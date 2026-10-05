"""The CAM routes: profiles listed, read, saved, patched and removed; a board
through one into a job; a job out as gcode; a run that refuses the other tool."""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from fake_serial import FakeSerial, fake_opener
from fastapi.testclient import TestClient

from spinny_web.app import Backend, create_app
from spinny_web.link import Link

REPO = Path(__file__).resolve().parents[3]
SHIPPED = REPO / "cam"
DATA = REPO / "toolpath" / "tests" / "data"
BOARD_FILES = [DATA / "board-F_Cu.gbr", DATA / "board-Edge_Cuts.gbr", DATA / "board-PTH.drl"]

SVG = """<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="40mm" viewBox="0 0 40 40">
    <rect x="5" y="5" width="10" height="10" stroke="#ff0000" fill="none"/>
    <circle cx="30" cy="30" r="5" stroke="#00ff00" fill="none"/>
</svg>
"""


@pytest.fixture
def fake():
    return FakeSerial(move_time=0.002)


@pytest.fixture
def client(tmp_path, fake):
    cam_dir = tmp_path / "cam"
    cam_dir.mkdir()
    for name in ("mill-3axis.toml", "cartesian-laser.toml"):
        shutil.copy(SHIPPED / name, cam_dir / name)
    (cam_dir / "broken.toml").write_text('name = "b"\n[[axes]]\nletter = "X"\nrole = "x"\n', encoding="utf-8")
    backend = Backend(
        root=tmp_path,
        link_factory=lambda url: Link(url, open_port=fake_opener(fake)),
        jobs_dir=tmp_path / "jobs",
        config_path=tmp_path / "config.json",
        cam_dir=cam_dir,
    )
    app = create_app(backend, frontend=tmp_path / "no-dist")
    with TestClient(app) as client:
        client.backend = backend
        client.cam_dir = cam_dir
        yield client


def upload(client, profile_id: str, paths: list[Path], **fields) -> dict:
    files = [("files", (path.name, path.read_bytes(), "application/octet-stream")) for path in paths]
    response = client.post(f"/api/cam/{profile_id}/jobs", files=files, data=fields)
    assert response.status_code == 200, response.text
    return response.json()


def test_the_profiles_are_listed_with_the_broken_one_named(client):
    listed = client.get("/api/cam").json()
    assert [p["id"] for p in listed["profiles"]] == ["cartesian-laser", "mill-3axis"]
    mill = listed["profiles"][1]
    assert mill["name"] == "3 axis mill" and mill["kinematics"] == "cartesian" and mill["tools"] == ["spindle"]
    assert mill["axes"] == "XYZ" and mill["operations"] == 3 and mill["machine"] is None
    assert len(listed["problems"]) == 1 and "broken.toml" in listed["problems"][0] and "radius and angle" in listed["problems"][0]
    document = client.get("/api/cam/mill-3axis").json()
    assert document["text"].startswith("# A standard three axis mill")
    assert [a["letter"] for a in document["document"]["axes"]] == ["X", "Y", "Z"]
    assert document["document"]["operations"][3]["cutting"]["passes"] == 3
    assert document["document"]["post"]["spinup"] == 2 and document["document"]["placement"]["anchor"] == "corner"
    assert client.get("/api/cam/nope").status_code == 404
    assert client.get("/api/cam/broken").status_code == 400
    assert client.get("/api/cam/Not%20This").status_code == 400


def test_a_profile_is_saved_whole_patched_in_place_and_removed(client):
    text = (SHIPPED / "mill-3axis.toml").read_text(encoding="utf-8").replace('name = "3 axis mill"', 'name = "Bench mill"')
    saved = client.put("/api/cam/bench", json={"text": text})
    assert saved.status_code == 200, saved.text
    assert saved.json()["document"]["name"] == "Bench mill"
    assert (client.cam_dir / "bench.toml").read_text(encoding="utf-8") == text
    assert "bench" in [p["id"] for p in client.get("/api/cam").json()["profiles"]]

    refused = client.put("/api/cam/bench", json={"text": text.replace("depth = 1.7", "depth = 70")})
    assert refused.status_code == 400 and "[[operations]] outline depth must be above 0 and at most 50" in refused.json()["detail"]
    assert (client.cam_dir / "bench.toml").read_text(encoding="utf-8") == text

    patched = client.patch("/api/cam/bench", json={"path": ["operations", 1, "enabled"], "value": True})
    assert patched.status_code == 200, patched.text
    assert patched.json()["document"]["operations"][1]["enabled"] is True
    assert "pattern = \"lines\"       # radial | rings | lines" in patched.json()["text"]
    patched = client.patch("/api/cam/bench", json={"path": ["operations", 0, "feed"], "value": 250})
    assert patched.json()["document"]["operations"][0]["cutting"]["feed"] == 250
    assert client.patch("/api/cam/bench", json={"path": ["operations", 7, "feed"], "value": 1}).status_code == 400
    assert client.patch("/api/cam/bench", json={"path": ["operations", 0, "feed"], "value": -1}).status_code == 400
    assert client.patch("/api/cam/nope", json={"path": ["name"], "value": "x"}).status_code == 404

    assert client.delete("/api/cam/bench").json() == {"deleted": "bench"}
    assert client.delete("/api/cam/bench").status_code == 404
    assert client.put("/api/cam/bad id", json={"text": text}).status_code == 400


