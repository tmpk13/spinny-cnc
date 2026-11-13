//! Servo outputs on the board: which pins and which I2C bus the stored
//! settings get at boot, the 50 Hz pulse on an RP2040 PWM slice, and the
//! PCA9685's registers for a servo on one of its channels.
//!
//! A servo takes a pulse every 20 ms whose width is its angle, 1 to 2 ms
//! on most. On the board's own pins that is a PWM slice running at 50 Hz;
//! through a PCA9685 it is the chip's 12-bit counter, also run at 50 Hz,
//! over I2C. The core keeps each servo's pulse in microseconds and the
//! board turns it into a compare value here.

use core::fmt::Write;

use heapless::String;
use spinny_core::settings::{
    i2c_block, i2c_scl_capable, i2c_sda_capable, output_pin_valid, Settings, PCA_CHANNELS, SERVO_PCA, SERVO_PIN,
};
use spinny_core::SERVOS;

use crate::laser::{pwm_is_channel_a, pwm_params, pwm_slice, PwmParams};

/// The pulse rate every hobby servo takes, a pulse each 20 ms.
pub const SERVO_HZ: u32 = 50;

/// The PWM slice settings for a servo pin: the smallest divider that fits
/// a 50 Hz period in 16 bits, 39 at 125 MHz, for a step of 0.312 us.
pub fn servo_params(sysclk_hz: u32) -> PwmParams {
    pwm_params(sysclk_hz, SERVO_HZ)
}

/// The compare value for a pulse of `us` microseconds on a slice set up by
/// `servo_params`: the divided clocks it lasts, rounded, and never past
/// the period. 0 holds the pin low, which is no pulse.
pub fn servo_compare(sysclk_hz: u32, params: PwmParams, us: u16) -> u16 {
    let clocks_per_us = sysclk_hz as u64;
    let divided = params.div as u64 * 1_000_000;
    let counts = (us as u64 * clocks_per_us + divided / 2) / divided;
    counts.min(params.top as u64) as u16
}

/// The servo and bus settings the board reads at boot.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ServoWiring {
    pub out: [u8; SERVOS],
    pub pin: [u8; SERVOS],
    pub chan: [u8; SERVOS],
    pub sda: u8,
    pub scl: u8,
    pub addr: u8,
}

impl ServoWiring {
    pub fn of(settings: &Settings) -> ServoWiring {
        ServoWiring {
            out: settings.servo_out,
            pin: settings.servo_pin.map(|pin| pin as u8),
            chan: settings.servo_chan,
            sda: settings.i2c_sda as u8,
            scl: settings.i2c_scl as u8,
            addr: settings.pca_addr as u8,
        }
    }
}

/// The pins already claimed when the servos come to theirs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Claimed {
    /// The laser's PWM output: its whole slice runs at the laser's rate.
    pub laser: u8,
    /// The tool output, when one is driven.
    pub tool: Option<u8>,
    pub probe: u8,
}

/// Why a servo, or the PCA9685's bus, was left without its pins.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refused {
    /// A pin no servo setting may name: a driver socket's, the UART's, or
    /// a STOP header's behind its input buffer.
    NotFree(u8),
    /// The laser's own pin, or one on the laser's PWM slice, which runs
    /// at the laser's rate.
    LaserSlice(u8),
    /// The tool output's pin.
    Tool(u8),
    /// The probe input's pin.
    Probe(u8),
    /// The PWM channel of servo `servo` (from 0) on `pin`: GPIO n and
    /// n + 16 drive the same channel.
    Channel { pin: u8, servo: usize },
    /// The bus's two pins are not one I2C block's data and clock lines.
    Blocks { sda: u8, scl: u8 },
    /// A bus pin is servo `servo`'s (from 0).
    Servo { pin: u8, servo: usize },
}

/// The PCA9685 as the board starts it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pca {
    pub sda: u8,
    pub scl: u8,
    /// I2C0 or I2C1.
    pub block: u8,
    pub addr: u8,
    /// Each servo's channel, for those on the PCA9685.
    pub channels: [Option<u8>; SERVOS],
}

