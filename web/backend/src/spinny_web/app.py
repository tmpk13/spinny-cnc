"""The HTTP and WebSocket API, and the static frontend.

Routes are plain functions, which FastAPI runs in its thread pool, so a
blocking link call waits there without holding up the event loop. The
ones that run on the loop are async: the uploads, which await their
files as they come in and hand the import to the pool; the Auto tab's,
whose agent runs its turns as tasks on the loop; and the WebSocket.
Events from the link and the runner reach the WebSocket clients through a
broadcast with one queue per client; a client that cannot keep up loses
events rather than slowing the others.
"""

from __future__ import annotations

import argparse
import asyncio
import functools
import json
import math
import os
import re
import threading
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Callable, Literal

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from spinny_laser import home
from spinny_laser import machine_keys
from spinny_laser import machines as machine_files
from spinny_laser.controls import default_controls

from . import __version__, calibration, center, update
from .align import Alignment
from .auto import Agent, AutoBusy, AutoMessageBody, AutoSettingsBody
from .cam import NotFound, ProfileStore, build_job, gcode_of
from .boardlook import (
    CORNERS,
    BoardLook,
    CLEAR_MM,
    BoardMover,
    Estimate,
    Feature,
    KnownPlace,
    PictureFrame,
    RestTracker,
    check_places,
    corner_from_edges,
    corner_of,
    corners_known,
    found_text,
    job_known,
    known_place,
    measured_known,
    pick_features,
    rough_box,
    search,
    search_box,
    search_extra,
    search_stops,
    settings_now,
)
from .camera import (
    CENTER_TOLERANCE,
    CENTER_TRIES,
    Camera,
    CameraError,
    MachineAccess,
    feature_limits,
    picture_to_machine,
    pose_summary,
    round_problem,
    spot_of,
    wait_settled,
)
from .camlog import CAMERAS, CameraLog
from .searchlog import SearchLog, SearchRecord, affine_of
from . import searchreport
from .files import write_whole
from .cameras import ControlsError, controls_note, list_controls, set_controls
from .cameras import detect as detect_cameras
from .backend_shared import _check_frame_width, _s_max, _setting, _soft_limits
from .gcode_link import GcodeLink, GcodeLinkError
from .gcode_part import POLL_SECONDS as GCODE_POLL_SECONDS
from .gcode_part import GcodePart
from .openpnp import machine_of
from .placing_part import PlacingPart
from .probing_part import ProbingPart
from .pnp import MachineMover, PnpError, UpCamera, job_components
from .parts import KEY as PARTS_FILTER_KEY, PartsFilter, filter_of, mark as mark_filtered, state as filter_state
from .topcam import TopCamera
from .heightmap import (
    OFF,
    Grid,
    HeightMap,
    HeightMapStore,
)
from .jobs import (
    MODE_DISPENSE,
    MAX_COMBINED,
    MODE_STENCIL,
    PASTE_LAYER,
    Finite,
    Group,
    ImportOptions,
    Job,
    JobImportError,
    JobPatch,
    JobStore,
    Recipe,
    apply_patch,
    check_width,
    combined,
    import_file,
    recipe_options,
    remake_upload,
    replaced,
    width_refusal,
    with_width,
)
from . import markers as marker_list
from . import mill
from . import thumbs
from . import plugins
from . import reports
from . import todo
from .machines import MachineStore
from .kinematics import (
    DEFAULT_TOLERANCE,
    DISPENSER,
    LASER,
    SPINDLE,
    CartesianStreamer,
    Dispense,
    Rates,
    Spindle,
    Streamer,
    check_feed,
    group_focus,
    head_board,
    num,
    plan_print,
)
from .kinematics import FOCUS_DECIMALS
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
    boot_after_loss,
    loss_verdict,
)
from .log import LEVELS, log, path_for as log_path, setup as setup_log, tail as log_tail, wire_line, wire_note
from .prober import Prober, ProberError
from .resume import PositionStore, ResumeStore
from .runner import DONE, HOLD, RUNNING, Runner, RunnerError, halt
from .tools import ToolBox
from .vision import VisionError, board_record_fields, lens_of

# The runtime files (jobs, config, height map) and the machine and CAM
# files: the repository's var/, machines/ and cam/ in a checkout, else the
# same under the user's spinny home (spinny_laser.home).
HOME = home.root()
DATA_DIR = HOME / "var"
MACHINES_DIR = HOME / "machines"
CAM_DIR = HOME / "cam"
# A release puts the built page and the shipped machine and CAM files
# inside this package; a checkout has the page's build beside it, and no
# shipped copies (its own directories are the files).
PACKAGE_DIR = Path(__file__).resolve().parent
SHIPPED_DIR = PACKAGE_DIR / "defaults"
FRONTEND_DIST = PACKAGE_DIR / "page" if (PACKAGE_DIR / "page").is_dir() else PACKAGE_DIR.parents[2] / "frontend" / "dist"
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
    # The drivers' tuning, one value for all four: TMC2209 register fields,
    # named and bounded as in its datasheet (Rev 1.09).
    {"name": "tmc_intpol", "unit": "0/1", "help": "1 = the drivers interpolate every microstep to 256, whatever tmc_*_micro (CHOPCONF intpol)"},
    {"name": "tmc_toff", "unit": "", "help": "chopper off time, CHOPCONF TOFF 1 to 15: slow decay of 24 + 32 * TOFF clocks; 1 only with tmc_tbl 2 or 3"},
    {"name": "tmc_tbl", "unit": "", "help": "comparator blank time, CHOPCONF TBL 0 to 3: 16, 24, 32 or 40 clocks"},
    {"name": "tmc_hstrt", "unit": "", "help": "spreadCycle hysteresis start, CHOPCONF HSTRT 0 to 7: 1 to 8 above its end; tmc_hstrt + tmc_hend at most 18"},
    {"name": "tmc_hend", "unit": "", "help": "spreadCycle hysteresis end, CHOPCONF HEND 0 to 15: -3 to 12"},
    {"name": "tmc_hold_delay", "unit": "", "help": "IHOLDDELAY 0 to 15: each step of the fall from run to hold current takes this many 2^18 clocks (21.8 ms); 0 drops at once"},
    {"name": "tmc_tpowerdown", "unit": "", "help": "TPOWERDOWN 0 to 255: how long a motor at rest keeps its run current, in 2^18 clocks (21.8 ms) from 87 ms after its last step, before the fall to hold; 2 or more with stealthChop"},
    {"name": "tmc_tpwmthrs", "unit": "TSTEP", "help": "TPWMTHRS 0 to 1048575: stealthChop while TSTEP is at least this, spreadCycle faster; TSTEP is the 12 MHz clocks between 1/256 microsteps, 46875 / full steps per second; 0 = stealthChop at every speed"},
    # The PCA9685 servo driver's bus, and the four servos.
    {"name": "i2c_sda", "unit": "GPIO", "help": "the PCA9685's I2C data line, an even pin: 0 (TX), 20, 24 for I2C0, 18, 22, 26 for I2C1; read at boot"},
    {"name": "i2c_scl", "unit": "GPIO", "help": "its clock line, an odd pin of the same block: 1 (RX), 17, 21, 29 for I2C0, 23, 27 for I2C1; read at boot"},
    {"name": "pca_addr", "unit": "", "help": "the PCA9685's 7-bit address, 64 to 127 (0x40 to 0x7F) as its address pins set it; read at boot"},
    *(
        entry
        for n in range(1, 5)
        for entry in (
            {"name": f"servo{n}_out", "unit": "", "help": f"servo {n}'s output: 0 none, 1 servo{n}_pin, 2 the PCA9685's channel servo{n}_chan; read at boot"},
            {"name": f"servo{n}_pin", "unit": "GPIO", "help": f"servo {n} on the board: its pin, not on the laser's PWM slice nor a STOP header's; read at boot"},
            {"name": f"servo{n}_chan", "unit": "", "help": f"servo {n} on the PCA9685: its channel, 0 to 15; read at boot"},
            {"name": f"servo{n}_min_us", "unit": "us", "help": f"servo {n}'s pulse at 0 degrees, 200 to 3000"},
            {"name": f"servo{n}_max_us", "unit": "us", "help": f"servo {n}'s pulse at servo{n}_range degrees, 200 to 3000"},
            {"name": f"servo{n}_range", "unit": "deg", "help": f"servo {n}'s angle from servo{n}_min_us to servo{n}_max_us, above 0 and at most 360"},
            {"name": f"servo{n}_start", "unit": "deg", "help": f"servo {n}'s angle at boot; -1 for no pulse until moved"},
        )
    ),
]

# How long a home may take before the request gives up on it: every axis
# at its jog rate over its travel, twice, and the slow locate.
HOME_TIMEOUT = 600.0

POLAR, CARTESIAN = "polar", "cartesian"
# What a dispensing run is made of when the config says nothing.
DISPENSE_DEFAULTS = {"gap": 0.1, "retract": 0.2, "output": 100.0, "extrude_rate": 60.0, "dwell_ms": 200}
# The travel height's bounds, mm: an H, so it may be below H 0 when the
# surface is not where H counts from.
TRAVEL_LIMIT = 100.0
# Pad probing: how small a pad the probe still lands on, mm^2, and how
# many points at most, by default.
PAD_MIN_AREA = 0.5
PAD_MAX_POINTS = 100
# The widest picture the page asks for, px.
FRAME_DEFAULT_WIDTH = 640

NO_FRONTEND = """<!doctype html>
<html><head><meta charset="utf-8"><title>spinny</title></head>
<body style="font-family: sans-serif; margin: 2em">
<h1>spinny-web</h1>
<p>The page is not built. Run <code>bun run build</code> in <code>web/frontend</code>
(or <code>mise run web</code>) and restart the backend; the API is up at <code>/api</code>.</p>
</body></html>
"""


# --- request bodies -----------------------------------------------------------


class WidthBody(BaseModel):
    width: float


class MarginBody(BaseModel):
    margin: float


class ConnectBody(BaseModel):
    url: str
    # The machine file to connect as, for a G-code machine on a port its
    # file does not claim; left out, the file that claims the port, else
    # this project's firmware.
    machine: str | None = None


class CombineBody(Finite):
    """Jobs to make one job of, in the order they are cut, and its name."""

    ids: list[str] = Field(min_length=2, max_length=MAX_COMBINED)
    name: str | None = None


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


class ServoBody(Finite):
    # The servo's number, 1 to 4.
    servo: int
    # Degrees, 0 to the servo's range; None lets it go, without a pulse.
    angle: float | None = None


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


class UpdateSettingsBody(BaseModel):
    # Whether a check takes pre-releases too.
    prereleases: bool


class RunBody(BaseModel):
    # How the run follows the board's height: off, auto (the focus axis
    # when one is fitted, else power), focus or power.
    compensate: str = OFF
    # The operator's word that the head is at focus where it stands: a
    # laser group's own focus counts from here even though the last run of
    # the job stopped with the head somewhere else, or in another frame.
    focus_here: bool = False


class ResumeBody(BaseModel):
    # The line of the job to pick it up at: the count of lines done, as the
    # progress reports it. With `rewind` the run starts over at the first
    # line of the path that line belongs to, so a count a line off cannot
    # leave a gap. `compensate` left out takes the way the run being
    # picked up followed the board. `focus_here` is the operator's word
    # that the head is at focus where it stands, so a laser group's own
    # focus counts from here rather than from where the run picked up
    # began, which the focus axis may no longer count the same. `changed`
    # is the operator's word that `line` is counted in the job as it is
    # now, though its plan is no longer the one the recorded run counted.
    line: int
    rewind: bool = True
    compensate: str | None = None
    focus_here: bool = False
    changed: bool = False


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
    look_threshold: float | None = None
    corner_mm: float | None = None


class CameraBoardBody(BaseModel):
    job: str | None = None


class CameraMarkBody(Finite):
    # A mark cut with the tool where it stands: how deep and how fast the
    # plunge; `here` only records the tool's point as the mark.
    depth: float = 0.1
    plunge: float = 30.0
    speed: float | None = None
    here: bool = False


class CamLogBody(Finite):
    enabled: bool


class CamLogPhotoBody(Finite):
    camera: str = "head"
    # Look for the spot the camera's routine looks for, and draw it.
    find: bool = True


class CameraFindBody(Finite):
    step: float = 2.0


class BoardSearchBody(Finite):
    # The box the picture's center searches, x0 y0 x1 y1 mm in the camera's
    # machine frame (the board frame for the head camera, X and Y for a
    # G-code machine's top camera); left out, a square the board's diagonal
    # on a side about where the picture's center is now.
    box: tuple[float, float, float, float] | None = None


class BoardPlaceBody(Finite):
    job: str


class CameraRefineBody(Finite):
    # The job whose board was found (or whose corners were taken), which
    # features to center (auto: fiducials, else holes, else pads), and how
    # many far apart.
    job: str
    use: Literal["auto", "fiducials", "holes", "pads"] = "auto"
    count: int = Field(default=3, ge=2, le=6)


class BoardCornerBody(Finite):
    # The picture's center is on this corner of the job's board's outline
    # box, by name (boardlook.CORNERS).
    job: str
    corner: str


class CameraLensBody(Finite):
    # Which camera: the head camera, the up camera, or a G-code machine's top camera.
    camera: Literal["head", "up", "top"]
    # The dots of the grid in the picture: dark on light (a printed sheet)
    # or bright on dark (a laser on anodized aluminum), and their pitch, mm.
    polarity: Literal["dark", "bright"] = "dark"
    pitch: float = 2.0


class CameraColorBody(Finite):
    # Which camera, and what it looks for by the color picked: marks and
    # fiducials (spots), the board's pads (board), a blank board's edges.
    camera: Literal["head", "up", "top"]
    item: Literal["spots", "board", "edges"]
    # The point of the full size picture the color is read at; left out
    # with `clear`, which forgets the item's color.
    x: float | None = None
    y: float | None = None
    clear: bool = False


class CameraControlsBody(Finite):
    # Which camera: the head camera, the up camera, or a G-code machine's top camera.
    camera: Literal["head", "up", "top"]
    # Control values by v4l2-ctl's names, set now and kept to be set at
    # every start; null forgets a kept one (the camera's own value stays).
    values: dict[str, int | None]


class PnpSettingsBody(Finite):
    device: str | None = None
    size: str | None = None
    fps: int | None = None
    pcbv: str | None = None
    nozzle_spot: str | None = None
    part_spot: str | None = None
    position: tuple[float, float] | None = None
    height: float | None = None
    mm_per_px: float | None = None
    roll: float | None = None
    mirror: bool | None = None
    # The settings to take back to none: position, height.
    clear: list[str] = Field(default_factory=list)


class PnpNozzleBody(Finite):
    # How far the head moves along X and Y to measure the picture; 0 keeps
    # the scale, roll and mirror measured before.
    step: float = 1.0


class PnpLookBody(Finite):
    # Which of the up camera's spots to look for once: the nozzle's or a part's.
    spot: Literal["nozzle", "part"] = "nozzle"


class PnpAngleBody(Finite):
    # Degrees the board is turned on the machine, for a fit from one reference.
    angle: float | None = None
    clear_angle: bool = False


class MachinePatchBody(BaseModel):
    # The table and the key: ["motion", "place_z"], ["feeder", 0, "at"];
    # null takes the key out.
    path: list[str | int]
    value: Any = None


