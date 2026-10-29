//! USB CDC ACM transport. One task runs the device, one turns received
//! packets into realtime actions and lines, one drains the output ring
//! into packets. The core writes through `UsbSink`, which never blocks.
//!
//! The endpoint reads and writes of this driver never fail, so a host
//! going away is only ever seen through the device's state: a bus reset,
//! a suspend or the configuration being dropped. Those come through the
//! `Handler` callbacks, which report the disconnect to the main loop and
//! make the reader and the writer start over. A program opening or
//! closing the port shows as the host's DTR line, which the control task
//! turns into events of its own: the opener is greeted, and a closer,
//! which may be a host that died mid-job, leaves nothing running.
//!
//! The controller can also lock up on a bus error (RP2040 erratum E15)
//! and answer nothing while staying on the bus; a guard task spots that
//! from the frame number and drops off the bus so the host starts over.
//! The writer makes it rarer by handing packets over early in a frame.

use core::cell::RefCell;
use core::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use critical_section::Mutex;
use embassy_executor::Spawner;
use embassy_futures::select::{select, Either};
use embassy_rp::pac;
use embassy_rp::peripherals::USB;
use embassy_rp::usb::Driver;
use embassy_rp::Peri;
use embassy_sync::blocking_mutex::raw::CriticalSectionRawMutex;
use embassy_sync::channel::Channel;
use embassy_sync::signal::Signal;
use embassy_time::{Duration, Instant, Ticker, Timer};
use embassy_usb::class::cdc_acm::{CdcAcmClass, ControlChanged, Receiver, Sender, State};
use embassy_usb::{Builder, Config, Handler, UsbDevice};
use spinny_core::hal::Sink;
use spinny_core::parser::Realtime;
use spinny_fw_logic::line::{Event as LineEvent, Line, LineAssembler};
use spinny_fw_logic::out::{zlp_after, OutRing, PACKET};
use spinny_fw_logic::usb_guard::{FrameClock, FrameWatch};
use static_cell::StaticCell;

use crate::diag::{self, UsbEvent};
use crate::Irqs;

type UsbDrv = Driver<'static, USB>;

/// A received line, or the marker for one that was too long to keep.
pub enum Inbound {
    Line(Line),
    TooLong,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    /// The host configured the device: it is on the bus, nobody has it open yet.
    Connected,
    /// A program on the host opened the port (DTR raised).
    HostOpened,
    /// The program holding the port closed it, or died (DTR dropped).
    HostClosed,
    /// The bus went away: a reset, a suspend, the configuration dropped.
    Disconnected,
}

/// Realtime bytes; a dropped duplicate is harmless.
pub static REALTIME: Channel<CriticalSectionRawMutex, Realtime, 8> = Channel::new();
/// Lines waiting for the main loop; more than the 16 credits the protocol gives the host.
pub static LINES: Channel<CriticalSectionRawMutex, Inbound, 24> = Channel::new();
pub static EVENTS: Channel<CriticalSectionRawMutex, Event, 8> = Channel::new();
/// The device lost its host: the reader drops the line it was assembling
/// and the writer the packet it was sending, and both wait for the next
/// configuration. One signal each, since a signal has one waiter.
static READER_RESTART: Signal<CriticalSectionRawMutex, ()> = Signal::new();
static WRITER_RESTART: Signal<CriticalSectionRawMutex, ()> = Signal::new();
/// The host has configured the device, and not reset or dropped it since.
static CONFIGURED: AtomicBool = AtomicBool::new(false);
/// How often the guard looks at the frame number.
const GUARD_PERIOD: Duration = Duration::from_millis(10);
/// How long the pull-up stays off after a lockup: long enough for the
/// host to take it as an unplug.
const UNPLUG_TIME: Duration = Duration::from_millis(200);
/// How often the writer looks at the frame number before handing over a
/// packet: well inside the gap that still places a frame start.
const ARM_LOOK: Duration = Duration::from_micros(50);
/// How often it looks while the host has not yet taken the last packet,
/// which can be for good when no program has the port open.
const ARM_PENDING_LOOK: Duration = Duration::from_micros(500);
/// How long it looks for a young frame before handing the packet over
/// anyway, as it did before: a bus with no frames takes nothing either way.
const ARM_GIVE_UP: Duration = Duration::from_millis(5);

