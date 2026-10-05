"""A design through a CAM profile: every enabled operation becomes a run of
paths with the cutting settings its tool gives it.

The geometry comes from the sibling engine (copper, isolation loops, the
outline, the drills) and this package's clearing and deposition; the
operations only say which of it is cut, with what, and how deep. The result
is plain data the web backend wraps into its job and the command line tool
writes gcode from.
"""

from __future__ import annotations

import math
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

from . import cam
from . import clear as copper_clearing
from . import deposit as copper_deposition

Point = tuple[float, float]
Polyline = list[Point]

GERBER_SUFFIXES = (".gbr", ".gtl", ".gbl", ".gts", ".gbs", ".gm1")
BOARD_SUFFIXES = GERBER_SUFFIXES + (".kicad_pcb",)
# A hole this much wider than the bit is milled round; narrower, the bit is
# put down at its center.
HOLE_SLACK = 0.02
# Chord tolerance of a milled hole.
HOLE_TOLERANCE = 0.005


class DesignError(ValueError):
    """The design cannot go through the profile."""


@dataclass
class PathSet:
    """Paths a design brought in by themselves (an SVG stroke, a run of gcode
    at one power), for the `paths` source to pick from by label."""

    label: str
    paths: list[Polyline]


@dataclass
class Design:
    """What a design offers the operations: copper with its outline and
    drills for a board, or ready paths for anything else. Everything is in
    board mm, placed by the caller."""

    name: str
    source: str
    copper: list = field(default_factory=list)
    outline: list[Polyline] = field(default_factory=list)
    # (center, diameter, end of a slot or None), as the drill file lists them.
    holes: list[tuple[Point, float, Point | None]] = field(default_factory=list)
    # The copper strokes' middles, for a deposit's narrow traces.
    centers: list[Polyline] = field(default_factory=list)
    paths: list[PathSet] = field(default_factory=list)
    # The raw gerber image, for a deposit's centerlines; None for other designs.
    image: object | None = None

    @property
    def board(self) -> bool:
        return bool(self.copper)


@dataclass
class BuiltGroup:
    label: str
    tool: str
    power: float
    min_power: float
    speed: float
    passes: int
    depth: float
    plunge: float
    paths: list[Polyline]
    enabled: bool = True
    # A laser's height over the surface, for a controller with a depth axis.
    height: float | None = None

    def document(self) -> dict:
        return {
            "label": self.label,
            "tool": self.tool,
            "power": self.power,
            "min_power": self.min_power,
            "speed": self.speed,
            "passes": self.passes,
            "depth": self.depth,
            "plunge": self.plunge,
            "enabled": self.enabled,
            "paths": [[list(p) for p in path] for path in self.paths],
        }


@dataclass
class BuiltJob:
    name: str
    source: str
    spot: float
    offset: Point
    groups: list[BuiltGroup]
    outline: list[Polyline]
    copper: list[Polyline]
    # What was left out or changed on the way, one line each.
    notes: list[str]


# --- reading a board ----------------------------------------------------------


def read_board(path: Path, layer: str = "F.Cu") -> Design:
    """A board's copper, outline and drills: a KiCad board exported through
    kicad-cli, or a copper gerber with its siblings found beside it."""
    from laser_sweep import excellon, geom, gerber, isocli

    path = Path(path)
    temporary: tempfile.TemporaryDirectory | None = None
    try:
        if path.suffix.lower() == ".kicad_pcb":
            temporary = tempfile.TemporaryDirectory(prefix="spinny-cam-")
            into = Path(temporary.name)
            isocli.export_board(path, layer, outline=True, drill=True, into=into)
            copper_path = isocli.find_layer(into, layer)
            source = "kicad"
        else:
            copper_path = path
            into = path.parent
            source = "gerber"
        try:
            outline_path: Path | None = isocli.find_layer(into, "Edge.Cuts")
        except isocli.SourceError:
            outline_path = None
        drill_path = isocli.find_drill(into, path.stem.split("-")[0]) if into.is_dir() else None
        image = gerber.read(copper_path)
        copper = geom.copper(image)
        if not copper:
            raise DesignError(f"{copper_path.name} draws no copper")
        outline: list[Polyline] = []
        if outline_path is not None:
            outline = isocli.outline_cut(isocli.outline_paths(gerber.read(outline_path)), 0.0)
        holes: list[tuple[Point, float, Point | None]] = []
        if drill_path is not None:
            drills = excellon.read(drill_path)
            holes = [(tuple(hole.at), float(hole.diameter), tuple(hole.end) if hole.end else None) for hole in drills.holes]
        return Design(
            name=path.stem,
            source=source,
            copper=copper,
            outline=[list(map(tuple, p)) for p in outline],
            holes=holes,
            centers=copper_deposition.centerlines(image),
            image=image,
        )
    except (isocli.SourceError, gerber.GerberError, OSError) as exc:
        raise DesignError(str(exc)) from exc
    finally:
        if temporary is not None:
            temporary.cleanup()


