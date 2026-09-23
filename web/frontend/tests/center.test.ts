import { describe, expect, test } from "bun:test";

import { HttpApi } from "../src/api.ts";
import { createContext } from "../src/main.ts";
import { MockBackend } from "../src/mock.ts";
import { Store, initialState, type AppState } from "../src/state.ts";
import { centerRequest, type CenterFields } from "../src/views/center.ts";
import { mountJobs } from "../src/views/jobs.ts";

function fields(overrides: Partial<CenterFields> = {}): CenterFields {
    return {
        fine: false,
        lines: "4",
        reach: "",
        ring: "",
        angle: "3",
        cross: "4",
        arm: "2.5",
        spiral: "5",
        errorAlong: "",
        errorAcross: "",
        power: "400",
        speed: "200",
        spot: "0.1",
        ...overrides,
    };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("center request", () => {
    test("the coarse pattern sends its own options and leaves blanks to the backend", () => {
        expect(centerRequest(fields({ lines: "6", ring: "0" }))).toEqual({ fine: false, lines: 6, ring: 0, power: 400, speed: 200, spot: 0.1 });
    });

    test("the fine pattern sends its dimensions and the error to show, not the lines", () => {
        expect(centerRequest(fields({ fine: true, reach: "8", errorAlong: "0.02" }))).toEqual({
            fine: true, reach: 8, power: 400, speed: 200, spot: 0.1, angle: 3, cross: 4, arm: 2.5, spiral: 5, show_error: [0.02, 0],
        });
    });

    test("a field that is not a number is named", () => {
        expect(centerRequest(fields({ speed: "fast" }))).toBe("speed is not a number");
        expect(centerRequest(fields({ lines: "2.5" }))).toBe("lines must be a whole number");
        expect(centerRequest(fields({ fine: true, errorAcross: "x" }))).toBe("error Z is not a number");
    });
});

describe("center api", () => {
    test("posts the request as json", async () => {
        const calls: { url: string; body: unknown }[] = [];
        const api = new HttpApi("", async (url, init) => {
            calls.push({ url, body: JSON.parse(String(init?.body)) });
            return new Response(JSON.stringify({ job: { id: "c1" }, summary: [], notes: [] }), { status: 200 });
        });
        const result = await api.centerJob({ fine: true, spiral: 0 });
        expect(result.job.id).toBe("c1");
        expect(calls).toEqual([{ url: "/api/center", body: { fine: true, spiral: 0 } }]);
    });
});

describe("center mock", () => {
    test("builds the coarse pattern and refuses the fine one", async () => {
        const backend = new MockBackend({ timers: false });
        const result = await backend.centerJob({ lines: 4 });
        expect(result.job.groups.map((g) => g.paths.length)).toEqual([4, 1]);
        expect(result.job.groups[1]!.speed).toBeLessThan(200);
        expect((await backend.jobs()).some((j) => j.id === result.job.id)).toBe(true);
        await expect(backend.centerJob({ lines: 1 })).rejects.toThrow("at least two lines");
        await expect(backend.centerJob({ fine: true })).rejects.toThrow("real backend");
    });
});

describe("center panel", () => {
    test("makes the job, selects it and shows how to read it", async () => {
        const store = new Store<AppState>(initialState(true));
        const backend = new MockBackend({ timers: false });
        const ctx = createContext(backend, store);
        const root = document.createElement("section");
        document.body.append(root);
        mountJobs(root, ctx);
        const panel = root.querySelector(".center-test")!;
        const inputs = Array.from(panel.querySelectorAll("input"));
        const fine = inputs[0]!;
        const lines = inputs[1]!;
        const angle = inputs[4]!;
        expect(angle.disabled).toBe(true);
        fine.checked = true;
        fine.dispatchEvent(new Event("change"));
        expect(lines.disabled).toBe(true);
        expect(angle.disabled).toBe(false);
        fine.checked = false;
        fine.dispatchEvent(new Event("change"));
        lines.value = "6";
        Array.from(panel.querySelectorAll("button")).find((b) => b.textContent === "Make test job")!.click();
        for (let i = 0; i < 5; i++) {
            await settle();
        }
        const job = store.get().job;
        expect(job?.source).toBe("center");
        expect(job?.groups[0]!.paths.length).toBe(6);
        expect(panel.querySelector(".center-test-summary")?.textContent).toContain("6 lines");
        root.remove();
    });
});
