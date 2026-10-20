"""The camera: pcbv behind the vision client, the routes, and the routine
that measures the camera's offset from a mark."""

from __future__ import annotations

import math
import sys
import textwrap
import time
from pathlib import Path

import pytest
from fake_serial import FakeSerial, fake_opener
from fastapi.testclient import TestClient

from spinny_web import camera as camera_module
from spinny_web.app import Backend, create_app
from spinny_web.camera import CameraSettings, pixel_to_board, scale_from_shift
from spinny_web.link import Link
from spinny_web.vision import VisionClient, VisionError, find_pcbv

# A stand-in for pcbv: the protocol over stdio, with a picture of nothing.
FAKE_PCBV = textwrap.dedent(
    """
    import json, sys
    seq = 0
    for raw in sys.stdin:
        try:
            request = json.loads(raw)
        except ValueError:
            sys.stdout.write(json.dumps({"id": None, "error": "not JSON"}) + "\\n"); sys.stdout.flush(); continue
        rid, cmd = request.get("id"), request.get("cmd")
        seq += 1
        if cmd == "hello":
            reply = {"id": rid, "version": "0.1.0", "camera": sys.argv[sys.argv.index("--camera") + 1], "board": None}
        elif cmd == "pose":
            reply = {"id": rid, "state": "locked", "fps": 10.0, "spots": 5, "look": "luma-local", "ms": 1.0, "width": 640, "height": 480,
                     "frame": seq, "age_ms": 3, "center": [50.0, 40.0], "angle_deg": 1.5, "mm_per_px": 0.05, "inliers": 5, "expected": 6, "rms_mm": 0.02}
        elif cmd == "frame":
            data = bytes([0xFF, 0xD8, 0xFF]) + b"x" * 100 + bytes([0xFF, 0xD9])
            sys.stdout.write(json.dumps({"id": rid, "width": request.get("width", 640), "height": 480, "bytes": len(data), "frame": seq, "age_ms": 2}) + "\\n")
            sys.stdout.flush(); sys.stdout.buffer.write(data); sys.stdout.buffer.flush(); continue
        elif cmd == "spot":
            reply = {"id": rid, "found": True, "x": 332.0, "y": 251.0, "dx": 12.0, "dy": 11.0, "area": 300.0, "major": 20.0, "minor": 19.0, "contrast": 80.0}
        elif cmd == "board":
            reply = {"id": rid, "features": 3, "islands": 2, "holes": 1} if request.get("path") else {"id": rid, "ok": True}
        elif cmd == "quit":
            sys.stdout.write(json.dumps({"id": rid, "ok": True}) + "\\n"); sys.stdout.flush(); break
        else:
            reply = {"id": rid, "error": "unknown command " + str(cmd)}
        sys.stdout.write(json.dumps(reply) + "\\n"); sys.stdout.flush()
    """
)


@pytest.fixture
def pcbv(tmp_path):
    script = tmp_path / "fake-pcbv"
    script.write_text(f"#!{sys.executable}\n" + FAKE_PCBV, encoding="utf-8")
    script.chmod(0o755)
    return str(script)


def test_the_vision_client_speaks_the_protocol(pcbv):
    client = VisionClient()
    hello = client.start("/dev/video9", "640x480", 15, pcbv)
    assert hello["version"] == "0.1.0" and hello["camera"] == "/dev/video9" and client.running
    pose = client.pose()
    assert pose["state"] == "locked" and pose["center"] == [50.0, 40.0]
    reply, data = client.frame(width=320, overlay=True)
    assert reply["width"] == 320 and reply["bytes"] == len(data) == 105 and data[:3] == bytes([0xFF, 0xD8, 0xFF])
    spot = client.spot()
    assert spot["found"] and (spot["dx"], spot["dy"]) == (12.0, 11.0)
    assert client.board("board.kicad_pcb", "front", "masked")["features"] == 3
    assert client.board(None)["ok"] is True
    with pytest.raises(VisionError, match="unknown command"):
        client.request("fly")
    client.close()
    assert not client.running
    with pytest.raises(VisionError, match="not running"):
        client.pose()


def test_pcbv_is_found_or_named(tmp_path):
    with pytest.raises(VisionError, match="not on PATH"):
        find_pcbv("no-such-program-anywhere")
    with pytest.raises(VisionError, match="is not at"):
        find_pcbv(str(tmp_path / "missing" / "pcbv"))
    program = tmp_path / "pcbv"
    program.write_text("#!/bin/sh\n")
    assert find_pcbv(str(program)) == str(program)
    assert find_pcbv(sys.executable) == sys.executable


