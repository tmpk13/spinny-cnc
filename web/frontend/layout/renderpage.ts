// The render check's page (render.html): four previews of one scene, drawn
// with the 2D context in the page, with WebGL2 in the page, with WebGL2 in
// the drawing worker and with the 2D context there, so the check
// (render.ts) can compare their pictures and time them. Everything it needs
// is on `window.renderCheck`.

import type { Camera } from "../src/camera.ts";
import { Preview, type PreviewOptions } from "../src/preview.ts";
import type { Group, HeightMap, Job, Path, Point } from "../src/types.ts";

const STATS = { length_mm: 0, seconds: 0, max_radius: 0, min_radius: 0, limited_fraction: 0, moves: 0 };

function group(label: string, paths: Path[], extra: Partial<Group> = {}): Group {
    return { label, power: 500, min_power: 0, speed: 400, passes: 1, enabled: true, paths, ...extra };
}

function job(id: string, groups: Group[], outline: Path[], copper: Path[], spot = 0.1, source = "json"): Job {
    return { id, name: id, source, spot, offset: { x: 0, y: 0 }, groups, outline, copper, stats: STATS };
}

/** A closed polygon of `count` points round (x, y), radius r, as a pad or a loop is drawn. */
function ring(x: number, y: number, r: number, count: number): Path {
    const points: Path = [];
    for (let i = 0; i <= count; i++) {
        const angle = (i / count) * Math.PI * 2;
        points.push([x + r * Math.cos(angle), y + r * Math.sin(angle)]);
    }
    return points;
}

function rect(x0: number, y0: number, x1: number, y1: number): Path {
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
}

/** A small board: two groups of cuts, one off, dots of paste of several sizes, an outline and copper with a hole. */
function smallJob(): Job {
    const isolation: Path[] = [];
    const copper: Path[] = [];
    for (let i = 0; i < 6; i++) {
        const x = -12 + i * 5;
        copper.push(ring(x, 6, 1.4, 24));
        isolation.push(ring(x, 6, 1.6, 32), ring(x, 6, 1.8, 32));
    }
    copper.push(rect(-15, -12, 15, -2), rect(-4, -9, 4, -5));
    isolation.push(rect(-15.2, -12.2, 15.2, -1.8));
    const clearing: Path[] = [];
    for (let i = 0; i < 40; i++) {
        const y = -11.5 + i * 0.25;
        clearing.push([[-14.5, y], [14.5, y]]);
    }
    const dots: Path[] = [[[-10, 12]], [[-5, 12]], [[0, 12]], [[5, 12]], [[10, 12]]];
    return job("small", [
        group("isolation", isolation),
        group("clearing", clearing, { enabled: false }),
        group("paste", dots, { areas: [0.2, 0.8, 2, 4, 8] }),
        group("engraving", [[[-14, 16], [-8, 18], [-2, 16], [4, 18], [10, 16]]]),
    ], [rect(-18, -15, 18, 20)], copper, 0.12);
}

/**
 * A large board like the one the 2D painter was tuned on: 3,700 pads of
 * copper with two isolation loops round each, 20,000 clearing strokes,
 * 800 drills, about 400,000 points in all.
 */
function bigJob(): Job {
    const copper: Path[] = [];
    const isolation: Path[] = [];
    const drills: Path[] = [];
    let n = 0;
    for (let iy = 0; iy < 50 && n < 3700; iy++) {
        for (let ix = 0; ix < 74 && n < 3700; ix++, n++) {
            const x = -78 + ix * 2.15;
            const y = -48 + iy * 1.95;
            copper.push(ring(x, y, 0.6, 23));
            isolation.push(ring(x, y, 0.7, 31), ring(x, y, 0.8, 31));
            if (n % 5 === 0 && drills.length < 800) {
                drills.push([[x, y]]);
            }
        }
    }
    const clearing: Path[] = [];
    for (let i = 0; i < 20000; i++) {
        const angle = (i / 20000) * Math.PI * 2 * 37;
        const r = 20 + (i % 500) * 0.12;
        const step: Point = [Math.cos(angle) * 0.6, Math.sin(angle) * 0.6];
        const x = Math.cos(angle) * r * 1.4;
        const y = Math.sin(angle) * r * 0.8;
        clearing.push([[x, y], [x + step[0], y + step[1]], [x + 2 * step[0], y + 2 * step[1]], [x + 3 * step[0], y + 3 * step[1]]]);
    }
    return job("big", [
        group("isolation", isolation),
        group("clearing", clearing),
        group("drills", drills),
    ], [rect(-80, -50, 80, 50)], copper, 0.1);
}

