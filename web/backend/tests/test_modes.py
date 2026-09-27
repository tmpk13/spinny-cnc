"""The optional modes: a cartesian machine and a spindle, streamer and API."""

from __future__ import annotations

import math
import re
import time

import pytest
from fake_serial import FakeSerial, fake_opener
from fastapi.testclient import TestClient

from spinny_web.app import Backend, create_app, profile_of
from spinny_web.heightmap import Compensation, Grid, HeightMap
from spinny_web.jobs import Group, Job
from spinny_web.kinematics import CartesianStreamer, Rates, Spindle, Streamer, head_board, turned
from spinny_web.link import REALTIME_JOG_CANCEL, Link
from spinny_web.prober import cartesian_probe_joint

WORD = re.compile(r"([A-Z])(-?\d+(?:\.\d+)?)")


def words(line: str) -> dict[str, float]:
    return {letter: float(value) for letter, value in WORD.findall(line)}


def square(x0: float, y0: float, side: float) -> list[tuple[float, float]]:
    return [(x0, y0), (x0 + side, y0), (x0 + side, y0 + side), (x0, y0 + side), (x0, y0)]


def job_of(*groups: Group) -> Job:
    return Job(name="t", groups=list(groups))


# --- the cartesian frame ----------------------------------------------------


def test_a_cartesian_line_is_one_straight_cut_on_the_rail_and_the_slide():
    streamer = CartesianStreamer()
    job = job_of(Group(label="g", power=400, speed=300, paths=[square(2.0, 1.0, 3.0)]))
    lines = [piece.line for piece in streamer.job_pieces(job, (0.0, 0.0))]
    assert lines == [
        "go R2.000 Z1.000",
        "cut R5.000 Z1.000 F300 S400",
        "cut R5.000 Z4.000 F300 S400",
        "cut R2.000 Z4.000 F300 S400",
        "cut R2.000 Z1.000 F300 S400",
    ]
    stats = streamer.estimate(job, (0.0, 0.0))
    assert stats.length_mm == pytest.approx(12.0)
    # 12 mm at 300 mm/min, and the rapid to the start at the rail's rate.
    assert stats.seconds == pytest.approx(12.0 / 300 * 60 + 2.0 / 560 * 60)


def test_a_cartesian_path_through_the_axis_is_nothing_special():
    streamer = CartesianStreamer()
    job = job_of(Group(label="g", paths=[[(-5.0, 0.0), (5.0, 0.0)]]))
    lines = [piece.line for piece in streamer.job_pieces(job, (-5.0, 0.0))]
    assert lines == ["cut R5.000 Z0.000 F400 S500"]


def test_the_board_turns_with_the_table_angle():
    streamer = CartesianStreamer(angle=90.0)
    # A quarter turn on, board X lies along the slide the other way.
    lines = streamer.board_goto((0.0, 0.0), 0.0, 5.0)
    assert lines == ["jogto R5.000 Z0.000"]
    lines = streamer.board_goto((0.0, 0.0), 5.0, 0.0)
    assert lines == ["jogto R0.000 Z-5.000"]
    assert streamer.board_of((5.0, 0.0)) == pytest.approx((0.0, 5.0))
    assert head_board(5.0, 90.0, 0.0, True) == pytest.approx((0.0, 5.0))
    # A polar machine leaves the slide out of the board position.
    assert head_board(5.0, 90.0, 3.0, False) == pytest.approx((0.0, 5.0))
    assert turned((1.0, 0.0), 30.0) == pytest.approx((math.cos(math.radians(30)), math.sin(math.radians(30))))


def test_a_cartesian_machine_takes_no_joint_space_group():
    streamer = CartesianStreamer()
    job = job_of(Group(label="rail line", joints=[[(0.0, 0.0), (5.0, 0.0)]]))
    with pytest.raises(ValueError, match="polar machine"):
        list(streamer.job_pieces(job, (0.0, 0.0)))
    # The stats of such a job fall back to the polar laser's.
    job.refresh_stats(streamer)
    assert job.stats.length_mm == pytest.approx(5.0)


