"""A placement run on a G-code machine as the cameras and the vacuum
sensor steer it: the machine file's words, the plan they make, and runs
against a fake machine with an up camera, a top camera and a vacuum
sensor."""

from __future__ import annotations

import math
import re
import time
from dataclasses import replace

import pytest
from device_fakes import BoardTopCamera, DeviceTopCamera, DeviceUpCamera, FakeMarlin, LaggingUpCamera, SeenBoard, turn, wait_for
from fastapi.testclient import TestClient
from gcode_rig import connect, gcode_file, rig_backend

from spinny_laser.machines import MachineError
from spinny_web.app import create_app
from spinny_web import boardlook
from spinny_web import camera as camera_module
from spinny_web.camera import picture_to_machine
from spinny_web.jobs import Design, Group, Job
from spinny_web.openpnp import MARKS_NOTE, POCKET_NOTE, board_fit, plan, tip_shift, wrap
from spinny_web.openpnp import parse as parse_file
from spinny_web.pnp import fit_circle, footprints_of, picture_angle_to_machine

BASE = """name = "rig"
[port]
url = "socket://127.0.0.1:9"
wait_ms = 0
timeout = 2
[gcode]
init = ["G21", "G90"]
{gcode}
[motion]
feed_xy = 3000
feed_z = 600
safe_z = 5
place_z = -1
pick_dwell_ms = 0
place_dwell_ms = 0
{motion}
[[feeder]]
id = "res"
match = "10k"
at = [10.0, 20.0, -2.0]
pitch = [4.0, 0.0]
count = 10
{feeder}
{rest}
"""


def profile(gcode: str = "", motion: str = "", feeder: str = "", rest: str = "") -> str:
    return BASE.format(gcode=gcode, motion=motion, feeder=feeder, rest=rest)


def parse(text: str, machine_id: str):
    """A profile as the tests write it, read as the G-code machine file it makes."""
    return parse_file(gcode_file(text), machine_id)


VACUUM = '[vacuum]\nread = "M105"\npart_on = [50, 100]\npart_off = [0, 10]\n'
CAMERA = "[camera]\nz = -4\n"
TOP = '[top_camera]\nz = 0\noffset = [34.0, -9.0]\nfiducial = "bright"\nwithin = 2\n'


def part(ref: str, x: float, y: float, rotation: float = 0.0, **extra) -> dict:
    return {"ref": ref, "value": "10k", "footprint": "R_0603", "side": "front", "x": x, "y": y, "rotation": rotation, "dnp": False, **extra}


# --- the machine file's words -------------------------------------------------------


def test_the_vacuum_reads_with_marlins_pattern_or_openpnps_named_group():
    device = parse(profile(rest=VACUUM), "rig")
    assert device.vacuum is not None and device.vacuum.part_on == (50.0, 100.0) and device.vacuum.part_off == (0.0, 10.0)
    assert device.vacuum.reading(["ok T:73.50 /0.00 B:0.00 /0.00 @:0 B@:0"]) == 73.5
    assert device.vacuum.reading(["ok"]) is None
    java = parse(profile(rest='[vacuum]\nread = "M105"\npattern = "P:(?<Value>-?\\\\d+)"\npart_on = [1, 2]\n'), "rig")
    assert java.vacuum is not None and java.vacuum.reading(["echo: T:5 P:42"]) == 42.0



def test_a_sensor_without_ranges_is_read_by_hand_only_and_reads_over_several_lines():
    # The LumenPnP reads its sensor through an I2C mux: three lines, the
    # reading in the last one's answer, as OpenPnP's pattern has it.
    rest = '[vacuum]\nread = ["M260 A112 B1 S1", "M260 A109 B6 S1", "M261 A109 B1 S2"]\npattern = "^.*data:(?<Value>.*)"\n'
    device = parse(profile(rest=rest), "rig")
    assert device.vacuum is not None and device.vacuum.read[-1] == "M261 A109 B1 S2"
    assert device.vacuum.part_on is None and device.vacuum.reading(["echo:i2c-reply: from:109 bytes:1 data:231", "ok"]) == 231.0
    program = plan(device, [part("R1", 1.0, 0.0)], board_fit([((0.0, 0.0), (0.0, 0.0))], 0.0), {})
    # No range, no check: the program reads nothing.
    assert not any("M261" in line for line in program.text().splitlines())


@pytest.mark.parametrize(
    "text, words",
    [
        (profile(rest='[vacuum]\npart_on = [1, 2]\n'), "[vacuum] read must name the line, or lines, that read the vacuum sensor"),
        (profile(rest='[vacuum]\nread = "M105"\npattern = "T:[0-9]+"\npart_on = [1, 2]\n'), "[vacuum] pattern must hold a group"),
        (profile(rest='[vacuum]\nread = "M105"\npattern = "T:("\npart_on = [1, 2]\n'), "[vacuum] pattern is not a regular expression"),
        (profile(rest='[vacuum]\nread = "M105"\npart_on = [9, 2]\n'), "must be the low reading, then the high one"),
        (profile(feeder='pocket = "bright"'), "[feeder 1] pocket looks with the top camera: add a [top_camera] table"),
        (profile(feeder="marks = [[1, 2], [3, 4], [5, 6]]", rest=TOP), "[feeder 1] marks must be a list of at most 2 places"),
        (profile(feeder="size = [1.6, -1]"), "[feeder 1] size must be a length and a width over 0"),
        (profile(feeder='pocket = "grey"', rest=TOP), "[feeder 1] pocket must be dark or bright"),
        (profile(motion="pick_tries = 0"), "[motion] pick_tries must be a whole number from 1 to 20"),
        (profile(rest='[top_camera]\nfiducial = "red"\n'), "[top_camera] fiducial must be dark or bright"),
        (profile(rest="[top_camera]\nroll = 400\n"), "[top_camera] roll must be a number from -360 to 360"),
    ],
)
def test_a_new_word_that_does_not_read_names_its_key(text, words):
    with pytest.raises(MachineError) as error:
        parse(text, "rig")
    assert words in str(error.value)


def test_the_plan_reads_the_vacuum_turns_the_other_way_and_keeps_the_tip_on_the_place():
    fit = board_fit([((0.0, 0.0), (100.0, 50.0))], 90.0)
    parts = [part("R1", 1.0, 0.0), part("FID1", 0.0, 0.0, fiducial=True)]
    device = parse(profile(gcode="rotation_cw = true", rest=VACUUM), "rig")
    program = plan(device, parts, fit, {}, runout=(0.1, 0.0))
    (r1,) = program.blocks
    assert program.skipped == []
    assert r1.check == ["M400", "M105 ; vacuum: a part held reads 50 to 100"]
    assert r1.release == ["M400", "M105 ; vacuum: an empty nozzle reads 0 to 10"]
    # Turned 90 counterclockwise; the axis turns clockwise for a positive A.
    assert r1.turn == pytest.approx(90.0) and "G0 X10 Y20 A0 F3000" in r1.pick
    # The tip runs 0.1 mm along +X off the axis at 0: at 90 it is 0.1 along
    # +Y, so the head goes 0.1 along +X and 0.1 along -Y of the place.
    assert r1.target == pytest.approx((100.0, 51.0)) and r1.place[0] == "G0 X100.1 Y50.9 A-90 F3000"
    assert tip_shift((0.1, 0.0), 90.0) == pytest.approx((0.1, -0.1))
    # A fiducial is no part: it is named only when asked for.
    asked = plan(device, parts, fit, {}, refs=["FID1"])
    assert asked.blocks == [] and asked.skipped == [{"ref": "FID1", "reason": "a fiducial, not a part"}]
    text = program.text()
    assert "M105 ; vacuum: a part held reads 50 to 100" in text and program.summary()["lines"] == text.count("\n") - 2


def test_the_plan_says_where_the_top_camera_looks_first():
    device = parse(profile(feeder='pocket = "bright"\nmarks = [[8.0, 18.0]]', rest=TOP), "rig")
    fit = board_fit([((0.0, 0.0), (100.0, 50.0))], 0.0)
    program = plan(device, [part("R1", 1.0, 0.0), part("R2", 2.0, 0.0)], fit, {})
    first, second = program.blocks
    assert first.pick[:3] == ["; R1 10k from res #1", MARKS_NOTE, POCKET_NOTE] and second.pick[1] == POCKET_NOTE


# --- the geometry --------------------------------------------------------------------


def test_a_circle_is_fitted_through_points_and_an_angle_seen_is_turned_to_the_machines():
    center, radius, rms = fit_circle([(1.0 + 0.2 * math.cos(a), -2.0 + 0.2 * math.sin(a)) for a in (0.1, 1.2, 2.0, 3.3, 4.4, 5.9)])
    assert center == pytest.approx((1.0, -2.0)) and radius == pytest.approx(0.2) and rms < 1e-9
    # Mirrored and rolled, as the up camera sees: an angle and a move agree.
    for degrees in (-80.0, -10.0, 0.0, 33.0, 89.0):
        mx, my = picture_to_machine(math.cos(math.radians(degrees)), math.sin(math.radians(degrees)), 1.0, 7.0, True)
        assert picture_angle_to_machine(degrees, 7.0, True) == pytest.approx(math.degrees(math.atan2(my, mx)))
    assert wrap(46.0, 90.0) == -44.0 and wrap(-45.0, 90.0) == 45.0 and wrap(91.0, 90.0) == pytest.approx(1.0)


