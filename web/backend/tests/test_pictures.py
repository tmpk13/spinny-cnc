"""Measuring pictures by their pixels: the shift between two pictures,
the camera's map fitted to head moves, how busy a picture is, and Measure
camera run on a fake head over a textured surface."""

from __future__ import annotations

import math
import time

import numpy as np
import pytest

from spinny_web import topcam
from spinny_web.camera import machine_to_picture, picture_to_machine
from spinny_web.pictures import BUSY_CONTRAST, busy_share, fit_camera, gray_array, phase_shift
from spinny_web.pnp import RUNNING
from spinny_web.topcam import TopCamera, nearest_turn

class Texture:
    """A surface with texture at every place and no repeat: a sum of plane
    waves of random direction, wavelength (0.1 to 2 mm) and phase, its
    value exact at any machine point (mm), so a picture of it shifted by
    a fraction of a pixel is exactly that."""

    def __init__(self, seed: int = 3, waves: int = 160) -> None:
        rng = np.random.default_rng(seed)
        frequency = rng.uniform(0.5, 10.0, waves)
        angle = rng.uniform(0.0, 2.0 * math.pi, waves)
        self.fx = frequency * np.cos(angle)
        self.fy = frequency * np.sin(angle)
        self.phase = rng.uniform(0.0, 2.0 * math.pi, waves)
        self.amplitude = 1.0 / frequency

    def at(self, x: np.ndarray, y: np.ndarray) -> np.ndarray:
        total = np.zeros_like(x)
        for fx, fy, phase, amplitude in zip(self.fx, self.fy, self.phase, self.amplitude):
            total += amplitude * np.cos(2.0 * math.pi * (fx * x + fy * y) + phase)
        return 128.0 + 40.0 * total / math.sqrt(float((self.amplitude ** 2).sum()) / 2.0)


def texture(seed: int = 3) -> Texture:
    return Texture(seed)


def picture(surface: Texture, center, scale, roll, mirror, width=320, height=180, lens: float = 0.0) -> np.ndarray:
    """What a camera of that scale, roll and mirror sees about `center`;
    with `lens` k, a scene point p (from the center, over the half
    diagonal) shows at p (1 + k |p|^2)."""
    du, dv = np.meshgrid(np.arange(width) - width / 2.0, np.arange(height) - height / 2.0)
    if lens:
        # Each pixel's scene point: the lens undone, two rounds from the pixel.
        norm = math.hypot(width / 2.0, height / 2.0)
        x, y = du / norm, dv / norm
        px, py = x, y
        for _ in range(3):
            r2 = px * px + py * py
            px, py = x / (1.0 + lens * r2), y / (1.0 + lens * r2)
        du, dv = px * norm, py * norm
    u = -du if mirror else du
    v = -dv
    c, s = math.cos(math.radians(roll)), math.sin(math.radians(roll))
    x = center[0] + scale * (u * c - v * s)
    y = center[1] + scale * (u * s + v * c)
    return surface.at(x, y)


def test_the_shift_between_two_pictures_is_found_to_hundredths_of_a_pixel():
    surface = texture()
    scale = 0.03
    first = picture(surface, (7.0, 7.0), scale, 0.0, False)
    for move in ((0.369, -0.1368), (-0.9, 0.6), (0.0, 0.15), (0.012, 0.003)):
        second = picture(surface, (7.0 + move[0], 7.0 + move[1]), scale, 0.0, False)
        dx, dy, peak = phase_shift(first, second)
        # The head moving +X moves the scene left: -move / scale, y down.
        assert dx == pytest.approx(-move[0] / scale, abs=0.05) and dy == pytest.approx(move[1] / scale, abs=0.05)
        assert peak > 0.2
    assert phase_shift(first, picture(surface, (7.3, 7.0), scale, 0.0, False))[2] > 0.9
    # Unrelated pictures barely correlate.
    rng = np.random.default_rng(1)
    assert phase_shift(rng.random((180, 320)) * 255.0, rng.random((180, 320)) * 255.0)[2] < 0.05


