// The placing panel's Repeat: a run that finished asks for the next board
// and places the same job again, never another job picked meanwhile.

import { afterEach, describe, expect, test } from "bun:test";
import type { Job, PlacingState } from "../src/types.ts";
import { mountPnpRun } from "../src/views/pnprun.ts";
import { settle, setup } from "./harness.ts";

const first = { id: "a1", name: "first board" } as unknown as Job;
const second = { id: "b2", name: "second board" } as unknown as Job;

function placing(running: boolean, state: "running" | "done"): PlacingState {
    return {
        machine: "lumen", name: "Lumen", document: null, angle: null, references: [], taken: {}, connected: true, homed: true, running,
        progress: { job: first.id, state, sent: 10, total: 10, placed: ["R1"], failed: [], steps: [], seconds: 3 },
    } as unknown as PlacingState;
}

afterEach(() => {
    document.body.replaceChildren();
    localStorage.removeItem("spinny.pnp.repeat");
    localStorage.removeItem("spinny.pnp.window");
});

describe("Repeat", () => {
    test("a run of one job that finished does not ask to place another job picked during it", async () => {
        localStorage.setItem("spinny.pnp.repeat", "1");
        localStorage.setItem("spinny.pnp.window", "0");
        const { root, store, ctx, calls } = setup();
        mountPnpRun(root, ctx);
        store.set({ job: first, placing: placing(true, "running") });
        await settle();
        // Another job picked while the first one's run goes on.
        store.set({ job: second });
        store.set({ placing: placing(false, "done") });
        for (let turn = 0; turn < 4; turn++) {
            await settle();
        }
        expect(calls.filter((call) => call.name === "pnpPlan").map((call) => call.args[0])).toEqual([]);
        expect(document.querySelector(".confirm, [role='alertdialog']")).toBeNull();
    });

    test("the job that ran is planned again for the next board", async () => {
        localStorage.setItem("spinny.pnp.repeat", "1");
        localStorage.setItem("spinny.pnp.window", "0");
        const { root, store, ctx, calls } = setup();
        mountPnpRun(root, ctx);
        store.set({ job: first, placing: placing(true, "running") });
        await settle();
        store.set({ placing: placing(false, "done") });
        for (let turn = 0; turn < 4; turn++) {
            await settle();
        }
        expect(calls.filter((call) => call.name === "pnpPlan").map((call) => call.args[0])).toEqual([first.id]);
    });
});
