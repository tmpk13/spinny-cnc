// 3D preview of the machine's working area, in board mm around the
// rotation axis: the rings (or a square grid) and the rail, the soft
// limits, the markers, copper, outline, the job's paths, the probe grid
// with its heights stretched to be seen, and the head over the board with
// its beam and a short trail. An orbit camera: drag orbits (or pans when
// the rotation is locked), shift or a second button pans, the wheel zooms
// about the cursor, double click returns to the overview.
//
// This is the preview's front: the canvas, its pointer and wheel, the
// camera, picking and the choices kept between visits. What is drawn is
// the renderer's (render/): the scene by the graphics card (WebGL2, or the
// 2D context where that cannot be had), the head and the text on a canvas
// laid over it, in a worker so a frame never holds the page up (see
// render/host.ts). The preview sends it only what changed, at most once an
// animation frame. `?preview=gl` draws with WebGL in the page, `?preview=2d`
// with the 2D context in the page.
//
// A click (a press let go where it was) picks the path under the pointer,
// shift or ctrl adds it or takes it back; with box selection on, a drag
// picks every path wholly inside the box. Picked paths are drawn with a
// halo under them, and the place the JSON panel's caret is in on top.

import {
    type Camera,
    type Vec3,
    Projector,
    frameOf,
    lookDown,
    orbit,
    overview,
    pan,
    quarterTurn,
    sameCamera,
    zoomAt,
} from "./camera.ts";
import { cssVar, readStored, writeStored } from "./dom.ts";
import type { JobPlace } from "./jsontext.ts";
import { registerPicture } from "./pageshot.ts";
import { boardOfJoint } from "./kinematics.ts";
import type { PathRef } from "./regroup.ts";
import { type Host, PageHost, WorkerHost, canDrawInWorker } from "./render/host.ts";
import type { PainterChoice, PainterKind, Renderer, Snapshot } from "./render/renderer.ts";
import {
    type Colors,
    DEFAULT_COLORS,
    type Dimension,
    FONT_PX,
    type Limits,
    type RenderJob,
    type RenderState,
    type SelectBox,
    cutOrderOf,
    initialRenderState,
    jobReach,
    limitReach,
    renderJobOf,
    sameColors,
    sameGrid,
} from "./render/scene.ts";
import type { SpeedLimits } from "./speed.ts";
import type { Board, Grid, HeightMap, Job, Joint, Marker, Point } from "./types.ts";

export type { Dimension, Limits };

const TRAIL_LENGTH = 240;
/** Where the rotation lock is remembered between visits. */
export const LOCK_KEY = "spinny.preview.lock";
/** Where the choice to draw the height map is remembered between visits. */
export const HEIGHTS_KEY = "spinny.previewHeights";
/** Where the choice of a square grid over the rings is remembered between visits. */
export const GRID_KEY = "spinny.preview.grid";
/** A path this near the pointer, CSS px, is the one a click picks. */
export const PICK_PX = 8;
/** A press let go within this many px of where it went down is a click. */
const CLICK_PX = 4;
/** How long the palette read from the stylesheet is trusted before it is read again, ms. */
const PALETTE_MS = 1000;
/**
 * A job of more points than this is drawn coarser by the 2D painter while
 * a drag or the wheel moves the view: its lines a device pixel wide where
 * they would be drawn wider than the spot (a hairline costs the rasterizer
 * a fraction of a wider stroke) and less detail kept, then again in full
 * once the view has stood still for `SETTLE_MS`. The WebGL painter draws
 * every frame in full.
 */
export const COARSE_POINTS = 50_000;
export const SETTLE_MS = 150;

/** Where the preview draws (in a worker where the browser can hand it the canvases, or in the page) and with which painter. */
export interface PreviewOptions {
    place?: "worker" | "page";
    painter?: PainterChoice;
}

/** What the page's address asks for: `?preview=gl` draws with WebGL2 in the page, `?preview=2d` with the 2D context there; nothing, the defaults. */
export function previewOptions(search: string = globalThis.location?.search ?? ""): PreviewOptions {
    const asked = new URLSearchParams(search).get("preview");
    return asked === "gl" || asked === "2d" ? { place: "page", painter: asked } : {};
}

export type DragMode = "orbit" | "pan";

