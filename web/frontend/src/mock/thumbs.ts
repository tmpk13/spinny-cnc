// A job drawn small for the job list, the backend's twin (spinny_web.thumbs)
// for the in-page mock: every group's paths in its color (the preview's
// four, in turn), a group switched off faint, a one-point path a dot, a
// model's moves by their X and Y, fitted to the box round everything with
// the board's Y up, points nearer than a 100th of the box to the last one
// kept skipped and at most MAX_POINTS drawn.

import type { Job, Point } from "../types.ts";

export const COLORS = ["#dc322f", "#268bd2", "#859900", "#6c71c4"];
export const SIZE = 64;
export const MAX_POINTS = 6000;
const STEP_SHARE = 1 / 100;

/** The job as a small SVG; an empty one when it draws nothing. */
export function thumbnail(job: Job): string {
    const groups = job.groups.map((group, index) => {
        let paths: Point[][] = group.paths.map((path) => path.map(([x, y]) => [x, y] as Point));
        if (paths.length === 0 && group.moves && group.moves.length > 0) {
            paths = group.moves.map((path) => path.map(([x, y]) => [x, y] as Point));
        }
        return { index, enabled: group.enabled, paths };
    });
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const { paths } of groups) {
        for (const path of paths) {
            for (const [x, y] of path) {
                x0 = Math.min(x0, x);
                y0 = Math.min(y0, y);
                x1 = Math.max(x1, x);
                y1 = Math.max(y1, y);
            }
        }
    }
    if (x0 > x1) {
        return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 1 1"></svg>`;
    }
    const span = Math.max(x1 - x0, y1 - y0, 1e-6);
    const margin = span * 0.06;
    const width = x1 - x0 + 2 * margin;
    const height = y1 - y0 + 2 * margin;
    const digits = Math.max(0, 3 - Math.floor(Math.log10(span)));
    const step = span * STEP_SHARE;
    const stroke = span / 60;
    const n = (v: number, d = digits): string => (v === 0 ? 0 : v).toFixed(d);
    const shapes: string[] = [];
    let left = MAX_POINTS;
    for (const { index, enabled, paths } of groups) {
        const color = COLORS[index % COLORS.length]!;
        const opacity = enabled ? "" : ' opacity="0.3"';
        const lines: string[] = [];
        const dots: string[] = [];
        for (const path of paths) {
            if (left <= 0) {
                break;
            }
            if (path.length === 1) {
                const [x, y] = path[0]!;
                dots.push(`<circle cx="${n(x)}" cy="${n(-y)}" r="${n(stroke, digits + 1)}"/>`);
                left -= 1;
                continue;
            }
            const kept: Point[] = [path[0]!];
            for (const point of path.slice(1, -1)) {
                const last = kept[kept.length - 1]!;
                if (Math.hypot(point[0] - last[0], point[1] - last[1]) >= step) {
                    kept.push(point);
                }
            }
            kept.push(path[path.length - 1]!);
            left -= kept.length;
            lines.push(`<polyline points="${kept.map(([x, y]) => `${n(x)},${n(-y)}`).join(" ")}"/>`);
        }
        if (lines.length > 0) {
            shapes.push(`<g stroke="${color}"${opacity}>${lines.join("")}</g>`);
        }
        if (dots.length > 0) {
            shapes.push(`<g fill="${color}"${opacity}>${dots.join("")}</g>`);
        }
    }
    const sizeW = width >= height ? SIZE : Math.max(1, Math.round((SIZE * width) / height));
    const sizeH = height >= width ? SIZE : Math.max(1, Math.round((SIZE * height) / width));
    const box = `${n(x0 - margin)} ${n(-(y1 + margin))} ${n(width)} ${n(height)}`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${sizeW}" height="${sizeH}" viewBox="${box}">`
        + `<g fill="none" stroke-width="${n(stroke, digits + 1)}" stroke-linecap="round" stroke-linejoin="round">${shapes.join("")}</g></svg>`;
}

/** A short key of what a job's drawing depends on, for the address it is asked at. */
export function thumbKey(summary: { stats: { length_mm: number; moves: number }; offset: { x: number; y: number }; rotation?: number; groups: { enabled: boolean; paths: number }[] }): string {
    const text = JSON.stringify([summary.stats.length_mm, summary.stats.moves, summary.offset.x, summary.offset.y, summary.rotation ?? 0, summary.groups.map((group) => [group.enabled ? 1 : 0, group.paths])]);
    let hash = 5381;
    for (let index = 0; index < text.length; index++) {
        hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0;
    }
    return hash.toString(36);
}
