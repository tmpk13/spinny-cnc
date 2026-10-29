//! Spotting a locked-up USB device controller.
//!
//! RP2040 erratum E15: a bus error during an IN transfer (a corrupt
//! handshake from the host, or noise on D+/D-) can leave the device
//! controller answering no token at all, while the pull-up keeps it on
//! the bus. The host sees protocol errors on every transfer and logs
//! nothing, the firmware sees no device event, and the main loop goes on
//! feeding the watchdog, so nothing resets: only a bus reset clears it.
//!
//! A configured device on an awake bus gets a start of frame every
//! millisecond, and the controller latches its frame number. A frame
//! number that stops moving without the bus being suspended is the
//! lockup; the firmware then drops its pull-up so the host sees an
//! unplug, and the host's re-enumeration resets the controller.
//!
//! Fewer lockups: the late IN token that sets it off comes in the last
//! 200 us of a frame, so a bulk IN packet is only handed to the
//! controller early in one (the workaround of TinyUSB and the Pico SDK).
//! The controller has no clock within a frame, only the frame number, so
//! `FrameClock` places the start of a frame between two looks at the
//! number taken close together on either side of it.

/// How long the frame number may stand still on an awake bus. Frames
/// come every millisecond, and a suspend is detected after 3 ms.
pub const STALL_MS: u32 = 100;

pub struct FrameWatch {
    /// The frame number last seen, and since when it has not moved.
    last: Option<(u16, u32)>,
}

impl Default for FrameWatch {
    fn default() -> Self {
        Self::new()
    }
}

impl FrameWatch {
    pub const fn new() -> Self {
        FrameWatch { last: None }
    }

    /// Takes one look at the frame number. `active` is the device being
    /// configured on a bus that is not suspended; while it is not, nothing
    /// is expected to move. True once for each stall, after which the
    /// watch starts over.
    pub fn check(&mut self, now_ms: u32, active: bool, frame: u16) -> bool {
        if !active {
            self.last = None;
            return false;
        }
        match self.last {
            Some((seen, since)) if seen == frame => {
                if now_ms.wrapping_sub(since) >= STALL_MS {
                    self.last = None;
                    true
                } else {
                    false
                }
            }
            _ => {
                self.last = Some((frame, now_ms));
                false
            }
        }
    }
}

/// Frame numbers wrap at 11 bits.
const FRAME_MASK: u16 = 0x7ff;
/// The widest gap between two looks that still places a frame start:
/// the start lies somewhere between them, so this is the error.
pub const LOOK_GAP_US: u32 = 300;
/// How far into a frame a packet may still be handed over. The late
/// tokens come after 800 us; this leaves room for an interrupt between
/// the look and the hand-over.
pub const EARLY_US: u32 = 700;

/// Where the bus is within its frame, from looks at the frame number.
pub struct FrameClock {
    /// The last look: frame number and microseconds.
    last: Option<(u16, u32)>,
    /// A frame and a time its start came after.
    start: Option<(u16, u32)>,
}

impl Default for FrameClock {
    fn default() -> Self {
        Self::new()
    }
}

impl FrameClock {
    pub const fn new() -> Self {
        FrameClock { last: None, start: None }
    }

