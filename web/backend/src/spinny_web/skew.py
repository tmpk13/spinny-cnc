"""A machine's skew learned from the boards found on it: its X and Y scale
(machine mm per true mm) and how far its axes are out of square, shared by
every job on that machine, apart from each board's own stretch.

Each board found with its stretch measured (a posterior look with board
stretch on, or Align's fit of three marks or more, when applied) gives the
board's stretch in its own frame and its turn. Turned into the machine's
frame, that stretch is the machine's skew plus the board's own stretch
turned with the board: the board carries its stretch with it, the machine's
skew stays put. So the boards' stretches in the machine's frame, averaged,
give the machine's skew, and boards found at different turns tell the two
apart (all at one turn, a stretch every board shares, a fab's, looks like
the machine's). The learned skew is shown with its uncertainty and written
to the machine file only on the operator's word: the X and Y joints' full
steps per mm of a cartesian machine on this project's firmware. Out of
square is said, not written: the axes are squared by hand.
"""

from __future__ import annotations

import datetime
import json
import math
import threading
from pathlib import Path

from .files import write_whole
from .log import log

# Boards a machine keeps, the newest; boards' own stretch from one to the
# next (a fab's tolerance), one standard deviation, which the average's
# uncertainty counts beside each fit's own; and how far apart the turns of
# the boards must be, degrees, to tell the machine's skew from a stretch
# the boards share.
KEEP = 50
BOARD_SIGMA = 0.002
SEPARATE_DEG = 30.0


def _turned(sx: float, sy: float, shear_deg: float, turn_deg: float) -> tuple[float, float, float]:
    """A board's stretch (X and Y scale, shear degrees off square, in its
    frame) turned into the machine's frame: the symmetric matrix R S R^T
    as its X scale, Y scale and off diagonal."""
    half = math.tan(math.radians(shear_deg)) / 2.0
    c, s = math.cos(math.radians(turn_deg)), math.sin(math.radians(turn_deg))
    # R S R^T for S = [[sx, half], [half, sy]].
    xx = c * c * sx - 2.0 * c * s * half + s * s * sy
    yy = s * s * sx + 2.0 * c * s * half + c * c * sy
    xy = c * s * (sx - sy) + (c * c - s * s) * half
    return xx, yy, xy


def estimate(boards: list[dict]) -> dict | None:
    """The machine's skew from its boards: X and Y scale and degrees out of
    square, each with its standard deviation, the boards' turns' spread,
    and whether they are far enough apart to tell it from the boards'
    own stretch; None with no board."""
    rows = []
    for board in boards:
        try:
            xx, yy, xy = _turned(float(board["scale_x"]), float(board["scale_y"]), float(board["shear_deg"]), float(board["turn_deg"]))
        except (KeyError, TypeError, ValueError):
            continue
        sd = board.get("sd") or {}
        fit = max(float(sd.get("scale_x") or 0.0), float(sd.get("scale_y") or 0.0))
        weight = 1.0 / (fit * fit + BOARD_SIGMA * BOARD_SIGMA)
        rows.append((xx, yy, xy, weight, float(board["turn_deg"])))
    if not rows:
        return None
    total = sum(row[3] for row in rows)
    mean = [sum(row[i] * row[3] for row in rows) / total for i in range(3)]
    # The spread of the boards about the mean, or the fits' own when one.
    spread = [
        math.sqrt(sum(row[3] * (row[i] - mean[i]) ** 2 for row in rows) / total) if len(rows) > 1 else 0.0
        for i in range(3)
    ]
    floor = 1.0 / math.sqrt(total)
    sd = [max(spread[i] / math.sqrt(max(len(rows) - 1, 1)), floor) for i in range(3)]
    turns = [row[4] % 180.0 for row in rows]
    span = _span(turns)
    return {
        "x_scale": round(mean[0], 6), "x_sd": round(sd[0], 6),
        "y_scale": round(mean[1], 6), "y_sd": round(sd[1], 6),
        # The axes' angle off square: twice the off diagonal, in degrees.
        "square_deg": round(math.degrees(2.0 * mean[2]), 4), "square_sd": round(math.degrees(2.0 * sd[2]), 4),
        "boards": len(rows),
        "turn_span_deg": round(span, 2),
        "separated": len(rows) >= 2 and span >= SEPARATE_DEG,
    }


def _span(turns: list[float]) -> float:
    """How far apart turns lie on a half circle (a stretch is the same
    turned half a turn), degrees: 180 less the widest gap between them."""
    if len(turns) < 2:
        return 0.0
    ordered = sorted(turns)
    gaps = [b - a for a, b in zip(ordered, ordered[1:])] + [ordered[0] + 180.0 - ordered[-1]]
    return 180.0 - max(gaps)


class SkewStore:
    """The boards found on each machine, by the machine file's name, kept
    in a JSON file."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.Lock()
        self._data: dict[str, list[dict]] = {}
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                self._data = {str(key): [b for b in value if isinstance(b, dict)] for key, value in data.items() if isinstance(value, list)}
        except (OSError, ValueError):
            self._data = {}

    def add(self, machine: str, job: str, source: str, turn_deg: float, stretch: dict) -> None:
        """A board found on `machine` with its stretch measured (`stretch`:
        posterior.stretch or fit_marks' stretch()), turned `turn_deg`."""
        board = {
            "t": datetime.datetime.now().isoformat(timespec="seconds"),
            "job": job, "source": source, "turn_deg": round(float(turn_deg), 4),
            "scale_x": float(stretch["scale_x"]), "scale_y": float(stretch["scale_y"]), "shear_deg": float(stretch["shear_deg"]),
            "sd": {"scale_x": float(stretch.get("scale_x_sd") or 0.0), "scale_y": float(stretch.get("scale_y_sd") or 0.0), "shear_deg": float(stretch.get("shear_deg_sd") or 0.0)},
        }
        with self._lock:
            boards = self._data.setdefault(machine, [])
            boards.append(board)
            del boards[:-KEEP]
            self._save()

    def boards(self, machine: str) -> list[dict]:
        with self._lock:
            return list(self._data.get(machine, []))

    def clear(self, machine: str) -> None:
        with self._lock:
            self._data.pop(machine, None)
            self._save()

    def state(self, machine: str | None) -> dict:
        boards = self.boards(machine) if machine else []
        return {"machine": machine, "boards": boards[-10:], "count": len(boards), "estimate": estimate(boards)}

    def _save(self) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            write_whole(self.path, json.dumps(self._data, indent=1))
        except OSError as exc:
            log.warning("skew: %s not written: %s", self.path, exc)
