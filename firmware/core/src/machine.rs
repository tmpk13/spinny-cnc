//! The controller: command execution, state, holds and resets, the laser.
//!
//! One `Machine` per controller. The main loop hands it bytes' worth of
//! parsed lines through `submit`, realtime actions through `realtime`, and
//! calls `poll` often (every millisecond or so) with the current time. All
//! output goes to the `Sink` passed in.
//!
//! State machine: `Idle` -> `Run` (a `go`/`cut` queued) or `Jog` (a jog
//! queued); `Run`/`Jog` -> `Hold` on `!`; `Hold` -> `Run`/`Jog` on `~`;
//! `Jog` -> `Idle` on jog cancel after the decel; any -> `Alarm` on a
//! reset while moving; `Alarm` -> `Idle` on `unlock`. Motion states return
//! to `Idle` when the planner and the stepper are both drained.

use crate::hal::{LaserPort, Sink, StepPort, Store};
use crate::parser::{PowerMode, Realtime};
use crate::report::State;
use crate::settings::Settings;
use crate::stepper::Front;
use crate::AXES;

/// Things the port loop must act on after a `poll`. Taken with `take_events`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Events {
    /// A `tmc_*` setting changed or settings were loaded: reconfigure the drivers.
    pub driver_config: bool,
    /// `$tmc` was asked for: print the driver status.
    pub driver_report: bool,
}

pub struct Machine<'a> {
    _front: Front<'a>,
}

impl<'a> Machine<'a> {
    pub fn new(front: Front<'a>, settings: Settings) -> Self {
        let _ = (front, settings);
        unimplemented!("machine::new")
    }

    pub fn settings(&self) -> &Settings {
        unimplemented!("machine::settings")
    }

    pub fn state(&self) -> State {
        unimplemented!("machine::state")
    }

    pub fn mode(&self) -> PowerMode {
        unimplemented!("machine::mode")
    }

    /// Executed joint position in units.
    pub fn joint(&self) -> [f32; AXES] {
        unimplemented!("machine::joint")
    }

    /// No line is waiting for planner space; `submit` may be called.
    pub fn ready_for_line(&self) -> bool {
        unimplemented!("machine::ready_for_line")
    }

    /// Parses and starts executing one line. Immediate commands answer
    /// now; motion that needs planner space answers from a later `poll`.
    pub fn submit(&mut self, line: &str, out: &mut impl Sink) {
        let _ = (line, out);
        unimplemented!("machine::submit")
    }

    pub fn realtime(&mut self, action: Realtime, laser: &mut impl LaserPort, out: &mut impl Sink) {
        let _ = (action, laser, out);
        unimplemented!("machine::realtime")
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
        let _ = (now_us, port, laser, store, out);
        unimplemented!("machine::poll")
    }

    /// The USB host went away: like a reset, and the laser off.
    pub fn disconnected(&mut self, laser: &mut impl LaserPort, port: &mut impl StepPort) {
        let _ = (laser, port);
        unimplemented!("machine::disconnected")
    }

    /// Reads the store and adopts its settings if valid.
    pub fn load_settings(&mut self, store: &mut impl Store) -> bool {
        let _ = store;
        unimplemented!("machine::load_settings")
    }

    pub fn take_events(&mut self) -> Events {
        unimplemented!("machine::take_events")
    }
}
