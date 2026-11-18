"""The top camera's offset applied after: a board's place taken through the
camera keeps the offset it was taken with and moves when the offset does,
finding a board needs no offset at all (its places are then the camera's
own, and the nozzle is kept off them until one is measured), Find
fiducials goes by the offset in use with only the scale measured, and the
look's own places follow a change."""

from __future__ import annotations

import pytest
from device_fakes import BoardTopCamera, FakeMarlin, SeenBoard, turn
from fastapi.testclient import TestClient
from gcode_rig import rig_backend
from test_placer import CAMERA_OFFSET, TOP, TRUE_TURN, job_places, outlined_job, profile, rig, routine_done, true_place, with_top_camera

from spinny_web import boardlook
from spinny_web.app import create_app
from spinny_web.boardlook import BoardLook, Estimate
from spinny_web.placing_part import CAMERA_NEEDS_OFFSET, MIXED_NEEDS_OFFSET, NOZZLE_NEEDS_OFFSET, reference_offset, reference_place

# A top camera whose file says nothing of where it looks from.
BARE_TOP = '[top_camera]\nz = 0\nfiducial = "bright"\nwithin = 2\n'
# The offset TOP's file gives as designed.
DESIGNED = (34.0, -9.0)


@pytest.fixture
def client(tmp_path):
    fake = FakeMarlin(position=(100.0, 50.0, 0.0))
    backend = rig_backend(tmp_path, {}, lambda url, baud: fake)
    app = create_app(backend, frontend=tmp_path / "no-dist")
    with TestClient(app) as client:
        client.backend = backend
        client.fake = fake
        yield client


@pytest.fixture
def quick_search(monkeypatch):
    """The fakes lock at once: a stop is looked at for a moment only."""
    monkeypatch.setattr(boardlook, "LOCK_SECONDS", 0.15)
    monkeypatch.setattr(boardlook, "STOP_SECONDS", 0.6)
    monkeypatch.setattr(boardlook, "SAMPLE_SECONDS", 0.01)


def references(client, job_id: str) -> dict:
    return {entry["ref"]: entry for entry in client.get("/api/pnp/placing").json()["references"] if entry["job"] == job_id}


def kept(client, job_id: str) -> dict:
    """The references as the config keeps them, by ref."""
    return {entry["ref"]: entry for entry in client.backend._placing_config().get("references", []) if entry["job"] == job_id}


# --- a reference's place ------------------------------------------------------------------------


def test_a_reference_reads_where_the_offset_in_use_puts_it():
    taken = {"at": [134.0, 41.0], "by": "camera", "offset": [34.0, -9.0]}
    assert reference_offset(taken) == (34.0, -9.0)
    assert reference_place(taken, (34.0, -9.0)) == (134.0, 41.0)
    # The offset measured after: the place moves by how far the offset did.
    assert reference_place(taken, (35.0, -10.5)) == (135.0, 39.5)
    # Taken with none known, it was the head's place.
    assert reference_place({"at": [100.0, 50.0], "offset": [0, 0]}, (35.0, -10.0)) == (135.0, 40.0)
    # One kept before references carried the offset, one by the nozzle and
    # one whose offset does not read stay where they were taken.
    for entry in ({"at": [1.0, 2.0], "by": "camera"}, {"at": [1.0, 2.0], "by": "nozzle"}, {"at": [1.0, 2.0], "offset": [True, 1]}, {"at": [1.0, 2.0], "offset": [3.0]}):
        assert reference_offset(entry) is None and reference_place(entry, (35.0, -10.0)) == (1.0, 2.0)


