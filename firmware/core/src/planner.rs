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
//!
//! The current block (the ring's tail) belongs to the stepper while it is
//! being sliced into segments: its entry speed and `progress` are the
//! stepper's actual state, written back through `current_mut`, and the
//! passes never change its entry speed. Its exit speed (the next block's
//! entry) may still rise when a block is appended; the stepper reads it
//! again for every segment.

use crate::math;
use crate::settings::Settings;
use crate::{AXES, BLOCKS, MAX_EVENT_RATE_HZ, SURFACE_EPSILON_MM};

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
    /// S value for a cut; zero for a turn on the axis.
    pub power: f32,
    /// Board mm per second along this block at nominal speed, for reports.
    pub surface_rate: f32,
    /// Board length of the block, mm.
    pub surface_mm: f32,
    pub recalculate: bool,
    /// Metric length the stepper has already sliced off the current block;
    /// with `entry_speed_sqr` this is the state the plan continues from.
    pub progress: f32,
}

impl Block {
    const EMPTY: Block = Block {
        steps: [0; AXES],
        dir_forward: 0,
        step_event_count: 0,
        length: 0.0,
        unit: [0.0; AXES],
        entry_speed_sqr: 0.0,
        max_entry_speed_sqr: 0.0,
        nominal_speed: 0.0,
        requested_speed: 0.0,
        acceleration: 0.0,
        kind: MoveKind::Rapid,
        power: 0.0,
        surface_rate: 0.0,
        surface_mm: 0.0,
        recalculate: false,
        progress: 0.0,
    };

