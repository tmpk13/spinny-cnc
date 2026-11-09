import { describe, expect, test } from "bun:test";

import type { Camera } from "../src/camera.ts";
import { formatJson } from "../src/jsontext.ts";
import { jointPreview } from "../src/mock/jobs.ts";
import { defaultOperation } from "../src/mock/mill.ts";
import { Preview } from "../src/preview.ts";
import { boxedAfter, pickedAfter } from "../src/regroup.ts";
import type { Job, MillOperation } from "../src/types.ts";
import { jobText, mountJobJson, placeText, readJobText } from "../src/views/jobjson.ts";
import { mountJobs } from "../src/views/jobs.ts";
import { mountPreviewPanel, shownJob } from "../src/views/previewpanel.ts";
import { connected, dialogButton, settle, setup } from "./harness.ts";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="40mm" viewBox="0 0 40 40">'
    + '<path d="M0 0 L10 0" stroke="#f00"/><path d="M0 10 L10 10" stroke="#f00"/><path d="M0 20 L10 20" stroke="#f00"/>'
    + '<path d="M20 0 L30 0" stroke="#00f"/></svg>';

const W = 400;
const H = 300;
const topDown: Camera = { target: [0, 0, 0], distance: 60, yaw: 0, pitch: 90 };

/** A canvas of a size, as a laid out page would measure it. */
function sized(width: number, height: number): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.getBoundingClientRect = (() => ({ width, height, x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, toJSON: () => ({}) })) as typeof canvas.getBoundingClientRect;
    document.body.appendChild(canvas);
    return canvas;
}

function lineJob(): Job {
    const group = (label: string, paths: [number, number][][]) => ({ label, power: 500, min_power: 0, speed: 400, passes: 1, enabled: true, paths });
    return {
        id: "j1", name: "j", source: "svg", spot: 0.1, offset: { x: 0, y: 0 },
        groups: [group("a", [[[-10, 0], [10, 0]], [[-10, 5], [10, 5]]]), group("b", [[[0, -8], [0, -6]]])],
        outline: [], copper: [],
        stats: { length_mm: 0, seconds: 0, max_radius: 0, min_radius: 0, limited_fraction: 0, moves: 0 },
    };
}

async function settleMany(times = 6): Promise<void> {
    for (let i = 0; i < times; i++) {
        await settle();
    }
}

