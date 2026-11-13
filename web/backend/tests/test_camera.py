"""The camera: pcbv behind the vision client, the routes, and the routine
that measures the camera's offset from a mark."""

from __future__ import annotations

import json
import math
import socket
import sys
import textwrap
import threading
import time

import pytest
from device_fakes import SeenBoard
from fake_serial import FakeSerial, fake_opener
from fastapi.testclient import TestClient

from spinny_web import boardlook
from spinny_web import camera as camera_module
from spinny_web.app import Backend, create_app
from spinny_web.boardlook import search_stops
from spinny_web.camera import CameraSettings, picture_to_machine, scale_from_shift
from spinny_web.jobs import Design, Group, Job
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


class FakeServedPcbv:
    """A stand-in for `pcbv serve --listen` on another machine: one client
    at a time, every request kept, and the service over at a `quit`."""

    def __init__(self, camera: str | None) -> None:
        self.camera = camera
        self.requests: list[dict] = []
        self.listener = socket.create_server(("127.0.0.1", 0))
        self.port = self.listener.getsockname()[1]
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self) -> None:
        while True:
            try:
                conn, _ = self.listener.accept()
            except OSError:
                return
            with conn, conn.makefile("rwb") as stream:
                for raw in stream:
                    request = json.loads(raw)
                    self.requests.append(request)
                    rid, cmd = request["id"], request["cmd"]
                    if cmd == "hello":
                        reply = {"id": rid, "version": "0.1.0", "camera": self.camera, "board": None}
                    elif cmd == "camera":
                        self.camera = request["path"]
                        reply = {"id": rid, "ok": True}
                    elif cmd == "quit":
                        stream.write(json.dumps({"id": rid, "ok": True}).encode() + b"\n")
                        stream.flush()
                        self.listener.close()
                        return
                    else:
                        reply = {"id": rid, "error": "unknown command " + cmd}
                    stream.write(json.dumps(reply).encode() + b"\n")
                    stream.flush()

    def close(self) -> None:
        self.listener.close()


def test_a_served_pcbv_takes_the_size_asked_for_here_and_outlives_its_clients():
    served = FakeServedPcbv("/dev/v4l/by-id/usb-cam-video-index0")
    try:
        for _ in range(2):
            client = VisionClient()
            hello = client.start(f"socket://127.0.0.1:{served.port}", "640x480", 15, "no-pcbv-needed")
            assert hello["camera"] == "/dev/v4l/by-id/usb-cam-video-index0" and client.running
            client.close()
            assert not client.running
        opens = [r for r in served.requests if r["cmd"] == "camera"]
        assert len(opens) == 2
        assert {k: v for k, v in opens[0].items() if k != "id"} == {
            "cmd": "camera",
            "path": "/dev/v4l/by-id/usb-cam-video-index0",
            "width": 640,
            "height": 480,
            "fps": 15,
        }
        assert not any(r["cmd"] == "quit" for r in served.requests)
    finally:
        served.close()


def test_a_served_pcbv_without_a_camera_is_refused():
    served = FakeServedPcbv(None)
    try:
        client = VisionClient()
        with pytest.raises(VisionError, match="has no camera open"):
            client.start(f"socket://127.0.0.1:{served.port}", "640x480", 15, "pcbv")
        assert not client.running
    finally:
        served.close()


def test_a_forwarded_port_with_nothing_behind_it_is_named():
    # What an ssh forward does with no listener at the far end: take the
    # connection, then close it.
    listener = socket.create_server(("127.0.0.1", 0))
    port = listener.getsockname()[1]

    def accept_and_close() -> None:
        conn, _ = listener.accept()
        conn.close()

    threading.Thread(target=accept_and_close, daemon=True).start()
    try:
        client = VisionClient()
        with pytest.raises(VisionError, match=f"no pcbv answers at socket://127.0.0.1:{port}.*no camera unit"):
            client.start(f"socket://127.0.0.1:{port}", "640x480", 15, "pcbv")
        assert not client.running
    finally:
        listener.close()


class ScriptedPcbv:
    """A pcbv serving over TCP, one client at a time, whose answers a test
    holds back: `silent` answers nothing past `hello` and `camera`,
    `late_spot` answers the first spot that many seconds late, and `stray`
    puts a reply carrying an id nobody asked for before each pose's own."""

    JPEG = b"\xff\xd8JPEG\xff\xd9"

    def __init__(self, silent: bool = False, late_spot: float = 0.0, stray: bool = False) -> None:
        self.silent = silent
        self.late_spot = late_spot
        self.stray = stray
        self.spots = 0
        self.requests: list[dict] = []
        self.listener = socket.create_server(("127.0.0.1", 0))
        self.port = self.listener.getsockname()[1]
        self.device = f"socket://127.0.0.1:{self.port}"
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self) -> None:
        while True:
            try:
                conn, _ = self.listener.accept()
            except OSError:
                return
            try:
                with conn, conn.makefile("rwb") as stream:
                    for raw in stream:
                        request = json.loads(raw)
                        self.requests.append(request)
                        self._answer(stream, request)
            except OSError:
                pass

    def _answer(self, stream, request: dict) -> None:
        rid, cmd = request["id"], request["cmd"]
        if cmd == "hello":
            reply = {"id": rid, "version": "0.1.0", "camera": "/dev/video0", "board": None}
        elif cmd == "camera":
            reply = {"id": rid, "ok": True}
        elif self.silent:
            return
        elif cmd == "pose":
            if self.stray:
                stream.write(json.dumps({"id": -7, "found": True, "dx": 99.0, "dy": 0.0}).encode() + b"\n")
            reply = {"id": rid, "state": "none", "width": 640, "height": 480, "frame": 1}
        elif cmd == "spot":
            self.spots += 1
            if self.spots == 1 and self.late_spot:
                time.sleep(self.late_spot)
            reply = {"id": rid, "found": True, "dx": 10.0 * self.spots, "dy": 0.0}
        elif cmd == "frame":
            stream.write(json.dumps({"id": rid, "width": 640, "height": 480, "bytes": len(self.JPEG)}).encode() + b"\n" + self.JPEG)
            stream.flush()
            return
        else:
            reply = {"id": rid, "error": "unknown command " + cmd}
        stream.write(json.dumps(reply).encode() + b"\n")
        stream.flush()

    def close(self) -> None:
        self.listener.close()