/// What the board claims for the servos at boot.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ServoPlan {
    /// Each servo's pin, for those on the board.
    pub pins: [Option<u8>; SERVOS],
    /// Why a servo on the board got no pin.
    pub refused: [Option<Refused>; SERVOS],
    /// The PCA9685, when a servo is on it and its bus has its pins.
    pub pca: Option<Pca>,
    /// Why a servo on the PCA9685 has no bus.
    pub bus_refused: Option<Refused>,
}

/// Works out the servos' pins after the laser, the tool output and the
/// probe have theirs: the machine file refuses every clash, so this only
/// keeps settings made at the console from driving a pin twice. A servo on
/// the board takes its pin unless it is another output's, the probe's, on
/// the laser's PWM slice, or on the PWM channel of an earlier servo; the
/// PCA9685's bus takes its two pins unless they are not one I2C block's,
/// or one is any of those.
pub fn plan(wiring: &ServoWiring, claimed: &Claimed) -> ServoPlan {
    let mut pins = [None; SERVOS];
    let mut refused = [None; SERVOS];
    for i in 0..SERVOS {
        if wiring.out[i] != SERVO_PIN {
            continue;
        }
        let pin = wiring.pin[i];
        let earlier = (0..i).find(|&j| pins[j].is_some_and(|other| same_channel(other, pin)));
        let why = if !output_pin_valid(pin as u32) {
            Some(Refused::NotFree(pin))
        } else if pwm_slice(pin) == pwm_slice(claimed.laser) {
            Some(Refused::LaserSlice(pin))
        } else if claimed.tool == Some(pin) {
            Some(Refused::Tool(pin))
        } else if claimed.probe == pin {
            Some(Refused::Probe(pin))
        } else {
            earlier.map(|servo| Refused::Channel { pin, servo })
        };
        match why {
            Some(why) => refused[i] = Some(why),
            None => pins[i] = Some(pin),
        }
    }
    let channels: [Option<u8>; SERVOS] =
        core::array::from_fn(|i| (wiring.out[i] == SERVO_PCA && wiring.chan[i] < PCA_CHANNELS).then_some(wiring.chan[i]));
    let (pca, bus_refused) = if channels.iter().all(Option::is_none) {
        (None, None)
    } else {
        match bus_refusal(wiring, claimed, &pins) {
            Some(why) => (None, Some(why)),
            None => (
                Some(Pca { sda: wiring.sda, scl: wiring.scl, block: i2c_block(wiring.sda as u32) as u8, addr: wiring.addr, channels }),
                None,
            ),
        }
    };
    ServoPlan { pins, refused, pca, bus_refused }
}

/// GPIO n and n + 16 drive the same channel of the same PWM slice.
fn same_channel(a: u8, b: u8) -> bool {
    pwm_slice(a) == pwm_slice(b) && pwm_is_channel_a(a) == pwm_is_channel_a(b)
}

fn bus_refusal(wiring: &ServoWiring, claimed: &Claimed, servo_pins: &[Option<u8>; SERVOS]) -> Option<Refused> {
    let (sda, scl) = (wiring.sda, wiring.scl);
    for pin in [sda, scl] {
        if !output_pin_valid(pin as u32) {
            return Some(Refused::NotFree(pin));
        }
    }
    if !i2c_sda_capable(sda as u32) || !i2c_scl_capable(scl as u32) || i2c_block(sda as u32) != i2c_block(scl as u32) {
        return Some(Refused::Blocks { sda, scl });
    }
    for pin in [sda, scl] {
        if pin == claimed.laser {
            return Some(Refused::LaserSlice(pin));
        }
        if claimed.tool == Some(pin) {
            return Some(Refused::Tool(pin));
        }
        if claimed.probe == pin {
            return Some(Refused::Probe(pin));
        }
        if let Some(servo) = servo_pins.iter().position(|&other| other == Some(pin)) {
            return Some(Refused::Servo { pin, servo });
        }
    }
    None
}

