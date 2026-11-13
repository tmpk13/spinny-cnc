"""Machine configuration files.

A machine is a TOML file: its axes with their scales, rates and limits,
the kinematics (the rail as the radius over a turning table, or as X
beside the cross slide as Y), the tool (a laser, a spindle with the focus
axis as its depth, or a paste dispenser whose plunger turns on the table's
driver) and the camera on the head, if any. Loading one writes every
firmware setting, so swapping files swaps machines. What a file leaves
out stays at the firmware's own default.

The sections and keys, with the firmware setting each one sets:

    name, description, kinematics (polar | cartesian), tool (laser | spindle | dispenser)
    [rail]    R, mm: full_steps_per_mm or steps_per_mm, max_rate, accel, jerk, jog_rate, limit (r_max), invert, current_ma, microsteps
    [table]   A, deg: full_steps_per_deg or steps_per_deg, max_rate, accel, jerk, jog_rate, invert, current_ma, microsteps
    [dispenser] A, mm, in place of [table] with tool = dispenser: full_steps_per_mm or steps_per_mm and the table's other keys
    [slide]   Z, mm: full_steps_per_mm or steps_per_mm, max_rate, accel, jerk, jog_rate, limit (z_max), invert, current_ma, microsteps
    [focus]   H, mm: fitted (h_axis), full_steps_per_mm or steps_per_mm, max_rate, accel, jerk, jog_rate, invert, current_ma, microsteps
              full_steps_per_mm (per_deg) is the motor's full steps per unit, 200 / mm per turn for a 1.8 degree
              motor, and <axis>_steps is it times microsteps; steps_per_mm is <axis>_steps itself
              each axis also takes socket, the driver socket it is wired to (X, Y, Z or E, each once: sockets),
              and its endstops: endstop (none, min, max, both: <axis>_stop), endstop_pin (<axis>_stop_pin),
              endstop_invert (stop_invert bit), endstop_halt (limits bit), home_pull, home_pos, home_travel
              (<axis>_home_pull, <axis>_home_pos, <axis>_home_travel)
    [probe]   invert, brake_ms (probe_ms), pin (probe_pin)
    [output]  pwm_hz, s_max, s_min, invert, test_ms (laser_ms), pin (laser_pin)
    [enable]  fitted (tool_out), pin (tool_pin), invert (tool_invert): an output that follows the tool
    [drivers] enable_invert, idle_ms, step_us, hold_pct, stealth, interpolate (tmc_intpol), and the drivers'
              register fields toff, tbl, hstrt, hend, hold_delay, tpowerdown, tpwmthrs (tmc_<key>)
    [pca9685] sda (i2c_sda), scl (i2c_scl), address (pca_addr): the PCA9685 servo driver on the board's I2C bus
    [servo.1] to [servo.4]  servo N: pin (servoN_out 1, servoN_pin) or channel (servoN_out 2, servoN_chan),
              min_us, max_us, range, start (servoN_<key>; left out, no pulse at boot), and for the page name
              and positions, a table of named angles; a servo the file leaves out has no output
    [host]    tolerance, clearance, travel, spinup, speed_control, and for dispensing gap, retract, output, extrude_rate,
              dwell_ms: the host's own settings, not the firmware's
    [camera]  device, size, fps, pcbv, side, finish, offset, roll, mm_per_px: a camera on the head, the backend's
    [controls] the page's jog panel and readout (spinny_laser.controls); left out, drawn from the kinematics, tool and focus axis

A machine whose own controller takes G-code (a pick and place machine's
Marlin, Smoothieware, RepRapFirmware or Grbl) is a file too, with
`controller = "gcode"`: an X/Y machine with the nozzle's height as Z and
its turn as A, the tool a vacuum nozzle. None of this project's firmware
settings are its; its own tables say how to talk to it and how it places
parts, and the backend reads them (spinny_web.openpnp):

    controller = "gcode", and kinematics (cartesian) and tool (nozzle) only as those
    [port] [gcode] [motion] [vacuum] [up_camera] [top_camera] [bus] [[slot]] [[feeder]], and [controls]
"""

from __future__ import annotations

import math
import re
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

from spinny_laser.controls import parse_controls

KINEMATICS = ("polar", "cartesian")
TOOLS = ("laser", "spindle", "dispenser")
# Who drives the machine: this project's firmware, or the machine's own
# controller taking G-code a line at a time.
SPINNY = "spinny"
GCODE = "gcode"
CONTROLLERS = (SPINNY, GCODE)
# A G-code machine's tool: a vacuum nozzle that picks and places parts.
NOZZLE = "nozzle"
# The tables of a G-code machine file the backend reads; this module keeps
# them as written.
GCODE_SECTIONS = ("port", "gcode", "motion", "vacuum", "up_camera", "top_camera", "bus", "slot", "feeder")

# Servos the firmware drives, servo.1 to servo.4 in a file. Each is on a
# GPIO of the board or on a channel of a PCA9685 on its I2C bus; a pulse of
# min_us at 0 degrees to max_us at its range.
SERVOS = 4
SERVO_US = (200, 3000)
SERVO_RANGE_MAX = 360.0
PCA_CHANNELS = 16
# A PCA9685's addresses, as its six address pins set them.
PCA_ADDRESSES = (0x40, 0x7F)
# The named angles a servo's bar on the page offers, at most this many.
SERVO_POSITIONS_MAX = 8

