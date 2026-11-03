import { describe, expect, test } from "bun:test";

import { MockBackend, PNP_STEP_SECONDS } from "../src/mock/backend.ts";
import { UP_TRUTH, upPicturePoint } from "../src/mock/pnp.ts";
import { MOCK_CAMERAS } from "../src/mock/vision.ts";
import type { Component, PnpState } from "../src/types.ts";
import {
    cameraOnBoard,
    drawingBox,
    filterParts,
    footprintName,
    mountPnp,
    partOffsetText,
    placeHead,
    boardSvg,
    pnpRoutineText,
} from "../src/views/pnp.ts";
import { click, connected, runUntilIdle, settle, setup } from "./harness.ts";

function part(ref: string, overrides: Partial<Component> = {}): Component {
    return { ref, value: "10k", footprint: "Resistor_SMD:R_0603", side: "front", x: 0, y: 0, rotation: 0, pads: 2, smd: true, dnp: false, ...overrides };
}

/** A mock X/Y machine with the up camera running and a board job uploaded. */
async function xyMock(): Promise<{ backend: MockBackend; jobId: string }> {
    const backend = new MockBackend({ timers: false });
    await backend.connect("/dev/ttyACM0");
    await backend.applyMachine("cartesian-mill");
    const job = await backend.uploadJob(new File(["(kicad_pcb)"], "board.kicad_pcb"), {});
    await backend.pnpStart();
    return { backend, jobId: job.id };
}

/** Steps the mock's clock until the up camera routine has ended, or a minute has gone by. */
async function runRoutine(backend: MockBackend): Promise<PnpState> {
    for (let t = 0; t < 60; t += 0.05) {
        backend.step(0.05);
        if ((await backend.pnp()).routine?.state !== "running") {
            break;
        }
    }
    return backend.pnp();
}

describe("pnp helpers", () => {
    test("parts filter by any word of ref, value or footprint, and by side", () => {
        const parts = [part("R1"), part("C1", { value: "100n", footprint: "Capacitor_SMD:C_0402", side: "back" }), part("U1", { value: "STM32" })];
        expect(filterParts(parts, "", "all").map((p) => p.ref)).toEqual(["R1", "C1", "U1"]);
        expect(filterParts(parts, "c_04", "all").map((p) => p.ref)).toEqual(["C1"]);
        expect(filterParts(parts, "stm u1", "all").map((p) => p.ref)).toEqual(["U1"]);
        expect(filterParts(parts, "", "back").map((p) => p.ref)).toEqual(["C1"]);
        expect(footprintName("Resistor_SMD:R_0603")).toBe("R_0603");
        expect(footprintName("bare")).toBe("bare");
    });

    test("the up camera's place turns with the table, and the drawing's box takes in everything", () => {
        expect(cameraOnBoard(null, 0)).toBeNull();
        const turned = cameraOnBoard([10, 0], 90)!;
        expect(turned.x).toBeCloseTo(0, 9);
        expect(turned.y).toBeCloseTo(10, 9);
        expect(drawingBox(null, [], [])).toBeNull();
        expect(drawingBox(null, [part("R1", { x: 4, y: -2 }), part("R2", { x: -6, y: 8 })], [{ x: 20, y: 0 }], 1)).toEqual({ x0: -7, y0: -3, x1: 21, y1: 9 });
    });

    test("the drawing has a dot per part, picks one on a press, and a head that moves without a redraw", () => {
        let picked = "";
        const drawn = boardSvg({ job: null, parts: [part("R1", { x: 0, y: 0 }), part("C1", { x: 10, y: 5, side: "back" })], selected: "C1", camera: null }, (ref) => {
            picked = ref;
        })!;
        expect(drawn.root.querySelectorAll(".pnp-part").length).toBe(2);
        expect(drawn.root.querySelector(".pnp-part.selected")?.getAttribute("data-ref")).toBe("C1");
        expect(drawn.root.querySelector(".pnp-part.back")).not.toBeNull();
        (drawn.root.querySelector('[data-ref="R1"]') as SVGElement).dispatchEvent(new Event("click"));
        expect(picked).toBe("R1");
        placeHead(drawn.root, drawn.box, { x: 5, y: 2 });
        expect(drawn.root.querySelectorAll(".pnp-head").length).toBe(1);
        placeHead(drawn.root, drawn.box, { x: 500, y: 2 });
        expect(drawn.root.querySelectorAll(".pnp-head").length).toBe(0);
    });

    test("the routine and the part are said in words", () => {
        const base = { running: true, frame: null, part_offset: null } as unknown as PnpState;
        expect(pnpRoutineText(base)).toBe("");
        expect(pnpRoutineText({ ...base, routine: { kind: "nozzle", state: "running", step: "scale", done: 3, total: 5, error: null, spot: { dx: 1, dy: 1, mm: 0.25 } } })).toContain("scale (3 of 5), nozzle 0.250 mm off center");
        expect(pnpRoutineText({ ...base, routine: { kind: "part", state: "error", step: "looking", done: 3, total: 4, error: "no part in the picture", spot: null } })).toContain("no part in the picture");
        expect(partOffsetText(base)).toContain("No part");
        expect(partOffsetText({ ...base, part_offset: { dx: 0.1, dy: -0.05, mm: 0.112, length: 1.6, width: 0.8 } })).toContain("X 0.100 Y -0.050");
    });
});

