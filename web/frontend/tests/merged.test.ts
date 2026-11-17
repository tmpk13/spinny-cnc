// The panels made of others: the Machine panel (position, jog, laser,
// markers), Board place (by hand, camera, marks, references) and the
// Height panel's rows lent by the jog and the Run panel. Each
// part keeps the id of the panel it was, the parts' titles give way to
// the panel's, and what else their heads held joins the panel's head or
// the way's summary.

import { afterEach, describe, expect, test } from "bun:test";
import { asPart, el } from "../src/dom.ts";
import { FIT_RULES, mountFit, placesParts } from "../src/views/fit.ts";
import { mountBoardPlace, placeLine, PLACE_WAYS } from "../src/views/boardplace.ts";
import { mountJobs } from "../src/views/jobs.ts";
import { mountJog } from "../src/views/jog.ts";
import { mountMachine } from "../src/views/machine.ts";
import { mountRun } from "../src/views/run.ts";
import { connected, findButton, settle, setup } from "./harness.ts";

afterEach(() => {
    document.body.replaceChildren();
    for (const way of PLACE_WAYS) {
        localStorage.removeItem(`spinny.place.${way.key}`);
    }
});

describe("the Machine panel", () => {
    test("holds the position, the jog, the tool and the markers under one title, the parts keeping their ids", () => {
        const { ctx, root, store } = setup();
        store.set({ snapshot: connected() });
        const panel = mountMachine(root, ctx, "run", { dro: "dro", jog: "jog", laser: "laser", markers: "markers" });
        const heads = Array.from(root.children).filter((child) => child.classList.contains("panel-head"));
        expect(heads.length).toBe(1);
        expect(Array.from(root.querySelectorAll("h2")).map((h2) => h2.textContent)).toEqual(["Machine"]);
        for (const id of ["dro", "jog", "laser", "markers"]) {
            expect(root.querySelector(`#${id}`)).not.toBeNull();
        }
        // The jog's own buttons lead the panel's head; the step size is with the pad it sets.
        expect(heads[0]!.contains(findButton(root, "Hold to move"))).toBe(true);
        expect(heads[0]!.contains(findButton(root, "Cancel"))).toBe(true);
        expect(root.querySelector("#jog")!.contains(findButton(root, "Fine"))).toBe(true);
        // In a view the head's Jog opens and shuts the jog, the tool and the markers.
        expect(heads[0]!.contains(findButton(root, "Jog"))).toBe(true);
        expect(root.hasAttribute("data-open")).toBe(false);
        findButton(root, "Jog").click();
        expect(root.hasAttribute("data-open")).toBe(true);
        panel.setOpen(false);
        expect(root.hasAttribute("data-open")).toBe(false);
        // A link or the search going to a part inside opens it.
        root.querySelector("#markers")!.dispatchEvent(new CustomEvent("spinny:show", { bubbles: true }));
        expect(root.hasAttribute("data-open")).toBe(true);
        panel.setOpen(false);
        // The tool's quick buttons and the markers are in the panel; the head box starts hidden.
        expect(root.contains(findButton(root, "Test beam"))).toBe(true);
        expect(root.querySelector("#markers")!.closest("details")?.querySelector("summary")?.textContent).toBe("Markers");
        expect(panel.head.classList.contains("hidden")).toBe(true);
        // The jog's rarely used rows fold under More.
        expect(root.querySelector("#jog details.jog-more summary")?.textContent).toBe("More: own steps, zero, go to, motors");
    });
});

