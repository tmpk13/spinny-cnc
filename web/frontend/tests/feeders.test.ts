// The feeders plan's page side (docs/FEEDERS.md): the feeder check and the
// Feeders step, the panel's parts with no feeder, and the mock's twins of
// the routes.

import { afterEach, describe, expect, test } from "bun:test";

import type { MockBackend } from "../src/mock/backend.ts";
import { feederCheck, partFeeders, planDevice } from "../src/mock/openpnp.ts";
import { initialState, type AppState } from "../src/state.ts";
import type { Component, FeederCheck, FeederCheckFeeder, Job, PlacingState } from "../src/types.ts";
import { placingSteps, stepToOpen } from "../src/views/areaviews.ts";
import { autoMemory, autoMove } from "../src/views/autosteps.ts";
import { checkLine, feedersDone, feedersLine, refreshFeederCheck, refsText } from "../src/views/feedercheck.ts";
import { setPickedToPlace } from "../src/views/partsfilter.ts";
import { feederPlaceText, feederTakenText, looseGroups, mountPnpFeeders } from "../src/views/pnpfeeders.ts";
import { connectGcode, parseDevice } from "./gcoderig.ts";
import { findButton, settle, setup } from "./harness.ts";

const TP_A = "0102030405060708090A0B0C";

// A G-code machine with a feeder bus: one feeder on it found by its id
// (no slot in the file), one strip; the mock's boards hold test points
// TP1 to TP3, which they hold by reference.
const PROFILE = `name = "lumen"
[port]
url = "socket://127.0.0.1:9"
wait_ms = 0
timeout = 2
[gcode]
init = ["G21", "G90"]
[motion]
feed_xy = 3000
feed_z = 600
safe_z = 31.5
place_z = 12
pick_dwell_ms = 0
place_dwell_ms = 0
[bus]
send = "M485 {packet}"
reply = "rs485-reply: (?<packet>[0-9A-Fa-f]*)"
poll_ms = 10
[[slot]]
address = 3
at = [100.0, 400.0, 10.0]
[[feeder]]
id = "tp-a"
refs = ["TP1"]
bus_id = "${TP_A}"
[[feeder]]
id = "tp-b"
refs = ["TP2"]
at = [10.0, 10.0, 5.0]
pitch = [4.0, 0.0]
count = 1
`;

function part(ref: string, value: string, more: Partial<Component> = {}): Component {
    return { ref, value, footprint: "Resistor_SMD:R_0603_1608Metric", side: "front", x: 0, y: 0, rotation: 0, pads: 2, smd: true, dnp: false, ...more };
}

function wants(id: string, more: Partial<FeederCheckFeeder> = {}): FeederCheckFeeder {
    return { id, refs: [], needs: 1, left: null, place_known: true, bus_id: null, address: null, seen: false, ...more };
}

/** A check of `fed` parts from `feeders`, and of parts with no feeder. */
function checkOf(fed: number, feeders: FeederCheckFeeder[], loose: string[] = [], ready = false): FeederCheck {
    return {
        parts: [
            ...Array.from({ length: fed }, (_, index) => ({ ref: `C${index + 1}`, value: "100n", footprint: "C_0402", feeder: feeders[0]?.id ?? "f", reason: null })),
            ...loose.map((ref) => ({ ref, value: "4k7", footprint: "R_0603", feeder: null, reason: "no feeder holds it" })),
        ],
        feeders,
        problems: [],
        ready,
    };
}

const job = { id: "b1", name: "board", offset: { x: 0, y: 0 }, rotation: 0, design: { board: true }, groups: [], outline: [], stats: { length_mm: 1, seconds: 1 } } as unknown as Job;

/** A state placing with a G-code machine, a board picked and its parts read, and a check kept for it. */
function placingState(check: FeederCheck | null, more: Partial<AppState> = {}): AppState {
    const placing = { machine: "lumen", name: "Lumen", document: null, angle: null, references: [], taken: {}, connected: true, homed: true, running: false } as unknown as PlacingState;
    return {
        ...initialState(true),
        placing,
        job,
        components: { job: job.id, components: [part("R1", "10k")], note: null },
        feederCheck: check === null ? null : { key: "k", job: job.id, check, error: null },
        ...more,
    };
}

