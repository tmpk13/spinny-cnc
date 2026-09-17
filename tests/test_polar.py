"""Kinematics: angles unwrap, segments subdivide to tolerance, the axis is handled."""

from __future__ import annotations

import math

import pytest

from spinny_laser import polar
from spinny_laser.polar import Kinematics


def test_unwrap_takes_the_short_way():
    assert polar.unwrap(10.0, 350.0) == pytest.approx(370.0)
    assert polar.unwrap(350.0, 10.0) == pytest.approx(-10.0)
    assert polar.unwrap(90.0, 720.0) == pytest.approx(810.0)


def test_angle_on_the_axis_keeps_the_previous_angle():
    assert polar.angle_of((0.0, 0.0), 123.0) == 123.0


def test_joint_round_trips():
    for point in [(3.0, 4.0), (-2.0, 0.5), (0.0, -7.0)]:
        joint = polar.joint_of(point, 0.0)
        back = polar.cartesian(joint)
        assert back == pytest.approx(point, abs=1e-9)


def test_radial_segment_is_one_move():
    pieces = polar.subdivide((1.0, 1.0), (5.0, 5.0), polar.joint_of((1.0, 1.0), 0.0), Kinematics())
    assert len(pieces) == 1
    assert pieces[0][1][1] == pytest.approx(45.0)


def _spiral_error(start, end, pieces):
    """Worst deviation of the joint-space polyline from the straight line."""
    worst = 0.0
    j0 = polar.joint_of(start, 0.0)
    for _, joint in pieces:
        for t in [i / 20.0 for i in range(21)]:
            along = polar.cartesian(
                (j0[0] + (joint[0] - j0[0]) * t, j0[1] + (joint[1] - j0[1]) * t)
            )
            dx, dy = end[0] - start[0], end[1] - start[1]
            length2 = dx * dx + dy * dy
            u = ((along[0] - start[0]) * dx + (along[1] - start[1]) * dy) / length2
            u = min(1.0, max(0.0, u))
            foot = (start[0] + dx * u, start[1] + dy * u)
            worst = max(worst, math.dist(along, foot))
        j0 = joint
    return worst


@pytest.mark.parametrize(
    "start,end",
    [
        ((10.0, -5.0), (10.0, 5.0)),
        ((-8.0, 2.0), (8.0, 2.0)),
        ((1.0, 0.2), (-1.0, 0.3)),
        ((20.0, 20.0), (21.0, 20.0)),
    ],
)
def test_subdivision_holds_the_tolerance(start, end):
    kin = Kinematics(tolerance=0.005)
    pieces = polar.subdivide(start, end, polar.joint_of(start, 0.0), kin)
    assert pieces[-1][0] == pytest.approx(end)
    assert _spiral_error(start, end, pieces) <= kin.tolerance * 1.05


def test_tighter_tolerance_means_more_segments():
    start, end = (10.0, -5.0), (10.0, 5.0)
    loose = polar.subdivide(start, end, polar.joint_of(start, 0.0), Kinematics(0.05))
    tight = polar.subdivide(start, end, polar.joint_of(start, 0.0), Kinematics(0.001))
    assert len(tight) > len(loose) >= 2


def test_through_the_axis_turns_on_the_spot():
    start, end = (-1.0, 0.0), (1.0, 0.0)
    pieces = polar.subdivide(start, end, polar.joint_of(start, 0.0), Kinematics())
    joints = [joint for _, joint in pieces]
    # In along the rail, turn half a turn at radius zero, out along the rail.
    assert joints[0][0] == pytest.approx(0.0)
    assert abs(joints[0][1]) == pytest.approx(180.0)
    assert joints[1][0] == pytest.approx(0.0)
    assert abs(joints[1][1] - joints[0][1]) == pytest.approx(180.0)
    assert joints[-1] == pytest.approx((1.0, joints[1][1]))
    assert len(joints) == 3


def test_leaving_the_axis_is_a_turn_then_a_radial_move():
    pieces = polar.subdivide((0.0, 0.0), (0.0, 3.0), (0.0, 0.0), Kinematics())
    joints = [joint for _, joint in pieces]
    assert joints == [pytest.approx((0.0, 90.0)), pytest.approx((3.0, 90.0))]


def test_closest_approach():
    assert polar.closest_approach((-1.0, 0.5), (1.0, 0.5)) == pytest.approx(0.5)
    assert polar.closest_approach((2.0, 0.0), (3.0, 0.0)) == pytest.approx(2.0)
    assert polar.path_min_radius([(2.0, 0.0), (3.0, 0.0), (0.0, 0.1)]) == pytest.approx(0.1, abs=1e-3)


def test_linear_resolution():
    # 200 steps, 16 microsteps, 100:1 gives 320000 steps a turn.
    steps_per_degree = 320000 / 360.0
    assert polar.linear_resolution(steps_per_degree, 50.0) == pytest.approx(0.00098, rel=0.01)
