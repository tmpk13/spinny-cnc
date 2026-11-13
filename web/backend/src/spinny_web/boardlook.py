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
taken while the head still moved. So the newest HISTORY estimates are
sorted into guesses, estimates whose middles lie within AGREE_MM of one
another and whose turns within AGREE_DEG making one guess, its place and
turn their medians. A guess's probability is its share of the evidence:
its looks, each weighed by how well pcbv matched it (the features it
paired of those it expected), over every guess's. The board is called
found when the most likely guess has NEED looks or more from SESSIONS
independent locks or more, at least the camera's threshold of the
evidence, and more of it than the next guess. Poses pcbv tracks from one
lock are one look at the picture, however many: a lock found by another
search (pcbv numbers them), after the pose was cleared or at another
stop, is another. A guess that has all but a second lock has pcbv clear
its pose and search the same picture again.
Corners of the board taken by hand (the picture's center put on each)
rule out every guess that puts one further than the camera's corner_mm
from where it was taken, and make a rough place of their own. A pose is
used only when the head is known to have been at rest when its frame was
taken.

The search moves the head so the picture's center visits a grid of stops
over a box, a picture's size apart less an overlap, nearest the start
first, and looks at each until the board is found, no lock comes, or the
stop's time is up. A board found is checked: the picture's center goes
over the board's middle (or the part of the board with the most pads and
holes in view) and the looks there must agree with the place found; a
check that disagrees or sees nothing sends the search on. It always ends:
found and checked, the box covered, or stopped.
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
from .camera import CORNER_MM, LOOK_THRESHOLD, picture_to_machine
from .kinematics import FOCUS_DECIMALS, coord
from .link import idle_status, settle
from .log import log
from .vision import VisionClient, VisionError

Point = tuple[float, float]
Box = tuple[float, float, float, float]

# Estimates make one guess when their middles lie within this of one
# another, mm, and their turns within this, degrees; a guess needs this many
# looks to be called found, and the guesses are made from the newest this
# many estimates.
AGREE_MM = 0.5
AGREE_DEG = 1.0
NEED = 5
HISTORY = 40
# The independent locks (pcbv searches) a guess's looks must come from, and
# how long after clearing pcbv's pose to look again from scratch it may be
# cleared once more, s.
SESSIONS = 2
RECHECK_SECONDS = 2.0
# A lock whose rival (the strongest other pose pcbv's search passed) holds
# at least this share of its evidence is ambiguous: the picture fits
# another place about as well.
AMBIGUOUS = 0.8
# The most guesses told to the page, the most likely first.
GUESSES = 8
# The least share of the evidence the most likely guess must hold, and how
# far it may put a corner taken by hand from where it was taken (mm), when
# a camera says none (its look_threshold and corner_mm).
THRESHOLD = LOOK_THRESHOLD
# What a feature that may or may not show counts among those pcbv expected,
# against one for a sure feature, as pcbv weighs it (its unsure_weight).
UNSURE_WEIGHT = 0.5
# The corners of a board's outline box that can be taken by hand, by name,
# as the board drawing shows them (the job's y up).
CORNERS = ("bottom left", "bottom right", "top right", "top left")
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
# The check of a board found: the looks at the check's place that must
# agree with it (or disagree, to call it wrong), and the most checks a
# search makes before it gives up.
CHECK_LOOKS = 3
MAX_CHECKS = 3
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
    center in the job's frame, when the frame was taken, how well pcbv
    matched the pose (match_of), the lock it came from and how near its
    rival came."""

    rotation: float
    shift: Point
    center: Point
    rms: float
    corners: list[Point] = field(default_factory=list)
    seen: Point | None = None
    captured: float = 0.0
    match: float = 1.0
    # The lock the pose came from (pcbv's number of the search that found
    # it), and its rival's share of its evidence (0 with none).
    session: int = 0
    rival: float = 0.0

    def apply(self, point: Point) -> Point:
        x, y = turn(point, self.rotation)
        return (x + self.shift[0], y + self.shift[1])

    def unapply(self, point: Point) -> Point:
        """A machine point back in the job's frame."""
        return turn((point[0] - self.shift[0], point[1] - self.shift[1]), -self.rotation)

    def to_dict(self) -> dict:
        return {
            "rotation": round(self.rotation, 4),
            "shift": [round(self.shift[0], 4), round(self.shift[1], 4)],
            "center": [round(self.center[0], 4), round(self.center[1], 4)],
            "rms": round(self.rms, 4),
            "match": round(self.match, 4),
            "session": self.session,
            "rival": round(self.rival, 4),
        }


@dataclass
class Guess:
    """One place the looks put the board: estimates within the agreement of
    one another, their median place and turn (`estimate`, whose match is
    theirs on average), how many, their matches summed (`weight`), how far
    they lie from the median, the history's index of the newest, and the
    share of the evidence the guess holds; with corners taken by hand, the
    furthest it puts one from where it was taken, and whether that rules
    it out (its probability then nothing); the locks its looks came from,
    and how near the strongest rival among them came."""

    estimate: Estimate
    looks: int
    weight: float
    spread_mm: float
    spread_deg: float
    newest: int
    probability: float = 0.0
    corner_mm: float | None = None
    ruled_out: bool = False
    # The independent locks its looks came from, and the strongest rival
    # any of them had (its share of that look's evidence).
    sessions: int = 1
    rival: float = 0.0


