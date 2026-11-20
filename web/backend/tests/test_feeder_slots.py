"""A feeder bus slot's place taken from where the head is, with the nozzle
or with the top camera (its measured offset added, the height from the
file's slots, Q66), the part found and centered on first, and the top
camera put over a slot to check it: over the virtual LumenPnP's Marlin,
with a top camera that sees what lies under it."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from device_fakes import DeviceTopCamera, FakeMarlin, FakePhotonBus
from gcode_rig import connect, rig_backend
from test_feederbus import C1U, C100N

from spinny_web.app import create_app
from spinny_web.placing_part import OVER_SLOT_NEEDS_OFFSET, SLOT_NEEDS_HEIGHT, SLOT_NEEDS_OFFSET
from spinny_web.topcam import SCALE_NEEDED

# The top camera's picture center from the nozzle as measured; the file
# says another as designed, which a slot taken with the camera never takes.
OFFSET = (23.5, 65.25)

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
seesaw = true
[top_camera]
offset = [20.0, 60.0]
within = 2
[bus]
send = "M485 {{packet}}"
reply = "rs485-reply: (?<packet>[0-9A-Fa-f]*)"
poll_ms = 10
[[slot]]
address = 3
at = [100.0, 400.0, 10.0]   # its pick point
rotation = 90
[[slot]]
address = 4
at = [115.0, 400.0, 10.02]
[[feeder]]
id = "c-100n"
match = "100n"
bus_id = "{C100N}"
slot = 3
pocket = "bright"
size = [1.0, 0.5]
[[feeder]]
id = "c-1u"
match = "1u"
bus_id = "{C1U}"
"""

# The same machine with no slot and no feeder in its file yet.
BARE = PROFILE.split("[[slot]]")[0]


@pytest.fixture
def client(tmp_path):
    fake = FakeMarlin(position=(100.0, 50.0, 31.5))
    fake.bus = FakePhotonBus({3: C100N, 4: C1U})
    backend = rig_backend(tmp_path, {"lumen": PROFILE, "bare": BARE}, lambda url, baud: fake)
    app = create_app(backend, frontend=tmp_path / "no-dist")
    with TestClient(app) as client:
        client.backend = backend
        client.fake = fake
        client.path = backend.machine_store.path("lumen")
        yield client


def measured(client) -> None:
    """The top camera's offset, scale and picture as measured."""
    response = client.put("/api/pnp/top", json={"offset": list(OFFSET), "mm_per_px": 0.02, "roll": 1.5, "mirror": False})
    assert response.status_code == 200, response.text


def head_to(client, line: str) -> None:
    client.backend.gcode.command(line, 2.0)


def moves_after(client, count: int) -> list[str]:
    return [line for line in client.fake.lines[count:] if line.split()[0] in ("G0", "G1")]


def text(client) -> str:
    return client.path.read_text(encoding="utf-8")


def test_a_slot_taken_with_the_nozzle_is_written_as_the_page_wrote_it(client):
    connect(client, "lumen")
    head_to(client, "G0 X130.25 Y401.5 Z9.88")
    before = text(client)
    answer = client.post("/api/pnp/bus/slot", json={"address": 5, "by": "nozzle"})
    assert answer.status_code == 200, answer.text
    after = text(client)
    # As the page's withSlot wrote it: a blank line, the new slot, 3 decimals.
    assert after == before.rstrip("\n") + "\n\n[[slot]]\naddress = 5\nat = [130.250, 401.500, 9.880]\n"
    body = answer.json()
    assert body["slot"] == {"address": 5, "at": [130.25, 401.5, 9.88], "rotation": 0.0}
    assert body["machine"] == "lumen" and [slot["address"] for slot in body["document"]["slots"]] == [3, 4, 5]
    # A slot the file has: its `at` changed in place, as withSlot changed it.
    head_to(client, "G0 X115.5 Y399.75 Z10.1")
    assert client.post("/api/pnp/bus/slot", json={"address": 4, "by": "nozzle"}).status_code == 200
    assert text(client) == after.replace("at = [115.0, 400.0, 10.02]", "at = [115.500, 399.750, 10.100]")
    # A comment after the place stays, and so does the slot's turn.
    third = client.post("/api/pnp/bus/slot", json={"address": 3, "by": "nozzle"}).json()
    assert third["slot"] == {"address": 3, "at": [115.5, 399.75, 10.1], "rotation": 90.0}
    assert "address = 3\nat = [115.500, 399.750, 10.100]   # its pick point\nrotation = 90\n" in text(client)


