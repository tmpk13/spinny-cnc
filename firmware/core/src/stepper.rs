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
//!
//! Profile slicing: every segment is planned from the speed at the end of
//! the previous one and the distance left in the block, so a block whose
//! exit speed the planner raised meanwhile (a block was appended) picks the
//! new exit up at its next segment, and nothing accumulates: the steps of a
//! segment are whole events taken off the block's exact event count.
//!
//! Probing: a block made by `probe` carries `StepBlock::probe`. While one
//! is loaded the interrupt reads the probe input at every tick and, the
//! first time it is active, copies the executed position into
//! `Shared::probe_at` and sets `Shared::probe_hit`. It does not stop by
//! itself: the main loop sees the flag and brakes like a jog cancel, so
//! the latched position is the contact and the travel after it is only
//! the braking distance. A brake only reaches segments not yet written,
//! so a probe keeps no more than `probe_segments` in the ring (the
//! `probe_ms` setting): with the full ring the head would press on for
//! 160 ms past the contact.
//!
//! A probe armed to halt (`probe_ms` 0, and slow enough that stopping dead
//! is within the axis's jerk) does not brake at all: at the contact the
//! interrupt drops the segment in progress and everything queued, and
//! while the halt stands it drops whatever else arrives, so the head
//! stops within the tick. The main loop then ends the probe with
//! `Front::abort`, which forgets the halt.
//!
//! Spindle: with the `spindle` setting the laser output drives a spindle,
//! which the main loop runs at a speed of its own through every move and
//! hold. `Shared::spindle` tells the interrupt so, and it then never writes
//! the output: not per segment, not when the ring runs dry, not on an abort.
//!
//! Abort ordering: `Front::abort` sets `Shared::abort` and forgets its own
//! state; it cannot empty the ring because the `Consumer` belongs to the
//! interrupt. The caller pends the interrupt; the interrupt's next `tick`
//! discards the segment in progress and every queued one, sets `idle`, and
//! clears `abort` last. Until then `Front::abort_pending` is true and
//! `prep` produces nothing (it asks for a kick while the interrupt is
//! idle). The first `prep` or `flush` after that copies the executed
//! position into the planner.

use core::cell::UnsafeCell;
use core::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, Ordering};

use heapless::spsc::{Consumer, Producer, Queue};

use crate::hal::{LaserPort, StepPort};
use crate::math;
use crate::parser::PowerMode;
use crate::planner::{Block, MoveKind, Planner};
use crate::settings::Settings;
use crate::{AXES, H, SEGMENTS, SEGMENT_MS};

/// Block ring size on the stepper side.
pub const STEP_BLOCKS: usize = 4;
/// Largest tick subdivision: up to `1 << MAX_AMASS` ticks per step event.
pub const MAX_AMASS: u8 = 3;
/// Most Bresenham events one block may hold. The interrupt shifts the
/// event count left by `MAX_AMASS` and adds an axis's shifted step count
/// (at most the same) to a counter kept below it, so twice the shifted
/// event count must still fit a u32. A longer block would wrap the
/// counters and lose the position; the caller refuses such a move.
pub const MAX_EVENTS: u32 = 1 << (31 - MAX_AMASS as u32);
/// Tick rate the subdivision aims for when the event rate is below it.
pub const AMASS_TARGET_HZ: f32 = 4000.0;
/// Slowest event rate a segment is written with, so its period stays
/// well inside a u32 of microseconds.
const MIN_EVENT_RATE_HZ: f32 = 2.0;
/// Segment length as planned, seconds.
const SEGMENT_S: f32 = SEGMENT_MS as f32 / 1000.0;
/// Segments a probe block keeps queued: the time between contact and the
/// start of the brake, beyond the main loop's own period. `probe_ms` in
/// whole segments, rounded up, and at least one.
pub fn probe_segments(settings: &Settings) -> usize {
    (settings.probe_ms.div_ceil(SEGMENT_MS) as usize).clamp(1, SEGMENTS)
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct StepBlock {
    pub steps: [u32; AXES],
    pub event_count: u32,
    /// Pin levels for the direction pins, polarity applied.
    pub dir_levels: u8,
    /// Bit i set when axis i counts up; the position follows this.
    pub dir_forward: u8,
    /// Board mm per metric unit, for the rate report.
    pub surface_scale: f32,
    /// Sample the probe input at every tick of this block.
    pub probe: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Segment {
    /// Ticks in this segment.
    pub ticks: u16,
    /// Microseconds between ticks.
    pub period_us: u32,
    /// Fraction of a microsecond on top of `period_us`, in 1/256 us; the
    /// interrupt carries it so the average period is exact.
    pub period_frac: u8,
    /// Tick subdivision: `1 << amass` ticks per step event.
    pub amass: u8,
    /// Index into the step block ring.
    pub block: u8,
    /// Laser high time, permille, for the whole segment.
    pub duty: u16,
    /// Metric speed of the segment, for the rate report.
    pub speed: f32,
}

impl Segment {
    /// Step events in the segment.
    pub fn events(&self) -> u32 {
        self.ticks as u32 >> self.amass
    }
}

/// Memory shared by both halves. Lives in a static in the firmware.
pub struct Shared {
    pub(crate) ring: UnsafeCell<Queue<Segment, SEGMENTS>>,
    pub(crate) blocks: UnsafeCell<[StepBlock; STEP_BLOCKS]>,
    /// Executed position in steps.
    pub position: [AtomicI32; AXES],
    /// The interrupt has nothing queued and is not armed.
    pub idle: AtomicBool,
    /// Stop stepping at once, discarding the segment in progress.
    pub abort: AtomicBool,
    /// Segments the interrupt has finished or discarded, wrapping; the
    /// front compares it with its own count to know when a block slot is
    /// free again.
    pub done: AtomicU32,
    /// The laser output is active low: off is full duty.
    pub laser_invert: AtomicBool,
    /// A hold is in force: every segment the interrupt loads runs with the
    /// beam off, whatever duty it was written with. Segments queued before
    /// the hold carry their own duty, so without this the beam would come
    /// back at the next segment boundary and burn through the whole ramp.
    pub laser_off: AtomicBool,
    /// The output drives a spindle, which the main loop owns: the
    /// interrupt leaves it alone.
    pub spindle: AtomicBool,
    /// Board speed of the segment being executed, mm/min as f32 bits, and
    /// the laser duty the interrupt applied for it. Written at every
    /// segment load, so a report shows the motion under way rather than
    /// the segment last written to the ring, up to 150 ms ahead of it.
    pub surface_rate: AtomicU32,
    pub duty: AtomicU32,
    /// Probe input level that means contact, from the settings.
    pub probe_level: AtomicBool,
    /// A probe block met contact; `probe_at` holds the focus axis position
    /// in steps at that tick. Cleared by `Front::arm_probe`.
    pub probe_hit: AtomicBool,
    pub probe_at: AtomicI32,
    /// The probe stops dead at contact rather than braking: set by
    /// `Front::arm_probe`, cleared when the front forgets its state.
    pub probe_halt: AtomicBool,
    /// Slot of the segment in progress, `NO_SLOT` when none; kept for the
    /// slot reuse check in the tests.
    #[cfg(test)]
    pub(crate) executing: core::sync::atomic::AtomicU8,
}

#[cfg(test)]
const NO_SLOT: u8 = u8::MAX;

// SAFETY: `Shared` is used by exactly one producer (`Front`, main loop) and
// one consumer (`Isr`, interrupt), made by a single `split`. `ring` is only
// touched through the `Producer` and `Consumer` it was split into, whose
// atomics order every enqueue before the matching dequeue. `blocks` is
// written by `Front` alone, and only into a slot that no queued or
// in-progress segment refers to (`done` versus the front's enqueue count,
// with release/acquire ordering); a block is written before the first
// segment referring to it is enqueued, so the queue's release store
// publishes it to the interrupt's acquire load. The remaining fields are
// atomics.
unsafe impl Sync for Shared {}

impl Shared {
    pub const fn new() -> Self {
        Shared {
            ring: UnsafeCell::new(Queue::new()),
            blocks: UnsafeCell::new(
                [StepBlock { steps: [0; AXES], event_count: 0, dir_levels: 0, dir_forward: 0, surface_scale: 0.0, probe: false };
                    STEP_BLOCKS],
            ),
            position: [AtomicI32::new(0), AtomicI32::new(0), AtomicI32::new(0), AtomicI32::new(0)],
            idle: AtomicBool::new(true),
            abort: AtomicBool::new(false),
            done: AtomicU32::new(0),
            laser_invert: AtomicBool::new(false),
            laser_off: AtomicBool::new(false),
            spindle: AtomicBool::new(false),
            surface_rate: AtomicU32::new(0),
            duty: AtomicU32::new(0),
            probe_level: AtomicBool::new(false),
            probe_hit: AtomicBool::new(false),
            probe_at: AtomicI32::new(0),
            probe_halt: AtomicBool::new(false),
            #[cfg(test)]
            executing: core::sync::atomic::AtomicU8::new(NO_SLOT),
        }
    }

    fn off_duty(&self) -> u16 {
        if self.laser_invert.load(Ordering::Relaxed) {
            1000
        } else {
            0
        }
    }

    fn read_position(&self) -> [i32; AXES] {
        let mut position = [0; AXES];
        for i in 0..AXES {
            position[i] = self.position[i].load(Ordering::Relaxed);
        }
        position
    }
}

impl Default for Shared {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Hold {
    None,
    /// Segments decelerate to zero, ignoring the planned profile.
    Decel,
    /// The ramp has been produced; nothing more until `resume`.
    Stopped,
}

/// The block being sliced.
#[derive(Clone, Copy, Debug)]
struct Slice {
    slot: u8,
    /// Events not yet put in a segment.
    events_left: u32,
    /// Metric length per event.
    per_event: f32,
}

/// Main-loop half.
pub struct Front<'a> {
    shared: &'a Shared,
    producer: Producer<'a, Segment>,
    /// Segments enqueued so far, wrapping; the n-th segment has number n.
    enqueued: u32,
    /// Number of the last segment written for each block slot; 0 = never.
    slot_seq: [u32; STEP_BLOCKS],
    next_slot: usize,
    slice: Option<Slice>,
    /// Metric speed at the end of the last segment produced.
    speed: f32,
    hold: Hold,
    /// `resume` came while the hold ramp was still being produced.
    resume_pending: bool,
    /// The planner position must be copied from the executed position once
    /// the interrupt has processed an abort.
    resync: bool,
}

/// Interrupt half.
pub struct Isr<'a> {
    shared: &'a Shared,
    consumer: Consumer<'a, Segment>,
    segment: Option<Segment>,
    ticks_left: u16,
    /// Slot whose Bresenham data is in the counters.
    loaded: Option<u8>,
    counter: [u32; AXES],
    steps_shifted: [u32; AXES],
    event_shifted: u32,
    forward: u8,
    /// Board mm per metric unit of the loaded block.
    surface_scale: f32,
    /// The loaded block is a probe: watch the input.
    probing: bool,
    /// Local copy of `Shared::done`.
    done: u32,
    /// Fraction of a microsecond owed to the timer, in 1/256 us.
    frac_acc: u32,
    /// Segments loaded so far and the last one, for the tests.
    #[cfg(test)]
    loads: u32,
    #[cfg(test)]
    last_loaded: Segment,
}

/// Splits the shared memory into the two halves. Called once.
pub fn split(shared: &'static mut Shared) -> (Front<'static>, Isr<'static>) {
    let shared: &'static Shared = shared;
    // SAFETY: the unique reference was just given up for the shared one,
    // so no other reference to the queue exists; the producer and consumer
    // only use the queue's atomics afterwards (see the `Sync` impl).
    let queue = unsafe { &mut *shared.ring.get() };
    let (producer, consumer) = queue.split();
    let front = Front {
        shared,
        producer,
        enqueued: 0,
        slot_seq: [0; STEP_BLOCKS],
        next_slot: 0,
        slice: None,
        speed: 0.0,
        hold: Hold::None,
        resume_pending: false,
        resync: false,
    };
    let isr = Isr {
        shared,
        consumer,
        segment: None,
        ticks_left: 0,
        loaded: None,
        counter: [0; AXES],
        steps_shifted: [0; AXES],
        event_shifted: 0,
        forward: 0,
        surface_scale: 0.0,
        probing: false,
        done: 0,
        frac_acc: 0,
        #[cfg(test)]
        loads: 0,
        #[cfg(test)]
        last_loaded: Segment::default(),
    };
    (front, isr)
}

/// What `prep` did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Prep {
    /// The ring was empty and idle before this call and has segments now:
    /// the caller must start the step timer (pend the interrupt).
    pub kick: bool,
}

