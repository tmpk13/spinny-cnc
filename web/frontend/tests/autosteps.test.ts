// Auto: what it does next from the state alone, and a whole run of it over
// the mock's pick and place machine, from a machine not homed to a board
// found by the camera and ready to place.

import { afterEach, describe, expect, test } from "bun:test";
import { initialState, type AppState } from "../src/state.ts";
import type { BoardEstimate, BoardLook, Component, Job, PlacingState, PnpReference, Port, TopState } from "../src/types.ts";
import { AGREE_MM, autoMemory, autoMove, autoRunner, placeOf, referencesOff, type AutoLine, type AutoMemory } from "../src/views/autosteps.ts";
import { connected, setup, settle } from "./harness.ts";

const job = { id: "b1", name: "board", offset: { x: 3, y: 4 }, rotation: 0, design: { board: true }, groups: [], outline: [], stats: { length_mm: 10, seconds: 5 } } as unknown as Job;
const part = (ref: string, x: number, y: number, fiducial = false): Component => ({ ref, x, y, fiducial } as unknown as Component);
const parts = [part("R1", 0, 0), part("R2", 30, 0), part("FID1", -2, -2, true), part("FID2", 32, 12, true)];
const estimate: BoardEstimate = { rotation: 0, shift: [100, 60], center: [115, 66], rms: 0.02 };

function top(patch: Partial<TopState> = {}): TopState {
    return { device: "/dev/video4", running: true, routine: null, offset: null, mm_per_px: 0.016, roll: 0, mirror: false, ...patch } as unknown as TopState;
}

function placing(patch: Partial<PlacingState> = {}): PlacingState {
    return { machine: "lumen", name: "Lumen", document: null, angle: null, references: [], taken: {}, connected: true, homed: true, running: false, top: top(), ...patch } as unknown as PlacingState;
}

/** A state with a G-code machine connected, a board picked and its parts read. */
function placingState(patch: Partial<PlacingState> = {}, more: Partial<AppState> = {}): AppState {
    return { ...initialState(true), placing: placing(patch), job, components: { job: job.id, components: parts } as AppState["components"], ...more };
}

const found = (patch: Partial<BoardLook> = {}): BoardLook => ({ job: job.id, found: true, estimate, ...patch });
const tried = (...keys: string[]): AutoMemory => ({ tried: new Set(keys), failed: new Map() });

afterEach(() => {
    document.body.replaceChildren();
});

