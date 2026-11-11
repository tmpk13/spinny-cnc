import { describe, expect, test } from "bun:test";

import { stepCeilingHz } from "../src/kinematics.ts";
import { jointPreview } from "../src/mock/jobs.ts";
import { isCapped, SPEED_COLORS, speedBucket, speedMap, type SpeedLimits } from "../src/speed.ts";
import type { Group, Job } from "../src/types.ts";
import { scrubText, speedLimitsOf } from "../src/views/previewpanel.ts";
import { initialState } from "../src/state.ts";

const POLAR: SpeedLimits = { kinematics: "polar", rRate: 560, aRate: 400, zRate: 600, tolerance: 0.005 };

function group(label: string, paths: [number, number][][], extra: Partial<Group> = {}): Group {
    return { label, power: 500, min_power: 0, speed: 400, passes: 1, enabled: true, paths, ...extra };
}

function job(groups: Group[]): Job {
    return {
        id: "j", name: "j", source: "svg", spot: 0.1, offset: { x: 0, y: 0 }, groups, outline: [], copper: [],
        stats: { length_mm: 0, seconds: 0, max_radius: 0, min_radius: 0, limited_fraction: 0, moves: 0 },
    };
}

describe("the speed view", () => {
    test("on the polar machine a cut round the axis is held back by the table near it and not far out", () => {
        // 400 mm/min round a ring needs 22918 / r deg/min of the table: at
        // 400 deg/min that is beyond 57 mm only.
        const ring = (r: number): [number, number][] => Array.from({ length: 33 }, (_, i) => [r * Math.cos((i / 32) * 2 * Math.PI), r * Math.sin((i / 32) * 2 * Math.PI)] as [number, number]);
        const near = speedMap(job([group("near", [ring(10)])]), POLAR);
        expect(near.segments.length).toBeGreaterThan(30);
        expect(near.segments.every(isCapped)).toBe(true);
        // The table's 400 deg/min at 10 mm is about 70 mm/min of surface.
        expect(near.fastest).toBeCloseTo(400 * Math.PI / 180 * 10, 0);
        expect(near.cappedLength).toBeCloseTo(near.length, 6);
        const far = speedMap(job([group("far", [ring(80)])]), POLAR);
        expect(far.segments.some(isCapped)).toBe(false);
        expect(far.fastest).toBeCloseTo(400, 6);
        expect(far.cappedLength).toBe(0);
    });

    test("groups switched off, dots and a model's moves are left out, and passes do not repeat the moves", () => {
        const map = speedMap(job([
            group("off", [[[60, 0], [70, 0]]], { enabled: false }),
            group("dots", [[[60, 5]], [[61, 5]]]),
            group("twice", [[[60, 10], [70, 10]]], { passes: 3 }),
        ]), POLAR);
        expect(map.segments.length).toBeGreaterThan(0);
        expect(map.segments.every((segment) => segment.wanted === 400)).toBe(true);
        expect(map.length).toBeCloseTo(10, 3);
    });

    test("a joint-space move is drawn along the arc the beam follows, not its chord", () => {
        const arc: [number, number][] = [[10, 0], [10, 90]];
        const map = speedMap(job([group("arc", [jointPreview(arc)], { joints: [arc] })]), POLAR);
        expect(map.segments.length).toBeGreaterThan(1);
        for (const segment of map.segments) {
            for (const [x, y] of [segment.from, segment.to]) {
                expect(Math.abs(Math.hypot(x, y) - 10)).toBeLessThan(0.01);
            }
        }
        // One move, counted once: the quarter arc, every piece at its speed.
        expect(map.length).toBeCloseTo(5 * Math.PI, 6);
        expect(new Set(map.segments.map((segment) => segment.speed)).size).toBe(1);
        expect(map.cappedLength).toBeCloseTo(map.length, 6);
        // A spiral out is drawn through the radii between.
        const spiral = speedMap(job([group("spiral", [], { joints: [[[5, 0], [15, 360]]] })]), POLAR);
        const middle = spiral.segments[Math.floor(spiral.segments.length / 2)]!;
        expect(Math.hypot(...middle.from)).toBeCloseTo(10, 0);
    });

    test("on a cartesian machine an axis's rate holds a move back along its direction", () => {
        const cartesian: SpeedLimits = { ...POLAR, kinematics: "cartesian", rRate: 300, zRate: 1000 };
        const map = speedMap(job([group("cut", [[[0, 0], [10, 0], [10, 10]]], { speed: 600 })]), cartesian);
        expect(map.segments.map((segment) => Math.round(segment.speed))).toEqual([300, 600]);
        expect(map.segments.map(isCapped)).toEqual([true, false]);
        expect(map.cappedLength).toBe(10);
    });

    test("the colors run from the slowest to the fastest", () => {
        expect(speedBucket(100, 100, 500)).toBe(0);
        expect(speedBucket(500, 100, 500)).toBe(SPEED_COLORS.length - 1);
        expect(speedBucket(300, 100, 500)).toBe(2);
        expect(speedBucket(400, 400, 400)).toBe(SPEED_COLORS.length - 1);
    });

    test("the rates come from the settings read, with the cross slide's for a cartesian Y", () => {
        const state = initialState(true);
        expect(speedLimitsOf(state)).toEqual({ kinematics: "polar", rRate: 560, aRate: 400, zRate: 560, tolerance: 0.005, assumed: true });
        state.settings = { values: { r_rate: 900, a_rate: 300, z_rate: 700 }, schema: [], host: { tolerance: 0.01 } } as unknown as typeof state.settings;
        expect(speedLimitsOf(state)).toEqual({ kinematics: "polar", rRate: 900, aRate: 300, zRate: 700, tolerance: 0.01, assumed: false });
    });

    test("a rate past what the step generator pulses is held to it, as the firmware's planner holds it", () => {
        // One step every 10 us tick at a 2 us pulse; a 20 us pulse needs 30
        // us busy-waited and 3 more of the interrupt's own.
        expect(stepCeilingHz(2)).toBe(100_000);
        expect(stepCeilingHz(5)).toBeCloseTo(1e6 / 11, 9);
        expect(stepCeilingHz(20)).toBeCloseTo(1e6 / 33, 9);
        const state = initialState(true);
        state.settings = {
            values: { r_rate: 560, a_rate: 600, z_rate: 560, r_steps: 10240, a_steps: 14222.222, z_steps: 12800, step_us: 2 },
            schema: [],
            host: { tolerance: 0.005 },
        } as unknown as typeof state.settings;
        const limits = speedLimitsOf(state);
        expect(limits.rRate).toBe(560);
        expect(limits.aRate).toBeCloseTo(421.875, 3);
        expect(limits.zRate).toBeCloseTo(468.75, 9);
        // A ring at 45 mm and 400 mm/min needs 509 deg/min of the table:
        // under the 600 asked for, over the 421.9 the table reaches.
        const ring = Array.from({ length: 65 }, (_, i) => [45 * Math.cos((i / 64) * 2 * Math.PI), 45 * Math.sin((i / 64) * 2 * Math.PI)] as [number, number]);
        const map = speedMap(job([group("ring", [ring])]), limits);
        expect(map.segments.length).toBeGreaterThan(60);
        expect(map.segments.every(isCapped)).toBe(true);
        expect(map.cappedLength).toBeCloseTo(map.length, 6);
    });
});