@dataclass
class Corner:
    """A corner of the board's outline taken: its name (CORNERS), where it
    lies in the job's frame, and its machine point: the picture's center
    put on it by hand, or where the board's two edges seen in the picture
    meet (`by` "edges"), which also tells the board's turn (`angle`,
    degrees)."""

    name: str
    job: Point
    machine: Point
    angle: float | None = None
    by: str = "hand"

    def to_dict(self) -> dict:
        data = {"corner": self.name, "job": _rounded(self.job), "machine": _rounded(self.machine), "by": self.by}
        if self.angle is not None:
            data["angle"] = round(self.angle, 4)
        return data


def corner_of(box: Box, name: str) -> Point:
    """The corner of a board's outline box (x0 y0 x1 y1, the job's frame) by its name."""
    x0, y0, x1, y1 = box
    places = {"bottom left": (x0, y0), "bottom right": (x1, y0), "top right": (x1, y1), "top left": (x0, y1)}
    if name not in places:
        raise ValueError(f"no corner {name!r}: one of {', '.join(CORNERS)}")
    return places[name]


def corners_from(data) -> list[Corner]:
    """Corners as a record keeps them (Corner.to_dict), back; bad ones left out."""
    corners = []
    for item in data if isinstance(data, list) else []:
        if isinstance(item, dict):
            job, machine = _point(item.get("job")), _point(item.get("machine"))
            if job is not None and machine is not None:
                angle = item.get("angle")
                corners.append(Corner(str(item.get("corner")), job, machine, float(angle) if _number(angle) else None, str(item.get("by") or "hand")))
    return corners


def rough_place(corners: list[Corner], middle: Point) -> Estimate | None:
    """Where corners taken put the board: with two or more, the turn and
    shift that fit them best; with one, turned as its edges say (else not
    turned), shifted so it lies where it was taken. None with none."""
    if not corners:
        return None
    angle = corners[0].angle if len(corners) == 1 else None
    fit = fit_rigid([(corner.job, corner.machine) for corner in corners], angle=angle)
    return Estimate(fit.rotation, fit.shift, fit.apply(middle), fit.rms)


def rough_box(place: Estimate, outline: Box, margin: float) -> Box:
    """The box on the machine that holds a board's outline box (the job's
    frame) where `place` puts it, grown by `margin` mm on every side."""
    x0, y0, x1, y1 = outline
    points = [place.apply(point) for point in ((x0, y0), (x1, y0), (x1, y1), (x0, y1))]
    xs, ys = [p[0] for p in points], [p[1] for p in points]
    return (min(xs) - margin, min(ys) - margin, max(xs) + margin, max(ys) + margin)


def rival_of(raw: dict) -> float:
    """How near the strongest other pose pcbv's search passed came to a
    lock: its share of the lock's evidence, 0 with none."""
    rival = raw.get("rival")
    ratio = rival.get("ratio") if isinstance(rival, dict) else None
    return max(float(ratio), 0.0) if _number(ratio) else 0.0


# A corner seen in a picture: the board's two edges there run within this
# many degrees of square to each other, and meet within this share of the
# shorter one's length (or 1 mm) beyond the ends of both.
EDGE_SQUARE_DEG = 15.0
EDGE_REACH = 0.25
# The job's direction (degrees, y up) of the edge that leaves each corner
# first counterclockwise: the other leaves a quarter turn on.
CORNER_FIRST = {"bottom left": 0.0, "bottom right": 90.0, "top right": 180.0, "top left": 270.0}


def corner_from_edges(lines: list[dict], name: str, frame: PictureFrame, scale: float, size: tuple[float, float]) -> tuple[Point, float]:
    """A board's corner and turn from the straight edges pcbv found in a
    picture (its `edges` reply's lines, strongest first): the strongest
    two that run square to each other and meet at the ends of both are the
    board's sides at the corner `name`; their crossing is the corner on the
    machine, and the turn is how far the sides leave it from the job's
    directions there (averaged over the two). `frame` places the picture,
    `scale` is mm per px, `size` the picture's width and height. A
    ValueError when no two edges make a corner."""
    if name not in CORNER_FIRST:
        raise ValueError(f"no corner {name!r}: one of {', '.join(CORNERS)}")
    width, height = size

    def machine(x: float, y: float) -> Point:
        off = picture_to_machine(x - width / 2.0, y - height / 2.0, scale, frame.roll, frame.mirror)
        return (frame.center[0] + off[0], frame.center[1] + off[1])

    segments = []
    for line in lines:
        try:
            a, b = machine(float(line["x0"]), float(line["y0"])), machine(float(line["x1"]), float(line["y1"]))
        except (KeyError, TypeError, ValueError):
            continue
        if math.dist(a, b) > 1e-6:
            segments.append((a, b))
    for i, (a0, a1) in enumerate(segments):
        for b0, b1 in segments[i + 1:]:
            da = (a1[0] - a0[0], a1[1] - a0[1])
            db = (b1[0] - b0[0], b1[1] - b0[1])
            cross = da[0] * db[1] - da[1] * db[0]
            la, lb = math.hypot(*da), math.hypot(*db)
            # sin of the angle between them: 1 when square.
            if abs(cross) / (la * lb) < math.cos(math.radians(EDGE_SQUARE_DEG)):
                continue
            # Where the two lines cross, as a share along each segment.
            t = ((b0[0] - a0[0]) * db[1] - (b0[1] - a0[1]) * db[0]) / cross
            u = ((b0[0] - a0[0]) * da[1] - (b0[1] - a0[1]) * da[0]) / cross
            reach = max(EDGE_REACH * min(la, lb), 1.0)
            if not (_near_end(t, la, reach) and _near_end(u, lb, reach)):
                continue
            point = (a0[0] + t * da[0], a0[1] + t * da[1])
            # Each side leaves the corner toward its far end.
            sides = []
            for (p0, p1) in ((a0, a1), (b0, b1)):
                far = p1 if math.dist(p1, point) >= math.dist(p0, point) else p0
                sides.append(math.degrees(math.atan2(far[1] - point[1], far[0] - point[0])))
            first, second = sides
            if _wrap(second - first) < 0.0:
                first, second = second, first
            base = CORNER_FIRST[name]
            rotation = _wrap(first - base + _wrap((second - 90.0) - first) / 2.0)
            return point, rotation
    raise ValueError(
        f"no corner of a board in the picture: {len(segments)} straight edges, none two square to each other and meeting;"
        " put the picture's center near the board's corner, with the bed around it in view"
    )


