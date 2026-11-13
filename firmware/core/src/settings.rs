//! Machine settings: names, units, defaults, text get/set, and a flash blob.
//!
//! Names and defaults are the table in docs/PROTOCOL.md. A `Settings` value
//! produced by this module is always within range: `set` refuses a change
//! that would leave it otherwise and `from_blob` rejects a stored copy that
//! is.

use crate::hal::Sink;
use crate::parser::number;
use crate::report;
use crate::{A, AXES, H, R, SEGMENTS, SEGMENT_MS, SERVOS, Z};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Settings {
    /// Steps per mm (radius, focus, cross slide) and per degree (table).
    /// The cross slide's entries are its `z_*` settings, used by `slide`
    /// as a setup axis and by the planner as a joint under `cartesian`.
    pub steps: [f32; AXES],
    /// Units per minute.
    pub max_rate: [f32; AXES],
    /// Units per second squared.
    pub accel: [f32; AXES],
    /// Allowed instantaneous speed change at a junction, units per second.
    pub jerk: [f32; AXES],
    /// Radius soft limit, mm; 0 = off.
    pub r_max: f32,
    /// Cross slide soft limit, mm either side of zero; 0 = off.
    pub z_max: f32,
    /// Jog rates without an F word, units per minute.
    pub jog_rate: [f32; AXES],
    /// Bit 0 inverts the radius, bit 1 the table, bit 2 the cross slide,
    /// bit 3 the focus axis.
    pub dir_invert: u8,
    /// Enable pin is active high.
    pub en_invert: bool,
    /// Disable the motors after this long idle; 0 = never.
    pub idle_ms: u32,
    /// Step pulse width.
    pub step_us: u32,
    pub laser_hz: u32,
    /// S for full duty.
    pub s_max: f32,
    /// Dynamic mode: a computed power below this is off.
    pub s_min: f32,
    pub laser_invert: bool,
    /// Default timeout for the `laser` command.
    pub laser_ms: u32,
    /// Run current per axis, mA; 0 leaves that driver untouched.
    pub tmc_ma: [u32; AXES],
    pub tmc_hold_pct: u32,
    pub tmc_micro: [u32; AXES],
    pub tmc_stealth: bool,
    /// A focus axis is fitted: `H` words are taken and its driver is
    /// configured. Off, the axis never moves.
    pub h_axis: bool,
    /// The probe input is active high; off, it is active low, as a switch
    /// or a pin touching grounded copper pulls it down.
    pub probe_invert: bool,
    /// Motion kept queued ahead of the step interrupt during a probe, ms:
    /// with the segment being stepped, how long the head goes on past the
    /// contact before its brake starts. Whole segments, rounded up; 0 stops
    /// the axis at the contact without a brake when the probe is slow
    /// enough for that (see `stepper`).
    pub probe_ms: u32,
    /// The cross slide is a joint: Y of an X/Y machine whose X is the
    /// radius, interpolated with it and with the focus axis, while the
    /// table holds its angle. Off, it is the setup axis in `slide`.
    pub cartesian: bool,
    /// The laser output drives a spindle: it runs at the speed `spindle`
    /// set until `spindle off`, a reset or an alarm, through every move
    /// and hold, and `S` is its speed rather than a beam power.
    pub spindle: bool,
    /// The driver socket of each joint as four digits, radius, table,
    /// cross slide and focus axis from the left (the `dir_invert` bit
    /// order), each 1 for the X socket, 2 for Y, 3 for Z and 4 for E: 1234
    /// is the board as labeled. Always each socket once.
    pub sockets: u32,
    /// GPIO of the laser (or spindle) PWM output. Read at boot: a change
    /// takes effect after `$save` and a restart.
    pub laser_pin: u32,
    /// GPIO of the probe input, pulled up inside the chip. Read at boot.
    pub probe_pin: u32,
    /// An output follows the tool: driven while a job runs, a beam is
    /// lit, a dwell burns or the spindle turns, for a laser supply relay,
    /// an air assist or a spindle's run input. The pin is claimed at boot
    /// only when this is set then; on a board that claimed it, a change
    /// applies at once.
    pub tool_out: bool,
    /// GPIO of that output. Read at boot.
    pub tool_pin: u32,
    /// The tool output is active low.
    pub tool_invert: bool,
    /// Where each axis has an endstop, by joint (`R`, `A`, `H`, `Z`): 0
    /// none, `STOP_MIN` at the negative end, `STOP_MAX` at the positive
    /// end, both at both ends on the one input (normally closed switches
    /// in series, or normally open in parallel). `home` seeks the switch,
    /// and `limits` makes it halt a move.
    pub stop: [u8; AXES],
    /// GPIO of each axis's endstop input, pulled up inside the chip. Read
    /// at boot.
    pub stop_pin: [u32; AXES],
    /// How far `home` backs the axis off its switch before the slow
    /// approach, and leaves it off the switch at the end, units.
    pub home_pull: [f32; AXES],
    /// What the axis reads where its switch closes: the switch at the
    /// negative end, or the only one. The positive switch of an axis with
    /// both reads `home_pos + home_travel`.
    pub home_pos: [f32; AXES],
    /// The axis's travel between its ends, units. A home seeks the switch
    /// a tenth further than that plus the pull-off, so a switch it does
    /// not find within it is missing.
    pub home_travel: [f32; AXES],
    /// The endstop inputs are active high: bit 0 the rail, bit 1 the
    /// table, bit 2 the cross slide, bit 3 the focus axis, the
    /// `dir_invert` order. Off, a switch pulls its input low.
    pub stop_invert: u8,
    /// Which endstops halt a move that closes them, same bit order: the
    /// interrupt drops everything the moment one closes, and the machine
    /// raises `ALARM:4`, the position lost as it is on a reset while
    /// moving. Off, a switch closing under a move is ignored.
    pub limits: u8,
    /// With `cartesian`, the table's driver turns a dispenser's plunger:
    /// `A` is its position in mm, taken on `go` and `cut` like a joint
    /// word, with no part in the board length a surface feed is measured
    /// over, and the output stays dark. On a polar machine the flag does
    /// nothing.
    pub dispenser: bool,
    /// The drivers' tuning below, one value for all four, each a register
    /// field of the TMC2209 (datasheet Rev 1.09). CHOPCONF.intpol: a
    /// driver interpolates every microstep it is given to 256, whatever
    /// `tmc_*_micro` it steps at.
    pub tmc_intpol: bool,
    /// CHOPCONF.TOFF, 1 to 15: the chopper's slow decay lasts 24 + 32 *
    /// TOFF clocks. 0 switches the driver's bridges off, so it is refused.
    pub tmc_toff: u8,
    /// CHOPCONF.TBL, 0 to 3: the current comparator is blanked for 16,
    /// 24, 32 or 40 clocks after each switching event.
    pub tmc_tbl: u8,
    /// CHOPCONF.HSTRT, 0 to 7: spreadCycle's hysteresis starts 1 to 8
    /// above its end.
    pub tmc_hstrt: u8,
    /// CHOPCONF.HEND, 0 to 15: spreadCycle's hysteresis ends at -3 to 12.
    pub tmc_hend: u8,
    /// IHOLD_IRUN.IHOLDDELAY, 0 to 15: each step of the fall from the run
    /// current to the hold current takes this many 2^18 clocks; 0 drops
    /// to the hold current at once.
    pub tmc_hold_delay: u8,
    /// TPOWERDOWN, 0 to 255: the wait, in 2^18 clocks, between the driver
    /// finding the motor at rest (2^20 clocks after its last step) and the
    /// fall to the hold current.
    pub tmc_tpowerdown: u8,
    /// TPWMTHRS, up to `TPWMTHRS_MAX`: with `tmc_stealth`, the TSTEP below
    /// which a driver leaves stealthChop for spreadCycle, TSTEP being the
    /// clocks between two 1/256 microsteps whatever the microsteps; 0 keeps
    /// stealthChop at every speed.
    pub tmc_tpwmthrs: u32,
    /// GPIOs of the I2C bus the PCA9685 is on, its data and its clock line:
    /// an even pin for the data and an odd one for the clock, of the same
    /// I2C block (`i2c_block`). Read at boot, and claimed only when a servo
    /// is on the PCA9685.
    pub i2c_sda: u32,
    pub i2c_scl: u32,
    /// The PCA9685's 7-bit address, `PCA_ADDR_MIN` to `PCA_ADDR_MAX` as its
    /// six address pins set it. Read at boot.
    pub pca_addr: u32,
    /// Where each servo's pulse comes from: `SERVO_NONE`, `SERVO_PIN` on
    /// its `servo_pin`, or `SERVO_PCA` on channel `servo_chan` of the
    /// PCA9685. Read at boot: the board claims a pin, or starts the bus,
    /// only for what was fitted then. A servo taken off stops its pulse at
    /// once.
    pub servo_out: [u8; SERVOS],
    /// GPIO of a servo on the board itself. Read at boot.
    pub servo_pin: [u32; SERVOS],
    /// Channel of a servo on the PCA9685, 0 to 15. Read at boot.
    pub servo_chan: [u8; SERVOS],
    /// The pulse at angle 0 and at the end of the range, microseconds. The
    /// first may be the longer, for a servo that turns the other way.
    pub servo_min_us: [u32; SERVOS],
    pub servo_max_us: [u32; SERVOS],
    /// Degrees from the angle at `servo_min_us` to the one at
    /// `servo_max_us`; a `servo` line takes 0 to this.
    pub servo_range: [f32; SERVOS],
    /// The angle a servo is driven to at boot, held to its range; below 0
    /// it gets no pulse until a `servo` line moves it.
    pub servo_start: [f32; SERVOS],
}

/// An endstop at the negative end of its axis, and one at the positive
/// end; `stop` is their sum.
pub const STOP_MIN: u8 = 1;
pub const STOP_MAX: u8 = 2;

/// Largest `probe_ms`: the whole segment ring.
pub const PROBE_MS_MAX: u32 = SEGMENTS as u32 * SEGMENT_MS;

/// Driver sockets in use, in the order `sockets` numbers them from 1.
pub const SOCKETS: usize = 4;
/// Radius on X, table on Y, cross slide on Z, focus axis on E.
pub const SOCKETS_DEFAULT: u32 = 1234;

/// Highest GPIO number the board has.
pub const PIN_MAX: u32 = 29;
/// GPIOs the driver sockets (STEP, DIR and EN of X, Y, Z and E) and the
/// driver UART own, which no pin setting may name.
pub const RESERVED_PINS: [u32; 14] = [2, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 19, 28];
/// The FAN3 header.
pub const LASER_PIN_DEFAULT: u32 = 20;
/// The Z-STOP header.
pub const PROBE_PIN_DEFAULT: u32 = 25;
/// The FAN1 header.
pub const TOOL_PIN_DEFAULT: u32 = 17;
/// Endstop inputs by joint: X-STOP for the rail, Y-STOP for the table,
/// E-STOP for the focus axis and the PROBE header for the cross slide,
/// Z-STOP being the probe's.
pub const STOP_PIN_DEFAULTS: [u32; AXES] = [4, 3, 16, 22];

/// Largest `tmc_tpwmthrs`: TPWMTHRS is a 20 bit field (TMC2209 datasheet
/// Rev 1.09, TPWMTHRS).
pub const TPWMTHRS_MAX: u32 = (1 << 20) - 1;

/// A servo's output: none, a GPIO of the board, or a PCA9685 channel.
pub const SERVO_NONE: u8 = 0;
pub const SERVO_PIN: u8 = 1;
pub const SERVO_PCA: u8 = 2;
/// The SERVOS header, a BLTouch's control line on other firmware.
pub const SERVO_PIN_DEFAULT: u32 = 29;
/// Channels of a PCA9685, LED0 to LED15.
pub const PCA_CHANNELS: u8 = 16;
/// The PCA9685's addresses: a fixed 1 and six address pins A5 to A0
/// (PCA9685 datasheet Rev. 4, 7.1 Device addresses); all pins low is the
/// first, and the default.
pub const PCA_ADDR_MIN: u32 = 0x40;
pub const PCA_ADDR_MAX: u32 = 0x7F;
pub const PCA_ADDR_DEFAULT: u32 = PCA_ADDR_MIN;
/// The I2C bus on the UART header's TX and RX pins, GP0 and GP1, which are
/// I2C0's data and clock lines.
pub const I2C_SDA_DEFAULT: u32 = 0;
pub const I2C_SCL_DEFAULT: u32 = 1;
/// The shortest and longest servo pulse a setting may name, microseconds.
/// Hobby servos take 1000 to 2000, many 500 to 2500; the bounds only keep
/// a typo from driving one hard into its stop.
pub const SERVO_US_MIN: u32 = 200;
pub const SERVO_US_MAX: u32 = 3000;
/// The widest servo range, degrees.
pub const SERVO_RANGE_MAX: f32 = 360.0;
/// The start angle that leaves a servo without a pulse at boot; any
/// value below 0 does.
pub const SERVO_START_NONE: f32 = -1.0;

/// A pin setting names a GPIO the board has and nothing else owns.
pub fn pin_valid(pin: u32) -> bool {
    pin <= PIN_MAX && !RESERVED_PINS.contains(&pin)
}

/// The STOP headers' GPIOs: Y-STOP, X-STOP, E-STOP and Z-STOP. Each signal
/// reaches the RP2040 through a 74LVC2G34 buffer (SKR Pico V1.0
/// schematic), an input only, whose output would fight anything the chip
/// drove on the pin.
pub const BUFFERED_INPUTS: [u32; 4] = [3, 4, 16, 25];