describe("pnp in the mock", () => {
    test("the up camera's picture shows the nozzle where the head is against the camera", () => {
        const at = upPicturePoint([0.5, 0], UP_TRUTH);
        // Mirrored: a head move along +X shows as a spot moving left, give or take the roll.
        expect(at.px).toBeLessThan(0);
        expect(Math.hypot(at.px, at.py) * UP_TRUTH.mmPerPx).toBeCloseTo(0.5, 9);
    });

    test("centering the nozzle finds the camera, and a look at a part finds its offset", async () => {
        const { backend } = await xyMock();
        // The nozzle out of the picture, with no place to go to: refused.
        await expect(backend.pnpNozzle(1)).rejects.toMatchObject({ status: 400 });
        await backend.goto({ kind: "joint", r: UP_TRUTH.where[0] - 1, z: UP_TRUTH.where[1] + 0.5 });
        runUntilIdle(backend);
        await expect(backend.pnpPart()).rejects.toMatchObject({ status: 400 });
        const started = await backend.pnpNozzle(1);
        expect(started.routine?.state).toBe("running");
        // The routine has the camera: no other device, size or rate under it.
        await expect(backend.pnpSettings({ fps: 10 })).rejects.toMatchObject({ status: 409, message: "the up camera routine is under way: abort it first" });
        // Nothing else moves the head meanwhile.
        await expect(backend.goto({ kind: "joint", r: 0 })).rejects.toMatchObject({ status: 409 });
        const done = await runRoutine(backend);
        // At least a step's worth of mock time per step.
        expect(done.routine?.seconds ?? 0).toBeGreaterThanOrEqual(PNP_STEP_SECONDS * 5 - 1e-9);
        expect(done.routine?.state).toBe("done");
        expect(done.position).toEqual(UP_TRUTH.where);
        expect(done.mirror).toBe(true);
        expect(done.mm_per_px).toBe(UP_TRUTH.mmPerPx);
        await backend.pnpPart();
        const looked = await runRoutine(backend);
        expect(looked.part_offset).toMatchObject({ dx: UP_TRUTH.part[0], dy: UP_TRUTH.part[1] });
    });

    test("a board job's parts, and a goto over one, corrected by the part on the nozzle", async () => {
        const { backend, jobId } = await xyMock();
        const { components, note } = await backend.components(jobId);
        expect(note).toBeNull();
        expect(components.length).toBeGreaterThan(0);
        const first = components[0]!;
        await backend.pnpGoto({ job: jobId, ref: first.ref });
        runUntilIdle(backend);
        expect(backend.machine.status().board.x).toBeCloseTo(first.x, 3);
        expect(backend.machine.status().board.y).toBeCloseTo(first.y, 3);
        await expect(backend.pnpGoto({ job: jobId, ref: first.ref, correct: true })).rejects.toMatchObject({ status: 400 });
        await expect(backend.pnpGoto({ job: jobId, ref: "nope" })).rejects.toMatchObject({ status: 404 });
        await expect(backend.pnpSettings({ nozzle_spot: "grey" as never })).rejects.toMatchObject({ status: 400 });
        expect((await backend.pnpSettings({ position: [1, 2], height: 3 })).position).toEqual([1, 2]);
        expect((await backend.pnpSettings({ clear: ["position", "height"] })).position).toBeNull();
    });
});