describe("what Auto does next", () => {
    test("nothing connected: the port found is connected once, and no port is the operator's", () => {
        const state = initialState(true);
        expect(autoMove(state, autoMemory())).toMatchObject({ kind: "need", step: "connect" });
        const port = { url: "/dev/ttyACM0", device: "/dev/ttyACM0", kind: "usb", spinny: true, product: "spinny laser controller" } as unknown as Port;
        const offered = { ...state, ports: [port] };
        expect(autoMove(offered, autoMemory())).toMatchObject({ kind: "act", step: "connect", key: "connect" });
        // Tried and still not connected: said, not tried again.
        const memory = tried("connect");
        memory.failed.set("connect", "it did not answer");
        const stop = autoMove(offered, memory);
        expect(stop.kind).toBe("need");
        expect(stop.say).toContain("did not connect: it did not answer");
    });

    test("a pick and place machine: home, then a board to pick, then the board by the camera", () => {
        expect(autoMove(placingState({ homed: false }), autoMemory())).toMatchObject({ kind: "act", step: "home", key: "home", say: "Homing" });
        expect(autoMove(placingState({}, { job: null }), autoMemory())).toMatchObject({ kind: "need", step: "parts" });
        // The camera stopped: started. Running with no board loaded: loaded. Then the search.
        expect(autoMove(placingState({ top: top({ running: false }) }), autoMemory())).toMatchObject({ kind: "act", key: "top-start" });
        expect(autoMove(placingState(), autoMemory())).toMatchObject({ kind: "act", key: "top-board" });
        expect(autoMove(placingState({ top: top({ board_look: { job: job.id } }) }), autoMemory())).toMatchObject({ kind: "act", key: "top-search", say: "Searching for the board" });
        // A routine under way is waited for, in its own words.
        const searching = top({ routine: { kind: "search", state: "running", step: "stop 3", done: 3, total: 9, error: null, spot: null } as TopState["routine"] });
        expect(autoMove(placingState({ top: searching }), tried("top-search"))).toMatchObject({ kind: "wait", step: "board", say: "Looking for the board: stop 3 (3 of 9)" });
    });

    test("with nothing known and a bed in the machine's file the search is a scan of the bed", () => {
        const document = { top: { offset: [23, 65], bed: [24, 66, 456, 552], fiducial: "bright", within: 2, z: null } } as unknown as PlacingState["document"];
        const state = placingState({ document, top: top({ board_look: { job: job.id } }) });
        expect(autoMove(state, autoMemory())).toMatchObject({ kind: "act", key: "top-search", say: "Scanning the bed for the board" });
    });

    test("the board found: its place taken, then its fiducials, then the placing is the operator's", () => {
        const seen = top({ board_look: found() });
        expect(autoMove(placingState({ top: seen }), tried("top-search"))).toMatchObject({ kind: "act", key: "top-place" });
        const references: PnpReference[] = [{ job: job.id, ref: "FID1", at: [98, 58], by: "look" }, { job: job.id, ref: "FID2", at: [132, 72], by: "look" }];
        expect(autoMove(placingState({ top: seen, references }), tried("top-search", "top-place"))).toMatchObject({ kind: "act", key: "fiducials" });
        const done = autoMove(placingState({ top: seen, references }), tried("top-search", "top-place", "fiducials"));
        expect(done).toMatchObject({ kind: "end", step: "run" });
        expect(done.say).toBe("The board was found by the camera, its fiducials centered. Ready to place: Plan, check it, then Run.");
        // Fiducials that were not found are said; the camera's place stands.
        const memory = tried("top-search", "top-place", "fiducials");
        memory.failed.set("fiducials", "fiducial FID2 is not within 2 mm");
        expect(autoMove(placingState({ top: seen, references }), memory).say).toContain("its fiducials were not (fiducial FID2 is not within 2 mm)");
        // With no scale measured the fiducials wait: nothing is sent.
        const unscaled = top({ board_look: found(), mm_per_px: 0 });
        expect(autoMove(placingState({ top: unscaled, references }), tried("top-search", "top-place")).say).toContain("its fiducials wait for the top camera's scale");
    });

    test("references kept from before: the camera still looks, and never replaces them by itself", () => {
        const kept: PnpReference[] = [{ job: job.id, ref: "R1", at: [100, 60], by: "nozzle" }, { job: job.id, ref: "R2", at: [130, 60], by: "nozzle" }];
        // It looks first, though the step is ticked.
        expect(autoMove(placingState({ references: kept }), autoMemory())).toMatchObject({ kind: "act", key: "top-board" });
        // Seen where they put it: on to the placing.
        const agrees = autoMove(placingState({ references: kept, top: top({ board_look: found() }) }), tried("top-search"));
        expect(agrees).toMatchObject({ kind: "end", step: "run" });
        expect(agrees.say).toContain("The camera sees the board where its 2 references put it.");
        // Seen elsewhere: the operator decides.
        const moved = found({ estimate: { ...estimate, shift: [112, 60] } });
        const differs = autoMove(placingState({ references: kept, top: top({ board_look: moved }) }), tried("top-search"));
        expect(differs).toMatchObject({ kind: "need", step: "board" });
        expect(differs.say).toContain("12.0 mm from where its 2 references put it");
        // Not found: they are kept, and said so.
        const lost = autoMove(placingState({ references: kept, top: top({ board_look: { job: job.id, found: false } }) }), tried("top-search"));
        expect(lost).toMatchObject({ kind: "end" });
        expect(lost.say).toContain("The camera did not find the board: its 2 references are kept.");
    });

    test("a board found before Auto began is looked for again before its place is trusted", () => {
        // The look's place may be the board placed before this one: a run of
        // Auto searches once before it compares or takes it.
        const kept: PnpReference[] = [{ job: job.id, ref: "R1", at: [100, 60], by: "nozzle" }, { job: job.id, ref: "R2", at: [130, 60], by: "nozzle" }];
        expect(autoMove(placingState({ references: kept, top: top({ board_look: found() }) }), autoMemory())).toMatchObject({ kind: "act", key: "top-search" });
        expect(autoMove(placingState({ top: top({ board_look: found() }) }), autoMemory())).toMatchObject({ kind: "act", key: "top-search" });
        // Searched in this run: the place found is the board's now.
        expect(autoMove(placingState({ references: kept, top: top({ board_look: found() }) }), tried("top-search"))).toMatchObject({ kind: "end", step: "run" });
        expect(autoMove(placingState({ top: top({ board_look: found() }) }), tried("top-search"))).toMatchObject({ kind: "act", key: "top-place" });
    });

    test("no board found and no reference: the operator takes a corner or a reference", () => {
        const lost = autoMove(placingState({ top: top({ board_look: { job: job.id, found: false } }) }), tried("top-search"));
        expect(lost).toMatchObject({ kind: "need", step: "board" });
        expect(lost.say).toContain("Corner here");
        // No camera to look with: by hand from the start.
        expect(autoMove(placingState({ top: top({ device: "" }) }), autoMemory())).toMatchObject({ kind: "need", step: "board" });
    });

    test("Auto never acts during a run, and never starts one", () => {
        expect(autoMove(placingState({ running: true }), autoMemory())).toMatchObject({ kind: "end", step: "run" });
        const running = { ...initialState(true), snapshot: connected(), job, progress: { job: job.id, state: "running", sent: 1, acked: 1, total: 9 } as AppState["progress"] };
        expect(autoMove(running, autoMemory())).toMatchObject({ kind: "end", step: "run" });
    });

    test("a laser or a mill: connect, a job, the board by the head camera when it is measured; the heights stay the operator's", () => {
        const state = { ...initialState(true), snapshot: connected() };
        expect(autoMove(state, autoMemory())).toMatchObject({ kind: "need", step: "job" });
        // No camera set up: the job stays where it was put by hand.
        const plain = autoMove({ ...state, job }, autoMemory());
        expect(plain).toMatchObject({ kind: "end", step: "run" });
        expect(plain.say).toContain("placed by hand (no head camera is set up)");
        expect(plain.say).toContain("Heights are yours to set");
        // A camera measured: started, the board loaded, searched for.
        const camera = { device: "/dev/video0", running: false, mm_per_px: 0.02, routine: null } as unknown as NonNullable<AppState["camera"]>;
        expect(autoMove({ ...state, job, camera }, autoMemory())).toMatchObject({ kind: "act", key: "head-start" });
        expect(autoMove({ ...state, job, camera: { ...camera, running: true } }, autoMemory())).toMatchObject({ kind: "act", key: "head-board" });
        expect(autoMove({ ...state, job, camera: { ...camera, running: true, board_look: { job: job.id } } }, autoMemory())).toMatchObject({ kind: "act", key: "head-search" });
        // Found: kept as marks; moving the job onto them is a press of the operator's.
        const seen = { ...camera, running: true, board_look: found() };
        expect(autoMove({ ...state, job, camera: seen }, tried("head-search"))).toMatchObject({ kind: "act", key: "align-capture" });
        const align = { job: job.id, marks: [{}, {}], fit: null } as unknown as AppState["align"];
        const stop = autoMove({ ...state, job, camera: seen, align }, tried("head-search", "align-capture"));
        expect(stop).toMatchObject({ kind: "need", step: "board" });
        expect(stop.say).toContain("Apply (By marks)");
        // Not measured: the camera's place would be off by where it sits from the tool.
        expect(autoMove({ ...state, job, camera: { ...camera, mm_per_px: 0 } }, autoMemory()).say).toContain("the head camera is not measured: Find mark");
    });
});