describe("Board place", () => {
    test("says where the selected job is and what placed it", () => {
        const { store } = setup();
        const state = store.get();
        expect(placeLine(state)).toBe("no job selected");
        const job = { id: "j1", name: "board", offset: { x: 1.5, y: -2 }, rotation: 0 } as unknown as NonNullable<typeof state.job>;
        expect(placeLine({ ...state, job })).toBe("X 1.50 Y -2.00 mm");
        const turned = { ...job, rotation: 90 } as typeof job;
        const align = { job: "j1", marks: [{}, {}] as never[], fit: null };
        expect(placeLine({ ...state, job: turned, align })).toBe("X 1.50 Y -2.00 mm, turned 90.00 deg, 2 marks taken");
    });

    test("a fold for each way, its box keeping the old panel's id; the views' titles give way to the folds'", () => {
        const { ctx, root } = setup();
        const place = mountBoardPlace(root, ctx);
        expect(Array.from(root.querySelectorAll(".place-way > summary h3")).map((h3) => h3.textContent)).toEqual(["By hand", "By camera", "By marks", "By references"]);
        expect(place.parts.find.id).toBe("find");
        expect(place.parts.align.id).toBe("align");
        expect(place.parts.refs.id).toBe("pnp-refs");
        // A view's own head and a view's own fold, as Find board and Align draw them.
        place.parts.find.append(el("div", { class: "panel-head" }, el("h2", {}, "Find board"), el("span", { class: "badge" }, "stopped")), el("p", {}, "body"));
        const fold = el("details", { class: "panel-fold" }, el("summary", { class: "panel-head" }, el("h2", {}, "Align"), el("span", { class: "badge" }, "no marks")), el("fieldset", {}, "marks"));
        place.parts.align.append(fold);
        place.finish();
        expect(place.parts.find.querySelector(".panel-head")).toBeNull();
        expect(place.parts.find.textContent).toBe("body");
        expect(place.parts.find.closest("details")!.querySelector("summary")!.textContent).toBe("By camerastopped");
        // Align's fold goes; its body stays, its badge joins the summary.
        expect(place.parts.align.querySelector("details")).toBeNull();
        expect(place.parts.align.querySelector("fieldset")?.textContent).toBe("marks");
        expect(place.parts.align.closest("details")!.querySelector("summary")!.textContent).toBe("By marksno marks");
        expect(root.querySelectorAll("h2").length).toBe(1);
    });

    test("a fold opened or closed stays so in this browser", () => {
        const { ctx, root } = setup();
        mountBoardPlace(root, ctx);
        const marks = root.querySelectorAll<HTMLDetailsElement>(".place-way")[2]!;
        expect(marks.open).toBe(false);
        marks.open = true;
        marks.dispatchEvent(new Event("toggle"));
        expect(localStorage.getItem("spinny.place.align")).toBe("1");
        document.body.replaceChildren();
        const again = setup();
        mountBoardPlace(again.root, again.ctx);
        expect(again.root.querySelectorAll<HTMLDetailsElement>(".place-way")[2]!.open).toBe(true);
    });
});

describe("the Height panel's rows from other views", () => {
    test("the jog draws the travel height where it is handed a box, and nowhere when handed none", () => {
        const { ctx, root, store } = setup();
        store.set({ snapshot: connected() });
        const box = document.createElement("div");
        mountJog(root, ctx, "run", () => true, { travel: box });
        expect(box.querySelector('input[aria-label="Travel height H"]')).not.toBeNull();
        expect(root.querySelector('input[aria-label="Travel height H"]')).toBeNull();
        const other = document.createElement("section");
        mountJog(other, ctx, "job", () => true, { travel: null });
        expect(other.querySelector('input[aria-label="Travel height H"]')).toBeNull();
    });

    test("the Run panel lends its choice of how a run follows the map, and keeps the chip that says it", () => {
        const { ctx, root } = setup();
        const host = document.createElement("div");
        mountRun(root, ctx, { mapHost: host });
        expect(host.querySelector('select[aria-label="Height map"]')).not.toBeNull();
        expect(root.querySelector('select[aria-label="Height map"]')).toBeNull();
        expect(root.querySelector(".map-use")).not.toBeNull();
    });
});

