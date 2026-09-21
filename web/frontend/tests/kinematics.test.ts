import { describe, expect, test } from "bun:test";

import {
    DEG,
    boardOfJoint,
    chordError,
    jointOfBoard,
    jointPath,
    lerpJoint,
    moveMinutes,
    segmentBoardMove,
    surfaceLength,
    tableLimitedSpeed,
    tableRateFor,
    unwrap,
} from "../src/kinematics.ts";
import type { Joint, Point } from "../src/types.ts";

function distanceToLine(p: Point, a: Point, b: Point): number {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) {
        return Math.hypot(p[0] - a[0], p[1] - a[1]);
    }
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
    return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t));
}

/** Largest distance of the joint interpolation from the board line, sampled finely. */
function replayError(joints: Joint[], from: Joint, line: [Point, Point]): number {
    let worst = 0;
    let previous = from;
    for (const joint of joints) {
        for (let i = 0; i <= 20; i++) {
            const p = boardOfJoint(lerpJoint(previous, joint, i / 20));
            worst = Math.max(worst, distanceToLine([p.x, p.y], line[0], line[1]));
        }
        previous = joint;
    }
    return worst;
}

describe("board <-> joint", () => {
    test("board of joint", () => {
        const b = boardOfJoint({ r: 10, a: 90 });
        expect(b.x).toBeCloseTo(0, 9);
        expect(b.y).toBeCloseTo(10, 9);
    });

    test("round trip", () => {
        const j = jointOfBoard({ x: 3, y: 4 });
        expect(j.r).toBeCloseTo(5, 9);
        expect(j.a).toBeCloseTo(Math.atan2(4, 3) / DEG, 9);
        const b = boardOfJoint(j);
        expect(b.x).toBeCloseTo(3, 9);
        expect(b.y).toBeCloseTo(4, 9);
    });

    test("unwrap picks the nearest representative", () => {
        expect(unwrap(10, 350)).toBe(370);
        expect(unwrap(-170, 170)).toBe(190);
        expect(unwrap(0, 0)).toBe(0);
        expect(unwrap(90, 100)).toBe(90);
        expect(unwrap(0, 720)).toBe(720);
    });

    test("angle unwraps against the previous joint", () => {
        const j = jointOfBoard({ x: 10, y: 1 }, { r: 10, a: 355 });
        expect(j.a).toBeCloseTo(360 + Math.atan2(1, 10) / DEG, 9);
    });

    test("the axis keeps the previous angle", () => {
        const j = jointOfBoard({ x: 0, y: 0 }, { r: 5, a: 123 });
        expect(j.r).toBe(0);
        expect(j.a).toBe(123);
    });
});

describe("lengths and rates", () => {
    test("surface length of a turn is the arc at the mean radius", () => {
        expect(surfaceLength({ r: 10, a: 0 }, { r: 10, a: 90 })).toBeCloseTo(10 * Math.PI / 2, 9);
        expect(surfaceLength({ r: 0, a: 0 }, { r: 10, a: 0 })).toBeCloseTo(10, 9);
    });

    test("table rate needed and the speed it allows", () => {
        expect(tableRateFor(400, 21.2)).toBeCloseTo(400 / (21.2 * DEG), 6);
        expect(tableLimitedSpeed(400, 10, 1080)).toBeCloseTo(10 * 1080 * DEG, 9);
        expect(tableLimitedSpeed(400, 30, 1080)).toBe(400);
        expect(tableRateFor(400, 0)).toBe(Infinity);
    });

    test("move time is held back by the slower axis", () => {
        // A tangential cut at r = 10 asking 400 mm/min needs 2292 deg/min; the table gives 1080.
        const minutes = moveMinutes({ r: 10, a: 0 }, { r: 10, a: 90 }, 400, 1000, 1080);
        expect(minutes).toBeCloseTo(90 / 1080, 9);
        // A radial move at 400 mm/min under the 1000 mm/min limit runs at the feed.
        expect(moveMinutes({ r: 0, a: 0 }, { r: 20, a: 0 }, 400, 1000, 1080)).toBeCloseTo(20 / 400, 9);
        // A rapid: each axis at its max rate, the longer one wins.
        expect(moveMinutes({ r: 0, a: 0 }, { r: 100, a: 180 }, null, 1000, 1080)).toBeCloseTo(180 / 1080, 9);
    });
});

describe("segmentation", () => {
    test("a short far segment is one move within tolerance", () => {
        const out = segmentBoardMove({ r: 20, a: 0 }, { x: 20, y: 0.5 }, 0.005);
        expect(out.length).toBe(1);
        expect(chordError({ r: 20, a: 0 }, out[0]!)).toBeLessThanOrEqual(0.005);
    });

    test("a long segment is split until the replay stays within tolerance", () => {
        const from: Joint = { r: 20, a: 0 };
        const to: Point = [0.5, 20];
        const joints = segmentBoardMove(from, { x: to[0], y: to[1] }, 0.005);
        expect(joints.length).toBeGreaterThan(4);
        const start = boardOfJoint(from);
        expect(replayError(joints, from, [[start.x, start.y], to])).toBeLessThan(0.005 + 0.002);
        const last = joints[joints.length - 1]!;
        expect(boardOfJoint(last).x).toBeCloseTo(0.5, 6);
        expect(boardOfJoint(last).y).toBeCloseTo(20, 6);
    });

    test("through the axis: radial in, a turn, radial out", () => {
        const joints = segmentBoardMove({ r: 10, a: 0 }, { x: -10, y: 0 }, 0.005);
        expect(joints).toEqual([{ r: 0, a: 0 }, { r: 0, a: 180 }, { r: 10, a: 180 }]);
    });

    test("leaving the axis turns first", () => {
        const joints = segmentBoardMove({ r: 0, a: 0 }, { x: 0, y: 5 }, 0.005);
        expect(joints).toEqual([{ r: 0, a: 90 }, { r: 5, a: 90 }]);
    });

    test("moving to the axis is one radial move", () => {
        const joints = segmentBoardMove({ r: 7, a: 45 }, { x: 0, y: 0 }, 0.005);
        expect(joints).toEqual([{ r: 0, a: 45 }]);
    });

    test("a path unwinds around the axis without a snap", () => {
        const square: Point[] = [[5, 5], [-5, 5], [-5, -5], [5, -5], [5, 5]];
        const joints = jointPath(square, { r: 5 * Math.SQRT2, a: 45 }, 0.005);
        let previous = 45;
        for (const joint of joints) {
            expect(Math.abs(joint.a - previous)).toBeLessThan(180);
            previous = joint.a;
        }
        expect(previous).toBeCloseTo(45 + 360, 6);
    });
});
