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

from pydantic import BaseModel, ConfigDict

from spinny_laser import machines as machine_files

from .camera import CAPTURE_KEYS
from .kinematics import FOCUS_DECIMALS, coord
from .link import Link, LinkError
from .log import log
from .vision import VisionClient, VisionError

Point = tuple[float, float]
RUNNING, DONE, STOPPED, ERROR = "running", "done", "stopped", "error"
NOZZLE_STEPS = ("lifting", "moving", "lowering", "scale", "centering", "done")
PART_STEPS = ("lifting", "moving", "lowering", "looking", "done")
POLARITIES = ("dark", "bright")
# The head is moved until the nozzle is this close to the picture's
# center, mm, at most this many times.
CENTER_TOLERANCE = 0.02
CENTER_TRIES = 4
DEFAULT_STEP = 1.0
MAX_STEP = 10.0
MOVE_TIMEOUT = 30.0
SETTLE_POLL = 0.05
# The most a measured or typed value may be, mm.
POSITION_LIMIT = 2000.0
HEIGHT_LIMIT = 100.0


class PnpError(Exception):
    """The up camera, or its routine, is in the wrong state for the request."""


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
    down, and its angle in degrees, counterclockwise as drawn."""

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


def footprints_of(text: str) -> list[Footprint]:
    """The footprints of a .kicad_pcb text, KiCad 5 (`module`, `fp_text`)
    to 10 (`footprint`, `property`), in file order. A footprint kept out of
    the position files or on the board only (a logo, a fiducial drawn as
    one) is not a part, and neither is one with no reference."""
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
        if not ref or "*" in ref or "exclude_from_pos_files" in flags or "board_only" in flags:
            continue
        at = _child(node, "at") or ["at", "0", "0"]
        layer = _child(node, "layer")
        side = "back" if layer is not None and len(layer) > 1 and str(layer[1]).startswith("B.") else "front"
        pads = sum(1 for item in node if isinstance(item, list) and item and item[0] == "pad")
        found.append(
            Footprint(
                ref=ref,
                value=value,
                footprint=node[1] if len(node) > 1 and isinstance(node[1], str) else "",
                side=side,
                x=_number(at[1] if len(at) > 1 else 0),
                y=_number(at[2] if len(at) > 2 else 0),
                rotation=_number(at[3] if len(at) > 3 else 0) % 360.0,
                pads=pads,
                smd="smd" in flags,
                dnp="dnp" in flags,
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
            }
        )
    return parts


# --- the picture ---------------------------------------------------------------


def picture_to_machine(dx: float, dy: float, mm_per_px: float, roll: float, mirror: bool) -> Point:
    """A point seen `dx`, `dy` px from the picture's center (right and down
    positive) as a displacement in the machine's frame from the point seen
    at the center, mm: the picture's y turned over, its x as well when the
    picture is mirrored, then turned by the roll and scaled."""
    u, v = (-dx if mirror else dx), -dy
    radians = math.radians(roll)
    c, s = math.cos(radians), math.sin(radians)
    return (mm_per_px * (u * c - v * s), mm_per_px * (u * s + v * c))


def calibrate(moved_x: Point, moved_y: Point, step: float) -> tuple[float, float, bool]:
    """The picture's mm per px, roll and mirror from how a spot the head
    holds moved in it, px, when the head moved `step` mm along +X
    (`moved_x`) and then along +Y (`moved_y`) from the same place: a mirror
    reverses which way the two moves turn."""
    w1 = (moved_x[0], -moved_x[1])
    w2 = (moved_y[0], -moved_y[1])
    cross = w1[0] * w2[1] - w1[1] * w2[0]
    if math.hypot(*w1) < 1e-6 or math.hypot(*w2) < 1e-6 or abs(cross) < 1e-9:
        raise ValueError("the spot did not move with the head: is the nozzle over the up camera?")
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
    """What the backend keeps of the up camera, the machine file's `[pnp]`."""

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

    def check(self) -> None:
        if not self.device.strip():
            raise ValueError("the up camera device must be named")
        if not machine_files._CAMERA_SIZE.match(self.size):
            raise ValueError("the up camera size must be WIDTHxHEIGHT")
        if not 1 <= int(self.fps) <= 120:
            raise ValueError("the up camera fps must be 1 to 120")
        if not self.pcbv.strip():
            raise ValueError("the pcbv program must be named")
        if self.nozzle_spot not in POLARITIES or self.part_spot not in POLARITIES:
            raise ValueError("the nozzle and part spots are dark or bright")
        if self.position is not None and any(not math.isfinite(v) or abs(v) > POSITION_LIMIT for v in self.position):
            raise ValueError(f"the up camera position must be two numbers within {POSITION_LIMIT:g} mm")
        if self.height is not None and not (math.isfinite(self.height) and abs(self.height) <= HEIGHT_LIMIT):
            raise ValueError(f"the up camera height must be within {HEIGHT_LIMIT:g} mm")
        if not (math.isfinite(self.mm_per_px) and 0.0 <= self.mm_per_px <= 1.0):
            raise ValueError("mm_per_px must be 0 to 1")
        if not (math.isfinite(self.roll) and abs(self.roll) <= 360.0):
            raise ValueError("the up camera roll must be within 360 degrees")


