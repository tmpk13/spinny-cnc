// Board <-> joint geometry. Board (x, y) is mm with the rotation axis at the
// origin; the joint is the radius r along the rail and the table angle a in
// degrees, so x = r cos a and y = r sin a.

import type { Board, Joint, Point } from "./types.ts";

export const DEG = Math.PI / 180;

/** Inside this radius a point has no angle of its own. */
export const AXIS_EPSILON = 1e-6;

/** Bisection stops here even when the chord error is still over the tolerance. */
const MAX_DEPTH = 24;
const MIN_SEGMENT = 1e-3;

export function boardOfJoint(joint: Joint): Board {
    const rad = joint.a * DEG;
    return { x: joint.r * Math.cos(rad), y: joint.r * Math.sin(rad) };
}

/** The representative of `angle` nearest `previous`, so a move never swings over half a turn. */
export function unwrap(angle: number, previous: number): number {
    const turns = Math.round((previous - angle) / 360);
    return angle + turns * 360;
}

/** Joint for a board point; on the axis the angle is kept from `previous`. */
export function jointOfBoard(board: Board, previous?: Joint): Joint {
    const r = Math.hypot(board.x, board.y);
    const before = previous ? previous.a : 0;
    if (r < AXIS_EPSILON) {
        return { r: 0, a: before };
    }
    const a = Math.atan2(board.y, board.x) / DEG;
    return { r, a: unwrap(a, before) };
}

export function lerpJoint(from: Joint, to: Joint, t: number): Joint {
    return { r: from.r + (to.r - from.r) * t, a: from.a + (to.a - from.a) * t };
}

/** Board length of a joint move as the firmware measures it: hypot(dr, r_mean * da). */
export function surfaceLength(from: Joint, to: Joint): number {
    const rMean = (from.r + to.r) / 2;
    return Math.hypot(to.r - from.r, rMean * (to.a - from.a) * DEG);
}

/** Table rate in deg/min needed for a tangential cut at `speed` mm/min and radius `r`. */
export function tableRateFor(speed: number, r: number): number {
    if (r < AXIS_EPSILON) {
        return Infinity;
    }
    return speed / (r * DEG);
}

/** Surface speed a tangential cut can reach at radius `r` under a table limit of `aRate` deg/min. */
export function tableLimitedSpeed(speed: number, r: number, aRate: number): number {
    return Math.min(speed, r * aRate * DEG);
}

/**
 * Time in minutes for a joint move at surface speed `feed`, held back by the
 * axis rate limits; a move without board length runs at the max rates.
 */
export function moveMinutes(from: Joint, to: Joint, feed: number | null, rRate: number, aRate: number): number {
    const length = surfaceLength(from, to);
    const radial = Math.abs(to.r - from.r) / rRate;
    const turn = Math.abs(to.a - from.a) / aRate;
    const wanted = feed !== null && feed > 0 && length >= AXIS_EPSILON ? length / feed : 0;
    return Math.max(wanted, radial, turn);
}

/** Largest distance between the joint interpolation and the board chord, sampled at the quarter points. */
export function chordError(from: Joint, to: Joint): number {
    const p0 = boardOfJoint(from);
    const p1 = boardOfJoint(to);
    let worst = 0;
    for (const t of [0.25, 0.5, 0.75]) {
        const p = boardOfJoint(lerpJoint(from, to, t));
        const lx = p0.x + (p1.x - p0.x) * t;
        const ly = p0.y + (p1.y - p0.y) * t;
        worst = Math.max(worst, Math.hypot(p.x - lx, p.y - ly));
    }
    return worst;
}

function distanceToSegment(px: number, py: number, a: Board, b: Board): { distance: number; t: number } {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared < AXIS_EPSILON * AXIS_EPSILON) {
        return { distance: Math.hypot(px - a.x, py - a.y), t: 0 };
    }
    const t = Math.min(1, Math.max(0, ((px - a.x) * dx + (py - a.y) * dy) / lengthSquared));
    const x = a.x + dx * t;
    const y = a.y + dy * t;
    return { distance: Math.hypot(px - x, py - y), t };
}

/**
 * Splits a straight board move into joint moves that each stay within
 * `tolerance` of the line. A move through the axis becomes a radial move in,
 * a turn on the spot, and a radial move out; a move leaving the axis starts
 * with the turn. The returned list holds the joint targets in order.
 */
export function segmentBoardMove(from: Joint, to: Board, tolerance: number): Joint[] {
    const out: Joint[] = [];
    const start = boardOfJoint(from);
    const hit = distanceToSegment(0, 0, start, to);
    if (hit.distance < AXIS_EPSILON && from.r >= AXIS_EPSILON && Math.hypot(to.x, to.y) >= AXIS_EPSILON) {
        // Through the axis: the part before it is purely radial.
        const inward: Joint = { r: 0, a: from.a };
        out.push(inward);
        bisect(inward, to, tolerance, 0, out);
        return out;
    }
    bisect(from, to, tolerance, 0, out);
    return out;
}

function bisect(from: Joint, to: Board, tolerance: number, depth: number, out: Joint[]): void {
    const target = jointOfBoard(to, from);
    if (from.r < AXIS_EPSILON) {
        // Leaving the axis: turn first, then move out radially.
        if (Math.abs(target.a - from.a) > AXIS_EPSILON) {
            out.push({ r: 0, a: target.a });
        }
        if (target.r >= AXIS_EPSILON) {
            out.push(target);
        }
        return;
    }
    const start = boardOfJoint(from);
    const length = Math.hypot(to.x - start.x, to.y - start.y);
    if (target.r < AXIS_EPSILON || length < MIN_SEGMENT || depth >= MAX_DEPTH || chordError(from, target) <= tolerance) {
        out.push(target);
        return;
    }
    const mid: Board = { x: (start.x + to.x) / 2, y: (start.y + to.y) / 2 };
    bisect(from, mid, tolerance, depth + 1, out);
    const last = out[out.length - 1] ?? from;
    bisect(last, to, tolerance, depth + 1, out);
}

/** Board polyline points to joint targets, one list per path. */
export function jointPath(path: Point[], from: Joint, tolerance: number): Joint[] {
    const out: Joint[] = [];
    let current = from;
    for (const [x, y] of path) {
        const segments = segmentBoardMove(current, { x, y }, tolerance);
        for (const joint of segments) {
            out.push(joint);
            current = joint;
        }
    }
    return out;
}
