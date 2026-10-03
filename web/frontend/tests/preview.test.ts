import { describe, expect, test } from "bun:test";

import {
    FIT_MARGIN,
    MAX_PITCH,
    MIN_DISTANCE,
    MIN_PITCH,
    OVERVIEW_PITCH,
    type Camera,
    circlePoints,
    fitDistance,
    frameOf,
    orbit,
    overview,
    pan,
    project,
    pxPerMm,
    unproject,
    zoomAt,
} from "../src/camera.ts";
import {
    LABEL_GAP_PX,
    LOCK_KEY,
    Preview,
    dragMode,
    heightExaggeration,
    heightSpread,
    jobReach,
    labelEvery,
    limitReach,
    limitShape,
    ringStep,
} from "../src/preview.ts";
import type { HeightMap, Job } from "../src/types.ts";

const job: Job = {
    id: "j",
    name: "j",
    source: "svg",
    spot: 0.1,
    offset: { x: 0, y: 0 },
    groups: [{ label: "g", power: 1, min_power: 0, speed: 1, passes: 1, enabled: true, paths: [[[3, 4], [-6, 8]]] }],
    outline: [[[-5, -5], [5, -5], [5, 5], [-5, 5], [-5, -5]]],
    copper: [[[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]]],
    stats: { length_mm: 0, seconds: 0, max_radius: 0, min_radius: 0, limited_fraction: 0, moves: 0 },
};

const W = 400;
const H = 300;
const topDown: Camera = { target: [0, 0, 0], distance: 100, yaw: 0, pitch: 90 };
const tilted: Camera = { target: [2, -3, 0], distance: 80, yaw: 30, pitch: 55 };

/** A 2D context that takes every call and counts the strokes, fills and texts. */
function fakeContext(): { ctx: CanvasRenderingContext2D; counts: Record<string, number> } {
    const counts: Record<string, number> = {};
    const ctx = new Proxy({}, {
        get(_target, name) {
            if (typeof name !== "string") {
                return undefined;
            }
            if (name === "measureText") {
                return () => ({ width: 10 });
            }
            return (): void => {
                counts[name] = (counts[name] ?? 0) + 1;
            };
        },
        set() {
            return true;
        },
    }) as unknown as CanvasRenderingContext2D;
    return { ctx, counts };
}

function sizedCanvas(width: number, height: number): { canvas: HTMLCanvasElement; counts: Record<string, number> } {
    const canvas = document.createElement("canvas");
    canvas.getBoundingClientRect = (() => ({ width, height, x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, toJSON: () => ({}) })) as typeof canvas.getBoundingClientRect;
    const { ctx, counts } = fakeContext();
    canvas.getContext = (() => ctx) as unknown as typeof canvas.getContext;
    document.body.appendChild(canvas);
    return { canvas, counts };
}

