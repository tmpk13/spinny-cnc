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

from pydantic import BaseModel, Field

from . import kinematics
from .kinematics import Streamer

ANCHOR_CENTER, ANCHOR_KEEP = "center", "keep"
DEFAULT_POWER = 500.0
DEFAULT_SPEED = 400.0
DEFAULT_SPOT = 0.1
# CSS pixels per millimeter at 96 dpi, which is what an SVG length without
# a unit is; the parser's own rounded factor is used so a file in mm comes
# back out in exact mm.
DEFAULT_PPI = 96.0
# Curves are bisected at most this deep when flattening.
FLATTEN_DEPTH = 16

GERBER_SUFFIXES = (".gbr", ".gtl", ".gbl", ".gts", ".gbs", ".gm1")

Point = tuple[float, float]
Polyline = list[Point]


class JobImportError(ValueError):
    """The file could not be turned into a job."""


class Group(BaseModel):
    label: str
    power: float = DEFAULT_POWER
    speed: float = DEFAULT_SPEED
    enabled: bool = True
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


class Offset(BaseModel):
    x: float = 0.0
    y: float = 0.0


class JobStats(BaseModel):
    length_mm: float = 0.0
    seconds: float = 0.0
    max_radius: float = 0.0
    min_radius: float = 0.0
    limited_fraction: float = 0.0
    moves: int = 0


class Job(BaseModel):
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
                    "speed": group.speed,
                    "enabled": group.enabled,
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
        stats = streamer.estimate(self)
        self.stats = JobStats(**stats.to_dict())


class GroupPatch(BaseModel):
    index: int
    label: str | None = None
    power: float | None = None
    speed: float | None = None
    enabled: bool | None = None


class JobPatch(BaseModel):
    name: str | None = None
    groups: list[GroupPatch] | None = None
    offset: Offset | None = None


def apply_patch(job: Job, patch: JobPatch, streamer: Streamer) -> Job:
    if patch.name:
        job.name = patch.name
    for change in patch.groups or []:
        if not 0 <= change.index < len(job.groups):
            raise ValueError(f"no group {change.index}")
        group = job.groups[change.index]
        if change.label is not None:
            group.label = change.label
        if change.power is not None:
            if change.power < 0:
                raise ValueError("power must be >= 0")
            group.power = change.power
        if change.speed is not None:
            if change.speed <= 0:
                raise ValueError("speed must be > 0")
            group.speed = change.speed
        if change.enabled is not None:
            group.enabled = change.enabled
    if patch.offset is not None:
        job.shift(patch.offset.x - job.offset.x, patch.offset.y - job.offset.y)
    job.refresh_stats(streamer)
    return job


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

    def check(self) -> None:
        if self.anchor not in (ANCHOR_CENTER, ANCHOR_KEEP):
            raise JobImportError(f"anchor must be {ANCHOR_CENTER} or {ANCHOR_KEEP}")
        if self.power < 0:
            raise JobImportError("power must be >= 0")
        if self.speed <= 0:
            raise JobImportError("speed must be > 0")
        if self.spot <= 0:
            raise JobImportError("spot must be > 0")
        if self.passes < 1:
            raise JobImportError("passes must be >= 1")


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
        job = from_board(path, name, options)
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
    for group in job.groups:
        if any(len(poly) < 2 for poly in group.joints):
            raise JobImportError("a joint-space path needs at least two points")
        if group.joints and not group.paths:
            group.paths = [kinematics.joint_preview(poly) for poly in group.joints]
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
    groups: dict[tuple[float, float], Group] = {}
    for path, points in zip(paths, placed):
        key = (path.power, path.speed)
        if key not in groups:
            groups[key] = Group(label=f"S{path.power:g} F{path.speed:g}", power=path.power, speed=path.speed)
        groups[key].paths.append(points)
    return Job(
        name=name,
        source="gcode",
        spot=options.spot,
        offset=Offset(x=options.offset[0], y=options.offset[1]),
        groups=list(groups.values()),
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


def from_board(path: Path, name: str, options: ImportOptions) -> Job:
    """Isolation loops for a copper gerber or a KiCad board, with the outline when found."""
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
        plan = isolate.build(copper, config, outline=outline)
    except (isocli.SourceError, gerber.GerberError, ValueError, OSError) as exc:
        raise JobImportError(str(exc)) from exc
    finally:
        if temporary is not None:
            temporary.cleanup()

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
    if plan.outline:
        groups.append(
            Group(
                label="board outline pass 1",
                power=options.power,
                speed=options.speed,
                paths=[[tuple(p) for p in path] for path in plan.outline],
            )
        )
    return Job(
        name=name,
        source=source,
        spot=options.spot,
        offset=Offset(x=options.offset[0], y=options.offset[1]),
        groups=groups,
        outline=[[tuple(p) for p in path] for path in plan.outline],
        copper=[[tuple(p) for p in contour] for contour in plan.copper],
    )


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
