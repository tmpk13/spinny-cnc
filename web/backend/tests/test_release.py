"""deploy/release.py's pure parts (names, launchers, the python-build-
standalone pick, the glibc floor) and a launcher run with a real Python;
the archives themselves are built by `mise run release`."""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]


def _load():
    spec = importlib.util.spec_from_file_location("spinny_release", REPO / "deploy" / "release.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # Registered first: its dataclasses look their module up while it loads.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


release = _load()


def test_a_release_is_named_by_version_commit_and_state():
    assert release.label("0.2.0", "4a67b63", tagged=True, dirty=False) == "0.2.0"
    assert release.label("0.2.0", "4a67b63", tagged=False, dirty=False) == "0.2.0-g4a67b63"
    assert release.label("0.2.0", "4a67b63", tagged=False, dirty=True) == "0.2.0-g4a67b63-dirty"


def _scripts() -> dict[str, str]:
    scripts = {}
    for path in release.SCRIPTED:
        scripts.update(release.entry_points(path.read_text()))
    return scripts


def test_only_the_backend_and_the_bridge_get_launchers_in_a_plain_release():
    chosen = release.launched(_scripts(), [])
    assert chosen == {"spinny-web": "spinny_web.app:main", "spinny-bridge": "spinny_web.bridge:main", "spinny-virtual-pnp": "spinny_web.virtual_pnp:main"}


def test_the_mcp_server_gets_a_launcher_only_with_its_package():
    assert "spinny-mcp" not in release.launched(_scripts(), ["auto"])
    assert release.launched(_scripts(), ["auto", "mcp"])["spinny-mcp"] == "spinny_web.mcp_server:main"


def test_a_launched_script_missing_from_the_packages_stops_the_build():
    scripts = _scripts()
    del scripts["spinny-bridge"]
    with pytest.raises(SystemExit, match="spinny-bridge"):
        release.launched(scripts, [])


def test_the_newest_python_for_the_machine_is_picked():
    listing = "\n".join(
        [
            "cpython-3.13.9-linux-aarch64-gnu        https://example/3.13-aarch64.tar.gz",
            "cpython-3.12.12-linux-x86_64-gnu        https://example/3.12.12-x86_64.tar.gz",
            "cpython-3.12.12-linux-aarch64-musl      https://example/3.12.12-aarch64-musl.tar.gz",
            "cpython-3.12.12-linux-aarch64-gnu       https://example/3.12.12-aarch64.tar.gz",
            "cpython-3.12.11-linux-aarch64-gnu       https://example/3.12.11-aarch64.tar.gz",
            "cpython-3.12.3-linux-x86_64-gnu         /usr/bin/python3.12",
        ]
    )
    assert release.python_url(listing, "aarch64") == "https://example/3.12.12-aarch64.tar.gz"
    assert release.python_url(listing, "x86_64") == "https://example/3.12.12-x86_64.tar.gz"
    with pytest.raises(SystemExit):
        release.python_url(listing, "riscv64")


def test_the_glibc_floor_is_the_newest_version_asked_for():
    assert release.glibc_floor([b"\0GLIBC_2.17\0GLIBC_2.28\0", b"x GLIBC_2.9 GLIBC_2.25"]) == (2, 28)
    # Compared as numbers: 2.9 is older than 2.28.
    assert release.glibc_floor([b"GLIBC_2.9"]) == (2, 9)
    assert release.glibc_floor([b"static"]) is None


def test_editable_paths_are_dropped_from_the_requirements():
    exported = "-e ../kicad-to-gcode\nfastapi==0.142.2\n    # via spinny-web\nuvloop==0.23.0 ; sys_platform != 'win32'\n"
    assert release.requirements(exported) == "fastapi==0.142.2\n    # via spinny-web\nuvloop==0.23.0 ; sys_platform != 'win32'\n"


def _bundle(tmp_path: Path, entry: str, python: str | None = None) -> Path:
    """A made-up release with one launcher in bin/; its Python is this one,
    or a shell script with the text `python`."""
    root = tmp_path / "spinny-x"
    (root / "bin").mkdir(parents=True)
    (root / "python" / "bin").mkdir(parents=True)
    interpreter = root / "python" / "bin" / "python3"
    if python is None:
        interpreter.symlink_to(sys.executable)
    else:
        interpreter.write_text(python)
        interpreter.chmod(0o755)
    launch = root / "bin" / "spinny-tool"
    launch.write_text(release.launcher("spinny-tool", entry))
    launch.chmod(0o755)
    return launch


def test_a_launcher_runs_its_function_with_the_bundles_python_alone(tmp_path):
    launch = _bundle(tmp_path, "json.tool:main")
    data = tmp_path / "in a file.json"
    data.write_text('{"b": 1}')
    # A package on the user's PYTHONPATH shadowing the one the bundle runs
    # is not looked at.
    planted = tmp_path / "planted" / "json"
    planted.mkdir(parents=True)
    (planted / "__init__.py").write_text("raise SystemExit('the user PYTHONPATH was used')")
    env = {**os.environ, "PYTHONPATH": str(planted.parent)}
    done = subprocess.run([launch, "--sort-keys", data], capture_output=True, text=True, env=env)
    assert done.returncode == 0, done.stderr
    assert json.loads(done.stdout) == {"b": 1}


def test_a_launcher_linked_from_elsewhere_puts_the_bundles_bin_first_on_path(tmp_path):
    echo = '#!/bin/sh\necho "$PATH"\nfor arg in "$@"; do echo "$arg"; done\n'
    launch = _bundle(tmp_path, "spinny_web.app:main", python=echo)
    linked = tmp_path / "elsewhere" / "spinny-tool"
    linked.parent.mkdir()
    linked.symlink_to(launch)
    done = subprocess.run([linked, "one argument"], capture_output=True, text=True, check=True, env={**os.environ, "PATH": "/usr/bin:/bin"})
    lines = done.stdout.splitlines()
    assert lines[0] == f"{launch.parent}:/usr/bin:/bin"
    assert lines[1:3] == ["-I", "-c"] and "from spinny_web.app import main" in lines[3]
    assert lines[4:] == ["one argument"]
