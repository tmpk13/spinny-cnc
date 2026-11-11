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
from dataclasses import dataclass, field
from pathlib import Path

from laser_sweep import isolate

from . import board, cam, carve
from . import clear as copper_clearing
from . import deposit as copper_deposition
from . import outline as board_outline
from .board import is_bottom
from .order import inner_first

Point = tuple[float, float]
Polyline = list[Point]
# x, y, z over the stock's top, and how the tool gets there (carve.RAPID,
# FEED or PLUNGE).
Move = tuple[float, float, float, int]

GERBER_SUFFIXES = board.GERBER_SUFFIXES
BOARD_SUFFIXES = GERBER_SUFFIXES + (".kicad_pcb",)
GCODE_SUFFIXES = (".gcode", ".nc", ".ngc")
MODEL_SUFFIXES = (".stl",)
# The files `read_design` reads.
DESIGN_SUFFIXES = BOARD_SUFFIXES + GCODE_SUFFIXES + MODEL_SUFFIXES
# Over the material for the moves between cuts, mm.
CLEARANCE = 1.0
# A model's chord tolerance is never finer than this: arcs any finer only
# add lines, the cutter does not follow them.
MODEL_TOLERANCE = 0.01
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
    # The board layer the copper was read from (F.Cu, or F.Paste for a
    # stencil); None for a design that is not a board, or a gerber whose
    # name does not say.
    layer: str | None = None
    copper: list = field(default_factory=list)
    outline: list[Polyline] = field(default_factory=list)
    # (center, diameter, end of a slot or None), as the drill file lists them.
    holes: list[tuple[Point, float, Point | None]] = field(default_factory=list)
    # The copper strokes' middles, for a deposit's narrow traces.
    centers: list[Polyline] = field(default_factory=list)
    paths: list[PathSet] = field(default_factory=list)
    # A 3D model's mesh file, which the kernel reads itself; None otherwise.
    model: Path | None = None
    # What reading the design left out, one line each.
    notes: list[str] = field(default_factory=list)

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
    # A model's toolpaths, every path's moves in three dimensions: z over
    # the stock's top, rapids, feeds at `speed` and plunges at `plunge`.
    # The first move of a path is where the tool comes down to from the
    # travel height. With these, `paths` is empty and `depth` and
    # `passes` say nothing about the cut.
    moves: list[list[Move]] = field(default_factory=list)
    # The profile's tool the group is cut with, its id and its name: a
    # change of bit between groups is a stop to fit the next one. None for
    # a group made otherwise, which cuts with whatever is fitted.
    tool_id: str | None = None
    tool_name: str | None = None

    @property
    def has_cuts(self) -> bool:
        return bool(self.paths) or bool(self.moves)


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


def read_board(path: Path, layer: str = board.DEFAULT_LAYER) -> Design:
    """A board's copper, outline and drills as `board.read` reads them: a
    KiCad board on its `layer` (the paste layer for a stencil), or a gerber
    with its siblings found beside it. A layer that fills nothing is
    refused, there being nothing for the operations to cut."""
    try:
        read = board.read(path, layer)
    except board.ReadError as exc:
        raise DesignError(str(exc)) from exc
    if not read.copper:
        raise DesignError(f"{read.file} draws no {read.word}")
    return Design(
        name=read.name,
        source=read.source,
        layer=read.layer,
        copper=read.copper,
        outline=read.outline,
        holes=read.holes,
        centers=copper_deposition.centerlines(read.image),
        notes=read.notes,
    )