describe("picking paths in the preview", () => {
    test("a click picks the nearest path within a few px, and a box the paths wholly inside it", () => {
        const preview = new Preview(sized(W, H));
        preview.setJob(lineJob());
        preview.setCamera(topDown);
        const scale = (H / 2) / Math.tan((20 * Math.PI) / 180) / 60;
        const at = (x: number, y: number): [number, number] => [W / 2 + x * scale, H / 2 - y * scale];
        expect(preview.pick(...at(3, 0.05))).toEqual([0, 0]);
        expect(preview.pick(...at(-4, 5.1))).toEqual([0, 1]);
        expect(preview.pick(...at(0, -7))).toEqual([1, 0]);
        // Too far from every line.
        expect(preview.pick(...at(3, 2.5))).toBeNull();
        const [x0, y0] = at(-11, 6);
        const [x1, y1] = at(11, -1);
        expect(preview.pathsIn({ x0, y0, x1, y1 })).toEqual([[0, 0], [0, 1]]);
        // A path only partly inside the box is not in it.
        const [cx, cy] = at(-1, -7);
        const [dx, dy] = at(1, -9);
        expect(preview.pathsIn({ x0: cx, y0: cy, x1: dx, y1: dy })).toEqual([]);
        preview.dispose();
    });

    test("a click picks one, shift adds and takes back, a click on nothing clears", () => {
        expect(pickedAfter([[0, 1]], [0, 0], false)).toEqual([[0, 0]]);
        expect(pickedAfter([[0, 1]], [0, 0], true)).toEqual([[0, 1], [0, 0]]);
        expect(pickedAfter([[0, 1], [0, 0]], [0, 1], true)).toEqual([[0, 0]]);
        expect(pickedAfter([[0, 1]], null, false)).toEqual([]);
        expect(pickedAfter([[0, 1]], null, true)).toEqual([[0, 1]]);
        expect(boxedAfter([[0, 1]], [[0, 1], [1, 0]], true)).toEqual([[0, 1], [1, 0]]);
        expect(boxedAfter([[0, 1]], [[1, 0]], false)).toEqual([[1, 0]]);
    });

    test("a click on the preview's canvas becomes the page's picked paths of the job shown", async () => {
        const { store, ctx, root } = setup();
        const preview = mountPreviewPanel(root, ctx);
        const canvasEl = root.querySelector("canvas.preview") as HTMLCanvasElement;
        canvasEl.getBoundingClientRect = (() => ({ width: W, height: H, x: 0, y: 0, top: 0, left: 0, right: W, bottom: H, toJSON: () => ({}) })) as typeof canvasEl.getBoundingClientRect;
        preview.resize();
        store.set({ job: lineJob() });
        preview.setCamera(topDown);
        const scale = (H / 2) / Math.tan((20 * Math.PI) / 180) / 60;
        const press = (type: string, x: number, y: number, extra: PointerEventInit = {}): void => {
            canvasEl.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, button: 0, bubbles: true, ...extra }));
        };
        press("pointerdown", W / 2 + 3 * scale, H / 2);
        press("pointerup", W / 2 + 3 * scale, H / 2);
        expect(store.get().selection).toEqual({ job: "j1", paths: [[0, 0]] });
        press("pointerdown", W / 2, H / 2 + 7 * scale, { shiftKey: true });
        press("pointerup", W / 2, H / 2 + 7 * scale, { shiftKey: true });
        expect(store.get().selection?.paths).toEqual([[0, 0], [1, 0]]);
        // A drag orbits and picks nothing.
        press("pointerdown", 10, 10);
        press("pointermove", 60, 40);
        press("pointerup", 60, 40);
        expect(store.get().selection?.paths).toEqual([[0, 0], [1, 0]]);
        preview.dispose();
        root.remove();
    });

    test("a path picked on the JSON panel's edit is found in the text and never acted on in the stored job", async () => {
        const { store, ctx, root, api } = setup();
        await api.connect("/dev/ttyACM0");
        store.set({ snapshot: connected() });
        mountJobs(root, ctx);
        mountJobJson(root, ctx);
        const preview = mountPreviewPanel(root, ctx);
        const canvasEl = root.querySelector("canvas.preview") as HTMLCanvasElement;
        canvasEl.getBoundingClientRect = (() => ({ width: W, height: H, x: 0, y: 0, top: 0, left: 0, right: W, bottom: H, toJSON: () => ({}) })) as typeof canvasEl.getBoundingClientRect;
        preview.resize();
        const made = await api.uploadJob(new File([SVG], "lines.svg"), { anchor: "keep" });
        await ctx.refreshJobs();
        await ctx.selectJob(made.id);
        (root.querySelector("details.json-panel") as HTMLDetailsElement).open = true;
        // The blue group's block moved above the red one: drawn, not kept.
        const editor = root.querySelector("textarea.json-input") as HTMLTextAreaElement;
        const text = JSON.parse(editor.value) as Job;
        editor.value = formatJson({ ...text, groups: [...text.groups].reverse() });
        editor.dispatchEvent(new Event("input"));
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(shownJob(store.get())?.groups[0]!.label).toBe("stroke #0000ff");
        preview.setCamera(topDown);
        const scale = (H / 2) / Math.tan((20 * Math.PI) / 180) / 60;
        const press = (type: string, x: number, y: number): void => {
            canvasEl.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, button: 0, bubbles: true }));
        };
        press("pointerdown", W / 2 + 25 * scale, H / 2);
        press("pointerup", W / 2 + 25 * scale, H / 2);
        // The blue line, first in the edit, is found in the text.
        expect(store.get().selection).toEqual({ job: made.id, paths: [[0, 0]], draft: true });
        expect(editor.value.slice(editor.selectionStart, editor.selectionStart + 9)).toBe("[[20, 0],");
        // The Jobs panel offers nothing to do with it: in the stored job
        // [0, 0] is a red line.
        expect((root.querySelector(".picked-row") as HTMLElement).classList.contains("hidden")).toBe(true);
        // Once the edit is thrown away, the stored job's picks work again.
        Array.from(root.querySelectorAll("button")).find((b) => b.textContent === "Revert")!.click();
        press("pointerdown", W / 2 + 25 * scale, H / 2);
        press("pointerup", W / 2 + 25 * scale, H / 2);
        expect(store.get().selection).toEqual({ job: made.id, paths: [[1, 0]] });
        expect((root.querySelector(".picked-row") as HTMLElement).classList.contains("hidden")).toBe(false);
        preview.dispose();
        root.remove();
    });

    test("a Plot page plan of a stored job takes no picks", async () => {
        const { store, ctx, root } = setup();
        const preview = mountPreviewPanel(root, ctx, (state) => state.millPlan ?? state.job);
        const canvasEl = root.querySelector("canvas.preview") as HTMLCanvasElement;
        canvasEl.getBoundingClientRect = (() => ({ width: W, height: H, x: 0, y: 0, top: 0, left: 0, right: W, bottom: H, toJSON: () => ({}) })) as typeof canvasEl.getBoundingClientRect;
        preview.resize();
        const job = lineJob();
        store.set({ job, millPlan: { ...job, groups: [...job.groups].reverse() } });
        preview.setCamera(topDown);
        canvasEl.dispatchEvent(new PointerEvent("pointerdown", { clientX: W / 2, clientY: H / 2, pointerId: 1, button: 0, bubbles: true }));
        canvasEl.dispatchEvent(new PointerEvent("pointerup", { clientX: W / 2, clientY: H / 2, pointerId: 1, button: 0, bubbles: true }));
        expect(store.get().selection).toBeNull();
        preview.dispose();
        root.remove();
    });

    test("the JSON panel's edit is the job shown while it is typed", () => {
        const { store } = setup();
        const job = lineJob();
        store.set({ job });
        expect(shownJob(store.get())).toBe(job);
        const draft = { ...job, name: "edited" };
        store.set({ jobDraft: draft });
        expect(shownJob(store.get())).toBe(draft);
        store.set({ jobDraft: { ...draft, id: "other" } });
        expect(shownJob(store.get())).toBe(job);
    });
});

