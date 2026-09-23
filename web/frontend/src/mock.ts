// In-page fake backend for `?mock=1`: a machine that moves at the firmware's
// rates, the job store, and the event feed the real WebSocket would carry.

import { ApiError, type Api } from "./api.ts";
import { boardOfJoint, lerpJoint, moveMinutes, segmentBoardMove, surfaceLength } from "./kinematics.ts";
import { MAX_VALUE, MAX_VALUE_TEXT, buildJob, centerJob, checkPower, checkSpeed, computeStats, demoCoupon, groupMoves, placeJob } from "./mockjobs.ts";
import type { LinkStatus } from "./state.ts";
import type {
    CenterRequest,
    CenterResponse,
    GotoRequest,
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
};

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
    { name: "dir_invert", unit: "mask", help: "bit 0 radius, bit 1 table, bit 2 cross slide" },
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
];

export type MoveKind = "go" | "cut" | "jog";

export interface Move {
    kind: MoveKind;
    target: Joint;
    /** Surface speed in mm/min for a cut, the jog feed, or null for the default rates. */
    feed: number | null;
    /** S word for a cut. */
    power: number;
    /** Job group index, for progress. */
    group: number;
}

interface Active {
    move: Move;
    from: Joint;
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
    "go [R] [A] | cut [R] [A] [F] [S] | jog [R] [A] [F] | jogto [R] [A] [F]",
    "cross slide, alone and from idle: jog Z [F] | jogto Z [F] | set Z",
    "dwell T [S] | mode dyn|const | laser S [T] | laser off | set [R] [A]",
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

/** Joint-space motion at constant rates, the firmware's state machine without acceleration. */
export class MockMachine {
    settings: Record<string, number> = { ...DEFAULT_SETTINGS };
    joint: Joint = { r: 0, a: 0 };
    /** Cross slide position in mm. */
    z = 0;
    state: MachineState = "Idle";
    alarm: number | null = null;
    mode: Mode = "dyn";
    enabled = false;
    /** Laser duty in permille. */
    laser = 0;
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

    moving(): boolean {
        return this.state === "Run" || this.state === "Jog";
    }

