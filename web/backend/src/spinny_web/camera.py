"""A camera on the head: its settings, its picture and pose through
pcb-vision, and the routine that measures where it looks from the tool.

The camera sees the board a fixed way off from the tool: `offset` is the
board point under the picture's center less the tool's, `roll` the turn of
the picture's x axis from board +X, and `mm_per_px` the picture's scale at
the board. The find routine measures all three from a mark the tool made:
the head goes where the camera should see the mark, the dark spot nearest
the picture's center is taken for it, a short move along +X shows how the
picture turns and scales against the machine, and the head is moved by
the spot's distance from the center until the center sits on the mark,
where the offset is the mark less the tool's point.
"""

from __future__ import annotations

import math
import threading
import time
from dataclasses import dataclass, field
from typing import Callable

from pydantic import BaseModel, ConfigDict

from spinny_laser import machines as machine_files

from .kinematics import FOCUS_DECIMALS, coord
from .link import Link, LinkError
from .log import log
from .vision import VisionClient, VisionError

Point = tuple[float, float]
RUNNING, DONE, STOPPED, ERROR = "running", "done", "stopped", "error"
STEPS = ("lifting", "moving", "scale", "centering", "done")
# The spot is centered when it is within this of the picture's center, mm,
# and the head is moved at most this many times to get it there.
CENTER_TOLERANCE = 0.02
CENTER_TRIES = 3
# The move along +X that measures the picture's scale and turn, mm, when
# none is asked for.
DEFAULT_STEP = 2.0
MAX_STEP = 20.0
# How long a move may take beyond its own time before the routine gives up, s.
MOVE_TIMEOUT = 30.0
SETTLE_POLL = 0.05


class CameraError(Exception):
    """The camera, or its routine, is in the wrong state for the request."""


class CameraSettings(BaseModel):
    """What the backend keeps of the camera, the machine file's `[camera]`."""

    model_config = ConfigDict(extra="forbid")

    device: str = "/dev/video0"
    size: str = "1280x720"
    fps: int = 30
    pcbv: str = "pcbv"
    side: str = "front"
    finish: str = "masked"
    offset: tuple[float, float] = (0.0, 0.0)
    roll: float = 0.0
    mm_per_px: float = 0.0

    def check(self) -> None:
        if not self.device.strip():
            raise ValueError("the camera device must be named")
        if not machine_files._CAMERA_SIZE.match(self.size):
            raise ValueError("the camera size must be WIDTHxHEIGHT")
        if not 1 <= int(self.fps) <= 120:
            raise ValueError("the camera fps must be 1 to 120")
        if not self.pcbv.strip():
            raise ValueError("the pcbv program must be named")
        if self.side not in machine_files.CAMERA_SIDES:
            raise ValueError("the camera side must be front or back")
        if self.finish not in machine_files.CAMERA_FINISHES:
            raise ValueError("the camera finish must be masked or bare")
        if any(not math.isfinite(v) or abs(v) > 1000.0 for v in self.offset):
            raise ValueError("the camera offset must be two numbers within 1000 mm")
        if not (math.isfinite(self.roll) and abs(self.roll) <= 360.0):
            raise ValueError("the camera roll must be within 360 degrees")
        if not (math.isfinite(self.mm_per_px) and self.mm_per_px >= 0.0):
            raise ValueError("mm_per_px must be 0 or more")

    @property
    def width(self) -> int:
        return int(self.size.split("x")[0])

    @property
    def height(self) -> int:
        return int(self.size.split("x")[1])


@dataclass
class Spot:
    dx: float
    dy: float
    mm: float = 0.0

    def to_dict(self) -> dict:
        return {"dx": round(self.dx, 2), "dy": round(self.dy, 2), "mm": round(self.mm, 4)}


@dataclass
class RoutineProgress:
    state: str = RUNNING
    step: str = STEPS[0]
    done: int = 0
    total: int = 6
    error: str | None = None
    spot: Spot | None = None
    started: float = field(default_factory=time.monotonic, repr=False)

    def to_dict(self) -> dict:
        return {
            "state": self.state,
            "step": self.step,
            "done": self.done,
            "total": self.total,
            "error": self.error,
            "spot": self.spot.to_dict() if self.spot is not None else None,
            "seconds": round(time.monotonic() - self.started, 1),
        }


