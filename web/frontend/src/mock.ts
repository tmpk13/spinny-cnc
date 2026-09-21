// In-page fake backend for `?mock=1`: a machine that moves at the firmware's
// rates, the job store, and the event feed the real WebSocket would carry.

import { ApiError, type Api } from "./api.ts";
import { boardOfJoint, jointOfBoard, jointPath, lerpJoint, moveMinutes, segmentBoardMove, surfaceLength } from "./kinematics.ts";
import { buildJob, computeStats, demoCoupon, placeJob } from "./mockjobs.ts";
import type { LinkStatus } from "./state.ts";
import type {
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

export const DEFAULT_SETTINGS: Record<string, number> = {
    r_steps: 256,
    a_steps: 888.889,
    r_rate: 1000,
    a_rate: 1080,
    r_accel: 50,
    a_accel: 50,
    r_jerk: 3,
    a_jerk: 10,
    r_max: 0,
    jog_r: 600,
    jog_a: 720,
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
    tmc_r_micro: 16,
    tmc_a_micro: 16,
    tmc_stealth: 1,
};

export const SETTINGS_SCHEMA: SettingSchema[] = [
    { name: "r_steps", unit: "steps/mm", help: "radius motor" },
    { name: "a_steps", unit: "steps/deg", help: "table motor: 200 steps * 16 microsteps * 100:1 / 360" },
    { name: "r_rate", unit: "mm/min", help: "max radius rate" },
    { name: "a_rate", unit: "deg/min", help: "max table rate" },
    { name: "r_accel", unit: "mm/s^2", help: "radius acceleration" },
    { name: "a_accel", unit: "deg/s^2", help: "table acceleration" },
    { name: "r_jerk", unit: "mm/s", help: "allowed speed change at a corner" },
    { name: "a_jerk", unit: "deg/s", help: "allowed speed change at a corner" },
    { name: "r_max", unit: "mm", help: "soft limit, 0 = off" },
    { name: "jog_r", unit: "mm/min", help: "jog rate without F" },
    { name: "jog_a", unit: "deg/min", help: "jog rate without F" },
    { name: "dir_invert", unit: "mask", help: "bit 0 radius, bit 1 table" },
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
    /** Seconds left on a constant beam; 0 when off. */
    beamSeconds = 0;

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
            joint: { ...this.joint },
            board: boardOfJoint(this.joint),
            rate: this.rate,
            laser: this.laser,
            mode: this.mode,
            enabled: this.enabled,
            queue: this.queueFree(),
        };
    }

    private checkRadius(r: number): void {
        if (r < -1e-9) {
            throw new MachineError(4, "value out of range");
        }
        const rMax = this.settings["r_max"] ?? 0;
        if (rMax > 0 && r > rMax + 1e-9) {
            throw new MachineError(4, "value out of range");
        }
    }

    /** Queues a move; the firmware refuses motion in Hold and Alarm, and jogs outside Idle/Jog. */
    push(move: Move): void {
        if (this.state === "Alarm" || this.state === "Hold") {
            throw new MachineError(5, "not allowed in this state");
        }
        if (move.kind === "jog" && this.state === "Run") {
            throw new MachineError(5, "not allowed in this state");
        }
        if (move.kind !== "jog" && this.state === "Jog") {
            throw new MachineError(5, "not allowed in this state");
        }
        if (!this.canQueue()) {
            throw new MachineError(5, "queue full");
        }
        this.checkRadius(move.target.r);
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

    private secondsFor(move: Move, from: Joint): number {
        const s = this.settings;
        switch (move.kind) {
            case "go":
                return moveMinutes(from, move.target, null, s["r_rate"] ?? 1000, s["a_rate"] ?? 1080) * 60;
            case "jog":
                if (move.feed === null) {
                    return moveMinutes(from, move.target, null, s["jog_r"] ?? 600, s["jog_a"] ?? 720) * 60;
                }
                return moveMinutes(from, move.target, move.feed, s["r_rate"] ?? 1000, s["a_rate"] ?? 1080) * 60;
            case "cut":
                return moveMinutes(from, move.target, move.feed, s["r_rate"] ?? 1000, s["a_rate"] ?? 1080) * 60;
        }
    }

    /** Duty in permille for a cut at the achieved speed. */
    private dutyFor(move: Move, achieved: number): number {
        if (move.kind !== "cut" || move.power <= 0) {
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
            this.laser = this.dutyFor(active.move, achieved);
            if (active.elapsed >= active.seconds - 1e-9) {
                this.joint = { ...active.move.target };
                this.active = null;
            }
        }
    }

    hold(): void {
        if (this.moving()) {
            this.state = "Hold";
            this.laser = 0;
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

    /** The reset byte: stop at once and flush; an alarm if it was moving. */
    reset(): void {
        const wasMoving = this.moving();
        this.queue = [];
        this.active = null;
        this.laser = 0;
        this.beamSeconds = 0;
        this.rate = 0;
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
            throw new MachineError(5, "not allowed in this state");
        }
    }

    setPosition(request: PositionRequest): void {
        this.requireIdle();
        if (request.r !== undefined) {
            this.checkRadius(request.r);
        }
        this.joint = { r: request.r ?? this.joint.r, a: request.a ?? this.joint.a };
    }

    beam(power: number, ms: number): void {
        this.requireIdle();
        const sMax = this.settings["s_max"] ?? 1000;
        if (power < 0 || power > sMax) {
            throw new MachineError(4, "value out of range");
        }
        const limit = ms > 0 ? ms : this.settings["laser_ms"] ?? 5000;
        this.laser = Math.max(0, Math.min(1000, (power / sMax) * 1000));
        this.beamSeconds = Math.min(60000, limit) / 1000;
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

    async disconnect(): Promise<Snapshot> {
        this.connected = false;
        this.url = null;
        this.outbox = [];
        if (this.session) {
            this.session.state = "stopped";
            this.session = null;
        }
        this.machine.beamOff();
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
        this.exchange(`set ${words.join(" ")}`.trim(), () => this.machine.setPosition(request));
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
                this.line("rx", `[spinny v${MOCK_VERSION} lines:${LINE_SLOTS} blocks:${PLANNER_BLOCKS}]`);
                if (machine.state === "Alarm") {
                    this.line("rx", "ALARM:1 reset while moving");
                }
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
                return ["error:2 bad word or number"];
            }
        }
        const get = (key: string): number | null => (words.has(key) ? words.get(key) ?? null : null);
        try {
            switch (keyword.toLowerCase()) {
                case "go":
                    machine.go(get("R"), get("A"));
                    return ["ok"];
                case "cut": {
                    const feed = get("F") ?? this.lastFeed;
                    const power = get("S") ?? this.lastPower;
                    this.lastFeed = feed;
                    this.lastPower = power;
                    machine.cut(get("R"), get("A"), feed, power);
                    return ["ok"];
                }
                case "jog":
                    machine.jog(get("R") ?? 0, get("A") ?? 0, get("F"));
                    return ["ok"];
                case "jogto":
                    machine.jogTo(get("R"), get("A"), get("F"));
                    return ["ok"];
                case "dwell":
                    return get("T") === null ? ["error:3 missing word"] : ["ok"];
                case "mode": {
                    const mode = (rest[0] ?? "").toLowerCase();
                    if (mode !== "dyn" && mode !== "const") {
                        return ["error:2 bad word or number"];
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
                    if (r !== null) {
                        position.r = r;
                    }
                    if (a !== null) {
                        position.a = a;
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
                    return ["[MSG:go cut jog jogto dwell mode laser set enable disable unlock version status $]", "ok"];
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

    private lastFeed = 100;
    private lastPower = 0;

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
            return ["[MSG:tmc r: ok 800mA 16us stealth]", "[MSG:tmc a: ok 800mA 16us stealth]", "ok"];
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
            rRate: this.machine.settings["r_rate"] ?? 1000,
            aRate: this.machine.settings["a_rate"] ?? 1080,
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
                groups: job.groups.map((group) => ({ label: group.label, power: group.power, speed: group.speed, enabled: group.enabled, paths: group.paths.length })),
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

    async patchJob(id: string, patch: JobPatch): Promise<void> {
        const job = this.requireJob(id);
        for (const change of patch.groups ?? []) {
            const group = job.groups[change.index];
            if (!group) {
                throw new ApiError(400, `no group ${change.index}`);
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
            const dx = patch.offset.x - job.offset.x;
            const dy = patch.offset.y - job.offset.y;
            const move = (paths: Job["outline"]): Job["outline"] => paths.map((path) => path.map(([x, y]) => [x + dx, y + dy]));
            for (const group of job.groups) {
                group.paths = move(group.paths);
            }
            job.outline = move(job.outline);
            job.copper = move(job.copper);
            job.offset = { ...patch.offset };
        }
        job.stats = computeStats(job.groups, this.limits());
    }

    async deleteJob(id: string): Promise<void> {
        this.requireJob(id);
        if (this.session && this.session.job.id === id) {
            throw new ApiError(409, "job is running");
        }
        this.jobStore.delete(id);
        this.order = this.order.filter((other) => other !== id);
    }

    /** The move list a job streams: a rapid to each path, then cuts within the chord tolerance. */
    movesFor(job: Job): Move[] {
        const moves: Move[] = [];
        let joint = this.machine.endpoint();
        job.groups.forEach((group, index) => {
            if (!group.enabled) {
                return;
            }
            for (const path of group.paths) {
                const first = path[0];
                if (!first) {
                    continue;
                }
                const start = jointOfBoard({ x: first[0], y: first[1] }, joint);
                moves.push({ kind: "go", target: start, feed: null, power: 0, group: index });
                joint = start;
                for (const target of jointPath(path.slice(1), start, this.tolerance)) {
                    moves.push({ kind: "cut", target, feed: group.speed, power: group.power, group: index });
                    joint = target;
                }
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
    return `<${state}|J:${machine.joint.r.toFixed(3)},${machine.joint.a.toFixed(4)}|V:${Math.round(machine.rate)}|L:${Math.round(machine.laser)}|Q:${free.planner},${free.lines}|M:${machine.mode}|E:${machine.enabled ? 1 : 0}>`;
}