class PnpSwapBody(BaseModel):
    # Which of the two goes over the point the other one is over.
    to: Literal["nozzle", "camera"]


class PnpCameraBody(Finite):
    # The up camera's place on the machine: typed, the head's place now
    # with the nozzle over it by eye (`here`), or forgotten (`clear`).
    position: tuple[float, float] | None = None
    here: bool = False
    clear: bool = False


class PnpBusFeedBody(BaseModel):
    # The machine file's feeder to advance once.
    feeder: str


class PnpLightBody(BaseModel):
    on: bool


class PnpVacuumBody(BaseModel):
    # The vacuum switched on or off first, when given; then the sensor read
    # when asked.
    on: bool | None = None
    read: bool = False


class PnpReferenceBody(Finite):
    job: str
    ref: str
    # Where the part's place is on the machine; left out, the machine is asked.
    at: tuple[float, float] | None = None
    # The place is under the top camera's picture's center, not the nozzle.
    camera: bool = False


class PnpPlanBody(BaseModel):
    job: str
    # The parts to place; left out, every one that can be.
    refs: list[str] | None = None
    # A run finds the board's fiducials with the top camera first.
    fiducials: bool = False


class PnpFiducialsBody(BaseModel):
    job: str


class TopSettingsBody(Finite):
    device: str | None = None
    size: str | None = None
    fps: int | None = None
    pcbv: str | None = None
    mark_spot: str | None = None
    mark_at: tuple[float, float] | None = None
    offset: tuple[float, float] | None = None
    mm_per_px: float | None = None
    roll: float | None = None
    mirror: bool | None = None
    look_threshold: float | None = None
    corner_mm: float | None = None
    side: str | None = None
    finish: str | None = None
    paste: bool | None = None
    # The settings to take back to none: mark_at, offset.
    clear: list[str] = Field(default_factory=list)


class TopOffsetBody(Finite):
    # How far the head moves along X and Y to measure the picture; 0 keeps
    # the scale, roll and mirror measured before.
    step: float = 2.0


class PnpFeederBody(BaseModel):
    # The feeder to count from its first part again; left out, every one.
    feeder: str | None = None


class PnpGotoBody(Finite):
    job: str
    ref: str
    # Put the part's center, as the up camera last saw it on the nozzle,
    # over the place rather than the nozzle's: on this project's firmware.
    correct: bool = False
    # The top camera's picture center over the part, not the nozzle: on a
    # G-code machine.
    camera: bool = False


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

    def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=CLIENT_QUEUE)
        self._queues.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self._queues.discard(queue)

    def publish(self, event: dict) -> None:
        for queue in list(self._queues):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                pass

    def publish_threadsafe(self, event: dict) -> None:
        loop = self.loop
        if loop is None or loop.is_closed():
            return
        try:
            loop.call_soon_threadsafe(self.publish, event)
        except RuntimeError:
            pass


# --- the backend --------------------------------------------------------------


def editing_job(method):
    """Holds the job's editing lock across a method whose first argument is
    a job id: the job it reads is the last one saved, two writers of one
    job take turns, and a delete or a run waits for a write under way."""

    @functools.wraps(method)
    def wrapped(self, job_id, *args, **kwargs):
        with self.store.editing(job_id):
            return method(self, job_id, *args, **kwargs)

    return wrapped



