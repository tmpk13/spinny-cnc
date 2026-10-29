import { describe, expect, test } from "bun:test";

import { DEVICE_LINES_PER_SECOND, MockBackend } from "../src/mock/backend.ts";
import { deviceFit, parseDevice, planDevice, planSummary } from "../src/mock/openpnp.ts";
import type { Component } from "../src/types.ts";
import { DEVICE_SETUP, deviceBadge, deviceRunText, referencesOf } from "../src/views/device.ts";
import { mountPnp } from "../src/views/pnp.ts";
import { click, dialogButton, settle, setup } from "./harness.ts";

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

describe("the mock's G-code device twin", () => {
    test("a profile that does not read names the key as the backend does", () => {
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
        expect(plan.blocks[0]!.lines).toEqual([
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
        const c1 = plan.blocks[1]!.lines;
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

describe("the G-code device in the mock", () => {
    test("is picked, connected, referenced, planned and sent, and counts its feeders", async () => {
        const backend = new MockBackend({ timers: false });
        const job = await backend.uploadJob(new File(["(kicad_pcb)"], "board.kicad_pcb"), {});
        const { components } = await backend.components(job.id);
        await expect(backend.deviceConnect()).rejects.toMatchObject({ status: 400 });
        await backend.deviceSelect({ profile: "openpnp-marlin" });
        // The shipped profile names no port.
        await expect(backend.deviceConnect()).rejects.toMatchObject({ status: 502 });
        const file = await backend.deviceFile("openpnp-marlin");
        const text = file.text.replace('url = ""', 'url = "/dev/ttyACM1"').replace('match = "10k 0603"', 'match = "TestPoint"').replace("count = 50", "count = 2");
        await backend.saveDeviceFile("openpnp-marlin", text);
        expect((await backend.deviceConnect()).connected).toBe(true);
        await expect(backend.devicePlan(job.id)).rejects.toMatchObject({ status: 400 });
        await backend.deviceCommand("G0 X40 Y30");
        const referenced = await backend.deviceReference({ job: job.id, ref: components[0]!.ref });
        expect(referenced.references).toEqual([{ job: job.id, ref: components[0]!.ref, at: [40, 30] }]);
        const plan = await backend.devicePlan(job.id);
        // Three test points, a strip of two.
        expect(plan.parts.length).toBe(2);
        expect(plan.skipped).toEqual([{ ref: components[2]!.ref, reason: "feeder r-10k-0603 is empty" }]);
        expect(backend.deviceProgramUrl(job.id).startsWith("data:text/plain")).toBe(true);
        await backend.deviceRun(job.id);
        await expect(backend.deviceHome()).rejects.toMatchObject({ status: 409 });
        runDevice(backend);
        const state = await backend.deviceState();
        expect(state.progress?.state).toBe("done");
        expect(state.progress?.placed).toEqual(plan.parts.map((entry) => entry.ref));
        expect(state.taken).toEqual({ "r-10k-0603": 2 });
        expect(state.log.some((entry) => entry.text === "M106")).toBe(true);
        expect((await backend.deviceResetFeeders()).taken).toEqual({});
        await backend.deviceGoto(job.id, components[1]!.ref);
        expect(state.running).toBe(false);
        expect((await backend.deviceDisconnect()).connected).toBe(false);
    });
});

describe("the G-code device on the PNP page", () => {
    test("takes the camera's and nozzle's place, references the picked part, plans and runs", async () => {
        const { store, ctx, backend } = setup();
        const roots = {
            steps: document.createElement("section"),
            parts: document.createElement("section"),
            board: document.createElement("section"),
            camera: document.createElement("section"),
            nozzle: document.createElement("section"),
            device: document.createElement("section"),
        };
        for (const root of Object.values(roots)) {
            document.body.append(root);
        }
        const job = await backend.uploadJob(new File(["(kicad_pcb)"], "board.kicad_pcb"), {});
        const file = await backend.deviceFile("openpnp-marlin");
        await backend.saveDeviceFile("openpnp-marlin", file.text.replace('url = ""', 'url = "/dev/ttyACM1"').replace('match = "10k 0603"', 'match = "TestPoint"'));
        mountPnp(roots, ctx);
        await ctx.refreshJobs();
        await ctx.refreshDevice();
        await ctx.selectJob(job.id);
        await settle();
        const placeWith = roots.parts.querySelector('select[aria-label="Place with"]') as HTMLSelectElement;
        placeWith.value = "device";
        placeWith.dispatchEvent(new Event("change"));
        expect(store.get().pnpTarget).toBe("device");
        expect(roots.camera.classList.contains("hidden")).toBe(true);
        expect(roots.device.classList.contains("hidden")).toBe(false);
        expect(roots.steps.querySelector(".roadmap-label")?.textContent).toBe("Profile");
        const profile = roots.device.querySelector('select[aria-label="Device profile"]') as HTMLSelectElement;
        profile.value = "openpnp-marlin";
        profile.dispatchEvent(new Event("change"));
        await settle();
        await settle();
        expect(store.get().device?.profile).toBe("openpnp-marlin");
        click(roots.device, "Connect");
        await settle();
        expect(store.get().device?.connected).toBe(true);
        (roots.parts.querySelector("table.pnp-parts tbody tr") as HTMLElement).click();
        expect(store.get().pnpPart).not.toBeNull();
        click(roots.device, `Here: ${store.get().pnpPart}`);
        await settle();
        await settle();
        expect(referencesOf(store.get().device, job.id).length).toBe(1);
        click(roots.device, "Plan");
        await settle();
        expect(roots.device.querySelector(".device-program")?.textContent).toContain("M106");
        click(roots.device, "Run");
        await settle();
        await settle();
        dialogButton("Run").click();
        await settle();
        await settle();
        expect(store.get().device?.running).toBe(true);
        runDevice(backend);
        await ctx.refreshDevice();
        expect(store.get().device?.progress?.state).toBe("done");
        expect(deviceRunText(store.get().device)).toContain("Done");
        expect(deviceBadge(store.get().device)).toBe("connected");
        // The page counts the setup through.
        const steps = DEVICE_SETUP.steps(store.get());
        expect(steps.find((entry) => entry.label === "Place")?.done).toBe(true);
        // The pick is remembered in storage the other test files share.
        localStorage.removeItem("spinny.pnp.target");
    });
});
