import { afterEach, describe, expect, test } from "bun:test";
import { closeMenu } from "../src/menu.ts";
import { initialState, Store, type AppState } from "../src/state.ts";
import { mountPageSettings } from "../src/views/pagesettings.ts";
import { LAYOUT_KEY, markCut, markupDefaults, moreMark, mountPanels, PRESETS_KEY, revealPanel } from "../src/views/panels.ts";
import { mountTabs, parseTabPrefs, readPage, TABS_KEY, writeTabPrefs } from "../src/views/tabs.ts";

/** A page like index.html's: two columns of panels with heads of each kind. */
function makeApp(): HTMLElement {
    const app = document.createElement("div");
    app.id = "app";
    app.innerHTML = `
        <main id="page-jobs" class="grid page">
            <div class="column">
                <section id="p-dro" class="panel" aria-label="Position"><div class="panel-head"><h2>Position</h2><span class="badge">age</span></div><p>body</p></section>
                <section id="p-laser" class="panel" aria-label="Laser"><h2>Laser</h2><fieldset class="panel-body"></fieldset></section>
                <section id="p-steps" class="panel" aria-label="Setup"><details class="panel-fold" open><summary class="panel-head"><h2>Setup</h2></summary><div class="panel-body">steps</div></details></section>
            </div>
            <div class="column">
                <section id="p-preview" class="panel" aria-label="Preview"><div class="panel-head"><h2>Preview</h2></div></section>
                <section id="p-console" class="panel" aria-label="Console"><div class="panel-head"><h2>Console</h2></div></section>
                <section id="p-device" class="panel hidden" aria-label="Device"><div class="panel-head"><h2>Device</h2></div></section>
            </div>
        </main>`;
    document.body.append(app);
    return app;
}

function ids(column: Element): string[] {
    return Array.from(column.children).filter((node) => node.matches("section.panel")).map((node) => node.id);
}

function pick(label: string): void {
    const item = Array.from(document.querySelectorAll<HTMLButtonElement>(".menu .menu-item")).find((node) => node.textContent === label);
    if (!item) {
        throw new Error(`no menu item ${label}`);
    }
    item.click();
}

function openMenuOf(id: string): void {
    document.querySelector<HTMLButtonElement>(`#${id} .panel-menu-button`)!.click();
}

afterEach(() => {
    closeMenu(false);
    document.getElementById("app")?.remove();
    // Every test file shares this storage.
    for (const key of [LAYOUT_KEY, PRESETS_KEY, TABS_KEY, "spinny.page"]) {
        localStorage.removeItem(key);
    }
});

describe("the panels' heads", () => {
    test("every head gets a menu after its title; a bare title gets a head; a disclosure keeps its own fold", () => {
        const app = makeApp();
        mountPanels(app);
        const dro = app.querySelector("#p-dro .panel-head")!;
        expect(Array.from(dro.children).map((node) => node.className)).toEqual(["panel-grip", "panel-chevron", "", "panel-menu-button", "panel-scroll", "panel-scroll", "badge"]);
        // The bare h2 is wrapped in a head of its own, the h2 the same node.
        const laser = app.querySelector("#p-laser")!;
        expect(laser.firstElementChild?.classList.contains("panel-head")).toBe(true);
        expect(laser.querySelector(".panel-head > h2")?.textContent).toBe("Laser");
        // The disclosure's summary gets the menu but no second fold button.
        const summary = app.querySelector("#p-steps summary")!;
        expect(summary.querySelector(".panel-menu-button")).not.toBeNull();
        expect(summary.querySelector(".panel-chevron")).toBeNull();
    });

    test("the fold button folds the panel to its head, and the fold is kept", () => {
        const app = makeApp();
        mountPanels(app);
        const chevron = app.querySelector<HTMLButtonElement>("#p-dro .panel-chevron")!;
        chevron.click();
        expect(app.querySelector("#p-dro")!.hasAttribute("data-collapsed")).toBe(true);
        expect(chevron.getAttribute("aria-expanded")).toBe("false");
        expect(JSON.parse(localStorage.getItem(LAYOUT_KEY)!).jobs.panels).toEqual({ "p-dro": { collapsed: true } });
        // A page opened again folds it again.
        app.remove();
        const again = makeApp();
        mountPanels(again);
        expect(again.querySelector("#p-dro")!.hasAttribute("data-collapsed")).toBe(true);
    });

    test("folding a disclosure panel from its menu opens and closes the disclosure", () => {
        const app = makeApp();
        mountPanels(app);
        openMenuOf("p-steps");
        pick("Fold");
        expect(app.querySelector<HTMLDetailsElement>("#p-steps details")!.open).toBe(false);
        openMenuOf("p-steps");
        pick("Unfold");
        expect(app.querySelector<HTMLDetailsElement>("#p-steps details")!.open).toBe(true);
    });
});

