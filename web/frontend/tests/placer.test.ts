import { describe, expect, test } from "bun:test";

import { DEVICE_LINES_PER_SECOND, MockBackend } from "../src/mock/backend.ts";
import { MARKS_NOTE, POCKET_NOTE, blockLines, checkLines, deviceFit, planDevice, tipShift, vacuumReading } from "../src/mock/openpnp.ts";
import { TOP_TRUTH } from "../src/mock/pnp.ts";
import type { Component, PlacingPlan, PlacingState } from "../src/types.ts";
import { fiducialText, partsLeft, placingRunText, topCameraText } from "../src/views/placing.ts";
import { mountPnp } from "../src/views/pnp.ts";
import { parseDevice } from "./gcoderig.ts";
import { settle, setup, pnpRoots } from "./harness.ts";

// The backend's placer test profile, word for word, so the two plans can be compared.
function profile(gcode = "", motion = "", feeder = "", rest = ""): string {
    return `name = "rig"
[port]
url = "socket://127.0.0.1:9"
wait_ms = 0
timeout = 2
[gcode]
init = ["G21", "G90"]
${gcode}
[motion]
feed_xy = 3000
feed_z = 600
safe_z = 5
place_z = -1
pick_dwell_ms = 0
place_dwell_ms = 0
${motion}
[[feeder]]
id = "res"
match = "10k"
at = [10.0, 20.0, -2.0]
pitch = [4.0, 0.0]
count = 10
${feeder}
${rest}
`;
}

const VACUUM = '[vacuum]\nread = "M105"\npart_on = [50, 100]\npart_off = [0, 10]\n';
const TOP = '[top_camera]\nz = 0\noffset = [34.0, -9.0]\nfiducial = "bright"\nwithin = 2\n';

function part(ref: string, x: number, y: number, rotation = 0, extra: Partial<Component> = {}): Component {
    return { ref, value: "10k", footprint: "R_0603", side: "front", x, y, rotation, pads: 2, smd: true, dnp: false, ...extra };
}

describe("the twin reads the new words as the backend does", () => {
    test("a vacuum with Marlin's pattern or OpenPnP's named group", () => {
        const device = parseDevice(profile("", "", "", VACUUM), "rig");
        expect(device.vacuum?.part_on).toEqual([50, 100]);
        expect(vacuumReading(device.vacuum!, ["ok T:73.50 /0.00 B:0.00 /0.00 @:0 B@:0"])).toBe(73.5);
        expect(vacuumReading(device.vacuum!, ["ok"])).toBeNull();
        const java = parseDevice(profile("", "", "", '[vacuum]\nread = "M105"\npattern = "P:(?<Value>-?\\\\d+)"\npart_on = [1, 2]\n'), "rig");
        // Kept as the backend keeps it, read as the backend reads it.
        expect(java.vacuum?.pattern).toBe("P:(?P<Value>-?\\d+)");
        expect(vacuumReading(java.vacuum!, ["echo: T:5 P:42"])).toBe(42);
    });

    test("a sensor without ranges reads over several lines and checks nothing", () => {
        const rest = '[vacuum]\nread = ["M260 A112 B1 S1", "M260 A109 B6 S1", "M261 A109 B1 S2"]\npattern = "^.*data:(?<Value>.*)"\n';
        const device = parseDevice(profile("", "", "", rest), "rig");
        expect(device.vacuum?.read.at(-1)).toBe("M261 A109 B1 S2");
        expect(device.vacuum?.part_on).toBeNull();
        expect(vacuumReading(device.vacuum!, ["echo:i2c-reply: from:109 bytes:1 data:231", "ok"])).toBe(231);
        expect(checkLines(device, true)).toEqual([]);
    });

    test("a new word that does not read names its key", () => {
        const cases: [string, string][] = [
            [profile("", "", "", "[vacuum]\npart_on = [1, 2]\n"), "[vacuum] read must name the line, or lines, that read the vacuum sensor"],
            [profile("", "", "", '[vacuum]\nread = "M105"\npattern = "T:[0-9]+"\npart_on = [1, 2]\n'), "[vacuum] pattern must hold a group"],
            [profile("", "", "", '[vacuum]\nread = "M105"\npart_on = [9, 2]\n'), "must be the low reading, then the high one"],
            [profile("", "", 'pocket = "bright"'), "[feeder 1] pocket looks with the top camera: add a [top_camera] table"],
            [profile("", "", "marks = [[1, 2], [3, 4], [5, 6]]", TOP), "[feeder 1] marks must be a list of at most 2 places"],
            [profile("", "", "size = [1.6, -1]"), "[feeder 1] size must be a length and a width over 0"],
            [profile("", "", 'pocket = "grey"', TOP), "[feeder 1] pocket must be dark or bright"],
            [profile("", "pick_tries = 0"), "[motion] pick_tries must be a whole number from 1 to 20"],
            [profile("", "", "", '[top_camera]\nfiducial = "red"\n'), "[top_camera] fiducial must be dark or bright"],
        ];
        for (const [text, words] of cases) {
            expect(() => parseDevice(text, "rig")).toThrow(words);
        }
    });

    test("the plan reads the vacuum, turns the other way and keeps the tip on the place, line for line", () => {
        const fit = deviceFit([[[0, 0], [100, 50]]], 90);
        const parts = [part("R1", 1, 0), part("FID1", 0, 0, 0, { fiducial: true })];
        const device = parseDevice(profile("rotation_cw = true", "", "", VACUUM), "rig");
        const plan = planDevice(device, parts, fit, {}, null, "", false, [0.1, 0]);
        const [r1] = plan.blocks;
        expect(plan.skipped).toEqual([]);
        expect(r1!.check).toEqual(["M400", "M105 ; vacuum: a part held reads 50 to 100"]);
        expect(r1!.release).toEqual(["M400", "M105 ; vacuum: an empty nozzle reads 0 to 10"]);
        expect(r1!.pick).toContain("G0 X10 Y20 A0 F3000");
        expect(r1!.place[0]).toBe("G0 X100.1 Y50.9 A-90 F3000");
        const [sx, sy] = tipShift([0.1, 0], 90);
        expect(sx).toBeCloseTo(0.1, 9);
        expect(sy).toBeCloseTo(-0.1, 9);
        expect(blockLines(r1!)).toContain("M105 ; vacuum: a part held reads 50 to 100");
        const asked = planDevice(device, parts, fit, {}, ["FID1"], "");
        expect(asked.blocks).toEqual([]);
        expect(asked.skipped).toEqual([{ ref: "FID1", reason: "a fiducial, not a part" }]);
    });

    test("the plan says where the top camera looks first", () => {
        const device = parseDevice(profile("", "", 'pocket = "bright"\nmarks = [[8.0, 18.0]]', TOP), "rig");
        const plan = planDevice(device, [part("R1", 1, 0), part("R2", 2, 0)], deviceFit([[[0, 0], [100, 50]]], 0), {}, null, "");
        const [first, second] = plan.blocks;
        expect(first!.pick.slice(0, 3)).toEqual(["; R1 10k from res #1", MARKS_NOTE, POCKET_NOTE]);
        expect(second!.pick[1]).toBe(POCKET_NOTE);
    });
});