/// The body of the `[MSG:...]` line for a servo left without its pin.
pub fn refused_text(servo: usize, why: Refused) -> String<96> {
    let mut text = String::new();
    let n = servo + 1;
    let _ = match why {
        Refused::NotFree(pin) => write!(text, "servo {n} on GP{pin} not driven: a driver socket's, the UART's or a STOP input's pin"),
        Refused::LaserSlice(pin) => write!(text, "servo {n} on GP{pin} not driven: PWM slice {} is the laser's", pwm_slice(pin)),
        Refused::Tool(pin) => write!(text, "servo {n} on GP{pin} not driven: the tool output's pin"),
        Refused::Probe(pin) => write!(text, "servo {n} on GP{pin} not driven: the probe's pin"),
        Refused::Channel { pin, servo } => {
            write!(text, "servo {n} on GP{pin} not driven: the PWM channel of servo {}", servo + 1)
        }
        Refused::Blocks { .. } | Refused::Servo { .. } => write!(text, "servo {n} not driven"),
    };
    text
}

/// The body of the `[MSG:...]` line for a PCA9685 left without its bus.
pub fn bus_refused_text(why: Refused) -> String<96> {
    let mut text = String::new();
    let _ = match why {
        Refused::Blocks { sda, scl } => {
            write!(text, "servo pca9685 not started: GP{sda} and GP{scl} are not one I2C block's data and clock")
        }
        Refused::NotFree(pin) => write!(text, "servo pca9685 not started: GP{pin} is a driver socket's, the UART's or a STOP input's"),
        Refused::LaserSlice(pin) => write!(text, "servo pca9685 not started: GP{pin} is the laser's"),
        Refused::Tool(pin) => write!(text, "servo pca9685 not started: GP{pin} is the tool output's"),
        Refused::Probe(pin) => write!(text, "servo pca9685 not started: GP{pin} is the probe's"),
        Refused::Servo { pin, servo } => write!(text, "servo pca9685 not started: GP{pin} is servo {}'s", servo + 1),
        Refused::Channel { .. } => write!(text, "servo pca9685 not started"),
    };
    text
}

/// The PCA9685's internal oscillator (PCA9685 datasheet Rev. 4, 7.3.5
/// PWM frequency PRE_SCALE): 25 MHz, give or take a few percent from chip
/// to chip, which the servo's pulse span takes up.
pub const PCA_OSC_HZ: u32 = 25_000_000;
/// Registers (datasheet, 7.3 Register descriptions, Table 4).
pub const MODE1: u8 = 0x00;
pub const MODE2: u8 = 0x01;
pub const LED0_ON_L: u8 = 0x06;
pub const ALL_LED_ON_H: u8 = 0xFB;
pub const ALL_LED_OFF_H: u8 = 0xFD;
pub const PRE_SCALE: u8 = 0xFE;
/// MODE1: register auto-increment, and the low power mode that stops the
/// oscillator, the only state PRE_SCALE can be written in. ALLCALL, set
/// at power-up, makes the chip answer 0x70 as well.
pub const MODE1_AI: u8 = 0x20;
pub const MODE1_SLEEP: u8 = 0x10;
pub const MODE1_ALLCALL: u8 = 0x01;
/// MODE2: totem pole outputs, the power-up value, which drive a servo's
/// signal line both ways.
pub const MODE2_OUTDRV: u8 = 0x04;
/// The bit of LEDn_ON_H and LEDn_OFF_H that holds an output fully on or
/// fully off whatever the counts.
pub const FULL: u8 = 0x10;
/// The oscillator takes this long to start after SLEEP is cleared
/// (datasheet, 7.3.1 Mode register 1, Remark), microseconds.
pub const WAKE_US: u64 = 500;
/// The chip's counter: 4096 steps a period.
pub const PCA_COUNTS: u32 = 4096;

