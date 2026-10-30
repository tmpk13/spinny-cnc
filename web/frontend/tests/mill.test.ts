// The Mill page, the markers, the preview's grid and a job made again for
// another width. The page's twin of the operations is read against the
// fixture the backend prints for the same samples (mise run mill-fixture),
// which the backend's own tests keep current.

import { describe, expect, test } from "bun:test";

import fixture from "../../backend/tests/data/mill-samples.json" with { type: "json" };
import { parseEvent } from "../src/ws.ts";
import { buildMill, defaultOperation, labelStem, passesOf } from "../src/mock/mill.ts";
import { GRID_KEY, Preview, formatTick, gridLines } from "../src/preview.ts";
import type { HolePoint, Job, MillOperation, Path } from "../src/types.ts";
import { PAGES } from "../src/views/tabs.ts";
import { headPosition, mountMarkers, nextMarkerName, withMarker } from "../src/views/markers.ts";
import { MILL_KEY, PLAN_DELAY_MS, holeSizes, millNeeds, mountMill, parsePoints, pointsText } from "../src/views/mill.ts";
import { mountJobs, widthMode } from "../src/views/jobs.ts";
import { mountPreviewPanel } from "../src/views/previewpanel.ts";
import { click, connected, dialogButton, findButton, settle, setup } from "./harness.ts";

const LIMITS = { rRate: 560, aRate: 400, tolerance: 0.005 };
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function close(a: Path[], b: number[][][]): boolean {
    return a.length === b.length && a.every((path, i) => path.length === b[i]!.length
        && path.every(([x, y], j) => Math.abs(x - b[i]![j]![0]!) < 1e-6 && Math.abs(y - b[i]![j]![1]!) < 1e-6));
}

describe("the mock's operations", () => {
    for (const sample of fixture) {
        const op = { ...defaultOperation(), ...(sample.op as Partial<MillOperation>) } as MillOperation;
        test(`${sample.name} makes the backend's job`, () => {
            const { job, notes } = buildMill("", op, (sample.holes ?? null) as HolePoint[] | null, LIMITS);
            expect(job.name).toBe(sample.name);
            expect(notes).toEqual(sample.notes);
            expect(job.spot).toBe(sample.spot);
            expect(job.outline.length).toBe(sample.outline);
            expect(job.groups.map((group) => group.label)).toEqual(sample.groups.map((group) => group.label));
            job.groups.forEach((group, index) => {
                const expected = sample.groups[index]!;
                expect(group.passes).toBe(expected.passes);
                expect(group.depth).toBe(expected.depth);
                expect(group.tool).toBe("spindle");
                expect(close(group.paths, expected.paths as number[][][])).toBe(true);
            });
        });
    }

    test("refuses what cannot be cut, as the backend does", () => {
        const pocket: MillOperation = { ...defaultOperation("pocket"), x1: 1.5, y1: 10, tool: 2 };
        expect(() => buildMill("", pocket, null, LIMITS)).toThrow("narrower than the bit");
        expect(() => buildMill("", { ...pocket, x1: 20, stepover: 0.9 }, null, LIMITS)).toThrow("corners");
        expect(() => buildMill("", { ...defaultOperation("holes") }, [], LIMITS)).toThrow("no drill holes");
        expect(passesOf({ ...defaultOperation(), depth: 1, step_down: 0.3 })).toBe(4);
        expect(labelStem("bore 3.20 mm holes (4)")).toBe("bore # mm holes (#)");
    });
});

