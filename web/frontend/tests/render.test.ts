// The preview's renderer apart from the page: the job packed for the
// drawing worker, the scene's list of things to draw, the WebGL painter's
// geometry, and the painter itself driven through a WebGL2 context that
// records what it is asked (the pictures are compared in Chromium by
// layout/render.ts).

import { describe, expect, test } from "bun:test";

import { Projector, frameOf, pxPerMm, type Camera } from "../src/camera.ts";
import { previewOptions } from "../src/preview.ts";
import type { PaintInput } from "../src/render/canvas2d.ts";
import { WorkerHost } from "../src/render/host.ts";
import { packJob, unpackJob } from "../src/render/pack.ts";
import { Renderer, blankState, hardwareGl } from "../src/render/renderer.ts";
import {
    type Item,
    type RenderJob,
    type RenderState,
    DEFAULT_COLORS,
    cutOrderOf,
    gridLayout,
    initialRenderState,
    jobReach,
    sceneOf,
    visibleBox,
} from "../src/render/scene.ts";
import { WebGLPainter, dotPoints, fanTriangles, linePoints, parseColor, texturePieces } from "../src/render/webgl.ts";
import type { Move } from "../src/types.ts";

const W = 400;
const H = 300;
const topDown: Camera = { target: [0, 0, 0], distance: 100, yaw: 0, pitch: 90 };

function renderJob(overrides: Partial<RenderJob> = {}): RenderJob {
    return {
        spot: 0.1,
        source: "json",
        groups: [
            { enabled: true, speed: 400, passes: 1, paths: [[[0, 0], [5, 0]], [[1, 1]], [[0, 2], [5, 2], [5, 4]]] },
            { enabled: false, speed: 400, passes: 1, paths: [[[0, -3], [4, -3]]] },
            { enabled: true, speed: 400, passes: 1, paths: [[[-2, 0]], [[-3, 0]]], areas: [0.5, 2] },
        ],
        outline: [[[-6, -6], [6, -6], [6, 6], [-6, 6], [-6, -6]]],
        copper: [[[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]]],
        ...overrides,
    };
}

function stateWith(patch: Partial<RenderState> = {}): RenderState {
    return { ...initialRenderState(topDown), width: W, height: H, colors: DEFAULT_COLORS, ...patch };
}

/** The scene for a state, as the renderer works it out for a frame. */
function sceneFor(state: RenderState): ReturnType<typeof sceneOf> {
    const scale = pxPerMm(state.camera, state.height);
    const reach = jobReach(state.job, 0);
    const extent = Math.max(reach * 1.5, 10);
    const layout = gridLayout(scale, visibleBox(state.camera, state.width, state.height, extent), !state.grid);
    return sceneOf({ state, scale, reach, extent, layout, speeds: null });
}

describe("a job packed for the worker", () => {
    test("comes back as it went, its points in typed arrays handed over", () => {
        const moves: Move[][] = [[[0, 0, 2, 0], [1, 0, -1, 1], [2, 0, -1, 1]]];
        const job: RenderJob = renderJob({
            groups: [
                ...renderJob().groups,
                { enabled: true, speed: 300, passes: 2, paths: [], moves },
                { enabled: true, speed: 300, passes: 1, paths: [[[1, 0], [0, 1]]], joints: [[[1, 0], [1, 90]]] },
            ],
        });
        const { packed, transfer } = packJob(job);
        expect(packed.groups[0]!.paths.coords).toBeInstanceOf(Float64Array);
        expect(transfer.length).toBeGreaterThan(job.groups.length);
        expect(unpackJob(packed)).toEqual(job);
    });

    test("keeps empty paths and lists", () => {
        const job = renderJob({ outline: [], copper: [[]], groups: [{ enabled: true, speed: 1, passes: 1, paths: [[], [[1, 2]]] }] });
        expect(unpackJob(packJob(job).packed)).toEqual(job);
    });
});

describe("the page's address", () => {
    test("asks for WebGL or 2D in the page, or leaves the defaults", () => {
        expect(previewOptions("?preview=gl")).toEqual({ place: "page", painter: "gl" });
        expect(previewOptions("?mock=1&preview=2d")).toEqual({ place: "page", painter: "2d" });
        expect(previewOptions("?preview=fast")).toEqual({});
        expect(previewOptions("")).toEqual({});
    });

    test("without WebGL2 there is no graphics card to draw with", () => {
        // The test DOM has no WebGL at all.
        expect(hardwareGl()).toBe(false);
    });
});

