"""Feeders on a bus: Photon's packets, the profile's [bus] and [[slot]],
a feeder advanced before its pick, its slot found by its id, and the
scan and feed routes, against a fake Photon bus behind a fake Marlin."""

from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from device_fakes import FakeMarlin, FakePhotonBus

from spinny_web.app import Backend, create_app
from spinny_web.feederbus import HEADER_FIELDS, BusError, FeederBus, Packet, crc8, decode, slot_place
from spinny_web.gcode_device import GcodeDevice
from spinny_web.jobs import Design, Group, Job
from spinny_web.openpnp import DeviceError, parse, plan, board_fit

C100N = "0102030405060708090A0B0C"
C1U = "AABBCCDDEEFF001122334455"

PROFILE = f"""name = "lumen"
[port]
url = "socket://127.0.0.1:9"
wait_ms = 0
timeout = 2
[gcode]
init = ["G21", "G90"]
[motion]
feed_xy = 3000
feed_z = 600
safe_z = 31.5
place_z = 12
pick_dwell_ms = 0
place_dwell_ms = 0
[bus]
send = "M485 {{packet}}"
reply = "rs485-reply: (?<packet>[0-9A-Fa-f]*)"
poll_ms = 10
[[slot]]
address = 3
at = [100.0, 400.0, 10.0]
rotation = 90
[[slot]]
address = 4
at = [115.0, 400.0, 10.0]
rotation = 90
[[feeder]]
id = "c-100n"
match = "100n"
bus_id = "{C100N}"
slot = 3
offset = [1.0, 0.0, 0.5]
advance = 2
[[feeder]]
id = "c-1u"
match = "1u"
bus_id = "{C1U.lower()}"
"""

BOARD = """(kicad_pcb
\t(footprint "Capacitor_SMD:C_0402_1005Metric"
\t\t(layer "F.Cu")
\t\t(at 101 -70)
\t\t(property "Reference" "C1")
\t\t(property "Value" "100n")
\t\t(attr smd)
\t)
\t(footprint "Capacitor_SMD:C_0402_1005Metric"
\t\t(layer "F.Cu")
\t\t(at 111 -70)
\t\t(property "Reference" "C2")
\t\t(property "Value" "1u")
\t\t(attr smd)
\t)
)
"""


def part(ref: str, value: str, x: float, y: float) -> dict:
    return {"ref": ref, "value": value, "footprint": "C_0402", "side": "front", "x": x, "y": y, "rotation": 0.0, "dnp": False}


# --- packets ---------------------------------------------------------------------------


def test_the_check_is_crc8_with_polynomial_7():
    # CRC-8/SMBUS's check value.
    assert crc8(b"123456789") == 0xF4


def test_a_packet_goes_out_as_hex_and_reads_back_or_not_at_all():
    packet = Packet(to=3, sender=0, number=7, payload=bytes([0x04, 40]))
    text = packet.encode(HEADER_FIELDS)
    assert text[:8] == "03000702" and decode(text, HEADER_FIELDS) == packet
    # A flipped bit, a short payload, and odd hex do not read.
    assert decode(text[:-1] + ("0" if text[-1] != "0" else "1"), HEADER_FIELDS) is None
    assert decode(text[:-2], HEADER_FIELDS) is None
    assert decode("ABC", HEADER_FIELDS) is None


def test_a_feeders_place_is_its_slots_with_the_offset_turned():
    assert slot_place((100.0, 400.0, 10.0), 90.0, (1.0, 0.0, 0.5)) == pytest.approx((100.0, 401.0, 10.5))


# --- the profile -----------------------------------------------------------------------


def test_the_bus_and_its_feeders_read_placed_by_their_slots_or_left_to_the_run():
    device = parse(PROFILE, "lumen")
    assert device.bus is not None and device.bus.reply == "rs485-reply: (?P<packet>[0-9A-Fa-f]*)"
    assert [slot.address for slot in device.slots] == [3, 4]
    c100n, c1u = device.feeders
    assert c100n.bus_id == C100N and c100n.at == pytest.approx((100.0, 401.0, 10.5)) and c100n.rotation == 90.0
    assert c1u.bus_id == C1U and c1u.at is None and c1u.slot is None
    fit = board_fit([((0.0, 0.0), (0.0, 0.0))], 0.0)
    program = plan(device, [part("C1", "100n", 1.0, 0.0), part("C2", "1u", 2.0, 0.0)], fit, {})
    assert [block.ref for block in program.blocks] == ["C1"]
    assert program.skipped == [{"ref": "C2", "reason": "feeder c-1u's slot is not known: scan the feeder bus, or run, which finds it"}]
    assert "; c-100n advances 2 mm on the feeder bus" in program.text().splitlines()


@pytest.mark.parametrize(
    "change, words",
    [
        (("[bus]\n", "[nobus]\n"), "[slot 1] address is a feeder bus's slot: add a [bus] section"),
        (('send = "M485 {packet}"', 'send = "M485"'), "[bus] send must hold {packet}"),
        (("poll_ms = 10", 'header = ["to", "to"]'), "[bus] header must name each of its bytes once"),
        (("slot = 3\n", "slot = 9\n"), "[feeder 1] slot 9 has no [[slot]] with its place"),
        (('advance = 2\n', 'advance = 2\nat = [1.0, 2.0, 3.0]\n'), "[feeder 1] at is not for a feeder on the bus"),
        ((f'bus_id = "{C1U.lower()}"', 'bus_id = "12"'), "[feeder 2] bus_id must be the feeder's id"),
    ],
)
def test_a_bus_that_does_not_read_names_its_key(change, words):
    old, new = change
    assert old in PROFILE
    with pytest.raises(DeviceError) as error:
        parse(PROFILE.replace(old, new, 1), "lumen")
    assert words in str(error.value)