describe("moving picked paths between groups", () => {
    test("the picked paths go into a new group, then into a group the job has, and out of the job", async () => {
        const { store, ctx, root, api, calls } = setup();
        await api.connect("/dev/ttyACM0");
        store.set({ snapshot: connected() });
        mountJobs(root, ctx);
        const made = await api.uploadJob(new File([SVG], "lines.svg"), { anchor: "keep" });
        await ctx.refreshJobs();
        await ctx.selectJob(made.id);
        const row = root.querySelector(".picked-row") as HTMLElement;
        expect(row.classList.contains("hidden")).toBe(true);
        // A group's name picks its paths.
        const names = Array.from(root.querySelectorAll("button.group-pick")) as HTMLButtonElement[];
        expect(names.map((name) => name.textContent)).toEqual(["stroke #ff0000", "stroke #0000ff"]);
        names[0]!.click();
        expect(store.get().selection).toEqual({ job: made.id, paths: [[0, 0], [0, 1], [0, 2]] });
        expect(row.classList.contains("hidden")).toBe(false);
        expect(row.textContent).toContain("3 paths picked from 1 group");
        // Two of them into a group of their own, named.
        store.set({ selection: { job: made.id, paths: [[0, 2], [0, 0]] } });
        (row.querySelector('input[aria-label="New group name"]') as HTMLInputElement).value = "slow lines";
        Array.from(row.querySelectorAll("button")).find((b) => b.textContent === "Move")!.click();
        await settleMany();
        expect(calls.some((call) => call.name === "replaceJob")).toBe(true);
        let job = store.get().job!;
        expect(job.groups.map((group) => [group.label, group.paths.length])).toEqual([["stroke #ff0000", 1], ["slow lines", 2], ["stroke #0000ff", 1]]);
        // They stay picked where they are now.
        expect(store.get().selection).toEqual({ job: made.id, paths: [[1, 0], [1, 1]] });
        // Into a group the job has: the blue one.
        const target = row.querySelector('select[aria-label="Move picked paths to"]') as HTMLSelectElement;
        target.value = "2";
        target.dispatchEvent(new Event("change"));
        Array.from(row.querySelectorAll("button")).find((b) => b.textContent === "Move")!.click();
        await settleMany();
        job = store.get().job!;
        expect(job.groups.map((group) => [group.label, group.paths.length])).toEqual([["stroke #ff0000", 1], ["stroke #0000ff", 3]]);
        // Out of the job, asked first.
        store.set({ selection: { job: made.id, paths: [[0, 0]] } });
        Array.from(row.querySelectorAll("button")).find((b) => b.textContent === "Delete paths")!.click();
        await settle();
        dialogButton("Delete paths").click();
        await settleMany();
        job = store.get().job!;
        expect(job.groups.map((group) => group.label)).toEqual(["stroke #0000ff"]);
        expect(store.get().selection).toBeNull();
        expect((await api.job(made.id)).groups.length).toBe(1);
        root.remove();
    });

    test("a job made from operations is no longer made again from them once its paths are moved or taken out", async () => {
        const { store, ctx, root, api, calls } = setup();
        await api.connect("/dev/ttyACM0");
        store.set({ snapshot: connected() });
        mountJobs(root, ctx);
        const line = (y: number): MillOperation => ({ ...defaultOperation("line"), depth: 0.3, step_down: 0.3, points: [[0, y], [10, y]] });
        const made = (await api.makeMill({ ops: [line(0), line(5), line(10)] })).job;
        await ctx.refreshJobs();
        await ctx.selectJob(made.id);
        const row = root.querySelector(".picked-row") as HTMLElement;
        const press = (label: string): void => Array.from(row.querySelectorAll("button")).find((b) => b.textContent === label)!.click();
        const sent = (): Job => calls.filter((call) => call.name === "replaceJob").at(-1)!.args[1] as Job;
        // Taken out: asked first, saying the operations would bring it back.
        store.set({ selection: { job: made.id, paths: [[1, 0]] } });
        press("Delete paths");
        await settle();
        expect(document.querySelector("dialog[open]")?.textContent).toContain("no longer made again from its operations");
        dialogButton("Delete paths").click();
        await settleMany();
        expect(sent().recipe).toBeNull();
        expect(store.get().job!.recipe ?? null).toBeNull();
        expect(store.get().job!.groups.length).toBe(2);
        // Another width cannot bring the line back.
        await expect(api.setJobWidth(made.id, 0.2)).rejects.toThrow("nothing is kept to make them again");
        expect((await api.job(made.id)).groups.length).toBe(2);
        // Moved: asked the same way while there is a recipe to lose.
        const other = (await api.makeMill({ ops: [line(0), line(5)] })).job;
        await ctx.refreshJobs();
        await ctx.selectJob(other.id);
        store.set({ selection: { job: other.id, paths: [[1, 0]] } });
        press("Move");
        await settle();
        expect(document.querySelector("dialog[open]")?.textContent).toContain("no longer made again from its operations");
        dialogButton("Move").click();
        await settleMany();
        expect(sent().recipe).toBeNull();
        expect((await api.job(other.id)).recipe ?? null).toBeNull();
        root.remove();
    });
});

