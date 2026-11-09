"""The Plot page's operations: simple cuts described by their numbers and
made into a job, one operation or several in the same job, and made again
for another bit or spot.

An operation is drilling points, drilling (or boring) a board job's holes,
a line through points, facing a rectangle, or a pocket or a profile of a
rectangle (its corners square or rounded) or a circle. A job of several
operations cuts them in order, each its own groups, with one cutter and
one bit or spot, since nothing changes the tool halfway through a run.
With `cutter` spindle every group is milled and goes
down in steps of `step_down` to `depth` under the surface, the way every
milled group does. With `cutter` laser the same paths are burnt with a beam
`tool` mm across at `power`, each pass the whole path again: a point, which
a beam cannot drill, is marked with a ring the spot across, and a board
hole is cut along its inside edge (or cleared in rings with `bore`).
"""

from __future__ import annotations

import math
from collections import defaultdict
from collections.abc import Callable
from typing import Literal

from pydantic import Field
from spinny_laser import align as alignment
from spinny_laser import mill as ops
from spinny_laser import pads as board_pads

from .jobs import (
    LASER,
    MAX_GROUP_PASSES,
    MAX_VALUE,
    SETTINGS,
    SPINDLE,
    Finite,
    Group,
    Job,
    JobImportError,
    Recipe,
    carry_settings,
    check_depth,
    check_power,
    check_speed,
    label_stem,
)
from .kinematics import Streamer

DRILL, HOLES, LINE, FACE, POCKET, PROFILE = "drill", "holes", "line", "face", "pocket", "profile"
RECT, CIRCLE = "rect", "circle"
# Holes this much wider than the bit are bored, not drilled, when boring
# is asked for, mm: a drill's run-out is about this.
BORE_SLACK = 0.05
# Hole sizes are told apart to this, mm.
SIZE_DECIMALS = 2
MAX_POINTS = 5000
# Operations in one job.
MAX_OPERATIONS = 100


class MillOperation(Finite):
    """One operation as the page sends it. Which of the shape's fields
    count follows `kind` (and `shape`); the rest are ignored."""

    kind: Literal["drill", "holes", "line", "face", "pocket", "profile"]
    # What cuts: a spindle's bit, or a laser's beam.
    cutter: Literal["spindle", "laser"] = SPINDLE
    # The job's name; left out, one is made from the operation.
    name: str | None = None
    # The bit's diameter, or the beam's spot, mm.
    tool: float = 1.0
    # How deep under the surface the cut ends, and how far each pass goes
    # down, mm: the passes are as many as it takes.
    depth: float = 0.5
    step_down: float = 0.5
    # A face or a pocket: how far apart its rows or loops are, as a share
    # of the bit.
    stepover: float = 0.4
    # Feed along the cut and down into it, mm/min, and the spindle's S.
    speed: float = 300.0
    plunge: float = 60.0
    spindle: float = 10000.0
    # A laser: its power and how many times each path is burnt.
    power: float = 500.0
    passes: int = 1
    # Climb milling (with the spindle turning clockwise), else conventional.
    climb: bool = True
    # A drill or a line: its points, board mm; a line may close.
    points: list[tuple[float, float]] = Field(default_factory=list)
    closed: bool = False
    # A pocket or a profile: of a rectangle or a circle.
    shape: Literal["rect", "circle"] = RECT
    # A rectangle (a face, or a pocket or profile of one) by two corners,
    # and for a pocket or a profile the radius its corners are rounded to.
    x0: float = 0.0
    y0: float = 0.0
    x1: float = 0.0
    y1: float = 0.0
    corner: float = 0.0
    # A circle by its center and diameter.
    cx: float = 0.0
    cy: float = 0.0
    diameter: float = 0.0
    # A profile: outside the shape, inside it, or on its line.
    side: Literal["outside", "inside", "on"] = ops.OUTSIDE
    # Holes: the job whose drill holes they are, the diameters to take
    # (all when left out), and whether a hole wider than the bit is bored
    # out with it rather than drilled.
    job: str | None = None
    sizes: list[float] | None = None
    bore: bool = True
    # The holes themselves, x, y and diameter: filled in from the job when
    # the operation is made, and kept with it, so the operation is made
    # again (another bit, another operation beside it) without that job.
    holes: list[tuple[float, float, float]] | None = None

    @property
    def laser(self) -> bool:
        return self.cutter == LASER

    def pass_count(self) -> int:
        """A laser's passes as given; a spindle's as many as it takes to the depth."""
        if self.laser:
            return self.passes
        return max(1, math.ceil(self.depth / self.step_down - 1e-9))

    def check(self) -> None:
        try:
            if self.laser:
                if not (math.isfinite(self.tool) and 0.0 < self.tool <= 100.0):
                    raise ValueError("the spot must be above 0 and at most 100 mm across")
                if not 1 <= self.passes <= MAX_GROUP_PASSES:
                    raise ValueError(f"the passes must be 1 to {MAX_GROUP_PASSES}")
                check_speed(self.speed, "the speed")
                check_power(self.power, "the power")
            else:
                ops.check_tool(self.tool)
                check_depth(self.depth)
                if not (math.isfinite(self.step_down) and 0.0 < self.step_down):
                    raise ValueError("the step down must be above 0 mm")
                if self.pass_count() > MAX_GROUP_PASSES:
                    raise ValueError(f"{self.depth:g} mm in steps of {self.step_down:g} is over {MAX_GROUP_PASSES} passes")
                check_speed(self.speed, "the feed")
                check_speed(self.plunge, "the plunge")
                check_power(self.spindle, "the spindle speed")
        except ValueError as exc:
            raise JobImportError(str(exc)) from exc
        values = [self.x0, self.y0, self.x1, self.y1, self.cx, self.cy, self.diameter, self.corner]
        values += [v for point in self.points for v in point]
        if not all(abs(v) <= MAX_VALUE for v in values):
            raise JobImportError(f"coordinates must be within {MAX_VALUE:g} mm")
        if len(self.points) > MAX_POINTS:
            raise JobImportError(f"at most {MAX_POINTS} points")
        if self.holes is not None and len(self.holes) > MAX_POINTS:
            raise JobImportError(f"at most {MAX_POINTS} holes")


