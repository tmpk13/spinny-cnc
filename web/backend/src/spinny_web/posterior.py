"""A probability over where a board lies on the machine, updated by every
picture a camera's look takes: the second way a look can call a board found
(a camera's look_method `posterior`), beside the vote among guesses
(boardlook.Consensus, `vote`).

The state is the board's pose on the machine: its turn and where its middle
lies; with board stretch on, also its X and Y scale and its shear; on a
flying scan, also the camera's delay. Each place a picture was taken from is
a view: where the picture's center lay on the machine, the picture's size
and scale, and the candidate poses pcbv put the board at in it, each with
how well it matched. A view says two things:

- a candidate is where the board may be: true with a chance that grows with
  its match, else one of the few false ones a picture gives (a pitch off on
  a repeated pattern, a chance fit);
- no candidate near a pose says the board is not there, as strongly as that
  pose would have put the board's pads and holes in the picture: an empty
  picture lowers every pose that would have shown features in it, a picture
  half off the board's edge lowers only the poses that put many of them in.

The probability is kept in parts. Each place the candidates of one or more
views agree on is a hypothesis: a Gaussian about its best fit, weighed by
the probability's mass there (Laplace's approximation of the evidence). The
rest, where nothing has looked yet, is a set of poses drawn from the prior,
each weighed by how much the views say the board is not there. A candidate
no hypothesis explains starts one of its own: any candidate may be false, so
a wrong one is a small hypothesis beside the right one instead of bending
its fit.

The board is found when the most likely hypothesis holds at least the
camera's threshold of the probability, more than any other, its spread (one
standard deviation) within the agreement the vote asks of its looks
(AGREE_MM, AGREE_DEG), from as many independent pcbv searches as the vote
needs locks. Corners taken by hand are evidence of their own: a hypothesis
that puts one further than the camera's corner_mm from where it was taken is
told as ruled out, and weighs next to nothing.

Repeated searches of one picture are one view: their candidates are pooled,
the best match of each kept, so a lock tracked or found again from the same
picture never counts as a second picture.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Callable, TypeGuard

import numpy as np

from .boardlook import (
    AGREE_DEG,
    AGREE_MM,
    AMBIGUOUS,
    EDGE_DEG,
    GUESSES,
    SESSIONS,
    Consensus,
    Corner,
    Estimate,
    Guess,
    KnownPlace,
    PictureFrame,
    match_of,
    pose_estimate,
    rival_of,
)

Point = tuple[float, float]
Box = tuple[float, float, float, float]

# How likely a view is to give a candidate at the board's true pose: at most
# P_MAX, less the fewer of the board's features the pose puts in the picture
# (1 - 1/e of it with FEATURES_HALF of them in view).
P_MAX = 0.9
FEATURES_HALF = 6.0
# A view the board is under gives a candidate even where the board's own
# features list says little (pcbv's model holds islands the list does not):
# its chance is never taken under this.
P_FLOOR = 0.05
# A search checks the most likely hypothesis from another place once it
# holds this share of the probability and leads (worth_checking).
LIKELY = 0.25
# False candidates a view gives, on average, spread over the board's points
# and every turn.
CLUTTER = 2.0
# A candidate's match against the matches of false ones: exp(MATCH_SLOPE *
# (match - MATCH_EVEN)) times as likely true, half that for one that did not
# pass pcbv's checks for a lock. A logistic fit of right against wrong locks
# on a LumenPnP's survey of a populated board (98 locks, the scale within
# 3%: cross-validated AUC 0.965; the lock's rms and scale added nothing).
# Replayed over two sessions' 49 records it called 2 more boards found, one
# whole-bed search 50 s sooner, and held the wrong places of three searches
# at a tenth of what the earlier (match / 0.5) ** 4 gave them.
MATCH_EVEN = 0.65
MATCH_SLOPE = 15.0
FAILED = 0.5
# How well a candidate places the picture: the head's place from one picture
# to the next (mm; the camera's offset is off the same for every picture,
# which moves the whole board and nothing else) and the camera's roll
# (degrees), one standard deviation, and the least fit error taken from pcbv.
PLACE_MM = 0.05
ROLL_DEG = 0.3
MIN_RMS_MM = 0.05
# Features this close to the picture's edge, as a share of its width or
# height, are not counted as in view.
EDGE_SHARE = 0.04
# The most features weighed (a board's pads can run to thousands; a fixed
# subsample stands for the rest), and the pitch of the stand-in grid over
# the outline for a board whose features are not known.
MAX_FEATURES = 400
GRID_MM = 2.5
# Poses drawn from the prior for where nothing has looked yet.
DIFFUSE = 1500
# The prior: a known place holds KNOWN_SHARE of it about it, the search box
# the rest but FAR, and FAR is spread over a square FAR_SIDE_MM on a side
# (at least FAR_TIMES the box) about the box, so a board outside the box
# is still found from enough views.
KNOWN_SHARE = 0.7
FAR = 0.1
FAR_SIDE_MM = 400.0
FAR_TIMES = 4.0
# A corner taken by hand is wrong this often; its place is good to half the
# camera's corner_mm (one standard deviation), a corner's edges' turn to
# half of EDGE_DEG.
CORNER_WRONG = 0.02
# A candidate belongs to a hypothesis when it lies within this squared
# Mahalanobis distance of what the hypothesis predicts (chi-square, three
# degrees of freedom, 0.999); two hypotheses this close are one.
GATE = 16.27
# The most hypotheses kept, the most likely.
MAX_HYPOTHESES = 40
# Board stretch: the X and Y scale within the fab's tolerance of 1, and the
# shear (degrees off square), one standard deviation.
SCALE_SIGMA = 0.002
SHEAR_SIGMA_DEG = 0.1
# A flying scan's camera delay: how long before pcbv gets a frame it was
# taken, s, as first guessed and how far off that may be.
DELAY_S = 0.08
DELAY_SIGMA_S = 0.06
# A hypothesis holding this much of the probability is the peak: the page
# says the probability is a Gaussian about it rather than spread over places.
DOMINANT = 0.9
# A place's views are one view within this, mm, and degrees of roll.
VIEW_MM = 0.05
VIEW_DEG = 0.1

LOG_2PI = math.log(2.0 * math.pi)


def _wrap_rad(value: float) -> float:
    return (value + math.pi) % (2.0 * math.pi) - math.pi


def _number(value) -> TypeGuard[int | float]:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _point(value) -> Point | None:
    if isinstance(value, (list, tuple)) and len(value) == 2 and all(_number(v) for v in value):
        return (float(value[0]), float(value[1]))
    return None


def _logsumexp(values: list[float]) -> float:
    top = max(values)
    if top == -math.inf:
        return -math.inf
    return top + math.log(sum(math.exp(v - top) for v in values))


def detection(features) -> np.ndarray:
    """How likely a view is to give a candidate at the board's pose when
    that pose puts `features` of the board's pads and holes in its picture."""
    return P_MAX * (1.0 - np.exp(-np.asarray(features, dtype=float) / FEATURES_HALF))


def _detection(features: float) -> float:
    """detection for one count, without numpy's cost for a scalar."""
    return P_MAX * (1.0 - math.exp(-float(features) / FEATURES_HALF))


def strength(match: float, passed: bool = True) -> float:
    """How many times likelier a candidate of this match is the board than a
    false one."""
    return math.exp(MATCH_SLOPE * (min(max(match, 0.0), 1.0) - MATCH_EVEN)) * (1.0 if passed else FAILED)


@dataclass
class Board:
    """What the probability knows of the board: its middle and its
    outline's box (the job's frame), and points standing for its pads and
    holes there, each counting `weight` features."""

    middle: Point
    outline: Box | None
    features: np.ndarray
    weight: float = 1.0

    @classmethod
    def of(cls, middle: Point, outline: Box | None, points: list[Point] | None = None) -> Board:
        """The board from its pads' and holes' points, a fixed subsample of
        at most MAX_FEATURES of them; with none, a grid over its outline (a
        typical board's features per area), else over a small square."""
        pts = np.array([p for p in (points or []) if _point(p) is not None], dtype=float).reshape(-1, 2)
        weight = 1.0
        if len(pts) == 0:
            x0, y0, x1, y1 = outline if outline is not None else (middle[0] - 10.0, middle[1] - 10.0, middle[0] + 10.0, middle[1] + 10.0)
            xs = np.arange(min(x0, x1) + GRID_MM / 2.0, max(x0, x1), GRID_MM)
            ys = np.arange(min(y0, y1) + GRID_MM / 2.0, max(y0, y1), GRID_MM)
            grid = np.array([(x, y) for y in ys for x in xs], dtype=float).reshape(-1, 2)
            pts = grid if len(grid) else np.array([middle], dtype=float)
        if len(pts) > MAX_FEATURES:
            weight = len(pts) / MAX_FEATURES
            pts = pts[np.random.default_rng(0).choice(len(pts), MAX_FEATURES, replace=False)]
        return cls(middle, outline, pts, weight)

    @property
    def area(self) -> float:
        """The board's area on the job's frame, mm^2: its outline's box, else its features' box."""
        if self.outline is not None:
            x0, y0, x1, y1 = self.outline
            return max(abs(x1 - x0) * abs(y1 - y0), 100.0)
        span = self.features.max(axis=0) - self.features.min(axis=0)
        return max(float(span[0] * span[1]), 100.0)

    @property
    def diagonal(self) -> float:
        if self.outline is not None:
            x0, y0, x1, y1 = self.outline
            return max(math.hypot(x1 - x0, y1 - y0), 1.0)
        span = self.features.max(axis=0) - self.features.min(axis=0)
        return max(float(math.hypot(*span)), 1.0)


