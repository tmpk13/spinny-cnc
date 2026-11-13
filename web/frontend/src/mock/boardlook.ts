// The mock's looks for a board, as the backend's boardlook.py makes them:
// each pose read while the picture is over the board gives an estimate of
// where the board lies (here the truth, the mock's poses being exact, but
// for a look now and then a pitch off, as a repeated pattern makes pcbv
// do), the estimates are sorted into guesses, and the board is found once
// the most likely guess has enough looks and the camera's threshold of the
// evidence. Corners taken by hand rule out the guesses that put one
// elsewhere, and give a rough place of their own.

import { fitRigid } from "../align.ts";
import { turned } from "../kinematics.ts";
import type { Board, BoardCorners, BoardEstimate, BoardGuess, BoardLook, CornerName, Job } from "../types.ts";
import { round4 } from "./jobs.ts";
import { jobBounds } from "./vision.ts";

/** The looks one guess needs to be called found, and the newest estimates the guesses are made from. */
export const LOOK_NEED = 5;
export const LOOK_HISTORY = 40;
/** The most guesses told to the page. */
export const LOOK_GUESSES = 8;
/** Estimates make one guess when their middles lie within this of one another, mm, and their turns within this, degrees. */
const AGREE_MM = 0.5;
const AGREE_DEG = 1;
/** A camera's look settings when it says none, as the backend's. */
export const LOOK_THRESHOLD = 0.5;
export const CORNER_MM = 2;
/** The mock's watchers see the board a pitch off at every this many locked looks. */
export const PITCH_OFF_EVERY = 7;
export const PITCH_MM = 2.54;
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

/** A job point back from where an estimate puts it on the machine. */
export function unapplyEstimate(estimate: BoardEstimate, point: [number, number]): [number, number] {
    const back = turned({ x: point[0] - estimate.shift[0], y: point[1] - estimate.shift[1] }, -estimate.rotation);
    return [back.x, back.y];
}

/** Where corners taken by hand put the board, as the backend's rough_place: two or more fit the turn, one keeps the board square. */
export function roughPlace(points: { job: [number, number]; machine: [number, number]; angle?: number }[], middle: Board): BoardEstimate | null {
    if (points.length === 0) {
        return null;
    }
    // One corner found by its edges carries the board's turn.
    const angle = points.length === 1 ? points[0]!.angle ?? null : null;
    const fit = fitRigid(points.map((point) => ({ design: point.job, machine: point.machine })), angle);
    const t = turned(middle, fit.rotation);
    return {
        rotation: round4(fit.rotation),
        shift: [round4(fit.shift[0]), round4(fit.shift[1])],
        center: [round4(t.x + fit.shift[0]), round4(t.y + fit.shift[1])],
        rms: round4(fit.rms),
        match: 1,
    };
}

/** The box on the machine that holds a job's extent where `place` puts it, grown by `margin` mm. */
export function roughBox(job: Job, place: BoardEstimate, margin: number): SearchBox | null {
    const bounds = jobBounds(job);
    if (bounds === null) {
        return null;
    }
    const points = [[bounds.x0, bounds.y0], [bounds.x1, bounds.y0], [bounds.x1, bounds.y1], [bounds.x0, bounds.y1]].map(([x, y]) => applyEstimate(place, { x: x!, y: y! }));
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    return [Math.min(...xs) - margin, Math.min(...ys) - margin, Math.max(...xs) + margin, Math.max(...ys) + margin];
}

interface Guess {
    estimate: BoardEstimate;
    looks: number;
    weight: number;
    spreadMm: number;
    spreadDeg: number;
    newest: number;
    probability: number;
    cornerMm: number | null;
    ruledOut: boolean;
}

/** The newest picture's corners (clockwise from its top left) and center on the machine. */
export interface MachinePicture {
    corners: [number, number][];
    center: [number, number];
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const half = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[half]! : (sorted[half - 1]! + sorted[half]!) / 2;
}

function wrap(degrees: number): number {
    return ((((degrees + 180) % 360) + 360) % 360) - 180;
}

/** One camera's look: the job loaded, the poses read, the estimates sorted into guesses, and the corners taken by hand. */
export class MockBoardLook {
    job: string | null = null;
    private looks = 0;
    private locked = 0;
    private pose: BoardLook["pose"] = null;
    private history: BoardEstimate[] = [];
    private guesses: Guess[] = [];
    private view: [number, number][] | null = null;
    private seen: [number, number] | null = null;
    private problem: string | null = null;
    private picture: MachinePicture | null = null;
    /** Locked looks the watchers read, for the one a pitch off now and then. */
    private sampled = 0;
    /** Corners of one job's board taken by hand, kept loaded or not, with that board's middle. */
    private corners: { job: string; middle: Board; points: BoardCorners["points"] } | null = null;
    /** Mock time since the last pose read, s. */
    elapsed = 0;

    /** `tuning` gives the camera's threshold (0 to 1) and corners' tolerance (mm) as they are now. */
    constructor(private readonly tuning: () => { threshold: number; cornerMm: number } = () => ({ threshold: LOOK_THRESHOLD, cornerMm: CORNER_MM })) {}

