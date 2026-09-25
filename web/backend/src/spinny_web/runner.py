"""Streams a job to the firmware and reports how far it got.

A thread generates the protocol lines lazily and sends them through the
link, blocking whenever the credits are used up, so the firmware's own
queue is what paces the job. Progress is published at most five times a
second and on every state change. A stop, or a line the firmware refuses,
holds the machine, waits for it to come to rest and resets it.
"""

from __future__ import annotations

import functools
import threading
import time
from dataclasses import dataclass, field
from typing import Callable

from .heightmap import Compensation
from .jobs import Job
from .kinematics import Streamer, num
from .link import (
    REALTIME_HOLD,
    REALTIME_RESUME,
    Link,
    LinkClosed,
    LinkError,
    Pending,
)

PUBLISH_INTERVAL = 0.2
# How long a hold may take to bring the machine to rest before the stop
# resets it anyway.
HOLD_WAIT = 2.0
# States in which the machine is not moving, so a reset will not lose
# steps: the firmware reports `Hold` only once the brake has finished.
AT_REST = ("Hold", "Idle", "Alarm")
# How long the machine may stay busy after the last ack, or the last
# answer, before the run is given up as stuck. A hold does not count.
DRAIN_TIMEOUT = 3600.0
# How long a stop waits for the streaming thread to wind up.
JOIN_WAIT = 2.0

RUNNING, HOLD, DONE, STOPPED, ERROR, IDLE = "running", "hold", "done", "stopped", "error", "idle"


class RunnerError(Exception):
    """The run could not be started or changed."""


@dataclass
class Progress:
    job: str | None = None
    state: str = IDLE
    sent: int = 0
    acked: int = 0
    total: int = 0
    estimate: float = 0.0
    group: int | None = None
    error: str | None = None
    started: float = field(default=0.0, repr=False)
    finished: float | None = field(default=None, repr=False)

    def to_dict(self) -> dict:
        end = self.finished if self.finished is not None else time.monotonic()
        seconds = end - self.started if self.started else 0.0
        return {
            "job": self.job,
            "state": self.state,
            "sent": self.sent,
            "acked": self.acked,
            "total": self.total,
            "seconds": round(seconds, 1),
            "estimate": round(self.estimate, 1),
            "group": self.group,
            "error": self.error,
        }


