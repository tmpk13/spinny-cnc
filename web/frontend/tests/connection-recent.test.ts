// The Connection tab's buttons for the machines connected lately: one
// press switches, so a button must not be replaced under the pointer by
// the snapshots that come at 10 Hz while a machine is connected.

import { afterEach, describe, expect, test } from "bun:test";

import { mountConnection } from "../src/views/connection.ts";
import { connected, settle, setup } from "./harness.ts";

const RECENT_KEY = "spinny.recent";

afterEach(() => {
    localStorage.removeItem(RECENT_KEY);
});

describe("the machines connected lately", () => {
    test("keep their buttons through snapshots that change nothing they show", async () => {
        localStorage.setItem(RECENT_KEY, JSON.stringify([
            { url: "/dev/ttyACM0", machine: null, label: "Spinny board" },
            { url: "/dev/ttyACM1", machine: "opulo-lumen-rev5", label: "Opulo LumenPnP" },
        ]));
        const { store, ctx, root } = setup();
        store.set({ snapshot: connected() });
        mountConnection(root, ctx);
        await settle();
        const row = root.querySelector(".connection-recent") as HTMLElement;
        const pressed = Array.from(row.querySelectorAll("button")).find((button) => button.textContent === "Opulo LumenPnP")!;
        expect(pressed).toBeDefined();
        // A press goes down; the next snapshot moves the head a little.
        store.set({ snapshot: connected({ board: { x: 1, y: 12.345 } }) });
        await settle();
        expect(pressed.isConnected).toBe(true);
        // Connected elsewhere, the buttons say so.
        store.set({ snapshot: { ...connected(), url: "/dev/ttyACM1" } });
        await settle();
        const now = Array.from(row.querySelectorAll("button")).find((button) => button.textContent === "Opulo LumenPnP")!;
        expect(now.getAttribute("aria-pressed")).toBe("true");
        store.set({ snapshot: { ...connected(), connected: false } });
    });
});
