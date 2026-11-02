"""A board's paste openings cut out of a film for a solder paste stencil,
and the stencil cut again for another margin, through the API."""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from spinny_web.app import Backend, create_app

REPO = Path(__file__).resolve().parents[3]
BOARD = REPO / "toolpath" / "tests" / "data" / "board.kicad_pcb"
COPPER = REPO / "toolpath" / "tests" / "data" / "board-F_Cu.gbr"

needs_kicad = pytest.mark.skipif(shutil.which("kicad-cli") is None, reason="kicad-cli not installed")


@pytest.fixture
def client(tmp_path):
    backend = Backend(root=tmp_path, jobs_dir=tmp_path / "jobs", config_path=tmp_path / "config.json")
    with TestClient(create_app(backend, frontend=tmp_path / "no-dist")) as client:
        yield client


def upload(client, path: Path, **fields):
    files = {"file": (path.name, path.read_bytes(), "application/octet-stream")}
    return client.post("/api/jobs", files=files, data={key: str(value) for key, value in fields.items()})


def sides(path) -> tuple[float, float]:
    """The short and the long side of a path's box, mm."""
    xs = [x for x, _ in path]
    ys = [y for _, y in path]
    return tuple(sorted((round(max(xs) - min(xs), 3), round(max(ys) - min(ys), 3))))


@needs_kicad
def test_a_stencil_cuts_round_every_paste_opening_inside_its_edge(client):
    response = upload(client, BOARD, mode="stencil", margin=0.05)
    assert response.status_code == 200, response.text
    job = response.json()
    # Left out, the layer is the paste's.
    assert job["source"] == "kicad" and job["layer"] == "F.Paste"
    openings, outline = job["groups"]
    assert openings["label"] == "paste openings, 0.050 mm margin" and openings["enabled"]
    # The film needs no board's shape unless asked.
    assert outline["label"] == "board outline pass 1" and not outline["enabled"]
    # One loop a pad, each 0.5 x 1.5 mm shrunk by the margin and half the spot.
    assert len(openings["paths"]) == len(job["copper"]) == 32
    assert {sides(path) for path in openings["paths"]} == {(0.3, 1.3)}
    assert job["recipe"]["options"]["mode"] == "stencil" and job["recipe"]["options"]["margin"] == 0.05


@needs_kicad
def test_a_stencil_is_cut_again_for_another_margin_where_it_lies(client):
    job = upload(client, BOARD, mode="stencil").json()
    assert job["groups"][0]["label"] == "paste openings, 0.000 mm margin"
    moved = {"x": job["offset"]["x"] + 3, "y": job["offset"]["y"] - 2}
    assert client.patch(f"/api/jobs/{job['id']}", json={"offset": moved, "groups": [{"index": 0, "speed": 77}]}).status_code == 200
    before = client.get(f"/api/jobs/{job['id']}").json()
    response = client.post(f"/api/jobs/{job['id']}/margin", json={"margin": 0.1})
    assert response.status_code == 200, response.text
    made = response.json()
    assert made["id"] == job["id"] and made["offset"] == moved
    assert made["groups"][0]["label"] == "paste openings, 0.100 mm margin"
    assert made["groups"][0]["speed"] == 77
    assert {sides(path) for path in made["groups"][0]["paths"]} == {(0.2, 1.2)}
    # The paste is where it was.
    assert made["copper"] == before["copper"]
    assert made["recipe"]["options"]["margin"] == 0.1
    # A margin that closes every opening is refused, and the job kept.
    closed = client.post(f"/api/jobs/{job['id']}/margin", json={"margin": 0.25})
    assert closed.status_code == 400 and "closes every opening" in closed.json()["detail"]
    assert client.get(f"/api/jobs/{job['id']}").json()["groups"] == made["groups"]
    # Another spot keeps the margin: 0.3 x 1.3 openings leave a 0.3 mm spot
    # no room inside, and are cut along their middle, half a spot short of
    # each end.
    wider = client.post(f"/api/jobs/{job['id']}/width", json={"width": 0.3}).json()
    assert [group["label"] for group in wider["groups"]] == [
        "paste openings narrower than the spot, along their middle",
        "board outline pass 1",
    ]
    assert {sides(path) for path in wider["groups"][0]["paths"]} == {(0.0, 1.0)}
    assert wider["recipe"]["options"]["margin"] == 0.1


def test_openings_the_margin_closes_come_switched_off(client, tmp_path):
    # A pad 0.2 mm wide, which a 0.12 mm margin closes, and a 1 mm square.
    paste = tmp_path / "pads-F_Paste.gbr"
    paste.write_text(
        "%FSLAX46Y46*%\n%MOMM*%\n%ADD10R,0.200000X1.000000*%\n%ADD11R,1.000000X1.000000*%\n"
        "D10*\nX0Y0D03*\nD11*\nX3000000Y0D03*\nM02*\n"
    )
    job = upload(client, paste, mode="stencil", margin=0.12).json()
    assert job["layer"] == "F.Paste"
    opening, closed = job["groups"]
    assert opening["label"] == "paste openings, 0.120 mm margin" and opening["enabled"]
    assert {sides(path) for path in opening["paths"]} == {(0.66, 0.66)}
    # Along the middle of the pad as drawn, there to be switched on.
    assert closed["label"] == "paste openings the margin closes, along their middle" and not closed["enabled"]
    assert {sides(path) for path in closed["paths"]} == {(0.0, 0.9)}
    assert upload(client, paste, mode="stencil", margin=0.5).status_code == 400


def test_stencil_options_are_refused_where_they_mean_nothing(client):
    for fields, says in (
        ({"mode": "stencil", "clear": "radial"}, "neither clear nor fill"),
        ({"mode": "stencil", "fill": "contour"}, "neither clear nor fill"),
        ({"mode": "stencil", "passes": 2}, "cuts round every opening once"),
        ({"margin": 0.05}, "not a stencil"),
        ({"mode": "deposit", "margin": 0.05}, "not a stencil"),
        ({"mode": "stencil", "margin": -0.01}, "margin must be 0 to 10 mm"),
        ({"mode": "stencil", "margin": 11}, "margin must be 0 to 10 mm"),
    ):
        response = upload(client, COPPER, **fields)
        assert response.status_code == 400 and says in response.json()["detail"], (fields, response.text)
    # A copper gerber cut as a stencil is its copper's openings.
    copper = upload(client, COPPER, mode="stencil").json()
    assert copper["layer"] == "F.Cu" and copper["groups"][0]["label"] == "copper openings, 0.000 mm margin"
    isolated = upload(client, COPPER).json()
    refused = client.post(f"/api/jobs/{isolated['id']}/margin", json={"margin": 0.05})
    assert refused.status_code == 400 and "is not a stencil" in refused.json()["detail"]
    assert client.post("/api/jobs/none/margin", json={"margin": 0.05}).status_code == 404
