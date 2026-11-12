"""A G-code machine used like the other machines: its machine file, the
port it claims, connected from the top bar, its readout, jog, goto,
position, home, stop and console; and the PNP tab's tools on it: the
nozzle over the up camera, the top camera and the nozzle swapped over a
point, the up camera's place set by hand, the lights and the vacuum, its
file edited a value at a time, the run's steps in words and the boards it
finished, and the shipped LumenPnP file."""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from device_fakes import FakeMarlin
from gcode_rig import URL, connect, gcode_file, rig_backend

from spinny_web.app import _move_device_config, create_app, move_device_profiles
from spinny_web.jobs import Design, Group, Job
from spinny_web.openpnp import goto_lines, parse

REPO = Path(__file__).resolve().parents[3]
LUMEN = REPO / "machines" / "opulo-lumen-rev5.toml"

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
    fake = FakeMarlin(position=(100.0, 50.0, 0.0))
    opened: list[str] = []

    def opener(url: str, baud: int):
        opened.append(url)
        return fake

    backend = rig_backend(tmp_path, {"rig": PROFILE}, opener)
    app = create_app(backend, frontend=tmp_path / "no-dist")
    with TestClient(app) as client:
        client.backend = backend
        client.fake = fake
        client.opened = opened
        yield client


def sent(client, since: int) -> list[str]:
    return client.fake.lines[since:]


def board_job(client) -> str:
    job = Job(name="board", source="kicad", groups=[Group(label="g", paths=[[(0.0, 0.0), (1.0, 0.0)]])], design=Design(shift=(-100.0, -70.0), rotation=0.0, board=True))
    client.backend.store.add(job)
    client.backend.store.keep_board(job.id, BOARD.encode())
    return job.id


# --- the machine file ----------------------------------------------------------------------


def test_the_lumenpnp_file_reads_with_its_safe_height_and_pump_and_valve():
    lumen = parse(LUMEN.read_text(encoding="utf-8"), "opulo-lumen-rev5")
    assert lumen.safe_z == 31.5 and lumen.move == "G1" and lumen.axes == ("X", "Y", "Z", "A")
    assert lumen.pick == ("M106 P1 S180", "M106") and lumen.place == ("M107 P1", "M107")
    assert lumen.light_on == ("M150 P255 R255 U255 B255",) and lumen.park == (42.328, 411.916)
    # Opulo's bottom camera seen by N1, and its top camera's offset from N1.
    assert lumen.camera_position == (61.92, 219.82) and lumen.camera_z == 4.0
    assert lumen.top is not None and lumen.top.offset == (23.544, 65.188)
    assert lumen.vacuum is not None and lumen.vacuum.part_on is None
    assert lumen.vacuum.reading(["echo:i2c-reply: from:109 bytes:1 data:233", "ok"]) == 233.0
    # Its port is the one whose USB names say lumen; its bars say the seesaw.
    assert lumen.match == ("lumen",) and lumen.claims("/dev/ttyACM1", "MARLIN_OPULO_LUMEN_REV5 CDC in FS Mode")
    assert not lumen.claims("/dev/ttyACM0", "spinny laser controller")
    assert [axis["axis"] for axis in lumen.controls["axes"]] == ["r", "z", "h", "a"]
    assert lumen.controls["axes"][2]["buttons"] == ["N1 down", "N1 up"] and lumen.motors_off == "M18"


def test_the_pick_and_place_lines_go_out_whole_in_the_program():
    machine = parse(gcode_file(PROFILE), "rig")
    assert machine.pick == ("M106 P1 S180", "M106")


def test_a_file_value_is_changed_in_place_and_a_missing_table_added(client, tmp_path):
    response = client.patch("/api/machines/rig", json={"path": ["motion", "place_z"], "value": -1.5})
    assert response.status_code == 200, response.text
    assert response.json()["document"]["gcode"]["place_z"] == -1.5
    text = (tmp_path / "machines" / "rig.toml").read_text()
    assert "place_z = -1.5" in text and 'name = "rig"' in text
    # A value the file refuses leaves it as it was.
    assert client.patch("/api/machines/rig", json={"path": ["motion", "pick_tries"], "value": 0}).status_code == 400
    assert "pick_tries" not in (tmp_path / "machines" / "rig.toml").read_text()
    # A table not in the file yet is added.
    assert client.patch("/api/machines/rig", json={"path": ["vacuum", "part_on"], "value": [1.0, 2.0]}).status_code == 200
    assert client.patch("/api/machines/bus-less", json={"path": ["motion", "place_z"], "value": 1}).status_code == 404


