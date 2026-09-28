"""Copper clearing: nothing kept is touched, and nothing else is missed."""

from __future__ import annotations

import math

import pytest
from laser_sweep import geom
from laser_sweep.gerber import CURVE_TOLERANCE

from spinny_laser import clear

SPOT = 0.1
KEEP = SPOT / 2.0
# A rounded offset is drawn in chords that fall inside the true arc by up
# to the curve tolerance, the isolation loops' own included.
SLACK = CURVE_TOLERANCE + 1e-3


def square(cx: float, cy: float, half: float) -> list[tuple[float, float]]:
    return [(cx - half, cy - half), (cx + half, cy - half), (cx + half, cy + half), (cx - half, cy + half)]


def pad(cx: float, cy: float, radius: float, count: int = 48) -> list[tuple[float, float]]:
    turn = 2 * math.pi / count
    return [(cx + radius * math.cos(turn * i), cy + radius * math.sin(turn * i)) for i in range(count)]


# Two pads with a trace between them, and a round pad; the axis lies in the
# cleared area, not on copper.
COPPER = [
    square(-1.5, 0.8, 0.4),
    square(1.5, 0.8, 0.4),
    [(-1.5, 0.7), (1.5, 0.7), (1.5, 0.9), (-1.5, 0.9)],
    pad(0.9, -0.9, 0.35),
]
BOARD = [(-2.6, -1.8), (2.6, -1.8), (2.6, 1.8), (-2.6, 1.8), (-2.6, -1.8)]


def samples(paths, step: float = 0.02):
    """Points along every segment, ends included."""
    for path in paths:
        for a, b in zip(path, path[1:]):
            count = max(1, math.ceil(math.dist(a, b) / step))
            for i in range(count + 1):
                t = i / count
                yield (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)


class Segments:
    """Segments bucketed on a grid, for the nearest one to a point."""

    def __init__(self, paths, cell: float) -> None:
        self.cell = cell
        self.buckets: dict[tuple[int, int], list] = {}
        for path in paths:
            for a, b in zip(path, path[1:]):
                x0, x1 = sorted((a[0], b[0]))
                y0, y1 = sorted((a[1], b[1]))
                for i in range(math.floor(x0 / cell) - 1, math.floor(x1 / cell) + 2):
                    for j in range(math.floor(y0 / cell) - 1, math.floor(y1 / cell) + 2):
                        self.buckets.setdefault((i, j), []).append((a, b))

    def distance(self, point) -> float:
        key = (math.floor(point[0] / self.cell), math.floor(point[1] / self.cell))
        near = self.buckets.get(key, [])
        return min((clear._segment_distance(point, a, b) for a, b in near), default=math.inf)


def check_keeps_clear(strokes, copper, keep, frame) -> None:
    near = geom.offset(copper, keep - SLACK)
    inside = geom.offset(frame, SLACK)
    for point in samples(strokes):
        assert not clear._inside(near, point), f"{point} is within {keep} of copper"
        assert clear._inside(inside, point), f"{point} is outside the perimeter"


def check_covers(strokes, copper, keep, board) -> None:
    """Every point of the board that the isolation does not burn is within
    half a spot of a stroke, a hair from the edge excepted."""
    burnt = geom.offset(copper, keep + SPOT / 2.0 + 2e-3)
    area = geom.offset(board, -SPOT / 4.0)
    index = Segments(strokes, SPOT)
    x0, y0, x1, y1 = geom.bounds(board)
    step = SPOT / 3.1
    missed = []
    y = y0
    while y <= y1:
        x = x0
        while x <= x1:
            point = (x, y)
            if clear._inside(area, point) and not clear._inside(burnt, point):
                if index.distance(point) > SPOT / 2.0 + 2e-3:
                    missed.append(point)
            x += step
        y += step
    assert not missed, f"{len(missed)} points left, first {missed[:3]}"


