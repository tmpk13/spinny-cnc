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

A place known before the search (where corners taken put the board, else
where this camera found it before, else the Align marks or the references,
else the job's own place) only orders the work: the stops nearest its
middle come first, and at each stop pcbv is told what board point the
known place puts under the picture's center, so its search tries the poses
near it first and then goes on as ever. It never decides: a pose is checked
by pcbv as any other, the guesses weigh it as any other, and the check of
a board found is made with pcbv told nothing.
"""

from __future__ import annotations

import math
import statistics
import threading
import time
from collections import deque
from dataclasses import dataclass, field, replace
from typing import Callable

import numpy as np

from spinny_laser.align import fit_rigid, turn

from . import camera as camera_module
from .camera import CORNER_MM, LOOK_THRESHOLD, picture_to_machine
from .kinematics import FOCUS_DECIMALS, coord
from .link import idle_status, settle
from .log import log
from .crops import cut
from .pictures import BOARD_BUSY, BUSY_WIDTH, EMPTY_BUSY, busy_share, fresh_gray, phase_shift
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
# The vote leaves out a lock that paired less than this share of the
# features pcbv expected in its picture (match_of). pcbv itself takes a
# quarter. On a LumenPnP over a populated board 169 pictures with the
# head's places known locked right at 0.64 to 0.98 and wrong (70 to 100 mm
# off, a turned cluster, a feeder's tape) at a median of 0.32; two searches
# started at the board's edge called such a place found and failed every
# check, and with this share left out of them neither did while ten
# others found the board as before.
MIN_MATCH = 0.5
# A guess whose looks were taken from places at least this far apart, mm,
# takes the board's turn and place from the head's moves: the job point
# under each picture's center against where that center was on the
# machine, which no error in the camera's roll touches. A single picture's
# turn is the roll less pcbv's angle: on a LumenPnP whose file says roll
# 180 and whose camera sits at 180.4, every found board came out 0.4
# degrees turned (0.2 mm at its middle, 0.35 at its edges); a sweep's
# picture centers fitted that way agreed to 0.07 mm rms. Closer places
# leave the turn to the roll: pcbv's centers (a few hundredths of a mm)
# over 20 mm still give it within 0.2 degrees.
PLACES_MM = 20.0
# Stops that must lock (a check, the first looks of a search about a
# known place) keep this far inside the board's outline, mm, or a fifth of
# its shorter side for a small board: pictures within 15 to 25 mm of a
# LumenPnP board's edge locked wrong about half the time.
EDGE_MM = 20.0
# A search about a known place looks first at this many of the places
# where that place puts the most pads in a picture (check_places).
KNOWN_FIRST = 2
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
# A quick scan's lattice (a search with no place known over a bed much
# larger than the board) is spaced at this share of the board's shorter
# side: wherever the board lies, a stop falls a fifth of that side or more
# inside its edges.
QUICK_SHARE = 0.6
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
# The places a found board's final fit takes looks from, at most: the stop
# that found it, the check that agreed, and checks after it half PLACES_MM
# or more from those. Fitting a LumenPnP survey's right locks 20 mm or more
# apart, the board's middle came out 0.18 mm off (rms) from two places,
# 0.11 from three and 0.08 from four; a check costs about a second.
FINAL_PLACES = 3
# A stop of a look that numbers pcbv's searches (either method, with the
# camera's scale known) ends on evidence before its clocks: with no lock
# once pcbv ran this many searches on settled frames there; and, for a
# look whose evidence comes once per search (the posterior), with a lock
# at the least match or better once pcbv tracked it this many poses
# with no new search, since searches of one picture pool into one view
# (posterior.py) and tracked poses bring nothing new (the vote counts
# tracked poses as looks, so it stays for them). On a LumenPnP board
# scan 49 of 84 stops found no lock: the vote waited LOCK_SECONDS at each
# (197 s in all), the posterior ended them in 0.65 s (86 s). pcbv searches a
# frame at a time when it holds no lock, about 30 a second. On a LumenPnP
# with the scale known every stop that locked did so within 4 searches (59
# stops), while six of 18 searches with the place known spent 5 to 27 s
# waiting out LOCK_SECONDS and STOP_SECONDS. A weak lock is not ended
# on: pcbv drops it and searches again (one tracked for 0.3 s gave way to
# the right place).
STOP_SEARCHES = 6
TRACKED_POSES = 2
# A stop's pictures are trusted from the first of two frames in a row that
# agree within this many pixels of the busy test's picture (BUSY_WIDTH, a
# quarter of a 1280 px picture: 0.4 full size px, 6 um on a LumenPnP),
# instead of a fixed settle time after every move (camera.SETTLE_SECONDS,
# then the ceiling): 9.5 s of a 40 s whole-bed search waited it out.
SETTLED_PX = 0.1
SETTLE_BY_FRAMES = True
# The speed a G-code machine's head is taken to move at when a place it is
# seen at changed, mm/s, for when the move ends: lower than any feed, so the
# wait is long enough.
SLOW_MM_S = 20.0
# How far a known place may be off: one found before or measured (mm and
# degrees, or three times the marks' rms), a corner's edges (degrees), and
# the job's own place, where the board was only meant to go (mm, or this
# share of the board's diagonal, and degrees).
KNOWN_MM = 2.0
KNOWN_DEG = 3.0
EDGE_DEG = 3.0
JOB_MM = 5.0
JOB_SHARE = 0.25
JOB_DEG = 15.0
# What can tell where the board is before a search, most trusted first.
KNOWN_SOURCES = ("corners", "found", "align", "references", "job")


@dataclass
class PictureFrame:
    """Where a picture lay on the machine when its frame was taken: the
    machine point under its center, and the roll and mirror its pixels
    turn into the machine's mm by."""

    center: Point
    roll: float
    mirror: bool = False
    # The head's velocity when the frame was taken (mm/s; nothing at rest):
    # the place is the head's for the camera's delay first guessed, and a
    # posterior on a flying scan fits the delay along it.
    velocity: Point = (0.0, 0.0)


def same_place(a: PictureFrame, b: PictureFrame) -> bool:
    """Whether two frames lay at one place at rest: a stop's frame, made
    again for each pose a replay reads."""
    return (
        math.dist(a.center, b.center) < 1e-6 and abs(a.roll - b.roll) < 1e-9 and a.mirror == b.mirror
        and a.velocity == (0.0, 0.0) and b.velocity == (0.0, 0.0)
    )


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
    # The machine point under the picture's center when the frame was
    # taken (`seen` is the job's point there); None when not known.
    place: Point | None = None
    # A guess's turn from the head's places less its looks' turn from the
    # camera's roll, degrees: how far the roll in use is off; None for a
    # look, or a guess whose looks came from one place.
    roll_off: float | None = None

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
            "roll_off": round(self.roll_off, 4) if self.roll_off is not None else None,
        }


def shifted(place: Estimate, dx: float, dy: float) -> Estimate:
    """A place of the board moved `dx`, `dy` mm on the machine, its turn
    kept: the shift, the board's middle and the machine point under the
    picture's center move; what is said in the job's frame stays."""
    under = place.place
    return replace(
        place,
        shift=(place.shift[0] + dx, place.shift[1] + dy),
        center=(place.center[0] + dx, place.center[1] + dy),
        place=(under[0] + dx, under[1] + dy) if under is not None else None,
    )


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


@dataclass
class KnownPlace:
    """Where the board is expected before a search looks: the turn and
    shift that take the job's frame onto the machine's, with the board's
    middle there (`place`), what said so (`source`, one of KNOWN_SOURCES),
    and how far it may be off: `within_mm`, and `within_deg` (None: the
    turn is not known)."""

    source: str
    place: Estimate
    within_mm: float
    within_deg: float | None

    def to_dict(self) -> dict:
        return {
            "source": self.source,
            "rotation": round(self.place.rotation, 4),
            "shift": _rounded(self.place.shift),
            "center": _rounded(self.place.center),
            "within_mm": round(self.within_mm, 4),
            "within_deg": round(self.within_deg, 4) if self.within_deg is not None else None,
        }


def corners_known(corners: list[Corner], middle: Point, corner_mm: float, diagonal: float) -> KnownPlace | None:
    """Where corners taken put the board: within their tolerance (and a
    tenth of the diagonal more with one corner); the turn within what two
    corners that far apart allow, a corner's edges' few degrees, or not
    known from one corner taken by hand. None without corners."""
    place = rough_place(corners, middle)
    if place is None:
        return None
    if len(corners) >= 2:
        span = max(math.dist(a.machine, b.machine) for a in corners for b in corners)
        within_deg: float | None = max(math.degrees(math.atan2(2.0 * corner_mm, max(span, 1e-6))), 1.0)
    else:
        within_deg = EDGE_DEG if corners[0].angle is not None else None
    within_mm = corner_mm + (0.1 * diagonal if len(corners) < 2 else 0.0)
    return KnownPlace("corners", place, within_mm, within_deg)


def measured_known(source: str, rotation: float, shift: Point, rms: float, marks: int, middle: Point) -> KnownPlace:
    """Where measured marks put the board (the Align marks' fit, the
    references'): within KNOWN_MM or three times their rms, the turn known
    from two marks or more."""
    tx, ty = turn(middle, rotation)
    place = Estimate(rotation, shift, (tx + shift[0], ty + shift[1]), rms)
    return KnownPlace(source, place, max(KNOWN_MM, 3.0 * rms), KNOWN_DEG if marks >= 2 else None)


def job_known(middle: Point, diagonal: float) -> KnownPlace:
    """The job's own place on the machine, where the board was meant to go:
    the job's frame is the machine's."""
    return KnownPlace("job", Estimate(0.0, (0.0, 0.0), middle, 0.0), max(JOB_MM, JOB_SHARE * diagonal), JOB_DEG)


def known_place(*candidates: KnownPlace | None) -> KnownPlace | None:
    """The first known place given, the most trusted first."""
    return next((candidate for candidate in candidates if candidate is not None), None)


