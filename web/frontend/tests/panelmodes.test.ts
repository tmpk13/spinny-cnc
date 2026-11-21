// The modes: arrangements of every area's panels picked from the top bar,
// built in or the operator's own, each keeping the changes made while it
// shows; the rail leaving out an area a mode leaves blank; the page
// settings' Mode part.

import { afterEach, describe, expect, test } from "bun:test";
import { arrangedLayout } from "../src/layout.ts";
import { closeMenu } from "../src/menu.ts";
import {
    ALL_PANELS,
    BUILT_IN_MODES,
    PAGE_PANELS,
    baseLayouts,
    freshModes,
    matchingMode,
    migratedModes,
    modeChanged,
    modeList,
    modeNameProblem,
    MODES_KEY,
    OLD_PRESETS_KEY,
    ownKey,
    parseModes,
    withWorking,
    workingLayouts,
} from "../src/modes.ts";
import { mountPageSettings } from "../src/views/pagesettings.ts";
import { LAYOUT_KEY, mountPanels } from "../src/views/panels.ts";
import { fillModes, mountModePick, mountModes } from "../src/views/modes.ts";
import { mountTabs, setBlankPages, showPage, type PageId } from "../src/views/tabs.ts";
import { findButton, setup } from "./harness.ts";

afterEach(() => {
    closeMenu(false);
    document.getElementById("app")?.remove();
    setBlankPages([]);
    for (const key of [MODES_KEY, OLD_PRESETS_KEY, LAYOUT_KEY, "spinny.page", "spinny.side-pages", "spinny.tabs"]) {
        localStorage.removeItem(key);
    }
});

describe("the built-in modes", () => {
    test("name every area's panels as index.html has them", async () => {
        const html = await Bun.file(new URL("../index.html", import.meta.url)).text();
        const doc = new DOMParser().parseFromString(html, "text/html");
        for (const [page, ids] of Object.entries(PAGE_PANELS)) {
            const markup = Array.from(doc.querySelectorAll(`#page-${page} > .column > section.panel[id]`)).map((node) => node.id);
            expect([page, ...markup]).toEqual([page, ...ids]);
        }
    });

    test("each arranges only its area's own panels, every panel once", () => {
        for (const mode of BUILT_IN_MODES) {
            for (const [page, arrangement] of Object.entries(mode.pages)) {
                const own = PAGE_PANELS[page as PageId];
                const named = [...(arrangement.columns ?? []).flat(2), ...(arrangement.hidden ?? [])];
                for (const id of [...named, ...(arrangement.folded ?? [])]) {
                    expect(`${mode.id} ${page} ${id}: ${own.includes(id)}`).toBe(`${mode.id} ${page} ${id}: true`);
                }
                expect(new Set(named).size).toBe(named.length);
            }
        }
    });

    test("All panels is every panel as the page lays them out; the others open where their work is", () => {
        expect(BUILT_IN_MODES.map((mode) => mode.name)).toEqual(["All panels", "Laser/mill use", "Laser/mill config", "PNP use", "PNP config"]);
        expect(BUILT_IN_MODES[0]!.id).toBe(ALL_PANELS);
        expect(BUILT_IN_MODES[0]!.pages).toEqual({});
        expect(BUILT_IN_MODES.map((mode) => mode.opens ?? null)).toEqual([null, "run", "facts", "run", "cameras"]);
    });

    test("PNP use shows the board, its parts, its place, the feeders and the run, and leaves the laser's panels and the Setup side out", () => {
        const pnp = BUILT_IN_MODES.find((mode) => mode.id === "pnp-use")!;
        const run = pnp.pages.run!;
        for (const id of ["machine", "pnp-top-view", "pnp-view", "pnp-board", "pnp-parts", "place", "pnp-feeders", "run", "console"]) {
            expect(run.columns!.flat(2)).toContain(id);
        }
        for (const id of ["steps", "run-preview", "camera-view", "heightmap"]) {
            expect(run.hidden).toContain(id);
        }
        for (const page of ["job", "facts", "machines", "cameras", "cam"] as const) {
            expect(pnp.pages[page]!.hidden).toEqual(PAGE_PANELS[page]);
        }
        expect(pnp.pages.home).toBeUndefined();
        expect(pnp.pages.ui).toBeUndefined();
    });
});

