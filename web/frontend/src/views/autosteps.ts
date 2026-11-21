// Auto: the stages of a run (src/views/stages.ts) done by the page as far
// as it can do them by itself. A press on Auto in the top bar walks the
// stages in their order from the first one not done: it connects the machine found, homes a
// G-code machine, starts the camera, looks for the board and takes the
// place found. It stops at the first thing that takes a person (a board to
// pick, a place the camera and the references disagree on, a job to move
// onto its marks, feeders the check finds wanting) and at the last stage,
// which it never presses: a run is started by hand. Where it stops, the
// page goes to the panel of that stage.
//
// Everything it starts is one of the page's own requests, the one a button
// of the stage's panel sends, and is started once in a run of Auto: what did not
// take is said and left to the operator, not tried again.
//
// `autoMove` says what is next from the state and what this run of Auto
// has tried, so the order and the stops are checked without a machine;
// `autoRunner` does the moves one after another; `mountAutoBar` is its
// button and its line in the top bar.

import { errorText } from "../api.ts";
import { button, el } from "../dom.ts";
import { formatFixed } from "../format.ts";
import { defaultPort } from "../ports.ts";
import { isMilling, profileOf } from "../profile.ts";
import type { AppState } from "../state.ts";
import type { BoardEstimate, Component, Job, PnpReference } from "../types.ts";
import { connectOffered, offeredPorts, portName } from "./connection.ts";
import type { Ctx } from "./context.ts";
import { checkLine, currentCheck } from "./feedercheck.ts";
import { searchWill, type LookCamera } from "./findboard.ts";
import { runActive } from "./heightmap.ts";
import { gcodePlacing, referencesOf, topRoutineText } from "./placing.ts";
import { runStages } from "./stages.ts";
import { goToPanel } from "./steps.ts";

/** What Auto works through: the page's requests, a camera's start, and its waits. */
export interface AutoIo {
    ctx: Ctx;
    /** Starts a camera as Start on its picture does. */
    startCamera(camera: LookCamera): void;
    /** A wait of so many milliseconds. */
    sleep(ms: number): Promise<void>;
}

/** What one run of Auto has begun and what failed of it. */
export interface AutoMemory {
    /** The acts begun, by key: each is begun once. */
    tried: Set<string>;
    /** What an act that failed said, by key. */
    failed: Map<string, string>;
}

/**
 * Auto's next move, each in the stage (a stage's id) it belongs to: a request
 * to send (`act`), a routine under way to wait for (`wait`), something only
 * a person can do (`need`: Auto stops, the stage's panel shown), or nothing
 * left that Auto does (`end`: it stops at the last stage).
 */
export type AutoMove =
    | { kind: "act"; step: string; key: string; say: string; run(io: AutoIo): Promise<void> }
    | { kind: "wait"; step: string; say: string }
    | { kind: "need"; step: string; say: string }
    | { kind: "end"; step: string; say: string };

/** How far the camera's place for a board may lie from where its references put it and still be the same place, mm. */
export const AGREE_MM = 1.0;
/** How long a camera has to start, s. */
const START_SECONDS = 15;

/** A fresh memory, for a run of Auto. */
export function autoMemory(): AutoMemory {
    return { tried: new Set(), failed: new Map() };
}

const act = (step: string, key: string, say: string, run: (io: AutoIo) => Promise<void>): AutoMove => ({ kind: "act", step, key, say, run });
const wait = (step: string, say: string): AutoMove => ({ kind: "wait", step, say });
const need = (step: string, say: string): AutoMove => ({ kind: "need", step, say });
const end = (step: string, say: string): AutoMove => ({ kind: "end", step, say });

/** An act for the first time; begun before with its goal still not met, what stops Auto, with what the act said. */
function once(memory: AutoMemory, move: AutoMove & { kind: "act" }, failed: string): AutoMove {
    if (!memory.tried.has(move.key)) {
        return move;
    }
    const why = memory.failed.get(move.key);
    return need(move.step, `${failed}${why ? `: ${why}` : ""}.`);
}

/** A request whose answer is a part of the state, put in the store; a failure is thrown to the runner. */
async function put<K extends keyof AppState>(io: AutoIo, key: K, promise: Promise<NonNullable<AppState[K]>>): Promise<void> {
    const answer = await promise;
    const patch: Partial<AppState> = {};
    patch[key] = answer;
    io.ctx.store.set(patch);
}

