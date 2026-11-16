import { describe, expect, test } from "bun:test";

import { pendingTotal, setPending } from "../src/state.ts";
import { mountConfig } from "../src/views/config.ts";
import { pendingOn } from "../src/views/tabs.ts";
import { mountVision } from "../src/views/vision.ts";
import { click, connected, settle, setup } from "./harness.ts";

describe("what the panels hold unapplied", () => {
    test("the counts are kept per panel and summed per page", () => {
        const { store } = setup();
        setPending(store, "machine-file", 1);
        setPending(store, "cam-profile", 2);
        setPending(store, "camera", 3);
        setPending(store, "job-json", 1);
        expect(pendingOn(store.get().pending, "machines")).toBe(1);
        expect(pendingOn(store.get().pending, "cam")).toBe(2);
        // Each page's panels add up on its tab.
        expect(pendingOn(store.get().pending, "cameras")).toBe(3);
        expect(pendingOn(store.get().pending, "job")).toBe(1);
        expect(pendingOn(store.get().pending, "run")).toBe(0);
        expect(pendingOn(store.get().pending, "home")).toBe(0);
        expect(pendingTotal(store.get().pending)).toBe(7);
        setPending(store, "cam-profile", 0);
        expect(store.get().pending).toEqual({ "machine-file": 1, camera: 3, "job-json": 1 });
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
        // The editor keeps the focus a click gave it, which would take the
        // arrow keys from the jog tests that run after these.
        (document.activeElement as HTMLElement | null)?.blur();
    });

    test("a row's Insert writes the board's value into the file, and Copy puts a key or the rows shown on the clipboard as TOML", async () => {
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
        const text = root.querySelector("textarea") as HTMLTextAreaElement;
        const search = listRoot.querySelector("input[type=search]") as HTMLInputElement;
        const row = (query: string): HTMLTableRowElement => {
            search.value = query;
            search.dispatchEvent(new Event("input"));
            return listRoot.querySelector("table.settings-list tbody tr") as HTMLTableRowElement;
        };
        const press = (line: HTMLTableRowElement, label: string): HTMLButtonElement => {
            const found = Array.from(line.querySelectorAll("button")).find((button) => button.textContent === label)!;
            found.click();
            return found;
        };
        // The file has the key at the board's value: Insert has nothing to write.
        expect(press(row("focus maxrate"), "Insert").disabled).toBe(true);
        // A key the file leaves out is added with the board's value.
        expect(text.value.includes("[rail]")).toBe(false);
        press(row("rail maxrate"), "Insert");
        expect(text.value).toContain("[rail]\nmax_rate = 560\n");
        // A value changed on the board goes in over the file's.
        await api.updateSettings({ values: { h_rate: 777 } });
        await ctx.refreshSettings();
        press(row("focus maxrate"), "Insert");
        expect(text.value.slice(text.selectionStart, text.selectionEnd)).toMatch(/^max_rate = 777\b/);
        expect(root.querySelector(".config-status")?.textContent).toBe("set [focus] max_rate = 777, not saved");
        expect(store.get().pending["machine-file"]).toBe(1);
        // Copy: the key as TOML, under its table; Copy all the rows shown.
        const written: string[] = [];
        const secure = Object.getOwnPropertyDescriptor(globalThis, "isSecureContext");
        const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
        Object.defineProperty(globalThis, "isSecureContext", { value: true, configurable: true });
        Object.defineProperty(navigator, "clipboard", { value: { writeText: async (value: string) => void written.push(value) }, configurable: true });
        try {
            // The File column follows the text once it is checked, a moment after the edit.
            await new Promise((resolve) => setTimeout(resolve, 450));
            await settle();
            press(row("focus maxrate"), "Copy");
            await settle();
            expect(written.at(-1)).toBe("[focus]\nmax_rate = 777\n");
            search.value = "drivers hold";
            search.dispatchEvent(new Event("input"));
            (Array.from(listRoot.querySelectorAll("button")).find((button) => button.textContent === "Copy all") as HTMLButtonElement).click();
            await settle();
            expect(written.at(-1)).toMatch(/^\[drivers\]\nhold_pct = 50\n/);
            expect(store.get().toasts.some((toast) => /^copied \d+ keys as TOML$/.test(toast.text))).toBe(true);
        } finally {
            if (secure) {
                Object.defineProperty(globalThis, "isSecureContext", secure);
            } else {
                delete (globalThis as { isSecureContext?: boolean }).isSecureContext;
            }
            if (clipboard) {
                Object.defineProperty(navigator, "clipboard", clipboard);
            } else {
                delete (navigator as { clipboard?: unknown }).clipboard;
            }
        }
        localStorage.removeItem("spinny.machine");
        (document.activeElement as HTMLElement | null)?.blur();
    });

    test("a host key the file leaves out is added with the host's value, or named when the host has none", async () => {
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
        const text = root.querySelector("textarea") as HTMLTextAreaElement;
        expect(text.value.includes("travel")).toBe(false);
        const search = listRoot.querySelector("input[type=search]") as HTMLInputElement;
        const travelRow = (): HTMLTableRowElement => {
            search.value = "host travel";
            search.dispatchEvent(new Event("input"));
            return listRoot.querySelector("table.settings-list tbody tr") as HTMLTableRowElement;
        };
        // The host has no travel height: nothing to add, and the toast says so.
        travelRow().click();
        expect(text.value.includes("travel")).toBe(false);
        const errors = (): string[] => store.get().toasts.filter((toast) => toast.level === "error").map((toast) => toast.text);
        expect(errors()).toEqual(["[host] travel has no value; type it into the file"]);
        // With one, the key goes in with it.
        await api.updateSettings({ host: { travel: 5 } });
        await ctx.refreshSettings();
        travelRow().click();
        expect(text.value.slice(text.selectionStart, text.selectionEnd)).toBe("travel = 5");
        expect(text.value).toContain("[host]");
        expect(errors().length).toBe(1);
        localStorage.removeItem("spinny.machine");
        (document.activeElement as HTMLElement | null)?.blur();
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
