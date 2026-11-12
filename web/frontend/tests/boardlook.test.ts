import { describe, expect, test } from "bun:test";

import { MockBackend } from "../src/mock/backend.ts";
import { estimateOf, jobSize, LOOK_NEED, searchStops } from "../src/mock/boardlook.ts";
import { TOP_TRUTH } from "../src/mock/pnp.ts";
import { turned } from "../src/kinematics.ts";
import { lookOnceText, uncrowded } from "../src/views/pnp.ts";
import { cameraBadge, lookText } from "../src/views/vision.ts";
import type { CameraState } from "../src/types.ts";

const TOP = '[top_camera]\nz = 0\noffset = [34.0, -9.0]\nfiducial = "bright"\nwithin = 2\n';

/** Steps the mock's clock until `done` says so, or a minute of mock time has gone by. */
async function until(backend: MockBackend, done: () => Promise<boolean>): Promise<void> {
    for (let t = 0; t < 60; t += 0.1) {
        if (await done()) {
            return;
        }
        backend.step(0.1);
    }
}

describe("the board look's words", () => {
    test("say how many looks agree, the board found, or why a pose was not used", () => {
        expect(lookText({ job: null })).toBe("");
        expect(lookText({ job: "a1", looks: 7, locked: 4, agree: 3, need: 5, found: false, pose: "locked", problem: "the head is moving", estimate: null }, "board"))
            .toBe("looking for board: 3 of 5 looks in a row agree, 4 of 7 locked, now locked (the head is moving)");
        expect(lookText({ job: "a1", agree: 5, need: 5, found: true, spread_mm: 0.1, spread_deg: 0.2, estimate: { rotation: 1, shift: [0, 0], center: [10, 20], rms: 0 } }, "board"))
            .toBe("board found: 5 looks in a row agree within 0.10 mm and 0.20 deg; middle at 10.00, 20.00, turned 1.00 deg");
        const base = { running: true, board: "a1", pose: { state: "lost" }, routine: null } as unknown as CameraState;
        expect(cameraBadge(base)).toBe("looking");
        expect(cameraBadge({ ...base, board_look: { job: "a1", found: true } })).toBe("found");
        expect(cameraBadge({ ...base, routine: { kind: "search", state: "running", step: "searching", done: 1, total: 4, error: null, spot: null } })).toBe("searching");
        expect(cameraBadge({ ...base, board: null })).toBe("running");
        expect(lookOnceText(null)).toBe("");
        expect(lookOnceText({ found: false, polarity: "dark" })).toContain("no dark spot found");
        expect(lookOnceText({ found: true, polarity: "bright", dx: 1.25, dy: -3, major: 20, minor: 18 })).toBe("look once: a bright spot 1.3, -3.0 px from the center, 20.0 by 18.0 px");
    });

    test("labels that would overlap are dropped, the first ones kept", () => {
        expect(uncrowded([
            { x: 0, y: 0, width: 20, height: 10 },
            { x: 10, y: 5, width: 20, height: 10 },
            { x: 40, y: 0, width: 20, height: 10 },
            { x: 0, y: 30, width: 20, height: 10 },
        ])).toEqual([true, false, true, true]);
    });

    test("the mock's search stops follow the backend's: a picture apart less the overlap, nearest first", () => {
        const stops = searchStops([0, 0, 30, 20], [10, 8], { x: 0, y: 0 });
        expect(stops.length).toBe(20);
        expect(Math.hypot(stops[0]!.x, stops[0]!.y)).toBeLessThan(Math.hypot(stops[19]!.x, stops[19]!.y));
        expect(() => searchStops([0, 0, 1000, 1000], [5, 5], { x: 0, y: 0 })).toThrow("smaller box");
    });
});

