"""The CAM routes: profiles listed, read, saved, patched and removed; a board
through one into a job; a job out as gcode; a run that refuses the other tool."""

from __future__ import annotations

import json
import shutil
import threading
from pathlib import Path

import pytest
from fake_serial import FakeSerial, fake_opener
from fastapi.testclient import TestClient

from spinny_laser import cam, camjob, post
from spinny_web.app import Backend, create_app
from spinny_web.cam import read_design, twin_samples
from spinny_web.jobs import Group
from spinny_web.kinematics import Spindle, Streamer
from spinny_web.link import Link

REPO = Path(__file__).resolve().parents[3]
SHIPPED = REPO / "cam"
DATA = REPO / "toolpath" / "tests" / "data"
BOARD_FILES = [DATA / "board-F_Cu.gbr", DATA / "board-Edge_Cuts.gbr", DATA / "board-PTH.drl"]

SVG = """<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="40mm" viewBox="0 0 40 40">
    <rect x="5" y="5" width="10" height="10" stroke="#ff0000" fill="none"/>
    <circle cx="30" cy="30" r="5" stroke="#00ff00" fill="none"/>
</svg>
"""


@pytest.fixture
def fake():
    return FakeSerial(move_time=0.002)


@pytest.fixture
def client(tmp_path, fake):
    cam_dir = tmp_path / "cam"
    cam_dir.mkdir()
    for name in ("mill-3axis.toml", "cartesian-laser.toml"):
        shutil.copy(SHIPPED / name, cam_dir / name)
    (cam_dir / "broken.toml").write_text('name = "b"\n[[axes]]\nletter = "X"\nrole = "x"\n', encoding="utf-8")
    backend = Backend(
        root=tmp_path,
        link_factory=lambda url: Link(url, open_port=fake_opener(fake)),
        jobs_dir=tmp_path / "jobs",
        config_path=tmp_path / "config.json",
        cam_dir=cam_dir,
    )
    app = create_app(backend, frontend=tmp_path / "no-dist")
    with TestClient(app) as client:
        client.backend = backend
        client.cam_dir = cam_dir
        yield client


def upload(client, profile_id: str, paths: list[Path], **fields) -> dict:
    files = [("files", (path.name, path.read_bytes(), "application/octet-stream")) for path in paths]
    response = client.post(f"/api/cam/{profile_id}/jobs", files=files, data=fields)
    assert response.status_code == 200, response.text
    return response.json()


def test_the_profiles_are_listed_with_the_broken_one_named(client):
    listed = client.get("/api/cam").json()
    assert [p["id"] for p in listed["profiles"]] == ["cartesian-laser", "mill-3axis"]
    mill = listed["profiles"][1]
    assert mill["name"] == "3 axis mill" and mill["kinematics"] == "cartesian" and mill["tools"] == ["spindle"]
    assert mill["axes"] == "XYZ" and mill["operations"] == 3 and mill["machine"] is None
    assert len(listed["problems"]) == 1 and "broken.toml" in listed["problems"][0] and "radius and angle" in listed["problems"][0]
    document = client.get("/api/cam/mill-3axis").json()
    assert document["text"].startswith("# A standard three axis mill")
    assert [a["letter"] for a in document["document"]["axes"]] == ["X", "Y", "Z"]
    assert document["document"]["operations"][3]["cutting"]["passes"] == 3
    assert document["document"]["post"]["spinup"] == 2 and document["document"]["placement"]["anchor"] == "corner"
    assert client.get("/api/cam/nope").status_code == 404
    assert client.get("/api/cam/broken").status_code == 400
    assert client.get("/api/cam/Not%20This").status_code == 400


