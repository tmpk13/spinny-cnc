// The Run panel the Jobs and the Plot pages share: the height map choice
// both copies show, what each page adds, and picking a stopped run up on
// either page.

import { describe, expect, test } from "bun:test";

import type { HeightMap, Job, Progress } from "../src/types.ts";
import { mapChoiceOf, mountRun, runStatsText } from "../src/views/run.ts";
import { click, connected, settle, setup } from "./harness.ts";

const READY: HeightMap = {
    grid: { x0: -10, y0: -5, x1: 10, y1: 5, nx: 2, ny: 2 },
    heights: [[0, 0.1], [0.2, 0.3]],
    focus_offset: 0,
    focus_set: true,
    probe_offset: [0, 0],
    created: "2026-11-11T10:00:00+00:00",
};

function job(): Job {
    return {
        id: "j1",
        name: "square",
        source: "json",
        spot: 0.1,
        offset: { x: 0, y: 0 },
        groups: [
            { label: "a", power: 500, min_power: 0, speed: 400, passes: 1, enabled: true, paths: [[[-4, -3], [6, -3], [6, 2]]] },
            { label: "off", power: 500, min_power: 0, speed: 400, passes: 1, enabled: false, paths: [[[-4, 0], [4, 0]]] },
        ],
        outline: [],
        copper: [],
        stats: { length_mm: 15, seconds: 90, max_radius: 0, min_radius: 0, limited_fraction: 0, moves: 0 },
    };
}

const SETTINGS = { depth: 5, feed: 60, slow: 15, backoff: 0.3, offset: [0, 0] as [number, number], rayleigh: 0.5 };

/** The Jobs page's copy and the Plot page's, mounted side by side. */
function mountBoth() {
    const harness = setup();
    const plot = document.createElement("section");
    document.body.appendChild(plot);
    mountRun(harness.root, harness.ctx);
    mountRun(plot, harness.ctx, { stats: true, hint: "zero the depth first" });
    const select = (root: HTMLElement): HTMLSelectElement => root.querySelector('select[aria-label="Height map"]') as HTMLSelectElement;
    return { ...harness, jobs: harness.root, plot, select };
}

describe("the height map choice", () => {
    test("follows the map until one is picked, and a mill has no power choice", () => {
        expect(mapChoiceOf(null, READY, false)).toBe("auto");
        expect(mapChoiceOf(null, null, false)).toBe("off");
        expect(mapChoiceOf(null, { ...READY, focus_set: false }, false)).toBe("off");
        expect(mapChoiceOf("off", READY, false)).toBe("off");
        expect(mapChoiceOf("focus", null, false)).toBe("focus");
        expect(mapChoiceOf("power", READY, false)).toBe("power");
        expect(mapChoiceOf("power", READY, true)).toBe("auto");
    });

    test("is the same in both pages' panels, whichever one it is picked in", () => {
        const { store, jobs, plot, select } = mountBoth();
        store.set({ snapshot: connected(), job: job(), heightMap: { map: READY, probe: null, settings: SETTINGS } });
        expect(select(jobs).value).toBe("auto");
        expect(select(plot).value).toBe("auto");
        expect(store.get().mapChoice).toBe("auto");
        select(plot).value = "off";
        select(plot).dispatchEvent(new Event("change"));
        expect(select(jobs).value).toBe("off");
        expect(jobs.querySelector(".map-use")?.textContent).toBe("map off");
        expect(plot.querySelector(".map-use")?.textContent).toBe("map off");
        expect(store.get().mapChoice).toBe("off");
        // A picked choice stays when the map goes.
        store.set({ heightMap: { map: null, probe: null, settings: SETTINGS } });
        expect(select(jobs).value).toBe("off");
        select(jobs).value = "auto";
        select(jobs).dispatchEvent(new Event("change"));
        expect(select(plot).value).toBe("auto");
        expect(plot.querySelector(".map-use")?.textContent).toBe("no map");
    });

    test("goes out with a run from either panel", async () => {
        const { store, plot, calls, select, api } = mountBoth();
        const made = await api.uploadJob(new File([JSON.stringify({ groups: [{ label: "a", power: 500, speed: 400, paths: [[[1, 1], [2, 1]]] }] })], "a.json"), {});
        store.set({ snapshot: connected(), job: await api.job(made.id) });
        select(plot).value = "power";
        select(plot).dispatchEvent(new Event("change"));
        click(plot, "Run");
        await settle();
        expect(calls.find((call) => call.name === "runJob")?.args).toEqual([made.id, "power", false]);
    });
});

describe("what each page's copy shows", () => {
    test("the Plot page's says the job's length, time and groups on, and its hint", () => {
        const { store, jobs, plot } = mountBoth();
        expect(plot.querySelector(".run-stats")?.textContent).toBe("make a job, or select one in the Jobs panel");
        store.set({ job: job() });
        expect(plot.querySelector(".run-stats")?.textContent).toBe(runStatsText(job()));
        expect(runStatsText(job())).toContain("1 of 2 groups on");
        expect(plot.querySelector(".run-job")?.textContent).toBe("square");
        expect(jobs.querySelector(".run-job")?.textContent).toBe("square");
        expect(jobs.querySelector(".run-stats")).toBeNull();
        expect(plot.textContent).toContain("zero the depth first");
        expect(jobs.textContent).not.toContain("zero the depth first");
    });

    test("both offer a stopped run of the selected job to pick up", () => {
        const { store, jobs, plot } = mountBoth();
        const stopped: Progress = { job: "j1", state: "stopped", sent: 9, acked: 7, total: 40, seconds: 3, estimate: 20, group: 0 };
        store.set({ snapshot: connected(), job: job(), progress: stopped });
        for (const root of [jobs, plot]) {
            expect(root.querySelector(".pickup")?.classList.contains("hidden")).toBe(false);
            // The line field comes first in the row, before the checkbox.
            expect((root.querySelector(".pickup input") as HTMLInputElement).value).toBe("7");
            expect(root.querySelector(".progress")?.classList.contains("hidden")).toBe(false);
        }
        store.set({ progress: { ...stopped, state: "done" } });
        expect(plot.querySelector(".pickup")?.classList.contains("hidden")).toBe(true);
    });
});
