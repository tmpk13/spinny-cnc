"""Machine files through the API: listing, which one is loaded, loading one."""

from __future__ import annotations

import json
import os
import socket
import subprocess
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from fake_serial import FakeSerial, fake_opener

from spinny_web.app import Backend, create_app
from spinny_web.link import Link

RIG = """
name = "Rig"
description = "the fake, with the table a quarter as fast"
kinematics = "cartesian"
tool = "spindle"

[rail]
steps_per_mm = 256
max_rate = 1000
jog_rate = 600

[table]
steps_per_deg = 888.889
max_rate = 270
jerk = 10
jog_rate = 720
microsteps = 16

[slide]
steps_per_mm = 256
max_rate = 1000
limit = 25
microsteps = 16

[focus]
fitted = true

[host]
tolerance = 0.02
clearance = 3
spinup = 1

[controls]
pad = false
center = { r = 0, z = 0 }

[[controls.axes]]
axis = "r"
label = "X"
steps = [1, 10]

[[controls.axes]]
axis = "z"
label = "Y"
steps = [1, 10]

[[controls.axes]]
axis = "h"
"""


@pytest.fixture
def fake():
    return FakeSerial(move_time=0.002)


@pytest.fixture
def client(tmp_path, fake):
    machines = tmp_path / "machines"
    machines.mkdir()
    (machines / "rig.toml").write_text(RIG, encoding="utf-8")
    (machines / "bare.toml").write_text("name = \"Bare\"\n", encoding="utf-8")
    (machines / "broken.toml").write_text("[rail]\nmax_rate = -5\n", encoding="utf-8")
    backend = Backend(
        root=tmp_path,
        link_factory=lambda url: Link(url, open_port=fake_opener(fake)),
        jobs_dir=tmp_path / "jobs",
        config_path=tmp_path / "config.json",
        machines_dir=machines,
    )
    app = create_app(backend, frontend=tmp_path / "no-dist")
    with TestClient(app) as client:
        client.backend = backend
        client.machines_dir = machines
        yield client


def connect(client) -> dict:
    response = client.post("/api/connect", json={"url": "socket://127.0.0.1:9999"})
    assert response.status_code == 200, response.text
    return response.json()


def test_the_files_are_listed_with_the_broken_one_named(client):
    listed = client.get("/api/machines").json()
    assert [m["id"] for m in listed["machines"]] == ["bare", "rig"]
    rig = listed["machines"][1]
    assert rig == {
        "id": "rig", "name": "Rig", "description": "the fake, with the table a quarter as fast",
        "kinematics": "cartesian", "tool": "spindle", "focus": True,
    }
    # No machine connected: nothing is loaded.
    assert listed["current"] is None
    [problem] = listed["problems"]
    assert problem["id"] == "broken" and "broken.toml" in problem["problem"] and "[rail] max_rate" in problem["problem"]

    response = client.get("/api/machines/rig").json()
    assert response["text"] == RIG and response["problems"] == []
    document = response["document"]
    assert document["settings"]["cartesian"] == 1 and document["settings"]["z_max"] == 25.0
    assert document["settings"]["a_rate"] == 270.0 and document["settings"]["dir_invert"] == 0
    assert document["host"] == {"tolerance": 0.02, "clearance": 3.0, "spinup": 1.0}
    # The page's controls as the file lays them out, filled in from the defaults for a cartesian spindle machine.
    controls = document["controls"]
    assert not controls["pad"] and controls["center"] == {"r": 0.0, "z": 0.0}
    assert [(axis["axis"], axis["label"], axis["buttons"]) for axis in controls["axes"]] == [
        ("r", "X", ["R-", "R+"]), ("z", "Y", ["Z-", "Z+"]), ("h", "Depth axis", ["Down", "Up"]),
    ]
    # A file that does not read still opens, with its text and the problem, so it can be mended.
    broken = client.get("/api/machines/broken").json()
    assert broken["document"] is None and broken["text"].startswith("[rail]") and "[rail] max_rate" in broken["problems"][0]
    assert client.get("/api/machines/nope").status_code == 404
    assert client.get("/api/machines/No%20Such").status_code == 400
    assert client.post("/api/machines/nope/apply").status_code == 404