def test_a_board_with_its_siblings_goes_through_the_mill_profile(client):
    answer = upload(client, "mill-3axis", BOARD_FILES, name="coupon")
    job, notes = answer["job"], answer["notes"]
    assert job["name"] == "coupon" and job["source"] == "gerber" and job["spot"] == 0.2
    labels = [(g["label"], g["enabled"], g["tool"]) for g in job["groups"]]
    assert labels[0] == ("isolation: loop 1 at 0.100 mm", True, "spindle")
    assert labels[2:] == [
        ("drills: 2 holes at the bit's size", True, "spindle"),
        ("drills: 1 holes milled round", True, "spindle"),
        ("outline: board outline", True, "spindle"),
    ]
    assert job["groups"][4]["passes"] == 3 and job["groups"][4]["depth"] == 1.7 and job["groups"][2]["power"] == 8000
    assert job["outline"] and job["copper"] and job["stats"]["moves"] > 0
    assert notes == []
    listed = client.get("/api/jobs").json()["jobs"]
    assert listed[0]["groups"][0]["tool"] == "spindle" and listed[0]["groups"][0]["paths"] == 32
    # The copper alone: no outline, no drills, and the notes say so.
    answer = upload(client, "mill-3axis", BOARD_FILES[:1])
    assert [g["label"] for g in answer["job"]["groups"]][2:] == []
    assert any("no drill file" in note for note in answer["notes"]) and any("no outline" in note for note in answer["notes"])


def test_an_svg_goes_through_the_paths_operation_of_the_laser_profile(client, tmp_path):
    svg = tmp_path / "coupon.svg"
    svg.write_text(SVG, encoding="utf-8")
    answer = upload(client, "cartesian-laser", [svg])
    job = answer["job"]
    cut = [g for g in job["groups"] if g["paths"]]
    assert [g["label"] for g in cut] == ["engraving: stroke #ff0000", "engraving: stroke #00ff00"]
    assert all(g["tool"] == "laser" and g["power"] == 300 and g["speed"] == 1200 for g in cut)
    xs = [p[0] for g in cut for path in g["paths"] for p in path]
    assert min(xs) == pytest.approx(10.0, abs=1e-6)  # the corner anchor plus the 10 mm offset
    assert any("isolation" in note for note in answer["notes"])
    refused = client.post("/api/cam/cartesian-laser/jobs", files=[("files", ("x.txt", b"hi", "text/plain"))])
    assert refused.status_code == 400 and "unknown file type" in refused.json()["detail"]
    assert client.post("/api/cam/nope/jobs", files=[("files", ("x.svg", SVG.encode(), "image/svg+xml"))]).status_code == 404


def test_a_job_is_written_as_gcode_for_the_profile(client):
    job = upload(client, "mill-3axis", BOARD_FILES)["job"]
    answer = client.post("/api/cam/mill-3axis/gcode", json={"job": job["id"]})
    assert answer.status_code == 200, answer.text
    written = answer.json()
    assert written["filename"] == "board-F_Cu.nc"
    text = written["text"]
    assert text.startswith("(board-F_Cu: 4 operations through 3 axis mill)") and "M3 S12000" in text and "G1 Z-0.100 F60.000" in text
    assert "G1 Z-1.800 F50.000" in text and text.endswith("M5\nM2\n")
    report = written["report"]
    assert report["extents"]["Z"][0] == -1.8 and report["lines"] > 100 and report["warnings"] == []
    assert client.post("/api/cam/mill-3axis/gcode", json={"job": "nope"}).status_code == 404
    # The laser profile has no depth axis for a milled job.
    refused = client.post("/api/cam/cartesian-laser/gcode", json={"job": job["id"]})
    assert refused.status_code == 400 and "needs a depth axis" in refused.json()["detail"]


def test_a_run_refuses_a_group_made_for_the_other_tool(client, fake):
    job = upload(client, "mill-3axis", BOARD_FILES)["job"]
    client.post("/api/connect", json={"url": "socket://127.0.0.1:9999"})
    refused = client.post(f"/api/jobs/{job['id']}/run", json={})
    assert refused.status_code == 400, refused.text
    assert "made for a spindle and this machine has a laser" in refused.json()["detail"]
    # With every spindle group switched off there is nothing left to cut.
    patch = {"groups": [{"index": i, "enabled": False} for i in range(len(job["groups"]))]}
    assert client.patch(f"/api/jobs/{job['id']}", json=patch).status_code == 200
    refused = client.post(f"/api/jobs/{job['id']}/run", json={})
    assert refused.status_code in (400, 409)
