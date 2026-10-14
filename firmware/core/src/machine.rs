//! The controller: command execution, state, holds and resets, the laser.
//!
//! One `Machine` per controller. The main loop hands it lines through
//! `submit`, realtime actions through `realtime`, and calls `poll` often
//! (every millisecond or so) with the current time. All output goes to
//! the `Sink` passed in: exactly one `ok` or `error:` per line.
//!
//! Immediate commands (`version`, `status`, `help`, `unlock`, and the `$`
//! family except `$save` and `$load`) answer from `submit`. Everything
//! else becomes the one pending request that `poll` completes: a motion
//! line once the planner has room, a sync command (`dwell`, `mode`,
//! `laser`, `set`, `enable`, `disable`) once queued motion is done, and
//! `$save`/`$load` at the next `poll`, where the store is. While a request
//! is pending `ready_for_line` is false and the caller keeps the next line
//! waiting; a dwell stays pending until its time is up, so nothing runs
//! during it.
//!
//! State machine: `Idle` -> `Run` (a `go`/`cut` queued, or a dwell) or
//! `Jog` (a jog queued); `Run`/`Jog` -> `Hold` on `!`; `Hold` -> `Run`/`Jog`
//! on `~`; `Jog` -> `Idle` on jog cancel after the decel; any -> `Alarm` on
//! a reset while moving; `Alarm` -> `Idle` on `unlock`. Motion states
//! return to `Idle` when the planner and the stepper are both drained.
//!
//! The laser port is written from here only for the constant beam (`laser
//! S T`, `dwell` with `S`) and to force it off on hold, reset, disconnect
//! and at the end of motion; during motion the step interrupt drives it
//! per segment.
//!
//! A `probe` is a pending command too: it waits for the motion queued
//! before it, like a dwell, then runs as a jog of the focus axis whose
//! block watches the probe input, and it stays pending until it ends, so
//! nothing runs behind it. At contact the interrupt latches the position,
//! `poll` brakes (or, with `probe_ms` 0 and a probe slow enough, the
//! interrupt has already stopped the axis dead), and the line is answered
//! with `[PRB:h:1]` and `ok` once the head has stopped. A probe that goes its whole distance without
//! contact raises `Alarm:2` and is answered `error:11`: the head is lower
//! than whoever sent it thinks, and whatever they sent next would move it
//! across the board. A jog cancel ends it with `[PRB:h:0]` and `ok`.
//!
//! A `home` is pending the same way and runs from `Idle` only, in the
//! `Home` state, one joint at a time in the order H, R, Z, A. Each joint
//! goes through a cycle `poll_home` drives: a switch closed at the start
//! is backed off, then the seek at the jog rate toward the switch with
//! the block watching it (`MoveKind::Home`), a brake at the contact as a
//! probe brakes, the position declared so the contact reads `home_pos`
//! (or `home_pos + home_travel` at the positive end of a two-ended axis),
//! a back-off by `home_pull`, a slow locate for the exact contact, the
//! declaration again, and the final move off the switch by the pull-off.
//! The cross slide of a polar machine is homed the same way on its own
//! `Slide`, its contact read by the main loop. Each joint done prints
//! `[HOME:<letter>:<position>:1]`; the line ends `ok` when every joint
//! is done. A hold or a jog cancel brakes the home and ends it with
//! `[HOME:..:0]` and `ok`; a switch not found within the travel is
//! `Alarm:5` and `error:13`, and a switch that stays closed through the
//! first back-off is `error:12`, nothing moved further.
//!
//! An endstop in `limits` closing under any other motion is a halt in the
//! interrupt (`stepper`), seen here as `Front::limit_hit`, or for the
//! polar cross slide read here and debounced the same way; either is
//! treated as a reset while moving, with `Alarm:4` and every axis unhomed.
//!
//! The cross slide is a pending command like any other, but it runs on
//! its own `Slide` rather than through the planner: it is taken only from
//! `Idle`, holds the state at `Jog` until it stops, and is stepped by
//! `poll_slide` from the main loop. A jog cancel brakes it, a reset or a
//! disconnect drops it.
//!
//! With the `cartesian` setting the cross slide is the fourth joint
//! instead: `Z` words go to the planner with the others, the radius is X
//! and the slide Y, and `A` stays off `go` and `cut` so the table holds
//! the board still under them. Switching hands the position over between
//! `Slide` and the joints, so the slide stays where it was either way.
//!
//! With the `spindle` setting the laser output drives a spindle. `spindle
//! S` and `spindle off` are sync commands like `laser`, and the output
//! then stays at that speed through moves, jogs, dwells and holds; only
//! `spindle off`, `laser off`, a reset, a disconnect or an alarm stop it.
//! `S` and `M` on a `cut` or a `dwell`, and a lit `laser`, are refused.

use crate::hal::{LaserPort, Sink, SlidePort, StepPort, Store};
use crate::math;
use crate::parser::{self, Command, Error, PowerMode, Realtime};
use crate::planner::{Feed, MoveKind, PlanError, Planner};
use crate::report::{self, State, Status};
use crate::settings::{Changed, SetError, Settings, BLOB_LEN};
use crate::slide::Slide;
use crate::stepper::{self, Front};
use crate::{A, AXES, H, LINE_MAX, LINE_SLOTS, R, Z};

/// Things the port loop must act on after a `poll`. Taken with `take_events`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Events {
    /// A `tmc_*` setting changed or settings were loaded: reconfigure the drivers.
    pub driver_config: bool,
    /// `$tmc` was asked for: print the driver status.
    pub driver_report: bool,
}

/// The line whose answer comes from a later `poll`.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Pending {
    None,
    /// Waits for planner room, and for a hold to end.
    Motion { target: [f32; AXES], kind: MoveKind, feed: Feed, power: f32, min_power: f32 },
    /// A cross slide move, started once the joints have come to rest.
    SlideMove { target: f32, feed: Option<f32> },
    /// The sync commands below wait for queued motion to finish.
    Dwell { ms: u32, power: Option<f32> },
    /// A dwell in progress; answered when its time is up.
    Dwelling,
    /// A probe, started once queued motion is done: the focus axis moves
    /// by up to `distance` mm at `feed` mm/min.
    Probe { distance: f32, feed: f32 },
    /// A probe in progress; answered when it ends.
    Probing,
    /// A home, started once queued motion is done: the joints in `axes`,
    /// those in `positive` toward their positive end.
    Home { axes: u8, positive: u8 },
    /// A home in progress; answered when it ends.
    Homing,
    Mode(PowerMode),
    LaserOn { power: f32, ms: Option<u32> },
    LaserOff,
    /// The spindle at `S`, or stopped.
    Spindle(Option<f32>),
    SetPosition([Option<f32>; AXES]),
    SetSlide(f32),
    Enable(bool),
    /// Store access happens in `poll`, where the store is.
    Save,
    Load,
}

/// A `home` under way: which joints are still to do, which end each goes
/// to, and where the one being homed is in its cycle.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Homing {
    /// Joints still to home, bit per joint, the one under way included.
    axes: u8,
    /// Joints that go to their positive end.
    positive: u8,
    /// The joint under way.
    joint: usize,
    phase: HomePhase,
    /// The joint's position at the contact the seek or the locate met:
    /// in steps for a joint the stepper moves, in mm for the polar cross
    /// slide.
    contact_steps: i32,
    contact_mm: f32,
}

/// The cycle of one joint's home, in order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HomePhase {
    /// Backing off a switch that was closed at the start, by the pull-off.
    Clear,
    /// Seeking the switch at the jog rate.
    Seek,
    /// Braking after the seek's contact.
    SeekBrake,
    /// Backing off the switch by the pull-off.
    Back,
    /// Approaching the switch again, slowly.
    Locate,
    /// Braking after the locate's contact.
    LocateBrake,
    /// Leaving the switch by the pull-off, where the joint ends.
    Off,
}

/// How a home ends short of every joint done.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HomeEnd {
    /// A hold or a jog cancel.
    Canceled,
    /// The switch stayed closed through the first back-off.
    StopActive,
    /// A move of the cycle does not fit the step counters.
    OutOfRange,
    /// No contact within the travel.
    Missed,
}

/// The order a `home` of several joints takes them in: the head up first,
/// then the rail, the cross slide and the table.
const HOME_ORDER: [usize; AXES] = [H, R, Z, A];
/// The locate runs this much slower than the seek, which runs at the
/// joint's jog rate.
const HOME_LOCATE_DIVISOR: f32 = 10.0;
/// The seek goes this much further than `home_travel`, plus the pull-off.
const HOME_SEEK_MARGIN: f32 = 1.1;

pub struct Machine<'a> {
    front: Front<'a>,
    planner: Planner,
    /// The cross slide, which only ever moves on its own.
    slide: Slide,
    settings: Settings,
    state: State,
    mode: PowerMode,
    /// Motor enable as driven.
    enabled: bool,
    pending: Pending,
    /// Modal `cut` words since the last reset.
    feed: Option<f32>,
    power: f32,
    /// The state a hold returns to.
    held: State,
    /// Deadline of the dwell in progress; `None` while held, with the
    /// time left kept in `dwell_left_us`.
    dwell_until: Option<u64>,
    dwell_left_us: u64,
    /// `S` of the dwell in progress.
    dwell_power: Option<f32>,
    /// Constant beam from the `laser` command: its `S` and deadline.
    beam: Option<f32>,
    beam_until: u64,
    /// `S` of the spindle while it runs, under the `spindle` setting.
    spindle: Option<f32>,
    /// A jog cancel is waiting for the stepper to stop.
    jog_cancel: bool,
    /// A probe met contact and is braking.
    probe_braking: bool,
    /// The probe in progress stops dead at contact instead of braking.
    probe_halting: bool,
    /// The probe input is active, as of the last `poll`.
    probe_active: bool,
    /// The endstops that are closed, bit per joint, as of the last `poll`.
    stops_closed: u8,
    /// The `home` under way.
    homing: Option<Homing>,
    /// A hold or a jog cancel is braking the home.
    home_cancel: bool,
    /// Joints homed since the position was last lost, bit per joint.
    homed: u8,
    /// When the polar cross slide's endstop was first seen closed under a
    /// move it may halt, for the debounce; `None` while open.
    slide_limit_since: Option<u64>,
    /// The cross slide's endstop was closed when its move started: no
    /// halt until it has opened.
    slide_limit_ignore: bool,
    /// A hold asked for while idle with a motion line taken in or still
    /// waiting: it is applied the moment that line starts.
    hold_latched: bool,
    /// Laser frequency and constant duty to re-apply at the next `poll`.
    apply_laser: bool,
    /// Enable pin level to re-apply at the next `poll`.
    apply_enable: bool,
    /// Level last driven on the tool output; `None` before the first, and
    /// again when the laser settings, which carry its polarity, change.
    tool_driven: Option<bool>,
    /// When `Idle` was entered, for the idle disable.
    idle_since: u64,
    /// Time of the last `poll`.
    now: u64,
    /// Lines the port holds behind the one pending here, for the status
    /// line's count of free line slots.
    lines_waiting: usize,
    events: Events,
}

impl<'a> Machine<'a> {
    pub fn new(front: Front<'a>, settings: Settings) -> Self {
        Machine {
            front,
            planner: Planner::new(),
            slide: Slide::new(),
            settings,
            state: State::Idle,
            mode: PowerMode::Dynamic,
            enabled: false,
            pending: Pending::None,
            feed: None,
            power: 0.0,
            held: State::Run,
            dwell_until: None,
            dwell_left_us: 0,
            dwell_power: None,
            beam: None,
            beam_until: 0,
            spindle: None,
            jog_cancel: false,
            probe_braking: false,
            probe_halting: false,
            probe_active: false,
            stops_closed: 0,
            homing: None,
            home_cancel: false,
            homed: 0,
            slide_limit_since: None,
            slide_limit_ignore: false,
            hold_latched: false,
            apply_laser: true,
            apply_enable: true,
            tool_driven: None,
            idle_since: 0,
            now: 0,
            lines_waiting: 0,
            events: Events::default(),
        }
    }

    /// How many lines the port holds that it has not yet handed over; the
    /// status line reports the credits left to the host from it. Called by
    /// the port loop before each `poll`.
    pub fn note_lines_waiting(&mut self, count: usize) {
        self.lines_waiting = count;
    }

    pub fn settings(&self) -> &Settings {
        &self.settings
    }

    pub fn state(&self) -> State {
        self.state
    }

    pub fn mode(&self) -> PowerMode {
        self.mode
    }

    /// Executed joint position in units. The cross slide's entry is where
    /// the slide is, whichever of `Slide` and the joints moves it.
    pub fn joint(&self) -> [f32; AXES] {
        let steps = self.front.position();
        let mut units = [0f32; AXES];
        for i in 0..AXES {
            units[i] = math::steps_to_units(steps[i], self.settings.steps[i]);
        }
        if !self.settings.cartesian {
            units[Z] = self.slide.position();
        }
        units
    }

    /// Planned end position in steps: where the next motion starts from.
    pub fn planned_position(&self) -> [i32; AXES] {
        self.planner.position()
    }

    /// Cross slide position in mm.
    pub fn slide_position(&self) -> f32 {
        self.joint()[Z]
    }

    /// Steps the cross slide. It is driven from the main loop rather than
    /// from the step interrupt, because nothing is tied to its timing;
    /// the returned time is when it would like the next call, and a
    /// caller on a fixed period may simply ignore it. Call it before
    /// `poll`, which ends the jog once the slide has stopped.
    pub fn poll_slide(&mut self, now_us: u64, port: &mut impl SlidePort) -> Option<u64> {
        self.slide.poll(now_us, port)
    }

    /// No line is waiting for planner space; `submit` may be called.
    pub fn ready_for_line(&self) -> bool {
        self.pending == Pending::None
    }

    /// Nothing is in progress or timed: `Idle` or `Alarm` with no line
    /// pending, the stepper idle, no constant beam and no idle disable
    /// timer running. A host simulation may wait for input instead of
    /// advancing time.
    pub fn is_quiet(&self) -> bool {
        self.is_settled() && self.beam.is_none() && !(self.enabled && self.settings.idle_ms > 0)
    }

    /// Nothing moves or waits: `Idle` or `Alarm` with no line pending, the
    /// stepper idle and in sync, the slide still. Unlike `is_quiet` this
    /// ignores a constant beam and the idle disable timer, which only need
    /// the clock to run on.
    pub fn is_settled(&self) -> bool {
        matches!(self.state, State::Idle | State::Alarm(_))
            && self.pending == Pending::None
            && !self.front.busy()
            && !self.front.resync_pending()
            && !self.slide.busy()
    }

    /// Parses and starts executing one line. Immediate commands answer
    /// now; motion that needs planner space answers from a later `poll`.
    /// The caller checks `ready_for_line` first.
    pub fn submit(&mut self, line: &str, out: &mut impl Sink) {
        if line.len() > LINE_MAX - 1 {
            report::error(Error::TooLong, out);
            return;
        }
        let body = line.find(';').map_or(line, |at| &line[..at]).trim();
        if body.is_empty() {
            report::ok(out);
            return;
        }
        let command = match parser::parse(line) {
            Ok(command) => command,
            Err(error) => {
                report::error(error, out);
                return;
            }
        };
        match self.execute(command, out) {
            Ok(true) => report::ok(out),
            Ok(false) => {}
            Err(error) => report::error(error, out),
        }
    }

    /// Runs an immediate command or makes the line pending. `Ok(true)`
    /// when it is answered now.
    fn execute(&mut self, command: Command, out: &mut impl Sink) -> Result<bool, Error> {
        match command {
            Command::Go { target } => {
                self.check_board_words(&target)?;
                self.check_motion_state(false)?;
                self.queue_motion(target, false, MoveKind::Rapid, Feed::Max, 0.0, 0.0)?;
                Ok(false)
            }
            Command::Cut { target, feed, power, min_power } => {
                self.check_board_words(&target)?;
                // A spindle's speed is its own command's: an `S` here is a
                // laser job sent to a machine that has none.
                if self.settings.spindle && (power.is_some() || min_power.is_some()) {
                    return Err(Error::BadWord);
                }
                self.check_motion_state(false)?;
                // A cut drags the tool through the work: with the spindle
                // stopped under a job (a `spindle off` or `laser off` from a
                // console, a speed of 0) the job ends at its next cut.
                if self.settings.spindle && !self.spindle.is_some_and(|speed| speed > 0.0) {
                    return Err(Error::State);
                }
                let feed = feed.or(self.feed).ok_or(Error::MissingWord)?;
                // `M` is not modal: a cut without it has no floor.
                let min_power = min_power.unwrap_or(0.0);
                let power = if self.settings.spindle { 0.0 } else { power.unwrap_or(self.power) };
                self.queue_motion(target, false, MoveKind::Cut, Feed::Surface(feed), power, min_power)?;
                self.feed = Some(feed);
                if !self.settings.spindle {
                    self.power = power;
                }
                Ok(false)
            }
            Command::Jog { target, feed, absolute } if target[Z].is_some() && !self.settings.cartesian => {
                // The slide moves alone and only from rest: it shares the
                // rail with a cut in progress and would move it.
                if target[R].is_some() || target[A].is_some() || target[H].is_some() {
                    return Err(Error::BadWord);
                }
                self.require_idle()?;
                let target = target[Z].unwrap_or(0.0);
                // The slide has no zero to stay on the far side of, so an
                // absolute Z is as free as a relative one.
                let target = if absolute { target } else { self.slide.position() + target };
                if !math::fits_steps(target, self.settings.steps[Z]) || self.past_z_max(target) {
                    return Err(Error::OutOfRange);
                }
                self.pending = Pending::SlideMove { target, feed };
                Ok(false)
            }
            Command::Jog { target, feed, absolute } => {
                self.check_motion_state(true)?;
                let feed = feed.map_or(Feed::Jog, Feed::Surface);
                self.queue_motion(target, !absolute, MoveKind::Jog, feed, 0.0, 0.0)?;
                Ok(false)
            }
            Command::SetPosition { value } if value[Z].is_some() && !self.settings.cartesian => {
                if value[R].is_some() || value[A].is_some() || value[H].is_some() {
                    return Err(Error::BadWord);
                }
                self.require_idle()?;
                let value = value[Z].unwrap_or(0.0);
                if !math::fits_steps(value, self.settings.steps[Z]) {
                    return Err(Error::OutOfRange);
                }
                self.pending = Pending::SetSlide(value);
                Ok(false)
            }
            Command::Probe { distance, feed } => {
                if !self.settings.h_axis {
                    return Err(Error::BadWord);
                }
                // A probe is a setup move that waits for what was queued
                // before it, so a host may send it behind a positioning
                // move, and through a hold of that move, which it waits
                // out like the move itself.
                if self.slide.busy() || self.jog_cancel || !matches!(self.state, State::Idle | State::Run | State::Jog | State::Hold) {
                    return Err(Error::State);
                }
                let feed = feed.unwrap_or(self.settings.jog_rate[H]);
                self.pending = Pending::Probe { distance, feed };
                Ok(false)
            }
            Command::Home { axes, positive, negative } => {
                // A focus axis that is not fitted has no switch to seek.
                let fitted = if self.settings.h_axis { 0b1111 } else { 0b1111 & !(1 << H) };
                let axes = if axes == 0 { self.settings.stop_mask() & fitted } else { axes };
                if axes == 0 || axes & !fitted != 0 || axes & !self.settings.stop_mask() != 0 {
                    return Err(Error::BadWord);
                }
                let mut ends = 0u8;
                for joint in 0..AXES {
                    let bit = 1 << joint;
                    if axes & bit == 0 {
                        continue;
                    }
                    // Unsigned, a joint goes to its only switch, or the
                    // negative one of two.
                    let to_max = if positive & bit != 0 {
                        true
                    } else if negative & bit != 0 {
                        false
                    } else {
                        !self.settings.has_min_stop(joint)
                    };
                    let there = if to_max { self.settings.has_max_stop(joint) } else { self.settings.has_min_stop(joint) };
                    if !there {
                        return Err(Error::BadWord);
                    }
                    if to_max {
                        ends |= bit;
                    }
                }
                self.require_idle()?;
                if self.slide.busy() || self.jog_cancel {
                    return Err(Error::State);
                }
                self.pending = Pending::Home { axes, positive: ends };
                Ok(false)
            }
            Command::Dwell { ms, power } => {
                if self.settings.spindle && power.is_some() {
                    return Err(Error::BadWord);
                }
                self.check_motion_state(false)?;
                self.pending = Pending::Dwell { ms, power };
                Ok(false)
            }
            Command::Mode(mode) => {
                self.pending = Pending::Mode(mode);
                Ok(false)
            }
            Command::LaserOn { power, ms } => {
                if self.settings.spindle {
                    return Err(Error::BadWord);
                }
                self.require_idle()?;
                self.pending = Pending::LaserOn { power, ms };
                Ok(false)
            }
            Command::LaserOff => {
                self.pending = Pending::LaserOff;
                Ok(false)
            }
            Command::SpindleOn { power } => {
                if !self.settings.spindle {
                    return Err(Error::BadWord);
                }
                // Started where a move would be: from rest or in a run,
                // and taken in during a hold of a run to start after it.
                self.check_motion_state(false)?;
                self.pending = Pending::Spindle(Some(power));
                Ok(false)
            }
            Command::SpindleOff => {
                if !self.settings.spindle {
                    return Err(Error::BadWord);
                }
                self.pending = Pending::Spindle(None);
                Ok(false)
            }
            Command::SetPosition { value } => {
                self.require_idle()?;
                if value[H].is_some() && !self.settings.h_axis {
                    return Err(Error::BadWord);
                }
                for i in 0..AXES {
                    if value[i].is_some_and(|units| !math::fits_steps(units, self.settings.steps[i])) {
                        return Err(Error::OutOfRange);
                    }
                }
                self.pending = Pending::SetPosition(value);
                Ok(false)
            }
            Command::Enable(on) => {
                if !on {
                    self.require_idle()?;
                }
                self.pending = Pending::Enable(on);
                Ok(false)
            }
            Command::Unlock => {
                if !matches!(self.state, State::Alarm(_)) {
                    return Err(Error::State);
                }
                self.state = State::Idle;
                self.idle_since = self.now;
                Ok(true)
            }
            Command::Version => {
                report::banner(out);
                Ok(true)
            }
            Command::Status => {
                report::status(&self.status(), out);
                Ok(true)
            }
            Command::Help => {
                out.write_str(HELP);
                Ok(true)
            }
            Command::SettingsList => {
                self.settings.format_all(out);
                Ok(true)
            }
            Command::SettingGet(name) => {
                if !self.settings.format(name, out) {
                    return Err(Error::UnknownSetting);
                }
                Ok(true)
            }
            Command::SettingSet(name, value) => {
                self.require_idle()?;
                let was_cartesian = self.settings.cartesian;
                let was_spindle = self.settings.spindle;
                let slide_at = self.joint()[Z];
                let changed = self.settings.set(name, value).map_err(|error| match error {
                    SetError::Unknown => Error::UnknownSetting,
                    SetError::BadValue => Error::BadSettingValue,
                })?;
                match changed {
                    Changed::Motion => self.apply_enable = true,
                    Changed::Laser => self.apply_laser = true,
                    Changed::Driver => self.events.driver_config = true,
                    Changed::Kinematics => self.hand_over_cross_slide(was_cartesian, slide_at),
                    Changed::Tool if was_spindle != self.settings.spindle => self.stop_output(),
                    Changed::Tool => {}
                    Changed::Other => {}
                }
                Ok(true)
            }
            Command::SettingsSave => {
                self.require_idle()?;
                self.pending = Pending::Save;
                Ok(false)
            }
            Command::SettingsLoad => {
                self.require_idle()?;
                self.pending = Pending::Load;
                Ok(false)
            }
            Command::SettingsDefaults => {
                self.require_idle()?;
                // The polarities, the socket map and the pins describe the
                // wiring, not a tuning: an active-low laser or tool output
                // taken back to active high would be driven to its active
                // level the moment the output is written, and a socket map
                // taken back to the board's labels would step another
                // axis's motor on the next move.
                let defaults = Settings {
                    laser_invert: self.settings.laser_invert,
                    en_invert: self.settings.en_invert,
                    probe_invert: self.settings.probe_invert,
                    dir_invert: self.settings.dir_invert,
                    sockets: self.settings.sockets,
                    laser_pin: self.settings.laser_pin,
                    probe_pin: self.settings.probe_pin,
                    tool_out: self.settings.tool_out,
                    tool_pin: self.settings.tool_pin,
                    tool_invert: self.settings.tool_invert,
                    // The endstops: where they are, their pins and polarity,
                    // and whether they halt a move, which a reset of the
                    // tuning must not switch off.
                    stop: self.settings.stop,
                    stop_pin: self.settings.stop_pin,
                    stop_invert: self.settings.stop_invert,
                    limits: self.settings.limits,
                    ..Settings::default()
                };
                self.adopt(defaults);
                Ok(true)
            }
            Command::DriverReport => {
                self.events.driver_report = true;
                Ok(true)
            }
        }
    }

