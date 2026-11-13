"""Search records: what a camera's look for a board saw, kept so that a
search that took long, never found the board or found it in the wrong
place can be gone through afterwards, and so that a change to the search or
to pcbv can be tried against real searches (searchreport.py) before it
reaches the machine.

A record is kept for every search over a box (`search`) and for every look
for a board with no search (`look`: from the board's loading until enough
looks agree, the board is unloaded, a search starts or the record is full).
Records are kept whether or not the camera log is on: a search that went
wrong is seldom the one somebody chose to log. Each is one folder named by
its id:

- `record.json`: what was looked for and how (the camera, its offset, roll,
  mirror and scale, the board file and the side and finish pcbv was told,
  the board's outline box and middle in the job's frame and the map from
  KiCad board points into that frame, the search's box and stops, the
  search's settings) and, once it ended, how it ended;
- `events.jsonl`: one JSON line for each thing that happened, `t` seconds
  from the start: each pose read (pcbv's whole reply, where the picture lay
  when its frame was taken or why that was not known, the estimate it gave
  or why none, the consensus after it), each move to a stop, each stop's
  end, each picture kept;
- `stop-NNN.jpg` or `look-NNN.jpg`: the camera's picture, full size, at each
  stop of a search once its looks are done (the head still at rest there),
  or at a look's first pose and when it found the board: the same pictures
  can be given to pcbv again (`pcbv locate`, or the folder replayed as a
  camera);
- `board.kicad_pcb`: the board file pcbv was given, as it was.

The oldest records go once there are more than MAX_RECORDS or they take
more than MAX_BYTES together; a record still being written never goes.
Nothing here stops a search: a line or a picture that cannot be written is
left out, with a warning in the log.
"""

from __future__ import annotations

import datetime
import hashlib
import json
import logging
import os
import re
import shutil
import threading
import time
from pathlib import Path
from typing import Callable

from .files import write_whole

log = logging.getLogger("spinny_web.searchlog")

# Records kept at most, and the room they may take together, bytes.
MAX_RECORDS = 60
MAX_BYTES = 200 * 1024 * 1024
# Event lines one record keeps at most, by kind: a look left loaded for long
# stops being recorded (the look itself goes on), a search's lines stop
# while the search goes on to its end.
MAX_EVENTS = {"search": 30000, "look": 3000}
# Pictures one record keeps at most, so one search over a wide box cannot
# push every other record out.
MAX_PICTURES = 150
# The JPEG quality a picture is asked for.
QUALITY = 85
# Records a listing gives at most.
MAX_LISTED = 200
RECORD = "record.json"
EVENTS = "events.jsonl"
BOARD = "board.kicad_pcb"
VERSION = 1
RECORD_ID = re.compile(r"^[0-9]{8}-[0-9]{6}-[0-9]{3}$")
# A file of a record that may be handed out: never a path.
FILE_NAME = re.compile(r"^(record\.json|events\.jsonl|board\.kicad_pcb|(stop|look)-[0-9]{3}\.jpg)$")


def _now() -> datetime.datetime:
    return datetime.datetime.now()


def affine_of(transform: Callable[[tuple[float, float]], tuple[float, float]]) -> list[list[float]]:
    """An affine map of the plane (a turn, a flip, a shift) as the rows
    [[a, b, c], [d, e, f]] taking (x, y) to (a x + b y + c, d x + e y + f),
    read off where it takes three points."""
    ox, oy = transform((0.0, 0.0))
    ax, ay = transform((1.0, 0.0))
    bx, by = transform((0.0, 1.0))
    return [[ax - ox, bx - ox, ox], [ay - oy, by - oy, oy]]


