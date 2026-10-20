// What the view tests of the camera, the alignment and the dispenser share:
// a store with the in-page mock behind a recording API, a mounted root,
// and the clicks and waits that drive a panel.

import type { Api } from "../src/api.ts";
import { createContext } from "../src/main.ts";
import { MockBackend } from "../src/mock/backend.ts";
import { Store, initialState, type AppState } from "../src/state.ts";
import type { Machine, Snapshot, WsEvent } from "../src/types.ts";

export function machine(overrides: Partial<Machine> = {}): Machine {
    return {
        state: "Idle",
        alarm: null,
        joint: { r: 12.345, a: 90, z: 0, h: 2 },
        board: { x: 0, y: 12.345 },
        rate: 0,
        laser: 0,
        mode: "dyn",
        enabled: true,
        queue: { planner: 32, lines: 16 },
        probe: false,
        ...overrides,
    };
}

export function connected(overrides: Partial<Machine> = {}, snapshot: Partial<Snapshot> = {}): Snapshot {
    return {
        connected: true,
        url: "/dev/ttyACM0",
        firmware: { version: "0.1.0", lines: 16, blocks: 32 },
        machine: machine(overrides),
        run: null,
        profile: { kinematics: "polar", tool: "laser", h_axis: true, r_max: 0, z_max: 0 },
        ...snapshot,
    };
}

/** The mock behind a proxy that records every call made through it. */
export function recordingApi(): { api: Api; calls: { name: string; args: unknown[] }[]; backend: MockBackend } {
    const calls: { name: string; args: unknown[] }[] = [];
    const backend = new MockBackend({ timers: false });
    const api = new Proxy(backend, {
        get(target, name: string) {
            const value = (target as unknown as Record<string, unknown>)[name];
            if (typeof value !== "function") {
                return value;
            }
            return (...args: unknown[]) => {
                calls.push({ name, args });
                return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
        },
    }) as unknown as Api;
    return { api, calls, backend };
}

export function setup() {
    const store = new Store<AppState>(initialState(true));
    const { api, calls, backend } = recordingApi();
    const ctx = createContext(api, store);
    const root = document.createElement("section");
    document.body.appendChild(root);
    const events: WsEvent[] = [];
    backend.onEvent((event) => events.push(event));
    return { store, api, calls, ctx, root, backend, events };
}

export function findButton(root: ParentNode, label: string): HTMLButtonElement {
    const button = Array.from(root.querySelectorAll("button")).find((b) => b.textContent === label);
    if (!button) {
        throw new Error(`no button ${label}`);
    }
    return button;
}

export function click(root: ParentNode, label: string): void {
    findButton(root, label).click();
}

export const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A button of the open confirm dialog. */
export function dialogButton(label: string): HTMLButtonElement {
    const dialog = document.querySelector("dialog[open]");
    if (!dialog) {
        throw new Error("no confirm dialog");
    }
    const found = Array.from(dialog.querySelectorAll("button")).find((b) => b.textContent === label);
    if (!found) {
        throw new Error(`no dialog button ${label}`);
    }
    return found;
}

/** Steps the mock until the machine is still, or gives up. */
export function runUntilIdle(backend: MockBackend, dt = 0.05, limit = 20000): void {
    let guard = 0;
    while ((backend.machine.state !== "Idle" || (backend.machine.queue.length > 0)) && guard < limit) {
        backend.step(dt);
        guard += 1;
    }
}