describe("what is kept of the modes", () => {
    const defaults = { run: Object.assign([["machine"], ["steps", "place", "console"], ["heightmap", "run"]], {}), job: Object.assign([["jobs"], ["preview"]], {}) };

    test("reads back safely: malformed parts left out, a mode that is not there gives way to All panels", () => {
        expect(parseModes(null)).toBeNull();
        expect(parseModes("{")).toBeNull();
        expect(parseModes(JSON.stringify({ own: {} }))).toBeNull();
        const read = parseModes(JSON.stringify({
            current: "own:gone",
            own: { bench: { layouts: {}, page: "pnp" }, "PNP use": { layouts: {} }, " pad": { layouts: {} }, bad: 3, nolayouts: {} },
            working: { "pnp-use": {}, "own:bench": {}, nowhere: {}, "laser-use": 2 },
        }))!;
        expect(Object.keys(read.own)).toEqual(["bench"]);
        // An old page name is read as the area it went to.
        expect(read.own["bench"]!.page).toBe("run");
        expect(Object.keys(read.working).sort()).toEqual(["own:bench", "pnp-use"]);
        expect(read.current).toBe(ALL_PANELS);
    });

    test("a name must be given, short, and not a built-in mode's", () => {
        expect(modeNameProblem("")).not.toBeNull();
        expect(modeNameProblem("  ")).not.toBeNull();
        expect(modeNameProblem("pnp USE")).toContain("built in");
        expect(modeNameProblem("all")).toContain("built in");
        expect(modeNameProblem("x".repeat(41))).not.toBeNull();
        expect(modeNameProblem("bench")).toBeNull();
    });

    test("the layouts kept by name before there were modes become modes of the operator's own", () => {
        const modes = migratedModes(JSON.stringify({ bench: { run: {} }, Default: {}, " ": {}, bad: 3 }));
        expect(Object.keys(modes.own)).toEqual(["bench"]);
        expect(modes.own["bench"]).toEqual({ layouts: { run: {} }, page: null });
        expect(modeList(modes).map((entry) => entry.key)).toEqual([...BUILT_IN_MODES.map((mode) => mode.id), ownKey("bench")]);
    });

    test("a mode's changes are kept apart from its own layouts, and only while they differ", () => {
        const fresh = freshModes();
        const pnp = baseLayouts("pnp-use", fresh, defaults);
        expect(pnp["run"]!.panels["heightmap"]).toEqual({ hidden: true });
        expect(pnp["job"]!.panels["jobs"]).toEqual({ hidden: true });
        expect(baseLayouts(ALL_PANELS, fresh, defaults)).toEqual({});
        const changed = { ...pnp, run: { ...pnp["run"]!, panels: { ...pnp["run"]!.panels, heightmap: {} } } };
        const kept = withWorking(fresh, "pnp-use", changed, defaults);
        expect(modeChanged("pnp-use", kept)).toBe(true);
        expect(workingLayouts("pnp-use", kept, defaults)["run"]!.panels["heightmap"]).toBeUndefined();
        // Put back as the mode has them: nothing kept.
        expect(modeChanged("pnp-use", withWorking(kept, "pnp-use", pnp, defaults))).toBe(false);
        expect(matchingMode(pnp, fresh, defaults)).toBe("pnp-use");
        expect(matchingMode({}, fresh, defaults)).toBe(ALL_PANELS);
        expect(matchingMode(changed, fresh, defaults)).toBeNull();
    });
});

/** A page with every area, each with a few of its panels. */
function makeApp(): HTMLElement {
    const panel = (id: string): string => `<section id="${id}" class="panel" aria-label="${id}"><div class="panel-head"><h2>${id}</h2></div></section>`;
    const column = (...ids: string[]): string => `<div class="column">${ids.map(panel).join("")}</div>`;
    const app = document.createElement("div");
    app.id = "app";
    app.innerHTML = `
        <nav id="tabs" class="tabs"></nav>
        <div id="pane-use" class="pane" data-side="use">
            <main id="page-home" class="grid page">${column("overview")}</main>
            <main id="page-job" class="grid page">${column("jobs", "job")}${column("preview")}</main>
            <main id="page-run" class="grid page">${column("machine")}${column("steps", "run-preview", "camera-view", "pnp-view", "place", "console")}${column("pnp-parts", "pnp-board", "heightmap", "run")}</main>
        </div>
        <div id="pane-setup" class="pane" data-side="setup">
            <main id="page-facts" class="grid page">${column("facts")}${column("tests")}</main>
            <main id="page-machines" class="grid page">${column("connection")}${column("settings")}</main>
            <main id="page-cameras" class="grid page">${column("camera", "camera-picture")}${column("pnp-camera", "pnp-camera-picture")}${column("pnp-head")}</main>
            <main id="page-cam" class="grid page">${column("cam")}</main>
            <main id="page-ui" class="grid page">${column("version")}</main>
        </div>`;
    document.body.append(app);
    return app;
}

