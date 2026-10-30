"""3D models through a CAM profile: the materials, stock and model tables,
the feeds a material works out, a model's job from the kernel, its gcode,
and spinny-cam taking an STL."""

from __future__ import annotations

import math
import re
from pathlib import Path

import models
import pytest

from spinny_laser import cam, camcli, camjob, carve, post

REPO = Path(__file__).resolve().parents[2]
PROFILE = REPO / "cam" / "mill-3d.toml"

needs_kernel = pytest.mark.skipif(carve.find() is None, reason="the 3D kernel is not built: mise run build-carve")


def profile_text(**changes: str) -> str:
    text = PROFILE.read_text(encoding="utf-8")
    for old, new in changes.items():
        assert old in text, old
        text = text.replace(old, new)
    return text


def parse(text: str) -> cam.Profile:
    return cam.parse(text, "test", "test.toml")


# --- the profile ----------------------------------------------------------------


def test_the_shipped_3d_profile_reads_with_its_materials():
    profile = cam.load(PROFILE)
    assert profile.material is not None and profile.material.id == "aluminum"
    assert {m.id for m in profile.materials} >= {"aluminum", "pom", "acrylic"}
    assert profile.summary()["model"] is True
    assert [op.source for op in profile.operations] == ["rough", "waterline", "parallel"]
    ball = profile.tool("ball2")
    assert (ball.shape, ball.flutes, ball.diameter) == ("ball", 2, 2.0)
    vee = profile.tool("vee60")
    assert vee.shape == "vee" and vee.diameter == 3.175


def test_a_material_sets_rpm_and_feed_held_to_the_spindle_and_the_axes():
    profile = cam.load(PROFILE)
    rough = profile.operations[0]
    aluminum = profile.material
    assert aluminum is not None
    # 150 m/min on 3 mm is 15915 rpm, over the spindle's 12000.
    assert rough.cutting["rpm"] == 12000
    assert rough.cutting["feed"] == pytest.approx(12000 * 2 * aluminum.chip(3.0), abs=0.5)
    assert "held to the spindle's 12000" in rough.feeds
    # The rough takes the material's step down, stepover and leave; the
    # file's own leave_floor stands.
    assert rough.cutting["step_down"] == pytest.approx(0.2 * 3.0)
    assert rough.cutting["stepover"] == pytest.approx(0.3)
    assert rough.cutting["leave_floor"] == 0.0
    assert rough.cutting["ramp"] == 2


def test_a_feed_over_the_axes_brings_the_rpm_down_to_keep_the_chip():
    profile = parse(
        profile_text(
            **{
                'material = "aluminum"   #': 'material = "pom"   #',
                "rate = 1200             # mm/min, the fastest feed": "rate = 800 # mm/min, the fastest feed",
            }
        )
    )
    rough = profile.operations[0]
    pom = profile.material
    assert pom is not None and pom.id == "pom"
    # 12000 rpm, 2 flutes and 0.05 mm would be 1200 mm/min, over X's 800.
    chip = pom.chip(3.0)
    assert rough.cutting["feed"] == 800
    assert rough.cutting["feed"] / (rough.cutting["rpm"] * 2) == pytest.approx(chip, rel=1e-3)
    assert rough.cutting["rpm"] < 12000
    assert "rpm brought down to keep the chip" in rough.feeds


def test_a_tool_that_gives_its_own_speeds_keeps_them():
    profile = parse(profile_text(**{"flutes = 2              # one or two": "rpm = 9000\nfeed = 250\nflutes = 2              # one or two"}))
    rough = profile.operations[0]
    assert (rough.cutting["rpm"], rough.cutting["feed"]) == (9000, 250)
    assert rough.feeds == ""


def test_chip_load_is_read_straight_between_its_points():
    material = cam.load(PROFILE).material
    assert material is not None
    assert material.chip(0.5) == 0.004
    assert material.chip(2.0) == pytest.approx(0.008)
    assert material.chip(10.0) == 0.025


@pytest.mark.parametrize(
    "change, fault",
    [
        ({'material = "aluminum"   #': 'material = "steel"   #'}, "[stock] material must name a [[materials]] id"),
        ({'shape = "ball"': 'shape = "bull"'}, "corner is needed for a bull nose"),
        ({"angle = 60              # included": "angle = 60\ncorner = 1 #"}, "corner is a bull nose's"),
        ({'tool = "ball2"': 'tool = "vee60"', 'source = "parallel"': 'source = "waterline"'}, "V bit, which cuts parallel passes only"),
        ({"angle = 0\n": "angle = 0\nflats = false\n"}, "flats adds a rough's or a waterline's levels"),
        ({"below = 0  ": "angle = 10\nbelow = 0  "}, "angle is the direction of parallel lines"),
        ({"turn = [0, 0, 0]": "turn = [0, 0]"}, "[model] turn must be [x, y, z]"),
        ({"min = 3000              # rpm": "min = 30000"}, "[spindle] min must be at most max"),
        ({"speed = 150\n": ""}, "speed is needed"),
    ],
)
def test_a_bad_3d_setting_is_named(change: dict[str, str], fault: str):
    with pytest.raises(cam.CamError) as caught:
        parse(profile_text(**change))
    assert fault in str(caught.value)


def test_a_model_setting_on_a_board_operation_is_refused():
    text = (REPO / "cam" / "mill-3axis.toml").read_text(encoding="utf-8").replace("depth = 1.7\n", "depth = 1.7\nleave = 0.1\n")
    with pytest.raises(cam.CamError, match="is for a model's operations"):
        parse(text)


