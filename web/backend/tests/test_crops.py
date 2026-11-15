"""Crops: the part of a camera's picture each task looks in, read from a
G-code machine's file, written by the page, sent to pcbv and applied to the
pictures measured here."""

from __future__ import annotations

import json
import socket
import threading

import numpy as np
import pytest
from fastapi.testclient import TestClient

from device_fakes import DeviceTopCamera, DeviceUpCamera, FakeMarlin, wait_for
from gcode_rig import connect, gcode_file, rig_backend

from spinny_laser.cam import set_value
from spinny_laser.machines import MachineError
from spinny_web.app import create_app
from spinny_web.boardlook import BoardLook
from spinny_web.crops import NO_CROPS, check_crop, check_tasks, clip_radius, crop_rows, cut, reach
from spinny_web.openpnp import parse
from spinny_web.vision import VisionClient, VisionError

PROFILE = """name = "crop rig"
[port]
url = "socket://127.0.0.1:9"
wait_ms = 0
timeout = 2
[gcode]
init = ["G21", "G90"]
[motion]
feed_xy = 3000
feed_z = 600
safe_z = 5
place_z = -1
pick_dwell_ms = 0
place_dwell_ms = 0
[up_camera]
z = -4
[top_camera]
z = 0
offset = [34.0, -9.0]
"""


# --- the boxes ---------------------------------------------------------------------


def test_a_crop_is_four_shares_in_order():
    assert check_crop([0, 0.25, 1, 0.75]) == (0.0, 0.25, 1.0, 0.75)
    for bad in ([0.5, 0.0, 0.5, 1.0], [0.0, 0.0, 1.2, 1.0], [-0.1, 0.0, 0.5, 1.0], [0.0, 0.9, 1.0, 0.1], [0, 0, 1], "all", [0, 0, 1, True]):
        with pytest.raises(ValueError):
            check_crop(bad)
    assert check_tasks({"nozzle": [0.4, 0.4, 0.6, 0.6]}, ("nozzle", "part")) == {"nozzle": (0.4, 0.4, 0.6, 0.6)}
    with pytest.raises(ValueError, match="no task 'board': the tasks are nozzle, part"):
        check_tasks({"board": [0, 0, 1, 1]}, ("nozzle", "part"))
    with pytest.raises(ValueError, match="part: a crop needs"):
        check_tasks({"part": [0.6, 0, 0.4, 1]}, ("nozzle", "part"))


def test_a_picture_is_cut_to_its_crop_and_a_radius_to_its_reach():
    gray = np.arange(100 * 200, dtype=np.uint8).reshape(100, 200)
    assert cut(gray, None) is gray
    part = cut(gray, (0.25, 0.5, 0.75, 1.0))
    assert part.shape == (50, 100) and part[0, 0] == gray[50, 50]
    # However thin, two pixels each way are kept for the measures.
    assert cut(gray, (0.5, 0.5, 0.5001, 0.5001)).shape == (2, 2)
    assert crop_rows((0.0, 0.0, 1.0, 1.0), 200, 100) == (0, 200, 0, 100)
    # A box about the center of a 1280 by 720 picture, 128 by 72 px.
    box = (0.45, 0.45, 0.55, 0.55)
    far = reach(box, 1280.0, 720.0)
    assert far == pytest.approx(np.hypot(64.0, 36.0))
    assert clip_radius(None, box, 1280.0, 720.0) == pytest.approx(far)
    assert clip_radius(30.0, box, 1280.0, 720.0) == 30.0
    assert clip_radius(500.0, box, 1280.0, 720.0) == pytest.approx(far)
    assert clip_radius(500.0, None, 1280.0, 720.0) == 500.0
    # A box off to one side reaches from the center to its far corner.
    assert reach((0.75, 0.0, 1.0, 0.5), 1280.0, 720.0) == pytest.approx(np.hypot(640.0, 360.0))


# --- the machine file --------------------------------------------------------------