class Backend(GcodePart, PlacingPart, ProbingPart):
    def __init__(
        self,
        root: Path,
        link_factory: Callable[[str], Link] | None = None,
        jobs_dir: Path | None = None,
        config_path: Path | None = None,
        machines_dir: Path | None = None,
        cam_dir: Path | None = None,
    ) -> None:
        self.root = root
        # Saves of the config from the request threads and from the run,
        # probing and routine threads take turns.
        self._config_lock = threading.Lock()
        self.machine_store = MachineStore(machines_dir if machines_dir is not None else MACHINES_DIR)
        self.cam = ProfileStore(cam_dir if cam_dir is not None else CAM_DIR)
        self.config_path = config_path or root / "config.json"
        self.config = self._load_config()
        self.store = JobStore(jobs_dir if jobs_dir is not None else root / "jobs")
        self.heightmaps = HeightMapStore(self.config_path.parent / "heightmap.json")
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
        # The camera on the head, through pcbv.
        self.camera = Camera(self.config, self._save_config, self.publish_camera, self.publish_message)
        self.pnp = UpCamera(self.config, self._save_config, self.publish_pnp, self.publish_message)
        self.top = TopCamera(self._placing_config, self._save_config, self.publish_placing, self.publish_message)
        # The head and top cameras' looks for a board: pcbv's poses read
        # while a board is loaded, sorted into guesses of where it lies, the
        # most likely called found once it holds the camera's threshold of
        # the evidence; held off while a routine moves the head and reads
        # them itself.
        self.head_look = BoardLook(
            lambda: self.camera.client, self.publish_camera, paused=lambda: self.camera.routine_active,
            tuning=lambda: _look_tuning(self.camera.settings()),
        )
        self.top_look = BoardLook(
            lambda: self.top.client, self.publish_placing, paused=lambda: self.top.routine_active,
            tuning=lambda: _look_tuning(self.top.settings()),
        )
        self._head_rest = RestTracker()
        self._top_rest = RestTracker()
        # The parts a placing run has put on the board now on the G-code
        # machine, by job: a run begins with a bare board and adds each
        # part it places; the top camera's pcbv is told them.
        self._board_placed: dict[str, list[str]] = {}
        # The pictures the cameras' routines looked at, kept while logging
        # is on, and photos taken by hand.
        self.camlog = CameraLog(
            self.config_path.parent / "camlog",
            enabled=bool(self.config.get("camlog", False)),
            publish=lambda state: self.broadcast.publish_threadsafe({"type": "camlog", **state}),
        )
        self.camera.camlog = self.camlog
        self.pnp.camlog = self.camlog
        self.top.camlog = self.camlog
        # Every look for a board and every search over a box, recorded
        # whatever the camera log's switch says, to be gone through later.
        self.searchlog = SearchLog(
            self.config_path.parent / "searchlog",
            publish=lambda state: self.broadcast.publish_threadsafe({"type": "searchlog", **state}),
        )
        # The link to a machine whose own controller takes G-code, open in
        # place of `link` while one is connected, and the machine file it
        # was opened as.
        self.gcode = GcodeLink(self.publish_placing, on_line=self._gcode_line, on_lost=self._gcode_lost)
        self._gcode_id: str | None = None
        # How often the head's place is read while the G-code machine is
        # left alone, s; 0 reads it only when a request needs it.
        self.gcode_poll_seconds = GCODE_POLL_SECONDS
        # The release this backend runs from and its updates from GitHub
        # (a checkout updates with git), pre-releases taken when asked.
        self.updater = update.Updater.here()
        self.updater.follow_prereleases(bool(self.config.get("update_prereleases", False)))
        # The marks that line a job up with the board.
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
        # The settings written since the controller's were last saved to
        # flash, or loaded from it, as far as this side has seen: a connect
        # knows of none, and a restart reads them all from flash again.
        self._unsaved: set[str] = set()
        # The last `boot ...` line reported, so the same one is not a fault twice.
        self._boot_reported: str | None = None
        # When the link last failed on its own and why (epoch s, reason), so
        # the board's next `boot` and `diag up` lines can say whether it lost
        # power in between; None after a close the operator asked for. The
        # note the boot line would make waits for the uptime in `_loss_note`.
        self._lost: tuple[float, str] | None = None
        self._loss_note: str | None = None
        # The next status report is a new link's first, which says whether
        # the board kept the position held at the connect.
        self._first_report = False
        # The focus axis frame, counted up whenever it may have changed.
        self._frame = 0
        # Names this backend's frames apart from another session's, whose
        # count started from 0 as well: see `focus_frame`.
        self._frame_session = uuid.uuid4().hex[:12]
        # The frame the stored map's heights were probed in (None for a map
        # from before). Focus here ties heights from another frame to this
        # one through the offset, so an offset given as a number holds only
        # for heights probed in this frame, and only then does probing
        # again keep the offset.
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
        _move_device_config(data)
        return data

    def _save_config(self) -> None:
        with self._config_lock:
            try:
                text = None
                for _ in range(5):
                    try:
                        text = json.dumps(self.config, indent=4, allow_nan=False)
                        break
                    except RuntimeError:
                        # Another thread changed the config while it was
                        # read (a run counting a feeder): read it again.
                        time.sleep(0.005)
                if text is None:
                    raise ValueError("the config kept changing while it was saved")
                self.config_path.parent.mkdir(parents=True, exist_ok=True)
                write_whole(self.config_path, text + "\n")
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
            full = _s_max(self._cached_values()) or 1000.0
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

    @property
    def travel_height(self) -> float | None:
        """The H the head rises to before a move from the page, probing or
        a camera routine goes across the board; None leaves the head at
        the height it has. Never a reason to go down: a head above it
        stays where it is."""
        value = self.config.get("travel")
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        value = float(value)
        return value if math.isfinite(value) and abs(value) <= TRAVEL_LIMIT else None

    def lift_height(self) -> float:
        """The H a camera routine rises to before it moves the head: the
        travel height, else the milling clearance taken as an H."""
        travel = self.travel_height
        return travel if travel is not None else self.spindle_config().clearance

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
            "travel": self.travel_height,
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

    def connect(self, url: str, machine: str | None = None) -> dict:
        """Opens the machine on `url`: a G-code machine when `machine` names
        one's file or a G-code machine file claims the port (by its url, or
        words in the port's USB names), else this project's firmware."""
        url = url.strip()
        if not url:
            raise ValueError("url is empty")
        try:
            check_url(url)
        except LinkError as exc:
            raise ValueError(str(exc)) from exc
        if machine is not None:
            if self.machine_store.get(machine).controller != machine_files.GCODE:
                raise ValueError(f"{machine} is a machine on this project's firmware: connect to its board without naming a file")
            return self._gcode_connect(url, machine)
        claimant = self.gcode_claimant(url, self._port_names(url))
        if claimant is not None:
            return self._gcode_connect(url, claimant)
        with self._lock:
            if self.link is not None and self.link.is_open and self.link.url == url:
                return self.snapshot()
            self._close_gcode()
            self._close_link()
            link = self.link_factory(url)
            link.subscribe(self._on_link_event)
            self._soft_resets = 0
            self._restarts_seen = None
            self._unsaved.clear()
            # The board may have started over since it last reported, its
            # supply gone or its reset pulled, and count from zero where the
            # head stands: its last position is held until it shows it kept
            # the count, or the position is declared.
            self.position_store.hold()
            self._first_report = True
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
            self._values(force=True)
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
            if self.gcode.url is not None:
                log.info("G-code link closed by the operator: %s", self.gcode.url)
            self._close_gcode()
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
        invert = self._cached_values().get("laser_invert")
        return 1000 if isinstance(invert, (int, float)) and invert else 0

    def shutdown(self) -> None:
        self.head_look.stop()
        self.top_look.stop()
        self.camera.shutdown()
        self.pnp.shutdown()
        self.top.shutdown()
        self.disconnect()

    def require_link(self) -> Link:
        link = self.link
        if link is None or not link.is_open:
            if self.gcode.connected:
                name = self._gcode_snapshot()["profile"]["name"]
                raise HTTPException(status_code=409, detail=f"{name} is a G-code machine: this is for a machine on this project's firmware")
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
        self._no_routine()
        return link

    def _no_routine(self) -> None:
        """Refuses a request that would move the head under a camera
        routine moving it."""
        if self.camera.routine_active:
            raise HTTPException(status_code=409, detail="a camera routine is moving the head")
        if self.pnp.routine_active:
            raise HTTPException(status_code=409, detail="the bottom camera routine is moving the head")

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
        limit, z_limit = _soft_limits(self._values())
        if not cartesian:
            z_limit = 0.0
        for joint, _ in targets:
            if limit > 0 and abs(joint[0]) > limit + 1e-9:
                raise ValueError(f"out of reach: R{joint[0]:.3f} is past the soft limit r_max={limit:g}")
            if z_limit > 0 and abs(joint[1]) > z_limit + 1e-9:
                raise ValueError(f"out of reach: Z{joint[1]:.3f} is past the soft limit z_max={z_limit:g}")

    def snapshot(self) -> dict:
        if self.gcode.connected or self._gcode_id is not None:
            return self._gcode_snapshot()
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
                    "servos": status.servos,
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
            # A restart is seen before the report is kept: it is the first
            # of the new count, not a position.
            self._check_restart()
            if self._first_report:
                self._first_report = False
                self.position_store.first_report(event.data)
            self.position_store.note(event.data)
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
            self._name_loss(text)
            uptime = re.match(r"diag up (\d+) s\b", text)
            if uptime is not None:
                self.position_store.board_started(time.time() - int(uptime.group(1)))
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
            # A link that never heard the board (a bridge with no controller
            # behind it, while the board is off) fails at every connect: the
            # failure that took the board away stays the one named, with its
            # time, until a link to the board fails again.
            link = self.link
            if reason == "disconnected":
                self._lost = None
                self._loss_note = None
            elif self._lost is None or (link is not None and link.banner is not None):
                self._lost = (time.time(), reason)
                self._loss_note = None
            # A close the user asked for is news, not a fault.
            self.publish_message("info" if reason == "disconnected" else "error", f"link closed: {reason}")
            self.broadcast.publish_threadsafe({"type": "state", **self.snapshot()})

    def _name_loss(self, text: str) -> None:
        """After a link that failed on its own, the board's `boot` line says
        what took it down when that was not the firmware (its supply, or its
        reset pin), and the `diag up` line after it whether it started again
        since the failure at all, and how long it was off: a dip that reset
        it at once, or a supply gone a while."""
        if self._lost is None:
            return
        lost_at, reason = self._lost
        if text.startswith("boot "):
            self._loss_note = boot_after_loss(text, lost_at, reason)
            if self._loss_note is None:
                self._lost = None
        elif self._loss_note is not None and text.startswith("diag up "):
            verdict = loss_verdict(self._loss_note, text, lost_at, time.time())
            if verdict is not None:
                self.publish_message(*verdict)
            self._lost = None
            self._loss_note = None

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
            # It counts from zero where the head stands: the position it
            # reported last is the one to declare. Held before the restart
            # is marked seen, so a report noted meanwhile cannot slip in.
            self.position_store.hold()
            self._restarts_seen = unasked
            self._unsaved.clear()
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

    def focus_frame(self) -> str:
        """The focus axis frame in use, named apart from every other one,
        an earlier session's included. A run's record keeps it with the
        height its groups' focus counted from, which is only that height
        again while the frame is the same."""
        return f"{self._frame_session}:{self._frame}"

    def _check_focus_start(self, job: Job, here: float | None) -> None:
        """Refuses a run of `job` that would count its groups' own focus
        from where the head is (`here`) when the last run of the job did
        not finish (stopped, failed, or left running by a host that died;
        a run under way has refused the start already): that run leaves
        the head at the height of the group it was cutting, not where it
        began, and nothing says whether it was focused again since. The
        run goes when the head is back at that run's start, or on the
        operator's word (`focus_here`)."""
        record = self.resume_store.get()
        if record is None or record.get("job") != job.id or record.get("state") == DONE:
            return
        began = record.get("start_h")
        if isinstance(began, bool) or not isinstance(began, (int, float)) or here is None:
            return
        if record.get("frame") != self.focus_frame():
            raise RunnerError(
                f"the last run of {job.name} stopped part way, and the focus axis has been renumbered since it"
                f" began at H{num(began, 4)} (a connect, a restart, a position set or a home), so nothing tells"
                " where focus is: bring the head to focus and run with focus here"
            )
        if abs(here - began) >= 0.5 * 10.0 ** -FOCUS_DECIMALS:
            raise RunnerError(
                f"the last run of {job.name} stopped with the focus axis at H{num(here, 4)}, not at H{num(began, 4)}"
                f" where it began and its groups' focus counts from: send the head back (go H{num(began, 4)}) and"
                " run, or if it was focused again where it is, run with focus here"
            )

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

    def _publish_probe(self) -> None:
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

    # Each of these sends a state to every page and answers it, for a
    # request that changed it to answer as well.

    def publish_heightmap(self) -> dict:
        state = self.heightmap_state()
        self.broadcast.publish_threadsafe({"type": "heightmap", **state})
        return state

    def publish_camera(self) -> dict:
        state = self.camera_state()
        self.broadcast.publish_threadsafe({"type": "camera", **state})
        return state

    def publish_pnp(self) -> dict:
        state = self.pnp.state()
        self.broadcast.publish_threadsafe({"type": "pnp", **state})
        return state

    def publish_align(self) -> dict:
        state = self.alignment.state()
        self.broadcast.publish_threadsafe({"type": "align", **state})
        return state

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
        if self.gcode.connected:
            return self._gcode_jog(body)
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
        if self.gcode.connected:
            return self._gcode_goto(body)
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
        rise = self._travel_rise(link, status, streamer, body)
        if rise is not None:
            lines = [rise, *lines]
        self._send_jog(link, lines, end)
        return {"lines": lines}

    def _travel_rise(self, link: Link, status, streamer: Streamer, body: GotoBody) -> str | None:
        """The line that takes the head up to the travel height before a
        goto moves it across the board, or None: no travel height, no
        focus axis, a goto that names the height itself or moves nothing
        across, or a head at rest at or above it. A head still moving may
        end anywhere, so it is taken to the travel height either way.
        `status` is the report the goto was planned from, or None for one
        read here."""
        travel = self.travel_height
        if travel is None or body.h is not None:
            return None
        if body.kind == "joint" and body.r is None and body.a is None and body.z is None:
            return None
        if status is None:
            status = link.status_now(1.0, routine=True)
        if status.h is None:
            return None
        if status.state == "Idle" and status.h >= travel - 1e-6:
            return None
        return streamer.joint_goto(None, None, None, travel)

    def set_position(self, body: PositionBody) -> dict:
        # Checked under both locks: a run or probing that starts meanwhile
        # plans from the position this would renumber.
        if self.gcode.connected:
            return self._gcode_set_position(body)
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
            if body.r is not None or body.a is not None or body.z is not None:
                # Where the head is over the board is declared: the machine's
                # reports are the position from here on. A focus height
                # alone says nothing of that.
                self.position_store.release()
        finally:
            # H renumbered moves the frame the map's heights are in, and R,
            # A or Z the board under them. Taken back whether or not the
            # machine answered: a line that timed out may still have gone
            # through.
            self._frame_changed("the position was set")
        link.status_now(1.0, routine=True)
        return self.snapshot()

    def realtime(self, action: str) -> dict:
        if self.gcode.connected:
            return self._gcode_realtime(action)
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

    def stop_all(self) -> dict:
        """The page's big Stop: whatever moves the machine or drives its
        output stops, each the way its own Stop does it. A run or probing
        is stopped with a hold, then a reset; otherwise a camera routine is
        ended, a jog or goto cancelled, and the beam or spindle turned off.
        A G-code machine gets its file's stop, which also ends a placing
        run and the camera routines. `stopped` names what was stopped."""
        stopped: list[str] = []
        if self.gcode.connected:
            if self.gcode.running:
                stopped.append("the placing run")
            for name, camera in (("the bottom camera routine", self.pnp), ("the top camera routine", self.top)):
                if camera.routine_active:
                    stopped.append(name)
            self._gcode_realtime("reset")
            stopped.append("the machine")
            return {"stopped": stopped, "snapshot": self.snapshot()}
        link = self.require_link()
        if self.runner.active:
            try:
                self.runner.stop()
                stopped.append("the run")
            except RunnerError:
                # It ended between the look and the stop.
                pass
        elif self.prober.active:
            try:
                self.prober.stop()
                stopped.append("probing")
            except ProberError:
                pass
        if not stopped:
            for name, camera in (("the camera routine", self.camera), ("the bottom camera routine", self.pnp)):
                if camera.routine_active:
                    camera.abort()
                    stopped.append(name)
            self._jog_target = None
            link.realtime(REALTIME_JOG_CANCEL)
            stopped.append("motion")
            try:
                link.request_ok("spindle off" if self.milling else "laser off")
                stopped.append("the output")
            except CommandError:
                # In an alarm the line is refused, and the output is off already.
                pass
            link.status_now(1.0, routine=True)
        return {"stopped": stopped, "snapshot": self.snapshot()}

    def command(self, line: str) -> dict:
        if self.gcode.connected:
            return self._gcode_command(line)
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
            if first == "set" and any(word[:1] in ("r", "a", "z") for word in words[1:]):
                # A position declared at the console, as from the jog panel.
                self.position_store.release()
        if lines and lines[-1] == "ok":
            self._note_flash(text)
        if setting:
            # A setting typed at the console: what this side remembers of
            # the machine's settings is stale, and the page's idea of what
            # the machine is (cartesian, spindle) with it.
            self._settings_cache = None
            try:
                self._values(force=True)
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

    def servo(self, servo: int, angle: float | None) -> dict:
        """Moves a servo from the page, or lets it go. The firmware moves it
        once queued motion is done; a run, probing or a camera routine owns
        the machine meanwhile, and a line from the page would land between
        theirs, so it is refused then as a move is."""
        with self._owner_lock:
            link = self._movable()
            if not 1 <= servo <= machine_files.SERVOS:
                raise ValueError(f"servo must be 1 to {machine_files.SERVOS}")
            values = self._values()
            if not values.get(f"servo{servo}_out"):
                raise ValueError(f"servo {servo} has no output: give [servo.{servo}] a pin or a channel in the machine file")
            if angle is None:
                line = f"servo N{servo} off"
            else:
                span = float(values.get(f"servo{servo}_range", 180.0))
                if not (math.isfinite(angle) and 0.0 <= angle <= span):
                    raise ValueError(f"angle must be 0 to {span:g} degrees")
                line = f"servo N{servo} A{num(angle)}"
            link.request_ok(line)
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
        if self.gcode.connected:
            return self._gcode_motors(enabled)
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
        if self.gcode.connected:
            return self._gcode_home(axes)
        line = " ".join(["home", *(word.upper() for word in words)])
        with self._owner_lock, self._move_lock:
            link = self._movable()
            self._jog_target = None
            try:
                answer = link.request_ok(line, timeout=HOME_TIMEOUT)
                # `[HOME:<letter>:<position>:1]` for each joint homed: a
                # board joint found its switch, so the reports place the
                # head again.
                if any(text[:7] in ("[HOME:R", "[HOME:A", "[HOME:Z") and text.endswith(":1]") for text in answer):
                    self.position_store.release()
            finally:
                # A home renumbers an axis as a `set` does: the frame the
                # height map's heights and points are in has moved.
                self._frame_changed("the machine was homed")
            link.status_now(1.0, routine=True)
            return self.snapshot()

    # --- settings -----------------------------------------------------------------

    def read_settings(self, force: bool = False) -> dict:
        """The settings as the page has them: the values with their
        schema, the host's own, and the machine file they are with the
        controls the page draws; a G-code machine has none of the
        firmware's settings, only its file's controls."""
        if self.gcode.connected:
            return self._gcode_settings()
        return self._settings_response(self._values(force))

    def _values(self, force: bool = False) -> dict:
        """The machine's settings by name: read with `$`, or as read less
        than SETTINGS_CACHE_SECONDS ago unless `force`. A read takes the
        rates and what the machine is from them."""
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
        # A restart since the last look has read every setting from flash.
        self._check_restart()
        return values

    def _cached_values(self) -> dict:
        """The settings as last read, without asking the machine; none
        before the first read."""
        cached = self._settings_cache
        return cached[1] if cached is not None else {}

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
            "unsaved": sorted(self._unsaved),
            "controls_from": source.id if source is not None else None,
            "controls": source.controls if source is not None else default_controls(profile["kinematics"], profile["tool"], profile["h_axis"]),
            # The servos' names and named positions, from the same file.
            "servos": list(source.servos) if source is not None else [],
        }

    def write_settings(self, values: dict | None, host: dict | None) -> dict:
        """Settings to the machine and the host's own, all or nothing.

        Every entry is checked here before anything goes out; a value the
        machine still refuses has the ones sent before it put back. The
        host's values are stored only once the machine's part is done.
        """
        tolerance = _tolerance(host["tolerance"]) if host and "tolerance" in host else None
        milling = None
        speed_control = None
        # The travel height: a number, or None to turn it off.
        travel: tuple[float | None] | None = None
        if host and "travel" in host:
            given = host["travel"]
            if given is None:
                travel = (None,)
            else:
                value = _host_number(host, "travel", 0.0)
                if not (math.isfinite(value) and abs(value) <= TRAVEL_LIMIT):
                    raise ValueError(f"the travel height must be -{TRAVEL_LIMIT:g} to {TRAVEL_LIMIT:g} mm, or none")
                travel = (value,)
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
        if travel is not None:
            if travel[0] is None:
                self.config.pop("travel", None)
            else:
                self.config["travel"] = travel[0]
        if dispensing is not None:
            self.config.update(dispensing)
        if tolerance is not None or milling is not None or speed_control is not None or dispensing is not None or travel is not None:
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
        if self.gcode.connected:
            current = self._gcode_id
        elif self.link is not None and self.link.is_open:
            try:
                current = self.read_settings()["machine"]
            except (LinkError, HTTPException):
                current = None
        return {"machines": [machine.summary() for machine in found], "current": current, "problems": problems}

    def machine_from_board(self, machine_id: str, text: str) -> dict:
        """The text with every key whose value differs from the connected
        board's written to the board's (spinny_laser.machine_keys), not
        saved: what it reads as, the keys written and the settings it still
        does not give the board's value for."""
        self.machine_store.path(machine_id)
        try:
            controller = machine_files.parse(text, machine_id, f"{machine_id}.toml").controller
        except machine_files.MachineError:
            controller = machine_files.SPINNY
        if controller != machine_files.SPINNY:
            raise ValueError("a G-code machine's file takes nothing from a board: its controller keeps its own settings")
        values = self._values(force=True)
        read = machine_keys.from_board(text, values, self.host_settings(), f"{machine_id}.toml")
        return {**self.machine_store.check(machine_id, read.text), "text": read.text, "changes": read.changes, "left": read.left}

    def machine(self, machine_id: str) -> machine_files.Machine:
        for machine in self.machine_list()[0]:
            if machine.id == machine_id:
                return machine
        raise HTTPException(status_code=404, detail=f"no machine file {machine_id!r}")

    def apply_machine(self, machine_id: str, save: bool = False) -> dict:
        """Writes a machine file's every setting and its host values, all or
        nothing as a settings write is, and saves them to flash if asked.
        A G-code machine's file has none to write: its controller keeps its
        own, and connecting to it is what makes it the machine."""
        machine = self.machine(machine_id)
        if machine.controller != machine_files.SPINNY:
            raise ValueError(f"{machine.name} is a G-code machine: its controller keeps its own settings; connect to it from the top bar")
        # A controller that lists none of a file's settings runs firmware
        # older than the file: name them all, not just the first refused.
        known = self._values(force=True)
        missing = [name for name in machine.settings if name not in known]
        if missing:
            raise ValueError(
                f"the controller does not have the settings {', '.join(missing)}: "
                f"its firmware predates them, flash the current firmware to load {machine_id!r}"
            )
        result = self.write_settings(dict(machine.settings), dict(machine.host) or None)
        if machine.camera:
            # The board has the file's settings by now: a camera that cannot
            # take the file's is a message, not a failed load.
            try:
                self.camera.update(dict(machine.camera))
            except CameraError as exc:
                self.publish_message("error", f"the camera settings of {machine_id!r} were not taken: {exc}")
            except VisionError as exc:
                # Kept, with the camera stopped: its restart on them failed.
                self.publish_message("error", f"the camera did not start again on {self.camera.settings().device}: {exc}")
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
        current = self._values(force=True)
        texts = {}
        for name, value in values.items():
            if name not in current:
                raise ValueError(f"unknown setting {name!r}")
            texts[name] = _setting_text(name, value)
        # The firmware checks s_min <= s_max on every line, so a write that
        # lowers s_max under the s_min in force sends its s_min first.
        if "s_min" in texts and "s_max" in texts and float(_number(texts["s_max"])) < float(current["s_min"]):
            texts = {"s_min": texts["s_min"], **{name: text for name, text in texts.items() if name != "s_min"}}
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
            self._unsaved.update(applied)
        except Exception as exc:
            # Refused, or lost on the way: whatever went before is put
            # back, so the write is all or nothing as far as the link
            # allows, and what the machine is read again. Last first, so
            # the board steps back through states it took once (s_min
            # and s_max are checked against each other on every line);
            # a line lost on the way, which may or may not have been
            # taken, goes back after them, since a link that fails ends
            # the putting back.
            back = list(reversed(applied))
            if isinstance(exc, CommandError):
                sending = None
            elif sending is not None:
                applied.append(sending)
                back.append(sending)
            self._restore_settings(link, {name: current[name] for name in back})
            self._settings_cache = None
            try:
                self._values(force=True)
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

    def _note_flash(self, text: str) -> None:
        """What a line typed at the console and taken did to the settings
        flash holds: `$name=value` writes one that is not saved yet,
        `$save` saves them all, `$load` reads them back, and `$defaults`
        changes them without saving."""
        if not text.startswith("$"):
            return
        name, sep, _ = text[1:].partition("=")
        word = name.strip().lower()
        if sep:
            self._unsaved.add(name.strip())
        elif word in ("save", "load"):
            self._unsaved.clear()
        elif word == "defaults":
            self._unsaved.add("$defaults")

    def save_settings(self) -> dict:
        self.require_link().request_ok("$save")
        self._unsaved.clear()
        return {"saved": True}

    # --- ports and jobs --------------------------------------------------------------

    def ports(self, claims: bool = True) -> dict:
        """The serial ports on this host, the controller's own first.

        A USB port is listed under its stable `/dev/serial/by-id` name when
        the system gives it one, so the pick survives a replug that moves
        it from ttyACM0 to ttyACM1. `kind` tells the page what to hide:
        `usb` for a device with a vendor id, `system` for a built-in port
        such as ttyS0, which is never the controller.

        With `claims`, a port a G-code machine file claims (its url, or
        words in the port's USB names) names that file in `machine`, which
        Connect opens it as; and a G-code machine whose file names a url no
        port is listed under (a socket, a port not plugged in) comes as an
        entry of kind `machine` of its own.
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
        if claims:
            self._claim_ports(found)
        return {"ports": found}

    def _claim_ports(self, found: list[dict]) -> None:
        """Names the G-code machine each listed port is, and lists the G-code
        machines whose own url is not among the ports."""
        machines, _ = self.machine_store.list()
        gcode = []
        for machine in machines:
            if machine.controller != machine_files.GCODE:
                continue
            try:
                gcode.append(self.machine_store.gcode(machine.id))
            except (ValueError, LookupError):
                continue
        for entry in found:
            names = " ".join(str(entry.get(key) or "") for key in ("product", "manufacturer", "description", "url", "device"))
            owner = next((machine for machine in gcode if machine.claims(str(entry["url"]), names) or machine.claims(str(entry.get("device") or ""), names)), None)
            entry["machine"] = owner.id if owner is not None else None
            entry["machine_name"] = owner.name if owner is not None else None
        listed = {str(entry["url"]) for entry in found} | {str(entry.get("device") or "") for entry in found}
        for machine in gcode:
            if machine.url and machine.url not in listed:
                found.append(
                    {
                        "url": machine.url,
                        "device": machine.url,
                        "description": machine.name,
                        "product": "",
                        "manufacturer": "",
                        "serial": "",
                        "vid": None,
                        "pid": None,
                        "kind": "machine",
                        "spinny": False,
                        "machine": machine.id,
                        "machine_name": machine.name,
                    }
                )

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
            # A board's paths follow the spot: its file is kept to import it
            # again for another, and a KiCad file for the camera besides.
            kept = self.store.keep_upload(job.id, name, data)
            job.design.board = kept and path.suffix.lower() == ".kicad_pcb"
            if kept:
                job.recipe = Recipe(file=name, options=recipe_options(options))
            self.store.save(job)
        return job

    def cam_import(self, profile_id: str, files: list[tuple[str, bytes]], name: str | None) -> dict:
        """The uploaded files through a CAM profile into a stored job: a board
        (a KiCad file, or a copper gerber with its outline and drill file
        beside it), an SVG, a DXF drawing, an X/Y gcode file, a job, or an
        STL model."""
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
        result = center.build(request, self.streamer(), self.rates.a_rate, _s_max(self._cached_values()))
        result.job = self.store.add(result.job)
        return result.model_dump()

    def calibrate_job(self, request: calibration.CalibrateRequest) -> dict:
        # Whether the laser has a focus axis is known from its settings,
        # read when a machine is connected, else as last read.
        if self.link is not None and self.link.is_open:
            try:
                values = self._values()
            except (LinkError, HTTPException):
                values = {}
        else:
            values = self._cached_values()
        focus_axis = bool(values.get("h_axis")) if "h_axis" in values else None
        result = calibration.build(request, self.streamer(), self.milling, focus_axis)
        result.job = self.store.add(result.job)
        return result.model_dump()

    def _job(self, job_id: str) -> Job:
        """The stored job; 404 for none."""
        job = self.store.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="no such job")
        return job

    def _idle_job(self, job_id: str) -> Job:
        """The stored job, to change; 404 for none, 409 while it runs."""
        job = self._job(job_id)
        if self.runner.active and self.runner.progress.job == job_id:
            raise HTTPException(status_code=409, detail="the job is running")
        return job

    @editing_job
    def patch_job(self, job_id: str, patch: JobPatch) -> Job:
        """The job changed by `patch`; refused while it runs, unless the
        patch only sets its icon."""
        job = self._job(job_id) if patch.icon_only else self._idle_job(job_id)
        job = apply_patch(job, patch, self.streamer())
        self.store.save(job)
        return job

    # --- the camera log -----------------------------------------------------------

    def camlog_state(self, limit: int = 100, camera: str | None = None) -> dict:
        if camera is not None and camera not in CAMERAS:
            raise ValueError(f"camera must be one of {', '.join(CAMERAS)}")
        return self.camlog.state(limit, camera)

    def set_camlog(self, enabled: bool) -> dict:
        """Logging on or off, kept across restarts."""
        with self._config_lock:
            self.config["camlog"] = bool(enabled)
        self._save_config()
        return self.camlog.set_enabled(enabled)

    def camlog_photo(self, camera: str, find: bool = True) -> dict:
        """A photo now with a camera, kept whether logging is on or not:
        the picture, the same with the marks, and with `find` what the
        camera's finder sees now (the head camera's mark, dark; the up
        camera's part, of its polarity; the top camera's mark, of its
        shade); a head camera with a board loaded adds pcbv's picture with
        the pose."""
        if camera == "head":
            client, running, pose = self.camera.client, self.camera.client.running, self.camera.board_job is not None
            polarity = "dark"
        elif camera == "up":
            client, running, pose = self.pnp.client, self.pnp.client.running, False
            polarity = self.pnp.settings().part_spot
        elif camera == "top":
            client, running, pose = self.top.client, self.top.client.running, False
            polarity = self.top.settings().mark_spot
        else:
            raise ValueError(f"camera must be one of {', '.join(CAMERAS)}")
        if not running:
            raise CameraError(f"the {camera} camera is not running: start it first")
        spot = client.spot(polarity=polarity) if find else None
        entry = self.camlog.look(client, camera, "photo", "by hand", spot=spot, note=f"{polarity} spot" if find else "", pose=pose, force=True)
        if entry is None:
            raise CameraError("the picture could not be kept: see the backend's log")
        return entry

    def clear_camlog(self) -> dict:
        return {"deleted": self.camlog.clear()}

    def searchlog_state(self, limit: int = 20, camera: str | None = None) -> dict:
        if camera is not None and camera not in ("head", "top"):
            raise ValueError(f"no camera {camera!r} looks for boards: head or top")
        return self.searchlog.state(limit, camera)

    def _search_record(self, record_id: str) -> searchreport.Record:
        folder = self.searchlog.folder_of(record_id)
        if folder is None:
            raise NotFound(f"no search record {record_id}")
        return searchreport.load(folder)

    def searchlog_record(self, record_id: str) -> dict:
        """A search record's header and what searchreport makes of it."""
        record = self._search_record(record_id)
        return {"record": record.header, "summary": searchreport.summarize(record)}

    def searchlog_report(self, record_id: str) -> str:
        """A search record as a page, its pictures by their names beside it."""
        return searchreport.html(self._search_record(record_id))

    def clear_searchlog(self) -> dict:
        return {"deleted": self.searchlog.clear()}

    def combine_jobs(self, ids: list[str], name: str | None = None) -> Job:
        """A new job of the jobs named, cut in that order, stored."""
        jobs = []
        for job_id in ids:
            job = self.store.get(job_id)
            if job is None:
                raise NotFound(f"no job {job_id!r}")
            jobs.append(job)
        made = combined(jobs, name)
        made.refresh_stats(self.streamer())
        return self.store.add(made)

    @editing_job
    def replace_job(self, job_id: str, data: dict) -> Job:
        """The job under `job_id` made what `data` says, as the page's JSON
        editor or its regrouping of paths sends it: checked as an upload
        is, its id kept, priced again."""
        made = replaced(job_id, data, self._idle_job(job_id))
        made.refresh_stats(self.streamer())
        self.store.save(made)
        return made

    @editing_job
    def run_job(self, job_id: str, compensate: str = OFF, focus_here: bool = False) -> dict:
        # The check that nothing is being probed and the runner's claim are
        # one step: probing asked for at the same moment waits for this,
        # then finds the run under way.
        with self._owner_lock:
            return self._run_job(job_id, compensate, focus_here)

    def _run_job(self, job_id: str, compensate: str = OFF, focus_here: bool = False) -> dict:
        job = self._job(job_id)
        if self.prober.active:
            raise HTTPException(status_code=409, detail="the board is being probed")
        self._no_routine()
        # Claimed before the settings are read: a stop, hold or reset while
        # they are keeps the run from starting, as one during its planning
        # does. The restart count is taken with it for the same reason.
        self.runner.reserve(self.link)
        try:
            restarts = self.link.restarts if self.link is not None else None
            if self.link is not None and self.link.is_open:
                self._check_depth_axis(self._values(force=True))
            compensation = self.compensation(compensate, job)
            # A cartesian plan is made in the frame of the table as it is now.
            status = None
            if self.cartesian and self.link is not None and self.link.is_open:
                status = self.link.status_now(1.0, routine=True)
            # Without the map a laser group's own focus counts from where
            # the head stands as the run begins.
            if compensation is None and not focus_here and not self.milling and not self.dispensing and group_focus(job):
                if self.link is not None and self.link.is_open:
                    self._check_focus_start(job, self.link.status_now(1.0, routine=True).h)
            return self.runner.start(job, self.link, self.streamer(status), compensation, restarts, frame=self.focus_frame())
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
            job = self._job(job_id)
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
                self._check_depth_axis(self._values(force=True))
                compensation = self.compensation(compensate, job)
                status = link.status_now(1.0, routine=True)
                streamer = self.streamer(status)
                plan_start: tuple[float, float] | None = None
                if theirs and record is not None and isinstance(record.get("start"), list) and len(record["start"]) == 2:
                    if bool(record.get("cartesian", False)) == streamer.cartesian:
                        plan_start = (float(record["start"][0]), float(record["start"][1]))
                if plan_start is None:
                    plan_start = streamer.start_of(status)
                # A group's own focus counts from where the run picked up
                # began, so its lines are the ones counted; that height is
                # a focus axis position, which means the same only in the
                # frame it was read in. The operator's word that the head
                # is at focus (`focus_here`) counts from where it stands.
                # Following the map, the map's focus height is the base.
                if group_focus(job):
                    began = record.get("start_h") if theirs and record is not None else None
                    if body.focus_here:
                        streamer.focus_base = status.h
                    elif isinstance(began, (int, float)) and not isinstance(began, bool):
                        if compensation is None and record is not None and record.get("frame") != self.focus_frame():
                            raise RunnerError(
                                f"the focus axis has been renumbered since the run being picked up began at"
                                f" H{num(began, 4)} (a connect, a restart, a position set or a home), so its groups'"
                                " heights cannot be counted from there: bring the head to focus and pick up with"
                                " focus here"
                            )
                        streamer.focus_base = float(began)
                    elif status.h is not None:
                        streamer.focus_base = status.h
                pieces = list(streamer.job_pieces(job, plan_start, compensation))
                # The count is the recorded run's, of the lines its plan
                # had: a job re-cut, regrouped, turned or moved since, paths
                # deleted or added, or a pickup that follows the map
                # otherwise, has other lines at the same count.
                kept = record.get("fingerprint") if theirs and record is not None else None
                if isinstance(kept, str) and not body.changed and plan_print(pieces) != kept:
                    raise RunnerError(
                        f"the plan of {job.name} is not the one the run being picked up counted its lines in: the job"
                        " was changed since (re-cut, regrouped, turned or moved, paths deleted or added), or the pickup"
                        f" follows the height map otherwise, so line {body.line} is not where that run got to: run it"
                        " from the top, or pick it up at a line counted in the job as it is now"
                    )
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
                    skip=skip,
                    pieces=pieces,
                    plan_start=plan_start,
                    frame=self.focus_frame(),
                )
            finally:
                self.runner.release()

    def _check_depth_axis(self, values: dict) -> None:
        """Refuses a run on a spindle or a dispenser with no focus axis
        (`h_axis` in the settings `values`), its depth or needle axis."""
        if self.milling and not values.get("h_axis"):
            raise ValueError("a spindle needs the focus axis as its depth axis: set $h_axis=1")
        if self.dispensing and not values.get("h_axis"):
            raise ValueError("a dispenser needs the focus axis as the needle's height: set $h_axis=1")

    @editing_job
    def set_job_width(self, job_id: str, width: float) -> Job:
        """The job made again for a bit or spot `width` mm across: a board
        imported again from its kept file, a Plot page operation built
        again, or a drawing given the width with its paths as they are."""
        job = self.store.get(job_id)
        if job is None:
            raise NotFound(f"no job {job_id!r}")
        if self.runner.active and self.runner.progress.job == job_id:
            raise RunnerError("the job is running")
        check_width(width)
        refusal = width_refusal(job)
        if refusal is not None:
            raise ValueError(refusal)
        recipe = job.recipe
        if mill.recipe_ops(recipe):
            made = mill.remake(job, width, self.streamer())
        elif recipe is not None and recipe.file:
            kept = self.store.upload_path(job.id, recipe.file)
            if kept is None:
                raise ValueError(f"the file {job.name} was imported from is no longer kept: import it again with the new width")
            made = remake_upload(job, kept, width, self.streamer())
        else:
            made = with_width(job, width, self.streamer())
        self.store.save(made)
        return made

    @editing_job
    def set_job_margin(self, job_id: str, margin: float) -> Job:
        """A stencil made again from its kept file with every opening shrunk
        by `margin` mm, where the job is now."""
        job = self.store.get(job_id)
        if job is None:
            raise NotFound(f"no job {job_id!r}")
        if self.runner.active and self.runner.progress.job == job_id:
            raise RunnerError("the job is running")
        recipe = job.recipe
        if recipe is None or not recipe.file or (recipe.options or {}).get("mode") != MODE_STENCIL:
            raise ValueError(f"{job.name} is not a stencil: a margin is for a board imported with mode stencil")
        kept = self.store.upload_path(job.id, recipe.file)
        if kept is None:
            raise ValueError(f"the file {job.name} was imported from is no longer kept: import it again with the new margin")
        made = remake_upload(job, kept, job.spot, self.streamer(), margin=margin)
        self.store.save(made)
        return made

    def mill_job(self, body: mill.MillJobBody | mill.MillOperation, keep: bool) -> dict:
        """The Plot page's operations as a job and its notes; stored when
        `keep`, else only shown. With `job` named, the operations replace
        that Plot page job's in place: same id, put where that job is now,
        turned and moved as it has been since it was made. With `like`
        named instead, a new job is turned and moved as that one has been."""
        if isinstance(body, mill.MillOperation):
            body = mill.MillJobBody(ops=[body], name=body.name)
        op_list = list(body.ops)
        if len(op_list) == 1 and op_list[0].kind == mill.HOLES and not op_list[0].name and not body.name and op_list[0].holes is None:
            source = self.store.get(op_list[0].job or "")
            if source is not None:
                op_list[0] = op_list[0].model_copy(update={"name": f"{source.name} holes"})

        target = None
        if body.job:
            target = self.store.get(body.job)
            if target is None:
                raise NotFound(f"no job {body.job!r}")
            if not mill.recipe_ops(target.recipe):
                raise ValueError(f"{target.name} was not made on the Plot page: its operations cannot be changed there")
            if keep and self.runner.active and self.runner.progress.job == target.id:
                raise RunnerError("the job is running")
        # The job whose frame the operations are typed in: the one they
        # replace, or the one a new job is put as.
        frame = target
        if target is None and body.like:
            frame = self.store.get(body.like)
            if frame is None:
                raise NotFound(f"no job {body.like!r}")

        def holes_of(op: mill.MillOperation) -> list[tuple[float, float, float]]:
            source = self.store.get(op.job or "")
            if source is None:
                raise NotFound(f"no job {op.job!r} to take holes from")
            # The board job's holes are where it is now, on the board; the
            # operations are typed from before the frame job's move, which
            # is applied to everything built.
            return list(source.holes) if frame is None else mill.unplaced(source.holes, frame)

        name = body.name if body.name is not None else (op_list[0].name if len(op_list) == 1 else None)
        job, notes = mill.build_job(op_list, holes_of, name)
        if target is not None:
            # The settings made on the Jobs page stay with the groups.
            mill.carry_job_settings(target, job)
            mill.placed(job, target)
        elif frame is not None:
            mill.moved_as(job, frame)
        job.refresh_stats(self.streamer())
        if keep:
            if target is not None:
                self.store.save(job)
            else:
                job = self.store.add(job)
        return {"job": job.model_dump(), "notes": notes}

    def markers_state(self) -> dict:
        return {"markers": [marker.model_dump() for marker in marker_list.from_config(self.config.get("markers"))]}

    def set_markers(self, markers: list[marker_list.Marker]) -> dict:
        kept = marker_list.checked(markers)
        self.config["markers"] = [marker.model_dump() for marker in kept]
        self._save_config()
        state = self.markers_state()
        self.broadcast.publish_threadsafe({"type": "markers", **state})
        return state

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

    # --- the camera -----------------------------------------------------------------

    def camera_state(self) -> dict:
        if self.head_look.job is not None and self.head_look.job != self.camera.board_job:
            # The camera stopped, or started again without the board.
            self.head_look.stop()
        return {**self.camera.state(job_center=self._job_center), "board_look": self.head_look.state()}

    def _head_look_place(self, captured: float) -> PictureFrame | str:
        """Where the head camera's picture lay on the board frame for a
        frame taken at `captured`: the tool's point plus the offset, once
        the machine has stood idle there for the settle time."""
        link = self.link
        status = link.status if link is not None else None
        if status is None:
            return "the machine is not connected: the head's place is not known"
        board = head_board(status.r, self.table_angle(status), status.z, self.cartesian)
        quiet = self._head_rest.see(board, moving=status.state != "Idle")
        if quiet is None or captured < quiet:
            return "the head is moving"
        settings = self.camera.settings()
        return PictureFrame((board[0] + settings.offset[0], board[1] + settings.offset[1]), settings.roll, False)

    def _look_scale(self, client, measured: float) -> tuple[float, float, float]:
        """A camera's picture size (full size px) and scale for a search:
        the size pcbv reports, the scale measured, else pcbv's own from a
        lock."""
        try:
            raw = client.pose()
        except VisionError:
            raw = {}
        width, height = raw.get("width"), raw.get("height")
        scale = measured if measured > 0.0 else raw.get("mm_per_px") if raw.get("state") == "locked" else 0.0
        if not isinstance(width, (int, float)) or not isinstance(height, (int, float)) or width <= 0 or height <= 0:
            raise ValueError("the camera has no picture yet: wait for one")
        if not isinstance(scale, (int, float)) or scale <= 0.0:
            raise ValueError("the camera's scale is not measured: measure it first, so the search knows how far its picture reaches")
        return float(width), float(height), float(scale)

    @staticmethod
    def _board_box(job) -> tuple[float, float, float, float] | None:
        """A job's outline's box (else its paths'), x0 y0 x1 y1 in its frame; None with neither."""
        points = [point for path in job.outline for point in path]
        if not points:
            points = [point for group in job.groups for path in group.board_paths() for point in path]
        if not points:
            return None
        xs, ys = [p[0] for p in points], [p[1] for p in points]
        return (min(xs), min(ys), max(xs), max(ys))

    @staticmethod
    def _board_size(job) -> tuple[tuple[float, float], float]:
        """A job's middle (its outline's box, else its paths') and diagonal, in its frame."""
        box = Backend._board_box(job)
        if box is None:
            return (0.0, 0.0), 10.0
        x0, y0, x1, y1 = box
        return ((x0 + x1) / 2.0, (y0 + y1) / 2.0), max(math.hypot(x1 - x0, y1 - y0), 1.0)

    def _check_places(self, job, view: tuple[float, float]) -> Callable[[Estimate], list[tuple[float, float]]]:
        """Where a search checks the job's board once found: its middle, or
        the part of it with the most pads and holes in a picture `view` mm
        (boardlook.check_places)."""
        middle, _ = self._board_size(job)
        outline = self._board_box(job)
        features = [(float(p[0]), float(p[1])) for p in job.pads] + [(float(h[0]), float(h[1])) for h in job.holes]
        return lambda found: check_places(found, middle, outline, features, view)

    def _corners_box(self, look: BoardLook, job, corner_mm: float) -> tuple[float, float, float, float] | None:
        """The box a search covers by default once corners of the job's
        board were taken: where they put its outline, grown by their
        tolerance, and by a tenth of the board's diagonal more with one
        corner, whose turn is not known; None without corners or outline."""
        rough = look.rough(job.id)
        outline = self._board_box(job)
        if rough is None or outline is None:
            return None
        _, diagonal = self._board_size(job)
        margin = corner_mm + (0.1 * diagonal if len(look.corners_of(job.id)) < 2 else 0.0)
        return rough_box(rough, outline, margin)

    def _corner_point(self, job, corner: str) -> tuple[float, float]:
        """A corner of the job's board's outline box, in its frame."""
        outline = self._board_box(job)
        if outline is None:
            raise ValueError("the job has no outline to take a corner of")
        if corner not in CORNERS:
            raise ValueError(f"no corner {corner!r}: one of {', '.join(CORNERS)}")
        return corner_of(outline, corner)

    def camera_corner(self, body: BoardCornerBody) -> dict:
        """The head camera's picture's center is on a corner of the job's
        board: the machine point under it is kept for that corner, the
        guesses weighed against it and a rough place made (boardlook.py)."""
        job = self._job(body.job)
        point = self._corner_point(job, body.corner)
        link = self.require_link()
        status = link.status_now(1.0, routine=True)
        if status.state != "Idle":
            raise ValueError(f"the machine is {status.state}: take a corner with the head at rest")
        head = head_board(status.r, self.table_angle(status), status.z, self.cartesian)
        settings = self.camera.settings()
        middle, _ = self._board_size(job)
        self.head_look.add_corner(job.id, body.corner, point, (head[0] + settings.offset[0], head[1] + settings.offset[1]), middle)
        return self.publish_camera()

    def camera_corners_clear(self) -> dict:
        self.head_look.clear_corners()
        return self.publish_camera()

    def _board_record(self, kind: str, camera: str, job, client, board: dict, picture: dict, extra: dict | None = None) -> SearchRecord | None:
        """A search record begun (searchlog.py) of `camera`'s look for a
        job's board (`look`) or its search over a box (`search`): what was
        looked for and how (`board`, the fields pcbv was given besides the
        file: side, finish, scale, paste, placed), `picture` the camera's
        place and scale and `extra` the search's box and stops; None when
        none could be begun, which nothing stops for."""
        try:
            middle, _ = self._board_size(job)
            box = self._board_box(job)
            try:
                hello = {key: value for key, value in client.request("hello").items() if key != "id"}
            except Exception:  # pcbv's version is nice to have, never needed
                hello = None
            header = {
                "job": {"id": job.id, "name": job.name},
                "board": {"file": job.recipe.file if job.recipe is not None else None, **board_record_fields(board)},
                "board_to_job": affine_of(job.design.board_to_job),
                "middle": [middle[0], middle[1]],
                "outline_box": list(box) if box is not None else None,
                "picture": picture,
                "settings": settings_now(self.head_look if camera == "head" else self.top_look, job.id),
                "pcbv": hello,
                **(extra or {}),
            }
            return self.searchlog.begin(kind, camera, header, self.store.board_path(job.id))
        except Exception as exc:  # a record never stops a look or a search
            log.warning("search record not begun: %r", exc)
            return None

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

    def cameras(self) -> dict:
        """The cameras attached, for the head, up or top camera's device to
        be picked from."""
        held = tuple(client.device for client in (self.camera.client, self.pnp.client, self.top.client) if client.running and client.device)
        return detect_cameras(self.camera.settings().pcbv, held)

    def _controlled(self, camera: str):
        """A camera by its name in the controls' routes, and how to tell the page of it."""
        if camera == "head":
            return self.camera, self.publish_camera
        if camera == "up":
            return self.pnp, self.publish_pnp
        self.placing_machine()
        return self.top, self.publish_placing

    def camera_lens(self, body: CameraLensBody) -> dict:
        """The camera's lens measured from the dot grid in its picture now
        (pcbv's calibrate), kept and applied from then on; what was
        measured, and the fit's residual before and after."""
        owner, publish = self._controlled(body.camera)
        if not owner.client.running:
            raise ValueError("the camera is not running: start it first")
        if not (math.isfinite(body.pitch) and 0.1 <= body.pitch <= 50.0):
            raise ValueError("the dots' pitch must be 0.1 to 50 mm")
        reply = {key: value for key, value in owner.client.calibrate(body.polarity, body.pitch).items() if key != "id"}
        owner.set_lens(lens_of(reply))
        self.publish_message(
            "info",
            f"{body.camera} camera lens measured from {reply.get('dots')} dots: k1 {reply.get('k1', 0.0):+.4f}, k2 {reply.get('k2', 0.0):+.4f};"
            f" the dots fit within {reply.get('rms_px', 0.0):.2f} px rms, {reply.get('rms_before_px', 0.0):.2f} px without it",
        )
        return {"camera": body.camera, "measured": reply, "state": publish()}

    def camera_color(self, body: CameraColorBody) -> dict:
        """A color picked from the camera's picture (the mean about a point
        of the full size picture) kept for what it looks for: spots, the
        board's pads or a blank board's edges; or forgotten. A board loaded
        with the board's color is loaded again with it."""
        owner, publish = self._controlled(body.camera)
        colors = dict(owner.settings().colors)
        rgb = None
        if body.clear:
            colors.pop(body.item, None)
        else:
            if body.x is None or body.y is None:
                raise ValueError("give the point of the picture to read the color at, or clear")
            if not owner.client.running:
                raise ValueError("the camera is not running: start it first")
            rgb = owner.client.color(body.x, body.y)
            colors[body.item] = rgb
        owner.update({"colors": colors})
        if body.item == "board":
            self._reload_board(body.camera)
        return {"camera": body.camera, "item": body.item, "rgb": rgb, "state": publish()}

    def _reload_board(self, camera: str) -> None:
        """A camera's board loaded again with its settings as they are now,
        when one is loaded."""
        if camera == "head" and self.head_look.job is not None and self.camera.running:
            self.camera_board(self.head_look.job)
        elif camera == "top" and self.top_look.job is not None and self.top.running and not self.top.routine_active:
            self.top_board(self.top_look.job)

    def camera_edge_corner(self, body: BoardCornerBody) -> dict:
        """The head camera sees a corner of the job's (blank) board against
        the bed: where its two edges meet is kept as that corner, with the
        board's turn the edges show (boardlook.corner_from_edges)."""
        job = self._job(body.job)
        point = self._corner_point(job, body.corner)
        link = self.require_link()
        status = link.status_now(1.0, routine=True)
        if status.state != "Idle":
            raise ValueError(f"the machine is {status.state}: find a corner with the head at rest")
        settings = self.camera.settings()
        if settings.mm_per_px <= 0.0:
            raise ValueError("the camera's scale is not measured: Find mark first")
        if not self.camera.running:
            raise ValueError("the camera is not running: start it first")
        head = head_board(status.r, self.table_angle(status), status.z, self.cartesian)
        frame = PictureFrame((head[0] + settings.offset[0], head[1] + settings.offset[1]), settings.roll, False)
        machine, rotation = self._edge_corner(self.camera.client, body.corner, frame, settings)
        middle, _ = self._board_size(job)
        self.head_look.add_corner(job.id, body.corner, point, machine, middle, rotation, "edges")
        self.publish_message("info", f"{body.corner} corner found by its edges at {machine[0]:.3f}, {machine[1]:.3f} mm, the board turned {rotation:+.3f} degrees")
        return self.publish_camera()

    def _edge_corner(self, client, corner: str, frame: PictureFrame, settings) -> tuple[tuple[float, float], float]:
        """Where a board's corner is in a camera's picture now, and its turn,
        from the straight edges pcbv finds (on the edges' picked color when
        there is one)."""
        wait_settled(client)
        reply = client.edges(8, settings.colors.get("edges"))
        width, height = reply.get("width"), reply.get("height")
        if not isinstance(width, (int, float)) or not isinstance(height, (int, float)):
            raise VisionError("pcbv's edges came without the picture's size")
        return corner_from_edges(reply.get("lines") or [], corner, frame, settings.mm_per_px, (float(width), float(height)))

    def camera_lens_clear(self, camera: str) -> dict:
        """The camera's lens correction forgotten."""
        owner, publish = self._controlled(camera)
        owner.set_lens(None)
        return {"camera": camera, "measured": None, "state": publish()}

    def camera_controls(self, camera: str) -> dict:
        """A camera's V4L2 controls as its device has them now, each with
        the value kept for it (set at every start), or why it has none."""
        owner, _ = self._controlled(camera)
        settings = owner.settings()
        kept = dict(settings.controls)
        note = controls_note(settings.device)
        controls: list[dict] = []
        if note is None:
            try:
                controls = list_controls(settings.device)
            except ControlsError as exc:
                raise VisionError(str(exc)) from exc
            for control in controls:
                control["kept"] = kept.get(control["name"])
        return {"camera": camera, "device": settings.device, "local": note is None, "note": note, "controls": controls, "kept": kept}

    def camera_controls_set(self, body: CameraControlsBody) -> dict:
        """Sets control values on a camera's device now and keeps them, to
        be set again each time it starts; a null forgets a kept value."""
        owner, publish = self._controlled(body.camera)
        settings = owner.settings()
        kept = dict(settings.controls)
        wanted = {name: value for name, value in body.values.items() if value is not None}
        for name, value in body.values.items():
            if value is None:
                kept.pop(name, None)
            else:
                kept[name] = value
        owner.update({"controls": kept})
        refused: list[str] = []
        if wanted and controls_note(settings.device) is None:
            refused = set_controls(settings.device, wanted)
        publish()
        return {**self.camera_controls(body.camera), "refused": refused}

    def camera_settings(self, body: CameraSettingsBody) -> dict:
        try:
            self.camera.update(body.model_dump(exclude_none=True))
        finally:
            # A restart that failed has left the camera stopped.
            self.head_look.retune()
            state = self.publish_camera()
        return state

    def camera_start(self) -> dict:
        self.camera.start()
        return self.publish_camera()

    def camera_stop(self) -> dict:
        self.camera.stop()
        self.head_look.stop()
        return self.publish_camera()

    def camera_frame(self, width: int, overlay: bool) -> bytes:
        _check_frame_width(width)
        return self.camera.frame(width, overlay)

    def camera_pose(self) -> dict:
        raw = self.camera.pose()
        if raw is None:
            return {"state": None, "job_center": None}
        pose = pose_summary(raw)
        if pose.get("state") == "locked":
            pose["job_center"] = self._job_center(raw)
        return pose

    def camera_board(self, job_id: str | None) -> dict:
        if job_id is None:
            self.head_look.stop()
            self.camera.load_board(None, None)
        else:
            job = self._job(job_id)
            path = self.store.board_path(job_id)
            if job.design is None or not job.design.board or path is None:
                raise ValueError("the job was not imported from a KiCad board file kept here: the camera has nothing to look for")
            self.camera.load_board(job_id, str(path))
            middle, _ = self._board_size(job)
            self.head_look.stop()
            record = self._board_record("look", "head", job, self.camera.client, self.camera.board_settings(), self._head_picture())
            self.head_look.start(job_id, job.design.board_to_job, middle, self._head_look_place, record)
        return self.publish_camera()

    def _head_picture(self) -> dict:
        """The head camera's place and scale, for a search record."""
        settings = self.camera.settings()
        return {
            "offset": list(settings.offset), "roll": settings.roll, "mirror": False,
            "mm_per_px": settings.mm_per_px, "device": settings.device, "pcbv": settings.pcbv, "lens": settings.lens,
        }

    def camera_search(self, body: BoardSearchBody) -> dict:
        """Moves the head camera over a box until enough looks agree on the
        board loaded (boardlook.py), on the camera's routine thread, owning
        the machine as the find routine does."""
        if self.head_look.job is None or self.head_look.job != self.camera.board_job:
            raise ValueError("no board loaded: press Look for board first")
        job = self._job(self.head_look.job)
        middle, diagonal = self._board_size(job)
        settings = self.camera.settings()
        width, height, scale = self._look_scale(self.camera.client, settings.mm_per_px)
        offset = settings.offset
        with self._owner_lock:
            link = self._movable()
            values = self._values(force=True)
            status = link.status_now(1.0, routine=True)
            access = MachineAccess(
                link=link,
                streamer=self.streamer(status),
                lift=self.lift_height(),
                has_focus_axis=bool(values.get("h_axis")),
                head_point=lambda report: head_board(report.r, self.table_angle(report), report.z, self.cartesian),
            )
            tool = head_board(status.r, self.table_angle(status), status.z, self.cartesian)
            here = (tool[0] + offset[0], tool[1] + offset[1])
            box = body.box if body.box is not None else self._corners_box(self.head_look, job, settings.corner_mm) or search_box(here, diagonal)
            known = self._head_known(job, settings.corner_mm)
            stops = search_stops(box, (width * scale, height * scale), known.place.center if known is not None else here)
            mover = BoardMover(access, self.camera.aborting, CameraError, lambda: self.camera._halt(link))
            look = self.head_look

            def run(progress) -> None:
                mover.begin()
                mover.lift()
                progress.step = "searching"

                def on_stop(index: int, count: int) -> None:
                    progress.done = index + 1
                    self.publish_camera()

                record = self._board_record(
                    "search", "head", job, self.camera.client, self.camera.board_settings(),
                    {**self._head_picture(), "width": width, "height": height, "mm_per_px_used": scale},
                    search_extra(box, here, stops, width * scale, height * scale, known),
                )
                found = search(
                    look, mover, stops, offset, lambda point: PictureFrame(point, settings.roll, False), mover.stopped, on_stop, CameraError, record,
                    checks=self._check_places(job, (width * scale, height * scale)), known=known, side=settings.side,
                )
                self.publish_message("info", found_text(found, look.consensus))

            self.camera.run_routine("search", len(stops) + 1, "looking for the board", link, run)
        return self.camera_state()

    def _head_known(self, job, corner_mm: float) -> KnownPlace | None:
        """Where the head camera's search expects the job's board: where
        the corners taken put it, else where the camera found it, else the
        Align marks' fit, else the job's own place (boardlook.known_place)."""
        middle, diagonal = self._board_size(job)
        try:
            fit = self.alignment.fit(job.id)
            align = measured_known("align", fit.rotation, fit.shift, fit.rms, fit.marks, middle)
        except ValueError:
            align = None
        look = self.head_look
        return known_place(corners_known(look.corners_of(job.id), middle, corner_mm, diagonal), look.found_known(job.id), align, job_known(middle, diagonal))

    def _refine_features(self, job) -> tuple[list[Feature], list[Feature], list[Feature]]:
        """A job's fiducials (from its kept board), drilled holes and pads
        as features to center, in its frame."""
        fiducials: list[Feature] = []
        try:
            parts = self.job_parts(job.id)["components"]
        except Exception as exc:  # the parts are a help, never needed
            log.warning("refine: the board's parts were not read: %r", exc)
            parts = []
        for part in parts:
            if part.get("fiducial"):
                diameter = part.get("diameter")
                size = float(diameter) if isinstance(diameter, (int, float)) and diameter > 0 else 1.0
                fiducials.append(Feature("fiducial", (float(part["x"]), float(part["y"])), size, str(part.get("ref") or "fiducial")))
        holes = [Feature("hole", (float(h[0]), float(h[1])), float(h[2]), f"hole at {h[0]:.2f}, {h[1]:.2f}") for h in job.holes]
        pads = [
            Feature("pad", (float(q[0]), float(q[1])), 2.0 * math.sqrt(max(float(q[2]), 0.0) / math.pi), f"pad at {q[0]:.2f}, {q[1]:.2f}")
            for q in job.pads
        ]
        return fiducials, holes, pads

    def camera_refine(self, body: CameraRefineBody) -> dict:
        """After the board is found (else from its corners), the head camera
        centers features far apart on it (boardlook.pick_features), each
        where the place found puts it, and makes them the job's camera
        marks in Align: a fit over a long baseline, whose turn does not lean
        on the camera's roll or on the picture's few millimeters. On the
        camera's routine thread, owning the machine as the search does."""
        job = self._job(body.job)
        look = self.head_look
        place = look.consensus.best if look.job == job.id and look.consensus.found else None
        if place is None:
            place = look.rough(job.id)
        if place is None:
            raise ValueError("the board's place is not known yet: Look for board and Search until it is found, or take its corners")
        settings = self.camera.settings()
        scale = settings.mm_per_px
        if scale <= 0.0:
            raise ValueError("the camera's scale is not measured: Find mark first")
        if not self.camera.running:
            raise ValueError("the camera is not running: start it first")
        fiducials, holes, pads = self._refine_features(job)
        chosen = pick_features(fiducials, holes, pads, body.use, body.count)
        if len(chosen) < 2:
            raise ValueError(f"the board has no two {'features' if body.use == 'auto' else body.use} clear of the rest to center on")
        with self._owner_lock:
            link = self._movable()
            values = self._values(force=True)
            status = link.status_now(1.0, routine=True)
            access = MachineAccess(
                link=link,
                streamer=self.streamer(status),
                lift=self.lift_height(),
                has_focus_axis=bool(values.get("h_axis")),
                head_point=lambda report: head_board(report.r, self.table_angle(report), report.z, self.cartesian),
            )
            mover = BoardMover(access, self.camera.aborting, CameraError, lambda: self.camera._halt(link))

            def run(progress) -> None:
                mover.begin()
                mover.lift()
                seen: list[tuple[tuple[float, float], tuple[float, float]]] = []
                for index, feature in enumerate(chosen):
                    progress.step = feature.name
                    progress.done = index
                    self.publish_camera()
                    machine = self._center_feature(mover, place.apply(feature.job), feature, settings, progress)
                    seen.append((feature.job, machine))
                state = self.alignment.replace_camera(job, seen)
                self.publish_align()
                fit = state.get("fit") or {}
                rms = fit.get("rms")
                self.publish_message(
                    "info",
                    f"{len(seen)} {chosen[0].kind}s centered, {max(math.dist(a[0], b[0]) for a in seen for b in seen):.1f} mm apart at most:"
                    f" the board turned {fit.get('rotation', 0.0):+.3f} degrees"
                    + (f", {rms * 1000.0:.0f} um rms" if isinstance(rms, (int, float)) else "")
                    + "; Apply in Align moves the job",
                )

            self.camera.run_routine("refine", len(chosen) + 1, "centering features", link, run)
        return self.camera_state()

    def _center_feature(self, mover: BoardMover, point: tuple[float, float], feature: Feature, settings, progress) -> tuple[float, float]:
        """The head camera's picture centered on a feature expected at
        `point` (the board frame): looked for within its clearance of there,
        of about its size (round for a fiducial or a hole), the head moved
        by what is left until the center sits on it; where it is."""
        client = self.camera.client
        scale, roll, offset = settings.mm_per_px, settings.roll, settings.offset
        round_kind = feature.kind in ("fiducial", "hole")
        limits = feature_limits(feature.size, scale) if round_kind else feature_limits(None, scale, math.pi * feature.size * feature.size / 4.0)
        within = max(feature.size / 2.0 + CLEAR_MM / 2.0, 0.5)
        shade = "dark" if feature.kind == "hole" else "bright"
        head = (point[0] - offset[0], point[1] - offset[1])
        mover.go(head)
        for _ in range(CENTER_TRIES + 1):
            if self.camera.aborting():
                raise CameraError("stopped")
            wait_settled(client)
            # A color picked for spots finds fiducials and pads; holes are dark.
            color = settings.colors.get("spots") if feature.kind != "hole" else None
            reply = client.spot(radius=within / scale, polarity=shade, color=color, **limits)
            if not reply.get("found"):
                raise CameraError(f"{feature.name}: nothing within {within:.2f} mm of where the board's place puts it: Search again, or check the camera's scale")
            problem = round_problem(reply) if round_kind else None
            if problem is not None:
                raise CameraError(f"{feature.name}: {problem}")
            progress.spot = spot_of(reply, within / scale)
            off = picture_to_machine(float(reply.get("dx", 0.0)), float(reply.get("dy", 0.0)), scale, roll)
            progress.spot.mm = math.hypot(*off)
            self.publish_camera()
            if math.hypot(*off) <= CENTER_TOLERANCE:
                break
            head = (head[0] + off[0], head[1] + off[1])
            mover.go(head)
        return (round(head[0] + offset[0] + off[0], 4), round(head[1] + offset[1] + off[1], 4))

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
                values = self._values(force=True)
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
        return self.publish_camera()

    def camera_find(self, step: float) -> dict:
        with self._owner_lock:
            link = self._movable()
            values = self._values(force=True)
            status = link.status_now(1.0, routine=True)
            streamer = self.streamer(status)
            access = MachineAccess(
                link=link,
                streamer=streamer,
                lift=self.lift_height(),
                has_focus_axis=bool(values.get("h_axis")),
                head_point=lambda report: head_board(report.r, self.table_angle(report), report.z, self.cartesian),
            )
            self.camera.find(access, step)
        return self.camera_state()

    def camera_abort(self) -> dict:
        self.camera.abort()
        return self.camera_state()

    # --- pick and place -------------------------------------------------------------

    def pnp_settings(self, body: PnpSettingsBody) -> dict:
        try:
            self.pnp.update(body.model_dump(exclude={"clear"}, exclude_none=True), tuple(body.clear))
        finally:
            # A restart that failed has left the up camera stopped.
            state = self.publish_pnp()
        return state

    def pnp_start(self) -> dict:
        self.pnp.start()
        return self.publish_pnp()

    def pnp_stop(self) -> dict:
        self.pnp.stop()
        return self.publish_pnp()

    def pnp_frame(self, width: int, overlay: bool) -> bytes:
        _check_frame_width(width)
        return self.pnp.frame(width, overlay)

    def _pnp_mover(self, link: Link) -> MachineMover:
        values = self._values(force=True)
        status = link.status_now(1.0, routine=True)
        access = MachineAccess(link=link, streamer=self.streamer(status), lift=self.lift_height(), has_focus_axis=bool(values.get("h_axis")))
        return MachineMover(access, self.pnp.aborting, self.publish_message)

    def pnp_nozzle(self, step: float) -> dict:
        """Centers the nozzle of the machine connected over the up camera:
        a G-code machine's place is kept with what the PNP tab keeps of it,
        this project's machine's in the up camera's settings."""
        if self.gcode.connected:
            self.gcode_nozzle(step)
            return self.pnp.state()
        with self._owner_lock:
            link = self._movable()
            self.pnp.center_nozzle(self._pnp_mover(link), step)
        return self.pnp.state()

    def pnp_part(self) -> dict:
        if self.gcode.connected:
            raise ValueError("a G-code machine looks at each part over the bottom camera as it places it: mark its feeder's parts for vision")
        with self._owner_lock:
            link = self._movable()
            self.pnp.measure_part(self._pnp_mover(link))
        return self.pnp.state()

    def pnp_look(self, spot: str) -> dict:
        """The up camera's nozzle or part spot found once, no move: kept in
        its state for the page to draw over the picture."""
        settings = self.pnp.settings()
        self.pnp.look_once(settings.nozzle_spot if spot == "nozzle" else settings.part_spot)
        return self.pnp.state()

    def pnp_abort(self) -> dict:
        self.pnp.abort()
        if self.pnp.target == "gcode":
            # The routine waits on a move and its wait command: the machine
            # is told to stop at once, not once that move has run out.
            self._stop_gcode()
        return self.pnp.state()

    def job_parts(self, job_id: str) -> dict:
        """The parts of a job's board in the job's frame, each marked
        `filtered` when the parts filter leaves it out; none for a job that
        keeps no board file, with why."""
        job = self._job(job_id)
        path = self.store.board_path(job_id)
        if job.design is None or not job.design.board or path is None:
            return {"job": job_id, "components": [], "note": "only a .kicad_pcb upload keeps the board its parts are read from"}
        return {"job": job_id, "components": mark_filtered(job_components(job, path), filter_of(self.config)), "note": None}

    def set_update_prereleases(self, follow: bool) -> dict:
        """Takes pre-releases into the update check or leaves them out, kept
        across restarts."""
        state = self.updater.follow_prereleases(follow)
        with self._config_lock:
            self.config["update_prereleases"] = follow
        self._save_config()
        return state

    def parts_filter_state(self) -> dict:
        return filter_state(filter_of(self.config))

    def set_parts_filter(self, body: PartsFilter) -> dict:
        """Keeps the parts filter; one that does not compile is refused, and
        the one kept before stays."""
        body.compiled()
        with self._config_lock:
            self.config[PARTS_FILTER_KEY] = body.model_dump()
        self._save_config()
        return filter_state(body)

    def pnp_goto(self, body: PnpGotoBody) -> dict:
        """The nozzle over a part's place, by a goto (so at the travel height
        first); with `correct`, the part's center as the up camera last saw
        it on the nozzle goes over the place instead. On a G-code machine
        the place is where the board's references put it, and `camera`
        takes the top camera's picture center there instead."""
        if self.gcode.connected:
            return self.gcode_goto_part(body)
        part = self._part(body.job, body.ref)
        target = (float(part["x"]), float(part["y"]))
        with self._owner_lock, self._move_lock:
            link = self._movable()
            if not body.correct:
                return self._goto(link, GotoBody(kind="board", x=target[0], y=target[1]))
            seen = self.pnp.part_offset
            if seen is None:
                raise ValueError("no part has been looked at on the nozzle: measure it over the bottom camera first")
            streamer, _ = self._move_frame(link)
            if not streamer.cartesian:
                raise ValueError("the bottom camera needs an X/Y machine ($cartesian=1)")
            joint = streamer.joint_at(target)
            return self._goto(link, GotoBody(kind="joint", r=joint[0] - seen["dx"], z=joint[1] - seen["dy"]))

    # --- alignment ------------------------------------------------------------------

    def align_mark(self, body: AlignMarkBody) -> dict:
        job = self._job(body.job)
        with self._owner_lock:
            link = self._movable()
            status = link.status_now(1.0, routine=True)
        point = head_board(status.r, self.table_angle(status), status.z, self.cartesian)
        state = self.alignment.mark_tool(job, point, body.design, body.nearest, body.within)
        self.publish_align()
        return state

    def align_capture(self, job_id: str) -> dict:
        """Marks from the head camera: the board found (its middle where
        the most likely guess puts it, and its turn), else the corners taken
        of it (a mark each), else the newest locked pose."""
        job = self._job(job_id)
        looking = self.camera.running and self.camera.board_job == job_id and job.design is not None
        best = self.head_look.consensus.best if looking and self.head_look.job == job_id and self.head_look.consensus.found else None
        if best is not None:
            # A guess likely enough: its median place and turn of the board,
            # its middle in the job paired with where it is on the machine.
            middle = self.head_look.consensus.middle
            state = self.alignment.mark_camera(job, middle, best.center, best.rotation if self.camera.settings().side == "front" else None)
            self.publish_align()
            return state
        corners = self.head_look.corners_of(job_id)
        if corners:
            for corner in corners:
                state = self.alignment.mark_camera(job, corner.job, corner.machine, None)
            self.publish_align()
            return state
        if not self.camera.running:
            raise CameraError("the camera is not running")
        if not looking:
            raise CameraError("the camera is not looking for this job's board: load it first, or take its corners")
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
        self._job(job_id)
        return self.alignment.fit(job_id).to_dict()

    @editing_job
    def align_apply(self, job_id: str) -> dict:
        updated, fit = self.alignment.apply(self._idle_job(job_id))
        updated.refresh_stats(self.streamer())
        self.store.save(updated)
        self.publish_align()
        log.info("job %s aligned: turned %.4f degrees, moved (%.4f, %.4f), rms %.4f over %d marks", job_id, fit.rotation, fit.shift[0], fit.shift[1], fit.rms, fit.marks)
        return {"job": updated.model_dump(), "fit": fit.to_dict()}

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