describe("camera", () => {
    test("straight down, board X runs right and board Y up the canvas, the axis in the middle", () => {
        const frame = frameOf(topDown);
        const axis = project(frame, W, H, [0, 0, 0])!;
        expect(axis.x).toBeCloseTo(W / 2, 9);
        expect(axis.y).toBeCloseTo(H / 2, 9);
        expect(axis.depth).toBeCloseTo(100, 9);
        const right = project(frame, W, H, [10, 0, 0])!;
        expect(right.x).toBeGreaterThan(W / 2);
        expect(right.y).toBeCloseTo(H / 2, 9);
        const up = project(frame, W, H, [0, 10, 0])!;
        expect(up.x).toBeCloseTo(W / 2, 9);
        expect(up.y).toBeLessThan(H / 2);
        // A point raised off the board is nearer the eye.
        expect(project(frame, W, H, [0, 0, 5])!.depth).toBeCloseTo(95, 9);
        // Ten millimeters measure the same on the canvas as the scale says.
        expect(right.x - axis.x).toBeCloseTo(10 * pxPerMm(topDown, H), 9);
    });

    test("tilted, the far side of the board is higher on the canvas and farther away", () => {
        const camera: Camera = { target: [0, 0, 0], distance: 100, yaw: 0, pitch: 60 };
        const frame = frameOf(camera);
        const far = project(frame, W, H, [0, 10, 0])!;
        const near = project(frame, W, H, [0, -10, 0])!;
        expect(far.y).toBeLessThan(H / 2);
        expect(near.y).toBeGreaterThan(H / 2);
        expect(far.depth).toBeGreaterThan(near.depth);
        // Board X still runs right.
        expect(project(frame, W, H, [10, 0, 0])!.x).toBeGreaterThan(W / 2);
        // Turned a quarter, the eye is on the +X side looking along -X, and
        // board Y runs right.
        const turned = frameOf({ ...camera, yaw: 90 });
        expect(project(turned, W, H, [0, 10, 0])!.x).toBeGreaterThan(W / 2);
        expect(project(turned, W, H, [10, 0, 0])!.depth).toBeLessThan(project(turned, W, H, [-10, 0, 0])!.depth);
    });

    test("project and unproject round trip on the board plane", () => {
        const frame = frameOf(tilted);
        for (const point of [[0, 0, 0], [7, -2, 0], [-4, 9, 0], [12, 12, 0]] as [number, number, number][]) {
            const p = project(frame, W, H, point)!;
            const back = unproject(frame, W, H, p.x, p.y)!;
            expect(back[0]).toBeCloseTo(point[0], 6);
            expect(back[1]).toBeCloseTo(point[1], 6);
            expect(back[2]).toBeCloseTo(0, 9);
        }
        // The plane the target floats on works the same way.
        const raised = unproject(frame, W, H, W / 2, H / 2, 3)!;
        expect(raised[2]).toBe(3);
    });

    test("what is behind the eye or in the sky is not drawn", () => {
        const low: Camera = { target: [0, 0, 0], distance: 10, yaw: 0, pitch: MIN_PITCH };
        const frame = frameOf(low);
        // Behind the eye: farther out on the eye's side than the eye itself.
        expect(project(frame, W, H, [0, -50, 0])).toBeNull();
        // The top of the canvas looks over the horizon at this pitch.
        expect(unproject(frame, W, H, W / 2, 0)).toBeNull();
    });

    test("zoom keeps the board point under the cursor still", () => {
        const before = unproject(frameOf(tilted), W, H, 310, 70)!;
        const zoomed = zoomAt(tilted, W, H, 310, 70, 2);
        expect(zoomed.distance).toBeCloseTo(40, 9);
        const after = unproject(frameOf(zoomed), W, H, 310, 70)!;
        expect(after[0]).toBeCloseTo(before[0], 6);
        expect(after[1]).toBeCloseTo(before[1], 6);
        // Zooming out again brings the camera back where it was.
        const back = zoomAt(zoomed, W, H, 310, 70, 0.5);
        expect(back.distance).toBeCloseTo(80, 9);
        expect(back.target[0]).toBeCloseTo(tilted.target[0], 6);
        expect(back.target[1]).toBeCloseTo(tilted.target[1], 6);
        // Clamped at the near end.
        expect(zoomAt(tilted, W, H, 200, 150, 1e9).distance).toBe(MIN_DISTANCE);
    });

    test("pan brings the board point under the start of the drag to its end", () => {
        const start = unproject(frameOf(tilted), W, H, 100, 200)!;
        const panned = pan(tilted, W, H, [100, 200], [160, 170]);
        const now = unproject(frameOf(panned), W, H, 160, 170)!;
        expect(now[0]).toBeCloseTo(start[0], 6);
        expect(now[1]).toBeCloseTo(start[1], 6);
        expect(panned.distance).toBe(tilted.distance);
        expect(panned.pitch).toBe(tilted.pitch);
        // A drag into the sky moves nothing.
        const low: Camera = { target: [0, 0, 0], distance: 10, yaw: 0, pitch: MIN_PITCH };
        expect(pan(low, W, H, [W / 2, H / 2], [W / 2, 0])).toEqual(low);
    });

    test("orbit turns about the target and keeps the pitch within bounds", () => {
        const turned = orbit(tilted, 50, 0);
        expect(turned.yaw).toBeCloseTo(30 + 50 * 0.4, 9);
        expect(turned.target).toEqual(tilted.target);
        expect(turned.distance).toBe(tilted.distance);
        expect(orbit(tilted, -100, 0).yaw).toBeCloseTo(350, 9);
        expect(orbit(tilted, 0, 1000).pitch).toBe(MAX_PITCH);
        expect(orbit(tilted, 0, -1000).pitch).toBe(MIN_PITCH);
    });

    test("the overview fits the reach with the axis in the middle, tilted", () => {
        const camera = overview(30, W, H);
        expect(camera.target).toEqual([0, 0, 0]);
        expect(camera.pitch).toBe(OVERVIEW_PITCH);
        const frame = frameOf(camera);
        for (const point of circlePoints(30 * FIT_MARGIN)) {
            const p = project(frame, W, H, point)!;
            expect(p.x).toBeGreaterThanOrEqual(0);
            expect(p.x).toBeLessThanOrEqual(W);
            expect(p.y).toBeGreaterThanOrEqual(0);
            expect(p.y).toBeLessThanOrEqual(H);
        }
        // Just inside: a little farther would waste room, a little nearer loses a point.
        expect(fitDistance(camera, W, H, circlePoints(30 * FIT_MARGIN), 4)).toBeLessThanOrEqual(camera.distance);
        expect(overview(10, W, H).distance).toBeLessThan(camera.distance);
        expect(overview(60, W, H).distance).toBeGreaterThan(camera.distance);
        // The field of view is fixed, so the fit depends on the canvas's
        // shape and not its pixel size; a canvas with no size yet does not throw.
        expect(Math.abs(overview(30, 800, 600).distance - camera.distance) / camera.distance).toBeLessThan(0.03);
        expect(overview(30, 400, 150).distance).toBeGreaterThan(camera.distance);
        expect(overview(30, 0, 0).distance).toBeGreaterThan(0);
    });
});