def test_a_camera_reference_moves_with_an_offset_set_after_and_older_ones_stay(client):
    job_id = rig(client, profile(rest=TOP))
    # The picture's center on R1 with the head at 100, 50: by the file's offset.
    state = client.post("/api/pnp/references", json={"job": job_id, "ref": "R1", "camera": True}).json()
    assert state["references"] == [{"job": job_id, "ref": "R1", "at": [134.0, 41.0], "by": "camera", "offset": [34.0, -9.0]}]
    # A reference kept before this, and one typed for the nozzle.
    client.backend._placing_config()["references"].append({"job": job_id, "ref": "R2", "at": [144.0, 41.0], "by": "camera"})
    client.post("/api/pnp/references", json={"job": job_id, "ref": "FID1", "at": [129.0, 51.0]})
    # The offset measured after the board was taken: 1 mm further along X, 1.5 less along Y.
    assert client.put("/api/pnp/top", json={"offset": [35.0, -10.5]}).status_code == 200
    shown = references(client, job_id)
    assert shown["R1"] == {"job": job_id, "ref": "R1", "at": [135.0, 39.5], "by": "camera", "offset": [34.0, -9.0]}
    assert shown["R2"]["at"] == [144.0, 41.0] and shown["FID1"] == {"job": job_id, "ref": "FID1", "at": [129.0, 51.0], "by": "nozzle"}
    # Nothing is written again: the config keeps the place as taken.
    assert kept(client, job_id)["R1"]["at"] == [134.0, 41.0]
    # The fit, and so a plan, goes by the places as they are now.
    parts = client.backend.job_parts(job_id)["components"]
    places = {part["ref"]: (part["x"], part["y"]) for part in parts}
    client.delete(f"/api/pnp/references?job={job_id}&ref=R2")
    client.delete(f"/api/pnp/references?job={job_id}&ref=FID1")
    fit = client.backend._board_fit(job_id, parts)
    assert fit.apply(places["R1"]) == pytest.approx((135.0, 39.5))
    planned = client.post("/api/pnp/plan", json={"job": job_id, "refs": ["R1"]})
    assert planned.status_code == 200, planned.text
    # The measured offset taken back (an Undo does the same): the file's again.
    assert client.put("/api/pnp/top", json={"clear": ["offset"]}).status_code == 200
    assert references(client, job_id)["R1"]["at"] == [134.0, 41.0]


# --- no offset known ----------------------------------------------------------------------------


def test_with_no_offset_known_the_camera_takes_places_and_the_nozzle_waits_for_one(client):
    job_id = rig(client, profile(rest=BARE_TOP))
    assert client.backend._top_offset_in_use(client.backend.placing_machine()) == ((0.0, 0.0), False)
    parts = client.backend.job_parts(job_id)["components"]
    places = {part["ref"]: (part["x"], part["y"]) for part in parts}
    # No reference at all: nothing to refuse for, nowhere to go.
    assert client.post("/api/pnp/goto", json={"job": job_id, "ref": "R1", "camera": True}).status_code == 400
    # Camera here: accepted, the place the head's, the offset noted as none.
    response = client.post("/api/pnp/references", json={"job": job_id, "ref": "R1", "camera": True})
    assert response.status_code == 200, response.text
    assert references(client, job_id)["R1"] == {"job": job_id, "ref": "R1", "at": [100.0, 50.0], "by": "camera", "offset": [0.0, 0.0]}
    # The camera goes back over what it took: the offset drops out.
    client.post("/api/command", json={"line": "G0 X80 Y30"})
    assert client.post("/api/pnp/goto", json={"job": job_id, "ref": "R1", "camera": True}).status_code == 200
    assert client.fake.position[:2] == pytest.approx((100.0, 50.0))
    assert client.backend._board_fit(job_id, parts, frame="camera").apply(places["R1"]) == pytest.approx((100.0, 50.0))
    # The nozzle cannot: a plan, a run, a goto by the nozzle say what to do.
    with pytest.raises(ValueError) as refused:
        client.backend._board_fit(job_id, parts)
    assert str(refused.value) == NOZZLE_NEEDS_OFFSET
    for path, body in (("/api/pnp/plan", {"job": job_id}), ("/api/pnp/run", {"job": job_id}), ("/api/pnp/goto", {"job": job_id, "ref": "R1"})):
        response = client.post(path, json=body)
        assert response.status_code == 400, (path, response.text)
        assert "taken by the top camera" in response.text and "Measure offset" in response.text
    # A reference by the nozzle beside it: the two cannot be set against each other.
    client.post("/api/pnp/references", json={"job": job_id, "ref": "R2", "at": [144.0, 41.0]})
    for frame in ("nozzle", "camera"):
        with pytest.raises(ValueError) as refused:
            client.backend._board_fit(job_id, parts, frame=frame)
        assert str(refused.value) == MIXED_NEEDS_OFFSET
    assert client.post("/api/pnp/goto", json={"job": job_id, "ref": "R1", "camera": True}).status_code == 400
    # References by the nozzle only: the nozzle goes by them, the camera cannot.
    client.delete(f"/api/pnp/references?job={job_id}&ref=R1")
    assert client.backend._board_fit(job_id, parts).apply(places["R2"]) == pytest.approx((144.0, 41.0))
    with pytest.raises(ValueError) as refused:
        client.backend._board_fit(job_id, parts, frame="camera")
    assert str(refused.value) == CAMERA_NEEDS_OFFSET and "Measure offset" in CAMERA_NEEDS_OFFSET
    # A corner of a board is taken the same way: the head's place, no offset.
    outlined = outlined_job(client)
    response = client.post("/api/pnp/top/corner", json={"job": outlined, "corner": "bottom left"})
    assert response.status_code == 200, response.text
    assert references(client, outlined) == {
        "corner bottom left": {"job": outlined, "ref": "corner bottom left", "at": [100.0, 50.0], "by": "corner", "point": [0.0, 0.0], "offset": [0.0, 0.0]},
    }
    [corner] = response.json()["top"]["board_look"]["corners"]["points"]
    assert corner["machine"] == [100.0, 50.0]
    # The swap of nozzle and camera over a point still needs a true offset.
    assert client.post("/api/pnp/swap", json={"to": "nozzle"}).status_code == 400


