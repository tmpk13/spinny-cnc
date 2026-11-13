"""Looking for a board with a camera that rides on the head: the head
camera of a machine on this project's firmware, or a G-code machine's top
camera.

pcbv, given the board's KiCad file, localizes every picture against it and
reports a pose: the KiCad board point under the picture's center, the
board points under its corners, and its own scale. With the machine point
the picture's center saw when the frame was taken (the head's place plus
the camera's offset) and how the picture's pixels turn into the machine's
mm (the camera's roll and mirror, pcbv's scale), each locked pose is an
estimate of where the board lies on the machine: the turn and the shift
that take the job's frame onto the machine's, fitted to the picture's
center and corners (or, from a pose without corners, its center and the
picture's angle on the board).

One pose can be wrong: a repeated pattern matched a pitch off, a picture
taken while the head still moved. So the board is called found only when
several looks in a row agree: the newest estimates within AGREE_MM of the
median place of the board's middle and AGREE_DEG of the median turn, NEED
of them in a row. The estimate reported is the median of the ones that
agree, and the spread says how far they lie apart. A pose is used only
when the head is known to have been at rest when its frame was taken.

The search moves the head so the picture's center visits a grid of stops
over a box, a picture's size apart less an overlap, nearest the start
first, and looks at each until the board is found, no lock comes, or the
stop's time is up. It always ends: found, the box covered, or stopped.
"""

from __future__ import annotations

import math
import statistics
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Callable

from spinny_laser.align import fit_rigid, turn

from . import camera as camera_module
from .camera import picture_to_machine
from .kinematics import FOCUS_DECIMALS, coord
from .link import idle_status, settle
from .log import log
from .vision import VisionClient, VisionError

Point = tuple[float, float]
Box = tuple[float, float, float, float]

# Estimates agree when the board's middle lies within this of their median,
# mm, and the turn within this of theirs, degrees; this many in a row call
# the board found, out of the newest this many kept.
AGREE_MM = 0.5
AGREE_DEG = 1.0
NEED = 5
WINDOW = 9
# How often the watcher asks pcbv for its pose while a board is loaded, s,
# and how often at most it tells the page that the look changed.
SAMPLE_SECONDS = 0.2
PUBLISH_SECONDS = 0.5
# The search: how much of a picture the next stop's picture overlaps, the
# most stops a box may take, how long a stop is looked at once a lock came
# (s), and how long one is looked at for a first lock.
OVERLAP = 0.3
MAX_STOPS = 400
STOP_SECONDS = 5.0
LOCK_SECONDS = 2.5
# The speed a G-code machine's head is taken to move at when a place it is
# seen at changed, mm/s, for when the move ends: lower than any feed, so the
# wait is long enough.
SLOW_MM_S = 20.0


@dataclass
class PictureFrame:
    """Where a picture lay on the machine when its frame was taken: the
    machine point under its center, and the roll and mirror its pixels
    turn into the machine's mm by."""

    center: Point
    roll: float
    mirror: bool = False


@dataclass
class Estimate:
    """Where one pose puts the board: the turn (degrees counterclockwise)
    and shift that take the job's frame onto the machine's, the board's
    middle on the machine, the fit's rms (mm), the picture's corners and
    center in the job's frame, and when the frame was taken."""

    rotation: float
    shift: Point
    center: Point
    rms: float
    corners: list[Point] = field(default_factory=list)
    seen: Point | None = None
    captured: float = 0.0

    def apply(self, point: Point) -> Point:
        x, y = turn(point, self.rotation)
        return (x + self.shift[0], y + self.shift[1])

    def to_dict(self) -> dict:
        return {
            "rotation": round(self.rotation, 4),
            "shift": [round(self.shift[0], 4), round(self.shift[1], 4)],
            "center": [round(self.center[0], 4), round(self.center[1], 4)],
            "rms": round(self.rms, 4),
        }


def _number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _point(value) -> Point | None:
    if isinstance(value, (list, tuple)) and len(value) == 2 and all(_number(v) for v in value):
        return (float(value[0]), float(value[1]))
    return None


