"""deploy-pi's cross-built pcbv, run in a made-up tree with stand-ins for
the build tools and for ssh, scp and rsync, which record what would go
to the Pi."""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]


def _tree(tmp_path: Path, cargo_ok: bool, strip: bool) -> tuple[Path, Path, dict]:
    repo = tmp_path / "spinny-laser-pcb"
    (repo / "deploy").mkdir(parents=True)
    # Files only: loading release.py in its tests leaves a __pycache__ here.
    for file in (REPO / "deploy").iterdir():
        if file.is_file():
            shutil.copy(file, repo / "deploy" / file.name)
    (repo / "web" / "frontend" / "dist").mkdir(parents=True)
    (repo / "web" / "frontend" / "dist" / "index.html").write_text("<html></html>")
    (tmp_path / "kicad-to-gcode").mkdir()
    old = tmp_path / "pcb-vision" / "target" / "aarch64-unknown-linux-gnu" / "debug" / "pcbv"
    old.parent.mkdir(parents=True)
    old.write_text("an old pcbv")
    old.chmod(0o755)
    (tmp_path / "pcb-vision" / "Cargo.toml").write_text("")
    tools = tmp_path / "tools"
    tools.mkdir()
    sent = tmp_path / "sent.txt"
    scripts = {
        "bun": "exit 0",
        "cargo": "exit 0" if cargo_ok else "exit 101",
        "rustup": "echo aarch64-unknown-linux-gnu",
        "aarch64-linux-gnu-gcc": "exit 0",
        "ssh": "cat >/dev/null; exit 0",
        "rsync": "exit 0",
        # The files staged for the Pi, one name a line.
        "scp": f'for f in "$@"; do [ -f "$f" ] && basename "$f" >> {sent}; done; exit 0',
    }
    if strip:
        scripts["aarch64-linux-gnu-strip"] = 'cp "$3" "$2"'
    for name, body in scripts.items():
        (tools / name).write_text(f"#!/bin/bash\n{body}\n")
        (tools / name).chmod(0o755)
    # Only the stand-ins and the plain tools: nothing real to build with.
    base = tmp_path / "base"
    base.mkdir()
    for tool in ("bash", "cat", "cp", "rm", "mktemp", "dirname", "basename", "grep", "mkdir", "env"):
        found = shutil.which(tool)
        assert found, tool
        (base / tool).symlink_to(found)
    env = dict(os.environ, PATH=f"{tools}:{base}")
    return repo, sent, env


def _deploy(repo: Path, env: dict) -> subprocess.CompletedProcess:
    return subprocess.run(["bash", str(repo / "deploy" / "deploy-pi.sh"), "--web", "pi@spinny.local"],
                          env=env, capture_output=True, text=True, timeout=60)


def _sent(path: Path) -> list[str]:
    return path.read_text().split() if path.exists() else []


@pytest.mark.skipif(shutil.which("bash") is None, reason="needs bash")
def test_a_pcbv_that_did_not_build_is_not_sent_in_place_of_the_new_one(tmp_path):
    repo, sent, env = _tree(tmp_path, cargo_ok=False, strip=True)
    done = _deploy(repo, env)
    assert done.returncode == 0, done.stderr
    assert "pcbv did not build for the Pi" in done.stderr
    assert "pcbv" not in _sent(sent)


@pytest.mark.skipif(shutil.which("bash") is None, reason="needs bash")
def test_a_pcbv_built_goes_to_the_pi(tmp_path):
    repo, sent, env = _tree(tmp_path, cargo_ok=True, strip=True)
    done = _deploy(repo, env)
    assert done.returncode == 0, done.stderr
    assert "pcbv" in _sent(sent)


@pytest.mark.skipif(shutil.which("bash") is None, reason="needs bash")
def test_without_the_cross_strip_the_deploy_goes_on_without_pcbv(tmp_path):
    repo, sent, env = _tree(tmp_path, cargo_ok=True, strip=False)
    done = _deploy(repo, env)
    assert done.returncode == 0, done.stderr
    assert "pcbv" not in _sent(sent)