def test_a_board_file_gives_its_fiducials_whatever_their_flags_and_its_parts_bodies():
    footprints = footprints_of(BOARD)
    by_ref = {footprint.ref: footprint for footprint in footprints}
    assert set(by_ref) == {"FID1", "FID2", "R1", "R2"}
    assert by_ref["FID1"].fiducial and by_ref["FID1"].diameter == 1.0 and not by_ref["R1"].fiducial
    assert by_ref["R1"].body == (1.6, 0.8) and by_ref["R2"].body is None


# --- runs on a fake machine --------------------------------------------------------------

BOARD = """(kicad_pcb
\t(footprint "Fiducial:Fiducial_1mm_Mask2mm"
\t\t(layer "F.Cu")
\t\t(at 95 -60)
\t\t(property "Reference" "FID1")
\t\t(property "Value" "Fiducial")
\t\t(attr smd exclude_from_pos_files exclude_from_bom)
\t\t(pad "" smd circle (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask"))
\t)
\t(footprint "Fiducial:Fiducial_1mm_Mask2mm"
\t\t(layer "F.Cu")
\t\t(at 135 -80)
\t\t(property "Reference" "FID2")
\t\t(property "Value" "Fiducial")
\t\t(attr smd exclude_from_pos_files exclude_from_bom)
\t\t(pad "" smd circle (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask"))
\t)
\t(footprint "Resistor_SMD:R_0603_1608Metric"
\t\t(layer "F.Cu")
\t\t(at 101 -70)
\t\t(property "Reference" "R1")
\t\t(property "Value" "10k")
\t\t(attr smd)
\t\t(fp_line (start -0.8 -0.4) (end 0.8 -0.4) (stroke (width 0.1) (type solid)) (layer "F.Fab"))
\t\t(fp_line (start 0.8 -0.4) (end 0.8 0.4) (stroke (width 0.1) (type solid)) (layer "F.Fab"))
\t\t(fp_line (start 0.8 0.4) (end -0.8 0.4) (stroke (width 0.1) (type solid)) (layer "F.Fab"))
\t\t(fp_line (start -0.8 0.4) (end -0.8 -0.4) (stroke (width 0.1) (type solid)) (layer "F.Fab"))
\t\t(fp_line (start -1.5 -0.7) (end 1.5 0.7) (stroke (width 0.05) (type solid)) (layer "F.CrtYd"))
\t)
\t(footprint "Resistor_SMD:R_0603_1608Metric"
\t\t(layer "F.Cu")
\t\t(at 111 -70)
\t\t(property "Reference" "R2")
\t\t(property "Value" "10k")
\t\t(attr smd)
\t)
)
"""


@pytest.fixture
def client(tmp_path):
    fake = FakeMarlin(position=(100.0, 50.0, 0.0))
    backend = rig_backend(tmp_path, {}, lambda url, baud: fake)
    app = create_app(backend, frontend=tmp_path / "no-dist")
    with TestClient(app) as client:
        client.backend = backend
        client.fake = fake
        yield client


def rig(client, text: str) -> str:
    """The machine file saved, the machine connected, a board job added: its id."""
    (client.backend.machine_store.directory / "rig.toml").write_text(gcode_file(text), encoding="utf-8")
    connect(client, "rig")
    job = Job(name="board", source="kicad", groups=[Group(label="g", paths=[[(0.0, 0.0), (1.0, 0.0)]])], design=Design(shift=(-100.0, -70.0), rotation=0.0, board=True))
    client.backend.store.add(job)
    client.backend.store.keep_board(job.id, BOARD.encode())
    return job.id


def run(client, body: dict) -> dict:
    """A run sent and waited out: the placing state after it."""
    response = client.post("/api/pnp/run", json=body)
    assert response.status_code == 200, response.text
    wait_for(lambda: not client.get("/api/pnp/placing").json()["running"])
    return client.get("/api/pnp/placing").json()


def routine_done(client, path: str = "/api/pnp") -> dict:
    """Waits out a camera routine: its progress when it ended."""
    if path == "/api/pnp":
        wait_for(lambda: client.get(path).json()["routine"]["state"] != "running")
        return client.get(path).json()["routine"]
    wait_for(lambda: client.get(path).json()["top"]["routine"]["state"] != "running")
    return client.get(path).json()["top"]["routine"]


def moves(lines: list[str]) -> list[tuple[float, float]]:
    """The X Y of every move across."""
    found = []
    for line in lines:
        x = re.search(r"\bX(-?[\d.]+)", line)
        y = re.search(r"\bY(-?[\d.]+)", line)
        if line.startswith("G0 ") and x and y:
            found.append((float(x.group(1)), float(y.group(1))))
    return found


def test_a_pick_the_vacuum_finds_empty_is_let_go_at_the_discard_place_and_the_next_pocket_taken(client):
    job_id = rig(client, profile(motion="discard = [0.0, 0.0, -1.5]", rest=VACUUM))
    client.post("/api/pnp/references", json={"job": job_id, "ref": "R1", "at": [100.0, 50.0]})
    # The first pick holds nothing (and the nozzle reads empty once let go
    # at the discard place), the second a part, which lets go.
    client.fake.readings = [20.0, 5.0, 80.0, 5.0]
    before = len(client.fake.lines)
    state = run(client, {"job": job_id, "refs": ["R1"]})
    assert state["progress"]["state"] == "done", state["progress"]
    assert state["progress"]["placed"] == ["R1"] and state["progress"]["failed"] == [] and state["taken"] == {"res": 2}
    sent = client.fake.lines[before:]
    across = moves(sent)
    # Pocket 1, the discard place, pocket 2, the place.
    assert across == [(10.0, 20.0), (0.0, 0.0), (14.0, 20.0), (100.0, 50.0)]
    assert sent.count("M105") == 4 and "G0 Z-1.5 F600" in sent
    assert state["progress"]["sent"] == state["progress"]["total"]


def test_the_files_top_camera_roll_places_its_pictures_until_a_scale_is_measured(client):
    rig(client, profile(rest=TOP + "roll = 180\n"))
    machine = client.backend.placing_machine()
    assert machine.top is not None and machine.top.roll == 180.0
    # The page reads it with the file, for the picture's Upright.
    assert client.get("/api/pnp/placing").json()["document"]["top"]["roll"] == 180.0
    assert client.backend._top_roll(machine) == 180.0
    assert client.backend._top_picture(machine)["roll"] == 180.0
    # Measured (Measure offset sets the scale and the roll together), the measured one wins.
    assert client.put("/api/pnp/top", json={"mm_per_px": 0.02, "roll": 1.5}).status_code == 200
    assert client.backend._top_roll(machine) == 1.5
    # A file without one leaves the settings' roll.
    assert parse(profile(rest=TOP), "rig").top.roll is None


def test_the_files_camera_settings_go_into_the_cameras_as_the_machine_connects(client):
    # The page set its own before: what the file leaves out stays.
    assert client.put("/api/pnp/settings", json={"device": "/dev/video7", "fps": 15}).status_code == 200
    top = TOP + 'device = "http://127.0.0.1:2329/snapshot"\nsize = "640x480"\nmark_spot = "bright"\n'
    up = CAMERA + 'device = "http://127.0.0.1:2328/snapshot"\nsize = "640x480"\nnozzle_spot = "bright"\n'
    rig(client, profile(rest=top + up))
    machine = client.backend.placing_machine()
    assert machine.top is not None and machine.top.settings == {"device": "http://127.0.0.1:2329/snapshot", "size": "640x480", "mark_spot": "bright"}
    assert machine.camera_settings == {"device": "http://127.0.0.1:2328/snapshot", "size": "640x480", "nozzle_spot": "bright"}
    taken = client.backend.top.settings()
    assert (taken.device, taken.size, taken.mark_spot) == ("http://127.0.0.1:2329/snapshot", "640x480", "bright")
    bottom = client.get("/api/pnp").json()
    assert (bottom["device"], bottom["size"], bottom["nozzle_spot"], bottom["fps"]) == ("http://127.0.0.1:2328/snapshot", "640x480", "bright", 15)
    document = client.get("/api/pnp/placing").json()["document"]
    assert document["top"]["settings"]["device"] == "http://127.0.0.1:2329/snapshot" and document["camera_settings"]["size"] == "640x480"
    # Each key is checked as the camera's settings check it.
    for rest, words in (
        (CAMERA + 'size = "big"\n', "[up_camera] size must be WIDTHxHEIGHT"),
        (CAMERA + "fps = 500\n", "[up_camera] fps must be a whole number from 1 to 120"),
        (TOP + 'device = ""\n', "[top_camera] device must name it"),
        (TOP + 'mark_spot = "grey"\n', "[top_camera] mark_spot must be dark or bright"),
    ):
        with pytest.raises(MachineError) as error:
            parse(profile(rest=rest), "rig")
        assert words in str(error.value)


def test_a_g_code_machine_connected_or_made_the_one_in_use_is_the_one_placed_with(client):
    rig(client, profile())
    listed = client.get("/api/machines").json()
    assert listed["current"] == "rig" and listed["used"] == "rig"
    (client.backend.machine_store.directory / "other.toml").write_text(gcode_file(profile()), encoding="utf-8")
    assert client.post("/api/disconnect").status_code == 200
    listed = client.post("/api/machines/other/use").json()
    assert listed["used"] == "other" and listed["current"] is None
    assert client.get("/api/pnp/placing").json()["machine"] == "other"