# --- the bus ---------------------------------------------------------------------------


def bus_over(fake: FakePhotonBus) -> FeederBus:
    profile = parse(PROFILE, "lumen").bus
    assert profile is not None
    marlin = FakeMarlin()
    marlin.bus = fake
    sent: list[str] = []

    def send(line: str) -> list[str]:
        sent.append(line)
        return [fake.answer(line[5:]), "ok"]

    bus = FeederBus(profile, send=send, sleep=lambda seconds: None)
    bus.sent = sent  # type: ignore[attr-defined]
    return bus


def test_a_feeder_is_found_initialized_fed_and_waited_for():
    fake = FakePhotonBus({3: C100N, 4: C1U})
    bus = bus_over(fake)
    assert bus.advance(C1U, 20) == 4
    assert fake.fed == [(4, 20)] and fake.ready == {4}
    # Found and initialized once: the next feed goes straight out.
    before = len(bus.sent)  # type: ignore[attr-defined]
    bus.advance(C1U, 20)
    codes = [decode(line[5:], HEADER_FIELDS).payload[0] for line in bus.sent[before:]]  # type: ignore[attr-defined]
    assert codes == [0x04, 0x06, 0x06]
    # A feeder that forgot it was initialized is initialized again.
    fake.ready.clear()
    assert bus.advance(C1U, 20) == 4 and len(fake.fed) == 3
    # Another feeder in the slot the profile names refuses.
    with pytest.raises(BusError, match="is 0102030405060708090A0B0C, not AABBCCDDEEFF001122334455"):
        bus_over(fake).advance(C1U, 20, address=3)
    with pytest.raises(BusError, match="no feeder answered to the id"):
        bus_over(FakePhotonBus({})).advance(C1U, 20)


def test_a_scan_lists_the_feeders_that_answer():
    assert bus_over(FakePhotonBus({3: C100N, 4: C1U})).scan() == [{"address": 3, "id": C100N}, {"address": 4, "id": C1U}]


# --- the routes and a run ------------------------------------------------------------------


@pytest.fixture
def client(tmp_path):
    pnp_dir = tmp_path / "pnp"
    pnp_dir.mkdir()
    (pnp_dir / "lumen.toml").write_text(PROFILE, encoding="utf-8")
    backend = Backend(root=tmp_path, jobs_dir=tmp_path / "jobs", config_path=tmp_path / "config.json", pnp_dir=pnp_dir)
    fake = FakeMarlin(position=(100.0, 50.0, 31.5))
    fake.bus = FakePhotonBus({3: C100N, 4: C1U})
    backend.pnp_device = GcodeDevice(backend.publish_pnp_device, opener=lambda url, baud: fake)
    app = create_app(backend, frontend=tmp_path / "no-dist")
    with TestClient(app) as client:
        client.backend = backend
        client.fake = fake
        yield client


def test_the_bus_is_scanned_a_feeder_fed_and_a_run_advances_each_before_its_pick(client):
    assert client.put("/api/pnp/device", json={"profile": "lumen"}).status_code == 200
    assert client.post("/api/pnp/device/connect").status_code == 200
    scan = client.post("/api/pnp/device/bus/scan").json()["feeders"]
    assert scan == [{"address": 3, "id": C100N, "feeder": "c-100n", "slot": True}, {"address": 4, "id": C1U, "feeder": "c-1u", "slot": True}]
    assert client.post("/api/pnp/device/bus/feed", json={"feeder": "c-100n"}).status_code == 200
    assert client.fake.bus.fed == [(3, 20)]
    assert client.post("/api/pnp/device/bus/feed", json={"feeder": "nope"}).status_code == 404
    job = Job(name="board", source="kicad", groups=[Group(label="g", paths=[[(0.0, 0.0), (1.0, 0.0)]])], design=Design(shift=(-100.0, -70.0), rotation=0.0, board=True))
    client.backend.store.add(job)
    client.backend.store.keep_board(job.id, BOARD.encode())
    client.post("/api/pnp/device/references", json={"job": job.id, "ref": "C1", "at": [200.0, 50.0]})
    client.post("/api/pnp/device/references", json={"job": job.id, "ref": "C2", "at": [210.0, 50.0]})
    # C2's feeder has no slot in the profile: connected, the plan finds it at address 4.
    planned = client.post("/api/pnp/device/plan", json={"job": job.id}).json()
    assert [entry["ref"] for entry in planned["parts"]] == ["C1", "C2"]
    assert client.post("/api/pnp/device/run", json={"job": job.id}).status_code == 200
    deadline = time.monotonic() + 10.0
    while client.get("/api/pnp/device").json()["running"] and time.monotonic() < deadline:
        time.sleep(0.02)
    state = client.get("/api/pnp/device").json()
    assert state["progress"]["state"] == "done", state["progress"]
    assert state["progress"]["placed"] == ["C1", "C2"]
    assert client.fake.bus.fed[-2:] == [(3, 20), (4, 40)]
    steps = [step["text"] for step in state["progress"]["steps"]]
    assert "feeder c-1u advanced 4 mm (address 4)" in steps
    # C2 was picked at slot 4's place: 115, 400 turned, less nothing.
    assert "G0 X115 Y400 A0 F3000" in client.fake.lines
