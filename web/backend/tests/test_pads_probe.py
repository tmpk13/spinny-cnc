"""Probing at a job's pads: the pad map and the routes that make it."""

from __future__ import annotations

import time

import pytest
from fake_serial import FakeSerial, fake_opener
from fastapi.testclient import TestClient

from spinny_web.app import Backend, create_app
from spinny_web.heightmap import HeightMap, nearest_clear_point, pad_grid
from spinny_web.jobs import Group, Job
from spinny_web.link import Link


def surface(x: float, y: float) -> float:
    return -1.5 + 0.01 * x - 0.02 * y


def test_a_pad_map_reads_its_pads_exactly_and_a_plane_between_them():
    points = [(0.0, 0.0), (20.0, 0.0), (0.0, 20.0), (20.0, 20.0), (7.0, 11.0)]
    heightmap = HeightMap.for_points(points, (0.0, 0.0, 20.0, 20.0))
    assert heightmap.is_pad_map and heightmap.wanted == 5 and not heightmap.complete
    assert heightmap.remaining() == [(i, -1) for i in range(5)]
    assert heightmap.grid.x0 == -1.0 and heightmap.grid.x1 == 21.0 and heightmap.grid.nx == 12
    for i, point in enumerate(points):
        heightmap.record((i, -1), surface(*point))
    assert heightmap.complete and heightmap.probed == 5
    assert heightmap.height_at(7.0, 11.0) == pytest.approx(surface(7.0, 11.0), abs=1e-9)
    assert heightmap.height_at(3.0, 17.0) == pytest.approx(surface(3.0, 17.0), abs=1e-9)
    assert heightmap.height_at(-1.0, 21.0) == pytest.approx(surface(-1.0, 21.0), abs=1e-9)
    assert heightmap.heights[0][0] == pytest.approx(surface(-1.0, -1.0), abs=1e-4)
    assert heightmap.cell_probed(10.0, 10.0) and heightmap.span() == (pytest.approx(-1.9), pytest.approx(-1.3))
    # A bump at one pad shows there and fades away from it.
    heightmap.record((4, -1), surface(7.0, 11.0) + 0.1)
    assert heightmap.height_at(7.0, 11.0) == pytest.approx(surface(7.0, 11.0) + 0.1, abs=1e-6)
    assert abs(heightmap.height_at(19.0, 1.0) - surface(19.0, 1.0)) < 0.03


def test_two_pads_read_between_them_and_a_pad_map_checks_its_shape():
    heightmap = HeightMap.for_points([(0.0, 0.0), (10.0, 0.0)], (0.0, 0.0, 10.0, 0.0))
    heightmap.record((0, -1), -1.0)
    heightmap.record((1, -1), -2.0)
    assert heightmap.height_at(5.0, 0.0) == pytest.approx(-1.5)
    assert heightmap.height_at(0.0, 0.0) == -1.0 and heightmap.height_at(10.0, 0.0) == -2.0
    assert pad_grid((0.0, 0.0, 0.5, 0.5)).nx == 3
    broken = heightmap.model_copy(update={"point_heights": [None]})
    with pytest.raises(ValueError, match="one entry per point"):
        broken.check()
    with pytest.raises(ValueError, match="at least one pad"):
        HeightMap.for_points([], (0.0, 0.0, 1.0, 1.0))


def test_the_nearest_clear_point_of_a_pad_map_is_a_probed_pad():
    job = Job(groups=[Group(label="cut", paths=[[(0.0, -5.0), (0.0, 5.0)]])])
    heightmap = HeightMap.for_points([(0.5, 0.0), (6.0, 0.0), (12.0, 0.0)], (0.0, -5.0, 12.0, 5.0))
    heightmap.record((0, -1), -1.0)
    heightmap.record((1, -1), -1.0)
    found = nearest_clear_point(heightmap, job, (1.0, 0.0), 2.0)
    assert found is not None and found[0] == (1, -1) and found[1] == (6.0, 0.0) and found[2] == pytest.approx(5.0)


@pytest.fixture
def fake():
    fake = FakeSerial(move_time=0.002)
    fake.settings.update({"h_axis": 1, "cartesian": 1, "z_max": 100, "r_max": 100})
    fake.surface = surface
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