def test_cartesian_jogs_put_z_beside_the_others():
    streamer = CartesianStreamer()
    assert streamer.joint_jog(1.0, None, None, None, -0.5) == "jog R1 Z-0.5"
    assert streamer.joint_goto(3.0, None, 200.0, -1.0, 4.0) == "jogto R3 H-1 Z4 F200"
    assert streamer.board_jog((1.0, 2.0), 1.0, 1.0) == ["jogto R2.000 Z3.000"]


def test_rates_take_the_slide_and_the_focus_axis_too():
    rates = Rates.from_settings({"z_rate": 300, "z_steps": 256, "h_rate": 120, "h_steps": 6400})
    assert (rates.z_rate, rates.h_rate) == (300.0, 120.0)
    # The step generator's ceiling caps them as it does the others.
    assert Rates.from_settings({"z_rate": 1000, "z_steps": 10240}).z_rate == pytest.approx(6.0e6 / 10240)


# --- milling ------------------------------------------------------------------


def mill(streamer: Streamer, job: Job, compensation=None) -> list[str]:
    return [piece.line for piece in streamer.job_pieces(job, (0.0, 0.0), compensation)]


def test_a_milled_path_is_a_lift_spin_up_plunge_cuts_and_a_rise():
    streamer = CartesianStreamer(spindle=Spindle(clearance=2.0, spinup=1.5))
    job = job_of(Group(label="iso", power=800, speed=200, depth=0.1, plunge=50, paths=[[(1.0, 1.0), (4.0, 5.0)]]))
    assert mill(streamer, job) == [
        "go H2.0000",
        "spindle S800",
        "dwell T1500",
        "go R1.000 Z1.000",
        "cut H-0.1000 F50",
        "cut R4.000 Z5.000 H-0.1000 F200",
        "go H2.0000",
        "spindle off",
    ]


def test_passes_step_down_to_the_depth_and_a_new_speed_restarts_the_spindle():
    streamer = CartesianStreamer(spindle=Spindle(spinup=0.0))
    path = [(0.0, 0.0), (10.0, 0.0)]
    job = job_of(
        Group(label="iso", power=800, speed=200, depth=0.2, plunge=50, passes=2, paths=[path]),
        Group(label="same", power=800, speed=200, depth=0.1, plunge=50, paths=[path]),
        Group(label="off", power=100, enabled=False, paths=[path]),
        Group(label="outline", power=1000, speed=100, depth=1.6, plunge=30, passes=4, paths=[path]),
    )
    lines = mill(streamer, job)
    plunges = [words(line)["H"] for line in lines if line.startswith("cut H")]
    assert plunges == pytest.approx([-0.1, -0.2, -0.1, -0.4, -0.8, -1.2, -1.6])
    assert [line for line in lines if line.startswith("spindle")] == ["spindle S800", "spindle S1000", "spindle off"]
    assert not any(line.startswith("dwell") for line in lines), "no spin-up asked for"
    # Every plunge is from the travel height, and every path rises back.
    height = None
    for line in lines:
        if line.startswith("cut H"):
            assert height == 2.0, "a plunge from the travel height"
        if line.startswith(("go H", "cut")):
            height = words(line)["H"]
        if line.startswith("go R"):
            assert height == 2.0, "rapids at the travel height"
    assert lines[-2:] == ["go H2.0000", "spindle off"]


def test_a_milled_cut_carries_no_power_and_the_estimate_counts_the_plunges():
    streamer = CartesianStreamer(spindle=Spindle(clearance=1.0, spinup=2.0), rates=Rates(h_rate=60.0))
    job = job_of(Group(label="g", power=500, speed=120, depth=0.5, plunge=30, paths=[[(0.0, 0.0), (6.0, 0.0)]]))
    for piece in streamer.job_pieces(job, (0.0, 0.0)):
        assert "S" not in words(piece.line) or piece.line.startswith("spindle"), piece.line
    stats = streamer.estimate(job, (0.0, 0.0))
    # The first lift from wherever the head is is not priced; 2 s spin-up,
    # plunge 1.5 mm at 30, 6 mm at 120, rise 1.5 mm at 60.
    assert stats.seconds == pytest.approx(2.0 + 3.0 + 3.0 + 1.5)
    assert stats.length_mm == pytest.approx(6.0)


