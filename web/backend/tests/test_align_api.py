"""Lining a job up with the board: marks from the tool and the camera,
the fit and its application."""

from __future__ import annotations

import math

import pytest
from fake_serial import FakeSerial, fake_opener
from fastapi.testclient import TestClient

from spinny_web.align import Alignment
from spinny_web.app import Backend, create_app
from spinny_web.jobs import Design, Group, Job
from spinny_web.link import Link


def padded_job() -> Job:
    return Job(
        groups=[Group(label="isolation", paths=[[(0.0, 0.0), (10.0, 0.0)]])],
        pads=[(0.0, 0.0, 1.0), (10.0, 0.0, 1.0), (10.0, 20.0, 1.0)],
        holes=[(5.0, 5.0, 0.8)],
        design=Design(shift=(-50.0, 40.0), rotation=0.0, board=False),
    )


def test_marks_pair_with_the_nearest_pad_or_hole_and_fit_a_turn_and_a_shift():
    alignment = Alignment()
    job = padded_job()
    job.id = "j1"
    with pytest.raises(ValueError, match="no pad of the job within"):
        alignment.mark_tool(job, (20.0, 20.0), None, "pad", 5.0)
    state = alignment.mark_tool(job, (0.3, -0.1), None, "pad", 5.0)
    assert state["job"] == "j1" and state["marks"][0]["kind"] == "pad" and state["marks"][0]["design"] == [0.0, 0.0]
    assert state["marks"][0]["distance"] == pytest.approx(math.hypot(0.3, 0.1), abs=1e-4)
    assert state["fit"]["rotation"] == 0.0 and state["fit"]["shift"] == [0.3, -0.1]
    state = alignment.mark_tool(job, (5.2, 5.1), None, "hole", 1.0)
    assert state["marks"][1]["kind"] == "hole" and state["fit"]["marks"] == 2
    state = alignment.mark_tool(job, (10.4, 20.0), (10.0, 20.0), None, 5.0)
    assert state["marks"][2]["kind"] == "point" and all(m["residual"] is not None for m in state["marks"])
    fit = alignment.fit("j1")
    assert fit.marks == 3 and fit.rms < 0.2
    assert alignment.remove(1)["fit"]["marks"] == 2
    with pytest.raises(IndexError):
        alignment.remove(5)
    other = padded_job()
    other.id = "j2"
    assert alignment.mark_tool(other, (0.0, 0.0), (0.0, 0.0), None, 5.0)["job"] == "j2"
    assert len(alignment.marks) == 1
    with pytest.raises(ValueError, match="no marks for this job"):
        alignment.fit("j1")


def test_applying_the_fit_turns_and_shifts_the_whole_job():
    alignment = Alignment()
    job = padded_job()
    job.id = "j1"
    # The board sits turned 90 degrees and moved by (1, 2).
    for design in [(0.0, 0.0), (10.0, 0.0), (10.0, 20.0)]:
        machine = (-design[1] + 1.0, design[0] + 2.0)
        alignment.mark_tool(job, machine, design, None, 5.0)
    updated, fit = alignment.apply(job)
    assert fit.rotation == pytest.approx(90.0) and fit.shift == pytest.approx((1.0, 2.0)) and fit.rms == pytest.approx(0.0, abs=1e-9)
    assert updated.rotation == pytest.approx(90.0) and (updated.offset.x, updated.offset.y) == pytest.approx((1.0, 2.0))
    assert updated.groups[0].paths[0][1] == pytest.approx((1.0, 12.0))
    assert updated.pads[2][:2] == pytest.approx((-19.0, 12.0)) and updated.holes[0][:2] == pytest.approx((-4.0, 7.0))
    assert updated.design is not None and updated.design.rotation == pytest.approx(90.0)
    # The design map follows: a gerber point lands where the turned job has it.
    gerber_point = (60.0, -40.0)
    assert updated.design.to_job(gerber_point) == pytest.approx((1.0 - 0.0, 2.0 + 10.0))
    assert alignment.marks == [] and job.rotation == 0.0


@pytest.fixture
def fake():
    fake = FakeSerial(move_time=0.002)
    fake.settings.update({"cartesian": 1, "z_max": 100, "r_max": 100})
    return fake


