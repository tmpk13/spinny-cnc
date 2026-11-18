// The layers inside the panels: what every run uses is in view, the rest
// folds under More in the same panel, a button that cannot act now is not
// shown, and how-to is behind a question mark.

import { afterEach, describe, expect, test } from "bun:test";
import { initialState } from "../src/state.ts";
import type { CamOperation, CamTool, Group, Job, JobSummary, Progress } from "../src/types.ts";
import { cameraViews, machineViews, viewPanels, viewsOf } from "../src/views/areaviews.ts";
import { helpMark } from "../src/views/context.ts";
import { mountFindBoard } from "../src/views/findboard.ts";
import { mountHeightMap } from "../src/views/heightmap.ts";
import { operationSays } from "../src/views/cam.ts";
import { groupSays, jobSizeText, mountJobs } from "../src/views/jobs.ts";
import { mountPanels } from "../src/views/panels.ts";
import { mountPnpRun } from "../src/views/pnprun.ts";
import { mountPreviewPanel, viewLabel } from "../src/views/previewpanel.ts";
import { mountRun } from "../src/views/run.ts";
import { collectFeatures, goToFeature } from "../src/views/search.ts";
import { mountTabs, showPage } from "../src/views/tabs.ts";
import { mountViewBars } from "../src/views/viewbar.ts";
import { connected, findButton, settle, setup } from "./harness.ts";

const summary = { id: "a1", name: "board", source: "gerber", spot: 0.1, offset: { x: 0, y: 0 }, rotation: 0, groups: [], stats: { length_mm: 120, seconds: 90 } } as unknown as JobSummary;
const job = { ...summary, outline: [], copper: [], groups: [] } as unknown as Job;
const progress: Progress = { job: "a1", state: "running", sent: 60, acked: 50, total: 200, seconds: 3, estimate: 9, group: 0 } as Progress;

afterEach(() => {
    document.getElementById("app")?.remove();
    document.body.replaceChildren();
    for (const key of ["spinny.views", "spinny.layout", "spinny.page", "spinny.side-pages", "spinny.preview.options", "spinny.find.test-layers"]) {
        localStorage.removeItem(key);
    }
});

/** Whether a node shows as far as the page's own switches go: not hidden itself, nor inside a fold that is shut. */
function inView(node: Element, root: Element): boolean {
    for (let at: Element | null = node; at && at !== root; at = at.parentElement) {
        if ((at as HTMLElement).hidden || at.classList.contains("hidden")) {
            return false;
        }
        const fold = at.parentElement;
        if (fold instanceof HTMLDetailsElement && !fold.open && at.tagName !== "SUMMARY") {
            return false;
        }
    }
    return true;
}

describe("the Height panel", () => {
    test("shows what a probe takes, and keeps the area, the pads, the ties, the settings and the file under More", () => {
        const { ctx, root, store } = setup();
        store.set({ snapshot: connected() });
        mountHeightMap(root, ctx);
        const more = root.querySelector("details.hm-more") as HTMLDetailsElement;
        expect(more.open).toBe(false);
        expect(more.querySelector("summary")?.textContent).toStartWith("More: ");
        for (const label of ["Fit to job", "Probe", "Focus here"]) {
            expect(inView(findButton(root, label), root)).toBe(true);
        }
        for (const label of ["Probe pads", "Plan", "Probe here: tie map", "Save map", "Load map", "Clear", "Set"]) {
            expect(more.contains(findButton(root, label))).toBe(true);
            expect(inView(findButton(root, label), root)).toBe(false);
        }
        expect(more.querySelector(".hm-grid-fields")).not.toBeNull();
        expect(more.querySelector(".hm-probe-settings")).not.toBeNull();
        // What a part is for is its heading's tooltip, not a paragraph.
        const pads = Array.from(more.querySelectorAll("h3")).find((heading) => heading.textContent === "Pads") as HTMLElement;
        expect(pads.title).toContain("Probe pads touches the job's pads");
        // How to focus is the button's tooltip.
        expect(findButton(root, "Focus here").title).toContain("Jog the head until the beam is in focus");
        // Stop shows only while there is probing to stop.
        expect(findButton(root, "Stop").hidden).toBe(true);
    });
});

