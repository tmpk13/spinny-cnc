"""Copper clearing: burn away every bit of copper that the isolation leaves
standing inside the board's perimeter, so only the traces and pads remain.

The perimeter is the board outline when it has one, and otherwise the
rectangle the isolation spans in X and Y. An outline drawn as separate
lines and arcs comes as one stroke per piece, so the pieces are joined end
to end first; an outline that still does not close, or that closes around
less than half the copper, as a lone cutout does, counts as none. A beam
center stays at least as far from the copper as the outermost isolation
loop runs, so a clearing stroke never reaches copper that stays, and its
ragged ends land in the trench that loop cuts. One more pass runs along
the inside of the perimeter, since strokes that meet the edge at a slant
leave slivers between them there.

Three fills, each a family of strokes at most one pitch apart:

- radial: spokes out from the axis. The table stands still while the head
  runs along the rail, and near the axis that is the fast direction of
  this machine, where the table's rate caps the surface speed of anything
  that turns it. Any straight stroke that misses the axis turns the table
  through the angle it spans, most of it where it passes closest, so a
  row near the axis crawls however it is laid. Spokes spread apart going
  out, so one only starts where its neighbours have drifted a whole pitch
  apart, and the spacing stays between half the pitch and the pitch.
  Spokes are packed only as tightly as the area's reach in each direction
  needs, and cut in whichever order and direction the head reaches soonest.
- rings: arcs about the axis. The head stands still while the table turns:
  smooth, and the rail never reverses, but slow where the table's rate
  binds.
- lines: rows along X, the usual raster.

Spokes and rings are laid about the axis as the job is placed. A job moved
afterwards still clears the same area, only no longer along the machine's
own axes.
"""

from __future__ import annotations

import bisect
import math

import pyclipper
from laser_sweep import geom
from laser_sweep.geom import SCALE, Polygons

from .polar import Point

RADIAL, RINGS, LINES = "radial", "rings", "lines"
PATTERNS = (RADIAL, RINGS, LINES)

Polyline = list[Point]

# Outline pieces whose ends are this close join into one path, and a path
# whose ends are this close is closed. A board edge drawn as lines and arcs
# is plotted one stroke per piece, and an interpolated arc may end a hair
# away from where the next piece starts.
JOIN_EPSILON = 1e-3
# The share of the copper's area a closed outline has to hold to be taken
# for the board, rather than for a cutout or a piece of waste.
HOLD_SHARE = 0.5
# A clipped piece shorter than this, where a stroke grazes a corner, would
# go out as no move at all: it is under the radius word's quantum.
MIN_STROKE = 0.001
# Spokes are halved inwards until the innermost set reaches no further than
# this many pitches from the axis; that set runs all the way in.
CORE_PITCHES = 4.0
# No two spokes are further apart than this, in radians, however little of
# the area lies between them.
WIDEST_GAP = math.pi / 4.0
# Rail millimeters the head runs in the time the table turns one degree,
# each at its max rate: the firmware's defaults, 560 mm/min and 400 deg/min.
DEFAULT_PACE = 560.0 / 400.0


