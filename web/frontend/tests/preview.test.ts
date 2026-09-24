import { describe, expect, test } from "bun:test";

import { LABEL_GAP_PX, MIN_SCALE, Preview, labelEvery, fitView, jobReach, panBy, ringStep, screenToWorld, worldToScreen, zoomAt } from "../src/preview.ts";
import type { Job } from "../src/types.ts";

const job: Job = {
    id: "j",
    name: "j",
    source: "svg",
    spot: 0.1,
    offset: { x: 0, y: 0 },
    groups: [{ label: "g", power: 1, min_power: 0, speed: 1, passes: 1, enabled: true, paths: [[[3, 4], [-6, 8]]] }],
    outline: [],
    copper: [[[1, 1], [2, 2]]],
    stats: { length_mm: 0, seconds: 0, max_radius: 0, min_radius: 0, limited_fraction: 0, moves: 0 },
};

describe("view math", () => {
    test("fit puts the axis in the middle with a margin", () => {
        const view = fitView(10, 400, 300);
        expect(view.cx).toBe(0);
        expect(view.cy).toBe(0);
        expect(view.scale).toBeCloseTo(300 / (20 * 1.15), 9);
    });

    test("world and screen round trip with y up", () => {
        const view = { cx: 1, cy: 2, scale: 10 };
        const [sx, sy] = worldToScreen(view, 400, 300, 1, 2);
        expect(sx).toBe(200);
        expect(sy).toBe(150);
        const [ux, uy] = worldToScreen(view, 400, 300, 1, 3);
        expect(uy).toBeLessThan(sy);
        expect(ux).toBe(200);
        const [wx, wy] = screenToWorld(view, 400, 300, 250, 100);
        expect(wx).toBeCloseTo(6, 9);
        expect(wy).toBeCloseTo(7, 9);
    });

    test("zoom keeps the point under the cursor still", () => {
        const view = { cx: 0, cy: 0, scale: 5 };
        const before = screenToWorld(view, 400, 300, 320, 60);
        const zoomed = zoomAt(view, 400, 300, 320, 60, 2);
        const after = screenToWorld(zoomed, 400, 300, 320, 60);
        expect(zoomed.scale).toBe(10);
        expect(after[0]).toBeCloseTo(before[0], 9);
        expect(after[1]).toBeCloseTo(before[1], 9);
    });

    test("zoom is clamped", () => {
        const view = { cx: 0, cy: 0, scale: 300 };
        expect(zoomAt(view, 10, 10, 5, 5, 100).scale).toBe(400);
        expect(zoomAt({ cx: 0, cy: 0, scale: 0.1 }, 10, 10, 5, 5, 0.01).scale).toBe(0.05);
    });

    test("pan moves the center against the drag", () => {
        const view = panBy({ cx: 0, cy: 0, scale: 10 }, 50, -20);
        expect(view.cx).toBe(-5);
        expect(view.cy).toBe(-2);
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

describe("Preview", () => {
    test("mounts on a canvas and takes a job and positions", () => {
        const canvas = document.createElement("canvas");
        document.body.appendChild(canvas);
        const preview = new Preview(canvas);
        preview.setJob(job);
        preview.setHead({ r: 5, a: 90 });
        preview.setHead({ r: 5, a: 100 });
        preview.setRMax(40);
        preview.draw();
        preview.resetView();
        preview.clearTrail();
        expect(preview.getView().cx).toBe(0);
        preview.dispose();
        canvas.remove();
    });

    test("fits once the canvas has a size, not while it is still unlaid", () => {
        // A canvas is measured as 0 by 0 until it is laid out, so the fit
        // the constructor does is against nothing. The first real size has
        // to refit, or the view stays at the smallest scale there is.
        const canvas = document.createElement("canvas");
        let rect = { width: 0, height: 0 };
        canvas.getBoundingClientRect = (() => ({ ...rect, x: 0, y: 0, top: 0, left: 0, right: rect.width, bottom: rect.height, toJSON: () => ({}) })) as typeof canvas.getBoundingClientRect;
        document.body.appendChild(canvas);
        const preview = new Preview(canvas);
        preview.setJob(job);
        expect(preview.getView().scale).toBe(MIN_SCALE);

        rect = { width: 400, height: 300 };
        preview.resize();
        expect(preview.getView().scale).toBeCloseTo(fitView(jobReach(job, 0), 400, 300).scale, 9);

        // A later resize keeps whatever the operator zoomed to.
        preview.setView({ cx: 1, cy: 2, scale: 33 });
        rect = { width: 500, height: 300 };
        preview.resize();
        expect(preview.getView().scale).toBe(33);
        expect(preview.getView().cx).toBe(1);
        preview.dispose();
        canvas.remove();
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
});