/// PRE_SCALE for an output rate (datasheet, Equation 1): round(osc /
/// (4096 * rate)) - 1, which the chip holds to 3 or more. 121 for 50 Hz.
pub fn pca_prescale(hz: u32) -> u8 {
    let hz = hz.max(1);
    let divisor = PCA_COUNTS.saturating_mul(hz);
    let rounded = (PCA_OSC_HZ + divisor / 2) / divisor;
    rounded.saturating_sub(1).clamp(3, 255) as u8
}

/// The counts of a pulse of `us` microseconds at a PRE_SCALE: one count
/// lasts (prescale + 1) / 25 us, 4.88 us at 50 Hz. Held below the period.
pub fn pca_counts(us: u16, prescale: u8) -> u16 {
    let per_count = prescale as u32 + 1;
    let counts = (us as u32 * (PCA_OSC_HZ / 1_000_000) + per_count / 2) / per_count;
    counts.min(PCA_COUNTS - 1) as u16
}

/// The write that sets one channel: its register, then ON at count 0 and
/// OFF at the pulse's end, low bytes first, the four latched together
/// when the write stops (MODE2 OCH 0, the power-up value). No pulse is
/// the full off bit.
pub fn pca_channel_write(channel: u8, pulse: Option<u16>, prescale: u8) -> [u8; 5] {
    let register = LED0_ON_L + 4 * channel;
    match pulse {
        Some(us) => {
            let off = pca_counts(us, prescale);
            [register, 0, 0, (off & 0xFF) as u8, (off >> 8) as u8]
        }
        None => [register, 0, 0, 0, FULL],
    }
}

/// The writes that set the chip up, in order, each a register and its
/// value: asleep, so PRE_SCALE takes; the rate; totem pole outputs; every
/// channel fully off, so none a setup from before left running carries
/// on; then awake with auto-increment and without the all-call address.
/// The servos' channels are written after `WAKE_US`.
pub fn pca_setup(prescale: u8) -> [[u8; 2]; 6] {
    [
        [MODE1, MODE1_SLEEP],
        [PRE_SCALE, prescale],
        [MODE2, MODE2_OUTDRV],
        [ALL_LED_ON_H, 0],
        [ALL_LED_OFF_H, FULL],
        [MODE1, MODE1_AI],
    ]
}

/// Whether MODE1 as read back is the chip as `pca_setup` left it: awake
/// and auto-incrementing. A chip that lost its supply comes back asleep,
/// all-call on and auto-increment off (MODE1 0x11), its rate and every
/// channel at their power-up values, and has to be set up again.
pub fn pca_holds_setup(mode1: u8) -> bool {
    mode1 & (MODE1_SLEEP | MODE1_AI) == MODE1_AI
}

/// The body of the `[MSG:...]` line once the PCA9685 is set up.
pub fn pca_ready_text(pca: &Pca) -> String<96> {
    let mut text = String::new();
    let _ = write!(text, "servo pca9685 0x{:02x} on GP{} GP{} ready", pca.addr, pca.sda, pca.scl);
    text
}

/// The body of the `[MSG:...]` line for a PCA9685 that does not answer.
pub fn pca_missing_text(pca: &Pca) -> String<96> {
    let mut text = String::new();
    let _ = write!(text, "servo pca9685 0x{:02x} on GP{} GP{} not answering, retrying", pca.addr, pca.sda, pca.scl);
    text
}

