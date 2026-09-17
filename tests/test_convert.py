"""spinny-polar: an X/Y job comes out as the same marks on the board."""

from __future__ import annotations

import pytest

from polar_sim import deviation, replay
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
    marks = replay(out.read_text())
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
    marks = replay(out.read_text())
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