describe("the cut order slider", () => {
    test("says how far along the cut it is", () => {
        expect(scrubText(5, 5, null)).toBe("all 5 paths, in cut order");
        expect(scrubText(0, 5, null)).toBe("none of 5 cut yet");
        expect(scrubText(2, 5, "isolation loop 1")).toBe("2 of 5 cut, the last in isolation loop 1");
    });
});

describe("the preview panel's speed and cut order", () => {
    test("the slider steps the cut and the speed view hides it", async () => {
        const { setup } = await import("./harness.ts");
        const { mountPreviewPanel } = await import("../src/views/previewpanel.ts");
        const { store, ctx, root } = setup();
        const preview = mountPreviewPanel(root, ctx);
        store.set({ job: job([group("a", [[[0, 0], [5, 0]], [[0, 1], [5, 1]]]), group("b", [[[0, 2], [5, 2]]])]) });
        const slider = root.querySelector('input[aria-label="Cut order"]') as HTMLInputElement;
        const row = root.querySelector(".scrub-row") as HTMLElement;
        expect(row.classList.contains("hidden")).toBe(false);
        expect([slider.max, slider.value]).toEqual(["3", "3"]);
        expect(preview.scrub).toBeNull();
        slider.value = "1";
        slider.dispatchEvent(new Event("input"));
        expect(preview.scrub).toBe(1);
        expect(row.textContent).toContain("1 of 3 cut, the last in a");
        Array.from(row.querySelectorAll("button")).find((b) => b.textContent === "On")!.click();
        expect(preview.scrub).toBe(2);
        expect(row.textContent).toContain("the last in a");
        // An edit of the same job keeps the place; another job starts whole.
        store.set({ job: { ...store.get().job!, name: "edited" } });
        expect(preview.scrub).toBe(2);
        store.set({ job: { ...job([group("c", [[[0, 0], [1, 0]]])]), id: "other" } });
        expect(preview.scrub).toBeNull();
        expect(slider.max).toBe("1");
        const speed = Array.from(root.querySelectorAll("button")).find((b) => b.textContent === "Speed")!;
        speed.click();
        expect(preview.speedView).toBe(true);
        expect(speed.getAttribute("aria-pressed")).toBe("true");
        expect(row.classList.contains("hidden")).toBe(true);
        root.remove();
    });
});