@dataclass
class Spot:
    dx: float
    dy: float
    mm: float = 0.0

    def to_dict(self) -> dict:
        return {"dx": round(self.dx, 2), "dy": round(self.dy, 2), "mm": round(self.mm, 4)}


@dataclass
class RoutineProgress:
    kind: str
    steps: tuple[str, ...]
    # The machine the routine moves: this one, or a G-code device.
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
class MachineAccess:
    """What the routines need of the machine: the link, the streamer for its
    joints, the height to travel at and whether there is a focus axis."""

    link: Link
    streamer: object
    lift: float
    has_focus_axis: bool


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
        }


class Mover:
    """What a routine moves: this machine's head or a G-code device's, to
    absolute places in that machine's own frame, each move waited out
    before the next. `name` says which machine, `letters` what its two
    axes are called."""

    name = "machine"
    letters = ("R", "Z")

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
        """Up to the height the head travels at, when it is lower."""
        raise NotImplementedError

    def go(self, point: Point) -> None:
        raise NotImplementedError

    def lower(self, height: float) -> None:
        raise NotImplementedError

    def halt(self) -> None:
        raise NotImplementedError

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
            raise ValueError("the up camera needs an X/Y machine ($cartesian=1): on the polar one only the rail crosses its picture")

    def begin(self) -> None:
        link = self.access.link
        status = link.status_now(1.0, routine=True)
        if status.state != "Idle":
            raise PnpError(f"the machine is {status.raw or status.state}, not Idle")
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
        try:
            if link.is_open:
                halt(link, self._message)
        except LinkError:
            pass

    def _line(self, line: str) -> None:
        if self._stopped():
            raise PnpError("stopped")
        self.access.link.request_ok(line)

    def _settle(self, seconds: float):
        """Waits for the machine to come to rest after a move; a hold extends the wait."""
        link = self.access.link
        allowed = seconds + MOVE_TIMEOUT
        deadline = time.monotonic() + allowed
        while True:
            if self._stopped():
                raise PnpError("stopped")
            status = link.status_now(1.0, routine=True)
            if link.restarts != self._restarts:
                raise PnpError("the machine reset during the routine")
            if status.state == "Idle":
                return status
            if status.state == "Alarm":
                raise PnpError(f"the machine raised an alarm: {status.raw}")
            if status.state == "Hold":
                deadline = time.monotonic() + allowed
            if time.monotonic() > deadline:
                raise PnpError(f"the head did not come to rest: {status.raw}")
            time.sleep(SETTLE_POLL)