    start(job: string): void {
        this.job = job;
        this.restart();
    }

    stop(): void {
        this.job = null;
        this.restart();
    }

    /** A fresh look: a search starts over. */
    restart(): void {
        this.looks = 0;
        this.locked = 0;
        this.pose = null;
        this.history = [];
        this.guesses = [];
        this.view = null;
        this.seen = null;
        this.problem = null;
        this.picture = null;
    }

    /** The most likely guess; null with none, or every one ruled out. */
    private get lead(): Guess | null {
        this.weigh();
        const first = this.guesses[0];
        return first && first.probability > 0 ? first : null;
    }

    get found(): boolean {
        const lead = this.lead;
        if (lead === null || lead.looks < LOOK_NEED || lead.probability < this.tuning().threshold - 1e-9) {
            return false;
        }
        const next = this.guesses[1];
        return next === undefined || lead.probability > next.probability + 1e-9;
    }

    get best(): BoardEstimate | null {
        return this.lead?.estimate ?? null;
    }

    /** One pose read: locked over the board with the estimate it gives and the picture's corners and center in the job's frame, or not locked, or locked but not usable (`problem`); `picture` is where the picture lay on the machine. */
    see(locked: boolean, estimate: BoardEstimate | null, view: [number, number][] | null, seen: [number, number] | null, problem: string | null = null, picture: MachinePicture | null = null): void {
        this.looks += 1;
        this.pose = locked ? "locked" : "lost";
        this.problem = problem;
        this.view = locked ? view : null;
        this.seen = locked ? seen : null;
        if (picture !== null) {
            this.picture = picture;
        }
        if (!locked || estimate === null) {
            return;
        }
        this.locked += 1;
        this.history.push(estimate);
        if (this.history.length > LOOK_HISTORY) {
            this.history.shift();
        }
        this.sort();
    }

    /** A pose the watcher read: as `see`, but every PITCH_OFF_EVERY-th locked one a pitch off along X. */
    sample(locked: boolean, estimate: BoardEstimate | null, view: [number, number][] | null, seen: [number, number] | null, problem: string | null = null, picture: MachinePicture | null = null): void {
        let given = estimate;
        if (locked && estimate !== null) {
            this.sampled += 1;
            if (this.sampled % PITCH_OFF_EVERY === 0) {
                given = { ...estimate, shift: [round4(estimate.shift[0] + PITCH_MM), estimate.shift[1]], center: [round4(estimate.center[0] + PITCH_MM), estimate.center[1]] };
            }
        }
        this.see(locked, given, view, seen, problem, picture);
    }

    /** Looks at once, as a stop that sees the board steadily gives them, until it is found or the history has been filled with them: whether it was found. */
    settle(estimate: BoardEstimate, view: [number, number][] | null, seen: [number, number] | null, picture: MachinePicture | null = null): boolean {
        for (let count = 0; count < LOOK_HISTORY + LOOK_NEED && !this.found; count++) {
            this.see(true, estimate, view, seen, null, picture);
        }
        return this.found;
    }

    /** The picture's center was on a corner of the job's board when `machine` was read: kept in place of one of the same name; another job's are dropped. */
    addCorner(job: string, corner: CornerName, point: [number, number], machine: [number, number], middle: Board, angle: number | null = null): void {
        const kept = this.corners !== null && this.corners.job === job ? this.corners.points.filter((entry) => entry.corner !== corner) : [];
        const taken: BoardCorners["points"][number] = { corner, job: [round4(point[0]), round4(point[1])], machine: [round4(machine[0]), round4(machine[1])], by: angle === null ? "hand" : "edges" };
        if (angle !== null) {
            taken.angle = round4(angle);
        }
        this.corners = { job, middle, points: [...kept, taken] };
    }

    clearCorners(): void {
        this.corners = null;
    }

    /** The corners taken of a job's board. */
    cornersOf(job: string | null): BoardCorners["points"] {
        return this.corners !== null && job !== null && this.corners.job === job ? this.corners.points : [];
    }

    /** Where the corners taken of a job's board put it; null with none. */
    rough(job: string): BoardEstimate | null {
        return this.corners !== null && this.corners.job === job ? roughPlace(this.corners.points, this.corners.middle) : null;
    }