def move_device_profiles(pnp_dir: Path, machines_dir: Path) -> list[str]:
    """G-code device profiles a backend from before kept in `pnp_dir`,
    written into `machines_dir` as G-code machine files (the profile's
    text with `controller = "gcode"` and its [camera] table, the up
    camera's, called [up_camera]), each one only when no machine file has
    its id, and only when it reads that way. What was done, a line each."""
    done: list[str] = []
    if not pnp_dir.is_dir():
        return done
    for path in sorted(pnp_dir.glob("*.toml")):
        target = machines_dir / path.name
        if target.exists():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            done.append(f"{path}: not moved to {machines_dir}: {exc}")
            continue
        text = re.sub(r"^\[camera\]", "[up_camera]", text, flags=re.MULTILINE)
        text = 'controller = "gcode"\n' + text
        try:
            machine_of(machine_files.parse(text, path.stem, str(target)))
        except machine_files.MachineError as exc:
            done.append(f"{path}: not moved to {machines_dir}: {exc}")
            continue
        try:
            machines_dir.mkdir(parents=True, exist_ok=True)
            write_whole(target, text)
        except OSError as exc:
            done.append(f"{path}: not moved to {machines_dir}: {exc}")
            continue
        done.append(f"{path}: written as the G-code machine file {target}")
    return done


