"""Jobs: the model the frontend sees, an importer per file kind, and a store.

Path coordinates are board millimeters with the rotation axis at the origin
and the offset already applied. Every importer places its drawing the same
way: `center` puts the middle of the job on the axis, `keep` keeps the
file's origin there, and the offset shifts the result afterwards.
"""

from __future__ import annotations

import dataclasses
import io
import json
import math
import re
import secrets
import tempfile
import threading
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field
from spinny_laser import align as alignment
from spinny_laser import board
from spinny_laser import clear as copper_clearing
from spinny_laser import deposit as copper_deposition
from spinny_laser import lines as cut_lines
from spinny_laser import order as cut_order
from spinny_laser import pads as board_pads
from spinny_laser import stencil as paste_stencil

from . import kinematics
from .kinematics import Streamer

ANCHOR_CENTER, ANCHOR_KEEP = "center", "keep"
DEFAULT_POWER = 500.0
DEFAULT_SPEED = 400.0
DEFAULT_SPOT = 0.1
# Milling: how deep a group cuts below the surface, mm, and how fast the
# tool goes down into it, mm/min. A tenth of a millimeter goes through the
# copper of a usual board.
DEFAULT_DEPTH = 0.1
DEFAULT_PLUNGE = 60.0
# The deepest a group may cut: well past any board, and short of any
# spindle's reach.
MAX_DEPTH = 50.0
# Farthest a laser group may raise or lower the head from focus, mm: past
# any lens's useful range, and short of a number typed in the wrong unit.
MAX_FOCUS = 50.0
# CSS pixels per millimeter at 96 dpi, which is what an SVG length without
# a unit is; the parser's own rounded factor is used so a file in mm comes
# back out in exact mm.
DEFAULT_PPI = 96.0
# Curves are bisected at most this deep when flattening.
FLATTEN_DEPTH = 16

GERBER_SUFFIXES = board.GERBER_SUFFIXES
# Largest value a power, a speed or a coordinate may take: far past any
# machine, and short enough to keep every protocol line under its limit.
MAX_VALUE = 1.0e6
# Isolation passes around the copper; each is another offset of every loop.
MAX_PASSES = 50
# Times a group burns over its own paths, the whole group again each time.
MAX_GROUP_PASSES = 100
# A board import clears no copper past the isolation unless asked to, and
# then with one of the clearing fills.
CLEAR_OFF = "off"
CLEAR_CHOICES = (CLEAR_OFF, *copper_clearing.PATTERNS)
# What a board import burns: around the copper, taking it away, or the
# copper itself, for a process that lays it down; or round the inside of
# every opening of the paste, cut out of a film for a solder paste stencil;
# or, with a dispenser, a dot of paste on every pad of the layer; or on the
# layer's lines themselves, every stroke along its middle and every filled
# shape round its edge, for a drawing to cut or mark where it lies.
MODE_ISOLATE, MODE_DEPOSIT, MODE_STENCIL, MODE_DISPENSE, MODE_LINES = "isolate", "deposit", "stencil", "dispense", "lines"
MODES = (MODE_ISOLATE, MODE_DEPOSIT, MODE_STENCIL, MODE_DISPENSE, MODE_LINES)
# The layer whose lines are the board's outline, which an import cuts as a
# group of its own unless the layer cut is that one.
OUTLINE_LAYER = "Edge.Cuts"
# The layer a stencil or a dispense is read from when the upload names none.
PASTE_LAYER = "F.Paste"
# A stencil's openings are shrunk by at most this much on every side, mm:
# far past any paste reduction, and short of a number typed in the wrong
# unit.
MAX_MARGIN = 10.0
# How a board layer may be flipped, as the isolation's config names it.
MIRRORS = ("none", "x", "y")
# Dispensing: the paste over a pad, mm, whose product with the pad's area
# is the dot's volume. A stencil's foil is about this thick.
DEFAULT_THICKNESS = 0.12
MIN_THICKNESS, MAX_THICKNESS = 0.01, 5.0
# The tools a group may be made for.
LASER, SPINDLE, DISPENSER = "laser", "spindle", "dispenser"
# How the tool gets to a model's move: the fourth number of each.
MOVE_RAPID, MOVE_FEED, MOVE_PLUNGE = kinematics.MOVE_RAPID, kinematics.MOVE_FEED, kinematics.MOVE_PLUNGE
MOVE_KINDS = (MOVE_RAPID, MOVE_FEED, MOVE_PLUNGE)

Point = tuple[float, float]
Polyline = list[Point]


class JobImportError(ValueError):
    """The file could not be turned into a job."""


class Finite(BaseModel):
    """A model whose numbers are numbers: NaN and infinity are refused."""

    model_config = ConfigDict(allow_inf_nan=False)


class Group(Finite):
    label: str
    power: float = DEFAULT_POWER
    # The least power a cut runs at in the firmware's dynamic mode, where
    # power follows the speed down into corners; above `power` it counts
    # as `power`, and zero is no floor.
    min_power: float = 0.0
    speed: float = DEFAULT_SPEED
    # How many times the group runs, all of its paths each time, so a
    # layer that one burn does not get through goes over the same lines
    # again once the rest of it has had a moment to cool.
    passes: int = 1
    enabled: bool = True
    # Milling only: the depth below the surface the last pass reaches, each
    # pass going a step deeper, and the plunge rate into it. A spindle's
    # speed is `power`, its feed `speed`.
    depth: float = DEFAULT_DEPTH
    plunge: float = DEFAULT_PLUNGE
    # Dispensing only: the paste over each pad, mm. A dot's volume is the
    # pad's area times this.
    thickness: float = DEFAULT_THICKNESS
    # A laser with a focus axis only: mm the head is raised above focus for
    # the group (negative lowers it), on the height map's focus height when
    # the run follows the map, else on the height the run starts at; None
    # leaves the head where the run puts it. A ladder of these is the focus
    # test.
    focus: float | None = None
    # What the group was made for, `laser`, `spindle` or `dispenser`, when
    # a CAM profile or a dispense import said; None runs on a laser or a
    # spindle. A run refuses a group made for another tool, since its
    # numbers mean something else there.
    tool: str | None = None
    paths: list[list[tuple[float, float]]] = Field(default_factory=list)
    # Dispensing: the area in mm^2 of the pad under each path, which is a
    # single point, in the paths' order; empty for every other group.
    areas: list[float] = Field(default_factory=list)
    # Joint-space polylines, radius mm and angle degrees, streamed as they
    # are with no kinematics in between: a negative radius is the far side
    # of the axis, which is how a calibration burn lands on a board point
    # from both directions. With these present, `paths` is only what the
    # preview draws.
    joints: list[list[tuple[float, float]]] = Field(default_factory=list)
    # A 3D model's toolpaths from a CAM profile: every path's moves as x,
    # y, z over the stock's top and how the tool gets there (0 a rapid, 1
    # a feed at `speed` along the move, 2 a plunge at `plunge`). The first
    # move of a path is where the tool comes down to from the travel
    # height. With these, `paths` is empty and `depth` and `passes` say
    # nothing about the cut.
    moves: list[list[tuple[float, float, float, int]]] = Field(default_factory=list)

    @property
    def has_cuts(self) -> bool:
        return bool(self.joints) or bool(self.paths) or bool(self.moves)

    def board_paths(self) -> list[list[tuple[float, float]]]:
        """The group's paths on the board: a model's moves seen from above."""
        if self.moves:
            return [[(float(m[0]), float(m[1])) for m in path] for path in self.moves]
        return self.paths