/** A model's toolpaths: rows across a dome, cut at their depth under the board. */
function modelJob(): Job {
    const moves: [number, number, number, 0 | 1 | 2][][] = [];
    for (let row = 0; row < 30; row++) {
        const y = -15 + row;
        const path: [number, number, number, 0 | 1 | 2][] = [[-15, y, 2, 0]];
        for (let i = 0; i <= 60; i++) {
            const x = -15 + i * 0.5;
            const z = -Math.max(0, 4 - (x * x + y * y) / 60);
            path.push([x, y, z, 1]);
        }
        moves.push(path);
    }
    return job("model", [group("rough", [], { moves })], [rect(-16, -16, 16, 16)], [], 0.1, "cam");
}

function heightMap(): HeightMap {
    const heights: (number | null)[][] = [];
    for (let iy = 0; iy < 5; iy++) {
        heights.push(Array.from({ length: 6 }, (_, ix) => (ix === 2 && iy === 3 ? null : 0.05 * Math.sin(ix) + 0.03 * iy)));
    }
    return { grid: { x0: -15, y0: -12, x1: 15, y1: 12, nx: 6, ny: 5 }, heights, focus_offset: 0, focus_set: false, probe_offset: [0, 0], created: "" };
}

const overviewAt = (distance: number, pitch = 60, yaw = 0): Camera => ({ target: [0, 0, 0], distance, yaw, pitch });

/** Every preview back to nothing shown, the view fitted. */
function reset(preview: Preview): void {
    preview.setSpeedView(false);
    preview.setScrub(null);
    preview.setSelection([]);
    preview.setHighlight(null);
    preview.setProbe(null, null);
    preview.setMarkers([]);
    preview.setEstimate([]);
    preview.setDimensions([]);
    preview.setShowGrid(false);
    preview.setShowHeights(true);
    preview.setLimits({ kinematics: "polar", r_max: 40, z_max: 0 });
    preview.clearTrail();
    preview.setHead(null);
}

/** Moves the head along a short arc, leaving a trail. */
function headAlong(preview: Preview, r: number, from: number, to: number): void {
    for (let a = from; a <= to; a += 3) {
        preview.setHead({ r, a });
    }
}

const small = smallJob();
const model = modelJob();
let big: Job | null = null;
const bigOnce = (): Job => (big ??= bigJob());

