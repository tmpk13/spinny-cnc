"""What a search record (searchlog.py) says, to find where a look for a
board went wrong and to try a change against real searches before it
reaches the machine:

- where the time went: each stop's move and look, the first pose used, the
  moment enough agreed;
- what pcbv saw at each stop: its states, how many features it paired of
  those it expected, its rms and time per frame, which look it used;
- how far each estimate lay from where the board lies, taken as the place
  the search found (or a place given, from fiducials or a ruler), and the
  outliers; stops where the board filled a good part of the picture and
  pcbv never locked (misses, pictures to try pcbv on);
- what other consensus settings (looks needed in a row, the distance they
  must agree within) would have called on the same poses, and whether that
  call would have been right;
- with a pcbv program, what it makes of the record's pictures now
  (`pcbv locate`), against what was recorded and the truth.

As text for a terminal or an agent, as JSON, or as one HTML page that
shows the pictures by their names beside it (the backend serves it from a
record's folder; written into the folder it opens as a file too).

    spinny-search list [--dir DIR] [--camera head|top] [-n N]
    spinny-search show ID|FOLDER [--dir DIR] [--truth X,Y,DEG] [--need 3,4,5]
                       [--agree 0.25,0.5,1] [--pcbv PROGRAM] [--json] [--html FILE]
    spinny-search sweep [--dir DIR] [--camera head|top] [--kind search|look]
                        [--need 3,4,5] [--agree 0.25,0.5,1] [--pcbv PROGRAM] [--json]

`sweep` runs every record kept through the same: a change to the
consensus settings or to pcbv weighed on all the searches at once.
"""

from __future__ import annotations

import argparse
import html as markup
import json
import math
import statistics
import subprocess
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import TypeGuard

from spinny_laser.align import turn

from .boardlook import Consensus, Estimate
from .camera import picture_to_machine
from .searchlog import BOARD, EVENTS, RECORD, RECORD_ID

Point = tuple[float, float]

# A stop whose picture the board covers this much of (by the place taken
# as the truth) is one pcbv should have locked at: no lock there is a miss.
MISS_COVER = 0.25
# The consensus settings tried on a record's poses when none are given.
NEEDS = (3, 4, 5, 6, 7)
AGREES = (0.25, 0.5, 1.0)
# How long one `pcbv locate` may take, s.
LOCATE_SECONDS = 120.0
# Outliers listed at most.
OUTLIERS = 20


def _number(value) -> TypeGuard[int | float]:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _point(value) -> Point | None:
    """[x, y] or {"x", "y"} as a point."""
    if isinstance(value, dict):
        x, y = value.get("x"), value.get("y")
    elif isinstance(value, (list, tuple)) and len(value) == 2:
        x, y = value[0], value[1]
    else:
        return None
    return (float(x), float(y)) if _number(x) and _number(y) else None


def _wrap(degrees: float) -> float:
    return (degrees + 180.0) % 360.0 - 180.0


def _median(values) -> float | None:
    values = [float(v) for v in values if _number(v)]
    return statistics.median(values) if values else None


def _quantile(values: list[float], q: float) -> float | None:
    values = sorted(values)
    if not values:
        return None
    return values[min(len(values) - 1, max(0, math.ceil(q * len(values)) - 1))]


# --- the record --------------------------------------------------------------------------


@dataclass
class Record:
    """A record read back: its folder, record.json and the event lines."""

    folder: Path
    header: dict
    events: list[dict]

    @property
    def outcome(self) -> dict:
        return self.header.get("outcome") or {}

    @property
    def settings(self) -> dict:
        return self.header.get("settings") or {}

    @property
    def middle(self) -> Point:
        return _point(self.header.get("middle")) or (0.0, 0.0)

    def of(self, name: str) -> list[dict]:
        return [event for event in self.events if event.get("event") == name]


def load(folder: Path) -> Record:
    """A record's folder read: a ValueError when it holds none."""
    try:
        header = json.loads((folder / RECORD).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ValueError(f"{folder} holds no search record: {exc}") from exc
    if not isinstance(header, dict):
        raise ValueError(f"{folder / RECORD} is not a search record")
    events: list[dict] = []
    try:
        lines = (folder / EVENTS).read_text(encoding="utf-8").splitlines()
    except OSError:
        lines = []
    for line in lines:
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if isinstance(event, dict):
            events.append(event)
    return Record(folder, header, events)


@dataclass
class Place:
    """Where the board lies on the machine, taken as the truth: the turn
    (degrees counterclockwise) and the shift that take the job's frame
    onto the machine's, and where that came from (`found`, `given`)."""

    rotation: float
    shift: Point
    source: str

    def apply(self, point: Point) -> Point:
        x, y = turn(point, self.rotation)
        return (x + self.shift[0], y + self.shift[1])

    def back(self, point: Point) -> Point:
        return turn((point[0] - self.shift[0], point[1] - self.shift[1]), -self.rotation)


def found_place(record: Record) -> Place | None:
    """The place a record's search or look found, None when it found none."""
    estimate = record.outcome.get("estimate")
    if record.outcome.get("result") != "found" or not isinstance(estimate, dict):
        return None
    rotation, shift = estimate.get("rotation"), _point(estimate.get("shift"))
    if not _number(rotation) or shift is None:
        return None
    return Place(float(rotation), shift, "found")


def given_place(record: Record, text: str) -> Place:
    """`X,Y,DEG`: the board's middle on the machine and its turn."""
    try:
        x, y, degrees = (float(part) for part in text.split(","))
    except ValueError as exc:
        raise ValueError("the truth is X,Y,DEG: the board's middle on the machine, mm, and its turn, degrees") from exc
    tx, ty = turn(record.middle, degrees)
    return Place(degrees, (x - tx, y - ty), "given")


def board_point(record: Record, job: Point) -> Point | None:
    """A point in the job's frame as a KiCad board point, through the
    record's map from board points to the job's frame."""
    rows = record.header.get("board_to_job")
    if not (isinstance(rows, list) and len(rows) == 2 and all(isinstance(row, list) and len(row) == 3 and all(_number(v) for v in row) for row in rows)):
        return None
    (a, b, c), (d, e, f) = rows
    det = a * e - b * d
    if abs(det) < 1e-12:
        return None
    x, y = job[0] - c, job[1] - f
    return ((e * x - b * y) / det, (-d * x + a * y) / det)


def _estimate(data) -> Estimate | None:
    """An estimate as a record keeps it, back as one the consensus takes."""
    if not isinstance(data, dict):
        return None
    center, shift, rotation = _point(data.get("center")), _point(data.get("shift")), data.get("rotation")
    if center is None or shift is None or not _number(rotation):
        return None
    rms = data.get("rms")
    return Estimate(float(rotation), shift, center, float(rms) if _number(rms) else 0.0, [], _point(data.get("seen")))


# --- geometry: how much of a picture the board covers --------------------------------------


def _area(points: list[Point]) -> float:
    """The signed area: positive counterclockwise."""
    return 0.5 * sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(points, points[1:] + points[:1]))