class Offset(Finite):
    x: float = 0.0
    y: float = 0.0


class Design(Finite):
    """How the design's own frame maps to the job's: the gerber frame a
    board was plotted in (the KiCad file's X, and its Y negated) flipped by
    `mirror` for a layer cut with the board turned over (x negates X, y
    negates Y), turned counterclockwise by `rotation` about the origin and
    moved by `shift`, kept current through every move of the job. `board`
    says whether the KiCad file is kept beside the job, so a camera can
    look for it."""

    shift: tuple[float, float] = (0.0, 0.0)
    rotation: float = 0.0
    board: bool = False
    mirror: str = "none"

    def to_job(self, point: tuple[float, float]) -> tuple[float, float]:
        """A gerber frame point in the job's frame."""
        x, y = point
        if self.mirror == "x":
            x = -x
        elif self.mirror == "y":
            y = -y
        x, y = alignment.turn((x, y), self.rotation)
        return (x + self.shift[0], y + self.shift[1])

    def angle_to_job(self, degrees: float) -> float:
        """A gerber frame direction, degrees counterclockwise from +X, in the
        job's frame: flipped with the layer, then turned with it."""
        if self.mirror == "x":
            degrees = 180.0 - degrees
        elif self.mirror == "y":
            degrees = -degrees
        return degrees + self.rotation

    def board_to_job(self, point: tuple[float, float]) -> tuple[float, float]:
        """A KiCad board frame point (mm, y down) in the job's frame."""
        return self.to_job((point[0], -point[1]))


class Recipe(Finite):
    """How a job was made, kept so that it can be made again for another
    bit or spot: a board upload's file name (the file is kept beside the
    job) and the options it was imported with, or a Mill page operation."""

    file: str | None = None
    options: dict | None = None
    mill: dict | None = None


class JobStats(Finite):
    length_mm: float = 0.0
    seconds: float = 0.0
    max_radius: float = 0.0
    min_radius: float = 0.0
    limited_fraction: float = 0.0
    moves: int = 0


class Job(Finite):
    id: str = ""
    name: str = "job"
    source: str = "json"
    # The board layer a kicad or gerber job was cut from, F.Cu or F.Paste
    # for a stencil; None for a drawing, a gcode file or a gerber whose
    # name does not say.
    layer: str | None = None
    spot: float = DEFAULT_SPOT
    offset: Offset = Field(default_factory=Offset)
    # Degrees the job has been turned counterclockwise about the origin
    # since import, by alignment; applied already, like the offset.
    rotation: float = 0.0
    groups: list[Group] = Field(default_factory=list)
    outline: list[list[tuple[float, float]]] = Field(default_factory=list)
    copper: list[list[tuple[float, float]]] = Field(default_factory=list)
    # The pads of a board layer (x, y, area in mm^2) and the holes of its
    # drill file (x, y, diameter), in the job's frame, for probing on
    # copper and for lining the job up; empty for a drawing or a gcode file.
    pads: list[tuple[float, float, float]] = Field(default_factory=list)
    holes: list[tuple[float, float, float]] = Field(default_factory=list)
    design: Design | None = None
    # How the job was made, for making it again for another bit; None for
    # a job whose paths do not follow the bit, or that cannot be made again.
    recipe: Recipe | None = None
    stats: JobStats = Field(default_factory=JobStats)

    def summary(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "source": self.source,
            "layer": self.layer,
            "spot": self.spot,
            "offset": self.offset.model_dump(),
            "rotation": self.rotation,
            "pads": len(self.pads),
            "holes": len(self.holes),
            "design": self.design.model_dump() if self.design is not None else None,
            "remake": self.recipe is not None,
            "groups": [
                {
                    "label": group.label,
                    "power": group.power,
                    "min_power": group.min_power,
                    "speed": group.speed,
                    "passes": group.passes,
                    "enabled": group.enabled,
                    "depth": group.depth,
                    "plunge": group.plunge,
                    "thickness": group.thickness,
                    "focus": group.focus,
                    "tool": group.tool,
                    "paths": len(group.paths),
                    "joints": len(group.joints),
                    "moves": len(group.moves),
                    "areas": len(group.areas),
                }
                for group in self.groups
            ],
            "stats": self.stats.model_dump(),
        }

    def shift(self, dx: float, dy: float) -> None:
        """Move everything on the board, offset included."""
        if dx == 0.0 and dy == 0.0:
            return
        if any(group.joints for group in self.groups):
            # A joint-space group is written about the axis itself; there
            # is no board drawing to move.
            raise ValueError("a joint-space group is fixed to the axis and cannot be moved")
        for group in self.groups:
            group.paths = [_shifted(path, dx, dy) for path in group.paths]
            group.moves = [[(x + dx, y + dy, z, kind) for x, y, z, kind in path] for path in group.moves]
        self.outline = [_shifted(path, dx, dy) for path in self.outline]
        self.copper = [_shifted(path, dx, dy) for path in self.copper]
        self.pads = [(x + dx, y + dy, area) for x, y, area in self.pads]
        self.holes = [(x + dx, y + dy, d) for x, y, d in self.holes]
        self.offset = Offset(x=self.offset.x + dx, y=self.offset.y + dy)
        if self.design is not None:
            self.design = Design(
                shift=(self.design.shift[0] + dx, self.design.shift[1] + dy),
                rotation=self.design.rotation,
                board=self.design.board,
                mirror=self.design.mirror,
            )

    def turn(self, degrees: float) -> None:
        """Turn everything on the board counterclockwise about the origin,
        the offset with it, as lining the job up with the board asks."""
        if degrees == 0.0:
            return
        if any(group.joints for group in self.groups):
            raise ValueError("a joint-space group is fixed to the axis and cannot be turned")

        def turned(path):
            return [alignment.turn((float(x), float(y)), degrees) for x, y in path]

        for group in self.groups:
            group.paths = [turned(path) for path in group.paths]
            group.moves = [[(*alignment.turn((float(x), float(y)), degrees), z, kind) for x, y, z, kind in path] for path in group.moves]
        self.outline = [turned(path) for path in self.outline]
        self.copper = [turned(path) for path in self.copper]
        self.pads = [(*alignment.turn((x, y), degrees), area) for x, y, area in self.pads]
        self.holes = [(*alignment.turn((x, y), degrees), d) for x, y, d in self.holes]
        ox, oy = alignment.turn((self.offset.x, self.offset.y), degrees)
        self.offset = Offset(x=ox, y=oy)
        self.rotation += degrees
        if self.design is not None:
            self.design = Design(
                shift=alignment.turn(self.design.shift, degrees),
                rotation=self.design.rotation + degrees,
                board=self.design.board,
                mirror=self.design.mirror,
            )

    def refresh_stats(self, streamer: Streamer) -> None:
        try:
            stats = streamer.estimate(self)
        except ValueError:
            # The machine as it is set up cannot run this job (a joint-space
            # group on a cartesian or milling machine), which the run will
            # say; the stats are then the polar laser's, or for a model's
            # moves, their length at their feeds.
            if any(group.moves for group in self.groups):
                self.stats = moves_stats(self)
                return
            stats = Streamer(tolerance=streamer.tolerance, rates=streamer.rates).estimate(self)
        self.stats = JobStats(**stats.to_dict())


