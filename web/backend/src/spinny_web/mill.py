"""The Mill page's operations: one simple cut described by its numbers and
made into a job of milled groups, and made again for another bit.

An operation is drilling points, drilling (or boring) a board job's holes,
a line through points, facing a rectangle, or a pocket or a profile of a
rectangle or a circle. The job it makes is cut on a spindle: every group
says so, and goes down in steps of `step_down` to `depth` under the
surface, the way every milled group does.
"""

from __future__ import annotations

import math
from collections import defaultdict
from typing import Literal

from pydantic import Field
from spinny_laser import mill as ops
from spinny_laser import pads as board_pads

from .jobs import (
    MAX_GROUP_PASSES,
    MAX_VALUE,
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


class MillOperation(Finite):
    """One operation as the page sends it. Which of the shape's fields
    count follows `kind` (and `shape`); the rest are ignored."""

    kind: Literal["drill", "holes", "line", "face", "pocket", "profile"]
    # The job's name; left out, one is made from the operation.
    name: str | None = None
    # The bit: its diameter, mm.
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
    # Climb milling (with the spindle turning clockwise), else conventional.
    climb: bool = True
    # A drill or a line: its points, board mm; a line may close.
    points: list[tuple[float, float]] = Field(default_factory=list)
    closed: bool = False
    # A pocket or a profile: of a rectangle or a circle.
    shape: Literal["rect", "circle"] = RECT
    # A rectangle (a face, or a pocket or profile of one) by two corners.
    x0: float = 0.0
    y0: float = 0.0
    x1: float = 0.0
    y1: float = 0.0
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

    def passes(self) -> int:
        return max(1, math.ceil(self.depth / self.step_down - 1e-9))

    def check(self) -> None:
        try:
            ops.check_tool(self.tool)
            check_depth(self.depth)
            if not (math.isfinite(self.step_down) and 0.0 < self.step_down):
                raise ValueError("the step down must be above 0 mm")
            if self.passes() > MAX_GROUP_PASSES:
                raise ValueError(f"{self.depth:g} mm in steps of {self.step_down:g} is over {MAX_GROUP_PASSES} passes")
            check_speed(self.speed, "the feed")
            check_speed(self.plunge, "the plunge")
            check_power(self.spindle, "the spindle speed")
        except ValueError as exc:
            raise JobImportError(str(exc)) from exc
        values = [self.x0, self.y0, self.x1, self.y1, self.cx, self.cy, self.diameter]
        values += [v for point in self.points for v in point]
        if not all(abs(v) <= MAX_VALUE for v in values):
            raise JobImportError(f"coordinates must be within {MAX_VALUE:g} mm")
        if len(self.points) > MAX_POINTS:
            raise JobImportError(f"at most {MAX_POINTS} points")


def _group(op: MillOperation, label: str, paths: list[list[tuple[float, float]]]) -> Group:
    return Group(
        label=label,
        power=op.spindle,
        speed=op.speed,
        passes=op.passes(),
        depth=op.depth,
        plunge=op.plunge,
        tool=SPINDLE,
        paths=paths,
    )


def _mm(value: float) -> str:
    return f"{value:g}"


def _rect_outline(op: MillOperation) -> list[list[tuple[float, float]]]:
    xa, ya, xb, yb = ops.box(op.x0, op.y0, op.x1, op.y1)
    return [[(xa, ya), (xb, ya), (xb, yb), (xa, yb), (xa, ya)]]


def _circle_outline(cx: float, cy: float, diameter: float) -> list[tuple[float, float]]:
    return ops.circle(cx, cy, diameter / 2.0, tolerance=max(0.01, diameter * 0.002))


def hole_groups(op: MillOperation, holes: list[tuple[float, float, float]]) -> tuple[list[Group], list[str]]:
    """A group a hole size, smallest first, each in a short tour on from
    where the last one ended: drilled, or bored out with the bit when it
    is wider than the bit and boring is asked for."""
    notes: list[str] = []
    wanted = None if op.sizes is None else {round(size, SIZE_DECIMALS) for size in op.sizes}
    by_size: dict[float, list[tuple[float, float]]] = defaultdict(list)
    for x, y, d in holes:
        size = round(d, SIZE_DECIMALS)
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
        if op.bore and size > op.tool + BORE_SLACK:
            paths = [ops.pocket_circle(x, y, size, op.tool, min(op.stepover, 1.0), op.climb)[0] for x, y in points]
            groups.append(_group(op, f"bore {size:.2f} mm holes ({count})", paths))
        else:
            if size < op.tool - BORE_SLACK:
                small += count
            groups.append(_group(op, f"drill {size:.2f} mm holes ({count})", ops.drill(points)))
    if small:
        notes.append(f"{small} holes are smaller than the {_mm(op.tool)} mm bit and come out its size")
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
            groups = [_group(op, f"drill {len(op.points)} points", ops.drill(op.points))]
            outline = [_circle_outline(x, y, op.tool) for x, y in op.points]
            name = f"drill {len(op.points)} points"
        elif op.kind == HOLES:
            if not holes:
                raise JobImportError("the job has no drill holes: import its board with the drill file")
            groups, notes = hole_groups(op, holes)
            wanted = None if op.sizes is None else {round(size, SIZE_DECIMALS) for size in op.sizes}
            kept_holes = [h for h in holes if wanted is None or round(h[2], SIZE_DECIMALS) in wanted]
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
                size = f"{_mm(op.diameter)} mm circle"
                outline = [_circle_outline(op.cx, op.cy, op.diameter)]
            else:
                if op.kind == POCKET:
                    paths = ops.pocket_rect(op.x0, op.y0, op.x1, op.y1, op.tool, op.stepover, op.climb)
                else:
                    paths = ops.profile_rect(op.x0, op.y0, op.x1, op.y1, op.tool, op.side, op.climb)
                size = f"{_mm(abs(op.x1 - op.x0))} x {_mm(abs(op.y1 - op.y0))} mm"
                outline = _rect_outline(op)
            what = "pocket" if op.kind == POCKET else f"profile {op.side}"
            groups = [_group(op, f"{what} {size}", paths)]
            name = f"{what} {size}"
            if op.kind == PROFILE and op.side != ops.INSIDE:
                notes.append("no tabs: a part cut free can move at the last pass, so hold it down or leave a skin")
        else:
            raise JobImportError(f"no operation {op.kind!r}")
    except ops.MillError as exc:
        raise JobImportError(str(exc)) from exc
    passes = op.passes()
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


def remake(job: Job, tool: float, streamer: Streamer) -> Job:
    """A Mill page job made again for a bit `tool` mm across, where it is
    now: turned and moved as the job was since it was made, its groups'
    settings kept."""
    assert job.recipe is not None and job.recipe.mill is not None
    op = MillOperation.model_validate({**job.recipe.mill, "tool": tool})
    if op.kind == HOLES:
        # The holes are kept in the job, and moved with it.
        made, _ = build(op, job.holes)
    else:
        made, _ = build(op)
        made.turn(job.rotation)
        made.shift(job.offset.x, job.offset.y)
    carry_settings(job.groups, made.groups)
    made.id = job.id
    made.name = job.name
    made.offset = job.offset.model_copy()
    made.rotation = job.rotation
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
]


def sample_jobs() -> list[dict]:
    """Every sample's job as the page sees it, its numbers to the micron."""

    def rounded(value):
        if isinstance(value, float):
            return round(value, 6)
        if isinstance(value, (list, tuple)):
            return [rounded(item) for item in value]
        return value

    out = []
    for sample in SAMPLES:
        fields = {key: value for key, value in sample.items() if key != "holes"}
        holes = [tuple(hole) for hole in sample.get("holes", [])] or None
        job, notes = build(MillOperation.model_validate(fields), holes)
        out.append(
            {
                "op": fields,
                "holes": sample.get("holes"),
                "name": job.name,
                "notes": notes,
                "spot": job.spot,
                "groups": [
                    {"label": group.label, "passes": group.passes, "depth": group.depth, "paths": rounded(group.paths)}
                    for group in job.groups
                ],
                "outline": len(job.outline),
            }
        )
    return out


if __name__ == "__main__":
    import json

    print(json.dumps(sample_jobs(), indent=1))
