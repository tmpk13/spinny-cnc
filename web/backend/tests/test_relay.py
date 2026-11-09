"""The Pi relay script, run against a stand-in ssh that runs the remote
part here, on a PATH that stands in for the Pi's."""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
RELAY = REPO / "relay" / "relay-pi.sh"


def _pi(tmp_path: Path, listening: set[int]) -> Path:
    """A bin directory standing in for the Pi's: ss lists the ports given
    as listening, sleep returns at once, and there is no socat."""
    pi = tmp_path / "pi"
    pi.mkdir()
    for tool in ("grep", "head", "ls", "cat"):
        found = shutil.which(tool)
        assert found, tool
        (pi / tool).symlink_to(found)
    ports = " ".join(str(port) for port in sorted(listening))
    (pi / "ss").write_text(
        "#!/bin/bash\n"
        f'for p in {ports}; do [[ "$*" == *":$p"* ]] && echo "LISTEN 0 4096 127.0.0.1:$p 0.0.0.0:*"; done\n'
        "exit 0\n"
    )
    (pi / "sleep").write_text("#!/bin/bash\nexit 0\n")
    for name in ("ss", "sleep"):
        (pi / name).chmod(0o755)
    return pi


def _run(tmp_path: Path, pi: Path) -> subprocess.CompletedProcess:
    here = tmp_path / "here"
    here.mkdir()
    bash = shutil.which("bash")
    # The stand-in ssh runs its last argument, the remote script, as the
    # Pi would, on the Pi's PATH.
    (here / "ssh").write_text(f'#!{bash}\nremote="${{@: -1}}"\nexec env PATH={pi} {bash} -c "$remote"\n')
    (here / "ssh").chmod(0o755)
    env = dict(os.environ, PATH=f"{here}:{os.environ['PATH']}", SPINNY_CAMERA_PORTS="")
    return subprocess.run([bash, str(RELAY), "pi@spinny.local"], env=env, capture_output=True, text=True, timeout=30)


@pytest.mark.skipif(shutil.which("bash") is None, reason="needs bash")
def test_a_pi_whose_bridge_listens_is_forwarded_without_socat(tmp_path):
    done = _run(tmp_path, _pi(tmp_path, {2324}))
    assert done.returncode == 0, done.stderr
    assert "a bridge already listens on port 2324" in done.stderr
    assert "socat is missing" not in done.stderr


@pytest.mark.skipif(shutil.which("bash") is None, reason="needs bash")
def test_a_pi_without_a_bridge_needs_socat(tmp_path):
    done = _run(tmp_path, _pi(tmp_path, set()))
    assert done.returncode == 1
    assert "socat is missing on the Pi" in done.stderr
