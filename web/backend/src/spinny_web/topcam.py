"""A G-code pick and place machine's top camera: fixed to its head beside
the nozzle and looking down, through pcb-vision like the other cameras.

Every place on the machine is the head's with the nozzle's tip (turned to
0) over a point. The camera's `offset` is where its picture's center is
from the tip, so the head looks at a point from the point less the
offset, and a spot seen there lies at the head's place plus the offset
plus the spot's displacement in the picture. The camera rides on the
head, so a fixed spot moves against the head's moves in the picture.

The offset, the picture's scale, roll and mirror come from one mark: the
nozzle's tip is put over the mark by hand (Nozzle on mark keeps the
head's place), then the routine moves the head so the camera should see
the mark (from the place it stands at when no offset is known yet),
measures the picture with a step along X and one along Y, and centers
the mark, where the offset is the nozzle's place less the head's.

The same look finds a board's fiducials (Find fiducials, or the start of
a run), a feeder's marks and a part in its pocket.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass
from typing import Callable

from pydantic import BaseModel, ConfigDict, Field

from spinny_laser import machines as machine_files

from .camera import CORNER_MM, LOOK_THRESHOLD, SETTLE_SECONDS, Spot, check_look, feature_limits, picture_to_machine, round_problem, spot_of
from .cameras import check_controls
from .openpnp import SHADES
from .pictures import CameraMap, fit_camera, fresh_gray, phase_shift
from .pnp import Mover, PickCamera, PnpError, RoutineProgress, calibrate
from .vision import check_colors, check_lens

Point = tuple[float, float]
OFFSET_STEPS = ("lifting", "moving", "lowering", "scale", "centering", "done")
# A spot is centered once within this of the picture's center, mm, after
# at most this many moves; a look that centers takes this many more.
CENTER_TOLERANCE = 0.02
CENTER_TRIES = 4
LOOK_TRIES = 2
DEFAULT_STEP = 2.0
MAX_STEP = 20.0
OFFSET_LIMIT = 500.0
# Measure camera: the picture's scale, roll and mirror from the head's
# moves alone, over any surface with texture (pictures.fit_camera). A first
# move of PROBE_MM along X tells the scale roughly; the grid's step then
# shifts the picture by GRID_SHARE of its height (within GRID_MM), over a 3
# by 3 grid about the start, GRID_PASSES times. Pictures are measured
# MEASURE_WIDTH px wide at most; a shift whose correlation peaks under
# MIN_PEAK shares too little with the first picture, and a fit worse than
# FIT_RMS_PX (full size px) is refused. On a LumenPnP (3 mm steps, twice)
# the moves fitted to 0.9 px rms, with 8 to 18 um of backlash on a return.
PICTURE_STEPS = ("lifting", "probing", "grid", "fitting", "done")
PROBE_MM = 0.5
GRID_SHARE = 0.15
GRID_MM = (0.2, 5.0)
GRID_PASSES = 2
MEASURE_WIDTH = 640
MIN_PEAK = 0.05
FIT_RMS_PX = 3.0
# Every grid place is reached from this far below it along X and Y, mm.
APPROACH_MM = 0.3
# A picture is taken once two in a row lie within this of each other
# (full size px), at most this long after the settle time: on a LumenPnP
# a fixed 0.25 s left 1.1 px rms over the grid, 0.75 s 0.59 px.
STILL_PX = 0.3
STILL_SECONDS = 1.5


def nearest_turn(degrees: float, near: float) -> float:
    """`degrees` written the way nearest `near` (a roll of -179.6 near
    180 reads 180.4): the same turn, so a setting keeps its written form."""
    return near + ((degrees - near + 180.0) % 360.0 - 180.0)


def _full_width(size: str, reply: dict) -> float:
    """The full size picture's width, px: the camera's size setting
    (WIDTHxHEIGHT), else the shrunk picture's own width."""
    match = machine_files._CAMERA_SIZE.match(size or "")
    if match:
        return float(size.split("x")[0])
    return float(reply["width"])


