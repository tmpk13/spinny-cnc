//! TMC2209 register values and UART datagrams for the two drivers, and the
//! reply parsing behind the status report.
//!
//! The SKR Pico straps the X socket to UART address 0 and the Y socket to
//! address 2 and fits 110 mOhm sense resistors. Both drivers share one
//! wire, so every byte sent comes back on RX before any reply.

use core::fmt::Write;

use heapless::String;
use tmc2209::data::MicroStepResolution;
use tmc2209::reg::{self, Address};
use tmc2209::{ReadRequest, Reader, WriteRequest};

/// Sense resistor on the SKR Pico, milliohms.
pub const RSENSE_MOHM: u64 = 110;
/// UART address per axis: radius on the X socket, table on the Y socket.
pub const ADDR: [u8; 2] = [0, 2];
pub const AXIS_LETTER: [char; 2] = ['R', 'A'];
/// IHOLD_IRUN.IHOLDDELAY: power-down ramp in units of 2^18 clocks.
pub const IHOLD_DELAY: u8 = 10;
/// CHOPCONF chopper fields: the datasheet's reset values with TBL=2.
pub const TOFF: u32 = 3;
pub const HSTRT: u32 = 5;
pub const HEND: u32 = 0;
pub const TBL: u32 = 2;

/// Full-scale sense voltages, millivolts, for VSENSE=1 and VSENSE=0.
const VFS_HIGH_SENS_MV: u64 = 180;
const VFS_LOW_SENS_MV: u64 = 325;

/// What the drivers are configured with, copied from the settings.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DriverConfig {
    /// Run current per axis, mA; 0 leaves that driver untouched.
    pub ma: [u32; 2],
    pub hold_pct: u32,
    pub micro: [u32; 2],
    pub stealth: bool,
}

pub type Datagram = [u8; WriteRequest::LEN_BYTES];

/// `CS + 1` for an RMS current at one sense range, from
/// `I_rms = (CS + 1) / 32 * V_fs / (R_sense + 20 mOhm) / sqrt(2)`.
fn cs_plus_one(ma: u32, vfs_mv: u64) -> u64 {
    let r_eff = RSENSE_MOHM + 20;
    // mA * mOhm * 32 * sqrt(2) scaled by 10000, over mV * 1000 * 10000.
    let num = ma as u64 * r_eff * 32 * 14142;
    let denom = vfs_mv * 10_000_000;
    (num + denom / 2) / denom
}

/// Current scale for a current at a given sense range, clamped to 0..=31.
pub fn cs_for(ma: u32, vsense: bool) -> u8 {
    let vfs = if vsense { VFS_HIGH_SENS_MV } else { VFS_LOW_SENS_MV };
    cs_plus_one(ma, vfs).saturating_sub(1).min(31) as u8
}

/// Picks the high-sensitivity range when the current fits in it, for the
/// finer resolution, and returns the scale with it.
pub fn current_to_vsense_cs(ma: u32) -> (bool, u8) {
    if ma == 0 {
        return (true, 0);
    }
    let fine = cs_plus_one(ma, VFS_HIGH_SENS_MV);
    if (1..=32).contains(&fine) {
        (true, (fine - 1) as u8)
    } else {
        (false, cs_for(ma, false))
    }
}

/// CHOPCONF.MRES for a microstep count, None for anything but 1..=256 in
/// powers of two.
pub fn mres(micro: u32) -> Option<u8> {
    if micro.is_power_of_two() && micro <= 256 {
        Some((8 - micro.trailing_zeros()) as u8)
    } else {
        None
    }
}

pub fn hold_ma(ma: u32, hold_pct: u32) -> u32 {
    ma * hold_pct.min(100) / 100
}

fn datagram<R: reg::WritableRegister>(addr: u8, register: R) -> Datagram {
    let mut out = [0u8; WriteRequest::LEN_BYTES];
    out.copy_from_slice(WriteRequest::new(addr, register).bytes());
    out
}

