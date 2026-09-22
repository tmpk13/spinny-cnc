//! The cross slide: the axis that carries the rail across the table's
//! rotation axis, so the rail passes over it.
//!
//! It is a setup axis. It moves on its own, only from `Idle`, with the
//! beam off, and it never takes part in a cut, so it has none of the
//! machinery the joints need: no lookahead, no junctions, no Bresenham
//! and no laser. One move is one trapezoid, and the whole of it is a step
//! count, a rate and a ramp.
//!
//! Nothing is tied to its timing, so it runs from the main loop rather
//! than from an interrupt: `poll` emits the steps that have come due and
//! says when it wants the next call. The rate is capped at `MAX_RATE_HZ`
//! so a loop running every 500 us carries it a handful of steps at a
//! time, and the jitter between passes changes nothing but the noise.

use crate::hal::SlidePort;
use crate::math;
use crate::settings::Settings;

/// Fastest the slide is stepped. A polled step generator cannot hold a
/// period much shorter than the loop it runs in, and this is the rate a
/// 500 us loop still carries in bursts a driver resolves.
pub const MAX_RATE_HZ: f32 = 20_000.0;

/// Slowest the slide is stepped. It is the floor under the ends of the
/// ramp, where the computed speed goes to zero, so a move always
/// finishes; a `z_rate` set below it is stepped at it.
pub const MIN_RATE_HZ: f32 = 2.0;

/// Steps one `poll` emits before it hands the caller its loop back. A
/// call that comes very late would otherwise fire the whole backlog at
/// once; the move simply takes longer instead.
const MAX_BURST: u32 = 32;

/// Bit of `dir_invert` that turns the slide around.
const DIR_INVERT_BIT: u8 = 2;

/// One cross slide move, and the position it leaves behind.
pub struct Slide {
    /// Executed position, steps.
    position: i32,
    /// Steps per mm the position is counted in. Kept beside it so a
    /// `z_steps` change between moves cannot rescale it silently.
    steps_per_mm: f32,
    /// Steps of the move in progress, and how many are done.
    total: u32,
    done: u32,
    /// Which way the steps go.
    forward: bool,
    /// Direction pin level for this move, `dir_invert` applied.
    dir_level: bool,
    /// The direction pin has not been driven for this move yet.
    dir_pending: bool,
    /// Cruise rate and acceleration of this move, in steps a second and
    /// steps a second squared.
    cruise: f32,
    accel: f32,
    /// Rate the next step is being taken at, steps a second.
    rate: f32,
    /// When that step is due.
    next_us: u64,
    busy: bool,
}

impl Default for Slide {
    fn default() -> Self {
        Slide::new()
    }
}

impl Slide {
    pub const fn new() -> Self {
        Slide {
            position: 0,
            steps_per_mm: 1.0,
            total: 0,
            done: 0,
            forward: true,
            dir_level: false,
            dir_pending: false,
            cruise: 0.0,
            accel: 0.0,
            rate: 0.0,
            next_us: 0,
            busy: false,
        }
    }

    /// Position in mm, from the steps taken.
    pub fn position(&self) -> f32 {
        math::steps_to_units(self.position, self.steps_per_mm)
    }

    /// Declares the position without moving, for `set Z`.
    pub fn set_position(&mut self, mm: f32, settings: &Settings) {
        self.steps_per_mm = settings.z_steps;
        self.position = math::units_to_steps(mm, settings.z_steps);
    }

    /// A move is running.
    pub fn busy(&self) -> bool {
        self.busy
    }