def wait_probe(client, timeout: float = 20.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        state = client.get("/api/heightmap").json()
        probe = state["probe"]
        if probe is not None and probe["state"] != "running":
            return state
        time.sleep(0.02)
    raise AssertionError("probing did not end")


def padded_job() -> Job:
    pads = [(x, y, 0.25 if (x, y) == (10.0, 10.0) else 1.0) for x in (0.0, 10.0, 20.0) for y in (0.0, 10.0)]
    return Job(
        groups=[Group(label="isolation", paths=[[(0.0, 2.0), (20.0, 2.0)]])],
        pads=pads,
    )


def test_pads_are_planned_then_probed_into_a_pad_map(client, fake):
    stored = client.post("/api/jobs", files={"file": ("padded.json", padded_job().model_dump_json().encode())}).json()
    assert len(stored["pads"]) == 6
    plan = client.post("/api/heightmap/pads/plan", json={"job": stored["id"], "min_area": 0.5}).json()
    assert plan["pads"] == 6 and plan["skipped"] == 1 and len(plan["points"]) == 5 and plan["seconds"] > 0
    assert plan["points"][0] == [0.0, 0.0]
    spread = client.post("/api/heightmap/pads/plan", json={"job": stored["id"], "min_area": 0.5, "max_points": 3}).json()
    assert len(spread["points"]) == 3
    # Starting lifts the probe where the head is: raise it first.
    fake.h = 3.0
    response = client.post("/api/heightmap/pads", json={"job": stored["id"], "min_area": 0.5})
    assert response.status_code == 200, response.text
    state = wait_probe(client)
    assert state["probe"]["state"] == "done", state["probe"]
    heightmap = state["map"]
    assert len(heightmap["points"]) == 5 and all(h is not None for h in heightmap["point_heights"])
    for (x, y), h in zip(heightmap["points"], heightmap["point_heights"]):
        assert h == pytest.approx(surface(x, y), abs=1e-3)
    # The grid is filled in from the pads.
    assert all(value is not None for row in heightmap["heights"] for value in row)
    assert client.get("/api/heightmap").json()["probe"]["pad"] is None
    # A run follows the pad map as it follows a grid: the H words follow the surface.
    response = client.post("/api/heightmap/focus", json={"offset": 1.0})
    assert response.status_code == 200, response.text
    fake.received_lines.clear()
    response = client.post(f"/api/jobs/{stored['id']}/run", json={"compensate": "focus"})
    assert response.status_code == 200, response.text
    deadline = time.monotonic() + 20.0
    while time.monotonic() < deadline and client.get("/api/run").json()["state"] == "running":
        time.sleep(0.02)
    assert client.get("/api/run").json()["state"] == "done"
    cuts = [line for line in fake.received_lines if line.startswith("cut ")]
    heights = [float(word[1:]) for line in cuts for word in line.split() if word.startswith("H")]
    assert heights and heights[0] == pytest.approx(surface(0.0, 2.0) + 1.0, abs=0.02) and heights[-1] == pytest.approx(surface(20.0, 2.0) + 1.0, abs=0.02)


def test_pad_probing_is_refused_without_pads_and_resumes_a_pad_map(client, fake):
    bare = Job(groups=[Group(label="cut", paths=[[(0.0, 0.0), (1.0, 0.0)]])])
    stored = client.post("/api/jobs", files={"file": ("bare.json", bare.model_dump_json().encode())}).json()
    response = client.post("/api/heightmap/pads/plan", json={"job": stored["id"]})
    assert response.status_code == 400 and "no pads" in response.json()["detail"]
    assert client.post("/api/heightmap/pads/plan", json={"job": "nope"}).status_code == 404
    assert client.post("/api/heightmap/pads", json={"resume": True}).status_code == 400
    padded = client.post("/api/jobs", files={"file": ("padded.json", padded_job().model_dump_json().encode())}).json()
    response = client.post("/api/heightmap/pads/plan", json={"job": padded["id"], "min_area": 5.0})
    assert response.status_code == 400 and "lower the least area" in response.json()["detail"]
    # A pad map put back part probed goes on with the pads it lacks.
    heightmap = HeightMap.for_points([(0.0, 0.0), (10.0, 0.0), (20.0, 0.0)], (0.0, 0.0, 20.0, 0.0))
    heightmap.record((0, -1), surface(0.0, 0.0))
    client.backend.heightmaps.put(heightmap)
    client.backend._heights_frame = client.backend._frame
    plan = client.post("/api/heightmap/pads/plan", json={"resume": True}).json()
    assert plan["resume"] == 1 and plan["points"] == [[10.0, 0.0], [20.0, 0.0]]
    fake.h = 3.0
    assert client.post("/api/heightmap/pads", json={"resume": True}).status_code == 200
    state = wait_probe(client)
    assert state["probe"]["state"] == "done" and state["probe"]["total"] == 3
    assert state["map"]["point_heights"][2] == pytest.approx(surface(20.0, 0.0), abs=1e-3)
