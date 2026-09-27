//! What the beam did, as JSON.
//!
//! Marks are board positions sampled while the laser is on, so a plot of
//! them is the burn the job would leave. Sampling is bounded: a mark is
//! kept when the duty changes, when the beam has moved far enough, or
//! after enough time on the move, which keeps a long job to a readable
//! file while a short burn still appears. An output that stays on in one
//! place, a burn in place or a spindle turning at rest, is a mark where
//! it starts and one where it changes: sampled by time, it would fill the
//! file with copies of one point for as long as it is left on.
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
/// Longest gap between marks while the beam is on and moving,
/// microseconds.
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
    /// Joints when the line was sent and when it was answered; a motion
    /// line is answered when the planner takes it, not when it ends.
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
    /// Commands the file had when a write was last tried.
    tried_commands: usize,
    /// Marks, commands and truncation as the file last had them.
    written: (usize, usize, bool),
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
                // Any joint, not the board distance: a slow cut covers less
                // than a step's gate between marks, and a plunge none.
                let still = (mark.r, mark.a, mark.h, mark.z) == (last.r, last.a, last.h, last.z);
                let keep = duty != last.duty
                    || (duty > 0
                        && (moved >= MIN_STEP_MM || (!still && us.saturating_sub(last.us) >= MAX_GAP_US)));
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

    /// Marks kept so far, oldest first.
    pub fn marks(&self) -> &[Mark] {
        &self.marks
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

    /// Marks or commands recorded since a write was last tried: a session
    /// that only moves dark (jogs, probing) is written at rest too.
    pub fn has_fresh(&self) -> bool {
        self.fresh > 0 || self.commands.len() != self.tried_commands
    }

    /// Writes the file if anything is new since the last write. A write
    /// that fails is tried again at the next flush, not at every pass that
    /// asks for fresh marks.
    pub fn flush(&mut self) -> io::Result<()> {
        let Some(path) = self.path.clone() else {
            return Ok(());
        };
        let now = (self.marks.len(), self.commands.len(), self.truncated);
        if now == self.written {
            return Ok(());
        }
        self.fresh = 0;
        self.tried_commands = self.commands.len();
        fs::write(&path, self.render())?;
        self.written = now;
        Ok(())
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
                "{{\"line\": \"{}\", \"sent_us\": {}, \"done_us\": {}, \"from\": {}, \"to\": {}, \"seconds\": {:.4}}}",
                escape(&command.text),
                command.sent_us,
                command.done_us,
                joints(&command.from),
                joints(&command.to),
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

/// Every joint by name: on a cartesian machine the head moves in `r` and
/// `z` with the table held, on a polar one in `r` and `a`, and `h` is the
/// focus or the cutting depth on either.
fn joints(joint: &[f32; AXES]) -> String {
    format!(
        "{{\"r\": {:.4}, \"a\": {:.4}, \"h\": {:.4}, \"z\": {:.4}}}",
        joint[R], joint[A], joint[H], joint[Z]
    )
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
    fn a_slow_move_is_sampled_by_time_and_a_change_of_duty_always_lands() {
        let mut trace = trace();
        // A micron per sample is far under the distance gate.
        trace.sample(0, [5.0, 0.0, 0.0, 0.0], 800);
        trace.sample(MAX_GAP_US / 2, [5.001, 0.0, 0.0, 0.0], 800);
        assert_eq!(trace.marks.len(), 1, "too soon to sample a slow move again");
        trace.sample(MAX_GAP_US, [5.002, 0.0, 0.0, 0.0], 800);
        assert_eq!(trace.marks.len(), 2);
        trace.sample(MAX_GAP_US + 1, [5.002, 0.0, 0.0, 0.0], 0);
        assert_eq!(trace.marks.len(), 3, "the beam closing is always a mark");
        // A plunge moves no board point, and is sampled all the same.
        trace.sample(10 * MAX_GAP_US, [5.002, 0.0, 0.0, 0.0], 600);
        trace.sample(11 * MAX_GAP_US, [5.002, 0.0, -0.01, 0.0], 600);
        assert_eq!(trace.marks.len(), 5);
    }

    #[test]
    fn an_output_left_on_in_one_place_is_marked_once_until_it_changes() {
        let mut trace = trace();
        // A spindle turning at rest, offered at every loop pass for a
        // second: one mark where it started, and nothing new to write.
        for i in 0..=2000u64 {
            trace.sample(i * 500, [5.0, 30.0, 2.0, 1.0], 600);
        }
        assert_eq!(trace.marks.len(), 1);
        assert_eq!(trace.fresh, 1);
        trace.sample(1_000_500, [5.0, 30.0, 2.0, 1.0], 300);
        assert_eq!(trace.marks.len(), 2, "a change of speed is a mark");
        // The last point of a move is kept once the head has stopped on
        // it, and then nothing more.
        trace.sample(1_001_000, [5.001, 30.0, 2.0, 1.0], 300);
        for i in 0..100u64 {
            trace.sample(1_001_000 + (i + 1) * MAX_GAP_US, [5.001, 30.0, 2.0, 1.0], 300);
        }
        assert_eq!(trace.marks.len(), 3);
        assert_eq!(trace.marks[2].r, 5.001f32 as f64);
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
        // A cartesian line: the head goes across the rail, on the slide.
        trace.command(Command {
            text: "cut R6 Z4 F300".into(),
            sent_us: 0,
            done_us: 0,
            from: [2.0, 0.0, -0.1, 1.0],
            to: [6.0, 0.0, -0.1, 4.0],
        });
        let text = trace.render();
        assert!(text.contains("\"marks\": 1"));
        assert!(text.contains("\"line\": \"cut R1 F60 S500\""));
        assert!(text.contains("\"seconds\": 1.0000"));
        assert!(text.contains("\"duty\": 1000"));
        assert!(
            text.contains(
                "\"from\": {\"r\": 2.0000, \"a\": 0.0000, \"h\": -0.1000, \"z\": 1.0000}, \
                 \"to\": {\"r\": 6.0000, \"a\": 0.0000, \"h\": -0.1000, \"z\": 4.0000}"
            ),
            "{text}"
        );
        // One object per line, and only marks start with their time.
        let commands: Vec<&str> = text.lines().filter(|line| line.trim_start().starts_with("{\"line\":")).collect();
        assert_eq!(commands.len(), 2, "{text}");
        assert_eq!(text.lines().filter(|line| line.trim_start().starts_with("{\"us\":")).count(), 1);
    }

    #[test]
    fn the_file_is_written_again_only_when_something_is_new() {
        let path = std::env::temp_dir().join(format!("spinny-virtual-trace-unit-{}.json", std::process::id()));
        let mut trace = Trace::new(Some(path.clone()));
        trace.flush().unwrap();
        assert!(!path.exists(), "nothing to write yet");
        trace.sample(0, [1.0, 0.0, 0.0, 0.0], 500);
        trace.flush().unwrap();
        assert!(path.exists());
        fs::remove_file(&path).unwrap();
        trace.flush().unwrap();
        assert!(!path.exists(), "rewritten with nothing new");
        // An answered line is new, and asks for a write at rest the way a
        // mark does, so a session with the output off reaches the file too.
        trace.command(Command { text: "version".into(), sent_us: 0, done_us: 0, from: [0.0; AXES], to: [0.0; AXES] });
        assert!(trace.has_fresh());
        trace.flush().unwrap();
        assert!(path.exists(), "an answered line is new");
        assert!(!trace.has_fresh());
        fs::remove_file(&path).unwrap();
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