describe("the panel menu", () => {
    test("moves go up, down and across columns; the ends are disabled with a reason", () => {
        const app = makeApp();
        mountPanels(app);
        const [left, right] = Array.from(app.querySelectorAll(".column"));
        openMenuOf("p-dro");
        const up = Array.from(document.querySelectorAll<HTMLButtonElement>(".menu .menu-item")).find((node) => node.textContent === "Move up")!;
        expect(up.disabled).toBe(true);
        expect(up.dataset["reason"]).toBe("already at the top");
        pick("Move down");
        expect(ids(left!)).toEqual(["p-laser", "p-dro", "p-steps"]);
        openMenuOf("p-dro");
        pick("Move right");
        expect(ids(left!)).toEqual(["p-laser", "p-steps"]);
        expect(ids(right!)).toEqual(["p-preview", "p-dro", "p-console", "p-device"]);
    });

    test("a stack shows its front panel under a row of tabs; a tab brings its panel in front", () => {
        const app = makeApp();
        mountPanels(app);
        openMenuOf("p-console");
        pick("Stack with above");
        const strip = app.querySelector(".panel-tabs")!;
        expect(Array.from(strip.querySelectorAll(".panel-tab")).map((tab) => tab.textContent)).toEqual(["Preview", "Console"]);
        const console = app.querySelector("#p-console")!;
        const preview = app.querySelector("#p-preview")!;
        expect(console.hasAttribute("data-stacked")).toBe(true);
        expect(console.hasAttribute("data-join-up")).toBe(true);
        expect(preview.hasAttribute("data-behind")).toBe(true);
        // The row sits right before the stack's panels.
        expect(strip.nextElementSibling?.id).toBe("p-preview");
        Array.from(strip.querySelectorAll<HTMLButtonElement>(".panel-tab")).find((tab) => tab.textContent === "Preview")!.click();
        expect(preview.hasAttribute("data-behind")).toBe(false);
        expect(console.hasAttribute("data-behind")).toBe(true);
        // Unstacking takes the row away.
        openMenuOf("p-preview");
        pick("Unstack");
        expect(app.querySelector(".panel-tabs")).toBeNull();
        expect(console.hasAttribute("data-behind")).toBe(false);
    });

    test("a stack folds as one: its fold button folds every panel of it, and a tab shows its panel folded too", () => {
        const app = makeApp();
        mountPanels(app);
        openMenuOf("p-console");
        pick("Stack with above");
        const console = app.querySelector("#p-console")!;
        const preview = app.querySelector("#p-preview")!;
        app.querySelector<HTMLButtonElement>("#p-console .panel-chevron")!.click();
        expect(console.hasAttribute("data-collapsed")).toBe(true);
        expect(preview.hasAttribute("data-collapsed")).toBe(true);
        Array.from(app.querySelectorAll<HTMLButtonElement>(".panel-tab")).find((tab) => tab.textContent === "Preview")!.click();
        expect(preview.hasAttribute("data-behind")).toBe(false);
        expect(preview.hasAttribute("data-collapsed")).toBe(true);
        app.querySelector<HTMLButtonElement>("#p-preview .panel-chevron")!.click();
        expect(console.hasAttribute("data-collapsed")).toBe(false);
        expect(preview.hasAttribute("data-collapsed")).toBe(false);
        // Taken apart, each panel folds on its own again.
        openMenuOf("p-preview");
        pick("Unstack");
        app.querySelector<HTMLButtonElement>("#p-preview .panel-chevron")!.click();
        expect(preview.hasAttribute("data-collapsed")).toBe(true);
        expect(console.hasAttribute("data-collapsed")).toBe(false);
    });

    test("a stack of a disclosure and a panel folds as one, from either, and takes the fold of the panel put in front", () => {
        const app = makeApp();
        mountPanels(app);
        // The laser folded, then stacked under the open Setup: Setup is in front, so the stack is open.
        app.querySelector<HTMLButtonElement>("#p-laser .panel-chevron")!.click();
        openMenuOf("p-steps");
        pick("Stack with above");
        const details = app.querySelector<HTMLDetailsElement>("#p-steps details")!;
        const laser = app.querySelector("#p-laser")!;
        expect(details.open).toBe(true);
        expect(laser.hasAttribute("data-collapsed")).toBe(false);
        // Folded from the panel behind, by its tab's menu: the disclosure in front folds too.
        const tab = Array.from(app.querySelectorAll<HTMLButtonElement>(".panel-tab")).find((node) => node.textContent === "Laser")!;
        tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
        pick("Fold");
        expect(laser.hasAttribute("data-collapsed")).toBe(true);
        expect(details.open).toBe(false);
        // Opened by hand from its own head: the laser follows.
        details.open = true;
        details.dispatchEvent(new Event("toggle"));
        expect(laser.hasAttribute("data-collapsed")).toBe(false);
    });

    test("a box that scrolls is marked with what it does not show, and its mark scrolls it on", () => {
        const box = document.createElement("div");
        const sizes = { scrollTop: 0, clientHeight: 100, scrollHeight: 300 };
        for (const name of Object.keys(sizes) as (keyof typeof sizes)[]) {
            Object.defineProperty(box, name, { configurable: true, get: () => sizes[name] });
        }
        let scrolled = 0;
        box.scrollBy = ((options: ScrollToOptions) => {
            scrolled += options.top ?? 0;
        }) as typeof box.scrollBy;
        const mark = moreMark(box, "scroll on");
        expect(mark.hidden).toBe(true);
        expect(markCut(box, mark)).toBe(true);
        expect(box.hasAttribute("data-cut-bottom")).toBe(true);
        expect(box.hasAttribute("data-cut-top")).toBe(false);
        expect(mark.hidden).toBe(false);
        (mark.querySelector("button") as HTMLButtonElement).click();
        expect(scrolled).toBe(80);
        // Scrolled to its end: cut over it only.
        sizes.scrollTop = 200;
        markCut(box, mark);
        expect(box.hasAttribute("data-cut-top")).toBe(true);
        expect(box.hasAttribute("data-cut-bottom")).toBe(false);
        expect(mark.hidden).toBe(true);
        // Not to be marked: no marks at all, and nothing changes the next time.
        expect(markCut(box, mark, true)).toBe(true);
        expect(box.hasAttribute("data-cut-top")).toBe(false);
        expect(markCut(box, mark, true)).toBe(false);
    });

    test("every panel ends with its mark of more below, each column too; a folded stack's strip says it is folded", () => {
        const app = makeApp();
        mountPanels(app);
        for (const panel of Array.from(app.querySelectorAll<HTMLElement>("section.panel"))) {
            expect(panel.lastElementChild?.classList.contains("more-mark")).toBe(true);
            // Not held at a height: never marked.
            expect((panel.lastElementChild as HTMLElement).hidden).toBe(true);
        }
        for (const column of Array.from(app.querySelectorAll(".column"))) {
            expect(column.lastElementChild?.classList.contains("more-mark")).toBe(true);
        }
        openMenuOf("p-console");
        pick("Stack with above");
        app.querySelector<HTMLButtonElement>("#p-console .panel-chevron")!.click();
        expect(app.querySelector(".panel-tabs")!.hasAttribute("data-folded")).toBe(true);
        app.querySelector<HTMLButtonElement>("#p-console .panel-chevron")!.click();
        expect(app.querySelector(".panel-tabs")!.hasAttribute("data-folded")).toBe(false);
    });

    test("a panel its view hides leaves the stack's tabs, and comes back to them", () => {
        const app = makeApp();
        const panels = mountPanels(app);
        const device = app.querySelector("#p-device")!;
        openMenuOf("p-console");
        const below = Array.from(document.querySelectorAll<HTMLButtonElement>(".menu .menu-item")).find((node) => node.textContent === "Stack with below")!;
        // The device panel is hidden by its view: nothing below to stack with.
        expect(below.disabled).toBe(true);
        closeMenu(false);
        // happy-dom may drop the layer's observer at any garbage collection,
        // so the page is drawn again by hand after each change of the view.
        device.classList.remove("hidden");
        panels.refresh();
        openMenuOf("p-console");
        pick("Stack with below");
        expect(Array.from(app.querySelectorAll(".panel-tab")).map((tab) => tab.textContent)).toEqual(["Device", "Console"]);
        device.classList.add("hidden");
        panels.refresh();
        expect(app.querySelector(".panel-tabs") === null).toBe(true);
        expect(app.querySelector("#p-console")!.hasAttribute("data-behind")).toBe(false);
        device.classList.remove("hidden");
        panels.refresh();
        expect(app.querySelectorAll(".panel-tab").length).toBe(2);
    });

    test("stuck panels draw joined and move together", () => {
        const app = makeApp();
        mountPanels(app);
        openMenuOf("p-laser");
        pick("Stick to above");
        expect(app.querySelector("#p-dro")!.hasAttribute("data-join-down")).toBe(true);
        expect(app.querySelector("#p-laser")!.hasAttribute("data-join-up")).toBe(true);
        openMenuOf("p-steps");
        pick("Move up");
        expect(ids(app.querySelector(".column")!)).toEqual(["p-steps", "p-dro", "p-laser"]);
        openMenuOf("p-laser");
        pick("Unstick");
        expect(app.querySelector("#p-laser")!.hasAttribute("data-join-up")).toBe(false);
    });

    test("a block of stuck panels lays them side by side and back, the cells in one row", () => {
        const app = makeApp();
        mountPanels(app);
        openMenuOf("p-laser");
        pick("Stick to above");
        openMenuOf("p-laser");
        pick("Side by side");
        const row = app.querySelector(".column > .panel-row")!;
        expect(row).not.toBeNull();
        expect(Array.from(row.querySelectorAll(".panel-row-cell > section.panel")).map((node) => node.id)).toEqual(["p-dro", "p-laser"]);
        // Side by side, the panels are not joined, and the block is the column's first thing.
        expect(app.querySelector("#p-dro")!.hasAttribute("data-join-down")).toBe(false);
        expect(row.hasAttribute("data-first")).toBe(true);
        expect(JSON.parse(localStorage.getItem(LAYOUT_KEY)!).jobs.panels).toEqual({ "p-dro": { row: true } });
        openMenuOf("p-dro");
        pick("One above another");
        expect(app.querySelector(".panel-row")).toBeNull();
        expect(ids(app.querySelector(".column")!)).toEqual(["p-dro", "p-laser", "p-steps"]);
        expect(app.querySelector("#p-laser")!.hasAttribute("data-join-up")).toBe(true);
    });

    test("a stack is a folder: sheets behind for the panels behind, and a button that takes it apart", () => {
        const app = makeApp();
        mountPanels(app);
        openMenuOf("p-console");
        pick("Stack with above");
        const console = app.querySelector("#p-console")!;
        expect(console.getAttribute("data-depth")).toBe("1");
        expect(app.querySelector("#p-preview")!.hasAttribute("data-depth")).toBe(false);
        const apart = app.querySelector<HTMLButtonElement>(".panel-tabs .panel-tabs-apart")!;
        expect(apart.title).not.toBe("");
        apart.click();
        expect(app.querySelector(".panel-tabs")).toBeNull();
        expect(console.hasAttribute("data-depth")).toBe(false);
        expect(ids(app.querySelectorAll(".column")[1]!)).toEqual(["p-preview", "p-console", "p-device"]);
        // The menu takes a stack apart too.
        openMenuOf("p-console");
        pick("Stack with above");
        openMenuOf("p-console");
        pick("Take the stack apart");
        expect(app.querySelector(".panel-tabs")).toBeNull();
    });

    test("side by side, a folded panel's cell is marked to give its width away", () => {
        const app = makeApp();
        mountPanels(app);
        openMenuOf("p-laser");
        pick("Stick to above");
        openMenuOf("p-laser");
        pick("Side by side");
        const cell = app.querySelector("#p-laser")!.parentElement!;
        expect(cell.classList.contains("panel-row-cell")).toBe(true);
        expect(cell.hasAttribute("data-folded")).toBe(false);
        app.querySelector<HTMLButtonElement>("#p-laser .panel-chevron")!.click();
        expect(app.querySelector("#p-laser")!.parentElement!.hasAttribute("data-folded")).toBe(true);
        app.querySelector<HTMLButtonElement>("#p-laser .panel-chevron")!.click();
        expect(app.querySelector("#p-laser")!.parentElement!.hasAttribute("data-folded")).toBe(false);
    });

    test("the markup stacks a panel marked data-stack with the one before it", () => {
        const app = makeApp();
        const console = app.querySelector("#p-console")!;
        console.setAttribute("data-stack", "");
        app.querySelector("#p-device")!.setAttribute("data-stack", "");
        const defaults = markupDefaults(Array.from(app.querySelectorAll<HTMLElement>("#page-jobs > .column")));
        expect(defaults.stacked).toEqual({ "p-console": "p-preview", "p-device": "p-preview" });
        mountPanels(app);
        // The device panel is hidden by its view: the stack shows two tabs.
        expect(Array.from(app.querySelectorAll(".panel-tab")).map((tab) => tab.textContent)).toEqual(["Preview", "Console"]);
        expect(app.querySelector("#p-console")!.hasAttribute("data-behind")).toBe(true);
        // As the markup has it, nothing is stored.
        expect(localStorage.getItem(LAYOUT_KEY)).toBeNull();
    });

    test("hidden panels show for a while, marked, and hide again", () => {
        const app = makeApp();
        const panels = mountPanels(app);
        openMenuOf("p-dro");
        pick("Hide");
        panels.setPeeking(true);
        const dro = app.querySelector("#p-dro")!;
        expect(dro.hasAttribute("data-off")).toBe(false);
        expect(dro.hasAttribute("data-peek")).toBe(true);
        expect(panels.hiddenPanels().map((panel) => panel.id)).toEqual(["p-dro"]);
        panels.setPeeking(false);
        expect(dro.hasAttribute("data-off")).toBe(true);
        // Peeking, its menu shows it for good.
        panels.setPeeking(true);
        openMenuOf("p-dro");
        pick("Show for good");
        expect(panels.hiddenPanels()).toEqual([]);
    });

    test("a panel held at a height shows its scroll buttons, fitted or dragged", () => {
        const app = makeApp();
        mountPanels(app);
        const scrolls = Array.from(app.querySelectorAll<HTMLButtonElement>("#p-dro .panel-scroll"));
        expect(scrolls.every((node) => node.hidden)).toBe(true);
        openMenuOf("p-dro");
        pick("Fit to screen");
        expect(app.querySelector("#p-dro")!.hasAttribute("data-height")).toBe(true);
        expect(scrolls.every((node) => !node.hidden)).toBe(true);
        openMenuOf("p-dro");
        pick("Free height");
        expect(scrolls.every((node) => node.hidden)).toBe(true);
    });

    test("the bar's eye shows while a panel is hidden and toggles the peek; Done editing ends edit mode", () => {
        const app = makeApp();
        const panels = mountPanels(app);
        const tools = document.createElement("div");
        app.append(tools);
        mountPageSettings(tools, panels);
        const eye = tools.querySelector<HTMLButtonElement>(".tabs-peek")!;
        expect(eye.hidden).toBe(true);
        openMenuOf("p-dro");
        pick("Hide");
        expect(eye.hidden).toBe(false);
        expect(eye.title).toContain("1 hidden panel");
        // The eye counts them at its corner.
        expect(eye.dataset["count"]).toBe("1");
        eye.click();
        expect(panels.peeking()).toBe(true);
        expect(eye.getAttribute("aria-pressed")).toBe("true");
        // Shown for good, nothing is hidden: the peek ends and the eye goes.
        panels.showPanel("p-dro");
        expect(panels.peeking()).toBe(false);
        expect(eye.hidden).toBe(true);
        expect(eye.dataset["count"]).toBeUndefined();
        panels.setEditing(true);
        const done = tools.querySelector<HTMLButtonElement>(".tabs-done")!;
        expect(done.textContent).toBe("Done editing");
        done.click();
        expect(panels.editing()).toBe(false);
    });

    test("a hidden panel is listed and shown again; reset puts a panel back home", () => {
        const app = makeApp();
        const panels = mountPanels(app);
        openMenuOf("p-dro");
        pick("Hide");
        expect(app.querySelector("#p-dro")!.hasAttribute("data-off")).toBe(true);
        expect(panels.hiddenPanels()).toEqual([{ id: "p-dro", title: "Position", page: "jobs" }]);
        panels.showPanel("p-dro");
        expect(app.querySelector("#p-dro")!.hasAttribute("data-off")).toBe(false);
        openMenuOf("p-dro");
        pick("Move right");
        openMenuOf("p-dro");
        pick("Reset panel");
        expect(ids(app.querySelector(".column")!)).toEqual(["p-dro", "p-laser", "p-steps"]);
    });
});

