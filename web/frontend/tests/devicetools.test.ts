import { describe, expect, test } from "bun:test";

import { MockBackend } from "../src/mock/backend.ts";
import { parseDevice } from "../src/mock/openpnp.ts";
import lumenText from "../../../pnp/opulo-lumen-rev5.toml" with { type: "text" };

// The backend's test profile (web/backend/tests/test_device_tools.py): the
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
    await mock.newDeviceFile("rig", PROFILE);
    await mock.deviceSelect({ profile: "rig" });
    await mock.deviceConnect();
    // The backend's fake device starts at X100 Y50 Z0.
    await mock.deviceCommand("G0 X100 Y50 Z0");
    return mock;
}

/** The lines the mock device was sent since `since` lines of its log. */
function sentSince(mock: MockBackend, since: number): Promise<string[]> {
    return mock.deviceState().then((state) => state.log.filter((entry) => entry.dir === "tx").map((entry) => entry.text).slice(since));
}

async function txCount(mock: MockBackend): Promise<number> {
    return (await mock.deviceState()).log.filter((entry) => entry.dir === "tx").length;
}

describe("the device's tools in the mock", () => {
    test("the LumenPnP profile reads", () => {
        const lumen = parseDevice(lumenText, "opulo-lumen-rev5");
        expect(lumen.safe_z).toBe(31.5);
        expect(lumen.pick).toEqual(["M106 P1 S180", "M106"]);
        expect(lumen.camera_position).toEqual([61.92, 219.82]);
        expect(lumen.top?.offset).toEqual([23.544, 65.188]);
    });

    test("a jog moves one axis from where the device says it is", async () => {
        const mock = await rig();
        let start = await txCount(mock);
        await mock.deviceJog("x", 1.5);
        expect(await sentSince(mock, start)).toEqual(["M114", "G0 X101.5 Y50 F3000"]);
        start = await txCount(mock);
        await mock.deviceJog("z", -0.5);
        expect(await sentSince(mock, start)).toEqual(["M114", "G0 Z-0.5 F600"]);
        start = await txCount(mock);
        await mock.deviceJog("rotation", 15);
        expect(await sentSince(mock, start)).toEqual(["M114", "G0 A15 F3000"]);
        await expect(mock.deviceJog("y", 0)).rejects.toThrow("step");
    });

    test("a move goes across at the safe height, and parks", async () => {
        const mock = await rig();
        let start = await txCount(mock);
        await mock.deviceMove({ x: 30, y: 40, z: -1 });
        expect(await sentSince(mock, start)).toEqual(["G0 Z5 F600", "G0 X30 Y40 F3000", "G0 Z-1 F600"]);
        start = await txCount(mock);
        await mock.deviceMove({ y: 45 });
        expect(await sentSince(mock, start)).toEqual(["M114", "G0 Z5 F600", "G0 X30 Y45 F3000"]);
        start = await txCount(mock);
        await mock.devicePark();
        expect(await sentSince(mock, start)).toEqual(["G0 Z5 F600", "G0 X40 Y400 F3000"]);
    });

    test("the nozzle goes over the up camera with the lights on, and the tools swap over a point", async () => {
        const mock = await rig();
        let start = await txCount(mock);
        const state = await mock.deviceOverCamera();
        expect(await sentSince(mock, start)).toEqual(["M150 P255", "G0 Z5 F600", "G0 X60 Y200 A0 F3000", "G0 Z-4 F600"]);
        expect(state.light).toBe(true);
        expect(state.camera.position).toEqual([60, 200]);
        expect(state.camera.measured).toBe(false);
        await mock.deviceMove({ x: 100, y: 50 });
        start = await txCount(mock);
        await mock.deviceSwap("nozzle");
        expect(await sentSince(mock, start)).toEqual(["M114", "G0 Z5 F600", "G0 X120 Y110 F3000"]);
    });

    test("the up camera's place is set by hand and forgotten back to the profile's", async () => {
        const mock = await rig();
        await mock.deviceMove({ x: 61, y: 201 });
        expect((await mock.deviceCamera({ here: true })).camera.position).toEqual([61, 201]);
        expect((await mock.deviceCamera({ position: [62.5, 199] })).camera.position).toEqual([62.5, 199]);
        expect((await mock.deviceCamera({ clear: true })).camera.position).toEqual([60, 200]);
    });

    test("the lights and the vacuum switch, and the sensor reads", async () => {
        const mock = await rig();
        const start = await txCount(mock);
        expect((await mock.deviceLight(false)).light).toBe(false);
        const answer = await mock.deviceVacuum({ on: true, read: true });
        expect(await sentSince(mock, start)).toEqual(["M150 P0", "M106 P1 S180", "M106", "M260 A112 B1 S1", "M105"]);
        expect(answer.vacuum?.on).toBe(true);
        expect(answer.vacuum?.reading).toBe(230.5);
    });

    test("a port is picked, refused while connected, and asked what it runs", async () => {
        const mock = new MockBackend();
        await mock.newDeviceFile("rig", PROFILE);
        const state = await mock.deviceSelect({ profile: "rig", url: "/dev/ttyACM7" });
        expect(state.port).toBe("/dev/ttyACM7");
        expect((await mock.deviceConnect()).url).toBe("/dev/ttyACM7");
        await expect(mock.deviceSelect({ url: "/dev/ttyACM8" })).rejects.toThrow("disconnect the device");
        await mock.deviceDisconnect();
        await expect(mock.deviceSelect({ url: "spy:///tmp/x" })).rejects.toThrow("not a serial device path");
        const answer = await mock.deviceIdentify("/dev/serial/by-id/usb-STMicroelectronics_MARLIN_OPULO_LUMEN_REV5_CDC_in_FS_Mode_1-if00");
        expect(answer.machine).toBe("LumenPnP");
    });

    test("a profile value is changed in its text and a missing table added", async () => {
        const mock = new MockBackend();
        await mock.newDeviceFile("rig", PROFILE);
        const file = await mock.patchDeviceFile("rig", ["motion", "place_z"], -1.5);
        expect(file.document.place_z).toBe(-1.5);
        expect(file.text).toContain("place_z = -1.5");
        await expect(mock.patchDeviceFile("rig", ["motion", "pick_tries"], 0)).rejects.toThrow("pick_tries");
        const lumen = await mock.patchDeviceFile("opulo-lumen-rev5", ["vacuum", "part_on"], [220, 241]);
        expect(lumen.document.vacuum?.part_on).toEqual([220, 241]);
        await expect(mock.newDeviceFile("rig")).rejects.toThrow("there already");
        expect((await mock.deleteDeviceFile("rig")).devices.map((entry) => entry.id)).not.toContain("rig");
    });
});
