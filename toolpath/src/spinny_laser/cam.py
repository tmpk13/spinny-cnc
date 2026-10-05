"""CAM profiles: the TOML files in `cam/` that describe a machine's axes, the
tools on it, the operations a design goes through with every cutting
setting, and how its gcode is written.

A profile is read whole and refused whole, every fault naming the file, the
table and the key, so a file written by hand or by a language model is
either taken as it stands or says what is wrong with it. `set_value` changes
one value in a file's text and keeps everything else as it was, comments
included.
"""

from __future__ import annotations

import json
import math
import re
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

LINEAR, ROTARY = "linear", "rotary"
KINDS = (LINEAR, ROTARY)
X, Y, DEPTH, RADIUS, ANGLE, SETUP = "x", "y", "depth", "radius", "angle", "setup"
ROLES = (X, Y, DEPTH, RADIUS, ANGLE, SETUP)
# One axis at most for each of these; any number of setup axes.
SINGLE_ROLES = (X, Y, DEPTH, RADIUS, ANGLE)
LASER, SPINDLE = "laser", "spindle"
TOOL_KINDS = (LASER, SPINDLE)
# A mill is a spindle: the file may say either.
TOOL_ALIASES = {"mill": SPINDLE}
ISOLATION, CLEARING, OUTLINE, DRILLS, DEPOSIT, PATHS = "isolation", "clearing", "outline", "drills", "deposit", "paths"
SOURCES = (ISOLATION, CLEARING, OUTLINE, DRILLS, DEPOSIT, PATHS)
PATTERNS = ("radial", "rings", "lines")
FILLS = ("contour", "radial", "rings", "lines")
MARKS = ("circle", "cross", "dot")
CENTER, CORNER, KEEP = "center", "corner", "keep"
ANCHORS = (CENTER, CORNER, KEEP)
MIRRORS = ("none", "x", "y")
CARTESIAN, POLAR = "cartesian", "polar"

MAX_VALUE = 1.0e6
MAX_DEPTH = 50.0
MAX_PASSES = 100
MAX_LOOPS = 50
MAX_WIDTH = 1000.0
DEFAULT_PLUNGE = 60.0
DEFAULT_DEPTH = 0.1
DEFAULT_STEPOVER = 0.5
DEFAULT_SPINUP = 2.0
DEFAULT_DECIMALS = 3
DEFAULT_HEADER = ("G21", "G90", "G94", "G17")
DEFAULT_FOOTER = ("M5", "M2")
# A profile's id is its file's stem, and it becomes a file name again when
# the page saves it.
ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")

# The cutting settings a tool of each kind gives the operations that use
# it, and the bounds each is checked against: (low, high, low allowed).
# An operation may name any of them again to cut otherwise than the tool's
# default, and `depth` for a spindle is usually the operation's own.
SPINDLE_SETTINGS: dict[str, tuple[float, float, bool]] = {
    "rpm": (0.0, MAX_VALUE, False),
    "feed": (0.0, MAX_VALUE, False),
    "plunge": (0.0, MAX_VALUE, False),
    "depth": (0.0, MAX_DEPTH, False),
    "step_down": (0.0, MAX_DEPTH, True),
    "stepover": (0.0, 1.0, False),
}
LASER_SETTINGS: dict[str, tuple[float, float, bool]] = {
    "power": (0.0, MAX_VALUE, True),
    "min_power": (0.0, MAX_VALUE, True),
    "speed": (0.0, MAX_VALUE, False),
    "height": (-MAX_WIDTH, MAX_WIDTH, True),
}
SETTINGS_BY_KIND = {SPINDLE: SPINDLE_SETTINGS, LASER: LASER_SETTINGS}
REQUIRED_BY_KIND = {SPINDLE: ("rpm", "feed"), LASER: ("power", "speed")}
# What an operation may say besides a cutting setting, by source.
OPERATION_KEYS = {"name", "source", "tool", "enabled", "passes", "loops", "pattern", "fill", "marks", "match"}


class CamError(ValueError):
    """A profile that cannot be taken: the message names the file, the table and the key."""


