// An area's views: what each holds, the layout the layer puts on the page
// for one, and the bar that lists them and shows one.

import { afterEach, describe, expect, test } from "bun:test";
import { defaultLayout, columnIds } from "../src/layout.ts";
import { closeMenu } from "../src/menu.ts";
import { initialState, Store, type AppState } from "../src/state.ts";
import type { Job, JobSummary, Progress } from "../src/types.ts";
import { ALL_VIEW, heightText, isSteps, jobSteps, jobViews, placeText, placingSteps, runText, stepToOpen, viewHolding, viewsOf } from "../src/views/areaviews.ts";
import { LAYOUT_KEY, markupDefaults, mountPanels, revealPanel, showPanelView, viewLayout } from "../src/views/panels.ts";
import { mountTabs, showPage } from "../src/views/tabs.ts";
import { mountViewBars, showAreaView, stepMark, VIEWS_KEY } from "../src/views/viewbar.ts";
import { connected, findButton, setup } from "./harness.ts";

const summary = { id: "a1", name: "board", source: "gerber", spot: 0.1, offset: { x: 1.5, y: -2 }, rotation: 0, groups: [], stats: { length_mm: 120, seconds: 90 } } as unknown as JobSummary;
const job = { ...summary, outline: [], copper: [], groups: [] } as unknown as Job;
const progress: Progress = { job: "a1", state: "running", sent: 60, acked: 50, total: 200, seconds: 3, estimate: 9, group: 0 } as Progress;

afterEach(() => {
    closeMenu(false);
    document.getElementById("app")?.remove();
    document.body.replaceChildren();
    for (const key of [LAYOUT_KEY, VIEWS_KEY, "spinny.page", "spinny.side-pages", "spinny.tabs"]) {
        localStorage.removeItem(key);
    }
});

describe("the Run area's steps", () => {
    test("a laser or a mill: connect, job, board, height, run; each done from the state", () => {
        const state = initialState(true);
        const before = jobSteps(state);
        expect(before.map((step) => step.id)).toEqual(["connect", "job", "board", "height", "run"]);
        expect(before.map((step) => step.step?.done)).toEqual([false, false, false, false, false]);
        expect(before.map((step) => step.step?.optional)).toEqual([false, false, true, true, false]);
        const after = jobSteps({ ...state, snapshot: connected(), jobs: [summary], job });
        expect(after.map((step) => step.step?.done)).toEqual([true, true, false, false, false]);
        // A run of the job picked that ran to its end.
        const done = jobSteps({ ...state, snapshot: connected(), jobs: [summary], job, progress: { ...progress, state: "done" } });
        expect(done.at(-1)?.step?.done).toBe(true);
        expect(isSteps(after)).toBe(true);
    });

    test("a machine with no axis for heights has no Height step", () => {
        const state = initialState(true);
        const plain = connected({}, { profile: { kinematics: "polar", tool: "laser", h_axis: false, r_max: 0, z_max: 0 } });
        expect(jobSteps({ ...state, snapshot: plain }).map((step) => step.id)).toEqual(["connect", "job", "board", "run"]);
        const mill = connected({}, { profile: { kinematics: "cartesian", tool: "spindle", h_axis: true, r_max: 0, z_max: 0 } });
        expect(jobSteps({ ...state, snapshot: mill }).map((step) => step.id)).toContain("height");
    });

    test("every step shows the work on the left, one panel beside it and the machine docked", () => {
        for (const step of jobSteps(initialState(true))) {
            expect(step.columns.length).toBe(3);
            expect(step.columns[0]).toEqual([["run-preview", "camera-view"]]);
            expect(step.columns[2]).toEqual(["machine"]);
            expect(step.dock).toBe(true);
        }
        // The camera's picture comes to the front of the work while it runs and the board is being placed.
        const state = initialState(true);
        const camera = { running: true } as AppState["camera"];
        expect(jobSteps({ ...state, camera }).find((step) => step.id === "board")?.front).toEqual(["camera-view"]);
        expect(jobSteps(state).find((step) => step.id === "board")?.front).toEqual([]);
    });

    test("the area opens at the first step a run needs that is not done, else the last", () => {
        const state = initialState(true);
        expect(stepToOpen(jobSteps(state))).toBe("connect");
        expect(stepToOpen(jobSteps({ ...state, snapshot: connected() }))).toBe("job");
        // Board and Height can be done without: a job picked leads to the run.
        expect(stepToOpen(jobSteps({ ...state, snapshot: connected(), job }))).toBe("run");
        expect(stepToOpen([])).toBeNull();
    });

    test("a G-code pick and place machine has its own steps", () => {
        const steps = placingSteps(initialState(true));
        expect(steps.map((step) => step.label)).toEqual(["Connect", "Home", "Parts", "Board", "Feeders", "Place"]);
        // Homing is the machine's own: its panel whole, not docked.
        const home = steps.find((step) => step.id === "home")!;
        expect(home.columns[1]).toEqual(["machine"]);
        expect(home.dock).toBeUndefined();
        expect(viewHolding(steps, "pnp-refs")).toBeNull();
        expect(viewHolding(steps, "place")).toBe("board");
        expect(viewHolding(steps, "pnp-view")).toBe("connect");
    });

    test("what is so in a step, in words", () => {
        const state = initialState(true);
        expect(placeText(state)).toBe("No job picked yet.");
        expect(placeText({ ...state, job })).toBe("The job sits at X 1.5 Y -2 mm, not turned.");
        expect(placeText({ ...state, job: { ...job, rotation: 90 } as Job })).toBe("The job sits at X 1.5 Y -2 mm, turned 90 deg.");
        expect(heightText(state)).toBe("No travel height; no height map.");
        expect(runText({ ...state, jobs: [summary], job })).toBe("board: 120.0 mm, about 1:30.");
        expect(runText({ ...state, jobs: [summary], job, progress })).toBe("Running board: 25%.");
        expect(runText({ ...state, jobs: [summary], job, progress: { ...progress, state: "done" } })).toBe("board is done.");
    });
});