def moves_stats(job: Job) -> JobStats:
    """A model's job priced without a machine: every move at its feed,
    rapids at none."""
    length = 0.0
    seconds = 0.0
    moves = 0
    for group in job.groups:
        if not group.enabled:
            continue
        for path in group.moves:
            moves += len(path)
            for (x0, y0, z0, _), (x1, y1, z1, kind) in zip(path, path[1:]):
                run = math.dist((x0, y0, z0), (x1, y1, z1))
                if kind == MOVE_RAPID:
                    continue
                length += math.hypot(x1 - x0, y1 - y0)
                rate = group.plunge if kind == MOVE_PLUNGE else group.speed
                seconds += run / rate * 60.0 if rate > 0 else 0.0
    return JobStats(length_mm=length, seconds=seconds, moves=moves)


class GroupPatch(Finite):
    index: int
    label: str | None = None
    power: float | None = None
    min_power: float | None = None
    speed: float | None = None
    passes: int | None = None
    enabled: bool | None = None
    depth: float | None = None
    plunge: float | None = None
    thickness: float | None = None
    # Given as null it takes the group's focus away; left out, it stays.
    focus: float | None = None


# What a job is turned about: the middle of what it cuts, or the origin.
TURN_ABOUT = ("center", "origin")


class JobPatch(Finite):
    name: str | None = None
    groups: list[GroupPatch] | None = None
    offset: Offset | None = None
    # Degrees to turn the job counterclockwise, after the offset, about the
    # middle of the box round what it cuts or about the origin.
    turn: float | None = None
    about: str = "center"


def check_power(power: float, what: str = "power") -> None:
    if not 0.0 <= power <= MAX_VALUE:
        raise ValueError(f"{what} must be between 0 and {MAX_VALUE:g}")


def check_speed(speed: float, what: str = "speed") -> None:
    if not 0.0 < speed <= MAX_VALUE:
        raise ValueError(f"{what} must be above 0 and at most {MAX_VALUE:g}")
    if speed < kinematics.MIN_FEED:
        # Written with three decimals it would reach the firmware as F0.
        raise ValueError(f"{what} must be at least {kinematics.MIN_FEED:g} mm/min")


def check_thickness(thickness: float) -> None:
    if not (math.isfinite(thickness) and MIN_THICKNESS <= thickness <= MAX_THICKNESS):
        raise ValueError(f"thickness must be {MIN_THICKNESS:g} to {MAX_THICKNESS:g} mm")


def check_depth(depth: float) -> None:
    if not 0.0 < depth <= MAX_DEPTH:
        raise ValueError(f"depth must be above 0 and at most {MAX_DEPTH:g} mm")


def check_focus(focus: float | None, what: str = "focus") -> None:
    if focus is not None and not (math.isfinite(focus) and abs(focus) <= MAX_FOCUS):
        raise ValueError(f"{what} must be within {MAX_FOCUS:g} mm of focus either way")


def check_passes(passes: int, what: str = "passes") -> None:
    if not 1 <= passes <= MAX_GROUP_PASSES:
        raise ValueError(f"{what} must be between 1 and {MAX_GROUP_PASSES}")


def apply_patch(job: Job, patch: JobPatch, streamer: Streamer) -> Job:
    """The job with the patch applied, as a new object.

    The whole patch is checked before anything changes, and the job given
    is left as it was: a patch refused part way must not leave a job half
    changed in memory and unchanged on disk.
    """
    for change in patch.groups or []:
        if not 0 <= change.index < len(job.groups):
            raise ValueError(f"no group {change.index}")
        if change.power is not None:
            check_power(change.power)
        if change.min_power is not None:
            check_power(change.min_power, "min power")
        if change.speed is not None:
            check_speed(change.speed)
        if change.passes is not None:
            check_passes(change.passes)
        if change.depth is not None:
            check_depth(change.depth)
        if change.plunge is not None:
            check_speed(change.plunge, "plunge")
        if change.thickness is not None:
            check_thickness(change.thickness)
        check_focus(change.focus)
    if patch.offset is not None:
        dx, dy = patch.offset.x - job.offset.x, patch.offset.y - job.offset.y
        if (dx != 0.0 or dy != 0.0) and any(group.joints for group in job.groups):
            raise ValueError("a joint-space group is fixed to the axis and cannot be moved")
    if patch.turn is not None:
        if patch.about not in TURN_ABOUT:
            raise ValueError(f"about must be one of {', '.join(TURN_ABOUT)}")
        if not -360.0 <= patch.turn <= 360.0:
            raise ValueError("turn must be -360 to 360 degrees")
        if patch.turn != 0.0 and any(group.joints for group in job.groups):
            raise ValueError("a joint-space group is fixed to the axis and cannot be turned")
    updated = job.model_copy(deep=True)
    if patch.name:
        updated.name = patch.name
    for change in patch.groups or []:
        group = updated.groups[change.index]
        if change.label is not None:
            group.label = change.label
        if change.power is not None:
            group.power = change.power
        if change.min_power is not None:
            group.min_power = change.min_power
        if change.speed is not None:
            group.speed = change.speed
        if change.passes is not None:
            group.passes = change.passes
        if change.enabled is not None:
            group.enabled = change.enabled
        if change.depth is not None:
            group.depth = change.depth
        if change.plunge is not None:
            group.plunge = change.plunge
        if change.thickness is not None:
            group.thickness = change.thickness
        if "focus" in change.model_fields_set:
            group.focus = change.focus
    if patch.offset is not None:
        updated.shift(patch.offset.x - updated.offset.x, patch.offset.y - updated.offset.y)
    if patch.turn:
        turn_job(updated, patch.turn, patch.about)
    updated.refresh_stats(streamer)
    return updated


def cut_middle(job: Job) -> tuple[float, float]:
    """The middle of the box round everything the job cuts and its outline;
    the origin for a job with nothing on the board."""
    points = [p for group in job.groups for path in group.paths for p in path]
    points += [(p[0], p[1]) for group in job.groups for path in group.moves for p in path]
    points += [p for path in job.outline for p in path]
    if not points:
        return (0.0, 0.0)
    xs = [float(p[0]) for p in points]
    ys = [float(p[1]) for p in points]
    return ((min(xs) + max(xs)) / 2.0, (min(ys) + max(ys)) / 2.0)