def test_a_file_is_checked_saved_and_removed_through_the_api(client):
    bad = "[rail]\nmax_rate = 0\n"
    good = "name = \"Mended\"\n[rail]\nmax_rate = 700"
    checked = client.post("/api/machines/broken/check", json={"text": bad}).json()
    assert checked["document"] is None and "[rail] max_rate must be above 0" in checked["problems"][0]
    checked = client.post("/api/machines/broken/check", json={"text": good}).json()
    assert checked["problems"] == [] and checked["document"]["name"] == "Mended" and checked["document"]["settings"]["r_rate"] == 700
    # A check writes nothing.
    assert (client.machines_dir / "broken.toml").read_text(encoding="utf-8") == "[rail]\nmax_rate = -5\n"
    # A save of a text that does not read leaves the file as it was.
    refused = client.put("/api/machines/broken", json={"text": bad})
    assert refused.status_code == 400 and "[rail] max_rate" in refused.json()["detail"]
    assert (client.machines_dir / "broken.toml").read_text(encoding="utf-8") == "[rail]\nmax_rate = -5\n"
    saved = client.put("/api/machines/broken", json={"text": good})
    assert saved.status_code == 200, saved.text
    assert saved.json()["document"]["name"] == "Mended" and saved.json()["text"] == good + "\n"
    assert (client.machines_dir / "broken.toml").read_text(encoding="utf-8") == good + "\n"
    listed = client.get("/api/machines").json()
    assert [m["id"] for m in listed["machines"]] == ["bare", "broken", "rig"] and listed["problems"] == []
    # A new id makes a new file; a bad id makes nothing.
    created = client.put("/api/machines/new-one", json={"text": ""})
    assert created.status_code == 200 and (client.machines_dir / "new-one.toml").read_text(encoding="utf-8") == "\n"
    assert created.json()["document"]["name"] == "new-one"
    assert client.put("/api/machines/New%20One", json={"text": ""}).status_code == 400
    assert client.post("/api/machines/New%20One/check", json={"text": ""}).status_code == 400
    assert client.delete("/api/machines/new-one").json() == {"deleted": "new-one"}
    assert not (client.machines_dir / "new-one.toml").exists()
    assert client.delete("/api/machines/new-one").status_code == 404
    assert client.get("/api/machines/new-one").status_code == 404


def test_loading_a_machine_writes_its_settings_and_names_it_as_the_current_one(client, fake, tmp_path):
    connect(client)
    # The fake boots with settings that are no file's.
    settings = client.get("/api/settings").json()
    assert settings["machine"] is None
    # No file's settings: the controls of the one file for this kind of
    # machine, bare, which are the defaults for a polar laser.
    assert settings["controls_from"] == "bare"
    assert settings["controls"]["pad"] and [axis["axis"] for axis in settings["controls"]["axes"]][:2] == ["r", "a"]
    assert client.get("/api/machines").json()["current"] is None

    response = client.post("/api/machines/rig/apply")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["machine"] == "rig" and body["controls_from"] == "rig"
    # Remembered, for the controls once a setting is changed by hand.
    assert json.loads((tmp_path / "config.json").read_text())["last_machine"] == "rig"
    assert body["values"]["cartesian"] == 1 and body["values"]["spindle"] == 1 and body["values"]["h_axis"] == 1
    assert body["values"]["a_rate"] == 270 and body["values"]["z_max"] == 25
    assert body["host"] == {"tolerance": 0.02, "clearance": 3.0, "spinup": 1.0, "speed_control": True}
    assert json.loads((tmp_path / "config.json").read_text())["tolerance"] == 0.02
    # Every setting the file differs in went out, a setting already at its
    # value did not, and nothing was saved to flash.
    assert "$cartesian=1" in fake.received_lines and "$a_rate=270" in fake.received_lines
    assert "$r_rate=1000" not in fake.received_lines
    assert fake.saved == 0
    assert fake.settings["cartesian"] == 1 and fake.settings["z_max"] == 25
    assert client.get("/api/machines").json()["current"] == "rig"
    loaded = client.get("/api/settings").json()
    assert loaded["machine"] == "rig"
    # The loaded file's controls come with the settings.
    assert not loaded["controls"]["pad"] and [axis["label"] for axis in loaded["controls"]["axes"]] == ["X", "Y", "Depth axis"]
    assert client.get("/api/state").json()["profile"] == {"kinematics": "cartesian", "tool": "spindle", "h_axis": True, "r_max": 0.0, "z_max": 25.0}

    # One setting changed by hand and it is no file's machine any more.
    assert client.put("/api/settings", json={"values": {"a_rate": 300}}).status_code == 200
    changed = client.get("/api/settings").json()
    assert changed["machine"] is None
    # The controls stay rig's: the file last loaded, for a machine that is still a cartesian spindle one.
    assert changed["controls_from"] == "rig"
    assert not changed["controls"]["pad"] and [axis["label"] for axis in changed["controls"]["axes"]] == ["X", "Y", "Depth axis"]
    # Two files for this kind of machine and none loaded from here: the
    # defaults for the cartesian spindle machine the settings describe.
    (client.machines_dir / "rig2.toml").write_text(RIG, encoding="utf-8")
    client.backend.config.pop("last_machine")
    unsure = client.get("/api/settings").json()
    assert unsure["machine"] is None and unsure["controls_from"] is None
    assert unsure["controls"]["pad"] and [axis["label"] for axis in unsure["controls"]["axes"]] == ["Radius", "Table", "Cross slide (Y)", "Depth axis"]
    (client.machines_dir / "rig2.toml").unlink()
    # With one file for the kind, its controls, loaded or not.
    assert client.get("/api/settings").json()["controls_from"] == "rig"

    # Loading with save writes the flash too.
    response = client.post("/api/machines/rig/apply", json={"save": True})
    assert response.status_code == 200, response.text
    assert fake.saved == 1 and response.json()["machine"] == "rig"


