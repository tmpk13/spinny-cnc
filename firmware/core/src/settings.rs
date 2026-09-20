//! Machine settings: names, units, defaults, text get/set, and a flash blob.
//!
//! Names and defaults are the table in docs/PROTOCOL.md.

use crate::hal::Sink;
use crate::AXES;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Settings {
    /// Steps per mm (radius) and per degree (table).
    pub steps: [f32; AXES],
    /// Units per minute.
    pub max_rate: [f32; AXES],
    /// Units per second squared.
    pub accel: [f32; AXES],
    /// Allowed instantaneous speed change at a junction, units per second.
    pub jerk: [f32; AXES],
    /// Radius soft limit, mm; 0 = off.
    pub r_max: f32,
    /// Jog rates without an F word, units per minute.
    pub jog_rate: [f32; AXES],
    /// Bit i inverts axis i.
    pub dir_invert: u8,
    /// Enable pin is active high.
    pub en_invert: bool,
    /// Disable the motors after this long idle; 0 = never.
    pub idle_ms: u32,
    /// Step pulse width.
    pub step_us: u32,
    pub laser_hz: u32,
    /// S for full duty.
    pub s_max: f32,
    /// Dynamic mode: a computed power below this is off.
    pub s_min: f32,
    pub laser_invert: bool,
    /// Default timeout for the `laser` command.
    pub laser_ms: u32,
    /// Run current per axis, mA; 0 leaves that driver untouched.
    pub tmc_ma: [u32; AXES],
    pub tmc_hold_pct: u32,
    pub tmc_micro: [u32; AXES],
    pub tmc_stealth: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            steps: [256.0, 888.889],
            max_rate: [1000.0, 1080.0],
            accel: [50.0, 50.0],
            jerk: [3.0, 10.0],
            r_max: 0.0,
            jog_rate: [600.0, 720.0],
            dir_invert: 0,
            en_invert: false,
            idle_ms: 0,
            step_us: 2,
            laser_hz: 5000,
            s_max: 1000.0,
            s_min: 0.0,
            laser_invert: false,
            laser_ms: 5000,
            tmc_ma: [800, 800],
            tmc_hold_pct: 50,
            tmc_micro: [16, 16],
            tmc_stealth: true,
        }
    }
}

/// Every setting name, in the order `$` lists them.
pub const NAMES: [&str; 26] = [
    "r_steps", "a_steps", "r_rate", "a_rate", "r_accel", "a_accel", "r_jerk", "a_jerk",
    "r_max", "jog_r", "jog_a", "dir_invert", "en_invert", "idle_ms", "step_us",
    "laser_hz", "s_max", "s_min", "laser_invert", "laser_ms",
    "tmc_r_ma", "tmc_a_ma", "tmc_hold_pct", "tmc_r_micro", "tmc_a_micro", "tmc_stealth",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SetError {
    Unknown,
    BadValue,
}

/// What a change touches, so the machine can re-apply it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Changed {
    Motion,
    Laser,
    Driver,
    Other,
}

/// Size of the persisted blob: magic, version, the fields, a CRC-32.
pub const BLOB_LEN: usize = 128;

impl Settings {
    /// Writes `name=value\n` for one setting; false for an unknown name.
    pub fn format(&self, name: &str, out: &mut impl Sink) -> bool {
        let _ = (name, out);
        unimplemented!("settings::format")
    }

    /// Writes every setting, one per line, in `NAMES` order.
    pub fn format_all(&self, out: &mut impl Sink) {
        let _ = out;
        unimplemented!("settings::format_all")
    }

    /// Parses `text` for `name`; ranges are checked (steps and rates
    /// positive, percentages 0..100, microsteps a power of two 1..256).
    pub fn set(&mut self, name: &str, text: &str) -> Result<Changed, SetError> {
        let _ = (name, text);
        unimplemented!("settings::set")
    }

    /// Serializes for the store. Layout is private to this module.
    pub fn to_blob(&self, buf: &mut [u8; BLOB_LEN]) {
        let _ = buf;
        unimplemented!("settings::to_blob")
    }

    /// `None` when the magic, version or CRC do not match.
    pub fn from_blob(buf: &[u8]) -> Option<Settings> {
        let _ = buf;
        unimplemented!("settings::from_blob")
    }
}
