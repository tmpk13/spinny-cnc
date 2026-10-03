"""The emitter: dialect, feed words, dark rotations, and where the beam lands."""

from __future__ import annotations

import contextlib
import math
import re
import signal

import pytest

from polar_sim import deviation, replay, replay_grblhal
from spinny_laser import gcode
from spinny_laser.gcode import GRBLHAL, INVERSE, JOINT, SCALED, PathGroup, PolarOptions

WORD = re.compile(r"([A-Z])(-?\d*\.?\d+)")


def square(x: float, y: float, size: float):
    return [(x, y), (x + size, y), (x + size, y + size), (x, y + size), (x, y)]


def emit(paths, **kwargs):
    """A joint-controller job, the mode every option below applies to."""
    kwargs.setdefault("controller", JOINT)
    options = PolarOptions(**kwargs)
    group = PathGroup("test", paths, power=500.0, speed=400.0)
    return gcode.generate([group], options, ["test"])


def emit_grblhal(paths, **kwargs):
    options = PolarOptions(controller=GRBLHAL, **kwargs)
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


def test_scaled_mode_writes_each_segments_own_feed():
    # F is modal in G94: written on the first segment only, every later
    # segment ran at the first one's scaling instead of its own.
    job = emit([[(5.0, 0.0), (7.0, 0.0), (7.0, 0.5)]], feed_mode=SCALED, rotary_scale=2.0)
    cuts = cut_lines(job.text)
    assert len(cuts) >= 2 and all(" F" in line for line in cuts)
    feeds = [float(dict(WORD.findall(line))["F"]) for line in cuts]
    assert feeds[0] == pytest.approx(400.0)
    # A tangential move at radius 7 turns 8.2 degrees per mm, weighted twice.
    turn = math.degrees(0.5 / 7.0)
    assert feeds[-1] == pytest.approx(400.0 * math.hypot(0.0, 2.0 * turn) / 0.5, rel=0.02)


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


@pytest.mark.parametrize("letter", ["S", "F", "M", "G", "N", "s", "I", "P"])
def test_rejects_a_rotary_letter_that_is_not_an_axis(letter):
    # Under S the angle became the laser power, under N a line number.
    with pytest.raises(ValueError, match="axis letter"):
        PolarOptions(controller=JOINT, rotary_axis=letter)


@pytest.mark.parametrize("rate", ["x_rapid", "rotary_rapid", "x_max_rate", "rotary_max_rate"])
def test_rejects_a_negative_axis_rate(rate):
    # A negative rapid rate gave a negative travel time, and a negative
    # limit was taken as no limit.
    with pytest.raises(ValueError, match="cannot be negative"):
        PolarOptions(**{rate: -1.0})
    # 0 is the way to ask for no limit.
    assert getattr(PolarOptions(**{rate: 0.0}), rate) == 0.0


def test_a_rotary_letter_is_any_other_axis_in_either_case():
    for letter in "ABCUVWYZ":
        assert PolarOptions(rotary_axis=letter).rotary_axis == letter
    job = emit([[(5.0, 0.0), (5.0, 1.0)]], rotary_axis="b")
    assert job.options.rotary_axis == "B"
    assert all(" B" in line for line in cut_lines(job.text))


# --- grblHAL polar kinematics: the controller transforms, the file is X/Y ---


def test_grblhal_is_the_default_and_writes_board_xy_in_g94():
    job = gcode.generate(
        [PathGroup("t", [square(5.0, 5.0, 2.0)], 500.0, 400.0)], PolarOptions(), ["t"]
    )
    assert job.options.controller == GRBLHAL
    assert "G93" not in job.text
    cuts = cut_lines(job.text)
    assert all(re.fullmatch(r"G1 X-?\d+\.\d{3} Y-?\d+\.\d{3}( S[\d.]+ F\d+)?", c) for c in cuts)
    assert cuts[0].endswith(" S500.00 F400")
    assert all(" F" not in c for c in cuts[1:])
    motion = [l for l in job.text.splitlines() if l.startswith("G0 ") or l.startswith("G1 X")]
    assert all(" A" not in l for l in motion)
    assert job.text.strip().endswith("G0 X0.000 Y0.000")


def test_grblhal_presplits_where_the_controllers_pieces_would_stray():
    # At 1 mm radius a 0.5 mm piece strays 30 microns; at 40 mm it is fine.
    near = emit_grblhal([[(1.0, -0.5), (1.0, 0.5)]])
    far = emit_grblhal([[(40.0, -0.5), (40.0, 0.5)]])
    assert len(cut_lines(near.text)) >= 4
    assert len(cut_lines(far.text)) == 1
    lengths = []
    x, y = 1.0, -0.5
    for line in cut_lines(near.text):
        words = dict(WORD.findall(line))
        nx, ny = float(words["X"]), float(words["Y"])
        lengths.append(math.dist((x, y), (nx, ny)))
        x, y = nx, ny
    assert max(lengths) < 0.5


