"""A 3D model's job: made from an STL through the CAM routes, its moves
streamed on the cartesian spindle machine, priced, moved, written as
gcode, and refused where it cannot run."""

from __future__ import annotations

import shutil
from pathlib import Path

import models
import pytest
from fake_serial import FakeSerial, fake_opener
from fastapi.testclient import TestClient

from spinny_laser import carve
from spinny_web.app import Backend, create_app
from spinny_web.jobs import Group, Job, JobImportError, from_json
from spinny_web.kinematics import MOVE_FEED, MOVE_PLUNGE, MOVE_RAPID, CartesianStreamer, Rates, Spindle, Streamer
from spinny_web.link import Link

REPO = Path(__file__).resolve().parents[3]
SHIPPED = REPO / "cam"

needs_kernel = pytest.mark.skipif(carve.find() is None, reason="the 3D kernel is not built: mise run build-carve")


@pytest.fixture
def client(tmp_path):
    cam_dir = tmp_path / "cam"
    cam_dir.mkdir()
    shutil.copy(SHIPPED / "mill-3d.toml", cam_dir / "mill-3d.toml")
    fake = FakeSerial(move_time=0.002)
    backend = Backend(
        root=tmp_path,
        link_factory=lambda url: Link(url, open_port=fake_opener(fake)),
        jobs_dir=tmp_path / "jobs",
        config_path=tmp_path / "config.json",
        cam_dir=cam_dir,
    )
    app = create_app(backend, frontend=tmp_path / "no-dist")
    with TestClient(app) as client:
        yield client


def upload(client, path: Path) -> dict:
    files = [("files", (path.name, path.read_bytes(), "application/octet-stream"))]
    response = client.post("/api/cam/mill-3d/jobs", files=files)
    assert response.status_code == 200, response.text
    return response.json()


@needs_kernel
def test_an_stl_through_the_3d_profile_is_a_job_of_moves(client, tmp_path):
    answer = upload(client, models.plate(tmp_path / "plate.stl"))
    job = answer["job"]
    assert job["source"] == "stl" and job["name"] == "plate"
    labels = [group["label"] for group in job["groups"]]
    assert labels == ["rough: 3 mm end mill", "surfaces: 2 mm ball end mill", "walls: 3 mm end mill"]
    rough = job["groups"][0]
    assert rough["tool"] == "spindle" and rough["paths"] == [] and rough["moves"]
    assert rough["power"] == 12000 and rough["depth"] == pytest.approx(6.2)
    assert job["groups"][2]["depth"] == pytest.approx(6.5)
    assert all(path[0][3] == MOVE_RAPID for path in rough["moves"])
    assert {m[3] for path in rough["moves"] for m in path} <= {MOVE_RAPID, MOVE_FEED, MOVE_PLUNGE}
    # Priced by the moves' feeds: no machine here runs a model's moves.
    assert job["stats"]["seconds"] > 60.0 and job["stats"]["length_mm"] > 1000.0
    assert any("6061 aluminum" in note for note in answer["notes"])
    listed = client.get("/api/jobs").json()
    summary = next(item for item in (listed["jobs"] if isinstance(listed, dict) else listed) if item["id"] == job["id"])
    assert summary["groups"][0]["moves"] == len(rough["moves"])


@needs_kernel
def test_a_model_job_is_written_as_gcode(client, tmp_path):
    job = upload(client, models.plate(tmp_path / "plate.stl"))["job"]
    answer = client.post("/api/cam/mill-3d/gcode", json={"job": job["id"]})
    assert answer.status_code == 200, answer.text
    written = answer.json()
    assert written["filename"] == "plate.nc"
    assert written["text"].startswith("(plate: 2 operations through 3D mill)")
    assert written["report"]["extents"]["Z"][0] == pytest.approx(-6.5)
    assert written["report"]["warnings"] == []


def carved(*paths: list[tuple[float, float, float, int]], speed: float = 200.0) -> Job:
    return Job(name="t", groups=[Group(label="model", power=800, speed=speed, plunge=50, depth=1.0, tool="spindle", moves=list(paths))])


def lines(streamer: Streamer, job: Job, compensation=None) -> list[str]:
    return [piece.line for piece in streamer.job_pieces(job, (0.0, 0.0), compensation)]


def test_a_model_path_comes_down_from_the_travel_height_and_feeds_along_its_moves():
    streamer = CartesianStreamer(spindle=Spindle(clearance=2.0, spinup=1.5))
    path = [
        (0.0, 0.0, 1.0, MOVE_RAPID),
        (0.0, 0.0, 0.1, MOVE_PLUNGE),
        (10.0, 0.0, -0.5, MOVE_FEED),
        (10.0, 10.0, -0.5, MOVE_FEED),
        (10.0, 10.0, 0.5, MOVE_RAPID),
        (20.0, 0.0, 0.5, MOVE_RAPID),
        (20.0, 0.0, -0.5, MOVE_PLUNGE),
    ]
    # The ramp's feed is along it: the board takes its share.
    board = 200.0 * 10.0 / (10.0**2 + 0.6**2) ** 0.5
    assert lines(streamer, carved(path)) == [
        "go H2.0000",
        "spindle S800",
        "dwell T1500",
        "go H1.0000",
        "cut H0.1000 F50",
        f"cut R10.000 Z0.000 H-0.5000 F{board:.3f}",
        "cut R10.000 Z10.000 H-0.5000 F200",
        "go R10.000 Z10.000 H0.5000",
        "go R20.000 Z0.000 H0.5000",
        "cut H-0.5000 F50",
        "go H2.0000",
        "spindle off",
    ]


