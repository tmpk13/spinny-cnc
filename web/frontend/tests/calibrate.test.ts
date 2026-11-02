import { describe, expect, test } from "bun:test";

import { createContext } from "../src/main.ts";
import { MockBackend } from "../src/mock/backend.ts";
import { ladder } from "../src/mock/calibrate.ts";
import { Store, initialState, type AppState } from "../src/state.ts";
import { calibrateRequest } from "../src/views/calibrate.ts";
import { mountJobs } from "../src/views/jobs.ts";

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
        expect(ladder(100, 1000, 4)).toEqual([100, 400, 700, 1000]);
    });

    test("a laser makes its material test, each square a group, and the mock refuses the depth test", async () => {
        const store = new Store<AppState>(initialState(true));
        const backend = new MockBackend({ timers: false });
        const ctx = createContext(backend, store);
        const root = document.createElement("section");
        document.body.append(root);
        mountJobs(root, ctx);
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
        root.remove();
    });
});