def test_the_files_bottom_camera_roll_and_mirror_stand_until_centering_measures_them(client):
    rig(client, profile(rest=CAMERA + "position = [150.0, 30.0]\nroll = 90\nmirror = false\n"))
    machine = client.backend.placing_machine()
    assert machine.camera_roll == 90.0 and machine.camera_mirror is False
    document = client.get("/api/pnp/placing").json()
    assert document["document"]["camera_roll"] == 90.0 and document["document"]["camera_mirror"] is False
    # Not measured: the place the routines and the picture's Upright take is the file's.
    assert document["camera"]["roll"] == 90.0 and document["camera"]["mirror"] is False
    # A place set by hand keeps no scale, so the file's roll still stands.
    assert client.put("/api/pnp/camera", json={"position": [151.0, 31.0]}).status_code == 200
    assert client.get("/api/pnp/placing").json()["camera"]["roll"] == 90.0
    # Measured (Center nozzle keeps the scale, roll and mirror together), the measured ones win.
    client.backend._keep_up_place(replace(client.backend._up_place(machine), mm_per_px=0.02, roll=1.5, mirror=True))
    camera = client.get("/api/pnp/placing").json()["camera"]
    assert camera["roll"] == 1.5 and camera["mirror"] is True
    # A file without them leaves a camera looking up mirrored, at roll 0.
    plain = parse(profile(rest=CAMERA), "rig")
    assert plain.camera_roll is None and plain.camera_mirror is None
    with pytest.raises(MachineError, match=r"\[up_camera\] roll must be a number from -360 to 360"):
        parse(profile(rest=CAMERA + "roll = 400\n"), "rig")
    with pytest.raises(MachineError, match=r"\[up_camera\] mirror must be true or false"):
        parse(profile(rest=CAMERA + 'mirror = "yes"\n'), "rig")


def test_the_parts_a_run_places_are_told_to_the_top_cameras_look_for_that_board(client):
    job_id = rig(client, profile(rest=VACUUM))
    client.post("/api/pnp/references", json={"job": job_id, "ref": "R1", "at": [100.0, 50.0]})
    client.fake.readings = [80.0, 5.0]
    told = BoardTopCamera(client.fake, (34.0, -9.0), SeenBoard((0.0, 0.0, 40.0, 30.0), 0.0, (150.0, 80.0)))
    backend = client.backend
    backend.top.client = told
    # The top camera looks for this job's board (as Look for board leaves it).
    backend.top_look.job = job_id
    backend._board_placed[job_id] = ["R9"]
    state = run(client, {"job": job_id, "refs": ["R1"]})
    assert state["progress"]["placed"] == ["R1"]
    # The run's board starts bare, then has each part placed.
    assert told.assemblies == [{"paste": False, "placed": []}, {"paste": False, "placed": ["R1"]}]
    assert backend._board_placed[job_id] == ["R1"]
    backend.top_look.job = None


def test_a_part_that_stays_on_the_nozzle_stops_the_run(client):
    job_id = rig(client, profile(rest=VACUUM))
    client.post("/api/pnp/references", json={"job": job_id, "ref": "R1", "at": [100.0, 50.0]})
    client.fake.readings = [80.0, 60.0]
    state = run(client, {"job": job_id, "refs": ["R1", "R2"]})
    assert state["progress"]["state"] == "error" and "may still be on the nozzle" in state["progress"]["error"]
    assert state["progress"]["placed"] == [] and state["taken"] == {"res": 1}


def test_a_part_still_on_the_nozzle_after_a_discard_stops_the_run(client):
    job_id = rig(client, profile(rest=VACUUM))
    client.post("/api/pnp/references", json={"job": job_id, "ref": "R1", "at": [100.0, 50.0]})
    # A pick read as failed whose part then will not let go.
    client.fake.readings = [20.0, 60.0]
    state = run(client, {"job": job_id, "refs": ["R1"]})
    assert state["progress"]["state"] == "error"
    assert "after a part was put back in its pocket" in state["progress"]["error"] and "may still be on the nozzle" in state["progress"]["error"]


def test_parts_of_a_feeder_that_ran_out_are_left_out_and_the_run_goes_on(client):
    # A strip of two: the first pick fails, the second places R1, and R2
    # finds the strip empty, which is no setup fault.
    job_id = rig(client, profile(rest=VACUUM).replace("count = 10", "count = 2"))
    client.post("/api/pnp/references", json={"job": job_id, "ref": "R1", "at": [100.0, 50.0]})
    client.fake.readings = [20.0, 5.0, 80.0, 5.0]
    state = run(client, {"job": job_id})
    progress = state["progress"]
    assert progress["state"] == "done" and progress["placed"] == ["R1"]
    assert progress["failed"] == [{"ref": "R2", "reason": "feeder res is empty"}]


def test_two_parts_in_a_row_left_out_stop_the_run(client):
    job_id = rig(client, profile(rest=VACUUM))
    client.post("/api/pnp/references", json={"job": job_id, "ref": "R1", "at": [100.0, 50.0]})
    # Every pick holds nothing; each let go reads empty.
    client.fake.readings = [20.0, 5.0] * 6
    state = run(client, {"job": job_id})
    progress = state["progress"]
    assert progress["state"] == "error" and "2 parts in a row were left out" in progress["error"]
    assert [entry["ref"] for entry in progress["failed"]] == ["R1", "R2"] and "the vacuum read 20" in progress["failed"][0]["reason"]
    # Three tries each, every one put back in its pocket.
    assert state["taken"] == {"res": 6} and client.fake.lines.count("M107") == 6


VISION = profile(feeder="vision = true\nsize = [1.6, 0.8]", rest=CAMERA)


def centered(client, camera: DeviceUpCamera) -> None:
    """The nozzle jogged near the up camera and centered over it."""
    client.backend.pnp.client = camera
    client.put("/api/pnp/settings", json={"part_spot": "bright"})
    client.post("/api/command", json={"line": f"G0 X{camera.where[0] + 0.4} Y{camera.where[1] - 0.3}"})
    response = client.post("/api/pnp/nozzle", json={"step": 1.0})
    assert response.status_code == 200, response.text
    assert routine_done(client)["state"] == "done"


def test_a_camera_whose_pictures_lag_the_moves_is_waited_for(client, monkeypatch):
    rig(client, VISION)
    camera = LaggingUpCamera(client.fake, where=(150.0, 30.0), roll=3.0, mirror=True, lag=0.08, period=0.04)
    client.backend.pnp.client = camera
    client.post("/api/command", json={"line": "G0 X150.4 Y29.7"})
    # Looked at the moment each move ends, the picture still shows the
    # nozzle where it was: the measure refuses what it sees.
    time.sleep(0.2)
    assert client.post("/api/pnp/nozzle", json={"step": 1.0}).status_code == 200
    routine = routine_done(client)
    assert routine["state"] == "error" and ("did not move" in routine["error"] or "lagged a move" in routine["error"]), routine
    # Each look waits for a picture taken after the head came to rest.
    monkeypatch.setattr(camera_module, "SETTLE_SECONDS", 0.15)
    client.post("/api/command", json={"line": "G0 X150.4 Y29.7"})
    time.sleep(0.2)
    assert client.post("/api/pnp/nozzle", json={"step": 1.0}).status_code == 200
    routine = routine_done(client)
    assert routine["state"] == "done", routine
    assert client.get("/api/pnp/placing").json()["camera"]["position"] == pytest.approx([150.0, 30.0], abs=0.005)
    # The spot the routine saw last is kept with its shape for the page to draw.
    assert {"x", "y", "major", "minor"} <= set(routine["spot"])
    camera.close()


def test_a_look_once_finds_the_spot_without_a_move_and_keeps_its_shape(client):
    rig(client, VISION)
    camera = DeviceUpCamera(client.fake, where=(150.0, 30.0), roll=0.0, mirror=True)
    client.backend.pnp.client = camera
    client.post("/api/command", json={"line": "G0 X150.5 Y30"})
    sent = len(client.fake.lines)
    response = client.post("/api/pnp/look", json={"spot": "nozzle"})
    assert response.status_code == 200, response.text
    look = response.json()["look"]
    assert look["found"] is True and look["polarity"] == "dark" and look["dx"] == pytest.approx(-50.0, abs=0.01)
    assert len(client.fake.lines) == sent
    # Far off, nothing: said, not refused.
    client.post("/api/command", json={"line": "G0 X160 Y30"})
    assert client.post("/api/pnp/look", json={"spot": "part"}).json()["look"] == {"found": False, "polarity": "dark", "radius": None}
    # Within a part class's crop, in px of the picture: kept with the look.
    assert client.post("/api/pnp/look", json={"spot": "part", "radius": 60.0}).json()["look"]["radius"] == 60.0
    assert client.post("/api/pnp/look", json={"spot": "part", "radius": 0}).status_code == 422


def test_the_runout_is_measured_over_the_up_camera_and_a_reversed_axis_named(client):
    rig(client, VISION)
    camera = DeviceUpCamera(client.fake, where=(150.0, 30.0), roll=3.0, mirror=True, runout=(0.08, -0.03))
    centered(client, camera)
    # Centered at 0, the tip (not the axis) is over the picture's center.
    assert client.get("/api/pnp/placing").json()["camera"]["position"] == pytest.approx([149.92, 30.03], abs=0.005)
    assert client.post("/api/pnp/runout").status_code == 200
    routine = routine_done(client)
    assert routine["state"] == "done", routine
    kept = client.get("/api/pnp/placing").json()["camera"]
    assert kept["runout"] == pytest.approx([0.08, -0.03], abs=0.003) and kept["position"] == pytest.approx([149.92, 30.03], abs=0.005)
    # The nozzle is back at 0, and a center again keeps the runout.
    assert client.fake.angle == 0.0
    centered(client, camera)
    assert client.get("/api/pnp/placing").json()["camera"]["runout"] == pytest.approx([0.08, -0.03], abs=0.003)
    # An axis wired the other way: the tip goes round clockwise.
    camera.cw = True
    client.post("/api/pnp/runout")
    routine = routine_done(client)
    assert routine["state"] == "error" and "rotation_cw = true" in routine["error"]


