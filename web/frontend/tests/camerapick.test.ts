import { describe, expect, test } from "bun:test";

import { ApiError } from "../src/api.ts";
import { MOCK_CAMERAS } from "../src/mock/vision.ts";
import type { DetectedCamera } from "../src/types.ts";
import { cameraLabel, cameraOf, detectCameras, foundText, pickMode } from "../src/views/camerapick.ts";
import { setup } from "./harness.ts";

function camera(overrides: Partial<DetectedCamera> = {}): DetectedCamera {
    return {
        device: "/dev/v4l/by-id/usb-Cam-video-index0",
        names: ["/dev/v4l/by-id/usb-Cam-video-index0", "/dev/video0"],
        name: "Cam",
        kind: "v4l2",
        modes: [{ size: "1920x1080", fps: 15 }, { size: "1280x720", fps: 30 }, { size: "640x480", fps: 60 }],
        online: null,
        ...overrides,
    };
}

describe("picking a camera", () => {
    test("a device set by any name that reaches a camera is that camera", () => {
        expect(cameraOf(MOCK_CAMERAS, "/dev/video0")?.name).toBe("Head Camera (mock)");
        expect(cameraOf(MOCK_CAMERAS, " http://localhost:2325/snapshot ")?.kind).toBe("stream");
        expect(cameraOf(MOCK_CAMERAS, "/dev/video1")).toBeNull();
        expect(cameraOf(MOCK_CAMERAS, "")).toBeNull();
    });

    test("a pick keeps the size and the rate set where the camera has them", () => {
        expect(pickMode(camera(), "640x480", 30)).toEqual({ size: "640x480", fps: 30 });
        // A size the camera lacks: 1280x720, which it has.
        expect(pickMode(camera(), "800x600", 30)).toEqual({ size: "1280x720", fps: 30 });
        // A rate above what it gives at the size: what it gives.
        expect(pickMode(camera(), "1920x1080", 30)).toEqual({ size: "1920x1080", fps: 15 });
        expect(pickMode(camera({ modes: [{ size: "1280x720", fps: 7.5 }] }), "1280x720", 30).fps).toBe(7);
        // Without 1280x720: the largest below it, else the smallest.
        const without = [{ size: "1920x1080", fps: 30 }, { size: "1024x768", fps: 30 }, { size: "320x240", fps: 30 }];
        expect(pickMode(camera({ modes: without }), "800x600", 30).size).toBe("1024x768");
        expect(pickMode(camera({ modes: [{ size: "3840x2160", fps: 30 }, { size: "1920x1080", fps: 30 }] }), "800x600", 30).size).toBe("1920x1080");
        // A rate the camera does not say, or no modes at all, keep what is set.
        expect(pickMode(camera({ modes: [{ size: "1280x720", fps: 0 }] }), "1280x720", 25)).toEqual({ size: "1280x720", fps: 25 });
        expect(pickMode(camera({ modes: [] }), "800x600", 12)).toEqual({ size: "800x600", fps: 12 });
    });

    test("the words of the list and of the line under it", () => {
        const [head, , stream] = MOCK_CAMERAS;
        expect(cameraLabel(head!, null)).toBe("Head Camera (mock)  /dev/v4l/by-id/usb-Mock_Head_Camera_0001-video-index0");
        expect(cameraLabel(head!, "up camera")).toBe("Head Camera (mock), set as the up camera  /dev/v4l/by-id/usb-Mock_Head_Camera_0001-video-index0");
        expect(cameraLabel({ ...stream!, online: false }, null)).toBe("stream on port 2325, 1280x720, no signal  http://127.0.0.1:2325/snapshot");
        expect(foundText(null, "/dev/video0")).toBe("Looking for cameras...");
        expect(foundText({ cameras: [], problems: ["pcbv is not built."] }, ""))
            .toBe("No camera found: plug one in and press Detect, or type a device. pcbv is not built.");
        expect(foundText({ cameras: MOCK_CAMERAS, problems: [] }, "/dev/video0")).toBe("3 cameras found.");
        expect(foundText({ cameras: MOCK_CAMERAS.slice(0, 1), problems: [] }, "/dev/video1")).toBe("1 camera found; /dev/video1 is not one of them.");
    });

    test("a press that fails says why; a look that fails waits quietly for the next", async () => {
        const { store, ctx, backend } = setup();
        const real = backend.cameras.bind(backend);
        backend.cameras = async () => {
            throw new ApiError(502, "the backend is away");
        };
        await detectCameras(ctx, false);
        expect(store.get().cameras).toBeNull();
        expect(store.get().toasts).toEqual([]);
        await detectCameras(ctx, true);
        expect(store.get().toasts.map((toast) => toast.text)).toEqual(["the backend is away"]);
        backend.cameras = real;
        await detectCameras(ctx, true);
        expect(store.get().cameras?.cameras.length).toBe(MOCK_CAMERAS.length);
        expect(store.get().cameras?.at).toBeGreaterThan(0);
    });
});
