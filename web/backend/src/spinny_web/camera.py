"""A camera on the head: its settings, its picture and pose through
pcb-vision, and the routine that measures where it looks from the tool;
and what every camera's routines share: a routine's states, a spot seen,
a point in the picture taken to the machine, and the machine's part in a
routine.

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

from pydantic import BaseModel, ConfigDict, Field

from spinny_laser import machines as machine_files

from .cameras import apply_kept, check_controls
from .kinematics import FOCUS_DECIMALS, coord
from .link import Link, LinkError, idle_status, settle
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
# The settings pcbv captures with: a running camera given others starts again.
CAPTURE_KEYS = ("device", "size", "fps", "pcbv")
# How long after the head comes to rest a picture is trusted, s. A USB
# camera's frame reaches pcbv a frame or two after its exposure began, and
# the machine shakes a little once a move ends, so the newest frame read at
# once after a move's wait can show the head still moving, or where it
# was: a look waits for a frame captured this long after it began.
SETTLE_SECONDS = 0.25
# How long a look waits for such a frame before it gives up, s.
FRESH_SECONDS = 3.0
# The fields of pcbv's spot reply that tell its place and shape, kept so a
# page can draw what was found.
SHAPE_KEYS = ("x", "y", "area", "major", "minor", "angle", "contrast")


class CameraError(Exception):
    """The camera, or its routine, is in the wrong state for the request."""


# A camera's look for a board (boardlook.py), unless set from the page: the
# least share of the evidence the most likely guess must hold to call the
# board found, and how far a guess may put a corner taken by hand from
# where it was taken, mm.
LOOK_THRESHOLD = 0.5
CORNER_MM = 2.0


def check_look(threshold: float, corner_mm: float) -> None:
    """A camera's look settings, as the page may set them."""
    if not (math.isfinite(threshold) and 0.0 <= threshold <= 1.0):
        raise ValueError("the look's threshold must be 0 to 1")
    if not (math.isfinite(corner_mm) and 0.1 <= corner_mm <= 50.0):
        raise ValueError("the corners' tolerance must be 0.1 to 50 mm")


class CameraSettings(BaseModel):
    """What the backend keeps of the camera, in config.json's `camera`: a
    machine file's `[camera]` is laid over it when that file is loaded."""

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
    # V4L2 control values (exposure, gain, focus, ...) set on the device
    # each time the camera starts, by the names v4l2-ctl gives them.
    controls: dict[str, int] = Field(default_factory=dict)
    # The look for a board: the threshold of the most likely guess, and
    # the corners' tolerance (mm).
    look_threshold: float = LOOK_THRESHOLD
    corner_mm: float = CORNER_MM

    def check(self) -> None:
        if not self.device.strip():
            raise ValueError("the camera device must be named")
        check_controls(self.controls)
        check_look(self.look_threshold, self.corner_mm)
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


@dataclass
class Spot:
    dx: float
    dy: float
    mm: float = 0.0
    # The rest of pcbv's reply: where in the full size picture (x, y), its
    # area, its equivalent ellipse (major, minor, angle), its contrast and
    # the rectangle around it (rect), as far as pcbv said them.
    shape: dict | None = None
    # How far from the picture's center the spot was looked for, px of the
    # full size picture; None for pcbv's own reach (a third of the height).
    radius: float | None = None

    def to_dict(self) -> dict:
        return {
            "dx": round(self.dx, 2),
            "dy": round(self.dy, 2),
            "mm": round(self.mm, 4),
            **(self.shape or {}),
            "radius": round(self.radius, 1) if self.radius is not None else None,
        }


def spot_of(reply: dict, radius: float | None = None) -> Spot:
    """A spot pcbv found, with its shape for the page to draw."""
    shape = {key: round(float(reply[key]), 2) for key in SHAPE_KEYS if isinstance(reply.get(key), (int, float)) and not isinstance(reply.get(key), bool)}
    rect = reply.get("rect")
    if isinstance(rect, dict) and all(isinstance(rect.get(key), (int, float)) for key in ("length", "width", "angle")):
        shape["rect"] = {key: round(float(rect[key]), 2) for key in ("length", "width", "angle")}
    return Spot(dx=float(reply.get("dx", 0.0)), dy=float(reply.get("dy", 0.0)), shape=shape or None, radius=radius)


def look_dict(reply: dict, polarity: str, radius: float | None = None) -> dict:
    """A look taken by hand, as the page draws it: what was asked for and
    what was found (its place and shape), or found false."""
    found = bool(reply.get("found"))
    out: dict = {"found": found, "polarity": polarity, "radius": round(radius, 1) if radius is not None else None}
    if found:
        out.update({key: value for key, value in spot_of(reply, radius).to_dict().items() if key not in ("mm", "radius")})
    return out