def _crossing(p: Point, q: Point, a: Point, b: Point) -> Point:
    """Where segment p-q crosses the line through a and b."""
    dx, dy = q[0] - p[0], q[1] - p[1]
    ex, ey = b[0] - a[0], b[1] - a[1]
    denominator = dx * ey - dy * ex
    if abs(denominator) < 1e-15:
        return q
    t = ((a[0] - p[0]) * ey - (a[1] - p[1]) * ex) / denominator
    return (p[0] + t * dx, p[1] + t * dy)


def _clip(subject: list[Point], clip: list[Point]) -> list[Point]:
    """The part of convex polygon `subject` inside convex polygon `clip`."""
    sign = 1.0 if _area(clip) >= 0.0 else -1.0
    output = list(subject)
    for a, b in zip(clip, clip[1:] + clip[:1]):
        if not output:
            break
        points, output = output, []
        inside = [sign * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) >= 0.0 for p in points]
        for index, p in enumerate(points):
            q = points[index - 1]
            if inside[index]:
                if not inside[index - 1]:
                    output.append(_crossing(q, p, a, b))
                output.append(p)
            elif inside[index - 1]:
                output.append(_crossing(q, p, a, b))
    return output


def cover(picture: list[Point], board: list[Point]) -> float:
    """How much of the picture (a convex polygon) the board's covers, 0 to 1."""
    whole = abs(_area(picture))
    if whole <= 0.0:
        return 0.0
    return min(1.0, abs(_area(_clip(picture, board))) / whole)


def picture_polygon(record: Record, center: Point) -> list[Point] | None:
    """A picture's corners on the machine with its center at `center`, from
    the record's picture size and scale; None when the record has none."""
    picture = record.header.get("picture") or {}
    width, height = picture.get("width"), picture.get("height")
    scale = picture.get("mm_per_px_used") or picture.get("mm_per_px")
    if not (_number(width) and _number(height) and _number(scale)) or scale <= 0.0:
        return None
    roll, mirror = float(picture.get("roll") or 0.0), bool(picture.get("mirror"))
    w, h = float(width) / 2.0, float(height) / 2.0
    corners = []
    for dx, dy in ((-w, -h), (w, -h), (w, h), (-w, h)):
        off = picture_to_machine(dx, dy, float(scale), roll, mirror)
        corners.append((center[0] + off[0], center[1] + off[1]))
    return corners


def board_polygon(record: Record, truth: Place | None) -> list[Point] | None:
    """The board's outline box on the machine where `truth` puts it."""
    box = record.header.get("outline_box")
    if truth is None or not (isinstance(box, list) and len(box) == 4 and all(_number(v) for v in box)):
        return None
    x0, y0, x1, y1 = (float(v) for v in box)
    return [truth.apply(corner) for corner in ((x0, y0), (x1, y0), (x1, y1), (x0, y1))]


# --- the summary -----------------------------------------------------------------------------


def _quality(poses: list[dict]) -> dict:
    """pcbv's medians over some poses: features paired of those expected,
    rms, time per frame, spots, and the looks it used."""
    raws = [event.get("pose") or {} for event in poses]
    locked = [raw for raw in raws if raw.get("state") == "locked"]
    ratios = [raw["inliers"] / raw["expected"] for raw in locked if _number(raw.get("inliers")) and _number(raw.get("expected")) and raw["expected"] > 0]
    return {
        "inliers": _median(raw.get("inliers") for raw in locked),
        "expected": _median(raw.get("expected") for raw in locked),
        "paired": round(statistics.median(ratios), 3) if ratios else None,
        "rms_mm": _median(raw.get("rms_mm") for raw in locked),
        "ms": _median(raw.get("ms") for raw in raws),
        "spots": _median(raw.get("spots") for raw in raws),
        "looks": dict(Counter(str(raw.get("look")) for raw in raws if raw.get("look") is not None)),
    }


def _deviation(event: dict, truth_middle: Point | None, truth: Place | None) -> tuple[float, float] | None:
    estimate = event.get("estimate")
    if truth is None or truth_middle is None or not isinstance(estimate, dict):
        return None
    center, rotation = _point(estimate.get("center")), estimate.get("rotation")
    if center is None or not _number(rotation):
        return None
    return math.dist(center, truth_middle), abs(_wrap(float(rotation) - truth.rotation))


def _stops(record: Record, truth: Place | None, truth_middle: Point | None) -> list[dict]:
    """Each stop a search went to: its moves, looks, poses and picture."""
    events_of: dict[int, list[dict]] = {}
    for event in record.events:
        index = event.get("index") if event.get("event") in ("stop", "arrived", "stop_end", "picture") else event.get("stop")
        if isinstance(index, int) and not isinstance(index, bool):
            events_of.setdefault(index, []).append(event)
    targets = [_point(stop) for stop in record.header.get("stops") or []]
    board = board_polygon(record, truth)
    rows = []
    for index in sorted(events_of):
        events = events_of[index]

        def first(name: str, events: list[dict] = events) -> dict:
            return next((event for event in events if event.get("event") == name), {})

        begun, arrived, ended, picture = first("stop"), first("arrived"), first("stop_end"), first("picture")
        poses = [event for event in events if event.get("event") == "pose"]
        target = _point(begun.get("target")) or (targets[index] if index < len(targets) else None)
        used = [event for event in poses if event.get("seen") == "used"]
        deviations = [d for d in (_deviation(event, truth_middle, truth) for event in used) if d is not None]
        covered = None
        if board is not None and target is not None:
            polygon = picture_polygon(record, target)
            covered = round(cover(polygon, board), 3) if polygon is not None else None
        middle = bool(begun.get("middle"))
        rows.append({
            "index": index,
            "middle": middle,
            "target": list(target) if target is not None else None,
            "move_s": round(arrived["t"] - begun["t"], 3) if _number(arrived.get("t")) and _number(begun.get("t")) else None,
            "look_s": ended.get("seconds"),
            "result": ended.get("result"),
            "poses": len(poses),
            "used": len(used),
            "refused": sum(1 for event in poses if event.get("seen") == "locked"),
            "states": dict(Counter(str(event.get("state")) for event in poses)),
            **_quality(poses),
            "deviation_mm": _median(d[0] for d in deviations),
            "deviation_max_mm": max((d[0] for d in deviations), default=None),
            "cover": covered,
            "missed": bool(covered is not None and covered >= MISS_COVER and not used and not middle),
            "picture": picture.get("file"),
        })
    return rows


