from __future__ import annotations

from spinny_laser.order import depths, inner_first, is_closed


def square(x: float, y: float, size: float) -> list[tuple[float, float]]:
    return [(x, y), (x + size, y), (x + size, y + size), (x, y + size), (x, y)]


def test_a_part_s_holes_and_marks_go_before_its_outline():
    outline = square(0.0, 0.0, 50.0)
    hole = square(10.0, 10.0, 5.0)
    slot_in_hole = square(11.0, 11.0, 1.0)
    mark = [(30.0, 30.0), (40.0, 30.0)]
    other_part = square(60.0, 0.0, 20.0)
    paths = [outline, other_part, hole, mark, slot_in_hole]
    assert depths(paths) == [0, 0, 1, 1, 2]
    assert inner_first(paths) == [slot_in_hole, hole, mark, outline, other_part]


def test_shapes_side_by_side_keep_their_order():
    paths = [square(0.0, 0.0, 5.0), [(20.0, 0.0), (30.0, 0.0)], square(10.0, 0.0, 5.0)]
    assert inner_first(paths) == paths


def test_a_shape_drawn_twice_does_not_hold_itself_and_open_paths_hold_nothing():
    twice = [square(0.0, 0.0, 5.0), square(0.0, 0.0, 5.0)]
    assert depths(twice) == [0, 0]
    # An open path around a square is no shape: the square stays at depth 0.
    almost = [(-1.0, -1.0), (9.0, -1.0), (9.0, 9.0), (-1.0, 9.0)]
    assert depths([almost, square(0.0, 0.0, 5.0)]) == [0, 0]
    assert not is_closed(almost) and is_closed(square(0.0, 0.0, 1.0))
    # A concave outline: the hole inside the L counts, the point in its notch does not.
    ell = [(0.0, 0.0), (20.0, 0.0), (20.0, 5.0), (5.0, 5.0), (5.0, 20.0), (0.0, 20.0), (0.0, 0.0)]
    inside = square(1.0, 1.0, 2.0)
    notch = square(10.0, 10.0, 2.0)
    assert depths([ell, inside, notch]) == [0, 1, 0]