@pytest.fixture
def client(tmp_path, fake):
    backend = Backend(
        root=tmp_path,
        link_factory=lambda url: Link(url, open_port=fake_opener(fake)),
        jobs_dir=tmp_path / "jobs",
        config_path=tmp_path / "config.json",
    )
    app = create_app(backend, frontend=tmp_path / "no-dist")
    with TestClient(app) as client:
        client.backend = backend
        response = client.post("/api/connect", json={"url": "socket://127.0.0.1:9999"})
        assert response.status_code == 200, response.text
        yield client


def test_marks_from_the_tool_align_a_job_through_the_api(client, fake):
    stored = client.post("/api/jobs", files={"file": ("padded.json", padded_job().model_dump_json().encode())}).json()
    assert client.get("/api/align").json() == {"job": None, "marks": [], "fit": None}
    fake.joint[0], fake.z = 0.5, 0.0
    response = client.post("/api/align/mark", json={"job": stored["id"], "nearest": "pad"})
    assert response.status_code == 200, response.text
    assert response.json()["marks"][0]["machine"] == [0.5, 0.0] and response.json()["marks"][0]["design"] == [0.0, 0.0]
    fake.joint[0], fake.z = 10.5, 0.2
    response = client.post("/api/align/mark", json={"job": stored["id"], "nearest": "pad", "within": 2.0})
    assert response.status_code == 200 and len(response.json()["marks"]) == 2
    fit = client.post("/api/align/fit", json={"job": stored["id"]}).json()
    assert fit["marks"] == 2 and fit["rotation"] == pytest.approx(math.degrees(math.atan2(0.2, 10.0)), abs=1e-3)
    assert client.post("/api/align/mark", json={"job": stored["id"], "nearest": "hole", "within": 0.5}).status_code == 400
    assert client.post("/api/align/mark", json={"job": stored["id"]}).status_code == 400
    assert client.post("/api/align/mark", json={"job": "nope", "nearest": "pad"}).status_code == 404
    assert client.delete("/api/align/marks/7").status_code == 404
    response = client.post("/api/align/apply", json={"job": stored["id"]})
    assert response.status_code == 200, response.text
    job = response.json()["job"]
    assert job["rotation"] == pytest.approx(fit["rotation"], abs=1e-3) and job["offset"]["x"] == pytest.approx(fit["shift"][0], abs=1e-3)
    assert client.get("/api/align").json()["marks"] == []
    assert client.get(f"/api/jobs/{stored['id']}").json()["rotation"] == pytest.approx(fit["rotation"], abs=1e-3)
    assert client.post("/api/align/fit", json={"job": stored["id"]}).status_code == 400
    # Marks are kept per job; a mark on another job starts over, and clear empties them.
    other = client.post("/api/jobs", files={"file": ("other.json", padded_job().model_dump_json().encode())}).json()
    assert client.post("/api/align/mark", json={"job": other["id"], "design": [1.0, 1.0]}).json()["job"] == other["id"]
    assert client.delete("/api/align").json()["marks"] == []


class LockedCamera:
    running = True
    board_job = None

    def __init__(self, center, angle):
        self.center = center
        self.angle = angle

    def pose(self):
        return {"state": "locked", "center": list(self.center), "angle_deg": self.angle, "width": 640, "height": 480}

    def close(self):
        pass


def test_a_capture_pairs_the_pictures_center_with_the_tool_plus_the_offset(client, fake):
    stored = client.post("/api/jobs", files={"file": ("padded.json", padded_job().model_dump_json().encode())}).json()
    response = client.post("/api/align/capture", json={"job": stored["id"]})
    assert response.status_code == 409 and "not running" in response.json()["detail"]
    camera = client.backend.camera
    camera.client = LockedCamera((55.0, 38.0), 1.0)
    response = client.post("/api/align/capture", json={"job": stored["id"]})
    assert response.status_code == 409 and "not looking for this job" in response.json()["detail"]
    camera.board_job = stored["id"]
    client.put("/api/camera/settings", json={"offset": [12.0, -3.0], "roll": 0.4})
    fake.joint[0], fake.z = 2.0, 1.0
    response = client.post("/api/align/capture", json={"job": stored["id"]})
    assert response.status_code == 200, response.text
    mark = response.json()["marks"][0]
    # The design point: the KiCad center (55, 38) in the gerber frame is (55, -38), shifted by the design's (-50, 40).
    assert mark["design"] == [5.0, 2.0] and mark["machine"] == [14.0, -2.0] and mark["source"] == "camera"
    assert mark["angle"] == pytest.approx(0.4 - 1.0) and mark["kind"] == "center"
    fit = response.json()["fit"]
    assert fit["rotation"] == pytest.approx(-0.6) and fit["marks"] == 1