/** Waits until the state shows `done`, looking a few times a second; throws `late` after `seconds`. */
async function until(io: AutoIo, done: (state: AppState) => boolean, seconds: number, late: string): Promise<void> {
    for (let waited = 0; !done(io.ctx.store.get()); waited += 250) {
        if (waited >= seconds * 1000) {
            throw new Error(late);
        }
        await io.sleep(250);
    }
}

/** A point of the job's frame where a look's place puts it on the machine. */
export function placeOf(estimate: BoardEstimate, point: [number, number]): [number, number] {
    const turn = (estimate.rotation * Math.PI) / 180;
    return [
        point[0] * Math.cos(turn) - point[1] * Math.sin(turn) + estimate.shift[0],
        point[0] * Math.sin(turn) + point[1] * Math.cos(turn) + estimate.shift[1],
    ];
}

/**
 * How far the place a look found for the board lies from where its
 * references were taken, mm: the furthest of them, each a part's place (or
 * a corner's own point) in the job; null when none can be compared.
 */
export function referencesOff(estimate: BoardEstimate, references: PnpReference[], parts: Component[]): number | null {
    let worst: number | null = null;
    for (const reference of references) {
        const part = parts.find((entry) => entry.ref === reference.ref);
        const point = reference.point ?? (part ? [part.x, part.y] as [number, number] : null);
        if (point === null) {
            continue;
        }
        const at = placeOf(estimate, point);
        const off = Math.hypot(at[0] - reference.at[0], at[1] - reference.at[1]);
        worst = worst === null ? off : Math.max(worst, off);
    }
    return worst;
}

/** The connection: nothing when connected, else the port found, connected once. */
function connectMove(state: AppState, memory: AutoMemory, connected: boolean): AutoMove | null {
    if (connected) {
        return null;
    }
    const port = defaultPort(offeredPorts(state));
    if (port === null) {
        return need("connect", "No port found: plug the machine in, or type its port on the Machines page.");
    }
    const name = portName(port);
    return once(memory, act("connect", "connect", `Connecting ${name}`, async (io) => {
        if (!(await connectOffered(io.ctx))) {
            throw new Error("it did not answer");
        }
    }) as AutoMove & { kind: "act" }, `${name} did not connect`);
}

/** A camera started as its picture's Start does, and waited for. */
function startCamera(step: string, camera: LookCamera, running: (state: AppState) => boolean): AutoMove & { kind: "act" } {
    const name = camera === "top" ? "top camera" : "head camera";
    return act(step, `${camera}-start`, `Starting the ${name}`, async (io) => {
        io.startCamera(camera);
        await until(io, running, START_SECONDS, `it did not start within ${START_SECONDS} s`);
    }) as AutoMove & { kind: "act" };
}

/**
 * A G-code pick and place machine's board step: a move, or once the step
 * is passed a line saying how. With references kept from before, the
 * camera still looks: a board moved since would otherwise be placed where
 * the old one lay; the references are only ever replaced by a press.
 */
