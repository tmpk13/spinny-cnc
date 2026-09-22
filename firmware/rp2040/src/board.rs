//! SKR Pico pin assignment and the ports the core drives.
//!
//! Pins are configured once through embassy's GPIO and PWM drivers and
//! then left alone. The ports are zero-sized and write the SIO and PWM
//! registers directly, so the step interrupt and the main loop use the
//! same types without sharing any state but a few atomics.

use core::mem::forget;
use core::sync::atomic::{AtomicU32, Ordering};

use embassy_rp::clocks::clk_sys_freq;
use embassy_rp::gpio::{Level, Output, Pin};
use embassy_rp::pac::{PWM, SIO};
use embassy_rp::peripherals::{
    PIN_10, PIN_11, PIN_12, PIN_19, PIN_2, PIN_20, PIN_28, PIN_5, PIN_6, PIN_7, PWM_SLICE2,
};
use embassy_rp::pwm::{Config as PwmConfig, Pwm};
use embassy_rp::Peri;
use spinny_core::hal::{LaserPort, SlidePort, StepPort};
use spinny_core::settings::Settings;
use spinny_fw_logic::laser::{compare, compare_before_top, pwm_is_channel_a, pwm_params, pwm_slice};
use spinny_fw_logic::pins::{level_masks, mask_of};
use spinny_fw_logic::step::pulse_loops;

/// STEP pins: radius on the X driver, table on the Y driver.
pub const STEP_PINS: [u8; 2] = [11, 6];
pub const DIR_PINS: [u8; 2] = [10, 5];
/// The cross slide on the Z driver socket. It is a single axis, so its
/// pins are one-element tables for the same SIO mask helpers.
pub const Z_STEP_PINS: [u8; 1] = [19];
pub const Z_DIR_PINS: [u8; 1] = [28];
/// Driver enable pins, active low on the TMC2209 sockets: radius, table,
/// cross slide. They are driven together, so a move energizes all three.
pub const EN_PINS: [u8; 3] = [12, 7, 2];
/// Every axis selected in an enable write.
const EN_ALL: u8 = 0b111;
/// Laser output, GP20 on the FAN3 header: PWM slice 2 channel A. The
/// slice and channel follow from the pin, `(gpio / 2) % 8` and even for A.
pub const LASER_PIN: u8 = 20;
pub const LASER_SLICE: usize = pwm_slice(LASER_PIN);
// The channel follows from the pin, and the code below writes channel A.
const _: () = assert!(pwm_is_channel_a(LASER_PIN));

/// Busy-wait iterations after a DIR change: about 50 cycles, well over
/// the 20 ns the TMC2209 asks for.
const DIR_SETUP_LOOPS: u32 = 16;

static SYSCLK_HZ: AtomicU32 = AtomicU32::new(125_000_000);
/// Busy-wait iterations after raising STEP; the main loop keeps it in
/// step with `step_us`.
static PULSE_LOOPS: AtomicU32 = AtomicU32::new(125);
/// Wrap value of the laser PWM, set by `set_frequency`.
static LASER_TOP: AtomicU32 = AtomicU32::new(0);
/// Last duty asked for, reapplied when the frequency changes.
static LASER_DUTY: AtomicU32 = AtomicU32::new(0);

pub struct Pins {
    pub pwm: Peri<'static, PWM_SLICE2>,
    pub laser: Peri<'static, PIN_20>,
    pub r_step: Peri<'static, PIN_11>,
    pub r_dir: Peri<'static, PIN_10>,
    pub r_en: Peri<'static, PIN_12>,
    pub a_step: Peri<'static, PIN_6>,
    pub a_dir: Peri<'static, PIN_5>,
    pub a_en: Peri<'static, PIN_7>,
    pub z_step: Peri<'static, PIN_19>,
    pub z_dir: Peri<'static, PIN_28>,
    pub z_en: Peri<'static, PIN_2>,
}

/// Claims the pins in a safe order: the laser output driven low, the
/// drivers disabled, then step and direction low. The drivers are
/// forgotten on purpose so they never release the pins.
pub fn init(pins: Pins) -> (StepPins, LaserPwm, SlidePins) {
    SYSCLK_HZ.store(clk_sys_freq(), Ordering::Relaxed);
    let params = pwm_params(sysclk(), Settings::default().laser_hz);
    let mut cfg = PwmConfig::default();
    cfg.divider = params.div.into();
    cfg.top = params.top;
    cfg.compare_a = 0;
    cfg.enable = true;
    LASER_TOP.store(params.top as u32, Ordering::Relaxed);
    forget(Pwm::new_output_a(pins.pwm, pins.laser, cfg));

    let step = [pins.r_step.pin(), pins.a_step.pin()];
    let dir = [pins.r_dir.pin(), pins.a_dir.pin()];
    let en = [pins.r_en.pin(), pins.a_en.pin(), pins.z_en.pin()];
    let z_step = [pins.z_step.pin()];
    let z_dir = [pins.z_dir.pin()];
    forget(Output::new(pins.r_en, Level::High));
    forget(Output::new(pins.a_en, Level::High));
    forget(Output::new(pins.z_en, Level::High));
    forget(Output::new(pins.r_step, Level::Low));
    forget(Output::new(pins.a_step, Level::Low));
    forget(Output::new(pins.z_step, Level::Low));
    forget(Output::new(pins.r_dir, Level::Low));
    forget(Output::new(pins.a_dir, Level::Low));
    forget(Output::new(pins.z_dir, Level::Low));
    // The SIO masks come from the tables above, which must name the pins
    // the outputs were just made on. Checked with every line at its safe
    // level, so a halt here leaves the drivers off and the laser low.
    assert!(step == STEP_PINS && dir == DIR_PINS && en == EN_PINS);
    assert!(z_step == Z_STEP_PINS && z_dir == Z_DIR_PINS);

    set_step_width(Settings::default().step_us);
    (StepPins, LaserPwm, SlidePins)
}

