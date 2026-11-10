"""A placement run on a G-code device: a board's parts placed one at a
time, each next line made from what the cameras and the vacuum sensor say.

On the device's run thread:

1. The profile's init lines.
2. With fiducials asked for, the top camera finds the board's fiducials
   where the board's place so far puts them; the board's place is fitted
   from them again (two or more give its turn too), kept as the job's
   references, and the parts planned again on it.
3. Each part: its feeder's marks once in the run (the feeder's places
   follow them); its pocket looked at when the feeder says so (an empty
   one is passed over); the pick; the vacuum read with the part held; the
   look over the up camera with the nozzle turned to the angle the part
   goes down at, its offset, angle and size checked, the angle corrected
   and looked at again; the place; the vacuum read once it let go.
   A pick that will not do (no part held, nothing on the nozzle, a part
   too far off, turned too far, or of the wrong size) lets the part go at
   the discard place, or back into its pocket, and takes the next pocket,
   up to the profile's pick_tries; then the part is left out, named in the
   progress with why. A part that stays on the nozzle after its place
   stops the run: it would be let go somewhere else.
4. The tail lines.

Places on the device are the head's with the nozzle's tip turned to 0
over a point. The up camera's place is the head's with that tip over the
picture's center, and its runout `e` how far the tip sits off the turning
axis at 0. Looking at a part turned to `a`, the head stands at the axis'
place less e turned by a, so the tip is over the center; the part's
center, seen `s` off the center, is `s + axis - head` off the axis, which
turns with the nozzle. To put that center on a place X with the nozzle at
`a'`: the head goes to X + e - (that offset turned by a' - a).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Callable

from spinny_laser.align import Fit, fit_rigid

from .gcode_device import DeviceLinkError, DeviceMover, GcodeDevice, RunContext
from .openpnp import (
    Block,
    Device,
    Feeder,
    Plan,
    check_lines,
    code_of,
    dwell_line,
    num,
    pick_lines,
    place_lines,
    plan,
    safe_line,
    turned,
)
from .pnp import CameraPlace, NoSpot, PnpError, UpCamera
from .topcam import Found, TopCamera
from .vision import VisionError

Point = tuple[float, float]
# The part is looked at again after a turn that corrects it by more than
# this many degrees, at most this many looks in all.
ANGLE_SETTLED = 0.5
LOOKS = 3
# Two or more fiducials disagreeing with their fit by more than this, mm,
# are taken for a wrong spot or another board.
FIDUCIAL_LIMIT = 0.25
# This many parts left out one after another stop the run: something is
# set up wrong (a shade, a sensor's range), and every pocket would go.
FAILED_IN_A_ROW = 2


class Rejected(Exception):
    """A pick that will not do: the part goes back and the next pocket is tried."""


def wrap90(degrees: float) -> float:
    """An angle in (-45, 45]: a rectangle's turn, which a quarter turn leaves as it was."""
    turned_ = math.fmod(degrees, 90.0)
    if turned_ <= -45.0:
        turned_ += 90.0
    elif turned_ > 45.0:
        turned_ -= 90.0
    return turned_


def fiducial_fit(found: list[Found], angle: float) -> Fit:
    """The board's place on the device from the fiducials found: a shift
    turned by `angle` from one, a turn and a shift from more; PnpError when
    they disagree."""
    pairs = [(entry.job, entry.seen) for entry in found]
    fit = fit_rigid(pairs, angle if len(pairs) == 1 else None)
    if len(pairs) >= 2 and fit.residuals:
        worst = max(range(len(pairs)), key=lambda i: fit.residuals[i])
        if fit.residuals[worst] > FIDUCIAL_LIMIT:
            raise PnpError(
                f"the fiducials do not agree: {found[worst].ref} sits {fit.residuals[worst]:.3f} mm off their fit"
                f" (scale {fit.scale:.4f}): a wrong spot taken for one, or another board"
            )
    return fit


