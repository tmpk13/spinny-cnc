"""The Mill page's operations, a job made again for another width, and the
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
    assert made["recipe"]["mill"]["tool"] == 4


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