    /// `Z` on a `go` or `cut` is a joint on a cartesian machine and
    /// nothing on a polar one, where the slide moves alone; `A` stays off
    /// them on a cartesian machine, whose table holds the board still.
    fn check_board_words(&self, target: &[Option<f32>; AXES]) -> Result<(), Error> {
        let stray = if self.settings.cartesian { target[A] } else { target[Z] };
        if stray.is_some() {
            return Err(Error::BadWord);
        }
        Ok(())
    }

    /// Past the cross slide's soft limit, on the step the value rounds to.
    fn past_z_max(&self, z: f32) -> bool {
        let steps = self.settings.steps[Z];
        let rounded = math::steps_to_units(math::units_to_steps(z, steps), steps);
        self.settings.z_max > 0.0 && libm::fabsf(rounded) > self.settings.z_max
    }

    /// The cross slide changes hands after `cartesian` was switched: the
    /// joints take the slide's position, or the slide the joint's, so the
    /// slide stays at `slide_at`, its position in mm before the change,
    /// under either. Settings change only from `Idle`, with nothing moving.
    fn hand_over_cross_slide(&mut self, was_cartesian: bool, slide_at: f32) {
        if was_cartesian == self.settings.cartesian {
            return;
        }
        if self.settings.cartesian {
            let mut position = self.planner.position();
            position[Z] = math::units_to_steps(slide_at, self.settings.steps[Z]);
            self.planner.set_position(position);
            self.front.set_position(position);
        } else {
            self.slide.set_position(slide_at, &self.settings);
        }
    }

    /// Stops whatever runs on the output: the `spindle` setting changed its
    /// meaning, and a beam or a spindle left on would carry over into it.
    fn stop_output(&mut self) {
        self.spindle = None;
        self.beam = None;
        self.apply_laser = true;
    }

    fn require_idle(&self) -> Result<(), Error> {
        if self.state == State::Idle {
            Ok(())
        } else {
            Err(Error::State)
        }
    }

    /// Jogs are accepted in `Idle` and `Jog`, everything else that moves
    /// in `Idle` and `Run`, and during a hold of a run, where it waits for
    /// the resume like a line taken in before the hold: a host streaming a
    /// job keeps sending through an operator's pause, and a refusal there
    /// would end the job.
    fn check_motion_state(&self, jog: bool) -> Result<(), Error> {
        // A cross slide move carries the rail the radius rides on, so
        // nothing joins it, not even the jog its own state looks like.
        if self.slide.busy() {
            return Err(Error::State);
        }
        // While a jog cancel brakes, the state is still `Jog` but whatever
        // is queued is about to be thrown away, a new jog with it; it
        // would be answered `ok` and never run.
        if self.jog_cancel {
            return Err(Error::State);
        }
        let allowed = if jog {
            matches!(self.state, State::Idle | State::Jog)
        } else {
            matches!(self.state, State::Idle | State::Run) || (self.state == State::Hold && self.held == State::Run)
        };
        if allowed {
            Ok(())
        } else {
            Err(Error::State)
        }
    }

    /// Resolves the words against the planned position and checks the
    /// radius; the push itself happens in `poll`.
    fn queue_motion(
        &mut self,
        words: [Option<f32>; AXES],
        relative: bool,
        kind: MoveKind,
        feed: Feed,
        power: f32,
        min_power: f32,
    ) -> Result<(), Error> {
        // Without a focus axis there is nothing to move: an `H` word is
        // refused rather than stepping a driver that is not there.
        if words[H].is_some() && !self.settings.h_axis {
            return Err(Error::BadWord);
        }
        let here = self.planner.position_units(&self.settings);
        let mut target = here;
        for i in 0..AXES {
            if let Some(word) = words[i] {
                target[i] = if relative { here[i] + word } else { word };
                // The step count is an i32: a target past its range would
                // be moved to short of where it says, with an `ok`.
                if !math::fits_steps(target[i], self.settings.steps[i]) {
                    return Err(Error::OutOfRange);
                }
            }
        }
        // Any move may cross the axis and come out the far side. A jog goes
        // there to be lined up with the axis; a cut goes there to land on a
        // board point from the other direction, the same point half a turn
        // away but with the head's offset from the axis mirrored, which is
        // what a calibration burn compares. The soft limit is on the
        // distance from the axis, either side, checked on the step the
        // target rounds to so a move back onto the axis is not refused for
        // a rounding hair.
        let r_steps = math::units_to_steps(target[R], self.settings.steps[R]);
        let r_units = math::steps_to_units(r_steps, self.settings.steps[R]);
        if self.settings.r_max > 0.0 && libm::fabsf(r_units) > self.settings.r_max {
            return Err(Error::OutOfRange);
        }
        // On a polar machine the joint's Z is not the slide and stays put.
        if self.settings.cartesian && self.past_z_max(target[Z]) {
            return Err(Error::OutOfRange);
        }
        // A move longer than the stepper's Bresenham counters can carry
        // would wrap them and lose the position; refuse it instead. The
        // step count is saturated, so the difference is taken in i64.
        let here_steps = self.planner.position();
        for i in 0..AXES {
            let steps = math::units_to_steps(target[i], self.settings.steps[i]);
            if (steps as i64 - here_steps[i] as i64).unsigned_abs() > stepper::MAX_EVENTS as u64 {
                return Err(Error::OutOfRange);
            }
        }
        self.pending = Pending::Motion { target, kind, feed, power, min_power };
        Ok(())
    }

    fn status(&self) -> Status {
        // A spindle's output is the main loop's alone, busy or not.
        let duty = if self.front.busy() && !self.settings.spindle {
            self.front.duty()
        } else {
            self.constant_duty().unwrap_or_else(|| self.off_duty())
        };
        // A hold is reported once the brake has finished, not when it was
        // asked for: `Hold` in a report means the steppers are still, so a
        // host that resets on seeing it loses no steps. Until then the
        // report keeps the state the hold interrupted.
        let state = if self.state == State::Hold && self.front.busy() { self.held } else { self.state };
        Status {
            state,
            joint: self.joint(),
            rate: self.front.surface_rate(),
            duty,
            planner_free: self.planner.free(),
            line_free: LINE_SLOTS.saturating_sub(self.lines_waiting + usize::from(self.pending != Pending::None)),
            mode: self.mode,
            enabled: self.enabled,
            probe: self.settings.h_axis.then_some(self.probe_active),
            homed: (self.settings.stop_mask() != 0).then_some(self.homed),
        }
    }

    pub fn realtime(&mut self, action: Realtime, laser: &mut impl LaserPort, out: &mut impl Sink) {
        match action {
            Realtime::Status => report::status(&self.status(), out),
            Realtime::Hold => {
                // A beam lit by `laser` is closed whatever the state, and
                // does not come back with the resume: an operator reaching
                // for hold as a stop expects the beam out. A dwell's beam
                // does come back, with the time it had left.
                if self.beam.take().is_some() {
                    laser.set_duty(self.off_duty());
                }
                // The cross slide has nothing to resume into: it is one
                // setup move with no queue behind it. A hold reached for
                // as a stop brakes it and ends it where it is, and the
                // state falls back to `Idle` rather than waiting on a
                // resume that would have nothing to do.
                // A home has nothing to resume into either: a hold brakes
                // it and ends it where it is.
                if self.state == State::Home {
                    self.cancel_home();
                    return;
                }
                if self.slide.busy() {
                    self.slide.cancel();
                    return;
                }
                if !matches!(self.state, State::Run | State::Jog) {
                    // Nothing moves yet, but a motion line already taken
                    // in, or still waiting to be read, starts the moment
                    // this returns and would run on as if the hold had
                    // never been asked for. It is kept for that line.
                    let waiting = matches!(
                        self.pending,
                        Pending::Motion { .. }
                            | Pending::Dwell { .. }
                            | Pending::Probe { .. }
                            | Pending::Home { .. }
                            | Pending::Spindle(Some(_))
                            | Pending::SlideMove { .. }
                    ) || self.lines_waiting > 0;
                    if self.state == State::Idle && waiting {
                        self.hold_latched = true;
                    }
                    return;
                }
                self.enter_hold(laser);
            }
            Realtime::Resume => {
                self.hold_latched = false;
                // A probe braking at its contact finishes the brake whatever
                // is asked: resumed, the rest of its block would drive the
                // head on through the board with nothing left to stop it.
                if self.state != State::Hold || self.jog_cancel || self.probe_braking {
                    return;
                }
                self.front.resume(&mut self.planner);
                self.state = self.held;
                if self.pending == Pending::Dwelling {
                    self.dwell_until = Some(self.now + self.dwell_left_us);
                    self.drive_beam(laser);
                }
            }
            Realtime::Reset => {
                let alarm = self.reset(laser);
                report::message("reset", out);
                if alarm {
                    report::alarm(1, out);
                }
                report::banner(out);
            }
            Realtime::JogCancel => {
                if self.state == State::Home {
                    self.cancel_home();
                    return;
                }
                // The slide only ever moves on its own, so at most one of
                // the two is running.
                if self.slide.busy() {
                    self.slide.cancel();
                    return;
                }
                let jogging = self.state == State::Jog || (self.state == State::Hold && self.held == State::Jog);
                if jogging {
                    self.front.request_hold();
                    self.jog_cancel = true;
                }
            }
        }
    }

    /// The drivers lost their motor supply: everything stops as a reset
    /// stops it, and the machine is left in `Alarm:3` even from `Idle`,
    /// because the motors held nothing meanwhile. Lines the host sent
    /// before it heard of it, still on their way in, are then refused
    /// rather than run from a position nobody knows.
    pub fn power_lost(&mut self, laser: &mut impl LaserPort, out: &mut impl Sink) {
        self.reset(laser);
        self.homed = 0;
        self.state = State::Alarm(3);
        report::message("reset", out);
        report::alarm(3, out);
        report::banner(out);
    }

    /// An endstop in `limits` closed under a move: the interrupt has
    /// halted (or the polar cross slide is stopped here), and everything
    /// else stops as it does on a reset. The motor may have stalled
    /// against the switch, so the position is lost: `Alarm:4`, and every
    /// axis is unhomed. The banner follows, as after a lost motor supply,
    /// so a host that streamed a job sees the lines it sent fail.
    fn limit_tripped(&mut self, mask: u8, laser: &mut impl LaserPort, out: &mut impl Sink) {
        self.reset(laser);
        self.homed = 0;
        self.state = State::Alarm(4);
        report::message("reset", out);
        report::limit(mask, out);
        report::alarm(4, out);
        report::banner(out);
    }

    /// Brakes the home under way; `poll_home` ends it once stopped.
    fn cancel_home(&mut self) {
        let Some(homing) = self.homing else {
            return;
        };
        if self.home_cancel {
            return;
        }
        self.home_cancel = true;
        if self.home_on_slide(homing.joint) {
            self.slide.cancel();
        } else {
            self.front.request_hold();
        }
    }

    fn enter_hold(&mut self, laser: &mut impl LaserPort) {
        self.hold_latched = false;
        self.held = self.state;
        self.state = State::Hold;
        self.front.request_hold();
        if let Some(until) = self.dwell_until.take() {
            self.dwell_left_us = until.saturating_sub(self.now);
        }
        // The beam goes out; a spindle keeps turning, so the resume does
        // not drive a still tool into the work.
        laser.set_duty(self.dark_duty());
    }

    /// Stops everything and forgets the modal state. True when it was
    /// moving: the position may be off and the state is `Alarm`.
    fn reset(&mut self, laser: &mut impl LaserPort) -> bool {
        let moving = matches!(self.state, State::Run | State::Jog | State::Hold | State::Home) && self.front.busy();
        self.front.abort(&mut self.planner);
        self.planner.clear();
        // The slide counts its own steps, so stopping it mid-move costs
        // no position and raises no alarm.
        self.slide.stop();
        self.pending = Pending::None;
        self.jog_cancel = false;
        self.probe_braking = false;
        self.probe_halting = false;
        self.homing = None;
        self.home_cancel = false;
        self.slide_limit_since = None;
        self.hold_latched = false;
        self.dwell_until = None;
        self.dwell_left_us = 0;
        self.dwell_power = None;
        self.beam = None;
        self.spindle = None;
        laser.set_duty(self.off_duty());
        self.feed = None;
        self.power = 0.0;
        self.mode = PowerMode::Dynamic;
        if moving {
            self.state = State::Alarm(1);
            self.homed = 0;
        } else if !matches!(self.state, State::Alarm(_)) {
            // An alarm already raised stays: it is the operator's
            // acknowledgment that the position may be off, and another
            // reset is not that.
            self.state = State::Idle;
            self.idle_since = self.now;
        }
        moving
    }

    /// Advances everything: fills the stepper, finishes pending commands,
    /// times the laser and the idle disable, moves between states.
    /// `now_us` is monotonic. Returns true when the step timer must be
    /// started (see `stepper::Prep::kick`).
    pub fn poll(
        &mut self,
        now_us: u64,
        port: &mut impl StepPort,
        laser: &mut impl LaserPort,
        store: &mut impl Store,
        out: &mut impl Sink,
    ) -> bool {
        self.now = now_us;
        self.probe_active = port.probe() == self.settings.probe_invert;
        self.stops_closed = (port.stops() ^ self.settings.joint_stop_invert() ^ 0b1111) & 0b1111;
        // Before anything is queued behind a halt the interrupt made.
        let limit = self.front.limit_hit();
        if limit != 0 {
            self.limit_tripped(limit, laser, out);
        }
        self.check_slide_limit(laser, out);
        let mut kick = self.front.prep(&mut self.planner, &self.settings, self.mode).kick;
        if self.progress(port, laser, store, out) {
            kick |= self.front.prep(&mut self.planner, &self.settings, self.mode).kick;
        }
        // A hold kept for a line that turned out not to be motion (a
        // setting, a query) has nothing left to wait for.
        if self.hold_latched && self.state == State::Idle && self.pending == Pending::None && self.lines_waiting == 0 {
            self.hold_latched = false;
        }
        // After `progress`, so a `$load` that changes a polarity reaches the
        // ports in the same poll that answers it: an output left one poll
        // behind the settings it belongs to is a lit beam or a dropped
        // driver enable for as long as that takes.
        if self.apply_enable {
            self.apply_enable = false;
            port.set_enable(self.enable_level(self.enabled));
        }
        if self.apply_laser {
            self.apply_laser = false;
            laser.set_frequency(self.settings.laser_hz);
            if !self.front.busy() || self.settings.spindle {
                self.drive_beam(laser);
            }
            self.tool_driven = None;
        }
        // The tool output follows what the output is doing, driven again
        // only when that changes. With `tool_out` off it rests at its
        // inactive level, whatever the tool does.
        let tool_on = self.settings.tool_out && self.tool_active();
        if self.tool_driven != Some(tool_on) {
            self.tool_driven = Some(tool_on);
            laser.set_enable(tool_on != self.settings.tool_invert);
        }
        if self.dwell_until.is_some_and(|until| now_us >= until) {
            self.dwell_until = None;
            if self.dwell_power.take().is_some() {
                self.beam = None;
                self.drive_beam(laser);
            }
            self.pending = Pending::None;
            report::ok(out);
        }
        let motion_done = matches!(self.state, State::Run | State::Jog)
            && self.planner.is_empty()
            && !self.front.busy()
            && !self.slide.busy()
            && !self.jog_cancel
            && !matches!(self.pending, Pending::Motion { .. } | Pending::Dwelling | Pending::Probing);
        if motion_done {
            self.enter_idle(laser);
        }
        if self.pending == Pending::Probing {
            // A halt at contact has stopped the axis already, whatever a
            // jog cancel was braking toward; the probe ends as a contact.
            if self.probe_halting && self.front.probe_contact().is_some() {
                self.jog_cancel = false;
            }
            if !self.jog_cancel {
                self.poll_probe(laser, out);
            }
        }
        if self.pending == Pending::Homing {
            self.poll_home(laser, out);
        }
        if self.jog_cancel && self.front.is_stopped() {
            self.jog_cancel = false;
            // Read before the flush, which the next probe's arming clears.
            let contact = self.front.probe_contact();
            self.front.flush(&mut self.planner);
            self.planner.clear();
            if matches!(self.pending, Pending::Motion { .. }) {
                // The rest of the jog is discarded, the line still answered.
                self.pending = Pending::None;
                report::ok(out);
            } else if matches!(self.pending, Pending::Probe { .. }) {
                // A probe waiting behind the jog was to start where the jog
                // would have ended; it ends unrun, as a canceled probe does.
                self.pending = Pending::None;
                self.report_probe(None, out);
                report::ok(out);
            } else if self.pending == Pending::Probing {
                // Canceled on purpose: the operator knows where the head
                // is, so no alarm, but no contact either unless there was.
                self.pending = Pending::None;
                self.probe_braking = false;
                self.probe_halting = false;
                self.report_probe(contact, out);
                report::ok(out);
            }
            self.enter_idle(laser);
        }
        if self.beam.is_some() && now_us >= self.beam_until {
            self.beam = None;
            self.drive_beam(laser);
        }
        // A turning spindle or a lit beam keeps the drivers on: the depth
        // axis under a turning tool keeps its holding torque, and the idle
        // time counts from when the output stops.
        if self.spindle.is_some_and(|speed| speed > 0.0) || self.beam.is_some() {
            self.idle_since = now_us;
        }
        let idle_limit = self.settings.idle_ms as u64 * 1000;
        if self.state == State::Idle && self.enabled && idle_limit > 0 && now_us.saturating_sub(self.idle_since) >= idle_limit {
            self.set_enabled(false, port);
        }
        kick
    }