class MillJobBody(Finite):
    """A job of one operation or several as the page sends it: `job` names
    the Plot page job they are to replace, None for a new job; `like` names
    a job a new one is put as, its operations typed in that job's frame
    from before its move."""

    ops: list[MillOperation] = Field(min_length=1, max_length=MAX_OPERATIONS)
    name: str | None = None
    job: str | None = None
    like: str | None = None


def _group(op: MillOperation, label: str, paths: list[list[tuple[float, float]]]) -> Group:
    if op.laser:
        return Group(label=label, power=op.power, speed=op.speed, passes=op.passes, tool=LASER, paths=paths)
    return Group(
        label=label,
        power=op.spindle,
        speed=op.speed,
        passes=op.pass_count(),
        depth=op.depth,
        plunge=op.plunge,
        tool=SPINDLE,
        paths=paths,
    )


def _points(op: MillOperation, points: list[tuple[float, float]]) -> list[list[tuple[float, float]]]:
    """A drill at every point, or for a beam, which drills nothing standing
    still, a ring the spot across about it."""
    if op.laser:
        return [ops.circle(x, y, op.tool / 2.0, tolerance=min(ops.DEFAULT_TOLERANCE, op.tool / 8.0)) for x, y in points]
    return ops.drill(points)


def _mm(value: float) -> str:
    return f"{value:g}"


def _rect_outline(op: MillOperation, corner: float = 0.0) -> list[list[tuple[float, float]]]:
    return [ops.rounded_rectangle(op.x0, op.y0, op.x1, op.y1, corner, tolerance=max(0.01, corner * 0.002))]


def _corners(op: MillOperation) -> str:
    """How a rectangle's corners are rounded, for its label; nothing when square."""
    return f", corners R{_mm(op.corner)}" if op.corner > 0.0 else ""


def _circle_outline(cx: float, cy: float, diameter: float) -> list[tuple[float, float]]:
    return ops.circle(cx, cy, diameter / 2.0, tolerance=max(0.01, diameter * 0.002))


def size_of(diameter: float) -> float:
    """A hole's size as the page lists it and sends it back: the diameter
    in hundredths rounded half up, the very arithmetic the page does, so a
    diameter on a half (3.175 mm, 1/8 in) comes out the same number on
    both sides. round() breaks that tie by the binary value's digits, which
    for 3.175 gives 3.17 where the page shows 3.18."""
    scale = 10**SIZE_DECIMALS
    return math.floor(diameter * scale + 0.5) / scale


def _wanted(op: MillOperation) -> set[float] | None:
    """The hole sizes a holes operation takes; None for all."""
    return None if op.sizes is None else {size_of(size) for size in op.sizes}


