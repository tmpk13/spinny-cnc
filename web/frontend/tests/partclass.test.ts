import { describe, expect, test } from "bun:test";

import { MockBackend } from "../src/mock/backend.ts";
import { deviceDocument } from "../src/mock/openpnp.ts";
import { initialState } from "../src/state.ts";
import type { AppState } from "../src/state.ts";
import { partCrop, partLookRadius } from "../src/views/camview.ts";
import { parseDevice } from "./gcoderig.ts";

// A G-code machine with a crop of its own and two part classes, as the
// backend's test_gcode_machine.py writes them.
const PROFILE = `name = "rig"
[port]
url = "socket://127.0.0.1:9"
[motion]
safe_z = 5
place_z = -1
[up_camera]
crop = 3.0
[[part_class]]
name = "0603"
match = "0603"
crop = 1.2
[[part_class]]
name = "QFP"
match = "lqfp"
crop = 8
`;

describe("part classes for the bottom camera's crop", () => {
    test("the mock reads them as the backend does, and refuses what it refuses", () => {
        const device = parseDevice(PROFILE, "rig");
        expect(deviceDocument(device).classes).toEqual([{ name: "0603", match: "0603", crop: 1.2 }, { name: "QFP", match: "lqfp", crop: 8 }]);
        expect(() => parseDevice(PROFILE.replace('name = "QFP"', 'name = "0603"'), "rig")).toThrow("another class's too");
        expect(() => parseDevice(PROFILE.replace('match = "lqfp"\n', ""), "rig")).toThrow("match must hold");
        expect(() => parseDevice(PROFILE.replace("crop = 8\n", ""), "rig")).toThrow("crop must say");
        expect(() => parseDevice(`${PROFILE}size = [1, 2]\n`, "rig")).toThrow("size");
    });

    test("the crop picked is a class's, else the file's; a Look once at a part keeps to it in the picture's px", () => {
        const base = initialState(true);
        const document = deviceDocument(parseDevice(PROFILE, "rig"));
        const state = {
            ...base,
            snapshot: { ...base.snapshot, connected: false },
            placing: { machine: "rig", document, camera: { position: [0, 0], height: null, mm_per_px: 0.02, roll: 0, mirror: true } },
        } as unknown as AppState;
        expect(partCrop(state, "QFP")).toEqual({ mm: 8, name: "QFP" });
        expect(partCrop(state, "gone")).toEqual({ mm: 3, name: null });
        expect(partCrop(state, null)).toEqual({ mm: 3, name: null });
        // With no G-code machine placing, no crop.
        expect(partCrop({ ...state, placing: null } as unknown as AppState, "QFP")).toBeNull();
        localStorage.setItem("spinny.pnp.crop", "0603");
        // 1.2 mm at 0.02 mm a px: 60 px.
        expect(partLookRadius(state)).toBe(60);
        localStorage.removeItem("spinny.pnp.crop");
        expect(partLookRadius({ ...state, placing: { ...state.placing!, camera: { ...state.placing!.camera, mm_per_px: 0 } } } as AppState)).toBeUndefined();
    });

    test("the mock's Look once keeps to the radius asked and says it", async () => {
        const backend = new MockBackend({ timers: false });
        await backend.pnpStart();
        const open = (await backend.pnpLook("nozzle")).look!;
        const near = (await backend.pnpLook("nozzle", 0.5)).look!;
        expect(open.radius).toBeNull();
        expect(near.radius).toBe(0.5);
        // A spot found further out than the radius is not found within it.
        if (open.found && Math.hypot(open.dx ?? 0, open.dy ?? 0) > 0.5) {
            expect(near.found).toBe(false);
        }
        await expect(backend.pnpLook("part", 0)).rejects.toMatchObject({ status: 422 });
    });
});
