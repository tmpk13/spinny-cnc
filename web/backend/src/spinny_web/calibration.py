"""Calibration tests as jobs: a laser's material test (a grid of squares at
a power and a speed each) and a mill's depth test (a row of slots a step
deeper each), built from spinny_laser.calibrate. Every patch is a group, so
the groups table names what each was cut with and a patch can be switched
off or cut again on its own.
"""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from spinny_laser import calibrate

from .jobs import DEFAULT_DEPTH, DEFAULT_PLUNGE, Finite, Group, Job, Offset, check_depth, check_power, check_speed
from .kinematics import Streamer

MATERIAL, DEPTH = "material", "depth"


class CalibrateRequest(Finite):
    """A ladder is (first, last, steps), both ends included."""

    kind: Literal["material", "depth"] = MATERIAL
    powers: tuple[float, float, int] = (100.0, 1000.0, 5)
    speeds: tuple[float, float, int] = (300.0, 1500.0, 5)
    size: float = Field(default=5.0, gt=0.0, le=calibrate.MAX_SIZE)
    gap: float = Field(default=2.0, ge=0.0, le=calibrate.MAX_SIZE)
    # Filled squares a spot apart (an engraving test), or outlines (a cut).
    fill: bool = True
    spot: float = Field(default=0.1, gt=0.0, le=calibrate.MAX_SIZE)
    depths: tuple[float, float, int] = (0.05, 0.3, 6)
    length: float = Field(default=10.0, gt=0.0, le=calibrate.MAX_SIZE)
    feed: float = 120.0
    plunge: float = 30.0
    # The spindle's S for every slot.
    spindle: float = 1000.0
    # The lower left corner of the pattern, board mm.
    x: float = 0.0
    y: float = 0.0


class CalibrateResult(Finite):
    job: Job
    summary: list[str]
    notes: list[str]


def build(request: CalibrateRequest, streamer: Streamer, milling: bool) -> CalibrateResult:
    """The test for the machine: the material test on a laser, the depth
    test on a mill; the other is refused, since it would cut nothing the
    machine can read."""
    origin = (request.x, request.y)
    if request.kind == MATERIAL:
        if milling:
            raise ValueError("the material test is a laser's: a mill takes the depth test")
        powers = calibrate.ladder(*request.powers)
        speeds = calibrate.ladder(*request.speeds)
        for power in powers:
            check_power(power)
        for speed in speeds:
            check_speed(speed)
        patches = calibrate.material(powers, speeds, request.size, request.gap, request.spot, request.fill, origin)
        what = f"filled {request.spot:g} mm apart" if request.fill else "outlined"
        summary = [
            f"material test: {len(powers)} powers S{powers[0]:g} to S{powers[-1]:g} left to right,"
            f" {len(speeds)} speeds {speeds[0]:g} to {speeds[-1]:g} mm/min bottom to top",
            f"{request.size:g} mm squares {request.gap:g} mm apart, {what}, lower left at X{request.x:g} Y{request.y:g}",
        ]
        notes = [
            "Each square is a group named for its power and speed: the one that marks as you want (or, outlined, the first cut through) names the settings for this material.",
            "With no focus axis this is also the focus and power test: one speed and a ladder of powers shows where the beam starts to mark.",
        ]
        name = "material test"
    else:
        if not milling:
            raise ValueError("the depth test is a mill's ($spindle=1): a laser takes the material test")
        depths = calibrate.ladder(*request.depths)
        for cut in depths:
            check_depth(cut)
        check_speed(request.feed, "feed")
        check_speed(request.plunge, "plunge")
        check_power(request.spindle, "spindle")
        if not request.spindle > 0:
            raise ValueError("a spindle needs a speed above 0")
        patches = calibrate.depth(depths, request.length, request.gap, request.spindle, request.feed, origin)
        summary = [
            f"depth test: {len(depths)} slots {depths[0]:g} to {depths[-1]:g} mm deep, {request.length:g} mm long,"
            f" {request.gap:g} mm apart, shallowest at Y{request.y:g}",
            f"feed {request.feed:g} mm/min, plunge {request.plunge:g} mm/min, spindle S{request.spindle:g}",
        ]
        notes = [
            "Touch the tool off on the copper first: each slot goes down from Z 0, or from the height map with it on.",
            "The shallowest slot that parts the copper is the isolation depth; a slot measured against its number shows how far the depth axis really moves.",
        ]
        name = "depth test"
    groups = [
        Group(
            label=patch.label,
            power=patch.power,
            speed=patch.speed,
            paths=patch.paths,
            depth=patch.depth if patch.depth is not None else DEFAULT_DEPTH,
            plunge=request.plunge if patch.depth is not None else DEFAULT_PLUNGE,
        )
        for patch in patches
    ]
    job = Job(name=name, source="calibrate", spot=request.spot, offset=Offset(x=request.x, y=request.y), groups=groups)
    job.refresh_stats(streamer)
    return CalibrateResult(job=job, summary=summary, notes=notes)
