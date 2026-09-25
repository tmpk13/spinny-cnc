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
import math
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Iterator

from spinny_laser import polar
from spinny_laser.polar import Joint, Kinematics, Point

if TYPE_CHECKING:
    from .heightmap import Compensation
    from .jobs import Job

DECIMALS = 3
ANGLE_DECIMALS = 4
# The focus axis word: a tenth of a micron is under a step at any usual scale.
FOCUS_DECIMALS = 4
DEFAULT_TOLERANCE = 0.005


@dataclass(frozen=True)
class Rates:
    """The firmware's axis limits, for the time estimate. The defaults
    are the firmware's own, for a job priced before a machine is read."""

    r_rate: float = 560.0
    a_rate: float = 400.0
    # The cross slide as a joint, and the focus axis.
    z_rate: float = 560.0
    h_rate: float = 600.0

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

    def __post_init__(self) -> None:
        if not (math.isfinite(self.clearance) and 0.0 < self.clearance <= 100.0):
            raise ValueError("the clearance must be above 0 and at most 100 mm")
        if not (math.isfinite(self.spinup) and 0.0 <= self.spinup <= 600.0):
            raise ValueError("the spin-up must be 0 to 600 s")


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


@dataclass
class Stats:
    length_mm: float = 0.0
    seconds: float = 0.0
    max_radius: float = 0.0
    min_radius: float = 0.0
    limited_fraction: float = 0.0
    moves: int = 0

    def to_dict(self) -> dict:
        return {
            "length_mm": round(self.length_mm, 3),
            "seconds": round(self.seconds, 1),
            "max_radius": round(self.max_radius, 3),
            "min_radius": round(self.min_radius, 3),
            "limited_fraction": round(self.limited_fraction, 4),
            "moves": self.moves,
        }


def board_of(joint: Joint) -> Point:
    return polar.cartesian(joint)


def joint_of(point: Point, previous_angle: float) -> Joint:
    return polar.joint_of(point, previous_angle)


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
        if value is not None and not (math.isfinite(value) and abs(value) <= 1.0e6):
            raise ValueError("a move needs numbers within 1e6")


def coord(value: float, decimals: int) -> str:
    """A fixed-decimal coordinate word value without a negative zero."""
    text = f"{value:.{decimals}f}"
    if text.startswith("-") and float(text) == 0.0:
        text = text[1:]
    return text


def surface_length(a: Joint, b: Joint) -> float:
    """Board length of one joint move, as the firmware reckons it."""
    arc = (a[0] + b[0]) / 2.0 * math.radians(b[1] - a[1])
    return math.hypot(b[0] - a[0], arc)


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


def joint_min_radius(poly: list[Joint]) -> float:
    """Nearest a joint polyline comes to the axis; zero when a move crosses it."""
    for a, b in zip(poly, poly[1:]):
        if (a[0] < 0.0) != (b[0] < 0.0):
            return 0.0
    return min(abs(r) for r, _ in poly)


def joint_preview(poly: list[Joint], step_mm: float = 0.1, step_deg: float = 1.0) -> list[Point]:
    """Board points along a joint polyline, close enough to draw it."""
    return polar.sample_joints([(float(r), float(a)) for r, a in poly], step_mm, step_deg)


# Shared with the command line tools, which cut a path at the axis the
# same way before subdividing it.
split_at_axis = polar.split_at_axis


