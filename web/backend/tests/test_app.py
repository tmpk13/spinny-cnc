"""The HTTP API through the test client, on a link to the fake firmware."""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest
from fake_serial import FakeSerial, fake_opener
from fastapi.testclient import TestClient

from spinny_web.app import Backend, Broadcast, create_app
from spinny_web.link import Link

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
    backend = Backend(
        root=tmp_path,
        link_factory=lambda url: Link(url, open_port=fake_opener(fake)),
        jobs_dir=tmp_path / "jobs",
        config_path=tmp_path / "config.json",
    )
    app = create_app(backend, frontend=tmp_path / "no-dist")
    with TestClient(app) as client:
        client.backend = backend
        yield client


def connect(client) -> dict:
    response = client.post("/api/connect", json={"url": "socket://127.0.0.1:9999"})
    assert response.status_code == 200, response.text
    return response.json()


def test_root_page_says_the_frontend_is_not_built(client):
    response = client.get("/")
    assert response.status_code == 200
    assert "not built" in response.text


def test_state_and_ports_before_connecting(client, tmp_path):
    state = client.get("/api/state").json()
    assert state == {"connected": False, "url": None, "firmware": None, "machine": None, "run": None}
    ports = client.get("/api/ports").json()
    assert "ports" in ports
    for route in ("/api/jog", "/api/goto", "/api/command", "/api/laser/off", "/api/unlock"):
        response = client.post(route, json={"line": "x", "kind": "joint", "dr": 1})
        assert response.status_code == 409, route
    assert client.get("/api/settings").status_code == 409


def test_connect_disconnect_and_last_url(client, fake, tmp_path):
    state = connect(client)
    assert state["connected"] and state["url"] == "socket://127.0.0.1:9999"
    assert state["firmware"] == {"version": "0.1.0", "lines": 16, "blocks": 32}
    assert state["machine"]["state"] == "Idle"
    assert state["machine"]["joint"] == {"r": 0.0, "a": 0.0, "z": 0.0}
    assert state["machine"]["board"] == {"x": 0.0, "y": 0.0}
    assert state["machine"]["queue"] == {"planner": 32, "lines": 16}
    ports = client.get("/api/ports").json()["ports"]
    assert {"url": "socket://127.0.0.1:9999", "description": "last used"} in ports
    config = json.loads((tmp_path / "config.json").read_text())
    assert config["last_url"] == "socket://127.0.0.1:9999"
    # Connecting again to the same url keeps the link.
    again = connect(client)
    assert again["connected"]
    state = client.post("/api/disconnect").json()
    assert not state["connected"] and state["url"] == "socket://127.0.0.1:9999"
    assert not fake.is_open


def test_connect_failure_is_reported(tmp_path):
    def broken(url):
        raise OSError("no such device")

    backend = Backend(root=tmp_path, link_factory=lambda url: Link(url, open_port=broken))
    with TestClient(create_app(backend)) as client:
        response = client.post("/api/connect", json={"url": "/dev/ttyNOPE"})
        assert response.status_code == 502
        assert "no such device" in response.json()["detail"]
        assert not client.get("/api/state").json()["connected"]


