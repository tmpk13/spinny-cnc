// The 2D painter: the scene's items (scene.ts) on a 2D canvas, for a
// browser that gives no WebGL2. Every point is projected by camera.ts's
// Projector and stroked with the plain 2D context.
//
// What stays still is drawn once into two offscreen layers for the camera,
// size, job and palette of the moment, the board under the rail and the
// work over it, and the two are copied either side of the rail when only
// the rail moved (a cartesian machine's head). A large job is drawn again
// on every frame of a pan or a zoom, so its lines are projected without
// allocating, their detail under half a pixel and the lines off the canvas
// left out, and stroked a batch of points at a time (see `Pen`); while a
// drag moves the view of a very large job its lines are drawn a device
// pixel wide, and in full again once the view stands still.

import type { Projector } from "../camera.ts";
import type { SpeedMap } from "../speed.ts";
import {
    type Circle,
    type CutOrder,
    type Ink,
    type Item,
    type Line,
    type LineSource,
    type Polyline,
    type RenderJob,
    type RenderState,
    type Scene,
    cachedRuns,
    cutOrderOf,
    dotRadius,
    passes,
    speedLines,
    spotOf,
} from "./scene.ts";
import type { Path, Point } from "../types.ts";

export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
export type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** The 2D context of a canvas of either kind; null where none can be had. */
export function context2d(canvas: AnyCanvas): Context2D | null {
    return (canvas as OffscreenCanvas).getContext("2d") as Context2D | null;
}

/**
 * Points a canvas path holds before it is stroked and a new one begun. The
 * rasterizer's work on a scan line grows with the edges of the path that
 * cross it, so one path of a whole board's lines costs far more than the
 * same lines a hundred or so points at a time: 20 000 clearing strokes
 * across a board took half a second as one path, 38 ms in batches of 128
 * (Chromium's software canvas; 64 to 256 were within 10%).
 */
export const BATCH_POINTS = 128;
/** A point of a line nearer than this to the last point kept, CSS px either way, is left out: it moves the line by less than that. */
export const DETAIL_PX = 0.5;
/** The detail left out while a large job's view moves, px. */
export const COARSE_DETAIL_PX = 1;

/** Canvas points of the line being drawn, x and y in turn, and whether each is in front of the eye; grown to the longest line yet. */
let lineXY = new Float64Array(2048);
let lineInFront = new Uint8Array(1024);

/**
 * Projects a line into `lineXY` and `lineInFront`: "none" when nothing of
 * it can show (every point behind the eye, or all of those in front past
 * one edge of the canvas by more than `margin` px, which leaves the
 * segments between them past it too), "whole" when every point is in
 * front, "broken" when some are behind.
 */
function projectLine(view: Projector, line: Line, margin: number): "none" | "whole" | "broken" {
    const n = line.length;
    if (lineInFront.length < n) {
        const size = Math.max(n, lineInFront.length * 2);
        lineXY = new Float64Array(2 * size);
        lineInFront = new Uint8Array(size);
    }
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let behind = false;
    for (let i = 0; i < n; i++) {
        const point = line[i]!;
        if (!view.into(point[0]!, point[1]!, point[2] ?? 0, lineXY, 2 * i)) {
            lineInFront[i] = 0;
            behind = true;
            continue;
        }
        lineInFront[i] = 1;
        const x = lineXY[2 * i]!;
        const y = lineXY[2 * i + 1]!;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
    }
    if (x0 > x1 || x1 < -margin || y1 < -margin || x0 > view.width + margin || y0 > view.height + margin) {
        return "none";
    }
    return behind ? "broken" : "whole";
}

/**
 * Strokes lines on a context a batch at a time (`BATCH_POINTS`): each line
 * projected once, a point within `detail` px of the last one kept left out
 * (a run's last point always kept, so a line ends where it does), a line
 * wholly off the canvas skipped, and the pen lifted across a point behind
 * the eye. A line split between two batches meets itself under round caps,
 * which draw as the round join would.
 */