    /// Completes the pending line when its turn has come. True when a
    /// block was pushed.
    fn progress(
        &mut self,
        port: &mut impl StepPort,
        laser: &mut impl LaserPort,
        store: &mut impl Store,
        out: &mut impl Sink,
    ) -> bool {
        let pending = self.pending;
        if let Pending::Motion { target, kind, feed, power, min_power } = pending {
            if self.state == State::Hold || self.front.resync_pending() {
                return false;
            }
            match self.planner.push(target, kind, feed, power, min_power, &self.settings) {
                Ok(_) => {
                    self.set_enabled(true, port);
                    if self.beam.take().is_some() {
                        laser.set_duty(self.off_duty());
                    }
                    self.pending = Pending::None;
                    self.state = if kind == MoveKind::Jog { State::Jog } else { State::Run };
                    if self.hold_latched {
                        self.enter_hold(laser);
                    }
                    report::ok(out);
                    return true;
                }
                Err(PlanError::Full) => return false,
                Err(PlanError::Feed) => {
                    self.pending = Pending::None;
                    report::error(Error::OutOfRange, out);
                    return false;
                }
            }
        }
        if matches!(pending, Pending::None | Pending::Dwelling | Pending::Probing | Pending::Homing) {
            return false;
        }
        if !self.planner.is_empty() || self.front.busy() {
            return false;
        }
        match pending {
            Pending::Dwell { ms, power } => {
                // A dwell is motion time. Starting one during a hold would
                // light the beam the hold turned off and leave the state at
                // `Run` with the stepper still holding, which no later
                // resume would clear.
                if self.state == State::Hold {
                    return false;
                }
                self.pending = Pending::Dwelling;
                self.state = State::Run;
                self.dwell_power = power;
                self.dwell_until = Some(self.now + ms as u64 * 1000);
                // A hold kept for this line takes the dwell's time and
                // leaves the beam dark; lit first, the output would carry
                // the power for the moment between the two writes.
                if self.hold_latched {
                    self.enter_hold(laser);
                } else {
                    self.drive_beam(laser);
                }
                return false;
            }
            Pending::Probe { distance, feed } => return self.start_probe(distance, feed, port, laser, out),
            Pending::Home { axes, positive } => return self.start_home(axes, positive, port, laser, out),
            Pending::Mode(mode) => self.mode = mode,
            // A hold kept for this line closes the beam as soon as it lights,
            // as it would a beam already lit: it is answered and stays dark.
            Pending::LaserOn { .. } if self.hold_latched => self.hold_latched = false,
            Pending::LaserOn { power, ms } => {
                self.beam = Some(power);
                self.beam_until = self.now + ms.unwrap_or(self.settings.laser_ms) as u64 * 1000;
                self.drive_beam(laser);
            }
            Pending::LaserOff => {
                // Off means the output off, a spindle's included.
                self.beam = None;
                self.spindle = None;
                self.drive_beam(laser);
            }
            Pending::Spindle(power) => {
                // A start waits out a hold, as the move behind it would. A
                // stop waits only for the motion queued ahead of it (which a
                // hold of a run keeps until the resume), not for the hold
                // itself. A hold kept for a start is applied here, so the
                // report says Hold and `~` starts it.
                if power.is_some() && self.hold_latched {
                    self.enter_hold(laser);
                }
                if power.is_some() && self.state == State::Hold {
                    return false;
                }
                self.spindle = power;
                self.drive_beam(laser);
            }
            Pending::SetPosition(value) => {
                let mut steps = self.planner.position();
                for i in 0..AXES {
                    if let Some(units) = value[i] {
                        steps[i] = math::units_to_steps(units, self.settings.steps[i]);
                        // Declared elsewhere, the axis is no longer where
                        // its switch put it.
                        self.homed &= !(1 << i);
                    }
                }
                self.planner.set_position(steps);
                self.front.set_position(steps);
            }
            Pending::SetSlide(value) => {
                self.slide.set_position(value, &self.settings);
                self.homed &= !(1 << Z);
            }
            // A hold brakes a slide move and ends it where it is; one kept
            // for the move ends it before its first step.
            Pending::SlideMove { .. } if self.hold_latched => self.hold_latched = false,
            Pending::SlideMove { target, feed } => {
                self.set_enabled(true, port);
                // A constant beam lit by `laser` goes out before the rail
                // moves, as it does before a joint move.
                if self.beam.take().is_some() {
                    laser.set_duty(self.off_duty());
                }
                self.slide.start(self.slide.position(), target, feed, &self.settings);
                if self.slide.busy() {
                    self.state = State::Jog;
                }
                self.slide_limit_ignore = self.stop_closed(Z);
                self.slide_limit_since = None;
            }
            Pending::Enable(on) => self.set_enabled(on, port),
            Pending::Save => {
                let mut blob = [0u8; BLOB_LEN];
                self.settings.to_blob(&mut blob);
                if !store.save(&blob) {
                    self.pending = Pending::None;
                    report::error(Error::Flash, out);
                    return false;
                }
            }
            Pending::Load => {
                if !self.load_settings(store) {
                    self.pending = Pending::None;
                    report::error(Error::Flash, out);
                    return false;
                }
            }
            Pending::None
            | Pending::Dwelling
            | Pending::Probing
            | Pending::Homing
            | Pending::Motion { .. } => {}
        }
        self.pending = Pending::None;
        report::ok(out);
        false
    }

    /// Starts the home once everything before it has run. True when a
    /// block was pushed.
    fn start_home(
        &mut self,
        axes: u8,
        positive: u8,
        port: &mut impl StepPort,
        laser: &mut impl LaserPort,
        out: &mut impl Sink,
    ) -> bool {
        // A hold kept for the line: a home has nothing to pause into, so
        // it does not start.
        if self.hold_latched {
            self.hold_latched = false;
            self.pending = Pending::None;
            report::error(Error::State, out);
            return false;
        }
        self.set_enabled(true, port);
        if self.beam.take().is_some() {
            laser.set_duty(self.off_duty());
        }
        self.pending = Pending::Homing;
        self.state = State::Home;
        self.home_cancel = false;
        self.homing = Some(Homing { axes, positive, joint: 0, phase: HomePhase::Clear, contact_steps: 0, contact_mm: 0.0 });
        self.next_home_joint(laser, out)
    }

    /// Takes up the next joint of the home in `HOME_ORDER`, or ends the
    /// home when none is left. True when a block was pushed.
    fn next_home_joint(&mut self, laser: &mut impl LaserPort, out: &mut impl Sink) -> bool {
        let Some(mut homing) = self.homing else {
            return false;
        };
        let Some(&joint) = HOME_ORDER.iter().find(|&&joint| homing.axes & (1 << joint) != 0) else {
            self.homing = None;
            self.pending = Pending::None;
            report::ok(out);
            self.enter_idle(laser);
            return false;
        };
        homing.joint = joint;
        self.homing = Some(homing);
        // Closed at rest, the switch is backed off first, so the seek
        // meets a fresh contact rather than reading the one it sits on.
        let phase = if self.stop_closed(joint) { HomePhase::Clear } else { HomePhase::Seek };
        self.home_phase(phase, laser, out)
    }

    /// Enters `phase` for the joint under way by queuing its move. True
    /// when a block was pushed.
    fn home_phase(&mut self, phase: HomePhase, laser: &mut impl LaserPort, out: &mut impl Sink) -> bool {
        let Some(mut homing) = self.homing else {
            return false;
        };
        let joint = homing.joint;
        let dir = if homing.positive & (1 << joint) != 0 { 1.0 } else { -1.0 };
        let pull = self.settings.home_pull[joint];
        let jog = self.settings.jog_rate[joint];
        let here = self.joint()[joint];
        let switch = self.switch_position(joint, dir);
        let (target, rate, watch) = match phase {
            HomePhase::Clear => (here - dir * pull, jog, false),
            HomePhase::Seek => (here + dir * (HOME_SEEK_MARGIN * self.settings.home_travel[joint] + pull), jog, true),
            HomePhase::Back => (switch - dir * pull, jog, false),
            // From the pull-off, twice it toward the switch: the seek put
            // the switch within its own repeatability of `switch`.
            HomePhase::Locate => (switch + dir * pull, jog / HOME_LOCATE_DIVISOR, true),
            HomePhase::Off => (switch - dir * pull, jog, false),
            HomePhase::SeekBrake | HomePhase::LocateBrake => return false,
        };
        homing.phase = phase;
        self.homing = Some(homing);
        if self.home_on_slide(joint) {
            self.slide.start(self.slide.position(), target, Some(rate), &self.settings);
            return false;
        }
        let scale = self.settings.steps[joint];
        let from = self.planner.position()[joint];
        if !math::fits_steps(target, scale)
            || (math::units_to_steps(target, scale) as i64 - from as i64).unsigned_abs() > stepper::MAX_EVENTS as u64
        {
            self.end_home(HomeEnd::OutOfRange, laser, out);
            return false;
        }
        let mut units = self.planner.position_units(&self.settings);
        units[joint] = target;
        let kind = if watch {
            self.front.arm_probe(false);
            MoveKind::Home(joint as u8)
        } else {
            MoveKind::Jog
        };
        match self.planner.push(units, kind, Feed::Axis(rate), 0.0, 0.0, &self.settings) {
            Ok(pushed) => pushed,
            Err(_) => {
                self.end_home(HomeEnd::OutOfRange, laser, out);
                false
            }
        }
    }

    /// Follows the home under way: brakes at a contact, declares the
    /// position once stopped, moves the joint on through its cycle and
    /// takes up the next joint.
    fn poll_home(&mut self, laser: &mut impl LaserPort, out: &mut impl Sink) {
        let Some(homing) = self.homing else {
            return;
        };
        let joint = homing.joint;
        let slide = self.home_on_slide(joint);
        if self.home_cancel {
            if self.home_stopped(slide) {
                self.end_home(HomeEnd::Canceled, laser, out);
            }
            return;
        }
        match homing.phase {
            HomePhase::Clear | HomePhase::Back | HomePhase::Off => {
                if !self.home_move_done(slide) {
                    return;
                }
                match homing.phase {
                    HomePhase::Clear if self.stop_closed(joint) => self.end_home(HomeEnd::StopActive, laser, out),
                    HomePhase::Clear => {
                        self.home_phase(HomePhase::Seek, laser, out);
                    }
                    HomePhase::Back => {
                        self.home_phase(HomePhase::Locate, laser, out);
                    }
                    _ => {
                        self.homed |= 1 << joint;
                        report::home(joint, self.joint()[joint], true, out);
                        let mut rest = homing;
                        rest.axes &= !(1 << joint);
                        self.homing = Some(rest);
                        self.next_home_joint(laser, out);
                    }
                }
            }
            HomePhase::Seek | HomePhase::Locate => {
                let mut met = homing;
                let contact = if slide {
                    // Read here, once a poll: the slide steps from the
                    // main loop, so this is as fine as its timing.
                    met.contact_mm = self.slide.position();
                    self.stop_closed(joint)
                } else {
                    match self.front.probe_contact() {
                        Some(steps) => {
                            met.contact_steps = steps;
                            true
                        }
                        None => false,
                    }
                };
                if contact {
                    if slide {
                        self.slide.cancel();
                    } else {
                        self.front.request_hold();
                    }
                    met.phase = if homing.phase == HomePhase::Seek { HomePhase::SeekBrake } else { HomePhase::LocateBrake };
                    self.homing = Some(met);
                } else if self.home_move_done(slide) {
                    self.end_home(HomeEnd::Missed, laser, out);
                }
            }
            HomePhase::SeekBrake | HomePhase::LocateBrake => {
                if !self.home_stopped(slide) {
                    return;
                }
                // The joint sits its overtravel past the contact: declare
                // the contact as the switch's position and it with it.
                let dir = if homing.positive & (1 << joint) != 0 { 1.0 } else { -1.0 };
                let switch = self.switch_position(joint, dir);
                if slide {
                    let now = self.slide.position();
                    self.slide.set_position(switch + (now - homing.contact_mm), &self.settings);
                } else {
                    self.front.flush(&mut self.planner);
                    self.planner.clear();
                    let mut steps = self.front.position();
                    let at_switch = math::units_to_steps(switch, self.settings.steps[joint]);
                    steps[joint] = steps[joint].wrapping_sub(homing.contact_steps).wrapping_add(at_switch);
                    self.planner.set_position(steps);
                    self.front.set_position(steps);
                }
                let next = if homing.phase == HomePhase::SeekBrake { HomePhase::Back } else { HomePhase::Off };
                self.home_phase(next, laser, out);
            }
        }
    }

    /// Ends the home short: `[HOME:..:0]` for the joint under way, then
    /// the answer `end` calls for.
    fn end_home(&mut self, end: HomeEnd, laser: &mut impl LaserPort, out: &mut impl Sink) {
        let Some(homing) = self.homing.take() else {
            return;
        };
        self.pending = Pending::None;
        self.home_cancel = false;
        if self.home_on_slide(homing.joint) {
            self.slide.stop();
        } else {
            self.front.flush(&mut self.planner);
            self.planner.clear();
        }
        report::home(homing.joint, self.joint()[homing.joint], false, out);
        match end {
            HomeEnd::Canceled => {
                report::ok(out);
                self.enter_idle(laser);
            }
            HomeEnd::StopActive => {
                report::error(Error::StopActive, out);
                self.enter_idle(laser);
            }
            HomeEnd::OutOfRange => {
                report::error(Error::OutOfRange, out);
                self.enter_idle(laser);
            }
            HomeEnd::Missed => {
                // The axis ran its travel and more without the switch:
                // it may have stalled against its end, so where it is
                // nobody knows.
                self.homed &= !(1 << homing.joint);
                report::alarm(5, out);
                report::error(Error::HomeFailed, out);
                self.state = State::Alarm(5);
                self.spindle = None;
                self.drive_beam(laser);
            }
        }
    }

    /// What the joint reads where the switch it seeks closes.
    fn switch_position(&self, joint: usize, dir: f32) -> f32 {
        if dir > 0.0 && self.settings.has_min_stop(joint) {
            self.settings.home_pos[joint] + self.settings.home_travel[joint]
        } else {
            self.settings.home_pos[joint]
        }
    }

    /// The joint is the polar cross slide, which moves on its own `Slide`.
    fn home_on_slide(&self, joint: usize) -> bool {
        joint == Z && !self.settings.cartesian
    }

    fn stop_closed(&self, joint: usize) -> bool {
        self.stops_closed & (1 << joint) != 0
    }

    /// A plain move of the home has run out.
    fn home_move_done(&self, slide: bool) -> bool {
        if slide {
            !self.slide.busy()
        } else {
            self.planner.is_empty() && !self.front.busy() && !self.front.resync_pending()
        }
    }

    /// A brake of the home has come to rest.
    fn home_stopped(&self, slide: bool) -> bool {
        if slide {
            !self.slide.busy()
        } else {
            self.front.is_stopped()
        }
    }

    /// The polar cross slide's endstop under one of its own moves, read
    /// and debounced here as the interrupt does the joints': closed for
    /// `LIMIT_DEBOUNCE_US`, it halts the slide and trips the alarm. One
    /// closed when the move started is waited out until it opens.
    fn check_slide_limit(&mut self, laser: &mut impl LaserPort, out: &mut impl Sink) {
        let watched = !self.settings.cartesian
            && self.slide.busy()
            && self.homing.is_none()
            && self.settings.joint_limits() & (1 << Z) != 0;
        let closed = self.stop_closed(Z);
        if !closed {
            self.slide_limit_since = None;
            self.slide_limit_ignore = false;
            return;
        }
        if !watched || self.slide_limit_ignore {
            self.slide_limit_since = None;
            return;
        }
        let since = *self.slide_limit_since.get_or_insert(self.now);
        if self.now.saturating_sub(since) >= stepper::LIMIT_DEBOUNCE_US as u64 {
            self.limit_tripped(1 << Z, laser, out);
        }
    }

    /// Queues the probe block once everything before it has run. True
    /// when a block was pushed.
    fn start_probe(
        &mut self,
        distance: f32,
        feed: f32,
        port: &mut impl StepPort,
        laser: &mut impl LaserPort,
        out: &mut impl Sink,
    ) -> bool {
        // Held with the probe still waiting: it starts after the resume.
        if self.state == State::Hold {
            return false;
        }
        let refuse = |machine: &mut Self, error: Error, out: &mut _| {
            machine.pending = Pending::None;
            report::error(error, out);
            false
        };
        // Pressed already: moving toward the board would only press harder.
        if self.probe_active {
            return refuse(self, Error::ProbeActive, out);
        }
        // With a spindle the probe may be the tool itself: a turning one
        // would cut into the copper at every touch.
        if self.settings.spindle && self.spindle.is_some_and(|speed| speed > 0.0) {
            return refuse(self, Error::State, out);
        }
        let mut target = self.planner.position_units(&self.settings);
        let steps = self.settings.steps[H];
        let from = self.planner.position()[H];
        target[H] += distance;
        if !math::fits_steps(target[H], steps)
            || (math::units_to_steps(target[H], steps) as i64 - from as i64).unsigned_abs() > stepper::MAX_EVENTS as u64
        {
            return refuse(self, Error::OutOfRange, out);
        }
        // Stopping dead is a speed change of the whole probe speed at once,
        // which the axis takes only within its jerk allowance; a faster
        // probe brakes as usual, from a single queued segment.
        let halting = self.settings.probe_ms == 0 && feed / 60.0 <= self.settings.jerk[H];
        self.front.arm_probe(halting);
        match self.planner.push(target, MoveKind::Probe, Feed::Surface(feed), 0.0, 0.0, &self.settings) {
            Ok(true) => {}
            // Under one step, or no speed: nothing to probe with.
            Ok(false) | Err(_) => return refuse(self, Error::OutOfRange, out),
        }
        self.set_enabled(true, port);
        if self.beam.take().is_some() {
            laser.set_duty(self.off_duty());
        }
        self.pending = Pending::Probing;
        self.probe_halting = halting;
        self.state = State::Jog;
        if self.hold_latched {
            self.enter_hold(laser);
        }
        true
    }

    /// Follows a probe in progress: brakes at contact, and answers the line
    /// once the head has stopped there or has run out of distance.
    fn poll_probe(&mut self, laser: &mut impl LaserPort, out: &mut impl Sink) {
        let contact = self.front.probe_contact();
        if contact.is_some() && !self.probe_braking {
            if self.probe_halting {
                // The interrupt has stopped the axis and dropped the ring;
                // the abort drops what the front still meant to write and
                // takes the position from the steps actually made.
                self.front.abort(&mut self.planner);
                self.planner.clear();
            } else {
                self.front.request_hold();
            }
            self.probe_braking = true;
        }
        if self.probe_braking {
            let stopped = if self.probe_halting {
                !self.front.busy() && !self.front.resync_pending()
            } else {
                self.front.is_stopped()
            };
            if stopped {
                // Also after a halt: a hold or cancel asked while its abort
                // was still being taken left the front holding, and the next
                // move would be answered and never run.
                self.front.flush(&mut self.planner);
                self.planner.clear();
                self.finish_probe(contact, laser, out);
            }
            return;
        }
        // Out of distance without contact. A held probe still has its
        // block, so this is the end of the move, not a pause in it.
        if self.state != State::Hold && self.planner.is_empty() && !self.front.busy() {
            self.finish_probe(None, laser, out);
        }
    }

    fn finish_probe(&mut self, contact: Option<i32>, laser: &mut impl LaserPort, out: &mut impl Sink) {
        self.pending = Pending::None;
        self.probe_braking = false;
        self.probe_halting = false;
        self.report_probe(contact, out);
        if contact.is_some() {
            report::ok(out);
            self.enter_idle(laser);
        } else {
            report::alarm(2, out);
            report::error(Error::ProbeMissed, out);
            self.state = State::Alarm(2);
            self.spindle = None;
            self.drive_beam(laser);
        }
    }

    /// `[PRB:h:1]` at the contact, or `[PRB:h:0]` where the head is.
    fn report_probe(&self, contact: Option<i32>, out: &mut impl Sink) {
        let steps = contact.unwrap_or_else(|| self.front.position()[H]);
        report::probe(math::steps_to_units(steps, self.settings.steps[H]), contact.is_some(), out);
    }

    fn enter_idle(&mut self, laser: &mut impl LaserPort) {
        self.state = State::Idle;
        self.idle_since = self.now;
        self.drive_beam(laser);
    }

    fn adopt(&mut self, settings: Settings) {
        let was_cartesian = self.settings.cartesian;
        let was_spindle = self.settings.spindle;
        let slide_at = self.joint()[Z];
        self.settings = settings;
        self.hand_over_cross_slide(was_cartesian, slide_at);
        if was_spindle != self.settings.spindle {
            self.stop_output();
        }
        self.events.driver_config = true;
        self.apply_laser = true;
        self.apply_enable = true;
    }

    /// Pin level for the enable state under the `en_invert` setting.
    fn enable_level(&self, on: bool) -> bool {
        on == self.settings.en_invert
    }

    fn set_enabled(&mut self, on: bool, port: &mut impl StepPort) {
        port.set_enable(self.enable_level(on));
        if on && !self.enabled {
            self.idle_since = self.now;
        }
        self.enabled = on;
    }

    fn off_duty(&self) -> u16 {
        if self.settings.laser_invert {
            1000
        } else {
            0
        }
    }

    /// Driven duty for an `S` value: linear to `s_max`, polarity applied.
    fn duty_for(&self, power: f32) -> u16 {
        let duty = (power / self.settings.s_max * 1000.0).clamp(0.0, 1000.0) as u16;
        if self.settings.laser_invert {
            1000 - duty
        } else {
            duty
        }
    }

    /// The output is in use: a job runs, a beam is lit, a dwell burns or
    /// the spindle turns. What the tool output follows. A held dwell does
    /// not burn: `enter_hold` takes its time and leaves its power for the
    /// resume.
    fn tool_active(&self) -> bool {
        self.state == State::Run
            || self.beam.is_some()
            || (self.dwell_power.is_some() && self.dwell_until.is_some())
            || (self.settings.spindle && self.spindle.is_some_and(|speed| speed > 0.0))
    }

    /// Duty with no beam: off, or the running spindle's.
    fn dark_duty(&self) -> u16 {
        match self.spindle {
            Some(power) if self.settings.spindle => self.duty_for(power),
            _ => self.off_duty(),
        }
    }

    /// Duty of the constant output in effect: the spindle's, or the
    /// dwell's `S`, else the `laser` command's.
    fn constant_duty(&self) -> Option<u16> {
        if self.settings.spindle {
            return self.spindle.map(|power| self.duty_for(power));
        }
        let power = if self.dwell_until.is_some() {
            self.dwell_power.or(self.beam)
        } else {
            self.beam
        };
        power.map(|power| self.duty_for(power))
    }

    /// Writes the constant beam, or off, to the laser. Not while the
    /// stepper drives it.
    fn drive_beam(&self, laser: &mut impl LaserPort) {
        laser.set_duty(self.constant_duty().unwrap_or_else(|| self.off_duty()));
    }

    /// Writes what the beam should be right now to the laser port, without
    /// waiting for a `poll`. Called as soon as the stored settings are
    /// known, so an output with `laser_invert` set is not left lit through
    /// the rest of the boot.
    pub fn drive_laser(&self, laser: &mut impl LaserPort) {
        self.drive_beam(laser);
    }

    /// The USB host went away: like a reset without the output, and the
    /// laser off. The motors stay enabled so the position holds.
    pub fn disconnected(&mut self, laser: &mut impl LaserPort) {
        self.reset(laser);
    }