def test_a_part_turned_off_its_angle_is_corrected_and_lands_on_its_place(client):
    job_id = rig(client, VISION)
    # The part sits 3 degrees off in the feeder and 0.1, 0.05 off the tip,
    # which runs 0.05 off the axis.
    camera = DeviceUpCamera(client.fake, where=(150.0, 30.0), roll=-2.0, mirror=True, runout=(0.05, 0.0), part=(0.1, 0.05), part_angle=3.0, rect=True)
    centered(client, camera)
    client.post("/api/pnp/runout")
    assert routine_done(client)["state"] == "done"
    # The board turned 30 degrees on the device: R1 goes down at 30.
    client.put("/api/pnp/placing", json={"angle": 30.0})
    client.post("/api/pnp/references", json={"job": job_id, "ref": "R1", "at": [100.0, 50.0]})
    before = len(client.fake.lines)
    state = run(client, {"job": job_id, "refs": ["R1"]})
    assert state["progress"]["state"] == "done", state["progress"]
    sent = client.fake.lines[before:]
    # Looked at turned to 30, then to 27 once seen 3 off.
    assert "G0 A30 F3000" in sent and "G0 A27 F3000" in sent
    place = next(line for line in sent if line.startswith("G0 X") and " A27 " in line)
    head = (float(re.search(r"X(-?[\d.]+)", place).group(1)), float(re.search(r"Y(-?[\d.]+)", place).group(1)))
    # Where the part's center lands, as a place of the tip at 0: the head,
    # plus the tip's and part's arm turned to 27, less the tip's at 0.
    arm = turn((0.05 + 0.1, 0.0 + 0.05), 27.0)
    landed = (head[0] + arm[0] - 0.05, head[1] + arm[1] - 0.0)
    assert landed == pytest.approx((100.0, 50.0), abs=0.003)
    seen = client.get("/api/pnp").json()["part_offset"]
    assert seen["angle"] is not None and seen["length"] == pytest.approx(1.6, abs=0.01)


def test_a_nozzle_turning_the_other_way_leaves_parts_out_and_says_why(client):
    job_id = rig(client, VISION)
    camera = DeviceUpCamera(client.fake, where=(150.0, 30.0), roll=0.0, mirror=True, part_angle=3.0, rect=True, cw=True)
    centered(client, camera)
    client.put("/api/pnp/placing", json={"angle": 30.0})
    client.post("/api/pnp/references", json={"job": job_id, "ref": "R1", "at": [100.0, 50.0]})
    state = run(client, {"job": job_id, "refs": ["R1"]})
    (failed,) = state["progress"]["failed"]
    assert "degrees off its angle" in failed["reason"] and "check [gcode] rotation_cw" in failed["reason"]


def test_a_part_of_the_wrong_size_is_put_back_and_left_out(client):
    job_id = rig(client, VISION)
    camera = DeviceUpCamera(client.fake, where=(150.0, 30.0), roll=0.0, mirror=True, size=(2.0, 1.25), rect=True)
    centered(client, camera)
    client.post("/api/pnp/references", json={"job": job_id, "ref": "R1", "at": [100.0, 50.0]})
    state = run(client, {"job": job_id, "refs": ["R1"]})
    assert state["progress"]["state"] == "done" and state["progress"]["placed"] == []
    (failed,) = state["progress"]["failed"]
    assert failed["ref"] == "R1" and "it looks 2.00 x 1.25 mm, not 1.60 x 0.80" in failed["reason"]
    assert state["taken"] == {"res": 3}


# --- the top camera ----------------------------------------------------------------------

# Where the board truly lies on the device: turned 0.6 degrees and shifted.
TRUE_TURN = 0.6
TRUE_SHIFT = (100.3, 49.8)
CAMERA_OFFSET = (35.0, -10.0)


def true_place(point):
    x, y = turn(point, TRUE_TURN)
    return (x + TRUE_SHIFT[0], y + TRUE_SHIFT[1])


def job_places(client, job_id: str) -> dict:
    return {entry["ref"]: (entry["x"], entry["y"]) for entry in client.get(f"/api/jobs/{job_id}/components").json()["components"]}


def with_top_camera(client, job_id: str, extra=()) -> DeviceTopCamera:
    places = job_places(client, job_id)
    things = [("dark", 120.0, 80.0, 1.0, 1.0)]
    things += [("bright", *true_place(places[ref]), 1.0, 1.0) for ref in ("FID1", "FID2")]
    camera = DeviceTopCamera(client.fake, CAMERA_OFFSET, [*things, *extra])
    client.backend.top.client = camera
    return camera


def measured_offset(client) -> None:
    """The nozzle over the mark, Nozzle on mark, Measure offset."""
    client.post("/api/command", json={"line": "G0 X120 Y80"})
    assert client.post("/api/pnp/top/mark").json()["top"]["mark_at"] == [120.0, 80.0]
    response = client.post("/api/pnp/top/offset", json={"step": 1.0})
    assert response.status_code == 200, response.text
    routine = routine_done(client, "/api/pnp/placing")
    assert routine["state"] == "done", routine


def test_the_top_camera_looks_once_for_its_mark_spot(client):
    # The route once called the board look (an attribute of the same name)
    # instead of Look once, and answered 500.
    rig(client, profile(rest=TOP))
    camera = DeviceTopCamera(client.fake, CAMERA_OFFSET, [("dark", 120.0 + CAMERA_OFFSET[0], 80.0 + CAMERA_OFFSET[1], 1.0, 1.0)])
    client.backend.top.client = camera
    client.post("/api/command", json={"line": "G0 X120 Y80"})
    response = client.post("/api/pnp/top/look")
    assert response.status_code == 200, response.text
    look = response.json()["top"]["look"]
    assert look is not None and (look.get("spot") or look).get("found") is True


def test_the_top_camera_measures_its_offset_and_finds_the_fiducials(client):
    job_id = rig(client, profile(rest=TOP))
    with_top_camera(client, job_id)
    measured_offset(client)
    top = client.get("/api/pnp/placing").json()["top"]
    assert top["offset"] == pytest.approx(list(CAMERA_OFFSET), abs=0.01)
    assert top["mm_per_px"] == pytest.approx(0.02, rel=0.01) and top["roll"] == pytest.approx(1.5, abs=0.1) and top["mirror"] is False
    places = job_places(client, job_id)
    # A rough reference by hand, 0.5 mm off, the board's turn unknown.
    rough = true_place(places["R1"])
    client.post("/api/pnp/references", json={"job": job_id, "ref": "R1", "at": [rough[0] + 0.4, rough[1] - 0.3]})
    response = client.post("/api/pnp/fiducials", json={"job": job_id})
    assert response.status_code == 200, response.text
    routine = routine_done(client, "/api/pnp/placing")
    assert routine["state"] == "done", routine
    state = client.get("/api/pnp/placing").json()
    found = {entry["ref"]: entry for entry in state["references"]}
    # Two fiducials outdo the reference by hand.
    assert set(found) == {"FID1", "FID2"} and all(entry["by"] == "fiducial" for entry in found.values())
    for ref in ("FID1", "FID2"):
        assert found[ref]["at"] == pytest.approx(list(true_place(places[ref])), abs=0.01)
    planned = client.post("/api/pnp/plan", json={"job": job_id, "refs": ["R1"]}).json()
    assert planned["fit"]["rotation"] == pytest.approx(TRUE_TURN, abs=0.02)
    assert state["top"]["fiducials"]["job"] == job_id
    # Go to part follows the fiducials: the nozzle over the part's true
    # place, or with the camera the head one camera offset short of it, so
    # the picture's center is on the part.
    client.post("/api/pnp/goto", json={"job": job_id, "ref": "R2"})
    assert client.fake.position[:2] == pytest.approx(true_place(places["R2"]), abs=0.01)
    client.post("/api/pnp/goto", json={"job": job_id, "ref": "R2", "camera": True})
    r2_true = true_place(places["R2"])
    assert client.fake.position[:2] == pytest.approx((r2_true[0] - CAMERA_OFFSET[0], r2_true[1] - CAMERA_OFFSET[1]), abs=0.01)
    # Camera here: the reference is where the camera's center is.
    client.post("/api/command", json={"line": f"G0 X{rough[0] - CAMERA_OFFSET[0]} Y{rough[1] - CAMERA_OFFSET[1]}"})
    state = client.post("/api/pnp/references", json={"job": job_id, "ref": "R2", "camera": True}).json()
    r2 = next(entry for entry in state["references"] if entry["ref"] == "R2")
    assert r2["at"] == pytest.approx(list(rough), abs=0.01) and r2["by"] == "camera"


