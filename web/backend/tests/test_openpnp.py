"""A G-code pick and place machine: its machine file, the board's fit on
it, the placement program, the link that sends it, and the routes."""

from __future__ import annotations

import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from device_fakes import DeviceUpCamera, FakeMarlin, wait_for
from gcode_rig import connect, gcode_file, rig_backend

from spinny_laser.machines import MachineError, check_id
from spinny_web.app import create_app
from spinny_web.gcode_link import GcodeLink, GcodeLinkError, RunContext
from spinny_web.jobs import Design, Group, Job
from spinny_web.machines import MachineStore
from spinny_web.openpnp import VISION_NOTE, PlanError, board_fit, count_code, parse, plan, read_position, wrap

REPO = Path(__file__).resolve().parents[3]
SHIPPED = REPO / "machines" / "openpnp-marlin.toml"

PROFILE = """name = "test machine"
[port]
url = "socket://127.0.0.1:9"
wait_ms = 0
timeout = 2
[gcode]
init = ["G21", "G90"]
end = ["G0 Z5"]
dwell = "G4 S{s}"
[motion]
feed_xy = 3000
feed_z = 600
safe_z = 5
place_z = -1
pick_dwell_ms = 250
place_dwell_ms = 0
[[feeder]]
id = "res"
match = "10k 0603"
at = [10.0, 20.0, -2.0]
pitch = [2.0, 0.5]
count = 2
rotation = 90
[[feeder]]
id = "cap"
match = "100n"
at = [30.0, 20.0, -2.5]
place_z = -0.5
feed = "M600 N1"
"""


def device():
    return parse(gcode_file(PROFILE), "test")


def part(ref: str, value: str, footprint: str, x: float, y: float, rotation: float = 0.0, **extra) -> dict:
    return {"ref": ref, "value": value, "footprint": footprint, "side": "front", "x": x, "y": y, "rotation": rotation, "dnp": False, **extra}


# --- the machine file -------------------------------------------------------------------


def test_the_shipped_file_reads():
    shipped = parse(SHIPPED.read_text(encoding="utf-8"), "openpnp-marlin")
    assert shipped.axes == ("X", "Y", "Z", "A") and shipped.wait == "M400" and shipped.pick == ("M106",)
    assert shipped.feeders and shipped.feeders[0].count == 50


@pytest.mark.parametrize(
    "change, words",
    [
        (("wait_ms = 0", "wait_ms = 0"), None),
        (('url = "socket://127.0.0.1:9"', 'url = "x"\nbaud = 12345'), "[port] baud must be one of"),
        (('dwell = "G4 S{s}"', 'dwell = "G4 P100"'), "[gcode] dwell must hold {ms} or {s}"),
        (('init = ["G21", "G90"]', 'init = ["G21", "G90"]\nrotation = "X"'), "the four axis letters must differ"),
        (('init = ["G21", "G90"]', 'init = ["G21", "G90"]\nz = "F"'), "[gcode] z must be one capital letter, not F"),
        (("safe_z = 5", ""), "[motion] safe_z is needed"),
        (('id = "cap"', 'id = "res"'), "[feeder 2] id 'res' is another feeder's too"),
        (('feed = "M600 N1"', 'feed = "M600\\nG28"'), "[feeder 2] feed must be a line, or a list of lines of printable ASCII"),
        (("count = 2", "count = 2\nspeed = 3"), "[feeder 1] speed is not a key here"),
        (('at = [30.0, 20.0, -2.5]', 'at = [30.0, 20.0]'), "[feeder 2] at must be 3 numbers"),
    ],
)
def test_a_file_that_does_not_read_names_the_key(change, words):
    old, new = change
    assert old in PROFILE
    text = gcode_file(PROFILE.replace(old, new, 1))
    if words is None:
        parse(text, "test")
        return
    with pytest.raises(MachineError) as error:
        parse(text, "test")
    assert words in str(error.value)


def test_a_machine_id_is_the_whole_text():
    # A line break after an id is not part of a file name.
    assert check_id("openpnp-marlin") == "openpnp-marlin"
    with pytest.raises(MachineError):
        check_id("openpnp-marlin\n")