def turn_job(job: Job, degrees: float, about: str = "center") -> None:
    """Turns the job counterclockwise about the middle of what it cuts, so
    it stays where it is on the board, or about the origin."""
    center = cut_middle(job) if about == "center" else (0.0, 0.0)
    job.turn(degrees)
    if center != (0.0, 0.0):
        tx, ty = alignment.turn(center, degrees)
        job.shift(center[0] - tx, center[1] - ty)


def _shifted(path, dx: float, dy: float) -> list[tuple[float, float]]:
    return [(x + dx, y + dy) for x, y in path]


# --- another width ----------------------------------------------------------

# A job's width is the bit's diameter or the beam's spot, mm.
MAX_WIDTH = 1000.0
# Sources whose paths are made for the width: offsets of the copper, or a
# model's moves.
WIDTH_MADE = ("kicad", "gerber", "stl")
# The group settings a job made again keeps.
SETTINGS = ("power", "min_power", "speed", "passes", "enabled", "depth", "plunge", "thickness", "focus")


def check_width(width: float) -> None:
    if not (math.isfinite(width) and 0.0 < width <= MAX_WIDTH):
        raise ValueError(f"the width must be above 0 and at most {MAX_WIDTH:g} mm")


def width_refusal(job: Job) -> str | None:
    """Why the job cannot be given another width; None when it can, made
    again from its recipe or, when its paths do not follow the width (a
    drawing's lines, a gcode file's moves), with the number alone."""
    if job.recipe is not None:
        return None
    # A board's paths are offsets of its copper, whatever it is called
    # after a save and a load.
    if job.source in WIDTH_MADE or job.copper or any(group.tool for group in job.groups):
        return f"{job.name}'s paths were made for {job.spot:g} mm and nothing is kept to make them again: import it again with the new width"
    return None


def label_stem(label: str) -> str:
    """A group's label with its numbers taken out, which the same group
    made again for another width keeps."""
    return re.sub(r"[-+]?\d+(?:\.\d+)?", "#", label)


def carry_settings(old: list[Group], new: list[Group]) -> None:
    """Each old group's settings onto the group made again in its place:
    the first new group whose label is the old one's but for its numbers
    takes the first such old group's, the second the second's."""
    by_stem: dict[str, list[Group]] = defaultdict(list)
    for group in old:
        by_stem[label_stem(group.label)].append(group)
    seen: dict[str, int] = defaultdict(int)
    for group in new:
        stem = label_stem(group.label)
        index = seen[stem]
        seen[stem] += 1
        if index < len(by_stem[stem]):
            source = by_stem[stem][index]
            for name in SETTINGS:
                setattr(group, name, getattr(source, name))


def with_width(job: Job, width: float, streamer: Streamer) -> Job:
    """The job with another width and its paths as they are, for a job
    whose paths do not follow it: the drawn width and the margins of
    probing take it."""
    updated = job.model_copy(deep=True)
    updated.spot = width
    updated.refresh_stats(streamer)
    return updated


def recipe_options(options: ImportOptions) -> dict:
    return dataclasses.asdict(options)


def remake_upload(job: Job, kept: Path, width: float, streamer: Streamer, margin: float | None = None) -> Job:
    """A board job imported again from its kept file for another width, and
    a stencil for another `margin` when one is given, and put where the job
    is now: the design's frame turned and moved as the job's has been, so
    the copper lands on the copper already cut, and its groups' settings
    kept."""
    recipe = job.recipe
    if recipe is None or not recipe.file or recipe.options is None:
        raise ValueError(f"{job.name} keeps no file to import again")
    fields = {key: value for key, value in recipe.options.items() if key in {f.name for f in dataclasses.fields(ImportOptions)}}
    if "offset" in fields:
        fields["offset"] = (float(fields["offset"][0]), float(fields["offset"][1]))
    options = ImportOptions(**fields)
    options.spot = width
    if margin is not None:
        options.margin = margin
    with tempfile.TemporaryDirectory(prefix="spinny-remake-") as folder:
        # Under its own name, alone: a gerber's layer is read from its name,
        # and its outline would be looked for beside it.
        path = Path(folder) / Path(recipe.file).name
        try:
            path.write_bytes(kept.read_bytes())
        except OSError as exc:
            raise JobImportError(f"cannot read the kept file of {job.name}: {exc}") from exc
        made = import_file(path, job.name, options, streamer)
    if job.design is not None and made.design is not None:
        made.turn(job.design.rotation - made.design.rotation)
        made.shift(job.design.shift[0] - made.design.shift[0], job.design.shift[1] - made.design.shift[1])
        made.design = job.design.model_copy()
    carry_settings(job.groups, made.groups)
    made.id = job.id
    made.name = job.name
    made.offset = job.offset.model_copy()
    made.rotation = job.rotation
    made.recipe = Recipe(file=recipe.file, options=recipe_options(options))
    made.refresh_stats(streamer)
    return made


# --- importers --------------------------------------------------------------


