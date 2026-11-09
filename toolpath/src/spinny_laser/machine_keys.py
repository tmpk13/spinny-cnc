"""Where each firmware setting is written in a machine file, and a file's
text brought to the values a board runs with.

`KEYS` names, for every firmware setting, the section and key a machine
file sets it with (spinny_laser.machines reads them the other way) and how
the setting holds it: a number as it is, a flag as 0/1, one bit of a mask,
an endstop word by its index, a socket letter by its digit, the scale in
full steps or as the firmware's number. `value_of` reads a key's value out
of a full set of settings, so a file's and a board's can be compared key by
key, and `from_board` writes the keys whose values differ into the text,
comments and order kept.
"""

from __future__ import annotations

import json
import math
import re
import sys
from dataclasses import asdict, dataclass

from spinny_laser.machines import AXES, ENDSTOPS, FIRMWARE_DEFAULTS, SOCKETS, TUNING_KEYS, MachineError, close, parse

# How a key's value sits in its setting.
NUMBER, INTEGER, FLAG, BIT, WORD, SOCKET, SCALE, KINEMATICS, TOOL, HOST = (
    "number", "integer", "flag", "bit", "word", "socket", "scale", "kinematics", "tool", "host",
)


@dataclass(frozen=True)
class Key:
    # The firmware setting, or for the host's own values `host.<key>`.
    setting: str
    # The file's section, None for its top; `table` stands for `dispenser`
    # on a dispenser, whose plunger turns on the table's driver.
    section: str | None
    key: str
    kind: str
    # The bit of a mask, or the digit of `sockets`, counted from 0.
    bit: int = 0

    def to_dict(self) -> dict:
        return asdict(self)


def _axis_keys(section: str, axis: str, bit: int, scale_key: str) -> list[Key]:
    keys = [
        Key(f"{axis}_steps", section, f"full_{scale_key}", SCALE),
        Key(f"{axis}_rate", section, "max_rate", NUMBER),
        Key(f"{axis}_accel", section, "accel", NUMBER),
        Key(f"{axis}_jerk", section, "jerk", NUMBER),
        Key(f"jog_{axis}", section, "jog_rate", NUMBER),
    ]
    if axis in ("r", "z"):
        keys.append(Key(f"{axis}_max", section, "limit", NUMBER))
    if axis == "h":
        keys.insert(0, Key("h_axis", section, "fitted", FLAG))
    keys += [
        Key("dir_invert", section, "invert", BIT, bit),
        Key(f"tmc_{axis}_ma", section, "current_ma", INTEGER),
        Key(f"tmc_{axis}_micro", section, "microsteps", INTEGER),
        Key("sockets", section, "socket", SOCKET, bit),
        Key(f"{axis}_stop", section, "endstop", WORD),
        Key(f"{axis}_stop_pin", section, "endstop_pin", INTEGER),
        Key("stop_invert", section, "endstop_invert", BIT, bit),
        Key("limits", section, "endstop_halt", BIT, bit),
        Key(f"{axis}_home_pull", section, "home_pull", NUMBER),
        Key(f"{axis}_home_pos", section, "home_pos", NUMBER),
        Key(f"{axis}_home_travel", section, "home_travel", NUMBER),
    ]
    return keys


def _keys() -> tuple[Key, ...]:
    keys = [
        Key("cartesian", None, "kinematics", KINEMATICS),
        Key("spindle", None, "tool", TOOL),
    ]
    for section, (axis, scale_key, bit) in AXES.items():
        keys += _axis_keys(section, axis, bit, scale_key)
    keys += [
        Key("probe_invert", "probe", "invert", FLAG),
        Key("probe_ms", "probe", "brake_ms", INTEGER),
        Key("probe_pin", "probe", "pin", INTEGER),
        Key("laser_hz", "output", "pwm_hz", INTEGER),
        Key("s_max", "output", "s_max", NUMBER),
        Key("s_min", "output", "s_min", NUMBER),
        Key("laser_invert", "output", "invert", FLAG),
        Key("laser_ms", "output", "test_ms", INTEGER),
        Key("laser_pin", "output", "pin", INTEGER),
        Key("tool_out", "enable", "fitted", FLAG),
        Key("tool_pin", "enable", "pin", INTEGER),
        Key("tool_invert", "enable", "invert", FLAG),
        Key("en_invert", "drivers", "enable_invert", FLAG),
        Key("idle_ms", "drivers", "idle_ms", INTEGER),
        Key("step_us", "drivers", "step_us", INTEGER),
        Key("tmc_hold_pct", "drivers", "hold_pct", INTEGER),
        Key("tmc_stealth", "drivers", "stealth", FLAG),
        Key("tmc_intpol", "drivers", "interpolate", FLAG),
        *(Key(f"tmc_{key}", "drivers", key, INTEGER) for key in TUNING_KEYS),
    ]
    for key in ("tolerance", "travel", "clearance", "spinup", "speed_control", "gap", "retract", "output", "extrude_rate", "dwell_ms"):
        keys.append(Key(f"host.{key}", "host", key, HOST))
    return tuple(keys)


