// The Plot page, the markers, the preview's grid and a job made again for
// another width. The page's twin of the operations is read against the
// fixture the backend prints for the same samples (mise run mill-fixture),
// which the backend's own tests keep current.

import { describe, expect, test } from "bun:test";

import fixture from "../../backend/tests/data/mill-samples.json" with { type: "json" };
import { parseEvent } from "../src/ws.ts";
import { buildMill, buildMillJob, labelStem, passesOf } from "../src/mock/mill.ts";
import { defaultOperation, recipeOps } from "../src/sketch.ts";
import { GRID_KEY, Preview } from "../src/preview.ts";
import { formatTick, gridLinesIn } from "../src/render/scene.ts";
import type { HolePoint, Job, MillOperation, MillResponse, Path } from "../src/types.ts";
import { PAGES } from "../src/views/tabs.ts";
import { headPosition, mountMarkers, nextMarkerName, withMarker } from "../src/views/markers.ts";
import { MILL_KEY, PLAN_DELAY_MS, fieldText, holeSizes, millNeeds, mountMill, parsePoints, pointsText } from "../src/views/mill.ts";
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
        const made = (): MillResponse => {
            if ("ops" in sample && Array.isArray(sample.ops)) {
                const ops = sample.ops.map((op) => ({ ...defaultOperation(), ...(op as Partial<MillOperation>) }) as MillOperation);
                return buildMillJob("", ops, null, LIMITS, (sample as { job_name?: string | null }).job_name ?? null);
            }
            const op = { ...defaultOperation(), ...((sample as { op?: unknown }).op as Partial<MillOperation>) } as MillOperation;
            return buildMill("", op, ((sample as { holes?: unknown }).holes ?? null) as HolePoint[] | null, LIMITS);
        };
        test(`${sample.name} makes the backend's job`, () => {
            const { job, notes } = made();
            expect(job.name).toBe(sample.name);
            expect(notes).toEqual(sample.notes);
            expect(job.spot).toBe(sample.spot);
            expect(job.outline.length).toBe(sample.outline);
            expect(job.groups.map((group) => group.label)).toEqual(sample.groups.map((group) => group.label));
            job.groups.forEach((group, index) => {
                const expected = sample.groups[index]!;
                expect(group.passes).toBe(expected.passes);
                expect(group.depth).toBe(expected.depth);
                expect(group.tool).toBe(expected.tool as "spindle" | "laser");
                expect(group.power).toBe(expected.power);
                expect(close(group.paths, expected.paths as number[][][])).toBe(true);
            });
        });
    }

    test("refuses what cannot be cut, as the backend does", () => {
        const pocket: MillOperation = { ...defaultOperation("pocket"), x1: 1.5, y1: 10, tool: 2 };
        expect(() => buildMill("", pocket, null, LIMITS)).toThrow("narrower than the bit");
        expect(() => buildMill("", { ...pocket, x1: 20, stepover: 0.9 }, null, LIMITS)).toThrow("corners");
        expect(() => buildMill("", { ...defaultOperation("holes") }, [], LIMITS)).toThrow("no drill holes");
        // A laser circle the spot fills: nothing to burn standing still.
        const dot: MillOperation = { ...defaultOperation("pocket"), cutter: "laser", shape: "circle", cx: 5, cy: 5, diameter: 0.2, tool: 0.2 };
        const fills = "the 0.2 mm spot fills the 0.2 mm circle, and a beam burns nothing standing still: mark its middle with a drill point, or give a wider circle";
        expect(() => buildMill("", dot, null, LIMITS)).toThrow(fills);
        expect(() => buildMill("", { ...dot, kind: "profile", side: "inside" }, null, LIMITS)).toThrow(fills);
        expect(buildMill("", { ...dot, diameter: 0.21 }, null, LIMITS).job.groups[0]!.paths[0]!.length).toBeGreaterThan(2);
        expect(passesOf({ ...defaultOperation(), depth: 1, step_down: 0.3 })).toBe(4);
        expect(labelStem("bore 3.20 mm holes (4)")).toBe("bore # mm holes (#)");
    });
});

