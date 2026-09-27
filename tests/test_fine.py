"""spinny-center --fine: the crossings have to move by what the geometry says."""

from __future__ import annotations

import json
import math

import pytest

from spinny_laser import fine, polar
from spinny_laser.center import main
from spinny_laser.fine import Design, build, intersections, readings, spirals, to_joints

TOLERANCE = 0.005


def design(**overrides) -> Design:
    return Design(**overrides)


def test_the_rail_lines_are_one_move_through_the_axis_with_the_table_still():
    groups = build(design(), 400.0, 200.0)
    rail = groups[0].joints[0]
    assert rail == [(-7.0, 0.0), (7.0, 0.0)]
    reference = groups[2].joints[0]
    assert reference == [(-7.0, 90.0), (7.0, 90.0)]
    # On the board that is the line across the axis, both halves of it.
    points = polar.sample_joints(rail)
    assert all(abs(y) < 1e-9 for _, y in points)
    assert min(x for x, _ in points) == pytest.approx(-7.0)
    assert max(x for x, _ in points) == pytest.approx(7.0)


def test_the_far_side_reaches_the_same_board_points_with_the_head_past_the_axis():
    joint = (5.0, 30.0)
    far = polar.far_side(joint)
    assert far[0] == -5.0 and far[1] == 210.0
    assert polar.cartesian(far) == pytest.approx(polar.cartesian(joint))
    # And with the machine out, the far side is displaced the other way.
    near_mark = polar.displaced(joint, 0.1, 0.05)
    far_mark = polar.displaced(far, 0.1, 0.05)
    true = polar.cartesian(joint)
    assert (near_mark[0] - true[0], near_mark[1] - true[1]) == pytest.approx(
        (true[0] - far_mark[0], true[1] - far_mark[1]), abs=1e-9
    )


def test_the_arms_are_a_v_symmetric_about_the_line_across_the_axis():
    d = design()
    left = fine.arm_points(d, -1)
    right = fine.arm_points(d, 1)
    slope = math.tan(math.radians(d.angle))
    # Inner ends below the rail line, outer ends above, each passing
    # through its crossing point.
    assert left[0] == pytest.approx((-(d.cross - d.arm), -slope * d.arm))
    assert left[1] == pytest.approx((-(d.cross + d.arm), slope * d.arm))
    assert right[0] == pytest.approx((d.cross - d.arm, -slope * d.arm))
    assert right[1] == pytest.approx((d.cross + d.arm, slope * d.arm))
    # The left arm is cut from the near side and the right one from the
    # far side, both with the table near 180 and the head on either side.
    groups = build(d, 400.0, 200.0, tolerance=TOLERANCE)
    near, far = groups[1].joints
    assert all(r > 0 for r, _ in near) and all(abs(a - 180.0) < 10.0 for _, a in near)
    assert all(r < 0 for r, _ in far) and all(abs(a - 180.0) < 10.0 for _, a in far)
    # Either arm traces its line on the board: y = slope * (|x| - cross).
    for joints in (near, far):
        for x, y in polar.sample_joints(joints):
            assert y == pytest.approx(slope * (abs(x) - d.cross), abs=TOLERANCE + 0.001)


@pytest.mark.parametrize("along,across", [(0.0, 0.02), (0.03, -0.015), (-0.05, 0.05), (0.0, 0.0)])
def test_the_arm_crossings_move_apart_by_four_times_the_cross_slide_error_over_the_angle(along, across):
    d = design()
    groups = build(d, 400.0, 200.0, tolerance=TOLERANCE)
    seen = readings(d, groups, along, across)
    assert len(seen["crossings"]) == 2, seen["crossings"]
    expected = 2.0 * d.cross + 4.0 * across / math.tan(math.radians(d.angle))
    # The radius zero error moves both crossings the same way and drops
    # out; the chord tolerance and the sampling are what is left.
    assert seen["arms"] == pytest.approx(expected, abs=0.02)