export class Pen {
    private count = 0;
    /** Something was stroked. */
    stroked = false;

    constructor(
        private readonly ctx: Context2D,
        private readonly view: Projector,
        private readonly margin: number,
        private readonly detail: number,
    ) {
        ctx.beginPath();
    }

    /** One line; `closed` joins its last point to its first unless it breaks behind the eye. A line of one point is a dot, the round cap of a stroke of no length. */
    line(line: Line, closed = false): void {
        const n = line.length;
        if (n === 0 || projectLine(this.view, line, this.margin) === "none") {
            return;
        }
        const ctx = this.ctx;
        let pen = false;
        let broken = false;
        let started = false;
        let firstX = 0;
        let firstY = 0;
        let lastX = 0;
        let lastY = 0;
        for (let i = 0; i < n; i++) {
            if (lineInFront[i] === 0) {
                pen = false;
                broken = true;
                continue;
            }
            const x = lineXY[2 * i]!;
            const y = lineXY[2 * i + 1]!;
            if (!pen) {
                if (this.count >= BATCH_POINTS) {
                    this.flush();
                }
                ctx.moveTo(x, y);
                this.count += 1;
                pen = true;
                lastX = x;
                lastY = y;
                if (!started) {
                    started = true;
                    firstX = x;
                    firstY = y;
                }
                if (n === 1) {
                    ctx.lineTo(x, y);
                    this.count += 1;
                }
                continue;
            }
            const end = i === n - 1 || lineInFront[i + 1] === 0;
            if (!end && Math.abs(x - lastX) < this.detail && Math.abs(y - lastY) < this.detail) {
                continue;
            }
            ctx.lineTo(x, y);
            lastX = x;
            lastY = y;
            this.count += 1;
            if (this.count >= BATCH_POINTS && !end) {
                this.flush();
                ctx.moveTo(x, y);
                this.count = 1;
            }
        }
        if (closed && pen && !broken) {
            ctx.lineTo(firstX, firstY);
            this.count += 1;
        }
    }

    /** Strokes what is left. */
    end(): void {
        if (this.count > 0) {
            this.ctx.stroke();
            this.stroked = true;
        }
        this.count = 0;
    }

    private flush(): void {
        this.ctx.stroke();
        this.stroked = true;
        this.ctx.beginPath();
        this.count = 0;
    }
}

/**
 * Traces a polyline into the context's path, the pen up across a null or a
 * point behind the eye; a closed one is joined back to its first point
 * unless it broke (closing across the gap would draw a chord through the
 * view). A polyline of a single point is a dot. Returns whether anything
 * was traced.
 */
export function tracePolyline(ctx: Context2D, view: Projector, line: Polyline): boolean {
    const at = new Float64Array(2);
    const points = line.points;
    if (points.length === 1) {
        const point = points[0];
        if (!point || !view.into(point[0], point[1], point[2], at)) {
            return false;
        }
        ctx.moveTo(at[0]!, at[1]!);
        ctx.lineTo(at[0]!, at[1]!);
        return true;
    }
    let pen = false;
    let drawn = false;
    let broken = false;
    let started = false;
    let firstX = 0;
    let firstY = 0;
    for (const point of points) {
        if (!point || !view.into(point[0], point[1], point[2], at)) {
            pen = false;
            broken = true;
            continue;
        }
        if (!pen) {
            ctx.moveTo(at[0]!, at[1]!);
            pen = true;
            if (!started) {
                started = true;
                firstX = at[0]!;
                firstY = at[1]!;
            }
        } else {
            ctx.lineTo(at[0]!, at[1]!);
            drawn = true;
        }
    }
    if (line.closed && pen && started && !broken) {
        ctx.lineTo(firstX, firstY);
        drawn = true;
    }
    return drawn;
}

