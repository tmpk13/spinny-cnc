"""The pads and holes of a board layer: for probing on copper, for dots of
solder paste, and for lining a job up with the board.

A pad is an island of what the layer fills: every flash and region of a
gerber, joined where they touch, so a pad drawn as two flashes counts
once. Strokes are tracks and are left out. An island larger than a pad
could be is a pour or a region and is left out too, and so is a pad poured
into one, which the pour has swallowed. The paste layer has nothing but
pads, so it is the layer to read on a finished board; a copper layer's
pads are its flashes where they stand free. Holes come from the drill
file, a slot by its middle.
"""

from __future__ import annotations

import math

from laser_sweep import geom
from laser_sweep.excellon import Drills
from laser_sweep.gerber import Fill, Image

Point = tuple[float, float]
# x, y and area in mm^2.
Pad = tuple[float, float, float]
# x, y and diameter.
Hole = tuple[float, float, float]

# Larger than this an island is a pour or a region, not a pad, mm^2.
MAX_PAD_AREA = 100.0
# Smaller than this an island is a sliver, mm^2.
MIN_PAD_AREA = 0.01


def pads_of(image: Image, max_area: float = MAX_PAD_AREA) -> list[Pad]:
    """Every pad of a layer, by its centroid and area, rows first."""
    fills = Image(figures=[figure for figure in image.figures if isinstance(figure, Fill)])
    pads: list[Pad] = []
    for island in geom.islands(geom.copper(fills)):
        area, (x, y) = centroid(island)
        if MIN_PAD_AREA <= area <= max_area:
            pads.append((round(x, 4), round(y, 4), round(area, 4)))
    pads.sort(key=lambda pad: (pad[1], pad[0]))
    return pads


def holes_of(drills: Drills) -> list[Hole]:
    """Every hole of a drill file, a slot by the middle of its run."""
    holes: list[Hole] = []
    for hole in drills.holes:
        x, y = hole.at
        if hole.end is not None:
            x, y = (x + hole.end[0]) / 2.0, (y + hole.end[1]) / 2.0
        holes.append((round(x, 4), round(y, 4), round(hole.diameter, 4)))
    holes.sort(key=lambda hole: (hole[1], hole[0]))
    return holes


def centroid(polygons) -> tuple[float, tuple[float, float]]:
    """The area of an island and its centroid: the outer contour less the
    holes inside it, whichever way round each is wound."""
    total = 0.0
    sx = 0.0
    sy = 0.0
    for index, contour in enumerate(polygons):
        area, x, y = _moments(contour)
        sign = 1.0 if index == 0 else -1.0
        total += sign * area
        sx += sign * area * x
        sy += sign * area * y
    if total <= 1e-12:
        return 0.0, (0.0, 0.0)
    return total, (sx / total, sy / total)


def _moments(contour) -> tuple[float, float, float]:
    """Unsigned area and centroid of one closed contour, by the shoelace."""
    twice = 0.0
    sx = 0.0
    sy = 0.0
    count = len(contour)
    for i in range(count):
        x0, y0 = contour[i]
        x1, y1 = contour[(i + 1) % count]
        cross = x0 * y1 - x1 * y0
        twice += cross
        sx += (x0 + x1) * cross
        sy += (y0 + y1) * cross
    if abs(twice) < 1e-12:
        return 0.0, 0.0, 0.0
    return abs(twice) / 2.0, sx / (3.0 * twice), sy / (3.0 * twice)


def nearest(points: list, to: Point) -> tuple[int, float] | None:
    """The index of the point nearest `to`, and how far; None of none."""
    best: tuple[int, float] | None = None
    for index, point in enumerate(points):
        distance = math.dist((point[0], point[1]), to)
        if best is None or distance < best[1]:
            best = (index, distance)
    return best


def tour(points: list, start: Point = (0.0, 0.0)) -> list[int]:
    """The indices in a short walk over the points: from the one nearest
    `start`, always on to the nearest not yet visited."""
    left = list(range(len(points)))
    order: list[int] = []
    here = start
    while left:
        index = min(left, key=lambda i: math.dist((points[i][0], points[i][1]), here))
        left.remove(index)
        order.append(index)
        here = (points[index][0], points[index][1])
    return order


def spread(points: list, count: int) -> list[int]:
    """The indices of at most `count` points spread over the whole set: the
    one nearest the middle first, then each time the point farthest from
    every one picked so far, so a few points still reach every corner."""
    if count >= len(points):
        return list(range(len(points)))
    if count <= 0 or not points:
        return []
    cx = sum(point[0] for point in points) / len(points)
    cy = sum(point[1] for point in points) / len(points)
    first = nearest(points, (cx, cy))
    assert first is not None
    chosen = [first[0]]
    distances = [math.dist((p[0], p[1]), (points[first[0]][0], points[first[0]][1])) for p in points]
    while len(chosen) < count:
        index = max(range(len(points)), key=lambda i: distances[i])
        if distances[index] <= 0.0:
            break
        chosen.append(index)
        for i, point in enumerate(points):
            distances[i] = min(distances[i], math.dist((point[0], point[1]), (points[index][0], points[index][1])))
    return chosen