@pytest.mark.parametrize("pattern", clear.PATTERNS)
def test_every_pattern_clears_the_board_and_leaves_the_copper(pattern):
    strokes = clear.clear(COPPER, KEEP, SPOT, pattern, outline=[BOARD])
    assert strokes
    frame = clear.perimeter(COPPER, KEEP, SPOT, [BOARD])
    check_keeps_clear(strokes, COPPER, KEEP, frame)
    check_covers(strokes, COPPER, KEEP, [BOARD[:-1]])


@pytest.mark.parametrize("pattern", clear.PATTERNS)
def test_without_an_outline_the_rectangle_the_isolation_spans_is_cleared(pattern):
    strokes = clear.clear(COPPER, KEEP, SPOT, pattern)
    x0, y0, x1, y1 = geom.bounds(COPPER)
    reach = KEEP + SPOT / 2.0
    x0, y0, x1, y1 = x0 - reach, y0 - reach, x1 + reach, y1 + reach
    box = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    check_keeps_clear(strokes, COPPER, KEEP, clear.perimeter(COPPER, KEEP, SPOT, None))
    check_covers(strokes, COPPER, KEEP, [box])


def test_more_isolation_loops_push_the_clearing_further_out():
    keep = SPOT / 2.0 + 2 * SPOT
    strokes = clear.clear(COPPER, keep, SPOT, clear.RADIAL, outline=[BOARD])
    check_keeps_clear(strokes, COPPER, keep, clear.perimeter(COPPER, keep, SPOT, [BOARD]))
    check_covers(strokes, COPPER, keep, [BOARD[:-1]])


def test_a_cutout_in_the_board_is_left_alone():
    hole = [(-0.8, -1.4), (-0.2, -1.4), (-0.2, -0.8), (-0.8, -0.8), (-0.8, -1.4)]
    strokes = clear.clear(COPPER, KEEP, SPOT, clear.RINGS, outline=[BOARD, hole])
    # The beam stays half a spot outside the cutout's edge.
    inner = geom.offset([hole[:-1]], SPOT / 2.0 - SLACK)
    assert not any(clear._inside(inner, p) for p in samples(strokes))
    assert any(-0.9 < x < -0.1 and -1.5 < y < -0.7 for x, y in samples(strokes))


def test_an_open_outline_falls_back_to_the_rectangle():
    open_edge = [(-2.6, -1.8), (2.6, -1.8), (2.6, 1.8)]
    assert clear.perimeter(COPPER, KEEP, SPOT, [open_edge]) == clear.perimeter(COPPER, KEEP, SPOT, None)


def pieces(path):
    """An outline as a board file plots one drawn with lines: a stroke per
    side, out of order, some drawn backwards, and one end a hair off."""
    sides = [[a, b] for a, b in zip(path, path[1:])]
    sides = sides[2:] + sides[:2]
    sides[1] = sides[1][::-1]
    x, y = sides[0][-1]
    sides[0][-1] = (x + 4e-4, y - 3e-4)
    return sides


def same_area(a, b) -> bool:
    # The end a hair off tilts one side of the board by as much.
    return geom.area(geom.difference(a, b)) + geom.area(geom.difference(b, a)) < 0.01


def test_an_outline_drawn_as_separate_pieces_is_joined():
    frame = clear.perimeter(COPPER, KEEP, SPOT, pieces(BOARD))
    assert same_area(frame, clear.perimeter(COPPER, KEEP, SPOT, [BOARD]))
    strokes = clear.clear(COPPER, KEEP, SPOT, clear.LINES, outline=pieces(BOARD))
    check_keeps_clear(strokes, COPPER, KEEP, frame)
    check_covers(strokes, COPPER, KEEP, [BOARD[:-1]])


def test_a_cutout_beside_an_outline_of_pieces_stays_a_cutout():
    # With the board's pieces left unjoined, the cutout was the only closed
    # path and the whole clearing landed inside it.
    hole = [(-2.4, -1.6), (-1.9, -1.6), (-1.9, -1.1), (-2.4, -1.1), (-2.4, -1.6)]
    outline = pieces(BOARD) + [hole]
    frame = clear.perimeter(COPPER, KEEP, SPOT, outline)
    assert same_area(frame, clear.perimeter(COPPER, KEEP, SPOT, [BOARD, hole]))
    strokes = clear.clear(COPPER, KEEP, SPOT, clear.RADIAL, outline=outline)
    inner = geom.offset([hole[:-1]], SPOT / 2.0 - SLACK)
    assert not any(clear._inside(inner, p) for p in samples(strokes))
    check_covers(strokes, COPPER, KEEP, geom.difference([BOARD[:-1]], [hole[:-1]]))