def test_a_silent_pcbv_keeps_no_caller_waiting_past_one_request_s_time():
    # A pcbv still connected but answering nothing, as over a stalled link,
    # and the page's frames and polls asking all the while: each caller
    # must give up within one request's time, not wait its turn behind
    # every caller before it, or the server's route threads run out.
    served = ScriptedPcbv(silent=True)
    client = VisionClient()
    try:
        client.start(served.device, "640x480", 15, "pcbv")
        timeout = 2.0
        ended: list[float] = []
        errors: list[str] = []

        def ask() -> None:
            try:
                client.request("frame", timeout=timeout, width=640)
            except VisionError as exc:
                errors.append(str(exc))
            ended.append(time.monotonic())

        began = time.monotonic()
        threads = [threading.Thread(target=ask, daemon=True) for _ in range(10)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=timeout + 1.5 - (time.monotonic() - began))
        assert len(ended) == 10 and max(ended) - began < timeout + 1.5, f"{len(ended)} of 10 callers ended"
        assert len(errors) == 10
        assert any(f"did not answer 'frame' within {timeout:g} s" in error for error in errors)
        # The reply still owed would answer the next request: the camera
        # is stopped, and the next caller is told so at once.
        assert not client.running and client.device is None
        asked = time.monotonic()
        with pytest.raises(VisionError, match="not running"):
            client.pose()
        assert time.monotonic() - asked < 0.5
    finally:
        client.close()
        served.close()


def test_a_late_reply_never_answers_a_later_request():
    served = ScriptedPcbv(late_spot=1.0)
    client = VisionClient()
    try:
        client.start(served.device, "640x480", 15, "pcbv")
        with pytest.raises(VisionError, match="did not answer 'spot' within 0.3 s"):
            client.request("spot", timeout=0.3)
        # Its answer comes later, and is no answer to the pose asked next.
        with pytest.raises(VisionError, match="not running"):
            client.pose()
        assert not client.running
        client.start(served.device, "640x480", 15, "pcbv")
        assert client.pose()["state"] == "none"
        reply, data = client.frame(width=640)
        assert data == ScriptedPcbv.JPEG and reply["bytes"] == len(data)
        assert client.spot()["dx"] == 20.0
        # Every request has an id of its own.
        ids = [request["id"] for request in served.requests]
        assert len(ids) == len(set(ids))
    finally:
        client.close()
        served.close()
    # A reply carrying an id that is not the one awaited is passed over.
    served = ScriptedPcbv(stray=True)
    client = VisionClient()
    try:
        client.start(served.device, "640x480", 15, "pcbv")
        assert client.pose()["state"] == "none"
        assert client.pose()["state"] == "none" and client.running
    finally:
        client.close()
        served.close()


def test_a_pcbv_that_cannot_open_its_camera_says_why(tmp_path):
    script = tmp_path / "failing-pcbv"
    script.write_text(
        f"#!{sys.executable}\nimport sys\n"
        "sys.stderr.write('Error: http://127.0.0.1:2325/stream closed without answering\\n')\nsys.exit(1)\n",
        encoding="utf-8",
    )
    script.chmod(0o755)
    client = VisionClient()
    with pytest.raises(VisionError, match="closed its output: Error: http://127.0.0.1:2325/stream closed without answering"):
        client.start("http://127.0.0.1:2325/stream", "1280x720", 30, str(script))
    assert not client.running


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
        moved = picture_to_machine(1.0, 0.0, 1.0, -roll)
        after = (before[0] - 2.0 / 0.02 * moved[0], before[1] + 2.0 / 0.02 * moved[1])
        mm_per_px, found = scale_from_shift(before, after, 2.0)
        assert mm_per_px == pytest.approx(0.02)
        delta = picture_to_machine(after[0] - before[0], after[1] - before[1], mm_per_px, found)
        assert delta == pytest.approx((-2.0, 0.0), abs=1e-9)
    with pytest.raises(ValueError, match="did not move"):
        scale_from_shift((1.0, 1.0), (1.0, 1.0), 2.0)
    CameraSettings(size="640x480").check()
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
    assert response.status_code == 409 and "camera routine" in response.json()["detail"]
    assert client.post("/api/camera/find", json={"step": 2.0}).status_code == 409
    assert client.post("/api/camera/abort").status_code == 200
    state = wait_routine(client)
    assert state["routine"]["state"] == "stopped"


def pid_of(client: VisionClient) -> int:
    stream = client._stream
    assert stream is not None and stream.process is not None
    return stream.process.pid