describe("Find board", () => {
    test("with the camera stopped offers its start in place of the presses it unlocks", () => {
        const { ctx, root, store } = setup();
        const started: string[] = [];
        mountFindBoard(root, ctx, { page: "test-layers", boxes: { head: () => null, top: () => null }, start: (camera) => started.push(camera) });
        store.set({ snapshot: connected() });
        const start = findButton(root, "Start the camera");
        expect(inView(start, root)).toBe(true);
        expect(inView(findButton(root, "Look for board"), root)).toBe(false);
        expect(root.querySelector(".find-note")?.textContent).toBe("The head camera is not running.");
        start.click();
        expect(started).toEqual(["head"]);
        // Running: the three presses of a find, the next one dark. The
        // search loads the board itself, so it leads; Look for board is the
        // look from where the camera stands.
        store.set({ camera: { ...(store.get().camera ?? {}), running: true } as NonNullable<ReturnType<typeof store.get>["camera"]> });
        expect(inView(start, root)).toBe(false);
        expect(inView(findButton(root, "Look for board"), root)).toBe(true);
        expect(findButton(root, "Look for board").classList.contains("btn-primary")).toBe(false);
        expect(findButton(root, "Search").classList.contains("btn-primary")).toBe(true);
        // The scan, the guesses, the corners and the features are one press away.
        const rest = root.querySelector("details.find-rest") as HTMLDetailsElement;
        expect(rest.open).toBe(false);
        for (const label of ["Full scan", "Clear guesses", "Unload", "Corner here"]) {
            expect(rest.contains(findButton(root, label))).toBe(true);
        }
    });

    test("without a way to start the camera it says where Start is", () => {
        const { ctx, root, store } = setup();
        mountFindBoard(root, ctx, { page: "test-layers", boxes: { head: () => null, top: () => null } });
        store.set({ snapshot: connected() });
        expect(root.querySelector(".find-note")?.textContent).toBe("The head camera is not running: Start is on its picture.");
        expect(inView(findButton(root, "Look for board"), root)).toBe(true);
        expect(inView(findButton(root, "Start the camera"), root)).toBe(false);
    });
});

describe("the Run panel", () => {
    test("leads with what the run goes by and shows only the buttons the run's state allows", () => {
        const { ctx, root, store } = setup();
        store.set({ snapshot: connected(), jobs: [summary], job });
        mountRun(root, ctx, { ready: true });
        const lines = Array.from(root.querySelectorAll(".run-ready dt")).map((node) => node.textContent);
        expect(lines).toEqual(["Job", "Board", "Height"]);
        expect(root.querySelector(".run-ready dd")?.textContent).toContain("120.0 mm");
        const shown = (): string[] => ["Run", "Hold", "Resume", "Stop"].filter((label) => !findButton(root, label).hidden);
        expect(shown()).toEqual(["Run"]);
        store.set({ progress });
        expect(shown()).toEqual(["Hold", "Stop"]);
        expect(root.querySelector(".progress-share")?.textContent).toBe("25%");
        store.set({ progress: { ...progress, state: "hold" } });
        expect(shown()).toEqual(["Resume", "Stop"]);
        expect(findButton(root, "Resume").classList.contains("btn-primary")).toBe(true);
        store.set({ progress: { ...progress, state: "done" } });
        expect(shown()).toEqual(["Run"]);
    });

    test("a machine with no axis for heights has no Height line", () => {
        const { ctx, root, store } = setup();
        store.set({ snapshot: connected({}, { profile: { kinematics: "polar", tool: "laser", h_axis: false, r_max: 0, z_max: 0 } }) });
        mountRun(root, ctx, { ready: true });
        const height = Array.from(root.querySelectorAll(".run-ready > div")).find((row) => row.querySelector("dt")?.textContent === "Height") as HTMLElement;
        expect(height.hidden).toBe(true);
    });

    test("a G-code pick and place machine has no run of paths: only its placing shows", async () => {
        const { ctx, root, store, api } = setup();
        mountRun(root, ctx, { ready: true });
        expect(root.querySelector(".run-row")?.hasAttribute("data-no-job-run")).toBe(false);
        store.set({ snapshot: await api.connect("/dev/ttyACM1", "opulo-lumen-rev5") });
        expect(root.querySelector(".run-row")?.hasAttribute("data-no-job-run")).toBe(true);
        expect(root.querySelector(".run-ready")?.hasAttribute("data-no-job-run")).toBe(true);
    });
});

