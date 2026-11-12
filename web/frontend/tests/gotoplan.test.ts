import { describe, expect, test } from "bun:test";

import { gotoPlanText, gotoSteps, planNumber, type PlanInput } from "../src/gotoplan.ts";

const LETTERS = { r: "X", z: "Y", h: "Z", a: "A" } as const;

function gcode(here: { r: number; z: number; h: number; a?: number }, safe = 31.5): PlanInput {
    return { gcode: true, height: safe, here: { a: 0, ...here }, board: null, letters: LETTERS };
}

describe("the goto plan of a G-code machine", () => {
    test("a height alone goes straight there: no rise", () => {
        expect(gotoPlanText(gcode({ r: 10, z: 20, h: 5 }), { kind: "joint", h: 12 })).toBe("Go: Z 5 to 12.");
    });

    test("an X already reached with a height moves only the height", () => {
        expect(gotoPlanText(gcode({ r: 10, z: 20, h: 5 }), { kind: "joint", r: 10, h: 12 })).toBe("Go: Z 5 to 12.");
    });

    test("going across rises to the safe height first and puts the height last", () => {
        expect(gotoPlanText(gcode({ r: 10, z: 20, h: 5 }), { kind: "joint", r: 50, h: 4 })).toBe("Go: Z 5 to 31.5, then X 10 to 50, then Z 31.5 to 4.");
    });

    test("from above the safe height it comes down to it too (a seesaw Z)", () => {
        expect(gotoSteps(gcode({ r: 0, z: 0, h: 40 }), { kind: "joint", z: 5 })).toEqual([
            [{ letter: "Z", from: 40, to: 31.5 }],
            [{ letter: "Y", from: 0, to: 5 }],
        ]);
    });

    test("the turn goes with the move across, or alone", () => {
        expect(gotoPlanText(gcode({ r: 0, z: 0, h: 31.5 }), { kind: "joint", r: 1, a: 90 })).toBe("Go: X 0 to 1 and A 0 to 90.");
        expect(gotoPlanText(gcode({ r: 0, z: 0, h: 31.5 }), { kind: "joint", a: 90 })).toBe("Go: A 0 to 90.");
    });

    test("a board point is X and Y, and a point already reached moves nothing", () => {
        expect(gotoPlanText(gcode({ r: 3, z: 4, h: 31.5 }), { kind: "board", y: 7 })).toBe("Go: Y 4 to 7.");
        expect(gotoPlanText(gcode({ r: 3, z: 4, h: 31.5 }), { kind: "board", x: 3, y: 4 })).toBe("Go: already there.");
    });
});

describe("the goto plan on this project's firmware", () => {
    const polar = (h: number | null, travel: number | null): PlanInput => ({
        gcode: false,
        height: travel,
        here: { r: 20, a: 90, z: 0, h },
        board: { x: 0, y: 20 },
        letters: { r: "R", a: "A", z: "Z", h: "H" },
    });

    test("with no travel height the joints named go together", () => {
        expect(gotoPlanText(polar(1, null), { kind: "joint", r: 30, a: 0 })).toBe("Go: R 20 to 30 and A 90 to 0.");
    });

    test("below the travel height a move across rises first; one naming H does not", () => {
        expect(gotoPlanText(polar(1, 4), { kind: "board", x: 10 })).toBe("Go: H 1 to 4, then X 0 to 10.");
        expect(gotoPlanText(polar(1, 4), { kind: "joint", r: 30, h: 2 })).toBe("Go: R 20 to 30 and H 1 to 2.");
        expect(gotoPlanText(polar(6, 4), { kind: "joint", r: 30 })).toBe("Go: R 20 to 30.");
    });

    test("a height alone does not rise to the travel height", () => {
        expect(gotoPlanText(polar(1, 4), { kind: "joint", h: 0.5 })).toBe("Go: H 1 to 0.5.");
    });
});

test("numbers keep at most three decimals", () => {
    expect(planNumber(1.23456)).toBe("1.235");
    expect(planNumber(2)).toBe("2");
});