def test_a_running_camera_starts_again_on_new_capture_settings(pcbv):
    camera = camera_module.Camera({}, lambda: None, lambda: None, lambda level, text: None)
    camera.update({"pcbv": pcbv, "device": "/dev/video9"})
    assert not camera.running
    camera.start()
    try:
        camera.load_board("job1", "board.kicad_pcb")
        first = pid_of(camera.client)
        camera.update({"side": "back", "offset": [1.0, 2.0]})
        assert pid_of(camera.client) == first
        camera.update({"device": "/dev/video8", "size": "640x480"})
        assert camera.running and pid_of(camera.client) != first
        assert camera.client.request("hello")["camera"] == "/dev/video8"
        # The board looked for is looked for again.
        assert camera.board_job == "job1"
        # Not while the routine has the camera; what the routine itself
        # keeps still goes through.
        gate = threading.Event()
        camera._thread = threading.Thread(target=gate.wait, daemon=True)
        camera._thread.start()
        with pytest.raises(camera_module.CameraError, match="abort that first"):
            camera.update({"device": "/dev/video7"})
        assert camera.settings().device == "/dev/video8"
        camera.update({"roll": 1.0})
        gate.set()
        camera._thread.join()
        # A start that fails leaves the camera stopped and the settings kept.
        with pytest.raises(VisionError, match="no-such-pcbv-program"):
            camera.update({"pcbv": "no-such-pcbv-program"})
        assert not camera.running and camera.board_job is None and camera.settings().pcbv == "no-such-pcbv-program"
    finally:
        camera.shutdown()


def test_a_running_up_camera_starts_again_on_new_capture_settings(pcbv):
    from spinny_web.pnp import PnpError, UpCamera

    up = UpCamera({}, lambda: None, lambda: None, lambda level, text: None)
    up.update({"pcbv": pcbv, "device": "/dev/video5"})
    assert not up.running
    up.start()
    try:
        first = pid_of(up.client)
        up.update({"nozzle_spot": "bright", "mm_per_px": 0.01})
        assert pid_of(up.client) == first
        up.update({"device": "/dev/video6"})
        assert up.running and pid_of(up.client) != first
        assert up.client.request("hello")["camera"] == "/dev/video6"
        gate = threading.Event()
        up._thread = threading.Thread(target=gate.wait, daemon=True)
        up._thread.start()
        with pytest.raises(PnpError, match="abort it first"):
            up.update({"fps": 10})
        gate.set()
        up._thread.join()
    finally:
        up.shutdown()


def test_a_failed_restart_through_the_route_shows_the_camera_stopped(client, pcbv):
    events: list[dict] = []
    client.backend.broadcast.publish_threadsafe = events.append
    assert client.put("/api/camera/settings", json={"pcbv": pcbv}).status_code == 200
    assert client.post("/api/camera/start").json()["running"] is True
    response = client.put("/api/camera/settings", json={"pcbv": "no-such-pcbv-program"})
    assert response.status_code == 502 and "no-such-pcbv-program" in response.json()["detail"]
    assert events[-1]["type"] == "camera" and events[-1]["running"] is False and events[-1]["pcbv"] == "no-such-pcbv-program"


def test_a_machine_file_restarts_a_running_camera_on_its_device_and_a_failure_does_not_fail_the_load(tmp_path, pcbv):
    machines = tmp_path / "machines"
    machines.mkdir()
    (machines / "seen.toml").write_text('name = "Seen"\n[camera]\ndevice = "/dev/video4"\n', encoding="utf-8")
    (machines / "blind.toml").write_text('name = "Blind"\n[camera]\npcbv = "no-such-pcbv-program"\n', encoding="utf-8")
    fake = FakeSerial(move_time=0.002)
    backend = Backend(
        root=tmp_path,
        link_factory=lambda url: Link(url, open_port=fake_opener(fake)),
        jobs_dir=tmp_path / "jobs",
        config_path=tmp_path / "config.json",
        machines_dir=machines,
    )
    messages: list[tuple[str, str]] = []
    with TestClient(create_app(backend, frontend=tmp_path / "no-dist")) as client:
        backend.publish_message = lambda level, text: messages.append((level, text))
        assert client.post("/api/connect", json={"url": "socket://127.0.0.1:9999"}).status_code == 200
        assert client.put("/api/camera/settings", json={"pcbv": pcbv}).status_code == 200
        assert client.post("/api/camera/start").json()["running"] is True
        assert client.post("/api/machines/seen/apply").status_code == 200
        assert backend.camera.running and backend.camera.client.request("hello")["camera"] == "/dev/video4"
        response = client.post("/api/machines/blind/apply")
        assert response.status_code == 200, response.text
        state = client.get("/api/camera").json()
        assert state["running"] is False and state["pcbv"] == "no-such-pcbv-program"
        assert messages[-1][0] == "error" and "did not start again on /dev/video4" in messages[-1][1]


class BoardStandIn:
    """A head camera whose pcbv has a board to look for: its pose is the
    `seen` board's from where the fake machine's tool stands plus the true
    offset."""

    def __init__(self, fake: FakeSerial, seen: SeenBoard, offset: tuple[float, float], roll: float, mm_per_px: float) -> None:
        self.fake = fake
        self.seen = seen
        self.offset = offset
        self.roll = roll
        self.mm_per_px = mm_per_px
        self.running = True
        self.device = "/dev/video0"
        self.loaded = None
        self.frames = 0
        self.asked: list[str] = []

    def board(self, path, side="front", finish="masked", **fields):
        self.loaded = path
        self.board_fields = {"side": side, "finish": finish, **fields}
        return {"features": 40}

    def request(self, cmd, timeout=None, **fields):
        self.asked.append(cmd)
        return {"ok": True}

    def pose(self):
        self.frames += 1
        if self.loaded is None:
            return {"state": "none", "frame": self.frames, "age_ms": 0, "width": 1280, "height": 720}
        center = (self.fake.joint[0] + self.offset[0], self.fake.z + self.offset[1])
        return self.seen.pose(center, self.roll, False, self.mm_per_px, 1280, 720, self.frames)

    def frame(self, width=None, overlay=False, quality=80):
        return {"width": 1280, "height": 720, "frame": self.frames, "age_ms": 0}, b"\xff\xd8 head picture \xff\xd9"

    def close(self):
        self.running = False