describe("the pnp page", () => {
    test("lists the parts, picks one from the list or the drawing, counts edits, and steps through the setup", async () => {
        // This machine places the parts unless a G-code device was picked before.
        localStorage.removeItem("spinny.pnp.target");
        const { store, ctx, backend, calls } = setup();
        const roots = {
            steps: document.createElement("section"),
            parts: document.createElement("section"),
            board: document.createElement("section"),
            camera: document.createElement("section"),
            nozzle: document.createElement("section"),
        };
        for (const root of Object.values(roots)) {
            document.body.append(root);
        }
        await backend.connect("/dev/ttyACM0");
        await backend.applyMachine("cartesian-mill");
        const job = await backend.uploadJob(new File(["(kicad_pcb)"], "board.kicad_pcb"), {});
        store.set({ snapshot: connected({}, { profile: { kinematics: "cartesian", tool: "spindle", h_axis: true, r_max: 0, z_max: 0 } }) });
        mountPnp(roots, ctx);
        await ctx.refreshJobs();
        await ctx.refreshPnp();
        await ctx.selectJob(job.id);
        await settle();
        await settle();
        const rows = roots.parts.querySelectorAll("table.pnp-parts tbody tr");
        expect(rows.length).toBeGreaterThan(0);
        expect(roots.board.querySelectorAll(".pnp-part").length).toBe(rows.length);
        (rows[0] as HTMLElement).click();
        expect(roots.parts.querySelector("tr.selected")).not.toBeNull();
        expect(roots.board.querySelector(".pnp-part.selected")).not.toBeNull();
        // The setup: connected, X/Y, then the camera is next.
        const states = Array.from(roots.steps.querySelectorAll(".roadmap-step")).map((item) => item.getAttribute("data-step"));
        expect(states.slice(0, 3)).toEqual(["done", "done", "next"]);
        click(roots.camera, "Start");
        await settle();
        expect(store.get().pnp?.running).toBe(true);
        // A field typed in is counted for the page's tab until applied.
        const device = roots.camera.querySelector('input[aria-label="Up camera device"]') as HTMLInputElement;
        device.value = "/dev/video9";
        device.dispatchEvent(new Event("input"));
        expect(store.get().pending["pnp"]).toBe(1);
        click(roots.camera, "Apply");
        await settle();
        await settle();
        expect(store.get().pnp?.device).toBe("/dev/video9");
        expect(store.get().pending["pnp"]).toBeUndefined();
        // A job moved after its parts were read: they are read again where it lies now.
        const asked = calls.filter((call) => call.name === "components").length;
        const moved = store.get().job!;
        store.set({ job: { ...moved, offset: { x: moved.offset.x + 5, y: moved.offset.y } } });
        await settle();
        expect(calls.filter((call) => call.name === "components").length).toBe(asked + 1);
        // Go to part goes over the picked one.
        click(roots.parts, "Go to part");
        await settle();
        expect(backend.machine.queue.length + (backend.machine.state === "Jog" ? 1 : 0)).toBeGreaterThan(0);
    });

    test("the up camera is picked from the cameras found, started on what the fields show, and started again on another", async () => {
        localStorage.removeItem("spinny.pnp.target");
        const { store, ctx, calls } = setup();
        const roots = {
            steps: document.createElement("section"),
            parts: document.createElement("section"),
            board: document.createElement("section"),
            camera: document.createElement("section"),
            nozzle: document.createElement("section"),
        };
        mountPnp(roots, ctx);
        await ctx.refreshPnp();
        await ctx.refreshCamera();
        const list = roots.camera.querySelector('select[aria-label="Detected cameras"]') as HTMLSelectElement;
        expect(list.options[0]?.textContent).toBe("looking...");
        click(roots.camera, "Detect");
        await settle();
        await settle();
        // The up camera's /dev/video1 is a metadata node, no camera; the head camera's is said to be so.
        expect(roots.camera.querySelector(".camera-found")?.textContent).toBe("3 cameras found; the device set, /dev/video1, is not one of them.");
        expect(list.value).toBe("");
        expect(list.options[1]?.textContent).toContain("set as the head camera");
        list.value = MOCK_CAMERAS[1]!.device;
        list.dispatchEvent(new Event("change"));
        expect(store.get().pending["pnp"]).toBe(1);
        click(roots.camera, "Start");
        await settle();
        await settle();
        await settle();
        expect(calls.map((call) => call.name).filter((name) => name === "pnpSettings" || name === "pnpStart")).toEqual(["pnpSettings", "pnpStart"]);
        expect(store.get().pnp).toMatchObject({ running: true, device: MOCK_CAMERAS[1]!.device });
        expect(store.get().pending["pnp"]).toBeUndefined();
        // Another pick on a running camera: Apply starts it again there.
        list.value = MOCK_CAMERAS[2]!.device;
        list.dispatchEvent(new Event("change"));
        click(roots.camera, "Apply");
        await settle();
        await settle();
        expect(store.get().pnp).toMatchObject({ running: true, device: MOCK_CAMERAS[2]!.device });
    });
});
