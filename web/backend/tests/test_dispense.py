"""Dispensing: dots of paste on a machine whose table joint is a plunger."""

from __future__ import annotations

import json
import re
import shutil
import time
from pathlib import Path

import pytest
from fake_serial import FakeSerial, fake_opener
from fastapi.testclient import TestClient

from spinny_web.app import Backend, create_app, profile_of
from spinny_web.jobs import Group, Job
from spinny_web.kinematics import CartesianStreamer, Dispense, Rates
from spinny_web.link import Link

REPO = Path(__file__).resolve().parents[3]
BOARD_SAMPLE = REPO / "toolpath" / "tests" / "data" / "board.kicad_pcb"
WORD = re.compile(r"([A-Z])(-?\d+(?:\.\d+)?)")


def words(line: str) -> dict[str, float]:
    return {k: float(v) for k, v in WORD.findall(line.split(" ", 1)[1])} if " " in line else {}


def dots_job(*points: tuple[float, float], areas: list[float] | None = None, thickness: float = 0.12) -> Job:
    return Job(
        groups=[
            Group(
                label="paste dots",
                tool="dispenser",
                thickness=thickness,
                paths=[[p] for p in points],
                areas=areas if areas is not None else [1.0] * len(points),
            )
        ]
    )


def test_a_dot_is_a_lower_a_push_a_wait_a_pull_back_and_a_lift():
    streamer = CartesianStreamer(dispense=Dispense(gap=0.1, retract=0.2, output=100.0, rate=60.0, dwell_ms=200), rates=Rates(a_rate=300.0))
    pieces = list(streamer.job_pieces(dots_job((1.0, 2.0), (3.0, 2.0), areas=[1.0, 2.0]), (0.0, 0.0)))
    kinds = [p.kind for p in pieces]
    assert kinds == ["plunger", "lift", "go", "lower", "extrude", "dwell", "retract", "lift", "go", "lower", "extrude", "dwell", "retract", "lift"]
    assert pieces[0].line == "set A0" and pieces[1].line == "go H2.0000"
    assert pieces[2].line == "go R1.000 Z2.000" and pieces[3].line == "go H0.1000"
    # The first dot pushes its volume (1 mm^2 * 0.12 mm over 100 mm^3/mm) plus the retract, then pulls the retract back.
    assert words(pieces[4].line) == {"A": 0.2012, "F": 60.0} and pieces[4].line.startswith("cut ")
    assert pieces[5].line == "dwell T200" and pieces[6].line == "go A0.0012"
    # The second dot starts from where the plunger was left.
    assert words(pieces[10].line)["A"] == pytest.approx(0.0012 + 0.2 + 0.0024)
    assert pieces[12].line == "go A0.0036"
    assert pieces[4].seconds == pytest.approx(0.2012 / 60.0 * 60.0) and pieces[6].seconds == pytest.approx(0.2 / 300.0 * 60.0)
    stats = streamer.estimate(dots_job((1.0, 2.0)), (0.0, 0.0))
    assert stats.moves == 8 and stats.length_mm == 0.0


def test_a_dispenser_follows_the_height_map_with_its_gap():
    from spinny_web.heightmap import Compensation, Grid, HeightMap

    grid = Grid(x0=0.0, y0=0.0, x1=10.0, y1=10.0, nx=2, ny=2)
    heightmap = HeightMap(grid=grid, heights=[[-1.0, -1.0], [-2.0, -2.0]], focus_offset=0.0, focus_set=True)
    compensation = Compensation(heightmap=heightmap, mode="focus", head_h=5.0, rayleigh=0.5, s_max=1000.0)
    streamer = CartesianStreamer(dispense=Dispense(gap=0.1, clearance=2.0))
    pieces = list(streamer.job_pieces(dots_job((5.0, 0.0), (5.0, 10.0)), (0.0, 0.0), compensation))
    lowers = [p for p in pieces if p.kind == "lower"]
    # Travel clears the highest point by the clearance; each needle height is the surface there plus the gap.
    assert pieces[1].line == "go H1.0000"
    assert [p.line for p in lowers] == ["go H-0.9000", "go H-1.9000"]


