//! The step interrupt: TIMER alarm 1 on TIMER_IRQ_1 at the highest
//! priority. Alarm 0 and TIMER_IRQ_0 belong to the embassy time driver.
//!
//! The interrupt is unarmed while the stepper has nothing queued. The main
//! loop pends it (`kick`) when the core reports new segments; each tick
//! then arms the alarm for the delay the core returns until the ring runs
//! dry again.

use core::cell::RefCell;

use cortex_m::peripheral::NVIC;
use critical_section::Mutex;
use embassy_rp::interrupt::{self, InterruptExt, Priority};
use embassy_rp::pac::TIMER;
use spinny_core::stepper::Isr;
use spinny_fw_logic::step::{alarm_passed, alarm_target, RETRY_US};

use crate::board::{LaserPwm, StepPins};

const ALARM: usize = 1;

/// The interrupt half of the stepper. Only `TIMER_IRQ_1` reaches it after
/// `install`, so keeping it in a static is sound whatever the auto traits
/// of the core's types say.
struct IsrSlot(Isr<'static>);

unsafe impl Send for IsrSlot {}

static ISR: Mutex<RefCell<Option<IsrSlot>>> = Mutex::new(RefCell::new(None));

pub fn install(isr: Isr<'static>) {
    critical_section::with(|cs| *ISR.borrow_ref_mut(cs) = Some(IsrSlot(isr)));
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

/// Arms the alarm `us` from now. A target that is already behind the
/// counter would not fire for 71 minutes, so it is moved a little ahead
/// unless the alarm did fire in the meantime.
fn arm(us: u32) {
    let mut target = alarm_target(TIMER.timerawl().read(), us);
    loop {
        TIMER.alarm(ALARM).write_value(target);
        let now = TIMER.timerawl().read();
        let armed = TIMER.armed().read().armed() & (1 << ALARM) != 0;
        if !armed || !alarm_passed(target, now) {
            return;
        }
        target = alarm_target(now, RETRY_US);
    }
}

#[embassy_rp::interrupt]
unsafe fn TIMER_IRQ_1() {
    // A kick may arrive while the alarm is armed: disarm so the stale
    // target cannot fire a second tick, then clear the flag.
    TIMER.armed().write(|w| w.set_armed(1 << ALARM));
    TIMER.intr().write(|w| w.set_alarm(ALARM, true));
    let next = critical_section::with(|cs| {
        ISR.borrow_ref_mut(cs)
            .as_mut()
            .and_then(|slot| slot.0.tick(&mut StepPins, &mut LaserPwm))
    });
    if let Some(us) = next {
        arm(us);
    }
}
