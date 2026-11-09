"""Calibration test patterns, each patch a group of its own so the groups
table shows what it was cut with.

The material test is a laser's grid of squares, power rising to the right
and speed rising upward, each square filled with lines a spot apart (an
engraving test) or only outlined (a cut-through test): the patch that
marks the way wanted, or the first one cut through, names the power and
speed for that material. On a machine with no focus axis it is also the
focus and power test: the power ladder at one speed shows where the
beam starts to mark.

The depth test is a mill's row of slots, each a step deeper than the one
before, cut at one feed and spindle speed: what is left shows where the
tool reaches through the copper, and a measured slot against its number
how far the depth axis really moves.

The focus ladder is a laser's row of lines with a focus axis, each burnt
with the head a step higher or lower than focus at one power and speed:
the thinnest, sharpest line names the focus, and how fast the lines widen
on either side how much a board's warp matters.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

Point = tuple[float, float]

# The most patches along a side, and the largest patch or slot, mm.
MAX_STEPS = 12
MAX_SIZE = 100.0


@dataclass
class Patch:
    label: str
    power: float
    speed: float
    paths: list[list[Point]] = field(default_factory=list)
    # A mill's depth for the patch, mm below the surface; None for a laser.
    depth: float | None = None
    # A laser's height over focus for the patch, mm; None for none.
    focus: float | None = None


def ladder(first: float, last: float, count: int) -> list[float]:
    """`count` values from `first` to `last`, both ends included, evenly apart."""
    if not 1 <= count <= MAX_STEPS:
        raise ValueError(f"a ladder has 1 to {MAX_STEPS} steps")
    if not (math.isfinite(first) and math.isfinite(last)):
        raise ValueError("a ladder's ends must be numbers")
    if count == 1:
        return [float(first)]
    return [round(first + (last - first) * i / (count - 1), 6) for i in range(count)]


def _square(x: float, y: float, size: float) -> list[Point]:
    return [(x, y), (x + size, y), (x + size, y + size), (x, y + size), (x, y)]


def _hatch(x: float, y: float, size: float, pitch: float) -> list[Point]:
    """One path back and forth across the square, a pitch apart: the beam
    stays on along the short step between two lines."""
    lines = max(1, int(math.floor(size / pitch + 1e-9)) + 1)
    step = size / (lines - 1) if lines > 1 else 0.0
    points: list[Point] = []
    for i in range(lines):
        row = y + i * step
        ends = [(x, row), (x + size, row)]
        points.extend(ends if i % 2 == 0 else ends[::-1])
    return points


def material(
    powers: list[float],
    speeds: list[float],
    size: float,
    gap: float,
    pitch: float,
    fill: bool,
    origin: Point = (0.0, 0.0),
) -> list[Patch]:
    """The laser's grid: a column per power, a row per speed, the lower left
    corner at `origin`; slowest and weakest at that corner."""
    if not 0.0 < size <= MAX_SIZE:
        raise ValueError(f"size must be above 0 and at most {MAX_SIZE:g} mm")
    if not 0.0 <= gap <= MAX_SIZE:
        raise ValueError(f"gap must be 0 to {MAX_SIZE:g} mm")
    if fill and not 0.0 < pitch <= size:
        raise ValueError("the fill's pitch must be above 0 and at most the size")
    patches = []
    for row, speed in enumerate(speeds):
        for column, power in enumerate(powers):
            x = origin[0] + column * (size + gap)
            y = origin[1] + row * (size + gap)
            path = _hatch(x, y, size, pitch) if fill else _square(x, y, size)
            patches.append(Patch(label=f"test S{power:g} F{speed:g}", power=power, speed=speed, paths=[path]))
    return patches


def depth(depths: list[float], length: float, gap: float, speed: float, feed: float, origin: Point = (0.0, 0.0)) -> list[Patch]:
    """The mill's row: a slot `length` long along X per depth, `gap` apart in
    Y from `origin` up, shallowest first whatever order the depths come in,
    so the coupon reads the same way however the ladder was typed."""
    if not 0.0 < length <= MAX_SIZE:
        raise ValueError(f"length must be above 0 and at most {MAX_SIZE:g} mm")
    if not 0.0 < gap <= MAX_SIZE:
        raise ValueError(f"gap must be above 0 and at most {MAX_SIZE:g} mm")
    patches = []
    for i, cut in enumerate(sorted(depths)):
        if not cut > 0.0:
            raise ValueError("every depth must be above 0")
        y = origin[1] + i * gap
        patches.append(Patch(
            label=f"test depth {cut:g} mm",
            power=speed,
            speed=feed,
            paths=[[(origin[0], y), (origin[0] + length, y)]],
            depth=cut,
        ))
    return patches


def focus_label(focus: float) -> str:
    """A focus step as a label says it: +0.25 above focus, -0.5 below, 0 at it."""
    return "0" if focus == 0 else f"{focus:+g}"


def focus_ladder(
    focuses: list[float],
    length: float,
    gap: float,
    power: float,
    speed: float,
    origin: Point = (0.0, 0.0),
) -> list[Patch]:
    """The laser's row: a line `length` long along X per focus step, `gap`
    apart in Y from `origin` up, lowest first, each at `power` and `speed`."""
    if not 0.0 < length <= MAX_SIZE:
        raise ValueError(f"length must be above 0 and at most {MAX_SIZE:g} mm")
    if not 0.0 < gap <= MAX_SIZE:
        raise ValueError(f"gap must be above 0 and at most {MAX_SIZE:g} mm")
    patches = []
    for i, step in enumerate(sorted(focuses)):
        y = origin[1] + i * gap
        patches.append(Patch(
            label=f"test focus {focus_label(step)} mm",
            power=power,
            speed=speed,
            paths=[[(origin[0], y), (origin[0] + length, y)]],
            focus=step,
        ))
    return patches