describe("the operation's fields", () => {
    test("points are read a line each and written back", () => {
        expect(parsePoints("1, 2\n\n-3.5 4\n5;6")).toEqual([[1, 2], [-3.5, 4], [5, 6]]);
        expect(parsePoints("1, 2\nthree")).toBe("line 2 is not x, y: three");
        expect(pointsText([[1, 2.5]])).toBe("1.000, 2.500");
    });

    test("each kind asks for its own fields", () => {
        expect(millNeeds("drill", "rect")).toMatchObject({ points: true, closed: false, rect: false, direction: false });
        expect(millNeeds("pocket", "circle")).toMatchObject({ circle: true, rect: false, stepover: true, direction: true, side: false });
        expect(millNeeds("profile", "rect")).toMatchObject({ rect: true, side: true, stepover: false });
        expect(millNeeds("face", "circle")).toMatchObject({ rect: true, shape: false, direction: false });
    });

    test("a job's holes are counted by size", () => {
        expect(holeSizes([[0, 0, 0.8], [1, 1, 0.801], [2, 2, 3]])).toEqual([{ size: 0.8, count: 2 }, { size: 3, count: 1 }]);
    });
});

function mountPage() {
    localStorage.removeItem(MILL_KEY);
    const harness = setup();
    const run = document.createElement("section");
    document.body.appendChild(run);
    mountMill({ operation: harness.root, run }, harness.ctx);
    return { ...harness, run };
}

function input(root: ParentNode, label: string): HTMLInputElement {
    const found = root.querySelector<HTMLInputElement>(`[aria-label="${label}"]`);
    if (!found) {
        throw new Error(`no field ${label}`);
    }
    return found;
}

function type(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    field.value = value;
    field.dispatchEvent(new Event("input"));
}

describe("Mill page", () => {
    test("plans the operation as it is typed and makes it into the selected job", async () => {
        const { root, store, calls } = mountPage();
        click(root, "Pocket");
        type(input(root, "Corner x"), "0");
        type(root.querySelectorAll<HTMLInputElement>('[aria-label="Corner y"]')[0]!, "0");
        type(root.querySelectorAll<HTMLInputElement>('[aria-label="Corner x"]')[1]!, "20");
        type(root.querySelectorAll<HTMLInputElement>('[aria-label="Corner y"]')[1]!, "10");
        await wait(PLAN_DELAY_MS + 30);
        const plan = store.get().millPlan;
        expect(plan?.groups[0]?.label).toBe("pocket 20 x 10 mm");
        expect(plan?.id).toBe("");
        expect(root.querySelector(".mill-notes")?.textContent).toContain("pass");
        click(root, "Make job");
        await wait(20);
        expect(calls.some((call) => call.name === "makeMill")).toBe(true);
        expect(store.get().job?.name).toBe("pocket 20 x 10 mm");
        expect(store.get().job?.source).toBe("mill");
        expect(store.get().millPlan).toBeNull();
        // Remembered for the next visit.
        expect(JSON.parse(localStorage.getItem(MILL_KEY) ?? "{}").kind).toBe("pocket");
    });

    test("says what is wrong instead of planning", async () => {
        const { root, store } = mountPage();
        click(root, "Drill");
        type(input(root, "Points"), "1, 2\nnot a point");
        await wait(PLAN_DELAY_MS + 30);
        expect(store.get().millPlan).toBeNull();
        expect(root.querySelector(".mill-problem")?.textContent).toBe("line 2 is not x, y: not a point");
        type(input(root, "Points"), "1, 2");
        type(input(root, "Bit mm"), "0");
        await wait(PLAN_DELAY_MS + 30);
        expect(root.querySelector(".mill-problem")?.textContent).toContain("bit");
    });

    test("takes a corner from the head and points from the markers", async () => {
        const { root, store } = mountPage();
        store.set({ snapshot: connected({ board: { x: 3.25, y: -1.5 } }), markers: [{ name: "A", x: 7, y: 8 }, { name: "B", x: 9, y: 1 }] });
        click(root, "Face");
        findButton(root.querySelector(".mill-point")!, "Here").click();
        expect(input(root, "Corner x").value).toBe("3.250");
        expect(input(root, "Corner y").value).toBe("-1.500");
        click(root, "Line");
        type(input(root, "Points"), "");
        click(root, "All markers");
        click(root, "Add here");
        expect(input(root, "Points").value).toBe("7.000, 8.000\n9.000, 1.000\n3.250, -1.500");
        await wait(PLAN_DELAY_MS + 30);
        expect(store.get().millPlan?.groups[0]?.label).toBe("line through 3 points");
    });

    test("drills a board job's holes, a group a size, leaving out the sizes unchecked", async () => {
        const { root, store, backend } = mountPage();
        const board: Job = await backend.job((await backend.jobs())[0]!.id);
        board.holes = [[0, 0, 0.8], [4, 0, 0.8], [8, 0, 3]];
        await store.set({ jobs: await backend.jobs() });
        click(root, "Holes");
        const select = input(root, "Job with holes") as unknown as HTMLSelectElement;
        select.value = board.id;
        select.dispatchEvent(new Event("change"));
        await wait(PLAN_DELAY_MS + 30);
        expect(store.get().millPlan?.groups.map((group) => group.label)).toEqual(["drill 0.80 mm holes (2)", "bore 3.00 mm holes (1)"]);
        const three = input(root, "3 mm holes");
        three.checked = false;
        three.dispatchEvent(new Event("change"));
        await wait(PLAN_DELAY_MS + 30);
        expect(store.get().millPlan?.groups.map((group) => group.label)).toEqual(["drill 0.80 mm holes (2)"]);
        expect(store.get().millPlan?.name).toBe(`${board.name} holes`);
    });

    test("runs the selected job from its run panel", async () => {
        const { run, store, calls, backend } = mountPage();
        const job = await backend.makeMill({ ...defaultOperation("drill"), points: [[1, 1]] });
        store.set({ snapshot: connected(), job: job.job });
        expect(run.querySelector(".mill-run-job")?.textContent).toBe("drill 1 points");
        click(run, "Run");
        await settle();
        expect(calls.find((call) => call.name === "runJob")?.args).toEqual([job.job.id, "off"]);
    });
});

