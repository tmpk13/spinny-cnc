"""Feeders on a bus: Photon's packets, the machine file's [bus] and [[slot]],
a feeder advanced before its pick, its slot found by its id, and the
scan and feed routes, against a fake Photon bus behind a fake Marlin."""

from __future__ import annotations

import re
import time

import pytest
from fastapi.testclient import TestClient

from device_fakes import FakeMarlin, FakePhotonBus
from gcode_rig import connect, gcode_file, rig_backend

from spinny_web import feederbus

from spinny_laser.machines import MachineError
from spinny_web.app import create_app
from spinny_web.feederbus import HEADER_FIELDS, BusError, Collision, FeederBus, NoAddress, Packet, crc8, decode, slot_place
from spinny_web.jobs import Design, Group, Job
from spinny_web.openpnp import board_fit, plan
from spinny_web.openpnp import parse as parse_file


def parse(text: str, machine_id: str):
    """A profile as the tests write it, read as the G-code machine file it makes."""
    return parse_file(gcode_file(text), machine_id)

C100N = "0102030405060708090A0B0C"
C1U = "AABBCCDDEEFF001122334455"
# A feeder just put in a slot whose floor was never programmed.
NEW = "5350494E4E59000000000101"

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
    assert (device.bus.identify, device.bus.program_floor, device.bus.unready, device.bus.fail) == (0xC1, 0xC2, 0xC3, 0x05)
    fit = board_fit([((0.0, 0.0), (0.0, 0.0))], 0.0)
    program = plan(device, [part("C1", "100n", 1.0, 0.0), part("C2", "1u", 2.0, 0.0)], fit, {})
    assert [block.ref for block in program.blocks] == ["C1"]
    assert program.skipped == [{"ref": "C2", "reason": "feeder c-1u's slot is not known: scan the feeder bus, or run, which finds it"}]
    assert "; c-100n advances 2 mm on the feeder bus" in program.text().splitlines()


@pytest.mark.parametrize(
    "change, words",
    [
        (('[bus]\nsend = "M485 {packet}"\nreply = "rs485-reply: (?<packet>[0-9A-Fa-f]*)"\npoll_ms = 10\n', ""), "[slot 1] address is a feeder bus's slot: add a [bus] table"),
        (('send = "M485 {packet}"', 'send = "M485"'), "[bus] send must hold {packet}"),
        (("poll_ms = 10", 'header = ["to", "to"]'), "[bus] header must name each of its bytes once"),
        (("slot = 3\n", "slot = 9\n"), "[feeder 1] slot 9 has no [[slot]] with its place"),
        (('advance = 2\n', 'advance = 2\nat = [1.0, 2.0, 3.0]\n'), "[feeder 1] at is not for a feeder on the bus"),
        ((f'bus_id = "{C1U.lower()}"', 'bus_id = "12"'), "[feeder 2] bus_id must be the feeder's id"),
        (("poll_ms = 10", "poll_ms = 10\nidentify = 300"), "[bus] identify must be a whole number from 0 to 255"),
    ],
)
def test_a_bus_that_does_not_read_names_its_key(change, words):
    old, new = change
    assert old in PROFILE
    with pytest.raises(MachineError) as error:
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
    fake.forget()
    assert bus.advance(C1U, 20) == 4 and len(fake.fed) == 3
    # Another feeder in the slot the profile names refuses.
    with pytest.raises(BusError, match="is 0102030405060708090A0B0C, not AABBCCDDEEFF001122334455"):
        bus_over(fake).advance(C1U, 20, address=3)
    with pytest.raises(BusError, match="no feeder answered to the id"):
        bus_over(FakePhotonBus({})).advance(C1U, 20)


def test_a_scan_lists_the_feeders_that_answer():
    assert bus_over(FakePhotonBus({3: C100N, 4: C1U})).scan() == [{"address": 3, "id": C100N}, {"address": 4, "id": C1U}]


