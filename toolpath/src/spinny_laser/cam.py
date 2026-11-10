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

from . import board
from .machines import is_id

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
# What a 3D model goes through: cleared level by level, its walls followed,
# its surfaces combed with lines.
ROUGH, WATERLINE, PARALLEL = "rough", "waterline", "parallel"
MODEL_SOURCES = (ROUGH, WATERLINE, PARALLEL)
SOURCES = (ISOLATION, CLEARING, OUTLINE, DRILLS, DEPOSIT, PATHS, *MODEL_SOURCES)
FLAT, BALL, BULL, VEE = "flat", "ball", "bull", "vee"
SHAPES = (FLAT, BALL, BULL, VEE)
CLIMB, CONVENTIONAL = "climb", "conventional"
DIRECTIONS = (CLIMB, CONVENTIONAL)
DEFAULT_FLUTES = 2
MAX_FLUTES = 12
# A spindle's speed range when the profile does not give one: the rpm a
# material asks for is held inside it.
DEFAULT_RPM_MIN = 0.0
DEFAULT_RPM_MAX = 24000.0
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
# A model's rough, when neither the file nor a material says: the stepover
# of the diameter, the stock left for the finish, the steepest entry in
# degrees, and the stock round the model.
DEFAULT_ROUGH_STEPOVER = 0.4
DEFAULT_LEAVE = 0.2
DEFAULT_RAMP = 3.0
DEFAULT_MARGIN = 2.0
DEFAULT_DECIMALS = 3
DEFAULT_HEADER = ("G21", "G90", "G94", "G17")
DEFAULT_FOOTER = ("M5", "M2")

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
    # A model's operations: the stock a rough leaves on the walls and on
    # the floors, the steepest entry in degrees, how far past touching the
    # model the tool goes round it, and how far under the model's bottom
    # the last level reaches (less than 0 leaves a skin holding the part).
    "leave": (0.0, MAX_DEPTH, True),
    "leave_floor": (0.0, MAX_DEPTH, True),
    "ramp": (0.0, 90.0, False),
    "band": (0.0, MAX_WIDTH, True),
    "below": (-MAX_DEPTH, MAX_DEPTH, True),
}
# The settings only a model's operations read.
MODEL_SETTINGS = ("leave", "leave_floor", "ramp", "band", "below")
LASER_SETTINGS: dict[str, tuple[float, float, bool]] = {
    "power": (0.0, MAX_VALUE, True),
    "min_power": (0.0, MAX_VALUE, True),
    "speed": (0.0, MAX_VALUE, False),
    "height": (-MAX_WIDTH, MAX_WIDTH, True),
}
SETTINGS_BY_KIND = {SPINDLE: SPINDLE_SETTINGS, LASER: LASER_SETTINGS}
REQUIRED_BY_KIND = {SPINDLE: ("rpm", "feed"), LASER: ("power", "speed")}
# What an operation may say besides a cutting setting, by source.
OPERATION_KEYS = {
    "name",
    "source",
    "tool",
    "enabled",
    "passes",
    "loops",
    "pattern",
    "fill",
    "marks",
    "match",
    "direction",
    "flats",
    "angle",
}


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
    # The width of the cut: a bit's diameter, a beam's spot. For a V bit,
    # the width at its default depth; `width_at` gives it for another.
    width: float
    # The cutting settings the file gives it, by key.
    settings: dict[str, float]
    # A V bit: the included angle of its point, degrees, and the width of
    # its tip, mm. Its cut widens with the depth. None for a straight bit
    # or a beam.
    angle: float | None = None
    tip: float = 0.0
    # The widest a V bit's cut can be, its shank, when the file says; None
    # for no bound.
    shank: float | None = None
    # A mill's end, as a model's operations cut with it: flat, ball, bull
    # (a flat end with corners rounded to `corner` mm) or vee. Its flutes
    # set the feed a material asks for, and `length`, when given, is how
    # deep under the stock's top it can reach.
    shape: str = FLAT
    corner: float = 0.0
    flutes: int = DEFAULT_FLUTES
    length: float | None = None

    def width_at(self, depth: float) -> float:
        """The width of the cut at a depth: a straight bit's or a beam's
        is its own, a V bit's is its tip plus what its flanks add."""
        if self.angle is None:
            return self.width
        wide = self.tip + 2.0 * max(0.0, depth) * math.tan(math.radians(self.angle / 2.0))
        return min(wide, self.shank) if self.shank is not None else wide

    def document(self) -> dict:
        out = {"id": self.id, "kind": self.kind, "name": self.name, "width": self.width, "settings": dict(self.settings)}
        if self.angle is not None:
            out["angle"] = self.angle
            out["tip"] = self.tip
            if self.shank is not None:
                out["shank"] = self.shank
        if self.kind == SPINDLE:
            out["shape"] = self.shape
            out["flutes"] = self.flutes
            if self.shape == BULL:
                out["corner"] = self.corner
            if self.length is not None:
                out["length"] = self.length
        return out

    @property
    def diameter(self) -> float:
        """A mill's full width: a V bit's shank, else its cut."""
        return self.shank if self.angle is not None and self.shank is not None else self.width


