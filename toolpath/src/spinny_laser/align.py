"""Lining a job up with the board on the table.

A mark pairs a design point (a pad, a hole, any point of the job) with
the board point the machine found it at. One mark gives a shift; two or
more give a turn about the origin and a shift, fitted by least squares
(a Procrustes fit: the centroids of both sets are matched, and the turn
is the one that best overlays the centered points). The scale the marks
imply is reported, so a wrong pairing or a stretched board shows, but
never applied: the machine's axes are what they are.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

Point = tuple[float, float]
# A design point and the machine point it was found at.
Pair = tuple[Point, Point]


@dataclass(frozen=True)
class Fit:
    # Degrees counterclockwise about the origin, applied before the shift.
    rotation: float
    shift: Point
    # What the marks say the design's size is against the machine's; 1 is
    # right, and it is never applied.
    scale: float
    rms: float
    residuals: tuple[float, ...]
    marks: int

    def apply(self, point: Point) -> Point:
        x, y = turn(point, self.rotation)
        return (x + self.shift[0], y + self.shift[1])

    def to_dict(self) -> dict:
        return {
            "rotation": round(self.rotation, 4),
            "shift": [round(self.shift[0], 4), round(self.shift[1], 4)],
            "scale": round(self.scale, 5),
            "rms": round(self.rms, 4),
            "residuals": [round(value, 4) for value in self.residuals],
            "marks": self.marks,
        }


def turn(point: Point, degrees: float) -> Point:
    """The point turned counterclockwise about the origin."""
    radians = math.radians(degrees)
    c, s = math.cos(radians), math.sin(radians)
    x, y = point
    return (x * c - y * s, x * s + y * c)


def fit_rigid(pairs: list[Pair], angle: float | None = None) -> Fit:
    """The turn and shift that take the design points onto the machine
    points. With one pair, or with `angle` given (degrees the board is
    known to be turned, from a camera), the turn is `angle` or 0 and the
    shift follows; with two or more, both are fitted."""
    if not pairs:
        raise ValueError("no marks to fit: mark a pad or a hole first")
    for design, machine in pairs:
        if not all(math.isfinite(v) for v in (*design, *machine)):
            raise ValueError("a mark holds a value that is not a number")
    if len(pairs) == 1 or angle is not None:
        rotation = float(angle) if angle is not None else 0.0
        scale = 1.0
    else:
        n = len(pairs)
        cdx = sum(d[0] for d, _ in pairs) / n
        cdy = sum(d[1] for d, _ in pairs) / n
        cmx = sum(m[0] for _, m in pairs) / n
        cmy = sum(m[1] for _, m in pairs) / n
        cross = 0.0
        dot = 0.0
        design_spread = 0.0
        machine_spread = 0.0
        for (dx, dy), (mx, my) in pairs:
            dx, dy, mx, my = dx - cdx, dy - cdy, mx - cmx, my - cmy
            cross += dx * my - dy * mx
            dot += dx * mx + dy * my
            design_spread += dx * dx + dy * dy
            machine_spread += mx * mx + my * my
        if design_spread <= 1e-12:
            raise ValueError("the marks are all on one design point: mark two different pads or holes")
        rotation = math.degrees(math.atan2(cross, dot))
        scale = math.sqrt(machine_spread / design_spread)
    # The shift puts the turned design centroid on the machine centroid,
    # which with one pair is the pair itself.
    n = len(pairs)
    turned = [turn(design, rotation) for design, _ in pairs]
    shift = (
        sum(m[0] for _, m in pairs) / n - sum(t[0] for t in turned) / n,
        sum(m[1] for _, m in pairs) / n - sum(t[1] for t in turned) / n,
    )
    fit = Fit(rotation=rotation, shift=shift, scale=scale, rms=0.0, residuals=(), marks=n)
    residuals = tuple(math.dist(fit.apply(design), machine) for design, machine in pairs)
    rms = math.sqrt(sum(r * r for r in residuals) / n)
    return Fit(rotation=rotation, shift=shift, scale=scale, rms=rms, residuals=residuals, marks=n)


def turned_paths(paths: list, degrees: float) -> list:
    """Polylines turned about the origin."""
    return [[turn((float(x), float(y)), degrees) for x, y in path] for path in paths]
