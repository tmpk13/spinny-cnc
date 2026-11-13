"""Pick and place: the parts of a board, and a camera that looks up.

A board job keeps its KiCad file, whose footprints are the parts: each one
at its place in the job's frame through the design's map (the KiCad board
frame, y down, to the gerber frame and on to the job's), turned with it.

The up camera is fixed to the machine and looks up at what the head holds
over it: the nozzle's tip, or a part on the nozzle. `position` is where the
head stands (rail and cross slide joints) with the nozzle over the
picture's center. A spot found in the picture is a displacement of the
head through the picture's scale, its roll and whether it is mirrored,
which looking up makes it. The nozzle routine measures all four: the head
goes over the camera, the spot nearest the picture's center is taken for
the nozzle (its bore, a dark spot, by default), a short move along +X and
one along +Y show how the picture scales, turns and mirrors against the
machine, and the head is moved until the nozzle sits on the picture's
center, where the joints are the position. The part routine reads where a
part held on the nozzle sits against the nozzle's center.

Only an X/Y machine has these: on the polar one the head moves along the
rail alone and the board turns under it, so no head move crosses the
camera's picture but the rail's.
"""

from __future__ import annotations

import math
import re
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from pydantic import BaseModel, ConfigDict, Field

from spinny_laser import machines as machine_files

from .cameras import apply_kept, check_controls
from .camera import CAPTURE_KEYS, DONE, ERROR, RUNNING, STOPPED, MachineAccess, Spot, look_dict, picture_to_machine, spot_of, wait_settled
from .kinematics import FOCUS_DECIMALS, coord
from .link import LinkError, idle_status, settle
from .log import log
from .openpnp import SHADES
from .vision import VisionClient, VisionError, check_colors, check_lens

Point = tuple[float, float]
NOZZLE_STEPS = ("lifting", "moving", "lowering", "scale", "centering", "done")
PART_STEPS = ("lifting", "moving", "lowering", "looking", "done")
RUNOUT_STEPS = ("lifting", "moving", "lowering", "turning", "done")
# The nozzle's angles the runout routine looks at its tip from, degrees.
RUNOUT_ANGLES = (0.0, 60.0, 120.0, 180.0, 240.0, 300.0)
# A runout smaller than this many pixels of the picture, or than this many
# mm, tells nothing of which way the nozzle turned.
RUNOUT_VISIBLE_PX = 2.0
RUNOUT_VISIBLE_MM = 0.01
# A part whose long side is not this much longer than its short one gives
# no angle from its equivalent ellipse.
ELONGATED = 1.3
# The two moves that measure the picture are as long as each other and at
# right angles on the machine, so the spot's moves in the picture are too:
# lengths further apart than this ratio, or an angle between them further
# than this from a right angle, degrees, say the measure went wrong.
SQUARE_RATIO = 1.25
SQUARE_DEGREES = 15.0
# The head is moved until the nozzle is this close to the picture's
# center, mm, at most this many times.
CENTER_TOLERANCE = 0.02
CENTER_TRIES = 4
DEFAULT_STEP = 1.0
MAX_STEP = 10.0
# The most a measured or typed value may be, mm.
POSITION_LIMIT = 2000.0
HEIGHT_LIMIT = 100.0


class PnpError(Exception):
    """The up camera, or its routine, is in the wrong state for the request."""


class NoSpot(PnpError):
    """The picture shows nothing of the shade looked for where it should."""


# --- the parts of a board -------------------------------------------------------

_TOKEN = re.compile(r'\(|\)|"(?:[^"\\]|\\.)*"|[^\s()"]+')


def parse_sexp(text: str) -> list:
    """A KiCad file's s-expression as nested lists of strings, quotes taken
    off; ValueError when the parentheses do not pair up."""
    stack: list[list] = [[]]
    for match in _TOKEN.finditer(text):
        token = match.group(0)
        if token == "(":
            stack.append([])
        elif token == ")":
            if len(stack) == 1:
                raise ValueError("a ')' with no '(' before it")
            done = stack.pop()
            stack[-1].append(done)
        elif token.startswith('"'):
            stack[-1].append(re.sub(r"\\(.)", r"\1", token[1:-1]))
        else:
            stack[-1].append(token)
    if len(stack) != 1:
        raise ValueError("a '(' that is never closed")
    return stack[0]


def _child(node: list, name: str) -> list | None:
    for item in node:
        if isinstance(item, list) and item and item[0] == name:
            return item
    return None


