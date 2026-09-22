"""The streamer: marks land on the intended lines, axis crossings are turns."""

from __future__ import annotations

import math

import pytest
from polar_sim import deviation
from replay import board, parse, replay

from spinny_web.jobs import Group, Job
from spinny_web.kinematics import Rates, Streamer, coord, num, split_at_axis

TOLERANCE = 0.005
# Chord tolerance, two coordinate quanta, and the snap onto the axis.
SLACK = TOLERANCE + 0.002 + 0.0005


def job_of(*paths, power=500.0, speed=400.0, groups=None) -> Job:
    if groups is None:
        groups = [Group(label="g", power=power, speed=speed, paths=[list(p) for p in paths])]
    return Job(name="t", groups=groups)


def lines_of(streamer: Streamer, job: Job, start=(0.0, 0.0)) -> list[str]:
    return [piece.line for piece in streamer.job_pieces(job, start)]


def cuts(lines: list[str]) -> list[tuple[float, float]]:
    """Joint targets of the cut lines, with missing words carried forward."""
    joint = (0.0, 0.0)
    out = []
    for line in lines:
        keyword, words = parse(line)
        if keyword in ("cut", "go", "jogto"):
            joint = (words.get("R", joint[0]), words.get("A", joint[1]))
            if keyword == "cut":
                out.append(joint)
    return out


def test_number_formatting():
    assert num(400.0) == "400"
    assert num(12.5) == "12.5"
    assert num(-0.0001) == "0"
    assert coord(-0.0001, 3) == "0.000"
    assert coord(12.34567, 4) == "12.3457"


def test_square_around_the_axis_marks_the_square():
    streamer = Streamer(tolerance=TOLERANCE)
    square = [(-5.0, -5.0), (5.0, -5.0), (5.0, 5.0), (-5.0, 5.0), (-5.0, -5.0)]
    lines = lines_of(streamer, job_of(square))
    assert lines[0].startswith("go R")
    assert lines[1].startswith("cut R") and " F400 S500" in lines[1]
    assert all(" F" not in line for line in lines[2:])
    marks, final = replay(lines)
    assert len(marks) == 1
    assert deviation(marks[0], square) <= SLACK
    # The loop goes once round: a full turn of the table from where it started.
    _, first = parse(lines[0])
    assert first["A"] == -135.0
    assert abs(final[1] - (first["A"] + 360.0)) < 0.01
    assert len(lines) > 20


def test_cut_through_the_axis_is_radial_in_turn_radial_out():
    streamer = Streamer(tolerance=TOLERANCE)
    path = [(-5.0, 0.0), (5.0, 0.0)]
    lines = lines_of(streamer, job_of(path))
    turns = [line for line in lines if line.startswith("go A")]
    assert len(turns) == 1
    # A half turn either way lands at the far side.
    assert float(turns[0][4:]) % 360.0 == 0.0
    targets = cuts(lines)
    previous = (5.0, 180.0)
    for joint in targets:
        # A cut never changes the angle while on the axis.
        assert not (previous[0] < 1e-6 and joint[0] < 1e-6 and joint[1] != previous[1])
        previous = joint
    # Radial in to exactly zero, then radial out.
    radii = [r for r, _ in targets]
    assert 0.0 in radii
    axis = radii.index(0.0)
    assert radii[: axis + 1] == sorted(radii[: axis + 1], reverse=True)
    assert radii[axis:] == sorted(radii[axis:])
    marks, final = replay(lines)
    assert all(deviation(mark, path) <= SLACK for mark in marks)
    assert abs(final[0] - 5.0) < 1e-6


def test_near_miss_of_the_axis_is_snapped_to_a_turn():
    streamer = Streamer(tolerance=TOLERANCE)
    path = [(-4.0, 0.0002), (4.0, -0.0002)]
    lines = lines_of(streamer, job_of(path))
    assert sum(line.startswith("go A") for line in lines) == 1
    marks, _ = replay(lines)
    assert all(deviation(mark, path) <= SLACK for mark in marks)


def test_line_passing_close_but_not_snapped_still_holds_tolerance():
    streamer = Streamer(tolerance=TOLERANCE)
    path = [(-3.0, 0.02), (3.0, 0.02)]
    lines = lines_of(streamer, job_of(path))
    assert not any(line.startswith("go A") for line in lines)
    marks, _ = replay(lines)
    assert all(deviation(mark, path) <= SLACK for mark in marks)


def test_feed_and_power_written_once_per_group_and_after_rapids():
    streamer = Streamer(tolerance=TOLERANCE)
    groups = [
        Group(label="a", power=500, speed=400, paths=[[(10.0, 0.0), (12.0, 0.0)], [(10.0, 5.0), (12.0, 5.0)]]),
        Group(label="b", power=300, speed=200, paths=[[(10.0, -5.0), (12.0, -5.0)]]),
        Group(label="off", power=900, speed=100, enabled=False, paths=[[(1.0, 1.0), (2.0, 2.0)]]),
    ]
    lines = lines_of(streamer, job_of(groups=groups))
    with_fs = [line for line in lines if " F" in line]
    assert [line.split(" F")[1] for line in with_fs] == ["400 S500", "400 S500", "200 S300"]
    kinds = [line.split()[0] for line in lines]
    assert kinds.count("go") == 3
    assert not any("S900" in line for line in lines)
    for line in lines:
        keyword, words = parse(line)
        if keyword == "go":
            assert "R" in words and "A" in words


