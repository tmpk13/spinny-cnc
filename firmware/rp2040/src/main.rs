//! SKR Pico (RP2040) firmware for the spinny laser: the spinny-core control
//! core driving the radius and table steppers, the laser PWM and the USB
//! CDC line protocol.
//!
//! Tasks: the main loop below polls the core every 500 us; `usb` owns the
//! CDC device, one task reading bytes into lines and one draining the
//! output ring; `tmc` owns the driver UART; `step_timer` runs the stepper
//! from TIMER alarm 1 at the highest interrupt priority.
//!
//! The cross slide is the exception: it is stepped straight from the main
//! loop, because it only ever moves on its own, from rest, with the beam
//! off, and nothing depends on when its pulses land.
#![no_std]
#![no_main]

mod board;
mod flash;
mod step_timer;
mod tmc;
mod usb;

use embassy_executor::Spawner;
use embassy_rp::bind_interrupts;
use embassy_rp::interrupt::{self, InterruptExt, Priority};
use embassy_rp::peripherals::{UART1, USB};
use embassy_rp::uart::BufferedInterruptHandler;
use embassy_rp::usb::InterruptHandler;
use embassy_rp::watchdog::Watchdog;
use embassy_time::{Duration, Instant, Ticker};
use panic_halt as _;
use spinny_core::hal::{LaserPort, Store};
use spinny_core::machine::Machine;
use spinny_core::settings::{Settings, BLOB_LEN};
use spinny_core::stepper::{self, Shared};
use spinny_core::{parser, report};
use static_cell::StaticCell;

bind_interrupts!(pub struct Irqs {
    USBCTRL_IRQ => InterruptHandler<USB>;
    UART1_IRQ => BufferedInterruptHandler<UART1>;
});

/// Main loop period; the core wants to be polled about every millisecond.
const LOOP_PERIOD: Duration = Duration::from_micros(500);
/// A stalled main loop resets the chip, which returns the laser pin to an input.
const WATCHDOG_TIMEOUT: Duration = Duration::from_millis(1500);

#[embassy_executor::main]
async fn main(spawner: Spawner) {
    let p = embassy_rp::init(Default::default());

    // The stored settings decide the laser output's resting level, so
    // they are read before the pin is claimed: driven low first and
    // corrected after the flash read, an inverted module would be lit for
    // that read.
    let mut store = flash::FlashStore::new(p.FLASH);
    let laser_invert = {
        let mut blob = [0u8; BLOB_LEN];
        store
            .load(&mut blob)
            .and_then(|n| Settings::from_blob(&blob[..n]))
            .map(|settings| settings.laser_invert)
            .unwrap_or(false)
    };

    // Laser output at its off level and motors disabled before anything else runs.
    let (mut port, mut laser, mut slide) = board::init(board::Pins {
        pwm: p.PWM_SLICE2,
        laser: p.PIN_20,
        r_step: p.PIN_11,
        r_dir: p.PIN_10,
        r_en: p.PIN_12,
        a_step: p.PIN_6,
        a_dir: p.PIN_5,
        a_en: p.PIN_7,
        z_step: p.PIN_19,
        z_dir: p.PIN_28,
        z_en: p.PIN_2,
    }, laser_invert);

    // Every other interrupt below the step timer, which `step_timer::start` puts at P0.
    interrupt::USBCTRL_IRQ.set_priority(Priority::P2);
    interrupt::UART1_IRQ.set_priority(Priority::P2);
    interrupt::TIMER_IRQ_0.set_priority(Priority::P1);

    let serial = store.serial_number();

    static SHARED: StaticCell<Shared> = StaticCell::new();
    let (front, isr) = stepper::split(SHARED.init(Shared::new()));
    step_timer::install(isr);
    step_timer::start();

    // The stored settings decide the laser output's resting level: the pin
    // was claimed low, which is the lit level once `laser_invert` is set.
    // They are read and the output driven before the USB and driver tasks
    // start, not left to the first poll.
    let mut sink = usb::UsbSink;
    let mut machine = Machine::new(front, Settings::default());
    machine.load_settings(&mut store);
    laser.set_frequency(machine.settings().laser_hz);
    machine.drive_laser(&mut laser);

    usb::start(&spawner, p.USB, serial);
    tmc::start(&spawner, p.UART1, p.PIN_8, p.PIN_9);
    tmc::configure_from(machine.settings());
    let _ = machine.take_events();

    let mut watchdog = Watchdog::new(p.WATCHDOG);
    watchdog.start(WATCHDOG_TIMEOUT);

    let mut ticker = Ticker::every(LOOP_PERIOD);
    loop {
        ticker.next().await;
        watchdog.feed(WATCHDOG_TIMEOUT);
        board::set_step_width(machine.settings().step_us);

        while let Ok(event) = usb::EVENTS.try_receive() {
            match event {
                usb::Event::Connected => report::banner(&mut sink),
                usb::Event::Disconnected => {
                    usb::clear_output();
                    machine.disconnected(&mut laser, &mut port);
                }
            }
        }
        while let Ok(action) = usb::REALTIME.try_receive() {
            machine.realtime(action, &mut laser, &mut sink);
        }
        if machine.ready_for_line() {
            match usb::LINES.try_receive() {
                Ok(usb::Inbound::Line(line)) => machine.submit(line.as_str(), &mut sink),
                Ok(usb::Inbound::TooLong) => report::error(parser::Error::TooLong, &mut sink),
                Err(_) => {}
            }
        }

        let now_us = Instant::now().as_micros();
        machine.note_lines_waiting(usb::LINES.len());
        // The cross slide steps from here rather than from the step
        // timer: nothing is tied to its timing, and it is capped at a
        // rate this loop carries. Before the poll that ends its jog.
        machine.poll_slide(now_us, &mut slide);
        if machine.poll(now_us, &mut port, &mut laser, &mut store, &mut sink) {
            step_timer::kick();
        }
        let events = machine.take_events();
        if events.driver_config {
            tmc::configure_from(machine.settings());
        }
        if events.driver_report {
            tmc::request_report();
        }
    }
}
