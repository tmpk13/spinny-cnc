import { describe, expect, test } from "bun:test";

import type { HeightMap, HostSettings, Job, SettingsResponse } from "../src/types.ts";
import { goToPanel, mountSteps, SETUPS, setupsFor, stepStates, type Step } from "../src/views/steps.ts";
import { connected, setup } from "./harness.ts";

const step = (done: boolean): Step => ({ label: "s", done, hint: "", panel: "x" });

function job(): Job {
    return {
        id: "j1",
        name: "square",
        source: "json",
        spot: 0.1,
        offset: { x: 0, y: 0 },
        groups: [{ label: "a", power: 500, min_power: 0, speed: 400, passes: 1, enabled: true, paths: [[[-4, -3], [6, -3], [6, 2]]] }],
        outline: [],
        copper: [],
        stats: { length_mm: 0, seconds: 0, max_radius: 0, min_radius: 0, limited_fraction: 0, moves: 0 },
    };
}

function map(focusSet: boolean): HeightMap {
    return {
        grid: { x0: -10, y0: -5, x1: 10, y1: 5, nx: 2, ny: 2 },
        heights: [[0, 0.1], [0.2, 0.3]],
        focus_offset: 0,
        focus_set: focusSet,
        probe_offset: [0, 0],
    } as HeightMap;
}

function settings(host: Partial<HostSettings>): SettingsResponse {
    return { values: {}, schema: [], host: { tolerance: 0.005, ...host } };
}

describe("step states", () => {
    test("the first step not done is the next, whatever is done after it", () => {
        expect(stepStates([step(true), step(false), step(true), step(false)])).toEqual(["done", "next", "done", "todo"]);
        expect(stepStates([step(true), step(true)])).toEqual(["done", "done"]);
    });

    test("the setups offered are the ones the machine has what for", () => {
        const { store } = setup();
        const ids = (): string[] => setupsFor(SETUPS, store.get()).map((entry) => entry.id);
        expect(ids()).toEqual(["map", "mill", "camera"]);
        store.set({ snapshot: connected() });
        expect(ids()).toEqual(["map", "camera"]);
        store.set({ snapshot: connected({}, { profile: { kinematics: "cartesian", tool: "spindle", h_axis: true, r_max: 0, z_max: 0 } }) });
        expect(ids()).toEqual(["mill", "camera"]);
        store.set({ snapshot: connected({}, { profile: { kinematics: "polar", tool: "laser", h_axis: false, r_max: 0, z_max: 0 } }) });
        expect(ids()).toEqual(["camera"]);
    });
});

describe("the steps panel", () => {
    test("fills in as the page's state does, and says what the next step takes", () => {
        const { store, ctx, root } = setup();
        mountSteps(root, ctx, SETUPS, "test.steps");
        const states = (): string[] => Array.from(root.querySelectorAll(".roadmap-step")).map((item) => item.getAttribute("data-step") ?? "");
        const next = (): string => root.querySelector(".roadmap-next")?.textContent ?? "";
        // Not connected: every setup is offered, the first shown, and connecting is next.
        expect(root.querySelectorAll(".roadmap-dot").length).toBe(7);
        expect(states()[0]).toBe("next");
        expect(next()).toContain("Connect");
        store.set({ snapshot: connected() });
        expect(states().slice(0, 2)).toEqual(["done", "next"]);
        store.set({ job: job(), settings: settings({ travel: 3 }) });
        expect(states().slice(0, 4)).toEqual(["done", "done", "done", "next"]);
        store.set({ heightMap: { map: map(false), probe: null, settings: { depth: 5, feed: 60, slow: 15, backoff: 0.3, offset: [0, 0], rayleigh: 0.5 } } });
        expect(states()[3]).toBe("done");
        expect(next()).toContain("Focus here");
        store.set({ heightMap: { map: map(true), probe: null, settings: { depth: 5, feed: 60, slow: 15, backoff: 0.3, offset: [0, 0], rayleigh: 0.5 } }, mapChoice: "auto" });
        expect(states()).toEqual(["done", "done", "done", "done", "done", "done", "next"]);
        expect(root.querySelector(".roadmap-count")?.textContent).toBe("6 of 7");
        expect(root.querySelector('[aria-current="step"] .roadmap-label')?.textContent).toBe("Run");
    });

    test("the setup picked is kept, and a step takes the page to its panel", () => {
        const { store, ctx, root } = setup();
        store.set({ snapshot: connected() });
        mountSteps(root, ctx, SETUPS, "test.pick");
        const pick = root.querySelector('select[aria-label="Setup"]') as HTMLSelectElement;
        pick.value = "camera";
        pick.dispatchEvent(new Event("change"));
        expect(Array.from(root.querySelectorAll(".roadmap-label")).map((label) => label.textContent)).toEqual(["Connect", "Camera on", "Mark", "Find mark"]);
        const again = document.createElement("section");
        document.body.append(again);
        mountSteps(again, ctx, SETUPS, "test.pick");
        expect((again.querySelector('select[aria-label="Setup"]') as HTMLSelectElement).value).toBe("camera");
        const page = document.createElement("main");
        page.id = "page-config";
        page.className = "page";
        const panel = document.createElement("section");
        panel.id = "target-panel";
        panel.className = "panel";
        page.append(panel);
        document.body.append(page);
        goToPanel("target-panel");
        expect(panel.classList.contains("flash")).toBe(true);
        expect(document.querySelector('.tab[aria-selected="true"]')?.getAttribute("data-page") ?? "config").toBe("config");
    });
});