def test_the_top_cameras_offset_and_fiducials_are_kept_at_once_logged_and_undone(client):
    job_id = rig(client, profile(rest=TOP))
    with_top_camera(client, job_id)
    client.post("/api/command", json={"line": "G0 X120 Y80"})
    client.post("/api/pnp/top/mark")
    assert client.post("/api/pnp/top/offset", json={"step": 1.0}).status_code == 200
    assert routine_done(client, "/api/pnp/placing")["state"] == "done"
    top = client.get("/api/pnp/placing").json()["top"]
    # Measured and kept, logged with the values before and the mark found.
    assert top["offset"] == pytest.approx(list(CAMERA_OFFSET), abs=0.01)
    entry = top["applied"]
    assert entry["kind"] == "offset" and entry["camera"] == "top" and "the top camera looks from" in entry["text"] and "dx" in entry["marks"]["spot"]
    changes = {change["name"]: change for change in entry["changes"]}
    assert changes["offset"]["before"] is None and changes["mm_per_px"]["before"] == 0.0 and entry["machine"] is not None
    # The fiducials found become references at once; Undo brings back the
    # reference by hand they replaced, and forgets the fiducials shown.
    rough = true_place(job_places(client, job_id)["R1"])
    client.post("/api/pnp/references", json={"job": job_id, "ref": "R1", "at": [rough[0] + 0.4, rough[1] - 0.3]})
    assert client.post("/api/pnp/fiducials", json={"job": job_id}).status_code == 200
    assert routine_done(client, "/api/pnp/placing")["state"] == "done"
    state = client.get("/api/pnp/placing").json()
    found = state["top"]["applied"]
    assert found["kind"] == "fiducials" and [point["label"] for point in found["marks"]["points"]] == ["FID1", "FID2"]
    assert "2 fiducials found" in found["text"]
    assert {entry["ref"] for entry in state["references"]} == {"FID1", "FID2"}
    [change] = found["changes"]
    assert change["target"] == "references" and change["name"] == job_id and [ref["ref"] for ref in change["before"]] == ["R1"]
    undone = client.post(f"/api/findings/{found['id']}/undo")
    assert undone.status_code == 200, undone.text
    state = undone.json()["state"]
    assert [entry["ref"] for entry in state["references"]] == ["R1"] and state["top"]["fiducials"] is None
    # The offset's undo takes the camera back to unmeasured.
    top = client.post(f"/api/findings/{entry['id']}/undo").json()["state"]["top"]
    assert top["offset"] is None and top["mm_per_px"] == 0.0
    assert top["applied"]["kind"] == "undo" and top["applied"]["undoes"] == entry["id"]
    log = client.get("/api/findings", params={"camera": "top"}).json()["entries"]
    assert [item["kind"] for item in log] == ["undo", "undo", "fiducials", "offset"]


def test_home_by_fiducial_homes_then_ties_the_numbers_to_the_bed(client):
    fiducial = (60.0, 170.0)
    job_id = rig(client, profile(rest=TOP + f"home_fiducial = [{fiducial[0]}, {fiducial[1]}]\n"))
    with_top_camera(client, job_id, extra=[("bright", *fiducial, 1.0, 1.0)])
    measured_offset(client)
    # The switches put the head 0.2, -0.15 mm off the place its numbers say.
    client.fake.home_place = (0.0, 0.0, 5.0)
    client.fake.home_error = (0.2, -0.15)
    before = len(client.fake.lines)
    response = client.post("/api/pnp/top/home")
    assert response.status_code == 200, response.text
    routine = routine_done(client, "/api/pnp/placing")
    assert routine["state"] == "done", routine
    sent = client.fake.lines[before:]
    assert sent[0] == "G28" and any(line.startswith("G92 X") for line in sent)
    # The numbers and the bed agree again, to the centering's tolerance.
    assert client.fake.bed_position[:2] == pytest.approx(client.fake.position[:2], abs=0.02)
    # Knocked 0.3 mm off later: found again from where the numbers are, no home.
    client.fake.origin[0] += 0.3
    before = len(client.fake.lines)
    assert client.post("/api/pnp/top/home", json={"home": False}).status_code == 200
    routine = routine_done(client, "/api/pnp/placing")
    # Looking and declaring: no homing step.
    assert routine["state"] == "done" and routine["total"] == 2, routine
    sent = client.fake.lines[before:]
    assert "G28" not in sent and any(line.startswith("G92 X") for line in sent)
    assert client.fake.bed_position[:2] == pytest.approx(client.fake.position[:2], abs=0.02)
    # A file without the fiducial says so.
    client.backend.machine_store.directory.joinpath("rig.toml").write_text(gcode_file(profile(rest=TOP)), encoding="utf-8")
    connect(client, "rig")
    refused = client.post("/api/pnp/top/home")
    assert refused.status_code == 400 and "home_fiducial" in refused.json()["detail"]


def test_a_run_finds_the_fiducials_first_and_places_on_them(client):
    job_id = rig(client, profile(rest=TOP))
    with_top_camera(client, job_id)
    measured_offset(client)
    places = job_places(client, job_id)
    rough = true_place(places["R1"])
    client.post("/api/pnp/references", json={"job": job_id, "ref": "R1", "at": [rough[0] - 0.6, rough[1] + 0.2]})
    before = len(client.fake.lines)
    state = run(client, {"job": job_id, "refs": ["R1"], "fiducials": True})
    assert state["progress"]["state"] == "done", state["progress"]
    place = moves(client.fake.lines[before:])[-1]
    assert place == pytest.approx(true_place(places["R1"]), abs=0.01)


def test_the_top_camera_finds_a_feeders_marks_passes_an_empty_pocket_and_picks_where_the_part_is(client):
    job_id = rig(client, profile(feeder='pocket = "bright"\nsize = [1.6, 0.8]\nmarks = [[8.0, 18.0], [48.0, 18.0]]', rest=TOP))
    # The feeder lies 0.5 mm along +X and 0.25 along -Y off its profile;
    # its first pocket is empty, the part in the second sits 0.1, 0.05 off.
    shift = (0.5, -0.25)
    extra = [("dark", 8.0 + shift[0], 18.0 + shift[1], 1.0, 1.0), ("dark", 48.0 + shift[0], 18.0 + shift[1], 1.0, 1.0)]
    extra.append(("bright", 14.0 + shift[0] + 0.1, 20.0 + shift[1] + 0.05, 1.6, 0.8))
    with_top_camera(client, job_id, extra)
    # The calibration mark stays out of the feeder's way.
    measured_offset(client)
    client.post("/api/pnp/references", json={"job": job_id, "ref": "R1", "at": [100.0, 50.0]})
    before = len(client.fake.lines)
    state = run(client, {"job": job_id, "refs": ["R1"]})
    assert state["progress"]["state"] == "done", state["progress"]
    assert state["progress"]["placed"] == ["R1"] and state["taken"] == {"res": 2}
    sent = client.fake.lines[before:]
    pick = next(line for line in sent if line.endswith(" A0 F3000") and line.startswith("G0 X1"))
    assert moves([pick])[0] == pytest.approx((14.6, 19.8), abs=0.01)


def test_a_run_that_looks_with_the_top_camera_needs_it_running(client):
    job_id = rig(client, profile(feeder='pocket = "bright"', rest=TOP))
    client.post("/api/pnp/references", json={"job": job_id, "ref": "R1", "at": [100.0, 50.0]})
    response = client.post("/api/pnp/run", json={"job": job_id, "refs": ["R1"]})
    assert response.status_code == 400 and "top camera is not running" in response.text
    response = client.post("/api/pnp/fiducials", json={"job": job_id})
    assert response.status_code == 400 and "offset is not measured" in response.text


def outlined_job(client) -> str:
    """A board job 40 by 30 mm in its frame, its KiCad file kept."""
    job = Job(
        name="outlined", source="kicad", groups=[Group(label="g", paths=[[(0.0, 0.0), (1.0, 0.0)]])],
        outline=[[(0.0, 0.0), (40.0, 0.0), (40.0, 30.0), (0.0, 30.0), (0.0, 0.0)]],
        design=Design(shift=(-100.0, -70.0), rotation=0.0, board=True),
    )
    client.backend.store.add(job)
    client.backend.store.keep_board(job.id, BOARD.encode())
    return job.id


@pytest.fixture
def quick_search(monkeypatch):
    """The fakes lock at once: a stop is looked at for a moment only."""
    monkeypatch.setattr(boardlook, "LOCK_SECONDS", 0.15)
    monkeypatch.setattr(boardlook, "STOP_SECONDS", 0.6)
    monkeypatch.setattr(boardlook, "SAMPLE_SECONDS", 0.01)