def test_a_g_code_machine_is_listed_and_never_written_to_a_board(client):
    listing = client.get("/api/machines").json()
    assert [(entry["id"], entry["controller"], entry["tool"]) for entry in listing["machines"]] == [("rig", "gcode", "nozzle")]
    document = client.get("/api/machines/rig").json()["document"]
    assert document["settings"] == {} and document["gcode"]["safe_z"] == 5.0
    assert [axis["letter"] for axis in document["controls"]["axes"]] == ["X", "Y", "Z", "A"]
    connect(client, "rig")
    refused = client.post("/api/machines/rig/apply")
    assert refused.status_code == 400 and "G-code machine" in refused.json()["detail"]
    # Its file cannot go while it is connected.
    assert client.delete("/api/machines/rig").status_code == 409


# --- the connection -------------------------------------------------------------------------


def test_a_g_code_machine_connects_from_the_top_bar_and_says_what_it_is(client):
    snapshot = connect(client, "rig")
    assert client.opened == [URL]
    assert snapshot["connected"] is True and snapshot["url"] == URL
    assert snapshot["firmware"]["name"] == "Marlin 2.1.2 (Opulo)"
    assert snapshot["profile"]["controller"] == "gcode" and snapshot["profile"]["machine"] == "rig" and snapshot["profile"]["tool"] == "nozzle"
    # The readout's joints: r is X, z is Y, h is Z.
    machine = snapshot["machine"]
    assert machine["state"] == "Idle" and machine["joint"] == {"r": 100.0, "a": 0.0, "z": 50.0, "h": 0.0}
    assert machine["board"] == {"x": 100.0, "y": 50.0}
    assert client.fake.lines[:4] == ["G21", "G90", "M115", "M114"]
    # The settings are the file's controls, none of the firmware's.
    settings = client.get("/api/settings").json()
    assert settings["values"] == {} and settings["machine"] == "rig" and settings["controls_from"] == "rig"
    assert [axis["axis"] for axis in settings["controls"]["axes"]] == ["r", "z", "h", "a"]
    assert client.get("/api/machines").json()["current"] == "rig"
    # The PNP tab places with it.
    placing = client.get("/api/pnp/placing").json()
    assert placing["machine"] == "rig" and placing["connected"] is True and placing["document"]["safe_z"] == 5.0
    # This project's firmware's requests are refused with the reason.
    refused = client.post("/api/laser", json={"power": 10})
    assert refused.status_code == 409 and "G-code machine" in refused.json()["detail"]
    snapshot = client.post("/api/disconnect").json()
    assert snapshot["connected"] is False and client.fake.closed is True


def test_a_port_the_file_claims_connects_as_that_machine(client):
    # The file's own url.
    response = client.post("/api/connect", json={"url": URL})
    assert response.status_code == 200 and response.json()["profile"]["machine"] == "rig"
    client.post("/api/disconnect")
    # A port whose USB names hold the file's word.
    client.backend.machine_store.patch("rig", ["port", "match"], ["lumen"])
    client.backend._port_names = lambda url: "MARLIN_OPULO_LUMEN_REV5 CDC in FS Mode" if url == "/dev/ttyACM5" else ""
    assert client.backend.gcode_claimant("/dev/ttyACM5", client.backend._port_names("/dev/ttyACM5")) == "rig"
    assert client.backend.gcode_claimant("/dev/ttyACM0", "spinny") is None
    response = client.post("/api/connect", json={"url": "/dev/ttyACM5"})
    assert response.json()["profile"]["machine"] == "rig" and client.opened[-1] == "/dev/ttyACM5"
    # Naming a file of this project's firmware is refused.
    client.post("/api/disconnect")
    (client.backend.machine_store.directory / "laser.toml").write_text('name = "laser"\n', encoding="utf-8")
    assert client.post("/api/connect", json={"url": URL, "machine": "laser"}).status_code == 400


