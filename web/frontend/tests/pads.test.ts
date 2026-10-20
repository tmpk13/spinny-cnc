import { describe, expect, test } from "bun:test";

import { MockBackend, PROBE_POINT_SECONDS, boardSurface, heightAt } from "../src/mock/backend.ts";
import { fillPadHeights, fitPlane, padMapGrid, selectPads } from "../src/mock/padmap.ts";
import type { HeightMap, HeightMapState, Job } from "../src/types.ts";
import { isPadMap, mapComplete, mapCounts, mapPartial, mapStatus, mountHeightMap, probingText } from "../src/views/heightmap.ts";
import { click, dialogButton, settle, setup } from "./harness.ts";

const SVG = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'><path d='M0 0 L10 0'/></svg>";

describe("pad map math", () => {
    test("pads under the area are skipped and the most spread out are kept over the count", () => {
        const pads: [number, number, number][] = [[0, 0, 9], [1, 0, 0.2], [10, 0, 9], [5, 0, 4], [10, 10, 9]];
        const all = selectPads(pads, 0.5, 100);
        expect(all.skipped).toBe(1);
        expect(all.points).toHaveLength(4);
        const two = selectPads(pads, 0.5, 2);
        expect(two.points.map(([x, y]) => `${x},${y}`).sort()).toEqual(["0,0", "10,10"]);
        const three = selectPads(pads, 0.5, 3);
        expect(three.points).toHaveLength(3);
        // A tour: neighbors follow one another.
        expect(all.points[0]).toEqual([0, 0]);
        expect(all.points[1]).toEqual([5, 0]);
    });

    test("a plane is fitted through three or more points and flat through fewer", () => {
        const plane = fitPlane([{ x: 0, y: 0, z: 1 }, { x: 10, y: 0, z: 2 }, { x: 0, y: 10, z: 3 }, { x: 10, y: 10, z: 4 }]);
        expect(plane.a).toBeCloseTo(0.1, 9);
        expect(plane.b).toBeCloseTo(0.2, 9);
        expect(plane.c).toBeCloseTo(1, 9);
        expect(fitPlane([{ x: 0, y: 0, z: 1 }, { x: 10, y: 0, z: 3 }])).toEqual({ a: 0, b: 0, c: 2 });
        expect(fitPlane([])).toEqual({ a: 0, b: 0, c: 0 });
    });

    test("the grid fills in from the probed pads, reading each pad's height at its place", () => {
        const map: HeightMap = {
            grid: { x0: 0, y0: 0, x1: 10, y1: 10, nx: 6, ny: 6 },
            heights: [],
            focus_offset: 0,
            focus_set: false,
            probe_offset: [0, 0],
            created: "",
            points: [[0, 0], [10, 0], [0, 10], [10, 10]],
            point_heights: [1, 2, 3, 4.5],
        };
        fillPadHeights(map);
        expect(map.heights).toHaveLength(6);
        expect(map.heights[0]![0]).toBeCloseTo(1, 9);
        expect(map.heights[0]![5]).toBeCloseTo(2, 9);
        expect(map.heights[5]![0]).toBeCloseTo(3, 9);
        expect(map.heights[5]![5]).toBeCloseTo(4.5, 9);
        // In between, the plane plus the bend stays between the corners.
        const middle = map.heights[2]![2]!;
        expect(middle).toBeGreaterThan(1);
        expect(middle).toBeLessThan(4.5);
        map.point_heights = [null, null, null, null];
        fillPadHeights(map);
        expect(map.heights.flat().every((value) => value === null)).toBe(true);
    });

    test("the pad map's grid spans the job and the pads with a margin at about 2 mm", () => {
        const job = { groups: [{ paths: [[[0, 0], [20, 0]]] }], outline: [[[0, -5], [20, 5]]] } as unknown as Job;
        const grid = padMapGrid(job, [[5, 0], [15, 0]]);
        expect(grid).toEqual({ x0: -1, y0: -6, x1: 21, y1: 6, nx: 12, ny: 7 });
    });
});