/** What a one-pointer drag does: it pans under the rotation lock, with shift, or with any button but the first; else it orbits. */
export function dragMode(locked: boolean, pointer: { button?: number; shiftKey?: boolean }): DragMode {
    if (locked || pointer.shiftKey || (pointer.button !== undefined && pointer.button !== 0)) {
        return "pan";
    }
    return "orbit";
}

/** A choice remembered under `key`, "1" on and "0" off; null when none was made in this browser. */
function readChoice(key: string): boolean | null {
    const stored = readStored(key);
    return stored === null ? null : stored === "1";
}

function writeChoice(key: string, on: boolean): void {
    writeStored(key, on ? "1" : "0");
}

/** The palette the stylesheet sets for the preview, each color falling back to the default. */
function readColors(node: Element): Colors {
    const d = DEFAULT_COLORS;
    return {
        bg: cssVar(node, "--pv-bg", d.bg),
        grid: cssVar(node, "--pv-grid", d.grid),
        axis: cssVar(node, "--pv-axis", d.axis),
        rail: cssVar(node, "--pv-rail", d.rail),
        rmax: cssVar(node, "--pv-rmax", d.rmax),
        copper: cssVar(node, "--pv-copper", d.copper),
        outline: cssVar(node, "--pv-outline", d.outline),
        head: cssVar(node, "--pv-head", d.head),
        trail: cssVar(node, "--pv-trail", d.trail),
        text: cssVar(node, "--pv-text", d.text),
        groups: d.groups.map((color, index) => cssVar(node, `--pv-g${index}`, color)),
        probe: cssVar(node, "--pv-probe", d.probe),
        marker: cssVar(node, "--pv-marker", d.marker),
        low: cssVar(node, "--hm-low", d.low),
        high: cssVar(node, "--hm-high", d.high),
        select: cssVar(node, "--pv-select", d.select),
        highlight: cssVar(node, "--pv-highlight", d.highlight),
        dim: cssVar(node, "--pv-dim", d.dim),
    };
}

/** The overlay's text: three quarters of the page's rem, in px, since a worker has no page to take a rem from. */
function readFont(node: Element): string {
    const rem = parseFloat(getComputedStyle(node.ownerDocument.documentElement).fontSize);
    const px = Number.isFinite(rem) && rem > 0 ? rem * 0.75 : FONT_PX;
    return `${Math.round(px * 100) / 100}px system-ui, sans-serif`;
}

interface Pointer {
    x: number;
    y: number;
    button: number;
    shiftKey: boolean;
    /** Where it went down, and whether it has moved past a click since. */
    downX: number;
    downY: number;
    moved: boolean;
    /** It went down with a key that adds to the picked paths. */
    additive: boolean;
}

/** A canvas point's distance to the segment from (ax, ay) to (bx, by), px. */
function segmentDistance(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax;
    const dy = by - ay;
    const length = dx * dx + dy * dy;
    const t = length > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length)) : 0;
    return Math.hypot(x - (ax + dx * t), y - (ay + dy * t));
}

export class Preview {
    private canvas: HTMLCanvasElement;
    /** The canvas laid over the scene for the head and the text; pointers go through it to the scene canvas. */
    private overlay: HTMLCanvasElement;
    /** What the renderer draws from, as sent to it and about to be. */
    private readonly state: RenderState;
    /** What changed since the renderer was last sent the state. */
    private patch: Partial<RenderState> = {};
    private host: Host;
    /** The job shown, whole, for picking its paths. */
    private job: Job | null = null;
    /** The view was fitted against a canvas that had a size. */
    private fitted = false;
    /** The canvas has no size: hidden with its page, or not laid out yet. */
    private hidden = false;
    private trail: Point[] = [];
    /** The grid picked in this browser; null follows the machine, a grid on a cartesian one. */
    private gridChoice = readChoice(GRID_KEY);
    /** Called with the path a click picked (null for none) and whether it adds to the picked ones. */
    onPick: ((ref: PathRef | null, additive: boolean) => void) | null = null;
    /** Called with the paths a selection box holds and whether they add to the picked ones. */
    onBox: ((refs: PathRef[], additive: boolean) => void) | null = null;
    private pending = false;
    private observer: ResizeObserver | null = null;
    private pointers = new Map<number, Pointer>();
    private disposers: (() => void)[] = [];
    private paletteAt = Number.NEGATIVE_INFINITY;
    private pointsMemo: { job: RenderJob | null; points: number } | null = null;
    private reachMemo: { job: RenderJob | null; limit: number; reach: number } | null = null;
    /** A drag or the wheel is moving the view of a large job drawn in 2D: it is drawn coarser until the timer finds it still. */
    private moving = false;
    private settleTimer: ReturnType<typeof setTimeout> | null = null;
    /** How long the last draw took, ms: a view is still only once it has gone unmoved for longer than a frame or two takes. */
    private drawMs = 0;
    /** Frames drawn so far. */
    private frames = 0;
    /** The painter asked for, kept for drawing in the page should the worker fail. */
    private painterChoice: PainterChoice = "auto";