def test_the_ports_name_the_machine_that_claims_them(client, monkeypatch):
    class Port:
        def __init__(self, device, product, vid):
            self.device, self.product, self.vid, self.pid = device, product, vid, 1
            self.manufacturer, self.serial_number, self.description = "", "", product

    from serial.tools import list_ports

    monkeypatch.setattr(list_ports, "comports", lambda: [Port("/dev/ttyACM0", "spinny laser", 0x2E8A), Port("/dev/ttyACM1", "MARLIN_OPULO_LUMEN_REV5 CDC in FS Mode", 0x0483)])
    client.backend.machine_store.patch("rig", ["port", "match"], ["lumen"])
    ports = client.get("/api/ports").json()["ports"]
    by_url = {port["url"]: port for port in ports}
    assert by_url["/dev/ttyACM0"]["machine"] is None and by_url["/dev/ttyACM1"]["machine"] == "rig"
    assert by_url["/dev/ttyACM1"]["machine_name"] == "rig"
    # The file's own url, which no port is listed under, comes as an entry of its own.
    assert by_url[URL]["kind"] == "machine" and by_url[URL]["machine"] == "rig"


def test_a_lost_port_shows_disconnected_and_connects_again(client):
    connect(client, "rig")
    client.backend.gcode._lose("the machine went away: gone")
    snapshot = client.get("/api/state").json()
    assert snapshot["connected"] is False and snapshot["profile"]["controller"] == "gcode"
    assert connect(client, "rig")["connected"] is True


# --- moves -------------------------------------------------------------------------------------


def test_a_jog_moves_an_axis_from_where_the_machine_says_it_is(client):
    connect(client, "rig")
    start = len(client.fake.lines)
    snapshot = client.post("/api/jog", json={"kind": "joint", "dr": 1.5}).json()
    assert snapshot["lines"] == ["G0 X101.5 F3000"] and sent(client, start) == ["M114", "G0 X101.5 F3000"]
    assert client.get("/api/state").json()["machine"]["joint"]["r"] == 101.5
    start = len(client.fake.lines)
    client.post("/api/jog", json={"kind": "joint", "dh": -0.5})
    assert sent(client, start) == ["M114", "G0 Z-0.5 F600"]
    # The board pad moves X and Y, at the feed typed.
    start = len(client.fake.lines)
    client.post("/api/jog", json={"kind": "board", "dx": 1, "dy": -2, "feed": 1200})
    assert sent(client, start) == ["M114", "G0 X102.5 Y48 F1200"]
    # A turn needs the axis in the position's answer.
    assert client.post("/api/jog", json={"kind": "joint", "da": 15}).status_code == 502
    client.fake.report_angle = True
    start = len(client.fake.lines)
    client.post("/api/jog", json={"kind": "joint", "da": 15})
    assert sent(client, start) == ["M114", "G0 A15 F3000"]
    assert client.post("/api/jog", json={"kind": "joint", "dz": 0}).status_code == 400


def test_a_goto_rises_only_to_go_across_and_puts_the_height_last(client):
    connect(client, "rig")
    start = len(client.fake.lines)
    client.post("/api/goto", json={"kind": "joint", "r": 30.0, "z": 40.0, "h": -1.0})
    assert sent(client, start) == ["M114", "G0 Z5 F600", "G0 X30 Y40 F3000", "G0 Z-1 F600", "M400", "M114"]
    # Over the same place, only the height moves: no rise first.
    start = len(client.fake.lines)
    client.post("/api/goto", json={"kind": "joint", "r": 30.0, "h": -2.0})
    assert sent(client, start) == ["M114", "G0 Z-2 F600", "M400", "M114"]
    # An axis left out stays where it is.
    start = len(client.fake.lines)
    client.post("/api/goto", json={"kind": "board", "y": 45.0})
    assert sent(client, start) == ["M114", "G0 Z5 F600", "G0 Y45 F3000", "M400", "M114"]
    assert client.get("/api/state").json()["machine"]["joint"] == {"r": 30.0, "a": 0.0, "z": 45.0, "h": 5.0}
    assert client.post("/api/goto", json={"kind": "joint"}).status_code == 400


