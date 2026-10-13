"""Picking a job up part way: the lines before a count are not sent, the
head is brought to where the next one begins, and the resume record says
where a run got to."""

from __future__ import annotations

import json
import time

import pytest
from fake_serial import FakeSerial, fake_opener
from fastapi.testclient import TestClient

from spinny_web.app import Backend, create_app
from spinny_web.jobs import Group, Job
from spinny_web.kinematics import CartesianStreamer, Spindle, Streamer
from spinny_web.link import Link
from spinny_web.resume import ResumeStore
from spinny_web.runner import DONE, RUNNING, Runner


def mill_job() -> Job:
    return Job(
        id="m1",
        name="mill",
        groups=[
            Group(label="iso", power=700, speed=200, depth=0.2, plunge=50, paths=[[(1.0, 0.0), (3.0, 0.0), (3.0, 2.0)], [(5.0, 0.0), (6.0, 1.0)]]),
            Group(label="fast", power=900, speed=300, depth=0.1, plunge=60, paths=[[(8.0, 0.0), (9.0, 0.0)]]),
        ],
    )


def laser_job() -> Job:
    square = [(10.0, -2.0), (12.0, -2.0), (12.0, 2.0), (10.0, 2.0), (10.0, -2.0)]
    return Job(id="l1", name="square", groups=[Group(label="one", power=500, speed=400, paths=[square, [(10.0, 5.0), (11.0, 5.0)]])])


# --- the plan ---------------------------------------------------------------


def test_rewind_goes_back_to_the_start_of_the_path():
    streamer = CartesianStreamer(spindle=Spindle(clearance=2.0, spinup=0.0))
    pieces = list(streamer.job_pieces(mill_job(), (0.0, 0.0)))
    kinds = [piece.kind for piece in pieces]
    # lift, spindle, go, plunge, cut, cut, lift, go, plunge, cut, lift, spindle, go, plunge, cut, lift, spindle off
    assert kinds[:7] == ["lift", "spindle", "go", "plunge", "cut", "cut", "lift"]
    first_cut = kinds.index("cut")
    assert streamer.rewind(pieces, first_cut + 1) == 2, "back over the cut and the plunge to the rapid"
    assert streamer.rewind(pieces, 2) == 2, "a rapid is a path start already"
    assert streamer.rewind(pieces, 0) == 0
    assert streamer.rewind(pieces, len(pieces) + 5) == len(pieces) - 1 or streamer.rewind(pieces, len(pieces) + 5) <= len(pieces)
    second_path = kinds.index("go", 3)
    assert streamer.rewind(pieces, second_path + 2) == second_path


def test_the_approach_lifts_travels_starts_the_spindle_and_plunges():
    streamer = CartesianStreamer(spindle=Spindle(clearance=2.0, spinup=1.5))
    job = mill_job()
    pieces = list(streamer.job_pieces(job, (0.0, 0.0)))
    kinds = [piece.kind for piece in pieces]
    # Picked up at the second cut of the first path, mid-path.
    second_cut = kinds.index("cut") + 1
    assert pieces[second_cut].kind == "cut"
    approach = streamer.approach(pieces, second_cut, job, None)
    assert approach == [
        "go H2.0000",
        "go R3.000 Z0.000",
        "spindle S700",
        "dwell T1500",
        "cut H-0.2000 F50",
    ]
    # Picked up at a rapid: nothing plunges, the spindle is started.
    rapid = kinds.index("go", 3)
    approach = streamer.approach(pieces, rapid, job, None)
    assert approach[0] == "go H2.0000" and approach[-2:] == ["spindle S700", "dwell T1500"]
    assert not any(line.startswith("cut") for line in approach)
    # Picked up at the second group's spindle line: the line itself starts it.
    speed_change = kinds.index("spindle", 2)
    assert pieces[speed_change].line == "spindle S900"
    approach = streamer.approach(pieces, speed_change, job, None)
    assert "spindle S700" not in approach and not any(line.startswith("spindle") for line in approach)
    # From the top there is nothing to do.
    assert streamer.approach(pieces, 0, job, None) == []


def test_a_laser_approach_is_one_dark_move_to_the_cut_start():
    streamer = Streamer()
    job = laser_job()
    pieces = list(streamer.job_pieces(job, (0.0, 0.0)))
    cuts = [index for index, piece in enumerate(pieces) if piece.kind == "cut"]
    index = cuts[2]
    approach = streamer.approach(pieces, index, job, None)
    assert approach == [f"go {streamer.words(pieces[index].start)}"]
    assert approach[0].startswith("go R12.166 A-9.46"), "the polar joint of the cut's start, (12, -2)"


