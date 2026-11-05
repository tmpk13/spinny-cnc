"""The camera log: the pictures the routines looked at, and photos by hand."""

from __future__ import annotations

import base64
import json
import time

import pytest
from fake_serial import FakeSerial, fake_opener
from fastapi.testclient import TestClient

from spinny_web import camlog as camlog_module
from spinny_web.app import Backend, create_app
from spinny_web.camlog import CameraLog, overlay_svg
from spinny_web.link import Link

JPEG = bytes([0xFF, 0xD8, 0xFF]) + b"picture" + bytes([0xFF, 0xD9])
POSED = bytes([0xFF, 0xD8, 0xFF]) + b"posed" + bytes([0xFF, 0xD9])


class Picture:
    """A camera that answers a frame, and a spot found or not."""

    def __init__(self, found: bool = True) -> None:
        self.running = True
        self.found = found
        self.frames: list[bool] = []

    def frame(self, width=None, overlay=False, quality=80):
        self.frames.append(overlay)
        return {"width": 640, "height": 480, "frame": len(self.frames), "age_ms": 5}, POSED if overlay else JPEG

    def spot(self, radius=None, polarity="dark"):
        if not self.found:
            return {"found": False}
        return {"found": True, "x": 332.0, "y": 251.0, "dx": 12.0, "dy": 11.0, "area": 300.0, "major": 20.0, "minor": 12.0, "contrast": 80.0}


def test_a_look_is_kept_only_with_logging_on_or_asked_for(tmp_path):
    published = []
    log = CameraLog(tmp_path / "camlog", publish=published.append)
    camera = Picture()
    assert log.look(camera, "up", "centering the nozzle", "scale", spot=camera.spot()) is None
    assert camera.frames == []
    log.set_enabled(True)
    entry = log.look(camera, "up", "centering the nozzle", "scale", spot=camera.spot(), note="dark spot, look 1")
    assert entry is not None and entry["camera"] == "up" and entry["step"] == "scale"
    assert entry["spot"]["found"] and entry["width"] == 640
    photo = log.path_of(entry["files"]["photo"])
    overlay = log.path_of(entry["files"]["overlay"])
    assert photo is not None and photo.read_bytes() == JPEG
    # The marks over the picture itself, in one file.
    svg = overlay.read_text()
    assert base64.b64encode(JPEG).decode() in svg
    assert '<rect x="322.0" y="245.0" width="20.0" height="12.0"' in svg
    assert "found at dx +12.0 dy +11.0 px" in svg and "dark spot, look 1" in svg
    assert published[-1]["count"] == 1
    # A pose picture too when asked, and a forced look with logging off.
    log.set_enabled(False)
    posed = log.look(camera, "head", "photo", "by hand", pose=True, force=True)
    assert posed is not None and log.path_of(posed["files"]["pose"]).read_bytes() == POSED
    # The index outlives a restart, newest first in a listing.
    again = CameraLog(tmp_path / "camlog")
    assert [entry["routine"] for entry in again.state()["entries"]] == ["photo", "centering the nozzle"]
    assert again.state(camera="up")["count"] == 1


def test_a_look_that_found_nothing_is_kept_and_says_so(tmp_path):
    log = CameraLog(tmp_path / "camlog", enabled=True)
    camera = Picture(found=False)
    entry = log.look(camera, "up", "looking at the part", "looking", spot=camera.spot())
    svg = log.path_of(entry["files"]["overlay"]).read_text()
    assert "nothing found inside the circle" in svg and "<rect" not in svg
    # A camera with no picture to give keeps nothing and stops nothing.

    class Blind:
        def frame(self, **_):
            raise RuntimeError("no frame")

    assert log.look(Blind(), "up", "looking at the part", "looking") is None


def test_the_oldest_go_with_their_pictures_past_the_most_kept(tmp_path, monkeypatch):
    monkeypatch.setattr(camlog_module, "MAX_ENTRIES", 3)
    log = CameraLog(tmp_path / "camlog", enabled=True)
    camera = Picture()
    entries = [log.look(camera, "head", "finding the mark", f"look {n}") for n in range(5)]
    kept = [entry["step"] for entry in log.state()["entries"]]
    assert kept == ["look 4", "look 3", "look 2"]
    assert log.path_of(entries[0]["files"]["photo"]) is None
    assert log.path_of(entries[4]["files"]["photo"]) is not None
    assert len((tmp_path / "camlog" / "entries.jsonl").read_text().splitlines()) == 3
    assert log.clear() == 3
    assert log.state()["entries"] == [] and list((tmp_path / "camlog").glob("*.jpg")) == []
    # Only a logged picture's name is a file of the log.
    for name in ("../config.json", "entries.jsonl", "20261105-101500-000.png"):
        assert log.path_of(name) is None