    /** Draws in a worker with the painter the browser runs best by default; the page's address can ask otherwise (`previewOptions`), and `options` before it. */
    constructor(canvas: HTMLCanvasElement, options: PreviewOptions = {}) {
        this.canvas = canvas;
        this.overlay = this.makeOverlay();
        this.state = initialRenderState(overview(10, 1, 1));
        this.state.heights = readChoice(HEIGHTS_KEY) ?? true;
        this.state.locked = readChoice(LOCK_KEY) ?? false;
        this.state.grid = this.showGrid;
        const chosen = { ...previewOptions(), ...options };
        this.painterChoice = chosen.painter ?? "auto";
        this.host = this.makeHost(chosen);
        this.showDrawing();
        this.bind();
        this.resize();
        // A screenshot cannot read a canvas a worker draws: it asks here.
        registerPicture({ canvases: () => [this.canvas, this.overlay], read: () => this.snapshot() });
    }

    /** What draws the preview, the painter (null until a worker has drawn) and where; how many frames it drew and how long the last took, ms. */
    get drawing(): { place: "worker" | "page"; painter: PainterKind | null; frames: number; lastMs: number } {
        return { place: this.host.place, painter: this.host.painter, frames: this.frames, lastMs: this.drawMs };
    }

    /** The renderer when it runs in the page; null while a worker draws. */
    get renderer(): Renderer | null {
        return this.host instanceof PageHost ? this.host.renderer : null;
    }

    /** The picture as last drawn, read back from the canvases, for checks. */
    snapshot(): Promise<Snapshot> {
        this.flush();
        return this.host.snapshot();
    }

    /** Shows a job; the view refits unless `keepView` is set, as for an edit of the same job. */
    setJob(job: Job | null, keepView = false): void {
        this.job = job;
        this.put("job", renderJobOf(job));
        if (keepView) {
            this.requestDraw();
        } else {
            this.resetView();
        }
    }

    /** The height map's points, filled where probed, and a grid about to be probed. */
    setProbe(map: HeightMap | null, draft: Grid | null): void {
        if (this.state.probeMap !== map || !sameGrid(this.state.probeDraft, draft)) {
            this.put("probeMap", map);
            this.put("probeDraft", draft);
            this.requestDraw();
        }
    }

    /** The paths picked, drawn with a halo; the same array again draws nothing new. */
    setSelection(refs: PathRef[]): void {
        if (refs !== this.state.selection) {
            this.put("selection", refs);
            this.requestDraw();
        }
    }

    /** The place in the job the JSON panel's caret is in: its path drawn on top, and its point. */
    setHighlight(place: JobPlace | null): void {
        if (place !== this.state.highlight) {
            this.put("highlight", place);
            this.requestDraw();
        }
    }

    /** With box selection on, a drag picks the paths inside its box; right drag still pans. */
    get boxSelection(): boolean {
        return this.state.boxSelect;
    }

    setBoxSelection(on: boolean): void {
        this.put("boxSelect", on);
        this.put("band", null);
        this.requestDraw();
    }