def _area(points: list[Point]) -> float:
    """Twice the signed area of a polygon: positive counterclockwise."""
    return sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(points, points[1:] + points[:1]))


def _wrap(degrees: float) -> float:
    return (degrees + 180.0) % 360.0 - 180.0


def pose_estimate(raw: dict, frame: PictureFrame, to_job: Callable[[Point], Point], middle: Point, captured: float = 0.0) -> tuple[Estimate | None, str | None]:
    """Where a locked pose puts the board, and None for any other; or a
    reason the pose cannot be used (a picture mirrored against the board).
    `to_job` takes a KiCad board point to the job's frame, `middle` is the
    board's middle in the job's frame."""
    if raw.get("state") != "locked":
        return None, None
    center = _point(raw.get("center"))
    if center is None:
        return None, None
    seen = to_job(center)
    corners = raw.get("corners")
    width, height, scale = raw.get("width"), raw.get("height"), raw.get("mm_per_px")
    if (
        isinstance(corners, list) and len(corners) == 4 and all(_point(c) is not None for c in corners)
        and _number(width) and _number(height) and _number(scale) and scale > 0.0
    ):
        w, h = float(width), float(height)
        pixels = [(w / 2.0, h / 2.0), (0.0, 0.0), (w, 0.0), (w, h), (0.0, h)]
        boards = [center, *[_point(c) for c in corners]]
        pairs = []
        for (px, py), board in zip(pixels, boards):
            off = picture_to_machine(px - w / 2.0, py - h / 2.0, float(scale), frame.roll, frame.mirror)
            pairs.append((to_job(board), (frame.center[0] + off[0], frame.center[1] + off[1])))
        jobs = [pair[0] for pair in pairs[1:]]
        machines = [pair[1] for pair in pairs[1:]]
        if _area(jobs) * _area(machines) < 0.0:
            return None, "the picture is mirrored against the board: check the camera's side (front or back) and its mirror"
        fit = fit_rigid(pairs)
        estimate = Estimate(fit.rotation, fit.shift, fit.apply(middle), fit.rms, jobs, seen, captured)
        return estimate, None
    angle = raw.get("angle_deg")
    if not _number(angle):
        return None, None
    # pcbv's angle is the picture's x axis on the board, the camera's roll
    # the same axis on the machine: the board is turned by the difference.
    rotation = _wrap(frame.roll - float(angle))
    tx, ty = turn(seen, rotation)
    shift = (frame.center[0] - tx, frame.center[1] - ty)
    estimate = Estimate(rotation, shift, (0.0, 0.0), 0.0, [], seen, captured)
    estimate.center = estimate.apply(middle)
    return estimate, None


