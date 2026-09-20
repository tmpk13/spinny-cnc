//! Lookahead planner over joint-space lines, in the style of grbl.
//!
//! Every move becomes a block with a step count per axis and a trapezoid
//! speed profile along the block. The planning metric is the plain
//! Euclidean length of the joint delta with mm and degrees counted alike;
//! it is only a parameter along the line, and the per-axis limits
//! (`max_rate`, `accel`, `jerk`) are what bound the physical motion, each
//! projected through the block's direction cosines. Junction speeds come
//! from the per-axis jerk limits: the speed change at a corner projected on
//! each axis must stay within that axis's allowance. A backward then forward
//! pass keeps entry and exit speeds reachable.

use crate::settings::Settings;
use crate::AXES;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MoveKind {
    /// Laser off, max rates.
    Rapid,
    /// Laser per the block's power and the machine's power mode.
    Cut,
    /// Laser off, cancelable.
    Jog,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Feed {
    /// Each axis at its max rate; the slower axis paces the move.
    Max,
    /// Board surface speed in mm/min (see `math::surface_length`).
    Surface(f32),
    /// The settings' jog rates, the slower axis pacing.
    Jog,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Block {
    /// Absolute step counts per axis and the direction (bit i = axis i forward).
    pub steps: [u32; AXES],
    pub dir_forward: u8,
    /// Largest per-axis step count: the Bresenham event count.
    pub step_event_count: u32,
    /// Length in the planning metric.
    pub length: f32,
    /// Direction cosines in the planning metric.
    pub unit: [f32; AXES],
    /// Speeds are metric units per second, squared where named so.
    pub entry_speed_sqr: f32,
    pub max_entry_speed_sqr: f32,
    /// After the axis limits.
    pub nominal_speed: f32,
    /// What the feed asked for before the axis limits; power scales by
    /// achieved over requested speed.
    pub requested_speed: f32,
    /// Along the block, metric units per second squared.
    pub acceleration: f32,
    pub kind: MoveKind,
    /// S value for a cut.
    pub power: f32,
    /// Board mm per second along this block at nominal speed, for reports.
    pub surface_rate: f32,
    /// Board length of the block, mm.
    pub surface_mm: f32,
    pub recalculate: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlanError {
    Full,
}

/// Ring of blocks plus the planned end position in steps.
pub struct Planner {
    _private: (),
}

impl Default for Planner {
    fn default() -> Self {
        Self::new()
    }
}

impl Planner {
    pub fn new() -> Self {
        unimplemented!("planner::new")
    }

    pub fn free(&self) -> usize {
        unimplemented!("planner::free")
    }

    pub fn is_empty(&self) -> bool {
        unimplemented!("planner::is_empty")
    }

    /// Queues a line to `target` (mm, deg). Returns `Ok(false)` when the
    /// target rounds to the current position and nothing was queued.
    pub fn push(
        &mut self,
        target: [f32; AXES],
        kind: MoveKind,
        feed: Feed,
        power: f32,
        settings: &Settings,
    ) -> Result<bool, PlanError> {
        let _ = (target, kind, feed, power, settings);
        unimplemented!("planner::push")
    }

    /// The block the stepper should execute next.
    pub fn current(&self) -> Option<&Block> {
        unimplemented!("planner::current")
    }

    pub fn current_mut(&mut self) -> Option<&mut Block> {
        unimplemented!("planner::current_mut")
    }

    /// Drops the current block once the stepper has consumed it.
    pub fn discard_current(&mut self) {
        unimplemented!("planner::discard_current")
    }

    /// Planned end position in steps.
    pub fn position(&self) -> [i32; AXES] {
        unimplemented!("planner::position")
    }

    /// Planned end position in units, from the step position.
    pub fn position_units(&self, settings: &Settings) -> [f32; AXES] {
        let _ = settings;
        unimplemented!("planner::position_units")
    }

    /// Sets the planned position; only meaningful when the ring is empty.
    pub fn set_position(&mut self, steps: [i32; AXES]) {
        let _ = steps;
        unimplemented!("planner::set_position")
    }

    /// Drops every block; the position is left for the caller to sync.
    pub fn clear(&mut self) {
        unimplemented!("planner::clear")
    }

    /// After a hold: the current block starts again from a stop, so the
    /// profile of everything queued is recomputed from zero entry speed.
    pub fn reinitialize(&mut self) {
        unimplemented!("planner::reinitialize")
    }

    /// The stepper stopped part way through the current block with
    /// `remaining` events left: shorten it so the plan starts there.
    pub fn shorten_current(&mut self, remaining: u32) {
        let _ = remaining;
        unimplemented!("planner::shorten_current")
    }

    /// Any block queued is a jog.
    pub fn has_jog(&self) -> bool {
        unimplemented!("planner::has_jog")
    }
}
