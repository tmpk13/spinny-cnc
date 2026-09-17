"""Gcode emitter for the radius-and-angle machine.

Same dialect as the Cartesian tool (`G21`/`G90`, `M4` dynamic power, `S` on
the first cut move of each path, `M4 S0` at the end of each path), with two
changes forced by the kinematics:

- Every cut segment carries its own feed word, because the joint-space
  distance of a segment has nothing to do with its length on the board. The
  default is inverse time (`G93`): `F` is the number of such segments the
  controller may run per minute, so the surface speed comes out right no
  matter how the controller measures distance across a linear and a rotary
  axis. `scaled` stays in `G94` and scales `F` by the ratio of joint length
  to board length instead, for a controller whose rotary axis is set up as
  a linear one counting degrees.
- A segment that only turns the table (which only happens on the axis) is
  crossed with the beam off, since under `M4` the spot would otherwise dwell
  at full power on one point of the board.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from laser_sweep.backlash import format_coord

from . import polar
from .polar import Joint, Kinematics, Point

M4_DYNAMIC = "M4"
M3_CONSTANT = "M3"
INVERSE, SCALED = "inverse", "scaled"


@dataclass(frozen=True)
class PolarOptions:
    rotary_axis: str = "A"
    invert_rotary: bool = False
    # Machine X reading when the beam is over the rotation axis.
    axis_x: float = 0.0
    feed_mode: str = INVERSE
    # Controller units per degree, for `scaled`: 1 when the rotary axis is
    # configured as a linear axis whose "mm" are degrees.
    rotary_scale: float = 1.0
    tolerance: float = 0.005
    s_max: float = 1000.0
    laser_mode: str = M4_DYNAMIC
    decimals: int = 3
    angle_decimals: int = 4
    # Axis limits, for the estimate and for the rotary-bound report. None
    # means unlimited.
    x_rapid: float = 3000.0
    rotary_rapid: float | None = 3600.0
    x_max_rate: float | None = None
    rotary_max_rate: float | None = None
    min_radius: float = 0.5
    return_home: bool = True
    preamble: tuple[str, ...] = ()
    postamble: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if self.feed_mode not in (INVERSE, SCALED):
            raise ValueError(f"feed mode must be {INVERSE} or {SCALED}")
        if len(self.rotary_axis) != 1 or not self.rotary_axis.isalpha():
            raise ValueError("rotary axis must be one letter")
        if self.rotary_axis.upper() == "X":
            raise ValueError("X is the radius, the rotary axis needs another letter")


@dataclass(frozen=True)
class PathGroup:
    """A run of paths that share one power and feed."""

    label: str
    paths: list[list[Point]]
    power: float
    speed: float


@dataclass
class Job:
    text: str
    cut_length: float = 0.0
    cut_seconds: float = 0.0
    travel_seconds: float = 0.0
    path_count: int = 0
    segment_count: int = 0
    # Cut length whose speed is set by an axis limit rather than by F.
    limited_length: float = 0.0
    peak_rotary_rate: float = 0.0
    peak_x_rate: float = 0.0
    slowest_speed: float | None = None
    total_rotation: float = 0.0
    final_angle: float = 0.0
    min_radius: float | None = None
    near_axis_paths: int = 0
    records: list[dict] = field(default_factory=list)
    options: PolarOptions | None = None

    @property
    def seconds(self) -> float:
        return self.cut_seconds + self.travel_seconds


class _Writer:
    def __init__(self, options: PolarOptions) -> None:
        self.options = options
        self.kinematics = Kinematics(options.tolerance)
        self.lines: list[str] = []
        self.joint: Joint | None = None
        self.point: Point | None = None
        self.open = False
        self.cut_length = 0.0
        self.cut_seconds = 0.0
        self.travel_seconds = 0.0
        self.path_count = 0
        self.segment_count = 0
        self.limited_length = 0.0
        self.peak_rotary_rate = 0.0
        self.peak_x_rate = 0.0
        self.slowest_speed: float | None = None
        self.total_rotation = 0.0
        self.min_radius: float | None = None
        self.near_axis_paths = 0

    # --- text ---------------------------------------------------------------

    def comment(self, text: str) -> None:
        self.lines.append(f"; {text}" if text else ";")

    def blank(self) -> None:
        self.lines.append("")

    def raw(self, text: str) -> None:
        self.lines.append(text)

    def words(self, joint: Joint) -> str:
        radius, angle = joint
        sign = -1.0 if self.options.invert_rotary else 1.0
        x = format_coord(self.options.axis_x + radius, self.options.decimals)
        a = format_coord(sign * angle, self.options.angle_decimals)
        return f"X{x} {self.options.rotary_axis}{a}"

    # --- motion -------------------------------------------------------------

    @property
    def angle(self) -> float:
        return self.joint[1] if self.joint is not None else 0.0

    def rapid_to(self, point: Point) -> None:
        joint = polar.joint_of(point, self.angle)
        self._rapid(joint, point)

    def _rapid(self, joint: Joint, point: Point) -> None:
        if self.joint is not None:
            dr = abs(joint[0] - self.joint[0])
            da = abs(joint[1] - self.joint[1])
            times = [dr / self.options.x_rapid if self.options.x_rapid else 0.0]
            if self.options.rotary_rapid:
                times.append(da / self.options.rotary_rapid)
            self.travel_seconds += max(times) * 60.0
            self.total_rotation += da
        self.raw(f"G0 {self.words(joint)}")
        self.joint = joint
        self.point = point

    def path(self, points: list[Point], power: float, speed: float) -> None:
        if len(points) < 2:
            return
        low = polar.path_min_radius(points)
        self.min_radius = low if self.min_radius is None else min(self.min_radius, low)
        if low < self.options.min_radius:
            self.near_axis_paths += 1

        self.rapid_to(points[0])
        first = True
        for target in points[1:]:
            here, joint = self._here()
            for point, next_joint in polar.subdivide(here, target, joint, self.kinematics):
                first = self._segment(point, next_joint, power, speed, first)
        self._close()

    def _here(self) -> tuple[Point, Joint]:
        assert self.point is not None and self.joint is not None
        return self.point, self.joint

    def _segment(
        self, point: Point, joint: Joint, power: float, speed: float, first: bool
    ) -> bool:
        here, previous = self._here()
        length = math.dist(here, point)
        dr = abs(joint[0] - previous[0])
        da = abs(joint[1] - previous[1])
        if length < polar.AXIS_EPSILON:
            # Only the table moves: cross it dark rather than dwell the spot.
            self._close()
            self._rapid(joint, point)
            return True

        minutes = length / speed
        if self.options.feed_mode == INVERSE:
            feed = 1.0 / minutes
        else:
            joint_length = math.hypot(dr, da * self.options.rotary_scale)
            feed = speed * joint_length / length

        if not self.open:
            self._open()
            first = True
        words = f"G1 {self.words(joint)}"
        if first:
            words += f" S{power:.2f}"
        if first or self.options.feed_mode == INVERSE:
            words += f" F{_feed(feed)}"
        self.raw(words)

        self._account(length, dr, da, minutes)
        self.joint = joint
        self.point = point
        return False

    def _account(self, length: float, dr: float, da: float, minutes: float) -> None:
        self.cut_length += length
        self.segment_count += 1
        self.total_rotation += da
        self.peak_rotary_rate = max(self.peak_rotary_rate, da / minutes)
        self.peak_x_rate = max(self.peak_x_rate, dr / minutes)
        actual = minutes
        if self.options.rotary_max_rate:
            actual = max(actual, da / self.options.rotary_max_rate)
        if self.options.x_max_rate:
            actual = max(actual, dr / self.options.x_max_rate)
        if actual > minutes * (1.0 + 1e-9):
            self.limited_length += length
            achieved = length / actual
            if self.slowest_speed is None or achieved < self.slowest_speed:
                self.slowest_speed = achieved
        self.cut_seconds += actual * 60.0

    def _open(self) -> None:
        if self.options.feed_mode == SCALED:
            # Feed 1 mm/min keeps dynamic power near zero until the cut sets F.
            self.raw("G1F1")
        self.open = True

    def _close(self) -> None:
        if not self.open:
            return
        if self.options.feed_mode == SCALED:
            self.raw("G1F1")
        self.raw(f"{self.options.laser_mode} S0")
        self.open = False
        self.path_count += 1


def _feed(value: float) -> str:
    if value >= 1000.0:
        return f"{value:.0f}"
    text = f"{value:.3f}".rstrip("0").rstrip(".")
    return text or "0"


def generate(groups: list[PathGroup], options: PolarOptions, header: list[str]) -> Job:
    """Emit ready made board-coordinate paths as radius and angle moves."""
    writer = _Writer(options)

    writer.raw("G21         ; Set units to mm")
    writer.raw("G90         ; Absolute positioning")
    writer.raw("G94         ; Feed in units per minute")
    writer.raw("G1F1")
    writer.raw(f"{options.laser_mode} S0")
    for line in options.preamble:
        writer.raw(line)
    writer.blank()
    for line in header:
        writer.comment(line)
    if options.feed_mode == INVERSE:
        writer.blank()
        writer.raw("G93         ; Inverse time feed: F is segments per minute")

    records: list[dict] = []
    for group in groups:
        if not group.paths:
            continue
        writer.blank()
        writer.comment(
            f"{group.label}: {len(group.paths)} paths"
            f" power={group.power:g} speed={group.speed:g}"
        )
        before_length = writer.cut_length
        before_seconds = writer.cut_seconds
        before_segments = writer.segment_count
        for path in group.paths:
            writer.path(path, group.power, group.speed)
        records.append(
            {
                "label": group.label,
                "paths": len(group.paths),
                "segments": writer.segment_count - before_segments,
                "power": group.power,
                "speed": group.speed,
                "length": writer.cut_length - before_length,
                "seconds": writer.cut_seconds - before_seconds,
            }
        )

    writer.blank()
    for line in options.postamble:
        writer.raw(line)
    writer.raw("M5          ; Switch tool off")
    if options.feed_mode == INVERSE:
        writer.raw("G94         ; Back to units per minute")
        writer.raw("G1F1")
    if options.return_home and writer.joint is not None:
        # Back over the axis, and the table to its starting orientation by
        # the short way rather than unwinding every turn of the job.
        home_angle = 360.0 * round(writer.joint[1] / 360.0)
        writer._rapid((0.0, home_angle), (0.0, 0.0))

    return Job(
        text="\n".join(writer.lines) + "\n",
        cut_length=writer.cut_length,
        cut_seconds=writer.cut_seconds,
        travel_seconds=writer.travel_seconds,
        path_count=writer.path_count,
        segment_count=writer.segment_count,
        limited_length=writer.limited_length,
        peak_rotary_rate=writer.peak_rotary_rate,
        peak_x_rate=writer.peak_x_rate,
        slowest_speed=writer.slowest_speed,
        total_rotation=writer.total_rotation,
        final_angle=writer.joint[1] if writer.joint else 0.0,
        min_radius=writer.min_radius,
        near_axis_paths=writer.near_axis_paths,
        records=records,
        options=options,
    )
