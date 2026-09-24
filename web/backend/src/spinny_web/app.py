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
from .jobs import ImportOptions, Job, JobImportError, JobPatch, JobStore, apply_patch, import_file
from .kinematics import DEFAULT_TOLERANCE, Rates, Streamer, board_of, check_feed, num
from .link import (
    check_url,
    CommandError,
    Event,
    Link,
    LinkError,
    REALTIME_HOLD,
    REALTIME_JOG_CANCEL,
    REALTIME_RESUME,
    REALTIME_STATUS,
)
from .runner import HOLD, RUNNING, Runner, RunnerError

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
    {"name": "dir_invert", "unit": "mask", "help": "bit 0 radius, bit 1 table, bit 2 cross slide"},
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
]

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
    # The cross slide moves on its own, so dz comes without dr or da.
    dz: float | None = None
    dx: float | None = None
    dy: float | None = None
    feed: float | None = None


class GotoBody(Finite):
    kind: str = "joint"
    r: float | None = None
    a: float | None = None
    z: float | None = None
    x: float | None = None
    y: float | None = None
    feed: float | None = None


class PositionBody(Finite):
    r: float | None = None
    a: float | None = None
    z: float | None = None


class MotorsBody(BaseModel):
    enabled: bool


class RealtimeBody(BaseModel):
    action: str


class CommandBody(BaseModel):
    line: str


class LaserBody(Finite):
    power: float
    ms: int | None = None


class ModeBody(BaseModel):
    mode: str


