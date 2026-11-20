"""Offset by bottom camera: the top camera's offset from the nozzle found
with the bottom camera, the two cameras looking at each other, against a
fake G-code machine whose cameras' picture centers lean as real ones do:
the circle finder that reads the bottom camera from above, the arithmetic
that cancels the lean, and the routine end to end."""

from __future__ import annotations

import math

import numpy as np
import pytest
from device_fakes import FakeMarlin, to_picture, wait_for
from fastapi.testclient import TestClient
from gcode_rig import connect, gcode_file, rig_backend

from spinny_web import camera as camera_module
from spinny_web import topcam
from spinny_web.app import create_app
from spinny_web.pictures import gradient_center, round_edge
from spinny_web.pnp import PnpError
from spinny_web.topcam import facing_result, facing_words

# --- the fake machine's cameras ---------------------------------------------------
#
# Heights in mm above the bottom camera's lens: its ring light at RING, the
# nozzle's tip sharp over it at TIP, the top camera's lens at TOP. The
# bottom camera's lens sits at BOTTOM on the machine and its picture's
# center looks up along a line leaning BOTTOM_LEAN mm across per mm up;
# the top camera's lens is LENS from the nozzle and its picture's center
# looks down along a line leaning TOP_LEAN. Pinhole cameras: mm a pixel is
# the distance over the focal length in px.
BOTTOM = (150.0, 30.0)
BOTTOM_LEAN = (0.012, -0.008)
TOP_LEAN = (-0.015, 0.01)
LENS = (34.0, -9.0)
RING, TIP, TOP = 2.0, 30.0, 100.0
BOTTOM_FOCAL, TOP_FOCAL = 600.0, 4000.0
BOTTOM_ROLL, TOP_ROLL = 3.0, 1.5
RING_MM = 9.0


def bottom_line(z: float) -> tuple[float, float]:
    """Where the bottom camera's picture center looks at height z."""
    return (BOTTOM[0] + BOTTOM_LEAN[0] * z, BOTTOM[1] + BOTTOM_LEAN[1] * z)


def top_line(head, z: float) -> tuple[float, float]:
    """Where the top camera's picture center looks at height z, the head at `head`."""
    return (head[0] + LENS[0] + TOP_LEAN[0] * (z - TOP), head[1] + LENS[1] + TOP_LEAN[1] * (z - TOP))


def bottom_scale(z: float) -> float:
    return z / BOTTOM_FOCAL


def top_scale(z: float) -> float:
    return (TOP - z) / TOP_FOCAL


# What the geometry makes of each: the head with the tip over the bottom
# camera's picture center, the offset each look alone finds, and the true
# one at the tip's height.
NOZZLE = bottom_line(TIP)
TRUE_OFFSET = (LENS[0] + TOP_LEAN[0] * (TIP - TOP), LENS[1] + TOP_LEAN[1] * (TIP - TOP))
BY_DOWN = (
    BOTTOM_LEAN[0] * (TIP - RING) + LENS[0] + TOP_LEAN[0] * (RING - TOP),
    BOTTOM_LEAN[1] * (TIP - RING) + LENS[1] + TOP_LEAN[1] * (RING - TOP),
)
BY_UP = (LENS[0] + BOTTOM_LEAN[0] * (TIP - TOP), LENS[1] + BOTTOM_LEAN[1] * (TIP - TOP))
SHARE = (TIP - RING) / (TOP - RING)


def ring_picture(center: tuple[float, float], radius: float, width: int, seed: int) -> np.ndarray:
    """A 1280x720 picture of a ring light seen far out of focus, shrunk to
    `width`: dark inside a bright band, grey beyond, its inner edge
    `radius` px about `center` (px from the picture's center), with noise."""
    factor = 1280.0 / width
    height = int(round(720.0 / factor))
    ys, xs = np.mgrid[0:height, 0:width].astype(np.float64)
    r = np.hypot((xs + 0.5) * factor - 640.0 - center[0], (ys + 0.5) * factor - 360.0 - center[1])
    inner = 0.5 * (1.0 + np.tanh((r - radius) / 8.0))
    outer = 0.5 * (1.0 + np.tanh((r - radius - 45.0) / 8.0))
    luma = 6.0 + 229.0 * inner - 35.0 * outer
    noise = np.random.default_rng(seed).normal(0.0, 1.5, luma.shape)
    return np.clip(luma + noise, 0, 255).astype(np.uint8)