def pixel_to_board(dx: float, dy: float, mm_per_px: float, roll: float) -> Point:
    """A displacement in the picture (right and down positive, px) as a
    displacement on the board, mm: the picture's y points down, so it is
    turned over, then by the camera's roll, then scaled."""
    radians = math.radians(roll)
    c, s = math.cos(radians), math.sin(radians)
    u, v = dx, -dy
    return (mm_per_px * (u * c - v * s), mm_per_px * (u * s + v * c))


def scale_from_shift(before: Point, after: Point, step: float) -> tuple[float, float]:
    """The picture's mm per px and roll from how a spot moved in it, from
    `before` to `after` (px), when the head moved `step` mm along +X: the
    spot moves against the head, so its move in the picture is board -X."""
    du, dv = after[0] - before[0], after[1] - before[1]
    moved = math.hypot(du, dv)
    if moved < 1e-6:
        raise ValueError("the spot did not move in the picture: is the camera on the head?")
    mm_per_px = step / moved
    roll = math.degrees(math.pi - math.atan2(-dv, du))
    while roll > 180.0:
        roll -= 360.0
    while roll <= -180.0:
        roll += 360.0
    return mm_per_px, roll


@dataclass
class MachineAccess:
    """What the find routine needs of the machine: the link, the streamer
    for its frame, where the tool is on the board for a status, and the
    travel clearance."""

    link: Link
    streamer: object
    head_point: Callable[[object], Point]
    clearance: float
    has_focus_axis: bool


