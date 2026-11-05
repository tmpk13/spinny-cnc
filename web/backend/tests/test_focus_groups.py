"""A laser group's own focus height, and the focus ladder that uses it."""

from __future__ import annotations

import json
import re
import time

import pytest
from fake_serial import FakeSerial, fake_opener
from fastapi.testclient import TestClient

from spinny_web import calibration
from spinny_web.app import Backend, create_app
from spinny_web.jobs import Group, Job, JobImportError, JobPatch, apply_patch, from_json
from spinny_web.kinematics import Spindle, Streamer
from spinny_web.link import Link

WORD = re.compile(r"([A-Z])(-?\d+(?:\.\d+)?)")


def words(line: str) -> dict[str, float]:
    return {letter: float(value) for letter, value in WORD.findall(line)}


def three_groups() -> Job:
    return Job(groups=[
        Group(label="a", paths=[[(5.0, 0.0), (6.0, 0.0)]]),
        Group(label="b", focus=0.5, paths=[[(5.0, 1.0), (6.0, 1.0)]]),
        # Starts where b ends: no rapid to carry its height.
        Group(label="c", focus=-0.25, paths=[[(6.0, 1.0), (7.0, 1.0)]]),
        Group(label="off", focus=3.0, enabled=False, paths=[[(1.0, 1.0), (2.0, 1.0)]]),
    ])


def test_each_group_burns_at_its_own_height_from_where_the_run_began():
    streamer = Streamer()
    streamer.focus_base = 2.0
    pieces = list(streamer.job_pieces(three_groups(), (0.0, 0.0)))
    heights = [(piece.kind, piece.group, piece.h) for piece in pieces if piece.h is not None]
    # The first group's height is said too, so a pick-up finds it; c gets
    # a lift of its own before its first cut, and the head goes back.
    assert heights == [("go", 0, 2.0), ("go", 1, 2.5), ("lift", 2, 1.75), ("lift", 2, 2.0)]
    assert pieces[0].line == "go R5.000 A0.0000 H2.0000"
    assert pieces[-1].line == "go H2.0000"
    lift = next(piece for piece in pieces if piece.kind == "lift")
    following = pieces[pieces.index(lift) + 1]
    assert following.kind == "cut" and following.group == 2
    # No H on a cut: the head stays where its group put it.
    assert all("H" not in piece.line for piece in pieces if piece.kind == "cut")
    # A job with no focus anywhere sends no H at all.
    plain = Job(groups=[Group(label="a", paths=[[(5.0, 0.0), (6.0, 0.0)]])])
    assert all("H" not in piece.line for piece in streamer.job_pieces(plain, (0.0, 0.0)))


def test_a_price_counts_the_height_changes_without_a_start():
    job = three_groups()
    flat = Job(groups=[group.model_copy(update={"focus": None}) for group in job.groups])
    assert Streamer().estimate(job).seconds > Streamer().estimate(flat).seconds


class FlatMap:
    """A compensation stand-in: the board at focus height 1 everywhere."""

    def __init__(self, mode: str) -> None:
        self.mode = mode
        self.step = 10.0
        self.head_h = 0.0

    def focus(self, point):
        return 1.0

    def scaled(self, power, floor, point):
        return power, floor


def test_on_the_map_a_groups_focus_adds_to_the_maps_focus_height():
    pieces = list(Streamer().job_pieces(three_groups(), (0.0, 0.0), FlatMap("focus")))
    by_group = {}
    for piece in pieces:
        if piece.h is not None and piece.group is not None:
            by_group.setdefault(piece.group, set()).add(round(piece.h, 6))
    assert by_group == {0: {1.0}, 1: {1.5}, 2: {0.75}}
    with pytest.raises(ValueError, match="b asks for a focus height, and following the map by power holds the head still"):
        list(Streamer().job_pieces(three_groups(), (0.0, 0.0), FlatMap("power")))


def test_a_focus_height_is_a_lasers_alone():
    job = three_groups()
    with pytest.raises(ValueError, match="b: a focus height is for a laser's beam; clear it to mill the group"):
        Streamer(spindle=Spindle()).check_job(job)
    job.groups[1].focus = None
    job.groups[2].focus = None
    Streamer(spindle=Spindle()).check_job(job)


