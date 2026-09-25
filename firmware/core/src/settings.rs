//! Machine settings: names, units, defaults, text get/set, and a flash blob.
//!
//! Names and defaults are the table in docs/PROTOCOL.md. A `Settings` value
//! produced by this module is always within range: `set` refuses a change
//! that would leave it otherwise and `from_blob` rejects a stored copy that
//! is.

use crate::hal::Sink;
use crate::parser::number;
use crate::report;
use crate::{A, AXES, H, R, SEGMENTS, SEGMENT_MS, Z};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Settings {
    /// Steps per mm (radius, focus, cross slide) and per degree (table).
    /// The cross slide's entries are its `z_*` settings, used by `slide`
    /// as a setup axis and by the planner as a joint under `cartesian`.
    pub steps: [f32; AXES],
    /// Units per minute.
    pub max_rate: [f32; AXES],
    /// Units per second squared.
    pub accel: [f32; AXES],
    /// Allowed instantaneous speed change at a junction, units per second.
    pub jerk: [f32; AXES],
    /// Radius soft limit, mm; 0 = off.
    pub r_max: f32,
    /// Cross slide soft limit, mm either side of zero; 0 = off.
    pub z_max: f32,
    /// Jog rates without an F word, units per minute.
    pub jog_rate: [f32; AXES],
    /// Bit 0 inverts the radius, bit 1 the table, bit 2 the cross slide,
    /// bit 3 the focus axis.
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
    /// A focus axis is fitted: `H` words are taken and its driver is
    /// configured. Off, the axis never moves.
    pub h_axis: bool,
    /// The probe input is active high; off, it is active low, as a switch
    /// or a pin touching grounded copper pulls it down.
    pub probe_invert: bool,
    /// Motion kept queued ahead of the step interrupt during a probe, ms:
    /// with the segment being stepped, how long the head goes on past the
    /// contact before its brake starts. Whole segments, rounded up; 0 stops
    /// the axis at the contact without a brake when the probe is slow
    /// enough for that (see `stepper`).
    pub probe_ms: u32,
    /// The cross slide is a joint: Y of an X/Y machine whose X is the
    /// radius, interpolated with it and with the focus axis, while the
    /// table holds its angle. Off, it is the setup axis in `slide`.
    pub cartesian: bool,
    /// The laser output drives a spindle: it runs at the speed `spindle`
    /// set until `spindle off`, a reset or an alarm, through every move
    /// and hold, and `S` is its speed rather than a beam power.
    pub spindle: bool,
}

/// Largest `probe_ms`: the whole segment ring.
pub const PROBE_MS_MAX: u32 = SEGMENTS as u32 * SEGMENT_MS;

impl Default for Settings {
    fn default() -> Self {
        Settings {
            // Both motors are 200 step at 256 microsteps. The radius rides
            // a 5 mm per turn screw, the table a 100:1 drive.
            // The focus axis is assumed to be a 200 step motor on an 8 mm
            // lead screw at 256 microsteps. The cross slide rides the same
            // screw and driver as the radius, so it keeps the radius scale,
            // rate and jerk.
            steps: [10240.0, 14222.222, 6400.0, 10240.0],
            // The step generator runs out before the motors do at this
            // resolution: 586 mm/min on the radius and 422 deg/min on the
            // table. Asking for more only moves slower than commanded.
            max_rate: [560.0, 400.0, 600.0, 560.0],
            accel: [50.0, 50.0, 50.0, 50.0],
            jerk: [3.0, 2.0, 1.0, 3.0],
            r_max: 0.0,
            z_max: 0.0,
            jog_rate: [300.0, 200.0, 120.0, 120.0],
            dir_invert: 0,
            en_invert: false,
            idle_ms: 0,
            step_us: 2,
            laser_hz: 5000,
            s_max: 1000.0,
            s_min: 0.0,
            laser_invert: false,
            laser_ms: 5000,
            tmc_ma: [800, 800, 600, 800],
            tmc_hold_pct: 50,
            tmc_micro: [256, 256, 256, 256],
            tmc_stealth: true,
            h_axis: false,
            probe_invert: false,
            probe_ms: 20,
            cartesian: false,
            spindle: false,
        }
    }
}

/// Every setting name, in the order `$` lists them.
pub const NAMES: [&str; 46] = [
    "r_steps", "a_steps", "r_rate", "a_rate", "r_accel", "a_accel", "r_jerk", "a_jerk",
    "r_max", "z_steps", "z_rate", "z_accel", "jog_z", "jog_r", "jog_a",
    "dir_invert", "en_invert", "idle_ms", "step_us",
    "laser_hz", "s_max", "s_min", "laser_invert", "laser_ms",
    "tmc_r_ma", "tmc_a_ma", "tmc_hold_pct", "tmc_r_micro", "tmc_a_micro",
    "tmc_z_ma", "tmc_z_micro", "tmc_stealth",
    "h_axis", "h_steps", "h_rate", "h_accel", "h_jerk", "jog_h", "probe_invert",
    "tmc_h_ma", "tmc_h_micro", "probe_ms",
    "z_jerk", "z_max", "cartesian", "spindle",
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
    /// `cartesian`: the cross slide changes hands between `slide` and the
    /// joints.
    Kinematics,
    /// `spindle`: the output changes meaning, so whatever runs on it stops.
    Tool,
    Other,
}