class Streamer:
    """Turns board moves into protocol lines, and prices them.

    This one is for the polar machine: a joint is (radius, angle). The
    methods between `start_of` and `_moves` are what a frame decides, and
    `CartesianStreamer` gives them for a machine whose cross slide is a
    joint. `spindle` turns a job into milling.
    """

    cartesian = False

    def __init__(
        self,
        tolerance: float = DEFAULT_TOLERANCE,
        rates: Rates | None = None,
        decimals: int = DECIMALS,
        angle_decimals: int = ANGLE_DECIMALS,
        spindle: Spindle | None = None,
    ) -> None:
        self.kinematics = Kinematics(tolerance)
        self.rates = rates or Rates()
        self.decimals = decimals
        self.angle_decimals = angle_decimals
        self.spindle = spindle
        # A segment within this of the axis is cut there and crosses it
        # with a dark turn. Half a word quantum is the least that makes
        # the words agree; the chord tolerance is the most the path may
        # be moved by, and a pass between the two would otherwise be
        # streamed as chords sweeping half a turn of the table at a radius
        # of microns, seconds of the beam on one spot under `mode const`.
        self.snap = max(0.5 * 10.0 ** -decimals, tolerance)

    @property
    def tolerance(self) -> float:
        return self.kinematics.tolerance

    # --- the frame ----------------------------------------------------------

    def start_of(self, status) -> Joint:
        """The joint a status report puts the head at, in this frame."""
        return (status.r, status.a)

    def board_of(self, joint: Joint) -> Point:
        return board_of(joint)

    def _path_start(self, point: Point, joint: Joint) -> Joint:
        """The joint that puts the beam over the first point of a path."""
        first = joint_of(point, joint[1])
        if first[0] < self.snap:
            # The word written is R0.000: the head is on the axis, and the
            # joint tracked must say so or the move away from it is cut as
            # a spiral instead of a turn.
            first = (0.0, first[1])
        return first

    def words(self, joint: Joint, radius: bool = True, angle: bool = True, h: float | None = None) -> str:
        parts = []
        if radius:
            parts.append(f"R{coord(joint[0], self.decimals)}")
        if angle:
            parts.append(f"A{coord(joint[1], self.angle_decimals)}")
        if h is not None:
            parts.append(f"H{coord(h, FOCUS_DECIMALS)}")
        return " ".join(parts)

    def _same(self, a: Joint, b: Joint) -> bool:
        return (
            abs(a[0] - b[0]) < 0.5 * 10.0 ** -self.decimals
            and abs(a[1] - b[1]) < 0.5 * 10.0 ** -self.angle_decimals
        )

    def surface_length(self, a: Joint, b: Joint) -> float:
        return surface_length(a, b)

    def _rapid_seconds(self, a: Joint, b: Joint) -> float:
        dr = abs(b[0] - a[0])
        da = abs(b[1] - a[1])
        return max(dr / self.rates.r_rate, da / self.rates.a_rate) * 60.0

    def _cut_cost(self, a: Joint, b: Joint, feed: float) -> tuple[float, bool]:
        dr = abs(b[0] - a[0])
        da = abs(b[1] - a[1])
        surface = surface_length(a, b)
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
        compensated for the board's height when asked."""
        if self.spindle is not None:
            return self._spindle_pieces(job, start, compensation)
        pieces = self._job_pieces(job, start)
        if compensation is None:
            return pieces
        return self.compensate(pieces, compensation)

    def compensate(self, pieces: Iterator[Piece], compensation: "Compensation") -> Iterator[Piece]:
        """The pieces rewritten for the board's height.

        A cut is split along its joint line into pieces no longer than the
        compensation's step on the board. That is the same line the
        firmware would have moved, since it interpolates joints linearly,
        but the focus height or the power now follows the surface along it
        instead of changing once per cut. With the focus axis every line
        carries the focus height at its end, rapids and turns included, so
        the head is at focus when a cut begins; with power the rapids are
        left as they are.
        """
        focus = compensation.mode == "focus"
        for piece in pieces:
            if piece.kind == "cut" and piece.start is not None:
                a, b = piece.start, piece.joint
                parts = max(1, math.ceil(piece.length / compensation.step - 1e-9))
                previous = a
                for k in range(1, parts + 1):
                    joint = b if k == parts else _lerp_joint(a, b, k / parts)
                    if focus:
                        h = compensation.focus(self.board_of(joint))
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
                    )
                    previous = joint
            elif focus and piece.kind in ("go", "turn"):
                h = compensation.focus(self.board_of(piece.joint))
                yield dataclasses.replace(piece, line=f"{piece.line} H{coord(h, FOCUS_DECIMALS)}")
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
                yield Piece(
                    line=f"go {self.words(first)}",
                    kind="go",
                    joint=first,
                    seconds=self._rapid_seconds(joint, first),
                    group=index,
                )
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
                    length=surface_length(joint, target),
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
            if group.joints:
                joint = yield from self._joint_group_pieces(group, index, joint, feed, power, floor)
                continue
            for path in group.paths * passes:
                points = [tuple(p) for p in path]
                if len(points) < 2:
                    continue
                for kind, a, b, p, q in self._path_moves(points, joint):
                    if kind == "go":
                        yield Piece(
                            line=f"go {self.words(b)}",
                            kind="go",
                            joint=b,
                            seconds=self._rapid_seconds(a, b),
                            group=index,
                        )
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
        """Where the tool travels between cuts: the clearance over the
        surface, which is H 0 without a height map and its highest point
        with one."""
        assert self.spindle is not None
        top = compensation.highest() if compensation is not None else 0.0
        return top + self.spindle.clearance

    def _lift(self, h: float, frm: float | None, group: int | None) -> Piece:
        seconds = abs(h - frm) / self.rates.h_rate * 60.0 if frm is not None else 0.0
        return Piece(line=f"go H{coord(h, FOCUS_DECIMALS)}", kind="lift", joint=(0.0, 0.0), seconds=seconds, group=group)

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
        travel = self.travel_height(compensation)
        spinup_ms = int(round(self.spindle.spinup * 1000.0))

        def surface(point: Point) -> float:
            return compensation.focus(point) if compensation is not None else 0.0

        joint = start
        h: float | None = None
        speed: float | None = None
        last_group: int | None = None
        yield self._lift(travel, h, None)
        h = travel
        for index, group in enumerate(job.groups):
            if not group.enabled:
                continue
            if group.joints:
                raise ValueError(f"{group.label}: a joint-space group cannot be milled")
            last_group = index
            feed = float(group.speed)
            plunge = float(group.plunge)
            if group.power != speed:
                speed = float(group.power)
                yield Piece(line=f"spindle S{num(speed)}", kind="spindle", joint=joint, group=index)
                if spinup_ms > 0:
                    yield Piece(line=f"dwell T{spinup_ms}", kind="dwell", joint=joint, seconds=spinup_ms / 1000.0, group=index)
            passes = max(1, int(group.passes))
            for k in range(1, passes + 1):
                depth = float(group.depth) * k / passes
                for path in group.paths:
                    points = [tuple(p) for p in path]
                    if len(points) < 2:
                        continue
                    plunged = False
                    for kind, a, b, p, q in self._path_moves(points, joint):
                        if kind == "go":
                            yield Piece(
                                line=f"go {self.words(b)}",
                                kind="go",
                                joint=b,
                                seconds=self._rapid_seconds(a, b),
                                group=index,
                            )
                            joint = b
                            continue
                        if not plunged:
                            bottom = surface(self.board_of(joint)) - depth
                            yield Piece(
                                line=f"cut H{coord(bottom, FOCUS_DECIMALS)} F{num(plunge)}",
                                kind="plunge",
                                joint=joint,
                                seconds=abs((h if h is not None else bottom) - bottom) / plunge * 60.0,
                                group=index,
                            )
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
                            )
                            previous = end
                        joint = b
                    if plunged:
                        yield self._lift(travel, h, index)
                        h = travel
        yield Piece(line="spindle off", kind="spindle", joint=joint, group=last_group)

    def estimate(self, job: "Job", start: Joint = (0.0, 0.0), compensation: "Compensation | None" = None) -> Stats:
        stats = Stats()
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
            for path in group.paths:
                points = [tuple(p) for p in path]
                if not points:
                    continue
                radii.append(max(polar.radius_of(p) for p in points))
                lows.append(polar.path_min_radius(points))
        for piece in self.job_pieces(job, start, compensation):
            stats.moves += 1
            stats.seconds += piece.seconds
            stats.length_mm += piece.length
            if piece.limited:
                limited += piece.length
        stats.max_radius = max(radii) if radii else 0.0
        stats.min_radius = min(lows) if lows else 0.0
        stats.limited_fraction = limited / stats.length_mm if stats.length_mm > 0 else 0.0
        return stats

    # --- jogs -------------------------------------------------------------

    def board_targets(self, start: Joint, target: Point) -> list[tuple[Joint, bool]]:
        """Joint targets on the way to a board point from a joint; True marks a turn."""
        out: list[tuple[Joint, bool]] = []
        point = board_of(start)
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

    def board_move(self, start: Joint, target: Point, feed: float | None = None) -> list[str]:
        """`jogto` lines that take the beam to a board point from a joint."""
        _finite(target[0], target[1], feed)
        return self.jog_lines(self.board_targets(start, target), feed)

    def board_jog(self, start: Joint, dx: float, dy: float, feed: float | None = None) -> list[str]:
        here = self.board_of(start)
        return self.board_move(start, (here[0] + dx, here[1] + dy), feed)

    def board_goto(self, start: Joint, x: float, y: float, feed: float | None = None) -> list[str]:
        return self.board_move(start, (x, y), feed)

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
        words = [f"Z{num(z, self.decimals)}"]
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
            words.append(f"R{num(r, self.decimals)}")
        if a is not None and (keyword == "jogto" or a != 0.0):
            words.append(f"A{num(a, self.angle_decimals)}")
        # The focus axis, which the firmware refuses without one fitted.
        if h is not None and (keyword == "jogto" or h != 0.0):
            words.append(f"H{num(h, FOCUS_DECIMALS)}")
        # The cross slide beside the others: a joint only on a cartesian
        # machine, and the firmware refuses it elsewhere.
        if z is not None and (keyword == "jogto" or z != 0.0):
            words.append(f"Z{num(z, self.decimals)}")
        if not words:
            raise ValueError("a joint move needs a radius, an angle, a focus height or a cross slide position")
        if feed:
            words.append(f"F{num(feed)}")
        return f"{keyword} {' '.join(words)}"