@pytest.mark.parametrize(("roll", "mirror", "scale"), [(0.0, False, 0.016), (180.4, False, 0.0161), (-37.0, True, 0.05), (91.0, True, 0.02)])
def test_the_camera_map_comes_from_the_shifts_head_moves_make(roll, mirror, scale):
    moves = [(i * 2.0, j * 2.0) for j in (-1, 0, 1) for i in (-1, 0, 1)]
    # A head move of m shows the scene moved by -m.
    shifts = [machine_to_picture(-m[0], -m[1], scale, roll, mirror) for m in moves]
    fit = fit_camera(moves, shifts)
    assert fit.mirror is mirror
    assert math.cos(math.radians(fit.roll - roll)) == pytest.approx(1.0, abs=1e-9)
    assert fit.mm_per_px == pytest.approx(scale, rel=1e-9) and abs(fit.skew_deg) < 1e-6 and fit.rms_px < 1e-9
    for move, shift in zip(moves, shifts):
        assert picture_to_machine(*shift, fit.mm_per_px, fit.roll, fit.mirror) == pytest.approx((-move[0], -move[1]), abs=1e-9)
    with pytest.raises(ValueError, match="both axes"):
        fit_camera([(1.0, 0.0), (2.0, 0.0)], [(1.0, 0.0), (2.0, 0.0)])
    assert nearest_turn(-179.6, 180.0) == pytest.approx(180.4) and nearest_turn(10.0, 0.0) == pytest.approx(10.0)


def test_a_busy_picture_has_edges_and_a_flat_one_none():
    flat = np.full((180, 320), 40.0)
    assert busy_share(flat) == 0.0
    stripes = np.zeros((180, 320))
    stripes[:, ::8] = 200.0
    assert busy_share(stripes) > 0.2
    # A step under the contrast counts for nothing.
    faint = np.zeros((180, 320))
    faint[:, 160:] = BUSY_CONTRAST - 1.0
    assert busy_share(faint) == 0.0
    reply = {"width": 4, "height": 2, "format": "gray"}
    assert gray_array(reply, bytes(range(8))).shape == (2, 4)
    with pytest.raises(ValueError, match="JPEG"):
        gray_array({**reply, "format": "jpeg"}, bytes(8))
    with pytest.raises(ValueError, match="bytes"):
        gray_array(reply, bytes(7))


def test_a_radial_lens_is_measured_from_the_tiles_of_pictures_the_heads_moves_shift():
    from spinny_web.pictures import fit_lens

    surface = texture()
    scale = 0.024
    moves = [(i * 0.6, j * 0.6) for j in (-1, 0, 1) for i in (-1, 0, 1) if (i, j) != (0, 0)]
    for k in (-0.03, 0.0):
        first = picture(surface, (7.0, 7.0), scale, 180.4, False, lens=k)
        pictures = [picture(surface, (7.0 + mx, 7.0 + my), scale, 180.4, False, lens=k) for mx, my in moves]
        shifts = [phase_shift(first, other)[:2] for other in pictures]
        fit = fit_lens(first, pictures, shifts)
        assert fit is not None and fit.tiles > 500
        # pcbv's k1 undoes the lens: -k to first order.
        assert fit.k1 == pytest.approx(-k, abs=0.004)
        assert fit.worth is (k != 0.0), fit.to_dict()
        # The shifts at the picture's center follow the head's moves at the
        # camera's own scale, the lens taken out.
        assert fit_camera(moves, fit.centers).mm_per_px == pytest.approx(scale, rel=0.002)
    # A crop of the picture: its tiles placed in the whole picture.
    first = picture(surface, (7.0, 7.0), scale, 180.4, False, lens=-0.03)
    pictures = [picture(surface, (7.0 + mx, 7.0 + my), scale, 180.4, False, lens=-0.03) for mx, my in moves]
    cut = (slice(20, 160), slice(40, 300))
    shifts = [phase_shift(first[cut], other[cut])[:2] for other in pictures]
    fit = fit_lens(first[cut], [other[cut] for other in pictures], shifts, (320.0, 180.0), (40.0, 20.0))
    assert fit is not None and fit.k1 == pytest.approx(0.03, abs=0.006)


class TexturedCamera:
    """A top camera over a textured surface, on a fake head; `lens` as
    picture() takes it."""

    def __init__(self, mover, scale: float, roll: float, mirror: bool, lens: float = 0.0) -> None:
        self.mover = mover
        self.surface = texture()
        self.scale, self.roll, self.mirror = scale, roll, mirror
        self.distortion = lens
        # The lens corrections pcbv was told, in turn.
        self.lenses: list = []
        self.running = True
        self.asked = 0

    def lens(self, lens):
        self.lenses.append(lens)
        return {"ok": True}

    def gray(self, width=None):
        self.asked += 1
        pixels = picture(self.surface, self.mover.place, self.scale, self.roll, self.mirror, lens=self.distortion)
        data = np.clip(pixels, 0, 255).astype(np.uint8).tobytes()
        return {"width": 320, "height": 180, "frame": self.asked, "age_ms": 0, "format": "gray"}, data

    def pose(self):
        return {"state": "none", "width": 320, "height": 180, "frame": self.asked, "age_ms": 0}

    def close(self):
        self.running = False


