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
GCODE_SAMPLE = REPO / "out" / "board.gcode"
GERBER_DIR = REPO.parent / "test-gerbers"
GERBER_SAMPLES = [GERBER_DIR / "test-gerbers-F_Cu.gbr", GERBER_DIR / "smaller-test" / "smaller-test-F_Cu.gbr"]
BOARD_SAMPLE = REPO / "tests" / "data" / "board.kicad_pcb"
BOARD_COPPER = REPO / "tests" / "data" / "board-F_Cu.gbr"

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


@pytest.mark.skipif(not GCODE_SAMPLE.exists(), reason="out/board.gcode is not there")
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
    reason="needs tests/data/board.kicad_pcb and kicad-cli",
)
def test_kicad_board_import_exports_gerbers():
    job = jobs.from_board(BOARD_SAMPLE, "board", ImportOptions())
    assert job.source == "kicad"
    assert job.groups and job.groups[0].label.startswith("isolation loop 1")
    assert job.outline


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
