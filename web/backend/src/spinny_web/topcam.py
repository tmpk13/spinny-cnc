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
from dataclasses import dataclass, replace
from typing import Callable

from pydantic import BaseModel, ConfigDict, Field

from spinny_laser import machines as machine_files

from .camera import CORNER_MM, DONE, ERROR, LOOK_THRESHOLD, SETTLE_SECONDS, STOPPED, Spot, check_look, feature_limits, look_dict, picture_to_machine, round_problem, spot_of
from .cameras import check_controls
from .crops import crop_rows, cut
from .openpnp import SHADES
from .pictures import CameraMap, RoundEdge, average_gray, fit_camera, fit_lens, fresh_gray, phase_shift, round_edge
from .pnp import DEFAULT_STEP as NOZZLE_STEP
from .pnp import NOZZLE_STEPS, TAKE_UP, CameraPlace, Mover, PickCamera, PnpError, RoutineProgress, UpCamera, calibrate
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
# What a look says when it cannot go: by the measured offset with none
# measured, or by an offset given with no scale to turn pixels into mm.
OFFSET_NEEDED = "the top camera's offset is not measured: Offset by bottom camera, or a mark (Nozzle on mark, then Measure offset)"
SCALE_NEEDED = "the top camera's scale is not measured: Measure camera, or a search that finds a board, measures it"
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

# Offset by bottom camera: the offset without a mark, by the bottom camera.
# The nozzle is centered over the bottom camera (Center nozzle's routine),
# then with both nozzles up the head is brought over it, so the cameras face
# each other, and each one's look across is centered: the top camera's
# picture center on the bottom camera (the circle of its ring light's edge,
# pictures.round_edge, over FACING_PICTURES pictures averaged), and the top
# camera's lens on the bottom camera's picture center (pcbv's round spot,
# UpCamera.lens_look). The nozzle's place less each of those head places is
# an offset; neither is the one placing needs.
#
# A camera's picture center looks along a line through its lens, and on a
# small camera the sensor sits a little off the lens' axis, so that line
# leans a degree or two. Say the bottom camera's ring is at height zf, the
# nozzle's tip where it was centered at zn and the top camera's lens at zt,
# and the two lines lean k mm across per mm up apart. Looking down, the top
# camera's line meets the bottom camera at zf, so that offset is off by
# k (zn - zf); looking up, the bottom camera's line meets the top camera at
# zt, off by k (zn - zt). The offset at the tip's height lies between them:
# (1 - u) times the first plus u times the second, u = (zn - zf) / (zt - zf),
# the share of the way up from the ring to the top camera the tip lies at.
# A camera's mm a pixel grows with the distance from its lens, so the top
# camera's scale at the board (zn) over its scale at the ring is 1 - u; the
# bottom camera's at the tip over its scale at the top camera's lens is u
# again, counted from its own lens: two estimates, the first kept, the
# second a check. On a LumenPnP (2026-11-19) the two looks came out 2.07 mm
# apart, and u 0.304 and 0.289.
FACING_STEPS = ("nozzle", "moving", "scale", "centering", "done")
FACING_STEP = 2.0
FACING_MAX_STEP = 5.0
FACING_PICTURES = 4
# A look is centered once within this of the picture's center, mm, after
# at most this many moves (the last look's remainder is added either way).
FACING_TOLERANCE = 0.01
FACING_TRIES = 4
# How far a look's turn may lie from its camera's own before the look is
# taken to follow something else, degrees; and how far the two estimates
# of u may differ before the result is called doubtful.
FACING_TURN_LIMIT = 15.0
FACING_SHARE_GAP = 0.05