def test_the_picture_geometry_round_trips():
    for roll in (0.0, 37.0, -120.0, 180.0):
        before = (3.0, -4.0)
        # The head moves +2 mm along X: the spot moves 2 mm of board -X in the picture.
        moved = pixel_to_board(1.0, 0.0, 1.0, -roll)
        after = (before[0] - 2.0 / 0.02 * moved[0], before[1] + 2.0 / 0.02 * moved[1])
        mm_per_px, found = scale_from_shift(before, after, 2.0)
        assert mm_per_px == pytest.approx(0.02)
        delta = pixel_to_board(after[0] - before[0], after[1] - before[1], mm_per_px, found)
        assert delta == pytest.approx((-2.0, 0.0), abs=1e-9)
    with pytest.raises(ValueError, match="did not move"):
        scale_from_shift((1.0, 1.0), (1.0, 1.0), 2.0)
    settings = CameraSettings(size="640x480")
    assert (settings.width, settings.height) == (640, 480)
    with pytest.raises(ValueError, match="WIDTHxHEIGHT"):
        CameraSettings(size="big").check()


@pytest.fixture
def fake():
    fake = FakeSerial(move_time=0.002)
    fake.settings.update({"cartesian": 1, "spindle": 1, "h_axis": 1, "z_max": 100, "r_max": 100})
    fake.h = 3.0
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


class StandInClient:
    """A camera that sees a mark on the board from where the fake machine
    stands: the true offset, roll and scale are what the routine must find."""

    def __init__(self, fake: FakeSerial, mark: tuple[float, float], offset: tuple[float, float], roll: float, mm_per_px: float) -> None:
        self.fake = fake
        self.mark = mark
        self.offset = offset
        self.roll = roll
        self.mm_per_px = mm_per_px
        self.running = True
        self.spots = 0

    def spot(self, radius=None, polarity="dark"):
        self.spots += 1
        head = (self.fake.joint[0], self.fake.z)
        center = (head[0] + self.offset[0], head[1] + self.offset[1])
        # The mark's board offset from the picture's center, turned into picture pixels.
        dx, dy = self.mark[0] - center[0], self.mark[1] - center[1]
        radians = math.radians(-self.roll)
        u = (dx * math.cos(radians) - dy * math.sin(radians)) / self.mm_per_px
        v = -(dx * math.sin(radians) + dy * math.cos(radians)) / self.mm_per_px
        if math.hypot(u, v) > 400.0:
            return {"found": False}
        return {"found": True, "dx": u, "dy": v, "x": 640 + u, "y": 360 + v, "area": 200.0, "major": 15.0, "minor": 15.0, "contrast": 90.0}

    def pose(self):
        return {"state": "none", "width": 1280, "height": 720, "frame": 1, "age_ms": 5, "fps": 10.0, "spots": 0}

    def close(self):
        self.running = False