describe("markers", () => {
    test("names and replaces", () => {
        expect(nextMarkerName([{ name: "M1", x: 0, y: 0 }, { name: "M3", x: 0, y: 0 }])).toBe("M2");
        const moved = withMarker([{ name: "a", x: 0, y: 0 }, { name: "b", x: 1, y: 1 }], { name: "a", x: 5, y: 5 });
        expect(moved).toEqual([{ name: "a", x: 5, y: 5 }, { name: "b", x: 1, y: 1 }]);
    });

    test("are marked where the head is, gone to, and deleted", async () => {
        const harness = setup();
        mountMarkers(harness.root, harness.ctx);
        harness.store.set({ snapshot: connected({ board: { x: 1.2345, y: -6 } }) });
        expect(headPosition(harness.store.get())).toEqual({ x: 1.2345, y: -6 });
        click(harness.root, "Mark here");
        await settle();
        expect(harness.store.get().markers).toEqual([{ name: "M1", x: 1.235, y: -6 }]);
        expect(harness.events.some((event) => event.type === "markers")).toBe(true);
        click(harness.root, "Go");
        await settle();
        expect(harness.calls.find((call) => call.name === "goto")?.args).toEqual([{ kind: "board", x: 1.235, y: -6 }]);
        click(harness.root, "Delete");
        await settle();
        expect(harness.store.get().markers).toEqual([]);
    });

    test("reach every page through the event feed", () => {
        const event = parseEvent(JSON.stringify({ type: "markers", markers: [{ name: "a", x: 1, y: 2 }] }));
        expect(event).toEqual({ type: "markers", data: { markers: [{ name: "a", x: 1, y: 2 }] } });
    });
});