def test_jogs_gotos_and_position(client, fake):
    connect(client)
    assert client.post("/api/jog", json={"kind": "joint", "dr": 1.0, "da": 0.0}).json() == {"lines": ["jog R1"]}
    assert client.post("/api/jog", json={"kind": "joint", "da": -90.0, "feed": 500}).json() == {
        "lines": ["jog A-90 F500"]
    }
    assert fake.joint == [1.0, -90.0]
    response = client.post("/api/goto", json={"kind": "joint", "r": 5.0, "a": 0.0})
    assert response.json() == {"lines": ["jogto R5 A0"]}
    assert fake.joint == [5.0, 0.0]
    client.post("/api/realtime", json={"action": "status"})
    response = client.post("/api/jog", json={"kind": "board", "dx": -10.0, "dy": 0.0, "feed": 500})
    lines = response.json()["lines"]
    assert lines[0].startswith("jogto R")
    turns = [line for line in lines if line.startswith("jogto A")]
    assert len(turns) == 1 and abs(float(turns[0].split()[1][1:])) == 180.0 and turns[0].endswith(" F500")
    assert fake.joint[0] == pytest.approx(5.0) and abs(fake.joint[1]) == pytest.approx(180.0)
    response = client.post("/api/goto", json={"kind": "board", "x": 0.0, "y": 3.0})
    assert response.status_code == 200
    assert fake.joint[0] == pytest.approx(3.0) and fake.joint[1] % 360.0 == pytest.approx(90.0)
    assert client.post("/api/jog", json={"kind": "sideways"}).status_code == 400
    # The far side of the axis is open to a goto; the soft limit is not.
    assert client.post("/api/goto", json={"kind": "joint", "r": -1}).status_code == 200
    assert fake.joint[0] == pytest.approx(-1.0)
    fake.settings["r_max"] = 50
    assert client.post("/api/goto", json={"kind": "joint", "r": -60}).status_code == 400
    fake.settings["r_max"] = 0
    assert client.post("/api/goto", json={"kind": "board", "x": 1}).status_code == 400
    state = client.post("/api/position", json={"r": 0, "a": 0}).json()
    assert "set R0 A0" in fake.received_lines
    assert state["machine"]["joint"] == {"r": 0.0, "a": 0.0, "z": 0.0}
    assert client.post("/api/position", json={}).status_code == 400
    assert client.post("/api/jog/cancel").status_code == 200
    assert 0x85 in fake.realtime_bytes


def test_the_cross_slide_moves_on_its_own(client, fake):
    connect(client)
    assert client.post("/api/jog", json={"kind": "joint", "dz": 0.5}).json() == {"lines": ["jog Z0.5"]}
    assert client.post("/api/jog", json={"kind": "joint", "dz": -0.05, "feed": 60}).json() == {
        "lines": ["jog Z-0.05 F60"]
    }
    assert fake.z == pytest.approx(0.45)
    assert client.post("/api/goto", json={"kind": "joint", "z": 1.25}).json() == {"lines": ["jogto Z1.25"]}
    assert fake.z == pytest.approx(1.25)
    state = client.post("/api/realtime", json={"action": "status"}).json()
    assert state["machine"]["joint"] == {"r": 0.0, "a": 0.0, "z": 1.25}
    # A body that mixes the axes is refused before anything goes out.
    sent = len(fake.received_lines)
    assert client.post("/api/jog", json={"kind": "joint", "dz": 0.5, "dr": 1.0}).status_code == 400
    assert client.post("/api/jog", json={"kind": "joint", "dz": 0.5, "da": 0.0}).status_code == 400
    assert client.post("/api/goto", json={"kind": "joint", "z": 0.5, "r": 1.0}).status_code == 400
    assert client.post("/api/goto", json={"kind": "joint", "z": 0.5, "a": 90.0}).status_code == 400
    assert len(fake.received_lines) == sent
    state = client.post("/api/position", json={"z": 0}).json()
    assert fake.received_lines[-1] == "set Z0"
    assert state["machine"]["joint"]["z"] == 0.0
    # All three at once still leave Z on a line of its own.
    client.post("/api/position", json={"r": 1, "a": 2, "z": 3})
    assert fake.received_lines[-2:] == ["set R1 A2", "set Z3"]
    assert fake.joint == [1.0, 2.0] and fake.z == pytest.approx(3.0)