def test_a_closed_cutout_alone_is_not_taken_for_the_board():
    open_edge = [(-2.6, -1.8), (2.6, -1.8), (2.6, 1.8)]
    hole = [(-2.4, -1.6), (-1.9, -1.6), (-1.9, -1.1), (-2.4, -1.1), (-2.4, -1.6)]
    box = clear.perimeter(COPPER, KEEP, SPOT, None)
    assert clear.perimeter(COPPER, KEEP, SPOT, [open_edge, hole]) == box
    assert clear.perimeter(COPPER, KEEP, SPOT, [hole]) == box


def test_pieces_join_however_they_branch():
    # Three pieces meet at the origin; the chain goes on along one of them
    # and the rest are left as they are, every piece used once.
    spokes = [[(0.0, 0.0), (1.0, 0.0)], [(0.0, 0.0), (0.0, 1.0)], [(-1.0, 0.0), (0.0, 0.0)]]
    joined = clear.chains(spokes)
    assert sum(len(chain) - 1 for chain in joined) == 3
    assert clear.chains([[(0.0, 0.0), (1.0, 0.0)], [(1.0, 0.0), (0.0, 0.0)]]) == [
        [(0.0, 0.0), (1.0, 0.0), (0.0, 0.0)]
    ]
    square_pieces = pieces(BOARD)
    (loop,) = clear.chains(square_pieces)
    assert loop[0] == loop[-1] and len(loop) == 5


def test_ring_arcs_hold_their_radius_and_turn_each_way_in_turn():
    strokes = clear.clear(COPPER, KEEP, SPOT, clear.RINGS, outline=[BOARD])
    frame = clear.perimeter(COPPER, KEEP, SPOT, [BOARD])
    edge_count = len(clear.edge(frame, geom.offset(COPPER, KEEP), (0.0, 0.0)))
    arcs = strokes[: len(strokes) - edge_count]
    radii = []
    for arc in arcs:
        r = math.hypot(*arc[0])
        assert all(math.hypot(*p) == pytest.approx(r, abs=1e-9) for p in arc)
        radii.append((round(r, 6), clear._sweep(arc) > 0))
    # Going out ring by ring, and each ring turns the other way to the last.
    seen = []
    for radius, ccw in radii:
        if not seen or seen[-1][0] != radius:
            seen.append((radius, ccw))
        else:
            assert seen[-1][1] == ccw
    assert [r for r, _ in seen] == sorted(r for r, _ in seen)
    assert all(a[1] != b[1] for a, b in zip(seen, seen[1:]))
    assert all(b[0] - a[0] <= SPOT + 1e-9 for a, b in zip(seen, seen[1:]))


def test_ring_chords_stay_within_half_the_tolerance():
    for radius in (0.05, 1.0, 20.0):
        points = clear.ring_points(radius, 0.005)
        chord = math.dist(points[0], points[1])
        sagitta = radius - math.sqrt(radius * radius - chord * chord / 4.0)
        assert sagitta <= 0.0025 + 1e-12
        assert points[0] == points[-1]


def test_spokes_are_radial_and_alternate_out_and_in():
    strokes = clear.clear(COPPER, KEEP, SPOT, clear.RADIAL, outline=[BOARD])
    frame = clear.perimeter(COPPER, KEEP, SPOT, [BOARD])
    edge_count = len(clear.edge(frame, geom.offset(COPPER, KEEP), (0.0, 0.0)))
    spokes = strokes[: len(strokes) - edge_count]
    outward = []
    for start, end in spokes:
        assert math.atan2(start[1], start[0]) == pytest.approx(math.atan2(end[1], end[0]), abs=1e-6)
        outward.append(math.hypot(*end) > math.hypot(*start))
    assert any(outward) and not all(outward)


