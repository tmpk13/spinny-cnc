// The mock's looks for a board, as the backend's boardlook.py makes them:
// each pose read while the picture is over the board gives an estimate of
// where the board lies (here the truth, the mock's poses being exact), and
// the board is found once enough of them in a row agree. A pose not
// locked, or one that could not be used, breaks no run but adds none.

import { turned } from "../kinematics.ts";
import type { Board, BoardEstimate, BoardLook, Job } from "../types.ts";
import { round4 } from "./jobs.ts";
import { jobBounds } from "./vision.ts";

/** Estimates in a row that call the board found. */
export const LOOK_NEED = 5;
/** Mock time between two poses read, s. */
export const LOOK_SAMPLE_SECONDS = 0.2;
/** Mock time a search spends at one stop, s. */
export const SEARCH_STOP_SECONDS = 0.4;
/** How much of a picture the next stop's picture overlaps. */
export const SEARCH_OVERLAP = 0.3;
/** The most stops a box may take. */
export const MAX_STOPS = 400;

export type SearchBox = [number, number, number, number];

/** A job's middle (its extent's) and diagonal in its frame. */
export function jobSize(job: Job): { middle: Board; diagonal: number } {
    const bounds = jobBounds(job);
    if (bounds === null) {
        return { middle: { x: 0, y: 0 }, diagonal: 10 };
    }
    return {
        middle: { x: (bounds.x0 + bounds.x1) / 2, y: (bounds.y0 + bounds.y1) / 2 },
        diagonal: Math.max(1, Math.hypot(bounds.x1 - bounds.x0, bounds.y1 - bounds.y0)),
    };
}

/** Whether a job's point lies on its board (within its extent). */
export function onBoard(job: Job, point: Board): boolean {
    const bounds = jobBounds(job);
    return bounds !== null && point.x >= bounds.x0 && point.x <= bounds.x1 && point.y >= bounds.y0 && point.y <= bounds.y1;
}

/** The turn and shift that take the job's frame onto the machine's, from where `place` puts two of its points, with the board's middle there. */
export function estimateOf(place: (point: Board) => Board, middle: Board): BoardEstimate {
    const a = place({ x: 0, y: 0 });
    const b = place({ x: 10, y: 0 });
    const rotation = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    const center = place(middle);
    return { rotation: round4(rotation), shift: [round4(a.x), round4(a.y)], center: [round4(center.x), round4(center.y)], rms: 0 };
}

/** A job point where an estimate puts it on the machine. */
export function applyEstimate(estimate: BoardEstimate, point: Board): Board {
    const t = turned(point, estimate.rotation);
    return { x: t.x + estimate.shift[0], y: t.y + estimate.shift[1] };
}

/** The search's stops over a box for the picture's center, a picture apart less the overlap, nearest the start first, as the backend's search_stops. */
export function searchStops(box: SearchBox, view: [number, number], start: Board): Board[] {
    const [x0, y0, x1, y1] = [Math.min(box[0], box[2]), Math.min(box[1], box[3]), Math.max(box[0], box[2]), Math.max(box[1], box[3])];
    const stepX = Math.max(view[0] * (1 - SEARCH_OVERLAP), 0.1);
    const stepY = Math.max(view[1] * (1 - SEARCH_OVERLAP), 0.1);
    const nx = Math.max(1, Math.ceil((x1 - x0) / stepX - 1e-9));
    const ny = Math.max(1, Math.ceil((y1 - y0) / stepY - 1e-9));
    if (nx * ny > MAX_STOPS) {
        throw new Error(`the box needs ${nx * ny} stops of the camera's picture, more than ${MAX_STOPS}: draw a smaller box`);
    }
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const stops: Board[] = [];
    for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
            stops.push({ x: cx + (i - (nx - 1) / 2) * stepX, y: cy + (j - (ny - 1) / 2) * stepY });
        }
    }
    const distance = (point: Board): number => Math.round(Math.hypot(point.x - start.x, point.y - start.y) * 1e6) / 1e6;
    return stops.sort((a, b) => distance(a) - distance(b) || Math.atan2(a.y - start.y, a.x - start.x) - Math.atan2(b.y - start.y, b.x - start.x));
}

/** One camera's look: the job loaded, the poses read, and the run of agreeing estimates. */
export class MockBoardLook {
    job: string | null = null;
    private looks = 0;
    private locked = 0;
    private agree = 0;
    private pose: BoardLook["pose"] = null;
    private estimate: BoardEstimate | null = null;
    private view: [number, number][] | null = null;
    private seen: [number, number] | null = null;
    private problem: string | null = null;
    /** Mock time since the last pose read, s. */
    elapsed = 0;

    start(job: string): void {
        this.job = job;
        this.restart();
    }

    stop(): void {
        this.job = null;
        this.restart();
    }

    /** A fresh run: a search starts over. */
    restart(): void {
        this.looks = 0;
        this.locked = 0;
        this.agree = 0;
        this.pose = null;
        this.estimate = null;
        this.view = null;
        this.seen = null;
        this.problem = null;
    }

    get found(): boolean {
        return this.agree >= LOOK_NEED;
    }

    get best(): BoardEstimate | null {
        return this.estimate;
    }

    /** One pose read: locked over the board with the estimate it gives and the picture's corners and center in the job's frame, or not locked, or locked but not usable (`problem`). */
    see(locked: boolean, estimate: BoardEstimate | null, view: [number, number][] | null, seen: [number, number] | null, problem: string | null = null): void {
        this.looks += 1;
        this.pose = locked ? "locked" : "lost";
        this.problem = problem;
        this.view = locked ? view : null;
        this.seen = locked ? seen : null;
        if (!locked || estimate === null) {
            return;
        }
        this.locked += 1;
        const same = this.estimate !== null && Math.hypot(this.estimate.center[0] - estimate.center[0], this.estimate.center[1] - estimate.center[1]) <= 0.5;
        this.agree = same ? this.agree + 1 : 1;
        this.estimate = estimate;
    }

    /** Enough looks at once, as a stop that sees the board steadily gives them. */
    settle(estimate: BoardEstimate, view: [number, number][] | null, seen: [number, number] | null): void {
        while (!this.found) {
            this.see(true, estimate, view, seen);
        }
    }

    state(): BoardLook {
        if (this.job === null) {
            return { job: null };
        }
        return {
            job: this.job,
            looks: this.looks,
            locked: this.locked,
            pose: this.pose,
            agree: this.agree,
            need: LOOK_NEED,
            found: this.found,
            spread_mm: this.estimate ? 0 : null,
            spread_deg: this.estimate ? 0 : null,
            estimate: this.estimate ? { ...this.estimate, shift: [...this.estimate.shift], center: [...this.estimate.center] } : null,
            view: this.view ? this.view.map(([x, y]) => [x, y]) : null,
            seen: this.seen ? [this.seen[0], this.seen[1]] : null,
            problem: this.problem,
        };
    }
}
