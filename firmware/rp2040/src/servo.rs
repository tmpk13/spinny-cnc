//! Servo outputs: servos on the board's own pins, each a channel of a PWM
//! slice running at 50 Hz, and servos on a PCA9685 over I2C, written by a
//! task of their own so the bus never holds up the main loop.
//!
//! Which pins and which bus are the stored settings' at boot
//! (`spinny_fw_logic::servo::plan`). A servo whose output, pin or channel
//! is changed afterwards gets no pulse until the board restarts: the core
//! holds such a servo without one until a `servo` line moves it, and the
//! pulse a line gives it then goes to the output it had at boot only if it
//! still names that one.

use core::cell::RefCell;
use core::sync::atomic::{AtomicU32, AtomicU8, Ordering};

use critical_section::Mutex;
use embassy_executor::Spawner;
use embassy_futures::select::{select, Either};
use embassy_rp::i2c::{self, Async, I2c};
use embassy_rp::pac::{IO_BANK0, PWM};
use embassy_rp::peripherals::{
    I2C0, I2C1, PIN_0, PIN_1, PIN_17, PIN_18, PIN_20, PIN_21, PIN_22, PIN_23, PIN_24, PIN_26, PIN_27, PIN_29,
};
use embassy_rp::Peri;
use embassy_sync::blocking_mutex::raw::CriticalSectionRawMutex;
use embassy_sync::signal::Signal;
use embassy_time::{with_timeout, Duration, Timer};
use spinny_core::machine::Machine;
use spinny_core::report;
use spinny_core::SERVOS;
use spinny_fw_logic::laser::{pwm_is_channel_a, pwm_slice};
use spinny_fw_logic::servo::{
    bus_refused_text, pca_channel_write, pca_holds_setup, pca_missing_text, pca_prescale, pca_ready_text,
    pca_reset_text, pca_setup, refused_text, servo_compare, servo_params, Pca, ServoPlan, MODE1, SERVO_HZ, WAKE_US,
};

use crate::usb::UsbSink;
use crate::Irqs;

/// GPIO function select of the PWM block.
const FUNCSEL_PWM: u8 = 4;
/// No pin claimed.
const NO_PIN: u8 = u8::MAX;
/// No output at boot: a servo whose current wiring is never this.
const NO_WIRING: u32 = u32::MAX;

/// The bus at 100 kHz, which any PCA9685 board and any wire length takes;
/// a servo's write is five bytes, so speed buys nothing.
const I2C_HZ: u32 = 100_000;
/// A write or a read is done within a millisecond at that rate; a
/// transfer that takes this long has a stuck bus behind it.
const TRANSFER_TIMEOUT: Duration = Duration::from_millis(20);
/// How long a chip that does not answer waits before it is tried again.
const RETRY_EVERY: Duration = Duration::from_millis(500);
/// How often a quiet chip is asked whether it still holds its setup: one
/// whose supply dropped comes back asleep with every channel off.
const CHECK_EVERY: Duration = Duration::from_millis(1000);

static SYSCLK_HZ: AtomicU32 = AtomicU32::new(125_000_000);
/// Each servo's pin on the board, or `NO_PIN`.
static PINS: [AtomicU8; SERVOS] = [const { AtomicU8::new(NO_PIN) }; SERVOS];
/// Each servo's output at boot as `Settings::servo_wiring` packs it, its
/// kind in the top byte: a pulse is driven only while the settings still
/// name it.
static BOOT_WIRING: [AtomicU32; SERVOS] = [const { AtomicU32::new(NO_WIRING) }; SERVOS];
/// The newest pulses for the PCA9685's servos, for its task.
static PCA_PULSES: Mutex<RefCell<[Option<u16>; SERVOS]>> = Mutex::new(RefCell::new([None; SERVOS]));
static PCA_CHANGED: Signal<CriticalSectionRawMutex, ()> = Signal::new();

fn pack(wiring: (u8, u32)) -> u32 {
    (wiring.0 as u32) << 24 | (wiring.1 & 0x00FF_FFFF)
}