def _number(value, default: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


@dataclass
class Footprint:
    """A footprint as the board file has it: KiCad's board frame, mm with y
    down, and its angle in degrees, counterclockwise as drawn. `body` is
    the extent of its fabrication drawing in its own frame, longer side
    first, when it has one; `diameter` a fiducial's largest pad."""

    ref: str
    value: str
    footprint: str
    side: str
    x: float
    y: float
    rotation: float
    pads: int
    smd: bool
    dnp: bool
    fiducial: bool = False
    body: tuple[float, float] | None = None
    diameter: float | None = None


FAB_LAYERS = ("F.Fab", "B.Fab")


def is_fiducial(ref: str, footprint: str) -> bool:
    """A fiducial by KiCad's habits: a reference starting FID, or a
    footprint named for one (Fiducial_1mm_Mask2mm)."""
    return ref.upper().startswith("FID") or "fiducial" in footprint.lower()


def _points_of(item: list) -> list[tuple[float, float]]:
    """The points a footprint's drawing item reaches: a line's or a
    rectangle's ends, a polygon's corners, an arc's ends and middle, and a
    circle's box."""
    points: list[tuple[float, float]] = []
    for key in ("start", "end", "mid"):
        found = _child(item, key)
        if found is not None and len(found) >= 3:
            points.append((_number(found[1]), _number(found[2])))
    center = _child(item, "center")
    if center is not None and len(center) >= 3 and item[0] == "fp_circle":
        cx, cy = _number(center[1]), _number(center[2])
        radius = math.dist((cx, cy), points[-1]) if points else 0.0
        points = [(cx - radius, cy - radius), (cx + radius, cy + radius)]
    pts = _child(item, "pts")
    if pts is not None:
        for xy in pts[1:]:
            if isinstance(xy, list) and len(xy) >= 3 and xy[0] == "xy":
                points.append((_number(xy[1]), _number(xy[2])))
    return points


def body_of(node: list) -> tuple[float, float] | None:
    """The extent of a footprint's fabrication drawing (F.Fab, or B.Fab on
    the back), in its own frame, longer side first; None without one."""
    points: list[tuple[float, float]] = []
    for item in node:
        if not (isinstance(item, list) and item and item[0] in ("fp_line", "fp_rect", "fp_poly", "fp_circle", "fp_arc")):
            continue
        layer = _child(item, "layer")
        if layer is None or len(layer) < 2 or layer[1] not in FAB_LAYERS:
            continue
        points.extend(_points_of(item))
    if len(points) < 2:
        return None
    width = max(x for x, _ in points) - min(x for x, _ in points)
    height = max(y for _, y in points) - min(y for _, y in points)
    if width <= 0.0 or height <= 0.0:
        return None
    return (round(max(width, height), 4), round(min(width, height), 4))


def largest_pad(node: list) -> float | None:
    sizes = []
    for item in node:
        if isinstance(item, list) and item and item[0] == "pad":
            size = _child(item, "size")
            if size is not None and len(size) >= 3:
                sizes.append(max(_number(size[1]), _number(size[2])))
    return max(sizes) if sizes else None


def footprints_of(text: str) -> list[Footprint]:
    """The footprints of a .kicad_pcb text, KiCad 5 (`module`, `fp_text`)
    to 10 (`footprint`, `property`), in file order. A footprint kept out of
    the position files or on the board only (a logo) is not a part, and
    neither is one with no reference; a fiducial is kept whatever its
    flags, marked as one, for the top camera to find."""
    tree = parse_sexp(text)
    root = tree[0] if tree and isinstance(tree[0], list) else tree
    found: list[Footprint] = []
    for node in root:
        if not (isinstance(node, list) and node and node[0] in ("footprint", "module")):
            continue
        ref = value = ""
        for item in node:
            if not (isinstance(item, list) and len(item) >= 3 and isinstance(item[1], str) and isinstance(item[2], str)):
                continue
            kind = (item[0], item[1].lower())
            if kind in (("property", "reference"), ("fp_text", "reference")):
                ref = item[2]
            elif kind in (("property", "value"), ("fp_text", "value")):
                value = item[2]
        attr = _child(node, "attr") or []
        flags = {word for word in attr[1:] if isinstance(word, str)}
        name = node[1] if len(node) > 1 and isinstance(node[1], str) else ""
        fiducial = bool(ref) and is_fiducial(ref, name)
        if not ref or "*" in ref or (("exclude_from_pos_files" in flags or "board_only" in flags) and not fiducial):
            continue
        at = _child(node, "at") or ["at", "0", "0"]
        layer = _child(node, "layer")
        side = "back" if layer is not None and len(layer) > 1 and str(layer[1]).startswith("B.") else "front"
        pads = sum(1 for item in node if isinstance(item, list) and item and item[0] == "pad")
        found.append(
            Footprint(
                ref=ref,
                value=value,
                footprint=name,
                side=side,
                x=_number(at[1] if len(at) > 1 else 0),
                y=_number(at[2] if len(at) > 2 else 0),
                rotation=_number(at[3] if len(at) > 3 else 0) % 360.0,
                pads=pads,
                smd="smd" in flags,
                dnp="dnp" in flags,
                fiducial=fiducial,
                body=body_of(node),
                diameter=largest_pad(node) if fiducial else None,
            )
        )
    return found


_CACHE: dict[str, tuple[float, list[Footprint]]] = {}
_CACHE_LOCK = threading.Lock()


def board_footprints(path: Path) -> list[Footprint]:
    """The footprints of a board file, read once per change of the file."""
    stamp = path.stat().st_mtime
    key = str(path)
    with _CACHE_LOCK:
        cached = _CACHE.get(key)
        if cached is not None and cached[0] == stamp:
            return cached[1]
    found = footprints_of(path.read_text(encoding="utf-8", errors="replace"))
    with _CACHE_LOCK:
        _CACHE[key] = (stamp, found)
    return found


def job_components(job, path: Path) -> list[dict]:
    """The parts of a board job, placed and turned into the job's frame
    through its design map, which follows every move and turn of the job."""
    design = job.design
    if design is None:
        raise ValueError("the job has no board design: only a board upload places its parts")
    parts = []
    for footprint in board_footprints(path):
        x, y = design.board_to_job((footprint.x, footprint.y))
        parts.append(
            {
                "ref": footprint.ref,
                "value": footprint.value,
                "footprint": footprint.footprint,
                "side": footprint.side,
                "x": round(x, 4),
                "y": round(y, 4),
                "rotation": round(design.angle_to_job(footprint.rotation) % 360.0, 3),
                "pads": footprint.pads,
                "smd": footprint.smd,
                "dnp": footprint.dnp,
                "fiducial": footprint.fiducial,
                "body": list(footprint.body) if footprint.body is not None else None,
                "diameter": footprint.diameter,
            }
        )
    return parts


# --- the picture ---------------------------------------------------------------


def picture_angle_to_machine(degrees: float, roll: float, mirror: bool) -> float:
    """A direction seen in the picture (degrees from its +x toward its +y,
    which points down) as a direction in the machine's frame, degrees
    counterclockwise from +X."""
    radians = math.radians(degrees)
    mx, my = picture_to_machine(math.cos(radians), math.sin(radians), 1.0, roll, mirror)
    return math.degrees(math.atan2(my, mx))


def fit_circle(points: list[Point]) -> tuple[Point, float, float]:
    """The circle through points by least squares on its equation (Kasa's
    fit): its center, its radius and the points' rms distance from it."""
    n = len(points)
    if n < 3:
        raise ValueError("a circle needs three points")
    mx = sum(x for x, _ in points) / n
    my = sum(y for _, y in points) / n
    # Centered, the equation x^2 + y^2 = 2 a x + 2 b y + c is a 2 x 2 solve.
    suu = suv = svv = suuu = svvv = suvv = svuu = 0.0
    for x, y in points:
        u, v = x - mx, y - my
        suu += u * u
        suv += u * v
        svv += v * v
        suuu += u * u * u
        svvv += v * v * v
        suvv += u * v * v
        svuu += v * u * u
    det = suu * svv - suv * suv
    if abs(det) < 1e-18:
        # Every point at one place: a circle of no size there.
        return (mx, my), 0.0, 0.0
    rhs_u = 0.5 * (suuu + suvv)
    rhs_v = 0.5 * (svvv + svuu)
    uc = (rhs_u * svv - rhs_v * suv) / det
    vc = (rhs_v * suu - rhs_u * suv) / det
    center = (uc + mx, vc + my)
    radius = math.sqrt(uc * uc + vc * vc + (suu + svv) / n)
    rms = math.sqrt(sum((math.dist(center, point) - radius) ** 2 for point in points) / n)
    return center, radius, rms


def calibrate(moved_x: Point, moved_y: Point, step: float) -> tuple[float, float, bool]:
    """The picture's mm per px, roll and mirror from how a spot the head
    holds moved in it, px, when the head moved `step` mm along +X
    (`moved_x`) and then along +Y (`moved_y`) from the same place: a mirror
    reverses which way the two moves turn."""
    w1 = (moved_x[0], -moved_x[1])
    w2 = (moved_y[0], -moved_y[1])
    cross = w1[0] * w2[1] - w1[1] * w2[0]
    if math.hypot(*w1) < 1e-6 or math.hypot(*w2) < 1e-6 or abs(cross) < 1e-9:
        raise ValueError("the spot did not move with the head: is the nozzle over the bottom camera?")
    # Equal moves at right angles show as equal moves at right angles: a
    # picture that lagged a move, or a spot that is not the one the head
    # holds (or that stays put while the head moves), shows otherwise.
    l1, l2 = math.hypot(*w1), math.hypot(*w2)
    between = math.degrees(math.acos(max(-1.0, min(1.0, (w1[0] * w2[0] + w1[1] * w2[1]) / (l1 * l2)))))
    if max(l1, l2) / min(l1, l2) > SQUARE_RATIO or abs(between - 90.0) > SQUARE_DEGREES:
        raise ValueError(
            f"the spot moved {l1:.0f} px for the step along X and {l2:.0f} px for the one along Y, {between:.0f} degrees apart,"
            " where equal steps at right angles were made: the picture lagged a move, or the spot found is not the one"
            " the steps moved (Look once shows what the finder takes)"
        )
    mirror = cross < 0.0
    f1 = (-w1[0], w1[1]) if mirror else w1
    f2 = (-w2[0], w2[1]) if mirror else w2
    mm_per_px = step / ((math.hypot(*f1) + math.hypot(*f2)) / 2.0)
    # The roll that takes the first move to +X and the second to +Y,
    # averaged on the circle.
    a1 = -math.atan2(f1[1], f1[0])
    a2 = math.pi / 2.0 - math.atan2(f2[1], f2[0])
    roll = math.degrees(math.atan2(math.sin(a1) + math.sin(a2), math.cos(a1) + math.cos(a2)))
    return mm_per_px, roll, mirror


class UpCameraSettings(BaseModel):
    """What the backend keeps of the up camera, `pnp` in its config.json."""

    model_config = ConfigDict(extra="forbid")

    device: str = "/dev/video1"
    size: str = "1280x720"
    fps: int = 30
    pcbv: str = "pcbv"
    # What the spot finder looks for: the nozzle's bore, and a part on it.
    nozzle_spot: str = "dark"
    part_spot: str = "dark"
    # The joints (along the rail, across it) that put the nozzle over the
    # picture's center; None until measured or typed in.
    position: tuple[float, float] | None = None
    # The H the nozzle is seen sharp at over the camera; None keeps the
    # height the head travels at.
    height: float | None = None
    mm_per_px: float = 0.0
    roll: float = 0.0
    mirror: bool = True
    # V4L2 control values set on the device each time the camera starts.
    controls: dict[str, int] = Field(default_factory=dict)
    # The lens correction measured from a dot grid, sent at every start.
    lens: dict[str, float] | None = None
    # Colors picked from the picture for what the camera looks for
    # (vision.COLOR_ITEMS): spots of that color instead of a shade, the
    # board's pads, a blank board's edges.
    colors: dict[str, list[int]] = Field(default_factory=dict)

    def check(self) -> None:
        if not self.device.strip():
            raise ValueError("the bottom camera device must be named")
        check_controls(self.controls)
        check_lens(self.lens)
        check_colors(self.colors)
        if not machine_files._CAMERA_SIZE.match(self.size):
            raise ValueError("the bottom camera size must be WIDTHxHEIGHT")
        if not 1 <= int(self.fps) <= 120:
            raise ValueError("the bottom camera fps must be 1 to 120")
        if not self.pcbv.strip():
            raise ValueError("the pcbv program must be named")
        if self.nozzle_spot not in SHADES or self.part_spot not in SHADES:
            raise ValueError("the nozzle and part spots are dark or bright")
        if self.position is not None and any(not math.isfinite(v) or abs(v) > POSITION_LIMIT for v in self.position):
            raise ValueError(f"the bottom camera position must be two numbers within {POSITION_LIMIT:g} mm")
        if self.height is not None and not (math.isfinite(self.height) and abs(self.height) <= HEIGHT_LIMIT):
            raise ValueError(f"the bottom camera height must be within {HEIGHT_LIMIT:g} mm")
        if not (math.isfinite(self.mm_per_px) and 0.0 <= self.mm_per_px <= 1.0):
            raise ValueError("mm_per_px must be 0 to 1")
        if not (math.isfinite(self.roll) and abs(self.roll) <= 360.0):
            raise ValueError("the bottom camera roll must be within 360 degrees")


@dataclass
class RoutineProgress:
    kind: str
    steps: tuple[str, ...]
    # The machine the routine moves: one on this project's firmware (machine), or a G-code machine (gcode).
    target: str = "machine"
    state: str = RUNNING
    step: str = ""
    error: str | None = None
    spot: Spot | None = None
    started: float = field(default_factory=time.monotonic, repr=False)

    def to_dict(self) -> dict:
        return {
            "kind": self.kind,
            "target": self.target,
            "state": self.state,
            "step": self.step,
            "done": self.steps.index(self.step) if self.step in self.steps else 0,
            "total": len(self.steps) - 1,
            "error": self.error,
            "spot": self.spot.to_dict() if self.spot is not None else None,
            "seconds": round(time.monotonic() - self.started, 1),
        }


@dataclass
class CameraPlace:
    """Where the up camera sits on one machine (the head's place with the
    nozzle over the picture's center, and the height the nozzle is sharp
    at) and how its picture lies against that machine's moves."""

    position: Point | None = None
    height: float | None = None
    mm_per_px: float = 0.0
    roll: float = 0.0
    mirror: bool = True
    # Where the nozzle's tip sits off its turning axis with the nozzle
    # turned to 0, mm in the machine's frame; None until measured. The
    # position above is the head's with the tip at 0 over the center.
    runout: Point | None = None

    @property
    def measured(self) -> bool:
        return self.position is not None and self.mm_per_px > 0.0

    def to_dict(self) -> dict:
        return {
            "position": list(self.position) if self.position is not None else None,
            "height": self.height,
            "mm_per_px": self.mm_per_px,
            "roll": self.roll,
            "mirror": self.mirror,
            "runout": list(self.runout) if self.runout is not None else None,
        }


class Mover:
    """What a routine moves: the head of a machine on this project's firmware or a G-code machine's, to
    absolute places in that machine's own frame, each move waited out
    before the next. `name` says which machine, `letters` what its two
    axes are called."""

    name = "machine"
    letters = ("R", "Z")
    # Whether the nozzle turns: only then are `turn` and the runout routine there.
    can_turn = False

    def check(self) -> None:
        """Refuses, at once, a machine the routine cannot run on."""

    def begin(self) -> None:
        """On the routine's thread: refuses a machine not at rest, and
        finds where the head is."""
        raise NotImplementedError

    def stopped(self) -> bool:
        raise NotImplementedError

    def here(self) -> Point:
        raise NotImplementedError

    def height(self) -> float | None:
        raise NotImplementedError

    def lift(self) -> None:
        """To the height the head travels at: up from below it on a machine
        on this project's firmware, to it from either side on a G-code
        machine (a seesaw Z lowers its other nozzle above it)."""
        raise NotImplementedError

    def go(self, point: Point) -> None:
        raise NotImplementedError

    def lower(self, height: float) -> None:
        raise NotImplementedError

    def halt(self) -> None:
        raise NotImplementedError

    def turn(self, degrees: float) -> None:
        """Turns the nozzle to `degrees`, counterclockwise from above."""
        raise PnpError("this machine does not turn its nozzle")

    def describe(self, point: Point) -> str:
        return f"{self.letters[0]} {point[0]:.3f} {self.letters[1]} {point[1]:.3f}"


class MachineMover(Mover):
    """This machine's head: the rail and cross slide joints, and the focus
    axis as the height."""

    def __init__(self, access: MachineAccess, stopped: Callable[[], bool], message: Callable[[str, str], None]) -> None:
        self.access = access
        self._stopped = stopped
        self._message = message
        self._status = None
        self._restarts = access.link.restarts

    def check(self) -> None:
        if not getattr(self.access.streamer, "cartesian", False):
            raise ValueError("the bottom camera needs an X/Y machine ($cartesian=1): on the polar one only the rail crosses its picture")

    def begin(self) -> None:
        link = self.access.link
        status = idle_status(link, PnpError)
        self._restarts = link.restarts
        self._status = status

    def stopped(self) -> bool:
        return self._stopped()

    def here(self) -> Point:
        return (self._status.r, self._status.z)

    def height(self) -> float | None:
        return self._status.h if self.access.has_focus_axis else None

    def _h_seconds(self, distance: float) -> float:
        """About how long the focus axis takes for a move, by its rate."""
        rate = getattr(getattr(self.access.streamer, "rates", None), "h_rate", 0.0) or 100.0
        return abs(distance) / rate * 60.0

    def lift(self) -> None:
        lift, h = self.access.lift, self._status.h
        if self.access.has_focus_axis and h is not None and h < lift - 1e-6:
            self._line(f"go H{coord(lift, FOCUS_DECIMALS)}")
            self._status = self._settle(self._h_seconds(lift - h))

    def go(self, point: Point) -> None:
        streamer = self.access.streamer
        start = self.here()
        self._line(f"go {streamer.words(point)}")
        self._status = self._settle(streamer._rapid_seconds(start, point))

    def lower(self, height: float) -> None:
        h = self._status.h
        if self.access.has_focus_axis and h is not None and abs(h - height) > 1e-6:
            self._line(f"go H{coord(height, FOCUS_DECIMALS)}")
            self._status = self._settle(self._h_seconds(height - h))

    def halt(self) -> None:
        from .runner import halt

        link = self.access.link
        if link.is_open:
            halt(link, self._message)

    def _line(self, line: str) -> None:
        if self._stopped():
            raise PnpError("stopped")
        self.access.link.request_ok(line)

    def _settle(self, seconds: float):
        """Waits for the machine to come to rest after a move; a hold extends the wait."""
        return settle(self.access.link, seconds, self._restarts, self._stopped, PnpError, "the routine")


class PickCamera:
    """What the up camera and a G-code machine's top camera share: settings
    kept in a dict of the backend's config under `key` (checked whole on
    every change; a running camera given another device, size, rate or
    program starts again on them), pcbv behind them, one routine at a time
    on a thread of its own with an abort, and the routines' looks kept in
    the camera log while it logs."""

    # The camera in words, as messages name it, and as the camera log does.
    label = "camera"
    log_name = "up"
    key = "camera"
    Settings: type = BaseModel
    # The settings that are places, kept as tuples, and the ones a patch's
    # `clear` may take back to none.
    places: tuple[str, ...] = ()
    clearable: tuple[str, ...] = ()
    # What a routine of each kind is called when it fails.
    routines: dict[str, str] = {}

    def __init__(self, store: Callable[[], dict], save: Callable[[], None], publish: Callable[[], None], message: Callable[[str, str], None]) -> None:
        self._store = store
        self._save = save
        self._publish = publish
        self._message = message
        self.client = VisionClient()
        # Where every look a routine takes is kept while logging is on; the
        # backend sets it.
        self.camlog = None
        self._looks = 0
        self.progress: RoutineProgress | None = None
        # The last look taken by hand (Look once): what was asked for and
        # what was found, for the page to draw over the picture.
        self.look: dict | None = None
        self._thread: threading.Thread | None = None
        self._abort = threading.Event()
        self._lock = threading.Lock()

    # --- settings -------------------------------------------------------------

    def settings(self):
        try:
            settings = self.Settings.model_validate(self._store().get(self.key, {}))
            settings.check()
            return settings
        except ValueError:
            return self.Settings()

    def update(self, patch: dict, clear: tuple[str, ...] = ()):
        """Keeps new settings, the whole set checked first; `clear` names the
        ones to take back to none. A running camera given another device,
        size, rate or program starts again on them."""
        before = self.settings()
        merged = {**before.model_dump(), **{key: value for key, value in patch.items() if value is not None}}
        for key in clear:
            if key in self.clearable:
                merged[key] = None
        for key in self.places:
            if isinstance(merged.get(key), (list, tuple)):
                merged[key] = tuple(float(v) for v in merged[key])
        settings = self.Settings.model_validate(merged)
        settings.check()
        restart = self.client.running and any(getattr(settings, key) != getattr(before, key) for key in CAPTURE_KEYS)
        if restart and self.routine_active:
            raise PnpError(f"the {self.label} routine is under way: abort it first")
        self._store()[self.key] = settings.model_dump()
        self._save()
        if restart:
            # A start that fails leaves the camera stopped and says why.
            self.client.close()
            self.start()
        return settings

    # --- pcbv -----------------------------------------------------------------

    @property
    def running(self) -> bool:
        return self.client.running

    @property
    def routine_active(self) -> bool:
        thread = self._thread
        return thread is not None and thread.is_alive()

    def aborting(self) -> bool:
        return self._abort.is_set()

    def start(self) -> None:
        if self.client.running:
            raise PnpError(f"the {self.label} is already running")
        settings = self.settings()
        self.client.start(settings.device, settings.size, settings.fps, settings.pcbv)
        log.info("%s started on %s", self.label, settings.device)
        refused = apply_kept(settings.device, settings.controls)
        if refused:
            self._message("error", f"the {self.label}'s controls were not all set: {refused}")
        lens = getattr(settings, "lens", None)
        if lens is not None:
            try:
                self.client.lens(lens)
            except VisionError as exc:
                self._message("error", f"the {self.label}'s lens correction was not taken: {exc}")

    def set_lens(self, lens: dict | None):
        """Keeps a lens correction (None: none) and gives it to a running
        pcbv; refused when pcbv refuses it."""
        settings = self.Settings.model_validate({**self.settings().model_dump(), "lens": lens})
        settings.check()
        if self.client.running:
            self.client.lens(lens)
        self._store()[self.key] = settings.model_dump()
        self._save()
        return settings

    def stop(self) -> None:
        if self.routine_active:
            raise PnpError(f"the {self.label} routine is under way: abort it first")
        self.client.close()

    def frame(self, width: int, overlay: bool) -> bytes:
        if not self.client.running:
            raise PnpError(f"the {self.label} is not running")
        _, data = self.client.frame(width=width, overlay=overlay)
        return data

    def state(self) -> dict:
        """The settings (places as lists), whether it runs, its latest
        frame's size, age and rate, and the routine under way or the last."""
        settings = self.settings()
        frame = None
        if self.client.running:
            try:
                raw = self.client.pose()
                if "width" in raw:
                    frame = {"width": raw.get("width"), "height": raw.get("height"), "age_ms": raw.get("age_ms"), "fps": raw.get("fps")}
            except VisionError as exc:
                if "no frame" not in str(exc):
                    log.warning("%s: %s", self.label, exc)
        dump = settings.model_dump()
        for key in self.places:
            dump[key] = list(dump[key]) if dump[key] is not None else None
        progress = self.progress
        return {
            "running": self.client.running,
            **dump,
            "frame": frame,
            "routine": progress.to_dict() if progress is not None else None,
            "look": self.look,
        }

    def look_once(self, polarity: str, radius: float | None = None) -> dict:
        """The spot of `polarity` the finder takes in the picture now, found
        once with no move, kept for the page to draw: a wrong polarity or a
        size the finder refuses shows before a routine trusts it."""
        if polarity not in SHADES:
            raise ValueError("the spot is dark or bright")
        if not self.client.running:
            raise PnpError(f"the {self.label} is not running: start it first")
        color = getattr(self.settings(), "colors", {}).get("spots")
        reply = self.client.spot(radius=radius, polarity=polarity, **({"color": color} if color is not None else {}))
        self._log_look("a look by hand", "look", reply, polarity)
        self.look = look_dict(reply, polarity, radius)
        self._publish()
        return self.look

    def _find_spot(self, **fields) -> dict:
        """pcbv's spot in a picture taken once the head came to rest after
        the move before it."""
        wait_settled(self.client)
        color = getattr(self.settings(), "colors", {}).get("spots")
        if color is not None and "color" not in fields:
            fields["color"] = color
        return self.client.spot(**fields)

    def shutdown(self) -> None:
        self._abort.set()
        try:
            self.client.close()
        except Exception:
            pass

    # --- a routine -------------------------------------------------------------

    def abort(self) -> None:
        if not self.routine_active:
            raise PnpError(f"no {self.label} routine is under way")
        self._abort.set()

    def _begin(self, kind: str, steps: tuple[str, ...], mover: Mover, body: Callable[[RoutineProgress], None]) -> None:
        mover.check()
        if not self.client.running:
            raise ValueError(f"the {self.label} is not running: start it first")
        with self._lock:
            if self.routine_active:
                raise PnpError(f"an {self.label} routine is already under way" if self.label[0] in "aeiou" else f"a {self.label} routine is already under way")
            self._abort.clear()
            self._looks = 0
            self.progress = RoutineProgress(kind=kind, steps=steps, step=steps[0], target=mover.name)
            progress = self.progress
            self._thread = threading.Thread(target=self._run, args=(mover, progress, body), name=f"{self.log_name}-{kind}", daemon=True)
            self._thread.start()
        self._publish()

    def _run(self, mover: Mover, progress: RoutineProgress, body: Callable[[RoutineProgress], None]) -> None:
        what = self.routines.get(progress.kind, progress.kind)
        try:
            body(progress)
            self._step(progress, "done")
            progress.state = DONE
        except (LinkError, VisionError, PnpError, ValueError) as exc:
            if self._abort.is_set():
                progress.state = STOPPED
                progress.error = "stopped"
                mover.halt()
            else:
                progress.state = ERROR
                progress.error = str(exc)
                self._message("error", f"{what} failed: {exc}")
        except Exception as exc:
            progress.state = ERROR
            progress.error = repr(exc)
            self._message("error", f"{what} failed: {exc!r}")
        finally:
            self._publish()

    def _step(self, progress: RoutineProgress | None, step: str) -> None:
        if progress is None:
            return
        progress.step = step
        self._publish()

    def _log_look(self, routine: str, step: str, reply: dict, shade: str) -> None:
        """Keeps the picture of a look while logging is on, found or not:
        a look that found nothing is the one to see."""
        if self.camlog is None:
            return
        self._looks += 1
        self.camlog.look(self.client, self.log_name, routine, step, spot=reply, note=f"{shade} spot, look {self._looks}")


class UpCamera(PickCamera):
    """The up camera's settings and state, pcbv behind them, and the routines.
    The camera may sit on a machine on this project's firmware or on a G-code
    machine: a routine is given the mover of the one connected and that one's
    calibration."""

    label = "bottom camera"
    log_name = "up"
    key = "pnp"
    Settings = UpCameraSettings
    places = ("position",)
    clearable = ("position", "height")
    routines = {"nozzle": "centering the nozzle", "runout": "measuring the runout", "part": "looking at the part"}

    def __init__(self, config: dict, save: Callable[[], None], publish: Callable[[], None], message: Callable[[str, str], None]) -> None:
        super().__init__(lambda: config, save, publish, message)
        self.config = config
        # Where the last part looked at sat against the nozzle's center, mm
        # in the machine's frame, and how big it looked.
        self.part_offset: dict | None = None

    def settings(self) -> UpCameraSettings:
        return super().settings()

    def update(self, patch: dict, clear: tuple[str, ...] = ()) -> UpCameraSettings:
        return super().update(patch, clear)

    def place(self) -> CameraPlace:
        """The camera's calibration on this machine, from the settings."""
        settings = self.settings()
        return CameraPlace(settings.position, settings.height, settings.mm_per_px, settings.roll, settings.mirror)

    def _keep_place(self, place: CameraPlace) -> None:
        self.update(
            {
                "position": place.position,
                "mm_per_px": place.mm_per_px,
                "roll": place.roll,
                "mirror": place.mirror,
                **({"height": place.height} if place.height is not None else {}),
            }
        )

    @property
    def target(self) -> str:
        """The machine the routine under way, or the last one, moves."""
        progress = self.progress
        return progress.target if progress is not None else "machine"

    def state(self) -> dict:
        return {**super().state(), "part_offset": self.part_offset}

    # --- the routines -----------------------------------------------------------

    def center_nozzle(self, mover: Mover, step: float, place: CameraPlace | None = None, keep: Callable[[CameraPlace], None] | None = None) -> None:
        """Starts the nozzle routine on its own thread; the caller has
        checked that nothing else owns the machine. `place` and `keep` are
        the calibration of the machine the camera sits on, this one's by
        default."""
        if not (math.isfinite(step) and 0.0 <= step <= MAX_STEP):
            raise ValueError(f"the step must be 0 to {MAX_STEP:g} mm")
        start = place if place is not None else self.place()
        self._begin("nozzle", NOZZLE_STEPS, mover, lambda progress: self._center(mover, step, progress, start, keep or self._keep_place))

    def measure_part(self, mover: Mover) -> None:
        """Starts the part routine on its own thread, over the camera as
        this machine's calibration places it."""
        start = self.place()
        if not start.measured:
            raise ValueError("the nozzle is not centered over the bottom camera yet: center it first")
        self._begin("part", PART_STEPS, mover, lambda progress: self._measure(mover, progress, start))

    def _over_camera(self, mover: Mover, progress: RoutineProgress | None, place: CameraPlace, angle: float = 0.0, head: Point | None = None) -> None:
        """Up to the travel height, the nozzle turned to `angle` where it
        turns, over the camera (at `head`, else its place, when known), and
        down to the height the nozzle is sharp at."""
        mover.begin()
        self._step(progress, "lifting")
        mover.lift()
        if mover.can_turn:
            mover.turn(angle)
        self._step(progress, "moving")
        where = head if head is not None else place.position
        if where is not None:
            mover.go(where)
        self._step(progress, "lowering")
        if place.height is not None:
            mover.lower(place.height)

    def _center(self, mover: Mover, step: float, progress: RoutineProgress, place: CameraPlace, keep: Callable[[CameraPlace], None]) -> None:
        settings = self.settings()
        self._over_camera(mover, progress, place)
        polarity = settings.nozzle_spot
        # The runout is the nozzle's own and outlasts a new center.
        seen = CameraPlace(place.position, place.height, place.mm_per_px, place.roll, place.mirror, place.runout)
        spot = self._spot(mover, progress, polarity, seen, "no nozzle in the picture: jog it over the bottom camera and center again")
        if step > 0.0 or seen.mm_per_px <= 0.0:
            self._step(progress, "scale")
            move = step if step > 0.0 else DEFAULT_STEP
            here = mover.here()
            mover.go((here[0] + move, here[1]))
            along = self._spot(mover, progress, polarity, seen, "the nozzle left the picture on the move along X: use a shorter step")
            mover.go((here[0], here[1] + move))
            across = self._spot(mover, progress, polarity, seen, "the nozzle left the picture on the move along Y: use a shorter step")
            mover.go(here)
            seen.mm_per_px, seen.roll, seen.mirror = calibrate((along.dx - spot.dx, along.dy - spot.dy), (across.dx - spot.dx, across.dy - spot.dy), move)
            spot = self._spot(mover, progress, polarity, seen, "the nozzle left the picture")
        self._step(progress, "centering")
        for _ in range(CENTER_TRIES):
            off = picture_to_machine(spot.dx, spot.dy, seen.mm_per_px, seen.roll, seen.mirror)
            if math.hypot(*off) <= CENTER_TOLERANCE:
                break
            here = mover.here()
            mover.go((here[0] - off[0], here[1] - off[1]))
            spot = self._spot(mover, progress, polarity, seen, "the nozzle left the picture while centering")
        off = picture_to_machine(spot.dx, spot.dy, seen.mm_per_px, seen.roll, seen.mirror)
        here = mover.here()
        seen.position = (round(here[0] - off[0], 4), round(here[1] - off[1], 4))
        height = mover.height()
        if height is not None:
            seen.height = round(height, 4)
        keep(seen)
        self._message(
            "info",
            f"nozzle centered over the bottom camera at {mover.describe(seen.position)},"
            f" {seen.mm_per_px * 1000.0:.1f} um per pixel, roll {seen.roll:+.2f} degrees{', mirrored' if seen.mirror else ''}",
        )

    def look_at_part(
        self,
        mover: Mover,
        place: CameraPlace,
        progress: RoutineProgress | None = None,
        angle: float = 0.0,
        head: Point | None = None,
        size: tuple[float, float] | None = None,
        crop: float | None = None,
    ) -> dict:
        """Over the camera with the part the nozzle holds, the nozzle turned
        to `angle` where it turns and the head at `head` (the camera's place
        by default): where the part's center sits against the picture's
        center, mm in the machine's frame (`dx`, `dy`), how big it looks,
        and the direction of its long side in the machine's frame, degrees
        (`angle`; None when the picture tells none). `size`, the length and
        width expected, keeps the finder to spots of about that area. Also
        what a G-code machine's placing run calls between a pick and its place;
        `crop`, mm, keeps the look within that far of the picture's center."""
        settings = self.settings()
        self._over_camera(mover, progress, place, angle, head)
        self._step(progress, "looking")
        if mover.stopped():
            raise PnpError("stopped")
        limits: dict = {}
        if size is not None and place.mm_per_px > 0.0:
            area = size[0] * size[1] / (place.mm_per_px * place.mm_per_px)
            limits = {"min_area": area * 0.25, "max_area": area * 4.0}
        if crop is not None and place.mm_per_px > 0.0:
            limits["radius"] = crop / place.mm_per_px
        reply = self._find_spot(polarity=settings.part_spot, **limits)
        self._log_look("looking at the part" if progress is not None else "placing: looking at the part", "looking", reply, settings.part_spot)
        if not reply.get("found"):
            raise NoSpot("no part in the picture: is one on the nozzle, and is the part spot the right polarity?")
        return self._part_seen(reply, place, progress)

    def _part_seen(self, reply: dict, place: CameraPlace, progress: RoutineProgress | None) -> dict:
        dx, dy = float(reply.get("dx", 0.0)), float(reply.get("dy", 0.0))
        off = picture_to_machine(dx, dy, place.mm_per_px, place.roll, place.mirror)
        if progress is not None:
            progress.spot = spot_of(reply)
            progress.spot.mm = math.hypot(*off)
        rect = reply.get("rect")
        direction = None
        if isinstance(rect, dict) and all(isinstance(rect.get(key), (int, float)) for key in ("length", "width", "angle")):
            length, width = float(rect["length"]), float(rect["width"])
            direction = picture_angle_to_machine(float(rect["angle"]), place.roll, place.mirror)
        else:
            length, width = float(reply.get("major", 0.0)), float(reply.get("minor", 0.0))
            # An older pcbv sends no rectangle: a clearly long part still
            # points along its ellipse's axis.
            if isinstance(reply.get("angle"), (int, float)) and width > 0.0 and length / width >= ELONGATED:
                direction = picture_angle_to_machine(float(reply["angle"]), place.roll, place.mirror)
        return {
            "dx": round(off[0], 4),
            "dy": round(off[1], 4),
            "mm": round(math.hypot(*off), 4),
            "length": round(length * place.mm_per_px, 3),
            "width": round(width * place.mm_per_px, 3),
            "angle": round(direction, 3) if direction is not None else None,
        }

    def measure_runout(self, mover: Mover, place: CameraPlace, keep: Callable[[CameraPlace], None], rotation_cw: bool = False) -> None:
        """Starts the runout routine on its own thread: the nozzle over the
        camera, its tip found at six angles, and the circle they lie on
        gives how far the tip sits off the turning axis. `rotation_cw` is
        what the profile says of the axis, checked against the turn seen."""
        if not mover.can_turn:
            raise ValueError("this machine does not turn its nozzle: the runout is measured on a G-code machine")
        if not place.measured:
            raise ValueError("the nozzle is not centered over the bottom camera yet: center it first")
        self._begin("runout", RUNOUT_STEPS, mover, lambda progress: self._runout(mover, progress, place, keep, rotation_cw))

    def _runout(self, mover: Mover, progress: RoutineProgress, place: CameraPlace, keep: Callable[[CameraPlace], None], rotation_cw: bool) -> None:
        settings = self.settings()
        self._over_camera(mover, progress, place, 0.0)
        self._step(progress, "turning")
        here = mover.here()
        seen: list[Point] = []
        try:
            for angle in RUNOUT_ANGLES:
                mover.turn(angle)
                spot = self._spot(mover, progress, settings.nozzle_spot, place, f"the nozzle's tip left the picture at {angle:g} degrees")
                seen.append(picture_to_machine(spot.dx, spot.dy, place.mm_per_px, place.roll, place.mirror))
        finally:
            # Back to 0, without hiding why the routine ended.
            if not mover.stopped():
                try:
                    mover.turn(0.0)
                except PnpError:
                    pass
        center, radius, rms = fit_circle(seen)
        # The tip at 0 less the axis: how far off true the tip runs.
        runout = (seen[0][0] - center[0], seen[0][1] - center[1])
        if radius >= max(RUNOUT_VISIBLE_MM, RUNOUT_VISIBLE_PX * place.mm_per_px):
            steps = []
            for a, b in zip(seen, seen[1:]):
                before = math.atan2(a[1] - center[1], a[0] - center[0])
                after = math.atan2(b[1] - center[1], b[0] - center[0])
                steps.append(math.degrees(math.atan2(math.sin(after - before), math.cos(after - before))))
            mean = sum(steps) / len(steps)
            if mean < 0.0:
                fix = "false" if rotation_cw else "true"
                raise PnpError(
                    f"the tip went round clockwise as the nozzle was turned counterclockwise ({mean:+.0f} degrees a step):"
                    f" the rotation axis turns the other way; set [gcode] rotation_cw = {fix} in the profile and measure again"
                )
            turns = "turns counterclockwise as the profile says"
        else:
            turns = "too small to show which way the nozzle turns"
        kept = CameraPlace(
            position=(round(here[0] - seen[0][0], 4), round(here[1] - seen[0][1], 4)),
            height=place.height,
            mm_per_px=place.mm_per_px,
            roll=place.roll,
            mirror=place.mirror,
            runout=(round(runout[0], 4), round(runout[1], 4)),
        )
        keep(kept)
        fit = f", the tips {rms * 1000.0:.0f} um rms off the circle" if rms > 0.0 else ""
        self._message("info", f"nozzle runout {radius * 1000.0:.0f} um ({turns}){fit}")

    def _measure(self, mover: Mover, progress: RoutineProgress, place: CameraPlace) -> None:
        self.part_offset = self.look_at_part(mover, place, progress)
        self._message("info", f"the part sits X {self.part_offset['dx']:+.3f} Y {self.part_offset['dy']:+.3f} mm from the nozzle's center")

    def _spot(self, mover: Mover, progress: RoutineProgress, polarity: str, place: CameraPlace, missing: str) -> Spot:
        if mover.stopped():
            raise PnpError("stopped")
        reply = self._find_spot(polarity=polarity)
        routine = {"nozzle": "centering the nozzle", "runout": "measuring the runout"}.get(progress.kind, "looking at the part")
        self._log_look(routine, progress.step, reply, polarity)
        if not reply.get("found"):
            raise PnpError(missing)
        spot = spot_of(reply)
        if place.mm_per_px > 0.0:
            spot.mm = math.hypot(*picture_to_machine(spot.dx, spot.dy, place.mm_per_px, place.roll, place.mirror))
        progress.spot = spot
        self._publish()
        return spot