    /// Reads the store and adopts its settings if valid. The drivers are
    /// configured either way.
    pub fn load_settings(&mut self, store: &mut impl Store) -> bool {
        let mut blob = [0u8; BLOB_LEN];
        let loaded = store.load(&mut blob).and_then(|n| Settings::from_blob(&blob[..n]));
        match loaded {
            Some(settings) => {
                self.adopt(settings);
                true
            }
            None => {
                self.events.driver_config = true;
                false
            }
        }
    }

    pub fn take_events(&mut self) -> Events {
        core::mem::take(&mut self.events)
    }
}

const HELP: &str = "go [R] [A] [H] | cut [R] [A] [H] [F] [S] [M] | jog [R] [A] [H] [F] | jogto [R] [A] [H] [F]\n\
cross slide, alone and from idle: jog Z [F] | jogto Z [F] | set Z\n\
cartesian=1: Z is a joint with R, H: go, cut, jog, jogto, set take Z; go, cut take no A\n\
focus axis probe (h_axis=1): probe H [F]\n\
home [R] [A] [H] [Z]: a - or + after a letter picks the end; alone, every axis with an endstop\n\
dwell T [S] | mode dyn|const | laser S [T] | laser off | set [R] [A] [H]\n\
spindle=1: spindle S | spindle off; no S or M on cut and dwell, no laser S\n\
enable | disable | unlock | version | status | help\n\
$ | $name | $name=value | $save | $load | $defaults | $tmc\n\
realtime bytes: ? status, ! hold, ~ resume, 0x18 reset, 0x85 jog cancel\n";

#[cfg(test)]
mod tests {
    extern crate std;

    use std::boxed::Box;
    use std::string::String;
    use std::vec;
    use std::vec::Vec;

    use super::*;
    use crate::settings::{STOP_MAX, STOP_MIN};
    use crate::stepper::{self, Isr, Shared};
    use crate::{A, BLOCKS};

    const POLL_US: u64 = 500;

    struct Port {
        count: [u64; AXES],
        enable_level: Option<bool>,
        enable_writes: u32,
        /// Probe pin level: high is open for the default active-low probe.
        probe_level: bool,
        /// Endstop input levels, bit per joint: high is open at the
        /// default polarity.
        stop_levels: u8,
        /// Direction levels as driven, and which level means forward,
        /// from the settings; the rig keeps the latter current.
        dir_levels: u8,
        dir_invert: u8,
        /// Where each motor physically is, in steps from the start: a
        /// `set` or a home moves the reported position, never this.
        physical: [i64; AXES],
    }

    impl StepPort for Port {
        fn set_dir(&mut self, levels: u8) {
            self.dir_levels = levels;
        }

        fn step(&mut self, mask: u8) {
            for i in 0..AXES {
                if mask & (1 << i) != 0 {
                    self.count[i] += 1;
                    let forward = (self.dir_levels ^ self.dir_invert) & (1 << i) != 0;
                    self.physical[i] += if forward { 1 } else { -1 };
                }
            }
        }

        fn set_enable(&mut self, high: bool) {
            self.enable_level = Some(high);
            self.enable_writes += 1;
        }

        fn probe(&mut self) -> bool {
            self.probe_level
        }

        fn stops(&mut self) -> u8 {
            self.stop_levels
        }
    }

    /// The cross slide's pins as counters.
    #[derive(Default)]
    struct SlidePins {
        pulses: u64,
        dir: Option<bool>,
        /// The cross slide's `dir_invert` bit, kept current by the rig.
        invert: bool,
        /// Where the motor physically is, in steps from the start.
        physical: i64,
    }

    impl SlidePort for SlidePins {
        fn set_dir(&mut self, high: bool) {
            self.dir = Some(high);
        }

        fn step(&mut self) {
            self.pulses += 1;
            let forward = self.dir.unwrap_or(false) != self.invert;
            self.physical += if forward { 1 } else { -1 };
        }
    }

    struct Laser {
        now: u64,
        duty: u16,
        hz: u32,
        /// (time, duty) per change.
        duties: Vec<(u64, u16)>,
        /// (time, level) per tool output write.
        enables: Vec<(u64, bool)>,
    }

    impl LaserPort for Laser {
        fn set_duty(&mut self, permille: u16) {
            assert!(permille <= 1000);
            if self.duty != permille {
                self.duties.push((self.now, permille));
            }
            self.duty = permille;
        }

        fn set_frequency(&mut self, hz: u32) {
            self.hz = hz;
        }

        fn set_enable(&mut self, high: bool) {
            self.enables.push((self.now, high));
        }
    }

    #[derive(Default)]
    struct FakeStore {
        blob: Option<Vec<u8>>,
        fail: bool,
        saves: u32,
    }

    impl Store for FakeStore {
        fn load(&mut self, buf: &mut [u8]) -> Option<usize> {
            let blob = self.blob.as_ref()?;
            let n = blob.len().min(buf.len());
            buf[..n].copy_from_slice(&blob[..n]);
            Some(n)
        }

        fn save(&mut self, blob: &[u8]) -> bool {
            self.saves += 1;
            if self.fail {
                return false;
            }
            self.blob = Some(blob.to_vec());
            true
        }
    }

    #[derive(Default)]
    struct Out(String);

    impl Sink for Out {
        fn write(&mut self, bytes: &[u8]) {
            self.0.push_str(core::str::from_utf8(bytes).unwrap());
        }
    }

    /// Main loop, step interrupt and virtual clock in one.
    struct Rig {
        machine: Machine<'static>,
        isr: Isr<'static>,
        port: Port,
        slide: SlidePins,
        laser: Laser,
        store: FakeStore,
        out: Out,
        now: u64,
        next_tick: Option<u64>,
        /// Ticks that stepped while `record` is set: (time, mask).
        min_duty_while_stepping: u16,
        max_duty_while_stepping: u16,
        /// Focus axis position at and below which the probe touches the
        /// board; `None` for no board under it.
        surface: Option<f32>,
        /// Where each joint's switches physically are, in its units from
        /// the start: closed at or below the first, at or above the second.
        stop_min: [Option<f32>; AXES],
        stop_max: [Option<f32>; AXES],
    }

    /// Fixed settings so these tests measure the machine and not its
    /// defaults, which follow the mechanics and move with them: 256
    /// steps/mm on the radius, 888.889 steps/deg on the table, neither
    /// near the step generator's ceiling.
    fn bench_settings() -> Settings {
        Settings {
            // The same for the cross slide: a coarse scale and a rate
            // that keep a jog a readable number of steps.
            steps: [256.0, 888.889, 256.0, 256.0],
            max_rate: [1000.0, 1080.0, 600.0, 1200.0],
            jog_rate: [600.0, 720.0, 120.0, 600.0],
            jerk: [3.0, 10.0, 1.0, 3.0],
            ..Settings::default()
        }
    }

    impl Rig {
        fn new() -> Rig {
            Rig::with(bench_settings())
        }

        fn with(settings: Settings) -> Rig {
            let shared: &'static mut Shared = Box::leak(Box::new(Shared::new()));
            let (front, isr) = stepper::split(shared);
            let mut rig = Rig {
                machine: Machine::new(front, settings),
                isr,
                port: Port {
                    count: [0; AXES],
                    enable_level: None,
                    enable_writes: 0,
                    probe_level: true,
                    stop_levels: 0b1111,
                    dir_levels: 0,
                    dir_invert: 0,
                    physical: [0; AXES],
                },
                slide: SlidePins::default(),
                laser: Laser { now: 0, duty: 0, hz: 0, duties: Vec::new(), enables: Vec::new() },
                store: FakeStore::default(),
                out: Out::default(),
                now: 0,
                next_tick: None,
                min_duty_while_stepping: 1000,
                max_duty_while_stepping: 0,
                surface: None,
                stop_min: [None; AXES],
                stop_max: [None; AXES],
            };
            report::banner(&mut rig.out);
            rig
        }

        fn take_out(&mut self) -> String {
            core::mem::take(&mut self.out.0)
        }

        /// The probe pin as the board under the head sets it: pulled low
        /// while touching, for the default active-low input. The endstops
        /// likewise, from where the motors physically are: a switch at or
        /// past `stop_min` or `stop_max` is closed.
        fn update_probe(&mut self) {
            let h = self.machine.joint()[H];
            self.port.probe_level = !self.surface.is_some_and(|top| h <= top);
            let settings = self.machine.settings();
            self.port.dir_invert = settings.joint_dir_invert();
            self.slide.invert = settings.dir_invert & 0b0100 != 0;
            let mut closed = 0u8;
            for i in 0..AXES {
                let steps = if i == Z && !settings.cartesian { self.slide.physical } else { self.port.physical[i] };
                let at = steps as f32 / settings.steps[i];
                if self.stop_min[i].is_some_and(|low| at <= low) || self.stop_max[i].is_some_and(|high| at >= high) {
                    closed |= 1 << i;
                }
            }
            self.port.stop_levels = !(closed ^ settings.joint_stop_invert()) & 0b1111;
        }

        /// Where a motor physically is, in its units from the start.
        fn physical(&self, joint: usize) -> f32 {
            let settings = self.machine.settings();
            let steps = if joint == Z && !settings.cartesian { self.slide.physical } else { self.port.physical[joint] };
            steps as f32 / settings.steps[joint]
        }

        fn poll(&mut self) {
            self.laser.now = self.now;
            self.update_probe();
            // As on the board: the slide is stepped from the main loop,
            // before the poll that ends its jog.
            self.machine.poll_slide(self.now, &mut self.slide);
            let kick = self.machine.poll(self.now, &mut self.port, &mut self.laser, &mut self.store, &mut self.out);
            if kick {
                self.next_tick = Some(self.now);
            }
        }

        fn tick(&mut self) {
            self.laser.now = self.now;
            self.update_probe();
            let before = self.port.count;
            let next = self.isr.tick(&mut self.port, &mut self.laser);
            if self.port.count != before {
                self.min_duty_while_stepping = self.min_duty_while_stepping.min(self.laser.duty);
                self.max_duty_while_stepping = self.max_duty_while_stepping.max(self.laser.duty);
            }
            self.next_tick = next.map(|us| self.now + us as u64);
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

        /// Submits a line once the machine takes one, then runs until it
        /// is answered. Returns the output produced meanwhile.
        fn line(&mut self, text: &str) -> String {
            let mut waited = 0;
            while !self.machine.ready_for_line() {
                self.advance(POLL_US);
                waited += 1;
                assert!(waited < 4_000_000, "machine never became ready for {text:?}");
            }
            self.machine.submit(text, &mut self.out);
            let mut waited = 0;
            while !answered(&self.out.0) {
                self.advance(POLL_US);
                waited += 1;
                assert!(waited < 4_000_000, "{text:?} was never answered: {:?}", self.out.0);
            }
            self.take_out()
        }

        /// Submits without waiting for the answer.
        fn submit(&mut self, text: &str) {
            assert!(self.machine.ready_for_line());
            self.machine.submit(text, &mut self.out);
        }

        fn realtime(&mut self, action: Realtime) {
            self.laser.now = self.now;
            self.machine.realtime(action, &mut self.laser, &mut self.out);
        }

        /// One pass of the board's main loop with `queue` as the lines the
        /// reader has assembled and `bytes` as the realtime bytes that came
        /// with them: waiting lines counted, realtime bytes, at most one
        /// line taken, waiting lines counted again, then the polls.
        fn pass(&mut self, queue: &mut Vec<&str>, bytes: &[Realtime]) {
            self.machine.note_lines_waiting(queue.len());
            for &action in bytes {
                self.realtime(action);
            }
            if !queue.is_empty() && self.machine.ready_for_line() {
                let line = queue.remove(0);
                self.machine.submit(line, &mut self.out);
            }
            self.machine.note_lines_waiting(queue.len());
            self.advance(POLL_US);
        }

        fn state(&self) -> State {
            self.machine.state()
        }

        /// Runs until the machine is `Idle` (or in alarm) with the stepper
        /// idle, then a little longer.
        fn run(&mut self) {
            let mut waited = 0;
            loop {
                self.advance(POLL_US);
                let settled = matches!(self.state(), State::Idle | State::Alarm(_))
                    && self.machine.ready_for_line()
                    && self.next_tick.is_none();
                if settled {
                    self.advance(10 * POLL_US);
                    break;
                }
                waited += 1;
                assert!(waited < 4_000_000, "motion did not finish");
            }
        }

        fn status_line(&mut self) -> String {
            self.realtime(Realtime::Status);
            let text = self.take_out();
            assert!(text.starts_with('<') && text.ends_with(">\n"), "{text:?}");
            text
        }

        /// Executed position in steps, back from the reported units.
        fn executed_steps(&self) -> [i32; AXES] {
            let joint = self.machine.joint();
            let steps = self.machine.settings().steps;
            [
                math::units_to_steps(joint[R], steps[R]),
                math::units_to_steps(joint[A], steps[A]),
                math::units_to_steps(joint[H], steps[H]),
                math::units_to_steps(joint[Z], steps[Z]),
            ]
        }
    }

    /// The output ends in an answer line.
    fn answered(out: &str) -> bool {
        out.lines().last().is_some_and(|last| last == "ok" || last.starts_with("error:"))
    }

