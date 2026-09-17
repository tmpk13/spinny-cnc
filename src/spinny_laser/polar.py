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


def on_axis(joint: Joint) -> bool:
    return joint[0] < AXIS_EPSILON


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