describe("the WebGL painter's geometry", () => {
    test("reads CSS colors", () => {
        expect(parseColor("#fff")).toEqual([1, 1, 1, 1]);
        expect(parseColor("#268bd2")).toEqual([0x26 / 255, 0x8b / 255, 0xd2 / 255, 1]);
        expect(parseColor("#00000080")[3]).toBeCloseTo(128 / 255, 9);
        expect(parseColor("rgb(255, 0, 0)")).toEqual([1, 0, 0, 1]);
        expect(parseColor("rgba(0 255 0 / 50%)")).toEqual([0, 1, 0, 0.5]);
        expect(parseColor("teal")).toEqual([0.5, 0.5, 0.5, 1]);
    });

    test("lines become points with an id each, a dot written twice", () => {
        const points = linePoints([[[[0, 0], [1, 0]], 7], [[[2, 3]], 8], [[[4, 4, -1], [5, 5, -2]], 9]]);
        expect(points.points).toBe(6);
        expect(Array.from(points.data.slice(0, 8))).toEqual([0, 0, 0, 7, 1, 0, 0, 7]);
        // The dot: its point twice, a segment of no length.
        expect(Array.from(points.data.slice(8, 16))).toEqual([2, 3, 0, 8, 2, 3, 0, 8]);
        expect(points.data[18]).toBe(-1);
        expect(Array.from(points.box)).toEqual([0, 0, -2, 5, 5, 0]);
    });

    test("a group's dots carry their pad's radius and their path's id", () => {
        const dots = dotPoints({ enabled: true, speed: 1, passes: 1, paths: [[[0, 0], [1, 0]], [[3, 4]], [[5, 6]]], areas: [0, Math.PI, 0] }, 0.2, (p) => 10 + p);
        expect(dots.points).toBe(2);
        // Path 1's area is pi: radius 1. Path 2's area is none: half the spot.
        expect(Array.from(dots.data)).toEqual([3, 4, 1, 11, 5, 6, Math.fround(0.1), 12]);
        expect(dots.widest).toBe(1);
    });

    test("copper is fanned from each shape's first point", () => {
        const fan = fanTriangles([[[0, 0], [1, 0], [1, 1], [0, 1]], [[5, 5], [6, 5]], [[2, 2], [3, 2], [3, 3]]]);
        expect(Array.from(fan.indices)).toEqual([0, 1, 2, 0, 2, 3, 4, 5, 6]);
        expect(fan.points.length).toBe(14);
        expect(Array.from(fan.box)).toEqual([0, 0, 0, 3, 3, 0]);
    });

    test("points too many for one texture go into several, a line's pieces overlapping by one", () => {
        expect(texturePieces(10, 4, true)).toEqual([{ start: 0, count: 10 }]);
        const room = 2048 * 2;
        expect(texturePieces(room + 5, 2, true)).toEqual([{ start: 0, count: room }, { start: room - 1, count: 6 }]);
        expect(texturePieces(room + 5, 2, false)).toEqual([{ start: 0, count: room }, { start: room, count: 5 }]);
        expect(texturePieces(0, 2, true)).toEqual([]);
    });
});

