"""Probing, the height map routes and compensated runs, through the HTTP API
on a link to the fake firmware."""

from __future__ import annotations

import json
import math
import re
import time

import pytest
from fake_serial import FakeSerial, fake_opener
from fastapi.testclient import TestClient

from spinny_web.app import Backend, create_app
from spinny_web.link import Link

WORD = re.compile(r"([A-Z])(-?\d+(?:\.\d+)?)")


def surface(x: float, y: float) -> float:
    return -1.5 + 0.01 * x - 0.02 * y


@pytest.fixture
def fake():
    fake = FakeSerial(move_time=0.002)
    fake.settings["h_axis"] = 1
    fake.surface = surface
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


def wait_probe(client, timeout: float = 10.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        state = client.get("/api/heightmap").json()
        if state["probe"] is not None and state["probe"]["state"] != "running":
            return state
        time.sleep(0.02)
    raise AssertionError("probing did not end")


def probe(client, **grid) -> dict:
    body = {"x0": -10, "y0": -5, "x1": 10, "y1": 5, "nx": 3, "ny": 2, **grid}
    response = client.post("/api/heightmap/probe", json=body)
    assert response.status_code == 200, response.text
    return wait_probe(client)


def words(line: str) -> dict[str, float]:
    return {letter: float(value) for letter, value in WORD.findall(line)}


def test_the_snapshot_carries_the_focus_axis_and_the_probe(client, fake):
    client.post("/api/realtime", json={"action": "status"})
    machine = client.get("/api/state").json()["machine"]
    assert machine["joint"]["h"] == 0.0
    assert machine["probe"] is False
    fake.h = -2.0
    client.post("/api/realtime", json={"action": "status"})
    assert client.get("/api/state").json()["machine"]["probe"] is True


def test_probing_fills_the_map_with_the_board_under_each_point(client, fake, tmp_path):
    state = probe(client)
    assert state["probe"]["state"] == "done", state["probe"]
    assert state["probe"]["done"] == state["probe"]["total"] == 6
    heightmap = state["map"]
    for iy, y in enumerate([-5, 5]):
        for ix, x in enumerate([-10, 0, 10]):
            assert heightmap["heights"][iy][ix] == pytest.approx(surface(x, y), abs=1e-4)
    # Kept on disk, and the head back at the travel height it started at.
    assert json.loads((tmp_path / "heightmap.json").read_text())["heights"] == heightmap["heights"]
    assert fake.h == 0.0
    # Each point: the move there, a fast touch, the back-off, a slow touch,
    # and the rise, in that order and nothing else.
    lines = [line for line in fake.received_lines if line.split()[0] in ("go", "probe")]
    first = lines[:5]
    assert first[0].startswith("go R10 A180") or first[0].startswith("go R11.18")
    assert first[1] == "probe H-5 F60"
    assert first[2].startswith("go H-1")
    assert first[3] == "probe H-0.6 F15"
    assert first[4] == "go H0.0000"
    assert len(lines) == 5 * 6


def test_the_probe_offset_puts_the_tip_over_each_point(client, fake):
    fake.probe_offset = (3.0, -2.0)
    response = client.put("/api/heightmap/settings", json={"offset": [3.0, -2.0], "slow": 0})
    assert response.status_code == 200, response.text
    assert response.json()["settings"]["offset"] == [3.0, -2.0]
    state = probe(client)
    assert state["probe"]["state"] == "done"
    assert state["map"]["probe_offset"] == [3.0, -2.0]
    for iy, y in enumerate([-5, 5]):
        for ix, x in enumerate([-10, 0, 10]):
            assert state["map"]["heights"][iy][ix] == pytest.approx(surface(x, y), abs=1e-4)
    # One touch per point without a slow speed.
    assert sum(line.startswith("probe") for line in fake.received_lines) == 6


def test_a_miss_stops_probing_and_leaves_the_alarm(client, fake):
    fake.surface = lambda x, y: None if x > 5 else surface(x, y)
    state = probe(client)
    assert state["probe"]["state"] == "error"
    assert "probe missed" in state["probe"]["error"]
    assert state["map"]["heights"][0][:2] == [pytest.approx(surface(-10, -5), abs=1e-4), pytest.approx(surface(0, -5), abs=1e-4)]
    assert state["map"]["heights"][0][2] is None
    assert fake.alarm == 2
    # Nothing after the miss.
    assert fake.received_lines[-1].startswith("probe")


def test_probing_is_refused_without_a_focus_axis_or_with_the_probe_down(client, fake):
    fake.settings["h_axis"] = 0
    body = {"x0": -10, "y0": -5, "x1": 10, "y1": 5}
    response = client.post("/api/heightmap/probe", json=body)
    assert response.status_code == 409 and "focus axis" in response.json()["detail"]
    fake.settings["h_axis"] = 1
    fake.h = -3.0
    response = client.post("/api/heightmap/probe", json=body)
    assert response.status_code == 409 and "already touching" in response.json()["detail"]
    fake.h = 0.0
    response = client.post("/api/heightmap/probe", json={**body, "nx": 1})
    assert response.status_code == 400
    response = client.post("/api/heightmap/probe", json={**body, "x1": -20})
    assert response.status_code == 400
    fake.settings["r_max"] = 8
    response = client.post("/api/heightmap/probe", json=body)
    assert response.status_code == 409 and "r_max=8" in response.json()["detail"]
    assert not any(line.startswith(("go", "probe")) for line in fake.received_lines)


def test_nothing_else_moves_the_head_while_probing(client, fake):
    fake.move_time = 0.05
    response = client.post("/api/heightmap/probe", json={"x0": -10, "y0": -5, "x1": 10, "y1": 5, "nx": 5, "ny": 5})
    assert response.status_code == 200
    assert client.post("/api/jog", json={"kind": "joint", "dr": 1}).status_code == 409
    job = client.post("/api/center", json={}).json()["job"]
    assert client.post(f"/api/jobs/{job['id']}/run").status_code == 409
    assert client.post("/api/heightmap/focus", json={"offset": 1}).status_code == 409
    assert client.post("/api/heightmap/stop").status_code == 200
    state = client.get("/api/heightmap").json()
    assert state["probe"]["state"] == "stopped"
    assert client.post("/api/heightmap/stop").status_code == 409


def test_focus_here_takes_the_offset_from_the_head_over_the_board(client, fake):
    probe(client)
    assert client.post("/api/heightmap/focus", json={}).status_code == 200
    # The beam over board (5, 0), focused by eye 2 mm above the contact.
    client.post("/api/goto", json={"kind": "joint", "r": 5, "a": 0})
    fake.h = surface(5, 0) + 2.0
    response = client.post("/api/heightmap/focus", json={})
    assert response.status_code == 200, response.text
    heightmap = response.json()["map"]
    assert heightmap["focus_set"] is True
    assert heightmap["focus_offset"] == pytest.approx(2.0, abs=1e-3)
    response = client.post("/api/heightmap/focus", json={"offset": 1.5})
    assert response.json()["map"]["focus_offset"] == 1.5


def test_a_compensated_run_needs_a_usable_map(client, fake):
    job = client.post("/api/center", json={"reach": 4, "ring": 3}).json()["job"]
    run = lambda mode: client.post(f"/api/jobs/{job['id']}/run", json={"compensate": mode})  # noqa: E731
    assert "no height map" in run("focus").json()["detail"]
    probe(client)
    assert "focus offset" in run("focus").json()["detail"]
    client.post("/api/heightmap/focus", json={"offset": 2.0})
    assert run("sideways").status_code == 400
    fake.settings["h_axis"] = 0
    assert "not fitted" in run("focus").json()["detail"]


def test_a_focus_run_follows_the_map(client, fake):
    probe(client, x0=-10, y0=-10, x1=10, y1=10, nx=3, ny=3)
    client.post("/api/heightmap/focus", json={"offset": 2.0})
    job = client.post("/api/center", json={"reach": 4, "ring": 3}).json()["job"]
    before = len(fake.received_lines)
    response = client.post(f"/api/jobs/{job['id']}/run", json={"compensate": "auto"})
    assert response.status_code == 200, response.text
    deadline = time.monotonic() + 20
    while client.get("/api/run").json()["state"] == "running" and time.monotonic() < deadline:
        time.sleep(0.05)
    assert client.get("/api/run").json()["state"] == "done"
    sent = fake.received_lines[before:]
    motion = [line for line in sent if line.split()[0] in ("go", "cut")]
    assert motion and all("H" in words(line) for line in motion)
    for line in motion:
        w = words(line)
        if "R" not in w:
            continue
        x = w["R"] * math.cos(math.radians(w["A"]))
        y = w["R"] * math.sin(math.radians(w["A"]))
        assert w["H"] == pytest.approx(surface(x, y) + 2.0, abs=1e-3)


def test_a_power_run_raises_the_power_and_leaves_the_head(client, fake):
    probe(client, x0=-10, y0=-10, x1=10, y1=10, nx=3, ny=3)
    client.post("/api/heightmap/focus", json={"offset": 0.0})
    client.put("/api/heightmap/settings", json={"rayleigh": 0.2})
    job = client.post("/api/center", json={"reach": 4, "ring": 3, "power": 200}).json()["job"]
    before = len(fake.received_lines)
    response = client.post(f"/api/jobs/{job['id']}/run", json={"compensate": "power"})
    assert response.status_code == 200, response.text
    deadline = time.monotonic() + 20
    while client.get("/api/run").json()["state"] == "running" and time.monotonic() < deadline:
        time.sleep(0.05)
    sent = fake.received_lines[before:]
    cuts = [words(line) for line in sent if line.startswith("cut")]
    assert cuts and all("H" not in w for w in cuts)
    # The head sits at 0, 1.5 mm or so above the board everywhere here:
    # the power goes up, and more where the board is lower.
    assert all(w["S"] > 200 for w in cuts)


def test_the_map_can_be_put_back_and_cleared(client, tmp_path):
    heightmap = {
        "grid": {"x0": 0, "y0": 0, "x1": 10, "y1": 10, "nx": 2, "ny": 2},
        "heights": [[0.0, 0.1], [0.2, 0.3]],
        "focus_offset": 1.0,
        "focus_set": True,
    }
    response = client.put("/api/heightmap", json=heightmap)
    assert response.status_code == 200, response.text
    assert response.json()["map"]["heights"] == heightmap["heights"]
    assert client.put("/api/heightmap", json={**heightmap, "heights": [[0.0]]}).status_code == 400
    assert client.put("/api/heightmap", json={**heightmap, "focus_offset": "nan"}).status_code == 422
    assert client.delete("/api/heightmap").json()["map"] is None
    assert not (tmp_path / "heightmap.json").exists()


def test_probe_settings_are_kept_and_checked(client, tmp_path):
    response = client.put("/api/heightmap/settings", json={"depth": 3, "feed": 100})
    assert response.status_code == 200
    settings = response.json()["settings"]
    assert settings["depth"] == 3 and settings["feed"] == 100 and settings["slow"] == 15
    assert json.loads((tmp_path / "config.json").read_text())["probe"]["depth"] == 3
    assert client.put("/api/heightmap/settings", json={"backoff": 10}).status_code == 400
    assert client.get("/api/heightmap").json()["settings"]["depth"] == 3


def test_focus_jogs_and_positions(client, fake):
    response = client.post("/api/jog", json={"kind": "joint", "dh": 0.5, "feed": 60})
    assert response.json() == {"lines": ["jog H0.5 F60"]}
    response = client.post("/api/goto", json={"kind": "joint", "h": -1.25})
    assert response.json() == {"lines": ["jogto H-1.25"]}
    assert client.post("/api/position", json={"h": 2}).status_code == 200
    assert fake.h == 2.0
    response = client.post("/api/jog", json={"kind": "joint", "dz": 1, "dh": 1})
    assert response.status_code == 400
