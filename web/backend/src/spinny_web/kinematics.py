"""Board geometry to joint-space protocol lines.

The firmware moves straight lines in joint space, so every board polyline
is subdivided with `spinny_laser.polar` until linear joint interpolation
stays within the chord tolerance, and each piece becomes one `cut`, `go` or
`jogto` line. A segment that passes within half a coordinate quantum of the
axis is split there: the crossing becomes a radial move in, a turn on the
spot with the beam off, and a radial move out, since a spiral out of the
axis can never be made straight by subdividing it.

With a height map a run is compensated for the board's height (see
`heightmap`): `compensate` rewrites the pieces, splitting cuts and adding
the focus axis word or raising the power.

`CartesianStreamer` is the same for a machine whose cross slide is a joint
(`$cartesian=1`): the head sits at R along the rail and Z across it, the
table holds its angle, and a board line is one straight `cut R Z` line.
Board points are turned by that angle, so a board placed on the table is
cut where a polar job would cut it.

With a `Spindle` (`$spindle=1`) a job is milled rather than burnt: the
focus axis is the depth axis, H 0 is the board's surface (or the height
map is), and every path is a plunge, the cuts at depth and a retract to
the travel height, with each pass of a group a step deeper.
"""

from __future__ import annotations

import dataclasses
import hashlib
import math
from dataclasses import dataclass
from typing import TYPE_CHECKING, Iterable, Iterator

from spinny_laser import align as alignment
from spinny_laser import polar
from spinny_laser.polar import Joint, Kinematics, Point

if TYPE_CHECKING:
    from .heightmap import Compensation
    from .jobs import Job

DECIMALS = 3
ANGLE_DECIMALS = 4
# The focus axis word: a tenth of a micron is under a step at any usual scale.
FOCUS_DECIMALS = 4
# How the tool gets to a model's move, the fourth number of each.
MOVE_RAPID, MOVE_FEED, MOVE_PLUNGE = 0, 1, 2
DEFAULT_TOLERANCE = 0.005
# Largest value a power, a speed or a coordinate may take: far past any
# machine, and short enough to keep every protocol line under its limit.
MAX_VALUE = 1.0e6
# The tools a group may be made for, and that a machine cuts with.
LASER, SPINDLE, DISPENSER = "laser", "spindle", "dispenser"


@dataclass(frozen=True)
class Rates:
    """The firmware's axis limits, for the time estimate. The defaults
    are the firmware's own, for a job priced before a machine is read."""

    r_rate: float = 560.0
    a_rate: float = 400.0
    # The cross slide as a joint, and the focus axis.
    z_rate: float = 560.0
    h_rate: float = 600.0

    @property
    def pace(self) -> float:
        """The rail's rate over the table's, mm per degree: what a radial
        clearing or fill orders its spokes by."""
        return self.r_rate / self.a_rate

    @classmethod
    def from_settings(cls, values: dict) -> "Rates":
        rates = cls()
        try:
            step_us = int(float(values.get("step_us", 2)))
            # The planner caps each axis by the step generator as well as
            # by its rate setting, and the estimate follows the lower of
            # the two.
            ceiling = step_ceiling_hz(step_us)
            capped = {}
            for axis in ("r", "a", "z", "h"):
                rate = float(values.get(f"{axis}_rate", getattr(rates, f"{axis}_rate")))
                steps = float(values.get(f"{axis}_steps", 0.0))
                rate = rate if rate > 0 else getattr(rates, f"{axis}_rate")
                if steps > 0:
                    rate = min(rate, ceiling * 60.0 / steps)
                capped[f"{axis}_rate"] = rate
        except (TypeError, ValueError):
            return rates
        return cls(**capped)


@dataclass(frozen=True)
class Spindle:
    """How a spindle job moves between the cuts: `clearance` mm over the
    highest point of the surface for travel, and `spinup` seconds of dwell
    after the spindle starts or changes speed."""

    clearance: float = 2.0
    spinup: float = 2.0
    # The S every spindle line asks for when the spindle's speed is not
    # the host's to set: a spindle with its own speed knob, or one behind
    # a switch, is run full on and never at a group's rpm. None follows
    # the groups.
    full: float | None = None

    def __post_init__(self) -> None:
        if not (math.isfinite(self.clearance) and 0.0 < self.clearance <= 100.0):
            raise ValueError("the clearance must be above 0 and at most 100 mm")
        if not (math.isfinite(self.spinup) and 0.0 <= self.spinup <= 600.0):
            raise ValueError("the spin-up must be 0 to 600 s")
        if self.full is not None and not (math.isfinite(self.full) and self.full > 0.0):
            raise ValueError("the full speed must be above 0")


@dataclass(frozen=True)
class Dispense:
    """What a dot of paste is made of, on a machine whose table joint is a
    dispenser's plunger: the head travels `clearance` mm over the surface,
    the needle stands `gap` over the pad, the plunger pushes out the dot's
    volume (the pad's area times the group's thickness) over `output`
    mm^3 per mm of plunger, plus the `retract` it took back after the last
    dot, at `rate` mm/min, waits `dwell_ms`, and pulls back `retract`."""

    clearance: float = 2.0
    gap: float = 0.1
    retract: float = 0.2
    output: float = 100.0
    rate: float = 60.0
    dwell_ms: int = 200

    def __post_init__(self) -> None:
        if not (math.isfinite(self.clearance) and 0.0 < self.clearance <= 100.0):
            raise ValueError("the clearance must be above 0 and at most 100 mm")
        if not (math.isfinite(self.gap) and 0.0 < self.gap <= 10.0):
            raise ValueError("the gap must be above 0 and at most 10 mm")
        if not (math.isfinite(self.retract) and 0.0 <= self.retract <= 50.0):
            raise ValueError("the retract must be 0 to 50 mm")
        if not (math.isfinite(self.output) and 0.0 < self.output <= 1.0e5):
            raise ValueError("the output must be above 0 and at most 100000 mm^3 per mm")
        if not (math.isfinite(self.rate) and 0.0 < self.rate <= 1.0e4):
            raise ValueError("the extrude rate must be above 0 and at most 10000 mm/min")
        if not 0 <= int(self.dwell_ms) <= 60000:
            raise ValueError("the dwell must be 0 to 60000 ms")

    def plunger_mm(self, area: float, thickness: float) -> float:
        """How far the plunger goes for a pad of `area` mm^2 under
        `thickness` mm of paste."""
        return area * thickness / self.output