def summarize(record: Record, truth: Place | None = None) -> dict:
    """What a record says, as plain data (see the module's docstring)."""
    header, outcome, settings = record.header, record.outcome, record.settings
    truth = truth or found_place(record)
    truth_middle = truth.apply(record.middle) if truth is not None else None
    agree_mm = float(settings.get("agree_mm") or 0.5)
    agree_deg = float(settings.get("agree_deg") or 1.0)
    poses = record.of("pose")
    deviations = [(event, d) for event in poses for d in [_deviation(event, truth_middle, truth)] if d is not None]
    distances = [d[0] for _, d in deviations]
    turns = [d[1] for _, d in deviations]
    outliers = [
        {
            "t": event.get("t"), "stop": event.get("stop"), "frame": event.get("frame"),
            "mm": round(d[0], 3), "deg": round(d[1], 3),
            "inliers": (event.get("pose") or {}).get("inliers"), "expected": (event.get("pose") or {}).get("expected"),
            "rms_mm": (event.get("pose") or {}).get("rms_mm"), "look": (event.get("pose") or {}).get("look"),
        }
        for event, d in deviations
        if d[0] > agree_mm or d[1] > agree_deg
    ]
    stops = _stops(record, truth, truth_middle) if header.get("kind") == "search" else []
    board = header.get("board") or {}
    job = header.get("job") or {}
    return {
        "id": header.get("id"),
        "kind": header.get("kind"),
        "camera": header.get("camera"),
        "started": header.get("started"),
        "job": job.get("name") or job.get("id"),
        "board": {"file": board.get("file"), "side": board.get("side"), "finish": board.get("finish")},
        "result": outcome.get("result") or "unfinished",
        "message": outcome.get("message"),
        "seconds": outcome.get("seconds"),
        "visited": outcome.get("visited"),
        "found_at": outcome.get("found_at"),
        "stop_count": len(header.get("stops") or []),
        "estimate": outcome.get("estimate"),
        "truth": {"source": truth.source, "middle": [round(truth_middle[0], 4), round(truth_middle[1], 4)], "rotation": round(truth.rotation, 4)} if truth is not None and truth_middle is not None else None,
        "settings": settings,
        "picture": header.get("picture"),
        "poses": len(poses),
        "states": dict(Counter(str(event.get("state")) for event in poses)),
        "seen": dict(Counter(str(event.get("seen")) for event in poses)),
        "refused": dict(Counter(str(event.get("refused") or event.get("problem") or "no reason") for event in poses if event.get("seen") == "locked")),
        "first_used_s": next((event.get("t") for event in poses if event.get("seen") == "used"), None),
        "found_s": next((event.get("t") for event in poses if (event.get("consensus") or {}).get("found")), None),
        "pcbv": _quality(poses),
        "deviation": {
            "count": len(distances),
            "median_mm": _median(distances), "p90_mm": _quantile(distances, 0.9), "max_mm": max(distances, default=None),
            "median_deg": _median(turns), "max_deg": max(turns, default=None),
            "outliers": len(outliers),
        } if distances else None,
        "outliers": outliers[:OUTLIERS],
        "stops": stops,
        "missed": [row["index"] for row in stops if row["missed"]],
        "pictures": [{"file": event.get("file"), "stop": event.get("index"), "why": event.get("why")} for event in record.of("picture") if event.get("file")],
        "errors": [event.get("text") for event in record.of("error")][:10],
    }


# --- what other settings would have called ------------------------------------------------


def what_ifs(record: Record, truth: Place | None = None, needs=NEEDS, agrees=AGREES) -> list[dict]:
    """The record's poses run again through a consensus for each number of
    looks needed in a row and distance they must agree within: when it
    would have called the board found, and how far from the truth. The
    search would have ended there; what came after it is not asked."""
    truth = truth or found_place(record)
    truth_middle = truth.apply(record.middle) if truth is not None else None
    settings = record.settings
    poses = record.of("pose")
    rows = []
    for need in needs:
        for agree in agrees:
            consensus = Consensus(record.middle, need=int(need), agree_mm=float(agree), agree_deg=settings.get("agree_deg"), window=settings.get("window"))
            row: dict = {
                "need": int(need), "agree_mm": float(agree), "found": False,
                "recorded": int(need) == settings.get("need") and math.isclose(float(agree), float(settings.get("agree_mm") or -1.0)),
            }
            for count, event in enumerate(poses, 1):
                consensus.see(event.get("state"), _estimate(event.get("estimate")), event.get("refused") or event.get("problem"))
                if consensus.found and consensus.best is not None:
                    best = consensus.best
                    row.update(found=True, t=event.get("t"), stop=event.get("stop"), poses=count, center=[round(best.center[0], 4), round(best.center[1], 4)], rotation=round(best.rotation, 4))
                    if truth is not None and truth_middle is not None:
                        row["error_mm"] = round(math.dist(best.center, truth_middle), 4)
                        row["error_deg"] = round(abs(_wrap(best.rotation - truth.rotation)), 4)
                    break
            rows.append(row)
    return rows


# --- pcbv again ---------------------------------------------------------------------------


def _picture_center(record: Record, picture: dict) -> Point | None:
    """Where a picture's center lay on the machine: its stop's, or for a
    look's picture the place of the newest pose before it that had one."""
    index = picture.get("index")
    if isinstance(index, int) and not isinstance(index, bool):
        for event in record.of("stop"):
            if event.get("index") == index:
                return _point(event.get("target"))
    place = None
    for event in record.events:
        if event is picture:
            break
        if event.get("event") == "pose" and isinstance(event.get("place"), dict):
            place = _point(event["place"].get("center"))
    return place


def rerun_pcbv(record: Record, program: str, truth: Place | None = None, timeout: float = LOCATE_SECONDS) -> list[dict]:
    """Each of the record's pictures given to `program locate` with the
    record's board, side and finish: whether it locks now, where, and how
    far from the board point the truth puts under the picture's center."""
    truth = truth or found_place(record)
    board = record.folder / BOARD
    if not board.is_file():
        raise ValueError(f"{board} is missing: the record kept no board file")
    kept = record.header.get("board") or {}
    side, finish = str(kept.get("side") or "front"), str(kept.get("finish") or "masked")
    stops = {row["index"]: row for row in _stops(record, None, None)}
    rows = []
    for picture in record.of("picture"):
        file = picture.get("file")
        if not file:
            continue
        index = picture.get("index")
        row: dict = {"file": file, "stop": index}
        if index in stops:
            row["recorded"] = f"{stops[index]['used']}/{stops[index]['poses']}"
        command = [program, "locate", str(board), str(record.folder / file), "--side", side, "--finish", finish, "--json"]
        try:
            done = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
        except (OSError, subprocess.TimeoutExpired) as exc:
            row["error"] = str(exc)
            rows.append(row)
            continue
        try:
            seen = json.loads(done.stdout)
        except ValueError:
            row["error"] = (done.stderr.strip().splitlines() or [f"exit {done.returncode}"])[-1]
            rows.append(row)
            continue
        pose = seen.get("pose") if isinstance(seen, dict) else None
        timing = seen.get("timing") if isinstance(seen, dict) else None
        row.update(
            state=str(seen.get("state", "")).lower() if isinstance(seen, dict) else None,
            locked=isinstance(pose, dict),
            ms=timing.get("total_ms") if isinstance(timing, dict) else None,
            spots=len(seen.get("spots") or []) if isinstance(seen, dict) else None,
        )
        if isinstance(pose, dict):
            center = _point(pose.get("center"))
            row.update(center=list(center) if center else None, inliers=pose.get("inliers"), expected=pose.get("expected"), rms_mm=pose.get("rms_mm"))
            where = _picture_center(record, picture)
            expected = board_point(record, truth.back(where)) if truth is not None and where is not None else None
            if center is not None and expected is not None:
                row["truth_center"] = [round(expected[0], 4), round(expected[1], 4)]
                row["error_mm"] = round(math.dist(center, expected), 4)
        rows.append(row)
    return rows


