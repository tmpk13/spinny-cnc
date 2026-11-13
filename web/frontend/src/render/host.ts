// Where the renderer runs. By default the preview hands its two canvases to
// a worker that runs the renderer, so drawing a frame (or making a large
// job's geometry, or its speed map) never holds up the page: the page only
// posts what changed, and the worker draws at its own animation frames.
// Where the browser cannot hand a canvas over, the worker never answers or
// the page asks for it (`?preview=gl` or `?preview=2d`), the renderer runs in
// the page instead.
//
// The worker is the page's own script loaded a second time: Bun bundles a
// page into one file and leaves a worker of its own unbundled, so this
// module, part of that file, starts serving when it finds itself in a
// worker. Nothing else in the bundle touches the page while it loads.

import { type PackedJob, packJob, unpackJob } from "./pack.ts";
import { Renderer, type PainterChoice, type PainterKind, type Snapshot } from "./renderer.ts";
import type { RenderJob, RenderState } from "./scene.ts";

/** How long the worker gets to load and say it is ready before the page draws by itself, ms. */
export const READY_MS = 5000;

/**
 * What the page sends the worker. The state goes without its job, which
 * comes packed (pack.ts) beside it: a new job (null for none), or nothing
 * when the job is as it was.
 */
export type ToWorker =
    | { kind: "start"; scene: OffscreenCanvas; overlay: OffscreenCanvas; state: RenderState; job: PackedJob | null; painter: PainterChoice }
    | { kind: "state"; patch: Partial<RenderState>; job?: PackedJob | null }
    | { kind: "snapshot"; id: number };

/** A state, or what changed of it, split into the rest and its job packed, with the buffers the job hands over. */
function withoutJob<T extends Partial<RenderState>>(state: T): { rest: T; job: PackedJob | null | undefined; transfer: Transferable[] } {
    if (!("job" in state)) {
        return { rest: state, job: undefined, transfer: [] };
    }
    const { job, ...rest } = state as T & { job: RenderJob | null };
    if (job === null) {
        return { rest: rest as T, job: null, transfer: [] };
    }
    const { packed, transfer } = packJob(job);
    return { rest: rest as T, job: packed, transfer };
}

/** What the worker sends back: ready for the canvases, a frame drawn and with what, a picture read back, or a fault. */
export type FromWorker =
    | { kind: "ready" }
    | { kind: "drawn"; ms: number; painter: PainterKind }
    | { kind: "snapshot"; id: number; snapshot: Snapshot }
    | { kind: "error"; message: string };

/** Where the preview's renderer runs, as the preview sees it. */
export interface Host {
    /** What draws: the WebGL painter or the 2D one; null until a worker has said. */
    readonly painter: PainterKind | null;
    /** Where: in a worker or in the page. */
    readonly place: "worker" | "page";
    send(patch: Partial<RenderState>): void;
    /** Draws a frame now when the renderer is in the page, returning how long it took; a worker draws on its own. */
    draw(): number | undefined;
    snapshot(): Promise<Snapshot>;
    dispose(): void;
}

/** The renderer in the page, drawn when the preview asks. */
export class PageHost implements Host {
    readonly place = "page";
    readonly renderer: Renderer;

    constructor(scene: HTMLCanvasElement, overlay: HTMLCanvasElement, state: RenderState, painter: PainterChoice, invalidate: () => void) {
        const doc = scene.ownerDocument;
        this.renderer = new Renderer(scene, overlay, { painter, layer: () => doc.createElement("canvas"), invalidate }, state);
    }

    get painter(): PainterKind {
        return this.renderer.kind;
    }

    send(patch: Partial<RenderState>): void {
        this.renderer.update(patch);
    }

    draw(): number {
        return this.renderer.frame();
    }

    snapshot(): Promise<Snapshot> {
        return Promise.resolve(this.renderer.snapshot());
    }

    dispose(): void {
        this.renderer.dispose();
    }
}

/**
 * The page's script, which the worker loads: the bundle this module is
 * part of. Null where it is not served over http: Bun's dev server (and a
 * test) names the source file here instead, so there the page draws.
 */
export function scriptUrl(): string | null {
    const url = import.meta.url;
    return /^https?:/.test(url) ? url : null;
}

/** Whether a canvas can be handed to a worker running the page's script: module workers, OffscreenCanvas and a script served over http. */
export function canDrawInWorker(canvas: HTMLCanvasElement): boolean {
    return typeof Worker === "function" && typeof OffscreenCanvas === "function" && typeof canvas.transferControlToOffscreen === "function"
        && scriptUrl() !== null;
}

/** What the worker host tells the preview. */
export interface WorkerEvents {
    drawn(ms: number, painter: PainterKind): void;
    /** The worker failed: before it took the canvases (`started` false), or after, when the canvases went with it. */
    failed(started: boolean): void;
}

/** The renderer in a worker: the canvases go over once it is ready, then only changes. */
export class WorkerHost implements Host {
    readonly place = "worker";
    painter: PainterKind | null = null;
    private readonly worker: Worker;
    private started = false;
    private failed = false;
    private timer: ReturnType<typeof setTimeout> | null;
    /** The whole state until the worker starts, then nothing: changes go straight over. */
    private readonly waiting: RenderState;
    private readonly snapshots = new Map<number, (snapshot: Snapshot) => void>();
    private nextSnapshot = 1;

