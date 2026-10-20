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
import os
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
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict

from spinny_laser import machines as machine_files
from spinny_laser import pads as board_pads
from spinny_laser.cam import CamError

from . import __version__, center
from .align import Alignment
from .cam import NotFound, ProfileStore, build_job, gcode_of
from .camera import Camera, CameraError, MachineAccess
from .heightmap import (
    AUTO,
    FOCUS,
    MODES,
    OFF,
    POWER,
    Compensation,
    Grid,
    HeightMap,
    HeightMapStore,
    check_covers,
    estimate_points_seconds,
    job_extent,
    nearest_clear_point,
)
from .jobs import (
    DEFAULT_THICKNESS,
    DISPENSER,
    MODE_DISPENSE,
    Group,
    ImportOptions,
    Job,
    JobImportError,
    JobPatch,
    JobStore,
    apply_patch,
    check_thickness,
    import_file,
)
from .machines import MachineStore
from .kinematics import (
    DEFAULT_TOLERANCE,
    CartesianStreamer,
    Dispense,
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
from .log import LEVELS, log, path_for as log_path, setup as setup_log, tail as log_tail, wire_line, wire_note
from .prober import Prober, ProberError, ProbeSettings, reach_joint
from .resume import PositionStore, ResumeStore
from .runner import HOLD, RUNNING, Runner, RunnerError, halt
from .vision import VisionError

# The repository's layout gives the defaults: the page's build beside this
# package, and the runtime files (jobs, config, height map) in var/ at the
# root, out of the source tree.
REPO_ROOT = Path(__file__).resolve().parents[4]
DATA_DIR = REPO_ROOT / "var"
MACHINES_DIR = REPO_ROOT / "machines"
CAM_DIR = REPO_ROOT / "cam"
FRONTEND_DIST = REPO_ROOT / "web" / "frontend" / "dist"
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
FRAME_SETTINGS = frozenset({"r_steps", "a_steps", "z_steps", "h_steps", "dir_invert", "cartesian", "h_axis", "sockets"})

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
    {"name": "h_axis", "unit": "0/1", "help": "1 = a focus axis is fitted, on its socket in sockets"},
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
    {"name": "sockets", "unit": "RAZH", "help": "driver socket per axis, rail, table, slide, focus: 1 X, 2 Y, 3 Z, 4 E, each once; 1234 as labeled"},
    {"name": "laser_pin", "unit": "GPIO", "help": "laser or spindle PWM output: 20 FAN3, 17 FAN1, 18 FAN2, 23 HE, 21 BED, 29 SERVO; read at boot, so save and restart"},
    {"name": "probe_pin", "unit": "GPIO", "help": "probe input, pulled up: 25 Z-STOP, 22 PROBE, 4 X-STOP, 3 Y-STOP, 16 E-STOP; read at boot"},
    {"name": "tool_out", "unit": "0/1", "help": "1 = tool_pin follows the tool: on while a job runs, a beam is lit, a dwell burns or the spindle turns; read at boot"},
    {"name": "tool_pin", "unit": "GPIO", "help": "the tool output, 17 FAN1 by default; read at boot"},
    {"name": "tool_invert", "unit": "0/1", "help": "1 = tool output active low"},
    {"name": "r_stop", "unit": "", "help": "rail endstops: 0 none, 1 at the negative end, 2 at the positive end, 3 both on the one input"},
    {"name": "r_stop_pin", "unit": "GPIO", "help": "rail endstop input, pulled up: 4 X-STOP, 3 Y-STOP, 16 E-STOP, 22 PROBE; read at boot"},
    {"name": "r_home_pull", "unit": "mm", "help": "how far a home backs off the switch, and leaves the rail from it"},
    {"name": "r_home_pos", "unit": "mm", "help": "what the rail reads at its switch (the negative one of two)"},
    {"name": "r_home_travel", "unit": "mm", "help": "rail travel between its ends; a home seeks a tenth further, and the positive switch of two reads home_pos + this"},
    {"name": "a_stop", "unit": "", "help": "table endstops: 0 none, 1 negative end, 2 positive end, 3 both"},
    {"name": "a_stop_pin", "unit": "GPIO", "help": "table endstop input, pulled up; read at boot"},
    {"name": "a_home_pull", "unit": "deg", "help": "how far a home backs off the switch, and leaves the table from it"},
    {"name": "a_home_pos", "unit": "deg", "help": "what the table reads at its switch"},
    {"name": "a_home_travel", "unit": "deg", "help": "table travel between its ends; a home seeks a tenth further"},
    {"name": "h_stop", "unit": "", "help": "focus axis endstops: 0 none, 1 negative end, 2 positive end, 3 both"},
    {"name": "h_stop_pin", "unit": "GPIO", "help": "focus axis endstop input, pulled up; read at boot"},
    {"name": "h_home_pull", "unit": "mm", "help": "how far a home backs off the switch, and leaves the head from it"},
    {"name": "h_home_pos", "unit": "mm", "help": "what the focus axis reads at its switch"},
    {"name": "h_home_travel", "unit": "mm", "help": "focus axis travel between its ends; a home seeks a tenth further"},
    {"name": "z_stop", "unit": "", "help": "cross slide endstops: 0 none, 1 negative end, 2 positive end, 3 both"},
    {"name": "z_stop_pin", "unit": "GPIO", "help": "cross slide endstop input, pulled up; read at boot"},
    {"name": "z_home_pull", "unit": "mm", "help": "how far a home backs off the switch, and leaves the slide from it"},
    {"name": "z_home_pos", "unit": "mm", "help": "what the cross slide reads at its switch"},
    {"name": "z_home_travel", "unit": "mm", "help": "cross slide travel between its ends; a home seeks a tenth further"},
    {"name": "dispenser", "unit": "0/1", "help": "1 = the table's joint is a dispenser's plunger in mm (with cartesian)"},
    {"name": "stop_invert", "unit": "mask", "help": "endstop inputs active high: bit 0 rail, bit 1 table, bit 2 cross slide, bit 3 focus axis"},
    {"name": "limits", "unit": "mask", "help": "endstops that halt a move closing them (ALARM:4, position lost), same bits"},
]

# How long a home may take before the request gives up on it: every axis
# at its jog rate over its travel, twice, and the slow locate.
HOME_TIMEOUT = 600.0

POLAR, CARTESIAN = "polar", "cartesian"
LASER, SPINDLE = "laser", "spindle"
# What a dispensing run is made of when the config says nothing.
DISPENSE_DEFAULTS = {"gap": 0.1, "retract": 0.2, "output": 100.0, "extrude_rate": 60.0, "dwell_ms": 200}
# Pad probing: how small a pad the probe still lands on, mm^2, and how
# many points at most, by default.
PAD_MIN_AREA = 0.5
PAD_MAX_POINTS = 100
# The widest picture the page asks for, px.
FRAME_MIN_WIDTH, FRAME_MAX_WIDTH, FRAME_DEFAULT_WIDTH = 160, 4096, 640

