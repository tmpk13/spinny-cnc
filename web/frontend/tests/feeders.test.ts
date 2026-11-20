// The feeders plan's page side (docs/FEEDERS.md): the feeder check and the
// Feeders step, the panel's parts with no feeder, and the mock's twins of
// the routes.

import { afterEach, describe, expect, test } from "bun:test";

import type { MockBackend } from "../src/mock/backend.ts";
import { appendTable } from "../src/mock/cam.ts";
import { feederCheck, partFeeders, planDevice } from "../src/mock/openpnp.ts";
import { initialState, type AppState } from "../src/state.ts";
import type { Component, FeederCheck, FeederCheckFeeder, Job, PlacingState } from "../src/types.ts";
import { placingSteps, stepToOpen } from "../src/views/areaviews.ts";
import { autoMemory, autoMove } from "../src/views/autosteps.ts";
import { into } from "../src/views/context.ts";
import { checkLine, feedersDone, feedersLine, refreshFeederCheck, refsText } from "../src/views/feedercheck.ts";
import { setPickedToPlace } from "../src/views/partsfilter.ts";
import { MOCK_BUS_LOOSE } from "../src/mock/machines.ts";
import { advanceFor, draftProblem, draftValues, feederIdFor, feederPlaceText, feederTakenText, freeAddress, identifyText, looseGroups, matchWords, mountPnpFeeders, slotTip, slotWay } from "../src/views/pnpfeeders.ts";
import { connectGcode, parseDevice } from "./gcoderig.ts";
import { dialogButton, findButton, settle, setup } from "./harness.ts";

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

/** Lets the mock's answers and the page's redraws after a press come in. */
async function settled(turns = 8): Promise<void> {
    for (let turn = 0; turn < turns; turn++) {
        await settle();
    }
}