# --- text ------------------------------------------------------------------------------------


def _stop_name(index, stop_count: int) -> str:
    """A stop by its number from 1, the look over the board's middle as such."""
    if not isinstance(index, int) or isinstance(index, bool):
        return "no stop"
    return "the middle" if stop_count and index >= stop_count else f"stop {index + 1}"


def _f(value, digits: int = 2, unit: str = "") -> str:
    return f"{value:.{digits}f}{unit}" if _number(value) else "-"


def _counts(counts: dict) -> str:
    return ", ".join(f"{name} {count}" for name, count in sorted(counts.items(), key=lambda item: -item[1])) or "none"


def text(summary: dict, ifs: list[dict] | None = None, pcbv: list[dict] | None = None) -> str:
    """The summary as lines for a terminal or an agent."""
    s = summary
    board = s["board"]
    lines = [
        f"{s['kind']} {s['id']}: {s['camera']} camera, job {s['job']} ({board.get('file') or 'board'}, {board.get('side')}, {board.get('finish')}), started {s['started']}",
    ]
    where = ""
    if s["kind"] == "search" and s.get("visited") is not None:
        where = f", {s['visited']} of {s['stop_count']} stops visited"
        if s.get("found_at") is not None:
            where += f", found at stop {s['found_at'] + 1}"
    lines.append(f"result: {s['result']} after {_f(s.get('seconds'), 1, ' s')}{where}" + (f": {s['message']}" if s.get("message") else ""))
    truth = s.get("truth")
    if truth:
        lines.append(f"board taken to lie with its middle at {truth['middle'][0]:.3f}, {truth['middle'][1]:.3f} mm, turned {truth['rotation']:+.3f} degrees ({truth['source']})")
    seen = s["seen"]
    lines.append(
        f"poses: {s['poses']} read: {seen.get('used', 0)} used, {seen.get('locked', 0)} locked but refused"
        f" ({_counts(s['refused'])}), {seen.get('none', 0)} not locked ({_counts({k: v for k, v in s['states'].items() if k != 'locked'})})"
    )
    lines.append(f"first pose used at {_f(s.get('first_used_s'), 1, ' s')}, enough agreed at {_f(s.get('found_s'), 1, ' s')}")
    q = s["pcbv"]
    lines.append(
        f"pcbv, medians: {_f(q.get('inliers'), 0)} of {_f(q.get('expected'), 0)} features paired when locked, rms {_f(q.get('rms_mm'), 3, ' mm')},"
        f" {_f(q.get('ms'), 0, ' ms')} a frame, {_f(q.get('spots'), 0)} spots; looks {_counts(q.get('looks') or {})}"
    )
    d = s.get("deviation")
    if d:
        lines.append(
            f"estimates against the truth: {d['count']}, median {_f(d['median_mm'], 3, ' mm')} {_f(d['median_deg'], 3, ' deg')},"
            f" 90% within {_f(d['p90_mm'], 3, ' mm')}, worst {_f(d['max_mm'], 3, ' mm')} {_f(d['max_deg'], 3, ' deg')}; {d['outliers']} outside the agreement"
        )
        for o in s["outliers"][:8]:
            stop = _stop_name(o.get("stop"), s["stop_count"])
            lines.append(f"  outlier at {_f(o['t'], 2, ' s')} ({stop}, frame {o['frame']}): {o['mm']:.3f} mm {o['deg']:.3f} deg off, {o.get('inliers')}/{o.get('expected')} paired, rms {_f(o.get('rms_mm'), 3)}")
    elif not truth:
        lines.append("no truth: the record found no board; give one with --truth X,Y,DEG to measure the estimates")
    if s["stops"]:
        lines.append("stops (place mm, move and look s, result, poses used/refused/read, paired, rms mm, ms, board cover, deviation mm, picture):")
        for row in s["stops"]:
            target = row["target"] or [math.nan, math.nan]
            name = "middle" if row["middle"] else f"{row['index'] + 1:3d}"
            cover_text = f"{row['cover'] * 100:3.0f}%" if _number(row.get("cover")) else "  -"
            counts = f"{row['used']}/{row['refused']}/{row['poses']}"
            lines.append(
                f"  {name:>6} {target[0]:8.2f} {target[1]:8.2f}  {_f(row['move_s'], 1):>5} {_f(row['look_s'], 1):>5}  {str(row['result']):8}"
                f" {counts:>11} {_f(row['paired'], 2):>5} {_f(row['rms_mm'], 3):>6} {_f(row['ms'], 0):>5}"
                f"  {cover_text} {_f(row['deviation_mm'], 3):>6}  {row['picture'] or '-'}{'  MISSED' if row['missed'] else ''}"
            )
        if s["missed"]:
            lines.append(f"missed: {len(s['missed'])} stops where the board covered at least {MISS_COVER:.0%} of the picture and nothing was used: " + ", ".join(str(i + 1) for i in s["missed"]))
    if s["errors"]:
        lines.append("pcbv errors: " + "; ".join(str(e) for e in s["errors"]))
    if ifs:
        lines.append("other settings on the same poses (need in a row, agree within mm: when found, how far off):")
        for row in ifs:
            mark = " (as recorded)" if row["recorded"] else ""
            if row["found"]:
                stop = _stop_name(row.get("stop"), s["stop_count"])
                off = f", {row['error_mm']:.3f} mm {row['error_deg']:.3f} deg off" if "error_mm" in row else ""
                wrong = "  WRONG" if "error_mm" in row and row["error_mm"] > row["agree_mm"] else ""
                lines.append(f"  need {row['need']} within {row['agree_mm']:g} mm: found at {_f(row['t'], 1, ' s')} ({stop}, pose {row['poses']}){off}{wrong}{mark}")
            else:
                lines.append(f"  need {row['need']} within {row['agree_mm']:g} mm: never{mark}")
    if pcbv is not None:
        lines.append("pcbv locate on the pictures now (locked, error against the truth, paired, ms; recorded used/read at that stop):")
        for row in pcbv:
            if "error" in row:
                lines.append(f"  {row['file']}: {row['error']}")
                continue
            got = f"locked, {_f(row.get('error_mm'), 3, ' mm')} off, {row.get('inliers')}/{row.get('expected')} paired" if row.get("locked") else f"{row.get('state') or 'no pose'}, {row.get('spots')} spots"
            lines.append(f"  {row['file']}: {got}, {_f(row.get('ms'), 0, ' ms')}; recorded {row.get('recorded', '-')}")
    return "\n".join(lines) + "\n"


