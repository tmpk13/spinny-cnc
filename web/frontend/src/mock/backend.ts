// In-page fake backend for `?mock=1`: a machine that moves at the firmware's
// rates, the job store, and the event feed the real WebSocket would carry.

import { fitRigid, turnPoint } from "../align.ts";
import { ApiError, errorText, frameWidth, thumbKey, type Api } from "../api.ts";
import { defaultControls } from "../controls.ts";
import { formatFixed } from "../format.ts";
import { fromBoard, type FromBoard } from "../machinekeys.ts";
import {
    AXIS_EPSILON,
    DEG,
    boardOfJoint,
    cappedRate,
    cartesianSurfaceLength,
    distanceToSegment,
    headBoard,
    jointOfBoard,
    lerpJoint,
    segmentBoardMove,
    surfaceLength,
    turned,
    unwrap,
} from "../kinematics.ts";
import {
    DEFAULT_DEPTH,
    DEFAULT_PLUNGE,
    MAX_VALUE,
    MAX_VALUE_TEXT,
    buildJob,
    jobFromJson,
    centerJob,
    checkDepth,
    checkPasses,
    checkPower,
    checkSpeed,
    computeStats,
    demoCoupon,
    formatG,
    placeJob,
    round4,
    checkThickness,
    checkFocus,
    DEFAULT_THICKNESS,
    shiftPaths,
} from "./jobs.ts";
import { groupMoves, jointPreview, pathMoves, type PlannedMove } from "../moves.ts";
import { ID_PATTERN, SHIPPED_PROFILES, buildCamJob, buildModelJob, camGcode, parseProfile, setValue, summaryOf } from "./cam.ts";
import {
    CAMERA_DEFAULTS,
    DEFAULT_SETTINGS,
    FLOAT_MAX,
    INT_MAX,
    MACHINE_ID_PATTERN,
    MICROSTEPS,
    MOCK_MACHINE_TEXTS,
    gcodeMachineOf,
    PIN_MAX,
    PROBE_MS_MAX,
    RESERVED_PINS,
    TUNING_BOUNDS,
    matches,
    parseMachine,
    summaryOf as machineSummaryOf,
} from "./machines.ts";
import { MAX_POINTS, MIN_AREA, fillPadHeights, padMapGrid, selectPads } from "./padmap.ts";
import { thumbnail } from "./thumbs.ts";
import { iconProblem } from "../icons.ts";
import { extent } from "./order.ts";
import { buildMillJob, carryJobSettings, carrySettings, cutMiddle, labelStem, MAX_OPERATIONS, moveJob, movedAs, placed, remakeMill, unplaced } from "./mill.ts";
import { defaultOperation, recipeOps } from "../sketch.ts";
import { calibrateJob } from "./calibrate.ts";
import {
    DEVICE_CAMERA_WHERE,
    DEVICE_RUNOUT,
    PNP_DEFAULTS,
    TOP_DEFAULTS,
    TOP_TRUTH,
    UP_TRUTH,
    checkPnpSettings,
    checkTopSettings,
    markFiltered,
    mockComponents,
    partsFilterPattern,
    partsFilterState,
    topFrameSvg,
    upFrameSvg,
    upInPicture,
    upPicturePoint,
} from "./pnp.ts";
import { MockCameraLog, svgUrl } from "./camlog.ts";
import { MockSearchLog, mockRecordUrl } from "./searchlog.ts";
import {
    CORNER_MM,
    LOOK_NEED,
    LOOK_SAMPLE_SECONDS,
    LOOK_THRESHOLD,
    MockBoardLook,
    SEARCH_STOP_SECONDS,
    applyEstimate,
    cornersKnown,
    estimateOf,
    jobKnown,
    jobSize,
    onBoard,
    roughBox,
    searchStops,
    type MachinePicture,
    type SearchBox,
} from "./boardlook.ts";
import { CORNER_NAMES, cornerOf } from "../corners.ts";
import { MockAuto } from "./auto.ts";
import { MockTodo } from "./todo.ts";
import { MockReports } from "./reports.ts";
import { MockPlugins } from "./plugins.ts";
import type { PluginInfo, PluginWithSource } from "../plugins.ts";
import type { BugReport, ReportAnswer, ReportSettings } from "../reports.ts";
import type { TodoItem, TodoList } from "../todo.ts";
import { decodePacket, encodePacket, idBytes, slotPlace, type BusPacket } from "../feederbus.ts";
import {
    angleWord,
    codeOf,
    type AxisName,
    deviceDocument,
    deviceFit,
    gnum,
    gotoLines,
    liftsLeaving,
    moveLine,
    placeLines,
    planDevice,
    planSummary,
    planText,
    safeLine,
    vacuumReading,
    wrapAngle,
    xyLine,
    zLine,
    jsPattern,
    type MockBlock,
    type MockDevice,
    type MockFeeder,
} from "./openpnp.ts";
import {
    BOARD_MISPLACEMENT,
    CAMERA_TRUTH,
    CAPTURE_KEYS,
    MOCK_CAMERAS,
    MOCK_CONTROLS,
    controlsNote,
    POSE_AGE_MS,
    POSE_FPS,
    boardPose,
    boardVector,
    checkCameraSettings,
    designPoint,
    frameSvg,
    inPicture,
    jobBounds,
    jobPlacement,
    parseSize,
    picturePoint,
    placedPoint,
    type Placement,
} from "./vision.ts";
import type { LinkStatus } from "../state.ts";
import type {
    AlignFit,
    AlignMark,
    AlignMarkRequest,
    AlignState,
    AutoConversation,
    AutoSettings,
    AutoSettingsUpdate,
    Board,
    BoardEstimate,
    BusFeeder,
    CalibrateRequest,
    CalibrateResponse,
    CameraColors,
    CameraControls,
    CameraLens,
    CameraPose,
    CameraRoutine,
    CameraSettings,
    CamerasResponse,
    CameraState,
    CamGcodeResponse,
    CamJobResponse,
    CamLogEntry,
    CamLogState,
    CamPath,
    CamProfileResponse,
    CamProfilesResponse,
    CamValue,
    CenterRequest,
    CenterResponse,
    ColorItem,
    Compensate,
    Component,
    ComponentsResponse,
    ControlledCamera,
    CornerName,
    GotoRequest,
    Grid,
    Group,
    HeightMap,
    HeightMapState,
    HolePoint,
    HostSettings,
    Job,
    JobIcon,
    JobPatch,
    JobSummary,
    JogRequest,
    Joint,
    LensMeasured,
    LoggedCamera,
    Machine,
    MachineCheck,
    MachineDocument,
    MachineFromBoard,
    MachineProblem,
    MachineResponse,
    MachinesResponse,
    MachineState,
    MapMode,
    Marker,
    MarkRequest,
    MillJobRequest,
    MillOperation,
    MillResponse,
    Mode,
    PadProbePlan,
    PadProbeRequest,
    PartOffset,
    PartsFilter,
    PartsFilterState,
    Path,
    PlacingPlan,
    PlacingRun,
    PlacingState,
    PnpGotoRequest,
    PnpReference,
    PnpRoutine,
    PnpSettings,
    PnpState,
    PnpStep,
    Point,
    Port,
    PositionRequest,
    ProbeEstimate,
    ProbeProgress,
    ProbeRequest,
    ProbeSettings,
    Profile,
    Progress,
    RealtimeAction,
    RefineUse,
    ResumePlan,
    ResumeRecord,
    ResumeRequest,
    RoutineStep,
    RunState,
    SearchCamera,
    SearchLogState,
    SettingSchema,
    SettingsResponse,
    SettingsUpdate,
    Snapshot,
    SpotLook,
    SpotPolarity,
    SpotReply,
    StopAnswer,
    TopRoutine,
    TopSettings,
    TopState,
    TouchAt,
    TouchMode,
    TouchPlan,
    TouchRequest,
    UpdateState,
    UploadOptions,
    WsEvent,
} from "../types.ts";
import type { EventFeed } from "../ws.ts";

export const MOCK_VERSION = "0.1.0-mock";
const CLOCK_EPSILON = 1e-9;

/** A camera's look settings, or the backend's defaults where it has none. */
function lookTuning(settings: { look_threshold?: number; corner_mm?: number }): { threshold: number; cornerMm: number } {
    return { threshold: settings.look_threshold ?? LOOK_THRESHOLD, cornerMm: settings.corner_mm ?? CORNER_MM };
}

/** Why a search gave up, as the backend says it. */
function notFoundText(stops: number, threshold: number): string {
    return `no board found: ${stops} stops of the camera's picture looked at without a guess of ${LOOK_NEED} looks holding ${Math.round(threshold * 100)}% of the evidence;`
        + " a box over where the board lies, the board's side and finish, or a lower threshold";
}
export const LINE_SLOTS = 16;
export const PLANNER_BLOCKS = 32;
/** Ms between the simulation's timer ticks. */
const TICK_MS = 50;

/**
 * What the demo machine starts with over the shipped defaults: the firmware
 * ships without a focus axis, the mock has one so the page shows probing
 * and the height map. `$h_axis=0` takes it out.
 */
export const MOCK_MACHINE_SETTINGS: Record<string, number> = { h_axis: 1 };

/** The firmware refuses a feed under this, and one that is not a number. */
export const MIN_FEED = 0.001;
/** Longest constant beam the firmware takes, ms. */
export const LASER_MAX_MS = 60000;
/** Longest dwell the firmware takes, ms. */
const DWELL_MAX_MS = 600000;
/** A move shorter than this on the board (a turn on the axis) runs with the beam off. */
const SURFACE_EPSILON_MM = 0.001;

export const SETTINGS_SCHEMA: SettingSchema[] = [
    { name: "r_steps", unit: "steps/mm", help: "radius motor" },
    { name: "a_steps", unit: "steps/deg", help: "table motor: 200 steps * tmc_a_micro microsteps * 100:1 / 360" },
    { name: "r_rate", unit: "mm/min", help: "max radius rate" },
    { name: "a_rate", unit: "deg/min", help: "max table rate" },
    { name: "r_accel", unit: "mm/s^2", help: "radius acceleration" },
    { name: "a_accel", unit: "deg/s^2", help: "table acceleration" },
    { name: "r_jerk", unit: "mm/s", help: "allowed speed change at a corner" },
    { name: "a_jerk", unit: "deg/s", help: "allowed speed change at a corner" },
    { name: "r_max", unit: "mm", help: "soft limit, 0 = off" },
    { name: "z_steps", unit: "steps/mm", help: "cross slide motor" },
    { name: "z_rate", unit: "mm/min", help: "max cross slide rate" },
    { name: "z_accel", unit: "mm/s^2", help: "cross slide acceleration" },
    { name: "jog_z", unit: "mm/min", help: "jog rate without F" },
    { name: "jog_r", unit: "mm/min", help: "jog rate without F" },
    { name: "jog_a", unit: "deg/min", help: "jog rate without F" },
    { name: "dir_invert", unit: "mask", help: "bit 0 radius, bit 1 table, bit 2 cross slide, bit 3 focus axis" },
    { name: "en_invert", unit: "0/1", help: "1 = enable pin active high" },
    { name: "idle_ms", unit: "ms", help: "disable motors after idle, 0 = never" },
    { name: "step_us", unit: "us", help: "step pulse width" },
    { name: "laser_hz", unit: "Hz", help: "PWM frequency" },
    { name: "s_max", unit: "", help: "S for full duty" },
    { name: "s_min", unit: "", help: "dyn mode: below this the beam is off" },
    { name: "laser_invert", unit: "0/1", help: "1 = active low output" },
    { name: "laser_ms", unit: "ms", help: "default T for laser" },
    { name: "tmc_r_ma", unit: "mA", help: "run current, 0 leaves the driver untouched" },
    { name: "tmc_a_ma", unit: "mA", help: "run current, 0 leaves the driver untouched" },
    { name: "tmc_hold_pct", unit: "%", help: "hold current as a share of run" },
    { name: "tmc_r_micro", unit: "", help: "microsteps" },
    { name: "tmc_a_micro", unit: "", help: "microsteps" },
    { name: "tmc_z_ma", unit: "mA", help: "cross slide run current" },
    { name: "tmc_z_micro", unit: "", help: "microsteps" },
    { name: "tmc_stealth", unit: "0/1", help: "stealthChop, else spreadCycle" },
    { name: "h_axis", unit: "0/1", help: "1 = a focus axis is fitted, on its socket in sockets" },
    { name: "h_steps", unit: "steps/mm", help: "focus axis motor" },
    { name: "h_rate", unit: "mm/min", help: "max focus axis rate" },
    { name: "h_accel", unit: "mm/s^2", help: "focus axis acceleration" },
    { name: "h_jerk", unit: "mm/s", help: "allowed speed change at a corner" },
    { name: "jog_h", unit: "mm/min", help: "jog and probe rate without F" },
    { name: "probe_invert", unit: "0/1", help: "1 = probe input active high" },
    { name: "tmc_h_ma", unit: "mA", help: "focus axis run current" },
    { name: "tmc_h_micro", unit: "", help: "microsteps" },
    { name: "probe_ms", unit: "ms", help: "motion queued during a probe, 0 to 160; 0 stops dead within h_jerk" },
    { name: "z_jerk", unit: "mm/s", help: "cross slide: allowed speed change at a corner, as a joint" },
    { name: "z_max", unit: "mm", help: "cross slide soft limit either side of zero, 0 = off" },
    { name: "cartesian", unit: "0/1", help: "1 = X/Y machine: the rail is X, the cross slide Y, the table holds" },
    { name: "spindle", unit: "0/1", help: "1 = the laser output drives a spindle, the focus axis is its depth" },
    { name: "sockets", unit: "RAZH", help: "driver socket per axis, rail, table, slide, focus: 1 X, 2 Y, 3 Z, 4 E, each once; 1234 as labeled" },
    { name: "laser_pin", unit: "GPIO", help: "laser or spindle PWM output: 20 FAN3, 17 FAN1, 18 FAN2, 23 HE, 21 BED, 29 SERVO; read at boot, so save and restart" },
    { name: "probe_pin", unit: "GPIO", help: "probe input, pulled up: 25 Z-STOP, 22 PROBE, 4 X-STOP, 3 Y-STOP, 16 E-STOP; read at boot" },
    { name: "tool_out", unit: "0/1", help: "1 = tool_pin follows the tool: on while a job runs, a beam is lit, a dwell burns or the spindle turns; read at boot" },
    { name: "tool_pin", unit: "GPIO", help: "the tool output, 17 FAN1 by default; read at boot" },
    { name: "tool_invert", unit: "0/1", help: "1 = tool output active low" },
    { name: "r_stop", unit: "", help: "rail endstops: 0 none, 1 at the negative end, 2 at the positive end, 3 both on the one input" },
    { name: "r_stop_pin", unit: "GPIO", help: "rail endstop input, pulled up: 4 X-STOP, 3 Y-STOP, 16 E-STOP, 22 PROBE; read at boot" },
    { name: "r_home_pull", unit: "mm", help: "how far a home backs off the switch, and leaves the rail from it" },
    { name: "r_home_pos", unit: "mm", help: "what the rail reads at its switch (the negative one of two)" },
    { name: "r_home_travel", unit: "mm", help: "rail travel between its ends; a home seeks a tenth further, and the positive switch of two reads home_pos + this" },
    { name: "a_stop", unit: "", help: "table endstops: 0 none, 1 negative end, 2 positive end, 3 both" },
    { name: "a_stop_pin", unit: "GPIO", help: "table endstop input, pulled up; read at boot" },
    { name: "a_home_pull", unit: "deg", help: "how far a home backs off the switch, and leaves the table from it" },
    { name: "a_home_pos", unit: "deg", help: "what the table reads at its switch" },
    { name: "a_home_travel", unit: "deg", help: "table travel between its ends; a home seeks a tenth further" },
    { name: "h_stop", unit: "", help: "focus axis endstops: 0 none, 1 negative end, 2 positive end, 3 both" },
    { name: "h_stop_pin", unit: "GPIO", help: "focus axis endstop input, pulled up; read at boot" },
    { name: "h_home_pull", unit: "mm", help: "how far a home backs off the switch, and leaves the head from it" },
    { name: "h_home_pos", unit: "mm", help: "what the focus axis reads at its switch" },
    { name: "h_home_travel", unit: "mm", help: "focus axis travel between its ends; a home seeks a tenth further" },
    { name: "z_stop", unit: "", help: "cross slide endstops: 0 none, 1 negative end, 2 positive end, 3 both" },
    { name: "z_stop_pin", unit: "GPIO", help: "cross slide endstop input, pulled up; read at boot" },
    { name: "z_home_pull", unit: "mm", help: "how far a home backs off the switch, and leaves the slide from it" },
    { name: "z_home_pos", unit: "mm", help: "what the cross slide reads at its switch" },
    { name: "z_home_travel", unit: "mm", help: "cross slide travel between its ends; a home seeks a tenth further" },
    { name: "stop_invert", unit: "mask", help: "endstop inputs active high: bit 0 rail, bit 1 table, bit 2 cross slide, bit 3 focus axis" },
    { name: "limits", unit: "mask", help: "endstops that halt a move closing them (ALARM:4, position lost), same bits" },
    { name: "dispenser", unit: "0/1", help: "1 = the table's joint is a dispenser's plunger in mm (with cartesian)" },
    // The drivers' tuning, one value for all four: TMC2209 register fields,
    // named and bounded as in its datasheet (Rev 1.09).
    { name: "tmc_intpol", unit: "0/1", help: "1 = the drivers interpolate every microstep to 256, whatever tmc_*_micro (CHOPCONF intpol)" },
    { name: "tmc_toff", unit: "", help: "chopper off time, CHOPCONF TOFF 1 to 15: slow decay of 24 + 32 * TOFF clocks; 1 only with tmc_tbl 2 or 3" },
    { name: "tmc_tbl", unit: "", help: "comparator blank time, CHOPCONF TBL 0 to 3: 16, 24, 32 or 40 clocks" },
    { name: "tmc_hstrt", unit: "", help: "spreadCycle hysteresis start, CHOPCONF HSTRT 0 to 7: 1 to 8 above its end; tmc_hstrt + tmc_hend at most 18" },
    { name: "tmc_hend", unit: "", help: "spreadCycle hysteresis end, CHOPCONF HEND 0 to 15: -3 to 12" },
    { name: "tmc_hold_delay", unit: "", help: "IHOLDDELAY 0 to 15: each step of the fall from run to hold current takes this many 2^18 clocks (21.8 ms); 0 drops at once" },
    { name: "tmc_tpowerdown", unit: "", help: "TPOWERDOWN 0 to 255: how long a motor at rest keeps its run current, in 2^18 clocks (21.8 ms) from 87 ms after its last step, before the fall to hold; 2 or more with stealthChop" },
    { name: "tmc_tpwmthrs", unit: "TSTEP", help: "TPWMTHRS 0 to 1048575: stealthChop while TSTEP is at least this, spreadCycle faster; TSTEP is the 12 MHz clocks between 1/256 microsteps, 46875 / full steps per second; 0 = stealthChop at every speed" },
];

/** Settings the firmware holds as 0 or 1. */
const FLAG_SETTINGS = new Set(["en_invert", "laser_invert", "tmc_stealth", "h_axis", "probe_invert", "cartesian", "spindle", "tool_out", "tool_invert", "dispenser", "tmc_intpol"]);
/** Settings the firmware holds as unsigned 32-bit integers: decimal text is refused. */
const INT_SETTINGS = new Set([
    "dir_invert",
    "idle_ms",
    "step_us",
    "laser_hz",
    "laser_ms",
    "tmc_r_ma",
    "tmc_a_ma",
    "tmc_hold_pct",
    "tmc_r_micro",
    "tmc_a_micro",
    "tmc_z_ma",
    "tmc_z_micro",
    "tmc_h_ma",
    "tmc_h_micro",
    "probe_ms",
    "sockets",
    "laser_pin",
    "probe_pin",
    "tool_pin",
    "r_stop",
    "a_stop",
    "h_stop",
    "z_stop",
    "r_stop_pin",
    "a_stop_pin",
    "h_stop_pin",
    "z_stop_pin",
    "stop_invert",
    "limits",
    "tmc_toff",
    "tmc_tbl",
    "tmc_hstrt",
    "tmc_hend",
    "tmc_hold_delay",
    "tmc_tpowerdown",
    "tmc_tpwmthrs",
]);
/** The pin settings: a GPIO the driver sockets and the driver UART leave free. */
const PIN_SETTINGS = ["laser_pin", "probe_pin", "tool_pin", "r_stop_pin", "a_stop_pin", "h_stop_pin", "z_stop_pin"];
/** The wiring, which `$defaults` leaves as it is: an active-low laser taken back to active high would light. */
const WIRING_SETTINGS = [
    "laser_invert", "en_invert", "probe_invert", "dir_invert", "sockets", "laser_pin", "probe_pin", "tool_out", "tool_pin", "tool_invert",
    "r_stop", "a_stop", "h_stop", "z_stop", "r_stop_pin", "a_stop_pin", "h_stop_pin", "z_stop_pin", "stop_invert", "limits",
];
/** Settings that scale or turn the axes, so the focus axis frame a height map is tied to. */
const FRAME_SETTINGS = new Set(["r_steps", "a_steps", "z_steps", "h_steps", "dir_invert", "cartesian", "h_axis", "sockets"]);

/** A typed `$` line that may change the frame the axes count in. */
function reframes(text: string): boolean {
    const body = (text.slice(1).split(";")[0] ?? "").trim().toLowerCase();
    if (body === "load" || body === "defaults") {
        return true;
    }
    return FRAME_SETTINGS.has((body.split("=")[0] ?? "").trim());
}
/** Largest whole number and other value the backend sends as a setting. */
const INT_SETTING_MAX = INT_MAX;
const SETTING_MAX = 1e7;
/** Largest chord tolerance the backend takes, mm. */
const MAX_TOLERANCE = 10;
/** The travel height's bounds, mm: an H, so it may be below H 0. */
const TRAVEL_LIMIT = 100;

/**
 * The firmware's check of a whole set of settings, so the rules that span
 * two of them hold: every value in its range, whole numbers where the
 * firmware keeps an integer, and `s_min` within `s_max`.
 */
export function settingsValid(settings: Record<string, number>): boolean {
    const value = (name: string): number => settings[name] ?? DEFAULT_SETTINGS[name] ?? Number.NaN;
    for (const name of Object.keys(DEFAULT_SETTINGS)) {
        const v = value(name);
        if (!Number.isFinite(v)) {
            return false;
        }
        if (FLAG_SETTINGS.has(name) && v !== 0 && v !== 1) {
            return false;
        }
        if (INT_SETTINGS.has(name) && !(Number.isInteger(v) && v >= 0 && v <= INT_MAX)) {
            return false;
        }
        if (/_(steps|rate|accel|jerk|home_pull|home_travel)$/.test(name) || name.startsWith("jog_")) {
            if (!(v > 0 && v <= FLOAT_MAX)) {
                return false;
            }
        }
        if (name.endsWith("_home_pos") && !(v >= -FLOAT_MAX && v <= FLOAT_MAX)) {
            return false;
        }
        if (/^tmc_._ma$/.test(name) && v > 2000) {
            return false;
        }
        if (/^tmc_._micro$/.test(name) && !MICROSTEPS.includes(v)) {
            return false;
        }
    }
    const within = (name: string, low: number, high: number): boolean => value(name) >= low && value(name) <= high;
    return (
        within("r_max", 0, FLOAT_MAX) &&
        within("z_max", 0, FLOAT_MAX) &&
        within("dir_invert", 0, 15) &&
        within("stop_invert", 0, 15) &&
        within("limits", 0, 15) &&
        ["r_stop", "a_stop", "h_stop", "z_stop"].every((name) => within(name, 0, 3)) &&
        within("probe_ms", 0, PROBE_MS_MAX) &&
        PIN_SETTINGS.every((name) => within(name, 0, PIN_MAX) && !RESERVED_PINS.has(value(name))) &&
        within("step_us", 1, 20) &&
        within("laser_hz", 100, 100000) &&
        within("laser_ms", 1, 60000) &&
        within("tmc_hold_pct", 0, 100) &&
        // The drivers' tuning, each register field within its width and
        // TOFF above 0, which would switch a driver off; the rules joining
        // two of them are the machine file's.
        Object.entries(TUNING_BOUNDS).every(([key, [low, high]]) => within(`tmc_${key}`, low, high)) &&
        value("s_max") > 0 &&
        value("s_max") <= FLOAT_MAX &&
        within("s_min", 0, value("s_max")) &&
        socketsValid(value("sockets"))
    );
}

/** Four digits, each of the four driver sockets 1 to 4 once, as the firmware takes them. */
function socketsValid(sockets: number): boolean {
    if (!(sockets >= 1000 && sockets <= 9999)) {
        return false;
    }
    const digits = String(sockets).split("").sort().join("");
    return digits === "1234";
}

/**
 * The value of `$name=value` text as the firmware reads it for that
 * setting, or null for text it refuses: 0 or 1 for a flag, digits only for
 * an integer, and otherwise a plain decimal with no exponent.
 */
function settingValue(name: string, text: string): number | null {
    if (FLAG_SETTINGS.has(name)) {
        return text === "0" ? 0 : text === "1" ? 1 : null;
    }
    if (INT_SETTINGS.has(name)) {
        return /^\d+$/.test(text) ? Number(text) : null;
    }
    return decimal(text);
}

/** A plain decimal as the firmware reads a word: optional sign, digits, optional fraction, no exponent. */
function decimal(text: string): number | null {
    return /^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(text) ? Number(text) : null;
}

export type MoveKind = "go" | "cut" | "jog" | "dwell" | "spindle";

export interface Move {
    kind: MoveKind;
    /** Where the joints end; a dwell or a spindle line stays where the move before it ended. */
    target: Joint;
    /** Focus axis at the end, mm; left out, the head keeps the height the move before left it at. */
    h?: number;
    /** Cross slide at the end on a cartesian machine, where it is a joint; left out, it stays. */
    z?: number;
    /** Only the focus axis moves, so the line carries only its word. */
    headOnly?: boolean;
    /** A board jog's turn on the axis: the line carries only the angle. */
    turn?: boolean;
    /** Surface speed in mm/min for a cut, the jog feed, or null for the default rates. */
    feed: number | null;
    /** S word for a cut or a dwell, or the spindle's speed. */
    power: number;
    /** M word for a cut: the floor of its dynamic power, not modal. */
    minPower?: number;
    /** A spindle's cut, which carries no S or M. */
    milled?: boolean;
    /** A dwell's time, ms. */
    ms?: number;
    /** `spindle off` rather than a speed. */
    off?: boolean;
    /** Job group index, for progress. */
    group: number;
}

interface Active {
    move: Move;
    from: Joint;
    to: Joint;
    fromH: number;
    toH: number;
    fromZ: number;
    toZ: number;
    seconds: number;
    elapsed: number;
}

/** A cross slide move: it owns the machine on its own until it ends. */
interface Slide {
    from: number;
    to: number;
    seconds: number;
    elapsed: number;
}

/** What the firmware prints for `help`, one line each, before its `ok`. */
export const HELP_LINES = [
    "go [R] [A] [H] | cut [R] [A] [H] [F] [S] [M] | jog [R] [A] [H] [F] | jogto [R] [A] [H] [F]",
    "cross slide, alone and from idle: jog Z [F] | jogto Z [F] | set Z",
    "cartesian=1: Z is a joint with R, H: go, cut, jog, jogto, set take Z; go, cut take no A",
    "focus axis probe (h_axis=1): probe H [F]",
    "home [R] [A] [H] [Z]: a - or + after a letter picks the end; alone, every axis with an endstop",
    "dwell T [S] | mode dyn|const | laser S [T] | laser off | set [R] [A] [H]",
    "spindle=1: spindle S | spindle off; no S or M on cut and dwell, no laser S",
    "dispenser=1 (with cartesian): A is the plunger in mm, on go and cut too; no S or M on cut and dwell, no laser S",
    "enable | disable | unlock | version | status | help | diag",
    "$ | $name | $name=value | $save | $load | $defaults | $tmc",
    "realtime bytes: ? status, ! hold, ~ resume, 0x18 reset, 0x85 jog cancel",
];

export class MachineError extends Error {
    readonly code: number;

    constructor(code: number, text: string) {
        super(`error:${code} ${text}`);
        this.name = "MachineError";
        this.code = code;
    }
}

/**
 * The simulated board under the probe: the focus axis height, mm, at which
 * the probe touches it at a board point. A gently warped plate about a
 * millimeter and a half below the head's zero.
 */
export function boardSurface(x: number, y: number): number {
    return -1.5 + 0.004 * x - 0.006 * y + 0.0002 * (x * x + y * y);
}

/** What `probe` found: the H of contact, or where it gave up. */
export interface ProbeResult {
    h: number;
    contact: boolean;
}

/** Joint-space motion at constant rates, the firmware's state machine without acceleration. */
export class MockMachine {
    settings: Record<string, number>;
    /** What `$load` reads back and `$save` writes. */
    flash: Record<string, number>;
    joint: Joint = { r: 0, a: 0 };
    /** Cross slide position in mm. */
    z = 0;
    /** Focus axis position in mm, up positive; kept whether or not the axis is fitted. */
    h = 0;
    /** The probe tip from the beam, along the rail and across it, mm: where it is mounted. */
    probeOffset: [number, number] = [0, 0];
    state: MachineState = "Idle";
    alarm: number | null = null;
    /** What a hold stopped: a hold of a run takes moves in to wait for the resume, a hold of a jog does not. */
    held: MachineState | null = null;
    mode: Mode = "dyn";
    enabled = false;
    /** Beam duty in permille of full power, 0 dark; status() reports it as driven on the pin. */
    laser = 0;
    /** `S` of the spindle while it turns, with `$spindle=1`; its duty is what the status shows. */
    spindle = 0;
    /** Surface speed of the move in progress, mm/min. */
    rate = 0;
    queue: Move[] = [];
    active: Active | null = null;
    /** The cross slide move in progress; nothing else runs beside it. */
    slide: Slide | null = null;
    /** Seconds left on a constant beam; 0 when off. */
    beamSeconds = 0;
    /** Modal F for `cut`, forgotten on a reset; null until a cut gives one. */
    feed: number | null = null;
    /** Modal S for `cut`, back to 0 on a reset. */
    power = 0;

    /** `settings` over the shipped defaults, as though stored in flash. */
    constructor(settings: Record<string, number> = {}) {
        this.settings = { ...DEFAULT_SETTINGS, ...settings };
        this.flash = { ...this.settings };
    }

    hasFocusAxis(): boolean {
        return (this.settings["h_axis"] ?? 0) !== 0;
    }

    /** What the machine is, as the backend reads it from the settings; with both flags set the spindle's rules hold. */
    profile(): Profile {
        return {
            kinematics: this.cartesian() ? "cartesian" : "polar",
            tool: this.milling() ? "spindle" : this.dispensing() ? "dispenser" : "laser",
            h_axis: this.hasFocusAxis(),
            r_max: this.settings["r_max"] ?? 0,
            z_max: this.settings["z_max"] ?? 0,
        };
    }

    milling(): boolean {
        return (this.settings["spindle"] ?? 0) !== 0;
    }

    /** The table's joint is a dispenser's plunger in mm: only with the cartesian flag, where the table has no part in the board frame. */
    dispensing(): boolean {
        return this.cartesian() && (this.settings["dispenser"] ?? 0) !== 0;
    }

    /** The output is dark whatever a line says: a spindle's or a dispenser's. */
    darkOutput(): boolean {
        return this.milling() || this.dispensing();
    }

    /** The angle the board frame is turned by: the table's, or none when that joint is a plunger. */
    frameAngle(joint: Joint = this.joint): number {
        return this.dispensing() ? 0 : joint.a;
    }

    /** Board length of a joint move: a plunger moves no board. */
    boardLength(from: Joint, to: Joint, fromZ: number, toZ: number): number {
        if (this.dispensing()) {
            return Math.hypot(to.r - from.r, toZ - fromZ);
        }
        return this.cartesian() ? cartesianSurfaceLength(from, to, fromZ, toZ) : surfaceLength(from, to);
    }

    /** The cross slide is a joint beside the radius, and the table holds the board still. */
    cartesian(): boolean {
        return (this.settings["cartesian"] ?? 0) !== 0;
    }

    /**
     * `spindle S` / `spindle off`: refused on a laser machine. A start is
     * taken where a move would be, from rest, in a run or in a hold of one;
     * a stop in any state. Either waits for the motion queued before it.
     */
    spin(power: number | null): void {
        if (!this.milling()) {
            throw new MachineError(2, "bad word");
        }
        if (power !== null && !(power >= 0)) {
            throw new MachineError(4, "out of range");
        }
        if (power !== null) {
            this.checkMotionState(false);
        }
        if (this.queue.length > 0 || this.active !== null) {
            this.queue.push({ kind: "spindle", target: this.endpoint(), power: power ?? 0, off: power === null, feed: null, group: -1 });
            return;
        }
        this.spindle = power ?? 0;
    }

    /** The spindle's speed once the queue has run: the last speed queued, else the one it turns at. */
    spindleEnd(): number {
        for (let i = this.queue.length - 1; i >= 0; i--) {
            const move = this.queue[i];
            if (move?.kind === "spindle") {
                return move.off ? 0 : move.power;
            }
        }
        return this.spindle;
    }

    /** `laser off`: the output off, a spindle's included. */
    outputOff(): void {
        this.beamOff();
        this.spindle = 0;
    }

    /** The board point under the beam with the joints at `joint`. */
    headBoard(joint: Joint = this.joint, z: number = this.z): Board {
        return headBoard({ r: joint.r, a: this.frameAngle(joint) }, z, this.cartesian());
    }

    /** The board point under the probe tip with the joints at `joint`: the tip is off the beam along the rail and across it. */
    tipBoard(joint: Joint = this.joint, z: number = this.z): Board {
        const [along, across] = this.probeOffset;
        const slide = this.cartesian() ? z : 0;
        return turned({ x: joint.r + along, y: slide + across }, this.frameAngle(joint));
    }

    /** The H at which the probe touches the board where the tip is now. */
    contactHeight(): number {
        const tip = this.tipBoard();
        return boardSurface(tip.x, tip.y);
    }

    /** The probe input: the tip on the board, through the polarity setting. */
    probeActive(): boolean {
        const touching = this.h <= this.contactHeight();
        return (this.settings["probe_invert"] ?? 0) !== 0 ? !touching : touching;
    }

    /** An H word needs the focus axis, and a number. */
    private checkFocusWord(h: number | undefined): void {
        if (h === undefined) {
            return;
        }
        if (!this.hasFocusAxis()) {
            throw new MachineError(2, "bad word");
        }
        if (!Number.isFinite(h)) {
            throw new MachineError(4, "out of range");
        }
    }

    /** Free planner blocks and line slots, as the status line reports them. */
    queueFree(): { planner: number; lines: number } {
        const planner = Math.max(0, PLANNER_BLOCKS - Math.min(this.queue.length, PLANNER_BLOCKS));
        const lines = Math.max(0, LINE_SLOTS - Math.max(0, this.queue.length - PLANNER_BLOCKS));
        return { planner, lines };
    }

    /** Lines still waiting behind the planner, so unanswered. */
    waitingLines(): number {
        return Math.max(0, this.queue.length - PLANNER_BLOCKS);
    }

    canQueue(): boolean {
        return this.queue.length < PLANNER_BLOCKS + LINE_SLOTS;
    }

    /** Where the machine will be once the queue has run. */
    endpoint(): Joint {
        const last = this.queue[this.queue.length - 1];
        if (last) {
            return last.target;
        }
        return this.active ? this.active.to : this.joint;
    }

    /** The focus axis once the queue has run: the last H word, else where it is headed now. */
    endpointH(): number {
        for (let i = this.queue.length - 1; i >= 0; i--) {
            const h = this.queue[i]?.h;
            if (h !== undefined) {
                return h;
            }
        }
        return this.active ? this.active.toH : this.h;
    }

    /** The cross slide once the queue has run, on a cartesian machine where moves carry it. */
    endpointZ(): number {
        for (let i = this.queue.length - 1; i >= 0; i--) {
            const z = this.queue[i]?.z;
            if (z !== undefined) {
                return z;
            }
        }
        return this.active ? this.active.toZ : this.z;
    }

    moving(): boolean {
        return this.state === "Run" || this.state === "Jog";
    }

    status(): Machine {
        const focus = this.hasFocusAxis();
        const duty = this.milling() ? Math.max(0, Math.min(1000, (this.spindle / (this.settings["s_max"] ?? 1000)) * 1000)) : this.laser;
        return {
            state: this.state,
            alarm: this.alarm,
            joint: { ...this.joint, z: this.z, h: focus ? this.h : null },
            board: this.headBoard(),
            rate: this.rate,
            // The duty driven on the pin: an active-low output reads 1000 dark.
            laser: (this.settings["laser_invert"] ?? 0) !== 0 ? 1000 - duty : duty,
            mode: this.mode,
            enabled: this.enabled,
            queue: this.queueFree(),
            probe: focus ? this.probeActive() : null,
            homed: this.hasStops() ? this.homed : null,
        };
    }

    /**
     * The soft limits: any move may cross the axis to the far side, and
     * `r_max` is on the distance from it, either side; on a cartesian
     * machine `z_max` holds the cross slide the same way.
     */
    checkReach(r: number, z: number | undefined = undefined): void {
        if (!Number.isFinite(r) || (z !== undefined && !Number.isFinite(z))) {
            throw new MachineError(4, "out of range");
        }
        const rMax = this.settings["r_max"] ?? 0;
        if (rMax > 0 && Math.abs(r) > rMax + 1e-9) {
            throw new MachineError(4, "out of range");
        }
        const zMax = this.settings["z_max"] ?? 0;
        if (z !== undefined && zMax > 0 && Math.abs(z) > zMax + 1e-9) {
            throw new MachineError(4, "out of range");
        }
    }

    private checkWords(move: Move): void {
        if (move.feed !== null && !(move.feed >= MIN_FEED)) {
            throw new MachineError(4, "out of range");
        }
        if (!(move.power >= 0)) {
            throw new MachineError(4, "out of range");
        }
        this.checkReach(move.target.r, move.z);
        if (!Number.isFinite(move.target.a)) {
            throw new MachineError(4, "out of range");
        }
    }

    /**
     * Jogs are taken in Idle and Jog, the other motion in Idle and Run and
     * in a hold of a run, where it waits for the resume; nothing joins a
     * cross slide move.
     */
    private checkMotionState(jog: boolean): void {
        if (this.slide !== null) {
            throw new MachineError(5, "not now");
        }
        const allowed = jog
            ? this.state === "Idle" || this.state === "Jog"
            : this.state === "Idle" || this.state === "Run" || (this.state === "Hold" && this.held === "Run");
        if (!allowed) {
            throw new MachineError(5, "not now");
        }
    }

    /** A cut's checks before its words are resolved: where motion is taken, and with a spindle only while it turns. */
    checkCut(): void {
        this.checkMotionState(false);
        if (this.milling() && !(this.spindleEnd() > 0)) {
            throw new MachineError(5, "not now");
        }
    }

    /** Queues a move, refused as the firmware refuses the line that asks for it. */
    push(move: Move): void {
        if (move.z !== undefined && !this.cartesian()) {
            // The cross slide moves on its own on a polar machine.
            throw new MachineError(2, "bad word");
        }
        const milling = this.milling();
        if (this.darkOutput() && move.kind === "cut" && (move.power > 0 || (move.minPower ?? 0) > 0)) {
            // A spindle's speed is its own command's, and a dispenser's output
            // is dark: an S on a cut is a laser job.
            throw new MachineError(2, "bad word");
        }
        if (this.darkOutput() && move.kind === "dwell" && move.power > 0) {
            throw new MachineError(2, "bad word");
        }
        this.checkMotionState(move.kind === "jog");
        if (milling && move.kind === "cut" && !(this.spindleEnd() > 0)) {
            // A cut drags the tool through the work: not with it stopped.
            throw new MachineError(5, "not now");
        }
        this.checkFocusWord(move.h);
        if (!this.canQueue()) {
            throw new MachineError(5, "queue full");
        }
        this.checkWords(move);
        this.queue.push(move);
        this.enabled = true;
        if (move.kind !== "spindle") {
            this.beamSeconds = 0;
        }
        if (this.state === "Idle") {
            this.state = move.kind === "jog" ? "Jog" : "Run";
        }
    }

    /** A relative jog; a `dh` or `dz` of null leaves that axis out of it. */
    jog(dr: number, da: number, feed: number | null, dh: number | null = null, dz: number | null = null): void {
        const from = this.endpoint();
        const h = dh !== null ? this.endpointH() + dh : undefined;
        const z = dz !== null ? this.endpointZ() + dz : undefined;
        this.push({ kind: "jog", target: { r: from.r + dr, a: from.a + da }, h, z, feed, power: 0, group: -1 });
    }

    jogTo(r: number | null, a: number | null, feed: number | null, h: number | null = null, z: number | null = null): void {
        const from = this.endpoint();
        this.push({ kind: "jog", target: { r: r ?? from.r, a: a ?? from.a }, h: h ?? undefined, z: z ?? undefined, feed, power: 0, group: -1 });
    }

    go(r: number | null, a: number | null, h: number | null = null, z: number | null = null): void {
        const from = this.endpoint();
        this.push({ kind: "go", target: { r: r ?? from.r, a: a ?? from.a }, h: h ?? undefined, z: z ?? undefined, feed: null, power: 0, group: -1 });
    }

    cut(r: number | null, a: number | null, feed: number, power: number, minPower = 0, h: number | null = null, z: number | null = null): void {
        const from = this.endpoint();
        const target = { r: r ?? from.r, a: a ?? from.a };
        this.push({ kind: "cut", target, h: h ?? undefined, z: z ?? undefined, feed, power, minPower, milled: this.milling(), group: -1 });
    }

    /** `dwell T [S]`: a wait once the motion before it is done, with the beam at S for a spot burn. */
    dwell(ms: number, power: number): void {
        this.push({ kind: "dwell", target: this.endpoint(), ms, power, feed: null, group: -1 });
    }

    /** Sends the cross slide to `z`; the firmware takes it in Idle only. */
    slideTo(z: number, feed: number | null): void {
        this.requireIdle();
        if (feed !== null && !(feed >= MIN_FEED)) {
            throw new MachineError(4, "out of range");
        }
        const zMax = this.settings["z_max"] ?? 0;
        if (!Number.isFinite(z) || (zMax > 0 && Math.abs(z) > zMax + 1e-9)) {
            throw new MachineError(4, "out of range");
        }
        const limit = this.settings["z_rate"] ?? 560;
        const rate = feed !== null ? Math.min(feed, limit) : this.settings["jog_z"] ?? 120;
        this.slide = { from: this.z, to: z, seconds: (Math.abs(z - this.z) / rate) * 60, elapsed: 0 };
        this.state = "Jog";
        this.enabled = true;
        // The beam is off throughout, and a board move has no speed here.
        this.laser = 0;
        this.beamSeconds = 0;
        this.rate = 0;
    }

    slideJog(dz: number, feed: number | null): void {
        this.slideTo(this.z + dz, feed);
    }

    /**
     * The focus axis moves with the joints and holds them back only when it
     * is the slower. F stays the board speed, except on a move that only
     * raises or lowers the head, which takes it as the speed of H. On a
     * cartesian machine the cross slide is one of the joints.
     */
    private secondsFor(move: Move, from: Joint, fromH: number, toH: number, fromZ: number, toZ: number): number {
        const s = this.settings;
        const to = move.target;
        const length = this.boardLength(from, to, fromZ, toZ);
        // Every rate, a jog's too, is held to what the step generator
        // pulses at the axis's steps a unit.
        const cap = (rate: number, axis: string): number => cappedRate(rate, s[`${axis}_steps`] ?? 0, s["step_us"] ?? 2);
        const hRate = cap(s["h_rate"] ?? 600, "h");
        const headOnly = Math.abs(to.r - from.r) < 1e-9 && Math.abs(to.a - from.a) < 1e-9 && Math.abs(toZ - fromZ) < 1e-9;
        let rates = [cap(s["r_rate"] ?? 560, "r"), cap(s["a_rate"] ?? 400, "a"), cap(s["z_rate"] ?? 560, "z")];
        let feed: number | null = null;
        let focusRate = hRate;
        if (move.kind === "jog" && move.feed === null) {
            rates = [cap(s["jog_r"] ?? 300, "r"), cap(s["jog_a"] ?? 200, "a"), cap(s["jog_z"] ?? 120, "z")];
            focusRate = cap(s["jog_h"] ?? 120, "h");
        } else if (move.kind !== "go") {
            feed = move.feed;
            if (headOnly && feed !== null) {
                focusRate = Math.min(feed, hRate);
            }
        }
        let [rRate = 560, aRate = 400, zRate = 560] = rates;
        // A plunger alone on a line with a feed moves at that feed, as a
        // focus axis alone does: no board length asks for it.
        if (this.dispensing() && feed !== null && feed > 0 && length < AXIS_EPSILON) {
            aRate = Math.min(feed, aRate);
        }
        const wanted = feed !== null && feed > 0 && length >= AXIS_EPSILON ? length / feed : 0;
        const minutes = Math.max(wanted, Math.abs(to.r - from.r) / rRate, Math.abs(to.a - from.a) / aRate, Math.abs(toZ - fromZ) / zRate);
        return Math.max(minutes, Math.abs(toH - fromH) / focusRate) * 60;
    }

    /** Duty in permille for a move of board length `length` at the achieved speed; a spindle's output is its own. */
    private dutyFor(move: Move, achieved: number, length: number): number {
        if (this.darkOutput()) {
            return 0;
        }
        const sMax = this.settings["s_max"] ?? 1000;
        if (move.kind === "dwell") {
            return Math.max(0, Math.min(1000, (move.power / sMax) * 1000));
        }
        if (move.kind !== "cut" || move.power <= 0 || length < SURFACE_EPSILON_MM) {
            return 0;
        }
        const sMin = this.settings["s_min"] ?? 0;
        let power = move.power;
        if (this.mode === "dyn") {
            const wanted = move.feed ?? 0;
            power = wanted > 0 ? Math.min(move.power, (move.power * achieved) / wanted) : 0;
            power = Math.max(power, Math.min(move.minPower ?? 0, move.power));
            if (power < sMin) {
                power = 0;
            }
        }
        return Math.max(0, Math.min(1000, (power / sMax) * 1000));
    }

    /** Runs the simulation forward by `dt` seconds. */
    advance(dt: number): void {
        if (this.beamSeconds > 0) {
            this.beamSeconds -= dt;
            if (this.beamSeconds <= 0) {
                this.beamSeconds = 0;
                this.laser = 0;
            }
        }
        if (this.state === "Hold" || this.state === "Alarm") {
            return;
        }
        if (this.slide) {
            this.advanceSlide(this.slide, dt);
            return;
        }
        let remaining = dt;
        while (remaining > 0) {
            if (!this.active) {
                const move = this.queue.shift();
                if (!move) {
                    this.state = "Idle";
                    this.rate = 0;
                    if (this.beamSeconds <= 0) {
                        this.laser = 0;
                    }
                    return;
                }
                this.state = move.kind === "jog" ? "Jog" : "Run";
                this.active = this.activate(move);
            }
            const active = this.active;
            if (active.seconds <= 1e-9) {
                this.land(active);
                continue;
            }
            const step = Math.min(remaining, active.seconds - active.elapsed);
            active.elapsed += step;
            remaining -= step;
            const t = Math.min(1, active.elapsed / active.seconds);
            this.joint = lerpJoint(active.from, active.to, t);
            this.h = active.fromH + (active.toH - active.fromH) * t;
            this.z = active.fromZ + (active.toZ - active.fromZ) * t;
            const length = this.boardLength(active.from, active.to, active.fromZ, active.toZ);
            const achieved = (length / active.seconds) * 60;
            this.rate = achieved;
            this.laser = this.dutyFor(active.move, achieved, length);
            if (active.elapsed >= active.seconds - 1e-9) {
                this.land(active);
            }
        }
    }

    /** The move taken off the queue: where it goes and how long it takes. A spindle line acts as it starts. */
    private activate(move: Move): Active {
        const motion = move.kind !== "dwell" && move.kind !== "spindle";
        const to = motion ? move.target : { ...this.joint };
        const toH = motion ? move.h ?? this.h : this.h;
        const toZ = motion ? move.z ?? this.z : this.z;
        let seconds = 0;
        if (move.kind === "dwell") {
            seconds = (move.ms ?? 0) / 1000;
        } else if (move.kind === "spindle") {
            this.spindle = move.off ? 0 : move.power;
        } else {
            seconds = this.secondsFor(move, this.joint, this.h, toH, this.z, toZ);
        }
        return { move, from: { ...this.joint }, to, fromH: this.h, toH, fromZ: this.z, toZ, seconds, elapsed: 0 };
    }

    private land(active: Active): void {
        this.joint = { ...active.to };
        this.h = active.toH;
        this.z = active.toZ;
        this.active = null;
    }

    private advanceSlide(slide: Slide, dt: number): void {
        slide.elapsed = Math.min(slide.seconds, slide.elapsed + dt);
        const t = slide.seconds <= 1e-9 ? 1 : slide.elapsed / slide.seconds;
        this.z = slide.from + (slide.to - slide.from) * t;
        if (slide.elapsed >= slide.seconds - 1e-9) {
            this.z = slide.to;
            this.slide = null;
            this.state = "Idle";
        }
    }

    /**
     * The hold byte. A beam lit by `laser` goes out whatever the state and
     * does not come back with the resume; a spindle keeps turning, so the
     * resume does not drive a still tool into the work. The cross slide is
     * a setup move with nothing behind it to resume into, so a hold ends it
     * where it is and the state falls back to Idle.
     */
    hold(): void {
        this.laser = 0;
        this.beamSeconds = 0;
        if (this.slide) {
            this.slide = null;
            this.state = "Idle";
            return;
        }
        if (this.moving()) {
            this.held = this.state;
            this.state = "Hold";
            this.rate = 0;
        }
    }

    resume(): void {
        if (this.state !== "Hold") {
            return;
        }
        const next = this.active?.move ?? this.queue[0];
        this.state = next ? (next.kind === "jog" ? "Jog" : "Run") : "Idle";
        this.held = null;
    }

    /**
     * The joint stepper is moving. A hold here is already braked, so a reset
     * from it loses no steps, and the slide counts its own steps.
     */
    private jointsBusy(): boolean {
        return this.moving() && this.slide === null;
    }

    /**
     * The reset byte: stop at once, flush, and forget the modal words. True
     * when the joints were moving, which raises `Alarm:1`; an alarm already
     * raised stays as it was.
     */
    reset(): boolean {
        const wasMoving = this.jointsBusy();
        this.queue = [];
        this.active = null;
        this.slide = null;
        this.held = null;
        this.laser = 0;
        this.spindle = 0;
        this.beamSeconds = 0;
        this.rate = 0;
        this.feed = null;
        this.power = 0;
        this.mode = "dyn";
        if (wasMoving) {
            this.state = "Alarm";
            this.alarm = 1;
        } else if (this.state !== "Alarm") {
            this.state = "Idle";
        }
        return wasMoving;
    }

    /** The jog cancel byte: the rest of a jog, running or held, is thrown away. */
    jogCancel(): void {
        const jogging = this.state === "Jog" || (this.state === "Hold" && this.held === "Jog");
        if (!jogging) {
            return;
        }
        if (this.slide) {
            // The slide stops where it has got to, like any other jog.
            this.slide = null;
            this.state = "Idle";
            return;
        }
        this.queue = this.queue.filter((move) => move.kind !== "jog");
        this.active = null;
        this.held = null;
        this.rate = 0;
        this.state = "Idle";
    }

    /** The joints homed since the position was last lost, as letters in joint order. */
    homed = "";

    /** Any axis has an endstop: the status then reports what is homed, and `home` has something to do. */
    hasStops(): boolean {
        return ["r", "a", "h", "z"].some((axis) => (this.settings[`${axis}_stop`] ?? 0) !== 0);
    }

    /**
     * `home [R|A|H|Z][-|+]...`: the joints named, or every one with an
     * endstop, in the firmware's order. The mock jumps each to the
     * pull-off from its switch rather than seeking it, and prints the
     * firmware's line per joint.
     */
    home(axes: string): string[] {
        const fitted = ["r", "a", "h", "z"].filter((axis) => (this.settings[`${axis}_stop`] ?? 0) !== 0 && (axis !== "h" || this.hasFocusAxis()));
        const words = axes.trim() === "" ? [] : axes.trim().split(/\s+/);
        const asked: string[] = [];
        for (const word of words) {
            const letter = word[0]!.toLowerCase();
            const sign = word.slice(1);
            const ends = this.settings[`${letter}_stop`] ?? 0;
            if (!/^[rahzRAHZ][-+]?$/.test(word) || asked.includes(letter) || !fitted.includes(letter)) {
                throw new MachineError(2, "bad word");
            }
            if ((sign === "+" && !(ends & 2)) || (sign === "-" && !(ends & 1))) {
                throw new MachineError(2, "bad word");
            }
            asked.push(letter);
        }
        const joints = asked.length > 0 ? asked : fitted;
        if (joints.length === 0) {
            throw new MachineError(2, "bad word");
        }
        this.requireIdle();
        const lines: string[] = [];
        for (const letter of ["h", "r", "z", "a"]) {
            if (!joints.includes(letter)) {
                continue;
            }
            const word = words.find((w) => w[0]!.toLowerCase() === letter);
            const sign = word?.slice(1) ?? "";
            const ends = this.settings[`${letter}_stop`] ?? 0;
            const toMax = sign === "+" || (sign !== "-" && !(ends & 1));
            const pull = this.settings[`${letter}_home_pull`] ?? 1;
            const atSwitch = (this.settings[`${letter}_home_pos`] ?? 0) + (toMax && ends & 1 ? (this.settings[`${letter}_home_travel`] ?? 0) : 0);
            const at = atSwitch - (toMax ? 1 : -1) * pull;
            if (letter === "r") {
                this.joint = { ...this.joint, r: at };
            } else if (letter === "a") {
                this.joint = { ...this.joint, a: at };
            } else if (letter === "h") {
                this.h = at;
            } else {
                this.z = at;
            }
            const upper = letter.toUpperCase();
            this.homed = ["R", "A", "H", "Z"].filter((l) => l === upper || this.homed.includes(l)).join("");
            lines.push(`[HOME:${upper}:${at.toFixed(4)}:1]`);
        }
        this.enabled = true;
        return lines;
    }

    /** Clears an alarm; outside one there is nothing to clear, and the firmware says so. */
    unlock(): void {
        if (this.state !== "Alarm") {
            throw new MachineError(5, "not now");
        }
        this.state = "Idle";
        this.alarm = null;
    }

    requireIdle(): void {
        if (this.state !== "Idle") {
            throw new MachineError(5, "not now");
        }
    }

    setPosition(request: PositionRequest): void {
        this.requireIdle();
        this.checkFocusWord(request.h);
        if (request.r !== undefined) {
            this.checkReach(request.r);
        }
        this.joint = { r: request.r ?? this.joint.r, a: request.a ?? this.joint.a };
        this.z = request.z ?? this.z;
        this.h = request.h ?? this.h;
        // Declared elsewhere, an axis is no longer where its switch put it.
        for (const [key, letter] of [["r", "R"], ["a", "A"], ["h", "H"], ["z", "Z"]] as const) {
            if (request[key] !== undefined) {
                this.homed = this.homed.replace(letter, "");
            }
        }
    }

    /**
     * `probe H<distance> [F]`: moves the focus axis by up to `distance`
     * until the probe input goes active. The mock answers at once rather
     * than over time, so it takes the line only at rest where the firmware
     * would wait for the moves queued before it. A miss is `Alarm:2`, and
     * like any alarm it stops a spindle.
     */
    probe(distance: number, feed: number | null): ProbeResult {
        if (!this.hasFocusAxis()) {
            throw new MachineError(2, "bad word");
        }
        if (!Number.isFinite(distance) || distance === 0 || (feed !== null && !(feed >= MIN_FEED))) {
            throw new MachineError(4, "out of range");
        }
        this.requireIdle();
        if (this.probeActive()) {
            throw new MachineError(10, "probe active");
        }
        if (this.milling() && this.spindle > 0) {
            // The probe may be the tool itself: a turning one would cut at every touch.
            throw new MachineError(5, "not now");
        }
        this.enabled = true;
        this.beamOff();
        const from = this.h;
        const end = from + distance;
        const surface = this.contactHeight();
        // The input starts inactive, so it changes where the head crosses
        // the board's height, whichever way the polarity is set.
        const crosses = distance < 0 ? from > surface && end <= surface : from <= surface && end > surface;
        if (!crosses) {
            this.h = end;
            this.state = "Alarm";
            this.alarm = 2;
            this.spindle = 0;
            return { h: end, contact: false };
        }
        // The head brakes a little past the contact: 20 ms of motion at the
        // probe's speed, as much as the distance leaves.
        const speed = feed ?? this.settings["jog_h"] ?? 120;
        const brake = Math.min(Math.abs(end - surface), Math.max(1e-4, (speed / 60) * 0.02));
        this.h = surface + Math.sign(distance) * brake;
        return { h: surface, contact: true };
    }

    /** `laser S T`: S over `s_max` is full duty, not more; T past the maximum is refused; a spindle machine has no beam. */
    beam(power: number, ms: number): void {
        if (this.darkOutput()) {
            throw new MachineError(2, "bad word");
        }
        if (!(power >= 0) || !(ms >= 0) || ms > LASER_MAX_MS) {
            throw new MachineError(4, "out of range");
        }
        this.requireIdle();
        const sMax = this.settings["s_max"] ?? 1000;
        const limit = ms > 0 ? ms : this.settings["laser_ms"] ?? 5000;
        this.laser = Math.max(0, Math.min(1000, (power / sMax) * 1000));
        this.beamSeconds = Math.min(LASER_MAX_MS, limit) / 1000;
    }

    /** The beam off; a spindle keeps turning, as it does through a probe. */
    beamOff(): void {
        this.laser = 0;
        this.beamSeconds = 0;
    }

    /** `$name=value`: the whole set is checked with the value in it, and a refused value changes nothing. */
    setSetting(name: string, value: number): void {
        if (!(name in DEFAULT_SETTINGS)) {
            throw new MachineError(6, "unknown setting");
        }
        const next = { ...this.settings, [name]: value };
        if (!settingsValid(next)) {
            throw new MachineError(7, "bad setting value");
        }
        this.adopt(next);
    }

    /** Takes a whole set of settings, from a write, `$load` or `$defaults`. */
    adopt(settings: Record<string, number>): void {
        if ((settings["spindle"] ?? 0) !== (this.settings["spindle"] ?? 0) || (settings["dispenser"] ?? 0) !== (this.settings["dispenser"] ?? 0)) {
            // The output changes meaning: whatever ran on it stops.
            this.outputOff();
        }
        this.settings = { ...settings };
    }
}

/** A planned move with where the cross slide ends, which moves only on a cartesian machine. */
type Step = PlannedMove & { z: number };

interface RunSession {
    job: Job;
    moves: Move[];
    next: number;
    okSent: number;
    state: RunState;
    seconds: number;
    group: number;
    /** The line the run picked the job up at; null for a run from the top. */
    resumedFrom?: number | null;
    compensate?: MapMode;
}

/** What a run was planned from, kept with its progress as the resume record. */
interface RunPlan {
    start: [number, number];
    compensate: MapMode;
    cartesian: boolean;
    spindle: boolean;
    /** The height a laser group's own focus counted from; null when no group had one. */
    start_h: number | null;
    /** The focus axis frame that height was read in. */
    frame: string;
    /** The plan's moves as `planPrint` sums them up. */
    fingerprint: string;
}

/** Where a run's plan began: the joints and the cross slide. */
interface PlanStart {
    joint: Joint;
    z: number;
}

/**
 * A short print of a plan's moves: what each one is and where it goes,
 * without the words that only say how (feed, power, floor, dwell time and
 * focus height), as the backend's PlanPrint sums its lines up. Two plans
 * with the same print have the same moves at the same counts.
 */
export function planPrint(moves: Move[]): string {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (const move of moves) {
        const words = formatMove(move).split(" ");
        const kept = words.slice(1).filter((word) => !["F", "S", "M", "T", "H"].includes(word.charAt(0).toUpperCase()));
        const text = `${move.kind} ${words[0]} ${kept.join(" ")}\n`;
        for (let i = 0; i < text.length; i++) {
            const code = text.charCodeAt(i);
            h1 = Math.imul(h1 ^ code, 2654435761);
            h2 = Math.imul(h2 ^ code, 1597334677);
        }
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/** Points per side of a probe grid. */
const GRID_MIN_POINTS = 2;
const GRID_MAX_POINTS = 50;
/** Most a map may span top to bottom and still be followed, mm. */
const MAX_SPAN = 5;
/** How far past the grid a job may reach and still be compensated, mm. */
const COVER_MARGIN = 1;
/** Mock time the probing spends on one grid point, s: less than a real probe, enough to watch. */
export const PROBE_POINT_SECONDS = 0.25;
const COMPENSATE_MODES: readonly string[] = ["off", "auto", "focus", "power"];

export const DEFAULT_PROBE_SETTINGS: ProbeSettings = { depth: 5, feed: 60, slow: 15, backoff: 0.3, offset: [0, 0], rayleigh: 0.5 };

/** Where the joints go to put the probe tip over a point; the cross slide too on a cartesian machine. */
type ProbeJoint = Joint & { z?: number };

/** A probing under way: the points in the order they are visited and the joints that reach them. */
interface ProbeSession {
    settings: ProbeSettings;
    order: [number, number][];
    joints: ProbeJoint[];
    /** Index into `order` of the point in progress. */
    next: number;
    /** A pad map: the indices of its points in the order they are probed, in place of `order`. */
    pads: number[] | null;
    /** Seconds spent on the point in progress. */
    elapsed: number;
    /** The head's height when probing began, which it travels at between points. */
    travel: number;
    map: HeightMap;
    /** Seconds unrounded; the state rounds them. */
    progress: ProbeProgress;
}

/** The camera offset routine under way, on the mock's clock. */
interface FindSession {
    /** The mark's board point. */
    mark: Board;
    /** How far the head is moved along +X to measure the scale; 0 skips it. */
    step: number;
    phase: RoutineStep;
    /** Centering moves made so far. */
    centered: number;
    elapsed: number;
    progress: CameraRoutine;
}

/** Mock time one step of the camera offset routine takes, s. */
export const FIND_STEP_SECONDS = 0.5;
/** The spot is centered once it is within this of the picture's center, mm. */
const CENTER_TOLERANCE = 0.02;
const CENTERING_MOVES = 3;
/** What the routine moves by when asked for no step but the scale is unknown, mm. */
const DEFAULT_FIND_STEP = 2;
/** Mock time one step of an up camera routine takes, s. */
export const PNP_STEP_SECONDS = 0.4;
/** How fast the mock's G-code machine takes a placing run's lines. */
export const DEVICE_LINES_PER_SECOND = 40;

function clamp(value: number, low: number, high: number): number {
    return value < low ? low : value > high ? high : value;
}

function checkGrid(grid: Grid): void {
    for (const value of [grid.x0, grid.y0, grid.x1, grid.y1]) {
        if (!(Math.abs(value) <= MAX_VALUE)) {
            throw new Error(`grid corners must be within ${MAX_VALUE_TEXT} mm`);
        }
    }
    if (!(grid.x1 > grid.x0 && grid.y1 > grid.y0)) {
        throw new Error("the grid needs x1 above x0 and y1 above y0");
    }
    for (const [count, name] of [[grid.nx, "nx"], [grid.ny, "ny"]] as const) {
        if (!Number.isInteger(count) || count < GRID_MIN_POINTS || count > GRID_MAX_POINTS) {
            throw new Error(`${name} must be ${GRID_MIN_POINTS} to ${GRID_MAX_POINTS}`);
        }
    }
}

function gridXs(grid: Grid): number[] {
    return Array.from({ length: grid.nx }, (_, i) => grid.x0 + ((grid.x1 - grid.x0) * i) / (grid.nx - 1));
}

function gridYs(grid: Grid): number[] {
    return Array.from({ length: grid.ny }, (_, j) => grid.y0 + ((grid.y1 - grid.y0) * j) / (grid.ny - 1));
}

/** How far a touch that ties the map keeps from a cut, mm, over half the job's spot. */
const TOUCH_CLEARANCE = 1.0;

/** A joint line's words: the rail and the cross slide when `z` is given, as a cartesian machine's joints are, else the rail and the table. */
function jointWords(r: number, a: number, z?: number): string {
    return z !== undefined ? `R${formatFixed(r, 3)} Z${formatFixed(z, 3)}` : `R${formatFixed(r, 3)} A${formatFixed(a, 4)}`;
}

/** The finer of the two point spacings, mm. */
function gridSpacing(grid: Grid): number {
    return Math.min((grid.x1 - grid.x0) / (grid.nx - 1), (grid.y1 - grid.y0) / (grid.ny - 1));
}

/** Every point as [ix, iy], row by row with every other row reversed, so the head never crosses the board between two points. */
export function gridOrder(grid: Grid): [number, number][] {
    const out: [number, number][] = [];
    for (let iy = 0; iy < grid.ny; iy++) {
        for (let k = 0; k < grid.nx; k++) {
            const ix = iy % 2 === 0 ? k : grid.nx - 1 - k;
            if (gridWanted(grid, ix, iy)) {
                out.push([ix, iy]);
            }
        }
    }
    return out;
}

/** Whether a grid point is probed: every one without a mask. */
export function gridWanted(grid: Grid, ix: number, iy: number): boolean {
    const mask = grid.mask;
    return !mask || Boolean(mask[iy]?.[ix]);
}

/** How many points a grid probes. */
export function gridPoints(grid: Grid): number {
    return gridOrder(grid).length;
}

/**
 * The grid probing only what a job's cuts come near: the corners of every
 * cell a cut passes through, the cut taken `margin` plus half the spot
 * wide. A job with no cuts inside the grid keeps the whole grid.
 */
export function gridMaskedForJob(grid: Grid, job: Job, margin: number): Grid {
    const reach = Math.max(0, margin) + Math.max(0, job.spot ?? 0) / 2;
    const dx = (grid.x1 - grid.x0) / (grid.nx - 1);
    const dy = (grid.y1 - grid.y0) / (grid.ny - 1);
    const cells: boolean[][] = Array.from({ length: grid.ny - 1 }, () => Array<boolean>(grid.nx - 1).fill(false));
    const clampX = (value: number): number => Math.max(0, Math.min(grid.nx - 2, Math.floor((value - grid.x0) / dx)));
    const clampY = (value: number): number => Math.max(0, Math.min(grid.ny - 2, Math.floor((value - grid.y0) / dy)));
    let anyCut = false;
    const markBox = (bx0: number, by0: number, bx1: number, by1: number): void => {
        if (bx1 < grid.x0 || bx0 > grid.x1 || by1 < grid.y0 || by0 > grid.y1) {
            return;
        }
        for (let j = clampY(by0); j <= clampY(by1); j++) {
            for (let i = clampX(bx0); i <= clampX(bx1); i++) {
                cells[j]![i] = true;
            }
        }
    };
    const step = Math.min(dx, dy) / 2;
    const markSegment = (a: Point, b: Point): void => {
        const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const parts = length > 0 ? Math.max(1, Math.ceil(length / step)) : 1;
        for (let k = 0; k < parts; k++) {
            const p: Point = [a[0] + (b[0] - a[0]) * k / parts, a[1] + (b[1] - a[1]) * k / parts];
            const q: Point = [a[0] + (b[0] - a[0]) * (k + 1) / parts, a[1] + (b[1] - a[1]) * (k + 1) / parts];
            markBox(Math.min(p[0], q[0]) - reach, Math.min(p[1], q[1]) - reach, Math.max(p[0], q[0]) + reach, Math.max(p[1], q[1]) + reach);
        }
    };
    for (const group of job.groups) {
        if (!group.enabled) {
            continue;
        }
        for (const path of group.paths) {
            if (path.length === 0) {
                continue;
            }
            anyCut = true;
            if (path.length === 1) {
                markSegment(path[0]!, path[0]!);
            }
            for (let k = 1; k < path.length; k++) {
                markSegment(path[k - 1]!, path[k]!);
            }
        }
        for (const poly of group.joints ?? []) {
            const points: Point[] = poly.map(([r, a]) => {
                const board = boardOfJoint({ r, a });
                return [board.x, board.y];
            });
            if (points.length === 0) {
                continue;
            }
            anyCut = true;
            for (let k = 1; k < points.length; k++) {
                markSegment(points[k - 1]!, points[k]!);
            }
        }
    }
    if (!anyCut) {
        return { ...grid, mask: null };
    }
    const mask: boolean[][] = Array.from({ length: grid.ny }, () => Array<boolean>(grid.nx).fill(false));
    cells.forEach((row, j) => row.forEach((flag, i) => {
        if (flag) {
            mask[j]![i] = mask[j]![i + 1] = mask[j + 1]![i] = mask[j + 1]![i + 1] = true;
        }
    }));
    return { ...grid, mask };
}

/**
 * The joints that put the probe tip, `offset` from the beam along the rail
 * and across it, over a board point, with the tip outside the beam. A tip
 * off the rail never comes nearer the axis than its offset across it; a
 * point inside that circle is probed from the nearest place on it when that
 * is at most `slack` away, and refused otherwise.
 */
export function probeJoint(point: [number, number], offset: [number, number], previousAngle: number, slack = 0): Joint {
    const [along, across] = offset;
    let [x, y] = point;
    let rho = Math.hypot(x, y);
    if (rho < Math.abs(across)) {
        if (Math.abs(across) - rho > slack) {
            throw new Error(
                `the probe cannot reach (${x.toFixed(2)}, ${y.toFixed(2)}): its tip is ${formatG(Math.abs(across))} mm off` +
                    " the rail, so it never comes nearer the axis than that; move the grid off the axis or" +
                    " mount the probe in line with the rail",
            );
        }
        const direction = rho > 0 ? Math.atan2(y, x) : 0;
        rho = Math.abs(across);
        x = rho * Math.cos(direction);
        y = rho * Math.sin(direction);
    }
    const reach = Math.sqrt(Math.max(0, rho * rho - across * across));
    const r = reach - along;
    if (rho < AXIS_EPSILON) {
        return { r, a: previousAngle };
    }
    const angle = (Math.atan2(y, x) - Math.atan2(across, reach)) / DEG;
    return { r, a: unwrap(angle, previousAngle) };
}

/** The board's height at a board point: bilinear inside the grid, the nearest edge outside it. */
export function heightAt(map: HeightMap, x: number, y: number): number {
    const grid = map.grid;
    const u = clamp(((x - grid.x0) / (grid.x1 - grid.x0)) * (grid.nx - 1), 0, grid.nx - 1);
    const v = clamp(((y - grid.y0) / (grid.y1 - grid.y0)) * (grid.ny - 1), 0, grid.ny - 1);
    const i = Math.min(Math.floor(u), grid.nx - 2);
    const j = Math.min(Math.floor(v), grid.ny - 2);
    const t = u - i;
    const s = v - j;
    const h00 = map.heights[j]?.[i];
    const h10 = map.heights[j]?.[i + 1];
    const h01 = map.heights[j + 1]?.[i];
    const h11 = map.heights[j + 1]?.[i + 1];
    if (h00 == null || h10 == null || h01 == null || h11 == null) {
        throw new Error("the height map is not complete");
    }
    return (1 - t) * (1 - s) * h00 + t * (1 - s) * h10 + (1 - t) * s * h01 + t * s * h11;
}

function probedValues(map: HeightMap): number[] {
    return map.heights.flat().filter((value): value is number => value !== null);
}

/** A pad map's probed points, with the count of its points; a grid map's probed cells and its cells. */
function probedCount(map: HeightMap): { probed: number; total: number; pads: boolean } {
    if (map.points && map.point_heights) {
        return { probed: map.point_heights.filter((value) => value !== null).length, total: map.points.length, pads: true };
    }
    return { probed: probedValues(map).length, total: map.grid.nx * map.grid.ny, pads: false };
}

/** Refuses a map whose shape does not match its grid. */
function checkHeightMap(map: HeightMap): void {
    checkGrid(map.grid);
    if (map.heights.length !== map.grid.ny || map.heights.some((row) => row.length !== map.grid.nx)) {
        throw new Error(`heights must be ${map.grid.ny} rows of ${map.grid.nx}`);
    }
    if (map.points && (!map.point_heights || map.point_heights.length !== map.points.length)) {
        throw new Error("point_heights must be one per point");
    }
    if (probedValues(map).some((value) => Math.abs(value) > MAX_VALUE)) {
        throw new Error(`heights must be within ${MAX_VALUE_TEXT} mm`);
    }
    if (Math.abs(map.focus_offset) > MAX_VALUE) {
        throw new Error(`focus_offset must be within ${MAX_VALUE_TEXT} mm`);
    }
}

/** A map as the backend reads one from a request: defaults filled in, numbers that are numbers. */
function readHeightMap(map: HeightMap): HeightMap {
    const grid = map?.grid;
    if (!grid || !Array.isArray(map.heights) || !map.heights.every((row) => Array.isArray(row))) {
        throw new ApiError(422, "a height map needs a grid and rows of heights");
    }
    const read: HeightMap = {
        grid: { x0: grid.x0, y0: grid.y0, x1: grid.x1, y1: grid.y1, nx: grid.nx ?? 5, ny: grid.ny ?? 5 },
        heights: map.heights.map((row) => row.map((value) => value ?? null)),
        focus_offset: map.focus_offset ?? 0,
        focus_set: map.focus_set ?? false,
        probe_offset: map.probe_offset ? [map.probe_offset[0], map.probe_offset[1]] : [0, 0],
        created: map.created ?? "",
        points: Array.isArray(map.points) ? map.points.map((point) => [point[0], point[1]]) : null,
        point_heights: Array.isArray(map.point_heights) ? map.point_heights.map((value) => value ?? null) : null,
    };
    const numbers = [...Object.values(read.grid), ...probedValues(read), read.focus_offset, ...read.probe_offset, ...(read.points ?? []).flat()];
    if (!numbers.every((value) => typeof value === "number" && Number.isFinite(value))) {
        throw new ApiError(422, "a height map's numbers must be finite");
    }
    return read;
}

/** Refuses a map a run should not follow. */
function checkUsable(map: HeightMap): void {
    const values = probedValues(map);
    const { probed, total, pads } = probedCount(map);
    if (probed !== total) {
        throw new Error(pads ? `the pad map is not complete: ${probed} of ${total} pads probed` : `the height map is not complete: ${probed} of ${total} points probed`);
    }
    if (!map.focus_set) {
        throw new Error("the focus offset is not set: focus the beam by eye over the probed area and use focus here");
    }
    const span = values.length > 0 ? Math.max(...values) - Math.min(...values) : 0;
    if (span > MAX_SPAN) {
        throw new Error(`the height map spans ${span.toFixed(3)} mm, more than ${MAX_SPAN} mm: probe again or flatten the board`);
    }
}

/**
 * The board box the enabled groups of a job cut inside. A joint-space
 * group is sampled along its moves, not only at its points: a move that
 * turns the table sweeps an arc well outside the box of its ends.
 */
function jobExtent(job: Job): [number, number, number, number] | null {
    const points = job.groups
        .filter((group) => group.enabled)
        .flatMap((group): [number, number][] => (group.joints && group.joints.length > 0 ? group.joints.flatMap((poly) => jointPreview(poly)) : group.paths.flat()));
    return points.length > 0 ? extent(points) : null;
}

/** Refuses a job that reaches past the probed area, where the edge value would stand in for a board nobody measured. */
function checkCovers(map: HeightMap, job: Job): void {
    const box = jobExtent(job);
    if (box === null) {
        return;
    }
    const grid = map.grid;
    const [x0, y0, x1, y1] = box;
    const m = COVER_MARGIN;
    if (!(x0 >= grid.x0 - m && y0 >= grid.y0 - m && x1 <= grid.x1 + m && y1 <= grid.y1 + m)) {
        const f = (value: number): string => value.toFixed(1);
        throw new Error(
            `the height map does not cover the job: probed X ${f(grid.x0)}..${f(grid.x1)} Y ${f(grid.y0)}..${f(grid.y1)}, ` +
                `the job reaches X ${f(x0)}..${f(x1)} Y ${f(y0)}..${f(y1)}`,
        );
    }
}

function checkProbeSettings(settings: ProbeSettings): void {
    if (!(settings.depth > 0 && settings.depth <= 100)) {
        throw new Error("depth must be above 0 and at most 100 mm");
    }
    if (!(settings.feed >= 0.001 && settings.feed <= 10000)) {
        throw new Error("feed must be 0.001 to 10000 mm/min");
    }
    if (settings.slow !== 0 && !(settings.slow >= 0.001 && settings.slow <= 10000)) {
        throw new Error("slow must be 0 (one touch) or 0.001 to 10000 mm/min");
    }
    if (!(settings.backoff > 0 && settings.backoff <= settings.depth)) {
        throw new Error("backoff must be above 0 and at most the depth");
    }
    const offset = settings.offset;
    if (!(Array.isArray(offset) && offset.length === 2 && offset.every((value) => Math.abs(value) <= 1000))) {
        throw new Error("the probe offset must be within 1000 mm");
    }
    if (!(settings.rayleigh >= 0.001 && settings.rayleigh <= 100)) {
        throw new Error("rayleigh must be 0.001 to 100 mm");
    }
}

/** The highest point a map puts the surface at, for a spindle to travel clear of. */
function highestSurface(map: HeightMap): number {
    const values = probedValues(map);
    return (values.length > 0 ? Math.max(...values) : 0) + map.focus_offset;
}

/**
 * The letter words of a line as the firmware reads them: each letter one
 * of `allowed` and given once, with a plain decimal value. Null when any
 * is not, which the firmware refuses as a bad word.
 */
function readWords(tokens: string[], allowed: string): Map<string, number> | null {
    const words = new Map<string, number>();
    for (const token of tokens) {
        const letter = (token[0] ?? "").toUpperCase();
        const value = decimal(token.slice(1));
        if (!/^[A-Z]$/.test(letter) || !allowed.includes(letter) || value === null || words.has(letter)) {
            return null;
        }
        words.set(letter, value);
    }
    return words;
}

/** The firmware's answer to `probe H<distance> [F<feed>]`, a refusal thrown as a MachineError. */
function probeReplies(machine: MockMachine, distance: number, feed: number | null): string[] {
    const result = machine.probe(distance, feed);
    const report = `[PRB:${result.h.toFixed(4)}:${result.contact ? 1 : 0}]`;
    if (result.contact) {
        return [report, "ok"];
    }
    return [report, "ALARM:2 probe missed, check the head before moving", "error:11 probe missed"];
}

/** The time now as the backend stamps a map it makes: to the second, in UTC as +00:00. */
function createdNow(): string {
    return new Date().toISOString().replace(/\.\d+Z$/, "+00:00");
}

/** A touch's mode and where it goes down, refused in the backend's words: a nearest point only ties the map. */
function touchOf(request: TouchRequest): { mode: TouchMode; at: TouchAt } {
    const mode = request.mode;
    const at = request.at ?? "here";
    if (mode !== "map" && mode !== "zero") {
        throw new ApiError(400, "mode must be map or zero");
    }
    if (at !== "here" && at !== "nearest") {
        throw new ApiError(400, "at must be here or nearest");
    }
    if (at === "nearest" && mode !== "map") {
        throw new ApiError(400, "the nearest probed point is for tying the map: H 0 is set where the head is");
    }
    return { mode, at };
}

/** Refuses an id no machine file may have, in the backend's words. */
function checkMachineId(id: string): void {
    if (!MACHINE_ID_PATTERN.test(id)) {
        throw new ApiError(400, `'${id}' is not a machine id: lower case letters, digits, - and _`);
    }
}

/** Refuses an id no CAM profile may have, in the backend's words. */
function checkProfileId(id: string): void {
    if (!ID_PATTERN.test(id)) {
        throw new ApiError(400, `'${id}' is not a profile id: lower case letters, digits, - and _`);
    }
}

/** What the PNP tab keeps of one G-code machine. */
interface MockPlacing {
    angle: number | null;
    references: PnpReference[];
    taken: Record<string, number>;
    boards: number;
    /** Where the up camera sits on the machine, as centering the nozzle over it measured, and the tip's runout. */
    upPlace: { position: [number, number] | null; mm_per_px: number; roll: number; mirror: boolean; runout: [number, number] | null };
}

/** The port at `url` is this G-code machine's: its url is the file's, or the port's USB names hold one of the file's words. */
function claims(machine: MockDevice, url: string, names: string): boolean {
    if (machine.url && url === machine.url) {
        return true;
    }
    const hay = names.toLowerCase();
    return hay !== "" && machine.match.some((word) => hay.includes(word.toLowerCase()));
}

function newPlacing(): MockPlacing {
    return { angle: null, references: [], taken: {}, boards: 0, upPlace: { position: null, mm_per_px: 0, roll: 0, mirror: true, runout: null } };
}

export interface MockOptions {
    /** Drive the simulation from a timer; off for tests, which call `step`. */
    timers?: boolean;
}

/** Each enabled group's own focus by its index, for the groups that have one and something to cut. */
export function groupFocus(job: Job): Map<number, number> {
    const offsets = new Map<number, number>();
    job.groups.forEach((group, index) => {
        const cuts = group.paths.length > 0 || (group.joints?.length ?? 0) > 0;
        if (group.enabled && cuts && group.focus !== undefined && group.focus !== null) {
            offsets.set(index, group.focus);
        }
    });
    return offsets;
}

/** Following the map by power holds the head still, which a group's own focus would move. */
function refusePowerWithFocus(job: Job, mode: string): void {
    const focused = groupFocus(job).keys().next();
    if (mode === "power" && !focused.done) {
        throw new Error(`${job.groups[focused.value]!.label} asks for a focus height, and following the map by power holds the head still: follow it with the focus axis, or clear the group's focus`);
    }
}

/** The fake backend: the Api and the EventFeed in one object. */
/** How far off its numbers the mock's home leaves the head, mm: what Home by fiducial finds and declares away. */
const MOCK_HOME_ERROR: [number, number] = [0.2, -0.15];

export class MockBackend implements Api, EventFeed {
    readonly machine = new MockMachine(MOCK_MACHINE_SETTINGS);
    connected = false;
    url: string | null = null;
    tolerance = 0.005;
    /** The host's milling settings: travel height over the surface, mm, and the spin-up dwell, s. */
    clearance = 2;
    spinup = 2;
    /** Whether the spindle's speed follows the groups; off, it runs at s_max whenever it runs. */
    speedControl = true;
    /** The H the page's moves and probing rise to before going across; null leaves the head where it is. */
    travel: number | null = null;
    /** The host's dispensing settings: what every dot of a dispensing run is made of. */
    gap = 0.1;
    retract = 0.2;
    output = 100;
    extrudeRate = 60;
    dwellMs = 200;
    status: LinkStatus = "closed";
    /** The camera on the head as the backend keeps it: its settings, whether it runs, the board it looks for and the mark. */
    cameraConfig: CameraSettings = { ...CAMERA_DEFAULTS, offset: [...CAMERA_DEFAULTS.offset] };
    cameraRunning = false;
    /** The photos taken by hand, and whether the routines' looks would be kept. */
    private readonly cameraLog = new MockCameraLog();
    /** The Auto tab: its conversation, settings and scripted provider. */
    private readonly auto = new MockAuto((data) => this.emit({ type: "auto", data }), () => this.jobSummaries());
    /** The top bar's to-do list. */
    private readonly todoList = new MockTodo();
    /** Bug reports and the link they are handed on to. */
    private readonly reportDesk = new MockReports();
    /** The page's plugins, the example of docs/PLUGINS.md among them. */
    readonly pluginShelf = new MockPlugins((list) => this.emit({ type: "plugins", data: { plugins: list } }));
    private cameraJob: string | null = null;
    private cameraMarkPoint: Board | null = null;
    /** Where the loaded board really lies: the job's design a little off, so alignment has something to find. */
    private placement: Placement | null = null;
    /** Each board's placement once looked for, so a board loaded again lies where it did. */
    private placements = new Map<string, Placement>();
    private routine: CameraRoutine | null = null;
    private finding: FindSession | null = null;
    /** The head and top cameras' looks for a board, the head camera's search under way, and the stops of the top camera's. */
    private readonly headLook = new MockBoardLook(() => lookTuning(this.cameraConfig));
    /** A line for each board search run to its end, as the backend's search records. */
    private readonly searchRecords = new MockSearchLog();
    private readonly topBoardLook = new MockBoardLook(() => lookTuning(this.topConfig));
    private headSearch: { stops: Board[]; index: number; elapsed: number; progress: CameraRoutine } | null = null;
    private topSearchStops: Board[] = [];
    /** The last look taken by hand with the up and the top camera. */
    private upLookOnce: SpotLook | null = null;
    private topLookOnce: SpotLook | null = null;
    /** The V4L2 control values each camera keeps. */
    private keptControls: Record<ControlledCamera, Record<string, number>> = { head: {}, up: {}, top: {} };
    /** The up camera of the PNP page: its settings, whether it runs, its routine, and the part last looked at. */
    pnpConfig: PnpSettings = { ...PNP_DEFAULTS };
    pnpRunning = false;
    private pnpRoutine: PnpRoutine | null = null;
    private pnpSession: { kind: "nozzle" | "part"; steps: PnpStep[]; elapsed: number; moved: boolean; progress: PnpRoutine } | null = null;
    private pnpPartOffset: PartOffset | null = null;
    /** Whether a part hangs on the mock's nozzle: from the first look at one on. */
    private pnpHolding = false;
    /**
     * What the PNP tab keeps of each G-code machine, by its file's id: the
     * board's turn and references, the feeders' counts, the boards
     * finished, and the up camera's place on it; and the G-code machine
     * connected and the one last connected, which the tab places with
     * while none is.
     */
    private placings = new Map<string, MockPlacing>();
    private gcodeId: string | null = null;
    private lastGcode: string | null = null;
    /** Whether the G-code machine's motors were last switched on, and what its firmware said it is. */
    private gcodeMotors = true;
    private gcodeFirmware: string | null = null;
    /** The connected G-code machine's link: a fake controller that answers every line `ok`, its head's place, and what it was told. */
    private deviceLink: {
        connected: boolean;
        url: string | null;
        homed: boolean;
        position: { x: number; y: number; z: number; rotation: number };
        log: { dir: string; text: string }[];
        light: boolean | null;
        reading: number | null;
        vacuumSwitched: boolean | null;
    } = {
        connected: false,
        url: null,
        homed: false,
        position: { x: 0, y: 0, z: 0, rotation: 0 },
        log: [],
        light: null,
        reading: null,
        vacuumSwitched: null,
    };
    private devicePositionRead = false;
    private deviceProgress: PlacingRun | null = null;
    private deviceSession: {
        lines: { code: string; block: MockBlock | null; look?: MockBlock; picked?: MockBlock; advance?: MockFeeder }[];
        next: number;
        elapsed: number;
        device: MockDevice;
        progress: PlacingRun;
        /** Each part's value, for the steps in words. */
        values: Map<string, string>;
    } | null = null;
    private deviceRoutine: { kind: "nozzle" | "runout"; elapsed: number; device: MockDevice; progress: PnpRoutine } | null = null;
    /** Whether the G-code machine's vacuum is on, as its pick and place commands left it. */
    private deviceVacuumOn = false;
    /** The fake feeder bus: the feeders initialized, the status asks a feed has left, and the next packet's number. */
    private busReady = new Set<number>();
    private busFeeding = new Map<number, number>();
    private busNumber = 0;
    /** The device's top camera: its settings, whether it runs, its routine, and the fiducials last found. */
    private topConfig: TopSettings = { ...TOP_DEFAULTS };
    private topRunning = false;
    private topRoutine: TopRoutine | null = null;
    private topSession: { kind: "offset" | "fiducials" | "search" | "home"; steps: string[]; elapsed: number; device: MockDevice; job: string | null; progress: TopRoutine } | null = null;
    private topFiducials: TopState["fiducials"] = null;
    /** The alignment marks, kept for one job at a time. */
    private alignJob: string | null = null;
    private alignMarks: AlignMark[] = [];
    private alignFitLast: AlignFit | null = null;

    private jobStore = new Map<string, Job>();
    /** The text a board job was imported from and its options, by job, to import it again for another width. */
    private uploads = new Map<string, { name: string; text: string; options: UploadOptions }>();
    private markerList: Marker[] = [];
    /** The CAM profiles, by id, as their files read; the shipped ones to start with. */
    private camTexts = new Map<string, string>(SHIPPED_PROFILES.map((profile) => [profile.id, profile.text]));
    private machineTexts = new Map<string, string>(MOCK_MACHINE_TEXTS.map((machine) => [machine.id, machine.text]));
    private order: string[] = [];
    private nextId = 1;
    private session: RunSession | null = null;
    private lastProgress: Progress | null = null;
    /** What the last run was planned from, kept with its progress as the resume record. */
    private lastPlan: RunPlan | null = null;
    /** Where the last run's plan began, all of it, so a pickup plans the same moves. */
    private lastStart: PlanStart | null = null;
    /** Board moves waiting for a free line slot, sent as the machine drains. */
    private outbox: { line: string; move: Move }[] = [];
    private eventListeners = new Set<(event: WsEvent) => void>();
    private statusListeners = new Set<(status: LinkStatus) => void>();
    private readonly useTimers: boolean;
    private timer: ReturnType<typeof setInterval> | null = null;
    private lastTick = 0;
    private stateClock = 0;
    private progressClock = 0;
    private lastSocket: string | null = null;
    private heightmap: HeightMap | null = null;
    /** The last probing's progress, kept once it has ended. */
    private probeProgress: ProbeProgress | null = null;
    private probing: ProbeSession | null = null;
    private probeConfig: ProbeSettings = structuredClone(DEFAULT_PROBE_SETTINGS);
    /**
     * The jogs sent through this API end where they were sent, as the
     * backend tracks them: a board move queued behind them starts from
     * there. Anything else moving the machine leaves that end unknown.
     */
    private jogTracked = false;
    /**
     * The focus axis frame, counted up whenever it may have changed, and
     * the frames the map's heights were probed in and its focus offset set
     * in; null for neither.
     */
    private frame = 0;
    private heightsFrame: number | null = null;
    private focusFrame: number | null = null;
    /** Lines the machine prints after its answer to a console line, as `$tmc` prints its report. */
    private later: string[] = [];
    /** The machine file last loaded onto the board; its controls stay while a setting changed by hand makes the values no file's. */
    private loaded: string | null = null;

    constructor(options: MockOptions = {}) {
        this.useTimers = options.timers ?? true;
        // The simulated probe sits where the probe settings say it is mounted.
        this.machine.probeOffset = [...this.probeConfig.offset];
        this.seedDemo();
    }

    // Event feed.

    start(): void {
        this.setStatus("open");
        if (this.useTimers && this.timer === null) {
            this.lastTick = performance.now();
            this.timer = setInterval(() => {
                const now = performance.now();
                const dt = Math.min(0.5, Math.max(0, (now - this.lastTick) / 1000));
                this.lastTick = now;
                this.step(dt);
            }, TICK_MS);
        }
        this.emit({ type: "state", data: this.snapshot() });
    }

    stop(): void {
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.setStatus("closed");
    }

    onEvent(listener: (event: WsEvent) => void): () => void {
        this.eventListeners.add(listener);
        return () => {
            this.eventListeners.delete(listener);
        };
    }

    onStatus(listener: (status: LinkStatus) => void): () => void {
        this.statusListeners.add(listener);
        return () => {
            this.statusListeners.delete(listener);
        };
    }

    private setStatus(status: LinkStatus): void {
        if (this.status === status) {
            return;
        }
        this.status = status;
        for (const listener of [...this.statusListeners]) {
            listener(status);
        }
    }

    private emit(event: WsEvent): void {
        for (const listener of [...this.eventListeners]) {
            listener(event);
        }
    }

    private line(dir: "tx" | "rx", text: string): void {
        this.emit({ type: "console", data: { dir, text } });
    }

    private message(level: "info" | "error", text: string): void {
        this.emit({ type: "message", data: { level, text } });
    }

    /** Advances the machine by `dt` seconds, streams the run and sends the periodic events. */
    step(dt: number): void {
        if (this.connected) {
            const wasMoving = this.machine.moving();
            this.machine.advance(dt);
            this.drainOutbox();
            this.serviceRun(dt);
            this.serviceProbe(dt);
            this.serviceFind(dt);
            this.serviceHeadSearch(dt);
            this.servicePnp(dt);
            const period = wasMoving || this.machine.moving() ? 0.1 : 0.2;
            this.stateClock += dt;
            if (this.stateClock >= period - CLOCK_EPSILON) {
                this.stateClock = Math.min(this.stateClock - period, period / 2);
                this.emit({ type: "state", data: this.snapshot() });
            }
        }
        // A G-code machine's placing run and camera routines, on the same clock.
        this.serviceDevice(dt);
        this.serviceDeviceRoutine(dt);
        this.serviceTopRoutine(dt);
        this.serviceLooks(dt);
        // So is the Auto tab, which moves nothing.
        this.auto.step(dt);
    }

    /** Sends a board move now when a slot is free, else keeps it for the next tick. */
    private send(line: string, move: Move): void {
        if (this.outbox.length === 0 && this.machine.canQueue()) {
            this.exchange(line, () => this.machine.push(move));
            return;
        }
        this.outbox.push({ line, move });
    }

    private drainOutbox(): void {
        while (this.outbox.length > 0 && this.machine.canQueue()) {
            const next = this.outbox.shift();
            if (!next) {
                break;
            }
            try {
                this.exchange(next.line, () => this.machine.push(next.move));
            } catch (error) {
                this.outbox = [];
                this.message("error", errorText(error));
                break;
            }
        }
    }

    snapshot(): Snapshot {
        if (this.gcodeId !== null) {
            return this.gcodeSnapshot(this.gcodeId);
        }
        return {
            connected: this.connected,
            url: this.url,
            firmware: this.connected ? { version: MOCK_VERSION, lines: LINE_SLOTS, blocks: PLANNER_BLOCKS } : null,
            machine: this.connected ? this.machine.status() : null,
            profile: this.machine.profile(),
            run: this.progress(),
            resume: this.resumeRecordOf(),
        };
    }

    private progress(): Progress | null {
        const session = this.session;
        if (!session) {
            return this.lastProgress;
        }
        const acked = session.next - this.machine.waitingLines();
        return {
            job: session.job.id,
            state: session.state,
            sent: session.next,
            acked: Math.max(session.resumedFrom ?? 0, Math.min(session.next, acked)),
            total: session.moves.length,
            seconds: session.seconds,
            estimate: session.job.stats.seconds,
            group: session.group,
            resumed_from: session.resumedFrom ?? null,
            compensate: session.compensate ?? "off",
        };
    }

    /** The record of the last run, as the backend keeps across sessions. */
    private resumeRecordOf(): ResumeRecord | null {
        const progress = this.progress();
        if (!progress || !this.lastPlan) {
            return null;
        }
        return { ...progress, ...this.lastPlan, position: { ...this.machine.joint, z: this.machine.z, h: this.machine.hasFocusAxis() ? this.machine.h : null } };
    }

    private serviceRun(dt: number): void {
        const session = this.session;
        if (!session) {
            return;
        }
        const machine = this.machine;
        if (machine.state === "Alarm") {
            session.state = "error";
        } else if (session.state === "running" && machine.state === "Hold") {
            session.state = "hold";
        } else if (session.state === "hold" && machine.state !== "Hold") {
            session.state = "running";
        }
        if (session.state === "running") {
            session.seconds += dt;
            while (session.next < session.moves.length && machine.canQueue()) {
                const move = session.moves[session.next];
                if (!move) {
                    break;
                }
                try {
                    machine.push(move);
                } catch (error) {
                    session.state = "error";
                    this.message("error", errorText(error));
                    break;
                }
                session.next += 1;
                this.line("tx", formatMove(move));
            }
            const acked = session.next - machine.waitingLines();
            while (session.okSent < acked) {
                session.okSent += 1;
                this.line("rx", "ok");
            }
            const current = machine.active?.move.group;
            if (current !== undefined && current >= 0) {
                session.group = current;
            }
            if (session.next >= session.moves.length && machine.queue.length === 0 && !machine.active) {
                session.state = "done";
            }
        }
        this.progressClock += dt;
        const finished = session.state === "done" || session.state === "stopped" || session.state === "error";
        if (this.progressClock >= 0.2 - CLOCK_EPSILON || finished) {
            this.progressClock = 0;
            const progress = this.progress();
            if (progress) {
                this.emit({ type: "progress", data: progress });
                this.lastProgress = progress;
            }
        }
        if (finished) {
            this.session = null;
            this.message(session.state === "done" ? "info" : "error", `job ${session.job.name}: ${session.state}`);
        }
    }

    // Connection.

    private requireConnected(): void {
        this.notGcode();
        if (!this.connected) {
            throw new ApiError(409, "not connected");
        }
    }

    /** A move or a position declaration: nothing else may move the head while the board is probed. */
    private requireMovable(): void {
        this.requireConnected();
        this.notOwned();
    }

    private refuseWhileProbing(): void {
        if (this.probing) {
            throw new ApiError(409, "the board is being probed");
        }
    }

    /**
     * Runs a machine action and turns its refusal into the backend's error
     * reply: a 400 that names the line the firmware refused.
     */
    private exchange(tx: string, action: () => void): void {
        this.requireConnected();
        this.line("tx", tx);
        try {
            action();
        } catch (error) {
            if (error instanceof MachineError) {
                this.line("rx", error.message);
                throw new ApiError(400, `'${tx}': ${error.message}`);
            }
            throw error;
        }
        this.line("rx", "ok");
    }

    /** A request that would change the machine under a run or probing that owns it. */
    private notOwned(): void {
        if (this.session) {
            throw new ApiError(409, "a job is running");
        }
        this.refuseWhileProbing();
        if (this.finding) {
            throw new ApiError(409, "the camera offset routine is running");
        }
        if (this.headSearch) {
            throw new ApiError(409, "a camera routine is moving the head");
        }
        if (this.pnpSession) {
            throw new ApiError(409, "the bottom camera routine is moving the head");
        }
    }

    /**
     * Takes back the height map's focus offset, keeping its heights: they
     * are focus axis positions in a frame that may have changed, and the
     * offset is what tied them to the frame in use.
     */
    private frameChanged(reason: string): void {
        this.frame += 1;
        const map = this.heightmap;
        if (!map || !map.focus_set) {
            return;
        }
        map.focus_set = false;
        this.message("info", `${reason}: focus here again before a run follows the height map`);
        this.emitHeightMap();
    }

    /** Takes back an offset set in a frame before this one; true when there was one. */
    private dropStaleFocus(): boolean {
        const map = this.heightmap;
        if (this.focusFrame === this.frame || !map || !map.focus_set) {
            return false;
        }
        map.focus_set = false;
        return true;
    }

    async ports(): Promise<Port[]> {
        const ports: Port[] = [
            {
                url: "/dev/serial/by-id/usb-spinny_spinny_laser_controller_mock-if00",
                device: "/dev/ttyACM0",
                description: "spinny laser controller (mock)",
                product: "spinny laser controller",
                manufacturer: "spinny",
                vid: 0x2e8a,
                pid: 0x000a,
                kind: "usb",
                spinny: true,
            },
            // A LumenPnP on Opulo's Marlin, as Linux lists its STM32 port.
            {
                url: "/dev/serial/by-id/usb-STMicroelectronics_MARLIN_OPULO_LUMEN_REV5_CDC_in_FS_Mode_2050335F4E30-if00",
                device: "/dev/ttyACM1",
                description: "MARLIN_OPULO_LUMEN_REV5 CDC in FS Mode",
                product: "MARLIN_OPULO_LUMEN_REV5 CDC in FS Mode",
                manufacturer: "STMicroelectronics",
                vid: 0x0483,
                pid: 0x5740,
                kind: "usb",
                spinny: false,
            },
            { url: "/dev/ttyS0", device: "/dev/ttyS0", description: "n/a", kind: "system", spinny: false },
        ];
        if (this.lastSocket) {
            ports.push({ url: this.lastSocket, device: this.lastSocket, description: "last used", kind: "last", spinny: false });
        }
        // The G-code machine each port is, by its file's url or words, and
        // the files whose own url no port is listed under.
        const machines = this.gcodeIds().map((id) => this.gcodeOf(id));
        for (const port of ports) {
            const names = [port.product, port.manufacturer, port.description, port.url, port.device].filter(Boolean).join(" ");
            const owner = machines.find((machine) => claims(machine, port.url, names) || claims(machine, port.device ?? "", names)) ?? null;
            port.machine = owner?.id ?? null;
            port.machine_name = owner?.name ?? null;
        }
        const listed = new Set(ports.flatMap((port) => [port.url, port.device ?? ""]));
        for (const machine of machines) {
            if (machine.url && !listed.has(machine.url)) {
                ports.push({ url: machine.url, device: machine.url, description: machine.name, kind: "machine", spinny: false, machine: machine.id, machine_name: machine.name });
            }
        }
        return ports;
    }

    /** The G-code machine file a port is: one whose url it is, or whose words its USB names hold; null for this project's firmware. */
    private claimant(url: string): string | null {
        return this.gcodeIds().find((id) => claims(this.gcodeOf(id), url, this.portNames(url))) ?? null;
    }

    /** The USB names of the mock's listed port at `url`. */
    private portNames(url: string): string {
        if (url.includes("LUMEN") || url === "/dev/ttyACM1") {
            return "MARLIN_OPULO_LUMEN_REV5 CDC in FS Mode STMicroelectronics";
        }
        if (url.includes("spinny") || url === "/dev/ttyACM0") {
            return "spinny laser controller";
        }
        return "";
    }

    async connect(url: string, machine: string | null = null): Promise<Snapshot> {
        if (!url) {
            throw new ApiError(400, "no port given");
        }
        if (machine !== null) {
            const document = this.machineRead(machine, this.machineText(machine)).document;
            if (document?.controller !== "gcode") {
                throw new ApiError(400, `${machine} is a machine on this project's firmware: connect to its board without naming a file`);
            }
            return this.gcodeConnect(url, machine);
        }
        const claimed = this.claimant(url);
        if (claimed !== null) {
            return this.gcodeConnect(url, claimed);
        }
        this.gcodeClose();
        if (url.startsWith("socket://")) {
            this.lastSocket = url;
        }
        this.connected = true;
        this.url = url;
        this.jogTracked = false;
        this.line("rx", `[spinny v${MOCK_VERSION} lines:${LINE_SLOTS} blocks:${PLANNER_BLOCKS}]`);
        this.message("info", `connected to ${url} (mock)`);
        // Whatever machine this is, its focus axis counts from where it was switched on.
        this.frameChanged("connected");
        const snapshot = this.snapshot();
        this.emit({ type: "state", data: snapshot });
        return snapshot;
    }

    /**
     * Closing the port ends a run as stopped, with a last progress for the
     * snapshots to carry, and the machine does what the firmware does when
     * its USB host goes away: a reset, so nothing keeps moving unattended.
     */
    async disconnect(): Promise<Snapshot> {
        if (this.gcodeId !== null) {
            this.gcodeClose();
            const snapshot = this.snapshot();
            this.emit({ type: "state", data: snapshot });
            return snapshot;
        }
        this.outbox = [];
        const session = this.session;
        if (session) {
            session.state = "stopped";
            this.serviceRun(0);
        }
        if (this.probing) {
            this.probeFinish(this.probing, "stopped", null);
        }
        this.machine.reset();
        this.connected = false;
        this.url = null;
        const snapshot = this.snapshot();
        this.emit({ type: "state", data: snapshot });
        return snapshot;
    }

    async state(): Promise<Snapshot> {
        return this.snapshot();
    }

    // Moving.

    /** A jog or goto feed the firmware will take, or none. */
    private checkFeed(feed: number | null): void {
        if (feed !== null && !(Number.isFinite(feed) && feed >= MIN_FEED)) {
            throw new ApiError(400, `feed must be at least ${formatG(MIN_FEED)} mm/min`);
        }
    }

    /**
     * Whether the backend would know where the next move starts: at rest,
     * or behind jogs it sent and tracked the end of. Anything else moving
     * the machine is on its way to an end nobody told it.
     */
    private startKnown(): boolean {
        const state = this.machine.state;
        if (state === "Jog" && this.jogTracked) {
            return true;
        }
        this.jogTracked = false;
        return state === "Idle" && this.outbox.length === 0;
    }

    /** Where the machine ends up once the outbox has been sent too. */
    private pendingEndpoint(): Joint {
        const last = this.outbox[this.outbox.length - 1];
        return last ? last.move.target : this.machine.endpoint();
    }

    private pendingZ(): number {
        for (let i = this.outbox.length - 1; i >= 0; i--) {
            const z = this.outbox[i]?.move.z;
            if (z !== undefined) {
                return z;
            }
        }
        return this.machine.endpointZ();
    }

    /**
     * The jog moves to a board point from where the queued motion ends. On
     * a cartesian machine a board point is one joint line in the frame of
     * the table's angle; on a polar one it is cut within the chord
     * tolerance and crosses the axis with a turn.
     */
    private boardMoves(target: Board, feed: number | null): Move[] {
        const start = this.pendingEndpoint();
        if (this.machine.cartesian()) {
            const joint = turned(target, -this.machine.frameAngle());
            return [{ kind: "jog", target: { r: joint.x, a: start.a }, z: joint.y, feed, power: 0, group: -1 }];
        }
        let from = start;
        return segmentBoardMove(start, target, this.tolerance).map((joint) => {
            const turn = Math.abs(from.r) < AXIS_EPSILON && Math.abs(joint.r) < AXIS_EPSILON && joint.a !== from.a;
            from = joint;
            return { kind: "jog", target: joint, turn, feed, power: 0, group: -1 };
        });
    }

    /** The board point the queued motion ends at. */
    private pendingBoard(): Board {
        return this.machine.headBoard(this.pendingEndpoint(), this.pendingZ());
    }

    /**
     * A board move is refused whole when any of its lines would be: sent a
     * line at a time, the ones inside the soft limit would run before the
     * refusal came back, and leave the head at the limit.
     */
    private checkReach(moves: Move[]): void {
        const rMax = this.machine.settings["r_max"] ?? 0;
        const zMax = this.machine.settings["z_max"] ?? 0;
        for (const move of moves) {
            if (rMax > 0 && Math.abs(move.target.r) > rMax + 1e-9) {
                throw new ApiError(400, `out of reach: R${move.target.r.toFixed(3)} is past the soft limit r_max=${formatG(rMax)}`);
            }
            if (move.z !== undefined && zMax > 0 && Math.abs(move.z) > zMax + 1e-9) {
                throw new ApiError(400, `out of reach: Z${move.z.toFixed(3)} is past the soft limit z_max=${formatG(zMax)}`);
            }
        }
    }

    private sendBoard(moves: Move[]): void {
        this.checkReach(moves);
        for (const move of moves) {
            this.send(formatMove(move), move);
        }
        this.jogTracked = true;
    }

    /** The height probing travels at: the head's, or the travel height when that is higher. */
    private probeTravel(h: number): number {
        return this.travel !== null ? Math.max(h, this.travel) : h;
    }

    /**
     * Up to the travel height before a goto goes across, as the backend
     * does: not without one or a focus axis, not for a goto that names the
     * height or moves nothing across, and not for a head already as high.
     */
    private travelRise(request: GotoRequest): void {
        const travel = this.travel;
        if (travel === null || !this.machine.hasFocusAxis()) {
            return;
        }
        const named = request as { r?: number; a?: number; h?: number; z?: number };
        if (named.h !== undefined) {
            return;
        }
        if (request.kind === "joint" && named.r === undefined && named.a === undefined && named.z === undefined) {
            return;
        }
        if (this.machine.endpointH() >= travel - 1e-6) {
            return;
        }
        this.exchange(`jogto H${gnum(travel, 4)}`, () => this.machine.jogTo(null, null, null, travel));
    }

    /** A joint line through the API; the tracked end follows the backend's rule for it. */
    private sendJoint(line: string, action: () => void, tracked: boolean): void {
        try {
            this.exchange(line, action);
        } catch (error) {
            this.jogTracked = false;
            throw error;
        }
        this.jogTracked = tracked;
    }

    async jog(request: JogRequest): Promise<void> {
        if (this.gcodeId !== null) {
            return this.gcodeJog(request);
        }
        this.requireMovable();
        const feed = request.feed ?? null;
        this.checkFeed(feed);
        const feedWord = feed ? ` F${gnum(feed)}` : "";
        const cartesian = this.machine.cartesian();
        if (request.kind === "joint") {
            const { dr, da, dh, dz } = request as { dr?: number; da?: number; dh?: number; dz?: number };
            if (dz !== undefined && !cartesian) {
                if (dr !== undefined || da !== undefined || dh !== undefined) {
                    throw new ApiError(400, "the cross slide moves on its own: dz cannot be sent with dr, da or dh");
                }
                if (dz === 0) {
                    throw new ApiError(400, "a cross slide jog needs a distance");
                }
                this.exchange(`jog Z${gnum(dz)}${feedWord}`, () => this.machine.slideJog(dz, feed));
                return;
            }
            // The backend's words: a relative jog leaves out an axis that does not move.
            const words = [
                dr ? `R${gnum(dr)}` : "",
                da ? `A${gnum(da, 4)}` : "",
                dh ? `H${gnum(dh, 4)}` : "",
                dz ? `Z${gnum(dz)}` : "",
            ].filter((w) => w !== "");
            if (words.length === 0) {
                throw new ApiError(400, "a joint move needs a radius, an angle, a focus height or a cross slide position");
            }
            // A relative jog ends where its start does, moved; a turn of a
            // cartesian table moves the frame that end is kept in, which a
            // plunger does not.
            const known = this.startKnown() && !(cartesian && da && !this.machine.dispensing());
            this.sendJoint(`jog ${words.join(" ")}${feedWord}`, () => this.machine.jog(dr ?? 0, da ?? 0, feed, dh ? dh : null, dz ? dz : null), known);
            return;
        }
        if (cartesian && !this.startKnown()) {
            throw new ApiError(409, "the table may still be turning: wait for the machine to stop before a board move");
        }
        const from = this.pendingBoard();
        this.sendBoard(this.boardMoves({ x: from.x + (request.dx ?? 0), y: from.y + (request.dy ?? 0) }, feed));
    }

    async goto(request: GotoRequest): Promise<void> {
        if (this.gcodeId !== null) {
            return this.gcodeGoto(request);
        }
        this.requireMovable();
        const feed = request.feed ?? null;
        this.checkFeed(feed);
        const feedWord = feed ? ` F${gnum(feed)}` : "";
        const cartesian = this.machine.cartesian();
        this.travelRise(request);
        if (request.kind === "joint") {
            const { r, a, h, z } = request as { r?: number; a?: number; h?: number; z?: number };
            if (z !== undefined && !cartesian) {
                if (r !== undefined || a !== undefined || h !== undefined) {
                    throw new ApiError(400, "the cross slide moves on its own: z cannot be sent with r, a or h");
                }
                this.exchange(`jogto Z${gnum(z)}${feedWord}`, () => this.machine.slideTo(z, feed));
                return;
            }
            const words = [
                r !== undefined ? `R${gnum(r)}` : "",
                a !== undefined ? `A${gnum(a, 4)}` : "",
                h !== undefined ? `H${gnum(h, 4)}` : "",
                z !== undefined ? `Z${gnum(z)}` : "",
            ].filter((w) => w !== "");
            if (words.length === 0) {
                throw new ApiError(400, "a joint move needs a radius, an angle, a focus height or a cross slide position");
            }
            const known = this.startKnown();
            // An axis left out stays where the queued jog ends, which is
            // known only when the start is; on a cartesian machine a goto
            // that turns the table moves the frame that end is kept in.
            const tracked = cartesian ? known && a === undefined : (r !== undefined && a !== undefined) || known;
            this.sendJoint(`jogto ${words.join(" ")}${feedWord}`, () => this.machine.jogTo(r ?? null, a ?? null, feed, h ?? null, z ?? null), tracked);
            return;
        }
        if (request.x === undefined && request.y === undefined) {
            throw new ApiError(400, "a board goto needs x and/or y");
        }
        const known = this.startKnown();
        if (cartesian && !known) {
            throw new ApiError(409, "the table may still be turning: wait for the machine to stop before a board move");
        }
        if ((request.x === undefined || request.y === undefined) && !known) {
            // The coordinate left out would be the one the head has on its
            // way somewhere, not the one it will stop at.
            throw new ApiError(400, "give both x and y: where the head will stop is not known");
        }
        const from = this.pendingBoard();
        this.sendBoard(this.boardMoves({ x: request.x ?? from.x, y: request.y ?? from.y }, feed));
    }

    async jogCancel(): Promise<void> {
        return this.realtime("cancel");
    }

    async setPosition(request: PositionRequest): Promise<void> {
        if (this.gcodeId !== null) {
            return this.gcodeSetPosition(request);
        }
        this.requireMovable();
        const words = [
            request.r !== undefined ? `R${gnum(request.r)}` : "",
            request.a !== undefined ? `A${gnum(request.a, 4)}` : "",
            request.h !== undefined ? `H${gnum(request.h, 4)}` : "",
        ].filter((w) => w !== "");
        if (words.length === 0 && request.z === undefined) {
            throw new ApiError(400, "give r, a, h and/or z");
        }
        this.jogTracked = false;
        try {
            if (words.length > 0) {
                const { r, a, h } = request;
                this.exchange(`set ${words.join(" ")}`, () => this.machine.setPosition({ r, a, h }));
            }
            if (request.z !== undefined) {
                // Z is declared on a line of its own, as the firmware wants it on a polar machine.
                const z = request.z;
                this.exchange(`set Z${gnum(z)}`, () => this.machine.setPosition({ z }));
            }
        } finally {
            // H renumbered moves the frame the map's heights are in, and R,
            // A or Z the board under them, whether or not a line was taken.
            this.frameChanged("the position was set");
        }
    }

    /** Motors on at any time; off only while nothing owns the machine, since the focus axis would sink with the rest. */
    async motors(enabled: boolean): Promise<void> {
        if (this.gcodeId !== null) {
            const device = this.gcodeIdle();
            const line = enabled ? device.motors_on : device.motors_off;
            if (!line) {
                throw new ApiError(400, `${device.name}'s file has no [gcode] motors_${enabled ? "on" : "off"} line`);
            }
            this.deviceLine(device, line);
            this.gcodeMotors = enabled;
            this.emit({ type: "state", data: this.snapshot() });
            return;
        }
        if (enabled) {
            this.exchange("enable", () => {
                this.machine.enabled = true;
            });
            return;
        }
        this.requireConnected();
        this.notOwned();
        this.exchange("disable", () => {
            this.machine.requireIdle();
            this.machine.enabled = false;
        });
    }

    async unlock(): Promise<void> {
        this.notGcode();
        this.exchange("unlock", () => this.machine.unlock());
    }

    async home(axes = ""): Promise<void> {
        if (this.gcodeId !== null) {
            const device = this.gcodeIdle();
            const letters = (axes.trim() === "" ? [] : axes.trim().split(/\s+/)).map((word) => {
                const index = ["r", "z", "h", "a"].indexOf(word.replace(/[+-]$/, "").toLowerCase());
                if (index < 0) {
                    throw new ApiError(400, `not an axis to home: '${word}'; give R, A, H or Z`);
                }
                return device.axes[[0, 1, 2, 3][index]!]!;
            });
            this.deviceLine(device, [device.home, ...letters].join(" "));
            this.deviceLink.homed = true;
            this.deviceHere(device);
            this.emit({ type: "state", data: this.snapshot() });
            this.emitPlacing();
            return;
        }
        const words = axes.trim() === "" ? [] : axes.trim().split(/\s+/);
        this.exchange(["home", ...words].join(" "), () => {
            for (const found of this.machine.home(axes)) {
                this.line("rx", found);
            }
        });
    }

    /** The big Stop, as the backend's stop_all: the run or probing stopped, else routines ended, motion cancelled and the output off. */
    async stopAll(): Promise<StopAnswer> {
        const stopped: string[] = [];
        if (this.gcodeId !== null) {
            if (this.deviceSession !== null) {
                stopped.push("the placing run");
            }
            if (this.deviceRoutine !== null) {
                stopped.push("the bottom camera routine");
            }
            if (this.topSession !== null) {
                stopped.push("the top camera routine");
            }
            await this.gcodeRealtime("reset");
            stopped.push("the machine");
            return { stopped, snapshot: this.snapshot() };
        }
        this.requireConnected();
        if (this.session && (this.session.state === "running" || this.session.state === "hold")) {
            await this.runStop();
            stopped.push("the run");
        } else if (this.probing) {
            await this.probeStop();
            stopped.push("probing");
        }
        if (stopped.length === 0) {
            if (this.finding) {
                await this.cameraAbort();
                stopped.push("the camera routine");
            }
            if (this.pnpSession) {
                await this.pnpAbort();
                stopped.push("the bottom camera routine");
            }
            await this.realtime("cancel");
            stopped.push("motion");
            await (this.machine.milling() ? this.spindleOff() : this.laserOff());
            stopped.push("the output");
        }
        return { stopped, snapshot: this.snapshot() };
    }

    async realtime(action: RealtimeAction): Promise<void> {
        if (this.gcodeId !== null) {
            return this.gcodeRealtime(action);
        }
        this.requireConnected();
        const machine = this.machine;
        switch (action) {
            case "hold":
                this.line("tx", "!");
                machine.hold();
                break;
            case "resume":
                this.line("tx", "~");
                machine.resume();
                break;
            case "reset": {
                // Probing is told first, so nothing more of it goes out after the byte.
                if (this.probing) {
                    this.probeFinish(this.probing, "stopped", "reset by the operator");
                }
                this.line("tx", "<0x18>");
                this.outbox = [];
                this.jogTracked = false;
                const alarmed = machine.reset();
                if (this.session) {
                    this.session.state = alarmed ? "error" : "stopped";
                }
                this.line("rx", "[MSG:reset]");
                // Only an alarm this reset raised is printed; one already raised stays as it was.
                if (alarmed) {
                    this.line("rx", "ALARM:1 reset while moving, position may be off");
                }
                this.line("rx", `[spinny v${MOCK_VERSION} lines:${LINE_SLOTS} blocks:${PLANNER_BLOCKS}]`);
                break;
            }
            case "cancel":
                this.line("tx", "<0x85>");
                this.outbox = [];
                this.jogTracked = false;
                machine.jogCancel();
                break;
            case "status":
                this.line("tx", "?");
                this.line("rx", statusLine(machine));
                break;
        }
        this.emit({ type: "state", data: this.snapshot() });
    }

    /**
     * A line typed at the console. A realtime byte typed on its own goes
     * out as one and answers nothing here, a hold or resume the run's own;
     * `laser off` or `spindle off` typed during a run stops it as its stop
     * does, since the lines behind would go on with the output stopped.
     */
    async command(line: string): Promise<string[]> {
        if (this.gcodeId !== null) {
            const device = this.gcodeOf(this.gcodeId);
            if (!/^[\x20-\x7e]*$/.test(line) || line.trim() === "") {
                throw new ApiError(400, "a line is one line of printable ASCII");
            }
            if (this.deviceSession !== null) {
                throw new ApiError(409, "a placing run is under way: its lines go out one at a time");
            }
            const reply = this.deviceLine(device, line.trim());
            this.emit({ type: "state", data: this.snapshot() });
            return reply;
        }
        this.requireConnected();
        const text = line.trim();
        if (text === "?") {
            await this.realtime("status");
            return [];
        }
        if (text === "!" || text === "~") {
            await this.realtime(text === "!" ? "hold" : "resume");
            return [];
        }
        const words = (text.split(";")[0] ?? "").toLowerCase().split(/\s+/).filter((word) => word !== "");
        const output = words.length === 2 && (words[0] === "laser" || words[0] === "spindle") && words[1] === "off";
        if (output && this.session) {
            await this.runStop();
            return [];
        }
        // As the backend guards them: lines that change the machine wait for
        // no run or probing, and a spindle start for no probing.
        const first = words[0] ?? "";
        const setting = text.startsWith("$") && (text.includes("=") || ["load", "defaults"].includes(text.slice(1).trim().toLowerCase()));
        if (setting || first === "set" || first === "disable") {
            this.notOwned();
        } else if (first === "spindle" && words[1] !== "off") {
            this.refuseWhileProbing();
        }
        // A typed line may move the head, so the end of the last jog is no start to plan from.
        this.jogTracked = false;
        this.line("tx", text);
        this.later = [];
        const replies = this.execute(text);
        for (const reply of [...replies, ...this.later]) {
            this.line("rx", reply);
        }
        this.later = [];
        if (replies[replies.length - 1] === "ok" && (first === "set" || (setting && reframes(text)))) {
            this.frameChanged("a position or setting changed at the console");
        }
        return replies;
    }

    /** A line of the firmware protocol against the mock machine, its words read as the firmware reads them. */
    private execute(text: string): string[] {
        const clean = text.replace(/;.*$/, "").trim();
        if (clean === "") {
            return ["ok"];
        }
        if (clean.startsWith("$")) {
            return this.executeSetting(clean.slice(1).trim());
        }
        const [keyword = "", ...tokens] = clean.split(/\s+/);
        try {
            return this.executeCommand(keyword.toLowerCase(), tokens);
        } catch (error) {
            if (error instanceof MachineError) {
                return [error.message];
            }
            throw error;
        }
    }

    private executeCommand(keyword: string, tokens: string[]): string[] {
        const machine = this.machine;
        const cartesian = machine.cartesian();
        const milling = machine.milling();
        /** The words of this line; a word the keyword does not take is refused. */
        const read = (allowed: string): Map<string, number> => {
            const words = readWords(tokens, allowed);
            if (words === null) {
                throw new MachineError(2, "bad word");
            }
            return words;
        };
        const needAxis = (words: Map<string, number>): void => {
            if (!["R", "A", "H", "Z"].some((key) => words.has(key))) {
                throw new MachineError(3, "missing word");
            }
        };
        const checkFeed = (words: Map<string, number>): void => {
            const feed = words.get("F");
            if (feed !== undefined && !(feed >= MIN_FEED)) {
                throw new MachineError(4, "out of range");
            }
        };
        const checkPowerWords = (words: Map<string, number>): void => {
            if ((words.get("S") ?? 0) < 0 || (words.get("M") ?? 0) < 0) {
                throw new MachineError(4, "out of range");
            }
        };
        const bare = (): void => {
            if (tokens.length > 0) {
                throw new MachineError(2, "bad word");
            }
        };
        /** Z is a joint on a cartesian machine and nothing on a polar one; A stays off `go` and `cut` on a cartesian one unless it is a dispenser's plunger. */
        const boardWords = (words: Map<string, number>): void => {
            if (words.has(cartesian && !machine.dispensing() ? "A" : "Z")) {
                throw new MachineError(2, "bad word");
            }
        };
        const get = (words: Map<string, number>, key: string): number | null => words.get(key) ?? null;
        switch (keyword) {
            case "go": {
                const words = read("RAHZ");
                needAxis(words);
                boardWords(words);
                machine.go(get(words, "R"), get(words, "A"), get(words, "H"), get(words, "Z"));
                return ["ok"];
            }
            case "cut": {
                const words = read("RAHZFSM");
                needAxis(words);
                checkFeed(words);
                checkPowerWords(words);
                boardWords(words);
                // A spindle's speed is its own command's, and a dispenser's
                // output is dark: an S or M here is a laser job sent to a
                // machine that has no beam.
                if (machine.darkOutput() && (words.has("S") || words.has("M"))) {
                    return ["error:2 bad word"];
                }
                machine.checkCut();
                // F and S are modal, but a reset forgets them: the first
                // cut after one must give F again. A dark output leaves S alone.
                const feed = get(words, "F") ?? machine.feed;
                const power = machine.darkOutput() ? 0 : get(words, "S") ?? machine.power;
                if (feed === null) {
                    return ["error:3 missing word"];
                }
                machine.cut(get(words, "R"), get(words, "A"), feed, power, get(words, "M") ?? 0, get(words, "H"), get(words, "Z"));
                machine.feed = feed;
                if (!milling) {
                    machine.power = power;
                }
                return ["ok"];
            }
            case "jog":
            case "jogto": {
                const words = read("RAHZF");
                needAxis(words);
                checkFeed(words);
                const absolute = keyword === "jogto";
                const z = get(words, "Z");
                if (z !== null && !cartesian) {
                    // The slide moves alone and only from rest.
                    if (words.has("R") || words.has("A") || words.has("H")) {
                        return ["error:2 bad word"];
                    }
                    if (absolute) {
                        machine.slideTo(z, get(words, "F"));
                    } else {
                        machine.slideJog(z, get(words, "F"));
                    }
                } else if (absolute) {
                    machine.jogTo(get(words, "R"), get(words, "A"), get(words, "F"), get(words, "H"), z);
                } else {
                    machine.jog(get(words, "R") ?? 0, get(words, "A") ?? 0, get(words, "F"), get(words, "H"), z);
                }
                return ["ok"];
            }
            case "probe": {
                const words = read("HF");
                const distance = get(words, "H");
                if (distance === null) {
                    return ["error:3 missing word"];
                }
                if (distance === 0) {
                    return ["error:4 out of range"];
                }
                checkFeed(words);
                return probeReplies(machine, distance, get(words, "F"));
            }
            case "dwell": {
                const words = read("TS");
                const t = get(words, "T");
                if (t === null) {
                    return ["error:3 missing word"];
                }
                checkPowerWords(words);
                if (t < 0 || t > DWELL_MAX_MS) {
                    return ["error:4 out of range"];
                }
                if (milling && words.has("S")) {
                    return ["error:2 bad word"];
                }
                machine.dwell(Math.floor(t + 0.5), get(words, "S") ?? 0);
                return ["ok"];
            }
            case "mode": {
                const [word, ...extra] = tokens;
                if (word === undefined) {
                    return ["error:3 missing word"];
                }
                const mode = word.toLowerCase();
                if (extra.length > 0 || (mode !== "dyn" && mode !== "const")) {
                    return ["error:2 bad word"];
                }
                machine.mode = mode;
                return ["ok"];
            }
            case "laser": {
                if ((tokens[0] ?? "").toLowerCase() === "off") {
                    if (tokens.length > 1) {
                        return ["error:2 bad word"];
                    }
                    machine.outputOff();
                    return ["ok"];
                }
                const words = read("ST");
                const power = get(words, "S");
                if (power === null) {
                    return ["error:3 missing word"];
                }
                checkPowerWords(words);
                const t = get(words, "T");
                if (t !== null && (t < 0 || t > LASER_MAX_MS)) {
                    return ["error:4 out of range"];
                }
                machine.beam(power, t === null ? 0 : Math.floor(t + 0.5));
                return ["ok"];
            }
            case "spindle": {
                if ((tokens[0] ?? "").toLowerCase() === "off") {
                    if (tokens.length > 1) {
                        return ["error:2 bad word"];
                    }
                    machine.spin(null);
                    return ["ok"];
                }
                const words = read("S");
                const speed = get(words, "S");
                if (speed === null) {
                    return ["error:3 missing word"];
                }
                checkPowerWords(words);
                machine.spin(speed);
                return ["ok"];
            }
            case "set": {
                const words = read("RAHZ");
                needAxis(words);
                const z = get(words, "Z");
                if (z !== null && !cartesian && (words.has("R") || words.has("A") || words.has("H"))) {
                    return ["error:2 bad word"];
                }
                const position: PositionRequest = {};
                for (const [key, name] of [["R", "r"], ["A", "a"], ["H", "h"], ["Z", "z"]] as const) {
                    const value = get(words, key);
                    if (value !== null) {
                        position[name] = value;
                    }
                }
                machine.setPosition(position);
                return ["ok"];
            }
            case "enable":
                bare();
                machine.enabled = true;
                return ["ok"];
            case "disable":
                bare();
                machine.requireIdle();
                machine.enabled = false;
                return ["ok"];
            case "unlock":
                bare();
                machine.unlock();
                return ["ok"];
            case "home":
                return [...machine.home(tokens.join(" ")), "ok"];
            case "diag":
                bare();
                // Answered at once; the board's counters follow the answer,
                // as the drivers' report does.
                this.later = ["[MSG:diag mock firmware: no board, no reset record]"];
                return ["ok"];
            case "version":
                bare();
                return [`[spinny v${MOCK_VERSION} lines:${LINE_SLOTS} blocks:${PLANNER_BLOCKS}]`, "ok"];
            case "status":
                bare();
                return [statusLine(machine), "ok"];
            case "help":
                bare();
                return [...HELP_LINES, "ok"];
            default:
                return ["error:1 unknown command"];
        }
    }

    private executeSetting(text: string): string[] {
        const machine = this.machine;
        if (text === "") {
            return [...Object.entries(machine.settings).map(([name, value]) => `${name}=${value}`), "ok"];
        }
        const eq = text.indexOf("=");
        if (eq < 0) {
            const command = text.toLowerCase();
            try {
                if (command === "save") {
                    machine.requireIdle();
                    machine.flash = { ...machine.settings };
                    return ["ok"];
                }
                if (command === "load" || command === "defaults") {
                    machine.requireIdle();
                    const wiring = Object.fromEntries(WIRING_SETTINGS.map((name) => [name, machine.settings[name] ?? 0]));
                    machine.adopt(command === "load" ? machine.flash : { ...DEFAULT_SETTINGS, ...wiring });
                    return ["ok"];
                }
            } catch (error) {
                return [error instanceof MachineError ? error.message : String(error)];
            }
            if (command === "tmc") {
                // Answered at once; the drivers' report follows as they answer
                // over their UART, microsteps read back from them.
                this.later = tmcReport(machine);
                return ["ok"];
            }
            const value = machine.settings[command];
            return value === undefined ? ["error:6 unknown setting"] : [`${command}=${value}`, "ok"];
        }
        const name = text.slice(0, eq).trim().toLowerCase();
        if (name === "") {
            return ["error:6 unknown setting"];
        }
        try {
            machine.requireIdle();
            if (!(name in DEFAULT_SETTINGS)) {
                return ["error:6 unknown setting"];
            }
            const value = settingValue(name, text.slice(eq + 1).trim());
            if (value === null) {
                return ["error:7 bad setting value"];
            }
            machine.setSetting(name, value);
            return ["ok"];
        } catch (error) {
            return [error instanceof MachineError ? error.message : "error:7 bad setting value"];
        }
    }

    // Laser.

    async laser(power: number, ms: number): Promise<void> {
        if (this.machine.milling()) {
            throw new ApiError(400, "the output drives a spindle ($spindle=1): use the spindle controls");
        }
        this.requireConnected();
        if (!(power >= 0)) {
            throw new ApiError(400, "power must be >= 0");
        }
        if (!(ms > 0)) {
            throw new ApiError(400, "ms must be > 0");
        }
        const t = Math.trunc(ms);
        this.exchange(`laser S${gnum(power)} T${t}`, () => this.machine.beam(power, t));
    }

    /**
     * Starts the spindle or changes its speed. A run starts and stops it
     * itself, and probing lowers the probe, which may be the tool itself,
     * onto the copper: it does not start during either.
     */
    async spindle(power: number): Promise<void> {
        this.notOwned();
        if (!this.machine.milling()) {
            throw new ApiError(400, "the output drives a laser ($spindle=0)");
        }
        if (!(Number.isFinite(power) && power >= 0)) {
            throw new ApiError(400, "power must be >= 0");
        }
        this.exchange(`spindle S${gnum(power)}`, () => this.machine.spin(power));
    }

    /** Stops the spindle, which on a laser machine is the beam. */
    async spindleOff(): Promise<void> {
        if (this.session) {
            throw new ApiError(409, "a job is running: stop it to stop the spindle");
        }
        if (this.machine.milling()) {
            this.exchange("spindle off", () => this.machine.spin(null));
        } else {
            this.exchange("laser off", () => this.machine.outputOff());
        }
    }

    /**
     * Beam off now. During a run the beam is the run's, and the button that
     * means that is the hold, which the run can resume; a run otherwise
     * under way, held say, is left as it is.
     */
    async laserOff(): Promise<void> {
        if (this.session?.state === "running") {
            await this.runHold();
            return;
        }
        if (this.session) {
            return;
        }
        this.exchange("laser off", () => this.machine.outputOff());
    }

    async mode(mode: Mode): Promise<void> {
        if (this.session) {
            throw new ApiError(409, "a job is running");
        }
        this.exchange(`mode ${mode}`, () => {
            this.machine.mode = mode;
        });
    }

    // Settings.

    async settings(): Promise<SettingsResponse> {
        if (this.gcodeId !== null) {
            // A G-code machine has none of the firmware's settings: its file and its controls.
            const document = this.machineRead(this.gcodeId, this.machineText(this.gcodeId)).document;
            return {
                values: {},
                schema: [],
                host: this.hostSettings(),
                machine: this.gcodeId,
                unsaved: [],
                controls_from: this.gcodeId,
                controls: document?.controls ?? defaultControls({ kinematics: "cartesian", tool: "nozzle", h_axis: true, r_max: 0, z_max: 0 }),
                controller: "gcode",
            };
        }
        const found = this.machineOf();
        // The controls: the file the settings are, else the file for this
        // kind of machine, else the defaults for what the settings say it is.
        const source = found ?? this.controlsFile();
        return {
            values: { ...this.machine.settings },
            schema: SETTINGS_SCHEMA,
            host: this.hostSettings(),
            machine: found?.id ?? null,
            unsaved: this.unsavedSettings(),
            controls_from: source?.id ?? null,
            controls: source?.controls ?? defaultControls(this.machine.profile()),
        };
    }

    /** The settings that differ from what flash holds: the mock keeps a copy of flash, which the backend can only follow by what it sent. */
    private unsavedSettings(): string[] {
        const { settings, flash } = this.machine;
        return Object.keys(settings).filter((name) => settings[name] !== flash[name]).sort();
    }

    /** The host's own settings as the settings response carries them. */
    private hostSettings(): HostSettings {
        return {
            tolerance: this.tolerance,
            clearance: this.clearance,
            travel: this.travel,
            spinup: this.spinup,
            speed_control: this.speedControl,
            gap: this.gap,
            retract: this.retract,
            output: this.output,
            extrude_rate: this.extrudeRate,
            dwell_ms: this.dwellMs,
        };
    }

    /** The machine files as they read now, by id, with what is wrong with the ones that do not. */
    private machineDocuments(): { documents: MachineDocument[]; problems: MachineProblem[] } {
        const documents: MachineDocument[] = [];
        const problems: MachineProblem[] = [];
        // In the backend's order: by file name, byte by byte, so "polar-laser-focus.toml" before "polar-laser.toml".
        const byFile = ([a]: [string, string], [b]: [string, string]): number => (`${a}.toml` < `${b}.toml` ? -1 : 1);
        for (const [id, text] of [...this.machineTexts.entries()].sort(byFile)) {
            try {
                documents.push(parseMachine(text, id));
            } catch (error) {
                problems.push({ id, problem: errorText(error) });
            }
        }
        return { documents, problems };
    }

    /** The machine file the live settings are, every one of them, or null. */
    private machineOf(): MachineDocument | null {
        return this.machineDocuments().documents.find((document) => matches(document, this.machine.settings)) ?? null;
    }

    /**
     * For settings that are no file's: the file last loaded when it describes
     * this kind of machine (a setting changed by hand does not change what
     * the machine is), else the one file that does, else null for the defaults.
     */
    private controlsFile(): MachineDocument | null {
        const profile = this.machine.profile();
        const kind = this.machineDocuments().documents.filter(
            (document) => document.kinematics === profile.kinematics && document.tool === profile.tool && document.focus === profile.h_axis,
        );
        return kind.find((document) => document.id === this.loaded) ?? (kind.length === 1 ? kind[0]! : null);
    }

    async machines(): Promise<MachinesResponse> {
        const { documents, problems } = this.machineDocuments();
        return {
            machines: documents.map((document) => machineSummaryOf(document)),
            current: this.gcodeId !== null ? this.gcodeId : this.connected ? this.machineOf()?.id ?? null : null,
            problems,
        };
    }

    private machineText(id: string): string {
        checkMachineId(id);
        const text = this.machineTexts.get(id);
        if (text === undefined) {
            throw new ApiError(404, `no machine file '${id}'`);
        }
        return text;
    }

    private machineRead(id: string, text: string): MachineCheck {
        try {
            return { document: parseMachine(text, id), problems: [] };
        } catch (error) {
            return { document: null, problems: [errorText(error)] };
        }
    }

    /** A file as written, with what it reads as or why it does not. */
    async machineFile(id: string): Promise<MachineResponse> {
        const text = this.machineText(id);
        return { ...this.machineRead(id, text), text };
    }

    async checkMachineFile(id: string, text: string): Promise<MachineCheck> {
        checkMachineId(id);
        return this.machineRead(id, text);
    }

    /** The text with the board's values written into it, not saved, as the backend reads it. */
    async machineFromBoard(id: string, text: string): Promise<MachineFromBoard> {
        checkMachineId(id);
        if (this.machineRead(id, text).document?.controller === "gcode") {
            throw new ApiError(400, "a G-code machine's file takes nothing from a board: its controller keeps its own settings");
        }
        this.requireConnected();
        let read: FromBoard;
        try {
            read = fromBoard(text, { ...this.machine.settings }, { ...this.hostSettings() }, (given) => parseMachine(given, id), `${id}.toml`);
        } catch (error) {
            throw new ApiError(400, errorText(error));
        }
        return { ...this.machineRead(id, read.text), text: read.text, changes: read.changes, left: read.left };
    }

    /** Kept once it reads as a machine, as the backend writes the file. */
    async saveMachineFile(id: string, text: string): Promise<MachineResponse> {
        checkMachineId(id);
        const kept = text.endsWith("\n") ? text : text + "\n";
        const read = this.machineRead(id, kept);
        if (!read.document) {
            throw new ApiError(400, read.problems[0] ?? "the text does not read");
        }
        this.machineTexts.set(id, kept);
        return { ...read, text: kept };
    }

    async deleteMachineFile(id: string): Promise<void> {
        this.machineText(id);
        if (this.gcodeId === id) {
            throw new ApiError(409, "disconnect the machine before removing its file");
        }
        this.machineTexts.delete(id);
    }

    /** A machine file's every setting, as the backend writes them: all or nothing, then saved to flash when asked. */
    async applyMachine(id: string, save = false): Promise<SettingsResponse> {
        const read = this.machineRead(id, this.machineText(id));
        if (!read.document) {
            throw new ApiError(404, `no machine file '${id}'`);
        }
        if (read.document.controller === "gcode") {
            throw new ApiError(400, `${read.document.name} is a G-code machine: its controller keeps its own settings; connect to it from the top bar`);
        }
        await this.updateSettings({ values: { ...read.document.settings }, host: { tolerance: this.tolerance, ...read.document.host } });
        this.loaded = id;
        // A load puts the file's camera into the backend's camera settings;
        // a running camera goes on with the old device until restarted.
        this.cameraConfig = { ...read.document.camera, offset: [read.document.camera.offset[0], read.document.camera.offset[1]] };
        this.emitCamera();
        if (save) {
            await this.saveSettings();
        }
        return this.settings();
    }

    /**
     * The machine's settings and the host's own, all or nothing: every entry
     * is checked before anything goes out, a value the machine still
     * refuses has the ones sent before it put back, and the host's values
     * are stored only once the machine's part went through.
     */
    async updateSettings(patch: SettingsUpdate): Promise<void> {
        const host = patch.host;
        let tolerance: number | null = null;
        if (host && host.tolerance !== undefined) {
            if (typeof host.tolerance !== "number" || Number.isNaN(host.tolerance)) {
                throw new ApiError(400, "tolerance must be a number");
            }
            if (!(Number.isFinite(host.tolerance) && host.tolerance > 0 && host.tolerance <= MAX_TOLERANCE)) {
                throw new ApiError(400, `tolerance must be above 0 and at most ${formatG(MAX_TOLERANCE)} mm`);
            }
            tolerance = host.tolerance;
        }
        const clearance = host?.clearance ?? this.clearance;
        const spinup = host?.spinup ?? this.spinup;
        // The travel height: a number, or null to turn it off.
        const travel = host && "travel" in host ? host.travel ?? null : this.travel;
        if (travel !== null && !(typeof travel === "number" && Number.isFinite(travel) && Math.abs(travel) <= TRAVEL_LIMIT)) {
            throw new ApiError(400, `the travel height must be -${TRAVEL_LIMIT} to ${TRAVEL_LIMIT} mm, or none`);
        }
        if (!(Number.isFinite(clearance) && clearance > 0 && clearance <= 100)) {
            throw new ApiError(400, "the clearance must be above 0 and at most 100 mm");
        }
        if (!(Number.isFinite(spinup) && spinup >= 0 && spinup <= 600)) {
            throw new ApiError(400, "the spin-up must be 0 to 600 s");
        }
        const gap = host?.gap ?? this.gap;
        const retract = host?.retract ?? this.retract;
        const output = host?.output ?? this.output;
        const extrudeRate = host?.extrude_rate ?? this.extrudeRate;
        const dwellMs = host?.dwell_ms ?? this.dwellMs;
        let speedControl = this.speedControl;
        if (host && host.speed_control !== undefined) {
            const flag: unknown = host.speed_control;
            if (!(typeof flag === "boolean" || (typeof flag === "number" && Number.isFinite(flag)))) {
                throw new ApiError(400, "speed_control must be true or false");
            }
            speedControl = Boolean(flag);
        }
        if (!(Number.isFinite(gap) && gap > 0 && gap <= 10)) {
            throw new ApiError(400, "the gap must be above 0 and at most 10 mm");
        }
        if (!(Number.isFinite(retract) && retract >= 0 && retract <= 50)) {
            throw new ApiError(400, "the retract must be 0 to 50 mm");
        }
        if (!(Number.isFinite(output) && output > 0 && output <= 100000)) {
            throw new ApiError(400, "the output must be above 0 and at most 100000 mm^3/mm");
        }
        if (!(Number.isFinite(extrudeRate) && extrudeRate > 0 && extrudeRate <= 10000)) {
            throw new ApiError(400, "the extrude rate must be above 0 and at most 10000 mm/min");
        }
        if (!(Number.isInteger(dwellMs) && dwellMs >= 0 && dwellMs <= 60000)) {
            throw new ApiError(400, "the dwell must be a whole number of ms from 0 to 60000");
        }
        const values = Object.entries(patch.values ?? {});
        if (values.length > 0) {
            this.writeMachineSettings(values);
        }
        if (tolerance !== null) {
            this.tolerance = tolerance;
        }
        this.clearance = clearance;
        this.spinup = spinup;
        this.speedControl = speedControl;
        this.travel = travel;
        this.gap = gap;
        this.retract = retract;
        this.output = output;
        this.extrudeRate = extrudeRate;
        this.dwellMs = dwellMs;
        if (values.length > 0 || tolerance !== null) {
            for (const job of this.jobStore.values()) {
                job.stats = computeStats(job.groups, this.limits());
            }
        }
    }

    /** The machine's part of a settings write: refused while a run or probing owns the machine. */
    private writeMachineSettings(values: [string, number][]): void {
        this.requireConnected();
        this.notOwned();
        const current = this.machine.settings;
        const texts: [string, string][] = [];
        for (const [name, value] of values) {
            if (!(name in current)) {
                throw new ApiError(400, `unknown setting '${name}'`);
            }
            if (typeof value !== "number" || !Number.isFinite(value)) {
                throw new ApiError(400, `${name} must be a number`);
            }
            // Only a whole number can be meant for a whole number setting,
            // and those go past the float bound: an idle time in ms, say.
            const whole = Number.isInteger(value);
            if (Math.abs(value) > (whole ? INT_SETTING_MAX : SETTING_MAX)) {
                throw new ApiError(400, `${name} must be within ${whole ? String(INT_SETTING_MAX) : formatG(SETTING_MAX)}`);
            }
            // As the backend writes a setting: a whole number as it is, others to six decimals.
            texts.push([name, gnum(value, 6)]);
        }
        // The firmware checks s_min <= s_max on every line, so a write that
        // lowers s_max under the s_min in force sends its s_min first.
        const sMax = texts.find(([name]) => name === "s_max");
        const sMin = texts.findIndex(([name]) => name === "s_min");
        if (sMax && sMin >= 0 && Number(sMax[1]) < (current["s_min"] ?? 0)) {
            texts.unshift(...texts.splice(sMin, 1));
        }
        const applied: [string, number][] = [];
        try {
            for (const [name, text] of texts) {
                const before = current[name] ?? 0;
                if (Number(text) === before) {
                    continue;
                }
                this.exchange(`$${name}=${text}`, () => {
                    this.machine.requireIdle();
                    this.machine.setSetting(name, Number(text));
                });
                applied.push([name, before]);
            }
        } catch (error) {
            // Whatever went before is put back, last first, so the board
            // steps back through states it took once; a value that cannot
            // be is skipped for the next.
            for (const [name, before] of [...applied].reverse()) {
                try {
                    this.exchange(`$${name}=${gnum(before, 6)}`, () => this.machine.setSetting(name, before));
                } catch {
                    continue;
                }
            }
            throw error;
        } finally {
            // A jog end tracked in one frame means nothing in another.
            this.jogTracked = false;
            if (applied.some(([name]) => FRAME_SETTINGS.has(name))) {
                this.frameChanged("a setting that scales or turns the axes changed");
            }
        }
    }

    async saveSettings(): Promise<void> {
        this.exchange("$save", () => {
            this.machine.requireIdle();
            this.machine.flash = { ...this.machine.settings };
        });
        this.message("info", "settings written to flash (mock)");
    }

    /** The rates a job is priced at, held to what the step generator pulses as the backend's are. */
    private limits(): { rRate: number; aRate: number; tolerance: number } {
        const s = this.machine.settings;
        const stepUs = s["step_us"] ?? 2;
        return {
            rRate: cappedRate(s["r_rate"] ?? 560, s["r_steps"] ?? 0, stepUs),
            aRate: cappedRate(s["a_rate"] ?? 400, s["a_steps"] ?? 0, stepUs),
            tolerance: this.tolerance,
        };
    }

    // Jobs.

    private seedDemo(): void {
        const placed = placeJob(demoCoupon(), "center", { x: 0, y: 14 });
        const id = this.newId();
        const groups = placed.groups.map((group) => ({ label: group.label, power: 500, min_power: 0, speed: 400, passes: 1, enabled: true, paths: group.paths }));
        const job: Job = {
            id,
            name: "demo coupon",
            source: "gerber",
            spot: 0.1,
            offset: { x: 0, y: 14 },
            rotation: 0,
            pads: placed.pads,
            holes: placed.holes,
            // A gerber keeps no board file for the camera to look for.
            design: { shift: placed.shift, rotation: 0, board: false },
            groups,
            outline: placed.outline,
            copper: placed.copper,
            stats: computeStats(groups, this.limits()),
        };
        this.jobStore.set(id, job);
        this.order.push(id);
    }

    /** The jobs' small drawings, each with the key it was drawn for. */
    private readonly thumbs = new Map<string, { key: string; url: string }>();

    private newId(): string {
        const id = (this.nextId++).toString(16).padStart(4, "0");
        return id;
    }

    // CAM profiles.

    async camProfiles(): Promise<CamProfilesResponse> {
        const profiles: CamProfilesResponse["profiles"] = [];
        const problems: string[] = [];
        for (const [id, text] of [...this.camTexts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
            try {
                profiles.push(summaryOf(parseProfile(text, id)));
            } catch (error) {
                problems.push(errorText(error));
            }
        }
        return { profiles, problems };
    }

    private camText(id: string): string {
        checkProfileId(id);
        const text = this.camTexts.get(id);
        if (text === undefined) {
            throw new ApiError(404, `no profile '${id}'`);
        }
        return text;
    }

    private camDocument(id: string, text: string): CamProfileResponse {
        try {
            return { document: parseProfile(text, id), text };
        } catch (error) {
            throw new ApiError(400, errorText(error));
        }
    }

    async camProfile(id: string): Promise<CamProfileResponse> {
        return this.camDocument(id, this.camText(id));
    }

    /** Kept once it reads as a profile, as the backend writes the file. */
    async saveCamProfile(id: string, text: string): Promise<CamProfileResponse> {
        checkProfileId(id);
        const kept = text.endsWith("\n") ? text : text + "\n";
        const response = this.camDocument(id, kept);
        this.camTexts.set(id, kept);
        return response;
    }

    async patchCamProfile(id: string, path: CamPath, value: CamValue): Promise<CamProfileResponse> {
        const text = this.camText(id);
        let changed: string;
        try {
            changed = setValue(text, path, value);
        } catch (error) {
            throw new ApiError(400, errorText(error));
        }
        return this.saveCamProfile(id, changed);
    }

    async deleteCamProfile(id: string): Promise<void> {
        this.camText(id);
        this.camTexts.delete(id);
    }

    /** The first design file through the profile; a board's siblings are not read here. */
    async camJob(id: string, files: File[], name?: string): Promise<CamJobResponse> {
        const profile = this.camDocument(id, this.camText(id)).document;
        const design = files.find((file) => !/\.drl$/i.test(file.name) && !/Edge[._-]?Cuts/i.test(file.name)) ?? files[0];
        if (!design) {
            throw new ApiError(400, "the upload holds no file");
        }
        let built: ReturnType<typeof buildCamJob>;
        try {
            const jobName = name?.trim() || design.name.replace(/\.[^.]+$/, "");
            built = /\.stl$/i.test(design.name)
                ? buildModelJob(this.newId(), profile, jobName, design.name, new Uint8Array(await design.arrayBuffer()))
                : buildCamJob(this.newId(), profile, jobName, design.name, await design.text(), this.limits());
        } catch (error) {
            throw new ApiError(400, errorText(error));
        }
        this.jobStore.set(built.job.id, built.job);
        this.order.push(built.job.id);
        const notes = [...built.notes, ...files.filter((file) => file !== design).map((file) => `${file.name} is not read by the mock`)];
        return { job: built.job, notes };
    }

    async camGcode(id: string, jobId: string): Promise<CamGcodeResponse> {
        const profile = this.camDocument(id, this.camText(id)).document;
        const job = this.requireJob(jobId);
        try {
            return camGcode(profile, job);
        } catch (error) {
            throw new ApiError(400, errorText(error));
        }
    }

    async uploadJob(file: File, options: UploadOptions): Promise<Job> {
        const text = await file.text();
        let built: ReturnType<typeof buildJob>;
        try {
            built = buildJob(this.newId(), file.name, text, options, this.limits(), this.machine.milling());
        } catch (error) {
            throw new ApiError(400, errorText(error));
        }
        this.jobStore.set(built.job.id, built.job);
        this.order.push(built.job.id);
        if (built.job.design) {
            this.uploads.set(built.job.id, { name: file.name, text, options: { ...options } });
            built.job.recipe = { file: file.name, options: { ...options } };
        }
        if (built.note) {
            this.message("info", built.note);
        }
        return built.job;
    }

    async replaceJob(id: string, data: Job): Promise<Job> {
        const old = this.requireJob(id);
        if (this.session && this.session.job.id === id) {
            throw new ApiError(409, "the job is running");
        }
        // A joint-space group's paths are only its drawing: one whose joints
        // changed comes without them, to be drawn again from the joints the
        // run streams; one whose joints are as they were keeps the drawing
        // sent, which a centering burn shown as burnt makes on purpose.
        const given = data as unknown as Record<string, unknown>;
        const body = !Array.isArray(given["groups"]) ? given : {
            ...given,
            groups: given["groups"].map((raw: unknown, index: number) => {
                const group = raw as Record<string, unknown> | null;
                const joints = group?.["joints"];
                if (!Array.isArray(joints) || joints.length === 0 || JSON.stringify(joints) === JSON.stringify(old.groups[index]?.joints ?? [])) {
                    return raw;
                }
                return { ...group, paths: [] };
            }),
        };
        let made: Job;
        try {
            made = jobFromJson(id, old.name, body, this.limits());
        } catch (error) {
            throw new ApiError(400, errorText(error));
        }
        // The source left out stays the old job's; anything else left out
        // takes a new job's default, as the backend has it.
        made.source = typeof given["source"] === "string" ? given["source"] : old.source;
        made.icon = given["icon"] === undefined ? old.icon ?? null : (given["icon"] as JobIcon | null);
        const iconRefused = iconProblem(made.icon);
        if (iconRefused !== null) {
            throw new ApiError(400, iconRefused);
        }
        made.layer = given["layer"] === undefined ? null : (given["layer"] as string | null);
        made.recipe = given["recipe"] === undefined ? null : (given["recipe"] as Job["recipe"]);
        // A recipe makes the groups again as the file or operations make
        // them, carrying settings by label but for its numbers: it stays
        // only while the groups cut what the old job's did under those
        // labels. A joint-space group's paths are only its drawing.
        const cuts = (job: Job): string => JSON.stringify(job.groups.map((group) => [
            labelStem(group.label), group.joints ?? [], group.moves ?? [], group.areas ?? [], (group.joints?.length ?? 0) > 0 ? [] : group.paths,
        ]));
        if (made.recipe && cuts(made) !== cuts(old)) {
            made.recipe = null;
        }
        if (made.design && old.design) {
            made.design.board = old.design.board;
        }
        this.jobStore.set(id, made);
        return structuredClone(made);
    }

    async combineJobs(ids: string[], name: string | null = null): Promise<Job> {
        if (ids.length < 2 || ids.length > 50) {
            throw new ApiError(422, "combine 2 to 50 jobs");
        }
        const jobs = ids.map((id) => {
            const job = this.jobStore.get(id);
            if (!job) {
                throw new ApiError(404, `no job '${id}'`);
            }
            return job;
        });
        const tools = [...new Set(jobs.flatMap((job) => job.groups.map((group) => group.tool).filter((tool): tool is NonNullable<typeof tool> => !!tool)))].sort();
        if (tools.length > 1) {
            throw new ApiError(400, `the jobs cut with different tools (${tools.join(", ")}): a job runs on one machine`);
        }
        // A group that names no tool is for a beam or a bit, which a
        // dispenser does not have: its dots and such paths run on no one machine.
        const cuts = (group: Job["groups"][number]): boolean => group.paths.length > 0 || (group.joints?.length ?? 0) > 0 || (group.moves?.length ?? 0) > 0;
        if (tools.length === 1 && tools[0] === "dispenser" && jobs.some((job) => job.groups.some((group) => !group.tool && cuts(group)))) {
            throw new ApiError(400, "the jobs mix a dispenser's dots with paths for a beam or a bit: a job runs on one machine");
        }
        const names = jobs.map((job) => job.name);
        const layers = new Set(jobs.map((job) => job.layer ?? null));
        const groups = jobs.flatMap((job) => job.groups.map((group) => ({ ...structuredClone(group), label: `${job.name}: ${group.label}` })));
        const made: Job = {
            id: this.newId(),
            name: (name ?? "").trim() || (names.length <= 3 ? names.join(" + ") : `${names[0]!} and ${names.length - 1} more`),
            source: "combined",
            layer: layers.size === 1 ? [...layers][0]! : null,
            spot: jobs[0]!.spot,
            offset: { x: 0, y: 0 },
            rotation: 0,
            groups,
            outline: jobs.flatMap((job) => structuredClone(job.outline)),
            copper: jobs.flatMap((job) => structuredClone(job.copper)),
            pads: jobs.flatMap((job) => structuredClone(job.pads ?? [])),
            holes: jobs.flatMap((job) => structuredClone(job.holes ?? [])),
            design: null,
            recipe: null,
            stats: computeStats(groups, this.limits()),
        };
        this.jobStore.set(made.id, made);
        this.order.push(made.id);
        return structuredClone(made);
    }

    /** The job's small drawing as a data address, drawn again only when its key changes. */
    jobThumbUrl(summary: JobSummary): string {
        const key = thumbKey(summary);
        const kept = this.thumbs.get(summary.id);
        if (kept && kept.key === key) {
            return kept.url;
        }
        const job = this.jobStore.get(summary.id);
        const url = svgUrl(job ? thumbnail(job) : "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
        this.thumbs.set(summary.id, { key, url });
        return url;
    }

    async setJobWidth(id: string, width: number): Promise<Job> {
        const job = this.requireJob(id);
        if (this.session && this.session.job.id === id) {
            throw new ApiError(409, "the job is running");
        }
        if (!(Number.isFinite(width) && width > 0 && width <= 1000)) {
            throw new ApiError(400, "the width must be above 0 and at most 1000 mm");
        }
        const made = job.recipe != null || job.source === "kicad" || job.source === "gerber" || job.source === "stl"
            || job.copper.length > 0 || job.groups.some((g) => g.tool)
            ? this.remade(job, width)
            : { ...structuredClone(job), spot: width };
        made.stats = computeStats(made.groups, this.limits());
        this.jobStore.set(id, made);
        return made;
    }

    async setJobMargin(id: string, margin: number): Promise<Job> {
        const job = this.requireJob(id);
        if (this.session && this.session.job.id === id) {
            throw new ApiError(409, "the job is running");
        }
        if (!job.recipe?.file || job.recipe.options?.["mode"] !== "stencil") {
            throw new ApiError(400, `${job.name} is not a stencil: a margin is for a board imported with mode stencil`);
        }
        let made: Job | null;
        try {
            made = this.remadeUpload(job, { margin });
        } catch (error) {
            throw new ApiError(400, errorText(error));
        }
        if (!made) {
            throw new ApiError(400, `the file ${job.name} was imported from is no longer kept: import it again with the new margin`);
        }
        made.stats = computeStats(made.groups, this.limits());
        this.jobStore.set(id, made);
        return made;
    }

    /** The job made again from its recipe for another width, or the refusal. */
    private remade(job: Job, width: number): Job {
        try {
            if (recipeOps(job.recipe).length > 0) {
                return remakeMill(job, width, this.limits());
            }
            const made = this.remadeUpload(job, { spot: width });
            if (made) {
                return made;
            }
        } catch (error) {
            throw new ApiError(400, errorText(error));
        }
        if (job.recipe?.file) {
            throw new ApiError(400, `the file ${job.name} was imported from is no longer kept: import it again with the new width`);
        }
        // A recipe with neither a file nor operations makes nothing again:
        // the width is the number alone, as the backend gives it.
        if (job.recipe) {
            return { ...structuredClone(job), spot: width };
        }
        throw new ApiError(400, `${job.name}'s paths were made for ${formatG(job.spot)} mm and nothing is kept to make them again: import it again with the new width`);
    }

    /**
     * A board upload made again from its kept file with the options it was
     * last made with and `changes`, put where the job is now with its
     * groups' settings kept; null when nothing is kept to make it from.
     */
    private remadeUpload(job: Job, changes: Partial<UploadOptions>): Job | null {
        const upload = this.uploads.get(job.id);
        if (!job.recipe?.file || !upload) {
            return null;
        }
        const options: UploadOptions = { ...upload.options, ...(job.recipe.options as UploadOptions | null | undefined), ...changes };
        const made = buildJob(job.id, upload.name, upload.text, options, this.limits(), this.machine.milling()).job;
        if (job.design && made.design) {
            moveJob(made, job.design.rotation - made.design.rotation, 0, 0);
            moveJob(made, 0, job.design.shift[0] - made.design.shift[0], job.design.shift[1] - made.design.shift[1]);
            made.design = { ...job.design };
        }
        carrySettings(job.groups, made.groups);
        made.name = job.name;
        made.icon = job.icon ?? null;
        made.offset = { ...job.offset };
        made.rotation = job.rotation ?? 0;
        made.recipe = { file: upload.name, options: { ...options } };
        return made;
    }

    async planMill(body: MillJobRequest): Promise<MillResponse> {
        return this.millResponse(body, false);
    }

    async makeMill(body: MillJobRequest): Promise<MillResponse> {
        return this.millResponse(body, true);
    }

    /** The operations as a job, stored when `keep`, in place of the Plot page job `job` names when it does. */
    private millResponse(body: MillJobRequest, keep: boolean): MillResponse {
        const ops = body.ops.map((op): MillOperation => ({ ...defaultOperation(op.kind), ...op }));
        if (ops.length === 0 || ops.length > MAX_OPERATIONS) {
            throw new ApiError(422, `a job holds 1 to ${MAX_OPERATIONS} operations`);
        }
        const only = ops[0]!;
        if (ops.length === 1 && only.kind === "holes" && !only.name && !body.name && (only.holes ?? null) === null) {
            const source = this.jobStore.get(only.job ?? "");
            if (source) {
                ops[0] = { ...only, name: `${source.name} holes` };
            }
        }
        let target: Job | null = null;
        if (body.job) {
            target = this.jobStore.get(body.job) ?? null;
            if (!target) {
                throw new ApiError(404, `no job '${body.job}'`);
            }
            if (recipeOps(target.recipe).length === 0) {
                throw new ApiError(400, `${target.name} was not made on the Plot page: its operations cannot be changed there`);
            }
            if (keep && this.session && this.session.job.id === target.id) {
                throw new ApiError(409, "the job is running");
            }
        }
        // The job whose frame the operations are typed in: the one they
        // replace, or the one a new job is put as.
        let where = target;
        if (!target && body.like) {
            where = this.jobStore.get(body.like) ?? null;
            if (!where) {
                throw new ApiError(404, `no job '${body.like}'`);
            }
        }
        const frame = where;
        const holesOf = (op: MillOperation): HolePoint[] => {
            const source = this.jobStore.get(op.job ?? "");
            if (!source) {
                throw new ApiError(404, `no job '${op.job ?? ""}' to take holes from`);
            }
            // The board job's holes are where it is now, on the board; the
            // operations are typed from before the frame job's move, which
            // is applied to everything built.
            return frame ? unplaced(source.holes ?? [], frame) : [...(source.holes ?? [])];
        };
        const name = body.name !== undefined && body.name !== null ? body.name : ops.length === 1 ? ops[0]!.name ?? null : null;
        let made: MillResponse;
        try {
            made = buildMillJob("", ops, holesOf, this.limits(), name);
        } catch (error) {
            throw error instanceof ApiError ? error : new ApiError(400, errorText(error));
        }
        if (target) {
            // The settings made on the Jobs page stay with the groups.
            carryJobSettings(target, made.job);
            placed(made.job, target);
            made.job.stats = computeStats(made.job.groups, this.limits());
        } else if (frame) {
            movedAs(made.job, frame);
            made.job.stats = computeStats(made.job.groups, this.limits());
        }
        if (keep) {
            if (target) {
                this.jobStore.set(target.id, made.job);
            } else {
                made.job.id = this.newId();
                this.jobStore.set(made.job.id, made.job);
                this.order.push(made.job.id);
            }
        }
        return made;
    }

    async markers(): Promise<Marker[]> {
        return this.markerList.map((marker) => ({ ...marker }));
    }

    async setMarkers(markers: Marker[]): Promise<Marker[]> {
        const names = new Set<string>();
        const kept: Marker[] = [];
        if (markers.length > 200) {
            throw new ApiError(400, "at most 200 markers");
        }
        for (const marker of markers) {
            const name = marker.name.trim();
            if (name === "" || name.length > 40) {
                throw new ApiError(400, "a marker's name is 1 to 40 characters");
            }
            if (names.has(name)) {
                throw new ApiError(400, `two markers are named '${name}'`);
            }
            if (![marker.x, marker.y].every((v) => Number.isFinite(v) && Math.abs(v) <= MAX_VALUE)) {
                throw new ApiError(400, `marker '${name}' must be within ${MAX_VALUE_TEXT} mm`);
            }
            names.add(name);
            kept.push({ name, x: marker.x, y: marker.y });
        }
        this.markerList = kept;
        this.emit({ type: "markers", data: { markers: kept.map((marker) => ({ ...marker })) } });
        return this.markers();
    }

    async todo(): Promise<TodoList> {
        return this.todoList.get();
    }

    async setTodo(items: TodoItem[], revision: number | null): Promise<TodoList> {
        return this.todoList.put(items, revision);
    }

    async saveReport(report: BugReport): Promise<ReportAnswer> {
        return this.reportDesk.save(report);
    }

    async reportSettings(): Promise<ReportSettings> {
        return this.reportDesk.settings();
    }

    async setReportLink(link: string): Promise<ReportSettings> {
        return this.reportDesk.setLink(link);
    }

    async plugins(): Promise<PluginInfo[]> {
        return this.pluginShelf.list();
    }

    async plugin(id: string): Promise<PluginWithSource> {
        return this.pluginShelf.read(id);
    }

    async setPluginEnabled(id: string, enabled: boolean, hash: string | null): Promise<PluginInfo> {
        return this.pluginShelf.setEnabled(id, enabled, hash);
    }

    async deletePlugin(id: string): Promise<void> {
        this.pluginShelf.delete(id);
    }

    pluginModuleUrl(info: PluginInfo): string {
        return this.pluginShelf.moduleUrl(info);
    }

    async centerJob(request: CenterRequest): Promise<CenterResponse> {
        if (this.machine.cartesian() || this.machine.milling()) {
            throw new ApiError(400, "the centering test is a burn on the polar laser machine ($cartesian=0, $spindle=0)");
        }
        const sMax = this.machine.settings["s_max"] ?? 0;
        let built: CenterResponse;
        try {
            built = centerJob(this.newId(), request, this.limits(), sMax > 0 ? sMax : null);
        } catch (error) {
            throw new ApiError(400, errorText(error));
        }
        this.jobStore.set(built.job.id, built.job);
        this.order.push(built.job.id);
        return built;
    }

    // The mock plays an installed release, 0.1.0 for x86_64-linux, which
    // GitHub has 0.2.0 newer than, and the pre-release 0.3.0rc1 newer
    // still, as spinny_web.update answers: a check finds the one followed,
    // an update downloads, then is done at the next look.
    private updating: UpdateState = {
        kind: "release",
        version: "0.1.0",
        platform: "x86_64-linux",
        root: "/opt/spinny/spinny-0.1.0-x86_64-linux",
        link: "/opt/spinny/spinny",
        latest: null,
        status: null,
        checked: null,
        state: "idle",
        done: 0,
        total: 0,
        error: null,
        installed: null,
        previous: null,
        prereleases: false,
    };

    async updatePrereleases(follow: boolean): Promise<UpdateState> {
        if (this.updating.state === "downloading") {
            throw new ApiError(400, "an update is under way");
        }
        if (follow !== this.updating.prereleases) {
            this.updating = { ...this.updating, prereleases: follow, latest: null, status: null, checked: null, error: null };
        }
        return { ...this.updating };
    }

    async updateState(): Promise<UpdateState> {
        if (this.updating.state === "downloading") {
            const name = this.updating.latest!.archive!.replace(/\.tar\.gz$/, "");
            this.updating = { ...this.updating, state: "done", done: this.updating.total, installed: name, previous: "spinny-0.1.0-x86_64-linux" };
        }
        return { ...this.updating };
    }

    async updateCheck(): Promise<UpdateState> {
        if (this.updating.kind === "checkout") {
            throw new ApiError(400, "this is a checkout of the repository, not an installed release: it updates with git (git pull)");
        }
        if (this.updating.state === "downloading") {
            throw new ApiError(400, "an update is under way");
        }
        const latest = this.updating.prereleases
            ? { version: "0.3.0rc1", tag: "v0.3.0rc1", page: "https://github.com/tmpk13/spinny-cnc/releases/tag/v0.3.0rc1", published: "2026-11-13T10:00:00Z", archive: "spinny-0.3.0rc1-x86_64-linux.tar.gz", size: 49_000_000, prerelease: true }
            : { version: "0.2.0", tag: "v0.2.0", page: "https://github.com/tmpk13/spinny-cnc/releases/tag/v0.2.0", published: "2026-11-12T10:00:00Z", archive: "spinny-0.2.0-x86_64-linux.tar.gz", size: 48_000_000, prerelease: false };
        this.updating = { ...this.updating, latest, status: "newer", checked: new Date().toISOString().slice(0, 19), error: null };
        return { ...this.updating };
    }

    async updateInstall(): Promise<UpdateState> {
        if (this.updating.kind === "checkout") {
            throw new ApiError(400, "this is a checkout of the repository, not an installed release: it updates with git (git pull)");
        }
        if (this.updating.state === "downloading") {
            throw new ApiError(400, "an update is under way");
        }
        if (this.updating.installed !== null) {
            throw new ApiError(400, `${this.updating.installed} is installed beside this one: restart from ${this.updating.link}/bin/spinny-web to run it`);
        }
        const latest = this.updating.latest;
        if (latest === null) {
            throw new ApiError(400, "check for a release first");
        }
        if (this.updating.status !== "newer" && this.updating.status !== "other") {
            throw new ApiError(400, `the latest release, ${latest.version}, is not newer than this one (${this.updating.version})`);
        }
        this.updating = { ...this.updating, state: "downloading", done: 0, total: latest.size, error: null };
        return { ...this.updating };
    }

    async calibrateJob(request: CalibrateRequest): Promise<CalibrateResponse> {
        let built: CalibrateResponse;
        try {
            built = calibrateJob(this.newId(), request, this.machine.milling(), this.limits(), this.machine.hasFocusAxis());
        } catch (error) {
            throw new ApiError(400, errorText(error));
        }
        this.jobStore.set(built.job.id, built.job);
        this.order.push(built.job.id);
        return built;
    }

    async jobs(): Promise<JobSummary[]> {
        return this.jobSummaries();
    }

    /** Every job in short, as GET /api/jobs lists them. */
    private jobSummaries(): JobSummary[] {
        return this.order.map((id) => {
            const job = this.jobStore.get(id);
            if (!job) {
                throw new ApiError(500, "job list out of step");
            }
            return {
                id: job.id,
                name: job.name,
                source: job.source,
                layer: job.layer ?? null,
                spot: job.spot,
                offset: job.offset,
                rotation: job.rotation ?? 0,
                remake: job.recipe != null,
                holes: job.holes?.length ?? 0,
                icon: job.icon ?? null,
                groups: job.groups.map((group) => ({
                    label: group.label,
                    power: group.power,
                    min_power: group.min_power,
                    speed: group.speed,
                    passes: group.passes,
                    enabled: group.enabled,
                    depth: group.depth,
                    plunge: group.plunge,
                    thickness: group.thickness,
                    focus: group.focus ?? null,
                    tool: group.tool ?? null,
                    paths: group.paths.length,
                    joints: group.joints?.length ?? 0,
                })),
                stats: job.stats,
            };
        });
    }

    private requireJob(id: string): Job {
        const job = this.jobStore.get(id);
        if (!job) {
            throw new ApiError(404, `no job ${id}`);
        }
        return job;
    }

    async job(id: string): Promise<Job> {
        return this.requireJob(id);
    }

    /** The whole patch is checked first and applied to a copy, so a refused one changes nothing; one that only sets the icon is taken while the job runs. */
    async patchJob(id: string, patch: JobPatch): Promise<void> {
        const job = this.requireJob(id);
        const iconOnly = Object.keys(patch).length === 1 && patch.icon !== undefined;
        if (this.session && this.session.job.id === id && !iconOnly) {
            throw new ApiError(409, "the job is running");
        }
        try {
            const problem = iconProblem(patch.icon);
            if (problem !== null) {
                throw new Error(problem);
            }
            for (const change of patch.groups ?? []) {
                if (!job.groups[change.index]) {
                    throw new Error(`no group ${change.index}`);
                }
                if (change.power !== undefined) {
                    checkPower(change.power);
                }
                if (change.min_power !== undefined) {
                    checkPower(change.min_power, "min power");
                }
                if (change.speed !== undefined) {
                    checkSpeed(change.speed);
                }
                if (change.passes !== undefined) {
                    checkPasses(change.passes);
                }
                if (change.depth !== undefined) {
                    checkDepth(change.depth);
                }
                if (change.plunge !== undefined) {
                    checkSpeed(change.plunge, "plunge");
                }
                if (change.thickness !== undefined) {
                    checkThickness(change.thickness);
                }
                checkFocus(change.focus);
            }
            if (patch.offset) {
                const moved = patch.offset.x !== job.offset.x || patch.offset.y !== job.offset.y;
                if (moved && job.groups.some((group) => group.joints && group.joints.length > 0)) {
                    throw new Error("a joint-space group is fixed to the axis and cannot be moved");
                }
                if (![patch.offset.x, patch.offset.y].every((v) => Number.isFinite(v) && Math.abs(v) <= MAX_VALUE)) {
                    throw new Error(`offset must be within ${MAX_VALUE_TEXT} mm`);
                }
            }
            if (patch.turn !== undefined) {
                const about = patch.about ?? "center";
                if (about !== "center" && about !== "origin") {
                    throw new Error("about must be one of center, origin");
                }
                if (!(patch.turn >= -360 && patch.turn <= 360)) {
                    throw new Error("turn must be -360 to 360 degrees");
                }
                if (patch.turn !== 0 && job.groups.some((group) => group.joints && group.joints.length > 0)) {
                    throw new Error("a joint-space group is fixed to the axis and cannot be turned");
                }
            }
        } catch (error) {
            throw new ApiError(400, errorText(error));
        }
        const updated = structuredClone(job);
        for (const change of patch.groups ?? []) {
            const group = updated.groups[change.index];
            if (!group) {
                continue;
            }
            if (change.power !== undefined) {
                group.power = change.power;
            }
            if (change.min_power !== undefined) {
                group.min_power = change.min_power;
            }
            if (change.speed !== undefined) {
                group.speed = change.speed;
            }
            if (change.passes !== undefined) {
                group.passes = change.passes;
            }
            if (change.depth !== undefined) {
                group.depth = change.depth;
            }
            if (change.plunge !== undefined) {
                group.plunge = change.plunge;
            }
            if (change.thickness !== undefined) {
                group.thickness = change.thickness;
            }
            if (change.focus !== undefined) {
                // Null takes the group's focus away.
                if (change.focus === null) {
                    delete group.focus;
                } else {
                    group.focus = change.focus;
                }
            }
            if (change.enabled !== undefined) {
                group.enabled = change.enabled;
            }
        }
        if (patch.offset) {
            const dx = patch.offset.x - updated.offset.x;
            const dy = patch.offset.y - updated.offset.y;
            for (const group of updated.groups) {
                group.paths = shiftPaths(group.paths, dx, dy);
                if (group.moves) {
                    group.moves = group.moves.map((path) => path.map(([x, y, z, kind]) => [x + dx, y + dy, z, kind]));
                }
            }
            updated.outline = shiftPaths(updated.outline, dx, dy);
            updated.copper = shiftPaths(updated.copper, dx, dy);
            updated.pads = (updated.pads ?? []).map(([x, y, area]) => [x + dx, y + dy, area]);
            updated.holes = (updated.holes ?? []).map(([x, y, diameter]) => [x + dx, y + dy, diameter]);
            if (updated.design) {
                updated.design = { ...updated.design, shift: [updated.design.shift[0] + dx, updated.design.shift[1] + dy] };
            }
            updated.offset = { ...patch.offset };
        }
        if (patch.turn) {
            // About the middle of what it cuts, the job stays where it is:
            // turned about the origin, then moved back by what the middle moved.
            const [cx, cy] = (patch.about ?? "center") === "center" ? cutMiddle(updated) : [0, 0];
            const [tx, ty] = turnPoint([cx, cy], patch.turn);
            moveJob(updated, patch.turn, cx - tx, cy - ty);
        }
        if (patch.icon !== undefined) {
            updated.icon = patch.icon;
        }
        if (!iconOnly) {
            updated.stats = computeStats(updated.groups, this.limits());
        }
        this.jobStore.set(id, updated);
    }

    async deleteJob(id: string): Promise<void> {
        this.requireJob(id);
        if (this.session && this.session.job.id === id) {
            throw new ApiError(409, "job is running");
        }
        this.jobStore.delete(id);
        this.order = this.order.filter((other) => other !== id);
        this.forgetJob(id);
    }

    /** A job gone takes its marks and the camera's board with it. */
    private forgetJob(id: string): void {
        if (this.alignJob === id) {
            this.alignJob = null;
            this.alignMarks = [];
            this.alignFitLast = null;
            this.emitAlign();
        }
        if (this.cameraJob === id) {
            this.cameraJob = null;
            this.placement = null;
            this.emitCamera();
        }
    }

    async deleteAllJobs(): Promise<string[]> {
        const running = this.session?.job.id ?? null;
        const removed: string[] = [];
        for (const id of [...this.order]) {
            if (id === running) {
                continue;
            }
            this.jobStore.delete(id);
            removed.push(id);
        }
        this.order = this.order.filter((id) => id === running);
        for (const id of removed) {
            this.forgetJob(id);
        }
        return removed;
    }

    /** The mock keeps no log: what it sends and hears goes out only as console events. */
    async log(): Promise<string[]> {
        return [];
    }

    /**
     * The steps along one board path from `joint`, `z`: the polar planner's,
     * or on a cartesian machine one joint line per board line, in the frame
     * of the table's angle, which holds.
     */
    private pathSteps(path: Path, joint: Joint, z: number): Step[] {
        if (!this.machine.cartesian()) {
            return pathMoves(path, joint, this.tolerance).map((move) => ({ ...move, z }));
        }
        if (path.length < 2) {
            return [];
        }
        const angle = this.machine.frameAngle();
        const out: Step[] = [];
        let here = { r: joint.r, z };
        path.forEach(([x, y], index) => {
            const at = turned({ x, y }, -angle);
            // Within the resolution of a word, the head is there already.
            if (Math.abs(at.x - here.r) < 0.5e-3 && Math.abs(at.y - here.z) < 0.5e-3) {
                return;
            }
            out.push({ kind: index === 0 ? "go" : "cut", target: { r: at.x, a: joint.a }, z: at.y });
            here = { r: at.x, z: at.y };
        });
        return out;
    }

    /** A laser group's steps from `joint`, `z`, once per pass. */
    private groupSteps(group: Group, joint: Joint, z: number): Step[] {
        if (!this.machine.cartesian()) {
            return groupMoves(group, joint, this.tolerance).map((move) => ({ ...move, z }));
        }
        if (group.joints && group.joints.length > 0) {
            throw new Error(`${group.label}: a joint-space group needs the polar machine ($cartesian=0)`);
        }
        const out: Step[] = [];
        for (let pass = 0; pass < Math.max(1, group.passes); pass++) {
            for (const path of group.paths) {
                const steps = this.pathSteps(path, joint, z);
                const last = steps[steps.length - 1];
                if (last) {
                    joint = last.target;
                    z = last.z;
                }
                out.push(...steps);
            }
        }
        return out;
    }

    /**
     * The move list a job streams from where the machine is: a rapid to
     * each path, then cuts within the chord tolerance; a joint-space group
     * goes out as it is written. With a map to follow by `focus`, every
     * move also carries the focus height at its end, and a job whose first
     * move is a cut, the head already over its start, gets a dark move to
     * the focus height first so the beam does not light at another. With
     * a spindle the job is milled instead. A laser group's own focus raises
     * the map's focus height, or without a map the height the head stands
     * at as the run begins (`focusBase` when given, the height a run picked
     * up began at): said on the group's first move (a lift of its own
     * before a cut that starts where the head is), and the head goes back
     * to that height after the last group. `from` is where the plan
     * begins, the machine's end of motion when left out.
     */
    movesFor(job: Job, focus: HeightMap | null = null, focusBase: number | null = null, from: PlanStart | null = null): Move[] {
        const machine = this.machine;
        const surface = focus ? (target: Joint, z: number): number => {
            const board = machine.headBoard(target, z);
            return heightAt(focus, board.x, board.y) + focus.focus_offset;
        } : null;
        // A group made for another tool than the machine has is refused;
        // one made for none runs on a laser or a spindle.
        const tool = machine.profile().tool;
        for (const group of job.groups) {
            if (group.enabled && group.tool && group.tool !== tool) {
                throw new Error(`${group.label}: made for a ${group.tool}, not this machine's ${tool}`);
            }
        }
        // A run has no stop to change the bit: a milling job whose enabled
        // groups a CAM profile made with more than one bit is refused, as
        // the backend refuses it. A group that names no bit cuts with
        // whatever is fitted.
        if (tool === "spindle") {
            const cutting = job.groups.filter((group) => group.enabled
                && (group.paths.length > 0 || (group.joints?.length ?? 0) > 0 || (group.moves?.length ?? 0) > 0)
                && (group.tool_id ?? null) !== null);
            const bits = new Map<string, string>();
            for (const group of cutting) {
                if (!bits.has(group.tool_id!)) {
                    bits.set(group.tool_id!, group.tool_name || group.tool_id!);
                }
            }
            if (bits.size > 1) {
                const [first, firstName] = bits.entries().next().value!;
                const later = cutting.filter((group) => group.tool_id !== first).map((group) => group.label);
                throw new Error(
                    `the job cuts with ${bits.size} bits (${[...bits.values()].join(", ")}) and a run does not stop to change one:`
                    + ` switch off ${later.join("; ")} to cut with the ${firstName} alone, then each other bit's groups after fitting it`,
                );
            }
        }
        const offsets = groupFocus(job);
        const focused = offsets.keys().next();
        if (!focused.done) {
            const label = job.groups[focused.value]!.label;
            if (tool !== "laser") {
                throw new Error(`${label}: a focus height is for a laser's beam; clear it to ${tool === "spindle" ? "mill" : "dispense"} the group`);
            }
            if (!machine.hasFocusAxis()) {
                throw new Error(`${label} asks for a focus height and the machine has no focus axis ($h_axis=1)`);
            }
        }
        const begin: PlanStart = from ?? { joint: machine.endpoint(), z: machine.endpointZ() };
        if (machine.dispensing()) {
            return this.dispensingMoves(job, focus, surface, begin);
        }
        if (machine.milling()) {
            return this.millingMoves(job, focus, surface, begin);
        }
        const cartesian = machine.cartesian();
        const moves: Move[] = [];
        let joint = begin.joint;
        let z = begin.z;
        const base = focusBase ?? machine.endpointH();
        // The height the plan last said, when a group's focus has it say any.
        let current: number | null = null;
        // Following the map: the own focus of the group whose height the
        // last move said. A cut of a group with another focus that starts
        // where the last move ended has no rapid to carry its height, so a
        // dark move goes first, or the cut would move the head lit.
        let said: number | null = null;
        let lastGroup = 0;
        job.groups.forEach((group, index) => {
            if (!group.enabled) {
                return;
            }
            const extra = offsets.get(index) ?? 0;
            for (const step of this.groupSteps(group, joint, z)) {
                const move: Move =
                    step.kind === "go"
                        ? { kind: "go", target: step.target, feed: null, power: 0, group: index }
                        : { kind: "cut", target: step.target, feed: group.speed, power: group.power, minPower: group.min_power, group: index };
                if (cartesian) {
                    move.z = step.z;
                }
                if (surface) {
                    if (move.kind === "cut" && said !== null && Math.abs(extra - said) >= 0.00005) {
                        moves.push({ kind: "go", target: joint, ...(cartesian ? { z } : {}), h: round4(surface(joint, z) + extra), headOnly: true, feed: null, power: 0, group: index });
                    }
                    said = extra;
                    move.h = round4(surface(step.target, step.z) + extra);
                } else if (offsets.size > 0) {
                    const want = round4(base + extra);
                    if (current === null || Math.abs(want - current) >= 0.00005) {
                        if (move.kind === "go") {
                            move.h = want;
                        } else {
                            moves.push({ kind: "go", target: joint, ...(cartesian ? { z } : {}), h: want, headOnly: true, feed: null, power: 0, group: index });
                        }
                        current = want;
                    }
                }
                moves.push(move);
                joint = step.target;
                z = step.z;
                lastGroup = index;
            }
        });
        if (!surface && current !== null && Math.abs(current - base) >= 0.00005) {
            moves.push({ kind: "go", target: joint, ...(cartesian ? { z } : {}), h: round4(base), headOnly: true, feed: null, power: 0, group: lastGroup });
        }
        const first = moves[0];
        if (surface && first?.kind === "cut") {
            const extra = offsets.get(first.group) ?? 0;
            moves.unshift({ kind: "go", target: begin.joint, h: round4(surface(begin.joint, begin.z) + extra), headOnly: true, feed: null, power: 0, group: first.group });
        }
        return moves;
    }

    /**
     * A job milled with the spindle, as the backend streams one: the tool
     * rises to the travel height, the spindle starts and is given its
     * spin-up, and each path is a rapid to its start, a plunge at the
     * group's plunge rate, the cuts at depth and a rise back, a group's
     * passes a step deeper each time. The spindle changes speed between
     * groups that ask for another and stops at the end, with the tool up.
     * With a map the depth is under the surface it gives, and the travel
     * height over its highest point.
     */
    private millingMoves(job: Job, map: HeightMap | null, surface: ((target: Joint, z: number) => number) | null, begin: PlanStart): Move[] {
        // A spindle at S0 is stopped, and every plunge after it would drive
        // a still tool into the board.
        for (const group of job.groups) {
            const hasCuts = group.paths.length > 0 || (group.joints?.length ?? 0) > 0;
            if (group.enabled && hasCuts && !(group.power > 0)) {
                throw new Error(`${group.label}: a spindle needs a speed above 0`);
            }
        }
        const machine = this.machine;
        const cartesian = machine.cartesian();
        const travel = round4((map ? highestSurface(map) : 0) + this.clearance);
        const spinupMs = Math.round(this.spinup * 1000);
        const under = (target: Joint, z: number, depth: number): number => round4((surface ? surface(target, z) : 0) - depth);
        const moves: Move[] = [];
        let joint = begin.joint;
        let z = begin.z;
        const lift = (group: number): Move => ({ kind: "go", target: joint, h: travel, headOnly: true, feed: null, power: 0, group });
        moves.push(lift(-1));
        let speed: number | null = null;
        let lastGroup = -1;
        job.groups.forEach((group, index) => {
            if (!group.enabled) {
                return;
            }
            if (group.joints && group.joints.length > 0) {
                throw new Error(`${group.label}: a joint-space group cannot be milled`);
            }
            lastGroup = index;
            // With the speed control off the spindle runs full on, at s_max.
            const wanted = this.speedControl ? group.power : machine.settings["s_max"] ?? 1000;
            if (wanted !== speed) {
                speed = wanted;
                moves.push({ kind: "spindle", target: joint, power: speed, feed: null, group: index });
                if (spinupMs > 0) {
                    moves.push({ kind: "dwell", target: joint, ms: spinupMs, power: 0, feed: null, group: index });
                }
            }
            const passes = Math.max(1, group.passes);
            const total = group.depth ?? DEFAULT_DEPTH;
            const plunge = group.plunge ?? DEFAULT_PLUNGE;
            for (let pass = 1; pass <= passes; pass++) {
                const depth = (total * pass) / passes;
                for (const path of group.paths) {
                    // A path of one point is a drill: over the point, the bit
                    // down to the depth and up again.
                    if (path.length === 1) {
                        const over = this.jointOver({ x: path[0]![0], y: path[0]![1] }, joint);
                        if (Math.abs(over.r - joint.r) >= 0.5e-3 || Math.abs(over.z - z) >= 0.5e-3 || Math.abs(over.a - joint.a) >= 0.5e-4) {
                            moves.push({ kind: "go", target: { r: over.r, a: over.a }, ...(cartesian ? { z: over.z } : {}), feed: null, power: 0, group: index });
                            joint = { r: over.r, a: over.a };
                            z = over.z;
                        }
                        moves.push({ kind: "cut", target: joint, h: under(joint, z, depth), headOnly: true, feed: plunge, power: 0, milled: true, group: index });
                        moves.push(lift(index));
                        continue;
                    }
                    let plunged = false;
                    for (const step of this.pathSteps(path, joint, z)) {
                        const slide = cartesian ? { z: step.z } : {};
                        if (step.kind === "go") {
                            moves.push({ kind: "go", target: step.target, ...slide, feed: null, power: 0, group: index });
                        } else {
                            if (!plunged) {
                                moves.push({ kind: "cut", target: joint, h: under(joint, z, depth), headOnly: true, feed: plunge, power: 0, milled: true, group: index });
                                plunged = true;
                            }
                            const h = under(step.target, step.z, depth);
                            // On the axis the tool stays on one board point while the table turns under it.
                            const turn = !cartesian && surfaceLength(joint, step.target) < SURFACE_EPSILON_MM;
                            moves.push(
                                turn
                                    ? { kind: "go", target: step.target, h, feed: null, power: 0, group: index }
                                    : { kind: "cut", target: step.target, ...slide, h, feed: group.speed, power: 0, milled: true, group: index },
                            );
                        }
                        joint = step.target;
                        z = step.z;
                    }
                    if (plunged) {
                        moves.push(lift(index));
                    }
                }
            }
        });
        moves.push({ kind: "spindle", target: joint, power: 0, off: true, feed: null, group: lastGroup });
        return moves;
    }

    /** The joints that put the head over a board point: the rail and the slide on a cartesian machine, the polar pair otherwise. */
    private jointOver(point: Board, from: Joint): { r: number; a: number; z: number } {
        if (this.machine.cartesian()) {
            const at = turned(point, -this.machine.frameAngle());
            return { r: at.x, a: from.a, z: at.y };
        }
        const joint = jointOfBoard(point, from);
        return { r: joint.r, a: joint.a, z: this.machine.z };
    }

    /**
     * A job dispensed, as the backend streams one: the head lifts to the
     * travel height, and for every dot goes over the pad, lowers the needle
     * to the gap over the surface, pushes the plunger out by the dot's
     * volume over the output plus the last retract at the extrude rate,
     * waits the dwell, pulls the plunger back by the retract and lifts.
     * The plunger's position only ever grows by the dots' volumes.
     */
    private dispensingMoves(job: Job, map: HeightMap | null, surface: ((target: Joint, z: number) => number) | null, begin: PlanStart): Move[] {
        const machine = this.machine;
        const cartesian = machine.cartesian();
        for (const group of job.groups) {
            if (!group.enabled) {
                continue;
            }
            if (group.joints && group.joints.length > 0) {
                throw new Error(`${group.label}: a joint-space group cannot be dispensed`);
            }
            if (group.paths.some((path) => path.length !== 1)) {
                throw new Error(`${group.label}: a dispenser lays dots: import the board with mode dispense`);
            }
        }
        const travel = round4((map ? highestSurface(map) : 0) + this.clearance);
        const over = (target: Joint, z: number): number => round4((surface ? surface(target, z) : 0) + this.gap);
        const moves: Move[] = [];
        let joint = begin.joint;
        let z = begin.z;
        let plunger = joint.a;
        const lift = (group: number): Move => ({ kind: "go", target: joint, h: travel, headOnly: true, feed: null, power: 0, group });
        moves.push(lift(-1));
        const dwellMs = Math.round(this.dwellMs);
        job.groups.forEach((group, index) => {
            if (!group.enabled) {
                return;
            }
            const thickness = group.thickness ?? DEFAULT_THICKNESS;
            for (let pass = 0; pass < Math.max(1, group.passes); pass++) {
                group.paths.forEach((path, dot) => {
                    const area = group.areas?.[dot];
                    if (area === undefined) {
                        throw new Error(`${group.label}: dot ${dot + 1} has no pad area`);
                    }
                    const at = this.jointOver({ x: path[0]![0], y: path[0]![1] }, joint);
                    joint = { r: at.r, a: plunger };
                    z = at.z;
                    moves.push({ kind: "go", target: joint, ...(cartesian ? { z } : {}), feed: null, power: 0, group: index });
                    moves.push({ kind: "go", target: joint, h: over(joint, z), headOnly: true, feed: null, power: 0, group: index });
                    plunger = round4(plunger + (area * thickness) / this.output + this.retract);
                    joint = { r: joint.r, a: plunger };
                    moves.push({ kind: "cut", target: joint, turn: true, feed: this.extrudeRate, power: 0, milled: true, group: index });
                    if (dwellMs > 0) {
                        moves.push({ kind: "dwell", target: joint, ms: dwellMs, power: 0, feed: null, group: index });
                    }
                    if (this.retract > 0) {
                        plunger = round4(plunger - this.retract);
                        joint = { r: joint.r, a: plunger };
                        moves.push({ kind: "go", target: joint, turn: true, feed: null, power: 0, group: index });
                    }
                    moves.push(lift(index));
                });
            }
        });
        return moves;
    }

    /**
     * How a run of `job` follows the height map, checked as the backend
     * checks it; null for off. Power compensation is only checked here: the
     * mock streams its cuts at the power they have.
     */
    private compensation(mode: string, job: Job): { mode: "focus" | "power"; map: HeightMap } | null {
        if (!COMPENSATE_MODES.includes(mode)) {
            throw new ApiError(400, `compensate must be one of ${COMPENSATE_MODES.join(", ")}`);
        }
        if (mode === "off") {
            return null;
        }
        // An offset set in a focus axis frame before this one is taken back first.
        if (this.dropStaleFocus()) {
            this.emitHeightMap();
        }
        const map = this.heightmap;
        try {
            if (!map) {
                throw new Error("there is no height map: probe the board first");
            }
            checkUsable(map);
            checkCovers(map, job);
        } catch (error) {
            throw new ApiError(400, errorText(error));
        }
        const hasAxis = this.machine.hasFocusAxis();
        const resolved = mode === "auto" ? (hasAxis ? "focus" : "power") : mode === "focus" ? "focus" : "power";
        if (this.machine.milling() && resolved === "power") {
            throw new ApiError(400, "a spindle follows the board with its depth axis: compensate by focus");
        }
        if (resolved === "focus" && !hasAxis) {
            throw new ApiError(400, "the focus axis is not fitted ($h_axis=0): compensate by power instead");
        }
        return { mode: resolved, map };
    }

    async runJob(id: string, compensate: Compensate = "off", focusHere = false): Promise<void> {
        this.requireConnected();
        const job = this.requireJob(id);
        this.refuseWhileProbing();
        if (this.machine.milling() && !this.machine.hasFocusAxis()) {
            throw new ApiError(400, "a spindle needs the focus axis as its depth axis: set $h_axis=1");
        }
        if (this.machine.dispensing() && !this.machine.hasFocusAxis()) {
            throw new ApiError(400, "a dispenser needs the focus axis as the needle's height: set $h_axis=1");
        }
        const followed = this.compensation(compensate, job);
        if (this.session) {
            throw new ApiError(409, "a job is already running");
        }
        if (this.machine.state !== "Idle" || this.outbox.length > 0) {
            throw new ApiError(409, "machine is not idle");
        }
        // Without the map a laser group's own focus counts from where the
        // head stands as the run begins.
        if (!followed && !focusHere) {
            this.checkFocusStart(job);
        }
        let moves: Move[];
        try {
            refusePowerWithFocus(job, followed?.mode ?? "off");
            moves = this.movesFor(job, followed?.mode === "focus" ? followed.map : null);
        } catch (error) {
            throw new ApiError(400, errorText(error));
        }
        if (moves.length === 0) {
            throw new ApiError(400, "job has no enabled paths");
        }
        this.jogTracked = false;
        this.session = { job, moves, next: 0, okSent: 0, state: "running", seconds: 0, group: 0, compensate: followed?.mode ?? "off" };
        this.lastProgress = null;
        this.lastStart = { joint: this.machine.endpoint(), z: this.machine.endpointZ() };
        this.lastPlan = this.planOf(followed?.mode ?? "off", this.focusStartOf(job, null), this.lastStart, moves);
        const following = followed ? `, following the board by ${followed.mode}` : "";
        this.message("info", `running ${job.name}: ${moves.length} moves${following}`);
        this.serviceRun(0);
    }

    /** The record's plan of a run whose `moves` begin at `begin`. */
    private planOf(compensate: MapMode, startH: number | null, begin: PlanStart, moves: Move[]): RunPlan {
        const machine = this.machine;
        const cartesian = machine.cartesian();
        return {
            start: cartesian ? [begin.joint.r, begin.z] : [begin.joint.r, begin.joint.a],
            compensate,
            cartesian,
            spindle: machine.milling(),
            start_h: startH,
            frame: this.frameName(),
            fingerprint: planPrint(moves),
        };
    }

    /** The focus axis frame in use, as the record keeps it beside a height. */
    private frameName(): string {
        return String(this.frame);
    }

    /** The height a laser group's own focus counts from in a run of `job`: `base`, or where the head stands; null when no group has one. */
    private focusStartOf(job: Job, base: number | null): number | null {
        const machine = this.machine;
        if (machine.milling() || machine.dispensing() || !machine.hasFocusAxis() || groupFocus(job).size === 0) {
            return null;
        }
        return base ?? machine.endpointH();
    }

    /**
     * Refuses a run of `job` counting its groups' own focus from where the
     * head is when the last run of the job did not finish, as the backend
     * does: that run leaves the head at the height of the group it was
     * cutting, and in another frame nothing tells where it began.
     */
    private checkFocusStart(job: Job): void {
        const here = this.focusStartOf(job, null);
        const record = this.resumeRecordOf();
        if (here === null || !record || record.job !== job.id || record.state === "done") {
            return;
        }
        const began = record.start_h;
        if (typeof began !== "number") {
            return;
        }
        if (record.frame !== this.frameName()) {
            throw new ApiError(
                409,
                `the last run of ${job.name} stopped part way, and the focus axis has been renumbered since it` +
                    ` began at H${gnum(began, 4)} (a connect, a restart, a position set or a home), so nothing tells` +
                    " where focus is: bring the head to focus and run with focus here",
            );
        }
        if (Math.abs(here - began) >= 0.00005) {
            throw new ApiError(
                409,
                `the last run of ${job.name} stopped with the focus axis at H${gnum(here, 4)}, not at H${gnum(began, 4)}` +
                    ` where it began and its groups' focus counts from: send the head back (go H${gnum(began, 4)}) and` +
                    " run, or if it was focused again where it is, run with focus here",
            );
        }
    }

    /**
     * The moves of a job and where picking it up at `request.line` would
     * start. A laser group's own focus counts from where the run picked up
     * began, when the record is this job's and the focus axis frame is the
     * one it began in, or from where the head stands on the operator's word
     * (`focus_here`); in another frame the pickup is refused, as the
     * backend's is. The plan begins where the run picked up began when the
     * record is this job's, so its moves are the ones counted, and a plan
     * that prints otherwise than that run's is refused unless the operator
     * says the line is counted in the job as it is now (`changed`).
     */
    private resumePlanOf(
        id: string,
        request: ResumeRequest,
    ): { job: Job; moves: Move[]; skip: number; line: number; compensate: MapMode; startH: number | null; begin: PlanStart } {
        const job = this.requireJob(id);
        if (!Number.isInteger(request.line) || request.line < 0) {
            throw new ApiError(400, "the line to pick the job up at cannot be negative");
        }
        const record = this.resumeRecordOf();
        const theirs = record !== null && record.job === id;
        const compensate = request.compensate ?? (theirs ? record.compensate ?? "off" : "off");
        if (!COMPENSATE_MODES.includes(compensate)) {
            throw new ApiError(400, `compensate must be one of ${COMPENSATE_MODES.join(", ")}`);
        }
        const followed = this.compensation(compensate, job);
        let base: number | null = null;
        const began = theirs ? record.start_h : null;
        if (groupFocus(job).size > 0 && !request.focus_here && typeof began === "number") {
            if (!followed && record!.frame !== this.frameName()) {
                throw new ApiError(
                    409,
                    `the focus axis has been renumbered since the run being picked up began at H${gnum(began, 4)}` +
                        " (a connect, a restart, a position set or a home), so its groups' heights cannot be counted" +
                        " from there: bring the head to focus and pick up with focus here",
                );
            }
            base = began;
        }
        const recorded = theirs && this.lastStart !== null && (record.cartesian ?? false) === this.machine.cartesian() ? this.lastStart : null;
        const begin: PlanStart = recorded ?? { joint: this.machine.endpoint(), z: this.machine.endpointZ() };
        let moves: Move[];
        try {
            refusePowerWithFocus(job, followed?.mode ?? "off");
            moves = this.movesFor(job, followed?.mode === "focus" ? followed.map : null, base, begin);
        } catch (error) {
            throw new ApiError(400, errorText(error));
        }
        if (theirs && typeof record.fingerprint === "string" && !request.changed && planPrint(moves) !== record.fingerprint) {
            throw new ApiError(
                409,
                `the plan of ${job.name} is not the one the run being picked up counted its lines in: the job` +
                    " was changed since (re-cut, regrouped, turned or moved, paths deleted or added), or the pickup" +
                    ` follows the height map otherwise, so line ${request.line} is not where that run got to: run it` +
                    " from the top, or pick it up at a line counted in the job as it is now",
            );
        }
        const line = Math.min(request.line, moves.length);
        let skip = line;
        if (request.rewind ?? true) {
            // A plunge is a cut of the head alone here, so it is stepped back over too.
            while (skip > 0 && moves[skip - 1]!.kind === "cut") {
                skip -= 1;
            }
            if (skip > 0 && moves[skip - 1]!.kind === "go") {
                skip -= 1;
            }
        }
        return { job, moves, skip, line, compensate: followed?.mode ?? "off", startH: this.focusStartOf(job, base), begin };
    }

    async planResume(id: string, request: ResumeRequest): Promise<ResumePlan> {
        const { moves, skip, line, compensate } = this.resumePlanOf(id, request);
        const next = moves[skip] ?? null;
        const record = this.resumeRecordOf();
        return {
            job: id,
            line,
            skip,
            total: moves.length,
            compensate,
            planned_from_record: record !== null && record.job === id,
            next: next ? formatMove(next) : null,
            group: next ? next.group : null,
            approach: next ? [formatMove(next)] : [],
        };
    }

    async resumeJob(id: string, request: ResumeRequest): Promise<Progress> {
        this.requireConnected();
        this.refuseWhileProbing();
        if (this.machine.milling() && !this.machine.hasFocusAxis()) {
            throw new ApiError(400, "a spindle needs the focus axis as its depth axis: set $h_axis=1");
        }
        const { job, moves, skip, compensate, startH, begin } = this.resumePlanOf(id, request);
        if (this.session) {
            throw new ApiError(409, "a job is already running");
        }
        if (this.machine.state !== "Idle" || this.outbox.length > 0) {
            throw new ApiError(409, "machine is not idle");
        }
        if (moves.length === 0) {
            throw new ApiError(400, "job has no enabled paths");
        }
        this.jogTracked = false;
        this.session = { job, moves, next: skip, okSent: skip, state: "running", seconds: 0, group: moves[skip]?.group ?? 0, resumedFrom: skip, compensate };
        this.lastProgress = null;
        this.lastStart = begin;
        this.lastPlan = this.planOf(compensate, startH, begin, moves);
        this.message("info", `picking ${job.name} up at line ${skip} of ${moves.length}`);
        this.serviceRun(0);
        const progress = this.progress();
        if (!progress) {
            throw new ApiError(500, "the run did not start");
        }
        return progress;
    }

    async resumeRecord(): Promise<ResumeRecord | null> {
        return this.resumeRecordOf();
    }

    async runHold(): Promise<void> {
        this.requireConnected();
        if (!this.session) {
            throw new ApiError(409, "no job running");
        }
        this.line("tx", "!");
        this.machine.hold();
        this.session.state = "hold";
    }

    async runResume(): Promise<void> {
        this.requireConnected();
        if (!this.session) {
            throw new ApiError(409, "no job running");
        }
        this.line("tx", "~");
        this.machine.resume();
        this.session.state = "running";
    }

    async runStop(): Promise<void> {
        this.requireConnected();
        const session = this.session;
        if (!session) {
            throw new ApiError(409, "no job running");
        }
        this.halt();
        session.state = "stopped";
        this.serviceRun(0);
        this.emit({ type: "state", data: this.snapshot() });
    }

    async run(): Promise<Progress | null> {
        return this.progress();
    }

    /** A stop's hold, then its reset: from a hold the reset loses no steps. */
    private halt(): void {
        this.line("tx", "!");
        this.machine.hold();
        this.line("tx", "<0x18>");
        this.outbox = [];
        this.machine.reset();
    }

    // Height map.

    private heightMapState(): HeightMapState {
        const progress = this.probeProgress;
        let remaining: number | null = null;
        if (progress) {
            remaining = progress.state === "running" ? Math.max(0, progress.total - progress.done) * PROBE_POINT_SECONDS : progress.state === "done" ? 0 : null;
        }
        return {
            map: this.heightmap ? structuredClone(this.heightmap) : null,
            probe: progress
                ? {
                    ...progress,
                    point: progress.point ? [progress.point[0], progress.point[1]] : null,
                    seconds: Math.round(progress.seconds * 10) / 10,
                    remaining: remaining === null ? null : Math.round(remaining * 10) / 10,
                }
                : null,
            settings: structuredClone(this.probeConfig),
        };
    }

    /** The grid a probe request asks for: the job's mask when it names one, the stored map's when it goes on with it. */
    private probeGridOf(request: ProbeRequest): { grid: Grid; resume: HeightMap | null } {
        if (request.resume) {
            const map = this.heightmap;
            if (!map) {
                throw new ApiError(400, "there is no height map to go on with: probe the board first");
            }
            if (map.points) {
                throw new ApiError(400, "the height map is a pad map: go on with it by probing the pads again");
            }
            if (map.heights.every((row, iy) => row.every((value, ix) => value !== null || !gridWanted(map.grid, ix, iy)))) {
                throw new ApiError(400, "the height map is complete: nothing is left to probe");
            }
            return { grid: structuredClone(map.grid), resume: map };
        }
        let grid: Grid = { x0: request.x0, y0: request.y0, x1: request.x1, y1: request.y1, nx: request.nx, ny: request.ny, mask: request.mask ?? null };
        try {
            checkGrid(grid);
        } catch (error) {
            throw new ApiError(400, errorText(error));
        }
        if (request.job) {
            const job = this.requireJob(request.job);
            const margin = request.margin ?? 1;
            if (!(Number.isFinite(margin) && margin >= 0 && margin <= 100)) {
                throw new ApiError(400, "the margin must be 0 to 100 mm");
            }
            grid = gridMaskedForJob(grid, job, margin);
        }
        return { grid, resume: null };
    }

    async probeEstimate(request: ProbeRequest): Promise<ProbeEstimate> {
        const { grid, resume } = this.probeGridOf(request);
        const points = resume
            ? gridOrder(grid).filter(([ix, iy]) => resume.heights[iy]?.[ix] === null).length
            : gridPoints(grid);
        return { seconds: Math.round(points * PROBE_POINT_SECONDS * 10) / 10, points, grid };
    }

    /**
     * One probe under the head, at once on the mock's clock: with `map`
     * the shift it finds against the map ties the map to the focus axis
     * frame in use; with `zero` the contact height becomes H 0.
     */
    async probeHere(request: TouchRequest): Promise<HeightMapState> {
        this.requireConnected();
        this.notOwned();
        const { mode, at } = touchOf(request);
        const machine = this.machine;
        if (mode === "map" && !this.heightmap) {
            throw new ApiError(400, "there is no height map to tie: probe the board, or probe here for H 0");
        }
        this.requireProbeReady();
        const settings = this.probeConfig;
        // The nearest clear point is picked, and the head sent over it, before the probe goes down.
        const nearest = at === "nearest" ? this.nearestClearTouch(request.job) : null;
        if (nearest) {
            this.line("tx", `go ${jointWords(nearest.joint.r, nearest.joint.a, nearest.joint.z)}`);
            this.probeGo(nearest.joint, null);
            this.line("rx", "ok");
        }
        const travel = machine.h;
        const line = `probe H-${gnum(settings.depth, 4)} F${gnum(settings.feed)}`;
        this.line("tx", line);
        const replies = probeReplies(machine, -settings.depth, settings.feed);
        for (const reply of replies) {
            this.line("rx", reply);
        }
        const report = /^\[PRB:(-?[\d.]+):([01])\]$/.exec(replies[0] ?? "");
        if (!report || report[2] !== "1") {
            this.message("error", `probing failed: the probe found nothing within ${formatG(settings.depth)} mm`);
            throw new ApiError(409, `the probe found nothing within ${formatG(settings.depth)} mm`);
        }
        const height = Number(report[1]);
        this.line("tx", `go H${formatFixed(travel, 4)}`);
        machine.h = travel;
        this.line("rx", "ok");
        if (mode === "zero") {
            this.line("tx", `set H${gnum(travel - height, 4)}`);
            machine.h = travel - height;
            this.line("rx", "ok");
            this.frameChanged("the surface was probed");
            this.message("info", `H 0 is now the surface probed here (it read ${height.toFixed(4)})`);
            this.emit({ type: "state", data: this.snapshot() });
            return this.heightMapState();
        }
        const map = this.heightmap!;
        const board = machine.headBoard();
        const x = nearest ? nearest.x : board.x + settings.offset[0];
        const y = nearest ? nearest.y : board.y + settings.offset[1];
        const grid = map.grid;
        const m = COVER_MARGIN;
        if (!(x >= grid.x0 - m && y >= grid.y0 - m && x <= grid.x1 + m && y <= grid.y1 + m)) {
            throw new ApiError(400, `probe over the map: the tip is at X ${x.toFixed(1)} Y ${y.toFixed(1)}`);
        }
        let mapped: number;
        try {
            mapped = heightAt(map, x, y);
        } catch (error) {
            throw new ApiError(400, errorText(error));
        }
        const shift = height - mapped;
        // The offset is the gap over the contact plus the frame's shift, measured from the gap, so a second tie changes nothing.
        let offset: number;
        let gap: number;
        if (map.focus_gap != null) {
            gap = map.focus_gap;
            offset = gap + shift;
        } else if (map.focus_set) {
            offset = map.focus_offset;
            gap = offset - shift;
        } else if (machine.milling()) {
            gap = 0;
            offset = shift;
        } else {
            throw new ApiError(400, "the map has never been focused: focus the beam by eye over it first (focus here)");
        }
        map.focus_offset = round4(offset);
        map.focus_gap = round4(gap);
        map.focus_set = true;
        map.focus_known = true;
        this.focusFrame = this.frame;
        this.emitHeightMap();
        this.message("info", `height map tied to this frame: the surface here reads ${height.toFixed(4)}, ${shift >= 0 ? "+" : ""}${shift.toFixed(4)} against the map`);
        return this.heightMapState();
    }

    private emitHeightMap(): void {
        this.emit({ type: "heightmap", data: this.heightMapState() });
    }

    async heightMap(): Promise<HeightMapState> {
        return this.heightMapState();
    }

    /**
     * Probes a grid of board points on the mock's clock, a fixed time per
     * point: the head goes over the point, touches, touches again slower,
     * and rises back to the height it had when probing began.
     */
    async probe(request: ProbeRequest): Promise<HeightMapState> {
        this.requireConnected();
        this.notOwned();
        const { grid, resume } = this.probeGridOf(request);
        this.requireProbeReady();
        const settings = structuredClone(this.probeConfig);
        // Every point is checked for reach before the first move, soft limits included.
        const xs = gridXs(grid);
        const ys = gridYs(grid);
        const order = resume ? gridOrder(grid).filter(([ix, iy]) => resume.heights[iy]?.[ix] === null) : gridOrder(grid);
        const joints = this.jointsForPoints(order.map(([ix, iy]) => [xs[ix] ?? 0, ys[iy] ?? 0]), settings, gridSpacing(grid) / 2);
        const map: HeightMap = resume ?? {
            grid: { x0: grid.x0, y0: grid.y0, x1: grid.x1, y1: grid.y1, nx: grid.nx, ny: grid.ny, mask: grid.mask ?? null },
            heights: Array.from({ length: grid.ny }, () => Array<number | null>(grid.nx).fill(null)),
            focus_offset: 0,
            focus_set: false,
            focus_known: false,
            probe_offset: [settings.offset[0], settings.offset[1]],
            created: createdNow(),
        };
        return this.startProbing({ map, resume: resume !== null, settings, joints, order, pads: null, total: gridPoints(grid) });
    }

    /**
     * Starts probing `map` with the head going over each point in turn at
     * `joints`: a grid's points in `order`, or a pad map's points by index
     * in `pads`, `total` points in all. The map replaces the one before it.
     */
    private startProbing(start: {
        map: HeightMap;
        /** The map is the stored one, gone on with where its last probing stopped. */
        resume: boolean;
        settings: ProbeSettings;
        joints: ProbeJoint[];
        order: [number, number][];
        pads: number[] | null;
        total: number;
    }): HeightMapState {
        const { map, resume, settings, joints, order, pads, total } = start;
        if (resume && this.heightsFrame !== this.frame) {
            throw new ApiError(400, "the focus axis was renumbered since the map was probed: probe it anew");
        }
        // A map probed before keeps its focus offset only if the probe has
        // not moved, the offset being contact to focus for that probe, and
        // its heights are in this focus axis frame.
        const previous = this.heightmap;
        const sameProbe = previous && previous.probe_offset[0] === settings.offset[0] && previous.probe_offset[1] === settings.offset[1];
        if (!resume && previous && sameProbe && this.heightsFrame === this.frame) {
            map.focus_offset = previous.focus_offset;
            map.focus_set = previous.focus_set;
            map.focus_known = previous.focus_known ?? false;
        }
        this.heightsFrame = this.frame;
        this.jogTracked = false;
        // The new map replaces the old one from the start, so its points fill in.
        this.heightmap = map;
        const progress: ProbeProgress = {
            state: "running",
            done: resume ? probedCount(map).probed : 0,
            total,
            point: null,
            ...(pads ? { pad: null } : {}),
            seconds: 0,
            error: null,
            estimate: Math.round((pads ?? order).length * PROBE_POINT_SECONDS * 10) / 10,
            remaining: null,
        };
        this.probeProgress = progress;
        const session: ProbeSession = { settings, order, joints, next: 0, pads, elapsed: 0, travel: this.probeTravel(this.machine.h), map, progress };
        this.probing = session;
        this.emitHeightMap();
        this.probeBegin(session);
        return this.heightMapState();
    }

    /** What probing needs of the machine: Idle, the focus axis, the probe clear of the board and the spindle still. */
    private requireProbeReady(): void {
        const machine = this.machine;
        if (machine.state !== "Idle") {
            throw new ApiError(409, `the machine is ${statusLine(machine)}, not Idle`);
        }
        if (!machine.hasFocusAxis()) {
            throw new ApiError(409, "the machine has no focus axis: set $h_axis=1 to probe");
        }
        if (machine.probeActive()) {
            throw new ApiError(409, "the probe is already touching: raise the head clear of the board first");
        }
        if (machine.milling() && machine.spindle > 0) {
            // The tool may be the probe: a turning one would cut at every touch.
            throw new ApiError(409, "the spindle is turning: stop it before probing");
        }
    }

    /**
     * The joints that put the probe tip over each point, every one checked
     * against the soft limits before the first move; `slack` lets a polar
     * point inside the tip's circle be probed from its edge.
     */
    private jointsForPoints(points: [number, number][], settings: ProbeSettings, slack: number): ProbeJoint[] {
        const machine = this.machine;
        const joints: ProbeJoint[] = [];
        const cartesian = machine.cartesian();
        const rMax = machine.settings["r_max"] ?? 0;
        const zMax = machine.settings["z_max"] ?? 0;
        let angle = machine.joint.a;
        for (const [x, y] of points) {
            const where = `the probe cannot reach (${x.toFixed(2)}, ${y.toFixed(2)}): the head would go to`;
            let joint: ProbeJoint;
            if (cartesian) {
                // The rail and the cross slide put the tip over the point; the table stays.
                const head = turned({ x, y }, -machine.frameAngle());
                joint = { r: head.x - settings.offset[0], a: machine.joint.a, z: head.y - settings.offset[1] };
                if (zMax > 0 && Math.abs(joint.z ?? 0) > zMax + 1e-9) {
                    throw new ApiError(409, `${where} Z${(joint.z ?? 0).toFixed(3)}, past the soft limit z_max=${formatG(zMax)}`);
                }
            } else {
                try {
                    joint = probeJoint([x, y], settings.offset, angle, slack);
                } catch (error) {
                    throw new ApiError(409, errorText(error));
                }
                angle = joint.a;
            }
            if (rMax > 0 && Math.abs(joint.r) > rMax + 1e-9) {
                throw new ApiError(409, `${where} R${joint.r.toFixed(3)}, past the soft limit r_max=${formatG(rMax)}`);
            }
            joints.push(joint);
        }
        return joints;
    }

    /**
     * The pads of a job probing would visit, as the backend picks them:
     * every pad of at least the area, the most spread out of them over the
     * count, in a short tour; or with `resume` the stored pad map's points
     * still without a height.
     */
    private padPlan(request: PadProbeRequest): { job: Job; map: HeightMap; order: number[]; skipped: number; resume: boolean; pads: number } {
        const job = this.requireJob(request.job);
        const minArea = request.min_area ?? MIN_AREA.fallback;
        const maxPoints = request.max_points ?? MAX_POINTS.fallback;
        if (!(Number.isFinite(minArea) && minArea >= MIN_AREA.low && minArea <= MIN_AREA.high)) {
            throw new ApiError(400, `min_area must be ${MIN_AREA.low} to ${MIN_AREA.high} mm^2`);
        }
        if (!(Number.isInteger(maxPoints) && maxPoints >= MAX_POINTS.low && maxPoints <= MAX_POINTS.high)) {
            throw new ApiError(400, `max_points must be a whole number from ${MAX_POINTS.low} to ${MAX_POINTS.high}`);
        }
        const pads = job.pads ?? [];
        const { points, skipped } = selectPads(pads, minArea, maxPoints);
        if (request.resume) {
            const map = this.heightmap;
            if (!map || !map.points || !map.point_heights) {
                throw new ApiError(400, "there is no pad map to go on with: probe the pads first");
            }
            const order = map.point_heights.map((height, index) => (height === null ? index : -1)).filter((index) => index >= 0);
            if (order.length === 0) {
                throw new ApiError(400, "the pad map is complete: nothing is left to probe");
            }
            return { job, map, order, skipped, resume: true, pads: pads.length };
        }
        if (pads.length === 0) {
            throw new ApiError(400, `${job.name} has no pads: a gerber or a KiCad board carries them`);
        }
        if (points.length === 0) {
            throw new ApiError(400, `no pad of ${job.name} is ${formatG(minArea)} mm^2 or more`);
        }
        const grid = padMapGrid(job, points);
        const settings = this.probeConfig;
        const map: HeightMap = {
            grid,
            heights: Array.from({ length: grid.ny }, () => Array<number | null>(grid.nx).fill(null)),
            focus_offset: 0,
            focus_set: false,
            focus_known: false,
            probe_offset: [settings.offset[0], settings.offset[1]],
            created: createdNow(),
            points,
            point_heights: points.map(() => null),
        };
        return { job, map, order: points.map((_, index) => index), skipped, resume: false, pads: pads.length };
    }

    async planPads(request: PadProbeRequest): Promise<PadProbePlan> {
        const plan = this.padPlan(request);
        const stored = this.heightmap;
        const skippable = stored?.points && stored.point_heights ? stored.point_heights.filter((height) => height !== null).length : 0;
        return {
            points: plan.order.map((index) => [plan.map.points![index]![0], plan.map.points![index]![1]]),
            pads: plan.pads,
            skipped: plan.skipped,
            seconds: Math.round(plan.order.length * PROBE_POINT_SECONDS * 10) / 10,
            resume: skippable,
        };
    }

    /** Probes the board at a job's pads on the mock's clock, as `probe` does a grid; the map is a pad map, its grid filled in from the pads. */
    async probePads(request: PadProbeRequest): Promise<HeightMapState> {
        this.requireConnected();
        this.notOwned();
        const plan = this.padPlan(request);
        this.requireProbeReady();
        const settings = structuredClone(this.probeConfig);
        const joints = this.jointsForPoints(plan.order.map((index) => plan.map.points![index]!), settings, 0);
        return this.startProbing({ map: plan.map, resume: plan.resume, settings, joints, order: [], pads: plan.order, total: plan.map.points?.length ?? 0 });
    }

    /** Where a touch would go down, and how the head gets there, without moving anything. */
    async planTouch(request: TouchRequest): Promise<TouchPlan> {
        this.requireConnected();
        if (touchOf(request).at === "nearest") {
            const found = this.nearestClearTouch(request.job);
            return {
                point: [round4(found.x), round4(found.y)],
                index: found.index,
                distance: Math.round(found.distance * 1000) / 1000,
                lines: [`go ${jointWords(found.joint.r, found.joint.a, found.joint.z)}`],
            };
        }
        const board = this.machine.headBoard();
        const offset = this.probeConfig.offset;
        return { point: [round4(board.x + offset[0]), round4(board.y + offset[1])], index: null, distance: 0, lines: [] };
    }

    /**
     * The probed point of the map nearest the tip that no cut of the job
     * (the one named, else the last run's) comes within the clearance of,
     * with the joint that puts the tip over it, checked for reach.
     */
    private nearestClearTouch(jobId: string | undefined): { x: number; y: number; index: [number, number]; distance: number; joint: ProbeJoint } {
        const map = this.heightmap;
        if (!map) {
            throw new ApiError(400, "there is no height map to tie: probe the board, or probe here for H 0");
        }
        const id = jobId ?? this.resumeRecordOf()?.job ?? undefined;
        if (!id) {
            throw new ApiError(400, "the nearest point clear of the cuts needs a job: load one, or run one first");
        }
        const job = this.jobStore.get(id);
        if (!job) {
            throw new ApiError(404, "no such job");
        }
        const machine = this.machine;
        const settings = this.probeConfig;
        const board = machine.headBoard();
        const tip = { x: board.x + settings.offset[0], y: board.y + settings.offset[1] };
        const clearance = TOUCH_CLEARANCE + (job.spot || 0) / 2;
        const cuts: [Board, Board][] = [];
        for (const group of job.groups) {
            if (!group.enabled) {
                continue;
            }
            for (const path of group.paths) {
                const first = path[0];
                if (path.length === 1 && first) {
                    cuts.push([{ x: first[0], y: first[1] }, { x: first[0], y: first[1] }]);
                }
                for (let i = 1; i < path.length; i++) {
                    const a = path[i - 1]!;
                    const b = path[i]!;
                    cuts.push([{ x: a[0], y: a[1] }, { x: b[0], y: b[1] }]);
                }
            }
        }
        const xs = gridXs(map.grid);
        const ys = gridYs(map.grid);
        let best: { x: number; y: number; index: [number, number]; distance: number } | null = null;
        for (let iy = 0; iy < map.grid.ny; iy++) {
            for (let ix = 0; ix < map.grid.nx; ix++) {
                if (map.heights[iy]?.[ix] == null) {
                    continue;
                }
                const x = xs[ix] ?? 0;
                const y = ys[iy] ?? 0;
                const distance = Math.hypot(x - tip.x, y - tip.y);
                if (best && distance >= best.distance) {
                    continue;
                }
                if (cuts.some(([a, b]) => distanceToSegment(x, y, a, b).distance < clearance)) {
                    continue;
                }
                best = { x, y, index: [ix, iy], distance };
            }
        }
        if (!best) {
            throw new ApiError(400, `no probed point of the map is ${formatG(clearance)} mm clear of the job's cuts: jog the tip over copper the map covers and probe here`);
        }
        // Reached as a probing reaches its points, soft limits included.
        const joint = this.jointsForPoints([[best.x, best.y]], settings, 0)[0]!;
        return { ...best, joint };
    }

    async probeStop(): Promise<HeightMapState> {
        const session = this.probing;
        if (!session) {
            throw new ApiError(409, "nothing is being probed");
        }
        this.halt();
        this.probeFinish(session, "stopped", null);
        this.emit({ type: "state", data: this.snapshot() });
        return this.heightMapState();
    }

    /**
     * Sets the focus offset: the head's height less the map's height under
     * the beam, which ties the map to the focus axis frame in use whatever
     * frame its heights were probed in; or given as a number, a plain
     * distance from contact to focus that holds only for heights probed in
     * this frame.
     */
    async focus(offset: number | null): Promise<HeightMapState> {
        this.refuseWhileProbing();
        const map = this.heightmap;
        if (!map) {
            throw new ApiError(400, "there is no height map: probe the board first");
        }
        let value = offset;
        if (value === null) {
            this.requireConnected();
            const machine = this.machine;
            if (machine.state !== "Idle") {
                throw new ApiError(400, `the machine is ${machine.state}: focus with the head at rest`);
            }
            // Without a focus axis the head's height is fixed, and zero is
            // as good a name for it as any: the map only needs the same one.
            const here = machine.hasFocusAxis() ? machine.h : 0;
            const board = machine.headBoard();
            const grid = map.grid;
            const m = COVER_MARGIN;
            if (!(board.x >= grid.x0 - m && board.y >= grid.y0 - m && board.x <= grid.x1 + m && board.y <= grid.y1 + m)) {
                // The edge height would stand in for copper nobody measured.
                const f = (v: number): string => v.toFixed(1);
                throw new ApiError(
                    400,
                    `focus over the probed area: the beam is at X ${f(board.x)} Y ${f(board.y)}, the map covers` +
                        ` X ${f(grid.x0)}..${f(grid.x1)} Y ${f(grid.y0)}..${f(grid.y1)}`,
                );
            }
            try {
                value = here - heightAt(map, board.x, board.y);
            } catch (error) {
                throw new ApiError(400, errorText(error));
            }
        } else if (this.heightsFrame !== this.frame) {
            throw new ApiError(
                400,
                "the map was probed before the focus axis was last renumbered (a connect, a restart," +
                    " a position set or a map put back): use focus here over the map, or probe again",
            );
        }
        if (!Number.isFinite(value)) {
            throw new ApiError(422, "offset must be a finite number");
        }
        if (Math.abs(value) > MAX_VALUE) {
            throw new ApiError(400, `focus_offset must be within ${MAX_VALUE_TEXT} mm`);
        }
        map.focus_offset = round4(value);
        // In the heights' own frame the offset is the gap itself; set in another, the gap waits for a tie.
        map.focus_gap = this.heightsFrame === this.frame ? round4(value) : null;
        map.focus_set = true;
        map.focus_known = true;
        this.focusFrame = this.frame;
        this.emitHeightMap();
        return this.heightMapState();
    }

    async keepFocus(): Promise<HeightMapState> {
        this.refuseWhileProbing();
        const map = this.heightmap;
        if (!map) {
            throw new ApiError(400, "there is no height map: probe the board first");
        }
        if (!map.focus_known) {
            throw new ApiError(400, "the map has never been focused, so there is no offset to keep: focus here");
        }
        map.focus_set = true;
        this.focusFrame = this.frame;
        const what = this.machine.milling() ? "touch-off" : "focus";
        this.message("info", `kept the height map's ${what} offset ${map.focus_offset.toFixed(4)} from before`);
        this.emitHeightMap();
        return this.heightMapState();
    }

    async probeSettings(patch: Partial<ProbeSettings>): Promise<HeightMapState> {
        const current = this.probeConfig;
        const next: ProbeSettings = {
            depth: patch.depth ?? current.depth,
            feed: patch.feed ?? current.feed,
            slow: patch.slow ?? current.slow,
            backoff: patch.backoff ?? current.backoff,
            offset: patch.offset ? [patch.offset[0], patch.offset[1]] : [current.offset[0], current.offset[1]],
            rayleigh: patch.rayleigh ?? current.rayleigh,
        };
        try {
            checkProbeSettings(next);
        } catch (error) {
            throw new ApiError(400, errorText(error));
        }
        this.probeConfig = next;
        this.machine.probeOffset = [next.offset[0], next.offset[1]];
        this.emitHeightMap();
        return this.heightMapState();
    }

    /**
     * Puts back a map, from a file say. Its heights are from a session whose
     * focus axis frame nothing here knows, so it needs focus here before a
     * run follows it, whatever it says of its offset.
     */
    async putHeightMap(map: HeightMap): Promise<HeightMapState> {
        this.refuseWhileProbing();
        const read = readHeightMap(map);
        try {
            checkHeightMap(read);
        } catch (error) {
            throw new ApiError(400, errorText(error));
        }
        read.focus_set = false;
        this.heightmap = read;
        this.heightsFrame = null;
        this.emitHeightMap();
        return this.heightMapState();
    }

    async clearHeightMap(): Promise<HeightMapState> {
        this.refuseWhileProbing();
        this.heightmap = null;
        this.heightsFrame = null;
        this.emitHeightMap();
        return this.heightMapState();
    }

    private serviceProbe(dt: number): void {
        const session = this.probing;
        if (!session) {
            return;
        }
        session.progress.seconds += dt;
        session.elapsed += dt;
        while (this.probing === session && session.elapsed >= PROBE_POINT_SECONDS - CLOCK_EPSILON) {
            session.elapsed -= PROBE_POINT_SECONDS;
            this.probePoint(session);
        }
    }

    /** Sends the head over the next point, or ends the probing when every point is done. */
    private probeBegin(session: ProbeSession): void {
        const point = session.pads ? null : session.order[session.next];
        const pad = session.pads ? session.pads[session.next] : null;
        const joint = session.joints[session.next];
        if ((point === undefined && pad === undefined) || !joint) {
            session.progress.point = null;
            session.progress.pad = null;
            this.probeFinish(session, "done", null);
            return;
        }
        session.progress.point = point ?? null;
        session.progress.pad = pad ?? null;
        this.emitHeightMap();
        const words = jointWords(joint.r, joint.a, joint.z);
        this.probeRequest(session, `go ${words}`, () => this.probeGo(joint, null));
    }

    /** Touches the point in progress, records it, and goes on to the next. */
    private probePoint(session: ProbeSession): void {
        const point = session.pads ? null : session.order[session.next];
        const pad = session.pads ? session.pads[session.next] : null;
        if (point === undefined && pad === undefined) {
            return;
        }
        const { depth, feed, slow, backoff } = session.settings;
        let height = this.probeTouch(session, feed, depth);
        if (height === null) {
            return;
        }
        if (slow > 0) {
            const above = height + backoff;
            if (!this.probeRequest(session, `go H${formatFixed(above, 4)}`, () => this.probeGo(null, above))) {
                return;
            }
            height = this.probeTouch(session, slow, 2 * backoff);
            if (height === null) {
                return;
            }
        }
        if (!this.probeRequest(session, `go H${formatFixed(session.travel, 4)}`, () => this.probeGo(null, session.travel))) {
            return;
        }
        if (pad !== null && pad !== undefined && session.map.point_heights) {
            // A pad's height goes into the pad map, and the grid is filled in
            // from every pad probed so far.
            session.map.point_heights[pad] = round4(height);
            fillPadHeights(session.map);
        } else if (point) {
            const [ix, iy] = point;
            const row = session.map.heights[iy];
            if (row) {
                row[ix] = round4(height);
            }
        }
        session.progress.done += 1;
        session.next += 1;
        this.emitHeightMap();
        this.probeBegin(session);
    }

    /** One probe down; the height at contact, or null when the probing has failed. */
    private probeTouch(session: ProbeSession, feed: number, distance: number): number | null {
        const replies = this.probeRequest(session, `probe H-${gnum(distance, 4)} F${gnum(feed)}`, () => probeReplies(this.machine, -distance, feed));
        if (replies === null) {
            return null;
        }
        const report = /^\[PRB:(-?[\d.]+):([01])\]$/.exec(replies[0] ?? "");
        if (!report) {
            this.probeFail(session, `no probe result in ${replies.join(", ")}`);
            return null;
        }
        if (report[2] !== "1") {
            this.probeFail(session, `the probe found nothing within ${formatG(distance)} mm`);
            return null;
        }
        return Number(report[1]);
    }

    /**
     * A positioning line of the probing, done at once: the mock spends its
     * fixed time per point instead of the travel. The soft limits hold as
     * they hold for any line.
     */
    private probeGo(joint: ProbeJoint | null, h: number | null): string[] {
        const machine = this.machine;
        if (h !== null && !machine.hasFocusAxis()) {
            throw new MachineError(2, "bad word");
        }
        machine.requireIdle();
        if (joint) {
            machine.checkReach(joint.r, joint.z);
            machine.joint = { r: joint.r, a: joint.a };
            machine.z = joint.z ?? machine.z;
        }
        if (h !== null) {
            machine.h = h;
        }
        machine.enabled = true;
        return ["ok"];
    }

    /** One line of the probing, logged both ways; anything but ok fails the probing. Null once it has failed. */
    private probeRequest(session: ProbeSession, line: string, action: () => string[]): string[] | null {
        this.line("tx", line);
        let replies: string[];
        try {
            replies = action();
        } catch (error) {
            if (!(error instanceof MachineError)) {
                throw error;
            }
            replies = [error.message];
        }
        for (const reply of replies) {
            this.line("rx", reply);
        }
        const answer = replies[replies.length - 1] ?? "";
        if (answer !== "ok") {
            this.probeFail(session, `'${line}': ${answer}`);
            return null;
        }
        return replies;
    }

    /** A missed probe has raised the alarm and stopped; anything else is halted the way a stop halts it. */
    private probeFail(session: ProbeSession, reason: string): void {
        if (this.machine.state !== "Alarm") {
            this.halt();
        }
        this.message("error", `probing failed: ${reason}`);
        this.probeFinish(session, "error", reason);
    }

    private probeFinish(session: ProbeSession, state: ProbeProgress["state"], error: string | null): void {
        if (this.probing !== session) {
            return;
        }
        this.probing = null;
        session.progress.state = state;
        session.progress.error = error;
        this.emitHeightMap();
    }

    // Camera.

    private emitCamera(): void {
        this.emit({ type: "camera", data: this.cameraStateOf() });
    }

    /** The picture's center on the board: the tool's point plus the camera's real offset, whatever the settings say. */
    private pictureCenter(): Board {
        const tool = this.machine.headBoard();
        return { x: tool.x + CAMERA_TRUTH.offset[0], y: tool.y + CAMERA_TRUTH.offset[1] };
    }

    private poseOf(): CameraPose | null {
        if (!this.cameraRunning) {
            return null;
        }
        const job = this.cameraJob ? this.jobStore.get(this.cameraJob) : undefined;
        if (!job || !this.placement) {
            return { state: "none" };
        }
        return boardPose(this.pictureCenter(), job, this.placement, CAMERA_TRUTH, this.cameraConfig.size);
    }

    private cameraStateOf(): CameraState {
        const [width, height] = parseSize(this.cameraConfig.size);
        return {
            ...this.cameraConfig,
            offset: [this.cameraConfig.offset[0], this.cameraConfig.offset[1]],
            running: this.cameraRunning,
            board: this.cameraJob,
            mark: this.cameraMarkPoint ? [this.cameraMarkPoint.x, this.cameraMarkPoint.y] : null,
            frame: this.cameraRunning ? { width, height, age_ms: POSE_AGE_MS, fps: POSE_FPS } : null,
            pose: this.poseOf(),
            routine: this.routine ? structuredClone(this.routine) : null,
            board_look: this.headLook.state(),
            controls: { ...this.keptControls.head },
        };
    }

    async cameras(): Promise<CamerasResponse> {
        return { cameras: structuredClone(MOCK_CAMERAS), problems: [] };
    }

    async camera(): Promise<CameraState> {
        return this.cameraStateOf();
    }

    async cameraSettings(patch: Partial<CameraSettings>): Promise<CameraState> {
        try {
            checkCameraSettings(patch);
        } catch (error) {
            throw new ApiError(400, errorText(error));
        }
        const next: CameraSettings = { ...this.cameraConfig, offset: [this.cameraConfig.offset[0], this.cameraConfig.offset[1]] };
        if (patch.device !== undefined) {
            next.device = patch.device;
        }
        if (patch.size !== undefined) {
            next.size = patch.size;
        }
        if (patch.fps !== undefined) {
            next.fps = patch.fps;
        }
        if (patch.pcbv !== undefined) {
            next.pcbv = patch.pcbv;
        }
        if (patch.side !== undefined) {
            next.side = patch.side;
        }
        if (patch.finish !== undefined) {
            next.finish = patch.finish;
        }
        if (patch.offset !== undefined) {
            next.offset = [patch.offset[0], patch.offset[1]];
        }
        if (patch.roll !== undefined) {
            next.roll = patch.roll;
        }
        if (patch.mm_per_px !== undefined) {
            next.mm_per_px = patch.mm_per_px;
        }
        if (patch.look_threshold !== undefined) {
            next.look_threshold = patch.look_threshold;
        }
        if (patch.corner_mm !== undefined) {
            next.corner_mm = patch.corner_mm;
        }
        // A running camera starts again on other capture settings, as the
        // backend's does, but not under the find routine.
        const restart = this.cameraRunning && CAPTURE_KEYS.some((key) => next[key] !== this.cameraConfig[key]);
        if (restart && (this.finding || this.headSearch)) {
            throw new ApiError(409, "the camera is finding the mark: abort that first");
        }
        this.cameraConfig = next;
        this.emitCamera();
        return this.cameraStateOf();
    }

    async cameraStart(): Promise<CameraState> {
        if (this.cameraRunning) {
            throw new ApiError(409, "the camera is running");
        }
        this.cameraRunning = true;
        this.message("info", `camera started on ${this.cameraConfig.device} (mock)`);
        this.emitCamera();
        return this.cameraStateOf();
    }

    async cameraStop(): Promise<CameraState> {
        if (this.finding || this.headSearch) {
            throw new ApiError(409, "the camera offset routine is running: abort it first");
        }
        this.cameraRunning = false;
        this.cameraJob = null;
        this.headLook.stop();
        this.emitCamera();
        return this.cameraStateOf();
    }

    /** The picture as the mock draws it now: the loaded board where it really lies, the mark, the crosshair and, with `overlay`, the pose. */
    cameraFrameUrl(width: number, overlay: boolean): string {
        const size = frameWidth(width);
        const job = this.cameraJob ? this.jobStore.get(this.cameraJob) : undefined;
        const placement = this.placement;
        const real = (point: Board): Board => (job && placement ? placedPoint(designPoint(point, jobPlacement(job)), placement) : point);
        const pads = job && placement ? (job.pads ?? []).map(([x, y, area]) => {
            const at = real({ x, y });
            return [at.x, at.y, area] as [number, number, number];
        }) : [];
        const outline = job && placement ? job.outline.map((path) => path.map(([x, y]) => {
            const at = real({ x, y });
            return [at.x, at.y] as Point;
        })) : [];
        return frameSvg({
            center: this.pictureCenter(),
            truth: CAMERA_TRUTH,
            size: this.cameraConfig.size,
            pads,
            outline,
            mark: this.cameraMarkPoint,
            finish: this.cameraConfig.finish,
            pose: this.poseOf(),
        }, size, overlay);
    }

    async cameraPose(): Promise<CameraPose> {
        return this.poseOf() ?? { state: null };
    }

    async cameraBoard(jobId: string | null): Promise<CameraState> {
        if (jobId === null) {
            this.cameraJob = null;
            this.placement = null;
            this.headLook.stop();
            this.emitCamera();
            return this.cameraStateOf();
        }
        const job = this.requireJob(jobId);
        if (!job.design?.board) {
            throw new ApiError(400, `${job.name} has no board file: upload the .kicad_pcb for the camera to look for it`);
        }
        // The board really lies a little off the job's design, where it lay
        // the first time it was looked for: aligning the job moves the job,
        // not the board.
        let placement = this.placements.get(jobId);
        if (!placement) {
            const design = jobPlacement(job);
            placement = {
                shift: [design.shift[0] + BOARD_MISPLACEMENT.shift[0], design.shift[1] + BOARD_MISPLACEMENT.shift[1]],
                rotation: design.rotation + BOARD_MISPLACEMENT.rotation,
            };
            this.placements.set(jobId, placement);
        }
        this.cameraJob = jobId;
        this.placement = placement;
        this.headLook.start(jobId);
        this.emitCamera();
        return this.cameraStateOf();
    }

    /**
     * A mark to measure the camera against: a drill of one point where the
     * tool stands, stored as a job named camera mark and run, or with
     * `here` only the tool's point recorded.
     */
    async cameraMark(request: MarkRequest): Promise<CameraState> {
        this.requireConnected();
        if (request.here) {
            this.notOwned();
            const point = this.machine.headBoard();
            this.cameraMarkPoint = { x: round4(point.x), y: round4(point.y) };
            this.message("info", `mark recorded at X ${gnum(point.x)} Y ${gnum(point.y)}`);
            this.emitCamera();
            return this.cameraStateOf();
        }
        if (!this.machine.milling()) {
            throw new ApiError(400, "a mark is cut with a spindle: this machine has none, so record the tool's point over a mark made by hand");
        }
        if (!this.machine.hasFocusAxis()) {
            throw new ApiError(400, "a mark needs the focus axis as the depth axis: set $h_axis=1");
        }
        const depth = request.depth ?? 0.1;
        const plunge = request.plunge ?? 30;
        if (!(Number.isFinite(depth) && depth >= 0.01 && depth <= 5)) {
            throw new ApiError(400, "depth must be 0.01 to 5 mm");
        }
        if (!(Number.isFinite(plunge) && plunge >= 1 && plunge <= 1000)) {
            throw new ApiError(400, "plunge must be 1 to 1000 mm/min");
        }
        this.notOwned();
        const point = this.machine.headBoard();
        const id = this.newId();
        const groups: Group[] = [{
            label: "camera mark",
            power: this.machine.settings["s_max"] ?? 1000,
            min_power: 0,
            speed: plunge,
            passes: 1,
            enabled: true,
            depth,
            plunge,
            tool: "spindle",
            paths: [[[point.x, point.y]]],
        }];
        const job: Job = {
            id,
            name: "camera mark",
            source: "mark",
            spot: 0.1,
            offset: { x: 0, y: 0 },
            rotation: 0,
            pads: [],
            holes: [],
            design: null,
            groups,
            outline: [],
            copper: [],
            stats: computeStats(groups, this.limits()),
        };
        this.jobStore.set(id, job);
        this.order.push(id);
        await this.runJob(id);
        this.cameraMarkPoint = { x: round4(point.x), y: round4(point.y) };
        this.emitCamera();
        return this.cameraStateOf();
    }

    async cameraFind(step: number): Promise<CameraState> {
        this.requireConnected();
        if (!this.cameraRunning) {
            throw new ApiError(400, "the camera is not running: start it first");
        }
        if (!this.cameraMarkPoint) {
            throw new ApiError(400, "there is no mark: make one with the tool, or record the tool's point over one");
        }
        if (!(Number.isFinite(step) && step >= 0 && step <= 20)) {
            throw new ApiError(400, "step must be 0 to 20 mm");
        }
        this.notOwned();
        if (this.machine.state !== "Idle" || this.outbox.length > 0) {
            throw new ApiError(409, `the machine is ${statusLine(this.machine)}, not Idle`);
        }
        const scale = step > 0 || !(this.cameraConfig.mm_per_px > 0);
        const focus = this.machine.hasFocusAxis();
        const total = (focus ? 1 : 0) + 1 + (scale ? 1 : 0) + CENTERING_MOVES;
        const progress: CameraRoutine = { state: "running", step: focus ? "lifting" : "moving", done: 0, total, error: null, spot: null };
        this.routine = progress;
        this.finding = { mark: { ...this.cameraMarkPoint }, step: scale ? (step > 0 ? step : DEFAULT_FIND_STEP) : 0, phase: progress.step, centered: 0, elapsed: 0, progress };
        this.jogTracked = false;
        this.emitCamera();
        return this.cameraStateOf();
    }

    async cameraAbort(): Promise<CameraState> {
        const search = this.headSearch;
        if (search) {
            this.headSearch = null;
            search.progress.state = "stopped";
            search.progress.error = "stopped";
            this.halt();
            this.emitCamera();
            return this.cameraStateOf();
        }
        const session = this.finding;
        if (!session) {
            throw new ApiError(409, "no camera offset routine is running");
        }
        this.halt();
        this.findFinish(session, "stopped", null);
        this.emit({ type: "state", data: this.snapshot() });
        return this.cameraStateOf();
    }

    private serviceFind(dt: number): void {
        const session = this.finding;
        if (!session) {
            return;
        }
        session.elapsed += dt;
        while (this.finding === session && session.elapsed >= FIND_STEP_SECONDS - CLOCK_EPSILON) {
            session.elapsed -= FIND_STEP_SECONDS;
            this.findStep(session);
        }
    }

    /** The mark's place in the picture now: pixels from the center, y down, and its distance in mm; null once it is out of the picture. */
    private spotNow(mark: Board): { dx: number; dy: number; mm: number } | null {
        const center = this.pictureCenter();
        const p = picturePoint(mark, center, CAMERA_TRUTH.roll, CAMERA_TRUTH.mmPerPx);
        if (!inPicture(p.px, p.py, this.cameraConfig.size)) {
            return null;
        }
        return { dx: Math.round(p.px * 10) / 10, dy: Math.round(p.py * 10) / 10, mm: round4(Math.hypot(mark.x - center.x, mark.y - center.y)) };
    }

    /** One line of the routine, taken at once and logged both ways; false once the routine has failed on it. */
    private findRequest(session: FindSession, line: string, action: () => void): boolean {
        this.line("tx", line);
        try {
            action();
        } catch (error) {
            if (!(error instanceof MachineError)) {
                throw error;
            }
            this.line("rx", error.message);
            this.findFail(session, `'${line}': ${error.message}`);
            return false;
        }
        this.line("rx", "ok");
        return true;
    }

    /** Puts the head's board point at `target`, at once. */
    private findMoveTo(session: FindSession, target: Board): boolean {
        const machine = this.machine;
        const over = this.jointOver(target, machine.joint);
        const joint: ProbeJoint = machine.cartesian() ? { r: over.r, a: machine.joint.a, z: over.z } : { r: over.r, a: over.a };
        const words = jointWords(joint.r, joint.a, joint.z);
        return this.findRequest(session, `go ${words}`, () => {
            this.probeGo(joint, null);
        });
    }

    private findMoveBy(session: FindSession, delta: Board): boolean {
        const here = this.machine.headBoard();
        return this.findMoveTo(session, { x: here.x + delta.x, y: here.y + delta.y });
    }

    private findAdvance(session: FindSession, next: RoutineStep): void {
        session.progress.done += 1;
        session.phase = next;
        session.progress.step = next;
        this.emitCamera();
    }

    /**
     * One step of the routine: the head lifts to the travel height, goes
     * where the camera should see the mark, moves a step along +X and back
     * to read the scale and the roll off how the spot moved, then moves by
     * the spot's distance from the center until it is within the tolerance,
     * and the offset is the mark less the tool's point.
     */
    private findStep(session: FindSession): void {
        const progress = session.progress;
        const config = this.cameraConfig;
        switch (session.phase) {
            case "lifting": {
                const travel = round4(this.clearance);
                if (!this.findRequest(session, `go H${formatFixed(travel, 4)}`, () => {
                    this.probeGo(null, travel);
                })) {
                    return;
                }
                this.findAdvance(session, "moving");
                return;
            }
            case "moving": {
                if (!this.findMoveTo(session, { x: session.mark.x - config.offset[0], y: session.mark.y - config.offset[1] })) {
                    return;
                }
                const spot = this.spotNow(session.mark);
                if (!spot) {
                    this.findFail(session, "no dark spot in the picture: the mark is not where the offset in force puts it");
                    return;
                }
                progress.spot = spot;
                this.findAdvance(session, session.step > 0 ? "scale" : "centering");
                return;
            }
            case "scale": {
                const before = this.spotNow(session.mark);
                if (!before || !this.findMoveBy(session, { x: session.step, y: 0 })) {
                    if (!before) {
                        this.findFail(session, "the spot was lost before the scale was measured");
                    }
                    return;
                }
                const after = this.spotNow(session.mark);
                if (!after) {
                    this.findFail(session, `the spot was lost when the head moved ${formatG(session.step)} mm along X`);
                    return;
                }
                const ddx = after.dx - before.dx;
                const ddy = after.dy - before.dy;
                const pixels = Math.hypot(ddx, ddy);
                if (pixels < 1e-6) {
                    this.findFail(session, "the spot did not move in the picture");
                    return;
                }
                // The head moved +X, so the spot moved -X in the board frame:
                // its move in the picture, turned over and by the roll, is
                // -X, which fixes the roll.
                config.mm_per_px = Math.round((session.step / pixels) * 1e6) / 1e6;
                config.roll = round4(wrapAngle(180 - (Math.atan2(-ddy, ddx) * 180) / Math.PI));
                if (!this.findMoveBy(session, { x: -session.step, y: 0 })) {
                    return;
                }
                progress.spot = this.spotNow(session.mark) ?? after;
                this.findAdvance(session, "centering");
                return;
            }
            case "centering": {
                const spot = this.spotNow(session.mark);
                if (!spot) {
                    this.findFail(session, "the spot was lost while centering");
                    return;
                }
                progress.spot = spot;
                if (spot.mm <= CENTER_TOLERANCE) {
                    // The picture's center is on the mark: the offset is the
                    // mark less the tool's point.
                    const tool = this.machine.headBoard();
                    config.offset = [round4(session.mark.x - tool.x), round4(session.mark.y - tool.y)];
                    progress.done = progress.total;
                    progress.step = "done";
                    this.message("info", `camera offset measured: X ${gnum(config.offset[0])} Y ${gnum(config.offset[1])}, roll ${gnum(config.roll, 4)} deg, ${gnum(config.mm_per_px, 6)} mm/px`);
                    this.findFinish(session, "done", null);
                    return;
                }
                if (session.centered >= CENTERING_MOVES) {
                    this.findFail(session, `the spot is still ${gnum(spot.mm, 3)} mm from the center after ${CENTERING_MOVES} moves`);
                    return;
                }
                if (!this.findMoveBy(session, boardVector(spot.dx, spot.dy, config.roll, config.mm_per_px))) {
                    return;
                }
                session.centered += 1;
                progress.done += 1;
                this.emitCamera();
                return;
            }
            case "done":
                return;
        }
    }

    private findFail(session: FindSession, reason: string): void {
        if (this.machine.state !== "Alarm") {
            this.halt();
        }
        this.message("error", `camera offset routine failed: ${reason}`);
        this.findFinish(session, "error", reason);
    }

    private findFinish(session: FindSession, state: CameraRoutine["state"], error: string | null): void {
        if (this.finding !== session) {
            return;
        }
        this.finding = null;
        session.progress.state = state;
        session.progress.error = error;
        this.emitCamera();
    }

    // Alignment.

    private alignStateOf(): AlignState {
        return { job: this.alignJob, marks: structuredClone(this.alignMarks), fit: this.alignFitLast ? structuredClone(this.alignFitLast) : null };
    }

    private emitAlign(): void {
        this.emit({ type: "align", data: this.alignStateOf() });
    }

    /** Marks for another job are replaced: they are kept for one job at a time. */
    private takeMarksFor(jobId: string): void {
        if (this.alignJob !== jobId) {
            this.alignJob = jobId;
            this.alignMarks = [];
            this.alignFitLast = null;
        }
    }

    /** The fit of the marks for `job`, the residuals written back to them; refused with the backend's words. */
    private fitMarks(job: Job): AlignFit {
        if (this.alignMarks.length === 0) {
            throw new ApiError(400, "there are no marks: mark a pad, a hole or a point first");
        }
        if (this.alignJob !== job.id) {
            throw new ApiError(400, `the marks are for job ${this.alignJob}, not ${job.id}`);
        }
        const marks = this.alignMarks;
        // A lone camera mark gives the turn: the board's angle it saw against the job's.
        const first = marks[0]!;
        const fixed = marks.length === 1 && first.angle !== null ? first.angle - (job.design?.rotation ?? job.rotation ?? 0) : null;
        const fit = fitRigid(marks.map((mark) => ({ design: mark.design, machine: mark.machine })), fixed);
        marks.forEach((mark, index) => {
            mark.residual = round4(fit.residuals[index] ?? 0);
        });
        const out: AlignFit = {
            rotation: round4(fit.rotation),
            shift: [round4(fit.shift[0]), round4(fit.shift[1])],
            scale: Math.round(fit.scale * 1e6) / 1e6,
            rms: round4(fit.rms),
            residuals: fit.residuals.map((value) => round4(value)),
            marks: marks.length,
        };
        this.alignFitLast = out;
        return out;
    }

    private refit(): void {
        const job = this.alignJob ? this.jobStore.get(this.alignJob) : undefined;
        if (job && this.alignMarks.length > 0) {
            this.fitMarks(job);
        } else {
            this.alignFitLast = null;
        }
    }

    async align(): Promise<AlignState> {
        return this.alignStateOf();
    }

    async alignMark(request: AlignMarkRequest): Promise<AlignState> {
        this.requireConnected();
        this.notOwned();
        const job = this.requireJob(request.job);
        const within = request.within ?? 5;
        if (!(Number.isFinite(within) && within >= 0.1 && within <= 100)) {
            throw new ApiError(400, "within must be 0.1 to 100 mm");
        }
        const tool = this.machine.headBoard();
        const machine: [number, number] = [round4(tool.x), round4(tool.y)];
        let mark: AlignMark;
        if (request.design) {
            const [x, y] = request.design;
            if (![x, y].every((v) => typeof v === "number" && Number.isFinite(v))) {
                throw new ApiError(400, "design must be two numbers");
            }
            mark = { design: [x, y], machine, source: "tool", kind: "point", distance: 0, angle: null, residual: null };
        } else {
            const nearest = request.nearest ?? null;
            if (nearest !== "pad" && nearest !== "hole") {
                throw new ApiError(400, "give a design point, or nearest pad or hole");
            }
            const candidates = nearest === "pad" ? job.pads ?? [] : job.holes ?? [];
            if (candidates.length === 0) {
                throw new ApiError(400, `${job.name} has no ${nearest}s`);
            }
            let best: [number, number, number] | null = null;
            let bestDistance = Infinity;
            for (const candidate of candidates) {
                const distance = Math.hypot(candidate[0] - tool.x, candidate[1] - tool.y);
                if (distance < bestDistance) {
                    bestDistance = distance;
                    best = candidate;
                }
            }
            if (!best || bestDistance > within) {
                throw new ApiError(400, `no ${nearest} within ${formatG(within)} mm of the tool`);
            }
            mark = { design: [best[0], best[1]], machine, source: "tool", kind: nearest, distance: round4(bestDistance), angle: null, residual: null };
        }
        this.takeMarksFor(job.id);
        this.alignMarks.push(mark);
        this.refit();
        this.emitAlign();
        return this.alignStateOf();
    }

    async alignCapture(jobId: string): Promise<AlignState> {
        this.requireConnected();
        this.notOwned();
        const job = this.requireJob(jobId);
        const best = this.cameraRunning && this.cameraJob === job.id && this.headLook.job === job.id && this.headLook.found ? this.headLook.best : null;
        const corners = this.headLook.cornersOf(job.id);
        if (best !== null || corners.length > 0) {
            // The board found: its middle where the most likely guess puts
            // it, and its turn; else a mark at each corner taken.
            const middle = jobSize(job).middle;
            const marks: AlignMark[] = best !== null
                ? [{ design: [round4(middle.x), round4(middle.y)], machine: [best.center[0], best.center[1]], source: "camera", kind: "center", distance: 0, angle: this.cameraConfig.side === "front" ? best.rotation : null, residual: null }]
                : corners.map((corner) => ({ design: [corner.job[0], corner.job[1]], machine: [corner.machine[0], corner.machine[1]], source: "camera", kind: "center", distance: 0, angle: null, residual: null }));
            this.takeMarksFor(job.id);
            this.alignMarks.push(...marks);
            this.refit();
            this.emitAlign();
            return this.alignStateOf();
        }
        if (!this.cameraRunning) {
            throw new ApiError(409, "the camera is not running");
        }
        if (this.cameraJob !== job.id) {
            throw new ApiError(409, `the camera is not looking for the board of ${job.name}: load it first`);
        }
        const pose = this.poseOf();
        if (!pose || pose.state !== "locked" || !pose.job_center) {
            throw new ApiError(409, "the camera has no lock on the board: put it over the board first");
        }
        const tool = this.machine.headBoard();
        const offset = this.cameraConfig.offset;
        const mark: AlignMark = {
            design: [pose.job_center[0], pose.job_center[1]],
            machine: [round4(tool.x + offset[0]), round4(tool.y + offset[1])],
            source: "camera",
            kind: "center",
            distance: 0,
            angle: round4(this.cameraConfig.roll - (pose.angle_deg ?? 0)),
            residual: null,
        };
        this.takeMarksFor(job.id);
        this.alignMarks.push(mark);
        this.refit();
        this.emitAlign();
        return this.alignStateOf();
    }

    async alignDeleteMark(index: number): Promise<AlignState> {
        if (!Number.isInteger(index) || index < 0 || index >= this.alignMarks.length) {
            throw new ApiError(404, `no mark ${index}`);
        }
        this.alignMarks.splice(index, 1);
        this.refit();
        this.emitAlign();
        return this.alignStateOf();
    }

    async alignClear(): Promise<AlignState> {
        this.alignMarks = [];
        this.alignFitLast = null;
        this.emitAlign();
        return this.alignStateOf();
    }

    async alignFit(jobId: string): Promise<AlignFit> {
        return this.fitMarks(this.requireJob(jobId));
    }

    /** Fits, turns the job counterclockwise about the origin and shifts it, its paths, outline, copper, pads and holes with it, and clears the marks. */
    async alignApply(jobId: string): Promise<{ job: Job; fit: AlignFit }> {
        const job = this.requireJob(jobId);
        if (this.session && this.session.job.id === jobId) {
            throw new ApiError(409, "the job is running");
        }
        const fit = this.fitMarks(job);
        if (job.groups.some((group) => group.joints && group.joints.length > 0)) {
            throw new ApiError(400, "a joint-space group is fixed to the axis and cannot be aligned");
        }
        const updated = structuredClone(job);
        const place = ([x, y]: Point): Point => {
            const turnedPoint = turnPoint([x, y], fit.rotation);
            return [turnedPoint[0] + fit.shift[0], turnedPoint[1] + fit.shift[1]];
        };
        for (const group of updated.groups) {
            group.paths = group.paths.map((path) => path.map(place));
        }
        updated.outline = updated.outline.map((path) => path.map(place));
        updated.copper = updated.copper.map((path) => path.map(place));
        updated.pads = (updated.pads ?? []).map(([x, y, area]) => [...place([x, y]), area] as [number, number, number]);
        updated.holes = (updated.holes ?? []).map(([x, y, diameter]) => [...place([x, y]), diameter] as [number, number, number]);
        updated.rotation = round4((updated.rotation ?? 0) + fit.rotation);
        const offset = place([updated.offset.x, updated.offset.y]);
        updated.offset = { x: round4(offset[0]), y: round4(offset[1]) };
        if (updated.design) {
            const shift = place(updated.design.shift);
            updated.design = { ...updated.design, shift: [round4(shift[0]), round4(shift[1])], rotation: round4(updated.design.rotation + fit.rotation) };
        }
        updated.stats = computeStats(updated.groups, this.limits());
        this.jobStore.set(jobId, updated);
        this.alignMarks = [];
        this.alignFitLast = null;
        this.message("info", `${job.name} aligned: turned ${gnum(fit.rotation, 4)} deg, moved X ${gnum(fit.shift[0])} Y ${gnum(fit.shift[1])}, rms ${gnum(fit.rms)} mm`);
        this.emitAlign();
        return { job: structuredClone(updated), fit };
    }

    // --- pick and place -----------------------------------------------------

    private pnpStateOf(): PnpState {
        const [width, height] = parseSize(this.pnpConfig.size);
        return {
            ...this.pnpConfig,
            position: this.pnpConfig.position ? [this.pnpConfig.position[0], this.pnpConfig.position[1]] : null,
            running: this.pnpRunning,
            frame: this.pnpRunning ? { width, height, age_ms: POSE_AGE_MS, fps: POSE_FPS } : null,
            routine: this.pnpRoutine ? { ...this.pnpRoutine } : null,
            part_offset: this.pnpPartOffset ? { ...this.pnpPartOffset } : null,
            look: this.upLookOnce ? { ...this.upLookOnce } : null,
            controls: { ...this.keptControls.up },
        };
    }

    private emitPnp(): void {
        this.emit({ type: "pnp", data: this.pnpStateOf() });
    }

    async pnp(): Promise<PnpState> {
        return this.pnpStateOf();
    }

    async pnpSettings(patch: Partial<PnpSettings> & { clear?: ("position" | "height")[] }): Promise<PnpState> {
        const { clear, ...given } = patch;
        const next: PnpSettings = { ...this.pnpConfig };
        for (const [key, value] of Object.entries(given) as [keyof PnpSettings, unknown][]) {
            if (value !== undefined && value !== null) {
                (next as unknown as Record<string, unknown>)[key] = value;
            }
        }
        for (const key of clear ?? []) {
            next[key] = null;
        }
        try {
            checkPnpSettings(next);
        } catch (error) {
            throw new ApiError(400, errorText(error));
        }
        const restart = this.pnpRunning && CAPTURE_KEYS.some((key) => next[key] !== this.pnpConfig[key]);
        if (restart && this.pnpSession) {
            throw new ApiError(409, "the bottom camera routine is under way: abort it first");
        }
        this.pnpConfig = next;
        this.emitPnp();
        return this.pnpStateOf();
    }

    async pnpStart(): Promise<PnpState> {
        if (this.pnpRunning) {
            throw new ApiError(409, "the bottom camera is already running");
        }
        this.pnpRunning = true;
        this.message("info", `bottom camera started on ${this.pnpConfig.device} (mock)`);
        this.emitPnp();
        return this.pnpStateOf();
    }

    async pnpStop(): Promise<PnpState> {
        if (this.pnpSession) {
            throw new ApiError(409, "the bottom camera routine is under way: abort it first");
        }
        this.pnpRunning = false;
        this.emitPnp();
        return this.pnpStateOf();
    }

    /** The nozzle's place from the camera's, mm in the machine's frame: the head's joints against where the camera really is. */
    private nozzleFromCamera(): [number, number] {
        return [this.machine.joint.r - UP_TRUTH.where[0], this.machine.z - UP_TRUTH.where[1]];
    }

    async camLog(camera?: LoggedCamera): Promise<CamLogState> {
        if (camera !== undefined && camera !== "head" && camera !== "up" && camera !== "top") {
            throw new ApiError(400, "camera must be one of head, up, top");
        }
        return this.camLogState(camera);
    }

    private camLogState(camera?: LoggedCamera): CamLogState {
        const entries = this.cameraLog.entries.filter((entry) => camera === undefined || entry.camera === camera);
        return { enabled: this.cameraLog.enabled, count: entries.length, entries: [...entries].reverse().slice(0, 100).map((entry) => structuredClone(entry)) };
    }

    async setCamLog(enabled: boolean): Promise<CamLogState> {
        this.cameraLog.enabled = enabled;
        this.emit({ type: "camlog", data: this.camLogState() });
        return this.camLogState();
    }

    async takePhoto(camera: LoggedCamera, find: boolean): Promise<CamLogEntry> {
        if (camera !== "head" && camera !== "up" && camera !== "top") {
            throw new ApiError(400, "camera must be one of head, up, top");
        }
        const running = camera === "head" ? this.cameraRunning : camera === "up" ? this.pnpRunning : this.topRunning;
        if (!running) {
            throw new ApiError(409, `the ${camera} camera is not running: start it first`);
        }
        const [width, height] = parseSize(camera === "head" ? this.cameraConfig.size : camera === "up" ? this.pnpConfig.size : this.topConfig.size);
        const picture = camera === "head" ? this.cameraFrameUrl(width, false) : camera === "up" ? this.pnpFrameUrl(width, false) : this.topFrameUrl(width, false);
        let spot: SpotReply | null = null;
        let note = "";
        if (find) {
            if (camera === "top") {
                // The mock's top camera shows a fiducial up and to the right of its crosshair.
                const dot = 0.5 / TOP_TRUTH.mmPerPx;
                spot = { found: true, x: width / 2 + dot * 3, y: height / 2 - dot * 2, dx: dot * 3, dy: -dot * 2, major: dot * 2, minor: dot * 2, contrast: 60 };
                note = `${this.topConfig.mark_spot} spot`;
            } else if (camera === "head") {
                const mark = this.cameraMarkPoint ? this.spotNow(this.cameraMarkPoint) : null;
                spot = mark ? { found: true, x: width / 2 + mark.dx, y: height / 2 + mark.dy, dx: mark.dx, dy: mark.dy, major: 12, minor: 12, contrast: 60 } : { found: false };
                note = "dark spot";
            } else {
                const nozzle = this.nozzleFromCamera();
                const p = upPicturePoint(nozzle, UP_TRUTH);
                const inside = upInPicture(nozzle, UP_TRUTH, this.pnpConfig.size);
                spot = inside ? { found: true, x: width / 2 + p.px, y: height / 2 + p.py, dx: p.px, dy: p.py, major: 40, minor: 40, contrast: 70 } : { found: false };
                note = `${this.pnpConfig.part_spot} spot`;
            }
        }
        const entry = this.cameraLog.keep({ camera, routine: "photo", step: "by hand", note, width, height, spot }, picture);
        this.emit({ type: "camlog", data: this.camLogState() });
        return structuredClone(entry);
    }

    async clearCamLog(): Promise<number> {
        const count = this.cameraLog.clear();
        this.emit({ type: "camlog", data: this.camLogState() });
        return count;
    }

    camLogFileUrl(name: string): string {
        return this.cameraLog.files.get(name) ?? "";
    }

    async searchLog(camera?: SearchCamera): Promise<SearchLogState> {
        if (camera !== undefined && camera !== "head" && camera !== "top") {
            throw new ApiError(400, `no camera ${camera} looks for boards: head or top`);
        }
        return this.searchRecords.state(camera);
    }

    searchLogUrl(id: string, name: string): string {
        return mockRecordUrl(id, name);
    }

    /** A search that ended, kept as the backend keeps its record. */
    private recordSearch(camera: SearchCamera, jobId: string, error: string | null, seconds: number, stops: number, visited: number, estimate: BoardEstimate | null): void {
        const result = error === null ? "found" : error.startsWith("no board found") ? "not found" : "error";
        this.searchRecords.add({ camera, job: jobId, jobName: this.requireJob(jobId).name, result, message: error, seconds, stops, visited, estimate });
        this.emit({ type: "searchlog", data: this.searchRecords.state() });
    }

    pnpFrameUrl(width: number, overlay: boolean): string {
        const size = frameWidth(width);
        return upFrameSvg({ nozzle: this.nozzleFromCamera(), holding: this.pnpHolding, size: this.pnpConfig.size, truth: UP_TRUTH }, size, overlay);
    }

    private startPnp(kind: "nozzle" | "part"): PnpState {
        this.requireMovable();
        if (!this.machine.cartesian()) {
            throw new ApiError(400, "the bottom camera needs an X/Y machine ($cartesian=1): on the polar one only the rail crosses its picture");
        }
        if (!this.pnpRunning) {
            throw new ApiError(400, "the bottom camera is not running: start it first");
        }
        if (this.machine.state !== "Idle" || this.outbox.length > 0) {
            throw new ApiError(409, `the machine is ${statusLine(this.machine)}, not Idle`);
        }
        const steps: PnpStep[] = kind === "nozzle"
            ? ["lifting", "moving", "lowering", "scale", "centering", "done"]
            : ["lifting", "moving", "lowering", "looking", "done"];
        const progress: PnpRoutine = { kind, state: "running", step: steps[0]!, done: 0, total: steps.length - 1, error: null, spot: null, seconds: 0 };
        this.pnpRoutine = progress;
        this.pnpSession = { kind, steps, elapsed: 0, moved: false, progress };
        this.jogTracked = false;
        this.emitPnp();
        return this.pnpStateOf();
    }

    async pnpNozzle(step: number): Promise<PnpState> {
        if (this.gcodeId !== null) {
            // The G-code machine's place over the camera is kept with what
            // the PNP tab keeps of it, as the backend's gcode_nozzle does.
            this.gcodeNozzle(step);
            return this.pnpStateOf();
        }
        if (!(Number.isFinite(step) && step >= 0 && step <= 10)) {
            throw new ApiError(400, "the step must be 0 to 10 mm");
        }
        const known = this.pnpConfig.position;
        // Without a place to go to, the nozzle must already be in the picture.
        if (!known && !upInPicture(this.nozzleFromCamera(), UP_TRUTH, this.pnpConfig.size)) {
            this.requireMovable();
            throw new ApiError(400, "no nozzle in the picture: jog it over the bottom camera and center again");
        }
        return this.startPnp("nozzle");
    }

    async pnpPart(): Promise<PnpState> {
        if (this.gcodeId !== null) {
            throw new ApiError(400, "a G-code machine looks at each part over the bottom camera as it places it: mark its feeder's parts for vision");
        }
        if (!this.pnpConfig.position || !(this.pnpConfig.mm_per_px > 0)) {
            throw new ApiError(400, "the nozzle is not centered over the bottom camera yet: center it first");
        }
        this.pnpHolding = true;
        return this.startPnp("part");
    }

    async pnpAbort(): Promise<PnpState> {
        const routine = this.deviceRoutine;
        if (routine) {
            // The routine waits on a move: the machine is told to stop at once.
            routine.progress.state = "stopped";
            routine.progress.error = "stopped";
            this.deviceRoutine = null;
            if (routine.device.stop) {
                this.deviceNote("tx", routine.device.stop);
            }
            this.emitPnp();
            this.emitPlacing();
            return this.pnpStateOf();
        }
        const session = this.pnpSession;
        if (!session) {
            throw new ApiError(409, "no bottom camera routine is under way");
        }
        session.progress.state = "stopped";
        session.progress.error = "stopped";
        this.pnpSession = null;
        this.emitPnp();
        return this.pnpStateOf();
    }

    /** The routine on the mock's clock: a step at a time, the result from where the camera really is. */
    private servicePnp(dt: number): void {
        const session = this.pnpSession;
        if (!session) {
            return;
        }
        session.elapsed += dt;
        session.progress.seconds = Math.round(session.elapsed * 10) / 10;
        // The head's last move made, the routine ends once it is at rest there.
        if (session.moved) {
            if (this.machine.state === "Idle" && this.machine.queue.length === 0) {
                session.progress.step = "done";
                session.progress.done = session.steps.length - 1;
                session.progress.state = "done";
                this.pnpSession = null;
                this.emitPnp();
            }
            return;
        }
        // The steps before the last, one at a time; the last one moves the head.
        const index = Math.min(session.steps.length - 2, Math.floor(session.elapsed / PNP_STEP_SECONDS));
        if (session.steps[index] !== session.progress.step) {
            session.progress.step = session.steps[index]!;
            session.progress.done = index;
            this.emitPnp();
        }
        if (session.elapsed < (session.steps.length - 1) * PNP_STEP_SECONDS) {
            return;
        }
        session.moved = true;
        const lift = this.travel ?? this.clearance;
        if (session.kind === "nozzle") {
            const [r, z] = UP_TRUTH.where;
            const height = this.pnpConfig.height ?? (this.machine.hasFocusAxis() ? Math.max(this.machine.h, lift) : null);
            this.machine.jogTo(r, null, null, height, z);
            this.pnpConfig = { ...this.pnpConfig, position: [r, z], mm_per_px: UP_TRUTH.mmPerPx, roll: UP_TRUTH.roll, mirror: UP_TRUTH.mirror, height };
            session.progress.spot = { dx: 0, dy: 0, mm: 0 };
            this.message("info", `nozzle centered over the bottom camera at R ${gnum(r)} Z ${gnum(z)} (mock)`);
        } else {
            const position = this.pnpConfig.position!;
            this.machine.jogTo(position[0], null, null, this.pnpConfig.height, position[1]);
            const [dx, dy] = UP_TRUTH.part;
            this.pnpPartOffset = { dx, dy, mm: round4(Math.hypot(dx, dy)), length: UP_TRUTH.partSize[0], width: UP_TRUTH.partSize[1] };
            this.message("info", `the part sits X ${gnum(dx)} Y ${gnum(dy)} mm from the nozzle's center (mock)`);
        }
        this.emitPnp();
    }

    async components(jobId: string): Promise<ComponentsResponse> {
        const job = this.requireJob(jobId);
        if (!job.design?.board) {
            return { job: jobId, components: [], note: "only a .kicad_pcb upload keeps the board its parts are read from" };
        }
        return { job: jobId, components: markFiltered(mockComponents(job), this.partsFilterKept), note: null };
    }

    /** The parts filter, as the backend keeps it in its config. */
    private partsFilterKept: PartsFilter = { pattern: "", field: "ref" };

    async partsFilter(): Promise<PartsFilterState> {
        return partsFilterState(this.partsFilterKept);
    }

    async setPartsFilter(filter: PartsFilter): Promise<PartsFilterState> {
        if (!["ref", "value", "footprint", "any"].includes(filter.field)) {
            throw new ApiError(422, "field must be ref, value, footprint or any");
        }
        try {
            partsFilterPattern(filter);
        } catch (error) {
            throw new ApiError(400, errorText(error));
        }
        this.partsFilterKept = { pattern: filter.pattern, field: filter.field };
        return partsFilterState(this.partsFilterKept);
    }

    async pnpGoto(request: PnpGotoRequest): Promise<void> {
        if (this.gcodeId !== null) {
            this.gcodeGotoPart(request.job, request.ref, request.camera === true);
            return;
        }
        const { components } = await this.components(request.job);
        const part = components.find((entry) => entry.ref === request.ref);
        if (!part) {
            throw new ApiError(404, `the job has no part '${request.ref}'`);
        }
        if (!request.correct) {
            await this.goto({ kind: "board", x: part.x, y: part.y });
            return;
        }
        const seen = this.pnpPartOffset;
        if (!seen) {
            throw new ApiError(400, "no part has been looked at on the nozzle: measure it over the bottom camera first");
        }
        if (!this.machine.cartesian()) {
            throw new ApiError(400, "the bottom camera needs an X/Y machine ($cartesian=1)");
        }
        // The board frame is the joints' turned by the table's angle.
        const joint = turned({ x: part.x, y: part.y }, -this.machine.joint.a);
        await this.goto({ kind: "joint", r: joint.x - seen.dx, z: joint.y - seen.dy } as GotoRequest);
    }

    // --- a G-code pick and place machine -------------------------------------------

    /** A G-code machine's file read as the mock's G-code machine; 400 for one that does not read, or is no G-code machine's. */
    private gcodeOf(id: string): MockDevice {
        const text = this.machineText(id);
        try {
            return gcodeMachineOf(text, id);
        } catch (error) {
            throw new ApiError(400, errorText(error));
        }
    }

    /** The G-code machine files that read, by id. */
    private gcodeIds(): string[] {
        return this.machineDocuments().documents.filter((document) => document.controller === "gcode").map((document) => document.id);
    }

    /**
     * The G-code machine the PNP tab works with: the one connected, else the
     * one last connected, else the only G-code machine file; null for none.
     */
    private placingId(): string | null {
        if (this.gcodeId !== null && this.deviceLink.connected) {
            return this.gcodeId;
        }
        const ids = this.gcodeIds();
        if (this.lastGcode !== null && ids.includes(this.lastGcode)) {
            return this.lastGcode;
        }
        return ids.length === 1 ? ids[0]! : null;
    }

    /** What the tab keeps of the placing machine; with none, a fresh one that goes nowhere. */
    private placing(): MockPlacing {
        const id = this.placingId();
        if (id === null) {
            return newPlacing();
        }
        let kept = this.placings.get(id);
        if (!kept) {
            kept = newPlacing();
            this.placings.set(id, kept);
        }
        return kept;
    }

    /** The placing machine's file, read; 409 with no G-code machine to place with. */
    private placingDevice(): MockDevice {
        const id = this.placingId();
        if (id === null) {
            throw new ApiError(409, 'no G-code machine to place with: connect one, or add a machine file with controller = "gcode"');
        }
        return this.gcodeOf(id);
    }

    private placingStateOf(): PlacingState {
        const link = this.deviceLink;
        const id = this.placingId();
        let device: MockDevice | null = null;
        try {
            device = id !== null ? this.gcodeOf(id) : null;
        } catch {
            device = null;
        }
        const placing = this.placing();
        const position = this.deviceCameraPosition();
        return {
            machine: id,
            name: device?.name ?? null,
            document: device ? deviceDocument(device) : null,
            angle: placing.angle,
            references: placing.references.map((entry) => ({ ...entry, at: [entry.at[0], entry.at[1]] })),
            taken: { ...placing.taken },
            boards: placing.boards,
            camera: {
                ...placing.upPlace,
                position: position ? [...position] : null,
                runout: placing.upPlace.runout ? [...placing.upPlace.runout] : null,
                height: device?.camera_z ?? null,
                measured: placing.upPlace.position !== null,
            },
            top: this.topStateOf(),
            connected: link.connected && this.gcodeId !== null && this.gcodeId === id,
            url: link.url,
            lost: null,
            running: this.deviceSession !== null,
            homed: link.homed,
            position: this.devicePositionRead ? { ...link.position } : null,
            light: link.light,
            vacuum: { on: link.vacuumSwitched, reading: link.reading },
            progress: this.deviceProgress
                ? {
                    ...this.deviceProgress,
                    placed: [...this.deviceProgress.placed],
                    failed: this.deviceProgress.failed.map((entry) => ({ ...entry })),
                    steps: (this.deviceProgress.steps ?? []).map((entry) => ({ ...entry })),
                }
                : null,
            log: link.log.slice(-60),
        };
    }

    /** Opens the G-code machine `id` on `url`, as the backend does: its init lines, then what it is and where its head is. */
    private gcodeConnect(url: string, id: string): Snapshot {
        const device = this.gcodeOf(id);
        if (this.gcodeId === id && this.deviceLink.connected && this.deviceLink.url === url) {
            return this.snapshot();
        }
        if (this.connected) {
            // The board on this project's firmware lets go of its port first.
            this.machine.reset();
            this.connected = false;
            this.url = null;
        }
        this.gcodeClose();
        this.gcodeId = id;
        this.lastGcode = id;
        this.url = url;
        this.deviceLink = { ...this.deviceLink, connected: true, url, homed: false, light: null, reading: null, vacuumSwitched: null };
        this.gcodeMotors = true;
        this.deviceNote("info", `connected to ${url} at ${device.baud} baud (mock)`);
        for (const line of device.init) {
            this.deviceLine(device, line);
        }
        const answer = this.deviceLine(device, "M115").join(" ");
        this.gcodeFirmware = /FIRMWARE_NAME:\s*(.+?)(?:\s+[A-Z_]+:|$)/.exec(answer)?.[1]?.trim() ?? null;
        this.deviceHere(device);
        this.message("info", `connected to ${url}: ${device.name}${this.gcodeFirmware ? `, ${this.gcodeFirmware}` : ""} (mock)`);
        const snapshot = this.snapshot();
        this.emit({ type: "state", data: snapshot });
        this.emitPlacing();
        return snapshot;
    }

    /** Lets the G-code machine's port go, a placing run on it stopped first. */
    private gcodeClose(): void {
        if (this.gcodeId === null) {
            return;
        }
        if (this.deviceSession !== null) {
            const session = this.deviceSession;
            session.progress.state = "stopped";
            session.progress.error = "stopped";
            this.deviceSession = null;
        }
        if (this.deviceLink.url !== null) {
            this.deviceNote("info", `disconnected from ${this.deviceLink.url}`);
        }
        this.deviceLink = { ...this.deviceLink, connected: false, url: null };
        this.gcodeId = null;
        this.url = null;
        this.emitPlacing();
    }

    /** The snapshot of a G-code machine: its head's place as the readout's joints, as the backend's _gcode_snapshot. */
    private gcodeSnapshot(id: string): Snapshot {
        let name = id;
        try {
            name = this.gcodeOf(id).name;
        } catch {
            // A file broken since the connect keeps its id for a name.
        }
        const link = this.deviceLink;
        const busy = this.deviceSession !== null || this.deviceRoutine !== null || this.topSession !== null;
        const position = link.position;
        return {
            connected: link.connected,
            url: this.url,
            firmware: link.connected ? { version: this.gcodeFirmware ?? "", lines: 1, blocks: 0, name: this.gcodeFirmware ?? name } : null,
            machine: link.connected
                ? {
                    state: busy ? "Run" : "Idle",
                    alarm: null,
                    joint: { r: position.x, a: position.rotation, z: position.y, h: position.z },
                    probe: null,
                    homed: null,
                    board: { x: round4(position.x), y: round4(position.y) },
                    rate: 0,
                    laser: 0,
                    mode: "dyn",
                    enabled: this.gcodeMotors,
                    queue: { planner: 0, lines: 0 },
                    age: 0,
                }
                : null,
            profile: { kinematics: "cartesian", tool: "nozzle", h_axis: true, r_max: 0, z_max: 0, controller: "gcode", machine: id, name },
            run: null,
            resume: null,
            position: null,
        };
    }

    /** Refuses what only a machine on this project's firmware does, with the reason, while a G-code machine is connected. */
    private notGcode(): void {
        if (this.gcodeId !== null) {
            const name = this.gcodeSnapshot(this.gcodeId).profile?.name ?? this.gcodeId;
            throw new ApiError(409, `${name} is a G-code machine: this is for a machine on this project's firmware`);
        }
    }

    /** A jog from where the controller says the head is: queued, as the backend's _gcode_jog. */
    private async gcodeJog(request: JogRequest): Promise<void> {
        this.checkFeed(request.feed ?? null);
        const device = this.gcodeIdle();
        const steps: Partial<Record<AxisName, number>> = {};
        if (request.kind === "joint") {
            const { dr, dz, dh, da } = request as { dr?: number; dz?: number; dh?: number; da?: number };
            Object.assign(steps, dr ? { x: dr } : {}, dz ? { y: dz } : {}, dh ? { z: dh } : {}, da ? { rotation: da } : {});
        } else {
            Object.assign(steps, request.dx ? { x: request.dx } : {}, request.dy ? { y: request.dy } : {});
        }
        if (Object.keys(steps).length === 0) {
            throw new ApiError(400, "a jog moves at least one axis");
        }
        for (const [name, value] of Object.entries(steps)) {
            const limit = name === "rotation" ? 3600 : 1000;
            if (Math.abs(value) > limit) {
                throw new ApiError(400, `a jog's step is at most ${limit} ${name === "rotation" ? "degrees" : "mm"} either way`);
            }
        }
        const here = this.deviceHere(device);
        const target: Partial<Record<AxisName, number>> = {};
        for (const [name, value] of Object.entries(steps) as [AxisName, number][]) {
            target[name] = here[name] + value;
        }
        const feed = request.feed ?? null;
        // Leaving the up camera with the nozzle down near its lens goes up
        // first, when the file asks for it.
        if (liftsLeaving(device, here, target, this.deviceCameraPosition())) {
            this.deviceLine(device, safeLine(device));
        }
        this.deviceLine(device, moveLine(device, target, feed));
        this.emit({ type: "state", data: this.snapshot() });
    }

    /** A goto: across at the safe height only when X or Y changes, the height last, run to its end; as the backend's _gcode_goto. */
    private async gcodeGoto(request: GotoRequest): Promise<void> {
        this.checkFeed(request.feed ?? null);
        const device = this.gcodeIdle();
        const want: Partial<Record<AxisName, number>> = {};
        if (request.kind === "joint") {
            const { r, z, h, a } = request as { r?: number; z?: number; h?: number; a?: number };
            Object.assign(want, r !== undefined ? { x: r } : {}, z !== undefined ? { y: z } : {}, h !== undefined ? { z: h } : {}, a !== undefined ? { rotation: a } : {});
        } else {
            if (request.x === undefined && request.y === undefined) {
                throw new ApiError(400, "a board goto needs x and/or y");
            }
            Object.assign(want, request.x !== undefined ? { x: request.x } : {}, request.y !== undefined ? { y: request.y } : {});
        }
        if (Object.keys(want).length === 0) {
            throw new ApiError(400, "give at least one axis to go to");
        }
        const here = this.deviceHere(device);
        this.headLines(device, gotoLines(device, here, want, request.feed ?? null));
    }

    /** Declares where the head is (G92), as the backend's _gcode_set_position. */
    private async gcodeSetPosition(request: PositionRequest): Promise<void> {
        const device = this.gcodeIdle();
        const given: [number, number][] = [];
        (["r", "z", "h", "a"] as const).forEach((joint, index) => {
            const value = request[joint];
            if (value !== undefined) {
                given.push([index, value]);
            }
        });
        if (given.length === 0) {
            throw new ApiError(400, "give r, a, h and/or z");
        }
        this.deviceLine(device, `G92 ${given.map(([index, value]) => `${device.axes[index]}${gnum(value)}`).join(" ")}`);
        const position = this.deviceLink.position;
        for (const [index, value] of given) {
            position[(["x", "y", "z", "rotation"] as const)[index]!] = value;
        }
        this.deviceHere(device);
        this.emit({ type: "state", data: this.snapshot() });
    }

    /** The console's and the jog panel's realtime buttons on a G-code machine, as the backend's _gcode_realtime. */
    private async gcodeRealtime(action: RealtimeAction): Promise<void> {
        const device = this.gcodeOf(this.gcodeId!);
        if (action === "reset" || action === "cancel") {
            this.deviceRoutine = null;
            this.topSession = null;
            if (this.deviceSession !== null) {
                this.deviceSession.progress.state = "stopped";
                this.deviceSession.progress.error = "stopped";
                this.deviceSession = null;
            }
            if (device.stop) {
                this.deviceNote("tx", device.stop);
            }
        } else if (action === "status") {
            if (this.deviceSession === null) {
                this.deviceHere(device);
            }
        } else {
            throw new ApiError(400, `${device.name} takes no hold: Stop stops it (${device.stop || "no stop line in its file"})`);
        }
        this.emit({ type: "state", data: this.snapshot() });
        this.emitPlacing();
    }

    /** Where the up camera is on the machine: as measured or set, else as its file has it. */
    private deviceCameraPosition(): [number, number] | null {
        const placing = this.placing();
        if (placing.upPlace.position !== null) {
            return placing.upPlace.position;
        }
        try {
            return this.placingId() !== null ? this.placingDevice().camera_position : null;
        } catch {
            return null;
        }
    }

    private emitPlacing(): void {
        this.emit({ type: "placing", data: this.placingStateOf() });
    }

    /** A line to or from the G-code machine: in its link's log, and the console's as every machine's lines are. */
    private deviceNote(dir: string, text: string): void {
        this.deviceLink.log.push({ dir, text });
        if (this.deviceLink.log.length > 200) {
            this.deviceLink.log.splice(0, this.deviceLink.log.length - 200);
        }
        if (dir === "tx" || dir === "rx") {
            this.line(dir, text);
        }
    }

    /** One line to the mock device and its answer: a move moves it, the position command reports, home zeroes it. */
    private deviceLine(device: MockDevice, line: string): string[] {
        const code = codeOf(line);
        if (!code) {
            return [];
        }
        if (!this.deviceLink.connected) {
            throw new ApiError(502, "the machine is not connected");
        }
        this.deviceNote("tx", code);
        const reply: string[] = [];
        const [x, y, z, a] = device.axes;
        const word = code.split(/\s+/)[0]!;
        if (word === device.move) {
            const position = this.deviceLink.position;
            for (const [letter, key] of [[x, "x"], [y, "y"], [z, "z"], [a, "rotation"]] as const) {
                const found = code.match(new RegExp(`\\b${letter}(-?\\d+(?:\\.\\d+)?)`));
                if (found) {
                    position[key] = Number(found[1]);
                }
            }
        } else if (code === device.position) {
            const position = this.deviceLink.position;
            reply.push(`${x}:${position.x.toFixed(2)} ${y}:${position.y.toFixed(2)} ${z}:${position.z.toFixed(2)} ${a}:${position.rotation.toFixed(2)} E:0.00 Count X:0 Y:0 Z:0`);
        } else if (code === device.home) {
            this.deviceLink.position = { x: 0, y: 0, z: 0, rotation: 0 };
        } else if (device.pick.includes(code)) {
            this.deviceVacuumOn = true;
        } else if (device.place.includes(code)) {
            this.deviceVacuumOn = false;
        } else if (code === "M115") {
            reply.push("FIRMWARE_NAME:Marlin 2.1.2 (mock) MACHINE_TYPE:mock machine EXTRUDER_COUNT:0");
        } else if (device.bus !== null && code.startsWith(device.bus.send.split("{packet}")[0]!)) {
            const prefix = device.bus.send.split("{packet}")[0]!;
            reply.push(this.busAnswer(device, code.slice(prefix.length).split(/\s/)[0] ?? ""));
        }
        if (device.vacuum && code === device.vacuum.read[device.vacuum.read.length - 1]) {
            // The middle of the range for how the vacuum stands, said as an
            // I2C read (OpenPnP's LumenPnP pattern) and as Marlin's M105.
            const span = this.deviceVacuumOn ? device.vacuum.part_on ?? [220, 241] : device.vacuum.part_off ?? [248, 255];
            const value = ((span[0] + span[1]) / 2).toFixed(2);
            reply.push(`echo:i2c-reply: from:109 bytes:1 data:${value}`, `ok T:${value} /0.00 B:0.00 /0.00 @:0 B@:0`);
        } else {
            reply.push("ok");
        }
        for (const text of reply) {
            this.deviceNote("rx", text);
        }
        return reply;
    }

    /** The connected G-code machine, for a request that sends it lines: refused while a run or a camera routine has it. */
    private gcodeIdle(): MockDevice {
        if (this.gcodeId === null || !this.deviceLink.connected) {
            throw new ApiError(409, "no G-code machine is connected: connect one from the top bar");
        }
        if (this.deviceSession !== null) {
            throw new ApiError(409, "a placing run is under way");
        }
        if (this.deviceRoutine !== null) {
            throw new ApiError(409, "the bottom camera routine is moving the head");
        }
        if (this.topSession !== null) {
            throw new ApiError(409, "the top camera routine is moving the head");
        }
        return this.gcodeOf(this.gcodeId);
    }

    /** Centers the G-code machine's nozzle over the up camera, as the backend's gcode_nozzle does. */
    private gcodeNozzle(step: number): void {
        const device = this.gcodeIdle();
        if (!(Number.isFinite(step) && step >= 0 && step <= 10)) {
            throw new ApiError(400, "the step must be 0 to 10 mm");
        }
        if (!this.pnpRunning) {
            throw new ApiError(400, "the bottom camera is not running: start it first");
        }
        if (this.pnpSession) {
            throw new ApiError(409, "a bottom camera routine is already under way");
        }
        const at = this.deviceLink.position;
        if (!this.placing().upPlace.position && !upInPicture([at.x - DEVICE_CAMERA_WHERE[0], at.y - DEVICE_CAMERA_WHERE[1]], UP_TRUTH, this.pnpConfig.size)) {
            throw new ApiError(400, "no nozzle in the picture: jog it over the bottom camera and center again");
        }
        const progress: PnpRoutine = { kind: "nozzle", target: "gcode", state: "running", step: "lifting", done: 0, total: 5, error: null, spot: null, seconds: 0 };
        this.pnpRoutine = progress;
        this.deviceRoutine = { kind: "nozzle", elapsed: 0, device, progress };
        this.emitPnp();
        this.emitPlacing();
    }

    async pnpRunout(): Promise<PlacingState> {
        const device = this.gcodeIdle();
        if (!this.placing().upPlace.position || !(this.placing().upPlace.mm_per_px > 0)) {
            throw new ApiError(400, "the nozzle is not centered over the bottom camera yet: center it first");
        }
        if (!this.deviceLink.connected) {
            throw new ApiError(400, "no G-code machine is connected: connect one from the top bar");
        }
        if (!this.pnpRunning) {
            throw new ApiError(400, "the bottom camera is not running: start it first");
        }
        if (this.pnpSession) {
            throw new ApiError(409, "a bottom camera routine is already under way");
        }
        const progress: PnpRoutine = { kind: "runout", target: "gcode", state: "running", step: "lifting", done: 0, total: 4, error: null, spot: null, seconds: 0 };
        this.pnpRoutine = progress;
        this.deviceRoutine = { kind: "runout", elapsed: 0, device, progress };
        this.emitPnp();
        this.emitPlacing();
        return this.placingStateOf();
    }

    private topStateOf(): TopState {
        const [width, height] = parseSize(this.topConfig.size);
        return {
            ...this.topConfig,
            mark_at: this.topConfig.mark_at ? [...this.topConfig.mark_at] : null,
            offset: this.topConfig.offset ? [...this.topConfig.offset] : null,
            running: this.topRunning,
            frame: this.topRunning ? { width, height, age_ms: POSE_AGE_MS, fps: POSE_FPS } : null,
            routine: this.topRoutine ? { ...this.topRoutine } : null,
            fiducials: this.topFiducials,
            look: this.topLookOnce ? { ...this.topLookOnce } : null,
            board_look: this.topBoardLook.state(),
            controls: { ...this.keptControls.top },
        };
    }

    private topMeasured(): boolean {
        return this.topConfig.offset !== null && this.topConfig.mm_per_px > 0;
    }

    async topSettings(patch: Partial<TopSettings> & { clear?: ("mark_at" | "offset")[] }): Promise<PlacingState> {
        // Kept with what the tab keeps of a G-code machine: there must be one.
        this.placingDevice();
        const { clear, ...rest } = patch;
        const next: TopSettings = { ...this.topConfig };
        for (const [key, value] of Object.entries(rest)) {
            if (value !== undefined && value !== null) {
                (next as unknown as Record<string, unknown>)[key] = value;
            }
        }
        for (const key of clear ?? []) {
            next[key] = null;
        }
        try {
            checkTopSettings(next);
        } catch (error) {
            throw new ApiError(400, errorText(error));
        }
        const restart = this.topRunning && CAPTURE_KEYS.some((key) => next[key] !== this.topConfig[key]);
        if (restart && this.topSession) {
            throw new ApiError(409, "the top camera routine is under way: abort it first");
        }
        this.topConfig = next;
        this.emitPlacing();
        return this.placingStateOf();
    }

    async topStart(): Promise<PlacingState> {
        if (this.topRunning) {
            throw new ApiError(409, "the top camera is already running");
        }
        this.topRunning = true;
        this.message("info", `top camera started on ${this.topConfig.device} (mock)`);
        this.emitPlacing();
        return this.placingStateOf();
    }

    async topStop(): Promise<PlacingState> {
        if (this.topSession) {
            throw new ApiError(409, "the top camera routine is under way: abort it first");
        }
        this.topRunning = false;
        this.emitPlacing();
        return this.placingStateOf();
    }

    topFrameUrl(width: number, overlay: boolean): string {
        return topFrameSvg(this.topConfig.size, frameWidth(width), overlay);
    }

    async topMark(): Promise<PlacingState> {
        const at = this.deviceHere(this.gcodeIdle());
        this.topConfig = { ...this.topConfig, mark_at: [at.x, at.y] };
        this.emitPlacing();
        return this.placingStateOf();
    }

    private beginTop(kind: "offset" | "fiducials" | "search" | "home", steps: string[], device: MockDevice, job: string | null): void {
        if (!this.deviceLink.connected) {
            throw new ApiError(400, "no G-code machine is connected: connect one from the top bar");
        }
        if (!this.topRunning) {
            throw new ApiError(400, "the top camera is not running: start it first");
        }
        if (this.topSession) {
            throw new ApiError(409, "a top camera routine is already under way");
        }
        const progress: TopRoutine = { kind, target: "gcode", state: "running", step: steps[0]!, done: 0, total: steps.length - 1, error: null, spot: null, seconds: 0 };
        this.topRoutine = progress;
        this.topSession = { kind, steps, elapsed: 0, device, job, progress };
        this.emitPlacing();
    }

    async topOffset(step: number): Promise<PlacingState> {
        const device = this.gcodeIdle();
        if (!(Number.isFinite(step) && step >= 0 && step <= 20)) {
            throw new ApiError(400, "the step must be 0 to 20 mm");
        }
        if (this.topConfig.mark_at === null) {
            throw new ApiError(400, "put the nozzle's tip over a mark and press Nozzle on mark first");
        }
        this.beginTop("offset", ["lifting", "moving", "lowering", "scale", "centering", "done"], device, null);
        return this.placingStateOf();
    }

    /** Home by fiducial, as the backend's top_home: home, find the bed's fiducial, declare the head's place. */
    async topHome(): Promise<PlacingState> {
        const device = this.gcodeIdle();
        if (!device.top?.home_fiducial) {
            throw new ApiError(400, `${device.name}'s file has no [top_camera] home_fiducial`);
        }
        if (!device.home) {
            throw new ApiError(400, `${device.name}'s file has no [gcode] home command`);
        }
        if (!this.topMeasured()) {
            throw new ApiError(400, "the top camera's offset is not measured: put the nozzle on a mark, then Measure offset");
        }
        this.beginTop("home", ["homing", "looking", "declaring", "done"], device, null);
        return this.placingStateOf();
    }

    async pnpFiducials(job: string): Promise<PlacingState> {
        const device = this.gcodeIdle();
        if (!device.top) {
            throw new ApiError(400, "the machine file has no [top_camera] section");
        }
        const parts = mockComponents(this.requireJob(job));
        const fiducials = parts.filter((entry) => entry.fiducial);
        this.deviceFitOf(job, parts);
        if (fiducials.length === 0) {
            throw new ApiError(400, "the board has no fiducials: footprints whose reference starts FID or whose name says Fiducial");
        }
        if (!this.topMeasured()) {
            throw new ApiError(400, "the top camera's offset is not measured: put the nozzle on a mark, then Measure offset");
        }
        this.beginTop("fiducials", ["lifting", ...fiducials.map((entry) => entry.ref), "fitting", "done"], device, job);
        return this.placingStateOf();
    }

    async topAbort(): Promise<PlacingState> {
        const session = this.topSession;
        if (!session) {
            throw new ApiError(409, "no top camera routine is under way");
        }
        session.progress.state = "stopped";
        session.progress.error = "stopped";
        this.topSession = null;
        if (session.device.stop) {
            this.deviceNote("tx", session.device.stop);
        }
        this.emitPlacing();
        return this.placingStateOf();
    }

    // --- the looks for a board, looks once and the cameras' controls ------------

    /** Where the head camera's loaded board really lies: the job's frame taken onto the board frame through the board's real placement. */
    private headTruth(job: Job, placement: Placement): BoardEstimate {
        return estimateOf((point) => placedPoint(designPoint(point, jobPlacement(job)), placement), jobSize(job).middle);
    }

    /** An estimate moved by how far the offset in force is from the camera's real one: what the backend makes of exact poses through it. */
    private offBy(estimate: BoardEstimate, dx: number, dy: number): BoardEstimate {
        return {
            ...estimate,
            shift: [round4(estimate.shift[0] + dx), round4(estimate.shift[1] + dy)],
            center: [round4(estimate.center[0] + dx), round4(estimate.center[1] + dy)],
        };
    }

    /** The head camera's picture corners and center in the job's frame, the board lying at `placement`. */
    private headView(job: Job, placement: Placement): { view: [number, number][]; seen: [number, number]; picture: MachinePicture } {
        const [width, height] = parseSize(this.cameraConfig.size);
        const center = this.pictureCenter();
        const toJob = (board: Board): [number, number] => {
            const point = placedPoint(designPoint(board, placement), jobPlacement(job));
            return [round4(point.x), round4(point.y)];
        };
        const corners = ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([sx, sy]): [number, number] => {
            const v = boardVector((sx * width) / 2, (sy * height) / 2, CAMERA_TRUTH.roll, CAMERA_TRUTH.mmPerPx);
            return [center.x + v.x, center.y + v.y];
        });
        // The picture where the look takes it to be: through the offset in
        // force, as the backend places a pose.
        const config = this.cameraConfig.offset;
        const dx = config[0] - CAMERA_TRUTH.offset[0];
        const dy = config[1] - CAMERA_TRUTH.offset[1];
        return {
            view: corners.map(([x, y]) => toJob({ x, y })),
            seen: toJob(center),
            picture: { corners: corners.map(([x, y]) => [x + dx, y + dy]), center: [center.x + dx, center.y + dy] },
        };
    }

    /** One pose of the head camera's look: locked while its picture is over the board, used once the machine stands Idle. */
    private headLookOnce(): boolean {
        const job = this.headLook.job !== null ? this.jobStore.get(this.headLook.job) : undefined;
        const placement = this.placement;
        if (!this.cameraRunning || !job || !placement) {
            return false;
        }
        const pose = boardPose(this.pictureCenter(), job, placement, CAMERA_TRUTH, this.cameraConfig.size);
        const locked = pose.state === "locked";
        const { view, seen, picture } = this.headView(job, placement);
        if (this.machine.state !== "Idle") {
            this.headLook.see(locked, null, view, seen, "the head is moving");
            return locked;
        }
        const config = this.cameraConfig.offset;
        const estimate = this.offBy(this.headTruth(job, placement), config[0] - CAMERA_TRUTH.offset[0], config[1] - CAMERA_TRUTH.offset[1]);
        this.headLook.sample(locked, locked ? estimate : null, view, seen, null, picture);
        return locked;
    }

    /** Where the board lies on the G-code machine: as its references put it, else a little off a place of the mock's own. */
    private topTruth(jobId: string): BoardEstimate {
        const job = this.requireJob(jobId);
        const middle = jobSize(job).middle;
        let fit: { rotation: number; shift: [number, number] } = { rotation: 0.8, shift: [100, 60] };
        try {
            const found = this.deviceFitOf(jobId, mockComponents(job));
            fit = { rotation: found.rotation, shift: [found.shift[0], found.shift[1]] };
        } catch {
            // No references: the mock's own place.
        }
        return estimateOf((point) => {
            const t = turned(point, fit.rotation);
            return { x: t.x + fit.shift[0], y: t.y + fit.shift[1] };
        }, middle);
    }

    /** The top camera's picture center on the machine, really. */
    private topPictureCenter(): Board {
        return { x: this.deviceLink.position.x + TOP_TRUTH.offset[0], y: this.deviceLink.position.y + TOP_TRUTH.offset[1] };
    }

    /** One pose of the top camera's look: locked while its picture's center is over the board. */
    private topLookSample(): boolean {
        const jobId = this.topBoardLook.job;
        const job = jobId !== null ? this.jobStore.get(jobId) : undefined;
        if (!this.topRunning || !job || jobId === null) {
            return false;
        }
        const truth = this.topTruth(jobId);
        const toJob = (machine: Board): [number, number] => {
            const t = turned({ x: machine.x - truth.shift[0], y: machine.y - truth.shift[1] }, -truth.rotation);
            return [round4(t.x), round4(t.y)];
        };
        const center = this.topPictureCenter();
        const seen = toJob(center);
        const locked = onBoard(job, { x: seen[0], y: seen[1] });
        const [width, height] = parseSize(this.topConfig.size);
        const half = [(width / 2) * TOP_TRUTH.mmPerPx, (height / 2) * TOP_TRUTH.mmPerPx];
        const corners = ([[-1, 1], [1, 1], [1, -1], [-1, -1]] as const).map(([sx, sy]): [number, number] => [center.x + sx * half[0]!, center.y + sy * half[1]!]);
        const view = corners.map(([x, y]) => toJob({ x, y }));
        const offset = this.topConfig.offset;
        if (offset === null) {
            this.topBoardLook.see(locked, null, view, seen, "the top camera's offset is not known: Measure offset first");
            return locked;
        }
        const estimate = this.offBy(truth, offset[0] - TOP_TRUTH.offset[0], offset[1] - TOP_TRUTH.offset[1]);
        // The picture where the look takes it to be: through the offset in force.
        const dx = offset[0] - TOP_TRUTH.offset[0];
        const dy = offset[1] - TOP_TRUTH.offset[1];
        const picture: MachinePicture = { corners: corners.map(([x, y]) => [x + dx, y + dy]), center: [center.x + dx, center.y + dy] };
        this.topBoardLook.sample(locked, locked ? estimate : null, view, seen, null, picture);
        return locked;
    }

    /** The looks read a pose every so often while a board is loaded and no search reads them itself. */
    private serviceLooks(dt: number): void {
        for (const [look, sample, emit, busy] of [
            [this.headLook, () => this.headLookOnce(), () => this.emitCamera(), this.headSearch !== null],
            [this.topBoardLook, () => this.topLookSample(), () => this.emitPlacing(), this.topSession !== null],
        ] as [MockBoardLook, () => boolean, () => void, boolean][]) {
            if (look.job === null || busy) {
                look.elapsed = 0;
                continue;
            }
            look.elapsed += dt;
            let read = false;
            while (look.elapsed >= LOOK_SAMPLE_SECONDS) {
                look.elapsed -= LOOK_SAMPLE_SECONDS;
                sample();
                read = true;
            }
            if (read) {
                emit();
            }
        }
    }

    async cameraSearch(box: SearchBox | null): Promise<CameraState> {
        this.requireConnected();
        const jobId = this.headLook.job;
        if (jobId === null || jobId !== this.cameraJob) {
            throw new ApiError(400, "no board loaded: press Look for board first");
        }
        if (!this.cameraRunning) {
            throw new ApiError(400, "the camera is not running: start it first");
        }
        this.notOwned();
        if (this.machine.state !== "Idle" || this.outbox.length > 0) {
            throw new ApiError(409, `the machine is ${statusLine(this.machine)}, not Idle`);
        }
        const scale = this.cameraConfig.mm_per_px > 0 ? this.cameraConfig.mm_per_px : this.poseOf()?.state === "locked" ? CAMERA_TRUTH.mmPerPx : 0;
        if (!(scale > 0)) {
            throw new ApiError(400, "the camera's scale is not measured: measure it first, so the search knows how far its picture reaches");
        }
        const [width, height] = parseSize(this.cameraConfig.size);
        const tool = this.machine.headBoard();
        const here = { x: tool.x + this.cameraConfig.offset[0], y: tool.y + this.cameraConfig.offset[1] };
        const job = this.requireJob(jobId);
        const { diagonal, middle } = jobSize(job);
        const cornerMm = lookTuning(this.cameraConfig).cornerMm;
        const around = this.cornersBox(this.headLook, job, cornerMm);
        // Where the board is known to be: the corners, a place found before,
        // the job's own place (the mock keeps no Align fit for this).
        const known = cornersKnown(this.headLook.cornersOf(job.id), middle, cornerMm, diagonal) ?? this.headLook.foundKnown(job.id) ?? jobKnown(middle, diagonal);
        let stops: Board[];
        try {
            stops = searchStops(box ?? around ?? [here.x - diagonal / 2, here.y - diagonal / 2, here.x + diagonal / 2, here.y + diagonal / 2], [width * scale, height * scale], { x: known.center[0], y: known.center[1] });
        } catch (error) {
            throw new ApiError(400, errorText(error));
        }
        const progress: CameraRoutine = { kind: "search", state: "running", step: "lifting", done: 0, total: stops.length + 1, error: null, spot: null };
        this.routine = progress;
        this.headSearch = { stops, index: 0, elapsed: 0, progress };
        this.headLook.restart();
        this.headLook.startFrom(known);
        this.jogTracked = false;
        this.emitCamera();
        return this.cameraStateOf();
    }

    /** Puts the tool's board point at `target` at once, as the find routine moves; false when the machine refused. */
    private searchMoveTo(target: Board): boolean {
        const machine = this.machine;
        const over = this.jointOver(target, machine.joint);
        const joint: ProbeJoint = machine.cartesian() ? { r: over.r, a: machine.joint.a, z: over.z } : { r: over.r, a: over.a };
        const line = `go ${jointWords(joint.r, joint.a, joint.z)}`;
        this.line("tx", line);
        try {
            this.probeGo(joint, null);
        } catch (error) {
            if (!(error instanceof MachineError)) {
                throw error;
            }
            this.line("rx", error.message);
            return false;
        }
        this.line("rx", "ok");
        return true;
    }

    /** The head camera's search on the mock's clock: a stop at a time, the board found at the first stop whose picture is over it. */
    private serviceHeadSearch(dt: number): void {
        const search = this.headSearch;
        if (!search) {
            return;
        }
        search.elapsed += dt;
        while (this.headSearch === search && search.elapsed >= SEARCH_STOP_SECONDS) {
            search.elapsed -= SEARCH_STOP_SECONDS;
            const progress = search.progress;
            const end = (state: CameraRoutine["state"], error: string | null): void => {
                this.headSearch = null;
                const jobId = this.headLook.job;
                if (jobId !== null) {
                    this.recordSearch("head", jobId, state === "done" ? null : error, search.index * SEARCH_STOP_SECONDS, search.stops.length, search.index, state === "done" ? this.headLook.state().estimate ?? null : null);
                }
                progress.state = state;
                progress.error = error;
                if (state === "done") {
                    progress.step = "done";
                    progress.done = progress.total;
                } else {
                    this.message("error", `looking for the board failed: ${error}`);
                }
                this.emitCamera();
            };
            if (search.index >= search.stops.length) {
                end("error", notFoundText(search.stops.length, lookTuning(this.cameraConfig).threshold));
                return;
            }
            const stop = search.stops[search.index]!;
            const offset = this.cameraConfig.offset;
            search.index += 1;
            progress.step = "searching";
            progress.done = search.index;
            if (!this.searchMoveTo({ x: stop.x - offset[0], y: stop.y - offset[1] })) {
                end("error", "the machine refused a move of the search");
                return;
            }
            this.headLook.guided();
            if (this.headLookOnce()) {
                const job = this.requireJob(this.headLook.job!);
                const placement = this.placement!;
                const estimate = this.offBy(this.headTruth(job, placement), offset[0] - CAMERA_TRUTH.offset[0], offset[1] - CAMERA_TRUTH.offset[1]);
                const { view, seen, picture } = this.headView(job, placement);
                if (!this.headLook.settle(estimate, view, seen, picture)) {
                    this.emitCamera();
                    continue;
                }
                this.searchMoveTo({ x: estimate.center[0] - offset[0], y: estimate.center[1] - offset[1] });
                this.message("info", `board found: its middle at ${formatFixed(estimate.center[0], 3)}, ${formatFixed(estimate.center[1], 3)} mm, turned ${formatFixed(estimate.rotation, 3)} degrees (mock)`);
                end("done", null);
                return;
            }
            this.emitCamera();
        }
    }

    async topBoard(jobId: string | null): Promise<PlacingState> {
        this.placingDevice();
        if (jobId === null) {
            this.topBoardLook.stop();
            this.emitPlacing();
            return this.placingStateOf();
        }
        if (!this.topRunning) {
            throw new ApiError(400, "the top camera is not running: start it first");
        }
        const job = this.requireJob(jobId);
        if (!job.design?.board) {
            throw new ApiError(400, "the job was not imported from a KiCad board file kept here: the camera has nothing to look for");
        }
        this.topBoardLook.start(jobId);
        this.emitPlacing();
        return this.placingStateOf();
    }

    async topSearch(box: SearchBox | null): Promise<PlacingState> {
        const device = this.gcodeIdle();
        const jobId = this.topBoardLook.job;
        if (jobId === null) {
            throw new ApiError(400, "no board loaded: press Look for board first");
        }
        const offset = this.topConfig.offset ?? device.top?.offset ?? null;
        if (offset === null) {
            throw new ApiError(400, "the top camera's offset is not known: give [top_camera] offset in the machine file, or Measure offset");
        }
        if (!(this.topConfig.mm_per_px > 0)) {
            throw new ApiError(400, "the camera's scale is not measured: measure it first, so the search knows how far its picture reaches");
        }
        const [width, height] = parseSize(this.topConfig.size);
        const head = this.deviceHere(device);
        const here = { x: head.x + offset[0], y: head.y + offset[1] };
        const job = this.requireJob(jobId);
        const { diagonal, middle } = jobSize(job);
        const cornerMm = lookTuning(this.topConfig).cornerMm;
        const around = this.cornersBox(this.topBoardLook, job, cornerMm);
        // Where the board is known to be: the corners, a place found before
        // (the job's frame is not this machine's, and the mock keeps no fit
        // of the references for this).
        const known = cornersKnown(this.topBoardLook.cornersOf(job.id), middle, cornerMm, diagonal) ?? this.topBoardLook.foundKnown(job.id);
        let stops: Board[];
        try {
            stops = searchStops(box ?? around ?? [here.x - diagonal / 2, here.y - diagonal / 2, here.x + diagonal / 2, here.y + diagonal / 2], [width * this.topConfig.mm_per_px, height * this.topConfig.mm_per_px], known ? { x: known.center[0], y: known.center[1] } : here);
        } catch (error) {
            throw new ApiError(400, errorText(error));
        }
        this.topSearchStops = stops;
        this.topBoardLook.restart();
        this.topBoardLook.startFrom(known);
        this.beginTop("search", ["lifting", ...stops.map((_, index) => `stop ${index + 1}`), "done"], device, jobId);
        return this.placingStateOf();
    }

    /** The top camera's search on the mock's clock: a stop at a time, the board found at the first stop whose picture is over it. */
    private serviceTopSearch(session: NonNullable<MockBackend["topSession"]>, dt: number): void {
        session.elapsed += dt;
        const progress = session.progress;
        progress.seconds = Math.round(session.elapsed * 10) / 10;
        const stops = this.topSearchStops;
        const reached = Math.floor(session.elapsed / SEARCH_STOP_SECONDS);
        const offset = this.topConfig.offset ?? session.device.top?.offset ?? [0, 0];
        while (this.topSession === session && progress.done < Math.min(reached, stops.length + 1)) {
            const index = progress.done;
            if (index >= stops.length) {
                this.topSession = null;
                progress.state = "error";
                progress.error = notFoundText(stops.length, lookTuning(this.topConfig).threshold);
                this.message("error", `looking for the board failed: ${progress.error}`);
                if (session.job !== null) {
                    this.recordSearch("top", session.job, progress.error, session.elapsed, stops.length, stops.length, null);
                }
                break;
            }
            const stop = stops[index]!;
            progress.done = index + 1;
            progress.step = `stop ${index + 1}`;
            this.deviceLine(session.device, xyLine(session.device, stop.x - offset[0], stop.y - offset[1]));
            this.topBoardLook.guided();
            if (this.topLookSample()) {
                const estimate = this.offBy(this.topTruth(session.job!), offset[0] - TOP_TRUTH.offset[0], offset[1] - TOP_TRUTH.offset[1]);
                const state = this.topBoardLook.state();
                if (!this.topBoardLook.settle(estimate, state.view ?? null, state.seen ?? null)) {
                    continue;
                }
                this.deviceLine(session.device, xyLine(session.device, estimate.center[0] - offset[0], estimate.center[1] - offset[1]));
                this.topSession = null;
                progress.state = "done";
                progress.step = "done";
                progress.done = progress.total;
                this.recordSearch("top", session.job!, null, session.elapsed, stops.length, index + 1, this.topBoardLook.state().estimate ?? null);
                this.message("info", `board found: its middle at ${formatFixed(estimate.center[0], 3)}, ${formatFixed(estimate.center[1], 3)} mm, turned ${formatFixed(estimate.rotation, 3)} degrees (mock)`);
            }
        }
        this.emitPlacing();
    }

    async topPlace(jobId: string): Promise<PlacingState> {
        const found = this.topBoardLook.job === jobId && this.topBoardLook.found ? this.topBoardLook.best : null;
        const best = found ?? this.topBoardLook.rough(jobId);
        const by = found !== null ? "look" : "corners";
        if (best === null) {
            throw new ApiError(400, "the top camera has not found this job's board: Look for board, then Search, until a guess is likely enough; or put the picture's center on its corners and take them");
        }
        const parts = mockComponents(this.requireJob(jobId));
        if (parts.length < 2) {
            throw new ApiError(400, "the board needs two parts to take its place from");
        }
        const fiducials = parts.filter((part) => part.fiducial);
        const pool = fiducials.length >= 2 ? fiducials : parts;
        let pair: [Component, Component] = [pool[0]!, pool[1]!];
        let far = -1;
        for (let i = 0; i < pool.length; i++) {
            for (let j = i + 1; j < pool.length; j++) {
                const d = (pool[i]!.x - pool[j]!.x) ** 2 + (pool[i]!.y - pool[j]!.y) ** 2;
                if (d > far) {
                    far = d;
                    pair = [pool[i]!, pool[j]!];
                }
            }
        }
        const refs = new Set(pair.map((part) => part.ref));
        const placing = this.placing();
        placing.references = placing.references.filter((entry) => !(entry.job === jobId && (refs.has(entry.ref) || entry.by === "look" || entry.by === "corners")));
        for (const part of pair) {
            const at = applyEstimate(best, { x: part.x, y: part.y });
            placing.references.push({ job: jobId, ref: part.ref, at: [round4(at.x), round4(at.y)], by });
        }
        this.emitPlacing();
        return this.placingStateOf();
    }

    async topCorner(jobId: string, corner: CornerName): Promise<PlacingState> {
        const device = this.gcodeIdle();
        const job = this.requireJob(jobId);
        const point = this.cornerPoint(job, corner);
        const offset = this.topConfig.offset ?? device.top?.offset ?? null;
        if (offset === null) {
            throw new ApiError(400, "the top camera's offset is not known: give [top_camera] offset in the machine file, or Measure offset");
        }
        const head = this.deviceHere(device);
        this.topBoardLook.addCorner(job.id, corner, point, [head.x + offset[0], head.y + offset[1]], jobSize(job).middle);
        this.emitPlacing();
        return this.placingStateOf();
    }

    async topCornersClear(): Promise<PlacingState> {
        this.topBoardLook.clearCorners();
        this.emitPlacing();
        return this.placingStateOf();
    }

    async cameraCorner(jobId: string, corner: CornerName): Promise<CameraState> {
        this.requireConnected();
        const job = this.requireJob(jobId);
        const point = this.cornerPoint(job, corner);
        if (this.machine.state !== "Idle") {
            throw new ApiError(400, `the machine is ${this.machine.state}: take a corner with the head at rest`);
        }
        const tool = this.machine.headBoard();
        const offset = this.cameraConfig.offset;
        this.headLook.addCorner(job.id, corner, point, [tool.x + offset[0], tool.y + offset[1]], jobSize(job).middle);
        this.emitCamera();
        return this.cameraStateOf();
    }

    async cameraCornersClear(): Promise<CameraState> {
        this.headLook.clearCorners();
        this.emitCamera();
        return this.cameraStateOf();
    }

    async cameraEdgeCorner(jobId: string, corner: CornerName): Promise<CameraState> {
        // The mock's blank board shows its corner under the picture's
        // center, its edges turned as the board lies.
        await this.cameraCorner(jobId, corner);
        const taken = this.headLook.cornersOf(jobId).find((entry) => entry.corner === corner)!;
        const job = this.requireJob(jobId);
        this.headLook.addCorner(job.id, corner, taken.job, taken.machine, jobSize(job).middle, this.placement?.rotation ?? 0);
        this.emitCamera();
        return this.cameraStateOf();
    }

    async topEdgeCorner(jobId: string, corner: CornerName): Promise<PlacingState> {
        await this.topCorner(jobId, corner);
        const taken = this.topBoardLook.cornersOf(jobId).find((entry) => entry.corner === corner)!;
        const job = this.requireJob(jobId);
        this.topBoardLook.addCorner(job.id, corner, taken.job, taken.machine, jobSize(job).middle, 0);
        this.emitPlacing();
        return this.placingStateOf();
    }

    async cameraRefine(jobId: string, use: RefineUse, count: number): Promise<CameraState> {
        this.requireConnected();
        const job = this.requireJob(jobId);
        const look = this.headLook;
        const place = look.job === job.id && look.found ? look.best : look.rough(job.id);
        if (place === null) {
            throw new ApiError(400, "the board's place is not known yet: Look for board and Search until it is found, or take its corners");
        }
        const pads = (job.pads ?? []).map((pad) => [pad[0], pad[1]] as [number, number]);
        const features = use === "pads" ? pads : (job.holes ?? []).map((hole) => [hole[0], hole[1]] as [number, number]);
        const pool = features.length >= 2 ? features : pads;
        if (pool.length < 2) {
            throw new ApiError(400, `the board has no two ${use === "auto" ? "features" : use} clear of the rest to center on`);
        }
        // The mock's features: the two furthest apart, then the furthest from those, centered where the place found puts them.
        let pair: [number, number] = [0, 1];
        let far = -1;
        for (let i = 0; i < pool.length; i++) {
            for (let j = i + 1; j < pool.length; j++) {
                const d = Math.hypot(pool[i]![0] - pool[j]![0], pool[i]![1] - pool[j]![1]);
                if (d > far) {
                    far = d;
                    pair = [i, j];
                }
            }
        }
        const taken = [pool[pair[0]]!, pool[pair[1]]!];
        while (taken.length < Math.min(count, pool.length)) {
            const next = pool.filter((p) => !taken.includes(p)).reduce((a, b) => (Math.min(...taken.map((t) => Math.hypot(a[0] - t[0], a[1] - t[1]))) >= Math.min(...taken.map((t) => Math.hypot(b[0] - t[0], b[1] - t[1]))) ? a : b));
            taken.push(next);
        }
        this.takeMarksFor(job.id);
        this.alignMarks = this.alignMarks.filter((mark) => mark.source !== "camera");
        for (const point of taken) {
            const at = applyEstimate(place, { x: point[0], y: point[1] });
            this.alignMarks.push({ design: [point[0], point[1]], machine: [round4(at.x), round4(at.y)], source: "camera", kind: "feature", distance: 0, angle: null, residual: null });
        }
        this.refit();
        this.emitAlign();
        this.message("info", `${taken.length} features centered: their places are the job's camera marks in Align`);
        return this.cameraStateOf();
    }

    /** A camera's settings dict, by its name in the controls' routes. */
    private settingsOf(camera: ControlledCamera): { lens?: CameraLens | null; colors?: CameraColors } {
        return camera === "head" ? this.cameraConfig : camera === "up" ? this.pnpConfig : this.topConfig;
    }

    private emitOf(camera: ControlledCamera): void {
        if (camera === "head") {
            this.emitCamera();
        } else if (camera === "up") {
            this.emitPnp();
        } else {
            this.emitPlacing();
        }
    }

    async cameraLens(camera: ControlledCamera, polarity: SpotPolarity, pitch: number): Promise<{ camera: ControlledCamera; measured: LensMeasured | null }> {
        this.controlledDevice(camera);
        if (!(pitch >= 0.1 && pitch <= 50)) {
            throw new ApiError(400, "the dots' pitch must be 0.1 to 50 mm");
        }
        const settings = this.settingsOf(camera);
        const [width, height] = parseSize((settings as { size: string }).size);
        // The mock's lens bends a little, the same every time.
        const measured: LensMeasured = { k1: -0.031, k2: 0.004, width, height, dots: polarity === "dark" ? 168 : 152, rms_px: 0.08, rms_before_px: 1.42, mm_per_px: 0.02, worst_px: 0.21 };
        settings.lens = { k1: measured.k1, k2: measured.k2, width, height };
        this.message("info", `${camera} camera lens measured from ${measured.dots} dots: k1 ${measured.k1}, k2 ${measured.k2}; the dots fit within ${measured.rms_px} px rms, ${measured.rms_before_px} px without it`);
        this.emitOf(camera);
        return { camera, measured };
    }

    async cameraLensClear(camera: ControlledCamera): Promise<{ camera: ControlledCamera; measured: null }> {
        this.controlledDevice(camera);
        this.settingsOf(camera).lens = null;
        this.emitOf(camera);
        return { camera, measured: null };
    }

    async cameraColor(camera: ControlledCamera, item: ColorItem, point: [number, number] | null): Promise<{ camera: ControlledCamera; item: ColorItem; rgb: [number, number, number] | null }> {
        this.controlledDevice(camera);
        const settings = this.settingsOf(camera);
        const colors: CameraColors = { ...(settings.colors ?? {}) };
        let rgb: [number, number, number] | null = null;
        if (point === null) {
            delete colors[item];
        } else {
            // The mock's pictures: copper pads, a dark bed, light marks.
            rgb = item === "edges" ? [52, 54, 60] : item === "board" ? [196, 128, 70] : [214, 210, 198];
            colors[item] = rgb;
        }
        settings.colors = colors;
        this.emitOf(camera);
        return { camera, item, rgb };
    }

    /** A corner of the job's extent by its name, as the backend takes it of the outline's box. */
    private cornerPoint(job: Job, corner: CornerName): [number, number] {
        if (!CORNER_NAMES.includes(corner)) {
            throw new ApiError(400, `no corner '${corner}': one of ${CORNER_NAMES.join(", ")}`);
        }
        const bounds = jobBounds(job);
        if (bounds === null) {
            throw new ApiError(400, "the job has no outline to take a corner of");
        }
        return cornerOf(bounds, corner);
    }

    /** The box a search covers by default once corners of the job's board were taken, as the backend's. */
    private cornersBox(look: MockBoardLook, job: Job, cornerMm: number): SearchBox | null {
        const rough = look.rough(job.id);
        if (rough === null) {
            return null;
        }
        const margin = cornerMm + (look.cornersOf(job.id).length < 2 ? 0.1 * jobSize(job).diagonal : 0);
        return roughBox(job, rough, margin);
    }

    /** A spot of a look once: its place in the picture and a round shape `across` px wide. */
    private spotLook(polarity: SpotLook["polarity"], at: { px: number; py: number } | null, size: string, across = 24): SpotLook {
        if (at === null) {
            return { found: false, polarity, radius: null };
        }
        const [width, height] = parseSize(size);
        const dx = Math.round(at.px * 100) / 100;
        const dy = Math.round(at.py * 100) / 100;
        return {
            found: true, polarity, radius: null, dx, dy, x: width / 2 + dx, y: height / 2 + dy,
            area: Math.round((Math.PI * across * across) / 4), major: across, minor: across * 0.9, angle: 12, contrast: 70, rect: { length: across * 0.96, width: across * 0.88, angle: 10 },
        };
    }

    async pnpLook(spot: "nozzle" | "part"): Promise<PnpState> {
        if (!this.pnpRunning) {
            throw new ApiError(409, "the bottom camera is not running: start it first");
        }
        const polarity = spot === "nozzle" ? this.pnpConfig.nozzle_spot : this.pnpConfig.part_spot;
        const mm: [number, number] = this.gcodeId !== null
            ? [this.deviceLink.position.x - DEVICE_CAMERA_WHERE[0], this.deviceLink.position.y - DEVICE_CAMERA_WHERE[1]]
            : this.nozzleFromCamera();
        const seen = upInPicture(mm, UP_TRUTH, this.pnpConfig.size) && (spot === "nozzle" || this.pnpHolding);
        this.upLookOnce = this.spotLook(polarity, seen ? upPicturePoint(mm, UP_TRUTH) : null, this.pnpConfig.size);
        this.emitPnp();
        return this.pnpStateOf();
    }

    async topLook(): Promise<PlacingState> {
        if (!this.topRunning) {
            throw new ApiError(409, "the top camera is not running: start it first");
        }
        // The mock's picture shows a bright fiducial in a dark ring 75 px
        // right of and 50 px above its center (topFrameSvg).
        this.topLookOnce = this.spotLook(this.topConfig.mark_spot, { px: 75, py: -50 }, this.topConfig.size, this.topConfig.mark_spot === "bright" ? 50 : 100);
        this.emitPlacing();
        return this.placingStateOf();
    }

    private controlledDevice(camera: ControlledCamera): string {
        if (camera === "head") {
            return this.cameraConfig.device;
        }
        if (camera === "up") {
            return this.pnpConfig.device;
        }
        this.placingDevice();
        return this.topConfig.device;
    }

    async cameraControls(camera: ControlledCamera): Promise<CameraControls> {
        const device = this.controlledDevice(camera);
        const note = controlsNote(device);
        const kept = this.keptControls[camera];
        return {
            camera,
            device,
            local: note === null,
            note,
            controls: note === null ? MOCK_CONTROLS.map((control) => ({ ...control, items: control.items?.map((item) => ({ ...item })), value: kept[control.name] ?? control.value, kept: kept[control.name] ?? null })) : [],
            kept: { ...kept },
        };
    }

    async setCameraControls(camera: ControlledCamera, values: Record<string, number | null>): Promise<CameraControls> {
        const device = this.controlledDevice(camera);
        const kept = { ...this.keptControls[camera] };
        for (const [name, value] of Object.entries(values)) {
            if (!/^[a-z0-9_]{1,64}$/.test(name)) {
                throw new ApiError(400, `'${name}' is not a camera control's name`);
            }
            if (value !== null && !Number.isInteger(value)) {
                throw new ApiError(400, `the control ${name} takes a whole number`);
            }
            if (value === null) {
                delete kept[name];
            } else {
                kept[name] = value;
            }
        }
        this.keptControls[camera] = kept;
        const refused = controlsNote(device) === null
            ? Object.entries(values).filter(([name, value]) => value !== null && !MOCK_CONTROLS.some((control) => control.name === name)).map(([name]) => `${name}: v4l2-ctl: unknown control '${name}'`)
            : [];
        if (camera === "head") {
            this.emitCamera();
        } else if (camera === "up") {
            this.emitPnp();
        } else {
            this.emitPlacing();
        }
        return { ...(await this.cameraControls(camera)), refused };
    }

    /**
     * The mock board lies on the machine exactly where the references put
     * it: the fiducials found there become its references when two or more
     * were found, and what the run and the panel show of them is kept.
     */
    private keepFiducials(job: string): string {
        const parts = mockComponents(this.requireJob(job));
        const fiducials = parts.filter((entry) => entry.fiducial);
        const fit = this.deviceFitOf(job, parts);
        const [tx, ty] = [fit.shift[0], fit.shift[1]];
        const found = fiducials.map((entry) => {
            const [x, y] = turnPoint([entry.x, entry.y], fit.rotation);
            return { ref: entry.ref, at: [round4(x + tx), round4(y + ty)] as [number, number] };
        });
        const refs = new Set(found.map((entry) => entry.ref));
        this.placing().references = this.placing().references.filter(
            (entry) => !(entry.job === job && (refs.has(entry.ref) || (found.length > 1 && entry.by !== "fiducial"))),
        );
        for (const entry of found) {
            this.placing().references.push({ job, ref: entry.ref, at: entry.at, by: "fiducial" });
        }
        this.topFiducials = { job, found, fit: { ...fit, marks: found.length } };
        return `${found.length} fiducials found: the board is turned ${fit.rotation >= 0 ? "+" : ""}${fit.rotation.toFixed(3)} degrees on the machine (mock)`;
    }

    /** The top camera's routine on the mock's clock, a step at a time. */
    private serviceTopRoutine(dt: number): void {
        const session = this.topSession;
        if (!session) {
            return;
        }
        if (session.kind === "search") {
            this.serviceTopSearch(session, dt);
            return;
        }
        session.elapsed += dt;
        session.progress.seconds = Math.round(session.elapsed * 10) / 10;
        const index = Math.min(session.steps.length - 1, Math.floor(session.elapsed / PNP_STEP_SECONDS));
        session.progress.step = session.steps[index]!;
        session.progress.done = index;
        if (index === session.steps.length - 1) {
            session.progress.state = "done";
            session.progress.spot = { dx: 0, dy: 0, mm: 0 };
            this.topSession = null;
            if (session.kind === "home") {
                // The mock's switches leave the head MOCK_HOME_ERROR off the
                // numbers; the fiducial seen there is declared away.
                const fiducial = session.device.top!.home_fiducial!;
                const [ox, oy] = this.topConfig.offset ?? TOP_TRUTH.offset;
                const head: [number, number] = [fiducial[0] - ox, fiducial[1] - oy];
                this.deviceLine(session.device, session.device.home);
                this.deviceLine(session.device, xyLine(session.device, head[0], head[1]));
                const [ex, ey] = MOCK_HOME_ERROR;
                this.deviceLine(session.device, `G92 ${session.device.axes[0]}${gnum(head[0] + ex)} ${session.device.axes[1]}${gnum(head[1] + ey)}`);
                const signed = (value: number): string => `${value >= 0 ? "+" : ""}${value.toFixed(3)}`;
                this.message("info", `homed by the fiducial: the head was ${signed(-ex)}, ${signed(-ey)} mm off the switches' home (mock)`);
            } else if (session.kind === "offset") {
                const mark = this.topConfig.mark_at ?? [0, 0];
                const [ox, oy] = TOP_TRUTH.offset;
                this.deviceLine(session.device, xyLine(session.device, mark[0] - ox, mark[1] - oy));
                this.topConfig = { ...this.topConfig, offset: [ox, oy], mm_per_px: TOP_TRUTH.mmPerPx, roll: TOP_TRUTH.roll, mirror: TOP_TRUTH.mirror };
                this.message("info", `the top camera looks from X ${ox >= 0 ? "+" : ""}${ox.toFixed(3)} Y ${oy >= 0 ? "+" : ""}${oy.toFixed(3)} mm off the nozzle (mock)`);
            } else if (session.job !== null) {
                this.message("info", this.keepFiducials(session.job));
            }
        }
        this.emitPlacing();
    }

    // The Auto tab: the backend's routes, with the scripted provider besides its own.

    async autoSettings(): Promise<AutoSettings> {
        return this.auto.settings();
    }

    async setAutoSettings(patch: AutoSettingsUpdate): Promise<AutoSettings> {
        return this.auto.update(patch);
    }

    async autoConversation(): Promise<AutoConversation> {
        return this.auto.conversation();
    }

    async autoSend(text: string): Promise<AutoConversation> {
        return this.auto.send(text);
    }

    async autoStop(): Promise<AutoConversation> {
        return this.auto.stop();
    }

    async autoClear(): Promise<AutoConversation> {
        return this.auto.clear();
    }

    /** The device's nozzle routine on the mock's clock: a step at a time, the camera's place from where it really is. */
    private serviceDeviceRoutine(dt: number): void {
        const routine = this.deviceRoutine;
        if (!routine) {
            return;
        }
        routine.elapsed += dt;
        routine.progress.seconds = Math.round(routine.elapsed * 10) / 10;
        const steps: PnpStep[] = routine.kind === "runout" ? ["lifting", "moving", "lowering", "turning", "done"] : ["lifting", "moving", "lowering", "scale", "centering", "done"];
        const index = Math.min(steps.length - 1, Math.floor(routine.elapsed / PNP_STEP_SECONDS));
        routine.progress.step = steps[index]!;
        routine.progress.done = index;
        if (index === steps.length - 1 && routine.kind === "runout") {
            this.deviceLine(routine.device, `${routine.device.move} ${angleWord(routine.device, 0)} F${gnum(routine.device.feed_xy, 0)}`);
            this.placing().upPlace = { ...this.placing().upPlace, runout: [...DEVICE_RUNOUT] };
            routine.progress.state = "done";
            this.deviceRoutine = null;
            this.message("info", `nozzle runout ${Math.round(Math.hypot(...DEVICE_RUNOUT) * 1000)} um (turns counterclockwise as the profile says) (mock)`);
            this.emitPlacing();
        } else if (index === steps.length - 1) {
            const [x, y] = DEVICE_CAMERA_WHERE;
            const z = routine.device.camera_z ?? routine.device.safe_z;
            this.deviceLine(routine.device, xyLine(routine.device, x, y));
            this.deviceLine(routine.device, zLine(routine.device, z));
            // The runout is the nozzle's own and outlasts a new center.
            this.placing().upPlace = { position: [x, y], mm_per_px: UP_TRUTH.mmPerPx, roll: UP_TRUTH.roll, mirror: UP_TRUTH.mirror, runout: this.placing().upPlace.runout };
            routine.progress.state = "done";
            routine.progress.spot = { dx: 0, dy: 0, mm: 0 };
            this.deviceRoutine = null;
            this.message("info", `nozzle centered over the bottom camera at X ${gnum(x)} Y ${gnum(y)} (mock)`);
            this.emitPlacing();
        }
        this.emitPnp();
    }

    async placingState(): Promise<PlacingState> {
        return this.placingStateOf();
    }

    async placingAngle(patch: { angle?: number; clear_angle?: boolean }): Promise<PlacingState> {
        this.placingDevice();
        if (patch.clear_angle) {
            this.placing().angle = null;
        } else if (patch.angle !== undefined) {
            if (!(Number.isFinite(patch.angle) && Math.abs(patch.angle) <= 360)) {
                throw new ApiError(400, "the board's turn must be within 360 degrees");
            }
            this.placing().angle = patch.angle;
        }
        this.emitPlacing();
        return this.placingStateOf();
    }

    private devicePart(jobId: string, ref: string): Component {
        const part = mockComponents(this.requireJob(jobId)).find((entry) => entry.ref === ref);
        if (!part) {
            throw new ApiError(404, `the job has no part '${ref}'`);
        }
        return part;
    }

    async pnpReference(request: { job: string; ref: string; at?: [number, number]; camera?: boolean }): Promise<PlacingState> {
        this.devicePart(request.job, request.ref);
        let at = request.at;
        if (at === undefined) {
            let offset: [number, number] = [0, 0];
            if (request.camera) {
                if (!this.topMeasured() || this.topConfig.offset === null) {
                    throw new ApiError(400, "the top camera's offset is not measured: put the nozzle on a mark, then Measure offset");
                }
                offset = this.topConfig.offset;
            }
            const here = this.deviceHere(this.gcodeIdle());
            at = [here.x + offset[0], here.y + offset[1]];
        } else if (!at.every((value) => Number.isFinite(value) && Math.abs(value) <= 10000)) {
            throw new ApiError(400, "a reference's place must be within 10000 mm");
        }
        this.placing().references = this.placing().references.filter((entry) => !(entry.job === request.job && entry.ref === request.ref));
        this.placing().references.push({ job: request.job, ref: request.ref, at: [round4(at[0]), round4(at[1])], by: request.camera ? "camera" : "nozzle" });
        this.emitPlacing();
        return this.placingStateOf();
    }

    async pnpDropReferences(job: string, ref?: string): Promise<PlacingState> {
        this.placing().references = this.placing().references.filter((entry) => !(entry.job === job && (ref === undefined || entry.ref === ref)));
        this.emitPlacing();
        return this.placingStateOf();
    }

    /** Where the board lies on the device: two fiducials or more found by the top camera outdo the references given by hand. */
    private deviceFitOf(jobId: string, parts: Component[]): AlignFit {
        const byRef = new Map(parts.map((part) => [part.ref, part]));
        const entries = this.placing().references.filter((entry) => entry.job === jobId && byRef.has(entry.ref));
        const found = entries.filter((entry) => entry.by === "fiducial");
        const pairs: [[number, number], [number, number]][] = (found.length > 1 ? found : entries).map((entry) => {
            const part = byRef.get(entry.ref)!;
            return [[part.x, part.y], [entry.at[0], entry.at[1]]];
        });
        try {
            return deviceFit(pairs, this.placing().angle);
        } catch (error) {
            throw new ApiError(400, errorText(error));
        }
    }

    private devicePlanOf(jobId: string, refs: string[] | null): { device: MockDevice; plan: ReturnType<typeof planDevice> } {
        const device = this.deviceSession === null ? this.foundSlots(this.placingDevice()) : this.placingDevice();
        const job = this.requireJob(jobId);
        const parts = markFiltered(mockComponents(job), this.partsFilterKept);
        if (parts.length === 0) {
            throw new ApiError(400, "only a .kicad_pcb upload keeps the board its parts are read from");
        }
        const fit = this.deviceFitOf(jobId, parts);
        const ready = this.placing().upPlace.position !== null && this.placing().upPlace.mm_per_px > 0;
        return { device, plan: planDevice(device, parts, fit, this.placing().taken, refs, job.name, ready, this.placing().upPlace.runout ?? [0, 0]) };
    }

    async pnpPlan(job: string, refs?: string[]): Promise<PlacingPlan> {
        return planSummary(this.devicePlanOf(job, refs ?? null).plan);
    }

    pnpProgramUrl(job: string, refs?: string[]): string {
        try {
            return `data:text/plain;charset=utf-8,${encodeURIComponent(planText(this.devicePlanOf(job, refs ?? null).plan))}`;
        } catch {
            return "data:text/plain;charset=utf-8,";
        }
    }

    async pnpRun(job: string, refs?: string[], fiducials = false): Promise<PlacingPlan & PlacingState> {
        if (this.deviceSession !== null) {
            throw new ApiError(409, "a placing run is already under way");
        }
        const picked = this.gcodeIdle();
        if (fiducials) {
            if (!mockComponents(this.requireJob(job)).some((entry) => entry.fiducial)) {
                throw new ApiError(400, "the board has no fiducials to find: footprints whose reference starts FID or whose name says Fiducial");
            }
            if (!picked.top) {
                throw new ApiError(400, "the machine file has no [top_camera] to find the fiducials with");
            }
        }
        let { device, plan } = this.devicePlanOf(job, refs ?? null);
        if (!this.deviceLink.connected) {
            throw new ApiError(502, "no G-code machine is connected: connect one from the top bar");
        }
        if (plan.blocks.length === 0) {
            throw new ApiError(502, "the program places no part");
        }
        if (plan.blocks.some((block) => block.vision) && !this.pnpRunning) {
            throw new ApiError(400, "the bottom camera is not running: start it, since some parts are to be looked at over it");
        }
        const used = new Set(plan.blocks.map((block) => block.feeder));
        const looks = fiducials || device.feeders.some((feeder) => used.has(feeder.id) && (feeder.pocket !== null || feeder.marks.length > 0));
        if (looks && !this.topRunning) {
            throw new ApiError(400, "the top camera is not running: start it, since the run looks with it");
        }
        if (fiducials) {
            if (!this.topMeasured()) {
                throw new ApiError(502, "finding the fiducials: the top camera's offset is not measured: put the nozzle on a mark, then Measure offset");
            }
            // The mock board lies where the references put it: the fiducials
            // are found there, and the plan is made on them.
            this.message("info", this.keepFiducials(job));
            ({ device, plan } = this.devicePlanOf(job, refs ?? null));
        }
        const lines: { code: string; block: MockBlock | null; look?: MockBlock; picked?: MockBlock; advance?: MockFeeder }[] = [];
        for (const line of plan.head) {
            lines.push({ code: codeOf(line), block: null });
        }
        for (const block of plan.blocks) {
            // A part counts against its feeder once its pick lines are answered.
            const busFeeder = device.feeders.find((feeder) => feeder.id === block.feeder && feeder.bus_id !== null);
            if (busFeeder) {
                lines.push({ code: "", block: null, advance: busFeeder });
            }
            block.pick.forEach((line, index) => lines.push({ code: codeOf(line), block: null, ...(index === block.pick.length - 1 ? { picked: block } : {}) }));
            for (const line of block.check) {
                lines.push({ code: codeOf(line), block: null });
            }
            if (block.vision) {
                // The place lines are made once the part has been looked at.
                lines.push({ code: "", block: null, look: block });
                continue;
            }
            const rest = [...block.place, ...block.release];
            rest.forEach((line, index) => lines.push({ code: codeOf(line), block: index === rest.length - 1 ? block : null }));
        }
        for (const line of plan.tail) {
            lines.push({ code: codeOf(line), block: null });
        }
        const progress: PlacingRun = { state: "running", sent: 0, total: planSummary(plan).lines, part: null, placed: [], failed: [], doing: null, job, error: null, seconds: 0, steps: [] };
        progress.steps!.push({ t: 0, ref: null, text: `placing ${plan.blocks.length} parts on ${device.name}`, level: "info" });
        const values = new Map(mockComponents(this.requireJob(job)).map((part) => [part.ref, part.value]));
        this.deviceProgress = progress;
        this.deviceSession = { lines, next: 0, elapsed: 0, device, progress, values };
        this.emitPlacing();
        return { ...planSummary(plan), ...this.placingStateOf() };
    }

    /** A step of a run in words, as the backend keeps its last 300. */
    private deviceStep(progress: PlacingRun, text: string, ref: string | null, level: "info" | "warning" | "error" = "info"): void {
        const steps = (progress.steps ??= []);
        steps.push({ t: progress.seconds, ref, text, level });
        if (steps.length > 300) {
            steps.splice(0, steps.length - 300);
        }
    }

    /** The program on the mock's clock, a few dozen lines a second. */
    private serviceDevice(dt: number): void {
        const session = this.deviceSession;
        if (!session) {
            return;
        }
        session.elapsed += dt;
        session.progress.seconds = Math.round(session.elapsed * 10) / 10;
        const due = Math.min(session.lines.length, Math.floor(session.elapsed * DEVICE_LINES_PER_SECOND) + 1);
        while (session.next < due) {
            const { code, block, look, picked, advance } = session.lines[session.next]!;
            session.next += 1;
            if (advance) {
                try {
                    const address = this.busAdvance(session.device, advance);
                    this.deviceStep(session.progress, `feeder ${advance.id} advanced ${gnum(advance.advance)} mm (address ${address})`, null);
                } catch (error) {
                    // The mock's run ends where the backend's would leave the
                    // part out: its bus answers every feeder it knows.
                    session.progress.state = "error";
                    session.progress.error = errorText(error);
                    this.deviceSession = null;
                    this.emitPlacing();
                    return;
                }
                continue;
            }
            if (look) {
                const lines = this.deviceLook(session.device, look);
                session.lines.splice(session.next, 0, ...lines);
                // The look's lines are counted as the backend counts them.
                session.progress.total += lines.filter((line) => line.code !== "").length - [...look.place, ...look.release].filter((line) => codeOf(line) !== "").length;
                continue;
            }
            if (code) {
                this.deviceLine(session.device, code);
                session.progress.sent += 1;
            }
            if (picked) {
                session.progress.part = picked.ref;
                this.placing().taken[picked.feeder] = Math.max(this.placing().taken[picked.feeder] ?? 0, picked.index + 1);
                const value = session.values.get(picked.ref) ?? "";
                this.deviceStep(session.progress, `picking ${value} from ${picked.feeder} #${picked.index + 1}`.replace("  ", " "), picked.ref);
            }
            if (block) {
                session.progress.placed.push(block.ref);
                this.deviceStep(session.progress, `placed at X ${gnum(block.target[0])} Y ${gnum(block.target[1])}, ${gnum(block.angle, 1)} deg`, block.ref);
            }
        }
        if (session.next >= session.lines.length) {
            session.progress.state = "done";
            session.progress.part = null;
            this.deviceStep(session.progress, `done: ${session.progress.placed.length} placed`, null);
            this.placing().boards += 1;
            this.deviceSession = null;
            this.message("info", `placing on ${session.device.name} done: ${session.progress.placed.length} parts placed (mock)`);
        }
        this.emitPlacing();
    }

    /**
     * Over the up camera with a part just picked, as the backend does
     * between its pick and its place: turned to the angle it goes down at,
     * the head where the tip is over the picture's center, then the place
     * lines that put the part's center (seen off the tip's, turned with the
     * nozzle) on the place, the tip's runout made up for. The mock's parts
     * sit true to their angle, so one look does.
     */
    private deviceLook(device: MockDevice, block: MockBlock): { code: string; block: MockBlock | null }[] {
        const camera = this.placing().upPlace.position ?? DEVICE_CAMERA_WHERE;
        const runout = this.placing().upPlace.runout ?? [0, 0];
        const axis: [number, number] = [camera[0] + runout[0], camera[1] + runout[1]];
        const [swungX, swungY] = turnPoint(runout, block.turn);
        const head: [number, number] = [axis[0] - swungX, axis[1] - swungY];
        const waits = device.wait ? [device.wait] : [];
        const lines = [
            safeLine(device),
            `${device.move} ${angleWord(device, block.turn)} F${gnum(device.feed_xy, 0)}`,
            ...waits,
            xyLine(device, head[0], head[1]),
            ...waits,
            ...(device.camera_z !== null ? [zLine(device, device.camera_z), ...waits] : []),
        ];
        const [dx, dy] = turnPoint(UP_TRUTH.part, block.turn);
        this.pnpPartOffset = { dx: round4(dx), dy: round4(dy), mm: round4(Math.hypot(dx, dy)), length: UP_TRUTH.partSize[0], width: UP_TRUTH.partSize[1], angle: block.angle };
        this.emitPnp();
        // The part's center off the axis, and the head that puts it on the place.
        const arm: [number, number] = [dx + axis[0] - head[0], dy + axis[1] - head[1]];
        const target: [number, number] = [block.target[0] + runout[0] - arm[0], block.target[1] + runout[1] - arm[1]];
        const place = [safeLine(device), ...placeLines(device, target, block.turn, block.place_z), ...block.release];
        return [
            ...lines.map((line) => ({ code: line, block: null })),
            ...place.map((line, index) => ({ code: codeOf(line), block: index === place.length - 1 ? block : null })),
        ];
    }

    async pnpRunStop(): Promise<PlacingState> {
        const session = this.deviceSession;
        if (session) {
            session.progress.state = "stopped";
            session.progress.error = "stopped";
            this.deviceSession = null;
            if (session.device.stop) {
                this.deviceNote("tx", session.device.stop);
            }
        }
        this.emitPlacing();
        return this.placingStateOf();
    }

    /** The nozzle, or the top camera's picture center, over a part's place on the G-code machine: up to the safe height, then across. */
    private gcodeGotoPart(job: string, ref: string, camera = false): void {
        const device = this.gcodeIdle();
        const part = this.devicePart(job, ref);
        const { plan } = this.devicePlanOf(job, []);
        const [tx, ty] = turnPoint([part.x, part.y], plan.fit.rotation);
        let [x, y] = [tx + plan.fit.shift[0], ty + plan.fit.shift[1]];
        if (camera) {
            const offset = this.topOffsetOf(device);
            [x, y] = [x - offset[0], y - offset[1]];
        }
        this.headLines(device, [safeLine(device), moveLine(device, { x, y })]);
        this.emitPlacing();
    }

    /** Where the top camera's picture center is from the nozzle: as measured, else as the profile's design has it. */
    private topOffsetOf(device: MockDevice): [number, number] {
        if (this.topConfig.offset !== null) {
            return [this.topConfig.offset[0], this.topConfig.offset[1]];
        }
        if (device.top?.offset) {
            return [device.top.offset[0], device.top.offset[1]];
        }
        throw new ApiError(400, "the top camera's offset is not known: give [top_camera] offset in the profile, or Measure offset");
    }

    private deviceLines(device: MockDevice, lines: string[]): void {
        for (const line of lines) {
            this.deviceLine(device, line);
        }
    }

    /** Moves of the head run to their end (the file's wait), the place read after, as the backend's _head_lines. */
    private headLines(device: MockDevice, lines: string[]): void {
        if (lines.length === 0) {
            return;
        }
        this.deviceLines(device, device.wait ? [...lines, device.wait] : lines);
        this.deviceHere(device);
        this.emit({ type: "state", data: this.snapshot() });
    }

    /** The head's place read off the G-code machine. */
    private deviceHere(device: MockDevice): { x: number; y: number; z: number; rotation: number } {
        this.deviceLine(device, device.position);
        this.devicePositionRead = true;
        return { ...this.deviceLink.position };
    }

    async pnpPark(): Promise<PlacingState> {
        const device = this.gcodeIdle();
        if (device.park === null) {
            throw new ApiError(400, `${device.name}'s file has no [motion] park place`);
        }
        this.headLines(device, gotoLines(device, this.deviceHere(device), { x: device.park[0], y: device.park[1], z: device.safe_z }));
        this.emitPlacing();
        return this.placingStateOf();
    }

    async pnpOverCamera(): Promise<PlacingState> {
        const device = this.gcodeIdle();
        const position = this.deviceCameraPosition();
        if (position === null) {
            throw new ApiError(400, "the bottom camera's place on the machine is not known: set it, or Center nozzle over it");
        }
        const lines: string[] = [];
        if (device.light_on.length > 0 && this.deviceLink.light !== true) {
            lines.push(...device.light_on);
            this.deviceLink.light = true;
        }
        const here = this.deviceHere(device);
        lines.push(...gotoLines(device, here, { x: position[0], y: position[1], rotation: 0, z: device.camera_z ?? device.safe_z }));
        this.headLines(device, lines);
        this.emitPlacing();
        return this.placingStateOf();
    }

    async pnpSwap(to: "nozzle" | "camera"): Promise<PlacingState> {
        const device = this.gcodeIdle();
        const offset = this.topOffsetOf(device);
        const here = this.deviceHere(device);
        const sign = to === "nozzle" ? 1 : -1;
        this.headLines(device, gotoLines(device, here, { x: here.x + sign * offset[0], y: here.y + sign * offset[1] }));
        this.emitPlacing();
        return this.placingStateOf();
    }

    async pnpCameraPlace(request: { position?: [number, number]; here?: boolean; clear?: boolean }): Promise<PlacingState> {
        const device = request.here ? this.gcodeIdle() : this.placingDevice();
        if (request.clear) {
            this.placing().upPlace.position = null;
        } else if (request.here) {
            const here = this.deviceHere(device);
            this.placing().upPlace.position = [round4(here.x), round4(here.y)];
        } else if (request.position !== undefined) {
            if (!request.position.every((value) => Number.isFinite(value) && Math.abs(value) <= 10000)) {
                throw new ApiError(400, "the bottom camera's place must be within 10000 mm");
            }
            this.placing().upPlace.position = [request.position[0], request.position[1]];
        } else {
            throw new ApiError(400, "give a position, here or clear");
        }
        this.emitPlacing();
        return this.placingStateOf();
    }

    async pnpLight(on: boolean): Promise<PlacingState> {
        const device = this.gcodeIdle();
        const lines = on ? device.light_on : device.light_off;
        if (lines.length === 0) {
            throw new ApiError(400, `the machine file has no [gcode] light_${on ? "on" : "off"}`);
        }
        this.deviceLines(device, lines);
        this.deviceLink.light = on;
        this.emitPlacing();
        return this.placingStateOf();
    }

    async pnpVacuum(request: { on?: boolean; read?: boolean }): Promise<PlacingState & { reply: string[] }> {
        const device = this.gcodeIdle();
        if (request.on === undefined && !request.read) {
            throw new ApiError(400, "give on, or read");
        }
        let reply: string[] = [];
        if (request.on !== undefined) {
            this.deviceLines(device, request.on ? device.pick : device.place);
            this.deviceLink.vacuumSwitched = request.on;
        }
        if (request.read) {
            const vacuum = device.vacuum;
            if (vacuum === null) {
                throw new ApiError(400, "the machine file has no [vacuum] read lines");
            }
            for (const line of vacuum.read) {
                reply = this.deviceLine(device, line);
            }
            const value = vacuumReading(vacuum, reply);
            if (value === null) {
                throw new ApiError(502, `'${vacuum.read[vacuum.read.length - 1]}' answered no reading its pattern finds: ${reply.join(" | ") || "nothing"}`);
            }
            this.deviceLink.reading = value;
        }
        this.emitPlacing();
        return { reply, ...this.placingStateOf() };
    }

    /** The feeders on the mock's bus: the profile's, each at its slot, or at the first address no other takes. */
    private fakeBus(device: MockDevice): Map<number, string> {
        const bus = new Map<number, string>();
        const free = [...device.slots.map((slot) => slot.address), ...Array.from({ length: 254 }, (_, index) => index + 1)];
        for (const feeder of device.feeders) {
            if (feeder.bus_id !== null && feeder.slot !== null) {
                bus.set(feeder.slot, feeder.bus_id);
            }
        }
        for (const feeder of device.feeders) {
            if (feeder.bus_id !== null && feeder.slot === null) {
                const address = free.find((candidate) => !bus.has(candidate))!;
                bus.set(address, feeder.bus_id);
            }
        }
        return bus;
    }

    /** A packet on the mock's bus answered as its feeders answer: find, id, initialize, feed and status. */
    private busAnswer(device: MockDevice, hex: string): string {
        const bus = device.bus!;
        const packet = decodePacket(hex, bus.header);
        const codes = bus.codes;
        if (packet === null || packet.payload.length === 0) {
            return "rs485-reply: TIMEOUT";
        }
        const [code, ...body] = packet.payload;
        const reply = (sender: number, payload: number[]): string =>
            `rs485-reply: ${encodePacket({ to: packet.sender, sender, number: packet.number, payload }, bus.header)}`;
        const feeders = this.fakeBus(device);
        const asHex = (bytes: number[]): string => bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
        if (packet.to === bus.broadcast && code === codes["find"]) {
            const address = [...feeders.entries()].find(([, id]) => id === asHex(body))?.[0];
            return address !== undefined ? reply(address, [codes["ok"]!]) : "rs485-reply: TIMEOUT";
        }
        const id = feeders.get(packet.to);
        if (id === undefined) {
            return "rs485-reply: TIMEOUT";
        }
        if (code === codes["get_id"]) {
            return reply(packet.to, [codes["ok"]!, ...idBytes(id)]);
        }
        if (code === codes["init"]) {
            if (asHex(body) !== id) {
                return reply(packet.to, [codes["wrong_id"]!, ...idBytes(id)]);
            }
            this.busReady.add(packet.to);
            return reply(packet.to, [codes["ok"]!, ...idBytes(id)]);
        }
        if (code === codes["feed"]) {
            if (!this.busReady.has(packet.to)) {
                return reply(packet.to, [codes["uninitialized"]!]);
            }
            this.busFeeding.set(packet.to, 2);
            return reply(packet.to, [codes["ok"]!, 0x01, 0xf4]);
        }
        if (code === codes["status"]) {
            const left = this.busFeeding.get(packet.to) ?? 0;
            if (left > 1) {
                this.busFeeding.set(packet.to, left - 1);
                return reply(packet.to, [codes["busy"]!]);
            }
            this.busFeeding.delete(packet.to);
            return reply(packet.to, [codes["ok"]!]);
        }
        return "rs485-reply: TIMEOUT";
    }

    /** One command on the bus and its answer, as the backend's FeederBus sends it. */
    private busExchange(device: MockDevice, to: number, code: number, payload: number[] = []): BusPacket | null {
        const bus = device.bus!;
        const pattern = new RegExp(jsPattern(bus.reply));
        for (let attempt = 0; attempt < Math.max(1, bus.tries); attempt++) {
            const number = this.busNumber;
            this.busNumber = (this.busNumber + 1) % 256;
            const line = bus.send.replace("{packet}", encodePacket({ to, sender: bus.host, number, payload: [code, ...payload] }, bus.header));
            for (const text of this.deviceLine(device, line)) {
                const found = pattern.exec(text);
                if (!found) {
                    continue;
                }
                const answer = decodePacket(found.groups?.["packet"] ?? found[1] ?? "", bus.header);
                if (answer !== null && (!bus.header.includes("id") || answer.number === number)) {
                    return answer;
                }
            }
        }
        return null;
    }

    /** A bus feeder's tape moved on by its advance, as the backend's FeederBus does: found, initialized, fed, waited for. */
    private busAdvance(device: MockDevice, feeder: MockFeeder): number {
        const bus = device.bus!;
        const codes = bus.codes;
        let address = feeder.slot;
        if (address === null) {
            const found = this.busExchange(device, bus.broadcast, codes["find"]!, idBytes(feeder.bus_id!));
            if (found === null || found.payload[0] !== codes["ok"]) {
                throw new ApiError(502, `feeder ${feeder.id}: no feeder answered to the id ${feeder.bus_id}: is it in its slot?`);
            }
            address = found.sender;
        }
        for (let attempt = 0; attempt < 2; attempt++) {
            if (!this.busReady.has(address)) {
                const init = this.busExchange(device, address, codes["init"]!, idBytes(feeder.bus_id!));
                if (init === null || init.payload[0] !== codes["ok"]) {
                    throw new ApiError(502, `feeder ${feeder.id}: the feeder at address ${address} would not initialize`);
                }
            }
            const fed = this.busExchange(device, address, codes["feed"]!, [Math.round(feeder.advance * 10)]);
            if (fed === null) {
                throw new ApiError(502, `feeder ${feeder.id}: the feeder at address ${address} did not answer the feed`);
            }
            if (fed.payload[0] === codes["uninitialized"] && attempt === 0) {
                this.busReady.delete(address);
                continue;
            }
            for (let ask = 0; ask < 10; ask++) {
                const status = this.busExchange(device, address, codes["status"]!);
                if (status?.payload[0] === codes["ok"]) {
                    return address;
                }
            }
            throw new ApiError(502, `feeder ${feeder.id}: the feeder at address ${address} did not finish its feed`);
        }
        throw new ApiError(502, `feeder ${feeder.id}: the feeder at address ${address} stays uninitialized`);
    }

    /** The profile with each bus feeder whose slot it does not give placed by where the bus says it is. */
    private foundSlots(device: MockDevice): MockDevice {
        if (device.bus === null || !this.deviceLink.connected || !device.feeders.some((feeder) => feeder.bus_id !== null && feeder.at === null)) {
            return device;
        }
        const feeders = device.feeders.map((feeder) => {
            if (feeder.bus_id === null || feeder.at !== null) {
                return feeder;
            }
            const found = this.busExchange(device, device.bus!.broadcast, device.bus!.codes["find"]!, idBytes(feeder.bus_id));
            const slot = found !== null && found.payload[0] === device.bus!.codes["ok"] ? device.slots.find((entry) => entry.address === found.sender) : undefined;
            return slot ? { ...feeder, slot: slot.address, at: slotPlace(slot.at, slot.rotation, feeder.offset), rotation: feeder.rotation + slot.rotation } : feeder;
        });
        return { ...device, feeders };
    }

    async pnpBusScan(): Promise<PlacingState & { feeders: BusFeeder[] }> {
        const device = this.gcodeIdle();
        if (device.bus === null) {
            throw new ApiError(400, "the machine file has no [bus] section");
        }
        const found: BusFeeder[] = [];
        for (let address = 1; address <= device.bus.max_address; address++) {
            const answer = this.busExchange(device, address, device.bus.codes["get_id"]!);
            if (answer !== null && answer.payload[0] === device.bus.codes["ok"] && answer.payload.length >= 13) {
                const id = answer.payload.slice(1, 13).map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
                found.push({ address, id, feeder: device.feeders.find((feeder) => feeder.bus_id === id)?.id ?? null, slot: device.slots.some((slot) => slot.address === address) });
            }
        }
        this.emitPlacing();
        return { feeders: found, ...this.placingStateOf() };
    }

    async pnpBusFeed(feederId: string): Promise<PlacingState> {
        const device = this.gcodeIdle();
        const feeder = device.feeders.find((entry) => entry.id === feederId);
        if (!feeder) {
            throw new ApiError(404, `the profile has no feeder '${feederId}'`);
        }
        if (feeder.bus_id === null) {
            throw new ApiError(400, `feeder ${feederId} is not on the bus`);
        }
        if (device.bus === null) {
            throw new ApiError(400, "the machine file has no [bus] section");
        }
        const address = this.busAdvance(device, feeder);
        this.message("info", `feeder ${feederId} advanced ${gnum(feeder.advance)} mm (bus address ${address})`);
        this.emitPlacing();
        return this.placingStateOf();
    }

    async pnpBoardsReset(): Promise<PlacingState> {
        this.placing().boards = 0;
        this.emitPlacing();
        return this.placingStateOf();
    }

    /** One value of a machine file changed in its text, comments and all; a plain table not there yet is added at its end. */
    async patchMachineFile(id: string, path: CamPath, value: CamValue): Promise<MachineResponse> {
        let text = this.machineText(id);
        const table = path.slice(0, -1);
        if (table.length === 1 && typeof table[0] === "string" && value !== null && !new RegExp(`^\\s*\\[${table[0]}\\]\\s*(#.*)?$`, "m").test(text)) {
            text = `${text.replace(/\n+$/, "")}\n\n[${table[0]}]\n`;
        }
        let changed: string;
        try {
            changed = setValue(text, path, value);
        } catch (error) {
            throw new ApiError(400, errorText(error));
        }
        const saved = await this.saveMachineFile(id, changed);
        this.emitPlacing();
        return saved;
    }

    async pnpResetFeeders(feeder?: string): Promise<PlacingState> {
        if (feeder === undefined) {
            this.placing().taken = {};
        } else {
            delete this.placing().taken[feeder];
        }
        this.emitPlacing();
        return this.placingStateOf();
    }
}

/** A move as the line that asks the firmware for it. */
export function formatMove(move: Move): string {
    const focus = move.h !== undefined ? `H${formatFixed(move.h, 4)}` : "";
    // A cartesian machine's moves carry the cross slide and hold the table.
    const joints = jointWords(move.target.r, move.target.a, move.z);
    const words = move.headOnly ? focus : move.turn ? `A${formatFixed(move.target.a, 4)}` : [joints, focus].filter((word) => word !== "").join(" ");
    switch (move.kind) {
        case "go":
            return `go ${words}`;
        case "jog":
            return move.feed !== null ? `jogto ${words} F${gnum(move.feed)}` : `jogto ${words}`;
        case "cut": {
            if (move.milled) {
                return `cut ${words} F${gnum(move.feed ?? 0)}`;
            }
            const floor = (move.minPower ?? 0) > 0 ? ` M${gnum(Math.min(move.minPower ?? 0, move.power))}` : "";
            return `cut ${words} F${gnum(move.feed ?? 0)} S${gnum(move.power)}${floor}`;
        }
        case "dwell":
            return move.power > 0 ? `dwell T${move.ms ?? 0} S${move.power}` : `dwell T${move.ms ?? 0}`;
        case "spindle":
            return move.off ? "spindle off" : `spindle S${gnum(move.power)}`;
    }
}

/** The status line the firmware prints for `?`, with no negative zero; L is the output's duty as driven on the pin, a spindle's included. */
export function statusLine(machine: MockMachine): string {
    const free = machine.queueFree();
    const state = machine.state === "Alarm" ? `Alarm:${machine.alarm ?? 1}` : machine.state;
    // The focus axis fields are there only with the axis fitted.
    const focus = machine.hasFocusAxis() ? `|H:${formatFixed(machine.h, 3)}|P:${machine.probeActive() ? 1 : 0}` : "";
    const stops = machine.hasStops() ? `|D:${machine.homed}` : "";
    const joint = `J:${formatFixed(machine.joint.r, 3)},${formatFixed(machine.joint.a, 4)}`;
    const duty = Math.round(machine.status().laser);
    return `<${state}|${joint}|V:${formatFixed(machine.rate, 0)}|L:${duty}|Q:${free.planner},${free.lines}|M:${machine.mode}|E:${machine.enabled ? 1 : 0}|Z:${formatFixed(machine.z, 3)}${focus}${stops}>`;
}

/**
 * What the drivers answer to `$tmc`, one line per socket with the
 * microsteps read back from them; the focus axis socket is empty without
 * the axis.
 */
function tmcReport(machine: MockMachine): string[] {
    const sockets: [string, number, string, boolean][] = [
        ["R", 0, "tmc_r_micro", true],
        ["A", 2, "tmc_a_micro", true],
        ["Z", 1, "tmc_z_micro", true],
        ["H", 3, "tmc_h_micro", machine.hasFocusAxis()],
    ];
    return sockets.map(([letter, addr, name, used]) =>
        used
            ? `[MSG:tmc ${letter} addr${addr} ifcnt=1 micro=${machine.settings[name] ?? 256} status=0x00000000]`
            : `[MSG:tmc ${letter} addr${addr} unused, no reply]`,
    );
}