def inverse_of(transform: Callable[[Point], Point]) -> Callable[[Point], Point]:
    """The inverse of an affine map of the plane (a flip, a turn and a
    shift, such as a design's from KiCad's board frame to the job's), read
    off where it takes three points."""
    ox, oy = transform((0.0, 0.0))
    ax, ay = transform((1.0, 0.0))
    bx, by = transform((0.0, 1.0))
    a, b, c, d = ax - ox, bx - ox, ay - oy, by - oy
    det = a * d - b * c
    if abs(det) < 1e-12:
        raise ValueError("the map folds the plane")

    def back(point: Point) -> Point:
        x, y = point[0] - ox, point[1] - oy
        return ((d * x - b * y) / det, (-c * x + a * y) / det)

    return back


def near_fields(known: KnownPlace, frame: PictureFrame, to_board: Callable[[Point], Point], side: str = "front") -> dict:
    """What pcbv is told of a known place at a search stop, its `reset`
    request's `near`: the KiCad board point (mm, y down) the known place
    puts under the picture's center, the turn of the picture's x axis
    there as a pose's angle_deg reads (counterclockwise on screen, in the
    view frame: the board frame, mirrored in x for the back), and how far
    either may be off. `to_board` takes the job's frame to KiCad's."""
    center = to_board(known.place.unapply(frame.center))
    step = picture_to_machine(1.0, 0.0, 1.0, frame.roll, frame.mirror)
    ahead = to_board(known.place.unapply((frame.center[0] + step[0], frame.center[1] + step[1])))
    sign = -1.0 if side == "back" else 1.0
    angle = math.degrees(math.atan2(-(ahead[1] - center[1]), sign * (ahead[0] - center[0])))
    fields: dict = {"center": _rounded(center), "angle_deg": round(angle, 4), "within_mm": round(known.within_mm, 4)}
    if known.within_deg is not None:
        fields["within_deg"] = round(known.within_deg, 4)
    return fields


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


def whole_score(raw: dict) -> float | None:
    """What pcbv's whole-picture search says of a pose or a candidate, 0 to
    1: how alike the picture and the drawn board are there (a pose's
    `dense.score`, a candidate's `score`). None when that search did not
    look at it: a camera without a measured scale, a frame tracked by its
    spots, an older pcbv."""
    dense = raw.get("dense")
    score = dense.get("score") if isinstance(dense, dict) else raw.get("score")
    return min(max(float(score), 0.0), 1.0) if _number(score) else None


def match_of(raw: dict) -> float:
    """How well a locked pose matched the board, 0 to 1: the features pcbv
    paired of those it expected in the picture, an unsure feature counted
    among those expected at pcbv's weight (pcbv refuses a lock under a
    quarter). pcbv counts an unsure feature paired as a whole one, so with
    unsure features about the share reads a little high; it is capped at
    1, and 1 for a pose that does not say.

    Where pcbv's whole-picture search scored the pose, the larger of that
    score and the pairs' share: the search locks views whose few pads the
    spot finder saw half of (glare, a film) at scores of 0.6 to 0.9, and a
    lock it only checked keeps at least what its pairs gave it. A low
    score never lowers a match here: pcbv itself refuses the lock once it
    trusts that search on the board."""
    inliers, expected, unsure = raw.get("inliers"), raw.get("expected"), raw.get("unsure")
    score = whole_score(raw)
    if not _number(inliers) or not _number(expected):
        return 1.0 if score is None else score
    whole = float(expected) + UNSURE_WEIGHT * (float(unsure) if _number(unsure) else 0.0)
    if whole <= 0.0:
        return 1.0 if score is None else score
    return max(min(max(float(inliers) / whole, 0.0), 1.0), score or 0.0)


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
        estimate = Estimate(fit.rotation, fit.shift, fit.apply(middle), fit.rms, jobs, seen, captured, match_of(raw), place=frame.center)
        return estimate, None
    angle = raw.get("angle_deg")
    if not _number(angle):
        return None, None
    # pcbv's angle is the picture's x axis on the board, the camera's roll
    # the same axis on the machine: the board is turned by the difference.
    rotation = _wrap(frame.roll - float(angle))
    tx, ty = turn(seen, rotation)
    shift = (frame.center[0] - tx, frame.center[1] - ty)
    estimate = Estimate(rotation, shift, (0.0, 0.0), 0.0, [], seen, captured, match_of(raw), place=frame.center)
    estimate.center = estimate.apply(middle)
    return estimate, None


def places_fit(group: list[Estimate]):
    """The turn and shift that take the job points under the pictures'
    centers onto where those centers were on the machine, for looks whose
    places lie PLACES_MM apart or more; None for looks from closer places
    or without them."""
    located = [e for e in group if e.seen is not None and e.place is not None]
    if len(located) < 2:
        return None
    span = max(math.dist(a.place, b.place) for a in located for b in located)  # type: ignore[arg-type]
    if span < PLACES_MM:
        return None
    return fit_rigid([(e.seen, e.place) for e in located])  # type: ignore[misc]


def placed_estimate(consensus: Consensus, found: Estimate) -> Estimate:
    """Where the looks that agree with a place found put the board, fitted
    to the head's places (places_fit) when they were taken PLACES_MM apart
    or more: each lock's board point under the picture's center against
    where that center was, no pose's corners or angle. The place found as
    it is otherwise. The posterior pools a place's looks into its best
    candidate; on a LumenPnP its places with the place known came out 0.08
    to 0.09 mm off, the looks' fit 0.03 to 0.05."""
    # A look agrees when the place found puts the board point it saw under
    # the picture's center where that center was: points only, since a
    # pose's own middle, extrapolated from its corners, is tenths off.
    group = [
        e for e in list(consensus.estimates)
        if e.match >= MIN_MATCH and e.seen is not None and e.place is not None and math.dist(found.apply(e.seen), e.place) <= consensus.agree_mm
    ]
    fit = places_fit(group)
    if fit is None:
        return found
    turns = [found.rotation + _wrap(e.rotation - found.rotation) for e in group]
    placed = Estimate(
        _wrap(fit.rotation), fit.shift, fit.apply(consensus.middle), fit.rms, found.corners, found.seen, found.captured, found.match,
        found.session, found.rival,
    )
    placed.roll_off = _wrap(fit.rotation - statistics.median(turns))
    return placed


def weak_problem(match: float, least: float) -> str:
    """Why a lock that matched under the least share was left out."""
    return f"the lock paired {match * 100.0:.0f}% of what its picture should show, under {least * 100.0:.0f}%"


