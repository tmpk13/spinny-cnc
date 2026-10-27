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

#[cfg(test)]
mod tests {
    use super::*;

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