def test_realtime_command_laser_mode_motors_unlock(client, fake):
    connect(client)
    for action, byte in (("hold", 0x21), ("resume", 0x7E), ("reset", 0x18)):
        assert client.post("/api/realtime", json={"action": action}).status_code == 200
        assert byte in fake.realtime_bytes
    assert client.post("/api/realtime", json={"action": "fly"}).status_code == 400
    assert client.post("/api/command", json={"line": "help"}).json()["lines"][-1] == "ok"
    assert client.post("/api/command", json={"line": "bogus"}).json() == {"lines": ["error:1 unknown command"]}
    assert client.post("/api/laser", json={"power": 50, "ms": 2000}).status_code == 200
    assert "laser S50 T2000" in fake.received_lines
    assert client.post("/api/laser/off").status_code == 200
    assert fake.received_lines[-1] == "laser off"
    assert client.post("/api/laser", json={"power": -1}).status_code == 400
    state = client.post("/api/mode", json={"mode": "const"}).json()
    assert state["machine"]["mode"] == "const"
    assert client.post("/api/mode", json={"mode": "loud"}).status_code == 400
    state = client.post("/api/motors", json={"enabled": False}).json()
    assert fake.received_lines[-1] == "disable" and not state["machine"]["enabled"]
    fake.alarm = 1
    state = client.post("/api/unlock").json()
    assert fake.received_lines[-1] == "unlock" and state["machine"]["state"] == "Idle"
    # An error answer to a required command is a 400.
    fake.settings["r_max"] = 1.0
    response = client.post("/api/goto", json={"kind": "joint", "r": 5.0})
    assert response.status_code == 400 and "error:4" in response.json()["detail"]


def test_settings_read_write_save(client, fake, tmp_path):
    connect(client)
    settings = client.get("/api/settings").json()
    assert settings["values"]["r_rate"] == 1000 and settings["values"]["a_steps"] == 888.889
    assert settings["host"] == {"tolerance": 0.005}
    assert {"name": "r_steps", "unit": "steps/mm", "help": "radius motor"} in settings["schema"]
    asked = fake.received_lines.count("$")
    client.get("/api/settings")
    assert fake.received_lines.count("$") == asked
    response = client.put("/api/settings", json={"values": {"r_rate": 800, "a_rate": 1080}, "host": {"tolerance": 0.01}})
    assert response.status_code == 200, response.text
    assert "$r_rate=800" in fake.received_lines
    assert "$a_rate=1080" not in fake.received_lines
    assert response.json()["values"]["r_rate"] == 800
    assert response.json()["host"]["tolerance"] == 0.01
    assert json.loads((tmp_path / "config.json").read_text())["tolerance"] == 0.01
    assert client.backend.rates.r_rate == 800.0
    assert client.put("/api/settings", json={"values": {"nope": 1}}).status_code == 400
    assert client.put("/api/settings", json={"values": {"r_rate": -5}}).status_code == 400
    assert client.put("/api/settings", json={"host": {"tolerance": 0}}).status_code == 400
    assert client.post("/api/settings/save").json() == {"saved": True}
    assert fake.saved == 1


def test_jobs_upload_list_get_patch_delete(client, tmp_path):
    files = {"file": ("drawing.svg", SVG.encode(), "image/svg+xml")}
    data = {"power": "250", "speed": "150", "anchor": "center", "offset_x": "0", "offset_y": "14", "spot": "0.2"}
    response = client.post("/api/jobs", files=files, data=data)
    assert response.status_code == 200, response.text
    job = response.json()
    assert job["name"] == "drawing" and job["source"] == "svg" and job["spot"] == 0.2
    assert job["offset"] == {"x": 0.0, "y": 14.0}
    assert [g["label"] for g in job["groups"]] == ["stroke #ff0000", "stroke #00ff00"]
    assert job["groups"][0]["power"] == 250 and job["groups"][0]["speed"] == 150
    assert job["stats"]["moves"] > 0 and job["stats"]["seconds"] > 0
    assert (tmp_path / "jobs" / f"{job['id']}.json").exists()

    listing = client.get("/api/jobs").json()["jobs"]
    assert [j["id"] for j in listing] == [job["id"]]
    assert listing[0]["groups"][0]["paths"] == 1 and "paths" not in listing[0]
    assert client.get(f"/api/jobs/{job['id']}").json() == job
    assert client.get("/api/jobs/nope").status_code == 404

    patch = {"groups": [{"index": 1, "power": 900, "enabled": False}], "offset": {"x": 5, "y": 14}}
    patched = client.patch(f"/api/jobs/{job['id']}", json=patch).json()
    assert patched["groups"][1]["power"] == 900 and not patched["groups"][1]["enabled"]
    assert patched["offset"] == {"x": 5.0, "y": 14.0}
    moved = patched["groups"][0]["paths"][0][0][0] - job["groups"][0]["paths"][0][0][0]
    assert moved == pytest.approx(5.0)
    assert patched["stats"]["moves"] < job["stats"]["moves"]
    assert client.patch(f"/api/jobs/{job['id']}", json={"groups": [{"index": 7}]}).status_code == 400

    # Running needs a connection.
    assert client.post(f"/api/jobs/{job['id']}/run").status_code == 409
    # Null until a job has run, like the snapshot's run.
    assert client.get("/api/run").json() is None
    assert client.post("/api/run/stop").status_code == 409

    assert client.delete(f"/api/jobs/{job['id']}").status_code == 200
    assert client.delete(f"/api/jobs/{job['id']}").status_code == 404
    assert client.get("/api/jobs").json() == {"jobs": []}