class Consensus:
    """The newest estimates, and whether enough of them in a row agree to
    call the board found. The thresholds are the module's unless given:
    a search record's poses are replayed with others to see what they
    would have called (searchreport.py)."""

    def __init__(
        self,
        middle: Point = (0.0, 0.0),
        need: int | None = None,
        agree_mm: float | None = None,
        agree_deg: float | None = None,
        window: int | None = None,
    ) -> None:
        self.middle = middle
        self.need = NEED if need is None else need
        self.agree_mm = AGREE_MM if agree_mm is None else agree_mm
        self.agree_deg = AGREE_DEG if agree_deg is None else agree_deg
        # The window holds at least the run that calls the board found.
        self.window = max(WINDOW if window is None else window, self.need)
        self.reset()

    def reset(self) -> None:
        self.estimates: deque[Estimate] = deque(maxlen=self.window)
        # Poses read, and the locked ones that gave an estimate.
        self.looks = 0
        self.locked = 0
        self.last_state: str | None = None
        self.problem: str | None = None
        self.agree = 0
        self.best: Estimate | None = None
        self.spread_mm: float | None = None
        self.spread_deg: float | None = None
        # The newest pose's picture on the board, while it is locked.
        self.view: Estimate | None = None

    @property
    def found(self) -> bool:
        return self.agree >= self.need

    def see(self, state: str | None, estimate: Estimate | None, problem: str | None) -> None:
        """One pose read: its state, the estimate it gave (None when it gave
        none, or could not be used), and why not when it could not."""
        self.looks += 1
        self.last_state = state
        self.problem = problem
        if state != "locked":
            self.view = None
        if estimate is None:
            return
        self.locked += 1
        self.view = estimate
        self.estimates.append(estimate)
        self._settle()

    def _settle(self) -> None:
        estimates = list(self.estimates)
        newest = estimates[-1]
        turns = [newest.rotation + _wrap(e.rotation - newest.rotation) for e in estimates]
        mx = statistics.median(e.center[0] for e in estimates)
        my = statistics.median(e.center[1] for e in estimates)
        mr = statistics.median(turns)
        inside = [math.dist(e.center, (mx, my)) <= self.agree_mm and abs(r - mr) <= self.agree_deg for e, r in zip(estimates, turns)]
        agree = 0
        for ok in reversed(inside):
            if not ok:
                break
            agree += 1
        self.agree = agree
        kept = [(e, r) for (e, r), ok in zip(zip(estimates, turns), inside) if ok]
        if not kept:
            self.best = None
            self.spread_mm = self.spread_deg = None
            return
        cx = statistics.median(e.center[0] for e, _ in kept)
        cy = statistics.median(e.center[1] for e, _ in kept)
        rotation = statistics.median(r for _, r in kept)
        tx, ty = turn(self.middle, rotation)
        self.best = Estimate(_wrap(rotation), (cx - tx, cy - ty), (cx, cy), statistics.median(e.rms for e, _ in kept), newest.corners, newest.seen, newest.captured)
        self.spread_mm = max(math.dist(e.center, (cx, cy)) for e, _ in kept)
        self.spread_deg = max(abs(r - rotation) for _, r in kept)

    def to_dict(self) -> dict:
        view = self.view
        return {
            "looks": self.looks,
            "locked": self.locked,
            "pose": self.last_state,
            "agree": self.agree,
            "need": self.need,
            "found": self.found,
            "spread_mm": round(self.spread_mm, 4) if self.spread_mm is not None else None,
            "spread_deg": round(self.spread_deg, 4) if self.spread_deg is not None else None,
            "estimate": self.best.to_dict() if self.best is not None else None,
            "view": [[round(x, 4), round(y, 4)] for x, y in view.corners] if view is not None and view.corners else None,
            "seen": [round(view.seen[0], 4), round(view.seen[1], 4)] if view is not None and view.seen is not None else None,
            "problem": self.problem,
        }


class RestTracker:
    """When the head last came to rest, told from the places it is seen
    at: a place that changed is a move that ends once `travel` (the move's
    length at `speed`, mm/s, or nothing for a place seen only at rest) and
    the camera's settle time have passed."""

    def __init__(self, speed: float | None = None) -> None:
        self.speed = speed
        self.place: Point | None = None
        self.quiet: float | None = None

    def see(self, place: Point | None, moving: bool = False, now: float | None = None) -> float | None:
        """The time from which a frame shows the head at rest where it is
        seen now; None while it moves or its place is not known."""
        now = time.monotonic() if now is None else now
        if place is None or moving:
            self.place = None
            self.quiet = None
            return None
        if self.place is None or math.dist(place, self.place) > 1e-4:
            travel = math.dist(place, self.place) / self.speed if self.place is not None and self.speed else 0.0
            self.place = place
            self.quiet = now + travel + camera_module.SETTLE_SECONDS
        return self.quiet


# The place a frame's picture had, from when the frame was taken: a frame,
# or why the pose cannot be used (the head moving, the offset not known).
PlaceOf = Callable[[float], "PictureFrame | str"]


