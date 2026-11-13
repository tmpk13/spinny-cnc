// How the preview draws a large job fast: points projected without
// allocating, lines a batch at a time, detail under half a pixel and
// lines off the canvas left out, a translucent batch laid on from a
// scratch layer, and a coarser picture while a drag moves the view.

import { describe, expect, test } from "bun:test";

import { type Camera, Projector, frameOf, project } from "../src/camera.ts";
import { COARSE_POINTS, Preview, SETTLE_MS } from "../src/preview.ts";
import { BATCH_POINTS, DETAIL_PX, Pen } from "../src/render/canvas2d.ts";
import type { Job, Path } from "../src/types.ts";

const W = 400;
const H = 300;
const topDown: Camera = { target: [0, 0, 0], distance: 100, yaw: 0, pitch: 90 };

interface Call {
    name: string;
    args: unknown[];
}

/** A 2D context that keeps every call and every property set, in order. */
function recordingContext(): { ctx: CanvasRenderingContext2D; calls: Call[]; sets: Call[] } {
    const calls: Call[] = [];
    const sets: Call[] = [];
    const ctx = new Proxy({}, {
        get(_target, name) {
            if (typeof name !== "string") {
                return undefined;
            }
            if (name === "measureText") {
                return () => ({ width: 10 });
            }
            return (...args: unknown[]): void => {
                calls.push({ name, args });
            };
        },
        set(_target, name, value) {
            sets.push({ name: String(name), args: [value] });
            return true;
        },
    }) as unknown as CanvasRenderingContext2D;
    return { ctx, calls, sets };
}

const count = (calls: Call[], name: string): number => calls.filter((call) => call.name === name).length;

function job(groups: Job["groups"], copper: Path[] = []): Job {
    return {
        id: "big",
        name: "big",
        source: "json",
        spot: 0.1,
        offset: { x: 0, y: 0 },
        groups,
        outline: [],
        copper,
        stats: { length_mm: 0, seconds: 0, max_radius: 0, min_radius: 0, limited_fraction: 0, moves: 0 },
    };
}

describe("the projector", () => {
    test("puts a point where project does, and nothing behind the eye", () => {
        const cameras: Camera[] = [topDown, { target: [2, -3, 0], distance: 80, yaw: 30, pitch: 55 }, { target: [0, 0, 0], distance: 3, yaw: 200, pitch: 5 }];
        const out = new Float64Array(4);
        for (const camera of cameras) {
            const frame = frameOf(camera);
            const view = new Projector(frame, W, H);
            for (const point of [[0, 0, 0], [7, -2, 0], [-40, 90, 0], [3, 4, 2.5], [0, -500, 0]] as [number, number, number][]) {
                const expected = project(frame, W, H, point);
                const ok = view.into(point[0], point[1], point[2], out, 2);
                expect(ok).toBe(expected !== null);
                if (expected) {
                    expect(out[2]).toBeCloseTo(expected.x, 6);
                    expect(out[3]).toBeCloseTo(expected.y, 6);
                }
            }
        }
    });
});