/** The scenes the check draws, by name. */
const SCENES: Record<string, (preview: Preview) => void> = {
    small: (preview) => {
        preview.setJob(small);
        headAlong(preview, 10, 30, 90);
        preview.setMarkers([{ name: "home", x: -16, y: 14 }, { name: "fid", x: 16, y: -13 }]);
        preview.setCamera(overviewAt(70));
    },
    picked: (preview) => {
        preview.setJob(small);
        preview.setSelection([[0, 2], [0, 3], [3, 0]]);
        preview.setHighlight({ list: "groups", group: 3, path: 0, point: 2 });
        preview.setCamera(overviewAt(55, 90));
    },
    scrubbed: (preview) => {
        preview.setJob(small);
        preview.setScrub(9);
        preview.setCamera(overviewAt(60, 75, 20));
    },
    speed: (preview) => {
        preview.setJob(small);
        preview.setSpeedLimits({ kinematics: "polar", rRate: 560, aRate: 200, zRate: 560, tolerance: 0.005 });
        preview.setSpeedView(true);
        preview.setCamera(overviewAt(60, 90));
    },
    probe: (preview) => {
        preview.setJob(small);
        preview.setProbe(heightMap(), { x0: -10, y0: -10, x1: 12, y1: 8, nx: 3, ny: 3 });
        preview.setCamera(overviewAt(70, 35, 30));
    },
    cartesian: (preview) => {
        preview.setLimits({ kinematics: "cartesian", r_max: 25, z_max: 18 });
        preview.setShowGrid(true);
        preview.setJob(small);
        preview.setHead({ r: 4, a: 20 }, { x: 6, y: -3 });
        preview.setHead({ r: 5, a: 20 }, { x: 7, y: -2 });
        preview.setCamera(overviewAt(80, 55, 340));
        preview.setDimensions([
            { kind: "linear", from: [-15, -12], to: [15, -12], side: -1, text: "30 mm" },
            { kind: "radius", center: [-12, 6], radius: 1.4, angle: 45, text: "R1.4" },
        ]);
    },
    low: (preview) => {
        preview.setJob(small);
        preview.setCamera({ target: [0, -6, 0], distance: 6, yaw: 15, pitch: 6 });
    },
    close: (preview) => {
        preview.setJob(small);
        preview.setCamera({ target: [-12, 6, 0], distance: 4, yaw: 0, pitch: 90 });
    },
    model: (preview) => {
        preview.setJob(model);
        preview.setCamera(overviewAt(60, 35, 25));
    },
    big: (preview) => {
        preview.setJob(bigOnce());
        preview.setLimits({ kinematics: "polar", r_max: 100, z_max: 0 });
        preview.setCamera(overviewAt(260, 60, 10));
    },
};

/** The page's previews, each drawn as its canvas's data-mode says. */
const previews: { mode: string; preview: Preview }[] = [];

/** How each mode draws: the 2D painter and WebGL in the page, then each in a worker; WebGL even where the browser has only a software GL (as headless Chromium does). */
const MODES: Record<string, PreviewOptions> = {
    "2d": { place: "page", painter: "2d" },
    gl: { place: "page", painter: "gl" },
    worker: { place: "worker", painter: "gl" },
    worker2d: { place: "worker", painter: "2d" },
};