# --- the page --------------------------------------------------------------------------------

STYLE = """
:root {
  --bg: #fdf6e3; --panel: #eee8d5; --text: #657b83; --strong: #586e75; --muted: #93a1a1;
  --line: #e4dcc4; --red: #dc322f; --yellow: #b58900; --green: #859900; --cyan: #2aa198;
  --blue: #268bd2; --magenta: #d33682; --violet: #6c71c4;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #002b36; --panel: #073642; --text: #839496; --strong: #93a1a1; --muted: #586e75; --line: #0d4553; }
}
body { background: var(--bg); color: var(--text); font: 0.95rem/1.45 system-ui, sans-serif; margin: 0; padding: 1rem 1.25rem 3rem; }
main { max-width: 80rem; margin: 0 auto; }
h1 { color: var(--strong); font-size: 1.4rem; margin: 0 0 0.25rem; }
h2 { color: var(--strong); font-size: 1.1rem; margin: 1.75rem 0 0.5rem; }
p { margin: 0.35rem 0; }
.muted { color: var(--muted); }
.result { font-weight: 600; }
.found { color: var(--magenta); } .notfound, .missed { color: var(--red); } .other { color: var(--yellow); }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.2rem 1rem; margin: 0.5rem 0; }
dt { color: var(--muted); } dd { margin: 0; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; font-variant-numeric: tabular-nums; font-size: 0.9rem; }
th, td { padding: 0.2rem 0.6rem; border-bottom: 1px solid var(--line); text-align: right; white-space: nowrap; }
th { color: var(--muted); font-weight: 500; }
td.left, th.left { text-align: left; }
tr.missed td { color: var(--red); } tr.wrong td { color: var(--red); } tr.recorded td { font-weight: 600; }
svg { display: block; width: 100%; height: auto; background: var(--panel); border-radius: 0.4rem; }
.map { max-width: 48rem; }
.pictures { display: grid; grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr)); gap: 0.75rem; }
figure { margin: 0; } figure img { width: 100%; border-radius: 0.3rem; display: block; }
figcaption { font-size: 0.85rem; margin-top: 0.2rem; }
code { background: var(--panel); padding: 0.05rem 0.3rem; border-radius: 0.2rem; }
a { color: var(--blue); }
"""


def _e(value) -> str:
    return markup.escape(str(value), quote=True)


def _map_svg(record: Record, summary: dict, truth: Place | None) -> str:
    """The box, the stops' pictures in the order visited, where the board
    lies by the truth and where each used pose put its middle; the
    machine's Y up."""
    header = record.header
    stops = summary["stops"]
    board = board_polygon(record, truth)
    shapes: list[tuple[str, list[Point]]] = []
    box = header.get("box")
    points: list[Point] = []
    if isinstance(box, list) and len(box) == 4 and all(_number(v) for v in box):
        x0, y0, x1, y1 = (float(v) for v in box)
        corners = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
        shapes.append(("box", corners))
        points += corners
    for row in stops:
        target = _point(row["target"])
        polygon = picture_polygon(record, target) if target is not None else None
        if polygon is not None:
            points += polygon
    if board is not None:
        points += board
    centers = [c for c in (_point((event.get("estimate") or {}).get("center")) for event in record.of("pose")) if c is not None]
    points += centers
    if not points:
        return ""
    xs, ys = [p[0] for p in points], [p[1] for p in points]
    span = max(max(xs) - min(xs), max(ys) - min(ys), 1.0)
    pad = span * 0.05
    left, top = min(xs) - pad, -max(ys) - pad
    width, height = max(xs) - min(xs) + 2 * pad, max(ys) - min(ys) + 2 * pad
    font = span / 45.0

    def path(polygon: list[Point]) -> str:
        return " ".join(f"{x:.3f},{-y:.3f}" for x, y in polygon)

    parts = [f'<svg class="map" viewBox="{left:.3f} {top:.3f} {width:.3f} {height:.3f}" role="img" aria-label="the search on the machine">']
    for _, corners in shapes:
        parts.append(f'<polygon points="{path(corners)}" fill="none" stroke="var(--muted)" stroke-dasharray="4 3" vector-effect="non-scaling-stroke"/>')
    visited = []
    for row in stops:
        target = _point(row["target"])
        polygon = picture_polygon(record, target) if target is not None else None
        if target is None:
            continue
        visited.append(target)
        color = "var(--magenta)" if row["result"] == "found" else "var(--red)" if row["missed"] else "var(--yellow)" if row["used"] else "var(--muted)"
        if row["middle"]:
            color = "var(--cyan)"
        if polygon is not None:
            parts.append(f'<polygon points="{path(polygon)}" fill="{color}" fill-opacity="0.12" stroke="{color}" vector-effect="non-scaling-stroke"/>')
        label = "m" if row["middle"] else str(row["index"] + 1)
        parts.append(f'<text x="{target[0]:.3f}" y="{-target[1]:.3f}" font-size="{font:.3f}" text-anchor="middle" dominant-baseline="middle" fill="{color}">{_e(label)}</text>')
    if len(visited) > 1:
        parts.append(f'<polyline points="{path(visited)}" fill="none" stroke="var(--blue)" stroke-opacity="0.5" vector-effect="non-scaling-stroke"/>')
    if board is not None:
        parts.append(f'<polygon points="{path(board)}" fill="none" stroke="var(--green)" stroke-width="2" vector-effect="non-scaling-stroke"/>')
    truth_middle = truth.apply(record.middle) if truth is not None else None
    agree = float(record.settings.get("agree_mm") or 0.5)
    for center in centers:
        near = truth_middle is not None and math.dist(center, truth_middle) <= agree
        parts.append(f'<circle cx="{center[0]:.3f}" cy="{-center[1]:.3f}" r="{span / 300.0:.3f}" fill="{"var(--cyan)" if near else "var(--red)"}"/>')
    parts.append("</svg>")
    return "".join(parts)


