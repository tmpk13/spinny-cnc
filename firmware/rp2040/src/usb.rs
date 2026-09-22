//! USB CDC ACM transport. One task runs the device, one turns received
//! packets into realtime actions and lines, one drains the output ring
//! into packets. The core writes through `UsbSink`, which never blocks.

use core::cell::RefCell;
use core::sync::atomic::{AtomicU32, Ordering};

use critical_section::Mutex;
use embassy_executor::Spawner;
use embassy_rp::peripherals::USB;
use embassy_rp::usb::Driver;
use embassy_rp::Peri;
use embassy_sync::blocking_mutex::raw::CriticalSectionRawMutex;
use embassy_sync::channel::Channel;
use embassy_sync::signal::Signal;
use embassy_usb::class::cdc_acm::{CdcAcmClass, Receiver, Sender, State};
use embassy_usb::{Builder, Config, UsbDevice};
use spinny_core::hal::Sink;
use spinny_core::parser::Realtime;
use spinny_fw_logic::line::{Event as LineEvent, Line, LineAssembler};
use spinny_fw_logic::out::{zlp_after, OutRing, PACKET};
use static_cell::StaticCell;

use crate::Irqs;

type UsbDrv = Driver<'static, USB>;

/// A received line, or the marker for one that was too long to keep.
pub enum Inbound {
    Line(Line),
    TooLong,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    Connected,
    Disconnected,
}

/// Realtime bytes; a dropped duplicate is harmless.
pub static REALTIME: Channel<CriticalSectionRawMutex, Realtime, 8> = Channel::new();
/// Lines waiting for the main loop; more than the 16 credits the protocol gives the host.
pub static LINES: Channel<CriticalSectionRawMutex, Inbound, 24> = Channel::new();
pub static EVENTS: Channel<CriticalSectionRawMutex, Event, 4> = Channel::new();

const OUT_CAPACITY: usize = 4096;
static OUT: Mutex<RefCell<OutRing<OUT_CAPACITY>>> = Mutex::new(RefCell::new(OutRing::new()));
static OUT_READY: Signal<CriticalSectionRawMutex, ()> = Signal::new();
static OUT_DROPPED: AtomicU32 = AtomicU32::new(0);

/// Where the core's output goes. A full ring drops its oldest bytes.
pub struct UsbSink;

impl Sink for UsbSink {
    fn write(&mut self, bytes: &[u8]) {
        critical_section::with(|cs| {
            let dropped = OUT.borrow_ref_mut(cs).push(bytes);
            if dropped > 0 {
                // Cortex-M0+ has no atomic read-modify-write; the critical section covers it.
                let total = OUT_DROPPED.load(Ordering::Relaxed).wrapping_add(dropped as u32);
                OUT_DROPPED.store(total, Ordering::Relaxed);
            }
        });
        OUT_READY.signal(());
    }
}

/// Discards output that never reached the host.
pub fn clear_output() {
    critical_section::with(|cs| OUT.borrow_ref_mut(cs).clear());
}

/// Bytes dropped because the host did not read fast enough.
#[allow(dead_code)]
pub fn dropped_bytes() -> u32 {
    OUT_DROPPED.load(Ordering::Relaxed)
}

fn take_packet(buf: &mut [u8; PACKET]) -> (usize, usize) {
    critical_section::with(|cs| {
        let mut ring = OUT.borrow_ref_mut(cs);
        let n = ring.pop(buf);
        (n, ring.len())
    })
}

pub fn start(spawner: &Spawner, usb: Peri<'static, USB>, serial: &'static str) {
    let driver = Driver::new(usb, Irqs);

    let mut config = Config::new(0x2E8A, 0x000A);
    config.manufacturer = Some("spinny");
    config.product = Some("spinny laser controller");
    config.serial_number = Some(serial);
    config.max_power = 100;
    config.max_packet_size_0 = 64;
    // A composite device with an interface association: Windows binds its
    // serial driver to the CDC function only when the device says so.
    config.device_class = 0xEF;
    config.device_sub_class = 0x02;
    config.device_protocol = 0x01;
    config.composite_with_iads = true;

    static CONFIG_DESCRIPTOR: StaticCell<[u8; 256]> = StaticCell::new();
    static BOS_DESCRIPTOR: StaticCell<[u8; 256]> = StaticCell::new();
    static CONTROL_BUF: StaticCell<[u8; 64]> = StaticCell::new();
    static STATE: StaticCell<State> = StaticCell::new();

    let mut builder = Builder::new(
        driver,
        config,
        CONFIG_DESCRIPTOR.init([0; 256]),
        BOS_DESCRIPTOR.init([0; 256]),
        &mut [],
        CONTROL_BUF.init([0; 64]),
    );
    let class = CdcAcmClass::new(&mut builder, STATE.init(State::new()), PACKET as u16);
    let (sender, receiver) = class.split();
    let device = builder.build();

    spawner.spawn(device_task(device).expect("usb device task"));
    spawner.spawn(reader_task(receiver).expect("usb reader task"));
    spawner.spawn(writer_task(sender).expect("usb writer task"));
}

#[embassy_executor::task]
async fn device_task(mut device: UsbDevice<'static, UsbDrv>) -> ! {
    device.run().await
}

#[embassy_executor::task]
async fn reader_task(mut receiver: Receiver<'static, UsbDrv>) {
    let mut assembler = LineAssembler::new();
    let mut buf = [0u8; PACKET];
    loop {
        receiver.wait_connection().await;
        assembler.reset();
        EVENTS.send(Event::Connected).await;
        while let Ok(n) = receiver.read_packet(&mut buf).await {
            for &byte in &buf[..n] {
                match assembler.push(byte) {
                    Some(LineEvent::Realtime(action)) => {
                        if action == Realtime::Reset {
                            // A reset throws away everything the host had
                            // already sent, and those lines are sitting
                            // here, parsed but not yet run. Dropping them
                            // where the byte stream is still in order
                            // keeps the ones that arrive afterwards: the
                            // machine must not carry on cutting the job
                            // the operator just stopped.
                            LINES.clear();
                        }
                        let _ = REALTIME.try_send(action);
                    }
                    Some(LineEvent::Line(line)) => LINES.send(Inbound::Line(line)).await,
                    Some(LineEvent::TooLong) => LINES.send(Inbound::TooLong).await,
                    None => {}
                }
            }
        }
        // Lines and realtime bytes the old host left behind must not act
        // for the next one, nor after the reset the event causes.
        LINES.clear();
        REALTIME.clear();
        EVENTS.send(Event::Disconnected).await;
    }
}

#[embassy_executor::task]
async fn writer_task(mut sender: Sender<'static, UsbDrv>) {
    let mut buf = [0u8; PACKET];
    loop {
        sender.wait_connection().await;
        loop {
            let (n, remaining) = take_packet(&mut buf);
            if n == 0 {
                OUT_READY.wait().await;
                continue;
            }
            if sender.write_packet(&buf[..n]).await.is_err() {
                break;
            }
            if zlp_after(n, remaining) && sender.write_packet(&[]).await.is_err() {
                break;
            }
        }
    }
}