/// Size of the persisted blob: magic, version, the fields, a CRC-32.
pub const BLOB_LEN: usize = 256;

/// Largest value any float setting may take; keeps the step arithmetic
/// far from f32 and u32 limits.
pub const FLOAT_MAX: f32 = 1.0e7;

const MAGIC: [u8; 4] = *b"SPNY";
/// Bumped whenever the field layout changes, so a blob written by an
/// older firmware is thrown away rather than read as this layout. Version
/// 5 is version 4 with fields appended, so a version 4 blob is still read,
/// with those fields at their defaults.
const BLOB_VERSION: u8 = 5;
/// Oldest version whose fields are a prefix of this layout.
const BLOB_VERSION_PREFIX: u8 = 4;
/// Bytes before the first field: magic and version.
const HEADER_LEN: usize = MAGIC.len() + 1;
/// Joints stored per array in the version 4 part of the blob, in this
/// order; the cross slide's values follow them as separate fields there.
const PREFIX_JOINTS: [usize; 3] = [R, A, H];
/// Serialized size of the version 4 fields.
const PREFIX_LEN: usize = 4 * (3 + 3 + 3 + 3 + 1 + 4 + 3)
    + 1 + 1 + 4 + 4 + 4 + 4 + 4 + 1 + 4
    + 4 * 3 + 4 + 4 * 3 + 4 + 4 + 1
    + 1 + 1 + 4;
/// Serialized size of the fields, in blob order: the version 4 fields,
/// then `z_jerk`, `z_max`, `cartesian` and `spindle`.
const FIELDS_LEN: usize = PREFIX_LEN + 4 + 4 + 1 + 1;
/// The CRC covers everything before it.
const CRC_OFFSET: usize = BLOB_LEN - 4;
const _: () = assert!(HEADER_LEN + FIELDS_LEN <= CRC_OFFSET);