describe("the operation's fields", () => {
    test("points are read a line each and written back", () => {
        expect(parsePoints("1, 2\n\n-3.5 4\n5;6")).toEqual([[1, 2], [-3.5, 4], [5, 6]]);
        expect(parsePoints("1, 2\nthree")).toBe("line 2 is not x, y: three");
        expect(pointsText([[1, 2.5]])).toBe("1.000, 2.500");
        // A number with more than three decimals keeps them, to read back as it.
        expect(pointsText([[1.5875, 25.4 / 3]])).toBe(`1.5875, ${25.4 / 3}`);
        expect([fieldText(0), fieldText(0.79375), fieldText(-3.25)]).toEqual(["0.000", "0.79375", "-3.250"]);
    });

    test("each kind asks for its own fields", () => {
        expect(millNeeds("drill", "rect")).toMatchObject({ points: true, closed: false, rect: false, direction: false });
        expect(millNeeds("pocket", "circle")).toMatchObject({ circle: true, rect: false, stepover: true, direction: true, side: false });
        expect(millNeeds("profile", "rect")).toMatchObject({ rect: true, side: true, stepover: false });
        expect(millNeeds("face", "circle")).toMatchObject({ rect: true, shape: false, direction: false });
    });

    test("a job's holes are counted by size", () => {
        expect(holeSizes([[0, 0, 0.8], [1, 1, 0.801], [2, 2, 3]])).toEqual([{ size: 0.8, count: 2 }, { size: 3, count: 1 }]);
        // A half rounded up, as the backend tells the sizes sent back apart.
        expect(holeSizes([[0, 0, 3.175], [1, 1, 0.305]])).toEqual([{ size: 0.31, count: 1 }, { size: 3.18, count: 1 }]);
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

describe("Plot page", () => {
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
        click(root, "New job");
        await wait(20);
        expect(calls.some((call) => call.name === "makeMill")).toBe(true);
        expect(store.get().job?.name).toBe("pocket 20 x 10 mm");
        expect(store.get().job?.source).toBe("mill");
        expect(store.get().job?.recipe?.ops?.length).toBe(1);
        // Remembered for the next visit.
        expect(JSON.parse(localStorage.getItem(MILL_KEY) ?? "{}").kind).toBe("pocket");
    });

    test("builds a job of several operations: add, take one back in the fields, apply, reorder, remove", async () => {
        const { root, store, calls } = mountPage();
        const tab = document.createElement("nav");
        const badge = (): string => root.querySelector(".plot-state")?.getAttribute("data-state") ?? "";
        expect(badge()).toBe("new");
        click(root, "Pocket");
        type(root.querySelectorAll<HTMLInputElement>('[aria-label="Corner x"]')[1]!, "20");
        type(root.querySelectorAll<HTMLInputElement>('[aria-label="Corner y"]')[1]!, "10");
        click(root, "New job");
        await wait(30);
        const id = store.get().job!.id;
        expect(badge()).toBe("applied");
        // A second operation goes at the end of the same job. The fields
        // were the first operation, so the mark says which one Apply would
        // replace.
        click(root, "Drill");
        type(input(root, "Points"), "30, 5");
        expect(badge()).toBe("changed");
        expect(root.querySelector(".plot-state")?.textContent).toBe("changed from operation 1");
        click(root, "Add to job");
        await wait(30);
        let job = store.get().job!;
        expect(job.id).toBe(id);
        expect(job.recipe?.ops?.map((op) => op.kind)).toEqual(["pocket", "drill"]);
        expect(job.groups.map((group) => group.label)).toEqual(["pocket 20 x 10 mm", "drill 1 points"]);
        expect(badge()).toBe("applied");
        expect(root.querySelectorAll(".plot-op").length).toBe(2);
        // The first one back in the fields, changed: marked, and counted on the tab.
        findButton(root, "pocket 20 x 10 at 10, 5").click();
        expect(input(root, "Corner radius").value).toBe("0.000");
        expect(badge()).toBe("applied");
        type(input(root, "Corner radius"), "2");
        expect(badge()).toBe("changed");
        expect(store.get().pending["plot"]).toBe(1);
        click(root, "Apply");
        await wait(30);
        job = store.get().job!;
        expect(job.id).toBe(id);
        expect(job.groups[0]!.label).toBe("pocket 20 x 10 mm, corners R2");
        expect(badge()).toBe("applied");
        expect(store.get().pending["plot"]).toBeUndefined();
        // The drill before the pocket, then out of the job.
        root.querySelectorAll<HTMLButtonElement>(".plot-op .button-row button")[2]!.click();
        await wait(30);
        expect(store.get().job!.recipe?.ops?.map((op) => op.kind)).toEqual(["drill", "pocket"]);
        expect(root.querySelector(".plot-op.editing")?.textContent).toContain("pocket");
        root.querySelectorAll<HTMLButtonElement>(".plot-op .button-row button")[1]!.click();
        await settle();
        dialogButton("Remove").click();
        await wait(30);
        expect(store.get().job!.recipe?.ops?.map((op) => op.kind)).toEqual(["pocket"]);
        expect(calls.filter((call) => call.name === "makeMill").length).toBe(5);
        tab.remove();
    });

    test("an operation taken back in the fields reads as it was kept: an inch bit, arithmetic, either way a rectangle is given", async () => {
        const { root, store } = mountPage();
        const badge = (): string => root.querySelector(".plot-state")?.getAttribute("data-state") ?? "";
        type(input(root, "Bit mm"), "1/16 in");
        click(root, "Pocket");
        type(root.querySelectorAll<HTMLInputElement>('[aria-label="Corner x"]')[1]!, "25.4/3");
        type(root.querySelectorAll<HTMLInputElement>('[aria-label="Corner y"]')[1]!, "10");
        click(root, "New job");
        await wait(30);
        click(root, "Drill");
        type(input(root, "Points"), "30, 5");
        click(root, "Add to job");
        await wait(30);
        expect(store.get().job!.recipe?.ops?.map((op) => op.tool)).toEqual([1.5875, 1.5875]);
        findButton(root, "pocket 8.467 x 10 at 4.233, 5").click();
        expect(input(root, "Bit mm").value).toBe("1.5875");
        expect(root.querySelectorAll<HTMLInputElement>('[aria-label="Corner x"]')[1]!.value).toBe(String(25.4 / 3));
        expect(input(root, "Depth mm").value).toBe("0.500");
        expect(badge()).toBe("applied");
        expect(store.get().pending["plot"]).toBeUndefined();
        // The same rectangle given by its center and size still reads as
        // kept, shown to the micron, and carried back to its corners.
        click(root, "Center and size");
        expect(input(root, "Width").value).toBe("8.467");
        expect(badge()).toBe("applied");
        findButton(root, "pocket 8.467 x 10 at 4.233, 5").click();
        expect(badge()).toBe("applied");
        click(root, "Corners");
        expect(badge()).toBe("applied");
        type(input(root, "Depth mm"), "0.8");
        click(root, "Apply");
        await wait(30);
        const first = store.get().job!.recipe!.ops![0]!;
        expect([first.depth, first.tool, first.x1]).toEqual([0.8, 1.5875, 25.4 / 3]);
        expect(badge()).toBe("applied");
    });

    test("a rectangle by its center and size, with rounded corners, and its sizes drawn as a sketch's", async () => {
        const { root, store, calls } = mountPage();
        click(root, "Pocket");
        type(root.querySelectorAll<HTMLInputElement>('[aria-label="Corner x"]')[1]!, "20");
        type(root.querySelectorAll<HTMLInputElement>('[aria-label="Corner y"]')[1]!, "10");
        click(root, "Center and size");
        expect([input(root, "Center x").value, input(root, "Center y").value, input(root, "Width").value, input(root, "Height").value]).toEqual(["10.000", "5.000", "20.000", "10.000"]);
        type(input(root, "Width"), "25.4/2");
        type(input(root, "Corner radius"), "1.5");
        await wait(PLAN_DELAY_MS + 30);
        const sent = calls.filter((call) => call.name === "planMill").at(-1)!.args[0] as { ops: MillOperation[] };
        expect(sent.ops[0]!.x0).toBeCloseTo(3.65, 9);
        expect(sent.ops[0]!.x1).toBeCloseTo(16.35, 9);
        expect(sent.ops[0]).toMatchObject({ y0: 0, y1: 10, corner: 1.5 });
        expect(store.get().millPlan?.groups[0]?.label).toBe("pocket 12.7 x 10 mm, corners R1.5");
        const dims = store.get().millDims;
        expect(dims.filter((dim) => dim.kind === "linear").map((dim) => dim.text)).toEqual(["12.7", "10"]);
        expect(dims.find((dim) => dim.kind === "radius")?.text).toBe("R1.5");
        expect(dims.find((dim) => dim.kind === "point")?.text).toBe("10, 5");
        // Back to corners, the rectangle carried across.
        click(root, "Corners");
        expect(root.querySelectorAll<HTMLInputElement>('[aria-label="Corner x"]')[0]!.value).toBe("3.650");
        // A face has no corner radius.
        click(root, "Face");
        expect(input(root, "Corner radius").closest(".hidden")).not.toBeNull();
    });

    test("cuts with the machine's laser: spot, power and passes, a point marked with a ring", async () => {
        const { root, store, calls } = mountPage();
        const profile = { kinematics: "cartesian" as const, tool: "laser" as const, h_axis: false, r_max: 300, z_max: 200 };
        store.set({ snapshot: { ...connected(), profile } });
        click(root, "Drill");
        type(input(root, "Points"), "1, 2");
        const shown = (label: string): boolean => !input(root, label).closest(".labeled")!.classList.contains("hidden");
        expect([shown("Spot mm"), shown("Power S"), shown("Passes")]).toEqual([true, true, true]);
        expect([shown("Bit mm"), shown("Depth mm"), shown("Spindle S")]).toEqual([false, false, false]);
        type(input(root, "Power S"), "300");
        type(input(root, "Passes"), "2");
        await wait(PLAN_DELAY_MS + 30);
        const plan = store.get().millPlan!;
        expect(plan.groups[0]!.label).toBe("mark 1 points");
        expect([plan.groups[0]!.tool, plan.groups[0]!.power, plan.groups[0]!.passes]).toEqual(["laser", 300, 2]);
        expect(plan.groups[0]!.paths[0]!.length).toBeGreaterThan(8);
        const sent = calls.filter((call) => call.name === "planMill").at(-1)!.args[0] as { ops: { cutter: string; tool: number }[] };
        expect(sent.ops[0]).toMatchObject({ cutter: "laser", tool: 0.1 });
        expect(root.textContent).toContain("a point burns a spot-wide ring");
        // A spindle machine: the bit's fields again, planned for it.
        store.set({ snapshot: { ...connected(), profile: { ...profile, tool: "spindle" } } });
        await wait(PLAN_DELAY_MS + 30);
        expect(store.get().millPlan!.groups[0]!.label).toBe("drill 1 points");
        expect(shown("Bit mm")).toBe(true);
        // Each machine keeps its own width.
        expect(JSON.parse(localStorage.getItem(MILL_KEY) ?? "{}")).toMatchObject({ cutter: "spindle", bit: 1, spot: 0.1 });
    });

    test("keeps the cutter it was using when the machine goes away", async () => {
        const { root, store } = mountPage();
        const profile = { kinematics: "cartesian" as const, tool: "laser" as const, h_axis: false, r_max: 300, z_max: 200 };
        const shown = (label: string): boolean => !input(root, label).closest(".labeled")!.classList.contains("hidden");
        click(root, "Drill");
        type(input(root, "Points"), "1, 2");
        // Nothing was stored when the page was mounted: a spindle then.
        store.set({ snapshot: { ...connected(), profile } });
        expect(shown("Spot mm")).toBe(true);
        store.set({ snapshot: { ...connected(), profile, connected: false } });
        expect([shown("Spot mm"), shown("Bit mm")]).toEqual([true, false]);
        expect(JSON.parse(localStorage.getItem(MILL_KEY) ?? "{}").cutter).toBe("laser");
        await wait(PLAN_DELAY_MS + 30);
        expect(store.get().millPlan?.groups[0]?.tool).toBe("laser");
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

    test("puts the head and the markers where they are on the board into a moved job", async () => {
        const { root, store, backend, ctx } = mountPage();
        const spindle = { kinematics: "cartesian" as const, tool: "spindle" as const, h_axis: true, r_max: 300, z_max: 200 };
        store.set({ snapshot: connected({ board: { x: 3, y: 4 } }, { profile: spindle }), markers: [{ name: "A", x: 7, y: 8 }] });
        const made = (await backend.makeMill({ ops: [{ ...defaultOperation("pocket"), x1: 20, y1: 10, tool: 1 }] })).job;
        // Lined up with the stock: moved 10 mm in x, then a quarter turn about the origin.
        await backend.patchJob(made.id, { offset: { x: 10, y: 0 }, turn: 90, about: "origin" });
        await ctx.refreshJobs();
        await ctx.selectJob(made.id);
        click(root, "Drill");
        type(input(root, "Points"), "");
        click(root, "Add here");
        click(root, "All markers");
        click(root, "Add to job");
        await wait(30);
        const drilled = (job: Job): number[][] => job.groups.at(-1)!.paths.map((path) => path[0]!.map((v) => Math.round(v * 1e6) / 1e6));
        expect(drilled(store.get().job!)).toEqual([[3, 4], [7, 8]]);
        // A corner from the head, applied in place of the pocket's.
        findButton(root, "pocket 20 x 10 at 10, 5").click();
        findButton(root.querySelector(".mill-point")!, "Here").click();
        click(root, "Apply");
        await wait(30);
        // The pocket's corner is at the head on the board, its bit half a millimeter in.
        const corner = store.get().job!.groups[0]!.paths.flat();
        expect(Math.max(...corner.map(([x]) => x))).toBeCloseTo(2.5, 6);
        expect(Math.min(...corner.map(([, y]) => y))).toBeCloseTo(4.5, 6);
        // A new job of the fields is put as the selected one is, where the plan shows it.
        click(root, "Drill");
        type(input(root, "Points"), "");
        click(root, "Add here");
        click(root, "New job");
        await wait(30);
        const fresh = store.get().job!;
        expect(fresh.id).not.toBe(made.id);
        expect(drilled(fresh)).toEqual([[3, 4]]);
        expect(fresh.offset.x).toBeCloseTo(0, 9);
        expect(fresh.offset.y).toBeCloseTo(10, 9);
        expect(fresh.rotation).toBe(90);
        // The hint names the frame the fields are in.
        expect(root.textContent).toContain("before it was moved");
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

    test("a holes operation keeps its own holes when applied, and a board job's holes land on the board's in a moved job", async () => {
        const { root, store, calls, backend, ctx } = mountPage();
        const board: Job = await backend.job((await backend.jobs())[0]!.id);
        board.holes = [[10, 10, 0.8]];
        await store.set({ jobs: await backend.jobs() });
        click(root, "Holes");
        type(input(root, "Bit mm"), "0.8");
        const select = input(root, "Job with holes") as unknown as HTMLSelectElement;
        select.value = board.id;
        select.dispatchEvent(new Event("change"));
        await wait(30);
        click(root, "New job");
        await wait(30);
        const plot = store.get().job!;
        expect(plot.groups[0]!.paths).toEqual([[[10, 10]]]);
        // Both lined up with the stock by the same move, 5 mm in x.
        await backend.patchJob(board.id, { offset: { x: board.offset.x + 5, y: board.offset.y } });
        await backend.patchJob(plot.id, { offset: { x: 5, y: 0 } });
        await ctx.refreshJobs();
        await ctx.reloadJob(plot.id);
        findButton(root, "holes (1), 0.8 mm").click();
        await wait(30);
        expect(root.querySelector(".plot-state")?.getAttribute("data-state")).toBe("applied");
        type(input(root, "Depth mm"), "0.8");
        click(root, "Apply");
        await wait(30);
        const sent = calls.filter((call) => call.name === "makeMill").at(-1)!.args[0] as { ops: MillOperation[] };
        expect(sent.ops[0]!.holes).toEqual([[10, 10, 0.8]]);
        expect(store.get().job!.groups[0]!.paths).toEqual([[[15, 10]]]);
        expect(store.get().job!.groups[0]!.depth).toBe(0.8);
        // The board job's holes taken again beside them land on its hole too.
        const added = await backend.makeMill({ ops: [...recipeOps(store.get().job!.recipe), { ...defaultOperation("holes"), job: board.id, tool: 0.8 }], job: plot.id });
        expect(added.job.groups.map((group) => group.paths)).toEqual([[[[15, 10]]], [[[15, 10]]]]);
        expect(added.job.recipe?.ops?.[1]?.holes).toEqual([[10, 10, 0.8]]);
    });

    test("changing a job's operations keeps the settings set on the Jobs page", async () => {
        const { backend } = setup();
        const pocket: MillOperation = { ...defaultOperation("pocket"), x1: 20, y1: 10, tool: 2, depth: 1, step_down: 0.3, stepover: 0.5 };
        const profile: MillOperation = { ...defaultOperation("profile"), x0: -5, y0: -5, x1: 25, y1: 15, tool: 2 };
        const made = (await backend.makeMill({ ops: [pocket, profile], name: "part" })).job;
        await backend.patchJob(made.id, { groups: [{ index: 0, speed: 120 }, { index: 1, enabled: false, focus: 0.5 }] });
        const send = async (ops: MillOperation[]): Promise<unknown[][]> => {
            const job = (await backend.makeMill({ ops, name: "part", job: made.id })).job;
            return job.groups.map((group) => [group.label.split(" ")[0], group.enabled, group.speed, group.depth, group.focus ?? null]);
        };
        // Apply: what the pocket's fields did not change keeps the Jobs
        // page's setting; the other operation keeps all of its own.
        const deeper = { ...pocket, depth: 1.5 };
        expect(await send([deeper, profile])).toEqual([["pocket", true, 120, 1.5, null], ["profile", false, 300, 0.5, 0.5]]);
        // Add, Up and Remove: every group keeps its settings wherever it goes.
        const drill: MillOperation = { ...defaultOperation("drill"), points: [[30, 5]], tool: 2, depth: 1, step_down: 0.5 };
        expect(await send([deeper, profile, drill])).toEqual([["pocket", true, 120, 1.5, null], ["profile", false, 300, 0.5, 0.5], ["drill", true, 300, 1, null]]);
        expect(await send([profile, deeper, drill])).toEqual([["profile", false, 300, 0.5, 0.5], ["pocket", true, 120, 1.5, null], ["drill", true, 300, 1, null]]);
        expect(await send([profile, drill])).toEqual([["profile", false, 300, 0.5, 0.5], ["drill", true, 300, 1, null]]);
        // A field changed on the Plot page wins over the Jobs page's setting.
        expect(await send([{ ...profile, speed: 200 }, drill])).toEqual([["profile", false, 200, 0.5, 0.5], ["drill", true, 300, 1, null]]);
    });

    test("a name typed for one job is not given to the next one selected", async () => {
        const { root, store, backend, ctx } = mountPage();
        const drill = (x: number): MillOperation => ({ ...defaultOperation("drill"), points: [[x, x]] });
        const bracket = (await backend.makeMill({ ops: [drill(1), drill(2)], name: "bracket" })).job;
        click(root, "Drill");
        type(input(root, "Points"), "5, 5");
        type(input(root, "Job name"), "plate");
        click(root, "New job");
        await wait(30);
        expect(store.get().job!.name).toBe("plate");
        // The name stays with the job it was typed for while that job is selected.
        expect(input(root, "Job name").value).toBe("plate");
        await ctx.refreshJobs();
        await ctx.selectJob(bracket.id);
        // Up touches no field: the job keeps its own name.
        root.querySelectorAll<HTMLButtonElement>(".plot-op .button-row button")[2]!.click();
        await wait(30);
        expect((await backend.job(bracket.id)).name).toBe("bracket");
        expect((await backend.jobs()).filter((job) => job.name === "plate").length).toBe(1);
        expect(input(root, "Job name").value).toBe("");
    });

    test("runs the selected job from its run panel", async () => {
        const { run, store, calls, backend } = mountPage();
        const job = await backend.makeMill({ ops: [{ ...defaultOperation("drill"), points: [[1, 1]] }] });
        store.set({ snapshot: connected(), job: job.job });
        expect(run.querySelector(".run-job")?.textContent).toBe("drill 1 points");
        click(run, "Run");
        await settle();
        expect(calls.find((call) => call.name === "runJob")?.args).toEqual([job.job.id, "off", false]);
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
        const lines = gridLinesIn(5, { x0: -12, y0: -12, x1: 12, y1: 12 });
        expect(lines.length).toBe(8);
        expect(lines[0]).toEqual({ from: [-10, -12], to: [-10, 12], major: true });
        expect(lines.some((line) => line.from[0] === 0 && line.from[1] === -12)).toBe(false);
        expect(gridLinesIn(0, { x0: -10, y0: -10, x1: 10, y1: 10 })).toEqual([]);
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
        preview.setShowGrid(false);
        expect(preview.showGrid).toBe(false);
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
        const made = (await backend.makeMill({ ops: [{ ...defaultOperation("pocket"), x1: 20, y1: 10, tool: 2, stepover: 0.5 }] })).job;
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
        mountJobs(harness.root, harness.ctx, harness.root);
        const made = (await harness.backend.makeMill({ ops: [{ ...defaultOperation("drill"), points: [[1, 1]], tool: 0.8 }] })).job;
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

test("the Plot page has a tab", () => {
    expect(PAGES.map((page) => page.id)).toEqual(["overview", "jobs", "plot", "cam", "pnp", "auto", "config", "connection", "plugins"]);
});
