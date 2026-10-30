"""Simple milling operations as toolpaths: drilling points, a line through
points, facing a rectangle, and pocketing or profiling a rectangle or a
circle.

Every function gives the paths of the tool's center in board mm for a bit
`tool` mm across; how deep they cut and in how many steps is the caller's.
A path of one point is a drill: the bit goes down there and up. A pocket
or a face is one path, so the bit stays down from the first cut to the
last.

Directions follow a spindle turning clockwise seen from above: climb
milling runs counterclockwise inside a pocket or a hole and clockwise
around the outside of a part, conventional milling the other way round.
"""

from __future__ import annotations

import math

Point = tuple[float, float]
Path = list[Point]

# The sides a profile can cut on: around the outside of the shape, inside
# it, or with the bit's center on the line.
OUTSIDE, INSIDE, ON = "outside", "inside", "on"
SIDES = (OUTSIDE, INSIDE, ON)
# How far a chord of an arc may stray from the arc, mm.
DEFAULT_TOLERANCE = 0.005
# A stepover is a share of the bit: past the whole bit a pass leaves a
# strip between itself and the last one.
MIN_STEPOVER, MAX_STEPOVER = 0.05, 1.0
# A rectangular pocket's loops meet at square corners, where the point
# between two loops is 0.586 of their spacing from both; past this share
# of the bit apart the bit misses it.
MAX_POCKET_STEPOVER = 0.85
# Lengths below this are nothing, mm.
EPSILON = 1e-9


class MillError(ValueError):
    """An operation that cannot be cut as asked."""


def check_tool(tool: float) -> None:
    if not (math.isfinite(tool) and 0.0 < tool <= 100.0):
        raise MillError("the bit must be above 0 and at most 100 mm across")


def check_stepover(stepover: float) -> None:
    if not (math.isfinite(stepover) and MIN_STEPOVER <= stepover <= MAX_STEPOVER):
        raise MillError(f"the stepover is a share of the bit, {MIN_STEPOVER:g} to {MAX_STEPOVER:g}")


def box(x0: float, y0: float, x1: float, y1: float) -> tuple[float, float, float, float]:
    """The rectangle with its corners in order, low corner first."""
    return min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)


def arc(cx: float, cy: float, radius: float, start: float, sweep: float, tolerance: float = DEFAULT_TOLERANCE) -> Path:
    """Points along an arc from `start` degrees through `sweep` degrees
    (counterclockwise when positive), both ends included, each chord within
    `tolerance` of the arc."""
    if radius <= EPSILON:
        return [(cx, cy)]
    tolerance = min(max(tolerance, 1e-6), radius)
    # The angle one chord may span for its middle to stay within tolerance.
    step = 2.0 * math.acos(1.0 - tolerance / radius)
    count = max(2, math.ceil(abs(math.radians(sweep)) / step), math.ceil(abs(sweep) / 360.0 * 16))
    a0 = math.radians(start)
    a1 = math.radians(sweep)
    return [(cx + radius * math.cos(a0 + a1 * i / count), cy + radius * math.sin(a0 + a1 * i / count)) for i in range(count + 1)]


def circle(cx: float, cy: float, radius: float, ccw: bool = True, start: float = 0.0, tolerance: float = DEFAULT_TOLERANCE) -> Path:
    """A whole circle as a closed path from `start` degrees, its last point its first."""
    path = arc(cx, cy, radius, start, 360.0 if ccw else -360.0, tolerance)
    if len(path) > 1:
        path[-1] = path[0]
    return path


def _rectangle(xa: float, ya: float, xb: float, yb: float, ccw: bool, near: Point | None = None) -> Path:
    """A closed rectangle starting and ending at the corner nearest `near`
    (the low corner without one), counterclockwise or clockwise."""
    corners = [(xa, ya), (xb, ya), (xb, yb), (xa, yb)]
    if not ccw:
        corners = [corners[0], corners[3], corners[2], corners[1]]
    first = 0
    if near is not None:
        first = min(range(4), key=lambda i: math.dist(corners[i], near))
    ordered = corners[first:] + corners[:first]
    return [*ordered, ordered[0]]


