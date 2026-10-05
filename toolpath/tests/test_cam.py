"""CAM profiles: the schema, the text patch, a design through one, the gcode."""

from __future__ import annotations

from pathlib import Path

import pytest

from spinny_laser import cam, camcli, camjob, post
from spinny_laser.cam import CamError, load_all, parse, set_value

REPO = Path(__file__).resolve().parents[2]
SHIPPED = REPO / "cam"
DATA = Path(__file__).resolve().parent / "data"
BOARD_COPPER = DATA / "board-F_Cu.gbr"

MINIMAL = """
name = "Bench"

[[axes]]
letter = "X"
role = "x"
[[axes]]
letter = "Y"
role = "y"
[[axes]]
letter = "Z"
role = "depth"
safe = 3

[[tools]]
id = "bit"
kind = "mill"
diameter = 0.5
rpm = 9000
feed = 240

[[operations]]
name = "cut"
source = "outline"
tool = "bit"
depth = 1.2
step_down = 0.5
"""


def test_the_shipped_profiles_load_and_say_what_they_are():
    found, problems = load_all(SHIPPED)
    assert problems == []
    assert [p.id for p in found] == ["cartesian-laser", "mill-3axis", "polar-laser"]
    by_id = {p.id: p for p in found}
    mill = by_id["mill-3axis"]
    assert mill.kinematics == "cartesian" and mill.machine is None
    assert [a.letter for a in mill.axes] == ["X", "Y", "Z"] and mill.axis("depth").safe == 5.0
    assert mill.tool_kinds == ["spindle"]
    assert mill.summary()["operations"] == 3
    outline = next(op for op in mill.operations if op.name == "outline")
    assert outline.cutting["passes"] == 3 and outline.cutting["depth"] == 1.7 and outline.cutting["rpm"] == 10000.0
    polar = by_id["polar-laser"]
    assert polar.kinematics == "polar" and polar.machine == "polar-laser"
    assert polar.axis("setup").park == 0.0
    outline = next(op for op in polar.operations if op.name == "outline")
    assert outline.cutting == {"power": 800.0, "min_power": 0.0, "speed": 200.0, "passes": 3.0, "width": 0.1}
    laser = by_id["cartesian-laser"]
    assert laser.axis("depth") is None and laser.tool_kinds == ["laser"]
    engraving = next(op for op in laser.operations if op.source == "paths")
    assert engraving.settings["match"] == "" and engraving.cutting["power"] == 300.0


def test_a_minimal_profile_takes_the_defaults():
    profile = parse(MINIMAL, "bench")
    assert profile.name == "Bench" and profile.post.header == cam.DEFAULT_HEADER and profile.post.spinup == 2.0
    assert profile.placement.anchor == "center" and profile.placement.offset == (0.0, 0.0)
    (op,) = profile.operations
    assert op.cutting["passes"] == 3 and op.cutting["plunge"] == cam.DEFAULT_PLUNGE and op.cutting["stepover"] == 0.5
    assert profile.axis("x").min is None and profile.axis("depth").rate is None


@pytest.mark.parametrize(
    ("change", "said"),
    [
        ('[[axes]]\nletter = "Q"\nrole = "x"\n', "[[axes]] role two axes are 'x'"),
        ('[[tools]]\nid = "bit"\nkind = "mill"\ndiameter = 0.5\nrpm = 9000\nfeed = 240\n', "[[tools]] id 'bit' is given twice"),
        ('[[operations]]\nname = "x"\nsource = "drills"\ntool = "nope"\n', "[[operations]] x tool must name a [[tools]] id: bit"),
        ('[[operations]]\nname = "x"\nsource = "outline"\ntool = "bit"\ndepth = 80\n', "[[operations]] x depth must be above 0 and at most 50"),
        ('[[operations]]\nname = "x"\nsource = "outline"\ntool = "bit"\npattern = "lines"\n', "[[operations]] x pattern is how clearing fills"),
        ('[[operations]]\nname = "x"\nsource = "outline"\ntool = "bit"\nspeed = 3\n', "[[operations]] x speed is not a key here"),
        ("[post]\nspindle_on = \"M8\"\n", "[post] spindle_on must be M3 or M4"),
        ("[placement]\noffset = [1]\n", "[placement] offset must be [x, y] in mm"),
        ("colour = 1\n", "[[operations]] cut colour is not a key here"),
    ],
)
def test_a_fault_names_the_table_and_the_key(change, said):
    with pytest.raises(CamError) as caught:
        parse(MINIMAL + change, "bench", "bench.toml")
    assert str(caught.value).startswith("bench.toml: " + said), str(caught.value)


