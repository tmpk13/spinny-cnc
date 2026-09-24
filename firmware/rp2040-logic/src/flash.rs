//! The settings blob in the last flash sector, over a minimal sector
//! interface so the load and save rules run on the host.

use spinny_core::settings::BLOB_LEN;

pub const FLASH_SIZE: usize = 2 * 1024 * 1024;
pub const SECTOR_SIZE: usize = 4096;
/// Offset of the settings sector from the start of flash.
pub const SETTINGS_OFFSET: u32 = (FLASH_SIZE - SECTOR_SIZE) as u32;

/// One erasable sector, always addressed from its start.
pub trait Sector {
    fn read(&mut self, buf: &mut [u8]) -> bool;
    fn erase(&mut self) -> bool;
    fn write(&mut self, data: &[u8]) -> bool;
}

/// An erased sector reads as all ones, so a blob with any other byte is
/// something that was written.
pub fn blob_present(buf: &[u8]) -> bool {
    buf.iter().any(|&b| b != 0xff)
}

/// Reads `BLOB_LEN` bytes (fewer if `buf` is smaller) and reports the
/// length when a blob is present.
pub fn load(sector: &mut impl Sector, buf: &mut [u8]) -> Option<usize> {
    let len = buf.len().min(BLOB_LEN);
    if len == 0 || !sector.read(&mut buf[..len]) {
        return None;
    }
    blob_present(&buf[..len]).then_some(len)
}

/// Erases the sector and writes the blob at its start.
pub fn save(sector: &mut impl Sector, blob: &[u8]) -> bool {
    !blob.is_empty() && blob.len() <= SECTOR_SIZE && sector.erase() && sector.write(blob)
}

/// Upper-case hex of `bytes` into `out`, two digits per byte, as far as
/// `out` reaches.
pub fn hex_upper(bytes: &[u8], out: &mut [u8]) {
    const DIGITS: &[u8; 16] = b"0123456789ABCDEF";
    for (pair, &b) in out.chunks_mut(2).zip(bytes) {
        pair[0] = DIGITS[(b >> 4) as usize];
        if let Some(low) = pair.get_mut(1) {
            *low = DIGITS[(b & 0xf) as usize];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct RamSector {
        data: [u8; SECTOR_SIZE],
        fail_erase: bool,
        erases: usize,
    }

    impl RamSector {
        fn blank() -> Self {
            RamSector {
                data: [0xff; SECTOR_SIZE],
                fail_erase: false,
                erases: 0,
            }
        }
    }

    impl Sector for RamSector {
        fn read(&mut self, buf: &mut [u8]) -> bool {
            buf.copy_from_slice(&self.data[..buf.len()]);
            true
        }

        fn erase(&mut self) -> bool {
            self.erases += 1;
            if self.fail_erase {
                return false;
            }
            self.data = [0xff; SECTOR_SIZE];
            true
        }

        fn write(&mut self, data: &[u8]) -> bool {
            for (slot, &b) in self.data.iter_mut().zip(data) {
                *slot &= b;
            }
            true
        }
    }

    #[test]
    fn blank_sector_loads_nothing() {
        let mut sector = RamSector::blank();
        let mut buf = [0u8; BLOB_LEN];
        assert_eq!(load(&mut sector, &mut buf), None);
    }

    #[test]
    fn save_then_load_round_trips() {
        let mut sector = RamSector::blank();
        let blob: Vec<u8> = (0..BLOB_LEN).map(|i| i as u8).collect();
        assert!(save(&mut sector, &blob));
        let mut buf = [0u8; BLOB_LEN];
        assert_eq!(load(&mut sector, &mut buf), Some(BLOB_LEN));
        assert_eq!(&buf[..], &blob[..]);
    }

    #[test]
    fn second_save_erases_first() {
        let mut sector = RamSector::blank();
        assert!(save(&mut sector, &[0x00; BLOB_LEN]));
        assert!(save(&mut sector, &[0x5a; BLOB_LEN]));
        assert_eq!(sector.erases, 2);
        let mut buf = [0u8; BLOB_LEN];
        assert_eq!(load(&mut sector, &mut buf), Some(BLOB_LEN));
        assert!(buf.iter().all(|&b| b == 0x5a));
    }

    #[test]
    fn load_is_capped_by_the_buffer() {
        let mut sector = RamSector::blank();
        assert!(save(&mut sector, &[0x11; BLOB_LEN]));
        let mut small = [0u8; 16];
        assert_eq!(load(&mut sector, &mut small), Some(16));
        let mut big = [0u8; BLOB_LEN + 50];
        assert_eq!(load(&mut sector, &mut big), Some(BLOB_LEN));
        assert_eq!(load(&mut sector, &mut []), None);
    }

    #[test]
    fn failures_and_bad_sizes_are_refused() {
        let mut sector = RamSector::blank();
        sector.fail_erase = true;
        assert!(!save(&mut sector, &[1; BLOB_LEN]));
        let mut sector = RamSector::blank();
        assert!(!save(&mut sector, &[]));
        assert!(!save(&mut sector, &[1; SECTOR_SIZE + 1]));
        assert_eq!(sector.erases, 0);
    }

    #[test]
    fn settings_sector_is_the_last_and_kept_out_of_the_image() {
        assert_eq!(SETTINGS_OFFSET as usize + SECTOR_SIZE, FLASH_SIZE);
        assert_eq!(SETTINGS_OFFSET % SECTOR_SIZE as u32, 0);
        // The firmware's linker script leaves the sector out of its FLASH region.
        let memory_x = include_str!("../../rp2040/memory.x");
        let flash = memory_x.lines().find(|line| line.trim_start().starts_with("FLASH")).unwrap();
        let reserved = format!("- {}K", SECTOR_SIZE / 1024);
        assert!(flash.contains("2048K") && flash.contains(&reserved), "{flash}");
    }

    #[test]
    fn hex_is_upper_case_and_bounded() {
        let mut out = [0u8; 16];
        hex_upper(&[0xde, 0xad, 0xbe, 0xef, 0x01, 0x23, 0x45, 0x67], &mut out);
        assert_eq!(&out, b"DEADBEEF01234567");
        let mut short = [b'.'; 3];
        hex_upper(&[0xab, 0xcd], &mut short);
        assert_eq!(&short, b"ABC");
    }
}
