"""The runner against the fake firmware: done, hold, stop, refusals, errors."""

from __future__ import annotations

import threading
import time

import pytest
from fake_serial import FakeSerial, fake_opener
from replay import parse

from spinny_web.jobs import Group, Job
from spinny_web.kinematics import Streamer
from spinny_web.link import REALTIME_RESET, Link, LinkClosed
from spinny_web import runner as runner_module
from spinny_web.runner import DONE, ERROR, HOLD, RUNNING, STOPPED, Runner, RunnerError


class Sink:
    def __init__(self) -> None:
        self.progress: list[dict] = []
        self.messages: list[tuple[str, str]] = []
        self.lock = threading.Lock()

    def publish(self, progress: dict) -> None:
        with self.lock:
            self.progress.append(dict(progress))

    def message(self, level: str, text: str) -> None:
        with self.lock:
            self.messages.append((level, text))

    def states(self) -> list[str]:
        with self.lock:
            out = []
            for item in self.progress:
                if not out or out[-1] != item["state"]:
                    out.append(item["state"])
            return out


def wait_for(predicate, timeout: float = 5.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return predicate()


def small_job(radius: float = 10.0) -> Job:
    square = [(radius, -2.0), (radius + 2.0, -2.0), (radius + 2.0, 2.0), (radius, 2.0), (radius, -2.0)]
    return Job(
        id="j1",
        name="square",
        groups=[
            Group(label="one", power=500, speed=400, paths=[square]),
            Group(label="two", power=300, speed=200, paths=[[(radius, 5.0), (radius + 1.0, 5.0)]]),
        ],
    )


def setup(**fake_args):
    fake = FakeSerial(**fake_args)
    link = Link("fake://", open_port=fake_opener(fake), poll=True)
    link.open()
    sink = Sink()
    runner = Runner(publish=sink.publish, message=sink.message)
    return fake, link, sink, runner


def test_run_to_completion_reports_progress_and_moves_the_machine():
    fake, link, sink, runner = setup(move_time=0.002)
    try:
        job = small_job()
        streamer = Streamer()
        expected = [piece for piece in streamer.job_pieces(job, (0.0, 0.0))]
        progress = runner.start(job, link, streamer)
        assert progress["state"] == RUNNING and progress["total"] == len(expected)
        assert wait_for(lambda: runner.progress.state == DONE, 10.0)
        final = runner.snapshot()
        assert final["sent"] == final["acked"] == final["total"] == len(expected)
        assert final["group"] == 1
        assert final["seconds"] > 0 and final["estimate"] > 0
        assert sink.states()[0] == RUNNING and sink.states()[-1] == DONE
        lines = [line for line in fake.received_lines if line.split()[0] in ("go", "cut")]
        assert lines == [piece.line for piece in expected]
        _, words = parse(expected[-1].line)
        assert fake.joint[0] == pytest.approx(words["R"]) and fake.joint[1] == pytest.approx(words["A"])
        assert fake.max_outstanding <= 16
    finally:
        link.close()


def test_progress_is_published_at_most_five_times_a_second_between_changes():
    fake, link, sink, runner = setup(move_time=0.001, ok_delay=0.002)
    try:
        big = Job(
            id="big",
            name="ring",
            groups=[Group(label="ring", paths=[[(20.0 + (i % 2), i * 0.5) for i in range(200)]])],
        )
        runner.start(big, link, Streamer())
        assert wait_for(lambda: runner.progress.state == DONE, 20.0)
        elapsed = runner.snapshot()["seconds"]
        running = [p for p in sink.progress if p["state"] == RUNNING]
        assert len(running) <= 5 * elapsed + 3
        assert len(running) >= 2
    finally:
        link.close()


def test_hold_resume_and_stop():
    fake, link, sink, runner = setup(move_time=0.5)
    try:
        runner.start(small_job(), link, Streamer())
        assert wait_for(lambda: fake.state() == "Run", 2.0)
        runner.hold()
        assert runner.progress.state == HOLD
        assert wait_for(lambda: fake.state() == "Hold", 1.0)
        with pytest.raises(RunnerError):
            runner.hold()
        runner.resume()
        assert runner.progress.state == RUNNING
        assert wait_for(lambda: fake.state() == "Run", 1.0)
        progress = runner.stop()
        assert progress["state"] == STOPPED
        assert progress["error"] is None
        # The stop holds first and resets once the machine is at rest, so
        # no alarm is raised and nothing has to be unlocked.
        assert fake.realtime_bytes.index(0x21) < fake.realtime_bytes.index(0x18)
        assert "unlock" not in fake.received_lines
        assert fake.alarm is None
        assert not runner.active
        assert sink.states() == [RUNNING, HOLD, RUNNING, STOPPED]
        # Lines the reset flushed never count as acked. An answer still on
        # its way when the reset went out is dropped too, so this is a bound.
        answered = [line for line in fake.answered_lines if line.split()[0] in ("go", "cut")]
        assert progress["acked"] <= len(answered)
        assert progress["acked"] <= progress["sent"]
        with pytest.raises(RunnerError):
            runner.stop()
        assert fake.state() == "Idle"
        # The next run starts cleanly.
        runner.start(small_job(), link, Streamer())
        assert wait_for(lambda: runner.progress.state == DONE, 20.0)
    finally:
        link.close()


def test_refuses_when_not_connected_or_not_idle():
    fake, link, sink, runner = setup(move_time=0.5)
    try:
        with pytest.raises(RunnerError):
            runner.start(small_job(), None, Streamer())
        link.request_ok("go R3")
        link.status_now(1.0)
        with pytest.raises(RunnerError):
            runner.start(small_job(), link, Streamer())
        assert wait_for(lambda: fake.state() == "Idle", 2.0)
        link.status_now(1.0)
        with pytest.raises(RunnerError):
            runner.start(Job(id="empty", name="empty"), link, Streamer())
        closed = Link("fake://", open_port=fake_opener(FakeSerial()), poll=False)
        closed.open()
        closed.close()
        with pytest.raises(RunnerError):
            runner.start(small_job(), closed, Streamer())
    finally:
        link.close()


def test_a_refused_line_ends_the_run_with_an_error():
    fake, link, sink, runner = setup(move_time=0.05)
    try:
        fake.settings["r_max"] = 12.0
        runner.start(small_job(radius=10.0), link, Streamer())
        assert wait_for(lambda: runner.progress.state == ERROR, 10.0)
        final = runner.snapshot()
        assert "error:4" in final["error"]
        assert 0x18 in fake.realtime_bytes
        assert sink.messages and sink.messages[-1][0] == "error"
        assert wait_for(lambda: fake.state() == "Idle", 2.0)
    finally:
        link.close()


def test_a_vanishing_port_ends_the_run_with_an_error():
    fake, link, sink, runner = setup(move_time=0.5, ok_delay=0.05)
    try:
        runner.start(small_job(), link, Streamer())
        assert wait_for(lambda: runner.progress.sent >= 2, 2.0)
        fake.vanish()
        assert wait_for(lambda: runner.progress.state == ERROR, 5.0)
        assert not link.is_open
    finally:
        link.close()


def test_stop_does_not_count_flushed_lines_as_acked():
    # The fake takes half a second over each line, so the stop lands with
    # the first line under way and the rest unanswered; the reset flushes
    # those and they never count.
    fake, link, sink, runner = setup(move_time=0.5, ok_delay=0.5)
    try:
        runner.start(small_job(), link, Streamer())
        assert wait_for(lambda: fake.state() == "Run", 3.0)
        assert runner.progress.sent >= 4
        progress = runner.stop()
        assert progress["state"] == STOPPED
        answered = [line for line in fake.answered_lines if line.split()[0] in ("go", "cut")]
        assert progress["acked"] == len(answered) <= 2
        assert progress["acked"] < progress["sent"]
    finally:
        link.close()


def test_stop_returns_quickly_when_the_machine_is_already_at_rest():
    fake, link, sink, runner = setup(move_time=0.001, ok_delay=0.3)
    try:
        runner.start(small_job(), link, Streamer())
        assert wait_for(lambda: runner.progress.sent >= 1, 2.0)
        assert fake.state() == "Idle"
        # The lines it has taken in are answered at once from here: an
        # idle machine with nothing left to take up has nothing to wait for.
        fake.ok_delay = 0.0
        started = time.monotonic()
        progress = runner.stop()
        assert time.monotonic() - started < 1.5
        assert progress["state"] == STOPPED
        assert fake.state() == "Idle"
    finally:
        link.close()


class Crashing(Streamer):
    """Streams normally for the estimate, then fails a few pieces into the run."""

    def __init__(self) -> None:
        super().__init__()
        self.calls = 0

    def job_pieces(self, job, start, compensation=None):
        self.calls += 1
        for index, piece in enumerate(super().job_pieces(job, start, compensation)):
            if self.calls > 1 and index == 2:
                raise RuntimeError("boom")
            yield piece


def test_a_crash_in_the_streaming_thread_is_reported_and_halts_the_machine():
    fake, link, sink, runner = setup(move_time=0.3)
    try:
        runner.start(small_job(), link, Crashing())
        assert wait_for(lambda: runner.progress.state == ERROR, 5.0)
        final = runner.snapshot()
        assert "RuntimeError" in final["error"] and "boom" in final["error"]
        assert 0x18 in fake.realtime_bytes
        assert sink.messages and sink.messages[-1][0] == "error"
        assert not runner.active
        assert wait_for(lambda: fake.state() == "Idle", 2.0)
    finally:
        link.close()


class Watching(Streamer):
    """Records whether the runner's lock is held while the estimate runs."""

    def __init__(self, runner: Runner) -> None:
        super().__init__()
        self.runner = runner
        self.locked: bool | None = None

    def estimate(self, job, start=(0.0, 0.0), compensation=None):
        self.locked = self.runner._lock.locked()
        return super().estimate(job, start, compensation)


def test_start_does_not_hold_the_lock_while_asking_the_machine():
    fake, link, sink, runner = setup(move_time=0.002)
    try:
        # The backend takes a progress snapshot on every link event, on the
        # reader thread, which must not wait behind a starting run.
        link.subscribe(lambda event: runner.snapshot())
        streamer = Watching(runner)
        runner.start(small_job(), link, streamer)
        assert streamer.locked is False
        assert wait_for(lambda: runner.progress.state == DONE, 10.0)
    finally:
        link.close()


def test_a_machine_that_resets_mid_run_stops_the_run_and_says_so():
    """A reset takes the queue and the modal words with it.

    The firmware announces itself again when it resets, which is the only
    warning the host gets. Without noticing it the run would keep sending
    into a machine that has forgotten where it is and what feed to cut at,
    and every line after it would come back refused.
    """
    # Enough lines, and slow enough acks, that the run is still going when
    # the machine restarts underneath it.
    fake, link, sink, runner = setup(move_time=0.02)
    big = Job(
        id="big",
        name="many",
        groups=[Group(
            label="one", power=500, speed=400,
            paths=[[(10.0 + i * 0.1, -3.0), (10.0 + i * 0.1, 3.0)] for i in range(40)],
        )],
    )
    try:
        streamer = Streamer()
        runner.start(big, link, streamer)
        assert wait_for(lambda: runner.progress.sent > 5, 5.0)
        assert runner.progress.sent < runner.progress.total
        # The machine restarts underneath the run.
        fake._emit(fake.banner())
        assert wait_for(lambda: runner.progress.state in (ERROR, STOPPED, DONE), 10.0)
        snapshot = runner.snapshot()
        assert snapshot["state"] == ERROR, snapshot
        assert "reset" in (snapshot.get("error") or ""), snapshot
        assert runner.progress.sent < runner.progress.total, "it kept streaming into a reset machine"
    finally:
        link.close()


def test_a_job_of_joint_paths_runs_through_the_axis():
    fake, link, sink, runner = setup(move_time=0.002)
    try:
        job = Job(
            id="j2",
            name="fine",
            groups=[Group(label="rail", power=400, speed=200, joints=[[(-6.0, 0.0), (6.0, 0.0)]])],
        )
        runner.start(job, link, Streamer())
        assert wait_for(lambda: runner.progress.state == DONE, 10.0)
        lines = [line for line in fake.received_lines if line.split()[0] in ("go", "cut")]
        assert lines == ["go R-6.000 A0.0000", "cut R6.000 A0.0000 F200 S400"]
        assert fake.joint[0] == pytest.approx(6.0)
        with pytest.raises(RunnerError):
            runner.start(Job(id="j3", name="empty", groups=[Group(label="off", enabled=False, joints=[[(-6.0, 0.0), (6.0, 0.0)]])]), link, Streamer())
    finally:
        link.close()


def test_a_reset_from_outside_the_run_stops_it_before_another_line_goes_out():
    """The console's reset byte, like the firmware restarting, empties the
    machine's queue and frees every credit at once. The run must not spend
    them: the machine is Idle again and would run whatever came next."""
    # Acks trail so every credit is in use and the sender is waiting; moves
    # are instant so the reset finds the machine at rest and raises no
    # alarm, which is what would otherwise refuse the stray lines.
    fake, link, sink, runner = setup(move_time=0.001, ok_delay=0.3)
    big = Job(
        id="big",
        name="many",
        groups=[Group(
            label="one", power=500, speed=400,
            paths=[[(10.0 + i * 0.1, -3.0), (10.0 + i * 0.1, 3.0)] for i in range(40)],
        )],
    )
    try:
        runner.start(big, link, Streamer())
        assert wait_for(lambda: runner.progress.sent >= 16, 5.0)
        assert wait_for(lambda: fake.state() == "Idle", 1.0)
        link.realtime(REALTIME_RESET)
        assert wait_for(lambda: runner.progress.state in (ERROR, STOPPED, DONE), 10.0)
        snapshot = runner.snapshot()
        assert snapshot["state"] == ERROR, snapshot
        assert "reset" in (snapshot["error"] or ""), snapshot
        after = fake.received_lines[fake.received_at_reset[0]:]
        assert not [line for line in after if line.split()[0] in ("go", "cut")], after
        assert not runner.active
    finally:
        link.close()


def test_a_version_asked_from_the_console_does_not_end_the_run():
    fake, link, sink, runner = setup(move_time=0.02)
    big = Job(
        id="big",
        name="many",
        groups=[Group(
            label="one", power=500, speed=400,
            paths=[[(10.0 + i * 0.1, -3.0), (10.0 + i * 0.1, 3.0)] for i in range(40)],
        )],
    )
    try:
        runner.start(big, link, Streamer())
        assert wait_for(lambda: runner.progress.sent > 5, 5.0)
        # The answer to `version` is the banner line: an answer, not a restart.
        assert link.request("version")[-1] == "ok"
        assert wait_for(lambda: runner.progress.state != RUNNING, 30.0)
        assert runner.snapshot()["state"] == DONE, runner.snapshot()
    finally:
        link.close()


def test_stop_waits_for_the_hold_to_finish_before_the_reset():
    # The firmware reports `Hold` only once the brake has finished; the
    # fake's ramp stands in for that. The reset must wait for it.
    fake, link, sink, runner = setup(move_time=0.5, hold_ramp=0.3)
    try:
        runner.start(small_job(), link, Streamer())
        assert wait_for(lambda: fake.state() == "Run", 2.0)
        progress = runner.stop()
        assert progress["state"] == STOPPED and progress["error"] is None
        first_hold = next(at for byte, at in fake.realtime_at if byte == 0x21)
        reset = next(at for byte, at in fake.realtime_at if byte == 0x18)
        assert reset - first_hold >= 0.3
        assert fake.alarm is None
        assert "unlock" not in fake.received_lines
        assert not any(level == "error" for level, _ in sink.messages)
    finally:
        link.close()


def test_a_stop_that_finds_the_machine_still_moving_leaves_the_alarm_up(monkeypatch):
    monkeypatch.setattr(runner_module, "HOLD_WAIT", 0.2)
    fake, link, sink, runner = setup(move_time=0.5, hold_ramp=1.0)
    try:
        runner.start(small_job(), link, Streamer())
        assert wait_for(lambda: fake.state() == "Run", 2.0)
        progress = runner.stop()
        # The reset went out anyway: a stop must stop. What it cost is
        # reported, and the alarm that says so is left for the operator.
        assert progress["state"] == STOPPED
        assert "position" in progress["error"] or "Alarm" in progress["error"]
        assert fake.alarm == 1
        assert "unlock" not in fake.received_lines
        assert any(level == "error" for level, _ in sink.messages)
    finally:
        link.close()


def test_a_hold_after_the_run_ended_is_refused_and_leaves_it_done():
    fake, link, sink, runner = setup(move_time=0.002)
    try:
        runner.start(small_job(), link, Streamer())
        assert wait_for(lambda: runner.progress.state == RUNNING, 2.0)
        real = link.realtime

        def slow_hold(byte, routine=False):
            # The run ends between the check and the byte.
            if byte in (0x21, b"!"):
                assert wait_for(lambda: runner.progress.state == DONE, 10.0)
            real(byte, routine=routine)

        link.realtime = slow_hold
        with pytest.raises(RunnerError):
            runner.hold()
        assert runner.progress.state == DONE
        assert not runner.active
        with pytest.raises(RunnerError):
            runner.resume()
        assert runner.progress.state == DONE
    finally:
        link.close()


def test_start_refuses_while_the_previous_thread_is_still_stopping():
    fake, link, sink, runner = setup(move_time=0.002)
    try:
        gate = threading.Event()
        stale = threading.Thread(target=gate.wait, daemon=True)
        stale.start()
        runner._thread = stale
        with pytest.raises(RunnerError, match="still stopping"):
            runner.start(small_job(), link, Streamer())
        gate.set()
        stale.join(1.0)
        runner.start(small_job(), link, Streamer())
        assert wait_for(lambda: runner.progress.state == DONE, 10.0)
    finally:
        link.close()


def test_a_run_being_prepared_counts_as_active_and_checks_the_start_again():
    fake, link, sink, runner = setup(move_time=0.002)
    try:
        seen = []

        class SlowStreamer(Streamer):
            def estimate(self, job, start, compensation=None):
                seen.append(runner.active)
                # A typed line moves the head while the estimate runs.
                link.request_ok("set R3 A0")
                return super().estimate(job, start, compensation)

        with pytest.raises(RunnerError, match="moved"):
            runner.start(small_job(), link, SlowStreamer())
        assert seen == [True]
        assert not runner.active
        assert runner.progress.state == "idle"
    finally:
        link.close()


def test_the_drain_gives_up_as_an_error_not_as_done(monkeypatch):
    monkeypatch.setattr(runner_module, "DRAIN_TIMEOUT", 0.3)
    fake, link, sink, runner = setup(move_time=100.0)
    try:
        runner.start(small_job(), link, Streamer())
        assert wait_for(lambda: not runner.active, 10.0)
        final = runner.snapshot()
        assert final["state"] == ERROR
        assert "come to rest" in final["error"]
        assert 0x18 in fake.realtime_bytes
        assert fake.state() == "Idle"
    finally:
        link.close()


def test_a_hold_during_the_drain_does_not_count_against_the_budget(monkeypatch):
    monkeypatch.setattr(runner_module, "DRAIN_TIMEOUT", 0.5)
    # The fake answers every line on receipt, so the whole job is a tail
    # after the last ack; keep it well inside the budget.
    fake, link, sink, runner = setup(move_time=0.005)
    try:
        runner.start(small_job(), link, Streamer())
        assert wait_for(lambda: runner.progress.sent == runner.progress.total, 5.0)
        runner.hold()
        time.sleep(0.7)
        assert runner.progress.state == HOLD
        runner.resume()
        assert wait_for(lambda: runner.progress.state == DONE, 5.0), runner.snapshot()
    finally:
        link.close()


def test_stop_reports_an_error_when_the_halt_cannot_reach_the_machine():
    fake, link, sink, runner = setup(move_time=0.5)
    try:
        runner.start(small_job(), link, Streamer())
        assert wait_for(lambda: fake.state() == "Run", 2.0)

        # The port goes away under the stop: the machine keeps cutting
        # what it has, and the run must not say it was stopped.
        def gone(byte, routine=False):
            raise LinkClosed("reader failed")

        link.realtime = gone
        progress = runner.stop()
        assert progress["state"] == ERROR
        assert "could not be stopped" in progress["error"]
    finally:
        link.close()


def test_a_run_starts_with_the_table_angle_renumbered_within_a_turn():
    fake, link, sink, runner = setup(move_time=0.002)
    try:
        fake.joint = [10.0, 1085.0]
        runner.start(small_job(), link, Streamer())
        assert wait_for(lambda: runner.progress.state == DONE, 10.0)
        assert "set A5" in fake.received_lines
        first = next(line for line in fake.received_lines if line.split()[0] in ("go", "cut"))
        assert "A" in first and float(first.split("A")[1].split()[0]) < 360.0
    finally:
        link.close()