def clear(
    copper: Polygons,
    keep: float,
    spot: float,
    pattern: str,
    outline: list[Polyline] | None = None,
    pitch: float | None = None,
    tolerance: float = 0.005,
    pace: float = DEFAULT_PACE,
) -> list[Polyline]:
    """Clearing strokes in cutting order, board mm about the axis.

    `keep` is the distance from the copper edge to the outermost isolation
    loop, which no beam center of the clearing comes closer than. `pitch`
    is the largest spacing between strokes, the spot when not given.
    `tolerance` is the chord tolerance the paths are streamed at: a ring
    is drawn with chords that stay within half of it, so each chord goes
    out as one move at a constant radius. `pace` is how many millimeters
    the rail runs while the table turns a degree, both at their max rates,
    which is what the spokes are ordered by.
    """
    if pattern not in PATTERNS:
        raise ValueError(f"clearing pattern must be one of {', '.join(PATTERNS)}")
    if not spot > 0.0:
        raise ValueError("spot must be > 0")
    if not keep >= 0.0:
        raise ValueError("keep must be >= 0")
    pitch = spot if pitch is None else pitch
    if not 0.0 < pitch <= spot:
        raise ValueError("pitch must be above 0 and at most the spot")
    if not tolerance > 0.0:
        raise ValueError("tolerance must be > 0")
    if not (pace > 0.0 and math.isfinite(pace)):
        raise ValueError("pace must be a finite number above 0")
    if not copper:
        return []

    kept = geom.offset(copper, keep) if keep > 0.0 else geom.union(copper)
    frame = perimeter(copper, keep, spot, outline)
    area = geom.difference(frame, kept)
    if not area:
        return []
    if pattern == RADIAL:
        strokes = spokes(area, pitch, pace)
    elif pattern == RINGS:
        strokes = rings(area, pitch, tolerance)
    else:
        strokes = rows(area, pitch)
    return strokes + edge(frame, kept, strokes[-1][-1] if strokes else (0.0, 0.0))


def perimeter(copper: Polygons, keep: float, spot: float, outline: list[Polyline] | None) -> Polygons:
    """Where a beam center may go: half a spot inside the board's edge.

    Without a closed outline, or with one that holds less than half the
    copper, it is the rectangle the isolation spans, less half a spot,
    which is the copper's box grown by `keep`.
    """
    closed = [path[:-1] for path in chains(outline or []) if _closed(path)]
    if closed:
        board = _even_odd(closed)
        if board and _holds(board, copper):
            return geom.offset(board, -spot / 2.0)
    x0, y0, x1, y1 = geom.bounds(copper)
    x0, y0, x1, y1 = x0 - keep, y0 - keep, x1 + keep, y1 + keep
    return [[(x0, y0), (x1, y0), (x1, y1), (x0, y1)]]


def chains(paths: list[Polyline], epsilon: float = JOIN_EPSILON) -> list[Polyline]:
    """The paths joined end to end where their ends meet, reversed as needed.

    A path that closes on its own stays a path of its own. A closed path
    or chain ends on its first point exactly. Where more than two ends
    meet, a chain goes on along the first unused piece found there.
    """
    out: list[Polyline] = []
    pieces: list[Polyline] = []
    for path in paths:
        if len(path) < 2:
            continue
        if _closed(path, epsilon):
            out.append(_shut(list(path)))
        else:
            pieces.append(list(path))

    def cell(point: Point) -> tuple[int, int]:
        return (math.floor(point[0] / epsilon), math.floor(point[1] / epsilon))

    ends: dict[tuple[int, int], list[tuple[int, bool]]] = {}
    for index, piece in enumerate(pieces):
        ends.setdefault(cell(piece[0]), []).append((index, False))
        ends.setdefault(cell(piece[-1]), []).append((index, True))
    used = [False] * len(pieces)

    def take(point: Point) -> Polyline | None:
        """An unused piece with an end at the point, running away from it."""
        cx, cy = cell(point)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for index, at_end in ends.get((cx + dx, cy + dy), ()):
                    piece = pieces[index]
                    if used[index] or math.dist(point, piece[-1] if at_end else piece[0]) > epsilon:
                        continue
                    used[index] = True
                    return piece[::-1] if at_end else piece
        return None

    for index, piece in enumerate(pieces):
        if used[index]:
            continue
        used[index] = True
        chain = list(piece)
        while not _closed(chain, epsilon):
            after = take(chain[-1])
            if after is None:
                break
            chain.extend(after[1:])
        while not _closed(chain, epsilon):
            before = take(chain[0])
            if before is None:
                break
            chain[:0] = before[:0:-1]
        out.append(_shut(chain) if _closed(chain, epsilon) else chain)
    return out


def _closed(path: Polyline, epsilon: float = JOIN_EPSILON) -> bool:
    return len(path) > 3 and math.dist(path[0], path[-1]) <= epsilon