def test_lines_for_a_goto_skip_a_height_already_reached():
    machine = parse(gcode_file(PROFILE), "rig")
    here = {"x": 0.0, "y": 0.0, "z": 0.0}
    assert goto_lines(machine, here, {"x": 1.0, "z": 5.0}) == ["G0 Z5 F600", "G0 X1 F3000"]
    assert goto_lines(machine, {**here, "z": 5.0}, {"x": 1.0, "y": 0.0}) == ["G0 X1 F3000"]
    assert goto_lines(machine, here, {"rotation": 90.0, "z": -1.0}) == ["G0 A90 F3000", "G0 Z-1 F600"]


def test_a_position_is_declared_homed_and_stopped(client):
    connect(client, "rig")
    start = len(client.fake.lines)
    snapshot = client.post("/api/position", json={"r": 0, "z": 0}).json()
    assert sent(client, start) == ["G92 X0 Y0", "M114"] and snapshot["connected"] is True
    start = len(client.fake.lines)
    client.post("/api/home", json={})
    assert sent(client, start) == ["G28", "M114"] and client.get("/api/pnp/placing").json()["homed"] is True
    start = len(client.fake.lines)
    client.post("/api/realtime", json={"action": "reset"})
    assert sent(client, start) == ["M410"]
    refused = client.post("/api/realtime", json={"action": "hold"})
    assert refused.status_code == 400 and "no hold" in refused.json()["detail"]
    start = len(client.fake.lines)
    client.post("/api/motors", json={"enabled": False})
    assert sent(client, start) == ["M18"] and client.get("/api/state").json()["machine"]["enabled"] is False


def test_the_console_sends_a_line_as_typed(client):
    connect(client, "rig")
    assert client.post("/api/command", json={"line": "M114"}).json()["lines"][-1] == "ok"
    assert client.post("/api/command", json={"line": "BAD"}).status_code == 502
    assert client.post("/api/command", json={"line": "G0\nG28"}).status_code == 400


def test_the_head_is_parked(client):
    connect(client, "rig")
    start = len(client.fake.lines)
    client.post("/api/pnp/park")
    assert sent(client, start) == ["M114", "G0 Z5 F600", "G0 X40 Y400 F3000", "M400", "M114"]
    assert client.get("/api/state").json()["machine"]["board"] == {"x": 40.0, "y": 400.0}


def test_the_nozzle_goes_over_the_up_camera_with_the_lights_on(client):
    connect(client, "rig")
    start = len(client.fake.lines)
    state = client.post("/api/pnp/over-camera").json()
    # The file's place, until a centering measures it; the height last.
    assert sent(client, start) == ["M114", "M150 P255", "G0 Z5 F600", "G0 X60 Y200 A0 F3000", "G0 Z-4 F600", "M400", "M114"]
    assert state["light"] is True and state["camera"]["position"] == [60.0, 200.0] and state["camera"]["measured"] is False


def test_a_jog_leaving_the_up_camera_goes_up_first_when_the_file_asks(tmp_path):
    fake = FakeMarlin(position=(60.0, 200.0, -4.0))
    profile = PROFILE.replace("z = -4\n", "z = -4\nleave = 3\n")
    backend = rig_backend(tmp_path, {"rig": profile}, lambda url, baud: fake)
    with TestClient(create_app(backend, frontend=tmp_path / "no-dist")) as client:
        client.fake = fake
        connect(client, "rig")
        # Small jogs over the lens stay at the height they are at.
        start = len(fake.lines)
        client.post("/api/jog", json={"kind": "joint", "dr": 1.0})
        assert sent(client, start) == ["M114", "G0 X61 F3000"]
        # The jog that takes the nozzle away rises first.
        start = len(fake.lines)
        client.post("/api/jog", json={"kind": "joint", "dr": 5.0})
        assert sent(client, start) == ["M114", "G0 Z5 F600", "G0 X66 F3000"]
        # Away from the lens, jogs go at the height they are at.
        client.post("/api/jog", json={"kind": "joint", "dh": -2.0})
        start = len(fake.lines)
        client.post("/api/jog", json={"kind": "joint", "dr": 5.0})
        assert sent(client, start) == ["M114", "G0 X71 F3000"]