def _near_end(share: float, length: float, reach: float) -> bool:
    """Whether a point `share` of the way along a segment `length` long lies
    within `reach` of one of its ends, beyond it or short of it."""
    along = share * length
    return abs(along) <= reach or abs(along - length) <= reach


def match_of(raw: dict) -> float:
    """How well a locked pose matched the board, 0 to 1: the features pcbv
    paired of those it expected in the picture, an unsure feature counted
    among those expected at pcbv's weight (pcbv refuses a lock under a
    quarter). pcbv counts an unsure feature paired as a whole one, so with
    unsure features about the share reads a little high; it is capped at
    1, and 1 for a pose that does not say."""
    inliers, expected, unsure = raw.get("inliers"), raw.get("expected"), raw.get("unsure")
    if not _number(inliers) or not _number(expected):
        return 1.0
    whole = float(expected) + UNSURE_WEIGHT * (float(unsure) if _number(unsure) else 0.0)
    if whole <= 0.0:
        return 1.0
    return min(max(float(inliers) / whole, 0.0), 1.0)


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
        estimate = Estimate(fit.rotation, fit.shift, fit.apply(middle), fit.rms, jobs, seen, captured, match_of(raw))
        return estimate, None
    angle = raw.get("angle_deg")
    if not _number(angle):
        return None, None
    # pcbv's angle is the picture's x axis on the board, the camera's roll
    # the same axis on the machine: the board is turned by the difference.
    rotation = _wrap(frame.roll - float(angle))
    tx, ty = turn(seen, rotation)
    shift = (frame.center[0] - tx, frame.center[1] - ty)
    estimate = Estimate(rotation, shift, (0.0, 0.0), 0.0, [], seen, captured, match_of(raw))
    estimate.center = estimate.apply(middle)
    return estimate, None


