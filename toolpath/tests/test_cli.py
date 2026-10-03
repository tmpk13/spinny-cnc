"""spinny-iso end to end: the files it writes, and the burn those files describe."""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

import pytest

from laser_sweep import geom, gerber, isolate
from laser_sweep.isolate import ANCHOR_CENTER, IsoConfig
from polar_sim import nearest_deviation, replay, replay_grblhal
from spinny_laser import machine
from spinny_laser.cli import main, read_outline
from spinny_laser.gcode import PolarOptions

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
    assert sim["controller"] == "grblhal"
    assert sim["rotary_axis"] == "A"
    assert sim["copper"]
    assert sim["radius"] > 1.0
    assert "wrote" in capsys.readouterr().out


def test_the_beam_lands_on_the_isolation_loops_through_grblhal(tmp_path):
    _, out = run(tmp_path, "--spot", "0.2", "--tolerance", "0.005")
    text = out.read_text()
    assert "G93" not in text and " A" not in text.split("M4 S0", 1)[1]
    config = IsoConfig(spot=0.2, anchor=ANCHOR_CENTER)
    plan = isolate.build(geom.copper(gerber.read(COPPER)), config)
    loops = [list(loop.points) for loop in plan.loops]
    marks = replay_grblhal(text)
    assert len(marks) >= len(loops)
    for mark in marks:
        assert nearest_deviation(mark, loops) <= 0.008


def test_the_joint_controller_still_lands_on_the_loops(tmp_path):
    _, out = run(tmp_path, "--spot", "0.2", "--controller", "joint")
    text = out.read_text()
    assert "G93" in text
    config = IsoConfig(spot=0.2, anchor=ANCHOR_CENTER)
    plan = isolate.build(geom.copper(gerber.read(COPPER)), config)
    loops = [list(loop.points) for loop in plan.loops]
    for mark in replay(text):
        assert nearest_deviation(mark, loops) <= 0.008


def test_center_anchor_puts_the_axis_in_the_middle(tmp_path):
    _, out = run(tmp_path, "--spot", "0.2")
    marks = replay_grblhal(out.read_text())
    xs = [x for mark in marks for x, _ in mark]
    ys = [y for mark in marks for _, y in mark]
    assert abs(min(xs) + max(xs)) < 0.5
    assert abs(min(ys) + max(ys)) < 0.5


def test_offset_shifts_the_board(tmp_path):
    _, out = run(tmp_path, "--spot", "0.2", "--offset", "10,0")
    marks = replay_grblhal(out.read_text())
    xs = [x for mark in marks for x, _ in mark]
    assert abs((min(xs) + max(xs)) / 2.0 - 10.0) < 0.5


def test_rotary_letter_and_inversion(tmp_path):
    _, out = run(tmp_path, "--controller", "joint", "--rotary-axis", "c", "--invert-rotary")
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


def test_axis_offset_is_refused_for_grblhal(tmp_path, capsys):
    with pytest.raises(SystemExit):
        run(tmp_path, "--axis-x", "3")
    assert "machine X 0" in capsys.readouterr().err


@pytest.mark.parametrize("flag", ["--rapid-rate", "--rotary-rapid", "--x-max-rate", "--rotary-max-rate"])
def test_a_negative_axis_rate_is_refused(tmp_path, capsys, flag):
    with pytest.raises(SystemExit) as failed:
        run(tmp_path, flag, "-1")
    assert failed.value.code == 2
    assert "cannot be negative" in capsys.readouterr().err
    assert not (tmp_path / "board.gcode").exists()


def summary_numbers(text: str) -> tuple[float, float]:
    limited = re.search(r"limited\s+([\d.]+) mm", text)
    estimate = re.search(r"estimate\s+([\d.]+) min", text)
    assert limited and estimate, text
    return float(limited.group(1)), float(estimate.group(1))


def test_rotary_limit_is_reported(tmp_path, capsys):
    # Both limits have defaults, so the limited line is there on every run:
    # the numbers are what the flag changes.
    run(tmp_path / "default", "--dry-run")
    free_limited, free_minutes = summary_numbers(capsys.readouterr().out)
    _, out = run(tmp_path, "--rotary-max-rate", "600")
    limited, minutes = summary_numbers(capsys.readouterr().out)
    assert limited > free_limited
    assert minutes > free_minutes
    assert "Rotary limit: 600 deg/min" in out.read_text()