def test_the_files_crops_read_by_task_and_reach_the_page():
    text = PROFILE + "[top_camera.crops]\nboard = [0.0, 0.1, 1.0, 0.9]\nspot = [0.3, 0.3, 0.7, 0.7]\n" + "[up_camera.crops]\nnozzle = [0.4, 0.35, 0.6, 0.65]\n"
    machine = parse(gcode_file(text), "rig")
    assert machine.top.crops == {"board": (0.0, 0.1, 1.0, 0.9), "spot": (0.3, 0.3, 0.7, 0.7)}
    assert machine.camera_crops == {"nozzle": (0.4, 0.35, 0.6, 0.65)}
    document = machine.document()
    assert document["top"]["crops"] == {"board": [0.0, 0.1, 1.0, 0.9], "spot": [0.3, 0.3, 0.7, 0.7]}
    assert document["camera_crops"] == {"nozzle": [0.4, 0.35, 0.6, 0.65]}
    plain = parse(gcode_file(PROFILE), "rig")
    assert plain.top.crops == {} and plain.camera_crops == {} and plain.document()["camera_crops"] == {}


@pytest.mark.parametrize(
    "extra, words",
    [
        ("[top_camera.crops]\nnozzle = [0, 0, 1, 1]\n", "[top_camera.crops] no task 'nozzle': the tasks are board, spot, edges, measure"),
        ("[up_camera.crops]\nboard = [0, 0, 1, 1]\n", "[up_camera.crops] no task 'board': the tasks are nozzle, part"),
        ("[up_camera.crops]\npart = [0.7, 0, 0.2, 1]\n", "[up_camera.crops] part: a crop needs 0 <= x0 < x1 <= 1"),
        ("[top_camera.crops]\nspot = [0, 0, 1]\n", "[top_camera.crops] spot: a crop is [x0, y0, x1, y1]"),
    ],
)
def test_a_crop_that_does_not_read_names_its_task(extra, words):
    with pytest.raises(MachineError) as error:
        parse(gcode_file(PROFILE + extra), "rig")
    assert words in str(error.value)


def test_a_key_is_set_in_a_table_of_a_table_and_the_table_before_keeps_its_keys():
    text = "[top_camera]\nz = 0\n\n[top_camera.crops]\nspot = [0.1, 0.1, 0.9, 0.9]   # the marks\n\n[motion]\nsafe_z = 5\n"
    changed = set_value(text, ("top_camera", "crops", "spot"), [0.2, 0.2, 0.8, 0.8])
    assert "spot = [0.2, 0.2, 0.8, 0.8]   # the marks" in changed
    # A key of [top_camera] goes in its own table, before its crops.
    changed = set_value(changed, ("top_camera", "within"), 2.5)
    assert changed.index("within = 2.5") < changed.index("[top_camera.crops]")
    changed = set_value(changed, ("top_camera", "crops", "board"), [0.0, 0.0, 1.0, 0.5])
    assert changed.index("board = ") < changed.index("[motion]")
    changed = set_value(changed, ("top_camera", "crops", "spot"), None)
    assert "spot =" not in changed
    with pytest.raises(Exception, match=r"no \[up_camera.crops\] table"):
        set_value(changed, ("up_camera", "crops", "part"), [0.0, 0.0, 1.0, 1.0])


@pytest.fixture
def client(tmp_path):
    fake = FakeMarlin(position=(100.0, 50.0, 0.0))
    backend = rig_backend(tmp_path, {"rig": PROFILE}, lambda url, baud: fake)
    app = create_app(backend, frontend=tmp_path / "no-dist")
    with TestClient(app) as client:
        client.backend = backend
        client.fake = fake
        yield client


def test_the_page_writes_a_crop_into_the_file_adding_its_table_and_clears_it(client):
    response = client.patch("/api/machines/rig", json={"path": ["up_camera", "crops", "nozzle"], "value": [0.4, 0.35, 0.6, 0.65]})
    assert response.status_code == 200, response.text
    text = (client.backend.machine_store.directory / "rig.toml").read_text(encoding="utf-8")
    assert "[up_camera.crops]\nnozzle = [0.4, 0.35, 0.6, 0.65]" in text
    placing = client.get("/api/pnp/placing").json()
    assert placing["document"]["camera_crops"] == {"nozzle": [0.4, 0.35, 0.6, 0.65]}
    # A second task joins the table; a wrong box is refused and the file kept.
    assert client.patch("/api/machines/rig", json={"path": ["up_camera", "crops", "part"], "value": [0.2, 0.2, 0.8, 0.8]}).status_code == 200
    refused = client.patch("/api/machines/rig", json={"path": ["up_camera", "crops", "part"], "value": [0.8, 0.2, 0.2, 0.8]})
    assert refused.status_code in (400, 422), refused.text
    assert client.get("/api/pnp/placing").json()["document"]["camera_crops"]["part"] == [0.2, 0.2, 0.8, 0.8]
    assert client.patch("/api/machines/rig", json={"path": ["up_camera", "crops", "nozzle"], "value": None}).status_code == 200
    assert client.get("/api/pnp/placing").json()["document"]["camera_crops"] == {"part": [0.2, 0.2, 0.8, 0.8]}


