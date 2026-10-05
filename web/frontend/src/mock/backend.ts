// In-page fake backend for `?mock=1`: a machine that moves at the firmware's
// rates, the job store, and the event feed the real WebSocket would carry.

import { ApiError, type Api } from "../api.ts";
import {
    AXIS_EPSILON,
    DEG,
    cartesianSurfaceLength,
    headBoard,
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
    centerJob,
    checkDepth,
    checkPasses,
    checkPower,
    checkSpeed,
    computeStats,
    demoCoupon,
    formatG,
    groupMoves,
    jointPreview,
    pathMoves,
    placeJob,
    type PlannedMove,
} from "./jobs.ts";
import { ID_PATTERN, SHIPPED_PROFILES, buildCamJob, camGcode, parseProfile, setValue, summaryOf } from "./cam.ts";
import type { LinkStatus } from "../state.ts";
import type {
    CamGcodeResponse,
    CamJobResponse,
    CamPath,
    CamProfileResponse,
    CamProfilesResponse,
    CamValue,
    Board,
    CenterRequest,
    CenterResponse,
    Compensate,
    GotoRequest,
    Grid,
    Group,
    HeightMap,
    HeightMapState,
    HostSettings,
    Job,
    JobPatch,
    JobSummary,
    JogRequest,
    Joint,
    Machine,
    MachineState,
    MachineSummary,
    MachinesResponse,
    Mode,
    Path,
    Port,
    PositionRequest,
    ProbeProgress,
    ProbeSettings,
    Profile,
    Progress,
    RealtimeAction,
    RunState,
    SettingSchema,
    SettingsResponse,
    SettingsUpdate,
    Snapshot,
    UploadOptions,
    WsEvent,
} from "../types.ts";
import type { EventFeed } from "../ws.ts";

export const MOCK_VERSION = "0.1.0-mock";
const CLOCK_EPSILON = 1e-9;
export const LINE_SLOTS = 16;
export const PLANNER_BLOCKS = 32;

/** The firmware's shipped defaults. */
export const DEFAULT_SETTINGS: Record<string, number> = {
    r_steps: 10240,
    a_steps: 14222.222,
    r_rate: 560,
    a_rate: 400,
    r_accel: 50,
    a_accel: 50,
    r_jerk: 3,
    a_jerk: 2,
    r_max: 0,
    z_steps: 10240,
    z_rate: 560,
    z_accel: 50,
    jog_z: 120,
    jog_r: 300,
    jog_a: 200,
    dir_invert: 0,
    en_invert: 0,
    idle_ms: 0,
    step_us: 2,
    laser_hz: 5000,
    s_max: 1000,
    s_min: 0,
    laser_invert: 0,
    laser_ms: 5000,
    tmc_r_ma: 800,
    tmc_a_ma: 800,
    tmc_hold_pct: 50,
    tmc_r_micro: 256,
    tmc_a_micro: 256,
    tmc_z_ma: 800,
    tmc_z_micro: 256,
    tmc_stealth: 1,
    h_axis: 0,
    h_steps: 6400,
    h_rate: 600,
    h_accel: 50,
    h_jerk: 1,
    jog_h: 120,
    probe_invert: 0,
    tmc_h_ma: 600,
    tmc_h_micro: 256,
    probe_ms: 20,
    z_jerk: 3,
    z_max: 0,
    cartesian: 0,
    spindle: 0,
};

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
    { name: "h_axis", unit: "0/1", help: "1 = a focus axis is fitted, on the E socket" },
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
];

/** Largest value a float setting takes, as the firmware bounds them. */
const FLOAT_MAX = 1e7;
/** Settings the firmware holds as 0 or 1. */
const FLAG_SETTINGS = new Set(["en_invert", "laser_invert", "tmc_stealth", "h_axis", "probe_invert", "cartesian", "spindle"]);
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
]);
const U32_MAX = 4294967295;
/** Most motion a probe keeps queued, ms: the firmware's segment ring. */
const PROBE_MS_MAX = 160;
const MICROSTEPS = [1, 2, 4, 8, 16, 32, 64, 128, 256];
/** The wiring, which `$defaults` leaves as it is: an active-low laser taken back to active high would light. */
const WIRING_SETTINGS = ["laser_invert", "en_invert", "probe_invert", "dir_invert"];
/** Settings that scale or turn the axes, so the focus axis frame a height map is tied to. */
const FRAME_SETTINGS = new Set(["r_steps", "a_steps", "z_steps", "h_steps", "dir_invert", "cartesian", "h_axis"]);

/** A typed `$` line that may change the frame the axes count in. */
function reframes(text: string): boolean {
    const body = (text.slice(1).split(";")[0] ?? "").trim().toLowerCase();
    if (body === "load" || body === "defaults") {
        return true;
    }
    return FRAME_SETTINGS.has((body.split("=")[0] ?? "").trim());
}
/** Largest whole number and other value the backend sends as a setting. */
const INT_SETTING_MAX = U32_MAX;
const SETTING_MAX = 1e7;
/** Largest chord tolerance the backend takes, mm. */
const MAX_TOLERANCE = 10;

