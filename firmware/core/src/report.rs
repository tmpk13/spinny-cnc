//! Status line and message formatting.

use crate::hal::Sink;
use crate::parser::PowerMode;
use crate::AXES;

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

/// `<Idle|J:0.000,0.0000|V:0|L:0|Q:32,16|M:dyn|E:0>` plus newline.
pub fn status(status: &Status, out: &mut impl Sink) {
    let _ = (status, out);
    unimplemented!("report::status")
}

/// `[spinny v0.1.0 lines:16 blocks:32]` plus newline.
pub fn banner(out: &mut impl Sink) {
    let _ = out;
    unimplemented!("report::banner")
}

/// `[MSG:text]` plus newline.
pub fn message(text: &str, out: &mut impl Sink) {
    let _ = (text, out);
    unimplemented!("report::message")
}

/// `ALARM:code text` plus newline.
pub fn alarm(code: u8, out: &mut impl Sink) {
    let _ = (code, out);
    unimplemented!("report::alarm")
}

/// `error:code text` plus newline.
pub fn error(error: crate::parser::Error, out: &mut impl Sink) {
    let _ = (error, out);
    unimplemented!("report::error")
}

/// `ok` plus newline.
pub fn ok(out: &mut impl Sink) {
    out.write(b"ok\n");
}

/// Writes a float with `decimals` places, no exponent, `-0` avoided.
pub fn float(value: f32, decimals: usize, out: &mut impl Sink) {
    let _ = (value, decimals, out);
    unimplemented!("report::float")
}
