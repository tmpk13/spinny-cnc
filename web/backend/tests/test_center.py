"""The centering test burn built by the backend, as `spinny-center` would write it."""

from __future__ import annotations

import math

import pytest
from fastapi.testclient import TestClient

from spinny_laser import center as coarse_pattern
from spinny_laser import fine as fine_pattern
from spinny_web.app import Backend, create_app
from spinny_web.center import CenterRequest, build
from spinny_web.jobs import JobImportError
from spinny_web.kinematics import Streamer


@pytest.fixture
def client(tmp_path):
    backend = Backend(root=tmp_path, jobs_dir=tmp_path / "jobs", config_path=tmp_path / "config.json")
    app = create_app(backend, frontend=tmp_path / "no-dist")
    with TestClient(app) as client:
        client.backend = backend
        yield client


def test_the_default_is_the_coarse_pattern_of_the_command_line():
    result = build(CenterRequest(), Streamer(), 400.0)
    want = coarse_pattern.build(4, 6.0, 8.0, 400.0, 200.0, 400.0)
    assert [g.label for g in result.job.groups] == [g.label for g in want]
    spokes = result.job.groups[0]
    assert len(spokes.paths) == 4
    assert all(math.isclose(math.hypot(*path[-1]), 6.0) for path in spokes.paths)
    ring = result.job.groups[1]
    # The ring is paced at what the table can turn at 8 mm.
    assert ring.speed == pytest.approx(coarse_pattern.ring_speed(8.0, 200.0, 400.0))
    assert ring.speed < 200.0
    assert result.job.source == "center" and result.job.stats.length_mm > 0
    assert any("mm/min, not 200" in note for note in result.notes)


def test_options_reach_the_coarse_pattern():
    result = build(CenterRequest(lines=6, reach=4.0, ring=0.0, power=250.0, speed=150.0), Streamer(), None)
    assert len(result.job.groups) == 1
    group = result.job.groups[0]
    assert len(group.paths) == 6 and group.power == 250.0 and group.speed == 150.0
    assert all(math.isclose(math.hypot(*path[-1]), 4.0) for path in group.paths)


def test_the_fine_pattern_is_joint_space_and_matches_the_command_line():
    result = build(CenterRequest(fine=True), Streamer(tolerance=0.005), 400.0)
    want = fine_pattern.build(fine_pattern.Design(), 400.0, 200.0, 400.0, 0.005)
    assert [g.label for g in result.job.groups] == [g.label for g in want]
    for got, expected in zip(result.job.groups, want):
        assert got.joints and len(got.joints) == len(expected.joints)
        assert got.paths
    # The head runs past the axis.
    assert min(r for g in result.job.groups for poly in g.joints for r, _ in poly) < 0
    assert any("gain" in line for line in result.summary)


def test_show_error_moves_the_preview_not_the_cuts():
    plain = build(CenterRequest(fine=True), Streamer(), 400.0).job
    shown = build(CenterRequest(fine=True, show_error=(0.02, 0.01)), Streamer(), 400.0)
    assert [g.joints for g in shown.job.groups] == [g.joints for g in plain.groups]
    assert shown.job.groups[0].paths != plain.groups[0].paths
    assert any("arm crossings" in line for line in shown.summary)


@pytest.mark.parametrize(
    "request_",
    [
        CenterRequest(lines=1),
        CenterRequest(lines=0, ring=0.0),
        CenterRequest(show_error=(0.1, 0.0)),
        CenterRequest(fine=True, cross=1.0, arm=2.0),
        CenterRequest(fine=True, angle=45.0),
        CenterRequest(speed=0.0),
    ],
)
def test_options_the_tool_refuses_are_refused(request_):
    with pytest.raises(JobImportError) as info:
        build(request_, Streamer(), 400.0)
    assert "--" not in str(info.value)


def test_power_over_s_max_is_refused_once_it_is_known():
    with pytest.raises(JobImportError, match="s_max"):
        build(CenterRequest(power=900.0), Streamer(), 400.0, s_max=800.0)
    build(CenterRequest(power=900.0), Streamer(), 400.0)


def test_the_route_stores_the_job(client):
    response = client.post("/api/center", json={"fine": True, "spiral": 0.0})
    assert response.status_code == 200, response.text
    data = response.json()
    job = data["job"]
    assert job["id"] and data["notes"] and data["summary"]
    assert len(job["groups"]) == 2
    listed = client.get("/api/jobs").json()["jobs"]
    assert [entry["id"] for entry in listed] == [job["id"]]
    assert client.get(f"/api/jobs/{job['id']}").json()["groups"][0]["joints"]


def test_the_route_refuses_bad_options(client):
    assert client.post("/api/center", json={"lines": 1}).status_code == 400
    assert client.post("/api/center", json={"lines": -1}).status_code == 422
    assert client.post("/api/center", json={"reach": 0}).status_code == 422
    assert client.get("/api/jobs").json()["jobs"] == []