describe("the Job area's views", () => {
    test("the ways to make a job, each beside the preview; the picked job's panel once a job is picked", () => {
        const state = initialState(true);
        expect(jobViews(state).map((view) => view.id)).toEqual(["jobs", "draw", "assistant", "json"]);
        expect(jobViews(state)[0]!.columns).toEqual([["jobs"], ["preview"]]);
        // What the assistant can do is there to read once: its panel is folded in the view.
        expect(jobViews(state).find((view) => view.id === "assistant")!.folded).toEqual(["auto-about"]);
        expect(jobViews({ ...state, job })[0]!.columns).toEqual([["jobs"], ["preview"], ["job"]]);
        expect(isSteps(jobViews(state))).toBe(false);
        expect(viewsOf("home", state)).toEqual([]);
        expect(viewsOf("job", state).length).toBe(4);
    });
});

/** A page like the Run area: three columns, the last holding the machine. */
function makeApp(): HTMLElement {
    const app = document.createElement("div");
    app.id = "app";
    const panel = (id: string, name: string): string => `<section id="${id}" class="panel" aria-label="${name}"><div class="panel-head"><h2>${name}</h2></div><p>body</p></section>`;
    app.innerHTML = `
        <nav id="tabs" class="tabs"></nav>
        <div id="pane-use" class="pane" data-side="use">
        <nav id="views-use" class="viewbar" hidden></nav>
        <main id="page-home" class="grid page"><div class="column">${panel("overview", "Next")}</div></main>
        <main id="page-job" class="grid page">
            <div class="column">${panel("jobs", "Jobs")}${panel("job", "Job")}</div>
            <div class="column">${panel("preview", "Preview")}${panel("jobjson", "Job JSON")}</div>
            <div class="column">${panel("mill-operation", "Draw")}${panel("job-machine", "Machine")}${panel("auto-chat", "Assistant")}${panel("auto-about", "What it can do")}</div>
        </main>
        <main id="page-run" class="grid page">
            <div class="column">${panel("machine", "Machine")}</div>
            <div class="column">${panel("steps", "Steps")}${panel("run-preview", "Preview")}${panel("camera-view", "Head camera view")}${panel("place", "Board place")}${panel("console", "Console")}</div>
            <div class="column">${panel("run-connect", "Connect")}${panel("run-job", "Job to run")}${panel("heightmap", "Height")}${panel("run", "Run")}</div>
        </main>
        </div>
        <div id="pane-setup" class="pane" data-side="setup">
        <nav id="views-setup" class="viewbar" hidden></nav>
        <main id="page-facts" class="grid page"><div class="column">${panel("facts", "Checklist")}</div></main>
        </div>`;
    document.body.append(app);
    return app;
}

