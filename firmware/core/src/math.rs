//! Small numeric helpers available without std.

use crate::{A, AXES, R, Z};

/// Board length of a straight joint move from `(r0, a0)` to `(r1, a1)`,
/// radii in mm and angles in degrees: `hypot(dr, r_mean * da_rad)`.
/// Exact for a pure turn or a pure radial move, a close approximation for
/// the short spirals the host streams.
pub fn surface_length(r0: f32, a0: f32, r1: f32, a1: f32) -> f32 {
    let dr = r1 - r0;
    let arc = 0.5 * (r0 + r1) * (a1 - a0).to_radians();
    hypot(dr, arc)
}

/// Board length of a straight joint move. On a polar machine the slide is
/// not a joint, so this is `surface_length`. On a cartesian one the head
/// sits `hypot(R, Z)` from the rotation axis, so a turn of the table (a jog
/// lining a board up; go and cut never turn it there) sweeps that radius:
/// `hypot(dr, dz, hypot(r_mean, z_mean) * da_rad)`, exact for a move of one
/// joint and close for the rest. Z is only read on a cartesian machine: a
/// polar one may still carry the value a cartesian session left in it.
pub fn joint_surface_length(start: &[f32; AXES], end: &[f32; AXES], cartesian: bool) -> f32 {
    if !cartesian {
        return surface_length(start[R], start[A], end[R], end[A]);
    }
    let radius = hypot(0.5 * (start[R] + end[R]), 0.5 * (start[Z] + end[Z]));
    norm(&[end[R] - start[R], end[Z] - start[Z], radius * (end[A] - start[A]).to_radians()])
}

pub fn hypot(x: f32, y: f32) -> f32 {
    libm::sqrtf(x * x + y * y)
}

/// Euclidean length of a vector.
pub fn norm(v: &[f32]) -> f32 {
    libm::sqrtf(v.iter().map(|x| x * x).sum())
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

/// Whether `units` at `steps_per_unit` rounds to a step count inside the
/// i32 range, so `units_to_steps` would not saturate.
pub fn fits_steps(units: f32, steps_per_unit: f32) -> bool {
    libm::fabs(libm::round(units as f64 * steps_per_unit as f64)) < i32::MAX as f64
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
    fn the_cross_slide_adds_square_to_the_rail() {
        let start = [1.0, 30.0, 0.0, 2.0];
        let end = [4.0, 30.0, -1.0, 6.0];
        assert!((joint_surface_length(&start, &end, true) - 5.0).abs() < 1e-6, "the focus axis is not on the board");
        // A polar machine ignores whatever Z holds.
        let polar = [10.0, 90.0, 0.0, 2.0];
        assert!((joint_surface_length(&[10.0, 0.0, 0.0, 2.0], &polar, false) - 10.0 * core::f32::consts::FRAC_PI_2).abs() < 1e-4);
    }

    #[test]
    fn a_table_turn_on_a_cartesian_machine_sweeps_the_heads_distance_from_the_axis() {
        // R5 Y20: the head is hypot(5, 20) from the axis.
        let turn = joint_surface_length(&[5.0, 0.0, 0.0, 20.0], &[5.0, 10.0, 0.0, 20.0], true);
        let expected = libm::sqrtf(425.0) * 10.0f32.to_radians();
        assert!((turn - expected).abs() < 1e-4, "{turn} vs {expected}");
        // On the axis's rail line but off it along Y it is still an arc.
        assert!(joint_surface_length(&[0.0, 0.0, 0.0, 20.0], &[0.0, 10.0, 0.0, 20.0], true) > 3.0);
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
        assert!(fits_steps(2_400_000.0, 888.889));
        assert!(!fits_steps(2_500_000.0, 888.889));
        assert!(!fits_steps(-2_500_000.0, 888.889));
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