def test_a_file_of_this_projects_firmware_is_no_g_code_machine():
    with pytest.raises(MachineError, match="is not a G-code machine"):
        parse('name = "laser"\n', "laser")
    with pytest.raises(MachineError, match='add controller = "gcode"'):
        parse(PROFILE, "test")


def test_a_position_reads_from_each_firmwares_answer():
    axes = ("X", "Y", "Z", "A")
    assert read_position(["X:10.00 Y:-20.50 Z:5.00 E:0.00 Count X:800 Y:1600 Z:400", "ok"], axes) == {"x": 10.0, "y": -20.5, "z": 5.0}
    assert read_position(["ok C: X:1.0000 Y:2.0000 Z:3.0000 A:45.0000"], axes) == {"x": 1.0, "y": 2.0, "z": 3.0, "rotation": 45.0}
    assert read_position(["ok"], axes) == {}


def test_the_board_lies_on_the_device_by_its_references():
    one = board_fit([((0.0, 0.0), (100.0, 50.0))], 90.0)
    assert one.apply((10.0, 0.0)) == pytest.approx((100.0, 60.0))
    two = board_fit([((0.0, 0.0), (100.0, 50.0)), ((10.0, 0.0), (100.0, 60.0))], None)
    assert two.rotation == pytest.approx(90.0) and two.apply((0.0, 10.0)) == pytest.approx((90.0, 50.0))
    with pytest.raises(PlanError):
        board_fit([], None)
    assert wrap(270.0) == -90.0 and wrap(-180.0) == 180.0 and wrap(180.0) == 180.0


# --- the program ---------------------------------------------------------------------


def test_the_program_picks_from_the_feeders_and_places_on_the_fitted_board():
    fit = board_fit([((0.0, 0.0), (100.0, 50.0))], None)
    parts = [
        part("R1", "10k", "Resistor_SMD:R_0603_1608Metric", 1.0, 2.0, 0.0),
        part("R2", "10k", "Resistor_SMD:R_0603_1608Metric", 3.0, 2.0, 180.0),
        part("C1", "100n", "Capacitor_SMD:C_0402", 5.0, 6.0, 45.0),
        part("U1", "STM32", "Package_QFP:LQFP-32", 0.0, 0.0),
        part("R3", "10k", "Resistor_SMD:R_0603_1608Metric", 4.0, 4.0),
        part("C2", "100n", "Capacitor_SMD:C_0402", 7.0, 7.0, dnp=True),
        part("C3", "100n", "Capacitor_SMD:C_0402", 8.0, 8.0, side="back"),
    ]
    # One part is left in the strip of two: the first 10k takes it.
    program = plan(device(), parts, fit, {"res": 1})
    assert [(block.ref, block.feeder, block.index) for block in program.blocks] == [("R1", "res", 1), ("C1", "cap", 0)]
    assert program.skipped == [
        {"ref": "R2", "reason": "feeder res is empty"},
        {"ref": "U1", "reason": "no feeder holds it"},
        {"ref": "R3", "reason": "feeder res is empty"},
        {"ref": "C2", "reason": "not to be fitted (dnp)"},
        {"ref": "C3", "reason": "on the back"},
    ]
    r1, c1 = program.blocks
    # The second part of the strip, turned from the feeder's 90 to its 0.
    assert r1.lines == [
        "; R1 10k from res #2",
        "G0 Z5 F600",
        "G0 X12 Y20.5 A0 F3000",
        "G0 Z-2 F600",
        "M400",
        "M106",
        "G4 S0.25",
        "G0 Z5 F600",
        "G0 X101 Y52 A-90 F3000",
        "G0 Z-1 F600",
        "M400",
        "M107",
        "G0 Z5 F600",
    ]
    # A feeder told to advance before each pick, a part placed higher.
    assert c1.lines[1] == "M600 N1" and "G0 X105 Y56 A45 F3000" in c1.lines and "G0 Z-0.5 F600" in c1.lines
    text = program.text()
    assert text.startswith("; placement on test machine: 2 parts\nG21\nG90\n") and text.endswith("M400\nG0 Z5\n")
    summary = program.summary()
    # G21 and G90, twelve and thirteen lines of code for the parts, the wait and the end.
    assert summary["lines"] == 2 + 12 + 13 + 2 and summary["fit"]["marks"] == 1
    # Only the parts asked for, and a part the job does not have is named.
    picked = plan(device(), parts, fit, {}, refs=["C1", "Q9"])
    assert [block.ref for block in picked.blocks] == ["C1"] and picked.skipped == [{"ref": "Q9", "reason": "not a part of this job"}]