def test_a_dispenser_refuses_paths_and_dots_without_areas():
    streamer = CartesianStreamer(dispense=Dispense())
    paths = Job(groups=[Group(label="outline", paths=[[(0.0, 0.0), (1.0, 0.0)]])])
    with pytest.raises(ValueError, match="dispenser, which lays dots"):
        streamer.check_job(paths)
    bare = Job(groups=[Group(label="dots", tool="dispenser", paths=[[(0.0, 0.0)]])])
    with pytest.raises(ValueError, match="pad's area"):
        list(streamer.job_pieces(bare, (0.0, 0.0)))
    milled = Job(groups=[Group(label="pocket", tool="spindle", paths=[[(0.0, 0.0), (1.0, 0.0)]])])
    with pytest.raises(ValueError, match="made for a spindle and this machine has a dispenser"):
        streamer.check_job(milled)
    # And a laser machine refuses a dispensing group.
    with pytest.raises(ValueError, match="made for a dispenser and this machine has a laser"):
        CartesianStreamer().check_job(dots_job((0.0, 0.0)))
    with pytest.raises(ValueError, match="retract must be 0 to 50"):
        Dispense(retract=-1.0)


def test_picking_a_dispensing_run_up_declares_the_plunger_and_lowers_mid_dot():
    streamer = CartesianStreamer(dispense=Dispense(gap=0.1, retract=0.2, output=100.0), rates=Rates(a_rate=300.0))
    job = dots_job((1.0, 2.0), (3.0, 2.0), areas=[1.0, 2.0])
    pieces = list(streamer.job_pieces(job, (0.0, 0.0)))
    # Picked up at the second dot's go: the plunger reads what the first dot
    # left, and the head stands where that go begins, over the first dot.
    assert streamer.approach(pieces, 8, job, None) == ["set A0.0012", "go H2.0000", "go R1.000 Z2.000"]
    # Picked up at the second dot's dwell: the plunger is pushed out and
    # not yet pulled back, and the needle goes down to the gap as well.
    assert streamer.approach(pieces, 11, job, None) == ["set A0.2036", "go H2.0000", "go R3.000 Z2.000", "go H0.1000"]


@pytest.fixture
def fake():
    fake = FakeSerial(move_time=0.002)
    fake.settings.update({"cartesian": 1, "dispenser": 1, "h_axis": 1, "z_max": 100, "r_max": 100})
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


