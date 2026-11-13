import { describe, expect, test } from "bun:test";

import { pictureStats } from "../src/imagestats.ts";
import { type FramePixels, histogramPath, MAX_PIXELS, mountCameraStats, statsLines, statsRegion } from "../src/views/camerastats.ts";
import { frameShown } from "../src/views/picture.ts";
import { click, setup, settle } from "./harness.ts";

/** RGBA rows of a gray ramp rising `slope` levels a pixel to the right. */
function ramp(slope: number, width = 40, height = 20): FramePixels {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const at = (y * width + x) * 4;
            const level = 20 + slope * x;
            data[at] = level;
            data[at + 1] = level;
            data[at + 2] = level;
            data[at + 3] = 255;
        }
    }
    return { data, width, height };
}

describe("a picture's live numbers", () => {
    test("the part measured is what the zoom shows, shrunk to at most MAX_PIXELS", () => {
        expect(statsRegion([1280, 720], 1)).toEqual({ source: [0, 0, 1280, 720], size: [640, 360] });
        expect(statsRegion([1280, 720], 2)).toEqual({ source: [320, 180, 640, 360], size: [640, 360] });
        expect(statsRegion([640, 360], 4)).toEqual({ source: [240, 135, 160, 90], size: [160, 90] });
        const { size } = statsRegion([4000, 3000], 1.3);
        expect(size[0] * size[1]).toBeLessThanOrEqual(MAX_PIXELS * 1.01);
    });

    test("the rows say the numbers, sharpness against the best", () => {
        const stats = { ...pictureStats(new Uint8Array(9).fill(100), 3, 3), sharpness: 6.04, edges: 0.0412, noise: 1.234, snr: 38.2, mean: 112.4, spread: 47.6, dark: 0.002, bright: 0.015 };
        expect(statsLines(stats, 8.05)).toEqual({
            sharpness: "6.0 (best 8.1, 75%); edges 4.1%",
            noise: "1.23 levels; SNR 38.2 dB",
            brightness: "112 of 255; spread 48",
            clipped: "black 0.2%, white 1.5%",
        });
        expect(statsLines({ ...stats, noise: 0, snr: null }, 0)).toMatchObject({ sharpness: "6.0; edges 4.1%", noise: "none measured" });
    });

    test("the histogram's bars, the fullest a unit high", () => {
        expect(histogramPath([0, 0, 0])).toBe("");
        expect(histogramPath([0, 1, 0.25])).toBe("M1 1V0.0000H2V1ZM2 1V0.5000H3V1Z");
    });

    test("frames are measured while started, no more than five a second, the best kept until reset or a new zoom", () => {
        let clock = 1000;
        let slope = 4;
        let answer: "pixels" | "unreadable" = "pixels";
        const view = mountCameraStats("top", { read: () => (answer === "unreadable" ? "unreadable" : ramp(slope)), now: () => clock });
        document.body.append(view.root);
        const image = { naturalWidth: 100, naturalHeight: 50 } as HTMLImageElement;
        const value = (name: string): string => Array.from(view.root.querySelectorAll(".camera-stat"))
            .find((line) => line.querySelector(".camera-stat-name")?.textContent === name)?.querySelector(".camera-stat-value")?.textContent ?? "";
        const status = view.root.querySelector(".camera-stats-status") as HTMLElement;
        const grid = view.root.querySelector(".camera-stats-grid") as HTMLElement;
        // Not started: a frame is not measured.
        frameShown("top", { image, zoom: 1 });
        expect(grid.classList.contains("hidden")).toBe(true);
        view.start();
        expect(status.textContent).toBe("Waiting for the camera's picture.");
        frameShown("top", { image, zoom: 1 });
        expect(grid.classList.contains("hidden")).toBe(false);
        expect(status.classList.contains("hidden")).toBe(true);
        expect(value("Sharpness")).toBe("4.0 (best 4.0, 100%); edges 0.0%");
        expect(value("Noise")).toBe("none measured");
        expect(value("Clipped")).toBe("black 0.0%, white 0.0%");
        // Within 200 ms of the last: not measured.
        clock += 100;
        slope = 6;
        frameShown("top", { image, zoom: 1 });
        expect(value("Sharpness")).toBe("4.0 (best 4.0, 100%); edges 0.0%");
        // Softer: the best stays, and says how far off it is.
        clock += 150;
        slope = 2;
        frameShown("top", { image, zoom: 1 });
        expect(value("Sharpness")).toBe("2.0 (best 4.0, 50%); edges 0.0%");
        click(view.root, "Reset best");
        expect(value("Sharpness")).toBe("2.0 (best 2.0, 100%); edges 0.0%");
        // Another zoom starts the best again.
        clock += 250;
        slope = 4;
        frameShown("top", { image, zoom: 1 });
        clock += 250;
        slope = 3;
        frameShown("top", { image, zoom: 2 });
        expect(value("Sharpness")).toBe("3.0 (best 3.0, 100%); edges 0.0%");
        // pcbv's own marks in the frame are measured too, and the line says so.
        clock += 250;
        frameShown("top", { image, zoom: 2, marked: true });
        expect(status.textContent).toContain("Overlay off");
        expect(grid.classList.contains("hidden")).toBe(false);
        // A picture the page may not read says so.
        clock += 250;
        answer = "unreadable";
        frameShown("top", { image, zoom: 2 });
        expect(status.textContent).toContain("another address");
        // Stopped: frames go unmeasured again.
        view.stop();
        clock += 250;
        answer = "pixels";
        slope = 1;
        frameShown("top", { image, zoom: 2 });
        expect(value("Sharpness")).toBe("3.0 (best 3.0, 100%); edges 0.0%");
        view.root.remove();
    });

    test("the controls' fold measures its camera's frames only while it is open", async () => {
        const { mountCameraControls } = await import("../src/views/cameracontrols.ts");
        const { ctx } = setup();
        const fold = mountCameraControls(ctx, "up", "the bottom camera");
        document.body.append(fold.root);
        const status = fold.root.querySelector(".camera-stats-status") as HTMLElement;
        const image = document.createElement("img");
        frameShown("up", { image, zoom: 1 });
        expect(status.textContent).toBe("");
        fold.root.open = true;
        fold.root.dispatchEvent(new Event("toggle"));
        await settle();
        expect(status.textContent).toBe("Waiting for the camera's picture.");
        // The test page's images have no pixels: the fold says so.
        frameShown("up", { image, zoom: 1 });
        expect(status.textContent).toBe("This browser gives the page no pixels to measure.");
        fold.root.open = false;
        fold.root.dispatchEvent(new Event("toggle"));
        status.textContent = "";
        frameShown("up", { image, zoom: 1 });
        expect(status.textContent).toBe("");
        fold.root.remove();
    });
});