/** The mock's board uploaded and picked, its parts read into the store. */
async function pickBoard(ctx: ReturnType<typeof setup>["ctx"], backend: MockBackend): Promise<Job> {
    const board = await backend.uploadJob(new File(["(kicad_pcb)"], "board.kicad_pcb"), {});
    await ctx.refreshJobs();
    await ctx.selectJob(board.id);
    ctx.store.set({ components: await backend.components(board.id) });
    return board;
}

/** The mock's placing state, to set its counts as a run would. */
function taken(backend: MockBackend): Record<string, number> {
    return (backend as unknown as { placing(): { taken: Record<string, number> } }).placing().taken;
}

afterEach(() => {
    document.body.replaceChildren();
    localStorage.removeItem("spinny.pnp.place.b1");
});

describe("the feeder check in words", () => {
    test("parts by reference, the last few counted", () => {
        expect(refsText([])).toBe("");
        expect(refsText(["R3"])).toBe("R3");
        expect(refsText(["R3", "R4"])).toBe("R3 and R4");
        expect(refsText(["R3", "R4", "R5"])).toBe("R3, R4 and R5");
        expect(refsText(["R3", "R4", "R5", "R6", "R7"])).toBe("R3, R4 and 3 more");
    });

    test("the line counts the parts and feeders, then says what is wanting", () => {
        const six = [wants("c-100n", { needs: 5, left: 3 }), ...["a", "b", "c", "d", "e"].map((id) => wants(id))];
        expect(checkLine(checkOf(14, six, ["R3", "R4"]))).toBe("14 parts from 6 feeders; R3 and R4 have no feeder; c-100n has 3 left of 5.");
        expect(checkLine(checkOf(3, [wants("a"), wants("b")], [], true))).toBe("3 parts from 2 feeders: every place known, none short.");
        expect(checkLine(checkOf(1, [wants("c-1u", { place_known: false })]))).toBe("1 part from 1 feeder; c-1u's place is not known.");
        expect(checkLine(checkOf(2, [wants("c-100n", { needs: 2, left: 0 })]))).toBe("2 parts from 1 feeder; c-100n has none left of 2.");
        expect(checkLine(checkOf(0, [], ["R3"]))).toBe("R3 has no feeder.");
        expect(checkLine(checkOf(0, []))).toBe("The board has no part to place.");
        // Past a few wants the rest are counted.
        const many = ["a", "b", "c", "d"].map((id) => wants(id, { place_known: false }));
        expect(checkLine(checkOf(4, many))).toBe("4 parts from 4 feeders; a's place is not known; b's place is not known; 2 more wants of the feeders.");
    });

    test("where a feeder is and what it has given, with what the check found", () => {
        const bus = { id: "c-1u", match: "1u", at: null, pitch: [0, 0], count: 0, columns: 0, rotation: 0, vision: false, size: null, pocket: null, marks: [], mark: "dark", bus_id: TP_A, slot: null } as unknown as Parameters<typeof feederPlaceText>[0];
        expect(feederPlaceText(bus)).toBe("slot found on the bus when a run starts");
        expect(feederPlaceText(bus, wants("c-1u", { place_known: false }))).toBe("not found on the bus yet: scan it");
        expect(feederPlaceText(bus, wants("c-1u", { seen: true, address: 4 }))).toBe("found at address 4");
        expect(feederPlaceText(bus, wants("c-1u", { seen: true, address: 7, place_known: false }))).toBe("found at address 7, which has no slot place");
        const strip = { ...bus, at: [1, 2, 3], bus_id: null, count: 5 } as typeof bus;
        expect(feederTakenText(strip, 2)).toBe("2 of 5");
        expect(feederTakenText(strip, 2, wants("s", { needs: 4, left: 3 }))).toBe("2 of 5, 4 needed");
        expect(looseGroups(checkOf(1, [wants("a")], ["R3", "R4"]))).toEqual([{ value: "4k7", footprint: "R_0603", refs: ["R3", "R4"] }]);
    });
});