function runDevice(backend: MockBackend): void {
    for (let i = 0; i < 4000 && backend["deviceSession"] !== null; i++) {
        backend.step(1 / DEVICE_LINES_PER_SECOND);
    }
}

async function routines(backend: MockBackend): Promise<void> {
    for (let i = 0; i < 400; i++) {
        const device = await backend.placingState();
        if ((await backend.pnp()).routine?.state !== "running" && device.top?.routine?.state !== "running") {
            return;
        }
        backend.step(0.1);
    }
}

describe("the cameras and the vacuum on the mock's G-code machine", () => {
    test("runout, the top camera's offset, the fiducials, then a run that finds them first and reads the vacuum", async () => {
        const backend = new MockBackend({ timers: false });
        const job = await backend.uploadJob(new File(["(kicad_pcb)"], "board.kicad_pcb"), {});
        const { components } = await backend.components(job.id);
        const fiducials = components.filter((entry) => entry.fiducial);
        expect(fiducials.map((entry) => entry.ref)).toEqual(["FID1", "FID2"]);
        const file = await backend.machineFile("openpnp-marlin");
        const text = file.text
            .replace('match = "10k 0603"', 'match = "TestPoint"\nvision = true')
            + `\n[up_camera]\nz = -10\n${VACUUM}${TOP}`;
        await backend.saveMachineFile("openpnp-marlin", text);
        await backend.connect("/dev/ttyACM1", "openpnp-marlin");
        await backend.pnpStart();
        // Runout needs the nozzle centered first.
        await expect(backend.pnpRunout()).rejects.toMatchObject({ status: 400 });
        await backend.command("G0 X150.5 Y29.8");
        await backend.pnpNozzle(1);
        await routines(backend);
        await backend.pnpRunout();
        await routines(backend);
        const measured = await backend.placingState();
        expect(measured.camera.runout).not.toBeNull();
        expect((await backend.pnp()).routine?.kind).toBe("runout");
        // The top camera: started, the nozzle on the mark, its offset measured.
        await expect(backend.topOffset(2)).rejects.toMatchObject({ status: 400 });
        await backend.topStart();
        await backend.command("G0 X120 Y80");
        expect((await backend.topMark()).top?.mark_at).toEqual([120, 80]);
        await backend.topOffset(2);
        await routines(backend);
        const top = (await backend.placingState()).top!;
        expect(top.offset).toEqual(TOP_TRUTH.offset);
        expect(topCameraText(top)).toContain("Top camera looks from X 35.000 Y -10.000");
        // Home by fiducial needs the file's fiducial; with one, it homes and declares the place.
        await expect(backend.topHome()).rejects.toMatchObject({ status: 400 });
        await backend.saveMachineFile("openpnp-marlin", text.replace("within = 2\n", "within = 2\nhome_fiducial = [60.0, 170.0]\n"));
        await backend.topHome();
        await routines(backend);
        const homed = (await backend.placingState()).log.filter((entry) => entry.dir === "tx").map((entry) => entry.text);
        expect(homed.slice(-3)).toEqual(["G28", "G0 X25 Y180 F6000", "G92 X25.2 Y179.85"]);
        // A rough reference, then the fiducials found and kept in its place.
        await backend.pnpReference({ job: job.id, ref: components[0]!.ref, at: [40, 30] });
        await backend.pnpFiducials(job.id);
        await routines(backend);
        const found = await backend.placingState();
        expect(found.references.filter((entry) => entry.by === "fiducial").map((entry) => entry.ref)).toEqual(["FID1", "FID2"]);
        expect(fiducialText(found.top, job.id)).toContain("Fiducials FID1, FID2 found");
        // Camera here: the reference is under the camera's crosshair.
        await backend.command("G0 X10 Y10");
        const here = await backend.pnpReference({ job: job.id, ref: components[1]!.ref, camera: true });
        expect(here.references.find((entry) => entry.ref === components[1]!.ref)).toMatchObject({ at: [45, 0], by: "camera" });
        // A run that finds the fiducials first, reads the vacuum, and looks at its part.
        const started = await backend.pnpRun(job.id, [components[0]!.ref], true);
        expect(started.parts.length).toBe(1);
        runDevice(backend);
        const done = await backend.placingState();
        expect(done.progress?.state).toBe("done");
        expect(done.progress?.job).toBe(job.id);
        expect(done.progress?.sent).toBe(done.progress?.total);
        const sent = done.log.filter((entry) => entry.dir === "tx").map((entry) => entry.text);
        expect(sent.filter((line) => line === "M105").length).toBe(2);
        expect(done.log.some((entry) => entry.dir === "rx" && entry.text.startsWith("ok T:75.00"))).toBe(true);
        // A run asked to find fiducials needs the top camera running.
        await backend.topStop();
        await expect(backend.pnpRun(job.id, [components[1]!.ref], true)).rejects.toMatchObject({ status: 400 });
    });
});

