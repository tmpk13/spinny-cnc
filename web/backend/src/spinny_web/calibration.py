"""Calibration tests as jobs: a laser's material test (a grid of squares at
a power and a speed each), its focus ladder (a row of lines a step above
or below focus each, on a focus axis) and a mill's depth test (a row of
slots a step deeper each), built from spinny_laser.calibrate. Every patch is a group, so
the groups table names what each was cut with and a patch can be switched
off or cut again on its own.
"""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from spinny_laser import calibrate

from .jobs import DEFAULT_DEPTH, DEFAULT_PLUNGE, Finite, Group, Job, Offset, check_depth, check_focus, check_power, check_speed
from .kinematics import Streamer

MATERIAL, DEPTH, FOCUS = "material", "depth", "focus"


class CalibrateRequest(Finite):
    """A ladder is (first, last, steps), both ends included."""

    kind: Literal["material", "depth", "focus"] = MATERIAL
    powers: tuple[float, float, int] = (100.0, 1000.0, 5)
    speeds: tuple[float, float, int] = (300.0, 1500.0, 5)
    size: float = Field(default=5.0, gt=0.0, le=calibrate.MAX_SIZE)
    gap: float = Field(default=2.0, ge=0.0, le=calibrate.MAX_SIZE)
    # Filled squares a spot apart (an engraving test), or outlines (a cut).
    fill: bool = True
    spot: float = Field(default=0.1, gt=0.0, le=calibrate.MAX_SIZE)
    depths: tuple[float, float, int] = (0.05, 0.3, 6)
    # The focus ladder: mm over focus from one line to the last, and the
    # one power and speed every line is burnt at.
    focuses: tuple[float, float, int] = (-1.0, 1.0, 9)
    power: float = 500.0
    speed: float = 600.0
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


def build(request: CalibrateRequest, streamer: Streamer, milling: bool, focus_axis: bool | None = None) -> CalibrateResult:
    """The test for the machine: the material test or the focus ladder on a
    laser, the depth test on a mill; the other is refused, since it would
    cut nothing the machine can read. `focus_axis` says whether the laser
    has one, when the settings were read: the ladder moves it."""
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
    elif request.kind == FOCUS:
        if milling:
            raise ValueError("the focus ladder is a laser's: a mill takes the depth test")
        if focus_axis is False:
            raise ValueError("the focus ladder moves the focus axis, and this machine has none ($h_axis=0): the material test's power ladder is the focus test without one")
        focuses = calibrate.ladder(*request.focuses)
        for step in focuses:
            check_focus(step, "a focus step")
        check_power(request.power)
        check_speed(request.speed)
        patches = calibrate.focus_ladder(focuses, request.length, request.gap, request.power, request.speed, origin)
        low, high = min(focuses), max(focuses)
        summary = [
            f"focus ladder: {len(focuses)} lines {calibrate.focus_label(low)} to {calibrate.focus_label(high)} mm over focus,"
            f" lowest at Y{request.y:g}, {request.length:g} mm long, {request.gap:g} mm apart",
            f"power S{request.power:g}, speed {request.speed:g} mm/min",
        ]
        notes = [
            "Bring the head to focus as near as you can first: each line is burnt that many mm above it (minus below), from the height the run starts at, or from the height map's focus height when the run follows the map, and the head goes back after.",
            "The thinnest, sharpest line is at focus; set the focus there (Focus here in the Height map panel, or jog H by the line's number) and run the ladder again with smaller steps to close in.",
        ]
        name = "focus ladder"
    else:
        if not milling:
            raise ValueError("the depth test is a mill's ($spindle=1): a laser takes the material test")
        # Shallowest first, as the row is laid out and the summary says.
        depths = sorted(calibrate.ladder(*request.depths))
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
            focus=patch.focus,
        )
        for patch in patches
    ]
    job = Job(name=name, source="calibrate", spot=request.spot, offset=Offset(x=request.x, y=request.y), groups=groups)
    job.refresh_stats(streamer)
    return CalibrateResult(job=job, summary=summary, notes=notes)