    /// Takes one look; true when the frame now running is known to have
    /// started less than `EARLY_US` ago. Known only once a look has seen
    /// the number step by one within `LOOK_GAP_US` of the look before:
    /// a slower look, or a skipped frame, says nothing of where the start
    /// fell, and the clock waits for the next one.
    pub fn early(&mut self, frame: u16, now_us: u32) -> bool {
        if let Some((seen, at)) = self.last {
            if frame == (seen.wrapping_add(1) & FRAME_MASK) && now_us.wrapping_sub(at) <= LOOK_GAP_US {
                self.start = Some((frame, at));
            }
        }
        self.last = Some((frame, now_us));
        matches!(self.start, Some((started, after)) if started == frame && now_us.wrapping_sub(after) < EARLY_US)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The frame number a bus whose frames start at `offset_us` shows at `now_us`.
    fn frame_at(now_us: u32, offset_us: u32) -> u16 {
        ((now_us.wrapping_sub(offset_us) / 1000) as u16) & FRAME_MASK
    }

    #[test]
    fn close_looks_place_the_frame_start_and_say_early_only_before_700_us() {
        let mut clock = FrameClock::new();
        let offset = 250;
        let mut early_at = Vec::new();
        for now in (0..5000u32).step_by(50) {
            if clock.early(frame_at(now, offset), now) {
                early_at.push(now);
            }
        }
        assert!(!early_at.is_empty());
        for now in early_at {
            // True time into the frame, which the clock never overstates.
            let into = (now + 1000 - offset) % 1000;
            assert!(into < EARLY_US, "early at {now}, {into} us into the frame");
        }
    }

    #[test]
    fn looks_far_apart_never_say_early() {
        let mut clock = FrameClock::new();
        for now in (0..20_000u32).step_by(400) {
            assert!(!clock.early(frame_at(now, 0), now));
        }
    }

    #[test]
    fn a_skipped_frame_says_nothing() {
        let mut clock = FrameClock::new();
        assert!(!clock.early(10, 0));
        assert!(!clock.early(12, 100));
        assert!(!clock.early(12, 150));
        // The next step, seen closely, does.
        assert!(!clock.early(12, 1000));
        assert!(clock.early(13, 1100));
    }

    #[test]
    fn a_start_is_good_for_its_own_frame_only() {
        let mut clock = FrameClock::new();
        assert!(!clock.early(4, 0));
        assert!(clock.early(5, 100));
        assert!(clock.early(5, 699));
        assert!(!clock.early(5, 700));
        // Seen late in the next frame: its start is not placed.
        assert!(!clock.early(6, 1900));
    }

    #[test]
    fn the_frame_number_and_the_clock_wrap() {
        let mut clock = FrameClock::new();
        let start = u32::MAX - 50;
        assert!(!clock.early(FRAME_MASK, start));
        assert!(clock.early(0, start.wrapping_add(100)));
    }

    #[test]
    fn moving_frames_are_never_a_stall() {
        let mut watch = FrameWatch::new();
        for ms in 0..1000u32 {
            assert!(!watch.check(ms * 10, true, ((ms * 10) & 0x7ff) as u16));
        }
    }

    #[test]
    fn a_frame_number_that_stands_still_is_a_stall_once() {
        let mut watch = FrameWatch::new();
        assert!(!watch.check(0, true, 5));
        assert!(!watch.check(50, true, 5));
        assert!(!watch.check(99, true, 5));
        assert!(watch.check(100, true, 5));
        // Starts over: another full wait before the next verdict.
        assert!(!watch.check(110, true, 5));
        assert!(!watch.check(200, true, 5));
        assert!(watch.check(210, true, 5));
    }

    #[test]
    fn nothing_is_expected_while_unconfigured_or_suspended() {
        let mut watch = FrameWatch::new();
        for ms in (0..1000u32).step_by(10) {
            assert!(!watch.check(ms, false, 5));
        }
        // Back on an awake bus, the wait starts from the first look.
        assert!(!watch.check(1000, true, 5));
        assert!(!watch.check(1090, true, 5));
        assert!(watch.check(1100, true, 5));
    }

    #[test]
    fn a_suspend_in_the_middle_restarts_the_wait() {
        let mut watch = FrameWatch::new();
        assert!(!watch.check(0, true, 5));
        assert!(!watch.check(90, false, 5));
        assert!(!watch.check(100, true, 5));
        assert!(!watch.check(190, true, 5));
        assert!(watch.check(200, true, 5));
    }

    #[test]
    fn the_millisecond_clock_wrapping_is_not_a_stall() {
        let mut watch = FrameWatch::new();
        let start = u32::MAX - 20;
        assert!(!watch.check(start, true, 1));
        assert!(!watch.check(start.wrapping_add(50), true, 1));
        assert!(watch.check(start.wrapping_add(100), true, 1));
    }
}