class Consensus:
    """The newest estimates sorted into guesses, and whether the most
    likely one is likely enough to call the board found. The settings are
    the module's unless given: a search record's poses are replayed with
    others to see what they would have called (searchreport.py). `tune`
    changes the threshold, the corners and their tolerance as they go."""

    # How the look calls the board found: a camera's look_method.
    method = "vote"

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
        min_match: float | None = None,
    ) -> None:
        self.middle = middle
        self.min_match = MIN_MATCH if min_match is None else min_match
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
        # Whether a stop may end without a lock on pcbv's searches there
        # (StopEnd): set by the look when the camera's scale is known, so
        # pcbv searches one scale window instead of trying them in turn.
        self.numbers_searches = False
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
        # The place of the frame pcbv's newest search ran on and that
        # search's number (counted_search); None when the newest pose
        # brought no search of a placed frame.
        self._searched_at: tuple[PictureFrame, int] | None = None

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
        none, or could not be used), and why not when it could not. A lock
        that matched under `min_match` is left out (MIN_MATCH says why)."""
        if estimate is not None and estimate.match < self.min_match:
            problem = weak_problem(estimate.match, self.min_match)
            estimate = None
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

    def take(self, raw: dict, where, captured: float, to_job, estimate: Estimate | None, problem: str | None, session: int | None = None, searched_where=None) -> None:
        """One pose pcbv reported, with what was made of it: the vote reads
        its state and estimate (the probability, posterior.py, reads the
        rest), and the number of the search it brought, placed where the
        searched frame was taken (`searched_where` when its candidates say
        which frame that was, else `where`) for counted_search."""
        self.see(raw.get("state"), estimate, problem)
        number = raw.get("search")
        counted = None
        if isinstance(number, (int, float)) and not isinstance(number, bool):
            listed = bool(raw.get("candidates")) and raw.get("candidates_search") == number
            at = searched_where if listed and searched_where is not None else where
            if isinstance(at, PictureFrame) and at.velocity == (0.0, 0.0):
                counted = (at, int(number))
        with self._mutex:
            self._searched_at = counted

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

    def agrees_here(self, look: Estimate, other: Estimate) -> bool:
        """Whether `other` puts the board point `look` saw under its
        picture's center where that center was, within the agreement: the
        point a picture places best. A pose's own turn and middle come from
        its corners, extrapolated past its pads (on a LumenPnP a right lock
        read the board's turn as -2.2 degrees, truth 0.17, and its stop
        never agreed with the place leading); they are not compared. A
        look without its point or place is compared whole (agrees)."""
        if look.seen is None or look.place is None:
            return self.agrees(look, other)
        return math.dist(other.apply(look.seen), look.place) <= self.agree_mm

    # Whether the look's evidence comes once per pcbv search (the
    # posterior) rather than once per pose (the vote): a stop with a lock
    # then ends once pcbv only tracks it (StopEnd's `searched`).
    counts_searches = False

    def counted_search(self, frame: PictureFrame) -> int | None:
        """pcbv's number of the search the newest pose brought, when that
        search ran on a frame taken at `frame`'s place; None otherwise."""
        with self._mutex:
            counted = self._searched_at
        if counted is None or not same_place(counted[0], frame):
            return None
        return counted[1]

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
        median place and turn, the turns taken about the seed's across the
        wrap; or, from looks taken PLACES_MM apart or more, the turn and
        place the head's places give (PLACES_MM says why)."""
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
        placed = places_fit(group)
        if placed is not None:
            estimate.rotation = _wrap(placed.rotation)
            estimate.shift = placed.shift
            estimate.center = placed.apply(self.middle)
            estimate.rms = placed.rms
            estimate.roll_off = _wrap(placed.rotation - rotation)
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
                "method": self.method,
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
        options: Callable[[], dict] | None = None,
        crop: Callable[[], tuple | None] | None = None,
        board_crop: Callable[[], tuple | None] | None = None,
    ) -> None:
        self._client = client
        self._publish = publish
        self._paused = paused
        # The part of the picture the busy test measures (crops.py), as the
        # camera's file has it now; None for the whole picture.
        self.crop: Callable[[], tuple | None] = crop or (lambda: None)
        # The crop pcbv's board look keeps to (None: the whole picture), for
        # where the posterior counts a picture's pads (posterior.View).
        self.board_crop: Callable[[], tuple | None] = board_crop or (lambda: None)
        # The camera's threshold and corners' tolerance, as they are now.
        self.tuning: Callable[[], tuple[float, float]] = tuning or (lambda: (THRESHOLD, CORNER_MM))
        # How the camera's look calls a board found (`method`: vote or
        # posterior), whether the posterior fits the board's stretch, and
        # the camera's scale (mm per px, 0 unknown), as they are now.
        self.options: Callable[[], dict] = options or (lambda: {"method": "vote"})
        # The loaded board's pads and holes and its outline's box, in the
        # job's frame, for the posterior's pictures.
        self._features: list[Point] = []
        self._outline: Box | None = None
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
        # Whether pcbv can give pictures as luma for the busy test; a pcbv
        # that cannot is asked once.
        self.busy_test = True
        # Why the camera's pcbv can answer no more (its service stopped, or
        # its process went away): a search ends on it instead of reading
        # every stop as one without a lock. Cleared as a board is loaded.
        self.failure: str | None = None
        # The newest stop's busy share, None when it was not measured.
        self.last_share: float | None = None
        # The place each job's board was found at by this camera, kept while
        # the backend runs: a known place for the next search.
        self.found_places: dict[str, Estimate] = {}
        # The search's known place, the stops at which pcbv took it and at
        # which it could not (a pcbv built before it could), and what it was
        # told at the stop now, sent again when it looks afresh there.
        self.known: KnownPlace | None = None
        self.guided = 0
        self.unguided = 0
        self._stop_near: dict | None = None
        self.searching = False
        # The job's frame to KiCad's board frame, for what pcbv is told.
        self.to_board: Callable[[Point], Point] | None = None
        # The newest full scan's pictures, for the page's mosaic.
        from .mosaic import Mosaic

        self.mosaic = Mosaic()

    @property
    def client(self) -> VisionClient:
        return self._client()

    @property
    def scale_seen(self) -> float | None:
        """The newest scale pcbv reported while locked, mm per full size
        px; kept through Clear guesses, a search and an unloaded board."""
        return self._scale

    def start(
        self, job_id: str, to_job: Callable[[Point], Point], middle: Point, place: PlaceOf, record=None,
        features: list[Point] | None = None, outline: Box | None = None,
    ) -> None:
        """The board of `job_id` is loaded in pcbv: its poses are read from
        now on, into a consensus begun anew, and into `record` (a look's
        search record) until the board is found. `features` (its pads and
        holes) and `outline` (its outline's box), in the job's frame, are
        what the posterior expects pictures to show."""
        self.stop()
        self.begin_record(record)
        self.failure = None
        self.busy_test = True
        with self._lock:
            self.job = job_id
            self._features = list(features or [])
            self._outline = outline
            self._to_job = to_job
            try:
                self.to_board = inverse_of(to_job)
            except ValueError:
                self.to_board = None
            self._place = place
            self.consensus = self._consensus(middle, job_id)
            self._forget_known()
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
            self.to_board = None
            self._place = None
            self.consensus = self._consensus((0.0, 0.0), None)
            self._forget_known()
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=2.0)

    def restart(self, box: Box | None = None, prior: KnownPlace | None = None, flying: bool = False) -> None:
        """A fresh consensus for the board loaded: a search starts over, the
        posterior's prior over `box` (the search's) and about `prior` (a
        place known before, corners aside); `flying` (a scan on the move)
        adds the camera's delay to the posterior's state."""
        with self._lock:
            self.consensus = self._consensus(self.consensus.middle, self.job, box, prior, flying)
            self._frame = None
            self._recheck_at = None
            self._forget_known()

    def forget(self) -> None:
        """The guesses and the place they predict forgotten, the board still
        loaded: the look starts over on the pictures to come (Clear
        guesses), as a search does."""
        self.end_record("searched")
        self.restart()
        self._changed = True

    def shift(self, dx: float, dy: float) -> bool:
        """The camera's offset from the tool is now `dx`, `dy` mm further
        along X and Y than when this look's places were made: each was the
        head's place plus the offset, so the corners taken and the places
        boards were found at move by as much, and the guesses start over on
        the pictures to come (their looks were weighed where the old offset
        put the pictures). The record open ends, as its poses' places were
        the old offset's. False when the look held no place to move."""
        with self._lock:
            held = bool(self.corners or self.found_places or self.consensus.guesses)
            self.corners = [replace(corner, machine=(corner.machine[0] + dx, corner.machine[1] + dy)) for corner in self.corners]
            self.found_places = {job: shifted(place, dx, dy) for job, place in self.found_places.items()}
        self.end_record("searched")
        self.restart()
        self._changed = True
        return held

    def _forget_known(self) -> None:
        self.known = None
        self.guided = 0
        self.unguided = 0
        self._stop_near = None

    def remember_found(self, place: Estimate) -> None:
        """The loaded job's board was found here: the next search's known place."""
        if self.job is not None:
            self.found_places[self.job] = place

    def found_known(self, job_id: str) -> KnownPlace | None:
        """Where this camera found a job's board before, as a known place."""
        place = self.found_places.get(job_id)
        return KnownPlace("found", place, KNOWN_MM, KNOWN_DEG) if place is not None else None

    def known_state(self) -> dict | None:
        """The search's known place for the page, with the stops at which
        pcbv was told it and at which it could not take it; None with none."""
        known = self.known
        if known is None:
            return None
        return {**known.to_dict(), "guided": self.guided, "unguided": self.unguided}

    def _consensus(self, middle: Point, job_id: str | None, box: Box | None = None, prior: KnownPlace | None = None, flying: bool = False) -> Consensus:
        threshold, corner_mm = self.tuning()
        options = self.options()
        if options.get("method") == "posterior" and job_id is not None:
            from .posterior import DELAY_S, DELAY_SIGMA_S, Board, Posterior

            board = Board.of(middle, self._outline, self._features)
            scale = options.get("scale")
            posterior = Posterior(
                board, box, prior, threshold=threshold, corner_mm=corner_mm, corners=self.corners_of(job_id),
                scale=float(scale) if isinstance(scale, (int, float)) else None, stretch=bool(options.get("stretch")),
                marks=list(options.get("marks") or []), delay=(DELAY_S, DELAY_SIGMA_S) if flying else None,
            )
            posterior.crop = self.board_crop()
            return posterior
        consensus = Consensus(middle, threshold=threshold, corner_mm=corner_mm, corners=self.corners_of(job_id))
        scale = options.get("scale")
        consensus.numbers_searches = isinstance(scale, (int, float)) and not isinstance(scale, bool) and scale > 0.0
        return consensus

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
        options = self.options()
        method = "posterior" if options.get("method") == "posterior" and self.job is not None else "vote"
        stretch = bool(options.get("stretch")) and method == "posterior"
        if method != consensus.method or stretch != bool(getattr(getattr(consensus, "layout", None), "stretch", False)):
            # Another method, or the board's stretch switched: the look
            # starts over with it, on the same pictures to come.
            with self._lock:
                self.consensus = self._consensus(consensus.middle, self.job, getattr(consensus, "_box_given", None), getattr(consensus, "known", None))
            self._changed = True
            record = self.record
            if record is not None:
                record.event("settings", method=method, stretch=stretch, **tuning_fields(self.consensus))
            return
        marks = [tuple(map(tuple, pair)) for pair in options.get("marks") or []]
        if method == "posterior" and hasattr(consensus, "mark_pairs") and marks != consensus.mark_pairs():
            consensus.set_marks(marks)
            self._changed = True
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
            if dead_camera(str(exc)):
                self.failure = str(exc)
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
        # A lock the vote leaves out (MIN_MATCH) is refused here, so a stop
        # seeing only such locks ends as one with none (a feeder's tape
        # held each quick scan stop its whole time); the record keeps its
        # estimate for replays with another least match.
        weak = None
        if estimate is not None and self.consensus.method == "vote" and estimate.match < self.consensus.min_match:
            weak, estimate = estimate, None
            problem = weak_problem(weak.match, self.consensus.min_match)
        width, height = raw.get("width"), raw.get("height")
        if isinstance(where, PictureFrame) and self._scale is not None and _number(width) and _number(height) and width > 0 and height > 0:
            self.consensus.picture = (where, float(width), float(height), self._scale)
        searched_where = None
        age = raw.get("candidates_age_ms")
        if raw.get("candidates") and _number(age):
            # The candidates are of the frame their search ran on, which
            # may have been taken before the newest, from another place.
            searched_where = place(received - float(age) / 1000.0)
        if hasattr(self.consensus, "crop"):
            # A crop changed in the machine file holds from the next picture.
            self.consensus.crop = self.board_crop()
        self.consensus.take(raw, where, captured, to_job, estimate, problem, estimate.session if estimate is not None else self.resets, searched_where)
        if not self.searching and self.consensus.found and self.consensus.best is not None:
            # A search remembers only a place its check agreed with.
            self.remember_found(self.consensus.best)
        self._changed = True
        seen = "used" if estimate is not None else "locked" if state == "locked" else "none"
        if record is not None:
            # The place of every pose is kept: a picture that locked on
            # nothing says where the board is not, for the posterior's replay.
            kept = where
            record.event("pose", **pose_fields(record, raw, received, captured, kept, estimate or weak, problem, seen, self.consensus))
            if record.kind == "look":
                self._look_record(record)
        if self.consensus.wants_another_lock:
            self._recheck(record)
        return seen

    def settle(self, began: float, stopped: Callable[[], bool]) -> float:
        """When the picture came to rest after a stop began at `began`: the
        capture time of the first of two frames in a row whose pictures
        agree within SETTLED_PX (phase_shift at BUSY_WIDTH), as Measure
        camera and OpenPnP's frame difference settling do; the camera's
        settle time after `began` at the latest, and that too for a camera
        that gives no pictures as luma."""
        ceiling = began + camera_module.SETTLE_SECONDS
        if not self.busy_test:
            return ceiling
        try:
            last, reply, last_at = _fresh_picture(self.client, began, stopped)
            while last_at < ceiling:
                gray, reply_now, captured = _fresh_picture(self.client, last_at + 1e-3, stopped, reply.get("frame"))
                reply = reply_now
                if gray.shape == last.shape:
                    dx, dy, _ = phase_shift(cut(last, self.crop()), cut(gray, self.crop()))
                    if math.hypot(dx, dy) <= SETTLED_PX:
                        return max(last_at, began)
                last, last_at = gray, captured
        except (AttributeError, VisionError, ValueError) as exc:
            if stopped() or dead_camera(str(exc)):
                return ceiling
            log.warning("board look: no settle by frames: %s", exc)
        return ceiling

    def busy(self, since: float, stopped: Callable[[], bool]) -> tuple[float, dict, float] | None:
        """How busy the camera's picture taken `since` or later is
        (pictures.busy_share), its reply and when it was taken; None when
        pcbv cannot give pictures as luma (asked again after the next
        board load)."""
        if not self.busy_test:
            return None
        try:
            asked = time.monotonic()
            gray, reply = fresh_gray(self.client, since, BUSY_WIDTH, stopped)
        except (AttributeError, VisionError, ValueError) as exc:
            if stopped():
                # The stop's own look says so.
                return None
            if dead_camera(str(exc)):
                self.failure = str(exc)
                return None
            log.warning("board look: no busy test: %s", exc)
            self.busy_test = False
            return None
        age = reply.get("age_ms")
        captured = asked - float(age) / 1000.0 if _number(age) else asked
        return busy_share(cut(gray, self.crop())), reply, captured

    def see_empty(self, frame: PictureFrame, share: float, reply: dict, captured: float, size: tuple[float, float] | None) -> None:
        """A picture the busy test called empty: one look that found no
        lock there, for the vote and the posterior (a view searched once
        with no candidate, so the board is less likely under it) and for
        the record, as a lost pose that says `empty` and its share. `size`
        is the full size picture's width and height, px."""
        to_job = self._to_job
        if self.job is None or to_job is None:
            return
        raw: dict = {"state": "lost", "searched": True, "empty": True, "busy": round(share, 4), "frame": reply.get("frame"), "age_ms": reply.get("age_ms")}
        if size is not None:
            raw["width"], raw["height"] = size
        received = time.monotonic()
        problem = f"the picture shows no board: {share * 100.0:.1f}% of it holds edges, under {EMPTY_BUSY * 100.0:.1f}%"
        self.consensus.take(raw, frame, captured, to_job, None, problem, self.resets, None)
        self._changed = True
        record = self.record
        if record is not None:
            record.event("pose", **pose_fields(record, raw, received, captured, frame, None, problem, "none", self.consensus))

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
        # At a search stop pcbv is told the known place again; at a check
        # it was told nothing, and is told nothing again.
        _reset(self, self._stop_near)

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
        options = self.options()
        method = "posterior" if options.get("method") == "posterior" else "vote"
        stretch = bool(options.get("stretch")) and method == "posterior"
        if self.job is None:
            threshold, corner_mm = self.tuning()
            return {
                "job": None, "threshold": threshold, "corner_mm": corner_mm, "method": method, "board_stretch": stretch, "corners": corners,
                "scan": self.mosaic.summary(),
            }
        return {
            "job": self.job, **consensus.to_dict(), "board_stretch": stretch, "record": self.last_record, "corners": corners, "known": self.known_state(),
            "scan": self.mosaic.summary(),
        }

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