def test_a_profile_is_saved_whole_patched_in_place_and_removed(client):
    text = (SHIPPED / "mill-3axis.toml").read_text(encoding="utf-8").replace('name = "3 axis mill"', 'name = "Bench mill"')
    saved = client.put("/api/cam/bench", json={"text": text})
    assert saved.status_code == 200, saved.text
    assert saved.json()["document"]["name"] == "Bench mill"
    assert (client.cam_dir / "bench.toml").read_text(encoding="utf-8") == text
    assert "bench" in [p["id"] for p in client.get("/api/cam").json()["profiles"]]

    refused = client.put("/api/cam/bench", json={"text": text.replace("depth = 1.7", "depth = 70")})
    assert refused.status_code == 400 and "[[operations]] outline depth must be above 0 and at most 50" in refused.json()["detail"]
    assert (client.cam_dir / "bench.toml").read_text(encoding="utf-8") == text

    patched = client.patch("/api/cam/bench", json={"path": ["operations", 1, "enabled"], "value": True})
    assert patched.status_code == 200, patched.text
    assert patched.json()["document"]["operations"][1]["enabled"] is True
    assert "pattern = \"lines\"       # radial | rings | lines" in patched.json()["text"]
    patched = client.patch("/api/cam/bench", json={"path": ["operations", 0, "feed"], "value": 250})
    assert patched.json()["document"]["operations"][0]["cutting"]["feed"] == 250
    assert client.patch("/api/cam/bench", json={"path": ["operations", 7, "feed"], "value": 1}).status_code == 400
    assert client.patch("/api/cam/bench", json={"path": ["operations", 0, "feed"], "value": -1}).status_code == 400
    assert client.patch("/api/cam/nope", json={"path": ["name"], "value": "x"}).status_code == 404

    assert client.delete("/api/cam/bench").json() == {"deleted": "bench"}
    assert client.delete("/api/cam/bench").status_code == 404
    assert client.put("/api/cam/bad id", json={"text": text}).status_code == 400


def test_two_patches_of_one_profile_at_once_both_land(client):
    store = client.backend.cam
    failures: list[Exception] = []
    for round_ in range(20):
        barrier = threading.Barrier(2)

        def patch(index: int, feed: float) -> None:
            barrier.wait()
            try:
                store.patch("mill-3axis", ["operations", index, "feed"], feed)
            except Exception as exc:
                failures.append(exc)

        feeds = (100.0 + round_, 200.0 + round_)
        threads = [threading.Thread(target=patch, args=(0, feeds[0])), threading.Thread(target=patch, args=(3, feeds[1]))]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        profile = store.get("mill-3axis")
        assert (profile.operations[0].cutting["feed"], profile.operations[3].cutting["feed"]) == feeds, f"round {round_}"
    assert failures == []
    assert sorted(path.name for path in client.cam_dir.iterdir()) == ["broken.toml", "cartesian-laser.toml", "mill-3axis.toml"]


def test_a_board_with_its_siblings_goes_through_the_mill_profile(client):
    answer = upload(client, "mill-3axis", BOARD_FILES, name="coupon")
    job, notes = answer["job"], answer["notes"]
    assert job["name"] == "coupon" and job["source"] == "gerber" and job["spot"] == 0.2
    labels = [(g["label"], g["enabled"], g["tool"]) for g in job["groups"]]
    assert labels[0] == ("isolation: loop 1 at 0.100 mm", True, "spindle")
    assert labels[2:] == [
        ("drills: 2 holes at the bit's size", True, "spindle"),
        ("drills: 1 holes milled round", True, "spindle"),
        ("outline: board outline", True, "spindle"),
    ]
    assert job["groups"][4]["passes"] == 3 and job["groups"][4]["depth"] == 1.7 and job["groups"][2]["power"] == 8000
    assert [(g["tool_id"], g["tool_name"]) for g in job["groups"]] == [
        ("vbit", "30 degree V bit"),
        ("endmill", "1 mm end mill"),
        ("drill", "0.8 mm drill"),
        ("drill", "0.8 mm drill"),
        ("endmill", "1 mm end mill"),
    ]
    assert job["outline"] and job["copper"] and job["stats"]["moves"] > 0
    # The switched-off clearing's end mill is wider than the V bit's trench.
    assert [note.split(",")[0] for note in notes] == ["clearing: 1 mm end mill cuts 1 mm wide"]
    listed = client.get("/api/jobs").json()["jobs"]
    assert listed[0]["groups"][0]["tool"] == "spindle" and listed[0]["groups"][0]["paths"] == 32
    # The copper alone: no outline, no drills, and the notes say so.
    answer = upload(client, "mill-3axis", BOARD_FILES[:1])
    assert [g["label"] for g in answer["job"]["groups"]][2:] == []
    assert any("no drill file" in note for note in answer["notes"]) and any("no outline" in note for note in answer["notes"])


