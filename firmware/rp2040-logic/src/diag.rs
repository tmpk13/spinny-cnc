//! Boot and crash diagnostics: the record one life of the firmware leaves
//! in RAM for the next, the reason the chip's reset registers give, and the
//! lines the firmware prints about them (`[MSG:boot ...]` after the banner,
//! `[MSG:diag ...]` in answer to `diag`).
//!
//! SRAM keeps its contents through every reset short of a power cycle, so
//! a record written before a reset is still there when the firmware starts
//! again. A power cycle leaves random bytes, which the magic word and its
//! complement reject. The record is armed at every boot with the stop left
//! at `None`: a life that ends without a handler running (the watchdog ran
//! out, or the reset came from outside) is told by what the main loop
//! wrote last, which is where it was and for how long it had run.

use core::fmt;

use spinny_core::hal::Sink;
use spinny_core::report::uint;

/// Marks a record written by this firmware; its complement sits next to it.
pub const MAGIC: u32 = 0x5350_4e59;
/// Longest text a record keeps: a panic's location and message, or a hard
/// fault's registers.
pub const TEXT_LEN: usize = 120;

/// What ended the life that wrote the record, as its handler recorded it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stop {
    /// No handler ran: the watchdog ran out, or the reset came from outside.
    None,
    Panic,
    HardFault,
}

impl Stop {
    pub fn as_u32(self) -> u32 {
        match self {
            Stop::None => 0,
            Stop::Panic => 1,
            Stop::HardFault => 2,
        }
    }

    fn from_u32(value: u32) -> Stop {
        match value {
            1 => Stop::Panic,
            2 => Stop::HardFault,
            _ => Stop::None,
        }
    }
}

/// Where the main loop is, written before each step of a pass.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Phase {
    /// Between passes, waiting for the ticker.
    #[default]
    Waiting,
    /// USB connect and disconnect events.
    Events,
    /// Realtime bytes.
    Realtime,
    /// A line handed to the machine.
    Line,
    /// The cross slide's steps.
    Slide,
    /// The machine's poll: planning, segments, the beam, a flash write.
    Poll,
    /// Driver configuration and reports.
    Drivers,
    /// A motor power loss.
    Power,
    /// Start-up, before the first pass.
    Boot,
}

impl Phase {
    pub fn name(self) -> &'static str {
        match self {
            Phase::Waiting => "waiting",
            Phase::Events => "events",
            Phase::Realtime => "realtime",
            Phase::Line => "line",
            Phase::Slide => "slide",
            Phase::Poll => "poll",
            Phase::Drivers => "drivers",
            Phase::Power => "power",
            Phase::Boot => "boot",
        }
    }

    pub fn as_u32(self) -> u32 {
        match self {
            Phase::Waiting => 0,
            Phase::Events => 1,
            Phase::Realtime => 2,
            Phase::Line => 3,
            Phase::Slide => 4,
            Phase::Poll => 5,
            Phase::Drivers => 6,
            Phase::Power => 7,
            Phase::Boot => 8,
        }
    }

    fn from_u32(value: u32) -> Phase {
        match value {
            1 => Phase::Events,
            2 => Phase::Realtime,
            3 => Phase::Line,
            4 => Phase::Slide,
            5 => Phase::Poll,
            6 => Phase::Drivers,
            7 => Phase::Power,
            8 => Phase::Boot,
            _ => Phase::Waiting,
        }
    }
}

/// The record kept in RAM that no reset clears. Plain words, so a handler
/// can write it with nothing but stores; the text is printable ASCII.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct Record {
    pub magic: u32,
    pub check: u32,
    pub stop: u32,
    pub phase: u32,
    pub uptime_ms: u32,
    pub lines: u32,
    pub pass_max_us: u32,
    pub gap_max_us: u32,
    pub text_len: u32,
    pub text: [u8; TEXT_LEN],
}

impl Record {
    /// A fresh record for the life that starts now: valid, nothing stopped.
    pub const fn armed() -> Record {
        Record {
            magic: MAGIC,
            check: !MAGIC,
            stop: 0,
            phase: Phase::Boot as u32,
            uptime_ms: 0,
            lines: 0,
            pass_max_us: 0,
            gap_max_us: 0,
            text_len: 0,
            text: [0; TEXT_LEN],
        }
    }

    /// Written by this firmware, not left by a power-up.
    pub fn is_valid(&self) -> bool {
        self.magic == MAGIC && self.check == !MAGIC && (self.text_len as usize) <= TEXT_LEN
    }

