//! SKR Pico firmware for the spinny laser. Placeholder entry until the
//! board support lands.
#![no_std]
#![no_main]

use embassy_executor::Spawner;
use embassy_time::Timer;
use panic_halt as _;

#[embassy_executor::main]
async fn main(_spawner: Spawner) {
    let _p = embassy_rp::init(Default::default());
    loop {
        Timer::after_millis(1000).await;
    }
}
