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
from spinny_web.link import REALTIME_RESET, Link
from spinny_web.runner import DONE, STOPPED, Runner

BINARY = os.environ.get("SPINNY_VIRTUAL", "")

# The debug build of the virtual firmware steps every microstep, and a
# probed grid takes tens of seconds of it: each test's own deadlines are
# the limit, not the suite's default timeout.
pytestmark = [pytest.mark.e2e, pytest.mark.timeout(300)]


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
        # The floor rides on every cut as an M word the firmware must take.
        job = Job(id="e2e", name="square", groups=[Group(label="one", power=500, min_power=150, speed=4000, paths=[square])])
        streamer = Streamer()
        expected = [piece for piece in streamer.job_pieces(job, (0.0, 0.0))]
        assert expected[-1].line.endswith(" S500 M150")
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


def test_a_far_side_cut_runs_on_the_virtual_firmware(firmware):
    link = Link(f"socket://127.0.0.1:{firmware}")
    link.open()
    try:
        assert link.request_ok("set R0 A0") == []
        job = Job(
            id="e2e-fine",
            name="fine",
            groups=[
                Group(label="rail", power=400, speed=4000, joints=[[(-6.0, 0.0), (6.0, 0.0)]]),
                Group(label="far arc", power=400, speed=4000, joints=[[(-5.5, 90.0), (-4.5, 110.0)]]),
            ],
        )
        streamer = Streamer()
        expected = [piece for piece in streamer.job_pieces(job, (0.0, 0.0))]
        assert expected[-1].line == "cut R-4.500 A110.0000 F4000 S400"
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
        assert status.state == "Idle"
        assert status.r == pytest.approx(-4.5, abs=0.01)
        assert status.a == pytest.approx(110.0, abs=0.01)
    finally:
        link.close()


def test_a_reset_during_a_held_run_ends_it_without_another_line(firmware):
    """The console's reset while a run is held. The run must end there, and
    nothing may be streamed into the machine once it is Idle again."""
    link = Link(f"socket://127.0.0.1:{firmware}")
    link.open()
    try:
        assert link.request_ok("set R0 A0") == []
        paths = [[(10.0 + i * 0.1, -3.0), (10.0 + i * 0.1, 3.0)] for i in range(60)]
        job = Job(id="e2e-reset", name="many", groups=[Group(label="one", power=500, speed=200, paths=paths)])
        runner = Runner()
        runner.start(job, link, Streamer())
        deadline = time.monotonic() + 30.0
        while runner.progress.sent < 16 and time.monotonic() < deadline:
            time.sleep(0.02)
        assert runner.progress.sent >= 16, runner.snapshot()
        runner.hold()
        deadline = time.monotonic() + 10.0
        while link.status_now(1.0).state != "Hold" and time.monotonic() < deadline:
            time.sleep(0.02)
        assert link.status_now(1.0).state == "Hold"
        sent = runner.progress.sent
        link.realtime(REALTIME_RESET)
        deadline = time.monotonic() + 30.0
        while runner.active and time.monotonic() < deadline:
            time.sleep(0.02)
        final = runner.snapshot()
        assert final["state"] == "error" and "reset" in final["error"], final
        assert runner.progress.sent == sent, "a line went out after the reset"
        status = link.status_now(1.0)
        assert status.state == "Idle", status.raw
        time.sleep(0.3)
        again = link.status_now(1.0)
        assert again.state == "Idle" and again.joint == status.joint, again.raw
    finally:
        link.close()


def test_a_stop_from_motion_holds_first_and_resets_at_rest(firmware):
    """The stop sequence against the real control core: the hold must have
    brought the machine to rest before the reset, so no alarm is raised and
    nothing has to be unlocked."""
    link = Link(f"socket://127.0.0.1:{firmware}")
    link.open()
    try:
        assert link.request_ok("set R0 A0") == []
        paths = [[(10.0 + i * 0.1, -3.0), (10.0 + i * 0.1, 3.0)] for i in range(60)]
        job = Job(id="e2e-stop", name="many", groups=[Group(label="one", power=500, speed=200, paths=paths)])
        seen: list[str] = []
        link.subscribe(lambda event: seen.append(f"{event.kind}:{event.data}"))
        runner = Runner()
        runner.start(job, link, Streamer())
        deadline = time.monotonic() + 30.0
        while runner.progress.sent < 16 and time.monotonic() < deadline:
            time.sleep(0.02)
        assert runner.progress.sent >= 16, runner.snapshot()
        assert link.status_now(1.0).state == "Run"
        final = runner.stop()
        assert final["state"] == STOPPED and final["error"] is None, final
        status = link.status_now(1.0)
        assert status.state == "Idle", status.raw
        assert not [text for text in seen if "ALARM" in text], seen
        time.sleep(0.3)
        again = link.status_now(1.0)
        assert again.state == "Idle" and again.joint == status.joint, again.raw
    finally:
        link.close()