    pub fn stop(&self) -> Stop {
        Stop::from_u32(self.stop)
    }

    pub fn phase(&self) -> Phase {
        Phase::from_u32(self.phase)
    }

    pub fn text(&self) -> &str {
        let len = (self.text_len as usize).min(TEXT_LEN);
        core::str::from_utf8(&self.text[..len]).unwrap_or("")
    }

    pub fn set_text(&mut self, text: &Text) {
        self.text = text.buf;
        self.text_len = text.len as u32;
    }
}

/// A bounded line of printable ASCII that `write!` fills: what a panic or
/// a fault leaves in the record. Anything past the end is dropped, and
/// a byte that could break the message line, or is not ASCII, is a space.
pub struct Text {
    buf: [u8; TEXT_LEN],
    len: usize,
}

impl Default for Text {
    fn default() -> Self {
        Self::new()
    }
}

impl Text {
    pub const fn new() -> Text {
        Text { buf: [0; TEXT_LEN], len: 0 }
    }

    pub fn as_str(&self) -> &str {
        core::str::from_utf8(&self.buf[..self.len]).unwrap_or("")
    }

    pub fn is_full(&self) -> bool {
        self.len == TEXT_LEN
    }
}

impl fmt::Write for Text {
    fn write_str(&mut self, s: &str) -> fmt::Result {
        for byte in s.bytes() {
            if self.len == TEXT_LEN {
                return Err(fmt::Error);
            }
            self.buf[self.len] = if (0x20..0x7f).contains(&byte) { byte } else { b' ' };
            self.len += 1;
        }
        Ok(())
    }
}

/// A source path as a panic location gives it, cut to the crate's own
/// part: `core/src/machine.rs` rather than the whole path to this
/// repository, `embassy-rp-0.10.0/src/usb.rs` rather than the registry.
pub fn short_file(path: &str) -> &str {
    match path.rfind("/src/") {
        Some(at) => {
            let start = path[..at].rfind('/').map_or(0, |slash| slash + 1);
            &path[start..]
        }
        None => path,
    }
}

/// What the reset registers say about the last reset.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ResetFlags {
    /// Power-on or brown-out.
    pub power_on: bool,
    /// The RUN pin: the reset button, or a debugger.
    pub run_pin: bool,
    /// The watchdog timer ran out.
    pub watchdog_timer: bool,
    /// The watchdog was told to reset: by a handler here, or by the
    /// bootloader after flashing.
    pub watchdog_force: bool,
}

/// Why this life started.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Boot {
    PowerOn,
    RunPin,
    /// The watchdog ran out: the main loop stalled.
    Timeout,
    Panic,
    HardFault,
    /// A forced reset nothing here recorded: the bootloader after
    /// flashing, or a reboot asked from outside.
    Forced,
    Unknown,
}

/// The reason, from the registers and the record the last life left.
pub fn boot_reason(flags: ResetFlags, record: Option<&Record>) -> Boot {
    if flags.watchdog_timer {
        return Boot::Timeout;
    }
    if flags.watchdog_force {
        return match record.map(Record::stop) {
            Some(Stop::Panic) => Boot::Panic,
            Some(Stop::HardFault) => Boot::HardFault,
            _ => Boot::Forced,
        };
    }
    if flags.power_on {
        Boot::PowerOn
    } else if flags.run_pin {
        Boot::RunPin
    } else {
        Boot::Unknown
    }
}

/// The body of `[MSG:boot ...]`: the reason, and for a reset the firmware
/// lived through, where the last life was and how long it had run.
pub fn write_boot(boot: Boot, record: Option<&Record>, out: &mut impl Sink) {
    match boot {
        Boot::PowerOn => out.write(b"power on"),
        Boot::RunPin => out.write(b"reset pin"),
        Boot::Unknown => out.write(b"unknown reset"),
        Boot::Forced => {
            out.write(b"forced reset");
            if let Some(record) = record {
                write_life(record, out);
            }
        }
        Boot::Timeout => {
            out.write(b"watchdog: the main loop stalled");
            if let Some(record) = record {
                write_life(record, out);
            }
        }
        Boot::Panic | Boot::HardFault => {
            out.write(if boot == Boot::Panic { b"panic".as_slice() } else { b"hard fault" });
            if let Some(record) = record {
                write_life(record, out);
                out.write(b": ");
                out.write_str(record.text());
            }
        }
    }
}