/// One field of `Settings` by reference, so parsing and printing are
/// written once per type.
enum Slot<'a> {
    Float(&'a mut f32),
    Int(&'a mut u32),
    Byte(&'a mut u8),
    Flag(&'a mut bool),
}

/// Position of `name` in `NAMES`, ignoring case.
fn index_of(name: &str) -> Option<usize> {
    NAMES.iter().position(|known| known.eq_ignore_ascii_case(name))
}

fn group(index: usize) -> Changed {
    match index {
        0..=18 | 33..=38 | 41..=43 => Changed::Motion,
        19..=23 => Changed::Laser,
        44 => Changed::Kinematics,
        45 => Changed::Tool,
        // Whether the focus axis is fitted decides whether its driver is
        // configured.
        _ => Changed::Driver,
    }
}

/// Unsigned decimal integer: digits only.
fn integer(text: &str) -> Option<u32> {
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse::<u32>().ok()
}

fn flag(text: &str) -> Option<bool> {
    match text {
        "0" => Some(false),
        "1" => Some(true),
        _ => None,
    }
}

/// CRC-32 as used by Ethernet and zip: reflected, polynomial 0xEDB88320,
/// initial and final xor all ones. Computed bit by bit, no table.
pub fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &byte in data {
        crc ^= byte as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

struct Writer<'a> {
    buf: &'a mut [u8],
    at: usize,
}

impl Writer<'_> {
    fn bytes(&mut self, bytes: &[u8]) {
        self.buf[self.at..self.at + bytes.len()].copy_from_slice(bytes);
        self.at += bytes.len();
    }

    fn u8(&mut self, value: u8) {
        self.bytes(&[value]);
    }

    fn u32(&mut self, value: u32) {
        self.bytes(&value.to_le_bytes());
    }

    fn f32(&mut self, value: f32) {
        self.bytes(&value.to_le_bytes());
    }

    fn flag(&mut self, value: bool) {
        self.u8(value as u8);
    }
}

struct Reader<'a> {
    buf: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn take<const N: usize>(&mut self) -> [u8; N] {
        let mut bytes = [0u8; N];
        bytes.copy_from_slice(&self.buf[self.at..self.at + N]);
        self.at += N;
        bytes
    }

    fn u8(&mut self) -> u8 {
        self.take::<1>()[0]
    }

    fn u32(&mut self) -> u32 {
        u32::from_le_bytes(self.take())
    }

    fn f32(&mut self) -> f32 {
        f32::from_le_bytes(self.take())
    }

    /// `None` for anything but 0 or 1.
    fn flag(&mut self) -> Option<bool> {
        match self.u8() {
            0 => Some(false),
            1 => Some(true),
            _ => None,
        }
    }
}

impl Settings {
    fn slot(&mut self, index: usize) -> Slot<'_> {
        match index {
            0 => Slot::Float(&mut self.steps[R]),
            1 => Slot::Float(&mut self.steps[A]),
            2 => Slot::Float(&mut self.max_rate[R]),
            3 => Slot::Float(&mut self.max_rate[A]),
            4 => Slot::Float(&mut self.accel[R]),
            5 => Slot::Float(&mut self.accel[A]),
            6 => Slot::Float(&mut self.jerk[R]),
            7 => Slot::Float(&mut self.jerk[A]),
            8 => Slot::Float(&mut self.r_max),
            9 => Slot::Float(&mut self.steps[Z]),
            10 => Slot::Float(&mut self.max_rate[Z]),
            11 => Slot::Float(&mut self.accel[Z]),
            12 => Slot::Float(&mut self.jog_rate[Z]),
            13 => Slot::Float(&mut self.jog_rate[R]),
            14 => Slot::Float(&mut self.jog_rate[A]),
            15 => Slot::Byte(&mut self.dir_invert),
            16 => Slot::Flag(&mut self.en_invert),
            17 => Slot::Int(&mut self.idle_ms),
            18 => Slot::Int(&mut self.step_us),
            19 => Slot::Int(&mut self.laser_hz),
            20 => Slot::Float(&mut self.s_max),
            21 => Slot::Float(&mut self.s_min),
            22 => Slot::Flag(&mut self.laser_invert),
            23 => Slot::Int(&mut self.laser_ms),
            24 => Slot::Int(&mut self.tmc_ma[R]),
            25 => Slot::Int(&mut self.tmc_ma[A]),
            26 => Slot::Int(&mut self.tmc_hold_pct),
            27 => Slot::Int(&mut self.tmc_micro[R]),
            28 => Slot::Int(&mut self.tmc_micro[A]),
            29 => Slot::Int(&mut self.tmc_ma[Z]),
            30 => Slot::Int(&mut self.tmc_micro[Z]),
            31 => Slot::Flag(&mut self.tmc_stealth),
            32 => Slot::Flag(&mut self.h_axis),
            33 => Slot::Float(&mut self.steps[H]),
            34 => Slot::Float(&mut self.max_rate[H]),
            35 => Slot::Float(&mut self.accel[H]),
            36 => Slot::Float(&mut self.jerk[H]),
            37 => Slot::Float(&mut self.jog_rate[H]),
            38 => Slot::Flag(&mut self.probe_invert),
            39 => Slot::Int(&mut self.tmc_ma[H]),
            40 => Slot::Int(&mut self.tmc_micro[H]),
            41 => Slot::Int(&mut self.probe_ms),
            42 => Slot::Float(&mut self.jerk[Z]),
            43 => Slot::Float(&mut self.z_max),
            44 => Slot::Flag(&mut self.cartesian),
            _ => Slot::Flag(&mut self.spindle),
        }
    }

    /// Direction inversion for the joint axes as the step port numbers
    /// them (bit i = axis i): the radius and table bits as they are, the
    /// focus axis from bit 3 and the cross slide from bit 2, which is how
    /// `dir_invert` numbered them before either was a joint.
    pub fn joint_dir_invert(&self) -> u8 {
        (self.dir_invert & 0b0011) | ((self.dir_invert >> 1) & (1 << H)) | ((self.dir_invert << 1) & (1 << Z))
    }

    /// Every field within its range.
    pub fn is_valid(&self) -> bool {
        let positive = |v: f32| v > 0.0 && v <= FLOAT_MAX;
        let non_negative = |v: f32| (0.0..=FLOAT_MAX).contains(&v);
        let microsteps = |m: u32| matches!(m, 1 | 2 | 4 | 8 | 16 | 32 | 64 | 128 | 256);
        self.steps.iter().all(|&v| positive(v))
            && self.max_rate.iter().all(|&v| positive(v))
            && self.accel.iter().all(|&v| positive(v))
            && self.jerk.iter().all(|&v| positive(v))
            && non_negative(self.r_max)
            && non_negative(self.z_max)
            && self.jog_rate.iter().all(|&v| positive(v))
            && self.dir_invert <= 15
            && self.probe_ms <= PROBE_MS_MAX
            && (1..=20).contains(&self.step_us)
            && (100..=100_000).contains(&self.laser_hz)
            && positive(self.s_max)
            && self.s_min >= 0.0
            && self.s_min <= self.s_max
            && (1..=60_000).contains(&self.laser_ms)
            && self.tmc_ma.iter().all(|&ma| ma <= 2000)
            && self.tmc_hold_pct <= 100
            && self.tmc_micro.iter().all(|&m| microsteps(m))
    }

    /// Writes `name=value\n` for one setting; false for an unknown name.
    pub fn format(&self, name: &str, out: &mut impl Sink) -> bool {
        match index_of(name) {
            Some(index) => {
                self.format_index(index, out);
                true
            }
            None => false,
        }
    }

    /// Writes every setting, one per line, in `NAMES` order.
    pub fn format_all(&self, out: &mut impl Sink) {
        for index in 0..NAMES.len() {
            self.format_index(index, out);
        }
    }

    fn format_index(&self, index: usize, out: &mut impl Sink) {
        let mut copy = *self;
        out.write_str(NAMES[index]);
        out.write(b"=");
        match copy.slot(index) {
            Slot::Float(v) => report::float_trimmed(*v, 3, out),
            Slot::Int(v) => report::uint(*v as u64, out),
            Slot::Byte(v) => report::uint(*v as u64, out),
            Slot::Flag(v) => out.write(if *v { b"1" } else { b"0" }),
        }
        out.write(b"\n");
    }

    /// Parses `text` for `name`; ranges are checked (steps and rates
    /// positive, percentages 0..100, microsteps a power of two 1..256).
    /// Nothing changes on an error. Names are matched ignoring case.
    pub fn set(&mut self, name: &str, text: &str) -> Result<Changed, SetError> {
        let index = index_of(name).ok_or(SetError::Unknown)?;
        let mut next = *self;
        match next.slot(index) {
            Slot::Float(v) => *v = number(text).ok_or(SetError::BadValue)?,
            Slot::Int(v) => *v = integer(text).ok_or(SetError::BadValue)?,
            Slot::Byte(v) => {
                let n = integer(text).ok_or(SetError::BadValue)?;
                *v = u8::try_from(n).map_err(|_| SetError::BadValue)?;
            }
            Slot::Flag(v) => *v = flag(text).ok_or(SetError::BadValue)?,
        }
        if !next.is_valid() {
            return Err(SetError::BadValue);
        }
        *self = next;
        Ok(group(index))
    }

    /// Serializes for the store. Layout is private to this module: magic,
    /// version, the fields little-endian (the version 4 fields in their old
    /// order, then the ones added since), zero padding, and a CRC-32 over
    /// all of that in the last four bytes.
    pub fn to_blob(&self, buf: &mut [u8; BLOB_LEN]) {
        buf.fill(0);
        let mut w = Writer { buf: &mut buf[..], at: 0 };
        w.bytes(&MAGIC);
        w.u8(BLOB_VERSION);
        for array in [&self.steps, &self.max_rate, &self.accel, &self.jerk] {
            for i in PREFIX_JOINTS {
                w.f32(array[i]);
            }
        }
        w.f32(self.r_max);
        w.f32(self.steps[Z]);
        w.f32(self.max_rate[Z]);
        w.f32(self.accel[Z]);
        w.f32(self.jog_rate[Z]);
        for i in PREFIX_JOINTS {
            w.f32(self.jog_rate[i]);
        }
        w.u8(self.dir_invert);
        w.flag(self.en_invert);
        w.u32(self.idle_ms);
        w.u32(self.step_us);
        w.u32(self.laser_hz);
        w.f32(self.s_max);
        w.f32(self.s_min);
        w.flag(self.laser_invert);
        w.u32(self.laser_ms);
        for i in PREFIX_JOINTS {
            w.u32(self.tmc_ma[i]);
        }
        w.u32(self.tmc_hold_pct);
        for i in PREFIX_JOINTS {
            w.u32(self.tmc_micro[i]);
        }
        w.u32(self.tmc_ma[Z]);
        w.u32(self.tmc_micro[Z]);
        w.flag(self.tmc_stealth);
        w.flag(self.h_axis);
        w.flag(self.probe_invert);
        w.u32(self.probe_ms);
        debug_assert_eq!(w.at, HEADER_LEN + PREFIX_LEN);
        w.f32(self.jerk[Z]);
        w.f32(self.z_max);
        w.flag(self.cartesian);
        w.flag(self.spindle);
        debug_assert_eq!(w.at, HEADER_LEN + FIELDS_LEN);
        let crc = crc32(&buf[..CRC_OFFSET]);
        buf[CRC_OFFSET..].copy_from_slice(&crc.to_le_bytes());
    }

    /// `None` when the blob is short, or the magic, version or CRC do not
    /// match, or a stored field is out of range. Bytes past `BLOB_LEN`
    /// are ignored. A version 4 blob keeps the defaults of the fields
    /// added after it.
    pub fn from_blob(buf: &[u8]) -> Option<Settings> {
        let buf = buf.get(..BLOB_LEN)?;
        let version = buf[MAGIC.len()];
        if buf[..MAGIC.len()] != MAGIC || !(BLOB_VERSION_PREFIX..=BLOB_VERSION).contains(&version) {
            return None;
        }
        let stored = u32::from_le_bytes(buf[CRC_OFFSET..].try_into().ok()?);
        if crc32(&buf[..CRC_OFFSET]) != stored {
            return None;
        }
        let mut r = Reader { buf, at: HEADER_LEN };
        let mut s = Settings::default();
        for array in [&mut s.steps, &mut s.max_rate, &mut s.accel, &mut s.jerk] {
            for i in PREFIX_JOINTS {
                array[i] = r.f32();
            }
        }
        s.r_max = r.f32();
        s.steps[Z] = r.f32();
        s.max_rate[Z] = r.f32();
        s.accel[Z] = r.f32();
        s.jog_rate[Z] = r.f32();
        for i in PREFIX_JOINTS {
            s.jog_rate[i] = r.f32();
        }
        s.dir_invert = r.u8();
        s.en_invert = r.flag()?;
        s.idle_ms = r.u32();
        s.step_us = r.u32();
        s.laser_hz = r.u32();
        s.s_max = r.f32();
        s.s_min = r.f32();
        s.laser_invert = r.flag()?;
        s.laser_ms = r.u32();
        for i in PREFIX_JOINTS {
            s.tmc_ma[i] = r.u32();
        }
        s.tmc_hold_pct = r.u32();
        for i in PREFIX_JOINTS {
            s.tmc_micro[i] = r.u32();
        }
        s.tmc_ma[Z] = r.u32();
        s.tmc_micro[Z] = r.u32();
        s.tmc_stealth = r.flag()?;
        s.h_axis = r.flag()?;
        s.probe_invert = r.flag()?;
        s.probe_ms = r.u32();
        if version >= 5 {
            s.jerk[Z] = r.f32();
            s.z_max = r.f32();
            s.cartesian = r.flag()?;
            s.spindle = r.flag()?;
        }
        if !s.is_valid() {
            return None;
        }
        Some(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Out(heapless::Vec<u8, 1024>);

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

    fn line(settings: &Settings, name: &str) -> Out {
        let mut out = Out::new();
        assert!(settings.format(name, &mut out), "{name} is unknown");
        out
    }

    const DEFAULT_LISTING: &str = "r_steps=10240\n\
        a_steps=14222.222\n\
        r_rate=560\n\
        a_rate=400\n\
        r_accel=50\n\
        a_accel=50\n\
        r_jerk=3\n\
        a_jerk=2\n\
        r_max=0\n\
        z_steps=10240\n\
        z_rate=560\n\
        z_accel=50\n\
        jog_z=120\n\
        jog_r=300\n\
        jog_a=200\n\
        dir_invert=0\n\
        en_invert=0\n\
        idle_ms=0\n\
        step_us=2\n\
        laser_hz=5000\n\
        s_max=1000\n\
        s_min=0\n\
        laser_invert=0\n\
        laser_ms=5000\n\
        tmc_r_ma=800\n\
        tmc_a_ma=800\n\
        tmc_hold_pct=50\n\
        tmc_r_micro=256\n\
        tmc_a_micro=256\n\
        tmc_z_ma=800\n\
        tmc_z_micro=256\n\
        tmc_stealth=1\n\
        h_axis=0\n\
        h_steps=6400\n\
        h_rate=600\n\
        h_accel=50\n\
        h_jerk=1\n\
        jog_h=120\n\
        probe_invert=0\n\
        tmc_h_ma=600\n\
        tmc_h_micro=256\n\
        probe_ms=20\n\
        z_jerk=3\n\
        z_max=0\n\
        cartesian=0\n\
        spindle=0\n";

    #[test]
    fn defaults_are_valid_and_listed_in_names_order() {
        let settings = Settings::default();
        assert!(settings.is_valid());
        let mut out = Out::new();
        settings.format_all(&mut out);
        assert_eq!(out.as_str(), DEFAULT_LISTING);
        let names: heapless::Vec<&str, 46> = out.as_str().lines().map(|l| l.split('=').next().unwrap()).collect();
        assert_eq!(names.as_slice(), &NAMES[..]);
    }

    #[test]
    fn format_one_and_unknown() {
        let settings = Settings::default();
        assert_eq!(line(&settings, "a_steps").as_str(), "a_steps=14222.222\n");
        assert_eq!(line(&settings, "A_STEPS").as_str(), "a_steps=14222.222\n");
        assert_eq!(line(&settings, "tmc_stealth").as_str(), "tmc_stealth=1\n");
        let mut out = Out::new();
        assert!(!settings.format("nope", &mut out));
        assert!(!settings.format("", &mut out));
        assert_eq!(out.as_str(), "");
    }

    #[test]
    fn every_name_is_settable_with_its_group() {
        // name, value to set, listed value, group
        let table: [(&str, &str, &str, Changed); 46] = [
            ("r_steps", "200.5", "200.5", Changed::Motion),
            ("a_steps", "888.8889", "888.889", Changed::Motion),
            ("r_rate", "1500", "1500", Changed::Motion),
            ("a_rate", "900.25", "900.25", Changed::Motion),
            ("r_accel", "75", "75", Changed::Motion),
            ("a_accel", "0.5", "0.5", Changed::Motion),
            ("r_jerk", "2", "2", Changed::Motion),
            ("a_jerk", "12.125", "12.125", Changed::Motion),
            ("r_max", "60", "60", Changed::Motion),
            ("z_steps", "640", "640", Changed::Motion),
            ("z_rate", "900", "900", Changed::Motion),
            ("z_accel", "25.5", "25.5", Changed::Motion),
            ("jog_z", "60", "60", Changed::Motion),
            ("jog_r", "300", "300", Changed::Motion),
            ("jog_a", "360", "360", Changed::Motion),
            ("dir_invert", "15", "15", Changed::Motion),
            ("en_invert", "1", "1", Changed::Motion),
            ("idle_ms", "30000", "30000", Changed::Motion),
            ("step_us", "5", "5", Changed::Motion),
            ("laser_hz", "20000", "20000", Changed::Laser),
            ("s_max", "255", "255", Changed::Laser),
            ("s_min", "10", "10", Changed::Laser),
            ("laser_invert", "1", "1", Changed::Laser),
            ("laser_ms", "60000", "60000", Changed::Laser),
            ("tmc_r_ma", "0", "0", Changed::Driver),
            ("tmc_a_ma", "2000", "2000", Changed::Driver),
            ("tmc_hold_pct", "100", "100", Changed::Driver),
            ("tmc_r_micro", "256", "256", Changed::Driver),
            ("tmc_a_micro", "1", "1", Changed::Driver),
            ("tmc_z_ma", "600", "600", Changed::Driver),
            ("tmc_z_micro", "16", "16", Changed::Driver),
            ("tmc_stealth", "0", "0", Changed::Driver),
            ("h_axis", "1", "1", Changed::Driver),
            ("h_steps", "1600", "1600", Changed::Motion),
            ("h_rate", "300", "300", Changed::Motion),
            ("h_accel", "20", "20", Changed::Motion),
            ("h_jerk", "0.5", "0.5", Changed::Motion),
            ("jog_h", "30", "30", Changed::Motion),
            ("probe_invert", "1", "1", Changed::Motion),
            ("tmc_h_ma", "400", "400", Changed::Driver),
            ("tmc_h_micro", "16", "16", Changed::Driver),
            ("probe_ms", "0", "0", Changed::Motion),
            ("z_jerk", "1.5", "1.5", Changed::Motion),
            ("z_max", "8", "8", Changed::Motion),
            ("cartesian", "1", "1", Changed::Kinematics),
            ("spindle", "1", "1", Changed::Tool),
        ];
        let mut settings = Settings::default();
        for (i, (name, value, shown, group)) in table.iter().enumerate() {
            assert_eq!(*name, NAMES[i]);
            assert_eq!(settings.set(name, value), Ok(*group), "{name}");
            let mut want = heapless::String::<48>::new();
            want.push_str(name).unwrap();
            want.push_str("=").unwrap();
            want.push_str(shown).unwrap();
            want.push_str("\n").unwrap();
            assert_eq!(line(&settings, name).as_str(), want.as_str());
        }
        assert!(settings.is_valid());
        assert_eq!(settings.steps, [200.5, 888.8889, 1600.0, 640.0]);
        assert_eq!(settings.dir_invert, 15);
        assert!(settings.en_invert);
        assert_eq!(settings.tmc_micro, [256, 1, 16, 16]);
        assert_eq!(settings.jog_rate[Z], 60.0);
        assert_eq!(settings.max_rate[Z], 900.0);
        assert_eq!(settings.accel[Z], 25.5);
        assert_eq!(settings.jerk[Z], 1.5);
        assert_eq!(settings.tmc_ma[Z], 600);
        assert_eq!(settings.z_max, 8.0);
        assert!(settings.cartesian && settings.spindle);
        assert!(!settings.tmc_stealth);
    }

    #[test]
    fn names_are_case_insensitive_on_set() {
        let mut settings = Settings::default();
        assert_eq!(settings.set("R_MAX", "12.5"), Ok(Changed::Motion));
        assert_eq!(settings.set("Laser_Hz", "1000"), Ok(Changed::Laser));
        assert_eq!(settings.set("TMC_STEALTH", "0"), Ok(Changed::Driver));
        assert_eq!(settings.r_max, 12.5);
        assert_eq!(settings.laser_hz, 1000);
        assert!(!settings.tmc_stealth);
    }

    #[test]
    fn unknown_names_are_rejected() {
        let mut settings = Settings::default();
        assert_eq!(settings.set("r_stepz", "1"), Err(SetError::Unknown));
        assert_eq!(settings.set("", "1"), Err(SetError::Unknown));
        assert_eq!(settings.set("r_steps ", "1"), Err(SetError::Unknown));
        assert_eq!(settings, Settings::default());
    }

    fn rejects(name: &str, value: &str) {
        let mut settings = Settings::default();
        let before = settings;
        assert_eq!(settings.set(name, value), Err(SetError::BadValue), "{name}={value}");
        assert_eq!(settings, before, "{name}={value} changed something");
    }

    fn accepts(name: &str, value: &str) {
        let mut settings = Settings::default();
        assert!(settings.set(name, value).is_ok(), "{name}={value}");
    }

    #[test]
    fn bad_numbers_are_rejected() {
        rejects("r_steps", "");
        rejects("r_steps", "abc");
        rejects("r_steps", "1e3");
        rejects("r_steps", "1.2.3");
        rejects("r_steps", "12 ");
        rejects("r_steps", "nan");
        rejects("r_steps", "inf");
        rejects("laser_hz", "5000.0");
        rejects("laser_hz", "-5000");
        rejects("laser_hz", "+5000");
        rejects("idle_ms", "4294967296");
        rejects("idle_ms", "x");
        rejects("dir_invert", "256");
        rejects("en_invert", "2");
        rejects("en_invert", "true");
        rejects("en_invert", "");
    }

    #[test]
    fn ranges_are_enforced() {
        for name in [
            "r_steps", "a_steps", "r_rate", "a_rate", "r_accel", "a_accel", "r_jerk", "a_jerk",
            "z_steps", "z_rate", "z_accel", "z_jerk", "jog_z", "jog_r", "jog_a", "s_max",
        ] {
            rejects(name, "0");
            rejects(name, "-1");
            rejects(name, "10000001");
            accepts(name, "0.001");
            accepts(name, "10000000");
        }
        rejects("r_max", "-0.5");
        accepts("r_max", "0");
        accepts("r_max", "0.0");
        rejects("z_max", "-1");
        accepts("z_max", "0");
        rejects("cartesian", "2");
        rejects("spindle", "0.5");
        rejects("dir_invert", "16");
        rejects("h_steps", "0");
        rejects("h_axis", "2");
        rejects("tmc_h_micro", "3");
        rejects("probe_ms", "161");
        rejects("probe_ms", "-10");
        accepts("probe_ms", "160");
        accepts("probe_ms", "15");
        accepts("dir_invert", "0");
        accepts("dir_invert", "7");
        accepts("idle_ms", "0");
        accepts("idle_ms", "4294967295");
        rejects("step_us", "0");
        rejects("step_us", "21");
        accepts("step_us", "1");
        accepts("step_us", "20");
        rejects("laser_hz", "99");
        rejects("laser_hz", "100001");
        accepts("laser_hz", "100");
        accepts("laser_hz", "100000");
        rejects("s_min", "-1");
        rejects("s_min", "1000.5");
        accepts("s_min", "0");
        accepts("s_min", "1000");
        rejects("laser_ms", "0");
        rejects("laser_ms", "60001");
        accepts("laser_ms", "1");
        for name in ["tmc_r_ma", "tmc_a_ma", "tmc_z_ma"] {
            rejects(name, "2001");
            accepts(name, "0");
            accepts(name, "2000");
        }
        rejects("tmc_hold_pct", "101");
        accepts("tmc_hold_pct", "0");
        for name in ["tmc_r_micro", "tmc_a_micro", "tmc_z_micro"] {
            for bad in ["0", "3", "12", "512", "255"] {
                rejects(name, bad);
            }
            for good in ["1", "2", "4", "8", "16", "32", "64", "128", "256"] {
                accepts(name, good);
            }
        }
        rejects("tmc_stealth", "2");
        rejects("laser_invert", "-1");
    }

    #[test]
    fn s_min_and_s_max_keep_their_order() {
        let mut settings = Settings::default();
        assert_eq!(settings.set("s_min", "600"), Ok(Changed::Laser));
        assert_eq!(settings.set("s_max", "500"), Err(SetError::BadValue));
        assert_eq!(settings.s_max, 1000.0);
        assert_eq!(settings.set("s_max", "600"), Ok(Changed::Laser));
        assert_eq!(settings.set("s_min", "600.001"), Err(SetError::BadValue));
    }

    #[test]
    fn crc32_check_value() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        assert_eq!(crc32(b""), 0);
    }

    #[test]
    fn blob_round_trip() {
        let mut settings = Settings::default();
        settings.set("a_steps", "888.8889").unwrap();
        settings.set("r_max", "55.5").unwrap();
        settings.set("z_steps", "1280").unwrap();
        settings.set("z_rate", "240").unwrap();
        settings.set("z_accel", "12.5").unwrap();
        settings.set("jog_z", "90").unwrap();
        settings.set("tmc_z_ma", "450").unwrap();
        settings.set("tmc_z_micro", "64").unwrap();
        settings.set("dir_invert", "6").unwrap();
        settings.set("en_invert", "1").unwrap();
        settings.set("idle_ms", "120000").unwrap();
        settings.set("laser_hz", "20000").unwrap();
        settings.set("s_min", "25").unwrap();
        settings.set("laser_invert", "1").unwrap();
        settings.set("tmc_a_ma", "1200").unwrap();
        settings.set("tmc_r_micro", "32").unwrap();
        settings.set("tmc_stealth", "0").unwrap();
        settings.set("z_jerk", "0.75").unwrap();
        settings.set("z_max", "12").unwrap();
        settings.set("cartesian", "1").unwrap();
        settings.set("spindle", "1").unwrap();

        let mut blob = [0xAAu8; BLOB_LEN];
        settings.to_blob(&mut blob);
        assert_eq!(&blob[..4], b"SPNY");
        assert_eq!(blob[4], BLOB_VERSION);
        assert!(blob[HEADER_LEN + FIELDS_LEN..CRC_OFFSET].iter().all(|&b| b == 0));
        assert_eq!(Settings::from_blob(&blob), Some(settings));

        let defaults = Settings::default();
        let mut blob = [0u8; BLOB_LEN];
        defaults.to_blob(&mut blob);
        assert_eq!(Settings::from_blob(&blob), Some(defaults));

        let mut longer = [0x55u8; BLOB_LEN + 16];
        longer[..BLOB_LEN].copy_from_slice(&blob);
        assert_eq!(Settings::from_blob(&longer), Some(defaults));
    }

    #[test]
    fn blob_stores_fields_little_endian() {
        let settings = Settings::default();
        let mut blob = [0u8; BLOB_LEN];
        settings.to_blob(&mut blob);
        let r_steps = f32::from_le_bytes(blob[HEADER_LEN..HEADER_LEN + 4].try_into().unwrap());
        assert_eq!(r_steps, 10240.0);
        let crc = u32::from_le_bytes(blob[CRC_OFFSET..].try_into().unwrap());
        assert_eq!(crc, crc32(&blob[..CRC_OFFSET]));
    }

    #[test]
    fn corrupted_blobs_are_rejected() {
        let settings = Settings::default();
        let mut good = [0u8; BLOB_LEN];
        settings.to_blob(&mut good);

        let mut bad = good;
        bad[HEADER_LEN + 2] ^= 0x01;
        assert_eq!(Settings::from_blob(&bad), None);

        let mut bad = good;
        bad[CRC_OFFSET] ^= 0xFF;
        assert_eq!(Settings::from_blob(&bad), None);

        let mut bad = good;
        bad[CRC_OFFSET - 1] = 1;
        assert_eq!(Settings::from_blob(&bad), None);

        let mut bad = good;
        bad[0] = b'X';
        assert_eq!(Settings::from_blob(&bad), None);

        let mut bad = good;
        bad[4] = BLOB_VERSION + 1;
        assert_eq!(Settings::from_blob(&bad), None);

        assert_eq!(Settings::from_blob(&good[..BLOB_LEN - 1]), None);
        assert_eq!(Settings::from_blob(&[]), None);
        assert_eq!(Settings::from_blob(&[0xFF; BLOB_LEN]), None);
    }

    #[test]
    fn blob_with_out_of_range_field_is_rejected() {
        let mut settings = Settings::default();
        settings.steps[R] = 0.0;
        let mut blob = [0u8; BLOB_LEN];
        settings.to_blob(&mut blob);
        assert_eq!(Settings::from_blob(&blob), None);

        let mut settings = Settings::default();
        settings.tmc_micro[A] = 3;
        settings.to_blob(&mut blob);
        assert_eq!(Settings::from_blob(&blob), None);

        // A flag byte that is neither 0 nor 1, behind a matching CRC.
        let mut blob = [0u8; BLOB_LEN];
        Settings::default().to_blob(&mut blob);
        let en_invert_at = HEADER_LEN + 4 * (4 * 3 + 1 + 4 + 3) + 1;
        blob[en_invert_at] = 2;
        let crc = crc32(&blob[..CRC_OFFSET]);
        blob[CRC_OFFSET..].copy_from_slice(&crc.to_le_bytes());
        assert_eq!(Settings::from_blob(&blob), None);
    }

    #[test]
    fn a_blob_from_an_older_layout_is_not_read_as_this_one() {
        // Version 1 had no cross slide fields, so every field after the
        // radius limit sat four words earlier. Read as this layout it
        // would pass its CRC and hand back rates and currents that were
        // never stored.
        let mut blob = [0u8; BLOB_LEN];
        Settings::default().to_blob(&mut blob);
        blob[MAGIC.len()] = 1;
        let crc = crc32(&blob[..CRC_OFFSET]);
        blob[CRC_OFFSET..].copy_from_slice(&crc.to_le_bytes());
        assert_eq!(Settings::from_blob(&blob), None);
    }

    #[test]
    fn a_version_4_blob_is_read_with_the_new_fields_at_their_defaults() {
        // Version 4 is this layout without the fields appended since.
        let mut stored = Settings::default();
        stored.set("z_steps", "1280").unwrap();
        stored.set("tmc_z_micro", "64").unwrap();
        stored.set("probe_ms", "40").unwrap();
        stored.set("z_jerk", "0.5").unwrap();
        stored.set("cartesian", "1").unwrap();
        let mut blob = [0u8; BLOB_LEN];
        stored.to_blob(&mut blob);
        blob[MAGIC.len()] = 4;
        blob[HEADER_LEN + PREFIX_LEN..CRC_OFFSET].fill(0);
        let crc = crc32(&blob[..CRC_OFFSET]);
        blob[CRC_OFFSET..].copy_from_slice(&crc.to_le_bytes());
        let read = Settings::from_blob(&blob).expect("a version 4 blob is read");
        assert_eq!(read.steps[Z], 1280.0);
        assert_eq!(read.tmc_micro[Z], 64);
        assert_eq!(read.probe_ms, 40);
        assert_eq!(read.jerk[Z], Settings::default().jerk[Z]);
        assert!(!read.cartesian && !read.spindle);
        assert_eq!(read.z_max, 0.0);
    }

    #[test]
    fn the_cross_slide_fields_fit_the_blob() {
        assert!(HEADER_LEN + FIELDS_LEN <= CRC_OFFSET, "{FIELDS_LEN} bytes of fields");
        let mut blob = [0u8; BLOB_LEN];
        Settings::default().to_blob(&mut blob);
        // Every field lands where the writer says it does: the stealth
        // flag, the focus axis and probe flags, then the probe queue time,
        // at the end of the version 4 fields.
        let end = HEADER_LEN + PREFIX_LEN;
        assert_eq!(blob[end - 7], 1);
        assert_eq!(blob[end - 6..end - 4], [0, 0]);
        assert_eq!(blob[end - 4..end], 20u32.to_le_bytes());
        let focus = Settings { h_axis: true, probe_invert: true, probe_ms: 160, ..Settings::default() };
        focus.to_blob(&mut blob);
        assert_eq!(blob[end - 6..end - 4], [1, 1]);
        assert_eq!(blob[end - 4..end], 160u32.to_le_bytes());
        assert_eq!(Settings::from_blob(&blob), Some(focus));
        // Then the cross slide's jerk and limit and the two mode flags,
        // just before the padding.
        let modes = Settings { z_max: 9.5, cartesian: true, spindle: true, ..Settings::default() };
        modes.to_blob(&mut blob);
        let tail = HEADER_LEN + FIELDS_LEN;
        assert_eq!(blob[end..end + 4], 3.0f32.to_le_bytes());
        assert_eq!(blob[end + 4..end + 8], 9.5f32.to_le_bytes());
        assert_eq!(blob[tail - 2..tail], [1, 1]);
        assert!(blob[tail..CRC_OFFSET].iter().all(|&b| b == 0));
    }

    #[test]
    fn the_focus_axis_and_cross_slide_bits_trade_places() {
        let mut settings = Settings::default();
        settings.dir_invert = 0b0100;
        assert_eq!(settings.joint_dir_invert(), 1 << Z, "bit 2 is the cross slide");
        settings.dir_invert = 0b1011;
        assert_eq!(settings.joint_dir_invert(), 0b0111);
        settings.dir_invert = 0b1000;
        assert_eq!(settings.joint_dir_invert(), 1 << H);
        settings.dir_invert = 0b1111;
        assert_eq!(settings.joint_dir_invert(), 0b1111);
    }
}