class Camera:
    """The camera's settings and state, pcbv behind them, and the routine."""

    def __init__(self, config: dict, save: Callable[[], None], publish: Callable[[], None], message: Callable[[str, str], None]) -> None:
        self.config = config
        self._save = save
        self._publish = publish
        self._message = message
        self.client = VisionClient()
        # The job whose board pcbv looks for, and the path it was loaded from.
        self.board_job: str | None = None
        self._board_path: str | None = None
        self.progress: RoutineProgress | None = None
        self._thread: threading.Thread | None = None
        self._abort = threading.Event()
        self._lock = threading.Lock()

    # --- settings -------------------------------------------------------------

    def settings(self) -> CameraSettings:
        try:
            settings = CameraSettings.model_validate(self.config.get("camera", {}))
            settings.check()
            return settings
        except ValueError:
            return CameraSettings()

    def update(self, patch: dict) -> CameraSettings:
        """Keeps new settings; the whole set is checked first."""
        current = self.settings().model_dump()
        merged = {**current, **{key: value for key, value in patch.items() if value is not None}}
        if "offset" in merged and isinstance(merged["offset"], (list, tuple)):
            merged["offset"] = tuple(float(v) for v in merged["offset"])
        settings = CameraSettings.model_validate(merged)
        settings.check()
        self.config["camera"] = settings.model_dump()
        self._save()
        return settings

    @property
    def mark(self) -> Point | None:
        value = self.config.get("camera_mark")
        if isinstance(value, (list, tuple)) and len(value) == 2:
            try:
                return (float(value[0]), float(value[1]))
            except (TypeError, ValueError):
                return None
        return None

    def set_mark(self, point: Point | None) -> None:
        if point is None:
            self.config.pop("camera_mark", None)
        else:
            self.config["camera_mark"] = [round(point[0], 4), round(point[1], 4)]
        self._save()

    # --- pcbv -----------------------------------------------------------------

    @property
    def running(self) -> bool:
        return self.client.running

    @property
    def routine_active(self) -> bool:
        thread = self._thread
        return thread is not None and thread.is_alive()

    def start(self) -> None:
        if self.client.running:
            raise CameraError("the camera is already running")
        settings = self.settings()
        self.client.start(settings.device, settings.size, settings.fps, settings.pcbv)
        self.board_job = None
        self._board_path = None
        log.info("camera started on %s", settings.device)

    def stop(self) -> None:
        if self.routine_active:
            raise CameraError("the camera is finding the mark: abort that first")
        self.client.close()
        self.board_job = None
        self._board_path = None

    def load_board(self, job_id: str | None, path: str | None) -> None:
        if not self.client.running:
            raise ValueError("the camera is not running: start it first")
        if job_id is None or path is None:
            self.client.board(None)
            self.board_job = None
            self._board_path = None
            return
        settings = self.settings()
        self.client.board(path, settings.side, settings.finish)
        self.board_job = job_id
        self._board_path = path

    def frame(self, width: int, overlay: bool) -> bytes:
        if not self.client.running:
            raise CameraError("the camera is not running")
        _, data = self.client.frame(width=width, overlay=overlay)
        return data

    def pose(self) -> dict | None:
        """The newest pose, or None with the camera stopped."""
        if not self.client.running:
            return None
        try:
            return self.client.pose()
        except VisionError as exc:
            if "no frame" in str(exc):
                return {"state": "none", "waiting": True}
            raise

    def state(self, job_center: Callable[[dict], Point | None] | None = None) -> dict:
        settings = self.settings()
        raw = None
        try:
            raw = self.pose()
        except VisionError as exc:
            log.warning("camera: %s", exc)
        frame = None
        pose = None
        if raw is not None:
            if "width" in raw:
                frame = {"width": raw.get("width"), "height": raw.get("height"), "age_ms": raw.get("age_ms"), "fps": raw.get("fps")}
            pose = pose_summary(raw)
            if job_center is not None and pose.get("state") == "locked":
                pose["job_center"] = job_center(raw)
        progress = self.progress
        return {
            "running": self.client.running,
            **settings.model_dump(),
            "offset": list(settings.offset),
            "board": self.board_job,
            "mark": list(self.mark) if self.mark is not None else None,
            "frame": frame,
            "pose": pose,
            "routine": progress.to_dict() if progress is not None else None,
        }

    def shutdown(self) -> None:
        self._abort.set()
        try:
            self.client.close()
        except Exception:
            pass

    # --- the find routine -----------------------------------------------------

    def find(self, access: MachineAccess, step: float) -> None:
        """Starts the routine on its own thread; the caller has checked
        that nothing else owns the machine."""
        if not (math.isfinite(step) and 0.0 <= step <= MAX_STEP):
            raise ValueError(f"the step must be 0 to {MAX_STEP:g} mm")
        mark = self.mark
        if mark is None:
            raise ValueError("no mark is recorded: make one with the tool, or say the mark is here")
        if not self.client.running:
            raise ValueError("the camera is not running: start it first")
        with self._lock:
            if self.routine_active:
                raise CameraError("the camera is already finding the mark")
            self._abort.clear()
            self.progress = RoutineProgress()
            progress = self.progress
            self._thread = threading.Thread(target=self._find, args=(access, mark, step, progress), name="camera-find", daemon=True)
            self._thread.start()
        self._publish()

    def abort(self) -> None:
        if not self.routine_active:
            raise CameraError("the camera is not finding the mark")
        self._abort.set()

    def _find(self, access: MachineAccess, mark: Point, step: float, progress: RoutineProgress) -> None:
        link = access.link
        restarts = link.restarts
        settings = self.settings()
        try:
            status = link.status_now(1.0, routine=True)
            if status.state != "Idle":
                raise CameraError(f"the machine is {status.raw or status.state}, not Idle")
            # Up to the travel height, so the move to the mark clears the board.
            self._step(progress, "lifting", 0)
            if access.has_focus_axis and status.h is not None and status.h < access.clearance - 1e-6:
                self._line(link, f"go H{coord(access.clearance, FOCUS_DECIMALS)}")
                status = self._settle(link, restarts, abs(access.clearance - status.h) / 100.0 * 60.0)
            # Where the camera should see the mark: the mark less the offset in force.
            self._step(progress, "moving", 1)
            offset = settings.offset
            status = self._move_to(access, status, (mark[0] - offset[0], mark[1] - offset[1]), restarts)
            spot = self._spot(progress, settings.mm_per_px, settings.roll)
            mm_per_px, roll = settings.mm_per_px, settings.roll
            if step > 0.0 or mm_per_px <= 0.0:
                self._step(progress, "scale", 2)
                move = step if step > 0.0 else DEFAULT_STEP
                head = access.head_point(status)
                status = self._move_to(access, status, (head[0] + move, head[1]), restarts)
                after = self._spot(progress, mm_per_px, roll)
                mm_per_px, roll = scale_from_shift((spot.dx, spot.dy), (after.dx, after.dy), move)
                status = self._move_to(access, status, head, restarts)
                spot = self._spot(progress, mm_per_px, roll)
            self._step(progress, "centering", 3)
            for attempt in range(CENTER_TRIES):
                delta = pixel_to_board(spot.dx, spot.dy, mm_per_px, roll)
                if math.hypot(*delta) <= CENTER_TOLERANCE:
                    break
                head = access.head_point(status)
                status = self._move_to(access, status, (head[0] + delta[0], head[1] + delta[1]), restarts)
                spot = self._spot(progress, mm_per_px, roll)
                progress.done = 3 + attempt
            # The picture's center is the head plus the offset, and the mark
            # is the center plus what is left of the spot's distance.
            head = access.head_point(status)
            delta = pixel_to_board(spot.dx, spot.dy, mm_per_px, roll)
            found = (mark[0] - head[0] - delta[0], mark[1] - head[1] - delta[1])
            self.update({"offset": found, "roll": roll, "mm_per_px": mm_per_px})
            self._step(progress, "done", progress.total)
            progress.state = DONE
            self._message(
                "info",
                f"camera offset measured: X {found[0]:+.3f} Y {found[1]:+.3f} mm from the tool,"
                f" {mm_per_px * 1000.0:.1f} um per pixel, roll {roll:+.2f} degrees",
            )
        except (LinkError, VisionError, CameraError, ValueError) as exc:
            if self._abort.is_set():
                progress.state = STOPPED
                progress.error = "stopped"
                self._halt(link)
            else:
                progress.state = ERROR
                progress.error = str(exc)
                self._message("error", f"finding the mark failed: {exc}")
        except Exception as exc:
            progress.state = ERROR
            progress.error = repr(exc)
            self._message("error", f"finding the mark failed: {exc!r}")
        finally:
            self._publish()

    def _step(self, progress: RoutineProgress, step: str, done: int) -> None:
        progress.step = step
        progress.done = done
        self._publish()

    def _spot(self, progress: RoutineProgress, mm_per_px: float, roll: float) -> Spot:
        if self._abort.is_set():
            raise CameraError("stopped")
        reply = self.client.spot()
        if not reply.get("found"):
            raise CameraError("no mark in the picture: jog the camera over the mark by hand and find again")
        spot = Spot(dx=float(reply.get("dx", 0.0)), dy=float(reply.get("dy", 0.0)))
        if mm_per_px > 0.0:
            spot.mm = math.hypot(*pixel_to_board(spot.dx, spot.dy, mm_per_px, roll))
        progress.spot = spot
        self._publish()
        return spot

    def _line(self, link: Link, line: str) -> None:
        if self._abort.is_set():
            raise CameraError("stopped")
        link.request_ok(line)

    def _move_to(self, access: MachineAccess, status, point: Point, restarts: int):
        """The tool to a board point at the height it has; the status at rest there."""
        streamer = access.streamer
        start = streamer.start_of(status)
        seconds = 0.0
        for joint, _ in streamer.board_targets(start, point):
            self._line(access.link, f"go {streamer.words(joint)}")
            seconds += streamer._rapid_seconds(start, joint)
            start = joint
        return self._settle(access.link, restarts, seconds)

    def _settle(self, link: Link, restarts: int, seconds: float):
        """Waits for the machine to come to rest after a move, as probing
        does; a hold extends the wait."""
        allowed = seconds + MOVE_TIMEOUT
        deadline = time.monotonic() + allowed
        while True:
            if self._abort.is_set():
                raise CameraError("stopped")
            status = link.status_now(1.0, routine=True)
            if link.restarts != restarts:
                raise CameraError("the machine reset during the routine")
            if status.state == "Idle":
                return status
            if status.state == "Alarm":
                raise CameraError(f"the machine raised an alarm: {status.raw}")
            if status.state == "Hold":
                deadline = time.monotonic() + allowed
            if time.monotonic() > deadline:
                raise CameraError(f"the head did not come to rest: {status.raw}")
            time.sleep(SETTLE_POLL)

    def _halt(self, link: Link) -> None:
        from .runner import halt

        try:
            if link.is_open:
                halt(link, self._message)
        except LinkError:
            pass


def pose_summary(raw: dict) -> dict:
    """The pose fields the page shows, from pcbv's reply."""
    state = raw.get("state", "none")
    summary: dict = {
        "state": state,
        "spots": raw.get("spots"),
        "fps": raw.get("fps"),
        "age_ms": raw.get("age_ms"),
        "job_center": None,
    }
    if state == "locked":
        for key in ("center", "angle_deg", "mm_per_px", "inliers", "expected", "rms_mm"):
            summary[key] = raw.get(key)
    return summary