def read_design(path: Path, placement: cam.Placement) -> Design:
    """A board, an X/Y gcode file or a 3D model as a design, its suffix
    saying which; the gcode's paths are placed as the profile's
    [placement] says."""
    suffix = path.suffix.lower()
    if suffix in BOARD_SUFFIXES:
        return read_board(path, placement.layer)
    if suffix in GCODE_SUFFIXES:
        design = read_gcode(path.read_text(encoding="utf-8", errors="replace"), path.stem)
        design.paths = place_paths(design.paths, placement.anchor, placement.offset)
        return design
    if suffix in MODEL_SUFFIXES:
        return read_model(path)
    raise DesignError(f"{path.name}: not a board, an X/Y gcode file or an STL model")


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
    if design.model is not None:
        return _model_job(profile, design, name, tolerance)
    notes: list[str] = list(design.notes)
    place = profile.placement
    spot = _isolation_width(profile)
    groups: list[BuiltGroup] = []
    outline: list[Polyline] = []
    copper: list = []
    if design.board:
        if is_bottom(design.layer) and place.mirror == "none":
            # The back is cut with the board turned over, where its copper
            # as drawn lies mirrored; the profile's own word is kept.
            notes.append(
                f'{design.name}: {design.layer} is a back layer and [placement] mirror is "none", so it is cut as drawn,'
                ' which with the board turned over is the copper\'s mirror image; mirror = "x" flips it'
            )
        # One placement for the whole board, around everything that will
        # be cut, at the isolation tool's width (or the narrowest tool's).
        config = isolate.IsoConfig(
            spot=spot,
            passes=_isolation_loops(profile),
            anchor=place.anchor,
            origin=place.offset,
            mirror=place.mirror,
        )
        drill_paths =[[hole[0]] for hole in design.holes]
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
        if operation.source in cam.MODEL_SOURCES:
            notes.append(f"{operation.name}: {design.name} is not a 3D model, so there is nothing to {operation.source}")
            continue
        made = _operation_groups(operation, tool, design, board, notes)
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


# --- a 3D model -------------------------------------------------------------


def read_model(path: Path) -> Design:
    """A mesh file as a design; the kernel reads the mesh itself."""
    if path.suffix.lower() not in MODEL_SUFFIXES:
        raise DesignError(f"{path.name}: a 3D model is an STL file")
    if not path.is_file():
        raise DesignError(f"{path.name}: no such file")
    return Design(name=path.stem, source="stl", model=path)


def model_request(profile: cam.Profile, design: Design, operations: list[cam.Operation], tolerance: float) -> dict:
    """The kernel's request for some of a profile's model operations."""
    depth = profile.axis(cam.DEPTH)
    assert depth is not None and depth.safe is not None
    stock = profile.stock
    return {
        "model": str(design.model),
        "turn": list(profile.model.turn),
        "scale": profile.model.scale,
        "stock": {
            "margin": stock.margin,
            "top": stock.top,
            "size": list(stock.size) if stock.size else None,
            "anchor": profile.placement.anchor,
            "offset": list(profile.placement.offset),
        },
        "tolerance": max(tolerance, MODEL_TOLERANCE),
        "travel": depth.safe,
        "clearance": min(CLEARANCE, depth.safe / 2.0),
        "operations": [_kernel_operation(operation, profile.tool(operation.tool)) for operation in operations],
    }


def _kernel_operation(operation: cam.Operation, tool: cam.Tool) -> dict:
    cutting = operation.cutting
    diameter = tool.diameter
    out = {
        "name": operation.name,
        "strategy": operation.source,
        "tool": {
            "shape": tool.shape,
            "diameter": diameter,
            "corner": tool.corner,
            "angle": tool.angle or 0.0,
            "tip": tool.tip,
        },
        "step_down": cutting["step_down"],
        "stepover": cutting["stepover"] * diameter,
        "leave": cutting["leave"],
        "leave_floor": cutting["leave_floor"],
        "ramp": cutting["ramp"],
        "direction": operation.settings.get("direction", cam.CLIMB),
        "below": cutting["below"],
        "flats": operation.settings.get("flats", True),
        "angle": float(operation.settings.get("angle", 0.0)),
    }
    if "band" in cutting:
        out["band"] = cutting["band"]
    return out