@dataclass(frozen=True)
class Axis:
    letter: str
    kind: str
    role: str
    # Travel, in the axis' own units; None is no check.
    min: float | None
    max: float | None
    # The fastest feed, and the rapid rate, units per minute; None is no cap.
    rate: float | None
    rapid: float | None
    # The machine coordinate of board 0 (of the surface, for the depth axis).
    offset: float
    # Where the program ends, when it has one.
    home: float | None
    # The depth axis: how far over the surface the tool travels.
    safe: float | None
    # A setup axis: where it is put before anything else moves.
    park: float | None

    def document(self) -> dict:
        return {
            "letter": self.letter,
            "kind": self.kind,
            "role": self.role,
            "min": self.min,
            "max": self.max,
            "rate": self.rate,
            "rapid": self.rapid,
            "offset": self.offset,
            "home": self.home,
            "safe": self.safe,
            "park": self.park,
        }


@dataclass(frozen=True)
class Tool:
    id: str
    kind: str
    name: str
    # The width of the cut: a bit's diameter, a beam's spot.
    width: float
    # The cutting settings the file gives it, by key.
    settings: dict[str, float]

    def document(self) -> dict:
        return {"id": self.id, "kind": self.kind, "name": self.name, "width": self.width, "settings": dict(self.settings)}


@dataclass(frozen=True)
class Operation:
    name: str
    source: str
    tool: str
    enabled: bool
    # Every key the operation gives itself, cutting settings and its own.
    settings: dict[str, Any]
    # The cutting settings it runs with: the tool's, the operation's over
    # them, and the pass count worked out from the depth and the step down.
    cutting: dict[str, float]

    def document(self) -> dict:
        return {
            "name": self.name,
            "source": self.source,
            "tool": self.tool,
            "enabled": self.enabled,
            "settings": dict(self.settings),
            "cutting": dict(self.cutting),
        }


@dataclass(frozen=True)
class Post:
    header: tuple[str, ...]
    footer: tuple[str, ...]
    spindle_on: str
    laser_on: str
    spinup: float
    decimals: int
    return_home: bool

    def document(self) -> dict:
        return {
            "header": list(self.header),
            "footer": list(self.footer),
            "spindle_on": self.spindle_on,
            "laser_on": self.laser_on,
            "spinup": self.spinup,
            "decimals": self.decimals,
            "return_home": self.return_home,
        }


@dataclass(frozen=True)
class Placement:
    anchor: str
    offset: tuple[float, float]
    layer: str
    mirror: str

    def document(self) -> dict:
        return {"anchor": self.anchor, "offset": list(self.offset), "layer": self.layer, "mirror": self.mirror}


@dataclass(frozen=True)
class Profile:
    id: str
    name: str
    description: str
    # The machines/ file whose firmware runs this profile's jobs through the
    # backend; None for a machine that only takes the gcode.
    machine: str | None
    axes: tuple[Axis, ...]
    tools: tuple[Tool, ...]
    operations: tuple[Operation, ...]
    post: Post
    placement: Placement

    @property
    def kinematics(self) -> str:
        return CARTESIAN if self.axis(X) is not None else POLAR

    def axis(self, role: str) -> Axis | None:
        for axis in self.axes:
            if axis.role == role:
                return axis
        return None

    def tool(self, tool_id: str) -> Tool:
        for tool in self.tools:
            if tool.id == tool_id:
                return tool
        raise CamError(f"no tool {tool_id!r} in {self.id}")

    @property
    def tool_kinds(self) -> list[str]:
        """The kinds of tool the enabled operations use, in order of first use."""
        kinds: list[str] = []
        for operation in self.operations:
            kind = self.tool(operation.tool).kind
            if operation.enabled and kind not in kinds:
                kinds.append(kind)
        return kinds

    def summary(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "machine": self.machine,
            "kinematics": self.kinematics,
            "tools": self.tool_kinds,
            "axes": "".join(axis.letter for axis in self.axes),
            "operations": sum(1 for operation in self.operations if operation.enabled),
        }

    def document(self) -> dict:
        return {
            **self.summary(),
            "axes": [axis.document() for axis in self.axes],
            "tools": [tool.document() for tool in self.tools],
            "operations": [operation.document() for operation in self.operations],
            "post": self.post.document(),
            "placement": self.placement.document(),
        }


# --- reading ----------------------------------------------------------------


def check_id(profile_id: str) -> str:
    if not ID_PATTERN.match(profile_id):
        raise CamError(
            f"{profile_id!r} is not a profile id: lower case letters, digits, - and _, starting with a letter or digit, at most 64"
        )
    return profile_id