@dataclass(frozen=True)
class Material:
    """What a mill cuts, and how hard it can be pushed: the cutting edge's
    speed in m/min, the chip a tooth takes by the tool's diameter, and the
    defaults a rough takes in it."""

    id: str
    name: str
    speed: float
    # (diameter mm, mm per tooth), by diameter; read straight between.
    chip_load: tuple[tuple[float, float], ...]
    # Of the tool's diameter: a rough's step down and stepover.
    depth: float
    stepover: float
    # Degrees, the steepest entry.
    ramp: float
    # Of the feed, straight down.
    plunge: float
    # mm a rough leaves for the finish.
    leave: float
    note: str

    def chip(self, diameter: float) -> float:
        points = self.chip_load
        if diameter <= points[0][0]:
            return points[0][1]
        for (d0, c0), (d1, c1) in zip(points, points[1:]):
            if diameter <= d1:
                return c0 + (c1 - c0) * (diameter - d0) / (d1 - d0)
        return points[-1][1]

    def document(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "speed": self.speed,
            "chip_load": [list(p) for p in self.chip_load],
            "depth": self.depth,
            "stepover": self.stepover,
            "ramp": self.ramp,
            "plunge": self.plunge,
            "leave": self.leave,
            "note": self.note,
        }


@dataclass(frozen=True)
class Stock:
    """The block a model is cut from: its material, and how much bigger
    than the model it is, or its size."""

    material: str | None
    margin: float
    top: float
    size: tuple[float, float, float] | None

    def document(self) -> dict:
        return {"material": self.material, "margin": self.margin, "top": self.top, "size": list(self.size) if self.size else None}


@dataclass(frozen=True)
class ModelSetup:
    """How a model is stood up before it is cut: turned about X, then Y,
    then Z by degrees, and scaled (25.4 for a model drawn in inches)."""

    turn: tuple[float, float, float]
    scale: float

    def document(self) -> dict:
        return {"turn": list(self.turn), "scale": self.scale}


@dataclass(frozen=True)
class SpindleRange:
    min: float
    max: float

    def document(self) -> dict:
        return {"min": self.min, "max": self.max}


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
    # Where the speed and the feed came from when a material set them, one
    # line for the job's notes; empty when the file gave them.
    feeds: str = ""

    def document(self) -> dict:
        return {
            "name": self.name,
            "source": self.source,
            "tool": self.tool,
            "enabled": self.enabled,
            "settings": dict(self.settings),
            "cutting": dict(self.cutting),
            "feeds": self.feeds,
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
    materials: tuple[Material, ...] = ()
    stock: Stock = Stock(None, 2.0, 0.0, None)
    model: ModelSetup = ModelSetup((0.0, 0.0, 0.0), 1.0)
    spindle: SpindleRange = SpindleRange(DEFAULT_RPM_MIN, DEFAULT_RPM_MAX)

    @property
    def material(self) -> Material | None:
        for material in self.materials:
            if material.id == self.stock.material:
                return material
        return None

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
            "material": self.material.name if self.material is not None else None,
            "model": any(operation.source in MODEL_SOURCES for operation in self.operations),
        }

    def document(self) -> dict:
        return {
            **self.summary(),
            "axes": [axis.document() for axis in self.axes],
            "tools": [tool.document() for tool in self.tools],
            "operations": [operation.document() for operation in self.operations],
            "post": self.post.document(),
            "placement": self.placement.document(),
            "materials": [material.document() for material in self.materials],
            "stock": self.stock.document(),
            "model_setup": self.model.document(),
            "spindle": self.spindle.document(),
        }


