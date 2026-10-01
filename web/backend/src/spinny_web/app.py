"""The HTTP and WebSocket API, and the static frontend.

Routes are plain functions so the blocking link calls run in the thread
pool. Events from the link and the runner reach the WebSocket clients
through a broadcast with one queue per client; a client that cannot keep
up loses events rather than slowing the others.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import re
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Callable

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict

from . import __version__, center
from .heightmap import AUTO, FOCUS, MODES, OFF, POWER, Compensation, Grid, HeightMap, HeightMapStore, check_covers
from .jobs import ImportOptions, Job, JobImportError, JobPatch, JobStore, apply_patch, import_file
from .kinematics import (
    DEFAULT_TOLERANCE,
    CartesianStreamer,
    Rates,
    Spindle,
    Streamer,
    check_feed,
    head_board,
    num,
)
from .link import (
    check_url,
    CommandError,
    Event,
    Link,
    LinkError,
    MAX_LINE,
    REALTIME_HOLD,
    REALTIME_JOG_CANCEL,
    REALTIME_RESUME,
    REALTIME_STATUS,
)
from .prober import Prober, ProberError, ProbeSettings
from .runner import HOLD, RUNNING, Runner, RunnerError, halt

BACKEND_ROOT = Path(__file__).resolve().parents[2]
FRONTEND_DIST = BACKEND_ROOT.parent / "frontend" / "dist"
SETTINGS_CACHE_SECONDS = 1.0
# The widest chord tolerance a run may be planned with: past this a board
# line is streamed as one joint line, which is an arc on the board.
MAX_TOLERANCE = 10.0
# The largest file an upload may be; a board, a drawing or a gcode file is
# well under it, and the whole of it is held in memory while it is read.
MAX_UPLOAD_BYTES = 64 * 1024 * 1024
CLIENT_QUEUE = 256
# The largest values the firmware's settings take: a float one, and a
# whole number one (u32). One past its bound is refused before anything of
# the same write is sent.
SETTING_MAX = 1.0e7
INT_SETTING_MAX = 2**32 - 1
# How long the output-off line may take on the way out of a connection
# before the reset byte stops the output instead, s.
OUTPUT_OFF_WAIT = 1.0
# Settings that change what a position means: the height map's heights
# and board points were measured under the ones in force then.
FRAME_SETTINGS = frozenset({"r_steps", "a_steps", "z_steps", "h_steps", "dir_invert", "cartesian", "h_axis"})

SETTINGS_SCHEMA = [
    {"name": "r_steps", "unit": "steps/mm", "help": "radius motor"},
    {"name": "a_steps", "unit": "steps/deg", "help": "table motor: 200 steps * tmc_a_micro microsteps * 100:1 / 360"},
    {"name": "r_rate", "unit": "mm/min", "help": "max radius rate"},
    {"name": "a_rate", "unit": "deg/min", "help": "max table rate"},
    {"name": "r_accel", "unit": "mm/s^2", "help": "radius acceleration"},
    {"name": "a_accel", "unit": "deg/s^2", "help": "table acceleration"},
    {"name": "r_jerk", "unit": "mm/s", "help": "allowed speed change at a corner"},
    {"name": "a_jerk", "unit": "deg/s", "help": "allowed speed change at a corner"},
    {"name": "r_max", "unit": "mm", "help": "soft limit, 0 = off"},
    {"name": "z_steps", "unit": "steps/mm", "help": "cross slide motor"},
    {"name": "z_rate", "unit": "mm/min", "help": "max cross slide rate"},
    {"name": "z_accel", "unit": "mm/s^2", "help": "cross slide acceleration"},
    {"name": "jog_z", "unit": "mm/min", "help": "jog rate without F"},
    {"name": "jog_r", "unit": "mm/min", "help": "jog rate without F"},
    {"name": "jog_a", "unit": "deg/min", "help": "jog rate without F"},
    {"name": "dir_invert", "unit": "mask", "help": "bit 0 radius, bit 1 table, bit 2 cross slide, bit 3 focus axis"},
    {"name": "en_invert", "unit": "0/1", "help": "1 = enable pin active high"},
    {"name": "idle_ms", "unit": "ms", "help": "disable motors after idle, 0 = never"},
    {"name": "step_us", "unit": "us", "help": "step pulse width"},
    {"name": "laser_hz", "unit": "Hz", "help": "PWM frequency"},
    {"name": "s_max", "unit": "", "help": "S for full duty"},
    {"name": "s_min", "unit": "", "help": "dyn mode: below this the beam is off"},
    {"name": "laser_invert", "unit": "0/1", "help": "1 = active low output"},
    {"name": "laser_ms", "unit": "ms", "help": "default T for laser"},
    {"name": "tmc_r_ma", "unit": "mA", "help": "run current, 0 leaves the driver untouched"},
    {"name": "tmc_a_ma", "unit": "mA", "help": "run current, 0 leaves the driver untouched"},
    {"name": "tmc_hold_pct", "unit": "%", "help": "hold current as a share of run"},
    {"name": "tmc_r_micro", "unit": "", "help": "microsteps"},
    {"name": "tmc_a_micro", "unit": "", "help": "microsteps"},
    {"name": "tmc_z_ma", "unit": "mA", "help": "cross slide run current"},
    {"name": "tmc_z_micro", "unit": "", "help": "microsteps"},
    {"name": "tmc_stealth", "unit": "0/1", "help": "stealthChop, else spreadCycle"},
    {"name": "h_axis", "unit": "0/1", "help": "1 = a focus axis is fitted, on the E socket"},
    {"name": "h_steps", "unit": "steps/mm", "help": "focus axis motor"},
    {"name": "h_rate", "unit": "mm/min", "help": "max focus axis rate"},
    {"name": "h_accel", "unit": "mm/s^2", "help": "focus axis acceleration"},
    {"name": "h_jerk", "unit": "mm/s", "help": "allowed speed change at a corner"},
    {"name": "jog_h", "unit": "mm/min", "help": "jog and probe rate without F"},
    {"name": "probe_invert", "unit": "0/1", "help": "1 = probe input active high"},
    {"name": "tmc_h_ma", "unit": "mA", "help": "focus axis run current"},
    {"name": "tmc_h_micro", "unit": "", "help": "microsteps"},
    {"name": "probe_ms", "unit": "ms", "help": "motion queued during a probe, 0 to 160; 0 stops dead within h_jerk"},
    {"name": "z_jerk", "unit": "mm/s", "help": "cross slide: allowed speed change at a corner, as a joint"},
    {"name": "z_max", "unit": "mm", "help": "cross slide soft limit either side of zero, 0 = off"},
    {"name": "cartesian", "unit": "0/1", "help": "1 = X/Y machine: the rail is X, the cross slide Y, the table holds"},
    {"name": "spindle", "unit": "0/1", "help": "1 = the laser output drives a spindle, the focus axis is its depth"},
]

POLAR, CARTESIAN = "polar", "cartesian"
LASER, SPINDLE = "laser", "spindle"

NO_FRONTEND = """<!doctype html>
<html><head><meta charset="utf-8"><title>spinny</title></head>
<body style="font-family: sans-serif; margin: 2em">
<h1>spinny-web</h1>
<p>The frontend is not built. Run the build in <code>web/frontend</code>,
then restart the backend; the API is up at <code>/api</code>.</p>
</body></html>
"""


# --- request bodies -----------------------------------------------------------


class ConnectBody(BaseModel):
    url: str


class Finite(BaseModel):
    """A body whose numbers are numbers: NaN and infinity are refused."""

    model_config = ConfigDict(allow_inf_nan=False)


class JogBody(Finite):
    kind: str = "joint"
    dr: float | None = None
    da: float | None = None
    # The cross slide: on its own on a polar machine, a joint beside the
    # others on a cartesian one.
    dz: float | None = None
    # The focus axis, which may move with the joints.
    dh: float | None = None
    dx: float | None = None
    dy: float | None = None
    feed: float | None = None


class GotoBody(Finite):
    kind: str = "joint"
    r: float | None = None
    a: float | None = None
    z: float | None = None
    h: float | None = None
    x: float | None = None
    y: float | None = None
    feed: float | None = None


class PositionBody(Finite):
    r: float | None = None
    a: float | None = None
    z: float | None = None
    h: float | None = None


class MotorsBody(BaseModel):
    enabled: bool


class RealtimeBody(BaseModel):
    action: str


class CommandBody(BaseModel):
    line: str


class LaserBody(Finite):
    power: float
    ms: int | None = None


class SpindleBody(Finite):
    power: float


class ModeBody(BaseModel):
    mode: str


class SettingsBody(BaseModel):
    values: dict[str, Any] | None = None
    host: dict[str, Any] | None = None


class RunBody(BaseModel):
    # How the run follows the board's height: off, auto (the focus axis
    # when one is fitted, else power), focus or power.
    compensate: str = OFF


class FocusBody(Finite):
    # Focus height minus contact height; left out, it is taken from where
    # the head is now, over a probed point with the beam in focus.
    offset: float | None = None


class ProbeConfigBody(Finite):
    depth: float | None = None
    feed: float | None = None
    slow: float | None = None
    backoff: float | None = None
    offset: tuple[float, float] | None = None
    rayleigh: float | None = None


# --- fan-out ------------------------------------------------------------------


class Broadcast:
    """One asyncio queue per WebSocket client; slow clients drop events."""

    def __init__(self) -> None:
        self.loop: asyncio.AbstractEventLoop | None = None
        self._queues: set[asyncio.Queue] = set()
        self.dropped = 0

    def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=CLIENT_QUEUE)
        self._queues.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self._queues.discard(queue)

    @property
    def clients(self) -> int:
        return len(self._queues)

    def publish(self, event: dict) -> None:
        for queue in list(self._queues):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                self.dropped += 1

    def publish_threadsafe(self, event: dict) -> None:
        loop = self.loop
        if loop is None or loop.is_closed():
            return
        try:
            loop.call_soon_threadsafe(self.publish, event)
        except RuntimeError:
            pass


# --- the backend --------------------------------------------------------------


class Backend:
    def __init__(
        self,
        root: Path = BACKEND_ROOT,
        link_factory: Callable[[str], Link] | None = None,
        jobs_dir: Path | None = None,
        config_path: Path | None = None,
        heightmap_path: Path | None = None,
    ) -> None:
        self.root = root
        self.config_path = config_path or root / "config.json"
        self.config = self._load_config()
        self.store = JobStore(jobs_dir if jobs_dir is not None else root / "jobs")
        self.heightmaps = HeightMapStore(heightmap_path or self.config_path.parent / "heightmap.json")
        self.link_factory = link_factory or (lambda url: Link(url))
        self.link: Link | None = None
        self.url: str | None = self.config.get("last_url")
        self.broadcast = Broadcast()
        self.runner = Runner(publish=self._publish_progress, message=self.publish_message)
        self.prober = Prober(self.heightmaps, publish=self._publish_probe, message=self.publish_message)
        self.rates = Rates()
        # What the machine is, from its settings: polar or cartesian, laser
        # or spindle. A laser on the polar machine until the first read.
        self.profile = profile_of({})
        self._settings_cache: tuple[float, dict] | None = None
        self._lock = threading.Lock()
        # One move request at a time: each plans from the end of the last,
        # and two in flight at once would both start from the same place.
        self._move_lock = threading.Lock()
        # Where the jog in progress ends, so the next board move starts from
        # there rather than from a position the machine has already left.
        self._jog_target: tuple[float, float] | None = None
        # A run and probing each claim the whole machine: the check that
        # the other is not under way and the claim are made under this, so
        # two starts that overlap cannot both pass. Taken before
        # `_move_lock` where both are held.
        self._owner_lock = threading.Lock()
        # The height map's read, change and write, one at a time.
        self._map_lock = threading.Lock()
        # Resets the firmware has announced on this link (`[MSG:reset]`
        # comes before the banner of a reset byte), and the restarts
        # without one already acted on; None until the link is open. A
        # banner with no reset before it is a machine that started over,
        # its focus axis at zero wherever the head was.
        self._soft_resets = 0
        self._restarts_seen: int | None = None
        # The focus axis frame, counted up whenever it may have changed, and
        # the frame the stored map's heights were probed in (None for a map
        # from before). Focus here ties heights from another frame to this
        # one through the offset, so an offset given as a number holds only
        # for heights probed in this frame, and only then does probing
        # again keep the offset.
        self._frame = 0
        self._heights_frame: int | None = None
        # The frame the focus offset was set in. Every frame change takes
        # the offset back as it happens, but probing writes its own copy of
        # the map as it goes: one made just before a restart it had not yet
        # seen would bring an offset from the old frame back.
        self._focus_frame: int | None = None

    # --- config -------------------------------------------------------------

    def _load_config(self) -> dict:
        try:
            data = json.loads(self.config_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
        if not isinstance(data, dict):
            data = {}
        data.setdefault("tolerance", DEFAULT_TOLERANCE)
        return data

    def _save_config(self) -> None:
        try:
            text = json.dumps(self.config, indent=4, allow_nan=False)
            self.config_path.write_text(text + "\n", encoding="utf-8")
        except (OSError, ValueError) as exc:
            # The value is in force for this process; say that it will not
            # outlive it rather than lose it in silence.
            self.publish_message("error", f"could not save {self.config_path}: {exc}")

    @property
    def tolerance(self) -> float:
        try:
            return _tolerance(self.config.get("tolerance", DEFAULT_TOLERANCE))
        except ValueError:
            return DEFAULT_TOLERANCE

    def spindle_config(self) -> Spindle:
        """The host's milling settings, the defaults for any that do not hold."""
        try:
            return Spindle(
                clearance=float(self.config.get("clearance", Spindle.clearance)),
                spinup=float(self.config.get("spinup", Spindle.spinup)),
            )
        except (TypeError, ValueError):
            return Spindle()

    def host_settings(self) -> dict:
        spindle = self.spindle_config()
        return {"tolerance": self.tolerance, "clearance": spindle.clearance, "spinup": spindle.spinup}

    @property
    def cartesian(self) -> bool:
        return self.profile["kinematics"] == CARTESIAN

    @property
    def milling(self) -> bool:
        return self.profile["tool"] == SPINDLE

    def streamer(self, status=None) -> Streamer:
        """The streamer for the machine as its settings were last read. A
        cartesian one works in the frame of the table angle in `status`, or
        in the last status polled."""
        spindle = self.spindle_config() if self.milling else None
        if self.cartesian:
            if status is None and self.link is not None and self.link.is_open:
                status = self.link.status
            angle = status.a if status is not None else 0.0
            return CartesianStreamer(angle=angle, tolerance=self.tolerance, rates=self.rates, spindle=spindle)
        return Streamer(tolerance=self.tolerance, rates=self.rates, spindle=spindle)

    # --- connection -----------------------------------------------------------

    def connect(self, url: str) -> dict:
        url = url.strip()
        if not url:
            raise ValueError("url is empty")
        try:
            check_url(url)
        except LinkError as exc:
            raise ValueError(str(exc)) from exc
        with self._lock:
            if self.link is not None and self.link.is_open and self.link.url == url:
                return self.snapshot()
            self._close_link()
            link = self.link_factory(url)
            link.subscribe(self._on_link_event)
            self._soft_resets = 0
            self._restarts_seen = None
            self.link = link
            try:
                link.open()
            except LinkError:
                self.link = None
                raise
            self._restarts_seen = link.restarts - self._soft_resets
            self.url = url
            self.config["last_url"] = url
            self._save_config()
            self._settings_cache = None
        if link.banner is None:
            self.publish_message("error", f"no banner from {url}: is that the firmware?")
        else:
            self.publish_message("info", f"connected to {url}, firmware v{link.banner.version}")
        # Nothing says the focus axis is where it was: the machine may have
        # been powered off, or moved by hand, since the offset was set.
        self._frame_changed("connected")
        try:
            link.status_now(1.0, routine=True)
            self.read_settings(force=True)
        except (LinkError, HTTPException):
            pass
        return self.snapshot()

    def disconnect(self) -> dict:
        with self._lock:
            self._close_link()
        return self.snapshot()

    def _close_link(self) -> None:
        link = self.link
        if link is None:
            return
        if self.runner.active:
            try:
                self.runner.stop()
            except RunnerError:
                pass
        if self.prober.active:
            try:
                self.prober.stop()
            except ProberError:
                pass
        if link.is_open:
            self._output_off(link)
        link.close("disconnected")
        self.link = None
        self._jog_target = None

    def _output_off(self, link: Link) -> None:
        """Stops a turning spindle or a lit beam before the port closes.

        The firmware does not see a port close, only the USB host going
        away, and a spindle has no timeout: left on, it would go on turning
        with nothing connected to stop it. On an idle machine `laser off`
        stops either. A machine that is moving or held, or one that does not
        take `laser off` in time, is stopped the way a run's stop does it:
        a hold, then the reset once it is at rest, which turns the output
        off without the reset landing on a move.
        """
        try:
            status = link.status_now(OUTPUT_OFF_WAIT, routine=True)
        except LinkError:
            status = None
        if status is not None and status.laser == self._off_duty():
            return
        if status is not None and status.state.startswith("Alarm"):
            # An alarm has stopped the output already.
            return
        if status is not None and status.state == "Idle":
            try:
                link.request_ok("laser off", timeout=OUTPUT_OFF_WAIT)
                return
            except LinkError:
                pass
        halt(link, self.publish_message)

    def _off_duty(self) -> int:
        """The output's duty with the beam dark or the spindle stopped, in
        the status report's permille, from the settings last read."""
        cached = self._settings_cache
        invert = cached[1].get("laser_invert") if cached is not None else None
        return 1000 if isinstance(invert, (int, float)) and invert else 0

    def shutdown(self) -> None:
        self.disconnect()

    def require_link(self) -> Link:
        link = self.link
        if link is None or not link.is_open:
            raise HTTPException(status_code=409, detail="not connected")
        return link

    def _movable(self) -> Link:
        """The link, for a request that moves the head or declares where it
        is: refused while a run owns the machine, from the moment its plan
        is made from where the head stands."""
        link = self.require_link()
        if self.runner.active:
            raise HTTPException(status_code=409, detail="a job is running")
        if self.prober.active:
            raise HTTPException(status_code=409, detail="the board is being probed")
        return link

    def move_start(self, link: Link, streamer: Streamer, status=None) -> tuple[tuple[float, float], bool]:
        """Where the next move starts, and whether that is certain.

        While a jog is still running the reported position is on its way
        somewhere, so the end of that jog is the start of the next one; the
        firmware resolves a relative jog queued behind it from that same
        planned end. The start is uncertain only while the machine jogs
        toward an end this backend did not send. `status` is a report just
        read, or None to read one.
        """
        if status is None:
            status = link.status_now(1.0, routine=True)
        if status.state == "Jog" and self._jog_target is not None:
            return self._jog_target, True
        self._jog_target = None
        return streamer.start_of(status), status.state == "Idle"

    def _move_frame(self, link: Link):
        """The streamer a jog or a goto is planned with, and the report it
        was made from (None on a polar machine, whose board frame does not
        turn). A cartesian one works in the frame of the table angle, read
        now: the last poll may be from before, or partway through, a turn."""
        if not self.cartesian:
            return self.streamer(), None
        status = link.status_now(1.0, routine=True)
        return self.streamer(status), status

    def _board_start(self, link: Link, streamer: Streamer, status) -> tuple[tuple[float, float], bool]:
        """The start of a board move. On a cartesian machine a board point
        is a joint target only in the frame of the angle the table stops
        at, and a move toward an end this backend did not track may be a
        turn still under way: the frame read now is not the one the move
        queued behind it would run in."""
        start, known = self.move_start(link, streamer, status)
        if streamer.cartesian and not known:
            raise HTTPException(
                status_code=409,
                detail="the table may still be turning: wait for the machine to stop before a board move",
            )
        return start, known

    def _send_jog(self, link: Link, lines: list[str], end: tuple[float, float] | None) -> None:
        try:
            for line in lines:
                link.request_ok(line)
        except LinkError:
            self._jog_target = None
            raise
        self._jog_target = end

    def _check_reach(self, targets: list[tuple[tuple[float, float], bool]], cartesian: bool = False) -> None:
        """A board move is refused whole when any of its lines would be.

        The firmware checks the soft limit a line at a time, and a move
        sent as several lines would run the ones inside the limit before
        the refusal came back, leaving the head at the limit rather than
        where it was. On a cartesian machine the cross slide's limit holds
        as well.
        """
        values = self.read_settings()["values"]
        try:
            limit = float(values.get("r_max", 0) or 0)
            z_limit = float(values.get("z_max", 0) or 0) if cartesian else 0.0
        except (TypeError, ValueError):
            limit, z_limit = 0.0, 0.0
        for joint, _ in targets:
            if limit > 0 and abs(joint[0]) > limit + 1e-9:
                raise ValueError(f"out of reach: R{joint[0]:.3f} is past the soft limit r_max={limit:g}")
            if z_limit > 0 and abs(joint[1]) > z_limit + 1e-9:
                raise ValueError(f"out of reach: Z{joint[1]:.3f} is past the soft limit z_max={z_limit:g}")

    def snapshot(self) -> dict:
        link = self.link
        connected = link is not None and link.is_open
        firmware = None
        machine = None
        if connected and link is not None:
            if link.banner is not None:
                firmware = {
                    "version": link.banner.version,
                    "lines": link.banner.lines,
                    "blocks": link.banner.blocks,
                }
            status = link.status
            if status is not None:
                x, y = head_board(status.r, status.a, status.z, self.cartesian)
                machine = {
                    "state": status.state,
                    "alarm": status.alarm,
                    "joint": {"r": status.r, "a": status.a, "z": status.z, "h": status.h},
                    "probe": status.probe,
                    "board": {"x": round(x, 4), "y": round(y, 4)},
                    "rate": status.rate,
                    "laser": status.laser,
                    "mode": status.mode,
                    "enabled": status.enabled,
                    "queue": {"planner": status.planner, "lines": status.lines},
                }
        return {
            "connected": connected,
            "url": self.url,
            "firmware": firmware,
            "machine": machine,
            "profile": self.profile,
            "run": self.runner.snapshot(),
        }

    # --- events ---------------------------------------------------------------

    def _on_link_event(self, event: Event) -> None:
        if event.kind == "status":
            self._check_restart()
            self.broadcast.publish_threadsafe({"type": "state", **self.snapshot()})
        elif event.kind == "console":
            self.broadcast.publish_threadsafe({"type": "console", **event.data})
        elif event.kind == "message":
            text = event.data.get("text", "")
            if text == "reset":
                self._soft_resets += 1
            self.broadcast.publish_threadsafe({"type": "message", **event.data})
            # The board resets itself after this one, and a reset keeps the
            # position, but a driver without its supply may have let its
            # motor slip: the focus axis frame is no longer the one the map
            # was focused in.
            if text.startswith("tmc ") and text.endswith(" lost motor power, position may be off"):
                self._frame_changed("the motors lost power")
        elif event.kind == "banner":
            self.broadcast.publish_threadsafe({"type": "state", **self.snapshot()})
        elif event.kind == "disconnect":
            reason = event.data.get("reason", "")
            # A close the user asked for is news, not a fault.
            self.publish_message("info" if reason == "disconnected" else "error", f"link closed: {reason}")
            self.broadcast.publish_threadsafe({"type": "state", **self.snapshot()})

    def _check_restart(self) -> None:
        """Takes the focus offset back when the machine has started over
        since the last look: a banner that no reset came before. A reset
        byte keeps the position, and a banner that answers `version` is
        not counted by the link at all."""
        link = self.link
        seen = self._restarts_seen
        if link is None or seen is None:
            return
        unasked = link.restarts - self._soft_resets
        if unasked > seen:
            self._restarts_seen = unasked
            self._frame_changed("the machine restarted")

    def _frame_changed(self, reason: str) -> None:
        """Takes back the height map's focus offset, keeping its heights.

        The heights are focus axis positions in the frame of the session
        that probed them, and the offset is what ties them to the frame in
        use: once that frame may have changed, a run would follow the board
        at heights that mean something else. Focus here again sets the
        offset in the new frame, which is all a shift of H needs.
        """
        with self._map_lock:
            self._frame += 1
            heightmap = self.heightmaps.get()
            if heightmap is None or not heightmap.focus_set:
                return
            heightmap.focus_set = False
            self.heightmaps.put(heightmap)
        self.publish_message("info", f"{reason}: focus here again before a run follows the height map")
        self.publish_heightmap()

    def _publish_progress(self, progress: dict) -> None:
        self.broadcast.publish_threadsafe({"type": "progress", **progress})

    def _publish_probe(self, progress: dict | None, heightmap: dict | None) -> None:
        self._drop_stale_focus()
        self.publish_heightmap()

    def _drop_stale_focus(self) -> bool:
        """Takes back an offset set in a focus axis frame before this one;
        True if there was one. The caller publishes the map."""
        with self._map_lock:
            if self._focus_frame == self._frame:
                return False
            heightmap = self.heightmaps.get()
            if heightmap is None or not heightmap.focus_set:
                return False
            heightmap.focus_set = False
            self.heightmaps.put(heightmap)
        return True

    def publish_heightmap(self) -> None:
        self.broadcast.publish_threadsafe({"type": "heightmap", **self.heightmap_state()})

    def publish_message(self, level: str, text: str) -> None:
        self.broadcast.publish_threadsafe({"type": "message", "level": level, "text": text})

    # --- moving -----------------------------------------------------------------

    def _slide_move(self, link: Link, line: str) -> dict:
        """One cross slide line. It leaves the beam where it is on the board,
        so a board jog still ends where the last one was going."""
        link.request_ok(line)
        return {"lines": [line]}

    def jog(self, body: JogBody) -> dict:
        # Checked under both locks, as a position set is: a run or probing
        # claims the machine under the first, so it cannot start between
        # this check and the line going out.
        with self._owner_lock, self._move_lock:
            link = self._movable()
            return self._jog(link, body)

    def _jog(self, link: Link, body: JogBody) -> dict:
        check_feed(body.feed)
        streamer, status = self._move_frame(link)
        if body.kind == "joint":
            if streamer.cartesian:
                # The cross slide is a joint: it goes on the line with the
                # others. A turn of the table moves the frame the tracked
                # end is kept in, so after one the end is not known.
                lines = [streamer.joint_jog(body.dr, body.da, body.feed, body.dh, body.dz)]
                start, known = self.move_start(link, streamer, status)
                known = known and not body.da
                end = (start[0] + (body.dr or 0.0), start[1] + (body.dz or 0.0)) if known else None
                self._send_jog(link, lines, end)
                return {"lines": lines}
            if body.dz is not None:
                if body.dr is not None or body.da is not None or body.dh is not None:
                    raise ValueError("the cross slide moves on its own: dz cannot be sent with dr, da or dh")
                return self._slide_move(link, streamer.slide_jog(body.dz, body.feed))
            lines = [streamer.joint_jog(body.dr, body.da, body.feed, body.dh)]
            start, known = self.move_start(link, streamer, status)
            # A relative jog's end is known when its start is.
            end = (start[0] + (body.dr or 0.0), start[1] + (body.da or 0.0)) if known else None
        elif body.kind == "board":
            start, _ = self._board_start(link, streamer, status)
            here = streamer.board_of(start)
            targets = streamer.board_targets(start, (here[0] + (body.dx or 0.0), here[1] + (body.dy or 0.0)))
            self._check_reach(targets, streamer.cartesian)
            lines = streamer.jog_lines(targets, body.feed)
            end = targets[-1][0] if targets else start
        else:
            raise ValueError("kind must be joint or board")
        self._send_jog(link, lines, end)
        return {"lines": lines}

    def goto(self, body: GotoBody) -> dict:
        # Checked under both locks, as a position set is: a run or probing
        # claims the machine under the first, so it cannot start between
        # this check and the line going out.
        with self._owner_lock, self._move_lock:
            link = self._movable()
            return self._goto(link, body)

    def _goto(self, link: Link, body: GotoBody) -> dict:
        check_feed(body.feed)
        streamer, status = self._move_frame(link)
        if body.kind == "joint" and streamer.cartesian:
            lines = [streamer.joint_goto(body.r, body.a, body.feed, body.h, body.z)]
            start, known = self.move_start(link, streamer, status)
            # The tracked end is kept in the frame of the table angle: it is
            # known only when the goto leaves the angle alone and nothing
            # ahead of it can turn the table, which an unknown start may.
            if known and body.a is None:
                end = (start[0] if body.r is None else body.r, start[1] if body.z is None else body.z)
            else:
                end = None
        elif body.kind == "joint":
            if body.z is not None:
                if body.r is not None or body.a is not None or body.h is not None:
                    raise ValueError("the cross slide moves on its own: z cannot be sent with r, a or h")
                return self._slide_move(link, streamer.slide_goto(body.z, body.feed))
            lines = [streamer.joint_goto(body.r, body.a, body.feed, body.h)]
            start, known = self.move_start(link, streamer, status)
            # An axis left out stays where the queued jog ends, which is
            # only known when the start is.
            if body.r is not None and body.a is not None:
                end = (body.r, body.a)
            elif known:
                end = (start[0] if body.r is None else body.r, start[1] if body.a is None else body.a)
            else:
                end = None
        elif body.kind == "board":
            if body.x is None and body.y is None:
                raise ValueError("a board goto needs x and/or y")
            start, known = self._board_start(link, streamer, status)
            # An axis left out keeps the coordinate the head will have
            # once the jog in progress ends, which is only known when the
            # start is: the reported position is one it is passing through.
            if (body.x is None or body.y is None) and not known:
                raise ValueError("give both x and y: where the head will stop is not known")
            here = streamer.board_of(start)
            target = (here[0] if body.x is None else body.x, here[1] if body.y is None else body.y)
            targets = streamer.board_targets(start, target)
            self._check_reach(targets, streamer.cartesian)
            lines = streamer.jog_lines(targets, body.feed)
            end = targets[-1][0] if targets else start
        else:
            raise ValueError("kind must be joint or board")
        self._send_jog(link, lines, end)
        return {"lines": lines}

    def set_position(self, body: PositionBody) -> dict:
        # Checked under both locks: a run or probing that starts meanwhile
        # plans from the position this would renumber.
        with self._owner_lock, self._move_lock:
            link = self._movable()
            return self._set_position(link, body)

    def _set_position(self, link: Link, body: PositionBody) -> dict:
        words = []
        if body.r is not None:
            # Negative is allowed here: it declares the head parked on the
            # far side of the axis, which is where lining up leaves it.
            words.append(f"R{num(body.r)}")
        if body.a is not None:
            words.append(f"A{num(body.a, 4)}")
        if body.h is not None:
            words.append(f"H{num(body.h, 4)}")
        if not words and body.z is None:
            raise ValueError("give r, a, h and/or z")
        self._jog_target = None
        try:
            if words:
                link.request_ok("set " + " ".join(words))
            if body.z is not None:
                # Z goes on a line of its own: on a polar machine it is never
                # a word beside R or A, and on a cartesian one it may be.
                link.request_ok(f"set Z{num(body.z)}")
        finally:
            # H renumbered moves the frame the map's heights are in, and R,
            # A or Z the board under them. Taken back whether or not the
            # machine answered: a line that timed out may still have gone
            # through.
            self._frame_changed("the position was set")
        link.status_now(1.0, routine=True)
        return self.snapshot()

    def realtime(self, action: str) -> dict:
        link = self.require_link()
        if action == "hold":
            # A running job's hold goes through the runner so the run's own
            # state follows the machine's. A run still being planned is not
            # started, and the byte goes out all the same: the run has sent
            # nothing, but a line typed before it may still be moving the
            # machine, and an idle machine drops the byte.
            if self.runner.cancel_start("held before it started"):
                link.realtime(REALTIME_HOLD)
            elif self.runner.progress.state == RUNNING:
                self.runner.hold()
            else:
                link.realtime(REALTIME_HOLD)
        elif action == "resume":
            if self.runner.progress.state == HOLD:
                self.runner.resume()
            else:
                link.realtime(REALTIME_RESUME)
        elif action == "reset":
            self._jog_target = None
            # The reset empties the machine and frees every credit at once.
            # A run in progress is told first, so its thread stops
            # streaming before the byte goes out rather than sending the
            # next lines into a machine that is Idle again and would run
            # them; a run still being planned is not started.
            self.runner.abort("reset by the operator")
            self.prober.cancel("reset by the operator")
            link.reset(timeout=1.0)
        elif action == "cancel":
            self._jog_target = None
            link.realtime(REALTIME_JOG_CANCEL)
        elif action == "status":
            link.status_now(1.0)
        else:
            raise ValueError("action must be hold, resume, reset, cancel or status")
        return self.snapshot()

    def command(self, line: str) -> dict:
        link = self.require_link()
        text = line.strip()
        # A realtime byte typed on its own goes out as one, outside the
        # credits; what it brings back arrives as an event. A hold or a
        # resume typed during a run is the run's, the same as the button.
        if text == "?":
            link.realtime(REALTIME_STATUS)
            return {"lines": []}
        if text in ("!", "~"):
            self.realtime("hold" if text == "!" else "resume")
            return {"lines": []}
        words = text.split(";", 1)[0].lower().split()
        if words == ["status"]:
            # The same report as `?`, asked for the same way: a report the
            # `status` line printed would come on top of those the `?`
            # bytes asked for.
            status = link.status_now(1.0)
            return {"lines": [status.raw, "ok"]}
        if words in (["laser", "off"], ["spindle", "off"]) and self.runner.active:
            # During a run the output is the run's. Both are sync commands
            # the firmware takes up only once the moves ahead have run, and
            # the lines behind would go on with the output stopped, or not
            # at all in a hold until the resume. Typed then, they stop the
            # run the way its stop does: hold, then reset, which turns the
            # output off. A run still being planned is not started, and
            # the line goes out as typed.
            if not self.runner.cancel_start("the output was turned off before it started"):
                try:
                    self.runner.stop()
                    return {"lines": []}
                except RunnerError:
                    # The run ended in between: the line is the operator's.
                    pass
        first = words[0] if words else ""
        setting = text.startswith("$") and ("=" in text or text[1:].strip().lower() in ("load", "defaults"))
        # Lines that change the machine under whoever owns it: a run or a
        # probing leaves it idle for a moment between its lines, and the
        # firmware takes them then. A spindle start is refused while
        # probing, as the button is: the probe may be the tool itself.
        owned = setting or first in ("set", "disable")
        spindle_start = first == "spindle" and words[1:2] != ["off"]
        # A typed line may move the head or declare where it is, which
        # makes the end of the last jog meaningless as a starting point.
        self._jog_target = None
        reframes = first == "set" or (setting and self._reframes(text))

        def send() -> list[str]:
            try:
                return link.request(text)
            except LinkError:
                # Lost unanswered, it may still have been taken.
                if reframes:
                    self._frame_changed("a position or setting changed at the console")
                raise

        if owned or spindle_start:
            with self._owner_lock:
                if owned:
                    self._not_owned()
                elif self.prober.active:
                    # A speed change during a run is the operator's to make.
                    raise HTTPException(status_code=409, detail="the board is being probed")
                lines = send()
        else:
            lines = send()
        if reframes and lines and lines[-1] == "ok":
            self._frame_changed("a position or setting changed at the console")
        if setting:
            # A setting typed at the console: what this side remembers of
            # the machine's settings is stale, and the page's idea of what
            # the machine is (cartesian, spindle) with it.
            self._settings_cache = None
            try:
                self.read_settings(force=True)
            except LinkError:
                pass
        return {"lines": lines}

    @staticmethod
    def _reframes(text: str) -> bool:
        """A typed `$` line that may change the frame the axes count in."""
        body = text[1:].split(";", 1)[0].strip().lower()
        if body in ("load", "defaults"):
            return True
        return body.split("=", 1)[0].strip() in FRAME_SETTINGS

    def laser(self, power: float, ms: int | None) -> dict:
        if self.milling:
            raise ValueError("the output drives a spindle ($spindle=1): use the spindle controls")
        link = self.require_link()
        if power < 0:
            raise ValueError("power must be >= 0")
        line = f"laser S{num(power)}"
        if ms is not None:
            if ms <= 0:
                raise ValueError("ms must be > 0")
            line += f" T{int(ms)}"
        link.request_ok(line)
        return self.snapshot()

    def laser_off(self) -> dict:
        # During a run the beam is the run's: `laser off` is a sync command
        # that would stall the cut mid-path, then let it go on. The button
        # that means "beam off now" is the hold, which the run can resume.
        if self.runner.progress.state == RUNNING:
            self.runner.hold()
            return self.snapshot()
        # A run still being planned has sent nothing: it is not started,
        # and the line goes out as it would with no run.
        cancelled = self.runner.cancel_start("the laser was turned off before it started")
        if self.runner.active and not cancelled:
            return self.snapshot()
        self.require_link().request_ok("laser off")
        return self.snapshot()

    def spindle_on(self, power: float) -> dict:
        """Starts the spindle, or changes its speed, from the page. A run
        starts and stops it itself, and a stop while one is under way would
        stall the tool in the work while the lines behind went on. Probing
        lowers the probe, which may be the tool itself, onto the copper:
        the spindle does not start while it is under way."""
        # Under the owner lock, so a probing that starts meanwhile sees the
        # spindle turning in its first status report.
        with self._owner_lock:
            if self.runner.active:
                raise HTTPException(status_code=409, detail="a job is running")
            if self.prober.active:
                raise HTTPException(status_code=409, detail="the board is being probed")
            if not self.milling:
                raise ValueError("the output drives a laser ($spindle=0)")
            if not (math.isfinite(power) and power >= 0):
                raise ValueError("power must be >= 0")
            link = self.require_link()
            link.request_ok(f"spindle S{num(power)}")
        link.status_now(1.0, routine=True)
        return self.snapshot()

    def spindle_off(self) -> dict:
        if self.runner.active:
            raise HTTPException(status_code=409, detail="a job is running: stop it to stop the spindle")
        link = self.require_link()
        link.request_ok("spindle off" if self.milling else "laser off")
        link.status_now(1.0, routine=True)
        return self.snapshot()

    def mode(self, mode: str) -> dict:
        if self.runner.active:
            raise HTTPException(status_code=409, detail="a job is running")
        if mode not in ("dyn", "const"):
            raise ValueError("mode must be dyn or const")
        link = self.require_link()
        link.request_ok(f"mode {mode}")
        link.status_now(1.0, routine=True)
        return self.snapshot()

    def motors(self, enabled: bool) -> dict:
        link = self.require_link()
        if enabled:
            link.request_ok("enable")
        else:
            # The drivers share their enable line: `disable` lets the focus
            # axis go too, and a head that sinks in an idle moment between
            # a run's lines or two probe points loses its height unseen. A
            # run or probing asked for at the same moment waits for this.
            with self._owner_lock:
                self._not_owned()
                link.request_ok("disable")
        link.status_now(1.0, routine=True)
        return self.snapshot()

    def _not_owned(self) -> None:
        """Refuses a request that would change the machine under a run or
        probing that owns it."""
        if self.runner.active:
            raise HTTPException(status_code=409, detail="a job is running")
        if self.prober.active:
            raise HTTPException(status_code=409, detail="the board is being probed")

    def unlock(self) -> dict:
        link = self.require_link()
        link.request_ok("unlock")
        link.status_now(1.0, routine=True)
        return self.snapshot()

    # --- settings -----------------------------------------------------------------

    def read_settings(self, force: bool = False) -> dict:
        link = self.require_link()
        now = time.monotonic()
        cached = self._settings_cache
        if not force and cached is not None and now - cached[0] < SETTINGS_CACHE_SECONDS:
            values = cached[1]
        else:
            values = {}
            for line in link.request_ok("$"):
                name, sep, text = line.partition("=")
                if sep:
                    values[name.strip()] = _number(text.strip())
            self._settings_cache = (now, values)
            self.rates = Rates.from_settings(values)
            self.profile = profile_of(values)
        return {"values": values, "schema": SETTINGS_SCHEMA, "host": self.host_settings()}

    def write_settings(self, values: dict | None, host: dict | None) -> dict:
        """Settings to the machine and the host's own, all or nothing.

        Every entry is checked here before anything goes out; a value the
        machine still refuses has the ones sent before it put back. The
        host's tolerance is stored only once the machine's part is done.
        """
        tolerance = _tolerance(host["tolerance"]) if host and "tolerance" in host else None
        milling = None
        if host and ("clearance" in host or "spinup" in host):
            current_spindle = self.spindle_config()
            try:
                milling = Spindle(
                    clearance=_host_number(host, "clearance", current_spindle.clearance),
                    spinup=_host_number(host, "spinup", current_spindle.spinup),
                )
            except (TypeError, ValueError) as exc:
                raise ValueError(str(exc)) from exc
        if values:
            # A setting changed between a run's lines, or two probe points,
            # would change what the rest of them mean; a run or probing
            # asked for meanwhile waits for the write.
            with self._owner_lock:
                self._write_machine_settings(values)
        if tolerance is not None:
            self.config["tolerance"] = tolerance
        if milling is not None:
            self.config["clearance"] = milling.clearance
            self.config["spinup"] = milling.spinup
        if tolerance is not None or milling is not None:
            self._save_config()
        if self.link is not None and self.link.is_open:
            return self.read_settings(force=True)
        return {"values": {}, "schema": SETTINGS_SCHEMA, "host": self.host_settings()}

    def _write_machine_settings(self, values: dict) -> None:
        """The machine's part of a settings write; the caller holds the
        owner lock."""
        self._not_owned()
        link = self.require_link()
        current = self.read_settings(force=True)["values"]
        texts = {}
        for name, value in values.items():
            if name not in current:
                raise ValueError(f"unknown setting {name!r}")
            texts[name] = _setting_text(name, value)
        applied: list[str] = []
        # The line on its way: one lost unanswered may still have been
        # taken, as a refused one was not.
        sending: str | None = None
        try:
            for name, text in texts.items():
                if _number(text) == current[name]:
                    continue
                sending = name
                link.request_ok(f"${name}={text}")
                applied.append(name)
                sending = None
        except Exception as exc:
            if isinstance(exc, CommandError):
                sending = None
            elif sending is not None:
                applied.append(sending)
            # Refused, or lost on the way: whatever went before is put
            # back, so the write is all or nothing as far as the link
            # allows, and what the machine is read again.
            self._restore_settings(link, {name: current[name] for name in applied})
            self._settings_cache = None
            try:
                self.read_settings(force=True)
            except (LinkError, HTTPException):
                pass
            raise
        finally:
            self._settings_cache = None
            # A jog end tracked in one frame means nothing in another.
            self._jog_target = None
            if FRAME_SETTINGS.intersection(applied):
                self._frame_changed("a setting that scales or turns the axes changed")

    def _restore_settings(self, link: Link, previous: dict) -> None:
        """Put back settings a refused write had already changed. A link
        that fails ends it; a value that cannot be sent, or is refused, is
        skipped for the next."""
        for name, value in previous.items():
            try:
                link.request_ok(f"${name}={_setting_text(name, value)}")
            except (ValueError, CommandError) as exc:
                self.publish_message("error", f"could not put {name} back to {value}: {exc}")
            except LinkError as exc:
                self.publish_message("error", f"could not put {name} back to {value}: {exc}")
                return

    def save_settings(self) -> dict:
        self.require_link().request_ok("$save")
        return {"saved": True}

    # --- ports and jobs --------------------------------------------------------------

    def ports(self) -> dict:
        from serial.tools import list_ports

        found = []
        try:
            for port in list_ports.comports():
                found.append({"url": port.device, "description": port.description or ""})
        except Exception:
            pass
        last = self.config.get("last_url")
        if last and last not in [entry["url"] for entry in found]:
            found.append({"url": last, "description": "last used"})
        return {"ports": found}

    def import_upload(self, filename: str, data: bytes, options: ImportOptions) -> Job:
        import tempfile

        name = Path(filename or "upload").name
        if not name or name.startswith("."):
            raise JobImportError("the upload needs a file name with a suffix")
        try:
            with tempfile.TemporaryDirectory(prefix="spinny-upload-") as folder:
                path = Path(folder) / name
                path.write_bytes(data)
                job = import_file(path, path.stem, options, self.streamer())
        except OSError as exc:
            raise JobImportError(f"cannot store the upload {name!r}: {exc}") from exc
        return self.store.add(job)

    def center_job(self, request: center.CenterRequest) -> dict:
        if self.cartesian or self.milling:
            raise ValueError("the centering test is a burn on the polar laser machine ($cartesian=0, $spindle=0)")
        cached = self._settings_cache
        s_max = cached[1].get("s_max") if cached is not None else None
        result = center.build(
            request,
            self.streamer(),
            self.rates.a_rate,
            s_max if isinstance(s_max, (int, float)) and s_max > 0 else None,
        )
        result.job = self.store.add(result.job)
        return result.model_dump()

    def patch_job(self, job_id: str, patch: JobPatch) -> Job:
        job = self.store.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="no such job")
        if self.runner.active and self.runner.progress.job == job_id:
            raise HTTPException(status_code=409, detail="the job is running")
        job = apply_patch(job, patch, self.streamer())
        self.store.save(job)
        return job

    def run_job(self, job_id: str, compensate: str = OFF) -> dict:
        # The check that nothing is being probed and the runner's claim are
        # one step: probing asked for at the same moment waits for this,
        # then finds the run under way.
        with self._owner_lock:
            return self._run_job(job_id, compensate)

    def _run_job(self, job_id: str, compensate: str = OFF) -> dict:
        job = self.store.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="no such job")
        if self.prober.active:
            raise HTTPException(status_code=409, detail="the board is being probed")
        # Claimed before the settings are read: a stop, hold or reset while
        # they are keeps the run from starting, as one during its planning
        # does. The restart count is taken with it for the same reason.
        self.runner.reserve(self.link)
        try:
            restarts = self.link.restarts if self.link is not None else None
            if self.link is not None and self.link.is_open:
                values = self.read_settings(force=True)["values"]
                if self.milling and not values.get("h_axis"):
                    raise ValueError("a spindle needs the focus axis as its depth axis: set $h_axis=1")
            compensation = self.compensation(compensate, job)
            # A cartesian plan is made in the frame of the table as it is now.
            status = None
            if self.cartesian and self.link is not None and self.link.is_open:
                status = self.link.status_now(1.0, routine=True)
            return self.runner.start(job, self.link, self.streamer(status), compensation, restarts, reserved=True)
        finally:
            self.runner.release()

    # --- the height map ---------------------------------------------------------------

    def probe_settings(self) -> ProbeSettings:
        try:
            settings = ProbeSettings.model_validate(self.config.get("probe", {}))
            settings.check()
            return settings
        except ValueError:
            return ProbeSettings()

    def heightmap_state(self) -> dict:
        heightmap = self.heightmaps.get()
        return {
            "map": heightmap.model_dump() if heightmap is not None else None,
            "probe": self.prober.snapshot(),
            "settings": self.probe_settings().model_dump(),
        }

    def put_heightmap(self, heightmap: HeightMap) -> dict:
        """Puts back a map, from a file say. Its heights are from a session
        whose focus axis frame nothing here knows, so it needs focus here
        before a run follows it, whatever it says of its offset."""
        if self.prober.active:
            raise HTTPException(status_code=409, detail="the board is being probed")
        heightmap.focus_set = False
        with self._map_lock:
            self.heightmaps.put(heightmap)
            self._heights_frame = None
        self.publish_heightmap()
        return self.heightmap_state()

    def clear_heightmap(self) -> dict:
        if self.prober.active:
            raise HTTPException(status_code=409, detail="the board is being probed")
        with self._map_lock:
            self.heightmaps.put(None)
            self._heights_frame = None
        self.publish_heightmap()
        return self.heightmap_state()

    def update_probe_settings(self, body: ProbeConfigBody) -> dict:
        patch = {key: value for key, value in body.model_dump().items() if value is not None}
        settings = ProbeSettings.model_validate({**self.probe_settings().model_dump(), **patch})
        settings.check()
        self.config["probe"] = settings.model_dump()
        self._save_config()
        self.publish_heightmap()
        return self.heightmap_state()

    def start_probe(self, grid: Grid) -> dict:
        # The check that no run is under way and the prober's claim are one
        # step: a run asked for at the same moment waits for this, then
        # finds the board being probed.
        with self._owner_lock:
            link = self._movable()
            # Claimed before the settings are read: a stop or reset while
            # they are keeps the probing from starting.
            self.prober.reserve(link)
            try:
                values = self.read_settings(force=True)["values"]
                try:
                    r_max = float(values.get("r_max", 0) or 0)
                    z_max = float(values.get("z_max", 0) or 0)
                except (TypeError, ValueError):
                    r_max, z_max = 0.0, 0.0
                # The tool may be the probe: a spindle has to be stopped.
                spindle_off = self._off_duty() if self.milling else None
                with self._move_lock:
                    self._jog_target = None
                    status = link.status_now(1.0, routine=True)
                    frame = self._frame
                    self.prober.start(
                        grid,
                        self.probe_settings(),
                        link,
                        self.streamer(status),
                        r_max,
                        z_max,
                        spindle_off,
                        keep_focus=self._heights_frame == frame,
                        reserved=True,
                    )
                    self._heights_frame = frame
            finally:
                # A start that went through has let go of the claim already.
                self.prober.release()
        return self.heightmap_state()

    def stop_probe(self) -> dict:
        self.prober.stop()
        return self.heightmap_state()

    def focus(self, offset: float | None) -> dict:
        """Sets the focus offset: given, or from the head's height over the
        board point under the beam, which the operator has just focused.

        Taken from the head, it ties the map to the focus axis frame in use
        whatever frame the heights were probed in. Given as a number, it is
        a plain distance from contact to focus, which holds only for
        heights probed in this frame.
        """
        if self.prober.active:
            raise HTTPException(status_code=409, detail="the board is being probed")
        if self.heightmaps.get() is None:
            raise ValueError("there is no height map: probe the board first")
        self._check_restart()
        frame = self._frame
        status = None
        if offset is None:
            status = self.require_link().status_now(1.0, routine=True)
            if status.state != "Idle":
                raise ValueError(f"the machine is {status.state}: focus with the head at rest")
            # The report may be the first after a restart.
            self._check_restart()
        with self._map_lock:
            heightmap = self.heightmaps.get()
            if heightmap is None:
                raise ValueError("there is no height map: probe the board first")
            if self._frame != frame:
                raise ValueError("the focus axis frame changed meanwhile: focus again")
            if status is not None:
                # Without a focus axis the head's height is fixed, and zero
                # is as good a name for it as any: the map only needs the
                # same one.
                here = status.h if status.h is not None else 0.0
                x, y = head_board(status.r, status.a, status.z, self.cartesian)
                grid = heightmap.grid
                if not grid.covers((x, y, x, y)):
                    # The edge height would stand in for copper nobody
                    # measured, and every compensated line would be off by
                    # the difference.
                    raise ValueError(
                        f"focus over the probed area: the beam is at X {x:.1f} Y {y:.1f}, the map covers"
                        f" X {grid.x0:.1f}..{grid.x1:.1f} Y {grid.y0:.1f}..{grid.y1:.1f}"
                    )
                offset = here - heightmap.height_at(x, y)
            elif self._heights_frame != frame:
                raise ValueError(
                    "the map was probed before the focus axis was last renumbered (a connect, a restart,"
                    " a position set or a map put back): use focus here over the map, or probe again"
                )
            heightmap.focus_offset = round(offset, 4)
            heightmap.focus_set = True
            self.heightmaps.put(heightmap)
            self._focus_frame = frame
        self.publish_heightmap()
        return self.heightmap_state()

    def compensation(self, mode: str, job: Job) -> Compensation | None:
        """What a run of `job` follows the board with, checked; None for off."""
        if mode not in MODES:
            raise ValueError(f"compensate must be one of {', '.join(MODES)}")
        if mode == OFF:
            return None
        # A restart not yet seen in a status report takes the offset back
        # before the map is looked at, and so does one probing missed.
        self._check_restart()
        if self._drop_stale_focus():
            self.publish_heightmap()
        heightmap = self.heightmaps.get()
        if heightmap is None:
            raise ValueError("there is no height map: probe the board first")
        heightmap.usable()
        check_covers(heightmap, job)
        # Read afresh: a focus axis taken out a moment ago must not be
        # driven from a cached answer.
        values = self.read_settings(force=True)["values"]
        has_axis = bool(values.get("h_axis"))
        if mode == AUTO:
            mode = FOCUS if has_axis else POWER
        if self.milling and mode == POWER:
            raise ValueError("a spindle follows the board with its depth axis: compensate by focus")
        if mode == FOCUS and not has_axis:
            raise ValueError("the focus axis is not fitted ($h_axis=0): compensate by power instead")
        status = self.require_link().status_now(1.0, routine=True)
        s_max = values.get("s_max", 1000.0)
        return Compensation(
            heightmap=heightmap,
            mode=mode,
            head_h=status.h if status.h is not None else 0.0,
            rayleigh=self.probe_settings().rayleigh,
            s_max=float(s_max) if isinstance(s_max, (int, float)) and s_max > 0 else 1000.0,
        )


