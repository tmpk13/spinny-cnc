"""The pick and place device's top camera: fixed to its head beside the
nozzle and looking down, through pcb-vision like the other cameras.

Every place on the device is the head's with the nozzle's tip (turned to
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
import threading
from dataclasses import dataclass
from typing import Callable

from pydantic import BaseModel, ConfigDict

from spinny_laser import machines as machine_files

from .camera import CAPTURE_KEYS, DONE, ERROR, STOPPED, Spot, picture_to_machine
from .log import log
from .openpnp import SHADES
from .pnp import Mover, PnpError, RoutineProgress, calibrate
from .vision import VisionClient, VisionError

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


@dataclass
class Found:
    """A fiducial found: its reference, its place in the job and where it
    is on the device."""

    ref: str
    job: Point
    seen: Point


class TopCameraSettings(BaseModel):
    """What the backend keeps of the top camera, beside the device's state."""

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

    def check(self) -> None:
        if not self.device.strip():
            raise ValueError("the top camera device must be named")
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


class TopCamera:
    """The top camera's settings and state, pcbv behind them, the routines,
    and the look the device's run uses. `store` gives the dict its
    settings live in (the device's part of the backend's config)."""

    def __init__(self, store: Callable[[], dict], save: Callable[[], None], publish: Callable[[], None], message: Callable[[str, str], None]) -> None:
        self._store = store
        self._save = save
        self._publish = publish
        self._message = message
        self.client = VisionClient()
        self.camlog = None
        self._looks = 0
        self.progress: RoutineProgress | None = None
        # The last fiducials found: the job, each one's places, the fit's rms.
        self.fiducials: dict | None = None
        self._thread: threading.Thread | None = None
        self._abort = threading.Event()
        self._lock = threading.Lock()

    # --- settings -------------------------------------------------------------

    def settings(self) -> TopCameraSettings:
        try:
            settings = TopCameraSettings.model_validate(self._store().get("top", {}))
            settings.check()
            return settings
        except ValueError:
            return TopCameraSettings()

    def update(self, patch: dict, clear: tuple[str, ...] = ()) -> TopCameraSettings:
        """Keeps new settings, the whole set checked first; `clear` names the
        ones (mark_at, offset) to take back to none. A running camera given
        another device, size, rate or program starts again on them."""
        before = self.settings()
        merged = {**before.model_dump(), **{key: value for key, value in patch.items() if value is not None}}
        for key in clear:
            if key in ("mark_at", "offset"):
                merged[key] = None
        for key in ("mark_at", "offset"):
            if isinstance(merged.get(key), (list, tuple)):
                merged[key] = tuple(float(v) for v in merged[key])
        settings = TopCameraSettings.model_validate(merged)
        settings.check()
        restart = self.client.running and any(getattr(settings, key) != getattr(before, key) for key in CAPTURE_KEYS)
        if restart and self.routine_active:
            raise PnpError("the top camera routine is under way: abort it first")
        self._store()["top"] = settings.model_dump()
        self._save()
        if restart:
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
            raise PnpError("the top camera is already running")
        settings = self.settings()
        self.client.start(settings.device, settings.size, settings.fps, settings.pcbv)
        log.info("top camera started on %s", settings.device)

    def stop(self) -> None:
        if self.routine_active:
            raise PnpError("the top camera routine is under way: abort it first")
        self.client.close()

    def frame(self, width: int, overlay: bool) -> bytes:
        if not self.client.running:
            raise PnpError("the top camera is not running")
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
                    log.warning("top camera: %s", exc)
        progress = self.progress
        dump = settings.model_dump()
        for key in ("mark_at", "offset"):
            dump[key] = list(dump[key]) if dump[key] is not None else None
        return {
            "running": self.client.running,
            **dump,
            "frame": frame,
            "routine": progress.to_dict() if progress is not None else None,
            "fiducials": self.fiducials,
        }

    def shutdown(self) -> None:
        self._abort.set()
        try:
            self.client.close()
        except Exception:
            pass

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
            area = math.pi * diameter * diameter / 4.0 / (scale * scale)
            limits = {"min_area": area * 0.3, "max_area": area * 3.0}
        seen: Point | None = None
        for _ in range(1 + (LOOK_TRIES if center else 0)):
            if mover.stopped():
                raise PnpError("stopped")
            reply = self.client.spot(radius=within / scale, polarity=shade, **limits)
            self._log_look(routine, step, reply, shade)
            if not reply.get("found"):
                return None
            off = picture_to_machine(float(reply.get("dx", 0.0)), float(reply.get("dy", 0.0)), scale, settings.roll, settings.mirror)
            if progress is not None:
                progress.spot = Spot(dx=float(reply.get("dx", 0.0)), dy=float(reply.get("dy", 0.0)), mm=math.hypot(*off))
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
        where `guess` puts it on the device, centered in the picture; a
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
        measured."""
        if not (math.isfinite(step) and 0.0 <= step <= MAX_STEP):
            raise ValueError(f"the step must be 0 to {MAX_STEP:g} mm")
        if self.settings().mark_at is None:
            raise ValueError("put the nozzle's tip over a mark and press Nozzle on mark first")
        self._begin("offset", OFFSET_STEPS, mover, lambda progress: self._offset(mover, progress, step, z, guess))

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
        was found, keeps it and answers the line to say of it."""
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

    def abort(self) -> None:
        if not self.routine_active:
            raise PnpError("no top camera routine is under way")
        self._abort.set()

    def _begin(self, kind: str, steps: tuple[str, ...], mover: Mover, body: Callable[[RoutineProgress], None]) -> None:
        mover.check()
        if not self.client.running:
            raise ValueError("the top camera is not running: start it first")
        with self._lock:
            if self.routine_active:
                raise PnpError("a top camera routine is already under way")
            self._abort.clear()
            self._looks = 0
            self.progress = RoutineProgress(kind=kind, steps=steps, step=steps[0], target=mover.name)
            progress = self.progress
            self._thread = threading.Thread(target=self._run, args=(mover, progress, body), name=f"top-{kind}", daemon=True)
            self._thread.start()
        self._publish()

    def _run(self, mover: Mover, progress: RoutineProgress, body: Callable[[RoutineProgress], None]) -> None:
        what = "measuring the top camera's offset" if progress.kind == "offset" else "finding the fiducials"
        try:
            body(progress)
            self._step(progress, "done")
            progress.state = DONE
        except (VisionError, PnpError, ValueError) as exc:
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
        self.update({"offset": offset, "mm_per_px": scale, "roll": roll, "mirror": mirror})
        self._message(
            "info",
            f"the top camera looks from X {offset[0]:+.3f} Y {offset[1]:+.3f} mm off the nozzle,"
            f" {scale * 1000.0:.1f} um per pixel, roll {roll:+.2f} degrees{', mirrored' if mirror else ''}",
        )

    def _spot(self, mover: Mover, progress: RoutineProgress, shade: str, scale: float, roll: float, mirror: bool, missing: str) -> Spot:
        if mover.stopped():
            raise PnpError("stopped")
        reply = self.client.spot(polarity=shade)
        self._log_look("measuring the top camera's offset", progress.step, reply, shade)
        if not reply.get("found"):
            raise PnpError(missing)
        spot = Spot(dx=float(reply.get("dx", 0.0)), dy=float(reply.get("dy", 0.0)))
        if scale > 0.0:
            spot.mm = math.hypot(*picture_to_machine(spot.dx, spot.dy, scale, roll, mirror))
        progress.spot = spot
        self._publish()
        return spot

    def _step(self, progress: RoutineProgress | None, step: str) -> None:
        if progress is None:
            return
        progress.step = step
        self._publish()

    def _log_look(self, routine: str, step: str, reply: dict, shade: str) -> None:
        if self.camlog is None:
            return
        self._looks += 1
        self.camlog.look(self.client, "top", routine, step, spot=reply, note=f"{shade} spot, look {self._looks}")