def test_the_overlay_marks_the_center_and_the_circle_searched():
    svg = overlay_svg(JPEG, 1280, 720, None, "head camera, photo: by hand")
    assert 'r="240.0"' in svg and "head camera, photo: by hand" in svg
    assert overlay_svg(JPEG, 1280, 720, None, "a < b", radius=100).count("&lt;") == 1


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


def test_logging_is_turned_on_kept_and_photos_are_taken_by_hand(client, tmp_path):
    assert client.get("/api/camlog").json() == {"enabled": False, "count": 0, "entries": []}
    assert client.put("/api/camlog", json={"enabled": True}).json()["enabled"] is True
    assert json.loads((tmp_path / "config.json").read_text())["camlog"] is True
    # Not running: no photo.
    refused = client.post("/api/camlog/photo", json={"camera": "head"})
    assert refused.status_code == 409 and "not running" in refused.text
    assert client.post("/api/camlog/photo", json={"camera": "side"}).status_code == 400
    client.backend.camera.client = Picture()
    taken = client.post("/api/camlog/photo", json={"camera": "head"})
    assert taken.status_code == 200, taken.text
    entry = taken.json()
    assert entry["routine"] == "photo" and entry["spot"]["found"] and entry["note"] == "dark spot"
    picture = client.get(f"/api/camlog/{entry['files']['photo']}")
    assert picture.status_code == 200 and picture.headers["content-type"] == "image/jpeg" and picture.content == JPEG
    drawn = client.get(f"/api/camlog/{entry['files']['overlay']}")
    assert drawn.headers["content-type"].startswith("image/svg+xml") and b"<rect" in drawn.content
    assert client.get("/api/camlog/..%2Fconfig.json").status_code == 404
    # The up camera: what its part finder sees, without the finder.
    client.backend.pnp.client = Picture()
    plain = client.post("/api/camlog/photo", json={"camera": "up", "find": False}).json()
    assert plain["camera"] == "up" and plain["spot"] is None
    listed = client.get("/api/camlog?camera=up").json()
    assert listed["count"] == 1 and listed["entries"][0]["id"] == plain["id"]
    assert client.get("/api/camlog?camera=nope").status_code == 400
    assert client.delete("/api/camlog").json() == {"deleted": 2}


class Stand:
    """A head camera over the mark wherever the head is: every look finds it
    a little off the center, so the routine centers in a try or two."""

    def __init__(self) -> None:
        self.running = True
        self.looks = 0

    def frame(self, width=None, overlay=False, quality=80):
        return {"width": 640, "height": 480, "frame": self.looks, "age_ms": 1}, JPEG

    def pose(self):
        return {"state": "none", "width": 640, "height": 480, "frame": self.looks, "age_ms": 1}

    def close(self):
        self.running = False

    def spot(self, radius=None, polarity="dark"):
        self.looks += 1
        return {"found": True, "x": 320.0, "y": 240.0, "dx": 0.0, "dy": 0.0, "area": 50.0, "major": 8.0, "minor": 8.0, "contrast": 60.0}


def test_every_look_of_the_find_routine_is_kept_while_logging(client):
    client.put("/api/camlog", json={"enabled": True})
    client.backend.camera.set_mark((30.0, 20.0))
    stand = Stand()
    client.backend.camera.client = stand
    client.put("/api/camera/settings", json={"offset": [11.0, -2.0], "roll": 0.0, "mm_per_px": 0.02})
    response = client.post("/api/camera/find", json={"step": 0})
    assert response.status_code == 200, response.text
    deadline = time.monotonic() + 10
    while client.get("/api/camera").json()["routine"]["state"] == "running" and time.monotonic() < deadline:
        time.sleep(0.05)
    entries = client.get("/api/camlog?camera=head").json()["entries"]
    assert len(entries) == stand.looks >= 1
    assert {entry["routine"] for entry in entries} == {"finding the mark"}
    assert entries[-1]["note"] == "look 1"


def test_a_spot_reply_is_kept_without_its_protocol_id(tmp_path):
    log = CameraLog(tmp_path / "camlog", enabled=True)
    entry = log.look(Picture(), "head", "photo", "by hand", spot={"id": 7, "found": False})
    assert entry["spot"] == {"found": False}
