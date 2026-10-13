"""The board's height map, from the probe, and the compensation a run takes from it.

A height is the focus axis position (H, mm, up positive) at which the probe
touched the board at one point of a rectangular grid in board coordinates.
Between points the surface is bilinear; outside the grid the nearest edge
holds. The focus height the beam wants at a board point is the height there
plus `focus_offset`: the distance from contact to focus, found once by
focusing by eye over a probed point and saying so ("focus here").

A run compensates one of two ways:

- `focus`: the focus axis follows the board. Every line carries the focus
  height at its end, and a cut is split so that no piece is longer than a
  quarter of the grid spacing, since the firmware moves H linearly along a
  line while the surface between probe points is not.
- `power`: the head stays at the height it has, and each piece of a cut is
  given more power where the board is out of focus. A Gaussian beam's spot
  grows with defocus `dz` as `sqrt(1 + (dz / zR)^2)`, `zR` its Rayleigh
  length, so the power is raised by that factor to hold the energy per
  unit of burnt area along the line, up to `s_max`. It is an
  approximation: a wider spot also cuts a wider line.

A spindle mills with `focus` only. There the offset is the touch-off: the
tool jogged down until it just touches the copper over a probed point,
and "focus here" said, so the map plus the offset is the height of the
surface under the tool, and a cut goes to that less its depth.
"""

from __future__ import annotations

import datetime
import json
import math
import os
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path

from pydantic import BaseModel, ConfigDict


# Points per side of the grid; a probe takes seconds per point, so a grid
# of 2500 is already most of an hour.
MIN_POINTS = 2
MAX_POINTS = 50
# More than this between the lowest and the highest point is a bad probe
# or a board that should be clamped flatter, not something to follow.
MAX_SPAN = 5.0
# How far past the grid a job may reach and still be compensated from its
# edge, mm.
COVER_MARGIN = 1.0
# The longest cut piece a compensated run sends, and the shortest it splits
# down to, mm.
MAX_STEP = 2.0
MIN_STEP = 0.25
# Largest coordinate accepted, as for jobs.
MAX_VALUE = 1.0e6
# Seconds a probe point spends beyond its moves: coming to rest, the probe's
# own answer, the lines' turnarounds.
PROBE_OVERHEAD = 1.5

FOCUS, POWER, OFF, AUTO = "focus", "power", "off", "auto"
MODES = (OFF, AUTO, FOCUS, POWER)


class Finite(BaseModel):
    """A model whose numbers are numbers: NaN and infinity are refused."""

    model_config = ConfigDict(allow_inf_nan=False)