describe("the Feeders step", () => {
    test("done when the check says every part would be placed; its line says what it found", () => {
        const ready = placingState(checkOf(3, [wants("a")], [], true));
        const feeders = placingSteps(ready).find((step) => step.id === "feeders")!;
        expect(feeders.step).toEqual({ done: true, optional: false });
        expect(feeders.line).toBe("3 parts from 1 feeder: every place known, none short.");
        const wanting = placingState(checkOf(2, [wants("a")], ["R3"]));
        expect(feedersDone(wanting)).toBe(false);
        expect(feedersLine(wanting)).toBe("2 parts from 1 feeder; R3 has no feeder.");
    });

    test("with no board, before the answer, after a failure, and for another job", () => {
        expect(feedersLine(placingState(null, { job: null }))).toBe("No board picked yet: its parts say which feeders a run needs.");
        expect(feedersLine(placingState(null))).toBe("Checking the feeders against the board's parts.");
        const failed = placingState(null, { feederCheck: { key: "k", job: job.id, check: null, error: "no such job" } });
        expect(feedersLine(failed)).toBe("The feeders could not be checked: no such job.");
        expect(feedersDone(failed)).toBe(false);
        const other = placingState(null, { feederCheck: { key: "k", job: "b2", check: checkOf(1, [wants("a")], [], true), error: null } });
        expect(feedersDone(other)).toBe(false);
        expect(feedersLine(other)).toBe("Checking the feeders against the board's parts.");
    });

    test("a run needs it: the area opens at Feeders until the check is ready", () => {
        const references = [{ job: job.id, ref: "R1", at: [1, 2] as [number, number] }];
        const wanting = placingState(checkOf(1, [wants("a")], ["R3"]));
        wanting.placing = { ...wanting.placing!, references };
        expect(stepToOpen(placingSteps(wanting))).toBe("feeders");
        const ready = placingState(checkOf(1, [wants("a")], [], true));
        ready.placing = { ...ready.placing!, references };
        expect(stepToOpen(placingSteps(ready))).toBe("run");
    });

    test("Auto stops at the Feeders step when the check finds them wanting, and says why", () => {
        const references = [{ job: job.id, ref: "R1", at: [1, 2] as [number, number], by: "nozzle" as const }];
        const state = placingState(checkOf(1, [wants("a")], ["R3"]));
        state.placing = { ...state.placing!, references, top: undefined };
        const move = autoMove(state, autoMemory());
        expect(move).toMatchObject({ kind: "need", step: "feeders" });
        expect(move.say).toEndWith("1 part from 1 feeder; R3 has no feeder.");
        // With no check back yet, as before: the placing is the operator's.
        expect(autoMove({ ...state, feederCheck: null }, autoMemory())).toMatchObject({ kind: "end", step: "run" });
    });
});