@pytest.mark.parametrize(
    "fake, words",
    [
        (FakePhotonBus({}, unaddressed=[C1U]), "it has no address (it answers from 0, the host's): its slot's floor is not programmed"),
        (FakePhotonBus({}, chipless=[C1U]), "it has no address (it answers from 255, the broadcast every feeder hears): its slot has no floor chip"),
        (FakePhotonBus({40: C1U}), "it answers from address 40, past [bus] max_address 32"),
    ],
)
def test_a_feeder_answering_from_an_address_no_slot_has_has_none_and_is_never_fed(fake, words):
    bus = bus_over(fake)
    with pytest.raises(NoAddress, match=re.escape(words)) as error:
        bus.find(C1U)
    assert error.value.address in (0, 255, 40) and bus.found == {}
    # A feed by its id stops at the find: nothing but the find goes out,
    # and that to the broadcast with the id, as finds do.
    before = len(bus.sent)  # type: ignore[attr-defined]
    with pytest.raises(NoAddress):
        bus.advance(C1U, 20)
    asked = [decode(line[5:], HEADER_FIELDS) for line in bus.sent[before:]]  # type: ignore[attr-defined]
    assert [(packet.to, packet.payload[0]) for packet in asked] == [(255, 0xC0)] and fake.fed == []


def test_identify_flashes_the_feeder_with_the_id_and_waits_until_it_listens_again():
    now = [0.0]
    fake = FakePhotonBus({3: C100N}, unaddressed=[C1U], clock=lambda: now[0])
    bus = bus_over(fake)
    slept: list[float] = []

    def sleep(seconds: float) -> None:
        slept.append(seconds)
        now[0] += seconds

    bus.sleep = sleep
    # As the plan's table has it: to the broadcast, 0xC1 and the id, answered
    # ok from the feeder's address, none included.
    assert bus.identify(C1U) == 0 and fake.identified == [C1U]
    (packet,) = [decode(line[5:], HEADER_FIELDS) for line in bus.sent]  # type: ignore[attr-defined]
    assert (packet.to, packet.payload) == (255, bytes([0xC1]) + bytes.fromhex(C1U))
    # It returns once the feeder listens again.
    assert slept == [2.0] and bus.identify(C100N) == 3 and bus.feeder_at(3) == C100N
    # Without the wait the feeder, still flashing, answers nothing.
    bus.sleep = lambda seconds: None
    assert bus.identify(C100N) == 3 and bus.feeder_at(3) is None
    now[0] += 1.8
    assert bus.feeder_at(3) == C100N
    # A feeder not on the bus: no answer, and no wait.
    slept.clear()
    bus.sleep = sleep
    assert bus.identify("00112233445566778899AABB") is None and slept == []


def test_a_slots_floor_is_programmed_and_the_feeder_answers_from_its_new_address():
    fake = FakePhotonBus({3: C100N}, unaddressed=[C1U])
    bus = bus_over(fake)
    bus.program(C1U, 5)
    first = decode(bus.sent[0][5:], HEADER_FIELDS)  # type: ignore[attr-defined]
    # As the plan's table has it: to the broadcast, 0xC2, the id, the address.
    assert (first.to, first.payload) == (255, bytes([0xC2]) + bytes.fromhex(C1U) + bytes([5]))
    (photon,) = [feeder for feeder in fake.feeders if feeder.id == C1U]
    # Initialized there and asked its id, to confirm.
    assert photon.floor == 5 and photon.initialized and bus.found[C1U] == 5 and 5 in bus.ready
    # A feeder with an address is given another: it no longer answers at the old one.
    bus.program(C100N, 7)
    assert bus.feeder_at(7) == C100N and bus.feeder_at(3) is None and bus.found[C100N] == 7


