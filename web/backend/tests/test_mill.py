"""The Plot page's operations, a job made again for another width, and the
markers, through the API."""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from spinny_web import mill
from spinny_web.app import Backend, create_app
from spinny_web.jobs import Group, Job, JobImportError, carry_settings, label_stem
from spinny_web.kinematics import Streamer

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
BOARD_COPPER = REPO / "toolpath" / "tests" / "data" / "board-F_Cu.gbr"

POCKET = {"kind": "pocket", "x0": 0, "y0": 0, "x1": 20, "y1": 10, "tool": 2, "depth": 1.0, "step_down": 0.3, "stepover": 0.5}


@pytest.fixture
def client(tmp_path):
    backend = Backend(root=tmp_path, jobs_dir=tmp_path / "jobs", config_path=tmp_path / "config.json")
    with TestClient(create_app(backend, frontend=tmp_path / "no-dist")) as client:
        client.backend = backend
        yield client


def bbox(paths):
    xs = [x for path in paths for x, _ in path]
    ys = [y for path in paths for _, y in path]
    return min(xs), min(ys), max(xs), max(ys)


def test_an_operation_is_a_milled_group_in_passes():
    job, notes = mill.build(mill.MillOperation(**POCKET))
    (group,) = job.groups
    assert group.tool == "spindle"
    assert group.depth == 1.0 and group.passes == 4
    assert job.source == "mill" and job.spot == 2
    assert job.recipe is not None and job.recipe.mill["kind"] == "pocket"
    assert bbox(group.paths) == (1, 1, 19, 9)
    assert any("4 passes" in note for note in notes)


@pytest.mark.parametrize(
    "op",
    [
        {"kind": "drill", "points": [[1, 2], [3, 4]]},
        {"kind": "line", "points": [[0, 0], [5, 0], [5, 5]], "closed": True},
        {"kind": "face", "x0": 0, "y0": 0, "x1": 30, "y1": 20, "stepover": 0.7},
        {"kind": "pocket", "shape": "circle", "cx": 5, "cy": 5, "diameter": 12},
        {"kind": "profile", "x0": 0, "y0": 0, "x1": 10, "y1": 5, "side": "outside"},
        {"kind": "profile", "shape": "circle", "cx": 0, "cy": 0, "diameter": 8, "side": "inside"},
    ],
)
def test_every_operation_makes_a_job(op):
    job, _ = mill.build(mill.MillOperation(**op))
    assert job.groups and all(group.paths for group in job.groups)
    assert all(group.tool == "spindle" for group in job.groups)


def test_a_drill_is_one_point_paths():
    job, _ = mill.build(mill.MillOperation(kind="drill", points=[(1, 2), (3, 4)]))
    assert job.groups[0].paths == [[(1.0, 2.0)], [(3.0, 4.0)]]


def test_holes_are_grouped_by_size_and_bored_when_wider_than_the_bit():
    holes = [(0, 0, 0.8), (5, 0, 0.8), (10, 0, 3.0), (2, 2, 1.0)]
    job, notes = mill.build(mill.MillOperation(kind="holes", tool=1.0, job="x"), holes)
    labels = [group.label for group in job.groups]
    assert labels == ["drill 0.80 mm holes (2)", "drill 1.00 mm holes (1)", "bore 3.00 mm holes (1)"]
    bored = job.groups[2].paths[0]
    assert max(math.dist(p, (10, 0)) for p in bored) == pytest.approx(1.0)
    assert len(job.holes) == 4
    # Drilled undersize holes come out the bit's size.
    assert any("smaller than" in note for note in notes)
    only, _ = mill.build(mill.MillOperation(kind="holes", tool=1.0, job="x", sizes=[3.0], bore=False), holes)
    assert [group.label for group in only.groups] == ["drill 3.00 mm holes (1)"]