describe("Preview", () => {
    test("mounts on a canvas, takes a job and positions, and draws it all", () => {
        const { canvas, counts } = sizedCanvas(W, H);
        const preview = new Preview(canvas);
        preview.setJob(job);
        preview.setHead({ r: 5, a: 90 });
        preview.setHead({ r: 5, a: 100 });
        preview.setRMax(40);
        preview.draw();
        expect(counts["stroke"]).toBeGreaterThan(5);
        expect(counts["fill"]).toBeGreaterThan(0);
        expect(counts["fillText"]).toBeGreaterThan(0);
        // A cartesian machine with the head known, and a probe grid with heights.
        preview.setLimits({ kinematics: "cartesian", r_max: 50, z_max: 20 });
        preview.setHead({ r: 3, a: 30 }, { x: 1, y: 2 });
        const map: HeightMap = {
            grid: { x0: -5, y0: -5, x1: 5, y1: 5, nx: 3, ny: 2 },
            heights: [[-0.05, 0, 0.05], [null, 0.02, 0.1]],
            focus_offset: 0,
            focus_set: false,
            probe_offset: [0, 0],
            created: "",
        };
        preview.setProbe(map, { x0: 0, y0: 0, x1: 2, y1: 2, nx: 2, ny: 2 });
        preview.draw();
        // Looking from low down, with something behind the eye: still draws.
        preview.setCamera({ target: [0, 0, 0], distance: 3, yaw: 200, pitch: MIN_PITCH });
        preview.draw();
        preview.resetView();
        preview.clearTrail();
        expect(preview.getCamera().target).toEqual([0, 0, 0]);
        preview.dispose();
        canvas.remove();
    });

    test("fits once the canvas has a size, not while it is still unlaid", () => {
        // A canvas is measured as 0 by 0 until it is laid out, so the fit
        // the constructor does is against nothing. The first real size has
        // to refit, or the view stays as far away as a 1 px canvas needs.
        const canvas = document.createElement("canvas");
        let rect = { width: 0, height: 0 };
        canvas.getBoundingClientRect = (() => ({ ...rect, x: 0, y: 0, top: 0, left: 0, right: rect.width, bottom: rect.height, toJSON: () => ({}) })) as typeof canvas.getBoundingClientRect;
        document.body.appendChild(canvas);
        const preview = new Preview(canvas);
        preview.setJob(job);
        expect(preview.getCamera().distance).toBe(overview(jobReach(job, 0), 1, 1).distance);

        rect = { width: 400, height: 300 };
        preview.resize();
        expect(preview.getCamera().distance).toBeCloseTo(overview(jobReach(job, 0), 400, 300).distance, 9);

        // A later resize keeps whatever the operator orbited and zoomed to.
        preview.setCamera({ target: [1, 2, 0], distance: 33, yaw: 45, pitch: 70 });
        rect = { width: 500, height: 300 };
        preview.resize();
        expect(preview.getCamera()).toEqual({ target: [1, 2, 0], distance: 33, yaw: 45, pitch: 70 });
        preview.dispose();
        canvas.remove();
    });

    test("a drag orbits, or pans with the rotation locked, and the lock is remembered", () => {
        localStorage.removeItem(LOCK_KEY);
        const { canvas } = sizedCanvas(W, H);
        const preview = new Preview(canvas);
        expect(preview.rotationLocked).toBe(false);
        const start = preview.getCamera();
        preview.dragBy([100, 100], [150, 110], dragMode(preview.rotationLocked, { button: 0 }));
        const orbited = preview.getCamera();
        expect(orbited.yaw).not.toBe(start.yaw);
        expect(orbited.pitch).not.toBe(start.pitch);
        expect(orbited.target).toEqual(start.target);

        expect(preview.toggleRotationLock()).toBe(true);
        expect(localStorage.getItem(LOCK_KEY)).toBe("1");
        preview.dragBy([100, 100], [150, 110], dragMode(preview.rotationLocked, { button: 0 }));
        const panned = preview.getCamera();
        expect(panned.yaw).toBe(orbited.yaw);
        expect(panned.pitch).toBe(orbited.pitch);
        expect(panned.target).not.toEqual(orbited.target);
        preview.zoomBy([200, 150], 2);
        expect(preview.getCamera().distance).toBeCloseTo(panned.distance / 2, 9);
        preview.draw();
        preview.dispose();

        // The next preview comes up locked.
        const other = new Preview(sizedCanvas(W, H).canvas);
        expect(other.rotationLocked).toBe(true);
        other.setRotationLocked(false);
        expect(localStorage.getItem(LOCK_KEY)).toBe("0");
        other.dispose();
        canvas.remove();
    });

    test("what a pointer does: shift or a second button pans, else the lock decides", () => {
        expect(dragMode(false, { button: 0 })).toBe("orbit");
        expect(dragMode(true, { button: 0 })).toBe("pan");
        expect(dragMode(false, { button: 0, shiftKey: true })).toBe("pan");
        expect(dragMode(false, { button: 2 })).toBe("pan");
        expect(dragMode(false, { button: 1 })).toBe("pan");
        expect(dragMode(false, {})).toBe("orbit");
    });
});