describe("the scene", () => {
    const kinds = (items: Item[]): string[] => items.map((item) => item.kind === "lines" ? `lines ${item.source.kind}` : item.kind);

    test("lists the job over the rail: limits, copper, groups, outline, then the axis", () => {
        const scene = sceneFor(stateWith({ job: renderJob(), limits: { kinematics: "polar", r_max: 20, z_max: 0 } }));
        expect(kinds(scene.rail)).toEqual(["polylines", "polylines"]);
        expect(kinds(scene.work)).toEqual([
            "polylines", "copper",
            "lines paths", "dots", "lines paths", "dots", "lines paths", "dots",
            "lines outline", "polylines",
        ]);
        expect(scene.board.length).toBeGreaterThan(0);
        expect(scene.exaggeration).toBeNull();
    });

    test("scrubbed, a group that is on is split by its place in the cut order, one that is off is faint", () => {
        const job = renderJob();
        expect(cutOrderOf(job).order).toEqual([[0, 0], [0, 1], [0, 2], [2, 0], [2, 1]]);
        expect(cutOrderOf(job).start).toEqual([0, -1, 3]);
        const scene = sceneFor(stateWith({ job, scrub: 2 }));
        // Group 0's lines and dots: their filter and alpha.
        const first = scene.work.flatMap((item) => {
            if (item.kind === "lines" && item.source.kind === "paths" && item.source.group === 0) {
                return [[item.source.filter, item.ink.alpha]];
            }
            return item.kind === "dots" && item.group === 0 ? [[item.filter, item.alpha]] : [];
        });
        expect(first).toEqual([
            [{ kind: "from", at: 2 }, 0.12],
            [{ kind: "before", at: 2 }, 0.9],
            [{ kind: "from", at: 2 }, 0.12],
            [{ kind: "before", at: 2 }, 0.9],
        ]);
        const off = scene.work.filter((item) => item.kind === "lines" && item.source.kind === "paths" && item.source.group === 1);
        expect(off.map((item) => item.kind === "lines" && [item.source.kind === "paths" && item.source.filter.kind, item.ink.alpha])).toEqual([["all", 0.12]]);
        // The last path cut so far is marked: path 1 of group 0, a dot.
        expect(scene.work.some((item) => item.kind === "circles" && item.alpha === 0.5)).toBe(true);
    });

    test("a model's group is drawn by its runs, and its outline thin", () => {
        const moves: Move[][] = [[[0, 0, 1, 0], [1, 0, -1, 1], [2, 0, -1, 1]]];
        const scene = sceneFor(stateWith({ job: renderJob({ groups: [{ enabled: true, speed: 1, passes: 1, paths: [], moves }] }) }));
        const runs = scene.work.find((item) => item.kind === "lines" && item.source.kind === "runs");
        expect(runs?.kind === "lines" && runs.ink.width).toBe(1);
        const outline = scene.work.find((item) => item.kind === "lines" && item.source.kind === "outline");
        expect(outline?.kind === "lines" && outline.ink.width).toBe(1);
    });

    test("picked paths are haloed under the groups, the JSON panel's place drawn over them", () => {
        const scene = sceneFor(stateWith({ job: renderJob(), selection: [[0, 2]], highlight: { list: "groups", group: 0, path: 2, point: 1 } }));
        const order = kinds(scene.work);
        expect(order.indexOf("lines picked")).toBeLessThan(order.indexOf("lines paths"));
        const tail = order.slice(order.indexOf("lines outline") + 1);
        expect(tail).toEqual(["polylines", "polylines", "circles", "polylines"]);
    });

    test("probed heights are raised as a mesh and named in the notes' stretch", () => {
        const map = {
            grid: { x0: -5, y0: -5, x1: 5, y1: 5, nx: 3, ny: 2 },
            heights: [[-0.05, 0, 0.05], [null, 0.02, 0.1]],
            focus_offset: 0,
            focus_set: false,
            probe_offset: [0, 0] as [number, number],
            created: "",
        };
        const scene = sceneFor(stateWith({ probeMap: map }));
        expect(scene.exaggeration).toBeGreaterThan(1);
        const circles = scene.work.find((item) => item.kind === "circles");
        // Five probed, one not: stroked.
        expect(circles?.kind === "circles" && circles.circles.filter((circle) => circle.stroke !== undefined).length).toBe(1);
        expect(sceneFor(stateWith({ probeMap: map, heights: false })).exaggeration).toBeNull();
    });
});

interface GlCall {
    name: string;
    args: unknown[];
}

/** A WebGL2 context that answers as a working one and records every call. */
function recordingGl(): { gl: WebGL2RenderingContext; calls: GlCall[] } {
    const calls: GlCall[] = [];
    const constants: Record<string, number> = {};
    let next = 0x1000;
    const gl = new Proxy({}, {
        get(_target, name) {
            if (typeof name !== "string") {
                return undefined;
            }
            if (/^[A-Z][A-Z0-9_]*$/.test(name)) {
                constants[name] ??= next++;
                return constants[name];
            }
            if (name === "drawingBufferWidth") {
                return W;
            }
            if (name === "drawingBufferHeight") {
                return H;
            }
            return (...args: unknown[]): unknown => {
                calls.push({ name, args });
                if (name.startsWith("create")) {
                    return { made: name };
                }
                if (name === "getShaderParameter" || name === "getProgramParameter") {
                    return true;
                }
                if (name === "getParameter") {
                    return 4096;
                }
                if (name === "isContextLost") {
                    return false;
                }
                if (name === "getUniformLocation") {
                    return { uniform: args[1] };
                }
                return null;
            };
        },
    }) as unknown as WebGL2RenderingContext;
    return { gl, calls };
}

