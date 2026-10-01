"""Copper deposition: all the copper burnt, and nothing past its edge."""

from __future__ import annotations

import math
from pathlib import Path

import pytest
from laser_sweep import geom, gerber
from laser_sweep.gerber import CURVE_TOLERANCE, Draw, Fill, Image

from spinny_laser import deposit

SPOT = 0.1
# A rounded offset is drawn in chords that fall inside the true arc.
# Clipper rounds the number of chords a corner gets, so a corner one and a
# half chords long gets one, which falls inside by up to 2.25 times the
# curve tolerance.
SLACK = 2.25 * CURVE_TOLERANCE + 1e-3


def rect(x0: float, y0: float, x1: float, y1: float) -> list[tuple[float, float]]:
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


def circle(cx: float, cy: float, radius: float, count: int = 64) -> list[tuple[float, float]]:
    turn = 2 * math.pi / count
    return [(cx + radius * math.cos(turn * i), cy + radius * math.sin(turn * i)) for i in range(count)]


# Two pads with a trace three spots wide between them, a round pad, a pad
# with a hole, a sharp triangle, and pads whose widths are no whole number
# of spots, which the loops leave a strip down the middle of.
COPPER = geom.union(
    [
        rect(-1.6, 0.4, -0.9, 1.2),
        rect(0.9, 0.4, 1.6, 1.2),
        rect(-0.9, 0.65, 0.9, 0.95),
        circle(0.9, -0.9, 0.37),
        rect(-1.9, -1.7, -0.7, -0.5),
        [(1.4, -1.7), (2.6, -1.7), (1.6, -1.1)],
        rect(-0.4, -1.7, 0.07, 0.1),
        rect(-0.3, 1.5, 1.3, 1.67),
    ]
)
HOLE = circle(-1.3, -1.1, 0.2)[::-1]
COPPER = geom.difference(COPPER, [HOLE])


def spans(polygons, y: float) -> list[tuple[float, float]]:
    """The x intervals of a row inside the polygons, nonzero winding."""
    crossings = []
    for contour in polygons:
        for (x0, y0), (x1, y1) in zip(contour, contour[1:] + contour[:1]):
            if (y0 <= y < y1) or (y1 <= y < y0):
                crossings.append((x0 + (y - y0) * (x1 - x0) / (y1 - y0), 1 if y1 > y0 else -1))
    crossings.sort()
    out, winding, start = [], 0, 0.0
    for x, turn in crossings:
        if winding == 0:
            start = x
        winding += turn
        if winding == 0:
            out.append((start, x))
    return out


def grid(polygons, step: float):
    """Points on a grid inside the polygons."""
    x0, y0, _, y1 = geom.bounds(polygons)
    y = y0 + step / 2
    while y < y1:
        for a, b in spans(polygons, y):
            x = x0 + step * math.ceil((a - x0) / step)
            while x <= b:
                yield (x, y)
                x += step
        y += step


def distance_to(point, a, b) -> float:
    ax, ay = a
    dx, dy = b[0] - ax, b[1] - ay
    length = dx * dx + dy * dy
    t = 0.0 if length == 0.0 else max(0.0, min(1.0, ((point[0] - ax) * dx + (point[1] - ay) * dy) / length))
    return math.hypot(point[0] - (ax + t * dx), point[1] - (ay + t * dy))


class Segments:
    """Segments bucketed on a grid, for the nearest one within a cell."""

    def __init__(self, paths, cell: float) -> None:
        self.cell = cell
        self.buckets: dict[tuple[int, int], list] = {}
        for path in paths:
            for a, b in zip(path, path[1:]):
                for i in range(math.floor(min(a[0], b[0]) / cell) - 1, math.floor(max(a[0], b[0]) / cell) + 2):
                    for j in range(math.floor(min(a[1], b[1]) / cell) - 1, math.floor(max(a[1], b[1]) / cell) + 2):
                        self.buckets.setdefault((i, j), []).append((a, b))

    def distance(self, point) -> float:
        key = (math.floor(point[0] / self.cell), math.floor(point[1] / self.cell))
        return min((distance_to(point, a, b) for a, b in self.buckets.get(key, [])), default=math.inf)


