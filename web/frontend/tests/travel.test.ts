import { describe, expect, test } from "bun:test";

import type { HeightMap } from "../src/types.ts";
import { freshTravel, goOnTravel, probeTravelText } from "../src/views/heightmap.ts";
import { mountJog, readTravel, travelText } from "../src/views/jog.ts";
import { connected, runUntilIdle, settle, setup } from "./harness.ts";

function partialMap(travel: number | null): HeightMap {
    return {
        grid: { x0: 0, y0: 0, x1: 10, y1: 10, nx: 2, ny: 1 },
        heights: [[-1.5, null]],
        probe_offset: [0, 0],
        focus_offset: 0,
        focus_set: false,
        travel,
    } as HeightMap;
}

describe("travel height text", () => {
    test("a blank field is off, a number within the bounds is the height, anything else is refused", () => {
        expect(readTravel("")).toEqual({ travel: null });
        expect(readTravel("  ")).toEqual({ travel: null });
        expect(readTravel("4.5")).toEqual({ travel: 4.5 });
        expect(readTravel("-2")).toEqual({ travel: -2 });
        expect("problem" in readTravel("101")).toBe(true);
        expect("problem" in readTravel("high")).toBe(true);
    });

    test("the row and the probe note say what the height does", () => {
        expect(travelText(null)).toContain("off");
        expect(travelText(3)).toContain("rise to H 3");
        expect(probeTravelText(null)).toContain("Raise the head");
        expect(probeTravelText(2)).toContain("H 2.000");
    });

    test("a fresh probing's confirm says where the head travels", () => {
        expect(freshTravel(null)).toContain("at its current height");
        expect(freshTravel(4)).toContain("H 4.000 (the travel height)");
    });

    test("going on rises to the higher of where probing began and the travel height", () => {
        expect(goOnTravel(partialMap(0.25), null)).toContain("H 0.250 (where probing began)");
        expect(goOnTravel(partialMap(0.25), 3)).toContain("H 3.000 (the travel height)");
        expect(goOnTravel(partialMap(5), 3)).toContain("H 5.000 (where probing began)");
        expect(goOnTravel(partialMap(null), 3)).toContain("H 3.000 (the travel height)");
        expect(goOnTravel(null, null)).toContain("at its current height");
    });
});

describe("travel height in the mock", () => {
    test("it is a host setting that null turns off", async () => {
        const { backend } = setup();
        await backend.connect("/dev/ttyACM0");
        expect((await backend.settings()).host.travel).toBeNull();
        await backend.updateSettings({ host: { travel: 4 } });
        expect((await backend.settings()).host.travel).toBe(4);
        await expect(backend.updateSettings({ host: { travel: 500 } })).rejects.toMatchObject({ status: 400 });
        await backend.updateSettings({ host: { travel: null } });
        expect((await backend.settings()).host.travel).toBeNull();
    });

    test("a goto across rises to it first, and a head at it is left alone", async () => {
        const { backend, events } = setup();
        await backend.connect("/dev/ttyACM0");
        await backend.updateSettings({ host: { travel: 3 } });
        const sent = (): string[] => events.flatMap((event) => (event.type === "console" && event.data.dir === "tx" ? [event.data.text] : []));
        await backend.goto({ kind: "board", x: 10, y: 0 });
        expect(sent()[0]).toBe("jogto H3");
        runUntilIdle(backend);
        expect(backend.machine.h).toBeCloseTo(3, 6);
        const before = sent().length;
        await backend.goto({ kind: "board", x: 0, y: 10 });
        expect(sent().slice(before).some((line) => line.startsWith("jogto H"))).toBe(false);
    });
});

describe("travel height row", () => {
    test("the jog panel shows it on a machine with a focus axis and writes it on a change", async () => {
        const { store, ctx, root, calls } = setup();
        store.set({ snapshot: connected() });
        mountJog(root, ctx);
        const field = root.querySelector<HTMLInputElement>('input[aria-label="Travel height H"]');
        expect(field).not.toBeNull();
        await ctx.api.connect("/dev/ttyACM0");
        field!.value = "2.5";
        field!.dispatchEvent(new Event("change"));
        await settle();
        await settle();
        expect(calls.some((call) => call.name === "updateSettings" && JSON.stringify(call.args[0]) === JSON.stringify({ host: { travel: 2.5 } }))).toBe(true);
        expect(store.get().settings?.host.travel).toBe(2.5);
        expect(root.querySelector(".travel-note")?.textContent).toContain("rise to H 2.5");
    });

    test("there is no row without a focus axis", () => {
        const { store, ctx, root } = setup();
        store.set({ snapshot: connected({}, { profile: { kinematics: "polar", tool: "laser", h_axis: false, r_max: 0, z_max: 0 } }) });
        mountJog(root, ctx);
        expect(root.querySelector('input[aria-label="Travel height H"]')).toBeNull();
    });
});