    /**
     * The path of the job under a canvas point: the one whose line (or dot)
     * comes nearest, within `PICK_PX`; null when none is that near. A
     * model's moves are no paths and are not picked.
     */
    pick(x: number, y: number): PathRef | null {
        const job = this.job;
        if (!job || this.state.width === 0) {
            return null;
        }
        const view = new Projector(frameOf(this.state.camera), this.state.width, this.state.height);
        const at = new Float64Array(2);
        let best: { ref: PathRef; distance: number } | null = null;
        job.groups.forEach((group, g) => {
            group.paths.forEach((path, p) => {
                let nearest = Infinity;
                let previous = false;
                let px = 0;
                let py = 0;
                for (const [bx, by] of path) {
                    if (!view.into(bx, by, 0, at)) {
                        previous = false;
                        continue;
                    }
                    const qx = at[0]!;
                    const qy = at[1]!;
                    nearest = Math.min(nearest, previous ? segmentDistance(x, y, px, py, qx, qy) : Math.hypot(x - qx, y - qy));
                    previous = true;
                    px = qx;
                    py = qy;
                }
                if (nearest <= PICK_PX && (best === null || nearest < best.distance)) {
                    best = { ref: [g, p], distance: nearest };
                }
            });
        });
        return best === null ? null : (best as { ref: PathRef }).ref;
    }

    /** Every path of the job wholly inside a box of canvas px. */
    pathsIn(box: SelectBox): PathRef[] {
        const job = this.job;
        if (!job) {
            return [];
        }
        const x0 = Math.min(box.x0, box.x1);
        const x1 = Math.max(box.x0, box.x1);
        const y0 = Math.min(box.y0, box.y1);
        const y1 = Math.max(box.y0, box.y1);
        const view = new Projector(frameOf(this.state.camera), this.state.width, this.state.height);
        const at = new Float64Array(2);
        const refs: PathRef[] = [];
        job.groups.forEach((group, g) => {
            group.paths.forEach((path, p) => {
                const inside = path.length > 0 && path.every(([px, py]) =>
                    view.into(px, py, 0, at) && at[0]! >= x0 && at[0]! <= x1 && at[1]! >= y0 && at[1]! <= y1);
                if (inside) {
                    refs.push([g, p]);
                }
            });
        });
        return refs;
    }

    /** The board's outline where the head camera's looks put it, drawn dashed over the job; empty for none. */
    setEstimate(paths: Point[][]): void {
        if (paths !== this.state.estimate && (paths.length > 0 || this.state.estimate.length > 0)) {
            this.put("estimate", paths);
            this.requestDraw();
        }
    }

    /** The saved positions to mark on the board, each with its name. */
    setMarkers(markers: Marker[]): void {
        if (markers !== this.state.markers) {
            this.put("markers", markers);
            this.requestDraw();
        }
    }

    /** Whether the height map's mesh and probe points are drawn; the choice is kept between visits. */
    get showHeights(): boolean {
        return this.state.heights;
    }

    setShowHeights(on: boolean): void {
        if (on !== this.state.heights) {
            this.put("heights", on);
            writeChoice(HEIGHTS_KEY, on);
            this.requestDraw();
        }
    }

    toggleHeights(): boolean {
        this.setShowHeights(!this.state.heights);
        return this.state.heights;
    }

    /**
     * Whether a square grid is drawn under the work instead of the rings:
     * the choice made in this browser, kept between visits, else the
     * machine's kind, a grid for a cartesian machine.
     */
    get showGrid(): boolean {
        return this.gridChoice ?? this.state.limits.kinematics === "cartesian";
    }

    setShowGrid(on: boolean): void {
        const before = this.showGrid;
        this.gridChoice = on;
        writeChoice(GRID_KEY, on);
        if (on !== before) {
            this.put("grid", on);
            this.requestDraw();
        }
    }

    /** What bounds the head as drawn. */
    getLimits(): Limits {
        return { ...this.state.limits };
    }

    /** What bounds the head: the machine's kinematics and its soft limits, as its profile gives them. */
    setLimits(limits: Limits): void {
        const current = this.state.limits;
        if (current.kinematics !== limits.kinematics || current.r_max !== limits.r_max || current.z_max !== limits.z_max) {
            this.put("limits", { kinematics: limits.kinematics, r_max: limits.r_max, z_max: limits.z_max });
            if (this.state.grid !== this.showGrid) {
                this.put("grid", this.showGrid);
            }
            this.requestDraw();
        }
    }