def test_a_board_found_with_no_offset_known_moves_onto_the_offset_measured_after(client, quick_search):
    rig(client, profile(rest=BARE_TOP))
    job_id = outlined_job(client)
    # The camera truly looks 34, -9 from the nozzle; nothing says so yet.
    board = SeenBoard((0.0, 0.0, 40.0, 30.0), 2.0, (150.0, 80.0), design_shift=(-100.0, -70.0))
    camera = BoardTopCamera(client.fake, DESIGNED, board, roll=1.5)
    client.backend.top.client = camera
    client.put("/api/pnp/top", json={"mm_per_px": 0.02, "roll": 1.5, "mirror": False})
    assert client.get("/api/pnp/placing").json()["top"]["offset"] is None
    assert client.post("/api/pnp/top/board", json={"job": job_id}).status_code == 200
    # The box as the head's places: the board lies one offset further.
    response = client.post("/api/pnp/top/search", json={"box": [106.0, 79.0, 166.0, 134.0]})
    assert response.status_code == 200, response.text
    assert routine_done(client, "/api/pnp/placing")["state"] == "done"
    look = client.get("/api/pnp/placing").json()["top"]["board_look"]
    mid = turn((20.0, 15.0), 2.0)
    middle = (mid[0] + 150.0, mid[1] + 80.0)
    # Found, in the camera's own places: where the head stands over it.
    assert look["found"] is True and look["estimate"]["rotation"] == pytest.approx(2.0, abs=0.01)
    assert look["estimate"]["center"] == pytest.approx([middle[0] - 34.0, middle[1] + 9.0], abs=0.01)
    assert client.fake.position[:2] == pytest.approx((middle[0] - 34.0, middle[1] + 9.0), abs=0.01)
    # The place found kept as references, the offset noted as none.
    response = client.post("/api/pnp/top/place", json={"job": job_id})
    assert response.status_code == 200, response.text
    parts = {part["ref"]: part for part in client.get(f"/api/jobs/{job_id}/components").json()["components"]}
    taken = references(client, job_id)
    assert len(taken) == 2 and all(entry["by"] == "look" and entry["offset"] == [0.0, 0.0] for entry in taken.values())
    # The nozzle is kept off the board until the offset is known.
    assert client.post("/api/pnp/plan", json={"job": job_id}).status_code == 400
    # The offset measured after (typed here): every place moves onto it.
    said: list[tuple[str, str]] = []
    publish = client.backend.publish_message
    client.backend.publish_message = lambda level, text: (said.append((level, text)), publish(level, text))[1]
    assert client.put("/api/pnp/top", json={"offset": list(DESIGNED)}).status_code == 200
    for ref, entry in references(client, job_id).items():
        x, y = turn((parts[ref]["x"], parts[ref]["y"]), 2.0)
        assert entry["at"] == pytest.approx([x + 150.0, y + 80.0], abs=0.01) and entry["offset"] == [0.0, 0.0]
    assert client.post("/api/pnp/plan", json={"job": job_id}).status_code == 200
    # The look's own place found moved too: the next search starts from the
    # board's true middle, and its guesses started over. Said once.
    assert client.post("/api/pnp/top/search", json={"box": [140.0, 70.0, 200.0, 125.0]}).status_code == 200
    assert routine_done(client, "/api/pnp/placing")["state"] == "done"
    look = client.get("/api/pnp/placing").json()["top"]["board_look"]
    assert look["known"]["source"] == "found" and look["known"]["center"] == pytest.approx(list(middle), abs=0.01)
    assert look["found"] is True and look["estimate"]["center"] == pytest.approx(list(middle), abs=0.01)
    moved = [text for level, text in said if "offset moved by" in text]
    assert moved == ["the top camera's offset moved by X +34.000 Y -9.000 mm: the corners and the place found moved with it, the guesses start over"]