class BoardLook:
    """One camera's look for a board: the job whose board its pcbv has
    loaded, a watcher thread reading poses into a consensus while the
    camera runs, and the state the page shows. `client` gives the
    camera's pcbv; `place` gives the picture's place on the machine for a
    frame taken at a time; `paused` holds the watcher off while a routine
    moves the head and reads the poses itself; `publish` tells the page."""

    def __init__(self, client: Callable[[], VisionClient], publish: Callable[[], None], paused: Callable[[], bool]) -> None:
        self._client = client
        self._publish = publish
        self._paused = paused
        self.job: str | None = None
        self._to_job: Callable[[Point], Point] | None = None
        self._place: PlaceOf | None = None
        self.consensus = Consensus()
        self._frame: object = None
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._end = threading.Event()
        self._changed = False
        self._published = 0.0
        # The search record (searchlog.py) every pose read goes into: the
        # look's own from the board's loading, or a search's while it
        # runs; and the newest one's id, for the page.
        self.record = None
        self.last_record: str | None = None
        self._record_lock = threading.Lock()
        self._last_error: str | None = None
        self._first_picture = False

    @property
    def client(self) -> VisionClient:
        return self._client()

    def start(self, job_id: str, to_job: Callable[[Point], Point], middle: Point, place: PlaceOf, record=None) -> None:
        """The board of `job_id` is loaded in pcbv: its poses are read from
        now on, into a consensus begun anew, and into `record` (a look's
        search record) until the board is found."""
        self.stop()
        self.begin_record(record)
        with self._lock:
            self.job = job_id
            self._to_job = to_job
            self._place = place
            self.consensus = Consensus(middle)
            self._frame = None
            self._end = threading.Event()
            end = self._end
            self._thread = threading.Thread(target=self._watch, args=(end,), name="board-look", daemon=True)
            self._thread.start()

    def begin_record(self, record) -> None:
        """Poses go into `record` from now on; a record still open (the
        look's own, as a search begins) ends as `searched`."""
        self.end_record("searched")
        with self._record_lock:
            self.record = record
            self._last_error = None
            self._first_picture = True
            if record is not None:
                self.last_record = record.id

    def end_record(self, result: str, only=None, **fields) -> None:
        """Ends the record poses go into (only `only`, when given: a look's
        own record ending as found must not end a search's that took its
        place meanwhile), with the consensus as it stands and `fields`."""
        with self._record_lock:
            record = self.record
            if record is None or (only is not None and record is not only):
                return
            self.record = None
        record.close(result, consensus=self.consensus.to_dict(), **fields)

    def stop(self) -> None:
        """No board loaded any more: the watcher ends and the look is forgotten."""
        self.end_record("unloaded")
        with self._lock:
            self._end.set()
            thread = self._thread
            self._thread = None
            self.job = None
            self._to_job = None
            self._place = None
            self.consensus = Consensus()
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=2.0)

    def restart(self) -> None:
        """A fresh consensus for the board loaded: a search starts over."""
        with self._lock:
            self.consensus = Consensus(self.consensus.middle)
            self._frame = None

    def sample(self, place: PlaceOf | None = None) -> str:
        """Reads pcbv's newest pose into the consensus, and into the record
        when there is one: `used` when it gave an estimate, `locked` when
        it was locked but could not be used, `none` for a pose that is not
        locked, `same` for the frame read before, `off` with no board or
        camera."""
        to_job = self._to_job
        place = place or self._place
        record = self.record
        if self.job is None or to_job is None or place is None or not self.client.running:
            return "off"
        try:
            raw = self.client.pose()
        except VisionError as exc:
            if "no frame" not in str(exc):
                log.warning("board look: %s", exc)
            # The same failure again and again is said once.
            if record is not None and str(exc) != self._last_error:
                self._last_error = str(exc)
                record.event("error", text=str(exc))
            return "off"
        received = time.monotonic()
        seq = raw.get("frame")
        if seq is not None and seq == self._frame:
            return "same"
        self._frame = seq
        self._last_error = None
        age = raw.get("age_ms")
        captured = received - float(age) / 1000.0 if _number(age) else received
        state = raw.get("state")
        estimate: Estimate | None = None
        problem: str | None = None
        where: PictureFrame | str | None = None
        if state == "locked":
            where = place(captured)
            if isinstance(where, str):
                problem = where
            else:
                estimate, problem = pose_estimate(raw, where, to_job, self.consensus.middle, captured)
        self.consensus.see(state, estimate, problem)
        self._changed = True
        seen = "used" if estimate is not None else "locked" if state == "locked" else "none"
        if record is not None:
            record.event("pose", **pose_fields(record, raw, received, captured, where, estimate, problem, seen, self.consensus))
            if record.kind == "look":
                self._look_record(record)
        return seen

    def _look_record(self, record) -> None:
        """A look's own record keeps a picture at its first pose and when
        the board is found, and ends then, or once it is full."""
        if self._first_picture:
            # Tried once: a camera that gives no picture is not asked at every pose.
            self._first_picture = False
            record.picture(self.client, f"look-{record.pictures:03d}", why="first pose")
        if self.consensus.found:
            record.picture(self.client, f"look-{record.pictures:03d}", why="found")
            best = self.consensus.best
            self.end_record("found", only=record, estimate=best.to_dict() if best is not None else None)
        elif record.full:
            self.end_record("cut short", only=record, message="the record is full; the look goes on unrecorded")

    def state(self) -> dict:
        consensus = self.consensus
        if self.job is None:
            return {"job": None}
        return {"job": self.job, **consensus.to_dict(), "record": self.last_record}

    def publish(self, force: bool = False) -> None:
        """Tells the page of a change, at most every PUBLISH_SECONDS unless forced."""
        now = time.monotonic()
        if self._changed and (force or now - self._published >= PUBLISH_SECONDS):
            self._changed = False
            self._published = now
            self._publish()

    def _watch(self, end: threading.Event) -> None:
        while not end.is_set():
            try:
                if not self._paused():
                    self.sample()
                    self.publish()
            except Exception as exc:  # the watcher outlives a bad reply
                log.warning("board look: %r", exc)
            end.wait(SAMPLE_SECONDS)


