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
//! The cross slide is a pending command like any other, but it runs on
//! its own `Slide` rather than through the planner: it is taken only from
//! `Idle`, holds the state at `Jog` until it stops, and is stepped by
//! `poll_slide` from the main loop. A jog cancel brakes it, a reset or a
//! disconnect drops it.

use crate::hal::{LaserPort, Sink, SlidePort, StepPort, Store};
use crate::math;
use crate::parser::{self, Command, Error, PowerMode, Realtime};
use crate::planner::{Feed, MoveKind, PlanError, Planner};
use crate::report::{self, State, Status};
use crate::settings::{Changed, SetError, Settings, BLOB_LEN};
use crate::slide::Slide;
use crate::stepper::{self, Front};
use crate::{AXES, LINE_MAX, LINE_SLOTS, R};

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
    Motion { target: [f32; AXES], kind: MoveKind, feed: Feed, power: f32 },
    /// A cross slide move, started once the joints have come to rest.
    SlideMove { target: f32, feed: Option<f32> },
    /// The sync commands below wait for queued motion to finish.
    Dwell { ms: u32, power: Option<f32> },
    /// A dwell in progress; answered when its time is up.
    Dwelling,
    Mode(PowerMode),
    LaserOn { power: f32, ms: Option<u32> },
    LaserOff,
    SetPosition([Option<f32>; AXES]),
    SetSlide(f32),
    Enable(bool),
    /// Store access happens in `poll`, where the store is.
    Save,
    Load,
}

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
    /// A jog cancel is waiting for the stepper to stop.
    jog_cancel: bool,
    /// Laser frequency and constant duty to re-apply at the next `poll`.
    apply_laser: bool,
    /// Enable pin level to re-apply at the next `poll`.
    apply_enable: bool,
    /// When `Idle` was entered, for the idle disable.
    idle_since: u64,
    /// Time of the last `poll`.
    now: u64,
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
            jog_cancel: false,
            apply_laser: true,
            apply_enable: true,
            idle_since: 0,
            now: 0,
            events: Events::default(),
        }
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

    /// Executed joint position in units.
    pub fn joint(&self) -> [f32; AXES] {
        let steps = self.front.position();
        let mut units = [0f32; AXES];
        for i in 0..AXES {
            units[i] = math::steps_to_units(steps[i], self.settings.steps[i]);
        }
        units
    }

    /// Planned end position in steps: where the next motion starts from.
    pub fn planned_position(&self) -> [i32; AXES] {
        self.planner.position()
    }

    /// Cross slide position in mm.
    pub fn slide_position(&self) -> f32 {
        self.slide.position()
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
        matches!(self.state, State::Idle | State::Alarm(_))
            && self.pending == Pending::None
            && !self.front.busy()
            && !self.front.resync_pending()
            && !self.slide.busy()
            && self.beam.is_none()
            && !(self.enabled && self.settings.idle_ms > 0)
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
                self.check_motion_state(false)?;
                self.queue_motion(target, false, MoveKind::Rapid, Feed::Max, 0.0)?;
                Ok(false)
            }
            Command::Cut { target, feed, power } => {
                self.check_motion_state(false)?;
                let feed = feed.or(self.feed).ok_or(Error::MissingWord)?;
                self.queue_motion(target, false, MoveKind::Cut, Feed::Surface(feed), power.unwrap_or(self.power))?;
                self.feed = Some(feed);
                if let Some(power) = power {
                    self.power = power;
                }
                Ok(false)
            }
            Command::Jog { target, feed, absolute } => {
                self.check_motion_state(true)?;
                let feed = feed.map_or(Feed::Jog, Feed::Surface);
                self.queue_motion(target, !absolute, MoveKind::Jog, feed, 0.0)?;
                Ok(false)
            }
            Command::JogZ { target, feed, absolute } => {
                // The slide moves alone and only from rest: it shares the
                // rail with a cut in progress and would move it.
                self.require_idle()?;
                let target = if absolute { target } else { self.slide.position() + target };
                self.pending = Pending::SlideMove { target, feed };
                Ok(false)
            }
            Command::SetSlide { value } => {
                self.require_idle()?;
                self.pending = Pending::SetSlide(value);
                Ok(false)
            }
            Command::Dwell { ms, power } => {
                self.check_motion_state(false)?;
                self.pending = Pending::Dwell { ms, power };
                Ok(false)
            }
            Command::Mode(mode) => {
                self.pending = Pending::Mode(mode);
                Ok(false)
            }
            Command::LaserOn { power, ms } => {
                self.require_idle()?;
                self.pending = Pending::LaserOn { power, ms };
                Ok(false)
            }
            Command::LaserOff => {
                self.pending = Pending::LaserOff;
                Ok(false)
            }
            Command::SetPosition { value } => {
                self.require_idle()?;
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
                let changed = self.settings.set(name, value).map_err(|error| match error {
                    SetError::Unknown => Error::UnknownSetting,
                    SetError::BadValue => Error::BadSettingValue,
                })?;
                match changed {
                    Changed::Motion => self.apply_enable = true,
                    Changed::Laser => self.apply_laser = true,
                    Changed::Driver => self.events.driver_config = true,
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
                self.adopt(Settings::default());
                Ok(true)
            }
            Command::DriverReport => {
                self.events.driver_report = true;
                Ok(true)
            }
        }
    }

    fn require_idle(&self) -> Result<(), Error> {
        if self.state == State::Idle {
            Ok(())
        } else {
            Err(Error::State)
        }
    }

    /// Jogs are accepted in `Idle` and `Jog`, everything else that moves
    /// in `Idle` and `Run`.
    fn check_motion_state(&self, jog: bool) -> Result<(), Error> {
        // A cross slide move carries the rail the radius rides on, so
        // nothing joins it, not even the jog its own state looks like.
        if self.slide.busy() {
            return Err(Error::State);
        }
        let allowed = if jog {
            matches!(self.state, State::Idle | State::Jog)
        } else {
            matches!(self.state, State::Idle | State::Run)
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
    ) -> Result<(), Error> {
        let here = self.planner.position_units(&self.settings);
        let mut target = here;
        for i in 0..AXES {
            if let Some(word) = words[i] {
                target[i] = if relative { here[i] + word } else { word };
            }
        }
        // Checked on the step the target rounds to, so a relative jog back
        // to the axis is not refused for a rounding hair below zero. A jog
        // may cross the axis and come out the far side: that is how the
        // head is lined up with it. A cut may not, because a negative
        // radius is the same board point half a turn away and the job's
        // polar words cannot say which was meant.
        let r_steps = math::units_to_steps(target[R], self.settings.steps[R]);
        let r_units = math::steps_to_units(r_steps, self.settings.steps[R]);
        let crosses = r_steps < 0 && kind != MoveKind::Jog;
        let beyond = self.settings.r_max > 0.0 && libm::fabsf(r_units) > self.settings.r_max;
        if crosses || beyond {
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
        self.pending = Pending::Motion { target, kind, feed, power };
        Ok(())
    }

    fn status(&self) -> Status {
        let duty = if self.front.busy() {
            self.front.duty()
        } else {
            self.constant_duty().unwrap_or_else(|| self.off_duty())
        };
        Status {
            state: self.state,
            joint: self.joint(),
            rate: self.front.surface_rate(),
            duty,
            planner_free: self.planner.free(),
            line_free: LINE_SLOTS,
            mode: self.mode,
            enabled: self.enabled,
            slide: self.slide.position(),
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
                if self.slide.busy() {
                    self.slide.cancel();
                    return;
                }
                if !matches!(self.state, State::Run | State::Jog) {
                    return;
                }
                self.held = self.state;
                self.state = State::Hold;
                self.front.request_hold();
                if let Some(until) = self.dwell_until.take() {
                    self.dwell_left_us = until.saturating_sub(self.now);
                }
                laser.set_duty(self.off_duty());
            }
            Realtime::Resume => {
                if self.state != State::Hold || self.jog_cancel {
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

    /// Stops everything and forgets the modal state. True when it was
    /// moving: the position may be off and the state is `Alarm`.
    fn reset(&mut self, laser: &mut impl LaserPort) -> bool {
        let moving = matches!(self.state, State::Run | State::Jog | State::Hold) && self.front.busy();
        self.front.abort(&mut self.planner);
        self.planner.clear();
        // The slide counts its own steps, so stopping it mid-move costs
        // no position and raises no alarm.
        self.slide.stop();
        self.pending = Pending::None;
        self.jog_cancel = false;
        self.dwell_until = None;
        self.dwell_left_us = 0;
        self.dwell_power = None;
        self.beam = None;
        laser.set_duty(self.off_duty());
        self.feed = None;
        self.power = 0.0;
        self.mode = PowerMode::Dynamic;
        if moving {
            self.state = State::Alarm(1);
        } else {
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
        let mut kick = self.front.prep(&mut self.planner, &self.settings, self.mode).kick;
        if self.progress(port, laser, store, out) {
            kick |= self.front.prep(&mut self.planner, &self.settings, self.mode).kick;
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
            if !self.front.busy() {
                self.drive_beam(laser);
            }
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
            && !matches!(self.pending, Pending::Motion { .. } | Pending::Dwelling);
        if motion_done {
            self.enter_idle(laser);
        }
        if self.jog_cancel && self.front.is_stopped() {
            self.jog_cancel = false;
            self.front.flush(&mut self.planner);
            self.planner.clear();
            if matches!(self.pending, Pending::Motion { .. }) {
                // The rest of the jog is discarded, the line still answered.
                self.pending = Pending::None;
                report::ok(out);
            }
            self.enter_idle(laser);
        }
        if self.beam.is_some() && now_us >= self.beam_until {
            self.beam = None;
            self.drive_beam(laser);
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
        if let Pending::Motion { target, kind, feed, power } = pending {
            if self.state == State::Hold || self.front.resync_pending() {
                return false;
            }
            match self.planner.push(target, kind, feed, power, &self.settings) {
                Ok(_) => {
                    self.set_enabled(true, port);
                    if self.beam.take().is_some() {
                        laser.set_duty(self.off_duty());
                    }
                    self.pending = Pending::None;
                    self.state = if kind == MoveKind::Jog { State::Jog } else { State::Run };
                    report::ok(out);
                    return true;
                }
                Err(PlanError::Full) => return false,
            }
        }
        if matches!(pending, Pending::None | Pending::Dwelling) {
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
                self.drive_beam(laser);
                return false;
            }
            Pending::Mode(mode) => self.mode = mode,
            Pending::LaserOn { power, ms } => {
                self.beam = Some(power);
                self.beam_until = self.now + ms.unwrap_or(self.settings.laser_ms) as u64 * 1000;
                self.drive_beam(laser);
            }
            Pending::LaserOff => {
                self.beam = None;
                self.drive_beam(laser);
            }
            Pending::SetPosition(value) => {
                let mut steps = self.planner.position();
                for i in 0..AXES {
                    if let Some(units) = value[i] {
                        steps[i] = math::units_to_steps(units, self.settings.steps[i]);
                    }
                }
                self.planner.set_position(steps);
                self.front.set_position(steps);
            }
            Pending::SetSlide(value) => self.slide.set_position(value, &self.settings),
            Pending::SlideMove { target, feed } => {
                self.set_enabled(true, port);
                self.slide.start(self.slide.position(), target, feed, &self.settings);
                if self.slide.busy() {
                    self.state = State::Jog;
                }
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
            Pending::None | Pending::Dwelling | Pending::Motion { .. } => {}
        }
        self.pending = Pending::None;
        report::ok(out);
        false
    }

    fn enter_idle(&mut self, laser: &mut impl LaserPort) {
        self.state = State::Idle;
        self.idle_since = self.now;
        self.drive_beam(laser);
    }

    fn adopt(&mut self, settings: Settings) {
        self.settings = settings;
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

    /// Duty of the constant beam in effect: the dwell's `S`, else the
    /// `laser` command's.
    fn constant_duty(&self) -> Option<u16> {
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
    pub fn disconnected(&mut self, laser: &mut impl LaserPort, port: &mut impl StepPort) {
        let _ = port;
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

const HELP: &str = "go [R] [A] | cut [R] [A] [F] [S] | jog [R] [A] [F] | jogto [R] [A] [F]\n\
cross slide, alone and from idle: jog Z [F] | jogto Z [F] | set Z\n\
dwell T [S] | mode dyn|const | laser S [T] | laser off | set [R] [A]\n\
enable | disable | unlock | version | status | help\n\
$ | $name | $name=value | $save | $load | $defaults | $tmc\n\
realtime bytes: ? status, ! hold, ~ resume, 0x18 reset, 0x85 jog cancel\n";

#[cfg(test)]
mod tests {
    extern crate std;

    use std::boxed::Box;
    use std::string::String;
    use std::vec::Vec;

    use super::*;
    use crate::stepper::{self, Isr, Shared};
    use crate::{A, BLOCKS};

    const POLL_US: u64 = 500;

    struct Port {
        count: [u64; AXES],
        enable_level: Option<bool>,
        enable_writes: u32,
    }

    impl StepPort for Port {
        fn set_dir(&mut self, _levels: u8) {}

        fn step(&mut self, mask: u8) {
            for i in 0..AXES {
                if mask & (1 << i) != 0 {
                    self.count[i] += 1;
                }
            }
        }

        fn set_enable(&mut self, high: bool) {
            self.enable_level = Some(high);
            self.enable_writes += 1;
        }
    }

    /// The cross slide's pins as counters.
    #[derive(Default)]
    struct SlidePins {
        pulses: u64,
        dir: Option<bool>,
    }

    impl SlidePort for SlidePins {
        fn set_dir(&mut self, high: bool) {
            self.dir = Some(high);
        }

        fn step(&mut self) {
            self.pulses += 1;
        }
    }

    struct Laser {
        now: u64,
        duty: u16,
        hz: u32,
        /// (time, duty) per change.
        duties: Vec<(u64, u16)>,
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
    }

    /// Fixed settings so these tests measure the machine and not its
    /// defaults, which follow the mechanics and move with them: 256
    /// steps/mm on the radius, 888.889 steps/deg on the table, neither
    /// near the step generator's ceiling.
    fn bench_settings() -> Settings {
        Settings {
            steps: [256.0, 888.889],
            max_rate: [1000.0, 1080.0],
            jog_rate: [600.0, 720.0],
            jerk: [3.0, 10.0],
            // The same for the cross slide: a coarse scale and a rate
            // that keep a jog a readable number of steps.
            z_steps: 256.0,
            z_rate: 1200.0,
            jog_z: 600.0,
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
                port: Port { count: [0; AXES], enable_level: None, enable_writes: 0 },
                slide: SlidePins::default(),
                laser: Laser { now: 0, duty: 0, hz: 0, duties: Vec::new() },
                store: FakeStore::default(),
                out: Out::default(),
                now: 0,
                next_tick: None,
                min_duty_while_stepping: 1000,
                max_duty_while_stepping: 0,
            };
            report::banner(&mut rig.out);
            rig
        }

        fn take_out(&mut self) -> String {
            core::mem::take(&mut self.out.0)
        }

        fn poll(&mut self) {
            self.laser.now = self.now;
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
            [math::units_to_steps(joint[R], steps[R]), math::units_to_steps(joint[A], steps[A])]
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
        assert_eq!(rig.machine.joint(), [0.0, 0.0]);
        assert_eq!(rig.port.count, [2 * 2560, 2 * 160_000]);
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
        assert_eq!(rig.port.count, [0, 26667]);
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
        assert_eq!(rig.machine.joint(), [40.0, 0.0]);
        // A jog may cross the axis and come out the far side: lining the
        // head up with it needs both directions through zero.
        assert_eq!(rig.line("jog R-41"), "ok\n");
        rig.run();
        assert_eq!(rig.machine.joint(), [-1.0, 0.0]);
        // A cutting move may not be sent there, where a polar radius has
        // no way to say which side of the axis was meant.
        assert_eq!(rig.line("go R-1"), "error:4 out of range\n");
        assert_eq!(rig.line("cut R-1 F100"), "error:4 out of range\n");
        assert_eq!(rig.line("jog R1"), "ok\n");
        rig.run();
        assert_eq!(rig.machine.joint(), [0.0, 0.0]);
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
            assert_eq!(rig.port.count, [5120 + 1280 + 3840, 160_000 + 17_778 + 177_778], "hold at {hold_at_us}");
            assert_eq!(rig.machine.joint(), [0.0, 0.0]);
            assert_eq!(rig.machine.planned_position(), [0, 0]);
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
        assert_eq!(rig.machine.joint(), [0.0, 0.0]);
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
        assert_eq!(rig.machine.joint(), [0.0, 0.0]);
        assert_eq!(rig.machine.planned_position(), [0, 0]);
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
        assert_eq!(rig.machine.joint(), [0.0, 0.0]);

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
        assert_eq!(rig.status_line(), "<Run|J:10.000,0.0000|V:0|L:500|Q:32,16|M:dyn|E:1|Z:0.000>\n");
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
        assert_eq!(rig.executed_steps(), [0, 40000]);
        assert_eq!(rig.machine.planned_position(), [0, 40000]);
        assert_eq!(rig.status_line(), "<Idle|J:0.000,45.0000|V:0|L:0|Q:32,16|M:dyn|E:1|Z:0.000>\n");
        let before = rig.port.count;
        assert_eq!(rig.line("go R5 A0"), "ok\n");
        rig.run();
        assert_eq!(rig.port.count, [before[R] + 1280, before[A] + 40000]);
        assert_eq!(rig.machine.joint(), [5.0, 0.0]);
        assert_eq!(rig.line("set A-90 R1"), "ok\n");
        assert_eq!(rig.executed_steps(), [256, -80000]);
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
        // The joints did not move with it.
        assert_eq!(rig.machine.joint(), [0.0, 0.0]);
        assert_eq!(rig.port.count, [0, 0]);

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
    fn a_cross_slide_jog_is_cancelled_and_stopped_by_the_realtime_bytes() {
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
        let cancelled = rig.machine.slide_position();
        assert!(cancelled > 0.1 && cancelled < 20.0, "stopped at {cancelled}");
        // Every pulse is in the position it reports.
        assert_eq!(rig.slide.pulses - before, (cancelled * 256.0) as u64);
        // It stays stopped, and takes the next move from where it is.
        rig.advance(1_000_000);
        assert_eq!(rig.slide.pulses - before, (cancelled * 256.0) as u64);
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
        rig.machine.disconnected(&mut rig.laser, &mut rig.port);
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
        assert!(listing.ends_with("tmc_stealth=1\nok\n"));
        assert_eq!(listing.lines().count(), 33);
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
        rig.machine.disconnected(&mut rig.laser, &mut rig.port);
        assert_eq!(rig.laser.duty, 0);
        assert_eq!(rig.state(), State::Idle);
        assert_eq!(rig.take_out(), "");
        rig.advance(POLL_US);
        assert_eq!(rig.laser.duty, 0);

        assert_eq!(rig.line("cut R50 F600 S800"), "ok\n");
        rig.advance(1_000_000);
        assert!(rig.laser.duty > 0);
        rig.machine.disconnected(&mut rig.laser, &mut rig.port);
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
        assert_eq!(rig.machine.joint(), [0.0, 0.0]);
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
            assert_eq!(rig.machine.joint(), [40.0, 0.0], "{mode}");
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
        assert_eq!(rig.line("$defaults"), "ok\n");
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
        assert_eq!(rig.machine.planned_position(), [0, 0]);
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
        assert_eq!(rig.machine.joint(), [40.0, 0.0]);
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
}