def test_a_slot_taken_with_the_camera_is_the_head_plus_the_measured_offset_at_the_slots_height(client):
    connect(client, "lumen")
    before = text(client)
    # The file's offset as designed does not count: refused, nothing written.
    refused = client.post("/api/pnp/bus/slot", json={"address": 5, "by": "camera"})
    assert refused.status_code == 409 and refused.json()["detail"] == SLOT_NEEDS_OFFSET
    assert text(client) == before
    measured(client)
    count = len(client.fake.lines)
    answer = client.post("/api/pnp/bus/slot", json={"address": 5, "by": "camera"})
    assert answer.status_code == 200, answer.text
    # The head at 100, 50; the other slots' heights, 10 and 10.02, agree: 10.01.
    assert answer.json()["slot"] == {"address": 5, "at": [123.5, 115.25, 10.01], "rotation": 0.0}
    assert text(client).endswith("\n\n[[slot]]\naddress = 5\nat = [123.500, 115.250, 10.010]\n")
    # Only the head's place was read: nothing moved.
    assert moves_after(client, count) == []
    # A slot the file has keeps its own height.
    head_to(client, "G0 X90 Y330")
    answer = client.post("/api/pnp/bus/slot", json={"address": 3, "by": "camera"}).json()
    assert answer["slot"] == {"address": 3, "at": [113.5, 395.25, 10.0], "rotation": 90.0}
    assert "at = [113.500, 395.250, 10.000]   # its pick point" in text(client)


def test_a_slot_taken_with_the_camera_takes_its_height_from_slots_that_agree(client):
    connect(client, "bare")
    measured(client)
    path = client.backend.machine_store.path("bare")
    before = path.read_text(encoding="utf-8")
    # The first slot gives no height to take.
    refused = client.post("/api/pnp/bus/slot", json={"address": 1, "by": "camera"})
    assert refused.status_code == 409 and refused.json()["detail"] == SLOT_NEEDS_HEIGHT
    assert path.read_text(encoding="utf-8") == before
    # Taken with the nozzle, its height is the next one's.
    head_to(client, "G0 Z12.5")
    assert client.post("/api/pnp/bus/slot", json={"address": 1, "by": "nozzle"}).json()["slot"]["at"] == [100.0, 50.0, 12.5]
    head_to(client, "G0 X110 Z31.5")
    assert client.post("/api/pnp/bus/slot", json={"address": 2, "by": "camera"}).json()["slot"]["at"] == [133.5, 115.25, 12.5]
    # Slots whose heights differ give none.
    head_to(client, "G0 Z12.6")
    client.post("/api/pnp/bus/slot", json={"address": 2, "by": "nozzle"})
    refused = client.post("/api/pnp/bus/slot", json={"address": 3, "by": "camera"})
    assert refused.status_code == 409 and refused.json()["detail"] == f"{SLOT_NEEDS_HEIGHT} (the other slots' heights differ by 0.100 mm)"