def load(path: Path | str) -> Profile:
    """Reads one profile; its id is the file's stem."""
    path = Path(path)
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise CamError(f"{path}: {exc.strerror or exc}") from exc
    return parse(text, path.stem, str(path))


def load_all(directory: Path | str) -> tuple[list[Profile], list[str]]:
    """Every `*.toml` in a directory, by id, with a message for each file
    that could not be taken, so one bad file does not hide the others."""
    directory = Path(directory)
    profiles: list[Profile] = []
    problems: list[str] = []
    if not directory.is_dir():
        return profiles, problems
    for path in sorted(directory.glob("*.toml")):
        try:
            profiles.append(load(path))
        except CamError as exc:
            problems.append(str(exc))
    return profiles, problems


def parse(text: str, profile_id: str, where: str = "profile") -> Profile:
    try:
        data = tomllib.loads(text)
    except tomllib.TOMLDecodeError as exc:
        raise CamError(f"{where}: {exc}") from exc
    reader = _Reader(where)
    name = reader.text(data, None, "name", profile_id)
    description = reader.text(data, None, "description", "")
    machine = reader.text(data, None, "machine", "") or None
    if machine is not None and not ID_PATTERN.match(machine):
        raise reader.fail(None, "machine", "must be the stem of a file in machines/")
    axes = tuple(reader.axis(table, index) for index, table in enumerate(reader.tables(data, "axes")))
    tools = tuple(reader.tool(table, index) for index, table in enumerate(reader.tables(data, "tools")))
    tool_ids = [tool.id for tool in tools]
    for tool_id in tool_ids:
        if tool_ids.count(tool_id) > 1:
            raise reader.fail("[[tools]]", "id", f"{tool_id!r} is given twice")
    by_id = {tool.id: tool for tool in tools}
    operations = tuple(
        reader.operation(table, index, by_id) for index, table in enumerate(reader.tables(data, "operations"))
    )
    post = reader.post(data)
    placement = reader.placement(data)
    reader.done(data, None, {"name", "description", "machine", "axes", "tools", "operations", "post", "placement"})
    _check_axes(reader, axes)
    if not tools:
        raise reader.fail(None, "tools", "the profile needs a tool: a [[tools]] table")
    names = [operation.name for operation in operations]
    for name_ in names:
        if names.count(name_) > 1:
            raise reader.fail("[[operations]]", "name", f"{name_!r} is given twice")
    return Profile(
        id=profile_id,
        name=name,
        description=description,
        machine=machine,
        axes=axes,
        tools=tools,
        operations=operations,
        post=post,
        placement=placement,
    )


def _check_axes(reader: "_Reader", axes: tuple[Axis, ...]) -> None:
    letters = [axis.letter for axis in axes]
    for letter in letters:
        if letters.count(letter) > 1:
            raise reader.fail("[[axes]]", "letter", f"{letter} is given twice")
    roles = [axis.role for axis in axes]
    for role in SINGLE_ROLES:
        if roles.count(role) > 1:
            raise reader.fail("[[axes]]", "role", f"two axes are {role!r}; one at most")
    plane = {X, Y} <= set(roles)
    polar = {RADIUS, ANGLE} <= set(roles)
    if plane == polar:
        raise reader.fail(
            "[[axes]]",
            "role",
            "the axes need x and y (a cartesian machine), or radius and angle (a polar one), and not both",
        )
    for axis in axes:
        if axis.role == ANGLE and axis.kind != ROTARY:
            raise reader.fail("[[axes]]", "kind", f"{axis.letter} is the angle, which turns: kind must be {ROTARY!r}")
        if axis.role in (X, Y, DEPTH, RADIUS) and axis.kind != LINEAR:
            raise reader.fail("[[axes]]", "kind", f"{axis.letter} is {axis.role!r}, which must be {LINEAR!r}")
        if axis.role == DEPTH and axis.safe is None:
            raise reader.fail("[[axes]]", "safe", f"{axis.letter} is the depth axis and needs a safe height over the surface")


