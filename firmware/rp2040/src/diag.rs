//! Diagnostics on the board: the record in RAM that a reset does not
//! clear, the reset registers, the panic and hard fault handlers that
//! write the record and reset the chip, and the counters `diag` prints.
//!
//! A panic or a hard fault used to spin until the watchdog ran out, with
//! the step interrupt still running the ring and nothing written down.
//! Now the handler stops the interrupts, writes what it knows into the
//! record and forces the watchdog reset at once; the next life reads the
//! record before anything else and tells the host after its banner.
//!
//! The record's fields are written through volatile pointers: nothing in
//! this life reads them, so plain stores could be dropped as dead.

use core::cell::RefCell;
use core::fmt::Write;
use core::mem::MaybeUninit;
use core::panic::PanicInfo;
use core::ptr;
use core::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use cortex_m_rt::{exception, ExceptionFrame};
use critical_section::Mutex;
use embassy_rp::pac;
use embassy_time::Instant;
use spinny_core::hal::Sink;
use spinny_fw_logic::diag::{self as logic, Boot, Live, Phase, Record, ResetFlags, Stop, Text};

#[link_section = ".uninit.diag"]
static mut RECORD: MaybeUninit<Record> = MaybeUninit::uninit();

/// What the last life left, read once at boot.
struct Last {
    boot: Boot,
    record: Option<Record>,
}

static LAST: Mutex<RefCell<Last>> = Mutex::new(RefCell::new(Last { boot: Boot::Unknown, record: None }));

// Cortex-M0+ has no atomic read-modify-write, so each counter has one
// writer (a task, or the main loop) and the others only read.
static LINES_LONG: AtomicU32 = AtomicU32::new(0);
static USB_CONFIGURED: AtomicU32 = AtomicU32::new(0);
static USB_DECONFIGURED: AtomicU32 = AtomicU32::new(0);
static USB_RESETS: AtomicU32 = AtomicU32::new(0);
static USB_SUSPENDS: AtomicU32 = AtomicU32::new(0);
static USB_RESUMES: AtomicU32 = AtomicU32::new(0);
static USB_DISABLED: AtomicU32 = AtomicU32::new(0);
static USB_LOCKUPS: AtomicU32 = AtomicU32::new(0);
static USB_EVENT_MS: AtomicU32 = AtomicU32::new(0);
static USB_EVENT_SEEN: AtomicBool = AtomicBool::new(false);
static DTR: AtomicBool = AtomicBool::new(false);
static RTS: AtomicBool = AtomicBool::new(false);
static CONTROL_CHANGES: AtomicU32 = AtomicU32::new(0);
static RX_BYTES: AtomicU32 = AtomicU32::new(0);
static RX_MS: AtomicU32 = AtomicU32::new(0);
static RX_SEEN: AtomicBool = AtomicBool::new(false);
static TX_BYTES: AtomicU32 = AtomicU32::new(0);
static WRITING: AtomicBool = AtomicBool::new(false);
static WRITE_STARTED_MS: AtomicU32 = AtomicU32::new(0);
static WRITE_MAX_MS: AtomicU32 = AtomicU32::new(0);
static POWER_LOST: AtomicU32 = AtomicU32::new(0);

fn record() -> *mut Record {
    // The static is only ever reached through this pointer.
    unsafe { (*ptr::addr_of_mut!(RECORD)).as_mut_ptr() }
}

fn now_ms() -> u32 {
    Instant::now().as_millis() as u32
}

/// Reads what the last life left and arms the record for this one. Call
/// first thing, before anything that could fail.
pub fn init() {
    let flags = {
        let chip = pac::VREG_AND_CHIP_RESET.chip_reset().read();
        let reason = pac::WATCHDOG.reason().read();
        ResetFlags {
            power_on: chip.had_por(),
            run_pin: chip.had_run(),
            watchdog_timer: reason.timer(),
            watchdog_force: reason.force(),
        }
    };
    let slot = record();
    // SAFETY: the record is plain words in RAM the runtime leaves alone;
    // nothing else touches it before the main loop runs.
    let left = unsafe { ptr::read_volatile(slot) };
    let left = left.is_valid().then_some(left);
    unsafe { ptr::write_volatile(slot, Record::armed()) };
    critical_section::with(|cs| {
        *LAST.borrow_ref_mut(cs) = Last { boot: logic::boot_reason(flags, left.as_ref()), record: left };
    });
}

fn write_field(write: impl FnOnce(&mut Record)) {
    let slot = record();
    // SAFETY: the main loop is the only writer while the firmware runs;
    // the handlers below take over the CPU and never return to it.
    unsafe {
        let mut copy = ptr::read_volatile(slot);
        write(&mut copy);
        ptr::write_volatile(slot, copy);
    }
}

