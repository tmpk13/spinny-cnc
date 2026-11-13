// A job's lists of points packed flat for the drawing worker. Posting a job
// as it is copies every [x, y] pair one by one: 400,000 points held the page
// up for 140 ms. Packed, each list is one typed array of coordinates and one
// of where each path starts, written in a few milliseconds and handed over
// without a copy; the worker unpacks them into the job the renderer reads.

import type { Move, Point } from "../types.ts";
import type { RenderGroup, RenderJob } from "./scene.ts";

/** Paths flat: `width` numbers a point, one path after another, path i's points from offsets[i] to offsets[i + 1]. */
export interface PackedPaths {
    width: number;
    coords: Float64Array;
    offsets: Uint32Array;
}

export interface PackedGroup {
    enabled: boolean;
    speed: number;
    passes: number;
    paths: PackedPaths;
    moves?: PackedPaths;
    joints?: PackedPaths;
    areas?: Float64Array;
}

export interface PackedJob {
    spot: number;
    source: string;
    groups: PackedGroup[];
    outline: PackedPaths;
    copper: PackedPaths;
}

/** Paths of points `width` numbers long, packed. */
export function packPaths(paths: readonly (readonly (readonly number[])[])[], width: number): PackedPaths {
    let points = 0;
    for (const path of paths) {
        points += path.length;
    }
    const coords = new Float64Array(points * width);
    const offsets = new Uint32Array(paths.length + 1);
    let at = 0;
    paths.forEach((path, index) => {
        offsets[index] = at / width;
        for (const point of path) {
            for (let k = 0; k < width; k++) {
                coords[at + k] = point[k] ?? 0;
            }
            at += width;
        }
    });
    offsets[paths.length] = at / width;
    return { width, coords, offsets };
}

/** Packed paths back as lists of points. */
export function unpackPaths<T extends readonly number[]>(packed: PackedPaths): T[][] {
    const { width, coords, offsets } = packed;
    const paths: T[][] = [];
    for (let index = 0; index + 1 < offsets.length; index++) {
        const path: number[][] = [];
        for (let at = offsets[index]! * width, end = offsets[index + 1]! * width; at < end; at += width) {
            if (width === 2) {
                path.push([coords[at]!, coords[at + 1]!]);
            } else if (width === 4) {
                path.push([coords[at]!, coords[at + 1]!, coords[at + 2]!, coords[at + 3]!]);
            } else {
                path.push(Array.from(coords.subarray(at, at + width)));
            }
        }
        paths.push(path as unknown as T[]);
    }
    return paths;
}

/** A job as the worker is sent it, and the buffers to hand over with it. */
export function packJob(job: RenderJob): { packed: PackedJob; transfer: ArrayBuffer[] } {
    const transfer: ArrayBuffer[] = [];
    const take = (packed: PackedPaths): PackedPaths => {
        transfer.push(packed.coords.buffer as ArrayBuffer, packed.offsets.buffer as ArrayBuffer);
        return packed;
    };
    const groups = job.groups.map((group): PackedGroup => {
        const packed: PackedGroup = { enabled: group.enabled, speed: group.speed, passes: group.passes, paths: take(packPaths(group.paths, 2)) };
        if (group.moves) {
            packed.moves = take(packPaths(group.moves, 4));
        }
        if (group.joints) {
            packed.joints = take(packPaths(group.joints, 2));
        }
        if (group.areas) {
            packed.areas = Float64Array.from(group.areas);
            transfer.push(packed.areas.buffer as ArrayBuffer);
        }
        return packed;
    });
    return {
        packed: { spot: job.spot, source: job.source, groups, outline: take(packPaths(job.outline, 2)), copper: take(packPaths(job.copper, 2)) },
        transfer,
    };
}

export function unpackJob(packed: PackedJob): RenderJob {
    return {
        spot: packed.spot,
        source: packed.source,
        groups: packed.groups.map((group): RenderGroup => {
            const unpacked: RenderGroup = { enabled: group.enabled, speed: group.speed, passes: group.passes, paths: unpackPaths<Point>(group.paths) };
            if (group.moves) {
                unpacked.moves = unpackPaths<Move>(group.moves);
            }
            if (group.joints) {
                unpacked.joints = unpackPaths<[number, number]>(group.joints);
            }
            if (group.areas) {
                unpacked.areas = Array.from(group.areas);
            }
            return unpacked;
        }),
        outline: unpackPaths<Point>(packed.outline),
        copper: unpackPaths<Point>(packed.copper),
    };
}