class SettingsBody(BaseModel):
    values: dict[str, Any] | None = None
    host: dict[str, Any] | None = None


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
    ) -> None:
        self.root = root
        self.config_path = config_path or root / "config.json"
        self.config = self._load_config()
        self.store = JobStore(jobs_dir if jobs_dir is not None else root / "jobs")
        self.link_factory = link_factory or (lambda url: Link(url))
        self.link: Link | None = None
        self.url: str | None = self.config.get("last_url")
        self.broadcast = Broadcast()
        self.runner = Runner(publish=self._publish_progress, message=self.publish_message)
        self.rates = Rates()
        self._settings_cache: tuple[float, dict] | None = None
        self._lock = threading.Lock()
        # One move request at a time: each plans from the end of the last,
        # and two in flight at once would both start from the same place.
        self._move_lock = threading.Lock()
        # Where the jog in progress ends, so the next board move starts from
        # there rather than from a position the machine has already left.
        self._jog_target: tuple[float, float] | None = None

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

    def streamer(self) -> Streamer:
        return Streamer(tolerance=self.tolerance, rates=self.rates)

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
            self.link = link
            try:
                link.open()
            except LinkError:
                self.link = None
                raise
            self.url = url
            self.config["last_url"] = url
            self._save_config()
            self._settings_cache = None
        if link.banner is None:
            self.publish_message("error", f"no banner from {url}: is that the firmware?")
        else:
            self.publish_message("info", f"connected to {url}, firmware v{link.banner.version}")
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
        link.close("disconnected")
        self.link = None
        self._jog_target = None

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
        return link

    def move_start(self, link: Link) -> tuple[tuple[float, float], bool]:
        """Where the next move starts, and whether that is certain.

        While a jog is still running the reported position is on its way
        somewhere, so the end of that jog is the start of the next one; the
        firmware resolves a relative jog queued behind it from that same
        planned end. The start is uncertain only while the machine jogs
        toward an end this backend did not send.
        """
        status = link.status_now(1.0, routine=True)
        if status.state == "Jog" and self._jog_target is not None:
            return self._jog_target, True
        self._jog_target = None
        return status.joint, status.state == "Idle"

    def _send_jog(self, link: Link, lines: list[str], end: tuple[float, float] | None) -> None:
        try:
            for line in lines:
                link.request_ok(line)
        except LinkError:
            self._jog_target = None
            raise
        self._jog_target = end

    def _check_reach(self, targets: list[tuple[tuple[float, float], bool]]) -> None:
        """A board move is refused whole when any of its lines would be.

        The firmware checks the soft limit a line at a time, and a move
        sent as several lines would run the ones inside the limit before
        the refusal came back, leaving the head at the limit rather than
        where it was.
        """
        try:
            limit = float(self.read_settings()["values"].get("r_max", 0) or 0)
        except (TypeError, ValueError):
            limit = 0.0
        if limit <= 0:
            return
        for joint, _ in targets:
            if abs(joint[0]) > limit + 1e-9:
                raise ValueError(f"out of reach: R{joint[0]:.3f} is past the soft limit r_max={limit:g}")

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
                x, y = board_of(status.joint)
                machine = {
                    "state": status.state,
                    "alarm": status.alarm,
                    "joint": {"r": status.r, "a": status.a, "z": status.z},
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
            "run": self.runner.snapshot(),
        }

    # --- events ---------------------------------------------------------------

    def _on_link_event(self, event: Event) -> None:
        if event.kind == "status":
            self.broadcast.publish_threadsafe({"type": "state", **self.snapshot()})
        elif event.kind == "console":
            self.broadcast.publish_threadsafe({"type": "console", **event.data})
        elif event.kind == "message":
            self.broadcast.publish_threadsafe({"type": "message", **event.data})
        elif event.kind == "banner":
            self.broadcast.publish_threadsafe({"type": "state", **self.snapshot()})
        elif event.kind == "disconnect":
            reason = event.data.get("reason", "")
            # A close the user asked for is news, not a fault.
            self.publish_message("info" if reason == "disconnected" else "error", f"link closed: {reason}")
            self.broadcast.publish_threadsafe({"type": "state", **self.snapshot()})

    def _publish_progress(self, progress: dict) -> None:
        self.broadcast.publish_threadsafe({"type": "progress", **progress})

    def publish_message(self, level: str, text: str) -> None:
        self.broadcast.publish_threadsafe({"type": "message", "level": level, "text": text})

    # --- moving -----------------------------------------------------------------

    def _slide_move(self, link: Link, line: str) -> dict:
        """One cross slide line. It leaves the beam where it is on the board,
        so a board jog still ends where the last one was going."""
        link.request_ok(line)
        return {"lines": [line]}

    def jog(self, body: JogBody) -> dict:
        link = self._movable()
        with self._move_lock:
            return self._jog(link, body)

    def _jog(self, link: Link, body: JogBody) -> dict:
        check_feed(body.feed)
        streamer = self.streamer()
        if body.kind == "joint":
            if body.dz is not None:
                if body.dr is not None or body.da is not None:
                    raise ValueError("the cross slide moves on its own: dz cannot be sent with dr or da")
                return self._slide_move(link, streamer.slide_jog(body.dz, body.feed))
            lines = [streamer.joint_jog(body.dr, body.da, body.feed)]
            start, known = self.move_start(link)
            # A relative jog's end is known when its start is.
            end = (start[0] + (body.dr or 0.0), start[1] + (body.da or 0.0)) if known else None
        elif body.kind == "board":
            start, _ = self.move_start(link)
            here = board_of(start)
            targets = streamer.board_targets(start, (here[0] + (body.dx or 0.0), here[1] + (body.dy or 0.0)))
            self._check_reach(targets)
            lines = streamer.jog_lines(targets, body.feed)
            end = targets[-1][0] if targets else start
        else:
            raise ValueError("kind must be joint or board")
        self._send_jog(link, lines, end)
        return {"lines": lines}

    def goto(self, body: GotoBody) -> dict:
        link = self._movable()
        with self._move_lock:
            return self._goto(link, body)

    def _goto(self, link: Link, body: GotoBody) -> dict:
        check_feed(body.feed)
        streamer = self.streamer()
        if body.kind == "joint":
            if body.z is not None:
                if body.r is not None or body.a is not None:
                    raise ValueError("the cross slide moves on its own: z cannot be sent with r or a")
                return self._slide_move(link, streamer.slide_goto(body.z, body.feed))
            lines = [streamer.joint_goto(body.r, body.a, body.feed)]
            start, known = self.move_start(link)
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
            start, known = self.move_start(link)
            # An axis left out keeps the coordinate the head will have
            # once the jog in progress ends, which is only known when the
            # start is: the reported position is one it is passing through.
            if (body.x is None or body.y is None) and not known:
                raise ValueError("give both x and y: where the head will stop is not known")
            here = board_of(start)
            target = (here[0] if body.x is None else body.x, here[1] if body.y is None else body.y)
            targets = streamer.board_targets(start, target)
            self._check_reach(targets)
            lines = streamer.jog_lines(targets, body.feed)
            end = targets[-1][0] if targets else start
        else:
            raise ValueError("kind must be joint or board")
        self._send_jog(link, lines, end)
        return {"lines": lines}

    def set_position(self, body: PositionBody) -> dict:
        link = self._movable()
        with self._move_lock:
            return self._set_position(link, body)

    def _set_position(self, link: Link, body: PositionBody) -> dict:
        words = []
        if body.r is not None:
            # Negative is allowed here: it declares the head parked on the
            # far side of the axis, which is where lining up leaves it.
            words.append(f"R{num(body.r)}")
        if body.a is not None:
            words.append(f"A{num(body.a, 4)}")
        if not words and body.z is None:
            raise ValueError("give r, a and/or z")
        self._jog_target = None
        if words:
            link.request_ok("set " + " ".join(words))
        if body.z is not None:
            # Z goes on a line of its own: it is never a word beside R or A.
            link.request_ok(f"set Z{num(body.z)}")
        link.status_now(1.0, routine=True)
        return self.snapshot()

    def realtime(self, action: str) -> dict:
        link = self.require_link()
        if action == "hold":
            # A running job's hold goes through the runner so the run's own
            # state follows the machine's.
            if self.runner.progress.state == RUNNING:
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
            # them.
            self.runner.abort("reset by the operator")
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
        # A typed line may move the head or declare where it is, which
        # makes the end of the last jog meaningless as a starting point.
        self._jog_target = None
        lines = link.request(text)
        if text.startswith("$") and "=" in text:
            # A setting typed at the console: what this side remembers of
            # the machine's settings is stale.
            self._settings_cache = None
        return {"lines": lines}

    def laser(self, power: float, ms: int | None) -> dict:
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
        if self.runner.active:
            return self.snapshot()
        self.require_link().request_ok("laser off")
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
        link.request_ok("enable" if enabled else "disable")
        link.status_now(1.0, routine=True)
        return self.snapshot()

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
        return {"values": values, "schema": SETTINGS_SCHEMA, "host": {"tolerance": self.tolerance}}

    def write_settings(self, values: dict | None, host: dict | None) -> dict:
        """Settings to the machine and the host's own, all or nothing.

        Every entry is checked here before anything goes out; a value the
        machine still refuses has the ones sent before it put back. The
        host's tolerance is stored only once the machine's part is done.
        """
        tolerance = _tolerance(host["tolerance"]) if host and "tolerance" in host else None
        if values:
            link = self.require_link()
            current = self.read_settings(force=True)["values"]
            texts = {}
            for name, value in values.items():
                if name not in current:
                    raise ValueError(f"unknown setting {name!r}")
                texts[name] = _setting_text(name, value)
            applied: list[str] = []
            try:
                for name, text in texts.items():
                    if _number(text) == current[name]:
                        continue
                    link.request_ok(f"${name}={text}")
                    applied.append(name)
            except CommandError:
                self._restore_settings(link, {name: current[name] for name in applied})
                raise
            finally:
                self._settings_cache = None
        if tolerance is not None:
            self.config["tolerance"] = tolerance
            self._save_config()
        if self.link is not None and self.link.is_open:
            return self.read_settings(force=True)
        return {"values": {}, "schema": SETTINGS_SCHEMA, "host": {"tolerance": self.tolerance}}

    def _restore_settings(self, link: Link, previous: dict) -> None:
        """Put back settings a refused write had already changed."""
        for name, value in previous.items():
            try:
                link.request_ok(f"${name}={_setting_text(name, value)}")
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

    def run_job(self, job_id: str) -> dict:
        job = self.store.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="no such job")
        return self.runner.start(job, self.link, self.streamer())


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
    """The value of a `$name=value` line: a finite number, or a bool as 0/1.

    Anything else is refused here rather than sent for the machine to
    refuse after the entries before it have been applied.
    """
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str):
        value = _number(value.strip())
        if isinstance(value, str):
            raise ValueError(f"{name} must be a number")
        if isinstance(value, int):
            return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError(f"{name} must be a number")
        text = f"{value:.6f}".rstrip("0").rstrip(".")
        return text if text not in ("", "-") else "0"
    raise ValueError(f"{name} must be a number")


def _tolerance(value) -> float:
    """The host's chord tolerance in mm, checked."""
    if isinstance(value, bool):
        raise ValueError("tolerance must be a number")
    try:
        tolerance = float(value)
    except (TypeError, ValueError) as exc:
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
        except RunnerError as exc:
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
    def run_job(job_id: str):
        return guarded(lambda: backend.run_job(job_id))

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