describe("the preview's grid", () => {
    test("lines span the grid either side of the axis, the axis left out", () => {
        const lines = gridLines(5, 12);
        expect(lines.length).toBe(8);
        expect(lines[0]).toEqual([[-10, -10], [-10, 10]]);
        expect(lines.some(([a]) => a[0] === 0 && a[1] === -10)).toBe(false);
        expect(gridLines(0, 10)).toEqual([]);
        expect(formatTick(-2.5)).toBe("-2.5");
        expect(formatTick(1.0000000002)).toBe("1");
    });

    test("follows the machine until one is picked, and the pick is kept", () => {
        localStorage.removeItem(GRID_KEY);
        const canvas = document.createElement("canvas");
        const preview = new Preview(canvas);
        expect(preview.showGrid).toBe(false);
        preview.setLimits({ kinematics: "cartesian", r_max: 50, z_max: 20 });
        expect(preview.showGrid).toBe(true);
        expect(preview.toggleGrid()).toBe(false);
        expect(localStorage.getItem(GRID_KEY)).toBe("0");
        expect(new Preview(document.createElement("canvas")).showGrid).toBe(false);
        preview.setShowGrid(true);
        expect(localStorage.getItem(GRID_KEY)).toBe("1");
        localStorage.removeItem(GRID_KEY);
        preview.setMarkers([{ name: "A", x: 1, y: 2 }]);
        preview.draw();
    });
});

test("a grid picked on one preview panel is picked on every one", () => {
    localStorage.removeItem(GRID_KEY);
    const one = setup();
    const two = setup();
    const first = mountPreviewPanel(one.root, one.ctx);
    const second = mountPreviewPanel(two.root, two.ctx);
    click(one.root, "Grid");
    expect(first.showGrid).toBe(true);
    expect(second.showGrid).toBe(true);
    expect(findButton(two.root, "Grid").getAttribute("aria-pressed")).toBe("true");
    click(two.root, "Grid");
    expect(first.showGrid).toBe(false);
    localStorage.removeItem(GRID_KEY);
});

describe("another width for a job", () => {
    test("is a remake, the width alone, or refused, by what the job keeps", () => {
        const base: Job = { id: "j", name: "j", source: "svg", spot: 0.1, offset: { x: 0, y: 0 }, groups: [], outline: [], copper: [], stats: { length_mm: 0, seconds: 0, max_radius: 0, min_radius: 0, limited_fraction: 0, moves: 0 } };
        expect(widthMode(base)).toBe("width");
        expect(widthMode({ ...base, recipe: { file: "a.gbr", options: {} } })).toBe("remake");
        expect(widthMode({ ...base, source: "gerber" })).toBe("refused");
        expect(widthMode({ ...base, source: "json", copper: [[[0, 0], [1, 0], [1, 1]]] })).toBe("refused");
    });

    test("makes a mill job again for another bit where it was moved, its settings kept", async () => {
        const { backend } = setup();
        const made = (await backend.makeMill({ ...defaultOperation("pocket"), x1: 20, y1: 10, tool: 2, stepover: 0.5 })).job;
        await backend.patchJob(made.id, { offset: { x: 5, y: -3 }, groups: [{ index: 0, speed: 123 }] });
        const wider = await backend.setJobWidth(made.id, 4);
        const xs = wider.groups[0]!.paths.flat().map(([x]) => x);
        expect(Math.min(...xs)).toBeCloseTo(7);
        expect(Math.max(...xs)).toBeCloseTo(23);
        expect(wider.groups[0]!.speed).toBe(123);
        expect(wider.spot).toBe(4);
        expect(wider.offset).toEqual({ x: 5, y: -3 });
    });

    test("the job details make it again with a confirm", async () => {
        const harness = setup();
        mountJobs(harness.root, harness.ctx);
        const made = (await harness.backend.makeMill({ ...defaultOperation("drill"), points: [[1, 1]], tool: 0.8 })).job;
        await harness.ctx.refreshJobs();
        await harness.ctx.selectJob(made.id);
        const field = input(harness.root, "Spot width");
        field.value = "1.2";
        click(harness.root, "Re-cut");
        await settle();
        dialogButton("Re-cut").click();
        await wait(20);
        expect(harness.calls.find((call) => call.name === "setJobWidth")?.args).toEqual([made.id, 1.2]);
        expect(harness.store.get().job?.spot).toBe(1.2);
    });
});

test("the Mill page has a tab", () => {
    expect(PAGES.map((page) => page.id)).toEqual(["machine", "mill", "cam", "pnp", "config"]);
});