describe("placing", () => {
    test("Plan and Run are in view, Stop while placing; the rest is under More", () => {
        const { ctx, root } = setup();
        mountPnpRun(root, ctx);
        const more = root.querySelector("details.pnp-run-more") as HTMLDetailsElement;
        expect(more.open).toBe(false);
        expect(inView(findButton(root, "Plan"), root)).toBe(true);
        expect(findButton(root, "Run").hidden).toBe(false);
        expect(findButton(root, "Stop").hidden).toBe(true);
        for (const label of ["Run the rest", "Count feeders again", "Reset"]) {
            expect(more.contains(findButton(root, label))).toBe(true);
        }
        document.querySelector(".run-window")?.remove();
    });
});

describe("the preview's view options", () => {
    test("Fit and Top view are in the head; View opens the rest and says how many modes are on", () => {
        const { ctx, root } = setup();
        mountPreviewPanel(root, ctx);
        const head = root.querySelector(".panel-head")!;
        expect(Array.from(head.querySelectorAll("button")).map((press) => press.textContent)).toEqual(["Fit", "Top view", "View"]);
        const options = root.querySelector(".preview-options") as HTMLElement;
        expect(options.hidden).toBe(true);
        findButton(root, "View").click();
        expect(options.hidden).toBe(false);
        expect(localStorage.getItem("spinny.preview.options")).toBe("1");
        // A mode that changes what a drag does is said on View while the row is shut.
        findButton(root, "Box select").click();
        findButton(root, "View, 1 on").click();
        expect(options.hidden).toBe(true);
        expect(viewLabel(0)).toBe("View");
        expect(viewLabel(2)).toBe("View, 2 on");
        // A search going to one of the options opens the row.
        findButton(root, "Speed").dispatchEvent(new CustomEvent("spinny:show", { bubbles: true }));
        expect(options.hidden).toBe(false);
    });
});

describe("the Jobs panel", () => {
    test("opening a file is the next thing to do while no job is kept; a job's row is the job and its Delete, the rest under More", () => {
        const { ctx, root, store } = setup();
        const run = document.createElement("section");
        mountJobs(root, ctx, run);
        store.set({ jobs: [] });
        const open = Array.from(root.querySelectorAll("label.btn")).find((label) => label.textContent === "Open a file")!;
        expect(open.classList.contains("btn-primary")).toBe(true);
        store.set({ jobs: [summary] });
        expect(open.classList.contains("btn-primary")).toBe(false);
        const remove = root.querySelector(".job-list .job-remove") as HTMLButtonElement;
        expect(remove.textContent).toBe("Delete");
        expect(remove.title).toBe("delete board");
        // A row is one button that picks the job, its drawing in it, and Delete.
        expect(Array.from(root.querySelectorAll(".job-list li > button")).map((press) => press.className.split(" ").at(-1))).toEqual(["job-pick", "job-remove"]);
        expect(root.querySelector(".job-list .job-pick .job-thumb-box")).not.toBeNull();
        // The picked job's icon and file, joining and emptying are folded under the list, out of the head.
        expect(root.querySelector(".panel-head button")).toBeNull();
        const more = root.querySelector("details.jobs-more") as HTMLDetailsElement;
        expect(more.open).toBe(false);
        expect(more.querySelector("summary")!.textContent).toBe("More: icon, save, combine, delete all");
        expect(Array.from(more.querySelectorAll("button")).map((press) => press.textContent)).toEqual(["Icon", "Save job", "Combine", "Delete all"]);
        // The boxes that tick jobs to join show with the fold open, where Combine is.
        const list = root.querySelector(".job-list") as HTMLElement;
        expect(list.hasAttribute("data-combining")).toBe(false);
        more.open = true;
        more.dispatchEvent(new Event("toggle"));
        expect(list.hasAttribute("data-combining")).toBe(true);
        more.open = false;
        more.dispatchEvent(new Event("toggle"));
        expect(list.hasAttribute("data-combining")).toBe(false);
    });
});

describe("a question mark", () => {
    test("holds how something is done: its tooltip, and a message on a press", () => {
        const { ctx, store } = setup();
        const mark = helpMark(ctx, "Drag the picture to move the head.");
        expect(mark.title).toBe("Drag the picture to move the head.");
        expect(mark.textContent).toBe("?");
        mark.click();
        expect(store.get().toasts.at(-1)?.text).toBe("Drag the picture to move the head.");
    });
});