/// Claims the pins of the servos on the board: each slice set to 50 Hz
/// and both its channels low, which is no pulse, before the pin is handed
/// to the PWM block. Called from `board::init`, with the plan worked out
/// once the laser, the tool output and the probe have their pins.
pub fn claim(plan: &ServoPlan, wiring: &[(u8, u32); SERVOS], sysclk_hz: u32) {
    SYSCLK_HZ.store(sysclk_hz, Ordering::Relaxed);
    let params = servo_params(sysclk_hz);
    let mut slices = 0u8;
    for (i, pin) in plan.pins.iter().enumerate() {
        let Some(pin) = *pin else {
            continue;
        };
        let slice = pwm_slice(pin);
        if slices & (1 << slice) == 0 {
            slices |= 1 << slice;
            let ch = PWM.ch(slice);
            ch.csr().write(|w| w.set_en(false));
            ch.div().write(|w| {
                w.set_int(params.div);
                w.set_frac(0);
            });
            ch.top().write(|w| w.set_top(params.top));
            ch.cc().write(|w| {
                w.set_a(0);
                w.set_b(0);
            });
            ch.ctr().write(|w| w.set_ctr(0));
            ch.csr().write(|w| w.set_en(true));
        }
        IO_BANK0.gpio(pin as usize).ctrl().write(|w| w.set_funcsel(FUNCSEL_PWM));
        PINS[i].store(pin, Ordering::Relaxed);
    }
    for i in 0..SERVOS {
        let on_pca = plan.pca.is_some_and(|pca| pca.channels[i].is_some());
        if plan.pins[i].is_some() || on_pca {
            BOOT_WIRING[i].store(pack(wiring[i]), Ordering::Relaxed);
        }
    }
}

/// Says what the plan left without its pins, and starts the PCA9685's
/// task when a servo is on it.
pub fn start(spawner: &Spawner, plan: &ServoPlan, i2c0: Peri<'static, I2C0>, i2c1: Peri<'static, I2C1>) {
    for (i, why) in plan.refused.iter().enumerate() {
        if let Some(why) = why {
            report::message(refused_text(i, *why).as_str(), &mut UsbSink);
        }
    }
    if let Some(why) = plan.bus_refused {
        report::message(bus_refused_text(why).as_str(), &mut UsbSink);
    }
    let Some(pca) = plan.pca else {
        return;
    };
    match open(i2c0, i2c1, pca.sda, pca.scl) {
        Some(bus) => spawner.spawn(pca_task(bus, pca).expect("pca task")),
        // The plan takes only pins of an I2C block, which all have a way
        // in here; a pin missing from it is this table's fault.
        None => report::message("servo pca9685 not started: no I2C pins here", &mut UsbSink),
    }
}

/// Drives every servo the machine has a pulse for, on the output it had at
/// boot: a servo on the board through its slice's compare, which the
/// slice takes at its next wrap, so a pulse is never cut short; a servo on
/// the PCA9685 through its task, which takes the newest pulses. The main
/// loop calls it when the machine says a pulse may have changed.
pub fn drive(machine: &Machine) {
    let settings = machine.settings();
    let pulses: [Option<u16>; SERVOS] = core::array::from_fn(|i| {
        let still = BOOT_WIRING[i].load(Ordering::Relaxed) == pack(settings.servo_wiring(i));
        machine.servo_pulse(i).filter(|_| still)
    });
    let sysclk = SYSCLK_HZ.load(Ordering::Relaxed);
    let params = servo_params(sysclk);
    for (i, pulse) in pulses.iter().enumerate() {
        let pin = PINS[i].load(Ordering::Relaxed);
        if pin == NO_PIN {
            continue;
        }
        let cc = pulse.map_or(0, |us| servo_compare(sysclk, params, us));
        // Only the main loop writes these slices, and a slice may carry two
        // servos, so the other channel's compare is kept.
        PWM.ch(pwm_slice(pin)).cc().modify(|w| {
            if pwm_is_channel_a(pin) {
                w.set_a(cc);
            } else {
                w.set_b(cc);
            }
        });
    }
    critical_section::with(|cs| *PCA_PULSES.borrow_ref_mut(cs) = pulses);
    PCA_CHANGED.signal(());
}

