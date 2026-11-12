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
        expect(lumen.safe_z).toBe(31.5);
        expect(lumen.pick).toEqual(["M106 P1 S180", "M106"]);
        expect(lumen.camera_position).toEqual([61.92, 219.82]);
        expect(lumen.top?.offset).toEqual([23.544, 65.188]);
        expect(lumen.match).toEqual(["lumen"]);
        const ports = await new MockBackend().ports();
        expect(ports.find((port) => port.device === "/dev/ttyACM1")?.machine).toBe("opulo-lumen-rev5");
        expect(ports.find((port) => port.device === "/dev/ttyACM0")?.machine).toBeNull();
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

    test("the nozzle goes over the up camera with the lights on, and the tools swap over a point", async () => {
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

    test("the up camera's place is set by hand and forgotten back to the file's", async () => {
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