describe("the pen", () => {
    const view = new Projector(frameOf(topDown), W, H);

    test("leaves out the points under half a pixel from the last one kept, never a line's last", () => {
        const { ctx, calls } = recordingContext();
        const pen = new Pen(ctx, view, 1, DETAIL_PX);
        // 2001 points a hundredth of a millimeter apart: 20 mm, about 80 px.
        const dense: Path = Array.from({ length: 2001 }, (_, i) => [-10 + i * 0.01, 0]);
        pen.line(dense);
        pen.end();
        const lines = calls.filter((call) => call.name === "lineTo");
        expect(lines.length).toBeGreaterThan(80 / (2 * DETAIL_PX));
        expect(lines.length).toBeLessThan(80 / DETAIL_PX + 2);
        // The line ends where it does.
        const end = project(frameOf(topDown), W, H, [10, 0, 0])!;
        expect(lines.at(-1)!.args[0]).toBeCloseTo(end.x, 9);
        // No two points kept are nearer than the detail, the last aside.
        for (let i = 1; i < lines.length - 1; i++) {
            const [ax] = lines[i - 1]!.args as number[];
            const [bx] = lines[i]!.args as number[];
            expect(Math.abs(bx! - ax!)).toBeGreaterThanOrEqual(DETAIL_PX);
        }
    });

    test("strokes a batch at a time, a line split between two going on from where it stopped", () => {
        const { ctx, calls } = recordingContext();
        const pen = new Pen(ctx, view, 1, DETAIL_PX);
        // 300 strokes of two points far enough apart to keep both.
        for (let i = 0; i < 300; i++) {
            pen.line([[-30, -20 + i * 0.1], [30, -20 + i * 0.1]]);
        }
        pen.end();
        expect(count(calls, "stroke")).toBe(Math.ceil(600 / BATCH_POINTS));
        // A long line over the batch size goes on after each stroke from its last point.
        const { ctx: other, calls: long } = recordingContext();
        const second = new Pen(other, view, 1, DETAIL_PX);
        second.line(Array.from({ length: 400 }, (_, i) => [-30 + i * 0.15, (i % 2) * 2]));
        second.end();
        expect(count(long, "stroke")).toBe(Math.ceil(400 / (BATCH_POINTS - 1)));
        const resumed = long.findIndex((call, index) => call.name === "beginPath" && index > 0);
        const before = long.slice(0, resumed).filter((call) => call.name === "lineTo").at(-1)!;
        expect(long[resumed + 1]).toEqual({ name: "moveTo", args: before.args });
    });

    test("skips a line off the canvas, lifts the pen behind the eye, closes and dots", () => {
        const { ctx, calls } = recordingContext();
        const pen = new Pen(ctx, view, 1, DETAIL_PX);
        pen.line([[1000, 0], [1010, 5]]);
        expect(calls.filter((call) => call.name === "moveTo")).toEqual([]);
        // One point: a dot, the round cap of a stroke of no length.
        pen.line([[1, 2]]);
        const dot = calls.filter((call) => call.name !== "beginPath");
        expect(dot.map((call) => call.name)).toEqual(["moveTo", "lineTo"]);
        expect(dot[0]!.args).toEqual(dot[1]!.args);
        // Closed: back to the first point.
        calls.length = 0;
        pen.line([[0, 0], [5, 0], [5, 5]], true);
        expect(calls.at(-1)).toEqual({ name: "lineTo", args: calls[0]!.args });
        pen.end();
        // Seen from low down, points behind the eye break the line and it is not closed.
        const low = new Projector(frameOf({ target: [0, 0, 0], distance: 3, yaw: 0, pitch: 5 }), W, H);
        const { ctx: lowCtx, calls: lowCalls } = recordingContext();
        const lowPen = new Pen(lowCtx, low, 1, DETAIL_PX);
        lowPen.line([[0, 1], [0, 2], [0, -20], [1, 2], [1, 1]], true);
        lowPen.end();
        expect(count(lowCalls, "moveTo")).toBe(2);
        expect(count(lowCalls, "lineTo")).toBe(2);
    });
});

/**
 * A preview drawn in 2D on a canvas whose context records what is drawn
 * on it, as do the overlay laid over it and the 2D painter's layers (made
 * as they are needed, in the order under, over, scratch).
 */
function recordedPreview(): { preview: Preview; page: Call[]; overlay: Call[]; layers: Call[][]; layerSets: Call[][]; canvas: HTMLCanvasElement; restore: () => void } {
    const made: { calls: Call[]; sets: Call[] }[] = [];
    const create = document.createElement.bind(document);
    document.createElement = ((tag: string, options?: ElementCreationOptions) => {
        const node = create(tag, options);
        if (tag === "canvas") {
            const { ctx, calls, sets } = recordingContext();
            made.push({ calls, sets });
            (node as HTMLCanvasElement).getContext = ((type: string) => (type === "2d" ? ctx : null)) as unknown as HTMLCanvasElement["getContext"];
        }
        return node;
    }) as typeof document.createElement;
    const canvas = create("canvas");
    canvas.getBoundingClientRect = (() => ({ width: W, height: H, x: 0, y: 0, top: 0, left: 0, right: W, bottom: H, toJSON: () => ({}) })) as typeof canvas.getBoundingClientRect;
    const { ctx, calls } = recordingContext();
    canvas.getContext = ((type: string) => (type === "2d" ? ctx : null)) as unknown as typeof canvas.getContext;
    document.body.appendChild(canvas);
    const preview = new Preview(canvas);
    // The preview makes its overlay first; the layers follow as they are drawn.
    const [overlay] = made.splice(0, 1);
    const layers: Call[][] = [];
    const layerSets: Call[][] = [];
    const follow = (): void => {
        for (const { calls: layerCalls, sets } of made.splice(0)) {
            layers.push(layerCalls);
            layerSets.push(sets);
        }
    };
    const draw = preview.draw.bind(preview);
    preview.draw = () => {
        draw();
        follow();
    };
    return { preview, page: calls, overlay: overlay!.calls, layers, layerSets, canvas, restore: () => (document.createElement = create) };
}

