import { describe, expect, test } from "bun:test";

import { MockBackend } from "../src/mock/backend.ts";
import { gcodeMachineOf } from "../src/mock/machines.ts";
import lumenText from "../../../machines/opulo-lumen-rev5.toml" with { type: "text" };
import { connectGcode, gcodeFile } from "./gcoderig.ts";

// The backend's test machine (web/backend/tests/test_gcode_machine.py): the
// mock must send the same lines for the same asks.
const PROFILE = `name = "rig"
[port]
url = "socket://127.0.0.1:9"
wait_ms = 0
timeout = 2
[gcode]
init = ["G21", "G90"]
pick = ["M106 P1 S180", "M106"]
place = ["M107 P1", "M107"]
light_on = "M150 P255"
light_off = "M150 P0"
[motion]
feed_xy = 3000
feed_z = 600
safe_z = 5
place_z = -1
pick_dwell_ms = 0
place_dwell_ms = 0
park = [40.0, 400.0]
[vacuum]
read = ["M260 A112 B1 S1", "M105"]
[camera]
position = [60.0, 200.0]
z = -4
[top_camera]
offset = [20.0, 60.0]
[[feeder]]
id = "res"
match = "10k"
at = [10.0, 20.0, -2.0]
pitch = [4.0, 0.0]
count = 10
`;

async function rig(): Promise<MockBackend> {
    const mock = new MockBackend();
    await connectGcode(mock, "rig", PROFILE);
    // The backend's fake machine starts at X100 Y50 Z0.
    await mock.command("G0 X100 Y50 Z0");
    return mock;
}

/** The lines the mock machine was sent since `since` lines of its log. */
function sentSince(mock: MockBackend, since: number): Promise<string[]> {
    return mock.placingState().then((state) => state.log.filter((entry) => entry.dir === "tx").map((entry) => entry.text).slice(since));
}

async function txCount(mock: MockBackend): Promise<number> {
    return (await mock.placingState()).log.filter((entry) => entry.dir === "tx").length;
}