class _Reader:
    """Typed reads of the TOML tables with one error style."""

    def __init__(self, where: str) -> None:
        self.where = where

    def fail(self, section: str | None, key: str, what: str) -> CamError:
        place = f"{section} {key}" if section else key
        return CamError(f"{self.where}: {place} {what}")

    def tables(self, top: dict, name: str) -> list[dict]:
        found = top.get(name, [])
        if not isinstance(found, list) or not all(isinstance(item, dict) for item in found):
            raise self.fail(None, name, f"must be [[{name}]] tables")
        return found

    def table(self, top: dict, name: str) -> dict:
        found = top.get(name, {})
        if not isinstance(found, dict):
            raise self.fail(None, name, "must be a table")
        return found

    def text(self, table: dict, section: str | None, key: str, default: str) -> str:
        value = table.get(key, default)
        if not isinstance(value, str):
            raise self.fail(section, key, "must be a string")
        return value

    def choice(self, table: dict, section: str | None, key: str, choices: tuple[str, ...], default: str | None) -> str:
        value = table.get(key, default)
        if value is None:
            raise self.fail(section, key, f"is needed: one of {', '.join(choices)}")
        if not isinstance(value, str) or value not in choices:
            raise self.fail(section, key, f"must be one of {', '.join(choices)}")
        return value

    def flag(self, table: dict, section: str | None, key: str, default: bool) -> bool:
        value = table.get(key, default)
        if not isinstance(value, bool):
            raise self.fail(section, key, "must be true or false")
        return value

    def number(self, table: dict, section: str | None, key: str) -> float | None:
        value = table.get(key)
        if value is None:
            return None
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise self.fail(section, key, "must be a number")
        if abs(value) > MAX_VALUE:
            raise self.fail(section, key, f"must be within {MAX_VALUE:g}")
        return float(value)

    def bounded(self, table: dict, section: str | None, key: str, low: float, high: float, low_ok: bool) -> float | None:
        value = self.number(table, section, key)
        if value is None:
            return None
        if value > high or value < low or (value == low and not low_ok):
            start = "at least" if low_ok else "above"
            raise self.fail(section, key, f"must be {start} {low:g} and at most {high:g}")
        return value

    def integer(self, table: dict, section: str | None, key: str, low: int, high: int) -> int | None:
        value = table.get(key)
        if value is None:
            return None
        if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
            raise self.fail(section, key, f"must be a whole number from {low} to {high}")
        return value

    def strings(self, table: dict, section: str | None, key: str, default: tuple[str, ...]) -> tuple[str, ...]:
        value = table.get(key)
        if value is None:
            return default
        if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
            raise self.fail(section, key, "must be a list of strings")
        return tuple(value)

    def done(self, table: dict, section: str | None, known: set[str]) -> None:
        unknown = sorted(set(table) - known)
        if unknown:
            raise self.fail(section, unknown[0], f"is not a key here; the keys are {', '.join(sorted(known))}")

    # --- the tables ---------------------------------------------------------

    def axis(self, table: dict, index: int) -> Axis:
        section = f"[[axes]] {index + 1}"
        letter = self.text(table, section, "letter", "")
        if not (len(letter) == 1 and letter.isascii() and letter.isalpha()):
            raise self.fail(section, "letter", "must be one letter, A to Z")
        letter = letter.upper()
        section = f"[[axes]] {letter}"
        kind = self.choice(table, section, "kind", KINDS, LINEAR)
        role = self.choice(table, section, "role", ROLES, None)
        low = self.number(table, section, "min")
        high = self.number(table, section, "max")
        if low is not None and high is not None and low >= high:
            raise self.fail(section, "max", "must be above min")
        rate = self.bounded(table, section, "rate", 0.0, MAX_VALUE, False)
        rapid = self.bounded(table, section, "rapid", 0.0, MAX_VALUE, False)
        offset = self.number(table, section, "offset") or 0.0
        home = self.number(table, section, "home")
        safe = self.bounded(table, section, "safe", 0.0, MAX_WIDTH, False)
        park = self.number(table, section, "park")
        if safe is not None and role != DEPTH:
            raise self.fail(section, "safe", "is the depth axis' travel height; this axis is not the depth")
        if park is not None and role != SETUP:
            raise self.fail(section, "park", "is where a setup axis is put; this axis is not one")
        self.done(table, section, {"letter", "kind", "role", "min", "max", "rate", "rapid", "offset", "home", "safe", "park"})
        return Axis(letter, kind, role, low, high, rate, rapid, offset, home, safe, park)

    def tool(self, table: dict, index: int) -> Tool:
        section = f"[[tools]] {index + 1}"
        tool_id = self.text(table, section, "id", "")
        if not ID_PATTERN.match(tool_id):
            raise self.fail(section, "id", "is needed: lower case letters, digits, - and _")
        section = f"[[tools]] {tool_id}"
        kind = self.text(table, section, "kind", "")
        kind = TOOL_ALIASES.get(kind, kind)
        if kind not in TOOL_KINDS:
            raise self.fail(section, "kind", f"must be one of {', '.join(TOOL_KINDS)}, or mill")
        name = self.text(table, section, "name", tool_id)
        width = self.bounded(table, section, "diameter", 0.0, MAX_WIDTH, False)
        spot = self.bounded(table, section, "spot", 0.0, MAX_WIDTH, False)
        if width is not None and spot is not None:
            raise self.fail(section, "spot", "and diameter are the same width; give one")
        width = width if width is not None else spot
        if width is None:
            raise self.fail(section, "diameter" if kind == SPINDLE else "spot", "is needed: the width of the cut, mm")
        bounds = SETTINGS_BY_KIND[kind]
        settings: dict[str, float] = {}
        for key, (low, high, low_ok) in bounds.items():
            value = self.bounded(table, section, key, low, high, low_ok)
            if value is not None:
                settings[key] = value
        passes = self.integer(table, section, "passes", 1, MAX_PASSES)
        if passes is not None:
            settings["passes"] = float(passes)
        for key in REQUIRED_BY_KIND[kind]:
            if key not in settings:
                raise self.fail(section, key, "is needed")
        self.done(table, section, {"id", "kind", "name", "diameter", "spot", "passes", *bounds})
        return Tool(tool_id, kind, name, width, settings)

    def operation(self, table: dict, index: int, tools: dict[str, Tool]) -> Operation:
        section = f"[[operations]] {index + 1}"
        name = self.text(table, section, "name", "")
        if not name.strip():
            raise self.fail(section, "name", "is needed")
        section = f"[[operations]] {name}"
        source = self.choice(table, section, "source", SOURCES, None)
        tool_id = self.text(table, section, "tool", "")
        if tool_id not in tools:
            known = ", ".join(tools) or "none yet"
            raise self.fail(section, "tool", f"must name a [[tools]] id: {known}")
        tool = tools[tool_id]
        enabled = self.flag(table, section, "enabled", True)
        bounds = SETTINGS_BY_KIND[tool.kind]
        settings: dict[str, Any] = {}
        for key, (low, high, low_ok) in bounds.items():
            value = self.bounded(table, section, key, low, high, low_ok)
            if value is not None:
                settings[key] = value
        passes = self.integer(table, section, "passes", 1, MAX_PASSES)
        if passes is not None:
            settings["passes"] = passes
        loops = self.integer(table, section, "loops", 1, MAX_LOOPS)
        if loops is not None:
            if source not in (ISOLATION, DEPOSIT):
                raise self.fail(section, "loops", "counts isolation or deposit loops; this operation is neither")
            settings["loops"] = loops
        if "pattern" in table:
            if source != CLEARING:
                raise self.fail(section, "pattern", "is how clearing fills; this operation is not clearing")
            settings["pattern"] = self.choice(table, section, "pattern", PATTERNS, None)
        if "fill" in table:
            if source != DEPOSIT:
                raise self.fail(section, "fill", "is how a deposit fills the copper; this operation is not a deposit")
            settings["fill"] = self.choice(table, section, "fill", FILLS, None)
        if "marks" in table:
            if source != DRILLS or tool.kind != LASER:
                raise self.fail(section, "marks", "is how a laser marks the drills; this operation is not that")
            settings["marks"] = self.choice(table, section, "marks", MARKS, None)
        if "match" in table:
            if source != PATHS:
                raise self.fail(section, "match", "picks imported paths by their label; this operation does not take paths")
            settings["match"] = self.text(table, section, "match", "")
        self.done(table, section, OPERATION_KEYS | set(bounds))
        cutting = resolve(tool, settings)
        if tool.kind == SPINDLE and cutting["passes"] > MAX_PASSES:
            raise self.fail(section, "step_down", f"gives more than {MAX_PASSES} passes to the depth")
        return Operation(name, source, tool_id, enabled, settings, cutting)

    def post(self, top: dict) -> Post:
        table = self.table(top, "post")
        section = "[post]"
        header = self.strings(table, section, "header", DEFAULT_HEADER)
        footer = self.strings(table, section, "footer", DEFAULT_FOOTER)
        spindle_on = self.text(table, section, "spindle_on", "M3").strip().upper()
        laser_on = self.text(table, section, "laser_on", "M4").strip().upper()
        if spindle_on not in ("M3", "M4"):
            raise self.fail(section, "spindle_on", "must be M3 or M4")
        if laser_on not in ("M3", "M4"):
            raise self.fail(section, "laser_on", "must be M3 or M4")
        spinup = self.bounded(table, section, "spinup", 0.0, 600.0, True)
        decimals = self.integer(table, section, "decimals", 1, 6)
        return_home = self.flag(table, section, "return_home", True)
        self.done(table, section, {"header", "footer", "spindle_on", "laser_on", "spinup", "decimals", "return_home"})
        return Post(
            header,
            footer,
            spindle_on,
            laser_on,
            DEFAULT_SPINUP if spinup is None else spinup,
            DEFAULT_DECIMALS if decimals is None else decimals,
            return_home,
        )

    def placement(self, top: dict) -> Placement:
        table = self.table(top, "placement")
        section = "[placement]"
        anchor = self.choice(table, section, "anchor", ANCHORS, CENTER)
        offset = table.get("offset", [0.0, 0.0])
        if (
            not isinstance(offset, list)
            or len(offset) != 2
            or not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in offset)
            or any(abs(v) > MAX_VALUE for v in offset)
        ):
            raise self.fail(section, "offset", "must be [x, y] in mm")
        layer = self.text(table, section, "layer", "F.Cu")
        mirror = self.choice(table, section, "mirror", MIRRORS, "none")
        self.done(table, section, {"anchor", "offset", "layer", "mirror"})
        return Placement(anchor, (float(offset[0]), float(offset[1])), layer, mirror)


