//! Laser PWM arithmetic for an RP2040 PWM slice: an integer clock divider
//! and a 16-bit wrap value per frequency, and a compare value per duty.

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

#[cfg(test)]
mod tests {
    use super::*;

    const SYSCLK: u32 = 125_000_000;

    fn frequency(p: PwmParams) -> f64 {
        SYSCLK as f64 / (p.div as f64 * (p.top as f64 + 1.0))
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
}
