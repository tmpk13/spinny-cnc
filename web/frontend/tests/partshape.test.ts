import { describe, expect, test } from "bun:test";

import type { AppState } from "../src/state.ts";
import type { Component, PartShape } from "../src/types.ts";
import { boardTurn, partShapes, readAlignSet, shapeMarks, spreadParts, writeAlignSet } from "../src/views/partshape.ts";
import { mountPnp } from "../src/views/pnp.ts";
import { nextToAlign } from "../src/views/pnprefs.ts";
import { machineToPicture } from "../src/views/picture.ts";
import { click, findButton, settle, setup, pnpRoots } from "./harness.ts";

function part(ref: string, x: number, y: number, extra: Partial<Component> = {}): Component {
    return { ref, value: "10k", footprint: "R_0603", side: "front", x, y, rotation: 0, pads: 2, smd: true, dnp: false, ...extra };
}

describe("the parts to align to", () => {
    test("are spread over the board: fiducials first, then each part farthest from those chosen", () => {
        const parts = [
            part("R1", 0, 0), part("R2", 50, 0), part("R3", 25, 1), part("R4", 26, 40), part("R5", 1, 1),
            part("FID1", 10, 10, { fiducial: true }), part("FID2", 40, 30, { fiducial: true }),
            part("C1", 100, 100, { side: "back" }), part("C2", 60, 60, { dnp: true }),
        ];
        expect(spreadParts(parts, 2)).toEqual(["FID1", "FID2"]);
        // Then the part farthest from both fiducials: R2 (40 and 31 away), not R5.
        expect(spreadParts(parts, 3)).toEqual(["FID1", "FID2", "R2"]);
        // No fiducials: the two farthest apart start it; back and dnp parts are left out.
        expect(spreadParts(parts.filter((entry) => !entry.fiducial), 3)).toEqual(["R1", "R2", "R4"]);
        expect(spreadParts(parts, 3, "back")).toEqual(["C1"]);
        expect(nextToAlign(["FID1", "FID2", "R2"], new Set(["FID1"]))).toBe("FID2");
        expect(nextToAlign(["FID1"], new Set(["FID1"]))).toBeNull();
        writeAlignSet("j1", ["R1", "R4"]);
        expect(readAlignSet("j1")).toEqual(["R1", "R4"]);
        localStorage.removeItem("spinny.pnp.align.j1");
        expect(readAlignSet("j1")).toEqual([]);
    });

    test("a part's shape is drawn about the picture's center, turned with the board", () => {
        const shape: PartShape = { job: "j1", ref: "R1", pads: [[[0.5, -0.2], [1.0, -0.2], [1.0, 0.2], [0.5, 0.2]]], body: [[[-1, 0], [1, 0]]] };
        const calibration = { mmPerPx: 0.01, roll: 0, mirror: false };
        const marks = shapeMarks(shape, 90, calibration, [640, 480]);
        expect(marks.map((mark) => mark.kind)).toEqual(["line", "line"]);
        const pad = marks[1]!;
        expect(pad.kind === "line" && pad.closed).toBe(true);
        // The pad's first corner (0.5, -0.2) turned a quarter is (0.2, 0.5) off the center.
        const [dx, dy] = machineToPicture(0.2, 0.5, 0.01, 0, false);
        if (pad.kind === "line") {
            expect(pad.points[0]![0]).toBeCloseTo(320 + dx, 6);
            expect(pad.points[0]![1]).toBeCloseTo(240 + dy, 6);
        }
        expect(pad.tone).toBe("part");
    });

    test("the board's turn comes from the references, else the look, else the corners, else the angle typed", () => {
        const parts = [part("R1", 0, 0), part("R2", 10, 0)];
        const base = { job: { id: "j1" }, components: { job: "j1", components: parts, note: null } } as unknown as AppState;
        const with_ = (placing: object): AppState => ({ ...base, placing } as unknown as AppState);
        expect(boardTurn(with_({ references: [{ job: "j1", ref: "R1", at: [0, 0] }, { job: "j1", ref: "R2", at: [0, 10] }], angle: null }))).toBeCloseTo(90, 6);
        expect(boardTurn(with_({ references: [], angle: null, top: { board_look: { job: "j1", found: true, estimate: { rotation: 12 } } } }))).toBe(12);
        expect(boardTurn(with_({ references: [], angle: null, top: { board_look: { job: "j1", found: false, corners: { job: "j1", rough: { rotation: -3 } } } } }))).toBe(-3);
        expect(boardTurn(with_({ references: [], angle: 7 }))).toBe(7);
        expect(boardTurn(with_({ references: [], angle: null }))).toBe(0);
    });
});