# The firmware's defaults, in the order it lists them. A file sets what it
# names and leaves the rest here, so a machine is always all 114 settings.
FIRMWARE_DEFAULTS: dict[str, float | int] = {
    "r_steps": 10240.0, "a_steps": 14222.222, "r_rate": 560.0, "a_rate": 400.0,
    "r_accel": 50.0, "a_accel": 50.0, "r_jerk": 3.0, "a_jerk": 2.0,
    "r_max": 0.0, "z_steps": 10240.0, "z_rate": 560.0, "z_accel": 50.0,
    "jog_z": 120.0, "jog_r": 300.0, "jog_a": 200.0,
    "dir_invert": 0, "en_invert": 0, "idle_ms": 0, "step_us": 2,
    "laser_hz": 5000, "s_max": 1000.0, "s_min": 0.0, "laser_invert": 0, "laser_ms": 5000,
    "tmc_r_ma": 800, "tmc_a_ma": 800, "tmc_hold_pct": 50, "tmc_r_micro": 256, "tmc_a_micro": 256,
    "tmc_z_ma": 800, "tmc_z_micro": 256, "tmc_stealth": 1,
    "h_axis": 0, "h_steps": 6400.0, "h_rate": 600.0, "h_accel": 50.0, "h_jerk": 1.0, "jog_h": 120.0,
    "probe_invert": 0, "tmc_h_ma": 600, "tmc_h_micro": 256, "probe_ms": 20,
    "z_jerk": 3.0, "z_max": 0.0, "cartesian": 0, "spindle": 0, "sockets": 1234,
    "laser_pin": 20, "probe_pin": 25, "tool_out": 0, "tool_pin": 17, "tool_invert": 0,
    "r_stop": 0, "r_stop_pin": 4, "r_home_pull": 1.0, "r_home_pos": 0.0, "r_home_travel": 200.0,
    "a_stop": 0, "a_stop_pin": 3, "a_home_pull": 1.0, "a_home_pos": 0.0, "a_home_travel": 400.0,
    "h_stop": 0, "h_stop_pin": 16, "h_home_pull": 1.0, "h_home_pos": 0.0, "h_home_travel": 50.0,
    "z_stop": 0, "z_stop_pin": 22, "z_home_pull": 1.0, "z_home_pos": 0.0, "z_home_travel": 200.0,
    "stop_invert": 0, "limits": 0,
    "dispenser": 0,
    "tmc_intpol": 1, "tmc_toff": 3, "tmc_tbl": 2, "tmc_hstrt": 5, "tmc_hend": 0,
    "tmc_hold_delay": 10, "tmc_tpowerdown": 20, "tmc_tpwmthrs": 0,
    "i2c_sda": 0, "i2c_scl": 1, "pca_addr": 64,
    **{
        f"servo{n}_{key}": value
        for n in range(1, SERVOS + 1)
        for key, value in (("out", 0), ("pin", 29), ("chan", n - 1), ("min_us", 1000), ("max_us", 2000), ("range", 180.0), ("start", -1.0))
    },
}

# The drivers' register fields a file sets under [drivers], each under its
# setting's name less the tmc_, with the field's bounds (TMC2209 datasheet
# Rev 1.09: CHOPCONF TOFF, TBL, HSTRT, HEND; IHOLD_IRUN IHOLDDELAY;
# TPOWERDOWN; TPWMTHRS, 20 bits). TOFF 0 would switch the driver off.
TPWMTHRS_MAX = 2**20 - 1
TUNING_KEYS = {
    "toff": (1, 15),
    "tbl": (0, 3),
    "hstrt": (0, 7),
    "hend": (0, 15),
    "hold_delay": (0, 15),
    "tpowerdown": (0, 255),
    "tpwmthrs": (0, TPWMTHRS_MAX),
}

# Where an axis's endstops are, in the order of the <axis>_stop values.
ENDSTOPS = ("none", "min", "max", "both")
# The board's GPIOs a pin setting may name: up to PIN_MAX, less the driver
# sockets' STEP, DIR and EN pins and the driver UART, which the firmware
# refuses. The headers, for the messages and the page.
PIN_MAX = 29
RESERVED_PINS = frozenset({2, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 19, 28})
HEADERS = {
    17: "FAN1", 18: "FAN2", 20: "FAN3", 21: "BED", 23: "HE", 29: "SERVO", 24: "RGB",
    4: "X-STOP", 3: "Y-STOP", 25: "Z-STOP", 16: "E-STOP", 22: "PROBE", 26: "THB", 27: "TH0",
    0: "TX", 1: "RX",
}
# The STOP headers' GPIOs reach the chip through a 74LVC2G34 input buffer
# (SKR Pico V1.0 schematic), which would drive against anything put out on
# them: no servo's pulse or I2C line goes there, and the firmware refuses
# them too.
BUFFERED_INPUTS = frozenset({3, 4, 16, 25})
# The RP2040's I2C pins less the reserved and buffered ones: data on an
# even GPIO, clock on the odd one, I2C0 from 0 and I2C1 from 2 in fours.
I2C_PAIRS = "data on GP0, 20 or 24 with clock on GP1, 17, 21 or 29 (I2C0), or GP18, 22 or 26 with GP23 or 27 (I2C1)"
# An id of a machine or a CAM profile, which is its file's name less
# .toml, and of a profile's tools and materials: lower case letters,
# digits, - and _, starting with a letter or digit, at most 64.
ID_PATTERN = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}")
MICROSTEPS = (1, 2, 4, 8, 16, 32, 64, 128, 256)
# The largest float the firmware holds, and the longest probe brake.
FLOAT_MAX = 1.0e7
PROBE_MS_MAX = 160
INT_MAX = 2**32 - 1

