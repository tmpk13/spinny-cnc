"""Solder paste stencils: each opening cut out round its inside edge,
shrunk by the margin first."""

from __future__ import annotations

import math
import shutil
from pathlib import Path

import pytest
from laser_sweep import geom
from laser_sweep.gerber import CURVE_TOLERANCE

from spinny_laser import camjob, stencil

SPOT = 0.1
# A rounded offset is drawn in chords that fall inside the true arc, by up
# to 2.25 times the curve tolerance.
SLACK = 2.25 * CURVE_TOLERANCE + 1e-3
BOARD = Path(__file__).parent / "data" / "board.kicad_pcb"


def rect(x0: float, y0: float, x1: float, y1: float) -> list[tuple[float, float]]:
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


def circle(cx: float, cy: float, radius: float, count: int = 64) -> list[tuple[float, float]]:
    turn = 2 * math.pi / count
    return [(cx + radius * math.cos(turn * i), cy + radius * math.sin(turn * i)) for i in range(count)]


def turned(points, degrees: float, about=(0.0, 0.0)):
    c, s = math.cos(math.radians(degrees)), math.sin(math.radians(degrees))
    ox, oy = about
    return [(ox + (x - ox) * c - (y - oy) * s, oy + (x - ox) * s + (y - oy) * c) for x, y in points]


def box(path) -> tuple[float, float, float, float]:
    xs = [x for x, _ in path]
    ys = [y for _, y in path]
    return min(xs), min(ys), max(xs), max(ys)


def test_a_loop_runs_half_a_spot_inside_each_opening_shrunk_by_the_margin():
    cut = stencil.stencil([rect(0.0, 0.0, 1.0, 0.6), rect(2.0, 0.0, 2.4, 0.4)], SPOT, margin=0.05)
    assert cut.narrow == [] and cut.closed == []
    assert sorted(box(loop) for loop in cut.loops) == [
        pytest.approx((0.1, 0.1, 0.9, 0.5)),
        pytest.approx((2.1, 0.1, 2.3, 0.3)),
    ]
    assert all(loop[0] == loop[-1] for loop in cut.loops)
    assert cut.paths == cut.loops


@pytest.mark.parametrize(
    "shape, corners",
    [
        (rect(0.0, 0.0, 1.2, 0.5), 4),
        (circle(0.0, 0.0, 0.4), 0),
        (turned(rect(0.0, 0.0, 1.0, 0.3), 30.0), 4),
    ],
)
def test_the_beam_burns_inside_the_shrunk_opening_and_frees_all_of_it(shape, corners):
    margin = 0.04
    cut = stencil.stencil([shape], SPOT, margin=margin)
    (loop,) = cut.loops
    shrunk = geom.offset([shape], -margin)
    burnt = geom.stroke([loop], SPOT)
    # Nothing past the opening the margin leaves.
    assert geom.area(geom.difference(burnt, shrunk)) < SLACK * geom.area(shrunk)
    # The kerf's outer edge on the opening's edge: all of it drops out but
    # the corners sharper than the beam, r^2 (1 - pi/4) at a right angle.
    freed = geom.union(burnt, [loop[:-1]])
    radius = SPOT / 2
    left = geom.area(geom.difference(shrunk, freed))
    assert left == pytest.approx(corners * radius * radius * (1 - math.pi / 4), abs=SLACK * radius * 8)


def test_an_opening_narrower_than_the_spot_is_cut_along_its_middle():
    spot = 0.2
    # 0.15 wide and 0.7 long, turned about its middle.
    shape = turned(rect(-0.35, -0.075, 0.35, 0.075), 30.0)
    cut = stencil.stencil([[(x + 3.0, y + 1.0) for x, y in shape]], spot)
    assert cut.loops == [] and cut.closed == []
    (stroke,) = cut.narrow
    # Half a spot short of each end, so the burn ends where the opening does.
    ends = sorted(turned([(-0.25, 0.0), (0.25, 0.0)], 30.0))
    assert sorted(stroke) == [pytest.approx((x + 3.0, y + 1.0), abs=1e-6) for x, y in ends]


