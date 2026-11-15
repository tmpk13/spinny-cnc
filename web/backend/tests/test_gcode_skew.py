"""A G-code machine whose X and Y axes are out of square: its file's
[motion] skew taken out by the backend's link (X less skew times Y on
every move and G92, X plus skew times Y on every place read) or, with
skew_by = "firmware", by the controller told the factor by the file's
[gcode] skew line (Marlin's M852) at the connect and whenever the file
changes it; a firmware that does not know the line refuses the connect.
The virtual LumenPnP's axes lean the same way, so where the head stands
on the bed says whether the skew was taken out."""

from __future__ import annotations

import math
import time
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from device_fakes import FakeMarlin
from gcode_rig import URL, connect, gcode_file, rig_backend
from test_pictures import Head, TexturedCamera

from test_virtual_pnp import send

from spinny_laser.machines import MachineError
from spinny_web import topcam
from spinny_web.app import create_app
from spinny_web.camera import RUNNING
from spinny_web.openpnp import (
    board_fit,
    declare_line,
    goto_lines,
    head_place,
    move_line,
    move_xy,
    parse,
    plan,
    read_position,
    skew_lines,
    unknown_in,
)
from spinny_web.topcam import TopCamera

# A LumenPnP's: its Y travel leans 0.13 degrees toward +X.
SKEW = 0.0023

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
pick_dwell_ms = 0
place_dwell_ms = 0
seesaw = false
skew = 0.0023
[[feeder]]
id = "res"
match = "10k"
at = [10.0, 20.0, -2.0]
pitch = [4.0, 0.0]
count = 10
"""


def profile(skew_by: str = "link", skew: float = SKEW, line: str | None = None) -> str:
    text = PROFILE.replace("skew = 0.0023", f'skew = {skew}\nskew_by = "{skew_by}"')
    if line is not None:
        text = text.replace('init = ["G21", "G90"]', f'init = ["G21", "G90"]\nskew = "{line}"')
    return text


def machine_of(text: str):
    return parse(gcode_file(text), "rig")


@pytest.fixture
def rig(tmp_path):
    """A backend over a skewed virtual LumenPnP, its file's text to choose;
    rig(text, skew_gcode) builds and connects it."""
    clients: list = []

    def build(text: str, skew_gcode: bool = False, machine_skew: float = SKEW):
        fake = FakeMarlin(position=(100.0, 50.0, 5.0), skew=machine_skew, skew_gcode=skew_gcode)
        backend = rig_backend(tmp_path, {"rig": text}, lambda url, baud: fake)
        context = TestClient(create_app(backend, frontend=tmp_path / "no-dist"))
        client = context.__enter__()
        clients.append(context)
        client.backend = backend
        client.fake = fake
        return client

    yield build
    for context in clients:
        context.__exit__(None, None, None)


def sent(client, since: int) -> list[str]:
    return client.fake.lines[since:]


def on_bed(client) -> tuple[float, float]:
    x, y, _ = client.fake.bed_position
    return (x, y)


def joint(client) -> dict:
    return client.get("/api/state").json()["machine"]["joint"]


# --- the machine file -----------------------------------------------------------------------


def test_a_file_reads_square_unless_it_gives_a_skew():
    square = machine_of(PROFILE.replace("skew = 0.0023\n", ""))
    assert (square.skew, square.skew_by, square.skew_line) == (0.0, "link", "M852 I{skew}")
    assert square.document()["skew"] == 0.0 and square.document()["skew_by"] == "link"
    skewed = machine_of(profile("firmware", line="M852 S{skew}"))
    assert (skewed.skew, skewed.skew_by, skewed.skew_line) == (SKEW, "firmware", "M852 S{skew}")
    # A firmware built with its factor: no line to send.
    assert machine_of(profile("firmware", line="")).skew_line == ""


@pytest.mark.parametrize(
    ("text", "said"),
    [
        (profile(skew=0.13), "0.13 degrees is 0.0023"),
        (PROFILE.replace("skew = 0.0023", "skew = true"), "[motion] skew must be a number"),
        (profile("both"), '[motion] skew_by must be "link"'),
        (profile(line="M852 I0.0023"), "[gcode] skew must hold {skew}"),
    ],
)
def test_a_skew_the_file_gets_wrong_is_refused_with_the_key(text, said):
    with pytest.raises(MachineError, match=None) as caught:
        machine_of(text)
    assert said in str(caught.value)


# --- the lines, with the link taking the skew out -------------------------------------------


def test_moves_send_x_less_the_skew_of_y_and_reads_add_it_back():
    machine = machine_of(profile())
    # 200 mm of Y leans 0.46 mm toward +X: the controller is sent 0.46 less.
    assert move_xy(machine, (100.0, 200.0)) == "G0 X99.54 Y200 F3000"
    assert head_place(machine, ["X:99.54 Y:200.00 Z:5.00 E:0.00 Count X:0 Y:0 Z:0", "ok"]) == pytest.approx({"x": 100.0, "y": 200.0, "z": 5.0})
    # An X reported without its Y is no place on skewed axes.
    assert read_position(["X:1.00 Z:2.00", "ok"], machine.axes, SKEW) == {"z": 2.0}
    # A move naming one of X and Y names both, the other where the head is.
    here = {"x": 100.0, "y": 200.0, "z": 5.0}
    assert move_line(machine, {"y": 300.0}, here=here) == "G0 X99.31 Y300 F3000"
    assert goto_lines(machine, here, {"x": 110.0}) == ["G0 X109.54 Y200 F3000"]
    with pytest.raises(ValueError, match="read its place first"):
        move_line(machine, {"x": 1.0})
    # Heights and turns alone are as on square axes.
    assert move_line(machine, {"z": 2.0}) == "G0 Z2 F600" and move_xy(machine, None, 90.0) == "G0 A90 F3000"
    assert declare_line(machine, {"x": 100.0, "y": 200.0, "z": 1.0}) == "G92 X99.54 Y200 Z1"
    with pytest.raises(ValueError, match="together"):
        declare_line(machine, {"x": 100.0})
    # Nothing goes to the firmware.
    assert skew_lines(machine) == []


def test_with_the_firmware_taking_it_out_the_lines_are_square_and_the_program_tells_it():
    machine = machine_of(profile("firmware"))
    assert machine.link_skew == 0.0 and machine.firmware_skew == SKEW
    assert move_xy(machine, (100.0, 200.0)) == "G0 X100 Y200 F3000"
    assert declare_line(machine, {"x": 100.0}) == "G92 X100"
    assert skew_lines(machine) == ["M852 I0.0023"]
    part = {"ref": "R1", "value": "10k", "footprint": "R_0603", "x": 1.0, "y": 2.0, "rotation": 0.0}
    program = plan(machine, [part], board_fit([((1.0, 2.0), (30.0, 40.0))], 0.0), {})
    assert program.head[1:] == ["G21", "G90", "M852 I0.0023"]
    assert unknown_in(['echo:Unknown command: "M852 I0.0023"', "ok"]) == 'echo:Unknown command: "M852 I0.0023"'
    assert unknown_in(["ok"]) is None


# --- the virtual LumenPnP's own skew and M852 ------------------------------------------------


def test_the_virtual_machine_leans_and_a_build_with_m852_takes_it_out():
    stock = FakeMarlin(position=(0.0, 0.0, 0.0), skew=SKEW)
    stock.drain()
    assert send(stock, "G1 X100 Y200 F6000", "M852 I0.0023") == ["ok", 'echo:Unknown command: "M852 I0.0023"', "ok"]
    assert stock.bed_position[:2] == pytest.approx((100.46, 200.0))
    built = FakeMarlin(position=(100.0, 200.0, 0.0), skew=SKEW, skew_gcode=True)
    built.drain()
    # The motors stay: the numbers are made again from them, and said.
    assert send(built, "M852 I0.0023") == ["X:100.46 Y:200.00 Z:0.00 E:0.00 Count X:0 Y:0 Z:0", "ok"]
    assert built.bed_position[:2] == pytest.approx((100.46, 200.0)) and built.position[:2] == pytest.approx((100.46, 200.0))
    assert send(built, "M852") == ["echo:  M852 I0.002300 J0 K0", "ok"]
    send(built, "G1 X100 Y200")
    assert built.bed_position[:2] == pytest.approx((100.0, 200.0))


# --- the backend, end to end -------------------------------------------------------------------


def test_the_link_puts_the_head_where_it_is_sent_on_skewed_axes(rig):
    client = rig(profile())
    snapshot = connect(client, "rig")
    # The place read at the connect is the nozzle's: 50 of Y leans 0.115.
    assert snapshot["machine"]["joint"]["r"] == pytest.approx(100.115) and on_bed(client) == pytest.approx((100.115, 50.0))
    start = len(client.fake.lines)
    client.post("/api/goto", json={"kind": "board", "x": 100.0, "y": 200.0})
    assert "G0 X99.54 Y200 F3000" in sent(client, start)
    assert on_bed(client) == pytest.approx((100.0, 200.0), abs=1e-3)
    assert (joint(client)["r"], joint(client)["z"]) == pytest.approx((100.0, 200.0), abs=0.006)
    # A jog along Y alone moves the controller's X too: the head stays on X 100.
    start = len(client.fake.lines)
    client.post("/api/jog", json={"kind": "joint", "dz": 100.0})
    assert sent(client, start) == ["M114", "G0 X99.31 Y300 F3000"]
    assert on_bed(client) == pytest.approx((100.0, 300.0), abs=1e-3)


def test_declaring_one_of_x_and_y_on_skewed_axes_declares_the_other_where_it_is(rig):
    client = rig(profile())
    connect(client, "rig")
    client.post("/api/goto", json={"kind": "board", "x": 100.0, "y": 200.0})
    start = len(client.fake.lines)
    client.post("/api/position", json={"z": 150.0})
    assert sent(client, start)[-2:] == ["G92 X99.655 Y150", "M114"]
    # The head did not move; its numbers now say Y 150 and still X 100.
    assert (joint(client)["r"], joint(client)["z"]) == pytest.approx((100.0, 150.0), abs=0.006)
    assert on_bed(client) == pytest.approx((100.0, 200.0), abs=1e-3)


def test_the_firmware_is_told_the_skew_at_the_connect_and_the_lines_stay_square(rig):
    client = rig(profile("firmware"), skew_gcode=True)
    connect(client, "rig")
    assert client.fake.lines[:5] == ["G21", "G90", "M115", "M852 I0.0023", "M114"]
    assert client.backend.gcode.skew_told == SKEW
    start = len(client.fake.lines)
    client.post("/api/goto", json={"kind": "board", "x": 100.0, "y": 200.0})
    assert "G0 X100 Y200 F3000" in sent(client, start) and "M852 I0.0023" not in sent(client, start)
    assert on_bed(client) == pytest.approx((100.0, 200.0), abs=1e-3)


def test_a_firmware_that_does_not_know_the_skew_line_is_not_connected(rig):
    client = rig(profile("firmware"), skew_gcode=False)
    response = client.post("/api/connect", json={"url": URL, "machine": "rig"})
    assert response.status_code == 502
    detail = response.json()["detail"]
    assert "does not know it" in detail and 'skew_by = "link"' in detail
    assert client.get("/api/state").json()["connected"] is False and client.fake.closed is True


def test_a_file_written_while_connected_moves_the_skew_between_firmware_and_link(rig):
    client = rig(profile("firmware"), skew_gcode=True)
    connect(client, "rig")
    # Given back to the link: the firmware is told 0 at once, and the
    # link takes it out from the next move on.
    start = len(client.fake.lines)
    assert client.patch("/api/machines/rig", json={"path": ["motion", "skew_by"], "value": "link"}).status_code == 200
    assert sent(client, start) == ["M852 I0"] and client.backend.gcode.skew_told == 0.0
    client.post("/api/goto", json={"kind": "board", "x": 100.0, "y": 200.0})
    assert on_bed(client) == pytest.approx((100.0, 200.0), abs=1e-3)
    # And to the firmware again, with another factor.
    start = len(client.fake.lines)
    client.patch("/api/machines/rig", json={"path": ["motion", "skew_by"], "value": "firmware"})
    client.patch("/api/machines/rig", json={"path": ["motion", "skew"], "value": 0.002})
    assert sent(client, start) == ["M852 I0.0023", "M852 I0.002"]
    client.post("/api/goto", json={"kind": "board", "x": 100.0, "y": 300.0})
    # The machine leans 0.0023, the firmware takes 0.002 out: 0.09 left at Y 300.
    assert on_bed(client) == pytest.approx((100.09, 300.0), abs=1e-3)


def test_a_square_file_sends_no_skew_line(rig):
    client = rig(PROFILE.replace("skew = 0.0023\n", ""))
    connect(client, "rig")
    client.post("/api/goto", json={"kind": "board", "x": 100.0, "y": 200.0})
    assert not [line for line in client.fake.lines if line.startswith("M852")]
    # The virtual machine leans; nothing takes it out.
    assert on_bed(client) == pytest.approx((100.46, 200.0), abs=1e-3)


# --- Measure camera says the skew that squares the axes --------------------------------------


class LeaningHead(Head):
    """A head whose axes lean `lean` beyond what its file (`skew`) takes
    out: sent to X Y it stands at X + lean * Y, which the camera sees."""

    def __init__(self, place, lean: float, skew: float) -> None:
        super().__init__(place)
        self.sent = place
        self.lean = lean
        self.machine = SimpleNamespace(skew=skew)

    def here(self):
        return self.sent

    def go(self, point) -> None:
        self.sent = (float(point[0]), float(point[1]))
        self.place = (self.sent[0] + self.lean * self.sent[1], self.sent[1])
        self.places.append(self.sent)


def test_measure_camera_says_the_file_skew_that_squares_the_axes(monkeypatch):
    monkeypatch.setattr(topcam, "SETTLE_SECONDS", 0.0)
    store: dict = {"top": {"size": "640x360", "roll": 180.0}}
    said = []
    camera = TopCamera(lambda: store, lambda: None, lambda: None, lambda kind, text: said.append((kind, text)))
    # The file takes 0.002 out; the axes lean 0.01 more than that.
    head = LeaningHead((7.0, 7.0), lean=0.01, skew=0.002)
    camera.client = TexturedCamera(head, 0.024, 180.4, False)
    camera.measure_picture(head, 0.0, 31.5, near_roll=180.0)
    deadline = time.monotonic() + 30.0
    while camera.progress.state == RUNNING and time.monotonic() < deadline:
        time.sleep(0.02)
    assert camera.progress.state == "done", (camera.progress.error, said)
    numbers = camera.measured_picture
    assert numbers["skew_deg"] == pytest.approx(-math.degrees(math.atan(0.01)), abs=0.08)
    assert numbers["skew"] == pytest.approx(0.012, abs=0.0015)
    assert f"[motion] skew = {numbers['skew']:.4f} squares them" in said[-1][1]
