"""The G-code device's tools around a run: the port picked and asked what
it is, jogs and moves, the nozzle over the up camera, the top camera and
the nozzle swapped over a point, the up camera's place set by hand, the
lights and the vacuum, the profile edited a value at a time, the run's
steps in words and the boards it finished, and the shipped LumenPnP
profile."""

from __future__ import annotations

import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from device_fakes import FakeMarlin

from spinny_web.app import Backend, create_app
from spinny_web.gcode_device import GcodeDevice, identify
from spinny_web.jobs import Design, Group, Job
from spinny_web.openpnp import parse

REPO = Path(__file__).resolve().parents[3]
LUMEN = REPO / "pnp" / "opulo-lumen-rev5.toml"

PROFILE = """name = "rig"
[port]
url = "socket://127.0.0.1:9"
wait_ms = 0
timeout = 2
[gcode]
init = ["G21", "G90"]
pick = ["M106 P1 S180", "M106"]
place = ["M107 P1", "M107"]
light_on = "M150 P255"
light_off = "M150 P0"
[motion]
feed_xy = 3000
feed_z = 600
safe_z = 5
place_z = -1
pick_dwell_ms = 0
place_dwell_ms = 0
park = [40.0, 400.0]
[vacuum]
read = ["M260 A112 B1 S1", "M105"]
[camera]
position = [60.0, 200.0]
z = -4
[top_camera]
offset = [20.0, 60.0]
[[feeder]]
id = "res"
match = "10k"
at = [10.0, 20.0, -2.0]
pitch = [4.0, 0.0]
count = 10
"""

BOARD = """(kicad_pcb
\t(footprint "Resistor_SMD:R_0603_1608Metric"
\t\t(layer "F.Cu")
\t\t(at 101 -70)
\t\t(property "Reference" "R1")
\t\t(property "Value" "10k")
\t\t(attr smd)
\t)
\t(footprint "Resistor_SMD:R_0603_1608Metric"
\t\t(layer "F.Cu")
\t\t(at 111 -70 90)
\t\t(property "Reference" "R2")
\t\t(property "Value" "10k")
\t\t(attr smd)
\t)
)
"""


@pytest.fixture
def client(tmp_path):
    pnp_dir = tmp_path / "pnp"
    pnp_dir.mkdir()
    (pnp_dir / "rig.toml").write_text(PROFILE, encoding="utf-8")
    backend = Backend(root=tmp_path, jobs_dir=tmp_path / "jobs", config_path=tmp_path / "config.json", pnp_dir=pnp_dir)
    fake = FakeMarlin(position=(100.0, 50.0, 0.0))
    opened: list[str] = []

    def opener(url: str, baud: int):
        opened.append(url)
        return fake

    backend.pnp_device = GcodeDevice(backend.publish_pnp_device, opener=opener)
    app = create_app(backend, frontend=tmp_path / "no-dist")
    with TestClient(app) as client:
        client.backend = backend
        client.fake = fake
        client.opened = opened
        yield client


def connected(client) -> None:
    assert client.put("/api/pnp/device", json={"profile": "rig"}).status_code == 200
    response = client.post("/api/pnp/device/connect")
    assert response.status_code == 200, response.text


def sent(client, since: int) -> list[str]:
    return client.fake.lines[since:]


def board_job(client) -> str:
    job = Job(name="board", source="kicad", groups=[Group(label="g", paths=[[(0.0, 0.0), (1.0, 0.0)]])], design=Design(shift=(-100.0, -70.0), rotation=0.0, board=True))
    client.backend.store.add(job)
    client.backend.store.keep_board(job.id, BOARD.encode())
    return job.id


# --- the profile -------------------------------------------------------------------------


def test_the_lumenpnp_profile_reads_with_its_safe_height_and_pump_and_valve():
    lumen = parse(LUMEN.read_text(encoding="utf-8"), "opulo-lumen-rev5")
    assert lumen.safe_z == 31.5 and lumen.move == "G1" and lumen.axes == ("X", "Y", "Z", "A")
    assert lumen.pick == ("M106 P1 S180", "M106") and lumen.place == ("M107 P1", "M107")
    assert lumen.light_on == ("M150 P255 R255 U255 B255",) and lumen.park == (42.328, 411.916)
    # Opulo's bottom camera seen by N1, and its top camera's offset from N1.
    assert lumen.camera_position == (61.92, 219.82) and lumen.camera_z == 4.0
    assert lumen.top is not None and lumen.top.offset == (23.544, 65.188)
    assert lumen.vacuum is not None and lumen.vacuum.part_on is None
    assert lumen.vacuum.reading(["echo:i2c-reply: from:109 bytes:1 data:233", "ok"]) == 233.0


def test_the_pick_and_place_lines_go_out_whole_in_the_program():
    device = parse(PROFILE, "rig")
    assert device.pick == ("M106 P1 S180", "M106")