class Grid(Finite):
    """Probe points `nx` by `ny`, evenly spaced, corners included.

    `mask[iy][ix]` says which of them are probed; None probes them all. A
    grid made around a job's cuts leaves out the points no cut comes near,
    which on a sparse board is most of them.
    """

    x0: float
    y0: float
    x1: float
    y1: float
    nx: int = 5
    ny: int = 5
    mask: list[list[bool]] | None = None

    def check(self) -> None:
        for value in (self.x0, self.y0, self.x1, self.y1):
            if abs(value) > MAX_VALUE:
                raise ValueError(f"grid corners must be within {MAX_VALUE:g} mm")
        if not (self.x1 > self.x0 and self.y1 > self.y0):
            raise ValueError("the grid needs x1 above x0 and y1 above y0")
        for count, name in ((self.nx, "nx"), (self.ny, "ny")):
            if not MIN_POINTS <= count <= MAX_POINTS:
                raise ValueError(f"{name} must be {MIN_POINTS} to {MAX_POINTS}")
        if self.mask is not None:
            if len(self.mask) != self.ny or any(len(row) != self.nx for row in self.mask):
                raise ValueError(f"the mask must be {self.ny} rows of {self.nx}")
            if self.points == 0:
                raise ValueError("the mask leaves no point to probe")

    def wanted(self, ix: int, iy: int) -> bool:
        return self.mask is None or bool(self.mask[iy][ix])

    @property
    def points(self) -> int:
        """How many points are probed."""
        if self.mask is None:
            return self.nx * self.ny
        return sum(1 for row in self.mask for flag in row if flag)

    @property
    def xs(self) -> list[float]:
        return [self.x0 + (self.x1 - self.x0) * i / (self.nx - 1) for i in range(self.nx)]

    @property
    def ys(self) -> list[float]:
        return [self.y0 + (self.y1 - self.y0) * j / (self.ny - 1) for j in range(self.ny)]

    @property
    def spacing(self) -> float:
        """The finer of the two point spacings, mm."""
        return min((self.x1 - self.x0) / (self.nx - 1), (self.y1 - self.y0) / (self.ny - 1))

    def order(self) -> list[tuple[int, int]]:
        """Every point probed as (ix, iy), row by row with every other row
        reversed, so the head never crosses the board between two points."""
        out = []
        for iy in range(self.ny):
            row = range(self.nx) if iy % 2 == 0 else range(self.nx - 1, -1, -1)
            out.extend((ix, iy) for ix in row if self.wanted(ix, iy))
        return out

    def cell_of(self, x: float, y: float) -> tuple[int, int, float, float]:
        """The cell a board point falls in, (i, j), and where in it, (t, s)
        in 0..1; a point outside the grid is taken at the nearest edge."""
        u = _clamp((x - self.x0) / (self.x1 - self.x0) * (self.nx - 1), 0.0, self.nx - 1)
        v = _clamp((y - self.y0) / (self.y1 - self.y0) * (self.ny - 1), 0.0, self.ny - 1)
        i = min(int(u), self.nx - 2)
        j = min(int(v), self.ny - 2)
        return i, j, u - i, v - j

    def with_mask_for(self, job, margin: float, spot: float = 0.0) -> "Grid":
        """This grid probing only what a job's cuts come near: the points
        at the corners of every cell a cut passes through, the cut taken
        `margin` plus half the `spot` wide, so the surface is known around
        each cut and nowhere else. A job with no cuts inside the grid gets
        the whole grid."""
        self.check()
        reach = max(0.0, float(margin)) + max(0.0, float(spot)) / 2.0
        dx = (self.x1 - self.x0) / (self.nx - 1)
        dy = (self.y1 - self.y0) / (self.ny - 1)
        cells = [[False] * (self.nx - 1) for _ in range(self.ny - 1)]
        step = min(dx, dy) / 2.0

        def mark_box(bx0: float, by0: float, bx1: float, by1: float) -> None:
            i0 = max(0, min(self.nx - 2, math.floor((bx0 - self.x0) / dx)))
            i1 = max(0, min(self.nx - 2, math.floor((bx1 - self.x0) / dx)))
            j0 = max(0, min(self.ny - 2, math.floor((by0 - self.y0) / dy)))
            j1 = max(0, min(self.ny - 2, math.floor((by1 - self.y0) / dy)))
            if bx1 < self.x0 or bx0 > self.x1 or by1 < self.y0 or by0 > self.y1:
                return
            for j in range(j0, j1 + 1):
                for i in range(i0, i1 + 1):
                    cells[j][i] = True

        def mark_segment(p: tuple[float, float], q: tuple[float, float]) -> None:
            # A long segment is marked in pieces, so a diagonal does not
            # take the whole box it spans.
            length = math.dist(p, q)
            parts = max(1, math.ceil(length / step)) if length > 0 else 1
            for k in range(parts):
                a = (p[0] + (q[0] - p[0]) * k / parts, p[1] + (q[1] - p[1]) * k / parts)
                b = (p[0] + (q[0] - p[0]) * (k + 1) / parts, p[1] + (q[1] - p[1]) * (k + 1) / parts)
                mark_box(min(a[0], b[0]) - reach, min(a[1], b[1]) - reach, max(a[0], b[0]) + reach, max(a[1], b[1]) + reach)

        any_cut = False
        for group in job.groups:
            if not group.enabled:
                continue
            for path in group.paths:
                points = [(float(x), float(y)) for x, y in path]
                if not points:
                    continue
                any_cut = True
                if len(points) == 1:
                    mark_segment(points[0], points[0])
                for a, b in zip(points, points[1:]):
                    mark_segment(a, b)
            for poly in group.joints:
                points = joint_moves_points(poly)
                if not points:
                    continue
                any_cut = True
                for a, b in zip(points, points[1:]):
                    mark_segment(a, b)
                if len(points) == 1:
                    mark_segment(points[0], points[0])
        if not any_cut:
            return self.model_copy(update={"mask": None})
        mask = [[False] * self.nx for _ in range(self.ny)]
        for j, row in enumerate(cells):
            for i, flag in enumerate(row):
                if flag:
                    mask[j][i] = mask[j][i + 1] = mask[j + 1][i] = mask[j + 1][i + 1] = True
        if not any(flag for row in mask for flag in row):
            return self.model_copy(update={"mask": None})
        return self.model_copy(update={"mask": mask})

    def estimate_seconds(self, settings, rates, cartesian: bool = True) -> float:
        """About how long probing takes: for each point the move from the
        last, a touch down over half the probe depth (the board is somewhere
        under the travel height, and the depth allows for not knowing
        where), the slow second touch, the rise back and the answers in
        between. A guess before the first point; the progress's own pace
        takes over once some are done."""
        order = self.order()
        if not order:
            return 0.0
        h_rate = float(getattr(rates, "h_rate", 600.0)) or 600.0
        travel_rate = float(getattr(rates, "r_rate", 560.0)) or 560.0
        feed = min(float(settings.feed), h_rate)
        descent = float(settings.depth) / 2.0
        per_point = descent / feed * 60.0 + descent / h_rate * 60.0 + PROBE_OVERHEAD
        if settings.slow > 0.0:
            slow = min(float(settings.slow), h_rate)
            per_point += settings.backoff / h_rate * 60.0 + 2.0 * settings.backoff / slow * 60.0 + PROBE_OVERHEAD
        seconds = per_point * len(order)
        xs, ys = self.xs, self.ys
        for (ix0, iy0), (ix1, iy1) in zip(order, order[1:]):
            distance = math.dist((xs[ix0], ys[iy0]), (xs[ix1], ys[iy1]))
            seconds += distance / travel_rate * 60.0
        return seconds

    def covers(self, box: tuple[float, float, float, float], margin: float = COVER_MARGIN) -> bool:
        x0, y0, x1, y1 = box
        return (
            x0 >= self.x0 - margin
            and y0 >= self.y0 - margin
            and x1 <= self.x1 + margin
            and y1 <= self.y1 + margin
        )