def test_the_top_camera_searches_a_box_for_the_board_and_keeps_its_place(client, quick_search):
    rig(client, profile(rest=TOP))
    job_id = outlined_job(client)
    board = SeenBoard((0.0, 0.0, 40.0, 30.0), 2.0, (150.0, 80.0), design_shift=(-100.0, -70.0))
    camera = BoardTopCamera(client.fake, (34.0, -9.0), board, roll=1.5)
    client.backend.top.client = camera
    client.put("/api/pnp/top", json={"offset": [34.0, -9.0], "mm_per_px": 0.02, "roll": 1.5, "mirror": False})
    assert client.post("/api/pnp/top/search", json={}).status_code == 400
    response = client.post("/api/pnp/top/board", json={"job": job_id})
    assert response.status_code == 200, response.text
    assert camera.loaded is not None and response.json()["top"]["board_look"]["job"] == job_id
    # Loaded with the camera's side and finish, its search kept within a
    # fifth of the scale measured, no paste and no part on the board.
    fields = camera.board_fields
    assert (fields["side"], fields["finish"], fields["paste"], fields["placed"]) == ("front", "masked", False, [])
    assert fields["scale"] == pytest.approx((0.016, 0.024))
    # The head far from the board: a box drawn over where it lies.
    response = client.post("/api/pnp/top/search", json={"box": [140.0, 70.0, 200.0, 125.0]})
    assert response.status_code == 200, response.text
    routine = routine_done(client, "/api/pnp/placing")
    assert routine["state"] == "done", routine
    look = client.get("/api/pnp/placing").json()["top"]["board_look"]
    middle = (150.0 + 20.0 * math.cos(math.radians(2.0)) - 15.0 * math.sin(math.radians(2.0)), 80.0 + 20.0 * math.sin(math.radians(2.0)) + 15.0 * math.cos(math.radians(2.0)))
    assert look["found"] is True and look["agree"] >= boardlook.NEED, look
    assert look["estimate"]["center"] == pytest.approx(list(middle), abs=0.01) and look["estimate"]["rotation"] == pytest.approx(2.0, abs=0.01)
    # It ended with the picture's center over the board's middle, and pcbv
    # was told to search afresh at every stop.
    assert (client.fake.position[0] + 34.0, client.fake.position[1] - 9.0) == pytest.approx(middle, abs=0.01)
    assert "reset" in camera.asked
    # Nothing told where the board was: no corners, no references, nothing
    # found before, and the job's own frame is not this machine's.
    assert look["known"] is None
    # Searched again, the place found is where it starts.
    assert client.post("/api/pnp/top/search", json={"box": [140.0, 70.0, 200.0, 125.0]}).status_code == 200
    assert routine_done(client, "/api/pnp/placing")["state"] == "done"
    known = client.get("/api/pnp/placing").json()["top"]["board_look"]["known"]
    assert known["source"] == "found" and known["center"] == pytest.approx(list(middle), abs=0.01) and known["guided"] == 0
    # The place found becomes the job's references: two parts, by look.
    response = client.post("/api/pnp/top/place", json={"job": job_id})
    assert response.status_code == 200, response.text
    refs = [entry for entry in response.json()["references"] if entry["job"] == job_id]
    assert len(refs) == 2 and {entry["by"] for entry in refs} == {"look"}
    parts = {part["ref"]: part for part in client.get(f"/api/jobs/{job_id}/components").json()["components"]}
    for entry in refs:
        part = parts[entry["ref"]]
        x, y = turn((part["x"], part["y"]), 2.0)
        assert entry["at"] == pytest.approx([x + 150.0, y + 80.0], abs=0.01)
    # Paste put on the board is told to pcbv as the board's assembly;
    # another side or finish is another model, loaded afresh.
    assert client.put("/api/pnp/top", json={"paste": True}).status_code == 200
    assert camera.assemblies[-1] == {"paste": True, "placed": []}
    assert client.put("/api/pnp/top", json={"side": "back", "finish": "bare"}).status_code == 200
    assert (camera.board_fields["side"], camera.board_fields["finish"], camera.board_fields["paste"]) == ("back", "bare", True)
    assert client.put("/api/pnp/top", json={"side": "top"}).status_code == 400
    # Unloaded, the look is forgotten; its settings stay.
    unloaded = client.post("/api/pnp/top/board", json={"job": None}).json()["top"]["board_look"]
    # The searches' map (their stops' pictures) is kept while the backend runs.
    assert unloaded.pop("scan")["motion"] == "search"
    assert unloaded == {"job": None, "threshold": boardlook.THRESHOLD, "corner_mm": boardlook.CORNER_MM, "method": "vote", "board_stretch": False, "corners": None}


def test_a_search_from_places_far_apart_keeps_the_top_camera_s_roll_and_scale_with_an_undo(client, quick_search, monkeypatch):
    # The fake board is small: its finding stop and its check lie closer
    # than a real board's do.
    monkeypatch.setattr(boardlook, "PLACES_MM", 5.0)
    rig(client, profile(rest=TOP))
    job_id = outlined_job(client)
    board = SeenBoard((0.0, 0.0, 40.0, 30.0), 2.0, (150.0, 80.0), design_shift=(-100.0, -70.0))
    # The camera sits at 1.9 degrees; the roll in use says 1.5.
    camera = BoardTopCamera(client.fake, (34.0, -9.0), board, roll=1.9, scale=0.0161)
    client.backend.top.client = camera
    client.put("/api/pnp/top", json={"offset": [34.0, -9.0], "mm_per_px": 0.02, "roll": 1.5, "mirror": False})
    assert client.post("/api/pnp/top/board", json={"job": job_id}).status_code == 200
    response = client.post("/api/pnp/top/search", json={"box": [140.0, 70.0, 200.0, 125.0]})
    assert response.status_code == 200, response.text
    assert routine_done(client, "/api/pnp/placing")["state"] == "done"
    top = client.get("/api/pnp/placing").json()["top"]
    look = top["board_look"]
    # Looks from the stop that found it and the check's place: the turn by
    # the head's moves, the board's own, and the roll 0.4 degrees off.
    assert look["found"] is True and look["estimate"]["rotation"] == pytest.approx(2.0, abs=0.01)
    assert look["estimate"]["roll_off"] == pytest.approx(0.4, abs=0.01)
    # Kept at once, logged with the values in use before; Undo takes them back.
    entry = top["applied"]
    assert entry["kind"] == "picture" and "roll at 1.90 degrees (1.50 in use)" in entry["text"] and "16.10 um a pixel" in entry["text"]
    assert top["roll"] == pytest.approx(1.9, abs=0.01) and top["mm_per_px"] == pytest.approx(0.0161)
    changes = {change["name"]: (change["before"], change["after"]) for change in entry["changes"]}
    assert changes["roll"][0] == 1.5 and changes["mm_per_px"] == (0.02, pytest.approx(0.0161))
    response = client.post(f"/api/findings/{entry['id']}/undo")
    assert response.status_code == 200, response.text
    settings = client.get("/api/pnp/placing").json()["top"]
    assert settings["roll"] == 1.5 and settings["mm_per_px"] == 0.02 and settings["applied"]["kind"] == "undo"


def test_a_top_camera_with_only_the_file_s_scale_searches_by_it(client, quick_search):
    # The file says the camera's scale as designed; none was measured, and
    # pcbv has not locked yet with the head off the board.
    rig(client, profile(rest=TOP + "roll = 1.5\nmm_per_px = 0.02\n"))
    job_id = outlined_job(client)
    board = SeenBoard((0.0, 0.0, 40.0, 30.0), 2.0, (150.0, 80.0), design_shift=(-100.0, -70.0))
    camera = BoardTopCamera(client.fake, (34.0, -9.0), board, roll=1.5)
    client.backend.top.client = camera
    client.put("/api/pnp/top", json={"offset": [34.0, -9.0], "mirror": False})
    assert client.get("/api/pnp/placing").json()["top"]["mm_per_px"] == 0.0
    assert client.post("/api/pnp/top/board", json={"job": job_id}).status_code == 200
    # pcbv keeps within one and a half times the design either way.
    assert camera.board_fields["scale"] == pytest.approx((0.02 / 1.5, 0.03))
    response = client.post("/api/pnp/top/search", json={"box": [140.0, 70.0, 200.0, 125.0]})
    assert response.status_code == 200, response.text
    assert routine_done(client, "/api/pnp/placing")["state"] == "done"
    look = client.get("/api/pnp/placing").json()["top"]["board_look"]
    assert look["found"] is True and look["estimate"]["rotation"] == pytest.approx(2.0, abs=0.01)


def test_a_search_with_nothing_known_scans_the_file_s_bed_quickly(client, quick_search):
    rig(client, profile(rest=TOP + "bed = [100.0, 40.0, 300.0, 200.0]\n"))
    job_id = outlined_job(client)
    board = SeenBoard((0.0, 0.0, 40.0, 30.0), 2.0, (150.0, 80.0), design_shift=(-100.0, -70.0))
    camera = BoardTopCamera(client.fake, (34.0, -9.0), board, roll=1.5)
    client.backend.top.client = camera
    client.put("/api/pnp/top", json={"offset": [34.0, -9.0], "mm_per_px": 0.02, "roll": 1.5, "mirror": False})
    assert client.post("/api/pnp/top/board", json={"job": job_id}).status_code == 200
    # No box drawn, no corners, references or place found before.
    response = client.post("/api/pnp/top/search", json={})
    assert response.status_code == 200, response.text
    assert routine_done(client, "/api/pnp/placing")["state"] == "done"
    look = client.get("/api/pnp/placing").json()["top"]["board_look"]
    assert look["found"] is True and look["estimate"]["rotation"] == pytest.approx(2.0, abs=0.01)
    # Its stops covered the bed 18 mm apart (0.6 of the board's 30 mm),
    # not the square about the head a search with nothing known took before.
    record = client.get("/api/searchlog?camera=top").json()["records"][0]
    shown = client.get(f"/api/searchlog/{record['id']}").json()["record"]
    assert shown["box"] == [100.0, 40.0, 300.0, 200.0]
    planned = shown["stops"]
    assert len(planned) == 12 * 9 + 11 * 8
    first = planned[: 12 * 9]
    assert min(math.dist(a, b) for a in first for b in first if a != b) == pytest.approx(18.0)


@pytest.mark.parametrize("only", [False, True])
def test_a_search_with_nothing_known_scans_the_file_s_board_area_first(client, quick_search, only):
    area = [130.0, 60.0, 210.0, 130.0]
    rest = TOP + "bed = [100.0, 40.0, 300.0, 200.0]\n" + f"board_area = {area}\nboard_area_only = {'true' if only else 'false'}\n"
    rig(client, profile(rest=rest))
    job_id = outlined_job(client)
    board = SeenBoard((0.0, 0.0, 40.0, 30.0), 2.0, (150.0, 80.0), design_shift=(-100.0, -70.0))
    camera = BoardTopCamera(client.fake, (34.0, -9.0), board, roll=1.5)
    client.backend.top.client = camera
    client.put("/api/pnp/top", json={"offset": [34.0, -9.0], "mm_per_px": 0.02, "roll": 1.5, "mirror": False})
    assert client.post("/api/pnp/top/board", json={"job": job_id}).status_code == 200
    response = client.post("/api/pnp/top/search", json={})
    assert response.status_code == 200, response.text
    assert routine_done(client, "/api/pnp/placing")["state"] == "done"
    look = client.get("/api/pnp/placing").json()["top"]["board_look"]
    assert look["found"] is True
    record = client.get("/api/searchlog?camera=top").json()["records"][0]
    shown = client.get(f"/api/searchlog/{record['id']}").json()["record"]
    planned = shown["stops"]
    inside = [area[0] <= x <= area[2] and area[1] <= y <= area[3] for x, y in planned]
    # The area's stops come first; the rest of the bed follows them only
    # when boards may lie elsewhere too.
    assert inside[0] and inside == sorted(inside, reverse=True)
    assert all(inside) is only
    assert shown["box"] == (area if only else [100.0, 40.0, 300.0, 200.0])


