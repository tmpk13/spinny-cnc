//! Small float helpers available without std.

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turn_and_radial_lengths_are_exact() {
        assert!((surface_length(10.0, 0.0, 10.0, 90.0) - 10.0 * core::f32::consts::FRAC_PI_2).abs() < 1e-4);
        assert!((surface_length(2.0, 30.0, 7.0, 30.0) - 5.0).abs() < 1e-6);
        assert_eq!(surface_length(0.0, 0.0, 0.0, 180.0), 0.0);
    }
}