def test_bad_uploads_are_400(client):
    response = client.post("/api/jobs", files={"file": ("x.txt", b"hello", "text/plain")})
    assert response.status_code == 400
    response = client.post("/api/jobs", files={"file": ("e.svg", b"<svg xmlns='http://www.w3.org/2000/svg'/>", "image/svg+xml")})
    assert response.status_code == 400
    response = client.post("/api/jobs", files={"file": ("d.svg", SVG.encode(), "image/svg+xml")}, data={"anchor": "corner"})
    assert response.status_code == 400


def test_gcode_and_json_uploads(client):
    gcode = b"G21\nG90\nM4 S0\nG0 X10 Y10\nG1 X14 Y10 S500 F400\nM5\n"
    job = client.post("/api/jobs", files={"file": ("part.nc", gcode, "text/plain")}, data={"anchor": "keep"}).json()
    assert job["source"] == "gcode" and job["groups"][0]["label"] == "S500 F400"
    copy = client.post("/api/jobs", files={"file": ("copy.json", json.dumps(job).encode(), "application/json")}).json()
    assert copy["id"] != job["id"] and copy["source"] == "json" and copy["name"] == "part"


def test_events_reach_the_broadcast(client, fake):
    backend = client.backend
    seen = []
    queue = backend.broadcast.subscribe()
    connect(client)
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline and len(seen) < 20:
        try:
            seen.append(queue.get_nowait())
        except Exception:
            time.sleep(0.02)
    backend.broadcast.unsubscribe(queue)
    types = {event["type"] for event in seen}
    assert {"state", "console", "message"} <= types
    state = next(event for event in seen if event["type"] == "state")
    assert state["connected"] is True and "machine" in state
    console = next(event for event in seen if event["type"] == "console")
    assert console["dir"] in ("rx", "tx") and "text" in console


def test_broadcast_drops_for_slow_clients():
    broadcast = Broadcast()
    queue = broadcast.subscribe()
    for i in range(300):
        broadcast.publish({"type": "console", "n": i})
    assert queue.qsize() == 256 and broadcast.dropped == 44
    broadcast.unsubscribe(queue)
    broadcast.publish({"type": "x"})
    assert broadcast.clients == 0
    broadcast.publish_threadsafe({"type": "x"})