/// The body of the `[MSG:...]` line for a PCA9685 found reset.
pub fn pca_reset_text(pca: &Pca) -> String<96> {
    let mut text = String::new();
    let _ = write!(text, "servo pca9685 0x{:02x} lost its setup, setting it up again", pca.addr);
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use spinny_core::settings::SERVO_NONE;

    const SYSCLK: u32 = 125_000_000;

    fn wiring() -> ServoWiring {
        ServoWiring::of(&Settings::default())
    }

    fn claimed() -> Claimed {
        Claimed { laser: 20, tool: None, probe: 25 }
    }

    #[test]
    fn a_servo_pin_runs_its_slice_at_fifty_hertz() {
        let p = servo_params(SYSCLK);
        assert_eq!(p, PwmParams { div: 39, top: 64101 });
        let hz = SYSCLK as f64 / (p.div as f64 * (p.top as f64 + 1.0));
        assert!((hz - 50.0).abs() < 0.01, "{hz}");
        // 0.312 us a count.
        assert_eq!(servo_compare(SYSCLK, p, 1000), 3205);
        assert_eq!(servo_compare(SYSCLK, p, 1500), 4808);
        assert_eq!(servo_compare(SYSCLK, p, 2000), 6410);
        assert_eq!(servo_compare(SYSCLK, p, 0), 0);
        assert_eq!(servo_compare(SYSCLK, p, u16::MAX), 64101, "never past the period");
        // A pulse is what it says within a count.
        for us in [200u16, 544, 1000, 1500, 2400, 3000] {
            let counts = servo_compare(SYSCLK, p, us) as f64;
            let width = counts * p.div as f64 / (SYSCLK as f64 / 1e6);
            assert!((width - us as f64).abs() <= 0.16, "{us}: {width}");
        }
    }

    #[test]
    fn the_servos_take_their_pins_unless_another_output_has_them() {
        let mut w = wiring();
        w.out = [SERVO_PIN, SERVO_PIN, SERVO_PIN, SERVO_PIN];
        w.pin = [29, 24, 21, 26];
        let got = plan(&w, &claimed());
        assert_eq!(got.pins, [Some(29), Some(24), None, Some(26)]);
        assert_eq!(got.refused, [None, None, Some(Refused::LaserSlice(21)), None], "GP21 is on the laser's slice 2");
        assert_eq!(got.pca, None);
        assert_eq!(refused_text(2, Refused::LaserSlice(21)).as_str(), "servo 3 on GP21 not driven: PWM slice 2 is the laser's");
        // The tool output's and the probe's pins are theirs, and a STOP
        // header's buffer drives its pin.
        w.pin = [17, 22, 29, 13];
        let got = plan(&w, &Claimed { tool: Some(17), probe: 22, ..claimed() });
        assert_eq!(got.pins, [None, None, Some(29), None]);
        assert_eq!(got.refused[0], Some(Refused::Tool(17)));
        assert_eq!(got.refused[1], Some(Refused::Probe(22)));
        assert_eq!(got.refused[3], Some(Refused::NotFree(13)));
        w.pin = [25, 4, 3, 16];
        assert_eq!(super::plan(&w, &claimed()).pins, [None; SERVOS]);
        // GP1 and GP17 drive the same channel, as do two servos on one pin;
        // the first one keeps it.
        w.pin = [1, 17, 22, 22];
        let got = plan(&w, &claimed());
        assert_eq!(got.pins, [Some(1), None, Some(22), None]);
        assert_eq!(got.refused[1], Some(Refused::Channel { pin: 17, servo: 0 }));
        assert_eq!(got.refused[3], Some(Refused::Channel { pin: 22, servo: 2 }));
        assert_eq!(refused_text(1, got.refused[1].unwrap()).as_str(), "servo 2 on GP17 not driven: the PWM channel of servo 1");
        // Two servos on the two channels of one slice both run.
        w.pin = [26, 27, 0, 0];
        w.out = [SERVO_PIN, SERVO_PIN, SERVO_NONE, SERVO_NONE];
        assert_eq!(super::plan(&w, &claimed()).pins, [Some(26), Some(27), None, None]);
    }

    #[test]
    fn the_pca9685_gets_its_bus_when_a_servo_is_on_it() {
        let mut w = wiring();
        w.out = [SERVO_PCA, SERVO_PIN, SERVO_NONE, SERVO_PCA];
        w.chan = [3, 0, 7, 15];
        let plan = plan(&w, &claimed());
        assert_eq!(plan.pins, [None, Some(29), None, None]);
        assert_eq!(
            plan.pca,
            Some(Pca { sda: 0, scl: 1, block: 0, addr: 0x40, channels: [Some(3), None, None, Some(15)] })
        );
        assert_eq!(plan.bus_refused, None);
        assert_eq!(pca_ready_text(&plan.pca.unwrap()).as_str(), "servo pca9685 0x40 on GP0 GP1 ready");
        // I2C1 on GP18 and GP23.
        w.sda = 18;
        w.scl = 23;
        assert_eq!(super::plan(&w, &claimed()).pca.map(|pca| pca.block), Some(1));
        // One block's data with the other's clock is no bus.
        w.scl = 1;
        let plan = super::plan(&w, &claimed());
        assert_eq!(plan.pca, None);
        assert_eq!(plan.bus_refused, Some(Refused::Blocks { sda: 18, scl: 1 }));
        assert_eq!(
            bus_refused_text(plan.bus_refused.unwrap()).as_str(),
            "servo pca9685 not started: GP18 and GP1 are not one I2C block's data and clock"
        );
        // A bus pin that is a servo's, the probe's or the laser's.
        w.sda = 0;
        w.pin[1] = 1;
        assert_eq!(super::plan(&w, &claimed()).bus_refused, Some(Refused::Servo { pin: 1, servo: 1 }));
        w.out[1] = SERVO_NONE;
        w.sda = 22;
        w.scl = 23;
        assert_eq!(super::plan(&w, &Claimed { probe: 22, ..claimed() }).bus_refused, Some(Refused::Probe(22)));
        w.sda = 24;
        w.scl = 25;
        assert_eq!(super::plan(&w, &claimed()).bus_refused, Some(Refused::NotFree(25)), "Z-STOP is a buffered input");
        w.sda = 20;
        w.scl = 21;
        assert_eq!(super::plan(&w, &claimed()).bus_refused, Some(Refused::LaserSlice(20)));
        // Without a servo on it, the bus is not started and its pins stay
        // free, whatever they are.
        w.out = [SERVO_PIN, SERVO_NONE, SERVO_NONE, SERVO_NONE];
        let plan = super::plan(&w, &claimed());
        assert_eq!((plan.pca, plan.bus_refused), (None, None));
    }

    #[test]
    fn the_pca9685_runs_at_fifty_hertz_in_4096_counts() {
        // Datasheet Equation 1: round(25 MHz / (4096 * 50)) - 1.
        assert_eq!(pca_prescale(50), 121);
        assert_eq!(pca_prescale(200), 30, "the datasheet's own example, 200 Hz");
        assert_eq!(pca_prescale(1526), 3);
        assert_eq!(pca_prescale(10_000), 3, "held to 3");
        assert_eq!(pca_prescale(1), 255, "held to a byte");
        // 4.88 us a count at 121.
        assert_eq!(pca_counts(1000, 121), 205);
        assert_eq!(pca_counts(1500, 121), 307);
        assert_eq!(pca_counts(2000, 121), 410);
        assert_eq!(pca_counts(30_000, 121), 4095);
        assert_eq!(pca_channel_write(0, Some(1500), 121), [0x06, 0, 0, 0x33, 0x01]);
        assert_eq!(pca_channel_write(15, Some(2000), 121), [0x42, 0, 0, 0x9A, 0x01]);
        assert_eq!(pca_channel_write(3, None, 121), [0x12, 0, 0, 0, 0x10], "fully off");
        // Set up asleep, so the rate takes, then woken with auto-increment
        // for the four bytes of a channel's write.
        let setup = pca_setup(121);
        assert_eq!(setup[0], [MODE1, MODE1_SLEEP]);
        assert_eq!(setup[1], [PRE_SCALE, 121]);
        assert_eq!(setup[5], [MODE1, MODE1_AI]);
        assert!(setup.iter().position(|w| w[0] == PRE_SCALE) < setup.iter().position(|w| w == &[MODE1, MODE1_AI]));
        assert!(pca_holds_setup(MODE1_AI));
        assert!(pca_holds_setup(0x80 | MODE1_AI), "the restart bit says nothing about the setup");
        assert!(!pca_holds_setup(0x11), "power-up: asleep, all-call, no auto-increment");
        assert!(!pca_holds_setup(MODE1_AI | MODE1_SLEEP));
        assert!(!pca_holds_setup(0));
    }
}
