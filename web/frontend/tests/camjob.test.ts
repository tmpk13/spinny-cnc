import { describe, expect, test } from "bun:test";

import { SHIPPED_PROFILES, buildCamJob, parseProfile } from "../src/mock/cam.ts";
import type { Path } from "../src/types.ts";

const limits = { rRate: 560, aRate: 400, tolerance: 0.005 };

function shipped(id: string): string {
    return SHIPPED_PROFILES.find((profile) => profile.id === id)!.text;
}

function box(paths: Path[]): [number, number, number, number] {
    const xs = paths.flatMap((path) => path.map(([x]) => x));
    const ys = paths.flatMap((path) => path.map(([, y]) => y));
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

describe("the mock's CAM jobs", () => {
    test("a mill's bit goes round the board's outline off the board, a beam on its line", () => {
        const milled = buildCamJob("0001", parseProfile(shipped("mill-3axis"), "mill-3axis"), "coupon", "board-F_Cu.gbr", "G04*", limits).job;
        const cut = milled.groups.find((group) => group.label === "outline: board outline")!;
        expect(cut.paths.length).toBe(1);
        const loop = cut.paths[0]!;
        expect(loop[0]).toEqual(loop.at(-1)!);
        // The 1 mm end mill's middle half a millimeter out all round.
        const [x0, y0, x1, y1] = box(milled.outline);
        box(cut.paths).forEach((value, i) => expect(value).toBeCloseTo([x0 - 0.5, y0 - 0.5, x1 + 0.5, y1 + 0.5][i]!, 6));
        const burnt = buildCamJob("0002", parseProfile(shipped("polar-laser"), "polar-laser"), "coupon", "board-F_Cu.gbr", "G04*", limits).job;
        expect(burnt.groups.find((group) => group.label === "outline: board outline")!.paths).toEqual(burnt.outline);
    });
});
