"""Solder paste stencils: every paste opening cut out of a film round its
inside edge, so the piece inside drops out and leaves the hole.

A stencil is a film with a hole wherever a pad takes paste. The beam need
not burn all of an opening away: it runs once round it, half a spot inside
the edge, where the kerf's outer edge lies on the opening's edge, and the
hole comes out the size drawn.

- A margin shrinks every opening by that much on every side first, for
  less paste than the pad's whole area. An opening the margin closes is
  not cut, as KiCad plots no paste for a pad whose paste margin closes it;
  the stroke along its middle is kept apart, for cutting it anyway.
- An opening narrower than the spot leaves the beam no room inside it. It
  is cut along its middle: the long center line of the smallest rectangle
  round it, ended half a spot short of each end, so the hole is as long as
  the opening and as wide as the spot. A stroke is never shorter than a
  quarter spot, since a laser path that does not move the beam burns
  nothing.
- A part of an opening narrower than the spot beside a part the beam fits
  in, such as a neck between two wide ends, is left: the loop round the
  wide part frees what it reaches.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from laser_sweep import geom
from laser_sweep.geom import Polygons
from laser_sweep.isolate import as_loop

from . import clear
from .deposit import HAIRLINE, opening
from .polar import Point

Polyline = list[Point]

# The shortest stroke along an opening's middle, as a share of the spot.
SHORTEST = 0.25


@dataclass
class Stencil:
    """The cuts of a stencil, each list in cutting order, board mm."""

    # Round each opening's edge, half a spot inside it.
    loops: list[Polyline] = field(default_factory=list)
    # Along the middle of each opening narrower than the spot.
    narrow: list[Polyline] = field(default_factory=list)
    # Along the middle of each opening the margin closes: no part of the
    # stencil, there for cutting such an opening anyway.
    closed: list[Polyline] = field(default_factory=list)

    @property
    def paths(self) -> list[Polyline]:
        return self.loops + self.narrow


def stencil(paste: Polygons, spot: float, margin: float = 0.0, pace: float = clear.DEFAULT_PACE) -> Stencil:
    """The cuts that free every opening of `paste` shrunk by `margin` mm.

    `pace` is how many millimeters the rail runs while the table turns a
    degree, which the cuts are ordered by, as for a clearing.
    """
    if not spot > 0.0:
        raise ValueError("spot must be > 0")
    if not (math.isfinite(margin) and margin >= 0.0):
        raise ValueError("margin must be a number of mm, 0 or more")
    if not (pace > 0.0 and math.isfinite(pace)):
        raise ValueError("pace must be a finite number above 0")
    radius = spot / 2.0
    out = Stencil()
    loops: list[Polyline] = []
    for piece in geom.islands(paste) if paste else []:
        shrunk = geom.offset(piece, -margin) if margin > 0.0 else piece
        if not shrunk:
            out.closed.extend(middle(piece, radius))
            continue
        # Where the beam's middle runs, offset from the opening in one step
        # rather than from the shrunk one, so a rounded corner is drawn in
        # chords once; a strip of it narrower than a hairline is no room.
        core = opening(geom.offset(piece, -(margin + radius)), HAIRLINE / 2.0)
        loops.extend(as_loop(contour) for contour in core if len(contour) >= 3)
        # The margin may part an opening in two, and either part may be too
        # narrow for a loop of its own.
        for part in geom.islands(shrunk):
            if not any(geom.contains(part, contour[0]) for contour in core):
                out.narrow.extend(middle(part, radius))
    out.loops = clear.by_travel(loops, pace)
    out.narrow = clear.by_travel(out.narrow, pace)
    out.closed = clear.by_travel(out.closed, pace)
    return out


def middle(piece: Polygons, radius: float) -> list[Polyline]:
    """The stroke along the middle of an opening, its outline first and its
    holes after, as `geom.islands` gives one: the long center line of the
    smallest rectangle round it, `radius` short of each end and no shorter
    than SHORTEST of the spot, kept on the opening."""
    hull = _hull(piece[0]) if piece else []
    if not hull:
        return []
    (cx, cy), (ux, uy), half = _long_axis(hull)
    reach = max(half - radius, SHORTEST * radius)
    stroke = [(cx - ux * reach, cy - uy * reach), (cx + ux * reach, cy + uy * reach)]
    return clear.clip_open([stroke], piece)


def _hull(points: list[Point]) -> list[Point]:
    """The convex hull, counterclockwise, its first point not repeated."""
    ordered = sorted(set(points))
    if len(ordered) <= 2:
        return ordered

    def turn(o: Point, a: Point, b: Point) -> float:
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower: list[Point] = []
    for point in ordered:
        while len(lower) >= 2 and turn(lower[-2], lower[-1], point) <= 0.0:
            lower.pop()
        lower.append(point)
    upper: list[Point] = []
    for point in reversed(ordered):
        while len(upper) >= 2 and turn(upper[-2], upper[-1], point) <= 0.0:
            upper.pop()
        upper.append(point)
    return lower[:-1] + upper[:-1]


def _long_axis(hull: list[Point]) -> tuple[Point, Point, float]:
    """The middle of the smallest rectangle round a convex hull, the unit
    direction of its longer side and half that side's length.

    The smallest rectangle has a side along one of the hull's edges, so
    each edge's direction is tried.
    """
    if len(hull) == 1:
        return hull[0], (1.0, 0.0), 0.0
    best: tuple[float, float, float, float, float, float, float] | None = None
    for (x0, y0), (x1, y1) in zip(hull, hull[1:] + hull[:1]):
        length = math.hypot(x1 - x0, y1 - y0)
        if length == 0.0:
            continue
        ux, uy = (x1 - x0) / length, (y1 - y0) / length
        along = [x * ux + y * uy for x, y in hull]
        across = [y * ux - x * uy for x, y in hull]
        low, high, left, right = min(along), max(along), min(across), max(across)
        area = (high - low) * (right - left)
        if best is None or area < best[0]:
            best = (area, ux, uy, low, high, left, right)
    assert best is not None
    _, ux, uy, low, high, left, right = best
    a, c = (low + high) / 2.0, (left + right) / 2.0
    center = (a * ux - c * uy, a * uy + c * ux)
    if high - low >= right - left:
        return center, (ux, uy), (high - low) / 2.0
    return center, (-uy, ux), (right - left) / 2.0