/// The I2C block the PCA9685 is on.
enum Bus {
    Zero(I2c<'static, I2C0, Async>),
    One(I2c<'static, I2C1, Async>),
}

impl Bus {
    async fn write(&mut self, addr: u8, bytes: &[u8]) -> Result<(), ()> {
        let transfer = async {
            match self {
                Bus::Zero(i2c) => i2c.write_async(addr, bytes.iter().copied()).await,
                Bus::One(i2c) => i2c.write_async(addr, bytes.iter().copied()).await,
            }
        };
        match with_timeout(TRANSFER_TIMEOUT, transfer).await {
            Ok(Ok(())) => Ok(()),
            _ => Err(()),
        }
    }

    async fn read_register(&mut self, addr: u8, register: u8) -> Result<u8, ()> {
        let mut value = [0u8];
        let transfer = async {
            match self {
                Bus::Zero(i2c) => i2c.write_read_async(addr, [register], &mut value).await,
                Bus::One(i2c) => i2c.write_read_async(addr, [register], &mut value).await,
            }
        };
        match with_timeout(TRANSFER_TIMEOUT, transfer).await {
            Ok(Ok(())) => Ok(value[0]),
            _ => Err(()),
        }
    }
}

/// The I2C driver on the bus's two pins. The driver takes its pins as
/// types, and the settings name them as numbers, so each pair an I2C block
/// can use, less the driver sockets', the UART's and the STOP headers'
/// pins, has its arm.
fn open(i2c0: Peri<'static, I2C0>, i2c1: Peri<'static, I2C1>, sda: u8, scl: u8) -> Option<Bus> {
    let mut config = i2c::Config::default();
    config.frequency = I2C_HZ;
    // Pulled up inside the chip too: a module's own pull-ups, which most
    // have, set the edges, and without one the lines idle high instead of
    // floating, so a missing chip reads as no answer.
    config.sda_pullup = true;
    config.scl_pullup = true;
    // Safety, for every `steal` below: these pins are claimed by nothing
    // else. The plan gives the bus only pins no other output, the probe
    // or a servo has, and `main` leaves the chip's typed pins unused.
    macro_rules! on {
        ($variant:ident, $peri:expr, $sda:ident, [$($n:literal => $scl:ident),*]) => {
            match scl {
                $($n => Some(Bus::$variant(I2c::new_async($peri, unsafe { $scl::steal() }, unsafe { $sda::steal() }, Irqs, config))),)*
                _ => None,
            }
        };
    }
    match sda {
        0 => on!(Zero, i2c0, PIN_0, [1 => PIN_1, 17 => PIN_17, 21 => PIN_21, 29 => PIN_29]),
        20 => on!(Zero, i2c0, PIN_20, [1 => PIN_1, 17 => PIN_17, 21 => PIN_21, 29 => PIN_29]),
        24 => on!(Zero, i2c0, PIN_24, [1 => PIN_1, 17 => PIN_17, 21 => PIN_21, 29 => PIN_29]),
        18 => on!(One, i2c1, PIN_18, [23 => PIN_23, 27 => PIN_27]),
        22 => on!(One, i2c1, PIN_22, [23 => PIN_23, 27 => PIN_27]),
        26 => on!(One, i2c1, PIN_26, [23 => PIN_23, 27 => PIN_27]),
        _ => None,
    }
}

/// Sets the chip up: asleep for the rate, every channel off, then awake,
/// and the oscillator's start waited out.
async fn set_up(bus: &mut Bus, addr: u8, prescale: u8) -> Result<(), ()> {
    for write in pca_setup(prescale) {
        bus.write(addr, &write).await?;
    }
    Timer::after(Duration::from_micros(WAKE_US)).await;
    Ok(())
}

/// Keeps the PCA9685 driving the servos' pulses: set up at start and
/// again whenever it is found without its setup (its supply dropped and
/// came back) or answers again after not answering, every channel written
/// afresh then; and each channel written when its pulse changes. A chip
/// that does not answer is said to once and tried again every half
/// second, so a module powered after the board still comes up.
#[embassy_executor::task]
async fn pca_task(mut bus: Bus, pca: Pca) {
    let prescale = pca_prescale(SERVO_HZ);
    let mut ready = false;
    // "not answering" was said, and nothing has answered since.
    let mut silent = false;
    // What each servo's channel was last given; `None` before the first
    // write after a setup.
    let mut written: [Option<Option<u16>>; SERVOS] = [None; SERVOS];
    loop {
        if !ready {
            if set_up(&mut bus, pca.addr, prescale).await.is_ok() {
                ready = true;
                silent = false;
                written = [None; SERVOS];
                report::message(pca_ready_text(&pca).as_str(), &mut UsbSink);
            } else if !silent {
                silent = true;
                report::message(pca_missing_text(&pca).as_str(), &mut UsbSink);
            }
        }
        if ready {
            let pulses = critical_section::with(|cs| *PCA_PULSES.borrow_ref(cs));
            for i in 0..SERVOS {
                let Some(channel) = pca.channels[i] else {
                    continue;
                };
                if written[i] == Some(pulses[i]) {
                    continue;
                }
                if bus.write(pca.addr, &pca_channel_write(channel, pulses[i], prescale)).await.is_err() {
                    ready = false;
                    silent = true;
                    report::message(pca_missing_text(&pca).as_str(), &mut UsbSink);
                    break;
                }
                written[i] = Some(pulses[i]);
            }
        }
        let wait = if ready { CHECK_EVERY } else { RETRY_EVERY };
        if let Either::Second(()) = select(PCA_CHANGED.wait(), Timer::after(wait)).await {
            if !ready {
                continue;
            }
            match bus.read_register(pca.addr, MODE1).await {
                Ok(mode1) if pca_holds_setup(mode1) => {}
                Ok(_) => {
                    ready = false;
                    report::message(pca_reset_text(&pca).as_str(), &mut UsbSink);
                }
                Err(()) => {
                    ready = false;
                    silent = true;
                    report::message(pca_missing_text(&pca).as_str(), &mut UsbSink);
                }
            }
        }
    }
}