def drill(points: list[Point]) -> list[Path]:
    """A one-point path at every point, in the order given."""
    if not points:
        raise MillError("a drill needs at least one point")
    return [[(float(x), float(y))] for x, y in points]


def line(points: list[Point], closed: bool = False) -> list[Path]:
    """One path through the points in order, back to the first when closed."""
    path = [(float(x), float(y)) for x, y in points]
    # A point given twice in a row is one point.
    path = [p for i, p in enumerate(path) if i == 0 or math.dist(p, path[i - 1]) > EPSILON]
    if len(path) < 2:
        raise MillError("a line needs two points apart")
    if closed and math.dist(path[0], path[-1]) > EPSILON:
        path.append(path[0])
    return [path]


def face(x0: float, y0: float, x1: float, y1: float, tool: float, stepover: float) -> list[Path]:
    """Rows along X over the rectangle, back and forth, from the low Y edge
    to the high one at most `stepover` bits apart, as one path. The bit's
    center runs over the whole rectangle, so its edge goes half a bit past
    every side and the rectangle is faced to its edges."""
    check_tool(tool)
    check_stepover(stepover)
    xa, ya, xb, yb = box(x0, y0, x1, y1)
    if xb - xa <= EPSILON and yb - ya <= EPSILON:
        raise MillError("a face needs two corners apart")
    rows = max(0, math.ceil((yb - ya) / (stepover * tool) - 1e-9))
    path: Path = []
    for j in range(rows + 1):
        y = ya + (yb - ya) * j / rows if rows > 0 else ya
        ends = [(xa, y), (xb, y)]
        path.extend(ends if j % 2 == 0 else ends[::-1])
    return line(path)


def pocket_rect(x0: float, y0: float, x1: float, y1: float, tool: float, stepover: float, climb: bool = True) -> list[Path]:
    """The rectangle cleared to its walls as one path: from a line along
    its middle out loop by loop, at most `stepover` bits apart, to the
    loop that finishes the walls. The corners keep the bit's radius."""
    check_tool(tool)
    check_stepover(stepover)
    if stepover > MAX_POCKET_STEPOVER:
        raise MillError(f"a rectangular pocket's stepover is at most {MAX_POCKET_STEPOVER:g}: wider, its loops leave the corners between them standing")
    xa, ya, xb, yb = box(x0, y0, x1, y1)
    r = tool / 2.0
    a, c, b, d = xa + r, ya + r, xb - r, yb - r
    if b < a - EPSILON or d < c - EPSILON:
        raise MillError(f"the pocket is narrower than the bit: {xb - xa:.3f} by {yb - ya:.3f} mm for a {tool:g} mm bit")
    b, d = max(a, b), max(c, d)
    # The middle: the line the loops close in on, a point for a square.
    m = min(b - a, d - c) / 2.0
    path: Path = [(a + m, c + m), (b - m, d - m)]
    insets: list[float] = []
    t = m - stepover * tool
    while t > EPSILON:
        insets.append(t)
        t -= stepover * tool
    insets.append(0.0)
    for t in insets:
        loop = _rectangle(a + t, c + t, b - t, d - t, ccw=climb, near=path[-1])
        path.extend(loop)
    return line(path)