def board_top(x: float, y: float) -> float:
    """The simulated board: 1.5 mm under the head's zero, tilted."""
    return -1.5 + 0.01 * x - 0.02 * y


@pytest.fixture
def focus_firmware(tmp_path):
    if not BINARY or not Path(BINARY).exists():
        pytest.skip("SPINNY_VIRTUAL does not name a virtual firmware binary")
    port = free_port()
    trace = tmp_path / "trace.json"
    process = subprocess.Popen(
        [
            BINARY, "--listen", f"127.0.0.1:{port}", "--fast", "--quiet",
            "--settings", "h_axis=1",
            "--surface", "-1.5,0.01,-0.02",
            "--probe-offset", "2,1",
            "--trace", str(trace),
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        if not wait_port(port):
            pytest.fail("the virtual firmware did not open its port")
        yield port, trace
    finally:
        process.terminate()
        try:
            process.wait(timeout=5.0)
        except subprocess.TimeoutExpired:
            process.kill()


def test_probing_then_a_focus_run_follows_the_board_on_the_virtual_firmware(focus_firmware, tmp_path):
    import json

    from spinny_web.heightmap import Compensation, Grid, HeightMapStore
    from spinny_web.prober import DONE as PROBED
    from spinny_web.prober import Prober, ProbeSettings

    port, trace = focus_firmware
    link = Link(f"socket://127.0.0.1:{port}")
    link.open()
    try:
        store = HeightMapStore(tmp_path / "heightmap.json")
        prober = Prober(store)
        settings = ProbeSettings(depth=4, feed=240, slow=30, backoff=0.3, offset=(2.0, 1.0))
        streamer = Streamer()
        prober.start(Grid(x0=-8, y0=-8, x1=8, y1=8, nx=3, ny=3), settings, link, streamer)
        deadline = time.monotonic() + 120.0
        while prober.active and time.monotonic() < deadline:
            time.sleep(0.05)
        assert prober.progress.state == PROBED, prober.snapshot()
        heightmap = store.get()
        # The tip, 2 mm out and 1 mm across from the beam, touched the board
        # at every point within a step of the focus axis. It never comes
        # within 1 mm of the axis, so the middle point was probed 1 mm out.
        for iy, y in enumerate(heightmap.grid.ys):
            for ix, x in enumerate(heightmap.grid.xs):
                at = (x, y) if (x, y) != (0.0, 0.0) else (1.0, 0.0)
                assert heightmap.heights[iy][ix] == pytest.approx(board_top(*at), abs=0.002)
        # Probed as the board is, not as it would have been at the axis.
        heightmap.heights[1][1] = board_top(0.0, 0.0)
        assert link.status_now(1.0).h == pytest.approx(0.0, abs=1e-3), "back at the travel height"

        heightmap.focus_offset = 1.0
        heightmap.focus_set = True
        compensation = Compensation(heightmap=heightmap, mode="focus")
        square = [(-5.0, -5.0), (5.0, -5.0), (5.0, 5.0), (-5.0, 5.0), (-5.0, -5.0)]
        job = Job(id="focus", name="square", groups=[Group(label="one", power=500, speed=2000, paths=[square])])
        runner = Runner()
        runner.start(job, link, streamer, compensation)
        deadline = time.monotonic() + 120.0
        while runner.progress.state == "running" and time.monotonic() < deadline:
            time.sleep(0.05)
        assert runner.progress.state == DONE, runner.snapshot()
    finally:
        link.close()
    # The trace is written once the client has gone.
    deadline = time.monotonic() + 10.0
    marks = []
    while time.monotonic() < deadline:
        try:
            marks = [m for m in json.loads(trace.read_text())["marks"] if m["duty"] > 0]
        except (OSError, ValueError):
            marks = []
        if marks:
            break
        time.sleep(0.1)
    assert len(marks) > 50
    # Along the whole burn the beam's focus sat 1 mm above the board under it.
    worst = max(abs(m["h"] - (board_top(m["x"], m["y"]) + 1.0)) for m in marks)
    assert worst < 0.01, worst


@pytest.fixture
def mill_firmware(tmp_path):
    """A cartesian machine with a spindle, whose tool is its own probe: it
    touches the tilted board wherever the tool tip meets it."""
    if not BINARY or not Path(BINARY).exists():
        pytest.skip("SPINNY_VIRTUAL does not name a virtual firmware binary")
    port = free_port()
    trace = tmp_path / "trace.json"
    process = subprocess.Popen(
        [
            BINARY, "--listen", f"127.0.0.1:{port}", "--fast", "--quiet",
            "--settings", "h_axis=1",
            "--settings", "cartesian=1",
            "--settings", "spindle=1",
            "--surface", "-1.5,0.01,-0.02",
            "--trace", str(trace),
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        if not wait_port(port):
            pytest.fail("the virtual firmware did not open its port")
        yield port, trace
    finally:
        process.terminate()
        try:
            process.wait(timeout=5.0)
        except subprocess.TimeoutExpired:
            process.kill()


def test_a_cartesian_spindle_probes_then_mills_at_depth_under_the_board_on_the_virtual_firmware(mill_firmware, tmp_path):
    import json

    from spinny_web.heightmap import Compensation, Grid, HeightMapStore
    from spinny_web.kinematics import CartesianStreamer, Spindle
    from spinny_web.prober import DONE as PROBED
    from spinny_web.prober import Prober, ProbeSettings

    port, trace = mill_firmware
    link = Link(f"socket://127.0.0.1:{port}")
    link.open()
    try:
        store = HeightMapStore(tmp_path / "heightmap.json")
        prober = Prober(store)
        streamer = CartesianStreamer(angle=0.0, spindle=Spindle(clearance=1.0, spinup=0.1))
        settings = ProbeSettings(depth=4, feed=240, slow=30, backoff=0.3, offset=(0.0, 0.0))
        prober.start(Grid(x0=-8, y0=-8, x1=8, y1=8, nx=3, ny=3), settings, link, streamer)
        deadline = time.monotonic() + 120.0
        while prober.active and time.monotonic() < deadline:
            time.sleep(0.05)
        assert prober.progress.state == PROBED, prober.snapshot()
        heightmap = store.get()
        # The tool is the probe, so the rail and the cross slide put it right
        # over each grid point, the axis included.
        for iy, y in enumerate(heightmap.grid.ys):
            for ix, x in enumerate(heightmap.grid.xs):
                assert heightmap.heights[iy][ix] == pytest.approx(board_top(x, y), abs=0.002)
        heightmap.focus_offset = 0.0
        heightmap.focus_set = True
        compensation = Compensation(heightmap=heightmap, mode="focus")
        square = [(-5.0, -5.0), (5.0, -5.0), (5.0, 5.0), (-5.0, 5.0), (-5.0, -5.0)]
        job = Job(
            id="mill",
            name="square",
            groups=[Group(label="iso", power=600, speed=400, depth=0.2, passes=2, plunge=120, paths=[square])],
        )
        runner = Runner()
        runner.start(job, link, streamer, compensation)
        deadline = time.monotonic() + 120.0
        while runner.progress.state == "running" and time.monotonic() < deadline:
            time.sleep(0.05)
        assert runner.progress.state == DONE, runner.snapshot()
        status = link.status_now(1.0)
        assert status.laser == 0, "the spindle stopped at the end"
        assert status.h == pytest.approx(heightmap.span()[1] + 1.0, abs=1e-3), "the tool ends up at the travel height"
    finally:
        link.close()
    deadline = time.monotonic() + 10.0
    marks = []
    while time.monotonic() < deadline:
        try:
            marks = [m for m in json.loads(trace.read_text())["marks"] if m["duty"] > 0]
        except (OSError, ValueError):
            marks = []
        if marks:
            break
        time.sleep(0.1)
    assert marks, "the spindle never turned"
    # In the work, the tool followed the board at the pass's depth under it,
    # on the square, with the table still.
    cutting = [m for m in marks if m["h"] < board_top(m["x"], m["y"]) - 0.05]
    assert len(cutting) > 50
    for m in cutting:
        assert m["a"] == 0.0 and m["x"] == pytest.approx(m["r"]) and m["y"] == pytest.approx(m["z"])
        on_square = min(abs(abs(m["x"]) - 5.0), abs(abs(m["y"]) - 5.0))
        assert on_square < 0.01, m
    depths = sorted({round(board_top(m["x"], m["y"]) - m["h"], 2) for m in cutting if on_edge(m)})
    assert depths == [0.1, 0.2], depths


def on_edge(mark) -> bool:
    """A mark along a side of the square, not in a corner's plunge."""
    return max(abs(mark["x"]), abs(mark["y"])) > 4.99 and min(abs(mark["x"]), abs(mark["y"])) < 4.5
