import { describe, expect, test } from "bun:test";

import { DEVICE_LINES_PER_SECOND, MockBackend } from "../src/mock/backend.ts";
import { blockLines, deviceFit, planDevice, planSummary, VISION_NOTE } from "../src/mock/openpnp.ts";
import type { Component } from "../src/types.ts";
import { PLACING_SETUP, placingBadge, placingRunText, referencesOf } from "../src/views/placing.ts";
import { mountPnp } from "../src/views/pnp.ts";
import { parseDevice } from "./gcoderig.ts";
import { click, dialogButton, settle, setup, pnpRoots } from "./harness.ts";

// The backend's test profile, word for word, so the two programs can be compared.
const PROFILE = `name = "test machine"
[port]
url = "socket://127.0.0.1:9"
wait_ms = 0
timeout = 2
[gcode]
init = ["G21", "G90"]
end = ["G0 Z5"]
dwell = "G4 S{s}"
[motion]
feed_xy = 3000
feed_z = 600
safe_z = 5
place_z = -1
pick_dwell_ms = 250
place_dwell_ms = 0
[[feeder]]
id = "res"
match = "10k 0603"
at = [10.0, 20.0, -2.0]
pitch = [2.0, 0.5]
count = 2
rotation = 90
[[feeder]]
id = "cap"
match = "100n"
at = [30.0, 20.0, -2.5]
place_z = -0.5
feed = "M600 N1"
`;

function part(ref: string, value: string, footprint: string, x: number, y: number, rotation = 0, extra: Partial<Component> = {}): Component {
    return { ref, value, footprint, side: "front", x, y, rotation, pads: 2, smd: true, dnp: false, ...extra };
}

function runDevice(backend: MockBackend): void {
    for (let i = 0; i < 2000 && backend["deviceSession"] !== null; i++) {
        backend.step(1 / DEVICE_LINES_PER_SECOND);
    }
}

describe("the mock's G-code machine twin", () => {
    test("a file that does not read names the key as the backend does", () => {
        expect(parseDevice(PROFILE, "test").feeders.map((feeder) => feeder.id)).toEqual(["res", "cap"]);
        expect(() => parseDevice(PROFILE.replace('dwell = "G4 S{s}"', 'dwell = "G4 P100"'), "test")).toThrow("[gcode] dwell must hold {ms} or {s}");
        expect(() => parseDevice(PROFILE.replace("safe_z = 5", ""), "test")).toThrow("[motion] safe_z is needed");
        expect(() => parseDevice(PROFILE.replace('id = "cap"', 'id = "res"'), "test")).toThrow("[feeder 2] id 'res' is another feeder's too");
        expect(() => parseDevice(PROFILE.replace("count = 2", "count = 2\nspeed = 3"), "test")).toThrow("[feeder 1] speed is not a key here");
        expect(() => parseDevice(`${PROFILE.replace('init = ["G21", "G90"]', 'init = ["G21", "G90"]\nrotation = "X"')}`, "test")).toThrow("the four axis letters must differ");
    });

    test("the program is the backend's, line for line", () => {
        const fit = deviceFit([[[0, 0], [100, 50]]], null);
        const parts = [
            part("R1", "10k", "Resistor_SMD:R_0603_1608Metric", 1, 2, 0),
            part("R2", "10k", "Resistor_SMD:R_0603_1608Metric", 3, 2, 180),
            part("C1", "100n", "Capacitor_SMD:C_0402", 5, 6, 45),
            part("U1", "STM32", "Package_QFP:LQFP-32", 0, 0),
            part("R3", "10k", "Resistor_SMD:R_0603_1608Metric", 4, 4),
            part("C2", "100n", "Capacitor_SMD:C_0402", 7, 7, 0, { dnp: true }),
            part("C3", "100n", "Capacitor_SMD:C_0402", 8, 8, 0, { side: "back" }),
        ];
        const plan = planDevice(parseDevice(PROFILE, "test"), parts, fit, { res: 1 }, null, "");
        expect(plan.blocks.map((block) => [block.ref, block.feeder, block.index])).toEqual([["R1", "res", 1], ["C1", "cap", 0]]);
        expect(plan.skipped).toEqual([
            { ref: "R2", reason: "feeder res is empty" },
            { ref: "U1", reason: "no feeder holds it" },
            { ref: "R3", reason: "feeder res is empty" },
            { ref: "C2", reason: "not to be fitted (dnp)" },
            { ref: "C3", reason: "on the back" },
        ]);
        expect(blockLines(plan.blocks[0]!)).toEqual([
            "; R1 10k from res #2",
            "G0 Z5 F600",
            "G0 X12 Y20.5 A0 F3000",
            "G0 Z-2 F600",
            "M400",
            "M106",
            "G4 S0.25",
            "G0 Z5 F600",
            "G0 X101 Y52 A-90 F3000",
            "G0 Z-1 F600",
            "M400",
            "M107",
            "G0 Z5 F600",
        ]);
        const c1 = blockLines(plan.blocks[1]!);
        expect(c1[1]).toBe("M600 N1");
        expect(c1).toContain("G0 X105 Y56 A45 F3000");
        expect(c1).toContain("G0 Z-0.5 F600");
        const summary = planSummary(plan);
        expect(summary.text.startsWith("; placement on test machine: 2 parts\nG21\nG90\n")).toBe(true);
        expect(summary.text.endsWith("M400\nG0 Z5\n")).toBe(true);
        expect(summary.lines).toBe(2 + 12 + 13 + 2);
        // Two references fit the board's turn.
        const turned = deviceFit([[[0, 0], [100, 50]], [[10, 0], [100, 60]]], null);
        expect(turned.rotation).toBeCloseTo(90, 9);
    });
});