def test_a_board_s_unplated_holes_in_their_own_drill_file_are_drilled(client, tmp_path):
    # KiCad writes the mounting holes to a drill file of their own.
    npth = tmp_path / "board-NPTH.drl"
    npth.write_text("M48\nFMAT,2\nMETRIC\nT1C3.200\n%\nG90\nG05\nT1\nX165.0Y-108.0\nT0\nM30\n", encoding="utf-8")
    answer = upload(client, "mill-3axis", BOARD_FILES + [npth])
    (milled,) = [g for g in answer["job"]["groups"] if g["label"].endswith("holes milled round")]
    assert milled["label"] == "drills: 2 holes milled round"
    # The 1 mm hole and the 3.2 mm one, the 0.8 mm drill's middle round
    # each at half the difference.
    widths = sorted(round(max(x for x, _ in path) - min(x for x, _ in path), 2) for path in milled["paths"])
    assert widths == [0.2, 2.4]


def test_an_svg_goes_through_the_paths_operation_of_the_laser_profile(client, tmp_path):
    svg = tmp_path / "coupon.svg"
    svg.write_text(SVG, encoding="utf-8")
    answer = upload(client, "cartesian-laser", [svg])
    job = answer["job"]
    cut = [g for g in job["groups"] if g["paths"]]
    assert [g["label"] for g in cut] == ["engraving: stroke #ff0000", "engraving: stroke #00ff00"]
    assert all(g["tool"] == "laser" and g["power"] == 300 and g["speed"] == 1200 for g in cut)
    xs = [p[0] for g in cut for path in g["paths"] for p in path]
    assert min(xs) == pytest.approx(10.0, abs=1e-6)  # the corner anchor plus the 10 mm offset
    assert any("isolation" in note for note in answer["notes"])
    refused = client.post("/api/cam/cartesian-laser/jobs", files=[("files", ("x.txt", b"hi", "text/plain"))])
    assert refused.status_code == 400 and "unknown file type" in refused.json()["detail"]
    assert client.post("/api/cam/nope/jobs", files=[("files", ("x.svg", SVG.encode(), "image/svg+xml"))]).status_code == 404


def test_a_dxf_drawing_goes_through_the_paths_operation_by_layer(client):
    answer = upload(client, "cartesian-laser", [DATA / "dxf" / "lines.dxf"])
    cut = [g for g in answer["job"]["groups"] if g["paths"]]
    assert [g["label"] for g in cut] == ["engraving: layer CUT", "engraving: layer MARK"]
    assert answer["job"]["source"] == "dxf"
    # Placed by the profile: the drawing's corner on its offset.
    xs = [p[0] for g in cut for path in g["paths"] for p in path]
    assert min(xs) == pytest.approx(10.0, abs=1e-6)


