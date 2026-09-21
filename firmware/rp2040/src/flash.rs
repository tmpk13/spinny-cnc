//! Settings storage in the last sector of the 2 MB flash, and the USB
//! serial number from the flash chip's unique id.

use embassy_rp::flash::{Blocking, Flash};
use embassy_rp::peripherals::FLASH;
use embassy_rp::Peri;
use spinny_core::hal::Store;
use spinny_fw_logic::flash::{self as sector, hex_upper, Sector, FLASH_SIZE, SECTOR_SIZE, SETTINGS_OFFSET};
use static_cell::StaticCell;

pub struct FlashStore {
    flash: Flash<'static, FLASH, Blocking, FLASH_SIZE>,
}

impl FlashStore {
    pub fn new(flash: Peri<'static, FLASH>) -> Self {
        FlashStore {
            flash: Flash::new_blocking(flash),
        }
    }

    /// The 64-bit unique id as 16 hex digits. Call once.
    pub fn serial_number(&mut self) -> &'static str {
        static SERIAL: StaticCell<[u8; 16]> = StaticCell::new();
        let mut uid = [0u8; 8];
        let _ = self.flash.blocking_unique_id(&mut uid);
        let buf = SERIAL.init([b'0'; 16]);
        hex_upper(&uid, buf);
        core::str::from_utf8(buf).unwrap_or("0000000000000000")
    }
}

impl Sector for FlashStore {
    fn read(&mut self, buf: &mut [u8]) -> bool {
        self.flash.blocking_read(SETTINGS_OFFSET, buf).is_ok()
    }

    /// Runs from RAM with interrupts off for the few tens of milliseconds
    /// an erase takes; the core only saves while idle.
    fn erase(&mut self) -> bool {
        self.flash
            .blocking_erase(SETTINGS_OFFSET, SETTINGS_OFFSET + SECTOR_SIZE as u32)
            .is_ok()
    }

    fn write(&mut self, data: &[u8]) -> bool {
        self.flash.blocking_write(SETTINGS_OFFSET, data).is_ok()
    }
}

impl Store for FlashStore {
    fn load(&mut self, buf: &mut [u8]) -> Option<usize> {
        sector::load(self, buf)
    }

    fn save(&mut self, blob: &[u8]) -> bool {
        sector::save(self, blob)
    }
}
