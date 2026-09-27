"""Polar kinematics: board coordinates to a radius on X and an angle on the table.

The laser rides a linear axis that passes over the rotation axis of the table
the board sits on. A board point at polar angle `phi` comes under the beam
when the table has turned so that `phi` points along the rail, so the joint
position for a point is simply its polar radius and polar angle. A straight
line in board coordinates is a spiral in joint space, so every segment is
subdivided until linear joint interpolation stays within a tolerance of the
line the controller was asked for.

Angles are kept unwrapped: each new angle is the representative nearest the
previous one, so the table never swings the long way round, and a job that
circles the axis simply keeps counting.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

Point = tuple[float, float]
# Radius in mm, angle in degrees, unwrapped.
Joint = tuple[float, float]

# A point closer to the axis than this has no angle of its own.
AXIS_EPSILON = 1e-6
# Bisection stops splitting once a segment is this short, in mm; at the axis
# the spiral error never reaches zero and the recursion has to end somewhere.
MIN_SEGMENT = 1e-3
MAX_DEPTH = 24


@dataclass(frozen=True)
class Kinematics:
    # Largest gap allowed between the joint-space path and the true line, mm.
    tolerance: float = 0.005

    def __post_init__(self) -> None:
        if self.tolerance <= 0:
            raise ValueError("tolerance must be > 0")


def radius_of(point: Point) -> float:
    return math.hypot(point[0], point[1])


def unwrap(angle: float, previous: float) -> float:
    """The representative of `angle` within half a turn of `previous`."""
    return previous + (angle - previous + 180.0) % 360.0 - 180.0


def angle_of(point: Point, previous: float) -> float:
    """Polar angle in degrees, unwrapped towards `previous`.

    On the axis every angle is the same place, so the previous one is kept
    and the move in to the axis is purely radial.
    """
    if radius_of(point) < AXIS_EPSILON:
        return previous
    return unwrap(math.degrees(math.atan2(point[1], point[0])), previous)


def joint_of(point: Point, previous_angle: float) -> Joint:
    return (radius_of(point), angle_of(point, previous_angle))


def cartesian(joint: Joint) -> Point:
    radius, angle = joint
    theta = math.radians(angle)
    return (radius * math.cos(theta), radius * math.sin(theta))


def far_side(joint: Joint) -> Joint:
    """The same board point reached with the head past the axis.

    The radius is negated and the table is half a turn on. A machine that
    is out displaces the beam the opposite way there, which is what a
    calibration burn compares.
    """
    return (-joint[0], joint[1] + 180.0)


def displaced(joint: Joint, along: float, across: float) -> Point:
    """Where the beam lands on a machine that is out.

    The head at commanded radius r sits `along` further out on the rail and
    `across` off it, and the board sees that turned to the table angle.
    """
    theta = math.radians(joint[1])
    radius = joint[0] + along
    return (
        radius * math.cos(theta) - across * math.sin(theta),
        radius * math.sin(theta) + across * math.cos(theta),
    )


def interpolate_joints(
    poly: list[Joint], step_mm: float = 0.1, step_deg: float = 1.0, limit: int | None = None
) -> list[Joint]:
    """Joints along a polyline as the firmware runs it: linear between its points.

    With a `limit`, the steps widen evenly where they would come to more
    than that many, every point of the polyline itself still kept; a limit
    below 1 keeps only those.
    """
    if not poly:
        return []
    moves = list(zip(poly, poly[1:]))
    wanted = [max(abs(b[0] - a[0]) / step_mm, abs(b[1] - a[1]) / step_deg) for a, b in moves]
    widen = 1.0
    if limit is not None:
        total = sum(max(1, math.ceil(count)) for count in wanted)
        if total > limit:
            widen = total / max(1, limit)
    out = [poly[0]]
    for (a, b), count in zip(moves, wanted):
        dr, da = b[0] - a[0], b[1] - a[1]
        steps = max(1, int(math.ceil(count / widen)))
        for i in range(1, steps + 1):
            t = i / steps
            out.append((a[0] + dr * t, a[1] + da * t))
    return out


# Most points a preview draws a joint polyline with, besides its own. A
# calibration pattern's longest takes a few hundred; a job whose joints
# span far past any machine would otherwise take millions.
MAX_SAMPLES = 20000


def sample_joints(
    poly: list[Joint], step_mm: float = 0.1, step_deg: float = 1.0, limit: int | None = MAX_SAMPLES
) -> list[Point]:
    """Board points along a joint polyline, close enough to draw it."""
    return [cartesian(joint) for joint in interpolate_joints(poly, step_mm, step_deg, limit)]


def on_axis(joint: Joint) -> bool:
    # A negative radius is the far side of the axis, as far from it as the
    # positive one.
    return abs(joint[0]) < AXIS_EPSILON


def _lerp(a: Point, b: Point, t: float) -> Point:
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)


def _distance(a: Point, b: Point) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def chord_error(start: Point, end: Point, j_start: Joint, j_end: Joint) -> float:
    """How far linear joint interpolation strays from the straight line.

    Sampled at the quarter points; the spiral's worst deviation sits near the
    middle of a segment, so three samples bound it closely enough for a
    tolerance check.
    """
    worst = 0.0
    for t in (0.25, 0.5, 0.75):
        along = _lerp(start, end, t)
        joint = (
            j_start[0] + (j_end[0] - j_start[0]) * t,
            j_start[1] + (j_end[1] - j_start[1]) * t,
        )
        worst = max(worst, _distance(along, cartesian(joint)))
    return worst


def subdivide(
    start: Point, end: Point, j_start: Joint, kinematics: Kinematics
) -> list[tuple[Point, Joint]]:
    """Joint targets that trace `start` to `end` within the tolerance.

    Returns the points after `start`, each with its joint position. A segment
    that leaves the axis is split into a pure rotation on the axis followed
    by a radial move, since a spiral out of the axis can never be made
    straight by subdividing it.
    """
    out: list[tuple[Point, Joint]] = []

    def visit(t0: float, t1: float, p0: Point, j0: Joint, depth: int) -> Joint:
        p1 = _lerp(start, end, t1)
        j1 = joint_of(p1, j0[1])
        if on_axis(j0) and not on_axis(j1):
            # Turn on the spot first, then run straight out along the rail.
            if abs(j1[1] - j0[1]) > 0.0:
                out.append((p0, (0.0, j1[1])))
            out.append((p1, j1))
            return j1
        length = _distance(p0, p1)
        if (
            depth >= MAX_DEPTH
            or length <= MIN_SEGMENT
            or chord_error(p0, p1, j0, j1) <= kinematics.tolerance
        ):
            out.append((p1, j1))
            return j1
        tm = (t0 + t1) / 2.0
        jm = visit(t0, tm, p0, j0, depth + 1)
        return visit(tm, t1, _lerp(start, end, tm), jm, depth + 1)

    visit(0.0, 1.0, start, j_start, 0)
    return out


def split_at_axis(start: Point, end: Point, snap: float) -> list[Point]:
    """The points after `start` on its way to `end`, cut at the axis.

    A segment that comes within `snap` of the axis is broken at its closest
    point, which is moved onto the axis: the move in is then purely radial,
    the turn happens on the spot with the beam off, and the move out is
    radial again. Without the cut the subdivision only finds the axis when
    a bisection point lands on it exactly, and otherwise emits a lit
    segment that spans it: half a turn of the table under the beam at a
    radius of a few microns.
    """
    if radius_of(start) < AXIS_EPSILON:
        return [end]
    if radius_of(end) < snap:
        return [(0.0, 0.0)]
    if closest_approach(start, end) >= snap:
        return [end]
    return [(0.0, 0.0), end]


def closest_approach(start: Point, end: Point) -> float:
    """Nearest the segment comes to the axis, mm."""
    dx, dy = end[0] - start[0], end[1] - start[1]
    length2 = dx * dx + dy * dy
    if length2 == 0.0:
        return radius_of(start)
    t = -(start[0] * dx + start[1] * dy) / length2
    t = min(1.0, max(0.0, t))
    return radius_of(_lerp(start, end, t))


def path_min_radius(path: list[Point]) -> float:
    if len(path) == 1:
        return radius_of(path[0])
    return min(closest_approach(a, b) for a, b in zip(path, path[1:]))


def linear_resolution(steps_per_degree: float, radius: float) -> float:
    """What one rotary step moves the surface at a radius, mm."""
    return math.radians(1.0 / steps_per_degree) * radius
