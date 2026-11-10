// How fast every cut of a job goes, for the preview's speed view: each
// group's paths taken through the moves the machine makes of them, every
// move given the speed it runs at and the speed its group asks for. On the
// polar machine a move's time is the longest of the board length at the
// group's speed, the radius change at the rail's rate and the turn at the
// table's (the table is the bottleneck near the axis, where a short board
// move is a long turn); on a cartesian one it is the board length at the
// speed each axis allows along the move's direction. A move slower than
// its group asks is capped. These are the same sums the job's stats make.

import { boardOfJoint, moveMinutes, surfaceLength } from "./kinematics.ts";
import { groupMoves, jointPreview } from "./mock/jobs.ts";
import type { Job, Joint, Kinematics, Point } from "./types.ts";

/** The rates a machine moves at, mm/min (degrees a minute for the table), and the chord tolerance the moves are planned to. */
export interface SpeedLimits {
    kinematics: Kinematics;
    rRate: number;
    aRate: number;
    /** The cross slide's rate, the board's Y on a cartesian machine. */
    zRate: number;
    tolerance: number;
    /** The rates are the defaults, no machine's settings having been read. */
    assumed?: boolean;
}

/** One move of a cut, on the board, with the speed it runs at and the one its group asks for, mm/min. */
export interface SpeedSegment {
    from: Point;
    to: Point;
    speed: number;
    wanted: number;
}

export interface SpeedMap {
    segments: SpeedSegment[];
    slowest: number;
    fastest: number;
    /** Cut length, and the part of it a rate holds below its group's speed, mm. */
    length: number;
    cappedLength: number;
}

/** Below this share of the speed asked for, a move counts as capped: rounding is not a cap. */
const CAPPED_SHARE = 1 - 1e-6;

export function isCapped(segment: SpeedSegment): boolean {
    return segment.speed < segment.wanted * CAPPED_SHARE;
}

/** The speed a cartesian machine runs a board move at: its group's, or less where an axis's rate holds it back. */
function cartesianSpeed(dx: number, dy: number, wanted: number, limits: SpeedLimits): number {
    const length = Math.hypot(dx, dy);
    if (length === 0) {
        return wanted;
    }
    let speed = wanted;
    if (dx !== 0) {
        speed = Math.min(speed, limits.rRate * (length / Math.abs(dx)));
    }
    if (dy !== 0) {
        speed = Math.min(speed, limits.zRate * (length / Math.abs(dy)));
    }
    return speed;
}

/** Every cut move of the job's groups that are on, with its speed; a model's moves and dots are left out. */
export function speedMap(job: Job, limits: SpeedLimits): SpeedMap {
    const segments: SpeedSegment[] = [];
    let length = 0;
    let cappedLength = 0;
    let joint: Joint = { r: 0, a: 0 };
    for (const group of job.groups) {
        if (!group.enabled || (group.moves?.length ?? 0) > 0 || group.speed <= 0) {
            continue;
        }
        if (limits.kinematics === "cartesian") {
            for (const path of group.paths) {
                for (let index = 1; index < path.length; index++) {
                    const from = path[index - 1]!;
                    const to = path[index]!;
                    const dx = to[0] - from[0];
                    const dy = to[1] - from[1];
                    const step = Math.hypot(dx, dy);
                    if (step === 0) {
                        continue;
                    }
                    const segment = { from, to, speed: cartesianSpeed(dx, dy, group.speed, limits), wanted: group.speed };
                    segments.push(segment);
                    length += step;
                    cappedLength += isCapped(segment) ? step : 0;
                }
            }
            continue;
        }
        // A board path's moves are within the chord tolerance of their
        // line, but a joint-space group's are its joint pairs as written:
        // an arc or a spiral on the board, drawn through the points its
        // group's drawing is sampled at.
        const jointSpace = (group.joints?.length ?? 0) > 0;
        // Each pass runs the same moves: one is enough to know their speeds.
        for (const move of groupMoves({ ...group, passes: 1 }, joint, limits.tolerance)) {
            if (move.kind === "cut") {
                const step = surfaceLength(joint, move.target);
                const minutes = moveMinutes(joint, move.target, group.speed, limits.rRate, limits.aRate);
                if (step > 0 && minutes > 0) {
                    const points: Point[] = jointSpace
                        ? jointPreview([[joint.r, joint.a], [move.target.r, move.target.a]])
                        : [joint, move.target].map((end): Point => {
                            const board = boardOfJoint(end);
                            return [board.x, board.y];
                        });
                    const speed = step / minutes;
                    for (let index = 1; index < points.length; index++) {
                        segments.push({ from: points[index - 1]!, to: points[index]!, speed, wanted: group.speed });
                    }
                    length += step;
                    cappedLength += isCapped({ from: points[0]!, to: points[1]!, speed, wanted: group.speed }) ? step : 0;
                }
            }
            joint = move.target;
        }
    }
    let slowest = Infinity;
    let fastest = 0;
    for (const segment of segments) {
        slowest = Math.min(slowest, segment.speed);
        fastest = Math.max(fastest, segment.speed);
    }
    return { segments, slowest: Number.isFinite(slowest) ? slowest : 0, fastest, length, cappedLength };
}

/** The speed view's colors, slowest first: Solarized violet, blue, cyan, green and yellow, leaving red for the capped mark. */
export const SPEED_COLORS = ["#6c71c4", "#268bd2", "#2aa198", "#859900", "#b58900"];

/** Which of the colors a speed takes between the job's slowest and fastest. */
export function speedBucket(speed: number, slowest: number, fastest: number): number {
    const buckets = SPEED_COLORS.length;
    if (!(fastest > slowest)) {
        return buckets - 1;
    }
    const share = (speed - slowest) / (fastest - slowest);
    return Math.min(buckets - 1, Math.max(0, Math.floor(share * buckets)));
}