def _model_job(profile: cam.Profile, design: Design, name: str | None, tolerance: float) -> BuiltJob:
    """A model through the profile's rough, waterline and parallel
    operations, by the kernel.

    The enabled operations are planned together, in order, each over the
    stock the ones before it left, which is what lets a finish move
    between its cuts just over the material. One switched off is planned
    alone on the whole block, so turning it on later is safe, if slower.
    """
    notes: list[str] = []
    depth = profile.axis(cam.DEPTH)
    if profile.kinematics != cam.CARTESIAN or depth is None or depth.safe is None:
        raise DesignError(f"{profile.name}: a 3D model is cut on an X/Y machine with a depth axis")
    operations = [operation for operation in profile.operations if operation.source in cam.MODEL_SOURCES]
    for operation in profile.operations:
        if operation.source not in cam.MODEL_SOURCES:
            notes.append(f"{operation.name}: {design.name} is a 3D model, so there is no {operation.source} in it")
    if not operations:
        raise DesignError(f"{profile.name} has no rough, waterline or parallel operation for a 3D model")
    for operation in operations:
        tool = profile.tool(operation.tool)
        if tool.shape == cam.VEE and tool.shank is None:
            raise DesignError(f"{operation.name}: the V bit {tool.id} needs its diameter to cut a model")
    answers: dict[str, dict] = {}
    first: dict | None = None
    try:
        together = [operation for operation in operations if operation.enabled]
        if together:
            first = carve.run(model_request(profile, design, together, tolerance))
            for out in first["operations"]:
                answers[out["name"]] = out
        for operation in operations:
            if operation.enabled:
                continue
            alone = carve.run(model_request(profile, design, [operation], tolerance))
            first = first or alone
            answers[operation.name] = alone["operations"][0]
            notes.append(f"{operation.name}: switched off, so planned on the whole block as if nothing had been cut before it")
    except carve.CarveError as exc:
        raise DesignError(f"{design.name}: {exc}") from exc
    assert first is not None
    notes.extend(first.get("notes", []))
    material = profile.material
    if material is not None and material.note:
        notes.append(f"{material.name}: {material.note}")
    tolerance_used = max(tolerance, MODEL_TOLERANCE)
    groups: list[BuiltGroup] = []
    for operation in operations:
        out = answers[operation.name]
        tool = profile.tool(operation.tool)
        if operation.feeds:
            notes.append(f"{operation.name}: {operation.feeds}")
        notes.extend(f"{operation.name}: {note}" for note in out.get("notes", []))
        if out.get("gouge", 0.0) > 2.0 * tolerance_used:
            raise DesignError(
                f"{operation.name}: the toolpaths come {out['gouge']:.3f} mm into the model, a fault in the kernel; no job was made"
            )
        moves = [[(float(m[0]), float(m[1]), float(m[2]), int(m[3])) for m in path] for path in out["paths"]]
        deepest = -min((m[2] for path in moves for m in path), default=0.0)
        if tool.length is not None and deepest > tool.length + 1e-9:
            notes.append(f"{operation.name}: goes {deepest:.2f} mm under the stock's top, deeper than {tool.name} reaches ({tool.length:g} mm)")
        cutting = operation.cutting
        groups.append(
            BuiltGroup(
                label=f"{operation.name}: {tool.name}",
                tool=cam.SPINDLE,
                power=cutting["rpm"],
                min_power=0.0,
                speed=cutting["feed"],
                passes=1,
                depth=max(deepest, 0.01),
                plunge=cutting["plunge"],
                paths=[],
                enabled=operation.enabled,
                moves=moves,
                tool_id=tool.id,
                tool_name=tool.name,
            )
        )
    if not any(group.moves for group in groups):
        raise DesignError(f"nothing in {design.name} for the operations of {profile.name}")
    if len([g for g in groups if g.enabled]) > 1:
        notes.append("the operations were planned in order, each over what the one before left: run them in that order, none of them skipped")
    low = first["stock"]["min"]
    high = first["stock"]["max"]
    outline = [[tuple(p) for p in loop] for loop in first.get("silhouette", [])]
    outline.append([(low[0], low[1]), (high[0], low[1]), (high[0], high[1]), (low[0], high[1]), (low[0], low[1])])
    model = first["model"]
    notes.insert(
        0,
        f"{design.name}: {model['size'][0]:g} x {model['size'][1]:g} x {model['size'][2]:g} mm, {model['triangles']} triangles, "
        f"in a {high[0] - low[0]:g} x {high[1] - low[1]:g} x {-low[2]:g} mm block with its top at Z 0",
    )
    widths = [profile.tool(operation.tool).width for operation in operations]
    return BuiltJob(
        name=name or design.name,
        source=design.source,
        spot=min(widths),
        offset=profile.placement.offset,
        groups=groups,
        outline=outline,
        copper=[],
        notes=notes,
    )