def along(contours, step: float):
    """Points round the contours, no further apart than the step."""
    for contour in contours:
        for a, b in zip(contour, contour[1:] + contour[:1]):
            count = max(1, math.ceil(math.dist(a, b) / step))
            for i in range(count):
                yield (a[0] + (b[0] - a[0]) * i / count, a[1] + (b[1] - a[1]) * i / count)


def check_covers(paths, area, spot: float = SPOT, points=None) -> None:
    """Every point of the area, or the points given, is within half a spot of a path."""
    index = Segments(paths, spot)
    missed = [p for p in points or grid(area, spot / 3.1) if index.distance(p) > spot / 2 + SLACK]
    assert not missed, f"{len(missed)} points left, first {missed[:3]}"


def check_inside(paths, copper, spot: float = SPOT) -> None:
    """Every beam center is half a spot inside the copper."""
    edge = Segments([contour + contour[:1] for contour in copper], spot)
    for path in paths:
        for a, b in zip(path, path[1:]):
            for t in (0.0, 0.5):
                point = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
                assert any(lo <= point[0] <= hi for lo, hi in spans(copper, point[1])), f"{point} is off the copper"
                assert edge.distance(point) >= spot / 2 - SLACK, f"{point} is within half a spot of the edge"


def reach(copper, spot: float = SPOT):
    """The copper a beam held inside it can burn: none of the corners
    sharper than the beam, nor a strip narrower than it."""
    return geom.offset(geom.offset(copper, -spot / 2), spot / 2 - SLACK)


@pytest.mark.parametrize("fill", deposit.FILLS)
def test_every_fill_burns_the_copper_and_nothing_past_its_edge(fill):
    burn = deposit.deposit(COPPER, SPOT, fill)
    assert burn.offsets == [SPOT / 2]
    assert len(burn.edges) == 1 and burn.edges[0] and burn.fill and not burn.thin
    check_inside(burn.paths, COPPER)
    check_covers(burn.paths, reach(COPPER))


def test_the_edge_loop_runs_half_a_spot_inside_every_outline():
    burn = deposit.deposit(COPPER, SPOT)
    (loops,) = burn.edges
    # One loop round each piece of copper and one round the hole.
    assert len(loops) == len(geom.offset(COPPER, -SPOT / 2))
    edge = Segments([contour + contour[:1] for contour in COPPER], SPOT)
    for loop in loops:
        assert loop[0] == loop[-1]
        for point in loop:
            assert edge.distance(point) == pytest.approx(SPOT / 2, abs=SLACK)


def test_more_passes_give_more_edge_loops_before_the_fill():
    for fill in (deposit.CONTOUR, "radial"):
        burn = deposit.deposit(COPPER, SPOT, fill, passes=3)
        assert burn.offsets == pytest.approx([0.05, 0.15, 0.25])
        assert all(burn.edges)
        check_inside(burn.paths, COPPER)
        check_covers(burn.paths, reach(COPPER))


def test_a_pitch_under_the_spot_packs_the_loops_closer():
    burn = deposit.deposit(COPPER, SPOT, passes=2, pitch=0.06)
    assert burn.offsets == pytest.approx([0.05, 0.11])
    check_covers(burn.paths, reach(COPPER))


PADS = [rect(-1.2, -0.4, -0.5, 0.4), rect(1.5, 0.4, 2.2, 1.2)]
TRACE = [(-0.85, 0.0), (1.0, 0.0), (1.85, 0.8)]


def test_a_trace_narrower_than_the_spot_is_burnt_along_its_middle():
    copper = geom.union(PADS + geom.stroke([TRACE], 0.07))
    burn = deposit.deposit(copper, SPOT, centers=[TRACE])
    # The pads have their loops; the trace has none, only its middle.
    assert len(burn.edges[0]) == 2
    assert burn.thin
    on_trace = Segments([TRACE], SPOT)
    for path in burn.thin:
        for point in path:
            assert on_trace.distance(point) < 1e-5
    # Its ends run on into the pads, to the band the loops burn.
    check_covers(burn.paths, geom.union(reach(copper) + geom.stroke([TRACE], 0.07)))