describe("a look's place against the references", () => {
    test("a point is turned, then shifted", () => {
        const at = placeOf({ rotation: 90, shift: [10, 20], center: [0, 0], rms: 0 }, [5, 0]);
        expect(at[0]).toBeCloseTo(10, 9);
        expect(at[1]).toBeCloseTo(25, 9);
    });

    test("the furthest reference tells; a corner goes by its own point, a part not on the board by nothing", () => {
        const references: PnpReference[] = [
            { job: job.id, ref: "R1", at: [100, 60], by: "nozzle" },
            { job: job.id, ref: "R2", at: [130, 60.5], by: "camera" },
            { job: job.id, ref: "corner bottom left", at: [97, 57], by: "corner", point: [-3, -3] },
            { job: job.id, ref: "gone", at: [0, 0], by: "nozzle" },
        ];
        expect(referencesOff(estimate, references, parts)).toBeCloseTo(0.5, 9);
        expect(referencesOff(estimate, [references[3]!], parts)).toBeNull();
        expect(AGREE_MM).toBeGreaterThan(0.5);
    });
});

/** The LumenPnP connected in the mock, its file naming where boards lie: the whole bed is more stops than a search takes for a board this small. */
async function lumen(backend: ReturnType<typeof setup>["backend"]): Promise<AppState["snapshot"]> {
    const file = await backend.machineFile("opulo-lumen-rev5");
    await backend.saveMachineFile("opulo-lumen-rev5", file.text.replace("# board_area = [60.0, 100.0, 260.0, 260.0]", "board_area = [60.0, 70.0, 200.0, 150.0]"));
    return backend.connect("/dev/ttyACM1", "opulo-lumen-rev5");
}