def step_ceiling_hz(step_us: int) -> float:
    """Most steps a second the firmware produces at a step pulse width: one
    per 10 us tick, and fewer once the pulse, busy-waited inside the tick at
    about 1.5 times its setting, plus the interrupt's own work no longer fit."""
    tick_us = max(10, (3 * max(0, step_us) + 1) // 2 + 3)
    return 1.0e6 / tick_us


@dataclass
class Piece:
    """One protocol line with what it costs."""

    line: str
    kind: str
    joint: Joint
    seconds: float = 0.0
    # Board length of a cut; zero for rapids and turns.
    length: float = 0.0
    # The time is set by an axis limit rather than by F.
    limited: bool = False
    group: int | None = None
    # What a cut was made from, so it can be split and rewritten: where it
    # starts, and its F, S and M (None for no M). A spindle's cut has no S.
    start: Joint | None = None
    feed: float = 0.0
    power: float = 0.0
    floor: float | None = None
    # The focus axis height the line leaves the head at, when the line
    # says: a lift, a plunge, a cut at depth, a compensated move. None
    # where the height is whatever it was.
    h: float | None = None


# The words a plan's print leaves out of each line: the feed, the power and
# its floor, a dwell's time and the focus axis height change with a group's
# settings, the spindle's spin-up and the height map's tie, and none of them
# moves a line to another count in the plan or another place on the board.
PRINT_SKIPS = frozenset("FSMTH")


class PlanPrint:
    """A short fingerprint of a plan's lines: what each one is and where it
    goes, without the words that only say how. Two plans with the same
    print have the same lines at the same counts, so a count of lines done
    in one is the same place in the other."""

    def __init__(self) -> None:
        self._hash = hashlib.sha256()

    def add(self, piece: Piece) -> None:
        words = piece.line.split()
        kept = [word for word in words[1:] if word[:1].upper() not in PRINT_SKIPS]
        self._hash.update(f"{piece.kind} {words[0] if words else ''} {' '.join(kept)}\n".encode())

    def hexdigest(self) -> str:
        return self._hash.hexdigest()[:16]


def plan_print(pieces: Iterable[Piece]) -> str:
    """The `PlanPrint` of a plan's pieces."""
    printed = PlanPrint()
    for piece in pieces:
        printed.add(piece)
    return printed.hexdigest()


@dataclass
class Stats:
    length_mm: float = 0.0
    seconds: float = 0.0
    max_radius: float = 0.0
    min_radius: float = 0.0
    limited_fraction: float = 0.0
    moves: int = 0
    # The lines priced, as `PlanPrint` sums them up: what a run keeps to
    # tell a pickup's plan from another.
    fingerprint: str = ""

    def to_dict(self) -> dict:
        return {
            "length_mm": round(self.length_mm, 3),
            "seconds": round(self.seconds, 1),
            "max_radius": round(self.max_radius, 3),
            "min_radius": round(self.min_radius, 3),
            "limited_fraction": round(self.limited_fraction, 4),
            "moves": self.moves,
        }


# The smallest feed the firmware accepts; the host writes F with three
# decimals, so anything under this would go out as `F0` and be refused.
MIN_FEED = 0.001


def _lerp_joint(a: Joint, b: Joint, t: float) -> Joint:
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)


def check_feed(feed: float | None) -> None:
    """A jog or goto feed the firmware will take, or none."""
    if feed is not None and not (math.isfinite(feed) and feed >= MIN_FEED):
        raise ValueError(f"feed must be at least {MIN_FEED:g} mm/min")


def num(value: float, decimals: int = 3) -> str:
    """A plain decimal with trailing zeros dropped and no negative zero."""
    text = f"{value:.{decimals}f}"
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    if text in ("-0", ""):
        text = "0"
    return text


def _finite(*values: float | None) -> None:
    """Refuses a value that is not a number before it can become a word."""
    for value in values:
        if value is not None and not (math.isfinite(value) and abs(value) <= MAX_VALUE):
            raise ValueError("a move needs numbers within 1e6")


def coord(value: float, decimals: int) -> str:
    """A fixed-decimal coordinate word value without a negative zero."""
    text = f"{value:.{decimals}f}"
    if text.startswith("-") and float(text) == 0.0:
        text = text[1:]
    return text


def _spindle_speed(line: str) -> float | None:
    """The S of a `spindle S` line; None for `spindle off`."""
    for word in line.split()[1:]:
        if word[:1].upper() == "S":
            try:
                return float(word[1:])
            except ValueError:
                return None
    return None


def turned_toward(poly: list[Joint], angle: float) -> list[Joint]:
    """The polyline with whole turns added so that it starts near `angle`.

    A joint-space path gives absolute angles, and its start is the same
    place any number of turns away; the nearest one is the one to go to.
    """
    if not poly:
        return poly
    turns = round((angle - poly[0][1]) / 360.0)
    if turns == 0:
        return poly
    return [(r, a + 360.0 * turns) for r, a in poly]


def group_focus(job: "Job") -> dict[int, float]:
    """Each enabled group's own focus, by its index, for the groups that
    have one and something to cut."""
    return {
        index: float(group.focus)
        for index, group in enumerate(job.groups)
        if group.enabled and group.has_cuts and group.focus is not None
    }


def joint_min_radius(poly: list[Joint]) -> float:
    """Nearest a joint polyline comes to the axis; zero when a move crosses it."""
    for a, b in zip(poly, poly[1:]):
        if (a[0] < 0.0) != (b[0] < 0.0):
            return 0.0
    return min(abs(r) for r, _ in poly)


# Most points the previews of one job's joint polylines add to their own.
# Each polyline is bounded on its own as well, but an upload of many would
# still come to millions of points.
PREVIEW_BUDGET = 100_000


def joint_previews(groups: list[list[list[Joint]]], budget: int = PREVIEW_BUDGET) -> list[list[list[Point]]]:
    """Board points along every polyline of every group, close enough to
    draw them (`polar.sample_joints`), with one budget for all of them:
    once it is spent, a polyline is drawn through its own points only."""
    out = []
    remaining = budget
    for polys in groups:
        drawn = []
        for poly in polys:
            points = polar.sample_joints([(float(r), float(a)) for r, a in poly], limit=min(polar.MAX_SAMPLES, max(0, remaining)))
            remaining -= len(points) - len(poly)
            drawn.append(points)
        out.append(drawn)
    return out


# Shared with the command line tools, which cut a path at the axis the
# same way before subdividing it.
split_at_axis = polar.split_at_axis


