"""Simple milling operations: the bit clears what it is asked to, keeps off
every wall, and runs the way climb milling asks."""

from __future__ import annotations

import math

import pytest

from spinny_laser import mill

TOOL = 2.0
R = TOOL / 2.0


def segment_distance(p, a, b) -> float:
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    length = dx * dx + dy * dy
    t = 0.0 if length == 0.0 else max(0.0, min(1.0, ((p[0] - ax) * dx + (p[1] - ay) * dy) / length))
    return math.dist(p, (ax + t * dx, ay + t * dy))


def path_distance(p, path) -> float:
    if len(path) == 1:
        return math.dist(p, path[0])
    return min(segment_distance(p, a, b) for a, b in zip(path, path[1:]))


def signed_area(path) -> float:
    return 0.5 * sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(path, path[1:]))


def samples(xa, ya, xb, yb, step=0.25):
    nx = max(1, int(round((xb - xa) / step)))
    ny = max(1, int(round((yb - ya) / step)))
    return [(xa + (xb - xa) * i / nx, ya + (yb - ya) * j / ny) for i in range(nx + 1) for j in range(ny + 1)]


def test_drill_is_a_point_a_path():
    assert mill.drill([(1, 2), (3, 4)]) == [[(1.0, 2.0)], [(3.0, 4.0)]]
    with pytest.raises(mill.MillError):
        mill.drill([])


def test_line_closes_and_drops_repeats():
    (path,) = mill.line([(0, 0), (0, 0), (5, 0), (5, 5)], closed=True)
    assert path == [(0.0, 0.0), (5.0, 0.0), (5.0, 5.0), (0.0, 0.0)]
    with pytest.raises(mill.MillError):
        mill.line([(1, 1), (1, 1)])


def test_face_covers_the_rectangle_in_rows_back_and_forth():
    (path,) = mill.face(10, 0, 0, 7, TOOL, 0.5)
    rows = sorted({y for _, y in path})
    assert rows[0] == 0.0 and rows[-1] == 7.0
    assert max(b - a for a, b in zip(rows, rows[1:])) <= 0.5 * TOOL + 1e-9
    # Every point of the rectangle is under the bit at some time.
    assert all(path_distance(p, path) <= R + 1e-9 for p in samples(0, 0, 10, 7))
    # Back and forth: the second row starts where the first ended.
    assert path[0] == (0.0, 0.0) and path[1] == (10.0, 0.0) and path[2][0] == 10.0


@pytest.mark.parametrize("size", [(20.0, 8.0), (8.0, 20.0), (9.0, 9.0), (2.0, 6.0)])
@pytest.mark.parametrize("stepover", [0.4, 0.7, mill.MAX_POCKET_STEPOVER])
def test_pocket_clears_to_the_walls_and_no_further(size, stepover):
    w, h = size
    (path,) = mill.pocket_rect(5, 5, 5 + w, 5 + h, TOOL, stepover)
    # The bit's center keeps a radius off every wall.
    for x, y in path:
        assert 5 + R - 1e-9 <= x <= 5 + w - R + 1e-9
        assert 5 + R - 1e-9 <= y <= 5 + h - R + 1e-9
    # Everything inside, but the corners the bit's radius leaves, is cut.
    inner = samples(5 + R, 5 + R, 5 + w - R, 5 + h - R)
    assert all(path_distance(p, path) <= R + 1e-9 for p in inner)
    # The walls are finished: the last loop runs on them.
    tail = path[-5:]
    assert {round(x, 9) for x, _ in tail} == {5 + R, 5 + w - R}


def test_pocket_finishes_counterclockwise_when_climbing():
    (climb,) = mill.pocket_rect(0, 0, 12, 10, TOOL, 0.5, climb=True)
    (conventional,) = mill.pocket_rect(0, 0, 12, 10, TOOL, 0.5, climb=False)
    assert signed_area(climb[-5:]) > 0
    assert signed_area(conventional[-5:]) < 0