describe("folders", () => {
    test("a panel makes a new folder, named after it and up for renaming; Enter keeps the name", () => {
        const app = makeApp();
        mountPanels(app);
        openMenuOf("p-laser");
        pick("New folder");
        const folder = app.querySelector(".column > .panel-folder")!;
        expect(Array.from(folder.querySelectorAll("section.panel")).map((node) => node.id)).toEqual(["p-laser"]);
        const field = folder.querySelector<HTMLInputElement>(".panel-folder-rename")!;
        expect(field.value).toBe("Laser");
        field.value = "Machine";
        field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        expect(folder.querySelector(".panel-folder-name")?.textContent).toBe("Machine");
        expect(folder.querySelector(".panel-folder-rename")).toBeNull();
        expect(JSON.parse(localStorage.getItem(LAYOUT_KEY)!).jobs.panels).toEqual({ "p-laser": { folder: "Machine" } });
        // Every button of its head says what it does.
        for (const node of Array.from(folder.querySelectorAll<HTMLButtonElement>(".panel-folder-head button"))) {
            expect(node.title).not.toBe("");
        }
        // Escape in a rename keeps the name it had.
        folder.querySelector<HTMLElement>(".panel-folder-name")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        const again = folder.querySelector<HTMLInputElement>(".panel-folder-rename")!;
        again.value = "Other";
        again.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        expect(folder.querySelector(".panel-folder-name")?.textContent).toBe("Machine");
    });

    test("panels go into a folder from anywhere on the page and out again; the folder shuts to its head, naming them", () => {
        const app = makeApp();
        mountPanels(app);
        openMenuOf("p-dro");
        pick("New folder");
        app.querySelector<HTMLInputElement>(".panel-folder-rename")!.blur();
        openMenuOf("p-console");
        pick("Into Position");
        openMenuOf("p-steps");
        pick("Into Position");
        const folder = app.querySelector(".panel-folder")!;
        expect(Array.from(folder.querySelectorAll("section.panel")).map((node) => node.id)).toEqual(["p-dro", "p-console", "p-steps"]);
        expect(folder.querySelector(".panel-folder-count")?.textContent).toBe("3 panels");
        // Inside a folder nothing joins.
        expect(app.querySelector("#p-console")!.hasAttribute("data-join-up")).toBe(false);
        // Shut: its head names what it holds, and its panels' handles go.
        folder.querySelector<HTMLButtonElement>(".panel-folder-head .panel-chevron")!.click();
        expect(folder.hasAttribute("data-shut")).toBe(true);
        expect(folder.querySelector(".panel-folder-count")?.textContent).toBe("3 panels: Position, Console, Setup");
        expect(Array.from(app.querySelectorAll<HTMLElement>(".panel-resize")).filter((node) => !node.hidden).length).toBe(2);
        folder.querySelector<HTMLButtonElement>(".panel-folder-head .panel-chevron")!.click();
        expect(folder.hasAttribute("data-shut")).toBe(false);
        // A panel in a folder moves among its panels, and out of it.
        openMenuOf("p-steps");
        pick("Up in the folder");
        expect(Array.from(folder.querySelectorAll("section.panel")).map((node) => node.id)).toEqual(["p-dro", "p-steps", "p-console"]);
        openMenuOf("p-console");
        pick("Out of Position");
        expect(Array.from(folder.querySelectorAll("section.panel")).map((node) => node.id)).toEqual(["p-dro", "p-steps"]);
        expect(app.querySelector("#p-console")!.parentElement!.classList.contains("column")).toBe(true);
    });

    test("a folder's menu moves it as one and takes it apart", () => {
        const app = makeApp();
        mountPanels(app);
        openMenuOf("p-laser");
        pick("New folder");
        app.querySelector<HTMLInputElement>(".panel-folder-rename")!.blur();
        openMenuOf("p-steps");
        pick("Into Laser");
        const [left, right] = Array.from(app.querySelectorAll(".column"));
        const folderMenu = (): void => app.querySelector<HTMLButtonElement>(".panel-folder-head .panel-menu-button")!.click();
        folderMenu();
        pick("Move up");
        expect(left!.firstElementChild?.classList.contains("panel-folder")).toBe(true);
        folderMenu();
        pick("Move right");
        expect(right!.querySelector(".panel-folder")).not.toBeNull();
        expect(ids(left!)).toEqual(["p-dro"]);
        folderMenu();
        pick("Take the folder apart");
        expect(app.querySelector(".panel-folder")).toBeNull();
        expect(ids(right!)).toEqual(["p-laser", "p-steps", "p-preview", "p-console", "p-device"]);
    });

    test("the markup puts a run of panels marked with one data-folder in a folder of that name, which a reset brings back", () => {
        const app = makeApp();
        for (const id of ["p-preview", "p-console"]) {
            app.querySelector(`#${id}`)!.setAttribute("data-folder", "View");
        }
        const columns = markupDefaults(Array.from(app.querySelectorAll<HTMLElement>(".column")));
        expect(columns.folders).toEqual({ "p-preview": "View" });
        expect(columns.stuck).toEqual({ "p-console": "p-preview" });
        const panels = mountPanels(app);
        const folder = app.querySelector(".panel-folder")!;
        expect(folder.querySelector(".panel-folder-name")?.textContent).toBe("View");
        expect(Array.from(folder.querySelectorAll("section.panel")).map((node) => node.id)).toEqual(["p-preview", "p-console"]);
        // The markup's own: nothing kept.
        expect(localStorage.getItem(LAYOUT_KEY) === null || JSON.parse(localStorage.getItem(LAYOUT_KEY)!).jobs === undefined).toBe(true);
        expect(app.querySelector("#page-jobs")!.hasAttribute("data-arranged")).toBe(false);
        app.querySelector<HTMLButtonElement>(".panel-folder-head .panel-menu-button")!.click();
        pick("Take the folder apart");
        expect(app.querySelector(".panel-folder")).toBeNull();
        panels.resetPage("jobs");
        expect(app.querySelector(".panel-folder .panel-folder-name")?.textContent).toBe("View");
    });
});