def _number(text: str):
    try:
        return int(text)
    except ValueError:
        pass
    try:
        return float(text)
    except ValueError:
        return text


def _setting_text(name: str, value) -> str:
    """The value of a `$name=value` line: a finite number the firmware can
    hold, or a bool as 0/1.

    Anything else is refused here rather than sent for the machine to
    refuse, or the link to refuse as too long, after the entries before it
    have been applied.
    """
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, str):
        value = _number(value.strip())
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a number")
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError(f"{name} must be a number")
    # Only a whole number can be meant for a whole number setting, and
    # those go past the float bound: an idle time in ms, say.
    whole = isinstance(value, int) or value.is_integer()
    limit = INT_SETTING_MAX if whole else SETTING_MAX
    if abs(value) > limit:
        shown = str(INT_SETTING_MAX) if whole else f"{SETTING_MAX:g}"
        raise ValueError(f"{name} must be within {shown}")
    if isinstance(value, int):
        text = str(value)
    else:
        text = f"{value:.6f}".rstrip("0").rstrip(".")
        text = text if text not in ("", "-") else "0"
    if len(f"${name}={text}\n".encode("ascii")) > MAX_LINE:
        raise ValueError(f"{name}={text} is longer than a line the machine takes")
    return text


def profile_of(values: dict) -> dict:
    """What the machine is, from its settings: how the head moves over the
    board, what is on the output, and the limits a page draws."""

    def number(name: str) -> float:
        value = values.get(name, 0)
        return float(value) if isinstance(value, (int, float)) and math.isfinite(value) else 0.0

    return {
        "kinematics": CARTESIAN if number("cartesian") else POLAR,
        "tool": SPINDLE if number("spindle") else LASER,
        "h_axis": bool(number("h_axis")),
        "r_max": number("r_max"),
        "z_max": number("z_max"),
    }