describe("a run of Auto over the mock's pick and place machine", () => {
    test("homes, starts the camera, scans the bed, takes the place found, finds the fiducials and stops before the placing", async () => {
        const { store, ctx, api, backend, calls } = setup();
        store.set({ snapshot: await lumen(backend) });
        await ctx.refreshPlacing();
        expect(store.get().placing?.document?.top?.board_area).toEqual([60, 70, 200, 150]);
        const board = await backend.uploadJob(new File(["(kicad_pcb)"], "board.kicad_pcb"), {});
        await ctx.refreshJobs();
        await ctx.selectJob(board.id);
        store.set({ components: await api.components(board.id) });
        expect(store.get().placing?.homed).toBe(false);
        expect(store.get().placing?.references).toEqual([]);

        const lines: AutoLine[] = [];
        // The mock's clock runs with Auto's waits, and the page reads the state as its pushes would bring it.
        const runner = autoRunner({
            ctx,
            startCamera: () => void api.topStart().then((state) => store.set({ placing: state })),
            sleep: async (ms) => {
                backend.step(Math.max(ms / 1000, 0.4) * 4);
                await ctx.refreshPlacing();
            },
        }, (line) => {
            if (line !== null) {
                lines.push(line);
            }
        });
        runner.start();
        expect(runner.running()).toBe(true);
        for (let turns = 0; turns < 4000 && runner.running(); turns++) {
            await settle();
        }
        expect(runner.running()).toBe(false);
        const last = lines.at(-1)!;
        expect(last.kind).toBe("end");
        expect(last.step).toBe("run");
        expect(last.text).toBe("The board was found by the camera, its fiducials centered. Ready to place: Plan, check it, then Run.");
        // Each request once, in the order of the steps; nothing started a run.
        const sent = calls.map((call) => call.name).filter((name) => ["home", "topStart", "topBoard", "topSearch", "topPlace", "pnpFiducials", "pnpRun"].includes(name));
        expect(sent).toEqual(["home", "topStart", "topBoard", "topSearch", "topPlace", "pnpFiducials"]);
        expect(calls.find((call) => call.name === "topSearch")?.args[0]).toBeNull();
        expect(lines.some((line) => line.text === "Scanning the bed for the board")).toBe(true);
        const placing = store.get().placing!;
        expect(placing.homed).toBe(true);
        expect(placing.references.filter((entry) => entry.job === board.id).map((entry) => entry.by)).toEqual(["fiducial", "fiducial"]);
        // Pressed again: the place found before may be the board placed
        // before, so the camera looks again; the references are kept, and
        // nothing starts a run.
        lines.length = 0;
        runner.start();
        for (let turns = 0; turns < 4000 && runner.running(); turns++) {
            await settle();
        }
        expect(lines[0]?.text).toBe("Searching for the board");
        expect(lines.at(-1)).toMatchObject({ kind: "end", step: "run" });
        expect(lines.at(-1)?.text).toContain("its 2 references");
        expect(calls.map((call) => call.name).filter((name) => ["topSearch", "topPlace", "pnpRun"].includes(name))).toEqual(["topSearch", "topPlace", "topSearch"]);
        expect(store.get().placing!.references.filter((entry) => entry.job === board.id).map((entry) => entry.by)).toEqual(["fiducial", "fiducial"]);
    });

    test("Stop Auto ends the run and the search it began", async () => {
        const { store, ctx, api, backend, calls } = setup();
        store.set({ snapshot: await lumen(backend) });
        await api.home();
        await api.topStart();
        await ctx.refreshPlacing();
        const board = await backend.uploadJob(new File(["(kicad_pcb)"], "board.kicad_pcb"), {});
        await ctx.refreshJobs();
        await ctx.selectJob(board.id);
        store.set({ components: await api.components(board.id) });
        const lines: AutoLine[] = [];
        // The mock's clock stands still: the search stays under way.
        const runner = autoRunner({ ctx, startCamera: () => undefined, sleep: () => settle() }, (line) => void (line && lines.push(line)));
        runner.start();
        for (let turns = 0; turns < 200 && store.get().placing?.top?.routine?.state !== "running"; turns++) {
            await settle();
        }
        expect(store.get().placing?.top?.routine?.kind).toBe("search");
        runner.stop();
        await settle();
        await settle();
        expect(runner.running()).toBe(false);
        expect(calls.some((call) => call.name === "topAbort")).toBe(true);
        expect(lines.at(-1)?.text.startsWith("Stopped: ")).toBe(true);
        expect(lines.at(-1)?.running).toBe(false);
    });
});