/** The mock's LumenPnP connected, with its own feeders, its board picked and the panel mounted. */
async function lumenPanel(): Promise<ReturnType<typeof setup> & { board: Job }> {
    const rig = setup();
    rig.store.set({ snapshot: await rig.backend.connect("/dev/ttyACM1", "opulo-lumen-rev5") });
    await rig.ctx.refreshPlacing();
    mountPnpFeeders(rig.root, rig.ctx);
    const board = await pickBoard(rig.ctx, rig.backend);
    await settled();
    return { ...rig, board };
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
        expect(before.problems).toEqual(["TP3: no feeder holds it", "feeder tp-a's slot is not known: scan the feeder bus"]);
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
        expect(check.problems).toEqual(["feeder tp-a is at bus address 1, which has no [[slot]] place in the machine file", "feeder tp-b has 1 part left, 2 needed"]);
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
        expect(loose.querySelector(".group-name")?.textContent).toBe("TP3");
        expect(loose.querySelector(".muted")?.textContent).toBe("9 mm^2, TestPoint_Pad");
        expect(findButton(loose, "Add feeder")).toBeDefined();
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

describe("adding a feeder", () => {
    test("its id, its words and its advance from the parts' value and footprint", () => {
        expect(feederIdFor("10k", "Resistor_SMD:R_0603_1608Metric", [])).toBe("10k-r0603");
        expect(feederIdFor("100n", "C_0402_1005Metric", ["100n-c0402"])).toBe("100n-c0402-2");
        expect(feederIdFor("9 mm^2", "TestPoint:TestPoint_Pad", [])).toBe("9-mm-2-testpoint");
        expect(feederIdFor("STM32F103", "Package_QFP:LQFP-48_7x7mm_P0.5mm", [])).toBe("stm32f103-lqfp-48");
        expect(feederIdFor("", "", [])).toBe("feeder");
        expect(matchWords("10k", "Resistor_SMD:R_0603_1608Metric")).toBe("10k R_0603_1608Metric");
        expect(advanceFor("Capacitor_SMD:C_0402_1005Metric")).toBe(2);
        expect(advanceFor("Resistor_SMD:R_0603_1608Metric")).toBe(4);
        expect(advanceFor("Package_TO_SOT_SMD:SOT-23")).toBe(4);
    });

    test("what a draft lacks, and the table it writes", () => {
        const draft = { id: "10k-r0603", match: "10k R_0603_1608Metric", refs: null, busId: "AABBCCDDEEFF001122334455", advance: 4 };
        expect(draftProblem(draft, [])).toBeNull();
        expect(draftProblem({ ...draft, id: "Big" }, [])).toBe("id: lower case letters, digits, - and _");
        expect(draftProblem(draft, ["10k-r0603"])).toBe("the file has a feeder 10k-r0603 already");
        expect(draftProblem({ ...draft, match: " " }, [])).toBe("say which parts it holds");
        expect(draftProblem({ ...draft, busId: null }, [])).toBe("scan the bus first: its id on the bus is needed");
        expect(draftProblem({ ...draft, advance: 30 }, [])).toBe("advance: 0.1 to 25.5 mm");
        expect(draftValues(draft)).toEqual({ id: "10k-r0603", match: "10k R_0603_1608Metric", bus_id: "AABBCCDDEEFF001122334455", advance: 4 });
        // By reference, the words are left out.
        expect(draftValues({ ...draft, refs: ["R3", "R4"] })).toEqual({ id: "10k-r0603", refs: ["R3", "R4"], bus_id: "AABBCCDDEEFF001122334455", advance: 4 });
    });

    test("the table goes at the end of the file, its comments kept, refused as the backend refuses it", () => {
        const text = "# a machine\n[motion]\nsafe_z = 30 # the height\n\n\n";
        expect(appendTable(text, "feeder", { id: "a", match: "10k", advance: 2.5, refs: ["R1"] }))
            .toBe('# a machine\n[motion]\nsafe_z = 30 # the height\n\n[[feeder]]\nid = "a"\nmatch = "10k"\nadvance = 2.5\nrefs = ["R1"]\n');
        expect(() => appendTable(text, "Feeder", { id: "a" })).toThrow("a table's name is lower case letters, digits and _, not 'Feeder'");
        expect(() => appendTable(text, "feeder", { "bad key": 1 })).toThrow("[[feeder]]: 'bad key' is not a key: letters, digits, - and _");
        expect(() => appendTable(text, "feeder", { slot: null })).toThrow("[[feeder]] slot has no value, and TOML has no null: leave the key out");
        expect(() => appendTable(text, "feeder", { at: { x: 1 } as unknown as number })).toThrow("[[feeder]] at: cannot write a value of type dict");
        expect(() => appendTable(text, "motion", { safe_z: 1 })).toThrow("the file with [[motion]] added does not read as TOML");
    });

    test("the mock's machine file takes the table once the whole file reads", async () => {
        const { backend } = setup();
        await connectGcode(backend, "lumen", PROFILE);
        const written = await backend.addMachineTable("lumen", "feeder", { id: "tp-c", refs: ["TP3"], bus_id: "AABBCCDDEEFF001122334455" });
        expect(written.text).toEndWith('\n\n[[feeder]]\nid = "tp-c"\nrefs = ["TP3"]\nbus_id = "AABBCCDDEEFF001122334455"\n');
        expect(written.document?.gcode?.feeders.map((feeder) => feeder.id)).toEqual(["tp-a", "tp-b", "tp-c"]);
        await expect(backend.addMachineTable("lumen", "feeder", { id: "tp-c", match: "x", at: [1, 2, 3] })).rejects.toThrow("[feeder 4] id 'tp-c' is another feeder's too");
        await expect(backend.addMachineTable("none", "feeder", { id: "x" })).rejects.toThrow("no machine file 'none'");
    });

    test("the mock's LumenPnP has feeders, and a feeder on its bus that its file does not name", async () => {
        const { lumen } = { lumen: setup() };
        await lumen.backend.connect("/dev/ttyACM1", "opulo-lumen-rev5");
        const state = await lumen.backend.placingState();
        expect(state.document?.feeders.map((feeder) => feeder.id)).toEqual(["tp-9mm2", "r-10k-0603", "c-100n-0402"]);
        const scan = await lumen.backend.pnpBusScan();
        expect(scan.feeders).toEqual([
            { address: 1, id: "0102030405060708090A0B0C", feeder: "tp-9mm2", slot: true },
            { address: 2, id: "1112131415161718191A1B1C", feeder: "r-10k-0603", slot: true },
            { address: 3, id: "2122232425262728292A2B2C", feeder: null, slot: false },
        ]);
    });

    test("from a part no feeder holds: its pair's words, the id a scan found that no feeder has, its advance", async () => {
        const { root, calls, store } = await lumenPanel();
        // No scan yet: the form says to scan first and will not save.
        findButton(root.querySelector(".feeder-loose")!, "Add feeder").click();
        let form = root.querySelector<HTMLElement>(".feeder-form")!;
        expect(form.textContent).toContain("Scan the bus first");
        expect(findButton(form, "Save").disabled).toBe(true);
        expect(findButton(form, "Save").dataset["reason"]).toBe("scan the bus first: its id on the bus is needed");
        findButton(form, "Cancel").click();
        expect(root.querySelector(".feeder-form")).toBeNull();
        findButton(root, "Scan bus").click();
        await settled();
        findButton(root.querySelector(".feeder-loose")!, "Add feeder").click();
        form = root.querySelector<HTMLElement>(".feeder-form")!;
        expect(form.querySelector<HTMLInputElement>("input[aria-label='Feeder id']")?.value).toBe("9-mm-2-testpoint");
        expect(form.querySelector<HTMLSelectElement>("select[aria-label='Its id on the bus']")?.value).toBe("2122232425262728292A2B2C");
        expect(form.querySelector<HTMLInputElement>("input[aria-label='Advance, mm']")?.value).toBe("4");
        findButton(form, "2").click();
        findButton(form, "Save").click();
        await settled();
        const added = calls.filter((call) => call.name === "addMachineTable").at(-1);
        expect(added?.args).toEqual(["opulo-lumen-rev5", "feeder", { id: "9-mm-2-testpoint", match: "9 mm^2 TestPoint_Pad", bus_id: "2122232425262728292A2B2C", advance: 2 }]);
        // Written: the panel and the check follow the file.
        expect(store.get().placing?.document?.feeders.map((feeder) => feeder.id)).toContain("9-mm-2-testpoint");
        expect(root.querySelector(".feeder-form")).toBeNull();
        expect(store.get().feederCheck?.check?.parts.find((part) => part.ref === "TP3")?.feeder).toBe("9-mm-2-testpoint");
        expect(root.querySelector(".feeder-loose")?.classList.contains("hidden")).toBe(true);
    });

    test("from a scan's row whose id no feeder has: that id, the parts by reference or by words", async () => {
        const { root, calls } = await lumenPanel();
        findButton(root, "Scan bus").click();
        await settled();
        const row = root.querySelector<HTMLElement>(".bus-scan li[data-address='3']")!;
        expect(row.querySelector(".group-says")?.textContent).toBe("2122232425262728292A2B2C, not in the file, no slot place yet");
        findButton(row, "Add feeder").click();
        // The rows are drawn again with the form under the one it was opened on.
        const form = root.querySelector<HTMLElement>(".bus-scan li[data-address='3'] .feeder-form")!;
        expect(form.textContent).toContain("2122232425262728292A2B2C");
        const parts = form.querySelector<HTMLSelectElement>("select[aria-label='Parts it holds']")!;
        expect(Array.from(parts.options).map((option) => option.textContent)).toEqual(["9 mm^2 TestPoint_Pad (TP3)"]);
        findButton(form, "Save").click();
        await settled();
        expect(calls.filter((call) => call.name === "addMachineTable").at(-1)?.args[2]).toEqual({ id: "9-mm-2-testpoint", match: "9 mm^2 TestPoint_Pad", bus_id: "2122232425262728292A2B2C", advance: 4 });
    });

    test("a part's group by reference; a file with no bus offers no feeder to add", async () => {
        const { root, calls } = await lumenPanel();
        findButton(root, "Scan bus").click();
        await settled();
        findButton(root.querySelector(".feeder-loose")!, "Add feeder").click();
        const form = root.querySelector<HTMLElement>(".feeder-form")!;
        const parts = form.querySelector<HTMLSelectElement>("select[aria-label='Parts it holds']")!;
        expect(Array.from(parts.options).map((option) => option.textContent)).toEqual(["9 mm^2 TestPoint_Pad (TP3)", "TP3 by reference"]);
        parts.value = "1";
        parts.dispatchEvent(new Event("change"));
        const id = form.querySelector<HTMLInputElement>("input[aria-label='Feeder id']")!;
        id.value = "tp3";
        id.dispatchEvent(new Event("input"));
        findButton(form, "Save").click();
        await settled();
        expect(calls.filter((call) => call.name === "addMachineTable").at(-1)?.args[2]).toEqual({ id: "tp3", refs: ["TP3"], bus_id: "2122232425262728292A2B2C", advance: 4 });
        // A machine with no bus: the parts are listed, with nothing to add.
        const plain = setup();
        await connectGcode(plain.backend, "plain", PROFILE.replace(/\[bus\][\s\S]*$/, '[[feeder]]\nid = "tp-a"\nrefs = ["TP1"]\nat = [1.0, 2.0, 3.0]\n'));
        await plain.ctx.refreshPlacing();
        mountPnpFeeders(plain.root, plain.ctx);
        await pickBoard(plain.ctx, plain.backend);
        await settled();
        expect(plain.root.querySelector(".feeder-loose .group-name")?.textContent).toBe("TP2 TP3");
        expect(plain.root.querySelector(".feeder-loose button")).toBeNull();
    });

    test("the picked feeders' buttons: put away with none picked, Feed each one on the bus, Count again each", async () => {
        const { root, calls } = await lumenPanel();
        const rows = (): HTMLTableRowElement[] => Array.from(root.querySelectorAll<HTMLTableRowElement>(".device-feeders tbody tr"));
        expect(findButton(root, "Feed").hidden).toBe(true);
        expect(root.querySelector(".feeder-picks")?.textContent).toContain("Pick feeders in the list to feed, count or scan them.");
        rows()[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        rows()[2]!.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
        expect(findButton(root, "Feed").hidden).toBe(false);
        findButton(root, "Feed").click();
        await settled();
        // The strip is not on the bus: the one bus feeder picked is fed.
        expect(calls.filter((call) => call.name === "pnpBusFeed").map((call) => call.args[0])).toEqual(["tp-9mm2"]);
        findButton(root, "Count again").click();
        await settle();
        expect(document.querySelector("dialog[open]")?.textContent).toContain("Count feeders tp-9mm2, c-100n-0402 from the first part again?");
        dialogButton("Count again").click();
        await settled();
        expect(calls.filter((call) => call.name === "pnpResetFeeders").map((call) => call.args[0])).toEqual(["tp-9mm2", "c-100n-0402"]);
    });
});

/** Puts the mock's head where a test wants it, as a jog would have left it. */
function headAt(backend: MockBackend, x: number, y: number, z: number): void {
    (backend as unknown as { deviceLink: { position: { x: number; y: number; z: number; rotation: number } } }).deviceLink.position = { x, y, z, rotation: 0 };
}

describe("a slot's place, by the top camera or the nozzle", () => {
    test("by the nozzle: the head's X, Y and Z, written as a new [[slot]] at the file's end, or into the slot there", async () => {
        const { backend } = setup();
        await connectGcode(backend, "lumen", PROFILE);
        headAt(backend, 120.5, 401.25, 9.5);
        const answer = await backend.pnpBusSlot({ address: 4, by: "nozzle" });
        expect(answer.slot).toEqual({ address: 4, at: [120.5, 401.25, 9.5], rotation: 0 });
        expect((await backend.machineFile("lumen")).text).toEndWith("\n\n[[slot]]\naddress = 4\nat = [120.5, 401.25, 9.5]\n");
        // Taken again: the slot's place changes, no second slot.
        headAt(backend, 121, 401, 9.5);
        await backend.pnpBusSlot({ address: 4, by: "nozzle" });
        const doc = (await backend.placingState()).document!;
        expect(doc.slots?.map((slot) => [slot.address, slot.at])).toEqual([[3, [100, 400, 10]], [4, [121, 401, 9.5]]]);
        await expect(backend.pnpBusSlot({ address: 0, by: "nozzle" })).rejects.toThrow("a slot's address is 1 to 254, not 0");
        await expect(backend.pnpBusSlot({ address: 4, by: "nozzle", find: true })).rejects.toThrow("find is for a slot taken with the camera");
    });

    test("by the camera: the head plus the measured offset, the height the slot's own or the other slots'", async () => {
        const { backend } = setup();
        await connectGcode(backend, "lumen", PROFILE + `[[slot]]\naddress = 5\nat = [130.0, 400.0, 10.04]\n`);
        headAt(backend, 80, 340, 31.5);
        await expect(backend.pnpBusSlot({ address: 6, by: "camera" })).rejects.toThrow("measure the top camera's offset first, or take the slot with the nozzle");
        await backend.topSettings({ offset: [20, 60] });
        // A new slot: the others' heights, which agree within 0.05 mm.
        expect((await backend.pnpBusSlot({ address: 6, by: "camera" })).slot).toEqual({ address: 6, at: [100, 400, 10.02], rotation: 0 });
        // The slot's own height when it has one.
        headAt(backend, 81, 341, 31.5);
        expect((await backend.pnpBusSlot({ address: 3, by: "camera" })).slot.at).toEqual([101, 401, 10]);
        // Heights apart: the nozzle first.
        await connectGcode(backend, "far", PROFILE + `[[slot]]\naddress = 5\nat = [130.0, 400.0, 10.1]\n`);
        await expect(backend.pnpBusSlot({ address: 7, by: "camera" })).rejects.toThrow("take one slot with the nozzle first: the camera gives no height (the other slots' heights differ by 0.100 mm)");
        // Find needs the shade of the feeder there.
        await expect(backend.pnpBusSlot({ address: 3, by: "camera", find: true })).rejects.toThrow("find needs the feeder's pocket shade");
    });

    test("the camera over a slot moves only X and Y, by the measured offset", async () => {
        const { backend } = setup();
        await connectGcode(backend, "lumen", PROFILE);
        await expect(backend.pnpBusOverSlot(9)).rejects.toThrow("lumen's file has no [[slot]] for bus address 9");
        await expect(backend.pnpBusOverSlot(3)).rejects.toThrow("measure the top camera's offset first: the camera goes over a slot by it");
        await backend.topSettings({ offset: [20, 60] });
        headAt(backend, 0, 0, 40);
        const before = (await backend.placingState()).log.length;
        await backend.pnpBusOverSlot(3);
        const sent = (await backend.placingState()).log.slice(before).filter((entry) => entry.dir === "tx").map((entry) => entry.text);
        // Across at the safe height: one move of X and Y, no Z in it; a Z move only to the safe height.
        const moves = sent.filter((line) => /^G[01] /.test(line));
        const across = moves.filter((line) => /X/.test(line));
        expect(across.length).toBe(1);
        expect(across[0]).toMatch(/X80\b.*Y340\b/);
        expect(across[0]).not.toMatch(/Z/);
        expect(moves.filter((line) => !/X/.test(line)).every((line) => /^G[01] Z31\.5\b/.test(line))).toBe(true);
    });

    test("the row's Slot here goes by the camera once its offset is measured, the other way under the row", async () => {
        const { root, calls, backend, ctx } = await lumenPanel();
        findButton(root, "Scan bus").click();
        await settled();
        // Address 3 has no slot place: by the nozzle while no offset is measured.
        expect(slotWay(ctx.store.get())).toBe("nozzle");
        let row = root.querySelector<HTMLElement>(".bus-scan li[data-address='3']")!;
        expect(findButton(row, "Slot here").title).toBe(slotTip(3, "nozzle"));
        expect(findButton(row, "Slot by camera").dataset["reason"]).toBe("measure the top camera's offset first (Cameras, Top camera)");
        await into(ctx, "placing", backend.topSettings({ offset: [20, 60] }));
        await settled();
        row = root.querySelector<HTMLElement>(".bus-scan li[data-address='3']")!;
        expect(findButton(row, "Slot here").title).toBe(slotTip(3, "camera"));
        expect(findButton(row, "Slot by nozzle").disabled).toBe(false);
        headAt(backend, 80, -30, 31.5);
        findButton(row, "Slot here").click();
        await settle();
        dialogButton("Take it").click();
        await settled();
        expect(calls.filter((call) => call.name === "pnpBusSlot").at(-1)?.args[0]).toEqual({ address: 3, by: "camera" });
        // The head plus the offset (the LumenPnP's skew taken out of X), at the other slots' height.
        const [x, y, z] = ctx.store.get().placing!.document!.slots!.find((slot) => slot.address === 3)!.at;
        expect([Math.round(x), y, z]).toEqual([100, 30, 12]);
        // Its place known, the row's button goes under it, with the camera over the slot.
        row = root.querySelector<HTMLElement>(".bus-scan li[data-address='3']")!;
        expect(row.querySelector(".group-row button.btn")?.textContent).toBe("Add feeder");
        findButton(row, "Camera over slot").click();
        await settled();
        expect(calls.filter((call) => call.name === "pnpBusOverSlot").map((call) => call.args)).toEqual([[3]]);
    });
});

describe("identify a feeder, program a slot's address", () => {
    test("the address offered, and what an identify answered, in words", () => {
        const found = [{ address: 1, id: "A", feeder: null, slot: true }, { address: 2, id: "B", feeder: null, slot: false }];
        expect(freeAddress(found, [{ address: 3 }])).toBe(4);
        expect(freeAddress([], [])).toBe(1);
        const names = new Map([["0102", "c-100n"]]);
        expect(identifyText(["0102"], [], names)).toBe("c-100n flashes");
        expect(identifyText(["0102", "0304"], [{ feeder: "c-1u", id: "0506", reason: "did not answer to its id: is it in a slot?" }], names))
            .toBe("c-100n, 0304 flash in turn; c-1u: did not answer to its id: is it in a slot?");
    });

    test("the mock's identify: by name and by id, a feeder with no address too; the ones not there named", async () => {
        const { backend } = setup();
        await backend.connect("/dev/ttyACM1", "opulo-lumen-rev5");
        const answer = await backend.pnpBusIdentify({ feeders: ["tp-9mm2", "c-100n-0402"], ids: ["3132333435363738393a3b3c", "AABBCCDDEEFF001122334455"] });
        expect(answer.identified).toEqual(["0102030405060708090A0B0C", "3132333435363738393A3B3C"]);
        expect(answer.missing).toEqual([
            { feeder: "c-100n-0402", id: null, reason: "not on the bus: its file gives no bus_id" },
            { feeder: "AABBCCDDEEFF001122334455", id: "AABBCCDDEEFF001122334455", reason: "did not answer to its id: is it in a slot?" },
        ]);
        await expect(backend.pnpBusIdentify({})).rejects.toThrow("name the feeders to identify, or their ids on the bus");
        await expect(backend.pnpBusIdentify({ feeders: ["nope"] })).rejects.toThrow("Opulo LumenPnP (Rev05, Marlin)'s file has no feeder 'nope'");
        await expect(backend.pnpBusIdentify({ ids: ["12"] })).rejects.toThrow("a feeder's id is 24 hex digits, not '12'");
    });

    test("Set address moves a feeder, and its [[slot]] and the feeders pinned to it with it (Q67)", async () => {
        const { backend } = setup();
        await backend.connect("/dev/ttyACM1", "opulo-lumen-rev5");
        // r-10k-0603 is pinned to slot 2, whose place the file has.
        await expect(backend.pnpBusProgram({ address: 1, feeder: "1112131415161718191A1B1C" })).rejects.toThrow("feeder tp-9mm2 answers at address 1: pick another");
        await expect(backend.pnpBusProgram({ address: 26, feeder: "1112131415161718191A1B1C" })).rejects.toThrow("a slot's address is 1 to [bus] max_address 25, not 26");
        const answer = await backend.pnpBusProgram({ address: 7, feeder: "1112131415161718191a1b1c" });
        expect([answer.address, answer.id]).toEqual([7, "1112131415161718191A1B1C"]);
        expect(answer.feeders.find((entry) => entry.id === "1112131415161718191A1B1C")).toEqual({ address: 7, id: "1112131415161718191A1B1C", feeder: "r-10k-0603", slot: true });
        const doc = (await backend.placingState()).document!;
        expect(doc.slots?.map((slot) => slot.address)).toEqual([1, 7]);
        expect(doc.feeders.find((feeder) => feeder.id === "r-10k-0603")?.slot).toBe(7);
        // An address another [[slot]] names is refused, as is a feeder not there.
        const file = await backend.machineFile("opulo-lumen-rev5");
        await backend.saveMachineFile("opulo-lumen-rev5", `${file.text}\n[[slot]]\naddress = 5\nat = [130.0, 30.0, 12.0]\n`);
        await expect(backend.pnpBusProgram({ address: 5, feeder: "2122232425262728292A2B2C" })).rejects.toThrow("the machine file's [[slot]] 5 is another slot's place: pick another address");
        await expect(backend.pnpBusProgram({ address: 9, feeder: "AABBCCDDEEFF001122334455" })).rejects.toThrow("the slot's address was not written: no feeder answered to the id AABBCCDDEEFF001122334455: is it in a slot?");
    });

    test("Address a new slot: the one feeder with no address gets it; none, or two, are refused", async () => {
        const { backend } = setup();
        await backend.connect("/dev/ttyACM1", "opulo-lumen-rev5");
        await expect(backend.pnpBusProgram({ address: 2 })).rejects.toThrow("feeder r-10k-0603 answers at address 2: pick another");
        const kept = MOCK_BUS_LOOSE["opulo-lumen-rev5"]!;
        try {
            MOCK_BUS_LOOSE["opulo-lumen-rev5"] = [...kept, { id: "4142434445464748494A4B4C", address: null }];
            await expect(backend.pnpBusProgram({ address: 9 })).rejects.toThrow("more than one feeder has no address: leave one in");
            MOCK_BUS_LOOSE["opulo-lumen-rev5"] = [{ id: "5152535455565758595A5B5C", address: null, floor: false }];
            await expect(backend.pnpBusProgram({ address: 9 })).rejects.toThrow("the slot's floor did not take the address: no floor chip, or the write did not read back");
        } finally {
            MOCK_BUS_LOOSE["opulo-lumen-rev5"] = kept;
        }
        const answer = await backend.pnpBusProgram({ address: 9 });
        expect(answer.id).toBe("3132333435363738393A3B3C");
        expect(answer.feeders.find((entry) => entry.address === 9)?.id).toBe("3132333435363738393A3B3C");
        await expect(backend.pnpBusProgram({ address: 10 })).rejects.toThrow("no feeder without an address answered");
    });

    test("in the panel: Identify the picked feeders or a row's, Set address and Address a new slot ask first, naming the address", async () => {
        const { root, calls } = await lumenPanel();
        findButton(root, "Scan bus").click();
        await settled();
        // The picked feeders on the bus.
        const rows = Array.from(root.querySelectorAll<HTMLTableRowElement>(".device-feeders tbody tr"));
        rows[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        rows[2]!.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
        findButton(root.querySelector(".feeder-picks")!, "Identify").click();
        await settled();
        expect(calls.filter((call) => call.name === "pnpBusIdentify").at(-1)?.args[0]).toEqual({ feeders: ["tp-9mm2"] });
        // A row's own.
        let row = root.querySelector<HTMLElement>(".bus-scan li[data-address='3']")!;
        findButton(row, "Identify").click();
        await settled();
        expect(calls.filter((call) => call.name === "pnpBusIdentify").at(-1)?.args[0]).toEqual({ ids: ["2122232425262728292A2B2C"] });
        // Set address offers the lowest address no feeder and no slot has.
        row = root.querySelector<HTMLElement>(".bus-scan li[data-address='2']")!;
        expect(row.querySelector<HTMLInputElement>("input[aria-label='New address for address 2']")?.value).toBe("4");
        findButton(row, "Set address").click();
        await settle();
        expect(document.querySelector("dialog[open]")?.textContent).toContain("Write address 4 into the floor of the slot feeder r-10k-0603 sits in? It answers at 4 from then on, and the file's [[slot]] 2 becomes [[slot]] 4.");
        dialogButton("Write address 4").click();
        await settled();
        expect(calls.filter((call) => call.name === "pnpBusProgram").at(-1)?.args[0]).toEqual({ address: 4, feeder: "1112131415161718191A1B1C" });
        expect(root.querySelector(".bus-scan li[data-address='4']")?.textContent).toContain("r-10k-0603");
        // Address a new slot, under the panel's More.
        const more = root.querySelector<HTMLDetailsElement>(".bus-more-fold")!;
        expect(more.querySelector("summary")?.textContent).toBe("More: address a new slot");
        expect(more.querySelector<HTMLInputElement>("input")?.value).toBe("2");
        findButton(more, "Address a new slot").click();
        await settle();
        expect(document.querySelector("dialog[open]")?.textContent).toContain("Write address 2 into the floor of the slot whose feeder has no address?");
        dialogButton("Write address 2").click();
        await settled();
        expect(calls.filter((call) => call.name === "pnpBusProgram").at(-1)?.args[0]).toEqual({ address: 2 });
        expect(root.querySelector(".bus-scan li[data-address='2']")?.textContent).toContain("3132333435363738393A3B3C");
    });
});

describe("the scan's rows and the machine in use", () => {
    test("another G-code machine connected drops the rows the last one's bus answered with", async () => {
        const { root, store, ctx, backend } = await lumenPanel();
        findButton(root, "Scan bus").click();
        await settled();
        expect(root.querySelectorAll(".bus-scan li").length).toBeGreaterThan(0);
        // A second pick and place machine, whose file has a bus of its own.
        await backend.saveMachineFile("lumen-two", (await backend.machineFile("opulo-lumen-rev5")).text);
        store.set({ snapshot: await backend.connect("/dev/ttyACM2", "lumen-two") });
        await ctx.refreshPlacing();
        await settled();
        expect(store.get().placing?.machine).toBe("lumen-two");
        expect(store.get().placing?.document?.bus).toBe(true);
        // Its bus has not been scanned: no row of the LumenPnP's, whose
        // addresses and ids Slot here, Set address and Add feeder would use.
        expect(root.querySelectorAll(".bus-scan li").length).toBe(0);
        expect(root.querySelector(".bus-scan")?.classList.contains("hidden")).toBe(true);
    });
});