class Streamer:
    """Turns board moves into protocol lines, and prices them.

    This one is for the polar machine: a joint is (radius, angle). The
    methods between `start_of` and `_moves` are what a frame decides, and
    `CartesianStreamer` gives them for a machine whose cross slide is a
    joint. `spindle` turns a job into milling, `dispense` into dots of
    paste on a machine whose table joint is a dispenser's plunger.
    """

    cartesian = False

    def __init__(
        self,
        tolerance: float = DEFAULT_TOLERANCE,
        rates: Rates | None = None,
        spindle: Spindle | None = None,
        dispense: Dispense | None = None,
    ) -> None:
        self.kinematics = Kinematics(tolerance)
        self.rates = rates or Rates()
        self.spindle = spindle
        self.dispense = dispense
        # The focus axis height a laser group's focus counts from when the
        # run follows no height map: where the head stood as the run began,
        # which the runner sets. A plan made without it (a price) counts
        # from 0, which moves nothing in time.
        self.focus_base: float | None = None
        # A segment within this of the axis is cut there and crosses it
        # with a dark turn. Half a word quantum is the least that makes
        # the words agree; the chord tolerance is the most the path may
        # be moved by, and a pass between the two would otherwise be
        # streamed as chords sweeping half a turn of the table at a radius
        # of microns, seconds of the beam on one spot under `mode const`.
        self.snap = max(0.5 * 10.0 ** -DECIMALS, tolerance)

    @property
    def tolerance(self) -> float:
        return self.kinematics.tolerance

    # --- the frame ----------------------------------------------------------

    def start_of(self, status) -> Joint:
        """The joint a status report puts the head at, in this frame."""
        return (status.r, status.a)

    def board_of(self, joint: Joint) -> Point:
        return polar.cartesian(joint)

    def _path_start(self, point: Point, joint: Joint) -> Joint:
        """The joint that puts the beam over the first point of a path."""
        first = polar.joint_of(point, joint[1])
        if first[0] < self.snap:
            # The word written is R0.000: the head is on the axis, and the
            # joint tracked must say so or the move away from it is cut as
            # a spiral instead of a turn.
            first = (0.0, first[1])
        return first

    def words(self, joint: Joint, radius: bool = True, h: float | None = None) -> str:
        parts = []
        if radius:
            parts.append(f"R{coord(joint[0], DECIMALS)}")
        parts.append(f"A{coord(joint[1], ANGLE_DECIMALS)}")
        if h is not None:
            parts.append(f"H{coord(h, FOCUS_DECIMALS)}")
        return " ".join(parts)

    def _same(self, a: Joint, b: Joint) -> bool:
        return (
            abs(a[0] - b[0]) < 0.5 * 10.0 ** -DECIMALS
            and abs(a[1] - b[1]) < 0.5 * 10.0 ** -ANGLE_DECIMALS
        )

    def _rapid_seconds(self, a: Joint, b: Joint) -> float:
        dr = abs(b[0] - a[0])
        da = abs(b[1] - a[1])
        return max(dr / self.rates.r_rate, da / self.rates.a_rate) * 60.0

    def _cut_cost(self, a: Joint, b: Joint, feed: float) -> tuple[float, bool]:
        dr = abs(b[0] - a[0])
        da = abs(b[1] - a[1])
        surface = polar.surface_length(a, b)
        minutes = surface / feed if feed > 0 else 0.0
        actual = max(minutes, dr / self.rates.r_rate, da / self.rates.a_rate)
        limited = actual > minutes * (1.0 + 1e-9) and surface > 0.0
        return actual * 60.0, limited

    def _moves(self, point: Point, target: Point, joint: Joint) -> Iterator[tuple[Point, Joint, bool]]:
        """Board points and joints on the way to `target`; True marks a turn."""
        for stop in split_at_axis(point, target, self.snap):
            for next_point, next_joint in polar.subdivide(point, stop, joint, self.kinematics):
                turn = (
                    polar.on_axis(next_joint)
                    and math.dist(next_point, point) < polar.AXIS_EPSILON
                    and abs(next_joint[1] - joint[1]) > 0.0
                )
                if not turn and self._same(joint, next_joint):
                    point = next_point
                    if polar.on_axis(next_joint):
                        # No line goes out, but the head is on the axis
                        # to within a quantum, and the next segment must
                        # be split as leaving it.
                        joint = next_joint
                    continue
                yield next_point, next_joint, turn
                point, joint = next_point, next_joint

    # --- lines ------------------------------------------------------------

    def cut_line(self, joint: Joint, feed: float, power: float | None, floor: float | None, h: float | None = None) -> str:
        """A `cut` with its own F and S, and M when there is a floor; a
        spindle's cut (power None) carries no S."""
        line = f"cut {self.words(joint, h=h)} F{num(feed)}"
        if power is not None:
            line += f" S{num(power)}"
        if floor is not None:
            line += f" M{num(floor)}"
        return line

    def _path_moves(self, points: list[Point], joint: Joint) -> Iterator[tuple[str, Joint, Joint, Point, Point]]:
        """The moves along one board path from a joint: `go` to its start
        if the head is not there, then `cut`s, and `turn`s where it crosses
        the axis. Each is (kind, from joint, to joint, from point, to point)."""
        first = self._path_start(points[0], joint)
        if not self._same(joint, first):
            yield "go", joint, first, self.board_of(joint), points[0]
            joint = first
        point = points[0]
        for target in points[1:]:
            for next_point, next_joint, turn in self._moves(point, target, joint):
                yield ("turn" if turn else "cut"), joint, next_joint, point, next_point
                point, joint = next_point, next_joint
            point = target

    # --- jobs -------------------------------------------------------------

    def job_pieces(self, job: "Job", start: Joint, compensation: "Compensation | None" = None) -> Iterator[Piece]:
        """Every protocol line of the job, lazily, from the machine's joint,
        compensated for the board's height when asked, each laser group at
        its own focus when it has one."""
        if self.dispense is not None:
            return self._dispense_pieces(job, start, compensation)
        if self.spindle is not None:
            return self._spindle_pieces(job, start, compensation)
        pieces = self._job_pieces(job, start)
        offsets = group_focus(job)
        if compensation is None:
            return self._focus_groups(pieces, offsets) if offsets else pieces
        if offsets and compensation.mode != "focus":
            label = job.groups[next(iter(offsets))].label
            raise ValueError(
                f"{label} asks for a focus height, and following the map by power holds the head still:"
                " follow it with the focus axis, or clear the group's focus"
            )
        return self.compensate(pieces, compensation, offsets)

    def _focus_groups(self, pieces: Iterator[Piece], offsets: dict[int, float]) -> Iterator[Piece]:
        """The pieces with each group at its own focus, counted from where
        the run began (`focus_base`): the head moves dark to a group's
        height with the rapid to its first path, or on its own before a
        cut that starts where the head is, and goes back to the start's
        height after the last group. The first group's height is said even
        when it is the start's, so a run picked up anywhere finds the height
        its line was planned at in the lines before it."""
        base = self.focus_base if self.focus_base is not None else 0.0
        current: float | None = None
        last_group: int | None = None
        last_joint: Joint | None = None
        quantum = 0.5 * 10.0 ** -FOCUS_DECIMALS
        for piece in pieces:
            if piece.group is not None and piece.kind in ("go", "turn", "cut"):
                want = base + offsets.get(piece.group, 0.0)
                if current is None or abs(want - current) >= quantum:
                    lift = self._lift(want, base if current is None else current, piece.group, piece.start if piece.start is not None else piece.joint)
                    current = want
                    if piece.kind in ("go", "turn"):
                        piece = dataclasses.replace(
                            piece,
                            line=f"{piece.line} H{coord(want, FOCUS_DECIMALS)}",
                            seconds=max(piece.seconds, lift.seconds),
                            h=want,
                        )
                    else:
                        yield lift
                last_group = piece.group
            last_joint = piece.joint
            yield piece
        if current is not None and abs(current - base) >= quantum and last_joint is not None:
            yield self._lift(base, current, last_group, last_joint)

    def compensate(self, pieces: Iterator[Piece], compensation: "Compensation", offsets: dict[int, float] | None = None) -> Iterator[Piece]:
        """The pieces rewritten for the board's height.

        A cut is split along its joint line into pieces no longer than the
        compensation's step on the board. That is the same line the
        firmware would have moved, since it interpolates joints linearly,
        but the focus height or the power now follows the surface along it
        instead of changing once per cut. With the focus axis every line
        carries the focus height at its end, rapids and turns included, so
        the head is at focus when a cut begins; with power the rapids are
        left as they are. `offsets` raises each group's focus height by its
        own focus.
        """
        focus = compensation.mode == "focus"
        offsets = offsets or {}
        quantum = 0.5 * 10.0 ** -FOCUS_DECIMALS

        def extra_of(piece: Piece) -> float:
            return offsets.get(piece.group, 0.0) if piece.group is not None else 0.0

        def focus_at(piece: Piece, joint: Joint) -> float:
            return compensation.focus(self.board_of(joint)) + extra_of(piece)
        # Whether a line has set the focus height yet. A job whose first
        # line is a cut, the head already over its first point, would light
        # the beam with the head at whatever height it was left and bring
        # it to focus only along that first piece; a dark move to the focus
        # height goes first instead.
        placed = not focus
        # The own focus of the group whose height the last line said, and
        # the height that line left the head at. A cut of a group with
        # another focus that starts where the last one ended has no rapid
        # to carry its height: it gets a dark move of its own too, or its
        # first piece would move the head by the difference with the beam on.
        said: float | None = None
        last_h = compensation.head_h
        for piece in pieces:
            if focus and piece.kind == "cut" and piece.start is not None:
                if not placed or (said is not None and abs(extra_of(piece) - said) >= quantum):
                    h = focus_at(piece, piece.start)
                    yield self._lift(h, last_h, piece.group, piece.start)
                    last_h = h
            placed = True
            if focus and piece.kind in ("go", "turn", "cut"):
                said = extra_of(piece)
            if piece.kind == "cut" and piece.start is not None:
                a, b = piece.start, piece.joint
                parts = max(1, math.ceil(piece.length / compensation.step - 1e-9))
                previous = a
                for k in range(1, parts + 1):
                    joint = b if k == parts else _lerp_joint(a, b, k / parts)
                    if focus:
                        h = focus_at(piece, joint)
                        last_h = h
                        power, floor = piece.power, piece.floor
                    else:
                        h = None
                        middle = self.board_of(_lerp_joint(a, b, (k - 0.5) / parts))
                        power, floor = compensation.scaled(piece.power, piece.floor, middle)
                    yield dataclasses.replace(
                        piece,
                        line=self.cut_line(joint, piece.feed, power, floor, h),
                        joint=joint,
                        seconds=piece.seconds / parts,
                        length=piece.length / parts,
                        start=previous,
                        power=power,
                        floor=floor,
                        h=h,
                    )
                    previous = joint
            elif focus and piece.kind in ("go", "turn"):
                h = focus_at(piece, piece.joint)
                last_h = h
                yield dataclasses.replace(piece, line=f"{piece.line} H{coord(h, FOCUS_DECIMALS)}", h=h)
            else:
                yield piece

    def _joint_group_pieces(self, group, index: int, joint: Joint, feed: float, power: float, floor: float | None):
        """A joint-space group: each pair of points is one move, and a
        negative radius is the far side of the axis. Only whole turns are
        added, so the table does not swing the long way round to a start
        that is the same place a turn away. Returns the joint it ends at."""
        for poly in group.joints * max(1, int(group.passes)):
            joints = turned_toward([(float(r), float(a)) for r, a in poly], joint[1])
            if len(joints) < 2:
                continue
            first = joints[0]
            if not self._same(joint, first):
                yield self._go(joint, first, index)
                joint = first
            for target in joints[1:]:
                if self._same(joint, target):
                    continue
                seconds, limited = self._cut_cost(joint, target, feed)
                yield Piece(
                    line=self.cut_line(target, feed, power, floor),
                    kind="cut",
                    joint=target,
                    seconds=seconds,
                    length=polar.surface_length(joint, target),
                    limited=limited,
                    group=index,
                    start=joint,
                    feed=feed,
                    power=power,
                    floor=floor,
                )
                joint = target
        return joint

    def _job_pieces(self, job: "Job", start: Joint) -> Iterator[Piece]:
        joint = start
        for index, group in enumerate(job.groups):
            if not group.enabled:
                continue
            feed = float(group.speed)
            power = float(group.power)
            # `M` is not modal, so a group without a floor leaves it off.
            floor = min(float(group.min_power), power) if group.min_power > 0 else None
            # Each pass is the whole group again, from wherever the last
            # one left the head: a closed loop starts where it ended, an
            # open path is gone back to.
            passes = max(1, int(group.passes))
            if group.moves:
                raise ValueError(f"{group.label}: a model's moves are cut with a spindle ($spindle=1)")
            if group.joints:
                joint = yield from self._joint_group_pieces(group, index, joint, feed, power, floor)
                continue
            for path in group.paths * passes:
                points = [tuple(p) for p in path]
                if len(points) < 2:
                    continue
                for kind, a, b, p, q in self._path_moves(points, joint):
                    if kind == "go":
                        yield self._go(a, b, index)
                    elif kind == "turn":
                        yield Piece(
                            line=f"go {self.words(b, radius=False)}",
                            kind="turn",
                            joint=b,
                            seconds=self._rapid_seconds(a, b),
                            group=index,
                        )
                    else:
                        seconds, limited = self._cut_cost(a, b, feed)
                        # Every cut carries its own feed and power. The
                        # firmware keeps them modal, but it forgets them
                        # on a reset, and a reset part way through a run
                        # would otherwise leave every line after it
                        # refused for a missing word rather than simply
                        # stopping the run.
                        yield Piece(
                            line=self.cut_line(b, feed, power, floor),
                            kind="cut",
                            joint=b,
                            seconds=seconds,
                            length=math.dist(p, q),
                            limited=limited,
                            group=index,
                            start=a,
                            feed=feed,
                            power=power,
                            floor=floor,
                        )
                    joint = b

    # --- milling ----------------------------------------------------------

    def travel_height(self, compensation: "Compensation | None") -> float:
        """Where the tool travels between cuts, or between dots: the
        clearance over the surface, which is H 0 without a height map and
        its highest point with one."""
        tool = self.dispense if self.dispense is not None else self.spindle
        assert tool is not None
        top = compensation.highest() if compensation is not None else 0.0
        return top + tool.clearance

    def _lift(self, h: float, frm: float | None, group: int | None, joint: Joint) -> Piece:
        """The focus or depth axis to `h` from `frm` (None: in no time), over `joint`."""
        seconds = abs(h - frm) / self.rates.h_rate * 60.0 if frm is not None else 0.0
        return Piece(line=f"go H{coord(h, FOCUS_DECIMALS)}", kind="lift", joint=joint, seconds=seconds, group=group, h=h)

    def _go(self, frm: Joint, to: Joint, group: int | None) -> Piece:
        """A rapid from one joint to another."""
        return Piece(line=f"go {self.words(to)}", kind="go", joint=to, seconds=self._rapid_seconds(frm, to), group=group)

    def _plunge(self, h: float, frm: float, rate: float, group: int | None, joint: Joint) -> Piece:
        """The tool down (or up) to `h` from `frm` at `rate` mm/min, over `joint`."""
        return Piece(line=f"cut H{coord(h, FOCUS_DECIMALS)} F{num(rate)}", kind="plunge", joint=joint, seconds=abs(frm - h) / rate * 60.0, group=group, h=h)

    def check_job(self, job: "Job") -> None:
        """Refuses, with a ValueError, a job this streamer would make into
        lines the machine must not run, before any line of it is made.

        A group a CAM profile made for the other tool is refused: its
        power is a spindle speed or a laser duty, its depth means nothing
        to a laser. So is a milling job of a profile's groups made with more
        than one bit, since nothing stops to change it. A spindle at S0 is
        stopped, and every plunge and cut after it would drive a still tool
        into the board: a milling group must ask for a speed. A laser group
        may have power 0, which is a harmless trace.
        """
        self.check_tools(job)
        self.check_bits(job)
        self._check_speeds(job)
        self._check_dots(job)
        self._check_focus(job)

    @property
    def tool(self) -> str:
        """What this streamer makes a job for: `laser`, `spindle` or `dispenser`."""
        if self.dispense is not None:
            return DISPENSER
        return SPINDLE if self.spindle is not None else LASER

    def check_tools(self, job: "Job") -> None:
        mine = self.tool
        # A group that names no tool was drawn for a beam or a bit, which
        # follow its paths; a dispenser lays dots, so it takes only groups
        # made for it.
        allowed = (mine,) if mine == DISPENSER else (None, mine)
        for group in job.groups:
            if group.enabled and group.has_cuts and group.tool not in allowed:
                if group.tool is None:
                    raise ValueError(
                        f"{group.label} is a group of paths and this machine has a dispenser, which lays dots:"
                        " import the board with mode dispense, or disable the group"
                    )
                raise ValueError(
                    f"{group.label} was made for {_article(group.tool)} and this machine has {_article(mine)}:"
                    f" disable the group, or load the machine file the profile names"
                )

    def check_bits(self, job: "Job") -> None:
        """A run has no stop to change the bit, so a milling job whose
        enabled groups a CAM profile made with more than one bit is refused,
        naming the groups to switch off to cut with the first bit alone. A
        group that names no bit cuts with whatever is fitted."""
        if self.tool != SPINDLE:
            return
        cutting = [group for group in job.groups if group.enabled and group.has_cuts and group.tool_id is not None]
        bits: dict[str, str] = {}
        for group in cutting:
            bits.setdefault(group.tool_id, group.tool_name or group.tool_id)
        if len(bits) < 2:
            return
        first = next(iter(bits))
        later = [group.label for group in cutting if group.tool_id != first]
        raise ValueError(
            f"the job cuts with {len(bits)} bits ({', '.join(bits.values())}) and a run does not stop to change one:"
            f" switch off {'; '.join(later)} to cut with the {bits[first]} alone, then each other bit's groups after fitting it"
        )

    def _check_focus(self, job: "Job") -> None:
        """A focus height is a laser's: a spindle's focus axis is its depth,
        a dispenser's the needle's height."""
        if self.tool == LASER:
            return
        for index in group_focus(job):
            group = job.groups[index]
            verb = "mill" if self.tool == SPINDLE else "dispense"
            raise ValueError(f"{group.label}: a focus height is for a laser's beam; clear it to {verb} the group")

    def _check_dots(self, job: "Job") -> None:
        """A dispensing group is dots: one point a path, with the pad's
        area beside each."""
        if self.dispense is None:
            return
        for group in job.groups:
            if not group.enabled or not group.has_cuts:
                continue
            if group.joints:
                raise ValueError(f"{group.label}: a joint-space group cannot be dispensed")
            if any(len(path) != 1 for path in group.paths):
                raise ValueError(f"{group.label}: a dispenser lays dots, one point a path: import the board with mode dispense")
            if len(group.areas) != len(group.paths) or any(not (math.isfinite(a) and a > 0.0) for a in group.areas):
                raise ValueError(f"{group.label}: every dot needs its pad's area above 0")

    def _check_speeds(self, job: "Job") -> None:
        if self.spindle is None:
            return
        for group in job.groups:
            if group.enabled and group.has_cuts and not group.power > 0:
                raise ValueError(f"{group.label}: a spindle needs a speed above 0")

    def _spindle_pieces(self, job: "Job", start: Joint, compensation: "Compensation | None") -> Iterator[Piece]:
        """Every line of a milling job.

        The tool rises to the travel height before anything moves across
        the board, then the spindle starts and is given its spin-up. Each
        path is a rapid to its start at the travel height, a plunge at the
        group's plunge rate, the cuts at depth and a rise back. A group's
        passes go a step deeper each time, down to its depth. The spindle
        changes speed between groups that ask for another, and stops at
        the end, with the tool up.
        """
        assert self.spindle is not None
        self._check_speeds(job)
        travel = self.travel_height(compensation)
        spinup_ms = int(round(self.spindle.spinup * 1000.0))

        def surface(point: Point) -> float:
            return compensation.focus(point) if compensation is not None else 0.0

        joint = start
        speed: float | None = None
        last_group: int | None = None
        yield self._lift(travel, None, None, joint)
        h = travel
        for index, group in enumerate(job.groups):
            if not group.enabled:
                continue
            if group.joints:
                raise ValueError(f"{group.label}: a joint-space group cannot be milled")
            last_group = index
            feed = float(group.speed)
            plunge = float(group.plunge)
            wanted = float(group.power) if self.spindle.full is None else float(self.spindle.full)
            if wanted != speed:
                speed = wanted
                yield Piece(line=f"spindle S{num(speed)}", kind="spindle", joint=joint, group=index)
                if spinup_ms > 0:
                    yield Piece(line=f"dwell T{spinup_ms}", kind="dwell", joint=joint, seconds=spinup_ms / 1000.0, group=index)
            if group.moves:
                joint, h = yield from self._carve_pieces(group, index, joint, h, travel, surface, compensation)
                continue
            passes = max(1, int(group.passes))
            for k in range(1, passes + 1):
                depth = float(group.depth) * k / passes
                for path in group.paths:
                    points = [tuple(p) for p in path]
                    if not points:
                        continue
                    if len(points) == 1 or all(p == points[0] for p in points):
                        # A drill: the bit goes down at the point and up.
                        first = self._path_start(points[0], joint)
                        if not self._same(joint, first):
                            yield self._go(joint, first, index)
                            joint = first
                        bottom = surface(self.board_of(joint)) - depth
                        yield self._plunge(bottom, h, plunge, index, joint)
                        yield self._lift(travel, bottom, index, joint)
                        h = travel
                        continue
                    plunged = False
                    for kind, a, b, p, q in self._path_moves(points, joint):
                        if kind == "go":
                            yield self._go(a, b, index)
                            joint = b
                            continue
                        if not plunged:
                            bottom = surface(self.board_of(joint)) - depth
                            yield self._plunge(bottom, h, plunge, index, joint)
                            h = bottom
                            plunged = True
                        if kind == "turn":
                            # On the axis the tool stays on one board point
                            # while the table turns under it.
                            yield Piece(
                                line=f"go {self.words(b, radius=False)} H{coord(h, FOCUS_DECIMALS)}",
                                kind="turn",
                                joint=b,
                                seconds=self._rapid_seconds(a, b),
                                group=index,
                                h=h,
                            )
                            joint = b
                            continue
                        seconds, limited = self._cut_cost(a, b, feed)
                        length = math.dist(p, q)
                        # With a map the cut is split so the depth follows
                        # the surface along it; without one it is flat.
                        parts = 1 if compensation is None else max(1, math.ceil(length / compensation.step - 1e-9))
                        previous = a
                        for n in range(1, parts + 1):
                            end = b if n == parts else _lerp_joint(a, b, n / parts)
                            h = surface(self.board_of(end)) - depth
                            yield Piece(
                                line=self.cut_line(end, feed, None, None, h),
                                kind="cut",
                                joint=end,
                                seconds=seconds / parts,
                                length=length / parts,
                                limited=limited,
                                group=index,
                                start=previous,
                                feed=feed,
                                h=h,
                            )
                            previous = end
                        joint = b
                    if plunged:
                        yield self._lift(travel, h, index, joint)
                        h = travel
        yield Piece(line="spindle off", kind="spindle", joint=joint, group=last_group)

    def _carve_pieces(self, group, index: int, joint: Joint, h: float, travel: float, surface, compensation):
        """A model's moves: each path from the travel height down to its
        first point, its moves as they are with the surface under them
        added to their height, and up again. A move's feed is along it in
        three dimensions, and `F` is the board speed, so a move that also
        rises or falls is given the share of the feed that lies on the
        board; one that only goes up or down takes the feed as it is.
        Returns the joint and the height it leaves the tool at."""
        if not self.cartesian:
            raise ValueError(f"{group.label}: a model's moves need the cartesian machine ($cartesian=1)")
        feed = float(group.speed)
        plunge = float(group.plunge)
        for path in group.moves:
            if not path:
                continue
            x, y, z, kind = path[0]
            first = self.joint_at((float(x), float(y)))
            if abs(h - travel) > 1e-9:
                yield self._lift(travel, h, index, joint)
                h = travel
            if not self._same(joint, first):
                yield self._go(joint, first, index)
                joint = first
            down = surface((float(x), float(y))) + float(z)
            if kind == MOVE_RAPID:
                yield Piece(
                    line=f"go H{coord(down, FOCUS_DECIMALS)}",
                    kind="go",
                    joint=joint,
                    seconds=abs(h - down) / self.rates.h_rate * 60.0,
                    group=index,
                    h=down,
                )
            else:
                yield self._plunge(down, h, plunge, index, joint)
            h = down
            at = (float(x), float(y), float(z))
            for x, y, z, kind in path[1:]:
                x, y, z = float(x), float(y), float(z)
                if kind == MOVE_RAPID:
                    target = self.joint_at((x, y))
                    high = surface((x, y)) + z
                    seconds = max(self._rapid_seconds(joint, target), abs(high - h) / self.rates.h_rate * 60.0)
                    yield Piece(line=f"go {self.words(target, h=high)}", kind="go", joint=target, seconds=seconds, group=index, h=high)
                    joint, h, at = target, high, (x, y, z)
                    continue
                rate = plunge if kind == MOVE_PLUNGE else feed
                run = math.hypot(x - at[0], y - at[1])
                # With a map the move is split so the height follows the
                # surface along it.
                parts = 1 if compensation is None or run <= 0.0 else max(1, math.ceil(run / compensation.step - 1e-9))
                for n in range(1, parts + 1):
                    t = n / parts
                    point = (at[0] + t * (x - at[0]), at[1] + t * (y - at[1]))
                    end = self.joint_at(point)
                    high = surface(point) + at[2] + t * (z - at[2])
                    piece = run / parts
                    if piece < 1e-9:
                        yield self._plunge(high, h, rate, index, joint)
                        h = high
                        continue
                    rise = high - h
                    board_feed = rate * piece / math.hypot(piece, rise)
                    seconds, limited = self._carve_cost(joint, end, rise, board_feed)
                    yield Piece(
                        line=self.cut_line(end, board_feed, None, None, high),
                        kind="cut",
                        joint=end,
                        seconds=seconds,
                        length=piece,
                        limited=limited,
                        group=index,
                        start=joint,
                        feed=board_feed,
                        h=high,
                    )
                    joint, h = end, high
                at = (x, y, z)
            yield self._lift(travel, h, index, joint)
            h = travel
        return joint, h

    def _carve_cost(self, a: Joint, b: Joint, rise: float, board_feed: float) -> tuple[float, bool]:
        """Seconds for a move across the board and up or down, and whether
        an axis' rate rather than its feed sets them."""
        seconds, limited = self._cut_cost(a, b, board_feed)
        held = abs(rise) / self.rates.h_rate * 60.0
        if held > seconds * (1.0 + 1e-9):
            return held, True
        return seconds, limited

    # --- dispensing -------------------------------------------------------

    def _dispense_pieces(self, job: "Job", start: Joint, compensation: "Compensation | None") -> Iterator[Piece]:
        """Every line of a dispensing job.

        The plunger is declared at 0 first, so its targets count the dots
        from the run's start whatever it read before, and a run picked up
        part way can declare it again. The head rises to the travel height,
        and for each dot goes over the pad, lowers the needle to the gap
        over the surface, pushes out the dot's volume plus the last retract,
        waits, pulls the plunger back and rises. The plunger ends every dot
        retracted, and its position grows by the dots' volumes alone.
        """
        dispense = self.dispense
        assert dispense is not None
        self.check_tools(job)
        self._check_dots(job)
        travel = self.travel_height(compensation)
        a_rate = self.rates.a_rate

        def surface(point: Point) -> float:
            return compensation.focus(point) if compensation is not None else 0.0

        joint = start
        plunger = 0.0
        yield Piece(line="set A0", kind="plunger", joint=joint)
        yield self._lift(travel, None, None, joint)
        h = travel
        for index, group in enumerate(job.groups):
            if not group.enabled or not group.has_cuts:
                continue
            thickness = float(group.thickness)
            for path, area in zip(group.paths, group.areas):
                point = (float(path[0][0]), float(path[0][1]))
                target = self._path_start(point, joint)
                if not self._same(joint, target):
                    yield self._go(joint, target, index)
                    joint = target
                low = surface(point) + dispense.gap
                yield Piece(
                    line=f"go H{coord(low, FOCUS_DECIMALS)}",
                    kind="lower",
                    joint=joint,
                    seconds=abs(h - low) / self.rates.h_rate * 60.0,
                    group=index,
                    h=low,
                )
                h = low
                volume = dispense.plunger_mm(float(area), thickness)
                push = dispense.retract + volume
                yield Piece(
                    line=f"cut A{coord(plunger + push, FOCUS_DECIMALS)} F{num(dispense.rate)}",
                    kind="extrude",
                    joint=joint,
                    seconds=push / dispense.rate * 60.0,
                    group=index,
                    feed=dispense.rate,
                    h=h,
                )
                plunger += volume
                if dispense.dwell_ms > 0:
                    yield Piece(line=f"dwell T{int(dispense.dwell_ms)}", kind="dwell", joint=joint, seconds=dispense.dwell_ms / 1000.0, group=index, h=h)
                if dispense.retract > 0.0:
                    yield Piece(
                        line=f"go A{coord(plunger, FOCUS_DECIMALS)}",
                        kind="retract",
                        joint=joint,
                        seconds=dispense.retract / a_rate * 60.0,
                        group=index,
                        h=h,
                    )
                yield self._lift(travel, h, index, joint)
                h = travel

    # --- picking a job up part way ----------------------------------------

    @staticmethod
    def rewind(pieces: list[Piece], index: int) -> int:
        """The first line of the path `pieces[index]` is part of: back over
        the cuts, turns and the plunge before it, and the rapid that
        brought the head to the path. A run picked up there cuts the whole
        path again rather than leaving a gap where a count one line off
        would have skipped a segment."""
        index = max(0, min(index, len(pieces)))
        while index > 0 and pieces[index - 1].kind in ("cut", "turn", "plunge"):
            index -= 1
        if index > 0 and pieces[index - 1].kind == "go":
            index -= 1
        return index

    def approach(
        self,
        pieces: list[Piece],
        skip: int,
        job: "Job",
        compensation: "Compensation | None",
    ) -> list[str]:
        """The lines that bring a head at rest, its output off, to where
        `pieces[skip]` begins, so the lines from there on land where the
        whole job would have put them.

        With a spindle the tool rises to the travel height first, goes
        over the point, the spindle is started at the speed the job had
        in force there and given its spin-up, and, when the next line is a
        cut at depth, the tool plunges to the depth that cut starts at.
        With a laser the head goes dark to the point, at the focus height
        the job had there when it follows the height map. With a dispenser
        the plunger is declared where the plan had it, the needle rises to
        the travel height and goes over the pad, and down to the gap when
        the line picked up is in the middle of a dot.
        """
        if skip <= 0 or skip > len(pieces):
            return []
        joint: Joint | None = None
        h: float | None = None
        speed: float | None = None
        plunger = 0.0
        for piece in pieces[:skip]:
            if piece.kind in ("go", "turn", "cut", "plunge", "lower", "extrude", "dwell", "retract"):
                joint = piece.joint
            if piece.h is not None:
                h = piece.h
            if piece.kind == "spindle":
                speed = _spindle_speed(piece.line)
            if piece.kind in ("extrude", "retract"):
                plunger = _plunger_target(piece.line, plunger)
        piece = pieces[skip] if skip < len(pieces) else None
        target = piece.start if piece is not None and piece.kind == "cut" and piece.start is not None else joint
        lines: list[str] = []
        if self.dispense is not None:
            travel = self.travel_height(compensation)
            lines.append(f"set A{coord(plunger, FOCUS_DECIMALS)}")
            lines.append(f"go H{coord(travel, FOCUS_DECIMALS)}")
            if target is not None:
                lines.append(f"go {self.words(target)}")
            if piece is not None and piece.kind in ("extrude", "dwell", "retract") and h is not None:
                lines.append(f"go H{coord(h, FOCUS_DECIMALS)}")
            return lines
        if self.spindle is None:
            if target is not None:
                lines.append(f"go {self.words(target, h=h)}")
            return lines
        travel = self.travel_height(compensation)
        lines.append(f"go H{coord(travel, FOCUS_DECIMALS)}")
        if target is not None:
            lines.append(f"go {self.words(target)}")
        if speed is not None and (piece is None or piece.kind != "spindle"):
            lines.append(f"spindle S{num(speed)}")
            spinup_ms = int(round(self.spindle.spinup * 1000.0))
            if spinup_ms > 0:
                lines.append(f"dwell T{spinup_ms}")
        if piece is not None and piece.kind in ("cut", "turn") and h is not None and piece.group is not None:
            plunge = float(job.groups[piece.group].plunge)
            lines.append(f"cut H{coord(h, FOCUS_DECIMALS)} F{num(plunge)}")
        return lines

    def renumber_for(self, pieces: list[Piece], skip: int, status) -> str | None:
        """A `set A` that gives the table, as the status reports it, the
        angle the plan counts it at: a job's angles are unwrapped from
        where the run began, and a machine that has started over since
        reads the same orientation turns apart. None when nothing needs
        saying, and always on a cartesian machine, whose table holds."""
        if self.cartesian or skip <= 0 or skip > len(pieces):
            return None
        joint: Joint | None = None
        for piece in pieces[:skip]:
            if piece.kind in ("go", "turn", "cut", "plunge"):
                joint = piece.joint
        if joint is None:
            return None
        declared = polar.unwrap(status.a, joint[1])
        if abs(declared - status.a) < 0.5 * 10.0 ** -ANGLE_DECIMALS:
            return None
        return f"set A{num(declared, ANGLE_DECIMALS)}"

    def estimate(
        self,
        job: "Job",
        start: Joint = (0.0, 0.0),
        compensation: "Compensation | None" = None,
        pieces: list[Piece] | None = None,
    ) -> Stats:
        """What the job costs from `start`, and the print of its lines.
        `pieces` is the job's lines already made from that start, when the
        caller has them, so they are not made twice."""
        stats = Stats()
        printed = PlanPrint()
        limited = 0.0
        radii: list[float] = []
        lows: list[float] = []
        for group in job.groups:
            if not group.enabled:
                continue
            if group.joints:
                for poly in group.joints:
                    joints = [(float(r), float(a)) for r, a in poly]
                    if not joints:
                        continue
                    radii.append(max(abs(r) for r, _ in joints))
                    lows.append(joint_min_radius(joints))
                continue
            for path in group.board_paths():
                points = [tuple(p) for p in path]
                if not points:
                    continue
                radii.append(max(polar.radius_of(p) for p in points))
                lows.append(polar.path_min_radius(points))
        for piece in pieces if pieces is not None else self.job_pieces(job, start, compensation):
            stats.moves += 1
            stats.seconds += piece.seconds
            stats.length_mm += piece.length
            if piece.limited:
                limited += piece.length
            printed.add(piece)
        stats.max_radius = max(radii) if radii else 0.0
        stats.min_radius = min(lows) if lows else 0.0
        stats.limited_fraction = limited / stats.length_mm if stats.length_mm > 0 else 0.0
        stats.fingerprint = printed.hexdigest()
        return stats

    # --- jogs -------------------------------------------------------------

    def board_targets(self, start: Joint, target: Point) -> list[tuple[Joint, bool]]:
        """Joint targets on the way to a board point from a joint; True marks a turn."""
        out: list[tuple[Joint, bool]] = []
        point = polar.cartesian(start)
        joint = start
        if joint[0] < 0.0:
            # The head is past the axis, where lining it up leaves it. A
            # board line from there is no joint line: the angle of every
            # point on the near side is half a turn from the one the head
            # is at. It comes back to the axis along the rail first, and
            # leaves it the usual way, with a turn on the spot.
            joint = (0.0, joint[1])
            point = (0.0, 0.0)
            out.append((joint, False))
        for next_point, next_joint, turn in self._moves(point, target, joint):
            out.append((next_joint, turn))
            point, joint = next_point, next_joint
        return out

    def jog_lines(self, targets: list[tuple[Joint, bool]], feed: float | None = None) -> list[str]:
        """`jogto` lines for joint targets; a turn carries only the angle word."""
        suffix = f" F{num(feed)}" if feed else ""
        return [f"jogto {self.words(joint, radius=not turn)}{suffix}" for joint, turn in targets]

    def joint_jog(
        self, dr: float | None, da: float | None, feed: float | None = None, dh: float | None = None, dz: float | None = None
    ) -> str:
        return self._joint_line("jog", dr, da, feed, dh, dz)

    def joint_goto(
        self, r: float | None, a: float | None, feed: float | None = None, h: float | None = None, z: float | None = None
    ) -> str:
        # A negative radius is the far side of the axis. A job can never
        # ask for one, but lining the head up with the axis means stepping
        # through zero, so a jog may.
        return self._joint_line("jogto", r, a, feed, h, z)

    def slide_jog(self, dz: float, feed: float | None = None) -> str:
        """`jog Z<mm>`: the cross slide is a setup axis and moves on its own."""
        if dz == 0.0:
            raise ValueError("a cross slide jog needs a distance")
        return self._slide_line("jog", dz, feed)

    def slide_goto(self, z: float, feed: float | None = None) -> str:
        return self._slide_line("jogto", z, feed)

    def _slide_line(self, keyword: str, z: float, feed: float | None) -> str:
        _finite(z, feed)
        # Z is never put on a line with R or A: the three are not
        # interpolated together, so the firmware refuses the combination.
        words = [f"Z{num(z, DECIMALS)}"]
        if feed:
            words.append(f"F{num(feed)}")
        return f"{keyword} {' '.join(words)}"

    def _joint_line(
        self,
        keyword: str,
        r: float | None,
        a: float | None,
        feed: float | None,
        h: float | None = None,
        z: float | None = None,
    ) -> str:
        _finite(r, a, feed, h, z)
        words = []
        if r is not None and (keyword == "jogto" or r != 0.0):
            words.append(f"R{num(r, DECIMALS)}")
        if a is not None and (keyword == "jogto" or a != 0.0):
            words.append(f"A{num(a, ANGLE_DECIMALS)}")
        # The focus axis, which the firmware refuses without one fitted.
        if h is not None and (keyword == "jogto" or h != 0.0):
            words.append(f"H{num(h, FOCUS_DECIMALS)}")
        # The cross slide beside the others: a joint only on a cartesian
        # machine, and the firmware refuses it elsewhere.
        if z is not None and (keyword == "jogto" or z != 0.0):
            words.append(f"Z{num(z, DECIMALS)}")
        if not words:
            raise ValueError("a joint move needs a radius, an angle, a focus height or a cross slide position")
        if feed:
            words.append(f"F{num(feed)}")
        return f"{keyword} {' '.join(words)}"