describe("the mock's feeder check", () => {
    test("a part no feeder holds, a feeder not found yet, then found on the bus by a scan", async () => {
        const { backend } = setup();
        await connectGcode(backend, "lumen", PROFILE);
        const board = await backend.uploadJob(new File(["(kicad_pcb)"], "board.kicad_pcb"), {});
        const before = await backend.pnpFeederCheck(board.id);
        // The fiducials and the mounting hole kept out of the position files are the job's, not listed.
        expect(before.parts.map((entry) => [entry.ref, entry.feeder, entry.reason])).toEqual([["TP1", "tp-a", null], ["TP2", "tp-b", null], ["TP3", null, "no feeder holds it"]]);
        expect(before.feeders).toEqual([
            { id: "tp-a", refs: ["TP1"], needs: 1, left: null, place_known: false, bus_id: TP_A, address: null, seen: false },
            { id: "tp-b", refs: ["TP2"], needs: 1, left: 1, place_known: true, bus_id: null, address: null, seen: false },
        ]);
        expect(before.problems).toEqual(["TP3: no feeder holds it", "feeder tp-a's place is not known: scan the feeder bus for it"]);
        expect(before.ready).toBe(false);
        // The scan finds tp-a in slot 3, whose place the file has.
        await backend.pnpBusScan();
        const after = await backend.pnpFeederCheck(board.id, ["TP1", "TP2"]);
        expect(after.parts.map((entry) => entry.ref)).toEqual(["TP1", "TP2"]);
        expect(after.feeders[0]).toMatchObject({ id: "tp-a", place_known: true, address: 3, seen: true });
        expect(after.ready).toBe(true);
        // Its count given: none left.
        taken(backend)["tp-b"] = 1;
        const empty = await backend.pnpFeederCheck(board.id, ["TP1", "TP2"]);
        expect(empty.feeders[1]).toMatchObject({ id: "tp-b", left: 0, needs: 1 });
        expect(empty.problems).toEqual(["feeder tp-b has no parts left, 1 needed"]);
        expect(empty.ready).toBe(false);
        // Disconnected, where the bus answered is forgotten.
        await backend.disconnect();
        expect((await backend.pnpFeederCheck(board.id, ["TP1"])).feeders[0]).toMatchObject({ seen: false, place_known: false, address: null });
    });

    test("a feeder short of parts, one found at an address with no slot place, and a job with no board", async () => {
        const { backend } = setup();
        const text = PROFILE.replace('refs = ["TP2"]\nat = [10.0, 10.0, 5.0]\npitch = [4.0, 0.0]\ncount = 1', 'refs = ["TP2", "TP3"]\nat = [10.0, 10.0, 5.0]\npitch = [4.0, 0.0]\ncount = 3')
            + `[[feeder]]\nid = "other"\nmatch = "nothing"\nbus_id = "AABBCCDDEEFF001122334455"\nslot = 3\n`;
        await connectGcode(backend, "lumen", text);
        const board = await backend.uploadJob(new File(["(kicad_pcb)"], "board.kicad_pcb"), {});
        taken(backend)["tp-b"] = 2;
        await backend.pnpBusScan();
        const check = await backend.pnpFeederCheck(board.id);
        expect(check.feeders.map((entry) => entry.id)).toEqual(["tp-a", "tp-b"]);
        // tp-a answers at the first address no slot of the file names.
        expect(check.feeders[0]).toMatchObject({ address: 1, seen: true, place_known: false });
        expect(check.feeders[1]).toMatchObject({ needs: 2, left: 1 });
        expect(check.problems).toEqual(["feeder tp-a answered at address 1, which has no [[slot]] place", "feeder tp-b has 1 part left, 2 needed"]);
        const drawn = await backend.uploadJob(new File(["<svg xmlns='http://www.w3.org/2000/svg'><path d='M0 0 L10 0'/></svg>"], "line.svg"), {});
        await expect(backend.pnpFeederCheck(drawn.id)).rejects.toThrow("only a .kicad_pcb upload keeps the board its parts are read from");
    });

    test("the check and the plan take up the same parts, for the same reasons", () => {
        const device = parseDevice(`[motion]\nsafe_z = 30\nplace_z = 10\n[[feeder]]\nid = "r10k"\nmatch = "10k"\nat = [0.0, 0.0, 1.0]\npitch = [4.0, 0.0]\n[[feeder]]\nid = "kept"\nrefs = ["H2"]\nmatch = ""\nat = [0.0, 9.0, 1.0]\n`, "m");
        const parts = [
            part("R1", "10k"), part("R2", "4k7"), part("FID1", "Fiducial", { fiducial: true }), part("R3", "10k", { dnp: true }),
            part("R4", "10k", { side: "back" }), part("R5", "10k", { filtered: true }), part("H1", "Hole", { exclude_from_pos_files: true }),
            part("H2", "Hole", { exclude_from_pos_files: true }),
        ];
        const fit = { rotation: 0, shift: [0, 0] as [number, number], scale: 1, rms: 0, residuals: [0], marks: 1 };
        for (const refs of [null, ["R1", "R2", "FID1", "R9", "H1"]]) {
            const plan = planDevice(device, parts, fit, {}, refs, "board");
            const entries = partFeeders(device.feeders, parts, refs);
            expect(entries.filter((entry) => entry.reason !== null).map((entry) => ({ ref: entry.ref, reason: entry.reason }))).toEqual(plan.skipped);
            expect(entries.filter((entry) => entry.reason === null).map((entry) => [entry.ref, entry.feeder?.id])).toEqual(plan.blocks.map((block) => [block.ref, block.feeder]));
            // The check lists what the plan places and what it leaves out for want of a feeder.
            const check = feederCheck(device, parts, refs, {}, new Map());
            expect(check.parts.map((entry) => entry.ref)).toEqual(entries.filter((entry) => entry.listed).map((entry) => entry.ref));
        }
        expect(feederCheck(device, parts, null, {}, new Map()).parts.map((entry) => entry.ref)).toEqual(["R1", "R2", "H2"]);
    });
});