class Consensus:
    """The newest estimates sorted into guesses, and whether the most
    likely one is likely enough to call the board found. The settings are
    the module's unless given: a search record's poses are replayed with
    others to see what they would have called (searchreport.py). `tune`
    changes the threshold, the corners and their tolerance as they go."""

    def __init__(
        self,
        middle: Point = (0.0, 0.0),
        need: int | None = None,
        agree_mm: float | None = None,
        agree_deg: float | None = None,
        history: int | None = None,
        threshold: float | None = None,
        corner_mm: float | None = None,
        corners: list[Corner] | None = None,
        sessions: int | None = None,
    ) -> None:
        self.middle = middle
        self.need = NEED if need is None else need
        # Never more locks than looks: one look comes from one lock.
        self.sessions = min(max(1, SESSIONS if sessions is None else int(sessions)), max(self.need, 1))
        self.agree_mm = AGREE_MM if agree_mm is None else agree_mm
        self.agree_deg = AGREE_DEG if agree_deg is None else agree_deg
        # The history holds at least the looks that call the board found.
        self.history = max(HISTORY if history is None else history, self.need)
        self.threshold = THRESHOLD if threshold is None else threshold
        self.corner_mm = CORNER_MM if corner_mm is None else corner_mm
        self.corners: list[Corner] = list(corners or [])
        # The watcher sees poses while a request tunes or reads.
        self._mutex = threading.RLock()
        self.reset()

    def reset(self) -> None:
        self.estimates: deque[Estimate] = deque(maxlen=self.history)
        # Poses read, and the locked ones that gave an estimate.
        self.looks = 0
        self.locked = 0
        self.last_state: str | None = None
        self.problem: str | None = None
        # The most likely first.
        self.guesses: list[Guess] = []
        # The newest pose's picture on the board, while it is locked.
        self.view: Estimate | None = None
        # The newest picture's place on the machine, its size (px) and its
        # scale (mm per px): where each guess says it lies on the board.
        self.picture: tuple[PictureFrame, float, float, float] | None = None

    @property
    def lead(self) -> Guess | None:
        """The most likely guess; None with none, or every one ruled out."""
        guesses = self.guesses
        return guesses[0] if guesses and guesses[0].probability > 0.0 else None

    @property
    def agree(self) -> int:
        """The looks that agree on the most likely guess."""
        lead = self.lead
        return lead.looks if lead is not None else 0

    @property
    def best(self) -> Estimate | None:
        """Where the most likely guess puts the board."""
        lead = self.lead
        return lead.estimate if lead is not None else None

    @property
    def spread_mm(self) -> float | None:
        lead = self.lead
        return lead.spread_mm if lead is not None else None

    @property
    def spread_deg(self) -> float | None:
        lead = self.lead
        return lead.spread_deg if lead is not None else None

    def _likely(self) -> bool:
        """The most likely guess has enough looks, at least the threshold's
        share of the evidence, and more of it than the next guess."""
        guesses = self.guesses
        lead = self.lead
        if lead is None or lead.looks < self.need or lead.probability < self.threshold - 1e-9:
            return False
        return len(guesses) < 2 or lead.probability > guesses[1].probability + 1e-9

    @property
    def found(self) -> bool:
        """The most likely guess is likely enough, from enough independent
        locks."""
        lead = self.lead
        return self._likely() and lead is not None and lead.sessions >= self.sessions

    @property
    def wants_another_lock(self) -> bool:
        """The most likely guess is likely enough but its looks came from
        too few independent locks: pcbv should search the picture afresh."""
        lead = self.lead
        return self._likely() and lead is not None and lead.sessions < self.sessions

    def see(self, state: str | None, estimate: Estimate | None, problem: str | None) -> None:
        """One pose read: its state, the estimate it gave (None when it gave
        none, or could not be used), and why not when it could not."""
        with self._mutex:
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

    def tune(self, threshold: float | None = None, corner_mm: float | None = None, corners: list[Corner] | None = None) -> None:
        """Another threshold, tolerance or set of corners (None keeps
        each): the guesses are weighed again."""
        with self._mutex:
            if threshold is not None:
                self.threshold = threshold
            if corner_mm is not None:
                self.corner_mm = corner_mm
            if corners is not None:
                self.corners = list(corners)
            self._weigh(list(self.guesses))

    def _near(self, a: Estimate, b: Estimate) -> bool:
        return math.dist(a.center, b.center) <= self.agree_mm and abs(_wrap(a.rotation - b.rotation)) <= self.agree_deg

    def agrees(self, a: Estimate, b: Estimate) -> bool:
        """Whether two estimates put the board in one place, within the
        agreement looks of one guess have."""
        return self._near(a, b)

    def _settle(self) -> None:
        """Sorts the estimates into guesses: the estimate with the most
        evidence within the agreement of it (ties: the newest) seeds a guess
        of those, then the same again with the rest."""
        items = list(self.estimates)
        count = len(items)
        near = [[self._near(a, b) for b in items] for a in items]
        # Each estimate's evidence within the agreement, among those left.
        weights = [sum(items[j].match for j in range(count) if near[i][j]) for i in range(count)]
        left = set(range(count))
        guesses = []
        while left:
            seed = max(left, key=lambda i: (weights[i], i))
            members = sorted(j for j in left if near[seed][j])
            left.difference_update(members)
            for j in members:
                for i in left:
                    if near[i][j]:
                        weights[i] -= items[j].match
            guesses.append(self._guess(items, seed, members))
        self._weigh(guesses)

    def _guess(self, items: list[Estimate], seed: int, members: list[int]) -> Guess:
        """The guess of `members` (indices into `items`, oldest first): their
        median place and turn, the turns taken about the seed's across the wrap."""
        group = [items[j] for j in members]
        pivot = items[seed].rotation
        turns = [pivot + _wrap(e.rotation - pivot) for e in group]
        cx = statistics.median(e.center[0] for e in group)
        cy = statistics.median(e.center[1] for e in group)
        rotation = statistics.median(turns)
        tx, ty = turn(self.middle, rotation)
        newest = group[-1]
        weight = sum(e.match for e in group)
        estimate = Estimate(
            _wrap(rotation), (cx - tx, cy - ty), (cx, cy), statistics.median(e.rms for e in group),
            newest.corners, newest.seen, newest.captured, weight / len(group), newest.session, newest.rival,
        )
        return Guess(
            estimate, len(group), weight,
            max(math.dist(e.center, (cx, cy)) for e in group),
            max(abs(r - rotation) for r in turns),
            members[-1],
            sessions=len({e.session for e in group}),
            rival=max(e.rival for e in group),
        )

    def _weigh(self, guesses: list[Guess]) -> None:
        """Each guess's verdict from the corners and share of the evidence;
        kept the most likely first (ties: the most looks, then the newest)."""
        for guess in guesses:
            if self.corners:
                guess.corner_mm = max(math.dist(guess.estimate.apply(corner.job), corner.machine) for corner in self.corners)
                guess.ruled_out = guess.corner_mm > self.corner_mm
            else:
                guess.corner_mm = None
                guess.ruled_out = False
        total = sum(guess.weight for guess in guesses if not guess.ruled_out)
        for guess in guesses:
            guess.probability = guess.weight / total if total > 0.0 and not guess.ruled_out else 0.0
        guesses.sort(key=lambda guess: (-guess.probability, -guess.looks, -guess.newest))
        self.guesses = guesses

    def footprint(self, estimate: Estimate) -> tuple[list[Point], Point] | None:
        """Where the newest picture lies on the board if `estimate` is
        right: its corners (clockwise from its top left) and its center in
        the job's frame; None before a picture's place is known."""
        if self.picture is None:
            return None
        frame, width, height, scale = self.picture

        def job_of(px: float, py: float) -> Point:
            off = picture_to_machine(px - width / 2.0, py - height / 2.0, scale, frame.roll, frame.mirror)
            return estimate.unapply((frame.center[0] + off[0], frame.center[1] + off[1]))

        corners = [job_of(x, y) for x, y in ((0.0, 0.0), (width, 0.0), (width, height), (0.0, height))]
        return corners, estimate.unapply(frame.center)

    def guess_dict(self, guess: Guess, total: float) -> dict:
        """A guess for the page: where it puts the board, how likely, its
        share of every guess's evidence (`share`, corners or not), and where
        it says the newest picture lies on the board (`view`, `seen`)."""
        data = {
            **guess.estimate.to_dict(),
            "looks": guess.looks,
            "probability": round(guess.probability, 4),
            "share": round(guess.weight / total, 4) if total > 0.0 else 0.0,
            "spread_mm": round(guess.spread_mm, 4),
            "spread_deg": round(guess.spread_deg, 4),
            "ruled_out": guess.ruled_out,
            "corner_mm": round(guess.corner_mm, 4) if guess.corner_mm is not None else None,
            "sessions": guess.sessions,
            "rival": round(guess.rival, 4),
            "view": None,
            "seen": None,
        }
        footprint = self.footprint(guess.estimate)
        if footprint is not None:
            data["view"] = [_rounded(point) for point in footprint[0]]
            data["seen"] = _rounded(footprint[1])
        return data

    def to_dict(self) -> dict:
        with self._mutex:
            view = self.view
            best = self.best
            total = sum(guess.weight for guess in self.guesses)
            return {
                "looks": self.looks,
                "locked": self.locked,
                "pose": self.last_state,
                "agree": self.agree,
                "need": self.need,
                "found": self.found,
                # The independent locks the most likely guess has and needs,
                # whether it waits for another, and how near a rival came to
                # it (its share of a look's evidence) and to the newest pose.
                "sessions": self.lead.sessions if self.lead is not None else 0,
                "sessions_needed": self.sessions,
                "rechecking": self.wants_another_lock,
                "rival": round(self.lead.rival, 4) if self.lead is not None else None,
                "ambiguous": self.lead is not None and self.lead.rival >= AMBIGUOUS,
                "view_rival": round(view.rival, 4) if view is not None else None,
                "spread_mm": round(self.spread_mm, 4) if self.spread_mm is not None else None,
                "spread_deg": round(self.spread_deg, 4) if self.spread_deg is not None else None,
                "estimate": best.to_dict() if best is not None else None,
                "view": [[round(x, 4), round(y, 4)] for x, y in view.corners] if view is not None and view.corners else None,
                "seen": [round(view.seen[0], 4), round(view.seen[1], 4)] if view is not None and view.seen is not None else None,
                "problem": self.problem,
                "threshold": round(self.threshold, 4),
                "corner_mm": round(self.corner_mm, 4),
                "guesses": [self.guess_dict(guess, total) for guess in self.guesses[:GUESSES]],
                "more": max(0, len(self.guesses) - GUESSES),
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

    def __init__(
        self,
        client: Callable[[], VisionClient],
        publish: Callable[[], None],
        paused: Callable[[], bool],
        tuning: Callable[[], tuple[float, float]] | None = None,
    ) -> None:
        self._client = client
        self._publish = publish
        self._paused = paused
        # The camera's threshold and corners' tolerance, as they are now.
        self.tuning: Callable[[], tuple[float, float]] = tuning or (lambda: (THRESHOLD, CORNER_MM))
        self.job: str | None = None
        self._to_job: Callable[[Point], Point] | None = None
        self._place: PlaceOf | None = None
        # Corners of one job's board taken by hand, kept whether or not its
        # board is loaded, and that board's middle for their rough place.
        self.corners: list[Corner] = []
        self.corners_job: str | None = None
        self._corners_middle: Point = (0.0, 0.0)
        # The newest scale pcbv reported, for pictures without a lock.
        self._scale: float | None = None
        # The camera's own settings are read once a board is loaded: the
        # backend holding them may not be whole yet.
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
        # How often pcbv's pose was cleared (every search stop, every look
        # afresh): the lock a pose came from when pcbv does not number its
        # locks. And when it was last cleared for another lock.
        self.resets = 0
        self._recheck_at: float | None = None

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
            self.consensus = self._consensus(middle, job_id)
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
            self.consensus = self._consensus((0.0, 0.0), None)
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=2.0)

    def restart(self) -> None:
        """A fresh consensus for the board loaded: a search starts over."""
        with self._lock:
            self.consensus = self._consensus(self.consensus.middle, self.job)
            self._frame = None
            self._recheck_at = None

    def _consensus(self, middle: Point, job_id: str | None) -> Consensus:
        threshold, corner_mm = self.tuning()
        return Consensus(middle, threshold=threshold, corner_mm=corner_mm, corners=self.corners_of(job_id))

    def corners_of(self, job_id: str | None) -> list[Corner]:
        """The corners taken of a job's board; none for another job's."""
        return list(self.corners) if job_id is not None and job_id == self.corners_job else []

    def retune(self) -> None:
        """The consensus follows the camera's threshold and tolerance and
        the corners as they are now; a change goes into the record, so a
        replay weighs the poses after it as the look did."""
        threshold, corner_mm = self.tuning()
        consensus = self.consensus
        corners = self.corners_of(self.job)
        if (threshold, corner_mm, corners) == (consensus.threshold, consensus.corner_mm, consensus.corners):
            return
        consensus.tune(threshold, corner_mm, corners)
        self._changed = True
        record = self.record
        if record is not None:
            record.event("settings", **tuning_fields(consensus))

    def add_corner(self, job_id: str, name: str, job_point: Point, machine: Point, middle: Point, angle: float | None = None, by: str = "hand") -> None:
        """A corner of the job's board lies at `machine` (the picture's
        center put on it, or its edges' crossing, which tells the board's
        `angle` too): kept in place of one of the same name, and any of
        another job's board dropped."""
        with self._lock:
            kept = self.corners if self.corners_job == job_id else []
            self.corners = [corner for corner in kept if corner.name != name] + [Corner(name, job_point, machine, angle, by)]
            self.corners_job = job_id
            self._corners_middle = middle
        self.retune()

    def clear_corners(self) -> None:
        with self._lock:
            self.corners = []
            self.corners_job = None
        self.retune()

    def rough(self, job_id: str) -> Estimate | None:
        """Where the corners taken of a job's board put it; None with none."""
        return rough_place(self.corners_of(job_id), self._corners_middle)

    def corners_state(self) -> dict | None:
        """The corners taken and their rough place, for the page; None with none."""
        corners = list(self.corners)
        job = self.corners_job
        if job is None or not corners:
            return None
        rough = rough_place(corners, self._corners_middle)
        return {"job": job, "points": [corner.to_dict() for corner in corners], "rough": rough.to_dict() if rough is not None else None}

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
        # Where the picture lay, asked of every pose: each guess says where
        # on the board that is, locked or not.
        where = place(captured)
        if state == "locked" and _number(raw.get("mm_per_px")) and raw["mm_per_px"] > 0.0:
            self._scale = float(raw["mm_per_px"])
        if state == "locked":
            if isinstance(where, str):
                problem = where
            else:
                estimate, problem = pose_estimate(raw, where, to_job, self.consensus.middle, captured)
        if estimate is not None:
            # pcbv numbers its locks by the search that found them; one that
            # does not, its pose cleared, has a lock of another search.
            acquisition = raw.get("acquisition")
            estimate.session = int(acquisition) if _number(acquisition) else self.resets
            estimate.rival = rival_of(raw)
        width, height = raw.get("width"), raw.get("height")
        if isinstance(where, PictureFrame) and self._scale is not None and _number(width) and _number(height) and width > 0 and height > 0:
            self.consensus.picture = (where, float(width), float(height), self._scale)
        self.consensus.see(state, estimate, problem)
        self._changed = True
        seen = "used" if estimate is not None else "locked" if state == "locked" else "none"
        if record is not None:
            # A record keeps the place of a locked pose only, as it did
            # before every pose was placed.
            kept = where if state == "locked" else None
            record.event("pose", **pose_fields(record, raw, received, captured, kept, estimate, problem, seen, self.consensus))
            if record.kind == "look":
                self._look_record(record)
        if self.consensus.wants_another_lock:
            self._recheck(record)
        return seen

    def _recheck(self, record) -> None:
        """The most likely guess waits for another independent lock: pcbv
        clears its pose and searches the same picture afresh, at most every
        RECHECK_SECONDS (a search and a few looks take a while)."""
        now = time.monotonic()
        if self._recheck_at is not None and now - self._recheck_at < RECHECK_SECONDS:
            return
        self._recheck_at = now
        if record is not None:
            record.event("recheck", resets=self.resets + 1)
        _reset(self)

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
        """The look for the page: the consensus with the board loaded, and
        the camera's settings and the corners taken, loaded or not."""
        # A setting changed elsewhere (a machine file) is followed here.
        self.retune()
        consensus = self.consensus
        corners = self.corners_state()
        if self.job is None:
            threshold, corner_mm = self.tuning()
            return {"job": None, "threshold": threshold, "corner_mm": corner_mm, "corners": corners}
        return {"job": self.job, **consensus.to_dict(), "record": self.last_record, "corners": corners}

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