# --- reading ----------------------------------------------------------------


def check_id(profile_id: str) -> str:
    """A profile's id is its file's stem, and becomes a file name again
    when the page saves it."""
    if not is_id(profile_id):
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
    if machine is not None and not is_id(machine):
        raise reader.fail(None, "machine", "must be the stem of a file in machines/")
    axes = tuple(reader.axis(table, index) for index, table in enumerate(reader.tables(data, "axes")))
    materials = tuple(reader.material(table, index) for index, table in enumerate(reader.tables(data, "materials")))
    material_ids = [material.id for material in materials]
    for material_id in material_ids:
        if material_ids.count(material_id) > 1:
            raise reader.fail("[[materials]]", "id", f"{material_id!r} is given twice")
    stock = reader.stock(data, material_ids)
    model = reader.model(data)
    spindle = reader.spindle(data)
    material = next((m for m in materials if m.id == stock.material), None)
    tools = tuple(reader.tool(table, index, material is not None) for index, table in enumerate(reader.tables(data, "tools")))
    tool_ids = [tool.id for tool in tools]
    for tool_id in tool_ids:
        if tool_ids.count(tool_id) > 1:
            raise reader.fail("[[tools]]", "id", f"{tool_id!r} is given twice")
    by_id = {tool.id: tool for tool in tools}
    feeds = _Feeds(material, spindle, axes)
    operations = tuple(
        reader.operation(table, index, by_id, feeds) for index, table in enumerate(reader.tables(data, "operations"))
    )
    post = reader.post(data)
    placement = reader.placement(data)
    reader.done(
        data,
        None,
        {"name", "description", "machine", "axes", "tools", "operations", "post", "placement", "materials", "stock", "model", "spindle"},
    )
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
        materials=materials,
        stock=stock,
        model=model,
        spindle=spindle,
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

    def tool(self, table: dict, index: int, material: bool) -> Tool:
        """A tool; with a material in the stock a mill may leave its rpm and
        feed to it."""
        section = f"[[tools]] {index + 1}"
        tool_id = self.text(table, section, "id", "")
        if not is_id(tool_id):
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
        # A V bit is given by its point: the cut is as wide as the depth
        # makes it, and the diameter, when given, is the shank that bounds it.
        angle = self.bounded(table, section, "angle", 0.0, 179.0, False)
        tip = self.bounded(table, section, "tip", 0.0, MAX_WIDTH, True)
        if (angle is not None or tip is not None) and kind != SPINDLE:
            raise self.fail(section, "angle" if angle is not None else "tip", "is for a mill's V bit; a beam has a spot")
        if tip is not None and angle is None:
            raise self.fail(section, "tip", "needs angle: the included angle of the V bit's point, degrees")
        shank = width if angle is not None else None
        width = width if width is not None else spot
        if width is None and angle is None:
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
            if key not in settings and not (material and kind == SPINDLE):
                raise self.fail(section, key, "is needed, or a [stock] material to work it out from")
        end = {}
        mill_keys = {"shape", "corner", "flutes", "length"}
        if kind == SPINDLE:
            end = self.mill_end(table, section, angle, shank if angle is not None else width)
        else:
            for key in sorted(mill_keys & set(table)):
                raise self.fail(section, key, "is for a mill; a beam has a spot")
        self.done(table, section, {"id", "kind", "name", "diameter", "spot", "passes", "angle", "tip", *bounds, *mill_keys})
        if angle is not None:
            # The nominal width is the cut at the tool's own default depth,
            # for whatever shows one number for the tool.
            tool = Tool(tool_id, kind, name, 0.0, settings, angle=angle, tip=tip or 0.0, shank=shank, **end)
            nominal = tool.width_at(settings.get("depth", DEFAULT_DEPTH))
            if nominal <= 0.0:
                raise self.fail(section, "tip", "or the depth must give the cut some width")
            return Tool(tool_id, kind, name, nominal, settings, angle=angle, tip=tip or 0.0, shank=shank, **end)
        assert width is not None
        return Tool(tool_id, kind, name, width, settings, **end)

    def mill_end(self, table: dict, section: str, angle: float | None, diameter: float | None) -> dict:
        """A mill's shape, corner, flutes and reach."""
        shape = self.choice(table, section, "shape", SHAPES, VEE if angle is not None else FLAT)
        if shape == VEE and angle is None:
            raise self.fail(section, "shape", "vee needs angle: the included angle of the V bit's point, degrees")
        if angle is not None and shape != VEE:
            raise self.fail(section, "angle", f"is a V bit's; this mill's shape is {shape}")
        corner = self.bounded(table, section, "corner", 0.0, MAX_WIDTH, False)
        if shape == BULL:
            if corner is None:
                raise self.fail(section, "corner", "is needed for a bull nose: the radius of its rounded corners, mm")
            if diameter is not None and corner > diameter / 2.0:
                raise self.fail(section, "corner", "must be at most half the diameter")
        elif corner is not None:
            raise self.fail(section, "corner", "is a bull nose's corner radius; give shape = \"bull\"")
        flutes = self.integer(table, section, "flutes", 1, MAX_FLUTES)
        length = self.bounded(table, section, "length", 0.0, MAX_WIDTH, False)
        return {"shape": shape, "corner": corner or 0.0, "flutes": flutes or DEFAULT_FLUTES, "length": length}

    def material(self, table: dict, index: int) -> Material:
        section = f"[[materials]] {index + 1}"
        material_id = self.text(table, section, "id", "")
        if not is_id(material_id):
            raise self.fail(section, "id", "is needed: lower case letters, digits, - and _")
        section = f"[[materials]] {material_id}"
        name = self.text(table, section, "name", material_id)
        speed = self.bounded(table, section, "speed", 0.0, 5000.0, False)
        if speed is None:
            raise self.fail(section, "speed", "is needed: the cutting edge's speed in m/min")
        raw = table.get("chip_load")
        if raw is None:
            raise self.fail(section, "chip_load", "is needed: [[diameter mm, mm per tooth], ...]")
        if isinstance(raw, (int, float)) and not isinstance(raw, bool):
            raw = [[1.0, raw]]
        pairs: list[tuple[float, float]] = []
        if not isinstance(raw, list) or not raw:
            raise self.fail(section, "chip_load", "must be [[diameter mm, mm per tooth], ...]")
        for pair in raw:
            if (
                not isinstance(pair, list)
                or len(pair) != 2
                or not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and 0 < v <= MAX_WIDTH for v in pair)
            ):
                raise self.fail(section, "chip_load", "must be [[diameter mm, mm per tooth], ...] with every number above 0")
            pairs.append((float(pair[0]), float(pair[1])))
        pairs.sort()
        if any(a[0] == b[0] for a, b in zip(pairs, pairs[1:])):
            raise self.fail(section, "chip_load", "gives one diameter twice")
        depth = self.bounded(table, section, "depth", 0.0, 10.0, False)
        stepover = self.bounded(table, section, "stepover", 0.0, 1.0, False)
        ramp = self.bounded(table, section, "ramp", 0.0, 90.0, False)
        plunge = self.bounded(table, section, "plunge", 0.0, 1.0, False)
        leave = self.bounded(table, section, "leave", 0.0, MAX_DEPTH, True)
        note = self.text(table, section, "note", "")
        self.done(table, section, {"id", "name", "speed", "chip_load", "depth", "stepover", "ramp", "plunge", "leave", "note"})
        return Material(
            id=material_id,
            name=name,
            speed=speed,
            chip_load=tuple(pairs),
            depth=0.5 if depth is None else depth,
            stepover=DEFAULT_ROUGH_STEPOVER if stepover is None else stepover,
            ramp=DEFAULT_RAMP if ramp is None else ramp,
            plunge=0.3 if plunge is None else plunge,
            leave=DEFAULT_LEAVE if leave is None else leave,
            note=note,
        )

    def stock(self, top: dict, material_ids: list[str]) -> Stock:
        table = self.table(top, "stock")
        section = "[stock]"
        material = self.text(table, section, "material", "") or None
        if material is not None and material not in material_ids:
            known = ", ".join(material_ids) or "none yet"
            raise self.fail(section, "material", f"must name a [[materials]] id: {known}")
        margin = self.bounded(table, section, "margin", 0.0, MAX_WIDTH, True)
        over = self.bounded(table, section, "top", 0.0, MAX_DEPTH, True)
        size = self.triple(table, section, "size", 0.0, MAX_WIDTH)
        self.done(table, section, {"material", "margin", "top", "size"})
        return Stock(material, DEFAULT_MARGIN if margin is None else margin, 0.0 if over is None else over, size)

    def model(self, top: dict) -> ModelSetup:
        table = self.table(top, "model")
        section = "[model]"
        turn = self.triple(table, section, "turn", -360.0, 360.0, low_ok=True) or (0.0, 0.0, 0.0)
        scale = self.bounded(table, section, "scale", 0.0, 1000.0, False)
        self.done(table, section, {"turn", "scale"})
        return ModelSetup(turn, 1.0 if scale is None else scale)

    def spindle(self, top: dict) -> SpindleRange:
        table = self.table(top, "spindle")
        section = "[spindle]"
        low = self.bounded(table, section, "min", 0.0, MAX_VALUE, True)
        high = self.bounded(table, section, "max", 0.0, MAX_VALUE, False)
        low = DEFAULT_RPM_MIN if low is None else low
        high = DEFAULT_RPM_MAX if high is None else high
        if low > high:
            raise self.fail(section, "min", "must be at most max")
        self.done(table, section, {"min", "max"})
        return SpindleRange(low, high)

    def triple(self, table: dict, section: str, key: str, low: float, high: float, low_ok: bool = False) -> tuple[float, float, float] | None:
        value = table.get(key)
        if value is None:
            return None
        start = "at least" if low_ok else "above"
        if (
            not isinstance(value, list)
            or len(value) != 3
            or not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in value)
            or any(v > high or v < low or (v == low and not low_ok) for v in value)
        ):
            raise self.fail(section, key, f"must be [x, y, z], each {start} {low:g} and at most {high:g}")
        return (float(value[0]), float(value[1]), float(value[2]))

    def operation(self, table: dict, index: int, tools: dict[str, Tool], feeds: "_Feeds") -> Operation:
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
        if source in MODEL_SOURCES:
            if tool.kind != SPINDLE:
                raise self.fail(section, "tool", "must be a mill: a model is cut, not burned")
            if tool.shape == VEE and source != PARALLEL:
                raise self.fail(section, "tool", "is a V bit, which cuts parallel passes only")
        else:
            for key in MODEL_SETTINGS:
                if key in settings:
                    raise self.fail(section, key, "is for a model's operations: rough, waterline or parallel")
        if "direction" in table:
            if source not in (ROUGH, WATERLINE):
                raise self.fail(section, "direction", "is which way a rough or a waterline goes round; this operation is neither")
            settings["direction"] = self.choice(table, section, "direction", DIRECTIONS, None)
        if "flats" in table:
            if source not in (ROUGH, WATERLINE):
                raise self.fail(section, "flats", "adds a rough's or a waterline's levels at the flat faces; this operation is neither")
            settings["flats"] = self.flag(table, section, "flats", True)
        if "angle" in table:
            if source != PARALLEL:
                raise self.fail(section, "angle", "is the direction of parallel lines; this operation is not parallel")
            settings["angle"] = self.bounded(table, section, "angle", -360.0, 360.0, True)
        self.done(table, section, OPERATION_KEYS | set(bounds))
        defaults, note = feeds.defaults(tool, source)
        cutting = resolve(tool, settings, defaults, source)
        if tool.kind == SPINDLE and cutting["passes"] > MAX_PASSES:
            raise self.fail(section, "step_down", f"gives more than {MAX_PASSES} passes to the depth")
        if tool.kind == SPINDLE and source == ROUGH and cutting["step_down"] > 0 and cutting["step_down"] < 0.01:
            raise self.fail(section, "step_down", "must be 0.01 mm or more for a rough")
        used = note if any(key not in settings and key not in tool.settings for key in ("rpm", "feed")) else ""
        return Operation(name, source, tool_id, enabled, settings, cutting, used)

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
        layer = self.text(table, section, "layer", board.DEFAULT_LAYER)
        try:
            board.check_layer(layer)
        except board.LayerError:
            raise self.fail(section, "layer", "must be a KiCad layer name such as F.Cu or F.Paste") from None
        mirror = self.choice(table, section, "mirror", MIRRORS, "none")
        self.done(table, section, {"anchor", "offset", "layer", "mirror"})
        return Placement(anchor, (float(offset[0]), float(offset[1])), layer, mirror)