def _timeline_svg(record: Record, summary: dict) -> str:
    """Each pose read along the time (used high, refused in the middle, not
    locked low), the run of agreeing looks below it, and the stops' starts."""
    poses = record.of("pose")
    end = max([float(event.get("t") or 0.0) for event in record.events] + [float(summary.get("seconds") or 0.0), 0.001])
    width, height = 1000.0, 160.0

    def x(t) -> float:
        return 10.0 + (float(t) / end) * (width - 20.0)

    need = int(record.settings.get("need") or 5)
    lanes = {"used": 20.0, "locked": 45.0, "none": 70.0}
    colors = {"used": "var(--green)", "locked": "var(--yellow)", "none": "var(--muted)"}
    parts = [f'<svg viewBox="0 0 {width:.0f} {height:.0f}" role="img" aria-label="the poses along the time">']
    for name, y in lanes.items():
        parts.append(f'<text x="12" y="{y - 6:.0f}" font-size="9" fill="var(--muted)">{_e(name)}</text>')
    for event in record.of("stop"):
        if _number(event.get("t")):
            label = "m" if event.get("middle") else str(int(event.get("index", 0)) + 1)
            parts.append(f'<line x1="{x(event["t"]):.1f}" y1="5" x2="{x(event["t"]):.1f}" y2="{height - 5:.0f}" stroke="var(--line)"/>')
            parts.append(f'<text x="{x(event["t"]) + 2:.1f}" y="{height - 6:.0f}" font-size="9" fill="var(--muted)">{_e(label)}</text>')
    steps = []
    for event in poses:
        if not _number(event.get("t")):
            continue
        seen = str(event.get("seen"))
        parts.append(f'<circle cx="{x(event["t"]):.1f}" cy="{lanes.get(seen, 70.0):.0f}" r="2.2" fill="{colors.get(seen, "var(--muted)")}"/>')
        agree = (event.get("consensus") or {}).get("agree") or 0
        steps.append((x(event["t"]), 140.0 - 40.0 * min(float(agree), need) / max(need, 1)))
    if steps:
        line = " ".join(f"{px:.1f},{py:.1f}" for px, py in steps)
        parts.append(f'<polyline points="{line}" fill="none" stroke="var(--magenta)" stroke-width="1.5"/>')
        parts.append(f'<line x1="10" y1="100" x2="{width - 10:.0f}" y2="100" stroke="var(--magenta)" stroke-dasharray="3 3" stroke-opacity="0.5"/>')
        parts.append(f'<text x="12" y="96" font-size="9" fill="var(--muted)">{need} agreeing</text>')
    parts.append(f'<text x="{width - 12:.0f}" y="12" font-size="9" text-anchor="end" fill="var(--muted)">{end:.1f} s</text>')
    parts.append("</svg>")
    return "".join(parts)


def _table(head: list[str], rows: list[list], classes: list[str] | None = None, left: int = 0) -> str:
    """A table: `left` first columns aligned left, `classes` per row."""
    cells = "".join(f'<th class="left">{_e(h)}</th>' if i < left else f"<th>{_e(h)}</th>" for i, h in enumerate(head))
    body = []
    for n, row in enumerate(rows):
        css = f' class="{classes[n]}"' if classes and classes[n] else ""
        tds = "".join(f'<td class="left">{cell}</td>' if i < left else f"<td>{cell}</td>" for i, cell in enumerate(row))
        body.append(f"<tr{css}>{tds}</tr>")
    return f'<div class="scroll"><table><thead><tr>{cells}</tr></thead><tbody>{"".join(body)}</tbody></table></div>'