def test_a_job_is_written_as_gcode_for_the_profile(client):
    job = upload(client, "mill-3axis", BOARD_FILES)["job"]
    answer = client.post("/api/cam/mill-3axis/gcode", json={"job": job["id"]})
    assert answer.status_code == 200, answer.text
    written = answer.json()
    assert written["filename"] == "board-F_Cu.nc"
    text = written["text"]
    assert text.startswith("(board-F_Cu: 4 operations through 3 axis mill)") and "M3 S12000" in text and "G1 Z-0.100 F60.000" in text
    assert "G1 Z-1.800 F50.000" in text and text.endswith("M5\nM2\n")
    # The drills and the outline are cut with bits of their own: the program stops for each.
    assert text.count("\nM0\n") == 2
    assert "M5\n(change the bit to 0.8 mm drill and zero Z with it as before, then resume)\nM0\n(drills: 2 holes" in text
    report = written["report"]
    assert report["extents"]["Z"][0] == -1.8 and report["lines"] > 100
    # The end mill's middle runs half a millimeter outside the board's edge,
    # past the lower left corner the shipped profile's travel starts at.
    assert report["warnings"] == [
        "drills: 2 holes at the bit's size: the program stops (M0) to change the bit to 0.8 mm drill",
        "outline: board outline: the program stops (M0) to change the bit to 1 mm end mill",
        "X reaches -0.400, under its min 0",
        "Y reaches -0.400, under its min 0",
    ]
    assert client.post("/api/cam/mill-3axis/gcode", json={"job": "nope"}).status_code == 404
    # The laser profile has no depth axis for a milled job.
    refused = client.post("/api/cam/cartesian-laser/gcode", json={"job": job["id"]})
    assert refused.status_code == 400 and "needs a depth axis" in refused.json()["detail"]


TWO_LASERS = """
name = "Two lasers"
[[axes]]
letter = "X"
role = "x"
[[axes]]
letter = "Y"
role = "y"
[[axes]]
letter = "Z"
role = "depth"
safe = 30
[[tools]]
id = "diode"
kind = "laser"
spot = 0.1
power = 300
speed = 600
height = 2
[[tools]]
id = "co2"
kind = "laser"
spot = 0.2
power = 900
speed = 300
height = 20
[[tools]]
id = "plain"
kind = "laser"
spot = 0.1
power = 100
speed = 600
[[operations]]
name = "engrave"
source = "paths"
tool = "diode"
match = "#ff0000"
height = 6
[[operations]]
name = "cut"
source = "paths"
tool = "co2"
match = "#00ff00"
[[operations]]
name = "mark"
source = "paths"
tool = "plain"
match = "#0000ff"
"""


def test_a_laser_group_is_written_at_its_own_operation_s_height(client, tmp_path):
    assert client.put("/api/cam/two-lasers", json={"text": TWO_LASERS}).status_code == 200
    svg = tmp_path / "coupon.svg"
    svg.write_text(SVG.replace("</svg>", '<line x1="1" y1="1" x2="3" y2="1" stroke="#0000ff"/>\n</svg>'), encoding="utf-8")
    job = upload(client, "two-lasers", [svg])["job"]
    assert [(g["label"], g["height"]) for g in job["groups"]] == [
        ("engrave: stroke #ff0000", 6.0),
        ("cut: stroke #00ff00", 20.0),
        ("mark: stroke #0000ff", None),
    ]
    written = client.post("/api/cam/two-lasers/gcode", json={"job": job["id"]}).json()["text"]
    profile = cam.parse(TWO_LASERS, "two-lasers")
    design = read_design(svg, profile, 0.005)
    expected = post.post(camjob.build(profile, design, "coupon", tolerance=0.005), profile).text

    def heights(text: str) -> list[str]:
        return [line for line in text.splitlines() if line.startswith("(") or line.startswith("G0 Z")]

    # Each group at its own height, a tool without one left where the safe height put it.
    assert heights(written) == [
        "(coupon: 3 operations through Two lasers)",
        "(board X/Y on X=x Y=y Z=depth)",
        "G0 Z30.000",
        "(engrave: stroke #ff0000: 1 paths)",
        "G0 Z6.000",
        "(cut: stroke #00ff00: 1 paths)",
        "G0 Z30.000",
        "G0 Z20.000",
        "(mark: stroke #0000ff: 1 paths)",
        "G0 Z30.000",
    ]
    assert heights(written) == heights(expected)
    # A group made otherwise than by the profile's operations takes the first laser tool's height.
    drawn = client.post("/api/jobs", files={"file": ("drawn.svg", SVG.encode(), "image/svg+xml")}).json()
    text = client.post("/api/cam/two-lasers/gcode", json={"job": drawn["id"]}).json()["text"]
    assert [line for line in text.splitlines() if line.startswith("G0 Z")] == ["G0 Z30.000", "G0 Z2.000", "G0 Z30.000", "G0 Z2.000", "G0 Z30.000"]
    # A job file's height is held to a profile's bound.
    far = dict(job, groups=[dict(job["groups"][0], height=5000.0)])
    refused = client.post("/api/jobs", files={"file": ("far.json", json.dumps(far).encode(), "application/json")})
    assert refused.status_code == 400 and "height must be within 1000 mm of the surface" in refused.json()["detail"]


