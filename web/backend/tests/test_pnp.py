"""Pick and place: the parts read from a board, the up camera's picture,
the routines that center the nozzle over it and look at a part, and the
routes."""

from __future__ import annotations

import math
import time
from pathlib import Path

import pytest
from fake_serial import FakeSerial, fake_opener
from fastapi.testclient import TestClient

from spinny_web.app import Backend, create_app
from spinny_web.jobs import Design, Group, Job
from spinny_web.link import Link
from spinny_web.pnp import UpCameraSettings, calibrate, footprints_of, job_components, parse_sexp, picture_to_machine

REPO = Path(__file__).resolve().parents[3]
BOARD_SAMPLE = REPO / "toolpath" / "tests" / "data" / "board.kicad_pcb"

# A board as KiCad 10 writes it: every token on a line of its own, a back
# side part, a part left out of the position files, and a logo.
BOARD = """(kicad_pcb
\t(version 20260206)
\t(footprint "Resistor_SMD:R_0603_1608Metric"
\t\t(layer "F.Cu")
\t\t(at 110 80 90)
\t\t(property "Reference" "R1"
\t\t\t(at 0 -1.4 90)
\t\t)
\t\t(property "Value" "10k"
\t\t\t(at 0 1.4 90)
\t\t)
\t\t(attr smd)
\t\t(pad "1" smd roundrect
\t\t\t(at -0.8 0 90)
\t\t)
\t\t(pad "2" smd roundrect
\t\t\t(at 0.8 0 90)
\t\t)
\t)
\t(footprint "Capacitor_SMD:C_0402_1005Metric"
\t\t(layer "B.Cu")
\t\t(at 100 90 180)
\t\t(property "Reference" "C1")
\t\t(property "Value" "100n")
\t\t(attr smd dnp)
\t\t(pad "1" smd rect)
\t\t(pad "2" smd rect)
\t)
\t(footprint "MountingHole:MountingHole_3.2mm"
\t\t(layer "F.Cu")
\t\t(at 95 75)
\t\t(property "Reference" "H1")
\t\t(attr exclude_from_pos_files)
\t)
\t(footprint "Logo:Logo"
\t\t(layer "F.Cu")
\t\t(at 120 95)
\t\t(property "Reference" "G***")
\t\t(attr board_only)
\t)
)
"""

# The same kind of part as KiCad 5 wrote it.
BOARD_V5 = """(kicad_pcb (version 20171130)
  (module Package_SO:SOIC-8 (layer F.Cu) (tedit 5A02F2D3) (at 50.8 30.48 270)
    (fp_text reference U3 (at 0 -3.4 90) (layer F.SilkS))
    (fp_text value "LM358 (dual)" (at 0 3.4 90) (layer F.Fab))
    (attr smd)
    (pad 1 smd rect (at -2.475 -1.905 270) (size 1.95 0.6))
  )
)
"""


def test_an_s_expression_reads_with_its_strings_unquoted():
    assert parse_sexp('(a "b c" (d 1.5) "e \\"f\\"")') == [["a", "b c", ["d", "1.5"], 'e "f"']]
    with pytest.raises(ValueError):
        parse_sexp("(a (b)")
    with pytest.raises(ValueError):
        parse_sexp("(a))")


def test_the_parts_of_a_board_leave_out_what_is_no_part():
    parts = footprints_of(BOARD)
    assert [part.ref for part in parts] == ["R1", "C1"]
    r1, c1 = parts
    assert (r1.value, r1.footprint, r1.side, r1.x, r1.y, r1.rotation, r1.pads, r1.smd, r1.dnp) == (
        "10k", "Resistor_SMD:R_0603_1608Metric", "front", 110.0, 80.0, 90.0, 2, True, False,
    )
    assert (c1.side, c1.rotation, c1.dnp) == ("back", 180.0, True)
    (u3,) = footprints_of(BOARD_V5)
    assert (u3.ref, u3.value, u3.x, u3.y, u3.rotation, u3.pads) == ("U3", "LM358 (dual)", 50.8, 30.48, 270.0, 1)


@pytest.mark.skipif(not BOARD_SAMPLE.exists(), reason="needs toolpath/tests/data/board.kicad_pcb")
def test_the_sample_board_has_its_microcontroller():
    parts = footprints_of(BOARD_SAMPLE.read_text(encoding="utf-8"))
    u1 = next(part for part in parts if part.ref == "U1")
    assert u1.value == "STM32G0B0KETx" and (u1.x, u1.y) == (161.455, 106.33)


def test_a_part_is_placed_and_turned_with_the_job(tmp_path):
    path = tmp_path / "board.kicad_pcb"
    path.write_text(BOARD, encoding="utf-8")
    # The gerber frame is KiCad's with y turned over; the design turns it
    # 90 degrees and moves it.
    job = Job(name="b", design=Design(shift=(5.0, -2.0), rotation=90.0, board=True))
    r1 = job_components(job, path)[0]
    # (110, -80) turned 90 degrees is (80, 110), then shifted.
    assert (r1["x"], r1["y"]) == pytest.approx((85.0, 108.0))
    assert r1["rotation"] == pytest.approx(180.0)
    with pytest.raises(ValueError):
        job_components(Job(name="drawing"), path)