# What pcbv or the client says when the camera can answer no more.
DEAD_WORDS = ("the service has stopped", "the camera is not running", "pcbv went away")


def _fresh_picture(client, since: float, stopped: Callable[[], bool], other=None, limit: float = 3.0) -> tuple[np.ndarray, dict, float]:
    """The camera's newest picture as luma at BUSY_WIDTH, taken `since` or
    later and other than the picture numbered `other`, its reply and when
    it was taken: asked again until one comes, each picture's capture told
    from the one ask that brought it. pcbv answers its newest picture again
    until the next is taken, so a capture told from the clock before many
    asks comes out early by the wait, and the same picture would pass for
    the next one; a ValueError when none comes within `limit` seconds, or
    once `stopped`."""
    deadline = time.monotonic() + limit
    while True:
        if stopped():
            raise ValueError("stopped")
        asked = time.monotonic()
        # Whatever picture is newest, from this one ask.
        gray, reply = fresh_gray(client, -math.inf, BUSY_WIDTH)
        age = reply.get("age_ms")
        captured = asked - float(age) / 1000.0 if _number(age) else asked
        frame = reply.get("frame")
        if captured >= since and (other is None or frame is None or frame != other):
            return gray, reply, captured
        if time.monotonic() >= deadline:
            raise ValueError("the camera gave no new picture: is it still running?")
        time.sleep(min(0.03, max(0.005, since - captured)))


def dead_camera(text: str) -> bool:
    """Whether an error from the camera's pcbv means it can answer no more."""
    return any(words in text for words in DEAD_WORDS)


def search_box(center: Point, size: float) -> Box:
    """A square box `size` mm on a side about a point."""
    half = size / 2.0
    return (center[0] - half, center[1] - half, center[0] + half, center[1] + half)


def _lattice(x0: float, y0: float, x1: float, y1: float, step_x: float, step_y: float, between: bool = False) -> list[Point]:
    """Points `step_x` by `step_y` apart centered in a box, one at least; with
    `between` the points halfway between those (none along an axis with one)."""
    nx = max(1, math.ceil((x1 - x0) / step_x - 1e-9))
    ny = max(1, math.ceil((y1 - y0) / step_y - 1e-9))
    if between:
        nx, ny = nx - 1, ny - 1
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    return [(cx + (i - (nx - 1) / 2.0) * step_x, cy + (j - (ny - 1) / 2.0) * step_y) for j in range(ny) for i in range(nx)]


def _nearest_first(stops: list[Point], start: Point) -> list[Point]:
    return sorted(stops, key=lambda p: (round(math.dist(p, start), 6), math.atan2(p[1] - start[1], p[0] - start[0])))


def _path(stops: list[Point], start: Point) -> list[Point]:
    """The stops in the order a head going each time to the nearest one left
    takes them, from `start`: a quick scan's lattice taken nearest the start
    first jumped from side to side (1 to 2 s a move on a LumenPnP's bed)."""
    left = list(stops)
    order = []
    here = start
    while left:
        index = min(range(len(left)), key=lambda i: (round(math.dist(left[i], here), 6), i))
        here = left.pop(index)
        order.append(here)
    return order


def search_stops(box: Box, view: tuple[float, float], start: Point, coarse: float | None = None) -> list[Point]:
    """The places for the picture's center that cover a box with pictures
    `view` (width, height mm) apart less OVERLAP: a grid centered in the
    box, a stop at least, nearest `start` first. With `coarse` (mm) a quick
    scan of a box much larger than the board instead: a lattice that far
    apart (never closer than the grid), then the lattice halfway between
    it, each in one path from `start` going to the nearest stop left each
    time; spaced at QUICK_SHARE of the board's
    shorter side, the first lattice has a stop well inside the board
    wherever it lies, where its looks lock right (its edges' looks lock
    wrong most often). A ValueError for a box that would take more than
    MAX_STOPS."""
    x0, y0, x1, y1 = min(box[0], box[2]), min(box[1], box[3]), max(box[0], box[2]), max(box[1], box[3])
    step_x = max(view[0] * (1.0 - OVERLAP), 0.1)
    step_y = max(view[1] * (1.0 - OVERLAP), 0.1)
    if coarse is not None and coarse > 0.0:
        step_x, step_y = max(step_x, coarse), max(step_y, coarse)
        first = _lattice(x0, y0, x1, y1, step_x, step_y)
        then = _lattice(x0, y0, x1, y1, step_x, step_y, between=True)
        if len(first) + len(then) > MAX_STOPS:
            # Asked for by a search with nothing known, not by a box drawn:
            # what narrows it is said, since "a smaller box" names nothing
            # the operator drew.
            raise ValueError(
                f"a scan of where boards lie needs {len(first) + len(then)} stops for a board this small, more than {MAX_STOPS}:"
                " give [top_camera] board_area in the machine file (where boards are put), draw a box on the camera's picture"
                " (Shift and a drag), or take a corner of the board"
            )
        ordered = _path(first, start)
        return ordered + _path(then, ordered[-1])
    nx = max(1, math.ceil((x1 - x0) / step_x - 1e-9))
    ny = max(1, math.ceil((y1 - y0) / step_y - 1e-9))
    if nx * ny > MAX_STOPS:
        raise ValueError(f"the box needs {nx * ny} stops of the camera's picture, more than {MAX_STOPS}: draw a smaller box")
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    stops = [(cx + (i - (nx - 1) / 2.0) * step_x, cy + (j - (ny - 1) / 2.0) * step_y) for j in range(ny) for i in range(nx)]
    stops.sort(key=lambda p: (round(math.dist(p, start), 6), math.atan2(p[1] - start[1], p[0] - start[0])))
    return stops


