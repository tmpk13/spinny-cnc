"""spinny-center: the pattern has to burn what the procedure reads off it."""

from __future__ import annotations

import math

import pytest

from polar_sim import replay_grblhal
from spinny_laser import center
from spinny_laser.center import build, main, ring, ring_speed, spokes


def test_spokes_are_radial_and_start_on_the_axis():
    paths = spokes(4, 0.0, 6.0)
    assert len(paths) == 4
    for index, path in enumerate(paths):
        start, end = path
        assert start == pytest.approx((0.0, 0.0), abs=1e-12)
        assert math.hypot(*end) == pytest.approx(6.0)
        # Evenly spread, starting along the rail.
        assert math.degrees(math.atan2(end[1], end[0])) % 360 == pytest.approx(index * 90.0)


def test_a_ring_is_closed_and_every_point_is_the_same_distance_out():
    points = ring(8.0)
    assert points[0] == pytest.approx(points[-1])
    for x, y in points:
        assert math.hypot(x, y) == pytest.approx(8.0)
    # Fine enough that the chords are not measurable against the circle.
    chord = math.dist(points[0], points[1])
    assert 8.0 - math.sqrt(64.0 - chord * chord / 4.0) < 0.001


def test_two_lines_is_the_fewest_that_bounds_anything():
    with pytest.raises(ValueError):
        spokes(1, 0.0, 6.0)
    with pytest.raises(ValueError):
        ring(0.0)


def test_the_ring_is_paced_by_the_table_not_by_the_feed():
    # A ring is all rotation, so the table's rate caps its surface speed.
    assert ring_speed(8.0, 200.0, None) == 200.0
    capped = ring_speed(8.0, 200.0, 400.0)
    assert capped == pytest.approx(center.RING_HEADROOM * math.radians(400.0) * 8.0)
    assert capped < 200.0
    # Far enough out, the table keeps up and the feed stands.
    assert ring_speed(80.0, 200.0, 400.0) == 200.0


def burn(groups, offset):
    """Where the beam lands on the board when the machine is out by `offset`.

    The pattern is written in board coordinates, so a machine that is out
    puts every commanded point somewhere else: the radius zero error runs
    along the rail and the cross slide error across it. The beam at
    commanded `(r, a)` sits at rail position `r + dx` and across it `dz`,
    and the board sees that rotated by the angle it has turned to.
    """
    dx, dz = offset
    marks = []
    for group in groups:
        for path in group.paths:
            # On the axis a point has no angle of its own, so it takes the
            # one the move is heading for, which is what the machine does:
            # it turns on the spot and then runs out along the rail.
            angles = [math.atan2(y, x) if math.hypot(x, y) > 1e-9 else None for x, y in path]
            for index, angle in enumerate(angles):
                if angle is None:
                    later = next((a for a in angles[index + 1:] if a is not None), None)
                    earlier = next((a for a in reversed(angles[:index]) if a is not None), None)
                    angles[index] = later if later is not None else (earlier or 0.0)
            drawn = []
            for (x, y), a in zip(path, angles):
                r = math.hypot(x, y)
                drawn.append(((r + dx) * math.cos(a) - dz * math.sin(a),
                              (r + dx) * math.sin(a) + dz * math.cos(a)))
            marks.append(drawn)
    return marks


def miss(line):
    """Signed distance from the axis to the line, positive to its left."""
    start, end = line[0], line[-1]
    along = (end[0] - start[0], end[1] - start[1])
    length = math.hypot(*along)
    return (along[0] * start[1] - along[1] * start[0]) / length