class SearchRecord:
    """One record being written: its folder, its header (record.json, the
    outcome added once it ended) and its event lines. `stop` is the
    search's stop being looked at, put on every line written meanwhile."""

    def __init__(self, folder: Path, header: dict, max_events: int, on_close: Callable[[SearchRecord], None]) -> None:
        self.folder = folder
        self.id: str = header["id"]
        self.kind: str = header["kind"]
        self.camera: str = header["camera"]
        self.header = header
        self.started = time.monotonic()
        self.stop: int | None = None
        self.events = 0
        self.pictures = 0
        self.counts: dict[str, int] = {}
        self.outcome: dict | None = None
        self._max_events = max_events
        self._on_close = on_close
        self._lock = threading.Lock()
        self._warned = False

    @property
    def closed(self) -> bool:
        return self.outcome is not None

    @property
    def full(self) -> bool:
        return self.events >= self._max_events

    def since(self, moment: float) -> float:
        """A time.monotonic() moment as seconds from the record's start."""
        return round(moment - self.started, 4)

    def update(self, **fields) -> None:
        """Adds to the header, learned after the start."""
        with self._lock:
            self.header.update(fields)
        self._write_header()

    def event(self, name: str, **fields) -> None:
        """One line: `name`, the time, the stop being looked at, `fields`."""
        with self._lock:
            if self.outcome is not None or self.events >= self._max_events:
                return
            line: dict = {"t": self.since(time.monotonic()), "event": name}
            if self.stop is not None:
                line["stop"] = self.stop
            line.update(fields)
            self.events += 1
            self.counts[name] = self.counts.get(name, 0) + 1
            try:
                with (self.folder / EVENTS).open("a", encoding="utf-8") as out:
                    out.write(json.dumps(line, separators=(",", ":")) + "\n")
            except (OSError, TypeError, ValueError) as exc:
                self._warn(exc)

    def picture(self, client, name: str, **fields) -> str | None:
        """Keeps the picture `client` (a running VisionClient) shows now as
        `name`.jpg, with a `picture` line saying so and `fields`; the file's
        name, or None when the record has had its pictures or none could
        be had, which the line says."""
        if self.closed:
            return None
        if self.pictures >= MAX_PICTURES:
            if self.pictures == MAX_PICTURES:
                self.pictures += 1
                self.event("picture", file=None, error=f"no more pictures: a record keeps {MAX_PICTURES}", **fields)
            return None
        try:
            reply, jpeg = client.frame(width=None, overlay=False, quality=QUALITY)
        except Exception as exc:  # a picture never stops a search
            self.event("picture", file=None, error=str(exc) or type(exc).__name__, **fields)
            return None
        if not jpeg:
            self.event("picture", file=None, error="the camera gave an empty picture", **fields)
            return None
        file = f"{name}.jpg"
        try:
            (self.folder / file).write_bytes(jpeg)
        except OSError as exc:
            self._warn(exc)
            return None
        self.pictures += 1
        self.event(
            "picture", file=file, frame=reply.get("frame"), age_ms=reply.get("age_ms"),
            width=reply.get("width"), height=reply.get("height"), bytes=len(jpeg), **fields,
        )
        return file

    def close(self, result: str, **fields) -> None:
        """Ends the record: how (`found`, `not found`, `stopped`, `error`,
        `unloaded`, `searched`, `cut short`) and `fields` (the estimate,
        the consensus, a message) go into record.json."""
        with self._lock:
            if self.outcome is not None:
                return
            self.outcome = {
                "result": result,
                "ended": _now().isoformat(timespec="milliseconds"),
                "seconds": self.since(time.monotonic()),
                "events": self.events,
                "pictures": min(self.pictures, MAX_PICTURES),
                "counts": dict(self.counts),
                **fields,
            }
        self._write_header()
        self._on_close(self)

    def _write_header(self) -> None:
        with self._lock:
            data = {**self.header, "outcome": self.outcome}
        try:
            write_whole(self.folder / RECORD, json.dumps(data, indent=1) + "\n")
        except (OSError, TypeError, ValueError) as exc:
            self._warn(exc)

    def _warn(self, exc: Exception) -> None:
        if not self._warned:
            self._warned = True
            log.warning("search record %s: cannot write: %s", self.id, exc)