def test_a_laser_burns_the_paths_in_passes_marking_points_with_a_ring():
    job, notes = mill.build(mill.MillOperation(kind="drill", cutter="laser", points=[(1, 2)], tool=0.2, power=300, passes=2, depth=5, step_down=0.01))
    (group,) = job.groups
    assert (group.tool, group.power, group.passes, job.spot, job.name) == ("laser", 300, 2, 0.2, "mark 1 points")
    # A ring the spot across about the point, closed: the beam drills nothing standing still.
    ring = group.paths[0]
    assert ring[0] == ring[-1] and len(ring) > 8
    assert all(math.dist(p, (1, 2)) == pytest.approx(0.1) for p in ring)
    assert notes == ["2 passes at S300 and 300 mm/min, a 0.2 mm spot"]
    pocket, _ = mill.build(mill.MillOperation(**{**POCKET, "cutter": "laser", "tool": 0.5, "power": 800}))
    assert pocket.groups[0].tool == "laser" and pocket.groups[0].passes == 1
    assert bbox(pocket.groups[0].paths) == (0.25, 0.25, 19.75, 9.75)
    # The streamer of a laser machine cuts every ring, none skipped as a point.
    lines = [piece.line for piece in Streamer().job_pieces(job, (0.0, 0.0))]
    assert sum(line.startswith("cut ") for line in lines) >= 2 * (len(ring) - 1)
    with pytest.raises(JobImportError, match="passes"):
        mill.build(mill.MillOperation(kind="drill", cutter="laser", points=[(1, 2)], passes=0))
    with pytest.raises(JobImportError, match="spot"):
        mill.build(mill.MillOperation(kind="drill", cutter="laser", points=[(1, 2)], tool=0))


def test_a_laser_cuts_a_hole_along_its_edge_or_clears_it_and_marks_one_under_the_spot():
    holes = [(0, 0, 3.0), (5, 0, 0.12)]
    cut, _ = mill.build(mill.MillOperation(kind="holes", cutter="laser", tool=0.2, job="x", bore=False), holes)
    assert [group.label for group in cut.groups] == ["mark 0.12 mm holes (1)", "cut 3.00 mm holes (1)"]
    edge = cut.groups[1].paths[0]
    assert all(math.dist(p, (0, 0)) == pytest.approx(1.4) for p in edge)
    cleared, _ = mill.build(mill.MillOperation(kind="holes", cutter="laser", tool=0.2, job="x", bore=True), holes)
    assert cleared.groups[1].label == "clear 3.00 mm holes (1)"


def test_an_operation_that_cannot_be_cut_says_why():
    with pytest.raises(JobImportError, match="narrower than the bit"):
        mill.build(mill.MillOperation(**{**POCKET, "x1": 1.5}))
    with pytest.raises(JobImportError, match="passes"):
        mill.build(mill.MillOperation(**{**POCKET, "depth": 10, "step_down": 0.01}))


def test_plan_shows_and_make_stores(client):
    plan = client.post("/api/mill/plan", json=POCKET)
    assert plan.status_code == 200, plan.text
    assert plan.json()["job"]["id"] == ""
    assert client.get("/api/jobs").json()["jobs"] == []
    made = client.post("/api/mill", json={**POCKET, "name": "slot"}).json()
    assert made["job"]["name"] == "slot"
    (listed,) = client.get("/api/jobs").json()["jobs"]
    assert listed["id"] == made["job"]["id"] and listed["remake"] is True
    refused = client.post("/api/mill", json={**POCKET, "tool": 30})
    assert refused.status_code == 400 and "narrower" in refused.json()["detail"]


def test_holes_come_from_a_stored_job(client):
    board = Job(name="board", source="gerber", holes=[(1, 1, 0.8), (4, 1, 0.8)], groups=[Group(label="copper pass 1", paths=[[(0, 0), (1, 0)]])])
    uploaded = client.post("/api/jobs", files={"file": ("board.json", board.model_dump_json().encode(), "application/json")}).json()
    made = client.post("/api/mill", json={"kind": "holes", "job": uploaded["id"], "tool": 0.8}).json()
    assert made["job"]["name"] == "board holes"
    assert made["job"]["groups"][0]["paths"] == [[[1, 1]], [[4, 1]]]
    missing = client.post("/api/mill", json={"kind": "holes", "job": "none"})
    assert missing.status_code == 404


