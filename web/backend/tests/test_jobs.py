"""Importers and the store: gcode, SVG, gerber, KiCad board, JSON."""

from __future__ import annotations

import json
import math
import shutil
from pathlib import Path

import pytest
from polar_sim import deviation

from spinny_web import jobs, kinematics
from spinny_web.jobs import (
    Group,
    ImportOptions,
    Job,
    JobImportError,
    JobPatch,
    JobStore,
    apply_patch,
    from_gcode,
    from_json,
    from_svg,
    import_file,
)
from spinny_web.kinematics import Streamer

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
GCODE_SAMPLE = REPO / "var" / "out" / "board.gcode"
GERBER_DIR = REPO.parent / "test-gerbers"
GERBER_SAMPLES = [GERBER_DIR / "test-gerbers-F_Cu.gbr", GERBER_DIR / "smaller-test" / "smaller-test-F_Cu.gbr"]
BOARD_SAMPLE = REPO / "toolpath" / "tests" / "data" / "board.kicad_pcb"
BOARD_COPPER = REPO / "toolpath" / "tests" / "data" / "board-F_Cu.gbr"

SVG = """<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="60mm" viewBox="0 0 100 60">
    <g transform="translate(10,10)">
        <rect x="0" y="0" width="20" height="10" stroke="#ff0000" fill="none"/>
    </g>
    <path d="M 50 30 A 10 10 0 1 1 30 30 A 10 10 0 1 1 50 30 Z" stroke="#0000ff" fill="none"/>
    <path d="M 70 10 C 80 10, 80 20, 90 20" stroke="blue" fill="none"/>
    <line x1="0" y1="50" x2="10" y2="60" style="stroke:#00ff00"/>
</svg>
"""


def bbox(paths):
    xs = [x for path in paths for x, _ in path]
    ys = [y for path in paths for _, y in path]
    return min(xs), min(ys), max(xs), max(ys)


def all_paths(job: Job):
    return [path for group in job.groups for path in group.paths]


def test_svg_import_groups_by_stroke_and_flattens_curves():
    job = from_svg(SVG, "drawing", ImportOptions(anchor="keep"))
    labels = [group.label for group in job.groups]
    assert labels == ["stroke #ff0000", "stroke #0000ff", "stroke #00ff00"]
    rect = job.groups[0].paths[0]
    # Translated by (10, 10) and flipped to y up.
    assert bbox([rect]) == pytest.approx((10.0, -20.0, 30.0, -10.0), abs=1e-6)
    assert rect[0] == rect[-1]
    circle, curve = job.groups[1].paths
    for x, y in circle:
        assert math.hypot(x - 40.0, y + 30.0) == pytest.approx(10.0, abs=0.006)
    assert len(circle) > 40
    # The chords stay within the tolerance of the arc.
    for (x0, y0), (x1, y1) in zip(circle, circle[1:]):
        mid = (x0 + x1) / 2.0, (y0 + y1) / 2.0
        assert 10.0 - math.hypot(mid[0] - 40.0, mid[1] + 30.0) <= 0.0051
    assert curve[0] == pytest.approx((70.0, -10.0), abs=1e-6)
    assert curve[-1] == pytest.approx((90.0, -20.0), abs=1e-6)
    assert len(curve) > 8
    assert job.groups[2].paths[0] == [
        pytest.approx((0.0, -50.0), abs=1e-6),
        pytest.approx((10.0, -60.0), abs=1e-6),
    ]
    assert all(group.power == 500.0 and group.speed == 400.0 for group in job.groups)


def test_svg_import_centers_and_offsets():
    job = from_svg(SVG, "drawing", ImportOptions(anchor="center", offset=(3.0, -4.0), power=250, speed=100))
    x0, y0, x1, y1 = bbox(all_paths(job))
    assert (x0 + x1) / 2.0 == pytest.approx(3.0, abs=1e-6)
    assert (y0 + y1) / 2.0 == pytest.approx(-4.0, abs=1e-6)
    assert job.offset.x == 3.0 and job.offset.y == -4.0
    assert job.groups[0].power == 250 and job.groups[0].speed == 100
    assert job.source == "svg"


def test_svg_without_units_is_pixels():
    text = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" stroke="black" fill="none"/></svg>'
    job = from_svg(text, "px", ImportOptions(anchor="keep"))
    x0, y0, x1, y1 = bbox(all_paths(job))
    # The parser's rounded px-per-mm factor keeps mm files exact instead.
    assert x1 - x0 == pytest.approx(25.4, abs=1e-3)


def test_svg_with_nothing_to_cut_is_refused():
    with pytest.raises(JobImportError):
        from_svg('<svg xmlns="http://www.w3.org/2000/svg"/>', "empty", ImportOptions())
    with pytest.raises(JobImportError):
        from_svg("not xml at all", "bad", ImportOptions())


def test_gcode_import_groups_consecutive_paths_by_power_and_speed():
    text = """G21
G90
M4 S0
G0 X10 Y10
G1 X14 Y10 S500 F400
G1 X14 Y12
M4 S0
G0 X20 Y20
G1 X22 Y21 S700 F300
M4 S0
G0 X0 Y0
G1 X1 Y0 S500 F400
M5
"""
    job = from_gcode(text, "sample", ImportOptions(anchor="keep"))
    # The file's order is kept: the last path is not pulled forward into
    # the first group although it shares its power and feed.
    assert [group.label for group in job.groups] == ["S500 F400", "S700 F300", "S500 F400"]
    assert len(job.groups[0].paths) == 1 and len(job.groups[2].paths) == 1
    assert job.groups[0].paths[0] == [(10.0, 10.0), (14.0, 10.0), (14.0, 12.0)]
    assert job.groups[1].power == 700.0 and job.groups[1].speed == 300.0
    with pytest.raises(JobImportError):
        from_gcode("G0 X1 Y1\nG2 X2 Y2 I1 J0\n", "arc", ImportOptions())
    with pytest.raises(JobImportError):
        from_gcode("G0 X1 Y1\n", "nocuts", ImportOptions())