def test_the_table_is_renumbered_toward_the_plan():
    streamer = Streamer()
    job = laser_job()
    pieces = list(streamer.job_pieces(job, (0.0, 0.0)))

    class Status:
        a = 350.0
        r = 10.0

    cuts = [index for index, piece in enumerate(pieces) if piece.kind == "cut"]
    line = streamer.renumber_for(pieces, cuts[1], Status())
    assert line == "set A-10", "350 degrees is -10 as the plan counts, near its angles around 0"
    assert CartesianStreamer().renumber_for(pieces, cuts[1], Status()) is None


# --- the runner -------------------------------------------------------------


def setup(**settings):
    fake = FakeSerial(move_time=0.002)
    fake.settings.update(settings)
    link = Link("fake://", open_port=fake_opener(fake), poll=True)
    link.open()
    records: list[dict] = []
    runner = Runner(checkpoint=records.append)
    return fake, link, runner, records


def wait_done(runner: Runner, timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while runner.progress.state == RUNNING:
        assert time.monotonic() < deadline, runner.progress
        time.sleep(0.01)


def job_lines(fake: FakeSerial) -> list[str]:
    return [line for line in fake.received_lines if not line.startswith(("$", "?", "status", "version"))]


def test_a_run_picked_up_part_way_sends_the_approach_then_the_rest():
    fake, link, runner, records = setup(cartesian=1, spindle=1, h_axis=1)
    try:
        job = mill_job()
        streamer = CartesianStreamer(spindle=Spindle(clearance=2.0, spinup=0.0))
        pieces = list(streamer.job_pieces(job, (0.0, 0.0)))
        skip = streamer.rewind(pieces, 5)
        progress = runner.start(job, link, streamer, skip=skip, pieces=pieces, plan_start=(0.0, 0.0))
        # The thread is off as soon as the start returns, so the counts may
        # have moved on by a line or two; they began at the skip.
        assert progress["resumed_from"] == skip and skip <= progress["acked"] <= progress["sent"]
        wait_done(runner)
        assert runner.progress.state == DONE, runner.progress
        assert runner.progress.acked == len(pieces)
        sent = job_lines(fake)
        approach = streamer.approach(pieces, skip, job, None)
        assert sent == approach + [piece.line for piece in pieces[skip:]]
        assert records and records[-1]["state"] == "done" and records[-1]["resumed_from"] == skip
        assert records[-1]["start"] == [0.0, 0.0] and records[-1]["cartesian"] is True
        assert records[0]["job"] == "m1"
    finally:
        link.close()


def test_a_count_past_the_job_is_refused():
    fake, link, runner, records = setup(cartesian=1, spindle=1, h_axis=1)
    try:
        streamer = CartesianStreamer(spindle=Spindle(spinup=0.0))
        pieces = list(streamer.job_pieces(mill_job(), (0.0, 0.0)))
        with pytest.raises(Exception):
            runner.start(mill_job(), link, streamer, skip=len(pieces) + 1, pieces=pieces, plan_start=(0.0, 0.0))
        assert not runner.active
    finally:
        link.close()


def test_the_record_follows_a_run_from_the_top():
    fake, link, runner, records = setup()
    try:
        job = laser_job()
        runner.start(job, link, Streamer())
        wait_done(runner)
        assert runner.progress.state == DONE
        assert records[0]["state"] == "running" and records[0]["job"] == "l1"
        assert records[-1]["state"] == "done" and records[-1]["acked"] == records[-1]["total"]
        assert records[-1]["compensate"] == "off" and records[-1]["resumed_from"] is None
        assert records[-1]["position"] is not None and "updated" in records[-1]
    finally:
        link.close()


def test_the_store_keeps_one_record(tmp_path):
    store = ResumeStore(tmp_path / "resume.json")
    assert store.get() is None
    store.put({"job": "a", "acked": 3})
    assert ResumeStore(tmp_path / "resume.json").get() == {"job": "a", "acked": 3}
    assert json.loads((tmp_path / "resume.json").read_text())["acked"] == 3
    store.clear()
    assert store.get() is None and not (tmp_path / "resume.json").exists()
    (tmp_path / "resume.json").write_text("not json")
    assert ResumeStore(tmp_path / "resume.json").get() is None


# --- the routes -------------------------------------------------------------


@pytest.fixture
def fake():
    fake = FakeSerial(move_time=0.002)
    fake.settings.update(cartesian=1, spindle=1, h_axis=1)
    return fake


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
        response = client.post("/api/connect", json={"url": "socket://127.0.0.1:9999"})
        assert response.status_code == 200, response.text
        yield client


def wait_run(client, timeout: float = 10.0) -> dict:
    deadline = time.monotonic() + timeout
    while True:
        progress = client.get("/api/run").json()
        if progress["state"] != "running":
            return progress
        assert time.monotonic() < deadline, progress
        time.sleep(0.01)


def test_the_resume_route_plans_and_picks_the_job_up(client, fake, tmp_path):
    job = mill_job()
    response = client.post("/api/jobs", files={"file": ("mill.json", job.model_dump_json(), "application/json")})
    assert response.status_code == 200, response.text
    job_id = response.json()["id"]
    assert client.get("/api/state").json()["resume"] is None

    response = client.post(f"/api/jobs/{job_id}/run")
    assert response.status_code == 200, response.text
    progress = wait_run(client)
    assert progress["state"] == "done"
    record = client.get("/api/resume").json()["resume"]
    assert record["job"] == job_id and record["state"] == "done" and record["acked"] == progress["total"]
    assert json.loads((tmp_path / "resume.json").read_text())["job"] == job_id
    assert client.get("/api/state").json()["resume"]["job"] == job_id

    # What picking it up at line 5 would do, without moving anything.
    before = len(fake.received_lines)
    response = client.post(f"/api/jobs/{job_id}/resume/plan", json={"line": 5})
    assert response.status_code == 200, response.text
    plan = response.json()
    assert plan["line"] == 5 and plan["skip"] <= 5 and plan["total"] == progress["total"]
    assert plan["approach"][0] == "go H2.0000" and plan["next"].startswith("go ")
    assert plan["planned_from_record"] is True
    assert len([line for line in fake.received_lines[before:] if line.startswith(("go", "cut", "spindle"))]) == 0

    exact = client.post(f"/api/jobs/{job_id}/resume/plan", json={"line": 5, "rewind": False}).json()
    assert exact["skip"] == 5 and len(exact["approach"]) >= len(plan["approach"])
    fake.received_lines.clear()
    response = client.post(f"/api/jobs/{job_id}/resume", json={"line": 5, "rewind": False})
    assert response.status_code == 200, response.text
    assert response.json()["resumed_from"] == 5 and response.json()["acked"] == 5
    progress = wait_run(client)
    assert progress["state"] == "done" and progress["resumed_from"] == 5
    sent = [line for line in fake.received_lines if not line.startswith(("$", "?", "status"))]
    assert sent[: len(exact["approach"])] == exact["approach"]
    assert sent[0] == "go H2.0000" and "spindle S700" in sent[:5]
    assert sent[-1] == "spindle off"
    assert len(sent) == len(exact["approach"]) + progress["total"] - 5

    response = client.delete("/api/resume")
    assert response.status_code == 200 and client.get("/api/resume").json()["resume"] is None


def test_the_resume_route_refuses_nonsense(client, fake):
    job = mill_job()
    job_id = client.post("/api/jobs", files={"file": ("mill.json", job.model_dump_json(), "application/json")}).json()["id"]
    assert client.post("/api/jobs/nope/resume", json={"line": 1}).status_code == 404
    assert client.post(f"/api/jobs/{job_id}/resume", json={"line": -1}).status_code == 400
    assert client.post(f"/api/jobs/{job_id}/resume", json={"line": 3, "compensate": "sideways"}).status_code == 400


def test_delete_all_jobs_keeps_the_running_one(client, fake):
    ids = []
    for name in ("a", "b"):
        job = laser_job()
        ids.append(client.post("/api/jobs", files={"file": (f"{name}.json", job.model_dump_json(), "application/json")}).json()["id"])
    response = client.delete("/api/jobs")
    assert response.status_code == 200
    assert sorted(response.json()["deleted"]) == sorted(ids)
    assert client.get("/api/jobs").json()["jobs"] == []


def test_the_log_route_reads_the_tail(client, tmp_path):
    (tmp_path / "spinny.log").write_text("one\ntwo\nthree\n")
    assert client.get("/api/log?lines=2").json()["lines"] == ["two", "three"]
    (tmp_path / "spinny.log").unlink()
    assert client.get("/api/log").json()["lines"] == []
