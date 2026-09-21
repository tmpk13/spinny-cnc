// Canvas preview drawn around the rotation axis in board mm: the axis cross,
// the rail along +X, the r_max circle, copper, outline, the job's paths and
// the head with a short trail. Wheel zooms, drag pans, double click resets.

import { cssVar } from "./dom.ts";
import { boardOfJoint } from "./kinematics.ts";
import type { Job, Joint, Path, Point } from "./types.ts";

/** World center in mm and CSS pixels per mm. */
export interface View {
    cx: number;
    cy: number;
    scale: number;
}

/** Screen room a ring label needs before the next one is drawn. */
export const LABEL_GAP_PX = 44;
export const MIN_SCALE = 0.05;
export const MAX_SCALE = 400;
const FIT_MARGIN = 1.15;
const TRAIL_LENGTH = 240;

export function fitView(reach: number, width: number, height: number): View {
    const span = Math.max(reach, 1) * 2 * FIT_MARGIN;
    const scale = Math.min(width, height) / span;
    return { cx: 0, cy: 0, scale: clampScale(scale) };
}

export function clampScale(scale: number): number {
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export function worldToScreen(view: View, width: number, height: number, x: number, y: number): Point {
    return [width / 2 + (x - view.cx) * view.scale, height / 2 - (y - view.cy) * view.scale];
}

export function screenToWorld(view: View, width: number, height: number, sx: number, sy: number): Point {
    return [view.cx + (sx - width / 2) / view.scale, view.cy - (sy - height / 2) / view.scale];
}

/** Zoom by `factor` keeping the world point under the cursor still. */
export function zoomAt(view: View, width: number, height: number, sx: number, sy: number, factor: number): View {
    const [wx, wy] = screenToWorld(view, width, height, sx, sy);
    const scale = clampScale(view.scale * factor);
    return {
        cx: wx - (sx - width / 2) / scale,
        cy: wy + (sy - height / 2) / scale,
        scale,
    };
}

export function panBy(view: View, dx: number, dy: number): View {
    return { cx: view.cx - dx / view.scale, cy: view.cy + dy / view.scale, scale: view.scale };
}

/** Farthest coordinate of anything drawn, in mm from the axis. */
export function jobReach(job: Job | null, rMax: number): number {
    let reach = rMax > 0 ? rMax : 0;
    if (job) {
        const paths: Path[] = [...job.outline, ...job.copper];
        for (const group of job.groups) {
            paths.push(...group.paths);
        }
        for (const path of paths) {
            for (const [x, y] of path) {
                reach = Math.max(reach, Math.hypot(x, y));
            }
        }
    }
    return reach > 0 ? reach : 10;
}

/** How many rings to skip between labels so they stay readable. */
export function labelEvery(stepMm: number, scale: number): number {
    const apart = stepMm * scale;
    if (apart >= LABEL_GAP_PX) {
        return 1;
    }
    return apart * 2 >= LABEL_GAP_PX ? 2 : 4;
}

/** Ring spacing in a 1-2-5 series that puts a handful of rings inside `reach`. */
export function ringStep(reach: number): number {
    const candidates = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
    for (const step of candidates) {
        if (reach / step <= 6) {
            return step;
        }
    }
    return 1000;
}

interface Colors {
    bg: string;
    grid: string;
    axis: string;
    rail: string;
    rmax: string;
    copper: string;
    outline: string;
    head: string;
    trail: string;
    text: string;
    groups: string[];
}

export class Preview {
    private readonly canvas: HTMLCanvasElement;
    private readonly ctx: CanvasRenderingContext2D | null;
    private view: View = { cx: 0, cy: 0, scale: 4 };
    private width = 0;
    private height = 0;
    private dpr = 1;
    /** The view was fitted against a canvas that had a size. */
    private fitted = false;
    private job: Job | null = null;
    private rMax = 0;
    private head: Joint | null = null;
    private trail: Point[] = [];
    private groupShapes: (Path2D | null)[] = [];
    private copperShape: Path2D | null = null;
    private outlineShape: Path2D | null = null;
    private pending = false;
    private observer: ResizeObserver | null = null;
    private drag: { id: number; x: number; y: number } | null = null;
    private disposers: (() => void)[] = [];

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        this.ctx = canvas.getContext("2d");
        this.bind();
        this.resize();
    }

    /** Shows a job; the view refits unless `keepView` is set, as for an edit of the same job. */
    setJob(job: Job | null, keepView = false): void {
        this.job = job;
        this.groupShapes = job ? job.groups.map((group) => makeShape(group.paths)) : [];
        this.copperShape = job ? makeShape(job.copper) : null;
        this.outlineShape = job ? makeShape(job.outline) : null;
        if (keepView) {
            this.requestDraw();
        } else {
            this.resetView();
        }
    }

    setRMax(mm: number): void {
        if (this.rMax !== mm) {
            this.rMax = mm;
            this.requestDraw();
        }
    }

    /** Live joint position; the trail keeps the last positions that moved. */
    setHead(joint: Joint | null): void {
        this.head = joint;
        if (joint) {
            const board = boardOfJoint(joint);
            const last = this.trail[this.trail.length - 1];
            if (!last || Math.hypot(last[0] - board.x, last[1] - board.y) > 1e-4) {
                this.trail.push([board.x, board.y]);
                if (this.trail.length > TRAIL_LENGTH) {
                    this.trail.splice(0, this.trail.length - TRAIL_LENGTH);
                }
            }
        }
        this.requestDraw();
    }

    clearTrail(): void {
        this.trail = [];
        this.requestDraw();
    }

    getView(): View {
        return this.view;
    }

    setView(view: View): void {
        this.view = view;
        this.requestDraw();
    }

    resetView(): void {
        this.view = fitView(jobReach(this.job, this.rMax), this.width || 1, this.height || 1);
        // A canvas measures 0 by 0 until it is laid out, so a fit before
        // that is against nothing and the next real size has to redo it.
        this.fitted = this.width > 1 && this.height > 1;
        this.requestDraw();
    }

    resize(): void {
        const rect = this.canvas.getBoundingClientRect();
        const width = Math.max(1, Math.round(rect.width));
        const height = Math.max(1, Math.round(rect.height));
        const dpr = typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1;
        const refit = !this.fitted;
        if (width !== this.width || height !== this.height || dpr !== this.dpr) {
            this.width = width;
            this.height = height;
            this.dpr = dpr;
            this.canvas.width = Math.round(width * dpr);
            this.canvas.height = Math.round(height * dpr);
            if (refit) {
                this.resetView();
            } else {
                this.requestDraw();
            }
        }
    }

    dispose(): void {
        for (const dispose of this.disposers) {
            dispose();
        }
        this.disposers = [];
        this.observer?.disconnect();
        this.observer = null;
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

    draw(): void {
        const ctx = this.ctx;
        if (!ctx || this.width === 0) {
            return;
        }
        const colors = this.colors();
        const { width, height, dpr, view } = this;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = colors.bg;
        ctx.fillRect(0, 0, width, height);

        const reach = jobReach(this.job, this.rMax);
        const px = 1 / view.scale;

        // World transform: mm to CSS px, y up.
        ctx.setTransform(
            dpr * view.scale, 0, 0, -dpr * view.scale,
            dpr * (width / 2 - view.cx * view.scale),
            dpr * (height / 2 + view.cy * view.scale),
        );
        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        // Rings and the rail.
        const step = ringStep(reach);
        ctx.strokeStyle = colors.grid;
        ctx.lineWidth = px;
        for (let ring = step; ring <= reach * 1.5; ring += step) {
            ctx.beginPath();
            ctx.arc(0, 0, ring, 0, Math.PI * 2);
            ctx.stroke();
        }
        ctx.strokeStyle = colors.rail;
        ctx.lineWidth = 2 * px;
        ctx.setLineDash([8 * px, 6 * px]);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.max(reach * 1.5, 10), 0);
        ctx.stroke();
        ctx.setLineDash([]);

        if (this.rMax > 0) {
            ctx.strokeStyle = colors.rmax;
            ctx.lineWidth = 1.5 * px;
            ctx.setLineDash([4 * px, 4 * px]);
            ctx.beginPath();
            ctx.arc(0, 0, this.rMax, 0, Math.PI * 2);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        const job = this.job;
        if (job) {
            if (job.copper.length > 0) {
                ctx.fillStyle = colors.copper;
                ctx.globalAlpha = 0.35;
                fillPaths(ctx, job.copper, this.copperShape);
                ctx.globalAlpha = 1;
            }
            const spot = job.spot > 0 ? job.spot : 0.1;
            job.groups.forEach((group, index) => {
                ctx.strokeStyle = colors.groups[index % colors.groups.length] ?? colors.axis;
                ctx.globalAlpha = group.enabled ? 0.9 : 0.25;
                ctx.lineWidth = Math.max(spot, 1.2 * px);
                strokePaths(ctx, group.paths, this.groupShapes[index] ?? null);
            });
            ctx.globalAlpha = 1;
            if (job.outline.length > 0) {
                ctx.strokeStyle = colors.outline;
                ctx.lineWidth = Math.max(spot / 2, px);
                strokePaths(ctx, job.outline, this.outlineShape);
            }
        }

        // Axis cross.
        const cross = 10 * px;
        ctx.strokeStyle = colors.axis;
        ctx.lineWidth = 1.5 * px;
        ctx.beginPath();
        ctx.moveTo(-cross, 0);
        ctx.lineTo(cross, 0);
        ctx.moveTo(0, -cross);
        ctx.lineTo(0, cross);
        ctx.stroke();

        // Trail and head.
        if (this.trail.length > 1) {
            ctx.strokeStyle = colors.trail;
            ctx.lineWidth = 2 * px;
            ctx.globalAlpha = 0.7;
            ctx.beginPath();
            this.trail.forEach(([x, y], index) => {
                if (index === 0) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }
            });
            ctx.stroke();
            ctx.globalAlpha = 1;
        }
        if (this.head) {
            const board = boardOfJoint(this.head);
            ctx.strokeStyle = colors.head;
            ctx.fillStyle = colors.head;
            ctx.lineWidth = 1.5 * px;
            ctx.beginPath();
            ctx.arc(board.x, board.y, 6 * px, 0, Math.PI * 2);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(board.x, board.y, 2 * px, 0, Math.PI * 2);
            ctx.fill();
            // The radius line from the axis to the head.
            ctx.globalAlpha = 0.5;
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(board.x, board.y);
            ctx.stroke();
            ctx.globalAlpha = 1;
        }

        // Labels in screen space.
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = colors.text;
        ctx.font = "0.75rem system-ui, sans-serif";
        ctx.textBaseline = "top";
        ctx.textAlign = "left";
        // Every ring gets a label only while they are far enough apart to
        // read; closer than that, every second or fourth one is labelled.
        const every = labelEvery(step, view.scale);
        let index = 0;
        for (let ring = step; ring <= reach * 1.5; ring += step) {
            index += 1;
            if (index % every !== 0) {
                continue;
            }
            const [sx, sy] = worldToScreen(view, width, height, ring, 0);
            if (sx > 0 && sx < width && sy > 0 && sy < height) {
                ctx.fillText(`${ring} mm`, sx + 3, sy + 3);
            }
        }
        ctx.textAlign = "right";
        ctx.textBaseline = "bottom";
        ctx.fillText(`${(view.scale).toFixed(1)} px/mm`, width - 6, height - 4);
    }

    private colors(): Colors {
        const node = this.canvas;
        return {
            bg: cssVar(node, "--pv-bg", "#ffffff"),
            grid: cssVar(node, "--pv-grid", "#d8d8d8"),
            axis: cssVar(node, "--pv-axis", "#e07000"),
            rail: cssVar(node, "--pv-rail", "#8090a0"),
            rmax: cssVar(node, "--pv-rmax", "#c02020"),
            copper: cssVar(node, "--pv-copper", "#c8a165"),
            outline: cssVar(node, "--pv-outline", "#404040"),
            head: cssVar(node, "--pv-head", "#e07000"),
            trail: cssVar(node, "--pv-trail", "#e0a000"),
            text: cssVar(node, "--pv-text", "#606060"),
            groups: [
                cssVar(node, "--pv-g0", "#c02020"),
                cssVar(node, "--pv-g1", "#204090"),
                cssVar(node, "--pv-g2", "#207040"),
                cssVar(node, "--pv-g3", "#806000"),
            ],
        };
    }

    private bind(): void {
        const canvas = this.canvas;
        const on = <K extends keyof HTMLElementEventMap>(type: K, handler: (event: HTMLElementEventMap[K]) => void, options?: AddEventListenerOptions): void => {
            canvas.addEventListener(type, handler, options);
            this.disposers.push(() => canvas.removeEventListener(type, handler, options));
        };
        on("wheel", (event) => {
            event.preventDefault();
            const rect = canvas.getBoundingClientRect();
            const factor = event.deltaY < 0 ? 1.2 : 1 / 1.2;
            this.view = zoomAt(this.view, this.width, this.height, event.clientX - rect.left, event.clientY - rect.top, factor);
            this.requestDraw();
        }, { passive: false });
        on("pointerdown", (event) => {
            if (event.button !== 0 && event.pointerType === "mouse") {
                return;
            }
            this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
            canvas.setPointerCapture?.(event.pointerId);
        });
        on("pointermove", (event) => {
            if (!this.drag || this.drag.id !== event.pointerId) {
                return;
            }
            this.view = panBy(this.view, event.clientX - this.drag.x, event.clientY - this.drag.y);
            this.drag.x = event.clientX;
            this.drag.y = event.clientY;
            this.requestDraw();
        });
        const end = (event: PointerEvent): void => {
            if (this.drag && this.drag.id === event.pointerId) {
                this.drag = null;
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
            const handler = (): void => this.requestDraw();
            media.addEventListener?.("change", handler);
            this.disposers.push(() => media.removeEventListener?.("change", handler));
        }
    }
}

function makeShape(paths: Path[]): Path2D | null {
    if (typeof Path2D !== "function") {
        return null;
    }
    const shape = new Path2D();
    tracePaths(shape, paths);
    return shape;
}

function tracePaths(target: { moveTo(x: number, y: number): void; lineTo(x: number, y: number): void }, paths: Path[]): void {
    for (const path of paths) {
        path.forEach(([x, y], index) => {
            if (index === 0) {
                target.moveTo(x, y);
            } else {
                target.lineTo(x, y);
            }
        });
    }
}

function strokePaths(ctx: CanvasRenderingContext2D, paths: Path[], shape: Path2D | null): void {
    if (shape) {
        ctx.stroke(shape);
        return;
    }
    ctx.beginPath();
    tracePaths(ctx, paths);
    ctx.stroke();
}

function fillPaths(ctx: CanvasRenderingContext2D, paths: Path[], shape: Path2D | null): void {
    if (shape) {
        ctx.fill(shape, "evenodd");
        return;
    }
    ctx.beginPath();
    tracePaths(ctx, paths);
    ctx.fill("evenodd");
}
