//! SKR Pico (RP2040) firmware for the spinny laser: the spinny-core control
//! core driving the radius and table steppers, the laser PWM and the USB
//! CDC line protocol.
//!
//! Tasks: the main loop below polls the core every 500 us; `usb` owns the
//! CDC device, one task reading bytes into lines and one draining the
//! output ring; `tmc` owns the driver UART; `step_timer` runs the stepper
//! from TIMER alarm 1 at the highest interrupt priority.
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
use spinny_core::hal::LaserPort;
use spinny_core::machine::Machine;
use spinny_core::settings::Settings;
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

    // Laser output low and motors disabled before anything else runs.
    let (mut port, mut laser) = board::init(board::Pins {
        pwm6: p.PWM_SLICE6,
        laser: p.PIN_29,
        r_step: p.PIN_11,
        r_dir: p.PIN_10,
        r_en: p.PIN_12,
        a_step: p.PIN_6,
        a_dir: p.PIN_5,
        a_en: p.PIN_7,
    });

    // Every other interrupt below the step timer, which `step_timer::start` puts at P0.
    interrupt::USBCTRL_IRQ.set_priority(Priority::P2);
    interrupt::UART1_IRQ.set_priority(Priority::P2);
    interrupt::TIMER_IRQ_0.set_priority(Priority::P1);

    let mut store = flash::FlashStore::new(p.FLASH);
    let serial = store.serial_number();

    static SHARED: StaticCell<Shared> = StaticCell::new();
    let (front, isr) = stepper::split(SHARED.init(Shared::new()));
    step_timer::install(isr);

    let mut sink = usb::UsbSink;
    let mut machine = Machine::new(front, Settings::default());
    // Read the stored settings before anything else starts: `board::init`
    // can only leave the laser pin low, which is the lit state when
    // `laser_invert` is set, and this is the first point the polarity is
    // known.
    machine.load_settings(&mut store);
    machine.drive_laser(&mut laser);
    laser.set_frequency(machine.settings().laser_hz);

    usb::start(&spawner, p.USB, serial);
    tmc::start(&spawner, p.UART1, p.PIN_8, p.PIN_9);
    step_timer::start();
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