describe("probed heights", () => {
    test("are stretched so the map's spread is a tenth of the reach, within bounds", () => {
        expect(heightExaggeration(0.1, 30)).toBeCloseTo(30, 9);
        expect(heightExaggeration(0.001, 30)).toBe(200);
        expect(heightExaggeration(10, 30)).toBe(1);
        expect(heightExaggeration(0, 30)).toBe(1);
        expect(heightExaggeration(0.1, 0)).toBe(1);
    });

    test("the spread needs two probed points", () => {
        const map = (heights: (number | null)[][]): HeightMap => ({
            grid: { x0: 0, y0: 0, x1: 1, y1: 1, nx: 2, ny: 2 },
            heights,
            focus_offset: 0,
            focus_set: false,
            probe_offset: [0, 0],
            created: "",
        });
        expect(heightSpread(map([[null, null], [null, null]]))).toBeNull();
        expect(heightSpread(map([[0.5, null], [null, null]]))).toBeNull();
        const spread = heightSpread(map([[-0.1, 0.1], [0.3, null]]))!;
        expect(spread.mean).toBeCloseTo(0.1, 9);
        expect(spread.range).toBeCloseTo(0.4, 9);
    });
});

describe("ring labels", () => {
    test("thin out when the rings are too close to read", () => {
        // Roomy: every 2 mm ring at 25 px per mm is 50 px apart.
        expect(labelEvery(2, 25)).toBe(1);
        // The phone view of a 14 mm reach: 2 mm rings about 30 px apart.
        expect(labelEvery(2, 15)).toBe(2);
        // Zoomed out far enough that only every fourth is worth a label.
        expect(labelEvery(2, 4)).toBe(4);
        // The boundary belongs to the roomier case.
        expect(labelEvery(1, LABEL_GAP_PX)).toBe(1);
    });

    test("reach covers paths, copper and r_max", () => {
        expect(jobReach(job, 0)).toBeCloseTo(10, 9);
        expect(jobReach(job, 30)).toBe(30);
        expect(jobReach(null, 0)).toBe(10);
    });

    test("ring step keeps a handful of rings", () => {
        expect(ringStep(4)).toBe(1);
        expect(ringStep(25)).toBe(5);
        expect(ringStep(80)).toBe(20);
        expect(ringStep(5000)).toBe(1000);
    });
});