def isolation_passes(plan: isolate.IsoPlan) -> list[tuple[int, float, list[Polyline]]]:
    """An isolation plan's loops a pass at a time, in the order the passes
    are cut: each pass's index, its distance from the copper and its
    loops."""
    passes = []
    for index in sorted({loop.index for loop in plan.loops}):
        members = [loop for loop in plan.loops if loop.index == index]
        passes.append((index, members[0].offset, [[tuple(p) for p in loop.points] for loop in members]))
    return passes


def _isolation_width(profile: cam.Profile) -> float:
    """The width the isolation is cut at: its operation's, at the depth it
    cuts (a V bit widens with it), else the narrowest tool's."""
    for operation in profile.operations:
        if operation.source == cam.ISOLATION:
            return float(operation.cutting["width"])
    return min(tool.width for tool in profile.tools)


def _isolation_loops(profile: cam.Profile) -> int:
    for operation in profile.operations:
        if operation.source == cam.ISOLATION:
            return int(operation.settings.get("loops", 1))
    return 1


def _shift_of(design: Design, plan, config) -> Point:
    """The shift the plan moved the copper by, read back from the result so
    the drills and the centerlines follow it exactly."""
    before = isolate.transform(design.copper, config, (0.0, 0.0))
    if not before or not plan.copper:
        return (0.0, 0.0)
    a = before[0][0]
    b = plan.copper[0][0]
    return (b[0] - a[0], b[1] - a[1])


def _moved(point: Point, config, shift: Point) -> Point:
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
            tool_id=tool.id,
            tool_name=tool.name,
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
        tool_id=tool.id,
        tool_name=tool.name,
    )