    /// Starts a move from `from_mm` to `to_mm` at `feed` mm a minute, or
    /// at `jog_z` without one, capped by `z_rate`. A move that rounds to
    /// no steps leaves the slide idle, so the caller sees `busy` false
    /// straight away.
    ///
    /// `from_mm` is where the caller believes the slide is; it becomes
    /// the position the executed steps are counted from.
    pub fn start(&mut self, from_mm: f32, to_mm: f32, feed: Option<f32>, settings: &Settings) {
        self.set_position(from_mm, settings);
        let target = math::units_to_steps(to_mm, settings.z_steps);
        let delta = target as i64 - self.position as i64;
        self.total = delta.unsigned_abs().min(u32::MAX as u64) as u32;
        self.done = 0;
        self.rate = 0.0;
        self.busy = self.total > 0;
        if !self.busy {
            return;
        }
        self.forward = delta > 0;
        self.dir_level = self.forward != (settings.dir_invert & (1 << DIR_INVERT_BIT) != 0);
        self.dir_pending = true;
        // The ramp works in steps and never leaves them, so a move ends
        // on the step it was asked for however the speeds round.
        let mm_per_min = feed.filter(|f| *f > 0.0).unwrap_or(settings.jog_z).min(settings.z_rate);
        self.cruise = (mm_per_min / 60.0 * settings.z_steps).clamp(MIN_RATE_HZ, MAX_RATE_HZ);
        self.accel = settings.z_accel * settings.z_steps;
    }

    /// Brakes to a stop as fast as `z_accel` allows and gives up the rest
    /// of the move. The steps already taken stay in the position, so it
    /// still says where the slide really is.
    pub fn cancel(&mut self) {
        if !self.busy {
            return;
        }
        // Shortening the move to the braking distance is all it takes:
        // the ramp reads the end of the move from `total`, so it starts
        // slowing down on the next step. Braking can never take longer
        // than finishing, which is what the original end stands for.
        let brake = libm::ceilf(self.rate * self.rate / (2.0 * self.accel)) as u32;
        self.total = self.done.saturating_add(brake).min(self.total);
        if self.done >= self.total {
            self.busy = false;
            self.rate = 0.0;
        }
    }

    /// Drops the move where it stands, for a reset or a disconnect.
    pub fn stop(&mut self) {
        self.busy = false;
        self.dir_pending = false;
        self.rate = 0.0;
    }

    /// Emits the steps that have come due and returns the time the next
    /// one is due at, or `None` when there is nothing left to do.
    pub fn poll(&mut self, now_us: u64, port: &mut impl SlidePort) -> Option<u64> {
        if !self.busy {
            return None;
        }
        if self.dir_pending {
            self.dir_pending = false;
            port.set_dir(self.dir_level);
            self.next_us = now_us;
        }
        let mut burst = 0;
        while now_us >= self.next_us {
            port.step();
            self.position += if self.forward { 1 } else { -1 };
            self.done += 1;
            if self.done >= self.total {
                self.busy = false;
                self.rate = 0.0;
                return None;
            }
            self.rate = self.rate_for(self.done);
            // Rounded up, so the rate reached is never above the rate
            // asked for.
            self.next_us += libm::ceilf(1.0e6 / self.rate) as u64;
            burst += 1;
            if burst == MAX_BURST {
                // What is left of a backlog waits for the calls that
                // follow, which is what keeps one late poll from
                // blocking its caller.
                self.next_us = self.next_us.max(now_us + 1);
                break;
            }
        }
        Some(self.next_us)
    }

    /// Rate for the step at index `at`, steps a second: the trapezoid
    /// read at the middle of that step, where the ramp up from the start
    /// and the ramp down to the end meet the cruise rate.
    fn rate_for(&self, at: u32) -> f32 {
        let from_start = at as f32 + 0.5;
        let to_end = (self.total.saturating_sub(at) as f32 - 0.5).max(0.0);
        let rate = self
            .cruise
            .min(math::sqrt(2.0 * self.accel * from_start))
            .min(math::sqrt(2.0 * self.accel * to_end));
        rate.clamp(MIN_RATE_HZ, MAX_RATE_HZ)
    }
}

#[cfg(test)]
mod tests {
    extern crate std;

    use std::vec::Vec;

    use super::*;

    /// The step and direction pins as counters, with the time of every
    /// pulse so the profile can be measured.
    #[derive(Default)]
    struct Port {
        now: u64,
        at: Vec<u64>,
        dir: Option<bool>,
        dir_writes: u32,
    }