def _host_number(host: dict, name: str, default: float) -> float:
    value = host.get(name, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a number")
    try:
        return float(value)
    except OverflowError as exc:
        # An integer too large for a float.
        raise ValueError(f"{name} must be a number") from exc


def _tolerance(value) -> float:
    """The host's chord tolerance in mm, checked."""
    if isinstance(value, bool):
        raise ValueError("tolerance must be a number")
    try:
        tolerance = float(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError("tolerance must be a number") from exc
    if not (math.isfinite(tolerance) and 0.0 < tolerance <= MAX_TOLERANCE):
        raise ValueError(f"tolerance must be above 0 and at most {MAX_TOLERANCE:g} mm")
    return tolerance


class OriginGuard:
    """Refuses requests a page from another origin can make without a
    preflight.

    A browser sends a form post, or opens a websocket, to any origin with
    no CORS check first; CORS only decides whether the page may read the
    answer. Here the request itself is what matters: a post starts a run
    or lights the laser. So a request that names an origin (browsers do,
    on every post and websocket) must name this server's own, or one on
    the allowed list. Requests with no origin at all, from scripts and
    command line tools, are not a page's doing and pass.
    """

    SAFE_METHODS = ("GET", "HEAD", "OPTIONS")

    def __init__(self, app, allowed: list[str] | None = None) -> None:
        self.app = app
        self.allowed = set(origin.rstrip("/").lower() for origin in allowed or [])

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] not in ("http", "websocket") or self._permitted(scope):
            await self.app(scope, receive, send)
            return
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        body = json.dumps({"detail": "cross-origin request refused"}).encode()
        await send(
            {
                "type": "http.response.start",
                "status": 403,
                "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())],
            }
        )
        await send({"type": "http.response.body", "body": body})

    def _permitted(self, scope) -> bool:
        if scope["type"] == "http" and scope.get("method", "GET").upper() in self.SAFE_METHODS:
            return True
        headers = {key.decode("latin-1").lower(): value.decode("latin-1") for key, value in scope.get("headers", [])}
        origin = headers.get("origin")
        if origin is None:
            return True
        origin = origin.rstrip("/").lower()
        if origin in self.allowed:
            return True
        host = headers.get("host", "").lower()
        scheme = scope.get("scheme", "http")
        scheme = {"ws": "http", "wss": "https"}.get(scheme, scheme)
        return bool(host) and origin == f"{scheme}://{host}"


# --- the app ---------------------------------------------------------------------


def create_app(
    backend: Backend | None = None,
    frontend: Path | None = None,
    cors_origins: list[str] | None = None,
    allowed_hosts: list[str] | None = None,
) -> FastAPI:
    backend = backend or Backend()
    frontend = FRONTEND_DIST if frontend is None else frontend

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        backend.broadcast.loop = asyncio.get_running_loop()
        try:
            yield
        finally:
            await run_in_threadpool(backend.shutdown)

    app = FastAPI(title="spinny-web", version=__version__, lifespan=lifespan)
    app.state.backend = backend

    @app.exception_handler(RequestValidationError)
    async def validation_failed(request: Request, exc: RequestValidationError) -> JSONResponse:
        # The stock answer echoes the input, and an input refused for
        # being NaN cannot be written as JSON: the echo is left out.
        errors = [{key: value for key, value in error.items() if key != "input"} for error in exc.errors()]
        return JSONResponse(status_code=422, content={"detail": jsonable_encoder(errors)})
    # A page from another origin may not drive the machine: the guard
    # refuses its posts and websockets, which a browser sends without a
    # preflight. CORS on top of it is only for a page served from
    # elsewhere, such as the frontend's dev server, so its calls can read
    # their answers.
    app.add_middleware(OriginGuard, allowed=cors_origins)
    if cors_origins:
        from fastapi.middleware.cors import CORSMiddleware

        app.add_middleware(
            CORSMiddleware,
            allow_origins=cors_origins,
            allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
            allow_headers=["content-type"],
        )
    if allowed_hosts:
        # The names this server answers to. A page that has pointed its own
        # name at this address (DNS rebinding) arrives with that name as
        # the host, and is turned away by it.
        from starlette.middleware.trustedhost import TrustedHostMiddleware

        app.add_middleware(TrustedHostMiddleware, allowed_hosts=allowed_hosts)

    def guarded(call: Callable[[], Any]) -> Any:
        try:
            return call()
        except CommandError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except (RunnerError, ProberError) as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except (JobImportError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except LinkError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    # --- connection ---

    @app.get("/api/ports")
    def ports():
        return backend.ports()

    @app.post("/api/connect")
    def connect(body: ConnectBody):
        return guarded(lambda: backend.connect(body.url))

    @app.post("/api/disconnect")
    def disconnect():
        return backend.disconnect()

    @app.get("/api/state")
    def state():
        return backend.snapshot()

    # --- moving ---

    @app.post("/api/jog")
    def jog(body: JogBody):
        return guarded(lambda: backend.jog(body))

    @app.post("/api/goto")
    def goto(body: GotoBody):
        return guarded(lambda: backend.goto(body))

    @app.post("/api/jog/cancel")
    def jog_cancel():
        return guarded(lambda: backend.realtime("cancel"))

    @app.post("/api/position")
    def position(body: PositionBody):
        return guarded(lambda: backend.set_position(body))

    @app.post("/api/motors")
    def motors(body: MotorsBody):
        return guarded(lambda: backend.motors(body.enabled))

    @app.post("/api/unlock")
    def unlock():
        return guarded(backend.unlock)

    @app.post("/api/realtime")
    def realtime(body: RealtimeBody):
        return guarded(lambda: backend.realtime(body.action))

    @app.post("/api/command")
    def command(body: CommandBody):
        return guarded(lambda: backend.command(body.line))

    # --- laser ---

    @app.post("/api/laser")
    def laser(body: LaserBody):
        return guarded(lambda: backend.laser(body.power, body.ms))

    @app.post("/api/laser/off")
    def laser_off():
        return guarded(backend.laser_off)

    @app.post("/api/spindle")
    def spindle(body: SpindleBody):
        return guarded(lambda: backend.spindle_on(body.power))

    @app.post("/api/spindle/off")
    def spindle_off():
        return guarded(backend.spindle_off)

    @app.post("/api/mode")
    def mode(body: ModeBody):
        return guarded(lambda: backend.mode(body.mode))

    # --- settings ---

    @app.get("/api/settings")
    def settings():
        return guarded(backend.read_settings)

    @app.put("/api/settings")
    def put_settings(body: SettingsBody):
        return guarded(lambda: backend.write_settings(body.values, body.host))

    @app.post("/api/settings/save")
    def save_settings():
        return guarded(backend.save_settings)

    # --- jobs ---

    @app.post("/api/jobs")
    async def upload_job(
        file: UploadFile = File(...),
        power: float | None = Form(None),
        speed: float | None = Form(None),
        spot: float | None = Form(None),
        anchor: str | None = Form(None),
        offset_x: float | None = Form(None),
        offset_y: float | None = Form(None),
        passes: int | None = Form(None),
        clear: str | None = Form(None),
        mode: str | None = Form(None),
        fill: str | None = Form(None),
    ):
        options = ImportOptions(tolerance=backend.tolerance)
        if power is not None:
            options.power = power
        if speed is not None:
            options.speed = speed
        if spot is not None:
            options.spot = spot
        if anchor:
            options.anchor = anchor.strip().lower()
        if offset_x is not None or offset_y is not None:
            options.offset = (offset_x or 0.0, offset_y or 0.0)
        if passes is not None:
            options.passes = passes
        if clear:
            options.clear = clear.strip().lower()
        if mode:
            options.mode = mode.strip().lower()
        if fill:
            options.fill = fill.strip().lower()
        chunks: list[bytes] = []
        size = 0
        while chunk := await file.read(1 << 20):
            size += len(chunk)
            if size > MAX_UPLOAD_BYTES:
                raise HTTPException(status_code=413, detail=f"the upload is over {MAX_UPLOAD_BYTES >> 20} MB")
            chunks.append(chunk)
        data = b"".join(chunks)
        try:
            job = await run_in_threadpool(backend.import_upload, file.filename or "", data, options)
        except (JobImportError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return job.model_dump()

    @app.post("/api/center")
    async def center_job(body: center.CenterRequest):
        return await run_in_threadpool(guarded, lambda: backend.center_job(body))

    @app.get("/api/jobs")
    def list_jobs():
        return {"jobs": [job.summary() for job in backend.store.list()]}

    @app.get("/api/jobs/{job_id}")
    def get_job(job_id: str):
        job = backend.store.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="no such job")
        return job.model_dump()

    @app.patch("/api/jobs/{job_id}")
    def patch_job(job_id: str, patch: JobPatch):
        return guarded(lambda: backend.patch_job(job_id, patch)).model_dump()

    @app.delete("/api/jobs/{job_id}")
    def delete_job(job_id: str):
        if backend.runner.active and backend.runner.progress.job == job_id:
            raise HTTPException(status_code=409, detail="the job is running")
        if not backend.store.remove(job_id):
            raise HTTPException(status_code=404, detail="no such job")
        return {"deleted": job_id}

    @app.post("/api/jobs/{job_id}/run")
    def run_job(job_id: str, body: RunBody | None = None):
        compensate = body.compensate if body is not None else OFF
        return guarded(lambda: backend.run_job(job_id, compensate))

    @app.post("/api/run/hold")
    def run_hold():
        return guarded(backend.runner.hold)

    @app.post("/api/run/resume")
    def run_resume():
        return guarded(backend.runner.resume)

    @app.post("/api/run/stop")
    def run_stop():
        return guarded(backend.runner.stop)

    @app.get("/api/run")
    def run_progress():
        # Null until a job has run, like the snapshot's `run`.
        return backend.runner.snapshot()

    # --- the height map ---

    @app.get("/api/heightmap")
    def heightmap():
        return backend.heightmap_state()

    @app.put("/api/heightmap")
    def put_heightmap(body: HeightMap):
        return guarded(lambda: backend.put_heightmap(body))

    @app.delete("/api/heightmap")
    def delete_heightmap():
        return guarded(backend.clear_heightmap)

    @app.put("/api/heightmap/settings")
    def put_probe_settings(body: ProbeConfigBody):
        return guarded(lambda: backend.update_probe_settings(body))

    @app.post("/api/heightmap/probe")
    def start_probe(body: Grid):
        return guarded(lambda: backend.start_probe(body))

    @app.post("/api/heightmap/stop")
    def stop_probe():
        return guarded(backend.stop_probe)

    @app.post("/api/heightmap/focus")
    def focus(body: FocusBody):
        return guarded(lambda: backend.focus(body.offset))

    # --- events ---

    @app.websocket("/ws")
    async def events(websocket: WebSocket):
        await websocket.accept()
        queue = backend.broadcast.subscribe()
        try:
            await websocket.send_json({"type": "state", **backend.snapshot()})
            gone = asyncio.ensure_future(websocket.receive())
            while True:
                getter = asyncio.ensure_future(queue.get())
                done, _ = await asyncio.wait({getter, gone}, return_when=asyncio.FIRST_COMPLETED)
                if gone in done:
                    getter.cancel()
                    break
                await websocket.send_json(getter.result())
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            backend.broadcast.unsubscribe(queue)

    # --- the frontend ---

    if frontend.is_dir():
        app.mount("/", StaticFiles(directory=str(frontend), html=True), name="frontend")
    else:

        @app.get("/", response_class=HTMLResponse)
        def index():
            return HTMLResponse(NO_FRONTEND)

    return app


def main(argv: list[str] | None = None) -> int:
    import uvicorn

    parser = argparse.ArgumentParser(prog="spinny-web", description="Web backend for the rotary table laser.")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument(
        "--cors-origin",
        action="append",
        default=[],
        help="an origin allowed to call the API from a page served elsewhere, such as the"
        " frontend dev server: http://localhost:3000; repeatable",
    )
    parser.add_argument(
        "--allowed-host",
        action="append",
        default=[],
        help="a host name this server answers to, such as spinny.local or 192.168.1.20;"
        " repeatable; any other Host header is refused (default: all)",
    )
    parser.add_argument("--version", action="version", version=__version__)
    args = parser.parse_args(argv)
    uvicorn.run(
        create_app(cors_origins=args.cors_origin, allowed_hosts=args.allowed_host),
        host=args.host,
        port=args.port,
        log_level="info",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
