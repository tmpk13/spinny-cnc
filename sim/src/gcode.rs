//! Reads polar gcode into timed moves.
//!
//! Each move is a straight line in joint space (radius, angle) with the power
//! and duration the controller would give it: inverse time feed (G93) is
//! one over F minutes, units per minute (G94) is joint distance over F, and
//! either is stretched when an axis cannot keep up. Under M4 the power then
//! drops by the same ratio, which is what the beam intensity shows.

use std::collections::HashMap;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    Rapid,
    Cut,
}

#[derive(Clone, Debug)]
pub struct Move {
    pub line: usize,
    pub text: String,
    pub kind: Kind,
    /// Joint start and end: radius in mm, angle in degrees (board angle, sign applied).
    pub from: (f64, f64),
    pub to: (f64, f64),
    /// Commanded S, and what the beam actually gets after any axis slowdown.
    pub power: f64,
    pub effective: f64,
    pub seconds: f64,
    /// Held below the programmed speed by an axis limit.
    pub limited: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub rotary_axis: char,
    pub invert_rotary: bool,
    pub axis_x: f64,
    pub x_rapid: f64,
    pub rotary_rapid: f64,
    pub x_max: f64,
    pub rotary_max: f64,
    pub s_max: f64,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            rotary_axis: 'A',
            invert_rotary: false,
            axis_x: 0.0,
            x_rapid: 3000.0,
            rotary_rapid: 3600.0,
            x_max: 3000.0,
            rotary_max: 3600.0,
            s_max: 1000.0,
        }
    }
}

#[derive(Debug, Default)]
pub struct Program {
    pub moves: Vec<Move>,
    /// Cumulative end time of each move, seconds.
    pub ends: Vec<f64>,
    pub total: f64,
    pub cut_length_joint: f64,
    pub max_radius: f64,
}

impl Program {
    /// Index of the move in progress at `time`, and how far through it is.
    pub fn at(&self, time: f64) -> Option<(usize, f64)> {
        if self.moves.is_empty() {
            return None;
        }
        let index = match self.ends.binary_search_by(|end| end.partial_cmp(&time).unwrap()) {
            Ok(i) => (i + 1).min(self.moves.len() - 1),
            Err(i) => i.min(self.moves.len() - 1),
        };
        let start = if index == 0 { 0.0 } else { self.ends[index - 1] };
        let span = self.moves[index].seconds;
        let t = if span > 0.0 {
            ((time - start) / span).clamp(0.0, 1.0)
        } else {
            1.0
        };
        Some((index, t))
    }
}

fn words(line: &str) -> Vec<(char, f64)> {
    let code = line.split(';').next().unwrap_or("");
    let mut out = Vec::new();
    let mut chars = code.chars().peekable();
    let mut depth = 0;
    while let Some(c) = chars.next() {
        match c {
            '(' => depth += 1,
            ')' => depth -= 1,
            _ if depth > 0 => {}
            _ if c.is_ascii_alphabetic() => {
                let mut number = String::new();
                while let Some(&n) = chars.peek() {
                    if n.is_ascii_digit() || n == '.' || n == '-' || n == '+' {
                        number.push(n);
                        chars.next();
                    } else {
                        break;
                    }
                }
                if let Ok(value) = number.parse::<f64>() {
                    out.push((c.to_ascii_uppercase(), value));
                }
            }
            _ => {}
        }
    }
    out
}