def _shut(path: Polyline) -> Polyline:
    """A closed path ending on its first point exactly."""
    return path[:-1] + [path[0]]


def _holds(board: Polygons, copper: Polygons) -> bool:
    """Whether the board region holds most of the copper."""
    solid = geom.union(copper)
    total = geom.area(solid)
    return total <= 0.0 or geom.area(geom.intersection(solid, board)) >= HOLD_SHARE * total


def _even_odd(contours: Polygons) -> Polygons:
    """The area the contours enclose, a cutout inside a board being a hole."""
    engine = pyclipper.Pyclipper()
    engine.AddPaths(_up(contours), pyclipper.PT_SUBJECT, True)
    return _down(engine.Execute(pyclipper.CT_UNION, pyclipper.PFT_EVENODD, pyclipper.PFT_EVENODD))


def _up(paths) -> list:
    return [[(int(round(x * SCALE)), int(round(y * SCALE))) for x, y in path] for path in paths]


def _down(paths) -> list[Polyline]:
    return [[(x / SCALE, y / SCALE) for x, y in path] for path in paths]


def clip_open(
    lines: list[Polyline],
    clip: Polygons,
    operation: int = pyclipper.CT_INTERSECTION,
) -> list[Polyline]:
    """The parts of open polylines inside (or outside, for a difference) the polygons."""
    lines = [line for line in lines if len(line) >= 2]
    if not lines:
        return []
    if not clip:
        return [list(line) for line in lines] if operation == pyclipper.CT_DIFFERENCE else []
    engine = pyclipper.Pyclipper()
    engine.AddPaths(_up(lines), pyclipper.PT_SUBJECT, False)
    engine.AddPaths(_up(clip), pyclipper.PT_CLIP, True)
    tree = engine.Execute2(operation, pyclipper.PFT_NONZERO, pyclipper.PFT_NONZERO)
    pieces = _down(pyclipper.OpenPathsFromPolyTree(tree))
    return [path for path in pieces if len(path) >= 2 and _length(path) >= MIN_STROKE]


def _length(path: Polyline) -> float:
    return sum(math.dist(a, b) for a, b in zip(path, path[1:]))


def radial_extent(area: Polygons) -> tuple[float, float]:
    """Nearest and farthest the area comes to the axis."""
    far = max(math.hypot(x, y) for contour in area for x, y in contour)
    if _inside(area, (0.0, 0.0)):
        return 0.0, far
    near = min(
        _segment_distance((0.0, 0.0), a, b)
        for contour in area
        for a, b in zip(contour, contour[1:] + contour[:1])
    )
    return near, far


def _inside(area: Polygons, point: Point) -> bool:
    """Nonzero winding over every contour, holes wound the other way."""
    probe = (int(round(point[0] * SCALE)), int(round(point[1] * SCALE)))
    winding = 0
    for contour in _up(area):
        if pyclipper.PointInPolygon(probe, contour) != 0:
            winding += 1 if pyclipper.Orientation(contour) else -1
    return winding != 0


def _segment_distance(point: Point, a: Point, b: Point) -> float:
    ax, ay = a
    dx, dy = b[0] - ax, b[1] - ay
    length = dx * dx + dy * dy
    t = 0.0 if length == 0.0 else max(0.0, min(1.0, ((point[0] - ax) * dx + (point[1] - ay) * dy) / length))
    return math.hypot(point[0] - (ax + t * dx), point[1] - (ay + t * dy))


# --- the fills ----------------------------------------------------------------