def turned(point: Point, degrees: float) -> Point:
    """A point turned about the rotation axis, counterclockwise."""
    theta = math.radians(degrees)
    c, s = math.cos(theta), math.sin(theta)
    return (point[0] * c - point[1] * s, point[0] * s + point[1] * c)


def head_board(r: float, a: float, z: float, cartesian: bool) -> Point:
    """The board point under the beam. On a polar machine the cross slide
    is calibration that puts the rail over the axis, so it is left out, as
    everything polar leaves it out; on a cartesian machine the head is at
    R along the rail and Z across it, turned by the table angle."""
    if cartesian:
        return turned((r, z), a)
    return board_of((r, a))


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
        return turned(joint, self.angle)

    def joint_at(self, point: Point) -> Joint:
        return turned(point, -self.angle)

    def _path_start(self, point: Point, joint: Joint) -> Joint:
        return self.joint_at(point)

    def words(self, joint: Joint, radius: bool = True, angle: bool = True, h: float | None = None) -> str:
        parts = [f"R{coord(joint[0], self.decimals)}", f"Z{coord(joint[1], self.decimals)}"]
        if h is not None:
            parts.append(f"H{coord(h, FOCUS_DECIMALS)}")
        return " ".join(parts)

    def _same(self, a: Joint, b: Joint) -> bool:
        quantum = 0.5 * 10.0 ** -self.decimals
        return abs(a[0] - b[0]) < quantum and abs(a[1] - b[1]) < quantum

    def surface_length(self, a: Joint, b: Joint) -> float:
        return math.dist(a, b)

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