function mount() {
    const app = makeApp();
    const { store } = setup();
    const tools = mountTabs(app.querySelector("#tabs")!, store);
    const panels = mountPanels(app);
    const modes = mountModes(panels);
    const hidden = (id: string): boolean => app.querySelector(`#${id}`)!.hasAttribute("data-off");
    const tab = (page: string): HTMLButtonElement => app.querySelector<HTMLButtonElement>(`.tab[data-page="${page}"]`)!;
    return { app, store, tools, panels, modes, hidden, tab };
}

describe("the mode in use", () => {
    test("starts as All panels; a mode picked lays every area out its way and goes to the area it opens on", () => {
        const { app, panels, modes, hidden, tab } = mount();
        showPage("job");
        expect(modes.current()).toBe(ALL_PANELS);
        expect(panels.layouts()).toEqual({});
        modes.pick("pnp-use");
        expect(modes.current()).toBe("pnp-use");
        expect(app.getAttribute("data-page")).toBe("run");
        expect(hidden("heightmap")).toBe(true);
        expect(hidden("steps")).toBe(true);
        expect(hidden("pnp-board")).toBe(false);
        // Job and the Setup side's areas but the page's own have nothing to show: their tabs go.
        for (const page of ["job", "facts", "machines", "cameras", "cam"]) {
            expect(tab(page).hidden).toBe(true);
        }
        expect(tab("home").hidden).toBe(false);
        expect(tab("ui").hidden).toBe(false);
        const setupName = app.querySelector<HTMLElement>('.tabs-side-name[data-side="setup"]')!;
        expect(setupName.hidden).toBe(false);
        // A side with no area left to show has no name either.
        panels.setLayouts({ ...panels.layouts(), ui: { columns: [], panels: { version: { hidden: true } } } });
        expect(tab("ui").hidden).toBe(true);
        expect(setupName.hidden).toBe(true);
        modes.reset();
        expect(setupName.hidden).toBe(false);
        expect(JSON.parse(localStorage.getItem(MODES_KEY)!).current).toBe("pnp-use");
        // All panels again: every panel, every tab; the area shown stays.
        modes.pick(ALL_PANELS);
        expect(app.getAttribute("data-page")).toBe("run");
        expect(hidden("heightmap")).toBe(false);
        expect(tab("job").hidden).toBe(false);
    });

    test("keeps the changes made while it shows, apart from the other modes', until it is reset", () => {
        const { panels, modes, hidden } = mount();
        modes.pick("pnp-use");
        expect(modes.changed()).toBe(false);
        panels.showPanel("heightmap");
        expect(modes.changed()).toBe(true);
        modes.pick("laser-use");
        expect(hidden("pnp-board")).toBe(true);
        expect(modes.changed()).toBe(false);
        modes.pick("pnp-use");
        expect(hidden("heightmap")).toBe(false);
        expect(modes.changed()).toBe(true);
        modes.resetPage("run");
        expect(hidden("heightmap")).toBe(true);
        expect(modes.changed()).toBe(false);
        panels.showPanel("steps");
        modes.reset();
        expect(hidden("steps")).toBe(true);
        expect(modes.changed()).toBe(false);
    });

    test("the panels as they are kept as a mode of one's own, opening on the area shown; deleted in use, All panels takes its place", () => {
        const { app, panels, modes, hidden } = mount();
        modes.pick("pnp-use");
        panels.showPanel("heightmap");
        expect(modes.keep("pnp use")).toContain("built in");
        expect(modes.keep(" bench ")).toBeNull();
        expect(modes.current()).toBe(ownKey("bench"));
        expect(modes.changed()).toBe(false);
        expect(modes.list().at(-1)).toMatchObject({ key: ownKey("bench"), name: "bench", own: true });
        modes.pick(ALL_PANELS);
        showPage("home");
        modes.pick(ownKey("bench"));
        expect(app.getAttribute("data-page")).toBe("run");
        expect(hidden("heightmap")).toBe(false);
        expect(hidden("steps")).toBe(true);
        // PNP use kept its change too.
        modes.pick("pnp-use");
        expect(modes.changed()).toBe(true);
        modes.pick(ownKey("bench"));
        modes.remove(ownKey("bench"));
        expect(modes.current()).toBe(ALL_PANELS);
        expect(modes.list().some((entry) => entry.own)).toBe(false);
        expect(hidden("steps")).toBe(false);
    });

    test("an area left blank is not the one shown after a pick or a reload", () => {
        const { app, modes } = mount();
        showPage("job");
        modes.pick("laser-config");
        // Laser/mill config opens on the Checklist and has no Job area.
        expect(app.getAttribute("data-page")).toBe("facts");
        // The Use side turned from Job, which it no longer has, to its first area.
        showPage("home");
        expect(app.querySelector<HTMLButtonElement>('.tab[data-page="job"]')!.hidden).toBe(true);
        app.remove();
        setBlankPages([]);
        localStorage.setItem("spinny.page", "job");
        const again = mount();
        expect(again.modes.current()).toBe("laser-config");
        expect(again.app.getAttribute("data-page")).not.toBe("job");
    });

    test("the first time, the layouts kept by name become modes, and the panels as left are the mode they match", () => {
        const app = makeApp();
        const defaults = mountPanels(app).defaults();
        app.remove();
        const pnp = baseLayouts("pnp-use", freshModes(), defaults);
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(pnp));
        localStorage.setItem(OLD_PRESETS_KEY, JSON.stringify({ bench: { run: arrangedLayout({ hidden: ["steps"] }, defaults["run"]!) } }));
        const { modes } = mount();
        expect(modes.current()).toBe("pnp-use");
        expect(modes.changed()).toBe(false);
        expect(modes.list().filter((entry) => entry.own).map((entry) => entry.name)).toEqual(["bench"]);
    });

    test("the pick in the top bar lists the modes, the operator's apart, and marks the one in use when it has changes", () => {
        const { panels, modes } = mount();
        const host = document.createElement("div");
        document.body.append(host);
        const pick = mountModePick(host, modes);
        expect(pick.value).toBe(ALL_PANELS);
        expect(pick.querySelector("optgroup")).toBeNull();
        expect(Array.from(pick.options).map((option) => option.textContent)).toEqual(BUILT_IN_MODES.map((mode) => mode.name));
        pick.value = "pnp-use";
        pick.dispatchEvent(new Event("change"));
        expect(modes.current()).toBe("pnp-use");
        panels.showPanel("heightmap");
        expect(pick.selectedOptions[0]!.textContent).toBe("PNP use (changed)");
        expect(pick.title).toContain("Changed since");
        modes.keep("bench");
        expect(Array.from(pick.querySelectorAll("optgroup")).map((group) => group.label)).toEqual(["Built in", "Yours"]);
        expect(pick.value).toBe(ownKey("bench"));
        const other = document.createElement("select");
        fillModes(other, modes);
        expect(other.value).toBe(ownKey("bench"));
        host.remove();
    });
});