def test_every_path_starts_from_the_travel_height():
    streamer = CartesianStreamer(spindle=Spindle(clearance=2.0, spinup=0.0))
    first = [(5.0, 5.0, 0.5, MOVE_RAPID), (6.0, 5.0, -1.0, MOVE_FEED)]
    second = [(30.0, 5.0, 0.5, MOVE_RAPID), (31.0, 5.0, -1.0, MOVE_FEED)]
    out = lines(streamer, carved(first, second))
    assert out[:5] == ["go H2.0000", "spindle S800", "go R5.000 Z5.000", "go H0.5000", out[4]]
    assert out[5:9] == ["go H2.0000", "go R30.000 Z5.000", "go H0.5000", out[8]]
    assert out[-2:] == ["go H2.0000", "spindle off"]


def test_a_height_map_lifts_every_move_by_the_surface_under_it():
    from spinny_web.heightmap import Compensation, Grid, HeightMap

    grid = Grid(x0=0, y0=0, x1=20, y1=20, nx=3, ny=3)
    tilted = HeightMap(grid=grid, heights=[[x * 0.1 for x in grid.xs] for _ in grid.ys], focus_offset=0.0, focus_set=True)
    compensation = Compensation(heightmap=tilted, mode="focus")
    streamer = CartesianStreamer(spindle=Spindle(clearance=1.0, spinup=0.0))
    path = [(0.0, 5.0, 0.5, MOVE_RAPID), (0.0, 5.0, -0.2, MOVE_PLUNGE), (20.0, 5.0, -0.2, MOVE_FEED)]
    pieces = list(streamer.job_pieces(carved(path), (0.0, 0.0), compensation))
    cuts = [piece for piece in pieces if piece.kind == "cut"]
    assert len(cuts) > 1, "the move is split to follow the map"
    for piece in cuts:
        x = piece.joint[0]
        assert piece.h == pytest.approx(x * 0.1 - 0.2, abs=1e-6)


def test_a_model_job_needs_the_cartesian_spindle_machine():
    polar = Streamer(spindle=Spindle())
    with pytest.raises(ValueError, match="cartesian machine"):
        lines(polar, carved([(0.0, 0.0, 1.0, MOVE_RAPID), (1.0, 0.0, -1.0, MOVE_FEED)]))
    laser = CartesianStreamer()
    with pytest.raises(ValueError, match="cut with a spindle"):
        lines(laser, carved([(0.0, 0.0, 1.0, MOVE_RAPID), (1.0, 0.0, -1.0, MOVE_FEED)]))


def test_a_laser_machine_prices_a_model_job_by_its_feeds():
    job = carved([(0.0, 0.0, 1.0, MOVE_RAPID), (0.0, 0.0, 0.0, MOVE_PLUNGE), (60.0, 0.0, 0.0, MOVE_FEED)], speed=600.0)
    job.refresh_stats(Streamer(rates=Rates()))
    assert job.stats.length_mm == pytest.approx(60.0)
    assert job.stats.seconds == pytest.approx(6.0 + 1.0 / 50.0 * 60.0)


def test_a_model_job_moves_and_turns_with_its_moves():
    job = carved([(1.0, 2.0, -0.5, MOVE_FEED)])
    job.shift(10.0, 0.0)
    assert job.groups[0].moves[0][0] == (11.0, 2.0, -0.5, MOVE_FEED)
    job.turn(90.0)
    x, y, z, kind = job.groups[0].moves[0][0]
    assert (x, y, z, kind) == (pytest.approx(-2.0), pytest.approx(11.0), -0.5, MOVE_FEED)
    assert job.groups[0].board_paths() == [[(x, y)]]


def test_a_job_file_with_moves_is_checked():
    good = carved([(0.0, 0.0, 1.0, MOVE_RAPID), (1.0, 0.0, -1.0, MOVE_FEED)])
    assert from_json(good.model_dump_json(), "t").groups[0].moves
    bad = good.model_copy(deep=True)
    bad.groups[0].moves = [[(0.0, 0.0, 1.0, 7)]]
    with pytest.raises(JobImportError, match="kind is 0"):
        from_json(bad.model_dump_json(), "t")
    mixed = good.model_copy(deep=True)
    mixed.groups[0].paths = [[(0.0, 0.0), (1.0, 1.0)]]
    with pytest.raises(JobImportError, match="come alone"):
        from_json(mixed.model_dump_json(), "t")