describe("the page's own markup", () => {
    test("groups the Run area's camera panels by camera, the ways to place the board, and the Job area's machine panels, in folders", async () => {
        const html = await Bun.file(new URL("../index.html", import.meta.url)).text();
        const doc = new DOMParser().parseFromString(html, "text/html");
        const defaults = (page: string) => markupDefaults(Array.from(doc.querySelectorAll<HTMLElement>(`#page-${page} > .column`)));
        expect(defaults("run").folders).toEqual({ "camera-view": "Camera", "pnp-view": "Bottom camera", "pnp-top-view": "Top camera", find: "Board place" });
        expect(defaults("run").stuck).toEqual({ camera: "camera-view", "pnp-camera": "pnp-view", "pnp-top": "pnp-top-view", align: "find", "pnp-refs": "find" });
        expect(defaults("run").stacked).toEqual({
            "camera-controls": "camera", "camera-sight": "camera", "camera-changes": "camera",
            "pnp-camera-controls": "pnp-camera", "pnp-camera-sight": "pnp-camera", "pnp-camera-changes": "pnp-camera",
            "pnp-top-controls": "pnp-top", "pnp-top-sight": "pnp-top", "pnp-top-changes": "pnp-top",
        });
        expect(defaults("job").folders).toEqual({ "mill-dro": "Machine" });
        expect(defaults("job").stacked).toEqual({ "auto-about": "auto-chat" });
        // The calibration tests are setup: the Checklist's page has them.
        expect(doc.querySelector("#pane-setup #page-facts #tests")).not.toBeNull();
        expect(doc.querySelector("#pane-use #tests")).toBeNull();
    });

    test("every panel's menu turns edit mode on and off", () => {
        const app = makeApp();
        const panels = mountPanels(app);
        openMenuOf("p-dro");
        pick("Edit panels");
        expect(panels.editing()).toBe(true);
        expect(app.hasAttribute("data-edit")).toBe(true);
        openMenuOf("p-laser");
        pick("Done editing");
        expect(panels.editing()).toBe(false);
    });
});

