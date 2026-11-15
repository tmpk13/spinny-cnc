"""The Machine view's pictures and models: kept per machine file beside
the config, told by their bytes, drawn over a box the page gives."""

from __future__ import annotations

import json
import shutil
import struct
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from spinny_web.app import Backend, create_app
from spinny_web.machineview import ViewError, checked_box, picture_type, stl_triangles

REPO = Path(__file__).resolve().parents[3]
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


def binary_stl(triangles: int) -> bytes:
    body = b"".join(struct.pack("<12fH", 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0) for _ in range(triangles))
    return b"solid looks ascii but is not" + b" " * 52 + struct.pack("<I", triangles) + body


ASCII_STL = b"""solid box
  facet normal 0 0 1
    outer loop
      vertex 0 0 0
      vertex 1 0 0
      vertex 0 1 0
    endloop
  endfacet
endsolid box
"""


@pytest.fixture
def client(tmp_path):
    machines = tmp_path / "machines"
    machines.mkdir()
    shutil.copy(REPO / "machines" / "opulo-lumen-rev5.toml", machines / "lumen.toml")
    backend = Backend(root=tmp_path, jobs_dir=tmp_path / "jobs", config_path=tmp_path / "config.json", machines_dir=machines)
    with TestClient(create_app(backend, frontend=tmp_path / "no-dist")) as client:
        yield client


def test_files_are_told_by_their_bytes():
    assert picture_type(PNG) == ("png", "image/png")
    assert picture_type(b"\xff\xd8\xff\xe0rest") == ("jpg", "image/jpeg")
    assert picture_type(b"RIFF\x00\x00\x00\x00WEBPVP8 ") == ("webp", "image/webp")
    with pytest.raises(ViewError, match="PNG, JPEG, WebP or GIF"):
        picture_type(b"<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>")
    # A binary file whose header starts with solid is still binary: its length says so.
    assert stl_triangles(binary_stl(3)) == 3
    assert stl_triangles(ASCII_STL) == 1
    with pytest.raises(ViewError, match="STL"):
        stl_triangles(b"solid nothing\nendsolid\n")
    with pytest.raises(ViewError, match="STL"):
        stl_triangles(binary_stl(3)[:-1])
    assert checked_box(None) is None and checked_box([0, 1, 2, 3]) == [0.0, 1.0, 2.0, 3.0]
    with pytest.raises(ViewError, match="below"):
        checked_box([2, 1, 0, 3])


def test_a_picture_and_a_model_are_kept_per_machine_beside_the_config(client, tmp_path):
    assert client.get("/api/machines/lumen/view").json() == {"machine": "lumen", "picture": None, "model": None}
    put = client.put("/api/machines/lumen/view/picture", files={"file": ("bench photo.png", PNG, "image/png")})
    assert put.status_code == 200, put.text
    picture = put.json()["picture"]
    assert picture == {"name": "bench photo.png", "type": "image/png", "bytes": len(PNG), "version": 1, "box": None}
    got = client.get("/api/machines/lumen/view/picture")
    assert got.content == PNG and got.headers["content-type"] == "image/png"
    model = client.put("/api/machines/lumen/view/model", files={"file": ("lumen.stl", binary_stl(4), "model/stl")}).json()["model"]
    assert model["triangles"] == 4 and model["version"] == 1
    assert client.get("/api/machines/lumen/view/model").content == binary_stl(4)
    # The box it is drawn over is kept with it, and a new file keeps the box.
    placed = client.put("/api/machines/lumen/view/picture/box", json={"box": [-10, -20, 500, 600]}).json()["picture"]
    assert placed["box"] == [-10.0, -20.0, 500.0, 600.0] and placed["version"] == 2
    again = client.put("/api/machines/lumen/view/picture", files={"file": ("other.jpg", b"\xff\xd8\xff\xe0jpeg", "image/jpeg")}).json()["picture"]
    assert again["box"] == [-10.0, -20.0, 500.0, 600.0] and again["version"] == 3 and again["type"] == "image/jpeg"
    folder = tmp_path / "machine-views" / "lumen"
    assert sorted(path.name for path in folder.iterdir()) == ["model.stl", "picture.jpg", "view.json"]
    assert json.loads((folder / "view.json").read_text())["picture"]["file"] == "picture.jpg"
    # Taken away one at a time; the folder goes with the last.
    assert client.delete("/api/machines/lumen/view/picture").json()["picture"] is None
    assert client.get("/api/machines/lumen/view/picture").status_code == 404
    assert client.delete("/api/machines/lumen/view/model").json() == {"machine": "lumen", "picture": None, "model": None}
    assert not folder.exists()


def test_what_the_view_refuses(client):
    svg = client.put("/api/machines/lumen/view/picture", files={"file": ("x.svg", b"<svg/>", "image/svg+xml")})
    assert svg.status_code == 400 and "PNG" in svg.json()["detail"]
    assert client.put("/api/machines/lumen/view/model", files={"file": ("x.stl", b"not a model", "model/stl")}).status_code == 400
    assert client.put("/api/machines/nobody/view/picture", files={"file": ("x.png", PNG, "image/png")}).status_code == 404
    assert client.put("/api/machines/lumen/view/sound", files={"file": ("x.png", PNG, "image/png")}).status_code == 400
    assert client.get("/api/machines/Bad.Id/view").status_code == 400
    assert client.put("/api/machines/lumen/view/model/box", json={"box": [0, 0, 1, 1]}).status_code == 404
    client.put("/api/machines/lumen/view/picture", files={"file": ("x.png", PNG, "image/png")})
    assert client.put("/api/machines/lumen/view/picture/box", json={"box": [5, 0, 1, 1]}).status_code == 400
    assert client.put("/api/machines/lumen/view/picture/box", json={"box": None}).json()["picture"]["box"] is None
