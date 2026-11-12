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

The camera pattern is a grid of dots a known pitch apart, for measuring a
camera's lens: a laser fills each dot (an IR or diode laser leaves a light
mark on anodized aluminum), a mill plunges once for each, or it is
printed from its SVG. The top right dot is left out, so a picture of it
tells which way it lies, turned or mirrored.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

Point = tuple[float, float]

# The most patches along a side, and the largest patch or slot, mm.
MAX_STEPS = 12
MAX_SIZE = 100.0
# The finest a material test's fill may be, mm: well under any beam's
# spot, and short of a pitch typed in the wrong unit.
MIN_PITCH = 0.01
# The most points a material test's fill may make in all: past any test a
# machine can cut, and short of a build that takes the backend minutes and
# a job file of hundreds of megabytes.
MAX_POINTS = 200_000


# The camera pattern: the most dots along a side, the pitch's bounds and
# the widest it may be, mm; how far a dot's outline may stray from a
# circle, mm; and the margin round it on the printed sheet, mm.
MAX_DOTS = 100
MIN_DOT_PITCH = 0.2
MAX_DOT_PITCH = 20.0
MAX_SPAN = 200.0
DOT_TOLERANCE = 0.005
SHEET_MARGIN = 5.0
# The width the printed sheet's words take, mm.
SHEET_TEXT = 70.0


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


def _rows(size: float, pitch: float) -> int:
    """How many lines a fill a pitch apart puts across a square."""
    return max(1, int(math.floor(size / pitch + 1e-9)) + 1)


def _hatch(x: float, y: float, size: float, pitch: float) -> list[Point]:
    """One path back and forth across the square, a pitch apart: the beam
    stays on along the short step between two lines."""
    lines = _rows(size, pitch)
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
    if fill and not MIN_PITCH <= pitch <= size:
        raise ValueError(f"the fill's pitch must be at least {MIN_PITCH:g} mm and at most the size")
    if fill:
        squares = len(powers) * len(speeds)
        points = squares * 2 * _rows(size, pitch)
        if points > MAX_POINTS:
            raise ValueError(
                f"a fill {pitch:g} mm apart over {squares} squares of {size:g} mm is {points} points, more than {MAX_POINTS}:"
                " give a wider pitch, or smaller or fewer squares"
            )
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


def dot_centers(columns: int, rows: int, pitch: float, origin: Point = (0.0, 0.0)) -> list[Point]:
    """The camera pattern's dots, the lower left one at `origin`, row by row
    from the bottom, every other row run backwards so the head goes the
    shortest way; the top right one left out."""
    if not (isinstance(columns, int) and isinstance(rows, int) and 2 <= columns <= MAX_DOTS and 2 <= rows <= MAX_DOTS):
        raise ValueError(f"the pattern has 2 to {MAX_DOTS} dots a side")
    if not MIN_DOT_PITCH <= pitch <= MAX_DOT_PITCH:
        raise ValueError(f"the dots' pitch must be {MIN_DOT_PITCH:g} to {MAX_DOT_PITCH:g} mm")
    if max(columns, rows) - 1 > MAX_SPAN / pitch + 1e-9:
        raise ValueError(f"the pattern must be at most {MAX_SPAN:g} mm across")
    centers = []
    for row in range(rows):
        for column in range(columns) if row % 2 == 0 else range(columns - 1, -1, -1):
            if (row, column) != (rows - 1, columns - 1):
                centers.append((round(origin[0] + column * pitch, 6), round(origin[1] + row * pitch, 6)))
    return centers


def _circle_sides(radius: float) -> int:
    """Corners enough for a circle's chords to stay within DOT_TOLERANCE of it."""
    if radius <= DOT_TOLERANCE:
        return 8
    return max(8, math.ceil(math.pi / math.acos(1.0 - DOT_TOLERANCE / radius)))