/// A pin a servo's pulse or the I2C bus may drive: a free GPIO not behind
/// a STOP header's buffer.
pub fn output_pin_valid(pin: u32) -> bool {
    pin_valid(pin) && !BUFFERED_INPUTS.contains(&pin)
}

/// The RP2040 wires an I2C block's data line to every fourth GPIO from 0
/// (I2C0) or 2 (I2C1) and its clock line to the GPIO after each (RP2040
/// datasheet, 1.4.3 GPIO Functions): data on even pins, clock on odd ones.
pub fn i2c_sda_capable(pin: u32) -> bool {
    pin.is_multiple_of(2)
}

pub fn i2c_scl_capable(pin: u32) -> bool {
    !pin.is_multiple_of(2)
}

/// The I2C block a data or clock GPIO belongs to: 0 or 1.
pub fn i2c_block(pin: u32) -> u32 {
    (pin / 2) % 2
}

/// `sockets` names each socket exactly once.
fn sockets_valid(sockets: u32) -> bool {
    if !(1000..=9999).contains(&sockets) {
        return false;
    }
    let mut seen = 0u8;
    let mut rest = sockets;
    for _ in 0..SOCKETS {
        let digit = rest % 10;
        rest /= 10;
        if !(1..=SOCKETS as u32).contains(&digit) {
            return false;
        }
        seen |= 1 << (digit - 1);
    }
    seen == 0b1111
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            // Both motors are 200 step at 256 microsteps. The radius rides
            // a 5 mm per turn screw, the table a 100:1 drive.
            // The focus axis is assumed to be a 200 step motor on an 8 mm
            // lead screw at 256 microsteps. The cross slide rides the same
            // screw and driver as the radius, so it keeps the radius scale,
            // rate and jerk.
            steps: [10240.0, 14222.222, 6400.0, 10240.0],
            // The step generator runs out before the motors do at this
            // resolution: 586 mm/min on the radius and 422 deg/min on the
            // table. Asking for more only moves slower than commanded.
            max_rate: [560.0, 400.0, 600.0, 560.0],
            accel: [50.0, 50.0, 50.0, 50.0],
            jerk: [3.0, 2.0, 1.0, 3.0],
            r_max: 0.0,
            z_max: 0.0,
            jog_rate: [300.0, 200.0, 120.0, 120.0],
            dir_invert: 0,
            en_invert: false,
            idle_ms: 0,
            step_us: 2,
            laser_hz: 5000,
            s_max: 1000.0,
            s_min: 0.0,
            laser_invert: false,
            laser_ms: 5000,
            tmc_ma: [800, 800, 600, 800],
            tmc_hold_pct: 50,
            tmc_micro: [256, 256, 256, 256],
            tmc_stealth: true,
            h_axis: false,
            probe_invert: false,
            probe_ms: 20,
            cartesian: false,
            spindle: false,
            sockets: SOCKETS_DEFAULT,
            laser_pin: LASER_PIN_DEFAULT,
            probe_pin: PROBE_PIN_DEFAULT,
            tool_out: false,
            tool_pin: TOOL_PIN_DEFAULT,
            tool_invert: false,
            stop: [0; AXES],
            stop_pin: STOP_PIN_DEFAULTS,
            home_pull: [1.0; AXES],
            home_pos: [0.0; AXES],
            // A rail's worth, a turn and a bit, a focus screw, a slide.
            home_travel: [200.0, 400.0, 50.0, 200.0],
            stop_invert: 0,
            limits: 0,
            dispenser: false,
            // What the firmware wrote before the tuning was a setting. The
            // chopper fields are those a TMC2209 with unprogrammed OTP comes
            // up with (TOFF 3, TBL 2, HSTRT 5, HEND 0, intpol on), and it
            // never wrote TPOWERDOWN or TPWMTHRS, which come up at 20 and 0
            // (TMC2209 datasheet Rev 1.09, CHOPCONF, TPOWERDOWN, TPWMTHRS
            // and OTP_READ). IHOLDDELAY 10 was its own choice.
            tmc_intpol: true,
            tmc_toff: 3,
            tmc_tbl: 2,
            tmc_hstrt: 5,
            tmc_hend: 0,
            tmc_hold_delay: 10,
            tmc_tpowerdown: 20,
            tmc_tpwmthrs: 0,
            i2c_sda: I2C_SDA_DEFAULT,
            i2c_scl: I2C_SCL_DEFAULT,
            pca_addr: PCA_ADDR_DEFAULT,
            // No servo fitted. One fitted on the board is on the SERVOS
            // header, and one on the PCA9685 on the channel of its number,
            // until set otherwise; the pulse span is the one every hobby
            // servo takes, and none moves at boot.
            servo_out: [SERVO_NONE; SERVOS],
            servo_pin: [SERVO_PIN_DEFAULT; SERVOS],
            servo_chan: core::array::from_fn(|i| i as u8),
            servo_min_us: [1000; SERVOS],
            servo_max_us: [2000; SERVOS],
            servo_range: [180.0; SERVOS],
            servo_start: [SERVO_START_NONE; SERVOS],
        }
    }
}

/// Every setting name, in the order `$` lists them.
pub const NAMES: [&str; 114] = [
    "r_steps", "a_steps", "r_rate", "a_rate", "r_accel", "a_accel", "r_jerk", "a_jerk",
    "r_max", "z_steps", "z_rate", "z_accel", "jog_z", "jog_r", "jog_a",
    "dir_invert", "en_invert", "idle_ms", "step_us",
    "laser_hz", "s_max", "s_min", "laser_invert", "laser_ms",
    "tmc_r_ma", "tmc_a_ma", "tmc_hold_pct", "tmc_r_micro", "tmc_a_micro",
    "tmc_z_ma", "tmc_z_micro", "tmc_stealth",
    "h_axis", "h_steps", "h_rate", "h_accel", "h_jerk", "jog_h", "probe_invert",
    "tmc_h_ma", "tmc_h_micro", "probe_ms",
    "z_jerk", "z_max", "cartesian", "spindle", "sockets",
    "laser_pin", "probe_pin", "tool_out", "tool_pin", "tool_invert",
    "r_stop", "r_stop_pin", "r_home_pull", "r_home_pos", "r_home_travel",
    "a_stop", "a_stop_pin", "a_home_pull", "a_home_pos", "a_home_travel",
    "h_stop", "h_stop_pin", "h_home_pull", "h_home_pos", "h_home_travel",
    "z_stop", "z_stop_pin", "z_home_pull", "z_home_pos", "z_home_travel",
    "stop_invert", "limits",
    "dispenser",
    "tmc_intpol", "tmc_toff", "tmc_tbl", "tmc_hstrt", "tmc_hend", "tmc_hold_delay", "tmc_tpowerdown", "tmc_tpwmthrs",
    "i2c_sda", "i2c_scl", "pca_addr",
    "servo1_out", "servo1_pin", "servo1_chan", "servo1_min_us", "servo1_max_us", "servo1_range", "servo1_start",
    "servo2_out", "servo2_pin", "servo2_chan", "servo2_min_us", "servo2_max_us", "servo2_range", "servo2_start",
    "servo3_out", "servo3_pin", "servo3_chan", "servo3_min_us", "servo3_max_us", "servo3_range", "servo3_start",
    "servo4_out", "servo4_pin", "servo4_chan", "servo4_min_us", "servo4_max_us", "servo4_range", "servo4_start",
];

/// First of the endstop settings in `NAMES`: five per joint in the
/// core's joint order, then the two masks; the dispenser flag and the
/// drivers' tuning follow them.
const STOP_NAMES_AT: usize = 52;
const STOP_NAMES_PER_JOINT: usize = 5;
/// First of the drivers' tuning settings in `NAMES`.
const TUNING_NAMES_AT: usize = 75;
/// First of the I2C bus's settings in `NAMES`: its two pins and the
/// PCA9685's address.
const BUS_NAMES_AT: usize = 83;
/// First of the servos' settings in `NAMES`, seven per servo from servo 1,
/// which run to its end.
const SERVO_NAMES_AT: usize = 86;
const SERVO_NAMES_PER_SERVO: usize = 7;
const _: () = assert!(SERVO_NAMES_AT + SERVOS * SERVO_NAMES_PER_SERVO == NAMES.len());

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SetError {
    Unknown,
    BadValue,
}

/// What a change touches, so the machine can re-apply it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Changed {
    Motion,
    Laser,
    Driver,
    /// `cartesian`: the cross slide changes hands between `slide` and the
    /// joints.
    Kinematics,
    /// `spindle` and `dispenser`: the output changes meaning, so whatever
    /// runs on it stops.
    Tool,
    /// A servo's settings: its pulse is worked out again.
    Servo,
    Other,
}

/// Size of the persisted blob: magic, version, the fields, a CRC-32 in the
/// last four bytes. Version 11 doubled it for the servos; the versions
/// before it are `OLD_BLOB_LEN` long, their CRC in their own last four.
pub const BLOB_LEN: usize = 512;
const OLD_BLOB_LEN: usize = 256;

/// Largest value any float setting may take; keeps the step arithmetic
/// far from f32 and u32 limits.
pub const FLOAT_MAX: f32 = 1.0e7;

const MAGIC: [u8; 4] = *b"SPNY";
/// Bumped whenever the field layout changes, so a blob written by an
/// older firmware is thrown away rather than read as this layout. Versions
/// 5 to 11 are version 4 with fields appended, so a blob from version 4 on
/// is still read, with the fields added after it at their defaults.
const BLOB_VERSION: u8 = 11;
/// Oldest version whose fields are a prefix of this layout.
const BLOB_VERSION_PREFIX: u8 = 4;
/// The first version written in the longer blob.
const LONG_BLOB_VERSION: u8 = 11;

/// The length of a blob of `version`, whose CRC is in its last four bytes.
const fn blob_len(version: u8) -> usize {
    if version >= LONG_BLOB_VERSION {
        BLOB_LEN
    } else {
        OLD_BLOB_LEN
    }
}
/// Bytes before the first field: magic and version.
const HEADER_LEN: usize = MAGIC.len() + 1;
/// Joints stored per array in the version 4 part of the blob, in this
/// order; the cross slide's values follow them as separate fields there.
const PREFIX_JOINTS: [usize; 3] = [R, A, H];
/// Serialized size of the version 4 fields.
const PREFIX_LEN: usize = 4 * (3 + 3 + 3 + 3 + 1 + 4 + 3)
    + 1 + 1 + 4 + 4 + 4 + 4 + 4 + 1 + 4
    + 4 * 3 + 4 + 4 * 3 + 4 + 4 + 1
    + 1 + 1 + 4;
/// Serialized size of the fields, in blob order: the version 4 fields,
/// then `z_jerk`, `z_max`, `cartesian` and `spindle` (version 5), then
/// `sockets` (version 6), then the pins and the tool output (version 7),
/// then the endstops and homing (version 8), then `dispenser` (version 9),
/// then the drivers' tuning (version 10), then the I2C bus and the servos
/// (version 11).
const FIELDS_LEN: usize = OLD_FIELDS_LEN + SERVO_FIELDS_LEN;
/// Serialized size of the fields up to version 10, which fill the old blob
/// up to its CRC.
const OLD_FIELDS_LEN: usize = PREFIX_LEN + 4 + 4 + 1 + 1 + 4 + PINS_LEN + STOPS_LEN + 1 + TUNING_LEN;
/// Serialized size of the version 11 fields: the bus's two pins and the
/// PCA9685's address a byte each, then per servo its output, pin and
/// channel a byte each, its two pulses in two bytes each, its range and
/// its start.
const SERVO_FIELDS_LEN: usize = 3 + SERVOS * (3 + 2 + 2 + 4 + 4);
/// Serialized size of the version 7 fields.
const PINS_LEN: usize = 4 + 4 + 1 + 4 + 1;
/// Serialized size of the version 8 fields: per joint the ends, the pin
/// as a byte, the pull-off, the position and the travel, then the masks.
const STOPS_LEN: usize = AXES * (1 + 1 + 4 + 4 + 4) + 1 + 1;
/// Serialized size of the version 10 fields: the interpolation flag, a
/// byte for each of the six small fields, and `tmc_tpwmthrs` in the three
/// bytes its 20 bits need. They fill the old blob up to its CRC, which is
/// why version 11 is a longer blob, with the CRC's place read from the
/// version.
const TUNING_LEN: usize = 1 + 6 + 3;
/// The CRC covers everything before it.
const CRC_OFFSET: usize = BLOB_LEN - 4;
const OLD_CRC_OFFSET: usize = OLD_BLOB_LEN - 4;
const _: () = assert!(HEADER_LEN + OLD_FIELDS_LEN == OLD_CRC_OFFSET);
const _: () = assert!(HEADER_LEN + FIELDS_LEN <= CRC_OFFSET);