function topBoardMove(state: AppState, memory: AutoMemory, job: Job, parts: Component[]): AutoMove | string {
    const placing = state.placing!;
    const top = placing.top ?? null;
    const references = referencesOf(placing, job.id);
    const kept = `${references.length} ${references.length === 1 ? "reference" : "references"}`;
    if (top?.routine?.state === "running") {
        return wait("board", topRoutineText(top));
    }
    const cannot = !top || top.device === "" ? "no top camera is set up" : job.design?.board !== true ? "the job was not opened from a .kicad_pcb" : null;
    if (top === null || cannot !== null) {
        return references.length > 0
            ? `The board's place is its ${kept} (${cannot}).`
            : need("board", `The board's place is yours to give (${cannot}): put the nozzle or the camera over a part and press Nozzle here or Camera here.`);
    }
    const look = top.board_look ?? null;
    const estimate = look?.found === true && look.job === job.id ? look.estimate ?? null : null;
    if (memory.tried.has("top-place")) {
        // The place was taken in this run: the fiducials make it exact.
        const fiducials = parts.filter((part) => part.fiducial === true).length;
        if (references.length === 0) {
            return need("board", `The place found was not taken${memory.failed.has("top-place") ? `: ${memory.failed.get("top-place")}` : ""}.`);
        }
        if (fiducials < 2) {
            return "The board was found by the camera.";
        }
        if (!(top.mm_per_px > 0)) {
            return "The board was found by the camera; its fiducials wait for the top camera's scale (Measure camera).";
        }
        if (!memory.tried.has("fiducials")) {
            return act("board", "fiducials", "Finding the fiducials", (io) => put(io, "placing", io.ctx.api.pnpFiducials(job.id)));
        }
        const routine = top.routine?.kind === "fiducials" ? top.routine : null;
        const why = memory.failed.get("fiducials") ?? (routine !== null && routine.state !== "done" ? routine.error ?? routine.state : null);
        return why ? `The board was found by the camera; its fiducials were not (${why}).` : "The board was found by the camera, its fiducials centered.";
    }
    if (!memory.tried.has("top-search")) {
        // A place found before this run may be the board placed before this
        // one (the look keeps it until a search or Clear guesses): the
        // camera looks once in every run before a place found is compared
        // with the references or taken.
        if (top.running !== true) {
            return once(memory, startCamera("board", "top", (now) => now.placing?.top?.running === true), "The top camera did not start");
        }
        if (look?.job !== job.id) {
            return once(memory, act("board", "top-board", "Loading the board for the camera", (io) => put(io, "placing", io.ctx.api.topBoard(job.id))) as AutoMove & { kind: "act" },
                "The board did not load for the camera");
        }
        const will = searchWill(state, "top", false) === "bed" ? "Scanning the bed for the board" : "Searching for the board";
        return act("board", "top-search", will, (io) => put(io, "placing", io.ctx.api.topSearch(null)));
    }
    // A search that was refused leaves the place found before it, which is
    // not the board's now.
    if (estimate !== null && !memory.failed.has("top-search")) {
        if (references.length === 0) {
            return act("board", "top-place", "Taking the place found", (io) => put(io, "placing", io.ctx.api.topPlace(job.id)));
        }
        const off = referencesOff(estimate, references, parts);
        if (off !== null && off > AGREE_MM) {
            return need("board", `The camera sees the board ${formatFixed(off, 1)} mm from where its ${kept} put it: Use as board place (By camera) takes the camera's; to keep the references, go on by hand.`);
        }
        return `The camera sees the board where its ${kept} put it.`;
    }
    // Searched in this run, and not found.
    const stopped = top.routine?.kind === "search" && top.routine.state === "stopped";
    const why = memory.failed.get("top-search") ?? (stopped ? "the search was stopped" : look?.problem ?? null);
    const said = `The camera did not find the board${why ? ` (${why})` : ""}`;
    return references.length > 0
        ? `${said}: its ${kept} are kept.`
        : need("board", `${said}: put the picture's center on a corner of it and press Corner here (By camera, More), or take a reference by hand.`);
}

/** The steps of a G-code pick and place machine: connect, home, the board and its parts, its place by the top camera, the feeders as the check finds them; then the placing is the operator's. */
function placingMove(state: AppState, memory: AutoMemory): AutoMove {
    const placing = state.placing;
    const connect = connectMove(state, memory, placing?.connected === true);
    if (connect !== null || placing === null) {
        return connect ?? need("connect", "No machine is connected.");
    }
    if (placing.running === true) {
        return end("run", "Placing: Auto does nothing during a run.");
    }
    if (placing.homed !== true) {
        if (placing.top?.routine?.state === "running") {
            return wait("home", topRoutineText(placing.top));
        }
        return once(memory, act("home", "home", "Homing", async (io) => {
            await io.ctx.api.home();
            await io.ctx.refreshPlacing();
        }) as AutoMove & { kind: "act" }, "The machine did not home");
    }
    const job = state.job;
    const parts = state.components !== null && job !== null && state.components.job === job.id ? state.components.components : [];
    if (job === null || parts.length === 0) {
        return need("parts", "Pick or open a board (.kicad_pcb) in the Parts panel.");
    }
    const board = topBoardMove(state, memory, job, parts);
    if (typeof board !== "string") {
        return board;
    }
    // A part no feeder holds, a feeder whose place is not known or one
    // that runs short is the operator's to settle, at the Feeders step.
    const feeders = currentCheck(state)?.check ?? null;
    if (feeders !== null && !feeders.ready) {
        return need("feeders", `${board} ${checkLine(feeders)}`);
    }
    return end("run", `${board} Ready to place: Plan, check it, then Run.`);
}

/**
 * A laser's or a mill's board step, which a run can do without: a move, or
 * a line saying how the step was passed. The head camera looks when it is
 * set up and measured (Find mark gives its scale and where it sits against
 * the tool); the place it finds becomes marks, and moving the job onto
 * them stays a press with its question, as the whole job moves.
 */
