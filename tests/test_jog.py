"""spinny-jog: the rapids it prints move one thing at a time through grblHAL."""

from __future__ import annotations

import math

import pytest

from polar_sim import grblhal_joint
from spinny_laser import jog
from spinny_laser.jog import JogError, main


def joints(text: str):
    """The joint moves grblHAL makes for the printed lines, from angle 0."""
    angle = 0.0
    out = []
    for line in text.splitlines():
        if not line.startswith("G0"):
            continue
        words = dict((w[0], float(w[1:])) for w in line.split()[1:])
        radius, angle = grblhal_joint((words["X"], words["Y"]), angle)
        out.append((radius, angle))
    return out


def test_turn_is_pure_rotation_in_quarter_steps(capsys):
    assert main(["--from", "10,0", "turn", "270"]) == 0
    moves = joints(capsys.readouterr().out)
    assert len(moves) == 3
    assert [a for _, a in moves] == pytest.approx([90.0, 180.0, 270.0], abs=0.01)
    assert all(abs(r - 10.0) < 1e-3 for r, _ in moves)


def test_negative_turn_goes_the_other_way(capsys):
    main(["--from", "0,5", "turn", "-100"])
    moves = joints(capsys.readouterr().out)
    # From 90 degrees down to -10, in two steps of 50. Three decimal
    # coordinates at 5 mm radius place an angle to a few thousandths.
    assert [a for _, a in moves] == pytest.approx([40.0, -10.0], abs=0.01)


def test_a_half_turn_is_split_so_it_cannot_go_backwards(capsys):
    main(["--from", "10,0", "turn", "180"])
    out = capsys.readouterr().out
    assert "either way" not in out
    assert [a for _, a in joints(out)] == pytest.approx([90.0, 180.0], abs=0.01)


def test_turn_on_the_axis_is_refused(capsys):
    with pytest.raises(SystemExit):
        main(["--from", "0,0", "turn", "90"])
    assert "over the axis" in capsys.readouterr().err


def test_radius_keeps_the_direction(capsys):
    main(["--from", "3,4", "radius", "10"])
    out = capsys.readouterr().out
    assert "G0 X6.000 Y8.000" in out
    moves = joints(out)
    assert abs(moves[0][0] - 10.0) < 1e-3
    assert abs(moves[0][1] - math.degrees(math.atan2(4, 3))) < 0.01


def test_radius_from_the_axis_needs_an_angle(capsys):
    with pytest.raises(SystemExit):
        main(["radius", "10"])
    assert "--angle" in capsys.readouterr().err
    main(["radius", "10", "--angle", "0"])
    assert "G0 X10.000 Y0.000" in capsys.readouterr().out


def test_center_and_to_describe_the_motors(capsys):
    main(["--from", "10,0", "center"])
    out = capsys.readouterr().out
    assert "G0 X0.000 Y0.000" in out
    assert "radius 10.000 -> 0.000" in out
    main(["--from", "10,0", "to", "-10,0"])
    out = capsys.readouterr().out
    assert "either way" in out


def test_turn_helper_rejects_bad_steps():
    with pytest.raises(JogError):
        jog.turn((10.0, 0.0), 90.0, step=0)
    assert jog.turn((10.0, 0.0), 0.0) == []