# Section name, the firmware's axis letter, the key its scale goes by, and
# its bit in dir_invert.
AXES = {
    "rail": ("r", "steps_per_mm", 0),
    "table": ("a", "steps_per_deg", 1),
    "slide": ("z", "steps_per_mm", 2),
    "focus": ("h", "steps_per_mm", 3),
}
# Driver sockets as the board labels them. The sockets setting is a digit
# per axis, in dir_invert bit order, each the socket's place here from 1.
SOCKETS = ("X", "Y", "Z", "E")
# What a machine file may say about the host's own settings: the bounds,
# and whether the low one is allowed. The dispensing values are what a
# dot of paste is made of: the needle's gap over the pad, the plunger's
# pull-back after each dot, the mm^3 of paste a mm of plunger gives, the
# plunger's speed while a dot is pushed out, and the wait before the
# pull-back. The travel height is an H the head rises to before the page's
# moves and probing go across the board; it may be below H 0.
HOST_KEYS = {
    "tolerance": (0.0, 10.0, False),
    "clearance": (0.0, 100.0, False),
    "travel": (-100.0, 100.0, True),
    "spinup": (0.0, 600.0, True),
    "gap": (0.0, 10.0, False),
    "retract": (0.0, 50.0, True),
    "output": (0.0, 1.0e5, False),
    "extrude_rate": (0.0, 1.0e4, False),
    "dwell_ms": (0.0, 60000.0, True),
}
HOST_INTEGERS = frozenset({"dwell_ms"})
# A camera on the head, as the backend reads it: nothing of it reaches the
# firmware. What a file leaves out keeps the backend's value.
CAMERA_DEFAULTS: dict[str, object] = {
    "device": "/dev/video0",
    "size": "1280x720",
    "fps": 30,
    "pcbv": "pcbv",
    "side": "front",
    "finish": "masked",
    "offset": [0.0, 0.0],
    "roll": 0.0,
    "mm_per_px": 0.0,
}
CAMERA_SIDES = ("front", "back")
CAMERA_FINISHES = ("masked", "bare")
_CAMERA_SIZE = re.compile(r"^[1-9][0-9]{1,4}x[1-9][0-9]{1,4}$")


class MachineError(ValueError):
    """A machine file that cannot be taken: the message names the file and the key."""


def is_id(text: str) -> bool:
    """Whether the text is an id from its first character to its last, so
    one with a line break after it is not."""
    return ID_PATTERN.fullmatch(text) is not None


def check_id(machine_id: str) -> str:
    """A machine id is a file name: lower case letters, digits, - and _."""
    if not is_id(machine_id):
        raise MachineError(f"{machine_id!r} is not a machine id: lower case letters, digits, - and _")
    return machine_id


def pin_name(pin: int) -> str:
    """A GPIO with its header, when it is one: 20 (FAN3)."""
    return f"{pin} ({HEADERS[pin]})" if pin in HEADERS else str(pin)


@dataclass(frozen=True)
class Machine:
    id: str
    name: str
    description: str
    kinematics: str
    tool: str
    focus: bool
    settings: dict[str, float | int]
    host: dict[str, float]
    # The page's controls, as spinny_laser.controls lays them out.
    controls: dict
    # What the file says of the camera, only the keys it names.
    camera: dict = field(default_factory=dict)
    # This project's firmware (spinny), or a controller of the machine's own
    # taking G-code (gcode), whose settings are none of the firmware's.
    controller: str = SPINNY
    # A G-code machine's own tables (GCODE_SECTIONS) as the file has them.
    gcode: dict = field(default_factory=dict)
    # The servos the page draws a bar for, servo 1 first: each one's number,
    # name, range in degrees and named positions as [{name, angle}].
    servos: list = field(default_factory=list)

    def summary(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "kinematics": self.kinematics,
            "tool": self.tool,
            "focus": self.focus,
            "controller": self.controller,
        }

    def document(self) -> dict:
        return {
            **self.summary(),
            "settings": dict(self.settings),
            "host": dict(self.host),
            "camera": {**CAMERA_DEFAULTS, **self.camera},
            "controls": self.controls,
            "servos": [dict(servo) for servo in self.servos],
        }


def load(path: Path | str) -> Machine:
    """Reads one machine file; its id is the file's stem."""
    path = Path(path)
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise MachineError(f"{path}: {exc.strerror or exc}") from exc
    return parse(text, path.stem, str(path))