@dataclass
class ImportOptions:
    power: float = DEFAULT_POWER
    speed: float = DEFAULT_SPEED
    spot: float = DEFAULT_SPOT
    anchor: str = ANCHOR_CENTER
    offset: Point = (0.0, 0.0)
    tolerance: float = kinematics.DEFAULT_TOLERANCE
    passes: int = 1
    # The layer a KiCad board is read from: a copper layer, or F.Paste,
    # whose openings a stencil cuts out of a film. A gerber is its own
    # layer.
    layer: str = board.DEFAULT_LAYER
    # Only a board has copper to isolate, clear or deposit, or paste to cut
    # a stencil for; other files ignore all of these.
    mode: str = MODE_ISOLATE
    clear: str = CLEAR_OFF
    # How a deposit fills the copper inside its edge loops; left out, with
    # loops on in to the middle.
    fill: str | None = None
    # A stencil only: mm every opening is shrunk by on every side before it
    # is cut, for less paste than the pad's whole area; left out, none.
    margin: float | None = None
    # Dispensing: the paste over every pad, mm.
    thickness: float = DEFAULT_THICKNESS
    # How a board layer is flipped: none, x (X negated, the board turned
    # over about its Y axis) or y; left out, x for a layer on the back
    # (B.Cu, B.Paste) and none for the front, so the back's copper lands
    # where it is with the board turned over left to right.
    mirror: str | None = None

    def check(self) -> None:
        if self.anchor not in (ANCHOR_CENTER, ANCHOR_KEEP):
            raise JobImportError(f"anchor must be {ANCHOR_CENTER} or {ANCHOR_KEEP}")
        if self.mode not in MODES:
            raise JobImportError(f"mode must be one of {', '.join(MODES)}")
        if self.clear not in CLEAR_CHOICES:
            raise JobImportError(f"clear must be one of {', '.join(CLEAR_CHOICES)}")
        if self.fill is not None and self.fill not in copper_deposition.FILLS:
            raise JobImportError(f"fill must be one of {', '.join(copper_deposition.FILLS)}")
        if self.mode == MODE_STENCIL and (self.clear != CLEAR_OFF or self.fill is not None):
            raise JobImportError("a stencil cuts round every opening: it takes neither clear nor fill")
        if self.mode == MODE_STENCIL and self.passes != 1:
            raise JobImportError("passes counts isolation or edge loops; a stencil cuts round every opening once: set its group's passes to cut again")
        if self.mode == MODE_LINES and (self.clear != CLEAR_OFF or self.fill is not None):
            raise JobImportError("lines cuts on the layer's lines: it takes neither clear nor fill")
        if self.mode == MODE_LINES and self.passes != 1:
            raise JobImportError("passes counts isolation or edge loops; lines are cut once each: set the group's passes to cut again")
        if self.margin is not None:
            if self.mode != MODE_STENCIL:
                raise JobImportError("margin is how much a stencil shrinks its openings; this import is not a stencil")
            if not (math.isfinite(self.margin) and 0.0 <= self.margin <= MAX_MARGIN):
                raise JobImportError(f"margin must be 0 to {MAX_MARGIN:g} mm")
        if self.mode != MODE_ISOLATE and self.clear != CLEAR_OFF:
            raise JobImportError("clear is for isolation; a deposit takes fill instead")
        if self.mode != MODE_DEPOSIT and self.fill is not None:
            raise JobImportError("fill is for a deposit; isolation takes clear instead")
        if self.mirror is not None and self.mirror not in MIRRORS:
            raise JobImportError(f"mirror must be one of {', '.join(MIRRORS)}")
        try:
            check_thickness(self.thickness)
        except ValueError as exc:
            raise JobImportError(str(exc)) from exc
        try:
            board.check_layer(self.layer)
            check_power(self.power)
            check_speed(self.speed)
        except ValueError as exc:
            raise JobImportError(str(exc)) from exc
        if not 0.0 < self.spot <= 1000.0:
            raise JobImportError("spot must be above 0 and at most 1000")
        if not all(math.isfinite(v) and abs(v) <= MAX_VALUE for v in self.offset):
            raise JobImportError(f"offset must be within {MAX_VALUE:g} mm")
        if not (math.isfinite(self.tolerance) and self.tolerance > 0.0):
            raise JobImportError("tolerance must be > 0")
        if not 1 <= self.passes <= MAX_PASSES:
            raise JobImportError(f"passes must be between 1 and {MAX_PASSES}")


def import_file(path: Path, name: str, options: ImportOptions, streamer: Streamer) -> Job:
    """A job from a file on disk, by its suffix."""
    options.check()
    suffix = path.suffix.lower()
    if suffix == ".json":
        job = from_json(path.read_text(encoding="utf-8"), name)
    elif suffix == ".svg":
        job = from_svg(path.read_text(encoding="utf-8"), name, options)
    elif suffix in (".gcode", ".nc", ".ngc"):
        job = from_gcode(path.read_text(encoding="utf-8", errors="replace"), name, options)
    elif suffix == ".kicad_pcb" or suffix in GERBER_SUFFIXES:
        job = from_board(path, name, options, pace=streamer.rates.r_rate / streamer.rates.a_rate)
    else:
        raise JobImportError(f"cannot import {path.name}: unknown file type {suffix!r}")
    job.refresh_stats(streamer)
    return job


def from_json(text: str, name: str) -> Job:
    try:
        job = Job.model_validate_json(text)
    except ValueError as exc:
        raise JobImportError(f"not a job: {exc}") from exc
    job.id = ""
    if not job.name or job.name == "job":
        job.name = name
    job.source = "json"
    if not 0.0 < job.spot <= 1000.0:
        raise JobImportError("spot must be above 0 and at most 1000")
    for group in job.groups:
        # The firmware refuses a cut with F at or below zero, so a group
        # that carries one would end its run on the first line; a number
        # past the bound would not fit a line at all.
        try:
            check_speed(group.speed, f"group {group.label!r}: speed")
            check_power(group.power, f"group {group.label!r}: power")
            check_power(group.min_power, f"group {group.label!r}: min power")
            check_passes(group.passes, f"group {group.label!r}: passes")
            if not 0.0 < group.depth <= MAX_DEPTH:
                raise JobImportError(f"group {group.label!r}: depth must be above 0 and at most {MAX_DEPTH:g} mm")
            check_speed(group.plunge, f"group {group.label!r}: plunge")
            check_thickness(group.thickness)
            check_focus(group.focus, f"group {group.label!r}: focus")
        except ValueError as exc:
            raise JobImportError(str(exc)) from exc
        if group.areas and len(group.areas) != len(group.paths):
            raise JobImportError(f"group {group.label!r}: areas must have one entry per path")
        if any(len(poly) < 2 for poly in group.joints):
            raise JobImportError("a joint-space path needs at least two points")
        for poly in group.paths + group.joints:
            for point in poly:
                if any(abs(v) > MAX_VALUE for v in point):
                    raise JobImportError(f"group {group.label!r}: a coordinate is past {MAX_VALUE:g}")
        if group.moves and (group.paths or group.joints):
            raise JobImportError(f"group {group.label!r}: a model's moves come alone, without paths or joints")
        for path in group.moves:
            for x, y, z, kind in path:
                if kind not in MOVE_KINDS:
                    raise JobImportError(f"group {group.label!r}: a move's kind is 0 (rapid), 1 (feed) or 2 (plunge)")
                if any(abs(v) > MAX_VALUE for v in (x, y)) or abs(z) > MAX_DEPTH * 20:
                    raise JobImportError(f"group {group.label!r}: a move is out of reach")
    drawn = [group for group in job.groups if group.joints and not group.paths]
    for group, paths in zip(drawn, kinematics.joint_previews([group.joints for group in drawn])):
        group.paths = paths
    return job


def place(paths: list[Polyline], anchor: str, offset: Point) -> list[Polyline]:
    """Anchor a drawing on the axis and shift it by the offset."""
    dx, dy = offset
    if anchor == ANCHOR_CENTER:
        xs = [x for path in paths for x, _ in path]
        ys = [y for path in paths for _, y in path]
        if xs:
            dx -= (min(xs) + max(xs)) / 2.0
            dy -= (min(ys) + max(ys)) / 2.0
    elif anchor != ANCHOR_KEEP:
        raise JobImportError(f"unknown anchor {anchor!r}")
    return [[(x + dx, y + dy) for x, y in path] for path in paths]