pub fn parse(text: &str, limits: &Limits) -> Program {
    let mut program = Program::default();
    let mut radius = 0.0;
    let mut angle = 0.0;
    let mut modal: Option<Kind> = None;
    let mut power = 0.0;
    let mut feed: Option<f64> = None;
    let mut inverse = false;
    let mut dynamic = true;
    let mut spindle_on = false;
    let mut clock = 0.0;
    let sign = if limits.invert_rotary { -1.0 } else { 1.0 };
    let rotary = limits.rotary_axis.to_ascii_uppercase();

    for (index, raw) in text.lines().enumerate() {
        let ws = words(raw);
        if ws.is_empty() {
            continue;
        }
        let map: HashMap<char, f64> = ws.iter().cloned().collect();
        let mut line_feed: Option<f64> = None;
        for &(letter, value) in &ws {
            match letter {
                'G' => match value as i32 {
                    0 => modal = Some(Kind::Rapid),
                    1 => modal = Some(Kind::Cut),
                    93 => inverse = true,
                    94 => inverse = false,
                    _ => {}
                },
                'M' => match value as i32 {
                    3 => {
                        spindle_on = true;
                        dynamic = false;
                    }
                    4 => {
                        spindle_on = true;
                        dynamic = true;
                    }
                    5 => spindle_on = false,
                    _ => {}
                },
                'S' => power = value,
                'F' => line_feed = Some(value),
                _ => {}
            }
        }
        if line_feed.is_some() {
            feed = line_feed;
        }
        let has_x = map.contains_key(&'X');
        let has_a = map.contains_key(&rotary);
        if !(has_x || has_a) {
            continue;
        }
        let kind = match modal {
            Some(kind) => kind,
            None => continue,
        };
        let to_r = map.get(&'X').map(|x| x - limits.axis_x).unwrap_or(radius);
        let to_a = map.get(&rotary).map(|a| a * sign).unwrap_or(angle);
        let dr = (to_r - radius).abs();
        let da = (to_a - angle).abs();

        let (programmed, seconds, on) = match kind {
            Kind::Rapid => {
                let t = (dr / limits.x_rapid).max(da / limits.rotary_rapid) * 60.0;
                // Under M4 the controller blanks the beam for rapids; M3 does not.
                (t, t, spindle_on && !dynamic && power > 0.0)
            }
            Kind::Cut => {
                let f = feed.unwrap_or(1.0).max(1e-9);
                let wanted = if inverse {
                    60.0 / f
                } else {
                    (dr * dr + da * da).sqrt() / f * 60.0
                };
                let actual = wanted
                    .max(dr / limits.x_max * 60.0)
                    .max(da / limits.rotary_max * 60.0);
                (wanted, actual, spindle_on && power > 0.0)
            }
        };
        let commanded = if on { power } else { 0.0 };
        let effective = if on && dynamic && seconds > 0.0 {
            power * (programmed / seconds).min(1.0)
        } else {
            commanded
        };
        clock += seconds;
        program.moves.push(Move {
            line: index + 1,
            text: raw.trim().to_string(),
            kind,
            from: (radius, angle),
            to: (to_r, to_a),
            power: commanded,
            effective,
            seconds,
            limited: kind == Kind::Cut && seconds > programmed * (1.0 + 1e-9),
        });
        program.ends.push(clock);
        if kind == Kind::Cut {
            program.cut_length_joint += (dr * dr + da * da).sqrt();
        }
        program.max_radius = program.max_radius.max(to_r.abs());
        radius = to_r;
        angle = to_a;
    }
    program.total = clock;
    program
}

/// Board coordinates of a joint position: where the beam is on the board.
pub fn board_point(joint: (f64, f64)) -> (f64, f64) {
    let (r, a) = joint;
    let t = a.to_radians();
    (r * t.cos(), r * t.sin())
}

pub fn lerp(a: (f64, f64), b: (f64, f64), t: f64) -> (f64, f64) {
    (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "G21\nG90\nG94\nG1F1\nM4 S0\nG93\nG0 X5.000 A0.0000\nG1 X5.000 A10.0000 S500.00 F60\nG1 X6.000 A10.0000 F120\nM4 S0\nM5\nG94\nG0 X0.000 A0.0000\n";

    #[test]
    fn parses_moves_with_inverse_time_durations() {
        let program = parse(SAMPLE, &Limits::default());
        assert_eq!(program.moves.len(), 4);
        let cut = &program.moves[1];
        assert_eq!(cut.kind, Kind::Cut);
        assert!((cut.seconds - 1.0).abs() < 1e-9);
        assert_eq!(cut.power, 500.0);
        assert!((program.moves[2].seconds - 0.5).abs() < 1e-9);
        assert_eq!(program.moves[3].power, 0.0);
        assert_eq!(program.moves[3].line, 13);
    }

    #[test]
    fn a_rotary_limit_stretches_the_move_and_drops_the_power() {
        let limits = Limits {
            rotary_max: 300.0,
            ..Limits::default()
        };
        let program = parse(SAMPLE, &limits);
        let cut = &program.moves[1];
        // Ten degrees at 300 deg/min takes two seconds instead of one.
        assert!((cut.seconds - 2.0).abs() < 1e-9);
        assert!(cut.limited);
        assert!((cut.effective - 250.0).abs() < 1e-9);
    }

    #[test]
    fn inversion_and_axis_offset_apply() {
        let limits = Limits {
            invert_rotary: true,
            axis_x: 10.0,
            ..Limits::default()
        };
        let program = parse("G0 X15 A-90\n", &limits);
        assert_eq!(program.moves[0].to, (5.0, 90.0));
    }

    #[test]
    fn at_finds_the_move_in_progress() {
        let program = parse(SAMPLE, &Limits::default());
        let (index, t) = program.at(program.ends[0] + 0.5).unwrap();
        assert_eq!(index, 1);
        assert!((t - 0.5).abs() < 1e-9);
        let (last, t_end) = program.at(1e9).unwrap();
        assert_eq!(last, 3);
        assert_eq!(t_end, 1.0);
    }

    #[test]
    fn m3_keeps_the_beam_on_during_rapids() {
        let program = parse("M3 S200\nG0 X1 A0\nG0 X2 A0\n", &Limits::default());
        assert_eq!(program.moves[1].power, 200.0);
        let dynamic = parse("M4 S200\nG0 X1 A0\nG0 X2 A0\n", &Limits::default());
        assert_eq!(dynamic.moves[1].power, 0.0);
    }

    #[test]
    fn board_point_is_polar() {
        let (x, y) = board_point((2.0, 90.0));
        assert!(x.abs() < 1e-9 && (y - 2.0).abs() < 1e-9);
    }
}