fn write_life(record: &Record, out: &mut impl Sink) {
    out.write(b" in ");
    out.write_str(record.phase().name());
    out.write(b" after ");
    uint(u64::from(record.uptime_ms / 1000), out);
    out.write(b" s, ");
    uint(u64::from(record.lines), out);
    out.write(b" lines, pass max ");
    uint(u64::from(record.pass_max_us), out);
    out.write(b" us, gap max ");
    uint(u64::from(record.gap_max_us), out);
    out.write(b" us");
}

/// `[MSG:boot ...]` plus newline, printed after the banner.
pub fn boot_message(boot: Boot, record: Option<&Record>, out: &mut impl Sink) {
    out.write(b"[MSG:boot ");
    write_boot(boot, record, out);
    out.write(b"]\n");
}

/// The counters of this life, as `diag` reports them.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Live {
    pub uptime_ms: u32,
    pub phase: Phase,
    /// Longest main loop pass and longest wait between two passes, both
    /// against the watchdog's budget.
    pub pass_max_us: u32,
    pub gap_max_us: u32,
    pub lines: u32,
    pub lines_long: u32,
    pub usb_configured: u32,
    pub usb_deconfigured: u32,
    pub usb_resets: u32,
    pub usb_suspends: u32,
    pub usb_resumes: u32,
    pub usb_disabled: u32,
    /// Times the controller stopped answering the bus and was forced off it.
    pub usb_lockups: u32,
    /// Since the last of those, or `None` for none yet.
    pub usb_event_age_ms: Option<u32>,
    pub dtr: bool,
    pub rts: bool,
    pub control_changes: u32,
    pub rx_bytes: u32,
    pub rx_age_ms: Option<u32>,
    pub tx_bytes: u32,
    pub tx_dropped: u32,
    /// How long the packet being written has waited for the host; `None`
    /// when the writer is idle.
    pub write_busy_ms: Option<u32>,
    pub write_max_ms: u32,
    pub power_lost: u32,
}

fn write_age(age: Option<u32>, out: &mut impl Sink) {
    match age {
        Some(ms) => {
            uint(u64::from(ms), out);
            out.write(b" ms ago");
        }
        None => out.write(b"never"),
    }
}

fn write_flag(flag: bool, out: &mut impl Sink) {
    out.write(if flag { b"1" } else { b"0" });
}

/// The `[MSG:diag ...]` lines: the boot reason again, then this life.
pub fn diag_messages(boot: Boot, record: Option<&Record>, live: &Live, out: &mut impl Sink) {
    out.write(b"[MSG:diag boot ");
    write_boot(boot, record, out);
    out.write(b"]\n");

    out.write(b"[MSG:diag up ");
    uint(u64::from(live.uptime_ms / 1000), out);
    out.write(b" s in ");
    out.write_str(live.phase.name());
    out.write(b", pass max ");
    uint(u64::from(live.pass_max_us), out);
    out.write(b" us, gap max ");
    uint(u64::from(live.gap_max_us), out);
    out.write(b" us, ");
    uint(u64::from(live.lines), out);
    out.write(b" lines, ");
    uint(u64::from(live.lines_long), out);
    out.write(b" too long]\n");

    out.write(b"[MSG:diag usb configured ");
    uint(u64::from(live.usb_configured), out);
    out.write(b", deconfigured ");
    uint(u64::from(live.usb_deconfigured), out);
    out.write(b", resets ");
    uint(u64::from(live.usb_resets), out);
    out.write(b", suspends ");
    uint(u64::from(live.usb_suspends), out);
    out.write(b", resumes ");
    uint(u64::from(live.usb_resumes), out);
    out.write(b", disabled ");
    uint(u64::from(live.usb_disabled), out);
    out.write(b", lockups ");
    uint(u64::from(live.usb_lockups), out);
    out.write(b", last ");
    write_age(live.usb_event_age_ms, out);
    out.write(b", dtr ");
    write_flag(live.dtr, out);
    out.write(b" rts ");
    write_flag(live.rts, out);
    out.write(b", control changes ");
    uint(u64::from(live.control_changes), out);
    out.write(b"]\n");

    out.write(b"[MSG:diag rx ");
    uint(u64::from(live.rx_bytes), out);
    out.write(b" bytes, last ");
    write_age(live.rx_age_ms, out);
    out.write(b"; tx ");
    uint(u64::from(live.tx_bytes), out);
    out.write(b" bytes, dropped ");
    uint(u64::from(live.tx_dropped), out);
    out.write(b", writer ");
    match live.write_busy_ms {
        Some(ms) => {
            out.write(b"waiting for the host for ");
            uint(u64::from(ms), out);
            out.write(b" ms");
        }
        None => out.write(b"idle"),
    }
    out.write(b", longest write ");
    uint(u64::from(live.write_max_ms), out);
    out.write(b" ms]\n");

    out.write(b"[MSG:diag motor power lost ");
    uint(u64::from(live.power_lost), out);
    out.write(b" times]\n");
}

