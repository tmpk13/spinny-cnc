//! What the beam did, as JSON.
//!
//! Marks are board positions sampled while the laser is on, so a plot of
//! them is the burn the job would leave. Sampling is bounded: a mark is
//! kept when the duty changes, when the beam has moved far enough, or
//! after enough time, which keeps a long job to a readable file while a
//! short burn still appears.
//!
//! The board position is the head's, `R` along the rail and the cross
//! slide `Z` across it, turned by the table angle, so it holds for a
//! polar and a cartesian machine alike. With a spindle on the output a
//! mark is where the tool is while it turns; `h` says whether it is in
//! the work.

use std::fmt::Write as _;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use spinny_core::{A, AXES, H, R, Z};

/// Board distance between marks along a cut, mm.
const MIN_STEP_MM: f64 = 0.05;
/// Longest gap between marks while the beam is on, microseconds.
const MAX_GAP_US: u64 = 2000;
/// Marks kept before sampling stops; the file says when it did.
const MAX_MARKS: usize = 200_000;
/// Commands kept, for the same reason: the process outlives many sessions.
const MAX_COMMANDS: usize = 20_000;

#[derive(Clone, Copy, Debug)]
pub struct Mark {
    pub us: u64,
    pub x: f64,
    pub y: f64,
    pub r: f64,
    pub a: f64,
    /// Focus axis, mm.
    pub h: f64,
    /// Cross slide, mm.
    pub z: f64,
    pub duty: u16,
}

/// One line the client sent, with what the machine was doing around it.
#[derive(Clone, Debug)]
pub struct Command {
    pub text: String,
    pub sent_us: u64,
    pub done_us: u64,
    /// Joints before and after; the file carries the radius and angle.
    pub from: [f32; AXES],
    pub to: [f32; AXES],
}

#[derive(Default)]
pub struct Trace {
    path: Option<PathBuf>,
    marks: Vec<Mark>,
    commands: Vec<Command>,
    /// Last mark kept, which the sampling gates measure against.
    last: Option<Mark>,
    truncated: bool,
    /// Marks recorded since the file was last written.
    fresh: usize,
    laser_on_mm: f64,
    max_radius: f64,
}

impl Trace {
    pub fn new(path: Option<PathBuf>) -> Trace {
        Trace { path, ..Trace::default() }
    }

    pub fn enabled(&self) -> bool {
        self.path.is_some()
    }

    /// Offers the beam position after a step. Joint is radius mm, angle
    /// degrees, focus mm and cross slide mm.
    pub fn sample(&mut self, us: u64, joint: [f32; AXES], duty: u16) {
        if self.path.is_none() {
            return;
        }
        let r = joint[R] as f64;
        let z = joint[Z] as f64;
        let a = (joint[A] as f64).to_radians();
        let (x, y) = (r * a.cos() - z * a.sin(), r * a.sin() + z * a.cos());
        let mark = Mark { us, x, y, r, a: joint[A] as f64, h: joint[H] as f64, z, duty };
        // The far side of the axis is as far out as the near one.
        self.max_radius = self.max_radius.max(r.hypot(z));
        let (keep, moved) = match self.last {
            None => (duty > 0, 0.0),
            Some(last) => {
                let moved = ((x - last.x).powi(2) + (y - last.y).powi(2)).sqrt();
                let keep = duty != last.duty
                    || (duty > 0 && (moved >= MIN_STEP_MM || us.saturating_sub(last.us) >= MAX_GAP_US));
                (keep, moved)
            }
        };
        if !keep {
            return;
        }
        if self.marks.len() >= MAX_MARKS {
            self.truncated = true;
            return;
        }
        // Summed between kept marks, not between steps: the axes step one
        // at a time, so a step by step sum measures the staircase the
        // microsteps trace out, around a fifth longer than the line.
        if duty > 0 {
            if let Some(last) = self.last {
                if last.duty > 0 {
                    self.laser_on_mm += moved;
                }
            }
        }
        self.marks.push(mark);
        self.last = Some(mark);
        self.fresh += 1;
    }

    /// Board length burnt so far, mm.
    pub fn laser_on_mm(&self) -> f64 {
        self.laser_on_mm
    }

    pub fn command(&mut self, command: Command) {
        if self.path.is_none() {
            return;
        }
        if self.commands.len() >= MAX_COMMANDS {
            self.truncated = true;
            return;
        }
        self.commands.push(command);
    }

    /// Creates or empties the file, so a path that cannot be written is
    /// known before a run rather than after, and a stale file from an
    /// earlier run cannot pass for this one.
    pub fn open(&self) -> io::Result<()> {
        match &self.path {
            Some(path) => fs::write(path, self.render()),
            None => Ok(()),
        }
    }

    pub fn has_fresh(&self) -> bool {
        self.fresh > 0
    }