def far_profile(area: Polygons, wedges: int) -> list[float]:
    """How far the area reaches from the axis in each of `wedges` equal
    wedges round it, the first starting at angle zero.

    The farthest point of the area in a wedge lies on its boundary, and the
    farthest point of a straight edge is one of its ends, so each edge is
    cut where it crosses from one wedge into the next and every piece
    counts by its ends.
    """
    width = 2.0 * math.pi / wedges
    far = [0.0] * wedges

    def reach(wedge: int, radius: float) -> None:
        wedge %= wedges
        if radius > far[wedge]:
            far[wedge] = radius

    for contour in area:
        for a, b in zip(contour, contour[1:] + contour[:1]):
            start = _angle(a)
            first = math.floor(start / width)
            reach(first, math.hypot(*a))
            reach(math.floor(_angle(b) / width), math.hypot(*b))
            cross = a[0] * b[1] - a[1] * b[0]
            if cross == 0.0:
                # Along a ray, or through the axis: each half keeps to the
                # wedge its end is in.
                continue
            sweep = math.atan2(cross, a[0] * b[0] + a[1] * b[1])
            dx, dy = b[0] - a[0], b[1] - a[1]
            # The rays between wedges that the edge crosses, in its turn.
            if sweep > 0.0:
                boundaries = range(first + 1, math.floor((start + sweep) / width) + 1)
            else:
                boundaries = range(first, math.ceil((start + sweep) / width) - 1, -1)
            for boundary in boundaries:
                c, s = math.cos(boundary * width), math.sin(boundary * width)
                across = c * dy - s * dx
                if across == 0.0:
                    continue
                radius = cross / across
                reach(boundary - 1, radius)
                reach(boundary, radius)
    return far


def spoke_angles(far: list[float], pitch: float) -> list[float]:
    """Spoke angles from zero round the axis, each gap only as wide as lets
    one pitch span it at the farthest the area reaches within it."""
    wedges = len(far)
    width = 2.0 * math.pi / wedges

    def reach(low: float, high: float) -> float:
        return max(far[k % wedges] for k in range(math.floor(low / width), math.floor(high / width) + 1))

    angles = []
    theta = 0.0
    while theta < 2.0 * math.pi:
        angles.append(theta)
        here = far[math.floor(theta / width) % wedges]
        gap = min(WIDEST_GAP, pitch / here) if here > 0.0 else WIDEST_GAP
        # A narrower gap can only reach less far, so this settles once the
        # reach stops falling (a pitch over the reach and back may round up).
        radius = reach(theta, theta + gap)
        while radius * gap > pitch:
            gap = pitch / radius
            narrower = reach(theta, theta + gap)
            if narrower >= radius:
                break
            radius = narrower
        theta += gap
    return angles


def spoke_levels(count: int, far: float, pitch: float) -> int:
    """How many times the set of spokes halves on the way in, keeping at
    least four in the innermost set."""
    levels = 0
    while far / 2.0**levels > CORE_PITCHES * pitch:
        levels += 1
    while levels > 0 and count < 4 * 2**levels:
        levels -= 1
    return levels


def spoke_level(index: int, levels: int) -> int:
    """The coarsest set spoke `index` belongs to: every 2**level-th spoke
    is in set `level`, and the last set runs all the way in."""
    level = 0
    while level < levels and index % 2 ** (level + 1) == 0:
        level += 1
    return level


def spoke_inner(angles: list[float], index: int, levels: int, pitch: float) -> float:
    """Where spoke `index` starts: where the gap it splits, between the
    nearest spokes of a coarser set on either side, grows to a pitch. The
    innermost set runs in to half a pitch off the axis."""
    level = spoke_level(index, levels)
    if level >= levels:
        return pitch / 2.0
    count = len(angles)
    left = index - 1
    while spoke_level(left % count, levels) <= level:
        left -= 1
    right = index + 1
    while spoke_level(right % count, levels) <= level:
        right += 1
    gap = (angles[right % count] - angles[left % count]) % (2.0 * math.pi)
    return max(pitch / 2.0, pitch / gap)