@pytest.mark.skipif(not GCODE_SAMPLE.exists(), reason="var/out/board.gcode is not there")
def test_gcode_sample_from_out(tmp_path):
    job = import_file(GCODE_SAMPLE, "board", ImportOptions(anchor="keep"), Streamer())
    assert job.source == "gcode"
    assert len(job.groups) >= 1
    assert sum(len(group.paths) for group in job.groups) > 50
    assert job.stats.moves > 0 and job.stats.seconds > 0
    # The sample was placed on the axis already: keeping it keeps the extent.
    x0, y0, x1, y1 = bbox(all_paths(job))
    assert x0 < 0 < x1


@pytest.mark.parametrize("sample", GERBER_SAMPLES, ids=lambda path: path.stem)
def test_gerber_import_builds_isolation_loops(sample):
    if not sample.exists():
        pytest.skip(f"{sample} is not there")
    job = jobs.from_board(sample, sample.stem, ImportOptions(spot=0.1, passes=2, offset=(0.0, 14.0)))
    assert job.source == "gerber"
    labels = [group.label for group in job.groups]
    assert labels[0].startswith("isolation loop 1 at 0.050")
    assert labels[1].startswith("isolation loop 2 at 0.150")
    assert job.copper and all(len(contour) >= 3 for contour in job.copper)
    assert all(len(path) >= 2 for group in job.groups for path in group.paths)
    x0, y0, x1, y1 = bbox(job.copper)
    assert (x0 + x1) / 2.0 == pytest.approx(0.0, abs=0.01)
    assert (y0 + y1) / 2.0 == pytest.approx(14.0, abs=0.2)
    if (sample.parent / f"{sample.stem.rsplit('-', 1)[0]}-Edge_Cuts.gbr").exists():
        assert job.outline and labels[-1] == "board outline pass 1"
    job.refresh_stats(Streamer())
    assert job.stats.moves > 0 and job.stats.seconds > 0


@pytest.mark.skipif(
    not BOARD_SAMPLE.exists() or shutil.which("kicad-cli") is None,
    reason="needs toolpath/tests/data/board.kicad_pcb and kicad-cli",
)
def test_kicad_board_import_exports_gerbers():
    job = jobs.from_board(BOARD_SAMPLE, "board", ImportOptions())
    assert job.source == "kicad"
    assert job.groups and job.groups[0].label.startswith("isolation loop 1")
    assert job.outline


@pytest.mark.parametrize("mode", ["isolate", "deposit", "dispense"])
def test_a_back_layer_is_flipped_in_x_with_its_pads_and_design_map(tmp_path, mode):
    outline = BOARD_COPPER.parent / "board-Edge_Cuts.gbr"
    if not BOARD_COPPER.exists() or not outline.exists():
        pytest.skip("needs the board's copper and outline gerbers")
    # The front's copper under a back layer's name, with the same outline.
    back = tmp_path / "board-B_Cu.gbr"
    shutil.copy(BOARD_COPPER, back)
    shutil.copy(outline, tmp_path / outline.name)
    options = {"spot": 0.1, "offset": (0.0, 14.0), "mode": mode}
    front = jobs.from_board(BOARD_COPPER, "front", ImportOptions(**options))
    flipped = jobs.from_board(back, "back", ImportOptions(**options))
    assert flipped.layer == "B.Cu" and front.design is not None and flipped.design is not None
    assert (front.design.mirror, flipped.design.mirror) == ("none", "x")

    def points(contours) -> list:
        return sorted((round(x, 3) + 0.0, round(y, 3)) for contour in contours for x, y in contour)

    def mirrored(contours) -> list:
        return sorted((round(-x, 3) + 0.0, round(y, 3)) for contour in contours for x, y in contour)

    # Centered on the offset, so the board turned over is the front about x = 0.
    assert points(flipped.copper) == mirrored(front.copper)
    assert points([[(x, y) for x, y, _ in flipped.pads]]) == mirrored([[(x, y) for x, y, _ in front.pads]])
    if mode != "dispense":
        assert points(flipped.outline) == mirrored(front.outline)
    # The design map takes a gerber point to where the job has it.
    gerber = (front.pads[0][0] - front.design.shift[0], front.pads[0][1] - front.design.shift[1])
    x, y = flipped.design.to_job(gerber)
    assert any(abs(x - px) < 1e-3 and abs(y - py) < 1e-3 for px, py, _ in flipped.pads)
    assert flipped.design.angle_to_job(30.0) == pytest.approx(150.0)
    # Asked for none, the back is cut as drawn.
    plain = jobs.from_board(back, "plain", ImportOptions(**options, mirror="none"))
    assert points(plain.copper) == points(front.copper)
    with pytest.raises(JobImportError, match="mirror"):
        ImportOptions(mirror="z").check()


def words(line: str) -> dict[str, str]:
    return {word[0]: word[1:] for word in line.split()[1:]}


def streamed(path) -> list:
    """The pieces one board path goes out as, on its own."""
    job = Job(groups=[Group(label="one", paths=[path])])
    return list(Streamer().job_pieces(job, (0.0, 0.0)))


@pytest.mark.parametrize("pattern", ["radial", "rings", "lines"])
def test_a_board_can_clear_its_copper_before_the_outline_is_cut(pattern):
    job = jobs.from_board(BOARD_COPPER, "board", ImportOptions(spot=0.1, clear=pattern))
    labels = [group.label for group in job.groups]
    assert labels[0].startswith("isolation loop 1")
    assert labels[-2:] == [f"copper clearing, {pattern}, 0.100 mm pitch", "board outline pass 1"]
    clearing = job.groups[-2]
    assert len(clearing.paths) > 100 and clearing.power == jobs.DEFAULT_POWER
    job.refresh_stats(Streamer())
    assert job.stats.seconds > 0


def test_without_clearing_a_board_has_only_loops_and_outline():
    job = jobs.from_board(BOARD_COPPER, "board", ImportOptions(spot=0.1))
    assert not any("clearing" in group.label for group in job.groups)


def edge_strokes(strokes) -> str:
    """An Edge.Cuts gerber with every stroke drawn on its own, the way
    KiCad plots the lines of a board's outline."""
    lines = ["%FSLAX46Y46*%", "%MOMM*%", "%LPD*%", "G01*", "%ADD10C,0.050000*%", "D10*"]
    for (xa, ya), (xb, yb) in strokes:
        lines.append(f"X{round(xa * 1e6)}Y{round(ya * 1e6)}D02*")
        lines.append(f"X{round(xb * 1e6)}Y{round(yb * 1e6)}D01*")
    return "\n".join(lines + ["M02*"]) + "\n"


