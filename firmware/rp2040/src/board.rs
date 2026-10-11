//! SKR Pico pin assignment and the ports the core drives.
//!
//! Pins are configured once at boot and then left alone. The driver
//! sockets' pins are the board's; the laser output, the probe input and
//! the tool output are wherever the stored settings put them, read from
//! flash before this runs. The ports are zero-sized and write the SIO and
//! PWM registers directly, so the step interrupt and the main loop use the
//! same types without sharing any state but a few atomics.

use core::mem::forget;
use core::sync::atomic::{AtomicBool, AtomicU8, AtomicU32, Ordering};

use embassy_rp::clocks::clk_sys_freq;
use embassy_rp::gpio::{AnyPin, Input, Level, Output, Pin, Pull};
use embassy_rp::pac::{IO_BANK0, PWM, SIO};
use embassy_rp::peripherals::{PIN_10, PIN_11, PIN_12, PIN_13, PIN_14, PIN_15, PIN_19, PIN_2, PIN_28, PIN_5, PIN_6, PIN_7};
use embassy_rp::Peri;
use spinny_core::hal::{LaserPort, SlidePort, StepPort};
use spinny_core::settings::{Settings, LASER_PIN_DEFAULT, PROBE_PIN_DEFAULT, RESERVED_PINS, SOCKETS};
use spinny_core::{AXES, Z};
use spinny_fw_logic::laser::{compare, compare_before_top, pwm_is_channel_a, pwm_params, pwm_slice, resting_duty};
use spinny_fw_logic::pins::{level_masks, mask_of};
use spinny_fw_logic::step::pulse_loops;

/// STEP and DIR pins of the X, Y, Z and E driver sockets. Which joint
/// drives which socket is the `sockets` setting, copied into the joint
/// tables below by `set_sockets`. The step interrupt drives the cross
/// slide's pins only on a cartesian machine, where it is a joint;
/// elsewhere its direction pin is written with every block and never
/// stepped, and `SlidePins` moves it from the main loop while the joints
/// are at rest.
pub const SOCKET_STEP_PINS: [u8; SOCKETS] = [11, 6, 19, 14];
pub const SOCKET_DIR_PINS: [u8; SOCKETS] = [10, 5, 28, 13];
/// Driver enable pins, active low, of the X, Y, Z and E sockets. They are
/// driven together, so a move energizes all four; an empty socket takes
/// no harm from its line.
pub const EN_PINS: [u8; SOCKETS] = [12, 7, 2, 15];
/// Every axis selected in an enable write.
const EN_ALL: u8 = 0b1111;
/// The driver UART, TX and RX.
pub const UART_PINS: [u8; 2] = [8, 9];
/// GPIO function select of the PWM block.
const FUNCSEL_PWM: u8 = 4;
/// No tool output claimed.
const NO_PIN: u8 = u8::MAX;

/// The pins no setting may name are the ones above, and the core refuses
/// a setting that names one; checked here so the two lists stay one.
const _: () = {
    let mut i = 0;
    while i < SOCKETS {
        assert!(contains(&RESERVED_PINS, SOCKET_STEP_PINS[i]));
        assert!(contains(&RESERVED_PINS, SOCKET_DIR_PINS[i]));
        assert!(contains(&RESERVED_PINS, EN_PINS[i]));
        i += 1;
    }
    assert!(contains(&RESERVED_PINS, UART_PINS[0]) && contains(&RESERVED_PINS, UART_PINS[1]));
    assert!(RESERVED_PINS.len() == 3 * SOCKETS + 2);
};

const fn contains(pins: &[u32], pin: u8) -> bool {
    let mut i = 0;
    while i < pins.len() {
        if pins[i] == pin as u32 {
            return true;
        }
        i += 1;
    }
    false
}

/// Busy-wait iterations after a DIR change: about 50 cycles, well over
/// the 20 ns the TMC2209 asks for.
const DIR_SETUP_LOOPS: u32 = 16;