# Areas to lay spokes over: about the axis, long and narrow across it, with
# a notch, and off to one side.
SPOKE_AREAS = {
    "disc": [pad(0.0, 0.0, 17.0, 256)],
    "strip": [[(-6.0, -0.8), (6.0, -0.8), (6.0, 0.8), (-6.0, 0.8)]],
    "notched": [[(-2.0, -2.0), (2.0, -2.0), (2.0, -0.2), (0.3, -0.2), (0.3, 0.2), (2.0, 0.2), (2.0, 2.0), (-2.0, 2.0)]],
    "aside": [square(5.0, 1.0, 1.5)],
    "speck": [square(0.0, 0.0, 0.15)],
}


def spoke_plan(area):
    """The profile, wedges, angles and start radii the fill lays spokes by."""
    _, reach = clear.radial_extent(area)
    wedges = max(8, math.ceil(2 * math.pi * (reach + SPOT) / SPOT))
    far = clear.far_profile(area, wedges)
    angles = clear.spoke_angles(far, SPOT)
    levels = clear.spoke_levels(len(angles), reach, SPOT)
    inner = [clear.spoke_inner(angles, i, levels, SPOT) for i in range(len(angles))]
    return reach, far, angles, inner


def reach_between(far, low: float, high: float) -> float:
    width = 2 * math.pi / len(far)
    return max(far[k % len(far)] for k in range(math.floor(low / width), math.floor(high / width) + 1))


@pytest.mark.parametrize("name", SPOKE_AREAS)
def test_spokes_are_never_more_than_a_pitch_apart_where_the_area_reaches(name):
    reach, far, angles, inner = spoke_plan(SPOKE_AREAS[name])
    for step in range(1, 200):
        radius = SPOT / 2.0 + (reach - SPOT / 2.0) * step / 200.0
        present = [i for i in range(len(angles)) if inner[i] <= radius]
        assert present
        for a, b in zip(present, present[1:] + present[:1]):
            gap = (angles[b] - angles[a]) % (2 * math.pi) or 2 * math.pi
            if radius <= reach_between(far, angles[a], angles[a] + gap):
                assert gap * radius <= SPOT * (1 + 1e-9), (radius, angles[a], gap)


def test_the_far_profile_is_how_far_the_area_reaches_in_each_wedge():
    far = clear.far_profile(SPOKE_AREAS["strip"], 360)
    # A wedge reaches farthest at its side further from square to the edge
    # it meets: up the strip at 91 degrees, along it at 1.
    assert far[90] == pytest.approx(0.8 / math.cos(math.radians(1.0)), rel=1e-9)
    assert far[0] == pytest.approx(6.0 / math.cos(math.radians(1.0)), rel=1e-9)
    assert max(far) == pytest.approx(math.hypot(6.0, 0.8), rel=1e-9)
    # Off to one side the far side of the circle holds nothing.
    aside = clear.far_profile(SPOKE_AREAS["aside"], 360)
    assert aside[180] == 0.0 and aside[10] > 6.0


def test_spokes_are_as_sparse_as_a_narrow_board_allows():
    """Across a strip the spokes only have to reach its edge, so there are
    fewer of them than a circle through its corners would need."""
    strip = SPOKE_AREAS["strip"]
    _, _, angles, _ = spoke_plan(strip)
    corner = math.hypot(6.0, 0.8)
    assert len(angles) < 0.5 * 2 * math.pi * corner / SPOT
    across = [b - a for a, b in zip(angles, angles[1:]) if abs(math.cos(a)) < 0.05]
    along = [b - a for a, b in zip(angles, angles[1:]) if abs(math.sin(a)) < 0.01]
    assert min(across) > 5 * max(along)


@pytest.mark.parametrize(
    "board",
    [
        [(-6.0, -1.8), (6.0, -1.8), (6.0, 1.8), (-6.0, 1.8), (-6.0, -1.8)],
        [(-2.6, -1.8), (8.0, -1.8), (8.0, -1.0), (2.6, -1.0), (2.6, 1.8), (-2.6, 1.8), (-2.6, -1.8)],
    ],
    ids=["strip", "ell"],
)
def test_shaped_spokes_clear_a_long_or_bent_board(board):
    strokes = clear.clear(COPPER, KEEP, SPOT, clear.RADIAL, outline=[board])
    frame = clear.perimeter(COPPER, KEEP, SPOT, [board])
    check_keeps_clear(strokes, COPPER, KEEP, frame)
    check_covers(strokes, COPPER, KEEP, [board[:-1]])