def sides(x0: float, y0: float, x1: float, y1: float) -> list:
    corners = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    return [(corners[i], corners[(i + 1) % 4]) for i in range(4)]


def board_with_edge(folder: Path, strokes) -> Path:
    copper = folder / BOARD_COPPER.name
    shutil.copy(BOARD_COPPER, copper)
    (folder / "board-Edge_Cuts.gbr").write_text(edge_strokes(strokes), encoding="utf-8")
    return copper


def outline_paths(job: Job) -> list:
    (group,) = [g for g in job.groups if g.label == "board outline pass 1"]
    return group.paths


def test_an_outline_drawn_as_lines_is_joined_and_its_cutout_cut_first(tmp_path):
    # The board's edge and a 2 mm cutout inside it, every side a stroke.
    copper = board_with_edge(tmp_path, sides(156.0, -112.0, 175.0, -100.0) + sides(160.0, -104.0, 162.0, -102.0))
    cut = outline_paths(jobs.from_board(copper, "board", ImportOptions(spot=0.1)))
    assert len(cut) == 2 and all(path[0] == path[-1] for path in cut)
    inner, outer = bbox(cut[:1]), bbox(cut[1:])
    assert (inner[2] - inner[0], inner[3] - inner[1]) == pytest.approx((2.0, 2.0))
    assert (outer[2] - outer[0], outer[3] - outer[1]) == pytest.approx((19.0, 12.0))


def test_a_mill_cuts_the_board_outline_outside_the_board(tmp_path):
    drawn = jobs.from_board(BOARD_COPPER, "board", ImportOptions(spot=1.0))
    milled = jobs.from_board(BOARD_COPPER, "board", ImportOptions(spot=1.0), milled=True)
    # A beam cuts on the line; a bit's middle runs its radius outside it.
    assert outline_paths(drawn) == drawn.outline
    x0, y0, x1, y1 = bbox(milled.outline)
    assert bbox(outline_paths(milled)) == pytest.approx((x0 - 0.5, y0 - 0.5, x1 + 0.5, y1 + 0.5), abs=1e-3)
    # A machine with a spindle imports it that way.
    spindle = Streamer(spindle=kinematics.Spindle(spinup=0.0))
    via = import_file(BOARD_COPPER, "board", ImportOptions(spot=1.0), spindle)
    assert outline_paths(via) == outline_paths(milled)
    # Inside a cutout the bit's middle runs its radius in; a cutout it
    # cannot go round is left out of the cut and kept, switched off, on its
    # line, so the preview shows it.
    copper = board_with_edge(tmp_path, sides(156.0, -112.0, 175.0, -100.0) + sides(160.0, -104.0, 162.0, -102.0) + sides(165.0, -104.0, 165.8, -103.2))
    job = jobs.from_board(copper, "board", ImportOptions(spot=1.0), milled=True)
    inner, outer = (bbox([path]) for path in outline_paths(job))
    assert (inner[2] - inner[0], inner[3] - inner[1]) == pytest.approx((1.0, 1.0), abs=1e-3)
    assert (outer[2] - outer[0], outer[3] - outer[1]) == pytest.approx((20.0, 13.0), abs=1e-3)
    narrow = job.groups[-1]
    assert narrow.label == "board outline cutouts narrower than the bit, on their line" and narrow.enabled is False
    (loop,) = narrow.paths
    box = bbox([loop])
    assert (box[2] - box[0], box[3] - box[1]) == pytest.approx((0.8, 0.8))


def test_a_spoke_goes_out_as_one_radial_cut():
    job = jobs.from_board(BOARD_COPPER, "board", ImportOptions(spot=0.1, clear="radial"))
    spokes = [
        path for path in job.groups[-2].paths
        if len(path) == 2 and abs(path[0][0] * path[1][1] - path[0][1] * path[1][0]) < 1e-9
    ]
    assert len(spokes) > 100
    for spoke in spokes:
        pieces = streamed(spoke)
        assert [piece.kind for piece in pieces] == ["go", "cut"]
        assert words(pieces[0].line)["A"] == words(pieces[1].line)["A"]


def test_a_ring_arc_goes_out_one_cut_per_chord_at_one_radius():
    job = jobs.from_board(BOARD_COPPER, "board", ImportOptions(spot=0.1, clear="rings"))
    arcs = [
        path for path in job.groups[-2].paths
        if len(path) > 2 and max(math.hypot(*p) for p in path) - min(math.hypot(*p) for p in path) < 1e-9
    ]
    assert len(arcs) > 50
    for arc in arcs:
        pieces = streamed(arc)
        assert [piece.kind for piece in pieces] == ["go"] + ["cut"] * (len(arc) - 1)
        assert len({words(piece.line)["R"] for piece in pieces}) == 1


def inside_of(contours):
    """Whether a point is on the copper, the contours scaled once."""
    import pyclipper
    from laser_sweep.geom import SCALE

    scaled = [[(round(x * SCALE), round(y * SCALE)) for x, y in contour] for contour in contours]
    solid = [pyclipper.Orientation(contour) for contour in scaled]

    def inside(point) -> bool:
        probe = (round(point[0] * SCALE), round(point[1] * SCALE))
        winding = sum(
            (1 if ccw else -1) for contour, ccw in zip(scaled, solid) if pyclipper.PointInPolygon(probe, contour) != 0
        )
        return winding != 0

    return inside


@pytest.mark.parametrize("fill", [None, "contour", "radial", "rings", "lines"])
def test_a_deposit_burns_the_copper_and_leaves_the_outline_off(fill):
    job = jobs.from_board(BOARD_COPPER, "board", ImportOptions(spot=0.1, mode="deposit", fill=fill))
    assert [group.label for group in job.groups] == [
        "copper edge loop 1 at 0.050 mm in",
        f"copper fill, {fill or 'contour'}, 0.100 mm pitch",
        "board outline pass 1",
    ]
    assert [group.enabled for group in job.groups] == [True, True, False]
    # Every beam center is on the copper, none on the bare board.
    inside = inside_of(job.copper)
    for group in job.groups[:2]:
        assert all(inside(point) for path in group.paths for point in path)
    job.refresh_stats(Streamer())
    assert job.stats.seconds > 0


