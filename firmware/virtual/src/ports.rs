//! The hardware the simulation offers the control core: steppers that only
//! count, a laser that only remembers its duty, a settings store in a file,
//! and a sink that collects bytes for the socket.

use std::fs;
use std::path::PathBuf;

use spinny_core::hal::{LaserPort, Sink, SlidePort, StepPort, Store};
use spinny_core::AXES;

/// Step and direction pins as counters. The position the machine reports
/// comes from the stepper's own step accounting, so this only records what
/// the pins did: pulses per axis, the last direction levels and the enable
/// level. Direction levels carry `dir_invert`, which exists to match a
/// motor that is wired backwards, so they say nothing about which way a
/// simulated axis moved.
#[derive(Default)]
pub struct Steppers {
    pub pulses: [u64; AXES],
    /// Direction pin levels, bit per axis.
    pub dir_levels: u8,
    /// Enable pin level, `None` until it is first driven.
    pub enable_level: Option<bool>,
    /// Probe input level, set by the simulation from the board surface
    /// before each poll and tick.
    pub probe_level: bool,
}

impl StepPort for Steppers {
    fn set_dir(&mut self, levels: u8) {
        self.dir_levels = levels;
    }

    fn step(&mut self, mask: u8) {
        for axis in 0..AXES {
            if mask & (1 << axis) != 0 {
                self.pulses[axis] += 1;
            }
        }
    }

    fn set_enable(&mut self, high: bool) {
        self.enable_level = Some(high);
    }

    fn probe(&mut self) -> bool {
        self.probe_level
    }
}

/// The cross slide's step and direction pins as counters. Its motor
/// enable is the one the `Steppers` port drives, as on the board.
#[derive(Default)]
pub struct Slide {
    pub pulses: u64,
    /// Direction pin level, `None` until it is first driven.
    pub dir_level: Option<bool>,
}

impl SlidePort for Slide {
    fn set_dir(&mut self, high: bool) {
        self.dir_level = Some(high);
    }

    fn step(&mut self) {
        self.pulses += 1;
    }
}

/// The laser output as a duty in permille.
#[derive(Default)]
pub struct Laser {
    pub duty: u16,
    pub hz: u32,
    pub changes: u64,
}

impl LaserPort for Laser {
    fn set_duty(&mut self, permille: u16) {
        if self.duty != permille {
            self.duty = permille;
            self.changes += 1;
        }
    }

    fn set_frequency(&mut self, hz: u32) {
        self.hz = hz;
    }
}

/// Settings in a file, standing in for the flash sector. Without a path
/// nothing is stored and `$load` finds nothing.
#[derive(Default)]
pub struct FileStore {
    pub path: Option<PathBuf>,
}

impl Store for FileStore {
    fn load(&mut self, buf: &mut [u8]) -> Option<usize> {
        let blob = fs::read(self.path.as_ref()?).ok()?;
        let n = blob.len().min(buf.len());
        buf[..n].copy_from_slice(&blob[..n]);
        Some(n)
    }

    fn save(&mut self, blob: &[u8]) -> bool {
        match self.path.as_ref() {
            Some(path) => fs::write(path, blob).is_ok(),
            None => false,
        }
    }
}

/// Collects what the machine writes until the loop hands it to the socket.
#[derive(Default)]
pub struct OutBuf {
    pub bytes: Vec<u8>,
}

impl Sink for OutBuf {
    fn write(&mut self, bytes: &[u8]) {
        self.bytes.extend_from_slice(bytes);
    }
}

impl OutBuf {
    pub fn take(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.bytes)
    }
}