@pytest.mark.parametrize("roll, mirror", [(0.0, False), (12.0, True), (-140.0, True), (95.0, False)])
def test_two_moves_give_the_scale_the_roll_and_the_mirror(roll, mirror):
    scale = 0.012

    def seen(dx_mm: float, dy_mm: float) -> tuple[float, float]:
        """Where a spot moved by a head move shows in the picture: the
        model run backwards."""
        radians = math.radians(-roll)
        u = (dx_mm * math.cos(radians) - dy_mm * math.sin(radians)) / scale
        v = (dx_mm * math.sin(radians) + dy_mm * math.cos(radians)) / scale
        return ((-u if mirror else u), -v)

    found = calibrate(seen(1.0, 0.0), seen(0.0, 1.0), 1.0)
    assert found[0] == pytest.approx(scale)
    assert math.cos(math.radians(found[1] - roll)) == pytest.approx(1.0, abs=1e-9)
    assert found[2] is mirror
    back = picture_to_machine(*seen(0.3, -0.7), *found)
    assert back == pytest.approx((0.3, -0.7))
    with pytest.raises(ValueError):
        calibrate((0.0, 0.0), (1.0, 0.0), 1.0)


def test_the_settings_are_checked():
    UpCameraSettings().check()
    for bad in ({"nozzle_spot": "grey"}, {"position": (3000.0, 0.0)}, {"mm_per_px": -1.0}, {"size": "big"}):
        with pytest.raises(ValueError):
            UpCameraSettings(**bad).check()


# --- the routines and the routes ------------------------------------------------


@pytest.fixture
def fake():
    fake = FakeSerial(move_time=0.002)
    fake.settings.update({"cartesian": 1, "h_axis": 1, "z_max": 100, "r_max": 100})
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


class UpStandIn:
    """An up camera fixed to the machine at `where` (the joints that put the
    nozzle over its center), seeing the nozzle, and a part `part` mm off it
    when one is held, through its true scale, roll and mirror."""

    def __init__(self, fake: FakeSerial, where, roll: float, mirror: bool, scale: float = 0.01, part=(0.12, -0.05)) -> None:
        self.fake = fake
        self.where = where
        self.roll = roll
        self.mirror = mirror
        self.scale = scale
        self.part = part
        self.running = True
        self.asked: list[str] = []

    def _pixels(self, dx_mm: float, dy_mm: float) -> tuple[float, float]:
        radians = math.radians(-self.roll)
        u = (dx_mm * math.cos(radians) - dy_mm * math.sin(radians)) / self.scale
        v = (dx_mm * math.sin(radians) + dy_mm * math.cos(radians)) / self.scale
        return ((-u if self.mirror else u), -v)

    def spot(self, radius=None, polarity="dark"):
        self.asked.append(polarity)
        nozzle = (self.fake.joint[0] - self.where[0], self.fake.z - self.where[1])
        if polarity == "bright":
            nozzle = (nozzle[0] + self.part[0], nozzle[1] + self.part[1])
        dx, dy = self._pixels(*nozzle)
        if math.hypot(dx, dy) > 350.0:
            return {"found": False}
        return {"found": True, "dx": dx, "dy": dy, "x": 640 + dx, "y": 360 + dy, "area": 900.0, "major": 160.0, "minor": 80.0, "contrast": 70.0}

    def pose(self):
        return {"state": "none", "width": 1280, "height": 720, "frame": 1, "age_ms": 4, "fps": 15.0, "spots": 0}

    def close(self):
        self.running = False