function headBoardMove(state: AppState, memory: AutoMemory, job: Job): AutoMove | string {
    const camera = state.camera;
    const place = `at X ${formatFixed(job.offset.x, 2)} Y ${formatFixed(job.offset.y, 2)} mm`;
    if (camera?.routine?.state === "running") {
        return wait("board", `Looking for the board: ${camera.routine.step} (${camera.routine.done} of ${camera.routine.total})`);
    }
    const marks = state.align !== null && state.align.job === job.id ? state.align.marks.length : 0;
    if (memory.tried.has("align-capture")) {
        return marks > 0
            ? need("board", "The camera found the board and its place is kept as marks: check them, then Apply (By marks) moves the job onto it.")
            : need("board", `The place found was not kept as marks${memory.failed.has("align-capture") ? `: ${memory.failed.get("align-capture")}` : ""}.`);
    }
    if (marks > 0) {
        return `The board has ${marks} ${marks === 1 ? "mark" : "marks"} taken (By marks: Apply moves the job onto them).`;
    }
    const cannot = !camera || camera.device === "" ? "no head camera is set up"
        : job.design?.board !== true ? "the job was not opened from a .kicad_pcb"
            : !(camera.mm_per_px > 0) ? "the head camera is not measured: Find mark" : null;
    if (camera === null || cannot !== null) {
        return `The job stays ${place}, placed by hand (${cannot}).`;
    }
    const look = camera.board_look ?? null;
    const found = look?.found === true && look.job === job.id;
    if (!found && !memory.tried.has("head-search")) {
        if (camera.running !== true) {
            return once(memory, startCamera("board", "head", (now) => now.camera?.running === true), "The head camera did not start");
        }
        if (look?.job !== job.id) {
            return once(memory, act("board", "head-board", "Loading the board for the camera", (io) => put(io, "camera", io.ctx.api.cameraBoard(job.id))) as AutoMove & { kind: "act" },
                "The board did not load for the camera");
        }
        return act("board", "head-search", "Searching for the board", (io) => put(io, "camera", io.ctx.api.cameraSearch(null)));
    }
    if (found) {
        return act("board", "align-capture", "Keeping the place found as marks", (io) => put(io, "align", io.ctx.api.alignCapture(job.id)));
    }
    const stopped = camera.routine?.kind === "search" && camera.routine.state === "stopped";
    const why = memory.failed.get("head-search") ?? (stopped ? "the search was stopped" : look?.problem ?? null);
    return `The camera did not find the board${why ? ` (${why})` : ""}: the job stays ${place}.`;
}

/** The steps of a laser, a mill or a dispenser of this project's firmware: connect, the job, the board by the head camera; the heights and the run are the operator's. */
function jobMove(state: AppState, memory: AutoMemory): AutoMove {
    const connect = connectMove(state, memory, state.snapshot.connected);
    if (connect !== null) {
        return connect;
    }
    if (runActive(state.progress ?? state.snapshot.run)) {
        return end("run", "A run is under way: Auto does nothing during a run.");
    }
    const job = state.job;
    if (job === null) {
        return need("job", "Pick the job to run.");
    }
    const board = headBoardMove(state, memory, job);
    if (typeof board !== "string") {
        return board;
    }
    // Probing touches the board and a focus is set by eye: neither is Auto's.
    const heights = profileOf(state.snapshot).h_axis || isMilling(state.snapshot) ? " Heights are yours to set: a probe touches the board." : "";
    return end("run", `${board}${heights} Ready: check the preview, then Run.`);
}

/** What Auto does next, for the machine connected (before one is, the connection). */
export function autoMove(state: AppState, memory: AutoMemory): AutoMove {
    return gcodePlacing(state) ? placingMove(state, memory) : jobMove(state, memory);
}

/** What Auto says of itself: its newest move's line, and whether it is still going. */
export interface AutoLine {
    kind: AutoMove["kind"];
    step: string;
    text: string;
    running: boolean;
}

export interface AutoRunner {
    /** Whether a run of Auto is going. */
    running(): boolean;
    /** Begins a run of Auto; nothing while one is going. */
    start(): void;
    /** Ends the run going, and a camera's search or fiducial routine it began with it. */
    stop(): void;
    /** The newest line; null before the first run and once cleared. */
    line(): AutoLine | null;
    /** Forgets the line of a run that ended. */
    clear(): void;
}

