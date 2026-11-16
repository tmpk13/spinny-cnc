// Which of the Run area's panels fit the machine connected. The area holds
// the panels of every kind of machine (a laser's or a mill's heights and
// head camera, a pick and place machine's parts and bottom camera); each
// shows only while the machine connected can use it. With no machine
// connected nothing is known of it, and every panel shows, except that a
// pick and place machine used last keeps the laser's away as before.

import { profileOf } from "../profile.ts";
import type { AppState } from "../state.ts";
import { gcodePlacing } from "./placing.ts";

/** Whether the machine places or dispenses parts: a G-code pick and place machine, or a nozzle or a dispenser on this project's. */
export function placesParts(state: AppState): boolean {
    if (gcodePlacing(state)) {
        return true;
    }
    if (!state.snapshot.connected) {
        return true;
    }
    const tool = profileOf(state.snapshot).tool;
    return tool === "nozzle" || tool === "dispenser";
}

/** The Run area's panels that follow the machine, by id, each with when it shows. */
export const FIT_RULES: readonly [id: string, shows: (state: AppState) => boolean][] = [
    // A G-code pick and place machine looks with its top camera, and has
    // no heights to probe or focus.
    ["camera-view", (state) => !gcodePlacing(state)],
    ["heightmap", (state) => !gcodePlacing(state)],
    // A laser or a mill places no parts and has no bottom camera.
    ["pnp-parts", placesParts],
    ["pnp-board", placesParts],
    ["pnp-view", placesParts],
];

/** Shows each panel of `FIT_RULES` found on the page while it fits the machine, hides it otherwise. */
export function mountFit(subscribe: (listener: (state: AppState) => void) => void, find: (id: string) => HTMLElement | null = (id) => document.getElementById(id)): void {
    subscribe((state) => {
        for (const [id, shows] of FIT_RULES) {
            find(id)?.classList.toggle("hidden", !shows(state));
        }
    });
}