describe("soft limits", () => {
    test("the polar machine's reach is a circle of r_max", () => {
        expect(limitShape({ kinematics: "polar", r_max: 50, z_max: 20 }, 30, 100)).toEqual({ kind: "circle", radius: 50 });
        expect(limitShape({ kinematics: "polar", r_max: 0, z_max: 20 }, 30, 100)).toBeNull();
        expect(limitReach({ kinematics: "polar", r_max: 50, z_max: 20 })).toBe(50);
    });

    test("a cartesian machine's reach is the joint box turned by the table angle", () => {
        const box = limitShape({ kinematics: "cartesian", r_max: 50, z_max: 20 }, 0, 100);
        expect(box).toEqual({ kind: "outline", points: [[50, 20], [-50, 20], [-50, -20], [50, -20]] });
        const turned = limitShape({ kinematics: "cartesian", r_max: 50, z_max: 20 }, 90, 100);
        expect(turned?.kind).toBe("outline");
        const corner = turned?.kind === "outline" ? turned.points[0]! : [0, 0];
        expect(corner[0]).toBeCloseTo(-20, 9);
        expect(corner[1]).toBeCloseTo(50, 9);
        expect(limitReach({ kinematics: "cartesian", r_max: 50, z_max: 20 })).toBeCloseTo(Math.hypot(50, 20), 9);
    });

    test("with one cartesian limit off the reach is a strip between two lines", () => {
        const strip = limitShape({ kinematics: "cartesian", r_max: 30, z_max: 0 }, 0, 100);
        expect(strip).toEqual({ kind: "lines", lines: [[[30, -100], [30, 100]], [[-30, -100], [-30, 100]]] });
        const across = limitShape({ kinematics: "cartesian", r_max: 0, z_max: 10 }, 0, 100);
        expect(across).toEqual({ kind: "lines", lines: [[[-100, 10], [100, 10]], [[-100, -10], [100, -10]]] });
        expect(limitShape({ kinematics: "cartesian", r_max: 0, z_max: 0 }, 0, 100)).toBeNull();
        expect(limitReach({ kinematics: "cartesian", r_max: 30, z_max: 0 })).toBe(30);
    });

    test("the fit takes in the corners of a cartesian box", () => {
        const { canvas } = sizedCanvas(400, 300);
        const preview = new Preview(canvas);
        preview.setLimits({ kinematics: "cartesian", r_max: 50, z_max: 20 });
        preview.setHead({ r: 5, a: 30 }, { x: 1, y: 2 });
        preview.resetView();
        expect(preview.getCamera().distance).toBeCloseTo(overview(Math.hypot(50, 20), 400, 300).distance, 9);
        preview.draw();
        // The radius alone keeps the machine as it was set.
        preview.setRMax(10);
        preview.resetView();
        expect(preview.getCamera().distance).toBeCloseTo(overview(jobReach(null, Math.hypot(10, 20)), 400, 300).distance, 9);
        preview.dispose();
        canvas.remove();
    });
});
