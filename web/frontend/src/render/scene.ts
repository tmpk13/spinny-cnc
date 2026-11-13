// What the preview draws, apart from how it is drawn: the state a picture
// is made from (`RenderState`), the grid or the rings that follow the zoom,
// the soft limits, the probed heights, and the list of things to draw in
// order (`sceneOf`). The WebGL painter (webgl.ts) and the 2D one
// (canvas2d.ts) each put that list on the scene canvas; the overlay
// (overlay.ts) draws what moves, and the text, on a canvas laid over it.
// Nothing here touches the page, so it runs in the page or in the drawing
// worker alike.
//
// The job's lines are named by where they come from (`LineSource`: a
// group's paths, the outline, the picked paths, a speed bucket) rather than
// listed, so the WebGL painter can keep them on the graphics card from one
// view to the next; what changes with the view (the grid, the rail, the
// markers' crosses) comes as world points worked out for the frame.

import { type Camera, type Vec3, circlePoints, frameOf, unproject } from "../camera.ts";
import type { JobPlace } from "../jsontext.ts";
import { turned } from "../kinematics.ts";
import type { PathRef } from "../regroup.ts";
import { SPEED_COLORS, isCapped, speedBucket, type SpeedLimits, type SpeedMap } from "../speed.ts";
import type { Board, Grid, Group, HeightMap, Job, Joint, Kinematics, Marker, Move, Path, Point } from "../types.ts";

/** What the drawing needs of a group: what it holds, and for the speed view its speed, passes and joints. */
export type RenderGroup = Pick<Group, "enabled" | "paths" | "moves" | "areas" | "speed" | "passes" | "joints">;

/** What the drawing needs of a job; a whole `Job` is one. */
export interface RenderJob {
    spot: number;
    source: string;
    groups: RenderGroup[];
    outline: Path[];
    copper: Path[];
}

/** The part of a job the drawing reads, without the rest (pads, stats, recipe), for sending to the drawing worker. */
export function renderJobOf(job: Job | null): RenderJob | null {
    if (job === null) {
        return null;
    }
    return {
        spot: job.spot,
        source: job.source,
        groups: job.groups.map((group) => ({
            enabled: group.enabled,
            paths: group.paths,
            speed: group.speed,
            passes: group.passes,
            ...(group.moves ? { moves: group.moves } : {}),
            ...(group.areas ? { areas: group.areas } : {}),
            ...(group.joints ? { joints: group.joints } : {}),
        })),
        outline: job.outline,
        copper: job.copper,
    };
}

/** What bounds the head, as the machine's profile gives it. */
export interface Limits {
    kinematics: Kinematics;
    /** Soft limit of the radius either side of the axis, mm; 0 is none. */
    r_max: number;
    /** Soft limit of the cross slide either side of zero on a cartesian machine, mm; 0 is none. */
    z_max: number;
}

/** The preview's palette, CSS colors read from the stylesheet. */
export interface Colors {
    bg: string;
    grid: string;
    axis: string;
    rail: string;
    rmax: string;
    copper: string;
    outline: string;
    head: string;
    trail: string;
    text: string;
    groups: string[];
    probe: string;
    marker: string;
    low: string;
    high: string;
    select: string;
    highlight: string;
    /** The sketch dimensions of the operation being edited. */
    dim: string;
}

/** The palette before the stylesheet is read, and where a variable is missing from it. */
export const DEFAULT_COLORS: Colors = {
    bg: "#ffffff",
    grid: "#d8d8d8",
    axis: "#e07000",
    rail: "#8090a0",
    rmax: "#c02020",
    copper: "#c8a165",
    outline: "#404040",
    head: "#e07000",
    trail: "#e0a000",
    text: "#606060",
    groups: ["#c02020", "#204090", "#207040", "#806000"],
    probe: "#7a3fb0",
    marker: "#2aa198",
    low: "#268bd2",
    high: "#dc322f",
    select: "#d33682",
    highlight: "#6c71c4",
    dim: "#2aa198",
};

export function sameColors(a: Colors, b: Colors): boolean {
    return a.bg === b.bg && a.grid === b.grid && a.axis === b.axis && a.rail === b.rail && a.rmax === b.rmax
        && a.copper === b.copper && a.outline === b.outline && a.head === b.head && a.trail === b.trail
        && a.text === b.text && a.probe === b.probe && a.marker === b.marker && a.low === b.low && a.high === b.high
        && a.select === b.select && a.highlight === b.highlight && a.dim === b.dim
        && a.groups.length === b.groups.length && a.groups.every((color, index) => color === b.groups[index]);
}

/** A group's color, the palette's group colors taken in turn. */
export function groupColor(colors: Colors, index: number): string {
    return colors.groups[index % colors.groups.length] ?? colors.axis;
}

/**
 * A size drawn over the work the way a sketch shows it, board mm in and
 * the drawing in screen px, so it reads at any zoom: the length between two
 * points on a line set off to one side of them (`side` 1 the left of `from`
 * to `to`, -1 the right, 0 on the points themselves, arrows at both ends),
 * a radius from its center out to its arc at `angle` degrees, or a point
 * marked with a cross and named.
 */
export type Dimension =
    | { kind: "linear"; from: [number, number]; to: [number, number]; side: -1 | 0 | 1; text: string }
    | { kind: "radius"; center: [number, number]; radius: number; angle: number; text: string }
    | { kind: "point"; at: [number, number]; text: string };

