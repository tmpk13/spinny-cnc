from __future__ import annotations

import pytest

from spinny_laser import calibrate
from spinny_laser.calibrate import depth, ladder, material


def test_a_ladder_spans_both_ends_evenly():
    assert ladder(100, 1000, 4) == [100.0, 400.0, 700.0, 1000.0]
    assert ladder(5, 5, 1) == [5.0]
    for bad in (0, 13):
        with pytest.raises(ValueError):
            ladder(1, 2, bad)


def test_the_material_grid_has_a_square_per_power_and_speed():
    patches = material([100, 200], [300, 600, 900], size=5, gap=2, pitch=1, fill=True, origin=(10, 20))
    assert [p.label for p in patches[:3]] == ["test S100 F300", "test S200 F300", "test S100 F600"]
    # The top right square: the last power and speed, its corner two cells in.
    last = patches[-1]
    assert (last.power, last.speed) == (200, 900)
    xs, ys = zip(*last.paths[0])
    assert (min(xs), max(xs), min(ys), max(ys)) == (17, 22, 34, 39)
    # Filled a pitch apart: six lines across five millimeters, back and forth.
    assert len(last.paths[0]) == 12 and last.paths[0][1] == (22, 34) and last.paths[0][2] == (22, 35)
    outlined = material([100], [300], size=5, gap=2, pitch=1, fill=False)
    assert outlined[0].paths[0] == [(0, 0), (5, 0), (5, 5), (0, 5), (0, 0)]
    with pytest.raises(ValueError, match="pitch"):
        material([100], [300], size=5, gap=2, pitch=6, fill=True)


def test_a_material_fill_too_fine_or_too_big_is_refused_before_it_is_built():
    with pytest.raises(ValueError, match="the fill's pitch must be at least 0.01 mm and at most the size"):
        material([100], [300], size=100, gap=0, pitch=0.001, fill=True)
    # Twelve by twelve 100 mm squares 0.05 mm apart would be 576,288 points.
    with pytest.raises(ValueError, match=r"a fill 0.05 mm apart over 144 squares of 100 mm is 576288 points, more than 200000"):
        material([100] * 12, [300] * 12, size=100, gap=0, pitch=0.05, fill=True)
    # Outlined, the squares are a few points each whatever the pitch.
    assert len(material([100] * 12, [300] * 12, size=100, gap=0, pitch=0.001, fill=False)) == 144


def test_the_depth_row_has_a_slot_per_depth():
    patches = depth([0.1, 0.2], length=10, gap=3, speed=8000, feed=120, origin=(1, 2))
    assert [(p.label, p.depth, p.power, p.speed) for p in patches] == [
        ("test depth 0.1 mm", 0.1, 8000, 120), ("test depth 0.2 mm", 0.2, 8000, 120),
    ]
    assert patches[1].paths == [[(1, 5), (11, 5)]]
    with pytest.raises(ValueError, match="above 0"):
        depth([0.0], length=10, gap=3, speed=8000, feed=120)


def test_the_depth_row_runs_shallowest_first_whichever_way_it_was_asked():
    patches = depth([0.2, 0.1], length=10, gap=3, speed=8000, feed=120, origin=(1, 2))
    assert [(p.label, p.depth, p.paths[0][0]) for p in patches] == [("test depth 0.1 mm", 0.1, (1, 2)), ("test depth 0.2 mm", 0.2, (1, 5))]


def test_the_focus_ladder_has_a_line_per_step_lowest_first():
    patches = calibrate.focus_ladder([0.5, -0.5, 0.0], 8.0, 1.5, 300.0, 900.0, (2.0, 3.0))
    assert [patch.label for patch in patches] == ["test focus -0.5 mm", "test focus 0 mm", "test focus +0.5 mm"]
    assert [patch.focus for patch in patches] == [-0.5, 0.0, 0.5]
    assert patches[0].paths == [[(2.0, 3.0), (10.0, 3.0)]]
    assert patches[2].paths == [[(2.0, 6.0), (10.0, 6.0)]]
    assert all(patch.power == 300.0 and patch.speed == 900.0 and patch.depth is None for patch in patches)
    with pytest.raises(ValueError, match="gap must be above 0"):
        calibrate.focus_ladder([0.0], 8.0, 0.0, 300.0, 900.0)


def test_the_camera_dots_leave_the_top_right_one_out_and_snake_along_the_rows():
    assert calibrate.dot_centers(3, 2, 2.0, (10.0, 20.0)) == [(10.0, 20.0), (12.0, 20.0), (14.0, 20.0), (12.0, 22.0), (10.0, 22.0)]
    for args, message in (
        ((1, 5, 2.0), "the pattern has 2 to 100 dots a side"),
        ((5, 5, 0.1), "the dots' pitch must be 0.2 to 20 mm"),
        ((100, 5, 20.0), "the pattern must be at most 200 mm across"),
    ):
        with pytest.raises(ValueError, match=message):
            calibrate.dot_centers(*args)


def test_a_laser_dot_is_its_outline_then_a_spiral_in_to_its_middle():
    # The same numbers the page's mock gives (web/frontend/tests/calibrate.test.ts).
    dot = calibrate.filled_dot((0.0, 0.0), 0.6, 0.1)
    assert len(dot) == 57 and dot[:3] == [(0.25, 0.0), (0.231, 0.0957), (0.1768, 0.1768)] and dot[-1] == (0.0, 0.0)
    # The outline is a beam's half width inside the dot's edge and closed.
    assert dot[16] == (0.25, 0.0)
    assert all(abs((x * x + y * y) ** 0.5 - 0.25) < 1e-3 for x, y in dot[:17])
    patches = calibrate.dots(4, 3, 1.0, 0.4, 0.1, 300.0, 600.0)
    assert len(patches) == 1 and len(patches[0].paths) == 11 and patches[0].power == 300.0
    with pytest.raises(ValueError, match="wider than the spot"):
        calibrate.dots(4, 3, 1.0, 1.2, 0.1, 300.0, 600.0)
    with pytest.raises(ValueError, match="more than 200000"):
        calibrate.dots(100, 100, 2.0, 1.9, 0.01, 300.0, 600.0)


def test_a_mill_s_dots_are_plunges_and_the_sheet_is_at_true_size():
    patches = calibrate.drilled_dots(3, 3, 1.0, 0.05, 1000.0, 120.0)
    assert patches[0].depth == 0.05 and all(len(path) == 1 for path in patches[0].paths) and len(patches[0].paths) == 8
    svg = calibrate.dots_svg(3, 2, 2.0, 0.6)
    assert svg.startswith('<svg xmlns="http://www.w3.org/2000/svg" width="80mm" height="22mm" viewBox="0 0 80 22">')
    assert svg.count("<circle") == 5 and '<circle cx="5" cy="7" r="0.3"/>' in svg
    assert '<path d="M 5 12 h 10"' in svg