/// Where the main loop is now.
pub fn phase(phase: Phase) {
    let slot = record();
    unsafe { ptr::write_volatile(ptr::addr_of_mut!((*slot).phase), phase.as_u32()) };
}

/// A pass begins: how long since the one before started counts against
/// the watchdog, which the loop feeds once a pass.
pub fn pass_begin(start: Instant, previous: Instant) {
    let gap = (start - previous).as_micros() as u32;
    let slot = record();
    unsafe {
        if gap > ptr::read_volatile(ptr::addr_of!((*slot).gap_max_us)) {
            ptr::write_volatile(ptr::addr_of_mut!((*slot).gap_max_us), gap);
        }
    }
}

/// A pass ends: its length, and the uptime for the record.
pub fn pass_end(start: Instant) {
    let now = Instant::now();
    let pass = (now - start).as_micros() as u32;
    let slot = record();
    unsafe {
        if pass > ptr::read_volatile(ptr::addr_of!((*slot).pass_max_us)) {
            ptr::write_volatile(ptr::addr_of_mut!((*slot).pass_max_us), pass);
        }
        ptr::write_volatile(ptr::addr_of_mut!((*slot).uptime_ms), now.as_millis() as u32);
    }
}

/// A line was handed to the machine.
pub fn line() {
    let slot = record();
    unsafe {
        let lines = ptr::read_volatile(ptr::addr_of!((*slot).lines));
        ptr::write_volatile(ptr::addr_of_mut!((*slot).lines), lines.wrapping_add(1));
    }
}

/// A line too long to keep arrived.
pub fn long_line() {
    LINES_LONG.store(LINES_LONG.load(Ordering::Relaxed).wrapping_add(1), Ordering::Relaxed);
}

#[derive(Clone, Copy)]
pub enum UsbEvent {
    Configured,
    Deconfigured,
    Reset,
    Suspended,
    Resumed,
    Disabled,
    /// The controller stopped answering the bus and was forced off it.
    Lockup,
}

/// A device state change, from the USB device task.
pub fn usb(event: UsbEvent) {
    let counter = match event {
        UsbEvent::Configured => &USB_CONFIGURED,
        UsbEvent::Deconfigured => &USB_DECONFIGURED,
        UsbEvent::Reset => &USB_RESETS,
        UsbEvent::Suspended => &USB_SUSPENDS,
        UsbEvent::Resumed => &USB_RESUMES,
        UsbEvent::Disabled => &USB_DISABLED,
        UsbEvent::Lockup => &USB_LOCKUPS,
    };
    counter.store(counter.load(Ordering::Relaxed).wrapping_add(1), Ordering::Relaxed);
    USB_EVENT_MS.store(now_ms(), Ordering::Relaxed);
    USB_EVENT_SEEN.store(true, Ordering::Relaxed);
}

/// The host set its control lines: it opened or closed the port.
pub fn control(dtr: bool, rts: bool) {
    DTR.store(dtr, Ordering::Relaxed);
    RTS.store(rts, Ordering::Relaxed);
    CONTROL_CHANGES.store(CONTROL_CHANGES.load(Ordering::Relaxed).wrapping_add(1), Ordering::Relaxed);
}

/// Bytes read from the host, from the reader task.
pub fn received(bytes: usize) {
    RX_BYTES.store(RX_BYTES.load(Ordering::Relaxed).wrapping_add(bytes as u32), Ordering::Relaxed);
    RX_MS.store(now_ms(), Ordering::Relaxed);
    RX_SEEN.store(true, Ordering::Relaxed);
}

/// The writer hands a packet to the endpoint; the host has to take it.
pub fn write_begin() {
    WRITE_STARTED_MS.store(now_ms(), Ordering::Relaxed);
    WRITING.store(true, Ordering::Relaxed);
}

/// The packet went, or the write was given up with the connection.
pub fn write_end(bytes: usize) {
    if WRITING.load(Ordering::Relaxed) {
        WRITING.store(false, Ordering::Relaxed);
        let took = now_ms().wrapping_sub(WRITE_STARTED_MS.load(Ordering::Relaxed));
        if took > WRITE_MAX_MS.load(Ordering::Relaxed) {
            WRITE_MAX_MS.store(took, Ordering::Relaxed);
        }
    }
    TX_BYTES.store(TX_BYTES.load(Ordering::Relaxed).wrapping_add(bytes as u32), Ordering::Relaxed);
}

/// The drivers lost their motor supply.
pub fn power_lost() {
    POWER_LOST.store(POWER_LOST.load(Ordering::Relaxed).wrapping_add(1), Ordering::Relaxed);
}