    /** Throws where no worker can be made: the page draws instead. */
    constructor(scene: HTMLCanvasElement, overlay: HTMLCanvasElement, state: RenderState, painter: PainterChoice, private readonly events: WorkerEvents) {
        this.waiting = { ...state };
        this.worker = new Worker(scriptUrl() ?? "", { type: "module", name: "preview" });
        this.worker.onmessage = (event: MessageEvent) => this.receive(event.data as FromWorker, scene, overlay, painter);
        this.worker.onerror = (event: ErrorEvent) => {
            event.preventDefault();
            console.warn(`preview: the drawing worker failed: ${event.message}`);
            this.fail();
        };
        this.timer = setTimeout(() => this.fail(), READY_MS);
    }

    send(patch: Partial<RenderState>): void {
        if (this.failed) {
            return;
        }
        if (!this.started) {
            Object.assign(this.waiting, patch);
            return;
        }
        const { rest, job, transfer } = withoutJob(patch);
        this.post(job === undefined ? { kind: "state", patch: rest } : { kind: "state", patch: rest, job }, transfer);
    }

    draw(): undefined {
        return undefined;
    }

    snapshot(): Promise<Snapshot> {
        const id = this.nextSnapshot++;
        return new Promise((resolve) => {
            this.snapshots.set(id, resolve);
            this.post({ kind: "snapshot", id });
        });
    }

    dispose(): void {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.failed = true;
        this.worker.terminate();
    }

    private post(message: ToWorker, transfer: Transferable[] = []): void {
        try {
            this.worker.postMessage(message, transfer);
        } catch (error) {
            console.warn(`preview: could not send to the drawing worker: ${String(error)}`);
            this.fail();
        }
    }

    private receive(message: FromWorker, scene: HTMLCanvasElement, overlay: HTMLCanvasElement, painter: PainterChoice): void {
        if (this.failed) {
            return;
        }
        switch (message.kind) {
            case "ready": {
                if (this.timer !== null) {
                    clearTimeout(this.timer);
                    this.timer = null;
                }
                let canvases: [OffscreenCanvas, OffscreenCanvas];
                try {
                    canvases = [scene.transferControlToOffscreen(), overlay.transferControlToOffscreen()];
                } catch (error) {
                    console.warn(`preview: cannot hand the canvases to the drawing worker: ${String(error)}`);
                    this.fail();
                    return;
                }
                this.started = true;
                const { rest, job, transfer } = withoutJob(this.waiting);
                this.post({ kind: "start", scene: canvases[0], overlay: canvases[1], state: { ...rest, job: null }, job: job ?? null, painter }, [...canvases, ...transfer]);
                return;
            }
            case "drawn":
                this.painter = message.painter;
                this.events.drawn(message.ms, message.painter);
                return;
            case "snapshot":
                this.snapshots.get(message.id)?.(message.snapshot);
                this.snapshots.delete(message.id);
                return;
            case "error":
                console.warn(`preview: drawing worker: ${message.message}`);
                return;
        }
    }

    private fail(): void {
        if (this.failed) {
            return;
        }
        this.dispose();
        this.events.failed(this.started);
    }
}

/** The scope a dedicated worker runs in, as much of it as the renderer uses. */
interface WorkerScope {
    postMessage(message: FromWorker, transfer?: Transferable[]): void;
    onmessage: ((event: MessageEvent) => void) | null;
    requestAnimationFrame?: (callback: () => void) => number;
}

/** Whether this code runs in a dedicated worker rather than a page. */
export function inWorker(): boolean {
    return typeof document === "undefined" && typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope === "function";
}

/** The worker's side: takes the canvases and the state, then draws a frame at the next animation frame after each change. */
export function serveRenderer(): void {
    const scope = globalThis as unknown as WorkerScope;
    let renderer: Renderer | null = null;
    let queued = false;
    const later = typeof scope.requestAnimationFrame === "function"
        ? (callback: () => void): void => {
            scope.requestAnimationFrame!(callback);
        }
        : (callback: () => void): void => {
            setTimeout(callback, 16);
        };
    const frame = (): void => {
        queued = false;
        if (renderer === null) {
            return;
        }
        try {
            const ms = renderer.frame();
            scope.postMessage({ kind: "drawn", ms, painter: renderer.kind });
        } catch (error) {
            scope.postMessage({ kind: "error", message: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error) });
        }
    };
    const ask = (): void => {
        if (!queued) {
            queued = true;
            later(frame);
        }
    };
    scope.onmessage = (event: MessageEvent) => {
        const message = event.data as ToWorker;
        try {
            switch (message.kind) {
                case "start":
                    renderer = new Renderer(message.scene, message.overlay, {
                        painter: message.painter,
                        layer: () => new OffscreenCanvas(1, 1),
                        invalidate: ask,
                    }, { ...message.state, job: message.job === null ? null : unpackJob(message.job) });
                    break;
                case "state":
                    renderer?.update(message.job === undefined ? message.patch : { ...message.patch, job: message.job === null ? null : unpackJob(message.job) });
                    break;
                case "snapshot": {
                    if (renderer === null) {
                        return;
                    }
                    const snapshot = renderer.snapshot();
                    scope.postMessage({ kind: "snapshot", id: message.id, snapshot }, [snapshot.pixels.buffer]);
                    return;
                }
            }
        } catch (error) {
            scope.postMessage({ kind: "error", message: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error) });
            return;
        }
        ask();
    };
    scope.postMessage({ kind: "ready" });
}

// Loaded in a worker (the page's own script, see above): serve.
if (inWorker()) {
    serveRenderer();
}
