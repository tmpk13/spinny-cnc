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

    /// Queues what the line assembler produced, or hands it back when
    /// there is no room for a line or no client to queue it for. A
    /// repeated realtime action is dropped when the queue is full, as on
    /// the board: acting on it once is what matters. The reader keeps a
    /// line handed back, and the bytes behind it, until there is room,
    /// which is what a host that spends more than its credits meets on
    /// the board, where the endpoint stops accepting packets and realtime
    /// bytes stop getting through with them.
    pub fn try_push(&self, event: Event) -> Result<(), Event> {
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return Err(event);
        }
        match event {
            Event::Realtime(action) => {
                if action == Realtime::Reset {
                    // A reset throws away what the host has already sent,
                    // and those lines are queued here. Dropping them while
                    // the byte stream is still in order keeps the ones
                    // that come after it.
                    state.lines.clear();
                }
                if state.realtime.len() < REALTIME_CAP {
                    state.realtime.push_back(action);
                }
            }
            Event::Line(_) | Event::TooLong if state.lines.len() >= LINE_CAP => return Err(event),
            Event::Line(line) => state.lines.push_back(Inbound::Line(line)),
            Event::TooLong => state.lines.push_back(Inbound::TooLong),
        }
        self.signal.notify_all();
        Ok(())
    }

    /// Waits until a line would fit, the client has gone, or the timeout
    /// has passed.
    pub fn wait_for_room(&self, timeout: Duration) {
        let state = self.state.lock().unwrap();
        let _ = self
            .signal
            .wait_timeout_while(state, timeout, |state| state.lines.len() >= LINE_CAP && !state.closed)
            .unwrap();
    }

    /// The client went away. What it had sent and the loop has not taken
    /// is dropped, as the board drops the lines its reader still holds:
    /// a dead client's job must not run on, and a loop waiting for planner
    /// room in a hold would otherwise never drain the queue and never end.
    pub fn close(&self) {
        let mut state = self.state.lock().unwrap();
        state.closed = true;
        state.lines.clear();
        state.realtime.clear();
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

    /// Lines received and not yet taken by the loop.
    pub fn lines_waiting(&self) -> usize {
        self.state.lock().unwrap().lines.len()
    }

    pub fn is_empty(&self) -> bool {
        let state = self.state.lock().unwrap();
        state.realtime.is_empty() && state.lines.is_empty()
    }

    /// Waits for a realtime action, for a line when `lines` says the
    /// machine would take one, or for the client to go away. Lines the
    /// machine cannot take yet do not end the wait: a machine held with a
    /// line pending would otherwise spin on the ones queued behind it.
    pub fn wait(&self, timeout: Duration, lines: bool) {
        let state = self.state.lock().unwrap();
        let _ = self
            .signal
            .wait_timeout_while(state, timeout, |state| {
                let work = !state.realtime.is_empty() || (lines && !state.lines.is_empty());
                !work && !state.closed
            })
            .unwrap();
    }
}