#[cfg(test)]
mod tests {
    use core::fmt::Write;

    use super::*;

    #[derive(Default)]
    struct Out(Vec<u8>);

    impl Sink for Out {
        fn write(&mut self, bytes: &[u8]) {
            self.0.extend_from_slice(bytes);
        }
    }

    impl Out {
        fn text(&self) -> String {
            String::from_utf8(self.0.clone()).unwrap()
        }
    }

    fn after(record: &Record, boot: Boot) -> String {
        let mut out = Out::default();
        boot_message(boot, Some(record), &mut out);
        out.text()
    }

    #[test]
    fn an_armed_record_is_valid_and_random_bytes_are_not() {
        let armed = Record::armed();
        assert!(armed.is_valid());
        assert_eq!(armed.stop(), Stop::None);
        assert_eq!(armed.phase(), Phase::Boot);
        assert_eq!(armed.text(), "");
        let mut garbage = armed;
        garbage.check = 0xdead_beef;
        assert!(!garbage.is_valid());
        let mut long = armed;
        long.text_len = TEXT_LEN as u32 + 1;
        assert!(!long.is_valid());
        let mut zero = armed;
        zero.magic = 0;
        zero.check = 0;
        assert!(!zero.is_valid());
    }

    #[test]
    fn text_is_cut_at_its_end_and_kept_printable() {
        let mut text = Text::new();
        write!(text, "core/src/machine.rs:12: index {} out\nof bounds\u{e9}", 7).unwrap();
        assert_eq!(text.as_str(), "core/src/machine.rs:12: index 7 out of bounds  ");
        let mut full = Text::new();
        let result = write!(full, "{}", "x".repeat(TEXT_LEN + 40));
        assert!(result.is_err(), "writing past the end says so");
        assert!(full.is_full());
        assert_eq!(full.as_str().len(), TEXT_LEN);
        let mut record = Record::armed();
        record.set_text(&full);
        assert!(record.is_valid());
        assert_eq!(record.text().len(), TEXT_LEN);
    }

    #[test]
    fn a_source_path_is_cut_to_its_crate() {
        assert_eq!(short_file("/home/u/cnc/firmware/core/src/machine.rs"), "core/src/machine.rs");
        assert_eq!(
            short_file("/home/u/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/embassy-rp-0.10.0/src/usb.rs"),
            "embassy-rp-0.10.0/src/usb.rs"
        );
        assert_eq!(short_file("/rustc/abc/library/core/src/panicking.rs"), "core/src/panicking.rs");
        assert_eq!(short_file("main.rs"), "main.rs");
        assert_eq!(short_file("src/lib.rs"), "src/lib.rs");
    }

    #[test]
    fn the_registers_and_the_record_give_the_reason() {
        let armed = Record::armed();
        let mut panicked = armed;
        panicked.stop = Stop::Panic.as_u32();
        let mut faulted = armed;
        faulted.stop = Stop::HardFault.as_u32();
        let timer = ResetFlags { watchdog_timer: true, ..Default::default() };
        let force = ResetFlags { watchdog_force: true, ..Default::default() };
        let por = ResetFlags { power_on: true, ..Default::default() };
        let run = ResetFlags { run_pin: true, ..Default::default() };
        assert_eq!(boot_reason(timer, Some(&armed)), Boot::Timeout);
        assert_eq!(boot_reason(timer, None), Boot::Timeout);
        assert_eq!(boot_reason(force, Some(&panicked)), Boot::Panic);
        assert_eq!(boot_reason(force, Some(&faulted)), Boot::HardFault);
        assert_eq!(boot_reason(force, Some(&armed)), Boot::Forced);
        assert_eq!(boot_reason(force, None), Boot::Forced);
        assert_eq!(boot_reason(por, Some(&panicked)), Boot::PowerOn, "a power cycle leaves no trustworthy record");
        assert_eq!(boot_reason(run, None), Boot::RunPin);
        assert_eq!(boot_reason(ResetFlags::default(), None), Boot::Unknown);
    }