def test_a_floor_with_no_chip_fails_the_write_from_the_old_address():
    fake = FakePhotonBus({}, chipless=[C1U])
    with pytest.raises(BusError, match="the slot's floor did not take the address: no floor chip, or the write did not read back"):
        bus_over(fake).program(C1U, 5)
    packet = Packet(to=255, sender=0, number=9, payload=bytes([0xC2]) + bytes.fromhex(C1U) + bytes([5])).encode(HEADER_FIELDS)
    answer = decode(fake.answer(packet).split(":", 1)[1].strip(), HEADER_FIELDS)
    assert answer is not None and (answer.sender, answer.payload) == (255, bytes([0x05])) and fake.feeders[0].floor is None


@pytest.mark.parametrize("address", [0, 255, 33])
def test_a_floor_is_never_given_an_address_no_slot_has(address):
    bus = bus_over(FakePhotonBus({}, unaddressed=[C1U]))
    with pytest.raises(ValueError, match="a slot's address is 1 to"):
        bus.program(C1U, address)
    assert bus.sent == []  # type: ignore[attr-defined]


def test_the_feeder_not_initialized_answers_alone_only_once_the_others_are():
    fake = FakePhotonBus({3: C100N, 4: C1U}, unaddressed=[NEW])
    bus = bus_over(fake)
    # Asked first, the three answer at once and garble each other: Marlin's
    # M485 drops what does not check, so it reads as no answer.
    assert bus.unready() is None
    for entry in bus.scan():
        bus.initialize(entry["address"], entry["id"])
    assert bus.unready() == NEW
    (packet, *_) = [decode(line[5:], HEADER_FIELDS) for line in bus.sent]  # type: ignore[attr-defined]
    assert (packet.to, packet.payload) == (255, bytes([0xC3]))
    # A controller that prints what it got shows the garble.
    with pytest.raises(Collision):
        bus_over(FakePhotonBus({3: C100N}, unaddressed=[NEW], checked=False)).unready()
    assert bus_over(FakePhotonBus({})).unready() is None


@pytest.mark.parametrize("address", [0, 255, 33])
def test_a_feed_is_never_sent_to_an_address_no_slot_has_whatever_gave_it(address):
    fake = FakePhotonBus({3: C100N})
    bus = bus_over(fake)
    with pytest.raises(BusError, match=f"address {address} is no slot's"):
        bus.advance(C100N, 20, address=address)
    assert bus.sent == [] and fake.fed == []  # type: ignore[attr-defined]


# --- the routes and a run ------------------------------------------------------------------


@pytest.fixture
def client(tmp_path):
    fake = FakeMarlin(position=(100.0, 50.0, 31.5))
    fake.bus = FakePhotonBus({3: C100N, 4: C1U})
    backend = rig_backend(tmp_path, {"lumen": PROFILE}, lambda url, baud: fake)
    app = create_app(backend, frontend=tmp_path / "no-dist")
    with TestClient(app) as client:
        client.backend = backend
        client.fake = fake
        yield client


def test_a_scan_of_the_feeders_picked_looks_for_each_by_its_id_and_names_the_missing(client):
    connect(client, "lumen")
    before = len(client.fake.lines)
    answer = client.post("/api/pnp/bus/scan", json={"feeders": ["c-1u", "c-100n", "c-1u"]}).json()
    assert answer["feeders"] == [{"address": 3, "id": C100N, "feeder": "c-100n", "slot": True}, {"address": 4, "id": C1U, "feeder": "c-1u", "slot": True}]
    assert answer["missing"] == []
    # One question each, by id, not one per address.
    asked = [line for line in client.fake.lines[before:] if line.startswith("M485")]
    assert len(asked) == 2 and all(decode(line[5:], HEADER_FIELDS).to == 255 for line in asked)
    # A feeder taken out of its slot is named, and why.
    client.fake.bus.remove(C1U)
    answer = client.post("/api/pnp/bus/scan", json={"feeders": ["c-1u"]}).json()
    assert answer["feeders"] == [] and answer["missing"] == [{"feeder": "c-1u", "id": C1U, "reason": "did not answer to its id: is it in a slot?"}]
    assert client.post("/api/pnp/bus/scan", json={"feeders": ["nope"]}).status_code == 404
    # No list: every address is asked, as before.
    assert [entry["address"] for entry in client.post("/api/pnp/bus/scan").json()["feeders"]] == [3]


