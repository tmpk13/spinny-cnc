import { describe, expect, test } from "bun:test";

import { crc8, decodePacket, encodePacket, HEADER_FIELDS, slotPlace } from "../src/feederbus.ts";
import { DEVICE_LINES_PER_SECOND, MockBackend } from "../src/mock/backend.ts";
import { parseDevice, planDevice } from "../src/mock/openpnp.ts";
import type { Component } from "../src/types.ts";

const C100N = "0102030405060708090A0B0C";
const C1U = "AABBCCDDEEFF001122334455";

// The backend's test profile (web/backend/tests/test_feederbus.py).
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
rotation = 90
[[slot]]
address = 4
at = [115.0, 400.0, 10.0]
rotation = 90
[[feeder]]
id = "c-100n"
match = "100n"
bus_id = "${C100N}"
slot = 3
offset = [1.0, 0.0, 0.5]
advance = 2
[[feeder]]
id = "c-1u"
match = "1u"
bus_id = "${C1U.toLowerCase()}"
`;

function part(ref: string, value: string, x: number): Component {
    return { ref, value, footprint: "C_0402", side: "front", x, y: 0, rotation: 0, pads: 2, smd: true, dnp: false };
}

describe("the feeder bus in the page and its mock", () => {
    test("packets read back as the backend's, checked by CRC-8 with the polynomial 7", () => {
        expect(crc8([..."123456789"].map((char) => char.charCodeAt(0)))).toBe(0xf4);
        const packet = { to: 3, sender: 0, number: 7, payload: [0x04, 40] };
        const text = encodePacket(packet);
        expect(text.slice(0, 8)).toBe("03000702");
        expect(decodePacket(text)).toEqual(packet);
        expect(decodePacket(text.slice(0, -2))).toBeNull();
        expect(decodePacket("ABC", HEADER_FIELDS)).toBeNull();
        const [x, y, z] = slotPlace([100, 400, 10], 90, [1, 0, 0.5]);
        expect(x).toBeCloseTo(100, 9);
        expect(y).toBeCloseTo(401, 9);
        expect(z).toBeCloseTo(10.5, 9);
    });

    test("the profile reads as the backend reads it, and the plan says each advance", () => {
        const device = parseDevice(PROFILE, "lumen");
        expect(device.bus?.reply).toBe("rs485-reply: (?P<packet>[0-9A-Fa-f]*)");
        expect(device.slots.map((slot) => slot.address)).toEqual([3, 4]);
        const [c100n, c1u] = device.feeders;
        expect(c100n!.at![1]).toBeCloseTo(401, 9);
        expect(c100n!.rotation).toBe(90);
        expect(c1u!.bus_id).toBe(C1U);
        expect(c1u!.at).toBeNull();
        const plan = planDevice(device, [part("C1", "100n", 1), part("C2", "1u", 2)], { rotation: 0, shift: [0, 0], scale: 1, rms: 0, residuals: [0], marks: 1 }, {}, null, "board");
        expect(plan.blocks.map((block) => block.ref)).toEqual(["C1"]);
        expect(plan.skipped).toEqual([{ ref: "C2", reason: "feeder c-1u's slot is not known: scan the feeder bus, or run, which finds it" }]);
        expect(plan.blocks[0]!.pick).toContain("; c-100n advances 2 mm on the feeder bus");
        expect(() => parseDevice(PROFILE.replace("slot = 3\n", "slot = 9\n"), "lumen")).toThrow("[feeder 1] slot 9 has no [[slot]] with its place");
        expect(() => parseDevice(PROFILE.replace('send = "M485 {packet}"', 'send = "M485"'), "lumen")).toThrow("[bus] send must hold {packet}");
    });

    test("the mock's bus is scanned, a feeder fed, and a run advances one before its pick", async () => {
        const mock = new MockBackend();
        // The mock's boards hold test points: the feeders hold them by their words.
        await mock.newDeviceFile("lumen", PROFILE.replace('match = "100n"', 'match = "TestPoint"').replace('match = "1u"', 'match = "nothing here"'));
        await mock.deviceSelect({ profile: "lumen" });
        await mock.deviceConnect();
        const scan = await mock.deviceBusScan();
        expect(scan.feeders).toEqual([
            { address: 3, id: C100N, feeder: "c-100n", slot: true },
            { address: 4, id: C1U, feeder: "c-1u", slot: true },
        ]);
        await mock.deviceBusFeed("c-100n");
        const sent = (await mock.deviceState()).log.filter((entry) => entry.dir === "tx").map((entry) => entry.text);
        expect(sent.some((line) => line.startsWith("M485 0300"))).toBe(true);
        await expect(mock.deviceBusFeed("nope")).rejects.toThrow("no feeder");
        const job = await mock.uploadJob(new File(["(kicad_pcb)"], "board.kicad_pcb"), {});
        const parts = (await mock.components(job.id)).components.filter((entry) => !entry.fiducial);
        await mock.deviceReference({ job: job.id, ref: parts[0]!.ref, at: [40, 30] });
        await mock.deviceRun(job.id, [parts[0]!.ref]);
        for (let tick = 0; tick < 4000 && (await mock.deviceState()).running; tick++) {
            (mock as unknown as { serviceDevice(dt: number): void }).serviceDevice(1 / DEVICE_LINES_PER_SECOND);
        }
        const state = await mock.deviceState();
        expect(state.progress?.state).toBe("done");
        expect(state.progress?.steps?.some((step) => step.text === "feeder c-100n advanced 2 mm (address 3)")).toBe(true);
    });
});
