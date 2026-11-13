// The renderer: keeps the state a picture is drawn from and draws frames
// of it, the scene with the WebGL painter (or the 2D one where WebGL2
// cannot be had) and the overlay over it. It runs in the page, or in the
// drawing worker (worker.ts) on canvases the page handed over; the preview
// (preview.ts) only sends it what changed.
//
// The scene canvas is drawn again only when something it shows changed;
// the overlay, whose head and trail move many times a second, every frame.

import { Projector, frameOf, pxPerMm } from "../camera.ts";
import { speedMap, type SpeedLimits, type SpeedMap } from "../speed.ts";
import { type AnyCanvas, Canvas2DPainter, type Context2D, context2d } from "./canvas2d.ts";
import { drawOverlay } from "./overlay.ts";
import { type RenderJob, type RenderState, gridLayout, initialRenderState, jobReach, limitReach, sceneOf, visibleBox } from "./scene.ts";
import { GL_ATTRIBUTES, WebGLPainter } from "./webgl.ts";

export type PainterKind = "gl" | "2d";

/**
 * Which painter draws: WebGL2 where a graphics card runs it ("auto"; where
 * only a software renderer would, the 2D painter, which draws a large job
 * many times faster there), WebGL2 even in software ("gl"), or the 2D
 * context ("2d").
 */
export type PainterChoice = "auto" | "gl" | "2d";

export interface RendererOptions {
    painter: PainterChoice;
    /** An offscreen canvas for the 2D painter's layers; null where none can be had. */
    layer: () => AnyCanvas | null;
    /** Asks for a frame, as when a lost WebGL context comes back. */
    invalidate: () => void;
}

/** A picture as RGBA bytes, top row first. */
export interface Snapshot {
    width: number;
    height: number;
    pixels: Uint8ClampedArray;
}

/** What the still scene is drawn from: a change in any of it draws the scene canvas again. */
const STILL_KEYS: ReadonlySet<keyof RenderState> = new Set<keyof RenderState>([
    "width", "height", "dpr", "camera", "colors", "job", "limits", "probeMap", "probeDraft", "heights", "grid",
    "markers", "speed", "speedLimits", "scrub", "selection", "highlight", "coarse",
]);

export class Renderer {
    readonly kind: PainterKind;
    private readonly state: RenderState;
    private readonly painter: WebGLPainter | Canvas2DPainter | null;
    /** The 2D painter draws the scene on the overlay canvas, the scene canvas having taken a WebGL context it could not use. */
    private readonly single: boolean;
    private readonly overlay: Context2D | null;
    /** Something the still scene shows changed, or the rail moved, since the scene canvas was drawn. */
    private still = true;
    private rail = true;
    /** The table angle the still scene was drawn at: a cartesian machine's limits turn with it. */
    private angle = 0;
    private exaggeration: number | null = null;
    private reachMemo: { job: RenderJob | null; limit: number; reach: number } | null = null;
    private speedMemo: { job: RenderJob; limits: SpeedLimits; map: SpeedMap } | null = null;

    constructor(private readonly scene: AnyCanvas, private readonly overlayCanvas: AnyCanvas, options: RendererOptions, initial: RenderState) {
        this.state = { ...initial };
        let painter: WebGLPainter | Canvas2DPainter | null = null;
        let single = false;
        if (options.painter === "gl" || (options.painter === "auto" && hardwareGl())) {
            let gl: WebGL2RenderingContext | null = null;
            try {
                const attributes = { ...GL_ATTRIBUTES, failIfMajorPerformanceCaveat: options.painter === "auto" };
                gl = (scene as OffscreenCanvas).getContext("webgl2", attributes) as WebGL2RenderingContext | null;
            } catch {
                gl = null;
            }
            if (gl !== null) {
                try {
                    painter = new WebGLPainter(gl, scene, options.invalidate);
                } catch (error) {
                    console.warn(`preview: WebGL2 is there but cannot draw, drawing in 2D: ${String(error)}`);
                    single = true;
                }
            }
        }
        this.overlay = context2d(overlayCanvas);
        if (painter === null) {
            const target = single ? this.overlay : context2d(scene);
            painter = target !== null ? new Canvas2DPainter(target, options.layer) : null;
        }
        this.painter = painter;
        this.single = single;
        this.kind = painter?.kind ?? "2d";
        this.resize();
    }

    /** Takes what changed; the next frame draws it. */
    update(patch: Partial<RenderState>): void {
        const sized = (patch.width !== undefined && patch.width !== this.state.width)
            || (patch.height !== undefined && patch.height !== this.state.height)
            || (patch.dpr !== undefined && patch.dpr !== this.state.dpr);
        Object.assign(this.state, patch);
        for (const key of Object.keys(patch) as (keyof RenderState)[]) {
            if (STILL_KEYS.has(key)) {
                this.still = true;
            }
        }
        // On a cartesian machine the rail runs through the head and the
        // limit box turns with the table.
        if (("head" in patch || "headBoard" in patch) && this.state.limits.kinematics === "cartesian") {
            this.rail = true;
            if ((this.state.head?.a ?? 0) !== this.angle) {
                this.still = true;
            }
        }
        if (sized) {
            this.resize();
        }
    }

