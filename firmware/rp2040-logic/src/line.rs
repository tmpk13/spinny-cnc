//! Turns the USB byte stream into realtime actions and complete lines.
//!
//! Realtime bytes are reported the moment they arrive and never enter the
//! line. `\r` is ignored, `\n` ends a line. A line longer than
//! `PAYLOAD_MAX` is dropped and reported as too long once its newline
//! arrives, so the host still gets exactly one answer for it. Bytes that
//! cannot be part of a command are replaced by `?`, which no command
//! accepts, so a damaged line fails instead of silently changing meaning.

use heapless::String;
use spinny_core::parser::{realtime, Realtime};
use spinny_core::LINE_MAX;

/// A complete line without its newline.
pub type Line = String<LINE_MAX>;

/// Longest accepted line body; `LINE_MAX` counts the newline.
pub const PAYLOAD_MAX: usize = LINE_MAX - 1;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    Realtime(Realtime),
    Line(Line),
    TooLong,
}

#[derive(Default)]
pub struct LineAssembler {
    line: Line,
    overflow: bool,
}

impl LineAssembler {
    pub const fn new() -> Self {
        LineAssembler {
            line: String::new(),
            overflow: false,
        }
    }

    /// Drops a partial line, for a new connection.
    pub fn reset(&mut self) {
        self.line.clear();
        self.overflow = false;
    }

    pub fn push(&mut self, byte: u8) -> Option<Event> {
        if let Some(action) = realtime(byte) {
            return Some(Event::Realtime(action));
        }
        match byte {
            b'\r' => None,
            b'\n' => {
                let event = if self.overflow {
                    Event::TooLong
                } else {
                    Event::Line(core::mem::take(&mut self.line))
                };
                self.reset();
                Some(event)
            }
            _ => {
                if self.overflow {
                    return None;
                }
                let c = match byte {
                    0x20..=0x7e => byte as char,
                    b'\t' => ' ',
                    _ => '?',
                };
                if self.line.len() >= PAYLOAD_MAX || self.line.push(c).is_err() {
                    self.line.clear();
                    self.overflow = true;
                }
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(asm: &mut LineAssembler, bytes: &[u8]) -> Vec<Event> {
        bytes.iter().filter_map(|&b| asm.push(b)).collect()
    }

    fn line(text: &str) -> Event {
        Event::Line(String::try_from(text).unwrap())
    }

    #[test]
    fn lines_end_at_newline_and_ignore_cr() {
        let mut asm = LineAssembler::new();
        let events = feed(&mut asm, b"go R1\r\ncut A90 F300\n\n");
        assert_eq!(events, vec![line("go R1"), line("cut A90 F300"), line("")]);
    }

    #[test]
    fn realtime_bytes_bypass_the_line() {
        let mut asm = LineAssembler::new();
        let events = feed(&mut asm, b"go ?R1!\n~\x18\x85");
        assert_eq!(
            events,
            vec![
                Event::Realtime(Realtime::Status),
                Event::Realtime(Realtime::Hold),
                line("go R1"),
                Event::Realtime(Realtime::Resume),
                Event::Realtime(Realtime::Reset),
                Event::Realtime(Realtime::JogCancel),
            ]
        );
    }

    #[test]
    fn longest_line_is_accepted_and_one_more_byte_is_not() {
        let mut asm = LineAssembler::new();
        let body: Vec<u8> = core::iter::repeat_n(b'a', PAYLOAD_MAX).collect();
        let mut bytes = body.clone();
        bytes.push(b'\n');
        let events = feed(&mut asm, &bytes);
        assert_eq!(events.len(), 1);
        assert!(matches!(&events[0], Event::Line(l) if l.len() == PAYLOAD_MAX));

        let mut bytes = body;
        bytes.extend_from_slice(b"b\ngo\n");
        let events = feed(&mut asm, &bytes);
        assert_eq!(events, vec![Event::TooLong, line("go")]);
    }

    #[test]
    fn realtime_bytes_still_work_inside_an_overlong_line() {
        let mut asm = LineAssembler::new();
        let bytes: Vec<u8> = core::iter::repeat_n(b'x', 200).chain(b"?\n".iter().copied()).collect();
        let events = feed(&mut asm, &bytes);
        assert_eq!(events, vec![Event::Realtime(Realtime::Status), Event::TooLong]);
    }

    #[test]
    fn unusable_bytes_become_question_marks() {
        let mut asm = LineAssembler::new();
        let events = feed(&mut asm, b"go\tR\xff1\x01\n");
        assert_eq!(events, vec![line("go R?1?")]);
    }

    #[test]
    fn reset_drops_a_partial_line() {
        let mut asm = LineAssembler::new();
        assert!(feed(&mut asm, b"go R").is_empty());
        asm.reset();
        assert_eq!(feed(&mut asm, b"cut\n"), vec![line("cut")]);
    }
}