def test_milling_on_the_polar_machine_plunges_after_the_turn_to_the_start():
    streamer = Streamer(spindle=Spindle(spinup=0.0))
    job = job_of(Group(label="g", power=500, speed=120, paths=[[(10.0, 0.0), (0.0, 10.0)]]))
    lines = mill(streamer, job)
    assert lines[:3] == ["go H2.0000", "spindle S500", "go R10.000 A0.0000"]
    assert lines[3] == "cut H-0.1000 F60"
    cuts = [line for line in lines if line.startswith("cut R")]
    assert len(cuts) > 3, "the line is a spiral in joint space and is subdivided"
    assert all(words(line)["H"] == pytest.approx(-0.1) for line in cuts)


def test_the_height_map_sets_the_depth_under_the_tool_and_the_travel_height():
    grid = Grid(x0=0, y0=-5, x1=10, y1=5, nx=3, ny=3)
    heightmap = HeightMap.empty(grid)
    for iy, y in enumerate(grid.ys):
        for ix, x in enumerate(grid.xs):
            heightmap.heights[iy][ix] = -1.0 + 0.05 * x
    # The tool touched the copper 0.3 mm above where the probe did.
    heightmap.focus_offset = 0.3
    heightmap.focus_set = True
    compensation = Compensation(heightmap=heightmap, mode="focus")
    streamer = CartesianStreamer(spindle=Spindle(clearance=2.0, spinup=0.0))
    job = job_of(Group(label="g", power=500, speed=120, depth=0.1, paths=[[(0.0, 0.0), (10.0, 0.0)]]))
    lines = mill(streamer, job, compensation)
    top = -1.0 + 0.05 * 10 + 0.3
    assert lines[0] == f"go H{top + 2.0:.4f}"
    cuts = [words(line) for line in lines if line.startswith("cut R")]
    assert len(cuts) >= 10 / compensation.step - 1e-9
    for w in cuts:
        assert w["H"] == pytest.approx(-1.0 + 0.05 * w["R"] + 0.3 - 0.1, abs=1e-4)
    plunge = next(line for line in lines if line.startswith("cut H"))
    assert words(plunge)["H"] == pytest.approx(-1.0 + 0.3 - 0.1)


def test_a_spindle_config_is_checked():
    with pytest.raises(ValueError):
        Spindle(clearance=0.0)
    with pytest.raises(ValueError):
        Spindle(spinup=-1.0)
    with pytest.raises(ValueError):
        Spindle(clearance=float("nan"))


def test_the_profile_follows_the_settings():
    assert profile_of({}) == {"kinematics": "polar", "tool": "laser", "h_axis": False, "r_max": 0.0, "z_max": 0.0}
    profile = profile_of({"cartesian": 1, "spindle": 1, "h_axis": 1, "r_max": 60, "z_max": 8.5})
    assert profile == {"kinematics": "cartesian", "tool": "spindle", "h_axis": True, "r_max": 60.0, "z_max": 8.5}


def test_the_probe_tip_goes_over_the_point_in_the_cartesian_frame():
    r, z = cartesian_probe_joint((3.0, 4.0), (1.0, -0.5), 0.0)
    assert (r, z) == pytest.approx((2.0, 4.5))
    # A quarter turn on, the point is turned back first.
    r, z = cartesian_probe_joint((0.0, 5.0), (0.0, 0.0), 90.0)
    assert (r, z) == pytest.approx((5.0, 0.0))


# --- the API ------------------------------------------------------------------


@pytest.fixture
def fake():
    return FakeSerial(move_time=0.002)


@pytest.fixture
def client(tmp_path, fake):
    backend = Backend(
        root=tmp_path,
        link_factory=lambda url: Link(url, open_port=fake_opener(fake)),
        jobs_dir=tmp_path / "jobs",
        config_path=tmp_path / "config.json",
    )
    app = create_app(backend, frontend=tmp_path / "no-dist")
    with TestClient(app) as client:
        client.backend = backend
        yield client


def connect(client) -> dict:
    response = client.post("/api/connect", json={"url": "socket://127.0.0.1:9999"})
    assert response.status_code == 200, response.text
    return response.json()