def parse(text: str, machine_id: str, where: str = "machine") -> Machine:
    try:
        data = tomllib.loads(text)
    except tomllib.TOMLDecodeError as exc:
        raise MachineError(f"{where}: {exc}") from exc
    reader = _Reader(where)
    settings = dict(FIRMWARE_DEFAULTS)
    top = dict(data)
    name = reader.text(top, "name", machine_id)
    description = reader.text(top, "description", "")
    controller = reader.choice(top, "controller", CONTROLLERS, SPINNY)
    if controller == GCODE:
        return _parse_gcode_machine(reader, top, machine_id, name, description)
    for section in GCODE_SECTIONS:
        if section in top:
            raise reader.fail(None, section, 'is a G-code machine\'s: add controller = "gcode" for a machine whose own controller takes G-code')
    kinematics = reader.choice(top, "kinematics", KINEMATICS, "polar")
    tool = reader.choice(top, "tool", TOOLS, "laser")
    settings["cartesian"] = int(kinematics == "cartesian")
    settings["spindle"] = int(tool == "spindle")
    settings["dispenser"] = int(tool == "dispenser")
    if tool == "dispenser" and kinematics != "cartesian":
        raise MachineError(f"{where}: tool = dispenser needs kinematics = cartesian")
    # The dispenser's plunger turns on the table's driver, so its section
    # stands in for the table's, in millimeters.
    if "dispenser" in top:
        if "table" in top:
            raise MachineError(f"{where}: [table] and [dispenser] cannot both be given: the dispenser is the table's driver")
        if tool != "dispenser":
            raise MachineError(f"{where}: [dispenser] needs tool = dispenser")
    dir_invert = 0
    stop_invert = 0
    limits = 0
    # The socket of each axis, as labeled unless the file says otherwise.
    sockets = list(SOCKETS)
    for section, (axis, scale_key, bit) in AXES.items():
        if section == "table" and "dispenser" in top:
            section, scale_key = "dispenser", "steps_per_mm"
        table = reader.table(top, section)
        if "socket" in table:
            sockets[bit] = reader.text_choice(table, "socket", section, SOCKETS)
        if axis == "h":
            settings["h_axis"] = int(reader.flag(table, "fitted", bool(settings["h_axis"]), section))
        # The scale as the firmware takes it counts microsteps; the full
        # steps of the motor do not, so a file that gives them keeps its
        # distances whatever microsteps it picks. Given neither, a file that
        # picks microsteps scales the default with them.
        if "microsteps" in table:
            settings[f"tmc_{axis}_micro"] = reader.one_of(table, "microsteps", section, MICROSTEPS)
        micro = settings[f"tmc_{axis}_micro"]
        full_key = f"full_{scale_key}"
        if scale_key in table and full_key in table:
            raise reader.fail(section, full_key, f"and {scale_key} cannot both be given: {scale_key} counts microsteps, {full_key} does not")
        if full_key in table:
            steps = reader.positive(table, full_key, section) * micro
            # The firmware takes the product, not the key, so the product is
            # what must be within its bound.
            if steps > FLOAT_MAX:
                raise reader.fail(section, full_key, f"times the {micro} microsteps is {steps:g} steps, above the firmware's {FLOAT_MAX:g}")
            settings[f"{axis}_steps"] = steps
        elif scale_key in table:
            settings[f"{axis}_steps"] = reader.positive(table, scale_key, section)
        elif "microsteps" in table:
            settings[f"{axis}_steps"] = FIRMWARE_DEFAULTS[f"{axis}_steps"] / FIRMWARE_DEFAULTS[f"tmc_{axis}_micro"] * micro
        for key, setting in (("max_rate", f"{axis}_rate"), ("accel", f"{axis}_accel"), ("jerk", f"{axis}_jerk"), ("jog_rate", f"jog_{axis}")):
            if key in table:
                settings[setting] = reader.positive(table, key, section)
        if axis in ("r", "z") and "limit" in table:
            settings[f"{axis}_max"] = reader.non_negative(table, "limit", section)
        if reader.flag(table, "invert", False, section):
            dir_invert |= 1 << bit
        if "current_ma" in table:
            settings[f"tmc_{axis}_ma"] = reader.integer(table, "current_ma", section, 0, 2000)
        if "endstop" in table:
            settings[f"{axis}_stop"] = ENDSTOPS.index(reader.text_choice(table, "endstop", section, ENDSTOPS))
        if "endstop_pin" in table:
            settings[f"{axis}_stop_pin"] = reader.pin(table, "endstop_pin", section)
        if reader.flag(table, "endstop_invert", False, section):
            stop_invert |= 1 << bit
        if reader.flag(table, "endstop_halt", False, section):
            limits |= 1 << bit
        for key in ("home_pull", "home_travel"):
            if key in table:
                settings[f"{axis}_{key}"] = reader.positive(table, key, section)
        if "home_pos" in table:
            home = reader.number(table, "home_pos", section)
            if not -FLOAT_MAX <= home <= FLOAT_MAX:
                raise reader.fail(section, "home_pos", f"must be within {FLOAT_MAX:g} either side of 0")
            settings[f"{axis}_home_pos"] = home
        reader.done(table, section, {scale_key, full_key, "max_rate", "accel", "jerk", "jog_rate", "invert", "current_ma", "microsteps", "socket",
                                     "endstop", "endstop_pin", "endstop_invert", "endstop_halt", "home_pull", "home_pos", "home_travel"}
                    | ({"limit"} if axis in ("r", "z") else set()) | ({"fitted"} if axis == "h" else set()))
    settings["dir_invert"] = dir_invert
    settings["stop_invert"] = stop_invert
    settings["limits"] = limits
    sections = ["dispenser" if section == "table" and "dispenser" in top else section for section in AXES]
    for i, socket in enumerate(sockets):
        if socket in sockets[:i]:
            other = sections[sockets.index(socket)]
            raise MachineError(f"{where}: [{sections[i]}] socket {socket} is the [{other}] socket too")
    settings["sockets"] = int("".join(str(SOCKETS.index(socket) + 1) for socket in sockets))

    probe = reader.table(top, "probe")
    settings["probe_invert"] = int(reader.flag(probe, "invert", False, "probe"))
    if "brake_ms" in probe:
        settings["probe_ms"] = reader.integer(probe, "brake_ms", "probe", 0, PROBE_MS_MAX)
    if "pin" in probe:
        settings["probe_pin"] = reader.pin(probe, "pin", "probe")
    reader.done(probe, "probe", {"invert", "brake_ms", "pin"})

    output = reader.table(top, "output")
    if "pwm_hz" in output:
        settings["laser_hz"] = reader.integer(output, "pwm_hz", "output", 100, 100_000)
    if "s_max" in output:
        settings["s_max"] = reader.positive(output, "s_max", "output")
    if "s_min" in output:
        settings["s_min"] = reader.non_negative(output, "s_min", "output")
    if settings["s_min"] > settings["s_max"]:
        raise MachineError(f"{where}: [output] s_min is above s_max")
    settings["laser_invert"] = int(reader.flag(output, "invert", False, "output"))
    if "test_ms" in output:
        settings["laser_ms"] = reader.integer(output, "test_ms", "output", 1, 60_000)
    if "pin" in output:
        settings["laser_pin"] = reader.pin(output, "pin", "output")
    reader.done(output, "output", {"pwm_hz", "s_max", "s_min", "invert", "test_ms", "pin"})

    # The tool output. The firmware takes the pins one setting at a time,
    # so two on one GPIO are refused here, where the whole file is seen.
    enable = reader.table(top, "enable")
    settings["tool_out"] = int(reader.flag(enable, "fitted", False, "enable"))
    if "pin" in enable:
        settings["tool_pin"] = reader.pin(enable, "pin", "enable")
    settings["tool_invert"] = int(reader.flag(enable, "invert", False, "enable"))
    reader.done(enable, "enable", {"fitted", "pin", "invert"})
    if settings["probe_pin"] == settings["laser_pin"]:
        raise MachineError(f"{where}: [probe] pin {pin_name(settings['probe_pin'])} is the [output] pin too")
    if settings["tool_out"]:
        for section, other in (("output", "laser_pin"), ("probe", "probe_pin")):
            if settings["tool_pin"] == settings[other]:
                raise MachineError(f"{where}: [enable] pin {pin_name(settings['tool_pin'])} is the [{section}] pin too")
    servos = _parse_servos(reader, top, settings)
    driven = _check_servo_pins(where, settings)
    # A fitted endstop is an input like the probe, which it may share;
    # on an output's pin it would read the output.
    for section, (axis, _, _) in AXES.items():
        if not settings[f"{axis}_stop"]:
            continue
        pin = settings[f"{axis}_stop_pin"]
        outputs = [("output", settings["laser_pin"])] + ([("enable", settings["tool_pin"])] if settings["tool_out"] else []) + driven
        for other, other_pin in outputs:
            if pin == other_pin:
                raise MachineError(f"{where}: [{section}] endstop_pin {pin_name(pin)} is the [{other}] pin too")

    drivers = reader.table(top, "drivers")
    settings["en_invert"] = int(reader.flag(drivers, "enable_invert", False, "drivers"))
    if "idle_ms" in drivers:
        settings["idle_ms"] = reader.integer(drivers, "idle_ms", "drivers", 0, INT_MAX)
    if "step_us" in drivers:
        settings["step_us"] = reader.integer(drivers, "step_us", "drivers", 1, 20)
    if "hold_pct" in drivers:
        settings["tmc_hold_pct"] = reader.integer(drivers, "hold_pct", "drivers", 0, 100)
    settings["tmc_stealth"] = int(reader.flag(drivers, "stealth", True, "drivers"))
    settings["tmc_intpol"] = int(reader.flag(drivers, "interpolate", True, "drivers"))
    for key, (low, high) in TUNING_KEYS.items():
        if key in drivers:
            settings[f"tmc_{key}"] = reader.integer(drivers, key, "drivers", low, high)
    _check_tuning(where, settings)
    reader.done(drivers, "drivers", {"enable_invert", "idle_ms", "step_us", "hold_pct", "stealth", "interpolate", *TUNING_KEYS})

    host_table = reader.table(top, "host")
    host: dict[str, float] = {}
    for key, (low, high, low_ok) in HOST_KEYS.items():
        if key not in host_table:
            continue
        if key in HOST_INTEGERS:
            host[key] = float(reader.integer(host_table, key, "host", int(low), int(high)))
            continue
        value = reader.number(host_table, key, "host")
        if not (low <= value <= high) or (not low_ok and value <= low):
            if key == "spinup" or not low_ok:
                raise MachineError(f"{where}: [host] {key} must be above {low:g} and at most {high:g}")
            raise MachineError(f"{where}: [host] {key} must be {low:g} to {high:g}")
        host[key] = value
    if "speed_control" in host_table:
        host["speed_control"] = float(reader.flag(host_table, "speed_control", True, "host"))
    reader.done(host_table, "host", {*HOST_KEYS, "speed_control"})
    camera = _parse_camera(reader, reader.table(top, "camera"))
    controls = parse_controls(reader, top, kinematics, tool, bool(settings["h_axis"]))
    reader.done(
        top,
        None,
        {"name", "description", "controller", "kinematics", "tool", *AXES, "dispenser", "probe", "output", "enable", "drivers", "host", "camera",
         "controls", "pca9685", "servo"},
    )

    return Machine(
        id=machine_id,
        name=name,
        description=description,
        kinematics=kinematics,
        tool=tool,
        focus=bool(settings["h_axis"]),
        settings=settings,
        host=host,
        controls=controls,
        camera=camera,
        servos=servos,
    )