def wait_routine(client, timeout: float = 20.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        state = client.get("/api/camera").json()
        routine = state["routine"]
        if routine is not None and routine["state"] != "running":
            return state
        time.sleep(0.02)
    raise AssertionError("the routine did not end")


def test_the_camera_state_settings_and_refusals_without_pcbv(client, fake):
    state = client.get("/api/camera").json()
    assert state["running"] is False and state["pose"] is None and state["frame"] is None and state["mark"] is None
    assert state["device"] == "/dev/video0" and state["offset"] == [0.0, 0.0]
    response = client.put("/api/camera/settings", json={"device": "/dev/video2", "size": "640x480", "offset": [12.5, -3.25], "roll": 0.5})
    assert response.status_code == 200 and response.json()["size"] == "640x480" and response.json()["offset"] == [12.5, -3.25]
    assert client.put("/api/camera/settings", json={"size": "huge"}).status_code == 400
    assert client.put("/api/camera/settings", json={"side": "top"}).status_code == 400
    assert client.get("/api/camera/frame.jpg").status_code == 404
    assert client.post("/api/camera/stop").status_code == 200
    assert client.post("/api/camera/find", json={"step": 2}).status_code == 400
    assert client.post("/api/camera/abort").status_code == 409
    response = client.post("/api/camera/start")
    # Started with a program that is not there: a 502 naming it.
    client.put("/api/camera/settings", json={"pcbv": "no-such-pcbv-program"})
    response = client.post("/api/camera/start")
    assert response.status_code == 502 and "no-such-pcbv-program" in response.json()["detail"]
    # The mark where the tool stands, without cutting.
    fake.joint[0], fake.z = 7.0, 3.0
    response = client.post("/api/camera/mark", json={"here": True})
    assert response.status_code == 200 and response.json()["mark"] == [7.0, 3.0]
    assert client.get("/api/camera").json()["mark"] == [7.0, 3.0]


def test_a_mark_is_cut_with_the_spindle(client, fake):
    fake.joint[0], fake.z = 4.0, 1.0
    response = client.post("/api/camera/mark", json={"depth": 0.2, "plunge": 40})
    assert response.status_code == 200, response.text
    assert response.json()["mark"] == [4.0, 1.0]
    deadline = time.monotonic() + 20.0
    while time.monotonic() < deadline and client.get("/api/run").json()["state"] == "running":
        time.sleep(0.02)
    assert client.get("/api/run").json()["state"] == "done"
    sent = fake.received_lines
    assert any(line.startswith("spindle S") for line in sent) and "cut H-0.2000 F40" in sent and "spindle off" in sent
    jobs = client.get("/api/jobs").json()["jobs"]
    assert any(job["name"] == "camera mark" and job["source"] == "mark" for job in jobs)
    # On a laser machine a mark is not cut.
    fake.settings["spindle"] = 0
    client.get("/api/settings")
    client.backend.read_settings(force=True)
    response = client.post("/api/camera/mark", json={"depth": 0.2})
    assert response.status_code == 400 and "by hand" in response.json()["detail"]


@pytest.mark.parametrize("roll", [0.0, 25.0, -90.0])
def test_finding_the_mark_measures_the_offset_the_roll_and_the_scale(client, fake, roll):
    truth = (12.5, -3.25)
    mark = (30.0, 20.0)
    fake.h = 0.5
    client.backend.camera.set_mark(mark)
    stand_in = StandInClient(fake, mark, truth, roll, 0.02)
    client.backend.camera.client = stand_in
    # A rough offset to start from, within the picture.
    client.put("/api/camera/settings", json={"offset": [11.0, -2.0], "roll": 0.0, "mm_per_px": 0.0})
    response = client.post("/api/camera/find", json={"step": 2.0})
    assert response.status_code == 200, response.text
    state = wait_routine(client)
    assert state["routine"]["state"] == "done", state["routine"]
    assert state["offset"] == pytest.approx(list(truth), abs=0.02)
    assert state["mm_per_px"] == pytest.approx(0.02, rel=0.01)
    found_roll = state["roll"]
    assert math.isclose(math.cos(math.radians(found_roll - roll)), 1.0, abs_tol=1e-4)
    assert state["routine"]["step"] == "done" and state["routine"]["spot"]["mm"] < 0.03
    # The head lifted to the clearance before moving.
    assert "go H2.0000" in fake.received_lines
    # A second find with the scale known skips the scale move when asked.
    fake.received_lines.clear()
    response = client.post("/api/camera/find", json={"step": 0})
    assert response.status_code == 200, response.text
    state = wait_routine(client)
    assert state["routine"]["state"] == "done" and state["offset"] == pytest.approx(list(truth), abs=0.02)


def test_a_find_without_the_mark_in_view_ends_as_an_error(client, fake):
    # The camera is sent 30 mm from where the mark really is: out of its picture.
    client.backend.camera.set_mark((40.0, 0.0))
    client.backend.camera.client = StandInClient(fake, (10.0, 0.0), (0.0, 0.0), 0.0, 0.02)
    assert client.post("/api/camera/find", json={"step": 2.0}).status_code == 200
    state = wait_routine(client)
    assert state["routine"]["state"] == "error" and "no mark in the picture" in state["routine"]["error"]
    # Nothing else may own the machine while the routine runs: a jog is refused.
    client.backend.camera.set_mark((10.0, 0.0))
    slow = StandInClient(fake, (10.0, 0.0), (0.0, 0.0), 0.0, 0.02)
    original = slow.spot

    def dawdle(*args, **kwargs):
        time.sleep(0.3)
        return original(*args, **kwargs)

    slow.spot = dawdle
    client.backend.camera.client = slow
    assert client.post("/api/camera/find", json={"step": 2.0}).status_code == 200
    time.sleep(0.05)
    response = client.post("/api/jog", json={"kind": "joint", "dr": 1.0})
    assert response.status_code == 409 and "finding the mark" in response.json()["detail"]
    assert client.post("/api/camera/find", json={"step": 2.0}).status_code == 409
    assert client.post("/api/camera/abort").status_code == 200
    state = wait_routine(client)
    assert state["routine"]["state"] == "stopped"