class _Feeds:
    """The rpm and feed a material asks of a mill, held to the spindle's
    range and the machine's rates, with the rough's defaults.

    The edge speed gives the rpm, the chip a tooth takes gives the feed.
    When the feed is more than the plane's slowest axis can do it is held
    there and the rpm comes down with it, so each tooth still takes its
    chip: a tool that turns fast and moves slowly rubs, which melts
    plastics and welds aluminum to the edge.
    """

    def __init__(self, material: Material | None, spindle: SpindleRange, axes: tuple[Axis, ...]) -> None:
        self.material = material
        self.spindle = spindle
        plane = [axis.rate for axis in axes if axis.role in (X, Y, RADIUS) and axis.rate is not None]
        self.cap = min(plane) if plane else None
        depth = [axis.rate for axis in axes if axis.role == DEPTH and axis.rate is not None]
        self.depth_cap = depth[0] if depth else None

    def defaults(self, tool: Tool, source: str) -> tuple[dict[str, float], str]:
        material = self.material
        if material is None or tool.kind != SPINDLE:
            return {}, ""
        diameter = tool.diameter
        rpm = material.speed * 1000.0 / (math.pi * diameter)
        held: list[str] = []
        if rpm > self.spindle.max:
            rpm = self.spindle.max
            held.append(f"the rpm held to the spindle's {self.spindle.max:g}")
        elif rpm < self.spindle.min:
            rpm = self.spindle.min
            held.append(f"the rpm raised to the spindle's least {self.spindle.min:g}")
        chip = material.chip(diameter)
        feed = rpm * tool.flutes * chip
        if self.cap is not None and feed > self.cap:
            feed = self.cap
            slower = max(feed / (tool.flutes * chip), self.spindle.min)
            held.append(f"the feed held to the axes' {self.cap:g} mm/min and the rpm brought down to keep the chip")
            rpm = slower
        plunge = feed * material.plunge
        if self.depth_cap is not None:
            plunge = min(plunge, self.depth_cap)
        out = {"rpm": float(round(rpm)), "feed": float(round(feed)), "plunge": float(max(1.0, round(plunge)))}
        if source == ROUGH:
            out["step_down"] = round(material.depth * diameter, 3)
            out["stepover"] = material.stepover
            out["leave"] = material.leave
        if source in MODEL_SOURCES:
            out["ramp"] = material.ramp
        actual = out["feed"] / (out["rpm"] * tool.flutes) if out["rpm"] > 0 else 0.0
        note = f"{material.name} with {tool.name}: {out['rpm']:.0f} rpm, {out['feed']:.0f} mm/min, {actual:.3f} mm a tooth on {tool.flutes} flutes"
        if held:
            note += "; " + ", ".join(held)
        return out, note


