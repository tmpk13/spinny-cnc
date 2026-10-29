import { describe, expect, test } from "bun:test";

import type { Api } from "../src/api.ts";
import { createContext } from "../src/main.ts";
import { initialState, Store, type AppState } from "../src/state.ts";
import type { HeightMap, HeightMapState, ProbeSettings, Snapshot } from "../src/types.ts";
import { focusPrompt, mountFocusBanner } from "../src/views/banner.ts";

const SETTINGS: ProbeSettings = { depth: 5, feed: 60, slow: 15, backoff: 0.3, offset: [0, 0], rayleigh: 0.5 };

function heightMap(overrides: Partial<HeightMap> = {}): HeightMap {
    return {
        grid: { x0: -10, y0: -5, x1: 10, y1: 5, nx: 2, ny: 2 },
        heights: [[0.1, 0.2], [0.3, 0.4]],
        focus_offset: 0.2023,
        focus_set: false,
        focus_known: true,
        probe_offset: [0, 0],
        created: "2026-10-29T09:00:00+00:00",
        ...overrides,
    };
}

function mapState(map: HeightMap | null): HeightMapState {
    return { map, probe: null, settings: SETTINGS } as HeightMapState;
}

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
    return { connected: true, url: "socket://127.0.0.1:2324", firmware: { version: "0.1.0", lines: 16, blocks: 32 }, machine: null, run: null, ...overrides };
}

function stateWith(map: HeightMap | null, overrides: Partial<Snapshot> = {}): AppState {
    return { ...initialState(false), snapshot: snapshot(overrides), heightMap: mapState(map) };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("focusPrompt", () => {
    test("offers the dropped offset of a map focused once", () => {
        const prompt = focusPrompt(stateWith(heightMap()));
        expect(prompt?.keep).toBe("Keep 0.2023");
        expect(prompt?.text).toContain("focus offset (0.2023 mm) was dropped");
        expect(prompt?.text).toContain("focus here again");
    });

    test("says nothing while the offset is set, was never set, or nothing is connected", () => {
        expect(focusPrompt(stateWith(heightMap({ focus_set: true })))).toBeNull();
        expect(focusPrompt(stateWith(heightMap({ focus_known: false })))).toBeNull();
        expect(focusPrompt(stateWith(heightMap({ heights: [[0.1, null], [0.3, 0.4]] })))).toBeNull();
        expect(focusPrompt(stateWith(null))).toBeNull();
        expect(focusPrompt(stateWith(heightMap(), { connected: false }))).toBeNull();
    });

    test("names a run that stopped with an error", () => {
        const resume = { job: "e633", state: "error", sent: 637, acked: 621, total: 7718, seconds: 51, estimate: 575, group: 0 } as const;
        const prompt = focusPrompt(stateWith(heightMap(), { resume }));
        expect(prompt?.text.startsWith("Run e633 stopped at line 621 of 7718.")).toBe(true);
    });
});

describe("mountFocusBanner", () => {
    function setup(map: HeightMap) {
        const store = new Store<AppState>(initialState(false));
        const calls: string[] = [];
        const kept = mapState({ ...map, focus_set: true });
        const api = new Proxy({}, {
            get: (_, name: string) => async () => {
                calls.push(name);
                return kept;
            },
        }) as unknown as Api;
        const ctx = createContext(api, store);
        const root = document.createElement("header");
        document.body.appendChild(root);
        mountFocusBanner(root, ctx);
        const banner = root.querySelector(".banner") as HTMLElement;
        const button = (label: string): HTMLButtonElement =>
            Array.from(banner.querySelectorAll("button")).find((b) => b.textContent === label) as HTMLButtonElement;
        return { store, calls, banner, button };
    }

    test("keeps the offset on the operator's word and goes away", async () => {
        const map = heightMap();
        const { store, calls, banner, button } = setup(map);
        expect(banner.classList.contains("hidden")).toBe(true);
        store.set({ snapshot: snapshot(), heightMap: mapState(map) });
        expect(banner.classList.contains("hidden")).toBe(false);
        button("Keep 0.2023").click();
        await settle();
        expect(calls).toEqual(["keepFocus"]);
        expect(banner.classList.contains("hidden")).toBe(true);
    });

    test("stays dismissed until the offset is dropped again", () => {
        const map = heightMap();
        const { store, banner, button } = setup(map);
        store.set({ snapshot: snapshot(), heightMap: mapState(map) });
        button("Dismiss").click();
        expect(banner.classList.contains("hidden")).toBe(true);
        store.set({ snapshot: snapshot() });
        expect(banner.classList.contains("hidden")).toBe(true);
        store.set({ heightMap: mapState({ ...map, focus_set: true }) });
        store.set({ heightMap: mapState(map) });
        expect(banner.classList.contains("hidden")).toBe(false);
    });
});
