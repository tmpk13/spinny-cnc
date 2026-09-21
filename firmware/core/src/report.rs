//! Status line and message formatting.
//!
//! Everything is written as bytes straight into the `Sink`. Numbers are
//! rendered with integer arithmetic, so no float formatting code is pulled
//! in and the text is the same on every target.

use crate::hal::Sink;
use crate::parser::PowerMode;
use crate::{A, AXES, BLOCKS, LINE_SLOTS, R, VERSION};

/// One state for the status line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Idle,
    Run,
    Jog,
    Hold,
    Alarm(u8),
}

/// Everything the status line shows.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Status {
    pub state: State,
    /// Radius mm, angle deg.
    pub joint: [f32; AXES],
    /// Board mm/min.
    pub rate: f32,
    /// Laser duty, permille.
    pub duty: u16,
    pub planner_free: usize,
    pub line_free: usize,
    pub mode: PowerMode,
    pub enabled: bool,
}

/// Most decimal places `float` renders.
pub const MAX_DECIMALS: usize = 9;

/// Text after the code on an `ALARM:` line.
pub fn alarm_text(code: u8) -> &'static str {
    match code {
        1 => "reset while moving, position may be off",
        _ => "unknown alarm",
    }
}

/// `<Idle|J:0.000,0.0000|V:0|L:0|Q:32,16|M:dyn|E:0>` plus newline.
pub fn status(status: &Status, out: &mut impl Sink) {
    out.write(b"<");
    match status.state {
        State::Idle => out.write(b"Idle"),
        State::Run => out.write(b"Run"),
        State::Jog => out.write(b"Jog"),
        State::Hold => out.write(b"Hold"),
        State::Alarm(code) => {
            out.write(b"Alarm:");
            uint(code as u64, out);
        }
    }
    out.write(b"|J:");
    float(status.joint[R], 3, out);
    out.write(b",");
    float(status.joint[A], 4, out);
    out.write(b"|V:");
    float(status.rate, 0, out);
    out.write(b"|L:");
    uint(status.duty as u64, out);
    out.write(b"|Q:");
    uint(status.planner_free as u64, out);
    out.write(b",");
    uint(status.line_free as u64, out);
    out.write(b"|M:");
    out.write_str(match status.mode {
        PowerMode::Dynamic => "dyn",
        PowerMode::Constant => "const",
    });
    out.write(b"|E:");
    out.write(if status.enabled { b"1" } else { b"0" });
    out.write(b">\n");
}

/// `[spinny v0.1.0 lines:16 blocks:32]` plus newline.
pub fn banner(out: &mut impl Sink) {
    out.write(b"[spinny v");
    out.write_str(VERSION);
    out.write(b" lines:");
    uint(LINE_SLOTS as u64, out);
    out.write(b" blocks:");
    uint(BLOCKS as u64, out);
    out.write(b"]\n");
}

/// `[MSG:text]` plus newline.
pub fn message(text: &str, out: &mut impl Sink) {
    out.write(b"[MSG:");
    out.write_str(text);
    out.write(b"]\n");
}

/// `ALARM:code text` plus newline.
pub fn alarm(code: u8, out: &mut impl Sink) {
    out.write(b"ALARM:");
    uint(code as u64, out);
    out.write(b" ");
    out.write_str(alarm_text(code));
    out.write(b"\n");
}

/// `error:code text` plus newline.
pub fn error(error: crate::parser::Error, out: &mut impl Sink) {
    out.write(b"error:");
    uint(error.code() as u64, out);
    out.write(b" ");
    out.write_str(error.text());
    out.write(b"\n");
}

/// `ok` plus newline.
pub fn ok(out: &mut impl Sink) {
    out.write(b"ok\n");
}

/// Writes an unsigned integer in decimal.
pub fn uint(value: u64, out: &mut impl Sink) {
    let mut digits = [0u8; 20];
    let mut at = digits.len();
    let mut rest = value;
    loop {
        at -= 1;
        digits[at] = b'0' + (rest % 10) as u8;
        rest /= 10;
        if rest == 0 {
            break;
        }
    }
    out.write(&digits[at..]);
}

/// Writes a float with `decimals` places (at most `MAX_DECIMALS`), no
/// exponent, rounded half away from zero, and never as `-0`.
///
/// The value is scaled in f64, which holds every digit of an f32, then
/// rounded to an integer; a magnitude beyond u64 saturates. NaN and the
/// infinities are written by name.
pub fn float(value: f32, decimals: usize, out: &mut impl Sink) {
    if value.is_nan() {
        out.write(b"nan");
        return;
    }
    if value.is_infinite() {
        out.write_str(if value < 0.0 { "-inf" } else { "inf" });
        return;
    }
    let decimals = decimals.min(MAX_DECIMALS);
    let scale = 10u64.pow(decimals as u32);
    let scaled = libm::fabsf(value) as f64 * scale as f64 + 0.5;
    let units = scaled as u64;
    if value < 0.0 && units != 0 {
        out.write(b"-");
    }
    uint(units / scale, out);
    if decimals > 0 {
        out.write(b".");
        let mut fraction = [b'0'; MAX_DECIMALS];
        let mut rest = units % scale;
        for digit in fraction[..decimals].iter_mut().rev() {
            *digit = b'0' + (rest % 10) as u8;
            rest /= 10;
        }
        out.write(&fraction[..decimals]);
    }
}