def test_the_lines_bound_a_square_of_twice_the_cross_slide_error():
    groups = build(lines=4, reach=6.0, ring_radius=0.0, power=400.0, speed=200.0)
    dx, dz = 0.30, 0.12
    marks = burn(groups, (dx, dz))
    assert len(marks) == 4
    # Every line lies the cross slide error away from the axis, on the
    # same side of its own direction, so the four of them bound a square
    # of twice that error whatever the radius zero error is.
    for line in marks:
        assert miss(line) == pytest.approx(dz, abs=1e-9)
    # The pair along the rail sits either side of the axis across it, and
    # the pair across the rail either side along it: a box 2 dz on a side.
    across = sorted(line[0][1] for line in (marks[0], marks[2]))
    along = sorted(line[0][0] for line in (marks[1], marks[3]))
    assert across == pytest.approx([-dz, dz], abs=1e-9)
    assert along == pytest.approx([-dz, dz], abs=1e-9)
    # And each line's inner end is the whole offset out from the axis.
    for line in marks:
        assert math.hypot(*line[0]) == pytest.approx(math.hypot(dx, dz), abs=1e-9)


def test_a_centered_machine_burns_lines_that_meet_at_a_point():
    groups = build(lines=4, reach=6.0, ring_radius=0.0, power=400.0, speed=200.0)
    marks = burn(groups, (0.0, 0.0))
    for line in marks:
        assert line[0] == pytest.approx((0.0, 0.0), abs=1e-12)


def test_the_ring_is_centered_on_the_axis_however_far_out_the_machine_is():
    groups = build(lines=2, reach=6.0, ring_radius=8.0, power=400.0, speed=200.0)
    marks = burn(groups, (0.45, -0.2))
    ring_marks = marks[-1]
    radii = [math.hypot(x, y) for x, y in ring_marks]
    # Every point of the ring is the same distance from the axis, so its
    # center is the axis. That is what everything else is measured from.
    assert max(radii) - min(radii) < 1e-9
    assert sum(radii) / len(radii) == pytest.approx(math.hypot(8.0 + 0.45, 0.2), abs=1e-9)


def test_the_pattern_survives_the_emitter_and_the_controller(tmp_path):
    out = tmp_path / "center.gcode"
    assert main(["-o", str(out), "--no-preview", "--no-sim", "--rotary-max-rate", "400"]) == 0
    text = out.read_text()
    paths = replay_grblhal(text)
    # Four lines and a ring come back as five marks.
    assert len(paths) == 5
    lines, ring_path = paths[:4], paths[4]
    for line in lines:
        angles = {round(math.degrees(math.atan2(y, x)) % 360, 3) for x, y in line if math.hypot(x, y) > 1e-6}
        assert len(angles) == 1, f"a line wandered off its angle: {angles}"
        # The emitter reopens the beam two coordinate quanta off the axis,
        # so a line starts a couple of microns out. Nothing here is
        # measured to better than a hundredth of a millimetre.
        assert min(math.hypot(x, y) for x, y in line) < 0.005, "a line missed the axis"
        assert max(math.hypot(x, y) for x, y in line) == pytest.approx(6.0, abs=0.01)
    radii = [math.hypot(x, y) for x, y in ring_path]
    assert min(radii) == pytest.approx(8.0, abs=0.01)
    assert max(radii) == pytest.approx(8.0, abs=0.01)


def test_the_map_says_how_to_read_the_burn(tmp_path):
    out = tmp_path / "center.gcode"
    assert main(["-o", str(out), "--no-preview", "--no-sim"]) == 0
    report = (tmp_path / "center.gcode.map.md").read_text()
    assert "cross slide" in report
    assert "const" in report


def test_the_ring_can_be_burnt_on_its_own():
    # A table scale that is out distorts the line pattern but not a
    # radius, so the ring alone is worth being able to cut.
    groups = build(lines=0, reach=6.0, ring_radius=5.0, power=400.0, speed=200.0)
    assert len(groups) == 1
    assert "ring" in groups[0].label
    assert spokes(0, 0.0, 6.0) == []


def test_a_ring_only_pattern_says_only_what_applies(tmp_path):
    out = tmp_path / "ring.gcode"
    assert main(["-o", str(out), "--lines", "0", "--ring", "5", "--no-preview", "--no-sim"]) == 0
    report = (tmp_path / "ring.gcode.map.md").read_text()
    assert "half its diameter" in report
    assert "square" not in report, "a ring on its own bounds no square"
