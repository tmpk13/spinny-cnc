//! Step generation, split in two halves that share a lock-free ring.
//!
//! `Front` runs in the main loop: `prep` walks the planner's blocks and
//! writes timed segments (about `SEGMENT_MS` each) with a constant step
//! rate and the laser duty for that slice, following the block's
//! acceleration profile, a requested hold, or a jog cancel.
//!
//! `Isr` runs from the step timer: each `tick` advances the Bresenham
//! counters of the segment in progress, pulses the pins, applies the laser
//! duty at a segment start, and returns the delay to the next tick. Ticks
//! are subdivided below the step rate when steps are sparse (as grbl's
//! AMASS does) so the minor axis is spread evenly, and never closer than
//! `MIN_TICK_US`.
//!
//! The ring holds `Segment`s; the per-block Bresenham data lives in a small
//! ring of `StepBlock`s that a segment refers to by index. The executed
//! position is published in atomics so the main loop can report it and
//! resync the planner after an abort.

use core::sync::atomic::{AtomicBool, AtomicI32};

use crate::hal::{LaserPort, StepPort};
use crate::parser::PowerMode;
use crate::planner::Planner;
use crate::settings::Settings;
use crate::{AXES, SEGMENTS};

/// Block ring size on the stepper side.
pub const STEP_BLOCKS: usize = 4;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct StepBlock {
    pub steps: [u32; AXES],
    pub event_count: u32,
    /// Pin levels for the direction pins, polarity applied.
    pub dir_levels: u8,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Segment {
    /// Ticks in this segment.
    pub ticks: u16,
    /// Microseconds between ticks.
    pub period_us: u32,
    /// Tick subdivision: `1 << amass` ticks per step event.
    pub amass: u8,
    /// Index into the step block ring.
    pub block: u8,
    /// Laser high time, permille, for the whole segment.
    pub duty: u16,
    /// Metric speed of the segment, for the rate report.
    pub speed: f32,
}

/// Memory shared by both halves. Lives in a static in the firmware.
pub struct Shared {
    pub(crate) ring: heapless::spsc::Queue<Segment, SEGMENTS>,
    pub(crate) blocks: [StepBlock; STEP_BLOCKS],
    /// Executed position in steps.
    pub position: [AtomicI32; AXES],
    /// The interrupt has nothing queued and is not armed.
    pub idle: AtomicBool,
    /// Stop stepping at once, discarding the segment in progress.
    pub abort: AtomicBool,
}

impl Shared {
    pub const fn new() -> Self {
        Shared {
            ring: heapless::spsc::Queue::new(),
            blocks: [StepBlock { steps: [0; AXES], event_count: 0, dir_levels: 0 }; STEP_BLOCKS],
            position: [AtomicI32::new(0), AtomicI32::new(0)],
            idle: AtomicBool::new(true),
            abort: AtomicBool::new(false),
        }
    }
}

impl Default for Shared {
    fn default() -> Self {
        Self::new()
    }
}

/// Main-loop half.
pub struct Front<'a> {
    _shared: &'a Shared,
}

/// Interrupt half.
pub struct Isr<'a> {
    _shared: &'a Shared,
}

/// Splits the shared memory into the two halves. Called once.
pub fn split(shared: &'static mut Shared) -> (Front<'static>, Isr<'static>) {
    let _ = shared;
    unimplemented!("stepper::split")
}

/// What `prep` did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Prep {
    /// The ring was empty and idle before this call and has segments now:
    /// the caller must start the step timer (pend the interrupt).
    pub kick: bool,
}

impl<'a> Front<'a> {
    /// Fills the segment ring from the planner. `mode` sets how a cut's
    /// power follows the speed. Safe to call often; it returns quickly when
    /// the ring is full or the planner is empty.
    pub fn prep(&mut self, planner: &mut Planner, settings: &Settings, mode: PowerMode) -> Prep {
        let _ = (planner, settings, mode);
        unimplemented!("stepper::Front::prep")
    }

    /// Decelerate to a stop at the block's acceleration; further `prep`
    /// calls produce the ramp and then nothing.
    pub fn request_hold(&mut self) {
        unimplemented!("stepper::Front::request_hold")
    }

    /// A requested hold or cancel has come to a complete stop and the ring
    /// has drained.
    pub fn is_stopped(&self) -> bool {
        unimplemented!("stepper::Front::is_stopped")
    }

    /// After a hold: shorten the planner's current block to what is left,
    /// let the planner replan from zero, and continue on the next `prep`.
    pub fn resume(&mut self, planner: &mut Planner) {
        let _ = planner;
        unimplemented!("stepper::Front::resume")
    }

    /// Stop at once: sets the abort flag for the interrupt, drops every
    /// segment, and syncs the planner position to the executed position.
    /// The planner's blocks are cleared by the caller.
    pub fn abort(&mut self, planner: &mut Planner) {
        let _ = planner;
        unimplemented!("stepper::Front::abort")
    }

    /// After a hold has stopped: discard what was queued (a jog cancel) and
    /// sync the planner position to the executed position.
    pub fn flush(&mut self, planner: &mut Planner) {
        let _ = planner;
        unimplemented!("stepper::Front::flush")
    }

    /// Executed position in steps.
    pub fn position(&self) -> [i32; AXES] {
        unimplemented!("stepper::Front::position")
    }

    /// Segments queued or a segment in progress.
    pub fn busy(&self) -> bool {
        unimplemented!("stepper::Front::busy")
    }

    /// Board speed of the segment in progress, mm/min.
    pub fn surface_rate(&self) -> f32 {
        unimplemented!("stepper::Front::surface_rate")
    }

    /// Laser duty of the segment in progress, permille.
    pub fn duty(&self) -> u16 {
        unimplemented!("stepper::Front::duty")
    }
}

impl<'a> Isr<'a> {
    /// One timer tick. Returns the microseconds until the next tick, or
    /// `None` when the ring is empty: the timer stops and `Shared::idle`
    /// is set, and the next `Prep::kick` restarts it.
    pub fn tick(&mut self, port: &mut impl StepPort, laser: &mut impl LaserPort) -> Option<u32> {
        let _ = (port, laser);
        unimplemented!("stepper::Isr::tick")
    }
}