def spokes(area: Polygons, pitch: float, pace: float = DEFAULT_PACE) -> list[Polyline]:
    """Radial strokes, in the order the head reaches them soonest."""
    _, far = radial_extent(area)
    outer = far + pitch
    # Wedges no wider than the closest spokes can be, so a gap between two
    # spans no more than a wedge or two beyond itself.
    angles = spoke_angles(far_profile(area, max(8, math.ceil(2.0 * math.pi * outer / pitch))), pitch)
    levels = spoke_levels(len(angles), far, pitch)
    rays = []
    for index, theta in enumerate(angles):
        inner = spoke_inner(angles, index, levels, pitch)
        c, s = math.cos(theta), math.sin(theta)
        rays.append([(inner * c, inner * s), (outer * c, outer * s)])
    by_spoke: dict[int, list[Polyline]] = {}
    for piece in clip_open(rays, area):
        index = _nearest(angles, _angle(_midpoint(piece)))
        # Back on the ray exactly, out from the axis side: clipping rounds
        # an end to a nanometre, which near the axis tilts a short spoke
        # enough to change its angle word.
        c, s = math.cos(angles[index]), math.sin(angles[index])
        low, high = sorted((math.hypot(*piece[0]), math.hypot(*piece[-1])))
        by_spoke.setdefault(index, []).append([(low * c, low * s), (high * c, high * s)])
    # Once round the table suits a few sets of spokes, where the rail runs
    # little between a short spoke's end and a long one's; nearest first
    # suits many, taking each set round in turn.
    orders = [
        sweep([sorted(by_spoke[i], key=lambda p: math.hypot(*p[0])) for i in sorted(by_spoke)], pace),
        by_travel([piece for i in sorted(by_spoke) for piece in by_spoke[i]], pace),
    ]
    return min(orders, key=lambda order: travel(order, pace))


def _nearest(angles: list[float], theta: float) -> int:
    """The index of the angle round the circle nearest `theta`."""
    count = len(angles)
    after = bisect.bisect_left(angles, theta)
    return min(
        ((after - 1) % count, after % count),
        key=lambda i: abs(math.remainder(angles[i] - theta, 2.0 * math.pi)),
    )


def _joint(point: Point) -> tuple[float, float]:
    """Radius and angle in degrees, [0, 360)."""
    return math.hypot(*point), math.degrees(_angle(point))


def _move(a: tuple[float, float], b: tuple[float, float], pace: float) -> float:
    """The time between two joints, in rail millimeters at `pace` to the
    degree: the longer of the rail's run and the table's turn."""
    turn = abs(b[1] - a[1]) % 360.0
    return max(abs(b[0] - a[0]), min(turn, 360.0 - turn) * pace)


def travel(strokes: list[Polyline], pace: float, start: Point = (0.0, 0.0)) -> float:
    """The time the head spends between strokes, in rail millimeters."""
    total = 0.0
    at = _joint(start)
    for stroke in strokes:
        total += _move(at, _joint(stroke[0]), pace)
        at = _joint(stroke[-1])
    return total


def sweep(spokes: list[list[Polyline]], pace: float, start: Point = (0.0, 0.0)) -> list[Polyline]:
    """Spokes in the order given, their pieces out from the axis, each
    spoke cut out or in as makes the least travel over the whole round."""
    if not spokes:
        return []

    def ends(pieces: list[Polyline], way: int) -> tuple[tuple[float, float], tuple[float, float]]:
        """Where the head starts and ends the spoke, out (0) or in (1)."""
        if way == 0:
            return _joint(pieces[0][0]), _joint(pieces[-1][-1])
        return _joint(pieces[-1][-1]), _joint(pieces[0][0])

    # For each way the last spoke went, the least travel so far, and for
    # each spoke after the first, the way the one before it went on that
    # path.
    at = _joint(start)
    best = [_move(at, ends(spokes[0], way)[0], pace) for way in (0, 1)]
    back: list[tuple[int, int]] = []
    for before, pieces in zip(spokes, spokes[1:]):
        step = []
        came = []
        for way in (0, 1):
            entry = ends(pieces, way)[0]
            costs = [best[w] + _move(ends(before, w)[1], entry, pace) for w in (0, 1)]
            w = 0 if costs[0] <= costs[1] else 1
            step.append(costs[w])
            came.append(w)
        best = step
        back.append((came[0], came[1]))
    way = 0 if best[0] <= best[1] else 1
    chosen = [way]
    for came in reversed(back):
        way = came[way]
        chosen.append(way)
    chosen.reverse()
    out: list[Polyline] = []
    for pieces, way in zip(spokes, chosen):
        out.extend(pieces if way == 0 else [p[::-1] for p in reversed(pieces)])
    return out