def test_a_deposit_sits_where_the_isolation_of_the_same_board_would():
    isolated = jobs.from_board(BOARD_COPPER, "board", ImportOptions(spot=0.1))
    deposited = jobs.from_board(BOARD_COPPER, "board", ImportOptions(spot=0.1, mode="deposit"))
    assert deposited.copper == isolated.copper
    assert deposited.outline == isolated.outline


def test_a_deposit_with_more_passes_has_a_group_per_edge_loop():
    job = jobs.from_board(BOARD_COPPER, "board", ImportOptions(spot=0.1, mode="deposit", passes=2, fill="radial"))
    labels = [group.label for group in job.groups]
    assert labels[:2] == ["copper edge loop 1 at 0.050 mm in", "copper edge loop 2 at 0.150 mm in"]
    assert labels[2:] == ["copper fill, radial, 0.100 mm pitch", "board outline pass 1"]


def test_traces_narrower_than_the_spot_are_deposited_along_their_middle():
    # The board's traces are 0.2 mm wide.
    job = jobs.from_board(BOARD_COPPER, "board", ImportOptions(spot=0.25, mode="deposit"))
    labels = [group.label for group in job.groups]
    assert "copper narrower than the spot, along its middle" in labels
    middle = job.groups[labels.index("copper narrower than the spot, along its middle")]
    assert len(middle.paths) == 10
    inside = inside_of(job.copper)
    assert all(inside(point) for path in middle.paths for point in path)


def test_isolation_and_deposit_options_are_not_mixed():
    with pytest.raises(JobImportError, match="mode must be one of isolate, deposit"):
        ImportOptions(mode="print").check()
    with pytest.raises(JobImportError, match="fill must be one of contour, radial, rings, lines"):
        ImportOptions(mode="deposit", fill="zigzag").check()
    with pytest.raises(JobImportError, match="clear is for isolation"):
        ImportOptions(mode="deposit", clear="radial").check()
    with pytest.raises(JobImportError, match="fill is for a deposit"):
        ImportOptions(fill="contour").check()
    ImportOptions(mode="deposit", fill="lines").check()


def test_a_drawing_is_burnt_as_drawn_in_either_mode():
    drawn = from_svg(SVG, "drawing", ImportOptions())
    assert from_svg(SVG, "drawing", ImportOptions(mode="deposit")).groups == drawn.groups


def test_an_unknown_clearing_is_refused():
    with pytest.raises(JobImportError, match="clear"):
        ImportOptions(clear="zigzag").check()


def test_board_import_refuses_missing_files(tmp_path):
    with pytest.raises(JobImportError):
        jobs.from_board(tmp_path / "missing.gbr", "x", ImportOptions())
    empty = tmp_path / "empty.gbr"
    empty.write_text("%FSLAX46Y46*%\n%MOMM*%\nM02*\n")
    with pytest.raises(JobImportError):
        jobs.from_board(empty, "empty", ImportOptions())


def test_json_roundtrip_and_store(tmp_path):
    job = from_svg(SVG, "drawing", ImportOptions())
    job.refresh_stats(Streamer())
    store = JobStore(tmp_path / "jobs")
    store.add(job)
    assert len(job.id) == 4
    assert (tmp_path / "jobs" / f"{job.id}.json").exists()
    again = JobStore(tmp_path / "jobs")
    loaded = again.get(job.id)
    assert loaded is not None and loaded.model_dump() == job.model_dump()
    assert [j.id for j in again.list()] == [job.id]
    copied = from_json(loaded.model_dump_json(), "copy")
    assert copied.id == "" and copied.name == "drawing"
    store.add(copied)
    assert copied.id != job.id
    assert store.remove(job.id) and not store.remove(job.id)
    assert not (tmp_path / "jobs" / f"{job.id}.json").exists()
    with pytest.raises(JobImportError):
        from_json("{not json", "bad")
    with pytest.raises(JobImportError):
        from_json(json.dumps({"groups": "nope"}), "bad")


def test_import_file_dispatches_by_suffix(tmp_path):
    (tmp_path / "d.svg").write_text(SVG)
    job = import_file(tmp_path / "d.svg", "d", ImportOptions(), Streamer())
    assert job.source == "svg" and job.stats.moves > 0
    (tmp_path / "j.json").write_text(job.model_dump_json())
    assert import_file(tmp_path / "j.json", "j", ImportOptions(), Streamer()).source == "json"
    (tmp_path / "x.txt").write_text("hello")
    with pytest.raises(JobImportError):
        import_file(tmp_path / "x.txt", "x", ImportOptions(), Streamer())
    with pytest.raises(JobImportError):
        import_file(tmp_path / "d.svg", "d", ImportOptions(anchor="corner"), Streamer())


def test_an_svg_part_s_holes_are_cut_before_its_outline():
    svg = """<svg xmlns="http://www.w3.org/2000/svg" width="60mm" height="40mm" viewBox="0 0 60 40">
        <rect x="0" y="0" width="40" height="40" stroke="#000" fill="none"/>
        <circle cx="10" cy="10" r="3" stroke="#000" fill="none"/>
        <rect x="45" y="0" width="10" height="10" stroke="#000" fill="none"/>
        <circle cx="30" cy="30" r="3" stroke="#000" fill="none"/>
    </svg>"""
    job = from_svg(svg, "plate", ImportOptions(anchor="keep"))
    sizes = [round(max(x for x, _ in path) - min(x for x, _ in path)) for path in job.groups[0].paths]
    # Both holes first, then the plate and the square beside it as drawn.
    assert sizes == [6, 6, 40, 10]