NO_FRONTEND = """<!doctype html>
<html><head><meta charset="utf-8"><title>spinny</title></head>
<body style="font-family: sans-serif; margin: 2em">
<h1>spinny-web</h1>
<p>The page is not built. Run <code>bun run build</code> in <code>web/frontend</code>
(or <code>mise run web</code>) and restart the backend; the API is up at <code>/api</code>.</p>
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


class HomeBody(BaseModel):
    # Joint letters R, A, H and Z, each with an optional - or + for the
    # end to seek; empty for every axis with an endstop.
    axes: str = ""


class LaserBody(Finite):
    power: float
    ms: int | None = None


class SpindleBody(Finite):
    power: float


class ModeBody(BaseModel):
    mode: str


class ApplyMachineBody(BaseModel):
    """Also write the settings to flash once they are applied."""

    save: bool = False


class CamTextBody(BaseModel):
    text: str


class MachineTextBody(BaseModel):
    text: str


class CamPatchBody(BaseModel):
    # The table and the key: ["operations", 2, "depth"]; null takes the key out.
    path: list[str | int]
    value: Any = None


class CamGcodeBody(BaseModel):
    job: str


class SettingsBody(BaseModel):
    values: dict[str, Any] | None = None
    host: dict[str, Any] | None = None


class RunBody(BaseModel):
    # How the run follows the board's height: off, auto (the focus axis
    # when one is fitted, else power), focus or power.
    compensate: str = OFF


class ResumeBody(BaseModel):
    # The line of the job to pick it up at: the count of lines done, as the
    # progress reports it. With `rewind` the run starts over at the first
    # line of the path that line belongs to, so a count a line off cannot
    # leave a gap. `compensate` left out takes the way the run being
    # picked up followed the board.
    line: int
    rewind: bool = True
    compensate: str | None = None


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


class ProbeBody(Grid):
    # With `job`, only the points a cut of that job comes within `margin`
    # mm of are probed (half the job's spot added), the rest of the grid
    # left out. `resume` goes on with the stored map where it has no
    # height yet, whatever grid this body carries.
    job: str | None = None
    margin: float | None = None
    resume: bool = False


# How far a touch that ties the map keeps from a cut, mm, over half the
# job's spot: a probe down in a cut reads its floor as the copper's height.
TOUCH_CLEARANCE = 1.0

# How far from H 0 a probe may have found the copper, mm, for a spindle's
# run without the height map to go ahead: more than a board's relief, so
# a Z 0 set at one corner of the board passes, and a frame with the copper
# millimeters away does not.
SURFACE_TOLERANCE = 1.0


class TouchBody(BaseModel):
    # What one probe under the head is for: `map` ties the height map to
    # the focus axis frame in use by the shift it finds there; `zero`
    # makes the contact height H 0, for milling without a map.
    mode: str = "map"
    # Where the probe goes down: `here`, under the head as it stands, or
    # `nearest`, the probed point of the map nearest the tip that no cut
    # of `job` comes within the clearance of, which the head goes to
    # first. The job is the page's, or the last run's when none is named.
    at: str = "here"
    job: str | None = None


class PadsBody(BaseModel):
    # Probing at a job's pads: those of at least `min_area` mm^2, at most
    # `max_points` of them spread over the board; `resume` goes on with
    # the pad map in the store.
    job: str | None = None
    min_area: float = PAD_MIN_AREA
    max_points: int = PAD_MAX_POINTS
    resume: bool = False


class CameraSettingsBody(Finite):
    device: str | None = None
    size: str | None = None
    fps: int | None = None
    pcbv: str | None = None
    side: str | None = None
    finish: str | None = None
    offset: tuple[float, float] | None = None
    roll: float | None = None
    mm_per_px: float | None = None


class CameraBoardBody(BaseModel):
    job: str | None = None


class CameraMarkBody(Finite):
    # A mark cut with the tool where it stands: how deep and how fast the
    # plunge; `here` only records the tool's point as the mark.
    depth: float = 0.1
    plunge: float = 30.0
    speed: float | None = None
    here: bool = False


class CameraFindBody(Finite):
    step: float = 2.0


class AlignMarkBody(Finite):
    job: str
    design: tuple[float, float] | None = None
    nearest: str | None = None
    within: float = 5.0


class AlignJobBody(BaseModel):
    job: str


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
        root: Path = DATA_DIR,
        link_factory: Callable[[str], Link] | None = None,
        jobs_dir: Path | None = None,
        config_path: Path | None = None,
        heightmap_path: Path | None = None,
        machines_dir: Path | None = None,
        cam_dir: Path | None = None,
    ) -> None:
        self.root = root
        self.machines_dir = machines_dir if machines_dir is not None else MACHINES_DIR
        self.machine_store = MachineStore(self.machines_dir)
        self.cam = ProfileStore(cam_dir if cam_dir is not None else CAM_DIR)
        self.config_path = config_path or root / "config.json"
        self.config = self._load_config()
        self.store = JobStore(jobs_dir if jobs_dir is not None else root / "jobs")
        self.heightmaps = HeightMapStore(heightmap_path or self.config_path.parent / "heightmap.json")
        self.resume_store = ResumeStore(self.config_path.parent / "resume.json")
        # Where the machine last said it was, for a controller that counts
        # from zero again after a power cycle.
        self.position_store = PositionStore(self.config_path.parent / "position.json")
        self.link_factory = link_factory or (lambda url: Link(url))
        self.link: Link | None = None
        self.url: str | None = self.config.get("last_url")
        self.broadcast = Broadcast()
        self.runner = Runner(publish=self._publish_progress, message=self.publish_message, checkpoint=self._checkpoint)
        self._run_state_logged: tuple[str | None, str] | None = None
        # A url, or `auto`, to keep a link open to without a page; None
        # leaves connecting to the operator.
        self.autoconnect: str | None = None
        self.autoconnect_paused = False
        self._autoconnect_failed: str | None = None
        self.prober = Prober(self.heightmaps, publish=self._publish_probe, message=self.publish_message)
        # The camera on the head, through pcbv, and the marks that line a
        # job up with the board.
        self.camera = Camera(self.config, self._save_config, self.publish_camera, self.publish_message)
        self.alignment = Alignment()
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
        # The last `boot ...` line reported, so the same one is not a fault twice.
        self._boot_reported: str | None = None
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
        # Where a probe last found the copper, (frame, H): what a spindle's
        # run without the height map is checked against, since it takes
        # H 0 for the copper.
        self._contact: tuple[int, float] | None = None

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
            self.config_path.parent.mkdir(parents=True, exist_ok=True)
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
        """The host's milling settings, the defaults for any that do not
        hold. With the spindle's speed control off, every spindle line asks
        for `s_max`, the full duty, whatever a group's speed says."""
        full = None
        if not self.speed_control:
            cached = self._settings_cache
            s_max = cached[1].get("s_max") if cached is not None else None
            full = float(s_max) if isinstance(s_max, (int, float)) and s_max > 0 else 1000.0
        try:
            return Spindle(
                clearance=float(self.config.get("clearance", Spindle.clearance)),
                spinup=float(self.config.get("spinup", Spindle.spinup)),
                full=full,
            )
        except (TypeError, ValueError):
            return Spindle(full=full)

    @property
    def speed_control(self) -> bool:
        """Whether the host sets the spindle's speed from the groups; off,
        the spindle runs full on whenever it runs."""
        return bool(self.config.get("speed_control", True))

    def dispense_config(self) -> Dispense:
        """What a dot of paste is made of, from the config; the defaults
        where it says nothing or something unusable."""
        values = {key: _host_number(self.config, key, float(default)) for key, default in DISPENSE_DEFAULTS.items()}
        try:
            return Dispense(
                clearance=self.spindle_config().clearance,
                gap=values["gap"],
                retract=values["retract"],
                output=values["output"],
                rate=values["extrude_rate"],
                dwell_ms=int(values["dwell_ms"]),
            )
        except (TypeError, ValueError):
            return Dispense(clearance=self.spindle_config().clearance)

    def host_settings(self) -> dict:
        spindle = self.spindle_config()
        dispense = self.dispense_config()
        return {
            "tolerance": self.tolerance,
            "clearance": spindle.clearance,
            "spinup": spindle.spinup,
            "speed_control": self.speed_control,
            "gap": dispense.gap,
            "retract": dispense.retract,
            "output": dispense.output,
            "extrude_rate": dispense.rate,
            "dwell_ms": dispense.dwell_ms,
        }

    @property
    def cartesian(self) -> bool:
        return self.profile["kinematics"] == CARTESIAN

    @property
    def milling(self) -> bool:
        return self.profile["tool"] == SPINDLE

    @property
    def dispensing(self) -> bool:
        return self.profile["tool"] == DISPENSER

    def table_angle(self, status) -> float:
        """The table's angle a status reports: on a dispenser `A` is the
        plunger, and the table holds at zero."""
        return 0.0 if self.dispensing else float(status.a)

    def streamer(self, status=None) -> Streamer:
        """The streamer for the machine as its settings were last read. A
        cartesian one works in the frame of the table angle in `status`, or
        in the last status polled."""
        spindle = self.spindle_config() if self.milling else None
        dispense = self.dispense_config() if self.dispensing else None
        if self.cartesian:
            if status is None and self.link is not None and self.link.is_open:
                status = self.link.status
            angle = self.table_angle(status) if status is not None else 0.0
            return CartesianStreamer(angle=angle, tolerance=self.tolerance, rates=self.rates, spindle=spindle, dispense=dispense)
        return Streamer(tolerance=self.tolerance, rates=self.rates, spindle=spindle, dispense=dispense)

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
            self.autoconnect_paused = False
        if link.banner is None:
            self.publish_message("error", f"no banner from {url}: is that the firmware?")
        else:
            self.publish_message("info", f"connected to {url}, firmware v{link.banner.version}")
        log.info("link opened: %s", url)
        wire_note(f"link opened: {url}")
        # Nothing says the focus axis is where it was: the machine may have
        # been powered off, or moved by hand, since the offset was set.
        self._frame_changed("connected")
        try:
            link.status_now(1.0, routine=True)
            self.read_settings(force=True)
        except (LinkError, HTTPException):
            pass
        self._ask_diag(link)
        return self.snapshot()

    @staticmethod
    def _ask_diag(link: Link) -> None:
        """Asks the firmware for its diagnostics: why it last started and
        its counters, which arrive as messages and so go to the log. An
        older firmware refuses the line, which is as good an answer."""
        try:
            link.request("diag", timeout=1.0)
        except LinkError:
            pass

    def disconnect(self) -> dict:
        with self._lock:
            if self.link is not None:
                log.info("link closed by the operator: %s", self.link.url)
            self._close_link()
            # An operator who closed the link does not want it opened again
            # behind their back; the next connect lifts this.
            self.autoconnect_paused = True
        return self.snapshot()

    def autoconnect_url(self) -> str | None:
        """Where `autoconnect` connects: the url given, or for `auto` the
        port that announces itself as the controller, else the last url."""
        wanted = self.autoconnect
        if not wanted:
            return None
        if wanted != "auto":
            return wanted
        for port in self.ports()["ports"]:
            if port.get("spinny"):
                return str(port["url"])
        last = self.config.get("last_url")
        return str(last) if last else None

    def autoconnect_tick(self) -> None:
        """Connects when nothing is, for a host told to keep a link up: a
        controller plugged in, or one that went quiet and was given up, is
        taken up again without a page open. Nothing happens while the
        operator has closed the link themselves."""
        if not self.autoconnect or self.autoconnect_paused:
            return
        if self.link is not None and self.link.is_open:
            return
        url = self.autoconnect_url()
        if url is None:
            return
        try:
            self.connect(url)
        except (LinkError, ValueError, HTTPException) as exc:
            detail = getattr(exc, "detail", None) or str(exc)
            if self._autoconnect_failed != url:
                self._autoconnect_failed = url
                log.error("autoconnect to %s failed: %s", url, detail)
            return
        self._autoconnect_failed = None

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
        self.position_store.flush()
        self.link = None
        self._jog_target = None

    def _output_off(self, link: Link) -> None:
        """Stops a turning spindle or a lit beam before the port closes.

        The board stops everything when the port closes (the host's DTR
        drops), but as a reset, which lands on a move as an alarm with the
        position lost; a program that opens the port without raising DTR,
        and the virtual firmware over a socket, see no close at all, and a
        spindle has no timeout. On an idle machine `laser off` stops
        either. A machine that is moving or held, or one that does not
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
        self.camera.shutdown()
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
        if self.camera.routine_active:
            raise HTTPException(status_code=409, detail="the camera is finding the mark")
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
                x, y = head_board(status.r, self.table_angle(status), status.z, self.cartesian)
                machine = {
                    "state": status.state,
                    "alarm": status.alarm,
                    "joint": {"r": status.r, "a": status.a, "z": status.z, "h": status.h},
                    "probe": status.probe,
                    "homed": status.homed,
                    "board": {"x": round(x, 4), "y": round(y, 4)},
                    "rate": status.rate,
                    "laser": status.laser,
                    "mode": status.mode,
                    "enabled": status.enabled,
                    "queue": {"planner": status.planner, "lines": status.lines},
                    # How old the report is, s: a machine that has gone
                    # quiet shows here before the link gives it up.
                    "age": round(link.age, 1),
                }
        return {
            "connected": connected,
            "url": self.url,
            "firmware": firmware,
            "machine": machine,
            "profile": self.profile,
            "run": self.runner.snapshot(),
            "resume": self.resume_store.get(),
            "position": self.position_store.get(),
        }

    # --- events ---------------------------------------------------------------

    def _on_link_event(self, event: Event) -> None:
        if event.kind == "status":
            self.position_store.note(event.data)
            self._check_restart()
            self.broadcast.publish_threadsafe({"type": "state", **self.snapshot()})
        elif event.kind == "console":
            data = event.data
            wire_line(str(data.get("dir", "")), str(data.get("text", "")), bool(data.get("poll")))
            self.broadcast.publish_threadsafe({"type": "console", **event.data})
        elif event.kind == "message":
            text = event.data.get("text", "")
            if text.startswith("boot "):
                # The board says why it started at every open of its port,
                # so a fault in the life before this one would come back as
                # an error at every reconnect; said once, it is news after.
                if text == self._boot_reported:
                    event = Event("message", {**event.data, "level": "info"})
                self._boot_reported = text
            # The machine's own words go to the log with the backend's: a
            # reset, an alarm, why it booted, its diagnostics.
            (log.error if event.data.get("level") == "error" else log.info)("machine: %s", text)
            wire_note(f"message: {text}")
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
            banner = event.data
            log.info("machine banner: firmware v%s, %s line slots, %s blocks", banner.version, banner.lines, banner.blocks)
            wire_note(f"banner: firmware v{banner.version}")
            self.broadcast.publish_threadsafe({"type": "state", **self.snapshot()})
        elif event.kind == "disconnect":
            reason = event.data.get("reason", "")
            self.position_store.flush()
            wire_note(f"link closed: {reason}")
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

    def _checkpoint(self, record: dict) -> None:
        """Keeps the resume record, and logs a run's state changes."""
        self.resume_store.put(record)
        key = (record.get("job"), str(record.get("state")))
        if key != self._run_state_logged:
            self._run_state_logged = key
            log.info(
                "run %s %s: %s sent / %s acked / %s%s%s",
                record.get("job"),
                record.get("state"),
                record.get("sent"),
                record.get("acked"),
                record.get("total"),
                f", picked up at line {record['resumed_from']}" if record.get("resumed_from") else "",
                f": {record['error']}" if record.get("error") else "",
            )

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

    def publish_camera(self) -> None:
        self.broadcast.publish_threadsafe({"type": "camera", **self.camera_state()})

    def publish_align(self) -> None:
        self.broadcast.publish_threadsafe({"type": "align", **self.alignment.state()})

    def publish_message(self, level: str, text: str) -> None:
        if level == "error":
            log.error("%s", text)
        else:
            log.info("%s", text)
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
        canceled = self.runner.cancel_start("the laser was turned off before it started")
        if self.runner.active and not canceled:
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
            full = self.spindle_config().full
            if full is not None and power > 0:
                # The speed is not the host's to set: on is full on.
                power = full
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

    def home(self, axes: str) -> dict:
        """Homes the axes named, or every one with an endstop. The firmware
        answers the line when the home ends, so this waits for it, as long
        as a home over the travel can take."""
        words = axes.split()
        for word in words:
            if not re.fullmatch(r"[RAHZrahz][-+]?", word):
                raise ValueError(f"not an axis to home: {word!r}; give R, A, H or Z, each with an optional - or +")
        line = " ".join(["home", *(word.upper() for word in words)])
        with self._owner_lock, self._move_lock:
            link = self._movable()
            self._jog_target = None
            try:
                link.request_ok(line, timeout=HOME_TIMEOUT)
            finally:
                # A home renumbers an axis as a `set` does: the frame the
                # height map's heights and points are in has moved.
                self._frame_changed("the machine was homed")
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
        return self._settings_response(values)

    def _settings_response(self, values: dict) -> dict:
        """The settings with the page's controls. The file the values are,
        every one of them, is named; the controls are that file's, or, for
        values that are no file's, those of the file last loaded from here
        or of the one file for this kind of machine, else the defaults for
        what the values say the machine is (spinny_laser.machines.controls_file)."""
        profile = self.profile
        loaded = self.config.get("last_machine")
        source = machine_files.controls_file(
            self.machine_list()[0], values, profile["kinematics"], profile["tool"], profile["h_axis"],
            loaded if isinstance(loaded, str) else None,
        )
        found = source if source is not None and machine_files.matches(source, values) else None
        return {
            "values": values,
            "schema": SETTINGS_SCHEMA,
            "host": self.host_settings(),
            "machine": found.id if found is not None else None,
            "controls_from": source.id if source is not None else None,
            "controls": source.controls if source is not None else controls_of(profile),
        }

    def write_settings(self, values: dict | None, host: dict | None) -> dict:
        """Settings to the machine and the host's own, all or nothing.

        Every entry is checked here before anything goes out; a value the
        machine still refuses has the ones sent before it put back. The
        host's tolerance is stored only once the machine's part is done.
        """
        tolerance = _tolerance(host["tolerance"]) if host and "tolerance" in host else None
        milling = None
        speed_control = None
        if host and "speed_control" in host:
            flag = host["speed_control"]
            if not isinstance(flag, (bool, int, float)) or isinstance(flag, float) and not math.isfinite(flag):
                raise ValueError("speed_control must be true or false")
            speed_control = bool(flag)
        if host and ("clearance" in host or "spinup" in host):
            current_spindle = self.spindle_config()
            try:
                milling = Spindle(
                    clearance=_host_number(host, "clearance", current_spindle.clearance),
                    spinup=_host_number(host, "spinup", current_spindle.spinup),
                )
            except (TypeError, ValueError) as exc:
                raise ValueError(str(exc)) from exc
        dispensing: dict | None = None
        if host and any(key in host for key in DISPENSE_DEFAULTS):
            current = self.dispense_config()
            try:
                checked = Dispense(
                    clearance=milling.clearance if milling is not None else current.clearance,
                    gap=_host_number(host, "gap", current.gap),
                    retract=_host_number(host, "retract", current.retract),
                    output=_host_number(host, "output", current.output),
                    rate=_host_number(host, "extrude_rate", current.rate),
                    dwell_ms=int(_host_number(host, "dwell_ms", float(current.dwell_ms))),
                )
            except (TypeError, ValueError) as exc:
                raise ValueError(str(exc)) from exc
            dispensing = {"gap": checked.gap, "retract": checked.retract, "output": checked.output, "extrude_rate": checked.rate, "dwell_ms": checked.dwell_ms}
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
        if speed_control is not None:
            self.config["speed_control"] = speed_control
        if dispensing is not None:
            self.config.update(dispensing)
        if tolerance is not None or milling is not None or speed_control is not None or dispensing is not None:
            self._save_config()
        if self.link is not None and self.link.is_open:
            return self.read_settings(force=True)
        return self._settings_response({})

    # --- machines -----------------------------------------------------------------

    def machine_list(self) -> tuple[list[machine_files.Machine], list[dict]]:
        """The machine files, read afresh so an edit shows at once, and
        the id and the problem of each one that cannot be taken."""
        return self.machine_store.list()

    def machines(self) -> dict:
        """Every machine file, and which one the connected machine's
        settings are; `None` with no machine connected or settings of no
        file's. A file that cannot be read is named with its problem."""
        found, problems = self.machine_list()
        current = None
        if self.link is not None and self.link.is_open:
            try:
                current = self.read_settings()["machine"]
            except (LinkError, CommandError, HTTPException):
                current = None
        return {"machines": [machine.summary() for machine in found], "current": current, "problems": problems}

    def machine(self, machine_id: str) -> machine_files.Machine:
        for machine in self.machine_list()[0]:
            if machine.id == machine_id:
                return machine
        raise HTTPException(status_code=404, detail=f"no machine file {machine_id!r}")

    def apply_machine(self, machine_id: str, save: bool = False) -> dict:
        """Writes a machine file's every setting and its host values, all or
        nothing as a settings write is, and saves them to flash if asked."""
        machine = self.machine(machine_id)
        # A controller that lists none of a file's settings runs firmware
        # older than the file: name them all, not just the first refused.
        known = self.read_settings(force=True)["values"]
        missing = [name for name in machine.settings if name not in known]
        if missing:
            raise ValueError(
                f"the controller does not have the settings {', '.join(missing)}: "
                f"its firmware predates them, flash the current firmware to load {machine_id!r}"
            )
        result = self.write_settings(dict(machine.settings), dict(machine.host) or None)
        if machine.camera:
            self.camera.update(dict(machine.camera))
            self.publish_camera()
        if self.config.get("last_machine") != machine_id:
            # Remembered, so the page keeps this file's controls once a
            # setting changed by hand makes the values no file's.
            self.config["last_machine"] = machine_id
            self._save_config()
            result = self._settings_response(result["values"])
        if save:
            self.save_settings()
        return result

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
                # As the firmware lists it: three decimals, so a finer value
                # already in force reads back a hair off and is not sent again.
                if machine_files.close(float(_number(text)), float(current[name])):
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
        """The serial ports on this host, the controller's own first.

        A USB port is listed under its stable `/dev/serial/by-id` name when
        the system gives it one, so the pick survives a replug that moves
        it from ttyACM0 to ttyACM1. `kind` tells the page what to hide:
        `usb` for a device with a vendor id, `system` for a built-in port
        such as ttyS0, which is never the controller.
        """
        from serial.tools import list_ports

        found = []
        try:
            by_id = _by_id_names()
            for port in list_ports.comports():
                vid = getattr(port, "vid", None)
                product = getattr(port, "product", None) or ""
                manufacturer = getattr(port, "manufacturer", None) or ""
                serial_number = getattr(port, "serial_number", None) or ""
                description = port.description or ""
                stable = by_id.get(port.device)
                words = " ".join((product, manufacturer, description)).lower()
                found.append(
                    {
                        "url": stable or port.device,
                        "device": port.device,
                        "description": description,
                        "product": product,
                        "manufacturer": manufacturer,
                        "serial": serial_number,
                        "vid": vid,
                        "pid": getattr(port, "pid", None),
                        "kind": "usb" if vid is not None else "system",
                        # The firmware announces itself as the spinny laser
                        # controller on the bus: the page picks that first.
                        "spinny": "spinny" in words,
                    }
                )
        except Exception as exc:
            log.error("listing the serial ports failed: %r", exc)
        found.sort(key=lambda entry: (not entry["spinny"], entry["kind"] != "usb", entry["url"]))
        last = self.config.get("last_url")
        if last and last not in [entry["url"] for entry in found] and last not in [entry.get("device") for entry in found]:
            found.append(
                {
                    "url": last,
                    "device": last,
                    "description": "last used",
                    "product": "",
                    "manufacturer": "",
                    "serial": "",
                    "vid": None,
                    "pid": None,
                    "kind": "last",
                    "spinny": False,
                }
            )
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
        job = self.store.add(job)
        if job.design is not None:
            kept = path.suffix.lower() == ".kicad_pcb" and self.store.keep_board(job.id, data)
            if job.design.board != kept:
                job.design.board = kept
                self.store.save(job)
        return job

    def cam_import(self, profile_id: str, files: list[tuple[str, bytes]], name: str | None) -> dict:
        """The uploaded files through a CAM profile into a stored job: a board
        (a KiCad file, or a copper gerber with its outline and drill file
        beside it), an SVG, an X/Y gcode file or a job."""
        import tempfile

        profile = self.cam.get(profile_id)
        names = [Path(filename or "upload").name for filename, _ in files]
        if not files or any(not n or n.startswith(".") for n in names):
            raise JobImportError("the upload needs file names with suffixes")
        try:
            with tempfile.TemporaryDirectory(prefix="spinny-cam-") as folder:
                for filename, data in zip(names, (data for _, data in files)):
                    (Path(folder) / filename).write_bytes(data)
                job, notes = build_job(profile, Path(folder), name, self.streamer())
        except OSError as exc:
            raise JobImportError(f"cannot store the upload: {exc}") from exc
        return {"job": self.store.add(job).model_dump(), "notes": notes}

    def cam_gcode(self, profile_id: str, job_id: str) -> dict:
        profile = self.cam.get(profile_id)
        job = self.store.get(job_id)
        if job is None:
            raise NotFound(f"no job {job_id!r}")
        return gcode_of(job, profile)

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
                if self.dispensing and not values.get("h_axis"):
                    raise ValueError("a dispenser needs the focus axis as the needle's height: set $h_axis=1")
            compensation = self.compensation(compensate, job)
            # A cartesian plan is made in the frame of the table as it is now.
            status = None
            if self.cartesian and self.link is not None and self.link.is_open:
                status = self.link.status_now(1.0, routine=True)
            return self.runner.start(job, self.link, self.streamer(status), compensation, restarts, reserved=True)
        finally:
            self.runner.release()

    def resume_job(self, job_id: str, body: ResumeBody, dry_run: bool = False) -> dict:
        """Picks `job_id` up at a line: the lines before it count as done,
        the head is brought from where it stands to where that line
        begins, and the job goes on from there.

        The plan is made from where the run being picked up began, when
        the resume record is that run's, so its lines are the ones that
        were counted; otherwise from where the head is, which on a
        cartesian machine changes at most the first rapid. `dry_run` only
        says what would happen: the line picked, and how the head gets
        there.
        """
        with self._owner_lock:
            job = self.store.get(job_id)
            if job is None:
                raise HTTPException(status_code=404, detail="no such job")
            if self.prober.active:
                raise HTTPException(status_code=409, detail="the board is being probed")
            record = self.resume_store.get()
            theirs = record is not None and record.get("job") == job_id
            compensate = body.compensate
            if compensate is None:
                compensate = str(record.get("compensate", OFF)) if theirs and record is not None else OFF
            if body.line < 0:
                raise ValueError("the line to pick the job up at cannot be negative")
            self.runner.reserve(self.link)
            try:
                link = self.require_link()
                restarts = link.restarts
                values = self.read_settings(force=True)["values"]
                if self.milling and not values.get("h_axis"):
                    raise ValueError("a spindle needs the focus axis as its depth axis: set $h_axis=1")
                if self.dispensing and not values.get("h_axis"):
                    raise ValueError("a dispenser needs the focus axis as the needle's height: set $h_axis=1")
                compensation = self.compensation(compensate, job)
                status = link.status_now(1.0, routine=True)
                streamer = self.streamer(status)
                plan_start: tuple[float, float] | None = None
                if theirs and record is not None and isinstance(record.get("start"), list) and len(record["start"]) == 2:
                    if bool(record.get("cartesian", False)) == streamer.cartesian:
                        plan_start = (float(record["start"][0]), float(record["start"][1]))
                if plan_start is None:
                    plan_start = streamer.start_of(status)
                pieces = list(streamer.job_pieces(job, plan_start, compensation))
                line = min(body.line, len(pieces))
                skip = streamer.rewind(pieces, line) if body.rewind else line
                if dry_run:
                    approach = streamer.approach(pieces, skip, job, compensation)
                    renumber = streamer.renumber_for(pieces, skip, status)
                    if renumber is not None:
                        approach.insert(0, renumber)
                    return {
                        "job": job_id,
                        "line": line,
                        "skip": skip,
                        "total": len(pieces),
                        "compensate": compensate,
                        "planned_from_record": theirs and plan_start is not None and record is not None and record.get("start") is not None,
                        "next": pieces[skip].line if skip < len(pieces) else None,
                        "group": pieces[skip].group if skip < len(pieces) else None,
                        "approach": approach,
                    }
                return self.runner.start(
                    job,
                    link,
                    streamer,
                    compensation,
                    restarts,
                    reserved=True,
                    skip=skip,
                    pieces=pieces,
                    plan_start=plan_start,
                )
            finally:
                self.runner.release()

    def delete_all_jobs(self) -> dict:
        """Removes every job but the one running."""
        running = self.runner.progress.job if self.runner.active else None
        removed = []
        for job in list(self.store.list()):
            if job.id == running:
                continue
            if self.store.remove(job.id):
                removed.append(job.id)
        log.info("deleted %d jobs", len(removed))
        return {"deleted": removed, "kept": [running] if running else []}

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

    def probe_grid(self, body: Grid) -> tuple[Grid, HeightMap | None]:
        """The grid a probe request asks for, and the map to go on with
        when it asks to resume. A plain grid is probed whole."""
        job_id = getattr(body, "job", None)
        margin_given = getattr(body, "margin", None)
        if getattr(body, "resume", False):
            heightmap = self.heightmaps.get()
            if heightmap is None:
                raise ValueError("there is no height map to go on with: probe the board first")
            if heightmap.complete:
                raise ValueError("the height map is complete: nothing is left to probe")
            return heightmap.grid, heightmap
        grid = Grid(x0=body.x0, y0=body.y0, x1=body.x1, y1=body.y1, nx=body.nx, ny=body.ny, mask=body.mask)
        grid.check()
        if job_id is not None:
            job = self.store.get(job_id)
            if job is None:
                raise HTTPException(status_code=404, detail="no such job")
            margin = float(margin_given) if margin_given is not None else 1.0
            if not (math.isfinite(margin) and 0.0 <= margin <= 100.0):
                raise ValueError("the margin must be 0 to 100 mm")
            grid = grid.with_mask_for(job, margin, float(job.spot or 0.0))
        return grid, None

    def probe_estimate(self, body: ProbeBody) -> dict:
        """About how long probing `body` would take, and the grid it would
        probe, mask included, without touching the machine."""
        grid, resume = self.probe_grid(body)
        settings = self.probe_settings()
        points = len(resume.remaining()) if resume is not None else grid.points
        seconds = grid.estimate_seconds(settings, self.rates, self.cartesian)
        if resume is not None and grid.points > 0:
            seconds = seconds * points / grid.points
        return {"seconds": round(seconds, 1), "points": points, "grid": grid.model_dump()}

    def start_probe(self, body: Grid) -> dict:
        grid, resume = self.probe_grid(body)
        # The check that no run is under way and the prober's claim are one
        # step: a run asked for at the same moment waits for this, then
        # finds the board being probed.
        with self._owner_lock:
            link = self._movable()
            # Claimed before the settings are read: a stop or reset while
            # they are keeps the probing from starting.
            self.prober.reserve(link)
            try:
                r_max, z_max = _soft_limits(self.read_settings(force=True)["values"])
                # The tool may be the probe: a spindle has to be stopped.
                spindle_off = self._off_duty() if self.milling else None
                with self._move_lock:
                    self._jog_target = None
                    status = link.status_now(1.0, routine=True)
                    frame = self._frame
                    if resume is not None and self._heights_frame != frame:
                        raise ValueError(
                            "the focus axis was renumbered since the map was probed (a connect, a restart or a"
                            " position set): its heights and the new ones would not agree, so probe it anew"
                        )
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
                        resume=resume,
                    )
                    self._heights_frame = frame
            finally:
                # A start that went through has let go of the claim already.
                self.prober.release()
        log.info("probing started: %d points%s", len(resume.remaining()) if resume is not None else grid.points, ", going on with the map" if resume is not None else "")
        return self.heightmap_state()

    def touch_probe(self, body: TouchBody, dry_run: bool = False) -> dict:
        """One probe down where the head is or, `at` nearest, at the probed
        point of the map nearest the tip that the job's cuts leave clear,
        which the head goes to first. With `map`, the height found ties
        the height map to the focus axis frame in use: the offset moves
        by what the surface reads there against what the map says, so a
        map probed before a power cycle, a restart or a position set
        follows the board again without probing it all over. With `zero`
        the contact height becomes H 0. `dry_run` only says where the
        probe would go down, and how the head gets there.
        """
        if body.mode not in ("map", "zero"):
            raise ValueError("mode must be map or zero")
        if body.at not in ("here", "nearest"):
            raise ValueError("at must be here or nearest")
        if body.mode == "map" and self.heightmaps.get() is None:
            raise ValueError("there is no height map to tie: probe the board, or probe here for H 0")
        job = None
        if body.at == "nearest":
            if body.mode != "map":
                raise ValueError("the nearest probed point is for tying the map: H 0 is set where the head is")
            job = self._touch_job(body.job)
        with self._owner_lock:
            link = self._movable()
            self.prober.reserve(link)
            try:
                r_max, z_max = _soft_limits(self.read_settings(force=True)["values"])
                spindle_off = self._off_duty() if self.milling else None
                with self._move_lock:
                    self._jog_target = None
                    status = link.status_now(1.0, routine=True)
                    frame = self._frame
                    settings = self.probe_settings()
                    streamer = self.streamer(status)
                    tip = _tip_point(status, settings.offset, self.cartesian, self.table_angle(status))
                    target = None
                    found = None
                    if job is not None:
                        heightmap = self.heightmaps.get()
                        if heightmap is None:
                            raise ValueError("there is no height map to tie: probe the board first")
                        clearance = TOUCH_CLEARANCE + float(job.spot or 0.0) / 2.0
                        found = nearest_clear_point(heightmap, job, tip, clearance)
                        if found is None:
                            raise ValueError(
                                f"no probed point of the map is {clearance:g} mm clear of the job's cuts:"
                                " jog the tip over copper the map covers and probe here"
                            )
                        tip = found[1]
                        # Refused past a soft limit before anything moves,
                        # as a grid's points are.
                        target = reach_joint(tip, settings.offset, streamer, self.table_angle(status), 0.0, r_max, z_max)
                    if dry_run:
                        return {
                            "point": [round(tip[0], 4), round(tip[1], 4)],
                            "index": list(found[0]) if found is not None else None,
                            "distance": round(found[2], 3) if found is not None else 0.0,
                            "lines": [f"go {streamer.words(target)}"] if target is not None else [],
                        }

                    def touched(height: float, travel: float) -> None:
                        self._touched(link, body.mode, height, travel, tip, frame)

                    self.prober.start(
                        Grid(x0=-1.0, y0=-1.0, x1=1.0, y1=1.0, nx=2, ny=2),
                        settings,
                        link,
                        streamer,
                        r_max,
                        z_max,
                        spindle_off,
                        reserved=True,
                        touch=touched,
                        target=target,
                    )
            finally:
                self.prober.release()
        log.info(
            "probing one point %s, for %s",
            f"at ({tip[0]:.2f}, {tip[1]:.2f}), the nearest clear of the cuts" if target is not None else "under the head",
            "the map's frame" if body.mode == "map" else "H 0",
        )
        return self.heightmap_state()

    def _touch_job(self, job_id: str | None) -> Job:
        """The job whose cuts a touch keeps clear of: the one named, else
        the last run's, whose cuts are the ones in the copper."""
        if job_id is None:
            record = self.resume_store.get()
            if record is not None and record.get("job"):
                job_id = str(record["job"])
        if job_id is None:
            raise ValueError("the nearest point clear of the cuts needs a job: load one, or run one first")
        job = self.store.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="no such job")
        return job

    def _touched(self, link: Link, mode: str, height: float, travel: float, tip: tuple[float, float], frame: int) -> None:
        """What a probe under the head found, with the head back up at rest.
        Runs on the probing thread, which owns the machine."""
        if mode == "zero":
            # The head is at the travel height; the contact height is to
            # read 0, so the head reads how far above it it stands.
            link.request_ok(f"set H{num(travel - height, 4)}")
            self._frame_changed("the surface was probed")
            with self._map_lock:
                self._contact = (self._frame, 0.0)
            try:
                link.status_now(1.0, routine=True)
            except LinkError:
                pass
            self.publish_message("info", f"H 0 is now the surface probed here (it read {height:.4f})")
            return
        x, y = tip
        with self._map_lock:
            heightmap = self.heightmaps.get()
            if heightmap is None:
                raise ValueError("the height map went away while probing")
            if self._frame != frame:
                raise ValueError("the focus axis frame changed while probing: probe here again")
            grid = heightmap.grid
            if not grid.covers((x, y, x, y)):
                raise ValueError(
                    f"probe over the map: the tip is at X {x:.1f} Y {y:.1f}, the map covers"
                    f" X {grid.x0:.1f}..{grid.x1:.1f} Y {grid.y0:.1f}..{grid.y1:.1f}"
                )
            if not heightmap.cell_probed(x, y):
                raise ValueError(f"the map was not probed around X {x:.1f} Y {y:.1f}: probe over a probed cell")
            mapped = heightmap.height_at(x, y)
            # The frame in use against the one the heights are in. The
            # offset is the gap over the contact plus this shift: measured
            # from the gap, so a second tie in the same frame finds the
            # same shift and leaves the offset where it is.
            shift = height - mapped
            if heightmap.focus_gap is not None:
                gap = heightmap.focus_gap
                offset = gap + shift
            elif heightmap.focus_set:
                # Focused in this frame with the gap unknown: the offset
                # is right as it stands, and the touch says what the gap is.
                offset = heightmap.focus_offset
                gap = offset - shift
            elif self.milling:
                # The tool is the probe: contact is where the tool meets
                # the copper, and the map's heights were that too.
                gap = 0.0
                offset = shift
            else:
                raise ValueError(
                    "the map has never been focused: focus the beam by eye over it first (focus here);"
                    " a probe here can then tie it to a new frame"
                )
            heightmap.focus_offset = round(offset, 4)
            heightmap.focus_gap = round(gap, 4)
            heightmap.focus_set = True
            heightmap.focus_known = True
            self.heightmaps.put(heightmap)
            self._focus_frame = frame
            self._contact = (frame, height)
        self.publish_heightmap()
        self.publish_message(
            "info",
            f"height map tied to this frame: the surface at X {x:.1f} Y {y:.1f} reads {height:.4f},"
            f" {shift:+.4f} against the map; focus offset {offset:.4f} ({gap:+.4f} over the contact)",
        )

    def stop_probe(self) -> dict:
        self.prober.stop()
        return self.heightmap_state()

    # --- pad probing ----------------------------------------------------------------

    def pad_points(self, body: PadsBody) -> tuple[list[tuple[float, float]], dict, HeightMap | None, tuple | None]:
        """The points a pad probing would probe, in order, with what was
        left out; the map to go on with when resuming; and the box the
        map's grid covers."""
        if body.resume:
            heightmap = self.heightmaps.get()
            if heightmap is None or heightmap.points is None:
                raise ValueError("there is no pad map to go on with: probe the pads first")
            if heightmap.complete:
                raise ValueError("the pad map is complete: nothing is left to probe")
            left = [heightmap.points[ix] for ix, _ in heightmap.remaining()]
            return left, {"pads": len(heightmap.points), "skipped": 0, "resume": heightmap.probed}, heightmap, None
        if body.job is None:
            raise ValueError("name the job whose pads to probe")
        job = self.store.get(body.job)
        if job is None:
            raise HTTPException(status_code=404, detail="no such job")
        if not (math.isfinite(body.min_area) and 0.05 <= body.min_area <= 1000.0):
            raise ValueError("min_area must be 0.05 to 1000 mm^2")
        if not 2 <= body.max_points <= 2500:
            raise ValueError("max_points must be 2 to 2500")
        if not job.pads:
            raise ValueError("the job has no pads: import it from a board, a KiCad file or a gerber")
        large = [(x, y) for x, y, area in job.pads if area >= body.min_area]
        if not large:
            raise ValueError(f"no pad of the job is {body.min_area:g} mm^2 or more: lower the least area")
        skipped = len(job.pads) - len(large)
        chosen = [large[i] for i in board_pads.spread(large, body.max_points)] if len(large) > body.max_points else large
        points = [chosen[i] for i in board_pads.tour(chosen)]
        box = job_extent(job)
        if box is None:
            xs = [p[0] for p in points]
            ys = [p[1] for p in points]
            box = (min(xs), min(ys), max(xs), max(ys))
        return points, {"pads": len(job.pads), "skipped": skipped, "resume": 0}, None, box

    def pads_plan(self, body: PadsBody) -> dict:
        points, counts, _, _ = self.pad_points(body)
        seconds = estimate_points_seconds(points, self.probe_settings(), self.rates)
        return {"points": [[round(x, 4), round(y, 4)] for x, y in points], "seconds": round(seconds, 1), **counts}

    def start_pads(self, body: PadsBody) -> dict:
        points, _, resume, box = self.pad_points(body)
        with self._owner_lock:
            link = self._movable()
            self.prober.reserve(link)
            try:
                r_max, z_max = _soft_limits(self.read_settings(force=True)["values"])
                spindle_off = self._off_duty() if self.milling else None
                with self._move_lock:
                    self._jog_target = None
                    status = link.status_now(1.0, routine=True)
                    frame = self._frame
                    if resume is not None and self._heights_frame != frame:
                        raise ValueError(
                            "the focus axis was renumbered since the map was probed (a connect, a restart or a"
                            " position set): its heights and the new ones would not agree, so probe it anew"
                        )
                    placeholder = resume.grid if resume is not None else Grid(x0=-1.0, y0=-1.0, x1=1.0, y1=1.0, nx=2, ny=2)
                    self.prober.start(
                        placeholder,
                        self.probe_settings(),
                        link,
                        self.streamer(status),
                        r_max,
                        z_max,
                        spindle_off,
                        keep_focus=self._heights_frame == frame,
                        reserved=True,
                        resume=resume,
                        points=resume.points if resume is not None else points,
                        box=box,
                    )
                    self._heights_frame = frame
            finally:
                self.prober.release()
        log.info("probing the pads: %d points%s", len(points), ", going on with the map" if resume is not None else "")
        return self.heightmap_state()

    # --- the camera -----------------------------------------------------------------

    def camera_state(self) -> dict:
        return self.camera.state(job_center=self._job_center)

    def _job_center(self, raw: dict) -> list | None:
        """The picture's center in the loaded job's frame, from a pose."""
        job_id = self.camera.board_job
        center = raw.get("center")
        if job_id is None or not isinstance(center, (list, tuple)) or len(center) != 2:
            return None
        job = self.store.get(job_id)
        if job is None or job.design is None:
            return None
        x, y = job.design.board_to_job((float(center[0]), float(center[1])))
        return [round(x, 4), round(y, 4)]

    def camera_settings(self, body: CameraSettingsBody) -> dict:
        patch = {key: value for key, value in body.model_dump().items() if value is not None}
        self.camera.update(patch)
        self.publish_camera()
        return self.camera_state()

    def camera_start(self) -> dict:
        self.camera.start()
        self.publish_camera()
        return self.camera_state()

    def camera_stop(self) -> dict:
        self.camera.stop()
        self.publish_camera()
        return self.camera_state()

    def camera_frame(self, width: int, overlay: bool) -> bytes:
        if not (FRAME_MIN_WIDTH <= width <= FRAME_MAX_WIDTH):
            raise ValueError(f"width must be {FRAME_MIN_WIDTH} to {FRAME_MAX_WIDTH}")
        return self.camera.frame(width, overlay)

    def camera_pose(self) -> dict:
        raw = self.camera.pose()
        if raw is None:
            return {"state": None, "job_center": None}
        from .camera import pose_summary

        pose = pose_summary(raw)
        if pose.get("state") == "locked":
            pose["job_center"] = self._job_center(raw)
        return pose

    def camera_board(self, job_id: str | None) -> dict:
        if job_id is None:
            self.camera.load_board(None, None)
        else:
            job = self.store.get(job_id)
            if job is None:
                raise HTTPException(status_code=404, detail="no such job")
            path = self.store.board_path(job_id)
            if job.design is None or not job.design.board or path is None:
                raise ValueError("the job was not imported from a KiCad board file kept here: the camera has nothing to look for")
            self.camera.load_board(job_id, str(path))
        self.publish_camera()
        return self.camera_state()

    def camera_mark(self, body: CameraMarkBody) -> dict:
        """Records the tool's point as the mark, and cuts it with the tool
        unless `here`."""
        if not (math.isfinite(body.depth) and 0.01 <= body.depth <= 5.0):
            raise ValueError("depth must be 0.01 to 5 mm")
        if not (math.isfinite(body.plunge) and 1.0 <= body.plunge <= 1000.0):
            raise ValueError("plunge must be 1 to 1000 mm/min")
        with self._owner_lock:
            link = self._movable()
            status = link.status_now(1.0, routine=True)
            point = head_board(status.r, self.table_angle(status), status.z, self.cartesian)
            if not body.here:
                if not self.milling:
                    raise ValueError("a mark is cut with a spindle: on another machine, make it by hand and say the mark is here")
                values = self.read_settings(force=True)["values"]
                if not values.get("h_axis"):
                    raise ValueError("a mark needs the depth axis: set $h_axis=1")
                speed = body.speed if body.speed is not None else float(values.get("s_max", 1000.0) or 1000.0)
                job = Job(
                    name="camera mark",
                    source="mark",
                    groups=[
                        Group(
                            label="camera mark",
                            power=speed,
                            speed=body.plunge,
                            depth=body.depth,
                            plunge=body.plunge,
                            tool=SPINDLE,
                            paths=[[(round(point[0], 4), round(point[1], 4))]],
                        )
                    ],
                )
                job.refresh_stats(self.streamer(status))
                job = self.store.add(job)
            self.camera.set_mark(point)
        if not body.here:
            self._run_job(job.id, OFF)
        self.publish_camera()
        return self.camera_state()

    def camera_find(self, step: float) -> dict:
        with self._owner_lock:
            link = self._movable()
            values = self.read_settings(force=True)["values"]
            status = link.status_now(1.0, routine=True)
            streamer = self.streamer(status)
            access = MachineAccess(
                link=link,
                streamer=streamer,
                head_point=lambda report: head_board(report.r, self.table_angle(report), report.z, self.cartesian),
                clearance=self.spindle_config().clearance,
                has_focus_axis=bool(values.get("h_axis")),
            )
            self.camera.find(access, step)
        return self.camera_state()

    def camera_abort(self) -> dict:
        self.camera.abort()
        return self.camera_state()

    # --- alignment ------------------------------------------------------------------

    def align_mark(self, body: AlignMarkBody) -> dict:
        job = self.store.get(body.job)
        if job is None:
            raise HTTPException(status_code=404, detail="no such job")
        with self._owner_lock:
            link = self._movable()
            status = link.status_now(1.0, routine=True)
        point = head_board(status.r, self.table_angle(status), status.z, self.cartesian)
        state = self.alignment.mark_tool(job, point, body.design, body.nearest, body.within)
        self.publish_align()
        return state

    def align_capture(self, job_id: str) -> dict:
        job = self.store.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="no such job")
        if not self.camera.running:
            raise CameraError("the camera is not running")
        if self.camera.board_job != job_id or job.design is None:
            raise CameraError("the camera is not looking for this job's board: load it first")
        raw = self.camera.pose()
        if raw is None or raw.get("state") != "locked" or not isinstance(raw.get("center"), (list, tuple)):
            raise CameraError("the camera has no lock on the board: move it over the board and wait for one")
        link = self.require_link()
        status = link.status_now(1.0, routine=True)
        head = head_board(status.r, self.table_angle(status), status.z, self.cartesian)
        settings = self.camera.settings()
        machine = (head[0] + settings.offset[0], head[1] + settings.offset[1])
        design = job.design.board_to_job((float(raw["center"][0]), float(raw["center"][1])))
        angle = None
        if settings.side == "front" and isinstance(raw.get("angle_deg"), (int, float)):
            # The picture's x axis points `roll` from board +X on the
            # machine and `angle_deg` from it on the design: the design is
            # turned by the difference.
            angle = settings.roll - float(raw["angle_deg"])
        state = self.alignment.mark_camera(job, design, machine, angle)
        self.publish_align()
        return state

    def align_remove(self, index: int) -> dict:
        try:
            state = self.alignment.remove(index)
        except IndexError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        self.publish_align()
        return state

    def align_clear(self) -> dict:
        state = self.alignment.clear()
        self.publish_align()
        return state

    def align_fit(self, job_id: str) -> dict:
        if self.store.get(job_id) is None:
            raise HTTPException(status_code=404, detail="no such job")
        return self.alignment.fit(job_id).to_dict()

    def align_apply(self, job_id: str) -> dict:
        job = self.store.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="no such job")
        if self.runner.active and self.runner.progress.job == job_id:
            raise HTTPException(status_code=409, detail="the job is running")
        updated, fit = self.alignment.apply(job)
        updated.refresh_stats(self.streamer())
        self.store.save(updated)
        self.publish_align()
        log.info("job %s aligned: turned %.4f degrees, moved (%.4f, %.4f), rms %.4f over %d marks", job_id, fit.rotation, fit.shift[0], fit.shift[1], fit.rms, fit.marks)
        return {"job": updated.model_dump(), "fit": fit.to_dict()}

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
                x, y = head_board(status.r, self.table_angle(status), status.z, self.cartesian)
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
            # In the heights' own frame the offset is the gap itself; set
            # from the head in another frame, the gap is unknown until a
            # tie measures the frame, and a gap from before does not
            # outlive a fresh focus by eye.
            heightmap.focus_gap = round(offset, 4) if self._heights_frame == frame else None
            heightmap.focus_set = True
            heightmap.focus_known = True
            self.heightmaps.put(heightmap)
            self._focus_frame = frame
        self.publish_heightmap()
        return self.heightmap_state()

    def _check_surface_at_zero(self) -> None:
        """A spindle's run without the height map cuts from H 0 as the
        copper's height. Refused when a probe in this frame found the
        copper well away from there: the run would cut in the air, or
        into the board. A frame nobody has probed in is let through, as
        before: the operator set Z 0 by hand, or means to."""
        if not self.milling:
            return
        with self._map_lock:
            contact = self._contact
        if contact is None or contact[0] != self._frame:
            return
        if abs(contact[1]) > SURFACE_TOLERANCE:
            raise ValueError(
                f"the copper reads H {contact[1]:.3f} where it was last probed, but without the height map"
                " the run cuts from H 0: probe here for Z 0 at the copper, or run with the height map"
            )

    def compensation(self, mode: str, job: Job) -> Compensation | None:
        """What a run of `job` follows the board with, checked; None for off."""
        if mode not in MODES:
            raise ValueError(f"compensate must be one of {', '.join(MODES)}")
        if mode == OFF:
            self._check_surface_at_zero()
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