# --- building -----------------------------------------------------------------


def build(
    profile: cam.Profile,
    design: Design,
    name: str | None = None,
    tolerance: float = 0.005,
    pace: float = copper_clearing.DEFAULT_PACE,
) -> BuiltJob:
    """Every enabled operation of the profile on the design, in the
    profile's order; a disabled one is kept as a group switched off, so it
    can be turned on at the machine.

    `tolerance` is the chord tolerance the paths will be streamed at, which
    the clearing rings are drawn to; `pace` orders a radial clearing.
    """
    from laser_sweep import isolate

    notes: list[str] = []
    place = profile.placement
    spot = _isolation_width(profile)
    groups: list[BuiltGroup] = []
    outline: list[Polyline] = []
    copper: list = []
    if design.board:
        # One placement for the whole board, around everything that will
        # be cut, at the isolation tool's width (or the narrowest tool's).
        config = isolate.IsoConfig(
            spot=spot,
            passes=_isolation_loops(profile),
            anchor=place.anchor,
            origin=place.offset,
            mirror=place.mirror,
        )
        isolate.offsets_for(config)
        drill_paths = [[hole[0]] for hole in design.holes]
        plan = isolate.build(design.copper, config, outline=design.outline, drills=drill_paths)
        shift = _shift_of(design, plan, config)
        copper = plan.copper
        outline = [list(map(tuple, p)) for p in plan.outline]
        holes = [
            (_moved(center, config, shift), diameter, _moved(end, config, shift) if end else None)
            for center, diameter, end in design.holes
        ]
        centers = isolate.transform(design.centers, config, shift) if design.centers else []
        board = _Board(plan, outline, holes, centers, tolerance, pace)
    else:
        board = None
    for operation in profile.operations:
        tool = profile.tool(operation.tool)
        made = _operation_groups(operation, tool, design, board, profile, notes)
        groups.extend(made)
    if not any(group.paths for group in groups):
        raise DesignError(f"nothing in {design.name} for the operations of {profile.name}")
    return BuiltJob(
        name=name or design.name,
        source=design.source,
        spot=spot,
        offset=place.offset,
        groups=groups,
        outline=outline,
        copper=[list(map(tuple, contour)) for contour in copper],
        notes=notes,
    )


@dataclass
class _Board:
    plan: object
    outline: list[Polyline]
    holes: list[tuple[Point, float, Point | None]]
    centers: list
    tolerance: float
    pace: float


def _isolation_width(profile: cam.Profile) -> float:
    """The width the isolation is cut at: its tool's, else the narrowest tool's."""
    for operation in profile.operations:
        if operation.source == cam.ISOLATION:
            return profile.tool(operation.tool).width
    return min(tool.width for tool in profile.tools)


def _isolation_loops(profile: cam.Profile) -> int:
    for operation in profile.operations:
        if operation.source == cam.ISOLATION:
            return int(operation.settings.get("loops", 1))
    return 1


def _shift_of(design: Design, plan, config) -> Point:
    """The shift the plan moved the copper by, read back from the result so
    the drills and the centerlines follow it exactly."""
    from laser_sweep import isolate

    before = isolate.transform(design.copper, config, (0.0, 0.0))
    if not before or not plan.copper:
        return (0.0, 0.0)
    a = before[0][0]
    b = plan.copper[0][0]
    return (b[0] - a[0], b[1] - a[1])


def _moved(point: Point, config, shift: Point) -> Point:
    from laser_sweep import isolate

    moved = isolate.transform([[point]], config, shift)
    return (float(moved[0][0][0]), float(moved[0][0][1]))