def test_patch_turns_the_job_about_its_middle_or_the_origin():
    streamer = Streamer()
    job = Job(
        name="bar",
        offset={"x": 10.0, "y": 0.0},
        groups=[Group(label="bar", power=500, speed=400, paths=[[(10.0, -2.0), (14.0, -2.0), (14.0, 2.0), (10.0, 2.0)]])],
        pads=[(12.0, 0.0, 1.0)],
    )
    job.refresh_stats(streamer)
    turned = apply_patch(job, JobPatch(turn=90.0), streamer)
    # About the middle (12, 0): the box keeps its middle and swaps its sides.
    xs, ys = zip(*turned.groups[0].paths[0])
    assert (min(xs), max(xs), min(ys), max(ys)) == pytest.approx((10.0, 14.0, -2.0, 2.0))
    assert turned.groups[0].paths[0][0] == pytest.approx((14.0, -2.0))
    assert turned.pads[0][:2] == pytest.approx((12.0, 0.0))
    assert turned.rotation == pytest.approx(90.0)
    # The offset turns about the same middle: (10, 0) is 2 left of it.
    assert (turned.offset.x, turned.offset.y) == pytest.approx((12.0, -2.0))
    about_origin = apply_patch(job, JobPatch(turn=90.0, about="origin"), streamer)
    assert about_origin.groups[0].paths[0][0] == pytest.approx((2.0, 10.0))
    assert (about_origin.offset.x, about_origin.offset.y) == pytest.approx((0.0, 10.0))
    # The offset applies first, then the turn about the moved middle.
    both = apply_patch(job, JobPatch(offset={"x": 20.0, "y": 0.0}, turn=180.0), streamer)
    xs, ys = zip(*both.groups[0].paths[0])
    assert (min(xs), max(xs)) == pytest.approx((20.0, 24.0))
    for bad in (JobPatch(turn=400.0), JobPatch(turn=10.0, about="corner")):
        with pytest.raises(ValueError):
            apply_patch(job, bad, streamer)
    fixed = Job(name="axis", groups=[Group(label="ring", power=500, speed=400, joints=[[(5.0, 0.0), (5.0, 90.0)]])])
    with pytest.raises(ValueError, match="cannot be turned"):
        apply_patch(fixed, JobPatch(turn=90.0), streamer)


def test_patch_shifts_and_reprices():
    streamer = Streamer()
    job = from_svg(SVG, "drawing", ImportOptions(anchor="center"))
    job.refresh_stats(streamer)
    before = bbox(all_paths(job))
    original = job
    job = apply_patch(job, JobPatch(offset={"x": 0.0, "y": 14.0}), streamer)
    after = bbox(all_paths(job))
    assert after[1] == pytest.approx(before[1] + 14.0) and after[0] == pytest.approx(before[0])
    assert job.offset.y == 14.0
    # The job given is left as it was: a patch is a new object.
    assert original.offset.y == 0.0 and bbox(all_paths(original)) == before
    job = apply_patch(job, JobPatch(groups=[{"index": 0, "power": 100, "speed": 50, "enabled": False}]), streamer)
    assert job.groups[0].power == 100 and not job.groups[0].enabled
    assert job.groups[0].min_power == 0.0
    job = apply_patch(job, JobPatch(groups=[{"index": 0, "min_power": 40}]), streamer)
    assert job.groups[0].min_power == 40 and job.groups[0].power == 100
    with pytest.raises(ValueError, match="min power"):
        apply_patch(job, JobPatch(groups=[{"index": 0, "min_power": -1}]), streamer)
    seconds = job.stats.seconds
    job = apply_patch(job, JobPatch(groups=[{"index": 0, "enabled": True}]), streamer)
    assert job.stats.seconds > seconds
    assert job.groups[0].passes == 1
    seconds, length = job.stats.seconds, job.stats.length_mm
    job = apply_patch(job, JobPatch(groups=[{"index": 0, "passes": 2}]), streamer)
    assert job.groups[0].passes == 2 and job.stats.seconds > seconds
    assert job.stats.length_mm > length
    for bad in (0, jobs.MAX_GROUP_PASSES + 1):
        with pytest.raises(ValueError, match="passes"):
            apply_patch(job, JobPatch(groups=[{"index": 0, "passes": bad}]), streamer)
    job = apply_patch(job, JobPatch(groups=[{"index": 0, "passes": 1}]), streamer)
    with pytest.raises(ValueError):
        apply_patch(job, JobPatch(groups=[{"index": 9, "enabled": True}]), streamer)
    with pytest.raises(ValueError):
        apply_patch(job, JobPatch(groups=[{"index": 0, "speed": 0}]), streamer)
    # A patch refused part way changes nothing.
    with pytest.raises(ValueError):
        apply_patch(job, JobPatch(groups=[{"index": 0, "power": 900}, {"index": 9}]), streamer)
    assert job.groups[0].power == 100


def test_summary_is_compact():
    job = from_svg(SVG, "drawing", ImportOptions())
    summary = job.summary()
    assert summary["groups"][0]["paths"] == 1
    assert "paths" not in summary
    assert set(summary["stats"]) == {"length_mm", "seconds", "max_radius", "min_radius", "limited_fraction", "moves"}


def test_marks_of_an_imported_drawing_follow_it():
    streamer = Streamer()
    job = from_svg(SVG, "drawing", ImportOptions(anchor="center"))
    from replay import replay

    lines = [piece.line for piece in streamer.job_pieces(job, (0.0, 0.0))]
    marks, _ = replay(lines)
    paths = all_paths(job)
    assert len(marks) == len(paths)
    for mark, path in zip(marks, paths):
        assert deviation(mark, path) <= 0.0075


def test_the_joint_previews_of_a_whole_job_share_one_bound():
    # A few kilobytes of upload whose previews would come to millions of
    # points at the drawing step: every polyline spans 2e5 mm of rail.
    span = [[-1.0e5, 0.0], [1.0e5, 0.0]]
    groups = [{"label": f"g{i}", "power": 400, "speed": 200, "joints": [span] * 10} for i in range(10)]
    job = from_json(json.dumps({"name": "big", "groups": groups}), "big")
    drawn = sum(len(path) for group in job.groups for path in group.paths)
    assert drawn <= kinematics.PREVIEW_BUDGET + 2 * 100
    # Past the budget a polyline is still drawn, through its own points.
    assert all(len(path) >= 2 for group in job.groups for path in group.paths)


