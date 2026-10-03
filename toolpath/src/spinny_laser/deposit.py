"""Copper deposition: burn the copper itself and leave the bare board alone.

Isolation burns around the copper, and clearing burns away whatever lies
between. An additive process, where the beam lays copper down rather than
taking it away, needs the opposite: every bit of the layer's copper burnt
and nothing past its edge.

- Edge loops follow each outline from the inside. The first runs half a
  spot in, so the beam's edge stops on the copper's edge and a trace keeps
  its drawn width; each further loop steps in by the pitch.
- The fill burns what the loops leave. `contour` goes on with loops until
  nothing is left, which runs along a trace and rings a pad in to its
  middle; radial, rings and lines are the clearing fills, clipped to the
  copper.
- Copper narrower than the spot cannot hold the beam inside it. A trace
  that narrow is burnt along the line the gerber draws it with, its
  middle, and comes out as wide as the spot.

Loops a pitch apart leave copper unburnt where they turn a corner, and
along the middle of a feature whose width is not a whole number of
pitches. What the loops burn is worked out, and wherever copper is left,
the beam runs along the line half a spot inside the deepest loop there,
which reaches it.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from laser_sweep import geom
from laser_sweep.geom import Polygons
from laser_sweep.gerber import CURVE_TOLERANCE, Draw, Image
from laser_sweep.isolate import as_loop

from . import clear
from .polar import Point

Polyline = list[Point]

CONTOUR = "contour"
FILLS = (CONTOUR, *clear.PATTERNS)

# A rounded offset is drawn in chords that fall inside its arcs, by up to
# 2.25 times the curve tolerance where Clipper gives a corner one chord for
# one and a half, so two offsets that should meet leave a hairline between
# them. Copper left in a strip this narrow is not left.
HAIRLINE = 3.0 * CURVE_TOLERANCE
# Any join but a round one is a miter to the offset.
MITER = "miter"


@dataclass
class Deposition:
    """The paths that burn a layer's copper, each list in cutting order,
    board mm."""

    # How far inside the copper's edge each set of edge loops runs.
    offsets: list[float] = field(default_factory=list)
    edges: list[list[Polyline]] = field(default_factory=list)
    fill: list[Polyline] = field(default_factory=list)
    # Along the middle of copper narrower than the spot.
    thin: list[Polyline] = field(default_factory=list)

    @property
    def paths(self) -> list[Polyline]:
        return [path for loops in self.edges for path in loops] + self.fill + self.thin


def centerlines(image: Image) -> list[Polyline]:
    """The line every stroke of the layer is drawn along: a trace's middle."""
    return [
        list(figure.points)
        for figure in image.figures
        if isinstance(figure, Draw) and figure.dark and len(figure.points) >= 2
    ]


def deposit(
    copper: Polygons,
    spot: float,
    fill: str = CONTOUR,
    passes: int = 1,
    centers: list[Polyline] | None = None,
    pitch: float | None = None,
    tolerance: float = 0.005,
    pace: float = clear.DEFAULT_PACE,
) -> Deposition:
    """The edge loops, the fill and the narrow traces of `copper`.

    `passes` is how many sets of edge loops come before the fill, each a
    group of its own. `centers` are the lines the layer's strokes are drawn
    along, from `centerlines`, which the copper too narrow for the beam is
    burnt along. `pitch` is the largest spacing between loops or fill
    strokes, the spot when not given. `tolerance` is the chord tolerance
    the rings fill is streamed at, and `pace` how many millimeters the
    rail runs while the table turns a degree, which the paths are ordered
    by, as for a clearing.
    """
    if fill not in FILLS:
        raise ValueError(f"deposition fill must be one of {', '.join(FILLS)}")
    if not spot > 0.0:
        raise ValueError("spot must be > 0")
    if passes < 1:
        raise ValueError("passes must be at least 1")
    pitch = spot if pitch is None else pitch
    if not 0.0 < pitch <= spot:
        raise ValueError("pitch must be above 0 and at most the spot")
    if not tolerance > 0.0:
        raise ValueError("tolerance must be > 0")
    if not (pace > 0.0 and math.isfinite(pace)):
        raise ValueError("pace must be a finite number above 0")
    solid = geom.union(copper) if copper else []
    if not solid:
        return Deposition()

    radius = spot / 2.0
    # Where a beam center may go, a hairline that the beam cannot follow
    # left out.
    core = opening(geom.offset(solid, -radius), HAIRLINE / 2.0)
    # Each level is offset from the copper itself: offsetting the one before
    # would draw every rounded corner in the chords of the last, and the
    # points would multiply level by level.
    levels: list[Polygons] = []
    level = core
    while level and (fill == CONTOUR or len(levels) < passes):
        levels.append(level)
        level = geom.offset(solid, -(radius + len(levels) * pitch))
    loops = [[as_loop(contour) for contour in level if len(contour) >= 3] for level in levels]

    out = Deposition()
    for index, edge in enumerate(loops[:passes]):
        out.offsets.append(radius + index * pitch)
        out.edges.append(clear.by_travel(edge, pace))
    # The loop round a level burns to half a spot inside it, and the loop
    # round the next level from half a spot outside that one: copper
    # between the two is left, and inside the last level, all of it. The
    # next loop's reach is taken a third of a hairline short: where the two
    # meet, along every edge at a pitch of one spot, a difference of edges
    # that coincide comes apart into slivers and slows Clipper down by
    # orders of magnitude, while a band that narrow along them goes with
    # the hairlines, and a gap at a corner stays.
    inner = [geom.offset(solid, -(spot + index * pitch)) for index in range(len(levels))]
    left: Polygons = []
    for index, deep in enumerate(inner):
        if index + 1 < len(levels):
            deep = geom.difference(deep, geom.offset(levels[index + 1], radius - HAIRLINE / 3.0))
        left.extend(deep)
    left = opening(left, HAIRLINE / 2.0)
    if fill == CONTOUR:
        strokes = [loop for level in loops[passes:] for loop in level]
        if left:
            lines = [closed(contour) for deep in inner for contour in deep]
            strokes += clear.clip_open(lines, geom.offset(left, radius))
        out.fill = clear.by_travel(strokes, pace)
    elif left:
        # A beam center within half a spot of copper left over is one that
        # burns some of it, and one the loops have not already been along.
        area = geom.intersection(core, geom.offset(left, radius))
        if fill == clear.RADIAL:
            out.fill = clear.spokes(area, pitch, pace)
        elif fill == clear.RINGS:
            out.fill = clear.rings(area, pitch, tolerance)
        else:
            out.fill = clear.rows(area, pitch)

    if centers:
        # The copper the beam reaches from the core, and what it does not.
        reach = geom.offset(core, radius)
        narrow = opening(geom.difference(solid, reach), HAIRLINE / 2.0)
        if narrow:
            # On into the copper the loops reach by half a spot, so the
            # beam's end meets their band wherever its edge curves away,
            # as round a pad or a bend; never off the copper.
            along = geom.intersection(solid, geom.offset(narrow, radius))
            out.thin = clear.by_travel(clear.clip_open(centers, along), pace)
    return out


def opening(paths: Polygons, radius: float) -> Polygons:
    """The polygons less every part narrower than twice `radius`.

    Mitered rather than rounded, so what is wide enough comes back on its
    own edges: a rounded join is drawn in chords that would move them by as
    much again as the chords of the offset that made them.
    """
    if not paths:
        return []
    return geom.offset(geom.offset(paths, -radius, MITER), radius, MITER)


def closed(contour) -> Polyline:
    """A contour as a polyline that ends where it starts."""
    return list(contour) + [contour[0]]