# --- the look follows a change ------------------------------------------------------------------


def test_a_look_shifted_moves_its_corners_and_places_found_and_starts_its_guesses_over():
    look = BoardLook(lambda: None, lambda: None, paused=lambda: True)
    # Nothing held: nothing to move.
    assert look.shift(1.0, 2.0) is False
    look.add_corner("j1", "bottom left", (0.0, 0.0), (10.0, 20.0), (20.0, 15.0), 1.5, "edges")
    look.job = "j1"
    found = Estimate(2.0, (150.0, 80.0), (170.0, 96.0), 0.03, corners=[(0.0, 0.0)], seen=(20.0, 15.0), place=(171.0, 95.0))
    look.remember_found(found)
    for _ in range(boardlook.NEED):
        look.consensus.see("locked", found, None)
    assert look.consensus.guesses and look.consensus.best is not None
    look._changed = False
    assert look.shift(1.0, -1.5) is True
    [corner] = look.corners_of("j1")
    # The machine points move; what is said in the job's frame, the turn
    # and how the corner was taken stay.
    assert corner.machine == (11.0, 18.5) and corner.job == (0.0, 0.0) and (corner.angle, corner.by) == (1.5, "edges")
    place = look.found_known("j1").place
    assert place.shift == (151.0, 78.5) and place.center == (171.0, 94.5) and place.place == (172.0, 93.5)
    assert place.rotation == 2.0 and place.seen == (20.0, 15.0) and place.corners == [(0.0, 0.0)]
    assert look.consensus.guesses == [] and look.consensus.best is None and look._changed is True
    # The fresh guesses weigh the corner where it lies now.
    assert look.consensus.corners == [corner]


