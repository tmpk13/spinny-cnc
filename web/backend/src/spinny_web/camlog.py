"""The camera log: the pictures the cameras' routines looked at, kept to see
afterwards where a finder went wrong and where it did not.

With logging on, every look a routine takes keeps three things: the
camera's picture as it was, the same picture with what the look found drawn
over it, and a line saying what was asked and what came back. The looks
are the head camera finding its mark; the up camera centering the nozzle,
measuring its runout and looking at a part, a G-code device's run looking
at each part it picked; and the top camera measuring its offset, finding a
board's fiducials and a feeder's marks, and looking at a pocket before its
pick. A look that found nothing is kept too, since that is the one to see.
A photo can be taken by hand at any time, logging on or not.

The picture with the marks is an SVG holding the JPEG and the marks over it
(the picture's center, the circle the finder searched, the spot it found
with the box of its axes and the line from the center to it), so it opens
in any browser with no image library here. A head camera with a board
loaded also gives pcbv's own picture with the board's pose drawn on it.

Everything sits in one folder, the pictures by entry id and an index of the
entries, one JSON line each; the oldest go once there are more than
`MAX_ENTRIES`.
"""

from __future__ import annotations

import base64
import datetime
import json
import logging
import re
import threading
from pathlib import Path
from typing import Callable

from .files import write_whole

log = logging.getLogger("spinny_web.camlog")

# Most entries kept; the oldest go with their pictures past this.
MAX_ENTRIES = 300
# Entries a listing gives at most.
MAX_LISTED = 500
# The JPEG quality a logged picture is asked for.
QUALITY = 90
INDEX = "entries.jsonl"
# A file the log may hand out: an entry's picture, never a path.
FILE_NAME = re.compile(r"^[0-9]{8}-[0-9]{6}-[0-9]{3}(-pose)?\.(jpg|svg)$")
CAMERAS = ("head", "up", "top")

# Colors of the marks, Solarized: the center cyan, the search circle and the
# line base1, a spot found magenta, a spot missed red.
CENTER = "#2aa198"
SEARCH = "#93a1a1"
FOUND = "#d33682"
MISSED = "#dc322f"


def _now() -> datetime.datetime:
    return datetime.datetime.now()