describe("a G-code machine used like the other machines, in the mock", () => {
    test("the LumenPnP file reads, and its port is found by its USB name", async () => {
        const lumen = gcodeMachineOf(lumenText, "opulo-lumen-rev5");
        // The operator calibrates this file (the cameras' places, the top
        // camera's offset): its numbers are checked against what the file
        // itself says, so a new calibration is not a failure here.
        const file = Bun.TOML.parse(lumenText) as {
            port: { match: string[] };
            gcode: { pick: string[] };
            motion: { safe_z: number };
            up_camera: { position: [number, number] };
            top_camera: {
                offset: [number, number];
                home_fiducial: [number, number];
                roll: number;
                mm_per_px: number;
                bed: [number, number, number, number];
            };
        };
        expect(lumen.safe_z).toBe(file.motion.safe_z);
        expect(lumen.pick).toEqual(file.gcode.pick);
        expect(lumen.camera_position).toEqual(file.up_camera.position);
        expect(lumen.top?.offset).toEqual(file.top_camera.offset);
        expect(lumen.top?.home_fiducial).toEqual(file.top_camera.home_fiducial);
        const top = file.top_camera;
        expect([lumen.top?.roll, lumen.top?.mm_per_px, lumen.top?.bed]).toEqual([top.roll, top.mm_per_px, top.bed]);
        expect(lumen.match).toEqual(file.port.match);
        const ports = await new MockBackend().ports();
        expect(ports.find((port) => port.device === "/dev/ttyACM1")?.machine).toBe("opulo-lumen-rev5");
        expect(ports.find((port) => port.device === "/dev/ttyACM0")?.machine).toBeNull();
    });

    test("the file's bottom camera roll and mirror stand until centering measures them, as the backend's", async () => {
        const mock = new MockBackend();
        await connectGcode(mock, "rig", PROFILE.replace("z = -4\n", "z = -4\nroll = 90\nmirror = false\n"));
        const state = await mock.placingState();
        expect(state.document?.camera_roll).toBe(90);
        expect(state.document?.camera_mirror).toBe(false);
        expect(state.camera.roll).toBe(90);
        expect(state.camera.mirror).toBe(false);
        // A file without them: a camera looking up, mirrored, at roll 0.
        const plain = gcodeMachineOf(gcodeFile(PROFILE), "rig");
        expect(plain.camera_roll).toBeNull();
        expect(plain.camera_mirror).toBeNull();
        expect((await (async () => {
            const other = new MockBackend();
            await connectGcode(other, "rig", PROFILE);
            return other.placingState();
        })()).camera.mirror).toBe(true);
        expect(() => gcodeMachineOf(gcodeFile(PROFILE.replace("z = -4\n", "z = -4\nroll = 400\n")), "rig")).toThrow("[up_camera] roll must be a number from -360 to 360");
    });

    test("the file's camera settings go into the cameras as the machine connects, as the backend's", async () => {
        const mock = new MockBackend();
        await mock.pnpSettings({ device: "/dev/video7", fps: 15 });
        const text = PROFILE
            .replace("z = -4\n", 'z = -4\ndevice = "http://127.0.0.1:2328/snapshot"\nsize = "640x480"\nnozzle_spot = "bright"\n')
            .replace("offset = [20.0, 60.0]\n", 'offset = [20.0, 60.0]\ndevice = "http://127.0.0.1:2329/snapshot"\nsize = "640x480"\nmark_spot = "bright"\n');
        await connectGcode(mock, "rig", text);
        const state = await mock.placingState();
        expect(state.document?.camera_settings).toEqual({ device: "http://127.0.0.1:2328/snapshot", size: "640x480", nozzle_spot: "bright" });
        expect(state.document?.top?.settings).toEqual({ device: "http://127.0.0.1:2329/snapshot", size: "640x480", mark_spot: "bright" });
        expect([state.top?.device, state.top?.size, state.top?.mark_spot]).toEqual(["http://127.0.0.1:2329/snapshot", "640x480", "bright"]);
        const bottom = await mock.pnp();
        expect([bottom.device, bottom.size, bottom.nozzle_spot, bottom.fps]).toEqual(["http://127.0.0.1:2328/snapshot", "640x480", "bright", 15]);
        // Each key is checked as the backend checks it.
        expect(() => gcodeMachineOf(gcodeFile(PROFILE.replace("z = -4\n", 'z = -4\nsize = "big"\n')), "rig")).toThrow("[up_camera] size must be WIDTHxHEIGHT");
        expect(() => gcodeMachineOf(gcodeFile(PROFILE.replace("z = -4\n", "z = -4\nfps = 500\n")), "rig")).toThrow("[up_camera] fps must be a whole number from 1 to 120");
        expect(() => gcodeMachineOf(gcodeFile(PROFILE.replace("offset = [20.0, 60.0]\n", 'offset = [20.0, 60.0]\ndevice = ""\n')), "rig")).toThrow("[top_camera] device must name it");
    });

    test("a jog moves an axis from where the controller says it is", async () => {
        const mock = await rig();
        let start = await txCount(mock);
        await mock.jog({ kind: "joint", dr: 1.5 });
        expect(await sentSince(mock, start)).toEqual(["M114", "G0 X101.5 F3000"]);
        start = await txCount(mock);
        await mock.jog({ kind: "joint", dh: -0.5 });
        expect(await sentSince(mock, start)).toEqual(["M114", "G0 Z-0.5 F600"]);
        start = await txCount(mock);
        await mock.jog({ kind: "board", dx: 1, dy: -2, feed: 1200 });
        expect(await sentSince(mock, start)).toEqual(["M114", "G0 X102.5 Y48 F1200"]);
        start = await txCount(mock);
        await mock.jog({ kind: "joint", dh: 0.5, feed: 120 });
        expect(await sentSince(mock, start)).toEqual(["M114", "G0 Z0 F120"]);
        start = await txCount(mock);
        await mock.jog({ kind: "joint", da: 15 });
        expect(await sentSince(mock, start)).toEqual(["M114", "G0 A15 F3000"]);
        await expect(mock.jog({ kind: "joint", dz: 0 })).rejects.toThrow("at least one axis");
    });

    test("a jog leaving the up camera goes up first when the file asks, as the backend's", async () => {
        const mock = new MockBackend();
        await connectGcode(mock, "rig", PROFILE.replace("z = -4\n", "z = -4\nleave = 3\n"));
        await mock.command("G0 X60 Y200 Z-4");
        let start = await txCount(mock);
        await mock.jog({ kind: "joint", dr: 1 });
        expect(await sentSince(mock, start)).toEqual(["M114", "G0 X61 F3000"]);
        start = await txCount(mock);
        await mock.jog({ kind: "joint", dr: 5 });
        expect(await sentSince(mock, start)).toEqual(["M114", "G0 Z5 F600", "G0 X66 F3000"]);
        await mock.jog({ kind: "joint", dh: -2 });
        start = await txCount(mock);
        await mock.jog({ kind: "joint", dr: 5 });
        expect(await sentSince(mock, start)).toEqual(["M114", "G0 X71 F3000"]);
    });

    test("a goto rises only to go across and puts the height last, and parks", async () => {
        const mock = await rig();
        let start = await txCount(mock);
        await mock.goto({ kind: "joint", r: 30, z: 40, h: -1 });
        expect(await sentSince(mock, start)).toEqual(["M114", "G0 Z5 F600", "G0 X30 Y40 F3000", "G0 Z-1 F600", "M400", "M114"]);
        start = await txCount(mock);
        await mock.goto({ kind: "joint", r: 30, h: -2 });
        expect(await sentSince(mock, start)).toEqual(["M114", "G0 Z-2 F600", "M400", "M114"]);
        start = await txCount(mock);
        await mock.goto({ kind: "board", y: 45 });
        expect(await sentSince(mock, start)).toEqual(["M114", "G0 Z5 F600", "G0 Y45 F3000", "M400", "M114"]);
        expect((await mock.state()).machine?.joint).toEqual({ r: 30, a: 0, z: 45, h: 5 });
        start = await txCount(mock);
        await mock.pnpPark();
        expect(await sentSince(mock, start)).toEqual(["M114", "G0 X40 Y400 F3000", "M400", "M114"]);
    });

    test("a position is declared, the machine homed and stopped", async () => {
        const mock = await rig();
        let start = await txCount(mock);
        await mock.setPosition({ r: 0, z: 0 });
        expect(await sentSince(mock, start)).toEqual(["G92 X0 Y0", "M114"]);
        start = await txCount(mock);
        await mock.home();
        expect(await sentSince(mock, start)).toEqual(["G28", "M114"]);
        expect((await mock.placingState()).homed).toBe(true);
        start = await txCount(mock);
        await mock.realtime("reset");
        expect(await sentSince(mock, start)).toEqual(["M410"]);
        start = await txCount(mock);
        await mock.motors(false);
        expect(await sentSince(mock, start)).toEqual(["M18"]);
        expect((await mock.state()).machine?.enabled).toBe(false);
    });

    test("the nozzle goes over the bottom camera with the lights on, and the tools swap over a point", async () => {
        const mock = await rig();
        let start = await txCount(mock);
        const state = await mock.pnpOverCamera();
        expect(await sentSince(mock, start)).toEqual(["M114", "M150 P255", "G0 Z5 F600", "G0 X60 Y200 A0 F3000", "G0 Z-4 F600", "M400", "M114"]);
        expect(state.light).toBe(true);
        expect(state.camera.position).toEqual([60, 200]);
        expect(state.camera.measured).toBe(false);
        await mock.goto({ kind: "joint", r: 100, z: 50 });
        start = await txCount(mock);
        await mock.pnpSwap("nozzle");
        expect(await sentSince(mock, start)).toEqual(["M114", "G0 X120 Y110 F3000", "M400", "M114"]);
    });

    test("the bottom camera's place is set by hand and forgotten back to the file's", async () => {
        const mock = await rig();
        await mock.goto({ kind: "joint", r: 61, z: 201 });
        expect((await mock.pnpCameraPlace({ here: true })).camera.position).toEqual([61, 201]);
        expect((await mock.pnpCameraPlace({ position: [62.5, 199] })).camera.position).toEqual([62.5, 199]);
        expect((await mock.pnpCameraPlace({ clear: true })).camera.position).toEqual([60, 200]);
    });

    test("the lights and the vacuum switch, and the sensor reads", async () => {
        const mock = await rig();
        const start = await txCount(mock);
        expect((await mock.pnpLight(false)).light).toBe(false);
        const answer = await mock.pnpVacuum({ on: true, read: true });
        expect(await sentSince(mock, start)).toEqual(["M150 P0", "M106 P1 S180", "M106", "M260 A112 B1 S1", "M105"]);
        expect(answer.vacuum?.on).toBe(true);
        expect(answer.vacuum?.reading).toBe(230.5);
    });

    test("a file value is changed in its text and a missing table added; the file is no board's", async () => {
        const mock = new MockBackend();
        await mock.saveMachineFile("rig", gcodeFile(PROFILE));
        const file = await mock.patchMachineFile("rig", ["motion", "place_z"], -1.5);
        expect(file.document?.gcode?.place_z).toBe(-1.5);
        expect(file.text).toContain("place_z = -1.5");
        await expect(mock.patchMachineFile("rig", ["motion", "pick_tries"], 0)).rejects.toThrow("pick_tries");
        const lumen = await mock.patchMachineFile("opulo-lumen-rev5", ["vacuum", "part_on"], [220, 241]);
        expect(lumen.document?.gcode?.vacuum?.part_on).toEqual([220, 241]);
        await expect(mock.applyMachine("rig")).rejects.toThrow("G-code machine");
        await connectGcode(mock, "rig");
        await expect(mock.deleteMachineFile("rig")).rejects.toThrow("disconnect");
    });
});