def test_a_depth_axis_needs_its_safe_height_and_a_top_level_key_is_checked():
    with pytest.raises(CamError, match=r"\[\[axes\]\] safe Z is the depth axis and needs a safe height"):
        parse(MINIMAL.replace("safe = 3\n", ""), "bench")
    with pytest.raises(CamError, match="^bench.toml: colour is not a key here"):
        parse("colour = 1\n" + MINIMAL, "bench", "bench.toml")


def test_a_laser_tool_and_an_angle_axis_have_their_own_rules():
    polar = """
[[axes]]
letter = "X"
role = "radius"
[[axes]]
letter = "A"
kind = "rotary"
role = "angle"
[[tools]]
id = "uv"
kind = "laser"
spot = 0.1
power = 500
speed = 400
height = 2
[[operations]]
name = "iso"
source = "isolation"
tool = "uv"
loops = 2
power = 450
"""
    profile = parse(polar, "p")
    assert profile.kinematics == "polar"
    (op,) = profile.operations
    assert op.cutting == {"power": 450.0, "min_power": 0.0, "speed": 400.0, "height": 2.0, "passes": 1.0, "width": 0.1}
    with pytest.raises(CamError, match="kind must be 'rotary'"):
        parse(polar.replace('kind = "rotary"\n', ""), "p")
    with pytest.raises(CamError, match="spot is needed"):
        parse(polar.replace("spot = 0.1\n", ""), "p")
    with pytest.raises(CamError, match="step_down gives more than 100 passes"):
        parse(MINIMAL.replace("step_down = 0.5", "step_down = 0.001"), "p")
    with pytest.raises(CamError, match="not a profile id"):
        cam.check_id("Not This")


def test_set_value_changes_one_value_and_keeps_the_rest():
    text = (SHIPPED / "mill-3axis.toml").read_text(encoding="utf-8")
    changed = set_value(text, ("operations", 1, "enabled"), True)
    changed = set_value(changed, ("operations", 0, "depth"), 0.15)
    changed = set_value(changed, ("post", "spinup"), 3)
    changed = set_value(changed, ("post", "header"), ["G21", "G90"])
    changed = set_value(changed, ("tools", 0, "stepover"), 0.3)
    changed = set_value(changed, ("name",), 'Mill "two"')
    changed = set_value(changed, ("operations", 3, "step_down"), None)
    profile = parse(changed, "mill-3axis")
    assert profile.operations[1].enabled and profile.operations[0].cutting["depth"] == 0.15
    assert profile.post.spinup == 3.0 and profile.post.header == ("G21", "G90")
    assert profile.tools[0].settings["stepover"] == 0.3 and profile.name == 'Mill "two"'
    # Without its own step down the outline takes the end mill's 0.6 mm, three passes still.
    assert "step_down" not in profile.operations[3].settings and profile.operations[3].cutting["passes"] == 3
    # The comments and the lines around the change stay.
    assert "spinup = 3              # s after the spindle starts or changes speed" in changed
    assert text.count("#") - 1 == changed.count("#")  # the step_down line took its comment with it
    assert len(changed.splitlines()) == len(text.splitlines())  # one line added, one taken out
    with pytest.raises(CamError, match=r"no \[\[operations\]\] table 9"):
        set_value(text, ("operations", 8, "depth"), 1.0)
    with pytest.raises(CamError, match=r"no \[extra\] table"):
        set_value(text, ("extra", "depth"), 1.0)
    with pytest.raises(CamError, match="end in a key"):
        set_value(text, ("operations", 1), 1.0)


def test_set_value_adds_a_key_to_an_empty_table_and_before_the_next_header():
    text = "name = \"a\"\n\n[post]\n\n[placement]\nanchor = \"keep\"   # as drawn\n"
    changed = set_value(text, ("post", "spinup"), 1.5)
    assert changed == "name = \"a\"\n\n[post]\nspinup = 1.5\n\n[placement]\nanchor = \"keep\"   # as drawn\n"
    changed = set_value(changed, ("placement", "anchor"), "corner")
    assert changed.endswith('anchor = "corner"   # as drawn\n')
    changed = set_value(changed, ("description",), "x")
    assert changed.startswith('name = "a"\ndescription = "x"\n\n[post]')