def from_gcode(text: str, name: str, options: ImportOptions) -> Job:
    """Absolute X/Y `G0`/`G1` cuts, grouped by the power and feed they ran at."""
    from spinny_laser import convert

    try:
        paths = convert.read_paths(text)
    except convert.ConvertError as exc:
        raise JobImportError(str(exc)) from exc
    if not paths:
        raise JobImportError("the file has no cuts")
    placed = place([path.points for path in paths], options.anchor, options.offset)
    # Consecutive paths at one power and feed share a group, and the file's
    # order is kept: a cut-out that comes after an engraving in the file
    # stays after it, so a piece freed by it cannot move under the beam
    # before the engraving is done.
    groups: list[Group] = []
    for path, points in zip(paths, placed):
        if groups and groups[-1].power == path.power and groups[-1].speed == path.speed:
            groups[-1].paths.append(points)
        else:
            groups.append(Group(label=f"S{path.power:g} F{path.speed:g}", power=path.power, speed=path.speed, paths=[points]))
    return Job(
        name=name,
        source="gcode",
        spot=options.spot,
        offset=Offset(x=options.offset[0], y=options.offset[1]),
        groups=groups,
    )


def svg_polylines(text: str, tolerance: float) -> list[tuple[str, Polyline]]:
    """Every shape as (stroke color, points in mm, y up), curves flattened."""
    from svgelements import SVG, Close, Line, Move, Path, Shape

    try:
        svg = SVG.parse(io.StringIO(text), reify=True, ppi=DEFAULT_PPI)
    except Exception as exc:
        raise JobImportError(f"not an SVG: {exc}") from exc
    px_per_mm = _px_per_mm()
    scale = 1.0 / px_per_mm
    tolerance_px = tolerance * px_per_mm
    out: list[tuple[str, Polyline]] = []

    def to_mm(point) -> Point:
        # SVG y grows downward and board y grows upward, so y is mirrored
        # here, once, after every transform has been applied in SVG space.
        return (point.x * scale, -point.y * scale)

    for element in svg.elements():
        if not isinstance(element, Shape):
            continue
        values = getattr(element, "values", {}) or {}
        if values.get("visibility") == "hidden" or values.get("display") == "none":
            continue
        path = Path(element)
        path.reify()
        color = _stroke_name(element)
        current: list = []

        def flush() -> None:
            if len(current) > 1:
                out.append((color, [to_mm(p) for p in current]))

        for segment in path:
            if isinstance(segment, Move):
                flush()
                current = [segment.end]
            elif isinstance(segment, Line):
                # A line right after a close starts where the closed
                # subpath began, with no move to say so.
                if not current:
                    current = [segment.start]
                current.append(segment.end)
            elif isinstance(segment, Close):
                if current:
                    current.append(current[0])
                flush()
                current = []
            else:
                if not current:
                    current = [segment.start]
                current.extend(_flatten(segment, tolerance_px, 0.0, 1.0, 0))
        flush()
    return out


def _px_per_mm() -> float:
    from svgelements import Length

    return float(Length("1mm").value(ppi=DEFAULT_PPI))


def _stroke_name(element) -> str:
    stroke = getattr(element, "stroke", None)
    if stroke is None or getattr(stroke, "value", None) is None:
        return "no stroke"
    try:
        return str(stroke.hex)
    except Exception:
        return str(stroke)


def _flatten(segment, tolerance: float, t0: float, t1: float, depth: int) -> list:
    """Points after t0 that keep the chords within the tolerance of the curve."""
    p0 = segment.point(t0)
    p1 = segment.point(t1)
    if p0 is None or p1 is None:
        return []
    worst = 0.0
    for fraction in (0.25, 0.5, 0.75):
        t = t0 + (t1 - t0) * fraction
        on_curve = segment.point(t)
        on_chord_x = p0.x + (p1.x - p0.x) * fraction
        on_chord_y = p0.y + (p1.y - p0.y) * fraction
        worst = max(worst, math.hypot(on_curve.x - on_chord_x, on_curve.y - on_chord_y))
    if worst <= tolerance or depth >= FLATTEN_DEPTH:
        return [p1]
    tm = (t0 + t1) / 2.0
    return _flatten(segment, tolerance, t0, tm, depth + 1) + _flatten(segment, tolerance, tm, t1, depth + 1)


def from_svg(text: str, name: str, options: ImportOptions) -> Job:
    """Every shape outline as a cut, one group per stroke color."""
    shapes = svg_polylines(text, options.tolerance)
    if not shapes:
        raise JobImportError("the SVG has no shapes to cut")
    placed = place([points for _, points in shapes], options.anchor, options.offset)
    groups: dict[str, Group] = {}
    for (color, _), points in zip(shapes, placed):
        if color not in groups:
            label = "no stroke" if color == "no stroke" else f"stroke {color}"
            groups[color] = Group(label=label, power=options.power, speed=options.speed)
        groups[color].paths.append(points)
    # A part's holes and marks before its outline, while the sheet holds it.
    for group in groups.values():
        group.paths = cut_order.inner_first(group.paths)
    return Job(
        name=name,
        source="svg",
        spot=options.spot,
        offset=Offset(x=options.offset[0], y=options.offset[1]),
        groups=list(groups.values()),
    )


