"""A placement run on a G-code machine: a board's parts placed one at a
time, each next line made from what the cameras and the vacuum sensor say.

On the machine's run thread:

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

Places on the machine are the head's with the nozzle's tip turned to 0
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

from spinny_laser.align import Fit, fit_rigid, turn

from .feederbus import BusError, FeederBus
from .gcode_link import GcodeLinkError, GcodeMover, GcodeLink, RunContext
from .kinematics import num
from .openpnp import (
    Block,
    GcodeMachine,
    Feeder,
    Plan,
    check_lines,
    count_code,
    pick_label,
    pick_lines,
    place_lines,
    plan,
    safe_line,
    wrap,
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


def fiducial_fit(found: list[Found], angle: float) -> Fit:
    """The board's place on the machine from the fiducials found: a shift
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
    """What a run is placed with besides the machine and its link."""

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
        machine: GcodeMachine,
        link: GcodeLink,
        parts: list[dict],
        fit: Fit,
        taken: dict[str, int],
        refs: list[str] | None,
        title: str,
        setup: PlaceSetup,
        fiducials: bool = False,
    ) -> None:
        self.machine = machine
        self.link = link
        self.parts = {part["ref"]: part for part in parts}
        self.all_parts = parts
        self.fit = fit
        self.taken = dict(taken)
        self.refs = refs
        self.title = title
        self.setup = setup
        self.feeders = {feeder.id: feeder for feeder in machine.feeders}
        self.feeder_fits: dict[str, Fit] = {}
        self.fiducials = [part for part in parts if part.get("fiducial")] if fiducials else []
        if fiducials and not self.fiducials:
            raise ValueError("the board has no fiducials to find: footprints whose reference starts FID or whose name says Fiducial")
        if fiducials and machine.top is None:
            raise ValueError("the machine file has no [top_camera] to find the fiducials with")
        self.program = self._plan(fit)
        self._no_angle_said = False
        self._failed_in_a_row = 0
        # The feeder bus as the run sees it: the addresses found and the
        # feeders initialized stay known from one part to the next.
        self._bus: FeederBus | None = None

    def _plan(self, fit: Fit) -> Plan:
        place = self.setup.up_place
        return plan(
            self.machine, self.all_parts, fit, self.taken, self.refs, title=self.title,
            vision_ready=place.measured, runout=place.runout or (0.0, 0.0),
        )

    def total(self) -> int:
        return count_code(self.program.text().splitlines())

    # --- the run -----------------------------------------------------------------

    def __call__(self, ctx: RunContext) -> None:
        machine = self.machine
        mover = GcodeMover(self.link, machine, send=ctx.send)
        ctx.progress.note(f"placing {len(self.program.blocks)} parts on {machine.name}")
        for line in self.program.head:
            ctx.send(line)
        if self.fiducials:
            self._find_fiducials(ctx, mover)
        blocks = self.program.blocks
        for number, block in enumerate(blocks):
            ctx.progress.total = ctx.progress.sent + self._lines(blocks[number:]) + count_code(self.program.tail)
            self._place(ctx, mover, block)
        for line in self.program.tail:
            ctx.send(line)
        failed = len(ctx.progress.failed)
        ctx.progress.note(f"done: {len(ctx.progress.placed)} placed" + (f", {failed} left out" if failed else ""))

    @staticmethod
    def _lines(blocks: list[Block]) -> int:
        return sum(count_code(block.lines) for block in blocks)

    def _doing(self, ctx: RunContext, what: str | None) -> None:
        ctx.progress.doing = what
        ctx.publish()

    def _find_fiducials(self, ctx: RunContext, mover: GcodeMover) -> None:
        top = self.machine.top
        assert top is not None
        self._doing(ctx, "finding the fiducials")
        guess = self.fit
        try:
            mover.begin()
            found = self.setup.top.locate_fiducials(mover, self.fiducials, guess.apply, top.fiducial, top.within, top.z)
            fit = fiducial_fit(found, guess.rotation)
        except (PnpError, VisionError) as exc:
            raise GcodeLinkError(f"finding the fiducials: {exc}") from exc
        self.setup.on_fiducials(found, fit)
        self.fit = fit
        self.program = self._plan(fit)
        rms = f", {fit.rms * 1000.0:.0f} um rms" if len(found) > 1 else ""
        said = f"{len(found)} fiducials found: the board is turned {fit.rotation:+.3f} degrees on the machine{rms}"
        self.setup.message("info", said)
        ctx.progress.note(said)
        self._doing(ctx, None)

    def _place(self, ctx: RunContext, mover: GcodeMover, block: Block) -> None:
        machine = self.machine
        feeder = self.feeders[block.feeder]
        part = self.parts[block.ref]
        ctx.progress.part = block.ref
        self._doing(ctx, None)
        if feeder.marks and feeder.id not in self.feeder_fits:
            self._find_marks(ctx, mover, feeder)
        reason = ""
        emptied = False
        for tries in range(1, machine.pick_tries + 1):
            index = self.taken.get(feeder.id, 0)
            if feeder.count > 0 and index >= feeder.count:
                reason = f"feeder {feeder.id} is empty"
                emptied = True
                break
            point = self._pocket(feeder, index)
            if feeder.pocket is not None:
                seen = self._look_in_pocket(ctx, mover, feeder, block, point, index)
                if seen is None:
                    self._take(feeder, index)
                    reason = f"pocket #{index + 1} of {feeder.id} looked empty"
                    self.setup.message("warning", f"{block.ref}: {reason}, passed over")
                    ctx.progress.note(f"{reason}, passed over", block.ref, "warning")
                    continue
                point = (seen[0], seen[1], point[2])
            if tries > 1:
                self._doing(ctx, f"try {tries} of {machine.pick_tries}")
            if feeder.bus_id is not None:
                try:
                    self._advance(ctx, feeder, block.ref)
                except BusError as exc:
                    reason = f"feeder {feeder.id} did not advance: {exc}"
                    break
            ctx.progress.note(f"picking {part.get('value', '')} from {feeder.id} #{index + 1}".replace("  ", " "), block.ref)
            for line in pick_lines(machine, feeder, pick_label(part, feeder, index), point):
                ctx.send(line)
            self._take(feeder, index)
            try:
                self._check_held(ctx)
                lines = self._look(ctx, mover, block, feeder) if block.vision else block.place
            except Rejected as exc:
                reason = str(exc)
                where = self._discard(ctx, point)
                more = "trying the next pocket" if tries < machine.pick_tries else "left out"
                self.setup.message("warning", f"{block.ref}: {reason}; {where}, {more}")
                ctx.progress.note(f"{reason}; {where}, {more}", block.ref, "warning")
                continue
            for line in lines:
                ctx.send(line)
            self._check_released(ctx, f"{block.ref} was placed")
            ctx.progress.placed.append(block.ref)
            ctx.progress.note(f"placed at X {num(block.target[0])} Y {num(block.target[1])}, {num(block.angle, 1)} deg", block.ref)
            self._failed_in_a_row = 0
            self._doing(ctx, None)
            return
        ctx.progress.failed.append({"ref": block.ref, "reason": reason})
        ctx.progress.note(f"left out: {reason}", block.ref, "error")
        self._doing(ctx, None)
        # A feeder that ran out is no sign of a wrong setup: the parts of
        # the other feeders still go.
        if emptied:
            return
        self._failed_in_a_row += 1
        if self._failed_in_a_row >= FAILED_IN_A_ROW:
            raise GcodeLinkError(f"{FAILED_IN_A_ROW} parts in a row were left out, the last as {reason}: check the setup before going on")

    def _advance(self, ctx: RunContext, feeder: Feeder, ref: str) -> None:
        """A feeder on the bus moves its tape on by one part before its pick."""
        bus_profile = self.machine.bus
        assert bus_profile is not None and feeder.bus_id is not None
        if self._bus is None:
            self._bus = FeederBus(bus_profile, send=ctx.send, stopped=lambda: self.link.stopping)
        self._doing(ctx, f"feeder {feeder.id} advancing")
        address = self._bus.advance(feeder.bus_id, round(feeder.advance * 10), feeder.slot)
        ctx.progress.note(f"feeder {feeder.id} advanced {num(feeder.advance)} mm (address {address})", ref)

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

    def _find_marks(self, ctx: RunContext, mover: GcodeMover, feeder: Feeder) -> None:
        top = self.machine.top
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
                    raise GcodeLinkError(
                        f"feeder {feeder.id}'s mark at X {num(mark[0])} Y {num(mark[1])} is not within {top.within:g} mm of there"
                    )
                pairs.append((mark, seen))
        except (PnpError, VisionError) as exc:
            raise GcodeLinkError(f"finding feeder {feeder.id}'s marks: {exc}") from exc
        fit = fit_rigid(pairs, 0.0 if len(pairs) == 1 else None)
        self.feeder_fits[feeder.id] = fit
        turn = f", turned {fit.rotation:+.2f} degrees" if len(pairs) > 1 else ""
        said = f"feeder {feeder.id} sits X {fit.shift[0]:+.3f} Y {fit.shift[1]:+.3f} mm off its profile{turn}"
        self.setup.message("info", said)
        ctx.progress.note(said)
        self._doing(ctx, None)

    def _look_in_pocket(self, ctx: RunContext, mover: GcodeMover, feeder: Feeder, block: Block, point, index: int) -> Point | None:
        top = self.machine.top
        assert top is not None and feeder.pocket is not None
        self._doing(ctx, f"looking at pocket #{index + 1} of {feeder.id}")
        try:
            mover.begin()
            return self.setup.top.look_at(
                mover, (point[0], point[1]), feeder.pocket, top.within, top.z, size=block.size,
                routine="looking at a pocket", step=f"{feeder.id} #{index + 1}",
            )
        except (PnpError, VisionError) as exc:
            raise GcodeLinkError(f"looking at pocket #{index + 1} of {feeder.id}: {exc}") from exc

    # --- the vacuum ------------------------------------------------------------------

    def _read(self, ctx: RunContext, held: bool) -> float | None:
        vacuum = self.machine.vacuum
        reply: list[str] = []
        lines = check_lines(self.machine, held)
        if vacuum is None or not lines:
            return None
        for line in lines:
            reply = ctx.send(line)
        value = vacuum.reading(reply)
        if value is None:
            raise GcodeLinkError(f"'{vacuum.read[-1]}' answered no reading its pattern finds: {' | '.join(reply) or 'nothing'}")
        return value

    def _check_held(self, ctx: RunContext) -> None:
        value = self._read(ctx, held=True)
        vacuum = self.machine.vacuum
        if value is None or vacuum is None or vacuum.part_on is None:
            return
        low, high = vacuum.part_on
        if not low <= value <= high:
            raise Rejected(f"the vacuum read {num(value)} with no part held ({num(low)} to {num(high)} with one)")
        ctx.progress.note(f"vacuum {num(value)}: held", ctx.progress.part)

    def _check_released(self, ctx: RunContext, what: str) -> None:
        """The nozzle is empty once a part was let go (`what` says which,
        in words); a part still on it stops the run, as the next pick would
        read as held whatever it took."""
        value = self._read(ctx, held=False)
        vacuum = self.machine.vacuum
        if value is None or vacuum is None or vacuum.part_off is None:
            return
        low, high = vacuum.part_off
        if not low <= value <= high:
            raise GcodeLinkError(
                f"the vacuum read {num(value)} after {what} ({num(low)} to {num(high)} empty):"
                " the part may still be on the nozzle, so the run stops before it is let go somewhere else"
            )

    def _discard(self, ctx: RunContext, pocket: tuple[float, float, float]) -> str:
        """Lets a held part go at the discard place, or back in its pocket;
        what was done, in words."""
        machine = self.machine
        target, where = (machine.discard, "let go at the discard place") if machine.discard is not None else (pocket, "put back in its pocket")
        # Put down as a place is, with the nozzle turned back to 0.
        for line in [safe_line(machine), *place_lines(machine, (target[0], target[1]), 0.0, target[2])]:
            ctx.send(line)
        self._check_released(ctx, f"a part was {where}")
        return where

    # --- the up camera -----------------------------------------------------------------

    def _look(self, ctx: RunContext, mover: GcodeMover, block: Block, feeder: Feeder) -> list[str]:
        """Over the up camera with the part just picked, turned to the angle
        it goes down at: the place lines that put its center on the place,
        its angle corrected; Rejected for a part that will not do."""
        machine = self.machine
        place = self.setup.up_place
        if place.position is None:
            raise GcodeLinkError("the bottom camera's place on the machine is not measured: center the nozzle over it")
        runout = place.runout or (0.0, 0.0)
        axis = (place.position[0] + runout[0], place.position[1] + runout[1])
        angle = block.turn
        before: float | None = None
        for look in range(LOOKS):
            self._doing(ctx, f"looking at {block.ref} over the bottom camera" + (f" again ({look + 1})" if look else ""))
            swung = turn(runout, angle)
            head = (axis[0] - swung[0], axis[1] - swung[1])
            try:
                seen = self.setup.up.look_at_part(mover, place, None, angle=angle, head=head, size=block.size, crop=block.crop)
            except NoSpot as exc:
                raise Rejected("nothing on the nozzle over the bottom camera") from exc
            except (PnpError, VisionError) as exc:
                raise GcodeLinkError(f"looking at {block.ref} over the bottom camera: {exc}") from exc
            self.setup.up.part_offset = seen
            self.setup.publish_up()
            angle_said = f", long side at {num(float(seen['angle']), 1)} deg" if isinstance(seen.get("angle"), (int, float)) else ""
            ctx.progress.note(f"seen over the bottom camera {num(float(seen['mm']))} mm off the nozzle{angle_said}", block.ref)
            self._check_size(block, seen)
            off = (float(seen["dx"]), float(seen["dy"]))
            if math.hypot(*off) > machine.max_offset:
                raise Rejected(f"it sits {math.hypot(*off):.3f} mm off the nozzle's center (at most {machine.max_offset:g})")
            delta = self._angle_error(block, feeder, seen, angle)
            settled = abs(delta) <= ANGLE_SETTLED
            if before is not None and abs(before) > 1.0 and abs(delta) > abs(before) * 1.5:
                fix = "false" if machine.rotation_cw else "true"
                raise GcodeLinkError(
                    f"turning {block.ref} by {-before:+.2f} degrees took it {delta - before:+.2f} further off:"
                    f" the rotation axis turns the other way; set [gcode] rotation_cw = {fix} in the profile"
                )
            if settled or look == LOOKS - 1:
                final = angle - delta
                # The part's center off the axis, turned on to the final angle.
                arm = turn((off[0] + axis[0] - head[0], off[1] + axis[1] - head[1]), final - angle)
                target = (block.target[0] + runout[0] - arm[0], block.target[1] + runout[1] - arm[1])
                return [safe_line(machine), *place_lines(machine, target, final, block.place_z)]
            before = delta
            angle = angle - delta
        raise AssertionError("the last look always places")

    def _check_size(self, block: Block, seen: dict) -> None:
        tolerance = self.machine.size_tolerance
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
                self.setup.message("warning", "the bottom camera tells no part's angle (pcb-vision before b4d1299): turns are not corrected")
            return 0.0
        delta = wrap(float(direction) - block.angle, 90.0)
        limit = self.machine.max_turn
        if abs(delta) > limit:
            # Had the axis turned the other way, the part would sit at its
            # feeder's angle less the turn; the two can be told apart unless
            # twice the turn is about a quarter turn's multiple.
            wrong_way = wrap(float(direction) - (feeder.rotation - angle), 90.0)
            hint = (
                "; it sits as if the nozzle had turned the other way: check [gcode] rotation_cw"
                if abs(wrap(2.0 * angle, 90.0)) > limit and abs(wrong_way) <= limit
                else ""
            )
            raise Rejected(f"it sits {delta:+.1f} degrees off its angle (at most {limit:g}){hint}")
        return delta