class UpCamera:
    """The up camera's settings and state, pcbv behind them, and the routines.
    The camera may sit on this machine or on a G-code device: a routine is
    given the mover of the one it is on and that one's calibration."""

    def __init__(self, config: dict, save: Callable[[], None], publish: Callable[[], None], message: Callable[[str, str], None]) -> None:
        self.config = config
        self._save = save
        self._publish = publish
        self._message = message
        self.client = VisionClient()
        # Where every look a routine takes is kept while logging is on; the
        # backend sets it.
        self.camlog = None
        self._looks = 0
        self.progress: RoutineProgress | None = None
        # Where the last part looked at sat against the nozzle's center, mm
        # in the machine's frame, and how big it looked.
        self.part_offset: dict | None = None
        # The machine the routine under way (or the last one) moves.
        self.target = "machine"
        self._thread: threading.Thread | None = None
        self._abort = threading.Event()
        self._lock = threading.Lock()

    # --- settings -------------------------------------------------------------

    def settings(self) -> UpCameraSettings:
        try:
            settings = UpCameraSettings.model_validate(self.config.get("pnp", {}))
            settings.check()
            return settings
        except ValueError:
            return UpCameraSettings()

    def update(self, patch: dict, clear: tuple[str, ...] = ()) -> UpCameraSettings:
        """Keeps new settings, the whole set checked first; `clear` names the
        ones (position, height) to take back to none. A running camera given
        another device, size, rate or program starts again on them."""
        before = self.settings()
        merged = {**before.model_dump(), **{key: value for key, value in patch.items() if value is not None}}
        for key in clear:
            if key in ("position", "height"):
                merged[key] = None
        if isinstance(merged.get("position"), (list, tuple)):
            merged["position"] = tuple(float(v) for v in merged["position"])
        settings = UpCameraSettings.model_validate(merged)
        settings.check()
        restart = self.client.running and any(getattr(settings, key) != getattr(before, key) for key in CAPTURE_KEYS)
        if restart and self.routine_active:
            raise PnpError("the up camera routine is under way: abort it first")
        self.config["pnp"] = settings.model_dump()
        self._save()
        if restart:
            # A start that fails leaves the camera stopped and says why.
            self.client.close()
            self.start()
        return settings

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
            raise PnpError("the up camera is already running")
        settings = self.settings()
        self.client.start(settings.device, settings.size, settings.fps, settings.pcbv)
        log.info("up camera started on %s", settings.device)

    def stop(self) -> None:
        if self.routine_active:
            raise PnpError("the up camera routine is under way: abort it first")
        self.client.close()

    def frame(self, width: int, overlay: bool) -> bytes:
        if not self.client.running:
            raise PnpError("the up camera is not running")
        _, data = self.client.frame(width=width, overlay=overlay)
        return data

    def state(self) -> dict:
        settings = self.settings()
        frame = None
        if self.client.running:
            try:
                raw = self.client.pose()
                if "width" in raw:
                    frame = {"width": raw.get("width"), "height": raw.get("height"), "age_ms": raw.get("age_ms"), "fps": raw.get("fps")}
            except VisionError as exc:
                if "no frame" not in str(exc):
                    log.warning("up camera: %s", exc)
        progress = self.progress
        return {
            "running": self.client.running,
            **settings.model_dump(),
            "position": list(settings.position) if settings.position is not None else None,
            "frame": frame,
            "routine": progress.to_dict() if progress is not None else None,
            "part_offset": self.part_offset,
        }

    def shutdown(self) -> None:
        self._abort.set()
        try:
            self.client.close()
        except Exception:
            pass

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

    def measure_part(self, mover: Mover, place: CameraPlace | None = None) -> None:
        start = place if place is not None else self.place()
        if not start.measured:
            raise ValueError("the nozzle is not centered over the up camera yet: center it first")
        self._begin("part", PART_STEPS, mover, lambda progress: self._measure(mover, progress, start))

    def abort(self) -> None:
        if not self.routine_active:
            raise PnpError("no up camera routine is under way")
        self._abort.set()

    def _begin(self, kind: str, steps: tuple[str, ...], mover: Mover, body: Callable[[RoutineProgress], None]) -> None:
        mover.check()
        if not self.client.running:
            raise ValueError("the up camera is not running: start it first")
        with self._lock:
            if self.routine_active:
                raise PnpError("an up camera routine is already under way")
            self._abort.clear()
            self._looks = 0
            self.target = mover.name
            self.progress = RoutineProgress(kind=kind, steps=steps, step=steps[0], target=mover.name)
            progress = self.progress
            self._thread = threading.Thread(target=self._run, args=(mover, progress, body), name=f"pnp-{kind}", daemon=True)
            self._thread.start()
        self._publish()

    def _run(self, mover: Mover, progress: RoutineProgress, body: Callable[[RoutineProgress], None]) -> None:
        what = "centering the nozzle" if progress.kind == "nozzle" else "looking at the part"
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

    def _over_camera(self, mover: Mover, progress: RoutineProgress | None, place: CameraPlace) -> None:
        """Up to the travel height, over the camera when its place is known,
        and down to the height the nozzle is sharp at."""
        mover.begin()
        self._step(progress, "lifting")
        mover.lift()
        self._step(progress, "moving")
        if place.position is not None:
            mover.go(place.position)
        self._step(progress, "lowering")
        if place.height is not None:
            mover.lower(place.height)

    def _center(self, mover: Mover, step: float, progress: RoutineProgress, place: CameraPlace, keep: Callable[[CameraPlace], None]) -> None:
        settings = self.settings()
        self._over_camera(mover, progress, place)
        polarity = settings.nozzle_spot
        seen = CameraPlace(place.position, place.height, place.mm_per_px, place.roll, place.mirror)
        spot = self._spot(mover, progress, polarity, seen, "no nozzle in the picture: jog it over the up camera and center again")
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
            f"nozzle centered over the up camera at {mover.describe(seen.position)},"
            f" {seen.mm_per_px * 1000.0:.1f} um per pixel, roll {seen.roll:+.2f} degrees{', mirrored' if seen.mirror else ''}",
        )

    def look_at_part(self, mover: Mover, place: CameraPlace, progress: RoutineProgress | None = None) -> dict:
        """Over the camera with the part the nozzle holds: where its center
        sits against the nozzle's, mm in the machine's frame, and how big it
        looks. Also what a G-code device's program calls between a pick and
        its place."""
        settings = self.settings()
        self._over_camera(mover, progress, place)
        self._step(progress, "looking")
        if mover.stopped():
            raise PnpError("stopped")
        reply = self.client.spot(polarity=settings.part_spot)
        self._log_look("looking at the part" if progress is not None else "placing: looking at the part", "looking", reply, settings.part_spot)
        if not reply.get("found"):
            raise PnpError("no part in the picture: is one on the nozzle, and is the part spot the right polarity?")
        dx, dy = float(reply.get("dx", 0.0)), float(reply.get("dy", 0.0))
        off = picture_to_machine(dx, dy, place.mm_per_px, place.roll, place.mirror)
        if progress is not None:
            progress.spot = Spot(dx=dx, dy=dy, mm=math.hypot(*off))
        return {
            "dx": round(off[0], 4),
            "dy": round(off[1], 4),
            "mm": round(math.hypot(*off), 4),
            "length": round(float(reply.get("major", 0.0)) * place.mm_per_px, 3),
            "width": round(float(reply.get("minor", 0.0)) * place.mm_per_px, 3),
        }

    def _measure(self, mover: Mover, progress: RoutineProgress, place: CameraPlace) -> None:
        self.part_offset = self.look_at_part(mover, place, progress)
        self._message("info", f"the part sits X {self.part_offset['dx']:+.3f} Y {self.part_offset['dy']:+.3f} mm from the nozzle's center")

    def _log_look(self, routine: str, step: str, reply: dict, polarity: str) -> None:
        """Keeps the picture of a look while logging is on, found or not:
        a look that found nothing is the one to see."""
        if self.camlog is None:
            return
        self._looks += 1
        self.camlog.look(self.client, "up", routine, step, spot=reply, note=f"{polarity} spot, look {self._looks}")

    def _step(self, progress: RoutineProgress | None, step: str) -> None:
        if progress is None:
            return
        progress.step = step
        self._publish()

    def _spot(self, mover: Mover, progress: RoutineProgress, polarity: str, place: CameraPlace, missing: str) -> Spot:
        if mover.stopped():
            raise PnpError("stopped")
        reply = self.client.spot(polarity=polarity)
        self._log_look("centering the nozzle" if progress.kind == "nozzle" else "looking at the part", progress.step, reply, polarity)
        if not reply.get("found"):
            raise PnpError(missing)
        spot = Spot(dx=float(reply.get("dx", 0.0)), dy=float(reply.get("dy", 0.0)))
        if place.mm_per_px > 0.0:
            spot.mm = math.hypot(*picture_to_machine(spot.dx, spot.dy, place.mm_per_px, place.roll, place.mirror))
        progress.spot = spot
        self._publish()
        return spot