def test_the_head_camera_searches_for_the_board_and_a_capture_takes_the_agreed_place(client, fake, monkeypatch):
    monkeypatch.setattr(boardlook, "LOCK_SECONDS", 0.15)
    monkeypatch.setattr(boardlook, "STOP_SECONDS", 0.6)
    monkeypatch.setattr(boardlook, "SAMPLE_SECONDS", 0.01)
    job = Job(
        name="board", source="kicad", groups=[Group(label="g", paths=[[(0.0, 0.0), (1.0, 0.0)]])],
        outline=[[(0.0, 0.0), (40.0, 0.0), (40.0, 30.0), (0.0, 30.0), (0.0, 0.0)]],
        design=Design(shift=(-100.0, -70.0), board=True),
    )
    client.backend.store.add(job)
    client.backend.store.keep_board(job.id, b"(kicad_pcb)")
    seen = SeenBoard((0.0, 0.0, 40.0, 30.0), 1.0, (40.0, 30.0), design_shift=(-100.0, -70.0))
    stand_in = BoardStandIn(fake, seen, (12.5, -3.25), 0.0, 0.02)
    client.backend.camera.client = stand_in
    client.put("/api/camera/settings", json={"offset": [12.5, -3.25], "roll": 0.0, "mm_per_px": 0.02})
    assert client.post("/api/camera/search", json={}).status_code == 400
    response = client.post("/api/camera/board", json={"job": job.id})
    assert response.status_code == 200, response.text
    assert response.json()["board_look"]["job"] == job.id
    # The search keeps within a fifth of the scale measured.
    assert stand_in.board_fields["scale"] == pytest.approx((0.016, 0.024)) and stand_in.board_fields["side"] == "front"
    response = client.post("/api/camera/search", json={"box": [45.0, 35.0, 75.0, 60.0]})
    assert response.status_code == 200, response.text
    state = wait_routine(client)
    assert state["routine"]["state"] == "done" and state["routine"]["kind"] == "search", state["routine"]
    middle = (40.0 + 20.0 * math.cos(math.radians(1.0)) - 15.0 * math.sin(math.radians(1.0)), 30.0 + 20.0 * math.sin(math.radians(1.0)) + 15.0 * math.cos(math.radians(1.0)))
    look = state["board_look"]
    assert look["found"] is True and look["estimate"]["center"] == pytest.approx(list(middle), abs=0.01)
    assert look["sessions"] >= boardlook.SESSIONS and look["rechecking"] is False
    assert (fake.joint[0] + 12.5, fake.z - 3.25) == pytest.approx(middle, abs=0.01)
    # The search was recorded, and the look begun by loading the board
    # ended as the search began.
    records = client.get("/api/searchlog?camera=head").json()["records"]
    search_record, look_record = records[0], records[1]
    assert search_record["kind"] == "search" and search_record["result"] == "found" and search_record["job"] == job.id
    assert look_record["kind"] == "look" and look_record["result"] == "searched"
    assert look["record"] == search_record["id"]
    shown = client.get(f"/api/searchlog/{search_record['id']}").json()
    assert shown["record"]["picture"]["offset"] == [12.5, -3.25] and shown["record"]["board"]["copy"] == "board.kicad_pcb"
    assert shown["summary"]["estimate"]["center"] == pytest.approx(list(middle), abs=0.01) and shown["summary"]["stops"]
    page = client.get(f"/api/searchlog/{search_record['id']}/report")
    assert page.status_code == 200 and page.headers["content-type"].startswith("text/html") and "Board search" in page.text
    picture = client.get(f"/api/searchlog/{search_record['id']}/stop-000.jpg")
    assert picture.status_code == 200 and picture.content == b"\xff\xd8 head picture \xff\xd9"
    assert client.get(f"/api/searchlog/{search_record['id']}/..%2Frecord.json").status_code == 404
    assert client.get("/api/searchlog/19990101-000000-000").status_code == 404
    assert client.get("/api/searchlog?camera=up").status_code == 400
    # A capture with the board found takes the agreed place and turn.
    response = client.post("/api/align/capture", json={"job": job.id})
    assert response.status_code == 200, response.text
    mark = response.json()["marks"][-1]
    assert mark["machine"] == pytest.approx(list(middle), abs=0.01) and mark["angle"] == pytest.approx(1.0, abs=0.01)


class NearStandIn(BoardStandIn):
    """A head camera whose pcbv takes a known place on each reset and says
    so, every reset's fields kept with where the picture's center was."""

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.resets: list[tuple[tuple[float, float], dict]] = []

    def request(self, cmd, timeout=None, **fields):
        self.asked.append(cmd)
        if cmd == "reset":
            self.resets.append(((self.fake.joint[0] + self.offset[0], self.fake.z + self.offset[1]), fields))
            return {"ok": True, **({"near": True} if "near" in fields else {})}
        return {"ok": True}