describe("trays, feeders told to advance, and the bottom camera in the twin", () => {
    const TRAY = PROFILE.replace(
        'feed = "M600 N1"',
        'feed = ["M600 N1", "M400"]\n[[feeder]]\nid = "ic"\nmatch = "STM32"\nat = [50.0, 10.0, -3.0]\npitch = [10.0, 0.0]\n'
        + "count = 6\ncolumns = 3\nrow_pitch = [0.0, 12.0]\nvision = true\n[camera]\nz = -4",
    );

    test("reads and plans them as the backend does", () => {
        const device = parseDevice(TRAY, "test");
        expect(device.feeders[1]!.feed).toEqual(["M600 N1", "M400"]);
        expect(device.camera_z).toBe(-4);
        expect(() => parseDevice(TRAY.replace("count = 6\n", ""), "test")).toThrow("needs its count");
        expect(() => parseDevice(TRAY.replace("columns = 3\n", ""), "test")).toThrow("row_pitch is for a tray");
        const fit = deviceFit([[[0, 0], [100, 50]]], null);
        const parts = [part("C1", "100n", "C_0402", 5, 6), part("U1", "STM32", "LQFP-32", 2, 3, 90)];
        const blind = planDevice(device, parts, fit, { ic: 4 }, null, "");
        expect(blind.blocks.map((block) => block.ref)).toEqual(["C1"]);
        expect(blind.skipped[0]!.reason).toContain("wants the bottom camera");
        const seen = planDevice(device, parts, fit, { ic: 4 }, null, "", true);
        const [c1, u1] = seen.blocks;
        expect(c1!.pick.slice(1, 3)).toEqual(["M600 N1", "M400"]);
        expect(u1!.vision).toBe(true);
        expect(u1!.pick).toContain("G0 X60 Y22 A0 F3000");
        expect(blockLines(u1!)).toContain(VISION_NOTE);
        expect(u1!.place[0]).toBe("G0 X102 Y53 A90 F3000");
        expect(planSummary(seen).parts[1]).toEqual({ ref: "U1", feeder: "ic", index: 4, vision: true });
    });
});

/** The shipped generic Marlin machine file, its strip holding the mock board's test points. */
async function marlinRig(backend: MockBackend, extra = "", vision = false): Promise<void> {
    const file = await backend.machineFile("openpnp-marlin");
    const text = file.text.replace('match = "10k 0603"', `match = "TestPoint"${vision ? "\nvision = true" : ""}`).replace("count = 50", "count = 2") + extra;
    await backend.saveMachineFile("openpnp-marlin", text);
}

