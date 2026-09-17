"""spinny-iso end to end: the files it writes, and the burn those files describe."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from laser_sweep import geom, gerber, isolate
from laser_sweep.isolate import ANCHOR_CENTER, IsoConfig
from polar_sim import nearest_deviation, replay
from spinny_laser.cli import main

DATA = Path(__file__).parent / "data"
COPPER = DATA / "board-F_Cu.gbr"
BOARD = DATA / "board.kicad_pcb"


def run(tmp_path, *args):
    out = tmp_path / "board.gcode"
    code = main([str(COPPER), "-o", str(out), *args])
    return code, out


def test_it_writes_gcode_map_preview_and_sim(tmp_path, capsys):
    code, out = run(tmp_path, "--spot", "0.2")
    assert code == 0
    assert out.exists()
    assert (tmp_path / "board.gcode.map.md").exists()
    assert (tmp_path / "board.gcode.preview.svg").exists()
    sim = json.loads((tmp_path / "board.gcode.sim.json").read_text())
    assert sim["rotary_axis"] == "A"
    assert sim["copper"]
    assert sim["radius"] > 1.0
    assert "wrote" in capsys.readouterr().out


def test_the_beam_lands_on_the_isolation_loops(tmp_path):
    _, out = run(tmp_path, "--spot", "0.2", "--tolerance", "0.005")
    text = out.read_text()
    config = IsoConfig(spot=0.2, anchor=ANCHOR_CENTER)
    plan = isolate.build(geom.copper(gerber.read(COPPER)), config)
    loops = [list(loop.points) for loop in plan.loops]
    marks = replay(text)
    assert len(marks) >= len(loops)
    for mark in marks:
        assert nearest_deviation(mark, loops) <= 0.008


def test_center_anchor_puts_the_axis_in_the_middle(tmp_path):
    _, out = run(tmp_path, "--spot", "0.2")
    marks = replay(out.read_text())
    xs = [x for mark in marks for x, _ in mark]
    ys = [y for mark in marks for _, y in mark]
    assert abs(min(xs) + max(xs)) < 0.5
    assert abs(min(ys) + max(ys)) < 0.5


def test_offset_shifts_the_board(tmp_path):
    _, out = run(tmp_path, "--spot", "0.2", "--offset", "10,0")
    marks = replay(out.read_text())
    xs = [x for mark in marks for x, _ in mark]
    assert abs((min(xs) + max(xs)) / 2.0 - 10.0) < 0.5


def test_rotary_letter_and_inversion(tmp_path):
    _, out = run(tmp_path, "--rotary-axis", "c", "--invert-rotary")
    text = out.read_text()
    assert " C" in text
    assert " A" not in text.split("\n\n", 1)[1].replace("Axes:", "")
    config = IsoConfig(spot=0.1, anchor=ANCHOR_CENTER)
    plan = isolate.build(geom.copper(gerber.read(COPPER)), config)
    loops = [list(loop.points) for loop in plan.loops]
    for mark in replay(text, rotary="C", invert=True):
        assert nearest_deviation(mark, loops) <= 0.008


def test_dry_run_writes_nothing(tmp_path, capsys):
    code, out = run(tmp_path, "--dry-run")
    assert code == 0
    assert not out.exists()
    assert "dry run" in capsys.readouterr().out


def test_fit_refuses_a_job_that_reaches_too_far(tmp_path, capsys):
    with pytest.raises(SystemExit):
        run(tmp_path, "--fit", "2")
    assert "outside --fit" in capsys.readouterr().err


def test_outline_and_drills_add_groups(tmp_path):
    _, out = run(tmp_path, "--outline", "auto", "--drill", "auto")
    text = out.read_text()
    assert "board outline pass 1" in text
    assert "drill marks (3 holes)" in text


def test_rotary_limit_is_reported(tmp_path, capsys):
    run(tmp_path, "--rotary-max-rate", "600")
    out = capsys.readouterr().out
    assert "limited" in out


@pytest.mark.skipif(shutil.which("kicad-cli") is None, reason="kicad-cli not installed")
def test_a_board_file_goes_straight_in(tmp_path):
    out = tmp_path / "board.gcode"
    code = main([str(BOARD), "-o", str(out), "--spot", "0.2", "--outline", "auto"])
    assert code == 0
    assert "board outline pass 1" in out.read_text()