# --- the link --------------------------------------------------------------------------


def connected(fake: FakeMarlin) -> GcodeLink:
    link = GcodeLink(lambda: None, opener=lambda url, baud: fake)
    link.connect("socket://127.0.0.1:9", 115200, 0, ("G21", "G90"), 2.0)
    return link


def test_a_line_and_its_answer_and_a_refusal_that_does_not_answer_the_next_line():
    fake = FakeMarlin()
    link = connected(fake)
    assert fake.lines == ["G21", "G90"]
    assert link.command("M114", 2.0)[0].startswith("X:12.50")
    with pytest.raises(GcodeLinkError, match="Unknown command"):
        link.command("BAD 1", 2.0)
    # The ok that came after the refusal was taken with it.
    assert link.command("M114", 2.0)[-1] == "ok" and len(link.command("G28", 2.0)) == 2
    # Comments go nowhere; a quiet device times out.
    assert link.command("; just words", 2.0) == []
    fake.silent = True
    with pytest.raises(GcodeLinkError, match="no answer"):
        link.command("G4 P1", 0.3)
    link.disconnect()
    assert fake.closed and not link.connected


def test_a_stop_ends_the_program_after_the_line_in_flight_and_sends_the_quickstop():
    fake = FakeMarlin()
    link = connected(fake)
    fit = board_fit([((0.0, 0.0), (100.0, 50.0))], None)
    parts = [part(f"R{i}", "10k", "R_0603", float(i), 0.0) for i in range(1, 3)] + [part(f"C{i}", "100n", "C", float(i), 1.0) for i in range(1, 9)]
    program = plan(device(), parts, fit, {})

    def job(ctx: RunContext) -> None:
        for block in program.blocks:
            for line in block.lines:
                ctx.send(line)
            ctx.progress.placed.append(block.ref)

    gate = threading.Event()
    inside = threading.Event()
    real = fake.write

    def slow(data: bytes) -> int:
        inside.set()
        gate.wait(2.0)
        return real(data)

    fake.write = slow
    ended = threading.Event()
    link.run_job(job, count_code(program.text().splitlines()), 2.0, lambda progress: ended.set())
    # The first line is on its way when the stop comes.
    assert inside.wait(2.0)
    fake.write = real
    link.stop("M410")
    gate.set()
    assert ended.wait(5.0)
    assert link.progress.state == "stopped" and "M410" in fake.lines
    # That line was answered; nothing went after it.
    assert link.progress.sent == 1 and link.progress.placed == []
    assert [line for line in fake.lines[2:] if line != "M410"] == ["G0 Z5 F600"]


# --- the routes -------------------------------------------------------------------------


@pytest.fixture
def client(tmp_path):
    fake = FakeMarlin(position=(100.0, 50.0, 0.0))
    backend = rig_backend(tmp_path, {"test": PROFILE}, lambda url, baud: fake)
    app = create_app(backend, frontend=tmp_path / "no-dist")
    with TestClient(app) as client:
        client.backend = backend
        client.fake = fake
        yield client


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


def board_job(client) -> str:
    job = Job(name="board", source="kicad", groups=[Group(label="g", paths=[[(0.0, 0.0), (1.0, 0.0)]])], design=Design(shift=(-100.0, -70.0), rotation=0.0, board=True))
    client.backend.store.add(job)
    client.backend.store.keep_board(job.id, BOARD.encode())
    return job.id