function panelsIn(column: Element): string[] {
    return Array.from(column.querySelectorAll("section.panel")).filter((node) => !node.hasAttribute("data-off")).map((node) => node.id);
}

describe("a view on its page", () => {
    test("the view's layout holds its panels in its columns and every other panel out of sight", () => {
        const app = makeApp();
        const defaults = markupDefaults(Array.from(app.querySelectorAll("#page-run > .column")));
        const layout = viewLayout({ id: "run", columns: [[["run-preview", "camera-view"]], ["run", "console"], ["machine"]], folded: ["console"], front: ["camera-view"] }, defaults);
        expect(columnIds(layout).map((ids) => ids.filter((id) => layout.panels[id]?.hidden !== true))).toEqual([["run-preview", "camera-view"], ["run", "console"], ["machine"]]);
        // The work is one stack, the panel asked for in front.
        expect(layout.columns[0]![0]).toEqual([{ ids: ["run-preview", "camera-view"], front: "camera-view" }]);
        expect(layout.panels["console"]).toEqual({ collapsed: true });
        expect(layout.panels["heightmap"]).toEqual({ hidden: true });
        // Every panel of the page is somewhere in it, once.
        expect(columnIds(layout).flat().sort()).toEqual(columnIds(defaultLayout(defaults)).flat().sort());
    });

    test("the layer shows a view in place of the operator's layout and gives the layout back", () => {
        const app = makeApp();
        const layer = mountPanels(app);
        // The operator folded a panel: that is the layout kept.
        app.querySelector<HTMLButtonElement>("#heightmap .panel-chevron")!.click();
        const kept = localStorage.getItem(LAYOUT_KEY);
        const columns = Array.from(app.querySelectorAll("#page-run > .column"));
        showPanelView("run", { id: "height", columns: [[["run-preview", "camera-view"]], ["heightmap"], ["machine"]] });
        expect(layer.viewOf("run")).toBe("height");
        expect(app.querySelector("#page-run")!.getAttribute("data-view")).toBe("height");
        expect(columns.map(panelsIn)).toEqual([["run-preview", "camera-view"], ["heightmap"], ["machine"]]);
        // In the view the panel shows unfolded, and the layout kept is still the operator's.
        expect(app.querySelector("#heightmap")!.hasAttribute("data-collapsed")).toBe(false);
        expect(localStorage.getItem(LAYOUT_KEY)).toBe(kept);
        expect(layer.hiddenPanels()).toEqual([]);
        // A tab of the work's stack pressed is kept while the page is open.
        const tab = Array.from(app.querySelectorAll<HTMLButtonElement>("#page-run .panel-tab")).find((node) => node.textContent === "Head camera view")!;
        tab.click();
        expect(app.querySelector("#camera-view")!.hasAttribute("data-behind")).toBe(false);
        showPanelView("run", { id: "run", columns: [[["run-preview", "camera-view"]], ["run"], ["machine"]] });
        showPanelView("run", { id: "height", columns: [[["run-preview", "camera-view"]], ["heightmap"], ["machine"]] });
        expect(app.querySelector("#run-preview")!.hasAttribute("data-behind")).toBe(true);
        expect(localStorage.getItem(LAYOUT_KEY)).toBe(kept);
        // No view: the operator's layout again, the panel folded as it was left.
        showPanelView("run", null);
        expect(layer.viewOf("run")).toBeNull();
        expect(app.querySelector("#page-run")!.hasAttribute("data-view")).toBe(false);
        expect(columns.map(panelsIn)).toEqual([["machine"], ["steps", "run-preview", "camera-view", "place", "console"], ["run-connect", "run-job", "heightmap", "run"]]);
        expect(app.querySelector("#heightmap")!.hasAttribute("data-collapsed")).toBe(true);
    });

    test("a view's panels are not arranged by hand: no menu opens on one", () => {
        const app = makeApp();
        mountPanels(app);
        showPanelView("run", { id: "height", columns: [["run-preview"], ["heightmap"], ["machine"]] });
        app.querySelector<HTMLButtonElement>("#heightmap .panel-menu-button")!.click();
        expect(document.querySelector(".menu")).toBeNull();
        showPanelView("run", null);
        app.querySelector<HTMLButtonElement>("#heightmap .panel-menu-button")!.click();
        expect(document.querySelector(".menu")).not.toBeNull();
    });

    test("a column with nothing drawn in it is marked, so the view's columns take its room", () => {
        const app = makeApp();
        mountPanels(app);
        showPanelView("run", { id: "two", columns: [["run-preview"], ["run"]] });
        const columns = Array.from(app.querySelectorAll("#page-run > .column"));
        expect(columns.map((column) => column.hasAttribute("data-empty"))).toEqual([false, false, true]);
    });

    test("a column that holds one panel in a view is marked, so the panel has no fold where the columns sit side by side", () => {
        const app = makeApp();
        mountPanels(app);
        const columns = Array.from(app.querySelectorAll("#page-run > .column"));
        const single = (): boolean[] => columns.map((column) => column.hasAttribute("data-single"));
        // The operator's own layout is theirs to fold: nothing is marked.
        expect(single()).toEqual([false, false, false]);
        // One panel, two panels, one panel.
        showPanelView("run", { id: "run", columns: [["run-preview"], ["run", "console"], ["machine"]] });
        expect(single()).toEqual([true, false, true]);
        showPanelView("run", null);
        expect(single()).toEqual([false, false, false]);
    });
});