def by_travel(strokes: list[Polyline], pace: float, start: Point = (0.0, 0.0)) -> list[Polyline]:
    """The strokes taken in turn by whichever end the head reaches soonest
    from where the last one left it, each cut from that end.

    The head's time to a point is the longer of the rail's run and the
    table's turn, counted in rail millimeters at `pace` to the degree: a
    move between two strokes is a straight line in the joints.
    """
    if not strokes:
        return []
    wedges = max(1, min(3600, 2 * len(strokes)))
    width = 360.0 / wedges
    buckets: list[dict[tuple[int, int], tuple[float, float]]] = [{} for _ in range(wedges)]

    def wedge(degrees: float) -> int:
        return int(degrees / width) % wedges

    for index, stroke in enumerate(strokes):
        for side, point in ((0, stroke[0]), (1, stroke[-1])):
            end = _joint(point)
            buckets[wedge(end[1])][(index, side)] = end
    at = _joint(start)
    out = []
    for _ in range(len(strokes)):
        best: tuple[float, int, int] | None = None
        home = wedge(at[1])
        for step in range(wedges // 2 + 1):
            # Nothing a wedge this far round is nearer in angle than this.
            if best is not None and (step - 1) * width * pace >= best[0]:
                break
            for k in sorted({(home + step) % wedges, (home - step) % wedges}):
                for (index, side), end in buckets[k].items():
                    cost = _move(at, end, pace)
                    if best is None or cost < best[0]:
                        best = (cost, index, side)
        assert best is not None
        _, index, side = best
        stroke = strokes[index]
        for end_side, point in ((0, stroke[0]), (1, stroke[-1])):
            del buckets[wedge(_joint(point)[1])][(index, end_side)]
        stroke = stroke if side == 0 else stroke[::-1]
        out.append(stroke)
        at = _joint(stroke[-1])
    return out


def spaced(low: float, high: float, pitch: float) -> list[float]:
    """Evenly spaced values no more than a pitch apart, none on either bound."""
    span = high - low
    count = max(1, math.ceil(span / pitch))
    return [low + (index + 0.5) * span / count for index in range(count)]


def ring_points(radius: float, tolerance: float) -> Polyline:
    """A closed ring from angle zero, its chords within half the tolerance."""
    sagitta = min(tolerance / 2.0, radius)
    step = 2.0 * math.acos(1.0 - sagitta / radius)
    count = max(8, math.ceil(2.0 * math.pi / step))
    points = [
        (radius * math.cos(2.0 * math.pi * i / count), radius * math.sin(2.0 * math.pi * i / count))
        for i in range(count)
    ]
    return points + [points[0]]


def rings(area: Polygons, pitch: float, tolerance: float) -> list[Polyline]:
    """Arcs about the axis, turning one way and then the other, going out."""
    near, far = radial_extent(area)
    radii = spaced(near, far, pitch)
    # A ring is clipped as chords, and the arc the machine runs bulges past
    # a chord by up to its sagitta; clipping to an area that much smaller
    # keeps the arc, and an end put back on the ring, inside the real one.
    inner = geom.offset(area, -tolerance / 2.0)
    by_ring: dict[int, list[Polyline]] = {}
    for piece in clip_open([ring_points(r, tolerance) for r in radii], inner):
        mid = _midpoint(piece)
        index = min(range(len(radii)), key=lambda i: abs(radii[i] - math.hypot(*mid)))
        radius = radii[index]
        # Back on the ring exactly: a clipped end sits on a chord, and the
        # radius word must not change along an arc.
        piece = [_on_ring(p, radius) for p in piece]
        if _sweep(piece) < 0.0:
            piece = piece[::-1]
        by_ring.setdefault(index, []).append(piece)
    out: list[Polyline] = []
    heading = 0.0
    for turn, index in enumerate(sorted(by_ring)):
        arcs = _join_at_seam(by_ring[index])
        if turn % 2:
            # Clockwise: each arc reversed, and met in falling angle.
            arcs = sorted((arc[::-1] for arc in arcs), key=lambda arc: -_angle(arc[0]))
            start = next((i for i, arc in enumerate(arcs) if _angle(arc[0]) <= heading), 0)
        else:
            arcs.sort(key=lambda arc: _angle(arc[0]))
            start = next((i for i, arc in enumerate(arcs) if _angle(arc[0]) >= heading), 0)
        arcs = arcs[start:] + arcs[:start]
        out.extend(arcs)
        heading = _angle(arcs[-1][-1])
    return out


def _on_ring(point: Point, radius: float) -> Point:
    length = math.hypot(*point)
    if length == 0.0:
        return (radius, 0.0)
    return (point[0] * radius / length, point[1] * radius / length)


def _sweep(piece: Polyline) -> float:
    """Signed angle a polyline turns through about the axis."""
    total = 0.0
    for a, b in zip(piece, piece[1:]):
        total += math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1])
    return total


