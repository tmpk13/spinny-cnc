// In-page fake backend for `?mock=1`: a machine that moves at the firmware's
// rates, the job store, and the event feed the real WebSocket would carry.

import { ApiError, type Api } from "./api.ts";
import { AXIS_EPSILON, DEG, boardOfJoint, lerpJoint, moveMinutes, segmentBoardMove, surfaceLength, unwrap } from "./kinematics.ts";
import { MAX_VALUE, MAX_VALUE_TEXT, buildJob, centerJob, checkPasses, checkPower, checkSpeed, computeStats, demoCoupon, groupMoves, placeJob } from "./mockjobs.ts";
import type { LinkStatus } from "./state.ts";
import type {
    Board,
    CenterRequest,
    CenterResponse,
    Compensate,
    GotoRequest,
    Grid,
    HeightMap,
    HeightMapState,
    Job,
    JobPatch,
    JobSummary,
    JogRequest,
    Joint,
    Machine,
    MachineState,
    Mode,
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
} from "./types.ts";
import type { EventFeed } from "./ws.ts";

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

export type MoveKind = "go" | "cut" | "jog";

export interface Move {
    kind: MoveKind;
    target: Joint;
    /** Focus axis at the end, mm; left out, the head keeps the height the move before left it at. */
    h?: number;
    /** Surface speed in mm/min for a cut, the jog feed, or null for the default rates. */
    feed: number | null;
    /** S word for a cut. */
    power: number;
    /** M word for a cut: the floor of its dynamic power, not modal. */
    minPower?: number;
    /** Job group index, for progress. */
    group: number;
}