describe("the Jobs panel and the Job panel", () => {
    test("the next import's settings sit in the import dialog, said in words under the drop area", () => {
        const { ctx, root } = setup();
        const run = document.createElement("section");
        mountJobs(root, ctx, run);
        const dialog = root.querySelector(".layer-chooser") as HTMLElement;
        const power = root.querySelector(".import-settings input") as HTMLInputElement;
        expect(dialog.contains(power)).toBe(true);
        expect(dialog.classList.contains("hidden")).toBe(true);
        const line = root.querySelector(".import-line")!;
        expect(line.textContent).toBe("Next import: S500, 400 mm/min, spot 0.1 mm, centered on the axis; a board's F.Cu isolate.");
        findButton(root, "Import settings").click();
        expect(dialog.classList.contains("hidden")).toBe(false);
        // Opened for the settings alone: no layer to pick, Done to close.
        expect(dialog.querySelector(".layer-chooser-row")!.classList.contains("hidden")).toBe(true);
        power.value = "300";
        power.dispatchEvent(new Event("input", { bubbles: true }));
        expect(line.textContent).toContain("S300,");
        findButton(dialog, "Done").click();
        expect(dialog.classList.contains("hidden")).toBe(true);
    });

    test("a file other than a board goes at once, with the settings shown", async () => {
        const { ctx, root, calls } = setup();
        mountJobs(root, ctx, document.createElement("section"));
        const event = new Event("drop", { cancelable: true });
        Object.defineProperty(event, "dataTransfer", { value: { files: [new File(['<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L10 0"/></svg>'], "line.svg")] } });
        root.querySelector(".drop")!.dispatchEvent(event);
        for (let i = 0; i < 5; i++) {
            await settle();
        }
        expect(calls.filter((call) => call.name === "uploadJob")[0]?.args[1]).toMatchObject({ power: 500, speed: 400, spot: 0.1 });
        expect((root.querySelector(".layer-chooser") as HTMLElement).classList.contains("hidden")).toBe(true);
    });

    test("the selected job's groups go to the Job panel when there is one", async () => {
        const { ctx, root, store } = setup();
        const job = document.createElement("section");
        mountJobs(root, ctx, document.createElement("section"), { details: job });
        await ctx.refreshJobs();
        await ctx.selectJob(store.get().jobs[0]!.id);
        expect(root.querySelector(".job-details")).toBeNull();
        expect(job.querySelector(".job-details h3")?.textContent).toBe(store.get().job!.name);
    });
});

describe("the Run area follows the machine", () => {
    const shown = (state: Parameters<typeof placesParts>[0]): string[] => FIT_RULES.filter(([, shows]) => shows(state)).map(([id]) => id);

    test("a laser shows its heights and head camera, no parts; a G-code pick and place machine the reverse", () => {
        const { store } = setup();
        const none = store.get();
        expect(shown(none)).toEqual(["camera-view", "heightmap", "pnp-parts", "pnp-board", "pnp-view"]);
        const laser = { ...none, snapshot: connected() };
        expect(shown(laser)).toEqual(["camera-view", "heightmap"]);
        const nozzle = { ...none, snapshot: connected({}, { profile: { kinematics: "cartesian", tool: "nozzle", h_axis: true, r_max: 0, z_max: 0 } }) };
        expect(placesParts(nozzle)).toBe(true);
        const gcode = { ...none, snapshot: connected({}, { profile: { kinematics: "cartesian", tool: "nozzle", h_axis: false, r_max: 0, z_max: 0, controller: "gcode" } }) };
        expect(shown(gcode)).toEqual(["pnp-parts", "pnp-board", "pnp-view"]);
    });

    test("mountFit hides and shows the panels found as the state changes", () => {
        const { store } = setup();
        const panels = new Map(FIT_RULES.map(([id]) => [id, el("section", { id, class: "panel" })]));
        mountFit((listener) => {
            store.subscribe(listener, ["snapshot"]);
            listener(store.get());
        }, (id) => panels.get(id) ?? null);
        expect(panels.get("pnp-parts")!.classList.contains("hidden")).toBe(false);
        store.set({ snapshot: connected() });
        expect(panels.get("pnp-parts")!.classList.contains("hidden")).toBe(true);
        expect(panels.get("heightmap")!.classList.contains("hidden")).toBe(false);
    });
});

test("a view mounted as a part of another panel has a section heading, not a panel head", () => {
    const part = el("div", {}, el("div", { class: "panel-head" }, el("h2", {}, "Placing"), el("span", { class: "badge" }, "0 boards")), el("p", {}, "body"));
    asPart(part);
    expect(part.querySelector(".panel-head")).toBeNull();
    expect(part.querySelector(".part-head h3")?.textContent).toBe("Placing");
    expect(part.querySelector(".part-head .badge")?.textContent).toBe("0 boards");
    expect(part.querySelector("h2")).toBeNull();
});
