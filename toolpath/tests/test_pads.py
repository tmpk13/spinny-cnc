"""Pads and holes read from a layer, and the orders they are visited in."""

from __future__ import annotations

import math

import pytest
from laser_sweep import excellon, gerber

from spinny_laser.pads import centroid, holes_of, nearest, pads_of, spread, tour

HEADER = "%FSLAX46Y46*%\n%MOMM*%\n%ADD10C,1.000000*%\n%ADD11R,2.000000X1.000000*%\n%ADD12C,0.200000*%\n%LPD*%\n"


def layer(body: str) -> gerber.Image:
    return gerber.parse(HEADER + body + "M02*\n")


def test_flashes_are_pads_and_strokes_and_regions_are_not():
    image = layer(
        "D10*\nX10000000Y5000000D03*\nX10000000Y8000000D03*\n"
        "D11*\nX20000000Y5000000D03*\n"
        "D12*\nX0Y0D02*\nX30000000Y0D01*\n"
        "G36*\nX40000000Y0D02*\nX60000000Y0D01*\nX60000000Y20000000D01*\nX40000000Y20000000D01*\nX40000000Y0D01*\nG37*\n"
    )
    pads = pads_of(image)
    assert [(x, y) for x, y, _ in pads] == [(10.0, 5.0), (20.0, 5.0), (10.0, 8.0)]
    assert pads[1][2] == pytest.approx(2.0, abs=1e-3)
    assert pads[0][2] == pytest.approx(math.pi / 4.0, rel=0.02)
    # The region is a pour as far as a pad list is concerned, unless asked for.
    assert len(pads_of(image, max_area=1000.0)) == 4


def test_flashes_that_touch_are_one_pad():
    image = layer("D10*\nX10000000Y5000000D03*\nX10500000Y5000000D03*\n")
    pads = pads_of(image)
    assert len(pads) == 1
    assert pads[0][0] == pytest.approx(10.25, abs=0.01) and pads[0][1] == pytest.approx(5.0, abs=0.01)


def test_a_centroid_discounts_the_holes():
    outer = [(0.0, 0.0), (4.0, 0.0), (4.0, 2.0), (0.0, 2.0)]
    hole = [(3.0, 0.5), (3.5, 0.5), (3.5, 1.5), (3.0, 1.5)]
    area, (x, y) = centroid([outer, hole])
    assert area == pytest.approx(7.5)
    # The hole on the right pulls the centroid left of 2.
    assert x == pytest.approx((8.0 * 2.0 - 0.5 * 3.25) / 7.5) and y == pytest.approx(1.0)
    assert centroid([list(reversed(outer)), hole])[1][0] == pytest.approx(x)


def test_holes_come_from_the_drill_file_a_slot_by_its_middle():
    drills = excellon.parse("M48\nMETRIC\nT1C0.800\n%\nT1\nX12.0Y5.0\nX10.0Y5.0\nX20.0Y7.0G85X24.0Y7.0\nM30\n")
    holes = holes_of(drills)
    assert holes == [(10.0, 5.0, 0.8), (12.0, 5.0, 0.8), (22.0, 7.0, 0.8)]


def test_a_tour_walks_to_the_nearest_point_each_time():
    points = [(10.0, 0.0), (0.0, 0.0), (1.0, 0.0), (11.0, 0.0)]
    assert tour(points) == [1, 2, 0, 3]
    assert tour(points, start=(12.0, 0.0)) == [3, 0, 2, 1]
    assert tour([]) == []


def test_a_spread_reaches_every_corner_first():
    points = [(x, y) for x in range(0, 50, 5) for y in range(0, 50, 5)]
    chosen = spread(points, 5)
    assert len(chosen) == 5 and len(set(chosen)) == 5
    picked = [points[i] for i in chosen]
    # One of the points about the middle first, then the four corners in some order.
    assert picked[0] in {(20, 20), (25, 25), (20, 25), (25, 20)}
    assert set(picked[1:]) == {(0, 0), (45, 45), (0, 45), (45, 0)}
    assert spread(points, 1000) == list(range(len(points)))
    assert spread(points, 0) == []


def test_nearest_names_the_point_and_the_distance():
    assert nearest([(0.0, 0.0, 1.0), (3.0, 4.0, 1.0)], (3.0, 3.0)) == (1, 1.0)
    assert nearest([], (0.0, 0.0)) is None
