"""End to end against the virtual firmware, when SPINNY_VIRTUAL names its binary."""

from __future__ import annotations

import os
import socket
import subprocess
import time
from pathlib import Path

import pytest
from replay import parse

from spinny_web.jobs import Group, Job
from spinny_web.kinematics import Streamer
from spinny_web.link import Link
from spinny_web.runner import DONE, Runner

BINARY = os.environ.get("SPINNY_VIRTUAL", "")

pytestmark = pytest.mark.e2e


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait_port(port: int, timeout: float = 10.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                return True
        except OSError:
            time.sleep(0.05)
    return False


@pytest.fixture
def firmware():
    if not BINARY or not Path(BINARY).exists():
        pytest.skip("SPINNY_VIRTUAL does not name a virtual firmware binary")
    port = free_port()
    process = subprocess.Popen(
        [BINARY, "--listen", f"127.0.0.1:{port}", "--fast"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        if not wait_port(port):
            pytest.fail("the virtual firmware did not open its port")
        yield port
    finally:
        process.terminate()
        try:
            process.wait(timeout=5.0)
        except subprocess.TimeoutExpired:
            process.kill()


def test_small_job_runs_on_the_virtual_firmware(firmware):
    link = Link(f"socket://127.0.0.1:{firmware}")
    link.open()
    try:
        assert link.banner is not None
        assert link.request_ok("set R0 A0") == []
        square = [(10.0, -2.0), (12.0, -2.0), (12.0, 2.0), (10.0, 2.0), (10.0, -2.0)]
        job = Job(id="e2e", name="square", groups=[Group(label="one", power=500, speed=4000, paths=[square])])
        streamer = Streamer()
        expected = [piece for piece in streamer.job_pieces(job, (0.0, 0.0))]
        runner = Runner()
        runner.start(job, link, streamer)
        deadline = time.monotonic() + 120.0
        while runner.progress.state != DONE and time.monotonic() < deadline:
            assert runner.progress.state in ("running", "done"), runner.snapshot()
            time.sleep(0.05)
        final = runner.snapshot()
        assert final["state"] == DONE, final
        assert final["sent"] == final["acked"] == len(expected)
        status = link.status_now(1.0)
        _, words = parse(expected[-1].line)
        assert status.state == "Idle"
        assert status.r == pytest.approx(words["R"], abs=0.01)
        assert status.a == pytest.approx(words["A"], abs=0.01)
    finally:
        link.close()