/// Device state changes, called from the device task.
struct DeviceEvents;

impl Handler for DeviceEvents {
    fn enabled(&mut self, enabled: bool) {
        if !enabled {
            CONFIGURED.store(false, Ordering::Relaxed);
            diag::usb(UsbEvent::Disabled);
            disconnected();
        }
    }

    fn reset(&mut self) {
        CONFIGURED.store(false, Ordering::Relaxed);
        diag::usb(UsbEvent::Reset);
        disconnected();
    }

    fn configured(&mut self, configured: bool) {
        if configured {
            CONFIGURED.store(true, Ordering::Relaxed);
            diag::usb(UsbEvent::Configured);
            let _ = EVENTS.try_send(Event::Connected);
        } else {
            CONFIGURED.store(false, Ordering::Relaxed);
            diag::usb(UsbEvent::Deconfigured);
            disconnected();
        }
    }

    fn suspended(&mut self, suspended: bool) {
        // With no VBUS sense on this board an unplug only ever shows as a
        // suspend, so a suspend is taken as the host going away.
        if suspended {
            diag::usb(UsbEvent::Suspended);
            disconnected();
        } else {
            diag::usb(UsbEvent::Resumed);
        }
    }
}

fn disconnected() {
    let _ = EVENTS.try_send(Event::Disconnected);
    READER_RESTART.signal(());
    WRITER_RESTART.signal(());
}

/// The program holding the port closed it: the line it left half sent
/// and the packet it was not reading go with it, so the next program's
/// first line is its own. The device stays configured, so the reader
/// and the writer come straight back for it.
fn host_closed() {
    let _ = EVENTS.try_send(Event::HostClosed);
    READER_RESTART.signal(());
    WRITER_RESTART.signal(());
}

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
    static HANDLER: StaticCell<DeviceEvents> = StaticCell::new();

    let mut builder = Builder::new(
        driver,
        config,
        CONFIG_DESCRIPTOR.init([0; 256]),
        BOS_DESCRIPTOR.init([0; 256]),
        &mut [],
        CONTROL_BUF.init([0; 64]),
    );
    builder.handler(HANDLER.init(DeviceEvents));
    let class = CdcAcmClass::new(&mut builder, STATE.init(State::new()), PACKET as u16);
    let (sender, receiver, control) = class.split_with_control();
    let device = builder.build();

    spawner.spawn(device_task(device).expect("usb device task"));
    spawner.spawn(reader_task(receiver).expect("usb reader task"));
    spawner.spawn(writer_task(sender).expect("usb writer task"));
    spawner.spawn(control_task(control).expect("usb control task"));
    spawner.spawn(guard_task().expect("usb guard task"));
}

/// Watches the host's DTR and RTS, which the host raises when a program
/// opens the port and drops when it closes it or dies. A rising DTR is a
/// program that has just opened the port and expects the banner; a
/// falling one is that program gone, with whatever it had queued. A bus
/// reset drops the line too, after the disconnect it already caused.
#[embassy_executor::task]
async fn control_task(control: ControlChanged<'static>) {
    let mut open = false;
    loop {
        control.control_changed().await;
        let dtr = control.dtr();
        diag::control(dtr, control.rts());
        if dtr != open {
            open = dtr;
            if dtr {
                let _ = EVENTS.try_send(Event::HostOpened);
            } else {
                host_closed();
            }
        }
    }
}