def wait_idle(fake: FakeSerial) -> None:
    deadline = time.monotonic() + 5.0
    while fake.state() != "Idle" or fake.answered_lines != fake.received_lines:
        assert time.monotonic() < deadline, "the fake never came to rest"
        time.sleep(0.005)


def machine_when(client, predicate) -> dict:
    """The machine in the snapshot once a status poll has brought it."""
    deadline = time.monotonic() + 5.0
    while True:
        machine = client.get("/api/state").json()["machine"]
        if machine is not None and predicate(machine):
            return machine
        assert time.monotonic() < deadline, f"never came: {machine}"
        time.sleep(0.01)


def test_a_cartesian_machine_jogs_the_board_straight_and_shows_it(client, fake):
    fake.settings["cartesian"] = 1
    state = connect(client)
    assert state["profile"]["kinematics"] == "cartesian"
    response = client.post("/api/goto", json={"kind": "board", "x": 3, "y": 4})
    assert response.status_code == 200, response.text
    assert response.json()["lines"] == ["jogto R3.000 Z4.000"]
    wait_idle(fake)
    machine = machine_when(client, lambda m: m["joint"]["z"] == 4.0)
    assert machine["board"] == {"x": 3.0, "y": 4.0}
    # The slide jogs beside the rail rather than on its own.
    response = client.post("/api/jog", json={"kind": "joint", "dr": 1, "dz": -1})
    assert response.status_code == 200, response.text
    assert response.json()["lines"] == ["jog R1 Z-1"]
    wait_idle(fake)
    response = client.post("/api/goto", json={"kind": "joint", "z": 0})
    assert response.json()["lines"] == ["jogto Z0"]


def test_a_polar_machine_still_moves_the_slide_alone(client, fake):
    connect(client)
    response = client.post("/api/jog", json={"kind": "joint", "dr": 1, "dz": -1})
    assert response.status_code == 400


def test_a_board_move_past_the_slide_limit_is_refused_whole(client, fake):
    fake.settings["cartesian"] = 1
    fake.settings["z_max"] = 5
    connect(client)
    response = client.post("/api/goto", json={"kind": "board", "x": 1, "y": 6})
    assert response.status_code == 400
    assert "z_max" in response.json()["detail"]
    assert not any(line.startswith("jogto") for line in fake.received_lines)


def test_the_spindle_controls_follow_the_tool(client, fake):
    connect(client)
    assert client.post("/api/spindle", json={"power": 300}).status_code == 400
    # Set at the console, the page's idea of the machine follows.
    assert client.post("/api/command", json={"line": "$spindle=1"}).json()["lines"] == ["ok"]
    assert client.get("/api/state").json()["profile"]["tool"] == "spindle"
    response = client.post("/api/spindle", json={"power": 300})
    assert response.status_code == 200, response.text
    assert fake.spindle == 300
    assert client.post("/api/laser", json={"power": 50, "ms": 100}).status_code == 400
    assert client.post("/api/spindle/off").status_code == 200
    assert fake.spindle == 0
    assert "spindle S300" in fake.received_lines and "spindle off" in fake.received_lines