def test_the_files_are_listed_read_checked_and_saved(client, tmp_path):
    listing = client.get("/api/machines").json()
    assert [machine["id"] for machine in listing["machines"]] == ["test"] and listing["problems"] == []
    assert client.get("/api/machines/test").json()["document"]["name"] == "test machine"
    checked = client.post("/api/machines/test/check", json={"text": gcode_file(PROFILE.replace("safe_z = 5", ""))}).json()
    assert checked["document"] is None and "safe_z is needed" in checked["problems"][0]
    assert client.put("/api/machines/test", json={"text": 'controller = "gcode"\nnope = 1'}).status_code == 400
    assert client.put("/api/machines/test", json={"text": gcode_file(PROFILE.replace("test machine", "renamed"))}).status_code == 200
    assert "renamed" in (tmp_path / "machines" / "test.toml").read_text()
    assert client.get("/api/machines/none").status_code == 404


def test_a_board_is_referenced_planned_sent_and_its_feeders_counted(client):
    job_id = board_job(client)
    assert connect(client, "test")["connected"] is True and client.fake.lines == ["G21", "G90", "M115", "M114"]
    # No reference yet: nothing can be placed.
    assert "reference" in client.post("/api/pnp/plan", json={"job": job_id}).json()["detail"]
    # R1 is where the machine's nozzle is (it reports X100 Y50), R2 typed.
    state = client.post("/api/pnp/references", json={"job": job_id, "ref": "R1"}).json()
    assert state["references"] == [{"job": job_id, "ref": "R1", "at": [100.0, 50.0], "by": "nozzle"}] and state["position"]["x"] == 100.0
    state = client.post("/api/pnp/references", json={"job": job_id, "ref": "R2", "at": [100.0, 60.0]}).json()
    assert len(state["references"]) == 2
    planned = client.post("/api/pnp/plan", json={"job": job_id}).json()
    assert [entry["ref"] for entry in planned["parts"]] == ["R1", "R2"] and planned["fit"]["rotation"] == pytest.approx(90.0)
    # R2 is turned 90 on the board and the board 90 on the machine; the feeder holds parts at 90.
    assert "G0 X100 Y60 A90 F3000" in planned["text"]
    download = client.get(f"/api/pnp/program.gcode?job={job_id}&refs=R2")
    assert download.headers["content-disposition"].startswith("attachment") and "R1" not in download.text and "; R2 10k" in download.text
    # Sent: both parts, and the feeder has given two.
    before = len(client.fake.lines)
    assert client.post("/api/pnp/run", json={"job": job_id}).status_code == 200
    deadline = time.monotonic() + 5.0
    while client.get("/api/pnp/placing").json()["running"] and time.monotonic() < deadline:
        time.sleep(0.02)
    state = client.get("/api/pnp/placing").json()
    assert state["progress"]["state"] == "done" and state["progress"]["placed"] == ["R1", "R2"]
    assert state["taken"] == {"res": 2} and len(client.fake.lines) > before
    # The strip is used up; counted from its first part again, it plans.
    assert client.post("/api/pnp/plan", json={"job": job_id}).json()["parts"] == []
    assert client.post("/api/pnp/feeders/reset", json={"feeder": "res"}).json()["taken"] == {}
    # Over a part, a home, a raw line, and a refusal.
    lines = len(client.fake.lines)
    assert client.post("/api/pnp/goto", json={"job": job_id, "ref": "R2"}).status_code == 200
    assert client.fake.lines[lines:] == ["G0 Z5 F600", "G0 X100 Y60 F3000", "M400", "M114"]
    client.post("/api/home", json={})
    assert client.get("/api/pnp/placing").json()["homed"] is True
    assert client.post("/api/command", json={"line": "M114"}).json()["lines"][-1] == "ok"
    assert client.post("/api/command", json={"line": "BAD"}).status_code == 502
    assert client.post("/api/command", json={"line": "G0\nG28"}).status_code == 400
    assert client.delete(f"/api/pnp/references?job={job_id}&ref=R2").json()["references"] == [{"job": job_id, "ref": "R1", "at": [100.0, 50.0], "by": "nozzle"}]
    assert client.post("/api/disconnect").json()["connected"] is False


