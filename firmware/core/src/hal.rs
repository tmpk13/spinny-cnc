//! What the core needs from the hardware. Every polarity is applied inside
//! the core, so the ports drive raw pin levels.

/// Step and direction pins for the joint axes, and the probe input.
pub trait StepPort {
    /// Pin level per axis (bit i = axis i). Settled before the next pulse.
    fn set_dir(&mut self, levels: u8);
    /// One pulse on every step pin in `mask`, at least `step_us` wide.
    fn step(&mut self, mask: u8);
    /// Level of the shared enable pin.
    fn set_enable(&mut self, high: bool);
    /// Level of the probe input, high true. Read from the step interrupt
    /// during a probe and from the main loop, so a plain register read.
    fn probe(&mut self) -> bool;
}

/// Step and direction pins for the cross slide. It moves alone and never
/// under the beam, so it has no laser and no shared timing; the motor
/// enable is `StepPort::set_enable`, which drives every driver together.
pub trait SlidePort {
    /// Pin level. Settled before the next pulse.
    fn set_dir(&mut self, high: bool);
    /// One pulse on the step pin, at least `step_us` wide.
    fn step(&mut self);
}

/// The laser PWM output. Implementations may be shared between the step
/// interrupt and the main loop, so a single register write per call.
pub trait LaserPort {
    /// High time in permille of the period.
    fn set_duty(&mut self, permille: u16);
    fn set_frequency(&mut self, hz: u32);
}

/// Where responses and reports go.
pub trait Sink {
    fn write(&mut self, bytes: &[u8]);
    fn write_str(&mut self, text: &str) {
        self.write(text.as_bytes());
    }
}

/// Persistent settings storage: one opaque blob.
pub trait Store {
    /// Fills `buf` with the stored blob; `None` when nothing valid is stored.
    fn load(&mut self, buf: &mut [u8]) -> Option<usize>;
    fn save(&mut self, blob: &[u8]) -> bool;
}
