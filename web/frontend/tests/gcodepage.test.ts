import { describe, expect, test } from "bun:test";

import { mountConfig } from "../src/views/config.ts";
import { mountConsole } from "../src/views/console.ts";
import { mountJog } from "../src/views/jog.ts";
import { mountConnection } from "../src/views/connection.ts";
import { defaultPort, firmwareLabel, machineOfPort, mountStatusBar, portLabel } from "../src/views/statusbar.ts";
import { findButton, settle, setup } from "./harness.ts";

// A G-code machine used like the other machines on the page: its port named
// after its machine file in the top bar and opened as it, its jog bars and
// controls, its console, and its file on the Config page.

describe("a G-code machine in the top bar", () => {
    test("its port is named after its file, offered, and Connect opens it as that machine", async () => {
        const { store, ctx, root } = setup();
        const bar = document.createElement("header");
        document.body.append(bar);
        mountStatusBar(bar, ctx);
        mountConnection(root, ctx);
        await ctx.refreshPorts();
        const ports = store.get().ports;
        const lumen = ports.find((port) => port.device === "/dev/ttyACM1")!;
        expect(lumen.machine).toBe("opulo-lumen-rev5");
        expect(portLabel(lumen)).toStartWith("Opulo LumenPnP (Rev05, Marlin): ");
        expect(machineOfPort(ports, lumen.url)).toBe("opulo-lumen-rev5");
        expect(machineOfPort(ports, "/dev/ttyACM0")).toBeNull();
        // This project's board stays the port offered first.
        expect(defaultPort(ports)?.spinny).toBe(true);
        const url = root.querySelector('input[aria-label="Port url"]') as HTMLInputElement;
        url.value = lumen.url;
        findButton(root, "Connect").click();
        await settle();
        await settle();
        const snapshot = store.get().snapshot;
        expect(snapshot.connected).toBe(true);
        expect(snapshot.profile?.controller).toBe("gcode");
        // The version, short, with the whole answer to M115 on hover.
        expect(bar.querySelector(".firmware")?.textContent).toBe("Marlin 2.1.2");
        expect(bar.querySelector<HTMLElement>(".firmware")?.title).toContain("Marlin 2.1.2");
        expect(bar.querySelector(".badge.profile")?.textContent).toBe("Opulo LumenPnP (Rev05, Marlin)");
        // Remembered: a button switches back to it in one press.
        expect(root.querySelector(".connection-recent button")?.textContent).toBe("Opulo LumenPnP (Rev05, Marlin)");
        bar.remove();
    });
});

describe("the firmware in the top bar", () => {
    test("is its version, short; whatever else a firmware says of itself shows on hover", () => {
        expect(firmwareLabel(null)).toEqual({ text: "", title: "" });
        expect(firmwareLabel({ version: "0.1.0", lines: 16, blocks: 32 }).text).toBe("v0.1.0");
        const gcode = (said: string) => firmwareLabel({ version: said, lines: 1, blocks: 0, name: said || "Opulo LumenPnP" });
        expect(gcode("Marlin 2.1.2.1 (Sep 12 2023 16:42:58)")).toEqual({ text: "Marlin 2.1.2.1", title: "firmware: Marlin 2.1.2.1 (Sep 12 2023 16:42:58)" });
        expect(gcode("Marlin bugfix-2.1.x (Github)").text).toBe("Marlin bugfix-2.1.x");
        expect(gcode("RepRapFirmware for Duet 3 MB6HC version 3.5.0-rc.1 notes: lots of words").text).toBe("RepRapFirmware 3.5.0-rc.1");
        expect(gcode("v1.4.2 Smoothie edge").text).toBe("v1.4.2");
        expect(gcode("Smoothieware").text).toBe("Smoothieware");
        expect(gcode("AVeryLongFirmwareNameWithNoNumber at all").text).toBe("AVeryLongFirmwa...");
        // A machine that said nothing of its firmware: the badge names it.
        expect(gcode("")).toEqual({ text: "", title: "" });
    });
});

describe("a G-code machine's controls", () => {
    test("the jog draws its file's bars, homes it, and has no travel height or unlock", async () => {
        const { store, ctx, root, api } = setup();
        store.set({ snapshot: await api.connect("/dev/ttyACM1", "opulo-lumen-rev5") });
        await ctx.refreshSettings();
        mountJog(root, ctx);
        await settle();
        const titles = Array.from(root.querySelectorAll(".axis-bar .axis-bar-title")).map((node) => node.textContent);
        // The board's moves are the pad's: the bars are the machine's own axes.
        expect(titles).toEqual(["X", "Y", "Nozzle height", "N1 turn"]);
        expect(root.querySelector('.jog-pad[data-axis="board"]')).not.toBeNull();
        expect(root.textContent).toContain("N1 down");
        expect(Array.from(root.querySelectorAll("button")).some((each) => each.textContent === "Unlock")).toBe(false);
        expect(findButton(root, "Home").classList.contains("hidden")).toBe(false);
        expect(root.querySelector(".travel-row")).toBeNull();
    });

    test("the console takes its own lines and has no hold", async () => {
        const { store, ctx, root, api } = setup();
        mountConsole(root, ctx);
        store.set({ snapshot: await api.connect("/dev/ttyACM1", "opulo-lumen-rev5") });
        const input = root.querySelector('input[aria-label="Command line"]') as HTMLInputElement;
        expect(input.placeholder).toContain("M114");
        expect(findButton(root, "Hold !").getAttribute("aria-disabled") === "true" || findButton(root, "Hold !").disabled).toBe(true);
        expect(await api.command("M114")).toContain("ok");
    });
});

describe("a G-code machine's file on the Config page", () => {
    test("reads as a G-code machine, and is never written to a board", async () => {
        localStorage.removeItem("spinny.machine");
        const { store, ctx, root, api } = setup();
        const listRoot = document.createElement("section");
        document.body.append(listRoot);
        store.set({ snapshot: await api.connect("/dev/ttyACM0") });
        mountConfig(root, ctx, listRoot);
        await ctx.refreshSettings();
        await settle();
        await settle();
        const pick = root.querySelector('select[aria-label="Machine file"]') as HTMLSelectElement;
        pick.value = "opulo-lumen-rev5";
        pick.dispatchEvent(new Event("change"));
        await settle();
        await settle();
        expect(root.querySelector(".config-note")?.textContent).toContain("a G-code machine (its own controller), a port named lumen, safe Z 31.5");
        const write = findButton(root, "Write to board");
        expect(write.getAttribute("aria-disabled") === "true" || write.disabled).toBe(true);
        expect(root.querySelector(".config-board")?.textContent).toContain("Use this machine connects it");
        localStorage.removeItem("spinny.machine");
    });
});