def test_a_search_starts_where_the_board_is_known_and_tells_pcbv_but_not_at_the_check(client, fake, monkeypatch):
    monkeypatch.setattr(boardlook, "LOCK_SECONDS", 0.15)
    monkeypatch.setattr(boardlook, "STOP_SECONDS", 0.6)
    monkeypatch.setattr(boardlook, "SAMPLE_SECONDS", 0.01)
    job = Job(
        name="board", source="kicad", groups=[Group(label="g", paths=[[(0.0, 0.0), (1.0, 0.0)]])],
        outline=[[(0.0, 0.0), (40.0, 0.0), (40.0, 30.0), (0.0, 30.0), (0.0, 0.0)]],
        design=Design(shift=(-100.0, -70.0), board=True),
    )
    client.backend.store.add(job)
    client.backend.store.keep_board(job.id, b"(kicad_pcb)")
    seen = SeenBoard((0.0, 0.0, 40.0, 30.0), 1.0, (40.0, 30.0), design_shift=(-100.0, -70.0))
    stand_in = NearStandIn(fake, seen, (12.5, -3.25), 0.0, 0.02)
    client.backend.camera.client = stand_in
    client.put("/api/camera/settings", json={"offset": [12.5, -3.25], "roll": 0.0, "mm_per_px": 0.02})
    truth = boardlook.Estimate(1.0, (40.0, 30.0), (0.0, 0.0), 0.0)
    middle = truth.apply((20.0, 15.0))
    # Two corners taken where the board lies: the known place.
    for corner, point in (("bottom left", (0.0, 0.0)), ("top right", (40.0, 30.0))):
        at = truth.apply(point)
        fake.joint[0], fake.z = at[0] - 12.5, at[1] + 3.25
        assert client.post("/api/camera/corner", json={"job": job.id, "corner": corner}).status_code == 200
    fake.joint[0], fake.z = 0.0, 0.0
    assert client.post("/api/camera/board", json={"job": job.id}).status_code == 200
    # A box much wider than the board, its stops a picture apart.
    box = [0.0, 0.0, 120.0, 100.0]
    response = client.post("/api/camera/search", json={"box": box})
    assert response.status_code == 200, response.text
    state = wait_routine(client)
    assert state["routine"]["state"] == "done", state["routine"]
    look = state["board_look"]
    assert look["found"] is True and look["estimate"]["center"] == pytest.approx(list(middle), abs=0.01)
    known = look["known"]
    assert known["source"] == "corners" and known["center"] == pytest.approx(list(middle), abs=1e-3)
    # The first stop is the one nearest the board's known middle, not the
    # one nearest where the camera stood.
    stops = search_stops(tuple(box), (1280 * 0.02, 720 * 0.02), tuple(middle))
    first_center, first = stand_in.resets[0]
    assert first_center == pytest.approx(stops[0], abs=1e-6)
    # pcbv was told the KiCad point and turn the known place puts there.
    raw = seen.pose(first_center, 0.0, False, 0.02, 1280, 720, 1)
    assert first["near"]["center"] == pytest.approx(raw["center"], abs=1e-3)
    assert first["near"]["angle_deg"] == pytest.approx(-1.0, abs=1e-3)
    assert first["near"]["within_mm"] == 2.0
    # Every stop's reset told it, a look afresh at a stop told it again,
    # and the check's told nothing.
    checked = [fields for _, fields in stand_in.resets if "near" not in fields]
    told = [fields for _, fields in stand_in.resets if "near" in fields]
    assert len(checked) >= 1 and len(told) >= known["guided"] >= 1 and known["unguided"] == 0
    record = client.get(f"/api/searchlog/{look['record']}").json()["record"]
    assert record["known"]["source"] == "corners"


def test_head_camera_corners_make_alignment_marks_and_its_look_settings_are_checked(client, fake):
    job = Job(
        name="board", source="kicad", groups=[Group(label="g", paths=[[(0.0, 0.0), (1.0, 0.0)]])],
        outline=[[(0.0, 0.0), (40.0, 0.0), (40.0, 30.0), (0.0, 30.0), (0.0, 0.0)]],
        design=Design(shift=(-100.0, -70.0), board=True),
    )
    client.backend.store.add(job)
    client.put("/api/camera/settings", json={"offset": [12.5, -3.25], "roll": 0.0, "mm_per_px": 0.02})

    def take(corner: str, point: tuple[float, float]) -> dict:
        # The picture's center put on the corner of a board turned a degree
        # and shifted to (40, 30): the tool there less the camera's offset.
        c, s = math.cos(math.radians(1.0)), math.sin(math.radians(1.0))
        fake.joint[0] = 40.0 + c * point[0] - s * point[1] - 12.5
        fake.z = 30.0 + s * point[0] + c * point[1] + 3.25
        response = client.post("/api/camera/corner", json={"job": job.id, "corner": corner})
        assert response.status_code == 200, response.text
        return response.json()["board_look"]

    assert client.post("/api/camera/corner", json={"job": job.id, "corner": "middle"}).status_code == 400
    take("bottom left", (0.0, 0.0))
    look = take("bottom right", (40.0, 0.0))
    # No board looked for: the corners and their rough place all the same.
    assert look["job"] is None and [point["corner"] for point in look["corners"]["points"]] == ["bottom left", "bottom right"]
    assert look["corners"]["rough"]["rotation"] == pytest.approx(1.0, abs=0.01)
    # A capture with no board found takes a mark at each corner.
    marks = client.post("/api/align/capture", json={"job": job.id}).json()["marks"]
    assert [mark["design"] for mark in marks[-2:]] == [[0.0, 0.0], [40.0, 0.0]]
    assert marks[-1]["machine"] == pytest.approx([40.0 + 40.0 * math.cos(math.radians(1.0)), 30.0 + 40.0 * math.sin(math.radians(1.0))], abs=0.01)
    assert client.delete("/api/camera/corners").json()["board_look"]["corners"] is None
    # The look's settings are the camera's, checked.
    assert client.put("/api/camera/settings", json={"corner_mm": 0.0}).status_code == 400
    assert client.put("/api/camera/settings", json={"look_threshold": -0.1}).status_code == 400
    look = client.put("/api/camera/settings", json={"look_threshold": 0.7, "corner_mm": 4.0}).json()["board_look"]
    assert look["threshold"] == 0.7 and look["corner_mm"] == 4.0