def look_at_stop(
    look: BoardLook, frame: PictureFrame, stopped: Callable[[], bool], error: type[Exception], check: Estimate | None = None,
) -> str:
    """Reads poses with the head at rest at one stop: `found` once the
    board is found; `no lock` when no lock came within LOCK_SECONDS,
    `time up` when the stop's time ran out. Only frames taken the camera's
    settle time after the stop began are used. With `check` (a place found
    elsewhere) the stop checks it instead: `agreed` once CHECK_LOOKS looks
    here put the board within the agreement of it, `disagreed` once as many
    put it elsewhere."""
    began = time.monotonic()
    trusted = began + camera_module.SETTLE_SECONDS
    locked = False
    agreed = disagreed = 0

    def place(captured: float) -> PictureFrame | str:
        return frame if captured >= trusted else "the head is coming to rest"

    while True:
        if stopped():
            raise error("stopped")
        seen = look.sample(place)
        look.publish()
        if check is None and look.consensus.found:
            return "found"
        if seen == "used":
            locked = True
            view = look.consensus.view
            if check is not None and view is not None:
                if look.consensus.agrees(view, check):
                    agreed += 1
                else:
                    disagreed += 1
                if agreed >= CHECK_LOOKS:
                    return "agreed"
                if disagreed >= CHECK_LOOKS:
                    return "disagreed"
        elapsed = time.monotonic() - began
        if elapsed >= STOP_SECONDS + camera_module.SETTLE_SECONDS:
            return "time up"
        if not locked and elapsed >= LOCK_SECONDS + camera_module.SETTLE_SECONDS:
            return "no lock"
        time.sleep(SAMPLE_SECONDS / 2.0)