def from_board(path: Path, name: str, options: ImportOptions, pace: float = copper_clearing.DEFAULT_PACE) -> Job:
    """Isolation loops for a gerber or a KiCad board, with the outline when found,
    or with `mode` deposit the copper itself burnt, or with `mode` stencil
    every opening cut round its inside edge, the outline switched off for
    both.

    A KiCad board is read on `options.layer`: a copper layer, the paste
    layer, which a stencil is cut for, or any layer whose lines `mode` lines
    cuts on (Edge.Cuts, a silk screen, a user layer). A gerber is the layer
    it is, and the groups are named for what the layer draws.

    `pace` is the machine's rail rate in mm/min over its table rate in
    deg/min, which a radial clearing or fill orders its spokes by."""
    from laser_sweep import geom, gerber, isocli, isolate

    from laser_sweep import excellon

    temporary: tempfile.TemporaryDirectory | None = None
    layer: str | None = options.layer
    holes: list[tuple[float, float, float]] = []
    try:
        if path.suffix.lower() == ".kicad_pcb":
            temporary = tempfile.TemporaryDirectory(prefix="spinny-web-")
            into = Path(temporary.name)
            isocli.export_board(path, options.layer, outline=True, drill=True, into=into)
            # kicad-cli names a gerber after the name a layer is shown by,
            # F.SilkS as F_Silkscreen, which the board's table may set.
            try:
                copper_path = board.find_plotted(into, options.layer, path)
            except board.LayerError:
                raise JobImportError(f"{path.name} has no layer {options.layer}") from None
            source = "kicad"
            for drill_path in sorted(into.glob("*.drl")):
                holes.extend(board_pads.holes_of(excellon.read(drill_path)))
        else:
            copper_path = path
            into = path.parent
            source = "gerber"
            layer = board.layer_of(path)
        word = board.layer_word(layer)
        mirror = options.mirror if options.mirror is not None else ("x" if board.is_bottom(layer) else "none")
        flip = (-1.0 if mirror == "x" else 1.0, -1.0 if mirror == "y" else 1.0)
        try:
            outline_path: Path | None = board.find_layer(into, "Edge.Cuts")
        except board.LayerError:
            outline_path = None
        image = gerber.read(copper_path)
        copper = geom.copper(image)
        # Lines drawn with no width leave no ink, and are lines all the same.
        drawn = cut_lines.drawn_lines(image) if options.mode == MODE_LINES else []
        if options.mode == MODE_LINES and not drawn:
            raise JobImportError(f"{copper_path.name} draws no lines")
        if not copper and options.mode != MODE_LINES:
            raise JobImportError(f"{copper_path.name} draws no {word}")
        # The pads and holes flipped as the layer is; the placement then
        # moves them as it moves the copper.
        pads = [(x * flip[0], y * flip[1], area) for x, y, area in board_pads.pads_of(image)]
        holes = [(x * flip[0], y * flip[1], d) for x, y, d in holes]
        outline: list = []
        if outline_path is not None:
            outline = isocli.outline_cut(isocli.outline_paths(gerber.read(outline_path)), 0.0)
        config = isolate.IsoConfig(
            spot=options.spot,
            passes=options.passes,
            anchor=options.anchor,
            origin=options.offset,
            mirror=mirror,
        )
        isolate.offsets_for(config)
        if options.mode == MODE_DISPENSE:
            if not pads:
                raise JobImportError(f"{copper_path.name} has no pads to dispense on")
            shift = isolate.placement(copper, config, 0.0, [(outline, 0.0)])
            placed = isolate.transform(copper, config, shift)
            outline = [list(p) for p in isolate.transform(outline, config, shift)]
            groups = dispense_groups(pads, shift, options, word)
        elif options.mode == MODE_DEPOSIT:
            # The beam keeps inside the copper, but over a trace narrower
            # than itself it reaches half a spot past the middle.
            reach = options.spot / 2.0
            shift = isolate.placement(copper, config, reach, [(outline, reach)])
            placed = isolate.transform(copper, config, shift)
            outline = [list(p) for p in isolate.transform(outline, config, shift)]
            deposition = copper_deposition.deposit(
                placed,
                options.spot,
                options.fill or copper_deposition.CONTOUR,
                passes=options.passes,
                centers=isolate.transform(copper_deposition.centerlines(image), config, shift),
                tolerance=options.tolerance,
                pace=pace,
            )
            groups = deposit_groups(deposition, options, word)
        elif options.mode == MODE_STENCIL:
            # The beam keeps inside the paste, but along the middle of an
            # opening narrower than itself it reaches half a spot past it.
            reach = options.spot / 2.0
            shift = isolate.placement(copper, config, reach, [(outline, reach)])
            placed = isolate.transform(copper, config, shift)
            outline = [list(p) for p in isolate.transform(outline, config, shift)]
            margin = options.margin or 0.0
            cut = paste_stencil.stencil(placed, options.spot, margin, pace=pace)
            if not cut.paths:
                raise JobImportError(f"a margin of {margin:g} mm closes every opening of {copper_path.name}")
            groups = stencil_groups(cut, options, word)
        elif options.mode == MODE_LINES:
            # The beam's middle runs on the lines, so its edge reaches half
            # a spot past them.
            reach = options.spot / 2.0
            shift = isolate.placement(drawn, config, reach, [(copper, 0.0), (outline, reach)])
            placed = isolate.transform(copper, config, shift)
            outline = [list(p) for p in isolate.transform(outline, config, shift)]
            lines = cut_lines.ordered([list(p) for p in isolate.transform(drawn, config, shift)], pace=pace)
            groups = lines_groups(lines, options, layer)
        else:
            plan = isolate.build(copper, config, outline=outline)
            placed, outline = plan.copper, plan.outline
            cleared: list = []
            if options.clear != CLEAR_OFF:
                # The clearing keeps its beam outside the outermost loop, and
                # runs its rings in chords the streamer sends out whole.
                cleared = copper_clearing.clear(
                    plan.copper,
                    max(plan.offsets),
                    options.spot,
                    options.clear,
                    outline=plan.outline,
                    tolerance=options.tolerance,
                    pace=pace,
                )
            groups = isolation_groups(plan, cleared, options, word)
            # The plan flipped and moved the copper; the pads and holes,
            # flipped already, follow it by the same amount, read back from
            # the first point.
            shift = (0.0, 0.0)
            if copper and plan.copper:
                x0, y0 = copper[0][0][0] * flip[0], copper[0][0][1] * flip[1]
                shift = (plan.copper[0][0][0] - x0, plan.copper[0][0][1] - y0)
    except (isocli.SourceError, gerber.GerberError, ValueError, OSError) as exc:
        raise JobImportError(str(exc)) from exc
    finally:
        if temporary is not None:
            temporary.cleanup()

    dx, dy = shift
    pads = [(round(x + dx, 4), round(y + dy, 4), area) for x, y, area in pads]
    holes = [(round(x + dx, 4), round(y + dy, 4), d) for x, y, d in holes]
    # The outline's own lines are the job when it is the layer cut on them.
    outline_cut = not (options.mode == MODE_LINES and layer == OUTLINE_LAYER)
    if outline and options.mode != MODE_DISPENSE and outline_cut:
        groups.append(
            Group(
                label="board outline pass 1",
                power=options.power,
                speed=options.speed,
                # A deposit burns copper wherever the beam goes, so the
                # outline is there to cut the board free with a power of its
                # own once the copper is down, and is off until then; a
                # stencil's film needs no board's shape unless asked, and a
                # drawing cut on its lines may be a mark on a board in place.
                enabled=options.mode not in (MODE_DEPOSIT, MODE_STENCIL, MODE_LINES),
                # A cutout inside the board before the edge that frees it.
                paths=cut_order.inner_first([[tuple(p) for p in path] for path in outline]),
            )
        )
    return Job(
        name=name,
        source=source,
        layer=layer,
        spot=options.spot,
        offset=Offset(x=options.offset[0], y=options.offset[1]),
        groups=groups,
        outline=[[tuple(p) for p in path] for path in outline],
        copper=[[tuple(p) for p in contour] for contour in placed],
        pads=pads,
        holes=holes,
        design=Design(shift=(float(dx), float(dy)), rotation=0.0, board=source == "kicad", mirror=mirror),
    )


def dispense_groups(pads: list, shift: tuple[float, float], options: ImportOptions, word: str = "copper") -> list[Group]:
    """One group of dots: a path of one point per pad at its centroid, in a
    short tour over the board from the pad nearest the origin, with the
    pad's area beside it; `word` is what the layer draws, for the label."""
    dx, dy = shift
    placed = [(x + dx, y + dy, area) for x, y, area in pads]
    order = board_pads.tour(placed)
    return [
        Group(
            label=f"{word} dots",
            power=options.power,
            speed=options.speed,
            thickness=options.thickness,
            tool=DISPENSER,
            paths=[[(round(placed[i][0], 4), round(placed[i][1], 4))] for i in order],
            areas=[placed[i][2] for i in order],
        )
    ]