    /** Draws a frame: the scene when it changed, the overlay always. Returns how long it took, ms. */
    frame(): number {
        const started = now();
        const s = this.state;
        if (!(s.width > 0 && s.height > 0)) {
            return 0;
        }
        const frame = frameOf(s.camera);
        const view = new Projector(frame, s.width, s.height);
        const scale = pxPerMm(s.camera, s.height);
        const reach = this.reach();
        const extent = Math.max(reach * 1.5, 10);
        // The grid's or the rings' step follows the zoom, over the part of
        // the board in view.
        const layout = gridLayout(scale, visibleBox(s.camera, s.width, s.height, extent), !s.grid);
        const speeds = s.speed ? this.speeds() : null;
        if ((this.still || this.rail || this.single) && this.painter !== null) {
            const scene = sceneOf({ state: s, scale, reach, extent, layout, speeds });
            this.exaggeration = scene.exaggeration;
            this.painter.paint({ scene, state: s, view, scale, speeds, still: this.still });
            this.angle = s.head?.a ?? 0;
            this.still = false;
            this.rail = false;
        }
        const ctx = this.overlay;
        if (ctx !== null) {
            if (!this.single) {
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
            }
            ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
            ctx.globalAlpha = 1;
            ctx.setLineDash([]);
            drawOverlay(ctx, { state: s, frame, scale, reach, layout, exaggeration: this.exaggeration, speeds });
        }
        return now() - started;
    }

    /** A frame drawn in full and read back, the overlay laid over the scene. */
    snapshot(): Snapshot {
        this.still = true;
        this.frame();
        const width = this.overlayCanvas.width;
        const height = this.overlayCanvas.height;
        let base: Uint8ClampedArray;
        if (this.painter instanceof WebGLPainter) {
            base = this.painter.readPixels().pixels;
        } else if (this.single || this.painter === null) {
            base = new Uint8ClampedArray(width * height * 4);
        } else {
            base = context2d(this.scene)?.getImageData(0, 0, width, height).data ?? new Uint8ClampedArray(width * height * 4);
        }
        const over = this.overlay?.getImageData(0, 0, width, height).data;
        const pixels = new Uint8ClampedArray(width * height * 4);
        for (let i = 0; i < pixels.length; i += 4) {
            const a = (over?.[i + 3] ?? 0) / 255;
            for (let c = 0; c < 3; c++) {
                pixels[i + c] = (over?.[i + c] ?? 0) * a + (base[i + c] ?? 0) * (1 - a);
            }
            pixels[i + 3] = Math.max(base[i + 3] ?? 0, over?.[i + 3] ?? 0);
        }
        return { width, height, pixels };
    }

    /** The job's speeds for the rates set, worked out once a job and rates. */
    speeds(): SpeedMap | null {
        const { job, speedLimits } = this.state;
        if (job === null || speedLimits === null) {
            return null;
        }
        const kept = this.speedMemo;
        if (kept && kept.job === job && kept.limits === speedLimits) {
            return kept.map;
        }
        const map = speedMap(job, speedLimits);
        this.speedMemo = { job, limits: speedLimits, map };
        return map;
    }

    dispose(): void {
        this.painter?.dispose();
    }

    /** Sizes both canvases' pixels to the canvas, device px; setting a size wipes a canvas, so the scene is drawn again. */
    private resize(): void {
        const width = Math.max(1, Math.round(this.state.width * this.state.dpr));
        const height = Math.max(1, Math.round(this.state.height * this.state.dpr));
        for (const canvas of [this.scene, this.overlayCanvas]) {
            if (canvas.width !== width || canvas.height !== height) {
                canvas.width = width;
                canvas.height = height;
            }
        }
        this.still = true;
    }

    /** The farthest thing drawn, as `jobReach` has it, worked out once per job and limit rather than per frame. */
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
}

/** The renderer names of the software rasterizers a browser falls back to without a graphics card. */
const SOFTWARE_GL = /swiftshader|llvmpipe|softpipe|software|basic render/i;

/**
 * Whether WebGL2 here runs on a graphics card, asked of a throwaway canvas
 * so the scene canvas stays free for the 2D context: the browser gives a
 * context that need not fear a major performance caveat, and its renderer
 * names no software rasterizer (Chromium's SwiftShader does not always own
 * up to the caveat).
 */
export function hardwareGl(): boolean {
    if (typeof WebGL2RenderingContext === "undefined") {
        return false;
    }
    try {
        const probe = typeof OffscreenCanvas === "function" ? new OffscreenCanvas(1, 1) : document.createElement("canvas");
        const gl = (probe as OffscreenCanvas).getContext("webgl2", { failIfMajorPerformanceCaveat: true }) as WebGL2RenderingContext | null;
        if (gl === null) {
            return false;
        }
        const info = gl.getExtension("WEBGL_debug_renderer_info");
        const name = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
        gl.getExtension("WEBGL_lose_context")?.loseContext();
        return !SOFTWARE_GL.test(name);
    } catch {
        return false;
    }
}

/** A fresh state for a renderer that has been sent nothing yet. */
export function blankState(): RenderState {
    return initialRenderState({ target: [0, 0, 0], distance: 100, yaw: 0, pitch: 60 });
}

/** A clock in ms, for how long a draw takes. */
export function now(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
}