def wait_routine(client, timeout: float = 20.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        state = client.get("/api/pnp").json()
        routine = state["routine"]
        if routine is not None and routine["state"] != "running":
            return state
        time.sleep(0.02)
    raise AssertionError("the routine did not end")


def test_the_state_settings_and_refusals_without_pcbv(client, fake):
    state = client.get("/api/pnp").json()
    assert state["running"] is False and state["position"] is None and state["routine"] is None
    response = client.put("/api/pnp/settings", json={"device": "/dev/video2", "nozzle_spot": "bright", "height": 1.5})
    assert response.status_code == 200, response.text
    assert response.json()["device"] == "/dev/video2" and response.json()["height"] == 1.5
    assert client.put("/api/pnp/settings", json={"nozzle_spot": "grey"}).status_code == 400
    assert client.put("/api/pnp/settings", json={"clear": ["height"]}).json()["height"] is None
    # Not running: no picture, no routine.
    assert client.get("/api/pnp/frame.jpg").status_code == 404
    assert client.post("/api/pnp/nozzle", json={"step": 1}).status_code == 400
    assert client.post("/api/pnp/abort").status_code == 409


def test_centering_the_nozzle_measures_where_the_camera_is(client, fake):
    where = (42.0, 17.5)
    stand_in = UpStandIn(fake, where, roll=7.0, mirror=True)
    client.backend.pnp.client = stand_in
    assert client.put("/api/settings", json={"host": {"travel": 4}}).status_code == 200
    client.put("/api/pnp/settings", json={"height": 2.0})
    # The operator has jogged the nozzle roughly over the camera.
    fake.joint = [41.4, 0.0]
    fake.z = 17.9
    response = client.post("/api/pnp/nozzle", json={"step": 1.0})
    assert response.status_code == 200, response.text
    state = wait_routine(client)
    assert state["routine"]["state"] == "done", state["routine"]
    assert state["position"] == pytest.approx(list(where), abs=0.02)
    assert state["mm_per_px"] == pytest.approx(0.01, rel=0.01)
    assert state["mirror"] is True
    assert math.cos(math.radians(state["roll"] - 7.0)) == pytest.approx(1.0, abs=1e-4)
    assert state["height"] == pytest.approx(2.0)
    # Up to the travel height first, then down to where the nozzle is sharp.
    lifts = [line for line in fake.received_lines if line.startswith("go H")]
    assert lifts[:2] == ["go H4.0000", "go H2.0000"]
    # A part on the nozzle is looked at against the nozzle's center.
    client.put("/api/pnp/settings", json={"part_spot": "bright"})
    response = client.post("/api/pnp/part")
    assert response.status_code == 200, response.text
    state = wait_routine(client)
    assert state["routine"]["state"] == "done", state["routine"]
    assert (state["part_offset"]["dx"], state["part_offset"]["dy"]) == pytest.approx((0.12, -0.05), abs=0.005)
    assert state["part_offset"]["length"] == pytest.approx(1.6) and state["part_offset"]["width"] == pytest.approx(0.8)


def test_a_nozzle_out_of_the_picture_ends_as_an_error(client, fake):
    client.backend.pnp.client = UpStandIn(fake, (42.0, 17.5), roll=0.0, mirror=True)
    fake.joint = [0.0, 0.0]
    fake.z = 0.0
    assert client.post("/api/pnp/nozzle", json={"step": 1.0}).status_code == 200
    state = wait_routine(client)
    assert state["routine"]["state"] == "error" and "no nozzle in the picture" in state["routine"]["error"]


def test_the_up_camera_needs_an_xy_machine(client, fake):
    fake.settings["cartesian"] = 0
    client.post("/api/command", json={"line": "$cartesian=0"})
    client.backend.pnp.client = UpStandIn(fake, (42.0, 17.5), roll=0.0, mirror=True)
    response = client.post("/api/pnp/nozzle", json={"step": 1.0})
    assert response.status_code == 400 and "X/Y machine" in response.json()["detail"]


def _board_job(client) -> str:
    job = Job(
        name="board",
        source="kicad",
        groups=[Group(label="g", paths=[[(0.0, 0.0), (10.0, 0.0)]])],
        design=Design(shift=(-100.0, 70.0), rotation=0.0, board=True),
    )
    store = client.backend.store
    store.add(job)
    store.keep_board(job.id, BOARD.encode())
    return job.id


def test_the_parts_route_and_a_goto_to_a_part(client, fake):
    job_id = _board_job(client)
    body = client.get(f"/api/jobs/{job_id}/components").json()
    assert body["note"] is None
    r1 = next(part for part in body["components"] if part["ref"] == "R1")
    # (110, -80) moved by (-100, 70).
    assert (r1["x"], r1["y"]) == pytest.approx((10.0, -10.0))
    # The head is at H 3: a travel height above it is risen to first.
    assert client.put("/api/settings", json={"host": {"travel": 5}}).status_code == 200
    response = client.post("/api/pnp/goto", json={"job": job_id, "ref": "R1"})
    assert response.status_code == 200, response.text
    lines = response.json()["lines"]
    assert lines[0].startswith("jogto H5")
    assert "R10" in lines[-1] and "Z-10" in lines[-1]
    assert client.post("/api/pnp/goto", json={"job": job_id, "ref": "R9"}).status_code == 404
    # Corrected by a part the up camera has not looked at: refused.
    assert client.post("/api/pnp/goto", json={"job": job_id, "ref": "R1", "correct": True}).status_code == 400
    client.backend.pnp.part_offset = {"dx": 0.2, "dy": -0.1, "mm": 0.22, "length": 1.6, "width": 0.8}
    deadline = time.monotonic() + 5.0
    while fake.state() != "Idle" and time.monotonic() < deadline:
        time.sleep(0.01)
    response = client.post("/api/pnp/goto", json={"job": job_id, "ref": "R1", "correct": True})
    assert response.status_code == 200, response.text
    assert "R9.8" in response.json()["lines"][-1] and "Z-9.9" in response.json()["lines"][-1]
    # A drawing keeps no board: no parts, and why.
    drawing = Job(name="drawing", groups=[Group(label="g", paths=[[(0.0, 0.0), (1.0, 0.0)]])])
    client.backend.store.add(drawing)
    body = client.get(f"/api/jobs/{drawing.id}/components").json()
    assert body["components"] == [] and "kicad_pcb" in body["note"]
    assert client.get("/api/jobs/nope/components").status_code == 404