    /** Sorts the history into guesses: the estimate with the most evidence within the agreement of it seeds a guess of those, then the same with the rest. */
    private sort(): void {
        const items = this.history;
        const near = (a: BoardEstimate, b: BoardEstimate): boolean =>
            Math.hypot(a.center[0] - b.center[0], a.center[1] - b.center[1]) <= AGREE_MM && Math.abs(wrap(a.rotation - b.rotation)) <= AGREE_DEG;
        const left = new Set(items.map((_, index) => index));
        const guesses: Guess[] = [];
        while (left.size > 0) {
            let seed = -1;
            let most = -1;
            for (const i of left) {
                let weight = 0;
                for (const j of left) {
                    if (near(items[i]!, items[j]!)) {
                        weight += items[j]!.match ?? 1;
                    }
                }
                if (weight > most || (weight === most && i > seed)) {
                    most = weight;
                    seed = i;
                }
            }
            const members = [...left].filter((j) => near(items[seed]!, items[j]!)).sort((a, b) => a - b);
            for (const j of members) {
                left.delete(j);
            }
            const group = members.map((j) => items[j]!);
            const pivot = items[seed]!.rotation;
            const turns = group.map((e) => pivot + wrap(e.rotation - pivot));
            const cx = median(group.map((e) => e.center[0]));
            const cy = median(group.map((e) => e.center[1]));
            const rotation = median(turns);
            const weight = group.reduce((sum, e) => sum + (e.match ?? 1), 0);
            guesses.push({
                estimate: {
                    rotation: round4(wrap(rotation)),
                    shift: [round4(median(group.map((e) => e.shift[0]))), round4(median(group.map((e) => e.shift[1])))],
                    center: [round4(cx), round4(cy)],
                    rms: round4(median(group.map((e) => e.rms))),
                    match: round4(weight / group.length),
                },
                looks: group.length,
                weight,
                spreadMm: Math.max(...group.map((e) => Math.hypot(e.center[0] - cx, e.center[1] - cy))),
                spreadDeg: Math.max(...turns.map((r) => Math.abs(r - rotation))),
                newest: members[members.length - 1]!,
                probability: 0,
                cornerMm: null,
                ruledOut: false,
            });
        }
        this.guesses = guesses;
        this.weigh();
    }

    /** Each guess's verdict from the corners taken of this board and share of the evidence, the most likely first. */
    private weigh(): void {
        const corners = this.cornersOf(this.job);
        const tolerance = this.tuning().cornerMm;
        for (const guess of this.guesses) {
            if (corners.length > 0) {
                guess.cornerMm = Math.max(...corners.map((corner) => {
                    const at = applyEstimate(guess.estimate, { x: corner.job[0], y: corner.job[1] });
                    return Math.hypot(at.x - corner.machine[0], at.y - corner.machine[1]);
                }));
                guess.ruledOut = guess.cornerMm > tolerance;
            } else {
                guess.cornerMm = null;
                guess.ruledOut = false;
            }
        }
        const total = this.guesses.reduce((sum, guess) => sum + (guess.ruledOut ? 0 : guess.weight), 0);
        for (const guess of this.guesses) {
            guess.probability = total > 0 && !guess.ruledOut ? guess.weight / total : 0;
        }
        this.guesses.sort((a, b) => b.probability - a.probability || b.looks - a.looks || b.newest - a.newest);
    }

    /** A guess for the page, with where it says the newest picture lies on the board. */
    private guessOf(guess: Guess, total: number): BoardGuess {
        const picture = this.picture;
        const back = (point: [number, number]): [number, number] => {
            const [x, y] = unapplyEstimate(guess.estimate, point);
            return [round4(x), round4(y)];
        };
        return {
            ...guess.estimate,
            shift: [...guess.estimate.shift],
            center: [...guess.estimate.center],
            looks: guess.looks,
            probability: round4(guess.probability),
            share: total > 0 ? round4(guess.weight / total) : 0,
            spread_mm: round4(guess.spreadMm),
            spread_deg: round4(guess.spreadDeg),
            ruled_out: guess.ruledOut,
            corner_mm: guess.cornerMm === null ? null : round4(guess.cornerMm),
            view: picture ? picture.corners.map(back) : null,
            seen: picture ? back(picture.center) : null,
        };
    }

    state(): BoardLook {
        const { threshold, cornerMm } = this.tuning();
        const corners: BoardCorners | null = this.corners === null || this.corners.points.length === 0 ? null : {
            job: this.corners.job,
            points: this.corners.points.map((point) => ({ ...point, job: [...point.job] as [number, number], machine: [...point.machine] as [number, number] })),
            rough: roughPlace(this.corners.points, this.corners.middle),
        };
        if (this.job === null) {
            return { job: null, threshold, corner_mm: cornerMm, corners };
        }
        const lead = this.lead;
        const total = this.guesses.reduce((sum, guess) => sum + guess.weight, 0);
        return {
            job: this.job,
            looks: this.looks,
            locked: this.locked,
            pose: this.pose,
            agree: lead?.looks ?? 0,
            need: LOOK_NEED,
            found: this.found,
            spread_mm: lead ? round4(lead.spreadMm) : null,
            spread_deg: lead ? round4(lead.spreadDeg) : null,
            estimate: lead ? { ...lead.estimate, shift: [...lead.estimate.shift], center: [...lead.estimate.center] } : null,
            view: this.view ? this.view.map(([x, y]) => [x, y]) : null,
            seen: this.seen ? [this.seen[0], this.seen[1]] : null,
            problem: this.problem,
            threshold,
            corner_mm: cornerMm,
            guesses: this.guesses.slice(0, LOOK_GUESSES).map((guess) => this.guessOf(guess, total)),
            more: Math.max(0, this.guesses.length - LOOK_GUESSES),
            corners,
        };
    }
}