describe("a G-code machine in the mock", () => {
    test("is connected from the top bar, referenced, planned and sent, and counts its feeders", async () => {
        const backend = new MockBackend({ timers: false });
        const job = await backend.uploadJob(new File(["(kicad_pcb)"], "board.kicad_pcb"), {});
        const { components } = await backend.components(job.id);
        // Two G-code machine files and none connected yet: nothing to place with.
        await expect(backend.pnpPlan(job.id)).rejects.toMatchObject({ status: 409 });
        await marlinRig(backend);
        const snapshot = await backend.connect("/dev/ttyACM1", "openpnp-marlin");
        expect(snapshot.connected).toBe(true);
        expect(snapshot.profile?.controller).toBe("gcode");
        expect(snapshot.firmware?.name).toContain("Marlin");
        await expect(backend.pnpPlan(job.id)).rejects.toMatchObject({ status: 400 });
        // The console sends its lines as typed; the readout follows.
        await backend.command("G0 X40 Y30");
        expect((await backend.state()).machine?.board).toEqual({ x: 40, y: 30 });
        const referenced = await backend.pnpReference({ job: job.id, ref: components[0]!.ref });
        expect(referenced.references).toEqual([{ job: job.id, ref: components[0]!.ref, at: [40, 30], by: "nozzle" }]);
        const plan = await backend.pnpPlan(job.id);
        // Three test points, a strip of two.
        expect(plan.parts.length).toBe(2);
        expect(plan.skipped).toEqual([{ ref: components[2]!.ref, reason: "feeder r-10k-0603 is empty" }]);
        expect(backend.pnpProgramUrl(job.id).startsWith("data:text/plain")).toBe(true);
        await backend.pnpRun(job.id);
        await expect(backend.home()).rejects.toMatchObject({ status: 409 });
        runDevice(backend);
        const state = await backend.placingState();
        expect(state.progress?.state).toBe("done");
        expect(state.progress?.placed).toEqual(plan.parts.map((entry) => entry.ref));
        expect(state.taken).toEqual({ "r-10k-0603": 2 });
        expect(state.log.some((entry) => entry.text === "M106")).toBe(true);
        expect((await backend.pnpResetFeeders()).taken).toEqual({});
        await backend.pnpGoto({ job: job.id, ref: components[1]!.ref });
        expect(state.running).toBe(false);
        expect((await backend.disconnect()).connected).toBe(false);
        // Disconnected, the tab still places with the machine last connected.
        expect((await backend.placingState()).machine).toBe("openpnp-marlin");
    });

    test("jogs from where the controller says, goes across at the safe height, and stops", async () => {
        const backend = new MockBackend({ timers: false });
        await backend.connect("/dev/ttyACM1", "openpnp-marlin");
        const sent = async (): Promise<string[]> => (await backend.placingState()).log.filter((entry) => entry.dir === "tx").map((entry) => entry.text);
        let before = (await sent()).length;
        await backend.jog({ kind: "joint", dr: 1.5 });
        expect((await sent()).slice(before)).toEqual(["M114", "G0 X1.5 F6000"]);
        before = (await sent()).length;
        await backend.goto({ kind: "joint", r: 30, z: 40, h: -1 });
        expect((await sent()).slice(before)).toEqual(["M114", "G0 X30 Y40 F6000", "G0 Z-1 F1200", "M400", "M114"]);
        before = (await sent()).length;
        await backend.goto({ kind: "joint", r: 30, h: -2 });
        expect((await sent()).slice(before)).toEqual(["M114", "G0 Z-2 F1200", "M400", "M114"]);
        before = (await sent()).length;
        await backend.realtime("reset");
        expect((await sent()).slice(before)).toEqual(["M410"]);
        await expect(backend.realtime("hold")).rejects.toMatchObject({ status: 400 });
        await expect(backend.laser(10, 100)).rejects.toMatchObject({ status: 409 });
        const settings = await backend.settings();
        expect(settings.controller).toBe("gcode");
        expect(settings.controls?.axes.map((axis) => axis.letter)).toEqual(["X", "Y", "Z", "A"]);
    });
});

