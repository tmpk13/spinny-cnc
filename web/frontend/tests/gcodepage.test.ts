import { describe, expect, test } from "bun:test";

import { mountConfig } from "../src/views/config.ts";
import { mountConsole } from "../src/views/console.ts";
import { mountJog } from "../src/views/jog.ts";
import { defaultPort, machineOfPort, mountStatusBar, portLabel } from "../src/views/statusbar.ts";
import { findButton, settle, setup } from "./harness.ts";

// A G-code machine used like the other machines on the page: its port named
// after its machine file in the top bar and opened as it, its jog bars and
// controls, its console, and its file on the Config page.

describe("a G-code machine in the top bar", () => {
    test("its port is named after its file, offered, and Connect opens it as that machine", async () => {
        const { store, ctx, root } = setup();
        mountStatusBar(root, ctx);
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
        expect(root.querySelector(".firmware")?.textContent).toContain("Marlin");
        expect(root.querySelector(".badge.profile")?.textContent).toBe("Opulo LumenPnP (Rev05, Marlin)");
    });
});

describe("a G-code machine's controls", () => {
    test("the jog panel draws its file's bars, homes it, and has no travel height or unlock", async () => {
        const { store, ctx, root, api } = setup();
        store.set({ snapshot: await api.connect("/dev/ttyACM1", "opulo-lumen-rev5") });
        await ctx.refreshSettings();
        mountJog(root, ctx);
        await settle();
        const titles = Array.from(root.querySelectorAll(".axis-bar .axis-bar-title")).map((node) => node.textContent);
        expect(titles).toEqual(["Board X", "Board Y", "X", "Y", "Nozzle height", "N1 turn"]);
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
        expect(root.querySelector(".config-board")?.textContent).toContain("connect it from the top bar");
        localStorage.removeItem("spinny.machine");
    });
});