describe("looking for a board in the mock", () => {
    test("the top camera searches a box, finds the board, and keeps its place as references", async () => {
        const backend = new MockBackend({ timers: false });
        const job = await backend.uploadJob(new File(["(kicad_pcb)"], "board.kicad_pcb"), {});
        const file = await backend.machineFile("openpnp-marlin");
        await backend.saveMachineFile("openpnp-marlin", `${file.text}\n${TOP}`);
        await backend.connect("/dev/ttyACM1", "openpnp-marlin");
        await backend.topStart();
        await expect(backend.topSearch(null)).rejects.toMatchObject({ status: 400, message: "no board loaded: press Look for board first" });
        const loaded = await backend.topBoard(job.id);
        expect(loaded.top?.board_look).toMatchObject({ job: job.id, looks: 0, found: false });
        await expect(backend.topSearch(null)).rejects.toMatchObject({ status: 400 });
        await backend.topSettings({ offset: [...TOP_TRUTH.offset], mm_per_px: TOP_TRUTH.mmPerPx, roll: TOP_TRUTH.roll });
        // The board lies at the mock's own place with no references.
        const stored = (await backend.job(job.id));
        const { middle } = jobSize(stored);
        const truth = estimateOf((point) => {
            const t = turned(point, 0.8);
            return { x: t.x + 100, y: t.y + 60 };
        }, middle);
        const [mx, my] = truth.center;
        await backend.topSearch([mx - 40, my - 40, mx + 40, my + 40]);
        await until(backend, async () => (await backend.placingState()).top?.routine?.state !== "running");
        const top = (await backend.placingState()).top!;
        expect(top.routine).toMatchObject({ kind: "search", state: "done" });
        expect(top.board_look?.found).toBe(true);
        expect(top.board_look?.agree).toBeGreaterThanOrEqual(LOOK_NEED);
        expect(top.board_look?.estimate?.center[0]).toBeCloseTo(mx, 3);
        expect(top.board_look?.estimate?.rotation).toBeCloseTo(0.8, 3);
        // Kept as two references by look.
        const placed = await backend.topPlace(job.id);
        const refs = placed.references.filter((entry) => entry.job === job.id);
        expect(refs.map((entry) => entry.by)).toEqual(["look", "look"]);
        // A box away from the board: covered, not found.
        await backend.topSearch([mx + 300, my + 300, mx + 340, my + 340]);
        await until(backend, async () => (await backend.placingState()).top?.routine?.state !== "running");
        const missed = (await backend.placingState()).top!.routine!;
        expect(missed.state).toBe("error");
        expect(missed.error).toContain("no board found");
        // A look once finds the mark spot and keeps its shape.
        const looked = (await backend.topLook()).top!.look!;
        expect(looked).toMatchObject({ found: true, polarity: "dark", dx: 75, dy: -50, major: 100 });
    });

    test("the head camera's look counts its poses, and its search ends", async () => {
        const backend = new MockBackend({ timers: false });
        await backend.connect("/dev/ttyACM0");
        await backend.applyMachine("cartesian-mill");
        const job = await backend.uploadJob(new File(["(kicad_pcb)"], "board.kicad_pcb"), {});
        await backend.cameraStart();
        await backend.cameraSettings({ mm_per_px: 0.02 });
        await expect(backend.cameraSearch(null)).rejects.toMatchObject({ status: 400 });
        await backend.cameraBoard(job.id);
        await until(backend, async () => ((await backend.camera()).board_look?.looks ?? 0) >= 3);
        expect((await backend.camera()).board_look?.looks).toBeGreaterThanOrEqual(3);
        await backend.cameraSearch(null);
        expect((await backend.camera()).routine).toMatchObject({ kind: "search", state: "running" });
        // Nothing else may move the head while it searches.
        await expect(backend.jog({ kind: "joint", dr: 1 })).rejects.toMatchObject({ status: 409 });
        await until(backend, async () => (await backend.camera()).routine?.state !== "running");
        const state = await backend.camera();
        expect(["done", "error"]).toContain(state.routine!.state);
        if (state.routine!.state === "done") {
            expect(state.board_look?.found).toBe(true);
        }
        await backend.cameraBoard(null);
        expect((await backend.camera()).board_look).toEqual({ job: null });
    });

    test("a camera's controls are listed, set and kept; a bridge Pi's camera has none here", async () => {
        const backend = new MockBackend({ timers: false });
        const listed = await backend.cameraControls("head");
        expect(listed.local).toBe(true);
        expect(listed.controls.find((control) => control.name === "auto_exposure")?.items?.length).toBe(2);
        const set = await backend.setCameraControls("head", { brightness: 140, gain_bogus: 3 });
        expect(set.kept).toEqual({ brightness: 140, gain_bogus: 3 });
        expect(set.refused).toEqual(["gain_bogus: v4l2-ctl: unknown control 'gain_bogus'"]);
        expect(set.controls.find((control) => control.name === "brightness")).toMatchObject({ value: 140, kept: 140 });
        expect((await backend.camera()).controls).toEqual({ brightness: 140, gain_bogus: 3 });
        expect((await backend.setCameraControls("head", { gain_bogus: null })).kept).toEqual({ brightness: 140 });
        await expect(backend.setCameraControls("head", { "Bad Name": 1 })).rejects.toMatchObject({ status: 400 });
        await backend.pnpSettings({ device: "http://127.0.0.1:2325/snapshot" });
        const far = await backend.cameraControls("up");
        expect(far.local).toBe(false);
        expect(far.controls).toEqual([]);
        expect(far.note).toContain("HTTP");
    });
});