def _group(operation: cam.Operation, tool: cam.Tool, label: str, paths: list[Polyline]) -> BuiltGroup:
    cutting = operation.cutting
    if tool.kind == cam.SPINDLE:
        return BuiltGroup(
            label=label,
            tool=cam.SPINDLE,
            power=cutting["rpm"],
            min_power=0.0,
            speed=cutting["feed"],
            passes=int(cutting["passes"]),
            depth=cutting["depth"],
            plunge=cutting["plunge"],
            paths=paths,
            enabled=operation.enabled,
        )
    return BuiltGroup(
        label=label,
        tool=cam.LASER,
        power=cutting["power"],
        min_power=cutting["min_power"],
        speed=cutting["speed"],
        passes=int(cutting["passes"]),
        depth=cam.DEFAULT_DEPTH,
        plunge=cam.DEFAULT_PLUNGE,
        paths=paths,
        enabled=operation.enabled,
        height=cutting.get("height"),
    )


def _operation_groups(
    operation: cam.Operation,
    tool: cam.Tool,
    design: Design,
    board: _Board | None,
    profile: cam.Profile,
    notes: list[str],
) -> list[BuiltGroup]:
    source = operation.source
    prefix = operation.name
    if source == cam.PATHS:
        wanted = str(operation.settings.get("match", "")).lower()
        taken = [found for found in design.paths if wanted in found.label.lower()]
        if not taken:
            notes.append(f"{prefix}: no paths" + (f" labeled {wanted!r}" if wanted else "") + f" in {design.name}")
            return []
        return [_group(operation, tool, f"{prefix}: {found.label}", [list(p) for p in found.paths]) for found in taken]
    if board is None:
        notes.append(f"{prefix}: {design.name} is not a board, so there is no {source} in it")
        return []
    plan = board.plan
    if source == cam.ISOLATION:
        groups = []
        for index in sorted({loop.index for loop in plan.loops}):
            members = [loop for loop in plan.loops if loop.index == index]
            label = f"{prefix}: loop {index + 1} at {members[0].offset:.3f} mm"
            groups.append(_group(operation, tool, label, [[tuple(p) for p in loop.points] for loop in members]))
        if plan.bridges:
            notes.append(f"{prefix}: {len(plan.bridges)} places where copper is too close to part at {tool.width:g} mm")
        return groups
    if source == cam.CLEARING:
        pattern = str(operation.settings.get("pattern", "lines"))
        pitch = tool.width * operation.cutting.get("stepover", 1.0) if tool.kind == cam.SPINDLE else tool.width
        strokes = copper_clearing.clear(
            plan.copper,
            max(plan.offsets),
            tool.width,
            pattern,
            outline=plan.outline,
            pitch=min(tool.width, max(pitch, 1e-3)),
            tolerance=board.tolerance,
            pace=board.pace,
        )
        if not strokes:
            notes.append(f"{prefix}: nothing left to clear")
            return []
        return [_group(operation, tool, f"{prefix}: {pattern}, {tool.width:g} mm {tool.kind}", [list(map(tuple, s)) for s in strokes])]
    if source == cam.OUTLINE:
        if not board.outline:
            notes.append(f"{prefix}: {design.name} has no outline")
            return []
        return [_group(operation, tool, f"{prefix}: board outline", [list(p) for p in board.outline])]
    if source == cam.DRILLS:
        if not board.holes:
            notes.append(f"{prefix}: {design.name} has no drill file")
            return []
        return _drill_groups(operation, tool, board.holes, notes)
    if source == cam.DEPOSIT:
        fill = str(operation.settings.get("fill", copper_deposition.CONTOUR))
        deposition = copper_deposition.deposit(
            plan.copper,
            tool.width,
            fill,
            passes=int(operation.settings.get("loops", 1)),
            centers=board.centers,
            tolerance=board.tolerance,
            pace=board.pace,
        )
        groups = [
            _group(operation, tool, f"{prefix}: edge loop {index + 1} at {offset:.3f} mm in", [list(map(tuple, loop)) for loop in loops])
            for index, (offset, loops) in enumerate(zip(deposition.offsets, deposition.edges))
            if loops
        ]
        if deposition.fill:
            groups.append(_group(operation, tool, f"{prefix}: fill, {fill}", [list(map(tuple, p)) for p in deposition.fill]))
        if deposition.thin:
            groups.append(_group(operation, tool, f"{prefix}: copper narrower than the tool, along its middle", [list(map(tuple, p)) for p in deposition.thin]))
        return groups
    raise DesignError(f"{prefix}: unknown source {source!r}")


