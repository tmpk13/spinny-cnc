// 3D canvas preview of the machine's working area, in board mm around the
// rotation axis: the rings (or a square grid) and the rail, the soft
// limits, the markers, copper, outline,
// the job's paths, the probe grid with its heights stretched to be seen,
// and the head over the board with its beam and a short trail. An orbit
// camera: drag orbits (or pans when the rotation is locked), shift or a
// second button pans, the wheel zooms about the cursor, double click
// returns to the overview. Everything is projected by camera.ts and drawn
// with the plain 2D context, so the page needs no WebGL and the view math
// tests without a canvas.
//
// The head moves many times a second while the rest of the picture does
// not, so what stays still is drawn once into offscreen layers for the
// camera, size, job and palette of the moment and copied under the head
// on every frame; the layers are drawn again only when one of those
// changes.
//
// A click (a press let go where it was) picks the path under the pointer,
// shift or ctrl adds it or takes it back; with box selection on, a drag
// picks every path wholly inside the box. Picked paths are drawn with a
// halo under them, and the place the JSON panel's caret is in on top.

import {
    type Camera,
    type Frame,
    type Vec3,
    circlePoints,
    frameOf,
    orbit,
    overview,
    pan,
    project,
    pxPerMm,
    sameCamera,
    unproject,
    zoomAt,
} from "./camera.ts";
import { cssVar } from "./dom.ts";
import type { JobPlace } from "./jsontext.ts";
import { boardOfJoint, turned } from "./kinematics.ts";
import type { PathRef } from "./regroup.ts";
import type { Board, Grid, HeightMap, Job, Joint, Kinematics, Marker, Move, Path, Point } from "./types.ts";

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
const TRAIL_LENGTH = 240;
/** Where the rotation lock is remembered between visits. */
export const LOCK_KEY = "spinny.preview.lock";
/** Where the choice to draw the height map is remembered between visits. */
export const HEIGHTS_KEY = "spinny.previewHeights";
/** Where the choice of a square grid over the rings is remembered between visits. */
export const GRID_KEY = "spinny.preview.grid";
/** A path this near the pointer, CSS px, is the one a click picks. */
export const PICK_PX = 8;
/** A press let go within this many px of where it went down is a click. */
const CLICK_PX = 4;
/** How strongly the finer lines of the grid and the rings are drawn beside the heavier ones. */
const MINOR_ALPHA = 0.45;
/** The head marker and the rail float this share of the reach over the board. */
const HEAD_HEIGHT = 0.15;
const MIN_EXAGGERATION = 1;
const MAX_EXAGGERATION = 200;
/** How long the palette read from the stylesheet is trusted before it is read again, ms. */
const PALETTE_MS = 1000;

/** What bounds the head, as the machine's profile gives it. */
export interface Limits {
    kinematics: Kinematics;
    /** Soft limit of the radius either side of the axis, mm; 0 is none. */
    r_max: number;
    /** Soft limit of the cross slide either side of zero on a cartesian machine, mm; 0 is none. */
    z_max: number;
}

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
export function jobReach(job: Job | null, limit: number): number {
    let reach = limit > 0 ? limit : 0;
    if (job) {
        const take = (paths: Path[]): void => {
            for (const path of paths) {
                for (const [x, y] of path) {
                    reach = Math.max(reach, Math.hypot(x, y));
                }
            }
        };
        take(job.outline);
        take(job.copper);
        for (const group of job.groups) {
            take(group.paths);
            for (const path of group.moves ?? []) {
                for (const [x, y] of path) {
                    reach = Math.max(reach, Math.hypot(x, y));
                }
            }
        }
    }
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
 * of a 1-2-5 series whose lines land at least `gap` px apart, so zooming
 * in brings finer lines in and zooming out thins them.
 */
export function gridStep(scale: number, gap = GRID_GAP_PX): number {
    if (!(scale > 0) || !Number.isFinite(scale)) {
        return MAX_GRID_STEP;
    }
    const least = Math.max(MIN_GRID_STEP, gap / scale);
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

export type DragMode = "orbit" | "pan";

/** What a one-pointer drag does: it pans under the rotation lock, with shift, or with any button but the first; else it orbits. */
export function dragMode(locked: boolean, pointer: { button?: number; shiftKey?: boolean }): DragMode {
    if (locked || pointer.shiftKey || (pointer.button !== undefined && pointer.button !== 0)) {
        return "pan";
    }
    return "orbit";
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

function readFlag(key: string, fallback: boolean): boolean {
    try {
        if (typeof localStorage === "undefined") {
            return fallback;
        }
        const stored = localStorage.getItem(key);
        return stored === null ? fallback : stored === "1";
    } catch {
        return fallback;
    }
}

/** A choice remembered under `key`; null when none was made in this browser. */
function readChoice(key: string): boolean | null {
    try {
        if (typeof localStorage === "undefined") {
            return null;
        }
        const stored = localStorage.getItem(key);
        return stored === null ? null : stored === "1";
    } catch {
        return null;
    }
}

function writeFlag(key: string, on: boolean): void {
    try {
        if (typeof localStorage !== "undefined") {
            localStorage.setItem(key, on ? "1" : "0");
        }
    } catch {
        // Nothing to remember into; the choice holds for this page.
    }
}

interface Colors {
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
}

function readColors(node: Element): Colors {
    return {
        bg: cssVar(node, "--pv-bg", "#ffffff"),
        grid: cssVar(node, "--pv-grid", "#d8d8d8"),
        axis: cssVar(node, "--pv-axis", "#e07000"),
        rail: cssVar(node, "--pv-rail", "#8090a0"),
        rmax: cssVar(node, "--pv-rmax", "#c02020"),
        copper: cssVar(node, "--pv-copper", "#c8a165"),
        outline: cssVar(node, "--pv-outline", "#404040"),
        head: cssVar(node, "--pv-head", "#e07000"),
        trail: cssVar(node, "--pv-trail", "#e0a000"),
        text: cssVar(node, "--pv-text", "#606060"),
        groups: [
            cssVar(node, "--pv-g0", "#c02020"),
            cssVar(node, "--pv-g1", "#204090"),
            cssVar(node, "--pv-g2", "#207040"),
            cssVar(node, "--pv-g3", "#806000"),
        ],
        probe: cssVar(node, "--pv-probe", "#7a3fb0"),
        marker: cssVar(node, "--pv-marker", "#2aa198"),
        low: cssVar(node, "--hm-low", "#268bd2"),
        high: cssVar(node, "--hm-high", "#dc322f"),
        select: cssVar(node, "--pv-select", "#d33682"),
        highlight: cssVar(node, "--pv-highlight", "#6c71c4"),
    };
}

function sameColors(a: Colors, b: Colors): boolean {
    return a.bg === b.bg && a.grid === b.grid && a.axis === b.axis && a.rail === b.rail && a.rmax === b.rmax
        && a.copper === b.copper && a.outline === b.outline && a.head === b.head && a.trail === b.trail
        && a.text === b.text && a.probe === b.probe && a.marker === b.marker && a.low === b.low && a.high === b.high
        && a.select === b.select && a.highlight === b.highlight
        && a.groups.length === b.groups.length && a.groups.every((color, index) => color === b.groups[index]);
}

/** Everything the still layers were drawn from; a change in any of it draws them again. */
interface SceneKey {
    job: Job | null;
    probeMap: HeightMap | null;
    probeDraft: Grid | null;
    heights: boolean;
    /** A square grid under the work rather than rings about the axis. */
    grid: boolean;
    markers: Marker[];
    selection: PathRef[];
    highlight: JobPlace | null;
    camera: Camera;
    width: number;
    height: number;
    dpr: number;
    colors: Colors;
    limits: Limits;
    /** The table angle on a cartesian machine, whose limit box turns with it; null on the polar machine, whose limits stand still. */
    angle: number | null;
}

function sameSceneKey(a: SceneKey, b: SceneKey): boolean {
    return a.job === b.job && a.probeMap === b.probeMap && sameGrid(a.probeDraft, b.probeDraft) && a.heights === b.heights && a.grid === b.grid && a.markers === b.markers
        && a.selection === b.selection && a.highlight === b.highlight
        && sameCamera(a.camera, b.camera) && a.width === b.width && a.height === b.height && a.dpr === b.dpr
        && a.colors === b.colors && a.angle === b.angle
        && a.limits.kinematics === b.limits.kinematics && a.limits.r_max === b.limits.r_max && a.limits.z_max === b.limits.z_max;
}

/**
 * The still parts of the picture, drawn once: the board with its rings,
 * which the rail is drawn over, and the limits, the job, the probe grid
 * and the axis cross, which are drawn over the rail, transparent elsewhere.
 */
interface Scene {
    key: SceneKey;
    under: HTMLCanvasElement;
    over: HTMLCanvasElement;
    /** How far the probed heights were stretched, for the notes; null without a mesh. */
    exaggeration: number | null;
}

interface Pointer {
    x: number;
    y: number;
    button: number;
    shiftKey: boolean;
    /** Where it went down, and whether it has moved past a click since. */
    downX: number;
    downY: number;
    moved: boolean;
    /** It went down with a key that adds to the picked paths. */
    additive: boolean;
}

/** The box a selection drag spans, canvas px. */
interface SelectBox {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

/** A canvas point's distance to the segment from `a` to `b`, px. */
function segmentDistance(x: number, y: number, a: { x: number; y: number }, b: { x: number; y: number }): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = dx * dx + dy * dy;
    const t = length > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / length)) : 0;
    return Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t));
}

