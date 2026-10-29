"""A G-code pick and place machine: its profile, the board's fit on it,
the placement program, the link that sends it, and the routes."""

from __future__ import annotations

import queue
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from spinny_web.app import Backend, create_app
from spinny_web.gcode_device import DeviceLinkError, GcodeDevice
from spinny_web.jobs import Design, Group, Job
from spinny_web.openpnp import DeviceError, board_fit, parse, plan, read_position, wrap

REPO = Path(__file__).resolve().parents[3]
SHIPPED = REPO / "pnp" / "openpnp-marlin.toml"

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
    return parse(PROFILE, "test")


def part(ref: str, value: str, footprint: str, x: float, y: float, rotation: float = 0.0, **extra) -> dict:
    return {"ref": ref, "value": value, "footprint": footprint, "side": "front", "x": x, "y": y, "rotation": rotation, "dnp": False, **extra}


# --- the profile -------------------------------------------------------------------


def test_the_shipped_profile_reads():
    shipped = parse(SHIPPED.read_text(encoding="utf-8"), "openpnp-marlin")
    assert shipped.axes == ("X", "Y", "Z", "A") and shipped.wait == "M400" and shipped.pick == "M106"
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
        (('feed = "M600 N1"', 'feed = "M600\\nG28"'), "[feeder 2] feed must be one line of printable ASCII"),
        (("count = 2", "count = 2\nspeed = 3"), "[feeder 1] speed is not a key here"),
        (('at = [30.0, 20.0, -2.5]', 'at = [30.0, 20.0]'), "[feeder 2] at must be 3 numbers"),
    ],
)
def test_a_profile_that_does_not_read_names_the_key(change, words):
    old, new = change
    assert old in PROFILE
    text = PROFILE.replace(old, new, 1)
    if words is None:
        parse(text, "test")
        return
    with pytest.raises(DeviceError) as error:
        parse(text, "test")
    assert words in str(error.value)


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
    with pytest.raises(DeviceError):
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


class FakeMarlin:
    """A port that answers like Marlin: `ok` for every line, a position for
    M114, `echo:busy` for a slow G28, and a refusal followed by `ok` for a
    line that starts with BAD; it records every line it was sent."""

    def __init__(self, position=(12.5, -3.0, 0.0)) -> None:
        self.out: queue.Queue[bytes] = queue.Queue()
        self.lines: list[str] = []
        self.position = position
        self.closed = False
        self.silent = False
        self.out.put(b"start\r\necho: External Reset\r\n")

    def read(self, size: int) -> bytes:
        try:
            return self.out.get(timeout=0.05)
        except queue.Empty:
            return b""

    def write(self, data: bytes) -> int:
        for line in data.decode().splitlines():
            self.lines.append(line)
            if self.silent:
                continue
            if line.startswith("BAD"):
                self.out.put(b"Error:Unknown command\r\nok\r\n")
            elif line == "M114":
                x, y, z = self.position
                self.out.put(f"X:{x:.2f} Y:{y:.2f} Z:{z:.2f} E:0.00 Count X:0 Y:0 Z:0\r\nok\r\n".encode())
            elif line == "G28":
                self.out.put(b"echo:busy: processing\r\n")
                self.out.put(b"ok\r\n")
            else:
                self.out.put(b"ok\r\n")
        return len(data)

    def close(self) -> None:
        self.closed = True


def connected(fake: FakeMarlin) -> GcodeDevice:
    link = GcodeDevice(lambda: None, opener=lambda url, baud: fake)
    link.connect("socket://127.0.0.1:9", 115200, 0, ("G21", "G90"), 2.0)
    return link


def test_a_line_and_its_answer_and_a_refusal_that_does_not_answer_the_next_line():
    fake = FakeMarlin()
    link = connected(fake)
    assert fake.lines == ["G21", "G90"]
    assert link.command("M114", 2.0)[0].startswith("X:12.50")
    with pytest.raises(DeviceLinkError, match="Unknown command"):
        link.command("BAD 1", 2.0)
    # The ok that came after the refusal was taken with it.
    assert link.command("M114", 2.0)[-1] == "ok" and len(link.command("G28", 2.0)) == 2
    # Comments go nowhere; a quiet device times out.
    assert link.command("; just words", 2.0) == []
    fake.silent = True
    with pytest.raises(DeviceLinkError, match="no answer"):
        link.command("G4 P1", 0.3)
    link.disconnect()
    assert fake.closed and not link.connected


def test_a_program_is_sent_a_line_at_a_time_and_counts_the_parts():
    fake = FakeMarlin()
    link = connected(fake)
    fit = board_fit([((0.0, 0.0), (100.0, 50.0))], None)
    program = plan(device(), [part("R1", "10k", "R_0603", 1.0, 2.0), part("C1", "100n", "C_0402", 5.0, 6.0)], fit, {})
    picked = []
    ended = threading.Event()
    link.run(program, 2.0, lambda block: picked.append(block.ref), lambda progress: ended.set())
    assert ended.wait(5.0)
    assert link.progress.state == "done" and link.progress.placed == ["R1", "C1"] and picked == ["R1", "C1"]
    sent = fake.lines[2:]
    assert sent[:2] == ["G21", "G90"] and "M106" in sent and sent[-1] == "G0 Z5"
    assert all(";" not in line for line in sent)
    assert link.progress.sent == link.progress.total == len(sent)