describe("arrays of picked paths", () => {
    test("the copies are drawn as the fields change, kept with Make array, and stay picked", async () => {
        const { store, ctx, root, api, calls } = setup();
        mountJobs(root, ctx);
        const made = await api.uploadJob(new File([SVG], "lines.svg"), { anchor: "keep" });
        await ctx.refreshJobs();
        await ctx.selectJob(made.id);
        const row = root.querySelector(".picked-row") as HTMLElement;
        const button = (label: string): HTMLButtonElement => Array.from(row.querySelectorAll("button")).find((b) => b.textContent === label)!;
        const field = (label: string): HTMLInputElement => row.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
        const type = (label: string, value: string): void => {
            field(label).value = value;
            field(label).dispatchEvent(new Event("input"));
        };
        store.set({ selection: { job: made.id, paths: [[1, 0]] } });
        button("Array").click();
        expect(row.querySelector(".array-box")?.classList.contains("hidden")).toBe(false);
        // Three in a row, 5 mm apart: drawn, not yet kept.
        type("Step x", "5");
        let draft = store.get().arrayDraft!;
        expect(draft.groups[1]!.paths.map((path) => path[0])).toEqual([[20, 0], [25, 0], [30, 0]]);
        expect(shownJob(store.get())).toBe(draft);
        expect(row.querySelector(".array-box")?.textContent).toContain("2 copies of 1 path");
        // Round the origin, four in a whole turn.
        button("Circular").click();
        type("Count", "4");
        draft = store.get().arrayDraft!;
        expect(draft.groups[1]!.paths.length).toBe(4);
        expect(Math.round(draft.groups[1]!.paths[2]![0]![0])).toBe(-20);
        type("Count", "1");
        expect(store.get().arrayDraft).toBeNull();
        expect(row.querySelector(".array-box")?.textContent).toContain("2 to 1000");
        type("Count", "4");
        button("Make array").click();
        await settleMany();
        expect(calls.filter((call) => call.name === "replaceJob").length).toBe(1);
        const job = store.get().job!;
        expect(job.groups[1]!.paths.length).toBe(4);
        expect(job.recipe ?? null).toBeNull();
        expect(store.get().arrayDraft).toBeNull();
        expect(store.get().selection).toEqual({ job: made.id, paths: [[1, 1], [1, 2], [1, 3]] });
        expect(row.querySelector(".array-box")?.classList.contains("hidden")).toBe(true);
        root.remove();
    });
});