def _escape(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def overlay_svg(jpeg: bytes, width: int, height: int, spot: dict | None, title: str, radius: float | None = None) -> str:
    """The picture with what a look found drawn over it, as an SVG holding
    the JPEG: the center's crosshair, the circle searched (`radius` px, a
    third of the height when not given, as pcbv searches), and with `spot`
    a reply of pcbv's `spot`: found, its center, a box `major` by `minor`
    round it and the line from the picture's center to it; not found, the
    words. `title` goes in the top left corner."""
    cx, cy = width / 2.0, height / 2.0
    search = radius if radius is not None else height / 3.0
    arm = max(8.0, height / 40.0)
    line_width = max(1.5, height / 400.0)
    font = max(12.0, height / 36.0)
    picture = base64.b64encode(jpeg).decode("ascii")
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
        f'<image href="data:image/jpeg;base64,{picture}" x="0" y="0" width="{width}" height="{height}"/>',
        f'<g fill="none" stroke-width="{line_width:.2f}">',
        f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{search:.1f}" stroke="{SEARCH}" stroke-dasharray="{arm:.0f} {arm / 2:.0f}"/>',
        f'<line x1="{cx - arm:.1f}" y1="{cy:.1f}" x2="{cx + arm:.1f}" y2="{cy:.1f}" stroke="{CENTER}"/>',
        f'<line x1="{cx:.1f}" y1="{cy - arm:.1f}" x2="{cx:.1f}" y2="{cy + arm:.1f}" stroke="{CENTER}"/>',
    ]
    lines = [title]
    if spot is not None and spot.get("found"):
        x = float(spot.get("x", cx + float(spot.get("dx", 0.0))))
        y = float(spot.get("y", cy + float(spot.get("dy", 0.0))))
        major = max(4.0, float(spot.get("major", 0.0)))
        minor = max(4.0, float(spot.get("minor", 0.0)))
        parts += [
            f'<line x1="{cx:.1f}" y1="{cy:.1f}" x2="{x:.1f}" y2="{y:.1f}" stroke="{SEARCH}"/>',
            f'<rect x="{x - major / 2:.1f}" y="{y - minor / 2:.1f}" width="{major:.1f}" height="{minor:.1f}" stroke="{FOUND}"/>',
            f'<line x1="{x - arm / 2:.1f}" y1="{y:.1f}" x2="{x + arm / 2:.1f}" y2="{y:.1f}" stroke="{FOUND}"/>',
            f'<line x1="{x:.1f}" y1="{y - arm / 2:.1f}" x2="{x:.1f}" y2="{y + arm / 2:.1f}" stroke="{FOUND}"/>',
        ]
        lines.append(
            f"found at dx {float(spot.get('dx', 0.0)):+.1f} dy {float(spot.get('dy', 0.0)):+.1f} px,"
            f" {major:.1f} x {minor:.1f} px, contrast {float(spot.get('contrast', 0.0)):.0f}"
        )
    elif spot is not None:
        lines.append("nothing found inside the circle")
    parts.append("</g>")
    color = FOUND if spot is None or spot.get("found") else MISSED
    for index, text in enumerate(lines):
        y = font * 1.4 * (index + 1)
        parts.append(
            f'<text x="{font * 0.6:.1f}" y="{y:.1f}" font-family="sans-serif" font-size="{font:.1f}"'
            f' fill="{color if index else CENTER}" stroke="#002b36" stroke-width="{font / 8:.2f}" paint-order="stroke">{_escape(text)}</text>'
        )
    parts.append("</svg>")
    return "\n".join(parts) + "\n"