// The backend's web/backend/tests/test_gcode_skew.py: a file whose axes are
// out of square sends the same lines for the same asks.
describe("a G-code machine whose axes are out of square, in the mock", () => {
    const SKEWED = PROFILE.replace("park = [40.0, 400.0]\n", "park = [40.0, 400.0]\nskew = 0.0023\n");

    async function skewed(text = SKEWED): Promise<MockBackend> {
        const mock = new MockBackend();
        await connectGcode(mock, "rig", text);
        // The controller's numbers that put the nozzle at X 100 Y 200, Z at the safe height.
        await mock.command("G0 X99.54 Y200 Z5");
        return mock;
    }

    test("a skew the file gets wrong is refused with the key", () => {
        expect(() => gcodeMachineOf(gcodeFile(SKEWED.replace("skew = 0.0023", "skew = 0.13")), "rig")).toThrow("0.13 degrees is 0.0023");
        expect(() => gcodeMachineOf(gcodeFile(SKEWED.replace("skew = 0.0023", 'skew = 0.0023\nskew_by = "both"')), "rig")).toThrow('[motion] skew_by must be "link"');
        expect(() => gcodeMachineOf(gcodeFile(SKEWED.replace('init = ["G21", "G90"]', 'init = ["G21", "G90"]\nskew = "M852 I1"')), "rig")).toThrow("[gcode] skew must hold {skew}");
        const square = gcodeMachineOf(gcodeFile(PROFILE), "rig");
        expect([square.skew, square.skew_by, square.skew_line]).toEqual([0, "link", "M852 I{skew}"]);
    });

    test("the link sends X less the skew of Y, reads it back, and declares X and Y together", async () => {
        const mock = await skewed();
        let joint = (await mock.state()).machine?.joint;
        expect(joint?.r).toBeCloseTo(100, 6);
        expect(joint?.z).toBe(200);
        let start = await txCount(mock);
        await mock.jog({ kind: "joint", dz: 100 });
        expect(await sentSince(mock, start)).toEqual(["M114", "G0 X99.31 Y300 F3000"]);
        start = await txCount(mock);
        await mock.goto({ kind: "board", x: 110 });
        expect(await sentSince(mock, start)).toEqual(["M114", "G0 X109.31 Y300 F3000", "M400", "M114"]);
        start = await txCount(mock);
        await mock.setPosition({ z: 150 });
        expect(await sentSince(mock, start)).toEqual(["M114", "G92 X109.655 Y150", "M114"]);
        joint = (await mock.state()).machine?.joint;
        expect(joint?.r).toBeCloseTo(110, 6);
        expect(joint?.z).toBe(150);
        // No line goes to the firmware.
        expect((await mock.placingState()).log.some((entry) => entry.text.startsWith("M852"))).toBe(false);
    });

    test("with the firmware taking it out, the connect tells it and the lines stay square; a file written moves it back", async () => {
        const mock = await skewed(SKEWED.replace("skew = 0.0023", 'skew = 0.0023\nskew_by = "firmware"'));
        const sent = (await mock.placingState()).log.filter((entry) => entry.dir === "tx").map((entry) => entry.text);
        expect(sent.slice(0, 5)).toEqual(["G21", "G90", "M115", "M852 I0.0023", "M114"]);
        let start = await txCount(mock);
        await mock.goto({ kind: "board", x: 100, y: 300 });
        expect(await sentSince(mock, start)).toEqual(["M114", "G0 X100 Y300 F3000", "M400", "M114"]);
        // Given back to the link: the firmware is told 0 at once.
        start = await txCount(mock);
        await mock.patchMachineFile("rig", ["motion", "skew_by"], "link");
        expect(await sentSince(mock, start)).toEqual(["M852 I0"]);
    });
});
