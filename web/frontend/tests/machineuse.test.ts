import { describe, expect, test } from "bun:test";

import { inUseText, machineInUse } from "../src/machineuse.ts";
import { initialState, type AppState } from "../src/state.ts";
import type { MachinesResponse, SettingsResponse, Snapshot } from "../src/types.ts";
import { mountConnection } from "../src/views/connection.ts";
import { mountStatusBar } from "../src/views/statusbar.ts";
import { connected, settle, setup } from "./harness.ts";

const machines: MachinesResponse = {
    machines: [
        { id: "k40", name: "K40", description: "", kinematics: "cartesian", tool: "laser", focus: false },
        { id: "lumen", name: "LumenPnP", description: "", kinematics: "cartesian", tool: "nozzle", focus: true, controller: "gcode" },
    ],
    current: null,
    used: "k40",
    problems: [],
};

function state(snapshot: Partial<Snapshot>, settings: Partial<SettingsResponse> | null): Pick<AppState, "snapshot" | "settings" | "machines"> {
    const base = initialState(true);
    return { snapshot: { ...base.snapshot, ...snapshot }, settings: settings as SettingsResponse | null, machines };
}

describe("the machine file in use", () => {
    test("is the G-code machine connected, the file the board runs, none for settings of no file, else the file last used", () => {
        const gcode = machineInUse(state({ connected: true, profile: { kinematics: "cartesian", tool: "nozzle", h_axis: true, r_max: 0, z_max: 0, controller: "gcode", machine: "lumen", name: "LumenPnP" } }, null));
        expect(inUseText(gcode)).toBe("LumenPnP, connected");
        expect(inUseText(machineInUse(state({ connected: true }, null)))).toBe("reading the board's settings");
        expect(inUseText(machineInUse(state({ connected: true }, { machine: "k40" })))).toBe("K40: the board runs it");
        const loose = machineInUse(state({ connected: true }, { machine: null, controls_from: "k40" }));
        expect([loose.id, loose.how]).toEqual([null, "no-file"]);
        expect(inUseText(loose)).toBe("none: the board runs settings no file has; the jog draws K40's controls");
        expect(inUseText(machineInUse(state({ connected: false }, null)))).toBe("K40, last used here; not connected");
        expect(inUseText(machineInUse({ ...state({ connected: false }, null), machines: { ...machines, used: null } }))).toBe("none yet");
    });

    test("is named on the Connection tab, and by its name in the top bar", async () => {
        const { store, ctx, root, api } = setup();
        const bar = document.createElement("header");
        document.body.append(bar);
        mountConnection(root, ctx);
        mountStatusBar(bar, ctx);
        await api.connect("/dev/ttyACM0");
        store.set({ snapshot: connected() });
        await ctx.refreshSettings();
        await ctx.refreshMachines();
        await settle();
        // The mock's board boots as the polar laser with its focus axis.
        expect(root.querySelector(".connection-machine")?.textContent).toBe("Machine file: Polar laser with focus axis: the board runs it.");
        const badge = bar.querySelector(".badge.profile") as HTMLElement;
        expect(badge.textContent).toBe("Polar laser with focus axis");
        expect(badge.title).toContain("polar-laser-focus.toml");
        // A setting changed by hand: no file's, the kind of machine shown instead (none for the polar laser).
        await api.updateSettings({ values: { a_rate: 123 } });
        await ctx.refreshSettings();
        expect(root.querySelector(".connection-machine")?.textContent).toContain("Machine file: none: the board runs settings no file has");
        expect(badge.classList.contains("hidden")).toBe(true);
        bar.remove();
    });
});