@dataclass
class PlaceSetup:
    """What a run is placed with besides the device and its link."""

    up: UpCamera
    up_place: CameraPlace
    top: TopCamera
    # Called with a feeder and how many parts it has given, once a pick is answered.
    on_taken: Callable[[str, int], None]
    # Called with the fiducials found and the fit made of them.
    on_fiducials: Callable[[list[Found], Fit], None]
    message: Callable[[str, str], None]
    publish_up: Callable[[], None]


class Placement:
    """One run's placement of a job's parts; called on the run thread."""

    def __init__(
        self,
        device: Device,
        link: GcodeDevice,
        parts: list[dict],
        fit: Fit,
        taken: dict[str, int],
        refs: list[str] | None,
        title: str,
        setup: PlaceSetup,
        fiducials: bool = False,
    ) -> None:
        self.device = device
        self.link = link
        self.parts = {part["ref"]: part for part in parts}
        self.all_parts = parts
        self.fit = fit
        self.taken = dict(taken)
        self.refs = refs
        self.title = title
        self.setup = setup
        self.feeders = {feeder.id: feeder for feeder in device.feeders}
        self.feeder_fits: dict[str, Fit] = {}
        self.fiducials = [part for part in parts if part.get("fiducial")] if fiducials else []
        if fiducials and not self.fiducials:
            raise ValueError("the board has no fiducials to find: footprints whose reference starts FID or whose name says Fiducial")
        if fiducials and device.top is None:
            raise ValueError("the device profile has no [top_camera] to find the fiducials with")
        self.program = self._plan(fit)
        self._no_angle_said = False
        self._failed_in_a_row = 0

    def _plan(self, fit: Fit) -> Plan:
        place = self.setup.up_place
        return plan(
            self.device, self.all_parts, fit, self.taken, self.refs, title=self.title,
            vision_ready=place.measured, runout=place.runout or (0.0, 0.0),
        )

    def total(self) -> int:
        return sum(1 for line in self.program.text().splitlines() if code_of(line))

    # --- the run -----------------------------------------------------------------

    def __call__(self, ctx: RunContext) -> None:
        device = self.device
        mover = DeviceMover(self.link, device, in_run=True, send=ctx.send)
        for line in self.program.head:
            ctx.send(line)
        if self.fiducials:
            self._find_fiducials(ctx, mover)
        blocks = self.program.blocks
        for number, block in enumerate(blocks):
            ctx.progress.total = ctx.progress.sent + self._lines(blocks[number:]) + self._lines_of(self.program.tail)
            self._place(ctx, mover, block)
        for line in self.program.tail:
            ctx.send(line)

    @staticmethod
    def _lines_of(lines: list[str]) -> int:
        return sum(1 for line in lines if code_of(line))

    def _lines(self, blocks: list[Block]) -> int:
        return sum(self._lines_of(block.lines) for block in blocks)

    def _doing(self, ctx: RunContext, what: str | None) -> None:
        ctx.progress.doing = what
        ctx.publish()

    def _find_fiducials(self, ctx: RunContext, mover: DeviceMover) -> None:
        top = self.device.top
        assert top is not None
        self._doing(ctx, "finding the fiducials")
        guess = self.fit
        try:
            mover.begin()
            found = self.setup.top.locate_fiducials(mover, self.fiducials, guess.apply, top.fiducial, top.within, top.z)
            fit = fiducial_fit(found, guess.rotation)
        except (PnpError, VisionError) as exc:
            raise DeviceLinkError(f"finding the fiducials: {exc}") from exc
        self.setup.on_fiducials(found, fit)
        self.fit = fit
        self.program = self._plan(fit)
        rms = f", {fit.rms * 1000.0:.0f} um rms" if len(found) > 1 else ""
        self.setup.message("info", f"{len(found)} fiducials found: the board is turned {fit.rotation:+.3f} degrees on the device{rms}")
        self._doing(ctx, None)

    def _place(self, ctx: RunContext, mover: DeviceMover, block: Block) -> None:
        device = self.device
        feeder = self.feeders[block.feeder]
        part = self.parts[block.ref]
        ctx.progress.part = block.ref
        self._doing(ctx, None)
        if feeder.marks and feeder.id not in self.feeder_fits:
            self._find_marks(ctx, mover, feeder)
        reason = ""
        for tries in range(1, device.pick_tries + 1):
            index = self.taken.get(feeder.id, 0)
            if feeder.count > 0 and index >= feeder.count:
                reason = f"feeder {feeder.id} is empty"
                break
            point = self._pocket(feeder, index)
            if feeder.pocket is not None:
                seen = self._look_in_pocket(ctx, mover, feeder, block, point, index)
                if seen is None:
                    self._take(feeder, index)
                    reason = f"pocket #{index + 1} of {feeder.id} looked empty"
                    self.setup.message("warning", f"{block.ref}: {reason}, passed over")
                    continue
                point = (seen[0], seen[1], point[2])
            label = f"{block.ref} {part.get('value', '')} from {feeder.id} #{index + 1}"
            if tries > 1:
                self._doing(ctx, f"try {tries} of {device.pick_tries}")
            for line in pick_lines(device, feeder, label, point):
                ctx.send(line)
            self._take(feeder, index)
            try:
                self._check_held(ctx)
                lines = self._look(ctx, mover, block, feeder) if block.vision else block.place
            except Rejected as exc:
                reason = str(exc)
                where = self._discard(ctx, point)
                more = "trying the next pocket" if tries < device.pick_tries else "left out"
                self.setup.message("warning", f"{block.ref}: {reason}; {where}, {more}")
                continue
            for line in lines:
                ctx.send(line)
            self._check_released(ctx, f"{block.ref} was placed")
            ctx.progress.placed.append(block.ref)
            self._failed_in_a_row = 0
            self._doing(ctx, None)
            return
        ctx.progress.failed.append({"ref": block.ref, "reason": reason})
        self._doing(ctx, None)
        self._failed_in_a_row += 1
        if self._failed_in_a_row >= FAILED_IN_A_ROW:
            raise DeviceLinkError(f"{FAILED_IN_A_ROW} parts in a row were left out, the last as {reason}: check the setup before going on")

    def _take(self, feeder: Feeder, index: int) -> None:
        self.taken[feeder.id] = max(self.taken.get(feeder.id, 0), index + 1)
        self.setup.on_taken(feeder.id, self.taken[feeder.id])

    def _pocket(self, feeder: Feeder, index: int) -> tuple[float, float, float]:
        x, y, z = feeder.place_of(index if feeder.count > 0 else 0)
        fit = self.feeder_fits.get(feeder.id)
        if fit is not None:
            x, y = fit.apply((x, y))
        return (x, y, z)

    # --- the top camera ----------------------------------------------------------------

    def _find_marks(self, ctx: RunContext, mover: DeviceMover, feeder: Feeder) -> None:
        top = self.device.top
        assert top is not None
        self._doing(ctx, f"finding feeder {feeder.id}'s marks")
        pairs = []
        try:
            mover.begin()
            for mark in feeder.marks:
                seen = self.setup.top.look_at(
                    mover, mark, feeder.mark, top.within, top.z, center=True, routine="finding a feeder's marks", step=feeder.id
                )
                if seen is None:
                    raise DeviceLinkError(
                        f"feeder {feeder.id}'s mark at X {num(mark[0])} Y {num(mark[1])} is not within {top.within:g} mm of there"
                    )
                pairs.append((mark, seen))
        except (PnpError, VisionError) as exc:
            raise DeviceLinkError(f"finding feeder {feeder.id}'s marks: {exc}") from exc
        fit = fit_rigid(pairs, 0.0 if len(pairs) == 1 else None)
        self.feeder_fits[feeder.id] = fit
        turn = f", turned {fit.rotation:+.2f} degrees" if len(pairs) > 1 else ""
        self.setup.message("info", f"feeder {feeder.id} sits X {fit.shift[0]:+.3f} Y {fit.shift[1]:+.3f} mm off its profile{turn}")
        self._doing(ctx, None)

    def _look_in_pocket(self, ctx: RunContext, mover: DeviceMover, feeder: Feeder, block: Block, point, index: int) -> Point | None:
        top = self.device.top
        assert top is not None and feeder.pocket is not None
        self._doing(ctx, f"looking at pocket #{index + 1} of {feeder.id}")
        try:
            mover.begin()
            return self.setup.top.look_at(
                mover, (point[0], point[1]), feeder.pocket, top.within, top.z, size=block.size,
                routine="looking at a pocket", step=f"{feeder.id} #{index + 1}",
            )
        except (PnpError, VisionError) as exc:
            raise DeviceLinkError(f"looking at pocket #{index + 1} of {feeder.id}: {exc}") from exc

    # --- the vacuum ------------------------------------------------------------------

    def _read(self, ctx: RunContext, held: bool) -> float | None:
        vacuum = self.device.vacuum
        reply: list[str] = []
        lines = check_lines(self.device, held)
        if vacuum is None or not lines:
            return None
        for line in lines:
            reply = ctx.send(line)
        value = vacuum.reading(reply)
        if value is None:
            raise DeviceLinkError(f"'{vacuum.read}' answered no reading its pattern finds: {' | '.join(reply) or 'nothing'}")
        return value

    def _check_held(self, ctx: RunContext) -> None:
        value = self._read(ctx, held=True)
        vacuum = self.device.vacuum
        if value is None or vacuum is None:
            return
        low, high = vacuum.part_on
        if not low <= value <= high:
            raise Rejected(f"the vacuum read {num(value)} with no part held ({num(low)} to {num(high)} with one)")

    def _check_released(self, ctx: RunContext, what: str) -> None:
        """The nozzle is empty once a part was let go (`what` says which,
        in words); a part still on it stops the run, as the next pick would
        read as held whatever it took."""
        value = self._read(ctx, held=False)
        vacuum = self.device.vacuum
        if value is None or vacuum is None or vacuum.part_off is None:
            return
        low, high = vacuum.part_off
        if not low <= value <= high:
            raise DeviceLinkError(
                f"the vacuum read {num(value)} after {what} ({num(low)} to {num(high)} empty):"
                " the part may still be on the nozzle, so the run stops before it is let go somewhere else"
            )

    def _discard(self, ctx: RunContext, pocket: tuple[float, float, float]) -> str:
        """Lets a held part go at the discard place, or back in its pocket;
        what was done, in words."""
        device = self.device
        x, y, z, _ = device.axes
        target, where = (device.discard, "let go at the discard place") if device.discard is not None else (pocket, "put back in its pocket")
        lines = [
            safe_line(device),
            f"{device.move} {x}{num(target[0])} {y}{num(target[1])} {device.angle_word(0.0)} F{num(device.feed_xy, 0)}",
            f"{device.move} {z}{num(target[2])} F{num(device.feed_z, 0)}",
            *([device.wait] if device.wait else []),
            device.place,
            *dwell_line(device, device.place_dwell_ms),
            safe_line(device),
        ]
        for line in lines:
            ctx.send(line)
        self._check_released(ctx, f"a part was {where}")
        return where

    # --- the up camera -----------------------------------------------------------------

    def _look(self, ctx: RunContext, mover: DeviceMover, block: Block, feeder: Feeder) -> list[str]:
        """Over the up camera with the part just picked, turned to the angle
        it goes down at: the place lines that put its center on the place,
        its angle corrected; Rejected for a part that will not do."""
        device = self.device
        place = self.setup.up_place
        if place.position is None:
            raise DeviceLinkError("the up camera's place on the device is not measured: center the nozzle over it")
        runout = place.runout or (0.0, 0.0)
        axis = (place.position[0] + runout[0], place.position[1] + runout[1])
        angle = block.turn
        before: float | None = None
        for look in range(LOOKS):
            self._doing(ctx, f"looking at {block.ref} over the up camera" + (f" again ({look + 1})" if look else ""))
            swung = turned(runout, angle)
            head = (axis[0] - swung[0], axis[1] - swung[1])
            try:
                seen = self.setup.up.look_at_part(mover, place, None, angle=angle, head=head, size=block.size)
            except NoSpot as exc:
                raise Rejected("nothing on the nozzle over the up camera") from exc
            except (PnpError, VisionError) as exc:
                raise DeviceLinkError(f"looking at {block.ref} over the up camera: {exc}") from exc
            self.setup.up.part_offset = seen
            self.setup.publish_up()
            self._check_size(block, seen)
            off = (float(seen["dx"]), float(seen["dy"]))
            if math.hypot(*off) > device.max_offset:
                raise Rejected(f"it sits {math.hypot(*off):.3f} mm off the nozzle's center (at most {device.max_offset:g})")
            delta = self._angle_error(block, feeder, seen, angle)
            settled = abs(delta) <= ANGLE_SETTLED
            if before is not None and abs(before) > 1.0 and abs(delta) > abs(before) * 1.5:
                fix = "false" if device.rotation_cw else "true"
                raise DeviceLinkError(
                    f"turning {block.ref} by {-before:+.2f} degrees took it {delta - before:+.2f} further off:"
                    f" the rotation axis turns the other way; set [gcode] rotation_cw = {fix} in the profile"
                )
            if settled or look == LOOKS - 1:
                final = angle - delta
                # The part's center off the axis, turned on to the final angle.
                arm = turned((off[0] + axis[0] - head[0], off[1] + axis[1] - head[1]), final - angle)
                target = (block.target[0] + runout[0] - arm[0], block.target[1] + runout[1] - arm[1])
                return [safe_line(device), *place_lines(device, target, final, block.place_z)]
            before = delta
            angle = angle - delta
        raise AssertionError("the last look always places")

    def _check_size(self, block: Block, seen: dict) -> None:
        tolerance = self.device.size_tolerance
        if block.size is None or tolerance <= 0.0:
            return
        length, width = float(seen.get("length", 0.0)), float(seen.get("width", 0.0))
        want_length, want_width = block.size
        if abs(length - want_length) > tolerance * want_length or abs(width - want_width) > tolerance * want_width:
            raise Rejected(f"it looks {length:.2f} x {width:.2f} mm, not {want_length:.2f} x {want_width:.2f} (within {tolerance * 100:.0f}%)")

    def _angle_error(self, block: Block, feeder: Feeder, seen: dict, angle: float) -> float:
        """How far the part's long side is turned from its angle on the
        board, degrees in (-45, 45], with the nozzle at `angle`. 0 when the
        picture gives no direction (an older pcbv): the turn then goes
        uncorrected."""
        direction = seen.get("angle")
        if not isinstance(direction, (int, float)):
            if not self._no_angle_said:
                self._no_angle_said = True
                self.setup.message("warning", "the up camera tells no part's angle (pcb-vision before b4d1299): turns are not corrected")
            return 0.0
        delta = wrap90(float(direction) - block.angle)
        limit = self.device.max_turn
        if abs(delta) > limit:
            # Had the axis turned the other way, the part would sit at its
            # feeder's angle less the turn; the two can be told apart unless
            # twice the turn is about a quarter turn's multiple.
            wrong_way = wrap90(float(direction) - (feeder.rotation - angle))
            hint = (
                "; it sits as if the nozzle had turned the other way: check [gcode] rotation_cw"
                if abs(wrap90(2.0 * angle)) > limit and abs(wrong_way) <= limit
                else ""
            )
            raise Rejected(f"it sits {delta:+.1f} degrees off its angle (at most {limit:g}){hint}")
        return delta