interface Active {
    move: Move;
    from: Joint;
    fromH: number;
    toH: number;
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
    "focus axis probe (h_axis=1): probe H [F]",
    "dwell T [S] | mode dyn|const | laser S [T] | laser off | set [R] [A] [H]",
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
    mode: Mode = "dyn";
    enabled = false;
    /** Laser duty in permille. */
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
            kinematics: (this.settings["cartesian"] ?? 0) !== 0 ? "cartesian" : "polar",
            tool: this.milling() ? "spindle" : "laser",
            h_axis: this.hasFocusAxis(),
            r_max: this.settings["r_max"] ?? 0,
            z_max: this.settings["z_max"] ?? 0,
        };
    }

    milling(): boolean {
        return (this.settings["spindle"] ?? 0) !== 0;
    }

    /** `spindle S` / `spindle off`: refused on a laser machine, as the firmware refuses it. */
    spin(power: number | null): void {
        if (!this.milling()) {
            throw new MachineError(2, "bad word");
        }
        if (power !== null && !(power >= 0)) {
            throw new MachineError(4, "out of range");
        }
        if (power !== null && (this.state === "Alarm" || this.state === "Jog")) {
            throw new MachineError(5, "not now");
        }
        this.spindle = power ?? 0;
    }

    /** The board point under the probe tip with the joints at `joint`. */
    tipBoard(joint: Joint = this.joint): Board {
        const [along, across] = this.probeOffset;
        const rad = joint.a * DEG;
        const reach = joint.r + along;
        return {
            x: reach * Math.cos(rad) - across * Math.sin(rad),
            y: reach * Math.sin(rad) + across * Math.cos(rad),
        };
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
        return this.active ? this.active.move.target : this.joint;
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

    moving(): boolean {
        return this.state === "Run" || this.state === "Jog";
    }

    status(): Machine {
        const focus = this.hasFocusAxis();
        return {
            state: this.state,
            alarm: this.alarm,
            joint: { ...this.joint, z: this.z, h: focus ? this.h : null },
            board: boardOfJoint(this.joint),
            rate: this.rate,
            laser: this.milling() ? Math.max(0, Math.min(1000, (this.spindle / (this.settings["s_max"] ?? 1000)) * 1000)) : this.laser,
            mode: this.mode,
            enabled: this.enabled,
            queue: this.queueFree(),
            probe: focus ? this.probeActive() : null,
        };
    }

    /** Any move may cross the axis to the far side; the soft limit is on the distance from it, either side. */
    private checkRadius(r: number): void {
        if (!Number.isFinite(r)) {
            throw new MachineError(4, "out of range");
        }
        const rMax = this.settings["r_max"] ?? 0;
        if (rMax > 0 && Math.abs(r) > rMax + 1e-9) {
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
        this.checkRadius(move.target.r);
        if (!Number.isFinite(move.target.a)) {
            throw new MachineError(4, "out of range");
        }
    }

    /** Queues a move; the firmware refuses motion in Hold and Alarm, and jogs outside Idle/Jog. */
    push(move: Move): void {
        this.checkFocusWord(move.h);
        if (this.state === "Alarm" || this.state === "Hold") {
            throw new MachineError(5, "not now");
        }
        if (this.slide !== null) {
            // The cross slide moves on its own; nothing joins it.
            throw new MachineError(5, "not now");
        }
        if (move.kind === "jog" && this.state === "Run") {
            throw new MachineError(5, "not now");
        }
        if (move.kind !== "jog" && this.state === "Jog") {
            throw new MachineError(5, "not now");
        }
        if (!this.canQueue()) {
            throw new MachineError(5, "queue full");
        }
        this.checkWords(move);
        this.queue.push(move);
        this.enabled = true;
        this.beamSeconds = 0;
        if (this.state === "Idle") {
            this.state = move.kind === "jog" ? "Jog" : "Run";
        }
    }

    /** A relative jog; a `dh` of null leaves the focus axis out of it. */
    jog(dr: number, da: number, feed: number | null, dh: number | null = null): void {
        const from = this.endpoint();
        const h = dh !== null ? this.endpointH() + dh : undefined;
        this.push({ kind: "jog", target: { r: from.r + dr, a: from.a + da }, h, feed, power: 0, group: -1 });
    }

    jogTo(r: number | null, a: number | null, feed: number | null, h: number | null = null): void {
        const from = this.endpoint();
        this.push({ kind: "jog", target: { r: r ?? from.r, a: a ?? from.a }, h: h ?? undefined, feed, power: 0, group: -1 });
    }

    go(r: number | null, a: number | null, h: number | null = null): void {
        const from = this.endpoint();
        this.push({ kind: "go", target: { r: r ?? from.r, a: a ?? from.a }, h: h ?? undefined, feed: null, power: 0, group: -1 });
    }

    cut(r: number | null, a: number | null, feed: number, power: number, minPower = 0, h: number | null = null): void {
        const from = this.endpoint();
        this.push({ kind: "cut", target: { r: r ?? from.r, a: a ?? from.a }, h: h ?? undefined, feed, power, minPower, group: -1 });
    }

    /** Sends the cross slide to `z`; the firmware takes it in Idle only. */
    slideTo(z: number, feed: number | null): void {
        this.requireIdle();
        if (feed !== null && !(feed >= MIN_FEED)) {
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
     * raises or lowers the head, which takes it as the speed of H.
     */
    private secondsFor(move: Move, from: Joint, fromH: number, toH: number): number {
        const s = this.settings;
        const hRate = s["h_rate"] ?? 600;
        const headOnly = Math.abs(move.target.r - from.r) < 1e-9 && Math.abs(move.target.a - from.a) < 1e-9;
        let minutes: number;
        let focusRate = hRate;
        if (move.kind === "go") {
            minutes = moveMinutes(from, move.target, null, s["r_rate"] ?? 560, s["a_rate"] ?? 400);
        } else if (move.kind === "jog" && move.feed === null) {
            minutes = moveMinutes(from, move.target, null, s["jog_r"] ?? 300, s["jog_a"] ?? 200);
            focusRate = s["jog_h"] ?? 120;
        } else {
            minutes = moveMinutes(from, move.target, move.feed, s["r_rate"] ?? 560, s["a_rate"] ?? 400);
            if (headOnly && move.feed !== null) {
                focusRate = Math.min(move.feed, hRate);
            }
        }
        return Math.max(minutes, Math.abs(toH - fromH) / focusRate) * 60;
    }

    /** Duty in permille for a cut of board length `length` at the achieved speed. */
    private dutyFor(move: Move, achieved: number, length: number): number {
        if (move.kind !== "cut" || move.power <= 0 || length < SURFACE_EPSILON_MM) {
            return 0;
        }
        const sMax = this.settings["s_max"] ?? 1000;
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
                const toH = move.h ?? this.h;
                const seconds = this.secondsFor(move, this.joint, this.h, toH);
                this.active = { move, from: { ...this.joint }, fromH: this.h, toH, seconds, elapsed: 0 };
            }
            const active = this.active;
            if (active.seconds <= 1e-9) {
                this.joint = { ...active.move.target };
                this.h = active.toH;
                this.active = null;
                continue;
            }
            const step = Math.min(remaining, active.seconds - active.elapsed);
            active.elapsed += step;
            remaining -= step;
            const t = Math.min(1, active.elapsed / active.seconds);
            this.joint = lerpJoint(active.from, active.move.target, t);
            this.h = active.fromH + (active.toH - active.fromH) * t;
            const length = surfaceLength(active.from, active.move.target);
            const achieved = (length / active.seconds) * 60;
            this.rate = achieved;
            this.laser = this.dutyFor(active.move, achieved, length);
            if (active.elapsed >= active.seconds - 1e-9) {
                this.joint = { ...active.move.target };
                this.h = active.toH;
                this.active = null;
            }
        }
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
     * does not come back with the resume. The cross slide is a setup move
     * with nothing behind it to resume into, so a hold ends it where it is
     * and the state falls back to Idle.
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
    }

    /**
     * The joint stepper is moving. A hold here is already braked, so a reset
     * from it loses no steps, and the slide counts its own steps.
     */
    private jointsBusy(): boolean {
        return this.moving() && this.slide === null;
    }

    /** The reset byte: stop at once, flush, and forget the modal words; an alarm if the joints were moving. */
    reset(): void {
        const wasMoving = this.jointsBusy();
        this.queue = [];
        this.active = null;
        this.slide = null;
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
    }

    jogCancel(): void {
        if (this.state !== "Jog") {
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
        this.rate = 0;
        this.state = "Idle";
    }

    unlock(): void {
        if (this.state === "Alarm") {
            this.state = "Idle";
            this.alarm = null;
        }
    }

    requireIdle(): void {
        if (this.state !== "Idle") {
            throw new MachineError(5, "not now");
        }
    }

    setPosition(request: PositionRequest): void {
        this.checkFocusWord(request.h);
        this.requireIdle();
        if (request.r !== undefined) {
            this.checkRadius(request.r);
        }
        this.joint = { r: request.r ?? this.joint.r, a: request.a ?? this.joint.a };
        this.z = request.z ?? this.z;
        this.h = request.h ?? this.h;
    }

    /**
     * `probe H<distance> [F]`: moves the focus axis by up to `distance`
     * until the probe input goes active. The mock answers at once rather
     * than over time, so it takes the line only at rest where the firmware
     * would wait for the moves queued before it. A miss is `Alarm:2`.
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
            return { h: end, contact: false };
        }
        // The head brakes a little past the contact: 20 ms of motion at the
        // probe's speed, as much as the distance leaves.
        const speed = feed ?? this.settings["jog_h"] ?? 120;
        const brake = Math.min(Math.abs(end - surface), Math.max(1e-4, (speed / 60) * 0.02));
        this.h = surface + Math.sign(distance) * brake;
        return { h: surface, contact: true };
    }

    /** `laser S T`: S over `s_max` is full duty, not more; T past the maximum is refused. */
    beam(power: number, ms: number): void {
        if (!(power >= 0) || !(ms >= 0) || ms > LASER_MAX_MS) {
            throw new MachineError(4, "out of range");
        }
        this.requireIdle();
        const sMax = this.settings["s_max"] ?? 1000;
        const limit = ms > 0 ? ms : this.settings["laser_ms"] ?? 5000;
        this.laser = Math.max(0, Math.min(1000, (power / sMax) * 1000));
        this.beamSeconds = Math.min(LASER_MAX_MS, limit) / 1000;
    }

    beamOff(): void {
        this.laser = 0;
        this.beamSeconds = 0;
    }

    setSetting(name: string, value: number): void {
        if (!(name in DEFAULT_SETTINGS)) {
            throw new MachineError(6, "unknown setting");
        }
        if (!Number.isFinite(value)) {
            throw new MachineError(7, "bad setting value");
        }
        if (/_(steps|rate|accel|jerk)$/.test(name) && value <= 0) {
            throw new MachineError(7, "bad setting value");
        }
        if (["h_axis", "probe_invert", "cartesian", "spindle"].includes(name) && value !== 0 && value !== 1) {
            throw new MachineError(7, "bad setting value");
        }
        if (name === "z_max" && value < 0) {
            throw new MachineError(7, "bad setting value");
        }
        if (name === "spindle" && value !== this.settings["spindle"]) {
            // The output changes meaning: whatever ran on it stops.
            this.spindle = 0;
            this.beamOff();
        }
        if (name === "probe_ms" && !(Number.isInteger(value) && value >= 0 && value <= 160)) {
            throw new MachineError(7, "bad setting value");
        }
        this.settings[name] = value;
    }
}

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

/** A probing under way: the points in the order they are visited and the joints that reach them. */
interface ProbeSession {
    settings: ProbeSettings;
    order: [number, number][];
    joints: Joint[];
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

/** The board box the enabled groups of a job cut inside, joint-space groups included. */
function jobExtent(job: Job): [number, number, number, number] | null {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const group of job.groups) {
        if (!group.enabled) {
            continue;
        }
        const points: [number, number][] =
            group.joints && group.joints.length > 0
                ? group.joints.flat().map(([r, a]): [number, number] => {
                      const board = boardOfJoint({ r, a });
                      return [board.x, board.y];
                  })
                : group.paths.flat();
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
        this.refuseWhileProbing();
    }

    private refuseWhileProbing(): void {
        if (this.probing) {
            throw new ApiError(409, "the board is being probed");
        }
    }

    /** Runs a machine action and turns its refusal into the backend's error reply. */
    private exchange(tx: string, action: () => void): void {
        this.requireConnected();
        this.line("tx", tx);
        try {
            action();
        } catch (error) {
            if (error instanceof MachineError) {
                this.line("rx", error.message);
                throw new ApiError(409, error.message);
            }
            throw error;
        }
        this.line("rx", "ok");
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
        this.line("rx", `[spinny v${MOCK_VERSION} lines:${LINE_SLOTS} blocks:${PLANNER_BLOCKS}]`);
        this.message("info", `connected to ${url} (mock)`);
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

    private boardTargets(target: { x: number; y: number }): Joint[] {
        return segmentBoardMove(this.pendingEndpoint(), target, this.tolerance);
    }

    async jog(request: JogRequest): Promise<void> {
        this.requireMovable();
        const feed = request.feed ?? null;
        const feedWord = feed !== null ? ` F${feed}` : "";
        if (request.kind === "joint") {
            const dz = request.dz;
            if (dz !== undefined) {
                this.exchange(`jog Z${dz.toFixed(3)}${feedWord}`, () => this.machine.slideJog(dz, feed));
                return;
            }
            const dr = request.dr ?? 0;
            const da = request.da ?? 0;
            const dh = request.dh ?? 0;
            const words = [dr !== 0 ? `R${dr.toFixed(3)}` : "", da !== 0 ? `A${da.toFixed(4)}` : "", dh !== 0 ? `H${dh.toFixed(4)}` : ""].filter((w) => w !== "");
            this.exchange(`jog ${words.join(" ")}${feedWord}`.trim(), () => this.machine.jog(dr, da, feed, dh !== 0 ? dh : null));
            return;
        }
        const from = boardOfJoint(this.pendingEndpoint());
        const target = { x: from.x + (request.dx ?? 0), y: from.y + (request.dy ?? 0) };
        for (const joint of this.boardTargets(target)) {
            this.send(`jogto R${joint.r.toFixed(3)} A${joint.a.toFixed(4)}${feedWord}`, { kind: "jog", target: joint, feed, power: 0, group: -1 });
        }
    }

    /** Where the machine ends up once the outbox has been sent too. */
    private pendingEndpoint(): Joint {
        const last = this.outbox[this.outbox.length - 1];
        return last ? last.move.target : this.machine.endpoint();
    }

    async goto(request: GotoRequest): Promise<void> {
        this.requireMovable();
        const feed = request.feed ?? null;
        const feedWord = feed !== null ? ` F${feed}` : "";
        if (request.kind === "joint") {
            const z = request.z;
            if (z !== undefined) {
                this.exchange(`jogto Z${z.toFixed(3)}${feedWord}`, () => this.machine.slideTo(z, feed));
                return;
            }
            const r = request.r ?? null;
            const a = request.a ?? null;
            const h = request.h ?? null;
            const words = [r !== null ? `R${r.toFixed(3)}` : "", a !== null ? `A${a.toFixed(4)}` : "", h !== null ? `H${h.toFixed(4)}` : ""].filter((w) => w !== "");
            this.exchange(`jogto ${words.join(" ")}${feedWord}`.trim(), () => this.machine.jogTo(r, a, feed, h));
            return;
        }
        const from = boardOfJoint(this.pendingEndpoint());
        const target = { x: request.x ?? from.x, y: request.y ?? from.y };
        for (const joint of this.boardTargets(target)) {
            this.send(`jogto R${joint.r.toFixed(3)} A${joint.a.toFixed(4)}${feedWord}`, { kind: "jog", target: joint, feed, power: 0, group: -1 });
        }
    }

    async jogCancel(): Promise<void> {
        this.requireConnected();
        this.outbox = [];
        this.line("tx", "<0x85>");
        this.machine.jogCancel();
        this.emit({ type: "state", data: this.snapshot() });
    }

    async setPosition(request: PositionRequest): Promise<void> {
        this.requireMovable();
        const words = [
            request.r !== undefined ? `R${request.r}` : "",
            request.a !== undefined ? `A${request.a}` : "",
            request.h !== undefined ? `H${request.h}` : "",
        ].filter((w) => w !== "");
        if (words.length > 0) {
            const { r, a, h } = request;
            this.exchange(`set ${words.join(" ")}`, () => this.machine.setPosition({ r, a, h }));
        }
        if (request.z !== undefined) {
            // Z is declared on a line of its own, as the firmware wants it.
            const z = request.z;
            this.exchange(`set Z${z}`, () => this.machine.setPosition({ z }));
        }
    }

    async motors(enabled: boolean): Promise<void> {
        this.exchange(enabled ? "enable" : "disable", () => {
            this.machine.enabled = enabled;
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
            case "reset":
                // Probing is told first, so nothing more of it goes out after the byte.
                if (this.probing) {
                    this.probeFinish(this.probing, "stopped", "reset by the operator");
                }
                this.line("tx", "<0x18>");
                this.outbox = [];
                machine.reset();
                if (this.session) {
                    this.session.state = machine.state === "Alarm" ? "error" : "stopped";
                }
                this.line("rx", "[MSG:reset]");
                if (machine.state === "Alarm") {
                    this.line("rx", "ALARM:1 reset while moving, position may be off");
                }
                this.line("rx", `[spinny v${MOCK_VERSION} lines:${LINE_SLOTS} blocks:${PLANNER_BLOCKS}]`);
                break;
            case "cancel":
                this.line("tx", "<0x85>");
                this.outbox = [];
                machine.jogCancel();
                break;
            case "status":
                this.line("tx", "?");
                this.line("rx", statusLine(machine));
                break;
        }
        this.emit({ type: "state", data: this.snapshot() });
    }

    async command(line: string): Promise<string[]> {
        this.requireConnected();
        const text = line.trim();
        this.line("tx", text);
        const replies = this.execute(text);
        for (const reply of replies) {
            this.line("rx", reply);
        }
        return replies;
    }

    /** A line of the firmware protocol against the mock machine. */
    private execute(text: string): string[] {
        const machine = this.machine;
        const clean = text.replace(/;.*$/, "").trim();
        if (clean === "") {
            return ["ok"];
        }
        if (clean.startsWith("$")) {
            return this.executeSetting(clean.slice(1));
        }
        const [keyword = "", ...rest] = clean.split(/\s+/);
        const words = new Map<string, number>();
        for (const word of rest) {
            const match = /^([a-z])(-?\d*\.?\d+)$/i.exec(word);
            if (match) {
                words.set((match[1] ?? "").toUpperCase(), Number(match[2]));
            } else if (!/^[a-z]+$/i.test(word)) {
                return ["error:2 bad word"];
            }
        }
        const get = (key: string): number | null => (words.has(key) ? words.get(key) ?? null : null);
        const noAxis = get("R") === null && get("A") === null && get("Z") === null && get("H") === null;
        try {
            switch (keyword.toLowerCase()) {
                case "go":
                    if (noAxis) {
                        return ["error:3 missing word"];
                    }
                    machine.go(get("R"), get("A"), get("H"));
                    return ["ok"];
                case "cut": {
                    // F and S are modal, but a reset forgets them: the first
                    // cut after one must give F again.
                    const feed = get("F") ?? machine.feed;
                    if (noAxis || feed === null) {
                        return ["error:3 missing word"];
                    }
                    const power = get("S") ?? machine.power;
                    const minPower = get("M") ?? 0;
                    if (power < 0 || minPower < 0) {
                        return ["error:4 out of range"];
                    }
                    machine.cut(get("R"), get("A"), feed, power, minPower, get("H"));
                    machine.feed = feed;
                    machine.power = power;
                    return ["ok"];
                }
                case "jog":
                case "jogto": {
                    const z = get("Z");
                    const absolute = keyword.toLowerCase() === "jogto";
                    if (noAxis) {
                        return ["error:3 missing word"];
                    }
                    if (z !== null) {
                        if (get("R") !== null || get("A") !== null || get("H") !== null) {
                            return ["error:2 bad word"];
                        }
                        if (absolute) {
                            machine.slideTo(z, get("F"));
                        } else {
                            machine.slideJog(z, get("F"));
                        }
                    } else if (absolute) {
                        machine.jogTo(get("R"), get("A"), get("F"), get("H"));
                    } else {
                        machine.jog(get("R") ?? 0, get("A") ?? 0, get("F"), get("H"));
                    }
                    return ["ok"];
                }
                case "probe": {
                    // H and F only; a missing or zero distance is refused
                    // before the machine is asked, as the firmware parses it.
                    if ([...words.keys()].some((key) => key !== "H" && key !== "F")) {
                        return ["error:2 bad word"];
                    }
                    const distance = get("H");
                    const feed = get("F");
                    if (distance === null) {
                        return ["error:3 missing word"];
                    }
                    if (distance === 0 || (feed !== null && !(feed >= MIN_FEED))) {
                        return ["error:4 out of range"];
                    }
                    return probeReplies(machine, distance, feed);
                }
                case "dwell":
                    return get("T") === null ? ["error:3 missing word"] : ["ok"];
                case "mode": {
                    const mode = (rest[0] ?? "").toLowerCase();
                    if (mode !== "dyn" && mode !== "const") {
                        return ["error:2 bad word"];
                    }
                    machine.mode = mode;
                    return ["ok"];
                }
                case "laser":
                    if ((rest[0] ?? "").toLowerCase() === "off") {
                        machine.beamOff();
                        return ["ok"];
                    }
                    if (get("S") === null) {
                        return ["error:3 missing word"];
                    }
                    machine.beam(get("S") ?? 0, get("T") ?? 0);
                    return ["ok"];
                case "set": {
                    const position: PositionRequest = {};
                    const r = get("R");
                    const a = get("A");
                    const z = get("Z");
                    const h = get("H");
                    if (z !== null && (r !== null || a !== null || h !== null)) {
                        return ["error:2 bad word"];
                    }
                    if (r !== null) {
                        position.r = r;
                    }
                    if (a !== null) {
                        position.a = a;
                    }
                    if (h !== null) {
                        position.h = h;
                    }
                    if (z !== null) {
                        position.z = z;
                    }
                    machine.setPosition(position);
                    return ["ok"];
                }
                case "enable":
                    machine.enabled = true;
                    return ["ok"];
                case "disable":
                    machine.enabled = false;
                    return ["ok"];
                case "unlock":
                    machine.unlock();
                    return ["ok"];
                case "version":
                    return [`[spinny v${MOCK_VERSION} lines:${LINE_SLOTS} blocks:${PLANNER_BLOCKS}]`, "ok"];
                case "status":
                case "?":
                    return [statusLine(machine), "ok"];
                case "help":
                    return [...HELP_LINES, "ok"];
                default:
                    return ["error:1 unknown command"];
            }
        } catch (error) {
            if (error instanceof MachineError) {
                return [error.message];
            }
            throw error;
        }
    }

    private executeSetting(text: string): string[] {
        const machine = this.machine;
        if (text === "") {
            return [...Object.entries(machine.settings).map(([name, value]) => `${name}=${value}`), "ok"];
        }
        if (text === "save") {
            machine.flash = { ...machine.settings };
            return ["ok"];
        }
        if (text === "load" || text === "defaults") {
            machine.settings = { ...(text === "load" ? machine.flash : DEFAULT_SETTINGS) };
            return ["ok"];
        }
        if (text === "tmc") {
            // What the drivers answer when asked, microsteps read back from them.
            const axes: [string, number, string][] = [["R", 0, "tmc_r_micro"], ["A", 2, "tmc_a_micro"], ["Z", 1, "tmc_z_micro"]];
            const lines = axes.map(([letter, addr, name]) => `[MSG:tmc ${letter} addr${addr} ifcnt=1 micro=${machine.settings[name] ?? 256} status=0x00000000]`);
            return [...lines, "ok"];
        }
        const eq = text.indexOf("=");
        if (eq < 0) {
            const value = machine.settings[text];
            return value === undefined ? ["error:6 unknown setting"] : [`${text}=${value}`, "ok"];
        }
        try {
            machine.requireIdle();
            machine.setSetting(text.slice(0, eq), Number(text.slice(eq + 1)));
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
        this.exchange(`laser S${power} T${ms}`, () => this.machine.beam(power, ms));
    }

    async spindle(power: number): Promise<void> {
        if (this.session) {
            throw new ApiError(409, "a job is running");
        }
        this.exchange(`spindle S${power}`, () => this.machine.spin(power));
    }

    async spindleOff(): Promise<void> {
        if (this.session) {
            throw new ApiError(409, "a job is running: stop it to stop the spindle");
        }
        this.exchange("spindle off", () => this.machine.spin(null));
    }

    async laserOff(): Promise<void> {
        this.exchange("laser off", () => this.machine.beamOff());
    }

    async mode(mode: Mode): Promise<void> {
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
        };
    }

    async updateSettings(patch: SettingsUpdate): Promise<void> {
        if (patch.host && Number.isFinite(patch.host.tolerance) && patch.host.tolerance > 0) {
            this.tolerance = patch.host.tolerance;
        }
        const clearance = patch.host?.clearance;
        const spinup = patch.host?.spinup;
        if (clearance !== undefined && !(Number.isFinite(clearance) && clearance > 0 && clearance <= 100)) {
            throw new ApiError(400, "the clearance must be above 0 and at most 100 mm");
        }
        if (spinup !== undefined && !(Number.isFinite(spinup) && spinup >= 0 && spinup <= 600)) {
            throw new ApiError(400, "the spin-up must be 0 to 600 s");
        }
        this.clearance = clearance ?? this.clearance;
        this.spinup = spinup ?? this.spinup;
        const values = patch.values ?? {};
        if (Object.keys(values).length > 0) {
            this.requireConnected();
            for (const [name, value] of Object.entries(values)) {
                this.exchange(`$${name}=${value}`, () => {
                    this.machine.requireIdle();
                    this.machine.setSetting(name, value);
                });
            }
            for (const job of this.jobStore.values()) {
                job.stats = computeStats(job.groups, this.limits());
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
        let built: CenterResponse;
        try {
            built = centerJob(this.newId(), request, this.limits());
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
                if (change.depth !== undefined && !(Number.isFinite(change.depth) && change.depth > 0 && change.depth <= 50)) {
                    throw new Error("depth must be above 0 and at most 50 mm");
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
     * The move list a job streams: a rapid to each path, then cuts within
     * the chord tolerance; a joint-space group goes out as it is written.
     * With `focusAt`, every move also carries the focus height at its end.
     */
    movesFor(job: Job, focusAt: ((board: Board) => number) | null = null): Move[] {
        const moves: Move[] = [];
        let joint = this.machine.endpoint();
        job.groups.forEach((group, index) => {
            if (!group.enabled) {
                return;
            }
            for (const step of groupMoves(group, joint, this.tolerance)) {
                const move: Move =
                    step.kind === "go"
                        ? { kind: "go", target: step.target, feed: null, power: 0, group: index }
                        : { kind: "cut", target: step.target, feed: group.speed, power: group.power, minPower: group.min_power, group: index };
                if (focusAt) {
                    move.h = round4(focusAt(boardOfJoint(step.target)));
                }
                moves.push(move);
                joint = step.target;
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
        if (resolved === "focus" && !hasAxis) {
            throw new ApiError(400, "the focus axis is not fitted ($h_axis=0): compensate by power instead");
        }
        return { mode: resolved, map };
    }

    async runJob(id: string, compensate: Compensate = "off"): Promise<void> {
        this.requireConnected();
        const job = this.requireJob(id);
        this.refuseWhileProbing();
        const followed = this.compensation(compensate, job);
        if (this.session) {
            throw new ApiError(409, "a job is already running");
        }
        if (this.machine.state !== "Idle" || this.outbox.length > 0) {
            throw new ApiError(409, "machine is not idle");
        }
        const map = followed?.map;
        const focusAt = map && followed.mode === "focus" ? (board: Board) => heightAt(map, board.x, board.y) + map.focus_offset : null;
        const moves = this.movesFor(job, focusAt);
        if (moves.length === 0) {
            throw new ApiError(400, "job has no enabled paths");
        }
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
        if (this.session) {
            throw new ApiError(409, "a job is running");
        }
        this.refuseWhileProbing();
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
        const settings = structuredClone(this.probeConfig);
        // Every point is checked for reach before the first move.
        const xs = gridXs(grid);
        const ys = gridYs(grid);
        const order = gridOrder(grid);
        const joints: Joint[] = [];
        let angle = machine.joint.a;
        for (const [ix, iy] of order) {
            let joint: Joint;
            try {
                joint = probeJoint([xs[ix] ?? 0, ys[iy] ?? 0], settings.offset, angle, gridSpacing(grid) / 2);
            } catch (error) {
                throw new ApiError(409, errorText(error));
            }
            joints.push(joint);
            angle = joint.a;
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
        // not moved: the offset is contact to focus for that probe.
        const previous = this.heightmap;
        if (previous && previous.probe_offset[0] === settings.offset[0] && previous.probe_offset[1] === settings.offset[1]) {
            map.focus_offset = previous.focus_offset;
            map.focus_set = previous.focus_set;
        }
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

    /** Sets the focus offset: given, or the head's height less the map's height under the beam. */
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
            const board = boardOfJoint(machine.joint);
            try {
                value = here - heightAt(map, board.x, board.y);
            } catch (error) {
                throw new ApiError(400, errorText(error));
            }
        }
        if (!Number.isFinite(value)) {
            throw new ApiError(422, "offset must be a finite number");
        }
        if (Math.abs(value) > MAX_VALUE) {
            throw new ApiError(400, `focus_offset must be within ${MAX_VALUE_TEXT} mm`);
        }
        map.focus_offset = round4(value);
        map.focus_set = true;
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

    async putHeightMap(map: HeightMap): Promise<HeightMapState> {
        this.refuseWhileProbing();
        const read = readHeightMap(map);
        try {
            checkHeightMap(read);
        } catch (error) {
            throw new ApiError(400, errorText(error));
        }
        this.heightmap = read;
        this.emitHeightMap();
        return this.heightMapState();
    }

    async clearHeightMap(): Promise<HeightMapState> {
        this.refuseWhileProbing();
        this.heightmap = null;
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
        this.probeRequest(session, `go R${coord(joint.r, 3)} A${coord(joint.a, 4)}`, () => this.probeGo(joint, null));
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
     * fixed time per point instead of the travel.
     */
    private probeGo(joint: Joint | null, h: number | null): string[] {
        const machine = this.machine;
        if (h !== null && !machine.hasFocusAxis()) {
            throw new MachineError(2, "bad word");
        }
        machine.requireIdle();
        if (joint) {
            machine.joint = { ...joint };
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

export function formatMove(move: Move): string {
    const focus = move.h !== undefined ? ` H${coord(move.h, 4)}` : "";
    const words = `R${move.target.r.toFixed(3)} A${move.target.a.toFixed(4)}${focus}`;
    switch (move.kind) {
        case "go":
            return `go ${words}`;
        case "jog":
            return move.feed !== null ? `jogto ${words} F${move.feed}` : `jogto ${words}`;
        case "cut":
            const floor = (move.minPower ?? 0) > 0 ? ` M${Math.min(move.minPower ?? 0, move.power)}` : "";
            return `cut ${words} F${move.feed ?? 0} S${move.power}${floor}`;
    }
}

export function statusLine(machine: MockMachine): string {
    const free = machine.queueFree();
    const state = machine.state === "Alarm" ? `Alarm:${machine.alarm ?? 1}` : machine.state;
    // The focus axis fields are there only with the axis fitted.
    const focus = machine.hasFocusAxis() ? `|H:${machine.h.toFixed(3)}|P:${machine.probeActive() ? 1 : 0}` : "";
    return `<${state}|J:${machine.joint.r.toFixed(3)},${machine.joint.a.toFixed(4)}|V:${Math.round(machine.rate)}|L:${Math.round(machine.laser)}|Q:${free.planner},${free.lines}|M:${machine.mode}|E:${machine.enabled ? 1 : 0}|Z:${machine.z.toFixed(3)}${focus}>`;
}