def test_a_trace_as_wide_as_the_spot_is_burnt_once_along_its_middle():
    line = [(-0.85, 0.0), (1.85, 0.0)]
    copper = geom.union([rect(-1.2, -0.4, -0.5, 0.4), rect(1.5, -0.4, 2.2, 0.4)] + geom.stroke([line], SPOT))
    burn = deposit.deposit(copper, SPOT, centers=[line])
    assert len(burn.edges[0]) == 2
    (middle,) = burn.thin
    assert all(abs(y) < 1e-5 for _, y in middle)
    check_covers(burn.paths, geom.union(reach(copper) + geom.stroke([line], SPOT)))


def test_a_trace_as_wide_as_the_spot_is_followed_round_a_bend():
    # A square bend leaves a speck of the trace wider than the spot on its
    # inside, which gets a loop of its own; the middle line runs on through
    # it rather than stopping where the loop's band begins.
    bend = [(-0.85, 0.0), (1.0, 0.0), (1.0, 1.5)]
    copper = geom.union([rect(-1.2, -0.4, -0.5, 0.4), rect(0.6, 1.4, 1.4, 2.1)] + geom.stroke([bend], SPOT))
    burn = deposit.deposit(copper, SPOT, centers=[bend])
    assert len(burn.edges[0]) == 3
    check_covers(burn.paths, geom.union(reach(copper) + geom.stroke([bend], SPOT)))


def test_a_board_drawn_with_traces_as_wide_as_the_spot_is_burnt_whole():
    # Where a trace runs into a pad, the band the pad's loop burns curves
    # away from the trace's sides, so a middle line that stopped at its edge
    # left a sliver of the trace on each side, too thin for a grid to find:
    # the trace's own edges are checked as well.
    image = gerber.read(Path(__file__).parent / "data" / "board-F_Cu.gbr")
    copper = geom.copper(image)
    strokes = [figure for figure in image.figures if isinstance(figure, Draw)]
    spot = strokes[0].width
    assert all(figure.width == spot for figure in strokes)
    burn = deposit.deposit(copper, spot, centers=deposit.centerlines(image))
    assert len(burn.thin) == len(strokes)
    traces = geom.union([part for figure in strokes for part in geom.stroke([list(figure.points)], spot)])
    check_inside([path for loops in burn.edges for path in loops] + burn.fill, copper, spot)
    check_covers(burn.paths, geom.union(reach(copper, spot) + traces), spot)
    check_covers(burn.paths, traces, spot, along(traces, spot / 20))


def test_a_trace_wider_than_the_spot_has_loops_and_no_middle_line():
    copper = geom.union(PADS + geom.stroke([TRACE], 0.25))
    burn = deposit.deposit(copper, SPOT, centers=[TRACE])
    assert not burn.thin
    check_inside(burn.paths, copper)
    check_covers(burn.paths, reach(copper))


def test_a_stroke_cut_away_by_clear_copper_is_not_followed_across_the_cut():
    gap = rect(0.2, -0.3, 0.3, 0.3)
    copper = geom.difference(geom.union(PADS + geom.stroke([TRACE], 0.07)), [gap])
    burn = deposit.deposit(copper, SPOT, centers=[TRACE])
    assert burn.thin
    for path in burn.thin:
        for a, b in zip(path, path[1:]):
            assert max(a[0], b[0]) <= 0.2 + 1e-5 or min(a[0], b[0]) >= 0.3 - 1e-5


def test_centerlines_are_the_dark_strokes_of_the_layer():
    image = Image(
        figures=[
            Draw(((0.0, 0.0), (1.0, 0.0)), width=0.1),
            Fill(((True, ((0.0, 0.0), (1.0, 0.0), (1.0, 1.0))),)),
            Draw(((0.0, 1.0), (1.0, 1.0)), width=0.1, dark=False),
            Draw(((2.0, 0.0),), width=0.1),
        ]
    )
    assert deposit.centerlines(image) == [[(0.0, 0.0), (1.0, 0.0)]]


def test_no_copper_burns_nothing_and_bad_settings_are_refused():
    empty = deposit.deposit([], SPOT)
    assert empty.paths == [] and empty.edges == []
    with pytest.raises(ValueError, match="fill"):
        deposit.deposit(COPPER, SPOT, "zigzag")
    with pytest.raises(ValueError, match="spot"):
        deposit.deposit(COPPER, 0.0)
    with pytest.raises(ValueError, match="passes"):
        deposit.deposit(COPPER, SPOT, passes=0)
    with pytest.raises(ValueError, match="pitch"):
        deposit.deposit(COPPER, SPOT, pitch=0.2)