def test_a_profile_value_is_changed_in_place_and_a_missing_table_added(client, tmp_path):
    response = client.patch("/api/pnp/devices/rig", json={"path": ["motion", "place_z"], "value": -1.5})
    assert response.status_code == 200, response.text
    assert response.json()["document"]["place_z"] == -1.5
    text = (tmp_path / "pnp" / "rig.toml").read_text()
    assert "place_z = -1.5" in text and 'name = "rig"' in text
    # A value the profile refuses leaves the file as it was.
    assert client.patch("/api/pnp/devices/rig", json={"path": ["motion", "pick_tries"], "value": 0}).status_code == 400
    assert "pick_tries" not in (tmp_path / "pnp" / "rig.toml").read_text()
    # New from the template, and removed.
    made = client.post("/api/pnp/devices/second")
    assert made.status_code == 200, made.text
    assert client.post("/api/pnp/devices/second").status_code == 400
    assert [entry["id"] for entry in client.delete("/api/pnp/devices/second").json()["devices"]] == ["rig"]
    assert client.delete("/api/pnp/devices/second").status_code == 404


# --- the port --------------------------------------------------------------------------------


def test_a_port_picked_in_the_panel_wins_over_the_profiles(client):
    state = client.put("/api/pnp/device", json={"profile": "rig", "url": "/dev/ttyACM7"}).json()
    assert state["port"] == "/dev/ttyACM7"
    assert client.post("/api/pnp/device/connect").status_code == 200
    assert client.opened == ["/dev/ttyACM7"]
    # Not while connected; and not to a url pyserial would read as something else.
    assert client.put("/api/pnp/device", json={"url": "/dev/ttyACM8"}).status_code == 409
    client.post("/api/pnp/device/disconnect")
    assert client.put("/api/pnp/device", json={"url": "spy:///tmp/x"}).status_code == 400
    assert client.put("/api/pnp/device", json={"url": ""}).json()["port"] is None


def test_a_port_is_asked_what_firmware_it_runs(client):
    answer = client.post("/api/pnp/device/identify", json={"url": "/dev/ttyACM3"}).json()
    assert answer["firmware"] == "Marlin 2.1.2 (Opulo)" and answer["machine"] == "LumenPnP"
    assert client.opened == ["/dev/ttyACM3"] and client.fake.closed is True
    assert identify("/dev/ttyACM3", 115200, opener=lambda url, baud: FakeMarlin())["lines"][-1] == "ok"


# --- moves -------------------------------------------------------------------------------------


def test_a_jog_moves_one_axis_from_where_the_device_says_it_is(client):
    connected(client)
    start = len(client.fake.lines)
    state = client.post("/api/pnp/device/jog", json={"axis": "x", "step": 1.5}).json()
    assert sent(client, start) == ["M114", "G0 X101.5 Y50 F3000"] and state["position"]["x"] == 101.5
    start = len(client.fake.lines)
    client.post("/api/pnp/device/jog", json={"axis": "z", "step": -0.5})
    assert sent(client, start) == ["M114", "G0 Z-0.5 F600"]
    # A rotation needs the axis in the position's answer.
    assert client.post("/api/pnp/device/jog", json={"axis": "rotation", "step": 15}).status_code == 502
    client.fake.report_angle = True
    start = len(client.fake.lines)
    client.post("/api/pnp/device/jog", json={"axis": "rotation", "step": 15})
    assert sent(client, start) == ["M114", "G0 A15 F3000"]
    assert client.post("/api/pnp/device/jog", json={"axis": "y", "step": 0}).status_code == 400


def test_a_move_goes_across_at_the_safe_height_and_parks(client):
    connected(client)
    start = len(client.fake.lines)
    client.post("/api/pnp/device/move", json={"x": 30.0, "y": 40.0, "z": -1.0})
    assert sent(client, start) == ["G0 Z5 F600", "G0 X30 Y40 F3000", "G0 Z-1 F600"]
    start = len(client.fake.lines)
    client.post("/api/pnp/device/move", json={"y": 45.0})
    assert sent(client, start) == ["M114", "G0 Z5 F600", "G0 X30 Y45 F3000"]
    start = len(client.fake.lines)
    state = client.post("/api/pnp/device/park").json()
    assert sent(client, start) == ["G0 Z5 F600", "G0 X40 Y400 F3000"] and state["position"]["y"] == 400.0


def test_the_nozzle_goes_over_the_up_camera_with_the_lights_on(client):
    connected(client)
    start = len(client.fake.lines)
    state = client.post("/api/pnp/device/over-camera").json()
    # The profile's place, until a centering measures it.
    assert sent(client, start) == ["M150 P255", "G0 Z5 F600", "G0 X60 Y200 A0 F3000", "G0 Z-4 F600"]
    assert state["light"] is True and state["camera"]["position"] == [60.0, 200.0] and state["camera"]["measured"] is False


def test_the_camera_and_the_nozzle_swap_over_a_point(client):
    connected(client)
    start = len(client.fake.lines)
    client.post("/api/pnp/device/swap", json={"to": "nozzle"})
    # The camera looked at 120, 110: the nozzle goes there.
    assert sent(client, start) == ["M114", "G0 Z5 F600", "G0 X120 Y110 F3000"]
    start = len(client.fake.lines)
    client.post("/api/pnp/device/swap", json={"to": "camera"})
    assert sent(client, start) == ["M114", "G0 Z5 F600", "G0 X100 Y50 F3000"]