    /// Speed squared reachable at the end of the block from its entry
    /// state at full acceleration.
    fn reachable_exit_sqr(&self) -> f32 {
        self.entry_speed_sqr + 2.0 * self.acceleration * (self.length - self.progress).max(0.0)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlanError {
    Full,
}

/// Ring of blocks plus the planned end position in steps.
pub struct Planner {
    blocks: [Block; BLOCKS],
    /// Ring index of the current block.
    tail: usize,
    /// Queued blocks, counted from `tail`.
    count: usize,
    position: [i32; AXES],
}

impl Default for Planner {
    fn default() -> Self {
        Self::new()
    }
}

/// Speed along a block with direction cosines `unit` at which the first
/// axis reaches its rate in `rates` (units per minute).
/// Rate limit per axis: the setting, or the fastest the step generator can
/// pulse that many steps per unit, whichever is lower. At 256 microsteps
/// on a 5 mm screw the second one binds well below the first.
pub fn effective_max_rate(settings: &Settings) -> [f32; AXES] {
    let mut rates = settings.max_rate;
    for i in 0..AXES {
        if settings.steps[i] > 0.0 {
            rates[i] = rates[i].min(MAX_EVENT_RATE_HZ * 60.0 / settings.steps[i]);
        }
    }
    rates
}

/// The same ceiling for the jog rates.
fn effective_jog_rate(settings: &Settings) -> [f32; AXES] {
    let mut rates = settings.jog_rate;
    for i in 0..AXES {
        if settings.steps[i] > 0.0 {
            rates[i] = rates[i].min(MAX_EVENT_RATE_HZ * 60.0 / settings.steps[i]);
        }
    }
    rates
}

fn paced_speed(unit: &[f32; AXES], rates: &[f32; AXES]) -> f32 {
    let mut speed = f32::INFINITY;
    for i in 0..AXES {
        let u = unit[i].abs();
        if u > 0.0 {
            speed = speed.min(rates[i] / 60.0 / u);
        }
    }
    speed
}

impl Planner {
    pub fn new() -> Self {
        Planner { blocks: [Block::EMPTY; BLOCKS], tail: 0, count: 0, position: [0; AXES] }
    }

    pub fn free(&self) -> usize {
        BLOCKS - self.count
    }

    pub fn is_empty(&self) -> bool {
        self.count == 0
    }

    /// Queued blocks.
    pub fn len(&self) -> usize {
        self.count
    }

    fn index(&self, nth: usize) -> usize {
        (self.tail + nth) % BLOCKS
    }

    /// The `nth` queued block; 0 is the current one.
    pub fn nth(&self, nth: usize) -> Option<&Block> {
        if nth < self.count {
            Some(&self.blocks[self.index(nth)])
        } else {
            None
        }
    }

    /// Speed squared the current block must end at: the next block's entry
    /// speed, or zero when nothing follows.
    pub fn current_exit_speed_sqr(&self) -> f32 {
        self.nth(1).map_or(0.0, |next| next.entry_speed_sqr)
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
        let mut target_steps = [0i32; AXES];
        let mut steps = [0u32; AXES];
        let mut dir_forward = 0u8;
        let mut delta_units = [0f32; AXES];
        let mut event_count = 0u32;
        for i in 0..AXES {
            target_steps[i] = math::units_to_steps(target[i], settings.steps[i]);
            let delta = target_steps[i].wrapping_sub(self.position[i]);
            steps[i] = delta.unsigned_abs();
            if delta > 0 {
                dir_forward |= 1 << i;
            }
            delta_units[i] = delta as f32 / settings.steps[i];
            event_count = event_count.max(steps[i]);
        }
        if event_count == 0 {
            return Ok(false);
        }
        if self.count == BLOCKS {
            return Err(PlanError::Full);
        }

        let length = math::hypot(delta_units[0], delta_units[1]);
        let mut unit = [0f32; AXES];
        for i in 0..AXES {
            unit[i] = delta_units[i] / length;
        }
        let axis_limit = paced_speed(&unit, &effective_max_rate(settings));
        let start = self.position_units(settings);
        let mut end = [0f32; AXES];
        for i in 0..AXES {
            end[i] = math::steps_to_units(target_steps[i], settings.steps[i]);
        }
        let surface_mm = math::surface_length(start[0], start[1], end[0], end[1]);
        let requested_speed = match feed {
            Feed::Max => axis_limit,
            Feed::Jog => paced_speed(&unit, &effective_jog_rate(settings)),
            Feed::Surface(mm_per_min) => {
                if surface_mm < SURFACE_EPSILON_MM || mm_per_min.is_nan() || mm_per_min <= 0.0 {
                    axis_limit
                } else {
                    length * (mm_per_min / 60.0) / surface_mm
                }
            }
        };
        let nominal_speed = requested_speed.min(axis_limit);
        let mut acceleration = f32::INFINITY;
        for i in 0..AXES {
            let u = unit[i].abs();
            if u > 0.0 {
                acceleration = acceleration.min(settings.accel[i] / u);
            }
        }

        // Junction with the block before this one: the speed change a corner
        // asks of each axis stays within that axis's jerk allowance.
        let max_entry_speed = match self.nth(self.count.wrapping_sub(1)) {
            None => 0.0,
            Some(prev) => {
                let mut speed = f32::INFINITY;
                for i in 0..AXES {
                    let change = (prev.unit[i] - unit[i]).abs();
                    if change > 1.0e-6 {
                        speed = speed.min(settings.jerk[i] / change);
                    }
                }
                speed.min(nominal_speed).min(prev.nominal_speed)
            }
        };

        // A turn on the axis has nothing under the beam: laser off.
        let power = if surface_mm < SURFACE_EPSILON_MM { 0.0 } else { power };
        let block = Block {
            steps,
            dir_forward,
            step_event_count: event_count,
            length,
            unit,
            entry_speed_sqr: 0.0,
            max_entry_speed_sqr: max_entry_speed * max_entry_speed,
            nominal_speed,
            requested_speed,
            acceleration,
            kind,
            power,
            surface_rate: nominal_speed * surface_mm / length,
            surface_mm,
            recalculate: false,
            progress: 0.0,
        };
        let at = self.index(self.count);
        self.blocks[at] = block;
        self.count += 1;
        self.position = target_steps;
        self.replan();
        Ok(true)
    }

    /// Backward pass from the last block (which exits at zero) down to the
    /// block after the current one, then the forward pass from the current
    /// block: every entry speed is reachable from both sides. The current
    /// block's entry speed is the stepper's and is left alone.
    fn replan(&mut self) {
        if self.count < 2 {
            if let Some(block) = self.current_mut() {
                block.recalculate = false;
            }
            return;
        }
        let mut exit_sqr = 0.0;
        for nth in (1..self.count).rev() {
            let at = self.index(nth);
            let block = &mut self.blocks[at];
            let reachable = exit_sqr + 2.0 * block.acceleration * block.length;
            block.entry_speed_sqr = block.max_entry_speed_sqr.min(reachable);
            block.recalculate = false;
            exit_sqr = block.entry_speed_sqr;
        }
        for nth in 0..self.count - 1 {
            let current = self.blocks[self.index(nth)];
            let next = &mut self.blocks[self.index(nth + 1)];
            if current.entry_speed_sqr < next.entry_speed_sqr {
                let reachable = current.reachable_exit_sqr();
                if reachable < next.entry_speed_sqr {
                    next.entry_speed_sqr = reachable;
                }
            }
        }
    }

    /// The block the stepper should execute next.
    pub fn current(&self) -> Option<&Block> {
        self.nth(0)
    }

    pub fn current_mut(&mut self) -> Option<&mut Block> {
        if self.count > 0 {
            Some(&mut self.blocks[self.tail])
        } else {
            None
        }
    }

    /// Drops the current block once the stepper has consumed it.
    pub fn discard_current(&mut self) {
        if self.count > 0 {
            self.tail = self.index(1);
            self.count -= 1;
        }
    }

    /// Planned end position in steps.
    pub fn position(&self) -> [i32; AXES] {
        self.position
    }

    /// Planned end position in units, from the step position.
    pub fn position_units(&self, settings: &Settings) -> [f32; AXES] {
        let mut units = [0f32; AXES];
        for i in 0..AXES {
            units[i] = math::steps_to_units(self.position[i], settings.steps[i]);
        }
        units
    }

    /// Sets the planned position; only meaningful when the ring is empty.
    pub fn set_position(&mut self, steps: [i32; AXES]) {
        self.position = steps;
    }

    /// Drops every block; the position is left for the caller to sync.
    pub fn clear(&mut self) {
        self.count = 0;
    }

    /// After a hold: the current block starts again from a stop, so the
    /// profile of everything queued is recomputed from zero entry speed.
    pub fn reinitialize(&mut self) {
        if let Some(block) = self.current_mut() {
            block.entry_speed_sqr = 0.0;
            block.recalculate = true;
        }
        self.replan();
    }

    /// The stepper stopped part way through the current block with
    /// `remaining` events left: shorten it so the plan starts there.
    /// The steps left per axis are what the stepper's Bresenham has not
    /// produced yet, so the total over the two parts is exact.
    pub fn shorten_current(&mut self, remaining: u32) {
        let Some(block) = self.current_mut() else {
            return;
        };
        let total = block.step_event_count;
        if remaining == 0 {
            self.discard_current();
            self.replan();
            return;
        }
        if remaining < total {
            let done = total - remaining;
            let scale = remaining as f32 / total as f32;
            let mut event_count = 0;
            for i in 0..AXES {
                block.steps[i] -= math::bresenham_done(done, block.steps[i], total);
                event_count = event_count.max(block.steps[i]);
            }
            block.step_event_count = event_count;
            block.length *= scale;
            block.surface_mm *= scale;
        }
        block.progress = 0.0;
        block.entry_speed_sqr = 0.0;
        block.max_entry_speed_sqr = 0.0;
        block.recalculate = true;
        self.replan();
    }

    /// Any block queued is a jog.
    pub fn has_jog(&self) -> bool {
        (0..self.count).any(|nth| self.blocks[self.index(nth)].kind == MoveKind::Jog)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{A, R};

    fn settings() -> Settings {
        Settings {
            // Fixed here so these tests measure the code and not the
            // machine's defaults: 256 steps/mm on the radius, 888.889
            // steps/deg on the table, neither near the step generator's
            // ceiling.
            steps: [256.0, 888.889],
            max_rate: [1000.0, 1080.0],
            jog_rate: [600.0, 720.0],
            jerk: [3.0, 10.0],
            ..Settings::default()
        }
    }

    fn push(planner: &mut Planner, r: f32, a: f32, kind: MoveKind, feed: Feed, power: f32) -> bool {
        planner.push([r, a], kind, feed, power, &settings()).unwrap()
    }

    fn close(a: f32, b: f32, tol: f32) -> bool {
        (a - b).abs() <= tol * b.abs().max(1.0)
    }

    #[test]
    fn empty_planner() {
        let planner = Planner::new();
        assert!(planner.is_empty());
        assert_eq!(planner.free(), BLOCKS);
        assert_eq!(planner.len(), 0);
        assert!(planner.current().is_none());
        assert_eq!(planner.position(), [0, 0]);
        assert_eq!(planner.position_units(&settings()), [0.0, 0.0]);
        assert!(!planner.has_jog());
        assert_eq!(planner.current_exit_speed_sqr(), 0.0);
    }

    #[test]
    fn target_rounds_to_steps_and_zero_moves_are_skipped() {
        let mut planner = Planner::new();
        assert!(!push(&mut planner, 0.001, 0.0, MoveKind::Rapid, Feed::Max, 0.0));
        assert!(planner.is_empty());
        assert!(push(&mut planner, 10.0, -90.0, MoveKind::Rapid, Feed::Max, 0.0));
        let block = planner.current().unwrap();
        assert_eq!(block.steps, [2560, 80000]);
        assert_eq!(block.dir_forward, 1 << R);
        assert_eq!(block.step_event_count, 80000);
        assert_eq!(planner.position(), [2560, -80000]);
        let units = planner.position_units(&settings());
        assert!(close(units[R], 10.0, 1e-6) && close(units[A], -90.0, 1e-6));
        assert!(!push(&mut planner, 10.0, -90.0, MoveKind::Rapid, Feed::Max, 0.0));
        assert_eq!(planner.len(), 1);
    }

    #[test]
    fn long_unwrapped_angle_is_exact() {
        let mut planner = Planner::new();
        assert!(push(&mut planner, 0.0, 3600.0, MoveKind::Rapid, Feed::Max, 0.0));
        let block = planner.current().unwrap();
        assert_eq!(block.steps, [0, 3_200_000]);
        assert_eq!(block.unit, [0.0, 1.0]);
        assert!(close(block.length, 3600.0, 1e-5));
        assert!(push(&mut planner, 0.0, 3599.999, MoveKind::Rapid, Feed::Max, 0.0));
        assert_eq!(planner.nth(1).unwrap().steps, [0, 1]);
        assert_eq!(planner.nth(1).unwrap().dir_forward, 0);
    }

    #[test]
    fn ring_fills_and_drains() {
        let mut planner = Planner::new();
        for i in 1..=BLOCKS {
            assert_eq!(planner.push([i as f32, 0.0], MoveKind::Rapid, Feed::Max, 0.0, &settings()), Ok(true));
        }
        assert_eq!(planner.free(), 0);
        assert_eq!(
            planner.push([100.0, 0.0], MoveKind::Rapid, Feed::Max, 0.0, &settings()),
            Err(PlanError::Full)
        );
        assert_eq!(planner.position(), [BLOCKS as i32 * 256, 0]);
        for i in 0..BLOCKS {
            assert_eq!(planner.current().unwrap().steps[R], 256, "block {i}");
            planner.discard_current();
        }
        assert!(planner.is_empty());
        planner.discard_current();
        assert!(planner.is_empty());
        assert!(push(&mut planner, 0.0, 1.0, MoveKind::Jog, Feed::Jog, 0.0));
        assert!(planner.has_jog());
        planner.clear();
        assert!(planner.is_empty());
        assert!(!planner.has_jog());
        assert_eq!(planner.position(), [0, 889]);
        planner.set_position([5, -7]);
        assert_eq!(planner.position(), [5, -7]);
    }

    #[test]
    fn max_feed_paces_by_the_slower_axis() {
        let mut planner = Planner::new();
        // Pure radial: r_rate 1000 mm/min.
        push(&mut planner, 30.0, 0.0, MoveKind::Rapid, Feed::Max, 0.0);
        let b = planner.nth(0).unwrap();
        assert!(close(b.nominal_speed, 1000.0 / 60.0, 1e-5));
        assert!(close(b.acceleration, 50.0, 1e-5));
        assert!(close(b.surface_mm, 30.0, 1e-5));
        assert!(close(b.surface_rate, 1000.0 / 60.0, 1e-5));
        // Pure turn: a_rate 1080 deg/min.
        push(&mut planner, 30.0, 90.0, MoveKind::Rapid, Feed::Max, 0.0);
        let b = planner.nth(1).unwrap();
        assert!(close(b.nominal_speed, 18.0, 1e-5));
        assert!(close(b.requested_speed, 18.0, 1e-5));
        // Diagonal 30 mm and 30 deg: the radius axis paces (1000/60 = 16.7 < 18).
        push(&mut planner, 60.0, 120.0, MoveKind::Rapid, Feed::Max, 0.0);
        let b = planner.nth(2).unwrap();
        let expected = 1000.0 / 60.0 / core::f32::consts::FRAC_1_SQRT_2;
        assert!(close(b.nominal_speed, expected, 1e-5));
        assert!(close(b.acceleration, 50.0 / core::f32::consts::FRAC_1_SQRT_2, 1e-5));
        // Jog uses the jog rates.
        push(&mut planner, 60.0, 130.0, MoveKind::Jog, Feed::Jog, 0.0);
        assert!(close(planner.nth(3).unwrap().nominal_speed, 12.0, 1e-5));
    }

    #[test]
    fn surface_feed_sets_the_metric_speed() {
        let mut planner = Planner::new();
        push(&mut planner, 10.0, 0.0, MoveKind::Rapid, Feed::Max, 0.0);
        planner.discard_current();
        // A 90 degree arc at r = 10: 15.708 mm of board at 300 mm/min = 3.1416 s
        // over 90 metric units = 28.65 units/s, above the table's 18 deg/s.
        push(&mut planner, 10.0, 90.0, MoveKind::Cut, Feed::Surface(300.0), 400.0);
        let b = planner.current().unwrap();
        assert!(close(b.surface_mm, 15.70796, 1e-4));
        assert!(close(b.requested_speed, 90.0 / (15.70796 / 5.0), 1e-4));
        assert!(close(b.nominal_speed, 18.0, 1e-5));
        assert!(close(b.surface_rate, 18.0 * 15.70796 / 90.0, 1e-4));
        assert_eq!(b.kind, MoveKind::Cut);
        assert_eq!(b.power, 400.0);
        // Slow enough not to be limited: 30 mm/min.
        push(&mut planner, 10.0, 180.0, MoveKind::Cut, Feed::Surface(30.0), 400.0);
        let b = planner.nth(1).unwrap();
        assert!(close(b.requested_speed, 90.0 / (15.70796 / 0.5), 1e-4));
        assert!(close(b.nominal_speed, b.requested_speed, 1e-6));
        assert!(close(b.surface_rate, 0.5, 1e-4));
    }

    #[test]
    fn turn_on_the_axis_runs_at_max_rate() {
        let mut planner = Planner::new();
        push(&mut planner, 0.0, 180.0, MoveKind::Cut, Feed::Surface(100.0), 500.0);
        let b = planner.current().unwrap();
        assert_eq!(b.surface_mm, 0.0);
        assert!(close(b.nominal_speed, 18.0, 1e-5));
        assert!(close(b.requested_speed, 18.0, 1e-5));
        assert_eq!(b.surface_rate, 0.0);
        assert_eq!(b.power, 0.0);
        assert_eq!(b.kind, MoveKind::Cut);
    }

    #[test]
    fn single_block_ramps_from_and_to_zero() {
        let mut planner = Planner::new();
        push(&mut planner, 100.0, 0.0, MoveKind::Rapid, Feed::Max, 0.0);
        let b = planner.current().unwrap();
        assert_eq!(b.entry_speed_sqr, 0.0);
        assert_eq!(b.max_entry_speed_sqr, 0.0);
        assert_eq!(planner.current_exit_speed_sqr(), 0.0);
    }

    #[test]
    fn collinear_blocks_keep_full_speed_through_the_junction() {
        let mut planner = Planner::new();
        push(&mut planner, 50.0, 0.0, MoveKind::Cut, Feed::Surface(600.0), 100.0);
        push(&mut planner, 100.0, 0.0, MoveKind::Cut, Feed::Surface(600.0), 100.0);
        push(&mut planner, 150.0, 0.0, MoveKind::Cut, Feed::Surface(600.0), 100.0);
        let nominal = 10.0f32;
        assert!(close(planner.nth(0).unwrap().nominal_speed, nominal, 1e-5));
        assert_eq!(planner.nth(0).unwrap().entry_speed_sqr, 0.0);
        assert!(close(planner.nth(1).unwrap().max_entry_speed_sqr, nominal * nominal, 1e-5));
        assert!(close(planner.nth(1).unwrap().entry_speed_sqr, nominal * nominal, 1e-5));
        assert!(close(planner.nth(2).unwrap().entry_speed_sqr, nominal * nominal, 1e-5));
    }

    #[test]
    fn right_angle_junction_follows_the_jerk_rule() {
        let mut planner = Planner::new();
        push(&mut planner, 50.0, 0.0, MoveKind::Cut, Feed::Surface(600.0), 100.0);
        push(&mut planner, 50.0, 50.0, MoveKind::Cut, Feed::Surface(600.0), 100.0);
        // Radius goes from unit 1 to 0: v <= r_jerk / 1 = 3; angle from 0 to 1: v <= a_jerk = 10.
        let junction = planner.nth(1).unwrap().max_entry_speed_sqr;
        assert!(close(junction, 9.0, 1e-5), "{junction}");
        assert!(close(planner.nth(1).unwrap().entry_speed_sqr, 9.0, 1e-5));
        // Back to a radial move the other way: units (0, 1) then (-1, 0), again 3.
        push(&mut planner, 0.0, 50.0, MoveKind::Cut, Feed::Surface(600.0), 100.0);
        assert!(close(planner.nth(2).unwrap().max_entry_speed_sqr, 9.0, 1e-5));
        // Reversal along the radius: unit -1 to 1 asks 2v <= 3, so v = 1.5.
        push(&mut planner, 50.0, 50.0, MoveKind::Cut, Feed::Surface(600.0), 100.0);
        assert!(close(planner.nth(3).unwrap().max_entry_speed_sqr, 2.25, 1e-5));
        assert!(close(planner.nth(3).unwrap().entry_speed_sqr, 2.25, 1e-5));
    }

    #[test]
    fn short_blocks_are_limited_by_what_is_reachable() {
        let mut planner = Planner::new();
        // 0.25 mm (64 step) blocks: 2 * 50 * 0.25 = 25 (units/s)^2 reachable from a stop.
        push(&mut planner, 0.25, 0.0, MoveKind::Cut, Feed::Surface(600.0), 100.0);
        push(&mut planner, 0.5, 0.0, MoveKind::Cut, Feed::Surface(600.0), 100.0);
        push(&mut planner, 0.75, 0.0, MoveKind::Cut, Feed::Surface(600.0), 100.0);
        assert!(close(planner.nth(1).unwrap().entry_speed_sqr, 25.0, 1e-4));
        assert!(close(planner.nth(2).unwrap().entry_speed_sqr, 25.0, 1e-4));
        push(&mut planner, 1.0, 0.0, MoveKind::Cut, Feed::Surface(600.0), 100.0);
        // The middle block can now run faster, the last still ends at zero.
        assert!(close(planner.nth(1).unwrap().entry_speed_sqr, 25.0, 1e-4));
        assert!(close(planner.nth(2).unwrap().entry_speed_sqr, 50.0, 1e-4));
        assert!(close(planner.nth(3).unwrap().entry_speed_sqr, 25.0, 1e-4));
        // A block whose steps are being sliced offers only what is left of it.
        {
            let current = planner.current_mut().unwrap();
            current.entry_speed_sqr = 0.0;
            current.progress = current.length * 0.5;
        }
        push(&mut planner, 1.25, 0.0, MoveKind::Cut, Feed::Surface(600.0), 100.0);
        assert!(close(planner.nth(1).unwrap().entry_speed_sqr, 12.5, 1e-4));
        assert!(close(planner.nth(2).unwrap().entry_speed_sqr, 37.5, 1e-4));
    }

    #[test]
    fn reinitialize_restarts_from_zero() {
        let mut planner = Planner::new();
        push(&mut planner, 50.0, 0.0, MoveKind::Cut, Feed::Surface(600.0), 100.0);
        push(&mut planner, 100.0, 0.0, MoveKind::Cut, Feed::Surface(600.0), 100.0);
        {
            let current = planner.current_mut().unwrap();
            current.entry_speed_sqr = 64.0;
            current.progress = 49.9;
        }
        push(&mut planner, 150.0, 0.0, MoveKind::Cut, Feed::Surface(600.0), 100.0);
        assert!(close(planner.nth(1).unwrap().entry_speed_sqr, 74.0, 1e-3));
        planner.reinitialize();
        assert_eq!(planner.current().unwrap().entry_speed_sqr, 0.0);
        assert!(planner.current().unwrap().recalculate);
        // Progress is kept: 0.1 mm is left, so the next block enters at 10.
        assert!(close(planner.nth(1).unwrap().entry_speed_sqr, 10.0, 1e-3));
        assert!(!planner.nth(1).unwrap().recalculate);
    }

    #[test]
    fn shorten_current_keeps_the_step_total_exact() {
        let mut planner = Planner::new();
        push(&mut planner, 10.0, 3.0, MoveKind::Cut, Feed::Surface(600.0), 100.0);
        let full = *planner.current().unwrap();
        assert_eq!(full.steps, [2560, 2667]);
        assert_eq!(full.step_event_count, 2667);
        for done in [1u32, 100, 1333, 2666] {
            let mut copy = Planner::new();
            push(&mut copy, 10.0, 3.0, MoveKind::Cut, Feed::Surface(600.0), 100.0);
            push(&mut copy, 20.0, 3.0, MoveKind::Cut, Feed::Surface(600.0), 100.0);
            copy.current_mut().unwrap().entry_speed_sqr = 30.0;
            copy.current_mut().unwrap().progress = 1.0;
            copy.shorten_current(full.step_event_count - done);
            let b = copy.current().unwrap();
            for i in 0..AXES {
                assert_eq!(b.steps[i] + math::bresenham_done(done, full.steps[i], full.step_event_count), full.steps[i]);
            }
            assert_eq!(b.step_event_count, full.step_event_count - done);
            let scale = b.step_event_count as f32 / full.step_event_count as f32;
            assert!(close(b.length, full.length * scale, 1e-5));
            assert!(close(b.surface_mm, full.surface_mm * scale, 1e-5));
            assert_eq!(b.entry_speed_sqr, 0.0);
            assert_eq!(b.progress, 0.0);
            assert!(b.recalculate);
            assert_eq!(b.unit, full.unit);
            assert_eq!(b.dir_forward, full.dir_forward);
            // The block after it is replanned from the shortened length.
            let reachable = 2.0 * b.acceleration * b.length;
            let next = copy.nth(1).unwrap().entry_speed_sqr;
            assert!(next <= reachable * (1.0 + 1e-5), "{next} {reachable}");
        }
        // Nothing done: only the entry speed changes.
        planner.shorten_current(full.step_event_count);
        assert_eq!(planner.current().unwrap().steps, full.steps);
        assert_eq!(planner.current().unwrap().entry_speed_sqr, 0.0);
        // Nothing left: the block is gone.
        planner.shorten_current(0);
        assert!(planner.is_empty());
        planner.shorten_current(5);
        assert!(planner.is_empty());
    }

    #[test]
    fn first_block_after_the_ring_empties_starts_from_zero() {
        let mut planner = Planner::new();
        push(&mut planner, 50.0, 0.0, MoveKind::Cut, Feed::Surface(600.0), 100.0);
        planner.discard_current();
        push(&mut planner, 100.0, 0.0, MoveKind::Cut, Feed::Surface(600.0), 100.0);
        assert_eq!(planner.current().unwrap().entry_speed_sqr, 0.0);
        assert_eq!(planner.current().unwrap().max_entry_speed_sqr, 0.0);
    }

    #[test]
    fn negative_direction_and_mixed_axes() {
        let mut planner = Planner::new();
        planner.set_position([2560, 88889]);
        push(&mut planner, 5.0, 50.0, MoveKind::Rapid, Feed::Max, 0.0);
        let b = planner.current().unwrap();
        assert_eq!(b.dir_forward, 0);
        assert_eq!(b.steps, [1280, 88889 - 44444]);
        assert!(b.unit[R] < 0.0 && b.unit[A] < 0.0);
        assert!(close(b.length, math::hypot(5.0, 50.0), 1e-4));
    }
}