def quick_first(box: Box, view: tuple[float, float], coarse: float) -> tuple[int, float]:
    """How many of a quick scan's stops (search_stops with `coarse`) make
    its first lattice, and how far apart they are, mm (the larger step)."""
    x0, y0, x1, y1 = min(box[0], box[2]), min(box[1], box[3]), max(box[0], box[2]), max(box[1], box[3])
    step_x = max(max(view[0] * (1.0 - OVERLAP), 0.1), coarse)
    step_y = max(max(view[1] * (1.0 - OVERLAP), 0.1), coarse)
    return len(_lattice(x0, y0, x1, y1, step_x, step_y)), max(step_x, step_y)


class StopEnd:
    """When the look at one stop ends, told pose by pose (`see`, with the
    pose's kind as BoardLook.sample says it and the time): `found` once the
    board is found; without `check`, `likely` once the posterior leads with
    this stop's lock but cannot call it found from one place
    (Posterior.worth_checking); with `check` (a place found elsewhere)
    `agreed` once CHECK_LOOKS looks here agree with it (_agrees),
    `disagreed` once as many put it elsewhere. A look that numbers pcbv's
    searches (numbers_searches: the camera's scale known) ends it on
    evidence too: `no lock` once pcbv ran STOP_SEARCHES searches on the
    stop's settled pictures without a lock; and one whose evidence comes
    once per search (counts_searches, the posterior) `searched` (not at a
    check, which counts its own looks) once a lock at the least match or
    better is tracked TRACKED_POSES poses with no new search; neither
    while a guess waits for another independent lock (wants_another_lock). The
    clocks from `began` end it at the latest: `no lock` without a lock
    after LOCK_SECONDS, `time up` after STOP_SECONDS, each past the
    camera's settle time. The replays of search records use it on their
    poses (searchreport.py)."""

    def __init__(self, consensus: Consensus, frame: PictureFrame, check: Estimate | None, began: float) -> None:
        self.consensus = consensus
        self.frame = frame
        self.check = check
        self.began = began
        self.locked = False
        self.agreed = 0
        self.disagreed = 0
        # pcbv's numbers of the first and newest searches brought here, and
        # the poses since the newest that tracked a lock.
        self.first: int | None = None
        self.newest: int | None = None
        self.tracked = 0

    @property
    def searches(self) -> int:
        """The searches pcbv ran from the first brought here to the newest:
        poses are read slower than pcbv searches, so some are not read."""
        return 0 if self.first is None or self.newest is None else self.newest - self.first + 1

    def _agrees(self, look: Estimate, other: Estimate) -> bool:
        """A look agrees with a place when it puts the board point under
        its picture's center where the place does (agrees_here), or the
        board's middle and turn where the place does (agrees): a pose's
        turn can be off (the first), and so can a place found from one
        picture's poses (the second; on a LumenPnP a place found 0.8
        degrees off put a check 30 mm away 0.7 mm off its point). A wrong
        place, a pitch of a repeated circuit away, fails both."""
        return self.consensus.agrees_here(look, other) or self.consensus.agrees(look, other)

    def see(self, seen: str, now: float) -> str | None:
        consensus = self.consensus
        check = self.check
        if check is None and consensus.found:
            return "found"
        view = consensus.view
        strong = seen == "used" and view is not None and view.match >= MIN_MATCH
        if check is None and seen == "used" and getattr(consensus, "worth_checking", False):
            best = consensus.best
            if view is not None and best is not None and self._agrees(view, best):
                return "likely"
        if seen == "used":
            # A weak lock (under the least match) does not hold the stop
            # past the lock time: the posterior weighs it, the vote refuses it.
            if view is None or view.match >= MIN_MATCH:
                self.locked = True
            if check is not None and strong:
                if self._agrees(view, check):
                    self.agreed += 1
                else:
                    self.disagreed += 1
                if self.agreed >= CHECK_LOOKS:
                    return "agreed"
                if self.disagreed >= CHECK_LOOKS:
                    return "disagreed"
        if consensus.numbers_searches:
            number = consensus.counted_search(self.frame)
            if number is not None:
                self.first = number if self.first is None else min(self.first, number)
                self.newest = number if self.newest is None else max(self.newest, number)
                self.tracked = 0
            elif strong and self.searches:
                self.tracked += 1
            elif seen != "same":
                self.tracked = 0
            if not consensus.wants_another_lock:
                # A check counts its own looks (CHECK_LOOKS), tracked or not;
                # the vote counts tracked poses as looks, so it stays for them.
                if consensus.counts_searches and check is None and self.searches and self.tracked >= TRACKED_POSES:
                    return "searched"
                if not self.locked and not strong and self.searches >= STOP_SEARCHES:
                    return "no lock"
        elapsed = now - self.began
        if elapsed >= STOP_SECONDS + camera_module.SETTLE_SECONDS:
            return "time up"
        if not self.locked and elapsed >= LOCK_SECONDS + camera_module.SETTLE_SECONDS:
            return "no lock"
        return None


def look_at_stop(
    look: BoardLook, frame: PictureFrame, stopped: Callable[[], bool], error: type[Exception], check: Estimate | None = None,
    gate: float = EMPTY_BUSY, size: tuple[float, float] | None = None, record=None, index: int | None = None,
) -> str:
    """Reads poses with the head at rest at one stop until StopEnd ends it
    (`found`, `likely`, `agreed`, `disagreed`, `searched`, `no lock`, `time
    up`). Only frames taken once the picture came to rest are used
    (BoardLook.settle; the camera's settle time after the stop began at
    the latest). First the picture's busy share (pictures.py) is measured:
    under EMPTY_BUSY the stop ends `empty` at once, a look that found
    nothing; under `gate` (a quick scan's first pass asks for a picture
    that looks like board, BOARD_BUSY) it ends `sparse`, left for later.
    `size` is the full size picture's width and height, px; the share goes
    into `record` with the stop's `index`."""
    began = time.monotonic()
    trusted = look.settle(began, stopped) if SETTLE_BY_FRAMES else began + camera_module.SETTLE_SECONDS
    if record is not None:
        record.event("settled", index=index, seconds=round(trusted - began, 3))
    busy = look.busy(trusted, stopped) if gate > 0.0 else None
    if busy is not None:
        share, reply, captured = busy
        look.last_share = share
        if record is not None:
            record.event("busy", index=index, share=round(share, 4), seconds=round(time.monotonic() - began, 3))
        if share < EMPTY_BUSY:
            look.see_empty(frame, share, reply, captured, size)
            look.publish()
            return "empty"
        if share < gate:
            return "sparse"

    def place(captured: float) -> PictureFrame | str:
        return frame if captured >= trusted else "the head is coming to rest"

    rule = StopEnd(look.consensus, frame, check, began)
    while True:
        if stopped():
            raise error("stopped")
        if look.failure is not None:
            raise error(f"the camera's pcbv can answer no more ({look.failure}): stop and start the camera, then search again")
        seen = look.sample(place)
        look.publish()
        end = rule.see(seen, time.monotonic())
        if end is not None:
            return end
        time.sleep(SAMPLE_SECONDS / 2.0)


# Rounds of putting a check's picture over the middle of the pads it holds
# (check_places): the point under the picture's center is then
# interpolated between pads, not extrapolated past them, so a scale, lens
# or height error moves it least (OpenPnP's fiducial locator looks again
# centered on what it found).
CENTER_ROUNDS = 2

# Where a crop lies about the picture's center: its center's offset and its
# extent, mm along the machine's axes (crops.crop_box_mm).
CropBox = tuple[Point, tuple[float, float]]


def _held(found: Estimate, place: Point, machine: np.ndarray, view: tuple[float, float], box: CropBox | None) -> np.ndarray:
    """Which features (`machine`, their places on the machine) a look
    whose sight is centered where `found` puts the job point `place` holds:
    nine tenths of its picture `view` (width, height mm), or of its crop
    (`box`'s extent), about that point, the sides along the machine's axes."""
    mx, my = found.apply(place)
    w, h = box[1] if box is not None else view
    return (np.abs(machine[:, 0] - mx) <= 0.45 * w) & (np.abs(machine[:, 1] - my) <= 0.45 * h)


def held_counts(found: Estimate, places: list[Point], features: list[Point], view: tuple[float, float], box: CropBox | None = None) -> list[int]:
    """How many of the job's pads and holes (`features`) a picture `view`
    (width, height mm, nine tenths of it, or of its crop `box`) holds with
    its sight (the picture, or its crop) centered on each place (job frame)
    where `found` puts the board: the sides along the machine's axes."""
    if not features or not places:
        return [0 for _ in places]
    machine = np.array([found.apply(f) for f in features])
    return [int(_held(found, place, machine, view, box).sum()) for place in places]


def dense_places(
    found: Estimate, middle: Point, outline: Box | None, features: list[Point], view: tuple[float, float], box: CropBox | None = None,
) -> list[tuple[Point, int]]:
    """Places on the board for the picture's center (job frame) with the
    pads and holes a picture there holds, the most first (ties: nearer the
    middle): a grid half a picture apart over the board's outline less
    EDGE_MM (or a fifth of its shorter side, for a small board), the
    middle among them. Over a bare stretch or near an edge pcbv locks
    wrong; on a LumenPnP an OreSat battery card's bare middle gave only
    quarter turns 10 to 19 mm off."""
    if outline is None or not features:
        return [(middle, 0)]
    x0, y0, x1, y1 = outline
    margin = min(EDGE_MM, 0.2 * min(x1 - x0, y1 - y0))
    sight = box[1] if box is not None else view
    spacing = max(min(sight) / 2.0, 0.5)
    places = [middle] + _lattice(x0 + margin, y0 + margin, x1 - margin, y1 - margin, spacing, spacing)
    counts = held_counts(found, places, features, view, box)
    order = sorted(range(len(places)), key=lambda i: (-counts[i], math.dist(places[i], middle)))
    return [(places[i], counts[i]) for i in order]