def test_a_mill_job_is_made_again_for_another_bit_where_it_was_moved(client):
    job = client.post("/api/mill", json=POCKET).json()["job"]
    patched = client.patch(f"/api/jobs/{job['id']}", json={"offset": {"x": 5, "y": -3}, "groups": [{"index": 0, "speed": 123}]})
    assert patched.status_code == 200, patched.text
    wider = client.post(f"/api/jobs/{job['id']}/width", json={"width": 4})
    assert wider.status_code == 200, wider.text
    made = wider.json()
    assert made["spot"] == 4 and made["id"] == job["id"]
    (group,) = made["groups"]
    # The walls are a bigger bit's radius in, on the moved pocket.
    assert bbox(group["paths"]) == pytest.approx((7, -1, 23, 5))
    assert group["speed"] == 123
    assert made["offset"] == {"x": 5, "y": -3}
    assert made["recipe"]["ops"][0]["tool"] == 4


def test_a_job_of_several_operations_cuts_them_in_order_with_one_bit():
    pocket = mill.MillOperation(**{**POCKET, "corner": 3})
    drill = mill.MillOperation(kind="drill", points=[(30, 5)], tool=2, depth=2, step_down=1)
    holes = mill.MillOperation(kind="holes", job="board", tool=2)
    job, notes = mill.build_job([pocket, drill, holes], lambda op: [(40, 0, 2.0), (44, 0, 4.0)])
    assert [group.label for group in job.groups] == [
        "pocket 20 x 10 mm, corners R3",
        "drill 1 points",
        "drill 2.00 mm holes (1)",
        "bore 4.00 mm holes (1)",
    ]
    assert job.name == "pocket 20 x 10 mm, corners R3 and 2 more"
    assert job.spot == 2 and job.source == "mill"
    assert notes[0].startswith("1: ") and any(note.startswith("3: ") for note in notes)
    # The holes are kept with their operation, so it is made again without
    # the job they came from; the rest keep what the page sent.
    assert [op["kind"] for op in job.recipe.ops] == ["pocket", "drill", "holes"]
    assert job.recipe.ops[2]["holes"] == [[40, 0, 2.0], [44, 0, 4.0]]
    assert job.recipe.ops[0]["corner"] == 3
    assert len(job.outline) == 1 + 1 + 2 and len(job.holes) == 2
    with pytest.raises(JobImportError, match="operation 2's 1 mm bit is not operation 1's 2 mm: a job cuts with one bit"):
        mill.build_job([pocket, drill.model_copy(update={"tool": 1})])
    with pytest.raises(JobImportError, match="operation 2 cuts with a laser and operation 1 with a spindle"):
        mill.build_job([pocket, drill.model_copy(update={"cutter": "laser"})])
    with pytest.raises(JobImportError, match="at least one operation"):
        mill.build_job([])


def test_rounded_corners_round_the_outline_and_are_checked(client):
    job, _ = mill.build(mill.MillOperation(**{**POCKET, "corner": 2}))
    (outline,) = job.outline
    assert outline[0] == pytest.approx(outline[-1])
    assert bbox([outline]) == pytest.approx((0, 0, 20, 10))
    assert len(outline) > 5, "arcs, not four corners"
    face, _ = mill.build(mill.MillOperation(kind="face", x0=0, y0=0, x1=20, y1=10, corner=2))
    assert len(face.outline[0]) == 5, "a face covers its whole rectangle, corners and all"
    refused = client.post("/api/mill/plan", json={**POCKET, "corner": 6})
    assert refused.status_code == 400 and "half the shorter side, 5 mm" in refused.json()["detail"]