def test_the_big_stop_sends_the_files_stop(client):
    connect(client, "rig")
    start = len(client.fake.lines)
    assert client.post("/api/stop").json()["stopped"] == ["the machine"]
    assert sent(client, start)[0] == "M410"


def test_without_leave_a_jog_never_rises(client):
    connect(client, "rig")
    client.post("/api/goto", json={"kind": "joint", "r": 60.0, "z": 200.0, "h": -4.0})
    start = len(client.fake.lines)
    client.post("/api/jog", json={"kind": "joint", "dr": 20.0})
    assert sent(client, start) == ["M114", "G0 X80 F3000"]


def test_the_camera_and_the_nozzle_swap_over_a_point(client):
    connect(client, "rig")
    start = len(client.fake.lines)
    client.post("/api/pnp/swap", json={"to": "nozzle"})
    # The camera looked at 120, 110: the nozzle goes there.
    assert sent(client, start) == ["M114", "G0 Z5 F600", "G0 X120 Y110 F3000", "M400", "M114"]
    start = len(client.fake.lines)
    client.post("/api/pnp/swap", json={"to": "camera"})
    assert sent(client, start) == ["M114", "G0 X100 Y50 F3000", "M400", "M114"]


def test_the_top_camera_goes_over_a_part_and_takes_a_reference_by_the_designed_offset(client):
    job_id = board_job(client)
    connect(client, "rig")
    client.post("/api/pnp/references", json={"job": job_id, "ref": "R1", "at": [100.0, 50.0]})
    start = len(client.fake.lines)
    assert client.post("/api/pnp/goto", json={"job": job_id, "ref": "R1", "camera": True}).status_code == 200
    assert sent(client, start) == ["G0 Z5 F600", "G0 X80 Y-10 F3000", "M400", "M114"]
    # The camera's crosshair over R2 now: the reference is the nozzle's place for it.
    state = client.post("/api/pnp/references", json={"job": job_id, "ref": "R2", "camera": True}).json()
    assert {"job": job_id, "ref": "R2", "at": [100.0, 50.0], "by": "camera"} in state["references"]


def test_the_up_cameras_place_is_set_by_hand(client):
    connect(client, "rig")
    client.post("/api/goto", json={"kind": "joint", "r": 61.0, "z": 201.0})
    state = client.put("/api/pnp/camera", json={"here": True}).json()
    assert state["camera"]["position"] == [61.0, 201.0] and state["camera"]["measured"] is True
    state = client.put("/api/pnp/camera", json={"position": [62.5, 199.0]}).json()
    assert state["camera"]["position"] == [62.5, 199.0]
    # Forgotten: the file's place is the guess again.
    assert client.put("/api/pnp/camera", json={"clear": True}).json()["camera"]["position"] == [60.0, 200.0]


# --- the lights and the vacuum ----------------------------------------------------------------------


def test_the_lights_and_the_vacuum_switch_and_the_sensor_reads(client):
    connect(client, "rig")
    client.fake.readings = [231.0]
    start = len(client.fake.lines)
    assert client.post("/api/pnp/light", json={"on": False}).json()["light"] is False
    answer = client.post("/api/pnp/vacuum", json={"on": True, "read": True}).json()
    assert sent(client, start) == ["M150 P0", "M106 P1 S180", "M106", "M260 A112 B1 S1", "M105"]
    assert answer["vacuum"] == {"on": True, "reading": 231.0}
    assert client.post("/api/pnp/vacuum", json={}).status_code == 400


# --- a run ------------------------------------------------------------------------------------------


def test_a_run_says_its_steps_in_words_and_counts_the_board(client):
    job_id = board_job(client)
    connect(client, "rig")
    client.post("/api/pnp/references", json={"job": job_id, "ref": "R1", "at": [100.0, 50.0]})
    client.post("/api/pnp/references", json={"job": job_id, "ref": "R2", "at": [110.0, 50.0]})
    assert client.post("/api/pnp/run", json={"job": job_id}).status_code == 200
    deadline = time.monotonic() + 5.0
    while client.get("/api/pnp/placing").json()["running"] and time.monotonic() < deadline:
        time.sleep(0.02)
    state = client.get("/api/pnp/placing").json()
    texts = [(step["ref"], step["text"]) for step in state["progress"]["steps"]]
    assert texts[0] == (None, "placing 2 parts on rig")
    assert ("R1", "picking 10k from res #1") in texts and ("R2", "placed at X 110 Y 50, 90 deg") in texts
    assert texts[-1] == (None, "done: 2 placed") and state["boards"] == 1
    # The pump and its valve both go on and off for every part.
    assert client.fake.lines.count("M106 P1 S180") == 2 and client.fake.lines.count("M107 P1") == 2
    assert client.post("/api/pnp/boards/reset").json()["boards"] == 0