def test_a_json_job_with_joints_gets_drawn_paths_and_stays_on_the_axis():
    streamer = Streamer()
    text = json.dumps(
        {"name": "fine", "groups": [{"label": "rail", "power": 400, "speed": 200, "joints": [[[-6, 0], [6, 0]]]}]}
    )
    job = from_json(text, "fine")
    group = job.groups[0]
    assert group.joints == [[(-6.0, 0.0), (6.0, 0.0)]]
    assert group.has_cuts
    # The drawn path is filled in from the joints for the preview.
    assert group.paths and len(group.paths[0]) > 100
    job.refresh_stats(streamer)
    assert job.stats.moves == 2 and job.stats.min_radius == 0.0
    assert job.summary()["groups"][0]["joints"] == 1
    # It is written about the axis: no offset, but the burn settings change.
    with pytest.raises(ValueError):
        apply_patch(job, JobPatch(offset={"x": 0.0, "y": 14.0}), streamer)
    job = apply_patch(job, JobPatch(groups=[{"index": 0, "speed": 100}]), streamer)
    assert job.groups[0].speed == 100
    with pytest.raises(JobImportError):
        from_json(json.dumps({"groups": [{"label": "x", "joints": [[[1, 0]]]}]}), "bad")
    kept = from_json(
        json.dumps({"groups": [{"label": "x", "paths": [[[0, 0], [1, 1]]], "joints": [[[-6, 0], [6, 0]]]}]}),
        "kept",
    )
    assert kept.groups[0].paths == [[(0.0, 0.0), (1.0, 1.0)]]


def test_the_fine_centering_pattern_imports_and_streams_past_the_axis():
    from replay import replay
    from spinny_laser import fine

    groups = fine.build(fine.Design(), 400.0, 200.0, rotary_max_rate=400.0)
    job = from_json(json.dumps(fine.job_document(groups, "center-fine", 0.1)), "center-fine")
    assert [g.label for g in job.groups] == [g.label for g in groups]
    streamer = Streamer()
    lines = [piece.line for piece in streamer.job_pieces(job, (0.0, 0.0))]
    assert any(line.startswith("cut R-") for line in lines)
    marks, _ = replay(lines)
    drawn = [path for _, paths in fine.drawn(groups) for path in paths]
    assert len(marks) == len(drawn) == 6
    for mark, path in zip(marks, drawn):
        assert deviation(mark, path) <= 0.01


def test_a_json_job_with_a_bad_speed_or_power_is_refused():
    text = json.dumps({"name": "x", "groups": [{"label": "g", "speed": 0, "paths": [[[1, 1], [2, 2]]]}]})
    with pytest.raises(jobs.JobImportError, match="speed"):
        from_json(text, "x")
    text = json.dumps({"name": "x", "groups": [{"label": "g", "power": -1, "paths": [[[1, 1], [2, 2]]]}]})
    with pytest.raises(jobs.JobImportError, match="power"):
        from_json(text, "x")
    text = json.dumps({"name": "x", "spot": 0, "groups": [{"label": "g", "paths": [[[1, 1], [2, 2]]]}]})
    with pytest.raises(jobs.JobImportError, match="spot"):
        from_json(text, "x")
    text = json.dumps({"name": "x", "groups": [{"label": "g", "min_power": -5, "paths": [[[1, 1], [2, 2]]]}]})
    with pytest.raises(jobs.JobImportError, match="min power"):
        from_json(text, "x")
    text = json.dumps({"name": "x", "groups": [{"label": "g", "passes": 0, "paths": [[[1, 1], [2, 2]]]}]})
    with pytest.raises(jobs.JobImportError, match="passes"):
        from_json(text, "x")
    # A job saved before groups had a floor or passes loads with none and one.
    text = json.dumps({"name": "x", "groups": [{"label": "g", "paths": [[[1, 1], [2, 2]]]}]})
    assert from_json(text, "x").groups[0].min_power == 0.0
    assert from_json(text, "x").groups[0].passes == 1


def test_numbers_that_are_not_numbers_or_too_large_are_refused():
    with pytest.raises(jobs.JobImportError):
        from_json('{"name":"bad","groups":[{"label":"g","paths":[[[NaN,0],[1,1]]]}]}', "bad")
    with pytest.raises(jobs.JobImportError):
        from_json('{"name":"bad","groups":[{"label":"g","power":1e9,"paths":[[[0,0],[1,1]]]}]}', "bad")
    with pytest.raises(jobs.JobImportError):
        from_json('{"name":"bad","groups":[{"label":"g","paths":[[[1e7,0],[1,1]]]}]}', "bad")
    with pytest.raises(jobs.JobImportError):
        from_json('{"name":"bad","spot":Infinity,"groups":[{"label":"g","paths":[[[0,0],[1,1]]]}]}', "bad")


def test_svg_close_followed_by_a_line_keeps_the_first_segment():
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="40mm" viewBox="0 0 40 40">'
        '<path d="M 0 0 L 10 0 L 10 10 Z L 20 20 L 30 30" stroke="#ff0000" fill="none"/></svg>'
    )
    shapes = jobs.svg_polylines(svg, 0.005)
    assert len(shapes) == 2
    second = [(round(x, 3), round(y, 3)) for x, y in shapes[1][1]]
    assert second == [(0.0, 0.0), (20.0, -20.0), (30.0, -30.0)]


def test_gcode_import_keeps_the_order_of_the_file():
    text = (
        "G21\nG90\nM4 S0\n"
        "G0 X0 Y0\nG1 X5 Y0 S500 F200\n"
        "G0 X10 Y0\nG1 X15 Y0 S300 F800\n"
        "G0 X20 Y0\nG1 X25 Y0 S500 F200\nM5\n"
    )
    job = jobs.from_gcode(text, "order", jobs.ImportOptions(anchor="keep"))
    assert [(g.power, g.speed, len(g.paths)) for g in job.groups] == [(500.0, 200.0, 1), (300.0, 800.0, 1), (500.0, 200.0, 1)]


def test_the_layer_of_a_board_is_checked_and_kept():
    with pytest.raises(JobImportError, match="layer must be a KiCad layer name"):
        ImportOptions(layer="F/Paste").check()
    ImportOptions(layer="In2.Cu").check()
    job = jobs.from_board(BOARD_COPPER, "board", ImportOptions(spot=0.1))
    assert job.layer == "F.Cu"
    assert job.summary()["layer"] == "F.Cu"
    assert jobs.job_from_dict(json.loads(jobs.job_to_json(job))).layer == "F.Cu"


def test_a_gerber_whose_name_does_not_say_its_layer_is_taken_for_copper(tmp_path):
    copy = tmp_path / "coupon.gbr"
    copy.write_bytes(BOARD_COPPER.read_bytes())
    job = jobs.from_board(copy, "coupon", ImportOptions(spot=0.1, mode="deposit"))
    assert job.layer is None
    assert job.groups[0].label == "copper edge loop 1 at 0.050 mm in"
    assert from_svg(SVG, "drawing", ImportOptions()).layer is None


