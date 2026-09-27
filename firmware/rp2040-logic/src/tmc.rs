//! TMC2209 register values and UART datagrams for the four drivers, the
//! reply parsing behind the status report, and which drivers hold their
//! configuration.
//!
//! The SKR Pico straps the X socket to UART address 0, the Y socket to
//! address 2, the Z socket to address 1 and the E socket to address 3,
//! and fits 110 mOhm sense resistors. Every driver shares one wire, so every byte sent comes back
//! on RX before any reply.
//!
//! The same MS1 and MS2 straps pick the microstep resolution while GCONF
//! leaves it to them, which is where a driver is after power-up: 8 on
//! address 0, 32 on 1, 64 on 2 and 16 on 3. The drivers run from the motor
//! supply, so switching that off and on puts every one of them back there.

use core::fmt::Write;

use heapless::String;
use tmc2209::data::MicroStepResolution;
use tmc2209::reg::{self, Address};
use tmc2209::{ReadRequest, Reader, WriteRequest};

/// Sense resistor on the SKR Pico, milliohms.
pub const RSENSE_MOHM: u64 = 110;
/// Driver sockets in use.
pub const DRIVERS: usize = 4;
/// UART address per axis: radius on the X socket, table on the Y socket,
/// cross slide on the Z socket, focus axis on the E socket.
pub const ADDR: [u8; DRIVERS] = [0, 2, 1, 3];
pub const AXIS_LETTER: [char; DRIVERS] = ['R', 'A', 'Z', 'H'];
/// IHOLD_IRUN.IHOLDDELAY: power-down ramp in units of 2^18 clocks.
pub const IHOLD_DELAY: u8 = 10;
/// CHOPCONF chopper fields: the datasheet's reset values with TBL=2.
pub const TOFF: u32 = 3;
pub const HSTRT: u32 = 5;
pub const HEND: u32 = 0;
pub const TBL: u32 = 2;

/// GSTAT flags. `reset`: the driver came up from power-on since the flags
/// were last cleared, with every register back at its reset value.
/// `drv_err`: it shut down for overtemperature or a short. `uv_cp`: its
/// charge pump is under voltage, which disables it; this one is not
/// latched. The flags are cleared by writing ones to them.
pub const GSTAT_RESET: u32 = 1 << 0;
pub const GSTAT_DRV_ERR: u32 = 1 << 1;
pub const GSTAT_UV_CP: u32 = 1 << 2;

/// Full-scale sense voltages, millivolts, for VSENSE=1 and VSENSE=0.
const VFS_HIGH_SENS_MV: u64 = 180;
const VFS_LOW_SENS_MV: u64 = 325;

/// What the drivers are configured with, copied from the settings.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DriverConfig {
    /// Run current per axis, mA; 0 leaves that driver untouched.
    pub ma: [u32; DRIVERS],
    pub hold_pct: u32,
    pub micro: [u32; DRIVERS],
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

/// The writes for one axis: the GSTAT flags cleared, then GCONF,
/// IHOLD_IRUN and CHOPCONF. The reset flag is set at every power-up, the
/// first included, so it tells a driver that lost its configuration only
/// once this has cleared it; clearing it first leaves a reset that lands
/// while the rest is written on show. None when the axis is to be left
/// alone or its microstep count is bad.
pub fn config_datagrams(axis: usize, cfg: &DriverConfig) -> Option<[Datagram; 4]> {
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

    let clear = reg::GSTAT::from(GSTAT_RESET | GSTAT_DRV_ERR | GSTAT_UV_CP);
    Some([datagram(addr, clear), datagram(addr, gconf), datagram(addr, currents), datagram(addr, chop)])
}

/// Whether a GSTAT read says the driver still holds what it was written:
/// it answered, has not come up from power-on since its flags were
/// cleared, and its charge pump is up. `None` is no reply, which is a
/// driver without its motor supply. A driver error is left to `$tmc`: it
/// costs neither the configuration nor the supply.
pub fn holds_config(gstat: Option<u32>) -> bool {
    matches!(gstat, Some(flags) if flags & (GSTAT_RESET | GSTAT_UV_CP) == 0)
}

/// Where one driver stands with the configuration the driver task holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Link {
    /// Left alone: no current asked for, or a microstep count it cannot take.
    Unused,
    /// To be written: not yet tried, refused, or lost with its supply.
    Pending,
    /// Took it, and has kept it at every poll since.
    Held,
    /// Held the configuration before the newest one, and is to be polled
    /// once more before that is written over it: the write clears the
    /// reset flag a supply cycle since the last poll left behind.
    Superseded,
}