def resolve(tool: Tool, settings: dict[str, Any]) -> dict[str, float]:
    """The settings an operation cuts with: the tool's defaults, the
    operation's own over them, and the pass count.

    A spindle's passes come from its depth and step down (each pass a step
    deeper, the last at the depth) unless the operation counts them itself;
    a laser's are how many times it goes over the paths.
    """
    cutting: dict[str, float] = {}
    keys = set(SETTINGS_BY_KIND[tool.kind]) | {"passes"}
    for key in keys:
        if key in settings:
            cutting[key] = float(settings[key])
        elif key in tool.settings:
            cutting[key] = float(tool.settings[key])
    if tool.kind == SPINDLE:
        cutting.setdefault("plunge", DEFAULT_PLUNGE)
        cutting.setdefault("depth", DEFAULT_DEPTH)
        cutting.setdefault("step_down", 0.0)
        cutting.setdefault("stepover", DEFAULT_STEPOVER)
        if "passes" not in cutting:
            step = cutting["step_down"]
            cutting["passes"] = float(math.ceil(cutting["depth"] / step - 1e-9)) if step > 0 else 1.0
    else:
        cutting.setdefault("min_power", 0.0)
        cutting.setdefault("passes", 1.0)
    cutting["width"] = tool.width
    return cutting