    impl SlidePort for Port {
        fn set_dir(&mut self, high: bool) {
            self.dir = Some(high);
            self.dir_writes += 1;
        }

        fn step(&mut self) {
            self.at.push(self.now);
        }
    }

    /// Settings that keep the slide well clear of both the rate cap and
    /// the rate floor, so these tests measure the ramp and not a clamp.
    fn bench() -> Settings {
        Settings {
            z_steps: 256.0,
            z_rate: 600.0,
            z_accel: 50.0,
            jog_z: 120.0,
            ..Settings::default()
        }
    }

    /// Runs the slide to its end, polling exactly when it asks to be
    /// polled. Returns the time it came to rest at.
    fn run(slide: &mut Slide, port: &mut Port, start_us: u64) -> u64 {
        let mut now = start_us;
        let mut polls = 0;
        while let Some(next) = slide.poll(now, port) {
            assert!(next > now, "poll asked to be called again at {next} from {now}");
            now = next;
            port.now = now;
            polls += 1;
            assert!(polls < 10_000_000, "the move never finished");
        }
        now
    }

    /// Speed over each gap between steps, mm a minute.
    fn speeds(port: &Port, steps_per_mm: f32) -> Vec<f32> {
        port.at
            .windows(2)
            .map(|pair| 1.0e6 / (pair[1] - pair[0]) as f32 / steps_per_mm * 60.0)
            .collect()
    }

    #[test]
    fn a_move_takes_exactly_the_steps_it_was_asked_for() {
        let settings = bench();
        for (from, to) in [(0.0f32, 4.0f32), (4.0, 0.0), (0.0, -2.5), (-2.5, 1.25), (0.0, 0.01)] {
            let mut slide = Slide::new();
            let mut port = Port::default();
            slide.start(from, to, None, &settings);
            run(&mut slide, &mut port, 0);
            let target = math::units_to_steps(to, settings.z_steps);
            let want = target - math::units_to_steps(from, settings.z_steps);
            assert_eq!(port.at.len(), want.unsigned_abs() as usize, "{from} to {to}");
            assert_eq!(port.dir, Some(to > from), "{from} to {to}");
            assert_eq!(port.dir_writes, 1, "the direction is driven once a move");
            // The target is the step it rounds to, as everywhere else.
            assert_eq!(slide.position(), math::steps_to_units(target, settings.z_steps), "{from} to {to}");
            assert!(!slide.busy());
        }
    }

    #[test]
    fn the_direction_pin_carries_dir_invert() {
        let mut settings = bench();
        settings.dir_invert = 0b100;
        let mut slide = Slide::new();
        let mut port = Port::default();
        slide.start(0.0, 1.0, None, &settings);
        slide.poll(0, &mut port);
        assert_eq!(port.dir, Some(false), "bit 2 turns the slide around");
        // The other two bits belong to the radius and the table.
        settings.dir_invert = 0b011;
        slide.start(0.0, 1.0, None, &settings);
        slide.poll(0, &mut port);
        assert_eq!(port.dir, Some(true));
    }

    #[test]
    fn the_rate_never_goes_above_z_rate() {
        let settings = bench();
        // Long enough to spend most of the move at the cruise rate.
        let mut slide = Slide::new();
        let mut port = Port::default();
        slide.start(0.0, 20.0, None, &settings);
        run(&mut slide, &mut port, 0);
        let jogged = speeds(&port, settings.z_steps);
        for speed in &jogged {
            assert!(*speed <= settings.jog_z, "{speed} mm/min over the jog rate");
        }
        // Without an F word it runs at jog_z, not at z_rate.
        let top = jogged.iter().cloned().fold(0.0f32, f32::max);
        assert!((top - settings.jog_z).abs() < 0.1, "reached {top} of {}", settings.jog_z);

        // An F word raises it, and z_rate is the ceiling over it.
        let mut port = Port::default();
        slide.start(0.0, 20.0, Some(9000.0), &settings);
        run(&mut slide, &mut port, 0);
        let top = speeds(&port, settings.z_steps).iter().cloned().fold(0.0f32, f32::max);
        assert!(top <= settings.z_rate, "{top} mm/min over z_rate");
        assert!((top - settings.z_rate).abs() < 1.0, "reached {top} of {}", settings.z_rate);
    }

