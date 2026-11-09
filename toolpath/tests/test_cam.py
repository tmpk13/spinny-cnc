"""CAM profiles: the schema, the text patch, a design through one, the gcode."""

from __future__ import annotations

import math
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
    assert [p.id for p in found] == ["cartesian-laser", "mill-3axis", "mill-3d", "polar-laser"]
    by_id = {p.id: p for p in found}
    assert by_id["mill-3d"].machine == "cartesian-mill" and by_id["mill-3d"].summary()["model"] is True
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
        ('[placement]\nlayer = "F/Paste"\n', "[placement] layer must be a KiCad layer name such as F.Cu or F.Paste"),
        ("shade = 1\n", "[[operations]] cut shade is not a key here"),
    ],
)
def test_a_fault_names_the_table_and_the_key(change, said):
    with pytest.raises(CamError) as caught:
        parse(MINIMAL + change, "bench", "bench.toml")
    assert str(caught.value).startswith("bench.toml: " + said), str(caught.value)


def test_a_depth_axis_needs_its_safe_height_and_a_top_level_key_is_checked():
    with pytest.raises(CamError, match=r"\[\[axes\]\] safe Z is the depth axis and needs a safe height"):
        parse(MINIMAL.replace("safe = 3\n", ""), "bench")
    with pytest.raises(CamError, match="^bench.toml: shade is not a key here"):
        parse("shade = 1\n" + MINIMAL, "bench", "bench.toml")


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
    # The switched-off clearing's end mill is wider than the V bit's trench.
    assert built.spot == 0.2 and [note.split(",")[0] for note in built.notes] == ["clearing: 1 mm end mill cuts 1 mm wide"]


def test_a_clearing_bit_wider_than_the_isolation_keeps_its_edge_off_the_copper():
    from laser_sweep import geom

    from spinny_laser import clear

    design = camjob.read_board(BOARD_COPPER, "F.Cu")
    text = set_value((SHIPPED / "mill-3axis.toml").read_text(encoding="utf-8"), ("operations", 1, "enabled"), True)
    built = camjob.build(parse(text, "mill-3axis"), design)
    clearing = next(g for g in built.groups if g.label.startswith("clearing"))
    assert clearing.enabled and clearing.paths
    # The isolation's V bit cuts 0.2 mm wide, its loop's middle 0.1 mm from
    # the copper; the 1 mm end mill's middle stays its radius away, so its
    # edge never reaches into a trace or a pad.
    assert clear.clip_open(clearing.paths, geom.offset(built.copper, 0.5 - 0.001)) == []
    assert clear.clip_open(clearing.paths, geom.offset(built.copper, 0.5 + 0.01)) != []
    assert any(note.startswith("clearing: 1 mm end mill cuts 1 mm wide, so its middle keeps 0.5 mm from the copper") for note in built.notes), built.notes
    # A laser clearing with the isolation's own spot keeps to the outermost
    # loop, as it always has, and says nothing.
    polar = set_value((SHIPPED / "polar-laser.toml").read_text(encoding="utf-8"), ("operations", 1, "enabled"), True)
    burnt = camjob.build(parse(polar, "polar-laser"), design)
    strokes = next(g for g in burnt.groups if g.label.startswith("clearing")).paths
    expected = clear.clear(burnt.copper, 0.05, 0.1, "radial", outline=burnt.outline, pitch=0.1)
    assert strokes == [list(map(tuple, s)) for s in expected]
    assert not any(note.startswith("clearing") for note in burnt.notes)


def bounds(paths) -> tuple[float, float, float, float]:
    xs = [p[0] for path in paths for p in path]
    ys = [p[1] for path in paths for p in path]
    return (min(xs), min(ys), max(xs), max(ys))


def sides(x0: float, y0: float, x1: float, y1: float) -> list:
    """A rectangle as four strokes of two points, the way KiCad plots the
    lines of Edge.Cuts."""
    corners = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    return [[corners[i], corners[(i + 1) % 4]] for i in range(4)]


def outline_group(built: camjob.BuiltJob) -> camjob.BuiltGroup:
    return next(g for g in built.groups if g.label == "outline: board outline")


def test_a_mill_cuts_the_outline_outside_the_board_and_a_laser_on_its_line():
    from laser_sweep import geom

    from spinny_laser import clear

    design = camjob.read_board(BOARD_COPPER, "F.Cu")
    built = camjob.build(cam.load(SHIPPED / "mill-3axis.toml"), design)
    x0, y0, x1, y1 = bounds(built.outline)
    assert (x1 - x0, y1 - y0) == pytest.approx((19.0, 12.0))
    # The 1 mm end mill's middle runs half a millimeter outside the drawn
    # edge all round, so the part comes out 19 x 12 mm and no copper near
    # the edge is in the bit's way.
    (loop,) = outline_group(built).paths
    assert loop[0] == loop[-1]
    assert bounds([loop]) == pytest.approx((x0 - 0.5, y0 - 0.5, x1 + 0.5, y1 + 0.5), abs=1e-3)
    board = [built.outline[0][:-1]]
    assert clear.clip_open([loop], geom.offset(board, 0.5 - 0.005)) == []
    assert clear.clip_open([loop], geom.offset(built.copper, 0.5)) == []
    # A beam's kerf is narrow: a laser cuts on the drawn line, as before.
    burnt = camjob.build(cam.load(SHIPPED / "polar-laser.toml"), design)
    assert outline_group(burnt).paths == burnt.outline