def _drill_groups(
    operation: cam.Operation,
    tool: cam.Tool,
    holes: list[tuple[Point, float, Point | None]],
    notes: list[str],
) -> list[BuiltGroup]:
    """Drilling: a bit is put down at the center of a hole its own size and
    milled round a wider one; a laser marks each hole instead."""
    prefix = operation.name
    if tool.kind == cam.LASER:
        from laser_sweep import excellon

        style = str(operation.settings.get("marks", excellon.CIRCLE))
        drills = excellon.Drills(
            holes=[excellon.Hole(at=center, diameter=diameter, end=end) for center, diameter, end in holes],
            tools={},
        )
        marks = excellon.marks(drills, style, tool.width)
        return [_group(operation, tool, f"{prefix}: {len(holes)} holes marked as {style}", [list(map(tuple, m)) for m in marks])]
    pecks: list[Polyline] = []
    rounds: list[Polyline] = []
    narrow = 0
    slots = 0
    for center, diameter, end in holes:
        if end is not None:
            slots += 1
            rounds.append(_slot(center, end, diameter, tool.width))
            continue
        if diameter < tool.width - HOLE_SLACK:
            narrow += 1
        if diameter > tool.width + HOLE_SLACK:
            rounds.append(_circle(center, (diameter - tool.width) / 2.0))
        else:
            pecks.append([center])
    if narrow:
        notes.append(f"{prefix}: {narrow} holes are narrower than the {tool.width:g} mm bit and come out its size")
    if slots:
        notes.append(f"{prefix}: {slots} slots are milled along their middle")
    groups = []
    if pecks:
        groups.append(_group(operation, tool, f"{prefix}: {len(pecks)} holes at the bit's size", pecks))
    if rounds:
        groups.append(_group(operation, tool, f"{prefix}: {len(rounds)} holes milled round", rounds))
    return groups


def _circle(center: Point, radius: float) -> Polyline:
    """A closed loop at `radius`, with chords within the hole tolerance,
    starting and ending at the same point."""
    if radius <= HOLE_TOLERANCE:
        return [center]
    count = max(8, int(math.ceil(math.pi / math.acos(max(-1.0, 1.0 - HOLE_TOLERANCE / radius)))))
    points = [
        (center[0] + radius * math.cos(2.0 * math.pi * k / count), center[1] + radius * math.sin(2.0 * math.pi * k / count))
        for k in range(count)
    ]
    return points + [points[0]]


def _slot(start: Point, end: Point, diameter: float, width: float) -> Polyline:
    """A slot as the bit's path: along the middle, widened to the slot when
    the bit is narrower than it, as a loop inset by the bit's radius."""
    inset = (diameter - width) / 2.0
    if inset <= HOLE_SLACK:
        return [start, end]
    dx, dy = end[0] - start[0], end[1] - start[1]
    length = math.hypot(dx, dy)
    if length == 0.0:
        return _circle(start, inset)
    nx, ny = -dy / length * inset, dx / length * inset
    return [
        (start[0] + nx, start[1] + ny),
        (end[0] + nx, end[1] + ny),
        (end[0] - nx, end[1] - ny),
        (start[0] - nx, start[1] - ny),
        (start[0] + nx, start[1] + ny),
    ]


# --- designs that are not boards ------------------------------------------------


def place_paths(sets: list[PathSet], anchor: str, offset: Point) -> list[PathSet]:
    """Ready paths placed as a board would be: centered on the origin, their
    lower left corner on it, or left where they are, then moved by `offset`."""
    points = [p for found in sets for path in found.paths for p in path]
    if not points:
        return sets
    if anchor == cam.KEEP:
        dx, dy = offset
    else:
        min_x, max_x = min(p[0] for p in points), max(p[0] for p in points)
        min_y, max_y = min(p[1] for p in points), max(p[1] for p in points)
        if anchor == cam.CENTER:
            dx, dy = offset[0] - (min_x + max_x) / 2.0, offset[1] - (min_y + max_y) / 2.0
        elif anchor == cam.CORNER:
            dx, dy = offset[0] - min_x, offset[1] - min_y
        else:
            raise DesignError(f"unknown anchor {anchor!r}")
    return [PathSet(found.label, [[(x + dx, y + dy) for x, y in path] for path in found.paths]) for found in sets]


def read_gcode(text: str, name: str) -> Design:
    """Cut paths of an X/Y gcode file, one set per run at the same power and feed."""
    from .convert import read_paths

    sets: list[PathSet] = []
    for path in read_paths(text):
        label = f"S{path.power:g} F{path.speed:g}"
        if sets and sets[-1].label == label:
            sets[-1].paths.append([tuple(p) for p in path.points])
        else:
            sets.append(PathSet(label, [[tuple(p) for p in path.points]]))
    if not sets:
        raise DesignError(f"{name}: no cuts in the gcode")
    return Design(name=name, source="gcode", paths=sets)
