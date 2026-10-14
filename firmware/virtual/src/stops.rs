//! Endstops for the virtual machine: a switch at either end of a joint,
//! closed while the joint is at or past it.

use spinny_core::settings::Settings;
use spinny_core::{A, AXES, H, R, Z};

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Stops {
    /// Position at or below which the joint's negative switch is closed.
    pub min: [Option<f32>; AXES],
    /// Position at or above which the joint's positive switch is closed.
    pub max: [Option<f32>; AXES],
}

impl Stops {
    /// Adds one `--stop`: a joint letter, the negative switch's position,
    /// a comma and the positive one's, either left out: `R-5,130`,
    /// `A0`, `H,20`.
    pub fn add(&mut self, text: &str) -> Result<(), String> {
        let bad = || format!("--stop wants LETTER[MIN][,MAX], got {text:?}");
        let mut chars = text.chars();
        let joint = match chars.next().map(|c| c.to_ascii_uppercase()) {
            Some('R') => R,
            Some('A') => A,
            Some('H') => H,
            Some('Z') => Z,
            _ => return Err(bad()),
        };
        let rest = chars.as_str();
        let (min, max) = rest.split_once(',').unwrap_or((rest, ""));
        let parse = |s: &str| -> Result<Option<f32>, String> {
            if s.is_empty() {
                Ok(None)
            } else {
                s.parse::<f32>().map(Some).map_err(|_| bad())
            }
        };
        self.min[joint] = parse(min)?;
        self.max[joint] = parse(max)?;
        if self.min[joint].is_none() && self.max[joint].is_none() {
            return Err(bad());
        }
        Ok(())
    }

    /// The joints whose switch is closed with the joints at `joint`, bit
    /// per joint.
    pub fn closed(&self, joint: [f32; AXES]) -> u8 {
        let mut mask = 0;
        for i in 0..AXES {
            let low = self.min[i].is_some_and(|at| joint[i] <= at);
            let high = self.max[i].is_some_and(|at| joint[i] >= at);
            if low || high {
                mask |= 1 << i;
            }
        }
        mask
    }

    /// The endstop input levels the board would read: a closed switch
    /// pulls its input to the level `stop_invert` calls closed, an open
    /// one rests at the other.
    pub fn levels(&self, joint: [f32; AXES], settings: &Settings) -> u8 {
        !(self.closed(joint) ^ settings.joint_stop_invert()) & 0b1111
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn switches_close_at_and_past_their_positions() {
        let mut stops = Stops::default();
        stops.add("R-5,130").unwrap();
        stops.add("a0").unwrap();
        stops.add("H,20").unwrap();
        assert_eq!(stops.closed([0.0, 1.0, 0.0, 0.0]), 0);
        assert_eq!(stops.closed([-5.0, 0.0, 20.0, 0.0]), 1 << R | 1 << A | 1 << H);
        assert_eq!(stops.closed([131.0, 0.5, 19.9, -100.0]), 1 << R);
        assert!(stops.add("X1").is_err());
        assert!(stops.add("R").is_err());
        assert!(stops.add("R1,b").is_err());
    }

    #[test]
    fn levels_follow_the_polarity() {
        let mut stops = Stops::default();
        stops.add("R-5").unwrap();
        let mut settings = Settings::default();
        assert_eq!(stops.levels([-5.0, 0.0, 0.0, 0.0], &settings), 0b1110, "closed pulls low");
        assert_eq!(stops.levels([0.0, 0.0, 0.0, 0.0], &settings), 0b1111);
        settings.stop_invert = 1;
        assert_eq!(stops.levels([-5.0, 0.0, 0.0, 0.0], &settings), 0b1111, "closed pulls high");
        assert_eq!(stops.levels([0.0, 0.0, 0.0, 0.0], &settings), 0b1110);
    }
}
