"""Jobs: the model the frontend sees, an importer per file kind, and a store.

Path coordinates are board millimeters with the rotation axis at the origin
and the offset already applied. Every importer places its drawing the same
way: `center` puts the middle of the job on the axis, `keep` keeps the
file's origin there, and the offset shifts the result afterwards.
"""

from __future__ import annotations

import io
import json
import math
import secrets
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field
from spinny_laser import clear as copper_clearing
from spinny_laser import deposit as copper_deposition

from . import kinematics
from .kinematics import Streamer

ANCHOR_CENTER, ANCHOR_KEEP = "center", "keep"
DEFAULT_POWER = 500.0
DEFAULT_SPEED = 400.0
DEFAULT_SPOT = 0.1
# Milling: how deep a group cuts below the surface, mm, and how fast the
# tool goes down into it, mm/min. A tenth of a millimetre goes through the
# copper of a usual board.
DEFAULT_DEPTH = 0.1
DEFAULT_PLUNGE = 60.0
# The deepest a group may cut: well past any board, and short of any
# spindle's reach.
MAX_DEPTH = 50.0
# CSS pixels per millimeter at 96 dpi, which is what an SVG length without
# a unit is; the parser's own rounded factor is used so a file in mm comes
# back out in exact mm.
DEFAULT_PPI = 96.0
# Curves are bisected at most this deep when flattening.
FLATTEN_DEPTH = 16

GERBER_SUFFIXES = (".gbr", ".gtl", ".gbl", ".gts", ".gbs", ".gm1")
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
# copper itself, for a process that lays it down.
MODE_ISOLATE, MODE_DEPOSIT = "isolate", "deposit"
MODES = (MODE_ISOLATE, MODE_DEPOSIT)

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
    paths: list[list[tuple[float, float]]] = Field(default_factory=list)
    # Joint-space polylines, radius mm and angle degrees, streamed as they
    # are with no kinematics in between: a negative radius is the far side
    # of the axis, which is how a calibration burn lands on a board point
    # from both directions. With these present, `paths` is only what the
    # preview draws.
    joints: list[list[tuple[float, float]]] = Field(default_factory=list)

    @property
    def has_cuts(self) -> bool:
        return bool(self.joints) or bool(self.paths)