def wait_settled(client: VisionClient, since: float | None = None) -> None:
    """Waits until pcbv's newest frame was captured SETTLE_SECONDS after
    `since` (time.monotonic(), now by default), so a look after a move sees
    the head at rest; refuses a camera whose pictures stop coming. pcbv
    says how old its frame is (`age_ms`), from which its capture is told on
    this clock: a reply that took long only makes the frame seem older."""
    settle = SETTLE_SECONDS
    if settle <= 0.0:
        return
    wanted = (time.monotonic() if since is None else since) + settle
    deadline = wanted + FRESH_SECONDS
    while True:
        now = time.monotonic()
        if now < wanted:
            time.sleep(wanted - now)
            continue
        try:
            raw = client.pose()
        except VisionError as exc:
            if "no frame" not in str(exc):
                raise
            raw = {}
        age = raw.get("age_ms")
        if not isinstance(age, (int, float)) and raw:
            # A pcbv that tells no age: the settle time alone.
            return
        if isinstance(age, (int, float)) and time.monotonic() - float(age) / 1000.0 >= wanted:
            return
        if time.monotonic() > deadline:
            raise VisionError(f"the camera gave no picture taken after the head came to rest within {FRESH_SECONDS:g} s")
        time.sleep(0.03)


@dataclass
class RoutineProgress:
    state: str = RUNNING
    step: str = STEPS[0]
    done: int = 0
    total: int = 6
    error: str | None = None
    spot: Spot | None = None
    started: float = field(default_factory=time.monotonic, repr=False)
    # Which routine: `find` (the mark) or `search` (the board).
    kind: str = "find"

    def to_dict(self) -> dict:
        return {
            "kind": self.kind,
            "state": self.state,
            "step": self.step,
            "done": self.done,
            "total": self.total,
            "error": self.error,
            "spot": self.spot.to_dict() if self.spot is not None else None,
            "seconds": round(time.monotonic() - self.started, 1),
        }


