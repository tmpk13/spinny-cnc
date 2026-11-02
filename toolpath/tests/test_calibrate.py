from __future__ import annotations

import pytest

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


def test_the_depth_row_has_a_slot_per_depth():
    patches = depth([0.1, 0.2], length=10, gap=3, speed=8000, feed=120, origin=(1, 2))
    assert [(p.label, p.depth, p.power, p.speed) for p in patches] == [
        ("test depth 0.1 mm", 0.1, 8000, 120), ("test depth 0.2 mm", 0.2, 8000, 120),
    ]
    assert patches[1].paths == [[(1, 5), (11, 5)]]
    with pytest.raises(ValueError, match="above 0"):
        depth([0.0], length=10, gap=3, speed=8000, feed=120)