class CameraLog:
    """The log's folder, its index in memory, and whether looks are kept.

    `publish` is called with the state after every change, for the page.
    """

    def __init__(self, folder: Path, enabled: bool = False, publish: Callable[[dict], None] | None = None) -> None:
        self.folder = folder
        self.enabled = enabled
        self._publish = publish or (lambda state: None)
        self._lock = threading.Lock()
        self._entries: list[dict] = []
        self._last_stamp = ""
        self._serial = 0
        try:
            for line in (folder / INDEX).read_text(encoding="utf-8").splitlines():
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                if isinstance(entry, dict) and isinstance(entry.get("id"), str):
                    self._entries.append(entry)
        except OSError:
            pass

    # --- the state --------------------------------------------------------------

    def state(self, limit: int = 100, camera: str | None = None) -> dict:
        with self._lock:
            entries = [entry for entry in self._entries if camera is None or entry.get("camera") == camera]
        newest = list(reversed(entries))[: max(0, min(limit, MAX_LISTED))]
        return {"enabled": self.enabled, "count": len(entries), "entries": newest}

    def set_enabled(self, on: bool) -> dict:
        self.enabled = bool(on)
        state = self.state()
        self._publish(state)
        return state

    def clear(self) -> int:
        """Forgets every entry and removes its pictures; the count removed."""
        with self._lock:
            gone = self._entries
            self._entries = []
            self._write_index()
        for entry in gone:
            self._remove_files(entry)
        self._publish(self.state())
        return len(gone)

    def path_of(self, name: str) -> Path | None:
        """The file of a logged picture, by its name; None for a name that
        is not one, or one not kept."""
        if not FILE_NAME.match(name):
            return None
        path = self.folder / name
        return path if path.is_file() else None

    # --- keeping a look ---------------------------------------------------------

    def look(
        self,
        client,
        camera: str,
        routine: str,
        step: str,
        spot: dict | None = None,
        note: str = "",
        radius: float | None = None,
        pose: bool = False,
        force: bool = False,
    ) -> dict | None:
        """Keeps the picture `client` (a running VisionClient) shows now,
        and the same with the marks of `spot`, a reply of its `spot`, when
        logging is on or `force`; with `pose`, also pcbv's picture with the
        board's pose drawn. The entry kept, or None when nothing was: the
        log is off, or the picture could not be had or kept, which a
        routine never stops for."""
        if not (self.enabled or force):
            return None
        # The reply's protocol id says nothing about the picture.
        if spot is not None:
            spot = {key: value for key, value in spot.items() if key != "id"}
        try:
            reply, jpeg = client.frame(width=None, overlay=False, quality=QUALITY)
        except Exception as exc:
            log.warning("camera log: no picture from the %s camera: %s", camera, exc)
            return None
        width = int(reply.get("width", 0) or 0)
        height = int(reply.get("height", 0) or 0)
        if width <= 0 or height <= 0 or not jpeg:
            return None
        entry_id = self._new_id()
        title = f"{camera} camera, {routine}: {step}" + (f" ({note})" if note else "")
        files = {"photo": f"{entry_id}.jpg", "overlay": f"{entry_id}.svg"}
        try:
            self.folder.mkdir(parents=True, exist_ok=True)
            (self.folder / files["photo"]).write_bytes(jpeg)
            (self.folder / files["overlay"]).write_text(overlay_svg(jpeg, width, height, spot, title, radius), encoding="utf-8")
            if pose:
                try:
                    _, drawn = client.frame(width=None, overlay=True, quality=QUALITY)
                    if drawn:
                        files["pose"] = f"{entry_id}-pose.jpg"
                        (self.folder / files["pose"]).write_bytes(drawn)
                except Exception as exc:
                    log.warning("camera log: no pose picture from the %s camera: %s", camera, exc)
        except OSError as exc:
            log.warning("camera log: cannot keep a picture: %s", exc)
            return None
        entry = {
            "id": entry_id,
            "time": _now().isoformat(timespec="milliseconds"),
            "camera": camera,
            "routine": routine,
            "step": step,
            "note": note,
            "width": width,
            "height": height,
            "frame": reply.get("frame"),
            "age_ms": reply.get("age_ms"),
            "spot": spot,
            "files": files,
        }
        with self._lock:
            self._entries.append(entry)
            dropped = self._entries[:-MAX_ENTRIES] if len(self._entries) > MAX_ENTRIES else []
            if dropped:
                self._entries = self._entries[-MAX_ENTRIES:]
                self._write_index()
            else:
                self._append_index(entry)
        for old in dropped:
            self._remove_files(old)
        self._publish(self.state())
        return entry

    # --- the files ----------------------------------------------------------------

    def _new_id(self) -> str:
        """A name sorting by time: the second it was taken and a count
        within that second."""
        with self._lock:
            stamp = _now().strftime("%Y%m%d-%H%M%S")
            if stamp == self._last_stamp:
                self._serial += 1
            else:
                self._last_stamp = stamp
                self._serial = 0
            # A restart within the same second must not reuse a name.
            while any(entry["id"] == f"{stamp}-{self._serial:03d}" for entry in self._entries[-50:]):
                self._serial += 1
            return f"{stamp}-{self._serial:03d}"

    def _append_index(self, entry: dict) -> None:
        try:
            with (self.folder / INDEX).open("a", encoding="utf-8") as index:
                index.write(json.dumps(entry, separators=(",", ":")) + "\n")
        except OSError as exc:
            log.warning("camera log: cannot write the index: %s", exc)

    def _write_index(self) -> None:
        try:
            self.folder.mkdir(parents=True, exist_ok=True)
            write_whole(self.folder / INDEX, "".join(json.dumps(entry, separators=(",", ":")) + "\n" for entry in self._entries))
        except OSError as exc:
            log.warning("camera log: cannot write the index: %s", exc)

    def _remove_files(self, entry: dict) -> None:
        for name in (entry.get("files") or {}).values():
            if isinstance(name, str) and FILE_NAME.match(name):
                try:
                    (self.folder / name).unlink()
                except OSError:
                    pass