fn age(seen: &AtomicBool, at: &AtomicU32, now: u32) -> Option<u32> {
    seen.load(Ordering::Relaxed).then(|| now.wrapping_sub(at.load(Ordering::Relaxed)))
}

fn live() -> Live {
    let now = now_ms();
    let slot = record();
    let (phase, pass_max_us, gap_max_us, lines) = unsafe {
        (
            ptr::read_volatile(ptr::addr_of!((*slot).phase)),
            ptr::read_volatile(ptr::addr_of!((*slot).pass_max_us)),
            ptr::read_volatile(ptr::addr_of!((*slot).gap_max_us)),
            ptr::read_volatile(ptr::addr_of!((*slot).lines)),
        )
    };
    Live {
        uptime_ms: now,
        phase: Record { phase, ..Record::armed() }.phase(),
        pass_max_us,
        gap_max_us,
        lines,
        lines_long: LINES_LONG.load(Ordering::Relaxed),
        usb_configured: USB_CONFIGURED.load(Ordering::Relaxed),
        usb_deconfigured: USB_DECONFIGURED.load(Ordering::Relaxed),
        usb_resets: USB_RESETS.load(Ordering::Relaxed),
        usb_suspends: USB_SUSPENDS.load(Ordering::Relaxed),
        usb_resumes: USB_RESUMES.load(Ordering::Relaxed),
        usb_disabled: USB_DISABLED.load(Ordering::Relaxed),
        usb_lockups: USB_LOCKUPS.load(Ordering::Relaxed),
        usb_event_age_ms: age(&USB_EVENT_SEEN, &USB_EVENT_MS, now),
        dtr: DTR.load(Ordering::Relaxed),
        rts: RTS.load(Ordering::Relaxed),
        control_changes: CONTROL_CHANGES.load(Ordering::Relaxed),
        rx_bytes: RX_BYTES.load(Ordering::Relaxed),
        rx_age_ms: age(&RX_SEEN, &RX_MS, now),
        tx_bytes: TX_BYTES.load(Ordering::Relaxed),
        tx_dropped: crate::usb::dropped_bytes(),
        write_busy_ms: WRITING
            .load(Ordering::Relaxed)
            .then(|| now.wrapping_sub(WRITE_STARTED_MS.load(Ordering::Relaxed))),
        write_max_ms: WRITE_MAX_MS.load(Ordering::Relaxed),
        power_lost: POWER_LOST.load(Ordering::Relaxed),
    }
}

/// `[MSG:boot ...]`: why this life started, printed after the banner.
pub fn boot_message(out: &mut impl Sink) {
    critical_section::with(|cs| {
        let last = LAST.borrow_ref(cs);
        logic::boot_message(last.boot, last.record.as_ref(), out);
    });
}

/// The `[MSG:diag ...]` lines `diag` asks for.
pub fn report(out: &mut impl Sink) {
    let live = live();
    critical_section::with(|cs| {
        let last = LAST.borrow_ref(cs);
        logic::diag_messages(last.boot, last.record.as_ref(), &live, out);
    });
}

/// Writes the stop into the record and resets the chip through the
/// watchdog, which takes every peripheral with it: the laser pin goes
/// back to an input, held by the board's own pull resistor, and the
/// motors are disabled. Never returns.
fn stop(stop: Stop, text: &Text) -> ! {
    cortex_m::interrupt::disable();
    write_field(|record| {
        record.stop = stop.as_u32();
        record.uptime_ms = now_ms();
        record.set_text(text);
    });
    reboot()
}

/// A watchdog reset of everything but the oscillators, as the running
/// watchdog is set up to do; set again here, since a fault can come
/// before the main loop has started it.
fn reboot() -> ! {
    pac::PSM.wdsel().write_value(pac::psm::regs::Wdsel(0x0001_ffff & !0x3));
    pac::WATCHDOG.ctrl().write(|w| {
        w.set_pause_dbg0(false);
        w.set_pause_dbg1(false);
        w.set_pause_jtag(false);
        w.set_enable(true);
        w.set_trigger(true);
    });
    loop {
        cortex_m::asm::nop();
    }
}

#[panic_handler]
fn panic(info: &PanicInfo) -> ! {
    let mut text = Text::new();
    if let Some(location) = info.location() {
        let _ = write!(text, "{}:{}: ", logic::short_file(location.file()), location.line());
    }
    let _ = write!(text, "{}", info.message());
    stop(Stop::Panic, &text)
}

#[exception]
unsafe fn HardFault(frame: &ExceptionFrame) -> ! {
    let mut text = Text::new();
    let _ = write!(text, "pc {:#010x} lr {:#010x}", frame.pc(), frame.lr());
    stop(Stop::HardFault, &text)
}