/// Watches for the controller locking up: a frame number that stands
/// still while the device is configured on a bus that is not suspended.
/// The board then treats the host as gone, as an unplug would, and drops
/// its pull-up long enough for the host to see one; the host's new
/// enumeration resets the controller and brings it back.
#[embassy_executor::task]
async fn guard_task() {
    let regs = pac::USB;
    let mut watch = FrameWatch::new();
    let mut ticker = Ticker::every(GUARD_PERIOD);
    loop {
        ticker.next().await;
        let active = CONFIGURED.load(Ordering::Relaxed) && !regs.sie_status().read().suspended();
        let frame = regs.sof_rd().read().count();
        if !watch.check(Instant::now().as_millis() as u32, active, frame) {
            continue;
        }
        diag::usb(UsbEvent::Lockup);
        CONFIGURED.store(false, Ordering::Relaxed);
        disconnected();
        // Nothing else writes this register after the driver set it up.
        regs.sie_ctrl().modify(|w| w.set_pullup_en(false));
        Timer::after(UNPLUG_TIME).await;
        regs.sie_ctrl().modify(|w| w.set_pullup_en(true));
    }
}

/// Waits for a safe moment to hand the controller a bulk IN packet: the
/// host has taken the one before, so the write arms the new one at once
/// rather than whenever that happens, and the frame is young, well clear
/// of the late IN tokens of its last 200 us that set off erratum E15.
async fn arm_window() {
    let usb = pac::USB;
    let dpram = pac::USB_DPRAM;
    let mut clock = FrameClock::new();
    let mut since = Instant::now();
    loop {
        let now = Instant::now();
        let early = clock.early(usb.sof_rd().read().count(), now.as_micros() as u32);
        // Endpoint 0 is control, and the class never writes its
        // notification endpoint: an armed IN buffer is the last packet.
        let pending = (1..16).any(|n| dpram.ep_in_buffer_control(n).read().available(0));
        if pending {
            since = now;
            Timer::after(ARM_PENDING_LOOK).await;
            continue;
        }
        if early || now - since >= ARM_GIVE_UP {
            return;
        }
        Timer::after(ARM_LOOK).await;
    }
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
        // A restart raised before this configuration was for the one before.
        READER_RESTART.reset();
        assembler.reset();
        loop {
            let n = match select(receiver.read_packet(&mut buf), READER_RESTART.wait()).await {
                Either::First(Ok(n)) => n,
                Either::First(Err(_)) | Either::Second(()) => break,
            };
            diag::received(n);
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
        // for the next one, nor after the reset the disconnect causes.
        LINES.clear();
        REALTIME.clear();
    }
}

#[embassy_executor::task]
async fn writer_task(mut sender: Sender<'static, UsbDrv>) {
    let mut buf = [0u8; PACKET];
    loop {
        sender.wait_connection().await;
        WRITER_RESTART.reset();
        loop {
            let (n, remaining) = take_packet(&mut buf);
            if n == 0 {
                match select(OUT_READY.wait(), WRITER_RESTART.wait()).await {
                    Either::First(()) => continue,
                    Either::Second(()) => break,
                }
            }
            if let Either::Second(()) = select(arm_window(), WRITER_RESTART.wait()).await {
                break;
            }
            diag::write_begin();
            match select(sender.write_packet(&buf[..n]), WRITER_RESTART.wait()).await {
                Either::First(Ok(())) => diag::write_end(n),
                Either::First(Err(_)) | Either::Second(()) => {
                    diag::write_end(0);
                    break;
                }
            }
            if zlp_after(n, remaining) {
                if let Either::Second(()) = select(arm_window(), WRITER_RESTART.wait()).await {
                    break;
                }
                diag::write_begin();
                match select(sender.write_packet(&[]), WRITER_RESTART.wait()).await {
                    Either::First(Ok(())) => diag::write_end(0),
                    Either::First(Err(_)) | Either::Second(()) => {
                        diag::write_end(0);
                        break;
                    }
                }
            }
        }
    }
}