/** Waits for each preview to have drawn since `frames`, up to `ms`. */
async function settled(before: number[], ms = 10000): Promise<void> {
    const until = performance.now() + ms;
    while (performance.now() < until) {
        if (previews.every(({ preview }, index) => preview.drawing.frames > (before[index] ?? 0))) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

function framesNow(): number[] {
    return previews.map(({ preview }) => preview.drawing.frames);
}

/** A picture as a PNG data URL. */
function png(width: number, height: number, pixels: Uint8ClampedArray): string {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
    return canvas.toDataURL("image/png");
}

interface Difference {
    mean: number;
    share: number;
}

/** How far apart two pictures are: the mean over pixels of the largest channel difference (0..255), and the share of pixels differing by more than `far`. */
function compare(a: Uint8ClampedArray, b: Uint8ClampedArray, far = 64): { mean: number; share: number; diff: Uint8ClampedArray } {
    let sum = 0;
    let count = 0;
    const diff = new Uint8ClampedArray(a.length);
    for (let i = 0; i < a.length; i += 4) {
        const d = Math.max(Math.abs(a[i]! - b[i]!), Math.abs(a[i + 1]! - b[i + 1]!), Math.abs(a[i + 2]! - b[i + 2]!));
        sum += d;
        if (d > far) {
            count += 1;
        }
        diff[i] = 255;
        diff[i + 1] = 255 - d;
        diff[i + 2] = 255 - d;
        diff[i + 3] = 255;
    }
    const pixels = a.length / 4;
    return { mean: sum / pixels, share: count / pixels, diff };
}

const api = {
    scenes: Object.keys(SCENES),
    drawing: () => previews.map(({ mode, preview }) => ({ mode, ...preview.drawing })),
    /** Shows a scene in every preview and waits for each to draw it. */
    async show(name: string): Promise<void> {
        const scene = SCENES[name];
        if (!scene) {
            throw new Error(`no scene ${name}`);
        }
        const before = framesNow();
        for (const { preview } of previews) {
            reset(preview);
            scene(preview);
            preview.draw();
        }
        await settled(before);
    },
    /**
     * Each preview's picture of the scene shown, and how far the WebGL ones
     * are from the 2D one, and each worker's from the same painter's in the
     * page; with `shots`, the pictures and where WebGL and 2D differ as PNGs.
     */
    async compare(shots: boolean): Promise<{ glVs2d: Difference; workerVsGl: Difference; worker2dVs2d: Difference; pngs: Record<string, string> }> {
        const pictures = await Promise.all(previews.map(({ preview }) => preview.snapshot()));
        const [flat, gl, worker, worker2d] = pictures;
        if (!flat || !gl || !worker || !worker2d) {
            throw new Error("four previews expected");
        }
        const glVs2d = compare(gl.pixels, flat.pixels);
        const workerVsGl = compare(worker.pixels, gl.pixels);
        const worker2dVs2d = compare(worker2d.pixels, flat.pixels);
        const pngs: Record<string, string> = {};
        if (shots) {
            pngs["2d"] = png(flat.width, flat.height, flat.pixels);
            pngs["gl"] = png(gl.width, gl.height, gl.pixels);
            pngs["worker"] = png(worker.width, worker.height, worker.pixels);
            pngs["diff"] = png(gl.width, gl.height, glVs2d.diff);
        }
        const plain = ({ mean, share }: Difference): Difference => ({ mean, share });
        return { glVs2d: plain(glVs2d), workerVsGl: plain(workerVsGl), worker2dVs2d: plain(worker2dVs2d), pngs };
    },
    /**
     * Times one preview through a drag: `steps` animation frames, each
     * turning the view a little and asking for a draw. Gives the page's
     * own time in each step (the draw itself when it is in the page, only
     * the sending when a worker draws), the frames drawn and how long the
     * drag took, and how long the scene took to come up.
     */
    async drag(index: number, scene: string, steps: number): Promise<{ mode: string; painter: string | null; upPage: number; upMs: number; stepMean: number; stepMax: number; frames: number; seconds: number }> {
        const entry = previews[index];
        if (!entry) {
            throw new Error(`no preview ${index}`);
        }
        const { preview, mode } = entry;
        const apply = SCENES[scene];
        if (!apply) {
            throw new Error(`no scene ${scene}`);
        }
        // The job is made before the clock starts.
        bigOnce();
        const frame = (): Promise<number> => new Promise((resolve) => requestAnimationFrame(resolve));
        reset(preview);
        await frame();
        // Only the draws asked for here: the preview's own at the next
        // animation frame would find nothing new and count twice.
        const ask = preview.requestDraw;
        preview.requestDraw = () => undefined;
        let before = preview.drawing.frames;
        const up = performance.now();
        apply(preview);
        preview.draw();
        const upPage = performance.now() - up;
        while (preview.drawing.frames === before) {
            await frame();
        }
        const upMs = performance.now() - up;
        await frame();
        before = preview.drawing.frames;
        const times: number[] = [];
        const started = performance.now();
        for (let step = 0; step < steps; step++) {
            await frame();
            const t0 = performance.now();
            preview.dragBy([400, 300], [403, 300.5], "orbit");
            preview.draw();
            times.push(performance.now() - t0);
        }
        // The last frames a worker still has to draw.
        const until = performance.now() + 5000;
        while (preview.drawing.place === "worker" && preview.drawing.frames - before < 1 && performance.now() < until) {
            await frame();
        }
        await frame();
        const seconds = (performance.now() - started) / 1000;
        preview.requestDraw = ask;
        return {
            mode,
            painter: preview.drawing.painter,
            upPage,
            upMs,
            stepMean: times.reduce((sum, t) => sum + t, 0) / times.length,
            stepMax: Math.max(...times),
            frames: preview.drawing.frames - before,
            seconds,
        };
    },
};

// Loaded again as the drawing worker, this script must not touch the page.
if (typeof document !== "undefined") {
    for (const canvas of Array.from(document.querySelectorAll<HTMLCanvasElement>("canvas.preview"))) {
        const mode = canvas.dataset["mode"] ?? "2d";
        previews.push({ mode, preview: new Preview(canvas, MODES[mode] ?? {}) });
    }
    (window as unknown as { renderCheck: typeof api }).renderCheck = api;
}