    /// Writes the file if anything is new since the last write.
    pub fn flush(&mut self) -> io::Result<()> {
        let Some(path) = self.path.clone() else {
            return Ok(());
        };
        if self.fresh == 0 && self.marks.is_empty() && self.commands.is_empty() {
            return Ok(());
        }
        self.fresh = 0;
        fs::write(&path, self.render())
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    fn render(&self) -> String {
        let mut out = String::with_capacity(self.marks.len() * 64 + 512);
        out.push_str("{\n  \"summary\": {");
        let _ = write!(
            out,
            "\"marks\": {}, \"commands\": {}, \"laser_on_mm\": {:.3}, \"max_radius_mm\": {:.3}, \"truncated\": {}",
            self.marks.len(),
            self.commands.len(),
            self.laser_on_mm,
            self.max_radius,
            self.truncated
        );
        out.push_str("},\n  \"commands\": [");
        for (i, command) in self.commands.iter().enumerate() {
            out.push_str(if i == 0 { "\n    " } else { ",\n    " });
            let _ = write!(
                out,
                "{{\"line\": \"{}\", \"sent_us\": {}, \"done_us\": {}, \"from\": [{:.4}, {:.4}], \"to\": [{:.4}, {:.4}], \"seconds\": {:.4}}}",
                escape(&command.text),
                command.sent_us,
                command.done_us,
                command.from[0],
                command.from[1],
                command.to[0],
                command.to[1],
                (command.done_us.saturating_sub(command.sent_us)) as f64 / 1e6,
            );
        }
        out.push_str("\n  ],\n  \"marks\": [");
        for (i, mark) in self.marks.iter().enumerate() {
            out.push_str(if i == 0 { "\n    " } else { ",\n    " });
            let _ = write!(
                out,
                "{{\"us\": {}, \"x\": {:.4}, \"y\": {:.4}, \"r\": {:.4}, \"a\": {:.4}, \"h\": {:.4}, \"z\": {:.4}, \"duty\": {}}}",
                mark.us, mark.x, mark.y, mark.r, mark.a, mark.h, mark.z, mark.duty
            );
        }
        out.push_str("\n  ]\n}\n");
        out
    }
}

fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push(' '),
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trace() -> Trace {
        Trace::new(Some(PathBuf::from("/dev/null")))
    }

    #[test]
    fn marks_start_when_the_beam_opens_and_follow_the_move() {
        let mut trace = trace();
        trace.sample(0, [10.0, 0.0, 0.0, 0.0], 0);
        assert!(trace.marks.is_empty(), "a dark move leaves no mark");
        trace.sample(100, [10.0, 0.0, 0.0, 0.0], 500);
        assert_eq!(trace.marks.len(), 1);
        // Half a degree at 10 mm is 0.087 mm, past the distance gate.
        trace.sample(200, [10.0, 0.5, 0.0, 0.0], 500);
        assert_eq!(trace.marks.len(), 2);
        let last = trace.marks[1];
        assert!((last.x - 10.0 * 0.5f64.to_radians().cos()).abs() < 1e-9);
        assert!((last.y - 10.0 * 0.5f64.to_radians().sin()).abs() < 1e-9);
    }

    #[test]
    fn burnt_length_follows_the_line_and_not_the_microstep_staircase() {
        let mut trace = trace();
        // A cut along the rail, offered one step at a time: the sum must
        // be the line, not the sum of the steps that make it up.
        for i in 0..=2000 {
            trace.sample(i as u64 * 100, [10.0 + i as f32 * 0.001, 0.0, 0.0, 0.0], 500);
        }
        assert!((trace.laser_on_mm() - 2.0).abs() < 0.11, "{}", trace.laser_on_mm());
        // A dark move adds nothing.
        let burnt = trace.laser_on_mm();
        for i in 0..=100 {
            trace.sample(1_000_000 + i as u64 * 100, [12.0 + i as f32 * 0.05, 0.0, 0.0, 0.0], 0);
        }
        assert_eq!(trace.laser_on_mm(), burnt);
    }

    #[test]
    fn a_still_beam_is_sampled_by_time_and_a_change_of_duty_always_lands() {
        let mut trace = trace();
        trace.sample(0, [5.0, 0.0, 0.0, 0.0], 800);
        trace.sample(MAX_GAP_US / 2, [5.0, 0.0, 0.0, 0.0], 800);
        assert_eq!(trace.marks.len(), 1, "too soon to sample a still beam again");
        trace.sample(MAX_GAP_US, [5.0, 0.0, 0.0, 0.0], 800);
        assert_eq!(trace.marks.len(), 2);
        trace.sample(MAX_GAP_US + 1, [5.0, 0.0, 0.0, 0.0], 0);
        assert_eq!(trace.marks.len(), 3, "the beam closing is always a mark");
    }

    #[test]
    fn json_carries_the_summary_the_commands_and_the_marks() {
        let mut trace = trace();
        trace.sample(0, [1.0, 0.0, 0.0, 0.0], 1000);
        trace.command(Command {
            text: "cut R1 F60 S500".into(),
            sent_us: 0,
            done_us: 1_000_000,
            from: [0.0, 0.0, 0.0, 0.0],
            to: [1.0, 0.0, 0.0, 0.0],
        });
        let text = trace.render();
        assert!(text.contains("\"marks\": 1"));
        assert!(text.contains("\"line\": \"cut R1 F60 S500\""));
        assert!(text.contains("\"seconds\": 1.0000"));
        assert!(text.contains("\"duty\": 1000"));
    }

    #[test]
    fn the_far_side_counts_toward_the_reach() {
        let mut trace = trace();
        trace.sample(0, [-6.0, 0.0, 0.0, 0.0], 800);
        trace.sample(100, [-4.0, 110.0, 0.0, 0.0], 800);
        assert!((trace.max_radius - 6.0).abs() < 1e-9);
    }

    #[test]
    fn the_cross_slide_moves_the_mark_across_the_rail() {
        let mut trace = trace();
        trace.sample(0, [10.0, 90.0, 0.0, 2.0], 500);
        let mark = trace.marks[0];
        // At 90 degrees the rail points along board Y and across it is -X.
        assert!((mark.x + 2.0).abs() < 1e-6 && (mark.y - 10.0).abs() < 1e-6, "{mark:?}");
        assert_eq!(mark.z, 2.0);
        assert!((trace.max_radius - 104.0f64.sqrt()).abs() < 1e-9);
    }

    #[test]
    fn quotes_and_control_bytes_cannot_break_the_json() {
        assert_eq!(escape("a\"b\\c\u{1}d"), "a\\\"b\\\\c d");
    }
}