def filled_dot(center: Point, diameter: float, spot: float) -> list[Point]:
    """A laser's dot as one path: its outline half a spot inside the edge,
    then a spiral a spot apart in to the middle."""
    radius = diameter / 2.0 - spot / 2.0
    sides = _circle_sides(radius)
    cx, cy = center
    points = [(cx + radius * math.cos(2.0 * math.pi * i / sides), cy + radius * math.sin(2.0 * math.pi * i / sides)) for i in range(sides + 1)]
    turns = radius / spot
    steps = max(1, math.ceil(turns * sides))
    for i in range(1, steps + 1):
        part = i / steps
        angle = 2.0 * math.pi * turns * part
        points.append((cx + radius * (1.0 - part) * math.cos(angle), cy + radius * (1.0 - part) * math.sin(angle)))
    return [(round(x, 4), round(y, 4)) for x, y in points]


def dots(columns: int, rows: int, pitch: float, diameter: float, spot: float, power: float, speed: float, origin: Point = (0.0, 0.0)) -> list[Patch]:
    """The laser's camera pattern: every dot filled, all in one group."""
    if not spot < diameter < pitch:
        raise ValueError("a dot must be wider than the spot and narrower than the pitch")
    if not MIN_PITCH <= spot:
        raise ValueError(f"the spot must be at least {MIN_PITCH:g} mm")
    centers = dot_centers(columns, rows, pitch, origin)
    radius = diameter / 2.0 - spot / 2.0
    sides = _circle_sides(radius)
    points = len(centers) * (sides + 1 + max(1, math.ceil(radius / spot * sides)))
    if points > MAX_POINTS:
        raise ValueError(f"{len(centers)} dots of {diameter:g} mm filled {spot:g} mm apart are {points} points, more than {MAX_POINTS}: give fewer or smaller dots")
    paths = [filled_dot(center, diameter, spot) for center in centers]
    return [Patch(label="camera dots", power=power, speed=speed, paths=paths)]


def drilled_dots(columns: int, rows: int, pitch: float, cut: float, spindle: float, feed: float, origin: Point = (0.0, 0.0)) -> list[Patch]:
    """The mill's camera pattern: one plunge `cut` deep at every dot, the
    tool's own width the dot's."""
    if not cut > 0.0:
        raise ValueError("the dots' depth must be above 0")
    paths = [[center] for center in dot_centers(columns, rows, pitch, origin)]
    return [Patch(label="camera dots", power=spindle, speed=feed, paths=paths, depth=cut)]


def _mm(value: float) -> str:
    """A length for the sheet: four decimals at most, no trailing zeros."""
    text = f"{value:.4f}".rstrip("0").rstrip(".")
    return "0" if text in ("", "-0") else text


def dots_svg(columns: int, rows: int, pitch: float, diameter: float) -> str:
    """The camera pattern as a sheet to print at 100%: black dots on white,
    the top right one left out as on the machine, a 10 mm bar to check the
    print's scale against, and what it is in words under it."""
    centers = dot_centers(columns, rows, pitch)
    span_x, span_y = (columns - 1) * pitch, (rows - 1) * pitch
    width = max(span_x, SHEET_TEXT) + 2.0 * SHEET_MARGIN
    bar_y = span_y + 2.0 * SHEET_MARGIN
    height = bar_y + 10.0
    words = (
        f"{columns} x {rows} dots {_mm(pitch)} mm apart, {_mm(diameter)} mm across",
        "the top right one left out; the bar is 10 mm: print at 100%",
    )
    lines = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{_mm(width)}mm" height="{_mm(height)}mm" viewBox="0 0 {_mm(width)} {_mm(height)}">',
        f'<rect width="{_mm(width)}" height="{_mm(height)}" fill="#ffffff"/>',
        '<g fill="#000000">',
        *(f'<circle cx="{_mm(SHEET_MARGIN + x)}" cy="{_mm(SHEET_MARGIN + span_y - y)}" r="{_mm(diameter / 2.0)}"/>' for x, y in centers),
        "</g>",
        f'<path d="M {_mm(SHEET_MARGIN)} {_mm(bar_y)} h 10" stroke="#000000" stroke-width="0.3" fill="none"/>',
        *(
            f'<text x="{_mm(SHEET_MARGIN)}" y="{_mm(bar_y + 3.5 + 2.8 * i)}" font-family="sans-serif" font-size="2" fill="#000000">{line}</text>'
            for i, line in enumerate(words)
        ),
        "</svg>",
    ]
    return "\n".join(lines) + "\n"
