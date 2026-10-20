// The pad map of the in-page mock: which pads of a job are probed, in what
// order, the grid that stands for them, and how the probed heights fill
// that grid in, the way the backend does it: a plane through the probed
// pads plus the nearest pads' deviations from it, weighted by the inverse
// square of their distance, so the map reads the probed height at a pad
// and bends smoothly between them.

import type { Grid, HeightMap, Job, PadPoint } from "../types.ts";
import { shortTour } from "./jobs.ts";

/** Pads under this area are left out, mm^2. */
export const MIN_AREA = { low: 0.05, high: 1000, fallback: 0.5 };
/** Over this many pads, the most spread out of them are probed. */
export const MAX_POINTS = { low: 2, high: 2500, fallback: 100 };
/** The pad map's grid: about this far between points, and this far past the job. */
export const PAD_GRID_SPACING = 2;
export const PAD_GRID_MARGIN = 1;
/** How many probed pads bend the plane at a grid point. */
const NEAREST_PADS = 8;

/**
 * The pads probed: every one of at least `minArea`, and when there are more
 * than `maxPoints`, the most spread out of them (the largest first, then
 * each time the pad farthest from those picked), in a short tour.
 */
export function selectPads(pads: PadPoint[], minArea: number, maxPoints: number): { points: [number, number][]; skipped: number } {
    const large = pads.filter((pad) => pad[2] >= minArea);
    const skipped = pads.length - large.length;
    let chosen = large;
    if (large.length > maxPoints) {
        const picked: PadPoint[] = [];
        const left = large.slice().sort((a, b) => b[2] - a[2]);
        picked.push(left.shift()!);
        while (picked.length < maxPoints && left.length > 0) {
            let bestIndex = 0;
            let bestDistance = -1;
            left.forEach((pad, index) => {
                const nearest = Math.min(...picked.map((other) => Math.hypot(other[0] - pad[0], other[1] - pad[1])));
                if (nearest > bestDistance) {
                    bestDistance = nearest;
                    bestIndex = index;
                }
            });
            picked.push(left.splice(bestIndex, 1)[0]!);
        }
        chosen = picked;
    }
    return { points: shortTour(chosen).map(([x, y]) => [x, y] as [number, number]), skipped };
}

/** The grid a pad map carries: the job's extent and the points' with a margin, at about the spacing. */
export function padMapGrid(job: Job, points: [number, number][]): Grid {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const take = (x: number, y: number): void => {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
    };
    for (const [x, y] of points) {
        take(x, y);
    }
    for (const group of job.groups) {
        for (const path of group.paths) {
            for (const [x, y] of path) {
                take(x, y);
            }
        }
    }
    for (const path of job.outline) {
        for (const [x, y] of path) {
            take(x, y);
        }
    }
    const round = (value: number): number => Math.round(value * 1000) / 1000;
    x0 = round(x0 - PAD_GRID_MARGIN);
    y0 = round(y0 - PAD_GRID_MARGIN);
    x1 = round(x1 + PAD_GRID_MARGIN);
    y1 = round(y1 + PAD_GRID_MARGIN);
    const count = (span: number): number => Math.max(2, Math.min(50, Math.round(span / PAD_GRID_SPACING) + 1));
    return { x0, y0, x1, y1, nx: count(x1 - x0), ny: count(y1 - y0) };
}

/** The least squares plane z = a x + b y + c through the points; a flat one at their mean with fewer than three, or three in a line. */
export function fitPlane(points: { x: number; y: number; z: number }[]): { a: number; b: number; c: number } {
    const n = points.length;
    if (n === 0) {
        return { a: 0, b: 0, c: 0 };
    }
    const mean = points.reduce((sum, p) => sum + p.z, 0) / n;
    if (n < 3) {
        return { a: 0, b: 0, c: mean };
    }
    const mx = points.reduce((sum, p) => sum + p.x, 0) / n;
    const my = points.reduce((sum, p) => sum + p.y, 0) / n;
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    let sxz = 0;
    let syz = 0;
    for (const p of points) {
        const dx = p.x - mx;
        const dy = p.y - my;
        const dz = p.z - mean;
        sxx += dx * dx;
        sxy += dx * dy;
        syy += dy * dy;
        sxz += dx * dz;
        syz += dy * dz;
    }
    const det = sxx * syy - sxy * sxy;
    if (Math.abs(det) < 1e-12) {
        return { a: 0, b: 0, c: mean };
    }
    const a = (sxz * syy - syz * sxy) / det;
    const b = (syz * sxx - sxz * sxy) / det;
    return { a, b, c: mean - a * mx - b * my };
}

/** Fills the pad map's grid heights in from its probed points; a map with none probed stays null throughout. */
export function fillPadHeights(map: HeightMap): void {
    const points = map.points ?? [];
    const heights = map.point_heights ?? [];
    const probed = points
        .map(([x, y], index) => ({ x, y, z: heights[index] ?? null }))
        .filter((p): p is { x: number; y: number; z: number } => p.z !== null);
    const grid = map.grid;
    if (probed.length === 0) {
        map.heights = Array.from({ length: grid.ny }, () => Array<number | null>(grid.nx).fill(null));
        return;
    }
    const plane = fitPlane(probed);
    const at = (x: number, y: number): number => plane.a * x + plane.b * y + plane.c;
    const deviations = probed.map((p) => ({ x: p.x, y: p.y, d: p.z - at(p.x, p.y) }));
    const out: (number | null)[][] = [];
    for (let iy = 0; iy < grid.ny; iy++) {
        const row: (number | null)[] = [];
        const y = grid.ny === 1 ? grid.y0 : grid.y0 + ((grid.y1 - grid.y0) * iy) / (grid.ny - 1);
        for (let ix = 0; ix < grid.nx; ix++) {
            const x = grid.nx === 1 ? grid.x0 : grid.x0 + ((grid.x1 - grid.x0) * ix) / (grid.nx - 1);
            const nearest = deviations
                .map((p) => ({ d: p.d, distance: Math.hypot(p.x - x, p.y - y) }))
                .sort((a, b) => a.distance - b.distance)
                .slice(0, NEAREST_PADS);
            const exact = nearest.find((p) => p.distance < 1e-9);
            let bend: number;
            if (exact) {
                bend = exact.d;
            } else {
                let weighted = 0;
                let weights = 0;
                for (const p of nearest) {
                    const w = 1 / (p.distance * p.distance);
                    weighted += w * p.d;
                    weights += w;
                }
                bend = weights > 0 ? weighted / weights : 0;
            }
            row.push(Math.round((at(x, y) + bend) * 10000) / 10000);
        }
        out.push(row);
    }
    map.heights = out;
}