class Runner:
    def __init__(
        self,
        publish: Callable[[dict], None] | None = None,
        message: Callable[[str, str], None] | None = None,
    ) -> None:
        self._publish = publish or (lambda progress: None)
        self._message = message or (lambda level, text: None)
        self._lock = threading.Lock()
        self._abort = threading.Event()
        self._thread: threading.Thread | None = None
        self._link: Link | None = None
        self._last_publish = 0.0
        self._error: str | None = None
        # What a run that ends with `_error` set is reported as: an error,
        # unless `abort` asked for something milder.
        self._end_state = ERROR
        # A run is being prepared: the plan is made from where the machine
        # is, and nothing may move it before the first line goes out.
        self._starting = False
        self.progress = Progress()

    # --- state ------------------------------------------------------------

    @property
    def active(self) -> bool:
        return self._starting or self.progress.state in (RUNNING, HOLD)

    def snapshot(self) -> dict | None:
        with self._lock:
            if self.progress.job is None:
                return None
            return self.progress.to_dict()

    # --- control ----------------------------------------------------------

    def start(self, job: Job, link: Link | None, streamer: Streamer, compensation: Compensation | None = None) -> dict:
        with self._lock:
            if self.active:
                raise RunnerError("a job is already running")
            thread = self._thread
            if thread is not None and thread.is_alive():
                # Its halt is still on its way to the machine; a new run
                # would be streamed into the reset that ends the old one.
                raise RunnerError("the previous run is still stopping")
            self._starting = True
        try:
            start, stats = self._prepare(job, link, streamer, compensation)
            assert link is not None
            with self._lock:
                self.progress = Progress(
                    job=job.id,
                    state=RUNNING,
                    total=stats.moves,
                    estimate=stats.seconds,
                    started=time.monotonic(),
                )
                progress = self.progress
                self._link = link
                self._error = None
                self._end_state = ERROR
                self._abort.clear()
                self._last_publish = 0.0
                self._thread = threading.Thread(
                    target=self._run,
                    args=(job, link, streamer, start, progress, compensation),
                    name="runner",
                    daemon=True,
                )
                self._thread.start()
        finally:
            self._starting = False
        self._emit(force=True)
        return progress.to_dict()

    def _prepare(self, job: Job, link: Link | None, streamer: Streamer, compensation: Compensation | None):
        if link is None or not link.is_open:
            raise RunnerError("not connected")
        # The status and the estimate run outside the lock: the reader thread
        # takes it for every snapshot, and the status answer arrives on that
        # thread.
        status = self._idle_status(link)
        if not any(group.enabled and group.has_cuts for group in job.groups):
            raise RunnerError("the job has nothing enabled to cut")
        if abs(status.a) >= 360.0:
            # Every pass of an outline around the axis adds a turn to the
            # angle, and the firmware keeps angles in single precision:
            # past a few dozen turns the word and the report lose the
            # step. The same orientation is declared with the turns taken
            # out before the plan is made from it.
            try:
                link.request_ok(f"set A{num(status.a % 360.0, 4)}")
            except LinkError as exc:
                raise RunnerError(f"could not renumber the table angle: {exc}") from exc
            status = self._idle_status(link)
        start = streamer.start_of(status)
        stats = streamer.estimate(job, start, compensation)
        # The estimate takes a while on a large job, and the plan is only
        # good from where the machine was when it was made: a typed line in
        # the meantime may have moved the head, or declared it elsewhere.
        # Every axis counts: a cartesian plan is made in the table's frame.
        after = self._idle_status(link)
        if (after.r, after.a, after.z, after.h) != (status.r, status.a, status.z, status.h):
            raise RunnerError("the machine moved while the run was being prepared")
        return start, stats

    @staticmethod
    def _idle_status(link: Link):
        try:
            status = link.status_now(1.0, routine=True)
        except LinkError as exc:
            raise RunnerError(f"no status from the machine: {exc}") from exc
        if status.state != "Idle":
            raise RunnerError(f"the machine is {status.raw or status.state}, not Idle")
        return status

    def hold(self) -> dict:
        link = self._require(RUNNING)
        link.realtime(REALTIME_HOLD)
        self._switch(RUNNING, HOLD)
        self._emit(force=True)
        return self.progress.to_dict()

    def resume(self) -> dict:
        link = self._require(HOLD)
        link.realtime(REALTIME_RESUME)
        self._switch(HOLD, RUNNING)
        self._emit(force=True)
        return self.progress.to_dict()

    def _switch(self, before: str, after: str) -> None:
        """The run from `before` to `after`, unless it ended in between: a
        finished run stays finished, and the byte just sent found a machine
        with nothing left to hold or resume."""
        with self._lock:
            if self.progress.state != before:
                raise RunnerError(f"the run is {self.progress.state}, not {before}")
            self.progress.state = after

    def stop(self) -> dict:
        with self._lock:
            if self.progress.state not in (RUNNING, HOLD):
                raise RunnerError("nothing is running")
            link = self._link
            progress = self.progress
        assert link is not None
        self._abort.set()
        stopped, note = self._halt(link)
        if not stopped:
            # The run is over on this side, but the machine is still
            # cutting what it had: say so rather than report a stop that
            # did not happen.
            self._fail(f"the machine could not be stopped: {note}", progress, ERROR)
        elif note is not None:
            self._fail(note, progress, STOPPED)
        else:
            self._finish(STOPPED, progress)
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=JOIN_WAIT)
        return self.progress.to_dict()

    def abort(self, reason: str, state: str = STOPPED) -> None:
        """Ends the run from outside, before another line goes out.

        The streaming thread halts the machine and reports the run as
        `state` with `reason`. Nothing happens when no run is active.
        """
        with self._lock:
            if self.progress.state not in (RUNNING, HOLD):
                return
            if self._error is None:
                self._error = reason
            self._end_state = state
        self._abort.set()

    def _require(self, state: str) -> Link:
        with self._lock:
            if self.progress.state != state:
                raise RunnerError(f"the run is {self.progress.state}, not {state}")
            link = self._link
        if link is None or not link.is_open:
            raise RunnerError("not connected")
        return link

    def _halt(self, link: Link) -> tuple[bool, str | None]:
        return halt(link, self._message)

    # --- the streaming thread ---------------------------------------------

    def _run(
        self,
        job: Job,
        link: Link,
        streamer: Streamer,
        start: tuple[float, float],
        progress: Progress,
        compensation: Compensation | None = None,
    ) -> None:
        restarts = link.restarts
        on_ack = functools.partial(self._on_ack, progress)
        try:
            for piece in streamer.job_pieces(job, start, compensation):
                if self._abort.is_set():
                    break
                if link.restarts != restarts:
                    # The machine announced itself again: it was reset, and
                    # with it went the queue and the position this run was
                    # planned from. Nothing after this point would land
                    # where the job says.
                    self._error = "the machine reset during the run"
                    self._abort.set()
                    break
                # A held run sends nothing more: what the machine has is
                # enough to resume with, and lines it has not taken in yet
                # would only queue behind the hold.
                while progress.state == HOLD and not self._abort.is_set():
                    time.sleep(0.02)
                if self._abort.is_set():
                    break
                link.send(piece.line, abort=self._abort, callback=on_ack)
                with self._lock:
                    progress.sent += 1
                    progress.group = piece.group
                self._emit()
            else:
                self._drain(link, restarts, progress)
        except LinkError as exc:
            if not self._abort.is_set():
                self._fail(str(exc), progress, ERROR)
                return
        except Exception as exc:
            # A fault in the streamer itself: the run must not stay marked as
            # running with the machine still cutting what was queued.
            if self._error is None:
                self._error = f"streaming failed: {exc!r}"
            self._abort.set()
        if self._error is not None:
            self._abort.set()
            reason = self._error
            state = self._end_state
            # A machine that has announced itself again has nothing queued
            # and nothing to halt; a second reset would only take an alarm
            # it raised for the operator as this run's doing.
            if link.restarts == restarts:
                stopped, note = self._halt(link)
                if not stopped:
                    reason = f"{reason}; the machine could not be stopped: {note}"
                    state = ERROR
            self._fail(reason, progress, state)
        elif not self._abort.is_set():
            self._finish(DONE, progress)

    def _on_ack(self, progress: Progress, pending: Pending) -> None:
        if progress is not self.progress:
            # An answer to a line of a run that is over. Its bookkeeping is
            # gone and the flags belong to the run after it.
            return
        if not pending.answered:
            # Dropped without an answer. The stop sequence sets the abort
            # flag before it resets, so a drop while the flag is clear is a
            # reset from elsewhere: the console's reset byte, or the
            # firmware restarting. The run ends here, in the link's own
            # callback, before the credit the drop freed can let another
            # line into a machine that has just been emptied and would run
            # it. A lost port is reported by the thread.
            if pending.response == "reset" and not self._abort.is_set():
                if self._error is None:
                    self._error = "the machine was reset during the run"
                self._abort.set()
            return
        with self._lock:
            progress.acked += 1
        if pending.ok:
            self._emit()
            return
        if self._error is None:
            self._error = f"{pending.line!r}: {pending.response}"
        self._abort.set()

    def _drain(self, link: Link, restarts: int, progress: Progress) -> None:
        """Wait for the last ack and for the machine to come to rest."""
        last_acked = -1
        deadline = time.monotonic() + DRAIN_TIMEOUT
        while not self._abort.is_set():
            if link.restarts != restarts:
                # Reset with the tail of the job still queued: those lines
                # were flushed, not run, however idle the machine now is.
                self._error = "the machine reset during the run"
                return
            with self._lock:
                acked, sent = progress.acked, progress.sent
            now = time.monotonic()
            if acked != last_acked:
                # The budget counts from the last answer: a long tail of
                # slow moves is still going somewhere while acks arrive.
                last_acked = acked
                deadline = now + DRAIN_TIMEOUT
            status = None
            if acked >= sent:
                # Only a status asked for now can say the machine has come
                # to rest: the polled one may be from before the last lines
                # were even sent, and a short job is acked in full before
                # the poll comes round again.
                try:
                    status = link.status_now(1.0, routine=True)
                except LinkError:
                    status = None
                if status is not None and not status.moving:
                    if status.state == "Alarm":
                        self._error = f"the machine raised {status.raw}"
                    return
            # A hold is the operator's and lasts as long as they like.
            held = status if status is not None else link.status
            if held is not None and held.state == "Hold":
                deadline = now + DRAIN_TIMEOUT
            if now >= deadline:
                # Reported as an error, not as done: the machine is still
                # busy with something, and the run's end is the stop that
                # follows.
                self._error = "the machine did not come to rest after the last line"
                return
            if not link.is_open:
                self._error = link.close_reason or "disconnected"
                return
            self._emit()
            time.sleep(0.05)

    def _fail(self, reason: str, progress: Progress, state: str) -> None:
        with self._lock:
            if progress is not self.progress or progress.state not in (RUNNING, HOLD):
                return
            progress.error = reason
        if state == ERROR:
            self._message("error", f"run failed: {reason}")
        else:
            self._message("info", f"run {state}: {reason}")
        self._finish(state, progress)

    def _finish(self, state: str, progress: Progress) -> None:
        with self._lock:
            if progress is not self.progress or progress.state not in (RUNNING, HOLD):
                return
            progress.state = state
            progress.finished = time.monotonic()
        self._emit(force=True)

    def _emit(self, force: bool = False) -> None:
        now = time.monotonic()
        with self._lock:
            if not force and now - self._last_publish < PUBLISH_INTERVAL:
                return
            self._last_publish = now
            snapshot = self.progress.to_dict()
        self._publish(snapshot)