describe("the page settings' Mode part", () => {
    test("resets the mode in use once it has changes, keeps one of one's own under a name, and deletes it", () => {
        const { app, panels, modes, tools } = mount();
        mountPageSettings(tools, panels, modes);
        modes.pick("pnp-use");
        tools.querySelector<HTMLButtonElement>(".tabs-gear")!.click();
        const sheet = tools.querySelector<HTMLElement>(".page-settings")!;
        expect(findButton(sheet, "Reset PNP use").dataset["locked"]).toBe("1");
        panels.showPanel("heightmap");
        findButton(sheet, "Reset PNP use").click();
        expect(app.querySelector("#heightmap")!.hasAttribute("data-off")).toBe(true);
        const field = sheet.querySelector<HTMLInputElement>('input[aria-label="Mode name"]')!;
        field.value = "All panels";
        findButton(sheet, "Keep as").click();
        expect(sheet.querySelector(".page-settings-problem")?.textContent).toContain("built in");
        sheet.querySelector<HTMLInputElement>('input[aria-label="Mode name"]')!.value = "bench";
        findButton(sheet, "Keep as").click();
        expect(modes.current()).toBe(ownKey("bench"));
        findButton(sheet, "Delete bench").click();
        expect(modes.current()).toBe(ALL_PANELS);
        // The area's reset puts it back as the mode has it.
        expect(findButton(sheet, "Reset Run").title).toContain("All panels");
    });
});