# --- trays, feeders told to advance, and the up camera on the machine ---------------------

TRAY = PROFILE.replace(
    'feed = "M600 N1"',
    'feed = ["M600 N1", "M400"]\n[[feeder]]\nid = "ic"\nmatch = "STM32"\nat = [50.0, 10.0, -3.0]\npitch = [10.0, 0.0]\n'
    "count = 6\ncolumns = 3\nrow_pitch = [0.0, 12.0]\nvision = true\n[camera]\nz = -4",
)


def test_a_tray_is_taken_row_by_row_and_a_feeder_told_to_advance_gets_every_line():
    device = parse(gcode_file(TRAY), "test")
    ic = device.feeders[2]
    assert [ic.place_of(index)[:2] for index in (0, 2, 3, 5)] == [(50.0, 10.0), (70.0, 10.0), (50.0, 22.0), (70.0, 22.0)]
    assert device.feeders[1].feed == ("M600 N1", "M400") and device.camera_z == -4.0
    with pytest.raises(MachineError, match="needs its count"):
        parse(gcode_file(TRAY.replace("count = 6\n", "")), "test")
    with pytest.raises(MachineError, match="row_pitch is for a tray"):
        parse(gcode_file(TRAY.replace("columns = 3\n", "")), "test")
    fit = board_fit([((0.0, 0.0), (100.0, 50.0))], None)
    parts = [part("C1", "100n", "C_0402", 5.0, 6.0), part("U1", "STM32", "LQFP-32", 2.0, 3.0, 90.0)]
    # Without the camera centered, a part its feeder wants looked at is left.
    blind = plan(device, parts, fit, {"ic": 4})
    assert [block.ref for block in blind.blocks] == ["C1"] and "wants the bottom camera" in blind.skipped[0]["reason"]
    seen = plan(device, parts, fit, {"ic": 4}, vision_ready=True)
    c1, u1 = seen.blocks
    assert c1.pick[1:3] == ["M600 N1", "M400"] and not c1.vision
    assert u1.vision and "G0 X60 Y22 A0 F3000" in u1.pick and VISION_NOTE in u1.lines
    assert u1.target == pytest.approx((102.0, 53.0)) and u1.turn == pytest.approx(90.0) and u1.place[0] == "G0 X102 Y53 A90 F3000"
    assert seen.summary()["parts"][1] == {"ref": "U1", "feeder": "ic", "index": 4, "vision": True}