@pytest.mark.parametrize("along,across", [(0.01, 0.0), (-0.02, 0.03), (0.04, -0.02), (0.0, 0.0)])
def test_the_spiral_crossing_moves_by_twice_the_radius_zero_error_over_the_angle(along, across):
    d = design()
    groups = build(d, 400.0, 200.0, tolerance=TOLERANCE)
    seen = readings(d, groups, along, across)
    assert len(seen["spiral_crossings"]) == 1, seen["spiral_crossings"]
    x, y = seen["spiral_crossings"][0]
    # The crossing turns about the axis by 360 * error / pitch degrees from
    # the reference direction, toward the short spiral's inner end when the
    # head sits short of the axis, out on the rail. The cross slide error
    # turns the two spirals opposite ways and drops out.
    angle = 90.0 - 360.0 * along / d.pitch
    assert math.degrees(math.atan2(y, x)) == pytest.approx(angle, abs=0.05)
    assert math.hypot(x, y) == pytest.approx(d.spiral, abs=0.01)
    # The reference line is a rail line, so it lies the cross slide error
    # off the axis: that error is in the reading once, against a gain of
    # nearly forty on the radius zero error.
    offset = d.spiral * math.sin(math.radians(360.0 * along / d.pitch)) + across
    assert seen["spiral"] == pytest.approx(offset, abs=0.01)


def test_the_spiral_and_ring_notes_name_one_error_alike():
    # A head out on the rail at radius zero moves the spiral crossing toward
    # the short spiral's inner end and burns the ring wider. The spiral
    # note called that past the axis while the ring note called it short.
    d = design(ring=6.0)
    groups = build(d, 400.0, 200.0, tolerance=TOLERANCE)
    assert readings(d, groups, 0.01, 0.0)["spiral"] > 0.0
    notes = fine.notes_for(d, 0.1, 200.0, groups)
    spiral = next(note for note in notes if note.startswith("Radius zero"))
    ring = next(note for note in notes if note.startswith("The ring at"))
    assert "toward its inner end the head at radius zero sits short of the axis" in spiral
    assert "short of the axis gives a negative R" in spiral
    assert "wider meaning the head is short of the axis" in ring


def test_the_gain_is_two_over_the_tangent_of_the_angle():
    d = design(angle=3.0)
    assert d.gain == pytest.approx(2.0 / math.tan(math.radians(3.0)))
    # The spirals are pitched so that they meet at that angle.
    near, far = spirals(d)
    assert d.pitch == pytest.approx(2.0 * math.pi * d.spiral * math.tan(math.radians(1.5)))
    assert near[1][0] - near[0][0] == pytest.approx(d.pitch * (360.0 - 2 * d.trim) / 360.0)
    # The far spiral goes inward with the angle, on the far side.
    assert far[0][0] == pytest.approx(-(d.spiral + d.pitch / 2))
    assert far[1][0] == pytest.approx(-(d.spiral - d.pitch / 2))
    assert far[1][1] - far[0][1] == pytest.approx(360.0)


def test_a_design_that_cannot_be_read_is_refused():
    with pytest.raises(ValueError):
        design(cross=2.0, arm=2.5)
    with pytest.raises(ValueError):
        design(reach=5.0)
    with pytest.raises(ValueError):
        design(angle=0.0)
    with pytest.raises(ValueError):
        design(spiral=8.0)


def test_the_arms_are_cut_straight_enough_for_the_angle():
    # A stray of the chord tolerance across an arm moves a crossing by the
    # stray over tan(angle), so the arms are subdivided finer than a job.
    d = design()
    assert d.arm_tolerance(0.005) == pytest.approx(fine.CROSSING_SLACK * math.tan(math.radians(3.0)))
    assert d.arm_tolerance(0.0001) == 0.0001
    groups = build(d, 400.0, 200.0, tolerance=0.005)
    near, far = groups[1].joints
    assert len(near) > 5 and len(far) > 5
    slope = math.tan(math.radians(d.angle))
    for joints in (near, far):
        for x, y in polar.sample_joints(joints, 0.02, 0.2):
            assert y == pytest.approx(slope * (abs(x) - d.cross), abs=d.arm_tolerance(0.005) + 1e-6)