def hole_groups(op: MillOperation, holes: list[tuple[float, float, float]]) -> tuple[list[Group], list[str]]:
    """A group a hole size, smallest first, each in a short tour on from
    where the last one ended: drilled, or bored out with the bit when it
    is wider than the bit and boring is asked for."""
    notes: list[str] = []
    wanted = _wanted(op)
    by_size: dict[float, list[tuple[float, float]]] = defaultdict(list)
    for x, y, d in holes:
        size = size_of(d)
        if wanted is None or size in wanted:
            by_size[size].append((x, y))
    if not by_size:
        raise JobImportError("no holes of the sizes asked for")
    groups: list[Group] = []
    here = (0.0, 0.0)
    small = 0
    for size in sorted(by_size):
        points = by_size[size]
        order = board_pads.tour(points, here)
        points = [points[i] for i in order]
        here = points[-1]
        count = len(points)
        wide = size > op.tool + BORE_SLACK
        if op.bore and wide:
            paths = [ops.pocket_circle(x, y, size, op.tool, min(op.stepover, 1.0), op.climb)[0] for x, y in points]
            groups.append(_group(op, f"{'clear' if op.laser else 'bore'} {size:.2f} mm holes ({count})", paths))
        elif op.laser and wide:
            # The beam along the hole's edge, inside it: the plug drops out.
            paths = [ops.profile_circle(x, y, size, op.tool, ops.INSIDE, op.climb)[0] for x, y in points]
            groups.append(_group(op, f"cut {size:.2f} mm holes ({count})", paths))
        else:
            if size < op.tool - BORE_SLACK:
                small += count
            groups.append(_group(op, f"{'mark' if op.laser else 'drill'} {size:.2f} mm holes ({count})", _points(op, points)))
    if small:
        notes.append(f"{small} holes are smaller than the {_mm(op.tool)} mm {'spot' if op.laser else 'bit'} and come out its size")
    return groups, notes


def build(op: MillOperation, holes: list[tuple[float, float, float]] | None = None, streamer: Streamer | None = None) -> tuple[Job, list[str]]:
    """The operation's job, not stored, and what to know about it; `holes`
    are the board job's holes for a holes operation, x, y and diameter."""
    op.check()
    notes: list[str] = []
    outline: list[list[tuple[float, float]]] = []
    kept_holes: list[tuple[float, float, float]] = []
    try:
        if op.kind == DRILL:
            if not op.points:
                raise ops.MillError("a drill needs at least one point")
            groups = [_group(op, f"{'mark' if op.laser else 'drill'} {len(op.points)} points", _points(op, op.points))]
            outline = [_circle_outline(x, y, op.tool) for x, y in op.points]
            name = f"{'mark' if op.laser else 'drill'} {len(op.points)} points"
        elif op.kind == HOLES:
            if not holes:
                raise JobImportError("the job has no drill holes: import its board with the drill file")
            groups, notes = hole_groups(op, holes)
            wanted = _wanted(op)
            kept_holes = [h for h in holes if wanted is None or size_of(h[2]) in wanted]
            outline = [_circle_outline(x, y, d) for x, y, d in kept_holes]
            name = f"holes {len(kept_holes)}"
        elif op.kind == LINE:
            paths = ops.line(op.points, op.closed)
            groups = [_group(op, f"{'closed line' if op.closed else 'line'} through {len(op.points)} points", paths)]
            name = f"line {len(op.points)} points"
        elif op.kind == FACE:
            paths = ops.face(op.x0, op.y0, op.x1, op.y1, op.tool, op.stepover)
            w, h = abs(op.x1 - op.x0), abs(op.y1 - op.y0)
            groups = [_group(op, f"face {_mm(w)} x {_mm(h)} mm", paths)]
            outline = _rect_outline(op)
            name = f"face {_mm(w)} x {_mm(h)}"
        elif op.kind in (POCKET, PROFILE):
            if op.shape == CIRCLE:
                if op.kind == POCKET:
                    paths = ops.pocket_circle(op.cx, op.cy, op.diameter, op.tool, op.stepover, op.climb)
                else:
                    paths = ops.profile_circle(op.cx, op.cy, op.diameter, op.tool, op.side, op.climb)
                if op.laser and all(len(path) < 2 for path in paths):
                    # A bit drills such a circle; a beam burns nothing
                    # standing still, and a ring about the point would burn
                    # twice the circle's width.
                    raise JobImportError(
                        f"the {_mm(op.tool)} mm spot fills the {_mm(op.diameter)} mm circle, and a beam burns nothing standing still:"
                        " mark its middle with a drill point, or give a wider circle"
                    )
                size = f"{_mm(op.diameter)} mm circle"
                outline = [_circle_outline(op.cx, op.cy, op.diameter)]
            else:
                if op.kind == POCKET:
                    paths = ops.pocket_rect(op.x0, op.y0, op.x1, op.y1, op.tool, op.stepover, op.climb, corner=op.corner)
                else:
                    paths = ops.profile_rect(op.x0, op.y0, op.x1, op.y1, op.tool, op.side, op.climb, corner=op.corner)
                size = f"{_mm(abs(op.x1 - op.x0))} x {_mm(abs(op.y1 - op.y0))} mm{_corners(op)}"
                outline = _rect_outline(op, op.corner)
            what = "pocket" if op.kind == POCKET else f"profile {op.side}"
            groups = [_group(op, f"{what} {size}", paths)]
            name = f"{what} {size}"
            if op.kind == PROFILE and op.side != ops.INSIDE:
                notes.append("no tabs: a part cut free can move at the last pass, so hold it down or leave a skin")
        else:
            raise JobImportError(f"no operation {op.kind!r}")
    except ops.MillError as exc:
        raise JobImportError(str(exc)) from exc
    passes = op.pass_count()
    if op.laser:
        notes.append(f"{passes} pass{'es' if passes != 1 else ''} at S{_mm(op.power)} and {_mm(op.speed)} mm/min, a {_mm(op.tool)} mm spot")
    else:
        notes.append(f"{passes} pass{'es' if passes != 1 else ''} of {_mm(op.depth / passes)} mm down to {_mm(op.depth)} mm")
    job = Job(
        name=(op.name or "").strip() or name,
        source="mill",
        spot=op.tool,
        groups=groups,
        outline=outline,
        holes=kept_holes,
        recipe=Recipe(mill=op.model_dump()),
    )
    if streamer is not None:
        job.refresh_stats(streamer)
    return job, notes