def picture_to_machine(dx: float, dy: float, mm_per_px: float, roll: float, mirror: bool = False) -> Point:
    """A point seen `dx`, `dy` px from the picture's center (right and down
    positive) as a displacement from the point seen at the center, mm in
    the frame the camera's roll is measured against (the board's for the
    head camera, the machine's for the others): the picture's y turned
    over, its x as well when the picture is mirrored, then turned by the
    roll and scaled."""
    u, v = (-dx if mirror else dx), -dy
    radians = math.radians(roll)
    c, s = math.cos(radians), math.sin(radians)
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
    """What a camera's routine needs of this machine: the link, the
    streamer for its frame, the height the head rises to before it moves,
    whether there is a focus axis, and, for the head camera's routine,
    where the tool is on the board for a status."""

    link: Link
    streamer: object
    lift: float
    has_focus_axis: bool
    head_point: Callable[[object], Point] | None = None


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
        # Where every look the routine takes is kept while logging is on;
        # the backend sets it.
        self.camlog = None
        self._looks = 0
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
        """Keeps new settings; the whole set is checked first. A running
        camera given another device, size, rate or program starts again on
        them, looking for the board it looked for."""
        before = self.settings()
        merged = {**before.model_dump(), **{key: value for key, value in patch.items() if value is not None}}
        if isinstance(merged["offset"], (list, tuple)):
            merged["offset"] = tuple(float(v) for v in merged["offset"])
        settings = CameraSettings.model_validate(merged)
        settings.check()
        restart = self.client.running and any(getattr(settings, key) != getattr(before, key) for key in CAPTURE_KEYS)
        if restart and self.routine_active:
            raise CameraError("the camera is finding the mark: abort that first")
        self.config["camera"] = settings.model_dump()
        self._save()
        if restart:
            self._restart()
        return settings

    def _restart(self) -> None:
        """Stops pcbv and starts it on the settings; a start that fails
        leaves the camera stopped and says why."""
        job, path = self.board_job, self._board_path
        self.client.close()
        self.board_job = None
        self._board_path = None
        self.start()
        if job is not None and path is not None:
            self.load_board(job, path)

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
        refused = apply_kept(settings.device, settings.controls)
        if refused:
            self._message("error", f"the camera's controls were not all set: {refused}")

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
            self._looks = 0
            self.progress = RoutineProgress()
            progress = self.progress
            self._thread = threading.Thread(target=self._find, args=(access, mark, step, progress), name="camera-find", daemon=True)
            self._thread.start()
        self._publish()

    def abort(self) -> None:
        if not self.routine_active:
            raise CameraError("the camera has no routine under way")
        self._abort.set()

    def aborting(self) -> bool:
        return self._abort.is_set()

    def run_routine(self, kind: str, total: int, what: str, link: Link, body: Callable[[RoutineProgress], None]) -> None:
        """Starts a routine of the camera's besides the find (the board
        search) on the routine's thread; `what` names it when it fails,
        `total` is its count of steps. The caller has checked that nothing
        else owns the machine."""
        if not self.client.running:
            raise ValueError("the camera is not running: start it first")
        with self._lock:
            if self.routine_active:
                raise CameraError("a camera routine is already under way")
            self._abort.clear()
            self._looks = 0
            self.progress = RoutineProgress(step="lifting", total=total, kind=kind)
            progress = self.progress
            self._thread = threading.Thread(target=self._run_routine, args=(body, progress, what, link), name=f"camera-{kind}", daemon=True)
            self._thread.start()
        self._publish()

    def _run_routine(self, body: Callable[[RoutineProgress], None], progress: RoutineProgress, what: str, link: Link) -> None:
        try:
            body(progress)
            self._step(progress, "done", progress.total)
            progress.state = DONE
        except (LinkError, VisionError, CameraError, ValueError) as exc:
            if self._abort.is_set():
                progress.state = STOPPED
                progress.error = "stopped"
                self._halt(link)
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

    def _find(self, access: MachineAccess, mark: Point, step: float, progress: RoutineProgress) -> None:
        link = access.link
        restarts = link.restarts
        settings = self.settings()
        try:
            head_point = access.head_point
            assert head_point is not None, "the find routine reads the tool's board point"
            status = idle_status(link, CameraError)
            # Up to the travel height, so the move to the mark clears the board.
            self._step(progress, "lifting", 0)
            if access.has_focus_axis and status.h is not None and status.h < access.lift - 1e-6:
                self._line(link, f"go H{coord(access.lift, FOCUS_DECIMALS)}")
                status = self._settle(link, restarts, abs(access.lift - status.h) / 100.0 * 60.0)
            # Where the camera should see the mark: the mark less the offset in force.
            self._step(progress, "moving", 1)
            offset = settings.offset
            status = self._move_to(access, status, (mark[0] - offset[0], mark[1] - offset[1]), restarts)
            spot = self._spot(progress, settings.mm_per_px, settings.roll)
            mm_per_px, roll = settings.mm_per_px, settings.roll
            if step > 0.0 or mm_per_px <= 0.0:
                self._step(progress, "scale", 2)
                move = step if step > 0.0 else DEFAULT_STEP
                head = head_point(status)
                status = self._move_to(access, status, (head[0] + move, head[1]), restarts)
                after = self._spot(progress, mm_per_px, roll)
                mm_per_px, roll = scale_from_shift((spot.dx, spot.dy), (after.dx, after.dy), move)
                status = self._move_to(access, status, head, restarts)
                spot = self._spot(progress, mm_per_px, roll)
            self._step(progress, "centering", 3)
            for attempt in range(CENTER_TRIES):
                delta = picture_to_machine(spot.dx, spot.dy, mm_per_px, roll)
                if math.hypot(*delta) <= CENTER_TOLERANCE:
                    break
                head = head_point(status)
                status = self._move_to(access, status, (head[0] + delta[0], head[1] + delta[1]), restarts)
                spot = self._spot(progress, mm_per_px, roll)
                progress.done = 3 + attempt
            # The picture's center is the head plus the offset, and the mark
            # is the center plus what is left of the spot's distance.
            head = head_point(status)
            delta = picture_to_machine(spot.dx, spot.dy, mm_per_px, roll)
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
        wait_settled(self.client)
        reply = self.client.spot()
        if self.camlog is not None:
            # Kept before a miss is refused: a look that found nothing is
            # the one to see.
            self._looks += 1
            self.camlog.look(self.client, "head", "finding the mark", progress.step, spot=reply, note=f"look {self._looks}", pose=self.board_job is not None)
        if not reply.get("found"):
            raise CameraError("no mark in the picture: jog the camera over the mark by hand and find again")
        spot = spot_of(reply)
        if mm_per_px > 0.0:
            spot.mm = math.hypot(*picture_to_machine(spot.dx, spot.dy, mm_per_px, roll))
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
        return settle(link, seconds, restarts, self._abort.is_set, CameraError, "the routine")

    def _halt(self, link: Link) -> None:
        from .runner import halt

        if link.is_open:
            halt(link, self._message)


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