class Offset(Finite):
    x: float = 0.0
    y: float = 0.0


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
    spot: float = DEFAULT_SPOT
    offset: Offset = Field(default_factory=Offset)
    groups: list[Group] = Field(default_factory=list)
    outline: list[list[tuple[float, float]]] = Field(default_factory=list)
    copper: list[list[tuple[float, float]]] = Field(default_factory=list)
    stats: JobStats = Field(default_factory=JobStats)

    def summary(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "source": self.source,
            "spot": self.spot,
            "offset": self.offset.model_dump(),
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
                    "paths": len(group.paths),
                    "joints": len(group.joints),
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
        self.outline = [_shifted(path, dx, dy) for path in self.outline]
        self.copper = [_shifted(path, dx, dy) for path in self.copper]
        self.offset = Offset(x=self.offset.x + dx, y=self.offset.y + dy)

    def refresh_stats(self, streamer: Streamer) -> None:
        try:
            stats = streamer.estimate(self)
        except ValueError:
            # The machine as it is set up cannot run this job (a joint-space
            # group on a cartesian or milling machine), which the run will
            # say; the stats are then the polar laser's.
            stats = Streamer(tolerance=streamer.tolerance, rates=streamer.rates).estimate(self)
        self.stats = JobStats(**stats.to_dict())


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


class JobPatch(Finite):
    name: str | None = None
    groups: list[GroupPatch] | None = None
    offset: Offset | None = None


def check_power(power: float, what: str = "power") -> None:
    if not 0.0 <= power <= MAX_VALUE:
        raise ValueError(f"{what} must be between 0 and {MAX_VALUE:g}")


def check_speed(speed: float, what: str = "speed") -> None:
    if not 0.0 < speed <= MAX_VALUE:
        raise ValueError(f"{what} must be above 0 and at most {MAX_VALUE:g}")
    if speed < kinematics.MIN_FEED:
        # Written with three decimals it would reach the firmware as F0.
        raise ValueError(f"{what} must be at least {kinematics.MIN_FEED:g} mm/min")


def check_depth(depth: float) -> None:
    if not 0.0 < depth <= MAX_DEPTH:
        raise ValueError(f"depth must be above 0 and at most {MAX_DEPTH:g} mm")


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
    if patch.offset is not None:
        dx, dy = patch.offset.x - job.offset.x, patch.offset.y - job.offset.y
        if (dx != 0.0 or dy != 0.0) and any(group.joints for group in job.groups):
            raise ValueError("a joint-space group is fixed to the axis and cannot be moved")
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
    if patch.offset is not None:
        updated.shift(patch.offset.x - updated.offset.x, patch.offset.y - updated.offset.y)
    updated.refresh_stats(streamer)
    return updated


def _shifted(path, dx: float, dy: float) -> list[tuple[float, float]]:
    return [(x + dx, y + dy) for x, y in path]


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
    layer: str = "F.Cu"
    # Only a board has copper to isolate, clear or deposit; other files
    # ignore all three.
    mode: str = MODE_ISOLATE
    clear: str = CLEAR_OFF
    # How a deposit fills the copper inside its edge loops; left out, with
    # loops on in to the middle.
    fill: str | None = None

    def check(self) -> None:
        if self.anchor not in (ANCHOR_CENTER, ANCHOR_KEEP):
            raise JobImportError(f"anchor must be {ANCHOR_CENTER} or {ANCHOR_KEEP}")
        if self.mode not in MODES:
            raise JobImportError(f"mode must be one of {', '.join(MODES)}")
        if self.clear not in CLEAR_CHOICES:
            raise JobImportError(f"clear must be one of {', '.join(CLEAR_CHOICES)}")
        if self.fill is not None and self.fill not in copper_deposition.FILLS:
            raise JobImportError(f"fill must be one of {', '.join(copper_deposition.FILLS)}")
        if self.mode == MODE_DEPOSIT and self.clear != CLEAR_OFF:
            raise JobImportError("clear is for isolation; a deposit takes fill instead")
        if self.mode == MODE_ISOLATE and self.fill is not None:
            raise JobImportError("fill is for a deposit; isolation takes clear instead")
        try:
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
        except ValueError as exc:
            raise JobImportError(str(exc)) from exc
        if any(len(poly) < 2 for poly in group.joints):
            raise JobImportError("a joint-space path needs at least two points")
        for poly in group.paths + group.joints:
            for point in poly:
                if any(abs(v) > MAX_VALUE for v in point):
                    raise JobImportError(f"group {group.label!r}: a coordinate is past {MAX_VALUE:g}")
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
    return Job(
        name=name,
        source="svg",
        spot=options.spot,
        offset=Offset(x=options.offset[0], y=options.offset[1]),
        groups=list(groups.values()),
    )


def from_board(path: Path, name: str, options: ImportOptions, pace: float = copper_clearing.DEFAULT_PACE) -> Job:
    """Isolation loops for a copper gerber or a KiCad board, with the outline when found,
    or with `mode` deposit the copper itself burnt and the outline switched off.

    `pace` is the machine's rail rate in mm/min over its table rate in
    deg/min, which a radial clearing or fill orders its spokes by."""
    from laser_sweep import geom, gerber, isocli, isolate

    temporary: tempfile.TemporaryDirectory | None = None
    try:
        if path.suffix.lower() == ".kicad_pcb":
            temporary = tempfile.TemporaryDirectory(prefix="spinny-web-")
            into = Path(temporary.name)
            isocli.export_board(path, options.layer, outline=True, drill=False, into=into)
            copper_path = isocli.find_layer(into, options.layer)
            source = "kicad"
        else:
            copper_path = path
            into = path.parent
            source = "gerber"
        try:
            outline_path: Path | None = isocli.find_layer(into, "Edge.Cuts")
        except isocli.SourceError:
            outline_path = None
        image = gerber.read(copper_path)
        copper = geom.copper(image)
        if not copper:
            raise JobImportError(f"{copper_path.name} draws no copper")
        outline: list = []
        if outline_path is not None:
            outline = isocli.outline_cut(isocli.outline_paths(gerber.read(outline_path)), 0.0)
        config = isolate.IsoConfig(
            spot=options.spot,
            passes=options.passes,
            anchor=options.anchor,
            origin=options.offset,
        )
        isolate.offsets_for(config)
        if options.mode == MODE_DEPOSIT:
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
            groups = deposit_groups(deposition, options)
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
            groups = isolation_groups(plan, cleared, options)
    except (isocli.SourceError, gerber.GerberError, ValueError, OSError) as exc:
        raise JobImportError(str(exc)) from exc
    finally:
        if temporary is not None:
            temporary.cleanup()

    if outline:
        groups.append(
            Group(
                label="board outline pass 1",
                power=options.power,
                speed=options.speed,
                # A deposit burns copper wherever the beam goes, so the
                # outline is there to cut the board free with a power of its
                # own once the copper is down, and is off until then.
                enabled=options.mode != MODE_DEPOSIT,
                paths=[[tuple(p) for p in path] for path in outline],
            )
        )
    return Job(
        name=name,
        source=source,
        spot=options.spot,
        offset=Offset(x=options.offset[0], y=options.offset[1]),
        groups=groups,
        outline=[[tuple(p) for p in path] for path in outline],
        copper=[[tuple(p) for p in contour] for contour in placed],
    )


def isolation_groups(plan, cleared: list, options: ImportOptions) -> list[Group]:
    """A group per isolation loop offset, then the clearing, if any."""
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
                label=f"copper clearing, {options.clear}, {options.spot:.3f} mm pitch",
                power=options.power,
                speed=options.speed,
                paths=[[tuple(p) for p in path] for path in cleared],
            )
        )
    return groups


def deposit_groups(deposition: copper_deposition.Deposition, options: ImportOptions) -> list[Group]:
    """A group per edge loop offset, then the fill and the narrow traces."""
    groups = [
        Group(
            label=f"copper edge loop {index + 1} at {offset:.3f} mm in",
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
                label=f"copper fill, {options.fill or copper_deposition.CONTOUR}, {options.spot:.3f} mm pitch",
                power=options.power,
                speed=options.speed,
                paths=[[tuple(p) for p in path] for path in deposition.fill],
            )
        )
    if deposition.thin:
        groups.append(
            Group(
                label="copper narrower than the spot, along its middle",
                power=options.power,
                speed=options.speed,
                paths=[[tuple(p) for p in path] for path in deposition.thin],
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
                try:
                    (self.directory / f"{job_id}.json").unlink()
                except OSError:
                    pass
        return True

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