def test_a_milling_run_needs_the_depth_axis_and_streams_the_plunges(client, fake):
    fake.settings["cartesian"] = 1
    fake.settings["spindle"] = 1
    connect(client)
    job = Job(
        name="mill",
        groups=[Group(label="iso", power=700, speed=200, depth=0.2, passes=2, paths=[[(1.0, 0.0), (3.0, 0.0)]])],
    )
    response = client.post("/api/jobs", files={"file": ("mill.json", job.model_dump_json(), "application/json")})
    assert response.status_code == 200, response.text
    job_id = response.json()["id"]
    response = client.post(f"/api/jobs/{job_id}/run")
    assert response.status_code == 400
    assert "h_axis" in response.json()["detail"]
    fake.settings["h_axis"] = 1
    # A map the job could run on, so the refusal is the spindle's own and
    # not the want of a map.
    grid = Grid(x0=0, y0=-1, x1=4, y1=1, nx=3, ny=3)
    heightmap = HeightMap.empty(grid)
    heightmap.heights = [[0.0] * 3 for _ in range(3)]
    assert client.put("/api/heightmap", json=heightmap.model_dump()).status_code == 200
    # Focused here, with the head over the map at rest.
    response = client.post("/api/heightmap/focus", json={})
    assert response.status_code == 200, response.text
    response = client.post(f"/api/jobs/{job_id}/run", json={"compensate": "power"})
    assert response.status_code == 400
    assert "compensate by focus" in response.json()["detail"], "a spindle does not compensate by power"
    assert client.backend.compensation("auto", client.backend.store.get(job_id)).mode == "focus"
    response = client.post(f"/api/jobs/{job_id}/run")
    assert response.status_code == 200, response.text
    deadline = time.monotonic() + 10.0
    while client.get("/api/run").json()["state"] == "running":
        assert time.monotonic() < deadline
        time.sleep(0.01)
    assert client.get("/api/run").json()["state"] == "done"
    sent = [line for line in fake.received_lines if not line.startswith(("$", "?", "status"))]
    assert sent[:4] == ["go H2.0000", "spindle S700", "dwell T2000", "go R1.000 Z0.000"]
    assert "cut H-0.1000 F60" in sent and "cut H-0.2000 F60" in sent
    assert sent[-1] == "spindle off"
    assert fake.spindle == 0


def test_host_milling_settings_are_kept(client, tmp_path):
    response = client.put("/api/settings", json={"host": {"clearance": 3.5, "spinup": 4}})
    assert response.status_code == 200, response.text
    assert response.json()["host"] == {"tolerance": 0.005, "clearance": 3.5, "spinup": 4.0}
    assert client.put("/api/settings", json={"host": {"clearance": 0}}).status_code == 400
    assert client.put("/api/settings", json={"host": {"spinup": "soon"}}).status_code == 400
    assert client.backend.spindle_config() == Spindle(clearance=3.5, spinup=4.0)


def test_the_centering_test_is_the_polar_lasers(client, fake):
    fake.settings["cartesian"] = 1
    connect(client)
    response = client.post("/api/center", json={})
    assert response.status_code == 400


@pytest.fixture
def quiet_client(tmp_path, fake):
    """A client whose link sends no status poll: the backend knows only
    the reports it asks for."""
    backend = Backend(
        root=tmp_path,
        link_factory=lambda url: Link(url, open_port=fake_opener(fake), poll=False),
        jobs_dir=tmp_path / "jobs",
        config_path=tmp_path / "config.json",
    )
    app = create_app(backend, frontend=tmp_path / "no-dist")
    with TestClient(app) as client:
        client.backend = backend
        yield client


def test_a_cartesian_board_goto_is_planned_at_the_angle_the_table_has_now(quiet_client, fake):
    fake.settings["cartesian"] = 1
    connect(quiet_client)
    # The table turned after the last report the backend has.
    fake.joint = [0.0, 90.0]
    response = quiet_client.post("/api/goto", json={"kind": "board", "x": 10, "y": 0})
    assert response.status_code == 200, response.text
    (line,) = response.json()["lines"]
    target = words(line)
    assert (target["R"], target["Z"]) == pytest.approx((0.0, -10.0), abs=1e-3)


def test_a_cartesian_board_move_waits_for_a_turn_of_the_table(client, fake):
    # The board frame turns with the table: a board point planned partway
    # through a turn is another point once the turn has ended.
    fake.settings["cartesian"] = 1
    connect(client)
    fake.move_time = 3.0
    response = client.post("/api/jog", json={"kind": "joint", "da": 90})
    assert response.status_code == 200, response.text
    assert fake.state() == "Jog"
    response = client.post("/api/goto", json={"kind": "board", "x": 10, "y": 0})
    assert response.status_code == 409
    assert "turning" in response.json()["detail"]
    assert client.post("/api/jog", json={"kind": "board", "dx": 1}).status_code == 409
    assert not any(line.startswith("jogto") for line in fake.received_lines)
    assert sum(line.startswith("jog ") for line in fake.received_lines) == 1
    # A joint goto that leaves the angle alone is queued behind the turn:
    # where it ends in joints is known, but not in which frame.
    response = client.post("/api/goto", json={"kind": "joint", "r": 10, "z": 0})
    assert response.status_code == 200, response.text
    response = client.post("/api/goto", json={"kind": "board", "x": 10, "y": 0})
    assert response.status_code == 409
    assert "turning" in response.json()["detail"]
    assert client.post("/api/jog", json={"kind": "board", "dx": 1}).status_code == 409
    assert sum(line.startswith("jogto") for line in fake.received_lines) == 1