def test_an_outline_drawn_as_lines_is_joined_and_its_cutout_cut_first():
    design = camjob.read_board(BOARD_COPPER, "F.Cu")
    # The board's edge and a 2 mm cutout inside it, drawn as lines.
    design.outline = sides(156.0, -112.0, 175.0, -100.0) + sides(160.0, -104.0, 162.0, -102.0)
    burnt = camjob.build(cam.load(SHIPPED / "polar-laser.toml"), design)
    cut = outline_group(burnt).paths
    assert len(cut) == 2 and all(path[0] == path[-1] and len(path) == 5 for path in cut)
    inner, outer = (bounds([path]) for path in cut)
    assert (inner[2] - inner[0], inner[3] - inner[1]) == pytest.approx((2.0, 2.0))
    assert (outer[2] - outer[0], outer[3] - outer[1]) == pytest.approx((19.0, 12.0))
    # A bit goes round each loop once, inside the cutout and outside the edge.
    milled = camjob.build(cam.load(SHIPPED / "mill-3axis.toml"), design)
    cut = outline_group(milled).paths
    assert len(cut) == 2
    inner, outer = (bounds([path]) for path in cut)
    assert (inner[2] - inner[0], inner[3] - inner[1]) == pytest.approx((1.0, 1.0), abs=1e-3)
    assert (outer[2] - outer[0], outer[3] - outer[1]) == pytest.approx((20.0, 13.0), abs=1e-3)
    assert not any(note.startswith("outline") for note in milled.notes)


def test_a_cutout_too_narrow_for_the_bit_and_a_loose_piece_are_noted():
    design = camjob.read_board(BOARD_COPPER, "F.Cu")
    # A cutout 0.8 mm across, which the 1 mm end mill cannot go round, and
    # a lone line, which has no inside for the bit to keep to.
    design.outline = sides(156.0, -112.0, 175.0, -100.0) + sides(160.0, -104.0, 160.8, -103.2) + [[(165.0, -105.0), (168.0, -105.0)]]
    milled = camjob.build(cam.load(SHIPPED / "mill-3axis.toml"), design)
    cut = outline_group(milled).paths
    assert len(cut) == 2 and len(cut[0]) == 2  # the line inside the board first, on its line
    edge = bounds([cut[1]])
    assert (edge[2] - edge[0], edge[3] - edge[1]) == pytest.approx((20.0, 13.0), abs=1e-3)
    outline_notes = [note for note in milled.notes if note.startswith("outline")]
    assert outline_notes == [
        "outline: 1 pieces of the outline join no loop, so the bit cuts them on their line",
        "outline: 1 cutouts are narrower than the 1 mm bit and are not cut",
    ]
    # On the line a beam cuts them all, and there is nothing to say.
    burnt = camjob.build(cam.load(SHIPPED / "polar-laser.toml"), design)
    assert len(outline_group(burnt).paths) == 3
    assert not any(note.startswith("outline") for note in burnt.notes)


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
    assert "not a board, an X/Y gcode file or an STL model" in capsys.readouterr().err


def test_a_v_bit_cuts_as_wide_as_the_depth_makes_it():
    text = """
[[axes]]
letter = "X"
role = "x"
[[axes]]
letter = "Y"
role = "y"
[[axes]]
letter = "Z"
role = "depth"
safe = 5
[[tools]]
id = "v"
kind = "mill"
angle = 30
tip = 0.1
rpm = 12000
feed = 300
depth = 0.1
[[operations]]
name = "iso"
source = "isolation"
tool = "v"
[[operations]]
name = "deep"
source = "outline"
tool = "v"
depth = 0.2
"""
    profile = parse(text, "v")
    tool = profile.tool("v")
    flank = 2.0 * 0.1 * math.tan(math.radians(15.0))
    assert tool.angle == 30.0 and tool.tip == 0.1 and tool.shank is None
    assert tool.width == pytest.approx(0.1 + flank), "the nominal width is the cut at the default depth"
    assert tool.width_at(0.2) == pytest.approx(0.1 + 2.0 * flank)
    iso, deep = profile.operations
    assert iso.cutting["width"] == pytest.approx(tool.width)
    assert deep.cutting["width"] == pytest.approx(0.1 + 2.0 * flank), "the outline is cut deeper, so wider"
    assert tool.document()["angle"] == 30.0
    # A shank bounds the width however deep the cut.
    capped = parse(text.replace("tip = 0.1\n", "tip = 0.1\ndiameter = 0.15\n"), "v").tool("v")
    assert capped.shank == 0.15 and capped.width_at(5.0) == 0.15
    with pytest.raises(CamError, match="tip needs angle"):
        parse(text.replace("angle = 30\n", ""), "v")
    with pytest.raises(CamError, match="angle is for a mill"):
        parse(text.replace('kind = "mill"\nangle = 30\ntip = 0.1\nrpm = 12000\nfeed = 300\n', 'kind = "laser"\nangle = 30\nspot = 0.1\npower = 1\nspeed = 100\n'), "v")