class LensStandIn:
    """pcbv's calibrate and lens requests: a grid measured once, the lens
    given kept."""

    running = True
    device = "/dev/video0"

    def __init__(self) -> None:
        self.lenses: list = []

    def calibrate(self, polarity="dark", pitch=2.0):
        self.asked = (polarity, pitch)
        return {"id": 3, "k1": -0.08, "k2": 0.02, "width": 1280, "height": 720, "dots": 180, "rms_px": 0.07, "rms_before_px": 3.7, "mm_per_px": 0.021}

    def lens(self, lens):
        self.lenses.append(lens)
        return {"ok": True}

    def pose(self):
        return {"state": "none", "frame": 1, "age_ms": 0, "width": 1280, "height": 720}

    def close(self):
        self.running = False


def test_a_cameras_lens_is_measured_from_a_dot_grid_kept_and_sent_and_forgotten(client):
    stand_in = LensStandIn()
    client.backend.camera.client = stand_in
    response = client.post("/api/cameras/lens", json={"camera": "head", "polarity": "bright", "pitch": 2.0})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["measured"]["dots"] == 180 and "id" not in body["measured"]
    lens = {"k1": -0.08, "k2": 0.02, "width": 1280, "height": 720}
    assert stand_in.asked == ("bright", 2.0) and stand_in.lenses == [lens] and body["state"]["lens"] == lens
    assert client.backend.camera.settings().lens == lens
    assert client.post("/api/cameras/lens", json={"camera": "head", "pitch": 0.0}).status_code == 400
    response = client.delete("/api/cameras/lens?camera=head")
    assert response.status_code == 200 and stand_in.lenses[-1] is None and response.json()["state"]["lens"] is None
    # Terms pcbv could not take are refused before they are kept.
    with pytest.raises(ValueError):
        client.backend.camera.set_lens({"k1": 2.0, "k2": 0.0, "width": 1280, "height": 720})
    stand_in.running = False
    assert client.post("/api/cameras/lens", json={"camera": "head"}).status_code == 400


class HolesStandIn(BoardStandIn):
    """The head camera over a board whose drilled holes show as dark discs:
    a spot is the hole nearest the picture's center, where the board truly
    lies (`seen`), within the radius asked."""

    def __init__(self, fake, seen, offset, mm_per_px, holes, diameter) -> None:
        super().__init__(fake, seen, offset, 0.0, mm_per_px)
        self.holes = [seen_point(seen, hole) for hole in holes]
        self.diameter = diameter
        self.looked: list[tuple[float, float]] = []

    def spot(self, radius=None, polarity="dark", min_area=None, max_area=None, min_roundness=None, color=None):
        center = (self.fake.joint[0] + self.offset[0], self.fake.z + self.offset[1])
        self.looked.append(center)
        best = None
        for hole in self.holes:
            dx, dy = (hole[0] - center[0]) / self.mm_per_px, -(hole[1] - center[1]) / self.mm_per_px
            if polarity != "dark" or (radius is not None and math.hypot(dx, dy) > radius):
                continue
            if best is None or math.hypot(dx, dy) < math.hypot(best["dx"], best["dy"]):
                size = self.diameter / self.mm_per_px
                best = {"found": True, "dx": dx, "dy": dy, "area": math.pi * size * size / 4.0, "major": size, "minor": size, "fill": 0.98}
        return best or {"found": False}


def seen_point(seen: SeenBoard, job_point):
    c, s = math.cos(math.radians(seen.rotation)), math.sin(math.radians(seen.rotation))
    return (seen.shift[0] + c * job_point[0] - s * job_point[1], seen.shift[1] + s * job_point[0] + c * job_point[1])


def test_the_head_camera_centers_holes_far_apart_and_makes_them_the_alignment_marks(client, fake):
    holes = [(2.0, 2.0, 1.0), (38.0, 2.0, 1.0), (38.0, 28.0, 1.0), (20.0, 15.0, 1.0), (2.0, 27.5, 1.0)]
    job = Job(
        name="board", source="kicad", groups=[Group(label="g", paths=[[(0.0, 0.0), (1.0, 0.0)]])],
        outline=[[(0.0, 0.0), (40.0, 0.0), (40.0, 30.0), (0.0, 30.0), (0.0, 0.0)]],
        design=Design(shift=(-100.0, -70.0), board=True), holes=holes,
    )
    client.backend.store.add(job)
    seen = SeenBoard((0.0, 0.0, 40.0, 30.0), 1.0, (40.0, 30.0), design_shift=(-100.0, -70.0))
    stand_in = HolesStandIn(fake, seen, (12.5, -3.25), 0.02, [hole[:2] for hole in holes], 1.0)
    client.backend.camera.client = stand_in
    client.put("/api/camera/settings", json={"offset": [12.5, -3.25], "roll": 0.0, "mm_per_px": 0.02})
    # Nothing found and no corners: no place to start from.
    assert client.post("/api/camera/refine", json={"job": job.id}).status_code == 400

    def take(corner: str, point) -> None:
        # The corners taken a little off (0.3 mm), as by eye.
        machine = seen_point(seen, point)
        fake.joint[0] = machine[0] + 0.3 - 12.5
        fake.z = machine[1] + 3.25
        assert client.post("/api/camera/corner", json={"job": job.id, "corner": corner}).status_code == 200

    take("bottom left", (0.0, 0.0))
    take("top right", (40.0, 30.0))
    response = client.post("/api/camera/refine", json={"job": job.id, "count": 3})
    assert response.status_code == 200, response.text
    state = wait_routine(client)
    assert state["routine"]["state"] == "done" and state["routine"]["kind"] == "refine", state["routine"]
    marks = client.get("/api/align").json()["marks"]
    # Three holes far apart (not the middle one), each centered where it is.
    assert len(marks) == 3 and all(mark["source"] == "camera" and mark["kind"] == "feature" for mark in marks)
    assert [20.0, 15.0] not in [mark["design"] for mark in marks]
    for mark in marks:
        assert mark["machine"] == pytest.approx(list(seen_point(seen, mark["design"])), abs=0.02)
    fit = client.get("/api/align").json()["fit"]
    assert fit["rotation"] == pytest.approx(1.0, abs=0.01) and fit["rms"] < 0.02