def html(record: Record, truth: Place | None = None, ifs: list[dict] | None = None, pcbv: list[dict] | None = None) -> str:
    """The record as one page; pictures by their names, beside it."""
    truth = truth or found_place(record)
    s = summarize(record, truth)
    ifs = what_ifs(record, truth) if ifs is None else ifs
    title = f"Board {s['kind']} {s['id']}"
    result_class = {"found": "found", "not found": "notfound"}.get(str(s["result"]), "other")
    board, picture, settings = s["board"], s.get("picture") or {}, s["settings"]
    out = [f"<title>{_e(title)}</title>", f"<style>{STYLE}</style>", "<main>", f"<h1>{_e(title)}</h1>"]
    out.append(f'<p class="muted">{_e(s["camera"])} camera, job {_e(s["job"])}, {_e(board.get("file") or "board")} ({_e(board.get("side"))}, {_e(board.get("finish"))}), started {_e(s["started"])}</p>')
    where = ""
    if s["kind"] == "search" and s.get("visited") is not None:
        where = f", {s['visited']} of {s['stop_count']} stops visited" + (f", found at stop {s['found_at'] + 1}" if s.get("found_at") is not None else "")
    out.append(f'<p><span class="result {result_class}">{_e(s["result"])}</span> after {_e(_f(s.get("seconds"), 1, " s"))}{_e(where)}{": " + _e(s["message"]) if s.get("message") else ""}</p>')
    truth_text = "none: no board was found; the command line takes one with --truth X,Y,DEG"
    if s.get("truth"):
        t = s["truth"]
        truth_text = f"middle at {t['middle'][0]:.3f}, {t['middle'][1]:.3f} mm, turned {t['rotation']:+.3f} degrees ({t['source']})"
    seen = s["seen"]
    q = s["pcbv"]
    facts = [
        ("Board taken to lie", truth_text),
        ("Poses read", f"{s['poses']}: {seen.get('used', 0)} used, {seen.get('locked', 0)} locked but refused, {seen.get('none', 0)} not locked"),
        ("Refused because", _counts(s["refused"])),
        ("States", _counts(s["states"])),
        ("First pose used", _f(s.get("first_used_s"), 1, " s")),
        ("Enough agreed", _f(s.get("found_s"), 1, " s")),
        ("pcbv, medians", f"{_f(q.get('inliers'), 0)} of {_f(q.get('expected'), 0)} features paired when locked, rms {_f(q.get('rms_mm'), 3, ' mm')}, {_f(q.get('ms'), 0, ' ms')} a frame, {_f(q.get('spots'), 0)} spots"),
        ("pcbv looks", _counts(q.get("looks") or {})),
        ("Camera", f"offset {picture.get('offset')}, roll {picture.get('roll')}, mirror {picture.get('mirror')}, {picture.get('mm_per_px_used') or picture.get('mm_per_px')} mm/px, {picture.get('width', '?')} x {picture.get('height', '?')} px, {picture.get('device')}"),
        ("Settings", ", ".join(f"{k} {v}" for k, v in settings.items())),
        ("pcbv", json.dumps(record.header.get("pcbv"))),
    ]
    d = s.get("deviation")
    if d:
        facts.insert(1, ("Estimates against it", f"{d['count']}: median {_f(d['median_mm'], 3, ' mm')} {_f(d['median_deg'], 3, ' deg')}, 90% within {_f(d['p90_mm'], 3, ' mm')}, worst {_f(d['max_mm'], 3, ' mm')} {_f(d['max_deg'], 3, ' deg')}; {d['outliers']} outside the agreement"))
    if s["errors"]:
        facts.append(("pcbv errors", "; ".join(str(e) for e in s["errors"])))
    out.append("<dl>" + "".join(f"<dt>{_e(k)}</dt><dd>{_e(v)}</dd>" for k, v in facts) + "</dl>")
    if s["stops"]:
        out.append("<h2>The search</h2>")
        out.append('<p class="muted">Pictures by stop: magenta found, yellow used poses, red missed (the board covered at least a quarter of the picture and nothing was used), grey nothing, cyan the look at the middle; green the board where it lies, dots where each used pose put its middle (red: outside the agreement). The machine\'s Y points up.</p>')
        out.append(_map_svg(record, s, truth))
    out.append("<h2>Along the time</h2>")
    out.append('<p class="muted">Each pose read: used (green), locked but refused (yellow), not locked (grey); the magenta line is the run of looks agreeing, the dashed one the run that calls the board found; numbers mark the stops.</p>')
    out.append(_timeline_svg(record, s))
    if s["stops"]:
        out.append("<h2>Stops</h2>")
        rows, classes = [], []
        for row in s["stops"]:
            target = row["target"] or [math.nan, math.nan]
            cover_text = f"{row['cover'] * 100:.0f}%" if _number(row.get("cover")) else "-"
            link = f'<a href="{_e(row["picture"])}">{_e(row["picture"])}</a>' if row["picture"] else "-"
            rows.append([
                "middle" if row["middle"] else str(row["index"] + 1), f"{target[0]:.2f}, {target[1]:.2f}", _f(row["move_s"], 1), _f(row["look_s"], 1),
                _e(row["result"]), f"{row['used']} / {row['refused']} / {row['poses']}", _f(row["paired"], 2), _f(row["rms_mm"], 3), _f(row["ms"], 0),
                _f(row["spots"], 0), _e(_counts(row["looks"])), cover_text, _f(row["deviation_mm"], 3), _f(row["deviation_max_mm"], 3), link,
            ])
            classes.append("missed" if row["missed"] else "")
        out.append(_table(["Stop", "Place, mm", "Move s", "Look s", "Result", "Used / refused / read", "Paired", "rms mm", "ms", "Spots", "Looks", "Board cover", "Off mm", "Worst mm", "Picture"], rows, classes, left=0))
    if s["outliers"]:
        out.append("<h2>Outliers</h2>")
        rows = [[_f(o["t"], 2), _e(_stop_name(o.get("stop"), s["stop_count"])), _e(o["frame"]), _f(o["mm"], 3), _f(o["deg"], 3), f"{o.get('inliers')}/{o.get('expected')}", _f(o.get("rms_mm"), 3), _e(o.get("look") or "-")] for o in s["outliers"]]
        out.append(_table(["t s", "Stop", "Frame", "Off mm", "Off deg", "Paired", "rms mm", "Look"], rows))
    out.append("<h2>Other settings on the same poses</h2>")
    out.append('<p class="muted">The poses run again through the consensus: when each number of looks in a row, agreeing within each distance, would have called the board found, and how far from where it lies (red: further than its own agreement). The search would have ended there.</p>')
    rows, classes = [], []
    for row in ifs:
        off = f"{row['error_mm']:.3f} mm, {row['error_deg']:.3f} deg" if "error_mm" in row else "-"
        when = f"{_f(row['t'], 1, ' s')}, {_stop_name(row.get('stop'), s['stop_count'])}, pose {row['poses']}" if row["found"] else "never"
        rows.append([str(row["need"]), f"{row['agree_mm']:g}", when, off, "as recorded" if row["recorded"] else ""])
        classes.append("wrong" if "error_mm" in row and row["error_mm"] > row["agree_mm"] else "recorded" if row["recorded"] else "")
    out.append(_table(["Need", "Within mm", "Found", "Off", ""], rows, classes, left=0))
    if pcbv is not None:
        out.append("<h2>pcbv on the pictures now</h2>")
        rows = []
        for row in pcbv:
            if "error" in row:
                rows.append([_e(row["file"]), _e(row["error"]), "", "", "", ""])
                continue
            rows.append([_e(row["file"]), "locked" if row.get("locked") else _e(row.get("state")), _f(row.get("error_mm"), 3), f"{row.get('inliers', '-')}/{row.get('expected', '-')}", _f(row.get("ms"), 0), _e(row.get("recorded", "-"))])
        out.append(_table(["Picture", "Now", "Off mm", "Paired", "ms", "Recorded used/read"], rows, left=1))
    if s["pictures"]:
        out.append("<h2>Pictures</h2>")
        stops = {row["index"]: row for row in s["stops"]}
        figures = []
        for p in s["pictures"]:
            row = stops.get(p.get("stop"))
            caption = p.get("why") or ""
            if row is not None:
                caption = ("middle" if row["middle"] else f"stop {row['index'] + 1}") + f": {row['result']}, {row['used']} used of {row['poses']}" + (f", board cover {row['cover'] * 100:.0f}%" if _number(row.get("cover")) else "")
            figures.append(f'<figure><a href="{_e(p["file"])}"><img src="{_e(p["file"])}" alt="{_e(caption)}" loading="lazy"></a><figcaption>{_e(caption)}</figcaption></figure>')
        out.append(f'<div class="pictures">{"".join(figures)}</div>')
    out.append("<h2>Trying pcbv on these pictures</h2>")
    out.append(
        f"<p>In this record's folder: <code>pcbv locate {BOARD} stop-000.jpg --side {_e(board.get('side') or 'front')} --finish {_e(board.get('finish') or 'masked')} -o overlay.png</code>;"
        f" every picture against the truth: <code>mise run search-report -- show {_e(s['id'])} --pcbv PROGRAM</code>. The data: "
        f'<a href="{RECORD}">{RECORD}</a>, <a href="{EVENTS}">{EVENTS}</a>.</p>'
    )
    out.append("</main>")
    return "\n".join(out) + "\n"


# --- every record at once ----------------------------------------------------------------------


def sweep(records: list[Record], needs=NEEDS, agrees=AGREES, program: str | None = None) -> dict:
    """Every record's poses through each consensus setting, totalled: in how
    many it would have called the board found, how often wrongly (further
    from the place the search found than its own agreement), in how many
    the search itself found nothing, and the poses and seconds it took;
    with `program`, every picture given to that pcbv against the poses
    recorded at its stop. A change to the search's settings or to pcbv is
    weighed on every search kept instead of on one."""
    totals: dict[tuple[int, float], dict] = {}
    for record in records:
        found = found_place(record) is not None
        for row in what_ifs(record, None, needs, agrees):
            key = (row["need"], row["agree_mm"])
            total = totals.setdefault(key, {"need": row["need"], "agree_mm": row["agree_mm"], "records": 0, "found": 0, "wrong": 0, "found_unjudged": 0, "recorded": 0, "poses": [], "t": []})
            total["records"] += 1
            total["recorded"] += 1 if row["recorded"] else 0
            if not row["found"]:
                continue
            total["found"] += 1
            total["poses"].append(row["poses"])
            total["t"].append(row["t"])
            if not found:
                total["found_unjudged"] += 1
            elif row.get("error_mm", 0.0) > row["agree_mm"]:
                total["wrong"] += 1
    settings = []
    for total in totals.values():
        poses, seconds = total.pop("poses"), total.pop("t")
        total["median_poses"] = _median(poses)
        total["median_s"] = _median(seconds)
        settings.append(total)
    answer: dict = {"records": len(records), "found": sum(1 for record in records if found_place(record) is not None), "settings": settings}
    if program is not None:
        lines = []
        for record in records:
            if not (record.folder / BOARD).is_file() or not any(event.get("file") for event in record.of("picture")):
                continue
            stops = {row["index"]: row for row in _stops(record, None, None)}
            rows = rerun_pcbv(record, program)
            done = [row for row in rows if "error" not in row]
            used_at = [row for row in done if isinstance(row.get("stop"), int) and stops.get(row["stop"], {}).get("used")]
            errors = [row["error_mm"] for row in done if _number(row.get("error_mm"))]
            lines.append({
                "id": record.header.get("id"),
                "pictures": len(rows),
                "failed": len(rows) - len(done),
                "locked_now": sum(1 for row in done if row.get("locked")),
                "used_then": len(used_at),
                "lost_now": sum(1 for row in used_at if not row.get("locked")),
                "gained_now": sum(1 for row in done if row.get("locked") and row not in used_at),
                "median_error_mm": _median(errors),
            })
        answer["pcbv"] = lines
    return answer


