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
    behind where its head was for the next session to declare."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._record: dict | None = None
        self._loaded = False
        self._pending: dict | None = None
        self._written_at = 0.0

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

    def get(self) -> dict | None:
        self._load()
        record = self._pending or self._record
        return dict(record) if record is not None else None

    def note(self, status, now: float | None = None) -> None:
        """A status report: kept at once, written when a second has passed
        since the last write."""
        now = time.monotonic() if now is None else now
        record = {"r": status.r, "a": status.a, "z": status.z, "h": status.h, "state": status.state, "at": _now_iso()}
        self._load()
        current = self._pending or self._record
        if current is not None and all(current.get(key) == record[key] for key in ("r", "a", "z", "h", "state")):
            return
        self._pending = record
        if now - self._written_at >= POSITION_INTERVAL:
            self.flush(now)

    def flush(self, now: float | None = None) -> None:
        """Writes what has changed since the last write, if anything."""
        if self._pending is None:
            return
        self._record = self._pending
        self._pending = None
        self._written_at = time.monotonic() if now is None else now
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(self.path.suffix + ".tmp")
            tmp.write_text(json.dumps(self._record, indent=2, allow_nan=False) + "\n", encoding="utf-8")
            tmp.replace(self.path)
        except (OSError, ValueError):
            pass


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
