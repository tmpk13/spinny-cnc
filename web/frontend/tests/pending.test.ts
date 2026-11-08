import { describe, expect, test } from "bun:test";

import { pendingTotal, setPending } from "../src/state.ts";
import { mountConfig } from "../src/views/config.ts";
import { pendingOn } from "../src/views/tabs.ts";
import { mountVision } from "../src/views/vision.ts";
import { click, connected, settle, setup } from "./harness.ts";

describe("what the panels hold unapplied", () => {
    test("the counts are kept per panel and summed per page", () => {
        const { store } = setup();
        setPending(store, "settings", 2);
        setPending(store, "machine-file", 1);
        setPending(store, "camera", 3);
        expect(pendingOn(store.get().pending, "config")).toBe(3);
        expect(pendingOn(store.get().pending, "jobs")).toBe(3);
        expect(pendingOn(store.get().pending, "cam")).toBe(0);
        expect(pendingTotal(store.get().pending)).toBe(6);
        setPending(store, "settings", 0);
        expect(store.get().pending).toEqual({ "machine-file": 1, camera: 3 });
    });
});

describe("the settings list", () => {
    test("lists every key with the file's value beside the board's, searches them, and takes the editor to one", async () => {
        localStorage.removeItem("spinny.machine");
        const { store, ctx, root, api } = setup();
        const listRoot = document.createElement("section");
        document.body.append(listRoot);
        await api.connect("/dev/ttyACM0");
        store.set({ snapshot: connected() });
        mountConfig(root, ctx, listRoot);
        await ctx.refreshSettings();
        await settle();
        await settle();
        const rows = (): HTMLTableRowElement[] => Array.from(listRoot.querySelectorAll("table.settings-list tbody tr"));
        const keyOf = (row: HTMLTableRowElement): string => row.querySelector(".settings-key")?.textContent ?? "";
        expect(rows().length).toBeGreaterThan(80);
        // The board runs the file it boots as: nothing differs.
        expect(listRoot.querySelector(".settings-count")?.textContent).toMatch(/, 0 differ$/);
        // A value written at the console differs from the file's.
        await api.updateSettings({ values: { r_rate: 777 } });
        await ctx.refreshSettings();
        const rate = rows().find((row) => keyOf(row) === "[rail] max_rate")!;
        expect(rate.classList.contains("differs")).toBe(true);
        expect(rate.cells[3]!.textContent).toBe("777");
        const only = listRoot.querySelector('input[aria-label="Only where the file and the board differ"]') as HTMLInputElement;
        only.checked = true;
        only.dispatchEvent(new Event("change"));
        expect(rows().map(keyOf)).toEqual(["[rail] max_rate"]);
        only.checked = false;
        only.dispatchEvent(new Event("change"));
        // A search by the firmware's name, letters apart, finds the key,
        // and one the file names otherwise too.
        const search = listRoot.querySelector("input[type=search]") as HTMLInputElement;
        search.value = "holdpct";
        search.dispatchEvent(new Event("input"));
        expect(keyOf(rows()[0]!)).toBe("[drivers] hold_pct");
        search.value = "intpol";
        search.dispatchEvent(new Event("input"));
        expect(keyOf(rows()[0]!)).toBe("[drivers] interpolate");
        // Clicked, a key the file names is selected; one it leaves out is added.
        const text = root.querySelector("textarea") as HTMLTextAreaElement;
        search.value = "rail accel";
        search.dispatchEvent(new Event("input"));
        rows()[0]!.click();
        expect(text.value.slice(text.selectionStart, text.selectionEnd)).toMatch(/^accel = /);
        search.value = "drivers stepus";
        search.dispatchEvent(new Event("input"));
        const before = text.value;
        rows()[0]!.click();
        expect(before.includes("step_us")).toBe(false);
        expect(text.value.slice(text.selectionStart, text.selectionEnd)).toBe("step_us = 2");
        expect(store.get().pending["machine-file"]).toBe(1);
        localStorage.removeItem("spinny.machine");
    });
});

describe("the camera panel", () => {
    test("counts a settings field typed in until it is applied", async () => {
        const { store, ctx, root } = setup();
        mountVision(root, ctx);
        await ctx.refreshCamera();
        const device = root.querySelector('input[aria-label="Camera device"]') as HTMLInputElement;
        device.value = "/dev/video4";
        device.dispatchEvent(new Event("input"));
        expect(store.get().pending["camera"]).toBe(1);
        expect(device.closest(".labeled")?.classList.contains("edited")).toBe(true);
        click(root, "Apply");
        await settle();
        await settle();
        expect(store.get().pending["camera"]).toBeUndefined();
    });
});