def resolve(tool: Tool, settings: dict[str, Any], defaults: dict[str, float], source: str) -> dict[str, float]:
    """The settings an operation cuts with: the tool's defaults, the
    operation's own over them, and the pass count. `defaults` are under
    the tool's: what a material works out for it. A model's operations
    take their own defaults for what nothing gives.

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
        elif key in defaults:
            cutting[key] = float(defaults[key])
    if tool.kind == SPINDLE and source in MODEL_SOURCES:
        diameter = tool.diameter
        if source == ROUGH:
            cutting.setdefault("step_down", round(0.5 * diameter, 3))
            cutting.setdefault("stepover", DEFAULT_ROUGH_STEPOVER)
            cutting.setdefault("leave", DEFAULT_LEAVE)
        elif source == WATERLINE:
            cutting.setdefault("step_down", round(diameter, 3))
            cutting.setdefault("stepover", DEFAULT_ROUGH_STEPOVER)
            cutting.setdefault("leave", 0.0)
        else:
            cutting.setdefault("stepover", 0.1)
            cutting.setdefault("leave", 0.0)
        cutting.setdefault("leave_floor", cutting["leave"])
        cutting.setdefault("ramp", DEFAULT_RAMP)
        cutting.setdefault("below", 0.0)
        # The level after level of a model is not a pass count.
        cutting["passes"] = 1.0
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
    # A V bit cuts as wide as the operation's depth makes it; the last
    # pass, at the full depth, sets the trench.
    cutting["width"] = tool.width_at(cutting["depth"]) if tool.kind == SPINDLE else tool.width
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