class HeightMap(Finite):
    grid: Grid
    # heights[iy][ix]: H at contact, mm; None where not yet probed.
    heights: list[list[float | None]]
    # Focus height minus contact height, mm, and whether anyone has said
    # what it is: until then a run would put the head at contact height.
    focus_offset: float = 0.0
    focus_set: bool = False
    # Someone has set the offset at some point, in some frame: a frame
    # change takes `focus_set` back but leaves this, so a probe at one
    # point can tie the map to the new frame by the shift it finds.
    focus_known: bool = False
    # Where the probe tip sat from the beam when the map was probed, along
    # the rail and across it, mm; kept to say how it was made.
    probe_offset: tuple[float, float] = (0.0, 0.0)
    # When probing started, ISO 8601.
    created: str = ""

    @classmethod
    def empty(cls, grid: Grid, probe_offset: tuple[float, float] = (0.0, 0.0)) -> "HeightMap":
        grid.check()
        return cls(
            grid=grid,
            heights=[[None] * grid.nx for _ in range(grid.ny)],
            probe_offset=probe_offset,
            created=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        )

    def check(self) -> None:
        self.grid.check()
        if len(self.heights) != self.grid.ny or any(len(row) != self.grid.nx for row in self.heights):
            raise ValueError(f"heights must be {self.grid.ny} rows of {self.grid.nx}")
        for row in self.heights:
            for value in row:
                if value is not None and abs(value) > MAX_VALUE:
                    raise ValueError(f"heights must be within {MAX_VALUE:g} mm")
        if abs(self.focus_offset) > MAX_VALUE:
            raise ValueError(f"focus_offset must be within {MAX_VALUE:g} mm")

    @property
    def probed(self) -> int:
        return sum(value is not None for row in self.heights for value in row)

    @property
    def wanted(self) -> int:
        """How many points the map is to have."""
        return self.grid.points

    @property
    def complete(self) -> bool:
        grid = self.grid
        return all(
            self.heights[iy][ix] is not None for iy in range(grid.ny) for ix in range(grid.nx) if grid.wanted(ix, iy)
        )

    def remaining(self) -> list[tuple[int, int]]:
        """The points still to probe, in probing order."""
        return [(ix, iy) for ix, iy in self.grid.order() if self.heights[iy][ix] is None]

    def span(self) -> tuple[float, float] | None:
        """Lowest and highest height probed."""
        values = [value for row in self.heights for value in row if value is not None]
        if not values:
            return None
        return min(values), max(values)

    def height_at(self, x: float, y: float) -> float:
        """The board's height at a board point: bilinear inside the grid,
        the nearest edge outside it. In a cell with a corner never probed
        (left out of the mask) the nearest probed corner stands in, and
        with none the nearest probed point of the map; a run is only let
        follow the map where its cuts have probed cells, so that is for a
        stray point, not a cut."""
        grid = self.grid
        i, j, t, s = grid.cell_of(x, y)
        h = self.heights
        h00, h10, h01, h11 = h[j][i], h[j][i + 1], h[j + 1][i], h[j + 1][i + 1]
        if h00 is not None and h10 is not None and h01 is not None and h11 is not None:
            return (1 - t) * (1 - s) * h00 + t * (1 - s) * h10 + (1 - t) * s * h01 + t * s * h11
        # A corner that is to be probed and is not yet is a map still being
        # made, not one with a hole left on purpose.
        for value, ix, iy in ((h00, i, j), (h10, i + 1, j), (h01, i, j + 1), (h11, i + 1, j + 1)):
            if value is None and grid.wanted(ix, iy):
                raise ValueError("the height map is not complete")
        corners = [
            (value, (di - t) ** 2 + (dj - s) ** 2)
            for value, di, dj in ((h00, 0, 0), (h10, 1, 0), (h01, 0, 1), (h11, 1, 1))
            if value is not None
        ]
        if corners:
            return min(corners, key=lambda pair: pair[1])[0]
        xs, ys = grid.xs, grid.ys
        nearest = None
        for iy in range(grid.ny):
            for ix in range(grid.nx):
                value = h[iy][ix]
                if value is None:
                    continue
                distance = (xs[ix] - x) ** 2 + (ys[iy] - y) ** 2
                if nearest is None or distance < nearest[1]:
                    nearest = (value, distance)
        if nearest is None:
            raise ValueError("the height map has no probed point")
        return nearest[0]

    def cell_probed(self, x: float, y: float, margin: float = COVER_MARGIN) -> bool:
        """Whether the board point lies in a cell with all four corners
        probed, allowing `margin` past the grid's edge."""
        grid = self.grid
        if not grid.covers((x, y, x, y), margin):
            return False
        i, j, _, _ = grid.cell_of(x, y)
        h = self.heights
        return all(value is not None for value in (h[j][i], h[j][i + 1], h[j + 1][i], h[j + 1][i + 1]))

    def focus_at(self, x: float, y: float) -> float:
        return self.height_at(x, y) + self.focus_offset

    def usable(self) -> None:
        """Refuses a map a run should not follow."""
        if not self.complete:
            raise ValueError(f"the height map is not complete: {self.probed} of {self.wanted} points probed")
        if not self.focus_set:
            raise ValueError(
                "the focus offset is not set: focus the beam by eye over the probed area and use focus here"
            )
        low, high = self.span() or (0.0, 0.0)
        if high - low > MAX_SPAN:
            raise ValueError(
                f"the height map spans {high - low:.3f} mm, more than {MAX_SPAN:g} mm: probe again or flatten the board"
            )