def _png(path, width: int, height: int, pixel) -> None:
    """A PNG of `pixel(x, y)` -> (r, g, b), written with zlib alone."""
    import struct
    import zlib

    rows = bytearray()
    for y in range(height):
        rows.append(0)
        for x in range(width):
            rows.extend(pixel(x, y))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    path.write_bytes(
        b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(bytes(rows), 6)) + chunk(b"IEND", b"")
    )


def test_a_real_pcbv_finds_a_blank_boards_corner_by_its_edges_and_reads_a_picked_color(tmp_path):
    # pcbv as built in the sibling repository, fed a picture of a blank
    # copper board's corner on a dark bed: its edges give the corner and
    # the board's turn, and a color read off the board is the copper's.
    from spinny_web.boardlook import PictureFrame, corner_from_edges

    try:
        program = find_pcbv("pcbv")
    except VisionError:
        pytest.skip("pcbv is not built")
    width, height, scale = 640, 480, 0.05
    corner, turn = (1.0, -0.5), 4.0
    c, s = math.cos(math.radians(turn)), math.sin(math.radians(turn))
    bed, copper = (40, 42, 45), (200, 120, 60)

    def inside(px: float, py: float) -> bool:
        mx, my = (px - width / 2) * scale - corner[0], -(py - height / 2) * scale - corner[1]
        return c * mx + s * my >= 0.0 and -s * mx + c * my >= 0.0

    def pixel(x: int, y: int):
        share = sum(inside(x + (i + 0.5) / 3, y + (j + 0.5) / 3) for i in range(3) for j in range(3)) / 9
        return tuple(round(b + (k - b) * share) for b, k in zip(bed, copper))

    picture = tmp_path / "corner.png"
    _png(picture, width, height, pixel)
    client = VisionClient()
    try:
        client.start(str(picture), f"{width}x{height}", 10, program)
        reply = client.edges(8)
        assert reply["width"] == width and reply["lines"], reply
        point, rotation = corner_from_edges(reply["lines"], "bottom left", PictureFrame((0.0, 0.0), 0.0, False), scale, (width, height))
        assert point == pytest.approx(corner, abs=0.05) and rotation == pytest.approx(turn, abs=0.3)
        # The board's color read off its middle, the bed's beside it.
        on_board = (width / 2 + 3.0 / scale, height / 2 - 3.0 / scale)
        assert client.color(*on_board) == pytest.approx(list(copper), abs=2)
        assert client.color(20.0, height - 20.0) == pytest.approx(list(bed), abs=2)
    finally:
        client.close()


def test_a_real_pcbv_takes_a_known_place_on_reset_and_says_whether_its_lock_lies_there(tmp_path):
    # pcbv (the sibling build, or the first on PATH) draws a picture of a
    # board strewn with specks and serves it: a reset told where the board
    # is expected is taken, a lock there says so, and a place 8 mm off
    # still ends on the board where it is, saying it lies elsewhere.
    try:
        program = find_pcbv("pcbv")
    except VisionError:
        pytest.skip("pcbv is not built")
    import subprocess
    from pathlib import Path

    board = Path(__file__).resolve().parents[3] / "toolpath" / "tests" / "data" / "board.kicad_pcb"
    picture = tmp_path / "shot.png"
    made = subprocess.run(
        [program, "synth", str(board), "-o", str(picture), "--finish", "bare", "--angle", "12", "--px-per-mm", "20", "--specks", "300", "--speck-radius", "2,5"],
        capture_output=True, text=True, timeout=60,
    )
    if made.returncode != 0:
        pytest.skip(f"this pcbv draws no specks: {made.stderr.strip()[-200:]}")
    client = VisionClient()

    def locked() -> dict:
        deadline = time.monotonic() + 10.0
        while True:
            pose = client.pose()
            if pose.get("state") == "locked" or time.monotonic() > deadline:
                return pose
            time.sleep(0.05)

    try:
        client.start(str(picture), "1280x960", 10, program)
        client.board(str(board), side="front", finish="bare", scale=(0.04, 0.06))
        pose = locked()
        assert pose["state"] == "locked" and "near" not in pose, pose
        center, angle = pose["center"], pose["angle_deg"]
        reply = client.request("reset", near={"center": center, "angle_deg": angle, "within_mm": 2.0, "within_deg": 5.0})
        if reply.get("near") is not True:
            pytest.skip("this pcbv takes no known place")
        pose = locked()
        assert pose["near"] is True and pose["center"] == pytest.approx(center, abs=0.1), pose
        client.request("reset", near={"center": [center[0] + 8.0, center[1]], "angle_deg": angle, "within_mm": 2.0})
        pose = locked()
        assert pose["near"] is False and pose["center"] == pytest.approx(center, abs=0.1), pose
    finally:
        client.close()


