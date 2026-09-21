//! Step timer arithmetic: the pulse busy-wait and the 32-bit alarm compare
//! of the RP2040 timer, which wraps every 71.6 minutes.

/// Delay to arm when a requested tick is already in the past.
pub const RETRY_US: u32 = 2;

/// Cycles to ask the busy-wait for so the pulse is at least `step_us`.
pub fn pulse_cycles(sysclk_hz: u32, step_us: u32) -> u32 {
    let cycles = sysclk_hz as u64 * step_us as u64 / 1_000_000;
    cycles.clamp(1, u32::MAX as u64) as u32
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pulse_cycles_follow_the_clock() {
        assert_eq!(pulse_cycles(125_000_000, 2), 250);
        assert_eq!(pulse_cycles(125_000_000, 10), 1250);
        assert_eq!(pulse_cycles(125_000_000, 0), 1);
        assert_eq!(pulse_cycles(48_000_000, 3), 144);
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
}
