//! Virtual time, either free-running or pinned to the wall clock.

use std::thread;
use std::time::{Duration, Instant};

/// Wall-clock waits shorter than this are spun out instead of slept,
/// because a sleep rounds up to the scheduler's granularity and a step
/// period is tens of microseconds.
const SPIN_US: u64 = 300;

pub enum Clock {
    /// Time only moves when the simulation asks for it.
    Fast { now: u64 },
    /// Time is what has really elapsed since the start.
    Real { start: Instant },
}

impl Clock {
    pub fn fast() -> Clock {
        Clock::Fast { now: 0 }
    }

    pub fn real() -> Clock {
        Clock::Real { start: Instant::now() }
    }

    pub fn is_fast(&self) -> bool {
        matches!(self, Clock::Fast { .. })
    }

    pub fn now(&self) -> u64 {
        match self {
            Clock::Fast { now } => *now,
            Clock::Real { start } => start.elapsed().as_micros() as u64,
        }
    }

    /// Moves time to `target`: a jump when free-running, a wait otherwise.
    pub fn wait_until(&mut self, target: u64) {
        match self {
            Clock::Fast { now } => *now = (*now).max(target),
            Clock::Real { start } => {
                let now = start.elapsed().as_micros() as u64;
                if target <= now {
                    return;
                }
                let delta = target - now;
                if delta > SPIN_US {
                    thread::sleep(Duration::from_micros(delta - SPIN_US));
                }
                while (start.elapsed().as_micros() as u64) < target {
                    std::hint::spin_loop();
                }
            }
        }
    }
}