/// Events for the next segment from speed `v0` with `events_left` to go,
/// and the speed at their end: accelerate or brake toward `goal` at
/// `accel` over `SEGMENT_S`, at least one event per segment. `None` when
/// braking to a stop is complete without another whole event.
fn segment_events(v0: f32, events_left: u32, per_event: f32, accel: f32, goal: f32) -> Option<(u32, f32)> {
    let dv = accel * SEGMENT_S;
    let v_end = if v0 < goal { (v0 + dv).min(goal) } else { (v0 - dv).max(goal) };
    let distance = 0.5 * (v0 + v_end) * SEGMENT_S;
    let events = libm::roundf(distance / per_event);
    let events = if events >= events_left as f32 { events_left } else { events as u32 };
    if events == 0 {
        if goal <= 0.0 && v_end <= 0.0 {
            return None;
        }
        return Some((1, v_end));
    }
    Some((events, v_end))
}

/// Speed at the end of `events` events, bounded by what the acceleration
/// allows over their distance and by the ramp down to `exit` at the end
/// of the block.
fn bound_end_speed(v0: f32, v_end: f32, events: u32, events_left: u32, per_event: f32, accel: f32, exit: f32) -> f32 {
    let d_seg = events as f32 * per_event;
    let d_after = (events_left - events) as f32 * per_event;
    let v = v_end.max(math::sqrt((v0 * v0 - 2.0 * accel * d_seg).max(0.0)));
    let v = v.min(math::sqrt(v0 * v0 + 2.0 * accel * d_seg));
    v.min(math::sqrt(exit * exit + 2.0 * accel * d_after))
}