    fn field<'a>(status: &'a str, key: &str) -> &'a str {
        status.trim().trim_matches(|c| c == '<' || c == '>').split('|').find_map(|f| f.strip_prefix(key)).unwrap()
    }

    #[test]
    fn example_session_from_the_protocol() {
        let mut rig = Rig::new();
        assert_eq!(rig.take_out(), "[spinny v0.1.0 lines:16 blocks:32]\n");
        assert_eq!(rig.line("set R0 A0"), "ok\n");
        assert_eq!(rig.line("go R10"), "ok\n");
        assert_eq!(rig.line("cut A90 F300 S400"), "ok\n");
        assert_eq!(rig.line("cut A180"), "ok\n");
        assert_eq!(rig.line("go R0 A0"), "ok\n");
        assert_eq!(rig.state(), State::Run);
        assert!(rig.port.enable_level == Some(false), "motors enabled with the active low default");
        rig.advance(2_000_000);
        let status = rig.status_line();
        assert!(status.starts_with("<Run|J:"), "{status}");
        let joint = field(&status, "J:");
        let (r, a) = joint.split_once(',').unwrap();
        assert_eq!(r.split('.').nth(1).unwrap().len(), 3);
        assert_eq!(a.split('.').nth(1).unwrap().len(), 4);
        // F300 at R10 asks 28.6 deg/s of a table limited to 18: the rate
        // report is the surface speed reached and the power scales with it.
        let rate = field(&status, "V:").parse::<u32>().unwrap();
        assert!((187..=190).contains(&rate), "{rate}");
        let duty = field(&status, "L:").parse::<u32>().unwrap();
        assert!((249..=253).contains(&duty), "{duty}");
        let (free, lines) = field(&status, "Q:").split_once(',').unwrap();
        assert!(free.parse::<usize>().unwrap() < BLOCKS);
        assert_eq!(lines, "16");
        assert_eq!(field(&status, "M:"), "dyn");
        assert_eq!(field(&status, "E:"), "1");
        rig.run();
        assert_eq!(rig.state(), State::Idle);
        assert_eq!(rig.machine.joint(), [0.0, 0.0, 0.0, 0.0]);
        assert_eq!(rig.port.count, [2 * 2560, 2 * 160_000, 0, 0]);
        assert_eq!(rig.laser.duty, 0);
        let status = rig.status_line();
        assert_eq!(status, "<Idle|J:0.000,0.0000|V:0|L:0|Q:32,16|M:dyn|E:1|Z:0.000>\n");
    }

    #[test]
    fn empty_and_comment_lines_answer_ok() {
        let mut rig = Rig::new();
        rig.take_out();
        assert_eq!(rig.line(""), "ok\n");
        assert_eq!(rig.line("   "), "ok\n");
        assert_eq!(rig.line("; just a comment"), "ok\n");
        assert_eq!(rig.line("\t ; tab"), "ok\n");
        assert_eq!(rig.line("nonsense"), "error:1 unknown command\n");
        assert_eq!(rig.line("go R1e3"), "error:2 bad word\n");
        let long: String = core::iter::repeat_n('x', LINE_MAX).collect();
        assert_eq!(rig.line(&long), "error:8 line too long\n");
    }

    #[test]
    fn cut_without_feed_is_missing_word() {
        let mut rig = Rig::new();
        rig.take_out();
        assert_eq!(rig.line("cut A10"), "error:3 missing word\n");
        assert_eq!(rig.line("cut A10 S100"), "error:3 missing word\n");
        assert_eq!(rig.line("cut A10 F600"), "ok\n");
        assert_eq!(rig.line("cut A20"), "ok\n");
        assert_eq!(rig.line("cut A30 S500"), "ok\n");
        rig.run();
        assert_eq!(rig.port.count, [0, 26667, 0, 0]);
        // A reset clears the modal words again.
        rig.realtime(Realtime::Reset);
        rig.take_out();
        assert_eq!(rig.line("cut A40"), "error:3 missing word\n");
    }

    #[test]
    fn motion_states_are_checked() {
        let mut rig = Rig::new();
        rig.take_out();
        assert_eq!(rig.line("go R50"), "ok\n");
        rig.advance(200_000);
        assert_eq!(rig.state(), State::Run);
        assert_eq!(rig.line("jog R1"), "error:5 not now\n");
        assert_eq!(rig.line("jogto R1"), "error:5 not now\n");
        assert_eq!(rig.line("set R0"), "error:5 not now\n");
        assert_eq!(rig.line("laser S100"), "error:5 not now\n");
        assert_eq!(rig.line("disable"), "error:5 not now\n");
        assert_eq!(rig.line("$save"), "error:5 not now\n");
        assert_eq!(rig.line("unlock"), "error:5 not now\n");
        assert_eq!(rig.line("go R60"), "ok\n");
        rig.run();
        assert_eq!(rig.line("jog R-10"), "ok\n");
        rig.advance(200_000);
        assert_eq!(rig.state(), State::Jog);
        assert_eq!(rig.line("go R0"), "error:5 not now\n");
        assert_eq!(rig.line("cut R0 F100"), "error:5 not now\n");
        assert_eq!(rig.line("dwell T10"), "error:5 not now\n");
        assert_eq!(rig.line("jog R-10"), "ok\n");
        rig.run();
        assert_eq!(rig.machine.joint(), [40.0, 0.0, 0.0, 0.0]);
        // A jog may cross the axis and come out the far side: lining the
        // head up with it needs both directions through zero.
        assert_eq!(rig.line("jog R-41"), "ok\n");
        rig.run();
        assert_eq!(rig.machine.joint(), [-1.0, 0.0, 0.0, 0.0]);
        // A cutting move may go there too: a calibration burn lands on the
        // same board point from both sides of the axis.
        assert_eq!(rig.line("go R-3"), "ok\n");
        rig.run();
        assert_eq!(rig.machine.joint(), [-3.0, 0.0, 0.0, 0.0]);
        assert_eq!(rig.line("cut R-1 F100"), "ok\n");
        rig.run();
        assert_eq!(rig.machine.joint(), [-1.0, 0.0, 0.0, 0.0]);
        assert_eq!(rig.line("jog R1"), "ok\n");
        rig.run();
        assert_eq!(rig.machine.joint(), [0.0, 0.0, 0.0, 0.0]);
        assert_eq!(rig.line("go A1"), "ok\n");
        rig.run();
        assert_eq!(rig.line("jog R0"), "ok\n");
        rig.run();
        assert_eq!(rig.state(), State::Idle);
    }

    #[test]
    fn hold_then_resume_completes_the_same_steps() {
        for hold_at_us in [300_000u64, 1_234_567, 3_000_100] {
            let mut rig = Rig::new();
            rig.take_out();
            assert_eq!(rig.line("go R20"), "ok\n");
            assert_eq!(rig.line("cut A180 F300 S500"), "ok\n");
            assert_eq!(rig.line("cut R15 A200"), "ok\n");
            assert_eq!(rig.line("go R0 A0"), "ok\n");
            rig.advance(hold_at_us);
            assert_eq!(rig.state(), State::Run);
            rig.realtime(Realtime::Hold);
            assert_eq!(rig.state(), State::Hold);
            assert_eq!(rig.take_out(), "");
            // The ramp runs out within a few hundred milliseconds.
            rig.advance(500_000);
            assert_eq!(rig.laser.duty, 0, "hold at {hold_at_us}");
            let stopped = rig.port.count;
            let status = rig.status_line();
            assert!(status.starts_with("<Hold|"), "{status}");
            assert_eq!(field(&status, "L:"), "0");
            assert_eq!(field(&status, "V:"), "0");
            rig.advance(300_000);
            assert_eq!(rig.port.count, stopped, "moved while held");
            assert_eq!(rig.laser.duty, 0);
            assert_eq!(rig.state(), State::Hold);
            rig.realtime(Realtime::Resume);
            assert_eq!(rig.state(), State::Run);
            rig.run();
            assert_eq!(rig.state(), State::Idle);
            // R: 0 -> 20 -> 15 -> 0; A: 0 -> 180 -> 200 -> 0.
            assert_eq!(rig.port.count, [5120 + 1280 + 3840, 160_000 + 17_778 + 177_778, 0, 0], "hold at {hold_at_us}");
            assert_eq!(rig.machine.joint(), [0.0, 0.0, 0.0, 0.0]);
            assert_eq!(rig.machine.planned_position(), [0, 0, 0, 0]);
            assert!(rig.max_duty_while_stepping > 0);
        }
    }

    #[test]
    fn hold_keeps_a_pending_motion_line() {
        let mut rig = Rig::new();
        rig.take_out();
        // Fill the planner with one second blocks so the next line waits for room.
        for i in 1..=BLOCKS {
            assert_eq!(rig.line(&std::format!("cut R{i} F60")), "ok\n");
        }
        rig.submit("go R0");
        rig.advance(POLL_US);
        assert!(!rig.machine.ready_for_line());
        rig.realtime(Realtime::Hold);
        rig.advance(500_000);
        assert_eq!(rig.take_out(), "");
        assert!(!rig.machine.ready_for_line());
        rig.realtime(Realtime::Resume);
        rig.run();
        assert_eq!(rig.take_out(), "ok\n");
        assert_eq!(rig.machine.joint(), [0.0, 0.0, 0.0, 0.0]);
        assert_eq!(rig.port.count[R], 2 * 32 * 256);
    }

    #[test]
    fn reset_while_moving_raises_an_alarm() {
        let mut rig = Rig::new();
        rig.take_out();
        assert_eq!(rig.line("go R50"), "ok\n");
        assert_eq!(rig.line("cut A90 F300 S500"), "ok\n");
        rig.advance(800_000);
        rig.realtime(Realtime::Reset);
        let out = rig.take_out();
        assert_eq!(
            out,
            "[MSG:reset]\nALARM:1 reset while moving, position may be off\n[spinny v0.1.0 lines:16 blocks:32]\n"
        );
        assert_eq!(rig.state(), State::Alarm(1));
        rig.advance(20_000);
        let stopped = rig.port.count;
        assert!(stopped[R] > 0 && stopped[R] < 12800);
        rig.advance(200_000);
        assert_eq!(rig.port.count, stopped, "stepping after the reset");
        assert_eq!(rig.laser.duty, 0);
        let status = rig.status_line();
        assert!(status.starts_with("<Alarm:1|"), "{status}");
        assert_eq!(rig.line("go R1"), "error:5 not now\n");
        assert_eq!(rig.line("unlock"), "ok\n");
        assert_eq!(rig.state(), State::Idle);
        assert_eq!(rig.machine.planned_position(), rig.executed_steps());
        assert_eq!(rig.line("go R0"), "ok\n");
        rig.run();
        assert_eq!(rig.machine.joint(), [0.0, 0.0, 0.0, 0.0]);
        assert_eq!(rig.machine.planned_position(), [0, 0, 0, 0]);
        assert_eq!(rig.port.count[R], 2 * stopped[R]);
    }

    #[test]
    fn reset_while_idle_is_not_an_alarm() {
        let mut rig = Rig::new();
        rig.take_out();
        assert_eq!(rig.line("mode const"), "ok\n");
        rig.realtime(Realtime::Reset);
        assert_eq!(rig.take_out(), "[MSG:reset]\n[spinny v0.1.0 lines:16 blocks:32]\n");
        assert_eq!(rig.state(), State::Idle);
        assert_eq!(rig.machine.mode(), PowerMode::Dynamic);
        assert_eq!(rig.line("unlock"), "error:5 not now\n");
    }

    #[test]
    fn hold_is_reported_once_the_brake_has_finished() {
        // The stop sequence a host runs is hold, wait for `Hold`, reset.
        // The report must not say `Hold` while the steppers still run
        // down the ramp, or that reset lands on a moving machine.
        let mut rig = Rig::new();
        rig.take_out();
        assert_eq!(rig.line("go R50"), "ok\n");
        assert_eq!(rig.line("cut A90 F300 S500"), "ok\n");
        rig.advance(800_000);
        rig.realtime(Realtime::Hold);
        assert_eq!(rig.state(), State::Hold);
        let status = rig.status_line();
        assert!(status.starts_with("<Run|"), "{status}");
        let mut waited = 0;
        while rig.status_line().starts_with("<Run|") {
            rig.advance(5_000);
            waited += 5_000;
            assert!(waited < 2_000_000, "the hold never came to rest");
        }
        let stopped = rig.port.count;
        let status = rig.status_line();
        assert!(status.starts_with("<Hold|"), "{status}");
        rig.realtime(Realtime::Reset);
        assert_eq!(rig.take_out(), "[MSG:reset]\n[spinny v0.1.0 lines:16 blocks:32]\n");
        assert_eq!(rig.state(), State::Idle);
        rig.advance(200_000);
        assert_eq!(rig.port.count, stopped, "stepping after the reset");
        assert_eq!(rig.machine.planned_position(), rig.executed_steps());
    }

    #[test]
    fn a_motion_line_during_a_hold_waits_for_the_resume() {
        // A host streams on through an operator's pause whenever it trails
        // the machine; the line must wait, not end the job with a refusal.
        let mut rig = Rig::new();
        rig.take_out();
        assert_eq!(rig.line("go R50"), "ok\n");
        assert_eq!(rig.line("cut A90 F300 S500"), "ok\n");
        rig.advance(800_000);
        rig.realtime(Realtime::Hold);
        rig.advance(600_000);
        assert!(rig.status_line().starts_with("<Hold|"));
        rig.submit("cut R40 A90");
        rig.advance(POLL_US * 4);
        assert_eq!(rig.take_out(), "", "answered during the hold");
        assert_eq!(rig.state(), State::Hold);
        assert!(!rig.machine.ready_for_line(), "a second line taken in behind the waiting one");
        rig.realtime(Realtime::Resume);
        rig.run();
        assert_eq!(rig.take_out(), "ok\n");
        let joint = rig.machine.joint();
        assert!((joint[R] - 40.0).abs() < 1e-3 && (joint[A] - 90.0).abs() < 1e-3, "{joint:?}");
    }

    #[test]
    fn a_hold_asked_while_a_line_waits_is_kept_for_that_line() {
        // The hold byte overtakes the line it was meant for: the machine
        // is idle when it arrives, and the line would otherwise run on.
        // Both arrive in one pass of the loop, as they do from a host that
        // writes the line and the hold together.
        let mut rig = Rig::new();
        rig.take_out();
        let mut queue = vec!["go R20"];
        rig.pass(&mut queue, &[Realtime::Hold]);
        assert_eq!(rig.take_out(), "ok\n");
        assert_eq!(rig.state(), State::Hold);
        rig.advance(500_000);
        assert_eq!(rig.port.count, [0, 0, 0, 0], "moved while held");
        assert_eq!(rig.laser.duty, 0);
        rig.realtime(Realtime::Resume);
        rig.run();
        assert_eq!(rig.machine.joint(), [20.0, 0.0, 0.0, 0.0]);
        // A hold kept for a line that is not motion is forgotten once it
        // has been read.
        let mut queue = vec!["$r_max"];
        rig.pass(&mut queue, &[Realtime::Hold]);
        assert_eq!(rig.take_out(), "r_max=0\nok\n");
        rig.advance(POLL_US);
        assert_eq!(rig.line("go R10"), "ok\n");
        assert_eq!(rig.state(), State::Run);
        rig.run();
        assert_eq!(rig.machine.joint(), [10.0, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn a_hold_kept_for_a_line_that_is_not_a_joint_move_applies_to_it() {
        // `laser S`: the hold closes the beam, so it never lights.
        let mut rig = Rig::new();
        rig.take_out();
        let mut queue = vec!["laser S800 T5000"];
        rig.pass(&mut queue, &[Realtime::Hold]);
        assert_eq!(rig.take_out(), "ok\n");
        rig.advance(100_000);
        assert_eq!(rig.laser.duty, 0, "the beam lit under a hold");
        assert_eq!(rig.state(), State::Idle);

        // A cross slide jog ends where it started, and the hold is not
        // left over for the next move.
        let mut queue = vec!["jog Z5 F60"];
        rig.pass(&mut queue, &[Realtime::Hold]);
        assert_eq!(rig.take_out(), "ok\n");
        rig.advance(500_000);
        assert_eq!(rig.slide.pulses, 0, "the slide ran under a hold");
        assert_eq!(rig.state(), State::Idle);
        assert_eq!(rig.line("go R1"), "ok\n");
        assert_eq!(rig.state(), State::Run, "a later move started held");
        rig.run();

        // A spindle start is held: the report says so, and the resume
        // starts it.
        assert_eq!(rig.line("$spindle=1"), "ok\n");
        let mut queue = vec!["spindle S500"];
        rig.pass(&mut queue, &[Realtime::Hold]);
        rig.advance(100_000);
        assert_eq!(rig.take_out(), "", "answered before the resume");
        assert_eq!(rig.laser.duty, 0);
        assert!(rig.status_line().starts_with("<Hold|"));
        rig.realtime(Realtime::Resume);
        rig.advance(POLL_US);
        assert_eq!(rig.take_out(), "ok\n");
        assert_eq!(rig.laser.duty, 500);
        assert_eq!(rig.state(), State::Idle);
    }

    #[test]
    fn reset_drops_a_pending_line_without_an_answer() {
        let mut rig = Rig::new();
        rig.take_out();
        assert_eq!(rig.line("go R2"), "ok\n");
        rig.submit("dwell T5000");
        rig.advance(POLL_US);
        assert!(!rig.machine.ready_for_line());
        rig.realtime(Realtime::Reset);
        assert!(rig.machine.ready_for_line());
        rig.run();
        assert!(!rig.take_out().contains("ok"));
    }

    #[test]
    fn jog_cancel_stops_short_and_ends_idle() {
        let mut rig = Rig::new();
        rig.take_out();
        assert_eq!(rig.line("jog R50"), "ok\n");
        assert_eq!(rig.line("jog A100"), "ok\n");
        rig.advance(1_000_000);
        assert_eq!(rig.state(), State::Jog);
        rig.realtime(Realtime::JogCancel);
        rig.run();
        assert_eq!(rig.state(), State::Idle);
        assert_eq!(rig.take_out(), "");
        let joint = rig.machine.joint();
        assert!(joint[R] > 1.0 && joint[R] < 50.0, "{joint:?}");
        assert_eq!(joint[A], 0.0);
        assert_eq!(rig.machine.planned_position(), rig.executed_steps());
    }

    #[test]
    fn jog_cancel_syncs_the_planner_and_answers_a_waiting_jog() {
        let mut rig = Rig::new();
        rig.take_out();
        assert_eq!(rig.line("jog R50"), "ok\n");
        rig.advance(1_000_000);
        rig.realtime(Realtime::JogCancel);
        rig.run();
        let steps = rig.executed_steps();
        assert_eq!(rig.machine.planned_position(), steps);
        assert_eq!(rig.port.count[R] as i32, steps[R]);
        // Back to the axis moves exactly the steps taken.
        assert_eq!(rig.line("go R0"), "ok\n");
        rig.run();
        assert_eq!(rig.port.count[R] as i32, 2 * steps[R]);
        assert_eq!(rig.machine.joint(), [0.0, 0.0, 0.0, 0.0]);

        // A jog waiting for planner room is answered and dropped by the cancel.
        for _ in 0..BLOCKS {
            assert_eq!(rig.line("jog R1 F60"), "ok\n");
        }
        rig.submit("jog R-10");
        rig.advance(POLL_US);
        assert!(!rig.machine.ready_for_line());
        rig.realtime(Realtime::JogCancel);
        rig.run();
        assert_eq!(rig.take_out(), "ok\n");
        assert!(rig.machine.ready_for_line());
        assert_eq!(rig.state(), State::Idle);
        assert!(rig.machine.joint()[R] < 2.0, "{:?}", rig.machine.joint());
        assert_eq!(rig.machine.planned_position(), rig.executed_steps());

        // Cancel from a hold entered while jogging.
        assert_eq!(rig.line("jog A90"), "ok\n");
        rig.advance(500_000);
        rig.realtime(Realtime::Hold);
        rig.advance(500_000);
        assert_eq!(rig.state(), State::Hold);
        rig.realtime(Realtime::JogCancel);
        rig.run();
        assert_eq!(rig.state(), State::Idle);
        assert!(rig.machine.joint()[A] < 90.0);
    }

    #[test]
    fn hold_closes_a_beam_lit_while_idle() {
        // Hold is the key an operator reaches for to stop everything. The
        // state machine has no Idle to Hold step, but the beam still goes
        // out, and stays out.
        let mut rig = Rig::new();
        rig.take_out();
        assert_eq!(rig.line("laser S800 T60000"), "ok\n");
        assert_eq!(rig.laser.duty, 800);

        rig.realtime(Realtime::Hold);
        assert_eq!(rig.laser.duty, 0, "hold left the beam lit");
        assert_eq!(rig.state(), State::Idle, "hold invented a state");
        rig.advance(1_000_000);
        assert_eq!(rig.laser.duty, 0, "the beam came back on its own");

        // Resume does not relight it, and the machine still works.
        rig.realtime(Realtime::Resume);
        assert_eq!(rig.laser.duty, 0, "resume relit a beam hold had closed");
        assert_eq!(rig.line("go R1"), "ok\n");
        rig.run();
        assert_eq!(rig.laser.duty, 0);
        assert!((rig.machine.joint()[R] - 1.0).abs() < 0.01);
    }

    #[test]
    fn laser_command_times_out() {
        let mut rig = Rig::new();
        rig.take_out();
        assert_eq!(rig.line("laser S500 T100"), "ok\n");
        assert_eq!(rig.laser.duty, 500);
        assert_eq!(rig.state(), State::Idle);
        let status = rig.status_line();
        assert_eq!(field(&status, "L:"), "500");
        rig.advance(50_000);
        assert_eq!(rig.laser.duty, 500);
        rig.advance(60_000);
        assert_eq!(rig.laser.duty, 0);
        // Default timeout and an explicit off.
        assert_eq!(rig.line("laser S1000"), "ok\n");
        assert_eq!(rig.laser.duty, 1000);
        rig.advance(4_000_000);
        assert_eq!(rig.laser.duty, 1000);
        assert_eq!(rig.line("laser off"), "ok\n");
        assert_eq!(rig.laser.duty, 0);
        // Over s_max is clamped, and motion turns the beam off.
        assert_eq!(rig.line("laser S2000 T60000"), "ok\n");
        assert_eq!(rig.laser.duty, 1000);
        assert_eq!(rig.line("go R1"), "ok\n");
        assert_eq!(rig.laser.duty, 0);
        rig.run();
        assert_eq!(rig.laser.duty, 0);
        // A hold turns the beam off for good.
        assert_eq!(rig.line("laser S300 T60000"), "ok\n");
        assert_eq!(rig.line("dwell T500"), "ok\n");
        assert_eq!(rig.laser.duty, 300);
        rig.submit("dwell T500");
        rig.advance(100_000);
        rig.realtime(Realtime::Hold);
        assert_eq!(rig.laser.duty, 0);
        rig.realtime(Realtime::Resume);
        rig.run();
        assert_eq!(rig.laser.duty, 0);
        assert_eq!(rig.take_out(), "ok\n");
    }

    #[test]
    fn dwell_with_power_burns_a_spot() {
        let mut rig = Rig::new();
        rig.take_out();
        assert_eq!(rig.line("go R10"), "ok\n");
        rig.submit("dwell T200 S250");
        // The dwell waits for the move and only then fires.
        rig.advance(100_000);
        assert_eq!(rig.laser.duty, 0);
        assert_eq!(rig.state(), State::Run);
        rig.run();
        assert_eq!(rig.take_out(), "ok\n");
        assert_eq!(rig.laser.duty, 0);
        assert_eq!(rig.state(), State::Idle);
        let on: Vec<&(u64, u16)> = rig.laser.duties.iter().filter(|&&(_, d)| d == 250).collect();
        assert_eq!(on.len(), 1);
        let start = on[0].0;
        let off = rig.laser.duties.iter().find(|&&(t, d)| t > start && d == 0).unwrap();
        let held = off.0 - start;
        assert!((199_000..=201_000).contains(&held), "{held}");

        // From idle the dwell starts at once, counts as Run, and a hold pauses it.
        rig.submit("dwell T300 S500");
        rig.advance(100_000);
        assert_eq!(rig.state(), State::Run);
        assert_eq!(rig.laser.duty, 500);
        // The dwell's own line is unanswered while it runs: one credit in use.
        assert_eq!(rig.status_line(), "<Run|J:10.000,0.0000|V:0|L:500|Q:32,15|M:dyn|E:1|Z:0.000>\n");
        rig.realtime(Realtime::Hold);
        assert_eq!(rig.laser.duty, 0);
        rig.advance(1_000_000);
        assert_eq!(rig.laser.duty, 0);
        assert_eq!(rig.take_out(), "");
        rig.realtime(Realtime::Resume);
        assert_eq!(rig.laser.duty, 500);
        rig.advance(150_000);
        assert_eq!(rig.laser.duty, 500);
        rig.advance(60_000);
        assert_eq!(rig.laser.duty, 0);
        assert_eq!(rig.take_out(), "ok\n");
        rig.run();
        assert_eq!(rig.state(), State::Idle);
        // A zero dwell without power answers at once.
        assert_eq!(rig.line("dwell T0"), "ok\n");
    }

    #[test]
    fn lining_up_can_step_through_the_axis_and_back() {
        // The head at radius zero is rarely over the axis to begin with.
        // Finding it means stepping past zero and back, and declaring the
        // position once the beam is on it, so both have to be allowed.
        let mut rig = Rig::new();
        rig.take_out();
        assert_eq!(rig.line("set R0 A0"), "ok\n");
        for _ in 0..4 {
            assert_eq!(rig.line("jog R-0.5"), "ok\n");
            rig.run();
        }
        assert_eq!(rig.machine.joint()[R], -2.0, "the head could not cross the axis");
        let status = rig.status_line();
        assert_eq!(field(&status, "J:").split(',').next().unwrap(), "-2.000");

        // Declared where it really is: the axis is now two out.
        assert_eq!(rig.line("set R-2"), "ok\n");
        assert_eq!(rig.machine.joint()[R], -2.0);
        assert_eq!(rig.line("jogto R0"), "ok\n");
        rig.run();
        assert_eq!(rig.machine.joint()[R], 0.0);

        // A soft limit still holds, on either side of the axis.
        assert_eq!(rig.line("$r_max=5"), "ok\n");
        assert_eq!(rig.line("jog R-6"), "error:4 out of range\n");
        assert_eq!(rig.line("jog R6"), "error:4 out of range\n");
        assert_eq!(rig.line("jog R-5"), "ok\n");
        rig.run();
        assert_eq!(rig.machine.joint()[R], -5.0);
    }

    #[test]
    fn set_declares_the_position() {
        let mut rig = Rig::new();
        rig.take_out();
        assert_eq!(rig.line("go R10 A45"), "ok\n");
        rig.run();
        assert_eq!(rig.status_line(), "<Idle|J:10.000,45.0000|V:0|L:0|Q:32,16|M:dyn|E:1|Z:0.000>\n");
        assert_eq!(rig.line("set R0"), "ok\n");
        assert_eq!(rig.executed_steps(), [0, 40000, 0, 0]);
        assert_eq!(rig.machine.planned_position(), [0, 40000, 0, 0]);
        assert_eq!(rig.status_line(), "<Idle|J:0.000,45.0000|V:0|L:0|Q:32,16|M:dyn|E:1|Z:0.000>\n");
        let before = rig.port.count;
        assert_eq!(rig.line("go R5 A0"), "ok\n");
        rig.run();
        assert_eq!(rig.port.count, [before[R] + 1280, before[A] + 40000, 0, 0]);
        assert_eq!(rig.machine.joint(), [5.0, 0.0, 0.0, 0.0]);
        assert_eq!(rig.line("set A-90 R1"), "ok\n");
        assert_eq!(rig.executed_steps(), [256, -80000, 0, 0]);
        assert_eq!(rig.status_line(), "<Idle|J:1.000,-90.0000|V:0|L:0|Q:32,16|M:dyn|E:1|Z:0.000>\n");
    }

    #[test]
    fn the_cross_slide_jogs_and_lands_where_it_was_asked() {
        let mut rig = Rig::new();
        rig.take_out();
        assert_eq!(rig.line("set Z0"), "ok\n");
        assert!(rig.status_line().ends_with("|Z:0.000>\n"));
        assert_eq!(rig.line("jog Z2"), "ok\n");
        rig.advance(POLL_US);
        assert_eq!(rig.state(), State::Jog, "the state is Jog while the slide moves");
        assert_eq!(rig.laser.duty, 0, "the beam is off throughout");
        rig.run();
        assert_eq!(rig.state(), State::Idle);
        assert_eq!(rig.machine.slide_position(), 2.0);
        assert_eq!(rig.slide.pulses, 512, "2 mm at 256 steps per mm");
        assert_eq!(rig.slide.dir, Some(true));
        assert!(rig.status_line().ends_with("|Z:2.000>\n"));
        // The joints did not move with it; the joint position carries the
        // slide's own.
        assert_eq!(rig.machine.joint(), [0.0, 0.0, 0.0, 2.0]);
        assert_eq!(rig.port.count, [0, 0, 0, 0]);

        // Relative jogs add up; an absolute one goes where it says.
        assert_eq!(rig.line("jog Z-0.5"), "ok\n");
        rig.run();
        assert_eq!(rig.machine.slide_position(), 1.5);
        assert_eq!(rig.slide.dir, Some(false));
        assert_eq!(rig.line("jogto Z-1"), "ok\n");
        rig.run();
        assert_eq!(rig.machine.slide_position(), -1.0);
        assert_eq!(rig.slide.pulses, 512 + 128 + 640);
        assert!(rig.status_line().ends_with("|Z:-1.000>\n"));

        // `set Z` declares the position without moving anything.
        assert_eq!(rig.line("set Z0"), "ok\n");
        assert_eq!(rig.machine.slide_position(), 0.0);
        assert_eq!(rig.slide.pulses, 512 + 128 + 640);
        // A move under one step answers and moves nothing.
        assert_eq!(rig.line("jog Z0.001"), "ok\n");
        rig.advance(POLL_US);
        assert_eq!(rig.state(), State::Idle);
        assert_eq!(rig.slide.pulses, 512 + 128 + 640);
    }

    #[test]
    fn the_cross_slide_moves_only_from_idle() {
        let mut rig = Rig::new();
        rig.take_out();
        assert_eq!(rig.line("go R50"), "ok\n");
        rig.advance(200_000);
        assert_eq!(rig.state(), State::Run);
        assert_eq!(rig.line("jog Z1"), "error:5 not now\n");
        assert_eq!(rig.line("jogto Z1"), "error:5 not now\n");
        assert_eq!(rig.line("set Z1"), "error:5 not now\n");
        rig.run();

        // Nor while a joint jog is running, which shares the rail.
        assert_eq!(rig.line("jog R-10"), "ok\n");
        rig.advance(50_000);
        assert_eq!(rig.state(), State::Jog);
        assert_eq!(rig.line("jog Z1"), "error:5 not now\n");
        rig.run();

        // And nothing else moves while the slide does.
        assert_eq!(rig.line("jog Z5"), "ok\n");
        rig.advance(POLL_US);
        assert_eq!(rig.state(), State::Jog);
        assert_eq!(rig.line("go R1"), "error:5 not now\n");
        assert_eq!(rig.line("jog R1"), "error:5 not now\n");
        assert_eq!(rig.line("set R0"), "error:5 not now\n");
        assert_eq!(rig.line("jog Z1"), "error:5 not now\n");
        rig.run();
        assert_eq!(rig.machine.slide_position(), 5.0);

        // The two are never on one line.
        assert_eq!(rig.line("jog Z1 R1"), "error:2 bad word\n");
        assert_eq!(rig.line("set R0 Z0"), "error:2 bad word\n");
        assert_eq!(rig.machine.slide_position(), 5.0);
    }

    #[test]
    fn a_cross_slide_jog_is_canceled_and_stopped_by_the_realtime_bytes() {
        let mut rig = Rig::new();
        rig.take_out();
        assert_eq!(rig.line("set Z0"), "ok\n");
        assert_eq!(rig.line("jog Z20"), "ok\n");
        rig.advance(200_000);
        assert_eq!(rig.state(), State::Jog);
        // A hold brakes it too, and ends it: there is no queue behind a
        // setup move for a resume to pick up.
        rig.realtime(Realtime::Hold);
        rig.run();
        assert_eq!(rig.state(), State::Idle);
        let held = rig.machine.slide_position();
        assert!(held > 0.0 && held < 20.0, "stopped at {held}");
        rig.realtime(Realtime::Resume);
        rig.advance(1_000_000);
        assert_eq!(rig.state(), State::Idle);
        assert_eq!(rig.machine.slide_position(), held, "a resume has nothing to take up");
        assert_eq!(rig.line("jogto Z0"), "ok\n");
        rig.run();

        let before = rig.slide.pulses;
        assert_eq!(rig.line("jog Z20"), "ok\n");
        rig.advance(200_000);
        assert_eq!(rig.state(), State::Jog);
        rig.realtime(Realtime::JogCancel);
        rig.run();
        assert_eq!(rig.state(), State::Idle);
        assert_eq!(rig.take_out(), "");
        let canceled = rig.machine.slide_position();
        assert!(canceled > 0.1 && canceled < 20.0, "stopped at {canceled}");
        // Every pulse is in the position it reports.
        assert_eq!(rig.slide.pulses - before, (canceled * 256.0) as u64);
        // It stays stopped, and takes the next move from where it is.
        rig.advance(1_000_000);
        assert_eq!(rig.slide.pulses - before, (canceled * 256.0) as u64);
        assert_eq!(rig.line("jogto Z0"), "ok\n");
        rig.run();
        assert_eq!(rig.machine.slide_position(), 0.0);

        // A reset drops the move where it stands, with no alarm: the
        // slide counts its own steps, so its position is still good.
        let before = rig.slide.pulses;
        assert_eq!(rig.line("jog Z20"), "ok\n");
        rig.advance(200_000);
        let moving = rig.machine.slide_position();
        rig.realtime(Realtime::Reset);
        rig.take_out();
        rig.advance(1_000_000);
        assert_eq!(rig.state(), State::Idle);
        let stopped = rig.machine.slide_position();
        assert!(stopped >= moving && stopped < 20.0, "{moving} then {stopped}");
        assert_eq!(rig.slide.pulses - before, (stopped * 256.0) as u64);
        rig.advance(1_000_000);
        assert_eq!(rig.machine.slide_position(), stopped, "a reset slide steps no more");
    }

    #[test]
    fn a_disconnect_stops_the_cross_slide() {
        let mut rig = Rig::new();
        rig.take_out();
        assert_eq!(rig.line("set Z0"), "ok\n");
        assert_eq!(rig.line("jog Z20"), "ok\n");
        rig.advance(200_000);
        assert_eq!(rig.state(), State::Jog);
        rig.laser.now = rig.now;
        rig.machine.disconnected(&mut rig.laser);
        let at = rig.machine.slide_position();
        assert!(at > 0.0 && at < 20.0, "stopped at {at}");
        rig.advance(1_000_000);
        assert_eq!(rig.state(), State::Idle);
        assert_eq!(rig.machine.slide_position(), at);
        assert!(rig.machine.is_quiet());
    }

    #[test]
    fn settings_change_only_while_idle() {
        let mut rig = Rig::new();
        rig.take_out();
        assert_eq!(rig.line("go R50"), "ok\n");
        rig.advance(100_000);
        assert_eq!(rig.line("$r_max=20"), "error:5 not now\n");
        assert_eq!(rig.line("$r_max"), "r_max=0\nok\n");
        assert_eq!(rig.line("$defaults"), "error:5 not now\n");
        assert_eq!(rig.line("$load"), "error:5 not now\n");
        rig.run();
        assert_eq!(rig.line("$r_max=20"), "ok\n");
        assert_eq!(rig.line("$r_max"), "r_max=20\nok\n");
        assert_eq!(rig.line("$nope"), "error:6 unknown setting\n");
        assert_eq!(rig.line("$nope=1"), "error:6 unknown setting\n");
        assert_eq!(rig.line("$r_max=-1"), "error:7 bad setting value\n");
        assert_eq!(rig.line("go R30"), "error:4 out of range\n");
        assert_eq!(rig.line("go R20"), "ok\n");
        rig.run();
        assert_eq!(rig.line("jog R0.01"), "error:4 out of range\n");
        assert_eq!(rig.line("jog R0.001"), "ok\n");
        rig.run();
        assert_eq!(rig.line("$tmc_r_ma=500"), "ok\n");
        assert!(rig.machine.take_events().driver_config);
        assert_eq!(rig.line("$laser_hz=20000"), "ok\n");
        rig.advance(POLL_US);
        assert_eq!(rig.laser.hz, 20000);
        assert_eq!(rig.line("$tmc"), "ok\n");
        assert_eq!(rig.machine.take_events(), Events { driver_config: false, driver_report: true });
        let listing = rig.line("$");
        assert!(listing.starts_with("r_steps=256\n"));
        assert!(listing.ends_with("z_home_travel=200\nstop_invert=0\nlimits=0\nok\n"));
        assert_eq!(listing.lines().count(), crate::settings::NAMES.len() + 1);
    }

    #[test]
    fn save_and_load_round_trip_through_the_store() {
        let mut rig = Rig::new();
        rig.take_out();
        assert_eq!(rig.line("$r_max=12.5"), "ok\n");
        assert_eq!(rig.line("$tmc_stealth=0"), "ok\n");
        assert_eq!(rig.line("$save"), "ok\n");
        assert_eq!(rig.store.saves, 1);
        assert_eq!(rig.store.blob.as_ref().map(|b| b.len()), Some(BLOB_LEN));
        rig.machine.take_events();
        assert_eq!(rig.line("$defaults"), "ok\n");
        assert_eq!(rig.machine.settings().r_max, 0.0);
        assert!(rig.machine.take_events().driver_config);
        assert_eq!(rig.line("$load"), "ok\n");
        assert_eq!(rig.machine.settings().r_max, 12.5);
        assert!(!rig.machine.settings().tmc_stealth);
        assert!(rig.machine.take_events().driver_config);
        // A fresh machine boots from the same store.
        let mut other = Rig::new();
        other.store.blob = rig.store.blob.clone();
        assert!(other.machine.load_settings(&mut other.store));
        assert_eq!(other.machine.settings().r_max, 12.5);
        assert!(other.machine.take_events().driver_config);
        // Nothing stored, or a bad blob, keeps the settings.
        let mut empty = Rig::new();
        assert!(!empty.machine.load_settings(&mut empty.store));
        assert!(empty.machine.take_events().driver_config);
        empty.store.blob = Some(std::vec![0xAA; BLOB_LEN]);
        assert!(!empty.machine.load_settings(&mut empty.store));
        assert_eq!(*empty.machine.settings(), bench_settings(), "a bad blob changed the settings");
        empty.take_out();
        assert_eq!(empty.line("$load"), "error:9 flash failed\n");
        // A failing write answers error 9.
        rig.store.fail = true;
        assert_eq!(rig.line("$save"), "error:9 flash failed\n");
    }

    #[test]
    fn disconnect_stops_and_turns_the_beam_off() {
        let mut rig = Rig::new();
        rig.take_out();
        assert_eq!(rig.line("laser S600 T60000"), "ok\n");
        assert_eq!(rig.laser.duty, 600);
        rig.machine.disconnected(&mut rig.laser);
        assert_eq!(rig.laser.duty, 0);
        assert_eq!(rig.state(), State::Idle);
        assert_eq!(rig.take_out(), "");
        rig.advance(POLL_US);
        assert_eq!(rig.laser.duty, 0);

        assert_eq!(rig.line("cut R50 F600 S800"), "ok\n");
        rig.advance(1_000_000);
        assert!(rig.laser.duty > 0);
        rig.machine.disconnected(&mut rig.laser);
        assert_eq!(rig.laser.duty, 0);
        assert_eq!(rig.state(), State::Alarm(1));
        rig.advance(20_000);
        let stopped = rig.port.count;
        rig.advance(500_000);
        assert_eq!(rig.port.count, stopped);
        assert_eq!(rig.laser.duty, 0);
        assert_eq!(rig.take_out(), "");
        // The motors stay enabled.
        assert_eq!(rig.port.enable_level, Some(false));
        assert!(rig.machine.ready_for_line());
        assert_eq!(rig.line("unlock"), "ok\n");
        assert_eq!(rig.line("go R0"), "ok\n");
        rig.run();
        assert_eq!(rig.machine.joint(), [0.0, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn immediate_commands_answer_with_ok() {
        let mut rig = Rig::new();
        rig.take_out();
        assert_eq!(rig.line("version"), "[spinny v0.1.0 lines:16 blocks:32]\nok\n");
        assert_eq!(rig.line("status"), "<Idle|J:0.000,0.0000|V:0|L:0|Q:32,16|M:dyn|E:0|Z:0.000>\nok\n");
        let help = rig.line("help");
        assert!(help.ends_with("ok\n"));
        assert!(help.contains("jogto") && help.contains("jog Z"));
        assert!(help.lines().all(|l| !l.starts_with('<') && !l.starts_with('[')));
    }

    #[test]
    fn enable_disable_and_the_idle_timer() {
        let mut rig = Rig::new();
        rig.advance(POLL_US);
        assert_eq!(rig.port.enable_level, Some(true), "disabled is high with the active low default");
        rig.take_out();
        assert_eq!(rig.line("enable"), "ok\n");
        assert_eq!(rig.port.enable_level, Some(false));
        assert!(rig.status_line().contains("|E:1|"));
        assert_eq!(rig.line("disable"), "ok\n");
        assert_eq!(rig.port.enable_level, Some(true));
        assert!(rig.status_line().contains("|E:0|"));
        assert_eq!(rig.line("$en_invert=1"), "ok\n");
        rig.advance(POLL_US);
        assert_eq!(rig.port.enable_level, Some(false));
        assert_eq!(rig.line("go R1"), "ok\n");
        assert_eq!(rig.port.enable_level, Some(true));
        rig.run();
        // Enabled while a job is queued: an enable behind motion waits for it.
        assert_eq!(rig.line("$idle_ms=100"), "ok\n");
        assert_eq!(rig.line("$en_invert=0"), "ok\n");
        rig.advance(50_000);
        assert!(rig.status_line().contains("|E:1|"));
        rig.advance(60_000);
        assert!(rig.status_line().contains("|E:0|"));
        assert_eq!(rig.port.enable_level, Some(true));
        assert_eq!(rig.line("go R2"), "ok\n");
        assert_eq!(rig.port.enable_level, Some(false));
        rig.submit("enable");
        rig.advance(POLL_US);
        assert!(!rig.machine.ready_for_line());
        rig.run();
        assert_eq!(rig.take_out(), "ok\n");
        rig.advance(200_000);
        assert!(rig.status_line().contains("|E:0|"));
    }

    #[test]
    fn mode_and_inversion_reach_the_laser() {
        let mut settings = Settings::default();
        settings.laser_invert = true;
        let mut rig = Rig::with(settings);
        rig.advance(POLL_US);
        assert_eq!(rig.laser.duty, 1000);
        rig.take_out();
        assert_eq!(rig.line("laser S250 T50"), "ok\n");
        assert_eq!(rig.laser.duty, 750);
        assert!(rig.status_line().contains("|L:750|"));
        rig.advance(60_000);
        assert_eq!(rig.laser.duty, 1000);
        assert_eq!(rig.line("mode const"), "ok\n");
        assert_eq!(rig.machine.mode(), PowerMode::Constant);
        assert_eq!(rig.line("cut R10 F600 S400"), "ok\n");
        rig.run();
        assert_eq!(rig.min_duty_while_stepping, 600);
        assert_eq!(rig.max_duty_while_stepping, 600);
        assert_eq!(rig.laser.duty, 1000);
        assert!(rig.status_line().contains("|M:const|"));
    }

    /// Duties the laser was driven with from `from` on.
    fn duties_since(rig: &Rig, from: usize) -> Vec<u16> {
        rig.laser.duties[from..].iter().map(|&(_, duty)| duty).collect()
    }

    #[test]
    fn a_hold_keeps_the_beam_off_through_the_whole_ramp() {
        for mode in ["mode const", "mode dyn"] {
            let mut rig = Rig::new();
            rig.take_out();
            assert_eq!(rig.line(mode), "ok\n");
            assert_eq!(rig.line("cut R40 F600 S1000"), "ok\n");
            rig.advance(1_000_000);
            assert!(rig.laser.duty > 0, "{mode}: the cut should be burning");
            rig.realtime(Realtime::Hold);
            assert_eq!(rig.laser.duty, 0, "{mode}");
            // The segments the hold catches in the ring, and the ramp the
            // front writes after it, must all run dark.
            let from = rig.laser.duties.len();
            rig.advance(2_000_000);
            assert_eq!(rig.state(), State::Hold, "{mode}");
            assert_eq!(duties_since(&rig, from), Vec::<u16>::new(), "{mode}: beam lit during the hold");
            // The resume cuts again and the job finishes.
            rig.realtime(Realtime::Resume);
            rig.advance(1_000_000);
            assert!(rig.laser.duty > 0, "{mode}: the resume should cut again");
            rig.run();
            assert_eq!(rig.laser.duty, 0, "{mode}");
            assert_eq!(rig.machine.joint(), [40.0, 0.0, 0.0, 0.0], "{mode}");
        }
    }

    #[test]
    fn a_dwell_waiting_behind_a_cut_does_not_fire_during_a_hold() {
        let mut rig = Rig::new();
        rig.take_out();
        // A cut short enough that its whole profile fits the segment ring:
        // the planner is empty while the stepper is still running it.
        assert_eq!(rig.line("cut R0.1 F600 S500"), "ok\n");
        rig.submit("dwell T2000 S1000");
        rig.advance(POLL_US);
        assert!(!rig.machine.ready_for_line());
        assert_eq!(rig.state(), State::Run);
        rig.realtime(Realtime::Hold);
        assert_eq!(rig.state(), State::Hold);
        assert_eq!(rig.laser.duty, 0);
        rig.advance(1_000_000);
        assert_eq!(rig.state(), State::Hold, "the dwell took the machine out of the hold");
        assert_eq!(rig.laser.duty, 0, "the dwell burnt a spot during the hold");
        assert_eq!(rig.take_out(), "");
        // The resume runs it, and the stepper was not left holding.
        rig.realtime(Realtime::Resume);
        rig.advance(POLL_US);
        assert_eq!(rig.laser.duty, 1000);
        rig.advance(2_100_000);
        assert_eq!(rig.laser.duty, 0);
        assert_eq!(rig.take_out(), "ok\n");
        rig.run();
        assert_eq!(rig.state(), State::Idle);
        assert_eq!(rig.line("go R1"), "ok\n");
        rig.run();
        assert_eq!(rig.machine.joint()[R], 1.0);
    }

    #[test]
    fn a_load_reaches_the_ports_in_the_poll_that_answers_it() {
        let mut rig = Rig::new();
        rig.take_out();
        assert_eq!(rig.line("$laser_invert=1"), "ok\n");
        assert_eq!(rig.line("$en_invert=1"), "ok\n");
        assert_eq!(rig.line("$save"), "ok\n");
        assert_eq!(rig.line("$laser_invert=0"), "ok\n");
        assert_eq!(rig.line("$en_invert=0"), "ok\n");
        rig.advance(POLL_US);
        assert_eq!(rig.laser.duty, 0);
        assert_eq!(rig.port.enable_level, Some(true));
        // The stored settings drive both outputs the other way round. A
        // poll of lag here is a poll of full beam on an active low output.
        assert_eq!(rig.line("$load"), "ok\n");
        assert!(rig.machine.settings().laser_invert);
        assert_eq!(rig.laser.duty, 1000, "the load left the beam lit");
        assert_eq!(rig.port.enable_level, Some(false), "the load left the enable pin inverted");
    }

    #[test]
    fn a_move_past_the_step_counter_range_is_refused() {
        let mut rig = Rig::new();
        rig.take_out();
        let steps = rig.machine.settings().steps;
        let over_a = 1.5 * stepper::MAX_EVENTS as f32 / steps[A];
        let over_r = 1.5 * stepper::MAX_EVENTS as f32 / steps[R];
        assert_eq!(rig.line(&std::format!("go A{over_a:.0}")), "error:4 out of range\n");
        assert_eq!(rig.line(&std::format!("jog A-{over_a:.0}")), "error:4 out of range\n");
        assert_eq!(rig.line(&std::format!("go R{over_r:.0}")), "error:4 out of range\n");
        assert_eq!(rig.line(&std::format!("cut A{over_a:.0} F600")), "error:4 out of range\n");
        assert_eq!(rig.machine.planned_position(), [0, 0, 0, 0]);
        assert!(rig.machine.ready_for_line());
        // What fits is still taken, and the limit is on the move, not on
        // the angle reached: another one of the same size follows it.
        let long = 0.9 * stepper::MAX_EVENTS as f32 / steps[A];
        assert_eq!(rig.line(&std::format!("go A{long:.0}")), "ok\n");
        let first = rig.machine.planned_position()[A];
        assert!(first > 0 && (first as u32) < stepper::MAX_EVENTS);
        assert_eq!(rig.line(&std::format!("go A{:.0}", 2.0 * long)), "ok\n");
        assert_eq!(rig.machine.planned_position()[A], 2 * first);
    }

    #[test]
    fn the_stored_polarity_reaches_the_port_before_the_first_poll() {
        let mut settings = Settings::default();
        settings.laser_invert = true;
        let mut rig = Rig::with(settings);
        // The board claims the pin low, reads the stored settings and then
        // calls this; nothing has polled yet.
        assert_eq!(rig.laser.duty, 0);
        rig.machine.drive_laser(&mut rig.laser);
        assert_eq!(rig.laser.duty, 1000, "an active low output must read off at boot");
    }

    #[test]
    fn a_planner_that_runs_dry_mid_job_drops_the_beam() {
        let mut rig = Rig::new();
        rig.take_out();
        assert_eq!(rig.line("mode const"), "ok\n");
        assert_eq!(rig.line("cut R5 F600 S800"), "ok\n");
        rig.advance(200_000);
        assert_eq!(rig.laser.duty, 800);
        // Nothing follows it: the stepper drains and the beam goes out.
        rig.run();
        assert_eq!(rig.state(), State::Idle);
        assert_eq!(rig.laser.duty, 0);
        rig.advance(2_000_000);
        assert_eq!(rig.laser.duty, 0, "lit while the host was late");
        // The next cut starts it again.
        assert_eq!(rig.line("cut R10 F600"), "ok\n");
        rig.advance(200_000);
        assert_eq!(rig.laser.duty, 800);
        rig.run();
        assert_eq!(rig.laser.duty, 0);
    }

    #[test]
    fn a_rapid_after_a_cut_runs_dark() {
        let mut rig = Rig::new();
        rig.take_out();
        assert_eq!(rig.line("mode const"), "ok\n");
        assert_eq!(rig.line("cut R20 F600 S700"), "ok\n");
        assert_eq!(rig.line("go R40"), "ok\n");
        rig.advance(500_000);
        assert_eq!(rig.laser.duty, 700, "the cut should be burning");
        let from = rig.laser.duties.len();
        rig.run();
        // One change, to off, at the block boundary; nothing lights again.
        assert_eq!(duties_since(&rig, from), std::vec![0u16]);
        assert_eq!(rig.machine.joint(), [40.0, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn a_settings_change_redrives_a_lit_beam() {
        let mut rig = Rig::new();
        rig.take_out();
        assert_eq!(rig.line("laser S250 T60000"), "ok\n");
        assert_eq!(rig.laser.duty, 250);
        // `s_max` rescales the same S, and S over it is full duty, not more.
        assert_eq!(rig.line("$s_max=500"), "ok\n");
        rig.advance(POLL_US);
        assert_eq!(rig.laser.duty, 500);
        assert_eq!(rig.line("$s_max=200"), "ok\n");
        rig.advance(POLL_US);
        assert_eq!(rig.laser.duty, 1000);
        // The polarity flips the driven level, not the power.
        assert_eq!(rig.line("$s_max=1000"), "ok\n");
        assert_eq!(rig.line("$laser_invert=1"), "ok\n");
        rig.advance(POLL_US);
        assert_eq!(rig.laser.duty, 750);
        assert_eq!(rig.line("laser off"), "ok\n");
        assert_eq!(rig.laser.duty, 1000, "off on an active low output is full duty");
        // `s_min` is a dynamic mode rule; it does not touch a constant beam.
        assert_eq!(rig.line("$s_min=900"), "ok\n");
        assert_eq!(rig.line("laser S100 T60000"), "ok\n");
        assert_eq!(rig.laser.duty, 900);
    }

    #[test]
    fn a_cross_slide_jog_closes_a_constant_beam() {
        let mut rig = Rig::new();
        rig.take_out();
        assert_eq!(rig.line("set Z0"), "ok\n");
        assert_eq!(rig.line("laser S800 T60000"), "ok\n");
        assert_eq!(rig.laser.duty, 800);
        assert_eq!(rig.line("jog Z2"), "ok\n");
        assert_eq!(rig.laser.duty, 0, "the beam goes out before the slide moves");
        rig.advance(POLL_US);
        assert_eq!(rig.state(), State::Jog);
        assert_eq!(rig.laser.duty, 0);
        rig.run();
        assert_eq!(rig.state(), State::Idle);
        assert_eq!(rig.laser.duty, 0, "and does not come back with the idle");
        assert_eq!(rig.machine.slide_position(), 2.0);
    }

    #[test]
    fn a_jog_during_a_cancel_brake_is_refused() {
        let mut rig = Rig::new();
        rig.take_out();
        assert_eq!(rig.line("jog R50"), "ok\n");
        rig.advance(1_000_000);
        rig.realtime(Realtime::JogCancel);
        rig.advance(POLL_US);
        assert_eq!(rig.state(), State::Jog, "still braking");
        assert_eq!(rig.line("jog R-10"), "error:5 not now\n");
        rig.run();
        assert_eq!(rig.state(), State::Idle);
        let braked = rig.machine.joint()[R];
        // Once it has stopped a jog is taken again, and runs.
        assert_eq!(rig.line("jog R-1"), "ok\n");
        rig.run();
        assert!((rig.machine.joint()[R] - (braked - 1.0)).abs() < 0.01);
    }

    #[test]
    fn the_status_counts_the_lines_the_port_holds() {
        let mut rig = Rig::new();
        rig.take_out();
        assert_eq!(field(&rig.status_line(), "Q:"), "32,16");
        rig.machine.note_lines_waiting(5);
        assert_eq!(field(&rig.status_line(), "Q:"), "32,11");
        // A line pending in the machine is unanswered too.
        for i in 1..=BLOCKS {
            assert_eq!(rig.line(&std::format!("cut R{i} F60")), "ok\n");
        }
        rig.submit("go R0");
        rig.advance(POLL_US);
        assert!(!rig.machine.ready_for_line());
        let status = rig.status_line();
        assert_eq!(field(&status, "Q:").split_once(',').unwrap().1, "10", "{status}");
        rig.realtime(Realtime::Reset);
        rig.take_out();
        rig.machine.note_lines_waiting(0);
        rig.run();
        assert_eq!(field(&rig.status_line(), "Q:"), "32,16");
    }

    #[test]
    fn a_position_past_the_step_range_is_refused() {
        let mut rig = Rig::new();
        rig.take_out();
        // At 888.889 steps per degree the i32 range ends near 2415919 degrees.
        assert_eq!(rig.line("set A2400000"), "ok\n");
        assert!((rig.machine.joint()[A] - 2_400_000.0).abs() < 1.0);
        assert_eq!(rig.line("set A2500000"), "error:4 out of range\n");
        assert_eq!(rig.line("go A2500000"), "error:4 out of range\n");
        assert_eq!(rig.line("jog A-5000000"), "error:4 out of range\n");
        assert_eq!(rig.line("set R9000000"), "error:4 out of range\n");
        assert_eq!(rig.line("set Z9000000"), "error:4 out of range\n");
        assert_eq!(rig.line("jog Z9000000"), "error:4 out of range\n");
        assert!((rig.machine.joint()[A] - 2_400_000.0).abs() < 1.0);
        assert_eq!(rig.state(), State::Idle);
    }

    #[test]
    fn a_reset_in_alarm_keeps_the_alarm_until_unlock() {
        let mut rig = Rig::new();
        rig.take_out();
        assert_eq!(rig.line("go R50"), "ok\n");
        rig.advance(500_000);
        rig.realtime(Realtime::Reset);
        rig.run();
        assert_eq!(rig.state(), State::Alarm(1));
        rig.take_out();
        rig.realtime(Realtime::Reset);
        assert_eq!(rig.take_out(), "[MSG:reset]\n[spinny v0.1.0 lines:16 blocks:32]\n");
        assert_eq!(rig.state(), State::Alarm(1), "a reset does not stand in for unlock");
        rig.machine.disconnected(&mut rig.laser);
        assert_eq!(rig.state(), State::Alarm(1));
        assert_eq!(rig.line("unlock"), "ok\n");
        assert_eq!(rig.state(), State::Idle);
    }

    #[test]
    fn a_feed_below_the_floor_is_refused() {
        let mut rig = Rig::new();
        rig.take_out();
        assert_eq!(rig.line("cut R1 F0.0001 S500"), "error:4 out of range\n");
        assert_eq!(rig.line("jog R1 F0"), "error:4 out of range\n");
        assert_eq!(rig.line("cut R0.001 F0.001 S500"), "ok\n");
        rig.realtime(Realtime::Reset);
        rig.run();
    }

    /// The bench with a focus axis fitted: 256 steps/mm, so a step is
    /// 3.90625 um and a sixteenth of a millimeter is a whole step count.
    fn focus_rig() -> Rig {
        let mut rig = Rig::with(Settings { h_axis: true, ..bench_settings() });
        rig.take_out();
        rig
    }

    #[test]
    fn focus_words_are_refused_without_the_axis() {
        let mut rig = Rig::new();
        rig.take_out();
        for line in ["go H1", "cut R1 H1 F100 S10", "jog H1", "jogto H1", "set H0", "probe H-1"] {
            assert_eq!(rig.line(line), "error:2 bad word\n", "{line}");
        }
        assert_eq!(rig.port.count, [0, 0, 0, 0]);
        assert!(rig.status_line().ends_with("|Z:0.000>\n"), "no focus fields without the axis");
    }

    #[test]
    fn a_cut_carries_the_focus_axis_along() {
        let mut rig = focus_rig();
        assert_eq!(rig.line("cut R10 H0.5 F600 S100"), "ok\n");
        let start = rig.now;
        rig.run();
        assert_eq!(rig.port.count, [2560, 0, 128, 0]);
        assert_eq!(rig.machine.joint(), [10.0, 0.0, 0.5, 0.0]);
        // 10 mm on the board at 600 mm/min: the focus axis follows the cut
        // rather than setting its pace.
        let seconds = (rig.now - start) as f64 / 1e6;
        assert!(seconds > 0.95 && seconds < 1.3, "{seconds} s");
        assert!(rig.status_line().ends_with("|H:0.500|P:0>\n"));
    }

    #[test]
    fn a_focus_jog_runs_at_its_own_feed() {
        let mut rig = focus_rig();
        assert_eq!(rig.line("jog H2 F60"), "ok\n");
        let start = rig.now;
        rig.run();
        let seconds = (rig.now - start) as f64 / 1e6;
        assert!(seconds > 1.9 && seconds < 2.2, "{seconds} s for 2 mm at 60 mm/min");
        assert_eq!(rig.machine.joint()[H], 2.0);
        assert_eq!(rig.line("jogto H-0.25"), "ok\n");
        rig.run();
        assert_eq!(rig.machine.joint()[H], -0.25);
        assert_eq!(rig.line("set H3"), "ok\n");
        assert_eq!(rig.machine.joint()[H], 3.0);
    }

    #[test]
    fn a_probe_stops_at_contact_and_reports_where() {
        let mut rig = focus_rig();
        rig.surface = Some(-1.25);
        assert_eq!(rig.line("probe H-5 F60"), "[PRB:-1.2500:1]\nok\n");
        assert_eq!(rig.state(), State::Idle);
        // It stopped a braking distance past the contact, not at the end.
        // At 1 mm/s the head stops within a few hundredths past contact.
        let h = rig.machine.joint()[H];
        assert!(h <= -1.25 && h > -1.3, "stopped at {h}");
        assert!(rig.status_line().ends_with("|P:1>\n"));
        // The next line runs as usual.
        assert_eq!(rig.line("jogto H1"), "ok\n");
        rig.run();
        assert_eq!(rig.machine.joint()[H], 1.0);
        assert!(rig.status_line().ends_with("|H:1.000|P:0>\n"));
    }

    #[test]
    fn a_probe_that_finds_nothing_raises_an_alarm() {
        let mut rig = focus_rig();
        assert_eq!(
            rig.line("probe H-1 F120"),
            "[PRB:-1.0000:0]\nALARM:2 probe missed, check the head before moving\nerror:11 probe missed\n"
        );
        assert_eq!(rig.state(), State::Alarm(2));
        assert_eq!(rig.line("go R1"), "error:5 not now\n");
        assert_eq!(rig.line("unlock"), "ok\n");
        assert_eq!(rig.line("jog H1"), "ok\n");
        rig.run();
        assert_eq!(rig.machine.joint()[H], 0.0);
    }

    #[test]
    fn a_probe_already_touching_does_not_move() {
        let mut rig = focus_rig();
        rig.surface = Some(0.5);
        rig.advance(POLL_US);
        assert_eq!(rig.line("probe H-1"), "error:10 probe active\n");
        assert_eq!(rig.port.count, [0, 0, 0, 0]);
        assert_eq!(rig.state(), State::Idle);
    }

    #[test]
    fn a_probe_active_high_follows_the_setting() {
        let mut rig = Rig::with(Settings { h_axis: true, probe_invert: true, ..bench_settings() });
        rig.take_out();
        // Open reads high, which is contact for an active-high input.
        assert_eq!(rig.line("probe H-1"), "error:10 probe active\n");
    }

    #[test]
    fn a_probe_waits_for_the_move_before_it() {
        let mut rig = focus_rig();
        rig.surface = Some(-1.0);
        rig.submit("go R5 H1");
        assert_eq!(rig.line("probe H-3 F120"), "ok\n", "the go's own answer");
        rig.run();
        assert_eq!(rig.take_out(), "[PRB:-1.0000:1]\nok\n");
        assert_eq!(rig.machine.joint()[R], 5.0);
        assert_eq!(rig.state(), State::Idle);
    }

    #[test]
    fn nothing_runs_behind_a_probe_until_it_is_answered() {
        let mut rig = focus_rig();
        rig.surface = Some(-2.0);
        rig.submit("probe H-3 F60");
        rig.advance(POLL_US);
        assert!(!rig.machine.ready_for_line(), "the probe is still pending");
        assert_eq!(rig.state(), State::Jog);
        let status = rig.status_line();
        assert!(status.starts_with("<Jog|"), "{status}");
        rig.run();
        assert_eq!(rig.take_out(), "[PRB:-2.0000:1]\nok\n");
    }

    #[test]
    fn a_jog_cancel_ends_a_probe_without_an_alarm() {
        let mut rig = focus_rig();
        rig.submit("probe H-10 F60");
        rig.advance(1_000_000);
        rig.realtime(Realtime::JogCancel);
        rig.run();
        let out = rig.take_out();
        assert!(out.starts_with("[PRB:-") && out.ends_with(":0]\nok\n"), "{out:?}");
        assert_eq!(rig.state(), State::Idle);
        let h = rig.machine.joint()[H];
        assert!(h < -0.95 && h > -1.05, "stopped at {h}");
    }

    #[test]
    fn a_resume_during_the_contact_brake_does_not_lift_the_brake() {
        let mut rig = focus_rig();
        rig.surface = Some(-1.25);
        rig.submit("probe H-5 F60");
        let mut waited = 0;
        while rig.machine.front.probe_contact().is_none() {
            rig.advance(POLL_US);
            waited += 1;
            assert!(waited < 20_000, "no contact");
        }
        // The operator pauses and resumes while the head brakes at the
        // contact.
        rig.realtime(Realtime::Hold);
        rig.advance(1_000);
        rig.realtime(Realtime::Resume);
        rig.run();
        assert_eq!(rig.take_out(), "[PRB:-1.2500:1]\nok\n");
        assert_eq!(rig.state(), State::Idle);
        let h = rig.machine.joint()[H];
        assert!(h <= -1.25 && h > -1.3, "stopped at {h}");
    }

    #[test]
    fn a_jog_cancel_ends_a_probe_waiting_behind_the_jog_unrun() {
        for hold_first in [false, true] {
            let mut rig = focus_rig();
            rig.surface = Some(-1.0);
            assert_eq!(rig.line("jog R40 F600"), "ok\n");
            rig.submit("probe H-3 F60");
            rig.advance(200_000);
            if hold_first {
                rig.realtime(Realtime::Hold);
                rig.advance(200_000);
            }
            rig.realtime(Realtime::JogCancel);
            rig.run();
            assert_eq!(rig.take_out(), "[PRB:0.0000:0]\nok\n", "hold first: {hold_first}");
            assert_eq!(rig.state(), State::Idle);
            assert_eq!(rig.machine.joint()[H], 0.0, "the head went down after the cancel");
        }
    }

    #[test]
    fn a_turning_spindle_keeps_the_drivers_on_past_the_idle_time() {
        let mut rig = Rig::with(Settings { spindle: true, h_axis: true, idle_ms: 100, ..bench_settings() });
        rig.take_out();
        assert_eq!(rig.line("enable"), "ok\n");
        assert_eq!(rig.line("spindle S300"), "ok\n");
        rig.advance(300_000);
        assert!(rig.status_line().contains("|E:1|"), "drivers released under a turning tool");
        assert_eq!(rig.line("spindle off"), "ok\n");
        rig.advance(50_000);
        assert!(rig.status_line().contains("|E:1|"), "the idle time counts from the stop");
        rig.advance(60_000);
        assert!(rig.status_line().contains("|E:0|"));
    }

    #[test]
    fn a_held_probe_resumes_and_still_finds_the_board() {
        let mut rig = focus_rig();
        rig.surface = Some(-1.5);
        rig.submit("probe H-3 F60");
        rig.advance(500_000);
        rig.realtime(Realtime::Hold);
        rig.advance(200_000);
        assert!(rig.status_line().starts_with("<Hold|"));
        let held_at = rig.machine.joint()[H];
        rig.advance(500_000);
        assert_eq!(rig.machine.joint()[H], held_at, "moved while held");
        assert_eq!(rig.take_out(), "", "answered while held");
        rig.realtime(Realtime::Resume);
        rig.run();
        assert_eq!(rig.take_out(), "[PRB:-1.5000:1]\nok\n");
    }

    #[test]
    fn a_reset_during_a_probe_is_a_reset_while_moving() {
        let mut rig = focus_rig();
        rig.submit("probe H-3 F60");
        rig.advance(500_000);
        rig.realtime(Realtime::Reset);
        rig.run();
        assert_eq!(rig.state(), State::Alarm(1));
        assert!(rig.machine.ready_for_line());
        let out = rig.take_out();
        assert!(!out.contains("PRB"), "{out:?}");
        // A fresh probe after the unlock starts clean, with no stale contact.
        rig.surface = Some(-5.0);
        assert_eq!(rig.line("unlock"), "ok\n");
        let out = rig.line("probe H-1 F120");
        assert!(out.ends_with(":0]\nALARM:2 probe missed, check the head before moving\nerror:11 probe missed\n"), "{out:?}");
    }

    #[test]
    fn a_probe_sent_during_a_hold_waits_for_the_resume() {
        let mut rig = focus_rig();
        rig.surface = Some(-1.0);
        assert_eq!(rig.line("go R20"), "ok\n");
        rig.advance(100_000);
        rig.realtime(Realtime::Hold);
        rig.advance(1_000_000);
        assert!(rig.status_line().starts_with("<Hold|"));
        rig.submit("probe H-3 F120");
        rig.advance(500_000);
        assert_eq!(rig.take_out(), "", "neither refused nor started");
        assert_eq!(rig.machine.joint()[H], 0.0);
        rig.realtime(Realtime::Resume);
        rig.run();
        assert_eq!(rig.take_out(), "[PRB:-1.0000:1]\nok\n");
        assert_eq!(rig.machine.joint()[R], 20.0);
    }

    /// How far past a contact at -1.25 mm a 60 mm/min probe stops.
    fn overtravel(probe_ms: u32) -> f32 {
        let mut rig = Rig::with(Settings { h_axis: true, probe_ms, ..bench_settings() });
        rig.take_out();
        rig.surface = Some(-1.25);
        assert_eq!(rig.line("probe H-5 F60"), "[PRB:-1.2500:1]\nok\n", "probe_ms={probe_ms}");
        -1.25 - rig.machine.joint()[H]
    }

    #[test]
    fn the_probe_queue_sets_how_far_the_head_presses_on() {
        let (full, default, short) = (overtravel(160), overtravel(20), overtravel(10));
        // At 1 mm/s every 10 ms of queue is 0.01 mm, the segment being
        // stepped one more, and the brake at 50 mm/s^2 another 0.01 mm.
        assert!(full > 0.15, "{full}");
        assert!(default > short && default < 0.045, "{default}");
        assert!(short < 0.035, "{short}");
        // Rounded up to whole segments.
        assert_eq!(overtravel(15), default);
    }

    #[test]
    fn a_probe_at_zero_ms_stops_dead_at_the_contact() {
        // 60 mm/min is the 1 mm/s the bench allows the axis to change at once.
        assert_eq!(overtravel(0), 0.0);
        let mut rig = Rig::with(Settings { h_axis: true, probe_ms: 0, ..bench_settings() });
        rig.take_out();
        rig.surface = Some(-1.25);
        assert_eq!(rig.line("probe H-5 F60"), "[PRB:-1.2500:1]\nok\n");
        assert_eq!(rig.state(), State::Idle);
        // The halt is over: the next moves run.
        assert_eq!(rig.line("jogto H1"), "ok\n");
        rig.run();
        assert_eq!(rig.machine.joint()[H], 1.0);
        rig.surface = Some(0.5);
        assert_eq!(rig.line("probe H-1 F30"), "[PRB:0.5000:1]\nok\n");
        assert_eq!(rig.machine.joint()[H], 0.5);
    }

    #[test]
    fn a_probe_too_fast_to_stop_dead_brakes_instead() {
        let mut rig = Rig::with(Settings { h_axis: true, probe_ms: 0, ..bench_settings() });
        rig.take_out();
        rig.surface = Some(-1.25);
        assert_eq!(rig.line("probe H-5 F120"), "[PRB:-1.2500:1]\nok\n");
        let past = -1.25 - rig.machine.joint()[H];
        // One segment at 2 mm/s and the brake from it.
        assert!(past > 0.01 && past < 0.08, "{past}");
    }

    #[test]
    fn a_halt_during_a_jog_cancel_ends_as_a_contact() {
        let mut rig = Rig::with(Settings { h_axis: true, probe_ms: 0, ..bench_settings() });
        rig.take_out();
        rig.surface = Some(-1.005);
        rig.submit("probe H-3 F60");
        rig.advance(1_000_000);
        rig.realtime(Realtime::JogCancel);
        rig.run();
        let out = rig.take_out();
        assert!(out.starts_with("[PRB:-1.00") && out.ends_with(":1]\nok\n"), "{out:?}");
        assert_eq!(rig.state(), State::Idle);
        assert_eq!(rig.line("jog H1"), "ok\n");
        rig.run();
        assert!(rig.machine.joint()[H] > -0.01, "{:?}", rig.machine.joint());
    }

    #[test]
    fn a_cartesian_machine_cuts_with_the_rail_and_the_cross_slide() {
        let mut rig = Rig::new();
        rig.take_out();
        assert_eq!(rig.line("$cartesian=1"), "ok\n");
        assert_eq!(rig.line("set R0 Z0"), "ok\n");
        assert_eq!(rig.line("cut R3 Z4 F300 S400"), "ok\n");
        rig.run();
        assert_eq!(rig.port.count, [768, 0, 0, 1024], "the interrupt stepped the slide with the rail");
        assert_eq!(rig.slide.pulses, 0, "the setup stepper stayed idle");
        assert_eq!(rig.machine.joint(), [3.0, 0.0, 0.0, 4.0]);
        assert!(rig.status_line().ends_with("|Z:4.000>\n"));
        assert_eq!(rig.max_duty_while_stepping, 400);
        // The table holds the board still under a go or a cut, and a jog
        // may still turn it to line the board up.
        assert_eq!(rig.line("go A10"), "error:2 bad word\n");
        assert_eq!(rig.line("cut R1 A10 F100"), "error:2 bad word\n");
        assert_eq!(rig.line("jog A10"), "ok\n");
        rig.run();
        assert_eq!(rig.line("jogto R0 Z0 F600"), "ok\n");
        rig.run();
        assert_eq!(rig.executed_steps(), [0, 8889, 0, 0]);
        assert_eq!(rig.line("jog Z-1.5"), "ok\n");
        rig.run();
        assert_eq!(rig.machine.joint()[Z], -1.5);
        assert_eq!(rig.line("set Z10"), "ok\n");
        assert_eq!(rig.machine.joint()[Z], 10.0);
    }

    #[test]
    fn on_a_polar_machine_the_cross_slide_stays_off_the_joint_lines() {
        let mut rig = Rig::new();
        rig.take_out();
        for line in ["go Z1", "go R1 Z1", "cut R1 Z1 F100", "jog R1 Z1", "jogto Z1 A3", "set R0 Z0", "jog H1 Z1"] {
            assert_eq!(rig.line(line), "error:2 bad word\n", "{line}");
        }
        assert_eq!(rig.port.count, [0; AXES]);
    }

    #[test]
    fn switching_to_cartesian_hands_the_slide_position_over() {
        let mut rig = Rig::new();
        rig.take_out();
        assert_eq!(rig.line("jog Z2"), "ok\n");
        rig.run();
        assert_eq!(rig.slide.pulses, 512);
        assert_eq!(rig.line("$cartesian=1"), "ok\n");
        assert_eq!(rig.machine.joint()[Z], 2.0, "the joint took the slide's position");
        assert_eq!(rig.line("$cartesian=1"), "ok\n");
        assert_eq!(rig.machine.joint()[Z], 2.0, "setting it again hands nothing over");
        assert_eq!(rig.line("jog Z1"), "ok\n");
        rig.run();
        assert_eq!(rig.port.count[Z], 256);
        assert_eq!(rig.slide.pulses, 512);
        assert_eq!(rig.machine.joint()[Z], 3.0);
        assert_eq!(rig.line("$cartesian=0"), "ok\n");
        assert_eq!(rig.machine.slide_position(), 3.0, "the slide took the joint's position");
        assert_eq!(rig.line("jog Z-1"), "ok\n");
        rig.run();
        assert_eq!(rig.slide.pulses, 512 + 256);
        assert_eq!(rig.machine.joint()[Z], 2.0);
        // `$defaults` goes back to polar the same way.
        assert_eq!(rig.line("$cartesian=1"), "ok\n");
        assert_eq!(rig.line("jog Z0.5"), "ok\n");
        rig.run();
        assert_eq!(rig.line("$defaults"), "ok\n");
        assert_eq!(rig.machine.slide_position(), 2.5);
    }

    #[test]
    fn the_cross_slide_soft_limit_holds_either_way() {
        let mut rig = Rig::new();
        rig.take_out();
        assert_eq!(rig.line("$z_max=5"), "ok\n");
        assert_eq!(rig.line("jogto Z6"), "error:4 out of range\n");
        assert_eq!(rig.line("jog Z-5.5"), "error:4 out of range\n");
        assert_eq!(rig.line("jogto Z5"), "ok\n");
        rig.run();
        assert_eq!(rig.line("$cartesian=1"), "ok\n");
        assert_eq!(rig.line("go Z-5.5"), "error:4 out of range\n");
        assert_eq!(rig.line("jog Z0.5"), "error:4 out of range\n");
        assert_eq!(rig.line("go R1 Z-5"), "ok\n");
        rig.run();
        assert_eq!(rig.machine.joint()[Z], -5.0);
    }

    #[test]
    fn the_tool_output_follows_the_job_the_beam_and_the_spindle() {
        let mut rig = Rig::with(Settings { tool_out: true, ..bench_settings() });
        rig.take_out();
        rig.advance(POLL_US);
        let level = |rig: &Rig| rig.laser.enables.last().map(|entry| entry.1);
        assert_eq!(level(&rig), Some(false), "at rest from the first poll");
        // A lit beam, until its timeout.
        assert_eq!(rig.line("laser S500 T100"), "ok\n");
        assert_eq!(level(&rig), Some(true));
        rig.advance(150_000);
        assert_eq!(level(&rig), Some(false));
        // A job, from the first cut until the machine is idle again; a
        // dark move is a job too.
        assert_eq!(rig.line("go R5"), "ok\n");
        assert_eq!(level(&rig), Some(true));
        rig.advance(5_000_000);
        assert_eq!(level(&rig), Some(false));
        let writes = rig.laser.enables.len();
        rig.advance(1_000_000);
        assert_eq!(rig.laser.enables.len(), writes, "driven only on a change");
        // Active low: the rest level is high, and turning the output off
        // by its setting returns it to rest rather than driving it low.
        assert_eq!(rig.line("$tool_invert=1"), "ok\n");
        rig.advance(POLL_US);
        assert_eq!(level(&rig), Some(true));
        assert_eq!(rig.line("laser S500 T100"), "ok\n");
        assert_eq!(level(&rig), Some(false));
        rig.advance(150_000);
        assert_eq!(rig.line("$tool_out=0"), "ok\n");
        rig.advance(POLL_US);
        assert_eq!(level(&rig), Some(true));
        let writes = rig.laser.enables.len();
        assert_eq!(rig.line("laser S500 T100"), "ok\n");
        rig.advance(150_000);
        assert_eq!(rig.laser.enables.len(), writes, "off by its setting, the output does not follow the beam");
        // The spindle, from its start to its stop.
        assert_eq!(rig.line("$tool_out=1"), "ok\n");
        assert_eq!(rig.line("$tool_invert=0"), "ok\n");
        assert_eq!(rig.line("$spindle=1"), "ok\n");
        rig.advance(POLL_US);
        assert_eq!(level(&rig), Some(false));
        assert_eq!(rig.line("spindle S500"), "ok\n");
        assert_eq!(level(&rig), Some(true));
        assert_eq!(rig.line("spindle off"), "ok\n");
        assert_eq!(level(&rig), Some(false));
    }

    #[test]
    fn a_spindle_turns_through_moves_and_holds_until_it_is_stopped() {
        let mut rig = Rig::new();
        rig.take_out();
        assert_eq!(rig.line("spindle S500"), "error:2 bad word\n", "a laser machine has no spindle");
        assert_eq!(rig.line("$spindle=1"), "ok\n");
        for line in ["laser S100", "cut R10 F100 S100", "cut R10 F100 M50", "dwell T10 S5"] {
            assert_eq!(rig.line(line), "error:2 bad word\n", "{line}");
        }
        assert_eq!(rig.line("spindle S500"), "ok\n");
        assert_eq!(rig.laser.duty, 500);
        assert!(rig.status_line().contains("|L:500|"));
        assert_eq!(rig.line("go R10"), "ok\n");
        assert_eq!(rig.line("cut A90 F300"), "ok\n");
        rig.advance(300_000);
        rig.realtime(Realtime::Hold);
        rig.advance(1_000_000);
        assert_eq!(rig.state(), State::Hold);
        assert_eq!(rig.laser.duty, 500, "a hold keeps the tool turning");
        rig.realtime(Realtime::Resume);
        rig.run();
        assert_eq!((rig.min_duty_while_stepping, rig.max_duty_while_stepping), (500, 500));
        assert_eq!(rig.laser.duty, 500, "and so does the end of the motion");
        assert!(rig.status_line().contains("|L:500|"));
        assert_eq!(rig.line("dwell T100"), "ok\n");
        assert_eq!(rig.laser.duty, 500);
        assert_eq!(rig.line("spindle off"), "ok\n");
        assert_eq!(rig.laser.duty, 0);

        // A reset stops it, and so does `laser off`.
        assert_eq!(rig.line("spindle S250"), "ok\n");
        assert_eq!(rig.laser.duty, 250);
        rig.realtime(Realtime::Reset);
        assert_eq!(rig.laser.duty, 0);
        rig.take_out();
        assert_eq!(rig.line("spindle S250"), "ok\n");
        assert_eq!(rig.line("laser off"), "ok\n");
        assert_eq!(rig.laser.duty, 0);

        // Taking the spindle out of the settings stops it too.
        assert_eq!(rig.line("spindle S250"), "ok\n");
        assert_eq!(rig.line("$spindle=1"), "ok\n");
        assert_eq!(rig.laser.duty, 250, "setting it again changes nothing");
        assert_eq!(rig.line("$spindle=0"), "ok\n");
        rig.advance(POLL_US);
        assert_eq!(rig.laser.duty, 0);
    }

    #[test]
    fn a_spindle_machine_cuts_only_with_the_spindle_turning() {
        let mut rig = Rig::with(Settings { spindle: true, h_axis: true, ..bench_settings() });
        rig.take_out();
        assert_eq!(rig.line("cut R5 F300"), "error:5 not now\n", "never started");
        assert_eq!(rig.line("go R5"), "ok\n", "a rapid does not need it");
        rig.run();
        assert_eq!(rig.line("spindle S500"), "ok\n");
        assert_eq!(rig.line("cut R10 F300"), "ok\n");
        rig.run();
        // Stopped under a job, from a console: the job ends at its next cut.
        assert_eq!(rig.line("spindle off"), "ok\n");
        assert_eq!(rig.line("cut R15 F300"), "error:5 not now\n");
        assert_eq!(rig.line("spindle S500"), "ok\n");
        assert_eq!(rig.line("laser off"), "ok\n");
        assert_eq!(rig.line("cut R15 F300"), "error:5 not now\n");
        assert_eq!(rig.line("spindle S0"), "ok\n");
        assert_eq!(rig.line("cut R15 F300"), "error:5 not now\n", "a speed of 0 is stopped");
        assert_eq!(rig.machine.joint()[R], 10.0);
    }

    #[test]
    fn a_spindle_keeps_its_polarity_and_never_probes_turning() {
        let mut settings = bench_settings();
        settings.spindle = true;
        settings.laser_invert = true;
        settings.h_axis = true;
        let mut rig = Rig::with(settings);
        rig.take_out();
        rig.advance(POLL_US);
        assert_eq!(rig.laser.duty, 1000, "off is full duty under laser_invert");
        assert_eq!(rig.line("spindle S200"), "ok\n");
        assert_eq!(rig.laser.duty, 800);
        assert!(rig.status_line().contains("|L:800|"));
        // The probe may be the tool itself.
        assert_eq!(rig.line("probe H-1"), "error:5 not now\n");
        assert_eq!(rig.port.count, [0, 0, 0, 0]);
        assert_eq!(rig.laser.duty, 800);
        assert_eq!(rig.line("spindle off"), "ok\n");
        assert_eq!(rig.line("probe H-1"), "[PRB:-1.0000:0]\nALARM:2 probe missed, check the head before moving\nerror:11 probe missed\n");
        assert_eq!(rig.laser.duty, 1000);
        assert_eq!(rig.line("spindle S200"), "error:5 not now\n", "not in an alarm");
    }

    #[test]
    fn a_motor_power_loss_stops_everything_and_alarms_even_from_idle() {
        let mut rig = Rig::with(Settings { spindle: true, h_axis: true, ..bench_settings() });
        rig.take_out();
        assert_eq!(rig.line("spindle S500"), "ok\n");
        assert_eq!(rig.laser.duty, 500);
        rig.machine.power_lost(&mut rig.laser, &mut rig.out);
        let out = rig.take_out();
        assert!(out.starts_with("[MSG:reset]\nALARM:3 motor power lost, position may be off\n[spinny v"), "{out:?}");
        assert_eq!(rig.laser.duty, 0);
        assert_eq!(rig.state(), State::Alarm(3));
        // A line the host sent before it heard of it is refused.
        assert_eq!(rig.line("go R1"), "error:5 not now\n");
        assert_eq!(rig.port.count, [0, 0, 0, 0]);
        assert_eq!(rig.line("unlock"), "ok\n");
        assert_eq!(rig.state(), State::Idle);
    }

    #[test]
    fn defaults_keep_the_wiring_polarities() {
        let mut settings = bench_settings();
        settings.laser_invert = true;
        settings.en_invert = true;
        settings.probe_invert = true;
        settings.dir_invert = 5;
        settings.sockets = 1423;
        settings.tool_out = true;
        settings.tool_invert = true;
        settings.tool_pin = 21;
        settings.idle_ms = 1234;
        settings.stop[R] = STOP_MIN;
        settings.stop_pin[R] = 22;
        settings.stop_invert = 1;
        settings.limits = 1;
        settings.home_pull[R] = 2.5;
        let mut rig = Rig::with(settings);
        rig.take_out();
        rig.advance(POLL_US);
        assert_eq!(rig.laser.duty, 1000);
        assert_eq!(rig.line("$defaults"), "ok\n");
        rig.advance(POLL_US);
        assert_eq!(rig.laser.duty, 1000, "an active-low laser lit by $defaults");
        let listed = rig.line("$");
        // The wiring stays: the polarities, the socket map and the pins.
        for line in [
            "laser_invert=1\n", "en_invert=1\n", "probe_invert=1\n", "dir_invert=5\n",
            "sockets=1423\n", "tool_out=1\n", "tool_invert=1\n", "tool_pin=21\n", "idle_ms=0\n",
            "r_stop=1\n", "r_stop_pin=22\n", "stop_invert=1\n", "limits=1\n", "r_home_pull=1\n",
        ] {
            assert!(listed.contains(line), "{line} in {listed}");
        }
    }

    /// The bench with a switch at the rail's negative end, which reads
    /// -3 mm, a 1 mm pull-off and 40 mm of travel.
    fn homing_settings() -> Settings {
        let mut settings = bench_settings();
        settings.stop[R] = STOP_MIN;
        settings.home_pos[R] = -3.0;
        settings.home_pull[R] = 1.0;
        settings.home_travel[R] = 40.0;
        settings
    }

    #[test]
    fn a_home_seeks_the_switch_backs_off_and_locates_it() {
        let mut rig = Rig::with(homing_settings());
        rig.take_out();
        // The switch is physically 7 mm from where the rail started.
        rig.stop_min[R] = Some(-7.0);
        assert_eq!(rig.line("home R"), "[HOME:R:-2.0000:1]\nok\n");
        assert_eq!(rig.state(), State::Idle);
        let status = rig.status_line();
        assert_eq!(field(&status, "D:"), "R");
        assert!(status.contains("|J:-2.000,"), "{status}");
        // The switch reads -3 and the rail sits the pull-off from it, so
        // physically it is 1 mm short of the switch.
        let physical = rig.physical(R);
        assert!((physical + 6.0).abs() < 0.02, "physically at {physical}");
        // Homed again from there, the same place.
        assert_eq!(rig.line("home R"), "[HOME:R:-2.0000:1]\nok\n");
        assert!((rig.physical(R) + 6.0).abs() < 0.02);
    }

    #[test]
    fn a_home_reports_the_home_state_while_it_runs() {
        let mut rig = Rig::with(homing_settings());
        rig.take_out();
        rig.stop_min[R] = Some(-30.0);
        rig.submit("home R");
        rig.advance(50_000);
        assert_eq!(rig.state(), State::Home);
        assert!(rig.status_line().starts_with("<Home|"));
        // Pending until it ends, so no line joins it.
        assert!(!rig.machine.ready_for_line());
        rig.run();
        assert_eq!(rig.state(), State::Idle);
        assert!(rig.take_out().ends_with("[HOME:R:-2.0000:1]\nok\n"));
    }

    #[test]
    fn a_two_ended_axis_homes_to_either_end() {
        let mut settings = homing_settings();
        settings.stop[R] = STOP_MIN + STOP_MAX;
        settings.home_travel[R] = 25.0;
        let mut rig = Rig::with(settings);
        rig.take_out();
        rig.stop_min[R] = Some(-7.0);
        rig.stop_max[R] = Some(18.0);
        // The positive switch reads home_pos + home_travel.
        assert_eq!(rig.line("home R+"), "[HOME:R:21.0000:1]\nok\n");
        assert!((rig.physical(R) - 17.0).abs() < 0.02, "physically at {}", rig.physical(R));
        assert_eq!(rig.line("home R-"), "[HOME:R:-2.0000:1]\nok\n");
        assert!((rig.physical(R) + 6.0).abs() < 0.02);
        // Unsigned, the negative end.
        assert_eq!(rig.line("jog R10"), "ok\n");
        rig.run();
        rig.take_out();
        assert_eq!(rig.line("home R"), "[HOME:R:-2.0000:1]\nok\n");
    }

    #[test]
    fn a_home_that_finds_no_switch_is_an_alarm() {
        let mut rig = Rig::with(homing_settings());
        rig.take_out();
        // Travel and a tenth, plus the pull-off, then nothing.
        assert_eq!(
            rig.line("home R"),
            "[HOME:R:-45.0000:0]\nALARM:5 home failed, position may be off\nerror:13 home failed\n"
        );
        assert_eq!(rig.state(), State::Alarm(5));
        assert_eq!(rig.line("jog R1"), "error:5 not now\n");
        assert_eq!(rig.line("unlock"), "ok\n");
        assert_eq!(field(&rig.status_line(), "D:"), "");
    }

    #[test]
    fn a_switch_closed_at_the_start_is_backed_off_first() {
        let mut rig = Rig::with(homing_settings());
        rig.take_out();
        // Parked on the switch: the rail backs off the pull-off, then
        // seeks the contact afresh.
        rig.stop_min[R] = Some(0.0);
        assert_eq!(rig.line("home R"), "[HOME:R:-2.0000:1]\nok\n");
        assert!((rig.physical(R) - 1.0).abs() < 0.02, "physically at {}", rig.physical(R));
    }

    #[test]
    fn a_switch_that_stays_closed_refuses_the_home() {
        let mut rig = Rig::with(homing_settings());
        rig.take_out();
        rig.stop_max[R] = Some(-1000.0);
        assert_eq!(rig.line("home R"), "[HOME:R:1.0000:0]\nerror:12 endstop active\n");
        assert_eq!(rig.state(), State::Idle);
        assert_eq!(field(&rig.status_line(), "D:"), "");
    }

    #[test]
    fn a_jog_cancel_or_a_hold_ends_a_home() {
        for action in [Realtime::JogCancel, Realtime::Hold] {
            let mut rig = Rig::with(homing_settings());
            rig.take_out();
            rig.stop_min[R] = Some(-30.0);
            rig.submit("home R");
            rig.advance(50_000);
            rig.realtime(action);
            rig.run();
            let out = rig.take_out();
            assert!(out.starts_with("[HOME:R:-") && out.ends_with(":0]\nok\n"), "{out}");
            assert_eq!(rig.state(), State::Idle);
            assert_eq!(field(&rig.status_line(), "D:"), "");
            assert!(rig.physical(R) < -0.1 && rig.physical(R) > -30.0, "stopped short at {}", rig.physical(R));
        }
    }

    #[test]
    fn a_home_takes_the_joints_in_order_and_refuses_one_without_a_switch() {
        let mut settings = homing_settings();
        settings.h_axis = true;
        settings.stop[H] = STOP_MAX;
        settings.home_pos[H] = 12.0;
        settings.home_travel[H] = 20.0;
        let mut rig = Rig::with(settings);
        rig.take_out();
        rig.stop_min[R] = Some(-7.0);
        rig.stop_max[H] = Some(10.0);
        assert_eq!(rig.line("home A"), "error:2 bad word\n");
        assert_eq!(rig.line("home R+"), "error:2 bad word\n", "no switch at that end");
        assert_eq!(rig.line("home H-"), "error:2 bad word\n");
        // The head first, then the rail.
        assert_eq!(rig.line("home"), "[HOME:H:11.0000:1]\n[HOME:R:-2.0000:1]\nok\n");
        assert_eq!(field(&rig.status_line(), "D:"), "RH");
        assert_eq!(rig.line("set R0"), "ok\n");
        assert_eq!(field(&rig.status_line(), "D:"), "H", "declared elsewhere, the rail is unhomed");
        assert_eq!(rig.line("go R5"), "ok\n");
        assert_eq!(rig.line("home R"), "error:5 not now\n", "only from Idle");
        rig.run();
    }

    #[test]
    fn a_focus_axis_not_fitted_has_no_switch_to_home() {
        let mut settings = homing_settings();
        settings.stop[H] = STOP_MAX;
        let mut rig = Rig::with(settings);
        rig.take_out();
        rig.stop_min[R] = Some(-7.0);
        assert_eq!(rig.line("home H"), "error:2 bad word\n");
        assert_eq!(rig.line("home"), "[HOME:R:-2.0000:1]\nok\n", "the rail alone");
    }

    #[test]
    fn the_polar_cross_slide_homes_on_its_own_stepper() {
        let mut settings = bench_settings();
        settings.stop[Z] = STOP_MIN;
        settings.home_pull[Z] = 1.0;
        settings.home_travel[Z] = 20.0;
        let mut rig = Rig::with(settings);
        rig.take_out();
        rig.stop_min[Z] = Some(-4.0);
        assert_eq!(rig.line("home Z"), "[HOME:Z:1.0000:1]\nok\n");
        assert!((rig.physical(Z) + 3.0).abs() < 0.02, "physically at {}", rig.physical(Z));
        assert_eq!(rig.port.count[Z], 0, "the joint stepper never moved it");
        let status = rig.status_line();
        assert_eq!(field(&status, "D:"), "Z");
        assert!(status.contains("|Z:1.000"), "{status}");
    }

    #[test]
    fn an_endstop_halts_a_move_it_closes_under() {
        let mut settings = homing_settings();
        settings.stop[R] = STOP_MAX;
        settings.limits = 1;
        let mut rig = Rig::with(settings);
        rig.take_out();
        rig.stop_max[R] = Some(5.0);
        assert_eq!(rig.line("go R10"), "ok\n");
        rig.run();
        let out = rig.take_out();
        assert!(
            out.starts_with("[MSG:reset]\n[MSG:endstop R]\nALARM:4 endstop hit while moving, position may be off\n[spinny v"),
            "{out}"
        );
        assert_eq!(rig.state(), State::Alarm(4));
        // Halted within the debounce of the switch, not run to the end.
        let physical = rig.physical(R);
        assert!(physical >= 5.0 && physical < 5.5, "halted at {physical}");
        assert_eq!(rig.line("unlock"), "ok\n");
        assert_eq!(field(&rig.status_line(), "D:"), "");
    }

    #[test]
    fn an_endstop_closed_at_rest_lets_the_axis_move_off_it() {
        let mut settings = homing_settings();
        settings.limits = 1;
        let mut rig = Rig::with(settings);
        rig.take_out();
        rig.stop_min[R] = Some(0.0);
        assert_eq!(rig.line("jog R2"), "ok\n");
        rig.run();
        assert_eq!(rig.state(), State::Idle);
        assert!(!rig.take_out().contains("ALARM"));
        assert!((rig.physical(R) - 2.0).abs() < 0.01);
        // Back onto it, and past it, is the halt.
        assert_eq!(rig.line("jog R-3"), "ok\n");
        rig.run();
        assert_eq!(rig.state(), State::Alarm(4));
        assert!(rig.physical(R) > -0.5, "halted at {}", rig.physical(R));
    }

    #[test]
    fn a_limit_on_the_polar_cross_slide_halts_it_too() {
        let mut settings = bench_settings();
        settings.stop[Z] = STOP_MAX;
        settings.limits = 0b0100;
        let mut rig = Rig::with(settings);
        rig.take_out();
        rig.stop_max[Z] = Some(3.0);
        assert_eq!(rig.line("jog Z8"), "ok\n");
        rig.run();
        assert_eq!(rig.state(), State::Alarm(4));
        assert!(rig.take_out().contains("[MSG:endstop Z]\nALARM:4"));
        let physical = rig.physical(Z);
        assert!(physical >= 3.0 && physical < 3.5, "halted at {physical}");
    }

    #[test]
    fn an_endstop_that_is_no_limit_is_ignored_under_a_move() {
        let mut rig = Rig::with(homing_settings());
        rig.take_out();
        rig.stop_min[R] = Some(-2.0);
        assert_eq!(rig.line("jog R-5"), "ok\n");
        rig.run();
        assert_eq!(rig.state(), State::Idle);
        assert!((rig.physical(R) + 5.0).abs() < 0.01);
    }
}