    #[test]
    fn the_boot_message_names_the_reason_and_the_life_before() {
        let mut out = Out::default();
        boot_message(Boot::PowerOn, None, &mut out);
        assert_eq!(out.text(), "[MSG:boot power on]\n");
        let mut record = Record::armed();
        record.phase = Phase::Poll.as_u32();
        record.uptime_ms = 12_345;
        record.lines = 27_213;
        record.pass_max_us = 820;
        record.gap_max_us = 1_900;
        assert_eq!(
            after(&record, Boot::Timeout),
            "[MSG:boot watchdog: the main loop stalled in poll after 12 s, 27213 lines, pass max 820 us, gap max 1900 us]\n"
        );
        let mut text = Text::new();
        write!(text, "core/src/machine.rs:1234: index out of bounds").unwrap();
        record.stop = Stop::Panic.as_u32();
        record.set_text(&text);
        assert_eq!(
            after(&record, Boot::Panic),
            "[MSG:boot panic in poll after 12 s, 27213 lines, pass max 820 us, gap max 1900 us: core/src/machine.rs:1234: index out of bounds]\n"
        );
        let mut regs = Text::new();
        write!(regs, "pc 0x10001234 lr 0x10005679").unwrap();
        record.stop = Stop::HardFault.as_u32();
        record.set_text(&regs);
        assert!(after(&record, Boot::HardFault).starts_with("[MSG:boot hard fault in poll after 12 s"));
        assert!(after(&record, Boot::HardFault).ends_with(": pc 0x10001234 lr 0x10005679]\n"));
        assert_eq!(
            after(&Record::armed(), Boot::Forced),
            "[MSG:boot forced reset in boot after 0 s, 0 lines, pass max 0 us, gap max 0 us]\n"
        );
        let mut out = Out::default();
        boot_message(Boot::Timeout, None, &mut out);
        assert_eq!(out.text(), "[MSG:boot watchdog: the main loop stalled]\n");
    }

    #[test]
    fn the_diag_lines_carry_every_counter() {
        let live = Live {
            uptime_ms: 56_400,
            phase: Phase::Waiting,
            pass_max_us: 310,
            gap_max_us: 1_200,
            lines: 120,
            lines_long: 1,
            usb_configured: 1,
            usb_resets: 1,
            usb_event_age_ms: Some(56_000),
            dtr: true,
            rts: true,
            control_changes: 2,
            rx_bytes: 3_456,
            rx_age_ms: Some(200),
            tx_bytes: 12_345,
            write_busy_ms: Some(4_000),
            write_max_ms: 12,
            ..Default::default()
        };
        let mut out = Out::default();
        diag_messages(Boot::RunPin, None, &live, &mut out);
        let text = out.text();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines[0], "[MSG:diag boot reset pin]");
        assert_eq!(lines[1], "[MSG:diag up 56 s in waiting, pass max 310 us, gap max 1200 us, 120 lines, 1 too long]");
        assert_eq!(
            lines[2],
            "[MSG:diag usb configured 1, deconfigured 0, resets 1, suspends 0, resumes 0, disabled 0, lockups 0, last 56000 ms ago, dtr 1 rts 1, control changes 2]"
        );
        assert_eq!(
            lines[3],
            "[MSG:diag rx 3456 bytes, last 200 ms ago; tx 12345 bytes, dropped 0, writer waiting for the host for 4000 ms, longest write 12 ms]"
        );
        assert_eq!(lines[4], "[MSG:diag motor power lost 0 times]");
        assert_eq!(lines.len(), 5);
        for line in &lines {
            assert!(line.starts_with("[MSG:diag ") && line.ends_with(']'), "{line}");
            assert!(line.is_ascii());
        }
        let mut idle = Out::default();
        diag_messages(Boot::Unknown, None, &Live::default(), &mut idle);
        assert!(idle.text().contains("rx 0 bytes, last never; tx 0 bytes, dropped 0, writer idle, longest write 0 ms]"));
        assert!(idle.text().contains("usb configured 0, deconfigured 0, resets 0, suspends 0, resumes 0, disabled 0, lockups 0, last never,"));
    }
}