static SYSCLK_HZ: AtomicU32 = AtomicU32::new(125_000_000);
/// Busy-wait iterations after raising STEP; the main loop keeps it in
/// step with `step_us`.
static PULSE_LOOPS: AtomicU32 = AtomicU32::new(125);
/// Wrap value of the laser PWM, set by `set_frequency`.
static LASER_TOP: AtomicU32 = AtomicU32::new(0);
/// Last duty asked for, reapplied when the frequency changes.
static LASER_DUTY: AtomicU32 = AtomicU32::new(0);
/// The PWM slice the laser pin belongs to, and whether it is the slice's
/// channel B; both follow from the pin, `(gpio / 2) % 8` and odd for B.
static LASER_SLICE: AtomicU8 = AtomicU8::new(pwm_slice(LASER_PIN_DEFAULT as u8) as u8);
static LASER_CHANNEL_B: AtomicBool = AtomicBool::new(!pwm_is_channel_a(LASER_PIN_DEFAULT as u8));
/// The probe input, with the internal pull-up: a switch or a pin touching
/// grounded copper pulls it low.
static PROBE_PIN: AtomicU8 = AtomicU8::new(PROBE_PIN_DEFAULT as u8);
/// The tool output, or `NO_PIN`.
static TOOL_PIN: AtomicU8 = AtomicU8::new(NO_PIN);
/// STEP and DIR pin of each joint in the core's order, from `sockets`;
/// the board as labeled until the settings are applied.
static JOINT_STEP_PINS: [AtomicU8; AXES] = [
    AtomicU8::new(SOCKET_STEP_PINS[0]),
    AtomicU8::new(SOCKET_STEP_PINS[1]),
    AtomicU8::new(SOCKET_STEP_PINS[3]),
    AtomicU8::new(SOCKET_STEP_PINS[2]),
];
static JOINT_DIR_PINS: [AtomicU8; AXES] = [
    AtomicU8::new(SOCKET_DIR_PINS[0]),
    AtomicU8::new(SOCKET_DIR_PINS[1]),
    AtomicU8::new(SOCKET_DIR_PINS[3]),
    AtomicU8::new(SOCKET_DIR_PINS[2]),
];

/// The driver sockets' pins, X, Y, Z and E.
pub struct Pins {
    pub x_step: Peri<'static, PIN_11>,
    pub x_dir: Peri<'static, PIN_10>,
    pub x_en: Peri<'static, PIN_12>,
    pub y_step: Peri<'static, PIN_6>,
    pub y_dir: Peri<'static, PIN_5>,
    pub y_en: Peri<'static, PIN_7>,
    pub z_step: Peri<'static, PIN_19>,
    pub z_dir: Peri<'static, PIN_28>,
    pub z_en: Peri<'static, PIN_2>,
    pub e_step: Peri<'static, PIN_14>,
    pub e_dir: Peri<'static, PIN_13>,
    pub e_en: Peri<'static, PIN_15>,
}

/// What the stored settings say about the pins claimed at boot.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IoPins {
    pub laser_invert: bool,
    pub laser_pin: u8,
    pub probe_pin: u8,
    /// The tool output's pin, when one is driven.
    pub tool_pin: Option<u8>,
    pub tool_invert: bool,
}

impl IoPins {
    /// The settings' pins. A tool output on the laser's or the probe's
    /// pin is not driven: two settings on one pin are the machine file's
    /// to refuse, since the firmware takes them one at a time.
    pub fn from_settings(settings: &Settings) -> IoPins {
        let tool = settings.tool_out && settings.tool_pin != settings.laser_pin && settings.tool_pin != settings.probe_pin;
        IoPins {
            laser_invert: settings.laser_invert,
            laser_pin: settings.laser_pin as u8,
            probe_pin: settings.probe_pin as u8,
            tool_pin: tool.then_some(settings.tool_pin as u8),
            tool_invert: settings.tool_invert,
        }
    }
}

/// A pin no socket or the UART owns. The settings refuse the others, so
/// this only guards a stored blob the core did not check.
fn free(pin: u8) -> bool {
    pin <= spinny_core::settings::PIN_MAX as u8 && !contains(&RESERVED_PINS, pin)
}