def recipe_ops(recipe: Recipe | None) -> list[dict]:
    """The operations a Plot page job was made from: its list, or the one
    operation a job made before there were lists keeps."""
    if recipe is None:
        return []
    if recipe.ops:
        return list(recipe.ops)
    return [recipe.mill] if recipe.mill is not None else []


def _bit(op: MillOperation) -> str:
    return "spot" if op.laser else "bit"


def build_job(
    op_list: list[MillOperation],
    holes_of: Callable[[MillOperation], list[tuple[float, float, float]] | None] | None = None,
    streamer: Streamer | None = None,
    name: str | None = None,
) -> tuple[Job, list[str]]:
    """The job of several operations, not stored, and what to know about
    it: each operation's groups in order, every outline and hole, the
    notes numbered by operation when there are several. `holes_of` gives a
    holes operation the board job's holes where it does not carry them."""
    if not op_list:
        raise JobImportError("a job needs at least one operation")
    first = op_list[0]
    for index, op in enumerate(op_list[1:], 2):
        if op.cutter != first.cutter:
            raise JobImportError(f"operation {index} cuts with a {op.cutter} and operation 1 with a {first.cutter}: a job cuts with one")
        if abs(op.tool - first.tool) > 1e-9:
            raise JobImportError(
                f"operation {index}'s {_mm(op.tool)} mm {_bit(op)} is not operation 1's {_mm(first.tool)} mm: a job cuts with one {_bit(first)}"
            )
    groups: list[Group] = []
    outline: list[list[tuple[float, float]]] = []
    kept: list[tuple[float, float, float]] = []
    notes: list[str] = []
    kept_ops: list[dict] = []
    names: list[str] = []
    for index, op in enumerate(op_list, 1):
        holes = op.holes
        if op.kind == HOLES and holes is None and holes_of is not None:
            holes = holes_of(op)
        part, part_notes = build(op, holes)
        groups.extend(part.groups)
        outline.extend(part.outline)
        kept.extend(part.holes)
        notes.extend(part_notes if len(op_list) == 1 else [f"{index}: {note}" for note in part_notes])
        names.append(part.name)
        data = op.model_dump()
        if op.kind == HOLES:
            data["holes"] = [list(hole) for hole in (holes or [])]
        kept_ops.append(data)
    made = (name or "").strip() or (names[0] if len(names) == 1 else f"{names[0]} and {len(names) - 1} more")
    job = Job(
        name=made,
        source="mill",
        spot=first.tool,
        groups=groups,
        outline=outline,
        holes=kept,
        recipe=Recipe(ops=kept_ops),
    )
    if streamer is not None:
        job.refresh_stats(streamer)
    return job, notes