# --- pcbv ----------------------------------------------------------------------------


class ServedPcbv:
    """A stand-in for `pcbv serve --listen`: `hello` names a crop when it
    takes crops (`crops`), every request is kept, `spot` finds nothing."""

    def __init__(self, crops: bool) -> None:
        self.crops = crops
        self.requests: list[dict] = []
        self.listener = socket.create_server(("127.0.0.1", 0))
        self.port = self.listener.getsockname()[1]
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self) -> None:
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
                    reply = {"id": rid, "version": "0.1.0", "camera": "/dev/video0", "board": None, "lens": None}
                    if self.crops:
                        reply["crop"] = None
                elif cmd == "camera":
                    reply = {"id": rid, "ok": True}
                elif cmd == "spot":
                    reply = {"id": rid, "found": False}
                elif cmd == "edges":
                    reply = {"id": rid, "lines": [], "width": 640, "height": 480, "lens": False}
                elif cmd == "crop" and self.crops:
                    reply = {"id": rid, "ok": True}
                else:
                    reply = {"id": rid, "error": f"unknown cmd {cmd!r}"}
                stream.write(json.dumps(reply).encode() + b"\n")
                stream.flush()

    def close(self) -> None:
        self.listener.close()


def test_a_pcbv_that_takes_crops_is_sent_them_and_an_older_one_looks_at_the_whole_picture():
    box = (0.4, 0.35, 0.6, 0.65)
    served = ServedPcbv(crops=True)
    client = VisionClient()
    try:
        client.start(f"socket://127.0.0.1:{served.port}", "640x480", 15, "pcbv")
        assert client.can_crop
        assert "uncropped" not in client.spot(radius=50.0, crop=box)
        assert "uncropped" not in client.edges(4, crop=box)
        assert client.set_crop(box)["ok"] is True
        client.set_crop(None)
        sent = {request["cmd"]: request for request in served.requests}
        assert served.requests[-1] == {"id": served.requests[-1]["id"], "cmd": "crop", "box": None}
        assert sent["spot"]["crop"] == list(box) and sent["edges"]["crop"] == list(box)
        assert [r["box"] for r in served.requests if r["cmd"] == "crop"] == [list(box), None]
        # No crop asked for, none sent.
        client.spot()
        assert "crop" not in served.requests[-1]
    finally:
        client.close()
        served.close()

    older = ServedPcbv(crops=False)
    client = VisionClient()
    try:
        client.start(f"socket://127.0.0.1:{older.port}", "640x480", 15, "pcbv")
        assert not client.can_crop
        assert client.spot(crop=box)["uncropped"] is True
        assert client.edges(4, crop=box)["uncropped"] is True
        assert all("crop" not in request for request in older.requests)
        with pytest.raises(VisionError, match="takes no crops"):
            client.set_crop(box)
    finally:
        client.close()
        older.close()


# --- the cameras' routines -------------------------------------------------------------


