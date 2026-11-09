"""Gcode for a standard controller from a built job and a CAM profile.

The profile's axes say which letters carry board X and Y (or the radius and
the angle of a polar machine), which one is the depth, and where the setup
axes are parked. A spindle operation is milled the way the web backend
streams one: the tool rises to the safe height, the spindle starts and is
given its spin-up, each path is a rapid to its start, a plunge, the cuts at
depth and a rise, pass by pass down to the depth; one cut with another bit
than the spindle operation before it is preceded by a stop (M0) to change
the bit. A laser operation cuts at the surface (or at the tool's height on a
depth axis) with its power on every cut. A polar profile is written by the
grblHAL polar writer in `gcode`.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from . import cam, carve, gcode
from .camjob import BuiltGroup, BuiltJob

Point = tuple[float, float]


class PostError(ValueError):
    """The job cannot be written for this profile."""


@dataclass
class Report:
    lines: int = 0
    cuts: int = 0
    length_mm: float = 0.0
    seconds: float = 0.0
    # Machine coordinates reached, by axis letter: [min, max].
    extents: dict[str, list[float]] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)

    def reach(self, letter: str, value: float) -> None:
        span = self.extents.setdefault(letter, [value, value])
        span[0] = min(span[0], value)
        span[1] = max(span[1], value)

    def document(self) -> dict:
        return {
            "lines": self.lines,
            "cuts": self.cuts,
            "length_mm": round(self.length_mm, 3),
            "seconds": round(self.seconds, 1),
            "extents": {letter: [round(low, 3), round(high, 3)] for letter, (low, high) in self.extents.items()},
            "warnings": list(self.warnings),
        }

    def summary_lines(self) -> list[str]:
        lines = [
            f"Lines:    {self.lines}",
            f"Cuts:     {self.cuts}, {self.length_mm:.1f} mm",
            f"Time:     {self.seconds / 60.0:.1f} min",
        ]
        for letter, (low, high) in self.extents.items():
            lines.append(f"{letter} reach:  {low:.3f} to {high:.3f}")
        lines.extend(f"Warning:  {warning}" for warning in self.warnings)
        return lines


@dataclass
class Program:
    text: str
    report: Report


def post(job: BuiltJob, profile: cam.Profile) -> Program:
    """The job as gcode for the profile's controller, with what it reaches.
    A job with nothing switched on to cut is refused, as a run refuses it:
    its program would only rise and go home."""
    if not any(group.enabled and group.has_cuts for group in job.groups):
        raise PostError("the job has nothing enabled to cut: switch on a group")
    if profile.kinematics == cam.POLAR:
        return _polar(job, profile)
    return _Cartesian(job, profile).write()


# --- cartesian ----------------------------------------------------------------


class _Cartesian:
    def __init__(self, job: BuiltJob, profile: cam.Profile) -> None:
        self.job = job
        self.profile = profile
        self.post = profile.post
        self.x = profile.axis(cam.X)
        self.y = profile.axis(cam.Y)
        self.depth = profile.axis(cam.DEPTH)
        assert self.x is not None and self.y is not None
        self.lines: list[str] = []
        self.report = Report()
        # Machine coordinates the controller is at, by letter; None until written.
        self.at: dict[str, float | None] = {axis.letter: None for axis in profile.axes}
        # The output's state: (kind, S) or None for off.
        self.output: tuple[str, float] | None = None
        self.feed: float | None = None
        self.power_word: float | None = None
        self.capped: set[str] = set()
        # The id of the bit the last spindle group that named one cut with:
        # the one fitted, as far as the program knows; None before any.
        self.bit: str | None = None

    # --- words ----------------------------------------------------------------

    def num(self, value: float) -> str:
        text = f"{value:.{self.post.decimals}f}"
        return "0." + "0" * self.post.decimals if text.startswith("-") and float(text) == 0.0 else text

    def emit(self, line: str) -> None:
        self.lines.append(line)

    def comment(self, text: str) -> None:
        self.emit("(" + gcode.one_line(text).replace("(", "[").replace(")", "]") + ")")

    def reach(self, axis: cam.Axis, value: float) -> None:
        self.report.reach(axis.letter, value)

    def check_travel(self) -> None:
        """One warning for each end of an axis the program goes past, at
        the farthest it goes."""
        for axis in self.profile.axes:
            span = self.report.extents.get(axis.letter)
            if span is None:
                continue
            if axis.min is not None and span[0] < axis.min - 1e-9:
                self.warn(f"{axis.letter} reaches {span[0]:.3f}, under its min {axis.min:g}")
            if axis.max is not None and span[1] > axis.max + 1e-9:
                self.warn(f"{axis.letter} reaches {span[1]:.3f}, over its max {axis.max:g}")

    def warn(self, text: str) -> None:
        if text not in self.report.warnings:
            self.report.warnings.append(text)

    def machine_xy(self, point: Point) -> tuple[float, float]:
        assert self.x is not None and self.y is not None
        return (point[0] + self.x.offset, point[1] + self.y.offset)

    def machine_z(self, over_surface: float) -> float:
        assert self.depth is not None
        return self.depth.offset + over_surface

    def cap(self, feed: float, axes: list[cam.Axis], what: str) -> float:
        """The feed, held to the slowest of the axes that move; said once."""
        capped = feed
        for axis in axes:
            if axis.rate is not None and axis.rate < capped:
                capped = axis.rate
        if capped < feed and what not in self.capped:
            self.capped.add(what)
            self.warn(f"{what}: {feed:g} mm/min is over the axes' rate; written as {capped:g}")
        return capped

    def rapid_seconds(self, moves: dict[cam.Axis, float]) -> float:
        """A rapid takes as long as its slowest axis."""
        seconds = 0.0
        for axis, distance in moves.items():
            rate = axis.rapid or axis.rate
            if rate:
                seconds = max(seconds, abs(distance) / rate * 60.0)
        return seconds

    def go(self, point: Point | None = None, z: float | None = None, setup: dict[cam.Axis, float] | None = None) -> None:
        """A rapid in machine coordinates: the plane, the depth, or setup axes."""
        words: list[str] = []
        moves: dict[cam.Axis, float] = {}
        if point is not None:
            assert self.x is not None and self.y is not None
            mx, my = self.machine_xy(point)
            for axis, value in ((self.x, mx), (self.y, my)):
                if self.at[axis.letter] is None or abs(self.at[axis.letter] - value) > 1e-9:  # type: ignore[operator]
                    words.append(f"{axis.letter}{self.num(value)}")
                    moves[axis] = value - (self.at[axis.letter] or value)
                    self.at[axis.letter] = value
                    self.reach(axis, value)
        if z is not None:
            assert self.depth is not None
            value = self.machine_z(z)
            if self.at[self.depth.letter] is None or abs(self.at[self.depth.letter] - value) > 1e-9:  # type: ignore[operator]
                words.append(f"{self.depth.letter}{self.num(value)}")
                moves[self.depth] = value - (self.at[self.depth.letter] or value)
                self.at[self.depth.letter] = value
                self.reach(self.depth, value)
        for axis, value in (setup or {}).items():
            words.append(f"{axis.letter}{self.num(value)}")
            moves[axis] = value - (self.at[axis.letter] or value)
            self.at[axis.letter] = value
            self.reach(axis, value)
        if words:
            self.emit("G0 " + " ".join(words))
            self.report.seconds += self.rapid_seconds(moves)

    def cut(self, point: Point, feed: float, power: float | None, what: str) -> None:
        """A G1 across the plane at `feed`, with S for a laser."""
        assert self.x is not None and self.y is not None
        mx, my = self.machine_xy(point)
        words: list[str] = []
        length = 0.0
        moved: dict[cam.Axis, float] = {}
        for axis, value in ((self.x, mx), (self.y, my)):
            before = self.at[axis.letter]
            if before is None or abs(before - value) > 1e-9:
                words.append(f"{axis.letter}{self.num(value)}")
                moved[axis] = value - (before if before is not None else value)
                self.at[axis.letter] = value
                self.reach(axis, value)
        if not words:
            return
        length = math.hypot(*moved.values()) if len(moved) == 2 else abs(next(iter(moved.values())))
        feed = self.cap(feed, list(moved), what)
        if self.feed != feed:
            words.append(f"F{self.num(feed)}")
            self.feed = feed
        if power is not None and self.power_word != power:
            words.append(f"S{power:g}")
            self.power_word = power
        self.emit("G1 " + " ".join(words))
        self.report.cuts += 1
        self.report.length_mm += length
        self.report.seconds += length / feed * 60.0

    def cut3(self, point: Point, over_surface: float, feed: float, what: str) -> None:
        """A G1 in three dimensions at `feed` along the move, held so that
        no axis goes faster than its rate."""
        assert self.x is not None and self.y is not None and self.depth is not None
        mx, my = self.machine_xy(point)
        mz = self.machine_z(over_surface)
        words: list[str] = []
        moved: dict[cam.Axis, float] = {}
        for axis, value in ((self.x, mx), (self.y, my), (self.depth, mz)):
            before = self.at[axis.letter]
            if before is None or abs(before - value) > 1e-9:
                words.append(f"{axis.letter}{self.num(value)}")
                moved[axis] = value - (before if before is not None else value)
                self.at[axis.letter] = value
                self.reach(axis, value)
        if not words:
            return
        length = math.sqrt(sum(d * d for d in moved.values()))
        # Each axis covers its share of the move: the feed is held where
        # the share of the slowest makes it go over its rate.
        capped = feed
        for axis, delta in moved.items():
            if axis.rate is not None and length > 0 and abs(delta) > 0:
                capped = min(capped, axis.rate * length / abs(delta))
        if capped < feed - 1e-9 and what not in self.capped:
            self.capped.add(what)
            self.warn(f"{what}: {feed:g} mm/min is over an axis' rate on some moves; those are written slower")
        feed = capped
        if self.feed is None or abs(self.feed - feed) > 1e-9:
            words.append(f"F{self.num(feed)}")
            self.feed = feed
        self.emit("G1 " + " ".join(words))
        self.report.cuts += 1
        self.report.length_mm += length
        self.report.seconds += length / feed * 60.0

    def plunge(self, over_surface: float, rate: float, what: str) -> None:
        assert self.depth is not None
        value = self.machine_z(over_surface)
        before = self.at[self.depth.letter]
        if before is not None and abs(before - value) <= 1e-9:
            return
        rate = self.cap(rate, [self.depth], what)
        words = [f"{self.depth.letter}{self.num(value)}"]
        if self.feed != rate:
            words.append(f"F{self.num(rate)}")
            self.feed = rate
        self.emit("G1 " + " ".join(words))
        self.at[self.depth.letter] = value
        self.reach(self.depth, value)
        if before is not None:
            self.report.seconds += abs(before - value) / rate * 60.0

    # --- the output -----------------------------------------------------------

    def output_off(self) -> None:
        if self.output is not None:
            self.emit("M5")
            self.output = None
            self.power_word = None

    def spindle(self, speed: float) -> None:
        if self.output == (cam.SPINDLE, speed):
            return
        if self.output is not None and self.output[0] != cam.SPINDLE:
            self.output_off()
        self.emit(f"{self.post.spindle_on} S{speed:g}")
        self.output = (cam.SPINDLE, speed)
        if self.post.spinup > 0:
            self.emit(f"G4 P{self.post.spinup:g}")
            self.report.seconds += self.post.spinup

    def laser(self) -> None:
        if self.output is not None and self.output[0] == cam.LASER:
            return
        self.output_off()
        self.emit(f"{self.post.laser_on} S0")
        self.output = (cam.LASER, 0.0)
        self.power_word = 0.0

    # --- the program ----------------------------------------------------------

    def write(self) -> Program:
        job, profile = self.job, self.profile
        self.comment(f"{job.name}: {len([g for g in job.groups if g.enabled and g.has_cuts])} operations through {profile.name}")
        self.comment("board X/Y on " + " ".join(f"{axis.letter}={axis.role}" for axis in profile.axes))
        for line in self.post.header:
            self.emit(line)
        setup = {axis: axis.park for axis in profile.axes if axis.role == cam.SETUP and axis.park is not None}
        if self.depth is not None:
            self.go(z=self.safe())
        if setup:
            self.go(setup=setup)
        for group in job.groups:
            if not group.enabled or not group.has_cuts:
                continue
            if group.tool == cam.SPINDLE and group.tool_id is not None:
                if self.bit is not None and group.tool_id != self.bit:
                    self.change_bit(group)
                self.bit = group.tool_id
            self.comment(f"{group.label}: {len(group.moves or group.paths)} paths")
            if group.moves:
                self.carve(group)
            elif group.tool == cam.SPINDLE:
                self.mill(group)
            else:
                self.burn(group)
        self.output_off()
        if self.depth is not None:
            self.go(z=self.safe())
        if self.post.return_home:
            homes = {axis: axis.home for axis in profile.axes if axis.home is not None and axis.role != cam.DEPTH}
            if homes:
                self.go(setup=homes)
            if self.depth is not None and self.depth.home is not None:
                self.go(setup={self.depth: self.depth.home})
        for line in self.post.footer:
            self.emit(line)
        self.check_travel()
        self.report.lines = len(self.lines)
        return Program("\n".join(self.lines) + "\n", self.report)

    def safe(self) -> float:
        assert self.depth is not None and self.depth.safe is not None
        return self.depth.safe

    def change_bit(self, group: BuiltGroup) -> None:
        """A stop for the group's bit: the spindle off, the tool up, the bit
        named and a pause (M0), which the operator resumes once the bit is
        fitted and Z is zeroed with it, its length being another."""
        name = group.tool_name or group.tool_id
        self.output_off()
        if self.depth is not None:
            self.go(z=self.safe())
        self.comment(f"change the bit to {name} and zero Z with it as before, then resume")
        self.emit("M0")
        self.warn(f"{group.label}: the program stops (M0) to change the bit to {name}")

    def mill(self, group: BuiltGroup) -> None:
        if self.depth is None:
            raise PostError(f"{group.label}: a spindle operation needs a depth axis in the profile")
        if not group.power > 0:
            raise PostError(f"{group.label}: a spindle needs a speed above 0")
        # Up before the spindle starts: a laser group before this one may
        # have left the tool at its focus height, on the work.
        self.go(z=self.safe())
        self.spindle(group.power)
        passes = max(1, group.passes)
        for k in range(1, passes + 1):
            depth = group.depth * k / passes
            for path in group.paths:
                points = [tuple(p) for p in path]
                if not points:
                    continue
                self.go(z=self.safe())
                self.go(point=points[0])
                self.plunge(-depth, group.plunge, f"{group.label} plunge")
                for target in points[1:]:
                    self.cut(target, group.speed, None, group.label)
                self.go(z=self.safe())

    def carve(self, group: BuiltGroup) -> None:
        """A model's paths: each from the safe height down to its first
        point, then its moves as they are, and up again."""
        if self.depth is None:
            raise PostError(f"{group.label}: a model's paths need a depth axis in the profile")
        if group.tool != cam.SPINDLE:
            raise PostError(f"{group.label}: a model's paths are cut with a spindle")
        if not group.power > 0:
            raise PostError(f"{group.label}: a spindle needs a speed above 0")
        self.go(z=self.safe())
        self.spindle(group.power)
        for path in group.moves:
            if not path:
                continue
            x, y, z, kind = path[0]
            self.go(z=self.safe())
            self.go(point=(x, y))
            if kind == carve.RAPID:
                self.go(z=z)
            else:
                self.plunge(z, group.plunge, f"{group.label} plunge")
            for x, y, z, kind in path[1:]:
                if kind == carve.RAPID:
                    self.go(point=(x, y), z=z)
                elif kind == carve.PLUNGE:
                    self.cut3((x, y), z, group.plunge, f"{group.label} plunge")
                else:
                    self.cut3((x, y), z, group.speed, group.label)
            self.go(z=self.safe())

    def burn(self, group: BuiltGroup) -> None:
        if group.min_power > 0:
            self.warn(f"{group.label}: the power floor {group.min_power:g} has no gcode word and is left out")
        if self.depth is not None:
            self.go(z=self.safe())
        self.laser()
        if self.depth is not None and group.height is not None:
            self.go(z=group.height)
        for _ in range(max(1, group.passes)):
            for path in group.paths:
                points = [tuple(p) for p in path]
                if len(points) < 2:
                    continue
                self.go(point=points[0])
                for target in points[1:]:
                    self.cut(target, group.speed, group.power, group.label)


# --- polar --------------------------------------------------------------------


def _polar(job: BuiltJob, profile: cam.Profile) -> Program:
    """A polar profile goes through the grblHAL polar writer: the radius on X
    and the angle on the rotary axis letter, laser operations only."""
    radius = profile.axis(cam.RADIUS)
    angle = profile.axis(cam.ANGLE)
    assert radius is not None and angle is not None
    if radius.letter != "X":
        raise PostError("the polar gcode writer puts the radius on X; name the radius axis X")
    groups: list[gcode.PathGroup] = []
    for group in job.groups:
        if not group.enabled or not group.has_cuts:
            continue
        if group.tool != cam.LASER:
            raise PostError(f"{group.label}: the polar gcode writer takes laser operations only; a spindle job runs through the web backend")
        paths = [[tuple(p) for p in path] for path in group.paths if len(path) >= 2]
        for _ in range(max(1, group.passes)):
            groups.append(gcode.PathGroup(group.label, paths, group.power, group.speed))
    try:
        options = gcode.PolarOptions(
            controller=gcode.JOINT,
            rotary_axis=angle.letter,
            x_rapid=radius.rapid or 0.0,
            rotary_rapid=angle.rapid,
            x_max_rate=radius.rate,
            rotary_max_rate=angle.rate,
            decimals=profile.post.decimals,
            preamble=tuple(profile.post.header),
            postamble=tuple(profile.post.footer),
            laser_mode=profile.post.laser_on,
            axis_x=radius.offset,
            return_home=profile.post.return_home,
        )
    except ValueError as exc:
        raise PostError(str(exc)) from exc
    written = gcode.generate(groups, options, [f"{job.name} through {profile.name}"])
    report = Report(
        lines=written.text.count("\n"),
        cuts=written.segment_count,
        length_mm=written.cut_length,
        seconds=written.seconds,
        extents={radius.letter: [written.min_radius or 0.0, max((math.hypot(*p) for g in groups for path in g.paths for p in path), default=0.0)]},
    )
    if radius.max is not None and report.extents[radius.letter][1] > radius.max + 1e-9:
        report.warnings.append(f"{radius.letter} reaches {report.extents[radius.letter][1]:.3f}, over its max {radius.max:g}")
    return Program(written.text, report)