describe("the view bar", () => {
    function mounted(): { app: HTMLElement; store: Store<AppState>; bar: HTMLElement } {
        const app = makeApp();
        const { ctx, store } = setup();
        mountTabs(app.querySelector("#tabs")!, store);
        mountPanels(app);
        mountViewBars(ctx, { use: app.querySelector("#views-use")!, setup: app.querySelector("#views-setup")! });
        return { app, store, bar: app.querySelector("#views-use")! };
    }
    const names = (bar: HTMLElement): string[] => Array.from(bar.querySelectorAll(".viewbar-name")).map((node) => node.textContent ?? "");
    const marks = (bar: HTMLElement): (string | null)[] => Array.from(bar.querySelectorAll(".viewbar-item")).map((node) => node.getAttribute("data-step"));

    test("lists the steps of the Run area, opens where the work stands and follows it", () => {
        const { app, store, bar } = mounted();
        showPage("run");
        expect(bar.hidden).toBe(false);
        expect(names(bar)).toEqual(["Connect", "Job", "Board", "Height", "Run"]);
        expect(marks(bar)).toEqual(["now", "todo", "optional", "optional", "todo"]);
        expect(app.querySelector("#page-run")!.getAttribute("data-view")).toBe("connect");
        expect(bar.querySelector(".viewbar-say")?.textContent).toBe("No machine is connected.");
        // Connected: on to the job, by itself, since no step was pressed.
        store.set({ snapshot: connected(), jobs: [summary] });
        expect(marks(bar)).toEqual(["done", "now", "optional", "optional", "todo"]);
        expect(app.querySelector("#page-run")!.getAttribute("data-view")).toBe("job");
        store.set({ job });
        expect(app.querySelector("#page-run")!.getAttribute("data-view")).toBe("run");
        // The work, the step's panel and the docked machine are what shows.
        expect(Array.from(app.querySelectorAll("#page-run > .column")).map(panelsIn)).toEqual([["run-preview", "camera-view"], ["run", "console"], ["machine"]]);
        expect(app.querySelector("#page-run")!.hasAttribute("data-dock")).toBe(true);
        expect(app.querySelector("#console")!.hasAttribute("data-collapsed")).toBe(true);
        // The step's own panels are marked to come first in a window too narrow for the work beside them; the dock is the last column.
        const columns = Array.from(app.querySelectorAll("#page-run > .column"));
        expect(columns.map((column) => column.hasAttribute("data-lead-column"))).toEqual([false, true, false]);
        expect(columns.map((column) => column.hasAttribute("data-dock-column"))).toEqual([false, false, true]);
        // The area shown whole has no step, so nothing leads.
        findButton(bar, "All panels").click();
        expect(columns.map((column) => column.hasAttribute("data-lead-column"))).toEqual([false, false, false]);
    });

    test("a step pressed stays, Back and Next walk the steps, and Next leads once the step is done", () => {
        const { app, store, bar } = mounted();
        showPage("run");
        store.set({ snapshot: connected(), jobs: [summary], job });
        const view = (): string | null => app.querySelector("#page-run")!.getAttribute("data-view");
        Array.from(bar.querySelectorAll<HTMLButtonElement>(".viewbar-step")).find((node) => node.textContent?.includes("Board"))!.click();
        expect(view()).toBe("board");
        expect(bar.querySelector(".viewbar-title")?.textContent).toBe("Board");
        expect((bar.querySelector(".viewbar-tag") as HTMLElement).hidden).toBe(false);
        // The state moving on does not take a pressed step away.
        store.set({ job: null });
        expect(view()).toBe("board");
        const next = bar.querySelector<HTMLButtonElement>(".viewbar-next")!;
        expect(next.textContent).toBe("Next: Height");
        expect(next.classList.contains("btn-primary")).toBe(false);
        next.click();
        expect(view()).toBe("height");
        bar.querySelector<HTMLButtonElement>(".viewbar-back")!.click();
        bar.querySelector<HTMLButtonElement>(".viewbar-back")!.click();
        expect(view()).toBe("job");
        // The Job step is not done with no job picked; picked, Next is the way on.
        expect(bar.querySelector<HTMLButtonElement>(".viewbar-next")!.classList.contains("btn-primary")).toBe(false);
        store.set({ job });
        expect(bar.querySelector<HTMLButtonElement>(".viewbar-next")!.classList.contains("btn-primary")).toBe(true);
        // The last step has no Next.
        showAreaView("run", "run");
        expect(bar.querySelector<HTMLButtonElement>(".viewbar-next")!.hidden).toBe(true);
    });

    test("All panels shows the area whole, is remembered, and pressed again gives the steps back", () => {
        const { app, bar } = mounted();
        showPage("run");
        const all = bar.querySelector<HTMLButtonElement>(".viewbar-all")!;
        all.click();
        expect(app.querySelector("#page-run")!.hasAttribute("data-view")).toBe(false);
        expect(all.getAttribute("aria-pressed")).toBe("true");
        expect(JSON.parse(localStorage.getItem(VIEWS_KEY)!)).toEqual({ run: ALL_VIEW });
        // No step is shown: nothing to go back or on from.
        expect(bar.querySelector<HTMLButtonElement>(".viewbar-next")!.hidden).toBe(true);
        expect(bar.querySelector<HTMLButtonElement>(".viewbar-back")!.hidden).toBe(true);
        expect(bar.querySelector(".viewbar-title")?.textContent).toBe("All panels");
        // The panels made for a step alone are left out of the area shown whole.
        expect(app.querySelector("#run-connect")!.classList.contains("hidden")).toBe(true);
        all.click();
        expect(app.querySelector("#page-run")!.getAttribute("data-view")).toBe("connect");
        expect(app.querySelector("#run-connect")!.classList.contains("hidden")).toBe(false);
        expect(JSON.parse(localStorage.getItem(VIEWS_KEY)!)).toEqual({});
    });

    test("the Job area's views are tabs, the one pressed remembered", () => {
        const { app, bar } = mounted();
        showPage("job");
        expect(names(bar)).toEqual(["Jobs", "Draw", "Assistant", "JSON"]);
        expect(bar.hasAttribute("data-steps")).toBe(false);
        expect(app.querySelector("#page-job")!.getAttribute("data-view")).toBe("jobs");
        Array.from(bar.querySelectorAll<HTMLButtonElement>(".viewbar-tab")).find((node) => node.textContent === "Draw")!.click();
        expect(app.querySelector("#page-job")!.getAttribute("data-view")).toBe("draw");
        expect(Array.from(app.querySelectorAll("#page-job > .column")).map(panelsIn)).toEqual([["mill-operation"], ["preview"], ["job-machine"]]);
        expect(JSON.parse(localStorage.getItem(VIEWS_KEY)!)).toEqual({ job: "draw" });
        // An area with no views has no bar.
        showPage("home");
        expect(bar.hidden).toBe(true);
    });

    test("a panel out of sight that has to be seen brings up the view that holds it", () => {
        const { app, store } = mounted();
        showPage("run");
        store.set({ snapshot: connected(), jobs: [summary], job });
        expect(app.querySelector("#page-run")!.getAttribute("data-view")).toBe("run");
        revealPanel("heightmap");
        expect(app.querySelector("#page-run")!.getAttribute("data-view")).toBe("height");
        // A panel no view holds shows with every panel.
        revealPanel("steps");
        expect(app.querySelector("#page-run")!.hasAttribute("data-view")).toBe(false);
    });

    test("how a step is drawn", () => {
        const [connect, job_, board] = jobSteps({ ...initialState(true), snapshot: connected() });
        expect(stepMark(connect!, false)).toBe("done");
        expect(stepMark(connect!, true)).toBe("now");
        expect(stepMark(job_!, false)).toBe("todo");
        expect(stepMark(board!, false)).toBe("optional");
    });
});