class CroppingUpCamera(DeviceUpCamera):
    """The fake device's up camera, its looks kept with the crop and the
    radius each was asked within; a static dark speck sits `speck` px from
    the picture's center, nearer than the nozzle's tip, unless a crop
    leaves it out."""

    def __init__(self, *args, speck=(60.0, 0.0), takes_crops: bool = True, **extra) -> None:
        super().__init__(*args, **extra)
        self.speck = speck
        self.can_crop = takes_crops
        self.asked: list[dict] = []

    def spot(self, radius=None, polarity="dark", min_area=None, max_area=None, min_roundness=None, color=None, crop=None):
        self.asked.append({"radius": radius, "crop": crop, "polarity": polarity})
        seen = self.spot_at(self.fake.bed_position, self.fake.angle, polarity)
        if polarity == "dark":
            u, v = self.speck
            inside = crop is None or not self.can_crop or (crop[0] <= (640 + u) / 1280 <= crop[2] and crop[1] <= (360 + v) / 720 <= crop[3])
            if inside and (not seen["found"] or np.hypot(u, v) < np.hypot(seen["dx"], seen["dy"])):
                seen = {"found": True, "dx": u, "dy": v, "x": 640 + u, "y": 360 + v, "area": 300.0, "major": 20.0, "minor": 19.0, "contrast": 70.0}
            if crop is not None and self.can_crop and seen["found"]:
                if not (crop[0] <= seen["x"] / 1280 <= crop[2] and crop[1] <= seen["y"] / 720 <= crop[3]):
                    seen = {"found": False}
        return {**seen, "uncropped": True} if crop is not None and not self.can_crop else seen


def rig(client, text: str) -> None:
    (client.backend.machine_store.directory / "rig.toml").write_text(gcode_file(text), encoding="utf-8")
    connect(client, "rig")


def routine_done(client) -> dict:
    wait_for(lambda: client.get("/api/pnp").json()["routine"]["state"] != "running")
    return client.get("/api/pnp").json()["routine"]


def test_the_nozzle_crop_keeps_center_nozzle_off_a_speck_beside_the_tip(client):
    # The speck sits 60 px right of the picture's center, the tip 90 px
    # left of it at the start: uncropped, centering takes the speck, which
    # does not move with the head, and fails at its scale step.
    rig(client, PROFILE)
    camera = CroppingUpCamera(client.fake, where=(150.0, 30.0), roll=0.0, mirror=True)
    client.backend.pnp.client = camera
    client.post("/api/command", json={"line": "G0 X150.9 Y30"})
    assert client.post("/api/pnp/nozzle", json={"step": 1.0}).status_code == 200
    routine = routine_done(client)
    assert routine["state"] == "error", routine
    assert routine["crop"] == {"task": "nozzle", "box": None}
    # A nozzle crop of the picture's left part keeps the speck out.
    box = [0.2, 0.3, 0.54, 0.7]
    assert client.patch("/api/machines/rig", json={"path": ["up_camera", "crops", "nozzle"], "value": box}).status_code == 200
    camera.asked.clear()
    client.post("/api/command", json={"line": "G0 X150.9 Y30"})
    assert client.post("/api/pnp/nozzle", json={"step": 1.0}).status_code == 200
    routine = routine_done(client)
    assert routine["state"] == "done", routine
    assert routine["crop"] == {"task": "nozzle", "box": box}
    assert client.get("/api/pnp/placing").json()["camera"]["position"] == pytest.approx([150.0, 30.0], abs=0.005)
    # Every look kept to the crop, its radius clipped to the crop's reach.
    assert camera.asked and all(look["crop"] == tuple(box) for look in camera.asked)
    assert all(look["radius"] == pytest.approx(reach(tuple(box), 1280.0, 720.0)) for look in camera.asked)
    # Look once at the part keeps to the part's crop, none here.
    look = client.post("/api/pnp/look", json={"spot": "part"}).json()["look"]
    assert "crop" not in look and camera.asked[-1]["crop"] is None
    look = client.post("/api/pnp/look", json={"spot": "nozzle"}).json()["look"]
    assert look["crop"] == {"task": "nozzle", "box": box}


def test_a_pcbv_without_crops_is_named_once_and_looks_at_the_whole_picture(client):
    text = PROFILE + "[up_camera.crops]\nnozzle = [0.2, 0.3, 0.54, 0.7]\n"
    rig(client, text)
    camera = CroppingUpCamera(client.fake, where=(150.0, 30.0), roll=0.0, mirror=True, speck=(600.0, 300.0), takes_crops=False)
    client.backend.pnp.client = camera
    messages: list[tuple[str, str]] = []
    client.backend.pnp._message = lambda level, text: messages.append((level, text))
    client.post("/api/command", json={"line": "G0 X150.4 Y30"})
    assert client.post("/api/pnp/nozzle", json={"step": 1.0}).status_code == 200
    assert routine_done(client)["state"] == "done"
    said = [text for level, text in messages if NO_CROPS in text]
    assert len(said) == 1 and messages[[t for _, t in messages].index(said[0])][0] == "warning"


