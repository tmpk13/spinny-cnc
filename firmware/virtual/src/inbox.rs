//! What the reader thread hands to the simulation loop.
//!
//! Realtime actions and lines are kept apart, as they are on the board: a
//! status request must not wait behind the lines the planner has not taken
//! yet. The loop blocks on `wait` while the machine has nothing to do, so
//! an idle simulation costs nothing and free-running time does not race
//! ahead of the client.

use std::collections::VecDeque;
use std::sync::{Condvar, Mutex};
use std::time::Duration;

use spinny_core::parser::Realtime;
use spinny_fw_logic::line::{Event, Line};

/// Lines held behind the machine. The protocol gives the host 16 credits,
/// so a client that follows it never fills this.
const LINE_CAP: usize = 24;
const REALTIME_CAP: usize = 8;

#[derive(Default)]
struct State {
    realtime: VecDeque<Realtime>,
    lines: VecDeque<Inbound>,
    closed: bool,
}

/// A line to run, or a line that was too long to keep.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Inbound {
    Line(Line),
    TooLong,
}

#[derive(Default)]
pub struct Inbox {
    state: Mutex<State>,
    signal: Condvar,
}

impl Inbox {
    pub fn new() -> Inbox {
        Inbox::default()
    }

    /// Queues what the line assembler produced. A repeated realtime action
    /// is dropped when the queue is full, as on the board: acting on it
    /// once is what matters. A line waits for room instead, which is what
    /// a host that spends more than its credits meets on the board, where
    /// the endpoint stops accepting packets and realtime bytes stop
    /// getting through with them.
    pub fn push(&self, event: Event) {
        let mut state = self.state.lock().unwrap();
        match event {
            Event::Realtime(action) => {
                if state.realtime.len() < REALTIME_CAP {
                    state.realtime.push_back(action);
                }
            }
            Event::Line(line) => {
                state = self.room(state);
                state.lines.push_back(Inbound::Line(line));
            }
            Event::TooLong => {
                state = self.room(state);
                state.lines.push_back(Inbound::TooLong);
            }
        }
        self.signal.notify_all();
    }

    fn room<'a>(&self, mut state: std::sync::MutexGuard<'a, State>) -> std::sync::MutexGuard<'a, State> {
        while state.lines.len() >= LINE_CAP && !state.closed {
            state = self.signal.wait(state).unwrap();
        }
        state
    }

    /// The client went away; the loop finishes what it is doing and stops.
    pub fn close(&self) {
        let mut state = self.state.lock().unwrap();
        state.closed = true;
        self.signal.notify_all();
    }

    pub fn take_realtime(&self) -> Option<Realtime> {
        self.state.lock().unwrap().realtime.pop_front()
    }

    pub fn take_line(&self) -> Option<Inbound> {
        let mut state = self.state.lock().unwrap();
        let line = state.lines.pop_front();
        if line.is_some() {
            self.signal.notify_all();
        }
        line
    }

    pub fn is_closed(&self) -> bool {
        self.state.lock().unwrap().closed
    }

    pub fn is_empty(&self) -> bool {
        let state = self.state.lock().unwrap();
        state.realtime.is_empty() && state.lines.is_empty()
    }

    /// Waits for something to arrive or for the client to go away.
    pub fn wait(&self, timeout: Duration) {
        let state = self.state.lock().unwrap();
        if !state.realtime.is_empty() || !state.lines.is_empty() || state.closed {
            return;
        }
        let _ = self.signal.wait_timeout(state, timeout).unwrap();
    }
}