def test_the_top_camera_searches_with_the_posterior_when_its_look_method_says_so(client, quick_search):
    rig(client, profile(rest=TOP))
    job_id = outlined_job(client)
    board = SeenBoard((0.0, 0.0, 40.0, 30.0), 2.0, (150.0, 80.0), design_shift=(-100.0, -70.0))
    camera = BoardTopCamera(client.fake, (34.0, -9.0), board, roll=1.5)
    client.backend.top.client = camera
    client.put("/api/pnp/top", json={"offset": [34.0, -9.0], "mm_per_px": 0.02, "roll": 1.5, "mirror": False})
    assert client.put("/api/pnp/top", json={"look_method": "guess"}).status_code == 422
    response = client.put("/api/pnp/top", json={"look_method": "posterior"})
    assert response.status_code == 200, response.text
    assert response.json()["top"]["board_look"]["method"] == "posterior"
    assert client.post("/api/pnp/top/board", json={"job": job_id}).status_code == 200
    response = client.post("/api/pnp/top/search", json={"box": [140.0, 70.0, 200.0, 125.0]})
    assert response.status_code == 200, response.text
    routine = routine_done(client, "/api/pnp/placing")
    assert routine["state"] == "done", routine
    look = client.get("/api/pnp/placing").json()["top"]["board_look"]
    middle = (150.0 + 20.0 * math.cos(math.radians(2.0)) - 15.0 * math.sin(math.radians(2.0)), 80.0 + 20.0 * math.sin(math.radians(2.0)) + 15.0 * math.cos(math.radians(2.0)))
    assert look["method"] == "posterior" and look["found"] is True, look
    assert look["estimate"]["center"] == pytest.approx(list(middle), abs=0.05) and look["estimate"]["rotation"] == pytest.approx(2.0, abs=0.05)
    assert 0.0 <= look["elsewhere"] < look["guesses"][0]["probability"]
    assert look["views"] >= 1 and look["representation"] in ("samples", "gaussian")
    # Clear guesses: the place predicted is forgotten, the board stays loaded.
    forgot = client.post("/api/pnp/top/board/forget").json()["top"]["board_look"]
    assert forgot["job"] is not None and forgot["guesses"] == [] and forgot["estimate"] is None
    # Back to the vote, the look starts over with it.
    assert client.put("/api/pnp/top", json={"look_method": "vote"}).json()["top"]["board_look"]["method"] == "vote"


def test_the_top_camera_scans_the_whole_board_from_a_rough_place_and_keeps_a_mosaic(client, quick_search):
    rig(client, profile(rest=TOP))
    job_id = outlined_job(client)
    board = SeenBoard((0.0, 0.0, 40.0, 30.0), 2.0, (150.0, 80.0), design_shift=(-100.0, -70.0))
    camera = BoardTopCamera(client.fake, (34.0, -9.0), board, roll=1.5)
    client.backend.top.client = camera
    client.put("/api/pnp/top", json={"offset": [34.0, -9.0], "mm_per_px": 0.02, "roll": 1.5, "mirror": False})
    assert client.post("/api/pnp/top/board", json={"job": job_id}).status_code == 200
    # Nothing tells where the board is yet.
    response = client.post("/api/pnp/top/scan", json={})
    assert response.status_code == 400 and "rough place" in response.json()["detail"]
    assert client.post("/api/pnp/top/search", json={"box": [140.0, 70.0, 200.0, 125.0]}).status_code == 200
    assert routine_done(client, "/api/pnp/placing")["state"] == "done"
    response = client.post("/api/pnp/top/scan", json={"margin": 1.0})
    assert response.status_code == 200, response.text
    routine = routine_done(client, "/api/pnp/placing")
    assert routine["state"] == "done" and routine["kind"] == "scan", routine
    look = client.get("/api/pnp/placing").json()["top"]["board_look"]
    mosaic = client.get("/api/pnp/top/scan").json()
    assert mosaic["job"] == job_id and len(mosaic["pictures"]) >= 4 and look["scan"]["pictures"] == len(mosaic["pictures"])
    middle = (150.0 + 20.0 * math.cos(math.radians(2.0)) - 15.0 * math.sin(math.radians(2.0)), 80.0 + 20.0 * math.sin(math.radians(2.0)) + 15.0 * math.cos(math.radians(2.0)))
    assert mosaic["estimate"]["center"] == pytest.approx(list(middle), abs=0.05) and mosaic["outline"] == [0.0, 0.0, 40.0, 30.0]
    # The pictures cover the board: the place found, from every stop.
    centers = [tuple(picture["center"]) for picture in mosaic["pictures"]]
    assert min(x for x, _ in centers) - 12.8 <= middle[0] - 20.0 and max(x for x, _ in centers) + 12.8 >= middle[0] + 20.0
    assert min(y for _, y in centers) - 7.2 <= middle[1] - 15.0 and max(y for _, y in centers) + 7.2 >= middle[1] + 15.0
    assert all(picture["width"] == 640 and picture["mm_per_px"] == pytest.approx(0.04) for picture in mosaic["pictures"])
    picture = client.get("/api/pnp/top/scan/0.jpg")
    assert picture.status_code == 200 and picture.headers["content-type"] == "image/jpeg"
    assert client.get(f"/api/pnp/top/scan/{len(centers)}.jpg").status_code == 404
    records = client.get("/api/searchlog?camera=top").json()["records"]
    assert records[0]["kind"] == "scan" and records[0]["result"] == "found"


def test_the_top_cameras_nozzle_box_is_kept_in_shares_of_the_picture_checked_and_cleared(client):
    rig(client, profile(rest=TOP))
    response = client.put("/api/pnp/top", json={"nozzle_box": [0.1, 0.6, 0.3, 0.9]})
    assert response.status_code == 200, response.text
    assert response.json()["top"]["nozzle_box"] == [0.1, 0.6, 0.3, 0.9]
    for bad in ([0.3, 0.6, 0.1, 0.9], [0.1, 0.6, 0.3, 1.5], [0.1, 0.6, 0.1, 0.9]):
        refused = client.put("/api/pnp/top", json={"nozzle_box": bad})
        assert refused.status_code == 400 and "nozzle box" in refused.json()["detail"]
    assert client.get("/api/pnp/placing").json()["top"]["nozzle_box"] == [0.1, 0.6, 0.3, 0.9]
    assert client.put("/api/pnp/top", json={"clear": ["nozzle_box"]}).json()["top"]["nozzle_box"] is None


def test_the_top_cameras_corner_by_edges_is_kept_with_its_picture_in_the_camera_log(client):
    rig(client, profile(rest=TOP))
    job_id = outlined_job(client)
    board = SeenBoard((0.0, 0.0, 40.0, 30.0), 2.0, (150.0, 80.0), design_shift=(-100.0, -70.0))
    camera = BoardTopCamera(client.fake, (34.0, -9.0), board, roll=0.0)
    # The board's bottom left corner under the picture's center, its sides
    # along the picture's right and up: no turn.
    camera.edges = lambda most=8, color=None: {"lines": [{"x0": 640.0, "y0": 360.0, "x1": 1000.0, "y1": 360.0}, {"x0": 640.0, "y0": 360.0, "x1": 640.0, "y1": 40.0}], "width": 1280, "height": 720}
    client.backend.top.client = camera
    client.put("/api/pnp/top", json={"offset": [34.0, -9.0], "mm_per_px": 0.02, "roll": 0.0, "mirror": False})
    client.put("/api/camlog", json={"enabled": True})
    response = client.post("/api/pnp/top/edge-corner", json={"job": job_id, "corner": "bottom left"})
    assert response.status_code == 200, response.text
    point = response.json()["top"]["board_look"]["corners"]["points"][0]
    assert point["by"] == "edges" and point["angle"] == pytest.approx(0.0, abs=1e-6)
    entry = client.get("/api/camlog", params={"camera": "top"}).json()["entries"][0]
    assert entry["camera"] == "top" and entry["routine"] == "corner by edges" and entry["edges"] == {"lines": 2, "corner": [640.0, 360.0]}
    client.put("/api/camlog", json={"enabled": False})