/// The GCONF, IHOLD_IRUN and CHOPCONF writes for one axis, in that order.
/// None when the axis is to be left alone or its microstep count is bad.
pub fn config_datagrams(axis: usize, cfg: &DriverConfig) -> Option<[Datagram; 3]> {
    let ma = cfg.ma[axis];
    if ma == 0 {
        return None;
    }
    let mres = mres(cfg.micro[axis])?;
    let addr = ADDR[axis];
    let (vsense, irun) = current_to_vsense_cs(ma);
    let ihold = cs_for(hold_ma(ma, cfg.hold_pct), vsense);

    let mut gconf = reg::GCONF::default();
    gconf.set_i_scale_analog(false);
    gconf.set_en_spread_cycle(!cfg.stealth);
    gconf.set_pdn_disable(true);
    gconf.set_mstep_reg_select(true);
    gconf.set_multistep_filt(true);

    let mut currents = reg::IHOLD_IRUN::default();
    currents.set_ihold(ihold);
    currents.set_irun(irun);
    currents.set_ihold_delay(IHOLD_DELAY);

    let mut chop = reg::CHOPCONF::default();
    chop.set_toff(TOFF);
    chop.set_hstrt(HSTRT);
    chop.set_hend(HEND);
    chop.set_tbl(TBL);
    chop.set_vsense(vsense);
    chop.set_mres(MicroStepResolution::from_driver(mres as u32));
    chop.set_intpol(true);

    Some([datagram(addr, gconf), datagram(addr, currents), datagram(addr, chop)])
}

/// The 4-byte read request for one register.
pub fn read_request(addr: u8, register: Address) -> [u8; ReadRequest::LEN_BYTES] {
    let mut out = [0u8; ReadRequest::LEN_BYTES];
    out.copy_from_slice(ReadRequest::from_addr(addr, register).bytes());
    out
}

/// Finds the reply to a read of `register` in the bytes that came back on
/// the wire (the echoed request first, then the reply) and returns its
/// data when the CRC and the register match.
pub fn parse_reply(bytes: &[u8], register: Address) -> Option<u32> {
    let mut reader = Reader::default();
    let mut rest = bytes;
    while !rest.is_empty() {
        let (used, response) = reader.read_response(rest);
        if let Some(response) = response {
            if response.crc_is_valid() && response.reg_addr().ok() == Some(register) {
                return Some(response.data_u32());
            }
        }
        if used == 0 {
            return None;
        }
        rest = &rest[used..];
    }
    None
}