def test_operations_are_applied_to_a_job_in_place_where_it_was_moved(client):
    made = client.post("/api/mill", json={"ops": [POCKET], "name": "plate"}).json()["job"]
    assert made["name"] == "plate" and made["recipe"]["ops"][0]["kind"] == "pocket"
    client.patch(f"/api/jobs/{made['id']}", json={"offset": {"x": 5, "y": -3}})
    drill = {"kind": "drill", "points": [[0, 0]], "tool": 2, "depth": 1, "step_down": 0.5}
    body = {"ops": [POCKET, drill], "name": "plate", "job": made["id"]}
    plan = client.post("/api/mill/plan", json=body).json()["job"]
    # The plan shows the job where it now is, and stores nothing.
    assert plan["groups"][1]["paths"] == [[[5, -3]]]
    assert len(client.get(f"/api/jobs/{made['id']}").json()["groups"]) == 1
    applied = client.post("/api/mill", json=body)
    assert applied.status_code == 200, applied.text
    job = applied.json()["job"]
    assert job["id"] == made["id"] and job["offset"] == {"x": 5, "y": -3}
    assert [group["label"] for group in job["groups"]] == ["pocket 20 x 10 mm", "drill 1 points"]
    assert bbox(job["groups"][0]["paths"]) == pytest.approx((6, -2, 24, 6))
    assert len(client.get("/api/jobs").json()["jobs"]) == 1
    # Only a Plot page job takes operations.
    board = Job(name="board", source="gerber", groups=[Group(label="copper pass 1", paths=[[(0, 0), (1, 0)]])])
    other = client.post("/api/jobs", files={"file": ("board.json", board.model_dump_json().encode(), "application/json")}).json()
    refused = client.post("/api/mill", json={"ops": [POCKET], "job": other["id"]})
    assert refused.status_code == 400 and "not made on the Plot page" in refused.json()["detail"]
    assert client.post("/api/mill", json={"ops": [POCKET], "job": "none"}).status_code == 404
    assert client.post("/api/mill", json={"ops": []}).status_code == 422


def test_a_job_of_operations_is_made_again_for_another_bit_holes_and_all(client):
    board = Job(name="board", source="gerber", holes=[(10, 10, 3.0)], groups=[Group(label="copper pass 1", paths=[[(0, 0), (1, 0)]])])
    uploaded = client.post("/api/jobs", files={"file": ("board.json", board.model_dump_json().encode(), "application/json")}).json()
    body = {"ops": [POCKET, {"kind": "holes", "job": uploaded["id"], "tool": 2}]}
    job = client.post("/api/mill", json=body).json()["job"]
    client.delete(f"/api/jobs/{uploaded['id']}")
    client.patch(f"/api/jobs/{job['id']}", json={"offset": {"x": 1, "y": 0}})
    wider = client.post(f"/api/jobs/{job['id']}/width", json={"width": 1}).json()
    pocket, bore = wider["groups"]
    assert bbox(pocket["paths"]) == pytest.approx((1.5, 0.5, 20.5, 9.5))
    # The hole, kept with its operation, is bored where the job moved it.
    assert bbox(bore["paths"]) == pytest.approx((10, 9, 12, 11))


def test_a_job_made_before_operations_were_lists_is_still_made_again():
    streamer = Streamer()
    old, _ = mill.build(mill.MillOperation(**POCKET))
    assert old.recipe.ops is None and old.recipe.mill is not None
    remade = mill.remake(old, 4, streamer)
    assert bbox(remade.groups[0].paths) == pytest.approx((2, 2, 18, 8))
    holes, _ = mill.build(mill.MillOperation(kind="holes", tool=1, job="x"), [(3, 3, 1.0)])
    holes.shift(2, 0)
    remade = mill.remake(holes, 1, streamer)
    assert remade.groups[0].paths == [[(5.0, 3.0)]], "its own holes, which moved with it"