@pytest.mark.skipif(
    not BOARD_SAMPLE.exists() or shutil.which("kicad-cli") is None,
    reason="needs toolpath/tests/data/board.kicad_pcb and kicad-cli",
)
def test_a_deposit_of_the_paste_layer_is_a_stencil():
    job = jobs.from_board(BOARD_SAMPLE, "board", ImportOptions(spot=0.1, layer="F.Paste", mode="deposit"))
    assert job.source == "kicad" and job.layer == "F.Paste"
    labels = [group.label for group in job.groups]
    assert labels[0] == "paste edge loop 1 at 0.050 mm in"
    assert labels[1] == "paste fill, contour, 0.100 mm pitch"
    assert labels[-1] == "board outline pass 1" and not job.groups[-1].enabled
    assert job.copper and job.outline
    inside = inside_of(job.copper)
    assert all(inside(point) for path in job.groups[0].paths for point in path)
    isolated = jobs.from_board(BOARD_SAMPLE, "board", ImportOptions(spot=0.1, layer="F.Paste", clear="radial"))
    assert isolated.layer == "F.Paste"
    assert [group.label for group in isolated.groups][-2].startswith("paste clearing, radial")


@pytest.mark.skipif(
    not BOARD_SAMPLE.exists() or shutil.which("kicad-cli") is None,
    reason="needs toolpath/tests/data/board.kicad_pcb and kicad-cli",
)
def test_a_layer_the_board_lacks_or_leaves_empty_is_refused():
    with pytest.raises(JobImportError, match="board.kicad_pcb has no layer In1.Cu"):
        jobs.from_board(BOARD_SAMPLE, "board", ImportOptions(layer="In1.Cu"))
    with pytest.raises(JobImportError, match="draws no paste"):
        jobs.from_board(BOARD_SAMPLE, "board", ImportOptions(layer="B.Paste"))


BOARD_EDGE = REPO / "toolpath" / "tests" / "data" / "board-Edge_Cuts.gbr"


def test_a_layer_cut_on_its_lines_puts_the_beam_on_what_is_drawn(tmp_path):
    from laser_sweep import gerber

    job = jobs.from_board(BOARD_EDGE, "edge", ImportOptions(spot=0.2, mode="lines"))
    assert job.layer == "Edge.Cuts"
    # The outline's own lines are the job: no outline group besides.
    assert [group.label for group in job.groups] == ["lines of Edge.Cuts"]
    [loop] = job.groups[0].paths
    assert loop[0] == loop[-1] and len(loop) > 4
    # Every point drawn lands on the cut, moved as the design map says.
    drawn = [point for figure in gerber.read(BOARD_EDGE).figures for point in figure.points]
    cut = {(round(x, 6), round(y, 6)) for x, y in loop}
    for point in drawn:
        x, y = job.design.to_job(point)
        assert (round(x, 6), round(y, 6)) in cut
    # Centered with the beam's half width round the lines.
    xs = [x for x, _ in loop]
    assert min(xs) + max(xs) == pytest.approx(0.0, abs=1e-9)
    # Another width moves nothing: the lines are where they are drawn.
    copy = tmp_path / "board-Edge_Cuts.gbr"
    copy.write_bytes(BOARD_EDGE.read_bytes())
    wider = jobs.from_board(copy, "edge", ImportOptions(spot=0.4, mode="lines"))
    assert wider.groups[0].paths == job.groups[0].paths


def test_lines_take_no_clearing_fill_or_extra_loops():
    for options, refusal in (
        (ImportOptions(mode="lines", clear="radial"), "neither clear nor fill"),
        (ImportOptions(mode="lines", fill="contour"), "neither clear nor fill"),
        (ImportOptions(mode="lines", passes=3), "lines are cut once each"),
    ):
        with pytest.raises(JobImportError, match=refusal):
            options.check()
    ImportOptions(mode="lines").check()


@pytest.mark.skipif(
    not BOARD_SAMPLE.exists() or shutil.which("kicad-cli") is None,
    reason="needs toolpath/tests/data/board.kicad_pcb and kicad-cli",
)
def test_a_silk_screen_is_cut_on_its_lines_with_the_outline_switched_off():
    job = jobs.from_board(BOARD_SAMPLE, "board", ImportOptions(spot=0.1, layer="F.SilkS", mode="lines"))
    assert job.source == "kicad" and job.layer == "F.SilkS"
    assert [group.label for group in job.groups] == ["lines of F.SilkS", "board outline pass 1"]
    assert job.groups[0].paths and job.groups[0].enabled
    assert not job.groups[1].enabled
    # Isolation of the silk now finds the gerber kicad-cli names F_Silkscreen.
    isolated = jobs.from_board(BOARD_SAMPLE, "board", ImportOptions(spot=0.1, layer="F.SilkS"))
    assert isolated.groups[0].label.startswith("isolation loop 1")
    # A layer the board leaves empty draws no lines.
    with pytest.raises(JobImportError, match="draws no lines"):
        jobs.from_board(BOARD_SAMPLE, "board", ImportOptions(layer="User.1", mode="lines"))


def test_a_job_is_replaced_by_its_edited_json_and_checked_as_an_upload_is():
    old = from_svg(SVG, "drawing", ImportOptions())
    data = old.model_dump()
    data["groups"][0]["power"] = 250
    data["groups"].append({"label": "moved", "speed": 900, "paths": [[[1, 1], [2, 2]]]})
    data.pop("name")
    made = jobs.replaced("ab12", data, old)
    assert made.id == "ab12" and made.name == old.name and made.source == "svg"
    assert made.groups[0].power == 250
    assert made.groups[-1].label == "moved" and made.groups[-1].power == jobs.DEFAULT_POWER
    for bad, refusal in (
        ({**data, "groups": [{"label": "x", "speed": 0, "paths": []}]}, "speed must be above 0"),
        ({**data, "spot": 0}, "spot must be above 0"),
        ({**data, "groups": [{"label": "x", "focus": 99, "paths": []}]}, "focus must be within"),
        ({**data, "groups": "nope"}, "not a job"),
    ):
        with pytest.raises(JobImportError, match=refusal):
            jobs.replaced("ab12", bad, old)
    with pytest.raises(JobImportError, match="must be a JSON object"):
        jobs.replaced("ab12", [], old)