    /**
     * Live joint position, and the board point under the head when the
     * caller knows it (a cartesian machine's is not the joint's polar
     * point); the trail keeps the last positions that moved. A frame that
     * reports the head where it was draws nothing.
     */
    setHead(joint: Joint | null, board: Board | null = null): void {
        const next = joint ? board ?? boardOfJoint(joint) : null;
        const same = sameJoint(this.state.head, joint) && sameBoard(this.state.headBoard, next);
        if (next) {
            const last = this.trail[this.trail.length - 1];
            if (!last || Math.hypot(last[0] - next.x, last[1] - next.y) > 1e-4) {
                this.trail.push([next.x, next.y]);
                if (this.trail.length > TRAIL_LENGTH) {
                    this.trail.splice(0, this.trail.length - TRAIL_LENGTH);
                }
            }
        }
        if (!same) {
            this.put("head", joint);
            this.put("headBoard", next);
            this.put("trail", this.trail);
            this.requestDraw();
        }
    }

    clearTrail(): void {
        this.trail = [];
        this.put("trail", this.trail);
        this.requestDraw();
    }

    getCamera(): Camera {
        const camera = this.state.camera;
        return { ...camera, target: [...camera.target] as Vec3 };
    }

    setCamera(camera: Camera): void {
        this.put("camera", { ...camera, target: [...camera.target] as Vec3 });
        this.requestDraw();
    }

    /** With the rotation locked a plain drag pans instead of orbiting; the choice is kept between visits. */
    get rotationLocked(): boolean {
        return this.state.locked;
    }

    setRotationLocked(locked: boolean): void {
        this.put("locked", locked);
        writeChoice(LOCK_KEY, locked);
        this.requestDraw();
    }

    toggleRotationLock(): boolean {
        this.setRotationLocked(!this.state.locked);
        return this.state.locked;
    }

    /** Back to the overview: the axis in the middle, tilted, everything drawn in view. */
    resetView(): void {
        this.put("camera", overview(this.reach(), this.state.width || 1, this.state.height || 1));
        // A canvas measures 0 by 0 until it is laid out, so a fit before
        // that is against nothing and the next real size has to redo it.
        this.fitted = this.state.width > 1 && this.state.height > 1;
        this.requestDraw();
    }

    /** Straight down at what the view is centered on, the board square to the canvas. */
    lookDown(): void {
        this.put("camera", lookDown(this.state.camera));
        this.requestDraw();
    }

    /** The view turned a quarter at a time about what it is centered on: positive turns the board clockwise. */
    turnView(turns: number): void {
        this.put("camera", quarterTurn(this.state.camera, turns));
        this.requestDraw();
    }

    /** One pointer dragged from `from` to `to` in canvas px: orbits, or pans. */
    dragBy(from: [number, number], to: [number, number], mode: DragMode): void {
        const camera = this.state.camera;
        this.moveCamera(mode === "orbit"
            ? orbit(camera, to[0] - from[0], to[1] - from[1])
            : pan(camera, this.state.width || 1, this.state.height || 1, from, to));
    }

    /** The wheel, or a pinch: zoom by `factor` about a canvas point. */
    zoomBy(at: [number, number], factor: number): void {
        this.moveCamera(zoomAt(this.state.camera, this.state.width || 1, this.state.height || 1, at[0], at[1], factor));
    }

    /** Takes a camera a pointer or the wheel moved to; one that moved nothing (a pointer event where the last one was, a zoom at its limit) draws nothing. */
    private moveCamera(camera: Camera): void {
        if (sameCamera(camera, this.state.camera)) {
            return;
        }
        this.put("camera", camera);
        this.stir();
        this.requestDraw();
    }

    /** A drag (of the view, or along the cut order) moved the picture of a large job drawn in 2D: it is drawn coarser until it stands still. */
    private stir(): void {
        if (this.host.painter !== "2d" || this.jobPoints() <= COARSE_POINTS) {
            return;
        }
        if (!this.moving) {
            this.moving = true;
            this.put("coarse", true);
        }
        if (this.settleTimer !== null) {
            clearTimeout(this.settleTimer);
        }
        // A drag's next event waits for the frame being drawn, so a timer
        // shorter than two frames would find a slow drag still and draw a
        // full picture between every two coarse ones.
        this.settleTimer = setTimeout(() => {
            this.settleTimer = null;
            this.moving = false;
            this.put("coarse", false);
            this.requestDraw();
        }, Math.max(SETTLE_MS, 2 * this.drawMs));
    }