def moved_as(made: Job, where: Job) -> Job:
    """A job made from operations typed in `where`'s frame turned and moved
    as `where` has been since it was made, so it lands where `where`'s
    operations do."""
    made.turn(where.rotation)
    made.shift(where.offset.x, where.offset.y)
    made.offset = where.offset.model_copy()
    made.rotation = where.rotation
    return made


def placed(made: Job, where: Job) -> Job:
    """A job made again from its operations put where `where` is: turned and
    moved as it has been since it was made, under its id."""
    moved_as(made, where)
    made.id = where.id
    return made


def unplaced(holes: list[tuple[float, float, float]], where: Job) -> list[tuple[float, float, float]]:
    """Holes where they are on the board (a board job's, as that job is
    now) in the frame `where`'s operations are typed in, from before it was
    turned and moved: placed() puts them back on the board's holes."""
    out = []
    for x, y, d in holes:
        bx, by = alignment.turn((x - where.offset.x, y - where.offset.y), -where.rotation)
        out.append((bx, by, d))
    return out


# The group settings no operation sets: the Jobs page's alone.
PAGE_SETTINGS = ("enabled", "min_power", "thickness", "focus")


def _group_count(op: MillOperation) -> int | None:
    """How many groups the operation makes: one a hole size it takes for
    holes, one for every other kind; None for holes it does not carry."""
    if op.kind != HOLES:
        return 1
    if op.holes is None:
        return None
    wanted = _wanted(op)
    return len({size for size in (size_of(d) for _, _, d in op.holes) if wanted is None or size in wanted})


def _by_operation(op_list: list[MillOperation], groups: list[Group]) -> list[list[Group]] | None:
    """The groups split by the operation that made them, in order; None
    when they do not add up, the groups having been changed apart from the
    operations since."""
    if len(op_list) == 1:
        return [list(groups)]
    counts: list[int] = []
    for op in op_list:
        count = _group_count(op)
        if count is None:
            return None
        counts.append(count)
    if sum(counts) != len(groups):
        return None
    split: list[list[Group]] = []
    at = 0
    for count in counts:
        split.append(groups[at : at + count])
        at += count
    return split


def _cutting(op: MillOperation) -> dict:
    """What decides what an operation cuts: all of it but its name and the
    holes filled in when it was made."""
    return op.model_dump(exclude={"name", "holes"})


def _paired(old_ops: list[MillOperation], new_ops: list[MillOperation]) -> list[tuple[int, int]]:
    """Each new operation's index with the index of the old one it takes
    the place of: an unchanged one with itself wherever it went (Add, Up,
    Remove), then the changed ones with the old ones left, in order
    (Apply)."""
    left = list(range(len(old_ops)))
    pairs: list[tuple[int, int]] = []
    changed: list[int] = []
    for index, op in enumerate(new_ops):
        same = next((at for at in left if _cutting(old_ops[at]) == _cutting(op)), None)
        if same is None:
            changed.append(index)
        else:
            left.remove(same)
            pairs.append((index, same))
    pairs.extend(zip(changed, left))
    return pairs


def _carry(old: list[Group], new: list[Group], base: Group | None) -> None:
    """Each old group's settings onto the new group of its label but for
    the numbers, in order, matched as carry_settings matches them. With
    `base`, the group the old operation's own numbers make, every setting
    the new numbers leave as they were; without, only the settings no
    operation sets."""
    by_stem: dict[str, list[Group]] = defaultdict(list)
    for group in old:
        by_stem[label_stem(group.label)].append(group)
    seen: dict[str, int] = defaultdict(int)
    for group in new:
        stem = label_stem(group.label)
        index = seen[stem]
        seen[stem] += 1
        if index >= len(by_stem[stem]):
            continue
        source = by_stem[stem][index]
        for name in SETTINGS if base is not None else PAGE_SETTINGS:
            if base is None or getattr(group, name) == getattr(base, name):
                setattr(group, name, getattr(source, name))