def test_a_part_is_looked_for_within_its_feeders_crop_else_the_files():
    text = PROFILE.replace("[camera]\n", "[camera]\ncrop = 3.0\n").replace('count = 10\n', 'count = 10\nvision = true\n[[feeder]]\nid = "ic"\nmatch = "STM32"\nat = [50.0, 20.0, -2.0]\ncrop = 6.5\nvision = true\n')
    machine = parse(gcode_file(text), "rig")
    assert machine.crop == 3.0 and machine.feeders[1].crop == 6.5 and machine.document()["crop"] == 3.0
    from spinny_web.openpnp import board_fit, plan

    parts = [
        {"ref": "R1", "value": "10k", "footprint": "R_0603", "side": "front", "x": 0.0, "y": 0.0, "rotation": 0.0, "dnp": False},
        {"ref": "U1", "value": "STM32", "footprint": "LQFP", "side": "front", "x": 5.0, "y": 0.0, "rotation": 0.0, "dnp": False},
    ]
    program = plan(machine, parts, board_fit([((0.0, 0.0), (0.0, 0.0))], 0.0), {}, vision_ready=True)
    assert [block.crop for block in program.blocks] == [3.0, 6.5]


def test_a_feeder_that_names_its_parts_holds_them_before_any_words():
    text = PROFILE.replace('count = 10\n', 'count = 10\n[[feeder]]\nid = "named"\nrefs = ["R2"]\nat = [70.0, 20.0, -2.0]\n')
    machine = parse(gcode_file(text), "rig")
    assert machine.feeders[1].refs == ("R2",) and machine.feeders[1].match == ""
    from spinny_web.openpnp import feeder_for

    r1 = {"ref": "R1", "value": "10k", "footprint": "R_0603"}
    r2 = {"ref": "R2", "value": "10k", "footprint": "R_0603"}
    assert feeder_for(machine, r1).id == "res" and feeder_for(machine, r2).id == "named"
    with pytest.raises(Exception, match="match must hold"):
        parse(gcode_file(text.replace('refs = ["R2"]\n', "")), "rig")


# --- what a backend from before kept -------------------------------------------------------------


def test_a_device_profile_from_before_becomes_a_machine_file(tmp_path):
    pnp = tmp_path / "pnp"
    pnp.mkdir()
    (pnp / "rig.toml").write_text(PROFILE, encoding="utf-8")
    (pnp / "broken.toml").write_text("[motion]\nsafe_z = 'x'\n", encoding="utf-8")
    machines = tmp_path / "machines"
    done = move_device_profiles(pnp, machines)
    assert any("rig.toml: written as the G-code machine file" in line for line in done)
    assert any("broken.toml: not moved" in line for line in done)
    assert parse((machines / "rig.toml").read_text(), "rig").camera_position == (60.0, 200.0)
    # Not again over a machine file of that id.
    (machines / "rig.toml").write_text("# mine\n" + gcode_file(PROFILE), encoding="utf-8")
    move_device_profiles(pnp, machines)
    assert (machines / "rig.toml").read_text().startswith("# mine")


def test_what_a_backend_kept_of_its_device_moves_under_the_machine(tmp_path):
    config = {"pnp_device": {"profile": "rig", "url": "/dev/ttyACM1", "references": [{"job": "j", "ref": "R1", "at": [1, 2]}], "taken": {"res": 3}, "top": {"device": "/dev/video4"}}}
    _move_device_config(config)
    assert "pnp_device" not in config and config["placing_machine"] == "rig"
    assert config["placing"]["rig"] == {"references": [{"job": "j", "ref": "R1", "at": [1, 2]}], "taken": {"res": 3}, "top": {"device": "/dev/video4"}}
    json.dumps(config)