def board_job(client) -> str:
    """The board's job added, C1 and C2 placed by hand on the machine: its id."""
    job = Job(name="board", source="kicad", groups=[Group(label="g", paths=[[(0.0, 0.0), (1.0, 0.0)]])], design=Design(shift=(-100.0, -70.0), rotation=0.0, board=True))
    client.backend.store.add(job)
    client.backend.store.keep_board(job.id, BOARD.encode())
    client.post("/api/pnp/references", json={"job": job.id, "ref": "C1", "at": [200.0, 50.0]})
    client.post("/api/pnp/references", json={"job": job.id, "ref": "C2", "at": [210.0, 50.0]})
    return job.id


def run_done(client, job_id: str) -> dict:
    """A run sent and waited out: the placing state after it."""
    assert client.post("/api/pnp/run", json={"job": job_id}).status_code == 200
    deadline = time.monotonic() + 10.0
    while client.get("/api/pnp/placing").json()["running"] and time.monotonic() < deadline:
        time.sleep(0.02)
    return client.get("/api/pnp/placing").json()


def test_the_bus_is_scanned_a_feeder_fed_and_a_run_advances_each_before_its_pick(client):
    connect(client, "lumen")
    scan = client.post("/api/pnp/bus/scan").json()["feeders"]
    assert scan == [{"address": 3, "id": C100N, "feeder": "c-100n", "slot": True}, {"address": 4, "id": C1U, "feeder": "c-1u", "slot": True}]
    assert client.post("/api/pnp/bus/feed", json={"feeder": "c-100n"}).status_code == 200
    assert client.fake.bus.fed == [(3, 20)]
    assert client.post("/api/pnp/bus/feed", json={"feeder": "nope"}).status_code == 404
    job_id = board_job(client)
    # C2's feeder has no slot in the file: connected, the plan finds it at address 4.
    planned = client.post("/api/pnp/plan", json={"job": job_id}).json()
    assert [entry["ref"] for entry in planned["parts"]] == ["C1", "C2"]
    state = run_done(client, job_id)
    assert state["progress"]["state"] == "done", state["progress"]
    assert state["progress"]["placed"] == ["C1", "C2"]
    assert client.fake.bus.fed[-2:] == [(3, 20), (4, 40)]
    steps = [step["text"] for step in state["progress"]["steps"]]
    assert "feeder c-1u advanced 4 mm (address 4)" in steps
    # C2 was picked at slot 4's place: 115, 400 turned, less nothing.
    assert "G0 X115 Y400 A0 F3000" in client.fake.lines


def test_a_run_leaves_out_the_parts_of_a_feeder_with_no_address_and_says_why(client, monkeypatch):
    # c-1u sits in a slot whose floor was never programmed: it answers
    # its find from 0, the host's address.
    client.fake.bus = FakePhotonBus({3: C100N}, unaddressed=[C1U])
    messages: list[tuple[str, str]] = []
    monkeypatch.setattr(client.backend, "publish_message", lambda level, text: messages.append((level, text)))
    connect(client, "lumen")
    job_id = board_job(client)
    planned = client.post("/api/pnp/plan", json={"job": job_id}).json()
    assert [entry["ref"] for entry in planned["parts"]] == ["C1"] and [entry["ref"] for entry in planned["skipped"]] == ["C2"]
    said = "feeder c-1u: it has no address (it answers from 0, the host's): its slot's floor is not programmed; its parts are left out"
    assert ("warning", said) in messages
    messages.clear()
    before = len(client.fake.lines)
    state = run_done(client, job_id)
    assert state["progress"]["state"] == "done", state["progress"]
    assert state["progress"]["placed"] == ["C1"] and ("warning", said) in messages
    # Only c-100n was fed, and nothing meant for one feeder went to 0 or 255.
    assert client.fake.bus.fed == [(3, 20)]
    packets = [decode(line[5:], HEADER_FIELDS) for line in client.fake.lines[before:] if line.startswith("M485")]
    assert all(packet.payload[0] == 0xC0 for packet in packets if packet.to in (0, 255))