    /** How many points the job draws, counted once a job. */
    private jobPoints(): number {
        const job = this.state.job;
        const memo = this.pointsMemo;
        if (memo && memo.job === job) {
            return memo.points;
        }
        let points = 0;
        const count = (paths: readonly (readonly unknown[])[]): void => {
            for (const path of paths) {
                points += path.length;
            }
        };
        if (job) {
            count(job.copper);
            count(job.outline);
            for (const group of job.groups) {
                count(group.paths);
                count(group.moves ?? []);
            }
        }
        this.pointsMemo = { job, points };
        return points;
    }

    /** The farthest thing drawn, as `jobReach` has it, worked out once per job and limit. */
    private reach(): number {
        const limit = limitReach(this.state.limits);
        const memo = this.reachMemo;
        if (memo && memo.job === this.state.job && memo.limit === limit) {
            return memo.reach;
        }
        const reach = jobReach(this.state.job, limit);
        this.reachMemo = { job: this.state.job, limit, reach };
        return reach;
    }

    resize(): void {
        const rect = this.canvas.getBoundingClientRect();
        // A canvas hidden with its page measures 0 by 0: nothing is drawn
        // into it until it is back, and then once at least, since the head
        // went on moving meanwhile.
        const hidden = !(rect.width > 0 && rect.height > 0);
        const back = this.hidden && !hidden;
        this.hidden = hidden;
        if (hidden) {
            return;
        }
        this.attachOverlay();
        const width = Math.max(1, Math.round(rect.width));
        const height = Math.max(1, Math.round(rect.height));
        const dpr = typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1;
        const refit = !this.fitted;
        if (width !== this.state.width || height !== this.state.height || dpr !== this.state.dpr) {
            this.put("width", width);
            this.put("height", height);
            this.put("dpr", dpr);
            if (refit) {
                this.resetView();
            } else {
                this.requestDraw();
            }
        } else if (back) {
            this.requestDraw();
        }
    }

    /** Reads the palette from the stylesheet again, as after a change of theme. */
    refreshColors(): void {
        this.paletteAt = Number.NEGATIVE_INFINITY;
        this.requestDraw();
    }

    dispose(): void {
        if (this.settleTimer !== null) {
            clearTimeout(this.settleTimer);
            this.settleTimer = null;
        }
        this.moving = false;
        this.unbind();
        this.host.dispose();
        this.overlay.remove();
    }

