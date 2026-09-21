//! SKR Pico pin assignment and the ports the core drives.
//!
//! Pins are configured once through embassy's GPIO and PWM drivers and
//! then left alone. The ports are zero-sized and write the SIO and PWM
//! registers directly, so the step interrupt and the main loop use the
//! same types without sharing any state but a few atomics.

use core::mem::forget;
use core::sync::atomic::{AtomicU32, Ordering};

use embassy_rp::clocks::clk_sys_freq;
use embassy_rp::gpio::{Level, Output};
use embassy_rp::pac::{PWM, SIO};
use embassy_rp::peripherals::{PIN_10, PIN_11, PIN_12, PIN_29, PIN_5, PIN_6, PIN_7, PWM_SLICE6};
use embassy_rp::pwm::{Config as PwmConfig, Pwm};
use embassy_rp::Peri;
use spinny_core::hal::{LaserPort, StepPort};
use spinny_core::settings::Settings;
use spinny_fw_logic::laser::{compare, pwm_params};
use spinny_fw_logic::pins::{level_masks, mask_of};
use spinny_fw_logic::step::pulse_cycles;

/// STEP pins: radius on the X driver, table on the Y driver.
pub const STEP_PINS: [u8; 2] = [11, 6];
pub const DIR_PINS: [u8; 2] = [10, 5];
/// Driver enable pins, active low on the TMC2209 sockets.
pub const EN_PINS: [u8; 2] = [12, 7];
/// Laser TTL output, GP29 on the SERVOS header: PWM slice 6 channel B.
pub const LASER_SLICE: usize = 6;

/// Settling time after a DIR change, well over the 20 ns the TMC2209 asks for.
const DIR_SETUP_CYCLES: u32 = 16;

static SYSCLK_HZ: AtomicU32 = AtomicU32::new(125_000_000);
/// Busy-wait after raising STEP; the main loop keeps it in step with `step_us`.
static PULSE_CYCLES: AtomicU32 = AtomicU32::new(250);
/// Wrap value of the laser PWM, set by `set_frequency`.
static LASER_TOP: AtomicU32 = AtomicU32::new(0);
/// Last duty asked for, reapplied when the frequency changes.
static LASER_DUTY: AtomicU32 = AtomicU32::new(0);

pub struct Pins {
    pub pwm6: Peri<'static, PWM_SLICE6>,
    pub laser: Peri<'static, PIN_29>,
    pub r_step: Peri<'static, PIN_11>,
    pub r_dir: Peri<'static, PIN_10>,
    pub r_en: Peri<'static, PIN_12>,
    pub a_step: Peri<'static, PIN_6>,
    pub a_dir: Peri<'static, PIN_5>,
    pub a_en: Peri<'static, PIN_7>,
}

/// Claims the pins in a safe order: the laser output driven low, the
/// drivers disabled, then step and direction low. The drivers are
/// forgotten on purpose so they never release the pins.
pub fn init(pins: Pins) -> (StepPins, LaserPwm) {
    SYSCLK_HZ.store(clk_sys_freq(), Ordering::Relaxed);
    let params = pwm_params(sysclk(), Settings::default().laser_hz);
    let mut cfg = PwmConfig::default();
    cfg.divider = params.div.into();
    cfg.top = params.top;
    cfg.compare_b = 0;
    cfg.enable = true;
    LASER_TOP.store(params.top as u32, Ordering::Relaxed);
    forget(Pwm::new_output_b(pins.pwm6, pins.laser, cfg));

    forget(Output::new(pins.r_en, Level::High));
    forget(Output::new(pins.a_en, Level::High));
    forget(Output::new(pins.r_step, Level::Low));
    forget(Output::new(pins.a_step, Level::Low));
    forget(Output::new(pins.r_dir, Level::Low));
    forget(Output::new(pins.a_dir, Level::Low));

    set_step_width(Settings::default().step_us);
    (StepPins, LaserPwm)
}

fn sysclk() -> u32 {
    SYSCLK_HZ.load(Ordering::Relaxed)
}

/// Step pulse width for the interrupt, from the `step_us` setting.
pub fn set_step_width(step_us: u32) {
    PULSE_CYCLES.store(pulse_cycles(sysclk(), step_us), Ordering::Relaxed);
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
        cortex_m::asm::delay(DIR_SETUP_CYCLES);
    }

    fn step(&mut self, mask: u8) {
        let bits = mask_of(mask, &STEP_PINS);
        if bits == 0 {
            return;
        }
        let out = SIO.gpio_out(0);
        out.value_set().write_value(bits);
        cortex_m::asm::delay(PULSE_CYCLES.load(Ordering::Relaxed));
        out.value_clr().write_value(bits);
    }

    fn set_enable(&mut self, high: bool) {
        let bits = mask_of(0b11, &EN_PINS);
        let out = SIO.gpio_out(0);
        if high {
            out.value_set().write_value(bits);
        } else {
            out.value_clr().write_value(bits);
        }
    }
}

/// The laser PWM compare and period, one register write each.
#[derive(Clone, Copy, Default)]
pub struct LaserPwm;

impl LaserPort for LaserPwm {
    fn set_duty(&mut self, permille: u16) {
        LASER_DUTY.store(permille as u32, Ordering::Relaxed);
        let top = LASER_TOP.load(Ordering::Relaxed) as u16;
        // A plain write, not a read-modify-write: channel A of the slice is unused.
        PWM.ch(LASER_SLICE).cc().write(|w| w.set_b(compare(top, permille)));
    }

    fn set_frequency(&mut self, hz: u32) {
        let params = pwm_params(sysclk(), hz);
        let ch = PWM.ch(LASER_SLICE);
        ch.div().write(|w| {
            w.set_int(params.div);
            w.set_frac(0);
        });
        ch.top().write(|w| w.set_top(params.top));
        LASER_TOP.store(params.top as u32, Ordering::Relaxed);
        let duty = LASER_DUTY.load(Ordering::Relaxed) as u16;
        ch.cc().write(|w| w.set_b(compare(params.top, duty)));
    }
}