# --- editing the text -------------------------------------------------------

_HEADER = re.compile(r"^\s*\[\[\s*([A-Za-z0-9_-]+)\s*\]\]\s*(#.*)?$")
_TABLE = re.compile(r"^\s*\[\s*([A-Za-z0-9_-]+)\s*\]\s*(#.*)?$")


def _key_pattern(key: str) -> re.Pattern:
    return re.compile(r"^(\s*" + re.escape(key) + r"\s*=\s*)(.*)$")


def _value_end(rest: str) -> int:
    """Where the value in `rest` (the text after `=`) ends, so a comment
    after it can be kept: a string to its closing quote, an array or inline
    table to its closing bracket, anything else up to a `#` or the end."""
    if not rest:
        return 0
    first = rest[0]
    if first in "\"'":
        index = 1
        while index < len(rest):
            if rest[index] == "\\" and first == '"':
                index += 2
                continue
            if rest[index] == first:
                return index + 1
            index += 1
        return len(rest)
    if first in "[{":
        close = "]" if first == "[" else "}"
        depth = 0
        quote: str | None = None
        index = 0
        while index < len(rest):
            char = rest[index]
            if quote is not None:
                if char == "\\" and quote == '"':
                    index += 1
                elif char == quote:
                    quote = None
            elif char in "\"'":
                quote = char
            elif char == first:
                depth += 1
            elif char == close:
                depth -= 1
                if depth == 0:
                    return index + 1
            elif char == "#":
                break
            index += 1
        return len(rest)
    hash_at = rest.find("#")
    end = len(rest) if hash_at < 0 else hash_at
    return len(rest[:end].rstrip())


