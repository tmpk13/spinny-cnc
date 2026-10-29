import { describe, expect, test } from "bun:test";

import { pendingTotal, setPending } from "../src/state.ts";
import { mountSettings, applyState } from "../src/views/settings.ts";
import { mountTabs, pendingOn } from "../src/views/tabs.ts";
import { mountVision } from "../src/views/vision.ts";
import { click, connected, settle, setup } from "./harness.ts";

describe("what the panels hold unapplied", () => {
    test("the state says typed and not sent, sent and not saved, or all applied", () => {
        expect(applyState(2, ["r_rate"])).toMatchObject({ kind: "pending", text: "2 not applied" });
        const unsaved = applyState(0, ["a_rate", "r_rate"]);
        expect(unsaved).toMatchObject({ kind: "unsaved", text: "applied, not saved to flash" });
        expect(unsaved.detail).toContain("a_rate, r_rate");
        expect(applyState(0, [])).toMatchObject({ kind: "applied", text: "all applied" });
    });

    test("the counts are kept per panel and summed per page", () => {
        const { store } = setup();
        setPending(store, "settings", 2);
        setPending(store, "machine-file", 1);
        setPending(store, "camera", 3);
        expect(pendingOn(store.get().pending, "config")).toBe(3);
        expect(pendingOn(store.get().pending, "machine")).toBe(3);
        expect(pendingOn(store.get().pending, "cam")).toBe(0);
        expect(pendingTotal(store.get().pending)).toBe(6);
        setPending(store, "settings", 0);
        expect(store.get().pending).toEqual({ "machine-file": 1, camera: 3 });
    });
});

describe("the firmware settings panel", () => {
    test("marks a value typed in, counts it on the tab, and follows it through apply and save", async () => {
        const { store, ctx, root, api } = setup();
        const tabs = document.createElement("nav");
        document.body.append(tabs);
        mountTabs(tabs, store);
        await api.connect("/dev/ttyACM0");
        store.set({ snapshot: connected() });
        mountSettings(root, ctx);
        await ctx.refreshSettings();
        const chip = root.querySelector(".settings-actions .apply-state") as HTMLElement;
        expect(chip.textContent).toBe("all applied");
        const rate = root.querySelector('input[aria-label="r_rate"]') as HTMLInputElement;
        rate.value = "777";
        rate.dispatchEvent(new Event("input"));
        expect(chip.textContent).toBe("1 not applied");
        expect(chip.getAttribute("data-apply")).toBe("pending");
        expect(rate.closest("tr")?.classList.contains("edited")).toBe(true);
        expect(rate.closest("tr")?.querySelector(".was")?.textContent).toMatch(/^was /);
        const config = tabs.querySelector('[data-page="config"]') as HTMLElement;
        expect(config.getAttribute("data-pending")).toBe("1");
        expect(config.textContent).toBe("Config");
        // A host value counts as well, and is marked on its field.
        const tolerance = root.querySelector(".settings-actions input") as HTMLInputElement;
        tolerance.value = "0.01";
        tolerance.dispatchEvent(new Event("input"));
        expect(chip.textContent).toBe("2 not applied");
        expect(tolerance.closest(".labeled")?.classList.contains("edited")).toBe(true);
        click(root, "Apply");
        await settle();
        await settle();
        expect(chip.textContent).toBe("applied, not saved to flash");
        expect(chip.title).toContain("r_rate");
        expect(config.hasAttribute("data-pending")).toBe(false);
        click(root, "Save to flash");
        await settle();
        await settle();
        expect(chip.textContent).toBe("all applied");
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