/** Strokes polylines in an ink as one path, so a translucent set is no darker where its lines cross. */
export function strokePolylines(ctx: Context2D, view: Projector, lines: readonly Polyline[], ink: Ink): void {
    ctx.strokeStyle = ink.color;
    ctx.lineWidth = ink.width;
    ctx.globalAlpha = ink.alpha;
    ctx.setLineDash(ink.dash ? [ink.dash[0], ink.dash[1]] : []);
    ctx.beginPath();
    let drawn = false;
    for (const line of lines) {
        drawn = tracePolyline(ctx, view, line) || drawn;
    }
    if (drawn) {
        ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
}

/** Circles at world points, each a size on the screen, filled or stroked, at one opacity; those behind the eye are left out. */
export function drawCircles(ctx: Context2D, view: Projector, circles: readonly Circle[], alpha: number): void {
    const at = new Float64Array(2);
    ctx.globalAlpha = alpha;
    for (const circle of circles) {
        if (!view.into(circle.at[0], circle.at[1], circle.at[2], at)) {
            continue;
        }
        ctx.beginPath();
        ctx.arc(at[0]!, at[1]!, circle.radius, 0, Math.PI * 2);
        if (circle.stroke !== undefined) {
            ctx.strokeStyle = circle.color;
            ctx.lineWidth = circle.stroke;
            ctx.stroke();
        } else {
            ctx.fillStyle = circle.color;
            ctx.fill();
        }
    }
    ctx.globalAlpha = 1;
}

/** What paint draws from: the scene's items, the state they were made from, and the frame's projection. */
export interface PaintInput {
    scene: Scene;
    state: RenderState;
    view: Projector;
    /** CSS px per mm at the target's depth. */
    scale: number;
    speeds: SpeedMap | null;
    /** Something but the rail changed since the last paint, so the still layers are drawn again. */
    still: boolean;
}

/** A layer and its context. */
interface Layer {
    canvas: AnyCanvas;
    ctx: Context2D;
}

/** The lines a source names, as the job holds them. */
export function sourceLines(source: LineSource, job: RenderJob, state: RenderState, speeds: SpeedMap | null, order: CutOrder): readonly Line[] {
    switch (source.kind) {
        case "paths": {
            const group = job.groups[source.group];
            if (!group) {
                return [];
            }
            const start = order.start[source.group] ?? -1;
            const filter = source.filter;
            return group.paths.filter((path, p) => path.length !== 1 && (filter.kind === "all" || start < 0 || passes(filter, start + p)));
        }
        case "runs":
            return cachedRuns(job.groups[source.group]?.moves ?? []);
        case "outline":
            return job.outline;
        case "picked":
            return state.selection
                .map(([g, p]) => job.groups[g]?.paths[p])
                .filter((path): path is Path => path !== undefined);
        case "speed": {
            if (speeds === null) {
                return [];
            }
            const lines = speedLines(speeds);
            return source.bucket === null ? lines.capped : lines.buckets[source.bucket] ?? [];
        }
    }
}

/** A group's dots that pass its filter: each point with its radius in mm. */
export function groupDots(item: Extract<Item, { kind: "dots" }>, job: RenderJob, order: CutOrder): [Point, number][] {
    const group = job.groups[item.group];
    if (!group) {
        return [];
    }
    const spot = spotOf(job);
    const start = order.start[item.group] ?? -1;
    const filter = item.filter;
    return group.paths.flatMap((path, p): [Point, number][] =>
        path.length === 1 && (filter.kind === "all" || start < 0 || passes(filter, start + p)) ? [[path[0]!, dotRadius(group.areas?.[p], spot)]] : []);
}

export class Canvas2DPainter {
    readonly kind = "2d";
    private under: Layer | null = null;
    private over: Layer | null = null;
    /** A layer a translucent set of lines is stroked on opaque before it is laid on the picture with its alpha. */
    private scratch: Layer | null = null;
    /** Offscreen canvases cannot be had: everything is drawn straight onto the canvas every time. */
    private noLayers = false;
    /** The layers hold a picture. */
    private drawn = false;
    /** The detail the lines being drawn keep, px. */
    private detail = DETAIL_PX;
    private width = 0;
    private height = 0;
    private dpr = 1;

    constructor(private readonly ctx: Context2D, private readonly makeLayer: () => AnyCanvas | null) {}

    paint(input: PaintInput): void {
        const { state } = input;
        const ctx = this.ctx;
        this.detail = state.coarse ? COARSE_DETAIL_PX : DETAIL_PX;
        this.width = state.width;
        this.height = state.height;
        this.dpr = state.dpr;
        const layers = this.layers();
        if (layers !== null) {
            if (input.still || !this.drawn) {
                this.beginLayer(layers.under);
                this.drawBackground(layers.under.ctx, state);
                this.drawItems(layers.under.ctx, input.scene.board, input);
                this.beginLayer(layers.over);
                this.drawItems(layers.over.ctx, input.scene.work, input);
                this.drawn = true;
            }
        }
        ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.globalAlpha = 1;
        if (layers !== null) {
            this.blit(ctx, layers.under.canvas);
        } else {
            this.drawBackground(ctx, state);
            this.drawItems(ctx, input.scene.board, input);
        }
        this.drawItems(ctx, input.scene.rail, input);
        if (layers !== null) {
            this.blit(ctx, layers.over.canvas);
        } else {
            this.drawItems(ctx, input.scene.work, input);
        }
    }

    dispose(): void {
        this.under = null;
        this.over = null;
        this.scratch = null;
    }

    private drawBackground(ctx: Context2D, state: RenderState): void {
        ctx.fillStyle = state.colors.bg;
        ctx.fillRect(0, 0, state.width, state.height);
    }

    /** The two still layers; null where offscreen canvases cannot be had. */
    private layers(): { under: Layer; over: Layer } | null {
        if (this.noLayers) {
            return null;
        }
        this.under ??= this.layer();
        this.over ??= this.layer();
        if (this.under === null || this.over === null) {
            this.noLayers = true;
            return null;
        }
        return { under: this.under, over: this.over };
    }

    private layer(): Layer | null {
        const canvas = this.makeLayer();
        const ctx = canvas ? context2d(canvas) : null;
        return canvas && ctx ? { canvas, ctx } : null;
    }

    /** Sizes a layer to the canvas and wipes it, the transform set so it is drawn in CSS px like the canvas. */
    private beginLayer(layer: Layer): void {
        const width = Math.round(this.width * this.dpr);
        const height = Math.round(this.height * this.dpr);
        if (layer.canvas.width !== width || layer.canvas.height !== height) {
            layer.canvas.width = width;
            layer.canvas.height = height;
        }
        const ctx = layer.ctx;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, width, height);
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.globalAlpha = 1;
        ctx.setLineDash([]);
    }

    /** Copies a layer onto a context, device pixel for device pixel. */
    private blit(ctx: Context2D, layer: AnyCanvas): void {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(layer, 0, 0);
        ctx.restore();
    }

    /** The scratch layer, sized and wiped; null where offscreen canvases cannot be had. */
    private scratchLayer(): Layer | null {
        if (this.noLayers) {
            return null;
        }
        this.scratch ??= this.layer();
        if (this.scratch === null) {
            return null;
        }
        this.beginLayer(this.scratch);
        return this.scratch;
    }

    private drawItems(ctx: Context2D, items: readonly Item[], input: PaintInput): void {
        const { state, view, scale, speeds } = input;
        const job = state.job;
        const order = cutOrderOf(job);
        for (const item of items) {
            switch (item.kind) {
                case "lines":
                    if (job) {
                        this.strokeLines(ctx, view, sourceLines(item.source, job, state, speeds, order), item.ink);
                    }
                    break;
                case "dots":
                    if (job) {
                        ctx.fillStyle = item.color;
                        ctx.globalAlpha = item.alpha;
                        this.fillDots(ctx, view, groupDots(item, job, order), scale);
                        ctx.globalAlpha = 1;
                    }
                    break;
                case "copper":
                    if (job) {
                        ctx.fillStyle = item.color;
                        ctx.globalAlpha = item.alpha;
                        this.fillPaths(ctx, view, job.copper);
                        ctx.globalAlpha = 1;
                    }
                    break;
                case "polylines":
                    strokePolylines(ctx, view, item.lines, item.ink);
                    break;
                case "circles":
                    drawCircles(ctx, view, item.circles, item.alpha);
                    break;
            }
        }
    }

    /**
     * Strokes board lines in `ink` with a `Pen`. Translucent lines of more
     * than one batch are stroked opaque on the scratch layer and laid on
     * with their alpha, so where they cross they are no darker than where
     * they run alone, as one stroke draws them.
     */
    private strokeLines(ctx: Context2D, view: Projector, lines: readonly Line[], ink: Ink): void {
        let points = 0;
        for (const line of lines) {
            points += line.length;
        }
        if (points === 0) {
            return;
        }
        const scratch = ink.alpha < 1 && points > BATCH_POINTS ? this.scratchLayer() : null;
        const target = scratch?.ctx ?? ctx;
        target.strokeStyle = ink.color;
        target.lineWidth = ink.width;
        target.globalAlpha = scratch ? 1 : ink.alpha;
        const pen = new Pen(target, view, ink.width / 2 + 1, this.detail);
        for (const line of lines) {
            pen.line(line);
        }
        pen.end();
        if (scratch && pen.stroked) {
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.globalAlpha = ink.alpha;
            ctx.drawImage(scratch.canvas, 0, 0);
            ctx.restore();
        }
        ctx.globalAlpha = 1;
    }

    /**
     * Filled circles on the board, each at a point with a radius in mm but
     * at least a couple of pixels, in the fill style of the moment and one
     * fill; those off the canvas are left out.
     */
    private fillDots(ctx: Context2D, view: Projector, dots: readonly [Point, number][], scale: number): void {
        const at = new Float64Array(2);
        ctx.beginPath();
        let drawn = false;
        for (const [[x, y], radius] of dots) {
            if (!view.into(x, y, 0, at)) {
                continue;
            }
            const r = Math.max(radius * scale, 1.5);
            const px = at[0]!;
            const py = at[1]!;
            if (px < -r || py < -r || px > view.width + r || py > view.height + r) {
                continue;
            }
            ctx.moveTo(px + r, py);
            ctx.arc(px, py, r, 0, Math.PI * 2);
            drawn = true;
        }
        if (drawn) {
            ctx.fill();
        }
    }

    /**
     * Fills closed board shapes, even-odd so holes stay holes, in the fill
     * style of the moment; a path with a point behind the eye is left out,
     * and so is one wholly off the canvas, which encloses nothing on it. A
     * fill closes each shape itself: `closePath` would cost Chromium a walk
     * of the whole path so far per shape, a tenth of a second for a board's
     * few thousand pads.
     */
    private fillPaths(ctx: Context2D, view: Projector, paths: readonly Path[]): void {
        ctx.beginPath();
        let drawn = false;
        for (const path of paths) {
            const n = path.length;
            if (n < 3 || projectLine(view, path, 1) !== "whole") {
                continue;
            }
            let lastX = lineXY[0]!;
            let lastY = lineXY[1]!;
            ctx.moveTo(lastX, lastY);
            for (let i = 1; i < n; i++) {
                const x = lineXY[2 * i]!;
                const y = lineXY[2 * i + 1]!;
                if (i < n - 1 && Math.abs(x - lastX) < this.detail && Math.abs(y - lastY) < this.detail) {
                    continue;
                }
                ctx.lineTo(x, y);
                lastX = x;
                lastY = y;
            }
            drawn = true;
        }
        if (drawn) {
            ctx.fill("evenodd");
        }
    }
}