/** Each draw's vertex count and the first point of the texture bound for it (null for a texture given no points). */
function drawnFrom(calls: GlCall[]): { count: number; first: [number, number] | null }[] {
    let bound: unknown = null;
    const points = new Map<unknown, Float32Array>();
    const draws: { count: number; first: [number, number] | null }[] = [];
    for (const call of calls) {
        if (call.name === "bindTexture") {
            bound = call.args[1];
        } else if (call.name === "texImage2D" && call.args[8] instanceof Float32Array) {
            points.set(bound, call.args[8]);
        } else if (call.name === "drawArrays") {
            const data = points.get(bound);
            draws.push({ count: call.args[2] as number, first: data ? [data[0]!, data[1]!] : null });
        }
    }
    return draws;
}

function paintInput(state: RenderState): PaintInput {
    const scale = pxPerMm(state.camera, state.height);
    const reach = jobReach(state.job, 0);
    const extent = Math.max(reach * 1.5, 10);
    const layout = gridLayout(scale, visibleBox(state.camera, state.width, state.height, extent), !state.grid);
    return {
        scene: sceneOf({ state, scale, reach, extent, layout, speeds: null }),
        state,
        view: new Projector(frameOf(state.camera), state.width, state.height),
        scale,
        speeds: null,
        still: true,
    };
}

describe("the WebGL painter", () => {
    const canvas = { addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as HTMLCanvasElement;

    test("draws each set of the job with one draw from its texture, copper through the stencil", () => {
        const { gl, calls } = recordingGl();
        const painter = new WebGLPainter(gl, canvas, () => undefined);
        const job = renderJob();
        painter.paint(paintInput(stateWith({ job })));
        const draws = calls.filter((call) => call.name === "drawArrays").map((call) => call.args[2]);
        // Group 0's two lines, five points: four segments of six vertices.
        // (The dot between them is in the dots.) Group 2's two dots: twelve.
        expect(draws).toContain(6 * 4);
        expect(draws).toContain(6 * 2);
        // The outline's five points, from the texture holding them: group
        // 0's lines take as many vertices, so the count alone tells nothing.
        expect(drawnFrom(calls)).toContainEqual({ count: 6 * 4, first: [-6, -6] });
        expect(drawnFrom(calls)).toContainEqual({ count: 6 * 4, first: [0, 0] });
        expect(calls.some((call) => call.name === "drawElements")).toBe(true);
        expect(calls.some((call) => call.name === "stencilOp")).toBe(true);
        // Translucent groups go through the layer.
        expect(calls.filter((call) => call.name === "blendEquation").length).toBeGreaterThan(1);
        expect(calls.some((call) => call.name === "drawArraysInstanced")).toBe(false);
        // The job's geometry is made once: the next frame sends no points.
        const uploads = calls.filter((call) => call.name === "texImage2D").length;
        calls.length = 0;
        painter.paint(paintInput(stateWith({ job, camera: { ...topDown, distance: 50 } })));
        const again = calls.filter((call) => call.name === "texImage2D").length;
        expect(again).toBeLessThan(uploads);
        // A new job lets the old one's textures go.
        calls.length = 0;
        painter.paint(paintInput(stateWith({ job: renderJob() })));
        expect(calls.some((call) => call.name === "deleteTexture")).toBe(true);
        painter.dispose();
    });

    test("filters a group by the cut order on the card, its ids being the paths' places", () => {
        const { gl, calls } = recordingGl();
        const painter = new WebGLPainter(gl, canvas, () => undefined);
        painter.paint(paintInput(stateWith({ job: renderJob(), scrub: 2 })));
        const filters = calls.filter((call) => call.name === "uniform1i" && (call.args[0] as { uniform: string }).uniform === "uFilter").map((call) => call.args[1]);
        expect(filters).toContain(1);
        expect(filters).toContain(2);
        painter.dispose();
    });
});

/** A scene canvas that gives the context it is handed and fires the events a test names. */
function glCanvas(gl: WebGL2RenderingContext): { canvas: HTMLCanvasElement; fire: (type: string) => void } {
    const listeners = new Map<string, ((event: Event) => void)[]>();
    const canvas = {
        width: 0,
        height: 0,
        getContext: (kind: string) => (kind === "webgl2" ? gl : null),
        addEventListener: (type: string, listener: (event: Event) => void) => {
            listeners.set(type, [...(listeners.get(type) ?? []), listener]);
        },
        removeEventListener: (type: string, listener: (event: Event) => void) => {
            listeners.set(type, (listeners.get(type) ?? []).filter((kept) => kept !== listener));
        },
    } as unknown as HTMLCanvasElement;
    const fire = (type: string): void => {
        for (const listener of listeners.get(type) ?? []) {
            listener({ preventDefault: () => undefined } as unknown as Event);
        }
    };
    return { canvas, fire };
}

describe("the renderer", () => {
    const overlay = { width: 0, height: 0, getContext: () => null } as unknown as HTMLCanvasElement;

    test("draws the scene again when a lost WebGL context comes back, blank as it comes", () => {
        const { gl, calls } = recordingGl();
        const { canvas, fire } = glCanvas(gl);
        let asked = 0;
        const renderer = new Renderer(canvas, overlay, { painter: "gl", layer: () => null, invalidate: () => { asked += 1; } }, stateWith({ job: renderJob() }));
        expect(renderer.kind).toBe("gl");
        renderer.frame();
        expect(calls.some((call) => call.name === "drawArrays")).toBe(true);
        fire("webglcontextlost");
        fire("webglcontextrestored");
        expect(asked).toBe(1);
        calls.length = 0;
        renderer.frame();
        expect(calls.some((call) => call.name === "clear")).toBe(true);
        expect(calls.some((call) => call.name === "drawArrays")).toBe(true);
        renderer.dispose();
    });
});

/** A worker that takes what it is sent and answers nothing until the test answers for it. */
class SilentWorker {
    static made: SilentWorker[] = [];
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    posted: unknown[] = [];
    terminated = false;

    constructor() {
        SilentWorker.made.push(this);
    }

    postMessage(message: unknown): void {
        this.posted.push(message);
    }

    terminate(): void {
        this.terminated = true;
    }
}

/** How a promise stands after a few tasks: settled either way, or still pending. */
async function standing(promise: Promise<unknown>): Promise<"resolved" | "rejected" | "pending"> {
    return Promise.race([
        promise.then(() => "resolved" as const, () => "rejected" as const),
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 20)),
    ]);
}