/**
 * The firmware's check of a whole set of settings, so the rules that span
 * two of them hold: every value in its range, whole numbers where the
 * firmware keeps an integer, and `s_min` within `s_max`.
 */
/**
 * The machine files the mock stands in for: the ones shipped in machines/,
 * each as its settings differ from the defaults, with the host values the
 * file names.
 */
export const MOCK_MACHINES: { summary: MachineSummary; values: Record<string, number>; host: HostSettings }[] = [
    {
        summary: { id: "polar-laser", name: "Polar laser", description: "UV laser on the rail, the board turning under it on the table", kinematics: "polar", tool: "laser", focus: false },
        values: {},
        host: { tolerance: 0.005 },
    },
    {
        summary: { id: "polar-laser-focus", name: "Polar laser with focus axis", description: "The polar laser with a motorized focus axis and a touch probe", kinematics: "polar", tool: "laser", focus: true },
        values: { h_axis: 1 },
        host: { tolerance: 0.005 },
    },
    {
        summary: { id: "cartesian-laser", name: "Cartesian laser", description: "Rail as X and cross slide as Y, the table holding still", kinematics: "cartesian", tool: "laser", focus: false },
        values: { cartesian: 1, z_max: 30 },
        host: { tolerance: 0.005 },
    },
    {
        summary: { id: "cartesian-mill", name: "Cartesian mill", description: "X/Y machine with a spindle on the output and the focus axis as depth", kinematics: "cartesian", tool: "spindle", focus: true },
        values: { cartesian: 1, spindle: 1, h_axis: 1, z_max: 30 },
        host: { tolerance: 0.005, clearance: 2, spinup: 2 },
    },
];

/** The machine file these settings are, every one of them, or null. */
export function machineOf(settings: Record<string, number>): string | null {
    for (const { summary, values } of MOCK_MACHINES) {
        const expected: Record<string, number> = { ...DEFAULT_SETTINGS, ...values };
        const same = Object.keys(expected).every((name) => Math.abs((settings[name] ?? Number.NaN) - (expected[name] ?? Number.NaN)) <= 5e-4);
        if (same) {
            return summary.id;
        }
    }
    return null;
}

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
        if (INT_SETTINGS.has(name) && !(Number.isInteger(v) && v >= 0 && v <= U32_MAX)) {
            return false;
        }
        if (/_(steps|rate|accel|jerk)$/.test(name) || name.startsWith("jog_")) {
            if (!(v > 0 && v <= FLOAT_MAX)) {
                return false;
            }
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
        within("probe_ms", 0, PROBE_MS_MAX) &&
        within("step_us", 1, 20) &&
        within("laser_hz", 100, 100000) &&
        within("laser_ms", 1, 60000) &&
        within("tmc_hold_pct", 0, 100) &&
        value("s_max") > 0 &&
        value("s_max") <= FLOAT_MAX &&
        within("s_min", 0, value("s_max"))
    );
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

