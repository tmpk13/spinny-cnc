"""Probing, the height map routes and compensated runs, through the HTTP API
on a link to the fake firmware."""

from __future__ import annotations

import json
import math
import os
import re
import socket
import subprocess
import threading
import time
from pathlib import Path

import pytest
from fake_serial import FakeSerial, fake_opener
from fastapi import HTTPException
from fastapi.testclient import TestClient

from spinny_web import prober as prober_module
from spinny_web.app import Backend, create_app
from spinny_web.heightmap import Grid, HeightMapStore
from spinny_web.kinematics import Streamer
from spinny_web.link import Link, LinkTimeout
from spinny_web.prober import Prober, ProberError, ProbeSettings

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
    # Nor does anything change the machine under it between two points.
    assert client.post("/api/motors", json={"enabled": False}).status_code == 409
    assert client.put("/api/settings", json={"values": {"h_rate": 300}}).status_code == 409
    assert client.post("/api/position", json={"h": 0}).status_code == 409
    assert not any(line.split()[0] in ("disable", "$h_rate=300", "set") for line in fake.received_lines)
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
    # Its heights are in a focus axis frame nothing here knows: it needs
    # focus here before a run follows it, and a number will not do.
    assert response.json()["map"]["focus_set"] is False
    assert json.loads((tmp_path / "heightmap.json").read_text())["focus_set"] is False
    response = client.post("/api/heightmap/focus", json={"offset": 1.0})
    assert response.status_code == 400 and "renumbered" in response.json()["detail"]
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