describe("kept layouts", () => {
    test("a layout kept by name comes back from its name; Default is the markup's", () => {
        const app = makeApp();
        const panels = mountPanels(app);
        expect(panels.currentPreset()).toBe("Default");
        openMenuOf("p-console");
        pick("Stack with above");
        expect(panels.currentPreset()).toBeNull();
        expect(panels.savePreset("Default")).toContain("built-in");
        expect(panels.savePreset(" bench ")).toBeNull();
        expect(panels.presetNames()).toEqual(["bench"]);
        expect(panels.currentPreset()).toBe("bench");
        panels.resetPage("jobs");
        expect(app.querySelector(".panel-tabs")).toBeNull();
        expect(panels.currentPreset()).toBe("Default");
        panels.applyPreset("bench");
        expect(app.querySelector(".panel-tabs")).not.toBeNull();
        panels.applyPreset("Default");
        expect(app.querySelector(".panel-tabs")).toBeNull();
        panels.deletePreset("bench");
        expect(panels.presetNames()).toEqual([]);
    });

    test("edit mode is a mark on the app", () => {
        const app = makeApp();
        const panels = mountPanels(app);
        panels.setEditing(true);
        expect(app.hasAttribute("data-edit")).toBe(true);
        panels.setEditing(false);
        expect(app.hasAttribute("data-edit")).toBe(false);
    });

    test("revealing a panel shows it, unfolds it and puts it in front of its stack", () => {
        const app = makeApp();
        mountPanels(app);
        openMenuOf("p-console");
        pick("Stack with above");
        openMenuOf("p-preview");
        pick("Hide");
        app.querySelector<HTMLButtonElement>("#p-console .panel-chevron")!.click();
        app.querySelector<HTMLDetailsElement>("#p-steps details")!.open = false;
        revealPanel("p-preview");
        expect(app.querySelector("#p-preview")!.hasAttribute("data-off")).toBe(false);
        expect(app.querySelector("#p-preview")!.hasAttribute("data-behind")).toBe(false);
        revealPanel("p-console");
        expect(app.querySelector("#p-console")!.hasAttribute("data-collapsed")).toBe(false);
        revealPanel("p-steps");
        expect(app.querySelector<HTMLDetailsElement>("#p-steps details")!.open).toBe(true);
    });
});