class Head:
    name = "gcode"

    def __init__(self, place) -> None:
        self.place = place
        self.places = []
        self.heights = []

    def check(self) -> None:
        pass

    def begin(self) -> None:
        pass

    def stopped(self) -> bool:
        return False

    def here(self):
        return self.place

    def lift(self) -> None:
        self.heights.append("safe")

    def lower(self, height: float) -> None:
        self.heights.append(height)

    def go(self, point) -> None:
        self.place = (float(point[0]), float(point[1]))
        self.places.append(self.place)

    def halt(self) -> None:
        pass

    def describe(self, point) -> str:
        return f"X {point[0]:.3f} Y {point[1]:.3f}"


@pytest.mark.parametrize(("roll", "mirror", "kept_roll"), [(180.4, False, 180.0), (12.0, True, 0.0)])
def test_measure_camera_finds_the_scale_roll_and_mirror_from_the_heads_moves(monkeypatch, roll, mirror, kept_roll):
    monkeypatch.setattr(topcam, "SETTLE_SECONDS", 0.0)
    store: dict = {"top": {"size": "640x360", "roll": kept_roll}}
    said = []
    camera = TopCamera(lambda: store, lambda: None, lambda: None, lambda kind, text: said.append((kind, text)))
    head = Head((7.0, 7.0))
    # The camera's pictures are shrunk to half of its 640 px: 0.012 mm a
    # full size px shows 0.024 in them.
    camera.client = TexturedCamera(head, 0.024, roll, mirror)
    camera.measure_picture(head, 0.0, 31.5, near_roll=kept_roll)
    deadline = time.monotonic() + 30.0
    while camera.progress.state == RUNNING and time.monotonic() < deadline:
        time.sleep(0.02)
    assert camera.progress.state == "done", (camera.progress.error, said)
    settings = camera.settings()
    assert settings.mm_per_px == pytest.approx(0.012, rel=0.003)
    assert settings.mirror is mirror
    # Written the way nearest the roll in use.
    assert abs(settings.roll - roll) < 0.05 or abs(settings.roll - (roll - 360.0)) < 0.05
    assert abs(settings.roll - kept_roll) <= 180.0
    numbers = camera.measured_picture
    assert numbers["pictures"] == 1 + 2 * 9 and numbers["rms_px"] < 0.5 and numbers["returned_um"] < 5.0
    # Up to the looking height, then 3 by 3 places about the start, twice.
    assert head.heights == ["safe", 31.5] and head.place == (7.0, 7.0)
    assert {(round(p[0] - 7.0, 3), round(p[1] - 7.0, 3)) for p in head.places} >= {(numbers["step"], 0.0), (0.0, -numbers["step"])}
    assert said and said[-1][0] == "info" and "um a pixel" in said[-1][1]
    # Kept at once and logged with its values before, for Undo.
    entry = camera.findings.newest()
    assert entry is not None and entry["kind"] == "camera"
    assert {change["name"] for change in entry["changes"]} >= {"mm_per_px", "roll"}
    # A picture without a lens keeps none.
    assert settings.lens is None and numbers["lens"] is not None and numbers["lens"]["worth"] is False


def test_measure_camera_keeps_the_lens_it_finds_and_the_scale_at_the_pictures_center(monkeypatch):
    monkeypatch.setattr(topcam, "SETTLE_SECONDS", 0.0)
    store: dict = {"top": {"size": "640x360", "roll": 180.0}}
    said = []
    camera = TopCamera(lambda: store, lambda: None, lambda: None, lambda kind, text: said.append((kind, text)))
    head = Head((7.0, 7.0))
    camera.client = TexturedCamera(head, 0.024, 180.4, False, lens=-0.03)
    camera.measure_picture(head, 0.0, 31.5, near_roll=180.0)
    deadline = time.monotonic() + 60.0
    while camera.progress.state == RUNNING and time.monotonic() < deadline:
        time.sleep(0.02)
    assert camera.progress.state == "done", (camera.progress.error, said)
    settings = camera.settings()
    assert settings.lens is not None and settings.lens["k1"] == pytest.approx(0.03, abs=0.005)
    assert (settings.lens["k2"], settings.lens["width"], settings.lens["height"]) == (0.0, 640, 360)
    # The scale at the picture's center, where pcbv's correction leaves it.
    assert settings.mm_per_px == pytest.approx(0.012, rel=0.003)
    assert "the lens +0.0" in said[-1][1]
    # The roll from the whole pictures, where a radial lens bends nothing.
    assert settings.roll == pytest.approx(180.4, abs=0.02)
    entry = camera.findings.newest()
    assert "lens" in {change["name"] for change in entry["changes"]}
    # The running pcbv was told it at once.
    assert camera.client.lenses == [settings.lens]