describe("a large job", () => {
    test("fills its copper without closePath, and lays a translucent group of many batches on from the scratch layer", () => {
        const { preview, page, layers, canvas, restore } = recordedPreview();
        try {
            const pads: Path[] = Array.from({ length: 50 }, (_, i) => [[i, 0], [i + 0.5, 0], [i + 0.5, 0.5], [i, 0.5]]);
            const strokes: Path[] = Array.from({ length: 400 }, (_, i) => [[-20, -20 + i * 0.1], [20, -20 + i * 0.1]]);
            preview.setJob(job([{ label: "off", power: 1, min_power: 0, speed: 1, passes: 1, enabled: false, paths: strokes }], pads));
            preview.setCamera(topDown);
            preview.draw();
            const [under, over, scratch] = layers;
            expect(under).toBeDefined();
            expect(count(over!, "closePath")).toBe(0);
            expect(count(over!, "fill")).toBe(1);
            // The switched-off group, 800 points, is stroked opaque on the
            // scratch layer in batches and laid on once.
            expect(count(scratch!, "stroke")).toBe(Math.ceil(800 / BATCH_POINTS));
            expect(count(over!, "drawImage")).toBe(1);
            expect(count(page, "drawImage")).toBe(2);
            preview.dispose();
            canvas.remove();
        } finally {
            restore();
        }
    });

    test("a pointer move that leaves the view where it was asks for no draw", () => {
        const { preview, canvas, restore } = recordedPreview();
        try {
            preview.setCamera(topDown);
            let asked = 0;
            preview.requestDraw = () => {
                asked += 1;
            };
            preview.dragBy([100, 100], [100, 100], "pan");
            preview.dragBy([100, 100], [100, 100], "orbit");
            preview.zoomBy([100, 100], 1);
            expect(asked).toBe(0);
            preview.dragBy([100, 100], [120, 100], "pan");
            expect(asked).toBe(1);
            preview.dispose();
            canvas.remove();
        } finally {
            restore();
        }
    });

    test("is drawn with hairlines while a drag moves the view, and in full once it stands still", async () => {
        const { preview, layerSets, canvas, restore } = recordedPreview();
        try {
            // Over COARSE_POINTS points in strokes a spot of 0.1 mm wide,
            // under a pixel at this distance.
            const strokes: Path[] = Array.from({ length: COARSE_POINTS / 2 + 1 }, (_, i) => [[-20, -20 + i * 0.001], [20, -20 + i * 0.001]]);
            preview.setJob(job([{ label: "a", power: 1, min_power: 0, speed: 1, passes: 1, enabled: true, paths: strokes }]));
            preview.setCamera(topDown);
            // The group, translucent and of many batches, is stroked on the
            // scratch layer, the third canvas made.
            const widths = (): number[] => {
                const found = (layerSets[2] ?? []).filter((set) => set.name === "lineWidth").map((set) => set.args[0] as number);
                for (const list of layerSets) {
                    list.length = 0;
                }
                return found;
            };
            preview.draw();
            expect(widths()).toContain(1.2);
            preview.dragBy([100, 100], [110, 100], "pan");
            preview.draw();
            const moving = widths();
            expect(moving).toEqual([1]);
            // Still for SETTLE_MS, or two draws' time when that is longer.
            let settled: number[] = [];
            const started = performance.now();
            while (!settled.includes(1.2) && performance.now() - started < 3000) {
                await new Promise((resolve) => setTimeout(resolve, SETTLE_MS / 3));
                preview.draw();
                settled = widths();
            }
            expect(settled).toContain(1.2);
            expect(performance.now() - started).toBeGreaterThanOrEqual(SETTLE_MS - 1);
            preview.dispose();
            canvas.remove();
        } finally {
            restore();
        }
    });
});