describe("the Setup side's views", () => {
    test("Machines: the machine and its file, the keys beside the file, the import", () => {
        expect(machineViews().map((view) => view.label)).toEqual(["Machine", "Keys", "Import"]);
        expect(viewPanels(machineViews()[0]!)).toEqual(["connection", "machine-file"]);
        expect(viewPanels(machineViews()[1]!)).toEqual(["machine-file", "settings"]);
        expect(viewsOf("machines", initialState(true)).length).toBe(3);
    });

    test("Cameras: a view a camera, and the bar lists the ones whose panels the machine has", () => {
        expect(cameraViews().map((view) => view.id)).toEqual(["head-camera", "bottom-camera", "top-camera", "head"]);
        const app = document.createElement("div");
        app.id = "app";
        const panel = (id: string, hidden = false): string => `<section id="${id}" class="panel${hidden ? " hidden" : ""}" aria-label="${id}"><div class="panel-head"><h2>${id}</h2></div></section>`;
        app.innerHTML = `
            <nav id="tabs" class="tabs"></nav>
            <div id="pane-use" class="pane" data-side="use"><nav id="views-use" class="viewbar" hidden></nav>
                <main id="page-home" class="grid page"><div class="column">${panel("overview")}</div></main></div>
            <div id="pane-setup" class="pane" data-side="setup"><nav id="views-setup" class="viewbar" hidden></nav>
                <main id="page-cameras" class="grid page">
                    <div class="column">${panel("camera")}${panel("camera-controls")}${panel("camera-sight")}${panel("camera-changes")}${panel("pnp-nozzle")}</div>
                    <div class="column">${panel("pnp-camera")}${panel("pnp-top", true)}${panel("pnp-top-controls", true)}${panel("pnp-top-sight", true)}${panel("pnp-top-changes", true)}</div>
                    <div class="column">${panel("pnp-head", true)}${panel("pnp-machine-view", true)}</div>
                </main></div>`;
        document.body.append(app);
        const { ctx, store } = setup();
        mountTabs(app.querySelector("#tabs")!, store);
        mountPanels(app);
        mountViewBars(ctx, { use: app.querySelector("#views-use")!, setup: app.querySelector("#views-setup")! });
        showPage("cameras");
        const names = (): string[] => Array.from(app.querySelectorAll("#views-setup .viewbar-name")).map((node) => node.textContent ?? "");
        // A laser has no top camera and no pick and place head: their views are not listed.
        expect(names()).toEqual(["Head camera", "Bottom camera"]);
        expect(app.querySelector("#page-cameras")!.getAttribute("data-view")).toBe("head-camera");
        // The machine connected has them: they are listed once their panels show.
        for (const id of ["pnp-top", "pnp-head"]) {
            app.querySelector(`#${id}`)!.classList.remove("hidden");
        }
        store.set({ snapshot: connected() });
        expect(names()).toEqual(["Head camera", "Bottom camera", "Top camera", "Head and bed"]);
    });
});

describe("the search", () => {
    test("leaves the layout's marks and the question marks out, and opens what holds the button it goes to", async () => {
        const app = document.createElement("div");
        app.id = "app";
        app.innerHTML = `<main id="page-run" class="grid page"><div class="column">
            <section id="heightmap" class="panel" aria-label="Height"><div class="panel-head"><h2>Height</h2><button class="help-mark" title="how">?</button></div>
                <details class="more"><summary>More</summary><button title="keep the map">Save map</button></details>
                <div class="more-mark"><button class="more-press" title="on">more below</button></div></section></div></main>`;
        document.body.append(app);
        const features = collectFeatures(app);
        expect(features.filter((feature) => feature.kind === "button").map((feature) => feature.label)).toEqual(["Save map"]);
        const save = features.find((feature) => feature.label === "Save map")!;
        let shown = 0;
        save.node!.addEventListener("spinny:show", () => (shown += 1));
        goToFeature(save);
        await settle();
        expect((app.querySelector("details") as HTMLDetailsElement).open).toBe(true);
        expect(shown).toBe(1);
    });
});