class FacingTopCamera:
    """The top camera on the fake head: it sees the bottom camera's ring
    light where the geometry puts it, as luma pictures (`gray`), each a
    frame of its own; `still` draws the ring at the picture's middle
    wherever the head is (a reflection riding on the head)."""

    def __init__(self, fake: FakeMarlin, still: bool = False) -> None:
        self.fake = fake
        self.still = still
        self.running = True
        self.device = "/dev/video4"
        self.frames = 0

    def ring(self) -> tuple[tuple[float, float], float]:
        head = self.fake.bed_position[:2]
        if self.still:
            return (0.0, 0.0), 400.0
        ring = bottom_line(RING)
        look = top_line(head, RING)
        center = to_picture((ring[0] - look[0], ring[1] - look[1]), TOP_ROLL, False, top_scale(RING))
        return center, RING_MM / top_scale(RING)

    def gray(self, width=None):
        width = int(width or 1280)
        self.frames += 1
        center, radius = self.ring()
        data = ring_picture(center, radius, width, self.frames)
        return {"width": width, "height": data.shape[0], "format": "gray", "frame": self.frames, "age_ms": 0}, data.tobytes()

    def pose(self):
        return {"state": "none", "width": 1280, "height": 720, "frame": self.frames, "age_ms": 0, "fps": 30.0, "spots": 0}

    def close(self):
        self.running = False


class FacingUpCamera:
    """The bottom camera fixed to the fake machine: with the nozzle down at
    the camera's height it sees the tip (the dark spot), with the head up
    the top camera's lens (a dark disc 6 mm across), each where the
    geometry puts it."""

    def __init__(self, fake: FakeMarlin, tip_z: float) -> None:
        self.fake = fake
        self.tip_z = tip_z
        self.running = True
        self.device = "/dev/video1"
        self.lens_looks = 0

    def spot(self, radius=None, polarity="dark", min_area=None, max_area=None, min_roundness=None, color=None, crop=None):
        x, y, z = self.fake.bed_position
        if polarity != "dark":
            return {"found": False}
        if z <= self.tip_z + 0.5:
            line = bottom_line(TIP)
            u, v = to_picture((x - line[0], y - line[1]), BOTTOM_ROLL, True, bottom_scale(TIP))
            size = (24.0, 22.0)
        else:
            self.lens_looks += 1
            line = bottom_line(TOP)
            u, v = to_picture((x + LENS[0] - line[0], y + LENS[1] - line[1]), BOTTOM_ROLL, True, bottom_scale(TOP))
            across = 6.0 / bottom_scale(TOP)
            size = (across, across * 0.98)
        area = math.pi * size[0] * size[1] / 4.0
        if (radius is not None and math.hypot(u, v) > radius) or (min_area is not None and area < min_area):
            return {"found": False}
        return {"found": True, "dx": u, "dy": v, "x": 640.0 + u, "y": 360.0 + v, "area": area, "major": size[0], "minor": size[1], "contrast": 80.0}

    def pose(self):
        return {"state": "none", "width": 1280, "height": 720, "frame": 1, "age_ms": 0, "fps": 30.0, "spots": 0}

    def close(self):
        self.running = False


PROFILE = """name = "rig"
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
[camera]
z = -4
position = [150.5, 29.6]
[top_camera]
offset = [34.0, -9.0]
{top}
"""


@pytest.fixture
def client(tmp_path, monkeypatch):
    # The fakes' pictures are of the head at rest the moment it arrives.
    monkeypatch.setattr(camera_module, "SETTLE_SECONDS", 0.0)
    monkeypatch.setattr(topcam, "SETTLE_SECONDS", 0.0)
    fake = FakeMarlin(position=(100.0, 50.0, 5.0))
    backend = rig_backend(tmp_path, {}, lambda url, baud: fake)
    app = create_app(backend, frontend=tmp_path / "no-dist")
    with TestClient(app) as client:
        client.backend = backend
        client.fake = fake
        yield client