/// Writes a float with up to `decimals` places: trailing zeros and a bare
/// point are dropped, so `888.889`, `2.5` and `0` come out as such.
pub fn float_trimmed(value: f32, decimals: usize, out: &mut impl Sink) {
    let mut buffer = Buffer::<32>::new();
    float(value, decimals, &mut buffer);
    let mut text = buffer.as_bytes();
    if text.contains(&b'.') {
        while text.ends_with(b"0") {
            text = &text[..text.len() - 1];
        }
        if text.ends_with(b".") {
            text = &text[..text.len() - 1];
        }
    }
    out.write(text);
}

/// Fixed-size sink for text that is edited before it goes out; anything
/// beyond the capacity is dropped.
struct Buffer<const N: usize> {
    bytes: [u8; N],
    len: usize,
}

impl<const N: usize> Buffer<N> {
    fn new() -> Self {
        Buffer { bytes: [0; N], len: 0 }
    }

    fn as_bytes(&self) -> &[u8] {
        &self.bytes[..self.len]
    }
}

impl<const N: usize> Sink for Buffer<N> {
    fn write(&mut self, bytes: &[u8]) {
        let n = bytes.len().min(N - self.len);
        self.bytes[self.len..self.len + n].copy_from_slice(&bytes[..n]);
        self.len += n;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::Error;

    struct Out(heapless::Vec<u8, 256>);

    impl Out {
        fn new() -> Self {
            Out(heapless::Vec::new())
        }

        fn as_str(&self) -> &str {
            core::str::from_utf8(&self.0).unwrap()
        }
    }

    impl Sink for Out {
        fn write(&mut self, bytes: &[u8]) {
            self.0.extend_from_slice(bytes).unwrap();
        }
    }

    fn float_text(value: f32, decimals: usize) -> Out {
        let mut out = Out::new();
        float(value, decimals, &mut out);
        out
    }

    fn trimmed_text(value: f32, decimals: usize) -> Out {
        let mut out = Out::new();
        float_trimmed(value, decimals, &mut out);
        out
    }

    fn sample() -> Status {
        Status {
            state: State::Idle,
            joint: [0.0, 0.0],
            rate: 0.0,
            duty: 0,
            planner_free: 32,
            line_free: 16,
            mode: PowerMode::Dynamic,
            enabled: false,
        }
    }

    fn status_text(status: &Status) -> Out {
        let mut out = Out::new();
        super::status(status, &mut out);
        out
    }

    #[test]
    fn status_idle_default() {
        assert_eq!(status_text(&sample()).as_str(), "<Idle|J:0.000,0.0000|V:0|L:0|Q:32,16|M:dyn|E:0>\n");
    }

    #[test]
    fn status_run_sample_from_protocol() {
        let status = Status {
            state: State::Run,
            joint: [7.512, 135.0],
            rate: 300.0,
            duty: 400,
            planner_free: 30,
            line_free: 16,
            mode: PowerMode::Dynamic,
            enabled: true,
        };
        assert_eq!(status_text(&status).as_str(), "<Run|J:7.512,135.0000|V:300|L:400|Q:30,16|M:dyn|E:1>\n");
    }

    #[test]
    fn status_negative_angle_and_rounding() {
        let mut status = sample();
        status.state = State::Jog;
        status.joint = [2.0625, -45.5];
        status.rate = 299.5;
        status.mode = PowerMode::Constant;
        assert_eq!(status_text(&status).as_str(), "<Jog|J:2.063,-45.5000|V:300|L:0|Q:32,16|M:const|E:0>\n");
        status.joint = [0.0, -0.03125];
        status.rate = 299.4;
        assert_eq!(status_text(&status).as_str(), "<Jog|J:0.000,-0.0313|V:299|L:0|Q:32,16|M:const|E:0>\n");
    }

    #[test]
    fn status_tiny_negative_is_not_minus_zero() {
        let mut status = sample();
        status.joint = [-0.0001, -0.00001];
        assert_eq!(status_text(&status).as_str(), "<Idle|J:0.000,0.0000|V:0|L:0|Q:32,16|M:dyn|E:0>\n");
    }

    #[test]
    fn status_states() {
        let mut status = sample();
        status.state = State::Hold;
        assert!(status_text(&status).as_str().starts_with("<Hold|"));
        status.state = State::Alarm(1);
        assert!(status_text(&status).as_str().starts_with("<Alarm:1|"));
        status.state = State::Run;
        assert!(status_text(&status).as_str().starts_with("<Run|"));
    }

    #[test]
    fn status_queue_and_duty() {
        let mut status = sample();
        status.duty = 1000;
        status.planner_free = 0;
        status.line_free = 3;
        status.enabled = true;
        assert_eq!(status_text(&status).as_str(), "<Idle|J:0.000,0.0000|V:0|L:1000|Q:0,3|M:dyn|E:1>\n");
    }

    #[test]
    fn banner_has_version_and_sizes() {
        let mut out = Out::new();
        banner(&mut out);
        let mut want = heapless::String::<64>::new();
        want.push_str("[spinny v").unwrap();
        want.push_str(VERSION).unwrap();
        want.push_str(" lines:16 blocks:32]\n").unwrap();
        assert_eq!(out.as_str(), want.as_str());
        assert_eq!(out.as_str(), "[spinny v0.1.0 lines:16 blocks:32]\n");
    }

    #[test]
    fn message_alarm_error_ok() {
        let mut out = Out::new();
        message("hello", &mut out);
        assert_eq!(out.as_str(), "[MSG:hello]\n");

        let mut out = Out::new();
        alarm(1, &mut out);
        assert_eq!(out.as_str(), "ALARM:1 reset while moving, position may be off\n");

        let mut out = Out::new();
        alarm(7, &mut out);
        assert_eq!(out.as_str(), "ALARM:7 unknown alarm\n");

        let mut out = Out::new();
        error(Error::BadWord, &mut out);
        assert_eq!(out.as_str(), "error:2 bad word\n");

        let mut out = Out::new();
        error(Error::Flash, &mut out);
        assert_eq!(out.as_str(), "error:9 flash failed\n");

        let mut out = Out::new();
        ok(&mut out);
        assert_eq!(out.as_str(), "ok\n");
    }

    #[test]
    fn uint_samples() {
        let mut out = Out::new();
        uint(0, &mut out);
        uint(7, &mut out);
        uint(u64::MAX, &mut out);
        assert_eq!(out.as_str(), "0718446744073709551615");
    }

    #[test]
    fn float_fixed_decimals() {
        assert_eq!(float_text(0.0, 3).as_str(), "0.000");
        assert_eq!(float_text(1.0, 2).as_str(), "1.00");
        assert_eq!(float_text(-1.0, 2).as_str(), "-1.00");
        assert_eq!(float_text(1234.5, 1).as_str(), "1234.5");
        assert_eq!(float_text(123456.0, 0).as_str(), "123456");
        assert_eq!(float_text(0.5, 4).as_str(), "0.5000");
        assert_eq!(float_text(-45.5, 4).as_str(), "-45.5000");
    }

    #[test]
    fn float_rounds_half_away_from_zero() {
        assert_eq!(float_text(2.5, 0).as_str(), "3");
        assert_eq!(float_text(-2.5, 0).as_str(), "-3");
        assert_eq!(float_text(0.0625, 3).as_str(), "0.063");
        assert_eq!(float_text(-0.0625, 3).as_str(), "-0.063");
        assert_eq!(float_text(0.999, 2).as_str(), "1.00");
        assert_eq!(float_text(-0.999, 2).as_str(), "-1.00");
        assert_eq!(float_text(2.4, 0).as_str(), "2");
    }

    #[test]
    fn float_never_prints_minus_zero() {
        assert_eq!(float_text(-0.0, 3).as_str(), "0.000");
        assert_eq!(float_text(-0.0004, 3).as_str(), "0.000");
        assert_eq!(float_text(-0.4, 0).as_str(), "0");
    }

    #[test]
    fn float_special_values() {
        assert_eq!(float_text(f32::NAN, 3).as_str(), "nan");
        assert_eq!(float_text(f32::INFINITY, 3).as_str(), "inf");
        assert_eq!(float_text(f32::NEG_INFINITY, 3).as_str(), "-inf");
        assert_eq!(float_text(1.5, 12).as_str(), "1.500000000");
    }

    #[test]
    fn float_trimmed_samples() {
        assert_eq!(trimmed_text(888.889, 3).as_str(), "888.889");
        assert_eq!(trimmed_text(0.0, 3).as_str(), "0");
        assert_eq!(trimmed_text(2.5, 3).as_str(), "2.5");
        assert_eq!(trimmed_text(1000.0, 3).as_str(), "1000");
        assert_eq!(trimmed_text(0.1, 3).as_str(), "0.1");
        assert_eq!(trimmed_text(-0.5, 3).as_str(), "-0.5");
        assert_eq!(trimmed_text(100.0, 0).as_str(), "100");
        assert_eq!(trimmed_text(0.0004, 3).as_str(), "0");
    }

    #[test]
    fn buffer_drops_overflow() {
        let mut buffer = Buffer::<4>::new();
        buffer.write(b"abcdef");
        assert_eq!(buffer.as_bytes(), b"abcd");
    }
}