def sweep_text(answer: dict) -> str:
    """A sweep as lines for a terminal or an agent."""
    lines = [f"{answer['records']} records, {answer['found']} found the board (their found place is the truth below)"]
    lines.append("need within mm: found in, wrong, found where the search found nothing, median poses and seconds to found")
    for total in answer["settings"]:
        mark = f" (as recorded in {total['recorded']})" if total["recorded"] else ""
        lines.append(
            f"  need {total['need']} within {total['agree_mm']:g}: {total['found']} of {total['records']}, {total['wrong']} wrong,"
            f" {total['found_unjudged']} unjudged, {_f(total['median_poses'], 0)} poses, {_f(total['median_s'], 1, ' s')}{mark}"
        )
    if "pcbv" in answer:
        lines.append("pcbv on every picture now: locked now of the pictures; of the stops where a pose was used then, lost now; locked now where none was used then; median distance from the truth")
        for line in answer["pcbv"]:
            failed = f", {line['failed']} failed" if line["failed"] else ""
            lines.append(
                f"  {line['id']}: {line['locked_now']} of {line['pictures']} locked{failed}; {line['lost_now']} of {line['used_then']} lost,"
                f" {line['gained_now']} gained; {_f(line['median_error_mm'], 3, ' mm')}"
            )
    return "\n".join(lines) + "\n"


# --- the command line ------------------------------------------------------------------------


def default_dir() -> Path:
    """The backend's search records: var/searchlog under the spinny home."""
    from spinny_laser import home

    return home.root() / "var" / "searchlog"


def _find(reference: str, folder: Path) -> Path:
    path = Path(reference)
    if (path / RECORD).is_file():
        return path
    if RECORD_ID.match(reference) and (folder / reference / RECORD).is_file():
        return folder / reference
    raise ValueError(f"no search record {reference!r}: neither a folder holding {RECORD} nor a record id in {folder}")


def _numbers(text: str, kind: type) -> tuple:
    try:
        return tuple(kind(part) for part in text.split(",") if part.strip())
    except ValueError as exc:
        raise ValueError(f"{text!r} is not a list of numbers separated by commas") from exc


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="spinny-search", description="Search records of the cameras' looks for a board: list them, show what one says, or sweep them all.")
    parser.add_argument("--dir", type=Path, default=None, help="the records' folder (default: var/searchlog under the spinny home)")
    commands = parser.add_subparsers(dest="command", required=True)
    listing = commands.add_parser("list", help="the newest records, one line each")
    listing.add_argument("--camera", choices=("head", "top"), help="only this camera's")
    listing.add_argument("-n", type=int, default=20, help="how many (default 20)")
    show = commands.add_parser("show", help="what one record says")
    show.add_argument("record", help="a record's id, or its folder")
    show.add_argument("--truth", help="X,Y,DEG: where the board's middle lies on the machine and its turn, from fiducials or a ruler (default: where the record found it)")
    show.add_argument("--need", default=",".join(str(n) for n in NEEDS), help="looks in a row to try on the poses (default %(default)s)")
    show.add_argument("--agree", default=",".join(f"{a:g}" for a in AGREES), help="agreement distances to try, mm (default %(default)s)")
    show.add_argument("--pcbv", metavar="PROGRAM", help="run PROGRAM locate on each picture with the record's board")
    show.add_argument("--json", action="store_true", help="print the summary, the other settings and pcbv's results as JSON")
    show.add_argument("--html", type=Path, metavar="FILE", help="write the page to FILE (in the record's folder for the pictures to show)")
    sweeping = commands.add_parser("sweep", help="every record's poses through other consensus settings, and with --pcbv every picture through a pcbv build, totalled")
    sweeping.add_argument("--camera", choices=("head", "top"), help="only this camera's records")
    sweeping.add_argument("--kind", choices=("search", "look"), help="only searches, or only looks")
    sweeping.add_argument("--need", default=",".join(str(n) for n in NEEDS), help="looks in a row to try (default %(default)s)")
    sweeping.add_argument("--agree", default=",".join(f"{a:g}" for a in AGREES), help="agreement distances to try, mm (default %(default)s)")
    sweeping.add_argument("--pcbv", metavar="PROGRAM", help="run PROGRAM locate on every record's pictures")
    sweeping.add_argument("--json", action="store_true", help="print the totals as JSON")
    args = parser.parse_args(argv)
    folder = args.dir if args.dir is not None else default_dir()
    try:
        if args.command == "list":
            from .searchlog import SearchLog

            for line in SearchLog(folder).state(args.n, args.camera)["records"]:
                estimate = line.get("estimate") or {}
                center = estimate.get("center")
                where = f" middle {center[0]:.2f}, {center[1]:.2f} turned {estimate.get('rotation', 0.0):+.2f}" if isinstance(center, list) else ""
                stops = f" {line['visited']}/{line['stops']} stops" if line.get("stops") else ""
                print(f"{line['id']}  {line['camera']:4} {line['kind']:6} {line['result']:10} {_f(line.get('seconds'), 1, ' s'):>8}{stops}  {line.get('job_name') or line.get('job')}{where}")
            return 0
        if args.command == "sweep":
            records = []
            for path in sorted(folder.iterdir()) if folder.is_dir() else []:
                if not RECORD_ID.match(path.name):
                    continue
                try:
                    record = load(path)
                except ValueError:
                    continue
                if (args.camera and record.header.get("camera") != args.camera) or (args.kind and record.header.get("kind") != args.kind):
                    continue
                records.append(record)
            answer = sweep(records, _numbers(args.need, int), _numbers(args.agree, float), args.pcbv)
            if args.json:
                print(json.dumps(answer, indent=1))
            else:
                sys.stdout.write(sweep_text(answer))
            return 0
        record = load(_find(args.record, folder))
        truth = given_place(record, args.truth) if args.truth else None
        ifs = what_ifs(record, truth, _numbers(args.need, int), _numbers(args.agree, float))
        pcbv = rerun_pcbv(record, args.pcbv, truth) if args.pcbv else None
        if args.html is not None:
            args.html.write_text(html(record, truth, ifs, pcbv), encoding="utf-8")
        if args.json:
            print(json.dumps({"summary": summarize(record, truth), "what_ifs": ifs, "pcbv": pcbv}, indent=1))
        else:
            sys.stdout.write(text(summarize(record, truth), ifs, pcbv))
        return 0
    except ValueError as exc:
        print(f"spinny-search: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