def test_jobs_combine_into_one_cut_in_order_their_groups_named_by_job(tmp_path):
    from fastapi.testclient import TestClient

    from spinny_web.app import Backend, create_app

    backend = Backend(root=tmp_path, jobs_dir=tmp_path / "jobs", config_path=tmp_path / "config.json")
    with TestClient(create_app(backend, frontend=tmp_path / "no-dist")) as client:
        def upload(job: Job) -> dict:
            body = job.model_dump_json().encode()
            return client.post("/api/jobs", files={"file": (f"{job.name}.json", body, "application/json")}).json()

        a = upload(Job(name="lid", layer="F.Cu", holes=[(1, 1, 0.8)], outline=[[(0, 0), (1, 0)]], groups=[Group(label="cut", paths=[[(0, 0), (5, 0)]])]))
        b = upload(Job(name="base", layer="F.Cu", groups=[Group(label="cut", power=900, paths=[[(0, 9), (5, 9)]]), Group(label="mark", paths=[[(1, 1)]])]))
        client.patch(f"/api/jobs/{b['id']}", json={"offset": {"x": 10, "y": 0}})
        made = client.post("/api/jobs/combine", json={"ids": [b["id"], a["id"]]})
        assert made.status_code == 200, made.text
        job = made.json()
        assert job["name"] == "base + lid" and job["source"] == "combined" and job["layer"] == "F.Cu"
        assert [group["label"] for group in job["groups"]] == ["base: cut", "base: mark", "lid: cut"]
        # Where the jobs are now: the moved one's paths moved, the new job not.
        assert job["groups"][0]["paths"] == [[[10, 9], [15, 9]]] and job["groups"][0]["power"] == 900
        assert job["offset"] == {"x": 0, "y": 0} and job["recipe"] is None
        assert job["holes"] == [[1, 1, 0.8]] and len(job["outline"]) == 1
        assert len(client.get("/api/jobs").json()["jobs"]) == 3
        named = client.post("/api/jobs/combine", json={"ids": [a["id"], b["id"]], "name": "set"}).json()
        assert named["name"] == "set"
        assert client.post("/api/jobs/combine", json={"ids": [a["id"]]}).status_code == 422
        assert client.post("/api/jobs/combine", json={"ids": [a["id"], "none"]}).status_code == 404
        laser = upload(Job(name="engrave", groups=[Group(label="burn", tool="laser", paths=[[(0, 0), (1, 1)]])]))
        mill_job = upload(Job(name="slot", groups=[Group(label="mill", tool="spindle", depth=0.5, paths=[[(0, 0), (1, 1)]])]))
        refused = client.post("/api/jobs/combine", json={"ids": [laser["id"], mill_job["id"]]})
        assert refused.status_code == 400 and "different tools (laser, spindle)" in refused.json()["detail"]
        # Dots for a dispenser and paths for a beam or a bit run on no one machine.
        dots = upload(Job(name="paste", groups=[Group(label="dots", tool="dispenser", paths=[[(1, 1)], [(2, 2)]])]))
        mixed = client.post("/api/jobs/combine", json={"ids": [dots["id"], a["id"]]})
        assert mixed.status_code == 400 and "mix a dispenser's dots with paths" in mixed.json()["detail"]


def test_a_combined_name_stays_short():
    from spinny_web.jobs import combined_name

    assert combined_name(["a", "b", "c"]) == "a + b + c"
    assert combined_name(["a", "b", "c", "d"]) == "a and 3 more"


def test_an_empty_path_draws_nothing_in_the_small_drawing(tmp_path):
    from fastapi.testclient import TestClient

    from spinny_web import thumbs
    from spinny_web.app import Backend, create_app

    job = Job(name="t", groups=[Group(label="g", paths=[[(0, 0), (5, 0)], []])])
    assert thumbs.thumbnail(job).count("<polyline") == 1
    backend = Backend(root=tmp_path, jobs_dir=tmp_path / "jobs", config_path=tmp_path / "config.json")
    stored = backend.store.add(job)
    with TestClient(create_app(backend, frontend=tmp_path / "no-dist")) as client:
        assert client.get(f"/api/jobs/{stored.id}/thumb.svg").status_code == 200


def test_a_job_is_drawn_small_for_the_list(tmp_path):
    import xml.etree.ElementTree as ET

    from fastapi.testclient import TestClient

    from spinny_web import thumbs
    from spinny_web.app import Backend, create_app

    long_path = [(math.cos(i / 500 * math.pi), math.sin(i / 500 * math.pi)) for i in range(1001)]
    job = Job(name="t", groups=[
        Group(label="ring", paths=[[(x * 20, y * 20) for x, y in long_path]]),
        Group(label="dots", enabled=False, paths=[[(1, 1)], [(2, 2)]]),
    ])
    svg = ET.fromstring(thumbs.thumbnail(job))
    ns = "{http://www.w3.org/2000/svg}"
    (line,) = svg.iter(f"{ns}polyline")
    # The ring, 1001 points 0.126 mm apart, keeps one a 100th of its 40 mm
    # box (0.4 mm) on: between its perimeter over 0.4 and over 0.526.
    perimeter = 40 * math.pi
    assert perimeter / 0.526 < len(line.get("points").split()) < perimeter / 0.4 + 2
    # The board's Y is up: the ring's top is at the box's top.
    assert svg.get("viewBox").split()[1] == "-22.40"
    dots = list(svg.iter(f"{ns}circle"))
    assert len(dots) == 2
    groups = [g for g in svg.iter(f"{ns}g") if g.get("fill") == thumbs.COLORS[1]]
    assert groups and groups[0].get("opacity") == "0.3", "a group switched off is faint"
    assert svg.get("width") == "64" and svg.get("height") == "64"
    assert "polyline" not in thumbs.thumbnail(Job(name="empty"))

    backend = Backend(root=tmp_path, jobs_dir=tmp_path / "jobs", config_path=tmp_path / "config.json")
    with TestClient(create_app(backend, frontend=tmp_path / "no-dist")) as client:
        made = client.post("/api/jobs", files={"file": ("t.json", job.model_dump_json().encode(), "application/json")}).json()
        reply = client.get(f"/api/jobs/{made['id']}/thumb.svg?v=1")
        assert reply.status_code == 200 and reply.headers["content-type"] == "image/svg+xml"
        assert reply.text.startswith("<svg")
        assert client.get("/api/jobs/none/thumb.svg").status_code == 404