def test_the_up_camera_on_the_device_centers_the_nozzle_and_corrects_each_place(client):
    (client.backend.machine_store.directory / "tray.toml").write_text(gcode_file(TRAY), encoding="utf-8")
    job = Job(
        name="board", source="kicad", groups=[Group(label="g", paths=[[(0.0, 0.0), (1.0, 0.0)]])],
        design=Design(shift=(-100.0, -70.0), rotation=0.0, board=True),
    )
    board = BOARD.replace('"10k"', '"STM32"', 1)
    client.backend.store.add(job)
    client.backend.store.keep_board(job.id, board.encode())
    camera = DeviceUpCamera(client.fake, where=(150.0, 30.0), roll=4.0, mirror=True)
    client.backend.pnp.client = camera
    connect(client, "tray")
    # The nozzle jogged roughly over the camera, then centered.
    client.post("/api/command", json={"line": "G0 X150.6 Y29.7"})
    response = client.post("/api/pnp/nozzle", json={"step": 1.0})
    assert response.status_code == 200, response.text
    wait_for(lambda: client.get("/api/pnp").json()["routine"]["state"] != "running")
    assert client.get("/api/pnp").json()["routine"]["state"] == "done", client.get("/api/pnp").json()["routine"]
    placed = client.get("/api/pnp/placing").json()["camera"]
    assert placed["position"] == pytest.approx([150.0, 30.0], abs=0.02) and placed["mirror"] is True
    assert placed["mm_per_px"] == pytest.approx(0.01, rel=0.01) and placed["height"] == -4.0
    # The routine moved the G-code machine.
    assert client.backend.pnp.target == "gcode"
    # A reference, then a run: U1 (from the tray, looked at) lands where
    # its center does, the offset turned with the nozzle.
    client.post("/api/pnp/references", json={"job": job.id, "ref": "R2", "at": [100.0, 60.0]})
    client.post("/api/pnp/references", json={"job": job.id, "ref": "R1", "at": [100.0, 50.0]})
    # The stand-in shows the part as the bright spot.
    assert client.put("/api/pnp/settings", json={"part_spot": "bright"}).status_code == 200
    # A part to be looked at needs the up camera running.
    camera.running = False
    response = client.post("/api/pnp/run", json={"job": job.id, "refs": ["R1"]})
    assert response.status_code == 400 and "bottom camera is not running" in response.text
    camera.running = True
    lines_before = len(client.fake.lines)
    response = client.post("/api/pnp/run", json={"job": job.id, "refs": ["R1"]})
    assert response.status_code == 200, response.text
    wait_for(lambda: not client.get("/api/pnp/placing").json()["running"])
    state = client.get("/api/pnp/placing").json()
    assert state["progress"]["state"] == "done", state["progress"]
    sent = client.fake.lines[lines_before:]
    # R1 is at (1, 0) in the job, (100, 50) on the device, turned 90 with
    # the board, 0 in the tray: looked at and placed at A90; the part sits
    # (0.12, -0.05) off the nozzle at A0, (0.05, 0.12) once turned.
    assert "G0 A90 F3000" in sent and "G0 X150 Y30 F3000" in sent and "G0 Z-4 F600" in sent
    assert "G0 X99.95 Y49.88 A90 F3000" in sent
    # The look's lines are counted: the run ends with every line it sent.
    assert state["progress"]["sent"] == state["progress"]["total"]
    # Looked at turned to its place's 90, where the offset has turned too.
    seen = client.get("/api/pnp").json()["part_offset"]
    assert (seen["dx"], seen["dy"]) == pytest.approx((0.05, 0.12), abs=0.005)


# --- what the sweep for bugs found -------------------------------------------------------


def test_a_lost_link_can_be_connected_again():
    ports = [FakeMarlin(), FakeMarlin()]
    link = GcodeLink(lambda: None, opener=lambda url, baud: ports.pop(0))
    link.connect("socket://127.0.0.1:9", 115200, 0, (), 2.0)
    first = link._port

    def gone(size: int) -> bytes:
        raise OSError("the cable was pulled")

    first.read = gone
    wait_for(lambda: link.state()["lost"] is not None)
    assert link.state()["connected"] is False
    link.connect("socket://127.0.0.1:9", 115200, 0, (), 2.0)
    assert link.connected and first.closed and link.command("M114", 2.0)[-1] == "ok"


def test_any_axis_letter_reads_from_a_position():
    assert read_position(["X:1.00 Y:2.00 Z:3.00 U:4.50 Count X:0", "ok"], ("X", "Y", "W", "U")) == {"x": 1.0, "y": 2.0, "rotation": 4.5}