def ray(degrees: float, low: float, high: float):
    c, s = math.cos(math.radians(degrees)), math.sin(math.radians(degrees))
    return [(low * c, low * s), (high * c, high * s)]


def test_travel_order_takes_the_end_the_head_reaches_first():
    # From the axis the inner end of the spoke at 10 degrees is nearest;
    # its outer end is then beside the outer end of the one at 11.
    strokes = [ray(11.0, 1.0, 5.0), ray(200.0, 0.5, 5.0), ray(10.0, 0.5, 5.0)]
    ordered = clear.by_travel(strokes, clear.DEFAULT_PACE)
    assert ordered[0] == strokes[2]
    assert ordered[1] == strokes[0][::-1]
    assert ordered[2] == strokes[1]
    assert sorted(map(sorted, ordered)) == sorted(map(sorted, strokes))


def test_travel_order_weighs_the_table_by_its_pace():
    # A slow table favours a longer run along the rail over a turn, and a
    # fast one the turn.
    strokes = [ray(0.0, 1.0, 2.0), ray(0.0, 5.0, 6.0), ray(10.0, 2.0, 3.0)]
    slow = clear.by_travel(strokes, 1.4)
    fast = clear.by_travel(strokes, 0.1)
    assert slow[1] == strokes[1]
    assert fast[1] == strokes[2]


def swept_in_turn(spokes):
    """The spokes by angle, out and in in strict turn: once round."""
    swept = []
    outward = True
    for stroke in sorted(spokes, key=lambda p: (round(clear._angle(p[0]), 9), min(map(math.hypot, *zip(*p))))):
        if (math.hypot(*stroke[0]) > math.hypot(*stroke[-1])) == outward:
            stroke = stroke[::-1]
        swept.append(stroke)
        outward = not outward
    return swept


@pytest.mark.parametrize("half", [2.0, 5.0, 14.0])
def test_spokes_travel_no_more_than_once_round_in_turn(half):
    spokes = clear.spokes([square(0.0, 0.0, half)], SPOT)
    once_round = clear.travel(swept_in_turn(spokes), clear.DEFAULT_PACE)
    assert clear.travel(spokes, clear.DEFAULT_PACE) <= once_round
    if half > 10.0:
        # Many sets of spokes: going once round, the rail would run back
        # from every short spoke's end to the next long one's.
        assert clear.travel(spokes, clear.DEFAULT_PACE) < 0.7 * once_round


def test_a_sweep_turns_each_spoke_to_meet_the_one_before():
    # Out along the first, in along the second from beside where the first
    # ends, and out along the short third, whose inner end is the nearer.
    spokes = [[ray(0.0, 0.5, 2.0)], [ray(1.0, 0.5, 2.0)], [ray(2.0, 1.0, 2.0)]]
    order = clear.sweep(spokes, clear.DEFAULT_PACE)
    assert order == [spokes[0][0], spokes[1][0][::-1], spokes[2][0]]


def test_copper_that_covers_the_board_leaves_nothing_to_clear():
    everything = [square(0.0, 0.0, 3.0)]
    assert clear.clear(everything, KEEP, SPOT, clear.RADIAL, outline=[BOARD]) == []


def test_refuses_what_it_cannot_do():
    with pytest.raises(ValueError, match="pattern"):
        clear.clear(COPPER, KEEP, SPOT, "zigzag")
    with pytest.raises(ValueError, match="pitch"):
        clear.clear(COPPER, KEEP, SPOT, clear.LINES, pitch=2 * SPOT)
    with pytest.raises(ValueError):
        clear.clear(COPPER, KEEP, SPOT, clear.RADIAL, pace=0.0)
    assert clear.clear([], KEEP, SPOT, clear.LINES) == []
