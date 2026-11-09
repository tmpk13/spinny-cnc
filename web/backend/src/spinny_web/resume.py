"""The resume record: how far the last run got and the plan it was made from.

The runner writes it as a job streams, so a host that dies with the job
half done, or a controller that goes quiet and is powered down, leaves
behind what a later session needs to pick the job up: the job, the line
count, where the plan began and how it followed the board. One file in
the runtime directory holds the record of the last run only.
"""

from __future__ import annotations

import datetime
import json
import threading
import time
from pathlib import Path

# Seconds between writes of the position while it keeps changing: a jog or
# a run moves it many times a second, and the file is for the next session.
POSITION_INTERVAL = 1.0


class ResumeStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._record: dict | None = None
        self._loaded = False

    def _load(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        if isinstance(data, dict) and isinstance(data.get("job"), str):
            self._record = data

    def get(self) -> dict | None:
        self._load()
        return dict(self._record) if self._record is not None else None

    def put(self, record: dict) -> None:
        self._loaded = True
        self._record = dict(record)
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(self.path.suffix + ".tmp")
            tmp.write_text(json.dumps(self._record, indent=2, allow_nan=False) + "\n", encoding="utf-8")
            tmp.replace(self.path)
        except (OSError, ValueError):
            # The record is in force for this process; a host that cannot
            # write its runtime directory has bigger problems, reported
            # where the config is saved.
            pass

    def clear(self) -> None:
        self._loaded = True
        self._record = None
        try:
            self.path.unlink()
        except OSError:
            pass


class PositionStore:
    """The last position the machine reported, kept across sessions.

    Written as the status reports come, at most once a second while the
    position changes and once more when the link closes, so a controller
    powered down after a jog, with no run to leave a record, still leaves
    behind where its head was for the next session to declare.

    A board may start over between two links (its supply went, or its
    reset), or under an open one, and then counts from zero where the head
    stands. So the position is held at every connect and at a restart: the
    reports are not taken, and the one from before is still there to
    declare, until the new link's first report reads the same joints (the
    board kept its count), the board's uptime reaches back past the kept
    report, the position is declared or the machine is homed. A held
    record says since when (`held`)."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._record: dict | None = None
        self._loaded = False
        self._pending: dict | None = None
        self._written_at = 0.0
        # When the position was held (epoch s), None while reports are taken.
        self._held: float | None = None
        # The reader thread notes reports while request threads hold and
        # release: a report taken between a restart and its hold would be
        # the new count's.
        self._lock = threading.RLock()

    def _load(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        if isinstance(data, dict) and isinstance(data.get("r"), (int, float)):
            self._record = data
            if data.get("held") is not None:
                # Held by an earlier session: held still, from when it says
                # or, unreadable, from now.
                self._held = _epoch(data["held"]) or time.time()

    def get(self) -> dict | None:
        with self._lock:
            self._load()
            record = self._pending or self._record
            return dict(record) if record is not None else None

    @property
    def held_since(self) -> float | None:
        """When the position was held (epoch s); None while reports are taken."""
        with self._lock:
            self._load()
            return self._held

    def note(self, status, now: float | None = None) -> None:
        """A status report: kept at once, written when a second has passed
        since the last write. Not taken while the position is held."""
        now = time.monotonic() if now is None else now
        record = {"r": status.r, "a": status.a, "z": status.z, "h": status.h, "state": status.state, "at": _now_iso()}
        with self._lock:
            self._load()
            if self._held is not None:
                return
            current = self._pending or self._record
            if current is not None and all(current.get(key) == record[key] for key in ("r", "a", "z", "h", "state")):
                return
            self._pending = record
            if now - self._written_at >= POSITION_INTERVAL:
                self.flush(now)

    def hold(self) -> None:
        """Keeps the position last reported, written out at once, and takes
        no report until it is released. A hold while one is in force keeps
        the first, since no report has been taken since."""
        with self._lock:
            self._load()
            self.flush()
            if self._held is not None or self._record is None:
                return
            self._held = time.time()
            self._record = {**self._record, "held": _iso(self._held)}
            self._write()

    def release(self) -> None:
        """Takes the machine's reports again: its position was declared, or
        it kept the one it had."""
        with self._lock:
            self._load()
            if self._held is None:
                return
            self._held = None
            if self._record is not None:
                self._record = {key: value for key, value in self._record.items() if key != "held"}
                self._write()

    def first_report(self, status) -> None:
        """The first report of a new link: a board that reads the joints the
        position was kept at has kept its count, and the hold goes."""
        with self._lock:
            self._load()
            kept = self._record
            if self._held is None or kept is None:
                return
            if all(kept.get(key) == getattr(status, key) for key in ("r", "a", "z", "h")):
                self.release()

    def board_started(self, started: float) -> None:
        """The board says it started at `started` (epoch s): one that was up
        before the kept position was reported has counted on from it since,
        and the hold goes. A second's rounding either way is allowed for."""
        with self._lock:
            self._load()
            kept = self._record
            if self._held is None or kept is None:
                return
            reported = _epoch(kept.get("at"))
            if reported is not None and started < reported - 2.0:
                self.release()

    def flush(self, now: float | None = None) -> None:
        """Writes what has changed since the last write, if anything."""
        with self._lock:
            if self._pending is None:
                return
            self._record = self._pending
            self._pending = None
            self._written_at = time.monotonic() if now is None else now
            self._write()

    def _write(self) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(self.path.suffix + ".tmp")
            tmp.write_text(json.dumps(self._record, indent=2, allow_nan=False) + "\n", encoding="utf-8")
            tmp.replace(self.path)
        except (OSError, ValueError):
            pass


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def _iso(epoch: float) -> str:
    return datetime.datetime.fromtimestamp(epoch, datetime.timezone.utc).isoformat(timespec="seconds")


def _epoch(text) -> float | None:
    """The epoch seconds of an ISO time this module wrote; None for anything else."""
    if not isinstance(text, str):
        return None
    try:
        return datetime.datetime.fromisoformat(text).timestamp()
    except ValueError:
        return None
