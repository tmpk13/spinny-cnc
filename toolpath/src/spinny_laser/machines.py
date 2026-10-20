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
    [rail]    R, mm: steps_per_mm, max_rate, accel, jerk, jog_rate, limit (r_max), invert, current_ma, microsteps
    [table]   A, deg: steps_per_deg, max_rate, accel, jerk, jog_rate, invert, current_ma, microsteps
    [dispenser] A, mm, in place of [table] with tool = dispenser: steps_per_mm and the table's other keys
    [slide]   Z, mm: steps_per_mm, max_rate, accel, jerk, jog_rate, limit (z_max), invert, current_ma, microsteps
    [focus]   H, mm: fitted (h_axis), steps_per_mm, max_rate, accel, jerk, jog_rate, invert, current_ma, microsteps
              each axis also takes socket, the driver socket it is wired to (X, Y, Z or E, each once: sockets),
              and its endstops: endstop (none, min, max, both: <axis>_stop), endstop_pin (<axis>_stop_pin),
              endstop_invert (stop_invert bit), endstop_halt (limits bit), home_pull, home_pos, home_travel
              (<axis>_home_pull, <axis>_home_pos, <axis>_home_travel)
    [probe]   invert, brake_ms (probe_ms), pin (probe_pin)
    [output]  pwm_hz, s_max, s_min, invert, test_ms (laser_ms), pin (laser_pin)
    [enable]  fitted (tool_out), pin (tool_pin), invert (tool_invert): an output that follows the tool
    [drivers] enable_invert, idle_ms, step_us, hold_pct, stealth
    [host]    tolerance, clearance, spinup, speed_control, and for dispensing gap, retract, output, extrude_rate,
              dwell_ms: the host's own settings, not the firmware's
    [camera]  device, size, fps, pcbv, side, finish, offset, roll, mm_per_px: a camera on the head, the backend's
    [controls] the page's jog panel and readout (spinny_laser.controls); left out, drawn from the kinematics, tool and focus axis
"""

from __future__ import annotations

import math
import re
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

from spinny_laser.controls import default_controls, parse_controls

KINEMATICS = ("polar", "cartesian")
TOOLS = ("laser", "spindle", "dispenser")

# The firmware's defaults, in the order it lists them. A file sets what it
# names and leaves the rest here, so a machine is always all 75 settings.
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
}

FLAGS = frozenset({"en_invert", "laser_invert", "tmc_stealth", "h_axis", "probe_invert", "cartesian", "spindle", "tool_out", "tool_invert", "dispenser"})
INTEGERS = frozenset({
    "dir_invert", "idle_ms", "step_us", "laser_hz", "laser_ms", "tmc_hold_pct", "probe_ms",
    "tmc_r_ma", "tmc_a_ma", "tmc_z_ma", "tmc_h_ma", "tmc_r_micro", "tmc_a_micro", "tmc_z_micro", "tmc_h_micro",
    "sockets", "laser_pin", "probe_pin", "tool_pin",
    "r_stop", "a_stop", "h_stop", "z_stop", "r_stop_pin", "a_stop_pin", "h_stop_pin", "z_stop_pin",
    "stop_invert", "limits",
})
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
}
# Settings the firmware reads at boot: a change takes effect after a save
# to flash and a restart.
BOOT_SETTINGS = ("laser_pin", "probe_pin", "tool_out", "tool_pin", "r_stop_pin", "a_stop_pin", "h_stop_pin", "z_stop_pin")
ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
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
# pull-back.
HOST_KEYS = {
    "tolerance": (0.0, 10.0, False),
    "clearance": (0.0, 100.0, False),
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


def check_id(machine_id: str) -> str:
    """A machine id is a file name: lower case letters, digits, - and _."""
    if not ID_PATTERN.fullmatch(machine_id):
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

    def summary(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "kinematics": self.kinematics,
            "tool": self.tool,
            "focus": self.focus,
        }

    def document(self) -> dict:
        return {
            **self.summary(),
            "settings": dict(self.settings),
            "host": dict(self.host),
            "camera": {**CAMERA_DEFAULTS, **self.camera},
            "controls": self.controls,
        }


def load(path: Path | str) -> Machine:
    """Reads one machine file; its id is the file's stem."""
    path = Path(path)
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise MachineError(f"{path}: {exc.strerror or exc}") from exc
    return parse(text, path.stem, str(path))


def load_all(directory: Path | str) -> tuple[list[Machine], list[str]]:
    """Every `*.toml` in a directory, by id, with a message for each file
    that could not be taken, so one bad file does not hide the others."""
    directory = Path(directory)
    machines: list[Machine] = []
    problems: list[str] = []
    if not directory.is_dir():
        return machines, problems
    for path in sorted(directory.glob("*.toml")):
        try:
            machines.append(load(path))
        except MachineError as exc:
            problems.append(str(exc))
    return machines, problems


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
        if scale_key in table:
            settings[f"{axis}_steps"] = reader.positive(table, scale_key, section)
        for key, setting in (("max_rate", f"{axis}_rate"), ("accel", f"{axis}_accel"), ("jerk", f"{axis}_jerk"), ("jog_rate", f"jog_{axis}")):
            if key in table:
                settings[setting] = reader.positive(table, key, section)
        if axis in ("r", "z") and "limit" in table:
            settings[f"{axis}_max"] = reader.non_negative(table, "limit", section)
        if reader.flag(table, "invert", False, section):
            dir_invert |= 1 << bit
        if "current_ma" in table:
            settings[f"tmc_{axis}_ma"] = reader.integer(table, "current_ma", section, 0, 2000)
        if "microsteps" in table:
            settings[f"tmc_{axis}_micro"] = reader.one_of(table, "microsteps", section, MICROSTEPS)
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
            settings[f"{axis}_home_pos"] = reader.number(table, "home_pos", section)
        reader.done(table, section, {scale_key, "max_rate", "accel", "jerk", "jog_rate", "invert", "current_ma", "microsteps", "socket",
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
    # A fitted endstop is an input like the probe, which it may share;
    # on an output's pin it would read the output.
    for section, (axis, _, _) in AXES.items():
        if not settings[f"{axis}_stop"]:
            continue
        pin = settings[f"{axis}_stop_pin"]
        outputs = [("output", settings["laser_pin"])] + ([("enable", settings["tool_pin"])] if settings["tool_out"] else [])
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
    reader.done(drivers, "drivers", {"enable_invert", "idle_ms", "step_us", "hold_pct", "stealth"})

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
    reader.done(top, None, {"name", "description", "kinematics", "tool", *AXES, "dispenser", "probe", "output", "enable", "drivers", "host", "camera", "controls"})

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
    )


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
    """The live settings are this machine's, every one of them."""
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


def current(machines: list[Machine], values: dict) -> str | None:
    """The id of the machine the live settings are, or None for a machine
    that is no file's."""
    found = matching(machines, values)
    return found.id if found is not None else None


def alike(machine: Machine, kinematics: str, tool: str, focus: bool) -> bool:
    """The file describes this kind of machine: the kinematics, the tool
    and whether a focus axis is fitted."""
    return machine.kinematics == kinematics and machine.tool == tool and machine.focus == focus


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