def pocket_circle(
    cx: float, cy: float, diameter: float, tool: float, stepover: float, climb: bool = True, tolerance: float = DEFAULT_TOLERANCE
) -> list[Path]:
    """The circle cleared to its wall as one path: down at the middle,
    then rings out, at most `stepover` bits apart, to the ring that
    finishes the wall. A circle as wide as the bit is a drill."""
    check_tool(tool)
    check_stepover(stepover)
    if not (math.isfinite(diameter) and diameter > 0.0):
        raise MillError("the circle needs a diameter above 0")
    radius = diameter / 2.0 - tool / 2.0
    if radius < -EPSILON:
        raise MillError(f"the bit is wider than the circle: a {tool:g} mm bit in {diameter:g} mm")
    if radius <= 1e-6:
        return [[(cx, cy)]]
    radii: list[float] = []
    rho = radius
    while rho > EPSILON:
        radii.append(rho)
        rho -= stepover * tool
    path: Path = [(cx, cy)]
    for rho in reversed(radii):
        path.extend(circle(cx, cy, rho, ccw=climb, tolerance=tolerance))
    return line(path)


def profile_rect(
    x0: float, y0: float, x1: float, y1: float, tool: float, side: str = OUTSIDE, climb: bool = True, tolerance: float = DEFAULT_TOLERANCE
) -> list[Path]:
    """One closed path along the rectangle's edge: outside it with the
    corners rounded by the bit's radius so the part keeps them sharp,
    inside it, where the corners keep the bit's radius, or on the line."""
    check_tool(tool)
    if side not in SIDES:
        raise MillError(f"the side is one of {', '.join(SIDES)}")
    xa, ya, xb, yb = box(x0, y0, x1, y1)
    if xb - xa <= EPSILON or yb - ya <= EPSILON:
        raise MillError("a rectangle needs a width and a height")
    r = tool / 2.0
    if side == INSIDE:
        if xb - xa < tool - EPSILON or yb - ya < tool - EPSILON:
            raise MillError(f"the rectangle is narrower than the bit: {xb - xa:.3f} by {yb - ya:.3f} mm for a {tool:g} mm bit")
        a, c, b, d = xa + r, ya + r, max(xa + r, xb - r), max(ya + r, yb - r)
        return line(_rectangle(a, c, b, d, ccw=climb))
    if side == ON:
        return line(_rectangle(xa, ya, xb, yb, ccw=not climb))
    # Outside, counterclockwise from under the low corner: each side, then
    # the quarter circle about the next corner.
    path: Path = [(xa, ya - r), (xb, ya - r)]
    path.extend(arc(xb, ya, r, -90.0, 90.0, tolerance)[1:])
    path.append((xb + r, yb))
    path.extend(arc(xb, yb, r, 0.0, 90.0, tolerance)[1:])
    path.append((xa, yb + r))
    path.extend(arc(xa, yb, r, 90.0, 90.0, tolerance)[1:])
    path.append((xa - r, ya))
    path.extend(arc(xa, ya, r, 180.0, 90.0, tolerance)[1:])
    path[-1] = path[0]
    if climb:
        path.reverse()
    return line(path)


def profile_circle(
    cx: float, cy: float, diameter: float, tool: float, side: str = OUTSIDE, climb: bool = True, tolerance: float = DEFAULT_TOLERANCE
) -> list[Path]:
    """One ring around the circle: outside it, inside it, or on the line."""
    check_tool(tool)
    if side not in SIDES:
        raise MillError(f"the side is one of {', '.join(SIDES)}")
    if not (math.isfinite(diameter) and diameter > 0.0):
        raise MillError("the circle needs a diameter above 0")
    r = tool / 2.0
    radius = diameter / 2.0 + (r if side == OUTSIDE else -r if side == INSIDE else 0.0)
    if radius < -EPSILON:
        raise MillError(f"the bit is wider than the circle: a {tool:g} mm bit in {diameter:g} mm")
    if radius <= 1e-6:
        return [[(cx, cy)]]
    # Climb runs clockwise around a part (or along its line), counterclockwise
    # inside a hole.
    ccw = (side == INSIDE) == climb
    return line(circle(cx, cy, radius, ccw=ccw, tolerance=tolerance))


def path_length(path: Path) -> float:
    return sum(math.dist(p, q) for p, q in zip(path, path[1:]))