def test_a_real_pcbv_measures_a_lens_from_a_dot_grid_and_takes_it(tmp_path, client):
    # A dot grid seen through a lens with k1 -0.08: the route measures it,
    # keeps it in the camera's settings and pcbv says it holds it.
    try:
        program = find_pcbv("pcbv")
    except VisionError:
        pytest.skip("pcbv is not built")
    width, height, k1 = 960, 720, -0.08
    cx, cy, reach = width / 2, height / 2, math.hypot(width / 2, height / 2)

    def raw(u: tuple[float, float]) -> tuple[float, float]:
        # The raw point whose correction is `u`: u = c + (d - c)(1 + k1 r^2).
        d = u
        for _ in range(30):
            r2 = ((d[0] - cx) ** 2 + (d[1] - cy) ** 2) / reach ** 2
            d = (cx + (u[0] - cx) / (1 + k1 * r2), cy + (u[1] - cy) / (1 + k1 * r2))
        return d

    dots = [raw((cx + i * 36.0, cy + j * 36.0)) for i in range(-12, 13) for j in range(-9, 10)]
    dots = [d for d in dots if 8 <= d[0] <= width - 8 and 8 <= d[1] <= height - 8]
    shade = [[235] * width for _ in range(height)]
    for x0, y0 in dots:
        for y in range(int(y0) - 7, int(y0) + 8):
            for x in range(int(x0) - 7, int(x0) + 8):
                share = sum(math.hypot(x + (i + 0.5) / 3 - x0, y + (j + 0.5) / 3 - y0) <= 6.0 for i in range(3) for j in range(3)) / 9
                shade[y][x] = round(235 - 205 * share)
    picture = tmp_path / "dots.png"
    _png(picture, width, height, lambda x, y: (shade[y][x],) * 3)
    camera = client.backend.camera
    camera.client = VisionClient()
    camera.client.start(str(picture), f"{width}x{height}", 10, program)
    try:
        response = client.post("/api/cameras/lens", json={"camera": "head", "polarity": "dark", "pitch": 2.0})
        assert response.status_code == 200, response.text
        measured = response.json()["measured"]
        assert measured["k1"] == pytest.approx(k1, abs=0.02) and measured["rms_px"] < measured["rms_before_px"]
        assert camera.settings().lens["width"] == width
        assert camera.client.request("hello")["lens"]["k1"] == pytest.approx(measured["k1"])
    finally:
        camera.client.close()


class EdgesStandIn(LensStandIn):
    """pcbv's color and edges requests: a blank board's bottom left corner
    turned 2 degrees at machine point `corner`, as the head camera sees it
    from where the fake machine's tool stands."""

    def __init__(self, fake, offset, corner, turn: float, scale: float) -> None:
        super().__init__()
        self.fake, self.offset, self.corner, self.turn, self.scale = fake, offset, corner, turn, scale
        self.colors: list = []

    def color(self, x, y, radius=3.0):
        return [200, 120, 60]

    def edges(self, most=8, color=None):
        self.colors.append(color)
        center = (self.fake.joint[0] + self.offset[0], self.fake.z + self.offset[1])
        lines = []
        for angle in (self.turn, self.turn + 90.0):
            ends = [(self.corner[0] + d * math.cos(math.radians(angle)), self.corner[1] + d * math.sin(math.radians(angle))) for d in (0.2, 6.0)]
            px = [(640.0 + (x - center[0]) / self.scale, 360.0 - (y - center[1]) / self.scale) for x, y in ends]
            lines.append({"x0": px[0][0], "y0": px[0][1], "x1": px[1][0], "y1": px[1][1]})
        return {"lines": lines, "width": 1280, "height": 720}


def test_a_blank_boards_corner_is_taken_by_its_edges_and_colors_are_picked_per_item(client, fake):
    job = Job(
        name="blank", source="kicad", groups=[Group(label="g", paths=[[(0.0, 0.0), (1.0, 0.0)]])],
        outline=[[(0.0, 0.0), (40.0, 0.0), (40.0, 30.0), (0.0, 30.0), (0.0, 0.0)]], design=Design(shift=(0.0, 0.0), board=True),
    )
    client.backend.store.add(job)
    client.put("/api/camera/settings", json={"offset": [12.5, -3.25], "roll": 0.0, "mm_per_px": 0.02})
    stand_in = EdgesStandIn(fake, (12.5, -3.25), (52.0, 31.0), 2.0, 0.02)
    client.backend.camera.client = stand_in
    # The picture's center about the corner, a few mm off it.
    fake.joint[0], fake.z = 52.0 + 2.0 - 12.5, 31.0 + 1.5 + 3.25
    response = client.post("/api/cameras/color", json={"camera": "head", "item": "edges", "x": 300.0, "y": 200.0})
    assert response.status_code == 200, response.text
    assert response.json()["rgb"] == [200, 120, 60] and client.backend.camera.settings().colors == {"edges": [200, 120, 60]}
    response = client.post("/api/camera/edge-corner", json={"job": job.id, "corner": "bottom left"})
    assert response.status_code == 200, response.text
    corners = response.json()["board_look"]["corners"]
    point = corners["points"][0]
    assert point["by"] == "edges" and point["machine"] == pytest.approx([52.0, 31.0], abs=1e-3) and point["angle"] == pytest.approx(2.0, abs=1e-3)
    # The edges were looked for on the color picked for them; one corner
    # with its turn is a whole rough place.
    assert stand_in.colors[-1] == [200, 120, 60]
    assert corners["rough"]["rotation"] == pytest.approx(2.0, abs=1e-3)
    assert client.post("/api/cameras/color", json={"camera": "head", "item": "edges", "clear": True}).json()["state"]["colors"] == {}
    assert client.post("/api/cameras/color", json={"camera": "head", "item": "spots"}).status_code == 400
    assert client.post("/api/cameras/color", json={"camera": "head", "item": "nozzle", "x": 1, "y": 1}).status_code == 422