def _clamp(value: float, low: float, high: float) -> float:
    return low if value < low else high if value > high else value


@dataclass
class Compensation:
    """How a run follows the board: the map, the mode, and for `power` the
    height the head keeps, the beam's Rayleigh length and the power cap."""

    heightmap: HeightMap
    mode: str
    head_h: float = 0.0
    rayleigh: float = 0.5
    s_max: float = 1000.0

    @property
    def step(self) -> float:
        """Longest cut piece on the board, mm."""
        return _clamp(self.heightmap.grid.spacing / 4.0, MIN_STEP, MAX_STEP)

    def focus(self, point: tuple[float, float]) -> float:
        return self.heightmap.focus_at(point[0], point[1])

    def highest(self) -> float:
        """The highest focus height over the map: for a spindle, the top of
        the surface the tool travels clear of."""
        _, high = self.heightmap.span() or (0.0, 0.0)
        return high + self.heightmap.focus_offset

    def factor(self, point: tuple[float, float]) -> float:
        """How much wider the spot is at a board point than at focus."""
        defocus = self.head_h - self.focus(point)
        return math.sqrt(1.0 + (defocus / self.rayleigh) ** 2)

    def scaled(self, power: float, floor: float | None, point: tuple[float, float]) -> tuple[float, float | None]:
        """S and M raised for the defocus at a board point, capped at s_max."""
        factor = self.factor(point)
        scaled = min(power * factor, self.s_max)
        if floor is None:
            return scaled, None
        return scaled, min(floor * factor, scaled)