def test_the_board_goes_through_the_mill_profile():
    profile = cam.load(SHIPPED / "mill-3axis.toml")
    design = camjob.read_board(BOARD_COPPER, "F.Cu")
    assert design.board and design.outline and len(design.holes) == 3
    built = camjob.build(profile, design)
    labels = [(g.label, g.enabled, g.tool) for g in built.groups]
    assert labels[0] == ("isolation: loop 1 at 0.100 mm", True, "spindle")
    assert labels[1][0].startswith("clearing: lines") and labels[1][1] is False
    assert labels[2:] == [
        ("drills: 2 holes at the bit's size", True, "spindle"),
        ("drills: 1 holes milled round", True, "spindle"),
        ("outline: board outline", True, "spindle"),
    ]
    pecks = built.groups[2]
    assert all(len(path) == 1 for path in pecks.paths) and pecks.depth == 1.8 and pecks.power == 8000.0
    (round_hole,) = built.groups[3].paths
    assert round_hole[0] == round_hole[-1] and len(round_hole) > 8
    outline = built.groups[4]
    assert outline.passes == 3 and outline.speed == 200.0 and outline.plunge == 40.0
    # Placed with the lower left corner on the origin.
    xs = [p[0] for g in built.groups for path in g.paths for p in path]
    ys = [p[1] for g in built.groups for path in g.paths for p in path]
    assert min(xs) == pytest.approx(0.0, abs=0.6) and min(ys) == pytest.approx(0.0, abs=0.6)
    assert built.spot == 0.2 and built.notes == []


def test_a_laser_profile_marks_the_drills_and_refuses_a_design_with_nothing_for_it():
    profile = parse(
        (SHIPPED / "polar-laser.toml").read_text(encoding="utf-8").replace('name = "drills"\nsource = "drills"\ntool = "uv"\nenabled = false', 'name = "drills"\nsource = "drills"\ntool = "uv"\nenabled = true'),
        "polar-laser",
    )
    built = camjob.build(profile, camjob.read_board(BOARD_COPPER))
    marks = next(g for g in built.groups if g.label.startswith("drills"))
    assert marks.label == "drills: 3 holes marked as circle" and len(marks.paths) == 3
    gcode_design = camjob.read_gcode("G21\nM4 S300\nG0 X1 Y1\nG1 X5 Y1 F600\nG1 X5 Y5\nM5\n", "coupon")
    with pytest.raises(camjob.DesignError, match="nothing in coupon"):
        camjob.build(profile, gcode_design)


def test_paths_of_a_gcode_design_are_picked_by_label_and_placed():
    profile = cam.load(SHIPPED / "cartesian-laser.toml")
    design = camjob.read_gcode("G21\nM4 S300\nG0 X1 Y1\nG1 X5 Y1 F600\nG1 X5 Y5\nM5\n", "coupon")
    design.paths = camjob.place_paths(design.paths, profile.placement.anchor, profile.placement.offset)
    built = camjob.build(profile, design)
    (group,) = [g for g in built.groups if g.paths]
    assert group.label == "engraving: S300 F600" and group.power == 300.0 and group.speed == 1200.0
    assert group.paths == [[(10.0, 10.0), (14.0, 10.0), (14.0, 14.0)]]
    assert any("isolation" in note and "not a board" in note for note in built.notes)


def test_the_cartesian_post_mills_the_way_the_backend_streams():
    profile = cam.load(SHIPPED / "mill-3axis.toml")
    built = camjob.BuiltJob(
        name="square",
        source="json",
        spot=1.0,
        offset=(0.0, 0.0),
        groups=[
            camjob.BuiltGroup("pocket", "spindle", 10000.0, 0.0, 200.0, 2, 1.0, 40.0, [[(0.0, 0.0), (10.0, 0.0), (10.0, 10.0)]]),
            camjob.BuiltGroup("hole", "spindle", 8000.0, 0.0, 100.0, 1, 1.8, 50.0, [[(5.0, 5.0)]]),
            camjob.BuiltGroup("off", "spindle", 8000.0, 0.0, 100.0, 1, 1.8, 50.0, [[(50.0, 5.0)]], enabled=False),
            camjob.BuiltGroup("fast", "spindle", 8000.0, 0.0, 9000.0, 1, 0.5, 50.0, [[(0.0, 0.0), (1.0, 0.0)]]),
        ],
        outline=[],
        copper=[],
        notes=[],
    )
    program = post.post(built, profile)
    lines = program.text.splitlines()
    assert lines[:8] == [
        "(square: 3 operations through 3 axis mill)",
        "(board X/Y on X=x Y=y Z=depth)",
        "G21",
        "G90",
        "G94",
        "G17",
        "G0 Z5.000",
        "(pocket: 1 paths)",
    ]
    body = lines[8:]
    assert body[:9] == [
        "M3 S10000",
        "G4 P2",
        "G0 X0.000 Y0.000",
        "G1 Z-0.500 F40.000",
        "G1 X10.000 F200.000",
        "G1 Y10.000",
        "G0 Z5.000",
        "G0 X0.000 Y0.000",
        "G1 Z-1.000 F40.000",
    ]
    hole = body.index("(hole: 1 paths)")
    assert body[hole + 1 : hole + 5] == ["M3 S8000", "G4 P2", "G0 X5.000 Y5.000", "G1 Z-1.800 F50.000"]
    assert body[hole + 5] == "G0 Z5.000"
    assert "(off: 1 paths)" not in program.text
    # The last path lifts the tool, the output goes off, the X/Y home comes before the Z home, then the footer.
    assert program.text.endswith("G0 Z5.000\nM5\nG0 X0.000 Y0.000\nG0 Z20.000\nM5\nM2\n")
    report = program.report
    assert report.extents["Z"] == [-1.8, 20.0] and report.extents["X"] == [0.0, 10.0]
    assert report.cuts == 5 and report.length_mm == pytest.approx(41.0)
    assert report.warnings == ["fast: 9000 mm/min is over the axes' rate; written as 1500"]
    assert "F1500.000" in program.text
    assert report.seconds > 4.0 + 20.0 / 200.0 * 60.0


