"""A job's own icon in the job list: kept with the job by a patch (also
while the job runs), checked, carried through a job made again or put in
place whole, and named alike here and in the page."""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from spinny_web.app import Backend, create_app
from spinny_web.jobs import ICON_COLORS, ICON_GLYPHS, Job, JobIcon, check_icon
from spinny_web.runner import RUNNING, Progress

REPO = Path(__file__).resolve().parents[3]
PAGE_ICONS = REPO / "web" / "frontend" / "src" / "icons.ts"

SVG = """<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="40mm" viewBox="0 0 40 40">
    <rect x="5" y="5" width="10" height="10" stroke="#ff0000" fill="none"/>
</svg>
"""


@pytest.fixture
def client(tmp_path):
    backend = Backend(root=tmp_path, jobs_dir=tmp_path / "jobs", config_path=tmp_path / "config.json")
    with TestClient(create_app(backend, frontend=tmp_path / "no-dist")) as client:
        client.backend = backend
        yield client


def upload(client) -> dict:
    response = client.post("/api/jobs", files={"file": ("drawing.svg", SVG.encode(), "image/svg+xml")})
    assert response.status_code == 200, response.text
    return response.json()


def test_an_icon_is_kept_listed_changed_and_taken_away(client):
    job = upload(client)
    assert job["icon"] is None and client.get("/api/jobs").json()["jobs"][0]["icon"] is None
    patched = client.patch(f"/api/jobs/{job['id']}", json={"icon": {"glyph": "star", "color": "magenta"}})
    assert patched.status_code == 200, patched.text
    assert patched.json()["icon"] == {"glyph": "star", "letters": None, "color": "magenta"}
    assert client.get("/api/jobs").json()["jobs"][0]["icon"]["glyph"] == "star"
    # A patch of something else leaves it; letters take its place.
    assert client.patch(f"/api/jobs/{job['id']}", json={"name": "renamed"}).json()["icon"]["glyph"] == "star"
    assert client.patch(f"/api/jobs/{job['id']}", json={"icon": {"letters": "J5", "color": "cyan"}}).json()["icon"]["letters"] == "J5"
    # Null gives the drawing back.
    assert client.patch(f"/api/jobs/{job['id']}", json={"icon": None}).json()["icon"] is None
    assert client.get(f"/api/jobs/{job['id']}").json()["icon"] is None


@pytest.mark.parametrize(
    "icon, words",
    [
        ({"glyph": "nope", "color": "blue"}, "glyph must be one of"),
        ({"glyph": "star", "letters": "A", "color": "blue"}, "one of the two"),
        ({"color": "blue"}, "one of the two"),
        ({"letters": "ABC", "color": "blue"}, "1 to 2 letters or digits"),
        ({"letters": "A!", "color": "blue"}, "1 to 2 letters or digits"),
        ({"glyph": "star", "color": "pink"}, "color must be one of"),
    ],
)
def test_an_icon_that_is_not_one_is_refused_and_changes_nothing(client, icon, words):
    job = upload(client)
    client.patch(f"/api/jobs/{job['id']}", json={"icon": {"glyph": "dot", "color": "green"}})
    response = client.patch(f"/api/jobs/{job['id']}", json={"icon": icon})
    assert response.status_code == 400 and words in response.json()["detail"]
    assert client.get(f"/api/jobs/{job['id']}").json()["icon"]["glyph"] == "dot"


def test_the_icon_is_set_while_the_job_runs_and_nothing_else_is(client):
    job = upload(client)
    client.backend.runner.progress = Progress(job=job["id"], state=RUNNING)
    try:
        response = client.patch(f"/api/jobs/{job['id']}", json={"icon": {"glyph": "bolt", "color": "yellow"}})
        assert response.status_code == 200, response.text
        # The stats were not made again for it.
        assert response.json()["stats"] == job["stats"]
        assert client.patch(f"/api/jobs/{job['id']}", json={"icon": {"glyph": "bolt", "color": "red"}, "name": "x"}).status_code == 409
    finally:
        client.backend.runner.progress = Progress()


def test_a_job_put_in_place_whole_keeps_its_icon_unless_it_names_another(client):
    job = upload(client)
    client.patch(f"/api/jobs/{job['id']}", json={"icon": {"glyph": "heart", "color": "red"}})
    whole = client.get(f"/api/jobs/{job['id']}").json()
    without = {key: value for key, value in whole.items() if key != "icon"}
    assert client.put(f"/api/jobs/{job['id']}", json=without).json()["icon"]["glyph"] == "heart"
    assert client.put(f"/api/jobs/{job['id']}", json={**whole, "icon": None}).json()["icon"] is None
    refused = client.put(f"/api/jobs/{job['id']}", json={**whole, "icon": {"glyph": "nope", "color": "red"}})
    assert refused.status_code == 400 and "glyph" in refused.json()["detail"]


def test_a_job_made_again_for_another_width_keeps_its_icon(client):
    job = upload(client)
    client.patch(f"/api/jobs/{job['id']}", json={"icon": {"letters": "A", "color": "violet"}})
    remade = client.post(f"/api/jobs/{job['id']}/width", json={"width": 0.3})
    assert remade.status_code == 200, remade.text
    assert remade.json()["icon"] == {"glyph": None, "letters": "A", "color": "violet"}


def test_a_plot_page_job_made_again_keeps_its_icon(client):
    op = {"kind": "drill", "points": [[1, 2], [-3, 4.5]], "tool": 0.8, "depth": 1.6, "step_down": 0.5}
    made = client.post("/api/mill", json={"ops": [op], "name": "holes"})
    assert made.status_code == 200, made.text
    job_id = made.json()["job"]["id"]
    client.patch(f"/api/jobs/{job_id}", json={"icon": {"glyph": "drill", "color": "orange"}})
    assert client.post(f"/api/jobs/{job_id}/width", json={"width": 1.0}).json()["icon"]["glyph"] == "drill"
    # Its operations changed in place (Apply) keep it too.
    again = client.post("/api/mill", json={"ops": [{**op, "points": [[0, 0]]}], "job": job_id})
    assert again.status_code == 200, again.text
    assert again.json()["job"]["icon"]["glyph"] == "drill"


def test_a_check_takes_none_and_known_icons():
    check_icon(None)
    check_icon(JobIcon(glyph="gear"))
    check_icon(JobIcon(letters="7", color="orange"))
    with pytest.raises(ValueError):
        check_icon(JobIcon(letters="", color="orange"))
    # A stored job whose icon does not check still loads.
    assert Job.model_validate({"name": "j", "icon": {"glyph": "nope"}}).icon.glyph == "nope"


@pytest.mark.skipif(not PAGE_ICONS.exists(), reason="needs the page's source")
def test_the_page_draws_every_glyph_and_color_the_backend_keeps():
    text = PAGE_ICONS.read_text(encoding="utf-8")
    glyphs = text[text.index("ICON_GLYPHS"):text.index("};")]
    assert re.findall(r"^\s{4}(\w+): \"", glyphs, re.MULTILINE) == list(ICON_GLYPHS)
    colors = re.search(r"ICON_COLORS = \[(.*?)\]", text).group(1)
    assert re.findall(r"\"(\w+)\"", colors) == list(ICON_COLORS)