def carry_job_settings(old: Job, made: Job) -> None:
    """The settings of a Plot page job's groups onto the groups its
    operations were made into again (Apply, Add, Up, Remove), operation by
    operation: a group keeps every setting its operation's numbers do not
    change, the ones only the Jobs page sets (turned off, a focus, a least
    power) and the ones changed there (a slower feed), and takes the
    operation's where those numbers changed. The groups of an operation
    new to the job are as it makes them."""
    old_ops = [MillOperation.model_validate(data) for data in recipe_ops(old.recipe)]
    new_ops = [MillOperation.model_validate(data) for data in recipe_ops(made.recipe)]
    old_split = _by_operation(old_ops, old.groups)
    new_split = _by_operation(new_ops, made.groups)
    if old_split is None or new_split is None:
        # The job's groups were changed apart from its operations (paths
        # moved between groups): what no operation sets, by label alone.
        _carry(old.groups, made.groups, None)
        return
    for index, at in _paired(old_ops, new_ops):
        _carry(old_split[at], new_split[index], _group(old_ops[at], "", []))


def remake(job: Job, tool: float, streamer: Streamer) -> Job:
    """A Plot page job made again for a bit `tool` mm across, where it is
    now: turned and moved as the job was since it was made, its groups'
    settings kept."""
    op_list = [MillOperation.model_validate({**data, "tool": tool}) for data in recipe_ops(job.recipe)]
    if len(op_list) == 1 and op_list[0].kind == HOLES and op_list[0].holes is None:
        # A job made before operations kept their holes: the job's own,
        # which moved with it.
        made, _ = build(op_list[0], job.holes)
        made.id = job.id
        made.offset = job.offset.model_copy()
        made.rotation = job.rotation
    else:
        made, _ = build_job(op_list)
        placed(made, job)
    carry_settings(job.groups, made.groups)
    made.name = job.name
    made.refresh_stats(streamer)
    return made


# Operations whose jobs the page's in-page twin is checked against: one of
# every kind and shape, printed by `python -m spinny_web.mill`.
SAMPLES: list[dict] = [
    {"kind": "drill", "points": [[1, 2], [-3, 4.5]], "tool": 0.8, "depth": 1.6, "step_down": 0.5},
    {"kind": "line", "points": [[0, 0], [12, 0], [12, 5]], "closed": True, "tool": 1, "depth": 0.3, "step_down": 0.3},
    {"kind": "face", "x0": 10, "y0": -2, "x1": -5, "y1": 6, "tool": 3, "stepover": 0.7, "depth": 0.2, "step_down": 0.1},
    {"kind": "pocket", "x0": 0, "y0": 0, "x1": 14, "y1": 9, "tool": 2, "stepover": 0.45, "depth": 1, "step_down": 0.4},
    {"kind": "pocket", "x0": 0, "y0": 0, "x1": 8, "y1": 8, "tool": 2, "stepover": 0.5, "climb": False},
    {"kind": "pocket", "shape": "circle", "cx": 3, "cy": -1, "diameter": 9, "tool": 2, "stepover": 0.5},
    {"kind": "profile", "x0": -4, "y0": -3, "x1": 6, "y1": 2, "tool": 1.5, "side": "outside", "depth": 1.6, "step_down": 0.4},
    {"kind": "profile", "x0": -4, "y0": -3, "x1": 6, "y1": 2, "tool": 1.5, "side": "inside", "climb": False},
    {"kind": "profile", "shape": "circle", "cx": 0, "cy": 0, "diameter": 6, "tool": 1, "side": "on"},
    {"kind": "profile", "shape": "circle", "cx": 2, "cy": 2, "diameter": 6, "tool": 1, "side": "outside", "climb": False},
    {"kind": "holes", "job": "board", "tool": 0.8, "stepover": 0.5, "holes": [[0, 0, 0.8], [5, 1, 0.8], [2, 4, 3.0], [9, 9, 0.6], [1, 1, 0.8]]},
    {"kind": "holes", "job": "board", "tool": 0.8, "bore": False, "sizes": [3.0, 0.6], "holes": [[0, 0, 0.8], [2, 4, 3.0], [9, 9, 0.6]]},
    # Diameters on a half of the last decimal, as the page lists and sends them.
    {"kind": "holes", "job": "board", "tool": 0.8, "sizes": [0.8, 3.18, 0.31], "holes": [[0, 0, 0.8], [5, 5, 3.175], [9, 9, 0.305], [3, 7, 1.575]]},
    {"kind": "drill", "cutter": "laser", "points": [[1, 2], [-3, 4.5]], "tool": 0.1, "power": 300, "passes": 2},
    {"kind": "pocket", "cutter": "laser", "x0": 0, "y0": 0, "x1": 3, "y1": 2, "tool": 0.2, "stepover": 0.8, "power": 800, "speed": 600},
    {"kind": "profile", "cutter": "laser", "shape": "circle", "cx": 1, "cy": 1, "diameter": 5, "tool": 0.1, "side": "outside", "passes": 3},
    {"kind": "holes", "cutter": "laser", "job": "board", "tool": 0.1, "bore": False, "holes": [[0, 0, 0.8], [2, 4, 3.0], [9, 9, 0.12]]},
    {"kind": "holes", "cutter": "laser", "job": "board", "tool": 0.1, "stepover": 0.9, "holes": [[0, 0, 0.8], [9, 9, 0.12]]},
    {"kind": "pocket", "x0": 0, "y0": 0, "x1": 16, "y1": 9, "tool": 2, "stepover": 0.6, "corner": 2.5},
    {"kind": "profile", "x0": -4, "y0": -3, "x1": 6, "y1": 3, "tool": 1.5, "side": "outside", "corner": 2},
    {"kind": "profile", "x0": -4, "y0": -3, "x1": 6, "y1": 3, "tool": 1.5, "side": "inside", "corner": 2, "climb": False},
    {"kind": "profile", "x0": -4, "y0": -3, "x1": 6, "y1": 3, "tool": 1.5, "side": "on", "corner": 3},
    {"kind": "profile", "cutter": "laser", "x0": 0, "y0": 0, "x1": 5, "y1": 4, "tool": 0.1, "side": "inside", "corner": 1, "passes": 2},
]

