// The joint moves a job's groups become, as the backend plans them for the
// polar machine: a rapid to each path's start and a cut per chord within
// the tolerance, a joint-space path as written, and a joint polyline turned
// back into board points to draw it. The speed view, the JSON panel and the
// in-page mock all plan with these.

import { axisSnap, boardOfJoint, jointOfBoard, jointPath } from "./kinematics.ts";
import type { Group, Joint, Path, Point } from "./types.ts";

/** Board points along a joint polyline, close enough to draw it; a negative radius lands on the far side. */
export function jointPreview(poly: [number, number][], stepMm = 0.1, stepDeg = 1): Path {
    const first = poly[0];
    if (!first) {
        return [];
    }
    const point = (r: number, a: number): Point => {
        const board = boardOfJoint({ r, a });
        return [board.x, board.y];
    };
    const out: Path = [point(first[0], first[1])];
    for (let i = 0; i + 1 < poly.length; i++) {
        const [r0, a0] = poly[i] as [number, number];
        const [r1, a1] = poly[i + 1] as [number, number];
        const steps = Math.max(1, Math.ceil(Math.max(Math.abs(r1 - r0) / stepMm, Math.abs(a1 - a0) / stepDeg)));
        for (let k = 1; k <= steps; k++) {
            const t = k / steps;
            out.push(point(r0 + (r1 - r0) * t, a0 + (a1 - a0) * t));
        }
    }
    return out;
}

/** Within the resolution of a protocol line: 3 decimals of mm, 4 of degrees. */
function sameJoint(a: Joint, b: Joint): boolean {
    return Math.abs(a.r - b.r) < 0.5e-3 && Math.abs(a.a - b.a) < 0.5e-4;
}

export interface PlannedMove {
    kind: "go" | "cut";
    target: Joint;
}

/** The paths once per pass, the whole group each time rather than each path over and over. */
function perPass<T>(paths: T[], passes: number): T[] {
    const out: T[] = [];
    for (let pass = 0; pass < Math.max(1, passes); pass++) {
        out.push(...paths);
    }
    return out;
}

/**
 * The joint moves of one group from `from`: a rapid to each path's start
 * and a cut per segment within the chord tolerance. A joint-space path goes
 * out as written, with whole turns added so its start is the nearest one.
 * The group runs once per pass, each pass from where the last one ended.
 */
export function groupMoves(group: Group, from: Joint, tolerance: number): PlannedMove[] {
    const out: PlannedMove[] = [];
    let joint = from;
    if (group.joints && group.joints.length > 0) {
        for (const poly of perPass(group.joints, group.passes)) {
            const head = poly[0];
            if (!head || poly.length < 2) {
                continue;
            }
            const turns = Math.round((joint.a - head[1]) / 360);
            const joints = poly.map(([r, a]) => ({ r, a: a + 360 * turns }));
            const first = joints[0] as Joint;
            if (!sameJoint(joint, first)) {
                out.push({ kind: "go", target: first });
                joint = first;
            }
            for (const target of joints.slice(1)) {
                if (sameJoint(joint, target)) {
                    continue;
                }
                out.push({ kind: "cut", target });
                joint = target;
            }
        }
        return out;
    }
    for (const path of perPass(group.paths, group.passes)) {
        for (const move of pathMoves(path, joint, tolerance)) {
            out.push(move);
            joint = move.target;
        }
    }
    return out;
}

/**
 * The joint moves along one board path from `from`: a rapid to its start
 * unless the head is there, then its cuts; nothing for a path of fewer
 * than two points. A start within the axis snap is on the axis, as its
 * radius word says, so the move away from it is a turn, not a spiral.
 */
export function pathMoves(path: Path, from: Joint, tolerance: number): PlannedMove[] {
    const first = path[0];
    if (!first || path.length < 2) {
        return [];
    }
    const out: PlannedMove[] = [];
    let joint = from;
    let start = jointOfBoard({ x: first[0], y: first[1] }, joint);
    if (start.r < axisSnap(tolerance)) {
        start = { r: 0, a: start.a };
    }
    if (!sameJoint(joint, start)) {
        out.push({ kind: "go", target: start });
        joint = start;
    }
    for (const target of jointPath(path.slice(1), joint, tolerance)) {
        out.push({ kind: "cut", target });
        joint = target;
    }
    return out;
}