def test_the_top_look_is_shifted_once_when_the_offset_in_use_changes(client):
    rig(client, profile(rest=TOP))
    job_id = outlined_job(client)
    client.put("/api/pnp/top", json={"mm_per_px": 0.02, "roll": 0.0, "mirror": False})
    backend = client.backend
    machine = backend.placing_machine()
    said: list[str] = []
    publish = backend.publish_message
    backend.publish_message = lambda level, text: (said.append(text), publish(level, text))[1]
    # A corner taken under the file's offset: the head at 100, 50.
    assert client.post("/api/pnp/top/corner", json={"job": job_id, "corner": "bottom left"}).status_code == 200
    [corner] = backend.top_look.corners_of(job_id)
    assert corner.machine == pytest.approx((134.0, 41.0))
    assert backend._settle_top_look(machine) == DESIGNED and said == []
    # Measured after: the look's corner and the reference kept of it agree.
    client.put("/api/pnp/top", json={"offset": [35.0, -10.5]})
    assert backend._settle_top_look(machine) == (35.0, -10.5)
    [corner] = backend.top_look.corners_of(job_id)
    assert corner.machine == pytest.approx((135.0, 39.5))
    assert references(client, job_id)["corner bottom left"]["at"] == [135.0, 39.5]
    assert said == ["the top camera's offset moved by X +1.000 Y -1.500 mm: the corners and the place found moved with it, the guesses start over"]
    # Settled again, nothing moves and nothing is said.
    backend._settle_top_look(machine)
    assert backend.top_look.corners_of(job_id)[0].machine == pytest.approx((135.0, 39.5)) and len(said) == 1
    # A corner taken now lands where the camera looks by the new offset.
    client.post("/api/pnp/top/corner", json={"job": job_id, "corner": "top right"})
    assert backend.top_look.corners_of(job_id)[-1].machine == pytest.approx((135.0, 39.5))
    assert references(client, job_id)["corner top right"]["offset"] == [35.0, -10.5]


# --- find fiducials by the offset in use --------------------------------------------------------


def test_find_fiducials_goes_by_the_files_offset_and_its_finds_move_onto_the_one_measured_after(client):
    job_id = rig(client, profile(rest=TOP))
    # The camera truly looks from CAMERA_OFFSET; the file says 34, -9.
    with_top_camera(client, job_id)
    error = (CAMERA_OFFSET[0] - DESIGNED[0], CAMERA_OFFSET[1] - DESIGNED[1])
    places = job_places(client, job_id)
    # The picture's center put on R1 by eye, 0.4 and 0.3 mm off: Camera here.
    r1 = true_place(places["R1"])
    client.post("/api/command", json={"line": f"G0 X{r1[0] + 0.4 - CAMERA_OFFSET[0]} Y{r1[1] - 0.3 - CAMERA_OFFSET[1]}"})
    client.post("/api/pnp/references", json={"job": job_id, "ref": "R1", "camera": True})
    # No scale measured: that is what Find fiducials cannot do without.
    response = client.post("/api/pnp/fiducials", json={"job": job_id})
    assert response.status_code == 400 and "scale is not measured" in response.text and "offset" not in response.text
    client.put("/api/pnp/top", json={"mm_per_px": 0.02, "roll": 1.5, "mirror": False})
    assert client.get("/api/pnp/placing").json()["top"]["offset"] is None
    response = client.post("/api/pnp/fiducials", json={"job": job_id})
    assert response.status_code == 200, response.text
    routine = routine_done(client, "/api/pnp/placing")
    assert routine["state"] == "done", routine
    found = references(client, job_id)
    assert set(found) == {"FID1", "FID2"} and all(entry["by"] == "fiducial" and entry["offset"] == list(DESIGNED) for entry in found.values())
    # Their places are the camera's under the file's offset: off the true
    # ones by how far that offset is wrong, the board's turn already right.
    for ref in ("FID1", "FID2"):
        true = true_place(places[ref])
        assert found[ref]["at"] == pytest.approx([true[0] - error[0], true[1] - error[1]], abs=0.01)
    parts = client.backend.job_parts(job_id)["components"]
    assert client.backend._board_fit(job_id, parts).rotation == pytest.approx(TRUE_TURN, abs=0.02)
    # The offset measured after: the fiducials are where they truly lie.
    client.put("/api/pnp/top", json={"offset": list(CAMERA_OFFSET)})
    found = references(client, job_id)
    for ref in ("FID1", "FID2"):
        assert found[ref]["at"] == pytest.approx(list(true_place(places[ref])), abs=0.01)
    # And the nozzle goes to a part's true place.
    client.post("/api/pnp/goto", json={"job": job_id, "ref": "R2"})
    assert client.fake.position[:2] == pytest.approx(true_place(places["R2"]), abs=0.01)