# Jobs of several operations, checked the same way: one cutter and one
# bit, each operation's groups in order, the notes numbered.
JOB_SAMPLES: list[dict] = [
    {
        "name": None,
        "ops": [
            {"kind": "pocket", "x0": 0, "y0": 0, "x1": 10, "y1": 6, "tool": 1, "corner": 1.5, "depth": 1, "step_down": 0.5},
            {"kind": "drill", "points": [[12, 3], [14, 3]], "tool": 1, "depth": 2, "step_down": 1},
            {"kind": "holes", "job": "board", "tool": 1, "holes": [[20, 0, 1.0], [22, 1, 3.0]]},
        ],
    },
    {
        "name": "plate",
        "ops": [
            {"kind": "profile", "cutter": "laser", "shape": "circle", "cx": 0, "cy": 0, "diameter": 8, "tool": 0.2, "side": "inside", "passes": 2},
            {"kind": "profile", "cutter": "laser", "x0": -10, "y0": -10, "x1": 10, "y1": 10, "tool": 0.2, "corner": 3},
        ],
    },
]


def _rounded(value):
    if isinstance(value, float):
        return round(value, 6)
    if isinstance(value, (list, tuple)):
        return [_rounded(item) for item in value]
    return value


def _described(job: Job, notes: list[str]) -> dict:
    """A made job as the page's twin is checked against it, its numbers to the micron."""
    return {
        "name": job.name,
        "notes": notes,
        "spot": job.spot,
        "groups": [
            {
                "label": group.label,
                "passes": group.passes,
                "depth": group.depth,
                "tool": group.tool,
                "power": group.power,
                "paths": _rounded(group.paths),
            }
            for group in job.groups
        ],
        "outline": len(job.outline),
    }


def sample_jobs() -> list[dict]:
    """Every sample's job as the page sees it: the one operation samples
    with `op`, the several operation ones with `ops`."""
    out = []
    for sample in SAMPLES:
        fields = {key: value for key, value in sample.items() if key != "holes"}
        holes = [tuple(hole) for hole in sample.get("holes", [])] or None
        job, notes = build(MillOperation.model_validate(fields), holes)
        out.append({"op": fields, "holes": sample.get("holes"), **_described(job, notes)})
    for sample in JOB_SAMPLES:
        op_list = [MillOperation.model_validate(fields) for fields in sample["ops"]]
        job, notes = build_job(op_list, name=sample["name"])
        out.append({"ops": sample["ops"], "job_name": sample["name"], **_described(job, notes)})
    return out


if __name__ == "__main__":
    import json

    print(json.dumps(sample_jobs(), indent=1))