def centered(
    found: Estimate, place: Point, features: list[Point], view: tuple[float, float], box: CropBox | None = None, within: Box | None = None,
) -> Point:
    """A check's place (job frame) moved over the middle of the pads and
    holes its picture holds there, CENTER_ROUNDS times, kept `within` a
    box (job frame: the outline less its edge margin) when given; as it is
    when it holds none."""
    if not features:
        return place
    jobs = np.asarray(features, dtype=float)
    machine = np.array([found.apply(f) for f in features])
    for _ in range(CENTER_ROUNDS):
        inside = _held(found, place, machine, view, box)
        if not inside.any():
            break
        middle = jobs[inside].mean(axis=0)
        place = (float(middle[0]), float(middle[1]))
        if within is not None:
            place = (min(max(place[0], within[0]), within[2]), min(max(place[1], within[1]), within[3]))
    return place


def check_places(
    found: Estimate, middle: Point, outline: Box | None, features: list[Point], view: tuple[float, float], count: int = MAX_CHECKS,
    box: CropBox | None = None,
) -> list[Point]:
    """Where to check a board found (`found` puts the job's frame on the
    machine), machine points for the picture's center, the best first:
    the place whose picture holds the most pads and holes (dense_places),
    then among those holding at least half as many each time the one
    farthest from the places taken: checks far apart give the board's
    turn from the head's places (places_fit) over a long baseline; `count`
    at most. Each is then moved over the middle of the pads its picture
    holds (centered), inside the outline's edge margin; two that come to
    the same pads are one. With a crop (`box`) the places are where the
    crop's center goes, its pads counted, and the picture's center is
    offset from it by the crop's offset. A board without features is
    checked at its middle."""
    dense = dense_places(found, middle, outline, features, view, box)
    ranked = [place for place, held in dense if held * 2 >= dense[0][1]] or [dense[0][0]]
    places: list[Point] = [ranked[0]]
    while len(places) < count:
        left = [place for place in ranked if all(math.dist(place, kept) > 1e-6 for kept in places)]
        if not left:
            break
        places.append(max(left, key=lambda place: min(math.dist(place, kept) for kept in places)))
    (ox, oy) = box[0] if box is not None else (0.0, 0.0)
    within = None
    if outline is not None:
        x0, y0, x1, y1 = outline
        margin = min(EDGE_MM, 0.2 * min(x1 - x0, y1 - y0))
        within = (x0 + margin, y0 + margin, x1 - margin, y1 - margin)
    # Two checks centered onto the same pads are one: the other is dropped.
    apart = 0.25 * min(box[1] if box is not None else view)
    kept: list[Point] = []
    for place in places:
        moved = centered(found, place, features, view, box, within)
        if all(math.dist(moved, other) > apart for other in kept):
            kept.append(moved)
    return [(found.apply(place)[0] - ox, found.apply(place)[1] - oy) for place in kept]


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
    known: KnownPlace | None = None,
    side: str = "front",
    box: Box | None = None,
    prior: KnownPlace | None = None,
    steer: dict | None = None,
    picture: tuple[float, float, float] | None = None,
    outline: Box | None = None,
    quick: tuple[int, float] | None = None,
) -> Estimate:
    """Moves the head (`mover`, already begun and at its looking height) so
    the picture's center visits each stop (the head at the stop less the
    camera's `offset`), looks at each, and ends found and checked, with the
    picture's center over the place checked and the estimate; or raises
    `error` once every stop was looked at, or MAX_CHECKS checks failed.
    `frame_at` is the picture's place with its center at a point; `checks`
    gives the places to check a board found at, the best first (the
    board's middle by default). `known`, where the board is expected, is
    told to pcbv at every stop but the checks (`side`, the camera's, says
    how pcbv reads the picture's turn). `record` (searchlog.py) gets every
    pose, each stop's move, end and picture, each check, and how the
    search ended. A posterior look takes `box` and `prior` (a place known
    before, corners aside) as its prior, and with `steer` (the picture's
    `width` and `height` px, its `scale` mm per px, the head's `speed`
    mm/s and where the picture's center is, `start`) goes to the stop
    expected to narrow the probability most for its time next, instead of
    the nearest. With `picture` (the full size picture's width, height px
    and scale mm per px) each stop's picture goes into the look's mosaic,
    a map of where the search looked, with the board's `outline` drawn
    where it was found. Each stop's picture is first measured for how busy
    it is (look_at_stop): an empty one ends the stop at once. `quick`, for
    a quick scan of a bed (search_stops' coarse lattice, its first `quick[0]`
    stops spaced `quick[1]` mm apart), asks pcbv only at stops whose
    pictures look like board (BOARD_BUSY) on the first lattice, then at
    the stops of the lattice between that lie next to one of those, then
    the rest of it alike, and last at the pictures left as sparse, the
    busiest first; the posterior's steering waits for it."""
    # The look's own record ends with the consensus it had, then the
    # search starts one afresh.
    look.begin_record(record)
    look.restart(box, prior)
    look.known = known
    look.searching = True
    if picture is not None and look.job is not None:
        look.mosaic.begin(look.job, [round(v, 4) for v in outline] if outline is not None else None, "search")
    visited = 0
    covered = False
    refuted = False
    made = 0
    places_of = checks or (lambda found: [found.center])

    def visit(index: int, target: Point, middle: bool = False, check: Estimate | None = None, gate: float = EMPTY_BUSY) -> str:
        """The picture's center to `target`, the stop looked at: its result.
        pcbv is told the known place at a stop, and nothing at a check: a
        check agrees with the place found only by what pcbv sees there."""
        head = (target[0] - offset[0], target[1] - offset[1])
        if record is not None:
            record.stop = index
            record.event("stop", index=index, target=_rounded(target), head=_rounded(head), **({"middle": True} if middle else {}))
        mover.go(head)
        frame = frame_at(target)
        near = near_fields(known, frame, look.to_board, side) if known is not None and check is None and look.to_board is not None else None
        took = _reset(look, near)
        if near is not None:
            if took:
                look.guided += 1
            else:
                look.unguided += 1
        if record is not None:
            record.event("arrived", index=index, **({"near": near, "took": took} if near is not None else {}))
        began = time.monotonic()
        size = (picture[0], picture[1]) if picture is not None else None
        result = look_at_stop(look, frame, stopped, error, check, gate, size, record, index)
        if record is not None:
            record.event("stop_end", index=index, result=result, seconds=round(time.monotonic() - began, 3))
            record.picture(look.client, f"stop-{index:03d}", index=index)
        if picture is not None:
            look.mosaic.add(look.client, frame.center, frame.roll, frame.mirror, picture[2], picture[0])
        return result

    remaining = list(range(len(stops)))
    here = steer.get("start") if steer is not None else None
    # A quick scan's order (see above): the stops yet to go with the busy
    # share each needs before pcbv is asked, and what each stop showed.
    shares: dict[int, float] = {}
    sparse: list[int] = []
    planned: list[tuple[int, float]] = []
    rested = False
    if quick is not None:
        planned = [(index, BOARD_BUSY) for index in range(min(quick[0], len(stops)))]
        remaining = []

    def plan_rest(at: Point) -> None:
        """The quick scan's first lattice is done: the lattice between,
        next to busy stops first, then the rest, then the sparse ones."""
        between = list(range(min(quick[0], len(stops)), len(stops)))
        busy_places = [stops[i] for i, share in shares.items() if share >= BOARD_BUSY]
        reach = 0.75 * quick[1]
        near = [i for i in between if any(math.dist(stops[i], place) <= reach for place in busy_places)]
        rest = [i for i in between if i not in near]
        order = _path([stops[i] for i in near], at)
        near_sorted = sorted(near, key=lambda i: order.index(stops[i]))
        planned.extend((i, EMPTY_BUSY) for i in near_sorted)
        planned.extend((i, BOARD_BUSY) for i in rest)
        planned.append((-1, 0.0))

    try:
        while remaining or planned:
            consensus = look.consensus
            gate = EMPTY_BUSY
            if planned:
                index, gate = planned.pop(0)
                if index == -1:
                    # The sparse pictures, the busiest first, looked at by pcbv whatever they show.
                    planned.extend((i, 0.0) for i in sorted(sparse, key=lambda i: -shares.get(i, 0.0)))
                    sparse.clear()
                    continue
            elif steer is not None and here is not None and hasattr(consensus, "next_stop") and len(remaining) > 1:
                frame = frame_at(tuple(here))
                pick = consensus.next_stop(
                    [stops[i] for i in remaining], tuple(here), frame.roll, frame.mirror, float(steer["width"]), float(steer["height"]),
                    float(steer["scale"]), float(steer.get("speed") or SLOW_MM_S), LOCK_SECONDS + camera_module.SETTLE_SECONDS,
                )
                index = remaining.pop(pick)
            else:
                index = remaining.pop(0)
            stop = stops[index]
            on_stop(min(visited, len(stops) - 1), len(stops))
            visited += 1
            here = stop
            look.last_share = None
            result = visit(index, stop, gate=gate)
            if look.last_share is not None:
                shares[index] = look.last_share
            if result == "sparse":
                sparse.append(index)
            if quick is not None and index == min(quick[0], len(stops)) - 1 and gate == BOARD_BUSY and not rested:
                rested = True
                plan_rest(stop)
            # Found: checked from elsewhere on the board, the place found
            # kept only once the looks there agree with it. A check that
            # saw nothing or disagreed leaves the evidence in the consensus:
            # while it still calls the board found, the next place is
            # checked; else the search goes on.
            while result in ("found", "likely"):
                if result == "likely" and made >= MAX_CHECKS:
                    # A lead never found is not refuted: the search goes on.
                    break
                if made >= MAX_CHECKS:
                    refuted = True
                    raise error(
                        f"the board was found {made} times but no check agreed: the looks at another place on it put it elsewhere"
                        " or saw nothing there; check the board's side and finish, or take its corners"
                    )
                best = look.consensus.best
                assert best is not None
                places = places_of(best) or [best.center]
                # A check PLACES_MM or more from where the board was found
                # gives the turn from the head's places (places_fit), the
                # farther the better: two places 25 mm apart on one side of
                # a LumenPnP board put its middle 0.12 mm off.
                places = sorted(places, key=lambda point: (math.dist(point, stop) < PLACES_MM, -math.dist(point, stop)))
                place = places[min(made, len(places) - 1)]
                made += 1
                outcome = visit(len(stops) + made - 1, place, middle=True, check=best)
                if record is not None:
                    record.event("check", result=outcome, estimate=best.to_dict(), place=_rounded(place))
                if outcome == "agreed":
                    # More places in the final fit: the found stop and the
                    # check make two; each more check place, half PLACES_MM
                    # or more from those taken, the farthest, cuts the error
                    # (FINAL_PLACES). A look there that disagrees stays out
                    # of the fit (placed_estimate).
                    taken = [stop, place]
                    while len(taken) < FINAL_PLACES and made < MAX_CHECKS:
                        left = [point for point in places if all(math.dist(point, other) >= PLACES_MM / 2.0 for other in taken)]
                        if not left:
                            break
                        more = max(left, key=lambda point: min(math.dist(point, other) for other in taken))
                        made += 1
                        extra = visit(len(stops) + made - 1, more, middle=True, check=look.consensus.best or best)
                        if record is not None:
                            record.event("check", result=extra, estimate=(look.consensus.best or best).to_dict(), place=_rounded(more), extra=True)
                        taken.append(more)
                    final = placed_estimate(look.consensus, look.consensus.best or best)
                    if picture is not None:
                        look.mosaic.finish(final.to_dict())
                    look.remember_found(final)
                    look.publish(force=True)
                    look.end_record("found", only=record, estimate=final.to_dict(), visited=visited, found_at=index, checks=made)
                    return final
                result = "found" if look.consensus.found else "likely" if result == "likely" and getattr(look.consensus, "worth_checking", False) else outcome
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
        if refuted:
            # Every check disagreed with the guess: forgotten, or the watcher
            # would go on calling it found and keep it as the place the next
            # search starts from (a LumenPnP's second search started at a
            # feeder's tape the first had refuted).
            look.restart()
        raise
    finally:
        # The watcher's looks afterwards are wherever the head is taken next.
        look.searching = False
        look._stop_near = None