# Degrees of table turn between the points a joint move's box is taken
# from: the arc between two of them bows out by r * (1 - cos 1 deg), under
# 8 um at 50 mm from the axis.
EXTENT_STEP_DEG = 2.0


def joint_moves_box(polys) -> tuple[float, float, float, float] | None:
    """The board box joint polylines sweep: each move is straight in radius
    and angle, an arc or a spiral on the board, and a full turn at one
    radius starts and ends at the same point. The work is bounded per move,
    whatever the moves span, and nothing is kept but the box."""
    box = None

    def take(r: float, a: float) -> None:
        nonlocal box
        x, y = r * math.cos(math.radians(a)), r * math.sin(math.radians(a))
        box = (x, y, x, y) if box is None else (min(box[0], x), min(box[1], y), max(box[2], x), max(box[3], y))

    for poly in polys:
        for r, a in poly:
            take(float(r), float(a))
        for (r0, a0), (r1, a1) in zip(poly, poly[1:]):
            r0, a0, r1, a1 = float(r0), float(a0), float(r1), float(a1)
            if abs(a1 - a0) >= 360.0:
                # A turn or more passes every angle: the circle of its
                # larger radius holds it.
                reach = max(abs(r0), abs(r1))
                take(reach, 0.0)
                take(reach, 90.0)
                take(reach, 180.0)
                take(reach, 270.0)
                continue
            steps = max(1, math.ceil(abs(a1 - a0) / EXTENT_STEP_DEG))
            for i in range(1, steps):
                t = i / steps
                take(r0 + (r1 - r0) * t, a0 + (a1 - a0) * t)
    return box


def job_extent(job) -> tuple[float, float, float, float] | None:
    """The board box the enabled groups of a job cut inside, joint-space
    groups included, those by their moves rather than their ends."""
    boxes = []
    for group in job.groups:
        if not group.enabled:
            continue
        if group.joints:
            boxes.append(joint_moves_box(group.joints))
        else:
            points = [(float(x), float(y)) for path in group.paths for x, y in path]
            if points:
                xs = [p[0] for p in points]
                ys = [p[1] for p in points]
                boxes.append((min(xs), min(ys), max(xs), max(ys)))
    boxes = [box for box in boxes if box is not None]
    if not boxes:
        return None
    return (
        min(box[0] for box in boxes),
        min(box[1] for box in boxes),
        max(box[2] for box in boxes),
        max(box[3] for box in boxes),
    )