@dataclass
class Layout:
    """Which parts the state holds: the turn (radians) and the middle's
    place always; X and Y scale and shear (radians off square) with
    stretch; the camera's delay (s) on a flying scan."""

    stretch: bool = False
    delay: bool = False

    @property
    def size(self) -> int:
        return 3 + (3 if self.stretch else 0) + (1 if self.delay else 0)

    @property
    def delay_index(self) -> int | None:
        return self.size - 1 if self.delay else None

    def start(self, theta: float, middle: Point, delay: float = DELAY_S) -> np.ndarray:
        state = [theta, middle[0], middle[1]]
        if self.stretch:
            state += [1.0, 1.0, 0.0]
        if self.delay:
            state.append(delay)
        return np.array(state, dtype=float)

    def extra_prior(self, delay: float = DELAY_S, delay_sigma: float = DELAY_SIGMA_S) -> tuple[np.ndarray, np.ndarray, list[int]]:
        """The prior of the parts past the pose: their means, their standard
        deviations and their indices."""
        means, sigmas, indices = [], [], []
        if self.stretch:
            means += [1.0, 1.0, 0.0]
            sigmas += [SCALE_SIGMA, SCALE_SIGMA, math.radians(SHEAR_SIGMA_DEG)]
            indices += [3, 4, 5]
        if self.delay:
            means.append(delay)
            sigmas.append(delay_sigma)
            indices.append(self.size - 1)
        return np.array(means, dtype=float), np.array(sigmas, dtype=float), indices

    def matrix(self, state: np.ndarray) -> np.ndarray:
        """The board's job frame to the machine's, about its middle: the turn
        times the stretch (X and Y scale, the shear shared out between the
        two axes)."""
        c, s = math.cos(state[0]), math.sin(state[0])
        turn = np.array([[c, -s], [s, c]])
        if not self.stretch:
            return turn
        half = math.tan(state[5]) / 2.0
        return turn @ np.array([[state[3], half], [half, state[4]]])

    def delay_of(self, state: np.ndarray, default: float) -> float:
        index = self.delay_index
        return float(state[index]) if index is not None else default


@dataclass
class Candidate:
    """A pose pcbv put the board at in a view: where it says the board lies
    (an Estimate), its match, whether it passed pcbv's checks for a lock,
    the searches that gave it, and how near pcbv's rival came."""

    estimate: Estimate
    match: float
    passed: bool
    searches: set = field(default_factory=set)
    expected: float = 0.0
    hypothesis: int | None = None

    @property
    def strength(self) -> float:
        return strength(self.match, self.passed)


@dataclass
class View:
    """The pictures taken from one place: the frame (the machine point
    under the picture's center, its roll and mirror, the head's velocity
    when it moved), its size (px) and scale (mm per px), the pcbv searches
    read there, their candidates pooled, and for the poses drawn from the
    prior how much this view says each is not where the board is."""

    index: int
    frame: PictureFrame
    width: float = 0.0
    height: float = 0.0
    scale: float = 0.0
    searches: set = field(default_factory=set)
    pool: list[Candidate] = field(default_factory=list)
    miss: np.ndarray | None = None
    captured: float = 0.0
    # The part of the picture pcbv's board look kept to, shares of its width
    # and height from the top left (crops.py); None for the whole picture.
    crop: tuple | None = None

    @property
    def placed(self) -> bool:
        return self.width > 0.0 and self.height > 0.0 and self.scale > 0.0

    @property
    def observed(self) -> bool:
        return self.placed and bool(self.searches)


@dataclass
class Hypothesis:
    """A place the candidates of one or more views agree on: the state's
    mean and covariance at the best fit, its candidates by view, its log
    evidence and its probability."""

    id: int
    mean: np.ndarray
    cov: np.ndarray
    members: dict[int, Candidate] = field(default_factory=dict)
    log_weight: float = -math.inf
    probability: float = 0.0
    corner_mm: float | None = None
    ruled_out: bool = False


