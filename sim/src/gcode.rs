//! Reads a job into timed joint moves.
//!
//! Each move is a straight line in joint space (radius, angle) with the power
//! and duration the controller would give it, stretched when an axis cannot
//! keep up. Under M4 the power then drops by the same ratio, which is what
//! the beam intensity shows.
//!
//! Two controllers are modelled. `Joint` files carry the radius on X and the
//! angle on another letter, with inverse time (G93) or units per minute
//! feed. `Grblhal` files carry board X/Y for grblHAL's polar kinematics,
//! which splits each cut into 0.5 mm pieces, runs every piece as one joint
//! move with F scaled by joint over board distance, and runs rapids as a
//! single joint move.

use std::collections::HashMap;

/// grblHAL's MAX_SEG_LENGTH_MM: cuts longer than this are split evenly.
pub const GRBLHAL_SEGMENT: f64 = 0.5;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Controller {
    Grblhal,
    Joint,
}

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
    pub controller: Controller,
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
            controller: Controller::Grblhal,
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
    let mut position = (0.0, 0.0);
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
        let kind = match modal {
            Some(kind) => kind,
            None => continue,
        };
        let f = feed.unwrap_or(1.0).max(1e-9);
        let text = raw.trim().to_string();

        match limits.controller {
            Controller::Joint => {
                let has_x = map.contains_key(&'X');
                let has_a = map.contains_key(&rotary);
                if !(has_x || has_a) {
                    continue;
                }
                let to_r = map.get(&'X').map(|x| x - limits.axis_x).unwrap_or(radius);
                let to_a = map.get(&rotary).map(|a| a * sign).unwrap_or(angle);
                let dr = (to_r - radius).abs();
                let da = (to_a - angle).abs();
                let wanted = match kind {
                    Kind::Rapid => (dr / limits.x_rapid).max(da / limits.rotary_rapid) * 60.0,
                    Kind::Cut if inverse => 60.0 / f,
                    Kind::Cut => (dr * dr + da * da).sqrt() / f * 60.0,
                };
                push(&mut program, &mut clock, limits, index + 1, &text, kind,
                     (radius, angle), (to_r, to_a), wanted, power, spindle_on, dynamic);
                radius = to_r;
                angle = to_a;
            }
            Controller::Grblhal => {
                if !(map.contains_key(&'X') || map.contains_key(&'Y')) {
                    continue;
                }
                let target = (
                    map.get(&'X').copied().unwrap_or(position.0),
                    map.get(&'Y').copied().unwrap_or(position.1),
                );
                let distance = ((target.0 - position.0).powi(2) + (target.1 - position.1).powi(2)).sqrt();
                let pieces = if kind == Kind::Cut && distance > GRBLHAL_SEGMENT && target != position {
                    (distance / GRBLHAL_SEGMENT).ceil() as usize
                } else {
                    1
                };
                let piece_length = distance / pieces as f64;
                for i in 1..=pieces {
                    let t = i as f64 / pieces as f64;
                    let point = (
                        position.0 + (target.0 - position.0) * t,
                        position.1 + (target.1 - position.1) * t,
                    );
                    let to = grblhal_joint(point, angle);
                    let dr = (to.0 - radius).abs();
                    let da = (to.1 - angle).abs();
                    let joint_distance = (dr * dr + da * da).sqrt();
                    let wanted = match kind {
                        Kind::Rapid => (dr / limits.x_rapid).max(da / limits.rotary_rapid) * 60.0,
                        Kind::Cut => {
                            // The controller scales F by joint over board distance,
                            // never below a half, so the piece takes board length over F.
                            let mut multiplier = if piece_length > 0.0 { joint_distance / piece_length } else { 0.0 };
                            if multiplier == 0.0 {
                                multiplier = 1.0;
                            } else if multiplier < 0.5 {
                                multiplier = 0.5;
                            }
                            joint_distance / (f * multiplier) * 60.0
                        }
                    };
                    push(&mut program, &mut clock, limits, index + 1, &text, kind,
                         (radius, angle), to, wanted, power, spindle_on, dynamic);
                    radius = to.0;
                    angle = to.1;
                }
                position = target;
            }
        }
    }
    program.total = clock;
    program
}

