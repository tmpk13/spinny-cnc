//! Small numeric helpers available without std.

/// Board length of a straight joint move from `(r0, a0)` to `(r1, a1)`,
/// radii in mm and angles in degrees: `hypot(dr, r_mean * da_rad)`.
/// Exact for a pure turn or a pure radial move, a close approximation for
/// the short spirals the host streams.
pub fn surface_length(r0: f32, a0: f32, r1: f32, a1: f32) -> f32 {
    let dr = r1 - r0;
    let arc = 0.5 * (r0 + r1) * (a1 - a0).to_radians();
    hypot(dr, arc)
}

pub fn hypot(x: f32, y: f32) -> f32 {
    libm::sqrtf(x * x + y * y)
}

pub fn sqrt(x: f32) -> f32 {
    libm::sqrtf(x)
}

/// Nearest step count to `units` at `steps_per_unit`, saturating at the
/// i32 range. Computed in f64 so unwrapped angles of millions of steps
/// round to the exact step.
pub fn units_to_steps(units: f32, steps_per_unit: f32) -> i32 {
    let steps = libm::round(units as f64 * steps_per_unit as f64);
    if steps >= i32::MAX as f64 {
        i32::MAX
    } else if steps <= i32::MIN as f64 {
        i32::MIN
    } else {
        steps as i32
    }
}

/// Units for a step position; the division is done in f64 for the same
/// reason as `units_to_steps`.
pub fn steps_to_units(steps: i32, steps_per_unit: f32) -> f32 {
    (steps as f64 / steps_per_unit as f64) as f32
}

/// Steps an axis with `steps` of `event_count` Bresenham events has taken
/// after `done` events, with the counter started at half the event count:
/// `floor(done * steps / event_count + 1/2)`. This is what the stepper
/// interrupt produces, so the planner can shorten a block exactly.
pub fn bresenham_done(done: u32, steps: u32, event_count: u32) -> u32 {
    if event_count == 0 {
        return 0;
    }
    let n = event_count as u64;
    ((n + 2 * done as u64 * steps as u64) / (2 * n)) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turn_and_radial_lengths_are_exact() {
        assert!((surface_length(10.0, 0.0, 10.0, 90.0) - 10.0 * core::f32::consts::FRAC_PI_2).abs() < 1e-4);
        assert!((surface_length(2.0, 30.0, 7.0, 30.0) - 5.0).abs() < 1e-6);
        assert_eq!(surface_length(0.0, 0.0, 0.0, 180.0), 0.0);
    }

    #[test]
    fn steps_round_to_nearest_and_back() {
        assert_eq!(units_to_steps(1.0, 256.0), 256);
        assert_eq!(units_to_steps(-0.5, 256.0), -128);
        assert_eq!(units_to_steps(0.001, 256.0), 0);
        assert_eq!(units_to_steps(0.002, 256.0), 1);
        assert_eq!(units_to_steps(3600.0, 888.889), 3_200_000);
        assert_eq!(units_to_steps(1.0e9, 888.889), i32::MAX);
        assert_eq!(units_to_steps(-1.0e9, 888.889), i32::MIN);
        assert!((steps_to_units(3_200_000, 888.889) - 3600.0).abs() < 1e-3);
        assert_eq!(steps_to_units(-128, 256.0), -0.5);
    }

    #[test]
    fn bresenham_closed_form_matches_the_counter() {
        for &(steps, count) in &[(1u32, 1u32), (3, 7), (7, 7), (0, 5), (100, 256), (888, 1000), (5, 12)] {
            let shifted = count << 3;
            let mut counter = shifted >> 1;
            let mut taken = 0;
            for done in 0..=count {
                assert_eq!(bresenham_done(done, steps, count), taken, "steps {steps} count {count} done {done}");
                if done < count {
                    counter += steps << 3;
                    if counter >= shifted {
                        counter -= shifted;
                        taken += 1;
                    }
                }
            }
            assert_eq!(taken, steps);
        }
        assert_eq!(bresenham_done(3, 5, 0), 0);
        assert_eq!(bresenham_done(1_000_000, 3_000_000, 3_200_000), 937_500);
    }
}
