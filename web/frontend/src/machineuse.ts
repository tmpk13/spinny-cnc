// Which machine file is the machine in use, as the Config tab, the
// Connection tab and the top bar say it: the G-code machine connected; the
// file whose settings the board connected runs, every one of them; for a
// board running settings no file has, none (the jog panel then draws the
// controls of the file the settings name as `controls_from`); with nothing
// connected, the file last used from this host.

import { profileOf } from "./profile.ts";
import type { AppState } from "./state.ts";

export interface MachineInUse {
    /** The file, or null for none. */
    id: string | null;
    /** Its name, or its id when the list has not said it. */
    name: string | null;
    /**
     * How it is in use: a G-code machine connected; the board connected
     * runs its settings; the board runs settings no file has; the board's
     * settings not read yet; nothing connected, the file last used here;
     * nothing connected and no file used yet.
     */
    how: "connected" | "board" | "no-file" | "reading" | "last" | "none";
    /** For settings no file has: the file the jog panel draws its controls from, by name; null for the defaults. */
    controls: string | null;
}

function nameOf(state: Pick<AppState, "machines">, id: string | null): string | null {
    if (id === null) {
        return null;
    }
    return state.machines?.machines.find((machine) => machine.id === id)?.name ?? id;
}

export function machineInUse(state: Pick<AppState, "snapshot" | "settings" | "machines">): MachineInUse {
    const snapshot = state.snapshot;
    if (snapshot.connected) {
        const profile = profileOf(snapshot);
        if (profile.controller === "gcode") {
            const id = profile.machine ?? null;
            return { id, name: profile.name ?? nameOf(state, id), how: "connected", controls: null };
        }
        const settings = state.settings;
        if (!settings) {
            return { id: null, name: null, how: "reading", controls: null };
        }
        if (settings.machine) {
            return { id: settings.machine, name: nameOf(state, settings.machine), how: "board", controls: null };
        }
        return { id: null, name: null, how: "no-file", controls: nameOf(state, settings.controls_from ?? null) };
    }
    const used = state.machines?.used ?? null;
    return used === null ? { id: null, name: null, how: "none", controls: null } : { id: used, name: nameOf(state, used), how: "last", controls: null };
}

/** The machine in use in a few words: "K40: the board runs it". */
export function inUseText(use: MachineInUse): string {
    switch (use.how) {
        case "connected":
            return `${use.name}, connected`;
        case "board":
            return `${use.name}: the board runs it`;
        case "no-file":
            return `none: the board runs settings no file has${use.controls ? `; the jog panel draws ${use.controls}'s controls` : ""}`;
        case "reading":
            return "reading the board's settings";
        case "last":
            return `${use.name}, last used here; not connected`;
        default:
            return "none yet";
    }
}