class SearchLog:
    """The records' folder: begins records, lists them, hands out their
    files and keeps them within MAX_RECORDS and MAX_BYTES. `publish` is
    called with the listing after a record begins or ends, for the page."""

    def __init__(self, folder: Path, publish: Callable[[dict], None] | None = None) -> None:
        self.folder = folder
        self._publish = publish or (lambda state: None)
        self._lock = threading.Lock()
        self._open: dict[str, SearchRecord] = {}
        self._last_stamp = ""
        self._serial = 0

    def begin(self, kind: str, camera: str, header: dict, board: Path | None = None) -> SearchRecord | None:
        """A new record of a `kind` (`search` or `look`) by `camera`
        (`head`, `top`), its header `header` and a copy of the `board`
        file; None when its folder cannot be made, which no search stops
        for."""
        with self._lock:
            record_id = self._new_id()
        folder = self.folder / record_id
        full = {"version": VERSION, "id": record_id, "kind": kind, "camera": camera, "started": _now().isoformat(timespec="milliseconds"), **header}
        try:
            folder.mkdir(parents=True)
            if board is not None and board.is_file():
                data = board.read_bytes()
                (folder / BOARD).write_bytes(data)
                full["board"] = {**(full.get("board") or {}), "copy": BOARD, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        except OSError as exc:
            log.warning("search log: cannot begin a record: %s", exc)
            return None
        record = SearchRecord(folder, full, MAX_EVENTS.get(kind, MAX_EVENTS["search"]), self._closed)
        record._write_header()
        with self._lock:
            self._open[record_id] = record
        self._prune()
        self._publish(self.state())
        return record

    def _closed(self, record: SearchRecord) -> None:
        with self._lock:
            self._open.pop(record.id, None)
        self._prune()
        self._publish(self.state())

    # --- reading -------------------------------------------------------------------

    def ids(self) -> list[str]:
        """Every record's id, the oldest first."""
        try:
            return sorted(entry.name for entry in os.scandir(self.folder) if entry.is_dir() and RECORD_ID.match(entry.name))
        except OSError:
            return []

    def get(self, record_id: str) -> dict | None:
        """A record's record.json, None for an id that is not one kept."""
        if not RECORD_ID.match(record_id):
            return None
        try:
            data = json.loads((self.folder / record_id / RECORD).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        return data if isinstance(data, dict) else None

    def folder_of(self, record_id: str) -> Path | None:
        if not RECORD_ID.match(record_id):
            return None
        folder = self.folder / record_id
        return folder if (folder / RECORD).is_file() else None

    def path_of(self, record_id: str, name: str) -> Path | None:
        """A file of a record by its name; None for a name that is not one,
        or one not kept."""
        folder = self.folder_of(record_id)
        if folder is None or not FILE_NAME.match(name):
            return None
        path = folder / name
        return path if path.is_file() else None

    def summary(self, data: dict) -> dict:
        """A record's line in the listing."""
        outcome = data.get("outcome") or {}
        record_id = data.get("id")
        with self._lock:
            running = record_id in self._open
        result = outcome.get("result") or ("running" if running else "unfinished")
        stops = data.get("stops")
        job = data.get("job") or {}
        board = data.get("board") or {}
        counts = outcome.get("counts") or {}
        consensus = outcome.get("consensus") or {}
        return {
            "id": record_id,
            "kind": data.get("kind"),
            "camera": data.get("camera"),
            "started": data.get("started"),
            "job": job.get("id"),
            "job_name": job.get("name"),
            "board": board.get("file"),
            "result": result,
            "message": outcome.get("message"),
            "seconds": outcome.get("seconds"),
            "stops": len(stops) if isinstance(stops, list) else None,
            "visited": outcome.get("visited"),
            "poses": counts.get("pose"),
            "pictures": outcome.get("pictures"),
            "agree": consensus.get("agree"),
            "estimate": outcome.get("estimate"),
        }

    def state(self, limit: int = 20, camera: str | None = None) -> dict:
        """The newest records' lines, of one camera when named."""
        lines = []
        ids = self.ids()
        for record_id in reversed(ids):
            data = self.get(record_id)
            if data is None or (camera is not None and data.get("camera") != camera):
                continue
            lines.append(self.summary(data))
        return {"count": len(lines), "records": lines[: max(0, min(limit, MAX_LISTED))]}

    # --- keeping it small ------------------------------------------------------------

    def clear(self) -> int:
        """Removes every record not being written; the count removed."""
        removed = 0
        for record_id in self.ids():
            with self._lock:
                if record_id in self._open:
                    continue
            if self._remove(record_id):
                removed += 1
        self._publish(self.state())
        return removed

    def _prune(self) -> None:
        ids = self.ids()
        sizes = {record_id: self._size(record_id) for record_id in ids}
        total = sum(sizes.values())
        count = len(ids)
        with self._lock:
            open_ids = set(self._open)
        # The newest record always stays, however big.
        for record_id in ids[:-1]:
            if count <= MAX_RECORDS and total <= MAX_BYTES:
                break
            if record_id in open_ids:
                continue
            if self._remove(record_id):
                count -= 1
                total -= sizes[record_id]

    def _size(self, record_id: str) -> int:
        try:
            return sum(entry.stat().st_size for entry in os.scandir(self.folder / record_id) if entry.is_file())
        except OSError:
            return 0

    def _remove(self, record_id: str) -> bool:
        if not RECORD_ID.match(record_id):
            return False
        try:
            shutil.rmtree(self.folder / record_id)
        except OSError as exc:
            log.warning("search log: cannot remove %s: %s", record_id, exc)
            return False
        return True

    def _new_id(self) -> str:
        """A name sorting by time: the second it began and a count within
        that second, never one a folder already has."""
        stamp = _now().strftime("%Y%m%d-%H%M%S")
        if stamp == self._last_stamp:
            self._serial += 1
        else:
            self._last_stamp = stamp
            self._serial = 0
        while (self.folder / f"{stamp}-{self._serial:03d}").exists():
            self._serial += 1
        return f"{stamp}-{self._serial:03d}"