def test_identify_flashes_the_feeders_picked_one_after_another_and_names_the_missing(client, monkeypatch):
    monkeypatch.setattr(feederbus, "IDENTIFY_WAIT", 0.0)
    strip = '[[feeder]]\nid = "tape"\nmatch = "10k"\nat = [10.0, 20.0, 1.0]\n'
    (client.backend.machine_store.directory / "lumen.toml").write_text(gcode_file(PROFILE + strip), encoding="utf-8")
    connect(client, "lumen")
    client.fake.bus.remove(C1U)
    stray = "00112233445566778899AABB"
    before = len(client.fake.lines)
    # c-100n named twice, by name and by its id from a scan row: it flashes once.
    response = client.post("/api/pnp/bus/identify", json={"feeders": ["c-100n", "c-1u", "tape"], "ids": [C100N.lower(), stray]})
    assert response.status_code == 200, response.text
    answer = response.json()
    assert answer["identified"] == [C100N] and client.fake.bus.identified == [C100N] and answer["machine"] == "lumen"
    assert answer["missing"] == [
        {"feeder": "tape", "id": None, "reason": "not on the bus: its file gives no bus_id"},
        {"feeder": "c-1u", "id": C1U, "reason": "did not answer to its id: is it in a slot?"},
        {"feeder": stray, "id": stray, "reason": "did not answer to its id: is it in a slot?"},
    ]
    asked = [decode(line[5:], HEADER_FIELDS) for line in client.fake.lines[before:] if line.startswith("M485")]
    assert {packet.to for packet in asked} == {255} and {packet.payload[0] for packet in asked} == {0xC1}
    assert client.post("/api/pnp/bus/identify", json={}).status_code == 400
    assert client.post("/api/pnp/bus/identify", json={"ids": ["12"]}).status_code == 400
    assert client.post("/api/pnp/bus/identify", json={"feeders": ["nope"]}).status_code == 404


def floor_of(client, feeder_id: str) -> int | None:
    return next(feeder.floor for feeder in client.fake.bus.feeders if feeder.id == feeder_id)


def changes(client, monkeypatch) -> list[dict]:
    """Every event the backend sends pages from now on, kept as it goes."""
    sent: list[dict] = []
    publish = client.backend.broadcast.publish_threadsafe
    monkeypatch.setattr(client.backend.broadcast, "publish_threadsafe", lambda event: (sent.append(event), publish(event)))
    return sent


def test_set_address_programs_a_feeders_floor_and_its_slots_place_follows(client, monkeypatch):
    connect(client, "lumen")
    sent = changes(client, monkeypatch)
    response = client.post("/api/pnp/bus/program", json={"address": 5, "feeder": C100N.lower()})
    assert response.status_code == 200, response.text
    answer = response.json()
    assert (answer["address"], answer["id"]) == (5, C100N) and floor_of(client, C100N) == 5
    # The scan again: c-100n at 5, its slot's place moved with it.
    assert answer["feeders"] == [{"address": 4, "id": C1U, "feeder": "c-1u", "slot": True}, {"address": 5, "id": C100N, "feeder": "c-100n", "slot": True}]
    machine = client.backend.machine_store.gcode("lumen")
    assert [slot.address for slot in machine.slots] == [5, 4]
    c100n = next(feeder for feeder in machine.feeders if feeder.id == "c-100n")
    assert c100n.slot == 5 and c100n.at == pytest.approx((100.0, 401.0, 10.5))
    assert "address = 5\nat = [100.0, 400.0, 10.0]" in client.backend.machine_store.text("lumen")
    # Pages read the file again.
    assert {"type": "changed", "what": "machines", "id": "lumen"} in sent


