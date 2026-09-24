import { describe, expect, test } from "bun:test";

import type { Api } from "../src/api.ts";
import { createContext } from "../src/main.ts";
import { gridPoints, sameGrid } from "../src/preview.ts";
import { initialState, Store, type AppState } from "../src/state.ts";
import type { Grid, HeightMap, HeightMapState, Job, Machine, ProbeSettings, Snapshot } from "../src/types.ts";
import { droText, mountDro } from "../src/views/dro.ts";
import {
    cellColor,
    gridForJob,
    heightStats,
    LABELED_POINTS,
    mapStatus,
    mapUsable,
    MAX_TINT,
    mountHeightMap,
    readGrid,
    signed,
} from "../src/views/heightmap.ts";
import { mountJobs } from "../src/views/jobs.ts";
import { mountJog } from "../src/views/jog.ts";

const SETTINGS: ProbeSettings = { depth: 5, feed: 60, slow: 15, backoff: 0.3, offset: [0, 0], rayleigh: 0.5 };

function grid(overrides: Partial<Grid> = {}): Grid {
    return { x0: -10, y0: -5, x1: 10, y1: 5, nx: 3, ny: 2, ...overrides };
}

function heightMap(heights: (number | null)[][], overrides: Partial<HeightMap> = {}): HeightMap {
    return {
        grid: grid({ nx: heights[0]?.length ?? 2, ny: heights.length }),
        heights,
        focus_offset: 0,
        focus_set: false,
        probe_offset: [0, 0],
        created: "2026-09-23T10:00:00+00:00",
        ...overrides,
    };
}

function machine(overrides: Partial<Machine> = {}): Machine {
    return {
        state: "Idle",
        alarm: null,
        joint: { r: 12.345, a: 90, z: 0, h: -1.25 },
        board: { x: 0, y: 12.345 },
        rate: 0,
        laser: 0,
        mode: "dyn",
        enabled: true,
        queue: { planner: 32, lines: 16 },
        probe: false,
        ...overrides,
    };
}

function connected(overrides: Partial<Machine> = {}): Snapshot {
    return { connected: true, url: "/dev/ttyACM0", firmware: { version: "0.1.0", lines: 16, blocks: 32 }, machine: machine(overrides), run: null };
}

function job(): Job {
    return {
        id: "j1",
        name: "square",
        source: "json",
        spot: 0.1,
        offset: { x: 0, y: 0 },
        groups: [
            { label: "a", power: 500, min_power: 0, speed: 400, passes: 1, enabled: true, paths: [[[-4, -3], [6, -3], [6, 2.05]]] },
            { label: "off", power: 500, min_power: 0, speed: 400, passes: 1, enabled: false, paths: [[[-40, 0], [40, 0]]] },
        ],
        outline: [],
        copper: [],
        stats: { length_mm: 0, seconds: 0, max_radius: 0, min_radius: 0, limited_fraction: 0, moves: 0 },
    };
}

/** The calls the views make, answered with a fixed height map state. */
function fakeApi(state: HeightMapState): { api: Api; calls: { name: string; args: unknown[] }[] } {
    const calls: { name: string; args: unknown[] }[] = [];
    const answer = (name: string) => async (...args: unknown[]) => {
        calls.push({ name, args });
        if (name === "jobs") {
            return [];
        }
        return name === "state" ? connected() : state;
    };
    const api = new Proxy({}, { get: (_, name: string) => answer(name) }) as unknown as Api;
    return { api, calls };
}