def _article(tool: str | None) -> str:
    return {SPINDLE: "a spindle", DISPENSER: "a dispenser"}.get(tool or "", "a laser")


def _plunger_target(line: str, fallback: float) -> float:
    """The `A` of a plunger line."""
    for word in line.split():
        if word[0] == "A":
            try:
                return float(word[1:])
            except ValueError:
                return fallback
    return fallback


def head_board(r: float, a: float, z: float, cartesian: bool) -> Point:
    """The board point under the beam. On a polar machine the cross slide
    is calibration that puts the rail over the axis, so it is left out, as
    everything polar leaves it out; on a cartesian machine the head is at
    R along the rail and Z across it, turned by the table angle."""
    if cartesian:
        return alignment.turn((r, z), a)
    return polar.cartesian((r, a))


class CartesianStreamer(Streamer):
    """The streamer for a machine whose cross slide is a joint.

    A joint is (radius, cross slide) in mm: the head's place along the rail
    and across it. The table holds `angle` degrees throughout, and a board
    point is that head position turned by it, the same frame a polar job
    uses when the slide's zero puts the rail over the axis. A board line is
    a joint line, so it goes out as one `cut` with no subdivision, and the
    axis is nothing special.
    """

    cartesian = True

    def __init__(self, angle: float = 0.0, **kwargs) -> None:
        super().__init__(**kwargs)
        if not math.isfinite(angle):
            raise ValueError("the table angle must be a number")
        self.angle = angle

    def start_of(self, status) -> Joint:
        return (status.r, status.z)

    def board_of(self, joint: Joint) -> Point:
        return alignment.turn(joint, self.angle)

    def joint_at(self, point: Point) -> Joint:
        return alignment.turn(point, -self.angle)

    def _path_start(self, point: Point, joint: Joint) -> Joint:
        return self.joint_at(point)

    def words(self, joint: Joint, radius: bool = True, h: float | None = None) -> str:
        parts = [f"R{coord(joint[0], DECIMALS)}", f"Z{coord(joint[1], DECIMALS)}"]
        if h is not None:
            parts.append(f"H{coord(h, FOCUS_DECIMALS)}")
        return " ".join(parts)

    def _same(self, a: Joint, b: Joint) -> bool:
        quantum = 0.5 * 10.0 ** -DECIMALS
        return abs(a[0] - b[0]) < quantum and abs(a[1] - b[1]) < quantum

    def _rapid_seconds(self, a: Joint, b: Joint) -> float:
        return max(abs(b[0] - a[0]) / self.rates.r_rate, abs(b[1] - a[1]) / self.rates.z_rate) * 60.0

    def _cut_cost(self, a: Joint, b: Joint, feed: float) -> tuple[float, bool]:
        surface = math.dist(a, b)
        minutes = surface / feed if feed > 0 else 0.0
        actual = max(minutes, abs(b[0] - a[0]) / self.rates.r_rate, abs(b[1] - a[1]) / self.rates.z_rate)
        limited = actual > minutes * (1.0 + 1e-9) and surface > 0.0
        return actual * 60.0, limited

    def _moves(self, point: Point, target: Point, joint: Joint) -> Iterator[tuple[Point, Joint, bool]]:
        next_joint = self.joint_at(target)
        if not self._same(joint, next_joint):
            yield target, next_joint, False

    def _joint_group_pieces(self, group, index, joint, feed, power, floor):
        raise ValueError(f"{group.label}: a joint-space group needs the polar machine ($cartesian=0)")

    def board_targets(self, start: Joint, target: Point) -> list[tuple[Joint, bool]]:
        return [(self.joint_at(target), False)]