def _soft_limits(values: dict) -> tuple[float, float]:
    """The r_max and z_max settings as numbers, 0 where unset."""
    try:
        return float(values.get("r_max", 0) or 0), float(values.get("z_max", 0) or 0)
    except (TypeError, ValueError):
        return 0.0, 0.0


def _tip_point(status, offset: tuple[float, float], cartesian: bool, table_angle: float | None = None) -> tuple[float, float]:
    """The board point under the probe tip: the head's place along the rail
    and across it plus the tip's offset in those directions, turned by the
    table's angle (the status's, unless given: a dispenser's `A` is its
    plunger). On the polar machine the head sits on the rail (across 0),
    on a cartesian one at the cross slide's position."""
    along = status.r + offset[0]
    across = (status.z if cartesian else 0.0) + offset[1]
    angle = math.radians(status.a if table_angle is None else table_angle)
    return (
        along * math.cos(angle) - across * math.sin(angle),
        along * math.sin(angle) + across * math.cos(angle),
    )


def _by_id_names() -> dict[str, str]:
    """Device path to its `/dev/serial/by-id` name, where the system keeps
    such links."""
    names: dict[str, str] = {}
    folder = Path("/dev/serial/by-id")
    try:
        for entry in folder.iterdir():
            try:
                target = str(entry.resolve())
            except OSError:
                continue
            names.setdefault(target, str(entry))
    except OSError:
        pass
    return names


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

    if number("spindle"):
        tool = SPINDLE
    elif number("dispenser") and number("cartesian"):
        tool = DISPENSER
    else:
        tool = LASER
    return {
        "kinematics": CARTESIAN if number("cartesian") else POLAR,
        "tool": tool,
        "h_axis": bool(number("h_axis")),
        "r_max": number("r_max"),
        "z_max": number("z_max"),
    }