def wait_for(predicate, timeout: float = 3.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return predicate()


def drain(queue) -> list[dict]:
    seen = []
    while True:
        try:
            seen.append(queue.get_nowait())
        except Exception:
            return seen


def test_board_jogs_chain_from_the_end_of_the_jog_in_progress(tmp_path):
    fake = FakeSerial(move_time=0.6)
    backend = Backend(
        root=tmp_path,
        link_factory=lambda url: Link(url, open_port=fake_opener(fake)),
        jobs_dir=tmp_path / "jobs",
        config_path=tmp_path / "config.json",
    )
    with TestClient(create_app(backend, frontend=tmp_path / "no-dist")) as client:
        connect(client)
        assert client.post("/api/goto", json={"kind": "joint", "r": 5.0, "a": 0.0}).json() == {"lines": ["jogto R5 A0"]}
        # The fake reports the target at once; make it look half way there.
        fake.joint = [2.5, 0.0]
        assert fake.state() == "Jog"
        lines = client.post("/api/jog", json={"kind": "board", "dx": 1.0, "dy": 0.0}).json()["lines"]
        assert lines == ["jogto R6.000 A0.0000"]
        fake.joint = [3.0, 0.0]
        lines = client.post("/api/jog", json={"kind": "board", "dx": 0.0, "dy": 6.0}).json()["lines"]
        # From the end of the previous jog, (6, 0), to (6, 6).
        assert lines[-1] == "jogto R8.485 A45.0000"
        assert len(lines) > 1
        # A cancel forgets the target; once idle the reported position is used.
        client.post("/api/jog/cancel")
        assert wait_for(lambda: fake.state() == "Idle", 2.0)
        fake.joint = [1.0, 0.0]
        lines = client.post("/api/jog", json={"kind": "board", "dx": 1.0, "dy": 0.0}).json()["lines"]
        assert lines == ["jogto R2.000 A0.0000"]
        # A refused line drops the target too.
        fake.settings["r_max"] = 1.0
        fake.joint = [0.5, 0.0]
        assert client.post("/api/jog", json={"kind": "joint", "dr": 5.0}).status_code == 400
        assert backend._jog_target is None


def test_disconnect_is_news_and_a_lost_port_is_an_error(tmp_path):
    fakes: list[FakeSerial] = []

    def factory(url: str) -> Link:
        fake = FakeSerial(move_time=0.002)
        fakes.append(fake)
        return Link(url, open_port=fake_opener(fake))

    backend = Backend(root=tmp_path, link_factory=factory, jobs_dir=tmp_path / "jobs", config_path=tmp_path / "config.json")
    with TestClient(create_app(backend, frontend=tmp_path / "no-dist")) as client:
        queue = backend.broadcast.subscribe()
        connect(client)
        client.post("/api/disconnect")
        assert wait_for(lambda: any(e["type"] == "message" and "link closed" in e["text"] for e in list(queue._queue)), 2.0)
        closed = [e for e in drain(queue) if e["type"] == "message" and "link closed" in e["text"]]
        assert closed and closed[-1]["level"] == "info"
        connect(client)
        fakes[-1].vanish()
        assert wait_for(lambda: not client.get("/api/state").json()["connected"], 3.0)
        assert wait_for(lambda: any(e["type"] == "message" and "link closed" in e["text"] for e in list(queue._queue)), 2.0)
        closed = [e for e in drain(queue) if e["type"] == "message" and "link closed" in e["text"]]
        assert closed and closed[-1]["level"] == "error"
        backend.broadcast.unsubscribe(queue)


def test_hold_and_reset_from_the_console_go_through_the_run(client, fake):
    connect(client)
    fake.ok_delay = 0.3
    paths = [[[10.0 + i * 0.1, -3.0], [10.0 + i * 0.1, 3.0]] for i in range(40)]
    job = {"name": "many", "groups": [{"label": "one", "power": 500, "speed": 400, "paths": paths}]}
    uploaded = client.post("/api/jobs", files={"file": ("many.json", json.dumps(job).encode(), "application/json")}).json()
    assert client.post(f"/api/jobs/{uploaded['id']}/run").status_code == 200
    assert wait_for(lambda: (client.get("/api/run").json() or {}).get("sent", 0) >= 16, 5.0)
    # A hold from the console is the run's hold, and a resume its resume.
    assert client.post("/api/realtime", json={"action": "hold"}).status_code == 200
    assert client.get("/api/run").json()["state"] == "hold"
    assert client.post("/api/realtime", json={"action": "resume"}).status_code == 200
    assert client.get("/api/run").json()["state"] == "running"
    # A reset ends the run before it can send another line.
    assert client.post("/api/realtime", json={"action": "reset"}).status_code == 200
    assert wait_for(lambda: client.get("/api/run").json()["state"] in ("stopped", "error"), 5.0)
    progress = client.get("/api/run").json()
    assert progress["state"] == "stopped" and "reset" in progress["error"], progress
    after = fake.received_lines[fake.received_at_reset[0]:]
    assert not [line for line in after if line.split()[0] in ("go", "cut")], after


def test_a_realtime_character_typed_in_the_console_goes_out_as_one(client, fake):
    connect(client)
    assert client.post("/api/command", json={"line": "?"}).json() == {"lines": []}
    assert 0x3F in fake.realtime_bytes
    assert client.post("/api/command", json={"line": "go R1\u0018"}).status_code == 400
    # A typed move forgets the jog target the next board jog would chain from.
    client.backend._jog_target = (6.0, 0.0)
    assert client.post("/api/command", json={"line": "jogto R1 A0"}).json()["lines"] == ["ok"]
    assert client.backend._jog_target is None


def test_a_relative_jog_while_jogging_keeps_the_planned_end(tmp_path):
    fake = FakeSerial(move_time=0.6)
    backend = Backend(
        root=tmp_path,
        link_factory=lambda url: Link(url, open_port=fake_opener(fake)),
        jobs_dir=tmp_path / "jobs",
        config_path=tmp_path / "config.json",
    )
    with TestClient(create_app(backend, frontend=tmp_path / "no-dist")) as client:
        connect(client)
        client.post("/api/goto", json={"kind": "joint", "r": 5.0, "a": 0.0})
        fake.joint = [2.5, 0.0]
        assert fake.state() == "Jog"
        # The firmware resolves a relative jog from the planned end, so the
        # end of this one is known: 5 + 1.
        assert client.post("/api/jog", json={"kind": "joint", "dr": 1.0}).status_code == 200
        assert backend._jog_target == (6.0, 0.0)
        lines = client.post("/api/jog", json={"kind": "board", "dx": 1.0, "dy": 0.0}).json()["lines"]
        assert lines == ["jogto R7.000 A0.0000"]
        # A move typed in the console makes the end unknown, and a one-axis
        # goto from an unknown start records no end at all.
        client.post("/api/command", json={"line": "jog R5"})
        assert backend._jog_target is None
        fake.joint = [2.5, 0.0]
        assert fake.state() == "Jog"
        assert client.post("/api/goto", json={"kind": "joint", "a": 90.0}).status_code == 200
        assert backend._jog_target is None


def test_a_refused_patch_leaves_the_job_as_it_was(client):
    job = client.post("/api/jobs", files={"file": ("drawing.svg", SVG.encode(), "image/svg+xml")}).json()
    response = client.patch(f"/api/jobs/{job['id']}", json={"groups": [{"index": 0, "power": 900}, {"index": 7}]})
    assert response.status_code == 400
    again = client.get(f"/api/jobs/{job['id']}").json()
    assert again["groups"][0]["power"] == job["groups"][0]["power"]
    assert again["stats"] == job["stats"]
    headers = {"content-type": "application/json"}
    response = client.patch(f"/api/jobs/{job['id']}", content='{"groups": [{"index": 0, "power": NaN}]}', headers=headers)
    assert response.status_code == 422


def test_a_settings_write_with_an_unknown_name_applies_nothing(client, fake):
    connect(client)
    response = client.put("/api/settings", json={"values": {"r_rate": 777, "nope": 1}})
    assert response.status_code == 400
    assert fake.settings["r_rate"] == 1000
    assert client.put("/api/settings", json={"values": {"r_rate": 777}}).status_code == 200
    assert fake.settings["r_rate"] == 777


def test_an_overlong_upload_name_is_refused_cleanly(client):
    response = client.post("/api/jobs", files={"file": ("a" * 300 + ".svg", SVG.encode(), "image/svg+xml")})
    assert response.status_code == 400


def test_a_body_that_is_not_a_number_is_refused_before_anything_moves(client, fake):
    connect(client)
    headers = {"content-type": "application/json"}
    assert client.post("/api/goto", content='{"kind": "board", "x": NaN, "y": 0.0}', headers=headers).status_code == 422
    assert client.post("/api/jog", content='{"kind": "joint", "dr": Infinity}', headers=headers).status_code == 422
    assert client.post("/api/laser", content='{"power": NaN, "ms": 100}', headers=headers).status_code == 422
    assert not [line for line in fake.received_lines if line.split()[0] in ("jog", "jogto", "laser")]