class Posterior(Consensus):
    """The probability over the board's pose, behind the same face as the
    vote (Consensus): `take` reads each pose pcbv reports, `guesses` are the
    hypotheses the most likely first, `found` and `best` say what the look
    says. `box` is where the board's middle is expected (a search's box);
    `known` a place known before (prior, never corners: they are evidence);
    `board` its middle, outline and features; `scale` the camera's mm per
    px for pictures before a lock; `stretch` adds the board's scale and
    shear, `delay` the camera's delay (a flying scan)."""

    method = "posterior"

    def __init__(
        self,
        board: Board,
        box: Box | None = None,
        known: KnownPlace | None = None,
        threshold: float | None = None,
        corner_mm: float | None = None,
        corners: list[Corner] | None = None,
        sessions: int | None = None,
        scale: float | None = None,
        stretch: bool = False,
        delay: tuple[float, float] | None = None,
        agree_mm: float | None = None,
        agree_deg: float | None = None,
        diffuse: int = DIFFUSE,
        seed: int = 1,
        marks: list[tuple[Point, Point]] | None = None,
    ) -> None:
        self.board = board
        # Marks measured for the board (a pad under the tool, a feature the
        # camera centered): evidence as corners are, to a twentieth of a
        # millimeter. Their fit is then no prior of its own.
        self.marks = [Corner("mark", (float(d[0]), float(d[1])), (float(m[0]), float(m[1])), None, "mark") for d, m in (marks or [])]
        if self.marks and known is not None and known.source == "align":
            known = None
        self.layout = Layout(stretch=stretch, delay=delay is not None)
        self.delay_prior = delay or (DELAY_S, DELAY_SIGMA_S)
        self.scale = float(scale) if scale and scale > 0.0 else 0.0
        self._scale_given = self.scale > 0.0
        # The board crop the look keeps to (BoardLook sets it), given to
        # each view as it is made.
        self.crop: tuple | None = None
        self.known = known
        self._box_given = box
        self._diffuse_count = int(diffuse)
        self._seed = seed
        super().__init__(board.middle, need=1, agree_mm=agree_mm, agree_deg=agree_deg, threshold=threshold, corner_mm=corner_mm, corners=corners, sessions=sessions)
        # One view can call the board found, from as many pcbv searches as
        # the vote asks locks of (the vote caps them at its looks).
        self.sessions = max(1, SESSIONS if sessions is None else int(sessions))
        # Its stops end on pcbv's searches with the scale known (StopEnd).
        self.numbers_searches = self._scale_given

    # --- state kept ---------------------------------------------------------------

    def reset(self) -> None:
        super().reset()
        self.views: list[View] = []
        self._view_keys: dict[tuple, int] = {}
        self.hypotheses: list[Hypothesis] = []
        self._next_id = 0
        self._searches = 0
        self._acquisitions: set = set()
        # The view the newest pose brought a search to and that search's
        # key (_search_of); None when it brought none (counted_search).
        self._counted: tuple[int, tuple] | None = None
        self.log_elsewhere = 0.0
        self.elsewhere = 1.0
        self._box = self._box_given
        self._diffuse: np.ndarray | None = None
        self._diffuse_log: np.ndarray | None = None
        self._miss_total: np.ndarray | None = None
        # Each hypothesis' features in each view, while its fit stays:
        # its id to (its mean's bytes, view index to (the view's size and
        # scale when counted, the count)).
        self._seen: dict[int, tuple[bytes, dict[int, tuple[tuple, float]]]] = {}
        if self._box is not None:
            self._draw()

    def _default_box(self, center: Point) -> Box:
        half = self.board.diagonal / 2.0
        return (center[0] - half, center[1] - half, center[0] + half, center[1] + half)

    # --- the prior -----------------------------------------------------------------

    def _parts(self, for_drawing: bool) -> list[tuple[float, str, tuple]]:
        """The prior's parts as (share, kind, parameters): the known place
        as a spread about it, the box, the far square. Drawn from (not
        weighed), corners taken add their rough place: where nothing has
        looked yet is then sampled there too."""
        assert self._box is not None
        x0, y0, x1, y1 = self._box
        box = (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))
        side = max(FAR_SIDE_MM, FAR_TIMES * max(box[2] - box[0], box[3] - box[1]))
        cx, cy = (box[0] + box[2]) / 2.0, (box[1] + box[3]) / 2.0
        far = (cx - side / 2.0, cy - side / 2.0, cx + side / 2.0, cy + side / 2.0)
        parts: list[tuple[float, str, tuple]] = []
        rest = 1.0 - FAR
        if self.known is not None:
            known = self.known
            sigma = max(known.within_mm / 2.0, 0.05)
            turn = (math.radians(known.place.rotation), math.radians(known.within_deg / 2.0)) if known.within_deg is not None else None
            parts.append((rest * KNOWN_SHARE, "gauss", (known.place.center, sigma, turn)))
            rest *= 1.0 - KNOWN_SHARE
        parts.append((rest, "box", (box, None)))
        parts.append((FAR, "box", (far, None)))
        if for_drawing and self._anchors():
            from .boardlook import corners_known

            rough = corners_known(self._anchors(), self.board.middle, self.corner_mm, self.board.diagonal)
            if rough is not None:
                sigma = max(rough.within_mm / 2.0, 0.05)
                turn = (math.radians(rough.place.rotation), math.radians(rough.within_deg / 2.0)) if rough.within_deg is not None else None
                parts = [(share * 0.5, kind, params) for share, kind, params in parts]
                parts.append((0.5, "gauss", (rough.place.center, sigma, turn)))
        return parts

    @staticmethod
    def _part_density(kind: str, params: tuple, theta: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
        if kind == "box":
            (bx0, by0, bx1, by1), _ = params
            area = max((bx1 - bx0) * (by1 - by0), 1e-9)
            inside = (x >= bx0) & (x <= bx1) & (y >= by0) & (y <= by1)
            return np.where(inside, 1.0 / (area * 2.0 * math.pi), 0.0)
        center, sigma, turn = params
        d2 = ((x - center[0]) ** 2 + (y - center[1]) ** 2) / (sigma * sigma)
        place = np.exp(-0.5 * d2) / (2.0 * math.pi * sigma * sigma)
        if turn is None:
            return place / (2.0 * math.pi)
        mean, spread = turn
        dt = (theta - mean + math.pi) % (2.0 * math.pi) - math.pi
        return place * np.exp(-0.5 * (dt / spread) ** 2) / (math.sqrt(2.0 * math.pi) * spread)

    def prior_density(self, theta, x, y) -> np.ndarray:
        """The prior's density at poses (turn in radians, middle in mm)."""
        theta, x, y = np.asarray(theta, dtype=float), np.asarray(x, dtype=float), np.asarray(y, dtype=float)
        total = np.zeros(np.broadcast(theta, x, y).shape)
        for share, kind, params in self._parts(False):
            total = total + share * self._part_density(kind, params, theta, x, y)
        return total

    def _draw(self) -> None:
        """Poses drawn from the prior (with corners, also about their rough
        place), each with its log weight against the prior; the views seen
        so far are weighed on them again."""
        rng = np.random.default_rng(self._seed)
        parts = self._parts(True)
        count = self._diffuse_count
        thetas, xs, ys = [], [], []
        for share, kind, params in parts:
            n = max(1, int(round(share * count)))
            if kind == "box":
                (bx0, by0, bx1, by1), _ = params
                xs.append(rng.uniform(bx0, bx1, n))
                ys.append(rng.uniform(by0, by1, n))
                thetas.append(rng.uniform(-math.pi, math.pi, n))
            else:
                center, sigma, turn = params
                xs.append(rng.normal(center[0], sigma, n))
                ys.append(rng.normal(center[1], sigma, n))
                thetas.append(rng.uniform(-math.pi, math.pi, n) if turn is None else rng.normal(turn[0], turn[1], n))
        theta, x, y = np.concatenate(thetas), np.concatenate(xs), np.concatenate(ys)
        drawn = np.zeros(len(theta))
        for share, kind, params in parts:
            drawn = drawn + share * self._part_density(kind, params, theta, x, y)
        prior = self.prior_density(theta, x, y)
        with np.errstate(divide="ignore"):
            self._diffuse_log = np.log(prior) - np.log(np.maximum(drawn, 1e-300))
        self._diffuse = np.stack([theta, x, y], axis=1)
        self._miss_total = np.zeros(len(theta))
        for view in self.views:
            view.miss = None
            self._weigh_view_diffuse(view)

    # --- what a pose puts in a picture ----------------------------------------------

    def features_in(self, states: np.ndarray, view: View) -> np.ndarray:
        """How many of the board's features each state (rows: turn, middle,
        and the layout's other parts) puts inside the view's picture."""
        states = np.atleast_2d(states)
        layout = self.layout
        theta = states[:, 0]
        c, s = np.cos(theta), np.sin(theta)
        d = self.board.features - np.asarray(self.board.middle)
        if layout.stretch and states.shape[1] >= 6:
            half = np.tan(states[:, 5]) / 2.0
            sx, sy = states[:, 3], states[:, 4]
            jx = sx[:, None] * d[None, :, 0] + half[:, None] * d[None, :, 1]
            jy = half[:, None] * d[None, :, 0] + sy[:, None] * d[None, :, 1]
        else:
            jx = np.broadcast_to(d[None, :, 0], (len(states), len(d)))
            jy = np.broadcast_to(d[None, :, 1], (len(states), len(d)))
        mx = c[:, None] * jx - s[:, None] * jy + states[:, 1][:, None]
        my = s[:, None] * jx + c[:, None] * jy + states[:, 2][:, None]
        cx, cy = view.frame.center
        if layout.delay and states.shape[1] > layout.size - 1:
            delay = states[:, layout.size - 1]
        else:
            delay = np.full(len(states), self.delay_prior[0])
        # A picture taken on the move was placed for the delay first
        # guessed; another delay puts it back or on along the head's way.
        vx, vy = view.frame.velocity
        late = delay - self.delay_prior[0]
        ox = mx - (cx - vx * late)[:, None]
        oy = my - (cy - vy * late)[:, None]
        roll = math.radians(view.frame.roll)
        cr, sr = math.cos(roll), math.sin(roll)
        u = (ox * cr + oy * sr) / view.scale
        v = (-ox * sr + oy * cr) / view.scale
        if view.crop is None:
            hw = view.width / 2.0 * (1.0 - 2.0 * EDGE_SHARE)
            hh = view.height / 2.0 * (1.0 - 2.0 * EDGE_SHARE)
            inside = (np.abs(u) <= hw) & (np.abs(v) <= hh)
        else:
            # Only the crop is looked in: its box in px from the picture's
            # center, right and down (camera.machine_to_picture), the edge
            # share kept off each of its sides.
            x0, y0, x1, y1 = view.crop
            dx = -u if view.frame.mirror else u
            dy = -v
            mx_, my_ = EDGE_SHARE * view.width, EDGE_SHARE * view.height
            inside = (
                (dx >= (x0 - 0.5) * view.width + mx_) & (dx <= (x1 - 0.5) * view.width - mx_)
                & (dy >= (y0 - 0.5) * view.height + my_) & (dy <= (y1 - 0.5) * view.height - my_)
            )
        return inside.sum(axis=1) * self.board.weight

    def _seen_counts(self, hypothesis: Hypothesis) -> dict[int, float]:
        """How many of the board's features the hypothesis' fit puts in
        each observed view's picture, by view index (features_in for its
        mean). Counted for every view a pose is taken in, so they are kept
        while its fit stays and each view's size and scale stay, and the
        views still to count are counted together; a view taken on the
        move goes through features_in, which knows the camera's delay."""
        mean = hypothesis.mean
        key = mean.tobytes()
        cached = self._seen.get(hypothesis.id)
        if cached is None or cached[0] != key:
            cached = (key, {})
            self._seen[hypothesis.id] = cached
        counts = cached[1]
        still: list[View] = []
        for view in self.views:
            if not view.observed:
                continue
            shape = (view.width, view.height, view.scale)
            held = counts.get(view.index)
            if held is not None and held[0] == shape:
                continue
            if view.frame.velocity != (0.0, 0.0):
                counts[view.index] = (shape, float(self.features_in(mean, view)[0]))
            else:
                still.append(view)
        if still:
            mx, my = self._feature_places(mean)
            centers = np.array([view.frame.center for view in still])
            rolls = np.radians([view.frame.roll for view in still])
            scales = np.array([view.scale for view in still])
            cr, sr = np.cos(rolls)[:, None], np.sin(rolls)[:, None]
            ox = mx[None, :] - centers[:, 0:1]
            oy = my[None, :] - centers[:, 1:2]
            u = (ox * cr + oy * sr) / scales[:, None]
            v = (-ox * sr + oy * cr) / scales[:, None]
            hw = np.array([view.width for view in still])[:, None] / 2.0 * (1.0 - 2.0 * EDGE_SHARE)
            hh = np.array([view.height for view in still])[:, None] / 2.0 * (1.0 - 2.0 * EDGE_SHARE)
            inside = ((np.abs(u) <= hw) & (np.abs(v) <= hh)).sum(axis=1) * self.board.weight
            for view, count in zip(still, inside):
                counts[view.index] = ((view.width, view.height, view.scale), float(count))
        if len(self._seen) > 4 * MAX_HYPOTHESES:
            alive = {h.id for h in self.hypotheses}
            self._seen = {ident: held for ident, held in self._seen.items() if ident in alive}
        return {index: held[1] for index, held in counts.items()}

    def _feature_places(self, state: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Where one state (turn, middle and the layout's other parts) puts
        the board's features on the machine, as features_in does."""
        theta = float(state[0])
        c, s = math.cos(theta), math.sin(theta)
        d = self.board.features - np.asarray(self.board.middle)
        if self.layout.stretch and len(state) >= 6:
            half = math.tan(float(state[5])) / 2.0
            jx = float(state[3]) * d[:, 0] + half * d[:, 1]
            jy = half * d[:, 0] + float(state[4]) * d[:, 1]
        else:
            jx, jy = d[:, 0], d[:, 1]
        return c * jx - s * jy + float(state[1]), s * jx + c * jy + float(state[2])

    def _weigh_view_diffuse(self, view: View) -> None:
        """What a view says of the poses drawn from the prior: the log of
        its chance to have given no candidate at each."""
        if self._diffuse is None or not view.observed or view.miss is not None:
            return
        states = self._diffuse
        if self.layout.size > 3:
            extra = np.tile(self.layout.start(0.0, (0.0, 0.0), self.delay_prior[0])[3:], (len(states), 1))
            states = np.concatenate([states, extra], axis=1)
        p = detection(self.features_in(states, view))
        view.miss = np.log1p(-np.minimum(p, 0.999999))
        assert self._miss_total is not None
        self._miss_total = self._miss_total + view.miss

    # --- the measurement ------------------------------------------------------------------

    def predict(self, state: np.ndarray, view: View) -> np.ndarray:
        """What a candidate in the view measures if the state is right: the
        job's point under the picture's center and the board's turn."""
        layout = self.layout
        matrix = layout.matrix(state)
        late = layout.delay_of(state, self.delay_prior[0]) - self.delay_prior[0]
        vx, vy = view.frame.velocity
        center = np.array([view.frame.center[0] - vx * late, view.frame.center[1] - vy * late])
        # The 2 by 2 solve written out: called for every candidate of every
        # hypothesis at every pose, numpy's solve cost most of a replay.
        a, b, c, d = float(matrix[0][0]), float(matrix[0][1]), float(matrix[1][0]), float(matrix[1][1])
        rx, ry = float(center[0] - state[1]), float(center[1] - state[2])
        det = a * d - b * c
        middle = self.board.middle
        return np.array([(d * rx - b * ry) / det + middle[0], (a * ry - c * rx) / det + middle[1], state[0]])

    def _measurement(self, candidate: Candidate, view: View) -> tuple[np.ndarray, np.ndarray]:
        """A candidate as a measurement (the job's point under the picture's
        center, the turn in radians) and its noise covariance: its fit's
        error and the picture's place on the machine for the point, the
        fit's error over the picture's reach and the camera's roll for the turn."""
        estimate = candidate.estimate
        seen = estimate.seen if estimate.seen is not None else estimate.unapply(view.frame.center)
        fit = max(estimate.rms, MIN_RMS_MM)
        sigma_p = math.hypot(fit, PLACE_MM)
        reach = 0.5 * math.hypot(view.width, view.height) * view.scale if view.placed else 10.0
        sigma_t = math.hypot(fit / max(reach, 1.0), math.radians(ROLL_DEG))
        z = np.array([seen[0], seen[1], math.radians(estimate.rotation)])
        return z, np.diag([sigma_p * sigma_p, sigma_p * sigma_p, sigma_t * sigma_t])

    def _jacobian(self, func: Callable[[np.ndarray], np.ndarray], state: np.ndarray) -> np.ndarray:
        steps = np.array([1e-6, 1e-4, 1e-4] + [1e-6] * (len(state) - 3))
        if self.layout.delay:
            steps[-1] = 1e-5
        columns = []
        for i, step in enumerate(steps):
            up, down = state.copy(), state.copy()
            up[i] += step
            down[i] -= step
            diff = func(up) - func(down)
            if len(diff) >= 3:
                diff[2] = _wrap_rad(diff[2])
            columns.append(diff / (2.0 * step))
        return np.stack(columns, axis=1)

    @staticmethod
    def _residual(z: np.ndarray, predicted: np.ndarray) -> np.ndarray:
        r = z - predicted
        r[2] = _wrap_rad(r[2])
        return r

    def _corner_terms(self, corner: Corner) -> tuple[Callable[[np.ndarray], np.ndarray], np.ndarray, np.ndarray]:
        """A corner taken as a measurement: where the state puts it on the
        machine (and the board's turn, from a corner by its edges), what was
        taken, and the noise."""
        sigma = self._sigma(corner)
        middle = np.asarray(self.board.middle)
        job = np.asarray(corner.job)
        edges = corner.angle is not None

        def place(state: np.ndarray) -> np.ndarray:
            point = self.layout.matrix(state) @ (job - middle) + state[1:3]
            return np.array([point[0], point[1], state[0]]) if edges else point

        if edges:
            z = np.array([corner.machine[0], corner.machine[1], math.radians(corner.angle or 0.0)])
            noise = np.diag([sigma * sigma, sigma * sigma, math.radians(EDGE_DEG / 2.0) ** 2])
        else:
            z = np.array(corner.machine)
            noise = np.diag([sigma * sigma, sigma * sigma])
        return place, z, noise

    def _anchors(self) -> list[Corner]:
        """The points measured on the board besides the pictures: corners
        taken, then marks."""
        return self.corners + self.marks

    def _sigma(self, anchor: Corner) -> float:
        """How well a corner (half the camera's corner_mm) or a mark places its point, mm."""
        return MARK_MM if anchor.by == "mark" else max(self.corner_mm / 2.0, 0.01)

    def _corner_log(self, state: np.ndarray, area: float) -> tuple[float, float, list[int]]:
        """The corners' and marks' log factor at a state (each a Gaussian
        about where it was taken, or wrong), the furthest the state puts a
        corner from where it was taken (mm), and which of them (indices
        into _anchors) are within the gate."""
        total, furthest, used = 0.0, 0.0, []
        for index, corner in enumerate(self._anchors()):
            place, z, noise = self._corner_terms(corner)
            predicted = place(state)
            r = z - predicted
            if len(r) == 3:
                r[2] = _wrap_rad(r[2])
            if corner.by != "mark":
                furthest = max(furthest, float(math.hypot(r[0], r[1])))
            d2 = float(r @ np.linalg.solve(noise, r))
            log_gauss = -0.5 * (d2 + len(r) * LOG_2PI + math.log(np.linalg.det(noise)))
            wrong = math.log(CORNER_WRONG / area) - (math.log(2.0 * math.pi) if len(r) == 3 else 0.0)
            total += float(np.logaddexp(math.log(1.0 - CORNER_WRONG) + log_gauss, wrong))
            if d2 < GATE:
                used.append(index)
        return total, furthest, used

    # --- fitting a hypothesis -------------------------------------------------------------

    def _fit(self, hypothesis: Hypothesis) -> None:
        """The hypothesis' state at its best fit to its candidates (and the
        corners within the gate, and the prior of the stretch and delay),
        Gauss-Newton from where it was, and its covariance there."""
        state = hypothesis.mean.copy()
        means, sigmas, indices = self.layout.extra_prior(*self.delay_prior)
        normal = np.eye(len(state))
        for _ in range(8):
            rows, residuals = [], []
            for view_index, candidate in hypothesis.members.items():
                view = self.views[view_index]
                z, noise = self._measurement(candidate, view)
                predicted = self.predict(state, view)
                jac = self._jacobian(lambda s, v=view: self.predict(s, v), state)
                weight = 1.0 / np.sqrt(np.diag(noise))
                rows.append(jac * weight[:, None])
                residuals.append(self._residual(z, predicted) * weight)
            anchors = self._anchors()
            if anchors:
                _, _, used = self._corner_log(state, self._box_area())
                for index in used:
                    place, z, noise = self._corner_terms(anchors[index])
                    predicted = place(state)
                    r = z - predicted
                    if len(r) == 3:
                        r[2] = _wrap_rad(r[2])
                    jac = self._jacobian(place, state)
                    weight = 1.0 / np.sqrt(np.diag(noise))
                    rows.append(jac * weight[:, None])
                    residuals.append(r * weight)
            for mean, sigma, index in zip(means, sigmas, indices):
                row = np.zeros(len(state))
                row[index] = 1.0 / sigma
                rows.append(row[None, :])
                residuals.append(np.array([(mean - state[index]) / sigma]))
            jac_all = np.concatenate(rows, axis=0)
            res_all = np.concatenate(residuals)
            normal = jac_all.T @ jac_all + np.eye(len(state)) * 1e-12
            step = np.linalg.solve(normal, jac_all.T @ res_all)
            state = state + step
            state[0] = _wrap_rad(state[0])
            if np.all(np.abs(step) < 1e-9):
                break
        hypothesis.mean = state
        hypothesis.cov = np.linalg.inv(normal)

    def _gate(self, hypothesis: Hypothesis, candidate: Candidate, view: View) -> float:
        """The squared Mahalanobis distance between a candidate and what the
        hypothesis predicts it to be."""
        z, noise = self._measurement(candidate, view)
        predicted = self.predict(hypothesis.mean, view)
        jac = self._jacobian(lambda s: self.predict(s, view), hypothesis.mean)
        innovation = jac @ hypothesis.cov @ jac.T + noise
        r = self._residual(z, predicted)
        return float(r @ np.linalg.solve(innovation, r))

    def _birth(self, candidate: Candidate, view_index: int) -> Hypothesis:
        estimate = candidate.estimate
        mean = self.layout.start(math.radians(estimate.rotation), estimate.center, self.delay_prior[0])
        hypothesis = Hypothesis(self._next_id, mean, np.eye(len(mean)), {view_index: candidate})
        self._next_id += 1
        self._fit(hypothesis)
        return hypothesis

    def _place(self, candidate: Candidate, view_index: int) -> None:
        """A candidate joins the hypothesis that explains it best (one per
        view each: the better of two kept), or starts one of its own."""
        view = self.views[view_index]
        best: tuple[float, Hypothesis] | None = None
        for hypothesis in self.hypotheses:
            d2 = self._gate(hypothesis, candidate, view)
            if d2 < GATE and (best is None or d2 < best[0]):
                best = (d2, hypothesis)
        if best is None:
            hypothesis = self._birth(candidate, view_index)
            candidate.hypothesis = hypothesis.id
            self.hypotheses.append(hypothesis)
            return
        hypothesis = best[1]
        held = hypothesis.members.get(view_index)
        if held is not None and held is not candidate:
            if held.strength >= candidate.strength:
                candidate.hypothesis = hypothesis.id
                return
            held.hypothesis = None
        hypothesis.members[view_index] = candidate
        candidate.hypothesis = hypothesis.id
        self._fit(hypothesis)

    def _merge(self) -> None:
        """Hypotheses that came to lie within the gate of one another are one."""
        merged = True
        while merged:
            merged = False
            for i, a in enumerate(self.hypotheses):
                for b in self.hypotheses[i + 1:]:
                    diff = a.mean[:3] - b.mean[:3]
                    diff[0] = _wrap_rad(diff[0])
                    joint = a.cov[:3, :3] + b.cov[:3, :3]
                    # The distance over the joint spread's trace is no more
                    # than the gated one: pairs far apart need no solve.
                    if float(diff @ diff) >= GATE * float(np.trace(joint)) or float(diff @ np.linalg.solve(joint, diff)) >= GATE:
                        continue
                    keep, gone = (a, b) if len(a.members) >= len(b.members) else (b, a)
                    for view_index, candidate in gone.members.items():
                        held = keep.members.get(view_index)
                        if held is None or candidate.strength > held.strength:
                            keep.members[view_index] = candidate
                        candidate.hypothesis = keep.id
                    self._fit(keep)
                    self.hypotheses.remove(gone)
                    merged = True
                    break
                if merged:
                    break

    # --- the evidence --------------------------------------------------------------------

    def _box_area(self) -> float:
        if self._box is None:
            return max(self.board.diagonal ** 2, 1.0)
        x0, y0, x1, y1 = self._box
        return max(abs(x1 - x0) * abs(y1 - y0), 1.0)

    def _evidence(self, hypothesis: Hypothesis) -> float:
        """The log of the probability's mass the hypothesis holds, unnormed:
        the prior at its fit, each of its views' candidates against the
        false ones a view gives, each other view's chance to have missed it,
        the corners, and the spread of its fit."""
        mean = hypothesis.mean
        prior = float(self.prior_density(mean[0], mean[1], mean[2]))
        if prior <= 0.0:
            return -math.inf
        clutter = CLUTTER / (self.board.area * 2.0 * math.pi)
        total = math.log(prior)
        seen_by_view = self._seen_counts(hypothesis)
        for view in self.views:
            if not view.observed:
                continue
            seen = seen_by_view[view.index]
            candidate = hypothesis.members.get(view.index)
            if candidate is None:
                total += math.log1p(-min(_detection(seen), 0.999999))
                continue
            p = max(_detection(max(seen, candidate.expected)), P_FLOOR)
            z, noise = self._measurement(candidate, view)
            r = self._residual(z, self.predict(mean, view))
            # The measurement's noise is diagonal (_measurement).
            variances = np.diag(noise)
            log_kernel = -0.5 * (float((r * r / variances).sum()) + 3.0 * LOG_2PI + float(np.log(variances).sum()))
            total += math.log(p) + math.log(max(candidate.strength, 1e-12)) - math.log(clutter) + log_kernel
        if self._anchors():
            corner_log, furthest, _ = self._corner_log(mean, self._box_area())
            total += corner_log
            hypothesis.corner_mm = furthest if self.corners else None
            hypothesis.ruled_out = bool(self.corners) and furthest > self.corner_mm
        else:
            hypothesis.corner_mm = None
            hypothesis.ruled_out = False
        means, sigmas, indices = self.layout.extra_prior(*self.delay_prior)
        for m, sigma, index in zip(means, sigmas, indices):
            total += -0.5 * (((mean[index] - m) / sigma) ** 2 + LOG_2PI) - math.log(sigma)
        sign, logdet = np.linalg.slogdet(hypothesis.cov)
        if sign > 0:
            total += 0.5 * (len(mean) * LOG_2PI + logdet)
        return total

    def _elsewhere(self) -> float:
        """The log of the probability's mass where no hypothesis is: the
        poses drawn from the prior, weighed by every view's chance to have
        missed the board there and by the corners."""
        if self._diffuse is None or self._diffuse_log is None or self._miss_total is None:
            return 0.0
        logs = self._diffuse_log + self._miss_total
        if self._anchors():
            area = self._box_area()
            for corner in self._anchors():
                logs = logs + self._diffuse_corner(corner, area)
        top = float(np.max(logs))
        if not math.isfinite(top):
            return -math.inf
        return top + math.log(float(np.mean(np.exp(logs - top))))

    def _diffuse_corner(self, corner: Corner, area: float) -> np.ndarray:
        assert self._diffuse is not None
        theta, x, y = self._diffuse[:, 0], self._diffuse[:, 1], self._diffuse[:, 2]
        jx, jy = corner.job[0] - self.board.middle[0], corner.job[1] - self.board.middle[1]
        px = np.cos(theta) * jx - np.sin(theta) * jy + x
        py = np.sin(theta) * jx + np.cos(theta) * jy + y
        sigma = self._sigma(corner)
        d2 = ((px - corner.machine[0]) ** 2 + (py - corner.machine[1]) ** 2) / (sigma * sigma)
        log_gauss = -0.5 * d2 - math.log(2.0 * math.pi * sigma * sigma)
        wrong = math.log(CORNER_WRONG / area)
        if corner.angle is not None:
            spread = math.radians(EDGE_DEG / 2.0)
            dt = (theta - math.radians(corner.angle) + math.pi) % (2.0 * math.pi) - math.pi
            log_gauss = log_gauss - 0.5 * (dt / spread) ** 2 - math.log(math.sqrt(2.0 * math.pi) * spread)
            wrong -= math.log(2.0 * math.pi)
        return np.logaddexp(math.log(1.0 - CORNER_WRONG) + log_gauss, wrong)

    def _weigh_all(self) -> None:
        """Every hypothesis' share and the rest's; the least likely let go
        past MAX_HYPOTHESES; the guesses the page shows made of them."""
        for hypothesis in self.hypotheses:
            hypothesis.log_weight = self._evidence(hypothesis)
        self.hypotheses.sort(key=lambda h: -h.log_weight)
        for gone in self.hypotheses[MAX_HYPOTHESES:]:
            for candidate in gone.members.values():
                candidate.hypothesis = -1
        del self.hypotheses[MAX_HYPOTHESES:]
        self.log_elsewhere = self._elsewhere()
        logs = [self.log_elsewhere] + [h.log_weight for h in self.hypotheses]
        total = _logsumexp(logs)
        if not math.isfinite(total):
            self.elsewhere = 1.0
            for hypothesis in self.hypotheses:
                hypothesis.probability = 0.0
        else:
            self.elsewhere = math.exp(self.log_elsewhere - total) if math.isfinite(self.log_elsewhere) else 0.0
            for hypothesis in self.hypotheses:
                hypothesis.probability = math.exp(hypothesis.log_weight - total) if math.isfinite(hypothesis.log_weight) else 0.0
        self.hypotheses.sort(key=lambda h: (-h.probability, -len(h.members)))
        self.guesses = [self._guess(h) for h in self.hypotheses]

    def _guess(self, hypothesis: Hypothesis) -> Guess:
        """A hypothesis as the vote's guess, for the page and the search."""
        mean, cov = hypothesis.mean, hypothesis.cov
        matrix = self.layout.matrix(mean)
        middle = np.asarray(self.board.middle)
        shift = mean[1:3] - matrix @ middle
        members = [hypothesis.members[i] for i in sorted(hypothesis.members)]
        newest = members[-1] if members else None
        estimate = Estimate(
            math.degrees(mean[0]), (float(shift[0]), float(shift[1])), (float(mean[1]), float(mean[2])),
            float(np.median([c.estimate.rms for c in members])) if members else 0.0,
            list(newest.estimate.corners) if newest else [], newest.estimate.seen if newest else None,
            newest.estimate.captured if newest else 0.0,
            float(np.mean([c.match for c in members])) if members else 0.0,
            newest.estimate.session if newest else 0,
            max((c.estimate.rival for c in members), default=0.0),
        )
        searches = set()
        for candidate in members:
            searches |= candidate.searches
        place_cov = cov[1:3, 1:3]
        spread_mm = math.sqrt(max(float(np.max(np.linalg.eigvalsh(place_cov))), 0.0))
        spread_deg = math.degrees(math.sqrt(max(float(cov[0, 0]), 0.0)))
        guess = Guess(
            estimate, len(members), hypothesis.probability, spread_mm, spread_deg,
            max(hypothesis.members) if hypothesis.members else 0, hypothesis.probability,
            hypothesis.corner_mm, hypothesis.ruled_out, sessions=len(searches), rival=estimate.rival,
        )
        return guess

    # --- what the look says ------------------------------------------------------------------

    @property
    def lead(self) -> Guess | None:
        guesses = self.guesses
        return guesses[0] if guesses and guesses[0].probability > 0.0 and not guesses[0].ruled_out else None

    def _likely(self) -> bool:
        """The most likely hypothesis holds the threshold of the probability,
        more than any other and more than where nothing looked yet, its
        spread within the agreement."""
        lead = self.lead
        if lead is None or lead.probability < self.threshold - 1e-9:
            return False
        if lead.spread_mm > self.agree_mm + 1e-9 or lead.spread_deg > self.agree_deg + 1e-9:
            return False
        second = self.guesses[1].probability if len(self.guesses) > 1 else 0.0
        return lead.probability > max(second, self.elsewhere) + 1e-9

    @property
    def worth_checking(self) -> bool:
        """The most likely hypothesis leads, holding LIKELY or more and more
        than any other, without being found: pictures from one place pool
        into one view, so a look from another place is what can raise it
        past the threshold. On a LumenPnP a look at rest held the right
        place at 0.49, wrong locks at the board's corner 0.22 and where
        nothing looked 0.20 until the head moved; on a scan of the whole bed
        a lock that matched fully held 0.37 against 0.62 where nothing had
        looked yet, which a check a second away settles."""
        lead = self.lead
        if lead is None or self.found or lead.probability < LIKELY:
            return False
        second = self.guesses[1].probability if len(self.guesses) > 1 else 0.0
        return lead.probability > second + 1e-9

    @property
    def stretch(self) -> dict | None:
        """The most likely hypothesis' X and Y scale and shear (degrees off
        square), each with its standard deviation; None without stretch."""
        if not self.layout.stretch or not self.hypotheses:
            return None
        h = self.hypotheses[0]
        sd = np.sqrt(np.maximum(np.diag(h.cov), 0.0))
        return {
            "scale_x": round(float(h.mean[3]), 6), "scale_x_sd": round(float(sd[3]), 6),
            "scale_y": round(float(h.mean[4]), 6), "scale_y_sd": round(float(sd[4]), 6),
            "shear_deg": round(math.degrees(float(h.mean[5])), 4), "shear_deg_sd": round(math.degrees(float(sd[5])), 4),
        }

    @property
    def delay(self) -> dict | None:
        """The camera's delay the most likely hypothesis puts, s, with its
        standard deviation; None but on a flying scan."""
        index = self.layout.delay_index
        if index is None or not self.hypotheses:
            return None
        h = self.hypotheses[0]
        return {"seconds": round(float(h.mean[index]), 5), "sd": round(math.sqrt(max(float(h.cov[index, index]), 0.0)), 5)}

    def to_dict(self) -> dict:
        with self._mutex:
            data = super().to_dict()
            dominant = bool(self.hypotheses) and self.hypotheses[0].probability >= DOMINANT
            data.update({
                "method": self.method,
                "elsewhere": round(self.elsewhere, 4),
                "representation": "gaussian" if dominant else "samples",
                "views": sum(1 for view in self.views if view.observed),
                "hypotheses": len(self.hypotheses),
                "stretch": self.stretch,
                "delay": self.delay,
            })
            return data

    # --- reading poses -----------------------------------------------------------------------

    def tune(self, threshold: float | None = None, corner_mm: float | None = None, corners: list[Corner] | None = None) -> None:
        with self._mutex:
            changed = (corners is not None and list(corners) != self.corners) or (corner_mm is not None and corner_mm != self.corner_mm)
            if threshold is not None:
                self.threshold = threshold
            if corner_mm is not None:
                self.corner_mm = corner_mm
            if corners is not None:
                self.corners = list(corners)
            if changed and self._box is not None:
                self._draw()
                for hypothesis in self.hypotheses:
                    self._fit(hypothesis)
            self._weigh_all()

    def set_marks(self, marks: list[tuple[Point, Point]]) -> None:
        """Other marks measured for the board: the probability is weighed again with them."""
        with self._mutex:
            self.marks = [Corner("mark", (float(d[0]), float(d[1])), (float(m[0]), float(m[1])), None, "mark") for d, m in marks]
            if self._box is not None:
                self._draw()
            for hypothesis in self.hypotheses:
                self._fit(hypothesis)
            self._weigh_all()

    def mark_pairs(self) -> list[tuple[Point, Point]]:
        return [(mark.job, mark.machine) for mark in self.marks]

    def see(self, state: str | None, estimate: Estimate | None, problem: str | None) -> None:
        """An estimate with nothing else (a record from before pcbv's
        candidates, replayed without its place): taken as a lock's only
        candidate at a view of its own."""
        self.take({"state": state}, None, 0.0, None, estimate, problem)

    def take(
        self,
        raw: dict,
        where,
        captured: float,
        to_job: Callable[[Point], Point] | None,
        estimate: Estimate | None,
        problem: str | None,
        session: int | None = None,
        searched_where=None,
    ) -> None:
        """One pose pcbv reported: its frame's place (`where`, a
        PictureFrame, or why it is not known), when it was taken, the job's
        map from KiCad's board frame, and what the vote made of it
        (`estimate`, `problem`; `session` its lock). A pose brings evidence
        once per pcbv search: its candidates (else its lock and its rival),
        pooled in the view of the place the searched frame was taken at
        (`searched_where` when pcbv says when that was, else `where`)."""
        with self._mutex:
            state = raw.get("state")
            self.looks += 1
            self.last_state = state
            self.problem = problem
            self._counted = None
            if state != "locked":
                self.view = None
            if estimate is not None:
                self.locked += 1
                self.view = estimate
                self.estimates.append(estimate)
            moving = isinstance(where, PictureFrame) and where.velocity != (0.0, 0.0)
            search, listed = self._search_of(raw, estimate, session, moving)
            if search is None:
                return
            place = searched_where if listed and searched_where is not None else where
            if listed and not isinstance(place, PictureFrame) and isinstance(where, PictureFrame) and estimate is not None:
                # The searched frame was taken while the head came to rest:
                # the lock it found, tracked into this frame, stands for it.
                listed = False
                place = where
            if not isinstance(place, PictureFrame):
                if estimate is None or listed or where is not None:
                    # Nothing placed yet: the search may still count once a
                    # frame of it is placed (a tracked one, at rest).
                    self._acquisitions.discard(search)
                    return
                place = PictureFrame(estimate.apply(estimate.seen) if estimate.seen is not None else estimate.center, 0.0, False)
            if self._box is None:
                self._box = self._default_box(place.center)
                self._draw()
            view = self._view_of(place, raw, captured)
            view.searches.add(search)
            self._counted = (view.index, search)
            if listed:
                candidates = self._candidates(raw, place, to_job, None) if to_job is not None else []
            elif to_job is not None:
                candidates = self._candidates(raw, place, to_job, estimate)
            else:
                candidates = [Candidate(estimate, estimate.match, True)] if estimate is not None else []
            known = {h.id for h in self.hypotheses}
            for candidate in candidates:
                candidate.searches.add(search)
                pooled = self._pool(view, candidate)
                if pooled.hypothesis == -1:
                    continue
                if pooled.hypothesis is None or pooled.hypothesis not in known:
                    self._place(pooled, view.index)
                    known = {h.id for h in self.hypotheses}
            for other in self.views:
                self._weigh_view_diffuse(other)
            self._merge()
            self._weigh_all()

    def _search_of(self, raw: dict, estimate: Estimate | None, session: int | None, moving: bool = False) -> tuple[tuple | None, bool]:
        """Which pcbv search a pose's evidence comes from, and whether the
        pose lists that search's candidates; None for a pose that brings
        nothing new (tracked from a search already read). pcbv numbers its
        searches (`search`) and says which one its candidates are from; a
        pcbv before candidates says only whether the frame searched and the
        lock it holds."""
        frame = raw.get("frame")
        if moving and _number(frame):
            # On the move every frame is another picture of another place:
            # its pose is evidence of its own, tracked or searched.
            key = ("moving", int(frame))
            if key in self._acquisitions:
                return None, False
            self._acquisitions.add(key)
            listed = isinstance(raw.get("candidates"), list) and raw.get("candidates_search") == raw.get("search") and raw.get("searched") is True
            return key, listed
        number = raw.get("search")
        if _number(number):
            key = ("search", int(number))
            if key in self._acquisitions:
                return None, False
            self._acquisitions.add(key)
            listed = isinstance(raw.get("candidates"), list) and raw.get("candidates_search") == number
            return key, listed
        if raw.get("searched") is True:
            self._searches += 1
            return ("frame", self._searches), False
        if estimate is not None:
            acquisition = raw.get("acquisition")
            lock = ("lock", int(acquisition)) if _number(acquisition) else ("lock", estimate.session if session is None else session)
            if lock in self._acquisitions:
                return None, False
            self._acquisitions.add(lock)
            return lock, False
        return None, False

    @staticmethod
    def _view_key(frame: PictureFrame) -> tuple | None:
        """The place a view is kept under; None on the move, where every
        picture is a view of its own."""
        if frame.velocity != (0.0, 0.0):
            return None
        return (round(frame.center[0] / VIEW_MM), round(frame.center[1] / VIEW_MM), round(frame.roll / VIEW_DEG), frame.mirror)

    @property
    def counts_searches(self) -> bool:
        """A stop ends on the searches made there (StopEnd) once the
        camera's scale is known: without it pcbv tries scale windows in
        turn, and a lock took up to hundreds of searches."""
        return self._scale_given

    def counted_search(self, frame: PictureFrame) -> int | None:
        """pcbv's number of the search the newest pose brought as evidence
        to the view at `frame`'s place; None when it brought none there,
        or a search pcbv did not number."""
        key = self._view_key(frame)
        with self._mutex:
            counted = self._counted
            if key is None or counted is None or self._view_keys.get(key) != counted[0]:
                return None
            search = counted[1]
            return int(search[1]) if search[0] == "search" else None

    def _view_of(self, frame: PictureFrame, raw: dict, captured: float) -> View:
        key = self._view_key(frame)
        index = self._view_keys.get(key) if key is not None else None
        if index is None:
            view = View(len(self.views), frame, captured=captured, crop=self.crop)
            self.views.append(view)
            if key is not None:
                self._view_keys[key] = view.index
        else:
            view = self.views[index]
        width, height, scale = raw.get("width"), raw.get("height"), raw.get("mm_per_px")
        if _number(width) and _number(height) and float(width) > 0.0 and float(height) > 0.0:
            view.width, view.height = float(width), float(height)
        if raw.get("state") == "locked" and _number(scale) and float(scale) > 0.0:
            self.scale = float(scale)
        if self.scale > 0.0:
            # Pictures taken before the scale was known get it now.
            for other in self.views:
                if other.scale <= 0.0:
                    other.scale = self.scale
                    if other.width <= 0.0 and view.width > 0.0:
                        other.width, other.height = view.width, view.height
        return view

    def _candidate(self, estimate: Estimate, raw: dict, passed: bool = True, expected: float = 0.0) -> Candidate:
        return Candidate(estimate, estimate.match, passed, expected=expected)

    def _candidates(self, raw: dict, where: PictureFrame, to_job: Callable[[Point], Point], estimate: Estimate | None) -> list[Candidate]:
        """The candidate poses of a pcbv reply as estimates: its `candidates`
        when it sends them, else its lock and the lock's rival."""
        listed = raw.get("candidates")
        out: list[Candidate] = []
        if isinstance(listed, list) and listed:
            for item in listed:
                if not isinstance(item, dict):
                    continue
                fields = {
                    "state": "locked", "center": item.get("center"), "corners": item.get("corners"), "angle_deg": item.get("angle_deg"),
                    "mm_per_px": item.get("mm_per_px", raw.get("mm_per_px")), "width": raw.get("width"), "height": raw.get("height"),
                    "inliers": item.get("found", item.get("inliers")), "expected": item.get("expected"), "unsure": item.get("unsure"),
                    # A place pcbv's whole-picture search refined says how
                    # well the picture fits it (boardlook.match_of).
                    "score": item.get("score"),
                }
                found, _ = pose_estimate(fields, where, to_job, self.board.middle)
                if found is None:
                    continue
                if _number(item.get("rms_mm")):
                    found.rms = max(found.rms, float(item["rms_mm"]))
                expected = float(item["expected"]) if _number(item.get("expected")) else 0.0
                out.append(Candidate(found, match_of(fields), bool(item.get("passed", True)), expected=expected))
            return out
        if estimate is None:
            return out
        expected = float(raw["expected"]) if _number(raw.get("expected")) else 0.0
        out.append(Candidate(estimate, estimate.match, True, expected=expected))
        rival = raw.get("rival")
        if isinstance(rival, dict) and _point(rival.get("center")) is not None and _number(rival.get("angle_deg")):
            fields = {"state": "locked", "center": rival["center"], "angle_deg": rival["angle_deg"]}
            other, _ = pose_estimate(fields, where, to_job, self.board.middle)
            if other is not None:
                other.rms = estimate.rms
                ratio = rival_of(raw)
                other.match = estimate.match * min(ratio, 1.0)
                out.append(Candidate(other, other.match, True, expected=expected))
        return out

    def _pool(self, view: View, candidate: Candidate) -> Candidate:
        """A candidate kept in its view's pool, or the one there it agrees
        with (the better match kept, the searches of both)."""
        for held in view.pool:
            if self.agrees(held.estimate, candidate.estimate):
                held.searches |= candidate.searches
                if candidate.strength > held.strength:
                    held.estimate, held.match, held.passed = candidate.estimate, candidate.match, candidate.passed
                    held.expected = max(held.expected, candidate.expected)
                    if held.hypothesis is not None and held.hypothesis >= 0:
                        for hypothesis in self.hypotheses:
                            if hypothesis.id == held.hypothesis:
                                self._fit(hypothesis)
                return held
        view.pool.append(candidate)
        return candidate

    # --- where to look next ------------------------------------------------------------------

    def look_value(self, center: Point, roll: float, mirror: bool, width: float, height: float, scale: float) -> float:
        """How much a picture with its center at `center` is expected to
        narrow the probability, nats: what it tells of which hypothesis (or
        none) is right, by whether it will give a candidate, plus how much a
        candidate there narrows the most likely hypothesis' fit."""
        view = View(-1, PictureFrame(center, roll, mirror), width, height, scale, crop=self.crop)
        view.searches.add(("plan", 0))
        weights, chances = [], []
        if self._diffuse is not None and self._miss_total is not None and self._diffuse_log is not None:
            states = self._diffuse
            if self.layout.size > 3:
                extra = np.tile(self.layout.start(0.0, (0.0, 0.0), self.delay_prior[0])[3:], (len(states), 1))
                states = np.concatenate([states, extra], axis=1)
            logs = self._diffuse_log + self._miss_total
            top = float(np.max(logs))
            share = np.exp(logs - top)
            share = share / max(float(share.sum()), 1e-300) * self.elsewhere
            weights.append(share)
            chances.append(detection(self.features_in(states, view)))
        for hypothesis in self.hypotheses:
            weights.append(np.array([hypothesis.probability]))
            chances.append(np.atleast_1d(detection(self.features_in(hypothesis.mean, view))))
        if not weights:
            return 0.0
        w = np.concatenate(weights)
        p = np.clip(np.concatenate(chances), 1e-9, 1.0 - 1e-9)
        total = float(w.sum())
        if total <= 0.0:
            return 0.0
        w = w / total

        def entropy(q):
            q = np.clip(q, 1e-12, 1.0 - 1e-12)
            return -(q * np.log(q) + (1.0 - q) * np.log(1.0 - q))

        gain = float(entropy(float(w @ p)) - w @ entropy(p))
        if self.hypotheses:
            lead = self.hypotheses[0]
            p_lead = float(detection(self.features_in(lead.mean, view)[0]))
            if p_lead > 0.01:
                candidate = Candidate(Estimate(math.degrees(lead.mean[0]), (0.0, 0.0), (float(lead.mean[1]), float(lead.mean[2])), MIN_RMS_MM), 1.0, True)
                candidate.estimate.seen = tuple(self.predict(lead.mean, view)[:2])
                _, noise = self._measurement(candidate, view)
                jac = self._jacobian(lambda s: self.predict(s, view), lead.mean)
                info = np.linalg.inv(lead.cov) + jac.T @ np.linalg.solve(noise, jac)
                sign_a, before = np.linalg.slogdet(lead.cov)
                sign_b, after = np.linalg.slogdet(np.linalg.inv(info))
                if sign_a > 0 and sign_b > 0:
                    gain += lead.probability * p_lead * 0.5 * max(before - after, 0.0)
        return gain

    def next_stop(self, stops: list[Point], here: Point, roll: float, mirror: bool, width: float, height: float, scale: float, speed: float, look_seconds: float) -> int:
        """The stop (an index into `stops`) to look from next: the one that
        narrows the probability most for the time it takes, the travel
        there (at `speed`, mm/s) and the look (`look_seconds`) counted
        against it; the nearest among equals."""
        best_index, best_score = 0, -math.inf
        for index, stop in enumerate(stops):
            seconds = look_seconds + math.dist(stop, here) / max(speed, 1e-6)
            score = self.look_value(stop, roll, mirror, width, height, scale) / max(seconds, 1e-6)
            if score > best_score + 1e-12 or (abs(score - best_score) <= 1e-12 and math.dist(stop, here) < math.dist(stops[best_index], here)):
                best_index, best_score = index, score
        return best_index


# Marks (a pad or hole under the tool, a feature centered by the camera)
# place their design point on the machine to this, one standard deviation,
# mm. A mark is wrong this often (a pad mistaken for its neighbor, a slip),
# anywhere within MARK_REACH_MM of where it belongs: a mark far off the fit
# is that, more likely than the tail of a good one, and counts for nothing
# instead of bending the fit.
MARK_MM = 0.05
MARK_WRONG = 0.02
MARK_REACH_MM = 10.0


@dataclass
class MarksFit:
    """Marks fitted with the board's stretch: the turn (degrees) and shift
    of the job's frame about its origin as a rigid fit gives them, the X
    and Y scale and the shear (degrees off square) with their standard
    deviations, the fit's rms (mm), each mark's residual (mm) and the
    weight it was given (1 trusted, less for one far off)."""

    rotation: float
    shift: Point
    scale_x: float
    scale_x_sd: float
    scale_y: float
    scale_y_sd: float
    shear_deg: float
    shear_deg_sd: float
    rms: float
    residuals: list[float]
    weights: list[float]

    def stretch(self) -> dict:
        return {
            "scale_x": round(self.scale_x, 6), "scale_x_sd": round(self.scale_x_sd, 6),
            "scale_y": round(self.scale_y, 6), "scale_y_sd": round(self.scale_y_sd, 6),
            "shear_deg": round(self.shear_deg, 4), "shear_deg_sd": round(self.shear_deg_sd, 4),
            "rms": round(self.rms, 4), "weights": [round(w, 3) for w in self.weights],
        }


def fit_marks(pairs: list[tuple[Point, Point]], sigma: float = MARK_MM) -> MarksFit:
    """The board's turn, place and stretch from marks (design point,
    machine point), three or more: the same state and priors as the
    posterior's hypotheses with stretch on (X and Y scale within the fab's
    tolerance of 1, shear near 0), fitted by least squares about the marks'
    middle, each mark weighed by how likely it is a good one rather than a
    wrong one (MARK_WRONG), so one far off counts for nothing. A ValueError
    with fewer than three marks."""
    from spinny_laser.align import fit_rigid

    if len(pairs) < 3:
        raise ValueError("the board's stretch needs three marks or more")
    rigid = fit_rigid(pairs)
    designs = np.array([p[0] for p in pairs], dtype=float)
    machines = np.array([p[1] for p in pairs], dtype=float)
    middle = designs.mean(axis=0)
    start = rigid.apply((float(middle[0]), float(middle[1])))
    layout = Layout(stretch=True)
    state = layout.start(math.radians(rigid.rotation), start)
    means, sigmas, indices = layout.extra_prior()
    weights = np.ones(len(pairs))
    cov = np.eye(len(state))

    def place(s: np.ndarray) -> np.ndarray:
        return (layout.matrix(s) @ (designs - middle).T).T + s[1:3]

    for _ in range(30):
        predicted = place(state)
        residual = machines - predicted
        distance = np.hypot(residual[:, 0], residual[:, 1]) / sigma
        # How likely each mark is a good one, given how far off it lies.
        good = (1.0 - MARK_WRONG) * np.exp(-0.5 * distance ** 2) / (2.0 * math.pi * sigma * sigma)
        wrong = MARK_WRONG / (math.pi * MARK_REACH_MM * MARK_REACH_MM)
        weights = good / (good + wrong)
        rows, values = [], []
        steps = np.array([1e-7, 1e-5, 1e-5, 1e-7, 1e-7, 1e-7])
        jac = np.zeros((2 * len(pairs), len(state)))
        for i, step in enumerate(steps):
            up, down = state.copy(), state.copy()
            up[i] += step
            down[i] -= step
            jac[:, i] = ((place(up) - place(down)) / (2.0 * step)).reshape(-1)
        w = np.repeat(np.sqrt(weights), 2) / sigma
        rows.append(jac * w[:, None])
        values.append(residual.reshape(-1) * w)
        for mean, spread, index in zip(means, sigmas, indices):
            row = np.zeros(len(state))
            row[index] = 1.0 / spread
            rows.append(row[None, :])
            values.append(np.array([(mean - state[index]) / spread]))
        a = np.concatenate(rows, axis=0)
        b = np.concatenate(values)
        normal = a.T @ a
        step = np.linalg.solve(normal, a.T @ b)
        state = state + step
        cov = np.linalg.inv(normal)
        if np.all(np.abs(step) < 1e-10):
            break
    residual = machines - place(state)
    distances = np.hypot(residual[:, 0], residual[:, 1])
    sd = np.sqrt(np.maximum(np.diag(cov), 0.0))
    turn_deg = math.degrees(float(state[0]))
    matrix = layout.matrix(state)
    shift = state[1:3] - matrix @ middle
    return MarksFit(
        turn_deg, (float(shift[0]), float(shift[1])),
        float(state[3]), float(sd[3]), float(state[4]), float(sd[4]), math.degrees(float(state[5])), math.degrees(float(sd[5])),
        float(math.sqrt(float(np.mean(distances ** 2)))), [float(d) for d in distances], [float(w) for w in weights],
    )


def posterior_fields(consensus) -> dict:
    """What a record keeps of the probability after a pose: the share
    where nothing has looked yet and the views it holds; nothing for a vote."""
    if not isinstance(consensus, Posterior):
        return {}
    return {"elsewhere": round(consensus.elsewhere, 4), "views": sum(1 for view in consensus.views if view.observed), "hypotheses": len(consensus.hypotheses)}


__all__ = [
    "AGREE_DEG", "AGREE_MM", "AMBIGUOUS", "GUESSES", "SESSIONS", "Board", "Candidate", "Hypothesis", "Layout", "Posterior", "View",
    "detection", "posterior_fields", "strength",
]
