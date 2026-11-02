import { describe, expect, test } from "bun:test";

import { depths, innerFirst, isClosed } from "../src/mock/order.ts";
import type { Path } from "../src/types.ts";

function square(x: number, y: number, size: number): Path {
    return [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]];
}

// The same cases as toolpath/tests/test_order.py, so the twins agree.
describe("inner shapes first", () => {
    test("a part's holes and marks go before its outline", () => {
        const outline = square(0, 0, 50);
        const hole = square(10, 10, 5);
        const slotInHole = square(11, 11, 1);
        const mark: Path = [[30, 30], [40, 30]];
        const otherPart = square(60, 0, 20);
        const paths = [outline, otherPart, hole, mark, slotInHole];
        expect(depths(paths)).toEqual([0, 0, 1, 1, 2]);
        expect(innerFirst(paths)).toEqual([slotInHole, hole, mark, outline, otherPart]);
    });

    test("shapes side by side keep their order", () => {
        const paths = [square(0, 0, 5), [[20, 0], [30, 0]] as Path, square(10, 0, 5)];
        expect(innerFirst(paths)).toEqual(paths);
    });

    test("a shape drawn twice does not hold itself and open paths hold nothing", () => {
        expect(depths([square(0, 0, 5), square(0, 0, 5)])).toEqual([0, 0]);
        const almost: Path = [[-1, -1], [9, -1], [9, 9], [-1, 9]];
        expect(depths([almost, square(0, 0, 5)])).toEqual([0, 0]);
        expect(isClosed(almost)).toBe(false);
        expect(isClosed(square(0, 0, 1))).toBe(true);
        const ell: Path = [[0, 0], [20, 0], [20, 5], [5, 5], [5, 20], [0, 20], [0, 0]];
        expect(depths([ell, square(1, 1, 2), square(10, 10, 2)])).toEqual([0, 1, 0]);
    });
});