def wait_until(predicate, timeout: float = 3.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return predicate()


def backend_for(tmp_path, make_fake) -> tuple[Backend, list[FakeSerial]]:
    """A backend whose every connect opens a fresh fake from `make_fake`."""
    fakes: list[FakeSerial] = []

    def factory(url: str) -> Link:
        fakes.append(make_fake())
        return Link(url, open_port=fake_opener(fakes[-1]))

    backend = Backend(
        root=tmp_path, link_factory=factory, jobs_dir=tmp_path / "jobs", config_path=tmp_path / "config.json"
    )
    return backend, fakes


def focus_fake(fake_class=FakeSerial, **options) -> FakeSerial:
    fake = fake_class(**options)
    fake.settings["h_axis"] = 1
    fake.surface = surface
    return fake


def test_a_run_and_probing_asked_for_together_do_not_both_start(client, fake, monkeypatch):
    fake.move_time = 0.05
    backend = client.backend
    job = client.post("/api/center", json={}).json()["job"]
    # Each start reads the settings between its check and its claim: made
    # slow, the two requests are both in that gap at once.
    read = backend.read_settings

    def slow_read(force: bool = False) -> dict:
        time.sleep(0.2)
        return read(force)

    monkeypatch.setattr(backend, "read_settings", slow_read)
    grid = Grid(x0=-10, y0=-5, x1=10, y1=5, nx=3, ny=2)
    barrier = threading.Barrier(2)
    outcomes: dict[str, str] = {}

    def attempt(name, call) -> None:
        barrier.wait()
        try:
            call()
            outcomes[name] = "started"
        except HTTPException as exc:
            outcomes[name] = f"{exc.status_code} {exc.detail}"
        except Exception as exc:
            outcomes[name] = repr(exc)

    threads = [
        threading.Thread(target=attempt, args=("run", lambda: backend.run_job(job["id"]))),
        threading.Thread(target=attempt, args=("probe", lambda: backend.start_probe(grid))),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=20.0)
    started = [name for name, outcome in outcomes.items() if outcome == "started"]
    try:
        assert len(started) == 1, outcomes
        # The other was turned away for the machine being taken, before it
        # sent anything, not by the machine being busy under it.
        other = "probe" if started == ["run"] else "run"
        assert outcomes[other] in ("409 a job is running", "409 the board is being probed"), outcomes
        assert not (backend.runner.active and backend.prober.active)
    finally:
        if backend.runner.active:
            client.post("/api/run/stop")
        if backend.prober.active:
            client.post("/api/heightmap/stop")


def test_probing_and_the_spindle_exclude_each_other(client, fake):
    fake.settings["spindle"] = 1
    client.backend.read_settings(force=True)
    assert client.post("/api/spindle", json={"power": 800}).status_code == 200
    assert fake.spindle == 800
    # The tool may be the probe: it is not lowered onto the copper turning.
    body = {"x0": -10, "y0": -5, "x1": 10, "y1": 5, "nx": 3, "ny": 2}
    response = client.post("/api/heightmap/probe", json=body)
    assert response.status_code == 409 and "spindle is turning" in response.json()["detail"]
    assert not any(line.split()[0] in ("go", "probe") for line in fake.received_lines)
    assert client.post("/api/spindle/off").status_code == 200
    fake.move_time = 0.05
    response = client.post("/api/heightmap/probe", json={**body, "nx": 5, "ny": 5})
    assert response.status_code == 200, response.text
    # Nor is it started while the board is probed; stopping it still works.
    response = client.post("/api/spindle", json={"power": 800})
    assert response.status_code == 409 and "probed" in response.json()["detail"]
    assert fake.spindle == 0
    assert client.post("/api/spindle/off").status_code == 200
    assert client.post("/api/heightmap/stop").status_code == 200


def test_focus_here_is_refused_with_the_beam_off_the_map(client, fake):
    probe(client)
    # Past the grid and its margin, the edge height would stand in for the
    # copper under the beam.
    client.post("/api/goto", json={"kind": "joint", "r": 20, "a": 0})
    response = client.post("/api/heightmap/focus", json={})
    assert response.status_code == 400 and "probed area" in response.json()["detail"]
    assert client.get("/api/heightmap").json()["map"]["focus_set"] is False
    # Within the margin a run may reach, it is taken.
    client.post("/api/goto", json={"kind": "joint", "r": 10.5, "a": 0})
    assert client.post("/api/heightmap/focus", json={}).status_code == 200


def focused(client) -> bool:
    return client.get("/api/heightmap").json()["map"]["focus_set"]


def test_the_offset_is_taken_back_when_the_focus_axis_is_renumbered(client, fake):
    probe(client)
    assert client.post("/api/heightmap/focus", json={"offset": 2.0}).status_code == 200
    assert focused(client)
    # Declaring H moves the frame the heights are in.
    assert client.post("/api/position", json={"h": 5}).status_code == 200
    assert not focused(client)
    job = client.post("/api/center", json={"reach": 4, "ring": 3}).json()["job"]
    response = client.post(f"/api/jobs/{job['id']}/run", json={"compensate": "focus"})
    assert response.status_code == 400 and "focus offset" in response.json()["detail"]
    # A number would put the old heights in the new frame; focus here takes
    # the difference with it.
    response = client.post("/api/heightmap/focus", json={"offset": 2.0})
    assert response.status_code == 400 and "renumbered" in response.json()["detail"]
    client.post("/api/goto", json={"kind": "joint", "r": 0, "a": 0})
    fake.h = surface(0, 0) + 5 + 2.0
    response = client.post("/api/heightmap/focus", json={})
    assert response.status_code == 200, response.text
    assert response.json()["map"]["focus_offset"] == pytest.approx(7.0, abs=1e-3)
    # That offset holds only for the old heights: probing again, in the new
    # frame, does not keep it.
    fake.h = 0.0
    state = probe(client)
    assert state["probe"]["state"] == "done"
    assert state["map"]["focus_set"] is False
    # Probed in this frame, a number holds, and probing again keeps it.
    assert client.post("/api/heightmap/focus", json={"offset": 2.0}).status_code == 200
    state = probe(client)
    assert state["map"]["focus_set"] is True and state["map"]["focus_offset"] == 2.0


def test_console_lines_that_change_the_machine_wait_for_probing_and_move_the_frame(client, fake):
    fake.move_time = 0.05
    body = {"x0": -10, "y0": -5, "x1": 10, "y1": 5, "nx": 3, "ny": 2}
    assert client.post("/api/heightmap/probe", json=body).status_code == 200
    # Typed while probing, as the buttons are: the probe may be the tool,
    # and a setting or a disable would land between two touches.
    for line in ("spindle S100", "disable", "set H1", "$h_steps=100"):
        response = client.post("/api/command", json={"line": line})
        assert response.status_code == 409, (line, response.text)
    assert wait_probe(client)["probe"]["state"] == "done"
    fake.move_time = 0.002
    assert client.post("/api/heightmap/focus", json={"offset": 2.0}).status_code == 200
    # A query changes nothing; a declared position moves the frame.
    assert client.post("/api/command", json={"line": "$h_steps"}).json()["lines"][-1] == "ok"
    assert focused(client)
    assert client.post("/api/command", json={"line": "set H5"}).json()["lines"] == ["ok"]
    assert not focused(client)


def test_a_stop_or_a_reset_while_a_start_reads_the_settings_keeps_it_from_starting(client, fake, monkeypatch):
    backend = client.backend
    read = backend.read_settings
    inside = threading.Event()

    def slow_read(force: bool = False) -> dict:
        # The start reads the settings before anything else: made slow, the
        # stop comes in that read.
        if threading.current_thread().name == "starter":
            inside.set()
            time.sleep(0.3)
        return read(force)

    monkeypatch.setattr(backend, "read_settings", slow_read)
    job = client.post("/api/center", json={}).json()["job"]
    grid = Grid(x0=-10, y0=-5, x1=10, y1=5, nx=3, ny=2)
    for start, interrupt in (
        (lambda: backend.run_job(job["id"]), lambda: backend.runner.stop()),
        (lambda: backend.run_job(job["id"]), lambda: backend.realtime("hold")),
        (lambda: backend.start_probe(grid), lambda: backend.realtime("reset")),
        (lambda: backend.start_probe(grid), lambda: backend.prober.stop()),
    ):
        inside.clear()
        sent = len(fake.received_lines)
        outcome: dict[str, str] = {}

        def attempt() -> None:
            try:
                start()
                outcome["start"] = "started"
            except Exception as exc:
                outcome["start"] = repr(exc)

        starter = threading.Thread(target=attempt, name="starter")
        starter.start()
        assert inside.wait(2.0)
        interrupt()
        starter.join(5.0)
        assert outcome["start"] != "started", outcome
        moves = [line for line in fake.received_lines[sent:] if line.split()[0] in ("go", "cut", "probe", "jog")]
        assert moves == [], moves
        assert not backend.runner.active and not backend.prober.active


def test_a_console_set_lost_unanswered_moves_the_frame_too(client, fake, monkeypatch):
    probe(client)
    assert client.post("/api/heightmap/focus", json={"offset": 2.0}).status_code == 200
    link = client.backend.link
    request = link.request

    def lost(line: str, timeout: float = 5.0) -> list[str]:
        # Taken by the machine, its answer never arrives.
        answer = request(line, timeout)
        if line.startswith("set"):
            raise LinkTimeout(f"no answer to {line!r}")
        return answer

    monkeypatch.setattr(link, "request", lost)
    assert client.post("/api/command", json={"line": "set H1"}).status_code == 502
    assert not focused(client)


def test_the_offset_is_taken_back_when_the_motors_lose_power(client, fake):
    probe(client)
    assert client.post("/api/heightmap/focus", json={"offset": 2.0}).status_code == 200
    # The board resets itself after the loss; the reset alone would keep
    # the position and the offset with it.
    fake._emit("[MSG:tmc H addr3 lost motor power, position may be off]")
    fake._emit("[MSG:reset]")
    fake._emit(fake.banner())
    deadline = time.monotonic() + 2.0
    while focused(client) and time.monotonic() < deadline:
        time.sleep(0.02)
    assert not focused(client)


def test_the_offset_is_taken_back_when_a_setting_rescales_the_focus_axis(client, fake):
    probe(client)
    assert client.post("/api/heightmap/focus", json={"offset": 2.0}).status_code == 200
    assert client.put("/api/settings", json={"values": {"h_rate": 500}}).status_code == 200
    assert focused(client)
    assert client.put("/api/settings", json={"values": {"h_steps": 3200}}).status_code == 200
    assert not focused(client)


def test_the_offset_is_taken_back_when_a_scaling_setting_may_have_gone_through_unanswered(client, fake, monkeypatch):
    probe(client)
    assert client.post("/api/heightmap/focus", json={"offset": 2.0}).status_code == 200
    link = client.backend.link
    request_ok = link.request_ok

    def lost(line: str, timeout: float = 5.0) -> list[str]:
        # Taken by the machine, its answer lost on the way back.
        lines = request_ok(line, timeout)
        if line.startswith("$h_steps="):
            raise LinkTimeout(f"no answer to {line!r}")
        return lines

    monkeypatch.setattr(link, "request_ok", lost)
    original = fake.settings["h_steps"]
    response = client.put("/api/settings", json={"values": {"h_steps": original * 2}})
    assert response.status_code == 502
    assert not focused(client)
    # Put back like one that was answered.
    assert fake.settings["h_steps"] == original


def test_motors_off_or_a_setting_asked_for_as_probing_starts_waits_and_is_refused(client, fake, monkeypatch):
    fake.move_time = 0.05
    backend = client.backend
    read = backend.read_settings
    inside = threading.Event()

    def slow_read(force: bool = False) -> dict:
        # The probe's start reads the settings between its check and its
        # claim: made slow, the other requests come in that gap.
        if threading.current_thread().name == "probe-start":
            inside.set()
            time.sleep(0.3)
        return read(force)

    monkeypatch.setattr(backend, "read_settings", slow_read)
    grid = Grid(x0=-10, y0=-5, x1=10, y1=5, nx=3, ny=2)
    starter = threading.Thread(target=backend.start_probe, args=(grid,), name="probe-start")
    starter.start()
    assert inside.wait(5.0)
    before = len(fake.received_lines)
    outcomes: dict[str, str] = {}

    def attempt(name, call) -> None:
        try:
            call()
            outcomes[name] = "done"
        except HTTPException as exc:
            outcomes[name] = f"{exc.status_code} {exc.detail}"
        except Exception as exc:
            outcomes[name] = repr(exc)

    others = [
        threading.Thread(target=attempt, args=("motors", lambda: backend.motors(False))),
        threading.Thread(target=attempt, args=("settings", lambda: backend.write_settings({"h_rate": 500}, None))),
    ]
    for thread in others:
        thread.start()
    for thread in [starter, *others]:
        thread.join(timeout=20.0)
    try:
        assert backend.prober.snapshot() is not None
        assert outcomes == {"motors": "409 the board is being probed", "settings": "409 the board is being probed"}
        sent = fake.received_lines[before:]
        assert "disable" not in sent and not [line for line in sent if line.startswith("$h_rate=")]
    finally:
        if backend.prober.active:
            client.post("/api/heightmap/stop")


def test_the_offset_is_taken_back_when_the_machine_restarts_but_not_on_a_reset(client, fake):
    probe(client)
    assert client.post("/api/heightmap/focus", json={"offset": 2.0}).status_code == 200
    # A reset keeps the position.
    assert client.post("/api/realtime", json={"action": "reset"}).status_code == 200
    client.post("/api/realtime", json={"action": "status"})
    time.sleep(0.1)
    assert focused(client)
    # A banner no reset came before is a machine that started over.
    fake._emit(fake.banner())
    client.post("/api/realtime", json={"action": "status"})
    assert wait_until(lambda: not focused(client))


def test_a_connect_takes_the_offset_back(tmp_path):
    backend, _ = backend_for(tmp_path, lambda: focus_fake(move_time=0.002))
    with TestClient(create_app(backend, frontend=tmp_path / "no-dist")) as client:
        assert client.post("/api/connect", json={"url": "socket://127.0.0.1:9999"}).status_code == 200
        probe(client)
        assert client.post("/api/heightmap/focus", json={"offset": 2.0}).status_code == 200
        client.post("/api/disconnect")
        assert client.post("/api/connect", json={"url": "socket://127.0.0.1:9999"}).status_code == 200
        assert not focused(client)
        client.post("/api/heightmap/focus", json={"offset": 2.0})
        assert not focused(client)
        assert client.post("/api/heightmap/focus", json={}).status_code == 200
        assert focused(client)
    # A backend started again, on the map it kept, may be talking to a
    # machine that was powered off in between.
    again, _ = backend_for(tmp_path, lambda: focus_fake(move_time=0.002))
    with TestClient(create_app(again, frontend=tmp_path / "no-dist")) as client:
        assert client.post("/api/connect", json={"url": "socket://127.0.0.1:9999"}).status_code == 200
        assert not focused(client)
        response = client.post("/api/heightmap/focus", json={"offset": 2.0})
        assert response.status_code == 400 and "renumbered" in response.json()["detail"]


class QueuedProbeFake(FakeSerial):
    """Answers a probe only once the motion queued ahead of it has run, as
    the firmware does."""

    def _probe(self, values: dict) -> list[str]:
        while time.monotonic() < self.busy_until or self.hold:
            time.sleep(0.005)
        return super()._probe(values)


def test_the_move_to_a_point_is_not_charged_to_its_probe(tmp_path, monkeypatch):
    # Every move takes longer than a probe is given for its own descent.
    monkeypatch.setattr(prober_module, "PROBE_MARGIN", 0.05)
    backend, fakes = backend_for(tmp_path, lambda: focus_fake(QueuedProbeFake, move_time=0.15))
    with TestClient(create_app(backend, frontend=tmp_path / "no-dist")) as client:
        assert client.post("/api/connect", json={"url": "socket://127.0.0.1:9999"}).status_code == 200
        client.put("/api/heightmap/settings", json={"depth": 2, "feed": 6000, "slow": 0})
        state = probe(client, nx=2, ny=2)
        assert state["probe"]["state"] == "done", state["probe"]
        assert fakes[0].h == 0.0


class HoldOnTheLastRise(QueuedProbeFake):
    """Held by the operator as the head rises from the last point, and
    resumed a while later."""

    points = 4
    held_for = 0.6

    def _execute(self, text: str):
        out = super()._execute(text)
        if text == "go H0.0000":
            self.rises = getattr(self, "rises", 0) + 1
            if self.rises == self.points:
                self._realtime(0x21)
                threading.Timer(self.held_for, self._realtime, args=(0x7E,)).start()
        return out


def test_a_hold_on_the_last_rise_waits_for_the_resume(tmp_path, monkeypatch):
    monkeypatch.setattr(prober_module, "LINE_TIMEOUT", 0.2)
    backend, fakes = backend_for(tmp_path, lambda: focus_fake(HoldOnTheLastRise, move_time=0.05))
    with TestClient(create_app(backend, frontend=tmp_path / "no-dist")) as client:
        assert client.post("/api/connect", json={"url": "socket://127.0.0.1:9999"}).status_code == 200
        client.put("/api/heightmap/settings", json={"slow": 0})
        state = probe(client, nx=2, ny=2)
        assert state["probe"]["state"] == "done", state["probe"]
        assert state["probe"]["seconds"] >= HoldOnTheLastRise.held_for
        assert 0x18 not in fakes[0].realtime_bytes


class RestartOnTheLastRise(FakeSerial):
    """Starts over, as after a dip in its supply, while the head rises from
    the last point of the second probing of a 2 by 2 grid."""

    at_rise = 8

    def _execute(self, text: str):
        out = super()._execute(text)
        if text == "go H0.0000":
            self.rises = getattr(self, "rises", 0) + 1
            if self.rises == self.at_rise:
                threading.Timer(0.01, self._emit, args=(self.banner(),)).start()
        return out


def test_a_restart_on_the_last_rise_ends_probing_and_takes_the_offset_back(tmp_path):
    backend, _ = backend_for(tmp_path, lambda: focus_fake(RestartOnTheLastRise, move_time=0.05))
    with TestClient(create_app(backend, frontend=tmp_path / "no-dist")) as client:
        assert client.post("/api/connect", json={"url": "socket://127.0.0.1:9999"}).status_code == 200
        client.put("/api/heightmap/settings", json={"slow": 0})
        assert probe(client, nx=2, ny=2)["probe"]["state"] == "done"
        assert client.post("/api/heightmap/focus", json={"offset": 2.0}).status_code == 200
        # Probed again in the same frame, the map would keep that offset.
        state = probe(client, nx=2, ny=2)
        assert state["probe"]["state"] == "error" and "reset" in state["probe"]["error"], state["probe"]
        assert state["map"]["focus_set"] is False
        job = client.post("/api/center", json={"reach": 4, "ring": 3}).json()["job"]
        response = client.post(f"/api/jobs/{job['id']}/run", json={"compensate": "focus"})
        assert response.status_code == 400 and "focus offset" in response.json()["detail"]


def test_an_offset_from_before_a_restart_is_not_followed_if_written_back(client, fake):
    probe(client)
    assert client.post("/api/heightmap/focus", json={"offset": 2.0}).status_code == 200
    stale = client.backend.heightmaps.get()
    fake._emit(fake.banner())
    client.post("/api/realtime", json={"action": "status"})
    assert wait_until(lambda: not focused(client))
    # A writer that had not seen the restart puts its copy back.
    client.backend.heightmaps.put(stale)
    job = client.post("/api/center", json={"reach": 4, "ring": 3}).json()["job"]
    response = client.post(f"/api/jobs/{job['id']}/run", json={"compensate": "focus"})
    assert response.status_code == 400 and "focus offset" in response.json()["detail"]
    assert not focused(client)


def start_held(prober: Prober, link: Link, end) -> None:
    """Starts probing with its first status report held back, ends it with
    `end` while it waits, then lets the report through."""
    entered = threading.Event()
    release = threading.Event()
    status_now = Link.status_now

    def held(*args, **kwargs):
        entered.set()
        release.wait(5.0)
        return status_now(link, *args, **kwargs)

    link.status_now = held
    outcome: dict[str, str] = {}

    def start() -> None:
        try:
            prober.start(Grid(x0=-10, y0=-5, x1=10, y1=5, nx=2, ny=2), ProbeSettings(), link, Streamer())
            outcome["result"] = "started"
        except ProberError as exc:
            outcome["result"] = str(exc)

    thread = threading.Thread(target=start)
    thread.start()
    try:
        assert entered.wait(5.0)
        assert prober.active
        end()
    finally:
        release.set()
        thread.join(timeout=5.0)
        del link.status_now
    assert "stopped before it started" in outcome["result"], outcome


def test_a_stop_or_a_reset_while_probing_starts_ends_it_before_anything_moves(tmp_path):
    fake = focus_fake(move_time=0.002)
    link = Link("socket://127.0.0.1:9999", open_port=fake_opener(fake))
    link.open()
    try:
        store = HeightMapStore(tmp_path / "heightmap.json")
        prober = Prober(store)
        start_held(prober, link, lambda: prober.stop())
        assert not prober.active and store.get() is None
        start_held(prober, link, lambda: prober.cancel("reset by the operator"))
        assert not prober.active and store.get() is None
        assert not any(line.split()[0] in ("go", "probe") for line in fake.received_lines)
        # Nothing is left behind: the next probing runs.
        prober.start(Grid(x0=-10, y0=-5, x1=10, y1=5, nx=2, ny=2), ProbeSettings(), link, Streamer())
        assert wait_until(lambda: not prober.active, 10.0)
        assert prober.progress.state == "done", prober.snapshot()
    finally:
        link.close()


VIRTUAL = os.environ.get("SPINNY_VIRTUAL", "")


@pytest.fixture
def realtime_firmware():
    """The virtual firmware in real time, with a focus axis over a tilted
    board and a table quick enough to keep the test short."""
    if not VIRTUAL or not Path(VIRTUAL).exists():
        pytest.skip("SPINNY_VIRTUAL does not name a virtual firmware binary")
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    settings = ["h_axis=1", "a_steps=500", "a_rate=7200", "a_accel=1000"]
    command = [VIRTUAL, "--listen", f"127.0.0.1:{port}", "--quiet", "--surface", "-1.5,0.01,-0.02"]
    for pair in settings:
        command += ["--settings", pair]
    process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        deadline = time.monotonic() + 10.0
        while True:
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                    break
            except OSError:
                if time.monotonic() > deadline:
                    pytest.fail("the virtual firmware did not open its port")
                time.sleep(0.05)
        yield port
    finally:
        process.terminate()
        try:
            process.wait(timeout=5.0)
        except subprocess.TimeoutExpired:
            process.kill()


@pytest.mark.e2e
def test_a_half_turn_before_the_first_point_is_waited_out_on_the_virtual_firmware(realtime_firmware, tmp_path, monkeypatch):
    # The first point is half a turn from the head at A0: the turn takes
    # longer than the probe is given for its own descent.
    monkeypatch.setattr(prober_module, "PROBE_MARGIN", 0.3)
    link = Link(f"socket://127.0.0.1:{realtime_firmware}")
    link.open()
    try:
        store = HeightMapStore(tmp_path / "heightmap.json")
        prober = Prober(store)
        settings = ProbeSettings(depth=4, feed=600, slow=0)
        prober.start(Grid(x0=-10, y0=-1, x1=-6, y1=1, nx=2, ny=2), settings, link, Streamer())
        assert wait_until(lambda: not prober.active, 60.0)
        assert prober.progress.state == "done", prober.snapshot()
        heightmap = store.get()
        for iy, y in enumerate(heightmap.grid.ys):
            for ix, x in enumerate(heightmap.grid.xs):
                assert heightmap.heights[iy][ix] == pytest.approx(surface(x, y), abs=0.01)
    finally:
        link.close()