# --- the full scan ---------------------------------------------------------------------

# How many looks a scan's stop takes once a lock came: enough for the vote's
# guesses to fill and for the posterior's pooled view; the posterior needs
# one search a picture.
SCAN_LOOKS = 3
# The margin a scan's rows run past where the place known puts the board's
# outline, mm, at least (the place's own tolerance when larger).
SCAN_MARGIN = 2.0
# Where a scan may start from: places measured or found, not the job's own
# place (only where the board was meant to go).
SCAN_SOURCES = ("corners", "found", "align", "references")


def scan_stops(box: Box, view: tuple[float, float], overlap: float = OVERLAP) -> list[Point]:
    """Rows over a box for the picture's center, a picture `view` (width,
    height mm) apart less `overlap`, back and forth: the first row along
    the box's bottom from its left, the next back from its right, so the
    head never travels a row's length empty. A ValueError for a box that
    would take more than MAX_STOPS."""
    x0, y0, x1, y1 = min(box[0], box[2]), min(box[1], box[3]), max(box[0], box[2]), max(box[1], box[3])
    step_x = max(view[0] * (1.0 - overlap), 0.1)
    step_y = max(view[1] * (1.0 - overlap), 0.1)
    # Pictures cover the box: the first and last centers a half picture in.
    span_x = max(x1 - x0 - view[0], 0.0)
    span_y = max(y1 - y0 - view[1], 0.0)
    nx = max(1, math.ceil(span_x / step_x - 1e-9) + 1)
    ny = max(1, math.ceil(span_y / step_y - 1e-9) + 1)
    if nx * ny > MAX_STOPS:
        raise ValueError(f"the board needs {nx * ny} pictures to cover, more than {MAX_STOPS}: lower the margin")
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    xs = [cx + (i - (nx - 1) / 2.0) * (span_x / max(nx - 1, 1) if nx > 1 else 0.0) for i in range(nx)]
    ys = [cy + (j - (ny - 1) / 2.0) * (span_y / max(ny - 1, 1) if ny > 1 else 0.0) for j in range(ny)]
    stops = []
    for j, y in enumerate(ys):
        row = xs if j % 2 == 0 else list(reversed(xs))
        stops.extend((x, y) for x in row)
    return stops


def look_scan_stop(look: BoardLook, frame: PictureFrame, stopped: Callable[[], bool], error: type[Exception]) -> str:
    """Reads poses with the head at rest at a scan's stop: `locked` once
    SCAN_LOOKS were used, `no lock` when none came within LOCK_SECONDS,
    `time up` past STOP_SECONDS. Frames taken the settle time after the
    stop began are used; the board found does not end it."""
    began = time.monotonic()
    trusted = began + camera_module.SETTLE_SECONDS
    used = 0
    # A look that counts pcbv's searches ends a stop without a lock after
    # STOP_SEARCHES of them (StopEnd).
    rule = StopEnd(look.consensus, frame, None, began)

    def place(captured: float) -> PictureFrame | str:
        return frame if captured >= trusted else "the head is coming to rest"

    while True:
        if stopped():
            raise error("stopped")
        if look.failure is not None:
            raise error(f"the camera's pcbv can answer no more ({look.failure}): stop and start the camera, then scan again")
        seen = look.sample(place)
        if seen == "used":
            used += 1
        look.publish()
        if used >= SCAN_LOOKS:
            return "locked"
        if look.consensus.numbers_searches:
            number = look.consensus.counted_search(frame)
            if number is not None:
                rule.first = number if rule.first is None else min(rule.first, number)
                rule.newest = number if rule.newest is None else max(rule.newest, number)
            if used == 0 and seen != "used" and rule.searches >= STOP_SEARCHES:
                return "no lock"
        elapsed = time.monotonic() - began
        if elapsed >= STOP_SECONDS + camera_module.SETTLE_SECONDS:
            return "time up"
        if used == 0 and elapsed >= LOCK_SECONDS + camera_module.SETTLE_SECONDS:
            return "no lock"
        time.sleep(SAMPLE_SECONDS / 2.0)


def scan(
    look: BoardLook,
    mover,
    stops: list[Point],
    offset: Point,
    frame_at: Callable[[Point], PictureFrame],
    stopped: Callable[[], bool],
    on_stop: Callable[[int, int], None],
    error: type[Exception],
    record=None,
    box: Box | None = None,
    prior: KnownPlace | None = None,
    picture: tuple[float, float, float] | None = None,
    outline: Box | None = None,
) -> Estimate | None:
    """Moves the head (`mover`, already begun) so the picture's center
    visits every stop of a full scan in turn, the head at rest at each, and
    looks at each without stopping once the board is found: every picture
    feeds the look (the posterior's prior over `box` about `prior`). Each
    stop's picture goes into the look's mosaic (`picture`: the full size
    picture's width, height px and scale mm per px) and the record. The
    place found once every stop was looked at, or None when the look
    calls none; raises `error` when stopped."""
    look.begin_record(record)
    look.restart(box, prior)
    look.searching = True
    if look.job is not None:
        look.mosaic.begin(look.job, [round(v, 4) for v in outline] if outline is not None else None, "stop")
    visited = 0
    try:
        for index, stop in enumerate(stops):
            on_stop(index, len(stops))
            visited = index + 1
            head = (stop[0] - offset[0], stop[1] - offset[1])
            if record is not None:
                record.stop = index
                record.event("stop", index=index, target=_rounded(stop), head=_rounded(head), scan=True)
            mover.go(head)
            frame = frame_at(stop)
            # Each picture is searched afresh, pcbv told nothing.
            _reset(look, None)
            if record is not None:
                record.event("arrived", index=index)
            began = time.monotonic()
            result = look_scan_stop(look, frame, stopped, error)
            if picture is not None:
                look.mosaic.add(look.client, frame.center, frame.roll, frame.mirror, picture[2], picture[0])
            if record is not None:
                record.event("stop_end", index=index, result=result, seconds=round(time.monotonic() - began, 3))
                record.picture(look.client, f"stop-{index:03d}", index=index)
        consensus = look.consensus
        found = consensus.best if consensus.found else None
        look.mosaic.finish(found.to_dict() if found is not None else None)
        if found is not None:
            look.remember_found(found)
        look.publish(force=True)
        look.end_record("found" if found is not None else "not found", only=record, estimate=found.to_dict() if found is not None else None, visited=visited, scan=True)
        return found
    except BaseException as exc:
        look.end_record("stopped" if stopped() else "error", only=record, message=str(exc) or type(exc).__name__, visited=visited, scan=True)
        raise
    finally:
        look.searching = False
        look._stop_near = None


# --- the full scan on the move ----------------------------------------------------------

# A flying scan's pictures blur less than this share of a small pad (the
# job's tenth percentile, else FLY_PAD_MM) over the camera's exposure, and
# the head never goes faster than FLY_MAX_MM_S, nor so fast that pcbv's
# looks (FLY_LOOKS_HZ) fall further apart than a third of a picture.
BLUR_SHARE = 0.25
FLY_PAD_MM = 0.5
FLY_MAX_MM_S = 20.0
FLY_LOOKS_HZ = 5.0
# The head's place is known between two reports at most this far apart, s.
HISTORY_GAP = 0.5
# A picture for the mosaic every this share of a picture's width along a row.
FLY_TILE_SHARE = 0.6


def fly_speed(exposure_s: float, pad_mm: float, view_width_mm: float) -> float:
    """The head's speed along a flying scan's rows, mm/s: blur within
    BLUR_SHARE of a pad over the exposure, pcbv's looks a third of a
    picture apart at most, and FLY_MAX_MM_S."""
    if not (exposure_s > 0.0):
        raise ValueError("a flying scan needs the camera's exposure set by hand: set it in the camera's picture controls")
    return max(min(BLUR_SHARE * pad_mm / exposure_s, view_width_mm / 3.0 * FLY_LOOKS_HZ, FLY_MAX_MM_S), 0.5)