/// Claims the pins in a safe order: the laser output at its off level,
/// the tool output at rest, the probe input, the drivers disabled, then
/// step and direction low. `io.laser_invert` is the stored polarity, read
/// from flash before this runs: the laser pin is driven at its off level
/// from the first instant it is an output (compare 0, always low,
/// normally; `top + 1`, always high, when inverted), so an inverted module
/// never sees the lit level while the rest boots. Until then the pad's
/// reset pull-down holds the line low. The drivers are forgotten on
/// purpose so they never release the pins.
pub fn init(pins: Pins, io: IoPins) -> (StepPins, LaserPwm, SlidePins) {
    SYSCLK_HZ.store(clk_sys_freq(), Ordering::Relaxed);

    // The laser's slice is programmed in full before its pin is handed
    // to the PWM block, so the pin goes from the pad's pull-down straight
    // to the off level.
    let laser_pin = if free(io.laser_pin) { io.laser_pin } else { LASER_PIN_DEFAULT as u8 };
    let slice = pwm_slice(laser_pin);
    let channel_b = !pwm_is_channel_a(laser_pin);
    LASER_SLICE.store(slice as u8, Ordering::Relaxed);
    LASER_CHANNEL_B.store(channel_b, Ordering::Relaxed);
    let params = pwm_params(sysclk(), Settings::default().laser_hz);
    let rest = resting_duty(io.laser_invert);
    LASER_TOP.store(params.top as u32, Ordering::Relaxed);
    // `set_frequency` recomputes the compare from the kept duty, and the
    // stored frequency goes in before any duty is set: kept at 0, it would
    // write the lit compare for an inverted module.
    LASER_DUTY.store(rest as u32, Ordering::Relaxed);
    let ch = PWM.ch(slice);
    ch.csr().write(|w| w.set_en(false));
    ch.div().write(|w| {
        w.set_int(params.div);
        w.set_frac(0);
    });
    ch.top().write(|w| w.set_top(params.top));
    write_compare(slice, channel_b, compare(params.top, rest));
    ch.ctr().write(|w| w.set_ctr(0));
    ch.csr().write(|w| w.set_en(true));
    IO_BANK0.gpio(laser_pin as usize).ctrl().write(|w| w.set_funcsel(FUNCSEL_PWM));

    // The other settable pins are nobody's: the typed peripherals of the
    // chip's GPIOs stay unused in `main`, so taking one by number here
    // meets no other driver.
    if let Some(tool) = io.tool_pin.filter(|&pin| free(pin) && pin != laser_pin) {
        let rest = if io.tool_invert { Level::High } else { Level::Low };
        forget(Output::new(unsafe { AnyPin::steal(tool) }, rest));
        TOOL_PIN.store(tool, Ordering::Relaxed);
    }
    // A probe on the laser's pin would read the beam as contact (the tool
    // output never shares it, `IoPins` drops that one): the default header
    // is read instead, which with nothing on it is pulled up, no contact.
    let mut probe_pin = if free(io.probe_pin) { io.probe_pin } else { PROBE_PIN_DEFAULT as u8 };
    if probe_pin == laser_pin {
        probe_pin = PROBE_PIN_DEFAULT as u8;
    }
    if probe_pin != laser_pin {
        forget(Input::new(unsafe { AnyPin::steal(probe_pin) }, Pull::Up));
    }
    PROBE_PIN.store(probe_pin, Ordering::Relaxed);

    let step = [pins.x_step.pin(), pins.y_step.pin(), pins.z_step.pin(), pins.e_step.pin()];
    let dir = [pins.x_dir.pin(), pins.y_dir.pin(), pins.z_dir.pin(), pins.e_dir.pin()];
    let en = [pins.x_en.pin(), pins.y_en.pin(), pins.z_en.pin(), pins.e_en.pin()];
    forget(Output::new(pins.x_en, Level::High));
    forget(Output::new(pins.y_en, Level::High));
    forget(Output::new(pins.z_en, Level::High));
    forget(Output::new(pins.e_en, Level::High));
    forget(Output::new(pins.x_step, Level::Low));
    forget(Output::new(pins.y_step, Level::Low));
    forget(Output::new(pins.z_step, Level::Low));
    forget(Output::new(pins.e_step, Level::Low));
    forget(Output::new(pins.x_dir, Level::Low));
    forget(Output::new(pins.y_dir, Level::Low));
    forget(Output::new(pins.z_dir, Level::Low));
    forget(Output::new(pins.e_dir, Level::Low));
    // The SIO masks come from the tables above, which must name the pins
    // the outputs were just made on. Checked with every line at its safe
    // level, so a halt here leaves the drivers off and the laser dark.
    assert!(step == SOCKET_STEP_PINS && dir == SOCKET_DIR_PINS && en == EN_PINS);

    set_step_width(Settings::default().step_us);
    (StepPins, LaserPwm, SlidePins)
}

fn sysclk() -> u32 {
    SYSCLK_HZ.load(Ordering::Relaxed)
}

/// Points each joint at the socket `sockets` gives it. The machine takes a
/// settings change only at rest, so no block is being stepped while the
/// tables change; a direction pin a joint has just moved to is written
/// with its next block, before any step.
pub fn set_sockets(settings: &Settings) {
    for joint in 0..AXES {
        let socket = settings.socket_of(joint);
        JOINT_STEP_PINS[joint].store(SOCKET_STEP_PINS[socket], Ordering::Relaxed);
        JOINT_DIR_PINS[joint].store(SOCKET_DIR_PINS[socket], Ordering::Relaxed);
    }
}

fn joint_pins(table: &[AtomicU8; AXES]) -> [u8; AXES] {
    core::array::from_fn(|joint| table[joint].load(Ordering::Relaxed))
}

/// Step pulse width for the interrupt, from the `step_us` setting.
pub fn set_step_width(step_us: u32) {
    PULSE_LOOPS.store(pulse_loops(sysclk(), step_us), Ordering::Relaxed);
}

/// The laser's compare, one register write. A plain write, not a
/// read-modify-write: the slice's other channel is a pin this firmware
/// never puts in its PWM function.
fn write_compare(slice: usize, channel_b: bool, cc: u16) {
    PWM.ch(slice).cc().write(|w| {
        if channel_b {
            w.set_b(cc);
        } else {
            w.set_a(cc);
        }
    });
}

