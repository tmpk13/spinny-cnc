import { describe, expect, test } from "bun:test";

import fixture from "../../../toolpath/tests/data/default-controls.json" with { type: "json" };
import { MockBackend } from "../src/mock/backend.ts";
import { CAMERA_DEFAULTS, DEFAULT_SETTINGS, parseMachine } from "../src/mock/machines.ts";
import type { Controls } from "../src/types.ts";

const DISPENSER = `
name = "Paste dispenser"
kinematics = "cartesian"
tool = "dispenser"

[rail]
steps_per_mm = 800

[dispenser]
steps_per_mm = 1600
max_rate = 300
jog_rate = 60
microsteps = 16

[focus]
fitted = true

[host]
gap = 0.15
retract = 0.3
output = 120
extrude_rate = 80
dwell_ms = 250

[camera]
device = "socket://pi:9000"
size = "1920x1080"
fps = 25
side = "back"
finish = "bare"
offset = [12.5, -3.2]
roll = 0.4
mm_per_px = 0.021
`;

describe("machine files with a dispenser and a camera", () => {
    test("a dispenser file reads onto the table's settings in mm, with the plunger's controls and the camera", () => {
        const doc = parseMachine(DISPENSER, "paste");
        expect(doc.tool).toBe("dispenser");
        expect(doc.kinematics).toBe("cartesian");
        expect(doc.focus).toBe(true);
        expect(doc.settings["dispenser"]).toBe(1);
        expect(doc.settings["cartesian"]).toBe(1);
        expect(doc.settings["spindle"]).toBe(0);
        expect(doc.settings["a_steps"]).toBe(1600);
        expect(doc.settings["a_rate"]).toBe(300);
        expect(doc.settings["jog_a"]).toBe(60);
        expect(doc.settings["tmc_a_micro"]).toBe(16);
        expect(doc.settings["r_steps"]).toBe(800);
        expect(doc.host).toEqual({ gap: 0.15, retract: 0.3, output: 120, extrude_rate: 80, dwell_ms: 250 });
        expect(doc.camera).toEqual({ device: "socket://pi:9000", size: "1920x1080", fps: 25, pcbv: "pcbv", side: "back", finish: "bare", offset: [12.5, -3.2], roll: 0.4, mm_per_px: 0.021 });
        expect(doc.controls).toEqual((fixture as unknown as Record<string, Controls>)["cartesian-dispenser-focus"]!);
        expect(Object.keys(DEFAULT_SETTINGS)).toHaveLength(75);
        expect(Object.keys(DEFAULT_SETTINGS).at(-1)).toBe("dispenser");
        expect(parseMachine('name = "x"', "x").camera).toEqual(CAMERA_DEFAULTS);
        expect(parseMachine('name = "x"', "x").settings["dispenser"]).toBe(0);
    });

    test("refuses what the backend refuses, in its words", () => {
        const refused = (text: string, message: string): void => {
            expect(() => parseMachine(text, "f")).toThrow(message);
        };
        refused('tool = "dispenser"', "f.toml: tool = dispenser needs kinematics = cartesian");
        refused('kinematics = "cartesian"\n[dispenser]\nsteps_per_mm = 1600', "f.toml: [dispenser] needs tool = dispenser");
        refused('kinematics = "cartesian"\ntool = "dispenser"\n[table]\nsteps_per_deg = 10\n[dispenser]\nsteps_per_mm = 1600', "f.toml: [table] and [dispenser] cannot both be given: the dispenser is the table's driver");
        refused('tool = "drill"', "f.toml: tool must be one of laser, spindle, dispenser");
        refused('kinematics = "cartesian"\ntool = "dispenser"\n[dispenser]\nsteps_per_mm = 0', "f.toml: [dispenser] steps_per_mm must be above 0 and at most 10000000");
        refused('kinematics = "cartesian"\ntool = "dispenser"\n[dispenser]\nsteps_per_deg = 10', "f.toml: [dispenser] steps_per_deg is not a key here");
        refused("[host]\ngap = 0", "f.toml: [host] gap must be above 0 and at most 10");
        refused("[host]\nretract = 60", "f.toml: [host] retract must be 0 to 50");
        refused("[host]\noutput = 0", "f.toml: [host] output must be above 0 and at most 100000");
        refused("[host]\nextrude_rate = 20000", "f.toml: [host] extrude_rate must be above 0 and at most 10000");
        refused("[host]\ndwell_ms = 1.5", "f.toml: [host] dwell_ms must be a whole number");
        refused("[host]\ndwell_ms = 70000", "f.toml: [host] dwell_ms must be 0 to 60000");
        refused("[host]\nspinup = -1", "f.toml: [host] spinup must be above 0 and at most 600");
        refused('[camera]\nsize = "big"', "f.toml: [camera] size must be WIDTHxHEIGHT");
        refused("[camera]\nfps = 0", "f.toml: [camera] fps must be 1 to 120");
        refused('[camera]\nside = "left"', "f.toml: [camera] side must be one of front, back");
        refused('[camera]\nfinish = "shiny"', "f.toml: [camera] finish must be one of masked, bare");
        refused("[camera]\noffset = [2000, 0]", "f.toml: [camera] offset must be two numbers within 1000 mm");
        refused("[camera]\nroll = 400", "f.toml: [camera] roll must be a number within 360");
        refused("[camera]\nmm_per_px = -1", "f.toml: [camera] mm_per_px must be 0 or more and at most 10000000");
        refused('[camera]\ndevice = ""', "f.toml: [camera] device must be text");
        refused("[camera]\nzoom = 2", "f.toml: [camera] zoom is not a key here");
    });

    test("the mock checks and loads such a file, the load setting the host's values and the camera", async () => {
        const backend = new MockBackend({ timers: false });
        await backend.connect("/dev/ttyACM0");
        const checked = await backend.checkMachineFile("paste", DISPENSER);
        expect(checked.problems).toEqual([]);
        expect(checked.document?.camera.device).toBe("socket://pi:9000");
        const broken = await backend.checkMachineFile("paste", DISPENSER.replace('side = "back"', 'side = "left"'));
        expect(broken.document).toBeNull();
        expect(broken.problems).toEqual(["paste.toml: [camera] side must be one of front, back"]);
        await backend.saveMachineFile("paste", DISPENSER);
        const applied = await backend.applyMachine("paste");
        expect(applied.host).toMatchObject({ gap: 0.15, retract: 0.3, output: 120, extrude_rate: 80, dwell_ms: 250 });
        expect(applied.values["dispenser"]).toBe(1);
        expect(applied.machine).toBe("paste");
        expect((await backend.state()).profile).toMatchObject({ kinematics: "cartesian", tool: "dispenser", h_axis: true });
        expect(await backend.camera()).toMatchObject({ device: "socket://pi:9000", size: "1920x1080", fps: 25, offset: [12.5, -3.2], roll: 0.4, mm_per_px: 0.021 });
        expect((await backend.machines()).machines.find((entry) => entry.id === "paste")?.tool).toBe("dispenser");
    });
});