def test_the_post_refuses_what_the_axes_cannot_do_and_warns_past_the_travel():
    laser = cam.load(SHIPPED / "cartesian-laser.toml")
    milled = camjob.BuiltJob("x", "json", 1.0, (0.0, 0.0), [camjob.BuiltGroup("cut", "spindle", 1.0, 0.0, 1.0, 1, 1.0, 1.0, [[(0.0, 0.0), (1.0, 0.0)]])], [], [], [])
    with pytest.raises(post.PostError, match="needs a depth axis"):
        post.post(milled, laser)
    burnt = camjob.BuiltJob(
        "x", "json", 0.1, (0.0, 0.0),
        [camjob.BuiltGroup("burn", "laser", 600.0, 100.0, 900.0, 2, 0.1, 60.0, [[(0.0, 0.0), (500.0, 0.0)]])],
        [], [], [],
    )
    program = post.post(burnt, laser)
    assert "M4 S0" in program.text and program.text.count("G1 X500.000 F900.000 S600") == 1
    assert program.text.count("G1 X500.000") == 2  # two passes
    assert "Y reaches" not in " ".join(program.report.warnings)
    assert any(w.startswith("X reaches 500.000, over its max 400") for w in program.report.warnings)
    assert any("power floor 100" in w for w in program.report.warnings)


def test_a_polar_profile_is_written_by_the_polar_writer():
    profile = cam.load(SHIPPED / "polar-laser.toml")
    built = camjob.BuiltJob(
        "ring", "json", 0.1, (0.0, 0.0),
        [camjob.BuiltGroup("line", "laser", 500.0, 0.0, 400.0, 1, 0.1, 60.0, [[(5.0, 0.0), (10.0, 0.0)]])],
        [], [], [],
    )
    program = post.post(built, profile)
    assert "G93" in program.text and "A0.0000" in program.text and program.report.extents["X"][1] == pytest.approx(10.0)
    milled = camjob.BuiltJob("x", "json", 1.0, (0.0, 0.0), [camjob.BuiltGroup("cut", "spindle", 1.0, 0.0, 1.0, 1, 1.0, 1.0, [[(0.0, 0.0), (1.0, 0.0)]])], [], [], [])
    with pytest.raises(post.PostError, match="laser operations only"):
        post.post(milled, profile)


def test_the_command_line_tool_writes_the_program_and_a_report(tmp_path, capsys):
    out = tmp_path / "board.nc"
    assert camcli.main([str(SHIPPED / "mill-3axis.toml"), str(BOARD_COPPER), "-o", str(out)]) == 0
    printed = capsys.readouterr().out
    assert "board-F_Cu through 3 axis mill: 4 operations" in printed and "Z reach:" in printed
    assert out.read_text().startswith("(board-F_Cu: 4 operations through 3 axis mill)")
    assert "- Lines:" in (tmp_path / "board.md").read_text()
    assert camcli.main([str(SHIPPED / "mill-3axis.toml"), str(BOARD_COPPER), "--dry-run"]) == 0
    assert camcli.main([str(SHIPPED / "mill-3axis.toml"), str(tmp_path / "nothing.svg")]) == 1
    assert "not a board or an X/Y gcode file" in capsys.readouterr().err