/// The driver task's view of every driver. A configuration makes each
/// driver it covers pending, or superseded where it was held; a write that
/// lands makes it held; a poll of a held or superseded driver that finds
/// it reset, unpowered or silent makes it pending and says so once, which
/// is the moment its motor lost its holding torque and its resolution went
/// back to the straps. A superseded driver the poll finds intact is
/// pending as well, without a word.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Links([Link; DRIVERS]);

impl Default for Links {
    fn default() -> Self {
        Self::new()
    }
}

impl Links {
    pub const fn new() -> Self {
        Self([Link::Unused; DRIVERS])
    }

    pub fn get(&self, axis: usize) -> Link {
        self.0[axis]
    }

    /// A new configuration: every driver it covers is to be written, after
    /// a poll for the ones that held the last one.
    pub fn configure(&mut self, cfg: &DriverConfig) {
        for (axis, link) in self.0.iter_mut().enumerate() {
            *link = match (config_datagrams(axis, cfg).is_some(), *link) {
                (false, _) => Link::Unused,
                (true, Link::Held | Link::Superseded) => Link::Superseded,
                (true, _) => Link::Pending,
            };
        }
    }

    /// A driver the next poll is to read: it holds its configuration, or
    /// held the one before and has not been checked since.
    pub fn watched(&self, axis: usize) -> bool {
        matches!(self.0[axis], Link::Held | Link::Superseded)
    }

    /// A write of a pending driver: `took` when it counted every datagram
    /// and its flags read back clear afterwards.
    pub fn written(&mut self, axis: usize, took: bool) {
        if took && self.0[axis] == Link::Pending {
            self.0[axis] = Link::Held;
        }
    }

    /// A poll of a watched driver with what its GSTAT read gave. True when
    /// it has just lost its configuration; later polls of it, until it is
    /// written again, say nothing more. A superseded driver is pending
    /// afterwards either way, for the newest configuration.
    pub fn polled(&mut self, axis: usize, gstat: Option<u32>) -> bool {
        let lost = self.watched(axis) && !holds_config(gstat);
        if lost || self.0[axis] == Link::Superseded {
            self.0[axis] = Link::Pending;
        }
        lost
    }

    /// No driver is waiting to be checked or written.
    pub fn settled(&self) -> bool {
        self.0.iter().all(|link| matches!(link, Link::Unused | Link::Held))
    }
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

/// Body of the `[MSG:...]` line for an axis whose driver did not take its
/// configuration.
pub fn refused_text(axis: usize) -> String<64> {
    let mut text = String::new();
    let letter = AXIS_LETTER[axis];
    let addr = ADDR[axis];
    let _ = write!(text, "tmc {letter} addr{addr} refused config, retrying");
    text
}

/// Body of the `[MSG:...]` line for an axis whose driver lost the
/// configuration it held: it stopped answering, or answered reset.
pub fn lost_text(axis: usize) -> String<64> {
    let mut text = String::new();
    let letter = AXIS_LETTER[axis];
    let addr = ADDR[axis];
    let _ = write!(text, "tmc {letter} addr{addr} lost motor power, position may be off");
    text
}

/// What a driver answered when asked about itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Reply {
    /// Write datagrams the driver has accepted since it powered up.
    pub ifcnt: u8,
    /// Microsteps it actually steps at, from `micro_of`.
    pub micro: u16,
    pub status: u32,
}

/// Microsteps a driver steps at: CHOPCONF's MRES once GCONF selects the
/// register, the MS1 and MS2 pins (read from IOIN) otherwise. MRES reads
/// 256 at power-up, so a driver on its straps would report 256 from
/// CHOPCONF alone.
pub fn micro_of(gconf: u32, chopconf: u32, ioin: u32) -> u16 {
    if reg::GCONF::from(gconf).mstep_reg_select() {
        return reg::CHOPCONF::from(chopconf).mres().number_of_microsteps() as u16;
    }
    let pins = reg::IOIN::from(ioin);
    match (pins.ms2(), pins.ms1()) {
        (false, false) => 8,
        (false, true) => 32,
        (true, false) => 64,
        (true, true) => 16,
    }
}