/// Step, direction and enable lines through the SIO set/clear registers.
#[derive(Clone, Copy, Default)]
pub struct StepPins;

impl StepPort for StepPins {
    fn set_dir(&mut self, levels: u8) {
        let (set, clr) = level_masks(levels, &joint_pins(&JOINT_DIR_PINS));
        let out = SIO.gpio_out(0);
        out.value_set().write_value(set);
        out.value_clr().write_value(clr);
        cortex_m::asm::delay(DIR_SETUP_LOOPS);
    }

    fn step(&mut self, mask: u8) {
        let bits = mask_of(mask, &joint_pins(&JOINT_STEP_PINS));
        if bits == 0 {
            return;
        }
        let out = SIO.gpio_out(0);
        out.value_set().write_value(bits);
        cortex_m::asm::delay(PULSE_LOOPS.load(Ordering::Relaxed));
        out.value_clr().write_value(bits);
    }

    fn set_enable(&mut self, high: bool) {
        let bits = mask_of(EN_ALL, &EN_PINS);
        let out = SIO.gpio_out(0);
        if high {
            out.value_set().write_value(bits);
        } else {
            out.value_clr().write_value(bits);
        }
    }

    fn probe(&mut self) -> bool {
        SIO.gpio_in(0).read() & (1 << PROBE_PIN.load(Ordering::Relaxed)) != 0
    }
}

/// The cross slide's step and direction lines, on whichever socket
/// `sockets` gives it, through the same SIO registers. Its enable is
/// `StepPins::set_enable`, which drives every driver socket together.
#[derive(Clone, Copy, Default)]
pub struct SlidePins;

impl SlidePort for SlidePins {
    fn set_dir(&mut self, high: bool) {
        let pin = JOINT_DIR_PINS[Z].load(Ordering::Relaxed);
        let (set, clr) = level_masks(high as u8, &[pin]);
        let out = SIO.gpio_out(0);
        out.value_set().write_value(set);
        out.value_clr().write_value(clr);
        cortex_m::asm::delay(DIR_SETUP_LOOPS);
    }

    fn step(&mut self) {
        let bits = mask_of(1, &[JOINT_STEP_PINS[Z].load(Ordering::Relaxed)]);
        let out = SIO.gpio_out(0);
        out.value_set().write_value(bits);
        cortex_m::asm::delay(PULSE_LOOPS.load(Ordering::Relaxed));
        out.value_clr().write_value(bits);
    }
}

/// The laser PWM compare and period, one register write each, and the
/// tool output's level.
#[derive(Clone, Copy, Default)]
pub struct LaserPwm;

fn laser_slice() -> usize {
    LASER_SLICE.load(Ordering::Relaxed) as usize
}

impl LaserPort for LaserPwm {
    fn set_duty(&mut self, permille: u16) {
        LASER_DUTY.store(permille as u32, Ordering::Relaxed);
        let top = LASER_TOP.load(Ordering::Relaxed) as u16;
        write_compare(laser_slice(), LASER_CHANNEL_B.load(Ordering::Relaxed), compare(top, permille));
    }

    /// Reprograms the slice in one go. The interrupt's `set_duty` computes
    /// its compare from the wrap value published here, so the block keeps
    /// it from running between the register writes and the store.
    fn set_frequency(&mut self, hz: u32) {
        let params = pwm_params(sysclk(), hz);
        critical_section::with(|_| {
            let slice = laser_slice();
            let channel_b = LASER_CHANNEL_B.load(Ordering::Relaxed);
            let ch = PWM.ch(slice);
            let old_top = LASER_TOP.load(Ordering::Relaxed) as u16;
            let cc = compare(params.top, LASER_DUTY.load(Ordering::Relaxed) as u16);
            ch.div().write(|w| {
                w.set_int(params.div);
                w.set_frac(0);
            });
            // Between the two writes the slice runs on one old and one
            // new value; this order never leaves a compare above the wrap,
            // which would hold the output high.
            if compare_before_top(old_top, params.top) {
                write_compare(slice, channel_b, cc);
                ch.top().write(|w| w.set_top(params.top));
            } else {
                ch.top().write(|w| w.set_top(params.top));
                write_compare(slice, channel_b, cc);
            }
            // A counter past a shorter wrap would run on to 0xFFFF first.
            ch.ctr().write(|w| w.set_ctr(0));
            LASER_TOP.store(params.top as u32, Ordering::Relaxed);
        });
    }

    fn set_enable(&mut self, high: bool) {
        let pin = TOOL_PIN.load(Ordering::Relaxed);
        if pin == NO_PIN {
            return;
        }
        let out = SIO.gpio_out(0);
        if high {
            out.value_set().write_value(1 << pin);
        } else {
            out.value_clr().write_value(1 << pin);
        }
    }
}
