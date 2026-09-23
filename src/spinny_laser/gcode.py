"""Gcode emitter for the radius-and-angle machine.

Same dialect as the Cartesian tool (`G21`/`G90`, `M4` dynamic power, `S` on
the first cut move of each path, `M4 S0` at the end of each path). Two
controllers are served:

- `grblhal`: grblHAL with polar kinematics does the transform itself, so the
  file holds board X/Y in `G94` with `F` as the surface speed. The controller
  splits cuts into 0.5 mm pieces and runs each as a joint move, which strays
  from a straight line near the axis, so segments are pre-split here to the
  tolerance. A cut leaving the axis first hops two coordinate quanta out
  along its new direction with the beam off, since the controller would
  otherwise spiral out of the center.
- `joint`: the file carries the radius on X and the angle on another axis,
  and every cut segment has its own feed word. Inverse time (`G93`) makes
  the surface speed independent of how the controller sums a linear and a
  rotary axis; `scaled` stays in `G94` and scales `F` per segment instead.

In both a segment that only turns the table, which only happens on the
axis, is crossed with the beam off: under `M4` the spot would otherwise
dwell at full power on one point of the board.
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
GRBLHAL, JOINT = "grblhal", "joint"
# grblHAL splits every cut into pieces this long and runs each as one joint move.
GRBLHAL_SEGMENT = 0.5
# How far a cut leaving the axis hops out before running radially, in
# coordinate quanta. The controller reads the new angle from this point
# instead of spiralling; the point is rounded first and its real angle used,
# since at this radius rounding turns the direction by tens of degrees.
EXIT_QUANTA = 2


@dataclass(frozen=True)
class PolarOptions:
    controller: str = GRBLHAL
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
        if self.controller not in (GRBLHAL, JOINT):
            raise ValueError(f"controller must be {GRBLHAL} or {JOINT}")
        if self.feed_mode not in (INVERSE, SCALED):
            raise ValueError(f"feed mode must be {INVERSE} or {SCALED}")
        if len(self.rotary_axis) != 1 or not self.rotary_axis.isalpha():
            raise ValueError("rotary axis must be one letter")
        if self.rotary_axis.upper() == "X":
            raise ValueError("X is the radius, the rotary axis needs another letter")
        if self.controller == GRBLHAL and self.axis_x != 0.0:
            raise ValueError(
                "grblHAL polar mode transforms around machine X 0, so the axis"
                " cannot be offset; set the machine up with the beam over the axis"
            )

    @property
    def cartesian(self) -> bool:
        """The controller does the kinematics and the file holds board X/Y."""
        return self.controller == GRBLHAL

    @property
    def units_per_minute(self) -> bool:
        return self.cartesian or self.feed_mode == SCALED


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
        self.hopped = False

    # --- text ---------------------------------------------------------------

    def comment(self, text: str) -> None:
        self.lines.append(f"; {text}" if text else ";")

    def blank(self) -> None:
        self.lines.append("")

    def raw(self, text: str) -> None:
        self.lines.append(text)

    def words(self, joint: Joint, point: Point) -> str:
        decimals = self.options.decimals
        if self.options.cartesian:
            return f"X{format_coord(point[0], decimals)} Y{format_coord(point[1], decimals)}"
        radius, angle = joint
        sign = -1.0 if self.options.invert_rotary else 1.0
        x = format_coord(self.options.axis_x + radius, decimals)
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
        self.raw(f"G0 {self.words(joint, point)}")
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
        # A segment that passes within half a coordinate quantum of the axis
        # is cut there, so the crossing is a radial move in, a dark turn on
        # the spot and a radial move out, never a lit chord spanning it.
        snap = max(0.5 * 10.0 ** -self.options.decimals, self.kinematics.tolerance)
        for target in points[1:]:
            here, _ = self._here()
            for stop in polar.split_at_axis(here, target, snap):
                first = self._trace(stop, power, speed, first)
        self._close()

    def _trace(self, target: Point, power: float, speed: float, first: bool) -> bool:
        # A turn on the axis moves the start of what is left, so the
        # remainder is subdivided again from where the head really is.
        while True:
            here, joint = self._here()
            self.hopped = False
            for point, next_joint in polar.subdivide(here, target, joint, self.kinematics):
                first = self._segment(point, next_joint, power, speed, first)
                if self.hopped:
                    break
            if not self.hopped:
                return first

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
            if not polar.on_axis(previous):
                # The same point twice, which a gcode file gives as a rapid
                # followed by a cut to where it already is: nothing to cut
                # and nothing to turn. Treated as a turn it would hop the
                # head to the axis and cut its way back out.
                return first
            # Only the table moves: cross it dark rather than dwell the spot.
            self._close()
            if self.options.cartesian:
                # Board X/Y cannot say "turn on the spot"; a point just off the
                # axis along the new direction reads as that angle instead.
                decimals = self.options.decimals
                hop = polar.cartesian((EXIT_QUANTA * 10.0 ** -decimals, joint[1]))
                point = (round(hop[0], decimals), round(hop[1], decimals))
                joint = polar.joint_of(point, joint[1])
            self._rapid(joint, point)
            self.hopped = True
            return True

        minutes = length / speed
        if self.options.cartesian:
            feed = speed
        elif self.options.feed_mode == INVERSE:
            feed = 1.0 / minutes
        else:
            joint_length = math.hypot(dr, da * self.options.rotary_scale)
            feed = speed * joint_length / length

        if not self.open:
            self._open()
            first = True
        words = f"G1 {self.words(joint, point)}"
        if first:
            words += f" S{power:.2f}"
        if first or not self.options.units_per_minute:
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
        if self.options.units_per_minute:
            # Feed 1 mm/min keeps dynamic power near zero until the cut sets F.
            self.raw("G1F1")
        self.open = True

    def _close(self) -> None:
        if not self.open:
            return
        if self.options.units_per_minute:
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
    if not options.units_per_minute:
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
    if not options.units_per_minute:
        writer.raw("G94         ; Back to units per minute")
        writer.raw("G1F1")
    if options.return_home and writer.joint is not None:
        if options.cartesian:
            # The controller is told X0 Y0 and keeps the table where it is
            # at the axis; the estimate must not book a turn it never makes.
            home_angle = writer.joint[1]
        else:
            # Back over the axis, and the table to its starting orientation
            # by the short way rather than unwinding every turn of the job.
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