describe("the placing panels' words", () => {
    test("say what a run left out, and which parts are left to run", () => {
        const plan: PlacingPlan = { parts: [{ ref: "R1", feeder: "res", index: 0, vision: false }, { ref: "R2", feeder: "res", index: 1, vision: false }], skipped: [], fit: { rotation: 0, shift: [0, 0], scale: 1, rms: 0, residuals: [], marks: 1 }, lines: 9, text: "" };
        const device = {
            progress: { state: "done", sent: 20, total: 20, part: null, placed: ["R1"], failed: [{ ref: "R2", reason: "the vacuum read 20" }], doing: null, job: "j1", error: null, seconds: 3 },
        } as unknown as PlacingState;
        expect(placingRunText(device)).toBe("Done: 20 of 20 lines, 1 parts placed, 1 left out in 3 s.");
        expect(partsLeft(device, plan, "j1")).toEqual(["R2"]);
        expect(partsLeft(device, plan, "j2")).toEqual([]);
        expect(topCameraText(null)).toContain("not measured");
    });

    test("the top camera's controls show on the PNP page", async () => {
        const { store, ctx, backend } = setup();
        const roots = pnpRoots();
        await backend.uploadJob(new File(["(kicad_pcb)"], "board.kicad_pcb"), {});
        mountPnp(roots, ctx);
        await ctx.refreshJobs();
        // The top camera's settings are kept for the G-code machine placed with.
        store.set({ snapshot: await backend.connect("/dev/ttyACM1", "openpnp-marlin") });
        await ctx.refreshPlacing();
        await settle();
        expect(roots.top.classList.contains("hidden")).toBe(false);
        expect(roots.top.textContent).toContain("Top camera");
        expect(roots.top.textContent).toContain("Nozzle on mark");
        const all = (): HTMLButtonElement[] => Object.values(roots).flatMap((root) => Array.from(root.querySelectorAll("button")));
        for (const label of ["Measure runout", "Measure offset", "Camera here", "Find fiducials", "Run the rest", "Nozzle over camera", "Camera to nozzle spot"]) {
            expect(all().some((each) => each.textContent === label)).toBe(true);
        }
        // Started from the panel, with the camera's device typed in sent first.
        const deviceField = roots.top.querySelector('input[aria-label="Top camera device"]') as HTMLInputElement;
        deviceField.value = "/dev/video6";
        deviceField.dispatchEvent(new Event("input"));
        const start = Array.from(roots.top.querySelectorAll("button")).filter((each) => each.textContent === "Start").pop()!;
        start.click();
        await settle();
        await settle();
        expect(store.get().placing?.top?.running).toBe(true);
        expect(store.get().placing?.top?.device).toBe("/dev/video6");
    });
});