describe("the Feeders panel and the check", () => {
    test("the parts no feeder holds are listed above the feeders, which say what they want", async () => {
        const { ctx, root, backend } = setup();
        await connectGcode(backend, "lumen", PROFILE);
        await ctx.refreshPlacing();
        mountPnpFeeders(root, ctx);
        await pickBoard(ctx, backend);
        await settle();
        await settle();
        const loose = root.querySelector(".feeder-loose")!;
        expect(loose.classList.contains("hidden")).toBe(false);
        expect(loose.textContent).toBe("TP39 mm^2, TestPoint_Pad");
        const cells = Array.from(root.querySelectorAll(".device-feeders tbody tr")).map((row) => Array.from(row.querySelectorAll("td")).map((cell) => cell.textContent));
        expect(cells[0]?.[2]).toBe("not found on the bus yet: scan it");
        expect(root.querySelector(".device-feeders td[data-need]")?.textContent).toBe("not found on the bus yet: scan it");
        // A scan finds it; the check is asked again and the row says where.
        findButton(root, "Scan bus").click();
        for (let turn = 0; turn < 6; turn++) {
            await settle();
        }
        expect(root.querySelector(".device-feeders tbody tr td:nth-child(3)")?.textContent).toBe("found at address 3");
        expect(root.querySelector(".device-feeders td[data-need]")).toBeNull();
    });

    test("asked again when what it depends on changes, and not otherwise", async () => {
        const { ctx, backend, calls } = setup();
        await connectGcode(backend, "lumen", PROFILE);
        await ctx.refreshPlacing();
        const asked = (): number => calls.filter((call) => call.name === "pnpFeederCheck").length;
        // No board: nothing to ask.
        await refreshFeederCheck(ctx);
        expect(asked()).toBe(0);
        const board = await pickBoard(ctx, backend);
        await refreshFeederCheck(ctx);
        expect(asked()).toBe(1);
        expect(ctx.store.get().feederCheck?.job).toBe(board.id);
        // The same question is not asked twice, and a status report changes none of it.
        await refreshFeederCheck(ctx);
        await ctx.refreshPlacing();
        await refreshFeederCheck(ctx);
        expect(asked()).toBe(1);
        // The counts changed: asked again.
        taken(backend)["tp-b"] = 1;
        await ctx.refreshPlacing();
        await refreshFeederCheck(ctx);
        expect(asked()).toBe(2);
        // A kept-out part picked to be placed changes the parts asked for.
        setPickedToPlace(board.id, "H1", true);
        await refreshFeederCheck(ctx);
        expect(asked()).toBe(3);
        expect(calls.filter((call) => call.name === "pnpFeederCheck").at(-1)?.args).toEqual([board.id, ["TP1", "TP2", "TP3", "H1"]]);
        localStorage.removeItem(`spinny.pnp.place.${board.id}`);
        await refreshFeederCheck(ctx);
        expect(asked()).toBe(4);
        // Forced, as after a scan: asked even with nothing changed in the page.
        await refreshFeederCheck(ctx, true);
        expect(asked()).toBe(5);
        // The board let go: the check goes with it.
        ctx.store.set({ job: null });
        await refreshFeederCheck(ctx);
        expect(ctx.store.get().feederCheck).toBeNull();
    });
});