def test_a_board_is_imported_again_for_another_spot_onto_the_same_copper(client, tmp_path):
    data = BOARD_COPPER.read_bytes()
    job = client.post("/api/jobs", files={"file": (BOARD_COPPER.name, data, "application/octet-stream")}, data={"spot": "0.2"}).json()
    assert job["recipe"]["file"] == BOARD_COPPER.name
    assert (tmp_path / "jobs" / f"{job['id']}.upload.gbr").is_file()
    client.patch(f"/api/jobs/{job['id']}", json={"offset": {"x": job["offset"]["x"] + 3, "y": job["offset"]["y"] - 2}, "groups": [{"index": 0, "speed": 77}]})
    before = client.get(f"/api/jobs/{job['id']}").json()
    made = client.post(f"/api/jobs/{job['id']}/width", json={"width": 0.4}).json()
    assert made["spot"] == 0.4
    # The copper is where it was; the loops around it are a wider spot out.
    assert bbox(made["copper"]) == pytest.approx(bbox(before["copper"]), abs=1e-6)
    assert made["design"]["shift"] == pytest.approx(before["design"]["shift"], abs=1e-6)
    old_loops, new_loops = bbox(before["groups"][0]["paths"]), bbox(made["groups"][0]["paths"])
    assert new_loops[0] < old_loops[0] and new_loops[2] > old_loops[2]
    assert made["groups"][0]["speed"] == 77
    assert made["recipe"]["options"]["spot"] == 0.4
    client.delete(f"/api/jobs/{job['id']}")
    assert not (tmp_path / "jobs" / f"{job['id']}.upload.gbr").exists()


def test_a_drawing_takes_the_width_alone_and_a_board_without_its_file_is_refused(client):
    svg = b'<svg xmlns="http://www.w3.org/2000/svg" width="10mm" height="10mm" viewBox="0 0 10 10"><path d="M0 0 L10 10" stroke="#f00" fill="none"/></svg>'
    drawing = client.post("/api/jobs", files={"file": ("d.svg", svg, "image/svg+xml")}).json()
    wider = client.post(f"/api/jobs/{drawing['id']}/width", json={"width": 0.5}).json()
    assert wider["spot"] == 0.5 and wider["groups"][0]["paths"] == drawing["groups"][0]["paths"]
    board = Job(name="old board", source="kicad", copper=[[(0, 0), (1, 0), (1, 1)]], groups=[Group(label="copper pass 1", paths=[[(0, 0), (1, 0)]])])
    uploaded = client.post("/api/jobs", files={"file": ("old.json", board.model_dump_json().encode(), "application/json")}).json()
    refused = client.post(f"/api/jobs/{uploaded['id']}/width", json={"width": 0.5})
    assert refused.status_code == 400 and "import it again" in refused.json()["detail"]
    assert client.post(f"/api/jobs/{drawing['id']}/width", json={"width": 0}).status_code == 400
    assert client.post("/api/jobs/none/width", json={"width": 1}).status_code == 404


def test_settings_carry_over_by_label_but_for_its_numbers():
    old = [Group(label="copper pass 1", speed=11), Group(label="copper pass 2", speed=22), Group(label="copper clearing, radial, 0.100 mm pitch", speed=33)]
    new = [Group(label="copper pass 1"), Group(label="copper pass 2"), Group(label="copper clearing, radial, 0.200 mm pitch")]
    carry_settings(old, new)
    assert [group.speed for group in new] == [11, 22, 33]
    assert label_stem("bore 3.20 mm holes (4)") == "bore # mm holes (#)"


def test_markers_are_kept_named_once_and_sent_to_every_page(client, tmp_path):
    assert client.get("/api/markers").json() == {"markers": []}
    put = client.put("/api/markers", json={"markers": [{"name": " corner ", "x": 1, "y": 2}, {"name": "tool", "x": -40, "y": 0}]})
    assert put.status_code == 200, put.text
    assert put.json()["markers"][0] == {"name": "corner", "x": 1, "y": 2}
    saved = json.loads((tmp_path / "config.json").read_text())
    assert [marker["name"] for marker in saved["markers"]] == ["corner", "tool"]
    twice = client.put("/api/markers", json={"markers": [{"name": "a", "x": 0, "y": 0}, {"name": "a", "x": 1, "y": 1}]})
    assert twice.status_code == 400 and "two markers" in twice.json()["detail"]
    blank = client.put("/api/markers", json={"markers": [{"name": " ", "x": 0, "y": 0}]})
    assert blank.status_code == 400
    assert len(client.get("/api/markers").json()["markers"]) == 2


def test_the_fixture_the_page_twin_is_checked_against_is_current():
    fixture = HERE / "data" / "mill-samples.json"
    assert json.loads(fixture.read_text()) == json.loads(json.dumps(mill.sample_jobs())), "run: mise run mill-fixture"