describe("a row that says its numbers", () => {
    const group = (over: Partial<Group>): Group => ({ label: "cut", power: 500, min_power: 0, speed: 400, passes: 1, enabled: true, paths: [], ...over });

    test("a job's group: power and speed, the passes when more than one, a focus of its own", () => {
        expect(groupSays(group({}), false)).toBe("S500, 400 mm/min");
        expect(groupSays(group({ passes: 3 }), false)).toBe("S500, 400 mm/min, 3 passes");
        expect(groupSays(group({ focus: 0.5 }), false)).toBe("S500, 400 mm/min, focus +0.5 mm");
        expect(groupSays(group({ focus: -1, passes: 2 }), false)).toBe("S500, 400 mm/min, 2 passes, focus -1 mm");
        // No focus of its own says nothing of it.
        expect(groupSays(group({ focus: null }), false)).toBe("S500, 400 mm/min");
    });

    test("milled, how deep it goes; a model's moves carry their own depths and passes; a dispenser's paste", () => {
        expect(groupSays(group({ power: 12000, speed: 300, depth: 1.6, passes: 4 }), true)).toBe("S12000, 1.6 mm deep, 300 mm/min, 4 passes");
        // With no depth of its own a group mills through the copper.
        expect(groupSays(group({ power: 12000, speed: 300 }), true)).toBe("S12000, 0.1 mm deep, 300 mm/min");
        expect(groupSays(group({ power: 12000, speed: 300, depth: 2.5, passes: 4, moves: [[]] } as Partial<Group>), true)).toBe("S12000, to 2.5 mm deep, 300 mm/min");
        expect(groupSays(group({ tool: "dispenser", thickness: 0.2 }), false)).toBe("0.2 mm of paste");
        expect(groupSays(group({ tool: "dispenser", passes: 2 }), true)).toBe("0.12 mm of paste, 2 passes");
    });

    test("a job's size: its length and its time", () => {
        expect(jobSizeText(job)).toBe("120.0 mm of path, 1:30 at these speeds");
    });

    test("a CAM operation: its tool by name, what it turns or burns at, its feed and its passes", () => {
        const laser = { id: "diode", name: "Diode laser", kind: "laser", width: 0.08, settings: {} } as unknown as CamTool;
        const mill = { id: "em", name: "1 mm end mill", kind: "spindle", width: 1, settings: {} } as unknown as CamTool;
        const operation = (cutting: Record<string, number>, tool: string): CamOperation => ({ name: "outline", source: "outline", tool, enabled: true, settings: {}, cutting }) as unknown as CamOperation;
        expect(operationSays(operation({ power: 600, speed: 150, passes: 6 }, "diode"), laser, "6 passes")).toBe("Diode laser, S600, 150 mm/min, 6 passes");
        expect(operationSays(operation({ rpm: 10000, feed: 200, depth: 1.7 }, "em"), mill, "3 passes to 1.7 mm")).toBe("1 mm end mill, S10000, 200 mm/min, 3 passes to 1.7 mm");
        // A tool the profile no longer has is named by its id, with no numbers to say.
        expect(operationSays(operation({}, "gone"), undefined, "1 pass")).toBe("gone, 1 pass");
    });
});

describe("the picked job's place by hand", () => {
    test("an offset typed moves the job when its field is left, with no button to press after; the turn has its own row", async () => {
        const { ctx, root, api, calls } = setup();
        mountJobs(root, ctx, root);
        await ctx.refreshJobs();
        const first = (await api.jobs())[0]!;
        await ctx.selectJob(first.id);
        const x = root.querySelector('input[aria-label="Offset x"]') as HTMLInputElement;
        const y = root.querySelector('input[aria-label="Offset y"]') as HTMLInputElement;
        const place = x.closest(".job-place")!;
        expect(Array.from(place.querySelectorAll("button")).map((press) => press.textContent)).toEqual(["Turn left", "Turn right"]);
        calls.length = 0;
        x.value = "3.5";
        x.dispatchEvent(new Event("change"));
        await settle();
        await settle();
        expect(calls.find((call) => call.name === "patchJob")?.args).toEqual([first.id, { offset: { x: 3.5, y: Number(y.value) } }]);
        expect((await api.job(first.id)).offset.x).toBe(3.5);
        // A field emptied is not an offset: said, and nothing sent.
        calls.length = 0;
        y.value = "";
        y.dispatchEvent(new Event("change"));
        await settle();
        expect(calls.some((call) => call.name === "patchJob")).toBe(false);
    });
});