describe("the drawing worker's host", () => {
    test("a picture asked for before the worker draws, or when it fails, is refused rather than left waiting", async () => {
        const real = globalThis.Worker;
        globalThis.Worker = SilentWorker as unknown as typeof Worker;
        try {
            const canvas = (): HTMLCanvasElement => ({ transferControlToOffscreen: () => ({}) }) as unknown as HTMLCanvasElement;
            const failed: boolean[] = [];
            const host = new WorkerHost(canvas(), canvas(), blankState(), "auto", { drawn: () => undefined, failed: (started) => failed.push(started) });
            const worker = SilentWorker.made.at(-1)!;
            // Not ready yet: the worker has no renderer, and drops the ask.
            expect(await standing(host.snapshot())).toBe("rejected");
            // Ready and started: an ask that is under way when the worker fails.
            worker.onmessage?.({ data: { kind: "ready" } } as MessageEvent);
            const asked = host.snapshot();
            worker.onerror?.({ message: "gone", preventDefault: () => undefined } as unknown as ErrorEvent);
            expect(failed).toEqual([true]);
            expect(await standing(asked)).toBe("rejected");
            host.dispose();
        } finally {
            globalThis.Worker = real;
        }
    });
});

describe("a picked pad", () => {
    test("is haloed round its dot as drawn, however wide the pad is", () => {
        // Close in: group 2's second pad (2 mm2) is a dot 16 px in radius.
        const camera: Camera = { ...topDown, distance: 20 };
        const state = stateWith({ job: renderJob(), camera, selection: [[2, 1]] });
        const scale = pxPerMm(camera, H);
        const dot = Math.sqrt(2 / Math.PI) * scale;
        expect(dot).toBeGreaterThan(15);
        // How far out of the pad's middle the halo reaches, px: the picked
        // lines' half width, or a ring in the selection's color.
        let reach = 0;
        for (const item of sceneFor(state).work) {
            if (item.kind === "lines" && item.source.kind === "picked") {
                reach = Math.max(reach, item.ink.width / 2);
            } else if (item.kind === "circles") {
                for (const circle of item.circles) {
                    if (circle.color === DEFAULT_COLORS.select && circle.at[0] === -3 && circle.at[1] === 0) {
                        reach = Math.max(reach, circle.radius);
                    }
                }
            }
        }
        // A line's halo stands 3.5 px out of either side of it; a dot's
        // out of its edge as far, or the dot over it hides it.
        expect(reach).toBeGreaterThanOrEqual(dot + 3.5 - 1e-9);
    });
});