    #[test]
    fn the_step_rate_is_capped_whatever_the_settings_ask() {
        let settings = Settings { z_rate: 1.0e6, jog_z: 1.0e6, ..bench() };
        let mut slide = Slide::new();
        let mut port = Port::default();
        slide.start(0.0, 20.0, None, &settings);
        run(&mut slide, &mut port, 0);
        for pair in port.at.windows(2) {
            let hz = 1.0e6 / (pair[1] - pair[0]) as f32;
            assert!(hz <= MAX_RATE_HZ, "{hz} Hz over the cap");
        }
    }

    #[test]
    fn the_ramp_stays_within_z_accel() {
        let settings = bench();
        let mut slide = Slide::new();
        let mut port = Port::default();
        slide.start(0.0, 10.0, Some(settings.z_rate), &settings);
        run(&mut slide, &mut port, 0);
        let speeds = speeds(&port, settings.z_steps);
        assert!(speeds.len() > 1000);
        // Measured over a window: step periods are whole microseconds,
        // and at speed one step to the next differs by only a few of
        // them, so a pair of steps says more about the rounding than
        // about the ramp.
        const WINDOW: usize = 32;
        let middle = |i: usize| 0.5 * (port.at[i] + port.at[i + 1]) as f32 * 1.0e-6;
        let mut rose = false;
        let mut fell = false;
        for i in 0..speeds.len() - WINDOW {
            let (v0, v1) = (speeds[i] / 60.0, speeds[i + WINDOW] / 60.0);
            let accel = (v1 - v0).abs() / (middle(i + WINDOW) - middle(i));
            assert!(accel <= settings.z_accel * 1.05, "{accel} mm/s^2 at step {i}");
            rose |= v1 > v0;
            fell |= v1 < v0;
        }
        assert!(rose && fell, "a trapezoid ramps up and back down");
        // Both ends are at rest: the slowest steps are the first and last.
        let slowest = speeds.iter().cloned().fold(f32::INFINITY, f32::min);
        assert!(speeds[0] < 2.0 * slowest && speeds[speeds.len() - 1] < 2.0 * slowest);
    }

    #[test]
    fn a_short_move_is_a_triangle_that_never_reaches_the_rate() {
        let settings = bench();
        let mut slide = Slide::new();
        let mut port = Port::default();
        // Ten steps: far too few to reach 120 mm/min at 50 mm/s^2.
        slide.start(0.0, 10.0 / settings.z_steps, None, &settings);
        run(&mut slide, &mut port, 0);
        assert_eq!(port.at.len(), 10);
        let speeds = speeds(&port, settings.z_steps);
        let top = speeds.iter().cloned().fold(0.0f32, f32::max);
        assert!(top < settings.jog_z, "{top} mm/min on a ten step move");
        assert_eq!(slide.position(), 10.0 / settings.z_steps);
    }

    #[test]
    fn a_move_shorter_than_one_step_does_nothing() {
        let settings = bench();
        let mut slide = Slide::new();
        let mut port = Port::default();
        slide.set_position(1.0, &settings);
        // Under half a step at 256 steps per mm.
        slide.start(1.0, 1.0 + 0.4 / settings.z_steps, None, &settings);
        assert!(!slide.busy(), "a move under a step should not start");
        assert_eq!(slide.poll(0, &mut port), None);
        assert!(port.at.is_empty());
        assert_eq!(port.dir, None, "an empty move touches no pin");
        assert_eq!(slide.position(), 1.0);

        slide.start(1.0, 1.0, None, &settings);
        assert!(!slide.busy());
        assert_eq!(slide.position(), 1.0);
    }