describe("the job as JSON", () => {
    test("reads text back as a job, or says what is wrong", () => {
        const job = lineJob();
        const text = jobText(job);
        expect(text).not.toContain('"stats"');
        expect(text).not.toContain('"id"');
        const read = readJobText(text, "j1");
        expect(typeof read === "string" ? read : read.groups.map((group) => group.paths.length)).toEqual([2, 1]);
        expect(readJobText("{", "j1")).toContain("not JSON yet");
        expect(readJobText("[]", "j1")).toBe("a job is a JSON object");
        expect(readJobText('{"groups": [{"paths": []}]}', "j1")).toBe("group 1 needs a label");
        expect(readJobText('{"groups": [{"label": "x", "paths": [[1, 2]]}]}', "j1")).toBe("x: paths are lists of [x, y] points");
        // Lists the preview walks, given as something else, are refused
        // rather than drawn: the preview would throw on them.
        expect(readJobText('{"groups": [{"label": "a", "paths": null}]}', "j1")).toBe("a: paths are lists of [x, y] points");
        expect(readJobText('{"groups": [{"label": "a", "paths": [], "moves": 5}]}', "j1")).toBe("a: moves are lists of [x, y, z, kind] moves");
        expect(readJobText('{"groups": [{"label": "a", "paths": [], "moves": [[[0, 0, 0]]]}]}', "j1")).toBe("a: moves are lists of [x, y, z, kind] moves");
        expect(readJobText('{"groups": [{"label": "a", "paths": [], "joints": 7}]}', "j1")).toBe("a: joints are lists of [radius, angle] points");
        expect(readJobText('{"groups": [{"label": "a", "paths": [], "areas": "big"}]}', "j1")).toBe("a: areas are a list of numbers");
        const model = readJobText('{"groups": [{"label": "a", "moves": [[[0, 0, 1, 0], [1, 0, -0.5, 2]]]}]}', "j1");
        expect(typeof model === "string" ? model : model.groups[0]!.moves).toEqual([[[0, 0, 1, 0], [1, 0, -0.5, 2]]]);
        expect(placeText({ list: "groups", group: 1, path: 0, point: 2 }, job)).toBe("b: path 1, point 3");
        expect(placeText({ list: "outline", group: null, path: 3, point: null }, job)).toBe("outline: path 4");
    });

    test("a joint-space group's edited joints are drawn where they now cut", () => {
        const arc: [number, number][] = [[10, 0], [10, 90]];
        const stored: Job = { ...lineJob(), groups: [{ label: "arc", power: 500, min_power: 0, speed: 400, passes: 1, enabled: true, paths: [jointPreview(arc)], joints: [arc] }] };
        const radii = (job: Job | string): number[] => typeof job === "string" ? [] : [...new Set(job.groups[0]!.paths.flat().map(([x, y]) => Math.round(Math.hypot(x, y) * 1e6) / 1e6))];
        expect(radii(stored)).toEqual([10]);
        const text = jobText(stored);
        expect(text).toContain("[[10, 0], [10, 90]]");
        expect(radii(readJobText(text.replace("[[10, 0], [10, 90]]", "[[20, 0], [20, 90]]"), stored.id, stored))).toEqual([20]);
        // Joints as kept keep the drawing the text gives, and joints with
        // no drawing are drawn as the backend draws them.
        const same = readJobText(text, stored.id, stored);
        expect(typeof same === "string" ? same : same.groups[0]!.paths).toEqual(stored.groups[0]!.paths);
        const bare = JSON.stringify({ groups: [{ label: "arc", joints: [arc] }] });
        expect(radii(readJobText(bare, stored.id, stored))).toEqual([10]);
    });

    test("the caret's place is drawn, an edit is shown as it is typed, and Apply keeps it", async () => {
        const { store, ctx, root, api, calls } = setup();
        await api.connect("/dev/ttyACM0");
        mountJobJson(root, ctx);
        const made = await api.uploadJob(new File([SVG], "lines.svg"), { anchor: "keep" });
        await ctx.refreshJobs();
        await ctx.selectJob(made.id);
        const panel = root.querySelector("details.json-panel") as HTMLDetailsElement;
        panel.open = true;
        const editor = root.querySelector("textarea.json-input") as HTMLTextAreaElement;
        expect(editor.value).toContain('"label": "stroke #ff0000"');
        // The caret in the second point of the first group's second path
        // (an SVG's Y runs down the page, the board's up it).
        const second = editor.value.indexOf("[[0, -10]");
        expect(second).toBeGreaterThan(0);
        editor.setSelectionRange(second + 12, second + 12);
        editor.dispatchEvent(new Event("click"));
        expect(store.get().highlight).toEqual({ list: "groups", group: 0, path: 1, point: 1, job: made.id });
        expect(root.querySelector(".json-where")?.textContent).toBe("stroke #ff0000: path 2, point 2");
        // An edit: the second path's end moved; drawn once it reads.
        editor.value = editor.value.replace("[[0, -10], [10, -10]]", "[[0, -10], [15, -12]]");
        editor.dispatchEvent(new Event("input"));
        expect(store.get().pending["job-json"]).toBe(1);
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(store.get().jobDraft?.groups[0]!.paths[1]).toEqual([[0, -10], [15, -12]]);
        Array.from(root.querySelectorAll("button")).find((b) => b.textContent === "Apply")!.click();
        await settleMany();
        expect(calls.some((call) => call.name === "replaceJob")).toBe(true);
        expect((await api.job(made.id)).groups[0]!.paths[1]).toEqual([[0, -10], [15, -12]]);
        expect(store.get().jobDraft).toBeNull();
        expect(store.get().pending["job-json"]).toBeUndefined();
        // A path picked in the preview puts the caret on its line.
        store.set({ selection: { job: made.id, paths: [[1, 0]] } });
        expect(editor.value.slice(editor.selectionStart, editor.selectionStart + 9)).toBe("[[20, 0],");
        // A text that is not a job is not kept.
        editor.value = "{";
        editor.dispatchEvent(new Event("input"));
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(root.querySelector(".json-status")?.textContent).toContain("not JSON yet");
        Array.from(root.querySelectorAll("button")).find((b) => b.textContent === "Revert")!.click();
        expect(editor.value).toContain('"label": "stroke #0000ff"');
        expect(store.get().pending["job-json"]).toBeUndefined();
        root.remove();
    });

    test("Apply of paths taken out says the job is no longer made again from its operations", async () => {
        const { store, ctx, root, api } = setup();
        mountJobJson(root, ctx);
        const line = (y: number): MillOperation => ({ ...defaultOperation("line"), depth: 0.3, step_down: 0.3, points: [[0, y], [10, y]] });
        const made = (await api.makeMill({ ops: [line(0), line(5)] })).job;
        await ctx.refreshJobs();
        await ctx.selectJob(made.id);
        const editor = root.querySelector("textarea.json-input") as HTMLTextAreaElement;
        const text = JSON.parse(editor.value) as Job;
        expect(text.recipe).not.toBeNull();
        editor.value = JSON.stringify({ ...text, groups: text.groups.slice(0, 1) });
        editor.dispatchEvent(new Event("input"));
        Array.from(root.querySelectorAll("button")).find((b) => b.textContent === "Apply")!.click();
        await settleMany();
        expect((await api.job(made.id)).recipe ?? null).toBeNull();
        expect(store.get().toasts.map((toast) => toast.text)).toContain(`${made.name}: kept as the text says, no longer made again from its operations`);
        root.remove();
    });
});