@dataclass
class Found:
    """A fiducial found: its reference, its place in the job and where it
    is on the machine."""

    ref: str
    job: Point
    seen: Point


class TopCameraSettings(BaseModel):
    """What the backend keeps of the top camera, with what it keeps of the G-code machine."""

    model_config = ConfigDict(extra="forbid")

    device: str = "/dev/video4"
    size: str = "1280x720"
    fps: int = 30
    pcbv: str = "pcbv"
    # The shade of the mark the offset is measured from.
    mark_spot: str = "dark"
    # The head's place with the nozzle's tip over that mark.
    mark_at: tuple[float, float] | None = None
    # Where the picture's center is from the nozzle's tip, mm; None until measured.
    offset: tuple[float, float] | None = None
    mm_per_px: float = 0.0
    roll: float = 0.0
    mirror: bool = False
    # V4L2 control values set on the device each time the camera starts.
    controls: dict[str, int] = Field(default_factory=dict)
    # The look for a board: the threshold of the most likely guess, and
    # the corners' tolerance (mm).
    look_threshold: float = LOOK_THRESHOLD
    corner_mm: float = CORNER_MM
    # How the look calls a board found (vote or posterior) and whether the
    # posterior fits the board's stretch; a G-code machine reports its
    # place only at rest, so its scans always stop for each picture.
    look_method: str = "vote"
    board_stretch: bool = False
    # The board as the camera sees it: the side looked at, whether solder
    # mask hides its copper, and whether it carries solder paste (the parts
    # placed on it are told to pcbv as a run places them).
    side: str = "front"
    finish: str = "masked"
    paste: bool = False
    # The lens correction measured from a dot grid, sent at every start.
    lens: dict[str, float] | None = None
    # Colors picked from the picture for what the camera looks for
    # (vision.COLOR_ITEMS): spots of that color instead of a shade, the
    # board's pads, a blank board's edges.
    colors: dict[str, list[int]] = Field(default_factory=dict)
    # Where the nozzle generally shows in the picture, as drawn on it: a
    # box x0, y0, x1, y1 in shares of the picture's width and height from
    # its top left (0 to 1), so another capture size keeps it. The nozzle
    # rides on the head with the camera, so the box stays put in the
    # picture wherever the head goes. None until drawn.
    nozzle_box: tuple[float, float, float, float] | None = None

    def check(self) -> None:
        if not self.device.strip():
            raise ValueError("the top camera device must be named")
        if self.nozzle_box is not None:
            x0, y0, x1, y1 = self.nozzle_box
            if not all(math.isfinite(v) and 0.0 <= v <= 1.0 for v in self.nozzle_box) or x0 >= x1 or y0 >= y1:
                raise ValueError("the nozzle box must be x0 y0 x1 y1 within the picture, 0 to 1, the first corner left of and above the second")
        check_lens(self.lens)
        check_colors(self.colors)
        if self.side not in machine_files.CAMERA_SIDES:
            raise ValueError("the top camera side must be front or back")
        if self.finish not in machine_files.CAMERA_FINISHES:
            raise ValueError("the top camera finish must be masked or bare")
        check_controls(self.controls)
        check_look(self.look_threshold, self.corner_mm, self.look_method)
        if not machine_files._CAMERA_SIZE.match(self.size):
            raise ValueError("the top camera size must be WIDTHxHEIGHT")
        if not 1 <= int(self.fps) <= 120:
            raise ValueError("the top camera fps must be 1 to 120")
        if not self.pcbv.strip():
            raise ValueError("the pcbv program must be named")
        if self.mark_spot not in SHADES:
            raise ValueError("the mark spot is dark or bright")
        for name, value in (("mark place", self.mark_at), ("offset", self.offset)):
            if value is not None and any(not math.isfinite(v) or abs(v) > 10000.0 for v in value):
                raise ValueError(f"the top camera's {name} must be two numbers within 10000 mm")
        if not (math.isfinite(self.mm_per_px) and 0.0 <= self.mm_per_px <= 1.0):
            raise ValueError("mm_per_px must be 0 to 1")
        if not (math.isfinite(self.roll) and abs(self.roll) <= 360.0):
            raise ValueError("the top camera roll must be within 360 degrees")

    @property
    def measured(self) -> bool:
        return self.offset is not None and self.mm_per_px > 0.0