@pytest.mark.parametrize("cartesian", [False, True])
def test_a_milling_group_at_speed_0_is_refused_before_a_line_is_made(cartesian):
    kinds = CartesianStreamer if cartesian else Streamer
    streamer = kinds(spindle=Spindle(spinup=0.0))
    job = job_of(
        Group(label="iso", power=500, speed=100, paths=[[(10.0, 0.0), (11.0, 0.0)]]),
        Group(label="still", power=0, speed=100, paths=[[(12.0, 0.0), (13.0, 0.0)]]),
    )
    with pytest.raises(ValueError, match="still: a spindle needs a speed above 0"):
        next(iter(streamer.job_pieces(job, (0.0, 0.0))))
    # A disabled one is not run, and a laser's power 0 is only a trace.
    job.groups[1].enabled = False
    assert mill(streamer, job)[-1] == "spindle off"
    job.groups[1].enabled = True
    assert any(line.endswith("S0") for line in mill(kinds(), job))


def test_a_milling_run_at_speed_0_is_refused_before_anything_is_sent(client, fake):
    fake.settings["spindle"] = 1
    fake.settings["h_axis"] = 1
    connect(client)
    job = job_of(Group(label="iso", power=0, speed=100, paths=[[(10.0, 0.0), (11.0, 0.0)]]))
    response = client.post("/api/jobs", files={"file": ("mill.json", job.model_dump_json(), "application/json")})
    assert response.status_code == 200, response.text
    response = client.post(f"/api/jobs/{response.json()['id']}/run")
    assert response.status_code == 400
    assert "speed above 0" in response.json()["detail"]
    assert not any(line.split()[0] in ("go", "cut", "spindle", "dwell") for line in fake.received_lines)


def test_a_polar_milling_run_sends_no_laser_words(client, fake):
    fake.settings["spindle"] = 1
    fake.settings["h_axis"] = 1
    connect(client)
    job = job_of(Group(label="iso", power=600, speed=150, paths=[[(10.0, 0.0), (0.0, 10.0)]]))
    response = client.post("/api/jobs", files={"file": ("mill.json", job.model_dump_json(), "application/json")})
    assert response.status_code == 200, response.text
    response = client.post(f"/api/jobs/{response.json()['id']}/run")
    assert response.status_code == 200, response.text
    deadline = time.monotonic() + 10.0
    while client.get("/api/run").json()["state"] == "running":
        assert time.monotonic() < deadline
        time.sleep(0.01)
    assert client.get("/api/run").json()["state"] == "done", client.get("/api/run").json()
    cuts = [line for line in fake.received_lines if line.startswith("cut R")]
    assert len(cuts) > 3
    assert not any("S" in words(line) or "M" in words(line) for line in cuts)
    assert fake.spindle == 0


# --- the fake keeps the firmware's rules -----------------------------------------


def fake_link(fake: FakeSerial) -> Link:
    link = Link("fake://", open_port=fake_opener(fake), poll=False)
    link.open()
    return link


@pytest.mark.parametrize("cartesian", [0, 1])
def test_the_fake_keeps_the_spindle_rules_in_both_modes(cartesian):
    fake = FakeSerial(move_time=0.002)
    fake.settings.update(spindle=1, h_axis=1, cartesian=cartesian)
    link = fake_link(fake)
    try:
        assert link.request("cut R5 F100")[-1] == "error:5 not now", "never started"
        assert link.request("cut R5 F100 S500")[-1] == "error:2 bad word"
        assert link.request("dwell T10 S5")[-1] == "error:2 bad word"
        assert link.request("laser S5")[-1] == "error:2 bad word"
        assert link.request("spindle S500")[-1] == "ok"
        assert link.request("cut R5 F100")[-1] == "ok"
        assert link.request("cut R6 F100 M10")[-1] == "error:2 bad word"
        assert link.request("laser off")[-1] == "ok"
        assert fake.spindle == 0, "laser off stops the spindle"
        assert link.request("cut R7 F100")[-1] == "error:5 not now"
        assert link.request("spindle S0")[-1] == "ok"
        assert link.request("cut R7 F100")[-1] == "error:5 not now", "a speed of 0 is stopped"
        assert fake.joint[0] == 5.0
        assert link.request("spindle S300")[-1] == "ok"
        assert link.request("$spindle=0")[-1] == "ok"
        assert fake.spindle == 0, "a change of what the output drives stops it"
    finally:
        link.close()