describe("the parts to align to on the PNP page", () => {
    test("Choose picks them, a press picks one, Next goes the top camera over the next with no reference, and its shape is drawn", async () => {
        const { store, ctx, backend, calls } = setup();
        const roots = pnpRoots();
        const job = await backend.uploadJob(new File(["(kicad_pcb)"], "board.kicad_pcb"), {});
        const file = await backend.machineFile("openpnp-marlin");
        await backend.saveMachineFile("openpnp-marlin", `${file.text}\n[top_camera]\noffset = [20.0, 0.0]\n`);
        mountPnp(roots, ctx);
        await ctx.refreshJobs();
        await ctx.selectJob(job.id);
        store.set({ snapshot: await backend.connect("/dev/ttyACM1", "openpnp-marlin") });
        await ctx.refreshPlacing();
        await settle();
        await settle();
        const count = roots.refs.querySelector('input[aria-label="Parts to align to"]') as HTMLInputElement;
        count.value = "2";
        count.dispatchEvent(new Event("change"));
        click(roots.refs, "Choose");
        // The mock's board has two fiducials: they are the two.
        const chips = (): string[] => Array.from(roots.refs.querySelectorAll(".align-chip")).map((chip) => chip.textContent ?? "");
        expect(chips()).toEqual(["FID1", "FID2"]);
        expect(roots.refs.querySelector(".align-line")?.textContent).toContain("0 of 2 have a reference; next: FID1");
        // No reference yet: Next picks the first, to be found by hand.
        click(roots.refs, "Next");
        await settle();
        expect(store.get().pnpPart).toBe("FID1");
        expect(roots.parts.querySelector("tr.selected")?.getAttribute("data-ref")).toBe("FID1");
        // Taken by the camera: FID1 is marked, and Next goes the camera over FID2.
        await backend.command("G0 X80 Y30");
        click(roots.refs, "Camera here: FID1");
        await settle();
        await settle();
        expect(roots.refs.querySelector(".align-chip.taken")?.textContent).toBe("FID1");
        click(roots.refs, "Next");
        await settle();
        await settle();
        expect(store.get().pnpPart).toBe("FID2");
        const gone = calls.filter((call) => call.name === "pnpGoto").at(-1);
        expect(gone?.args[0]).toEqual({ job: job.id, ref: "FID2", camera: true });
        // A press on a chip picks its part; the part picked can be dropped from the set and added again.
        findButton(roots.refs, "FID1").click();
        expect(store.get().pnpPart).toBe("FID1");
        click(roots.refs, "Drop picked");
        expect(chips()).toEqual(["FID2"]);
        click(roots.refs, "Add picked");
        expect(chips()).toEqual(["FID2", "FID1"]);
        // A part's shape is asked for once, and said when it comes.
        let loaded = 0;
        const shapes = partShapes(ctx, () => loaded++);
        const board = store.get().job!;
        expect(shapes.get(board, "FID1")).toBeNull();
        await settle();
        expect(loaded).toBe(1);
        expect(shapes.get(board, "FID1")?.pads[0]?.length).toBe(16);
        expect(calls.filter((call) => call.name === "partShape").length).toBe(1);
        localStorage.removeItem(`spinny.pnp.align.${job.id}`);
        localStorage.removeItem("spinny.pnp.align.count");
    });
});