# --- the search ----------------------------------------------------------------------


def search_box(center: Point, size: float) -> Box:
    """A square box `size` mm on a side about a point."""
    half = size / 2.0
    return (center[0] - half, center[1] - half, center[0] + half, center[1] + half)


def search_stops(box: Box, view: tuple[float, float], start: Point) -> list[Point]:
    """The places for the picture's center that cover a box with pictures
    `view` (width, height mm) apart less OVERLAP: a grid centered in the
    box, a stop at least, nearest `start` first. A ValueError for a box
    that would take more than MAX_STOPS."""
    x0, y0, x1, y1 = min(box[0], box[2]), min(box[1], box[3]), max(box[0], box[2]), max(box[1], box[3])
    step_x = max(view[0] * (1.0 - OVERLAP), 0.1)
    step_y = max(view[1] * (1.0 - OVERLAP), 0.1)
    nx = max(1, math.ceil((x1 - x0) / step_x - 1e-9))
    ny = max(1, math.ceil((y1 - y0) / step_y - 1e-9))
    if nx * ny > MAX_STOPS:
        raise ValueError(f"the box needs {nx * ny} stops of the camera's picture, more than {MAX_STOPS}: draw a smaller box")
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    stops = [(cx + (i - (nx - 1) / 2.0) * step_x, cy + (j - (ny - 1) / 2.0) * step_y) for j in range(ny) for i in range(nx)]
    stops.sort(key=lambda p: (round(math.dist(p, start), 6), math.atan2(p[1] - start[1], p[0] - start[0])))
    return stops


def look_at_stop(look: BoardLook, frame: PictureFrame, stopped: Callable[[], bool], error: type[Exception]) -> str:
    """Reads poses with the head at rest at one stop: `found` once the
    board is found; `no lock` when no lock came within LOCK_SECONDS,
    `time up` when the stop's time ran out. Only frames taken the camera's
    settle time after the stop began are used."""
    began = time.monotonic()
    trusted = began + camera_module.SETTLE_SECONDS
    locked = False

    def place(captured: float) -> PictureFrame | str:
        return frame if captured >= trusted else "the head is coming to rest"

    while True:
        if stopped():
            raise error("stopped")
        seen = look.sample(place)
        look.publish()
        if look.consensus.found:
            return "found"
        if seen == "used":
            locked = True
        elapsed = time.monotonic() - began
        if elapsed >= STOP_SECONDS + camera_module.SETTLE_SECONDS:
            return "time up"
        if not locked and elapsed >= LOCK_SECONDS + camera_module.SETTLE_SECONDS:
            return "no lock"
        time.sleep(SAMPLE_SECONDS / 2.0)