def _join_at_seam(arcs: list[Polyline]) -> list[Polyline]:
    """A ring is clipped as a path from angle zero round to angle zero, so an
    arc across that angle comes back as two; they become one again."""
    if len(arcs) < 2:
        return arcs
    seam = 1e-6 * max(1.0, math.hypot(*arcs[0][0]))
    tails = [arc for arc in arcs if math.dist(arc[-1], _seam_point(arc)) < seam]
    heads = [arc for arc in arcs if math.dist(arc[0], _seam_point(arc)) < seam]
    if len(tails) != 1 or len(heads) != 1 or tails[0] is heads[0]:
        return arcs
    tail, head = tails[0], heads[0]
    return [arc for arc in arcs if arc is not tail and arc is not head] + [tail + head[1:]]


def _seam_point(arc: Polyline) -> Point:
    return (math.hypot(*arc[0]), 0.0)


def rows(area: Polygons, pitch: float) -> list[Polyline]:
    """Rows along X, left to right and back, going up."""
    x0, y0, x1, y1 = geom.bounds(area)
    heights = spaced(y0, y1, pitch)
    lines = [[(x0 - pitch, y), (x1 + pitch, y)] for y in heights]
    by_row: dict[int, list[Polyline]] = {}
    for piece in clip_open(lines, area):
        mid = _midpoint(piece)
        index = min(range(len(heights)), key=lambda i: abs(heights[i] - mid[1]))
        y = heights[index]
        ends = sorted((piece[0][0], piece[-1][0]))
        by_row.setdefault(index, []).append([(ends[0], y), (ends[1], y)])
    out: list[Polyline] = []
    for turn, index in enumerate(sorted(by_row)):
        pieces = sorted(by_row[index], key=lambda p: p[0][0])
        if turn % 2:
            pieces = [p[::-1] for p in reversed(pieces)]
        out.extend(pieces)
    return out


def edge(frame: Polygons, kept: Polygons, near: Point) -> list[Polyline]:
    """The inside of the perimeter, where the copper to keep does not reach,
    starting from the loop nearest `near`."""
    loops = [contour + contour[:1] for contour in frame if len(contour) >= 3]
    pieces = clip_open(loops, kept, pyclipper.CT_DIFFERENCE)
    out: list[Polyline] = []
    position = near
    while pieces:
        nearest = min(range(len(pieces)), key=lambda i: math.dist(position, pieces[i][0]))
        piece = pieces.pop(nearest)
        out.append(piece)
        position = piece[-1]
    return out


def _midpoint(piece: Polyline) -> Point:
    """A point on the piece halfway along its vertices, clear of its ends."""
    if len(piece) == 2:
        a, b = piece
        return ((a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0)
    return piece[len(piece) // 2]


def _angle(point: Point) -> float:
    """Angle about the axis in [0, 2 pi)."""
    return math.atan2(point[1], point[0]) % (2.0 * math.pi)