/// Body of the `[MSG:...]` line for one axis. The microstep count is the
/// one the driver reports, not the one it was asked for: a driver that
/// never took its configuration answers with whatever MS1 and MS2 strap
/// it to, and that is the difference between a move and a stall. A driver
/// the configuration leaves alone (`in_use` false, the focus driver
/// without `h_axis`) is still asked, and marked unused, so an empty socket
/// or a strapped one is not taken for a fault.
pub fn report_text(axis: usize, reply: Option<Reply>, in_use: bool) -> String<64> {
    let mut text = String::new();
    let letter = AXIS_LETTER[axis];
    let addr = ADDR[axis];
    let unused = if in_use { "" } else { "unused, " };
    let _ = match reply {
        Some(reply) => write!(
            text,
            "tmc {letter} addr{addr} {unused}ifcnt={} micro={} status=0x{:08x}",
            reply.ifcnt, reply.micro, reply.status
        ),
        None if in_use => write!(text, "tmc {letter} addr{addr} no reply, is motor power on"),
        None => write!(text, "tmc {letter} addr{addr} unused, no reply"),
    };
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use tmc2209::reg::{CHOPCONF, GCONF, GSTAT, IHOLD_IRUN, IOIN};

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
            ma: [800, 1500, 600, 400],
            hold_pct: 50,
            micro: [16, 32, 128, 8],
            stealth: true,
        };
        let [clear, gconf, currents, chop] = config_datagrams(0, &cfg).unwrap();
        for d in [&clear, &gconf, &currents, &chop] {
            assert_eq!(d[0], 0x05);
            assert_eq!(d[1], 0);
            assert_eq!(d[2] & 0x80, 0x80);
            assert_eq!(d[7], tmc2209::crc(&d[..7]));
        }
        assert_eq!(clear[2] & 0x7f, Address::GSTAT as u8);
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

        let [_, gconf, currents, chop] = config_datagrams(1, &cfg).unwrap();
        assert_eq!(gconf[1], 2);
        let c = IHOLD_IRUN::from(data(&currents));
        assert_eq!(c.irun(), 26);
        let ch = CHOPCONF::from(data(&chop));
        assert!(!ch.vsense());
        assert_eq!(ch.mres().number_of_microsteps(), 32);

        // The cross slide is the Z socket, which straps to address 1.
        let [_, gconf, _, chop] = config_datagrams(2, &cfg).unwrap();
        assert_eq!(gconf[1], 1);
        assert_eq!(CHOPCONF::from(data(&chop)).mres().number_of_microsteps(), 128);
    }

    #[test]
    fn fields_the_configuration_never_sets_stay_off() {
        // These decide whether a step is one edge or two, whether the
        // sense resistors are the board's, and whether the short
        // protection runs. None is ours to set, and all of them ride on
        // the register defaults, so a change of those must fail here
        // rather than on the machine.
        let cfg = DriverConfig { ma: [800; DRIVERS], hold_pct: 50, micro: [256; DRIVERS], stealth: true };
        let [_, gconf, _, chop] = config_datagrams(0, &cfg).unwrap();
        let g = GCONF::from(data(&gconf));
        assert!(!g.internal_rsense(), "the driver would ignore the sense resistors");
        assert!(!g.shaft());
        assert!(!g.test_mode());
        let ch = CHOPCONF::from(data(&chop));
        assert!(!ch.dedge(), "both edges would step, doubling every move");
        assert!(!ch.diss2g());
        assert!(!ch.diss2vs());
        assert_eq!(ch.mres().number_of_microsteps(), 256);
    }

    #[test]
    fn a_refused_axis_says_which_one() {
        assert_eq!(refused_text(0).as_str(), "tmc R addr0 refused config, retrying");
        assert_eq!(refused_text(1).as_str(), "tmc A addr2 refused config, retrying");
        assert_eq!(refused_text(2).as_str(), "tmc Z addr1 refused config, retrying");
    }

    #[test]
    fn spread_cycle_and_untouched_axes() {
        let cfg = DriverConfig {
            ma: [0, 600, 600, 0],
            hold_pct: 30,
            micro: [16, 12, 16, 16],
            stealth: false,
        };
        assert!(config_datagrams(0, &cfg).is_none());
        assert!(config_datagrams(1, &cfg).is_none());
        let cfg = DriverConfig { micro: [16; DRIVERS], ..cfg };
        let [_, gconf, ..] = config_datagrams(1, &cfg).unwrap();
        assert!(GCONF::from(data(&gconf)).en_spread_cycle());
    }

    #[test]
    fn a_configuration_clears_the_reset_flag_before_anything_else() {
        // Every driver comes up with the reset flag set, and nothing but a
        // write of ones clears it: left set, the first poll after a boot
        // would take every driver for one that had just lost its supply.
        let cfg = DriverConfig { ma: [800; DRIVERS], hold_pct: 50, micro: [256; DRIVERS], stealth: true };
        for (axis, &addr) in ADDR.iter().enumerate() {
            let datagrams = config_datagrams(axis, &cfg).unwrap();
            let [clear, ..] = datagrams;
            assert_eq!(clear[1], addr);
            assert_eq!(clear[2], 0x80 | Address::GSTAT as u8);
            let flags = GSTAT::from(data(&clear));
            assert!(flags.reset() && flags.drv_err() && flags.uv_cp());
            assert_eq!(data(&clear), GSTAT_RESET | GSTAT_DRV_ERR | GSTAT_UV_CP);
            // The count of accepted writes the driver task checks for.
            assert_eq!(datagrams.len(), 4);
        }
    }

    #[test]
    fn a_configuration_is_kept_only_while_it_has_not_landed() {
        let cfg = DriverConfig { ma: [800, 800, 800, 0], hold_pct: 50, micro: [256; DRIVERS], stealth: true };
        let mut links = Links::new();
        assert!(links.settled());
        links.configure(&cfg);
        assert_eq!(links.get(0), Link::Pending);
        assert_eq!(links.get(3), Link::Unused, "the focus driver without a current is left alone");
        assert!(!links.settled());
        links.written(0, true);
        links.written(1, false);
        links.written(2, true);
        assert_eq!(links.get(0), Link::Held, "a landed configuration is not retried");
        assert_eq!(links.get(1), Link::Pending, "a refused one is");
        assert!(!links.settled());
        links.written(1, true);
        assert!(links.settled());
        // An unused driver never becomes held, whatever a write says.
        links.written(3, true);
        assert_eq!(links.get(3), Link::Unused);
        // A new configuration writes every driver it covers again, the
        // ones that held the last one once a poll has found them intact.
        links.configure(&cfg);
        assert_eq!(links.get(0), Link::Superseded);
        assert!(!links.settled());
        assert!(!links.polled(0, Some(0)));
        assert_eq!(links.get(0), Link::Pending);
    }

    #[test]
    fn a_supply_cycle_just_before_a_new_configuration_is_still_reported() {
        let cfg = DriverConfig { ma: [800; DRIVERS], hold_pct: 50, micro: [256; DRIVERS], stealth: true };
        let mut links = Links::new();
        links.configure(&cfg);
        for axis in 0..DRIVERS {
            links.written(axis, true);
        }
        // The supply dropped and came back since the last poll, and a
        // settings change arrives before the next one. Writing it would
        // clear the reset flag unread; the drivers that held the old one
        // are polled first.
        links.configure(&cfg);
        for axis in 0..DRIVERS {
            assert!(links.watched(axis));
            assert_ne!(links.get(axis), Link::Pending, "not written before the poll");
        }
        assert!(links.polled(0, Some(GSTAT_RESET)), "the reset flag is still seen");
        // Still dark when the change came.
        assert!(links.polled(1, None));
        assert!(!links.polled(2, Some(0)), "intact: written without a word");
        assert!(!links.polled(2, Some(GSTAT_RESET)), "polled once, then only written");
        for axis in 0..3 {
            assert_eq!(links.get(axis), Link::Pending);
        }
        // A driver the new configuration leaves alone is not watched.
        let without_focus = DriverConfig { ma: [800, 800, 800, 0], ..cfg };
        links.configure(&without_focus);
        assert_eq!(links.get(3), Link::Unused);
        assert!(!links.watched(3));
        assert!(!links.polled(3, None));
    }

    #[test]
    fn a_driver_that_loses_its_supply_is_reported_once_and_written_again() {
        let cfg = DriverConfig { ma: [800; DRIVERS], hold_pct: 50, micro: [256; DRIVERS], stealth: true };
        let mut links = Links::new();
        links.configure(&cfg);
        for axis in 0..DRIVERS {
            links.written(axis, true);
        }
        assert!(!links.polled(0, Some(0)), "clear flags: it holds its configuration");
        assert!(!links.polled(0, Some(GSTAT_DRV_ERR)), "a driver error costs no configuration");
        assert_eq!(links.get(0), Link::Held);

        // The supply goes: the driver stops answering.
        assert!(links.polled(0, None));
        assert_eq!(links.get(0), Link::Pending);
        assert!(!links.settled());
        assert!(!links.polled(0, None), "said once, not at every poll while it is dark");

        // The supply dropped and came back between two polls: the driver
        // answers, with its registers back at their reset values.
        assert!(links.polled(1, Some(GSTAT_RESET)));
        // Its charge pump is under voltage, which disables it.
        assert!(links.polled(2, Some(GSTAT_UV_CP)));
        assert!(!links.polled(3, Some(0)));

        // Written again once it answers, and watched as before.
        links.written(0, false);
        assert_eq!(links.get(0), Link::Pending);
        for axis in 0..DRIVERS {
            links.written(axis, true);
        }
        assert!(links.settled());
        assert!(links.polled(0, Some(GSTAT_RESET)), "a second loss is said again");
    }

    #[test]
    fn only_clear_flags_hold_a_configuration() {
        assert!(holds_config(Some(0)));
        assert!(holds_config(Some(GSTAT_DRV_ERR)));
        assert!(!holds_config(None));
        assert!(!holds_config(Some(GSTAT_RESET)));
        assert!(!holds_config(Some(GSTAT_UV_CP)));
        assert!(!holds_config(Some(GSTAT_RESET | GSTAT_UV_CP)));
    }

    #[test]
    fn a_lost_axis_says_which_one() {
        assert_eq!(lost_text(0).as_str(), "tmc R addr0 lost motor power, position may be off");
        assert_eq!(lost_text(3).as_str(), "tmc H addr3 lost motor power, position may be off");
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
        let reply = Reply { ifcnt: 4, micro: 256, status: 0x8000_0000 };
        assert_eq!(report_text(0, Some(reply), true).as_str(), "tmc R addr0 ifcnt=4 micro=256 status=0x80000000");
        assert_eq!(report_text(1, None, true).as_str(), "tmc A addr2 no reply, is motor power on");
        assert_eq!(report_text(2, Some(reply), true).as_str(), "tmc Z addr1 ifcnt=4 micro=256 status=0x80000000");
        let strapped = Reply { ifcnt: 0, micro: 8, status: 0 };
        assert_eq!(report_text(0, Some(strapped), true).as_str(), "tmc R addr0 ifcnt=0 micro=8 status=0x00000000");
    }

    #[test]
    fn a_driver_left_alone_is_reported_as_unused_not_as_a_fault() {
        // Without a focus axis the E socket is never configured: empty, it
        // answers nothing, and fitted, it steps at its strap.
        assert_eq!(report_text(3, None, false).as_str(), "tmc H addr3 unused, no reply");
        let strapped = Reply { ifcnt: 255, micro: 256, status: 0 };
        let text = report_text(3, Some(strapped), false);
        assert_eq!(text.as_str(), "tmc H addr3 unused, ifcnt=255 micro=256 status=0x00000000");
        assert!(text.len() < text.capacity(), "the longest line fits");
    }

    #[test]
    fn microsteps_read_back_from_the_driver() {
        // What each axis reports when its configuration landed: GCONF
        // selects the register, and MRES says the rest.
        let asked = |micro: u32| {
            let cfg = DriverConfig { ma: [800; DRIVERS], hold_pct: 50, micro: [micro; DRIVERS], stealth: true };
            let [_, gconf, _, chop] = config_datagrams(0, &cfg).unwrap();
            micro_of(data(&gconf), data(&chop), 0)
        };
        assert_eq!(asked(256), 256);
        assert_eq!(asked(16), 16);
        // What the sockets strap to when it did not, or when the motor
        // supply went and came back: GCONF back at its reset value leaves
        // the pins in charge, and MRES reads 256 all the while.
        let reset_gconf = GCONF::default().0;
        let reset_chop = CHOPCONF::default();
        assert_eq!(reset_chop.mres().number_of_microsteps(), 256);
        let pins = |ms1: bool, ms2: bool| {
            let mut ioin = IOIN::default();
            ioin.0 |= (ms1 as u32) << 2 | (ms2 as u32) << 3;
            ioin.0
        };
        assert_eq!(micro_of(reset_gconf, reset_chop.0, pins(false, false)), 8, "the radius socket, address 0");
        assert_eq!(micro_of(reset_gconf, reset_chop.0, pins(true, false)), 32, "the cross slide socket, address 1");
        assert_eq!(micro_of(reset_gconf, reset_chop.0, pins(false, true)), 64, "the table socket, address 2");
        assert_eq!(micro_of(reset_gconf, reset_chop.0, pins(true, true)), 16, "the focus socket, address 3");
    }
}
