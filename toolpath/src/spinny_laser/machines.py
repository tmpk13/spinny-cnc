"""Machine configuration files.

A machine is a TOML file: its axes with their scales, rates and limits,
the kinematics (the rail as the radius over a turning table, or as X
beside the cross slide as Y) and the tool on the output (a laser, or a
spindle with the focus axis as its depth). Loading one writes every
firmware setting, so swapping files swaps machines. What a file leaves
out stays at the firmware's own default.

The sections and keys, with the firmware setting each one sets:

    name, description, kinematics (polar | cartesian), tool (laser | spindle)
    [rail]    R, mm: steps_per_mm, max_rate, accel, jerk, jog_rate, limit (r_max), invert, current_ma, microsteps
    [table]   A, deg: steps_per_deg, max_rate, accel, jerk, jog_rate, invert, current_ma, microsteps
    [slide]   Z, mm: steps_per_mm, max_rate, accel, jerk, jog_rate, limit (z_max), invert, current_ma, microsteps
    [focus]   H, mm: fitted (h_axis), steps_per_mm, max_rate, accel, jerk, jog_rate, invert, current_ma, microsteps
    [probe]   invert, brake_ms (probe_ms)
    [output]  pwm_hz, s_max, s_min, invert, test_ms (laser_ms)
    [drivers] enable_invert, idle_ms, step_us, hold_pct, stealth
    [host]    tolerance, clearance, spinup: the host's own settings, not the firmware's
"""

from __future__ import annotations

import math
import tomllib
from dataclasses import dataclass
from pathlib import Path

KINEMATICS = ("polar", "cartesian")
TOOLS = ("laser", "spindle")

# The firmware's defaults, in the order it lists them. A file sets what it
# names and leaves the rest here, so a machine is always all 46 settings.
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
    "z_jerk": 3.0, "z_max": 0.0, "cartesian": 0, "spindle": 0,
}

FLAGS = frozenset({"en_invert", "laser_invert", "tmc_stealth", "h_axis", "probe_invert", "cartesian", "spindle"})
INTEGERS = frozenset({
    "dir_invert", "idle_ms", "step_us", "laser_hz", "laser_ms", "tmc_hold_pct", "probe_ms",
    "tmc_r_ma", "tmc_a_ma", "tmc_z_ma", "tmc_h_ma", "tmc_r_micro", "tmc_a_micro", "tmc_z_micro", "tmc_h_micro",
})
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
# What a machine file may say about the host's own settings, and their bounds.
HOST_KEYS = {"tolerance": (0.0, 10.0), "clearance": (0.0, 100.0), "spinup": (0.0, 600.0)}


class MachineError(ValueError):
    """A machine file that cannot be taken: the message names the file and the key."""


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
        return {**self.summary(), "settings": dict(self.settings), "host": dict(self.host)}


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
    dir_invert = 0
    for section, (axis, scale_key, bit) in AXES.items():
        table = reader.table(top, section)
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
        reader.done(table, section, {scale_key, "max_rate", "accel", "jerk", "jog_rate", "invert", "current_ma", "microsteps"}
                    | ({"limit"} if axis in ("r", "z") else set()) | ({"fitted"} if axis == "h" else set()))
    settings["dir_invert"] = dir_invert

    probe = reader.table(top, "probe")
    settings["probe_invert"] = int(reader.flag(probe, "invert", False, "probe"))
    if "brake_ms" in probe:
        settings["probe_ms"] = reader.integer(probe, "brake_ms", "probe", 0, PROBE_MS_MAX)
    reader.done(probe, "probe", {"invert", "brake_ms"})

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
    reader.done(output, "output", {"pwm_hz", "s_max", "s_min", "invert", "test_ms"})

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
    for key, (low, high) in HOST_KEYS.items():
        if key in host_table:
            value = reader.number(host_table, key, "host")
            if not (low <= value <= high) or (key != "spinup" and value <= 0):
                raise MachineError(f"{where}: [host] {key} must be above {low:g} and at most {high:g}")
            host[key] = value
    reader.done(host_table, "host", set(HOST_KEYS))
    reader.done(top, None, {"name", "description", "kinematics", "tool", *AXES, "probe", "output", "drivers", "host"})

    return Machine(
        id=machine_id,
        name=name,
        description=description,
        kinematics=kinematics,
        tool=tool,
        focus=bool(settings["h_axis"]),
        settings=settings,
        host=host,
    )


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


def current(machines: list[Machine], values: dict) -> str | None:
    """The id of the machine the live settings are, or None for a machine
    that is no file's."""
    for machine in machines:
        if matches(machine, values):
            return machine.id
    return None


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