def facing_result(
    nozzle: Point, down: Point, up: Point, down_scale: float, up_scale: float, board_scale: float | None, tip_scale: float,
) -> dict:
    """The top camera's offset from Offset by bottom camera's places (see
    above): `nozzle` the head's with the tip over the bottom camera, `down`
    the head's with the top camera's picture center on the bottom camera,
    `up` the head's with the top camera's lens on the bottom camera's
    picture center. The scales, mm a pixel: the top camera's at the bottom
    camera (`down_scale`) and at the board (`board_scale`, None when not
    known), the bottom camera's at the top camera's lens (`up_scale`) and
    at the tip (`tip_scale`). A PnpError when no share between 0 and 1
    comes out of them."""
    by_down = (nozzle[0] - down[0], nozzle[1] - down[1])
    by_up = (nozzle[0] - up[0], nozzle[1] - up[1])
    share_down = 1.0 - board_scale / down_scale if board_scale and down_scale > 0.0 else None
    share_up = tip_scale / up_scale if tip_scale > 0.0 and up_scale > 0.0 else None
    share = share_down if share_down is not None else share_up
    if share is None or not 0.0 < share < 1.0:
        said = "none" if share is None else f"{share:.2f}"
        raise PnpError(
            f"the cameras' scales do not put the nozzle's tip between them ({said} of the way up):"
            " measure the top camera's picture over a board first (Measure camera)"
        )
    offset = ((1.0 - share) * by_down[0] + share * by_up[0], (1.0 - share) * by_down[1] + share * by_up[1])
    return {
        "offset": (round(offset[0], 4), round(offset[1], 4)),
        "by_down": [round(by_down[0], 4), round(by_down[1], 4)],
        "by_up": [round(by_up[0], 4), round(by_up[1], 4)],
        "gap": round(math.hypot(by_down[0] - by_up[0], by_down[1] - by_up[1]), 4),
        "share": round(share, 4),
        "share_down": round(share_down, 4) if share_down is not None else None,
        "share_up": round(share_up, 4) if share_up is not None else None,
        "down_head": [round(down[0], 4), round(down[1], 4)],
        "up_head": [round(up[0], 4), round(up[1], 4)],
        "down_scale": round(down_scale, 7),
        "up_scale": round(up_scale, 7),
    }


def facing_words(result: dict) -> str:
    """What Offset by bottom camera says of its result."""
    offset, by_down, by_up = result["offset"], result["by_down"], result["by_up"]
    words = (
        f"the top camera looks from X {offset[0]:+.3f} Y {offset[1]:+.3f} mm off the nozzle, by the bottom camera:"
        f" looking down at it X {by_down[0]:+.3f} Y {by_down[1]:+.3f}, its lens seen from below X {by_up[0]:+.3f} Y {by_up[1]:+.3f}"
        f" ({result['gap']:.2f} mm apart, the cameras' lean), the tip {result['share']:.2f} of the way up from the bottom camera to the top"
    )
    down, up = result.get("share_down"), result.get("share_up")
    if down is not None and up is not None:
        words += f" ({up:.2f} by the bottom camera's scales)"
        if abs(down - up) > FACING_SHARE_GAP:
            words += ": the two disagree, so the offset is doubtful; measure the top camera's picture over a board again (Measure camera)"
    return words


def _reach(mover: Mover, point: Point) -> None:
    """The head to `point` from TAKE_UP short of it along X and Y, so the
    drives' backlash is taken up the same way at every look."""
    mover.go((point[0] - TAKE_UP, point[1] - TAKE_UP))
    mover.go(point)


def _check_turn(what: str, found: tuple[float, float, bool], roll: float | None, mirror: bool | None) -> None:
    """A PnpError when the turn and mirror a look's moves showed (calibrate's)
    are not the camera's own, `roll` and `mirror` (None: not known): the
    look followed something that is not where it seemed."""
    if roll is None:
        return
    if mirror is not None and found[2] != mirror:
        raise PnpError(f"{what}: the picture moved {'mirrored' if found[2] else 'unmirrored'}, unlike the camera's own: the look followed something else")
    apart = (found[1] - roll + 180.0) % 360.0 - 180.0
    if abs(apart) > FACING_TURN_LIMIT:
        raise PnpError(f"{what}: the picture turned {found[1]:+.1f} degrees against the camera's own {roll:+.1f}: the look followed something else")