def isolation_groups(plan, cleared: list, options: ImportOptions, word: str = "copper") -> list[Group]:
    """A group per isolation loop offset, then the clearing, if any; `word`
    is what the layer draws, for the labels."""
    groups: list[Group] = []
    for index in sorted({loop.index for loop in plan.loops}):
        members = [loop for loop in plan.loops if loop.index == index]
        groups.append(
            Group(
                label=f"isolation loop {index + 1} at {members[0].offset:.3f} mm",
                power=options.power,
                speed=options.speed,
                paths=[[tuple(p) for p in loop.points] for loop in members],
            )
        )
    if cleared:
        # Before the outline: a board cut free may move under the beam.
        groups.append(
            Group(
                label=f"{word} clearing, {options.clear}, {options.spot:.3f} mm pitch",
                power=options.power,
                speed=options.speed,
                paths=[[tuple(p) for p in path] for path in cleared],
            )
        )
    return groups


def deposit_groups(deposition: copper_deposition.Deposition, options: ImportOptions, word: str = "copper") -> list[Group]:
    """A group per edge loop offset, then the fill and the narrow traces;
    `word` is what the layer draws, for the labels."""
    groups = [
        Group(
            label=f"{word} edge loop {index + 1} at {offset:.3f} mm in",
            power=options.power,
            speed=options.speed,
            paths=[[tuple(p) for p in loop] for loop in loops],
        )
        for index, (offset, loops) in enumerate(zip(deposition.offsets, deposition.edges))
        if loops
    ]
    if deposition.fill:
        groups.append(
            Group(
                label=f"{word} fill, {options.fill or copper_deposition.CONTOUR}, {options.spot:.3f} mm pitch",
                power=options.power,
                speed=options.speed,
                paths=[[tuple(p) for p in path] for path in deposition.fill],
            )
        )
    if deposition.thin:
        groups.append(
            Group(
                label=f"{word} narrower than the spot, along its middle",
                power=options.power,
                speed=options.speed,
                paths=[[tuple(p) for p in path] for path in deposition.thin],
            )
        )
    return groups


def lines_groups(lines: list, options: ImportOptions, layer: str | None) -> list[Group]:
    """One group of the layer's lines, cut on them, named for the layer."""
    return [
        Group(
            label=f"lines of {layer}" if layer else "lines of the layer",
            power=options.power,
            speed=options.speed,
            paths=[[tuple(p) for p in line] for line in lines],
        )
    ]


def stencil_groups(cut: paste_stencil.Stencil, options: ImportOptions, word: str = "paste") -> list[Group]:
    """A group of loops round the openings, then the openings narrower than
    the spot and, switched off, those the margin closes; `word` is what the
    layer draws, for the labels."""
    groups: list[Group] = []
    if cut.loops:
        groups.append(
            Group(
                label=f"{word} openings, {options.margin or 0.0:.3f} mm margin",
                power=options.power,
                speed=options.speed,
                paths=[[tuple(p) for p in loop] for loop in cut.loops],
            )
        )
    if cut.narrow:
        groups.append(
            Group(
                label=f"{word} openings narrower than the spot, along their middle",
                power=options.power,
                speed=options.speed,
                paths=[[tuple(p) for p in path] for path in cut.narrow],
            )
        )
    if cut.closed:
        # Not part of the stencil the margin asked for: there to be
        # switched on, for paste on those pads after all.
        groups.append(
            Group(
                label=f"{word} openings the margin closes, along their middle",
                power=options.power,
                speed=options.speed,
                enabled=False,
                paths=[[tuple(p) for p in path] for path in cut.closed],
            )
        )
    return groups


# --- the store ----------------------------------------------------------------


class JobStore:
    """Jobs in memory, mirrored as one JSON file each so a restart keeps them."""

    def __init__(self, directory: Path | None = None) -> None:
        self.directory = directory
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()
        if directory is not None:
            directory.mkdir(parents=True, exist_ok=True)
            for file in sorted(directory.glob("*.json"), key=lambda p: p.stat().st_mtime):
                try:
                    job = Job.model_validate_json(file.read_text(encoding="utf-8"))
                except (ValueError, OSError):
                    continue
                if job.id:
                    self._jobs[job.id] = job

    def new_id(self) -> str:
        while True:
            candidate = secrets.token_hex(2)
            if candidate not in self._jobs:
                return candidate

    def add(self, job: Job) -> Job:
        with self._lock:
            if not job.id or job.id in self._jobs:
                job.id = self.new_id()
            self._jobs[job.id] = job
            self._write(job)
        return job

    def save(self, job: Job) -> None:
        with self._lock:
            self._jobs[job.id] = job
            self._write(job)

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def list(self) -> list[Job]:
        with self._lock:
            return list(self._jobs.values())

    def remove(self, job_id: str) -> bool:
        with self._lock:
            job = self._jobs.pop(job_id, None)
            if job is None:
                return False
            if self.directory is not None:
                kept = [self.directory / f"{job_id}.json", self.directory / f"{job_id}.kicad_pcb"]
                kept.extend(self.directory.glob(f"{job_id}.upload*"))
                for path in kept:
                    try:
                        path.unlink()
                    except OSError:
                        pass
        return True

    def keep_board(self, job_id: str, data: bytes) -> bool:
        """Keeps the KiCad board a job was imported from beside it, so the
        camera can look for it; False when there is nowhere to keep it."""
        if self.directory is None:
            return False
        try:
            target = self.directory / f"{job_id}.kicad_pcb"
            temp = target.with_suffix(".kicad_pcb.tmp")
            temp.write_bytes(data)
            temp.replace(target)
        except OSError:
            return False
        return True

    def keep_upload(self, job_id: str, name: str, data: bytes) -> bool:
        """Keeps the file a board job was imported from beside it, so it can
        be imported again for another width; a KiCad board is the one kept
        for the camera. False when there is nowhere to keep it."""
        suffix = Path(name).suffix.lower()
        if suffix == ".kicad_pcb":
            return self.keep_board(job_id, data)
        if self.directory is None:
            return False
        try:
            target = self.directory / f"{job_id}.upload{suffix}"
            temp = target.with_name(target.name + ".tmp")
            temp.write_bytes(data)
            temp.replace(target)
        except OSError:
            return False
        return True

    def upload_path(self, job_id: str, name: str) -> Path | None:
        """The file kept for a job imported from `name`, when there is one."""
        suffix = Path(name).suffix.lower()
        if suffix == ".kicad_pcb":
            return self.board_path(job_id)
        if self.directory is None:
            return None
        path = self.directory / f"{job_id}.upload{suffix}"
        return path if path.is_file() else None

    def board_path(self, job_id: str) -> Path | None:
        """The board file kept for a job, when there is one."""
        if self.directory is None:
            return None
        path = self.directory / f"{job_id}.kicad_pcb"
        return path if path.is_file() else None

    def _write(self, job: Job) -> None:
        if self.directory is None:
            return
        target = self.directory / f"{job.id}.json"
        temp = target.with_suffix(".json.tmp")
        temp.write_text(job.model_dump_json(), encoding="utf-8")
        temp.replace(target)


def job_from_dict(data: dict) -> Job:
    return Job.model_validate(data)


def job_to_json(job: Job) -> str:
    return json.dumps(job.model_dump(), separators=(",", ":"))