def test_pocket_narrower_than_the_bit_is_refused():
    with pytest.raises(mill.MillError, match="narrower than the bit"):
        mill.pocket_rect(0, 0, 1.5, 10, TOOL, 0.5)


def test_pocket_stepover_that_misses_the_corners_is_refused():
    with pytest.raises(mill.MillError, match="corners"):
        mill.pocket_rect(0, 0, 20, 20, TOOL, 0.9)


@pytest.mark.parametrize("diameter", [2.0, 3.0, 7.5, 20.0])
def test_circle_pocket_clears_the_circle(diameter):
    (path,) = mill.pocket_circle(3, -4, diameter, TOOL, 0.6)
    wall = diameter / 2 - R
    assert all(math.dist(p, (3, -4)) <= wall + 1e-9 for p in path)
    assert path[0] == (3, -4)
    if wall > 0:
        assert math.isclose(math.dist(path[-1], (3, -4)), wall, abs_tol=1e-9)
        inside = [p for p in samples(3 - wall, -4 - wall, 3 + wall, -4 + wall) if math.dist(p, (3, -4)) <= wall]
        assert all(path_distance(p, path) <= R + mill.DEFAULT_TOLERANCE + 1e-9 for p in inside)
    else:
        assert path == [(3, -4)]


def test_circle_narrower_than_the_bit_is_refused():
    with pytest.raises(mill.MillError, match="wider than the circle"):
        mill.pocket_circle(0, 0, 1.0, TOOL, 0.5)


def test_outside_profile_keeps_a_radius_off_the_part_with_sharp_corners():
    (path,) = mill.profile_rect(0, 0, 10, 6, TOOL, mill.OUTSIDE)
    assert path[0] == path[-1]
    for p in path:
        # The distance from the rectangle is the bit's radius everywhere.
        dx = max(0 - p[0], 0.0, p[0] - 10)
        dy = max(0 - p[1], 0.0, p[1] - 6)
        assert math.isclose(math.hypot(dx, dy), R, abs_tol=1e-9)
    # Climb runs clockwise around a part.
    assert signed_area(path) < 0
    (conventional,) = mill.profile_rect(0, 0, 10, 6, TOOL, mill.OUTSIDE, climb=False)
    assert signed_area(conventional) > 0


def test_inside_and_on_profiles():
    (inside,) = mill.profile_rect(0, 0, 10, 6, TOOL, mill.INSIDE)
    assert sorted({x for x, _ in inside}) == [R, 10 - R]
    assert signed_area(inside) > 0
    (on,) = mill.profile_rect(0, 0, 10, 6, TOOL, mill.ON)
    assert sorted({x for x, _ in on}) == [0, 10]
    with pytest.raises(mill.MillError):
        mill.profile_rect(0, 0, 1, 6, TOOL, mill.INSIDE)


@pytest.mark.parametrize(("side", "radius", "clockwise"), [(mill.OUTSIDE, 6.0, True), (mill.INSIDE, 4.0, False), (mill.ON, 5.0, True)])
def test_circle_profiles(side, radius, clockwise):
    (path,) = mill.profile_circle(1, 1, 10.0, TOOL, side)
    assert all(math.isclose(math.dist(p, (1, 1)), radius, abs_tol=1e-9) for p in path)
    assert (signed_area(path) < 0) == clockwise
    # The chords stay within the tolerance of the arc.
    a, b = path[0], path[1]
    middle = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
    assert radius - math.dist(middle, (1, 1)) <= mill.DEFAULT_TOLERANCE + 1e-12


def test_arguments_are_checked():
    with pytest.raises(mill.MillError, match="bit"):
        mill.face(0, 0, 1, 1, 0.0, 0.5)
    with pytest.raises(mill.MillError, match="stepover"):
        mill.face(0, 0, 1, 1, TOOL, 1.5)
    with pytest.raises(mill.MillError, match="side"):
        mill.profile_circle(0, 0, 5, TOOL, "beside")