def search(
    look: BoardLook,
    mover,
    stops: list[Point],
    offset: Point,
    frame_at: Callable[[Point], PictureFrame],
    stopped: Callable[[], bool],
    on_stop: Callable[[int, int], None],
    error: type[Exception],
    record=None,
) -> Estimate:
    """Moves the head (`mover`, already begun and at its looking height) so
    the picture's center visits each stop (the head at the stop less the
    camera's `offset`), looks at each, and ends found, with the picture's
    center over the board's middle and the estimate; or raises `error`
    once every stop was looked at. `frame_at` is the picture's place with
    its center at a point. `record` (searchlog.py) gets every pose, each
    stop's move, end and picture, and how the search ended."""
    # The look's own record ends with the consensus it had, then the
    # search starts one afresh.
    look.begin_record(record)
    look.restart()
    visited = 0
    covered = False

    def visit(index: int, target: Point, middle: bool = False) -> str:
        """The picture's center to `target`, the stop looked at: its result."""
        head = (target[0] - offset[0], target[1] - offset[1])
        if record is not None:
            record.stop = index
            record.event("stop", index=index, target=_rounded(target), head=_rounded(head), **({"middle": True} if middle else {}))
        mover.go(head)
        _reset(look)
        if record is not None:
            record.event("arrived", index=index)
        began = time.monotonic()
        result = look_at_stop(look, frame_at(target), stopped, error)
        if record is not None:
            record.event("stop_end", index=index, result=result, seconds=round(time.monotonic() - began, 3))
            record.picture(look.client, f"stop-{index:03d}", index=index)
        return result

    try:
        for index, stop in enumerate(stops):
            on_stop(index, len(stops))
            visited = index + 1
            if visit(index, stop) == "found":
                best = look.consensus.best
                assert best is not None
                # The picture's center over the board's middle, looked at again
                # from there: the board fills the picture, the estimate holds.
                visit(len(stops), best.center, middle=True)
                final = look.consensus.best or best
                look.publish(force=True)
                look.end_record("found", only=record, estimate=final.to_dict(), visited=visited, found_at=index)
                return final
        look.publish(force=True)
        covered = True
        raise error(f"no board found: {len(stops)} stops of the camera's picture looked at without {NEED} looks agreeing; a box over where the board lies, or the board's side and finish checked")
    except BaseException as exc:
        result = "not found" if covered else "stopped" if stopped() else "error"
        look.end_record(result, only=record, message=str(exc) or type(exc).__name__, visited=visited)
        raise


def _rounded(point: Point) -> list[float]:
    return [round(point[0], 4), round(point[1], 4)]


def search_extra(box: Box, start: Point, stops: list[Point], view_width: float, view_height: float) -> dict:
    """A search's box, the picture's center it started from, its stops and
    the picture's size on the machine (mm), for its record."""
    return {
        "box": [round(value, 4) for value in box],
        "start": _rounded(start),
        "stops": [_rounded(stop) for stop in stops],
        "view_mm": [round(view_width, 4), round(view_height, 4)],
    }


def settings_now() -> dict:
    """The look's and the search's settings as they are now, for a record."""
    return {
        "agree_mm": AGREE_MM,
        "agree_deg": AGREE_DEG,
        "need": NEED,
        "window": WINDOW,
        "sample_s": SAMPLE_SECONDS,
        "stop_s": STOP_SECONDS,
        "lock_s": LOCK_SECONDS,
        "settle_s": camera_module.SETTLE_SECONDS,
        "overlap": OVERLAP,
    }