class CroppingTopCamera(DeviceTopCamera):
    """The fake device's top camera, taking crops: its looks kept, the
    board crop told to it kept, and only spots inside a spot's crop found."""

    def __init__(self, *args, **extra) -> None:
        super().__init__(*args, **extra)
        self.can_crop = True
        self.asked: list[dict] = []
        self.board_crops: list = []

    def start(self, device, size, fps, pcbv):
        self.running = True
        return {"version": "0.1.0", "camera": device, "board": None, "crop": None}

    def set_crop(self, crop):
        self.board_crops.append(crop)
        return {"ok": True}

    def spot(self, radius=None, polarity="dark", min_area=None, max_area=None, min_roundness=None, color=None, crop=None):
        self.asked.append({"radius": radius, "crop": crop})
        found = super().spot(radius, polarity, min_area, max_area, min_roundness, color)
        if crop is not None and found.get("found"):
            if not (crop[0] <= found["x"] / 1280 <= crop[2] and crop[1] <= found["y"] / 720 <= crop[3]):
                return {"found": False}
        return found

    def edges(self, most=8, color=None, crop=None):
        self.asked.append({"edges": most, "crop": crop})
        return {"lines": [], "width": 1280, "height": 720}


def test_the_top_cameras_tasks_keep_to_their_crops_and_its_board_crop_is_sent(client):
    offset = (34.0, -9.0)
    text = PROFILE + "[top_camera.crops]\nboard = [0.1, 0.1, 0.9, 0.9]\nspot = [0.25, 0.25, 0.75, 0.75]\nedges = [0.0, 0.5, 1.0, 1.0]\n"
    rig(client, text)
    # A dark mark 8 mm off the picture's center along X (400 px at 0.02 mm
    # a pixel, a share of 0.81): outside the spot crop.
    camera = CroppingTopCamera(client.fake, offset, [("dark", 120.0 + offset[0] + 8.0, 80.0 + offset[1], 1.0, 1.0)], roll=0.0)
    client.backend.top.client = camera
    client.post("/api/command", json={"line": "G0 X120 Y80"})
    look = client.post("/api/pnp/top/look").json()["top"]["look"]
    assert look["found"] is False and look["crop"] == {"task": "spot", "box": [0.25, 0.25, 0.75, 0.75]}
    assert camera.asked[-1]["crop"] == (0.25, 0.25, 0.75, 0.75)
    # The edge view keeps to the edges crop.
    edges = client.get("/api/cameras/edges", params={"camera": "top"}).json()
    assert edges["crop"] == [0.0, 0.5, 1.0, 1.0] and camera.asked[-1]["crop"] == (0.0, 0.5, 1.0, 1.0)
    # The board crop goes to pcbv at the start and again when the file changes.
    client.backend.top.client.running = False
    client.backend.top.start()
    assert camera.board_crops == [(0.1, 0.1, 0.9, 0.9)]
    assert client.patch("/api/machines/rig", json={"path": ["top_camera", "crops", "board"], "value": None}).status_code == 200
    assert camera.board_crops[-1] is None
    # Search records keep the crops the look kept to.
    picture = client.backend._top_picture(client.backend.placing_machine())
    assert picture["crops"] == {"spot": [0.25, 0.25, 0.75, 0.75], "edges": [0.0, 0.5, 1.0, 1.0]}


def test_the_busy_test_measures_only_the_measure_crop():
    class Client:
        def gray(self, width=None):
            # Busy on the left half only.
            picture = np.zeros((40, 80), dtype=np.uint8)
            picture[:, :40:2] = 255
            return {"width": 80, "height": 40, "format": "gray", "age_ms": 0, "frame": 1}, picture.tobytes()

    box: list = [None]
    look = BoardLook(lambda: Client(), lambda: None, paused=lambda: False, crop=lambda: box[0])
    whole, _, _ = look.busy(0.0, lambda: False)
    box[0] = (0.5, 0.0, 1.0, 1.0)
    right, _, _ = look.busy(0.0, lambda: False)
    box[0] = (0.0, 0.0, 0.5, 1.0)
    left, _, _ = look.busy(0.0, lambda: False)
    assert right == 0.0 and left > whole > 0.0
