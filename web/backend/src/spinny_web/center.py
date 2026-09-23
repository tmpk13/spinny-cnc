"""The centering test burn as a job: what `spinny-center` writes, built in place.

The coarse pattern is radial lines and a ring in board millimeters, which
the streamer turns into joint moves like any drawing. The fine pattern is
joint-space groups that run the head past the axis, taken as the command
line tool writes them.
"""

from __future__ import annotations

import json

from pydantic import Field

from spinny_laser import center as coarse_pattern
from spinny_laser import fine as fine_pattern

from .jobs import Finite, Group, Job, JobImportError, check_power, check_speed, from_json
from .kinematics import Streamer

# More lines than this only burn the square's corners into one blot.
MAX_LINES = 360
# Longest dimension the pattern may ask for, far past any table.
MAX_SIZE = 1000.0


class CenterRequest(Finite):
    """The options of `spinny-center`; a missing reach or ring takes the mode's default."""

    fine: bool = False
    lines: int = Field(default=4, ge=0, le=MAX_LINES)
    reach: float | None = Field(default=None, gt=0.0, le=MAX_SIZE)
    ring: float | None = Field(default=None, ge=0.0, le=MAX_SIZE)
    angle: float = fine_pattern.Design.angle
    cross: float = Field(default=fine_pattern.Design.cross, le=MAX_SIZE)
    arm: float = Field(default=fine_pattern.Design.arm, le=MAX_SIZE)
    spiral: float = Field(default=fine_pattern.Design.spiral, le=MAX_SIZE)
    # Draws the fine pattern as a machine burns it with the radius zero
    # the first number out along the rail and the rail the second off the
    # axis; what is streamed is unchanged.
    show_error: tuple[float, float] | None = None
    spot: float = Field(default=0.1, gt=0.0, le=MAX_SIZE)
    power: float = 400.0
    speed: float = 200.0


class CenterResult(Finite):
    job: Job
    summary: list[str]
    notes: list[str]


def build(
    request: CenterRequest,
    streamer: Streamer,
    rotary_max_rate: float | None,
    s_max: float | None = None,
) -> CenterResult:
    """The pattern as a job with its stats, or JobImportError for options it cannot take."""
    try:
        check_power(request.power)
        check_speed(request.speed)
        if s_max is not None and request.power > s_max:
            raise ValueError(f"power {request.power:g} is over s_max {s_max:g}")
        if request.fine:
            result = _fine(request, streamer.tolerance, rotary_max_rate)
        else:
            if request.show_error is not None:
                raise ValueError("show error only applies to the fine pattern")
            result = _coarse(request, rotary_max_rate)
    except JobImportError:
        raise
    except ValueError as exc:
        raise JobImportError(str(exc).replace("--", "")) from exc
    result.job.refresh_stats(streamer)
    return result


def _coarse(request: CenterRequest, rotary_max_rate: float | None) -> CenterResult:
    reach = 6.0 if request.reach is None else request.reach
    ring = 8.0 if request.ring is None else request.ring
    if request.lines == 0 and ring <= 0:
        raise ValueError("0 lines needs a ring to measure")
    groups = coarse_pattern.build(
        request.lines, reach, ring, request.power, request.speed, rotary_max_rate
    )
    job = Job(
        name="center",
        source="center",
        spot=request.spot,
        groups=[
            Group(label=group.label, power=group.power, speed=group.speed, paths=group.paths)
            for group in groups
        ],
    )
    summary = [
        f"pattern    {request.lines} lines to {reach:g} mm"
        + (f", ring at {ring:g} mm" if ring > 0 else ""),
    ]
    notes = coarse_pattern.all_notes(request.lines, ring, request.speed, rotary_max_rate)
    return CenterResult(job=job, summary=summary, notes=notes)


def _fine(request: CenterRequest, tolerance: float, rotary_max_rate: float | None) -> CenterResult:
    design = fine_pattern.Design(
        reach=fine_pattern.Design.reach if request.reach is None else request.reach,
        angle=request.angle,
        cross=request.cross,
        arm=request.arm,
        spiral=request.spiral,
        ring=0.0 if request.ring is None else request.ring,
    )
    groups = fine_pattern.build(design, request.power, request.speed, rotary_max_rate, tolerance)
    name = "center-fine"
    job = from_json(json.dumps(fine_pattern.job_document(groups, name, request.spot)), name)
    job.source = "center"
    summary = [
        f"pattern    fine: rail lines {design.reach:g} mm each way, arms crossing at"
        f" {design.cross:g} mm, {design.angle:g} deg"
        + (f", spirals at {design.spiral:g} mm" if design.spiral > 0 else "")
        + (f", ring at {design.ring:g} mm" if design.ring > 0 else ""),
        f"gain       {design.gain:.1f}: 0.01 mm of error moves a crossing"
        f" {design.gain * 0.01:.2f} mm, the arm crossings {2 * design.gain * 0.01:.2f} mm apart",
        f"head       to R {-design.far_reach:.1f}, past the axis",
    ]
    if request.show_error is not None:
        along, across = request.show_error
        for group, (_, paths) in zip(job.groups, fine_pattern.burnt(groups, along, across)):
            group.paths = paths
        job.name = f"{name} shown {along:g},{across:g}"
        seen = fine_pattern.readings(design, groups, along, across)
        summary.append(
            f"shown      as burnt with the radius zero {along:g} mm out and the rail"
            f" {across:g} mm off the axis"
        )
        if "arms" in seen:
            summary.append(f"           arm crossings {seen['arms']:.2f} mm apart")
        if "spiral" in seen:
            summary.append(f"           spiral crossing {seen['spiral']:.2f} mm from its line")
    notes = fine_pattern.notes_for(design, request.spot, request.speed, groups)
    return CenterResult(job=job, summary=summary, notes=notes)