export class Preview {
    private readonly canvas: HTMLCanvasElement;
    private readonly ctx: CanvasRenderingContext2D | null;
    private camera: Camera = overview(10, 1, 1);
    private width = 0;
    private height = 0;
    private dpr = 1;
    /** The view was fitted against a canvas that had a size. */
    private fitted = false;
    /** The canvas has no size: hidden with its page, or not laid out yet. */
    private hidden = false;
    private job: Job | null = null;
    private limits: Limits = { kinematics: "polar", r_max: 0, z_max: 0 };
    private head: Joint | null = null;
    private headBoard: Board | null = null;
    private trail: Point[] = [];
    private probeMap: HeightMap | null = null;
    private probeDraft: Grid | null = null;
    private markers: Marker[] = [];
    private selection: PathRef[] = [];
    private highlight: JobPlace | null = null;
    /** A drag picks the paths inside its box instead of orbiting or panning. */
    private boxSelect = false;
    private box: SelectBox | null = null;
    /** Called with the path a click picked (null for none) and whether it adds to the picked ones. */
    onPick: ((ref: PathRef | null, additive: boolean) => void) | null = null;
    /** Called with the paths a selection box holds and whether they add to the picked ones. */
    onBox: ((refs: PathRef[], additive: boolean) => void) | null = null;
    private heights = readFlag(HEIGHTS_KEY, true);
    /** The grid picked in this browser; null follows the machine, a grid on a cartesian one. */
    private gridChoice = readChoice(GRID_KEY);
    private pending = false;
    private observer: ResizeObserver | null = null;
    private pointers = new Map<number, Pointer>();
    private locked = readFlag(LOCK_KEY, false);
    private disposers: (() => void)[] = [];
    private palette: Colors | null = null;
    private paletteAt = 0;
    private scene: Scene | null = null;
    /** The page cannot make offscreen canvases; the still layers are drawn every frame instead. */
    private noLayers = false;
    private reachMemo: { job: Job | null; limit: number; reach: number } | null = null;

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        this.ctx = canvas.getContext("2d");
        this.bind();
        this.resize();
    }

    /** Shows a job; the view refits unless `keepView` is set, as for an edit of the same job. */
    setJob(job: Job | null, keepView = false): void {
        this.job = job;
        if (keepView) {
            this.requestDraw();
        } else {
            this.resetView();
        }
    }

    /** The height map's points, filled where probed, and a grid about to be probed. */
    setProbe(map: HeightMap | null, draft: Grid | null): void {
        if (this.probeMap !== map || !sameGrid(this.probeDraft, draft)) {
            this.probeMap = map;
            this.probeDraft = draft;
            this.requestDraw();
        }
    }

    /** The paths picked, drawn with a halo; the same array again draws nothing new. */
    setSelection(refs: PathRef[]): void {
        if (refs !== this.selection) {
            this.selection = refs;
            this.requestDraw();
        }
    }

    /** The place in the job the JSON panel's caret is in: its path drawn on top, and its point. */
    setHighlight(place: JobPlace | null): void {
        if (place !== this.highlight) {
            this.highlight = place;
            this.requestDraw();
        }
    }

    /** With box selection on, a drag picks the paths inside its box; right drag still pans. */
    get boxSelection(): boolean {
        return this.boxSelect;
    }

    setBoxSelection(on: boolean): void {
        this.boxSelect = on;
        this.box = null;
        this.requestDraw();
    }

    /**
     * The path of the job under a canvas point: the one whose line (or dot)
     * comes nearest, within `PICK_PX`; null when none is that near. A
     * model's moves are no paths and are not picked.
     */
    pick(x: number, y: number): PathRef | null {
        const job = this.job;
        if (!job || this.width === 0) {
            return null;
        }
        const frame = frameOf(this.camera);
        let best: { ref: PathRef; distance: number } | null = null;
        job.groups.forEach((group, g) => {
            group.paths.forEach((path, p) => {
                let nearest = Infinity;
                let previous: { x: number; y: number } | null = null;
                for (const [px, py] of path) {
                    const point = project(frame, this.width, this.height, [px, py, 0]);
                    if (!point) {
                        previous = null;
                        continue;
                    }
                    nearest = Math.min(nearest, previous ? segmentDistance(x, y, previous, point) : Math.hypot(x - point.x, y - point.y));
                    previous = point;
                }
                if (nearest <= PICK_PX && (best === null || nearest < best.distance)) {
                    best = { ref: [g, p], distance: nearest };
                }
            });
        });
        return best === null ? null : (best as { ref: PathRef }).ref;
    }

    /** Every path of the job wholly inside a box of canvas px. */
    pathsIn(box: SelectBox): PathRef[] {
        const job = this.job;
        if (!job) {
            return [];
        }
        const x0 = Math.min(box.x0, box.x1);
        const x1 = Math.max(box.x0, box.x1);
        const y0 = Math.min(box.y0, box.y1);
        const y1 = Math.max(box.y0, box.y1);
        const frame = frameOf(this.camera);
        const refs: PathRef[] = [];
        job.groups.forEach((group, g) => {
            group.paths.forEach((path, p) => {
                const inside = path.length > 0 && path.every(([px, py]) => {
                    const point = project(frame, this.width, this.height, [px, py, 0]);
                    return point !== null && point.x >= x0 && point.x <= x1 && point.y >= y0 && point.y <= y1;
                });
                if (inside) {
                    refs.push([g, p]);
                }
            });
        });
        return refs;
    }

    /** The saved positions to mark on the board, each with its name. */
    setMarkers(markers: Marker[]): void {
        if (markers !== this.markers) {
            this.markers = markers;
            this.requestDraw();
        }
    }

    /** Whether the height map's mesh and probe points are drawn; the choice is kept between visits. */
    get showHeights(): boolean {
        return this.heights;
    }

    setShowHeights(on: boolean): void {
        if (on !== this.heights) {
            this.heights = on;
            writeFlag(HEIGHTS_KEY, on);
            this.requestDraw();
        }
    }

    toggleHeights(): boolean {
        this.setShowHeights(!this.heights);
        return this.heights;
    }

    /**
     * Whether a square grid is drawn under the work instead of the rings:
     * the choice made in this browser, kept between visits, else the
     * machine's kind, a grid for a cartesian machine.
     */
    get showGrid(): boolean {
        return this.gridChoice ?? this.limits.kinematics === "cartesian";
    }

    setShowGrid(on: boolean): void {
        const before = this.showGrid;
        this.gridChoice = on;
        writeFlag(GRID_KEY, on);
        if (on !== before) {
            this.requestDraw();
        }
    }

    toggleGrid(): boolean {
        this.setShowGrid(!this.showGrid);
        return this.showGrid;
    }

    /** The radius limit drawn, mm; 0 is none. */
    get rMax(): number {
        return this.limits.r_max;
    }

    /** What bounds the head as drawn. */
    getLimits(): Limits {
        return { ...this.limits };
    }

    /** The radius limit alone, the machine otherwise as it was set. */
    setRMax(mm: number): void {
        this.setLimits({ ...this.limits, r_max: mm });
    }

    /** What bounds the head: the machine's kinematics and its soft limits, as its profile gives them. */
    setLimits(limits: Limits): void {
        const current = this.limits;
        if (current.kinematics !== limits.kinematics || current.r_max !== limits.r_max || current.z_max !== limits.z_max) {
            this.limits = { kinematics: limits.kinematics, r_max: limits.r_max, z_max: limits.z_max };
            this.requestDraw();
        }
    }

    /**
     * Live joint position, and the board point under the head when the
     * caller knows it (a cartesian machine's is not the joint's polar
     * point); the trail keeps the last positions that moved. A frame that
     * reports the head where it was draws nothing.
     */
    setHead(joint: Joint | null, board: Board | null = null): void {
        const next = joint ? board ?? boardOfJoint(joint) : null;
        const same = sameJoint(this.head, joint) && sameBoard(this.headBoard, next);
        this.head = joint;
        this.headBoard = next;
        if (next) {
            const last = this.trail[this.trail.length - 1];
            if (!last || Math.hypot(last[0] - next.x, last[1] - next.y) > 1e-4) {
                this.trail.push([next.x, next.y]);
                if (this.trail.length > TRAIL_LENGTH) {
                    this.trail.splice(0, this.trail.length - TRAIL_LENGTH);
                }
            }
        }
        if (!same) {
            this.requestDraw();
        }
    }

    clearTrail(): void {
        this.trail = [];
        this.requestDraw();
    }

    getCamera(): Camera {
        return { ...this.camera, target: [...this.camera.target] as Vec3 };
    }

    setCamera(camera: Camera): void {
        this.camera = { ...camera, target: [...camera.target] as Vec3 };
        this.requestDraw();
    }

    /** With the rotation locked a plain drag pans instead of orbiting; the choice is kept between visits. */
    get rotationLocked(): boolean {
        return this.locked;
    }

    setRotationLocked(locked: boolean): void {
        this.locked = locked;
        writeFlag(LOCK_KEY, locked);
        this.requestDraw();
    }

    toggleRotationLock(): boolean {
        this.setRotationLocked(!this.locked);
        return this.locked;
    }

    /** Back to the overview: the axis in the middle, tilted, everything drawn in view. */
    resetView(): void {
        this.camera = overview(this.reach(), this.width || 1, this.height || 1);
        // A canvas measures 0 by 0 until it is laid out, so a fit before
        // that is against nothing and the next real size has to redo it.
        this.fitted = this.width > 1 && this.height > 1;
        this.requestDraw();
    }

    /** One pointer dragged from `from` to `to` in canvas px: orbits, or pans. */
    dragBy(from: [number, number], to: [number, number], mode: DragMode): void {
        if (mode === "orbit") {
            this.camera = orbit(this.camera, to[0] - from[0], to[1] - from[1]);
        } else {
            this.camera = pan(this.camera, this.width || 1, this.height || 1, from, to);
        }
        this.requestDraw();
    }

    /** The wheel, or a pinch: zoom by `factor` about a canvas point. */
    zoomBy(at: [number, number], factor: number): void {
        this.camera = zoomAt(this.camera, this.width || 1, this.height || 1, at[0], at[1], factor);
        this.requestDraw();
    }

    resize(): void {
        const rect = this.canvas.getBoundingClientRect();
        // A canvas hidden with its page measures 0 by 0: nothing is drawn
        // into it until it is back, and then once at least, since the
        // head went on moving meanwhile.
        const hidden = !(rect.width > 0 && rect.height > 0);
        const back = this.hidden && !hidden;
        this.hidden = hidden;
        if (hidden) {
            return;
        }
        const width = Math.max(1, Math.round(rect.width));
        const height = Math.max(1, Math.round(rect.height));
        const dpr = typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1;
        const refit = !this.fitted;
        if (width !== this.width || height !== this.height || dpr !== this.dpr) {
            this.width = width;
            this.height = height;
            this.dpr = dpr;
            this.canvas.width = Math.round(width * dpr);
            this.canvas.height = Math.round(height * dpr);
            if (refit) {
                this.resetView();
            } else {
                this.requestDraw();
            }
        } else if (back) {
            this.requestDraw();
        }
    }

    /** Reads the palette from the stylesheet again, as after a change of theme. */
    refreshColors(): void {
        this.paletteAt = Number.NEGATIVE_INFINITY;
        this.requestDraw();
    }

    dispose(): void {
        for (const dispose of this.disposers) {
            dispose();
        }
        this.disposers = [];
        this.observer?.disconnect();
        this.observer = null;
    }

    requestDraw(): void {
        if (this.pending) {
            return;
        }
        this.pending = true;
        const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn: () => void) => setTimeout(fn, 16);
        raf(() => {
            this.pending = false;
            this.draw();
        });
    }

    draw(): void {
        const ctx = this.ctx;
        if (!ctx || this.hidden || this.width === 0) {
            return;
        }
        const colors = this.colors();
        const { width, height, dpr, camera } = this;
        const reach = this.reach();
        const frame = frameOf(camera);
        const scale = pxPerMm(camera, height);
        const cartesian = this.limits.kinematics === "cartesian";
        const extent = Math.max(reach * 1.5, 10);
        const headHeight = Math.max(1, reach * HEAD_HEIGHT);
        const at = (x: number, y: number, z = 0) => project(frame, width, height, [x, y, z]);
        const grid = this.showGrid;
        // The grid's or the rings' step follows the zoom, over the part of
        // the board in view.
        const layout = gridLayout(scale, visibleBox(camera, width, height, extent), !grid);

        const scene = this.stillScene(colors, reach, scale, extent, layout);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        if (scene) {
            this.blit(ctx, scene.under);
        } else {
            this.drawBoard(ctx, frame, colors, layout, scale);
        }

        // The rail, floating at the head's height: along +X from the axis
        // on the polar machine, where it is the radius; through the head
        // along the table's turned X on a cartesian one, which carries it
        // across the table on the cross slide.
        ctx.strokeStyle = colors.rail;
        ctx.lineWidth = 2;
        ctx.setLineDash([8, 6]);
        if (cartesian) {
            const through = this.headBoard ?? { x: 0, y: 0 };
            const along = turned({ x: extent, y: 0 }, this.head?.a ?? 0);
            this.polyline(ctx, frame, [
                [through.x - along.x, through.y - along.y, headHeight],
                [through.x + along.x, through.y + along.y, headHeight],
            ]);
        } else {
            this.polyline(ctx, frame, [[0, 0, headHeight], [extent, 0, headHeight]]);
        }
        ctx.setLineDash([]);
        // The column from the axis up to the rail, so the height reads.
        ctx.globalAlpha = 0.4;
        ctx.lineWidth = 1;
        this.polyline(ctx, frame, [[0, 0, 0], [0, 0, headHeight]]);
        ctx.globalAlpha = 1;

        let exaggeration: number | null;
        if (scene) {
            this.blit(ctx, scene.over);
            exaggeration = scene.exaggeration;
        } else {
            exaggeration = this.drawWork(ctx, frame, colors, reach, scale, extent);
        }

        // Trail and head.
        if (this.trail.length > 1) {
            ctx.strokeStyle = colors.trail;
            ctx.lineWidth = 2;
            ctx.globalAlpha = 0.7;
            this.polyline(ctx, frame, this.trail.map(([x, y]) => [x, y, 0] as Vec3));
            ctx.globalAlpha = 1;
        }
        if (this.head && this.headBoard) {
            const board = this.headBoard;
            ctx.strokeStyle = colors.head;
            ctx.fillStyle = colors.head;
            ctx.lineWidth = 1.5;
            // The radius line from the axis to the head, which on a
            // cartesian machine is no joint of it.
            if (!cartesian) {
                ctx.globalAlpha = 0.5;
                this.polyline(ctx, frame, [[0, 0, 0], [board.x, board.y, 0]]);
                ctx.globalAlpha = 1;
            }
            // The beam from the head down to the board.
            ctx.globalAlpha = 0.6;
            this.polyline(ctx, frame, [[board.x, board.y, 0], [board.x, board.y, headHeight]]);
            ctx.globalAlpha = 1;
            const spot = at(board.x, board.y, 0);
            if (spot) {
                ctx.beginPath();
                ctx.arc(spot.x, spot.y, 2.5, 0, Math.PI * 2);
                ctx.fill();
            }
            const marker = at(board.x, board.y, headHeight);
            if (marker) {
                ctx.beginPath();
                ctx.arc(marker.x, marker.y, 6, 0, Math.PI * 2);
                ctx.stroke();
                ctx.beginPath();
                ctx.arc(marker.x, marker.y, 2, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        // Labels in screen space on the heavier lines or rings, every one
        // while they are far enough apart to read, every second or fourth
        // beyond: the rings along the rail, or toward the middle of the
        // view when the rail is out of it; the grid's lines along both axes,
        // or along the view's lower and left edges when an axis is out of it.
        const { step, box } = layout;
        ctx.fillStyle = colors.text;
        ctx.font = "0.75rem system-ui, sans-serif";
        ctx.textBaseline = "top";
        ctx.textAlign = "left";
        const label = (text: string, x: number, y: number): void => {
            const p = at(x, y, 0);
            if (p && p.x > 0 && p.x < width && p.y > 0 && p.y < height) {
                ctx.fillText(text, p.x + 3, p.y + 3);
            }
        };
        const major = step * majorEvery(step);
        const every = labelEvery(major, scale);
        // A grid line's label sits where it meets the axis across it; with
        // that point off the canvas, where the line meets the canvas's
        // lower edge (lines along Y) or its left edge (lines along X).
        const lineLabel = (text: string, from: Point, to: Point, axis: Point, edge: "bottom" | "left"): void => {
            const p = at(axis[0], axis[1], 0);
            if (p && p.x > 0 && p.x < width && p.y > 0 && p.y < height) {
                ctx.fillText(text, p.x + 3, p.y + 3);
                return;
            }
            const a = at(from[0], from[1], 0);
            const b = at(to[0], to[1], 0);
            if (!a || !b) {
                return;
            }
            const [along, across, place] = edge === "bottom" ? [a.y, b.y, height - 34] : [a.x, b.x, 6];
            if (Math.abs(across - along) < 1e-9) {
                return;
            }
            const t = (place - along) / (across - along);
            if (t < 0 || t > 1) {
                return;
            }
            const x = edge === "bottom" ? a.x + (b.x - a.x) * t : place;
            const y = edge === "bottom" ? place : a.y + (b.y - a.y) * t;
            if (x > 0 && x < width && y > 0 && y < height) {
                ctx.fillText(text, x + 3, y + 3);
            }
        };
        if (box) {
            if (grid) {
                for (let k = Math.ceil(box.x0 / major - 1e-9); k * major <= box.x1 + 1e-9; k++) {
                    if (k !== 0 && k % every === 0) {
                        const v = k * major;
                        lineLabel(formatTick(v), [v, box.y0], [v, box.y1], [v, 0], "bottom");
                    }
                }
                for (let k = Math.ceil(box.y0 / major - 1e-9); k * major <= box.y1 + 1e-9; k++) {
                    if (k !== 0 && k % every === 0) {
                        const v = k * major;
                        lineLabel(formatTick(v), [box.x0, v], [box.x1, v], [0, v], "left");
                    }
                }
            } else {
                const { rings, from, to } = ringsIn(step, box);
                const rail = to - from >= Math.PI * 2 - 1e-9 || (from <= 0 && 0 <= to) || (from <= Math.PI * 2 && Math.PI * 2 <= to);
                const angle = rail ? 0 : (from + to) / 2;
                for (const ring of rings) {
                    const k = Math.round(ring.radius / major);
                    if (ring.major && k % every === 0) {
                        label(`${formatTick(ring.radius)} mm`, ring.radius * Math.cos(angle), ring.radius * Math.sin(angle));
                    }
                }
            }
        }
        this.drawMarkerLabels(ctx, at, colors, width, height);
        ctx.textAlign = "right";
        ctx.textBaseline = "bottom";
        const notes = [`elev ${Math.round(camera.pitch)} deg`];
        notes.unshift(`${grid ? "grid" : "rings"} ${formatTick(step)} mm`);
        if (this.locked) {
            notes.unshift("rotation locked");
        }
        if (exaggeration !== null) {
            notes.unshift(`heights x${exaggeration >= 10 ? Math.round(exaggeration) : exaggeration.toFixed(1)}`);
        }
        if (this.boxSelect) {
            notes.unshift("box select");
        }
        ctx.fillText(notes.join("   "), width - 6, height - 4);
        // The selection box being dragged.
        const band = this.box;
        if (band) {
            ctx.save();
            ctx.strokeStyle = colors.select;
            ctx.lineWidth = 1;
            ctx.setLineDash([5, 3]);
            ctx.strokeRect(Math.min(band.x0, band.x1), Math.min(band.y0, band.y1), Math.abs(band.x1 - band.x0), Math.abs(band.y1 - band.y0));
            ctx.restore();
        }
    }

    /** The farthest thing drawn, as `jobReach` has it, worked out once per job and limit rather than per frame. */
    private reach(): number {
        const limit = limitReach(this.limits);
        const memo = this.reachMemo;
        if (memo && memo.job === this.job && memo.limit === limit) {
            return memo.reach;
        }
        const reach = jobReach(this.job, limit);
        this.reachMemo = { job: this.job, limit, reach };
        return reach;
    }

    /**
     * The still layers for the picture of the moment, drawn again only when
     * something in them changed; null where offscreen canvases cannot be
     * had, and the layers are then drawn straight onto the canvas.
     */
    private stillScene(colors: Colors, reach: number, scale: number, extent: number, layout: GridLayout): Scene | null {
        if (this.noLayers) {
            return null;
        }
        const key: SceneKey = {
            job: this.job,
            probeMap: this.probeMap,
            probeDraft: this.probeDraft,
            heights: this.heights,
            grid: this.showGrid,
            markers: this.markers,
            selection: this.selection,
            highlight: this.highlight,
            camera: this.camera,
            width: this.width,
            height: this.height,
            dpr: this.dpr,
            colors,
            limits: this.limits,
            angle: this.limits.kinematics === "cartesian" ? this.head?.a ?? 0 : null,
        };
        const scene = this.scene;
        if (scene && sameSceneKey(scene.key, key)) {
            return scene;
        }
        const under = scene?.under ?? this.layerCanvas();
        const over = scene?.over ?? this.layerCanvas();
        const underCtx = under?.getContext("2d");
        const overCtx = over?.getContext("2d");
        if (!under || !over || !underCtx || !overCtx) {
            this.noLayers = true;
            this.scene = null;
            return null;
        }
        const frame = frameOf(this.camera);
        this.beginLayer(under, underCtx);
        this.drawBoard(underCtx, frame, colors, layout, scale);
        this.beginLayer(over, overCtx);
        const exaggeration = this.drawWork(overCtx, frame, colors, reach, scale, extent);
        this.scene = { key, under, over, exaggeration };
        return this.scene;
    }

    private layerCanvas(): HTMLCanvasElement | null {
        if (typeof document === "undefined") {
            return null;
        }
        return document.createElement("canvas");
    }

    /** Sizes a layer to the canvas and wipes it, the transform set so it is drawn in CSS px like the canvas. */
    private beginLayer(layer: HTMLCanvasElement, ctx: CanvasRenderingContext2D): void {
        const width = Math.round(this.width * this.dpr);
        const height = Math.round(this.height * this.dpr);
        if (layer.width !== width || layer.height !== height) {
            layer.width = width;
            layer.height = height;
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, width, height);
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.globalAlpha = 1;
        ctx.setLineDash([]);
    }

    /** Copies a layer onto the canvas, device pixel for device pixel. */
    private blit(ctx: CanvasRenderingContext2D, layer: HTMLCanvasElement): void {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(layer, 0, 0);
        ctx.restore();
    }

    /**
     * The board: the background, and the rings about the axis or a square
     * grid over the part of it in view, the finer lines faint and every
     * heavier one at full strength. A ring is drawn over the arc in view,
     * its chords within a third of a pixel of the circle, so it stays round
     * however far in the view is zoomed.
     */
    private drawBoard(ctx: CanvasRenderingContext2D, frame: Frame, colors: Colors, layout: GridLayout, scale: number): void {
        ctx.fillStyle = colors.bg;
        ctx.fillRect(0, 0, this.width, this.height);
        const { step, box } = layout;
        if (box === null) {
            return;
        }
        ctx.strokeStyle = colors.grid;
        ctx.lineWidth = 1;
        const lines = this.showGrid ? gridLinesIn(step, box) : [];
        const rings = this.showGrid ? null : ringsIn(step, box);
        const tolerance = 0.3 / (scale > 0 ? scale : 1);
        for (const major of [false, true]) {
            ctx.globalAlpha = major ? 1 : MINOR_ALPHA;
            ctx.beginPath();
            let drawn = false;
            for (const line of lines) {
                if (line.major === major) {
                    drawn = this.tracePolyline(ctx, frame, [[line.from[0], line.from[1], 0], [line.to[0], line.to[1], 0]], false) || drawn;
                }
            }
            for (const ring of rings?.rings ?? []) {
                if (ring.major === major) {
                    drawn = this.tracePolyline(ctx, frame, arcPoints(ring.radius, rings!.from, rings!.to, tolerance), false) || drawn;
                }
            }
            if (drawn) {
                ctx.stroke();
            }
        }
        ctx.globalAlpha = 1;
    }

    /**
     * What lies on the board over the rail: the soft limits, the job's
     * copper, paths and outline, the probe grid and the axis cross. Returns
     * the stretch of the probed heights, or null when no surface was drawn.
     */
    private drawWork(ctx: CanvasRenderingContext2D, frame: Frame, colors: Colors, reach: number, scale: number, extent: number): number | null {
        const limit = limitShape(this.limits, this.head?.a ?? 0, extent);
        if (limit) {
            ctx.strokeStyle = colors.rmax;
            ctx.lineWidth = 1.5;
            ctx.setLineDash([4, 4]);
            if (limit.kind === "circle") {
                this.polyline(ctx, frame, circlePoints(limit.radius, 96), true);
            } else if (limit.kind === "outline") {
                this.polyline(ctx, frame, limit.points.map(([x, y]) => [x, y, 0] as Vec3), true);
            } else {
                for (const [[x0, y0], [x1, y1]] of limit.lines) {
                    this.polyline(ctx, frame, [[x0, y0, 0], [x1, y1, 0]]);
                }
            }
            ctx.setLineDash([]);
        }

        const job = this.job;
        if (job) {
            if (job.copper.length > 0) {
                ctx.fillStyle = colors.copper;
                ctx.globalAlpha = 0.35;
                this.fillPaths(ctx, frame, job.copper);
                ctx.globalAlpha = 1;
            }
            const spot = job.spot > 0 ? job.spot : 0.1;
            // The picked paths: a halo a few px wider than the line, under it.
            if (this.selection.length > 0) {
                ctx.strokeStyle = colors.select;
                ctx.fillStyle = colors.select;
                ctx.globalAlpha = 0.45;
                ctx.lineWidth = Math.max(spot * scale, 1.2) + 7;
                const picked = this.selection
                    .map(([g, p]) => job.groups[g]?.paths[p])
                    .filter((path): path is Path => path !== undefined);
                this.strokePaths(ctx, frame, picked);
                ctx.globalAlpha = 1;
            }
            job.groups.forEach((group, index) => {
                const color = colors.groups[index % colors.groups.length] ?? colors.axis;
                ctx.strokeStyle = color;
                ctx.fillStyle = color;
                ctx.globalAlpha = group.enabled ? 0.9 : 0.25;
                if (group.moves && group.moves.length > 0) {
                    // A model's toolpaths are too dense to draw a tool
                    // wide: thin lines, at their depth under the board.
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    let drawn = false;
                    for (const run of cutRuns(group.moves)) {
                        drawn = this.tracePolyline(ctx, frame, run, false) || drawn;
                    }
                    if (drawn) {
                        ctx.stroke();
                    }
                    return;
                }
                ctx.lineWidth = Math.max(spot * scale, 1.2);
                this.strokePaths(ctx, frame, group.paths.filter((path) => path.length !== 1));
                // A path of one point is a dot: a drill, or a dot of paste
                // the size of its pad.
                group.paths.forEach((path, dot) => {
                    if (path.length === 1) {
                        this.fillDot(ctx, frame, path[0]!, dotRadius(group.areas?.[dot], spot), scale);
                    }
                });
            });
            ctx.globalAlpha = 1;
            if (job.outline.length > 0) {
                ctx.strokeStyle = colors.outline;
                // A model's outline and block, and the shape a Mill page
                // operation cuts, are where it lies, not a cut: a thin line,
                // so the toolpaths under it show.
                const thin = job.source === "mill" || job.groups.some((group) => (group.moves?.length ?? 0) > 0);
                ctx.lineWidth = thin ? 1 : Math.max(spot * scale / 2, 1);
                this.strokePaths(ctx, frame, job.outline);
            }
            this.drawHighlight(ctx, frame, colors, job, spot, scale);
        }

        const exaggeration = this.heights ? this.drawProbe(ctx, frame, colors, reach) : null;

        // The markers: a diagonal cross and a ring, eight px whatever the
        // zoom, so they read apart from the axis cross.
        const size = 8 / scale;
        ctx.strokeStyle = colors.marker;
        ctx.lineWidth = 1.5;
        for (const marker of this.markers) {
            const { x, y } = marker;
            this.polyline(ctx, frame, [[x - size, y - size, 0], [x + size, y + size, 0]]);
            this.polyline(ctx, frame, [[x - size, y + size, 0], [x + size, y - size, 0]]);
            this.polyline(ctx, frame, circlePoints(size * 0.7, 16).map(([cx, cy]) => [x + cx, y + cy, 0] as Vec3), true);
        }

        // Axis cross, ten px wide whatever the zoom.
        const cross = 10 / scale;
        ctx.strokeStyle = colors.axis;
        ctx.lineWidth = 1.5;
        this.polyline(ctx, frame, [[-cross, 0, 0], [cross, 0, 0]]);
        this.polyline(ctx, frame, [[0, -cross, 0], [0, cross, 0]]);
        return exaggeration;
    }

    /**
     * The place the JSON panel's caret is in: its path over everything in
     * the highlight color, and with a point named, the segments either side
     * of it thicker still and the point as a ring.
     */
    private drawHighlight(ctx: CanvasRenderingContext2D, frame: Frame, colors: Colors, job: Job, spot: number, scale: number): void {
        const place = this.highlight;
        if (!place) {
            return;
        }
        const list = place.list === "groups" ? job.groups[place.group ?? -1]?.paths : place.list === "outline" ? job.outline : job.copper;
        const path = list?.[place.path];
        if (!path || path.length === 0) {
            return;
        }
        ctx.strokeStyle = colors.highlight;
        ctx.fillStyle = colors.highlight;
        ctx.globalAlpha = 0.9;
        ctx.lineWidth = Math.max(spot * scale, 1.2) + 3;
        this.strokePaths(ctx, frame, [path]);
        if (place.point !== null && path[place.point]) {
            const i = place.point;
            const around = path.slice(Math.max(0, i - 1), Math.min(path.length, i + 2));
            ctx.lineWidth = Math.max(spot * scale, 1.2) + 7;
            this.strokePaths(ctx, frame, [around]);
            const [x, y] = path[i]!;
            const p = project(frame, this.width, this.height, [x, y, 0]);
            if (p) {
                ctx.lineWidth = 2;
                ctx.globalAlpha = 1;
                ctx.beginPath();
                ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
                ctx.stroke();
            }
        }
        ctx.globalAlpha = 1;
    }

    /** The markers' names beside them, in screen space so they stay upright. */
    private drawMarkerLabels(
        ctx: CanvasRenderingContext2D,
        at: (x: number, y: number, z?: number) => { x: number; y: number } | null,
        colors: Colors,
        width: number,
        height: number,
    ): void {
        if (this.markers.length === 0) {
            return;
        }
        ctx.save();
        ctx.fillStyle = colors.marker;
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";
        for (const marker of this.markers) {
            const p = at(marker.x, marker.y, 0);
            if (p && p.x > 0 && p.x < width && p.y > 0 && p.y < height) {
                ctx.fillText(marker.name, p.x + 7, p.y - 5);
            }
        }
        ctx.restore();
    }

    /**
     * The probe grid: its outline and points, solid and filled where the
     * map is probed, dashed and hollow for a grid not probed yet; the
     * probed heights raised out of the board, stretched to be seen, as a
     * mesh with each point colored below or above the mean. Returns the
     * stretch, or null when no surface was drawn.
     */
    private drawProbe(ctx: CanvasRenderingContext2D, frame: Frame, colors: Colors, reach: number): number | null {
        const map = this.probeMap;
        const draft = this.probeDraft;
        const grids: { grid: Grid; heights: (number | null)[][] | null }[] = [];
        if (draft !== null && (map === null || !sameGrid(draft, map.grid))) {
            grids.push({ grid: draft, heights: null });
        }
        if (map !== null) {
            grids.push({ grid: map.grid, heights: map.heights });
        }
        let exaggeration: number | null = null;
        ctx.lineWidth = 1.2;
        for (const { grid, heights } of grids) {
            ctx.strokeStyle = colors.probe;
            ctx.fillStyle = colors.probe;
            ctx.setLineDash(heights === null ? [5, 4] : []);
            ctx.globalAlpha = heights === null ? 0.7 : 0.9;
            this.polyline(ctx, frame, [[grid.x0, grid.y0, 0], [grid.x1, grid.y0, 0], [grid.x1, grid.y1, 0], [grid.x0, grid.y1, 0]], true);
            ctx.setLineDash([]);
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
                for (let iy = 0; iy < grid.ny; iy++) {
                    this.polyline(ctx, frame, Array.from({ length: grid.nx }, (_, ix) => raised(iy * grid.nx + ix)));
                }
                for (let ix = 0; ix < grid.nx; ix++) {
                    this.polyline(ctx, frame, Array.from({ length: grid.ny }, (_, iy) => raised(iy * grid.nx + ix)));
                }
            }
            // A pad map's points are the pads probed, not the grid's cells:
            // drawn on the board, filled once probed.
            const pads = heights !== null && map?.points && map.point_heights ? map : null;
            if (pads && pads.points && pads.point_heights) {
                const padHeights = pads.point_heights;
                pads.points.forEach(([x, y], index) => {
                    const height = padHeights[index] ?? null;
                    const top: Vec3 = height !== null && spread ? [x, y, (height - spread.mean) * stretch] : [x, y, 0];
                    const p = project(frame, this.width, this.height, top);
                    if (!p) {
                        return;
                    }
                    ctx.beginPath();
                    ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
                    if (height !== null) {
                        ctx.fillStyle = top[2] !== 0 ? (top[2] < 0 ? colors.low : colors.high) : colors.probe;
                        ctx.fill();
                    } else {
                        ctx.stroke();
                    }
                });
            } else {
                points.forEach(([x, y], index) => {
                    const top = raised(index);
                    const probed = heights !== null && (heights[Math.floor(index / grid.nx)]?.[index % grid.nx] ?? null) !== null;
                    const p = project(frame, this.width, this.height, top ?? [x, y, 0]);
                    if (!p) {
                        return;
                    }
                    ctx.beginPath();
                    ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
                    if (probed) {
                        ctx.fillStyle = top && top[2] !== 0 ? (top[2] < 0 ? colors.low : colors.high) : colors.probe;
                        ctx.fill();
                    } else {
                        ctx.stroke();
                    }
                });
            }
        }
        ctx.globalAlpha = 1;
        return exaggeration;
    }

    /** Strokes world points as one line, the pen up across a point behind the eye or a null; `closed` joins the last to the first. */
    private polyline(ctx: CanvasRenderingContext2D, frame: Frame, points: (Vec3 | null)[], closed = false): void {
        ctx.beginPath();
        if (this.tracePolyline(ctx, frame, points, closed)) {
            ctx.stroke();
        }
    }

    private tracePolyline(ctx: CanvasRenderingContext2D, frame: Frame, points: (Vec3 | null)[], closed: boolean): boolean {
        let pen = false;
        let drawn = false;
        let broken = false;
        let first: { x: number; y: number } | null = null;
        for (const point of points) {
            const p = point ? project(frame, this.width, this.height, point) : null;
            if (!p) {
                // Closing across a gap would draw a chord through the view.
                pen = false;
                broken = true;
                continue;
            }
            if (!pen) {
                ctx.moveTo(p.x, p.y);
                pen = true;
                first = first ?? p;
            } else {
                ctx.lineTo(p.x, p.y);
                drawn = true;
            }
        }
        if (closed && pen && first && !broken) {
            ctx.lineTo(first.x, first.y);
            drawn = true;
        }
        return drawn;
    }

    /** A filled circle on the board at `point`, `radius` mm across the board but at least a couple of pixels. */
    private fillDot(ctx: CanvasRenderingContext2D, frame: Frame, point: Point, radius: number, scale: number): void {
        const p = project(frame, this.width, this.height, [point[0], point[1], 0]);
        if (!p) {
            return;
        }
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(radius * scale, 1.5), 0, Math.PI * 2);
        ctx.fill();
    }

    private strokePaths(ctx: CanvasRenderingContext2D, frame: Frame, paths: Path[]): void {
        ctx.beginPath();
        let drawn = false;
        for (const path of paths) {
            // A path of one point is a drill: the round cap of a zero
            // length stroke draws it as a dot of the spot's width.
            const points = path.length === 1 ? [path[0]!, path[0]!] : path;
            drawn = this.tracePolyline(ctx, frame, points.map(([x, y]) => [x, y, 0] as Vec3), false) || drawn;
        }
        if (drawn) {
            ctx.stroke();
        }
    }

    /** Fills closed board shapes, even-odd so holes stay holes; a path with a point behind the eye is left out. */
    private fillPaths(ctx: CanvasRenderingContext2D, frame: Frame, paths: Path[]): void {
        ctx.beginPath();
        let drawn = false;
        for (const path of paths) {
            const projected: { x: number; y: number }[] = [];
            for (const [x, y] of path) {
                const p = project(frame, this.width, this.height, [x, y, 0]);
                if (!p) {
                    break;
                }
                projected.push(p);
            }
            if (projected.length < path.length || projected.length < 3) {
                continue;
            }
            projected.forEach((p, index) => (index === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
            ctx.closePath();
            drawn = true;
        }
        if (drawn) {
            ctx.fill("evenodd");
        }
    }

    /**
     * The palette from the stylesheet, read again after a change of theme
     * or once a second at most, since every read is a computed style; the
     * same values keep the same object, so the still layers drawn with
     * them stand.
     */
    private colors(): Colors {
        const now = typeof performance !== "undefined" ? performance.now() : Date.now();
        if (this.palette && now - this.paletteAt < PALETTE_MS) {
            return this.palette;
        }
        const read = readColors(this.canvas);
        this.paletteAt = now;
        if (!this.palette || !sameColors(this.palette, read)) {
            this.palette = read;
        }
        return this.palette;
    }

    private canvasPoint(event: { clientX: number; clientY: number }): [number, number] {
        const rect = this.canvas.getBoundingClientRect();
        return [event.clientX - rect.left, event.clientY - rect.top];
    }

    private bind(): void {
        const canvas = this.canvas;
        const on = <K extends keyof HTMLElementEventMap>(type: K, handler: (event: HTMLElementEventMap[K]) => void, options?: AddEventListenerOptions): void => {
            canvas.addEventListener(type, handler, options);
            this.disposers.push(() => canvas.removeEventListener(type, handler, options));
        };
        on("wheel", (event) => {
            event.preventDefault();
            this.zoomBy(this.canvasPoint(event), event.deltaY < 0 ? 1.2 : 1 / 1.2);
        }, { passive: false });
        on("contextmenu", (event) => event.preventDefault());
        on("pointerdown", (event) => {
            const [x, y] = this.canvasPoint(event);
            this.pointers.set(event.pointerId, {
                x, y, button: event.button, shiftKey: event.shiftKey,
                downX: x, downY: y, moved: false,
                additive: event.shiftKey || event.ctrlKey || event.metaKey,
            });
            canvas.setPointerCapture?.(event.pointerId);
        });
        on("pointermove", (event) => {
            const pointer = this.pointers.get(event.pointerId);
            if (!pointer) {
                return;
            }
            const [x, y] = this.canvasPoint(event);
            if (!pointer.moved && Math.hypot(x - pointer.downX, y - pointer.downY) > CLICK_PX) {
                pointer.moved = true;
            }
            if (this.boxSelect && pointer.button === 0 && this.pointers.size === 1) {
                // A drag with box selection on draws the box, nothing turns.
                if (pointer.moved) {
                    this.box = { x0: pointer.downX, y0: pointer.downY, x1: x, y1: y };
                    this.requestDraw();
                }
                pointer.x = x;
                pointer.y = y;
                return;
            }
            const others = Array.from(this.pointers.entries()).filter(([id]) => id !== event.pointerId);
            if (others.length > 0) {
                // Two fingers: zoom by how their distance changed, about
                // their middle, and pan by how the middle moved.
                const other = others[0]![1];
                const before = Math.hypot(pointer.x - other.x, pointer.y - other.y);
                const after = Math.hypot(x - other.x, y - other.y);
                const midBefore: [number, number] = [(pointer.x + other.x) / 2, (pointer.y + other.y) / 2];
                const midAfter: [number, number] = [(x + other.x) / 2, (y + other.y) / 2];
                if (before > 0 && after > 0) {
                    this.zoomBy(midAfter, after / before);
                }
                this.dragBy(midBefore, midAfter, "pan");
            } else {
                this.dragBy([pointer.x, pointer.y], [x, y], dragMode(this.locked, { button: pointer.button, shiftKey: event.shiftKey || pointer.shiftKey }));
            }
            pointer.x = x;
            pointer.y = y;
        });
        const end = (event: PointerEvent): void => {
            const pointer = this.pointers.get(event.pointerId);
            const alone = this.pointers.size === 1;
            this.pointers.delete(event.pointerId);
            if (!pointer || event.type !== "pointerup" || !alone || pointer.button !== 0) {
                this.box = null;
                return;
            }
            if (this.box) {
                const refs = this.pathsIn(this.box);
                this.box = null;
                this.requestDraw();
                this.onBox?.(refs, pointer.additive);
            } else if (!pointer.moved) {
                const [x, y] = this.canvasPoint(event);
                this.onPick?.(this.pick(x, y), pointer.additive);
            }
        };
        on("pointerup", end);
        on("pointercancel", end);
        on("dblclick", () => this.resetView());

        if (typeof ResizeObserver === "function") {
            this.observer = new ResizeObserver(() => this.resize());
            this.observer.observe(canvas);
        } else if (typeof window !== "undefined") {
            const handler = (): void => this.resize();
            window.addEventListener("resize", handler);
            this.disposers.push(() => window.removeEventListener("resize", handler));
        }
        if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
            const media = window.matchMedia("(prefers-color-scheme: dark)");
            const handler = (): void => this.refreshColors();
            media.addEventListener?.("change", handler);
            this.disposers.push(() => media.removeEventListener?.("change", handler));
        }
    }
}

/** A dot's radius on the board, mm: that of a circle of its pad's area, or half the spot without one. */
export function dotRadius(area: number | undefined, spot: number): number {
    if (area !== undefined && area > 0) {
        return Math.sqrt(area / Math.PI);
    }
    return spot / 2;
}

function sameJoint(a: Joint | null, b: Joint | null): boolean {
    if (a === null || b === null) {
        return a === b;
    }
    return a.r === b.r && a.a === b.a;
}

function sameBoard(a: Board | null, b: Board | null): boolean {
    if (a === null || b === null) {
        return a === b;
    }
    return a.x === b.x && a.y === b.y;
}