def _move_device_config(config: dict) -> None:
    """What a backend from before G-code machines were machine files kept of
    its G-code device (under `pnp_device`, for the profile picked) moved to
    where it is kept now: under `placing`, by the machine file's id, which
    is the profile's (its file moved from pnp/ to machines/)."""
    old = config.pop("pnp_device", None)
    if not isinstance(old, dict):
        return
    machine_id = old.get("profile")
    if not isinstance(machine_id, str) or not machine_id:
        return
    placing = config.setdefault("placing", {})
    if isinstance(placing, dict) and machine_id not in placing:
        placing[machine_id] = {key: value for key, value in old.items() if key in ("angle", "references", "taken", "boards", "camera", "top")}
    config.setdefault("placing_machine", machine_id)


def profile_of(values: dict) -> dict:
    """What the machine is, from its settings: how the head moves over the
    board, what is on the output, and the limits a page draws."""
    if _setting(values, "spindle"):
        tool = SPINDLE
    elif _setting(values, "dispenser") and _setting(values, "cartesian"):
        tool = DISPENSER
    else:
        tool = LASER
    r_max, z_max = _soft_limits(values)
    return {
        "kinematics": CARTESIAN if _setting(values, "cartesian") else POLAR,
        "tool": tool,
        "h_axis": bool(_setting(values, "h_axis")),
        "r_max": r_max,
        "z_max": z_max,
        "controller": machine_files.SPINNY,
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


def _look_tuning(settings) -> tuple[float, float]:
    """A camera's look settings: the threshold of the most likely guess
    and the corners' tolerance."""
    return settings.look_threshold, settings.corner_mm


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
# Where the backend's own tools reach it when nothing says otherwise: the
# Claude Code provider of the Auto tab hands this to `spinny-mcp`.
DEFAULT_API_URL = "http://127.0.0.1:8000"


async def _read_uploads(files: list[UploadFile]) -> list[tuple[str, bytes]]:
    """Each upload's name and bytes, read a megabyte at a time; 413 once
    they come to more than MAX_UPLOAD_BYTES together."""
    read: list[tuple[str, bytes]] = []
    size = 0
    for upload in files:
        chunks: list[bytes] = []
        while chunk := await upload.read(1 << 20):
            size += len(chunk)
            if size > MAX_UPLOAD_BYTES:
                raise HTTPException(status_code=413, detail=f"the upload is over {MAX_UPLOAD_BYTES >> 20} MB")
            chunks.append(chunk)
        read.append((upload.filename or "", b"".join(chunks)))
    return read


async def _keep_connected(backend: Backend) -> None:
    while True:
        try:
            await run_in_threadpool(backend.autoconnect_tick)
        except Exception as exc:
            log.error("autoconnect failed: %r", exc)
        await asyncio.sleep(AUTOCONNECT_INTERVAL)


def create_app(
    backend: Backend,
    frontend: Path | None = None,
    cors_origins: list[str] | None = None,
    allowed_hosts: list[str] | None = None,
    api_url: str | None = None,
) -> FastAPI:
    frontend = FRONTEND_DIST if frontend is None else frontend
    # The Auto tab's agent: its tools call into this app itself, so a tool
    # meets the same routes and guards a page does.
    agent = Agent(
        config=backend.config,
        save_config=backend._save_config,
        publish=backend.broadcast.publish,
        toolbox=lambda: ToolBox.in_process(app),
        api_url=api_url or DEFAULT_API_URL,
        workdir=backend.root / "auto",
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        backend.broadcast.loop = asyncio.get_running_loop()
        keeper = asyncio.ensure_future(_keep_connected(backend)) if backend.autoconnect else None
        try:
            yield
        finally:
            if keeper is not None:
                keeper.cancel()
            await agent.shutdown()
            await run_in_threadpool(backend.shutdown)

    app = FastAPI(title="spinny-web", version=__version__, lifespan=lifespan)
    app.state.backend = backend
    app.state.auto = agent

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
        from urllib.parse import urlsplit

        from starlette.middleware.trustedhost import TrustedHostMiddleware, parse_host_header

        # The loopback names are always taken: the backend's own tools come
        # in under them (the Auto tab's in-process calls), and a page served
        # from elsewhere cannot send them as its host, which is all the
        # check is for. So is the address handed to the MCP server the
        # Claude Code provider starts, the bound one when that is not every
        # address: a browser sends it as the host only for a page loaded
        # from this server's own address, never for a rebound name.
        own = parse_host_header(urlsplit(api_url or DEFAULT_API_URL).netloc)
        hosts = list(dict.fromkeys([*allowed_hosts, "127.0.0.1", "localhost", *([own.host] if own else [])]))
        app.add_middleware(TrustedHostMiddleware, allowed_hosts=hosts)

    def guarded(call: Callable[[], Any]) -> Any:
        try:
            return call()
        except CommandError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except (RunnerError, ProberError) as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except NotFound as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except GcodeLinkError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        except (CameraError, PnpError) as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except (LinkError, VisionError) as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    def jpeg(take: Callable[[], bytes], not_running: type[Exception]) -> Response:
        """A camera's picture, never kept by the browser: 404 while the
        camera is stopped (`not_running` is what it raises then) or has no
        picture yet, 400 for a width out of range, 502 for pcbv failing."""
        try:
            data = take()
        except not_running as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except VisionError as exc:
            if "no frame" in str(exc):
                raise HTTPException(status_code=404, detail="no picture yet") from exc
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return Response(content=data, media_type="image/jpeg", headers={"Cache-Control": "no-store"})

    # --- connection ---

    @app.get("/api/ports")
    def ports():
        return backend.ports()

    @app.post("/api/connect")
    def connect(body: ConnectBody):
        return guarded(lambda: backend.connect(body.url, body.machine))

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

    @app.post("/api/stop")
    def stop_all():
        return guarded(backend.stop_all)

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

    @app.post("/api/servo")
    def servo(body: ServoBody):
        return guarded(lambda: backend.servo(body.servo, body.angle))

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

    @app.post("/api/machines/{machine_id}/from-board")
    def machine_from_board(machine_id: str, body: MachineTextBody):
        return guarded(lambda: backend.machine_from_board(machine_id, body.text))

    @app.delete("/api/machines/{machine_id}")
    def machine_delete(machine_id: str):
        def remove():
            if backend.gcode.connected and backend._gcode_id == machine_id:
                raise HTTPException(status_code=409, detail="disconnect the machine before removing its file")
            backend.machine_store.remove(machine_id)

        guarded(remove)
        return {"deleted": machine_id}

    @app.patch("/api/machines/{machine_id}")
    def machine_patch(machine_id: str, body: MachinePatchBody):
        result = guarded(lambda: backend.machine_store.patch(machine_id, body.path, body.value))
        backend.publish_placing()
        return result

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
        uploads = await _read_uploads(files)
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
        mirror: str | None = Form(None),
        margin: float | None = Form(None),
    ):
        options = ImportOptions(tolerance=backend.tolerance)
        # Left out or auto, a layer on the back is flipped in X.
        if mirror and mirror.strip().lower() != "auto":
            options.mirror = mirror.strip().lower()
        if layer:
            options.layer = layer.strip()
        elif mode and mode.strip().lower() in (MODE_DISPENSE, MODE_STENCIL):
            # Paste goes where the paste layer says, and so do its openings.
            options.layer = PASTE_LAYER
        if thickness is not None:
            options.thickness = thickness
        if margin is not None:
            options.margin = margin
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
        [(filename, data)] = await _read_uploads([file])
        job = await run_in_threadpool(guarded, lambda: backend.import_upload(filename, data, options))
        return job.model_dump()

    @app.post("/api/center")
    def center_job(body: center.CenterRequest):
        return guarded(lambda: backend.center_job(body))

    @app.post("/api/calibrate")
    def calibrate_job(body: calibration.CalibrateRequest):
        return guarded(lambda: backend.calibrate_job(body))

    def updating(call: Callable[[], dict]) -> dict:
        try:
            return call()
        except update.UpdateError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/api/update")
    def update_state():
        return backend.updater.snapshot()

    @app.post("/api/update/check")
    def update_check():
        return updating(backend.updater.check)

    @app.post("/api/update/install")
    def update_install():
        return updating(backend.updater.start)

    @app.put("/api/update/settings")
    def update_settings(body: UpdateSettingsBody):
        return updating(lambda: backend.set_update_prereleases(body.prereleases))

    @app.get("/api/jobs")
    def list_jobs():
        return {"jobs": [job.summary() for job in backend.store.list()]}

    @app.delete("/api/jobs")
    def delete_all_jobs():
        return backend.delete_all_jobs()

    @app.get("/api/jobs/{job_id}")
    def get_job(job_id: str):
        return backend._job(job_id).model_dump()

    @app.get("/api/jobs/{job_id}/thumb.svg")
    def get_job_thumb(job_id: str):
        # The page asks with a key of the job's state in the address, so a
        # drawing can be kept as long as the address is the same.
        job = backend._job(job_id)
        return Response(content=thumbs.thumbnail(job), media_type="image/svg+xml", headers={"Cache-Control": "max-age=86400"})

    @app.patch("/api/jobs/{job_id}")
    def patch_job(job_id: str, patch: JobPatch):
        return guarded(lambda: backend.patch_job(job_id, patch)).model_dump()

    @app.post("/api/jobs/combine")
    def combine_jobs(body: CombineBody):
        return guarded(lambda: backend.combine_jobs(body.ids, body.name)).model_dump()

    @app.put("/api/jobs/{job_id}")
    def put_job(job_id: str, body: dict):
        return guarded(lambda: backend.replace_job(job_id, body)).model_dump()

    @app.post("/api/jobs/{job_id}/width")
    def set_job_width(job_id: str, body: WidthBody):
        return guarded(lambda: backend.set_job_width(job_id, body.width)).model_dump()

    @app.post("/api/jobs/{job_id}/margin")
    def set_job_margin(job_id: str, body: MarginBody):
        return guarded(lambda: backend.set_job_margin(job_id, body.margin)).model_dump()

    @app.post("/api/mill/plan")
    def plan_mill(body: mill.MillJobBody | mill.MillOperation):
        return guarded(lambda: backend.mill_job(body, keep=False))

    @app.post("/api/mill")
    def make_mill(body: mill.MillJobBody | mill.MillOperation):
        return guarded(lambda: backend.mill_job(body, keep=True))

    @app.get("/api/markers")
    def get_markers():
        return backend.markers_state()

    @app.put("/api/markers")
    def put_markers(body: marker_list.MarkerList):
        return guarded(lambda: backend.set_markers(body.markers))

    # The top bar's to-do list, kept beside the config.
    todo.add_routes(app, todo.TodoStore(backend.config_path.parent / "todo.json"))
    # Bug reports from the page, kept beside the config and handed on as
    # its report link says.
    app.state.reports = reports.ReportDesk(
        backend.config_path.parent / "reports",
        backend.config,
        backend._save_config,
        lambda: f"{backend.updater.version} ({backend.updater.state.get('kind', 'checkout')})",
    )
    reports.add_routes(app, app.state.reports)
    # Plugins for the page, each off until the operator turns it on; every
    # change goes to every page, which starts and stops its plugins by it.
    plugins.add_routes(app, plugins.PluginStore(
        backend.config_path.parent / "plugins",
        publish=lambda listed: backend.broadcast.publish_threadsafe({"type": "plugins", "plugins": listed}),
    ))

    @app.delete("/api/jobs/{job_id}")
    def delete_job(job_id: str):
        if backend.runner.active and backend.runner.progress.job == job_id:
            raise HTTPException(status_code=409, detail="the job is running")
        if not backend.store.remove(job_id):
            raise HTTPException(status_code=404, detail="no such job")
        return {"deleted": job_id}

    @app.post("/api/jobs/{job_id}/run")
    def run_job(job_id: str, body: RunBody | None = None):
        body = body if body is not None else RunBody()
        return guarded(lambda: backend.run_job(job_id, body.compensate, body.focus_here))

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

    @app.post("/api/heightmap/focus/keep")
    def keep_focus():
        return guarded(backend.keep_focus)

    @app.post("/api/heightmap/pads")
    def start_pads(body: PadsBody):
        return guarded(lambda: backend.start_pads(body))

    @app.post("/api/heightmap/pads/plan")
    def pads_plan(body: PadsBody):
        return guarded(lambda: backend.pads_plan(body))

    # --- camera ---

    @app.get("/api/cameras")
    def cameras():
        return backend.cameras()

    @app.get("/api/cameras/controls")
    def camera_controls(camera: Literal["head", "up", "top"] = "head"):
        return guarded(lambda: backend.camera_controls(camera))

    @app.post("/api/cameras/color")
    def camera_color(body: CameraColorBody):
        return guarded(lambda: backend.camera_color(body))

    @app.post("/api/camera/edge-corner")
    def camera_edge_corner(body: BoardCornerBody):
        return guarded(lambda: backend.camera_edge_corner(body))

    @app.post("/api/camera/refine")
    def camera_refine(body: CameraRefineBody):
        return guarded(lambda: backend.camera_refine(body))

    @app.post("/api/cameras/lens")
    def camera_lens(body: CameraLensBody):
        return guarded(lambda: backend.camera_lens(body))

    @app.delete("/api/cameras/lens")
    def camera_lens_clear(camera: Literal["head", "up", "top"] = "head"):
        return guarded(lambda: backend.camera_lens_clear(camera))

    @app.put("/api/cameras/controls")
    def camera_controls_set(body: CameraControlsBody):
        return guarded(lambda: backend.camera_controls_set(body))

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
        return jpeg(lambda: backend.camera_frame(width, bool(overlay)), CameraError)

    @app.get("/api/camera/pose")
    def camera_pose():
        return guarded(backend.camera_pose)

    # --- the camera log ---

    @app.get("/api/camlog")
    def camlog_state(limit: int = 100, camera: str | None = None):
        return guarded(lambda: backend.camlog_state(limit, camera))

    @app.put("/api/camlog")
    def camlog_set(body: CamLogBody):
        return guarded(lambda: backend.set_camlog(body.enabled))

    @app.post("/api/camlog/photo")
    def camlog_photo(body: CamLogPhotoBody):
        return guarded(lambda: backend.camlog_photo(body.camera, body.find))

    @app.delete("/api/camlog")
    def camlog_clear():
        return guarded(backend.clear_camlog)

    @app.get("/api/camlog/{name}")
    def camlog_file(name: str):
        path = backend.camlog.path_of(name)
        if path is None:
            raise HTTPException(status_code=404, detail="no such picture")
        media = "image/svg+xml" if name.endswith(".svg") else "image/jpeg"
        return Response(content=path.read_bytes(), media_type=media, headers={"Cache-Control": "max-age=3600"})

    # --- the search records ---

    @app.get("/api/searchlog")
    def searchlog_state(limit: int = 20, camera: str | None = None):
        return guarded(lambda: backend.searchlog_state(limit, camera))

    @app.delete("/api/searchlog")
    def searchlog_clear():
        return guarded(backend.clear_searchlog)

    @app.get("/api/searchlog/{record_id}")
    def searchlog_record(record_id: str):
        return guarded(lambda: backend.searchlog_record(record_id))

    @app.get("/api/searchlog/{record_id}/report")
    def searchlog_report(record_id: str):
        page = guarded(lambda: backend.searchlog_report(record_id))
        return Response(content=page, media_type="text/html; charset=utf-8", headers={"Cache-Control": "no-store"})

    @app.get("/api/searchlog/{record_id}/{name}")
    def searchlog_file(record_id: str, name: str):
        path = backend.searchlog.path_of(record_id, name)
        if path is None:
            raise HTTPException(status_code=404, detail="no such file in the record")
        if name.endswith(".jpg"):
            return Response(content=path.read_bytes(), media_type="image/jpeg", headers={"Cache-Control": "max-age=3600"})
        media = "application/json" if name.endswith(".json") else "text/plain; charset=utf-8"
        # The header and the lines grow while a record is written.
        return Response(content=path.read_bytes(), media_type=media, headers={"Cache-Control": "no-store"})

    @app.post("/api/camera/board")
    def camera_board(body: CameraBoardBody):
        return guarded(lambda: backend.camera_board(body.job))

    @app.post("/api/camera/corner")
    def camera_corner(body: BoardCornerBody):
        return guarded(lambda: backend.camera_corner(body))

    @app.delete("/api/camera/corners")
    def camera_corners_clear():
        return guarded(backend.camera_corners_clear)

    @app.post("/api/camera/mark")
    def camera_mark(body: CameraMarkBody):
        return guarded(lambda: backend.camera_mark(body))

    @app.post("/api/camera/find")
    def camera_find(body: CameraFindBody | None = None):
        return guarded(lambda: backend.camera_find((body or CameraFindBody()).step))

    @app.post("/api/camera/search")
    def camera_search(body: BoardSearchBody | None = None):
        return guarded(lambda: backend.camera_search(body or BoardSearchBody()))

    @app.post("/api/camera/abort")
    def camera_abort():
        return guarded(backend.camera_abort)

    # --- pick and place ---

    @app.get("/api/pnp")
    def pnp_state():
        return guarded(backend.pnp.state)

    @app.put("/api/pnp/settings")
    def pnp_settings(body: PnpSettingsBody):
        return guarded(lambda: backend.pnp_settings(body))

    @app.post("/api/pnp/start")
    def pnp_start():
        return guarded(backend.pnp_start)

    @app.post("/api/pnp/stop")
    def pnp_stop():
        return guarded(backend.pnp_stop)

    @app.get("/api/pnp/frame.jpg")
    def pnp_frame(width: int = FRAME_DEFAULT_WIDTH, overlay: int = 1):
        return jpeg(lambda: backend.pnp_frame(width, bool(overlay)), PnpError)

    @app.post("/api/pnp/nozzle")
    def pnp_nozzle(body: PnpNozzleBody | None = None):
        return guarded(lambda: backend.pnp_nozzle((body or PnpNozzleBody()).step))

    @app.post("/api/pnp/part")
    def pnp_part():
        return guarded(backend.pnp_part)

    @app.post("/api/pnp/look")
    def pnp_look(body: PnpLookBody | None = None):
        return guarded(lambda: backend.pnp_look((body or PnpLookBody()).spot))

    @app.post("/api/pnp/abort")
    def pnp_abort():
        return guarded(backend.pnp_abort)

    @app.post("/api/pnp/goto")
    def pnp_goto(body: PnpGotoBody):
        return guarded(lambda: backend.pnp_goto(body))

    @app.get("/api/jobs/{job_id}/components")
    def job_components_route(job_id: str):
        return guarded(lambda: backend.job_parts(job_id))

    @app.get("/api/pnp/parts-filter")
    def parts_filter_state():
        return backend.parts_filter_state()

    @app.put("/api/pnp/parts-filter")
    def set_parts_filter(body: PartsFilter):
        return guarded(lambda: backend.set_parts_filter(body))

    # --- placing with a G-code machine ---

    @app.get("/api/pnp/placing")
    def placing_state():
        return guarded(backend.placing_state)

    @app.put("/api/pnp/placing")
    def placing_angle(body: PnpAngleBody):
        return guarded(lambda: backend.placing_angle(body))

    @app.post("/api/pnp/references")
    def pnp_reference(body: PnpReferenceBody):
        return guarded(lambda: backend.pnp_reference(body))

    @app.delete("/api/pnp/references")
    def pnp_drop_references(job: str, ref: str | None = None):
        return guarded(lambda: backend.pnp_drop_references(job, ref))

    @app.post("/api/pnp/plan")
    def pnp_plan(body: PnpPlanBody):
        return guarded(lambda: backend.pnp_plan(body))

    @app.get("/api/pnp/program.gcode")
    def pnp_program(job: str, refs: str | None = None):
        wanted = [ref for ref in refs.split(",") if ref] if refs else None
        text = guarded(lambda: backend.pnp_program(job, wanted))
        return Response(content=text, media_type="text/plain", headers={"Content-Disposition": 'attachment; filename="placement.gcode"', "Cache-Control": "no-store"})

    @app.post("/api/pnp/run")
    def pnp_run(body: PnpPlanBody):
        return guarded(lambda: backend.pnp_run(body))

    @app.post("/api/pnp/run/stop")
    def pnp_run_stop():
        return guarded(backend.pnp_run_stop)

    @app.post("/api/pnp/park")
    def pnp_park():
        return guarded(backend.pnp_park)

    @app.post("/api/pnp/over-camera")
    def pnp_over_camera():
        return guarded(backend.pnp_over_camera)

    @app.post("/api/pnp/swap")
    def pnp_swap(body: PnpSwapBody):
        return guarded(lambda: backend.pnp_swap(body))

    @app.put("/api/pnp/camera")
    def pnp_camera_place(body: PnpCameraBody):
        return guarded(lambda: backend.pnp_camera_place(body))

    @app.post("/api/pnp/light")
    def pnp_light(body: PnpLightBody):
        return guarded(lambda: backend.pnp_light(body.on))

    @app.post("/api/pnp/vacuum")
    def pnp_vacuum(body: PnpVacuumBody):
        return guarded(lambda: backend.pnp_vacuum(body))

    @app.post("/api/pnp/boards/reset")
    def pnp_boards_reset():
        return guarded(backend.pnp_boards_reset)

    @app.post("/api/pnp/bus/scan")
    def pnp_bus_scan():
        return guarded(backend.pnp_bus_scan)

    @app.post("/api/pnp/bus/feed")
    def pnp_bus_feed(body: PnpBusFeedBody):
        return guarded(lambda: backend.pnp_bus_feed(body.feeder))

    @app.post("/api/pnp/feeders/reset")
    def pnp_reset_feeders(body: PnpFeederBody | None = None):
        return guarded(lambda: backend.pnp_reset_feeders(body or PnpFeederBody()))

    @app.post("/api/pnp/runout")
    def pnp_runout():
        return guarded(backend.pnp_runout)

    @app.post("/api/pnp/fiducials")
    def pnp_fiducials(body: PnpFiducialsBody):
        return guarded(lambda: backend.pnp_fiducials(body))

    @app.put("/api/pnp/top")
    def top_settings(body: TopSettingsBody):
        return guarded(lambda: backend.top_settings(body))

    @app.post("/api/pnp/top/start")
    def top_start():
        return guarded(backend.top_start)

    @app.post("/api/pnp/top/stop")
    def top_stop():
        return guarded(backend.top_stop)

    @app.get("/api/pnp/top/frame.jpg")
    def top_frame(width: int = FRAME_DEFAULT_WIDTH, overlay: int = 1):
        return jpeg(lambda: backend.top_frame(width, bool(overlay)), PnpError)

    @app.post("/api/pnp/top/mark")
    def top_mark():
        return guarded(backend.top_mark)

    @app.post("/api/pnp/top/offset")
    def top_offset(body: TopOffsetBody | None = None):
        return guarded(lambda: backend.top_offset((body or TopOffsetBody()).step))

    @app.post("/api/pnp/top/look")
    def top_look():
        return guarded(backend.top_look)

    @app.post("/api/pnp/top/board")
    def top_board(body: CameraBoardBody):
        return guarded(lambda: backend.top_board(body.job))

    @app.post("/api/pnp/top/search")
    def top_search(body: BoardSearchBody | None = None):
        return guarded(lambda: backend.top_search(body or BoardSearchBody()))

    @app.post("/api/pnp/top/place")
    def top_place(body: BoardPlaceBody):
        return guarded(lambda: backend.top_place(body))

    @app.post("/api/pnp/top/corner")
    def top_corner(body: BoardCornerBody):
        return guarded(lambda: backend.top_corner(body))

    @app.post("/api/pnp/top/edge-corner")
    def top_edge_corner(body: BoardCornerBody):
        return guarded(lambda: backend.top_edge_corner(body))

    @app.delete("/api/pnp/top/corners")
    def top_corners_clear():
        return guarded(backend.top_corners_clear)

    @app.post("/api/pnp/top/home")
    def top_home():
        return guarded(backend.top_home)

    @app.post("/api/pnp/top/abort")
    def top_abort():
        return guarded(backend.top_abort)

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

    # --- the Auto tab ---

    @app.get("/api/auto/settings")
    async def auto_settings():
        return agent.settings()

    @app.put("/api/auto/settings")
    async def put_auto_settings(body: AutoSettingsBody):
        try:
            return agent.update_settings(body.provider, body.model, body.base_url)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/api/auto/conversation")
    async def auto_conversation():
        return agent.conversation()

    @app.post("/api/auto/messages")
    async def auto_message(body: AutoMessageBody):
        try:
            return agent.send(body.text)
        except AutoBusy as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/auto/stop")
    async def auto_stop():
        return await agent.stop()

    @app.delete("/api/auto/conversation")
    async def auto_clear():
        return await agent.clear()

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
        help="how much the backend writes to spinny.log in --data and to stderr (default: info, or SPINNY_LOG_LEVEL)",
    )
    parser.add_argument("--version", action="version", version=__version__)
    updating = parser.add_mutually_exclusive_group()
    updating.add_argument("--check-update", action="store_true", help="ask GitHub for the latest release and say how it stands against this one, then end")
    updating.add_argument(
        "--update",
        action="store_true",
        help="download the latest release for this platform, check it against its SHA256SUMS, unpack it beside this one and point the link `spinny` beside them at it, then end",
    )
    updating.add_argument("--rollback", action="store_true", help="point the link `spinny` back at the release before the last update, then end")
    parser.add_argument(
        "--pre",
        action="store_true",
        help="with --check-update or --update: take pre-releases too, the newest release by version that has this platform's archive",
    )
    args = parser.parse_args(argv)
    if args.pre and not (args.check_update or args.update):
        parser.error("--pre goes with --check-update or --update")
    if args.check_update or args.update or args.rollback:
        return update.command("check" if args.check_update else "update" if args.update else "rollback", prereleases=args.pre)
    setup_log(args.data, level=args.log_level)
    log.info("spinny-web %s starting on %s:%d, files in %s", __version__, args.host, args.port, args.data)
    # A release's first start: the machine and CAM files it ships fill
    # whichever of these directories does not exist yet.
    for directory, name in ((args.machines, "machines"), (args.cam, "cam")):
        if home.seed(directory, SHIPPED_DIR / name):
            log.info("%s: the shipped %s files copied in", directory, name)
    for moved in move_device_profiles(HOME / "pnp", args.machines):
        log.info("%s", moved)
    backend = Backend(root=args.data, machines_dir=args.machines, cam_dir=args.cam)
    backend.autoconnect = args.connect
    # Where this backend is reached from the same machine, for the MCP
    # server the Auto tab's Claude Code provider starts.
    reach = "127.0.0.1" if args.host in ("", "0.0.0.0", "::") else args.host
    if ":" in reach and not reach.startswith("["):
        reach = f"[{reach}]"
    uvicorn.run(
        create_app(
            backend=backend,
            cors_origins=args.cors_origin,
            allowed_hosts=args.allowed_host,
            api_url=f"http://{reach}:{args.port}",
        ),
        host=args.host,
        port=args.port,
        log_level="info",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
