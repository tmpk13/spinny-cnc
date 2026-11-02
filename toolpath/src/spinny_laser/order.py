"""Cutting order of a drawing's paths: whatever lies inside a closed shape
is cut before the shape itself.

A part's holes and the marks on it are cut while the sheet around them
still holds the part; cut after the outline frees it, the part may drop or
shift and the holes land wrong. Every path is ranked by how many closed
shapes enclose it, and the deepest go first; paths of the same depth keep
the order they came in.
"""

from __future__ import annotations

Point = tuple[float, float]

# Ends nearer than this, mm, close a path.
CLOSED_WITHIN = 1e-6


def is_closed(path: list[Point]) -> bool:
    """A path whose ends meet, around at least three points."""
    if len(path) < 4:
        return False
    (x0, y0), (x1, y1) = path[0], path[-1]
    return abs(x0 - x1) <= CLOSED_WITHIN and abs(y0 - y1) <= CLOSED_WITHIN


def _box(path: list[Point]) -> tuple[float, float, float, float]:
    xs = [p[0] for p in path]
    ys = [p[1] for p in path]
    return (min(xs), min(ys), max(xs), max(ys))


def _area(path: list[Point]) -> float:
    total = 0.0
    for (x0, y0), (x1, y1) in zip(path, path[1:]):
        total += x0 * y1 - x1 * y0
    return abs(total) / 2.0


def _inside(point: Point, polygon: list[Point]) -> bool:
    """Even-odd ray test; the polygon's last point repeats its first."""
    x, y = point
    inside = False
    for (x0, y0), (x1, y1) in zip(polygon, polygon[1:]):
        if (y0 > y) != (y1 > y) and x < x0 + (y - y0) * (x1 - x0) / (y1 - y0):
            inside = not inside
    return inside


def depths(paths: list[list[Point]]) -> list[int]:
    """For each path, how many of the closed paths enclose it: a closed path
    holds another when its box holds the other's, it is the larger, and the
    other's first point lies inside it."""
    closed = [i for i, path in enumerate(paths) if is_closed(path)]
    boxes = {i: _box(paths[i]) for i in closed}
    areas = {i: _area(paths[i]) for i in closed}
    out = []
    for i, path in enumerate(paths):
        if not path:
            out.append(0)
            continue
        box = _box(path)
        area = areas.get(i, 0.0)
        depth = 0
        for j in closed:
            if j == i:
                continue
            bx0, by0, bx1, by1 = boxes[j]
            if not (bx0 <= box[0] and by0 <= box[1] and box[2] <= bx1 and box[3] <= by1):
                continue
            if areas[j] <= area:
                continue
            if _inside(path[0], paths[j]):
                depth += 1
        out.append(depth)
    return out


def inner_first(paths: list[list[Point]]) -> list[list[Point]]:
    """The paths with everything inside a closed shape before the shape:
    deepest first, the order given kept within a depth."""
    ranked = depths(paths)
    order = sorted(range(len(paths)), key=lambda i: -ranked[i])
    return [paths[i] for i in order]