/// Body of the `[MSG:...]` line for one axis.
pub fn report_text(axis: usize, reply: Option<(u8, u32)>) -> String<48> {
    let mut text = String::new();
    let letter = AXIS_LETTER[axis];
    let addr = ADDR[axis];
    let _ = match reply {
        Some((ifcnt, status)) => write!(text, "tmc {letter} addr{addr} ifcnt={ifcnt} status=0x{status:08x}"),
        None => write!(text, "tmc {letter} addr{addr} no reply"),
    };
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use tmc2209::reg::{CHOPCONF, GCONF, IHOLD_IRUN};

    fn data(datagram: &Datagram) -> u32 {
        u32::from_be_bytes([datagram[3], datagram[4], datagram[5], datagram[6]])
    }

    fn reply(register: Address, value: u32) -> [u8; 8] {
        let mut bytes = [0x05, 0xff, register as u8, 0, 0, 0, 0, 0];
        bytes[3..7].copy_from_slice(&value.to_be_bytes());
        bytes[7] = tmc2209::crc(&bytes[..7]);
        bytes
    }

    #[test]
    fn current_scale_matches_the_datasheet_formula() {
        // 800 mA fits the 180 mV range: CS + 1 = 800 * 130 * 32 * 1.4142 / 180000 = 26.2.
        assert_eq!(current_to_vsense_cs(800), (true, 25));
        // 1500 mA needs the 325 mV range: CS + 1 = 27.1.
        assert_eq!(current_to_vsense_cs(1500), (false, 26));
        assert_eq!(current_to_vsense_cs(0), (true, 0));
        assert_eq!(current_to_vsense_cs(5000), (false, 31));
        // Hold current at the run current's range.
        assert_eq!(cs_for(400, true), 12);
        assert_eq!(cs_for(750, false), 13);
    }

    #[test]
    fn microsteps_map_to_mres() {
        assert_eq!(mres(256), Some(0));
        assert_eq!(mres(16), Some(4));
        assert_eq!(mres(1), Some(8));
        assert_eq!(mres(0), None);
        assert_eq!(mres(12), None);
        assert_eq!(mres(512), None);
        assert_eq!(hold_ma(800, 50), 400);
        assert_eq!(hold_ma(800, 150), 800);
    }

    #[test]
    fn datagrams_carry_the_register_fields() {
        let cfg = DriverConfig {
            ma: [800, 1500],
            hold_pct: 50,
            micro: [16, 32],
            stealth: true,
        };
        let [gconf, currents, chop] = config_datagrams(0, &cfg).unwrap();
        for d in [&gconf, &currents, &chop] {
            assert_eq!(d[0], 0x05);
            assert_eq!(d[1], 0);
            assert_eq!(d[2] & 0x80, 0x80);
            assert_eq!(d[7], tmc2209::crc(&d[..7]));
        }
        assert_eq!(gconf[2] & 0x7f, Address::GCONF as u8);
        assert_eq!(currents[2] & 0x7f, Address::IHOLD_IRUN as u8);
        assert_eq!(chop[2] & 0x7f, Address::CHOPCONF as u8);

        let g = GCONF::from(data(&gconf));
        assert!(!g.i_scale_analog());
        assert!(!g.en_spread_cycle());
        assert!(g.pdn_disable());
        assert!(g.mstep_reg_select());
        assert!(g.multistep_filt());

        let c = IHOLD_IRUN::from(data(&currents));
        assert_eq!(c.irun(), 25);
        assert_eq!(c.ihold(), 12);
        assert_eq!(c.ihold_delay(), IHOLD_DELAY);

        let ch = CHOPCONF::from(data(&chop));
        assert_eq!(ch.toff(), TOFF);
        assert_eq!(ch.hstrt(), HSTRT);
        assert_eq!(ch.hend(), HEND);
        assert_eq!(ch.tbl(), TBL);
        assert!(ch.vsense());
        assert_eq!(ch.mres().number_of_microsteps(), 16);
        assert!(ch.intpol());

        let [gconf, currents, chop] = config_datagrams(1, &cfg).unwrap();
        assert_eq!(gconf[1], 2);
        let c = IHOLD_IRUN::from(data(&currents));
        assert_eq!(c.irun(), 26);
        let ch = CHOPCONF::from(data(&chop));
        assert!(!ch.vsense());
        assert_eq!(ch.mres().number_of_microsteps(), 32);
    }

    #[test]
    fn spread_cycle_and_untouched_axes() {
        let cfg = DriverConfig {
            ma: [0, 600],
            hold_pct: 30,
            micro: [16, 12],
            stealth: false,
        };
        assert!(config_datagrams(0, &cfg).is_none());
        assert!(config_datagrams(1, &cfg).is_none());
        let cfg = DriverConfig { micro: [16, 16], ..cfg };
        let [gconf, ..] = config_datagrams(1, &cfg).unwrap();
        assert!(GCONF::from(data(&gconf)).en_spread_cycle());
    }

    #[test]
    fn read_request_is_addressed_and_checked() {
        let req = read_request(2, Address::DRV_STATUS);
        assert_eq!(&req[..3], &[0x05, 2, 0x6f]);
        assert_eq!(req[3], tmc2209::crc(&req[..3]));
    }

    #[test]
    fn reply_is_found_behind_the_echo() {
        let mut wire = Vec::new();
        wire.extend_from_slice(&read_request(0, Address::IFCNT));
        wire.extend_from_slice(&reply(Address::IFCNT, 7));
        assert_eq!(parse_reply(&wire, Address::IFCNT), Some(7));
        assert_eq!(parse_reply(&wire, Address::DRV_STATUS), None);
        assert_eq!(parse_reply(&wire[..4], Address::IFCNT), None);
        assert_eq!(parse_reply(&[], Address::IFCNT), None);
    }

    #[test]
    fn echo_ending_in_a_sync_byte_does_not_confuse_the_reader() {
        // A request whose CRC byte happens to be the sync value.
        let mut wire = vec![0x05, 0x00, 0x02, 0x05];
        wire.extend_from_slice(&reply(Address::IFCNT, 0x12));
        assert_eq!(parse_reply(&wire, Address::IFCNT), Some(0x12));
    }

    #[test]
    fn bad_crc_is_rejected() {
        let mut bytes = reply(Address::DRV_STATUS, 0x8000_0000);
        bytes[7] ^= 1;
        assert_eq!(parse_reply(&bytes, Address::DRV_STATUS), None);
        let mut noise = vec![0x00, 0xff, 0x05];
        noise.extend_from_slice(&reply(Address::DRV_STATUS, 0x8000_0000));
        assert_eq!(parse_reply(&noise, Address::DRV_STATUS), Some(0x8000_0000));
    }

    #[test]
    fn report_lines() {
        assert_eq!(report_text(0, Some((3, 0x8000_0000))).as_str(), "tmc R addr0 ifcnt=3 status=0x80000000");
        assert_eq!(report_text(1, None).as_str(), "tmc A addr2 no reply");
        assert_eq!(report_text(1, Some((255, 0xffff_ffff))).as_str(), "tmc A addr2 ifcnt=255 status=0xffffffff");
    }
}