KEYS = _keys()


def section_for(key: Key, tool: str) -> str | None:
    """The section a key is in for a machine with this tool."""
    return "dispenser" if key.section == "table" and tool == "dispenser" else key.section


def value_of(key: Key, settings: dict, host: dict | None = None) -> object:
    """The key's value as a file would say it, read from a full set of
    settings (and the host's values for a host key); None when they do
    not hold it."""
    if key.kind == HOST:
        return (host or {}).get(key.key)
    if key.setting not in settings and key.kind not in (TOOL,):
        return None
    if key.kind == KINEMATICS:
        return "cartesian" if settings["cartesian"] else "polar"
    if key.kind == TOOL:
        if settings.get("spindle"):
            return "spindle"
        return "dispenser" if settings.get("dispenser") else "laser"
    value = settings[key.setting]
    if key.kind == FLAG:
        return bool(value)
    if key.kind == BIT:
        return bool(int(value) >> key.bit & 1)
    if key.kind == WORD:
        index = int(value)
        return ENDSTOPS[index] if 0 <= index < len(ENDSTOPS) else None
    if key.kind == SOCKET:
        digits = str(int(value))
        if len(digits) != len(SOCKETS) or key.bit >= len(digits):
            return None
        digit = int(digits[key.bit])
        return SOCKETS[digit - 1] if 1 <= digit <= len(SOCKETS) else None
    if key.kind == INTEGER:
        return int(value)
    return float(value)


def same(a: object, b: object) -> bool:
    """Equal as a key's value, numbers as far as the firmware can tell."""
    if isinstance(a, bool) or isinstance(b, bool) or not isinstance(a, (int, float)) or not isinstance(b, (int, float)):
        return a == b
    return close(float(a), float(b))


def toml_value(value: object) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return f'"{value}"'
    if isinstance(value, int) or (isinstance(value, float) and value.is_integer() and abs(value) < 1e15):
        return str(int(value))
    assert isinstance(value, float) and math.isfinite(value)
    return f"{value:.10f}".rstrip("0").rstrip(".")


# --- the text --------------------------------------------------------------

_HEADER = re.compile(r"^\s*\[\[?\s*([A-Za-z0-9_.\-]+)\s*\]\]?\s*(#.*)?$")


def _split_comment(rest: str) -> tuple[str, str]:
    """A value and the comment after it, the `#` outside any string."""
    quote = None
    escaped = False
    for i, char in enumerate(rest):
        if quote:
            if escaped:
                escaped = False
            elif char == "\\" and quote == '"':
                escaped = True
            elif char == quote:
                quote = None
        elif char in "\"'":
            quote = char
        elif char == "#":
            return rest[:i], rest[i:]
    return rest, ""


def _sections(lines: list[str]) -> list[tuple[str | None, int, int]]:
    """Each section as (name, first line after its header, end), the top
    first with no header."""
    spans: list[tuple[str | None, int, int]] = []
    name: str | None = None
    start = 0
    for i, line in enumerate(lines):
        found = _HEADER.match(line)
        if found:
            spans.append((name, start, i))
            name, start = found.group(1), i + 1
    spans.append((name, start, len(lines)))
    return spans


def has_key(text: str, section: str | None, key: str) -> bool:
    lines = text.split("\n")
    pattern = re.compile(rf"^\s*{re.escape(key)}\s*=")
    return any(pattern.match(lines[i]) for name, a, b in _sections(lines) if name == section for i in range(a, b))


def set_key(text: str, section: str | None, key: str, value: object) -> str:
    """The text with `key = value` in its section: the line's value replaced
    and its comment kept, or a line added after the section's last key, or
    the section added before [controls] (or at the end)."""
    lines = text.split("\n")
    written = toml_value(value)
    pattern = re.compile(rf"^(\s*{re.escape(key)}\s*=\s*)(.*)$")
    spans = _sections(lines)
    for name, a, b in spans:
        if name != section:
            continue
        for i in range(a, b):
            found = pattern.match(lines[i])
            if found:
                old, comment = _split_comment(found.group(2))
                if comment:
                    # The comment stays in its column where the value fits.
                    width = len(old)
                    lines[i] = found.group(1) + written.ljust(width - 1 if len(written) < width else len(written)) + " " + comment
                else:
                    lines[i] = found.group(1) + written
                return "\n".join(lines)
        last = a - 1
        for i in range(a, b):
            stripped = lines[i].strip()
            if stripped and not stripped.startswith("#"):
                last = i
        if section is None and last < a:
            # A top with no keys: after its leading comments.
            last = next((i for i in range(a, b) if not lines[i].strip().startswith("#")), b) - 1
        lines.insert(last + 1, f"{key} = {written}")
        return "\n".join(lines)
    assert section is not None
    block = [f"[{section}]", f"{key} = {written}", ""]
    at = next((a - 1 for name, a, _ in spans if name is not None and (name == "controls" or name.startswith("controls."))), None)
    if at is None:
        while lines and lines[-1] == "":
            lines.pop()
        return "\n".join(lines + ["", *block])
    lines[at:at] = block
    return "\n".join(lines)