def check_places(
    found: Estimate, middle: Point, outline: Box | None, features: list[Point], view: tuple[float, float], count: int = MAX_CHECKS,
) -> list[Point]:
    """Where to check a board found (`found` puts the job's frame on the
    machine), machine points for the picture's center, the best first: the
    board's middle when the picture there holds at least half the pads and
    holes (`features`, the job's frame) the best place does, else the
    places over the board (its middle and the middles of a 3 by 3 grid over
    its outline box, `outline`) whose picture (`view`, mm) holds the most,
    the nearer the middle first among equals; `count` of them at most. A
    board without features is checked at its middle."""
    candidates = [middle]
    if outline is not None:
        x0, y0, x1, y1 = outline
        candidates += [(x0 + (x1 - x0) * (i + 0.5) / 3.0, y0 + (y1 - y0) * (j + 0.5) / 3.0) for j in range(3) for i in range(3)]
    reach = 0.45 * min(view)

    def held(point: Point) -> int:
        return sum(1 for f in features if math.dist(f, point) <= reach)

    counts = [held(point) for point in candidates]
    best = max(counts) if counts else 0
    order = sorted(range(len(candidates)), key=lambda i: (-counts[i], math.dist(candidates[i], middle)))
    if counts[0] * 2 >= best:
        order = [0] + [i for i in order if i != 0]
    places: list[Point] = []
    for index in order:
        point = candidates[index]
        if any(math.dist(point, kept) < 1e-6 for kept in places):
            continue
        places.append(point)
        if len(places) >= count:
            break
    return [found.apply(point) for point in places]


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
    checks: Callable[[Estimate], list[Point]] | None = None,
) -> Estimate:
    """Moves the head (`mover`, already begun and at its looking height) so
    the picture's center visits each stop (the head at the stop less the
    camera's `offset`), looks at each, and ends found and checked, with the
    picture's center over the place checked and the estimate; or raises
    `error` once every stop was looked at, or MAX_CHECKS checks failed.
    `frame_at` is the picture's place with its center at a point; `checks`
    gives the places to check a board found at, the best first (the
    board's middle by default). `record` (searchlog.py) gets every pose,
    each stop's move, end and picture, each check, and how the search
    ended."""
    # The look's own record ends with the consensus it had, then the
    # search starts one afresh.
    look.begin_record(record)
    look.restart()
    visited = 0
    covered = False
    made = 0
    places_of = checks or (lambda found: [found.center])

    def visit(index: int, target: Point, middle: bool = False, check: Estimate | None = None) -> str:
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
        result = look_at_stop(look, frame_at(target), stopped, error, check)
        if record is not None:
            record.event("stop_end", index=index, result=result, seconds=round(time.monotonic() - began, 3))
            record.picture(look.client, f"stop-{index:03d}", index=index)
        return result

    try:
        for index, stop in enumerate(stops):
            on_stop(index, len(stops))
            visited = index + 1
            result = visit(index, stop)
            # Found: checked from elsewhere on the board, the place found
            # kept only once the looks there agree with it. A check that
            # saw nothing or disagreed leaves the evidence in the consensus:
            # while it still calls the board found, the next place is
            # checked; else the search goes on.
            while result == "found":
                if made >= MAX_CHECKS:
                    raise error(
                        f"the board was found {made} times but no check agreed: the looks at another place on it put it elsewhere"
                        " or saw nothing there; check the board's side and finish, or take its corners"
                    )
                best = look.consensus.best
                assert best is not None
                places = places_of(best) or [best.center]
                place = places[min(made, len(places) - 1)]
                made += 1
                outcome = visit(len(stops) + made - 1, place, middle=True, check=best)
                if record is not None:
                    record.event("check", result=outcome, estimate=best.to_dict(), place=_rounded(place))
                if outcome == "agreed":
                    final = look.consensus.best or best
                    look.publish(force=True)
                    look.end_record("found", only=record, estimate=final.to_dict(), visited=visited, found_at=index, checks=made)
                    return final
                result = "found" if look.consensus.found else outcome
        look.publish(force=True)
        covered = True
        raise error(
            f"no board found: {len(stops)} stops of the camera's picture looked at without a guess of {NEED} looks from"
            f" {look.consensus.sessions} locks holding {look.consensus.threshold * 100.0:.0f}% of the evidence and a check"
            " agreeing; a box over where the board lies, the board's side and finish, or a lower threshold"
        )
    except BaseException as exc:
        result = "not found" if covered else "stopped" if stopped() else "error"
        look.end_record(result, only=record, message=str(exc) or type(exc).__name__, visited=visited)
        raise


