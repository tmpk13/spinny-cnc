"""A layer cut on its lines: strokes along their middles, fills round their edges."""

from __future__ import annotations

import math

from laser_sweep.gerber import Draw, Fill, Image

from spinny_laser import lines, order


def test_a_stroke_is_cut_along_its_middle_and_a_fill_round_its_edge():
    square = ((0.0, 0.0), (2.0, 0.0), (2.0, 2.0), (0.0, 2.0))
    hole = ((0.5, 0.5), (1.5, 0.5), (1.5, 1.5), (0.5, 1.5))
    image = Image(figures=[
        Draw(points=((10.0, 0.0), (12.0, 0.0), (12.0, 3.0)), width=0.15),
        Fill(parts=((True, square), (False, hole))),
        # A stroke that erases draws no line, nor does a lone point.
        Draw(points=((20.0, 0.0), (21.0, 0.0)), width=0.1, dark=False),
        Draw(points=((30.0, 0.0),), width=0.1),
    ])
    drawn = lines.drawn_lines(image)
    assert drawn[0] == [(10.0, 0.0), (12.0, 0.0), (12.0, 3.0)]
    assert drawn[1] == [*square, square[0]]
    assert drawn[2] == [*hole, hole[0]]
    assert len(drawn) == 3


def test_the_pieces_of_a_shape_are_cut_as_one_and_whats_inside_first():
    # A 10 mm square drawn a side at a time, the sides in no order and two
    # of them backwards, and a circle inside it drawn in two halves.
    sides = [
        [(10.0, 0.0), (10.0, 10.0)],
        [(0.0, 0.0), (10.0, 0.0)],
        [(0.0, 10.0), (10.0, 10.0)],
        [(0.0, 10.0), (0.0, 0.0)],
    ]
    half = [(5.0 + 2.0 * math.cos(t * math.pi / 8), 5.0 + 2.0 * math.sin(t * math.pi / 8)) for t in range(9)]
    other = [(5.0 + 2.0 * math.cos(t * math.pi / 8), 5.0 + 2.0 * math.sin(t * math.pi / 8)) for t in range(8, 17)]
    cut = lines.ordered([*sides, half, other])
    assert len(cut) == 2
    assert all(order.is_closed(path) for path in cut)
    # The circle, the hole in the part, before the square that frees it.
    assert max(math.dist(p, (5.0, 5.0)) for p in cut[0]) < 2.0 + 1e-9
    assert len(cut[1]) == 5
    assert {(round(x, 9), round(y, 9)) for x, y in cut[1]} == {(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)}


def test_open_lines_go_by_the_heads_travel():
    far = [(50.0, 0.0), (60.0, 0.0)]
    near = [(5.0, 0.0), (1.0, 0.0)]
    cut = lines.ordered([far, near])
    # The nearer one first, from its end nearer the axis.
    assert cut == [[(1.0, 0.0), (5.0, 0.0)], far]