describe("the tab bar's settings", () => {
    test("stored settings read safely; old page names are read as the new ones", () => {
        expect(parseTabPrefs(null)).toEqual({ start: "last", fold: false, hidden: [] });
        expect(parseTabPrefs("{")).toEqual({ start: "last", fold: false, hidden: [] });
        expect(parseTabPrefs(JSON.stringify({ start: "mill", fold: true, hidden: ["config", "nope", "pnp"] })))
            .toEqual({ start: "job", fold: true, hidden: ["run", "machines"] });
    });

    test("the start page wins over the page last shown", () => {
        localStorage.setItem("spinny.page", "cam");
        expect(readPage()).toBe("cam");
        writeTabPrefs({ start: "machines", fold: false, hidden: [] });
        expect(readPage()).toBe("machines");
        writeTabPrefs({ start: "last", fold: false, hidden: [] });
        expect(readPage()).toBe("cam");
    });

    test("a tab kept out of the bar opens from More, which names the page when it is shown", () => {
        const app = document.createElement("div");
        app.id = "app";
        const nav = document.createElement("nav");
        nav.className = "tabs";
        app.append(nav);
        document.body.append(app);
        mountTabs(nav, new Store<AppState>(initialState(true)));
        const more = nav.querySelector<HTMLButtonElement>(".tabs-more")!;
        expect(more.hidden).toBe(true);
        writeTabPrefs({ start: "last", fold: true, hidden: ["cam"] });
        expect(nav.querySelector<HTMLButtonElement>('.tab[data-page="cam"]')!.hidden).toBe(true);
        expect(more.hidden).toBe(false);
        expect(more.textContent).toBe("More");
        expect(nav.hasAttribute("data-fold")).toBe(true);
        more.click();
        pick("CAM");
        expect(app.getAttribute("data-page")).toBe("cam");
        expect(more.textContent).toBe("CAM");
        expect(more.getAttribute("aria-current")).toBe("page");
        expect(nav.querySelector<HTMLElement>(".tabs-strip")!.dataset["label"]).toBe("CAM");
    });
});