    requestDraw(): void {
        if (this.pending) {
            return;
        }
        this.pending = true;
        const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn: () => void) => setTimeout(fn, 16);
        raf(() => {
            this.pending = false;
            this.draw();
        });
    }

    /** Sends the renderer what changed and, when it runs in the page, draws a frame now. */
    draw(): void {
        if (this.hidden || this.state.width === 0) {
            return;
        }
        this.flush();
        const ms = this.host.draw();
        if (ms !== undefined) {
            this.drawMs = ms;
            this.frames += 1;
        }
    }

    /** The speed view's rates; null leaves the view nothing to show. */
    setSpeedLimits(limits: SpeedLimits | null): void {
        const current = this.state.speedLimits;
        const same = limits !== null && current !== null
            && limits.kinematics === current.kinematics && limits.rRate === current.rRate
            && limits.aRate === current.aRate && limits.zRate === current.zRate && limits.tolerance === current.tolerance
            && limits.assumed === current.assumed;
        if (!same) {
            this.put("speedLimits", limits);
            this.requestDraw();
        }
    }

    /** With the speed view on, the job's cuts are drawn by the speed they run at, the capped ones marked. */
    get speedView(): boolean {
        return this.state.speed;
    }

    setSpeedView(on: boolean): void {
        this.put("speed", on);
        this.requestDraw();
    }

    /** The job's paths in the order they are cut: the groups that are on, in order, a model's group as one. */
    cutOrder(): PathRef[] {
        return cutOrderOf(this.state.job).order;
    }

    /** How many paths of the cut order are drawn as done, the last of them marked, the rest faint; null draws the job whole. */
    setScrub(at: number | null): void {
        if (at === this.state.scrub) {
            return;
        }
        this.put("scrub", at);
        this.stir();
        this.requestDraw();
    }

    get scrub(): number | null {
        return this.state.scrub;
    }

    /** The sizes of the operation being edited, as a sketch shows them; none clears them. */
    setDimensions(dims: Dimension[]): void {
        if (dims.length === 0 && this.state.dims.length === 0) {
            return;
        }
        this.put("dims", dims);
        this.requestDraw();
    }

    /** Records a change of the state for the renderer. */
    private put<K extends keyof RenderState>(key: K, value: RenderState[K]): void {
        this.state[key] = value;
        this.patch[key] = value;
    }

    /** Sends the renderer what changed, the palette read again when it is old. */
    private flush(): void {
        const at = now();
        if (at - this.paletteAt >= PALETTE_MS) {
            this.paletteAt = at;
            // The palette and the font are read from the stylesheet, once a
            // second at most since every read is a computed style; the same
            // values keep the same object, so nothing is drawn again for them.
            const colors = readColors(this.canvas);
            if (!sameColors(colors, this.state.colors)) {
                this.put("colors", colors);
            }
            const font = readFont(this.canvas);
            if (font !== this.state.font) {
                this.put("font", font);
            }
        }
        if (Object.keys(this.patch).length > 0) {
            const patch = this.patch;
            this.patch = {};
            this.host.send(patch);
        }
    }

    /** The host the options ask for; a worker only where a canvas can be handed to one and one can be made. */
    private makeHost(options: PreviewOptions): Host {
        const painter = options.painter ?? "auto";
        if (options.place !== "page" && canDrawInWorker(this.canvas)) {
            try {
                return new WorkerHost(this.canvas, this.overlay, { ...this.state }, painter, {
                    drawn: (ms) => {
                        this.drawMs = ms;
                        this.frames += 1;
                        if (this.frames === 1) {
                            this.showDrawing();
                        }
                    },
                    failed: (started) => this.drawInPage(started),
                });
            } catch (error) {
                console.warn(`preview: no drawing worker, drawing in the page: ${String(error)}`);
            }
        }
        return new PageHost(this.canvas, this.overlay, { ...this.state }, painter, () => this.requestDraw());
    }

    /**
     * The worker failed: the page draws instead. A worker that had taken
     * the canvases took them with it, so fresh ones take their places.
     */
    private drawInPage(started: boolean): void {
        if (started) {
            this.unbind();
            const scene = this.canvas.cloneNode(false) as HTMLCanvasElement;
            const overlay = this.makeOverlay();
            this.canvas.replaceWith(scene);
            this.overlay.remove();
            this.canvas = scene;
            this.overlay = overlay;
            this.attachOverlay();
            this.bind();
        }
        this.patch = {};
        this.host = new PageHost(this.canvas, this.overlay, { ...this.state }, this.painterChoice, () => this.requestDraw());
        this.showDrawing();
        this.requestDraw();
    }

    /** Says on the canvas what draws it ("worker gl", "page 2d"; "worker starting" until a worker has drawn), for the browser's tools and the render check. */
    private showDrawing(): void {
        this.canvas.dataset["drawing"] = `${this.host.place} ${this.host.painter ?? "starting"}`;
    }

    private makeOverlay(): HTMLCanvasElement {
        const overlay = this.canvas.ownerDocument.createElement("canvas");
        overlay.className = "preview-overlay";
        overlay.setAttribute("aria-hidden", "true");
        return overlay;
    }

    /** Lays the overlay over the canvas once the canvas is in the page. */
    private attachOverlay(): void {
        const parent = this.canvas.parentNode;
        if (parent !== null && this.overlay.parentNode !== parent) {
            this.canvas.after(this.overlay);
        }
    }

    private canvasPoint(event: { clientX: number; clientY: number }): [number, number] {
        const rect = this.canvas.getBoundingClientRect();
        return [event.clientX - rect.left, event.clientY - rect.top];
    }

    private unbind(): void {
        for (const dispose of this.disposers) {
            dispose();
        }
        this.disposers = [];
        this.observer?.disconnect();
        this.observer = null;
        this.pointers.clear();
    }

    private bind(): void {
        const canvas = this.canvas;
        const on = <K extends keyof HTMLElementEventMap>(type: K, handler: (event: HTMLElementEventMap[K]) => void, options?: AddEventListenerOptions): void => {
            canvas.addEventListener(type, handler, options);
            this.disposers.push(() => canvas.removeEventListener(type, handler, options));
        };
        on("wheel", (event) => {
            event.preventDefault();
            this.zoomBy(this.canvasPoint(event), event.deltaY < 0 ? 1.2 : 1 / 1.2);
        }, { passive: false });
        on("contextmenu", (event) => event.preventDefault());
        on("pointerdown", (event) => {
            const [x, y] = this.canvasPoint(event);
            this.pointers.set(event.pointerId, {
                x, y, button: event.button, shiftKey: event.shiftKey,
                downX: x, downY: y, moved: false,
                additive: event.shiftKey || event.ctrlKey || event.metaKey,
            });
            canvas.setPointerCapture?.(event.pointerId);
        });
        on("pointermove", (event) => {
            const pointer = this.pointers.get(event.pointerId);
            if (!pointer) {
                return;
            }
            const [x, y] = this.canvasPoint(event);
            if (!pointer.moved && Math.hypot(x - pointer.downX, y - pointer.downY) > CLICK_PX) {
                pointer.moved = true;
            }
            if (this.state.boxSelect && pointer.button === 0 && this.pointers.size === 1) {
                // A drag with box selection on draws the box, nothing turns.
                if (pointer.moved) {
                    this.put("band", { x0: pointer.downX, y0: pointer.downY, x1: x, y1: y });
                    this.requestDraw();
                }
                pointer.x = x;
                pointer.y = y;
                return;
            }
            const others = Array.from(this.pointers.entries()).filter(([id]) => id !== event.pointerId);
            if (others.length > 0) {
                // Two fingers: zoom by how their distance changed, about
                // their middle, and pan by how the middle moved.
                const other = others[0]![1];
                const before = Math.hypot(pointer.x - other.x, pointer.y - other.y);
                const after = Math.hypot(x - other.x, y - other.y);
                const midBefore: [number, number] = [(pointer.x + other.x) / 2, (pointer.y + other.y) / 2];
                const midAfter: [number, number] = [(x + other.x) / 2, (y + other.y) / 2];
                if (before > 0 && after > 0) {
                    this.zoomBy(midAfter, after / before);
                }
                this.dragBy(midBefore, midAfter, "pan");
            } else {
                this.dragBy([pointer.x, pointer.y], [x, y], dragMode(this.state.locked, { button: pointer.button, shiftKey: event.shiftKey || pointer.shiftKey }));
            }
            pointer.x = x;
            pointer.y = y;
        });
        const end = (event: PointerEvent): void => {
            const pointer = this.pointers.get(event.pointerId);
            const alone = this.pointers.size === 1;
            this.pointers.delete(event.pointerId);
            const band = this.state.band;
            if (!pointer || event.type !== "pointerup" || !alone || pointer.button !== 0) {
                if (band !== null) {
                    this.put("band", null);
                    this.requestDraw();
                }
                return;
            }
            if (band !== null) {
                const refs = this.pathsIn(band);
                this.put("band", null);
                this.requestDraw();
                this.onBox?.(refs, pointer.additive);
            } else if (!pointer.moved) {
                const [x, y] = this.canvasPoint(event);
                this.onPick?.(this.pick(x, y), pointer.additive);
            }
        };
        on("pointerup", end);
        on("pointercancel", end);
        on("dblclick", () => this.resetView());

        if (typeof ResizeObserver === "function") {
            this.observer = new ResizeObserver(() => this.resize());
            this.observer.observe(canvas);
        } else if (typeof window !== "undefined") {
            const handler = (): void => this.resize();
            window.addEventListener("resize", handler);
            this.disposers.push(() => window.removeEventListener("resize", handler));
        }
        if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
            const media = window.matchMedia("(prefers-color-scheme: dark)");
            const handler = (): void => this.refreshColors();
            media.addEventListener?.("change", handler);
            this.disposers.push(() => media.removeEventListener?.("change", handler));
        }
    }
}

/** A clock in ms, for the palette's age. */
function now(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function sameJoint(a: Joint | null, b: Joint | null): boolean {
    if (a === null || b === null) {
        return a === b;
    }
    return a.r === b.r && a.a === b.a;
}

function sameBoard(a: Board | null, b: Board | null): boolean {
    if (a === null || b === null) {
        return a === b;
    }
    return a.x === b.x && a.y === b.y;
}
