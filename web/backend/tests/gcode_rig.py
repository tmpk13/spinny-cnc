"""A backend with G-code machines in its machines directory and a fake
controller behind every port it opens, for the tests of a G-code machine
connected from the top bar and placing with it."""

from __future__ import annotations

import re
from pathlib import Path

from spinny_web.app import Backend
from spinny_web.gcode_link import GcodeLink

# Where the tests' G-code machines are connected; the fake behind it
# answers whatever url is opened.
URL = "socket://127.0.0.1:9"


def gcode_file(text: str) -> str:
    """A G-code machine file from a profile written as the tests write
    them: `controller = "gcode"` first, and its up camera's table under
    that name."""
    return 'controller = "gcode"\n' + re.sub(r"^\[camera\]", "[up_camera]", text, flags=re.MULTILINE)


def rig_backend(tmp_path: Path, files: dict[str, str], opener) -> Backend:
    """A backend whose machines directory holds `files` (id to profile
    text, made G-code machine files) and whose G-code link opens ports with
    `opener`; the head's place is read only when a request needs it, so a
    test sees every line it caused and no others."""
    machines = tmp_path / "machines"
    machines.mkdir(exist_ok=True)
    for machine_id, text in files.items():
        (machines / f"{machine_id}.toml").write_text(gcode_file(text), encoding="utf-8")
    backend = Backend(root=tmp_path, jobs_dir=tmp_path / "jobs", config_path=tmp_path / "config.json", machines_dir=machines)
    backend.gcode = GcodeLink(backend.publish_placing, opener=opener, on_line=backend._gcode_line, on_lost=backend._gcode_lost)
    backend.gcode_poll_seconds = 0
    return backend


def connect(client, machine_id: str, url: str = URL) -> dict:
    """Connects the G-code machine `machine_id` as the top bar does; the snapshot."""
    response = client.post("/api/connect", json={"url": url, "machine": machine_id})
    assert response.status_code == 200, response.text
    return response.json()