def _center_by(
    mover: Mover, head: Point, first: Spot | RoundEdge, found: tuple[float, float, bool], look: Callable[[], Spot | RoundEdge], sign: float,
) -> tuple[Point, Spot | RoundEdge]:
    """The head's place that brings what a look sees onto the picture's
    center, and the last look: `first` was seen with the head at `head`,
    `found` is the look's scale, roll and mirror; `sign` 1 when the camera
    rides on the head (the head moves by what is seen), -1 when what is
    seen does (the head moves against it)."""
    scale, roll, mirror = found
    here, seen = head, first
    for _ in range(FACING_TRIES):
        off = picture_to_machine(seen.dx, seen.dy, scale, roll, mirror)
        if math.hypot(*off) <= FACING_TOLERANCE:
            break
        here = (here[0] + sign * off[0], here[1] + sign * off[1])
        _reach(mover, here)
        seen = look()
    off = picture_to_machine(seen.dx, seen.dy, scale, roll, mirror)
    return (here[0] + sign * off[0], here[1] + sign * off[1]), seen


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
        "facing": "measuring the top camera's offset by the bottom camera",
    }
    crop_tasks = {"offset": "spot", "fiducials": "spot", "home": "spot", "search": "board", "scan": "board", "picture": "measure"}
    look_task = "spot"
    board_task = "board"

    def __init__(self, store: Callable[[], dict], save: Callable[[], None], publish: Callable[[], None], message: Callable[[str, str], None]) -> None:
        super().__init__(store, save, publish, message)
        # The last fiducials found: the job, each one's places, the fit's rms.
        self.fiducials: dict | None = None
        # The numbers of the last Measure camera (CameraMap's and the run's).
        self.measured_picture: dict | None = None
        # The numbers of the last Offset by bottom camera (facing_result's,
        # with the looks' turns, the last ring and lens seen, and the offset
        # it replaced).
        self.facing: dict | None = None

    def settings(self) -> TopCameraSettings:
        return super().settings()

    def update(self, patch: dict, clear: tuple[str, ...] = ()) -> TopCameraSettings:
        return super().update(patch, clear)

    def state(self) -> dict:
        return {**super().state(), "fiducials": self.fiducials, "measured_picture": self.measured_picture, "facing": self.facing}

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
        offset: Point | None = None,
    ) -> Point | None:
        """Where the spot of `shade` nearest `point` (a place of the tip)
        is, looked for within `within` mm of it from the head's place over
        it at `z` (the travel height when None), of about `size` (length,
        width) or `diameter` when given; with `center` the head moves onto
        the spot and looks again, so the picture's middle measures it. None
        when there is none. The mover has begun.

        `offset` is the picture's center from the tip to go by, in place of
        the measured one: `point` and the answer are then places made with
        it (a board's place taken through this camera under an offset not
        measured yet), and only the scale has to be measured."""
        settings = self.settings()
        if offset is None:
            if not settings.measured or settings.offset is None:
                raise PnpError(OFFSET_NEEDED)
            offset = settings.offset
        elif settings.mm_per_px <= 0.0:
            raise PnpError(SCALE_NEEDED)
        if not self.client.running:
            raise PnpError("the top camera is not running: start it first")
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
            reply = self._find_spot("spot", radius=within / scale, polarity=shade, **limits)
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
        offset: Point | None = None,
    ) -> list[Found]:
        """Each fiducial (`ref`, `x`, `y` in the job, `diameter`) found
        where `guess` puts it on the machine, centered in the picture; a
        PnpError names the one that is not there. `offset` as look_at's:
        `guess` and the places found are then made with it."""
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
                center=True, routine="finding fiducials", step=ref, progress=progress, offset=offset,
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
        # Only the measure task's crop of each picture is compared: the
        # nozzle or the head's own parts in view do not move with the bed.
        crop = self.crop("measure")

        def picture():
            return self._still(mover, settle, crop)

        def reach(point: Point) -> None:
            # Every place from the same side, so the axes' backlash is
            # taken up the same way at each picture.
            if approach > 0.0:
                mover.go((point[0] - approach, point[1] - approach))
            mover.go(point)

        grays: list = []

        def shift_to(point: Point, first) -> tuple[float, float, float]:
            reach(point)
            gray, _ = picture()
            dx, dy, peak = phase_shift(first, gray)
            if peak < MIN_PEAK:
                raise PnpError(
                    f"the picture at {mover.describe(point)} shares too little with the first (correlation {peak:.3f}):"
                    " measure over a board or a printed pattern, with a shorter step"
                )
            grays.append(gray)
            return dx, dy, peak

        reach(start)
        first, reply = picture()
        full_width = _full_width(settings.size, reply)
        factor = full_width / float(reply["width"])
        # Where the measured pictures lie in the whole one, for the lens.
        uncut = (float(reply["width"]), float(reply["height"]))
        x0, _, y0, _ = crop_rows(crop, int(uncut[0]), int(uncut[1]))
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
        # The probe's picture is no grid picture: the lens pairs each grid
        # picture with its shift.
        grays.clear()
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
        grid = list(grays)
        back = shift_to(start, first)
        self._step(progress, "fitting")
        fit = fit_camera(moves, shifts)
        # The lens from the same pictures' tiles (pictures.fit_lens). Kept,
        # the scale is the one at the picture's center, where pcbv's
        # correction leaves it: the whole pictures' shifts average the lens
        # over them (0.4% coarser on a LumenPnP).
        lens = fit_lens(first, grid, shifts, uncut, (float(x0), float(y0)))
        if lens is not None and lens.worth:
            # Only the scale: a radial lens bends no shift's direction on
            # average, and the whole pictures' roll is the steadier.
            centered = [(move, center) for move, center in zip(moves, lens.centers) if center is not None]
            at_center = fit_camera([move for move, _ in centered], [center for _, center in centered])
            fit = replace(fit, mm_per_px_x=at_center.mm_per_px_x, mm_per_px_y=at_center.mm_per_px_y)
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
            "crop": list(crop) if crop is not None else None,
            # Each grid picture: the head's move (mm), the shift seen (full size px), the correlation's peak.
            "rows": rows,
            "lens": lens.to_dict() if lens is not None else None,
        }
        full_height = full_width * uncut[1] / uncut[0]
        kept_lens = (
            {"k1": round(lens.k1, 5), "k2": 0.0, "width": int(round(full_width)), "height": int(round(full_height))}
            if lens is not None and lens.worth else None
        )
        said_lens = (
            f", the lens {kept_lens['k1']:+.4f} (corners {lens.corner_px * factor * mm_per_px * 1000.0:.0f} um)" if kept_lens is not None and lens is not None
            else ", no lens worth correcting" if lens is not None else ""
        )
        # The moves went through the skew the machine file takes out now
        # (link or firmware): what is left of it, added to that, is the
        # file's skew that squares the axes. Under 90 degrees from +X to
        # +Y (skew_deg below 0) is a skew above 0.
        skew_now = getattr(getattr(mover, "machine", None), "skew", None)
        said_skew = ""
        if isinstance(skew_now, (int, float)):
            numbers["skew"] = round(float(skew_now) - math.tan(math.radians(fit.skew_deg)), 6)
            said_skew = f" ([motion] skew = {numbers['skew']:.4f} squares them)"
        words = (
            f"the top camera's picture measured by the head's moves: {mm_per_px * 1000.0:.2f} um a pixel"
            f" ({numbers['mm_per_px_x'] * 1000.0:.2f} along X, {numbers['mm_per_px_y'] * 1000.0:.2f} along Y),"
            f" roll {roll:.2f} degrees{', mirrored' if fit.mirror else ''}, the axes {abs(fit.skew_deg):.2f} degrees from square{said_skew},"
            f" {rms_px:.2f} px rms, back at the start within {returned_um:.0f} um{said_lens}"
        )
        self.measured_picture = numbers
        if keep is not None:
            self._message("info", keep(fit, numbers))
            return
        # Kept at once and logged with Undo, as every routine's result.
        patch = {"mm_per_px": round(mm_per_px, 7), "roll": round(roll, 4), "mirror": fit.mirror}
        if kept_lens is not None:
            patch["lens"] = kept_lens
        self._message("info", self.findings.keep("camera", words, patch))

    def _still(self, mover: Mover, settle: float = 0.0, crop=None):
        """A picture of the head at rest, MEASURE_WIDTH px wide at most and
        cut to `crop`, with pcbv's reply: the head still rings after a move,
        so pictures are taken from SETTLE_SECONDS (and `settle`) after it
        until two in a row agree within STILL_PX, for at most STILL_SECONDS."""
        settings = self.settings()
        gray, reply = fresh_gray(self.client, time.monotonic() + SETTLE_SECONDS + settle, MEASURE_WIDTH, mover.stopped)
        gray = cut(gray, crop)
        factor = _full_width(settings.size, reply) / float(reply["width"])
        until = time.monotonic() + STILL_SECONDS
        while time.monotonic() < until:
            later, reply = fresh_gray(self.client, time.monotonic(), MEASURE_WIDTH, mover.stopped)
            later = cut(later, crop)
            dx, dy, _ = phase_shift(gray, later)
            gray = later
            if math.hypot(dx, dy) * factor <= STILL_PX:
                break
        return gray, reply

    # --- the offset by the bottom camera ---------------------------------------------

    def measure_offset_facing(
        self,
        mover: Mover,
        up: UpCamera,
        place: CameraPlace,
        keep_place: Callable[[CameraPlace], None],
        step: float,
        guess: Point | None,
        board_scale: float | None,
        nozzle: bool = True,
        target: str | None = None,
    ) -> None:
        """Starts Offset by bottom camera on its own thread (see FACING_STEPS
        above): with `nozzle`, the nozzle is first centered over `up`, the
        bottom camera, from `place` (its calibration on this machine) and
        the place measured is kept through `keep_place` (logged against
        `target`, as Center nozzle's); without, `place` is the nozzle's
        place as kept. Then the two cameras look at each other with the head
        at the travel height, `step` mm the scale moves, and the offset is
        kept. `guess` is the file's offset, gone by while none is measured;
        `board_scale` the top camera's mm a pixel at the board when the
        settings have none measured."""
        if not (math.isfinite(step) and 0.0 < step <= FACING_MAX_STEP):
            raise ValueError(f"the step must be over 0 and at most {FACING_MAX_STEP:g} mm")
        if not up.client.running:
            raise ValueError("the bottom camera is not running: start it first")
        if up.routine_active:
            raise ValueError("a bottom camera routine is under way")
        if nozzle and place.position is None:
            raise ValueError("the bottom camera's place is not known: Center nozzle over it once by hand, or give [up_camera] position in the machine file")
        if not nozzle and not place.measured:
            raise ValueError("the nozzle is not centered over the bottom camera yet: center it first, or let this routine do it")
        self._begin(
            "facing", FACING_STEPS, mover,
            lambda progress: self._facing(mover, progress, up, place, keep_place, step, guess, board_scale, nozzle, target),
        )

    def _facing(
        self,
        mover: Mover,
        progress: RoutineProgress,
        up: UpCamera,
        place: CameraPlace,
        keep_place: Callable[[CameraPlace], None],
        step: float,
        guess: Point | None,
        board_scale: float | None,
        nozzle: bool,
        target: str | None,
    ) -> None:
        settings = self.settings()
        mover.begin()
        stood = mover.here()
        if nozzle:
            self._step(progress, "nozzle")
            place = self._facing_nozzle(mover, up, place, keep_place, target)
        nozzle_at = place.position
        if nozzle_at is None or place.mm_per_px <= 0.0:
            raise PnpError("the nozzle is not centered over the bottom camera")
        self._step(progress, "moving")
        mover.lift()
        offset_now = settings.offset if settings.offset is not None else guess
        # Over the bottom camera by the offset in use, else where the head
        # stood when the routine began (put there by hand).
        head = (nozzle_at[0] - offset_now[0], nozzle_at[1] - offset_now[1]) if offset_now is not None else stood
        self._step(progress, "scale")
        lens_shade: list[str | None] = [None]

        def look_down() -> Spot | RoundEdge:
            return self._facing_down(mover, progress)

        def look_up() -> Spot | RoundEdge:
            spot, lens_shade[0] = self._facing_up(mover, progress, up, lens_shade[0])
            return spot

        looks = []
        for move in ((0.0, 0.0), (step, 0.0), (0.0, step)):
            _reach(mover, (head[0] + move[0], head[1] + move[1]))
            looks.append((look_down(), look_up()))
        (down0, up0), (down_x, up_x), (down_y, up_y) = looks
        # The top camera rides on the head over a bottom camera that stays
        # put: what it sees moves against the head's moves. The top camera's
        # lens, seen from below, moves with them.
        try:
            down_map = calibrate((down0.dx - down_x.dx, down0.dy - down_x.dy), (down0.dx - down_y.dx, down0.dy - down_y.dy), step)
        except ValueError as exc:
            raise PnpError(f"the top camera looking down at the bottom camera: {exc}") from None
        try:
            up_map = calibrate((up_x.dx - up0.dx, up_x.dy - up0.dy), (up_y.dx - up0.dx, up_y.dy - up0.dy), step)
        except ValueError as exc:
            raise PnpError(f"the bottom camera looking up at the top camera: {exc}") from None
        top_roll = settings.roll if settings.mm_per_px > 0.0 else None
        _check_turn("the top camera looking down at the bottom camera", down_map, top_roll, settings.mirror if top_roll is not None else None)
        _check_turn("the bottom camera looking up at the top camera", up_map, place.roll, place.mirror)
        self._step(progress, "centering")
        # The picture's center on the bottom camera: the head moves by what
        # is seen. The lens on the bottom camera's center: against it.
        down, last_down = _center_by(mover, head, down0, down_map, look_down, 1.0)
        up_head, last_up = _center_by(mover, head, up0, up_map, look_up, -1.0)
        board = settings.mm_per_px if settings.mm_per_px > 0.0 else board_scale
        result = facing_result(nozzle_at, down, up_head, down_map[0], up_map[0], board, place.mm_per_px)
        offset = result["offset"]
        if any(abs(v) > OFFSET_LIMIT for v in offset):
            raise PnpError(f"the offset came out {offset[0]:.1f}, {offset[1]:.1f} mm: is the top camera over the bottom camera?")
        self.facing = {
            **result,
            "nozzle": [round(nozzle_at[0], 4), round(nozzle_at[1], 4)],
            "down_roll": round(down_map[1], 3),
            "up_roll": round(up_map[1], 3),
            "ring": last_down.to_dict(),
            "lens": {"dx": round(last_up.dx, 3), "dy": round(last_up.dy, 3), "shade": lens_shade[0]},
            "before": list(settings.offset) if settings.offset is not None else None,
        }
        self._message("info", self.findings.keep("offset", facing_words(result), {"offset": offset}))

    def _facing_nozzle(self, mover: Mover, up: UpCamera, place: CameraPlace, keep_place: Callable[[CameraPlace], None], target: str | None) -> CameraPlace:
        """The nozzle centered over the bottom camera as Center nozzle does,
        shown as that camera's own routine while it runs, and kept."""
        shown = RoutineProgress(kind="nozzle", steps=NOZZLE_STEPS, step=NOZZLE_STEPS[0], target=mover.name, crop=up.crop_state("nozzle"))
        up.progress = shown
        try:
            seen, tip = up.center_tip(mover, NOZZLE_STEP, shown, place)
            words = up.keep_tip(mover, seen, tip, keep_place, target)
        except Exception as exc:
            shown.state = STOPPED if self.aborting() else ERROR
            shown.error = "stopped" if self.aborting() else str(exc)
            raise
        finally:
            up._publish()
        shown.step, shown.state = "done", DONE
        up._publish()
        self._message("info", words)
        return seen

    def _facing_down(self, mover: Mover, progress: RoutineProgress) -> RoundEdge:
        """The bottom camera's ring as the top camera sees it: the circle
        of its strongest round edge in FACING_PICTURES pictures averaged,
        px of the full size picture."""
        if mover.stopped():
            raise PnpError("stopped")
        self._still(mover)
        gray, reply = average_gray(self.client, FACING_PICTURES, time.monotonic(), MEASURE_WIDTH, mover.stopped)
        found = round_edge(gray)
        factor = _full_width(self.settings().size, reply) / float(reply["width"])
        seen = found.scaled(factor) if found is not None else None
        look = {"found": False} if seen is None else {
            "found": True, "dx": seen.dx, "dy": seen.dy, "major": 2.0 * seen.radius, "minor": 2.0 * seen.radius, "fill": 0.0,
        }
        self._log_look("measuring the offset by the bottom camera", progress.step, look, "ring")
        if seen is None:
            raise PnpError("the top camera sees no ring: is it over the bottom camera, with the light on?")
        progress.spot = spot_of(look)
        self._publish()
        return seen

    def _facing_up(self, mover: Mover, progress: RoutineProgress, up: UpCamera, shade: str | None) -> tuple[Spot, str]:
        """The top camera's lens as the bottom camera sees it (lens_look),
        drawn over the bottom camera's picture, and the shade it was found
        in; the first look's shade is kept for the rest."""
        if mover.stopped():
            raise PnpError("stopped")
        reply, found_shade = up.lens_look("measuring the offset by the bottom camera", progress.step, shade)
        up.look = look_dict(reply, found_shade)
        up._publish()
        if not reply.get("found"):
            raise PnpError("the bottom camera sees no lens over it: is the top camera over the bottom camera, with the light on?")
        return spot_of(reply), found_shade

    def find_fiducials(
        self,
        mover: Mover,
        fiducials: list[dict],
        guess: Callable[[Point], Point],
        shade: str,
        within: float,
        z: float | None,
        done: Callable[[list[Found]], str],
        offset: Point | None = None,
    ) -> None:
        """Starts the fiducial routine on its own thread; `done` hears what
        was found, keeps it (and logs it, findings.py) and answers the line
        to say of it. With `offset` (look_at's) the routine goes by it and
        needs only the scale measured: the fiducials' places are the
        camera's own under that offset, moved when a truer one is measured."""
        if not fiducials:
            raise ValueError("the board has no fiducials: footprints whose reference starts FID or whose name says Fiducial")
        settings = self.settings()
        if offset is None and not settings.measured:
            raise ValueError(OFFSET_NEEDED)
        if offset is not None and settings.mm_per_px <= 0.0:
            raise ValueError(SCALE_NEEDED)
        steps = ("lifting", *[str(f["ref"]) for f in fiducials], "fitting", "done")

        def body(progress: RoutineProgress) -> None:
            mover.begin()
            self._step(progress, "lifting")
            found = self.locate_fiducials(mover, fiducials, guess, shade, within, z, progress, offset)
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
            raise ValueError(OFFSET_NEEDED)
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
        reply = self._find_spot("spot", polarity=shade)
        self._log_look("measuring the top camera's offset", progress.step, reply, shade)
        if not reply.get("found"):
            raise PnpError(missing)
        spot = spot_of(reply)
        if scale > 0.0:
            spot.mm = math.hypot(*picture_to_machine(spot.dx, spot.dy, scale, roll, mirror))
        progress.spot = spot
        self._publish()
        return spot
