"""Finding the cameras attached: those pcbv lists on this computer under
their stable names, and the streams and pcbvs behind forwarded ports."""

from __future__ import annotations

import json
import socket
import subprocess
import threading
import time

import pytest
from fastapi.testclient import TestClient

from spinny_web import app as app_module
from spinny_web import cameras as cameras_module
from spinny_web.app import Backend, create_app
from spinny_web.cameras import camera_ports, detect, local_cameras, modes_of, probe

USTREAMER_STATE = {
    "ok": True,
    "result": {
        "instance_id": "",
        "encoder": {"type": "HW", "quality": 80},
        "source": {"resolution": {"width": 1280, "height": 720}, "online": True, "desired_fps": 30, "captured_fps": 29},
        "stream": {"queued_fps": 0, "clients": 0, "clients_stat": {}},
    },
}


class Server:
    """A port on the loopback that answers each connection with `answer`,
    given the socket and what came in before the request's blank line."""

    def __init__(self, answer) -> None:
        self.answer = answer
        self.listener = socket.create_server(("127.0.0.1", 0))
        self.port = self.listener.getsockname()[1]
        self.held: list[socket.socket] = []
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self) -> None:
        while True:
            try:
                conn, _ = self.listener.accept()
            except OSError:
                return
            self.held.append(conn)
            threading.Thread(target=self.answer, args=(conn,), daemon=True).start()

    def close(self) -> None:
        self.listener.close()
        for conn in self.held:
            conn.close()


def read_request(conn: socket.socket) -> bytes:
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = conn.recv(1024)
        if not chunk:
            break
        data += chunk
    return data


def http(status: str, body: bytes):
    def answer(conn: socket.socket) -> None:
        read_request(conn)
        conn.sendall(f"HTTP/1.0 {status}\r\nContent-Type: application/json\r\n\r\n".encode() + body)
        conn.close()

    return answer


def pcbv_line(conn: socket.socket) -> None:
    # pcbv answers every line that is not JSON with an error, and keeps the client.
    with conn.makefile("rb") as stream:
        stream.readline()
        conn.sendall(json.dumps({"id": None, "error": "not JSON: expected value at line 1 column 1"}).encode() + b"\n")
        time.sleep(5)


def silent(conn: socket.socket) -> None:
    time.sleep(5)


def closed_at_once(conn: socket.socket) -> None:
    # What an ssh forward with nothing at the far end does.
    conn.close()


@pytest.fixture
def server():
    made: list[Server] = []

    def make(answer) -> Server:
        made.append(Server(answer))
        return made[-1]

    yield make
    for each in made:
        each.close()


def test_the_ports_follow_the_variable_relay_pi_reads(monkeypatch):
    monkeypatch.delenv("SPINNY_CAMERA_PORTS", raising=False)
    assert camera_ports() == [2325, 2326]
    monkeypatch.setenv("SPINNY_CAMERA_PORTS", "2400")
    assert camera_ports() == [2400]
    # Set and empty names none, as it does for relay-pi.
    assert camera_ports("") == []
    assert camera_ports("2330, 2331 x 2330 99999 0") == [2330, 2331]


def test_each_size_is_kept_once_with_its_best_rate():
    listed = [
        {"fourcc": "YUYV", "width": 1280, "height": 720, "fps": 10.0},
        {"fourcc": "MJPG", "width": 1280, "height": 720, "fps": 30.0},
        {"fourcc": "MJPG", "width": 640, "height": 480, "fps": 30.0},
        {"fourcc": "MJPG", "width": 1920, "height": 1080, "fps": 7.5},
        {"fourcc": "MJPG", "width": 0, "height": 480, "fps": 30.0},
        {"fourcc": "MJPG", "width": "wide"},
        "nonsense",
    ]
    assert modes_of(listed) == [
        {"size": "1920x1080", "fps": 7.5},
        {"size": "1280x720", "fps": 30.0},
        {"size": "640x480", "fps": 30.0},
    ]
    assert modes_of(None) == []


def listing(*devices: tuple[str, str]) -> bytes:
    return json.dumps(
        [{"path": path, "name": name, "modes": [{"fourcc": "MJPG", "width": 640, "height": 480, "fps": 30.0}]} for path, name in devices]
    ).encode()


class FakeRun:
    """subprocess.run as pcbv would answer it, the commands kept."""

    def __init__(self, stdout: bytes = b"[]", returncode: int = 0, stderr: bytes = b"") -> None:
        self.answer = (returncode, stdout, stderr)
        self.calls: list[list[str]] = []

    def __call__(self, command, **_):
        self.calls.append(command)
        return subprocess.CompletedProcess(command, *self.answer)