describe("probing the pads in the mock", () => {
    test("the plan picks the pads, the most spread out over the count, and says how long", async () => {
        const backend = new MockBackend({ timers: false });
        await backend.connect("/dev/ttyACM0");
        const job = (await backend.jobs())[0]!;
        const plan = await backend.planPads({ job: job.id });
        expect(plan).toMatchObject({ pads: 3, skipped: 0, resume: 0 });
        expect(plan.points).toEqual([[-12, 14], [0, 14], [12, 14]]);
        // Rounded to a tenth of a second, as the grid estimate is.
        expect(plan.seconds).toBeCloseTo(Math.round(3 * PROBE_POINT_SECONDS * 10) / 10, 6);
        const two = await backend.planPads({ job: job.id, max_points: 2 });
        expect(two.points).toEqual([[-12, 14], [12, 14]]);
        await expect(backend.planPads({ job: job.id, min_area: 10 })).rejects.toMatchObject({ status: 400, message: "no pad of demo coupon is 10 mm^2 or more" });
        await expect(backend.planPads({ job: job.id, min_area: 0.01 })).rejects.toMatchObject({ status: 400, message: "min_area must be 0.05 to 1000 mm^2" });
        await expect(backend.planPads({ job: job.id, max_points: 1 })).rejects.toMatchObject({ status: 400, message: "max_points must be a whole number from 2 to 2500" });
        await expect(backend.planPads({ job: "nope" })).rejects.toMatchObject({ status: 404 });
        const line = await backend.uploadJob(new File([SVG], "line.svg"), {});
        await expect(backend.planPads({ job: line.id })).rejects.toMatchObject({ status: 400, message: "line has no pads: a gerber or a KiCad board carries them" });
        await expect(backend.planPads({ job: job.id, resume: true })).rejects.toMatchObject({ status: 400, message: "there is no pad map to go on with: probe the pads first" });
    });

    test("probing the pads makes a pad map whose grid fills in, stopped short and gone on with", async () => {
        const backend = new MockBackend({ timers: false });
        const states: HeightMapState[] = [];
        backend.onEvent((event) => {
            if (event.type === "heightmap") {
                states.push(event.data);
            }
        });
        await backend.connect("/dev/ttyACM0");
        const job = (await backend.jobs())[0]!;
        const state = await backend.probePads({ job: job.id });
        expect(state.map?.points).toHaveLength(3);
        expect(state.map?.point_heights).toEqual([null, null, null]);
        expect(state.map?.grid).toMatchObject({ x0: -19, y0: 1, x1: 19, y1: 27 });
        expect(state.probe).toMatchObject({ state: "running", done: 0, total: 3, point: null, pad: 0 });
        backend.step(PROBE_POINT_SECONDS + 1e-6);
        const after = await backend.heightMap();
        expect(after.map?.point_heights?.[0]).toBeCloseTo(boardSurface(-12, 14), 3);
        expect(after.map?.heights.flat().every((value) => value !== null)).toBe(true);
        expect(after.probe).toMatchObject({ done: 1, pad: 1 });
        expect(states.some((entry) => entry.probe?.pad === 1)).toBe(true);
        await backend.probeStop();
        const partial = (await backend.heightMap()).map!;
        expect(isPadMap(partial)).toBe(true);
        expect(mapPartial(partial)).toBe(true);
        expect(mapComplete(partial)).toBe(false);
        expect(mapCounts(partial)).toEqual({ probed: 1, total: 3 });
        expect((await backend.planPads({ job: job.id, resume: true })).resume).toBe(1);
        expect((await backend.planPads({ job: job.id, resume: true })).points).toEqual([[0, 14], [12, 14]]);
        await expect(backend.probe({ ...partial.grid, resume: true })).rejects.toMatchObject({ status: 400, message: "the height map is a pad map: go on with it by probing the pads again" });
        await backend.probePads({ job: job.id, resume: true });
        backend.step(2 * PROBE_POINT_SECONDS + 1e-6);
        const done = await backend.heightMap();
        expect(done.probe?.state).toBe("done");
        expect(done.map?.point_heights?.every((value) => value !== null)).toBe(true);
        const map = done.map!;
        expect(mapComplete(map)).toBe(true);
        // The map reads the probed height near a pad and follows the board between them.
        expect(heightAt(map, 0, 14)).toBeCloseTo(boardSurface(0, 14), 1);
        expect(heightAt(map, 6, 14)).toBeCloseTo(boardSurface(6, 14), 1);
        await expect(backend.planPads({ job: job.id, resume: true })).rejects.toMatchObject({ status: 400, message: "the pad map is complete: nothing is left to probe" });
        // A compensated run wants the offset, then follows the pad map like a grid map.
        await expect(backend.runJob(job.id, "auto")).rejects.toMatchObject({ status: 400, message: "the focus offset is not set: focus the beam by eye over the probed area and use focus here" });
        // The words the panel uses.
        expect(mapStatus({ map: partial, probe: null, settings: done.settings })).toEqual({ text: "1/3 pads probed", kind: "partial" });
        expect(mapStatus({ map, probe: null, settings: done.settings })).toEqual({ text: "focus not set", kind: "partial" });
        expect(probingText({ done: 1, total: 3, pad: 1, seconds: 2, remaining: 0.5 }, true)).toBe("Probing pad 2 of 3, 2 s, about 0:01 left");
        expect(probingText({ done: 1, total: 3, seconds: 2, remaining: null }, false)).toBe("Probing point 2 of 3, 2 s");
        // A pad map put back keeps its points.
        const back = await backend.putHeightMap(map);
        expect(back.map?.points).toHaveLength(3);
        expect(back.map?.focus_set).toBe(false);
    });

    test("the height map panel's Pads row plans and probes the pads after a confirm", async () => {
        const { store, ctx, root, api, backend, calls } = setup();
        await api.connect("/dev/ttyACM0");
        await ctx.refreshState();
        await ctx.refreshJobs();
        await ctx.refreshHeightMap();
        mountHeightMap(root, ctx);
        const jobs = await api.jobs();
        await ctx.selectJob(jobs[0]!.id);
        click(root, "Plan");
        await settle();
        await settle();
        expect(root.querySelector(".hm-pads-note")?.textContent).toContain("3 points, of 3 pads");
        (root.querySelector('input[aria-label="Most pads probed"]') as HTMLInputElement).value = "2";
        click(root, "Probe pads");
        await settle();
        await settle();
        dialogButton("Probe pads").click();
        for (let i = 0; i < 4; i++) {
            await settle();
        }
        expect(calls.filter((c) => c.name === "probePads").at(-1)?.args[0]).toEqual({ job: jobs[0]!.id, min_area: 0.5, max_points: 2, resume: false });
        expect(store.get().heightMap?.map?.points).toHaveLength(2);
        expect(root.querySelector(".hm-badge")?.textContent).toBe("probing 0/2");
        expect(root.textContent).toContain("Probing pad 1 of 2");
        // Stopped after one pad: the grid's Continue stays hidden for a pad map, the pads' shows.
        backend.step(PROBE_POINT_SECONDS + 1e-6);
        await api.probeStop();
        await ctx.refreshHeightMap();
        await ctx.refreshState();
        const continues = Array.from(root.querySelectorAll("button")).filter((b) => b.textContent === "Continue");
        expect(continues.map((b) => b.classList.contains("hidden"))).toEqual([true, false]);
        expect(root.querySelector(".hm-badge")?.textContent).toBe("1/2 pads probed");
        continues[1]!.click();
        await settle();
        await settle();
        dialogButton("Continue").click();
        for (let i = 0; i < 4; i++) {
            await settle();
        }
        expect(calls.filter((c) => c.name === "probePads").at(-1)?.args[0]).toMatchObject({ resume: true });
    });
});