def format_value(value: Any) -> str:
    """A value as TOML writes it."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise CamError("a value must be a number")
        return repr(value)
    if isinstance(value, str):
        return json.dumps(value)
    if isinstance(value, (list, tuple)):
        return "[" + ", ".join(format_value(item) for item in value) + "]"
    raise CamError(f"cannot write a value of type {type(value).__name__}")


def _table_range(lines: list[str], table: tuple) -> tuple[int, int]:
    """The line after the table's header, and the line of the next header
    (or the end); the top level is everything before the first header."""
    counts: dict[str, int] = {}
    start: int | None = 0 if table == () else None
    for index, line in enumerate(lines):
        header = _HEADER.match(line)
        plain = _TABLE.match(line) if header is None else None
        if header is None and plain is None:
            continue
        if start is not None:
            return start, index
        if header is not None:
            name = header.group(1)
            if table == (name, counts.get(name, 0)):
                start = index + 1
            counts[name] = counts.get(name, 0) + 1
        elif plain is not None and table == (plain.group(1),):
            start = index + 1
    if start is None:
        if len(table) == 2:
            raise CamError(f"no [[{table[0]}]] table {table[1] + 1} in the file")
        raise CamError(f"no [{table[0]}] table in the file")
    return start, len(lines)


def set_value(text: str, path: tuple, value: Any) -> str:
    """The file's text with one value changed and everything else, comments
    included, as it was.

    `path` names the table and the key: `("name",)` for a key at the top,
    `("post", "spinup")` for one in `[post]`, `("operations", 2, "depth")`
    for one in the third `[[operations]]` table. A key that is not there is
    added at the end of its table; `None` takes a key out. A table that is
    not there is refused, as is a value that does not read back.
    """
    if not path or not isinstance(path[-1], str) or not re.match(r"^[A-Za-z0-9_-]+$", path[-1]):
        raise CamError("the path must end in a key")
    table = tuple(path[:-1])
    if len(table) == 2 and (not isinstance(table[0], str) or not isinstance(table[1], int) or table[1] < 0):
        raise CamError("a table in an array is named by its name and its index")
    if len(table) == 1 and not isinstance(table[0], str):
        raise CamError("a table is named by its name")
    if len(table) > 2:
        raise CamError("the path goes no deeper than a table and a key")
    key = path[-1]
    lines = text.split("\n")
    start, end = _table_range(lines, table)
    pattern = _key_pattern(key)
    found = next((index for index in range(start, end) if pattern.match(lines[index])), None)
    if value is None:
        if found is not None:
            del lines[found]
    elif found is not None:
        match = pattern.match(lines[found])
        assert match is not None
        rest = match.group(2)
        cut = _value_end(rest)
        lines[found] = match.group(1) + format_value(value) + rest[cut:]
    else:
        # After the table's last line that says something, so blank lines
        # left before the next header stay where they are.
        at = end
        while at > start and lines[at - 1].strip() == "":
            at -= 1
        lines.insert(at, f"{key} = {format_value(value)}")
    changed = "\n".join(lines)
    try:
        data = tomllib.loads(changed)
    except tomllib.TOMLDecodeError as exc:
        raise CamError(f"the change does not read as TOML: {exc}") from exc
    read = _lookup(data, path)
    if value is None:
        if read is not None:
            raise CamError(f"{'.'.join(map(str, path))} is still there")
    elif not _same(read, value):
        raise CamError(f"{'.'.join(map(str, path))} did not take the value")
    return changed


def _lookup(data: Any, path: tuple) -> Any:
    node = data
    for step in path:
        if isinstance(step, int):
            if not isinstance(node, list) or step >= len(node):
                return None
            node = node[step]
        else:
            if not isinstance(node, dict) or step not in node:
                return None
            node = node[step]
    return node


def _same(read: Any, value: Any) -> bool:
    if isinstance(value, bool) or isinstance(read, bool):
        return read is value
    if isinstance(value, (int, float)) and isinstance(read, (int, float)):
        return math.isclose(float(read), float(value), rel_tol=0.0, abs_tol=0.0) or read == value
    if isinstance(value, (list, tuple)) and isinstance(read, list):
        return len(read) == len(value) and all(_same(a, b) for a, b in zip(read, value))
    return read == value
