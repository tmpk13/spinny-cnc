import { beforeEach, describe, expect, test } from "bun:test";

import { matchText, searchParts, stepMatch } from "../src/views/partsearch.ts";
import { mountPnp, viewOn } from "../src/views/pnp.ts";
import type { Component } from "../src/types.ts";
import { click, connected, settle, setup, pnpRoots } from "./harness.ts";

function part(ref: string, overrides: Partial<Component> = {}): Component {
    return { ref, value: "10k", footprint: "Resistor_SMD:R_0603", side: "front", x: 0, y: 0, rotation: 0, pads: 2, smd: true, dnp: false, ...overrides };
}

const refs = (parts: Component[]): string[] => parts.map((entry) => entry.ref);

beforeEach(() => {
    for (const key of ["spinny.pnp.keptout", "spinny.pnp.searchby", "spinny.pnp.target", "spinny.pnp.side"]) {
        localStorage.removeItem(key);
    }
});

describe("finding a part on the board", () => {
    test("matches the letters in order, the whole text first, ties in reference order", () => {
        const parts = [part("R10"), part("C1", { value: "100n" }), part("R1"), part("R21", { value: "10k 1%" }), part("U1", { value: "STM32" })];
        expect(refs(searchParts(parts, "r1", "ref"))).toEqual(["R1", "R10", "R21"]);
        expect(refs(searchParts(parts, "R1", "ref"))[0]).toBe("R1");
        expect(refs(searchParts(parts, "  ", "ref"))).toEqual([]);
        // By value: the exact value first, then the looser ones.
        expect(refs(searchParts(parts, "10k", "value"))).toEqual(["R1", "R10", "R21"]);
        expect(refs(searchParts(parts, "10k 1", "value"))).toEqual(["R21"]);
        expect(refs(searchParts(parts, "stm", "value"))).toEqual(["U1"]);
        expect(refs(searchParts(parts, "zz", "value"))).toEqual([]);
    });

    test("steps round the matches either way and says where it is", () => {
        expect(stepMatch(-1, 3, false)).toBe(0);
        expect(stepMatch(-1, 3, true)).toBe(2);
        expect(stepMatch(2, 3, false)).toBe(0);
        expect(stepMatch(0, 3, true)).toBe(2);
        expect(stepMatch(-1, 0, false)).toBe(-1);
        expect(matchText("", 0, -1)).toBe("");
        expect(matchText("q", 0, -1)).toBe("no match");
        expect(matchText("r", 1, -1)).toBe("1 match");
        expect(matchText("r", 4, 1)).toBe("2 of 4");
    });

    test("a part out of view brings the view to it, its size kept; one in view leaves it", () => {
        const limit = { x0: 0, y0: 0, x1: 100, y1: 100 };
        const view = { x0: 0, y0: 0, x1: 20, y1: 20 };
        expect(viewOn(view, 10, 10, limit)).toBe(view);
        expect(viewOn(view, 50, 60, limit)).toEqual({ x0: 40, y0: 50, x1: 60, y1: 70 });
        // Kept within the board.
        expect(viewOn(view, 99, 1, limit)).toEqual({ x0: 80, y0: 0, x1: 100, y1: 20 });
    });
});

/** The PNP page on the mock with a board job's parts listed. */
async function pnpPage() {
    const harness = setup();
    const { store, ctx, backend } = harness;
    const roots = pnpRoots();
    await backend.connect("/dev/ttyACM0");
    await backend.applyMachine("cartesian-mill");
    const job = await backend.uploadJob(new File(["(kicad_pcb)"], "board.kicad_pcb"), {});
    store.set({ snapshot: connected({}, { profile: { kinematics: "cartesian", tool: "spindle", h_axis: true, r_max: 0, z_max: 0 } }) });
    mountPnp(roots, ctx);
    await ctx.refreshJobs();
    await ctx.selectJob(job.id);
    await settle();
    await settle();
    return { ...harness, roots, job };
}

const dotRefs = (root: HTMLElement, kind = ""): string[] => Array.from(root.querySelectorAll(`.pnp-part${kind}`)).map((dot) => dot.getAttribute("data-ref") ?? "");

describe("the pnp page's board", () => {
    test("the search lights its matches, dims the rest, and Enter steps through them picking each", async () => {
        const { roots, store } = await pnpPage();
        const field = roots.board.querySelector('input[aria-label="Find a part on the board"]') as HTMLInputElement;
        field.value = "tp1";
        field.dispatchEvent(new Event("input"));
        const lit = dotRefs(roots.board, ".match");
        expect(lit[0]).toBe("TP1");
        expect(lit.length).toBeGreaterThan(0);
        expect(dotRefs(roots.board, ".dim")).toContain("FID1");
        const count = roots.board.querySelector(".pnp-search-count")!;
        expect(count.textContent).toBe(`${lit.length} match${lit.length === 1 ? "" : "es"}`);
        const enter = (shift = false): void => {
            field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: shift }));
        };
        enter();
        expect(store.get().pnpPart).toBe("TP1");
        expect(dotRefs(roots.board, ".selected")).toEqual(["TP1"]);
        expect(roots.parts.querySelector("tr.selected td")?.textContent).toBe("TP1");
        expect(count.textContent).toBe(`1 of ${lit.length}`);
        // Back round to the last match and forward again.
        field.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
        expect(store.get().pnpPart).toBe(lit[lit.length - 1]!);
        field.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
        expect(store.get().pnpPart).toBe("TP1");
        // A lone match stepped to again stays picked, not unpicked as a second click would.
        field.value = "fid1";
        field.dispatchEvent(new Event("input"));
        expect(dotRefs(roots.board, ".match")).toEqual(["FID1"]);
        enter();
        enter(true);
        expect(store.get().pnpPart).toBe("FID1");
        expect(count.textContent).toBe("1 of 1");
        // By value: the mounting hole's.
        click(roots.board, "Value");
        field.value = "mountinghole";
        field.dispatchEvent(new Event("input"));
        expect(dotRefs(roots.board, ".match")).toEqual(["H1"]);
        field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        expect(field.value).toBe("");
        expect(dotRefs(roots.board, ".dim")).toEqual([]);
    });
});