/// One field of `Settings` by reference, so parsing and printing are
/// written once per type.
enum Slot<'a> {
    Float(&'a mut f32),
    Int(&'a mut u32),
    Byte(&'a mut u8),
    Flag(&'a mut bool),
}

/// A mask in the `dir_invert` bit order (rail, table, cross slide, focus
/// axis) as the step port numbers the joints: the rail and table bits as
/// they are, the focus axis from bit 3 and the cross slide from bit 2.
fn joint_bits(bits: u8) -> u8 {
    (bits & 0b0011) | ((bits >> 1) & (1 << H)) | ((bits << 1) & (1 << Z))
}

/// Position of `name` in `NAMES`, ignoring case.
fn index_of(name: &str) -> Option<usize> {

    NAMES.iter().position(|known| known.eq_ignore_ascii_case(name))
}

fn group(index: usize) -> Changed {
    match index {
        0..=18 | 33..=38 | 41..=43 => Changed::Motion,
        19..=23 => Changed::Laser,
        44 => Changed::Kinematics,
        45 | 74 => Changed::Tool,
        // The pins are read at boot; the tool output is driven again at
        // the next poll.
        47 | 48 | 50 => Changed::Other,
        49 | 51 => Changed::Laser,
        // A servo's pulse is worked out from its settings each time; the
        // bus is started at boot.
        SERVO_NAMES_AT.. => Changed::Servo,
        BUS_NAMES_AT.. => Changed::Other,
        // The drivers' tuning is written to them like their currents.
        TUNING_NAMES_AT.. => Changed::Driver,
        // The endstops are read fresh by the stepper at every fill, and
        // a home reads its tuning when it starts.
        STOP_NAMES_AT.. => Changed::Other,
        // Whether the focus axis is fitted decides whether its driver is
        // configured; `sockets` moves every axis to its driver.
        _ => Changed::Driver,
    }
}

/// Unsigned decimal integer: digits only.
fn integer(text: &str) -> Option<u32> {
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse::<u32>().ok()
}

fn flag(text: &str) -> Option<bool> {
    match text {
        "0" => Some(false),
        "1" => Some(true),
        _ => None,
    }
}

/// CRC-32 as used by Ethernet and zip: reflected, polynomial 0xEDB88320,
/// initial and final xor all ones. Computed bit by bit, no table.
pub fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &byte in data {
        crc ^= byte as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

struct Writer<'a> {
    buf: &'a mut [u8],
    at: usize,
}

impl Writer<'_> {
    fn bytes(&mut self, bytes: &[u8]) {
        self.buf[self.at..self.at + bytes.len()].copy_from_slice(bytes);
        self.at += bytes.len();
    }

    fn u8(&mut self, value: u8) {
        self.bytes(&[value]);
    }

    /// The low two bytes of `value`, which must fit in them.
    fn u16(&mut self, value: u32) {
        debug_assert!(value <= u16::MAX as u32);
        self.bytes(&value.to_le_bytes()[..2]);
    }

    fn u32(&mut self, value: u32) {
        self.bytes(&value.to_le_bytes());
    }

    /// The low three bytes of `value`, which must fit in them.
    fn u24(&mut self, value: u32) {
        debug_assert!(value < 1 << 24);
        self.bytes(&value.to_le_bytes()[..3]);
    }

    fn f32(&mut self, value: f32) {
        self.bytes(&value.to_le_bytes());
    }

    fn flag(&mut self, value: bool) {
        self.u8(value as u8);
    }
}

struct Reader<'a> {
    buf: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn take<const N: usize>(&mut self) -> [u8; N] {
        let mut bytes = [0u8; N];
        bytes.copy_from_slice(&self.buf[self.at..self.at + N]);
        self.at += N;
        bytes
    }

    fn u8(&mut self) -> u8 {
        self.take::<1>()[0]
    }

    fn u16(&mut self) -> u32 {
        u16::from_le_bytes(self.take()) as u32
    }

    fn u32(&mut self) -> u32 {
        u32::from_le_bytes(self.take())
    }

    fn u24(&mut self) -> u32 {
        let [low, mid, high] = self.take::<3>();
        u32::from_le_bytes([low, mid, high, 0])
    }

    fn f32(&mut self) -> f32 {
        f32::from_le_bytes(self.take())
    }

    /// `None` for anything but 0 or 1.
    fn flag(&mut self) -> Option<bool> {
        match self.u8() {
            0 => Some(false),
            1 => Some(true),
            _ => None,
        }
    }
}

impl Settings {
    fn slot(&mut self, index: usize) -> Slot<'_> {
        match index {
            0 => Slot::Float(&mut self.steps[R]),
            1 => Slot::Float(&mut self.steps[A]),
            2 => Slot::Float(&mut self.max_rate[R]),
            3 => Slot::Float(&mut self.max_rate[A]),
            4 => Slot::Float(&mut self.accel[R]),
            5 => Slot::Float(&mut self.accel[A]),
            6 => Slot::Float(&mut self.jerk[R]),
            7 => Slot::Float(&mut self.jerk[A]),
            8 => Slot::Float(&mut self.r_max),
            9 => Slot::Float(&mut self.steps[Z]),
            10 => Slot::Float(&mut self.max_rate[Z]),
            11 => Slot::Float(&mut self.accel[Z]),
            12 => Slot::Float(&mut self.jog_rate[Z]),
            13 => Slot::Float(&mut self.jog_rate[R]),
            14 => Slot::Float(&mut self.jog_rate[A]),
            15 => Slot::Byte(&mut self.dir_invert),
            16 => Slot::Flag(&mut self.en_invert),
            17 => Slot::Int(&mut self.idle_ms),
            18 => Slot::Int(&mut self.step_us),
            19 => Slot::Int(&mut self.laser_hz),
            20 => Slot::Float(&mut self.s_max),
            21 => Slot::Float(&mut self.s_min),
            22 => Slot::Flag(&mut self.laser_invert),
            23 => Slot::Int(&mut self.laser_ms),
            24 => Slot::Int(&mut self.tmc_ma[R]),
            25 => Slot::Int(&mut self.tmc_ma[A]),
            26 => Slot::Int(&mut self.tmc_hold_pct),
            27 => Slot::Int(&mut self.tmc_micro[R]),
            28 => Slot::Int(&mut self.tmc_micro[A]),
            29 => Slot::Int(&mut self.tmc_ma[Z]),
            30 => Slot::Int(&mut self.tmc_micro[Z]),
            31 => Slot::Flag(&mut self.tmc_stealth),
            32 => Slot::Flag(&mut self.h_axis),
            33 => Slot::Float(&mut self.steps[H]),
            34 => Slot::Float(&mut self.max_rate[H]),
            35 => Slot::Float(&mut self.accel[H]),
            36 => Slot::Float(&mut self.jerk[H]),
            37 => Slot::Float(&mut self.jog_rate[H]),
            38 => Slot::Flag(&mut self.probe_invert),
            39 => Slot::Int(&mut self.tmc_ma[H]),
            40 => Slot::Int(&mut self.tmc_micro[H]),
            41 => Slot::Int(&mut self.probe_ms),
            42 => Slot::Float(&mut self.jerk[Z]),
            43 => Slot::Float(&mut self.z_max),
            44 => Slot::Flag(&mut self.cartesian),
            45 => Slot::Flag(&mut self.spindle),
            46 => Slot::Int(&mut self.sockets),
            47 => Slot::Int(&mut self.laser_pin),
            48 => Slot::Int(&mut self.probe_pin),
            49 => Slot::Flag(&mut self.tool_out),
            50 => Slot::Int(&mut self.tool_pin),
            51 => Slot::Flag(&mut self.tool_invert),
            72 => Slot::Byte(&mut self.stop_invert),
            73 => Slot::Byte(&mut self.limits),
            74 => Slot::Flag(&mut self.dispenser),
            75 => Slot::Flag(&mut self.tmc_intpol),
            76 => Slot::Byte(&mut self.tmc_toff),
            77 => Slot::Byte(&mut self.tmc_tbl),
            78 => Slot::Byte(&mut self.tmc_hstrt),
            79 => Slot::Byte(&mut self.tmc_hend),
            80 => Slot::Byte(&mut self.tmc_hold_delay),
            81 => Slot::Byte(&mut self.tmc_tpowerdown),
            82 => Slot::Int(&mut self.tmc_tpwmthrs),
            83 => Slot::Int(&mut self.i2c_sda),
            84 => Slot::Int(&mut self.i2c_scl),
            85 => Slot::Int(&mut self.pca_addr),
            SERVO_NAMES_AT.. => {
                let at = index - SERVO_NAMES_AT;
                let servo = at / SERVO_NAMES_PER_SERVO;
                match at % SERVO_NAMES_PER_SERVO {
                    0 => Slot::Byte(&mut self.servo_out[servo]),
                    1 => Slot::Int(&mut self.servo_pin[servo]),
                    2 => Slot::Byte(&mut self.servo_chan[servo]),
                    3 => Slot::Int(&mut self.servo_min_us[servo]),
                    4 => Slot::Int(&mut self.servo_max_us[servo]),
                    5 => Slot::Float(&mut self.servo_range[servo]),
                    _ => Slot::Float(&mut self.servo_start[servo]),
                }
            }
            _ => {
                let at = index - STOP_NAMES_AT;
                let joint = [R, A, H, Z][at / STOP_NAMES_PER_JOINT];
                match at % STOP_NAMES_PER_JOINT {
                    0 => Slot::Byte(&mut self.stop[joint]),
                    1 => Slot::Int(&mut self.stop_pin[joint]),
                    2 => Slot::Float(&mut self.home_pull[joint]),
                    3 => Slot::Float(&mut self.home_pos[joint]),
                    _ => Slot::Float(&mut self.home_travel[joint]),
                }
            }
        }
    }

    /// The table's driver turns a dispenser's plunger: the flag acts
    /// only on a cartesian machine.
    pub fn dispensing(&self) -> bool {
        self.cartesian && self.dispenser
    }

    /// Servo `i` (from 0) has an output.
    pub fn servo_fitted(&self, i: usize) -> bool {
        self.servo_out[i] != SERVO_NONE
    }

    /// Some servo has an output.
    pub fn any_servo(&self) -> bool {
        (0..SERVOS).any(|i| self.servo_fitted(i))
    }

    /// Where servo `i`'s pulse comes from: its output and the pin or the
    /// channel that output takes. A change of it is a servo wired anew.
    pub fn servo_wiring(&self, i: usize) -> (u8, u32) {
        match self.servo_out[i] {
            SERVO_PIN => (SERVO_PIN, self.servo_pin[i]),
            SERVO_PCA => (SERVO_PCA, self.servo_chan[i] as u32),
            out => (out, 0),
        }
    }

    /// Servo `i`'s pulse for `angle` degrees, in whole microseconds, the
    /// angle held to the servo's range: a straight line from `servo_min_us`
    /// at 0 to `servo_max_us` at the end of the range.
    pub fn servo_pulse_us(&self, i: usize, angle: f32) -> u16 {
        let range = self.servo_range[i];
        let angle = angle.clamp(0.0, range);
        let min = self.servo_min_us[i] as f32;
        let max = self.servo_max_us[i] as f32;
        // Both ends are within the setting bounds, so the sum is positive
        // and fits a u16.
        (min + (max - min) * angle / range + 0.5) as u16
    }

    /// The angle servo `i` is driven to at boot, held to its range; `None`
    /// leaves it without a pulse.
    pub fn servo_start_angle(&self, i: usize) -> Option<f32> {
        let start = self.servo_start[i];
        (start >= 0.0).then(|| start.min(self.servo_range[i]))
    }

    /// Joints with an endstop, bit i = joint i.
    pub fn stop_mask(&self) -> u8 {
        let mut mask = 0;
        for i in 0..AXES {
            if self.stop[i] != 0 {
                mask |= 1 << i;
            }
        }
        mask
    }

    /// Joint `i` has a switch at its negative end.
    pub fn has_min_stop(&self, i: usize) -> bool {
        self.stop[i] & STOP_MIN != 0
    }

    /// Joint `i` has a switch at its positive end.
    pub fn has_max_stop(&self, i: usize) -> bool {
        self.stop[i] & STOP_MAX != 0
    }

    /// `stop_invert` as the step port numbers the joints: bit i set when
    /// joint i's endstop input is active high.
    pub fn joint_stop_invert(&self) -> u8 {
        joint_bits(self.stop_invert)
    }

    /// `limits` as the step port numbers the joints, less the joints that
    /// have no endstop.
    pub fn joint_limits(&self) -> u8 {
        joint_bits(self.limits) & self.stop_mask()
    }

    /// Direction inversion for the joint axes as the step port numbers
    /// them (bit i = axis i): the radius and table bits as they are, the
    /// focus axis from bit 3 and the cross slide from bit 2, which is how
    /// `dir_invert` numbered them before either was a joint.
    pub fn joint_dir_invert(&self) -> u8 {
        joint_bits(self.dir_invert)
    }

    /// Driver socket of a joint (`R`, `A`, `H` or `Z`): 0 for the X
    /// socket, 1 for Y, 2 for Z, 3 for E.
    pub fn socket_of(&self, joint: usize) -> usize {
        // Digit place from the left, in the `dir_invert` order.
        let place = match joint {
            R => 0,
            A => 1,
            Z => 2,
            _ => 3,
        };
        let digit = self.sockets / 10u32.pow((SOCKETS - 1 - place) as u32) % 10;
        digit as usize - 1
    }

    /// Every field within its range.
    pub fn is_valid(&self) -> bool {
        let positive = |v: f32| v > 0.0 && v <= FLOAT_MAX;
        let non_negative = |v: f32| (0.0..=FLOAT_MAX).contains(&v);
        let microsteps = |m: u32| matches!(m, 1 | 2 | 4 | 8 | 16 | 32 | 64 | 128 | 256);
        self.steps.iter().all(|&v| positive(v))
            && self.max_rate.iter().all(|&v| positive(v))
            && self.accel.iter().all(|&v| positive(v))
            && self.jerk.iter().all(|&v| positive(v))
            && non_negative(self.r_max)
            && non_negative(self.z_max)
            && self.jog_rate.iter().all(|&v| positive(v))
            && self.dir_invert <= 15
            && self.probe_ms <= PROBE_MS_MAX
            && (1..=20).contains(&self.step_us)
            && (100..=100_000).contains(&self.laser_hz)
            && positive(self.s_max)
            && self.s_min >= 0.0
            && self.s_min <= self.s_max
            && (1..=60_000).contains(&self.laser_ms)
            && self.tmc_ma.iter().all(|&ma| ma <= 2000)
            && self.tmc_hold_pct <= 100
            && self.tmc_micro.iter().all(|&m| microsteps(m))
            && sockets_valid(self.sockets)
            && pin_valid(self.laser_pin)
            && pin_valid(self.probe_pin)
            && pin_valid(self.tool_pin)
            && self.stop.iter().all(|&ends| ends <= STOP_MIN + STOP_MAX)
            && self.stop_pin.iter().all(|&pin| pin_valid(pin))
            && self.home_pull.iter().all(|&v| positive(v))
            && self.home_pos.iter().all(|&v| (-FLOAT_MAX..=FLOAT_MAX).contains(&v))
            && self.home_travel.iter().all(|&v| positive(v))
            && self.stop_invert <= 15
            && self.limits <= 15
            // The drivers' tuning: each register field's width, and TOFF
            // above 0, which would switch the driver off (TMC2209
            // datasheet Rev 1.09, CHOPCONF, IHOLD_IRUN and TPWMTHRS).
            // TPOWERDOWN is 8 bits, all of its byte. Rules that join two
            // fields are the machine file's, which sees them together.
            && (1..=15).contains(&self.tmc_toff)
            && self.tmc_tbl <= 3
            && self.tmc_hstrt <= 7
            && self.tmc_hend <= 15
            && self.tmc_hold_delay <= 15
            && self.tmc_tpwmthrs <= TPWMTHRS_MAX
            // The bus: each pin able to carry its line. Whether the two are
            // of one I2C block joins two settings, which is the machine
            // file's to judge, and the board's at boot.
            && output_pin_valid(self.i2c_sda)
            && i2c_sda_capable(self.i2c_sda)
            && output_pin_valid(self.i2c_scl)
            && i2c_scl_capable(self.i2c_scl)
            && (PCA_ADDR_MIN..=PCA_ADDR_MAX).contains(&self.pca_addr)
            && (0..SERVOS).all(|i| self.servo_valid(i))
    }

    /// Servo `i`'s settings each within their own bounds. A start past the
    /// range is held to it when used: the two are set one at a time.
    fn servo_valid(&self, i: usize) -> bool {
        let pulse = |us: u32| (SERVO_US_MIN..=SERVO_US_MAX).contains(&us);
        self.servo_out[i] <= SERVO_PCA
            && output_pin_valid(self.servo_pin[i])
            && self.servo_chan[i] < PCA_CHANNELS
            && pulse(self.servo_min_us[i])
            && pulse(self.servo_max_us[i])
            && self.servo_range[i] > 0.0
            && self.servo_range[i] <= SERVO_RANGE_MAX
            && (SERVO_START_NONE..=SERVO_RANGE_MAX).contains(&self.servo_start[i])
    }

    /// Writes `name=value\n` for one setting; false for an unknown name.
    pub fn format(&self, name: &str, out: &mut impl Sink) -> bool {
        match index_of(name) {
            Some(index) => {
                self.format_index(index, out);
                true
            }
            None => false,
        }
    }

    /// Writes every setting, one per line, in `NAMES` order.
    pub fn format_all(&self, out: &mut impl Sink) {
        for index in 0..NAMES.len() {
            self.format_index(index, out);
        }
    }

    fn format_index(&self, index: usize, out: &mut impl Sink) {
        let mut copy = *self;
        out.write_str(NAMES[index]);
        out.write(b"=");
        match copy.slot(index) {
            Slot::Float(v) => report::float_trimmed(*v, 3, out),
            Slot::Int(v) => report::uint(*v as u64, out),
            Slot::Byte(v) => report::uint(*v as u64, out),
            Slot::Flag(v) => out.write(if *v { b"1" } else { b"0" }),
        }
        out.write(b"\n");
    }

    /// Parses `text` for `name`; ranges are checked (steps and rates
    /// positive, percentages 0..100, microsteps a power of two 1..256).
    /// Nothing changes on an error. Names are matched ignoring case.
    pub fn set(&mut self, name: &str, text: &str) -> Result<Changed, SetError> {
        let index = index_of(name).ok_or(SetError::Unknown)?;
        let mut next = *self;
        match next.slot(index) {
            Slot::Float(v) => *v = number(text).ok_or(SetError::BadValue)?,
            Slot::Int(v) => *v = integer(text).ok_or(SetError::BadValue)?,
            Slot::Byte(v) => {
                let n = integer(text).ok_or(SetError::BadValue)?;
                *v = u8::try_from(n).map_err(|_| SetError::BadValue)?;
            }
            Slot::Flag(v) => *v = flag(text).ok_or(SetError::BadValue)?,
        }
        if !next.is_valid() {
            return Err(SetError::BadValue);
        }
        *self = next;
        Ok(group(index))
    }

    /// Serializes for the store. Layout is private to this module: magic,
    /// version, the fields little-endian (the version 4 fields in their old
    /// order, then the ones added since), zero padding, and a CRC-32 over
    /// all of that in the last four bytes.
    pub fn to_blob(&self, buf: &mut [u8; BLOB_LEN]) {
        buf.fill(0);
        let mut w = Writer { buf: &mut buf[..], at: 0 };
        w.bytes(&MAGIC);
        w.u8(BLOB_VERSION);
        for array in [&self.steps, &self.max_rate, &self.accel, &self.jerk] {
            for i in PREFIX_JOINTS {
                w.f32(array[i]);
            }
        }
        w.f32(self.r_max);
        w.f32(self.steps[Z]);
        w.f32(self.max_rate[Z]);
        w.f32(self.accel[Z]);
        w.f32(self.jog_rate[Z]);
        for i in PREFIX_JOINTS {
            w.f32(self.jog_rate[i]);
        }
        w.u8(self.dir_invert);
        w.flag(self.en_invert);
        w.u32(self.idle_ms);
        w.u32(self.step_us);
        w.u32(self.laser_hz);
        w.f32(self.s_max);
        w.f32(self.s_min);
        w.flag(self.laser_invert);
        w.u32(self.laser_ms);
        for i in PREFIX_JOINTS {
            w.u32(self.tmc_ma[i]);
        }
        w.u32(self.tmc_hold_pct);
        for i in PREFIX_JOINTS {
            w.u32(self.tmc_micro[i]);
        }
        w.u32(self.tmc_ma[Z]);
        w.u32(self.tmc_micro[Z]);
        w.flag(self.tmc_stealth);
        w.flag(self.h_axis);
        w.flag(self.probe_invert);
        w.u32(self.probe_ms);
        debug_assert_eq!(w.at, HEADER_LEN + PREFIX_LEN);
        w.f32(self.jerk[Z]);
        w.f32(self.z_max);
        w.flag(self.cartesian);
        w.flag(self.spindle);
        w.u32(self.sockets);
        w.u32(self.laser_pin);
        w.u32(self.probe_pin);
        w.flag(self.tool_out);
        w.u32(self.tool_pin);
        w.flag(self.tool_invert);
        for i in 0..AXES {
            w.u8(self.stop[i]);
            w.u8(self.stop_pin[i] as u8);
            w.f32(self.home_pull[i]);
            w.f32(self.home_pos[i]);
            w.f32(self.home_travel[i]);
        }
        w.u8(self.stop_invert);
        w.u8(self.limits);
        w.flag(self.dispenser);
        w.flag(self.tmc_intpol);
        for field in [self.tmc_toff, self.tmc_tbl, self.tmc_hstrt, self.tmc_hend, self.tmc_hold_delay, self.tmc_tpowerdown] {
            w.u8(field);
        }
        w.u24(self.tmc_tpwmthrs);
        debug_assert_eq!(w.at, HEADER_LEN + OLD_FIELDS_LEN);
        // Pins are below 30 and the address below 128, so a byte each.
        w.u8(self.i2c_sda as u8);
        w.u8(self.i2c_scl as u8);
        w.u8(self.pca_addr as u8);
        for i in 0..SERVOS {
            w.u8(self.servo_out[i]);
            w.u8(self.servo_pin[i] as u8);
            w.u8(self.servo_chan[i]);
            w.u16(self.servo_min_us[i]);
            w.u16(self.servo_max_us[i]);
            w.f32(self.servo_range[i]);
            w.f32(self.servo_start[i]);
        }
        debug_assert_eq!(w.at, HEADER_LEN + FIELDS_LEN);
        let crc = crc32(&buf[..CRC_OFFSET]);
        buf[CRC_OFFSET..].copy_from_slice(&crc.to_le_bytes());
    }

    /// `None` when the blob is short, or the magic, version or CRC do not
    /// match, or a stored field is out of range. Bytes past the version's
    /// length (`BLOB_LEN`, or the old blob's before version 11) are
    /// ignored, so an old blob read as long as a new one still reads. A
    /// blob older than this version keeps the defaults of the fields added
    /// after it.
    pub fn from_blob(buf: &[u8]) -> Option<Settings> {
        let version = *buf.get(MAGIC.len())?;
        if buf[..MAGIC.len()] != MAGIC || !(BLOB_VERSION_PREFIX..=BLOB_VERSION).contains(&version) {
            return None;
        }
        let buf = buf.get(..blob_len(version))?;
        let crc_at = buf.len() - 4;
        let stored = u32::from_le_bytes(buf[crc_at..].try_into().ok()?);
        if crc32(&buf[..crc_at]) != stored {
            return None;
        }
        let mut r = Reader { buf, at: HEADER_LEN };
        let mut s = Settings::default();
        for array in [&mut s.steps, &mut s.max_rate, &mut s.accel, &mut s.jerk] {
            for i in PREFIX_JOINTS {
                array[i] = r.f32();
            }
        }
        s.r_max = r.f32();
        s.steps[Z] = r.f32();
        s.max_rate[Z] = r.f32();
        s.accel[Z] = r.f32();
        s.jog_rate[Z] = r.f32();
        for i in PREFIX_JOINTS {
            s.jog_rate[i] = r.f32();
        }
        s.dir_invert = r.u8();
        s.en_invert = r.flag()?;
        s.idle_ms = r.u32();
        s.step_us = r.u32();
        s.laser_hz = r.u32();
        s.s_max = r.f32();
        s.s_min = r.f32();
        s.laser_invert = r.flag()?;
        s.laser_ms = r.u32();
        for i in PREFIX_JOINTS {
            s.tmc_ma[i] = r.u32();
        }
        s.tmc_hold_pct = r.u32();
        for i in PREFIX_JOINTS {
            s.tmc_micro[i] = r.u32();
        }
        s.tmc_ma[Z] = r.u32();
        s.tmc_micro[Z] = r.u32();
        s.tmc_stealth = r.flag()?;
        s.h_axis = r.flag()?;
        s.probe_invert = r.flag()?;
        s.probe_ms = r.u32();
        if version >= 5 {
            s.jerk[Z] = r.f32();
            s.z_max = r.f32();
            s.cartesian = r.flag()?;
            s.spindle = r.flag()?;
        }
        if version >= 6 {
            s.sockets = r.u32();
        }
        if version >= 7 {
            s.laser_pin = r.u32();
            s.probe_pin = r.u32();
            s.tool_out = r.flag()?;
            s.tool_pin = r.u32();
            s.tool_invert = r.flag()?;
        }
        if version >= 8 {
            for i in 0..AXES {
                s.stop[i] = r.u8();
                s.stop_pin[i] = r.u8() as u32;
                s.home_pull[i] = r.f32();
                s.home_pos[i] = r.f32();
                s.home_travel[i] = r.f32();
            }
            s.stop_invert = r.u8();
            s.limits = r.u8();
        }
        if version >= 9 {
            s.dispenser = r.flag()?;
        }
        if version >= 10 {
            s.tmc_intpol = r.flag()?;
            s.tmc_toff = r.u8();
            s.tmc_tbl = r.u8();
            s.tmc_hstrt = r.u8();
            s.tmc_hend = r.u8();
            s.tmc_hold_delay = r.u8();
            s.tmc_tpowerdown = r.u8();
            s.tmc_tpwmthrs = r.u24();
        }
        if version >= 11 {
            s.i2c_sda = r.u8() as u32;
            s.i2c_scl = r.u8() as u32;
            s.pca_addr = r.u8() as u32;
            for i in 0..SERVOS {
                s.servo_out[i] = r.u8();
                s.servo_pin[i] = r.u8() as u32;
                s.servo_chan[i] = r.u8();
                s.servo_min_us[i] = r.u16();
                s.servo_max_us[i] = r.u16();
                s.servo_range[i] = r.f32();
                s.servo_start[i] = r.f32();
            }
        }
        if !s.is_valid() {
            return None;
        }
        Some(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Out(heapless::Vec<u8, 4096>);

    impl Out {
        fn new() -> Self {
            Out(heapless::Vec::new())
        }

        fn as_str(&self) -> &str {
            core::str::from_utf8(&self.0).unwrap()
        }
    }

    impl Sink for Out {
        fn write(&mut self, bytes: &[u8]) {
            self.0.extend_from_slice(bytes).unwrap();
        }
    }

    fn line(settings: &Settings, name: &str) -> Out {
        let mut out = Out::new();
        assert!(settings.format(name, &mut out), "{name} is unknown");
        out
    }

    const DEFAULT_LISTING: &str = "r_steps=10240\n\
        a_steps=14222.222\n\
        r_rate=560\n\
        a_rate=400\n\
        r_accel=50\n\
        a_accel=50\n\
        r_jerk=3\n\
        a_jerk=2\n\
        r_max=0\n\
        z_steps=10240\n\
        z_rate=560\n\
        z_accel=50\n\
        jog_z=120\n\
        jog_r=300\n\
        jog_a=200\n\
        dir_invert=0\n\
        en_invert=0\n\
        idle_ms=0\n\
        step_us=2\n\
        laser_hz=5000\n\
        s_max=1000\n\
        s_min=0\n\
        laser_invert=0\n\
        laser_ms=5000\n\
        tmc_r_ma=800\n\
        tmc_a_ma=800\n\
        tmc_hold_pct=50\n\
        tmc_r_micro=256\n\
        tmc_a_micro=256\n\
        tmc_z_ma=800\n\
        tmc_z_micro=256\n\
        tmc_stealth=1\n\
        h_axis=0\n\
        h_steps=6400\n\
        h_rate=600\n\
        h_accel=50\n\
        h_jerk=1\n\
        jog_h=120\n\
        probe_invert=0\n\
        tmc_h_ma=600\n\
        tmc_h_micro=256\n\
        probe_ms=20\n\
        z_jerk=3\n\
        z_max=0\n\
        cartesian=0\n\
        spindle=0\n\
        sockets=1234\n\
        laser_pin=20\n\
        probe_pin=25\n\
        tool_out=0\n\
        tool_pin=17\n\
        tool_invert=0\n\
        r_stop=0\n\
        r_stop_pin=4\n\
        r_home_pull=1\n\
        r_home_pos=0\n\
        r_home_travel=200\n\
        a_stop=0\n\
        a_stop_pin=3\n\
        a_home_pull=1\n\
        a_home_pos=0\n\
        a_home_travel=400\n\
        h_stop=0\n\
        h_stop_pin=16\n\
        h_home_pull=1\n\
        h_home_pos=0\n\
        h_home_travel=50\n\
        z_stop=0\n\
        z_stop_pin=22\n\
        z_home_pull=1\n\
        z_home_pos=0\n\
        z_home_travel=200\n\
        stop_invert=0\n\
        limits=0\n\
        dispenser=0\n\
        tmc_intpol=1\n\
        tmc_toff=3\n\
        tmc_tbl=2\n\
        tmc_hstrt=5\n\
        tmc_hend=0\n\
        tmc_hold_delay=10\n\
        tmc_tpowerdown=20\n\
        tmc_tpwmthrs=0\n\
        i2c_sda=0\n\
        i2c_scl=1\n\
        pca_addr=64\n\
        servo1_out=0\n\
        servo1_pin=29\n\
        servo1_chan=0\n\
        servo1_min_us=1000\n\
        servo1_max_us=2000\n\
        servo1_range=180\n\
        servo1_start=-1\n\
        servo2_out=0\n\
        servo2_pin=29\n\
        servo2_chan=1\n\
        servo2_min_us=1000\n\
        servo2_max_us=2000\n\
        servo2_range=180\n\
        servo2_start=-1\n\
        servo3_out=0\n\
        servo3_pin=29\n\
        servo3_chan=2\n\
        servo3_min_us=1000\n\
        servo3_max_us=2000\n\
        servo3_range=180\n\
        servo3_start=-1\n\
        servo4_out=0\n\
        servo4_pin=29\n\
        servo4_chan=3\n\
        servo4_min_us=1000\n\
        servo4_max_us=2000\n\
        servo4_range=180\n\
        servo4_start=-1\n";

    #[test]
    fn defaults_are_valid_and_listed_in_names_order() {
        let settings = Settings::default();
        assert!(settings.is_valid());
        let mut out = Out::new();
        settings.format_all(&mut out);
        assert_eq!(out.as_str(), DEFAULT_LISTING);
        let names: heapless::Vec<&str, 114> = out.as_str().lines().map(|l| l.split('=').next().unwrap()).collect();
        assert_eq!(names.as_slice(), &NAMES[..]);
    }

    #[test]
    fn format_one_and_unknown() {
        let settings = Settings::default();
        assert_eq!(line(&settings, "a_steps").as_str(), "a_steps=14222.222\n");
        assert_eq!(line(&settings, "A_STEPS").as_str(), "a_steps=14222.222\n");
        assert_eq!(line(&settings, "tmc_stealth").as_str(), "tmc_stealth=1\n");
        let mut out = Out::new();
        assert!(!settings.format("nope", &mut out));
        assert!(!settings.format("", &mut out));
        assert_eq!(out.as_str(), "");
    }

    #[test]
    fn every_name_is_settable_with_its_group() {
        // name, value to set, listed value, group
        let table: [(&str, &str, &str, Changed); 114] = [
            ("r_steps", "200.5", "200.5", Changed::Motion),
            ("a_steps", "888.8889", "888.889", Changed::Motion),
            ("r_rate", "1500", "1500", Changed::Motion),
            ("a_rate", "900.25", "900.25", Changed::Motion),
            ("r_accel", "75", "75", Changed::Motion),
            ("a_accel", "0.5", "0.5", Changed::Motion),
            ("r_jerk", "2", "2", Changed::Motion),
            ("a_jerk", "12.125", "12.125", Changed::Motion),
            ("r_max", "60", "60", Changed::Motion),
            ("z_steps", "640", "640", Changed::Motion),
            ("z_rate", "900", "900", Changed::Motion),
            ("z_accel", "25.5", "25.5", Changed::Motion),
            ("jog_z", "60", "60", Changed::Motion),
            ("jog_r", "300", "300", Changed::Motion),
            ("jog_a", "360", "360", Changed::Motion),
            ("dir_invert", "15", "15", Changed::Motion),
            ("en_invert", "1", "1", Changed::Motion),
            ("idle_ms", "30000", "30000", Changed::Motion),
            ("step_us", "5", "5", Changed::Motion),
            ("laser_hz", "20000", "20000", Changed::Laser),
            ("s_max", "255", "255", Changed::Laser),
            ("s_min", "10", "10", Changed::Laser),
            ("laser_invert", "1", "1", Changed::Laser),
            ("laser_ms", "60000", "60000", Changed::Laser),
            ("tmc_r_ma", "0", "0", Changed::Driver),
            ("tmc_a_ma", "2000", "2000", Changed::Driver),
            ("tmc_hold_pct", "100", "100", Changed::Driver),
            ("tmc_r_micro", "256", "256", Changed::Driver),
            ("tmc_a_micro", "1", "1", Changed::Driver),
            ("tmc_z_ma", "600", "600", Changed::Driver),
            ("tmc_z_micro", "16", "16", Changed::Driver),
            ("tmc_stealth", "0", "0", Changed::Driver),
            ("h_axis", "1", "1", Changed::Driver),
            ("h_steps", "1600", "1600", Changed::Motion),
            ("h_rate", "300", "300", Changed::Motion),
            ("h_accel", "20", "20", Changed::Motion),
            ("h_jerk", "0.5", "0.5", Changed::Motion),
            ("jog_h", "30", "30", Changed::Motion),
            ("probe_invert", "1", "1", Changed::Motion),
            ("tmc_h_ma", "400", "400", Changed::Driver),
            ("tmc_h_micro", "16", "16", Changed::Driver),
            ("probe_ms", "0", "0", Changed::Motion),
            ("z_jerk", "1.5", "1.5", Changed::Motion),
            ("z_max", "8", "8", Changed::Motion),
            ("cartesian", "1", "1", Changed::Kinematics),
            ("spindle", "1", "1", Changed::Tool),
            ("sockets", "1432", "1432", Changed::Driver),
            ("laser_pin", "23", "23", Changed::Other),
            ("probe_pin", "22", "22", Changed::Other),
            ("tool_out", "1", "1", Changed::Laser),
            ("tool_pin", "18", "18", Changed::Other),
            ("tool_invert", "1", "1", Changed::Laser),
            ("r_stop", "3", "3", Changed::Other),
            ("r_stop_pin", "22", "22", Changed::Other),
            ("r_home_pull", "2.5", "2.5", Changed::Other),
            ("r_home_pos", "-3", "-3", Changed::Other),
            ("r_home_travel", "150", "150", Changed::Other),
            ("a_stop", "1", "1", Changed::Other),
            ("a_stop_pin", "26", "26", Changed::Other),
            ("a_home_pull", "0.5", "0.5", Changed::Other),
            ("a_home_pos", "90", "90", Changed::Other),
            ("a_home_travel", "370", "370", Changed::Other),
            ("h_stop", "2", "2", Changed::Other),
            ("h_stop_pin", "27", "27", Changed::Other),
            ("h_home_pull", "1.25", "1.25", Changed::Other),
            ("h_home_pos", "15", "15", Changed::Other),
            ("h_home_travel", "40", "40", Changed::Other),
            ("z_stop", "0", "0", Changed::Other),
            ("z_stop_pin", "25", "25", Changed::Other),
            ("z_home_pull", "3", "3", Changed::Other),
            ("z_home_pos", "-20", "-20", Changed::Other),
            ("z_home_travel", "60", "60", Changed::Other),
            ("stop_invert", "15", "15", Changed::Other),
            ("limits", "9", "9", Changed::Other),
            ("dispenser", "1", "1", Changed::Tool),
            ("tmc_intpol", "0", "0", Changed::Driver),
            ("tmc_toff", "5", "5", Changed::Driver),
            ("tmc_tbl", "1", "1", Changed::Driver),
            ("tmc_hstrt", "4", "4", Changed::Driver),
            ("tmc_hend", "2", "2", Changed::Driver),
            ("tmc_hold_delay", "6", "6", Changed::Driver),
            ("tmc_tpowerdown", "128", "128", Changed::Driver),
            ("tmc_tpwmthrs", "234", "234", Changed::Driver),
            ("i2c_sda", "20", "20", Changed::Other),
            ("i2c_scl", "21", "21", Changed::Other),
            ("pca_addr", "65", "65", Changed::Other),
            ("servo1_out", "1", "1", Changed::Servo),
            ("servo1_pin", "24", "24", Changed::Servo),
            ("servo1_chan", "15", "15", Changed::Servo),
            ("servo1_min_us", "500", "500", Changed::Servo),
            ("servo1_max_us", "2500", "2500", Changed::Servo),
            ("servo1_range", "270", "270", Changed::Servo),
            ("servo1_start", "90.5", "90.5", Changed::Servo),
            ("servo2_out", "2", "2", Changed::Servo),
            ("servo2_pin", "0", "0", Changed::Servo),
            ("servo2_chan", "3", "3", Changed::Servo),
            ("servo2_min_us", "2000", "2000", Changed::Servo),
            ("servo2_max_us", "1000", "1000", Changed::Servo),
            ("servo2_range", "90", "90", Changed::Servo),
            ("servo2_start", "45", "45", Changed::Servo),
            ("servo3_out", "0", "0", Changed::Servo),
            ("servo3_pin", "26", "26", Changed::Servo),
            ("servo3_chan", "7", "7", Changed::Servo),
            ("servo3_min_us", "1100", "1100", Changed::Servo),
            ("servo3_max_us", "1900", "1900", Changed::Servo),
            ("servo3_range", "120.25", "120.25", Changed::Servo),
            ("servo3_start", "-1", "-1", Changed::Servo),
            ("servo4_out", "1", "1", Changed::Servo),
            ("servo4_pin", "1", "1", Changed::Servo),
            ("servo4_chan", "9", "9", Changed::Servo),
            ("servo4_min_us", "600", "600", Changed::Servo),
            ("servo4_max_us", "2400", "2400", Changed::Servo),
            ("servo4_range", "180", "180", Changed::Servo),
            ("servo4_start", "0", "0", Changed::Servo),
        ];
        let mut settings = Settings::default();
        for (i, (name, value, shown, group)) in table.iter().enumerate() {
            assert_eq!(*name, NAMES[i]);
            assert_eq!(settings.set(name, value), Ok(*group), "{name}");
            let mut want = heapless::String::<48>::new();
            want.push_str(name).unwrap();
            want.push_str("=").unwrap();
            want.push_str(shown).unwrap();
            want.push_str("\n").unwrap();
            assert_eq!(line(&settings, name).as_str(), want.as_str());
        }
        assert!(settings.is_valid());
        assert_eq!(settings.steps, [200.5, 888.8889, 1600.0, 640.0]);
        assert_eq!(settings.dir_invert, 15);
        assert!(settings.en_invert);
        assert_eq!(settings.tmc_micro, [256, 1, 16, 16]);
        assert_eq!(settings.jog_rate[Z], 60.0);
        assert_eq!(settings.max_rate[Z], 900.0);
        assert_eq!(settings.accel[Z], 25.5);
        assert_eq!(settings.jerk[Z], 1.5);
        assert_eq!(settings.tmc_ma[Z], 600);
        assert_eq!(settings.z_max, 8.0);
        assert!(settings.cartesian && settings.spindle && settings.dispenser);
        assert!(!settings.tmc_stealth);
        assert!(!settings.tmc_intpol);
        assert_eq!(
            [settings.tmc_toff, settings.tmc_tbl, settings.tmc_hstrt, settings.tmc_hend, settings.tmc_hold_delay, settings.tmc_tpowerdown],
            [5, 1, 4, 2, 6, 128]
        );
        assert_eq!(settings.tmc_tpwmthrs, 234);
        assert_eq!((settings.i2c_sda, settings.i2c_scl, settings.pca_addr), (20, 21, 65));
        assert_eq!(settings.servo_out, [SERVO_PIN, SERVO_PCA, SERVO_NONE, SERVO_PIN]);
        assert_eq!(settings.servo_pin, [24, 0, 26, 1]);
        assert_eq!(settings.servo_chan, [15, 3, 7, 9]);
        assert_eq!(settings.servo_min_us, [500, 2000, 1100, 600]);
        assert_eq!(settings.servo_max_us, [2500, 1000, 1900, 2400]);
        assert_eq!(settings.servo_range, [270.0, 90.0, 120.25, 180.0]);
        assert_eq!(settings.servo_start, [90.5, 45.0, -1.0, 0.0]);
    }

    #[test]
    fn names_are_case_insensitive_on_set() {
        let mut settings = Settings::default();
        assert_eq!(settings.set("R_MAX", "12.5"), Ok(Changed::Motion));
        assert_eq!(settings.set("Laser_Hz", "1000"), Ok(Changed::Laser));
        assert_eq!(settings.set("TMC_STEALTH", "0"), Ok(Changed::Driver));
        assert_eq!(settings.r_max, 12.5);
        assert_eq!(settings.laser_hz, 1000);
        assert!(!settings.tmc_stealth);
    }

    #[test]
    fn unknown_names_are_rejected() {
        let mut settings = Settings::default();
        assert_eq!(settings.set("r_stepz", "1"), Err(SetError::Unknown));
        assert_eq!(settings.set("", "1"), Err(SetError::Unknown));
        assert_eq!(settings.set("r_steps ", "1"), Err(SetError::Unknown));
        assert_eq!(settings, Settings::default());
    }

    fn rejects(name: &str, value: &str) {
        let mut settings = Settings::default();
        let before = settings;
        assert_eq!(settings.set(name, value), Err(SetError::BadValue), "{name}={value}");
        assert_eq!(settings, before, "{name}={value} changed something");
    }

    fn accepts(name: &str, value: &str) {
        let mut settings = Settings::default();
        assert!(settings.set(name, value).is_ok(), "{name}={value}");
    }

    #[test]
    fn bad_numbers_are_rejected() {
        rejects("r_steps", "");
        rejects("r_steps", "abc");
        rejects("r_steps", "1e3");
        rejects("r_steps", "1.2.3");
        rejects("r_steps", "12 ");
        rejects("r_steps", "nan");
        rejects("r_steps", "inf");
        rejects("laser_hz", "5000.0");
        rejects("laser_hz", "-5000");
        rejects("laser_hz", "+5000");
        rejects("idle_ms", "4294967296");
        rejects("idle_ms", "x");
        rejects("dir_invert", "256");
        rejects("en_invert", "2");
        rejects("en_invert", "true");
        rejects("en_invert", "");
    }

    #[test]
    fn ranges_are_enforced() {
        for name in [
            "r_steps", "a_steps", "r_rate", "a_rate", "r_accel", "a_accel", "r_jerk", "a_jerk",
            "z_steps", "z_rate", "z_accel", "z_jerk", "jog_z", "jog_r", "jog_a", "s_max",
        ] {
            rejects(name, "0");
            rejects(name, "-1");
            rejects(name, "10000001");
            accepts(name, "0.001");
            accepts(name, "10000000");
        }
        rejects("r_max", "-0.5");
        accepts("r_max", "0");
        accepts("r_max", "0.0");
        rejects("z_max", "-1");
        accepts("z_max", "0");
        rejects("cartesian", "2");
        rejects("spindle", "0.5");
        rejects("dispenser", "2");
        rejects("dir_invert", "16");
        rejects("h_steps", "0");
        rejects("h_axis", "2");
        rejects("tmc_h_micro", "3");
        rejects("probe_ms", "161");
        rejects("probe_ms", "-10");
        accepts("probe_ms", "160");
        accepts("probe_ms", "15");
        accepts("dir_invert", "0");
        accepts("dir_invert", "7");
        accepts("idle_ms", "0");
        accepts("idle_ms", "4294967295");
        rejects("step_us", "0");
        rejects("step_us", "21");
        accepts("step_us", "1");
        accepts("step_us", "20");
        rejects("laser_hz", "99");
        rejects("laser_hz", "100001");
        accepts("laser_hz", "100");
        accepts("laser_hz", "100000");
        rejects("s_min", "-1");
        rejects("s_min", "1000.5");
        accepts("s_min", "0");
        accepts("s_min", "1000");
        rejects("laser_ms", "0");
        rejects("laser_ms", "60001");
        accepts("laser_ms", "1");
        for name in ["tmc_r_ma", "tmc_a_ma", "tmc_z_ma"] {
            rejects(name, "2001");
            accepts(name, "0");
            accepts(name, "2000");
        }
        rejects("tmc_hold_pct", "101");
        accepts("tmc_hold_pct", "0");
        for name in ["tmc_r_micro", "tmc_a_micro", "tmc_z_micro"] {
            for bad in ["0", "3", "12", "512", "255"] {
                rejects(name, bad);
            }
            for good in ["1", "2", "4", "8", "16", "32", "64", "128", "256"] {
                accepts(name, good);
            }
        }
        rejects("tmc_stealth", "2");
        rejects("laser_invert", "-1");
    }

    #[test]
    fn s_min_and_s_max_keep_their_order() {
        let mut settings = Settings::default();
        assert_eq!(settings.set("s_min", "600"), Ok(Changed::Laser));
        assert_eq!(settings.set("s_max", "500"), Err(SetError::BadValue));
        assert_eq!(settings.s_max, 1000.0);
        assert_eq!(settings.set("s_max", "600"), Ok(Changed::Laser));
        assert_eq!(settings.set("s_min", "600.001"), Err(SetError::BadValue));
    }

    #[test]
    fn crc32_check_value() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        assert_eq!(crc32(b""), 0);
    }

    #[test]
    fn blob_round_trip() {
        let mut settings = Settings::default();
        settings.set("a_steps", "888.8889").unwrap();
        settings.set("r_max", "55.5").unwrap();
        settings.set("z_steps", "1280").unwrap();
        settings.set("z_rate", "240").unwrap();
        settings.set("z_accel", "12.5").unwrap();
        settings.set("jog_z", "90").unwrap();
        settings.set("tmc_z_ma", "450").unwrap();
        settings.set("tmc_z_micro", "64").unwrap();
        settings.set("dir_invert", "6").unwrap();
        settings.set("en_invert", "1").unwrap();
        settings.set("idle_ms", "120000").unwrap();
        settings.set("laser_hz", "20000").unwrap();
        settings.set("s_min", "25").unwrap();
        settings.set("laser_invert", "1").unwrap();
        settings.set("tmc_a_ma", "1200").unwrap();
        settings.set("tmc_r_micro", "32").unwrap();
        settings.set("tmc_stealth", "0").unwrap();
        settings.set("z_jerk", "0.75").unwrap();
        settings.set("z_max", "12").unwrap();
        settings.set("cartesian", "1").unwrap();
        settings.set("spindle", "1").unwrap();

        let mut blob = [0xAAu8; BLOB_LEN];
        settings.to_blob(&mut blob);
        assert_eq!(&blob[..4], b"SPNY");
        assert_eq!(blob[4], BLOB_VERSION);
        assert!(blob[HEADER_LEN + FIELDS_LEN..CRC_OFFSET].iter().all(|&b| b == 0));
        assert_eq!(Settings::from_blob(&blob), Some(settings));

        let defaults = Settings::default();
        let mut blob = [0u8; BLOB_LEN];
        defaults.to_blob(&mut blob);
        assert_eq!(Settings::from_blob(&blob), Some(defaults));

        let mut longer = [0x55u8; BLOB_LEN + 16];
        longer[..BLOB_LEN].copy_from_slice(&blob);
        assert_eq!(Settings::from_blob(&longer), Some(defaults));
    }

    #[test]
    fn blob_stores_fields_little_endian() {
        let settings = Settings::default();
        let mut blob = [0u8; BLOB_LEN];
        settings.to_blob(&mut blob);
        let r_steps = f32::from_le_bytes(blob[HEADER_LEN..HEADER_LEN + 4].try_into().unwrap());
        assert_eq!(r_steps, 10240.0);
        let crc = u32::from_le_bytes(blob[CRC_OFFSET..].try_into().unwrap());
        assert_eq!(crc, crc32(&blob[..CRC_OFFSET]));
    }

    #[test]
    fn corrupted_blobs_are_rejected() {
        let settings = Settings::default();
        let mut good = [0u8; BLOB_LEN];
        settings.to_blob(&mut good);

        let mut bad = good;
        bad[HEADER_LEN + 2] ^= 0x01;
        assert_eq!(Settings::from_blob(&bad), None);

        let mut bad = good;
        bad[CRC_OFFSET] ^= 0xFF;
        assert_eq!(Settings::from_blob(&bad), None);

        let mut bad = good;
        bad[CRC_OFFSET - 1] = 1;
        assert_eq!(Settings::from_blob(&bad), None);

        let mut bad = good;
        bad[0] = b'X';
        assert_eq!(Settings::from_blob(&bad), None);

        let mut bad = good;
        bad[4] = BLOB_VERSION + 1;
        assert_eq!(Settings::from_blob(&bad), None);

        assert_eq!(Settings::from_blob(&good[..BLOB_LEN - 1]), None);
        assert_eq!(Settings::from_blob(&[]), None);
        assert_eq!(Settings::from_blob(&[0xFF; BLOB_LEN]), None);
    }

    #[test]
    fn blob_with_out_of_range_field_is_rejected() {
        let mut settings = Settings::default();
        settings.steps[R] = 0.0;
        let mut blob = [0u8; BLOB_LEN];
        settings.to_blob(&mut blob);
        assert_eq!(Settings::from_blob(&blob), None);

        let mut settings = Settings::default();
        settings.tmc_micro[A] = 3;
        settings.to_blob(&mut blob);
        assert_eq!(Settings::from_blob(&blob), None);

        // A flag byte that is neither 0 nor 1, behind a matching CRC.
        let mut blob = [0u8; BLOB_LEN];
        Settings::default().to_blob(&mut blob);
        let en_invert_at = HEADER_LEN + 4 * (4 * 3 + 1 + 4 + 3) + 1;
        blob[en_invert_at] = 2;
        let crc = crc32(&blob[..CRC_OFFSET]);
        blob[CRC_OFFSET..].copy_from_slice(&crc.to_le_bytes());
        assert_eq!(Settings::from_blob(&blob), None);
    }

    #[test]
    fn a_blob_from_an_older_layout_is_not_read_as_this_one() {
        // Version 1 had no cross slide fields, so every field after the
        // radius limit sat four words earlier. Read as this layout it
        // would pass its CRC and hand back rates and currents that were
        // never stored.
        let mut blob = [0u8; BLOB_LEN];
        Settings::default().to_blob(&mut blob);
        blob[MAGIC.len()] = 1;
        let crc = crc32(&blob[..CRC_OFFSET]);
        blob[CRC_OFFSET..].copy_from_slice(&crc.to_le_bytes());
        assert_eq!(Settings::from_blob(&blob), None);
    }

    /// `stored` as the firmware of an older `version` wrote it, in the old,
    /// shorter blob: this layout's bytes up to `keep`, zeros after them, and
    /// the CRC in the old blob's last four bytes. The fields of every
    /// version are a prefix of this layout, so up to that version's own
    /// fields the bytes are the ones it wrote.
    fn old_blob(stored: &Settings, version: u8, keep: usize) -> [u8; OLD_BLOB_LEN] {
        assert!(version < LONG_BLOB_VERSION && keep <= OLD_CRC_OFFSET);
        let mut long = [0u8; BLOB_LEN];
        stored.to_blob(&mut long);
        let mut blob = [0u8; OLD_BLOB_LEN];
        blob[..keep].copy_from_slice(&long[..keep]);
        blob[MAGIC.len()] = version;
        let crc = crc32(&blob[..OLD_CRC_OFFSET]);
        blob[OLD_CRC_OFFSET..].copy_from_slice(&crc.to_le_bytes());
        blob
    }

    #[test]
    fn a_version_4_blob_is_read_with_the_new_fields_at_their_defaults() {
        // Version 4 is this layout without the fields appended since.
        let mut stored = Settings::default();
        stored.set("z_steps", "1280").unwrap();
        stored.set("tmc_z_micro", "64").unwrap();
        stored.set("probe_ms", "40").unwrap();
        stored.set("z_jerk", "0.5").unwrap();
        stored.set("cartesian", "1").unwrap();
        let blob = old_blob(&stored, 4, HEADER_LEN + PREFIX_LEN);
        let read = Settings::from_blob(&blob).expect("a version 4 blob is read");
        assert_eq!(read.steps[Z], 1280.0);
        assert_eq!(read.tmc_micro[Z], 64);
        assert_eq!(read.probe_ms, 40);
        assert_eq!(read.jerk[Z], Settings::default().jerk[Z]);
        assert!(!read.cartesian && !read.spindle);
        assert_eq!(read.z_max, 0.0);
    }

    #[test]
    fn a_version_5_blob_is_read_with_the_sockets_as_labeled() {
        let stored = Settings { z_max: 4.0, cartesian: true, sockets: 4321, ..Settings::default() };
        let blob = old_blob(&stored, 5, OLD_CRC_OFFSET);
        let read = Settings::from_blob(&blob).expect("a version 5 blob is read");
        assert_eq!(read, Settings { sockets: SOCKETS_DEFAULT, ..stored });
    }

    #[test]
    fn pins_are_free_gpios_of_the_board() {
        for name in ["laser_pin", "probe_pin", "tool_pin"] {
            for bad in ["30", "2", "8", "9", "19", "28", "-1", "1.5", ""] {
                rejects(name, bad);
            }
            for good in ["0", "17", "20", "22", "25", "29"] {
                accepts(name, good);
            }
        }
        // Two settings on one pin are the file's to refuse: the firmware
        // takes them one at a time, so a swap would never go through.
        let mut settings = Settings::default();
        assert_eq!(settings.set("probe_pin", "20"), Ok(Changed::Other));
        assert!(settings.is_valid());
        let mut stored = Settings { laser_pin: 2, ..Settings::default() };
        let mut blob = [0u8; BLOB_LEN];
        stored.to_blob(&mut blob);
        assert_eq!(Settings::from_blob(&blob), None, "a stored socket pin is thrown away");
        stored.laser_pin = 23;
        stored.to_blob(&mut blob);
        assert_eq!(Settings::from_blob(&blob), Some(stored));
    }

    #[test]
    fn sockets_name_each_socket_once() {
        for bad in ["0", "123", "12345", "1123", "1235", "0123", "1204", "12.34", "-1234"] {
            rejects("sockets", bad);
        }
        for good in ["1234", "4321", "1423", "2143"] {
            accepts("sockets", good);
        }
    }

    #[test]
    fn each_joint_finds_its_socket_by_digit_place() {
        let labeled = Settings::default();
        assert_eq!([R, A, Z, H].map(|j| labeled.socket_of(j)), [0, 1, 2, 3]);
        // A three axis mill: radius on X, cross slide on Y, focus axis on
        // Z, the table on E.
        let mill = Settings { sockets: 1423, ..Settings::default() };
        assert_eq!([R, A, Z, H].map(|j| mill.socket_of(j)), [0, 3, 1, 2]);
    }

    /// A version 4 blob as the firmware before the cross slide joint and
    /// the spindle wrote it, with a distinct value in every field.
    const VERSION_4_BLOB: [u8; OLD_BLOB_LEN] = [
            0x53, 0x50, 0x4e, 0x59, 0x04, 0x00, 0x00, 0xa0, 0x45, 0x00, 0x3c, 0xde, 0x45, 0x00, 0x00, 0x48,
            0x45, 0x00, 0x00, 0x61, 0x44, 0x00, 0x00, 0x7a, 0x44, 0x00, 0x00, 0x96, 0x43, 0x00, 0x00, 0x20,
            0x42, 0x00, 0x00, 0x34, 0x42, 0x00, 0x00, 0xf0, 0x41, 0x00, 0x00, 0x20, 0x40, 0x00, 0x00, 0xf0,
            0x40, 0x00, 0x00, 0x00, 0x3f, 0x00, 0x00, 0x70, 0x42, 0x00, 0x00, 0xa0, 0x44, 0x00, 0x00, 0xf0,
            0x42, 0x00, 0x00, 0xa0, 0x41, 0x00, 0x00, 0xb4, 0x42, 0x00, 0x00, 0xe1, 0x43, 0x00, 0x00, 0x07,
            0x44, 0x00, 0x00, 0x16, 0x43, 0x0d, 0x01, 0xc4, 0x09, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0xd0,
            0x07, 0x00, 0x00, 0x00, 0x00, 0x61, 0x44, 0x00, 0x00, 0x40, 0x41, 0x01, 0x58, 0x1b, 0x00, 0x00,
            0xbc, 0x02, 0x00, 0x00, 0xee, 0x02, 0x00, 0x00, 0xc2, 0x01, 0x00, 0x00, 0x28, 0x00, 0x00, 0x00,
            0x20, 0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00, 0x80, 0x00, 0x00, 0x00, 0x26, 0x02, 0x00, 0x00,
            0x08, 0x00, 0x00, 0x00, 0x01, 0x01, 0x01, 0x3c, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x38, 0x18, 0xd7, 0xe8,
        ];

    /// The values stored in `VERSION_4_BLOB`, as `$` lists them.
    const VERSION_4_VALUES: [(&str, &str); 42] = [
        ("r_steps", "5120"), ("a_steps", "7111.5"), ("r_rate", "900"), ("a_rate", "1000"),
        ("r_accel", "40"), ("a_accel", "45"), ("r_jerk", "2.5"), ("a_jerk", "7.5"),
        ("r_max", "60"), ("z_steps", "1280"), ("z_rate", "120"), ("z_accel", "20"),
        ("jog_z", "90"), ("jog_r", "450"), ("jog_a", "540"), ("dir_invert", "13"),
        ("en_invert", "1"), ("idle_ms", "2500"), ("step_us", "3"), ("laser_hz", "2000"),
        ("s_max", "900"), ("s_min", "12"), ("laser_invert", "1"), ("laser_ms", "7000"),
        ("tmc_r_ma", "700"), ("tmc_a_ma", "750"), ("tmc_hold_pct", "40"), ("tmc_r_micro", "32"),
        ("tmc_a_micro", "64"), ("tmc_z_ma", "550"), ("tmc_z_micro", "8"), ("tmc_stealth", "1"),
        ("h_axis", "1"), ("h_steps", "3200"), ("h_rate", "300"), ("h_accel", "30"),
        ("h_jerk", "0.5"), ("jog_h", "150"), ("probe_invert", "1"), ("tmc_h_ma", "450"),
        ("tmc_h_micro", "128"), ("probe_ms", "60"),
    ];

    #[test]
    fn a_blob_written_by_the_version_4_firmware_reads_back_field_by_field() {
        // Built by that firmware's own writer, so a change to the prefix
        // layout here that the writer and reader make together still shows.
        let read = Settings::from_blob(&VERSION_4_BLOB).expect("a version 4 blob is read");
        for (name, value) in VERSION_4_VALUES {
            let listed = line(&read, name);
            let read_value = listed.as_str().strip_prefix(name).and_then(|rest| rest.strip_prefix('=')).map(str::trim_end);
            assert_eq!(read_value, Some(value), "{name}");
        }
        let defaults = Settings::default();
        for name in ["z_jerk", "z_max", "cartesian", "spindle", "sockets", "laser_pin", "probe_pin", "tool_out", "tool_pin", "tool_invert", "dispenser"]
            .into_iter()
            .chain(NAMES[TUNING_NAMES_AT..].iter().copied())
        {
            assert_eq!(line(&read, name).as_str(), line(&defaults, name).as_str(), "{name} came after version 4");
        }
    }

    #[test]
    fn the_cross_slide_fields_fit_the_blob() {
        const { assert!(HEADER_LEN + FIELDS_LEN <= CRC_OFFSET, "the fields run into the CRC") };
        let mut blob = [0u8; BLOB_LEN];
        Settings::default().to_blob(&mut blob);
        // Every field lands where the writer says it does: the stealth
        // flag, the focus axis and probe flags, then the probe queue time,
        // at the end of the version 4 fields.
        let end = HEADER_LEN + PREFIX_LEN;
        assert_eq!(blob[end - 7], 1);
        assert_eq!(blob[end - 6..end - 4], [0, 0]);
        assert_eq!(blob[end - 4..end], 20u32.to_le_bytes());
        let focus = Settings { h_axis: true, probe_invert: true, probe_ms: 160, ..Settings::default() };
        focus.to_blob(&mut blob);
        assert_eq!(blob[end - 6..end - 4], [1, 1]);
        assert_eq!(blob[end - 4..end], 160u32.to_le_bytes());
        assert_eq!(Settings::from_blob(&blob), Some(focus));
        // Then the cross slide's jerk and limit, the two mode flags and
        // the sockets, then the pins and the tool output, then the
        // endstops, the dispenser flag and the drivers' tuning.
        let modes = Settings {
            z_max: 9.5, cartesian: true, spindle: true, sockets: 1423,
            laser_pin: 23, probe_pin: 22, tool_out: true, tool_pin: 18, tool_invert: true,
            ..Settings::default()
        };
        modes.to_blob(&mut blob);
        let tail = HEADER_LEN + FIELDS_LEN;
        let pins = HEADER_LEN + OLD_FIELDS_LEN - TUNING_LEN - 1 - STOPS_LEN - PINS_LEN;
        assert_eq!(blob[end..end + 4], 3.0f32.to_le_bytes());
        assert_eq!(blob[end + 4..end + 8], 9.5f32.to_le_bytes());
        assert_eq!(blob[pins - 6..pins - 4], [1, 1]);
        assert_eq!(blob[pins - 4..pins], 1423u32.to_le_bytes());
        assert_eq!(blob[pins..pins + 4], 23u32.to_le_bytes());
        assert_eq!(blob[pins + 4..pins + 8], 22u32.to_le_bytes());
        assert_eq!(blob[pins + 8], 1);
        assert_eq!(blob[pins + 9..pins + 13], 18u32.to_le_bytes());
        assert_eq!(blob[pins + 13], 1);
        assert!(blob[tail..CRC_OFFSET].iter().all(|&b| b == 0));
        assert_eq!(Settings::from_blob(&blob), Some(modes));
    }

    #[test]
    fn the_endstop_fields_are_checked_and_round_trip_the_blob() {
        let mut settings = Settings::default();
        for (name, bad, good) in [
            ("r_stop", "4", "3"),
            ("a_stop_pin", "28", "26"),
            ("h_home_pull", "0", "0.1"),
            ("z_home_pos", "100000000", "-9999999"),
            ("r_home_travel", "-1", "500"),
            ("stop_invert", "16", "15"),
            ("limits", "16", "0"),
        ] {
            assert_eq!(settings.set(name, bad), Err(SetError::BadValue), "{name}={bad}");
            assert_eq!(settings.set(name, good), Ok(Changed::Other), "{name}={good}");
        }
        settings.set("a_stop", "1").unwrap();
        settings.set("h_stop", "2").unwrap();
        assert_eq!(settings.stop_mask(), 1 << R | 1 << A | 1 << H);
        assert!(settings.has_min_stop(R) && settings.has_max_stop(R));
        assert!(settings.has_min_stop(A) && !settings.has_max_stop(A));
        assert!(!settings.has_min_stop(H) && settings.has_max_stop(H));
        // The masks follow the dir_invert bit order into the joint order,
        // and the limits leave out a joint with no switch.
        assert_eq!(settings.joint_stop_invert(), 0b1111);
        settings.set("stop_invert", "8").unwrap();
        assert_eq!(settings.joint_stop_invert(), 1 << H, "bit 3 is the focus axis");
        settings.set("stop_invert", "4").unwrap();
        assert_eq!(settings.joint_stop_invert(), 1 << Z, "bit 2 is the cross slide");
        settings.set("limits", "15").unwrap();
        assert_eq!(settings.joint_limits(), 1 << R | 1 << A | 1 << H);
        let mut blob = [0u8; BLOB_LEN];
        settings.to_blob(&mut blob);
        assert_eq!(Settings::from_blob(&blob), Some(settings));
        // A version 7 blob reads with the endstops at their defaults.
        let older = Settings::default();
        assert_eq!(Settings::from_blob(&old_blob(&older, 7, OLD_CRC_OFFSET)), Some(older));
        assert_eq!(Settings::from_blob(&old_blob(&settings, 7, OLD_CRC_OFFSET)), Some(older));
    }

    #[test]
    fn the_dispenser_flag_the_drivers_tuning_the_bus_and_the_servos_are_listed_last() {
        let mut out = Out::new();
        Settings::default().format_all(&mut out);
        let lines: heapless::Vec<&str, 114> = out.as_str().lines().collect();
        assert_eq!(lines.len(), NAMES.len());
        assert_eq!(NAMES.len(), 114);
        assert_eq!(lines[TUNING_NAMES_AT - 1], "dispenser=0");
        assert_eq!(
            lines[TUNING_NAMES_AT..BUS_NAMES_AT],
            ["tmc_intpol=1", "tmc_toff=3", "tmc_tbl=2", "tmc_hstrt=5", "tmc_hend=0", "tmc_hold_delay=10", "tmc_tpowerdown=20", "tmc_tpwmthrs=0"]
        );
        assert_eq!(lines[BUS_NAMES_AT..SERVO_NAMES_AT], ["i2c_sda=0", "i2c_scl=1", "pca_addr=64"]);
        assert_eq!(
            lines[SERVO_NAMES_AT + 2 * SERVO_NAMES_PER_SERVO..SERVO_NAMES_AT + 3 * SERVO_NAMES_PER_SERVO],
            ["servo3_out=0", "servo3_pin=29", "servo3_chan=2", "servo3_min_us=1000", "servo3_max_us=2000", "servo3_range=180", "servo3_start=-1"]
        );
    }

    #[test]
    fn the_dispenser_flag_round_trips_the_blob() {
        let mut settings = Settings::default();
        assert_eq!(settings.set("dispenser", "1"), Ok(Changed::Tool));
        assert!(!settings.dispensing(), "the flag acts only on a cartesian machine");
        settings.set("cartesian", "1").unwrap();
        assert!(settings.dispensing());
        let mut blob = [0u8; BLOB_LEN];
        settings.to_blob(&mut blob);
        assert_eq!(blob[HEADER_LEN + OLD_FIELDS_LEN - TUNING_LEN - 1], 1, "just before the drivers' tuning");
        assert_eq!(Settings::from_blob(&blob), Some(settings));
    }

    /// The drivers' tuning with no field at its default, TPWMTHRS at its
    /// largest so all three of its bytes are used.
    fn tuned() -> Settings {
        Settings {
            tmc_intpol: false,
            tmc_toff: 15,
            tmc_tbl: 1,
            tmc_hstrt: 7,
            tmc_hend: 11,
            tmc_hold_delay: 0,
            tmc_tpowerdown: 255,
            tmc_tpwmthrs: TPWMTHRS_MAX,
            ..Settings::default()
        }
    }

    #[test]
    fn the_drivers_tuning_takes_each_register_fields_range() {
        // TMC2209 datasheet Rev 1.09: TOFF, HEND and IHOLDDELAY are 4 bits,
        // HSTRT 3, TBL 2, TPOWERDOWN 8 and TPWMTHRS 20; TOFF 0 switches
        // the driver off.
        for (name, low, high, over) in [
            ("tmc_toff", "1", "15", "16"),
            ("tmc_tbl", "0", "3", "4"),
            ("tmc_hstrt", "0", "7", "8"),
            ("tmc_hend", "0", "15", "16"),
            ("tmc_hold_delay", "0", "15", "16"),
            ("tmc_tpowerdown", "0", "255", "256"),
            ("tmc_tpwmthrs", "0", "1048575", "1048576"),
        ] {
            accepts(name, low);
            accepts(name, high);
            rejects(name, over);
            rejects(name, "-1");
            rejects(name, "2.5");
        }
        rejects("tmc_toff", "0");
        rejects("tmc_intpol", "2");
        accepts("tmc_intpol", "0");
        // Two fields together are the machine file's to judge: TOFF 1 with
        // a short blank time, and a hysteresis past what the datasheet
        // allows, still pass one at a time.
        let mut settings = Settings::default();
        assert_eq!(settings.set("tmc_tbl", "0"), Ok(Changed::Driver));
        assert_eq!(settings.set("tmc_toff", "1"), Ok(Changed::Driver));
        assert_eq!(settings.set("tmc_hstrt", "7"), Ok(Changed::Driver));
        assert_eq!(settings.set("tmc_hend", "15"), Ok(Changed::Driver));
        assert!(settings.is_valid());
    }

    #[test]
    fn the_drivers_tuning_fills_the_old_blob_up_to_its_crc() {
        let settings = tuned();
        let mut blob = [0u8; BLOB_LEN];
        settings.to_blob(&mut blob);
        assert_eq!(HEADER_LEN + OLD_FIELDS_LEN, OLD_CRC_OFFSET, "no padding was left");
        let at = OLD_CRC_OFFSET - TUNING_LEN;
        assert_eq!(blob[at..OLD_CRC_OFFSET], [0, 15, 1, 7, 11, 0, 255, 0xff, 0xff, 0x0f]);
        assert_eq!(Settings::from_blob(&blob), Some(settings));
        let defaults = Settings::default();
        defaults.to_blob(&mut blob);
        assert_eq!(blob[at..OLD_CRC_OFFSET], [1, 3, 2, 5, 0, 10, 20, 0, 0, 0]);
        let middling = Settings { tmc_tpwmthrs: 0x0001_0203, ..Settings::default() };
        middling.to_blob(&mut blob);
        assert_eq!(blob[OLD_CRC_OFFSET - 3..OLD_CRC_OFFSET], [0x03, 0x02, 0x01], "little-endian");
        assert_eq!(Settings::from_blob(&blob), Some(middling));
    }

    #[test]
    fn a_stored_tuning_out_of_range_is_thrown_away() {
        let mut blob = [0u8; BLOB_LEN];
        for stored in [
            Settings { tmc_toff: 0, ..Settings::default() },
            Settings { tmc_tbl: 4, ..Settings::default() },
            Settings { tmc_hend: 16, ..Settings::default() },
            Settings { tmc_tpwmthrs: TPWMTHRS_MAX + 1, ..Settings::default() },
        ] {
            stored.to_blob(&mut blob);
            assert_eq!(Settings::from_blob(&blob), None, "{stored:?}");
        }
        // The interpolation flag is a flag byte like the others.
        Settings::default().to_blob(&mut blob);
        blob[OLD_CRC_OFFSET - TUNING_LEN] = 2;
        let crc = crc32(&blob[..CRC_OFFSET]);
        blob[CRC_OFFSET..].copy_from_slice(&crc.to_le_bytes());
        assert_eq!(Settings::from_blob(&blob), None);
    }

    #[test]
    fn a_version_9_blob_is_read_with_the_drivers_tuning_at_its_defaults() {
        // Version 9 is this layout without the tuning appended after the
        // dispenser flag. Its firmware left zeros there, which read as
        // this layout would be TOFF 0 and throw the whole blob away, and
        // with it the wiring; a stale tuning is not read either.
        let stored = Settings { cartesian: true, dispenser: true, laser_invert: true, ..tuned() };
        let kept = Settings { cartesian: true, dispenser: true, laser_invert: true, ..Settings::default() };
        for padding in [false, true] {
            let keep = if padding { OLD_CRC_OFFSET - TUNING_LEN } else { OLD_CRC_OFFSET };
            let blob = old_blob(&stored, 9, keep);
            assert_eq!(Settings::from_blob(&blob), Some(kept), "zero padding: {padding}");
        }
    }

    #[test]
    fn a_version_8_blob_is_read_with_the_dispenser_off() {
        // Version 8 is this layout without the flag appended after the
        // endstops: a stale byte there is not read as the flag.
        let stored = Settings { cartesian: true, dispenser: true, ..Settings::default() };
        let blob = old_blob(&stored, 8, OLD_CRC_OFFSET);
        let read = Settings::from_blob(&blob).expect("a version 8 blob is read");
        assert!(read.cartesian && !read.dispenser);
        assert_eq!(read, Settings { cartesian: true, ..Settings::default() });
    }

    #[test]
    fn the_focus_axis_and_cross_slide_bits_trade_places() {
        let mut settings = Settings { dir_invert: 0b0100, ..Settings::default() };
        assert_eq!(settings.joint_dir_invert(), 1 << Z, "bit 2 is the cross slide");
        settings.dir_invert = 0b1011;
        assert_eq!(settings.joint_dir_invert(), 0b0111);
        settings.dir_invert = 0b1000;
        assert_eq!(settings.joint_dir_invert(), 1 << H);
        settings.dir_invert = 0b1111;
        assert_eq!(settings.joint_dir_invert(), 0b1111);
    }

    /// Every servo and bus setting away from its default.
    fn servos() -> Settings {
        Settings {
            i2c_sda: 20,
            i2c_scl: 21,
            pca_addr: 0x7F,
            servo_out: [SERVO_PIN, SERVO_PCA, SERVO_NONE, SERVO_PCA],
            servo_pin: [24, 0, 27, 1],
            servo_chan: [15, 4, 9, 0],
            servo_min_us: [500, 2400, 200, 3000],
            servo_max_us: [2500, 600, 3000, 1000],
            servo_range: [270.0, 90.0, 0.5, 360.0],
            servo_start: [135.5, -1.0, 0.0, 360.0],
            ..Settings::default()
        }
    }

    #[test]
    fn the_servo_and_bus_settings_take_their_bounds() {
        for (name, low, high, outside) in [
            ("servo1_out", "0", "2", ["3", "-1", "1.5"]),
            ("servo2_chan", "0", "15", ["16", "-1", "2.5"]),
            ("servo3_min_us", "200", "3000", ["199", "3001", "1500.5"]),
            ("servo4_max_us", "200", "3000", ["0", "65536", "x"]),
            ("servo1_range", "0.001", "360", ["0", "360.01", "-90"]),
            ("servo2_start", "-1", "360", ["-1.01", "360.5", "nan"]),
            ("pca_addr", "64", "127", ["63", "128", "0"]),
        ] {
            accepts(name, low);
            accepts(name, high);
            for value in outside {
                rejects(name, value);
            }
        }
        // A servo's pin is any free GPIO but a STOP header's, which a
        // buffer drives.
        for bad in ["30", "2", "19", "28", "-1", "3", "4", "16", "25"] {
            rejects("servo1_pin", bad);
        }
        for good in ["29", "24", "0", "17", "22"] {
            accepts("servo4_pin", good);
        }
        // The bus's data line is on an even pin and its clock on an odd
        // one; whether the two are of one block is the file's to judge.
        for (name, good, bad) in [
            ("i2c_sda", ["0", "20", "24", "26"], ["1", "17", "8", "30", "16", "4"]),
            ("i2c_scl", ["1", "17", "21", "27"], ["0", "20", "9", "29.5", "25", "3"]),
        ] {
            for value in good {
                accepts(name, value);
            }
            for value in bad {
                rejects(name, value);
            }
        }
        let mut settings = Settings::default();
        assert_eq!(settings.set("i2c_sda", "18"), Ok(Changed::Other));
        assert_eq!(i2c_block(settings.i2c_sda), 1);
        assert_eq!(i2c_block(settings.i2c_scl), 0, "one block's data with the other's clock is taken");
        // A start past the range is held to it when used: the range may
        // come second in a file that widens both.
        assert_eq!(settings.set("servo1_start", "270"), Ok(Changed::Servo));
        assert_eq!(settings.servo_start_angle(0), Some(180.0));
        assert_eq!(settings.set("servo1_range", "270"), Ok(Changed::Servo));
        assert_eq!(settings.servo_start_angle(0), Some(270.0));
    }

    #[test]
    fn a_servos_pulse_is_a_line_from_its_shortest_to_its_longest() {
        let settings = Settings::default();
        assert_eq!(settings.servo_pulse_us(0, 0.0), 1000);
        assert_eq!(settings.servo_pulse_us(0, 90.0), 1500);
        assert_eq!(settings.servo_pulse_us(0, 180.0), 2000);
        assert_eq!(settings.servo_pulse_us(0, 45.5), 1253, "rounded to the microsecond");
        // Held to the range.
        assert_eq!(settings.servo_pulse_us(0, 200.0), 2000);
        assert_eq!(settings.servo_pulse_us(0, -5.0), 1000);
        let s = servos();
        assert_eq!(s.servo_pulse_us(0, 135.0), 1500);
        assert_eq!(s.servo_pulse_us(0, 270.0), 2500);
        // Turning the other way: the longer pulse at 0.
        assert_eq!(s.servo_pulse_us(1, 0.0), 2400);
        assert_eq!(s.servo_pulse_us(1, 90.0), 600);
        assert_eq!(s.servo_pulse_us(1, 30.0), 1800);
        assert_eq!(s.servo_pulse_us(3, 360.0), 1000);
        assert_eq!(s.servo_pulse_us(2, 0.25), 1600);
        // Started at boot where the setting says, or not at all.
        assert_eq!([0, 1, 2, 3].map(|i| s.servo_start_angle(i)), [Some(135.5), None, Some(0.0), Some(360.0)]);
        assert_eq!(Settings::default().servo_start_angle(0), None);
        assert!(s.any_servo() && !Settings::default().any_servo());
        assert!(s.servo_fitted(0) && s.servo_fitted(1) && !s.servo_fitted(2));
        // The wiring is what a pulse goes out on: the pin of a servo on the
        // board, the channel of one on the PCA9685, nothing for none.
        assert_eq!([0, 1, 2, 3].map(|i| s.servo_wiring(i)), [(SERVO_PIN, 24), (SERVO_PCA, 4), (SERVO_NONE, 0), (SERVO_PCA, 0)]);
    }

    #[test]
    fn the_servos_round_trip_the_blob_after_the_old_fields() {
        let stored = servos();
        assert!(stored.is_valid());
        let mut blob = [0u8; BLOB_LEN];
        stored.to_blob(&mut blob);
        assert_eq!(blob[MAGIC.len()], 11);
        assert_eq!(Settings::from_blob(&blob), Some(stored));
        // Laid out after the version 10 fields, which end where the old
        // blob's CRC was: the bus, then each servo in turn.
        let at = OLD_CRC_OFFSET;
        assert_eq!(blob[at..at + 3], [20, 21, 0x7F]);
        let servo = at + 3;
        assert_eq!(blob[servo..servo + 7], [SERVO_PIN, 24, 15, 0xF4, 0x01, 0xC4, 0x09], "500 and 2500 little-endian");
        assert_eq!(blob[servo + 7..servo + 11], 270.0f32.to_le_bytes());
        assert_eq!(blob[servo + 11..servo + 15], 135.5f32.to_le_bytes());
        let last = servo + 3 * 15;
        assert_eq!(blob[last..last + 7], [SERVO_PCA, 1, 0, 0xB8, 0x0B, 0xE8, 0x03]);
        assert_eq!(last + 15, HEADER_LEN + FIELDS_LEN);
        assert!(blob[HEADER_LEN + FIELDS_LEN..CRC_OFFSET].iter().all(|&b| b == 0));
        // A stored servo out of its bounds throws the blob away, as any
        // field does.
        for bad in [
            Settings { servo_out: [3, 0, 0, 0], ..Settings::default() },
            Settings { servo_chan: [0, 16, 0, 0], ..Settings::default() },
            Settings { servo_min_us: [1000, 1000, 100, 1000], ..Settings::default() },
            Settings { servo_range: [180.0, 180.0, 180.0, 0.0], ..Settings::default() },
            Settings { i2c_sda: 1, ..Settings::default() },
            Settings { pca_addr: 0x3F, ..Settings::default() },
        ] {
            bad.to_blob(&mut blob);
            assert_eq!(Settings::from_blob(&blob), None, "{bad:?}");
        }
    }

    #[test]
    fn a_version_10_blob_is_read_with_no_servo() {
        // Version 10 is this layout without the bus and the servos, in the
        // shorter blob; its firmware wrote nothing past the tuning.
        let stored = Settings { laser_invert: true, sockets: 1423, ..servos() };
        let blob = old_blob(&stored, 10, OLD_CRC_OFFSET);
        let read = Settings::from_blob(&blob).expect("a version 10 blob is read");
        assert_eq!(read, Settings { laser_invert: true, sockets: 1423, ..Settings::default() });
        // The flash is read as long as this version's blob: an old blob
        // comes with the erased sector behind it, which is not read.
        let mut sector = [0xFFu8; BLOB_LEN];
        sector[..OLD_BLOB_LEN].copy_from_slice(&blob);
        assert_eq!(Settings::from_blob(&sector), Some(read));
        // Too short for its own version, or a version 11 cut to the old
        // length, is nothing.
        assert_eq!(Settings::from_blob(&blob[..OLD_BLOB_LEN - 1]), None);
        let mut long = [0u8; BLOB_LEN];
        stored.to_blob(&mut long);
        assert_eq!(Settings::from_blob(&long[..OLD_BLOB_LEN]), None);
    }
}