def test_a_file_that_goes_bad_after_listing_is_refused_whole(client, fake):
    connect(client)
    (client.machines_dir / "rig.toml").write_text("[rail]\nmax_rate = 0\n", encoding="utf-8")
    response = client.post("/api/machines/rig/apply")
    # The file no longer loads, so there is no machine of that name to apply.
    assert response.status_code == 404
    assert "$cartesian=1" not in fake.received_lines
    assert [m["id"] for m in client.get("/api/machines").json()["machines"]] == ["bare"]


def test_old_firmware_without_a_files_settings_is_named_and_nothing_is_written(client, fake):
    connect(client)
    # Settings the fake itself never reads, so it still answers.
    for name in ("h_jerk", "probe_ms", "z_jerk"):
        del fake.settings[name]
    response = client.post("/api/machines/rig/apply")
    assert response.status_code == 400, response.text
    detail = response.json()["detail"]
    assert "h_jerk" in detail and "probe_ms" in detail and "z_jerk" in detail and "firmware" in detail
    assert not any(line.startswith("$") and "=" in line for line in fake.received_lines)


def test_loading_needs_a_connected_machine(client):
    response = client.post("/api/machines/rig/apply")
    assert response.status_code in (400, 409, 502), response.text


# --- the virtual firmware reads the same files ------------------------------------

REPO = Path(__file__).resolve().parents[3]
SHIPPED = REPO / "machines"
BINARY = os.environ.get("SPINNY_VIRTUAL", "")


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _wait_port(port: int, timeout: float = 10.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                return True
        except OSError:
            time.sleep(0.05)
    return False


@pytest.mark.e2e
@pytest.mark.timeout(120)
@pytest.mark.parametrize("machine_id", ["polar-laser", "polar-laser-focus", "cartesian-laser", "cartesian-mill"])
def test_the_virtual_firmware_started_from_a_file_is_recognized_as_that_machine(tmp_path, machine_id):
    """The Rust and the Python readings of a machine file agree on every
    setting: the virtual firmware started with --machine reports settings
    the backend names as that very file."""
    if not BINARY or not Path(BINARY).exists():
        pytest.skip("SPINNY_VIRTUAL does not name a virtual firmware binary")
    port = _free_port()
    process = subprocess.Popen(
        [BINARY, "--listen", f"127.0.0.1:{port}", "--fast", "--quiet", "--machine", str(SHIPPED / f"{machine_id}.toml")],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        assert _wait_port(port), "the virtual firmware did not open its port"
        backend = Backend(root=tmp_path, jobs_dir=tmp_path / "jobs", config_path=tmp_path / "config.json", machines_dir=SHIPPED)
        app = create_app(backend, frontend=tmp_path / "no-dist")
        with TestClient(app) as client:
            response = client.post("/api/connect", json={"url": f"socket://127.0.0.1:{port}"})
            assert response.status_code == 200, response.text
            settings = client.get("/api/settings").json()
            assert settings["machine"] == machine_id, {
                name: value for name, value in settings["values"].items()
                if value != client.get(f"/api/machines/{machine_id}").json()["settings"][name]
            }
            assert client.get("/api/machines").json()["current"] == machine_id
            client.post("/api/disconnect")
    finally:
        process.terminate()
        try:
            process.wait(timeout=5.0)
        except subprocess.TimeoutExpired:
            process.kill()
