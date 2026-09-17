"""The emitter: dialect, feed words, dark rotations, and where the beam lands."""

from __future__ import annotations

import math
import re

import pytest

from polar_sim import deviation, replay
from spinny_laser import gcode
from spinny_laser.gcode import INVERSE, SCALED, PathGroup, PolarOptions

WORD = re.compile(r"([A-Z])(-?\d*\.?\d+)")


def square(x: float, y: float, size: float):
    return [(x, y), (x + size, y), (x + size, y + size), (x, y + size), (x, y)]


def emit(paths, **kwargs):
    options = PolarOptions(**kwargs)
    group = PathGroup("test", paths, power=500.0, speed=400.0)
    return gcode.generate([group], options, ["test"])


def cut_lines(text: str) -> list[str]:
    return [line for line in text.splitlines() if line.startswith("G1 X")]


def test_header_and_footer_follow_the_dialect():
    job = emit([square(5.0, 5.0, 2.0)])
    lines = job.text.splitlines()
    assert lines[0].startswith("G21")
    assert lines[1].startswith("G90")
    assert lines[2].startswith("G94")
    assert lines[3] == "G1F1"
    assert lines[4] == "M4 S0"
    assert any(line.startswith("G93") for line in lines)
    tail = [line for line in lines if line.strip()][-4:]
    assert tail[0].startswith("M5")
    assert tail[1].startswith("G94")
    assert tail[2] == "G1F1"
    assert tail[3].startswith("G0 X0.000 A")


def test_every_inverse_cut_has_its_own_feed_and_first_has_power():
    job = emit([square(5.0, 5.0, 2.0)])
    cuts = cut_lines(job.text)
    assert all(" F" in line for line in cuts)
    assert cuts[0].count(" S") == 1
    assert all(" S" not in line for line in cuts[1:])
    assert job.text.count("M4 S0") == 2  # header and one path end


def test_scaled_mode_stays_in_g94_and_scales_feed():
    job = emit([square(5.0, 5.0, 2.0)], feed_mode=SCALED)
    assert "G93" not in job.text
    cuts = cut_lines(job.text)
    # A radial move covers the same joint distance as board distance.
    job2 = emit([[(5.0, 0.0), (7.0, 0.0)]], feed_mode=SCALED)
    line = cut_lines(job2.text)[0]
    assert re.search(r"F400\b", line)
    # A tangential move at radius 10 turns 5.73 degrees per mm, so F grows.
    job3 = emit([[(10.0, 0.0), (10.0, 0.1)]], feed_mode=SCALED)
    feed = float(WORD.findall(cut_lines(job3.text)[0])[-1][1])
    assert feed > 400.0
    assert cuts


def test_inverse_feed_is_speed_over_segment_length():
    job = emit([[(5.0, 0.0), (7.0, 0.0)]])
    line = cut_lines(job.text)[0]
    feed = float(dict(WORD.findall(line))["F"])
    assert feed == pytest.approx(400.0 / 2.0, rel=1e-3)


def test_angles_unwrap_across_the_seam():
    # A loop around the axis passes through 180 degrees; the angle must keep
    # counting instead of jumping from 180 to -180.
    circle = [
        (5.0 * math.cos(math.radians(a)), 5.0 * math.sin(math.radians(a)))
        for a in range(0, 361, 10)
    ]
    job = emit([circle])
    angles = [float(dict(WORD.findall(line))["A"]) for line in cut_lines(job.text)]
    steps = [b - a for a, b in zip(angles, angles[1:])]
    assert all(abs(step) < 30.0 for step in steps)
    assert angles[-1] == pytest.approx(360.0, abs=1e-3)
    assert job.total_rotation == pytest.approx(360.0, abs=0.5)


def test_return_home_takes_the_short_way_round():
    circle = [
        (5.0 * math.cos(math.radians(a)), 5.0 * math.sin(math.radians(a)))
        for a in range(0, 361, 10)
    ]
    job = emit([circle, circle, circle])
    last = job.text.strip().splitlines()[-1]
    assert last == "G0 X0.000 A1080.0000"


def test_invert_and_axis_offset_change_the_words():
    job = emit([[(5.0, 0.0), (0.0, 5.0)]], invert_rotary=True, axis_x=12.5)
    first = [line for line in job.text.splitlines() if line.startswith("G0 X")][0]
    assert first == "G0 X17.500 A0.0000"
    last_cut = cut_lines(job.text)[-1]
    assert "X17.500 A-90.0000" in last_cut


def test_rotation_on_the_axis_is_crossed_dark():
    job = emit([[(-2.0, 0.0), (2.0, 0.0)]])
    lines = [line for line in job.text.splitlines() if line and not line.startswith(";")]
    body = lines[lines.index("G93         ; Inverse time feed: F is segments per minute") + 1 :]
    # In to the axis under power, S0, a G0 turn, then back out under power.
    kinds = [line.split()[0] + ("S0" if line.endswith("S0") else "") for line in body[:9]]
    assert kinds[:1] == ["G0"]
    assert "M4S0" in kinds
    turn = [line for line in body if line.startswith("G0 X0.000 A")]
    assert turn, "no dark rotation on the axis"
    assert job.path_count == 2


@pytest.mark.parametrize("mode", [INVERSE, SCALED])
def test_replayed_beam_follows_the_board_geometry(mode):
    paths = [
        square(3.0, 3.0, 4.0),
        square(-8.0, 1.0, 2.0),
        [(6.0, -6.0), (-6.0, 6.0)],
        [(0.0, 0.0), (5.0, 1.0)],
    ]
    job = emit(paths, feed_mode=mode, tolerance=0.005)
    marks = replay(job.text)
    # The diagonal through the axis is split at the axis into two marks.
    assert len(marks) == len(paths) + 1
    flat = [point for path in paths for point in [path]]
    for mark in marks:
        best = min(deviation(mark, path) for path in flat)
        assert best <= 0.005 + 0.002


def test_replay_respects_axis_offset_and_inversion():
    paths = [square(3.0, 3.0, 4.0)]
    job = emit(paths, axis_x=20.0, invert_rotary=True)
    marks = replay(job.text, axis_x=20.0, invert=True)
    assert deviation(marks[0], paths[0]) <= 0.007


def test_axis_limits_lengthen_the_estimate_and_are_reported():
    # A tangential move at radius 2 needs 400 / (2 * pi / 180) deg per min.
    path = [(2.0, -1.0), (2.0, 1.0)]
    free = emit([path])
    bound = emit([path], rotary_max_rate=1000.0)
    assert bound.cut_seconds > free.cut_seconds
    assert bound.limited_length == pytest.approx(bound.cut_length)
    assert bound.peak_rotary_rate > 1000.0
    assert bound.slowest_speed is not None and bound.slowest_speed < 400.0
    assert free.limited_length == 0.0


def test_near_axis_paths_are_counted():
    job = emit([[(0.2, -1.0), (0.2, 1.0)], [(5.0, 0.0), (6.0, 0.0)]], min_radius=0.5)
    assert job.near_axis_paths == 1
    assert job.min_radius == pytest.approx(0.2)


def test_rejects_x_as_the_rotary_letter():
    with pytest.raises(ValueError):
        PolarOptions(rotary_axis="X")