def pose_fields(record, raw: dict, received: float, captured: float, where, estimate: Estimate | None, problem: str | None, seen: str, consensus: Consensus) -> dict:
    """A pose's line in a record: pcbv's whole reply (its protocol id left
    out), when it was read and when its frame was taken (seconds from the
    record's start), where the picture lay then or why that was not
    known, the estimate or why there was none, and the consensus after."""
    fields: dict = {
        "frame": raw.get("frame"),
        "state": raw.get("state"),
        "seen": seen,
        "read": record.since(received),
        "captured": record.since(captured),
        "pose": {key: value for key, value in raw.items() if key != "id"},
    }
    if isinstance(where, PictureFrame):
        fields["place"] = {"center": _rounded(where.center), "roll": where.roll, "mirror": where.mirror}
    elif isinstance(where, str):
        fields["refused"] = where
    if problem is not None and not isinstance(where, str):
        fields["problem"] = problem
    if estimate is not None:
        fields["estimate"] = {**estimate.to_dict(), "seen": _rounded(estimate.seen) if estimate.seen is not None else None}
    best = consensus.best
    fields["consensus"] = {
        "agree": consensus.agree,
        "found": consensus.found,
        "spread_mm": round(consensus.spread_mm, 4) if consensus.spread_mm is not None else None,
        "spread_deg": round(consensus.spread_deg, 4) if consensus.spread_deg is not None else None,
        "estimate": best.to_dict() if best is not None else None,
    }
    return fields


def found_text(found: Estimate, consensus: Consensus) -> str:
    """The line said of a board a search found."""
    spread = ""
    if consensus.spread_mm is not None and consensus.spread_deg is not None:
        spread = f" within {consensus.spread_mm:.2f} mm and {consensus.spread_deg:.2f} degrees"
    return (
        f"board found: its middle at {found.center[0]:.3f}, {found.center[1]:.3f} mm, turned {found.rotation:+.3f} degrees;"
        f" {consensus.agree} looks in a row agree{spread}"
    )


def _reset(look: BoardLook) -> None:
    """pcbv forgets the pose it tracked: the head moved, so it searches the
    new picture afresh rather than coasting on the old one."""
    try:
        look.client.request("reset")
    except VisionError as exc:
        log.warning("board look: reset: %s", exc)
    except AttributeError:
        pass


class BoardMover:
    """A machine on this project's firmware moved in its board frame, for
    the head camera's search: the tool to board points through the
    streamer's joints, the head up to its travel height first."""

    name = "machine"
    letters = ("X", "Y")
    can_turn = False

    def __init__(self, access, stopped: Callable[[], bool], error: type[Exception], halt: Callable[[], None]) -> None:
        self.access = access
        self._stopped = stopped
        self._error = error
        self._halt = halt
        self._status = None
        self._restarts = access.link.restarts

    def check(self) -> None:
        """Every machine moves in its board frame."""

    def begin(self) -> None:
        self._status = idle_status(self.access.link, self._error)
        self._restarts = self.access.link.restarts

    def stopped(self) -> bool:
        return self._stopped()

    def here(self) -> Point:
        head_point = self.access.head_point
        assert head_point is not None, "the board mover reads the tool's board point"
        return head_point(self._status)

    def height(self) -> float | None:
        return self._status.h if self.access.has_focus_axis else None

    def lift(self) -> None:
        lift, h = self.access.lift, self._status.h
        if self.access.has_focus_axis and h is not None and h < lift - 1e-6:
            self._line(f"go H{coord(lift, FOCUS_DECIMALS)}")
            self._status = self._settle(abs(lift - h) / 100.0 * 60.0)

    def lower(self, height: float) -> None:
        """The head camera looks from the height it travels at."""

    def go(self, point: Point) -> None:
        streamer = self.access.streamer
        start = streamer.start_of(self._status)
        seconds = 0.0
        for joint, _ in streamer.board_targets(start, point):
            self._line(f"go {streamer.words(joint)}")
            seconds += streamer._rapid_seconds(start, joint)
            start = joint
        self._status = self._settle(seconds)

    def halt(self) -> None:
        self._halt()

    def _line(self, line: str) -> None:
        if self._stopped():
            raise self._error("stopped")
        self.access.link.request_ok(line)

    def _settle(self, seconds: float):
        return settle(self.access.link, seconds, self._restarts, self._stopped, self._error, "the search")