def test_the_sidecar_carries_what_the_estimate_assumed(tmp_path):
    # A rate of 0 is no limit to the estimate, and must be to the simulator;
    # the rotary scale weights the angle in a scaled feed.
    run(
        tmp_path, "--controller", "joint", "--feed-mode", "scaled", "--rotary-scale", "2",
        "--x-max-rate", "0", "--rotary-rapid", "0",
    )
    sim = json.loads((tmp_path / "board.gcode.sim.json").read_text())
    assert sim["x_max_rate"] == 0.0 and sim["rotary_rapid"] == 0.0
    assert sim["rotary_max_rate"] == 3600.0
    assert sim["rotary_scale"] == 2.0
    unlimited = machine.sim_document(PolarOptions(rotary_rapid=None), [], [], [], 0.1)
    assert unlimited["rotary_rapid"] == 0.0 and unlimited["x_max_rate"] == 0.0


def groups_in(text: str) -> dict[str, list[str]]:
    """Each group's cut lines, by the label its comment carries."""
    groups: dict[str, list[str]] = {}
    label = None
    for line in text.splitlines():
        if line.startswith("; ") and not line.startswith("; ="):
            label = line[2:].strip()
        elif line.startswith("G1 X") and label is not None:
            groups.setdefault(label, []).append(line)
    return groups


def test_an_outline_and_drill_setting_of_zero_is_used_as_given(tmp_path):
    # 0 used to mean "not given" and fell back to --power, burning an
    # outline asked to stay dark.
    _, out = run(tmp_path, "--outline", "auto", "--drill", "auto", "--outline-power", "0", "--drill-power", "300")
    groups = groups_in(out.read_text())
    outline = next(lines for label, lines in groups.items() if label.startswith("board outline pass 1"))
    drills = next(lines for label, lines in groups.items() if label.startswith("drill marks"))
    assert " S0.00 " in outline[0]
    assert " S300.00 " in drills[0]


@pytest.mark.parametrize(
    "flags,message",
    [
        (["--outline-power", "5000"], "--outline-power 5000 is outside"),
        (["--drill-power", "-1"], "--drill-power -1 is outside"),
        (["--outline-speed", "0"], "--outline-speed must be > 0"),
        (["--drill-speed", "-100"], "--drill-speed must be > 0"),
        (["--outline-passes", "0"], "--outline-passes must be at least 1"),
        (["--power", "-5"], "--power -5 is outside"),
    ],
)
def test_outline_and_drill_settings_are_checked_like_the_isolations(tmp_path, capsys, flags, message):
    with pytest.raises(SystemExit):
        run(tmp_path, "--outline", "auto", "--drill", "auto", *flags)
    assert message in capsys.readouterr().err


# The board's profile as a board file plots one drawn with lines and an
# arc: every piece its own stroke, one of them drawn backwards.
SPLIT_PROFILE = """%TF.FileFunction,Profile,NP*%
%FSLAX46Y46*%
%MOMM*%
%LPD*%
G01*
%ADD10C,0.050000*%
D10*
X156000000Y-112000000D02*
X174000000Y-112000000D01*
G75*
G03*
X175000000Y-111000000I0J1000000D01*
G01*
X175000000Y-111000000D02*
X175000000Y-100000000D01*
X156000000Y-100000000D02*
X175000000Y-100000000D01*
X156000000Y-100000000D02*
X156000000Y-112000000D01*
M02*
"""


def test_an_outline_of_pieces_is_grown_as_one_loop(tmp_path):
    split = tmp_path / "split-Edge_Cuts.gbr"
    split.write_text(SPLIT_PROFILE)
    whole = read_outline(DATA / "board-Edge_Cuts.gbr", 0.5)
    grown = read_outline(split, 0.5)
    # Left as pieces, they were cut on the profile itself, not outside it.
    assert len(grown) == len(whole) == 1
    assert grown[0][0] == grown[0][-1]
    assert geom.area([grown[0][:-1]]) == pytest.approx(geom.area([whole[0][:-1]]), rel=1e-3)
    # On the profile itself the pieces are cut as drawn.
    assert len(read_outline(split, 0.0)) == 4


@pytest.mark.skipif(shutil.which("kicad-cli") is None, reason="kicad-cli not installed")
def test_a_board_file_goes_straight_in(tmp_path):
    out = tmp_path / "board.gcode"
    code = main([str(BOARD), "-o", str(out), "--spot", "0.2", "--outline", "auto"])
    assert code == 0
    assert "board outline pass 1" in out.read_text()