class TopCamera(PickCamera):
    """The top camera's settings and state, pcbv behind them, the routines,
    and the look a placing run uses. `store` gives the dict its settings
    live in (what the backend keeps of the G-code machine placed with)."""

    label = "top camera"
    log_name = "top"
    key = "top"
    Settings = TopCameraSettings
    places = ("mark_at", "offset", "nozzle_box")
    clearable = ("mark_at", "offset", "nozzle_box")
    routines = {
        "offset": "measuring the top camera's offset", "fiducials": "finding the fiducials", "search": "looking for the board",
        "scan": "scanning the board", "home": "homing by the fiducial", "picture": "measuring the top camera's picture",
    }

    def __init__(self, store: Callable[[], dict], save: Callable[[], None], publish: Callable[[], None], message: Callable[[str, str], None]) -> None:
        super().__init__(store, save, publish, message)
        # The last fiducials found: the job, each one's places, the fit's rms.
        self.fiducials: dict | None = None
        # The numbers of the last Measure camera (CameraMap's and the run's).
        self.measured_picture: dict | None = None

    def settings(self) -> TopCameraSettings:
        return super().settings()

    def update(self, patch: dict, clear: tuple[str, ...] = ()) -> TopCameraSettings:
        return super().update(patch, clear)

    def state(self) -> dict:
        return {**super().state(), "fiducials": self.fiducials, "measured_picture": self.measured_picture}

    # --- the look -----------------------------------------------------------------

    def look_at(
        self,
        mover: Mover,
        point: Point,
        shade: str,
        within: float,
        z: float | None,
        size: tuple[float, float] | None = None,
        diameter: float | None = None,
        center: bool = False,
        routine: str = "looking",
        step: str = "",
        progress: RoutineProgress | None = None,
    ) -> Point | None:
        """Where the spot of `shade` nearest `point` (a place of the tip)
        is, looked for within `within` mm of it from the head's place over
        it at `z` (the travel height when None), of about `size` (length,
        width) or `diameter` when given; with `center` the head moves onto
        the spot and looks again, so the picture's middle measures it. None
        when there is none. The mover has begun."""
        settings = self.settings()
        if not settings.measured or settings.offset is None:
            raise PnpError("the top camera's offset is not measured: put the nozzle on a mark, then Measure offset")
        if not self.client.running:
            raise PnpError("the top camera is not running: start it first")
        offset = settings.offset
        head = (point[0] - offset[0], point[1] - offset[1])
        mover.lift()
        mover.go(head)
        if z is not None:
            mover.lower(z)
        scale = settings.mm_per_px
        limits: dict = {}
        if size is not None:
            area = size[0] * size[1] / (scale * scale)
            limits = {"min_area": area * 0.25, "max_area": area * 4.0}
        elif diameter is not None and diameter > 0.0:
            # A fiducial: round, of about its size (camera.feature_limits).
            limits = feature_limits(diameter, scale)
        seen: Point | None = None
        for _ in range(1 + (LOOK_TRIES if center else 0)):
            if mover.stopped():
                raise PnpError("stopped")
            reply = self._find_spot(radius=within / scale, polarity=shade, **limits)
            self._log_look(routine, step, reply, shade)
            if not reply.get("found"):
                return None
            problem = round_problem(reply) if "min_roundness" in limits else None
            if problem is not None:
                raise PnpError(f"{step or 'the mark'}: {problem}; the light, the shade looked for, or the board's place")
            off = picture_to_machine(float(reply.get("dx", 0.0)), float(reply.get("dy", 0.0)), scale, settings.roll, settings.mirror)
            if progress is not None:
                progress.spot = spot_of(reply, within / scale)
                progress.spot.mm = math.hypot(*off)
                self._publish()
            seen = (head[0] + offset[0] + off[0], head[1] + offset[1] + off[1])
            if not center or math.hypot(*off) <= CENTER_TOLERANCE:
                break
            head = (head[0] + off[0], head[1] + off[1])
            mover.go(head)
        return seen

    def locate_fiducials(
        self,
        mover: Mover,
        fiducials: list[dict],
        guess: Callable[[Point], Point],
        shade: str,
        within: float,
        z: float | None,
        progress: RoutineProgress | None = None,
    ) -> list[Found]:
        """Each fiducial (`ref`, `x`, `y` in the job, `diameter`) found
        where `guess` puts it on the machine, centered in the picture; a
        PnpError names the one that is not there."""
        found: list[Found] = []
        for fiducial in fiducials:
            ref = str(fiducial["ref"])
            self._step(progress, ref)
            job = (float(fiducial["x"]), float(fiducial["y"]))
            expected = guess(job)
            diameter = fiducial.get("diameter")
            seen = self.look_at(
                mover, expected, shade, within, z,
                diameter=float(diameter) if isinstance(diameter, (int, float)) else None,
                center=True, routine="finding fiducials", step=ref, progress=progress,
            )
            if seen is None:
                raise PnpError(f"fiducial {ref} is not within {within:g} mm of where the board's place puts it: a reference closer to it, or a wider [top_camera] within")
            found.append(Found(ref=ref, job=job, seen=(round(seen[0], 4), round(seen[1], 4))))
        return found

    # --- the routines ---------------------------------------------------------------

    def measure_offset(self, mover: Mover, step: float, z: float | None, guess: Point | None) -> None:
        """Starts the offset routine on its own thread. `z` is the height
        the head looks from, `guess` the profile's offset, used until one is
        measured. What it measures is kept at once and logged (findings.py)."""
        if not (math.isfinite(step) and 0.0 <= step <= MAX_STEP):
            raise ValueError(f"the step must be 0 to {MAX_STEP:g} mm")
        if self.settings().mark_at is None:
            raise ValueError("put the nozzle's tip over a mark and press Nozzle on mark first")
        self._begin("offset", OFFSET_STEPS, mover, lambda progress: self._offset(mover, progress, step, z, guess))

    def measure_picture(
        self, mover: Mover, step: float, z: float | None, keep: Callable[[CameraMap, dict], str] | None = None, near_roll: float | None = None,
        approach: float = APPROACH_MM, settle: float = 0.0,
    ) -> None:
        """Starts Measure camera on its own thread: the picture's scale,
        roll and mirror from the head's moves over whatever lies under the
        camera (a board, a printed pattern: anything with texture that does
        not repeat within a few mm), no mark needed. `step` is the grid's
        step, mm (0: one that shifts the picture by GRID_SHARE of its
        height). `z` is the height the head looks from. `keep` takes the
        map and the run's numbers and keeps them, answering the words to
        say (by default the settings take the scale, roll and mirror).
        The roll is written the way nearest `near_roll` (the roll in use),
        else the settings' roll. Every place is reached from `approach` mm
        below it along X and Y, and pictured `settle` s later than a look
        after a move would be."""
        if not (math.isfinite(step) and 0.0 <= step <= GRID_MM[1]):
            raise ValueError(f"the step must be 0 to {GRID_MM[1]:g} mm")
        if not (math.isfinite(approach) and 0.0 <= approach <= GRID_MM[1] and math.isfinite(settle) and 0.0 <= settle <= 5.0):
            raise ValueError(f"the approach must be 0 to {GRID_MM[1]:g} mm and the settle 0 to 5 s")
        self._begin("picture", PICTURE_STEPS, mover, lambda progress: self._picture(mover, progress, step, z, keep, near_roll, approach, settle))

    def _picture(
        self, mover: Mover, progress: RoutineProgress, step: float, z: float | None, keep: Callable[[CameraMap, dict], str] | None,
        near_roll: float | None, approach: float = 0.0, settle: float = 0.0,
    ) -> None:
        settings = self.settings()
        mover.begin()
        self._step(progress, "lifting")
        mover.lift()
        if z is not None:
            mover.lower(z)
        start = mover.here()

        def picture():
            # The head still rings after a move: pictures are taken until
            # two in a row agree within STILL_PX, for at most STILL_SECONDS.
            gray, reply = fresh_gray(self.client, time.monotonic() + SETTLE_SECONDS + settle, MEASURE_WIDTH, mover.stopped)
            factor = _full_width(settings.size, reply) / float(reply["width"])
            until = time.monotonic() + STILL_SECONDS
            while time.monotonic() < until:
                later, reply = fresh_gray(self.client, time.monotonic(), MEASURE_WIDTH, mover.stopped)
                dx, dy, _ = phase_shift(gray, later)
                gray = later
                if math.hypot(dx, dy) * factor <= STILL_PX:
                    break
            return gray, reply

        def reach(point: Point) -> None:
            # Every place from the same side, so the axes' backlash is
            # taken up the same way at each picture.
            if approach > 0.0:
                mover.go((point[0] - approach, point[1] - approach))
            mover.go(point)

        def shift_to(point: Point, first) -> tuple[float, float, float]:
            reach(point)
            gray, _ = picture()
            dx, dy, peak = phase_shift(first, gray)
            if peak < MIN_PEAK:
                raise PnpError(
                    f"the picture at {mover.describe(point)} shares too little with the first (correlation {peak:.3f}):"
                    " measure over a board or a printed pattern, with a shorter step"
                )
            return dx, dy, peak

        reach(start)
        first, reply = picture()
        full_width = _full_width(settings.size, reply)
        factor = full_width / float(reply["width"])
        self._step(progress, "probing")
        if step <= 0.0:
            dx, dy, _ = shift_to((start[0] + PROBE_MM, start[1]), first)
            moved = math.hypot(dx, dy)
            if moved < 0.5:
                raise PnpError("the picture did not move with the head: is the camera on the head, over something with texture?")
            per_px = PROBE_MM / moved
            step = min(max(GRID_SHARE * first.shape[0] * per_px, GRID_MM[0]), GRID_MM[1])
            step = round(step, 2)
        self._step(progress, "grid")
        moves: list[Point] = []
        shifts: list[Point] = []
        peaks: list[float] = []
        rows: list[list[float]] = []
        order = [(i, j) for j in (-1, 0, 1) for i in ((-1, 0, 1) if j != 0 else (1, 0, -1))]
        for _ in range(GRID_PASSES):
            for i, j in order:
                dx, dy, peak = shift_to((start[0] + i * step, start[1] + j * step), first)
                moves.append((i * step, j * step))
                shifts.append((dx, dy))
                peaks.append(peak)
                rows.append([round(i * step, 4), round(j * step, 4), round(dx * factor, 3), round(dy * factor, 3), round(peak, 4)])
        # Back where it began: how far the picture lies from the first is
        # the backlash and drift the moves hold.
        back = shift_to(start, first)
        self._step(progress, "fitting")
        fit = fit_camera(moves, shifts)
        mm_per_px = fit.mm_per_px / factor
        rms_px, worst_px = fit.rms_px * factor, fit.worst_px * factor
        if rms_px > FIT_RMS_PX:
            raise PnpError(
                f"the head's moves fit the pictures badly ({rms_px:.1f} px rms over the grid): the head may slip, or the surface"
                " repeats within the step; measure over another place"
            )
        roll = nearest_turn(fit.roll, settings.roll if near_roll is None else near_roll)
        returned_um = math.hypot(back[0], back[1]) * factor * mm_per_px * 1000.0
        numbers = {
            **fit.to_dict(), "mm_per_px": round(mm_per_px, 7), "mm_per_px_x": round(fit.mm_per_px_x / factor, 7),
            "mm_per_px_y": round(fit.mm_per_px_y / factor, 7), "roll": round(roll, 4), "rms_px": round(rms_px, 3),
            "worst_px": round(worst_px, 3), "step": step, "pictures": len(moves) + 1, "returned_um": round(returned_um, 1),
            "least_peak": round(min(peaks), 4), "head": [round(start[0], 4), round(start[1], 4)],
            "approach": approach, "settle": settle, "returned_px": [round(back[0] * factor, 3), round(back[1] * factor, 3)],
            # Each grid picture: the head's move (mm), the shift seen (full size px), the correlation's peak.
            "rows": rows,
        }
        words = (
            f"the top camera's picture measured by the head's moves: {mm_per_px * 1000.0:.2f} um a pixel"
            f" ({numbers['mm_per_px_x'] * 1000.0:.2f} along X, {numbers['mm_per_px_y'] * 1000.0:.2f} along Y),"
            f" roll {roll:.2f} degrees{', mirrored' if fit.mirror else ''}, the axes {abs(fit.skew_deg):.2f} degrees from square,"
            f" {rms_px:.2f} px rms, back at the start within {returned_um:.0f} um"
        )
        self.measured_picture = numbers
        if keep is not None:
            self._message("info", keep(fit, numbers))
            return
        self.update({"mm_per_px": round(mm_per_px, 7), "roll": round(roll, 4), "mirror": fit.mirror})
        self._message("info", words)

    def find_fiducials(
        self,
        mover: Mover,
        fiducials: list[dict],
        guess: Callable[[Point], Point],
        shade: str,
        within: float,
        z: float | None,
        done: Callable[[list[Found]], str],
    ) -> None:
        """Starts the fiducial routine on its own thread; `done` hears what
        was found, keeps it (and logs it, findings.py) and answers the line
        to say of it."""
        if not fiducials:
            raise ValueError("the board has no fiducials: footprints whose reference starts FID or whose name says Fiducial")
        if not self.settings().measured:
            raise ValueError("the top camera's offset is not measured: put the nozzle on a mark, then Measure offset")
        steps = ("lifting", *[str(f["ref"]) for f in fiducials], "fitting", "done")

        def body(progress: RoutineProgress) -> None:
            mover.begin()
            self._step(progress, "lifting")
            found = self.locate_fiducials(mover, fiducials, guess, shade, within, z, progress)
            self._step(progress, "fitting")
            self._message("info", done(found))

        self._begin("fiducials", steps, mover, body)

    def home_by_fiducial(
        self,
        mover: Mover,
        fiducial: Point,
        shade: str,
        within: float,
        z: float | None,
        home: Callable[[], None] | None,
        declare: Callable[[Point], None],
    ) -> None:
        """Starts the visual home on its own thread: the machine homed
        (`home`, the file's home line; None finds the fiducial from where
        the head's numbers are now), the bed's homing fiducial looked for
        within `within` mm of `fiducial` (the nozzle's place over it, as
        the file has it) and centered in the picture, then the head's X Y
        declared (`declare`, a G92) so the controller's numbers put the
        fiducial where the file says. The switches find home to a few
        hundredths; the fiducial ties the numbers to the bed itself."""
        if not self.settings().measured:
            raise ValueError("the top camera's offset is not measured: put the nozzle on a mark, then Measure offset")
        if not self.client.running:
            raise ValueError("the top camera is not running: start it first")

        def body(progress: RoutineProgress) -> None:
            if home is not None:
                self._step(progress, "homing")
                home()
            mover.begin()
            self._step(progress, "looking")
            seen = self.look_at(mover, fiducial, shade, within, z, center=True, routine="homing by fiducial", step="fiducial", progress=progress)
            if seen is None:
                raise PnpError(f"no fiducial within {within:g} mm of X {fiducial[0]:.3f} Y {fiducial[1]:.3f}: check [top_camera] home_fiducial, or widen within")
            self._step(progress, "declaring")
            # The numbers put the fiducial at `seen`; it is at `fiducial`.
            shift = (seen[0] - fiducial[0], seen[1] - fiducial[1])
            here = mover.here()
            declare((round(here[0] - shift[0], 4), round(here[1] - shift[1], 4)))
            mover.begin()
            against = "the switches' home" if home is not None else "where its numbers said"
            self._message("info", f"homed by the fiducial: the head was {shift[0]:+.3f}, {shift[1]:+.3f} mm off {against}")

        steps = ("homing", "looking", "declaring", "done") if home is not None else ("looking", "declaring", "done")
        self._begin("home", steps, mover, body)

    def _offset(self, mover: Mover, progress: RoutineProgress, step: float, z: float | None, guess: Point | None) -> None:
        settings = self.settings()
        mark_at = settings.mark_at
        if mark_at is None:
            raise PnpError("put the nozzle's tip over a mark and press Nozzle on mark first")
        mover.begin()
        self._step(progress, "lifting")
        mover.lift()
        self._step(progress, "moving")
        start = settings.offset if settings.offset is not None else guess
        if start is not None:
            mover.go((mark_at[0] - start[0], mark_at[1] - start[1]))
        self._step(progress, "lowering")
        if z is not None:
            mover.lower(z)
        shade = settings.mark_spot
        scale, roll, mirror = settings.mm_per_px, settings.roll, settings.mirror
        missing = "no mark in the picture: jog the camera over it and measure again"
        spot = self._spot(mover, progress, shade, scale, roll, mirror, missing)
        if step > 0.0 or scale <= 0.0:
            self._step(progress, "scale")
            move = step if step > 0.0 else DEFAULT_STEP
            here = mover.here()
            mover.go((here[0] + move, here[1]))
            along = self._spot(mover, progress, shade, scale, roll, mirror, "the mark left the picture on the move along X: use a shorter step")
            mover.go((here[0], here[1] + move))
            across = self._spot(mover, progress, shade, scale, roll, mirror, "the mark left the picture on the move along Y: use a shorter step")
            mover.go(here)
            # The camera rides on the head: a mark that stays put moves
            # against the head's move in the picture.
            scale, roll, mirror = calibrate((spot.dx - along.dx, spot.dy - along.dy), (spot.dx - across.dx, spot.dy - across.dy), move)
            spot = self._spot(mover, progress, shade, scale, roll, mirror, missing)
        self._step(progress, "centering")
        for _ in range(CENTER_TRIES):
            off = picture_to_machine(spot.dx, spot.dy, scale, roll, mirror)
            if math.hypot(*off) <= CENTER_TOLERANCE:
                break
            here = mover.here()
            mover.go((here[0] + off[0], here[1] + off[1]))
            spot = self._spot(mover, progress, shade, scale, roll, mirror, "the mark left the picture while centering")
        off = picture_to_machine(spot.dx, spot.dy, scale, roll, mirror)
        here = mover.here()
        offset = (round(mark_at[0] - here[0] - off[0], 4), round(mark_at[1] - here[1] - off[1], 4))
        if any(abs(v) > OFFSET_LIMIT for v in offset):
            raise PnpError(f"the offset came out {offset[0]:.1f}, {offset[1]:.1f} mm: is the mark the one the nozzle was put on?")
        words = (
            f"the top camera looks from X {offset[0]:+.3f} Y {offset[1]:+.3f} mm off the nozzle,"
            f" {scale * 1000.0:.1f} um per pixel, roll {roll:+.2f} degrees{', mirrored' if mirror else ''}"
        )
        # Kept at once and logged, the mark centered in the picture drawn
        # while the page offers its Undo.
        self._message("info", self.findings.keep("offset", words, {"offset": offset, "mm_per_px": scale, "roll": roll, "mirror": mirror}, marks={"spot": spot.to_dict()}))

    def _spot(self, mover: Mover, progress: RoutineProgress, shade: str, scale: float, roll: float, mirror: bool, missing: str) -> Spot:
        if mover.stopped():
            raise PnpError("stopped")
        reply = self._find_spot(polarity=shade)
        self._log_look("measuring the top camera's offset", progress.step, reply, shade)
        if not reply.get("found"):
            raise PnpError(missing)
        spot = spot_of(reply)
        if scale > 0.0:
            spot.mm = math.hypot(*picture_to_machine(spot.dx, spot.dy, scale, roll, mirror))
        progress.spot = spot
        self._publish()
        return spot
