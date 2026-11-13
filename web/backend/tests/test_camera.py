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

    def board(self, path, side="front", finish="masked"):
        self.loaded = path
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
    response = client.post("/api/camera/search", json={"box": [45.0, 35.0, 75.0, 60.0]})
    assert response.status_code == 200, response.text
    state = wait_routine(client)
    assert state["routine"]["state"] == "done" and state["routine"]["kind"] == "search", state["routine"]
    middle = (40.0 + 20.0 * math.cos(math.radians(1.0)) - 15.0 * math.sin(math.radians(1.0)), 30.0 + 20.0 * math.sin(math.radians(1.0)) + 15.0 * math.cos(math.radians(1.0)))
    look = state["board_look"]
    assert look["found"] is True and look["estimate"]["center"] == pytest.approx(list(middle), abs=0.01)
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