    #[test]
    fn a_cancel_stops_short_and_keeps_the_position_it_reached() {
        let settings = bench();
        let mut slide = Slide::new();
        let mut port = Port::default();
        slide.start(0.0, 20.0, Some(settings.z_rate), &settings);
        // Run into the cruise, then cancel.
        let mut now = 0;
        while let Some(next) = slide.poll(now, &mut port) {
            now = next;
            port.now = now;
            if port.at.len() >= 500 {
                break;
            }
        }
        assert!(slide.busy());
        slide.cancel();
        let stepped_before = port.at.len();
        run(&mut slide, &mut port, now);
        assert!(!slide.busy());
        let steps = port.at.len();
        assert!(steps > stepped_before, "the brake takes a few more steps");
        assert!(steps < 5120, "it should stop well short of 20 mm");
        // Where it really is: every pulse counted, nothing rounded away.
        assert_eq!(slide.position(), steps as f32 / settings.z_steps);
        // The brake is a ramp down, not a stop on the spot.
        let speeds = speeds(&port, settings.z_steps);
        let last = speeds[speeds.len() - 1];
        assert!(last < speeds[stepped_before - 2], "{last} mm/min at the end");

        // A second cancel after it has stopped changes nothing.
        let at = slide.position();
        slide.cancel();
        assert!(!slide.busy());
        assert_eq!(slide.position(), at);
    }

    #[test]
    fn a_cancel_before_the_first_step_stops_where_it_started() {
        let settings = bench();
        let mut slide = Slide::new();
        let mut port = Port::default();
        slide.start(2.0, 8.0, None, &settings);
        slide.cancel();
        assert!(!slide.busy());
        assert_eq!(slide.position(), 2.0);
        assert_eq!(slide.poll(0, &mut port), None);
        assert!(port.at.is_empty());
    }

    #[test]
    fn a_stop_drops_the_move_on_the_spot() {
        let settings = bench();
        let mut slide = Slide::new();
        let mut port = Port::default();
        slide.start(0.0, 20.0, None, &settings);
        let mut now = 0;
        while let Some(next) = slide.poll(now, &mut port) {
            now = next;
            port.now = now;
            if port.at.len() >= 100 {
                break;
            }
        }
        slide.stop();
        assert!(!slide.busy());
        let steps = port.at.len();
        assert_eq!(slide.position(), steps as f32 / settings.z_steps);
        assert_eq!(slide.poll(now + 1_000_000, &mut port), None);
        assert_eq!(port.at.len(), steps, "a stopped slide steps no more");
    }

    #[test]
    fn a_late_poll_catches_up_without_a_burst_without_end() {
        let settings = Settings { z_rate: 1.0e6, jog_z: 1.0e6, ..bench() };
        let mut slide = Slide::new();
        let mut port = Port::default();
        slide.start(0.0, 20.0, None, &settings);
        slide.poll(0, &mut port);
        // A whole second late, where the backlog is thousands of steps.
        port.now = 1_000_000;
        slide.poll(1_000_000, &mut port);
        assert!(port.at.len() <= MAX_BURST as usize + 1, "{} steps in one poll", port.at.len());
        // The rest still gets stepped, and the total is still exact.
        run(&mut slide, &mut port, 1_000_000);
        assert_eq!(port.at.len(), (20.0 * settings.z_steps) as usize);
        assert_eq!(slide.position(), 20.0);
    }

    #[test]
    fn the_position_follows_set_position_and_survives_a_scale_change() {
        let mut settings = bench();
        let mut slide = Slide::new();
        assert_eq!(slide.position(), 0.0);
        slide.set_position(-3.5, &settings);
        assert_eq!(slide.position(), -3.5);
        // A new scale takes effect where it is declared, not under a
        // position already counted in the old one.
        settings.z_steps = 512.0;
        assert_eq!(slide.position(), -3.5);
        slide.set_position(-3.5, &settings);
        assert_eq!(slide.position(), -3.5);
    }
}