@dataclass
class FromBoard:
    text: str
    # One line per key written: `[rail] max_rate = 900 (was 600)`.
    changes: list[str]
    # Settings the text still does not give the board's value for.
    left: list[str]


def from_board(text: str, live: dict, host: dict | None = None, where: str = "machine") -> FromBoard:
    """The text with every key whose value differs from the board's written
    to the board's value. A scale goes in the key the section already uses,
    else as full steps over the board's microsteps. A [host] key is written
    only when the file names it: one left out keeps the host's value, so it
    cannot differ. The text must read as a machine first."""
    machine = parse(text, "board", where)
    board_tool = value_of(Key("spindle", None, "tool", TOOL), live)
    if "dispenser" in (machine.tool, board_tool) and machine.tool != board_tool:
        raise MachineError(
            f"{where}: the board runs a {board_tool} and the file a {machine.tool}:"
            " the dispenser's plunger takes the [table]'s place, so change the tool and that section by hand"
        )
    changes: list[str] = []
    for key in KEYS:
        if key.kind == HOST:
            if not has_key(text, key.section, key.key) or host is None or host.get(key.key) is None:
                continue
            board = host[key.key]
            if key.key == "speed_control":
                board = bool(board)
            mine = machine.host.get(key.key)
            if key.key == "speed_control" and mine is not None:
                mine = bool(mine)
        else:
            board = value_of(key, live)
            mine = value_of(key, machine.settings)
        if board is None:
            continue
        section = section_for(key, machine.tool)
        name = key.key
        if key.kind == SCALE:
            plain = name.removeprefix("full_")
            if section == "dispenser":
                plain, name = "steps_per_mm", "full_steps_per_mm"
            assert isinstance(board, float) and isinstance(mine, float)
            if has_key(text, section, plain):
                name = plain
            else:
                # Compared as full steps: the same steps per mm at other
                # microsteps are other full steps, and the same full steps
                # at other microsteps need no line of their own.
                board = board / int(live.get(f"tmc_{key.setting[0]}_micro", 256))
                mine = mine / int(machine.settings[f"tmc_{key.setting[0]}_micro"])
        if same(board, mine):
            continue
        text = set_key(text, section, name, board)
        where_key = f"[{section}] {name}" if section else name
        changes.append(f"{where_key} = {toml_value(board)} (was {toml_value(mine) if mine is not None else 'unset'})")
    after = parse(text, "board", where)
    left = []
    for name, value in live.items():
        if name in after.settings and isinstance(value, (int, float)) and not close(float(value), float(after.settings[name])):
            left.append(name)
    return FromBoard(text, changes, left)


# Texts the page's twin is checked against: machines made up here, so an
# edit to a shipped file never moves the fixture.
SAMPLE_INTO = """name = "Into"
kinematics = "polar"

[rail]
full_steps_per_mm = 40      # 200 steps per turn, 5 mm per turn
max_rate = 560              # mm/min
microsteps = 256
socket = "X"

[table]
steps_per_deg = 14222.222
invert = false

[host]
tolerance = 0.005
clearance = 2               # mm

[controls]
pad = true
"""

SAMPLE_BOARD = """kinematics = "cartesian"
tool = "spindle"

[rail]
full_steps_per_mm = 50
microsteps = 32
max_rate = 1200
socket = "Y"
endstop = "min"
endstop_halt = true

[table]
steps_per_deg = 888.888
invert = true
socket = "X"

[focus]
fitted = true
full_steps_per_mm = 40
microsteps = 32

[probe]
pin = 26
brake_ms = 0

[drivers]
hold_pct = 30
interpolate = false
tpwmthrs = 234
"""


def fixture() -> dict:
    """The keys, what reading one sample board into another text gives, and
    the firmware's defaults in the order it lists them, for the page's twins
    to be checked against."""
    board = parse(SAMPLE_BOARD, "board").settings
    host = {"tolerance": 0.01, "clearance": 3.5, "travel": None, "spinup": 2.0}
    read = from_board(SAMPLE_INTO, board, host)
    return {
        "keys": [key.to_dict() for key in KEYS],
        "case": {"into": SAMPLE_INTO, "board": board, "host": host, "text": read.text, "changes": read.changes, "left": read.left},
        "defaults": dict(FIRMWARE_DEFAULTS),
    }


if __name__ == "__main__":
    json.dump(fixture(), sys.stdout, indent=4)
    sys.stdout.write("\n")