/** The box a selection drag spans, canvas px. */
export interface SelectBox {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

/** Everything a picture of the preview is drawn from. */
export interface RenderState {
    /** The canvas in CSS px, and device px per CSS px. */
    width: number;
    height: number;
    dpr: number;
    camera: Camera;
    colors: Colors;
    /** The overlay's text as a CSS font in px: a rem means nothing in a worker. */
    font: string;
    job: RenderJob | null;
    limits: Limits;
    head: Joint | null;
    /** The board point under the head. */
    headBoard: Board | null;
    trail: Point[];
    /** The board's outline where a camera's looks put it, board mm; none drawn when empty. */
    estimate: Point[][];
    probeMap: HeightMap | null;
    probeDraft: Grid | null;
    /** The height map's mesh and probe points are drawn. */
    heights: boolean;
    /** A square grid under the work rather than rings about the axis. */
    grid: boolean;
    markers: Marker[];
    dims: Dimension[];
    /** The speed view, and the rates it is worked out for. */
    speed: boolean;
    speedLimits: SpeedLimits | null;
    /** How many paths of the cut order are drawn as done; null draws the job whole. */
    scrub: number | null;
    selection: PathRef[];
    highlight: JobPlace | null;
    /** For the notes line: the rotation lock and box selection are on. */
    locked: boolean;
    boxSelect: boolean;
    /** The selection box being dragged. */
    band: SelectBox | null;
    /** A large job's view is moving: the 2D painter draws it coarser. */
    coarse: boolean;
}

export const FONT_PX = 12;

export function initialRenderState(camera: Camera): RenderState {
    return {
        width: 0,
        height: 0,
        dpr: 1,
        camera,
        colors: DEFAULT_COLORS,
        font: `${FONT_PX}px system-ui, sans-serif`,
        job: null,
        limits: { kinematics: "polar", r_max: 0, z_max: 0 },
        head: null,
        headBoard: null,
        trail: [],
        estimate: [],
        probeMap: null,
        probeDraft: null,
        heights: true,
        grid: false,
        markers: [],
        dims: [],
        speed: false,
        speedLimits: null,
        scrub: null,
        selection: [],
        highlight: null,
        locked: false,
        boxSelect: false,
        band: null,
        coarse: false,
    };
}

/** Every point of a probe grid that is probed, row by row from the lowest Y; a mask leaves points out. */
export function gridPoints(grid: Grid): Point[] {
    const points: Point[] = [];
    for (let iy = 0; iy < grid.ny; iy++) {
        for (let ix = 0; ix < grid.nx; ix++) {
            if (grid.mask && !grid.mask[iy]?.[ix]) {
                continue;
            }
            points.push([
                grid.x0 + (grid.x1 - grid.x0) * ix / Math.max(1, grid.nx - 1),
                grid.y0 + (grid.y1 - grid.y0) * iy / Math.max(1, grid.ny - 1),
            ]);
        }
    }
    return points;
}

function sameMask(a: Grid["mask"], b: Grid["mask"]): boolean {
    if (!a && !b) {
        return true;
    }
    if (!a || !b || a.length !== b.length) {
        return false;
    }
    return a.every((row, iy) => row.length === b[iy]?.length && row.every((flag, ix) => flag === b[iy]?.[ix]));
}

export function sameGrid(a: Grid | null, b: Grid | null): boolean {
    if (a === null || b === null) {
        return a === b;
    }
    return (a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1 && a.nx === b.nx && a.ny === b.ny) && sameMask(a.mask, b.mask);
}

/** Screen room a ring label needs before the next one is drawn. */
export const LABEL_GAP_PX = 44;
/** How strongly the finer lines of the grid and the rings are drawn beside the heavier ones. */
const MINOR_ALPHA = 0.45;
/** The head marker and the rail float this share of the reach over the board. */
export const HEAD_HEIGHT = 0.15;
const MIN_EXAGGERATION = 1;
const MAX_EXAGGERATION = 200;

/** The soft limits drawn on the board: a circle, a closed outline, or pairs of parallel lines. */
export type LimitShape =
    | { kind: "circle"; radius: number }
    | { kind: "outline"; points: Point[] }
    | { kind: "lines"; lines: [Point, Point][] };

/**
 * Where the soft limits put the edge of the reach on the board. On the
 * polar machine `r_max` is the distance from the axis, a circle. On a
 * cartesian one the limits are on the joints, |R| <= r_max along the rail
 * and |Z| <= z_max across it, so the reach is that box turned by the table
 * angle; with one of them off it is a strip between two lines, drawn
 * `extent` mm long each way. Null when nothing is limited.
 */
export function limitShape(limits: Limits, angle: number, extent: number): LimitShape | null {
    const r = limits.r_max > 0 ? limits.r_max : 0;
    const z = limits.kinematics === "cartesian" && limits.z_max > 0 ? limits.z_max : 0;
    if (limits.kinematics !== "cartesian") {
        return r > 0 ? { kind: "circle", radius: r } : null;
    }
    const at = (x: number, y: number): Point => {
        const board = turned({ x, y }, angle);
        return [board.x, board.y];
    };
    if (r > 0 && z > 0) {
        return { kind: "outline", points: [at(r, z), at(-r, z), at(-r, -z), at(r, -z)] };
    }
    if (r > 0) {
        return { kind: "lines", lines: [[at(r, -extent), at(r, extent)], [at(-r, -extent), at(-r, extent)]] };
    }
    if (z > 0) {
        return { kind: "lines", lines: [[at(-extent, z), at(extent, z)], [at(-extent, -z), at(extent, -z)]] };
    }
    return null;
}

/** How far from the axis the soft limits reach, for fitting the view: the corner of a cartesian box. */
export function limitReach(limits: Limits): number {
    const r = limits.r_max > 0 ? limits.r_max : 0;
    if (limits.kinematics !== "cartesian") {
        return r;
    }
    const z = limits.z_max > 0 ? limits.z_max : 0;
    return r > 0 && z > 0 ? Math.hypot(r, z) : Math.max(r, z);
}

/** Farthest coordinate of anything drawn, in mm from the axis; `limit` is how far the soft limits reach. */
export function jobReach(job: RenderJob | null, limit: number): number {
    // Squares compared, one root at the end: a large job has hundreds of
    // thousands of points.
    let far = limit > 0 ? limit * limit : 0;
    if (job) {
        const take = (paths: readonly (readonly (readonly number[])[])[]): void => {
            for (const path of paths) {
                for (const point of path) {
                    const x = point[0]!;
                    const y = point[1]!;
                    const square = x * x + y * y;
                    if (square > far) {
                        far = square;
                    }
                }
            }
        };
        take(job.outline);
        take(job.copper);
        for (const group of job.groups) {
            take(group.paths);
            take(group.moves ?? []);
        }
    }
    const reach = Math.sqrt(far);
    return reach > 0 ? reach : 10;
}

/** A model's moves as the lines the tool cuts along, in three dimensions: every run of feeds and plunges from the point before it; rapids are left out. */
export function cutRuns(moves: Move[][]): Vec3[][] {
    const runs: Vec3[][] = [];
    for (const path of moves) {
        let run: Vec3[] = [];
        let last: Vec3 | null = null;
        for (const [x, y, z, kind] of path) {
            const point: Vec3 = [x, y, z];
            if (kind === 0) {
                if (run.length > 1) {
                    runs.push(run);
                }
                run = [];
            } else {
                if (run.length === 0 && last !== null) {
                    run.push(last);
                }
                run.push(point);
            }
            last = point;
        }
        if (run.length > 1) {
            runs.push(run);
        }
    }
    return runs;
}

/** A model's cut lines, worked out once for its moves. */
const runsOf = new WeakMap<Move[][], Vec3[][]>();

export function cachedRuns(moves: Move[][]): Vec3[][] {
    let runs = runsOf.get(moves);
    if (!runs) {
        runs = cutRuns(moves);
        runsOf.set(moves, runs);
    }
    return runs;
}

/** Points of a line on the board: x and y, and a height where it leaves the board (a model's cuts). */
export type Line = readonly (readonly number[])[];

/**
 * The speed view's lines, worked out once for a speed map: the capped
 * moves, and the moves in each color's bucket. A move that starts where
 * the last one of its set ended goes on that one's line: the moves of a
 * path follow each other, and one line of their points strokes far faster
 * than as many lines of two (and leaves its sub-pixel steps to the pen).
 */
const speedLinesOf = new WeakMap<SpeedMap, { capped: Line[]; buckets: Line[][] }>();

export function speedLines(map: SpeedMap): { capped: Line[]; buckets: Line[][] } {
    let lines = speedLinesOf.get(map);
    if (!lines) {
        const buckets: Point[][][] = SPEED_COLORS.map(() => []);
        const capped: Point[][] = [];
        const extend = (set: Point[][], from: Point, to: Point): void => {
            const line = set[set.length - 1];
            const end = line?.[line.length - 1];
            if (line && end && end[0] === from[0] && end[1] === from[1]) {
                line.push(to);
            } else {
                set.push([from, to]);
            }
        };
        for (const segment of map.segments) {
            extend(buckets[speedBucket(segment.speed, map.slowest, map.fastest)]!, segment.from, segment.to);
            if (isCapped(segment)) {
                extend(capped, segment.from, segment.to);
            }
        }
        lines = { capped, buckets };
        speedLinesOf.set(map, lines);
    }
    return lines;
}

/** How many rings to skip between labels so they stay readable. */
export function labelEvery(stepMm: number, scale: number): number {
    const apart = stepMm * scale;
    if (apart >= LABEL_GAP_PX) {
        return 1;
    }
    return apart * 2 >= LABEL_GAP_PX ? 2 : 4;
}

/** Least screen gap between the finest lines of the grid or the rings, CSS px; closer lines give way to a coarser step. */
export const GRID_GAP_PX = 16;
/** The finest step of the grid and the rings, mm: ten microns, past anything the machine places. */
export const MIN_GRID_STEP = 0.01;
/** The coarsest step, mm. */
export const MAX_GRID_STEP = 1000;
/** The most lines the grid draws (both ways together), or rings; past it the step coarsens. */
export const MAX_GRID_LINES = 400;
/** Where the view reaches the horizon the grid goes this many camera distances out from the target, no farther. */
const GRID_FAR = 6;

/** An axis-aligned box on the board, mm. */
export interface Box {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

/** A step of the 1-2-5 series rounded to what it is, so 0.1 * 2 reads 0.2. */
function tidyStep(step: number): number {
    return Number(step.toPrecision(12));
}

/** The leading digit of a 1-2-5 step: 1, 2 or 5. */
function stepDigit(step: number): number {
    return Math.round(step / 10 ** Math.floor(Math.log10(step) + 1e-9));
}

/** The step after `step` in the 1-2-5 series, at most the coarsest. */
export function coarserStep(step: number): number {
    const digit = stepDigit(step);
    const next = tidyStep(digit === 1 ? step * 2 : digit === 2 ? step * 2.5 : step * 2);
    return Math.min(MAX_GRID_STEP, next);
}

/**
 * The step of the grid and the rings at `scale` CSS px per mm: the finest
 * of a 1-2-5 series whose lines land at least `GRID_GAP_PX` apart, so
 * zooming in brings finer lines in and zooming out thins them.
 */
export function gridStep(scale: number): number {
    if (!(scale > 0) || !Number.isFinite(scale)) {
        return MAX_GRID_STEP;
    }
    const least = Math.max(MIN_GRID_STEP, GRID_GAP_PX / scale);
    let step = tidyStep(10 ** Math.floor(Math.log10(least)));
    while (step < least * (1 - 1e-9) && step < MAX_GRID_STEP) {
        step = coarserStep(step);
    }
    return Math.min(step, MAX_GRID_STEP);
}

/** How many steps apart the heavier lines are: every fifth of a 1 or 2 step, every second of a 5 step, so they fall on round numbers. */
export function majorEvery(step: number): number {
    return stepDigit(step) === 5 ? 2 : 5;
}

/** Whether the line or ring `k` steps out is a heavier one. */
function isMajor(k: number, every: number): boolean {
    return Math.abs(k) % every === 0;
}

/** A grid line, a segment across the box, and whether it is a heavier one. */
export interface GridLine {
    from: Point;
    to: Point;
    major: boolean;
}

/**
 * The lines of a square grid `step` apart that cross `box`, in X and Y,
 * each a segment across the box; every `majorEvery` line is a heavier
 * one, counted from the axis. The axis lines themselves are left to the
 * axis cross.
 */
export function gridLinesIn(step: number, box: Box): GridLine[] {
    if (!(step > 0) || !(box.x1 > box.x0) || !(box.y1 > box.y0)) {
        return [];
    }
    const every = majorEvery(step);
    const lines: GridLine[] = [];
    for (let k = Math.ceil(box.x0 / step - 1e-9); k * step <= box.x1 + 1e-9; k++) {
        if (k !== 0) {
            lines.push({ from: [k * step, box.y0], to: [k * step, box.y1], major: isMajor(k, every) });
        }
    }
    for (let k = Math.ceil(box.y0 / step - 1e-9); k * step <= box.y1 + 1e-9; k++) {
        if (k !== 0) {
            lines.push({ from: [box.x0, k * step], to: [box.x1, k * step], major: isMajor(k, every) });
        }
    }
    return lines;
}

/** The radius of each ring and whether it is a heavier one. */
export interface Ring {
    radius: number;
    major: boolean;
}

/** How near the axis the box comes, 0 when it holds it, and how far its farthest corner is. */
function ringSpan(box: Box): { near: number; far: number } {
    const nearX = Math.min(Math.max(0, box.x0), box.x1);
    const nearY = Math.min(Math.max(0, box.y0), box.y1);
    const far = Math.max(
        Math.hypot(box.x0, box.y0),
        Math.hypot(box.x1, box.y0),
        Math.hypot(box.x1, box.y1),
        Math.hypot(box.x0, box.y1),
    );
    return { near: Math.hypot(nearX, nearY), far };
}

/** The count of steps out to the first ring at or past `near`; the axis itself is no ring. */
function firstRing(near: number, step: number): number {
    return Math.max(1, Math.ceil(near / step - 1e-9));
}

/**
 * The part of the rings about the axis `step` apart that crosses `box`:
 * the rings from the box's nearest point to its farthest, and the arc
 * they are drawn over, `from` to `to` radians counterclockwise from +X; a
 * box round the axis takes the whole turn.
 */
export function ringsIn(step: number, box: Box): { rings: Ring[]; from: number; to: number } {
    const none = { rings: [], from: 0, to: 0 };
    if (!(step > 0) || !(box.x1 > box.x0) || !(box.y1 > box.y0)) {
        return none;
    }
    const { near, far } = ringSpan(box);
    const every = majorEvery(step);
    const rings: Ring[] = [];
    for (let k = firstRing(near, step); k * step <= far + 1e-9; k++) {
        rings.push({ radius: tidyStep(k * step), major: isMajor(k, every) });
    }
    if (near === 0) {
        return { rings, from: 0, to: Math.PI * 2 };
    }
    // The axis lies outside the box, so its corners span less than half a
    // turn about it: measured from the middle's direction, they bound it.
    const corners: Point[] = [[box.x0, box.y0], [box.x1, box.y0], [box.x1, box.y1], [box.x0, box.y1]];
    const middle = Math.atan2((box.y0 + box.y1) / 2, (box.x0 + box.x1) / 2);
    const turns = corners.map(([x, y]) => {
        let delta = Math.atan2(y, x) - middle;
        while (delta > Math.PI) {
            delta -= Math.PI * 2;
        }
        while (delta < -Math.PI) {
            delta += Math.PI * 2;
        }
        return delta;
    });
    return { rings, from: middle + Math.min(...turns), to: middle + Math.max(...turns) };
}

/** Points along the arc of a ring from `from` to `to` radians, its chords within `tolerance` mm of the circle. */
export function arcPoints(radius: number, from: number, to: number, tolerance: number): Vec3[] {
    const sweep = to - from;
    const whole = sweep >= Math.PI * 2 - 1e-9;
    const ratio = Math.min(1, Math.max(0, tolerance / radius));
    const chord = ratio >= 1 ? Math.PI / 4 : 2 * Math.acos(1 - ratio);
    const count = Math.min(2048, Math.max(whole ? 48 : 4, Math.ceil(sweep / chord)));
    return Array.from({ length: count + 1 }, (_, i) => {
        const angle = from + (sweep * i) / count;
        return [radius * Math.cos(angle), radius * Math.sin(angle), 0] as Vec3;
    });
}

/**
 * The part of the board the view shows, as the box round it, within
 * `extent` mm of the axis either way: canvas points sampled along the
 * edges and through the middle, each taken down to the board. Where the
 * view reaches the horizon the box runs out `GRID_FAR` camera distances
 * from the target. Null when the view shows none of the board.
 */
export function visibleBox(camera: Camera, width: number, height: number, extent: number): Box | null {
    const frame = frameOf(camera);
    const far = camera.distance * GRID_FAR;
    const [tx, ty] = camera.target;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let open = false;
    const steps = 4;
    for (let i = 0; i <= steps; i++) {
        for (let j = 0; j <= steps; j++) {
            const hit = unproject(frame, width, height, (width * i) / steps, (height * j) / steps, 0);
            if (!hit || Math.hypot(hit[0] - tx, hit[1] - ty) > far) {
                open = true;
                continue;
            }
            x0 = Math.min(x0, hit[0]);
            y0 = Math.min(y0, hit[1]);
            x1 = Math.max(x1, hit[0]);
            y1 = Math.max(y1, hit[1]);
        }
    }
    if (open) {
        x0 = Math.min(x0, tx - far);
        y0 = Math.min(y0, ty - far);
        x1 = Math.max(x1, tx + far);
        y1 = Math.max(y1, ty + far);
    }
    const box = {
        x0: Math.max(x0, -extent),
        y0: Math.max(y0, -extent),
        x1: Math.min(x1, extent),
        y1: Math.min(y1, extent),
    };
    return box.x1 > box.x0 && box.y1 > box.y0 ? box : null;
}

/** How the grid or the rings are laid out for a view: the step, and the part of the board they are drawn over. */
export interface GridLayout {
    step: number;
    box: Box | null;
}

/**
 * The step for `scale` px per mm over the part of the board in view,
 * coarsened until no more than `MAX_GRID_LINES` lines or rings cross it.
 */
export function gridLayout(scale: number, box: Box | null, rings: boolean): GridLayout {
    let step = gridStep(scale);
    if (box === null) {
        return { step, box };
    }
    const span = ringSpan(box);
    const count = (s: number): number => {
        if (rings) {
            return Math.floor(span.far / s + 1e-9) - firstRing(span.near, s) + 1;
        }
        return (box.x1 - box.x0) / s + (box.y1 - box.y0) / s;
    };
    while (step < MAX_GRID_STEP && count(step) > MAX_GRID_LINES) {
        step = coarserStep(step);
    }
    return { step, box };
}

/** A grid line's position as its label: a whole number, or as few decimals as it has. */
export function formatTick(value: number): string {
    return String(Math.round(value * 1000) / 1000);
}

/**
 * How much the probed heights are stretched to be seen at all: a tenth of
 * a millimeter of warp beside a 30 mm board is nothing to the eye, so the
 * map's spread is drawn as a tenth of the reach, within bounds.
 */
export function heightExaggeration(range: number, reach: number): number {
    if (!(range > 0) || !(reach > 0)) {
        return MIN_EXAGGERATION;
    }
    return Math.min(MAX_EXAGGERATION, Math.max(MIN_EXAGGERATION, (reach * 0.1) / range));
}

/** The probed heights' mean and spread; null until two points are probed. */
export function heightSpread(map: HeightMap): { mean: number; range: number } | null {
    const heights: number[] = [];
    for (const row of map.heights) {
        for (const height of row) {
            if (height !== null && Number.isFinite(height)) {
                heights.push(height);
            }
        }
    }
    if (heights.length < 2) {
        return null;
    }
    const mean = heights.reduce((sum, h) => sum + h, 0) / heights.length;
    return { mean, range: Math.max(...heights) - Math.min(...heights) };
}

/** A dot's radius on the board, mm: that of a circle of its pad's area, or half the spot without one. */
export function dotRadius(area: number | undefined, spot: number): number {
    if (area !== undefined && area > 0) {
        return Math.sqrt(area / Math.PI);
    }
    return spot / 2;
}

/** The job's spot, mm: a job without one is drawn as a tenth of a millimeter. */
export function spotOf(job: RenderJob): number {
    return job.spot > 0 ? job.spot : 0.1;
}

/**
 * The job's paths in the order they are cut: the groups that are on, in
 * order, a path at a time, a model's group as one entry ([group, -1]).
 * `start` is where each group's first path falls in it (-1 for a group that
 * is off), so a path's place is its group's start plus its index.
 */
export interface CutOrder {
    order: PathRef[];
    start: number[];
}

const orders = new WeakMap<RenderJob, CutOrder>();

export function cutOrderOf(job: RenderJob | null): CutOrder {
    if (job === null) {
        return { order: [], start: [] };
    }
    let kept = orders.get(job);
    if (!kept) {
        const order: PathRef[] = [];
        const start = job.groups.map((group, g) => {
            if (!group.enabled) {
                return -1;
            }
            const at = order.length;
            if ((group.moves?.length ?? 0) > 0) {
                order.push([g, -1]);
            } else {
                group.paths.forEach((_, p) => order.push([g, p]));
            }
            return at;
        });
        kept = { order, start };
        orders.set(job, kept);
    }
    return kept;
}

/** How a set of lines is stroked: color, width in CSS px, opacity, and a dash and the gap after it in CSS px. */
export interface Ink {
    color: string;
    width: number;
    alpha: number;
    dash?: readonly [number, number];
}

/** Which of a group's paths a draw takes by their place in the cut order: all, those before `at`, or those from `at` on. */
export type CutFilter = { kind: "all" } | { kind: "before"; at: number } | { kind: "from"; at: number };

export const ALL: CutFilter = { kind: "all" };

/** Whether a path at `place` in the cut order passes a filter. */
export function passes(filter: CutFilter, place: number): boolean {
    return filter.kind === "all" || (filter.kind === "before" ? place < filter.at : place >= filter.at);
}

/**
 * Lines that come from the job, the same from one view to the next: a
 * group's paths of other than one point (`filter` by their place in the cut
 * order, which needs the group on), a model group's cut runs, the outline,
 * the picked paths, or a speed bucket's moves (null for the capped ones).
 */
export type LineSource =
    | { kind: "paths"; group: number; filter: CutFilter }
    | { kind: "runs"; group: number }
    | { kind: "outline" }
    | { kind: "picked" }
    | { kind: "speed"; bucket: number | null };

/** A line worked out for the frame, in world points; a null lifts the pen. `closed` joins the last point to the first unless the line breaks. A line of one point is a dot the ink's width across. */
export interface Polyline {
    points: (Vec3 | null)[];
    closed?: boolean;
}

/** A circle a size on the screen about a world point: filled, or stroked `stroke` CSS px wide. */
export interface Circle {
    at: Vec3;
    /** CSS px. */
    radius: number;
    color: string;
    stroke?: number;
}

/** One thing to draw. */
export type Item =
    | { kind: "lines"; source: LineSource; ink: Ink }
    /** A group's paths of one point: dots the size of their pad (or half the spot), at least 1.5 px. */
    | { kind: "dots"; group: number; filter: CutFilter; color: string; alpha: number }
    /** The job's copper, filled even-odd so holes stay holes. */
    | { kind: "copper"; color: string; alpha: number }
    | { kind: "polylines"; lines: Polyline[]; ink: Ink }
    | { kind: "circles"; circles: Circle[]; alpha: number };

/**
 * A picture's still parts in order: the board and its grid or rings, the
 * rail and its column (which on a cartesian machine move with the head),
 * then the work over the rail: the limits, the job, the probe grid, the
 * markers and the axis cross.
 */
export interface Scene {
    board: Item[];
    rail: Item[];
    work: Item[];
    /** How far the probed heights are stretched, for the notes; null without a mesh. */
    exaggeration: number | null;
}

/** What `sceneOf` needs beside the state, worked out once a frame. */
export interface SceneFrame {
    state: RenderState;
    /** CSS px per mm at the target's depth. */
    scale: number;
    reach: number;
    /** How far the rail and the limits' lines run, mm. */
    extent: number;
    layout: GridLayout;
    speeds: SpeedMap | null;
}

/** The world point of a board point. */
function flat([x, y]: readonly number[]): Vec3 {
    return [x!, y!, 0];
}

/** The rail's line: along +X from the axis on the polar machine, through the head along the table's turned X on a cartesian one. */
export function railLine(state: RenderState, extent: number, headHeight: number): Vec3[] {
    if (state.limits.kinematics === "cartesian") {
        const through = state.headBoard ?? { x: 0, y: 0 };
        const along = turned({ x: extent, y: 0 }, state.head?.a ?? 0);
        return [
            [through.x - along.x, through.y - along.y, headHeight],
            [through.x + along.x, through.y + along.y, headHeight],
        ];
    }
    return [[0, 0, headHeight], [extent, 0, headHeight]];
}

/** The head marker's and the rail's height over the board, mm. */
export function headHeightOf(reach: number): number {
    return Math.max(1, reach * HEAD_HEIGHT);
}

/** Everything still in the picture, as the painters draw it. */
export function sceneOf(frame: SceneFrame): Scene {
    const { state, scale, reach, extent, layout } = frame;
    const colors = state.colors;
    const board: Item[] = [];
    // The rings about the axis or a square grid over the part of the board
    // in view, the finer lines faint and every heavier one at full
    // strength. A ring is drawn over the arc in view, its chords within a
    // third of a pixel of the circle, so it stays round however far in the
    // view is zoomed.
    const { step, box } = layout;
    if (box !== null) {
        const lines = state.grid ? gridLinesIn(step, box) : [];
        const rings = state.grid ? null : ringsIn(step, box);
        const tolerance = 0.3 / (scale > 0 ? scale : 1);
        for (const major of [false, true]) {
            const set: Polyline[] = [];
            for (const line of lines) {
                if (line.major === major) {
                    set.push({ points: [flat(line.from), flat(line.to)] });
                }
            }
            for (const ring of rings?.rings ?? []) {
                if (ring.major === major) {
                    set.push({ points: arcPoints(ring.radius, rings!.from, rings!.to, tolerance) });
                }
            }
            if (set.length > 0) {
                board.push({ kind: "polylines", lines: set, ink: { color: colors.grid, width: 1, alpha: major ? 1 : MINOR_ALPHA } });
            }
        }
    }

    // The rail, floating at the head's height, and the column from the axis
    // up to it, so the height reads.
    const headHeight = headHeightOf(reach);
    const rail: Item[] = [
        { kind: "polylines", lines: [{ points: railLine(state, extent, headHeight) }], ink: { color: colors.rail, width: 2, alpha: 1, dash: [8, 6] } },
        { kind: "polylines", lines: [{ points: [[0, 0, 0], [0, 0, headHeight]] }], ink: { color: colors.rail, width: 1, alpha: 0.4 } },
    ];

    const work: Item[] = [];
    const limit = limitShape(state.limits, state.head?.a ?? 0, extent);
    if (limit) {
        const lines: Polyline[] = limit.kind === "circle"
            ? [{ points: circlePoints(limit.radius, 96), closed: true }]
            : limit.kind === "outline"
                ? [{ points: limit.points.map(flat), closed: true }]
                : limit.lines.map(([from, to]) => ({ points: [flat(from), flat(to)] }));
        work.push({ kind: "polylines", lines, ink: { color: colors.rmax, width: 1.5, alpha: 1, dash: [4, 4] } });
    }
    const job = state.job;
    if (job) {
        workItems(work, frame, job);
    }
    const exaggeration = state.heights ? probeItems(work, state, reach) : null;

    // The markers: a diagonal cross and a ring, eight px whatever the
    // zoom, so they read apart from the axis cross.
    const size = 8 / scale;
    const marks: Polyline[] = [];
    for (const { x, y } of state.markers) {
        marks.push({ points: [[x - size, y - size, 0], [x + size, y + size, 0]] });
        marks.push({ points: [[x - size, y + size, 0], [x + size, y - size, 0]] });
        marks.push({ points: circlePoints(size * 0.7, 16).map(([cx, cy]) => [x + cx, y + cy, 0] as Vec3), closed: true });
    }
    if (marks.length > 0) {
        work.push({ kind: "polylines", lines: marks, ink: { color: colors.marker, width: 1.5, alpha: 1 } });
    }

    // Axis cross, ten px wide whatever the zoom.
    const cross = 10 / scale;
    work.push({
        kind: "polylines",
        lines: [{ points: [[-cross, 0, 0], [cross, 0, 0]] }, { points: [[0, -cross, 0], [0, cross, 0]] }],
        ink: { color: colors.axis, width: 1.5, alpha: 1 },
    });
    return { board, rail, work, exaggeration };
}

/** The job: its copper, the picked paths' halo, the speed view, the cut order so far, the groups, the outline and the JSON panel's place. */
function workItems(work: Item[], frame: SceneFrame, job: RenderJob): void {
    const { state, scale, speeds } = frame;
    const colors = state.colors;
    if (job.copper.length > 0) {
        work.push({ kind: "copper", color: colors.copper, alpha: 0.35 });
    }
    const spot = spotOf(job);
    // The spot's width, but at least 1.2 px to be read; a device pixel
    // while a large job's view moves.
    const width = Math.max(spot * scale, state.coarse ? 1 / state.dpr : 1.2);
    // The picked paths: a halo a few px wider than the line, under it.
    if (state.selection.length > 0) {
        work.push({ kind: "lines", source: { kind: "picked" }, ink: { color: colors.select, width: width + 7, alpha: 0.45 } });
    }
    if (speeds !== null) {
        // Every path faint in its group's color, then each move by its
        // speed over a red halo where it is capped; narrower while a large
        // job's view moves, since wide strokes are what a rasterizer spends
        // its time on.
        job.groups.forEach((_, group) => {
            work.push({ kind: "lines", source: { kind: "paths", group, filter: ALL }, ink: { color: groupColor(colors, group), width, alpha: 0.12 } });
        });
        const { capped, buckets } = speedLines(speeds);
        if (capped.length > 0) {
            work.push({ kind: "lines", source: { kind: "speed", bucket: null }, ink: { color: colors.rmax, width: width + (state.coarse ? 2 : 6), alpha: 0.45 } });
        }
        buckets.forEach((lines, bucket) => {
            if (lines.length > 0) {
                work.push({ kind: "lines", source: { kind: "speed", bucket }, ink: { color: SPEED_COLORS[bucket]!, width: Math.max(width, state.coarse ? 1 / state.dpr : 2), alpha: 1 } });
            }
        });
    }
    // With the cut order scrubbed, the paths cut so far are drawn, the last
    // of them marked, and the rest faint.
    const scrub = speeds === null ? state.scrub : null;
    const order = cutOrderOf(job);
    if (scrub !== null && scrub > 0) {
        const last = order.order[scrub - 1];
        const path = last && last[1] >= 0 ? job.groups[last[0]]?.paths[last[1]] : undefined;
        if (path && path.length === 1) {
            work.push({ kind: "circles", circles: [{ at: flat(path[0]!), radius: Math.max(spot * scale, 6), color: colors.head }], alpha: 0.5 });
        } else if (path && path.length > 1) {
            work.push({ kind: "polylines", lines: [{ points: path.map(flat) }], ink: { color: colors.head, width: width + 8, alpha: 0.5 } });
        }
    }
    job.groups.forEach((group, index) => {
        const color = groupColor(colors, index);
        const alpha = group.enabled ? 0.9 : 0.25;
        const carved = (group.moves?.length ?? 0) > 0;
        const dots = (filter: CutFilter, dotAlpha: number): void => {
            work.push({ kind: "dots", group: index, filter, color, alpha: dotAlpha });
        };
        if (speeds !== null && !carved && group.paths.some((path) => path.length > 1)) {
            // Drawn by speed above; its dots still follow.
            dots(ALL, alpha);
            return;
        }
        let movesAlpha = alpha;
        if (scrub !== null) {
            const start = order.start[index] ?? -1;
            if (carved) {
                movesAlpha = start >= 0 && start < scrub ? 0.9 : 0.12;
            } else if (start < 0) {
                // A group that is off is no part of the cut: faint throughout.
                work.push({ kind: "lines", source: { kind: "paths", group: index, filter: ALL }, ink: { color, width, alpha: 0.12 } });
                dots(ALL, 0.12);
                return;
            } else {
                const later: CutFilter = { kind: "from", at: scrub };
                const sooner: CutFilter = { kind: "before", at: scrub };
                work.push({ kind: "lines", source: { kind: "paths", group: index, filter: later }, ink: { color, width, alpha: 0.12 } });
                work.push({ kind: "lines", source: { kind: "paths", group: index, filter: sooner }, ink: { color, width, alpha: 0.9 } });
                dots(later, 0.12);
                dots(sooner, 0.9);
                return;
            }
        }
        if (carved) {
            // A model's toolpaths are too dense to draw a tool wide: thin
            // lines, at their depth under the board.
            work.push({ kind: "lines", source: { kind: "runs", group: index }, ink: { color, width: 1, alpha: movesAlpha } });
            return;
        }
        work.push({ kind: "lines", source: { kind: "paths", group: index, filter: ALL }, ink: { color, width, alpha } });
        dots(ALL, alpha);
    });
    if (job.outline.length > 0) {
        // A model's outline and block, and the shape a Plot page operation
        // cuts, are where it lies, not a cut: a thin line, so the toolpaths
        // under it show.
        const thin = job.source === "mill" || job.groups.some((group) => (group.moves?.length ?? 0) > 0);
        work.push({ kind: "lines", source: { kind: "outline" }, ink: { color: colors.outline, width: thin ? 1 : Math.max(spot * scale / 2, 1), alpha: 1 } });
    }
    // The place the JSON panel's caret is in: its path over everything in
    // the highlight color, and with a point named, the segments either side
    // of it thicker still and the point as a ring.
    const place = state.highlight;
    const list = place === null ? undefined : place.list === "groups" ? job.groups[place.group ?? -1]?.paths : place.list === "outline" ? job.outline : job.copper;
    const path = place === null ? undefined : list?.[place.path];
    if (place !== null && path && path.length > 0) {
        const lineWidth = Math.max(spot * scale, 1.2);
        work.push({ kind: "polylines", lines: [{ points: path.map(flat) }], ink: { color: colors.highlight, width: lineWidth + 3, alpha: 0.9 } });
        const point = place.point !== null ? path[place.point] : undefined;
        if (place.point !== null && point) {
            const i = place.point;
            const around = path.slice(Math.max(0, i - 1), Math.min(path.length, i + 2));
            work.push({ kind: "polylines", lines: [{ points: around.map(flat) }], ink: { color: colors.highlight, width: lineWidth + 7, alpha: 0.9 } });
            work.push({ kind: "circles", circles: [{ at: flat(point), radius: 7, color: colors.highlight, stroke: 2 }], alpha: 1 });
        }
    }
}

/**
 * The probe grid: its outline and points, solid and filled where the map
 * is probed, dashed and hollow for a grid not probed yet; the probed
 * heights raised out of the board, stretched to be seen, as a mesh with
 * each point colored below or above the mean. Returns the stretch, or null
 * when no surface is drawn.
 */
function probeItems(work: Item[], state: RenderState, reach: number): number | null {
    const map = state.probeMap;
    const draft = state.probeDraft;
    const colors = state.colors;
    const grids: { grid: Grid; heights: (number | null)[][] | null }[] = [];
    if (draft !== null && (map === null || !sameGrid(draft, map.grid))) {
        grids.push({ grid: draft, heights: null });
    }
    if (map !== null) {
        grids.push({ grid: map.grid, heights: map.heights });
    }
    let exaggeration: number | null = null;
    for (const { grid, heights } of grids) {
        const alpha = heights === null ? 0.7 : 0.9;
        const ink: Ink = { color: colors.probe, width: 1.2, alpha };
        work.push({
            kind: "polylines",
            lines: [{ points: [[grid.x0, grid.y0, 0], [grid.x1, grid.y0, 0], [grid.x1, grid.y1, 0], [grid.x0, grid.y1, 0]], closed: true }],
            ink: heights === null ? { ...ink, dash: [5, 4] } : ink,
        });
        const points = gridPoints(grid);
        const spread = map !== null && heights !== null ? heightSpread(map) : null;
        const stretch = spread ? heightExaggeration(spread.range, reach) : 1;
        const raised = (index: number): Vec3 | null => {
            const height = heights?.[Math.floor(index / grid.nx)]?.[index % grid.nx] ?? null;
            if (height === null || !spread) {
                return null;
            }
            const [x, y] = points[index]!;
            return [x, y, (height - spread.mean) * stretch];
        };
        if (spread) {
            exaggeration = stretch;
            // Rows, then columns, pen up where a point is not probed.
            const mesh: Polyline[] = [];
            for (let iy = 0; iy < grid.ny; iy++) {
                mesh.push({ points: Array.from({ length: grid.nx }, (_, ix) => raised(iy * grid.nx + ix)) });
            }
            for (let ix = 0; ix < grid.nx; ix++) {
                mesh.push({ points: Array.from({ length: grid.ny }, (_, iy) => raised(iy * grid.nx + ix)) });
            }
            work.push({ kind: "polylines", lines: mesh, ink });
        }
        const circles: Circle[] = [];
        const colorOf = (z: number): string => (z !== 0 ? (z < 0 ? colors.low : colors.high) : colors.probe);
        // A pad map's points are the pads probed, not the grid's cells:
        // drawn on the board, filled once probed.
        const pads = heights !== null && map?.points && map.point_heights ? map : null;
        if (pads && pads.points && pads.point_heights) {
            const padHeights = pads.point_heights;
            pads.points.forEach(([x, y], index) => {
                const height = padHeights[index] ?? null;
                const top: Vec3 = height !== null && spread ? [x, y, (height - spread.mean) * stretch] : [x, y, 0];
                circles.push(height !== null
                    ? { at: top, radius: 3, color: colorOf(top[2]) }
                    : { at: top, radius: 3, color: colors.probe, stroke: 1.2 });
            });
        } else {
            points.forEach(([x, y], index) => {
                const top = raised(index);
                const probed = heights !== null && (heights[Math.floor(index / grid.nx)]?.[index % grid.nx] ?? null) !== null;
                const at: Vec3 = top ?? [x, y, 0];
                circles.push(probed
                    ? { at, radius: 3, color: top ? colorOf(top[2]) : colors.probe }
                    : { at, radius: 3, color: colors.probe, stroke: 1.2 });
            });
        }
        if (circles.length > 0) {
            work.push({ kind: "circles", circles, alpha });
        }
    }
    return exaggeration;
}