def _parse_servos(reader: "_Reader", top: dict, settings: dict) -> list[dict]:
    """`[pca9685]` and `[servo.1]` to `[servo.4]` into the settings: each
    servo on a pin of the board (`pin`) or a channel of the PCA9685
    (`channel`), its pulse span, range and start angle; a servo the file
    leaves out has no output. Returns what the page draws for each one
    given: its number, name, range and named positions."""
    pca = reader.table(top, "pca9685")
    for key, setting in (("sda", "i2c_sda"), ("scl", "i2c_scl")):
        if key in pca:
            settings[setting] = reader.output_pin(pca, key, "pca9685")
    if "sda" in pca and settings["i2c_sda"] % 2:
        raise reader.fail("pca9685", "sda", f"must be an even GPIO, an I2C block's data line: {I2C_PAIRS}")
    if "scl" in pca and not settings["i2c_scl"] % 2:
        raise reader.fail("pca9685", "scl", f"must be an odd GPIO, an I2C block's clock line: {I2C_PAIRS}")
    if "address" in pca:
        settings["pca_addr"] = reader.integer(pca, "address", "pca9685", *PCA_ADDRESSES)
    reader.done(pca, "pca9685", {"sda", "scl", "address"})

    tables = reader.table(top, "servo")
    for number in tables:
        if number not in {str(n) for n in range(1, SERVOS + 1)}:
            raise reader.fail(None, f"servo.{number}", f"is not a servo: the board has servo.1 to servo.{SERVOS}")
    servos = []
    for n in range(1, SERVOS + 1):
        if str(n) not in tables:
            settings[f"servo{n}_out"] = 0
            continue
        section = f"servo.{n}"
        table = tables[str(n)]
        if not isinstance(table, dict):
            raise reader.fail(None, section, "must be a table")
        table = dict(table)
        name = reader.text(table, "name", f"Servo {n}")
        if not name.strip():
            raise reader.fail(section, "name", "must not be empty")
        if "pin" in table and "channel" in table:
            raise reader.fail(section, "channel", "and pin cannot both be given: a servo is on a pin of the board or a channel of the PCA9685")
        if "pin" in table:
            settings[f"servo{n}_out"] = 1
            settings[f"servo{n}_pin"] = reader.output_pin(table, "pin", section)
        elif "channel" in table:
            settings[f"servo{n}_out"] = 2
            settings[f"servo{n}_chan"] = reader.integer(table, "channel", section, 0, PCA_CHANNELS - 1)
        else:
            raise reader.fail(None, section, "needs pin, a GPIO of the board, or channel, one of the PCA9685's")
        for key in ("min_us", "max_us"):
            if key in table:
                settings[f"servo{n}_{key}"] = reader.integer(table, key, section, *SERVO_US)
        if "range" in table:
            span = reader.number(table, "range", section)
            if not 0.0 < span <= SERVO_RANGE_MAX:
                raise reader.fail(section, "range", f"must be above 0 and at most {SERVO_RANGE_MAX:g} degrees")
            settings[f"servo{n}_range"] = span
        span = float(settings[f"servo{n}_range"])
        if "start" in table:
            start = reader.number(table, "start", section)
            if not 0.0 <= start <= span:
                raise reader.fail(section, "start", f"must be 0 to the range, {span:g} degrees; left out, the servo gets no pulse at boot")
            settings[f"servo{n}_start"] = start
        else:
            settings[f"servo{n}_start"] = -1.0
        positions = table.get("positions", {})
        if not isinstance(positions, dict):
            raise reader.fail(section, "positions", "must be a table of names and angles, like { up = 30, down = 120 }")
        if len(positions) > SERVO_POSITIONS_MAX:
            raise reader.fail(section, "positions", f"names {len(positions)} angles; at most {SERVO_POSITIONS_MAX}")
        named = []
        for label, angle in positions.items():
            if isinstance(angle, bool) or not isinstance(angle, (int, float)) or not math.isfinite(angle) or not 0.0 <= angle <= span:
                raise reader.fail(section, "positions", f"{label} must be an angle, 0 to the range, {span:g} degrees")
            named.append({"name": label, "angle": float(angle)})
        reader.done(table, section, {"name", "pin", "channel", "min_us", "max_us", "range", "start", "positions"})
        servos.append({"servo": n, "name": name, "range": span, "positions": named})
    return servos