def _lines_waiting(link: Link, status) -> bool:
    """Lines the machine has taken in but not yet answered: a report that
    says Idle with one of those still queued is not a machine at rest."""
    banner = link.banner
    return banner is not None and status.lines < banner.lines


def halt(link: Link, message: Callable[[str, str], None]) -> tuple[bool, str | None]:
    """Hold, wait for the machine to come to rest, and reset it.

    Returns whether the reset went out, and a note when the stop was
    not clean: the machine did not come to rest in time, so the reset
    may have cost steps, or an alarm is up afterwards. The alarm is
    left for the operator: it says the position may be off, and only
    they can check that.
    """
    try:
        link.realtime(REALTIME_HOLD)
        rested = wait_rest(link, HOLD_WAIT)
        answered = link.reset(timeout=1.0)
    except LinkError as exc:
        message("error", f"stop: {exc}")
        return False, str(exc)
    note = None
    if not rested:
        note = "the machine did not come to rest before the reset: the position may be off"
    try:
        status = link.status_now(1.0, routine=True)
    except LinkError:
        status = None
    if status is None and not answered:
        # Neither the banner nor a report came back: the reset byte
        # went out, but nothing says the machine acted on it.
        note = "the machine did not answer the reset: check that it has stopped"
    if status is not None and status.state == "Alarm":
        note = f"the machine is in {status.raw or status.state}: check the position, then unlock"
    if note is not None:
        message("error", note)
    return True, note


def wait_rest(link: Link, timeout: float) -> bool:
    """Fresh status reports until the machine is held, idle or alarmed,
    and, when idle, with no line left waiting that could start it.

    Only reports asked for after the hold count: the cached one may
    predate it and still say Idle for a move that has since started.
    A hold that went out ahead of a line the machine had not taken up
    yet found nothing to hold, and that line then starts the motion;
    seeing the machine move, the hold is asked for again. A held or
    alarmed machine takes up no line, so lines waiting behind those
    states are at rest too, and the reset flushes them.
    """
    deadline = time.monotonic() + timeout
    nudged = time.monotonic()
    while time.monotonic() < deadline:
        try:
            status = link.status_now(0.3, routine=True)
        except LinkClosed:
            return False
        except LinkError:
            status = None
        if status is not None:
            if status.state in AT_REST and not (status.state == "Idle" and _lines_waiting(link, status)):
                return True
            if status.state in ("Run", "Jog") and time.monotonic() - nudged > 0.1:
                link.realtime(REALTIME_HOLD)
                nudged = time.monotonic()
        time.sleep(0.02)
    return False