def joint_moves_points(poly) -> list[tuple[float, float]]:
    """Board points along a joint polyline's moves, each move an arc or a
    spiral sampled every couple of degrees of table turn, so what the
    moves sweep is seen and not only their ends."""
    out: list[tuple[float, float]] = []

    def take(r: float, a: float) -> None:
        out.append((r * math.cos(math.radians(a)), r * math.sin(math.radians(a))))

    joints = [(float(r), float(a)) for r, a in poly]
    if not joints:
        return out
    take(*joints[0])
    for (r0, a0), (r1, a1) in zip(joints, joints[1:]):
        steps = max(1, min(720, math.ceil(abs(a1 - a0) / EXTENT_STEP_DEG)))
        for i in range(1, steps + 1):
            t = i / steps
            take(r0 + (r1 - r0) * t, a0 + (a1 - a0) * t)
    return out


def check_covers(heightmap: HeightMap, job) -> None:
    """Refuses a job that reaches past the probed area: the edge value
    would stand in for a board nobody measured. With a map probed around
    another job's cuts, every cut of this one must lie in probed cells."""
    box = job_extent(job)
    if box is None:
        return
    grid = heightmap.grid
    if not grid.covers(box):
        raise ValueError(
            "the height map does not cover the job: probed X {:.1f}..{:.1f} Y {:.1f}..{:.1f}, "
            "the job reaches X {:.1f}..{:.1f} Y {:.1f}..{:.1f}".format(
                grid.x0, grid.x1, grid.y0, grid.y1, box[0], box[2], box[1], box[3]
            )
        )
    if grid.mask is None and heightmap.complete:
        return
    # Along every cut, at half a cell: a segment that crosses a cell nobody
    # probed would be cut to a guessed height.
    step = max(min((grid.x1 - grid.x0) / (grid.nx - 1), (grid.y1 - grid.y0) / (grid.ny - 1)) / 2.0, 1e-3)
    for group in job.groups:
        if not group.enabled:
            continue
        polylines = [[(float(x), float(y)) for x, y in path] for path in group.paths]
        polylines.extend(joint_moves_points(poly) for poly in group.joints)
        for points in polylines:
            if not points:
                continue
            samples = [points[0]]
            for a, b in zip(points, points[1:]):
                parts = max(1, math.ceil(math.dist(a, b) / step))
                samples.extend((a[0] + (b[0] - a[0]) * k / parts, a[1] + (b[1] - a[1]) * k / parts) for k in range(1, parts + 1))
            for x, y in samples:
                if not heightmap.cell_probed(x, y):
                    raise ValueError(
                        f"the height map was not probed under {group.label} at X {x:.1f} Y {y:.1f}:"
                        " probe again around this job's cuts"
                    )


class HeightMapStore:
    """The one height map, kept in a file so it outlives the process."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.Lock()
        self.heightmap: HeightMap | None = self._read()

    def _read(self) -> HeightMap | None:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            heightmap = HeightMap.model_validate(data)
            heightmap.check()
            return heightmap
        except (OSError, ValueError):
            return None

    def get(self) -> HeightMap | None:
        with self._lock:
            return self.heightmap.model_copy(deep=True) if self.heightmap is not None else None

    def put(self, heightmap: HeightMap | None) -> None:
        """Replaces the map (None clears it) and writes it through."""
        if heightmap is not None:
            heightmap.check()
        with self._lock:
            self.heightmap = heightmap.model_copy(deep=True) if heightmap is not None else None
            if heightmap is None:
                try:
                    self.path.unlink()
                except FileNotFoundError:
                    pass
                return
            _write_atomic(self.path, heightmap.model_dump_json(indent=2))


def _write_atomic(path: Path, text: str) -> None:
    """A file that is either the old one or the whole new one."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix=path.name, dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text + "\n")
        os.replace(temp, path)
    except BaseException:
        try:
            os.unlink(temp)
        except OSError:
            pass
        raise
