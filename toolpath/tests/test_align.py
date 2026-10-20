"""The turn and shift that line a job up with the board."""

from __future__ import annotations

import math

import pytest

from spinny_laser.align import fit_rigid, turn, turned_paths


def moved(point, degrees, shift):
    x, y = turn(point, degrees)
    return (x + shift[0], y + shift[1])


def test_three_marks_recover_the_turn_and_the_shift():
    design = [(0.0, 0.0), (30.0, 0.0), (10.0, 20.0)]
    pairs = [(p, moved(p, -1.5, (0.31, -0.08))) for p in design]
    fit = fit_rigid(pairs)
    assert fit.rotation == pytest.approx(-1.5, abs=1e-6)
    assert fit.shift[0] == pytest.approx(0.31, abs=1e-6) and fit.shift[1] == pytest.approx(-0.08, abs=1e-6)
    assert fit.scale == pytest.approx(1.0, abs=1e-9) and fit.rms == pytest.approx(0.0, abs=1e-9)
    assert fit.marks == 3 and len(fit.residuals) == 3
    assert fit.apply((10.0, 20.0)) == pytest.approx(pairs[2][1])


def test_one_mark_is_a_shift_unless_an_angle_is_known():
    fit = fit_rigid([((5.0, 5.0), (6.0, 4.0))])
    assert (fit.rotation, fit.shift) == (0.0, (1.0, -1.0))
    known = fit_rigid([((10.0, 0.0), (0.0, 10.0))], angle=90.0)
    assert known.rotation == 90.0
    assert known.shift[0] == pytest.approx(0.0, abs=1e-9) and known.shift[1] == pytest.approx(0.0, abs=1e-9)


def test_a_stretched_or_mispaired_board_shows_in_the_scale_and_the_residuals():
    design = [(0.0, 0.0), (40.0, 0.0)]
    fit = fit_rigid([(design[0], (0.0, 0.0)), (design[1], (40.4, 0.0))])
    assert fit.scale == pytest.approx(1.01)
    # A scale is reported, never applied: the shift centers the error.
    assert fit.residuals == pytest.approx((0.2, 0.2))
    assert fit.rms == pytest.approx(0.2)


def test_marks_on_one_design_point_cannot_be_fitted():
    with pytest.raises(ValueError, match="two different"):
        fit_rigid([((1.0, 1.0), (0.0, 0.0)), ((1.0, 1.0), (5.0, 5.0))])
    with pytest.raises(ValueError, match="no marks"):
        fit_rigid([])
    with pytest.raises(ValueError, match="not a number"):
        fit_rigid([((math.nan, 0.0), (0.0, 0.0))])


def test_the_fit_reads_as_a_document_and_turns_paths():
    fit = fit_rigid([((0.0, 0.0), (1.0, 2.0)), ((10.0, 0.0), (1.0, 12.0))])
    doc = fit.to_dict()
    assert doc["rotation"] == pytest.approx(90.0) and doc["shift"] == pytest.approx([1.0, 2.0])
    assert doc["marks"] == 2 and doc["rms"] == 0.0 and doc["scale"] == 1.0
    turned = turned_paths([[(1.0, 0.0), (0.0, 1.0)]], 90.0)
    assert [value for path in turned for point in path for value in point] == pytest.approx([0.0, 1.0, -1.0, 0.0], abs=1e-12)