describe("the bottom camera on the mock's G-code machine", () => {
    test("centers the nozzle over it, then each part marked for it is placed where its center lands", async () => {
        const backend = new MockBackend({ timers: false });
        const job = await backend.uploadJob(new File(["(kicad_pcb)"], "board.kicad_pcb"), {});
        const { components } = await backend.components(job.id);
        await marlinRig(backend, "\n[up_camera]\nz = -10\n", true);
        await backend.connect("/dev/ttyACM1", "openpnp-marlin");
        await backend.pnpStart();
        // Out of the picture: refused; over the camera, centered.
        await expect(backend.pnpNozzle(1)).rejects.toMatchObject({ status: 400 });
        await backend.command("G0 X150.5 Y29.8");
        await backend.pnpNozzle(1);
        for (let i = 0; i < 200 && (await backend.pnp()).routine?.state === "running"; i++) {
            backend.step(0.1);
        }
        const state = await backend.placingState();
        expect(state.camera.position).toEqual([150, 30]);
        expect(state.camera.height).toBe(-10);
        expect((await backend.pnp()).routine?.target).toBe("gcode");
        await backend.pnpReference({ job: job.id, ref: components[0]!.ref, at: [40, 30] });
        const plan = await backend.pnpPlan(job.id, [components[0]!.ref]);
        expect(plan.parts[0]!.vision).toBe(true);
        await backend.pnpRun(job.id, [components[0]!.ref]);
        runDevice(backend);
        const done = await backend.placingState();
        expect(done.progress?.state).toBe("done");
        // At the camera, down to where the nozzle is sharp, then the place
        // moved against the part's offset (0.15, -0.08), not turned here.
        const sent = done.log.filter((entry) => entry.dir === "tx").map((entry) => entry.text);
        expect(sent).toContain("G0 X150 Y30 F6000");
        expect(sent).toContain("G0 Z-10 F1200");
        expect(sent).toContain("G0 X39.85 Y30.08 A0 F6000");
        // The look's lines are counted as the backend counts them.
        expect(done.progress?.sent).toBe(done.progress?.total);
        expect(done.taken).toEqual({ "r-10k-0603": 1 });
    });
});

describe("a G-code machine on the PNP page", () => {
    test("shows its panels once connected, references the picked part, plans and runs", async () => {
        const { store, ctx, backend } = setup();
        const roots = pnpRoots();
        const job = await backend.uploadJob(new File(["(kicad_pcb)"], "board.kicad_pcb"), {});
        await marlinRig(backend);
        mountPnp(roots, ctx);
        await ctx.refreshJobs();
        await ctx.selectJob(job.id);
        await settle();
        // Connected from the top bar: the page follows the machine.
        store.set({ snapshot: await backend.connect("/dev/ttyACM1", "openpnp-marlin") });
        await ctx.refreshPlacing();
        await settle();
        expect(roots.nozzle.classList.contains("hidden")).toBe(true);
        expect(roots.camera.classList.contains("hidden")).toBe(false);
        expect(roots.head.classList.contains("hidden")).toBe(false);
        expect(roots.steps.querySelector(".roadmap-label")?.textContent).toBe("Connect");
        expect(store.get().placing?.connected).toBe(true);
        (roots.parts.querySelector("table.pnp-parts tbody tr") as HTMLElement).click();
        expect(store.get().pnpPart).not.toBeNull();
        click(roots.refs, `Nozzle here: ${store.get().pnpPart}`);
        await settle();
        await settle();
        expect(referencesOf(store.get().placing, job.id).length).toBe(1);
        click(roots.run, "Plan");
        await settle();
        expect(roots.run.querySelector(".device-program")?.textContent).toContain("M106");
        click(roots.run, "Run");
        await settle();
        await settle();
        dialogButton("Run").click();
        await settle();
        await settle();
        expect(store.get().placing?.running).toBe(true);
        runDevice(backend);
        await ctx.refreshPlacing();
        expect(store.get().placing?.progress?.state).toBe("done");
        expect(placingRunText(store.get().placing)).toContain("Done");
        expect(placingBadge(store.get().placing)).toBe("connected");
        // The page counts the setup through.
        const steps = PLACING_SETUP.steps(store.get());
        expect(steps.find((entry) => entry.label === "Place")?.done).toBe(true);
    });
});