def _check_servo_pins(where: str, settings: dict) -> list[tuple[str, int]]:
    """The servos' pins and the PCA9685's bus against each other and the
    other pins: the firmware takes them one at a time, so a pin named twice
    is refused here, where the whole file is seen. A servo's pin may not be
    another output's or the probe's, nor on the laser's PWM slice, whose
    rate is the laser's, nor on another servo's PWM channel (GPIO n and
    n + 16 share one); two servos may not share a channel of the PCA9685;
    and the bus, when a servo is on it, is one I2C block's data and clock
    lines and nobody else's. Returns the outputs these add, for the
    endstops' check."""
    laser = settings["laser_pin"]
    others = [("output", laser), ("probe", settings["probe_pin"])]
    if settings["tool_out"]:
        others.append(("enable", settings["tool_pin"]))
    driven: list[tuple[str, int]] = []
    channels: dict[int, int] = {}
    for n in range(1, SERVOS + 1):
        section = f"servo.{n}"
        out = settings[f"servo{n}_out"]
        if out == 2:
            channel = settings[f"servo{n}_chan"]
            if channel in channels:
                raise MachineError(f"{where}: [{section}] channel {channel} is [servo.{channels[channel]}]'s too")
            channels[channel] = n
        if out != 1:
            continue
        pin = settings[f"servo{n}_pin"]
        for other, other_pin in others + driven:
            if pin == other_pin:
                raise MachineError(f"{where}: [{section}] pin {pin_name(pin)} is the [{other}] pin too")
        if (pin // 2) % 8 == (laser // 2) % 8:
            raise MachineError(
                f"{where}: [{section}] pin {pin_name(pin)} is on PWM slice {(pin // 2) % 8} with the [output] pin {pin_name(laser)}, which runs at the laser's rate"
            )
        for other, other_pin in driven:
            if (other_pin // 2) % 8 == (pin // 2) % 8 and other_pin % 2 == pin % 2:
                raise MachineError(
                    f"{where}: [{section}] pin {pin_name(pin)} drives the PWM channel of the [{other}] pin {pin_name(other_pin)}: GPIO n and n + 16 share one"
                )
        driven.append((section, pin))
    if channels:
        sda, scl = settings["i2c_sda"], settings["i2c_scl"]
        if (sda // 2) % 2 != (scl // 2) % 2:
            raise MachineError(f"{where}: [pca9685] sda {pin_name(sda)} and scl {pin_name(scl)} are not one I2C block's: {I2C_PAIRS}")
        for key, pin in (("sda", sda), ("scl", scl)):
            for other, other_pin in others + driven:
                if pin == other_pin:
                    raise MachineError(f"{where}: [pca9685] {key} {pin_name(pin)} is the [{other}] pin too")
        driven += [("pca9685", sda), ("pca9685", scl)]
    return driven


def _parse_gcode_machine(reader: "_Reader", top: dict, machine_id: str, name: str, description: str) -> Machine:
    """A machine whose own controller takes G-code: an X/Y machine with the
    nozzle's height as Z (the focus joint) and its turn as A. This
    project's firmware sections mean nothing to it and are refused; its
    own tables are kept for the backend to read, and its controls are
    read here like any machine's."""
    kinematics = reader.choice(top, "kinematics", ("cartesian",), "cartesian")
    tool = reader.choice(top, "tool", (NOZZLE,), NOZZLE)
    for section in (*AXES, "dispenser", "probe", "output", "enable", "drivers", "host", "camera", "pca9685", "servo"):
        if section in top:
            raise reader.fail(None, section, "is for a machine on this project's firmware: a G-code machine's own controller keeps its settings")
    controls = parse_controls(reader, top, kinematics, tool, True)
    reader.done(top, None, {"name", "description", "controller", "kinematics", "tool", "controls", *GCODE_SECTIONS})
    return Machine(
        id=machine_id,
        name=name,
        description=description,
        kinematics=kinematics,
        tool=tool,
        focus=True,
        settings={},
        host={},
        controls=controls,
        controller=GCODE,
        gcode={section: top[section] for section in GCODE_SECTIONS if section in top},
    )


def _check_tuning(where: str, settings: dict) -> None:
    """The rules of the TMC2209 datasheet Rev 1.09 that join two of the
    drivers' settings. The firmware takes settings one at a time, so it
    holds each field to its own bounds only, and these are checked here,
    where the whole file is seen. CHOPCONF: TOFF 1 only with TBL 2 or 3;
    the hysteresis, HSTRT + 1 plus HEND - 3, at most 16. TPOWERDOWN: at
    least 2 for stealthChop to tune itself while the motor rests."""
    if settings["tmc_toff"] == 1 and settings["tmc_tbl"] < 2:
        raise MachineError(f"{where}: [drivers] toff = 1 needs tbl 2 or 3")
    if settings["tmc_hstrt"] + settings["tmc_hend"] > 18:
        raise MachineError(f"{where}: [drivers] hstrt + hend must be at most 18: the hysteresis, hstrt + 1 plus hend - 3, may not pass 16")
    if settings["tmc_stealth"] and settings["tmc_tpowerdown"] < 2:
        raise MachineError(f"{where}: [drivers] tpowerdown must be 2 or more with stealth: stealthChop tunes itself in that time at rest")


def _parse_camera(reader: "_Reader", table: dict) -> dict:
    """The `[camera]` table, only the keys it names, each checked."""
    camera: dict = {}
    for key in ("device", "pcbv"):
        if key in table:
            value = table[key]
            if not isinstance(value, str) or not value.strip():
                raise reader.fail("camera", key, "must be text")
            camera[key] = value
    if "size" in table:
        value = table["size"]
        if not isinstance(value, str) or not _CAMERA_SIZE.match(value):
            raise reader.fail("camera", "size", "must be WIDTHxHEIGHT")
        camera["size"] = value
    if "fps" in table:
        camera["fps"] = reader.integer(table, "fps", "camera", 1, 120)
    if "side" in table:
        camera["side"] = reader.text_choice(table, "side", "camera", CAMERA_SIDES)
    if "finish" in table:
        camera["finish"] = reader.text_choice(table, "finish", "camera", CAMERA_FINISHES)
    if "offset" in table:
        value = table["offset"]
        if (
            not isinstance(value, list)
            or len(value) != 2
            or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or abs(v) > 1000.0 for v in value)
        ):
            raise reader.fail("camera", "offset", "must be two numbers within 1000 mm")
        camera["offset"] = [float(value[0]), float(value[1])]
    if "roll" in table:
        value = reader.number(table, "roll", "camera")
        if abs(value) > 360.0:
            raise reader.fail("camera", "roll", "must be a number within 360")
        camera["roll"] = value
    if "mm_per_px" in table:
        camera["mm_per_px"] = reader.non_negative(table, "mm_per_px", "camera")
    reader.done(table, "camera", set(CAMERA_DEFAULTS))
    return camera


class _Reader:
    """Typed reads out of the parsed tables, each error naming the file and
    the key."""

    def __init__(self, where: str) -> None:
        self.where = where

    def fail(self, section: str | None, key: str, what: str) -> MachineError:
        place = f"[{section}] {key}" if section else key
        return MachineError(f"{self.where}: {place} {what}")

    def table(self, top: dict, section: str) -> dict:
        value = top.get(section, {})
        if not isinstance(value, dict):
            raise self.fail(None, section, "must be a table")
        return dict(value)

    def text(self, top: dict, key: str, default: str) -> str:
        value = top.get(key, default)
        if not isinstance(value, str):
            raise self.fail(None, key, "must be a string")
        return value

    def choice(self, top: dict, key: str, choices: tuple[str, ...], default: str) -> str:
        value = self.text(top, key, default)
        if value not in choices:
            raise self.fail(None, key, f"must be one of {', '.join(choices)}")
        return value

    def text_choice(self, table: dict, key: str, section: str, choices: tuple[str, ...]) -> str:
        value = table[key]
        if not isinstance(value, str) or value not in choices:
            raise self.fail(section, key, f"must be one of {', '.join(choices)}")
        return value

    def flag(self, table: dict, key: str, default: bool, section: str) -> bool:
        value = table.get(key, default)
        if not isinstance(value, bool):
            raise self.fail(section, key, "must be true or false")
        return value

    def number(self, table: dict, key: str, section: str) -> float:
        value = table[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise self.fail(section, key, "must be a number")
        return float(value)

    def positive(self, table: dict, key: str, section: str) -> float:
        value = self.number(table, key, section)
        if not (0.0 < value <= FLOAT_MAX):
            raise self.fail(section, key, f"must be above 0 and at most {FLOAT_MAX:g}")
        return value

    def non_negative(self, table: dict, key: str, section: str) -> float:
        value = self.number(table, key, section)
        if not (0.0 <= value <= FLOAT_MAX):
            raise self.fail(section, key, f"must be 0 or more and at most {FLOAT_MAX:g}")
        return value

    def integer(self, table: dict, key: str, section: str, low: int, high: int) -> int:
        value = table[key]
        if isinstance(value, bool) or not isinstance(value, int):
            raise self.fail(section, key, "must be a whole number")
        if not (low <= value <= high):
            raise self.fail(section, key, f"must be {low} to {high}")
        return value

    def pin(self, table: dict, key: str, section: str) -> int:
        value = self.integer(table, key, section, 0, PIN_MAX)
        if value in RESERVED_PINS:
            raise self.fail(section, key, f"{value} is a driver socket's or the driver UART's; the sockets and the UART keep "
                            + ", ".join(str(pin) for pin in sorted(RESERVED_PINS)))
        return value

    def output_pin(self, table: dict, key: str, section: str) -> int:
        """A pin a servo's pulse or the I2C bus drives: a free GPIO, not
        a STOP header's behind its input buffer."""
        value = self.pin(table, key, section)
        if value in BUFFERED_INPUTS:
            raise self.fail(section, key, f"{pin_name(value)} is a STOP header's, an input behind a buffer that would drive against it")
        return value

    def one_of(self, table: dict, key: str, section: str, choices: tuple[int, ...]) -> int:
        value = self.integer(table, key, section, min(choices), max(choices))
        if value not in choices:
            raise self.fail(section, key, f"must be one of {', '.join(str(c) for c in choices)}")
        return value

    def done(self, table: dict, section: str | None, known: set[str]) -> None:
        unknown = sorted(set(table) - known)
        if unknown:
            raise self.fail(section, unknown[0], "is not a key here")


def close(a: float, b: float) -> bool:
    """Equal as far as a setting read back from the firmware can tell: it
    keeps a 32 bit float and prints three decimals."""
    return math.isclose(a, b, rel_tol=1e-6, abs_tol=5e-4)


def matches(machine: Machine, values: dict) -> bool:
    """The live settings are this machine's, every one of them. A G-code
    machine has none of this project's firmware settings, so no board's
    are its."""
    if machine.controller != SPINNY:
        return False
    for name, expected in machine.settings.items():
        value = values.get(name)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not close(float(value), float(expected)):
            return False
    return True


def matching(machines: list[Machine], values: dict) -> Machine | None:
    """The machine the live settings are, or None for a machine that is no
    file's."""
    for machine in machines:
        if matches(machine, values):
            return machine
    return None


def alike(machine: Machine, kinematics: str, tool: str, focus: bool) -> bool:
    """The file describes this kind of machine: the kinematics, the tool
    and whether a focus axis is fitted, on this project's firmware."""
    return machine.controller == SPINNY and machine.kinematics == kinematics and machine.tool == tool and machine.focus == focus


def controls_file(machines: list[Machine], values: dict, kinematics: str, tool: str, focus: bool, loaded: str | None = None) -> Machine | None:
    """The file the page draws its controls from, for these live settings
    and the kind of machine they describe: the file the settings are,
    every one of them; else, for settings that are no file's, the file
    last loaded onto the board (`loaded`) when it describes this kind of
    machine, since a setting changed by hand does not change what the
    machine is; else the one file that does; else None, for the defaults."""
    found = matching(machines, values)
    if found is not None:
        return found
    kind = [machine for machine in machines if alike(machine, kinematics, tool, focus)]
    for machine in kind:
        if machine.id == loaded:
            return machine
    return kind[0] if len(kind) == 1 else None


def cli_defaults(machine: Machine) -> dict:
    """What a machine file says for the gcode tools' machine options: the
    axis rates for the estimate, the power scale, and the host's chord
    tolerance when it names one."""
    if machine.controller != SPINNY:
        raise MachineError(f"{machine.id} is a G-code machine: the gcode tools' options are a machine's on this project's firmware")
    defaults = {
        "rotary_max_rate": float(machine.settings["a_rate"]),
        "rotary_rapid": float(machine.settings["a_rate"]),
        "x_max_rate": float(machine.settings["r_rate"]),
        "rapid_rate": float(machine.settings["r_rate"]),
        "s_max": float(machine.settings["s_max"]),
    }
    if "tolerance" in machine.host:
        defaults["tolerance"] = machine.host["tolerance"]
    return defaults
