"""The feeders' check: a job's parts as the plan takes them (part_feeders,
the plan's own first half), what each feeder must give and has left,
where a bus feeder last answered, and the route that answers it with
nothing moved and the bus not asked."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from device_fakes import FakeMarlin, FakePhotonBus
from gcode_rig import connect, gcode_file, rig_backend
from test_feederbus import BOARD, C1U, C100N
from test_feederbus import PROFILE as BUS_PROFILE
from test_feederbus import part as bus_part
from test_openpnp import PROFILE, TRAY, device, part

from spinny_web.app import create_app
from spinny_web.jobs import Design, Group, Job
from spinny_web.openpnp import NO_FEEDER, board_fit, feeder_check, parse, part_feeders, plan, ref_words

R0603 = "Resistor_SMD:R_0603_1608Metric"


def bus_device():
    return parse(gcode_file(BUS_PROFILE), "lumen")


def same_as_plan(machine, parts, refs=None, taken=None, vision_ready=False):
    """part_feeders' list against the plan's: each reason it gives is the
    plan's for that part, in the plan's order; the parts it lets through
    are the plan's blocks, in order, and the parts the plan leaves out for
    reasons of its own (the bottom camera, a slot not known, an empty
    feeder), each from the feeder the plan took."""
    fit = board_fit([((0.0, 0.0), (100.0, 50.0))], 0.0)
    program = plan(machine, parts, fit, dict(taken or {}), refs, vision_ready=vision_ready)
    entries = part_feeders(machine, parts, refs)
    through = [entry for entry in entries if entry.reason is None]
    through_refs = {entry.ref for entry in through}
    left = [(entry.ref, entry.reason) for entry in entries if entry.reason is not None]
    assert left == [(skip["ref"], skip["reason"]) for skip in program.skipped if skip["ref"] not in through_refs]
    planned = [block.ref for block in program.blocks]
    assert planned == [entry.ref for entry in through if entry.ref in set(planned)]
    own = {skip["ref"] for skip in program.skipped if skip["ref"] in through_refs}
    assert set(planned) | own == through_refs and not set(planned) & own
    feeder_of = {entry.ref: entry.feeder.id for entry in through}
    assert all(feeder_of[block.ref] == block.feeder for block in program.blocks)
    return entries, program


# --- the plan's own list -------------------------------------------------------------


def test_part_feeders_give_the_plans_parts_and_reasons_on_its_fixtures():
    parts = [
        part("R1", "10k", R0603, 1.0, 2.0, 0.0),
        part("R2", "10k", R0603, 3.0, 2.0, 180.0),
        part("C1", "100n", "Capacitor_SMD:C_0402", 5.0, 6.0, 45.0),
        part("U1", "STM32", "Package_QFP:LQFP-32", 0.0, 0.0),
        part("R3", "10k", R0603, 4.0, 4.0),
        part("C2", "100n", "Capacitor_SMD:C_0402", 7.0, 7.0, dnp=True),
        part("C3", "100n", "Capacitor_SMD:C_0402", 8.0, 8.0, side="back"),
        part("FID1", "", "Fiducial", 9.0, 9.0, fiducial=True),
    ]
    entries, program = same_as_plan(device(), parts, taken={"res": 1})
    # The plan's own reason (an empty strip) is not part_feeders' to give.
    assert [skip["reason"] for skip in program.skipped if skip["ref"] in ("R2", "R3")] == ["feeder res is empty"] * 2
    assert [(entry.ref, entry.reason) for entry in entries] == [
        ("R1", None), ("R2", None), ("C1", None), ("U1", NO_FEEDER), ("R3", None),
        ("C2", "not to be fitted (dnp)"), ("C3", "on the back"),
    ]
    # Asked for by name: one the job lacks first, a fiducial named.
    entries, _ = same_as_plan(device(), parts, refs=["C1", "Q9", "FID1"])
    assert [(entry.ref, entry.reason) for entry in entries] == [("Q9", "not a part of this job"), ("C1", None), ("FID1", "a fiducial, not a part")]
    kept_out = [
        part("TP1", "100n", "TestPoint:TestPoint_Pad_D1.0mm", 1.0, 1.0, exclude_from_pos_files=True),
        part("TP2", "100n", "TestPoint:TestPoint_Pad_D1.0mm", 2.0, 1.0, exclude_from_pos_files=True),
        part("C1", "100n", "Capacitor_SMD:C_0402", 3.0, 1.0, filtered=True),
        part("C2", "100n", "Capacitor_SMD:C_0402", 4.0, 1.0),
    ]
    same_as_plan(device(), kept_out)
    same_as_plan(device(), kept_out, refs=["TP2", "C1", "C2"])
    named = parse(gcode_file(PROFILE.replace('match = "100n"', 'refs = ["TP1", "C2"]')), "test")
    entries, _ = same_as_plan(named, kept_out)
    assert [entry.ref for entry in entries if entry.reason is None] == ["TP1", "C2"]
    # A tray whose parts want the bottom camera, centered or not.
    tray = parse(gcode_file(TRAY), "test")
    tray_parts = [part("C1", "100n", "C_0402", 5.0, 6.0), part("U1", "STM32", "LQFP-32", 2.0, 3.0, 90.0)]
    same_as_plan(tray, tray_parts, taken={"ic": 4})
    same_as_plan(tray, tray_parts, taken={"ic": 4}, vision_ready=True)
    # A bus feeder whose slot is not known yet.
    _, program = same_as_plan(bus_device(), [bus_part("C1", "100n", 1.0, 0.0), bus_part("C2", "1u", 2.0, 0.0)])
    assert program.skipped == [{"ref": "C2", "reason": "feeder c-1u's slot is not known: scan the feeder bus, or run, which finds it"}]


# --- the check -----------------------------------------------------------------------


def test_references_are_named_in_words_and_counted_past_six():
    assert ref_words(["R3"]) == "R3"
    assert ref_words(["R3", "R4"]) == "R3 and R4"
    assert ref_words(["R1", "R2", "R3"]) == "R1, R2 and R3"
    six = [f"R{n}" for n in range(1, 7)]
    assert ref_words(six) == "R1, R2, R3, R4, R5 and R6"
    assert ref_words([*six, "R7", "R8"]) == "R1, R2, R3, R4, R5 and 3 more"


def test_the_check_names_the_parts_no_feeder_holds_and_a_feeder_short_or_empty():
    parts = [
        part("R1", "10k", R0603, 1.0, 2.0),
        part("R2", "10k", R0603, 3.0, 2.0),
        part("U1", "STM32", "Package_QFP:LQFP-32", 0.0, 0.0),
        part("R3", "10k", R0603, 4.0, 4.0),
        part("C1", "100n", "Capacitor_SMD:C_0402", 5.0, 6.0),
        part("U2", "STM32", "Package_QFP:LQFP-32", 0.0, 5.0),
        part("C2", "100n", "Capacitor_SMD:C_0402", 7.0, 7.0, dnp=True),
        part("FID1", "", "Fiducial", 9.0, 9.0, fiducial=True),
    ]
    check = feeder_check(device(), parts, None, {"res": 1}, {})
    # The parts the job places, in its order; the dnp part and the fiducial are the job's to leave out.
    assert [(entry["ref"], entry["feeder"], entry["reason"]) for entry in check["parts"]] == [
        ("R1", "res", None), ("R2", "res", None), ("U1", None, "no feeder holds it"), ("R3", "res", None),
        ("C1", "cap", None), ("U2", None, "no feeder holds it"),
    ]
    assert check["parts"][0] == {"ref": "R1", "value": "10k", "footprint": R0603, "feeder": "res", "reason": None}
    # The strip of two has given one; the feeder told to advance counts nothing.
    assert check["feeders"] == [
        {"id": "res", "refs": ["R1", "R2", "R3"], "needs": 3, "left": 1, "place_known": True, "bus_id": None, "address": None, "seen": False},
        {"id": "cap", "refs": ["C1"], "needs": 1, "left": None, "place_known": True, "bus_id": None, "address": None, "seen": False},
    ]
    assert check["problems"] == ["U1 and U2: no feeder holds them", "feeder res has 1 part left, 3 needed"]
    assert check["ready"] is False
    empty = feeder_check(device(), parts, None, {"res": 5}, {})
    assert empty["feeders"][0]["left"] == 0 and empty["problems"][1] == "feeder res has no parts left, 3 needed"
    assert feeder_check(device(), parts, None, {}, {})["problems"][1] == "feeder res has 2 parts left, 3 needed"
    # Only the parts asked for: enough left, every place known, ready.
    picked = feeder_check(device(), parts, ["R1", "C1"], {"res": 1}, {})
    assert [entry["ref"] for entry in picked["parts"]] == ["R1", "C1"] and picked["problems"] == [] and picked["ready"] is True
    alone = feeder_check(device(), parts, ["U1"], {}, {})
    assert alone["feeders"] == [] and alone["problems"] == ["U1: no feeder holds it"] and alone["ready"] is False
    # Nothing to place is not ready, and no problem.
    nothing = feeder_check(device(), parts, ["C2", "FID1", "Q9"], {}, {})
    assert nothing == {"parts": [], "feeders": [], "problems": [], "ready": False}


def test_a_bus_feeders_place_is_known_by_its_slot_or_where_the_bus_answered():
    machine = bus_device()
    parts = [bus_part("C1", "100n", 1.0, 0.0), bus_part("C2", "1u", 2.0, 0.0), bus_part("C3", "1u", 3.0, 0.0)]
    check = feeder_check(machine, parts, None, {}, {})
    c100n, c1u = check["feeders"]
    # c-100n names its slot in the file; c-1u has not answered on the bus.
    assert c100n == {"id": "c-100n", "refs": ["C1"], "needs": 1, "left": None, "place_known": True, "bus_id": C100N, "address": 3, "seen": False}
    assert c1u == {"id": "c-1u", "refs": ["C2", "C3"], "needs": 2, "left": None, "place_known": False, "bus_id": C1U, "address": None, "seen": False}
    assert check["problems"] == ["feeder c-1u's slot is not known: scan the feeder bus"] and check["ready"] is False
    # Seen at address 4, which has a [[slot]]: known, and ready.
    seen = feeder_check(machine, parts, None, {}, {C1U: 4})
    assert seen["feeders"][1] == {**c1u, "place_known": True, "address": 4, "seen": True}
    assert seen["problems"] == [] and seen["ready"] is True
    # Seen where no [[slot]] says the place.
    away = feeder_check(machine, parts, None, {}, {C1U: 9})
    assert away["feeders"][1]["place_known"] is False and away["feeders"][1]["address"] == 9
    assert away["problems"] == ["feeder c-1u is at bus address 9, which has no [[slot]] place in the machine file"]
    # A feeder whose file names its slot keeps its place; the address is where it answered.
    moved = feeder_check(machine, parts, None, {}, {C100N: 4, C1U: 4})
    assert moved["feeders"][0] == {**c100n, "address": 4, "seen": True}


# --- the route -----------------------------------------------------------------------


@pytest.fixture
def client(tmp_path):
    fake = FakeMarlin(position=(100.0, 50.0, 31.5))
    fake.bus = FakePhotonBus({3: C100N, 4: C1U})
    backend = rig_backend(tmp_path, {"lumen": BUS_PROFILE}, lambda url, baud: fake)
    app = create_app(backend, frontend=tmp_path / "no-dist")
    with TestClient(app) as client:
        client.backend = backend
        client.fake = fake
        yield client


def board_job(client) -> str:
    job = Job(name="board", source="kicad", groups=[Group(label="g", paths=[[(0.0, 0.0), (1.0, 0.0)]])], design=Design(shift=(-100.0, -70.0), rotation=0.0, board=True))
    client.backend.store.add(job)
    client.backend.store.keep_board(job.id, BOARD.encode())
    return job.id


def c1u_of(client, job: str) -> dict:
    response = client.post("/api/pnp/feeders/check", json={"job": job})
    assert response.status_code == 200, response.text
    return next(entry for entry in response.json()["feeders"] if entry["id"] == "c-1u")


def test_the_route_answers_with_nothing_sent_and_keeps_where_the_bus_answered_until_a_disconnect(client):
    job = board_job(client)
    # With no machine connected the file is checked: c-1u's slot is not known.
    answer = client.post("/api/pnp/feeders/check", json={"job": job}).json()
    assert [entry["ref"] for entry in answer["parts"]] == ["C1", "C2"] and answer["ready"] is False
    assert answer["problems"] == ["feeder c-1u's slot is not known: scan the feeder bus"]
    connect(client, "lumen")
    before = list(client.fake.lines)
    assert c1u_of(client, job)["seen"] is False
    assert client.fake.lines == before
    # A scan of every address: known where it answered.
    client.post("/api/pnp/bus/scan")
    assert c1u_of(client, job) == {
        "id": "c-1u", "refs": ["C2"], "needs": 1, "left": None, "place_known": True, "bus_id": C1U, "address": 4, "seen": True,
    }
    assert client.post("/api/pnp/feeders/check", json={"job": job, "refs": ["C2"]}).json()["ready"] is True
    # Taken out of its slot, a scan that does not find it forgets it.
    del client.fake.bus.feeders[4]
    client.post("/api/pnp/bus/scan")
    assert c1u_of(client, job)["seen"] is False
    # Put in a slot the file has no place for, found by its id.
    client.fake.bus.feeders[5] = C1U
    client.post("/api/pnp/bus/scan", json={"feeders": ["c-1u"]})
    assert c1u_of(client, job) == {
        "id": "c-1u", "refs": ["C2"], "needs": 1, "left": None, "place_known": False, "bus_id": C1U, "address": 5, "seen": True,
    }
    # Not found by its id: forgotten.
    del client.fake.bus.feeders[5]
    client.post("/api/pnp/bus/scan", json={"feeders": ["c-1u"]})
    assert c1u_of(client, job)["address"] is None
    # The plan asks the bus for a feeder whose file gives no slot, by its id: kept too.
    client.fake.bus.feeders[4] = C1U
    client.post("/api/pnp/references", json={"job": job, "ref": "C1", "at": [200.0, 50.0]})
    client.post("/api/pnp/references", json={"job": job, "ref": "C2", "at": [210.0, 50.0]})
    assert [entry["ref"] for entry in client.post("/api/pnp/plan", json={"job": job}).json()["parts"]] == ["C1", "C2"]
    assert c1u_of(client, job)["address"] == 4
    # A disconnect forgets it, and a connect again starts with nothing.
    assert client.post("/api/disconnect").status_code == 200
    assert c1u_of(client, job)["seen"] is False
    connect(client, "lumen")
    assert c1u_of(client, job)["seen"] is False
    assert client.post("/api/pnp/feeders/check", json={"job": "nope"}).status_code == 404
