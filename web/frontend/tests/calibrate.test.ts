import { describe, expect, test } from "bun:test";

import { createContext } from "../src/main.ts";
import { MockBackend } from "../src/mock/backend.ts";
import { ladder } from "../src/mock/calibrate.ts";
import { Store, initialState, type AppState } from "../src/state.ts";
import { calibrateRequest } from "../src/views/calibrate.ts";
import { mountJobs, showsFocus } from "../src/views/jobs.ts";
import { connected } from "./harness.ts";

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("calibration test", () => {
    test("the fields make a request, a ladder whole or not at all", () => {
        expect(calibrateRequest({ kind: "material", fill: "1", "power from": "100", "power to": "400", "power steps": "4", size: "6", x: "" })).toEqual({
            kind: "material", powers: [100, 400, 4], size: 6, fill: true,
        });
        expect(calibrateRequest({ kind: "material", fill: "0", "power from": "100" })).toBe("give the power ladder its from, to and steps, or none of them");
        expect(calibrateRequest({ kind: "material", fill: "0", "speed from": "1", "speed to": "2", "speed steps": "2.5" })).toBe("speed steps must be a whole number");
        expect(calibrateRequest({ kind: "depth", fill: "1", "depth from": "0.1", "depth to": "0.3", "depth steps": "3", feed: "90" })).toEqual({
            kind: "depth", depths: [0.1, 0.3, 3], feed: 90,
        });
        expect(calibrateRequest({ kind: "depth", fill: "1", feed: "fast" })).toBe("feed is not a number");
        expect(calibrateRequest({ kind: "focus", fill: "1", "focus from": "-0.4", "focus to": "0.4", "focus steps": "5", power: "300", gap: "1" })).toEqual({
            kind: "focus", focuses: [-0.4, 0.4, 5], power: 300, gap: 1,
        });
        expect(ladder(100, 1000, 4)).toEqual([100, 400, 700, 1000]);
    });

    test("a laser makes its material test, each square a group, and the mock refuses the depth test", async () => {
        const store = new Store<AppState>(initialState(true));
        const backend = new MockBackend({ timers: false });
        const ctx = createContext(backend, store);
        const root = document.createElement("section");
        document.body.append(root);
        mountJobs(root, ctx, root);
        const panel = root.querySelector(".calibrate-test")!;
        expect(panel.classList.contains("hidden")).toBe(false);
        const steps = panel.querySelector('input[aria-label="power steps"]') as HTMLInputElement;
        steps.value = "3";
        Array.from(panel.querySelectorAll("button")).find((b) => b.textContent === "Make test job")!.click();
        for (let i = 0; i < 5; i++) {
            await settle();
        }
        const job = store.get().job;
        expect(job?.source).toBe("calibrate");
        expect(job?.groups.length).toBe(15);
        expect(job?.groups[0]!.label).toBe("test S100 F300");
        expect(job?.groups.at(-1)!.label).toBe("test S1000 F1500");
        expect(panel.querySelector(".center-test-summary")?.textContent).toContain("3 powers S100 to S1000");
        await expect(backend.calibrateJob({ kind: "depth" })).rejects.toMatchObject({ status: 400, message: "the depth test is a mill's ($spindle=1): a laser takes the material test" });
        // A fill too fine, or too many lines in all, is refused as the backend refuses it.
        await expect(backend.calibrateJob({ kind: "material", powers: [100, 100, 1], speeds: [300, 300, 1], size: 20, spot: 0.001 }))
            .rejects.toMatchObject({ status: 400, message: "the fill's pitch must be at least 0.01 mm and at most the size" });
        await expect(backend.calibrateJob({ kind: "material", powers: [100, 100, 12], speeds: [300, 300, 12], size: 100, spot: 0.05 }))
            .rejects.toMatchObject({ status: 400, message: "a fill 0.05 mm apart over 144 squares of 100 mm is 576288 points, more than 200000: give a wider pitch, or smaller or fewer squares" });
        root.remove();
    });

    test("a mill's depth test runs shallowest first whichever way it was asked, as the backend lays it", async () => {
        const backend = new MockBackend({ timers: false });
        await backend.connect("/dev/ttyACM0");
        await backend.updateSettings({ values: { spindle: 1 } });
        const made = await backend.calibrateJob({ kind: "depth", depths: [0.3, 0.05, 6] });
        const first = made.job.groups[0]!;
        expect([first.depth, first.paths[0]![0]![1]]).toEqual([0.05, 0]);
        expect(made.summary[0]!.startsWith("depth test: 6 slots 0.05 to 0.3 mm deep")).toBe(true);
        expect(made.summary[0]!.endsWith("shallowest at Y0")).toBe(true);
    });

    test("a laser with a focus axis makes a focus ladder, and each line's focus shows in the groups table", async () => {
        const store = new Store<AppState>(initialState(true));
        const backend = new MockBackend({ timers: false });
        await backend.connect("/dev/ttyACM0");
        await backend.updateSettings({ values: { h_axis: 1 } });
        const ctx = createContext(backend, store);
        const root = document.createElement("section");
        document.body.append(root);
        mountJobs(root, ctx, root);
        const panel = root.querySelector(".calibrate-test")!;
        const which = panel.querySelector('select[aria-label="Test"]') as HTMLSelectElement;
        const shown = (element: Element): boolean => !element.classList.contains("hidden");
        // No focus axis, no ladder to pick.
        store.set({ snapshot: { ...connected(), profile: { kinematics: "polar", tool: "laser", h_axis: false, r_max: 0, z_max: 0 } } });
        expect(shown(which.closest("label")!)).toBe(false);
        store.set({ snapshot: connected() });
        expect(shown(which.closest("label")!)).toBe(true);
        which.value = "focus";
        which.dispatchEvent(new Event("change"));
        const steps = panel.querySelector('input[aria-label="focus steps"]') as HTMLInputElement;
        expect(shown(steps.closest(".field-grid")!)).toBe(true);
        steps.value = "3";
        Array.from(panel.querySelectorAll("button")).find((b) => b.textContent === "Make test job")!.click();
        for (let i = 0; i < 5; i++) {
            await settle();
        }
        const job = store.get().job!;
        expect(job.groups.map((group) => group.label)).toEqual(["test focus -1 mm", "test focus 0 mm", "test focus +1 mm"]);
        expect(panel.querySelector(".center-test-summary")?.textContent).toContain("3 lines -1 to +1 mm over focus");
        const heads = Array.from(root.querySelectorAll("table.groups thead th")).map((th) => th.textContent);
        expect(heads).toContain("Focus");
        const fields = Array.from(root.querySelectorAll('input[aria-label="focus"]')) as HTMLInputElement[];
        expect(fields.map((field) => field.value)).toEqual(["-1", "0", "1"]);
        // A blank field takes the group's focus away.
        fields[0]!.value = "";
        fields[0]!.dispatchEvent(new Event("change"));
        for (let i = 0; i < 5; i++) {
            await settle();
        }
        expect((await backend.job(job.id)).groups[0]!.focus).toBeUndefined();
        expect((await backend.job(job.id)).groups[1]!.focus).toBe(0);
        // The column stays for a job with a focus set, on a machine without the axis.
        expect(showsFocus(job, false, false)).toBe(true);
        expect(showsFocus({ ...job, groups: job.groups.map((group) => ({ ...group, focus: null })) }, false, false)).toBe(false);
        expect(showsFocus(job, true, true)).toBe(false);
        root.remove();
    });
});