def test_grblhal_leaves_the_axis_through_a_tiny_hop():
    job = emit_grblhal([[(-2.0, 0.0), (2.0, 0.0)]])
    body = [l for l in job.text.splitlines() if l and not l.startswith(";")]
    assert "G0 X0.002 Y0.000" in body
    hop = body.index("G0 X0.002 Y0.000")
    assert body[hop - 1] == "M4 S0"
    assert body[hop + 2].startswith("G1 X2.000 Y0.000 S500.00 F400")
    assert job.path_count == 2


def test_grblhal_hop_direction_survives_rounding():
    # Leaving the axis at 11 degrees: the hop rounds to a point at some other
    # angle, and the cut has to be re-split from there to stay on the line.
    path = [(0.0, 0.0), (5.0, 1.0)]
    job = emit_grblhal([path])
    marks = replay_grblhal(job.text)
    assert len(marks) == 1
    assert deviation(marks[0], path) <= 0.005 + 0.002


def test_grblhal_refuses_an_axis_offset():
    with pytest.raises(ValueError):
        PolarOptions(controller=GRBLHAL, axis_x=5.0)


def test_grblhal_replay_follows_the_board_geometry():
    paths = [
        square(3.0, 3.0, 4.0),
        square(-8.0, 1.0, 2.0),
        square(0.4, -0.6, 1.2),
        [(6.0, -6.0), (-6.0, 6.0)],
        [(0.0, 0.0), (5.0, 1.0)],
    ]
    job = emit_grblhal(paths, tolerance=0.005)
    marks = replay_grblhal(job.text)
    assert len(marks) == len(paths) + 1
    for mark in marks:
        assert min(deviation(mark, path) for path in paths) <= 0.005 + 0.002


def test_without_presplitting_the_controller_would_miss():
    # The same near-axis square through grblHAL's own 0.5 mm pieces alone.
    raw = "G94\nM4 S0\nG0 X0.400 Y-0.600\nG1 X1.600 Y-0.600 S500 F400\nG1 X1.600 Y0.600\nG1 X0.400 Y0.600\nG1 X0.400 Y-0.600\nM4 S0\nM5\n"
    mark = replay_grblhal(raw)[0]
    assert deviation(mark, square(0.4, -0.6, 1.2)) > 0.01


def test_a_repeated_point_is_not_a_turn_on_the_axis():
    # A gcode file gives a rapid and then a cut to the same point; treated
    # as a turn it hopped the head to the axis and cut its way back out.
    path = [(5.0, 3.0), (5.0, 3.0), (6.0, 3.0)]
    job = emit_grblhal([path])
    cuts = cut_lines(job.text)
    assert all(not re.match(r"G1 X0\.\d+ Y0\.\d+", line) for line in cuts), cuts
    assert "G0 X0.002" not in job.text
    joint = emit([path])
    assert len(cut_lines(joint.text)) >= 1
    assert joint.cut_length == pytest.approx(1.0, abs=1e-6)


@contextlib.contextmanager
def deadline(seconds: float):
    """Fail instead of hanging when the writer loops."""

    def expire(signum, frame):
        raise TimeoutError(f"still writing after {seconds:g} s")

    previous = signal.signal(signal.SIGALRM, expire)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0.0)
        signal.signal(signal.SIGALRM, previous)


def test_a_repeated_point_on_the_axis_is_not_a_turn():
    # A step through no angle on the axis was taken for a turn. The joint
    # writer's turn left the head where it was, so it turned on the spot
    # forever; the grblHAL one hopped off the axis and cut its way back.
    twice = [(1.0, 0.0), (0.0, 0.0), (0.0, 0.0), (0.0, 1.0)]
    once = [(1.0, 0.0), (0.0, 0.0), (0.0, 1.0)]
    with deadline(5.0):
        assert emit([twice]).text == emit([once]).text
        assert emit_grblhal([twice]).text == emit_grblhal([once]).text
        still = emit([[(0.0, 0.0), (0.0, 0.0)]])
    assert still.path_count == 0 and still.cut_length == 0.0
    assert not cut_lines(still.text)


def test_a_crossing_that_misses_the_axis_by_less_than_a_quantum_is_cut_there():
    # Only an exact hit on the axis used to be seen; anything else was a
    # lit chord spanning it, half a turn of the table under the beam.
    job = emit([[(-5.0, 0.0), (2.0, 0.0)]])
    lines = job.text.splitlines()
    turns = [line for line in lines if line.startswith("G0 X0.000 A")]
    assert turns, lines
    for line in cut_lines(job.text):
        radius = float(re.match(r"G1 X(-?[\d.]+)", line).group(1))
        assert radius >= 0.5 or radius == 0.0, line
    assert job.cut_length == pytest.approx(7.0, abs=1e-6)


def test_the_cartesian_return_home_keeps_the_table_angle():
    path = [(3.0, 0.0), (-2.0, 5.0)]
    job = emit_grblhal([path], return_home=True)
    assert job.text.rstrip().splitlines()[-1].startswith("G0 X0.000 Y0.000")
    assert job.final_angle == pytest.approx(math.degrees(math.atan2(5.0, -2.0)), abs=1e-6)
    joint = emit([path], return_home=True)
    assert joint.final_angle == pytest.approx(0.0, abs=1e-9)
