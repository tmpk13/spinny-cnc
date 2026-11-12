import { describe, expect, test } from "bun:test";

import { MockCameraLog, overlaySvg } from "../src/mock/camlog.ts";
import { lookText, mountCameraLog } from "../src/views/camlog.ts";
import type { CamLogEntry } from "../src/types.ts";
import { dialogButton, settle, setup } from "./harness.ts";

async function settleMany(times = 6): Promise<void> {
    for (let i = 0; i < times; i++) {
        await settle();
    }
}

describe("the camera log", () => {
    test("marks the center, the circle searched and the spot found, or says nothing was", () => {
        const found = overlaySvg("data:x", 1280, 720, { found: true, x: 652, y: 371, dx: 12, dy: 11, major: 20, minor: 12 }, "bottom camera, photo: by hand");
        expect(found).toContain('<rect x="642.0" y="365.0" width="20.0" height="12.0"');
        expect(found).toContain('r="240.0"');
        expect(found).toContain("found at dx +12.0 dy +11.0 px");
        const missed = overlaySvg("data:x", 1280, 720, { found: false }, "a < b");
        expect(missed).toContain("nothing found inside the circle");
        expect(missed).toContain("a &lt; b");
        expect(missed).not.toContain("<rect");
        const entry = (spot: CamLogEntry["spot"]): CamLogEntry => ({ id: "x", time: "2026-11-05T10:15:00.000Z", camera: "up", routine: "photo", step: "by hand", note: "", width: 1, height: 1, spot, files: { photo: "x.jpg", overlay: "x.svg" } });
        expect(lookText(entry(null))).toBe("no finder");
        expect(lookText(entry({ found: false }))).toBe("found nothing");
        expect(lookText(entry({ found: true, dx: -3, dy: 4.25 }))).toBe("found at dx -3.0 dy +4.3 px");
    });

    test("keeps at most its count, the oldest going with their pictures", () => {
        const log = new MockCameraLog();
        const kept = log.keep({ camera: "head", routine: "photo", step: "by hand", note: "", width: 10, height: 10, spot: null }, "data:picture");
        expect(log.files.get(kept.files.photo)).toBe("data:picture");
        expect(log.files.get(kept.files.overlay)?.startsWith("data:image/svg+xml")).toBe(true);
        expect(log.clear()).toBe(1);
        expect(log.files.size).toBe(0);
    });

    test("a camera panel turns logging on, takes a photo and shows it with what its finder found", async () => {
        const { store, ctx, root, api, calls } = setup();
        await api.connect("/dev/ttyACM0");
        mountCameraLog(root, ctx, "head");
        await settleMany();
        const toggle = root.querySelector('input[aria-label="Log every look"]') as HTMLInputElement;
        expect(toggle.checked).toBe(false);
        toggle.checked = true;
        toggle.dispatchEvent(new Event("change"));
        await settleMany();
        expect(calls.some((call) => call.name === "setCamLog" && call.args[0] === true)).toBe(true);
        expect(store.get().camlog?.enabled).toBe(true);
        // Not running: the photo is refused.
        const photo = Array.from(root.querySelectorAll("button")).find((b) => b.textContent === "Photo")!;
        photo.click();
        await settleMany();
        expect(store.get().toasts.some((toast) => toast.text.includes("not running"))).toBe(true);
        await api.cameraStart();
        photo.click();
        await settleMany();
        const entries = root.querySelectorAll(".camlog-entry");
        expect(entries.length).toBe(1);
        expect(entries[0]!.textContent).toContain("photo: by hand");
        const links = Array.from(entries[0]!.querySelectorAll(".camlog-links a")).map((a) => a.textContent);
        expect(links).toEqual(["photo", "with marks"]);
        const thumb = entries[0]!.querySelector("img") as HTMLImageElement;
        expect(thumb.getAttribute("src")?.startsWith("data:image/svg+xml")).toBe(true);
        // The other camera's panel does not show it.
        const other = document.createElement("section");
        mountCameraLog(other, ctx, "up");
        await settleMany();
        expect(other.querySelectorAll(".camlog-entry").length).toBe(0);
        // Cleared, asked first.
        Array.from(root.querySelectorAll("button")).find((b) => b.textContent === "Clear log")!.click();
        await settle();
        dialogButton("Clear log").click();
        await settleMany();
        expect(root.querySelectorAll(".camlog-entry").length).toBe(0);
        root.remove();
    });

    test("a camera panel shows its own camera's pictures however many the other camera kept since", async () => {
        const { store, ctx, root, api, backend } = setup();
        await api.connect("/dev/ttyACM0");
        const log = (backend as unknown as { cameraLog: MockCameraLog }).cameraLog;
        const look = (camera: "head" | "up", step: string) => log.keep({ camera, routine: "find", step, note: "", width: 10, height: 10, spot: null }, "data:picture");
        for (let i = 0; i < 5; i++) {
            look("head", `head ${i}`);
        }
        for (let i = 0; i < 101; i++) {
            look("up", `up ${i}`);
        }
        store.set({ camlog: await api.camLog() });
        mountCameraLog(root, ctx, "head");
        await settleMany();
        expect(root.querySelectorAll(".camlog-entry").length).toBe(5);
        expect(root.textContent).toContain("5 kept of this camera");
        root.remove();
    });
});
