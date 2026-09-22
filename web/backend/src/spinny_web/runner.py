"""Streams a job to the firmware and reports how far it got.

A thread generates the protocol lines lazily and sends them through the
link, blocking whenever the credits are used up, so the firmware's own
queue is what paces the job. Progress is published at most five times a
second and on every state change. A stop, or a line the firmware refuses,
holds the machine, resets it and clears the alarm that leaves behind.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Callable

from .jobs import Job
from .kinematics import Streamer
from .link import (
    REALTIME_HOLD,
    REALTIME_RESUME,
    Link,
    LinkClosed,
    LinkError,
    Pending,
)

PUBLISH_INTERVAL = 0.2
HOLD_WAIT = 2.0
# States in which the machine is not moving, so a reset will not lose steps.
AT_REST = ("Hold", "Idle", "Alarm")
# How long the machine may stay busy after the last ack before the run is
# given up as stuck.
DRAIN_TIMEOUT = 3600.0

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
        self.progress = Progress()

    # --- state ------------------------------------------------------------

    @property
    def active(self) -> bool:
        return self.progress.state in (RUNNING, HOLD)

    def snapshot(self) -> dict | None:
        with self._lock:
            if self.progress.job is None:
                return None
            return self.progress.to_dict()

    # --- control ----------------------------------------------------------

    def start(self, job: Job, link: Link | None, streamer: Streamer) -> dict:
        with self._lock:
            if self.active:
                raise RunnerError("a job is already running")
        if link is None or not link.is_open:
            raise RunnerError("not connected")
        # The status and the estimate run outside the lock: the reader thread
        # takes it for every snapshot, and the status answer arrives on that
        # thread.
        try:
            status = link.status_now(1.0)
        except LinkError as exc:
            raise RunnerError(f"no status from the machine: {exc}") from exc
        if status.state != "Idle":
            raise RunnerError(f"the machine is {status.raw or status.state}, not Idle")
        if not any(group.enabled and group.has_cuts for group in job.groups):
            raise RunnerError("the job has nothing enabled to cut")
        start = status.joint
        stats = streamer.estimate(job, start)
        with self._lock:
            if self.active:
                raise RunnerError("a job is already running")
            self.progress = Progress(
                job=job.id,
                state=RUNNING,
                total=stats.moves,
                estimate=stats.seconds,
                started=time.monotonic(),
            )
            self._link = link
            self._error = None
            self._end_state = ERROR
            self._abort.clear()
            self._last_publish = 0.0
            self._thread = threading.Thread(
                target=self._run,
                args=(job, link, streamer, start),
                name="runner",
                daemon=True,
            )
            self._thread.start()
        self._emit(force=True)
        return self.progress.to_dict()

    def hold(self) -> dict:
        link = self._require(RUNNING)
        link.realtime(REALTIME_HOLD)
        with self._lock:
            self.progress.state = HOLD
        self._emit(force=True)
        return self.progress.to_dict()

    def resume(self) -> dict:
        link = self._require(HOLD)
        link.realtime(REALTIME_RESUME)
        with self._lock:
            self.progress.state = RUNNING
        self._emit(force=True)
        return self.progress.to_dict()

    def stop(self) -> dict:
        with self._lock:
            if not self.active:
                raise RunnerError("nothing is running")
            link = self._link
        assert link is not None
        self._abort.set()
        self._halt(link)
        self._finish(STOPPED)
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=2.0)
        return self.progress.to_dict()

    def abort(self, reason: str, state: str = STOPPED) -> None:
        """Ends the run from outside, before another line goes out.

        The streaming thread halts the machine and reports the run as
        `state` with `reason`. Nothing happens when no run is active.
        """
        with self._lock:
            if not self.active:
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

    def _halt(self, link: Link) -> None:
        """Hold, wait for the stop, reset, and clear the alarm that leaves."""
        try:
            link.realtime(REALTIME_HOLD)
            self._wait_rest(link, HOLD_WAIT)
            link.reset(timeout=1.0)
            try:
                status = link.status_now(1.0)
            except LinkError:
                status = link.status
            if status is not None and status.state == "Alarm":
                link.request("unlock", timeout=2.0)
        except LinkError as exc:
            self._message("error", f"stop: {exc}")

    # --- the streaming thread ---------------------------------------------

    def _run(self, job: Job, link: Link, streamer: Streamer, start: tuple[float, float]) -> None:
        restarts = link.restarts
        try:
            for piece in streamer.job_pieces(job, start):
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
                link.send(piece.line, abort=self._abort, callback=self._on_ack)
                with self._lock:
                    self.progress.sent += 1
                    self.progress.group = piece.group
                self._emit()
            else:
                self._drain(link, restarts)
        except LinkError as exc:
            if not self._abort.is_set():
                self._fail(str(exc))
                return
        except Exception as exc:
            # A fault in the streamer itself: the run must not stay marked as
            # running with the machine still cutting what was queued.
            if self._error is None:
                self._error = f"streaming failed: {exc!r}"
            self._abort.set()
        if self._error is not None:
            self._abort.set()
            self._halt(link)
            self._fail(self._error)
        elif not self._abort.is_set():
            self._finish(DONE)

    def _on_ack(self, pending: Pending) -> None:
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
            self.progress.acked += 1
        if pending.ok:
            self._emit()
            return
        if self._error is None:
            self._error = f"{pending.line!r}: {pending.response}"
        self._abort.set()

    def _drain(self, link: Link, restarts: int) -> None:
        """Wait for the last ack and for the machine to come to rest."""
        deadline = time.monotonic() + DRAIN_TIMEOUT
        while not self._abort.is_set() and time.monotonic() < deadline:
            if link.restarts != restarts:
                # Reset with the tail of the job still queued: those lines
                # were flushed, not run, however idle the machine now is.
                self._error = "the machine reset during the run"
                return
            with self._lock:
                acked = self.progress.acked >= self.progress.sent
            if acked:
                # Only a status asked for now can say the machine has come
                # to rest: the polled one may be from before the last lines
                # were even sent, and a short job is acked in full before
                # the poll comes round again.
                try:
                    status = link.status_now(1.0)
                except LinkError:
                    status = None
                if status is not None and not status.moving:
                    if status.state == "Alarm":
                        self._error = f"the machine raised {status.raw}"
                    return
            if not link.is_open:
                self._error = link.close_reason or "disconnected"
                return
            self._emit()
            time.sleep(0.05)

    def _fail(self, reason: str) -> None:
        with self._lock:
            if self.progress.state not in (RUNNING, HOLD):
                return
            self.progress.error = reason
            state = self._end_state
        if state == ERROR:
            self._message("error", f"run failed: {reason}")
        else:
            self._message("info", f"run {state}: {reason}")
        self._finish(state)

    def _finish(self, state: str) -> None:
        with self._lock:
            if self.progress.state not in (RUNNING, HOLD):
                return
            self.progress.state = state
            self.progress.finished = time.monotonic()
        self._emit(force=True)

    def _wait_rest(self, link: Link, timeout: float) -> bool:
        """Fresh status reports until the machine is held, idle or alarmed.

        Only reports asked for after the hold count: the cached one may
        predate it and still say Idle for a move that has since started.
        """
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                if link.status_now(0.3).state in AT_REST:
                    return True
            except LinkClosed:
                return False
            except LinkError:
                pass
            time.sleep(0.02)
        return False

    def _emit(self, force: bool = False) -> None:
        now = time.monotonic()
        with self._lock:
            if not force and now - self._last_publish < PUBLISH_INTERVAL:
                return
            self._last_publish = now
            snapshot = self.progress.to_dict()
        self._publish(snapshot)