# --- features to center once the board is found -------------------------------------

# A feature to center stands at least this far clear of every other one,
# mm, beyond both their sizes: the spot nearest the picture's center is
# then that feature, whatever small error the place found has.
CLEAR_MM = 1.0
# The most candidates of one kind the far-apart pick weighs, the ones
# furthest out along eight directions; a board's pads can run to
# thousands.
PICK_POOL = 160


@dataclass
class Feature:
    """A point of the board to center the camera on: a fiducial, a drilled
    hole or a pad; where it lies in the job's frame, its size (diameter, or
    a pad's as a disc of its area, mm) and its name."""

    kind: str
    job: Point
    size: float
    name: str


def isolated(features: list[Feature], others: list[Feature], clear: float = CLEAR_MM) -> list[Feature]:
    """The features with no other one (of `others`) nearer than their two
    sizes' half sums and `clear`."""
    kept = []
    for feature in features:
        near = min(
            (math.dist(feature.job, other.job) - (feature.size + other.size) / 2.0 for other in others if other is not feature and other.job != feature.job),
            default=math.inf,
        )
        if near >= clear:
            kept.append(feature)
    return kept


def far_apart(features: list[Feature], count: int) -> list[Feature]:
    """`count` of the features spread as far as they go: the two furthest
    apart, then each next the one furthest from those taken."""
    if len(features) <= count:
        return list(features)
    pool = features
    if len(pool) > PICK_POOL:
        # The ones furthest out along eight directions.
        chosen: dict[int, Feature] = {}
        for k in range(8):
            angle = math.pi * k / 4.0
            c, s_ = math.cos(angle), math.sin(angle)
            ranked = sorted(range(len(features)), key=lambda i: -(features[i].job[0] * c + features[i].job[1] * s_))
            for i in ranked[: PICK_POOL // 8]:
                chosen[i] = features[i]
        pool = list(chosen.values())
    a, b = max(((x, y) for i, x in enumerate(pool) for y in pool[i + 1:]), key=lambda pair: math.dist(pair[0].job, pair[1].job))
    taken = [a, b]
    while len(taken) < count:
        rest = [f for f in pool if all(f is not t for t in taken)]
        if not rest:
            break
        taken.append(max(rest, key=lambda f: min(math.dist(f.job, t.job) for t in taken)))
    return taken


def pick_features(fiducials: list[Feature], holes: list[Feature], pads: list[Feature], use: str = "auto", count: int = 3) -> list[Feature]:
    """The features to center after a board is found: `count` far apart
    of one kind that stand clear of the rest, fiducials first (made to be
    found), then holes (round, dark, sharp), then pads; `use` names one
    kind instead of `auto`. Fewer than two when no kind has two."""
    everything = fiducials + holes + pads
    kinds = {"fiducials": fiducials, "holes": holes, "pads": pads}
    order = ["fiducials", "holes", "pads"] if use == "auto" else [use]
    for kind in order:
        if kind not in kinds:
            raise ValueError(f"use must be auto, fiducials, holes or pads, not {kind!r}")
        clear = isolated(kinds[kind], everything)
        if len(clear) >= 2:
            return far_apart(clear, count)
    return []


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


def tuning_fields(consensus: Consensus) -> dict:
    """A consensus' threshold, corners' tolerance and corners, for a record."""
    return {
        "threshold": consensus.threshold,
        "corner_mm": consensus.corner_mm,
        "corners": [corner.to_dict() for corner in consensus.corners],
    }


def settings_now(look: BoardLook | None = None, job_id: str | None = None) -> dict:
    """The look's and the search's settings as they are now, for a record
    of the look for `job_id`'s board: the camera's threshold and corners'
    tolerance, and the corners taken of that board, from `look`."""
    threshold, corner_mm = look.tuning() if look is not None else (THRESHOLD, CORNER_MM)
    corners = look.corners_of(job_id) if look is not None else []
    return {
        "agree_mm": AGREE_MM,
        "agree_deg": AGREE_DEG,
        "need": NEED,
        "sessions": SESSIONS,
        "history": HISTORY,
        "threshold": threshold,
        "corner_mm": corner_mm,
        "corners": [corner.to_dict() for corner in corners],
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
    lead = consensus.lead
    fields["consensus"] = {
        "agree": consensus.agree,
        "found": consensus.found,
        "guesses": len(consensus.guesses),
        "probability": round(lead.probability, 4) if lead is not None else None,
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
    lead = consensus.lead
    share = f", {lead.probability * 100.0:.0f}% of the evidence" if lead is not None else ""
    return (
        f"board found: its middle at {found.center[0]:.3f}, {found.center[1]:.3f} mm, turned {found.rotation:+.3f} degrees;"
        f" {consensus.agree} looks agree{spread}{share}"
    )


def _reset(look: BoardLook) -> None:
    """pcbv forgets the pose it tracked: the head moved, so it searches the
    new picture afresh rather than coasting on the old one, or a guess
    wants a lock of another search."""
    look.resets += 1
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