def rig(client, top: str = "", still: bool = False) -> tuple[FacingTopCamera, FacingUpCamera]:
    """The machine file saved and connected, both fake cameras in place,
    the top camera's picture measured at the board (the tip's height)."""
    (client.backend.machine_store.directory / "rig.toml").write_text(gcode_file(PROFILE.format(top=top)), encoding="utf-8")
    connect(client, "rig")
    looking_down = FacingTopCamera(client.fake, still)
    looking_up = FacingUpCamera(client.fake, -4.0)
    client.backend.top.client = looking_down
    client.backend.pnp.client = looking_up
    return looking_down, looking_up


def measured_board(client) -> None:
    client.backend.top.update({"mm_per_px": top_scale(TIP), "roll": TOP_ROLL, "mirror": False})


def facing(client, **body) -> dict:
    """Offset by bottom camera run to its end: its progress."""
    response = client.post("/api/pnp/top/offset/facing", json=body)
    assert response.status_code == 200, response.text
    wait_for(lambda: client.get("/api/pnp/placing").json()["top"]["routine"]["state"] != "running")
    return client.get("/api/pnp/placing").json()["top"]["routine"]


# --- the circle finder ---------------------------------------------------------------


@pytest.mark.parametrize("center", [(0.0, 0.0), (-21.7, -16.1), (95.0, -60.0), (-140.0, 75.0)])
def test_a_ring_wider_than_the_picture_is_found_by_its_edge(center):
    # The ring's inner edge is 450 px about its center: its top and bottom
    # leave the 720 px picture, as the LumenPnP's bottom camera does seen
    # from its top camera; the circle fitted to the arcs left finds it.
    picture = ring_picture(center, 450.0, 640, seed=3)
    found = round_edge(picture)
    assert found is not None
    full = found.scaled(2.0)
    assert (full.dx, full.dy) == pytest.approx(center, abs=0.25)
    assert full.radius == pytest.approx(450.0, abs=3.0) and found.rays >= 100


def test_a_picture_with_no_round_edge_has_none_and_the_gradients_meet_in_its_middle():
    flat = np.full((360, 640), 120, dtype=np.uint8)
    assert round_edge(flat) is None
    assert gradient_center(flat) == pytest.approx((320.0, 180.0))


# --- the arithmetic -------------------------------------------------------------------


def test_the_two_looks_combined_by_the_tips_height_give_the_true_offset():
    down_head = (NOZZLE[0] - BY_DOWN[0], NOZZLE[1] - BY_DOWN[1])
    up_head = (NOZZLE[0] - BY_UP[0], NOZZLE[1] - BY_UP[1])
    result = facing_result(NOZZLE, down_head, up_head, top_scale(RING), bottom_scale(TOP), top_scale(TIP), bottom_scale(TIP))
    # Each look alone is off by the lean, the two by over 1.5 mm.
    assert math.dist(BY_DOWN, TRUE_OFFSET) > 0.5 and math.dist(BY_UP, TRUE_OFFSET) > 1.0
    assert result["share"] == pytest.approx(SHARE, abs=1e-4)
    assert result["offset"] == pytest.approx(TRUE_OFFSET, abs=1e-3)
    # The bottom camera counts the share from its lens, not its ring: near.
    assert result["share_up"] == pytest.approx(TIP / TOP, abs=1e-4)
    assert "doubtful" not in facing_words(result)
    # Without the top camera's scale at the board, the bottom camera's share.
    alone = facing_result(NOZZLE, down_head, up_head, top_scale(RING), bottom_scale(TOP), None, bottom_scale(TIP))
    assert alone["share"] == pytest.approx(TIP / TOP, abs=1e-4) and alone["share_down"] is None