function setup(state: HeightMapState) {
    const store = new Store<AppState>(initialState(false));
    const { api, calls } = fakeApi(state);
    const ctx = createContext(api, store);
    const root = document.createElement("section");
    document.body.appendChild(root);
    return { store, ctx, root, calls };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function click(root: ParentNode, label: string): void {
    const node = Array.from(root.querySelectorAll("button")).find((b) => b.textContent === label);
    if (!node) {
        throw new Error(`no button ${label}`);
    }
    node.click();
}

async function confirm(label: string): Promise<void> {
    await settle();
    const node = Array.from(document.querySelectorAll("dialog[open] button")).find((b) => b.textContent === label) as HTMLButtonElement | undefined;
    if (!node) {
        throw new Error(`no dialog button ${label}`);
    }
    node.click();
    await settle();
}

describe("height map math", () => {
    test("statistics skip what is not probed", () => {
        expect(heightStats(heightMap([[null, null], [null, null]]))).toBeNull();
        const stats = heightStats(heightMap([[-1, null, -2], [0, -1, null]]))!;
        expect(stats).toEqual({ min: -2, max: 0, mean: -1, probed: 4, total: 6 });
    });

    test("cells are gray at the mean, red above and blue below, up to the cap", () => {
        const stats = heightStats(heightMap([[-2, -1, 0]]))!;
        expect(cellColor(-1, stats)).toBe("color-mix(in oklab, var(--hm-high) 0%, var(--hm-mid))");
        expect(cellColor(0, stats)).toBe(`color-mix(in oklab, var(--hm-high) ${MAX_TINT}%, var(--hm-mid))`);
        expect(cellColor(-2, stats)).toBe(`color-mix(in oklab, var(--hm-low) ${MAX_TINT}%, var(--hm-mid))`);
        expect(cellColor(-1.5, stats)).toBe(`color-mix(in oklab, var(--hm-low) ${MAX_TINT / 2}%, var(--hm-mid))`);
        expect(cellColor(null, stats)).toBe("transparent");
        expect(cellColor(3, heightStats(heightMap([[3, 3]]))!)).toBe("var(--hm-mid)");
    });

    test("a grid fitted to a job reaches past its enabled groups, on tenths", () => {
        expect(gridForJob(job(), 4, 3)).toEqual({ x0: -5, y0: -4, x1: 7, y1: 3.1, nx: 4, ny: 3 });
        const line = job();
        line.groups[0]!.paths = [[[0, 0], [5, 0]]];
        const fitted = gridForJob(line, 2, 2, 0)!;
        expect(fitted.y1 - fitted.y0).toBe(1);
        const joints = job();
        joints.groups[0]!.joints = [[[5, 90], [-5, 90]]];
        const around = gridForJob(joints, 2, 2)!;
        expect(around.y0).toBe(-6);
        expect(around.y1).toBe(6);
        const none = job();
        none.groups[0]!.enabled = false;
        expect(gridForJob(none, 2, 2)).toBeNull();
    });

    test("a deviation carries its sign", () => {
        expect(signed(0.0504)).toBe("+0.050");
        expect(signed(-0.05)).toBe("-0.050");
        expect(signed(0.0001)).toBe("0.000");
    });

    test("grid fields are read and checked", () => {
        const fields = { x0: "-10", y0: "-5", x1: "10", y1: "5", nx: "3", ny: "2" };
        expect(readGrid(fields)).toEqual(grid());
        expect(readGrid({ ...fields, x0: "a" })).toBe("x0 is not a number");
        expect(readGrid({ ...fields, x1: "-20" })).toContain("X to above X from");
        expect(readGrid({ ...fields, nx: "1" })).toContain("2 to 50");
        expect(readGrid({ ...fields, ny: "2.5" })).toContain("whole numbers");
    });

    test("the badge and the run choice follow the map", () => {
        expect(mapStatus(null)).toEqual({ text: "no map", kind: "none" });
        const partial = heightMap([[0, null]]);
        expect(mapStatus({ map: partial, probe: null, settings: SETTINGS }).text).toBe("1/2 probed");
        expect(mapStatus({ map: partial, probe: { state: "running", done: 1, total: 2, point: [1, 0], seconds: 2, error: null }, settings: SETTINGS }).text).toBe("probing 1/2");
        const full = heightMap([[0, 0.1]]);
        expect(mapStatus({ map: full, probe: null, settings: SETTINGS }).text).toBe("focus not set");
        expect(mapUsable(full)).toBe(false);
        full.focus_set = true;
        expect(mapStatus({ map: full, probe: null, settings: SETTINGS })).toEqual({ text: "ready", kind: "ready" });
        expect(mapUsable(full)).toBe(true);
        expect(mapUsable(null)).toBe(false);
    });

    test("the preview's grid points run row by row from the lowest Y", () => {
        expect(gridPoints(grid())).toEqual([[-10, -5], [0, -5], [10, -5], [-10, 5], [0, 5], [10, 5]]);
        expect(sameGrid(grid(), grid())).toBe(true);
        expect(sameGrid(grid(), grid({ nx: 4 }))).toBe(false);
        expect(sameGrid(null, null)).toBe(true);
        expect(sameGrid(grid(), null)).toBe(false);
    });
});

describe("focus axis readout and jog", () => {
    test("the readout shows H and the probe only on a machine with them", () => {
        const text = droText(machine({ probe: true }));
        expect(text.h).toBe("-1.250");
        expect(text.probe).toBe("down");
        const none = droText(machine({ joint: { r: 1, a: 2, z: 0, h: null }, probe: null }));
        expect(none.h).toBeNull();
        expect(none.probe).toBeNull();

        const { store, ctx, root } = setup({ map: null, probe: null, settings: SETTINGS });
        mountDro(root, ctx);
        store.set({ snapshot: connected() });
        const cell = root.querySelector('[data-dro="h"]')!;
        expect(cell.textContent).toBe("-1.250");
        expect(cell.parentElement!.classList.contains("hidden")).toBe(false);
        expect(root.querySelector('[data-dro="probe"]')!.textContent).toBe("up");
        store.set({ snapshot: connected({ joint: { r: 1, a: 2, z: 0, h: null }, probe: null }) });
        expect(cell.parentElement!.classList.contains("hidden")).toBe(true);
    });

    test("the focus jog is there with the axis and moves it at its own rate", async () => {
        const { store, ctx, root, calls } = setup({ map: null, probe: null, settings: SETTINGS });
        mountJog(root, ctx);
        const frame = root.querySelector(".focus-axis")!;
        store.set({ snapshot: connected({ joint: { r: 0, a: 0, z: 0, h: null } }) });
        expect(frame.classList.contains("hidden")).toBe(true);
        store.set({ snapshot: connected() });
        expect(frame.classList.contains("hidden")).toBe(false);
        click(frame, "Up");
        click(frame, "Down");
        await settle();
        expect(calls.filter((call) => call.name === "jog").map((call) => call.args[0])).toEqual([
            { kind: "joint", dh: 0.1, feed: null },
            { kind: "joint", dh: -0.1, feed: null },
        ]);
    });
});

describe("height map panel", () => {
    test("the map is drawn as the board seen from above, with values off the mean", () => {
        const map = heightMap([[-1.5, -1.4, -1.3], [-1.6, -1.5, -1.4]]);
        const { store, ctx, root } = setup({ map, probe: null, settings: SETTINGS });
        mountHeightMap(root, ctx);
        store.set({ snapshot: connected(), heightMap: { map, probe: null, settings: SETTINGS } });
        const rows = root.querySelectorAll("table.hm-table tr");
        expect(rows.length).toBe(2);
        const top = rows[0]!.querySelectorAll("td");
        expect(top.length).toBe(3);
        // The top row is the highest Y.
        expect(top[0]!.getAttribute("title")).toBe("X -10.0 Y 5.0: -1.600 mm");
        // The mean is -1.45.
        expect(top[0]!.textContent).toBe("-0.150");
        expect(root.querySelector(".hm-badge")!.textContent).toBe("focus not set");
        expect(root.querySelector(".hm-legend")!.textContent).toContain("span 0.300 mm");
        // A bigger grid carries its values in the tooltip only.
        const wide = heightMap([Array(LABELED_POINTS + 1).fill(0), Array(LABELED_POINTS + 1).fill(0.5)]);
        store.set({ heightMap: { map: wide, probe: null, settings: SETTINGS } });
        expect(root.querySelector("table.hm-table td")!.textContent).toBe("");
    });

    test("probing asks first, then sends the grid in the fields", async () => {
        const { store, ctx, root, calls } = setup({ map: null, probe: null, settings: SETTINGS });
        mountHeightMap(root, ctx);
        store.set({ snapshot: connected({ joint: { r: 0, a: 0, z: 0, h: null } }), heightMap: { map: null, probe: null, settings: SETTINGS } });
        const probe = Array.from(root.querySelectorAll("button")).find((b) => b.textContent === "Probe")!;
        expect(probe.disabled).toBe(true);
        expect(root.textContent).toContain("No focus axis");
        store.set({ snapshot: connected() });
        expect(probe.disabled).toBe(false);
        expect(store.get().probeDraft).toEqual({ x0: -20, y0: -20, x1: 20, y1: 20, nx: 5, ny: 5 });
        store.set({ job: job() });
        click(root, "Fit to job");
        expect(store.get().probeDraft).toEqual({ x0: -5, y0: -4, x1: 7, y1: 3.1, nx: 5, ny: 5 });
        click(root, "Probe");
        await confirm("Probe");
        expect(calls.find((call) => call.name === "probe")?.args[0]).toEqual({ x0: -5, y0: -4, x1: 7, y1: 3.1, nx: 5, ny: 5 });
    });

    test("focus here and a typed offset go to the backend", async () => {
        const map = heightMap([[0, 0], [0, 0]]);
        const { store, ctx, root, calls } = setup({ map, probe: null, settings: SETTINGS });
        mountHeightMap(root, ctx);
        store.set({ snapshot: connected(), heightMap: { map, probe: null, settings: SETTINGS } });
        click(root, "Focus here");
        await settle();
        const field = root.querySelector(".hm-focus input") as HTMLInputElement;
        field.value = "1.25";
        click(root, "Set");
        await settle();
        expect(calls.filter((call) => call.name === "focus").map((call) => call.args[0])).toEqual([null, 1.25]);
    });

    test("a probe setting is sent when its field changes", async () => {
        const { store, ctx, root, calls } = setup({ map: null, probe: null, settings: SETTINGS });
        mountHeightMap(root, ctx);
        store.set({ snapshot: connected(), heightMap: { map: null, probe: null, settings: SETTINGS } });
        const fields = root.querySelectorAll(".hm-probe-settings input");
        const depth = fields[0] as HTMLInputElement;
        expect(depth.value).toBe("5");
        depth.value = "3";
        depth.dispatchEvent(new Event("change"));
        const across = fields[5] as HTMLInputElement;
        across.value = "-1.5";
        across.dispatchEvent(new Event("change"));
        await settle();
        expect(calls.filter((call) => call.name === "probeSettings").map((call) => call.args[0])).toEqual([
            { depth: 3 },
            { offset: [0, -1.5] },
        ]);
    });
});

describe("compensated runs", () => {
    test("the run goes out with the choice, auto once the map is usable", async () => {
        const map = heightMap([[0, 0.1], [0.2, 0.3]], { focus_set: true });
        const { store, ctx, root, calls } = setup({ map, probe: null, settings: SETTINGS });
        mountJobs(root, ctx);
        store.set({ snapshot: connected(), job: job(), heightMap: { map: null, probe: null, settings: SETTINGS } });
        const select = root.querySelector('select[aria-label="Height map"]') as HTMLSelectElement;
        expect(select.value).toBe("off");
        store.set({ heightMap: { map, probe: null, settings: SETTINGS } });
        expect(select.value).toBe("auto");
        click(root, "Run");
        await settle();
        select.value = "power";
        select.dispatchEvent(new Event("change"));
        store.set({ heightMap: { map: null, probe: null, settings: SETTINGS } });
        expect(select.value).toBe("power");
        click(root, "Run");
        await settle();
        expect(calls.filter((call) => call.name === "runJob").map((call) => call.args)).toEqual([["j1", "auto"], ["j1", "power"]]);
    });
});
