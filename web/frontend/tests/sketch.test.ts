import { describe, expect, test } from "bun:test";

import { defaultOperation, movedDims, operationDims, operationSummary, sameOperation, sizeText } from "../src/sketch.ts";
import type { MillOperation } from "../src/types.ts";
import { applyState, plannedOps } from "../src/views/mill.ts";

const op = (fields: Partial<MillOperation>): MillOperation => ({ ...defaultOperation(fields.kind ?? "drill"), ...fields });

describe("an operation as a sketch", () => {
    test("a circle shows its diameter across its center", () => {
        const dims = operationDims(op({ kind: "pocket", shape: "circle", cx: 3, cy: -2, diameter: 8 }));
        expect(dims).toEqual([
            { kind: "linear", from: [-1, -2], to: [7, -2], side: 0, text: "D8" },
            { kind: "point", at: [3, -2], text: "3, -2" },
        ]);
    });

    test("a rectangle by its corners names both, its size below and beside it", () => {
        const dims = operationDims(op({ kind: "profile", x0: 10, y0: 4, x1: 0, y1: 0 }));
        expect(dims).toEqual([
            { kind: "linear", from: [0, 0], to: [10, 0], side: -1, text: "10" },
            { kind: "linear", from: [10, 0], to: [10, 4], side: -1, text: "4" },
            { kind: "point", at: [10, 4], text: "10, 4" },
            { kind: "point", at: [0, 0], text: "0, 0" },
        ]);
        // A face's corners are its rectangle's, whatever the radius says.
        expect(operationDims(op({ kind: "face", x1: 5, y1: 5, corner: 2 })).some((dim) => dim.kind === "radius")).toBe(false);
    });

    test("a line's points are numbered and its legs measured, closed back to the start", () => {
        const dims = operationDims(op({ kind: "line", points: [[0, 0], [3, 0], [3, 4]], closed: true }));
        expect(dims.filter((dim) => dim.kind === "point").map((dim) => dim.text)).toEqual(["1: 0, 0", "2: 3, 0", "3: 3, 4"]);
        expect(dims.filter((dim) => dim.kind === "linear").map((dim) => dim.text)).toEqual(["3", "4", "5"]);
        // Many points are only numbered.
        const many = operationDims(op({ kind: "drill", points: Array.from({ length: 20 }, (_, i) => [i, 0] as [number, number]) }));
        expect(many[19]).toEqual({ kind: "point", at: [19, 0], text: "20" });
        expect(operationDims(op({ kind: "holes" }))).toEqual([]);
    });

    test("the sizes go with a job turned and moved", () => {
        const dims = operationDims(op({ kind: "pocket", x0: 0, y0: 0, x1: 10, y1: 4, corner: 1 }));
        const moved = movedDims(dims, 90, 5, 0);
        const width = moved[0]!;
        expect(width.kind === "linear" && width.to.map((v) => Math.round(v * 1e9) / 1e9)).toEqual([5, 10]);
        const radius = moved.find((dim) => dim.kind === "radius")!;
        expect(radius.kind === "radius" && radius.angle).toBe(135);
        expect(movedDims(dims, 0, 0, 0)).toBe(dims);
    });

    test("a line names each operation the way the list shows it", () => {
        expect(operationSummary(op({ kind: "pocket", x0: 0, y0: 0, x1: 20, y1: 10, corner: 2 }))).toBe("pocket 20 x 10 R2 at 10, 5");
        expect(operationSummary(op({ kind: "profile", shape: "circle", side: "on", cx: 1, cy: 2, diameter: 6 }))).toBe("profile on the line D6 at 1, 2");
        expect(operationSummary(op({ kind: "drill", cutter: "laser", points: [[0, 0]] }))).toBe("mark 1 point");
        expect(operationSummary(op({ kind: "holes", holes: [[0, 0, 1], [1, 1, 1]], sizes: [1] }))).toBe("holes (2), 1 mm");
        expect(sizeText(0.1 + 0.2)).toBe("0.3");
    });

    test("two operations cut the same whatever their names and the holes filled in", () => {
        const a = op({ kind: "pocket", x1: 10, y1: 5 });
        expect(sameOperation(a, { ...a, name: "other", holes: [[1, 1, 1]] })).toBe(true);
        expect(sameOperation(a, { ...a, corner: undefined })).toBe(true);
        expect(sameOperation(a, { ...a, depth: 0.6 })).toBe(false);
        expect(sameOperation(a, { ...a, cutter: "laser" })).toBe(false);
    });
});

describe("the fields against the job", () => {
    const pocket = op({ kind: "pocket", x1: 10, y1: 5 });
    const drill = op({ kind: "drill", points: [[1, 1]] });

    test("the mark says new, outside, applied or changed", () => {
        expect(applyState(null, null, pocket)).toBe("new");
        expect(applyState([pocket], null, drill)).toBe("outside");
        expect(applyState([pocket], 0, pocket)).toBe("applied");
        expect(applyState([pocket], 0, drill)).toBe("changed");
        expect(applyState([pocket], 0, null)).toBe("changed");
        expect(applyState([pocket], 3, pocket)).toBe("outside");
    });

    test("the plan is the job with the fields in place, at the end, or alone", () => {
        expect(plannedOps(null, null, drill)).toEqual([drill]);
        expect(plannedOps([pocket], null, drill)).toEqual([pocket, drill]);
        expect(plannedOps([pocket, pocket], 1, drill)).toEqual([pocket, drill]);
    });
});