def test_a_part_never_seen_on_the_nozzle_is_retried_from_the_next_pockets_then_left_out(client):
    (client.backend.machine_store.directory / "tray.toml").write_text(gcode_file(TRAY), encoding="utf-8")
    job = Job(
        name="board", source="kicad", groups=[Group(label="g", paths=[[(0.0, 0.0), (1.0, 0.0)]])],
        design=Design(shift=(-100.0, -70.0), rotation=0.0, board=True),
    )
    client.backend.store.add(job)
    client.backend.store.keep_board(job.id, BOARD.replace('"10k"', '"STM32"', 1).encode())
    camera = DeviceUpCamera(client.fake, where=(150.0, 30.0), roll=0.0, mirror=True)
    client.backend.pnp.client = camera
    connect(client, "tray")
    client.backend._placing_config()["camera"] = {"position": [150.0, 30.0], "mm_per_px": 0.01, "roll": 0.0, "mirror": True}
    client.post("/api/pnp/references", json={"job": job.id, "ref": "R1", "at": [100.0, 50.0]})
    # The part is nowhere in the picture: each pick happened, no place did;
    # each part went back into its pocket and the next pocket was tried.
    camera.part = (50.0, 50.0)
    client.put("/api/pnp/settings", json={"part_spot": "bright"})
    lines_before = len(client.fake.lines)
    assert client.post("/api/pnp/run", json={"job": job.id, "refs": ["R1"]}).status_code == 200
    wait_for(lambda: not client.get("/api/pnp/placing").json()["running"])
    state = client.get("/api/pnp/placing").json()
    assert state["progress"]["state"] == "done" and state["progress"]["placed"] == []
    assert state["progress"]["failed"] == [{"ref": "R1", "reason": "nothing on the nozzle over the bottom camera"}]
    assert state["taken"] == {"ic": 3}
    sent = client.fake.lines[lines_before:]
    # Picked from the tray's first three places, each let go where it came from.
    assert [line for line in sent if line.startswith("G0 X5") or line.startswith("G0 X6") or line.startswith("G0 X7")] == [
        "G0 X50 Y10 A0 F3000", "G0 X50 Y10 A0 F3000", "G0 X60 Y10 A0 F3000", "G0 X60 Y10 A0 F3000", "G0 X70 Y10 A0 F3000", "G0 X70 Y10 A0 F3000",
    ]
    assert sent.count("M107") == 3


def test_an_abort_of_a_routine_on_the_machine_stops_it_at_once(client):
    (client.backend.machine_store.directory / "tray.toml").write_text(gcode_file(TRAY), encoding="utf-8")
    client.backend.pnp.client = DeviceUpCamera(client.fake, where=(150.0, 30.0), roll=0.0, mirror=True)
    connect(client, "tray")
    client.post("/api/command", json={"line": "G0 X150 Y30"})
    # The machine holds the routine's first wait as a long move would.
    client.fake.hold = threading.Event()
    assert client.post("/api/pnp/nozzle", json={"step": 1.0}).status_code == 200
    wait_for(lambda: "M400" in client.fake.lines)
    assert client.post("/api/pnp/abort").status_code == 200
    # The stop went out while the routine still waited on the machine.
    assert "M410" in client.fake.lines and client.backend.pnp.routine_active
    client.fake.hold.set()
    wait_for(lambda: not client.backend.pnp.routine_active)
    assert client.get("/api/pnp").json()["routine"]["state"] == "stopped"


def test_a_config_save_reads_the_config_again_when_another_thread_changed_it(client, tmp_path, monkeypatch):
    from spinny_web import app as app_module

    real = app_module.json.dumps
    calls = {"n": 0}

    def flaky(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("dictionary changed size during iteration")
        return real(*args, **kwargs)

    monkeypatch.setattr(app_module.json, "dumps", flaky)
    client.backend.config["travel"] = 7.5
    client.backend._save_config()
    monkeypatch.setattr(app_module.json, "dumps", real)
    assert calls["n"] == 2 and '"travel": 7.5' in (tmp_path / "config.json").read_text()


def test_two_saves_of_one_machine_file_at_once_both_succeed(tmp_path):
    store = MachineStore(tmp_path / "machines")
    text = SHIPPED.read_text(encoding="utf-8")
    failures: list[Exception] = []
    for round_ in range(20):
        barrier = threading.Barrier(2)

        def save(name: str) -> None:
            barrier.wait()
            try:
                store.save("rig", text.replace('name = "', f'name = "{name} ', 1))
            except Exception as exc:
                failures.append(exc)

        threads = [threading.Thread(target=save, args=(name,)) for name in (f"A{round_}", f"B{round_}")]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
    assert failures == []
    assert sorted(path.name for path in (tmp_path / "machines").iterdir()) == ["rig.toml"]
