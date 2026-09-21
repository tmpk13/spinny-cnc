//! Step timer arithmetic: the pulse busy-wait and the 32-bit alarm
//! schedule of the RP2040 timer, which wraps every 71.6 minutes.

/// Delay to arm when a requested tick is already in the past.
pub const RETRY_US: u32 = 2;

/// Fewest CPU cycles one iteration of `cortex_m::asm::delay` takes on a
/// Cortex-M core. The M0+ takes three (a subtract and a taken branch), so
/// a pulse comes out about 1.5 times its setting; the floor keeps it from
/// ever coming out short.
pub const DELAY_MIN_CYCLES_PER_LOOP: u64 = 2;

/// Iterations to give the busy-wait so the pulse is at least `step_us`.
pub fn pulse_loops(sysclk_hz: u32, step_us: u32) -> u32 {
    let cycles = (sysclk_hz as u64 * step_us as u64).div_ceil(1_000_000);
    cycles.div_ceil(DELAY_MIN_CYCLES_PER_LOOP).clamp(1, u32::MAX as u64) as u32
}

/// Alarm value for `us` after `now`, in the timer's wrapping low word.
pub fn alarm_target(now: u32, us: u32) -> u32 {
    now.wrapping_add(us)
}

/// `target` is not strictly ahead of `now`, so an alarm set to it may
/// never fire.
pub fn alarm_passed(target: u32, now: u32) -> bool {
    (target.wrapping_sub(now) as i32) <= 0
}

/// Target of the next tick, `us` after a base: the previous target when
/// the alarm started this tick, so the time the interrupt itself takes
/// does not stretch the period; `now` when a kick started it. A target
/// that is not ahead of `now` (the interrupt ran longer than the period,
/// or something masked it for a while) becomes `now + RETRY_US`: the
/// schedule slips by the lateness instead of firing a burst of ticks.
pub fn next_target(previous: u32, fired: bool, now: u32, us: u32) -> u32 {
    let base = if fired { previous } else { now };
    let target = alarm_target(base, us);
    if alarm_passed(target, now) {
        alarm_target(now, RETRY_US)
    } else {
        target
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pulse_loops_cover_the_width_at_two_cycles_a_loop() {
        // 250 cycles at 125 MHz for 2 us, at least two cycles per iteration.
        assert_eq!(pulse_loops(125_000_000, 2), 125);
        assert_eq!(pulse_loops(125_000_000, 10), 625);
        assert_eq!(pulse_loops(125_000_000, 0), 1);
        assert_eq!(pulse_loops(48_000_000, 3), 72);
        // Odd counts round up, never down.
        assert_eq!(pulse_loops(125_000_000, 1), 63);
        assert_eq!(pulse_loops(1_000_001, 1), 1);
        assert_eq!(pulse_loops(1_000_001, 3), 2);
    }

    #[test]
    fn targets_wrap_with_the_timer() {
        assert_eq!(alarm_target(10, 5), 15);
        assert_eq!(alarm_target(u32::MAX, 5), 4);
        assert_eq!(alarm_target(u32::MAX - 1, 2), 0);
    }

    #[test]
    fn passed_is_a_signed_compare() {
        assert!(alarm_passed(10, 10));
        assert!(alarm_passed(9, 10));
        assert!(!alarm_passed(11, 10));
        assert!(!alarm_passed(4, u32::MAX));
        assert!(alarm_passed(u32::MAX, 4));
        assert!(!alarm_passed(alarm_target(100, i32::MAX as u32), 100));
    }

    #[test]
    fn next_target_counts_from_the_alarm_not_from_the_interrupt() {
        // The interrupt finished 8 us after its target; the period still
        // starts at the target.
        assert_eq!(next_target(1000, true, 1008, 62), 1062);
        // A kick starts a fresh schedule from now, whatever the old target.
        assert_eq!(next_target(1000, false, 5000, 62), 5062);
        assert_eq!(next_target(1000, false, 900, 62), 962);
        // Late by a period or more: a little ahead of now, no catch-up burst.
        assert_eq!(next_target(1000, true, 1062, 62), 1064);
        assert_eq!(next_target(1000, true, 1500, 62), 1502);
        // Across the timer wrap.
        assert_eq!(next_target(u32::MAX - 10, true, u32::MAX - 2, 20), 9);
        assert_eq!(next_target(u32::MAX - 10, true, 30, 20), 32);
    }
}