def test_far_side_joints_come_from_the_near_conversion_mirrored():
    points = [(4.0, -0.2), (6.0, 0.2)]
    near = to_joints(points, TOLERANCE, 0.0)
    far = to_joints(points, TOLERANCE, 0.0, far=True)
    assert len(near) == len(far) > 2
    for n, f in zip(near, far):
        assert f == pytest.approx((-n[0], n[1] + 180.0))


def test_turning_features_are_paced_by_the_table():
    d = design(ring=8.0)
    groups = build(d, 400.0, 200.0, rotary_max_rate=400.0)
    by_label = {g.label.split(",")[0].split(" at ")[0]: g for g in groups}
    assert by_label["rail line through the axis"].speed == 200.0
    assert by_label["arms " + f"{d.angle:g} deg off the rail line"].speed == 200.0
    inner = d.spiral - d.pitch / 2
    assert by_label["spirals"].speed == pytest.approx(fine.HEADROOM * math.radians(400.0) * inner)
    assert by_label["reference ring"].speed == pytest.approx(fine.HEADROOM * math.radians(400.0) * 8.0)


def test_a_negative_table_rate_is_refused(tmp_path, capsys):
    # It paced the turning features at a negative speed.
    out = tmp_path / "fine.json"
    with pytest.raises(SystemExit):
        main(["--fine", "-o", str(out), "--rotary-max-rate", "-1"])
    assert "cannot be negative" in capsys.readouterr().err
    assert not out.exists()
    # 0 sets no limit: nothing is paced below the speed asked for.
    assert main(["--fine", "-o", str(out), "--rotary-max-rate", "0", "--no-map", "--no-preview"]) == 0
    assert all(group["speed"] == 200.0 for group in json.loads(out.read_text())["groups"])


def test_the_job_is_written_for_the_web_interface(tmp_path):
    out = tmp_path / "fine.json"
    assert main(["--fine", "-o", str(out), "--rotary-max-rate", "400"]) == 0
    job = json.loads(out.read_text())
    assert job["groups"] and all("joints" in g and "paths" in g for g in job["groups"])
    radii = [r for g in job["groups"] for poly in g["joints"] for r, _ in poly]
    assert min(radii) == pytest.approx(-7.0) and max(radii) == pytest.approx(7.0)
    # Every joint polyline has a drawn path of the same shape.
    for group in job["groups"]:
        assert len(group["paths"]) == len(group["joints"])
    report = (tmp_path / "fine.json.map.md").read_text()
    assert "past the axis" in report and "cross slide" in report and "radius zero" in report
    assert (tmp_path / "fine.json.preview.svg").exists()


def test_the_preview_can_show_a_machine_that_is_out(tmp_path, capsys):
    out = tmp_path / "fine.json"
    assert main(["--fine", "-o", str(out), "--show-error", "0.02,0.01", "--no-map"]) == 0
    printed = capsys.readouterr().out
    assert "arm crossings" in printed and "spiral crossing" in printed
    assert (tmp_path / "fine.json.preview.svg").exists()
    with pytest.raises(SystemExit):
        main(["--fine", "-o", str(out), "--show-error", "0.02"])


def test_intersections_find_a_crossing_once():
    a = [(-1.0, 0.0), (0.0, 0.0), (1.0, 0.0)]
    b = [(0.5, -1.0), (0.5, 1.0)]
    assert intersections(a, b) == [pytest.approx((0.5, 0.0))]
    assert intersections(a, [(2.0, -1.0), (2.0, 1.0)]) == []
