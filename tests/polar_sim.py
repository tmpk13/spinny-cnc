"""A model of the machine: replays polar gcode and reports where the beam went."""

from __future__ import annotations

import math
import re

WORD = re.compile(r"([A-Za-z])(-?\d*\.?\d+)")


def replay(text: str, rotary: str = "A", axis_x: float = 0.0, invert: bool = False):
    """Board-coordinate cut paths, sampled finely along each joint move.

    Each G1 at non zero power is interpolated linearly in joint space, which
    is what the controller does, and every sample is mapped back to the
    board. The result is the mark the beam leaves, path by path.
    """
    radius = 0.0
    angle = 0.0
    power = 0.0
    mode = None
    inverse = False
    paths: list[list[tuple[float, float]]] = []
    current: list[tuple[float, float]] = []
    feeds: list[float] = []
    sign = -1.0 if invert else 1.0

    def board(r: float, a: float) -> tuple[float, float]:
        theta = math.radians(a)
        return (r * math.cos(theta), r * math.sin(theta))

    for raw in text.splitlines():
        line = raw.split(";")[0].strip()
        if not line:
            continue
        words = dict((k.upper(), float(v)) for k, v in WORD.findall(line))
        if "M" in words:
            power = 0.0 if words["M"] == 5 else words.get("S", power)
            continue
        if "S" in words:
            power = words["S"]
        if "G" in words:
            code = words["G"]
            if code == 93:
                inverse = True
                continue
            if code == 94:
                inverse = False
                continue
            if code in (0, 1):
                mode = int(code)
            elif code in (2, 3):
                raise AssertionError("arcs are not expected")
            elif code not in (21, 90):
                continue
        has_axis = "X" in words or rotary in words
        if not has_axis:
            continue
        nr = words.get("X", radius + axis_x) - axis_x
        na = sign * words[rotary] if rotary in words else angle
        if mode == 1 and power > 0:
            if inverse:
                assert "F" in words, f"inverse time cut without F: {raw}"
            if not current:
                current = [board(radius, angle)]
            steps = max(1, int(abs(na - angle) / 0.5) + 1)
            for i in range(1, steps + 1):
                t = i / steps
                current.append(board(radius + (nr - radius) * t, angle + (na - angle) * t))
            if "F" in words:
                feeds.append(words["F"])
        elif current:
            paths.append(current)
            current = []
        radius, angle = nr, na
    if current:
        paths.append(current)
    return paths


def deviation(mark: list[tuple[float, float]], path: list[tuple[float, float]]) -> float:
    """Worst distance from any sampled mark point to the intended polyline."""
    worst = 0.0
    for point in mark:
        worst = max(worst, _point_to_path(point, path))
    return worst


def nearest_deviation(mark, paths, slack: float = 0.5) -> float:
    """Deviation from the intended path this mark belongs to.

    Only paths whose bounding box holds the mark's first point are measured,
    which turns a job of hundreds of loops from minutes into a second.
    """
    x0, y0 = mark[0]
    candidates = []
    for path in paths:
        xs = [x for x, _ in path]
        ys = [y for _, y in path]
        if min(xs) - slack <= x0 <= max(xs) + slack and min(ys) - slack <= y0 <= max(ys) + slack:
            candidates.append(path)
    if not candidates:
        return math.inf
    return min(deviation(mark, path) for path in candidates)


def _point_to_path(point, path) -> float:
    best = math.inf
    for a, b in zip(path, path[1:]):
        best = min(best, _point_to_segment(point, a, b))
    return best


def _point_to_segment(p, a, b) -> float:
    dx, dy = b[0] - a[0], b[1] - a[1]
    length2 = dx * dx + dy * dy
    if length2 == 0.0:
        return math.dist(p, a)
    t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2
    t = min(1.0, max(0.0, t))
    return math.dist(p, (a[0] + dx * t, a[1] + dy * t))