/** How long Auto leaves the state to settle after an act, and between looks at a routine under way, ms. */
const SETTLE_MS = 150;
const POLL_MS = 400;

/**
 * Runs Auto's moves one after another. `changed` is told whenever the line
 * changes, with the stage each move is in.
 */
export function autoRunner(io: AutoIo, changed: (line: AutoLine | null) => void): AutoRunner {
    let run = 0;
    let going = false;
    let line: AutoLine | null = null;
    let memory = autoMemory();

    function say(next: AutoLine | null): void {
        line = next;
        changed(line);
    }

    async function loop(mine: number): Promise<void> {
        while (mine === run) {
            const move = autoMove(io.ctx.store.get(), memory);
            if (move.kind === "need" || move.kind === "end") {
                going = false;
                say({ kind: move.kind, step: move.step, text: move.say, running: false });
                return;
            }
            say({ kind: move.kind, step: move.step, text: move.say, running: true });
            if (move.kind === "act") {
                memory.tried.add(move.key);
                try {
                    await move.run(io);
                } catch (error) {
                    memory.failed.set(move.key, errorText(error));
                }
                await io.sleep(SETTLE_MS);
            } else {
                await io.sleep(POLL_MS);
            }
        }
    }

    return {
        running: () => going,
        start() {
            if (going) {
                return;
            }
            going = true;
            run += 1;
            memory = autoMemory();
            void loop(run);
        },
        stop() {
            if (!going) {
                return;
            }
            going = false;
            run += 1;
            // A routine Auto began is stopped with it, as Stop search does.
            const state = io.ctx.store.get();
            if (state.placing?.top?.routine?.state === "running" && (memory.tried.has("top-search") || memory.tried.has("fiducials"))) {
                void io.ctx.call(io.ctx.api.topAbort()).then((answer) => answer && io.ctx.store.set({ placing: answer }));
            }
            if (state.camera?.routine?.state === "running" && memory.tried.has("head-search")) {
                void io.ctx.call(io.ctx.api.cameraAbort()).then((answer) => answer && io.ctx.store.set({ camera: answer }));
            }
            say(line ? { ...line, kind: "need", text: `Stopped: ${line.text}.`, running: false } : null);
        },
        line: () => line,
        clear() {
            if (!going && line !== null) {
                say(null);
            }
        },
    };
}

/**
 * Auto's button and its line, in the top bar's `host`: Auto starts a run
 * of it and Stop Auto ends one; the line says what it does, and once it
 * stops, why, with a press on the line going to the panel of that stage.
 * Where it stops the page goes to that panel by itself, once.
 */
export function mountAutoBar(host: HTMLElement, io: AutoIo): AutoRunner {
    // Stopped by its own button, Auto goes nowhere: the operator is where they mean to be.
    let byHand = false;
    const press = button("Auto", () => {
        if (runner.running()) {
            byHand = true;
            runner.stop();
            byHand = false;
        } else {
            runner.start();
        }
    }, "btn btn-small bar-auto",
    "do what the page can by itself: connect the machine found, home a G-code machine, find the board with the camera and take its place; it stops where you are needed and never starts a run");
    const line = el("button", { type: "button", class: "badge auto-chip hidden", role: "status" });
    const panelOf = (stage: string): string | null => runStages(io.ctx.store.get()).find((entry) => entry.id === stage)?.panel ?? null;
    let shown: AutoLine | null = null;
    line.addEventListener("click", () => {
        const panel = shown ? panelOf(shown.step) : null;
        if (panel !== null) {
            goToPanel(panel);
        }
        if (!runner.running()) {
            runner.clear();
        }
    });
    const runner = autoRunner(io, (next) => {
        const stopped = next !== null && !next.running && !byHand && (shown === null || shown.running || shown.text !== next.text);
        shown = next;
        press.textContent = runner.running() ? "Stop Auto" : "Auto";
        press.classList.toggle("urgent", runner.running());
        line.classList.toggle("hidden", next === null);
        line.textContent = next === null ? "" : `Auto: ${next.text}`;
        line.title = next === null ? "" : next.running ? "what Auto is doing" : "where Auto stopped; press for the panel of that stage, and to put this away";
        line.setAttribute("data-auto", next?.kind ?? "");
        // Stopped where a person is needed: the panel that needs them.
        const panel = stopped ? panelOf(next.step) : null;
        if (panel !== null) {
            goToPanel(panel);
        }
    });
    host.append(press, line);
    return runner;
}