def test_a_stop_ends_the_program_after_the_line_in_flight_and_sends_the_quickstop():
    fake = FakeMarlin()
    link = connected(fake)
    fit = board_fit([((0.0, 0.0), (100.0, 50.0))], None)
    parts = [part(f"R{i}", "10k", "R_0603", float(i), 0.0) for i in range(1, 3)] + [part(f"C{i}", "100n", "C", float(i), 1.0) for i in range(1, 9)]
    program = plan(device(), parts, fit, {})
    gate = threading.Event()
    real = fake.write

    def slow(data: bytes) -> int:
        gate.wait(2.0)
        return real(data)

    fake.write = slow
    ended = threading.Event()
    link.run(program, 2.0, lambda block: None, lambda progress: ended.set())
    time.sleep(0.05)
    fake.write = real
    link.stop("M410")
    gate.set()
    assert ended.wait(5.0)
    assert link.progress.state == "stopped" and "M410" in fake.lines
    assert len(link.progress.placed) < len(program.blocks)


# --- the routes -------------------------------------------------------------------------


@pytest.fixture
def client(tmp_path):
    pnp_dir = tmp_path / "pnp"
    pnp_dir.mkdir()
    (pnp_dir / "test.toml").write_text(PROFILE, encoding="utf-8")
    backend = Backend(root=tmp_path, jobs_dir=tmp_path / "jobs", config_path=tmp_path / "config.json", pnp_dir=pnp_dir)
    fake = FakeMarlin(position=(100.0, 50.0, 0.0))
    backend.pnp_device = GcodeDevice(backend.publish_pnp_device, opener=lambda url, baud: fake)
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


def test_the_profiles_are_listed_read_checked_and_saved(client, tmp_path):
    listing = client.get("/api/pnp/devices").json()
    assert [device["id"] for device in listing["devices"]] == ["test"] and listing["problems"] == []
    assert client.get("/api/pnp/devices/test").json()["document"]["name"] == "test machine"
    checked = client.post("/api/pnp/devices/test/check", json={"text": PROFILE.replace("safe_z = 5", "")}).json()
    assert checked["document"] is None and "safe_z is needed" in checked["problems"][0]
    assert client.put("/api/pnp/devices/test", json={"text": "nope = 1"}).status_code == 400
    assert client.put("/api/pnp/devices/test", json={"text": PROFILE.replace("test machine", "renamed")}).status_code == 200
    assert "renamed" in (tmp_path / "pnp" / "test.toml").read_text()
    assert client.get("/api/pnp/devices/none").status_code == 404


def test_a_board_is_referenced_planned_sent_and_its_feeders_counted(client):
    job_id = board_job(client)
    assert client.post("/api/pnp/device/connect").status_code == 400
    assert client.put("/api/pnp/device", json={"profile": "test"}).json()["profile"] == "test"
    response = client.post("/api/pnp/device/connect")
    assert response.status_code == 200, response.text
    assert response.json()["connected"] is True and client.fake.lines == ["G21", "G90"]
    # No reference yet: nothing can be placed.
    assert "reference" in client.post("/api/pnp/device/plan", json={"job": job_id}).json()["detail"]
    # R1 is where the device's nozzle is (it reports X100 Y50), R2 typed.
    state = client.post("/api/pnp/device/references", json={"job": job_id, "ref": "R1"}).json()
    assert state["references"] == [{"job": job_id, "ref": "R1", "at": [100.0, 50.0]}] and state["position"]["x"] == 100.0
    state = client.post("/api/pnp/device/references", json={"job": job_id, "ref": "R2", "at": [100.0, 60.0]}).json()
    assert len(state["references"]) == 2
    planned = client.post("/api/pnp/device/plan", json={"job": job_id}).json()
    assert [entry["ref"] for entry in planned["parts"]] == ["R1", "R2"] and planned["fit"]["rotation"] == pytest.approx(90.0)
    # R2 is turned 90 on the board and the board 90 on the device; the feeder holds parts at 90.
    assert "G0 X100 Y60 A90 F3000" in planned["text"]
    download = client.get(f"/api/pnp/device/program.gcode?job={job_id}&refs=R2")
    assert download.headers["content-disposition"].startswith("attachment") and "R1" not in download.text and "; R2 10k" in download.text
    # Sent: both parts, and the feeder has given two.
    before = len(client.fake.lines)
    assert client.post("/api/pnp/device/run", json={"job": job_id}).status_code == 200
    deadline = time.monotonic() + 5.0
    while client.get("/api/pnp/device").json()["running"] and time.monotonic() < deadline:
        time.sleep(0.02)
    state = client.get("/api/pnp/device").json()
    assert state["progress"]["state"] == "done" and state["progress"]["placed"] == ["R1", "R2"]
    assert state["taken"] == {"res": 2} and len(client.fake.lines) > before
    # The strip is used up; counted from its first part again, it plans.
    assert client.post("/api/pnp/device/plan", json={"job": job_id}).json()["parts"] == []
    assert client.post("/api/pnp/device/feeders/reset", json={"feeder": "res"}).json()["taken"] == {}
    # Over a part, a home, a raw line, and a refusal.
    lines = len(client.fake.lines)
    assert client.post("/api/pnp/device/goto", json={"job": job_id, "ref": "R2"}).status_code == 200
    assert client.fake.lines[lines:] == ["G0 Z5 F600", "G0 X100 Y60 F3000"]
    assert client.post("/api/pnp/device/home").json()["homed"] is True
    assert client.post("/api/pnp/device/command", json={"line": "M114"}).json()["reply"][-1] == "ok"
    assert client.post("/api/pnp/device/command", json={"line": "BAD"}).status_code == 502
    assert client.post("/api/pnp/device/command", json={"line": "G0\nG28"}).status_code == 400
    assert client.delete(f"/api/pnp/device/references?job={job_id}&ref=R2").json()["references"] == [{"job": job_id, "ref": "R1", "at": [100.0, 50.0]}]
    assert client.post("/api/pnp/device/disconnect").json()["connected"] is False
