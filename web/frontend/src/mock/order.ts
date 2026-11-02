// The page's twin of spinny_laser.order: whatever lies inside a closed
// shape is cut before the shape, so a part's holes and marks are cut while
// the sheet still holds it. Every path is ranked by how many closed shapes
// enclose it and the deepest go first; the same depth keeps its order.

import type { Path, Point } from "../types.ts";

/** Ends nearer than this, mm, close a path. */
const CLOSED_WITHIN = 1e-6;

/** A path whose ends meet, around at least three points. */
export function isClosed(path: Path): boolean {
    if (path.length < 4) {
        return false;
    }
    const [x0, y0] = path[0]!;
    const [x1, y1] = path[path.length - 1]!;
    return Math.abs(x0 - x1) <= CLOSED_WITHIN && Math.abs(y0 - y1) <= CLOSED_WITHIN;
}

function box(path: Path): [number, number, number, number] {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of path) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
    }
    return [minX, minY, maxX, maxY];
}

function area(path: Path): number {
    let total = 0;
    for (let i = 0; i + 1 < path.length; i += 1) {
        const [x0, y0] = path[i]!;
        const [x1, y1] = path[i + 1]!;
        total += x0 * y1 - x1 * y0;
    }
    return Math.abs(total) / 2;
}

/** Even-odd ray test; the polygon's last point repeats its first. */
function inside([x, y]: Point, polygon: Path): boolean {
    let result = false;
    for (let i = 0; i + 1 < polygon.length; i += 1) {
        const [x0, y0] = polygon[i]!;
        const [x1, y1] = polygon[i + 1]!;
        if ((y0 > y) !== (y1 > y) && x < x0 + ((y - y0) * (x1 - x0)) / (y1 - y0)) {
            result = !result;
        }
    }
    return result;
}

/** For each path, how many of the closed paths enclose it: larger, its box round the other's, the other's first point inside. */
export function depths(paths: Path[]): number[] {
    const closed = paths.map((path, index) => (isClosed(path) ? index : -1)).filter((index) => index >= 0);
    const boxes = new Map(closed.map((index) => [index, box(paths[index]!)]));
    const areas = new Map(closed.map((index) => [index, area(paths[index]!)]));
    return paths.map((path, i) => {
        if (path.length === 0) {
            return 0;
        }
        const own = box(path);
        const size = areas.get(i) ?? 0;
        let depth = 0;
        for (const j of closed) {
            if (j === i) {
                continue;
            }
            const [bx0, by0, bx1, by1] = boxes.get(j)!;
            if (!(bx0 <= own[0] && by0 <= own[1] && own[2] <= bx1 && own[3] <= by1) || areas.get(j)! <= size) {
                continue;
            }
            if (inside(path[0]!, paths[j]!)) {
                depth += 1;
            }
        }
        return depth;
    });
}

/** The paths with everything inside a closed shape before the shape: deepest first, the order given kept within a depth. */
export function innerFirst(paths: Path[]): Path[] {
    const ranked = depths(paths);
    return paths.map((_, index) => index).sort((a, b) => ranked[b]! - ranked[a]! || a - b).map((index) => paths[index]!);
}