#[allow(clippy::too_many_arguments)]
fn push(
    program: &mut Program,
    clock: &mut f64,
    limits: &Limits,
    line: usize,
    text: &str,
    kind: Kind,
    from: (f64, f64),
    to: (f64, f64),
    wanted: f64,
    power: f64,
    spindle_on: bool,
    dynamic: bool,
) {
    let dr = (to.0 - from.0).abs();
    let da = (to.1 - from.1).abs();
    let seconds = match kind {
        Kind::Rapid => wanted,
        Kind::Cut => wanted
            .max(dr / limits.x_max * 60.0)
            .max(da / limits.rotary_max * 60.0),
    };
    // Under M4 the controller blanks the beam for rapids; M3 does not.
    let on = match kind {
        Kind::Rapid => spindle_on && !dynamic && power > 0.0,
        Kind::Cut => spindle_on && power > 0.0,
    };
    let commanded = if on { power } else { 0.0 };
    let effective = if on && dynamic && seconds > 0.0 {
        power * (wanted / seconds).min(1.0)
    } else {
        commanded
    };
    *clock += seconds;
    program.moves.push(Move {
        line,
        text: text.to_string(),
        kind,
        from,
        to,
        power: commanded,
        effective,
        seconds,
        limited: kind == Kind::Cut && seconds > wanted * (1.0 + 1e-9),
    });
    program.ends.push(*clock);
    if kind == Kind::Cut {
        program.cut_length_joint += (dr * dr + da * da).sqrt();
    }
    program.max_radius = program.max_radius.max(to.0.abs());
}

/// grblHAL's transform_from_cartesian: radius, and the angle unwrapped to
/// the nearest turn, kept unchanged on the axis.
pub fn grblhal_joint(point: (f64, f64), last_angle: f64) -> (f64, f64) {
    let radius = (point.0 * point.0 + point.1 * point.1).sqrt();
    if radius == 0.0 {
        return (0.0, last_angle);
    }
    let angle = point.1.atan2(point.0).to_degrees().rem_euclid(360.0);
    let delta = angle - last_angle.rem_euclid(360.0);
    if delta.abs() <= 180.0 {
        (radius, last_angle + delta)
    } else if delta > 0.0 {
        (radius, last_angle + delta - 360.0)
    } else {
        (radius, last_angle + delta + 360.0)
    }
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

    fn joint() -> Limits {
        Limits {
            controller: Controller::Joint,
            ..Limits::default()
        }
    }

    #[test]
    fn grblhal_splits_cuts_into_half_millimetre_pieces_and_not_rapids() {
        let program = parse("M4 S500\nG0 X10 Y0\nG1 X10 Y2 F400\nG0 X-10 Y0\n", &Limits::default());
        // One rapid, four cut pieces, one rapid across the axis.
        assert_eq!(program.moves.len(), 6);
        let cut: Vec<&Move> = program.moves.iter().filter(|m| m.kind == Kind::Cut).collect();
        assert_eq!(cut.len(), 4);
        // Each piece is 0.5 mm of board at 400 mm/min: 75 ms.
        for m in &cut {
            assert!((m.seconds - 0.075).abs() < 1e-6, "{}", m.seconds);
            assert_eq!(m.power, 500.0);
        }
        assert!((cut[3].to.0 - (104.0f64).sqrt()).abs() < 1e-9);
        // The rapid to the far side is one joint move through half a turn.
        let last = program.moves.last().unwrap();
        assert_eq!(last.kind, Kind::Rapid);
        assert!((last.to.1 - 180.0).abs() < 1e-9);
    }

    #[test]
    fn grblhal_joint_matches_the_controller() {
        assert_eq!(grblhal_joint((0.0, 0.0), 45.0), (0.0, 45.0));
        let (r, a) = grblhal_joint((0.0, -1.0), 10.0);
        assert!((r - 1.0).abs() < 1e-9 && (a + 90.0).abs() < 1e-9);
        let (_, a) = grblhal_joint((1.0, -0.01), 350.0);
        assert!(a > 359.0 && a < 360.0);
        let (_, a) = grblhal_joint((1.0, 0.01), 359.0);
        assert!(a > 360.0);
    }

    #[test]
    fn parses_moves_with_inverse_time_durations() {
        let program = parse(SAMPLE, &joint());
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
            ..joint()
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
            ..joint()
        };
        let program = parse("G0 X15 A-90\n", &limits);
        assert_eq!(program.moves[0].to, (5.0, 90.0));
    }

    #[test]
    fn at_finds_the_move_in_progress() {
        let program = parse(SAMPLE, &joint());
        let (index, t) = program.at(program.ends[0] + 0.5).unwrap();
        assert_eq!(index, 1);
        assert!((t - 0.5).abs() < 1e-9);
        let (last, t_end) = program.at(1e9).unwrap();
        assert_eq!(last, 3);
        assert_eq!(t_end, 1.0);
    }

    #[test]
    fn m3_keeps_the_beam_on_during_rapids() {
        let program = parse("M3 S200\nG0 X1 A0\nG0 X2 A0\n", &joint());
        assert_eq!(program.moves[1].power, 200.0);
        let dynamic = parse("M4 S200\nG0 X1 A0\nG0 X2 A0\n", &joint());
        assert_eq!(dynamic.moves[1].power, 0.0);
    }

    #[test]
    fn board_point_is_polar() {
        let (x, y) = board_point((2.0, 90.0));
        assert!(x.abs() < 1e-9 && (y - 2.0).abs() < 1e-9);
    }
}