def wait_run(client, timeout: float = 20.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        run = client.get("/api/run").json()
        if run and run["state"] != "running":
            return run
        time.sleep(0.02)
    raise AssertionError("the run did not end")


def test_the_profile_and_the_controls_say_dispenser(client, fake):
    assert profile_of({"cartesian": 1, "dispenser": 1}) == {"kinematics": "cartesian", "tool": "dispenser", "h_axis": False, "r_max": 0.0, "z_max": 0.0}
    assert profile_of({"cartesian": 0, "dispenser": 1})["tool"] == "laser"
    assert profile_of({"cartesian": 1, "dispenser": 1, "spindle": 1})["tool"] == "spindle"
    state = client.get("/api/state").json()
    assert state["profile"]["tool"] == "dispenser"
    settings = client.get("/api/settings").json()
    assert [axis["letter"] for axis in settings["controls"]["axes"]] == ["X", "Y", "E", "H"]
    assert settings["host"]["gap"] == 0.1 and settings["host"]["dwell_ms"] == 200
    assert any(entry["name"] == "dispenser" for entry in settings["schema"])


def test_the_dispensing_values_are_host_settings(client):
    response = client.put("/api/settings", json={"host": {"gap": 0.15, "retract": 0.3, "output": 120, "extrude_rate": 90, "dwell_ms": 300}})
    assert response.status_code == 200, response.text
    host = response.json()["host"]
    assert (host["gap"], host["retract"], host["output"], host["extrude_rate"], host["dwell_ms"]) == (0.15, 0.3, 120.0, 90.0, 300)
    assert client.put("/api/settings", json={"host": {"gap": 0}}).status_code == 400
    assert client.put("/api/settings", json={"host": {"dwell_ms": 70000}}).status_code == 400
    # Kept across a read.
    assert client.get("/api/settings").json()["host"]["retract"] == 0.3


def test_a_dispensing_job_runs_as_dots(client, fake):
    job = dots_job((1.0, 2.0), (3.0, 2.0), areas=[1.0, 2.0])
    response = client.post("/api/jobs", files={"file": ("dots.json", job.model_dump_json().encode())})
    assert response.status_code == 200, response.text
    stored = response.json()
    assert stored["groups"][0]["tool"] == "dispenser" and stored["groups"][0]["areas"] == [1.0, 2.0]
    assert stored["groups"][0]["thickness"] == 0.12 and stored["rotation"] == 0
    response = client.post(f"/api/jobs/{stored['id']}/run")
    assert response.status_code == 200, response.text
    run = wait_run(client)
    assert run["state"] == "done", run
    sent = [line for line in fake.received_lines if line.split(" ")[0] in ("set", "go", "cut", "dwell")]
    assert sent[0] == "set A0" and sent[1] == "go H2.0000"
    assert "cut A0.2012 F60" in sent and "go A0.0012" in sent and "dwell T200" in sent
    assert fake.joint[1] == pytest.approx(0.0036)
    # A thickness patch changes the dots' volumes.
    response = client.patch(f"/api/jobs/{stored['id']}", json={"groups": [{"index": 0, "thickness": 0.24}]})
    assert response.status_code == 200 and response.json()["groups"][0]["thickness"] == 0.24
    assert client.patch(f"/api/jobs/{stored['id']}", json={"groups": [{"index": 0, "thickness": 9}]}).status_code == 400


def test_a_path_job_is_refused_on_a_dispenser(client):
    job = Job(groups=[Group(label="outline", paths=[[(0.0, 0.0), (1.0, 0.0)]])])
    stored = client.post("/api/jobs", files={"file": ("lines.json", job.model_dump_json().encode())}).json()
    response = client.post(f"/api/jobs/{stored['id']}/run")
    assert response.status_code == 400 and "lays dots" in response.json()["detail"]


def test_a_dispenser_needs_the_height_axis(client, fake):
    fake.settings["h_axis"] = 0
    stored = client.post("/api/jobs", files={"file": ("dots.json", dots_job((1.0, 2.0)).model_dump_json().encode())}).json()
    response = client.post(f"/api/jobs/{stored['id']}/run")
    assert response.status_code == 400 and "needle's height" in response.json()["detail"]


@pytest.mark.skipif(not BOARD_SAMPLE.exists() or shutil.which("kicad-cli") is None, reason="needs the sample board and kicad-cli")
def test_a_board_imports_as_paste_dots_with_its_pads(client):
    with BOARD_SAMPLE.open("rb") as handle:
        response = client.post("/api/jobs", files={"file": ("board.kicad_pcb", handle)}, data={"mode": "dispense", "thickness": "0.15"})
    assert response.status_code == 200, response.text
    job = response.json()
    assert job["layer"] == "F.Paste" and [g["label"] for g in job["groups"]] == ["paste dots"]
    group = job["groups"][0]
    assert len(group["paths"]) == 32 == len(group["areas"]) and all(len(path) == 1 for path in group["paths"])
    assert group["thickness"] == 0.15 and group["tool"] == "dispenser"
    assert len(job["pads"]) == 32 and job["design"]["board"] is True and job["design"]["rotation"] == 0
    # The dots sit on the pads, which sit where an isolation import puts the copper.
    assert sorted(tuple(p[0]) for p in group["paths"]) == sorted((x, y) for x, y, _ in job["pads"])
    summary = client.get("/api/jobs").json()["jobs"][0]
    assert summary["pads"] == 32 and summary["groups"][0]["areas"] == 32
    # The board file is kept beside the job for the camera.
    assert (client.backend.store.directory / f"{job['id']}.kicad_pcb").is_file()
    assert client.delete(f"/api/jobs/{job['id']}").status_code == 200
    assert not (client.backend.store.directory / f"{job['id']}.kicad_pcb").exists()