@pytest.mark.parametrize(
    "body, status, words",
    [
        ({"address": 0, "by": "nozzle"}, 400, "a slot's address is 1 to 254, not 0"),
        ({"address": 255, "by": "nozzle"}, 400, "a slot's address is 1 to 254, not 255"),
        ({"address": 3, "by": "nozzle", "find": True}, 400, "find is for a slot taken with the camera"),
        # c-1u answered at 4, and has no pocket shade to look for.
        ({"address": 4, "by": "camera", "find": True}, 400, "find needs the feeder's pocket shade"),
        ({"address": 9, "by": "camera", "find": True}, 400, "find needs the feeder's pocket shade"),
    ],
)
def test_a_slot_that_cannot_be_taken_is_refused_before_anything_moves(client, body, status, words):
    connect(client, "lumen")
    measured(client)
    client.post("/api/pnp/bus/scan")
    before = text(client)
    count = len(client.fake.lines)
    response = client.post("/api/pnp/bus/slot", json=body)
    assert response.status_code == status and response.json()["detail"] == words
    assert moves_after(client, count) == [] and text(client) == before


def test_find_centers_the_camera_on_the_part_of_the_feeder_last_seen_there(client):
    connect(client, "lumen")
    # c-100n moved to address 4, where a scan finds it; its part lies 0.6
    # and -0.4 mm off where the camera looks from the head at 100, 50.
    client.fake.bus.feeders.clear()
    client.fake.bus.feeders[4] = C100N
    client.post("/api/pnp/bus/scan")
    part = (124.1, 114.85)
    client.backend.top.client = DeviceTopCamera(client.fake, OFFSET, [("bright", part[0], part[1], 1.0, 0.5)])
    # An offset with no scale measured says what is missing.
    client.put("/api/pnp/top", json={"offset": list(OFFSET)})
    count = len(client.fake.lines)
    unscaled = client.post("/api/pnp/bus/slot", json={"address": 4, "by": "camera", "find": True})
    assert unscaled.status_code == 409 and unscaled.json()["detail"] == SCALE_NEEDED
    assert moves_after(client, count) == []
    measured(client)
    count = len(client.fake.lines)
    answer = client.post("/api/pnp/bus/slot", json={"address": 4, "by": "camera", "find": True})
    assert answer.status_code == 200, answer.text
    # The part's center, at slot 4's own height.
    assert answer.json()["slot"] == {"address": 4, "at": [124.1, 114.85, 10.02], "rotation": 0.0}
    assert "at = [124.100, 114.850, 10.020]" in text(client)
    # The head went across only, at the safe height, the picture's center left on the part.
    moves = moves_after(client, count)
    assert moves and all(" Z" not in line for line in moves)
    assert client.fake.bed_position == pytest.approx((part[0] - OFFSET[0], part[1] - OFFSET[1], 31.5), abs=0.02)
    # Nothing there to find: refused, the file as it was.
    client.backend.top.client.things.clear()
    before = text(client)
    missed = client.post("/api/pnp/bus/slot", json={"address": 4, "by": "camera", "find": True})
    assert missed.status_code == 409 and "no bright part of feeder c-100n within 2 mm" in missed.json()["detail"]
    assert text(client) == before


def test_the_camera_goes_over_a_slot_across_only_and_never_down(client):
    connect(client, "lumen")
    refused = client.post("/api/pnp/bus/over-slot", json={"address": 3})
    assert refused.status_code == 409 and refused.json()["detail"] == OVER_SLOT_NEEDS_OFFSET
    measured(client)
    assert client.post("/api/pnp/bus/over-slot", json={"address": 9}).status_code == 404
    count = len(client.fake.lines)
    assert client.post("/api/pnp/bus/over-slot", json={"address": 3}).status_code == 200
    # Slot 3 at 100, 400 less the measured offset; the head at the safe height stays there.
    assert moves_after(client, count) == ["G0 X76.5 Y334.75 F3000"]
    assert client.fake.bed_position == pytest.approx((76.5, 334.75, 31.5))
    # From below the safe height it goes up first; slot 4 lies along X from 3.
    head_to(client, "G0 Z20")
    count = len(client.fake.lines)
    assert client.post("/api/pnp/bus/over-slot", json={"address": 4}).status_code == 200
    assert moves_after(client, count) == ["G0 Z31.5 F600", "G0 X91.5 F3000"]
    assert client.fake.bed_position == pytest.approx((91.5, 334.75, 31.5))