def test_a_groups_focus_is_patched_cleared_and_checked():
    job = three_groups()
    patched = apply_patch(job, JobPatch.model_validate({"groups": [{"index": 0, "focus": -1.5}]}), Streamer())
    assert patched.groups[0].focus == -1.5
    # Left out it stays, null takes it away.
    kept = apply_patch(patched, JobPatch.model_validate({"groups": [{"index": 0, "power": 300}]}), Streamer())
    assert kept.groups[0].focus == -1.5
    cleared = apply_patch(kept, JobPatch.model_validate({"groups": [{"index": 0, "focus": None}]}), Streamer())
    assert cleared.groups[0].focus is None
    with pytest.raises(ValueError, match="focus must be within 50 mm"):
        apply_patch(job, JobPatch.model_validate({"groups": [{"index": 0, "focus": 80}]}), Streamer())
    assert job.summary()["groups"][1]["focus"] == 0.5
    with pytest.raises(JobImportError, match="group 'a': focus must be within"):
        from_json(json.dumps({"groups": [{"label": "a", "focus": -60, "paths": [[[0, 0], [1, 0]]]}]}), "j")


def test_the_focus_ladder_is_a_row_of_lines_a_step_from_focus_each():
    request = calibration.CalibrateRequest(kind="focus", focuses=(-0.5, 0.5, 5), power=300, speed=900, length=8, gap=1.5, x=2, y=3)
    result = calibration.build(request, Streamer(), milling=False, focus_axis=True)
    groups = result.job.groups
    assert [group.label for group in groups] == [
        "test focus -0.5 mm", "test focus -0.25 mm", "test focus 0 mm", "test focus +0.25 mm", "test focus +0.5 mm",
    ]
    assert [group.focus for group in groups] == [-0.5, -0.25, 0.0, 0.25, 0.5]
    assert all(group.power == 300 and group.speed == 900 for group in groups)
    assert groups[0].paths == [[(2.0, 3.0), (10.0, 3.0)]]
    assert groups[-1].paths == [[(2.0, 9.0), (10.0, 9.0)]]
    assert result.job.name == "focus ladder"
    with pytest.raises(ValueError, match="has none"):
        calibration.build(request, Streamer(), milling=False, focus_axis=False)
    with pytest.raises(ValueError, match="a mill takes the depth test"):
        calibration.build(request, Streamer(), milling=True, focus_axis=True)
    with pytest.raises(ValueError, match="a focus step must be within"):
        calibration.build(request.model_copy(update={"focuses": (-60.0, 0.0, 2)}), Streamer(), milling=False, focus_axis=True)


@pytest.fixture
def fake():
    fake = FakeSerial(move_time=0.002)
    fake.settings["h_axis"] = 1
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
        response = client.post("/api/connect", json={"url": "socket://127.0.0.1:9999"})
        assert response.status_code == 200, response.text
        yield client


def wait_done(client, timeout: float = 20.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        progress = client.get("/api/run").json()
        if progress["state"] not in ("running", "hold"):
            return progress
        time.sleep(0.05)
    raise AssertionError("the run did not end")


def test_a_focus_ladder_runs_each_line_at_its_height_and_comes_back(client, fake):
    client.get("/api/settings")
    fake.h = 1.25
    made = client.post("/api/calibrate", json={"kind": "focus", "focuses": [-0.5, 0.5, 3], "length": 4, "gap": 1, "x": 3, "y": 0})
    assert made.status_code == 200, made.text
    job = made.json()["job"]
    assert [group["focus"] for group in job["groups"]] == [-0.5, 0.0, 0.5]
    before = len(fake.received_lines)
    response = client.post(f"/api/jobs/{job['id']}/run")
    assert response.status_code == 200, response.text
    assert wait_done(client)["state"] == "done"
    sent = fake.received_lines[before:]
    heights = [words(line)["H"] for line in sent if line.split()[0] in ("go", "cut") and "H" in words(line)]
    assert heights == pytest.approx([0.75, 1.25, 1.75, 1.25])
    assert fake.h == pytest.approx(1.25)
    record = client.get("/api/resume").json()["resume"]
    assert record["start_h"] == pytest.approx(1.25)


def test_a_groups_focus_needs_the_focus_axis(client, fake):
    written = client.put("/api/settings", json={"values": {"h_axis": 0}})
    assert written.status_code == 200, written.text
    assert fake.settings["h_axis"] == 0
    made = client.post("/api/calibrate", json={"kind": "focus"})
    assert made.status_code == 400 and "$h_axis=0" in made.text
    job = client.post("/api/center", json={"reach": 4, "ring": 3}).json()["job"]
    client.patch(f"/api/jobs/{job['id']}", json={"groups": [{"index": 0, "focus": 0.5}]})
    response = client.post(f"/api/jobs/{job['id']}/run")
    assert response.status_code == 409 and "no focus axis" in response.text