/// Constant speed for a segment of `events` events from `v0` to `v_end`.
/// A segment that stops short of the block's end was sized from the mean
/// of its two speeds over `SEGMENT_S`, so that mean is its speed. One that
/// takes the rest of the block has its length set by the block instead,
/// and its end speed by the block's exit: a short block from rest to rest
/// would have a mean of zero and crawl at `MIN_EVENT_RATE_HZ`, the beam on
/// one spot the whole time. Its speed is then the mean of the fastest
/// profile the acceleration allows over its length (up toward `top` and
/// back down), never below the mean of its ends. `top` is the block's
/// nominal speed, or `v0` in a hold, which never speeds up.
fn segment_speed(v0: f32, v_end: f32, events: u32, slice: &Slice, block: &Block, top: f32) -> f32 {
    let mean = 0.5 * (v0 + v_end);
    let distance = events as f32 * slice.per_event;
    let accel = block.acceleration;
    if events < slice.events_left || distance <= 0.0 || !(accel.is_finite() && accel > 0.0) {
        return mean;
    }
    let peak = math::sqrt(accel * distance + 0.5 * (v0 * v0 + v_end * v_end))
        .min(top)
        .max(v0.max(v_end));
    if peak <= 0.0 {
        return mean;
    }
    let ramps = ((peak * peak - v0 * v0) + (peak * peak - v_end * v_end)) / (2.0 * accel);
    let time = (peak - v0) / accel + (peak - v_end) / accel + (distance - ramps).max(0.0) / peak;
    if time > 0.0 {
        (distance / time).max(mean)
    } else {
        mean
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Timing {
    amass: u8,
    period_us: u32,
    period_frac: u8,
    events: u32,
}

/// Tick subdivision, tick period and event count for `events` events at
/// `rate` events per second. The events are cut down when the ticks would
/// not fit the segment's u16. A period under `floor_us` (the shortest tick
/// the interrupt can hold at the current step pulse width, see
/// `crate::min_tick_us`) is held there, which makes such a segment slower
/// than planned; the planner's rate cap keeps that from happening.
fn timing(rate: f32, events: u32, floor_us: u32) -> Timing {
    let rate = rate.max(MIN_EVENT_RATE_HZ);
    let mut amass = 0u8;
    while amass < MAX_AMASS && (rate * (1u32 << amass) as f32) < AMASS_TARGET_HZ {
        amass += 1;
    }
    let tick_rate = rate * (1u32 << amass) as f32;
    let period_q8 = libm::ceilf(256.0e6 / tick_rate) as u32;
    let (period_us, period_frac) = if period_q8 >> 8 < floor_us {
        (floor_us, 0)
    } else {
        (period_q8 >> 8, (period_q8 & 0xFF) as u8)
    };
    Timing { amass, period_us, period_frac, events: events.min((u16::MAX as u32) >> amass) }
}

/// Laser duty for a segment of `block` at `speed`, polarity applied.
fn segment_duty(block: &Block, speed: f32, settings: &Settings, mode: PowerMode) -> u16 {
    let power = match (block.kind, mode) {
        (MoveKind::Cut, PowerMode::Constant) => block.power,
        (MoveKind::Cut, PowerMode::Dynamic) => {
            let scaled = if block.requested_speed > 0.0 {
                (block.power * speed / block.requested_speed).min(block.power)
            } else {
                0.0
            };
            // The cut's floor keeps the beam up where the head slows for a
            // corner or a ramp; `s_min` still turns off whatever is below it.
            let scaled = scaled.max(block.min_power);
            if scaled < settings.s_min {
                0.0
            } else {
                scaled
            }
        }
        _ => 0.0,
    };
    let duty = (power / settings.s_max * 1000.0).clamp(0.0, 1000.0) as u16;
    if settings.laser_invert {
        1000 - duty
    } else {
        duty
    }
}

impl<'a> Front<'a> {
    /// Fills the segment ring from the planner. `mode` sets how a cut's
    /// power follows the speed. Safe to call often; it returns quickly when
    /// the ring is full or the planner is empty.
    pub fn prep(&mut self, planner: &mut Planner, settings: &Settings, mode: PowerMode) -> Prep {
        self.shared.laser_invert.store(settings.laser_invert, Ordering::Relaxed);
        self.shared.spindle.store(settings.spindle, Ordering::Relaxed);
        self.shared.probe_level.store(settings.probe_invert, Ordering::Relaxed);
        if self.shared.abort.load(Ordering::SeqCst) {
            // The interrupt has to run once more to empty the ring, even
            // when it is idle.
            return Prep { kick: self.shared.idle.load(Ordering::SeqCst) };
        }
        if self.resync {
            self.resync = false;
            planner.set_position(self.position());
        }
        if self.hold == Hold::Stopped {
            if !self.resume_pending {
                return Prep::default();
            }
            self.finish_resume(planner);
        }
        if self.hold == Hold::None {
            // The hold, cancel or abort is over: segments carry their own
            // duty again. Done here rather than where the hold ends so an
            // abort still runs dark until the interrupt has emptied the ring.
            self.shared.laser_off.store(false, Ordering::Relaxed);
        }
        let mut kick = false;
        while self.producer.ready() {
            if self.slice.is_none() && !self.load_block(planner, settings) {
                break;
            }
            let probing = planner.current().is_some_and(|block| block.kind == MoveKind::Probe);
            if probing && self.producer.len() >= probe_segments(settings) {
                break;
            }
            // A halted probe is over: nothing more goes out until the main
            // loop has ended it.
            if self.halted() {
                break;
            }
            if !self.produce(planner, settings, mode) {
                break;
            }
            kick |= self.shared.idle.load(Ordering::SeqCst);
        }
        Prep { kick }
    }

    /// The segment numbered `seq` has been executed or discarded.
    fn is_done(&self, seq: u32) -> bool {
        seq == 0 || (self.shared.done.load(Ordering::Acquire).wrapping_sub(seq) as i32) >= 0
    }

    /// Takes the planner's current block into a free step block slot.
    /// False when there is no block or no free slot.
    fn load_block(&mut self, planner: &mut Planner, settings: &Settings) -> bool {
        let Some(block) = planner.current() else {
            if self.hold == Hold::Decel {
                // Nothing left to slow down: the last block ended at zero.
                self.hold = Hold::Stopped;
                self.speed = 0.0;
            }
            return false;
        };
        if self.hold == Hold::Decel && self.speed <= 0.0 {
            self.hold = Hold::Stopped;
            return false;
        }
        let slot = self.next_slot;
        if !self.is_done(self.slot_seq[slot]) {
            return false;
        }
        let step_block = StepBlock {
            steps: block.steps,
            event_count: block.step_event_count,
            dir_levels: block.dir_forward ^ settings.joint_dir_invert(),
            dir_forward: block.dir_forward,
            surface_scale: if block.length > 0.0 { block.surface_mm / block.length } else { 0.0 },
            probe: block.kind == MoveKind::Probe,
        };
        #[cfg(test)]
        self.check_slot_unreferenced(slot as u8);
        // SAFETY: the slot's last segment is done (`is_done`), so neither
        // the ring nor the interrupt refers to it; only the front writes.
        unsafe {
            (*self.shared.blocks.get())[slot] = step_block;
        }
        // A block is always taken from its start; a partly executed one
        // re-enters through `Planner::shorten_current`.
        self.slice = Some(Slice {
            slot: slot as u8,
            events_left: block.step_event_count,
            per_event: block.length / block.step_event_count as f32,
        });
        self.next_slot = (slot + 1) % STEP_BLOCKS;
        if let Some(block) = planner.current_mut() {
            block.progress = 0.0;
        }
        true
    }

    #[cfg(test)]
    fn check_slot_unreferenced(&self, slot: u8) {
        // SAFETY: tests are single-threaded, the ring is not being consumed.
        let queued = unsafe { &*self.shared.ring.get() };
        assert!(queued.iter().all(|segment| segment.block != slot), "slot {slot} rewritten while queued");
        assert_ne!(self.shared.executing.load(Ordering::Relaxed), slot, "slot {slot} rewritten while executing");
    }

    /// Writes one segment of the current slice. False when nothing was
    /// written: the ring is full, or the hold ramp has reached zero.
    fn produce(&mut self, planner: &mut Planner, settings: &Settings, mode: PowerMode) -> bool {
        let Some(mut slice) = self.slice else {
            return false;
        };
        let Some(block) = planner.current().copied() else {
            self.slice = None;
            return false;
        };
        let hold = self.hold == Hold::Decel;
        let exit = math::sqrt(planner.current_exit_speed_sqr());
        let v0 = self.speed.min(block.nominal_speed).max(0.0);
        let goal = if hold { 0.0 } else { block.nominal_speed };
        let Some((mut events, mut v_end)) = segment_events(v0, slice.events_left, slice.per_event, block.acceleration, goal)
        else {
            // Stopped without another whole event; the block keeps what is left.
            self.speed = 0.0;
            self.hold = Hold::Stopped;
            self.write_back(planner, &slice, 0.0);
            return false;
        };
        v_end = bound_end_speed(v0, v_end, events, slice.events_left, slice.per_event, block.acceleration, exit);
        let top = if hold { v0 } else { block.nominal_speed };
        let mut speed = segment_speed(v0, v_end, events, &slice, &block, top);
        let floor_us = crate::min_tick_us(settings.step_us);
        let mut timing = timing(speed / slice.per_event, events, floor_us);
        if timing.events < events {
            events = timing.events;
            v_end = bound_end_speed(v0, v_end, events, slice.events_left, slice.per_event, block.acceleration, exit);
            speed = segment_speed(v0, v_end, events, &slice, &block, top);
            timing = self::timing(speed / slice.per_event, events, floor_us);
        }
        let duty = segment_duty(&block, speed, settings, mode);
        let segment = Segment {
            ticks: (events << timing.amass) as u16,
            period_us: timing.period_us,
            period_frac: timing.period_frac,
            amass: timing.amass,
            block: slice.slot,
            duty,
            speed,
        };
        if self.producer.enqueue(segment).is_err() {
            return false;
        }
        self.enqueued = self.enqueued.wrapping_add(1);
        self.slot_seq[slice.slot as usize] = self.enqueued;
        slice.events_left -= events;
        self.speed = v_end;
        if slice.events_left == 0 {
            planner.discard_current();
            self.slice = None;
        } else {
            self.slice = Some(slice);
            self.write_back(planner, &slice, v_end);
        }
        if hold && v_end <= 0.0 {
            self.speed = 0.0;
            self.hold = Hold::Stopped;
            return false;
        }
        true
    }

    /// Gives the planner the state its current block continues from.
    fn write_back(&self, planner: &mut Planner, slice: &Slice, v_end: f32) {
        if let Some(block) = planner.current_mut() {
            block.entry_speed_sqr = v_end * v_end;
            block.progress = (block.length - slice.events_left as f32 * slice.per_event).max(0.0);
        }
    }

    /// Decelerate to a stop at the block's acceleration; further `prep`
    /// calls produce the ramp and then nothing. The beam is off from here
    /// until the hold ends, segments already queued included.
    pub fn request_hold(&mut self) {
        self.resume_pending = false;
        self.shared.laser_off.store(true, Ordering::Relaxed);
        if self.hold == Hold::None {
            self.hold = if self.speed > 0.0 { Hold::Decel } else { Hold::Stopped };
        }
    }

    /// A requested hold or cancel has come to a complete stop and the ring
    /// has drained.
    pub fn is_stopped(&self) -> bool {
        self.hold == Hold::Stopped && self.producer.is_empty() && self.shared.idle.load(Ordering::SeqCst)
    }

    /// After a hold: shorten the planner's current block to what is left,
    /// let the planner replan from zero, and continue on the next `prep`.
    /// Called before the ramp has been produced it takes effect as soon as
    /// the ramp reaches zero.
    pub fn resume(&mut self, planner: &mut Planner) {
        match self.hold {
            Hold::None => {}
            Hold::Decel => self.resume_pending = true,
            Hold::Stopped => self.finish_resume(planner),
        }
    }

    fn finish_resume(&mut self, planner: &mut Planner) {
        if let Some(slice) = self.slice.take() {
            planner.shorten_current(slice.events_left);
        }
        planner.reinitialize();
        self.hold = Hold::None;
        self.resume_pending = false;
        self.speed = 0.0;
    }

    /// Stop at once: sets the abort flag for the interrupt, drops every
    /// segment, and syncs the planner position to the executed position.
    /// The planner's blocks are cleared by the caller.
    ///
    /// The ring is emptied by the interrupt on its next tick, so the caller
    /// pends it (also when idle) and can watch `abort_pending`. The
    /// position copied here may still move by the steps of the tick in
    /// flight; the first `prep` or `flush` after the interrupt has cleared
    /// the flag copies the final one.
    pub fn abort(&mut self, planner: &mut Planner) {
        self.forget();
        planner.set_position(self.position());
        if !(self.producer.is_empty() && self.shared.idle.load(Ordering::SeqCst)) {
            self.resync = true;
            self.shared.abort.store(true, Ordering::SeqCst);
        }
    }

    /// The interrupt has not yet processed an `abort`.
    pub fn abort_pending(&self) -> bool {
        self.shared.abort.load(Ordering::SeqCst)
    }

    fn forget(&mut self) {
        self.slice = None;
        self.hold = Hold::None;
        self.resume_pending = false;
        self.speed = 0.0;
        self.shared.probe_halt.store(false, Ordering::SeqCst);
    }

    /// After a hold has stopped: discard what was queued (a jog cancel) and
    /// sync the planner position to the executed position.
    pub fn flush(&mut self, planner: &mut Planner) {
        self.forget();
        if self.shared.abort.load(Ordering::SeqCst) {
            self.resync = true;
        } else {
            self.resync = false;
            planner.set_position(self.position());
        }
    }

    /// Executed position in steps.
    pub fn position(&self) -> [i32; AXES] {
        self.shared.read_position()
    }

    /// Forgets an earlier contact, before a probe block is queued. With
    /// `halt` the interrupt stops the axes dead at the contact.
    pub fn arm_probe(&mut self, halt: bool) {
        self.shared.probe_hit.store(false, Ordering::SeqCst);
        self.shared.probe_halt.store(halt, Ordering::SeqCst);
    }

    /// A probe armed to halt has met contact, and the interrupt is
    /// dropping whatever reaches it.
    fn halted(&self) -> bool {
        self.shared.probe_halt.load(Ordering::SeqCst) && self.shared.probe_hit.load(Ordering::SeqCst)
    }

    /// Focus axis position in steps at the contact a probe block met, once
    /// it has.
    pub fn probe_contact(&self) -> Option<i32> {
        if self.shared.probe_hit.load(Ordering::Acquire) {
            Some(self.shared.probe_at.load(Ordering::Relaxed))
        } else {
            None
        }
    }

    /// Declares the executed position (a `set` command). Only while the
    /// interrupt is idle and the ring is empty, so no step is in flight.
    pub fn set_position(&mut self, steps: [i32; AXES]) {
        for i in 0..AXES {
            self.shared.position[i].store(steps[i], Ordering::Relaxed);
        }
    }

    /// The planner position still has to be copied from the executed
    /// position: an abort is being processed, or has been and the `prep`
    /// or `flush` that copies has not run yet. No block may be pushed
    /// until this is false.
    pub fn resync_pending(&self) -> bool {
        self.resync || self.shared.abort.load(Ordering::SeqCst)
    }

    /// Segments queued or a segment in progress.
    pub fn busy(&self) -> bool {
        !self.producer.is_empty() || !self.shared.idle.load(Ordering::SeqCst) || self.shared.abort.load(Ordering::SeqCst)
    }

    /// Board speed of the segment the interrupt is executing, mm/min.
    pub fn surface_rate(&self) -> f32 {
        if self.busy() {
            f32::from_bits(self.shared.surface_rate.load(Ordering::Relaxed))
        } else {
            0.0
        }
    }

    /// Laser duty the interrupt applied for the segment it is executing,
    /// permille; off once a hold has closed the beam.
    pub fn duty(&self) -> u16 {
        if self.busy() && !self.shared.laser_off.load(Ordering::Relaxed) {
            self.shared.duty.load(Ordering::Relaxed) as u16
        } else {
            self.shared.off_duty()
        }
    }
}

impl<'a> Isr<'a> {
    /// One timer tick. Returns the microseconds until the next tick, or
    /// `None` when the ring is empty: the timer stops and `Shared::idle`
    /// is set, and the next `Prep::kick` restarts it.
    pub fn tick(&mut self, port: &mut impl StepPort, laser: &mut impl LaserPort) -> Option<u32> {
        let shared = self.shared;
        if shared.abort.load(Ordering::SeqCst) {
            self.drop_all(laser);
            shared.abort.store(false, Ordering::SeqCst);
            return None;
        }
        // A halted probe stays halted: a segment the front wrote just as
        // the contact came is dropped here, not stepped.
        if shared.probe_halt.load(Ordering::SeqCst) && shared.probe_hit.load(Ordering::SeqCst) {
            self.drop_all(laser);
            return None;
        }
        if self.segment.is_none() {
            let next = match self.consumer.dequeue() {
                Some(segment) => Some(segment),
                None => {
                    // Announce idle, then look again: a segment enqueued in
                    // between would otherwise wait for a kick that was
                    // already decided against.
                    shared.idle.store(true, Ordering::SeqCst);
                    self.consumer.dequeue()
                }
            };
            match next {
                Some(segment) => self.load(segment, port, laser),
                None => {
                    self.write_duty(laser, shared.off_duty());
                    self.publish(0.0, shared.off_duty());
                    return None;
                }
            }
        }
        let segment = self.segment.unwrap_or_default();
        // Before this tick's steps, so the position latched is the one the
        // input was read at.
        if self.probing
            && !shared.probe_hit.load(Ordering::Relaxed)
            && port.probe() == shared.probe_level.load(Ordering::Relaxed)
        {
            shared.probe_at.store(shared.position[H].load(Ordering::Relaxed), Ordering::Relaxed);
            shared.probe_hit.store(true, Ordering::Release);
            if shared.probe_halt.load(Ordering::SeqCst) {
                // Not even this tick's steps: the axis stops where the
                // input was read.
                self.drop_all(laser);
                return None;
            }
        }
        let mut mask = 0u8;
        for i in 0..AXES {
            self.counter[i] += self.steps_shifted[i] >> segment.amass;
            if self.counter[i] >= self.event_shifted {
                self.counter[i] -= self.event_shifted;
                mask |= 1 << i;
                let delta = if self.forward & (1 << i) != 0 { 1 } else { -1 };
                let at = shared.position[i].load(Ordering::Relaxed);
                shared.position[i].store(at.wrapping_add(delta), Ordering::Relaxed);
            }
        }
        if mask != 0 {
            port.step(mask);
        }
        self.ticks_left -= 1;
        if self.ticks_left == 0 {
            self.segment = None;
            self.finish_segments(1);
        }
        self.frac_acc += segment.period_frac as u32;
        let carry = self.frac_acc >> 8;
        self.frac_acc &= 0xFF;
        Some(segment.period_us + carry)
    }

    /// Drops the segment in progress and everything queued, beam off, and
    /// goes idle; an abort and a probe halt end this way.
    fn drop_all(&mut self, laser: &mut impl LaserPort) {
        let shared = self.shared;
        let mut dropped = self.segment.take().map_or(0, |_| 1);
        while self.consumer.dequeue().is_some() {
            dropped += 1;
        }
        self.loaded = None;
        self.ticks_left = 0;
        self.finish_segments(dropped);
        self.write_duty(laser, shared.off_duty());
        self.publish(0.0, shared.off_duty());
        shared.idle.store(true, Ordering::SeqCst);
    }

    /// Drives the laser output, unless it is a spindle's.
    fn write_duty(&self, laser: &mut impl LaserPort, duty: u16) {
        if !self.shared.spindle.load(Ordering::Relaxed) {
            laser.set_duty(duty);
        }
    }

    /// Publishes what the executing segment does, for the status report.
    fn publish(&self, surface_rate: f32, duty: u16) {
        self.shared.surface_rate.store(surface_rate.to_bits(), Ordering::Relaxed);
        self.shared.duty.store(duty as u32, Ordering::Relaxed);
    }

    fn finish_segments(&mut self, count: u32) {
        self.done = self.done.wrapping_add(count);
        self.shared.done.store(self.done, Ordering::Release);
        #[cfg(test)]
        self.shared.executing.store(NO_SLOT, Ordering::Relaxed);
    }

    fn load(&mut self, segment: Segment, port: &mut impl StepPort, laser: &mut impl LaserPort) {
        let shared = self.shared;
        shared.idle.store(false, Ordering::SeqCst);
        if self.loaded != Some(segment.block) {
            // SAFETY: the front wrote this slot before enqueueing the
            // segment and will not touch it until the segment is done.
            let block = unsafe { (*shared.blocks.get())[segment.block as usize] };
            self.event_shifted = block.event_count << MAX_AMASS;
            for i in 0..AXES {
                self.steps_shifted[i] = block.steps[i] << MAX_AMASS;
                self.counter[i] = self.event_shifted >> 1;
            }
            self.forward = block.dir_forward;
            self.surface_scale = block.surface_scale;
            self.probing = block.probe;
            port.set_dir(block.dir_levels);
            self.loaded = Some(segment.block);
        }
        let held = shared.laser_off.load(Ordering::Relaxed);
        let duty = if held { shared.off_duty() } else { segment.duty };
        self.write_duty(laser, duty);
        self.publish(segment.speed * self.surface_scale * 60.0, duty);
        self.segment = Some(segment);
        self.ticks_left = segment.ticks;
        #[cfg(test)]
        {
            self.loads += 1;
            self.last_loaded = segment;
            shared.executing.store(segment.block, Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
mod tests {
    extern crate std;

    use std::boxed::Box;
    use std::vec::Vec;

    use super::*;
    use crate::planner::Feed;
    use crate::{A, MAX_EVENT_RATE_HZ, MIN_TICK_US, R};

    /// Polls per virtual second of the main loop in the rig.
    const POLL_US: u64 = 500;

    struct Port {
        now: u64,
        count: [u64; AXES],
        levels: u8,
        dirs: Vec<u8>,
        record: bool,
        /// (time, mask) per pulse when `record` is set.
        pulses: Vec<(u64, u8)>,
    }

    impl StepPort for Port {
        fn set_dir(&mut self, levels: u8) {
            self.levels = levels;
            self.dirs.push(levels);
        }

        fn step(&mut self, mask: u8) {
            assert!(mask != 0 && mask < 1 << AXES);
            for i in 0..AXES {
                if mask & (1 << i) != 0 {
                    self.count[i] += 1;
                }
            }
            if self.record {
                self.pulses.push((self.now, mask));
            }
        }

        fn set_enable(&mut self, _high: bool) {}

        fn probe(&mut self) -> bool {
            true
        }
    }

    struct Laser {
        now: u64,
        duty: u16,
        /// (time, duty) per change.
        duties: Vec<(u64, u16)>,
    }

    impl LaserPort for Laser {
        fn set_duty(&mut self, permille: u16) {
            assert!(permille <= 1000);
            if self.duty != permille || self.duties.is_empty() {
                self.duties.push((self.now, permille));
            }
            self.duty = permille;
        }

        fn set_frequency(&mut self, _hz: u32) {}
    }

    /// A segment as the interrupt loaded it, with its block.
    #[derive(Clone, Copy, Debug)]
    struct Loaded {
        at: u64,
        segment: Segment,
        block: StepBlock,
    }

    impl Loaded {
        fn duration_us(&self) -> u64 {
            let period_q8 = (self.segment.period_us as u64) * 256 + self.segment.period_frac as u64;
            self.segment.ticks as u64 * period_q8 / 256
        }

        fn events(&self) -> u32 {
            self.segment.events()
        }

        /// Steps of `axis` in the segment, as a fraction of the events.
        fn axis_steps(&self, axis: usize) -> f64 {
            self.events() as f64 * self.block.steps[axis] as f64 / self.block.event_count as f64
        }

        /// Metric length and acceleration of the block, recomputed from the steps.
        fn metric(&self, settings: &Settings) -> (f32, f32) {
            let mut delta = [0f32; AXES];
            for i in 0..AXES {
                delta[i] = self.block.steps[i] as f32 / settings.steps[i];
            }
            let length = math::hypot(delta[0], delta[1]);
            let mut accel = f32::INFINITY;
            for i in 0..AXES {
                let u = delta[i] / length;
                if u > 0.0 {
                    accel = accel.min(settings.accel[i] / u);
                }
            }
            (length, accel)
        }
    }

    /// Main loop, step interrupt and virtual clock in one.
    struct Rig {
        front: Front<'static>,
        isr: Isr<'static>,
        planner: Planner,
        settings: Settings,
        mode: PowerMode,
        port: Port,
        laser: Laser,
        now: u64,
        next_tick: Option<u64>,
        loads: Vec<Loaded>,
        seen_loads: u32,
        /// Blocks pushed, as (steps, dir_forward), to compare with what ran.
        pushed: Vec<([u32; AXES], u8)>,
        idle_at: u64,
        /// Executed position when the rig was built or last declared.
        start: [i32; AXES],
    }

    impl Rig {
        fn new(settings: Settings) -> Rig {
            let shared: &'static mut Shared = Box::leak(Box::new(Shared::new()));
            let (front, isr) = split(shared);
            Rig {
                front,
                isr,
                planner: Planner::new(),
                settings,
                mode: PowerMode::Dynamic,
                port: Port { now: 0, count: [0; AXES], levels: 0, dirs: Vec::new(), record: false, pulses: Vec::new() },
                laser: Laser { now: 0, duty: 0, duties: Vec::new() },
                now: 0,
                next_tick: None,
                loads: Vec::new(),
                seen_loads: 0,
                pushed: Vec::new(),
                idle_at: 0,
                start: [0; AXES],
            }
        }

        fn shared(&self) -> &'static Shared {
            self.front.shared
        }

        fn push(&mut self, r: f32, a: f32, kind: MoveKind, feed: Feed, power: f32, min_power: f32) {
            assert_eq!(self.planner.push([r, a, 0.0, 0.0], kind, feed, power, min_power, &self.settings), Ok(true));
            let block = self.planner.nth(self.planner.len() - 1).unwrap();
            self.pushed.push((block.steps, block.dir_forward));
        }

        fn go(&mut self, r: f32, a: f32) {
            self.push(r, a, MoveKind::Rapid, Feed::Max, 0.0, 0.0);
        }

        fn cut(&mut self, r: f32, a: f32, feed: f32, power: f32) {
            self.push(r, a, MoveKind::Cut, Feed::Surface(feed), power, 0.0);
        }

        fn cut_with_floor(&mut self, r: f32, a: f32, feed: f32, power: f32, min_power: f32) {
            self.push(r, a, MoveKind::Cut, Feed::Surface(feed), power, min_power);
        }

        fn tick(&mut self) {
            self.port.now = self.now;
            self.laser.now = self.now;
            let next = self.isr.tick(&mut self.port, &mut self.laser);
            self.next_tick = next.map(|us| {
                assert!(us >= MIN_TICK_US, "tick period {us} below the minimum");
                self.now + us as u64
            });
            if next.is_none() {
                self.idle_at = self.now;
                assert!(self.shared().idle.load(Ordering::SeqCst));
                if !self.settings.spindle {
                    assert_eq!(self.laser.duty, if self.settings.laser_invert { 1000 } else { 0 }, "laser on while idle");
                }
            }
            if self.isr.loads != self.seen_loads {
                self.seen_loads = self.isr.loads;
                let segment = self.isr.last_loaded;
                assert!(segment.ticks > 0, "segment with zero ticks");
                assert_eq!(segment.ticks as u32 % (1 << segment.amass), 0);
                // SAFETY: single-threaded test, the front is not writing.
                let block = unsafe { (*self.shared().blocks.get())[segment.block as usize] };
                assert!(block.event_count > 0);
                self.loads.push(Loaded { at: self.now, segment, block });
            }
        }

        fn poll(&mut self) {
            let prep = self.front.prep(&mut self.planner, &self.settings, self.mode);
            if prep.kick {
                if self.next_tick.is_some() {
                    // Only a pending abort asks again before the interrupt ran.
                    assert!(self.front.abort_pending(), "kick while the interrupt is armed");
                } else {
                    self.next_tick = Some(self.now);
                }
            }
        }

        /// Runs the main loop and the interrupt for `us` of virtual time.
        fn advance(&mut self, us: u64) {
            let end = self.now + us;
            while self.now < end {
                self.poll();
                let poll_at = (self.now + POLL_US).min(end);
                while let Some(at) = self.next_tick {
                    if at > poll_at {
                        break;
                    }
                    self.now = at;
                    self.tick();
                }
                self.now = poll_at;
            }
        }

        fn is_idle(&self) -> bool {
            self.planner.is_empty() && !self.front.busy() && self.next_tick.is_none()
        }

        /// Runs until everything is executed; returns the time the motion took.
        fn run(&mut self) -> f64 {
            let start = self.now;
            let mut first_load = None;
            loop {
                self.advance(POLL_US);
                if first_load.is_none() {
                    first_load = self.loads.first().map(|l| l.at);
                }
                if self.is_idle() {
                    self.advance(POLL_US);
                    break;
                }
                assert!(self.now - start < 1_000_000_000, "motion did not finish");
            }
            match first_load {
                Some(at) if self.idle_at > at => (self.idle_at - at) as f64 / 1.0e6,
                _ => 0.0,
            }
        }

        /// The executed position agrees with the planner, and the steps the
        /// loaded segments carried per direction add up to the pulses the
        /// port counted and to the net position from where the rig started.
        fn position_matches(&self) {
            assert_eq!(self.front.position(), self.planner.position(), "executed vs planned position");
            let mut forward = [0f64; AXES];
            let mut backward = [0f64; AXES];
            for load in &self.loads {
                for i in 0..AXES {
                    let steps = load.axis_steps(i);
                    if load.block.dir_forward & (1 << i) != 0 {
                        forward[i] += steps;
                    } else {
                        backward[i] += steps;
                    }
                }
            }
            let position = self.front.position();
            for i in 0..AXES {
                let net = forward[i] - backward[i];
                let moved = (position[i] - self.start[i]) as f64;
                assert!((net - moved).abs() < 1.5, "axis {i}: segments net {net} steps, position moved {moved}");
                let pulses = forward[i] + backward[i];
                assert!((pulses - self.port.count[i] as f64).abs() < 1.5, "axis {i}: segments {pulses} steps, port {}", self.port.count[i]);
            }
        }

        /// Steps per axis the pushed blocks add up to.
        fn pushed_steps(&self) -> [u64; AXES] {
            let mut total = [0u64; AXES];
            for (steps, _) in &self.pushed {
                for i in 0..AXES {
                    total[i] += steps[i] as u64;
                }
            }
            total
        }

        /// The blocks the interrupt ran, in order: runs of loads on one slot.
        fn executed_blocks(&self) -> Vec<([u32; AXES], u8)> {
            let mut blocks: Vec<([u32; AXES], u8)> = Vec::new();
            let mut last_slot = None;
            for load in &self.loads {
                if last_slot != Some(load.segment.block) {
                    blocks.push((load.block.steps, load.block.dir_forward));
                    last_slot = Some(load.segment.block);
                }
            }
            blocks
        }

        fn max_segment_speed(&self) -> f32 {
            self.loads.iter().map(|l| l.segment.speed).fold(0.0, f32::max)
        }

        fn max_duty(&self) -> u16 {
            self.loads.iter().map(|l| l.segment.duty).max().unwrap_or(0)
        }

        fn check_axis_rates(&self) {
            for load in &self.loads {
                let seconds = load.duration_us() as f64 / 1.0e6;
                for i in 0..AXES {
                    let limit = self.settings.max_rate[i] as f64 / 60.0 * self.settings.steps[i] as f64;
                    let rate = load.axis_steps(i) / seconds;
                    assert!(rate <= limit * 1.001, "axis {i} at {rate} steps/s, limit {limit}: {load:?}");
                }
            }
        }

        /// Speed changes between consecutive segments of one block stay
        /// within the block's acceleration over the two half segments.
        fn check_acceleration(&self) {
            for pair in self.loads.windows(2) {
                let (a, b) = (&pair[0], &pair[1]);
                if a.segment.block != b.segment.block {
                    continue;
                }
                let (_, accel) = a.metric(&self.settings);
                let seconds = (a.duration_us() + b.duration_us()) as f32 / 2.0e6;
                let change = (b.segment.speed - a.segment.speed).abs();
                let allowed = accel * seconds * 1.05 + 0.02;
                assert!(change <= allowed, "speed change {change} over {seconds}s allows {allowed}: {a:?} -> {b:?}");
                // The executed rate follows the planned speed.
                let (length, _) = a.metric(&self.settings);
                let per_event = length / a.block.event_count as f32;
                let executed = a.events() as f32 * per_event / (a.duration_us() as f32 / 1.0e6);
                assert!(executed <= a.segment.speed * 1.001 && executed >= a.segment.speed * 0.95, "{executed} vs {}", a.segment.speed);
            }
        }
    }

    fn settings() -> Settings {
        Settings {
            // Fixed here so these tests measure the code and not the
            // machine's defaults: 256 steps/mm on the radius, 888.889
            // steps/deg on the table, neither near the step generator's
            // ceiling.
            steps: [256.0, 888.889, 256.0, 256.0],
            max_rate: [1000.0, 1080.0, 600.0, 1000.0],
            jog_rate: [600.0, 720.0, 120.0, 600.0],
            jerk: [3.0, 10.0, 1.0, 3.0],
            ..Settings::default()
        }
    }

    #[test]
    fn single_block_steps_match_the_plan() {
        let mut rig = Rig::new(settings());
        rig.settings.dir_invert = 0b10;
        rig.go(10.0, -90.0);
        let seconds = rig.run();
        assert_eq!(rig.port.count, [2560, 80000, 0, 0]);
        assert_eq!(rig.front.position(), [2560, -80000, 0, 0]);
        rig.position_matches();
        assert_eq!(rig.port.dirs, std::vec![0b01 ^ 0b10]);
        assert_eq!(rig.executed_blocks(), rig.pushed);
        // 90 degrees at 18 deg/s plus the ramps (18 / 50 s).
        assert!((seconds - (5.0 + 0.36)).abs() < 0.1, "{seconds}");
        rig.check_axis_rates();
        rig.check_acceleration();
        assert!(!rig.front.busy());
        assert_eq!(rig.front.duty(), 0);
        assert_eq!(rig.front.surface_rate(), 0.0);
    }

    #[test]
    fn multi_block_program_steps_match() {
        let mut rig = Rig::new(settings());
        rig.go(20.0, 0.0);
        rig.cut(20.0, 90.0, 300.0, 400.0);
        rig.cut(25.0, 135.0, 300.0, 400.0);
        rig.cut(25.0, 45.0, 300.0, 400.0);
        rig.go(0.0, -30.0);
        rig.go(5.0, -30.0);
        rig.run();
        assert_eq!(rig.port.count, rig.pushed_steps());
        assert_eq!(rig.front.position(), [1280, -26667, 0, 0]);
        rig.position_matches();
        assert_eq!(rig.executed_blocks(), rig.pushed);
        rig.check_axis_rates();
        rig.check_acceleration();
    }

    #[test]
    fn long_unwrapped_angle_is_exact() {
        let mut rig = Rig::new(settings());
        rig.go(0.0, 3600.0);
        let seconds = rig.run();
        assert_eq!(rig.port.count, [0, 3_200_000, 0, 0]);
        assert_eq!(rig.front.position(), [0, 3_200_000, 0, 0]);
        rig.position_matches();
        assert!((seconds - (200.0 + 0.36)).abs() < 0.5, "{seconds}");
        rig.go(0.0, 3599.0);
        rig.run();
        assert_eq!(rig.front.position(), [0, 3_199_111, 0, 0]);
        assert_eq!(rig.port.count, [0, 3_200_889, 0, 0]);
        rig.check_axis_rates();
    }

    #[test]
    fn blocks_stream_while_running() {
        // Blocks pushed while the stepper runs join the plan at speed.
        let mut rig = Rig::new(settings());
        rig.cut(10.0, 0.0, 600.0, 100.0);
        rig.advance(300_000);
        rig.cut(20.0, 0.0, 600.0, 100.0);
        rig.advance(300_000);
        rig.cut(30.0, 0.0, 600.0, 100.0);
        rig.run();
        assert_eq!(rig.port.count, [7680, 0, 0, 0]);
        rig.position_matches();
        rig.check_acceleration();
        // The first block was already slowing toward zero when the second
        // arrived and picked the new exit speed up: no stop in between.
        let dips = rig.loads.iter().filter(|l| l.segment.speed < 1.0).count();
        assert!(dips <= 4, "{dips} slow segments");
    }

    #[test]
    fn surface_feed_takes_surface_length_over_feed() {
        let mut rig = Rig::new(settings());
        rig.go(10.0, 0.0);
        rig.run();
        rig.loads.clear();
        rig.cut(10.0, 90.0, 100.0, 400.0);
        let seconds = rig.run();
        let surface = 10.0 * core::f64::consts::FRAC_PI_2;
        let nominal = 90.0 / (surface / (100.0 / 60.0));
        let expected = surface / (100.0 / 60.0) + nominal / 50.0;
        assert!((seconds - expected).abs() < 0.03 * expected, "{seconds} vs {expected}");
        assert_eq!(rig.max_duty(), 400);
        rig.check_axis_rates();
        rig.check_acceleration();
    }

    #[test]
    fn a_short_block_from_rest_to_rest_takes_its_ramp_time() {
        // Blocks small enough to end within their first segments, each
        // from rest to rest: a few microns at fine microstepping. Timed at
        // the mean of a zero start and a zero exit, the last segment ran
        // at the event rate floor, seconds with the beam at full power.
        for (length, mode, power, floor) in [
            (0.002, PowerMode::Constant, 1000.0, 0.0),
            (0.002, PowerMode::Dynamic, 1000.0, 200.0),
            (0.02, PowerMode::Constant, 1000.0, 0.0),
            (0.2, PowerMode::Dynamic, 1000.0, 200.0),
        ] {
            let mut settings = settings();
            settings.steps[R] = 10240.0;
            let mut rig = Rig::new(settings);
            rig.mode = mode;
            rig.cut_with_floor(length, 0.0, 300.0, power, floor);
            let seconds = rig.run();
            // Triangle (or trapezoid) at the block's acceleration.
            let a = settings.accel[R] as f64;
            let v = 300.0 / 60.0;
            let d = length as f64;
            let expected = if a * d < v * v { 2.0 * (d / a).sqrt() } else { d / v + v / a };
            assert!(seconds < expected * 1.3 + 0.002, "{length} mm took {seconds} s, a ramp takes {expected} s");
            assert!(rig.max_duty() > 0, "the cut burns");
            rig.position_matches();
            rig.check_acceleration();
        }
    }

    #[test]
    fn axis_limited_cut_is_slower_with_less_power() {
        let mut rig = Rig::new(settings());
        rig.go(10.0, 0.0);
        rig.run();
        rig.loads.clear();
        rig.cut(10.0, 90.0, 300.0, 400.0);
        let seconds = rig.run();
        // 300 mm/min asks 28.65 units/s of a table that does 18.
        let expected = 90.0 / 18.0 + 18.0 / 50.0;
        assert!((seconds - expected).abs() < 0.03 * expected, "{seconds} vs {expected}");
        let requested = 90.0 / (10.0 * core::f32::consts::FRAC_PI_2 / 5.0);
        let duty = (400.0 * 18.0 / requested) as u16;
        assert!((rig.max_duty() as i32 - duty as i32).abs() <= 2, "{} vs {duty}", rig.max_duty());
        assert!((rig.max_segment_speed() - 18.0).abs() < 0.01);
        rig.check_axis_rates();
    }

    #[test]
    fn the_step_generators_ceiling_limits_the_speed_and_the_power_with_it() {
        // Fine microstepping runs the generator out before the axis rate
        // does: 10240 steps/mm can only be pulsed at 586 mm/min. Without
        // the planner knowing that, a segment would be planned at the
        // commanded speed, the interrupt would fall behind it, and the
        // beam would burn at a power meant for a speed never reached.
        let fine = Settings {
            steps: [10240.0, 14222.222, 256.0, 10240.0],
            max_rate: [5000.0, 5000.0, 600.0, 5000.0],
            accel: [500.0, 500.0, 500.0, 500.0],
            ..settings()
        };
        let ceiling = MAX_EVENT_RATE_HZ / 10240.0;
        let ceiling64 = ceiling as f64;
        assert!((crate::planner::effective_max_rate(&fine)[R] / 60.0 - ceiling).abs() < 0.01);

        let mut rig = Rig::new(fine);
        rig.cut(2.0, 0.0, 3000.0, 500.0);
        let seconds = rig.run();
        // A radial cut of 2 mm: the feed asks 50 mm/s, the axis gives 9.77.
        let expected = 2.0 / ceiling64 + ceiling64 / 500.0;
        assert!((seconds - expected).abs() < 0.05 * expected, "{seconds} vs {expected}");
        // The power follows the speed down, as it does for any axis limit.
        let duty = (500.0 * ceiling / 50.0) as u16;
        assert!((rig.max_duty() as i32 - duty as i32).abs() <= 3, "{} vs {duty}", rig.max_duty());
        // And every tick the interrupt was asked for was one it could make.
        rig.check_axis_rates();
        for segment in &rig.loads {
            assert!(segment.segment.period_us >= MIN_TICK_US, "a segment asked for a tick too soon");
        }
    }

    #[test]
    fn a_spindle_output_is_never_written_by_the_interrupt() {
        let mut settings = settings();
        settings.spindle = true;
        let mut rig = Rig::new(settings);
        // The main loop runs the spindle; the interrupt must leave it be
        // through rapids, cuts, a hold and the ring running dry.
        rig.laser.duty = 700;
        rig.go(10.0, 0.0);
        rig.run();
        rig.cut(10.0, 90.0, 100.0, 0.0);
        rig.advance(500_000);
        rig.front.request_hold();
        rig.advance(1_000_000);
        rig.front.resume(&mut rig.planner);
        rig.run();
        assert_eq!(rig.laser.duty, 700);
        assert!(rig.laser.duties.is_empty(), "the interrupt wrote {:?}", rig.laser.duties);
    }

    #[test]
    fn the_cross_slide_is_stepped_with_the_rail_as_a_fourth_joint() {
        let mut rig = Rig::new(Settings { cartesian: true, ..settings() });
        assert_eq!(
            rig.planner.push([3.0, 0.0, 0.0, -4.0], MoveKind::Cut, Feed::Surface(300.0), 400.0, 0.0, &rig.settings),
            Ok(true)
        );
        let seconds = rig.run();
        assert_eq!(rig.port.count, [768, 0, 0, 1024]);
        assert_eq!(rig.front.position(), [768, 0, 0, -1024]);
        // 5 mm of board at 300 mm/min, plus the ramps.
        assert!((1.0..1.3).contains(&seconds), "{seconds} s");
        rig.position_matches();
    }

    #[test]
    fn reports_follow_the_segment_in_progress() {
        let mut rig = Rig::new(settings());
        rig.go(10.0, 0.0);
        rig.run();
        rig.cut(10.0, 90.0, 100.0, 400.0);
        rig.advance(2_000_000);
        assert!(rig.front.busy());
        assert_eq!(rig.front.duty(), 400);
        let rate = rig.front.surface_rate();
        assert!((rate - 100.0).abs() < 2.0, "{rate}");
        rig.run();
        assert_eq!(rig.front.duty(), 0);
        assert_eq!(rig.front.surface_rate(), 0.0);
    }

    #[test]
    fn collinear_cuts_keep_speed_through_the_junction() {
        let mut rig = Rig::new(settings());
        rig.cut(50.0, 0.0, 600.0, 100.0);
        rig.cut(100.0, 0.0, 600.0, 100.0);
        rig.run();
        let first_block = rig.loads[0].segment.block;
        let boundary = rig.loads.iter().position(|l| l.segment.block != first_block).unwrap();
        let before = rig.loads[boundary - 1].segment.speed;
        let after = rig.loads[boundary].segment.speed;
        assert!((before - 10.0).abs() < 0.2 && (after - 10.0).abs() < 0.2, "{before} {after}");
        assert_eq!(rig.port.count, [25600, 0, 0, 0]);
        rig.check_acceleration();
    }

    #[test]
    fn right_angle_in_joint_space_slows_to_the_jerk_limit() {
        let mut rig = Rig::new(settings());
        rig.cut(50.0, 0.0, 600.0, 100.0);
        rig.cut(50.0, 50.0, 600.0, 100.0);
        rig.run();
        let first_block = rig.loads[0].segment.block;
        let boundary = rig.loads.iter().position(|l| l.segment.block != first_block).unwrap();
        let before = rig.loads[boundary - 1].segment.speed;
        let after = rig.loads[boundary].segment.speed;
        // r_jerk = 3 units/s across the corner; a segment's speed is its
        // average, so the ones next to the corner are within half a
        // segment of acceleration (0.25) of it.
        assert!(before <= 3.3 && before > 2.5, "{before}");
        assert!(after <= 3.3 && after > 2.5, "{after}");
        assert!(rig.max_segment_speed() > 9.5);
        assert_eq!(rig.port.count, [12800, 44444, 0, 0]);
        rig.check_acceleration();
    }

    #[test]
    fn hold_then_resume_completes_the_same_steps() {
        for hold_at_us in [200_000u64, 1_234_567, 2_500_000, 3_000_100, 4_444_444] {
            let mut rig = Rig::new(settings());
            rig.go(20.0, 0.0);
            rig.cut(20.0, 180.0, 300.0, 500.0);
            rig.cut(15.0, 200.0, 300.0, 500.0);
            rig.go(0.0, 0.0);
            let total = rig.pushed_steps();
            rig.advance(hold_at_us);
            assert!(rig.front.busy());
            rig.front.request_hold();
            let mut waited = 0;
            while !rig.front.is_stopped() {
                rig.advance(1_000);
                waited += 1;
                assert!(waited < 2_000, "hold did not stop");
            }
            assert_eq!(rig.laser.duty, 0);
            let stopped = rig.front.position();
            let count = rig.port.count;
            rig.advance(50_000);
            assert_eq!(rig.front.position(), stopped);
            assert_eq!(rig.port.count, count);
            assert!(!rig.front.busy());
            assert!(!rig.planner.is_empty());
            rig.front.resume(&mut rig.planner);
            rig.run();
            assert_eq!(rig.port.count, total, "hold at {hold_at_us}");
            assert_eq!(rig.front.position(), [0, 0, 0, 0]);
            rig.position_matches();
            rig.check_axis_rates();
            rig.check_acceleration();
        }
    }

    #[test]
    fn resume_during_the_ramp_takes_effect_when_stopped() {
        let mut rig = Rig::new(settings());
        rig.go(30.0, 0.0);
        rig.advance(600_000);
        rig.front.request_hold();
        rig.front.resume(&mut rig.planner);
        rig.run();
        assert_eq!(rig.port.count, [7680, 0, 0, 0]);
        assert_eq!(rig.front.position(), [7680, 0, 0, 0]);
        // The ramp down did happen.
        assert!(rig.loads.iter().any(|l| l.segment.speed < 0.6));
    }

    #[test]
    fn hold_while_idle_is_stopped_at_once() {
        let mut rig = Rig::new(settings());
        rig.front.request_hold();
        assert!(rig.front.is_stopped());
        rig.front.resume(&mut rig.planner);
        rig.go(1.0, 0.0);
        rig.run();
        assert_eq!(rig.port.count, [256, 0, 0, 0]);
    }

    #[test]
    fn jog_cancel_flushes_the_rest() {
        let mut rig = Rig::new(settings());
        rig.push(50.0, 0.0, MoveKind::Jog, Feed::Jog, 0.0, 0.0);
        rig.push(50.0, 100.0, MoveKind::Jog, Feed::Jog, 0.0, 0.0);
        assert!(rig.planner.has_jog());
        rig.advance(1_000_000);
        rig.front.request_hold();
        while !rig.front.is_stopped() {
            rig.advance(1_000);
        }
        rig.front.flush(&mut rig.planner);
        rig.planner.clear();
        assert_eq!(rig.planner.position(), rig.front.position());
        assert_eq!(rig.port.count[R] as i32, rig.front.position()[R]);
        assert!(rig.port.count[R] > 0 && rig.port.count[R] < 12800);
        rig.pushed.clear();
        rig.go(0.0, 0.0);
        rig.run();
        assert_eq!(rig.front.position(), [0, 0, 0, 0]);
        assert_eq!(rig.port.count[R], 2 * rig.pushed[0].0[R] as u64);
    }

    #[test]
    fn abort_stops_and_syncs_the_planner() {
        let mut rig = Rig::new(settings());
        rig.go(20.0, 0.0);
        rig.cut(20.0, 180.0, 300.0, 500.0);
        rig.advance(1_500_000);
        rig.front.abort(&mut rig.planner);
        rig.planner.clear();
        assert!(rig.front.abort_pending());
        assert!(rig.front.busy());
        let count_at_abort = rig.port.count;
        rig.advance(20_000);
        assert!(!rig.front.abort_pending());
        assert!(!rig.front.busy());
        assert_eq!(rig.laser.duty, 0);
        assert_eq!(rig.planner.position(), rig.front.position());
        assert_eq!(rig.port.count, [5120, rig.front.position()[A] as u64, 0, 0]);
        // At most the tick in flight after the abort.
        assert!(rig.port.count[A] - count_at_abort[A] <= 1);
        rig.advance(50_000);
        assert_eq!(rig.port.count, [5120, rig.front.position()[A] as u64, 0, 0]);
        let aborted_at = rig.front.position();
        rig.pushed.clear();
        rig.go(0.0, 0.0);
        rig.run();
        assert_eq!(rig.front.position(), [0, 0, 0, 0]);
        assert_eq!(rig.port.count, [5120 * 2, 2 * aborted_at[A] as u64, 0, 0]);
        rig.check_acceleration();
    }

    #[test]
    fn abort_with_segments_queued_but_the_interrupt_idle() {
        let mut rig = Rig::new(settings());
        rig.go(20.0, 0.0);
        // Fill the ring without acting on the kick.
        let prep = rig.front.prep(&mut rig.planner, &rig.settings, rig.mode);
        assert!(prep.kick);
        assert!(!rig.front.producer.is_empty());
        rig.front.abort(&mut rig.planner);
        rig.planner.clear();
        assert!(rig.front.abort_pending());
        // The next prep asks for the kick again; the interrupt then empties the ring.
        rig.poll();
        assert!(rig.next_tick.is_some());
        rig.advance(1_000);
        assert!(!rig.front.abort_pending());
        assert!(rig.front.producer.is_empty());
        assert_eq!(rig.port.count, [0, 0, 0, 0]);
        assert_eq!(rig.planner.position(), [0, 0, 0, 0]);
        assert!(!rig.front.busy());
        rig.pushed.clear();
        rig.go(1.0, 0.0);
        rig.run();
        assert_eq!(rig.port.count, [256, 0, 0, 0]);
    }

    #[test]
    fn abort_while_idle_needs_no_interrupt() {
        let mut rig = Rig::new(settings());
        rig.go(1.0, 0.0);
        rig.run();
        rig.planner.set_position([5, 5, 0, 0]);
        rig.front.abort(&mut rig.planner);
        assert!(!rig.front.abort_pending());
        assert_eq!(rig.planner.position(), [256, 0, 0, 0]);
    }

    #[test]
    fn turn_on_the_axis_uses_max_rate_with_the_laser_off() {
        let mut rig = Rig::new(settings());
        rig.cut(0.0, 180.0, 100.0, 500.0);
        let seconds = rig.run();
        assert_eq!(rig.port.count, [0, 160000, 0, 0]);
        assert_eq!(rig.max_duty(), 0);
        assert!(rig.laser.duties.iter().all(|&(_, d)| d == 0));
        assert!((rig.max_segment_speed() - 18.0).abs() < 0.01);
        assert!((seconds - (10.0 + 0.36)).abs() < 0.1, "{seconds}");
        rig.check_axis_rates();
    }

    #[test]
    fn laser_invert_inverts_the_duty() {
        let mut rig = Rig::new(settings());
        rig.settings.laser_invert = true;
        rig.cut(10.0, 0.0, 600.0, 200.0);
        rig.advance(600_000);
        assert_eq!(rig.laser.duty, 800);
        assert_eq!(rig.front.duty(), 800);
        rig.run();
        assert_eq!(rig.laser.duty, 1000);
        assert_eq!(rig.front.duty(), 1000);
        assert!(rig.loads.iter().all(|l| l.segment.duty >= 800));
        // Constant mode: full S while moving.
        rig.mode = PowerMode::Constant;
        rig.loads.clear();
        rig.cut(20.0, 0.0, 600.0, 200.0);
        rig.run();
        assert!(rig.loads.iter().all(|l| l.segment.duty == 800));
    }

    #[test]
    fn s_min_zeroes_low_power() {
        let mut rig = Rig::new(settings());
        rig.settings.s_min = 300.0;
        rig.cut(10.0, 0.0, 600.0, 400.0);
        rig.run();
        let duties: Vec<u16> = rig.loads.iter().map(|l| l.segment.duty).collect();
        assert_eq!(duties[0], 0);
        assert!(duties.contains(&400));
        assert!(duties.iter().all(|&d| d == 0 || d >= 300), "{duties:?}");
        // Without s_min the ramp has low duties.
        let mut rig = Rig::new(settings());
        rig.cut(10.0, 0.0, 600.0, 400.0);
        rig.run();
        assert!(rig.loads.iter().any(|l| l.segment.duty > 0 && l.segment.duty < 300));
        // Constant mode ignores the speed.
        let mut rig = Rig::new(settings());
        rig.mode = PowerMode::Constant;
        rig.cut(10.0, 0.0, 600.0, 400.0);
        rig.run();
        assert!(rig.loads.iter().all(|l| l.segment.duty == 400));
        // A rapid never fires.
        let mut rig = Rig::new(settings());
        rig.go(10.0, 0.0);
        rig.run();
        assert_eq!(rig.max_duty(), 0);
    }

    #[test]
    fn min_power_floors_the_dynamic_ramp() {
        let mut rig = Rig::new(settings());
        rig.cut_with_floor(10.0, 0.0, 600.0, 400.0, 150.0);
        rig.run();
        let duties: Vec<u16> = rig.loads.iter().filter(|l| l.segment.ticks > 0).map(|l| l.segment.duty).collect();
        assert!(duties.contains(&400));
        assert!(duties.iter().all(|&d| (150..=400).contains(&d)), "{duties:?}");
        assert!(duties.contains(&150), "the ramp ends reach the floor: {duties:?}");
        // `s_min` above the floor still turns the slow ends off.
        let mut rig = Rig::new(settings());
        rig.settings.s_min = 300.0;
        rig.cut_with_floor(10.0, 0.0, 600.0, 400.0, 150.0);
        rig.run();
        assert!(rig.loads.iter().all(|l| l.segment.duty == 0 || l.segment.duty >= 300));
        // Constant mode is already at S.
        let mut rig = Rig::new(settings());
        rig.mode = PowerMode::Constant;
        rig.cut_with_floor(10.0, 0.0, 600.0, 400.0, 150.0);
        rig.run();
        assert!(rig.loads.iter().all(|l| l.segment.duty == 400));
    }

    #[test]
    fn amass_spreads_a_slow_minor_axis() {
        let mut rig = Rig::new(settings());
        rig.go(10.0, 0.0);
        rig.run();
        rig.port.record = true;
        rig.loads.clear();
        // 13 radius steps against 8889 table steps at about 2500 events/s.
        rig.cut(10.05, 10.0, 30.0, 0.0);
        let seconds = rig.run();
        assert_eq!(rig.port.count, [2560 + 13, 88889 - 80000, 0, 0]);
        let cruise: Vec<&Loaded> = rig.loads.iter().filter(|l| l.segment.speed > rig.max_segment_speed() * 0.999).collect();
        assert!(cruise.len() > 10);
        let period = cruise[0].segment.period_us;
        let period_q8 = period as u64 * 256 + cruise[0].segment.period_frac as u64;
        for load in &cruise {
            assert_eq!(load.segment.amass, 1, "{load:?}");
            assert_eq!(load.segment.period_us, period);
            assert_eq!(load.segment.period_frac, cruise[0].segment.period_frac);
            let tick_rate = 1.0e6 / period as f32;
            assert!(tick_rate >= AMASS_TARGET_HZ * 0.99 && tick_rate < 2.0 * AMASS_TARGET_HZ);
        }
        let start = (seconds * 0.25e6) as u64 + rig.loads[0].at;
        let end = (seconds * 0.75e6) as u64 + rig.loads[0].at;
        let radius: Vec<u64> =
            rig.port.pulses.iter().filter(|&&(t, m)| m & (1 << R) != 0 && t >= start && t <= end).map(|&(t, _)| t).collect();
        assert!(radius.len() >= 4, "{}", radius.len());
        let gaps: Vec<u64> = radius.windows(2).map(|w| w[1] - w[0]).collect();
        let (min, max) = (gaps.iter().min().unwrap(), gaps.iter().max().unwrap());
        // One tick period, plus the microsecond the fraction carry may add.
        assert!(max - min <= period as u64 + 2, "gaps {gaps:?} period {period}");
        let ticks: Vec<u64> = gaps.iter().map(|g| (g * 256 + period_q8 / 2) / period_q8).collect();
        assert!(ticks.iter().max().unwrap() - ticks.iter().min().unwrap() <= 1, "tick gaps {ticks:?}");
        // Without subdivision the gap would only be a whole event: two ticks.
        assert!(*max as f64 / period as f64 > 1000.0);
    }

    #[test]
    fn amass_levels_follow_the_rate() {
        let t = |amass, period_us, period_frac, events| Timing { amass, period_us, period_frac, events };
        assert_eq!(timing(16000.0, 160, MIN_TICK_US), t(0, 62, 128, 160));
        assert_eq!(timing(3000.0, 30, MIN_TICK_US), t(1, 166, 171, 30));
        assert_eq!(timing(1500.0, 15, MIN_TICK_US), t(2, 166, 171, 15));
        assert_eq!(timing(100.0, 1, MIN_TICK_US), t(3, 1250, 0, 1));
        assert_eq!(timing(0.0, 1, MIN_TICK_US), t(3, 62500, 0, 1));
        // A tick rate above the timer's floor is held at the floor.
        assert_eq!(timing(200_000.0, 2000, MIN_TICK_US), t(0, MIN_TICK_US, 0, 2000));
        assert_eq!(timing(200_000.0, 2000, 33), t(0, 33, 0, 2000));
        // Too many ticks for a segment cut the events down.
        assert_eq!(timing(50.0, 100_000, MIN_TICK_US), t(3, 2500, 0, 8191));
    }

    #[test]
    fn the_tick_floor_follows_the_step_pulse_width() {
        // A pulse of up to 4 us fits the 10 us tick; longer ones stretch it.
        assert_eq!(crate::min_tick_us(1), MIN_TICK_US);
        assert_eq!(crate::min_tick_us(2), MIN_TICK_US);
        assert_eq!(crate::min_tick_us(4), MIN_TICK_US);
        assert_eq!(crate::min_tick_us(5), 11);
        assert_eq!(crate::min_tick_us(10), 18);
        assert_eq!(crate::min_tick_us(20), 33);
        assert!((crate::max_event_rate_hz(2) - MAX_EVENT_RATE_HZ).abs() < 1e-3);
        // The planner's ceiling follows it, so a wide pulse slows the
        // plan rather than the interrupt: the duty then matches the speed.
        let wide = Settings {
            steps: [10240.0, 14222.222, 256.0, 10240.0],
            max_rate: [5000.0, 5000.0, 600.0, 5000.0],
            accel: [500.0, 500.0, 500.0, 500.0],
            step_us: 20,
            ..settings()
        };
        let ceiling = crate::max_event_rate_hz(20) * 60.0 / 10240.0;
        assert!((crate::planner::effective_max_rate(&wide)[R] - ceiling).abs() < 0.01, "{ceiling}");
        let mut rig = Rig::new(wide);
        rig.cut(2.0, 0.0, 3000.0, 500.0);
        rig.run();
        rig.check_axis_rates();
        for segment in &rig.loads {
            assert!(segment.segment.period_us >= 33, "a tick of {} us at a 20 us pulse", segment.segment.period_us);
        }
        rig.position_matches();
    }

    #[test]
    fn fractional_periods_average_out() {
        let mut rig = Rig::new(settings());
        rig.go(0.0, 90.0);
        rig.run();
        // 18 deg/s is 16000 events/s: 62.5 us, so the ticks alternate 62 and 63.
        let top = rig.max_segment_speed();
        let cruise: Vec<&Loaded> = rig.loads.iter().filter(|l| l.segment.speed >= top * 0.9999).collect();
        assert!(cruise.len() > 100);
        assert!(cruise.iter().all(|l| l.segment.period_us == 62 && l.segment.period_frac == 128));
        let mut rig = Rig::new(settings());
        rig.port.record = true;
        rig.go(0.0, 30.0);
        rig.run();
        let times: Vec<u64> = rig.port.pulses.iter().map(|&(t, _)| t).collect();
        let middle = &times[times.len() / 3..2 * times.len() / 3];
        let gaps: Vec<u64> = middle.windows(2).map(|w| w[1] - w[0]).collect();
        assert!(gaps.iter().all(|&g| g == 62 || g == 63), "{gaps:?}");
        assert!(gaps.contains(&62) && gaps.contains(&63));
    }

    #[test]
    fn slots_are_recycled_only_when_free() {
        // Many tiny blocks: each is one or two segments, so the four slots
        // turn over constantly. The front asserts on every slot write.
        let mut rig = Rig::new(settings());
        for i in 1..=BLOCKS_IN_TEST {
            rig.cut(i as f32 * 0.05, 0.0, 600.0, 100.0);
        }
        rig.run();
        assert_eq!(rig.port.count, [(BLOCKS_IN_TEST as f32 * 0.05 * 256.0) as u64, 0, 0, 0]);
        assert_eq!(rig.executed_blocks(), rig.pushed);
        // Every segment was executed against the block it was written for.
        let mut expected = rig.pushed.iter();
        let mut current = expected.next().unwrap();
        let mut slot = rig.loads[0].segment.block;
        for load in &rig.loads {
            if load.segment.block != slot {
                slot = load.segment.block;
                current = expected.next().unwrap();
            }
            assert_eq!((load.block.steps, load.block.dir_forward), *current);
        }
        rig.check_acceleration();
    }

    const BLOCKS_IN_TEST: usize = 24;

    #[test]
    fn ring_capacity_limits_the_lookahead() {
        let mut rig = Rig::new(settings());
        rig.go(100.0, 0.0);
        let prep = rig.front.prep(&mut rig.planner, &rig.settings, rig.mode);
        assert!(prep.kick);
        assert_eq!(rig.front.producer.len(), SEGMENTS - 1);
        let prep = rig.front.prep(&mut rig.planner, &rig.settings, rig.mode);
        assert!(!prep.kick);
        assert!(rig.front.busy());
        rig.next_tick = Some(rig.now);
        rig.run();
        assert_eq!(rig.port.count, [25600, 0, 0, 0]);
    }

    #[test]
    fn negative_moves_count_down() {
        let mut rig = Rig::new(settings());
        rig.planner.set_position([2560, 88889, 0, 0]);
        rig.shared().position[R].store(2560, Ordering::Relaxed);
        rig.shared().position[A].store(88889, Ordering::Relaxed);
        rig.go(5.0, -50.0);
        rig.run();
        assert_eq!(rig.front.position(), [1280, -44444, 0, 0]);
        assert_eq!(rig.port.count, [1280, 88889 + 44444, 0, 0]);
        assert_eq!(rig.port.dirs, std::vec![0]);
    }

    #[test]
    fn the_longest_allowed_block_keeps_the_counters_in_range() {
        let mut rig = Rig::new(settings());
        // `MAX_EVENTS` events with a minor axis almost as long: the shifted
        // counter peaks just short of a full u32 here, so one event more
        // would wrap it.
        let a = MAX_EVENTS as f32 / settings().steps[A];
        let r = 0.99 * MAX_EVENTS as f32 / settings().steps[R];
        rig.go(r, a);
        let block = *rig.planner.current().unwrap();
        assert!(block.step_event_count <= MAX_EVENTS, "{}", block.step_event_count);
        assert!(block.step_event_count > MAX_EVENTS - 1024, "{}", block.step_event_count);
        assert!(block.steps[R] > block.steps[A] / 2);
        // A couple of seconds of the block is enough to reach full speed,
        // where the subdivision is off and the counter increments are largest.
        rig.advance(2_000_000);
        assert!(rig.port.count[R] > 0 && rig.port.count[A] > 0);
        assert_eq!(rig.front.position()[A] as u64, rig.port.count[A]);
        rig.check_axis_rates();
    }
}