/** A setting's value as the backend writes it on a line: a whole number as it is, others to six decimals. */
function settingText(value: number): string {
    if (Number.isInteger(value)) {
        return String(value);
    }
    const text = value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
    return text === "" || text === "-" || text === "-0" ? "0" : text;
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
    "dwell T [S] | mode dyn|const | laser S [T] | laser off | set [R] [A] [H]",
    "spindle=1: spindle S | spindle off; no S or M on cut and dwell, no laser S",
    "enable | disable | unlock | version | status | help",
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

    /** What the machine is, as the backend reads it from the settings. */
    profile(): Profile {
        return {
            kinematics: this.cartesian() ? "cartesian" : "polar",
            tool: this.milling() ? "spindle" : "laser",
            h_axis: this.hasFocusAxis(),
            r_max: this.settings["r_max"] ?? 0,
            z_max: this.settings["z_max"] ?? 0,
        };
    }

    milling(): boolean {
        return (this.settings["spindle"] ?? 0) !== 0;
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
        return headBoard(joint, z, this.cartesian());
    }

    /** The board point under the probe tip with the joints at `joint`: the tip is off the beam along the rail and across it. */
    tipBoard(joint: Joint = this.joint, z: number = this.z): Board {
        const [along, across] = this.probeOffset;
        const slide = this.cartesian() ? z : 0;
        return turned({ x: joint.r + along, y: slide + across }, joint.a);
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
        if (milling && move.kind === "cut" && (move.power > 0 || (move.minPower ?? 0) > 0)) {
            // A spindle's speed is its own command's: an S on a cut is a laser job.
            throw new MachineError(2, "bad word");
        }
        if (milling && move.kind === "dwell" && move.power > 0) {
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
        const length = this.cartesian() ? cartesianSurfaceLength(from, to, fromZ, toZ) : surfaceLength(from, to);
        const hRate = s["h_rate"] ?? 600;
        const headOnly = Math.abs(to.r - from.r) < 1e-9 && Math.abs(to.a - from.a) < 1e-9 && Math.abs(toZ - fromZ) < 1e-9;
        let rates = [s["r_rate"] ?? 560, s["a_rate"] ?? 400, s["z_rate"] ?? 560];
        let feed: number | null = null;
        let focusRate = hRate;
        if (move.kind === "jog" && move.feed === null) {
            rates = [s["jog_r"] ?? 300, s["jog_a"] ?? 200, s["jog_z"] ?? 120];
            focusRate = s["jog_h"] ?? 120;
        } else if (move.kind !== "go") {
            feed = move.feed;
            if (headOnly && feed !== null) {
                focusRate = Math.min(feed, hRate);
            }
        }
        const [rRate = 560, aRate = 400, zRate = 560] = rates;
        const wanted = feed !== null && feed > 0 && length >= AXIS_EPSILON ? length / feed : 0;
        const minutes = Math.max(wanted, Math.abs(to.r - from.r) / rRate, Math.abs(to.a - from.a) / aRate, Math.abs(toZ - fromZ) / zRate);
        return Math.max(minutes, Math.abs(toH - fromH) / focusRate) * 60;
    }

    /** Duty in permille for a move of board length `length` at the achieved speed; a spindle's output is its own. */
    private dutyFor(move: Move, achieved: number, length: number): number {
        if (this.milling()) {
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
            const length = this.cartesian() ? cartesianSurfaceLength(active.from, active.to, active.fromZ, active.toZ) : surfaceLength(active.from, active.to);
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
        if (this.milling()) {
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
        if ((settings["spindle"] ?? 0) !== (this.settings["spindle"] ?? 0)) {
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
    /** Seconds spent on the point in progress. */
    elapsed: number;
    /** The head's height when probing began, which it travels at between points. */
    travel: number;
    map: HeightMap;
    /** Seconds unrounded; the state rounds them. */
    progress: ProbeProgress;
}

/** A plain decimal with trailing zeros dropped and no negative zero. */
function num(value: number, decimals = 3): string {
    return String(Number(value.toFixed(decimals)));
}

/** A fixed-decimal word value without a negative zero. */
function coord(value: number, decimals: number): string {
    const text = value.toFixed(decimals);
    return Number(text) === 0 ? text.replace(/^-/, "") : text;
}

/** Six significant digits, trailing zeros dropped: the backend's short number format. */
function shortNumber(value: number): string {
    return String(Number(value.toPrecision(6)));
}

function round4(value: number): number {
    return Math.round(value * 1e4) / 1e4;
}

function clamp(value: number, low: number, high: number): number {
    return value < low ? low : value > high ? high : value;
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
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

/** The finer of the two point spacings, mm. */
function gridSpacing(grid: Grid): number {
    return Math.min((grid.x1 - grid.x0) / (grid.nx - 1), (grid.y1 - grid.y0) / (grid.ny - 1));
}

/** Every point as [ix, iy], row by row with every other row reversed, so the head never crosses the board between two points. */
export function gridOrder(grid: Grid): [number, number][] {
    const out: [number, number][] = [];
    for (let iy = 0; iy < grid.ny; iy++) {
        for (let k = 0; k < grid.nx; k++) {
            out.push([iy % 2 === 0 ? k : grid.nx - 1 - k, iy]);
        }
    }
    return out;
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
                `the probe cannot reach (${x.toFixed(2)}, ${y.toFixed(2)}): its tip is ${shortNumber(Math.abs(across))} mm off` +
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

/** Refuses a map whose shape does not match its grid. */
function checkHeightMap(map: HeightMap): void {
    checkGrid(map.grid);
    if (map.heights.length !== map.grid.ny || map.heights.some((row) => row.length !== map.grid.nx)) {
        throw new Error(`heights must be ${map.grid.ny} rows of ${map.grid.nx}`);
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
    };
    const numbers = [...Object.values(read.grid), ...probedValues(read), read.focus_offset, ...read.probe_offset];
    if (!numbers.every((value) => typeof value === "number" && Number.isFinite(value))) {
        throw new ApiError(422, "a height map's numbers must be finite");
    }
    return read;
}

/** Refuses a map a run should not follow. */
function checkUsable(map: HeightMap): void {
    const values = probedValues(map);
    const total = map.grid.nx * map.grid.ny;
    if (values.length !== total) {
        throw new Error(`the height map is not complete: ${values.length} of ${total} points probed`);
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
    const xs: number[] = [];
    const ys: number[] = [];
    for (const group of job.groups) {
        if (!group.enabled) {
            continue;
        }
        const points: [number, number][] =
            group.joints && group.joints.length > 0 ? group.joints.flatMap((poly) => jointPreview(poly)) : group.paths.flat();
        for (const [x, y] of points) {
            xs.push(x);
            ys.push(y);
        }
    }
    if (xs.length === 0) {
        return null;
    }
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
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

export interface MockOptions {
    /** Drive the simulation from a timer; off for tests, which call `step`. */
    timers?: boolean;
    /** Ms between timer ticks. */
    tickMs?: number;
    /** Time source in ms. */
    now?: () => number;
}

/** Fake API and event feed: `api` and `feed` in one object. */
export class MockBackend implements Api, EventFeed {
    readonly machine = new MockMachine(MOCK_MACHINE_SETTINGS);
    connected = false;
    url: string | null = null;
    tolerance = 0.005;
    /** The host's milling settings: travel height over the surface, mm, and the spin-up dwell, s. */
    clearance = 2;
    spinup = 2;
    status: LinkStatus = "closed";

    private jobStore = new Map<string, Job>();
    /** The CAM profiles, by id, as their files read; the shipped ones to start with. */
    private camTexts = new Map<string, string>(SHIPPED_PROFILES.map((profile) => [profile.id, profile.text]));
    private order: string[] = [];
    private nextId = 1;
    private session: RunSession | null = null;
    private lastProgress: Progress | null = null;
    /** Board moves waiting for a free line slot, sent as the machine drains. */
    private outbox: { line: string; move: Move }[] = [];
    private eventListeners = new Set<(event: WsEvent) => void>();
    private statusListeners = new Set<(status: LinkStatus) => void>();
    private readonly useTimers: boolean;
    private readonly tickMs: number;
    private readonly now: () => number;
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

    constructor(options: MockOptions = {}) {
        this.useTimers = options.timers ?? true;
        this.tickMs = options.tickMs ?? 50;
        this.now = options.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
        // The simulated probe sits where the probe settings say it is mounted.
        this.machine.probeOffset = [...this.probeConfig.offset];
        this.seedDemo();
    }

    // Event feed.

    start(): void {
        this.setStatus("open");
        if (this.useTimers && this.timer === null) {
            this.lastTick = this.now();
            this.timer = setInterval(() => {
                const now = this.now();
                const dt = Math.min(0.5, Math.max(0, (now - this.lastTick) / 1000));
                this.lastTick = now;
                this.step(dt);
            }, this.tickMs);
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
            const period = wasMoving || this.machine.moving() ? 0.1 : 0.2;
            this.stateClock += dt;
            if (this.stateClock >= period - CLOCK_EPSILON) {
                this.stateClock = Math.min(this.stateClock - period, period / 2);
                this.emit({ type: "state", data: this.snapshot() });
            }
        }
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
                this.message("error", error instanceof Error ? error.message : String(error));
                break;
            }
        }
    }

    snapshot(): Snapshot {
        return {
            connected: this.connected,
            url: this.url,
            firmware: this.connected ? { version: MOCK_VERSION, lines: LINE_SLOTS, blocks: PLANNER_BLOCKS } : null,
            machine: this.connected ? this.machine.status() : null,
            profile: this.machine.profile(),
            run: this.progress(),
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
            acked: Math.max(0, Math.min(session.next, acked)),
            total: session.moves.length,
            seconds: session.seconds,
            estimate: session.job.stats.seconds,
            group: session.group,
        };
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
                    this.message("error", error instanceof Error ? error.message : String(error));
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
            { url: "/dev/ttyACM0", description: "RP2040 spinny firmware (mock)" },
        ];
        if (this.lastSocket) {
            ports.push({ url: this.lastSocket, description: "virtual firmware" });
        }
        return ports;
    }

    async connect(url: string): Promise<Snapshot> {
        if (!url) {
            throw new ApiError(400, "no port given");
        }
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
            const joint = turned(target, -this.machine.joint.a);
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
        this.requireMovable();
        const feed = request.feed ?? null;
        this.checkFeed(feed);
        const feedWord = feed ? ` F${num(feed)}` : "";
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
                this.exchange(`jog Z${num(dz)}${feedWord}`, () => this.machine.slideJog(dz, feed));
                return;
            }
            // The backend's words: a relative jog leaves out an axis that does not move.
            const words = [
                dr ? `R${num(dr)}` : "",
                da ? `A${num(da, 4)}` : "",
                dh ? `H${num(dh, 4)}` : "",
                dz ? `Z${num(dz)}` : "",
            ].filter((w) => w !== "");
            if (words.length === 0) {
                throw new ApiError(400, "a joint move needs a radius, an angle, a focus height or a cross slide position");
            }
            // A relative jog ends where its start does, moved; a turn of a
            // cartesian table moves the frame that end is kept in.
            const known = this.startKnown() && !(cartesian && da);
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
        this.requireMovable();
        const feed = request.feed ?? null;
        this.checkFeed(feed);
        const feedWord = feed ? ` F${num(feed)}` : "";
        const cartesian = this.machine.cartesian();
        if (request.kind === "joint") {
            const { r, a, h, z } = request as { r?: number; a?: number; h?: number; z?: number };
            if (z !== undefined && !cartesian) {
                if (r !== undefined || a !== undefined || h !== undefined) {
                    throw new ApiError(400, "the cross slide moves on its own: z cannot be sent with r, a or h");
                }
                this.exchange(`jogto Z${num(z)}${feedWord}`, () => this.machine.slideTo(z, feed));
                return;
            }
            const words = [
                r !== undefined ? `R${num(r)}` : "",
                a !== undefined ? `A${num(a, 4)}` : "",
                h !== undefined ? `H${num(h, 4)}` : "",
                z !== undefined ? `Z${num(z)}` : "",
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
        this.requireConnected();
        this.outbox = [];
        this.jogTracked = false;
        this.line("tx", "<0x85>");
        this.machine.jogCancel();
        this.emit({ type: "state", data: this.snapshot() });
    }

    async setPosition(request: PositionRequest): Promise<void> {
        this.requireMovable();
        const words = [
            request.r !== undefined ? `R${num(request.r)}` : "",
            request.a !== undefined ? `A${num(request.a, 4)}` : "",
            request.h !== undefined ? `H${num(request.h, 4)}` : "",
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
                this.exchange(`set Z${num(z)}`, () => this.machine.setPosition({ z }));
            }
        } finally {
            // H renumbered moves the frame the map's heights are in, and R,
            // A or Z the board under them, whether or not a line was taken.
            this.frameChanged("the position was set");
        }
    }

    /** Motors on at any time; off only while nothing owns the machine, since the focus axis would sink with the rest. */
    async motors(enabled: boolean): Promise<void> {
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
        this.exchange("unlock", () => this.machine.unlock());
    }

    async realtime(action: RealtimeAction): Promise<void> {
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
        /** Z is a joint on a cartesian machine and nothing on a polar one; A stays off `go` and `cut` on a cartesian one. */
        const boardWords = (words: Map<string, number>): void => {
            if (words.has(cartesian ? "A" : "Z")) {
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
                // A spindle's speed is its own command's: an S or M here is a
                // laser job sent to a machine that has no beam.
                if (milling && (words.has("S") || words.has("M"))) {
                    return ["error:2 bad word"];
                }
                machine.checkCut();
                // F and S are modal, but a reset forgets them: the first
                // cut after one must give F again. A spindle leaves S alone.
                const feed = get(words, "F") ?? machine.feed;
                const power = milling ? 0 : get(words, "S") ?? machine.power;
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
        this.exchange(`laser S${num(power)} T${t}`, () => this.machine.beam(power, t));
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
        this.exchange(`spindle S${num(power)}`, () => this.machine.spin(power));
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
        return {
            values: { ...this.machine.settings },
            schema: SETTINGS_SCHEMA,
            host: { tolerance: this.tolerance, clearance: this.clearance, spinup: this.spinup },
            machine: machineOf(this.machine.settings),
        };
    }

    async machines(): Promise<MachinesResponse> {
        return {
            machines: MOCK_MACHINES.map((entry) => ({ ...entry.summary })),
            current: this.connected ? machineOf(this.machine.settings) : null,
            problems: [],
        };
    }

    /** A machine file's every setting, as the backend writes them: all or nothing, then saved to flash when asked. */
    async applyMachine(id: string, save = false): Promise<SettingsResponse> {
        const found = MOCK_MACHINES.find((entry) => entry.summary.id === id);
        if (!found) {
            throw new ApiError(404, `no machine file '${id}'`);
        }
        await this.updateSettings({ values: { ...DEFAULT_SETTINGS, ...found.values }, host: { ...found.host } });
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
        if (!(Number.isFinite(clearance) && clearance > 0 && clearance <= 100)) {
            throw new ApiError(400, "the clearance must be above 0 and at most 100 mm");
        }
        if (!(Number.isFinite(spinup) && spinup >= 0 && spinup <= 600)) {
            throw new ApiError(400, "the spin-up must be 0 to 600 s");
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
            texts.push([name, settingText(value)]);
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
            // Whatever went before is put back; a value that cannot be is
            // skipped for the next.
            for (const [name, before] of applied) {
                try {
                    this.exchange(`$${name}=${settingText(before)}`, () => this.machine.setSetting(name, before));
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

    private limits(): { rRate: number; aRate: number; tolerance: number } {
        return {
            rRate: this.machine.settings["r_rate"] ?? 560,
            aRate: this.machine.settings["a_rate"] ?? 400,
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
            groups,
            outline: placed.outline,
            copper: placed.copper,
            stats: computeStats(groups, this.limits()),
        };
        this.jobStore.set(id, job);
        this.order.push(id);
    }

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
                problems.push(error instanceof Error ? error.message : String(error));
            }
        }
        return { profiles, problems };
    }

    private camText(id: string): string {
        if (!ID_PATTERN.test(id)) {
            throw new ApiError(400, `'${id}' is not a profile id: lower case letters, digits, - and _`);
        }
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
            throw new ApiError(400, error instanceof Error ? error.message : String(error));
        }
    }

    async camProfile(id: string): Promise<CamProfileResponse> {
        return this.camDocument(id, this.camText(id));
    }

    /** Kept once it reads as a profile, as the backend writes the file. */
    async saveCamProfile(id: string, text: string): Promise<CamProfileResponse> {
        if (!ID_PATTERN.test(id)) {
            throw new ApiError(400, `'${id}' is not a profile id: lower case letters, digits, - and _`);
        }
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
            throw new ApiError(400, error instanceof Error ? error.message : String(error));
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
        const text = await design.text();
        let built: ReturnType<typeof buildCamJob>;
        try {
            built = buildCamJob(this.newId(), profile, name?.trim() || design.name.replace(/\.[^.]+$/, ""), design.name, text, this.limits());
        } catch (error) {
            throw new ApiError(400, error instanceof Error ? error.message : String(error));
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
            throw new ApiError(400, error instanceof Error ? error.message : String(error));
        }
    }

    async uploadJob(file: File, options: UploadOptions): Promise<Job> {
        const text = await file.text();
        let built: ReturnType<typeof buildJob>;
        try {
            built = buildJob(this.newId(), file.name, text, options, this.limits());
        } catch (error) {
            throw new ApiError(400, error instanceof Error ? error.message : String(error));
        }
        this.jobStore.set(built.job.id, built.job);
        this.order.push(built.job.id);
        if (built.note) {
            this.message("info", built.note);
        }
        return built.job;
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
            throw new ApiError(400, error instanceof Error ? error.message : String(error));
        }
        this.jobStore.set(built.job.id, built.job);
        this.order.push(built.job.id);
        return built;
    }

    async jobs(): Promise<JobSummary[]> {
        return this.order.map((id) => {
            const job = this.jobStore.get(id);
            if (!job) {
                throw new ApiError(500, "job list out of step");
            }
            return {
                id: job.id,
                name: job.name,
                source: job.source,
                spot: job.spot,
                offset: job.offset,
                groups: job.groups.map((group) => ({
                    label: group.label,
                    power: group.power,
                    min_power: group.min_power,
                    speed: group.speed,
                    passes: group.passes,
                    enabled: group.enabled,
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

    /** The whole patch is checked first and applied to a copy, so a refused one changes nothing. */
    async patchJob(id: string, patch: JobPatch): Promise<void> {
        const job = this.requireJob(id);
        if (this.session && this.session.job.id === id) {
            throw new ApiError(409, "the job is running");
        }
        try {
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
        } catch (error) {
            throw new ApiError(400, error instanceof Error ? error.message : String(error));
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
            if (change.enabled !== undefined) {
                group.enabled = change.enabled;
            }
        }
        if (patch.offset) {
            const dx = patch.offset.x - updated.offset.x;
            const dy = patch.offset.y - updated.offset.y;
            const move = (paths: Job["outline"]): Job["outline"] => paths.map((path) => path.map(([x, y]) => [x + dx, y + dy]));
            for (const group of updated.groups) {
                group.paths = move(group.paths);
            }
            updated.outline = move(updated.outline);
            updated.copper = move(updated.copper);
            updated.offset = { ...patch.offset };
        }
        updated.stats = computeStats(updated.groups, this.limits());
        this.jobStore.set(id, updated);
    }

    async deleteJob(id: string): Promise<void> {
        this.requireJob(id);
        if (this.session && this.session.job.id === id) {
            throw new ApiError(409, "job is running");
        }
        this.jobStore.delete(id);
        this.order = this.order.filter((other) => other !== id);
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
        const angle = this.machine.joint.a;
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
     * a spindle the job is milled instead.
     */
    movesFor(job: Job, focus: HeightMap | null = null): Move[] {
        const machine = this.machine;
        const surface = focus ? (target: Joint, z: number): number => {
            const board = machine.headBoard(target, z);
            return heightAt(focus, board.x, board.y) + focus.focus_offset;
        } : null;
        if (machine.milling()) {
            return this.millingMoves(job, focus, surface);
        }
        const cartesian = machine.cartesian();
        const moves: Move[] = [];
        let joint = machine.endpoint();
        let z = machine.endpointZ();
        job.groups.forEach((group, index) => {
            if (!group.enabled) {
                return;
            }
            for (const step of this.groupSteps(group, joint, z)) {
                const move: Move =
                    step.kind === "go"
                        ? { kind: "go", target: step.target, feed: null, power: 0, group: index }
                        : { kind: "cut", target: step.target, feed: group.speed, power: group.power, minPower: group.min_power, group: index };
                if (cartesian) {
                    move.z = step.z;
                }
                if (surface) {
                    move.h = round4(surface(step.target, step.z));
                }
                moves.push(move);
                joint = step.target;
                z = step.z;
            }
        });
        const first = moves[0];
        if (surface && first?.kind === "cut") {
            const start = machine.endpoint();
            const startZ = machine.endpointZ();
            moves.unshift({ kind: "go", target: start, h: round4(surface(start, startZ)), headOnly: true, feed: null, power: 0, group: first.group });
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
    private millingMoves(job: Job, map: HeightMap | null, surface: ((target: Joint, z: number) => number) | null): Move[] {
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
        let joint = machine.endpoint();
        let z = machine.endpointZ();
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
            if (group.power !== speed) {
                speed = group.power;
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

    async runJob(id: string, compensate: Compensate = "off"): Promise<void> {
        this.requireConnected();
        const job = this.requireJob(id);
        this.refuseWhileProbing();
        if (this.machine.milling() && !this.machine.hasFocusAxis()) {
            throw new ApiError(400, "a spindle needs the focus axis as its depth axis: set $h_axis=1");
        }
        const followed = this.compensation(compensate, job);
        if (this.session) {
            throw new ApiError(409, "a job is already running");
        }
        if (this.machine.state !== "Idle" || this.outbox.length > 0) {
            throw new ApiError(409, "machine is not idle");
        }
        let moves: Move[];
        try {
            moves = this.movesFor(job, followed?.mode === "focus" ? followed.map : null);
        } catch (error) {
            throw new ApiError(400, errorText(error));
        }
        if (moves.length === 0) {
            throw new ApiError(400, "job has no enabled paths");
        }
        this.jogTracked = false;
        this.session = { job, moves, next: 0, okSent: 0, state: "running", seconds: 0, group: 0 };
        this.lastProgress = null;
        const following = followed ? `, following the board by ${followed.mode}` : "";
        this.message("info", `running ${job.name}: ${moves.length} moves${following}`);
        this.serviceRun(0);
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
        return {
            map: this.heightmap ? structuredClone(this.heightmap) : null,
            probe: progress
                ? { ...progress, point: progress.point ? [progress.point[0], progress.point[1]] : null, seconds: Math.round(progress.seconds * 10) / 10 }
                : null,
            settings: structuredClone(this.probeConfig),
        };
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
    async probe(grid: Grid): Promise<HeightMapState> {
        this.requireConnected();
        this.notOwned();
        try {
            checkGrid(grid);
        } catch (error) {
            throw new ApiError(400, errorText(error));
        }
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
        const settings = structuredClone(this.probeConfig);
        // Every point is checked for reach before the first move, soft limits included.
        const xs = gridXs(grid);
        const ys = gridYs(grid);
        const order = gridOrder(grid);
        const joints: ProbeJoint[] = [];
        const cartesian = machine.cartesian();
        const rMax = machine.settings["r_max"] ?? 0;
        const zMax = machine.settings["z_max"] ?? 0;
        let angle = machine.joint.a;
        for (const [ix, iy] of order) {
            const x = xs[ix] ?? 0;
            const y = ys[iy] ?? 0;
            const where = `the probe cannot reach (${x.toFixed(2)}, ${y.toFixed(2)}): the head would go to`;
            let joint: ProbeJoint;
            if (cartesian) {
                // The rail and the cross slide put the tip over the point; the table stays.
                const head = turned({ x, y }, -machine.joint.a);
                joint = { r: head.x - settings.offset[0], a: machine.joint.a, z: head.y - settings.offset[1] };
                if (zMax > 0 && Math.abs(joint.z ?? 0) > zMax + 1e-9) {
                    throw new ApiError(409, `${where} Z${(joint.z ?? 0).toFixed(3)}, past the soft limit z_max=${formatG(zMax)}`);
                }
            } else {
                try {
                    joint = probeJoint([x, y], settings.offset, angle, gridSpacing(grid) / 2);
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
        const map: HeightMap = {
            grid: { x0: grid.x0, y0: grid.y0, x1: grid.x1, y1: grid.y1, nx: grid.nx, ny: grid.ny },
            heights: Array.from({ length: grid.ny }, () => Array<number | null>(grid.nx).fill(null)),
            focus_offset: 0,
            focus_set: false,
            probe_offset: [settings.offset[0], settings.offset[1]],
            created: new Date().toISOString().replace(/\.\d+Z$/, "+00:00"),
        };
        // A map probed before keeps its focus offset only if the probe has
        // not moved, the offset being contact to focus for that probe, and
        // its heights are in this focus axis frame.
        const previous = this.heightmap;
        const sameProbe = previous && previous.probe_offset[0] === settings.offset[0] && previous.probe_offset[1] === settings.offset[1];
        if (previous && sameProbe && this.heightsFrame === this.frame) {
            map.focus_offset = previous.focus_offset;
            map.focus_set = previous.focus_set;
        }
        this.heightsFrame = this.frame;
        this.jogTracked = false;
        // The new map replaces the old one from the start, so its grid fills in.
        this.heightmap = map;
        const progress: ProbeProgress = { state: "running", done: 0, total: grid.nx * grid.ny, point: null, seconds: 0, error: null };
        this.probeProgress = progress;
        const session: ProbeSession = { settings, order, joints, next: 0, elapsed: 0, travel: machine.h, map, progress };
        this.probing = session;
        this.emitHeightMap();
        this.probeBegin(session);
        return this.heightMapState();
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
        map.focus_set = true;
        this.focusFrame = this.frame;
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
        const point = session.order[session.next];
        const joint = session.joints[session.next];
        if (!point || !joint) {
            session.progress.point = null;
            this.probeFinish(session, "done", null);
            return;
        }
        session.progress.point = point;
        this.emitHeightMap();
        const words = joint.z !== undefined ? `R${coord(joint.r, 3)} Z${coord(joint.z, 3)}` : `R${coord(joint.r, 3)} A${coord(joint.a, 4)}`;
        this.probeRequest(session, `go ${words}`, () => this.probeGo(joint, null));
    }

    /** Touches the point in progress, records it, and goes on to the next. */
    private probePoint(session: ProbeSession): void {
        const point = session.order[session.next];
        if (!point) {
            return;
        }
        const { depth, feed, slow, backoff } = session.settings;
        let height = this.probeTouch(session, feed, depth);
        if (height === null) {
            return;
        }
        if (slow > 0) {
            const above = height + backoff;
            if (!this.probeRequest(session, `go H${coord(above, 4)}`, () => this.probeGo(null, above))) {
                return;
            }
            height = this.probeTouch(session, slow, 2 * backoff);
            if (height === null) {
                return;
            }
        }
        if (!this.probeRequest(session, `go H${coord(session.travel, 4)}`, () => this.probeGo(null, session.travel))) {
            return;
        }
        const [ix, iy] = point;
        const row = session.map.heights[iy];
        if (row) {
            row[ix] = round4(height);
        }
        session.progress.done += 1;
        session.next += 1;
        this.emitHeightMap();
        this.probeBegin(session);
    }

    /** One probe down; the height at contact, or null when the probing has failed. */
    private probeTouch(session: ProbeSession, feed: number, distance: number): number | null {
        const replies = this.probeRequest(session, `probe H-${num(distance, 4)} F${num(feed)}`, () => probeReplies(this.machine, -distance, feed));
        if (replies === null) {
            return null;
        }
        const report = /^\[PRB:(-?[\d.]+):([01])\]$/.exec(replies[0] ?? "");
        if (!report) {
            this.probeFail(session, `no probe result in ${replies.join(", ")}`);
            return null;
        }
        if (report[2] !== "1") {
            this.probeFail(session, `the probe found nothing within ${shortNumber(distance)} mm`);
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
}

/** A move as the line that asks the firmware for it. */
export function formatMove(move: Move): string {
    const focus = move.h !== undefined ? `H${coord(move.h, 4)}` : "";
    // A cartesian machine's moves carry the cross slide and hold the table.
    const joints = move.z !== undefined ? `R${coord(move.target.r, 3)} Z${coord(move.z, 3)}` : `R${coord(move.target.r, 3)} A${coord(move.target.a, 4)}`;
    const words = move.headOnly ? focus : move.turn ? `A${coord(move.target.a, 4)}` : [joints, focus].filter((word) => word !== "").join(" ");
    switch (move.kind) {
        case "go":
            return `go ${words}`;
        case "jog":
            return move.feed !== null ? `jogto ${words} F${num(move.feed)}` : `jogto ${words}`;
        case "cut": {
            if (move.milled) {
                return `cut ${words} F${num(move.feed ?? 0)}`;
            }
            const floor = (move.minPower ?? 0) > 0 ? ` M${num(Math.min(move.minPower ?? 0, move.power))}` : "";
            return `cut ${words} F${num(move.feed ?? 0)} S${num(move.power)}${floor}`;
        }
        case "dwell":
            return move.power > 0 ? `dwell T${move.ms ?? 0} S${move.power}` : `dwell T${move.ms ?? 0}`;
        case "spindle":
            return move.off ? "spindle off" : `spindle S${num(move.power)}`;
    }
}

/** The status line the firmware prints for `?`, with no negative zero; L is the output's duty as driven on the pin, a spindle's included. */
export function statusLine(machine: MockMachine): string {
    const free = machine.queueFree();
    const state = machine.state === "Alarm" ? `Alarm:${machine.alarm ?? 1}` : machine.state;
    // The focus axis fields are there only with the axis fitted.
    const focus = machine.hasFocusAxis() ? `|H:${coord(machine.h, 3)}|P:${machine.probeActive() ? 1 : 0}` : "";
    const joint = `J:${coord(machine.joint.r, 3)},${coord(machine.joint.a, 4)}`;
    const duty = Math.round(machine.status().laser);
    return `<${state}|${joint}|V:${coord(machine.rate, 0)}|L:${duty}|Q:${free.planner},${free.lines}|M:${machine.mode}|E:${machine.enabled ? 1 : 0}|Z:${coord(machine.z, 3)}${focus}>`;
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