def test_scales_that_put_the_tip_outside_the_cameras_are_refused_and_far_apart_ones_doubted():
    with pytest.raises(PnpError, match="between them"):
        facing_result(NOZZLE, (0.0, 0.0), (1.0, 1.0), 0.01, 0.1, 0.02, 0.05)
    result = facing_result(NOZZLE, (0.0, 0.0), (1.0, 1.0), top_scale(RING), bottom_scale(TOP), top_scale(TIP), bottom_scale(TIP) * 1.5)
    assert "doubtful" in facing_words(result)


# --- the routine ------------------------------------------------------------------------


def test_offset_by_the_bottom_camera_centers_the_nozzle_then_cancels_the_cameras_lean(client):
    rig(client)
    measured_board(client)
    routine = facing(client, step=2.0)
    assert routine["state"] == "done", routine
    state = client.get("/api/pnp/placing").json()
    top = state["top"]
    # The nozzle was centered and kept as Center nozzle keeps it.
    assert state["camera"]["position"] == pytest.approx(NOZZLE, abs=0.005)
    assert top["offset"] == pytest.approx(TRUE_OFFSET, abs=0.01)
    numbers = top["facing"]
    assert numbers["by_down"] == pytest.approx(BY_DOWN, abs=0.01) and numbers["by_up"] == pytest.approx(BY_UP, abs=0.01)
    assert numbers["share"] == pytest.approx(SHARE, abs=0.005) and numbers["share_up"] == pytest.approx(TIP / TOP, abs=0.005)
    assert numbers["down_scale"] == pytest.approx(top_scale(RING), rel=0.01) and numbers["up_scale"] == pytest.approx(bottom_scale(TOP), rel=0.01)
    assert numbers["lens"]["shade"] == "dark" and numbers["before"] is None
    # The bottom camera's routine showed while the nozzle was centered.
    assert client.get("/api/pnp").json()["routine"]["state"] == "done"
    # Kept at once and logged: Undo takes the offset back.
    entry = top["applied"]
    assert entry["kind"] == "offset" and "by the bottom camera" in entry["text"]
    undone = client.post(f"/api/findings/{entry['id']}/undo")
    assert undone.status_code == 200, undone.text
    assert undone.json()["state"]["top"]["offset"] is None


def test_offset_by_the_bottom_camera_without_the_nozzle_keeps_the_head_up(client):
    rig(client)
    measured_board(client)
    client.backend.config.setdefault("placing", {}).setdefault("rig", {})["camera"] = {
        "position": list(NOZZLE), "mm_per_px": bottom_scale(TIP), "roll": BOTTOM_ROLL, "mirror": True,
    }
    client.fake.lines.clear()
    routine = facing(client, step=1.5, nozzle=False)
    assert routine["state"] == "done", routine
    assert client.get("/api/pnp/placing").json()["top"]["offset"] == pytest.approx(TRUE_OFFSET, abs=0.01)
    # Only moves across at the travel height: no Z line below it.
    heights = [float(word[1:]) for line in client.fake.lines for word in line.split() if word.startswith("Z")]
    assert all(z >= 5.0 for z in heights), heights


def test_a_ring_that_rides_with_the_head_is_refused(client):
    # A reflection of the top camera's own light stays put in its picture.
    rig(client, still=True)
    measured_board(client)
    routine = facing(client, step=2.0)
    assert routine["state"] == "error" and "looking down at the bottom camera" in routine["error"], routine
    assert client.get("/api/pnp/placing").json()["top"]["offset"] is None


def test_offset_by_the_bottom_camera_needs_the_bottom_camera_running_and_its_place(client):
    _, looking_up = rig(client)
    looking_up.running = False
    response = client.post("/api/pnp/top/offset/facing", json={})
    assert response.status_code == 400 and "bottom camera is not running" in response.json()["detail"]
    looking_up.running = True
    response = client.post("/api/pnp/top/offset/facing", json={"nozzle": False})
    assert response.status_code == 400 and "center it first" in response.json()["detail"]
    response = client.post("/api/pnp/top/offset/facing", json={"step": 0})
    assert response.status_code == 400 and "step" in response.json()["detail"]