def test_without_a_material_a_mill_still_needs_its_rpm_and_feed():
    text = profile_text(**{'material = "aluminum"   #': '# material = "aluminum"   #'})
    with pytest.raises(cam.CamError, match="rpm is needed, or a \\[stock\\] material"):
        parse(text)


# --- a model's job ----------------------------------------------------------------


@pytest.fixture
def plate(tmp_path: Path) -> Path:
    return models.plate(tmp_path / "plate.stl")


@needs_kernel
def test_a_plate_becomes_a_rough_and_its_walls(plate: Path):
    profile = cam.load(PROFILE)
    built = camjob.build(profile, camjob.read_model(plate))
    labels = [group.label for group in built.groups]
    assert labels == ["rough: 3 mm end mill", "walls: 3 mm end mill", "surfaces: 2 mm ball end mill"]
    rough, walls, surfaces = built.groups
    assert rough.enabled and walls.enabled and not surfaces.enabled
    for group in built.groups:
        assert group.moves and not group.paths
        assert group.tool == cam.SPINDLE
        for path in group.moves:
            assert path[0][3] == carve.RAPID
            assert all(kind in (carve.RAPID, carve.FEED, carve.PLUNGE) for *_, kind in path)
    # The block: 3 mm round a 30 x 20 plate, its top 0.5 over the plate's.
    assert rough.depth == pytest.approx(6.5)
    assert rough.power == 12000 and rough.speed == walls.speed
    assert any("30 x 20 x 6 mm" in note for note in built.notes)
    assert any("switched off, so planned on the whole block" in note for note in built.notes)
    assert built.outline[-1][0] == (0.0, 0.0) and built.outline[-1][2] == (36.0, 26.0)
    # The deepest moves are at the plate's bottom, the shallowest cut at the
    # top's facing.
    zs = [m[2] for path in rough.moves for m in path if m[3] == carve.FEED]
    assert min(zs) == pytest.approx(-6.5)


@needs_kernel
def test_a_board_profile_says_it_has_nothing_for_a_model(plate: Path):
    profile = cam.load(REPO / "cam" / "mill-3axis.toml")
    with pytest.raises(camjob.DesignError, match="no rough, waterline or parallel operation"):
        camjob.build(profile, camjob.read_model(plate))


def test_a_model_is_an_stl(tmp_path: Path):
    (tmp_path / "part.obj").write_text("o part\n")
    with pytest.raises(camjob.DesignError, match="a 3D model is an STL file"):
        camjob.read_model(tmp_path / "part.obj")


def test_a_missing_kernel_says_how_to_build_it(plate: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setenv(carve.ENV, str(tmp_path / "nowhere"))
    with pytest.raises(camjob.DesignError, match="mise run build-carve"):
        camjob.build(cam.load(PROFILE), camjob.read_model(plate))


@needs_kernel
def test_the_kernel_refuses_a_stock_too_small_by_name(plate: Path):
    profile = parse(profile_text(**{"# size = [50, 40, 6.35]": "size = [20, 20, 6]"}))
    with pytest.raises(camjob.DesignError, match="the model does not fit"):
        camjob.build(profile, camjob.read_model(plate))


# --- its gcode ----------------------------------------------------------------------


@needs_kernel
def test_the_gcode_comes_down_from_the_safe_height_and_cuts_in_three_dimensions(plate: Path):
    profile = cam.load(PROFILE)
    built = camjob.build(profile, camjob.read_model(plate))
    program = post.post(built, profile)
    lines = program.text.splitlines()
    assert program.report.warnings == []
    assert "M3 S12000" in lines
    first_cut = next(i for i, line in enumerate(lines) if line.startswith("G1 "))
    # Before it: up to the safe height, over the start, down to just over the block.
    assert "G0 Z5.000" in lines[:first_cut]
    assert re.match(r"G0 X[\d.]+ Y[\d.]+$", lines[first_cut - 2])
    assert lines[first_cut - 1] == "G0 Z1.000"
    three = [line for line in lines if line.startswith("G1 ") and "X" in line and "Z" in line]
    assert three, "a ramp moves X or Y and Z together"
    lowest = min(float(m) for m in re.findall(r"Z(-?[\d.]+)", program.text))
    assert lowest == pytest.approx(-6.5)
    assert program.report.extents["Z"][0] == pytest.approx(-6.5)
    assert math.isclose(program.report.extents["X"][1], 36.2, abs_tol=1e-6)
    assert lines[-2:] == ["M5", "M2"]


@needs_kernel
def test_a_feed_over_an_axis_is_written_slower_on_steep_moves(plate: Path):
    profile = parse(profile_text(**{"rate = 600              # plunges are held to it": "rate = 5"}))
    built = camjob.build(profile, camjob.read_model(plate))
    program = post.post(built, profile)
    assert any("over an axis' rate on some moves" in w for w in program.report.warnings)


# --- spinny-cam ---------------------------------------------------------------------


@needs_kernel
def test_spinny_cam_takes_an_stl(plate: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]):
    output = tmp_path / "plate.nc"
    assert camcli.main([str(PROFILE), str(plate), "-o", str(output)]) == 0
    printed = capsys.readouterr().out
    assert "plate through 3D mill: 2 operations" in printed
    assert "rough: 3 mm end mill:" in printed
    assert output.read_text(encoding="utf-8").startswith("(plate: 2 operations through 3D mill)")
    assert output.with_suffix(".md").is_file()
