//! Laser PWM arithmetic for an RP2040 PWM slice: an integer clock divider
//! and a 16-bit wrap value per frequency, and a compare value per duty.

/// PWM slice a pin belongs to. The RP2040 wires GPIO `n` to slice
/// `(n / 2) % 8`, channel A when `n` is even and channel B when it is odd,
/// so the slice and the channel are not free choices once the pin is known.
pub const fn pwm_slice(gpio: u8) -> usize {
    (gpio as usize / 2) % 8
}

/// Whether a pin drives channel A of its slice; channel B otherwise.
pub const fn pwm_is_channel_a(gpio: u8) -> bool {
    gpio % 2 == 0
}

/// Divider and wrap value for one PWM frequency.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PwmParams {
    /// Integer clock divider, 1..=255.
    pub div: u8,
    /// Counter wrap value; the period is `top + 1` divided clocks.
    pub top: u16,
}

/// Longest period in divided clocks. One below the counter's range so a
/// full-duty compare of `top + 1` still fits in the 16-bit compare field.
const MAX_PERIOD: u64 = 65535;

/// Picks the smallest integer divider that fits the period in 16 bits,
/// then the wrap value closest to `hz`. Frequencies the hardware cannot
/// reach are clamped to its range.
pub fn pwm_params(sysclk_hz: u32, hz: u32) -> PwmParams {
    let hz = hz.max(1) as u64;
    let clk = sysclk_hz as u64;
    let div = clk.div_ceil(hz * MAX_PERIOD).clamp(1, 255);
    let period = (clk / (div * hz)).clamp(2, MAX_PERIOD);
    PwmParams {
        div: div as u8,
        top: (period - 1) as u16,
    }
}

/// Compare value for a duty in permille: 0 is always low, 1000 is always
/// high (`top + 1` never matches the counter).
pub fn compare(top: u16, permille: u16) -> u16 {
    let permille = permille.min(1000) as u32;
    ((top as u32 + 1) * permille / 1000) as u16
}

/// Duty in permille that keeps the output dark at a polarity: 0 holds the
/// pin low, 1000 holds it high for a module that fires on a low input. The
/// pin is claimed at this level, and it is also the duty a frequency
/// change recomputes the compare from until the first duty is set, so the
/// two are seeded from the same value.
pub const fn resting_duty(invert: bool) -> u16 {
    if invert {
        1000
    } else {
        0
    }
}

/// Whether the compare goes before the wrap value when the period changes
/// from `old_top` to `new_top`. Between the two writes the slice runs on
/// one old and one new value; this order keeps that compare at or below
/// what the duty asks for at that wrap, so a compare above the wrap never
/// holds the output high in between.
pub fn compare_before_top(old_top: u16, new_top: u16) -> bool {
    new_top < old_top
}

#[cfg(test)]
mod tests {
    use super::*;

    const SYSCLK: u32 = 125_000_000;

    fn frequency(p: PwmParams) -> f64 {
        SYSCLK as f64 / (p.div as f64 * (p.top as f64 + 1.0))
    }

    #[test]
    fn a_pins_slice_and_channel_follow_from_its_number() {
        // The laser sits on GP20, the SKR Pico's FAN3 output.
        assert_eq!(pwm_slice(20), 2);
        assert!(pwm_is_channel_a(20));
        // Pins that have been considered for it, and the ends of the range.
        assert_eq!((pwm_slice(29), pwm_is_channel_a(29)), (6, false));
        assert_eq!((pwm_slice(25), pwm_is_channel_a(25)), (4, false));
        assert_eq!((pwm_slice(0), pwm_is_channel_a(0)), (0, true));
        assert_eq!((pwm_slice(16), pwm_is_channel_a(16)), (0, true));
        // Neighboring pins share a slice and split its two channels.
        for gpio in 0..30u8 {
            assert_eq!(pwm_slice(gpio), pwm_slice(gpio ^ 1));
            assert_ne!(pwm_is_channel_a(gpio), pwm_is_channel_a(gpio ^ 1));
        }
    }

    #[test]
    fn default_frequency_uses_divider_one() {
        let p = pwm_params(SYSCLK, 5000);
        assert_eq!(p, PwmParams { div: 1, top: 24999 });
        assert!((frequency(p) - 5000.0).abs() < 0.01);
    }

    #[test]
    fn low_frequencies_raise_the_divider() {
        let p = pwm_params(SYSCLK, 1000);
        assert_eq!(p, PwmParams { div: 2, top: 62499 });
        assert!((frequency(p) - 1000.0).abs() < 0.01);
        let p = pwm_params(SYSCLK, 100);
        assert_eq!(p.div, 20);
        assert!((frequency(p) - 100.0).abs() < 0.01);
    }

    #[test]
    fn out_of_range_frequencies_are_clamped() {
        let p = pwm_params(SYSCLK, 1);
        assert_eq!(p, PwmParams { div: 255, top: 65534 });
        let p = pwm_params(SYSCLK, 0);
        assert_eq!(p.div, 255);
        let p = pwm_params(SYSCLK, 100_000_000);
        assert_eq!(p, PwmParams { div: 1, top: 1 });
    }

    #[test]
    fn compare_maps_permille_onto_the_period() {
        assert_eq!(compare(24999, 0), 0);
        assert_eq!(compare(24999, 500), 12500);
        assert_eq!(compare(24999, 1000), 25000);
        assert_eq!(compare(24999, 1500), 25000);
        assert_eq!(compare(65534, 1000), 65535);
        assert_eq!(compare(9, 1), 0);
        assert_eq!(compare(9, 100), 1);
    }

    #[test]
    fn a_frequency_change_before_the_first_duty_keeps_the_output_dark() {
        // The pin is claimed at the resting duty, and the stored frequency
        // goes in right after, its compare worked out from the duty kept
        // with it. A duty kept at 0 for an inverted module would put a
        // compare of 0 there, which holds the pin low: lit.
        for invert in [false, true] {
            let rest = resting_duty(invert);
            let claimed = compare(pwm_params(SYSCLK, 5000).top, rest);
            for hz in [5000, 20_000, 200, 1] {
                let top = pwm_params(SYSCLK, hz).top;
                let retuned = compare(top, rest);
                if invert {
                    assert_eq!(claimed, 25000, "always high from the claim on");
                    assert_eq!(retuned as u32, top as u32 + 1, "always high at {hz} Hz");
                } else {
                    assert_eq!((claimed, retuned), (0, 0), "always low at {hz} Hz");
                }
            }
        }
    }

    #[test]
    fn reprogramming_never_raises_the_duty_in_between() {
        let pairs = [(24999u16, 1249u16), (1249, 24999), (62499, 62499), (1, 65534), (65534, 1)];
        for (old_top, new_top) in pairs {
            for permille in [0u16, 1, 250, 500, 999, 1000] {
                let old_cc = compare(old_top, permille);
                let new_cc = compare(new_top, permille);
                // The slice between the first write and the second.
                let (cc, top) = if compare_before_top(old_top, new_top) {
                    (new_cc, old_top)
                } else {
                    (old_cc, new_top)
                };
                assert!(cc <= compare(top, permille), "{old_top}->{new_top} at {permille}: {cc} on top {top}");
                assert!(cc as u32 <= top as u32 + 1);
                if permille == 0 {
                    assert_eq!(cc, 0);
                }
            }
        }
        assert!(compare_before_top(24999, 1249));
        assert!(!compare_before_top(1249, 24999));
        assert!(!compare_before_top(100, 100));
    }
}