def test_the_top_camera_goes_over_a_part_and_takes_a_reference_by_the_designed_offset(client):
    job_id = board_job(client)
    connected(client)
    client.post("/api/pnp/device/references", json={"job": job_id, "ref": "R1", "at": [100.0, 50.0]})
    start = len(client.fake.lines)
    assert client.post("/api/pnp/device/goto", json={"job": job_id, "ref": "R1", "camera": True}).status_code == 200
    assert sent(client, start) == ["G0 Z5 F600", "G0 X80 Y-10 F3000"]
    # The camera's crosshair over R2 now: the reference is the nozzle's place for it.
    state = client.post("/api/pnp/device/references", json={"job": job_id, "ref": "R2", "camera": True}).json()
    assert {"job": job_id, "ref": "R2", "at": [100.0, 50.0], "by": "camera"} in state["references"]


def test_the_up_cameras_place_is_set_by_hand(client):
    connected(client)
    client.post("/api/pnp/device/move", json={"x": 61.0, "y": 201.0})
    state = client.put("/api/pnp/device/camera", json={"here": True}).json()
    assert state["camera"]["position"] == [61.0, 201.0] and state["camera"]["measured"] is True
    state = client.put("/api/pnp/device/camera", json={"position": [62.5, 199.0]}).json()
    assert state["camera"]["position"] == [62.5, 199.0]
    # Forgotten: the profile's place is the guess again.
    assert client.put("/api/pnp/device/camera", json={"clear": True}).json()["camera"]["position"] == [60.0, 200.0]


# --- the lights and the vacuum ----------------------------------------------------------------------


def test_the_lights_and_the_vacuum_switch_and_the_sensor_reads(client):
    connected(client)
    client.fake.readings = [231.0]
    start = len(client.fake.lines)
    assert client.post("/api/pnp/device/light", json={"on": False}).json()["light"] is False
    answer = client.post("/api/pnp/device/vacuum", json={"on": True, "read": True}).json()
    assert sent(client, start) == ["M150 P0", "M106 P1 S180", "M106", "M260 A112 B1 S1", "M105"]
    assert answer["vacuum"] == {"on": True, "reading": 231.0}
    assert client.post("/api/pnp/device/vacuum", json={}).status_code == 400


# --- a run ------------------------------------------------------------------------------------------


def test_a_run_says_its_steps_in_words_and_counts_the_board(client):
    job_id = board_job(client)
    connected(client)
    client.post("/api/pnp/device/references", json={"job": job_id, "ref": "R1", "at": [100.0, 50.0]})
    client.post("/api/pnp/device/references", json={"job": job_id, "ref": "R2", "at": [110.0, 50.0]})
    assert client.post("/api/pnp/device/run", json={"job": job_id}).status_code == 200
    deadline = time.monotonic() + 5.0
    while client.get("/api/pnp/device").json()["running"] and time.monotonic() < deadline:
        time.sleep(0.02)
    state = client.get("/api/pnp/device").json()
    texts = [(step["ref"], step["text"]) for step in state["progress"]["steps"]]
    assert texts[0] == (None, "placing 2 parts on rig")
    assert ("R1", "picking 10k from res #1") in texts and ("R2", "placed at X 110 Y 50, 90 deg") in texts
    assert texts[-1] == (None, "done: 2 placed") and state["boards"] == 1
    # The pump and its valve both go on and off for every part.
    assert client.fake.lines.count("M106 P1 S180") == 2 and client.fake.lines.count("M107 P1") == 2
    assert client.post("/api/pnp/device/boards/reset").json()["boards"] == 0


def test_a_part_is_looked_for_within_its_feeders_crop_else_the_profiles():
    text = PROFILE.replace("[camera]\n", "[camera]\ncrop = 3.0\n").replace('count = 10\n', 'count = 10\nvision = true\n[[feeder]]\nid = "ic"\nmatch = "STM32"\nat = [50.0, 20.0, -2.0]\ncrop = 6.5\nvision = true\n')
    device = parse(text, "rig")
    assert device.crop == 3.0 and device.feeders[1].crop == 6.5 and device.document()["crop"] == 3.0
    from spinny_web.openpnp import board_fit, plan

    parts = [
        {"ref": "R1", "value": "10k", "footprint": "R_0603", "side": "front", "x": 0.0, "y": 0.0, "rotation": 0.0, "dnp": False},
        {"ref": "U1", "value": "STM32", "footprint": "LQFP", "side": "front", "x": 5.0, "y": 0.0, "rotation": 0.0, "dnp": False},
    ]
    program = plan(device, parts, board_fit([((0.0, 0.0), (0.0, 0.0))], 0.0), {}, vision_ready=True)
    assert [block.crop for block in program.blocks] == [3.0, 6.5]