def controls_of(profile: dict) -> dict:
    """The page's controls for a machine whose settings are no file's: the
    defaults for what the profile says it is."""
    return machine_files.default_controls(profile["kinematics"], profile["tool"], profile["h_axis"])


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


# How often a host told to keep a link up looks for the controller, s.
AUTOCONNECT_INTERVAL = 5.0


async def _keep_connected(backend: Backend) -> None:
    while True:
        try:
            await run_in_threadpool(backend.autoconnect_tick)
        except Exception as exc:
            log.error("autoconnect failed: %r", exc)
        await asyncio.sleep(AUTOCONNECT_INTERVAL)


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
        keeper = asyncio.ensure_future(_keep_connected(backend)) if backend.autoconnect else None
        try:
            yield
        finally:
            if keeper is not None:
                keeper.cancel()
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
        except (JobImportError, CamError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except NotFound as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except CameraError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except (LinkError, VisionError) as exc:
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

    @app.post("/api/home")
    def home(body: HomeBody):
        return guarded(lambda: backend.home(body.axes))

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

    @app.get("/api/machines")
    def machines():
        return guarded(backend.machines)

    @app.get("/api/machines/{machine_id}")
    def machine(machine_id: str):
        return guarded(lambda: backend.machine_store.document(machine_id))

    @app.put("/api/machines/{machine_id}")
    def machine_save(machine_id: str, body: MachineTextBody):
        return guarded(lambda: backend.machine_store.save(machine_id, body.text))

    @app.post("/api/machines/{machine_id}/check")
    def machine_check(machine_id: str, body: MachineTextBody):
        return guarded(lambda: backend.machine_store.check(machine_id, body.text))

    @app.delete("/api/machines/{machine_id}")
    def machine_delete(machine_id: str):
        guarded(lambda: backend.machine_store.remove(machine_id))
        return {"deleted": machine_id}

    @app.post("/api/machines/{machine_id}/apply")
    def apply_machine(machine_id: str, body: ApplyMachineBody | None = None):
        return guarded(lambda: backend.apply_machine(machine_id, bool(body and body.save)))

    @app.post("/api/settings/save")
    def save_settings():
        return guarded(backend.save_settings)

    # --- CAM profiles ---

    @app.get("/api/cam")
    def cam_profiles():
        return guarded(backend.cam.list)

    @app.get("/api/cam/{profile_id}")
    def cam_profile(profile_id: str):
        return guarded(lambda: backend.cam.document(profile_id))

    @app.put("/api/cam/{profile_id}")
    def cam_save(profile_id: str, body: CamTextBody):
        return guarded(lambda: backend.cam.save(profile_id, body.text))

    @app.patch("/api/cam/{profile_id}")
    def cam_patch(profile_id: str, body: CamPatchBody):
        return guarded(lambda: backend.cam.patch(profile_id, body.path, body.value))

    @app.delete("/api/cam/{profile_id}")
    def cam_delete(profile_id: str):
        guarded(lambda: backend.cam.remove(profile_id))
        return {"deleted": profile_id}

    @app.post("/api/cam/{profile_id}/jobs")
    async def cam_job(profile_id: str, files: list[UploadFile] = File(...), name: str | None = Form(None)):
        uploads: list[tuple[str, bytes]] = []
        size = 0
        for upload in files:
            chunks: list[bytes] = []
            while chunk := await upload.read(1 << 20):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail=f"the upload is over {MAX_UPLOAD_BYTES >> 20} MB")
                chunks.append(chunk)
            uploads.append((upload.filename or "", b"".join(chunks)))
        return await run_in_threadpool(guarded, lambda: backend.cam_import(profile_id, uploads, name))

    @app.post("/api/cam/{profile_id}/gcode")
    def cam_gcode(profile_id: str, body: CamGcodeBody):
        return guarded(lambda: backend.cam_gcode(profile_id, body.job))

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
        layer: str | None = Form(None),
        clear: str | None = Form(None),
        mode: str | None = Form(None),
        fill: str | None = Form(None),
        thickness: float | None = Form(None),
    ):
        options = ImportOptions(tolerance=backend.tolerance)
        if layer:
            options.layer = layer.strip()
        elif mode and mode.strip().lower() == MODE_DISPENSE:
            # Paste goes where the paste layer says.
            options.layer = "F.Paste"
        if thickness is not None:
            options.thickness = thickness
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

    @app.delete("/api/jobs")
    def delete_all_jobs():
        return backend.delete_all_jobs()

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

    @app.post("/api/jobs/{job_id}/resume")
    def resume_job(job_id: str, body: ResumeBody):
        return guarded(lambda: backend.resume_job(job_id, body))

    @app.post("/api/jobs/{job_id}/resume/plan")
    def plan_resume(job_id: str, body: ResumeBody):
        return guarded(lambda: backend.resume_job(job_id, body, dry_run=True))

    @app.get("/api/resume")
    def resume_record():
        return {"resume": backend.resume_store.get()}

    @app.delete("/api/resume")
    def forget_resume():
        if backend.runner.active:
            raise HTTPException(status_code=409, detail="a job is running")
        backend.resume_store.clear()
        return {"resume": None}

    @app.get("/api/log")
    def read_log(lines: int = 200, file: str = "spinny"):
        path = log_path(backend.root, file)
        if path is None:
            raise HTTPException(status_code=400, detail=f"no log named {file!r}: spinny or wire")
        return {"lines": log_tail(path, lines)}

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
    def start_probe(body: ProbeBody):
        return guarded(lambda: backend.start_probe(body))

    @app.post("/api/heightmap/estimate")
    def probe_estimate(body: ProbeBody):
        return guarded(lambda: backend.probe_estimate(body))

    @app.post("/api/heightmap/touch")
    def touch_probe(body: TouchBody):
        return guarded(lambda: backend.touch_probe(body))

    @app.post("/api/heightmap/touch/plan")
    def touch_plan(body: TouchBody):
        return guarded(lambda: backend.touch_probe(body, dry_run=True))

    @app.post("/api/heightmap/stop")
    def stop_probe():
        return guarded(backend.stop_probe)

    @app.post("/api/heightmap/focus")
    def focus(body: FocusBody):
        return guarded(lambda: backend.focus(body.offset))

    @app.post("/api/heightmap/pads")
    def start_pads(body: PadsBody):
        return guarded(lambda: backend.start_pads(body))

    @app.post("/api/heightmap/pads/plan")
    def pads_plan(body: PadsBody):
        return guarded(lambda: backend.pads_plan(body))

    # --- camera ---

    @app.get("/api/camera")
    def camera_state():
        return guarded(backend.camera_state)

    @app.put("/api/camera/settings")
    def camera_settings(body: CameraSettingsBody):
        return guarded(lambda: backend.camera_settings(body))

    @app.post("/api/camera/start")
    def camera_start():
        return guarded(backend.camera_start)

    @app.post("/api/camera/stop")
    def camera_stop():
        return guarded(backend.camera_stop)

    @app.get("/api/camera/frame.jpg")
    def camera_frame(width: int = FRAME_DEFAULT_WIDTH, overlay: int = 1):
        try:
            data = backend.camera_frame(width, bool(overlay))
        except CameraError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except VisionError as exc:
            if "no frame" in str(exc):
                raise HTTPException(status_code=404, detail="no picture yet") from exc
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return Response(content=data, media_type="image/jpeg", headers={"Cache-Control": "no-store"})

    @app.get("/api/camera/pose")
    def camera_pose():
        return guarded(backend.camera_pose)

    @app.post("/api/camera/board")
    def camera_board(body: CameraBoardBody):
        return guarded(lambda: backend.camera_board(body.job))

    @app.post("/api/camera/mark")
    def camera_mark(body: CameraMarkBody):
        return guarded(lambda: backend.camera_mark(body))

    @app.post("/api/camera/find")
    def camera_find(body: CameraFindBody | None = None):
        step = body.step if body is not None else 2.0
        return guarded(lambda: backend.camera_find(step))

    @app.post("/api/camera/abort")
    def camera_abort():
        return guarded(backend.camera_abort)

    # --- alignment ---

    @app.get("/api/align")
    def align_state():
        return backend.alignment.state()

    @app.post("/api/align/mark")
    def align_mark(body: AlignMarkBody):
        return guarded(lambda: backend.align_mark(body))

    @app.post("/api/align/capture")
    def align_capture(body: AlignJobBody):
        return guarded(lambda: backend.align_capture(body.job))

    @app.delete("/api/align/marks/{index}")
    def align_remove(index: int):
        return guarded(lambda: backend.align_remove(index))

    @app.delete("/api/align")
    def align_clear():
        return guarded(backend.align_clear)

    @app.post("/api/align/fit")
    def align_fit(body: AlignJobBody):
        return guarded(lambda: backend.align_fit(body.job))

    @app.post("/api/align/apply")
    def align_apply(body: AlignJobBody):
        return guarded(lambda: backend.align_apply(body.job))

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
    parser.add_argument(
        "--data",
        type=Path,
        default=DATA_DIR,
        help=f"directory for the jobs, the config and the height map (default: {DATA_DIR})",
    )
    parser.add_argument(
        "--machines",
        type=Path,
        default=MACHINES_DIR,
        help=f"directory of machine files, one TOML file per machine (default: {MACHINES_DIR})",
    )
    parser.add_argument(
        "--cam",
        type=Path,
        default=CAM_DIR,
        help=f"directory of CAM profiles, one TOML file per machine and tool set (default: {CAM_DIR})",
    )
    parser.add_argument(
        "--connect",
        metavar="URL",
        help="keep a link open to this port without a page: a url, or `auto` for the port that announces"
        " itself as the controller (else the last url used); a controller that goes quiet or is replugged is"
        " taken up again every few seconds, unless the operator closed the link from the page",
    )
    parser.add_argument(
        "--log-level",
        choices=LEVELS,
        default=os.environ.get("SPINNY_LOG_LEVEL", "info").lower(),
        help="how much the backend writes to var/spinny.log and stderr (default: info, or SPINNY_LOG_LEVEL)",
    )
    parser.add_argument("--version", action="version", version=__version__)
    args = parser.parse_args(argv)
    setup_log(args.data, level=args.log_level)
    log.info("spinny-web %s starting on %s:%d", __version__, args.host, args.port)
    backend = Backend(root=args.data, machines_dir=args.machines, cam_dir=args.cam)
    backend.autoconnect = args.connect
    uvicorn.run(
        create_app(
            backend=backend,
            cors_origins=args.cors_origin,
            allowed_hosts=args.allowed_host,
        ),
        host=args.host,
        port=args.port,
        log_level="info",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