def test_an_opening_shorter_than_the_spot_is_a_quarter_spot_stroke_on_its_middle():
    spot = 0.2
    cut = stencil.stencil([circle(1.0, -2.0, 0.06)], spot)
    (stroke,) = cut.narrow
    assert math.dist(stroke[0], stroke[-1]) == pytest.approx(stencil.SHORTEST * spot, abs=1e-6)
    middle = ((stroke[0][0] + stroke[-1][0]) / 2, (stroke[0][1] + stroke[-1][1]) / 2)
    assert middle == pytest.approx((1.0, -2.0), abs=1e-3)


def test_a_margin_that_closes_an_opening_keeps_its_middle_apart():
    cut = stencil.stencil([rect(0.0, 0.0, 1.0, 0.2), rect(2.0, 0.0, 3.0, 1.0)], SPOT, margin=0.12)
    assert len(cut.loops) == 1 and cut.narrow == []
    (stroke,) = cut.closed
    # Along the middle of the opening as drawn.
    assert sorted(stroke) == [pytest.approx((0.05, 0.1), abs=1e-6), pytest.approx((0.95, 0.1), abs=1e-6)]
    assert stencil.stencil([rect(0.0, 0.0, 1.0, 0.2)], SPOT, margin=0.12).paths == []


def test_a_margin_that_parts_an_opening_cuts_each_part():
    # Two squares joined by a neck 0.2 wide.
    dumbbell = geom.union([rect(0.0, 0.0, 1.0, 1.0), rect(2.0, 0.0, 3.0, 1.0), rect(0.9, 0.4, 2.1, 0.6)])
    assert len(stencil.stencil(dumbbell, SPOT).loops) == 1
    parted = stencil.stencil(dumbbell, SPOT, margin=0.15)
    # Where the neck met a square, the loop keeps the beam's middle 0.2 from
    # the inside corners at y 0.4 and 0.6, a little bump toward the neck.
    bump = math.sqrt(0.2**2 - 0.1**2)
    assert sorted(box(loop) for loop in parted.loops) == [
        pytest.approx((0.2, 0.2, 1.0 - bump, 0.8), abs=SLACK),
        pytest.approx((2.0 + bump, 0.2, 2.8, 0.8), abs=SLACK),
    ]


def test_an_opening_round_an_island_of_film_is_cut_along_both_edges():
    ring = geom.difference([rect(0.0, 0.0, 2.0, 2.0)], [rect(0.5, 0.5, 1.5, 1.5)])
    cut = stencil.stencil(ring, SPOT, margin=0.05)
    assert sorted(box(loop) for loop in cut.loops) == [
        pytest.approx((0.1, 0.1, 1.9, 1.9)),
        pytest.approx((0.4, 0.4, 1.6, 1.6), abs=SLACK),
    ]


def test_no_paste_is_no_cut_and_bad_numbers_are_refused():
    assert stencil.stencil([], SPOT).paths == []
    with pytest.raises(ValueError, match="spot"):
        stencil.stencil([rect(0, 0, 1, 1)], 0.0)
    for margin in (-0.01, math.nan, math.inf):
        with pytest.raises(ValueError, match="margin"):
            stencil.stencil([rect(0, 0, 1, 1)], SPOT, margin=margin)
    with pytest.raises(ValueError, match="pace"):
        stencil.stencil([rect(0, 0, 1, 1)], SPOT, pace=0.0)


@pytest.mark.skipif(shutil.which("kicad-cli") is None, reason="kicad-cli not installed")
def test_a_board_paste_layer_is_cut_one_loop_an_opening():
    paste = camjob.read_board(BOARD, "F.Paste").copper
    openings = geom.islands(paste)
    cut = stencil.stencil(paste, SPOT, margin=0.05)
    assert len(cut.loops) == len(openings) == 32
    # Every loop inside its own pad, 0.5 x 1.5 mm with rounded corners,
    # shrunk by the margin and half the spot.
    assert {tuple(sorted((round(x1 - x0, 3), round(y1 - y0, 3)))) for x0, y0, x1, y1 in map(box, cut.loops)} == {(0.3, 1.3)}
    for loop in cut.loops:
        assert sum(geom.contains(piece, loop[0]) for piece in openings) == 1