def test_start_angle_comes_from_the_machine():
    streamer = Streamer(tolerance=TOLERANCE)
    lines = lines_of(streamer, job_of([(10.0, 0.0), (10.0, 1.0)]), start=(3.0, 720.0))
    _, words = parse(lines[0])
    assert words["A"] == 720.0
    assert words["R"] == 10.0


def test_estimate_accounts_for_the_table_limit():
    streamer = Streamer(tolerance=TOLERANCE, rates=Rates(r_rate=1000.0, a_rate=1080.0))
    arc = [(2.0 * math.cos(math.radians(a)), 2.0 * math.sin(math.radians(a))) for a in range(0, 91, 5)]
    job = job_of(arc, speed=400.0)
    stats = streamer.estimate(job)
    # A quarter turn at 1080 deg/min is 5 s; the 2 mm rapid out is 0.12 s.
    assert abs(stats.seconds - (5.0 + 0.12)) < 0.2
    assert stats.limited_fraction > 0.99
    assert abs(stats.length_mm - math.pi) < 0.02
    assert abs(stats.max_radius - 2.0) < 1e-6 and abs(stats.min_radius - 2.0) < 0.01
    assert stats.moves == len([p for p in streamer.job_pieces(job, (0.0, 0.0))])

    radial = job_of([(20.0, 0.0), (25.0, 0.0)], speed=400.0)
    stats = streamer.estimate(radial)
    assert stats.limited_fraction == 0.0
    assert abs(stats.seconds - (5.0 / 400.0 * 60.0 + 20.0 / 1000.0 * 60.0)) < 1e-6
    assert stats.moves == 2


def test_estimate_of_an_empty_job():
    stats = Streamer().estimate(Job(name="empty"))
    assert stats.moves == 0 and stats.seconds == 0.0 and stats.length_mm == 0.0


def test_board_jog_through_the_axis_turns_on_the_spot():
    streamer = Streamer(tolerance=TOLERANCE)
    lines = streamer.board_jog((5.0, 0.0), -10.0, 0.0, feed=500.0)
    assert all(line.startswith("jogto ") and line.endswith(" F500") for line in lines)
    turns = [line for line in lines if line.startswith("jogto A")]
    assert len(turns) == 1 and abs(float(turns[0].split()[1][1:])) == 180.0
    marks, final = replay(lines, (5.0, 0.0))
    assert marks == []
    assert abs(final[0] - 5.0) < 1e-9 and abs(abs(final[1]) - 180.0) < 1e-9
    assert board(final) == pytest.approx((-5.0, 0.0), abs=1e-9)


def test_board_goto_without_feed_and_short_moves():
    streamer = Streamer(tolerance=TOLERANCE)
    lines = streamer.board_goto((0.0, 90.0), 0.0, 4.0)
    assert lines == ["jogto R4.000 A90.0000"]
    lines = streamer.board_goto((0.0, 0.0), 0.0, 4.0)
    assert lines == ["jogto A90.0000", "jogto R4.000 A90.0000"]
    assert streamer.board_goto((4.0, 90.0), 0.0, 4.0) == []
    marks, final = replay(streamer.board_goto((10.0, 0.0), 0.0, 10.0))
    assert abs(final[1] - 90.0) < 1e-9


def test_joint_jogs_pass_straight_through():
    streamer = Streamer()
    assert streamer.joint_jog(1.0, None) == "jog R1"
    assert streamer.joint_jog(None, -90.0) == "jog A-90"
    assert streamer.joint_jog(1.0, -90.0, 500.0) == "jog R1 A-90 F500"
    assert streamer.joint_jog(0.5, 0.0) == "jog R0.5"
    assert streamer.joint_goto(0.0, 0.0) == "jogto R0 A0"
    assert streamer.joint_goto(None, 45.0, 300.0) == "jogto A45 F300"
    with pytest.raises(ValueError):
        streamer.joint_jog(None, None)
    with pytest.raises(ValueError):
        streamer.joint_goto(-1.0, 0.0)


def test_cross_slide_lines_carry_z_alone():
    streamer = Streamer()
    assert streamer.slide_jog(0.05) == "jog Z0.05"
    assert streamer.slide_jog(-0.5, 60.0) == "jog Z-0.5 F60"
    assert streamer.slide_goto(0.0) == "jogto Z0"
    assert streamer.slide_goto(1.25, 120.0) == "jogto Z1.25 F120"
    # Rounded to the same resolution as a radius, and never a word beside R or A.
    assert streamer.slide_jog(0.1234) == "jog Z0.123"
    for line in (streamer.slide_jog(1.0), streamer.slide_goto(1.0)):
        assert "R" not in line and "A" not in line
    with pytest.raises(ValueError):
        streamer.slide_jog(0.0)


def test_split_at_axis():
    snap = 0.0005
    assert split_at_axis((1.0, 0.0), (2.0, 0.0), snap) == [(2.0, 0.0)]
    assert split_at_axis((1.0, 0.0), (-1.0, 0.0), snap) == [(0.0, 0.0), (-1.0, 0.0)]
    assert split_at_axis((0.0, 0.0), (-1.0, 0.0), snap) == [(-1.0, 0.0)]
    assert split_at_axis((1.0, 0.0), (0.0001, 0.0), snap) == [(0.0, 0.0)]


def test_rates_from_settings():
    assert Rates.from_settings({"r_rate": 800, "a_rate": "720"}) == Rates(800.0, 720.0)
    assert Rates.from_settings({}) == Rates()
    assert Rates.from_settings({"r_rate": 0}) == Rates()