def test_cameras_here_go_by_their_stable_names(tmp_path):
    dev = tmp_path / "dev"
    by_id = tmp_path / "by-id"
    by_path = tmp_path / "by-path"
    for folder in (dev, by_id, by_path):
        folder.mkdir()
    for node in ("video0", "video1", "video2", "video4"):
        (dev / node).touch()
    (by_id / "usb-Maker_Head_Cam_123-video-index0").symlink_to(dev / "video0")
    (by_id / "usb-Maker_Head_Cam_123-video-index1").symlink_to(dev / "video1")
    (by_path / "pci-0000:00:14.0-usb-0:1:1.0-video-index0").symlink_to(dev / "video0")
    # Two cameras alike without serial numbers: udev points their one by-id
    # name at whichever came last.
    (by_id / "usb-Cheap_Cam-video-index0").symlink_to(dev / "video4")
    (by_path / "pci-0000:00:14.0-usb-0:2:1.0-video-index0").symlink_to(dev / "video2")
    (by_path / "pci-0000:00:14.0-usb-0:3:1.0-video-index0").symlink_to(dev / "video4")
    program = tmp_path / "pcbv"
    program.touch()
    run = FakeRun(listing((str(dev / "video0"), "Head Cam"), (str(dev / "video2"), "Cheap Cam"), (str(dev / "video4"), "Cheap Cam")))
    cameras, problems = local_cameras(str(program), by_id, by_path, run)
    assert problems == [] and run.calls == [[str(program), "cameras", "--json"]]
    assert [camera["device"] for camera in cameras] == [
        str(by_id / "usb-Maker_Head_Cam_123-video-index0"),
        str(by_path / "pci-0000:00:14.0-usb-0:2:1.0-video-index0"),
        str(by_path / "pci-0000:00:14.0-usb-0:3:1.0-video-index0"),
    ]
    head = cameras[0]
    assert head["names"] == [
        str(by_id / "usb-Maker_Head_Cam_123-video-index0"),
        str(by_path / "pci-0000:00:14.0-usb-0:1:1.0-video-index0"),
        str(dev / "video0"),
    ]
    assert head == {**head, "name": "Head Cam", "kind": "v4l2", "modes": [{"size": "640x480", "fps": 30.0}], "online": None}
    # The shared by-id name still finds the camera it points at now.
    assert str(by_id / "usb-Cheap_Cam-video-index0") in cameras[2]["names"]
    # Without links a camera goes by its node.
    run = FakeRun(listing((str(dev / "video0"), "Head Cam")))
    cameras, _ = local_cameras(str(program), tmp_path / "none", tmp_path / "none", run)
    assert cameras[0]["device"] == str(dev / "video0") and cameras[0]["names"] == [str(dev / "video0")]


def test_cameras_here_that_cannot_be_listed_say_why(tmp_path):
    cameras, problems = local_cameras("no-such-pcbv-program-anywhere")
    assert cameras == [] and "cannot be listed" in problems[0] and "not on PATH" in problems[0]
    program = tmp_path / "pcbv"
    program.touch()
    _, problems = local_cameras(str(program), run=FakeRun(returncode=1, stderr=b"warming up\nError: no video devices\n"))
    assert problems == ["pcbv could not list the cameras on this computer: Error: no video devices"]
    _, problems = local_cameras(str(program), run=FakeRun(stdout=b"cameras: none"))
    assert "not a JSON list" in problems[0]

    def hangs(command, **_):
        raise subprocess.TimeoutExpired(command, 15.0)

    _, problems = local_cameras(str(program), run=hangs)
    assert "timed out" in problems[0]


def test_a_ustreamer_is_a_stream_of_its_size_and_rate(server):
    streaming = server(http("200 OK", json.dumps(USTREAMER_STATE).encode()))
    camera = probe("127.0.0.1", streaming.port)
    url = f"http://127.0.0.1:{streaming.port}/snapshot"
    assert camera == {
        "device": url,
        "names": [url, f"http://localhost:{streaming.port}/snapshot"],
        "name": f"stream on port {streaming.port}",
        "kind": "stream",
        "modes": [{"size": "1280x720", "fps": 30.0}],
        "online": True,
    }
    offline = json.loads(json.dumps(USTREAMER_STATE))
    offline["result"]["source"]["online"] = False
    dark = server(http("200 OK", json.dumps(offline).encode()))
    assert probe("127.0.0.1", dark.port)["online"] is False