def test_the_fake_reports_the_spindle_as_its_duty_and_stops_it_on_an_alarm():
    fake = FakeSerial(move_time=0.002)
    fake.settings.update(spindle=1, h_axis=1, s_max=500)
    link = fake_link(fake)
    try:
        assert link.request("spindle S100")[-1] == "ok"
        assert link.status_now(1.0).laser == 200
        fake.settings["laser_invert"] = 1
        assert link.status_now(1.0).laser == 800
        # The probe may be the tool: not while it turns.
        assert link.request("probe H-1")[-1] == "error:5 not now"
        assert link.request("spindle off")[-1] == "ok"
        assert link.status_now(1.0).laser == 1000, "stopped is full duty on an inverted output"
        fake.spindle = 100
        fake.settings["spindle"] = 1
        assert link.request("probe H-1")[-1] == "error:5 not now"
        fake.spindle = 0
        assert link.request("probe H-1")[-1] == "error:11 probe missed"
        assert link.request("spindle S100")[-1] == "error:5 not now", "not in an alarm"
        assert link.request("spindle off")[-1] == "ok"
    finally:
        link.close()


def test_the_fake_ends_a_probe_waiting_behind_a_cancelled_jog():
    fake = FakeSerial(move_time=2.0)
    fake.settings["h_axis"] = 1
    fake.surface = lambda x, y: -5.0
    link = fake_link(fake)
    try:
        assert link.request("jog R5")[-1] == "ok"
        probe = link.send("probe H-1")
        assert not probe.wait(0.2), "a probe waits for the jog ahead of it"
        link.realtime(REALTIME_JOG_CANCEL)
        assert probe.wait(1.0)
        assert probe.lines == ["[PRB:0.0000:0]"] and probe.response == "ok"
        assert fake.alarm is None and fake.h == 0.0
    finally:
        link.close()


def test_the_fake_moves_no_axis_for_a_line_it_refuses():
    fake = FakeSerial(move_time=0.002)
    fake.settings.update(h_axis=1, r_max=50)
    link = fake_link(fake)
    try:
        assert link.request("go R100 H1")[-1] == "error:4 out of range"
        assert fake.h == 0.0
    finally:
        link.close()


def test_a_typed_spindle_off_during_a_milling_run_stops_the_run(client, fake):
    # Sent as typed it would wait for the queue, stop the spindle part way
    # through the job, and leave the cuts behind it to a still tool.
    fake.settings["spindle"] = 1
    fake.settings["h_axis"] = 1
    connect(client)
    # Answered slowly, so the job is still streaming when the line is typed.
    fake.ok_delay = 0.03
    fake.move_time = 0.2
    job = job_of(Group(label="iso", power=600, speed=150, passes=4, paths=[square(10.0, 0.0, 4.0)]))
    response = client.post("/api/jobs", files={"file": ("mill.json", job.model_dump_json(), "application/json")})
    job_id = response.json()["id"]
    assert client.post(f"/api/jobs/{job_id}/run").status_code == 200
    deadline = time.monotonic() + 5.0
    while fake.spindle == 0:
        assert time.monotonic() < deadline, "the run never started the spindle"
        time.sleep(0.005)
    response = client.post("/api/command", json={"line": "spindle off ; now"})
    assert response.status_code == 200, response.text
    assert client.get("/api/run").json()["state"] == "stopped"
    assert "spindle off ; now" not in fake.received_lines and "spindle off" not in fake.received_lines
    assert 0x18 in fake.realtime_bytes and fake.spindle == 0