def test_corners_taken_with_the_top_camera_give_a_rough_place_a_search_box_and_references(client, quick_search):
    rig(client, profile(rest=TOP))
    job_id = outlined_job(client)
    board = SeenBoard((0.0, 0.0, 40.0, 30.0), 2.0, (150.0, 80.0), design_shift=(-100.0, -70.0))
    client.backend.top.client = BoardTopCamera(client.fake, (34.0, -9.0), board, roll=1.5)
    client.put("/api/pnp/top", json={"offset": [34.0, -9.0], "mm_per_px": 0.02, "roll": 1.5, "mirror": False})
    # Nothing found and no corners: no place to keep.
    assert client.post("/api/pnp/top/place", json={"job": job_id}).status_code == 400
    assert client.post("/api/pnp/top/corner", json={"job": job_id, "corner": "middle"}).status_code == 400

    def take(corner: str, point: tuple[float, float]) -> dict:
        # The picture's center put on the corner: the head there less the offset.
        x, y = turn(point, 2.0)
        client.post("/api/goto", json={"kind": "joint", "r": x + 150.0 - 34.0, "z": y + 80.0 + 9.0})
        response = client.post("/api/pnp/top/corner", json={"job": job_id, "corner": corner})
        assert response.status_code == 200, response.text
        return response.json()["top"]["board_look"]["corners"]

    take("bottom left", (0.0, 0.0))
    corners = take("top right", (40.0, 30.0))
    assert [point["corner"] for point in corners["points"]] == ["bottom left", "top right"]
    assert corners["rough"]["rotation"] == pytest.approx(2.0, abs=0.01) and corners["rough"]["shift"] == pytest.approx([150.0, 80.0], abs=0.01)
    # Kept as references by corners, with no look.
    refs = [entry for entry in client.post("/api/pnp/top/place", json={"job": job_id}).json()["references"] if entry["job"] == job_id]
    assert len(refs) == 2 and {entry["by"] for entry in refs} == {"corners"}
    # A search with no box drawn keeps to where the corners put the board.
    client.post("/api/pnp/top/board", json={"job": job_id})
    assert client.post("/api/pnp/top/search", json={}).status_code == 200
    assert routine_done(client, "/api/pnp/placing")["state"] == "done"
    record_id = client.get("/api/searchlog?camera=top").json()["records"][0]["id"]
    record = client.get(f"/api/searchlog/{record_id}").json()["record"]
    xs = [turn(point, 2.0)[0] + 150.0 for point in ((0.0, 0.0), (40.0, 0.0), (40.0, 30.0), (0.0, 30.0))]
    assert record["box"][0] == pytest.approx(min(xs) - 2.0, abs=0.01) and record["box"][2] == pytest.approx(max(xs) + 2.0, abs=0.01)
    assert record["settings"]["corners"][1]["corner"] == "top right" and record["settings"]["threshold"] == boardlook.THRESHOLD
    look = client.get("/api/pnp/placing").json()["top"]["board_look"]
    assert look["found"] and look["guesses"][0]["probability"] == 1.0 and look["guesses"][0]["corner_mm"] < 0.05
    assert look["known"]["source"] == "corners" and record["known"]["source"] == "corners"
    # The threshold and tolerance are the camera's, set from the page, checked.
    assert client.put("/api/pnp/top", json={"look_threshold": 1.5}).status_code == 400
    look = client.put("/api/pnp/top", json={"look_threshold": 0.8, "corner_mm": 1.0}).json()["top"]["board_look"]
    assert look["threshold"] == 0.8 and look["corner_mm"] == 1.0
    assert client.delete("/api/pnp/top/corners").json()["top"]["board_look"]["corners"] is None
    # Without corners or a place found, the references put the board.
    job = client.backend._job(job_id)
    assert client.backend._top_known(job, 2.0).source == "found"
    client.backend.top_look.found_places.clear()
    known = client.backend._top_known(job, 2.0)
    assert known.source == "references" and known.place.rotation == pytest.approx(2.0, abs=0.01)


def test_a_run_that_places_no_part_says_why(client):
    job_id = rig(client, profile(feeder='refs = ["X9"]').replace('match = "10k"\n', ""))
    client.post("/api/pnp/references", json={"job": job_id, "ref": "R1", "at": [100.0, 50.0]})
    response = client.post("/api/pnp/run", json={"job": job_id})
    assert response.status_code == 502
    assert response.json()["detail"] == "the program places no part: 2 parts no feeder holds it"


def test_a_parts_shape_is_served_from_its_board_file(client):
    job_id = rig(client, profile())
    shape = client.get(f"/api/jobs/{job_id}/components/R1/shape").json()
    # R1 draws its body on F.Fab (1.6 by 0.8 about its center) and has no pads.
    assert shape["job"] == job_id and shape["ref"] == "R1" and shape["pads"] == [] and len(shape["body"]) == 4
    assert client.get(f"/api/jobs/{job_id}/components/R9/shape").status_code == 404
    bare = Job(name="plain", source="svg", groups=[Group(label="g", paths=[[(0.0, 0.0), (1.0, 0.0)]])])
    client.backend.store.add(bare)
    assert client.get(f"/api/jobs/{bare.id}/components/R1/shape").status_code == 404


def test_a_corner_taken_is_a_reference_go_to_part_and_a_plan_place_the_board_by(client):
    rig(client, profile(rest=TOP))
    job_id = outlined_job(client)
    client.put("/api/pnp/top", json={"offset": [34.0, -9.0], "mm_per_px": 0.02, "roll": 0.0, "mirror": False})
    # No reference yet: nowhere to go.
    assert client.post("/api/pnp/goto", json={"job": job_id, "ref": "R1"}).status_code == 400

    def take(corner: str, at: tuple[float, float]) -> list[dict]:
        # The picture's center on the corner: the head there less the offset.
        client.post("/api/goto", json={"kind": "joint", "r": at[0] - 34.0, "z": at[1] + 9.0})
        response = client.post("/api/pnp/top/corner", json={"job": job_id, "corner": corner})
        assert response.status_code == 200, response.text
        return [entry for entry in response.json()["references"] if entry["job"] == job_id]

    refs = take("bottom left", (150.0, 80.0))
    assert refs == [{"job": job_id, "ref": "corner bottom left", "at": [150.0, 80.0], "by": "corner", "point": [0.0, 0.0]}]
    # One corner: the board shifted, not turned. R1 lies 1 mm along X from it.
    client.post("/api/pnp/goto", json={"job": job_id, "ref": "R1"})
    assert client.fake.position[:2] == pytest.approx((151.0, 80.0), abs=1e-6)
    # A second corner gives the turn; taken again, a corner replaces itself.
    far = turn((40.0, 30.0), 2.0)
    take("top right", (far[0] + 150.0 + 3.0, far[1] + 80.0))
    refs = take("top right", (far[0] + 150.0, far[1] + 80.0))
    assert [entry["ref"] for entry in refs] == ["corner bottom left", "corner top right"]
    planned = client.post("/api/pnp/plan", json={"job": job_id, "refs": ["R1"]}).json()
    # The head's place is read to a hundredth of a mm.
    assert planned["fit"]["rotation"] == pytest.approx(2.0, abs=0.01) and planned["fit"]["marks"] == 2
    client.post("/api/pnp/goto", json={"job": job_id, "ref": "R2"})
    r2 = turn((11.0, 0.0), 2.0)
    assert client.fake.position[:2] == pytest.approx((r2[0] + 150.0, r2[1] + 80.0), abs=0.01)
    # The posterior's prior leaves the corners out: they are weighed on their own.
    job = client.backend._job(job_id)
    parts = client.backend.job_parts(job_id)["components"]
    with pytest.raises(ValueError):
        client.backend._board_fit(job_id, parts, corners=False)
    # With the look's corners gone (as after a restart), the corners kept as
    # references still tell a search where the board is.
    client.backend.top_look.clear_corners()
    known = client.backend._top_known(job, 2.0)
    assert known is not None and known.source == "references" and known.place.rotation == pytest.approx(2.0, abs=0.01)
    # A corner found by its edges turns a lone reference by the turn they showed.
    client.backend._keep_corner(job_id, "top right", (40.0, 30.0), (190.0, 110.0), 5.0)
    client.post("/api/pnp/references", json={"job": job_id, "ref": "R1", "at": [0.0, 0.0]})
    client.delete(f"/api/pnp/references?job={job_id}&ref=R1")
    client.delete(f"/api/pnp/references?job={job_id}&ref=corner%20bottom%20left")
    assert client.backend._board_fit(job_id, parts).rotation == pytest.approx(5.0)
    # Clear corners forgets the corners kept as references too.
    take("bottom left", (150.0, 80.0))
    client.delete("/api/pnp/top/corners")
    assert [entry for entry in client.get("/api/pnp/placing").json()["references"] if entry["job"] == job_id and entry["by"] == "corner"] == []
    assert job.id == job_id


def test_a_search_that_covers_its_box_without_the_board_ends_as_not_found(client, quick_search):
    rig(client, profile(rest=TOP))
    job_id = outlined_job(client)
    board = SeenBoard((0.0, 0.0, 40.0, 30.0), 0.0, (500.0, 500.0), design_shift=(-100.0, -70.0))
    client.backend.top.client = BoardTopCamera(client.fake, (34.0, -9.0), board, roll=0.0, pictures=False)
    client.put("/api/pnp/top", json={"offset": [34.0, -9.0], "mm_per_px": 0.02, "roll": 0.0})
    client.post("/api/pnp/top/board", json={"job": job_id})
    assert client.post("/api/pnp/top/search", json={"box": [100.0, 30.0, 140.0, 60.0]}).status_code == 200
    routine = routine_done(client, "/api/pnp/placing")
    assert routine["state"] == "error" and "no board found" in routine["error"] and routine["total"] >= 6
    assert client.post("/api/pnp/top/place", json={"job": job_id}).status_code == 400
    # Recorded as not found, every stop visited; this camera gives no
    # pictures, which the record says and goes on.
    record = client.get("/api/searchlog?camera=top").json()["records"][0]
    assert record["kind"] == "search" and record["result"] == "not found" and record["visited"] == record["stops"]
    assert f"{record['stops']} stops" in routine["error"] and record["message"] == routine["error"]
    summary = client.get(f"/api/searchlog/{record['id']}").json()["summary"]
    assert len(summary["stops"]) == record["stops"] and summary["pictures"] == [] and summary["truth"] is None
