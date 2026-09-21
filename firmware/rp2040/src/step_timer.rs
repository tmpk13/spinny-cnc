//! The step interrupt: TIMER alarm 1 on TIMER_IRQ_1 at the highest
//! priority. Alarm 0 and TIMER_IRQ_0 belong to the embassy time driver.
//!
//! The interrupt is unarmed while the stepper has nothing queued. The main
//! loop pends it (`kick`) when the core reports new segments; each tick
//! then arms the alarm for the delay the core returns, counted from the
//! previous target so the schedule stays phase locked, until the ring
//! runs dry again.

use core::cell::RefCell;
use core::sync::atomic::{AtomicU32, Ordering};

use cortex_m::peripheral::NVIC;
use critical_section::Mutex;
use embassy_rp::interrupt::{self, InterruptExt, Priority};
use embassy_rp::pac::TIMER;
use spinny_core::stepper::Isr;
use spinny_fw_logic::step::{alarm_passed, alarm_target, next_target, RETRY_US};

use crate::board::{LaserPwm, StepPins};

const ALARM: usize = 1;

/// The interrupt half of the stepper. `Isr` is `Send` (its shared memory
/// is `Sync`, the queue consumer is `Send`), so the mutex alone makes the
/// static sound; only `TIMER_IRQ_1` touches it after `install`.
static ISR: Mutex<RefCell<Option<Isr<'static>>>> = Mutex::new(RefCell::new(None));

/// Target the alarm was last armed for; the next tick counts from it.
static TARGET: AtomicU32 = AtomicU32::new(0);

pub fn install(isr: Isr<'static>) {
    critical_section::with(|cs| *ISR.borrow_ref_mut(cs) = Some(isr));
}

/// Enables the alarm interrupt at the highest priority; the alarm itself
/// stays unarmed until the first kick.
pub fn start() {
    TIMER.inte().modify(|w| w.set_alarm(ALARM, true));
    interrupt::TIMER_IRQ_1.set_priority(Priority::P0);
    unsafe { interrupt::TIMER_IRQ_1.enable() };
}

/// Runs a tick right away; called when the ring goes from empty to filled.
pub fn kick() {
    NVIC::pend(interrupt::TIMER_IRQ_1);
}

/// Arms the alarm `us` after the previous target (a tick the alarm
/// started) or after now (a tick a kick started). A target already behind
/// the counter would not fire for 71 minutes, so it is moved a little
/// ahead unless the alarm did fire in the meantime.
fn arm(fired: bool, us: u32) {
    let now = TIMER.timerawl().read();
    let mut target = next_target(TARGET.load(Ordering::Relaxed), fired, now, us);
    loop {
        TIMER.alarm(ALARM).write_value(target);
        let now = TIMER.timerawl().read();
        let armed = TIMER.armed().read().armed() & (1 << ALARM) != 0;
        if !armed || !alarm_passed(target, now) {
            TARGET.store(target, Ordering::Relaxed);
            return;
        }
        target = alarm_target(now, RETRY_US);
    }
}

#[embassy_rp::interrupt]
unsafe fn TIMER_IRQ_1() {
    // The flag tells an alarm tick from a kick. Disarm before clearing it:
    // a kick that lands while the alarm is armed must not leave the stale
    // target to fire a second tick.
    let fired = TIMER.intr().read().alarm(ALARM);
    TIMER.armed().write(|w| w.set_armed(1 << ALARM));
    TIMER.intr().write(|w| w.set_alarm(ALARM, true));
    let next = critical_section::with(|cs| {
        ISR.borrow_ref_mut(cs)
            .as_mut()
            .and_then(|isr| isr.tick(&mut StepPins, &mut LaserPwm))
    });
    if let Some(us) = next {
        arm(fired, us);
    }
}