fn sysclk() -> u32 {
    SYSCLK_HZ.load(Ordering::Relaxed)
}

/// Step pulse width for the interrupt, from the `step_us` setting.
pub fn set_step_width(step_us: u32) {
    PULSE_LOOPS.store(pulse_loops(sysclk(), step_us), Ordering::Relaxed);
}

/// Step, direction and enable lines through the SIO set/clear registers.
#[derive(Clone, Copy, Default)]
pub struct StepPins;

impl StepPort for StepPins {
    fn set_dir(&mut self, levels: u8) {
        let (set, clr) = level_masks(levels, &DIR_PINS);
        let out = SIO.gpio_out(0);
        out.value_set().write_value(set);
        out.value_clr().write_value(clr);
        cortex_m::asm::delay(DIR_SETUP_LOOPS);
    }

    fn step(&mut self, mask: u8) {
        let bits = mask_of(mask, &STEP_PINS);
        if bits == 0 {
            return;
        }
        let out = SIO.gpio_out(0);
        out.value_set().write_value(bits);
        cortex_m::asm::delay(PULSE_LOOPS.load(Ordering::Relaxed));
        out.value_clr().write_value(bits);
    }

    fn set_enable(&mut self, high: bool) {
        let bits = mask_of(EN_ALL, &EN_PINS);
        let out = SIO.gpio_out(0);
        if high {
            out.value_set().write_value(bits);
        } else {
            out.value_clr().write_value(bits);
        }
    }
}

/// The cross slide's step and direction lines, through the same SIO
/// registers. Its enable is `StepPins::set_enable`, which drives every
/// driver socket together.
#[derive(Clone, Copy, Default)]
pub struct SlidePins;

impl SlidePort for SlidePins {
    fn set_dir(&mut self, high: bool) {
        let (set, clr) = level_masks(high as u8, &Z_DIR_PINS);
        let out = SIO.gpio_out(0);
        out.value_set().write_value(set);
        out.value_clr().write_value(clr);
        cortex_m::asm::delay(DIR_SETUP_LOOPS);
    }

    fn step(&mut self) {
        let bits = mask_of(1, &Z_STEP_PINS);
        let out = SIO.gpio_out(0);
        out.value_set().write_value(bits);
        cortex_m::asm::delay(PULSE_LOOPS.load(Ordering::Relaxed));
        out.value_clr().write_value(bits);
    }
}

/// The laser PWM compare and period, one register write each.
#[derive(Clone, Copy, Default)]
pub struct LaserPwm;

impl LaserPort for LaserPwm {
    fn set_duty(&mut self, permille: u16) {
        LASER_DUTY.store(permille as u32, Ordering::Relaxed);
        let top = LASER_TOP.load(Ordering::Relaxed) as u16;
        // A plain write, not a read-modify-write: channel B of the slice
        // is GP21, which this firmware never puts in its PWM function.
        PWM.ch(LASER_SLICE).cc().write(|w| w.set_a(compare(top, permille)));
    }

    /// Reprograms the slice in one go. The interrupt's `set_duty` computes
    /// its compare from the wrap value published here, so the block keeps
    /// it from running between the register writes and the store.
    fn set_frequency(&mut self, hz: u32) {
        let params = pwm_params(sysclk(), hz);
        critical_section::with(|_| {
            let ch = PWM.ch(LASER_SLICE);
            let old_top = LASER_TOP.load(Ordering::Relaxed) as u16;
            let cc = compare(params.top, LASER_DUTY.load(Ordering::Relaxed) as u16);
            ch.div().write(|w| {
                w.set_int(params.div);
                w.set_frac(0);
            });
            // Between the two writes the slice runs on one old and one
            // new value; this order never leaves a compare above the wrap,
            // which would hold the output high.
            if compare_before_top(old_top, params.top) {
                ch.cc().write(|w| w.set_a(cc));
                ch.top().write(|w| w.set_top(params.top));
            } else {
                ch.top().write(|w| w.set_top(params.top));
                ch.cc().write(|w| w.set_a(cc));
            }
            // A counter past a shorter wrap would run on to 0xFFFF first.
            ch.ctr().write(|w| w.set_ctr(0));
            LASER_TOP.store(params.top as u32, Ordering::Relaxed);
        });
    }
}