    status(): Machine {
        return {
            state: this.state,
            alarm: this.alarm,
            joint: { ...this.joint, z: this.z },
            board: boardOfJoint(this.joint),
            rate: this.rate,
            laser: this.laser,
            mode: this.mode,
            enabled: this.enabled,
            queue: this.queueFree(),
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

    jog(dr: number, da: number, feed: number | null): void {
        const from = this.endpoint();
        this.push({ kind: "jog", target: { r: from.r + dr, a: from.a + da }, feed, power: 0, group: -1 });
    }

    jogTo(r: number | null, a: number | null, feed: number | null): void {
        const from = this.endpoint();
        this.push({ kind: "jog", target: { r: r ?? from.r, a: a ?? from.a }, feed, power: 0, group: -1 });
    }

    go(r: number | null, a: number | null): void {
        const from = this.endpoint();
        this.push({ kind: "go", target: { r: r ?? from.r, a: a ?? from.a }, feed: null, power: 0, group: -1 });
    }

    cut(r: number | null, a: number | null, feed: number, power: number): void {
        const from = this.endpoint();
        this.push({ kind: "cut", target: { r: r ?? from.r, a: a ?? from.a }, feed, power, group: -1 });
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

    private secondsFor(move: Move, from: Joint): number {
        const s = this.settings;
        switch (move.kind) {
            case "go":
                return moveMinutes(from, move.target, null, s["r_rate"] ?? 560, s["a_rate"] ?? 400) * 60;
            case "jog":
                if (move.feed === null) {
                    return moveMinutes(from, move.target, null, s["jog_r"] ?? 300, s["jog_a"] ?? 200) * 60;
                }
                return moveMinutes(from, move.target, move.feed, s["r_rate"] ?? 560, s["a_rate"] ?? 400) * 60;
            case "cut":
                return moveMinutes(from, move.target, move.feed, s["r_rate"] ?? 560, s["a_rate"] ?? 400) * 60;
        }
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
            power = wanted > 0 ? (move.power * achieved) / wanted : 0;
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
                this.active = { move, from: { ...this.joint }, seconds: this.secondsFor(move, this.joint), elapsed: 0 };
            }
            const active = this.active;
            if (active.seconds <= 1e-9) {
                this.joint = { ...active.move.target };
                this.active = null;
                continue;
            }
            const step = Math.min(remaining, active.seconds - active.elapsed);
            active.elapsed += step;
            remaining -= step;
            const t = Math.min(1, active.elapsed / active.seconds);
            this.joint = lerpJoint(active.from, active.move.target, t);
            const length = surfaceLength(active.from, active.move.target);
            const achieved = (length / active.seconds) * 60;
            this.rate = achieved;
            this.laser = this.dutyFor(active.move, achieved, length);
            if (active.elapsed >= active.seconds - 1e-9) {
                this.joint = { ...active.move.target };
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
        this.requireIdle();
        if (request.r !== undefined) {
            this.checkRadius(request.r);
        }
        this.joint = { r: request.r ?? this.joint.r, a: request.a ?? this.joint.a };
        this.z = request.z ?? this.z;
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
        if (/_(steps|rate|accel)$/.test(name) && value <= 0) {
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
    readonly machine = new MockMachine();
    connected = false;
    url: string | null = null;
    tolerance = 0.005;
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

    constructor(options: MockOptions = {}) {
        this.useTimers = options.timers ?? true;
        this.tickMs = options.tickMs ?? 50;
        this.now = options.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
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
            const words = [dr !== 0 ? `R${dr.toFixed(3)}` : "", da !== 0 ? `A${da.toFixed(4)}` : ""].filter((w) => w !== "");
            this.exchange(`jog ${words.join(" ")}${feedWord}`.trim(), () => this.machine.jog(dr, da, feed));
            return;
        }
        this.requireConnected();
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
            const words = [r !== null ? `R${r.toFixed(3)}` : "", a !== null ? `A${a.toFixed(4)}` : ""].filter((w) => w !== "");
            this.exchange(`jogto ${words.join(" ")}${feedWord}`.trim(), () => this.machine.jogTo(r, a, feed));
            return;
        }
        this.requireConnected();
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
        const words = [
            request.r !== undefined ? `R${request.r}` : "",
            request.a !== undefined ? `A${request.a}` : "",
        ].filter((w) => w !== "");
        if (words.length > 0) {
            const { r, a } = request;
            this.exchange(`set ${words.join(" ")}`, () => this.machine.setPosition({ r, a }));
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
        const noAxis = get("R") === null && get("A") === null && get("Z") === null;
        try {
            switch (keyword.toLowerCase()) {
                case "go":
                    if (noAxis) {
                        return ["error:3 missing word"];
                    }
                    machine.go(get("R"), get("A"));
                    return ["ok"];
                case "cut": {
                    // F and S are modal, but a reset forgets them: the first
                    // cut after one must give F again.
                    const feed = get("F") ?? machine.feed;
                    if (noAxis || feed === null) {
                        return ["error:3 missing word"];
                    }
                    const power = get("S") ?? machine.power;
                    machine.cut(get("R"), get("A"), feed, power);
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
                        if (get("R") !== null || get("A") !== null) {
                            return ["error:2 bad word"];
                        }
                        if (absolute) {
                            machine.slideTo(z, get("F"));
                        } else {
                            machine.slideJog(z, get("F"));
                        }
                    } else if (absolute) {
                        machine.jogTo(get("R"), get("A"), get("F"));
                    } else {
                        machine.jog(get("R") ?? 0, get("A") ?? 0, get("F"));
                    }
                    return ["ok"];
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
                    if (z !== null && (r !== null || a !== null)) {
                        return ["error:2 bad word"];
                    }
                    if (r !== null) {
                        position.r = r;
                    }
                    if (a !== null) {
                        position.a = a;
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
            return ["ok"];
        }
        if (text === "load" || text === "defaults") {
            machine.settings = { ...DEFAULT_SETTINGS };
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
        this.exchange(`laser S${power} T${ms}`, () => this.machine.beam(power, ms));
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
            host: { tolerance: this.tolerance },
        };
    }

    async updateSettings(patch: SettingsUpdate): Promise<void> {
        if (patch.host && Number.isFinite(patch.host.tolerance) && patch.host.tolerance > 0) {
            this.tolerance = patch.host.tolerance;
        }
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
        this.exchange("$save", () => this.machine.requireIdle());
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
        const groups = placed.groups.map((group) => ({ label: group.label, power: 500, speed: 400, enabled: true, paths: group.paths }));
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
                    speed: group.speed,
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
                if (change.speed !== undefined) {
                    checkSpeed(change.speed);
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
            if (change.speed !== undefined) {
                group.speed = change.speed;
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
     */
    movesFor(job: Job): Move[] {
        const moves: Move[] = [];
        let joint = this.machine.endpoint();
        job.groups.forEach((group, index) => {
            if (!group.enabled) {
                return;
            }
            for (const step of groupMoves(group, joint, this.tolerance)) {
                if (step.kind === "go") {
                    moves.push({ kind: "go", target: step.target, feed: null, power: 0, group: index });
                } else {
                    moves.push({ kind: "cut", target: step.target, feed: group.speed, power: group.power, group: index });
                }
                joint = step.target;
            }
        });
        return moves;
    }

    async runJob(id: string): Promise<void> {
        this.requireConnected();
        const job = this.requireJob(id);
        if (this.session) {
            throw new ApiError(409, "a job is already running");
        }
        if (this.machine.state !== "Idle" || this.outbox.length > 0) {
            throw new ApiError(409, "machine is not idle");
        }
        const moves = this.movesFor(job);
        if (moves.length === 0) {
            throw new ApiError(400, "job has no enabled paths");
        }
        this.session = { job, moves, next: 0, okSent: 0, state: "running", seconds: 0, group: 0 };
        this.lastProgress = null;
        this.message("info", `running ${job.name}: ${moves.length} moves`);
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
        this.line("tx", "!");
        this.machine.hold();
        this.line("tx", "<0x18>");
        this.outbox = [];
        this.machine.reset();
        session.state = "stopped";
        this.serviceRun(0);
        this.emit({ type: "state", data: this.snapshot() });
    }

    async run(): Promise<Progress | null> {
        return this.progress();
    }
}

export function formatMove(move: Move): string {
    const words = `R${move.target.r.toFixed(3)} A${move.target.a.toFixed(4)}`;
    switch (move.kind) {
        case "go":
            return `go ${words}`;
        case "jog":
            return move.feed !== null ? `jogto ${words} F${move.feed}` : `jogto ${words}`;
        case "cut":
            return `cut ${words} F${move.feed ?? 0} S${move.power}`;
    }
}

export function statusLine(machine: MockMachine): string {
    const free = machine.queueFree();
    const state = machine.state === "Alarm" ? `Alarm:${machine.alarm ?? 1}` : machine.state;
    return `<${state}|J:${machine.joint.r.toFixed(3)},${machine.joint.a.toFixed(4)}|V:${Math.round(machine.rate)}|L:${Math.round(machine.laser)}|Q:${free.planner},${free.lines}|M:${machine.mode}|E:${machine.enabled ? 1 : 0}|Z:${machine.z.toFixed(3)}>`;
}
