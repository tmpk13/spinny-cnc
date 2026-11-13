import { beforeEach, describe, expect, test } from "bun:test";

import { MockBackend } from "../src/mock/backend.ts";
import { markFiltered } from "../src/mock/pnp.ts";
import { filterLine, keptOut, pickedToPlace, placeRefs, setPickedToPlace, shownParts } from "../src/views/partsfilter.ts";
import { mountPnp } from "../src/views/pnp.ts";
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

describe("parts kept out of the position files and the parts filter", () => {
    test("the kept-out parts show by choice, the filtered ones never, and a run asks for the picked ones", () => {
        const parts = [
            part("R1"),
            part("TP1", { exclude_from_pos_files: true }),
            part("TP2", { exclude_from_pos_files: true }),
            part("FID1", { fiducial: true, exclude_from_pos_files: true }),
            part("J1", { filtered: true }),
        ];
        expect(keptOut(parts[1]!)).toBe(true);
        expect(keptOut(parts[3]!)).toBe(false);
        expect(refs(shownParts(parts, true))).toEqual(["R1", "TP1", "TP2", "FID1"]);
        expect(refs(shownParts(parts, false))).toEqual(["R1", "FID1"]);
        // None picked: the backend decides; one picked: every placeable part and it.
        expect(placeRefs(parts, new Set())).toBeUndefined();
        expect(placeRefs(parts, new Set(["J1"]))).toBeUndefined();
        expect(placeRefs(parts, new Set(["TP2"]))).toEqual(["R1", "TP2"]);
        expect(filterLine(null, parts)).toBe("");
        expect(filterLine({ pattern: "^J", field: "ref", error: null }, parts)).toBe("1 part left out by the filter");
        expect(filterLine({ pattern: "[", field: "ref", error: "the parts filter is not a regular expression: x" }, parts)).toContain("not a regular expression");
    });

    test("the picks are kept per job", () => {
        setPickedToPlace("job-a", "TP1", true);
        setPickedToPlace("job-a", "TP2", true);
        setPickedToPlace("job-a", "TP1", false);
        expect([...pickedToPlace("job-a")]).toEqual(["TP2"]);
        expect([...pickedToPlace("job-b")]).toEqual([]);
        localStorage.removeItem("spinny.pnp.place.job-a");
    });

    test("the mock marks the parts its filter matches, by the field picked, any case", () => {
        const parts = [part("TP1", { value: "TestPoint", footprint: "TestPoint:TestPoint_Pad_D1.0mm" }), part("TPS1", { value: "TPS62130", footprint: "Package_DFN_QFN:QFN-16" })];
        expect(markFiltered(parts, { pattern: "^tp\\d", field: "ref" }).map((entry) => entry.filtered)).toEqual([true, false]);
        expect(markFiltered(parts, { pattern: "qfn", field: "footprint" }).map((entry) => entry.filtered)).toEqual([false, true]);
        expect(markFiltered(parts, { pattern: "^TPS", field: "any" }).map((entry) => entry.filtered)).toEqual([false, true]);
        expect(markFiltered(parts, { pattern: "(", field: "ref" }).map((entry) => entry.filtered)).toEqual([false, false]);
    });

    test("the mock's plan leaves a kept-out part out unless it is named, and a filtered one always", async () => {
        const backend = new MockBackend({ timers: false });
        const job = await backend.uploadJob(new File(["(kicad_pcb)"], "board.kicad_pcb"), {});
        const { components } = await backend.components(job.id);
        const hole = components.find((entry) => entry.ref === "H1")!;
        expect(hole.exclude_from_pos_files).toBe(true);
        await backend.connect("/dev/ttyACM1", "openpnp-marlin");
        await backend.pnpReference({ job: job.id, ref: components[0]!.ref, at: [40, 30] });
        const plan = await backend.pnpPlan(job.id);
        expect(plan.skipped).toContainEqual({ ref: "H1", reason: "kept out of the position files: pick it to place it" });
        const named = await backend.pnpPlan(job.id, ["H1"]);
        expect(named.skipped).toEqual([{ ref: "H1", reason: "no feeder holds it" }]);
        await expect(backend.setPartsFilter({ pattern: "(", field: "ref" })).rejects.toMatchObject({ status: 400 });
        expect((await backend.setPartsFilter({ pattern: "^TP1$", field: "ref" })).error).toBeNull();
        const filtered = await backend.pnpPlan(job.id, ["TP1"]);
        expect(filtered.skipped).toEqual([{ ref: "TP1", reason: "left out by the parts filter" }]);
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

const rowRefs = (root: HTMLElement): string[] => Array.from(root.querySelectorAll("table.pnp-parts tbody tr")).map((row) => row.querySelector("td")?.textContent ?? "");
const dotRefs = (root: HTMLElement, kind = ""): string[] => Array.from(root.querySelectorAll(`.pnp-part${kind}`)).map((dot) => dot.getAttribute("data-ref") ?? "");

describe("the pnp page's parts list", () => {
    test("kept-out parts are marked, hidden by the switch, and picked to be placed", async () => {
        const { roots, job } = await pnpPage();
        expect(rowRefs(roots.parts)).toContain("H1");
        const hole = Array.from(roots.parts.querySelectorAll("table.pnp-parts tbody tr")).find((row) => row.querySelector("td")?.textContent === "H1")!;
        expect(hole.classList.contains("kept-out")).toBe(true);
        expect(dotRefs(roots.board, ".kept-out")).toEqual(["H1"]);
        const place = hole.querySelector('input[aria-label="Place H1"]') as HTMLInputElement;
        place.click();
        expect([...pickedToPlace(job.id)]).toEqual(["H1"]);
        // The press on the box did not pick the row.
        expect(hole.classList.contains("selected")).toBe(false);
        const show = roots.parts.querySelector('input[aria-label="Show parts kept out of the position files"]') as HTMLInputElement;
        show.click();
        expect(rowRefs(roots.parts)).not.toContain("H1");
        expect(dotRefs(roots.board)).not.toContain("H1");
        expect(localStorage.getItem("spinny.pnp.keptout")).toBe("0");
        localStorage.removeItem(`spinny.pnp.place.${job.id}`);
    });

    test("the filter leaves its parts out of the list and the drawing, counts them, and says in place why one is refused", async () => {
        const { roots, calls } = await pnpPage();
        const pattern = roots.parts.querySelector('input[aria-label="Parts filter"]') as HTMLInputElement;
        const line = roots.parts.querySelector(".pnp-filter-line") as HTMLElement;
        const before = rowRefs(roots.parts);
        const asked = calls.filter((call) => call.name === "components").length;
        pattern.value = "^tp[12]$";
        pattern.dispatchEvent(new Event("input"));
        click(roots.parts, "Apply");
        await settle();
        await settle();
        await settle();
        expect(calls.filter((call) => call.name === "components").length).toBe(asked + 1);
        expect(rowRefs(roots.parts)).toEqual(before.filter((ref) => ref !== "TP1" && ref !== "TP2"));
        expect(dotRefs(roots.board)).not.toContain("TP1");
        expect(line.textContent).toBe("2 parts left out by the filter");
        // An expression that does not compile: said under the field, the one kept stays.
        pattern.value = "TP(";
        pattern.dispatchEvent(new Event("input"));
        click(roots.parts, "Apply");
        await settle();
        await settle();
        expect(line.classList.contains("error")).toBe(true);
        expect(line.textContent).toContain("not a regular expression");
        expect(rowRefs(roots.parts)).not.toContain("TP1");
    });
});