def test_a_run_refuses_a_group_made_for_the_other_tool(client, fake):
    job = upload(client, "mill-3axis", BOARD_FILES)["job"]
    client.post("/api/connect", json={"url": "socket://127.0.0.1:9999"})
    refused = client.post(f"/api/jobs/{job['id']}/run", json={})
    assert refused.status_code == 400, refused.text
    assert "made for a spindle and this machine has a laser" in refused.json()["detail"]
    # With every spindle group switched off there is nothing left to cut.
    patch = {"groups": [{"index": i, "enabled": False} for i in range(len(job["groups"]))]}
    assert client.patch(f"/api/jobs/{job['id']}", json=patch).status_code == 200
    refused = client.post(f"/api/jobs/{job['id']}/run", json={})
    assert refused.status_code in (400, 409)
    # Its gcode is refused the same way, not written as a program that only goes home.
    refused = client.post("/api/cam/mill-3axis/gcode", json={"job": job["id"]})
    assert refused.status_code == 400 and refused.json()["detail"] == "the job has nothing enabled to cut: switch on a group"


def test_a_run_refuses_a_job_of_more_than_one_bit(client, fake):
    job = upload(client, "mill-3axis", BOARD_FILES)["job"]
    fake.settings["spindle"] = 1
    fake.settings["h_axis"] = 1
    client.post("/api/connect", json={"url": "socket://127.0.0.1:9999"})
    refused = client.post(f"/api/jobs/{job['id']}/run", json={})
    assert refused.status_code == 400, refused.text
    assert refused.json()["detail"] == (
        "the job cuts with 3 bits (30 degree V bit, 0.8 mm drill, 1 mm end mill) and a run does not stop to change one:"
        " switch off drills: 2 holes at the bit's size; drills: 1 holes milled round; outline: board outline"
        " to cut with the 30 degree V bit alone, then each other bit's groups after fitting it"
    )
    assert not any(line.split()[0] in ("go", "cut", "spindle", "dwell") for line in fake.received_lines if line.strip())
    # One bit's groups, and groups that name no bit, are a job the run takes.
    stored = client.backend.store.get(job["id"]).model_copy(deep=True)
    streamer = Streamer(spindle=Spindle())
    for group in stored.groups[2:]:
        group.enabled = False
    stored.groups.append(Group(label="drawn", power=9000, paths=[[(0.0, 0.0), (1.0, 0.0)]]))
    streamer.check_job(stored)
    # A laser machine has no bits to change: the groups' tool is what it refuses.
    with pytest.raises(ValueError, match="made for a spindle"):
        Streamer().check_job(stored)


def test_the_fixture_the_page_s_post_is_checked_against_is_current():
    fixture = Path(__file__).resolve().parent / "data" / "cam-post-samples.json"
    assert json.loads(fixture.read_text(encoding="utf-8")) == json.loads(json.dumps(twin_samples())), "run: mise run cam-fixture"