def test_a_pcbv_on_a_port_is_told_from_a_stream_without_waiting(server):
    serving = server(pcbv_line)
    started = time.monotonic()
    camera = probe("127.0.0.1", serving.port)
    assert time.monotonic() - started < 1.0
    assert camera is not None and camera["kind"] == "pcbv" and camera["device"] == f"socket://127.0.0.1:{serving.port}"


def test_what_is_no_camera_is_left_out(server):
    assert probe("127.0.0.1", server(http("404 Not Found", b"not here")).port) is None
    assert probe("127.0.0.1", server(http("200 OK", b'{"ok": true, "result": {}}')).port) is None
    assert probe("127.0.0.1", server(http("200 OK", b"<html>")).port) is None
    assert probe("127.0.0.1", server(closed_at_once).port) is None
    started = time.monotonic()
    assert probe("127.0.0.1", server(silent).port, timeout=0.3) is None
    assert time.monotonic() - started < 1.0
    unused = socket.create_server(("127.0.0.1", 0))
    port = unused.getsockname()[1]
    unused.close()
    assert probe("127.0.0.1", port) is None


def test_detect_puts_the_cameras_here_first_and_lists_a_held_pcbv_unasked(server, monkeypatch):
    monkeypatch.setattr(cameras_module, "local_cameras", lambda pcbv: ([{"device": "/dev/video0", "kind": "v4l2"}], ["a problem"]))
    streaming = server(http("200 OK", json.dumps(USTREAMER_STATE).encode()))
    held = server(silent)
    unused = socket.create_server(("127.0.0.1", 0))
    nothing = unused.getsockname()[1]
    unused.close()
    ports = sorted([streaming.port, held.port, nothing])
    started = time.monotonic()
    found = detect("pcbv", held=(f"socket://127.0.0.1:{held.port}",), ports=ports)
    # A held pcbv is not asked: asking would wait behind this backend's own connection.
    assert time.monotonic() - started < 1.0
    assert found["problems"] == ["a problem"]
    assert [camera["device"] for camera in found["cameras"]] == ["/dev/video0"] + [
        f"socket://127.0.0.1:{held.port}" if port == held.port else f"http://127.0.0.1:{streaming.port}/snapshot"
        for port in ports
        if port != nothing
    ]


def test_a_held_pcbv_is_known_by_its_localhost_name_too(server, monkeypatch):
    monkeypatch.setattr(cameras_module, "local_cameras", lambda pcbv: ([], []))
    held = server(silent)
    started = time.monotonic()
    found = detect("pcbv", held=(f"socket://localhost:{held.port}",), ports=[held.port])
    assert time.monotonic() - started < 1.0
    assert [(camera["device"], camera["kind"]) for camera in found["cameras"]] == [(f"socket://127.0.0.1:{held.port}", "pcbv")]


def test_the_route_lists_with_the_cameras_program_and_what_runs(tmp_path, monkeypatch):
    asked: list[tuple] = []

    def fake_detect(pcbv, held):
        asked.append((pcbv, held))
        return {"cameras": [{"device": "/dev/video0"}], "problems": []}

    monkeypatch.setattr(app_module, "detect_cameras", fake_detect)
    backend = Backend(root=tmp_path, jobs_dir=tmp_path / "jobs", config_path=tmp_path / "config.json")
    with TestClient(create_app(backend, frontend=tmp_path / "no-dist")) as client:
        client.put("/api/camera/settings", json={"pcbv": "/opt/pcbv"})
        response = client.get("/api/cameras")
    assert response.status_code == 200 and response.json() == {"cameras": [{"device": "/dev/video0"}], "problems": []}
    assert asked == [("/opt/pcbv", ())]


# What v4l2-ctl --list-ctrls-menus prints for a laptop's camera.
LISTING = """
User Controls

                     brightness 0x00980900 (int)    : min=0 max=255 step=1 default=128 value=140 flags=0x00001000
                       contrast 0x00980901 (int)    : min=0 max=255 step=1 default=32 value=32 flags=0x00001000
        white_balance_automatic 0x0098090c (bool)   : default=1 value=1
           power_line_frequency 0x00980918 (menu)   : min=0 max=2 default=1 value=1 (50 Hz)
\t\t\t\t0: Disabled
\t\t\t\t1: 50 Hz
\t\t\t\t2: 60 Hz
      white_balance_temperature 0x0098091a (int)    : min=2800 max=6500 step=1 default=4600 value=4600 flags=inactive, 0x00001000
   region_of_interest_rectangle 0x00981ae1 (unknown): type=107 value=unsupported payload type flags=has-payload, 0x00001000
  region_of_interest_auto_ctrls 0x00981ae2 (bitmask): max=0x000000ff default=0x00000010 value=16 flags=0x00001000

Camera Controls

                  auto_exposure 0x009a0901 (menu)   : min=0 max=3 default=3 value=3 (Aperture Priority Mode)
\t\t\t\t1: Manual Mode
\t\t\t\t3: Aperture Priority Mode
         exposure_time_absolute 0x009a0902 (int)    : min=4 max=1250 step=1 default=157 value=157 flags=inactive, 0x00001000
                 focus_absolute 0x009a090a (int)    : min=0 max=250 step=5 default=0 value=0 flags=read-only
"""


