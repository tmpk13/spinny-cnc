// The panels made of others: the Machine panel (position, jog, laser,
// markers), Board place (by hand, camera, marks, references) and the
// Height panel's rows lent by the jog and the Run panel. Each
// part keeps the id of the panel it was, the parts' titles give way to
// the panel's, and what else their heads held joins the panel's head or
// the way's summary.

import { afterEach, describe, expect, test } from "bun:test";
import { el } from "../src/dom.ts";
import { mountBoardPlace, placeLine, PLACE_WAYS } from "../src/views/boardplace.ts";
import { mountJog } from "../src/views/jog.ts";
import { mountMachine } from "../src/views/machine.ts";
import { mountRun } from "../src/views/run.ts";
import { connected, findButton, setup } from "./harness.ts";

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
        // The jog's own buttons lead the panel's head.
        expect(heads[0]!.contains(findButton(root, "Fine"))).toBe(true);
        expect(heads[0]!.contains(findButton(root, "Hold to move"))).toBe(true);
        // The tool's quick buttons and the markers are in the panel; the head box starts hidden.
        expect(root.contains(findButton(root, "Test beam"))).toBe(true);
        expect(root.querySelector("#markers")!.closest("details")?.querySelector("summary")?.textContent).toBe("Markers");
        expect(panel.head.classList.contains("hidden")).toBe(true);
        // The jog's rarely used rows fold under More.
        expect(root.querySelector("#jog details.jog-more summary")?.textContent).toBe("Go to, set position, motors");
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
