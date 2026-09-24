//! A board under the probe, so a probe on the virtual machine finds one.
//!
//! The board's top, as the focus axis position at which the probe tip
//! touches it, is a smooth function of the board point: a base height, a
//! tilt along X and Y, and a bowl about the rotation axis, which covers
//! the warps a clamped board shows. The probe tip may sit off the beam,
//! `along` the rail and `across` it, as it does on a head that carries
//! both; the board point under the tip turns with the table like the one
//! under the beam.

use spinny_core::{A, AXES, H, R};

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Surface {
    /// Height at the rotation axis, mm.
    pub base: f64,
    /// Rise per mm along board X and Y.
    pub slope: [f64; 2],
    /// Rise per mm squared of distance from the axis: a bowl when
    /// positive, a dome when negative.
    pub curve: f64,
    /// The probe tip from the beam: along the rail and across it, mm.
    pub offset: [f64; 2],
}

impl Surface {
    /// `BASE[,SX,SY[,CURVE]]`, plain decimals.
    pub fn parse(text: &str) -> Result<Surface, String> {
        let values = numbers(text)?;
        let mut surface = Surface::default();
        match values.as_slice() {
            [base] => surface.base = *base,
            [base, sx, sy] => {
                surface.base = *base;
                surface.slope = [*sx, *sy];
            }
            [base, sx, sy, curve] => {
                surface.base = *base;
                surface.slope = [*sx, *sy];
                surface.curve = *curve;
            }
            _ => return Err(format!("--surface wants BASE[,SX,SY[,CURVE]], got {text:?}")),
        }
        Ok(surface)
    }

    /// `ALONG,ACROSS` for the probe tip's offset from the beam.
    pub fn parse_offset(text: &str) -> Result<[f64; 2], String> {
        match numbers(text)?.as_slice() {
            [along, across] => Ok([*along, *across]),
            _ => Err(format!("--probe-offset wants ALONG,ACROSS, got {text:?}")),
        }
    }

    /// Top of the board at a board point.
    pub fn height(&self, x: f64, y: f64) -> f64 {
        self.base + self.slope[0] * x + self.slope[1] * y + self.curve * (x * x + y * y)
    }

    /// Board point under the probe tip with the head at `joint`.
    pub fn under_probe(&self, joint: [f32; AXES]) -> (f64, f64) {
        let theta = (joint[A] as f64).to_radians();
        let radius = joint[R] as f64 + self.offset[0];
        let across = self.offset[1];
        (radius * theta.cos() - across * theta.sin(), radius * theta.sin() + across * theta.cos())
    }

    /// The probe is down on the board. A hair under a step is allowed, so
    /// a height that is a whole number of steps is met on that step even
    /// though the position comes back from the steps in single precision.
    pub fn touching(&self, joint: [f32; AXES]) -> bool {
        let (x, y) = self.under_probe(joint);
        joint[H] as f64 <= self.height(x, y) + 1e-6
    }
}

fn numbers(text: &str) -> Result<Vec<f64>, String> {
    text.split(',')
        .map(|part| {
            part.trim()
                .parse::<f64>()
                .ok()
                .filter(|v| v.is_finite())
                .ok_or_else(|| format!("{part:?} is not a number"))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_each_form() {
        assert_eq!(Surface::parse("-1.5").unwrap(), Surface { base: -1.5, ..Surface::default() });
        let tilted = Surface::parse("0, 0.01, -0.02").unwrap();
        assert_eq!(tilted.slope, [0.01, -0.02]);
        assert_eq!(Surface::parse("1,0,0,0.001").unwrap().curve, 0.001);
        assert!(Surface::parse("1,2").is_err());
        assert!(Surface::parse("x").is_err());
        assert!(Surface::parse("nan").is_err());
        assert_eq!(Surface::parse_offset("5,-2").unwrap(), [5.0, -2.0]);
        assert!(Surface::parse_offset("5").is_err());
    }

    #[test]
    fn the_board_turns_with_the_table() {
        let surface = Surface { slope: [0.1, 0.0], ..Surface::default() };
        // Beam at 10 mm on the rail, table at 90 degrees: board point (0, 10).
        let (x, y) = surface.under_probe([10.0, 90.0, 0.0]);
        assert!(x.abs() < 1e-9 && (y - 10.0).abs() < 1e-9);
        assert!(surface.touching([10.0, 90.0, 0.0]));
        // At 0 degrees the same radius is board X 10, one mm up the slope.
        assert!(!surface.touching([10.0, 0.0, 1.5]));
        assert!(surface.touching([10.0, 0.0, 1.0]));
    }

    #[test]
    fn the_tip_sits_off_the_beam() {
        let surface = Surface { offset: [2.0, 3.0], ..Surface::default() };
        let (x, y) = surface.under_probe([10.0, 0.0, 0.0]);
        assert!((x - 12.0).abs() < 1e-9 && (y - 3.0).abs() < 1e-9);
        let (x, y) = surface.under_probe([10.0, 90.0, 0.0]);
        assert!((x + 3.0).abs() < 1e-9 && (y - 12.0).abs() < 1e-9);
    }
}