def _operation_groups(
    operation: cam.Operation,
    tool: cam.Tool,
    design: Design,
    board: _Board | None,
    notes: list[str],
) -> list[BuiltGroup]:
    source = operation.source
    prefix = operation.name
    # The width of this operation's cut: the tool's, or for a V bit what
    # the operation's depth makes it.
    width = float(operation.cutting["width"])
    if source == cam.PATHS:
        wanted = str(operation.settings.get("match", "")).lower()
        taken = [found for found in design.paths if wanted in found.label.lower()]
        if not taken:
            notes.append(f"{prefix}: no paths" + (f" labeled {wanted!r}" if wanted else "") + f" in {design.name}")
            return []
        # What lies inside a shape is cut before the shape that frees it.
        return [_group(operation, tool, f"{prefix}: {found.label}", inner_first([list(p) for p in found.paths])) for found in taken]
    if board is None:
        notes.append(f"{prefix}: {design.name} is not a board, so there is no {source} in it")
        return []
    plan = board.plan
    if source == cam.ISOLATION:
        groups = [
            _group(operation, tool, f"{prefix}: loop {index + 1} at {offset:.3f} mm", loops)
            for index, offset, loops in isolation_passes(plan)
        ]
        if plan.bridges:
            notes.append(f"{prefix}: {len(plan.bridges)} places where copper is too close to part at {width:g} mm")
        return groups
    if source == cam.CLEARING:
        pattern = str(operation.settings.get("pattern", "lines"))
        pitch = width * operation.cutting["stepover"] if tool.kind == cam.SPINDLE else width
        # The tool's middle stays on or past the isolation's outermost loop,
        # so its strokes end in that loop's trench; a tool whose radius is
        # more than that loop's distance from the copper stays its radius
        # off instead, or its edge would cut into the copper beside every
        # stroke.
        outermost = max(plan.offsets)
        keep = max(outermost, width / 2.0)
        if keep > outermost:
            notes.append(
                f"{prefix}: {tool.name} cuts {width:g} mm wide, so its middle keeps {keep:g} mm from the copper, past the"
                f" isolation's outermost loop at {outermost:g} mm; copper in a gap narrower than the cut is left where the"
                " isolation does not reach"
            )
        strokes = copper_clearing.clear(
            plan.copper,
            keep,
            width,
            pattern,
            outline=plan.outline,
            pitch=min(width, max(pitch, 1e-3)),
            tolerance=board.tolerance,
            pace=board.pace,
        )
        if not strokes:
            notes.append(f"{prefix}: nothing left to clear")
            return []
        return [_group(operation, tool, f"{prefix}: {pattern}, {width:g} mm {tool.kind}", [list(map(tuple, s)) for s in strokes])]
    if source == cam.OUTLINE:
        if not board.outline:
            notes.append(f"{prefix}: {design.name} has no outline")
            return []
        # A beam cuts on the line; a bit's middle runs its radius off the
        # board, so the part comes out the size it is drawn.
        made = board_outline.cut(board.outline, width / 2.0 if tool.kind == cam.SPINDLE else 0.0)
        if made.loose:
            notes.append(f"{prefix}: {made.loose} pieces of the outline join no loop, so the bit cuts them on their line")
        if made.narrow:
            notes.append(f"{prefix}: {len(made.narrow)} cutouts are narrower than the {width:g} mm bit and are not cut")
        if not made.paths:
            return []
        return [_group(operation, tool, f"{prefix}: board outline", made.paths)]
    if source == cam.DRILLS:
        if not board.holes:
            notes.append(f"{prefix}: {design.name} has no drill file")
            return []
        return _drill_groups(operation, tool, board.holes, notes, width)
    if source == cam.DEPOSIT:
        fill = str(operation.settings.get("fill", copper_deposition.CONTOUR))
        deposition = copper_deposition.deposit(
            plan.copper,
            width,
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
    width: float | None = None,
) -> list[BuiltGroup]:
    """Drilling: a bit is put down at the center of a hole its own size and
    milled round a wider one; a laser marks each hole instead. `width` is
    the cut's at the operation's depth, the tool's own when left out."""
    width = tool.width if width is None else width
    prefix = operation.name
    if tool.kind == cam.LASER:
        from laser_sweep import excellon

        style = str(operation.settings.get("marks", excellon.CIRCLE))
        drills = excellon.Drills(
            holes=[excellon.Hole(at=center, diameter=diameter, end=end) for center, diameter, end in holes],
            tools={},
        )
        marks = excellon.marks(drills, style, width)
        return [_group(operation, tool, f"{prefix}: {len(holes)} holes marked as {style}", [list(map(tuple, m)) for m in marks])]
    pecks: list[Polyline] = []
    rounds: list[Polyline] = []
    narrow = 0
    slots = 0
    for center, diameter, end in holes:
        if end is not None:
            slots += 1
            rounds.append(_slot(center, end, diameter, width))
            continue
        if diameter < width - HOLE_SLACK:
            narrow += 1
        if diameter > width + HOLE_SLACK:
            rounds.append(_circle(center, (diameter - width) / 2.0))
        else:
            pecks.append([center])
    if narrow:
        notes.append(f"{prefix}: {narrow} holes are narrower than the {width:g} mm bit and come out its size")
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
    return [(center[0] + x, center[1] + y) for x, y in copper_clearing.ring_points(radius, 2.0 * HOLE_TOLERANCE)]


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
    """Ready paths placed together as a board would be (`cam.place`)."""
    placed = iter(cam.place([path for found in sets for path in found.paths], anchor, offset))
    return [PathSet(found.label, [next(placed) for _ in found.paths]) for found in sets]


def read_gcode(text: str, name: str) -> Design:
    """Cut paths of an X/Y gcode file, one set per run at the same power and
    feed. A run is told from the next by its label, so a power or a feed
    that differs from the one before only past what the label prints joins
    its set."""
    from . import convert

    runs = convert.runs(convert.read_paths(text), key=convert.run_label)
    sets = [PathSet(convert.run_label(run[0]), [[tuple(p) for p in path.points] for path in run]) for run in runs]
    if not sets:
        raise DesignError(f"{name}: no cuts in the gcode")
    return Design(name=name, source="gcode", paths=sets)
