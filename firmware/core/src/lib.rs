//! Motion control core for the spinny laser machine: a radius axis and a
//! rotary table driven as straight lines in joint space, with the laser
//! power tied to the speed actually reached.
//!
//! The crate is portable. The RP2040 firmware and the host-side virtual
//! machine both drive it through the traits in `hal`, and every module is
//! tested on the host.
//!
//! Data flow: `parser` turns a line into a `Command`; `machine` executes it,
//! pushing moves into `planner`; `stepper::Front::prep` turns planned blocks
//! into timed segments; `stepper::Isr::tick` runs from the step timer
//! interrupt and pulses the pins.
//!
//! The cross slide `Z` in `slide` stands apart from all of that: it is a
//! setup axis that moves alone, from the main loop, with the beam off.
#![cfg_attr(not(feature = "std"), no_std)]

pub mod hal;
pub mod machine;
pub mod math;
pub mod parser;
pub mod planner;
pub mod report;
pub mod settings;
pub mod slide;
pub mod stepper;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Joint axes: index 0 is the radius in mm, index 1 the table angle in degrees.
pub const AXES: usize = 2;
pub const R: usize = 0;
pub const A: usize = 1;

/// Longest accepted line, newline included.
pub const LINE_MAX: usize = 96;
/// Lines held behind the planner; the host may have this many unanswered.
pub const LINE_SLOTS: usize = 16;
/// Planner ring size.
pub const BLOCKS: usize = 32;
/// Stepper segment ring size.
pub const SEGMENTS: usize = 16;
/// Length of one stepper segment; the speed profile is stepped this often.
pub const SEGMENT_MS: u32 = 10;
/// Shortest tick period the step timer is asked for, in microseconds.
pub const MIN_TICK_US: u32 = 10;
/// Most step events a second the generator can produce, from that tick.
/// An axis with many steps per unit runs into this before it runs into
/// its own `max_rate`, so the planner caps the speed by it and the laser
/// power follows the speed actually reached.
pub const MAX_EVENT_RATE_HZ: f32 = 1_000_000.0 / MIN_TICK_US as f32;
/// Microseconds a tick spends beyond the step pulse: the interrupt's own
/// work, on the RP2040 a few microseconds.
pub const TICK_OVERHEAD_US: u32 = 3;

/// Shortest tick the step timer can hold at a step pulse width. The pulse
/// is busy-waited inside the tick and comes out about 1.5 times its
/// setting on the RP2040, so above a few microseconds it no longer fits
/// `MIN_TICK_US`; a tick asked for sooner than the interrupt can finish
/// slips, and the move runs slower than its segment and laser duty were
/// planned for.
pub const fn min_tick_us(step_us: u32) -> u32 {
    let needed = (3 * step_us + 1) / 2 + TICK_OVERHEAD_US;
    if needed > MIN_TICK_US {
        needed
    } else {
        MIN_TICK_US
    }
}

/// Most step events a second the generator can produce at that pulse width.
pub fn max_event_rate_hz(step_us: u32) -> f32 {
    1_000_000.0 / min_tick_us(step_us) as f32
}
/// A move shorter than this on the board is a turn on the axis.
pub const SURFACE_EPSILON_MM: f32 = 0.001;