class PlaceHistory:
    """The head's board points as the status reports gave them, with when
    each came: where the head was at a moment between two reports, and how
    fast it went there."""

    def __init__(self, keep: int = 6000) -> None:
        self._points: deque[tuple[float, Point]] = deque(maxlen=keep)
        self._lock = threading.Lock()

    def add(self, moment: float, point: Point) -> None:
        with self._lock:
            if self._points and moment <= self._points[-1][0]:
                return
            self._points.append((moment, point))

    def latest(self) -> Point | None:
        with self._lock:
            return self._points[-1][1] if self._points else None

    def at(self, moment: float) -> tuple[Point, Point] | None:
        """The head's point and velocity (mm/s) at `moment`, between the two
        reports about it; None outside them, or across a gap of more than
        HISTORY_GAP."""
        with self._lock:
            points = list(self._points)
        for (t0, p0), (t1, p1) in zip(points, points[1:]):
            if t0 <= moment <= t1:
                if t1 - t0 > HISTORY_GAP:
                    return None
                share = (moment - t0) / (t1 - t0) if t1 > t0 else 0.0
                point = (p0[0] + (p1[0] - p0[0]) * share, p0[1] + (p1[1] - p0[1]) * share)
                span = max(t1 - t0, 1e-6)
                return point, ((p1[0] - p0[0]) / span, (p1[1] - p0[1]) / span)
        return None


def fly_rows(stops: list[Point], view_width: float) -> list[tuple[Point, Point]]:
    """A scan's stops (scan_stops, row by row) as rows to fly: each from
    half a picture before its first stop to half a picture past its last,
    so the pictures at its ends cover the box at speed."""
    rows: list[list[Point]] = []
    for stop in stops:
        if rows and abs(rows[-1][0][1] - stop[1]) < 1e-9:
            rows[-1].append(stop)
        else:
            rows.append([stop])
    out = []
    for row in rows:
        first, last = row[0], row[-1]
        direction = 1.0 if last[0] >= first[0] else -1.0
        out.append(((first[0] - direction * view_width / 2.0, first[1]), (last[0] + direction * view_width / 2.0, last[1])))
    return out


def fly_scan(
    look: BoardLook,
    mover,
    rows: list[tuple[Point, Point]],
    offset: Point,
    roll: float,
    history: PlaceHistory,
    speed: float,
    stopped: Callable[[], bool],
    on_row: Callable[[int, int], None],
    error: type[Exception],
    record=None,
    box: Box | None = None,
    prior: KnownPlace | None = None,
    picture: tuple[float, float, float] | None = None,
    outline: Box | None = None,
    delay: float | None = None,
) -> Estimate | None:
    """A full scan with the head moving at `speed` (mm/s) along each row
    (`mover.go` to its start, at rest; `mover.fly(end, speed)` begun, the
    head going on its own; `mover.arrived()` once there). Each frame is
    placed where `history` (the head's reported places) puts the head when
    it was taken, less the camera's delay first guessed (`delay`, else the
    posterior's DELAY_S), with the head's velocity, for the posterior to
    fit the delay; the mosaic gets a picture every FLY_TILE_SHARE of a
    picture's width. The place found once every row was flown, or None."""
    from .posterior import DELAY_S

    late = DELAY_S if delay is None else delay
    look.begin_record(record)
    look.restart(box, prior, flying=True)
    look.searching = True
    if look.job is not None:
        look.mosaic.begin(look.job, [round(v, 4) for v in outline] if outline is not None else None, "fly")
    spacing = FLY_TILE_SHARE * picture[0] * picture[2] if picture is not None else math.inf
    # When the head set off along the row now flown: a frame from before is
    # of the move to the row's start, at rapid speed and blurred.
    flying_since: float | None = None

    def place(captured: float) -> PictureFrame | str:
        moment = captured - late
        if flying_since is None or moment < flying_since:
            return "the head was not on a row yet"
        found = history.at(moment)
        if found is None:
            return "the head's place is not known for that moment"
        point, velocity = found
        if math.hypot(*velocity) > 1.5 * speed:
            return "the head went faster than the row's speed"
        return PictureFrame((point[0] + offset[0], point[1] + offset[1]), roll, False, velocity)

    flown = 0
    try:
        for index, (start, end) in enumerate(rows):
            on_row(index, len(rows))
            head_start = (start[0] - offset[0], start[1] - offset[1])
            head_end = (end[0] - offset[0], end[1] - offset[1])
            if record is not None:
                record.stop = index
                record.event("row", index=index, start=_rounded(start), end=_rounded(end), speed=round(speed, 3))
            flying_since = None
            mover.go(head_start)
            _reset(look, None)
            mover.fly(head_end, speed)
            flying_since = time.monotonic()
            last_tile: Point | None = None
            while True:
                if stopped():
                    raise error("stopped")
                look.sample(place)
                look.publish()
                if picture is not None:
                    latest = history.latest()
                    if latest is not None and (last_tile is None or math.dist(latest, last_tile) >= spacing):
                        try:
                            meta, jpeg = look.client.frame(width=640, overlay=False, quality=75)
                        except Exception:  # a picture never stops a scan
                            meta, jpeg = {}, b""
                        age = meta.get("age_ms")
                        where = place(time.monotonic() - (float(age) / 1000.0 if _number(age) else 0.0))
                        width, height = meta.get("width"), meta.get("height")
                        if jpeg and isinstance(where, PictureFrame) and isinstance(width, int) and isinstance(height, int) and width > 0:
                            look.mosaic.add_jpeg(jpeg, width, height, where.center, roll, False, picture[2], picture[0])
                            last_tile = latest
                if mover.arrived():
                    break
                time.sleep(SAMPLE_SECONDS / 2.0)
            flown = index + 1
            if record is not None:
                record.event("row_end", index=index)
        consensus = look.consensus
        found = consensus.best if consensus.found else None
        look.mosaic.finish(found.to_dict() if found is not None else None)
        if found is not None:
            look.remember_found(found)
        look.publish(force=True)
        extra = {"delay": consensus.delay} if getattr(consensus, "delay", None) is not None else {}
        look.end_record("found" if found is not None else "not found", only=record, estimate=found.to_dict() if found is not None else None, visited=flown, scan=True, **extra)
        return found
    except BaseException as exc:
        look.end_record("stopped" if stopped() else "error", only=record, message=str(exc) or type(exc).__name__, visited=flown, scan=True)
        raise
    finally:
        look.searching = False
        look._stop_near = None


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


def search_extra(box: Box, start: Point, stops: list[Point], view_width: float, view_height: float, known: KnownPlace | None = None) -> dict:
    """A search's box, the picture's center it started from, its stops, the
    picture's size on the machine (mm) and the known place it was told,
    for its record."""
    return {
        "box": [round(value, 4) for value in box],
        "start": _rounded(start),
        "stops": [_rounded(stop) for stop in stops],
        "view_mm": [round(view_width, 4), round(view_height, 4)],
        "known": known.to_dict() if known is not None else None,
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
    options = look.options() if look is not None else {}
    method = "posterior" if options.get("method") == "posterior" else "vote"
    return {
        "method": method,
        "stretch": bool(options.get("stretch")) and method == "posterior",
        "agree_mm": AGREE_MM,
        "agree_deg": AGREE_DEG,
        "min_match": MIN_MATCH,
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
    if consensus.method == "posterior":
        from .posterior import posterior_fields

        fields["consensus"].update(posterior_fields(consensus))
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


def scan_text(found: Estimate | None, consensus: Consensus, stops: int) -> str:
    """The line said when a full scan ends."""
    if found is None:
        return (
            f"scan done: {stops} pictures of the board, and the look calls no place found;"
            " the mosaic shows them, check the board's side and finish, or lower the threshold"
        )
    return f"scan done: {stops} pictures; " + found_text(found, consensus)


def _reset(look: BoardLook, near: dict | None = None) -> bool:
    """pcbv forgets the pose it tracked: the head moved, so it searches the
    new picture afresh rather than coasting on the old one, or a guess
    wants a lock of another search. With `near` (near_fields) its searches
    try the poses near a known place first until the next reset: whether
    it took it, which a pcbv built before it could does not say."""
    look.resets += 1
    look._stop_near = near
    try:
        reply = look.client.request("reset", **({"near": near} if near is not None else {}))
    except VisionError as exc:
        if dead_camera(str(exc)):
            look.failure = str(exc)
        log.warning("board look: reset: %s", exc)
        return False
    except AttributeError:
        return False
    return near is not None and isinstance(reply, dict) and reply.get("near") is True


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

    def fly(self, point: Point, speed: float) -> None:
        """Begins a straight board line to `point` at `speed` mm/s, the
        beam off (`cut` at S0), and returns while the head moves: a flying
        scan's row. `arrived` says when the head stands there."""
        streamer = self.access.streamer
        joint = streamer.start_of(self._status)
        here = streamer.board_of(joint)
        lines = []
        for kind, _, to_joint, _, _ in streamer._path_moves([here, point], joint):
            lines.append(streamer.cut_line(to_joint, speed * 60.0, 0, None) if kind == "cut" else f"go {streamer.words(to_joint)}")
        for line in lines:
            self._line(line)
        self._target = point
        self._flying = time.monotonic()

    def arrived(self) -> bool:
        """The head stands at the end of the row `fly` began (the machine
        Idle there, a moment after the lines went out). A machine that
        reset since the search began, or raised an alarm, never gets there:
        the search's error, as a move's settle raises it."""
        if time.monotonic() - getattr(self, "_flying", 0.0) < 0.3:
            return False
        link = self.access.link
        if link.restarts != self._restarts:
            raise self._error("the machine reset during the search")
        status = link.status
        if status is not None and status.state == "Alarm":
            raise self._error(f"the machine raised an alarm: {status.raw}")
        if status is None or status.state != "Idle":
            return False
        head_point = self.access.head_point
        assert head_point is not None
        self._status = status
        return math.dist(head_point(status), self._target) < 0.1

    def halt(self) -> None:
        self._halt()

    def _line(self, line: str) -> None:
        if self._stopped():
            raise self._error("stopped")
        self.access.link.request_ok(line)

    def _settle(self, seconds: float):
        return settle(self.access.link, seconds, self._restarts, self._stopped, self._error, "the search")
