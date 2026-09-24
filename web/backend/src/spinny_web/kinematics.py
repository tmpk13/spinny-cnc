"""Board geometry to joint-space protocol lines.

The firmware moves straight lines in joint space, so every board polyline
is subdivided with `spinny_laser.polar` until linear joint interpolation
stays within the chord tolerance, and each piece becomes one `cut`, `go` or
`jogto` line. A segment that passes within half a coordinate quantum of the
axis is split there: the crossing becomes a radial move in, a turn on the
spot with the beam off, and a radial move out, since a spiral out of the
axis can never be made straight by subdividing it.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Iterator

from spinny_laser import polar
from spinny_laser.polar import Joint, Kinematics, Point

if TYPE_CHECKING:
    from .jobs import Job

DECIMALS = 3
ANGLE_DECIMALS = 4
DEFAULT_TOLERANCE = 0.005


@dataclass(frozen=True)
class Rates:
    """The firmware's axis limits, for the time estimate. The defaults
    are the firmware's own, for a job priced before a machine is read."""

    r_rate: float = 560.0
    a_rate: float = 400.0

    @classmethod
    def from_settings(cls, values: dict) -> "Rates":
        rates = cls()
        try:
            r_rate = float(values.get("r_rate", rates.r_rate))
            a_rate = float(values.get("a_rate", rates.a_rate))
            r_steps = float(values.get("r_steps", 0.0))
            a_steps = float(values.get("a_steps", 0.0))
            step_us = int(float(values.get("step_us", 2)))
        except (TypeError, ValueError):
            return rates
        r_rate = r_rate if r_rate > 0 else rates.r_rate
        a_rate = a_rate if a_rate > 0 else rates.a_rate
        # The planner caps each axis by the step generator as well as by
        # its rate setting, and the estimate follows the lower of the two.
        ceiling = step_ceiling_hz(step_us)
        if r_steps > 0:
            r_rate = min(r_rate, ceiling * 60.0 / r_steps)
        if a_steps > 0:
            a_rate = min(a_rate, ceiling * 60.0 / a_steps)
        return cls(r_rate, a_rate)


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
    """Turns board moves into protocol lines, and prices them."""

    def __init__(
        self,
        tolerance: float = DEFAULT_TOLERANCE,
        rates: Rates | None = None,
        decimals: int = DECIMALS,
        angle_decimals: int = ANGLE_DECIMALS,
    ) -> None:
        self.kinematics = Kinematics(tolerance)
        self.rates = rates or Rates()
        self.decimals = decimals
        self.angle_decimals = angle_decimals
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

    # --- words ------------------------------------------------------------

    def words(self, joint: Joint, radius: bool = True, angle: bool = True) -> str:
        parts = []
        if radius:
            parts.append(f"R{coord(joint[0], self.decimals)}")
        if angle:
            parts.append(f"A{coord(joint[1], self.angle_decimals)}")
        return " ".join(parts)

    def _same(self, a: Joint, b: Joint) -> bool:
        return (
            abs(a[0] - b[0]) < 0.5 * 10.0 ** -self.decimals
            and abs(a[1] - b[1]) < 0.5 * 10.0 ** -self.angle_decimals
        )

    # --- pieces of a board move --------------------------------------------

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

    # --- jobs -------------------------------------------------------------

    def job_pieces(self, job: "Job", start: Joint) -> Iterator[Piece]:
        """Every protocol line of the job, lazily, from the machine's joint."""
        joint = start
        for index, group in enumerate(job.groups):
            if not group.enabled:
                continue
            feed = float(group.speed)
            power = float(group.power)
            # `M` is not modal, so a group without a floor leaves it off.
            floor = f" M{num(min(float(group.min_power), power))}" if group.min_power > 0 else ""
            if group.joints:
                # Joint-space paths go out as they are: each pair of points
                # is one move, and a negative radius is the far side of the
                # axis. Only whole turns are added, so the table does not
                # swing the long way round to a start that is the same
                # place a turn away.
                for poly in group.joints:
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
                            line=f"cut {self.words(target)} F{num(feed)} S{num(power)}{floor}",
                            kind="cut",
                            joint=target,
                            seconds=seconds,
                            length=surface_length(joint, target),
                            limited=limited,
                            group=index,
                        )
                        joint = target
                continue
            for path in group.paths:
                points = [tuple(p) for p in path]
                if len(points) < 2:
                    continue
                first = joint_of(points[0], joint[1])
                if first[0] < self.snap:
                    # The word written is R0.000: the head is on the axis,
                    # and the joint tracked must say so or the move away
                    # from it is cut as a spiral instead of a turn.
                    first = (0.0, first[1])
                if not self._same(joint, first):
                    yield Piece(
                        line=f"go {self.words(first)}",
                        kind="go",
                        joint=first,
                        seconds=self._rapid_seconds(joint, first),
                        group=index,
                    )
                    joint = first
                point = points[0]
                for target in points[1:]:
                    for next_point, next_joint, turn in self._moves(point, target, joint):
                        if turn:
                            yield Piece(
                                line=f"go {self.words(next_joint, radius=False)}",
                                kind="turn",
                                joint=next_joint,
                                seconds=self._rapid_seconds(joint, next_joint),
                                group=index,
                            )
                        else:
                            seconds, limited = self._cut_cost(joint, next_joint, feed)
                            # Every cut carries its own feed and power. The
                            # firmware keeps them modal, but it forgets them
                            # on a reset, and a reset part way through a run
                            # would otherwise leave every line after it
                            # refused for a missing word rather than simply
                            # stopping the run.
                            line = f"cut {self.words(next_joint)} F{num(feed)} S{num(power)}{floor}"
                            yield Piece(
                                line=line,
                                kind="cut",
                                joint=next_joint,
                                seconds=seconds,
                                length=math.dist(point, next_point),
                                limited=limited,
                                group=index,
                            )
                        point, joint = next_point, next_joint
                    point = target

    def estimate(self, job: "Job", start: Joint = (0.0, 0.0)) -> Stats:
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
        for piece in self.job_pieces(job, start):
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
        here = board_of(start)
        return self.board_move(start, (here[0] + dx, here[1] + dy), feed)

    def board_goto(self, start: Joint, x: float, y: float, feed: float | None = None) -> list[str]:
        return self.board_move(start, (x, y), feed)

    def joint_jog(self, dr: float | None, da: float | None, feed: float | None = None) -> str:
        return self._joint_line("jog", dr, da, feed)

    def joint_goto(self, r: float | None, a: float | None, feed: float | None = None) -> str:
        # A negative radius is the far side of the axis. A job can never
        # ask for one, but lining the head up with the axis means stepping
        # through zero, so a jog may.
        return self._joint_line("jogto", r, a, feed)

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

    def _joint_line(self, keyword: str, r: float | None, a: float | None, feed: float | None) -> str:
        _finite(r, a, feed)
        words = []
        if r is not None and (keyword == "jogto" or r != 0.0):
            words.append(f"R{num(r, self.decimals)}")
        if a is not None and (keyword == "jogto" or a != 0.0):
            words.append(f"A{num(a, self.angle_decimals)}")
        if not words:
            raise ValueError("a joint move needs a radius or an angle")
        if feed:
            words.append(f"F{num(feed)}")
        return f"{keyword} {' '.join(words)}"
