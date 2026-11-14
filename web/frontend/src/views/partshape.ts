// The parts a board is lined up by on a G-code machine, and the picked
// part's shape over the top camera's picture.
//
// The set: how many parts the board is aligned to and which, kept per job
// in this browser. Choose fills it with parts spread over the board (its
// fiducials first, then each next part the one farthest from those
// chosen); a part picked can be added and any one dropped. The Board on
// the machine panel steps through the set: each part picked in turn, the
// top camera taken over it where the board's place puts it, and a
// reference taken there with Camera here.
//
// The shape: the picked part's pads and body, as its footprint in the
// board file draws them, drawn about the top camera's crosshair turned as
// the part lies on the machine (its angle in the job and the board's turn),
// so the part is lined up with the crosshair by eye before Camera here.

import { readStored, writeStored } from "../dom.ts";
import type { AppState } from "../state.ts";
import type { Component, Job, PartShape } from "../types.ts";
import type { Ctx } from "./context.ts";
import { type Calibration, type Mark, machineToPicturePoints } from "./picture.ts";
import { referenceFit } from "./pnprefs.ts";

const SHAPE_KEY = "spinny.pnp.shape";
const SET_KEY = "spinny.pnp.align.";
const COUNT_KEY = "spinny.pnp.align.count";

/** How many parts Choose picks unless set: three far apart fit a board's place and turn, and check each other. */
export const ALIGN_COUNT = 3;

/** Whether the picked part's shape is drawn over the top camera's picture: on unless turned off in this browser. */
export function readShowShape(): boolean {
    return readStored(SHAPE_KEY) !== "0";
}

export function writeShowShape(on: boolean): void {
    writeStored(SHAPE_KEY, on ? "1" : "0");
}

/** The parts a job's board is aligned to, as picked in this browser, in order. */
export function readAlignSet(job: string): string[] {
    try {
        const kept: unknown = JSON.parse(readStored(SET_KEY + job) ?? "[]");
        return Array.isArray(kept) ? kept.filter((ref): ref is string => typeof ref === "string") : [];
    } catch {
        return [];
    }
}

export function writeAlignSet(job: string, refs: string[]): void {
    writeStored(SET_KEY + job, JSON.stringify(refs));
}

/** How many parts Choose picks: the count last asked for, else ALIGN_COUNT. */
export function readAlignCount(): number {
    const count = Number(readStored(COUNT_KEY));
    return Number.isInteger(count) && count >= 1 && count <= 20 ? count : ALIGN_COUNT;
}

export function writeAlignCount(count: number): void {
    writeStored(COUNT_KEY, String(count));
}

/**
 * `count` parts spread over the board, references for lining it up: its
 * fiducials first (the farthest apart first), then the parts on `side`
 * (not dnp, not left out by the filter), each next one the one farthest
 * from those already chosen, starting from the two farthest apart.
 */
export function spreadParts(parts: Component[], count: number, side: "front" | "back" = "front"): string[] {
    const usable = parts.filter((part) => part.side === side && !part.filtered);
    const fiducials = usable.filter((part) => part.fiducial === true);
    const others = usable.filter((part) => part.fiducial !== true && !part.dnp);
    const chosen: Component[] = [];
    const distance = (a: Component, b: Component): number => Math.hypot(a.x - b.x, a.y - b.y);
    for (const pool of [fiducials, others]) {
        const left = [...pool];
        while (chosen.length < count && left.length > 0) {
            let best = 0;
            if (chosen.length === 0) {
                // The two farthest apart start the set: the first of them now.
                let far = -1;
                left.forEach((a, i) => left.forEach((b) => {
                    if (distance(a, b) > far) {
                        far = distance(a, b);
                        best = i;
                    }
                }));
            } else {
                let far = -1;
                left.forEach((part, i) => {
                    const near = Math.min(...chosen.map((other) => distance(part, other)));
                    if (near > far) {
                        far = near;
                        best = i;
                    }
                });
            }
            chosen.push(left.splice(best, 1)[0]!);
        }
    }
    return chosen.map((part) => part.ref);
}

/**
 * The board's turn on the machine, degrees, for the shape drawn: as its
 * references fit it, else as the top camera's look found it, else as the
 * corners taken of it give it, else as typed; 0 with none of them.
 */
export function boardTurn(state: AppState): number {
    const placing = state.placing;
    const job = state.job?.id ?? null;
    const parts = state.components !== null && state.components.job === job ? state.components.components : [];
    const fit = referenceFit(placing, job, parts);
    if (fit !== null) {
        return fit.rotation;
    }
    const look = placing?.top?.board_look;
    if (look && look.job === job && look.found === true && look.estimate) {
        return look.estimate.rotation;
    }
    const corners = look?.corners;
    if (corners && corners.job === job && corners.rough) {
        return corners.rough.rotation;
    }
    return placing?.angle ?? 0;
}

/**
 * A part's shape over a picture whose center sees the part's center: its
 * pads closed, its body's lines open, each offset turned by the board's
 * turn on the machine (`turn`, degrees) and seen through the camera's
 * calibration.
 */
export function shapeMarks(shape: PartShape, turn: number, calibration: Calibration, size: [number, number]): Mark[] {
    const radians = (turn * Math.PI) / 180;
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    const place = (points: [number, number][]): [number, number][] =>
        machineToPicturePoints(points.map(([x, y]) => [x * c - y * s, x * s + y * c] as [number, number]), [0, 0], calibration, size);
    const title = `${shape.ref} as its footprint draws it: line the part up with it, then press Camera here`;
    return [
        ...shape.body.filter((line) => line.length >= 2).map((line): Mark => ({ kind: "line", points: place(line), tone: "part", title })),
        ...shape.pads.filter((pad) => pad.length >= 3).map((pad): Mark => ({ kind: "line", points: place(pad), closed: true, tone: "part", title })),
    ];
}

/**
 * The shapes of the parts picked, asked of the backend once each for a job
 * as it lies (a job turned since turns its shapes): `get` gives the shape
 * when it is in, else asks for it (once) and calls `loaded` when it comes;
 * a part with none (a refused ask) gives null.
 */
export function partShapes(ctx: Ctx, loaded: () => void): { get(job: Job, ref: string): PartShape | null } {
    const kept = new Map<string, PartShape | null>();
    return {
        get(job: Job, ref: string): PartShape | null {
            const key = JSON.stringify([job.id, ref, job.design ?? null]);
            if (kept.has(key)) {
                return kept.get(key) ?? null;
            }
            kept.set(key, null);
            ctx.api.partShape(job.id, ref).then((shape) => {
                kept.set(key, shape);
                loaded();
            }, () => undefined);
            return null;
        },
    };
}
