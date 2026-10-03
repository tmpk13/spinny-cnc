"""spinny-polar: an X/Y job comes out as the same marks on the board."""

from __future__ import annotations

import pytest

from polar_sim import deviation, replay_grblhal
from spinny_laser import convert
from spinny_laser.convert import ConvertError, main, read_paths

SAMPLE = """G21
G90
G1F1
M4 S0

G0 X10.000 Y10.000
G1F1
G1 X14.000 Y10.000 S500.00 F400
G1 X14.000 Y12.000
G1 X10.000 Y12.000
G1 X10.000 Y10.000
G1F1
M4 S0

G0 X20.000 Y20.000
G1F1
G1 X22.000 Y21.000 S700.00 F300
G1F1
M4 S0

M5
G0 X0.000 Y0.000
"""


def test_reads_paths_with_their_power_and_feed():
    paths = read_paths(SAMPLE)
    assert len(paths) == 2
    assert paths[0].power == 500.0 and paths[0].speed == 400.0
    assert paths[0].points == [(10.0, 10.0), (14.0, 10.0), (14.0, 12.0), (10.0, 12.0), (10.0, 10.0)]
    assert paths[1].power == 700.0 and paths[1].speed == 300.0


def test_groups_follow_power_and_feed():
    groups = convert.group_paths(read_paths(SAMPLE))
    assert [group.label for group in groups] == ["S500 F400", "S700 F300"]


def test_refuses_arcs_and_relative_moves():
    with pytest.raises(ConvertError):
        read_paths("G91\nG0 X1 Y1\n")
    with pytest.raises(ConvertError):
        read_paths("G0 X1 Y1\nG2 X2 Y2 I1 J0\n")


def test_the_rewrite_marks_the_same_geometry(tmp_path):
    source = tmp_path / "job.gcode"
    source.write_text(SAMPLE)
    out = tmp_path / "job.polar.gcode"
    assert main([str(source), "-o", str(out), "--anchor", "keep"]) == 0
    marks = replay_grblhal(out.read_text())
    originals = [path.points for path in read_paths(SAMPLE)]
    assert len(marks) == 2
    for mark, original in zip(marks, originals):
        assert deviation(mark, original) <= 0.008
    assert "S500.00" in out.read_text() and "S700.00" in out.read_text()


def test_center_anchor_moves_the_extent_onto_the_axis(tmp_path):
    source = tmp_path / "job.gcode"
    source.write_text(SAMPLE)
    out = tmp_path / "job.polar.gcode"
    main([str(source), "-o", str(out)])
    marks = replay_grblhal(out.read_text())
    xs = [x for mark in marks for x, _ in mark]
    ys = [y for mark in marks for _, y in mark]
    # Extent 10..22 in X and 10..21 in Y, centered on the axis.
    assert abs(min(xs) + max(xs)) < 0.05
    assert abs(min(ys) + max(ys)) < 0.05


def test_default_output_sits_next_to_the_input(tmp_path):
    source = tmp_path / "job.gcode"
    source.write_text(SAMPLE)
    assert main([str(source)]) == 0
    assert (tmp_path / "job.polar.gcode").exists()
    assert (tmp_path / "job.polar.gcode.sim.json").exists()


def test_a_feed_on_the_spindle_line_counts():
    text = "G21\nG90\nG0 X0 Y0\nM4 S500 F900\nG1 X5 Y0\nM5\n"
    paths = read_paths(text)
    assert len(paths) == 1 and paths[0].speed == 900.0 and paths[0].power == 500.0


def test_an_s_word_on_the_m5_line_carries_to_the_next_spindle_on():
    # S is modal: the power set beside M5 is what a later bare M3 fires at.
    dark = "M3 S500\nG0 X0 Y0\nG1 X10 Y0 F400\nM5 S0\nG0 X0 Y5\nM3\nG1 X10 Y5\nM5\n"
    paths = read_paths(dark)
    assert len(paths) == 1 and paths[0].points == [(0.0, 0.0), (10.0, 0.0)]
    brighter = dark.replace("M5 S0", "M5 S800")
    paths = read_paths(brighter)
    assert [path.power for path in paths] == [500.0, 800.0]
    assert paths[1].points == [(0.0, 5.0), (10.0, 5.0)]


@pytest.mark.parametrize("code", ["G93", "G95"])
def test_refuses_a_feed_that_is_not_mm_per_minute(code):
    # Under G93 an F of 200 on a 2 mm move is 400 mm/min, not 200.
    with pytest.raises(ConvertError, match=code):
        read_paths(f"{code}\nM4 S500\nG0 X1 Y0\nG1 X3 Y0 F200\nM5\n")