def test_a_listing_gives_the_controls_the_page_can_set():
    controls = {control["name"]: control for control in cameras_module.parse_controls(LISTING)}
    # The region of interest (no number), the bitmask and a read-only focus are left out.
    assert list(controls) == ["brightness", "contrast", "white_balance_automatic", "power_line_frequency", "white_balance_temperature", "auto_exposure", "exposure_time_absolute"]
    assert controls["brightness"] == {"name": "brightness", "section": "User Controls", "kind": "int", "min": 0, "max": 255, "step": 1, "default": 128, "value": 140, "inactive": False}
    assert controls["white_balance_automatic"]["kind"] == "bool" and controls["white_balance_automatic"]["value"] == 1
    assert controls["auto_exposure"]["items"] == [{"value": 1, "label": "Manual Mode"}, {"value": 3, "label": "Aperture Priority Mode"}]
    assert controls["auto_exposure"]["section"] == "Camera Controls" and controls["exposure_time_absolute"]["inactive"] is True


def test_controls_are_listed_set_kept_and_set_again_at_a_start(tmp_path, monkeypatch):
    calls: list[list[str]] = []

    def fake_v4l2(args):
        calls.append(args)
        if "--list-ctrls-menus" in args:
            return LISTING
        if args[-1].startswith("contrast="):
            raise cameras_module.ControlsError("v4l2-ctl: VIDIOC_S_EXT_CTRLS: failed: Invalid argument")
        return ""

    monkeypatch.setattr(cameras_module, "_v4l2", fake_v4l2)
    backend = Backend(root=tmp_path, jobs_dir=tmp_path / "jobs", config_path=tmp_path / "config.json")
    with TestClient(create_app(backend, frontend=tmp_path / "no-dist")) as client:
        listed = client.get("/api/cameras/controls", params={"camera": "head"}).json()
        assert listed["local"] is True and listed["device"] == "/dev/video0" and listed["kept"] == {}
        assert [control["kept"] for control in listed["controls"][:2]] == [None, None]
        # Set now (automatic exposure first), kept, one refused and said.
        response = client.put("/api/cameras/controls", json={"camera": "head", "values": {"exposure_time_absolute": 300, "auto_exposure": 1, "contrast": 900}})
        assert response.status_code == 200, response.text
        answer = response.json()
        assert answer["kept"] == {"exposure_time_absolute": 300, "auto_exposure": 1, "contrast": 900}
        assert answer["refused"] == ["contrast: v4l2-ctl: VIDIOC_S_EXT_CTRLS: failed: Invalid argument"]
        sets = [args[-1] for args in calls if "-c" in args]
        assert sets == ["auto_exposure=1", "contrast=900", "exposure_time_absolute=300"]
        assert client.get("/api/camera").json()["controls"] == {"exposure_time_absolute": 300, "auto_exposure": 1, "contrast": 900}
        # A null forgets a kept value; a name v4l2-ctl would not print is refused.
        assert client.put("/api/cameras/controls", json={"camera": "head", "values": {"contrast": None}}).json()["kept"] == {"exposure_time_absolute": 300, "auto_exposure": 1}
        assert client.put("/api/cameras/controls", json={"camera": "head", "values": {"Bad Name": 1}}).status_code == 400
        # The kept values are set again when the camera starts.
        calls.clear()
        backend.camera.client.start = lambda device, size, fps, pcbv: {"version": "test"}
        backend.camera.start()
        assert [args[-1] for args in calls] == ["auto_exposure=1", "exposure_time_absolute=300"]
        # A bridge Pi's snapshots have none here, and say why.
        client.put("/api/pnp/settings", json={"device": "http://127.0.0.1:2325/snapshot"})
        far = client.get("/api/cameras/controls", params={"camera": "up"}).json()
        assert far["local"] is False and far["controls"] == [] and "HTTP" in far["note"]