def test_set_address_refuses_an_address_taken_by_a_feeder_or_a_slot_or_none_at_all(client):
    connect(client, "lumen")
    taken = client.post("/api/pnp/bus/program", json={"address": 4, "feeder": C100N})
    assert taken.status_code == 409 and taken.json()["detail"] == "feeder c-1u answers at address 4: pick another"
    client.fake.bus.remove(C1U)
    slot = client.post("/api/pnp/bus/program", json={"address": 4, "feeder": C100N})
    assert slot.status_code == 409 and "[[slot]] 4 is another slot's place" in slot.json()["detail"]
    for address in (0, 33, 255):
        assert client.post("/api/pnp/bus/program", json={"address": address, "feeder": C100N}).status_code == 400
    assert client.post("/api/pnp/bus/program", json={"address": 5, "feeder": "12"}).status_code == 400
    # Nothing was written.
    assert floor_of(client, C100N) == 3 and [slot.address for slot in client.backend.machine_store.gcode("lumen").slots] == [3, 4]


def test_address_a_new_slot_initializes_the_others_then_programs_the_one_without(client, monkeypatch):
    client.fake.bus = FakePhotonBus({3: C100N, 4: C1U}, unaddressed=[NEW])
    connect(client, "lumen")
    sent = changes(client, monkeypatch)
    response = client.post("/api/pnp/bus/program", json={"address": 6})
    assert response.status_code == 200, response.text
    answer = response.json()
    assert (answer["address"], answer["id"]) == (6, NEW) and floor_of(client, NEW) == 6
    assert [(entry["address"], entry["id"], entry["feeder"], entry["slot"]) for entry in answer["feeders"]] == [
        (3, C100N, "c-100n", True), (4, C1U, "c-1u", True), (6, NEW, None, False)
    ]
    # No slot of the file moved: the new one has no place yet.
    assert [slot.address for slot in client.backend.machine_store.gcode("lumen").slots] == [3, 4]
    assert not [event for event in sent if event.get("type") == "changed"]
    # An address another feeder answers at is refused before anything is written.
    assert client.post("/api/pnp/bus/program", json={"address": 3}).json()["detail"] == "feeder c-100n answers at address 3: pick another"


@pytest.mark.parametrize(
    "unaddressed, checked, status, words",
    [
        ([], True, 409, "no feeder without an address answered"),
        ([NEW, "5350494E4E59000000000102"], True, 409, "no feeder without an address answered (two or more answering at once garble each other"),
        ([NEW, "5350494E4E59000000000102"], False, 409, "more than one feeder has no address: leave one in"),
    ],
)
def test_address_a_new_slot_needs_exactly_one_feeder_without_an_address(client, unaddressed, checked, status, words):
    client.fake.bus = FakePhotonBus({3: C100N}, unaddressed=unaddressed, checked=checked)
    connect(client, "lumen")
    response = client.post("/api/pnp/bus/program", json={"address": 6})
    assert response.status_code == status and response.json()["detail"].startswith(words)
    assert all(feeder.floor in (0, 3) for feeder in client.fake.bus.feeders)


def test_a_new_slot_with_no_floor_chip_is_not_addressed(client):
    client.fake.bus = FakePhotonBus({3: C100N}, chipless=[NEW])
    connect(client, "lumen")
    response = client.post("/api/pnp/bus/program", json={"address": 6})
    assert response.status_code == 502
    assert response.json()["detail"] == "the slot's address was not written: the slot's floor did not take the address: no floor chip, or the write did not read back"

