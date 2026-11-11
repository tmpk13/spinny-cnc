// An ASCII DXF drawing as board paths in millimeters, one set a layer: the
// in-page mock's twin of the toolpath library's reader (spinny_laser.dxf),
// step for step, so a DXF upload gives the mock the paths the backend
// would make. Read: LINE; LWPOLYLINE and POLYLINE, their bulges as arcs;
// ARC; CIRCLE; ELLIPSE; SPLINE, flattened, or the line through its fit
// points when it gives no control points; INSERT of a block, scaled,
// turned, in rows and columns and nested, a block's entities on layer 0
// taking the insert's layer. An entity's own coordinate system (an
// extrusion other than +Z) is honored, heights are dropped, $INSUNITS
// gives the unit (millimeters when it gives none), and lines whose ends
// meet are joined into paths. Text, hatches, dimensions and the like, the
// entities of a layer switched off or frozen, invisible ones and paper
// space are left out; a binary DXF is refused. The test reads the
// fixtures the backend's reader is checked on and compares the paths.

import type { Path, Point } from "../types.ts";

/** A 2D affine map (a, b, c, d, e, f): (x, y) to (a x + c y + e, b x + d y + f). */
type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const BINARY_SENTINEL = "AutoCAD Binary DXF";
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);
const LINE_END = /\r\n|\r|\n/;
const BLANKS = /^[ \t\f\v]+|[ \t\f\v]+$/g;
const WHOLE = /^[+-]?[0-9]+$/;
const REAL = /^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;

/** Millimeters a unit for each $INSUNITS code; 0 (no unit) is taken as mm. */
const UNITS_MM: Record<number, number> = {
    0: 1, 1: 25.4, 2: 304.8, 3: 1_609_344, 4: 1, 5: 10, 6: 1000, 7: 1_000_000, 8: 25.4e-6, 9: 0.0254, 10: 914.4,
    11: 1e-7, 12: 1e-6, 13: 1e-3, 14: 100, 15: 10_000, 16: 100_000, 17: 1e12, 18: 1.495978707e14, 19: 9.4607304725808e18,
    20: 3.0856775814913673e19,
};

/** Blocks inserted in blocks this deep at most. */
const MAX_NESTING = 16;
/** Chords a curve is cut into at most, and at least one every eighth of a turn. */
const MAX_STEPS = 10_000;
const MIN_STEP = Math.PI / 4;
/** A spline's spans are halved at most this deep while flattening. */
const SPLINE_DEPTH = 12;
const DEFAULT_LAYER = "0";
/** Ends nearer than this, mm, are joined (the backend's clear.JOIN_EPSILON). */
const JOIN_EPSILON = 1e-3;
const DEG = Math.PI / 180;

export interface DxfLayer {
    name: string;
    paths: Path[];
}

export interface DxfDrawing {
    /** The layers that draw something, in the order they first draw. */
    layers: DxfLayer[];
    unitMm: number;
}

/** The label a layer's paths take in a job: its name after "layer". */
export function layerLabel(name: string): string {
    return `layer ${name}`;
}

/** A string as Python's repr quotes it, as the backend's messages do. */
function quoted(text: string): string {
    return text.includes("'") && !text.includes('"') ? `"${text}"` : `'${text.replaceAll("'", "\\'")}'`;
}

/** Python's float remainder: the sign of the divisor. */
function pyMod(a: number, b: number): number {
    const m = a % b;
    return m !== 0 && (m < 0) !== (b < 0) ? m + b : m;
}

type Pair = [number, string];

function pairsOf(text: string): Pair[] {
    if (text.startsWith(BYTE_ORDER_MARK)) {
        text = text.slice(1);
    }
    if (text.startsWith(BINARY_SENTINEL)) {
        throw new Error("a binary DXF: save the drawing as an ASCII DXF");
    }
    const lines = text.split(LINE_END);
    const pairs: Pair[] = [];
    for (let index = 0; index + 1 < lines.length; index += 2) {
        const code = lines[index]!.replace(BLANKS, "");
        if (!WHOLE.test(code)) {
            throw new Error(`not an ASCII DXF: line ${index + 1} should be a group code, not ${quoted(code.slice(0, 20))}`);
        }
        pairs.push([Number(code), lines[index + 1]!.replace(BLANKS, "")]);
    }
    return pairs;
}

/** A value as a number, in the one form a DXF writes them. */
function real(kind: string, code: number, value: string): number {
    if (!REAL.test(value)) {
        throw new Error(`${kind}: group ${code} should be a number, not ${quoted(value.slice(0, 20))}`);
    }
    const number = Number(value);
    if (!Number.isFinite(number)) {
        throw new Error(`${kind}: group ${code} is not a finite number`);
    }
    return number;
}

class Entity {
    readonly pairs: Pair[] = [];

    constructor(readonly kind: string) {}

    text(code: number, fallback = ""): string {
        for (const [c, value] of this.pairs) {
            if (c === code) {
                return value;
            }
        }
        return fallback;
    }

    number(code: number, fallback = 0): number {
        for (const [c, value] of this.pairs) {
            if (c === code) {
                return real(this.kind, code, value);
            }
        }
        return fallback;
    }

    whole(code: number, fallback = 0): number {
        return Math.trunc(this.number(code, fallback));
    }

    numbers(code: number): number[] {
        return this.pairs.filter(([c]) => c === code).map(([, value]) => real(this.kind, code, value));
    }

    normal(): [number, number, number] {
        return [this.number(210, 0), this.number(220, 0), this.number(230, 1)];
    }
}

function entitiesOf(pairs: Pair[]): Entity[] {
    const out: Entity[] = [];
    for (const [code, value] of pairs) {
        if (code === 0) {
            out.push(new Entity(value));
        } else {
            out[out.length - 1]?.pairs.push([code, value]);
        }
    }
    return out;
}

function sectionsOf(pairs: Pair[]): Map<string, Pair[]> {
    const sections = new Map<string, Pair[]>();
    let index = 0;
    while (index < pairs.length) {
        const [code, value] = pairs[index]!;
        if (code === 0 && value === "EOF") {
            break;
        }
        if (code === 0 && value === "SECTION") {
            const next = pairs[index + 1];
            const name = next && next[0] === 2 ? next[1] : "";
            let end = index + 2;
            while (end < pairs.length && !(pairs[end]![0] === 0 && pairs[end]![1] === "ENDSEC")) {
                end += 1;
            }
            sections.set(name, pairs.slice(index + 2, end));
            index = end + 1;
        } else {
            index += 1;
        }
    }
    return sections;
}

function unitMm(header: Pair[]): number {
    for (let index = 0; index < header.length; index++) {
        const [code, value] = header[index]!;
        if (code === 9 && value === "$INSUNITS") {
            for (const [c, v] of header.slice(index + 1)) {
                if (c === 9) {
                    break;
                }
                if (c === 70) {
                    const unit = Math.trunc(real("$INSUNITS", c, v));
                    const mm = UNITS_MM[unit];
                    if (mm === undefined) {
                        throw new Error(`$INSUNITS ${unit} is no unit this reader knows`);
                    }
                    return mm;
                }
            }
        }
    }
    return 1;
}

/** The layers switched off (a negative color) or frozen. */
function hiddenLayers(tables: Pair[]): Set<string> {
    const hidden = new Set<string>();
    for (const entity of entitiesOf(tables)) {
        if (entity.kind !== "LAYER") {
            continue;
        }
        const name = entity.text(2);
        if (name && (entity.whole(70) & 1 || entity.number(62, 7) < 0)) {
            hidden.add(name);
        }
    }
    return hidden;
}

interface Block {
    base: Point;
    entities: Entity[];
}

function blocksOf(section: Pair[]): Map<string, Block> {
    const blocks = new Map<string, Block>();
    let current: Block | null = null;
    for (const entity of entitiesOf(section)) {
        if (entity.kind === "BLOCK") {
            current = { base: [entity.number(10), entity.number(20)], entities: [] };
            // An external reference's entities are in another file.
            if (!(entity.whole(70) & 4)) {
                blocks.set(entity.text(2).toUpperCase(), current);
            }
        } else if (entity.kind === "ENDBLK") {
            current = null;
        } else if (current !== null) {
            current.entities.push(entity);
        }
    }
    return blocks;
}

// --- geometry ------------------------------------------------------------------------

/** m after n. */
function multiply(m: Matrix, n: Matrix): Matrix {
    const [a, b, c, d, e, f] = m;
    const [p, q, r, s, t, u] = n;
    return [a * p + c * q, b * p + d * q, a * r + c * s, b * r + d * s, a * t + c * u + e, b * t + d * u + f];
}

function apply(m: Matrix, x: number, y: number): Point {
    const [a, b, c, d, e, f] = m;
    return [a * x + c * y + e, b * x + d * y + f];
}

/** The most the map stretches a length: its larger singular value. */
function norm(m: Matrix): number {
    const [a, b, c, d] = m;
    const t = a * a + b * b + c * c + d * d;
    const det = a * d - b * c;
    return Math.sqrt((t + Math.sqrt(Math.max(0, t * t - 4 * det * det))) / 2);
}

/** An entity's own coordinate system to the drawing's, seen from above: the arbitrary axis algorithm, heights dropped. */
function ocs(normal: [number, number, number]): Matrix {
    let [nx, ny, nz] = normal;
    const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (length === 0 || (nx === 0 && ny === 0 && nz > 0)) {
        return IDENTITY;
    }
    nx /= length;
    ny /= length;
    nz /= length;
    let ax: [number, number, number] = Math.abs(nx) < 1 / 64 && Math.abs(ny) < 1 / 64 ? [nz, 0, -nx] : [-ny, nx, 0];
    let aLength = Math.sqrt(ax[0] * ax[0] + ax[1] * ax[1] + ax[2] * ax[2]);
    ax = [ax[0] / aLength, ax[1] / aLength, ax[2] / aLength];
    let ay: [number, number, number] = [ny * ax[2] - nz * ax[1], nz * ax[0] - nx * ax[2], nx * ax[1] - ny * ax[0]];
    aLength = Math.sqrt(ay[0] * ay[0] + ay[1] * ay[1] + ay[2] * ay[2]);
    ay = [ay[0] / aLength, ay[1] / aLength, ay[2] / aLength];
    return [ax[0], ax[1], ay[0], ay[1], 0, 0];
}

/** Chords an arc of `radius` through `sweep` radians is cut into: each sagging at most `tolerance`, one at least every eighth of a turn. */
function steps(radius: number, sweep: number, tolerance: number): number {
    sweep = Math.abs(sweep);
    const least = Math.ceil(sweep / MIN_STEP - 1e-9);
    const wanted = radius > tolerance ? Math.ceil(sweep / (2 * Math.acos(1 - tolerance / radius)) - 1e-9) : least;
    return Math.max(1, least, Math.min(MAX_STEPS, wanted));
}

/** Points along an arc from `start` through `sweep` radians, counterclockwise for a positive sweep. */
function arc(cx: number, cy: number, radius: number, start: number, sweep: number, tolerance: number): Point[] {
    const n = steps(radius, sweep, tolerance);
    const out: Point[] = [];
    for (let k = 0; k <= n; k++) {
        out.push([cx + radius * Math.cos(start + sweep * k / n), cy + radius * Math.sin(start + sweep * k / n)]);
    }
    return out;
}

/** The points after `p0` up to `p1` along a polyline segment of `bulge` (the tangent of a quarter of its angle, positive counterclockwise). */
function bulged(p0: Point, p1: Point, bulge: number, tolerance: number): Point[] {
    const dx = p1[0] - p0[0];
    const dy = p1[1] - p0[1];
    const chord = Math.sqrt(dx * dx + dy * dy);
    if (bulge === 0 || chord === 0) {
        return [p1];
    }
    const sweep = 4 * Math.atan(bulge);
    const radius = chord * (1 + bulge * bulge) / (4 * Math.abs(bulge));
    const along = (1 - bulge * bulge) / (4 * bulge);
    const cx = (p0[0] + p1[0]) / 2 - dy * along;
    const cy = (p0[1] + p1[1]) / 2 + dx * along;
    const start = Math.atan2(p0[1] - cy, p0[0] - cx);
    const points = arc(cx, cy, radius, start, sweep, tolerance).slice(1);
    points[points.length - 1] = p1;
    return points;
}

/** A polyline's vertices, each with the bulge of the segment after it. */
function vertices(points: [number, number, number][], closed: boolean, tolerance: number): Point[] {
    const first = points[0];
    if (!first) {
        return [];
    }
    const out: Point[] = [[first[0], first[1]]];
    for (let index = 0; index + 1 < points.length; index++) {
        const [x0, y0, bulge] = points[index]!;
        const [x1, y1] = points[index + 1]!;
        out.push(...bulged([x0, y0], [x1, y1], bulge, tolerance));
    }
    if (closed && points.length > 1) {
        const [x0, y0, bulge] = points[points.length - 1]!;
        out.push(...bulged([x0, y0], [first[0], first[1]], bulge, tolerance));
    }
    return out;
}

/** The point of a NURBS curve at `u`, by de Boor's algorithm on its weighted control points. */
function nurbs(degree: number, knots: number[], control: [number, number, number][], u: number): Point {
    const n = control.length - 1;
    let span = degree;
    while (span < n && knots[span + 1]! <= u) {
        span += 1;
    }
    const d: [number, number, number][] = [];
    for (let j = 0; j <= degree; j++) {
        const [x, y, w] = control[j + span - degree]!;
        d.push([x * w, y * w, w]);
    }
    for (let r = 1; r <= degree; r++) {
        for (let j = degree; j > r - 1; j--) {
            const low = knots[j + span - degree]!;
            const denominator = knots[j + 1 + span - r]! - low;
            const alpha = denominator === 0 ? 0 : (u - low) / denominator;
            const [a0, a1, a2] = d[j - 1]!;
            const [b0, b1, b2] = d[j]!;
            d[j] = [(1 - alpha) * a0 + alpha * b0, (1 - alpha) * a1 + alpha * b1, (1 - alpha) * a2 + alpha * b2];
        }
    }
    const [x, y, w] = d[degree]!;
    return w !== 0 ? [x / w, y / w] : [x, y];
}

/** A spline's curve within the tolerance, or the line through its fit points when it gives no control points. */
function spline(entity: Entity, tolerance: number): Point[] {
    const flags = entity.whole(70);
    let degree = entity.whole(71, 3);
    const xs = entity.numbers(10);
    const ys = entity.numbers(20);
    const controlPoints: Point[] = xs.slice(0, Math.min(xs.length, ys.length)).map((x, i) => [x, ys[i]!]);
    if (controlPoints.length < 2) {
        const fx = entity.numbers(11);
        const fy = entity.numbers(21);
        const fit: Point[] = fx.slice(0, Math.min(fx.length, fy.length)).map((x, i) => [x, fy[i]!]);
        if (fit.length < 2) {
            return [];
        }
        if (flags & 1 && (fit[0]![0] !== fit[fit.length - 1]![0] || fit[0]![1] !== fit[fit.length - 1]![1])) {
            fit.push(fit[0]!);
        }
        return fit;
    }
    let weights = entity.numbers(41);
    if (weights.length !== controlPoints.length || weights.some((w) => w <= 0)) {
        weights = controlPoints.map(() => 1);
    }
    const control: [number, number, number][] = controlPoints.map(([x, y], i) => [x, y, weights[i]!]);
    const n = control.length - 1;
    degree = Math.max(1, Math.min(degree, n));
    let knots = entity.numbers(40);
    if (knots.length !== n + degree + 2 || knots.some((k, i) => i > 0 && k < knots[i - 1]!)) {
        // A knot vector that does not fit the points: the clamped uniform one.
        const inner = n - degree;
        knots = [...Array(degree + 1).fill(0), ...Array.from({ length: inner }, (_, k) => k + 1), ...Array(degree + 1).fill(inner + 1)];
    }
    const low = knots[degree]!;
    const high = knots[n + 1]!;
    const all = [low, ...knots.slice(degree + 1, n + 1).filter((k) => low < k && k < high), high];
    const breaks = all.filter((b, index) => index === 0 || b > all[index - 1]!);

    const flatten = (u0: number, p0: Point, u1: number, p1: Point, depth: number): Point[] => {
        let worst = 0;
        for (const fraction of [0.25, 0.5, 0.75]) {
            const q = nurbs(degree, knots, control, u0 + (u1 - u0) * fraction);
            const ex = q[0] - (p0[0] + (p1[0] - p0[0]) * fraction);
            const ey = q[1] - (p0[1] + (p1[1] - p0[1]) * fraction);
            worst = Math.max(worst, Math.sqrt(ex * ex + ey * ey));
        }
        if (worst <= tolerance || depth >= SPLINE_DEPTH) {
            return [p1];
        }
        const um = (u0 + u1) / 2;
        const pm = nurbs(degree, knots, control, um);
        return [...flatten(u0, p0, um, pm, depth + 1), ...flatten(um, pm, u1, p1, depth + 1)];
    };

    const points: Point[] = [nurbs(degree, knots, control, breaks[0]!)];
    for (let index = 0; index + 1 < breaks.length; index++) {
        const u1 = breaks[index + 1]!;
        points.push(...flatten(breaks[index]!, points[points.length - 1]!, u1, nurbs(degree, knots, control, u1), 0));
    }
    const head = points[0]!;
    const tail = points[points.length - 1]!;
    if (flags & 1 && (head[0] !== tail[0] || head[1] !== tail[1])) {
        points.push(head);
    }
    return points;
}

// --- joining ------------------------------------------------------------------------

function dist(a: Point, b: Point): number {
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function closedChain(path: Point[]): boolean {
    return path.length > 3 && dist(path[0]!, path[path.length - 1]!) <= JOIN_EPSILON;
}

/** A closed path ending on its first point exactly. */
function shut(path: Point[]): Point[] {
    return [...path.slice(0, -1), path[0]!];
}

/**
 * The paths joined end to end where their ends meet, reversed as needed,
 * as the backend's clear.chains joins them: closed paths first as they
 * came, then each chain from the first unused piece, forward from its end
 * and then back from its start; where more than two ends meet, the first
 * unused piece found there.
 */
export function chains(paths: Point[][]): Point[][] {
    const out: Point[][] = [];
    const pieces: Point[][] = [];
    for (const path of paths) {
        if (path.length < 2) {
            continue;
        }
        if (closedChain(path)) {
            out.push(shut(path));
        } else {
            pieces.push([...path]);
        }
    }
    const cell = (point: Point): [number, number] => [Math.floor(point[0] / JOIN_EPSILON), Math.floor(point[1] / JOIN_EPSILON)];
    const ends = new Map<string, [number, boolean][]>();
    const note = (point: Point, index: number, atEnd: boolean): void => {
        const key = cell(point).join(",");
        let list = ends.get(key);
        if (!list) {
            list = [];
            ends.set(key, list);
        }
        list.push([index, atEnd]);
    };
    pieces.forEach((piece, index) => {
        note(piece[0]!, index, false);
        note(piece[piece.length - 1]!, index, true);
    });
    const used = pieces.map(() => false);
    const take = (point: Point): Point[] | null => {
        const [cx, cy] = cell(point);
        for (const dx of [-1, 0, 1]) {
            for (const dy of [-1, 0, 1]) {
                for (const [index, atEnd] of ends.get(`${cx + dx},${cy + dy}`) ?? []) {
                    const piece = pieces[index]!;
                    if (used[index] || dist(point, atEnd ? piece[piece.length - 1]! : piece[0]!) > JOIN_EPSILON) {
                        continue;
                    }
                    used[index] = true;
                    return atEnd ? [...piece].reverse() : piece;
                }
            }
        }
        return null;
    };
    pieces.forEach((piece, index) => {
        if (used[index]) {
            return;
        }
        used[index] = true;
        let chain = [...piece];
        while (!closedChain(chain)) {
            const after = take(chain[chain.length - 1]!);
            if (after === null) {
                break;
            }
            chain.push(...after.slice(1));
        }
        while (!closedChain(chain)) {
            const before = take(chain[0]!);
            if (before === null) {
                break;
            }
            chain = [...[...before].reverse().slice(0, -1), ...chain];
        }
        out.push(closedChain(chain) ? shut(chain) : chain);
    });
    return out;
}

// --- reading -------------------------------------------------------------------------

class Reader {
    readonly drawn: [string, Point[]][] = [];

    constructor(private readonly blocks: Map<string, Block>, private readonly hidden: Set<string>, private readonly tolerance: number) {}

    walk(entities: Entity[], matrix: Matrix, inherited: string | null, inserting: string[]): void {
        let index = 0;
        while (index < entities.length) {
            const entity = entities[index]!;
            index += 1;
            if (entity.kind === "POLYLINE") {
                // Its vertices follow it as entities of their own, to SEQEND.
                const list: Entity[] = [];
                while (index < entities.length && entities[index]!.kind === "VERTEX") {
                    list.push(entities[index]!);
                    index += 1;
                }
                this.polyline(entity, list, matrix, inherited);
                continue;
            }
            if (entity.kind === "VERTEX" || entity.kind === "SEQEND" || entity.kind === "ATTRIB") {
                continue;
            }
            const layer = this.layer(entity, inherited);
            if (layer === null) {
                continue;
            }
            if (entity.kind === "INSERT") {
                this.insert(entity, matrix, layer, inserting);
            } else {
                this.shape(entity, matrix, layer);
            }
        }
    }

    /** The layer the entity draws on, or null for one not drawn. */
    layer(entity: Entity, inherited: string | null): string | null {
        if (entity.text(67) === "1" || entity.text(60) === "1") {
            return null;
        }
        let layer = entity.text(8, DEFAULT_LAYER) || DEFAULT_LAYER;
        if (layer === DEFAULT_LAYER && inherited !== null) {
            layer = inherited;
        }
        return this.hidden.has(layer) ? null : layer;
    }

    add(layer: string, points: Point[], matrix: Matrix): void {
        if (points.length > 1) {
            this.drawn.push([layer, points.map(([x, y]) => apply(matrix, x, y))]);
        }
    }

    /** The tolerance in the units of a map's source. */
    local(matrix: Matrix): number {
        const stretch = norm(matrix);
        return stretch > 0 ? this.tolerance / stretch : this.tolerance;
    }

    shape(entity: Entity, matrix: Matrix, layer: string): void {
        const kind = entity.kind;
        if (kind === "LINE") {
            this.add(layer, [[entity.number(10), entity.number(20)], [entity.number(11), entity.number(21)]], matrix);
        } else if (kind === "ARC" || kind === "CIRCLE") {
            const m = multiply(matrix, ocs(entity.normal()));
            const radius = entity.number(40);
            if (radius <= 0) {
                return;
            }
            const cx = entity.number(10);
            const cy = entity.number(20);
            let points: Point[];
            if (kind === "CIRCLE") {
                points = arc(cx, cy, radius, 0, 2 * Math.PI, this.local(m));
                points[points.length - 1] = points[0]!;
            } else {
                const start = entity.number(50) * DEG;
                const sweep = pyMod(entity.number(51) - entity.number(50), 360) * DEG || 2 * Math.PI;
                points = arc(cx, cy, radius, start, sweep, this.local(m));
            }
            this.add(layer, points, m);
        } else if (kind === "ELLIPSE") {
            this.add(layer, this.ellipse(entity, matrix), matrix);
        } else if (kind === "LWPOLYLINE") {
            const m = multiply(matrix, ocs(entity.normal()));
            const list: [number, number, number][] = [];
            for (const [code, value] of entity.pairs) {
                if (code === 10) {
                    list.push([real(kind, code, value), 0, 0]);
                } else if (code === 20 && list.length > 0) {
                    list[list.length - 1]![1] = real(kind, code, value);
                } else if (code === 42 && list.length > 0) {
                    list[list.length - 1]![2] = real(kind, code, value);
                }
            }
            this.add(layer, vertices(list, (entity.whole(70) & 1) !== 0, this.local(m)), m);
        } else if (kind === "SPLINE") {
            this.add(layer, spline(entity, this.local(matrix)), matrix);
        }
    }

    ellipse(entity: Entity, matrix: Matrix): Point[] {
        const cx = entity.number(10);
        const cy = entity.number(20);
        const mx = entity.number(11);
        const my = entity.number(21);
        const mz = entity.number(31);
        const ratio = entity.number(40, 1);
        let [nx, ny, nz] = entity.normal();
        const length = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        nx /= length;
        ny /= length;
        nz /= length;
        // The minor axis: the normal across the major one, the ratio long.
        const sx = ratio * (ny * mz - nz * my);
        const sy = ratio * (nz * mx - nx * mz);
        const major = Math.sqrt(mx * mx + my * my + mz * mz);
        if (major === 0) {
            return [];
        }
        const t0 = entity.number(41, 0);
        const t1 = entity.number(42, 2 * Math.PI);
        const sweep = pyMod(t1 - t0, 2 * Math.PI) || 2 * Math.PI;
        // Within the tolerance of the circle of the major radius, which
        // the ellipse is that circle squeezed: chords sag no more on it.
        const n = steps(major, sweep, this.local(matrix));
        const points: Point[] = [];
        for (let k = 0; k <= n; k++) {
            const t = t0 + sweep * k / n;
            points.push([cx + mx * Math.cos(t) + sx * Math.sin(t), cy + my * Math.cos(t) + sy * Math.sin(t)]);
        }
        if (sweep === 2 * Math.PI) {
            points[points.length - 1] = points[0]!;
        }
        return points;
    }

    polyline(entity: Entity, list: Entity[], matrix: Matrix, inherited: string | null): void {
        const layer = this.layer(entity, inherited);
        const flags = entity.whole(70);
        // A polygon mesh or a polyface mesh is a surface, not a line.
        if (layer === null || flags & (16 | 64)) {
            return;
        }
        const threeD = (flags & 8) !== 0;
        const m = threeD ? matrix : multiply(matrix, ocs(entity.normal()));
        const points: [number, number, number][] = list
            // A spline's frame of control points is not on the line.
            .filter((vertex) => !(vertex.whole(70) & 16))
            .map((vertex) => [vertex.number(10), vertex.number(20), threeD ? 0 : vertex.number(42)]);
        this.add(layer, vertices(points, (flags & 1) !== 0, this.local(m)), m);
    }

    insert(entity: Entity, matrix: Matrix, layer: string, inserting: string[]): void {
        const name = entity.text(2);
        const key = name.toUpperCase();
        const block = this.blocks.get(key);
        if (!block) {
            return;
        }
        if (inserting.includes(key)) {
            throw new Error(`block ${quoted(name)} inserts itself`);
        }
        if (inserting.length >= MAX_NESTING) {
            throw new Error(`blocks are nested more than ${MAX_NESTING} deep`);
        }
        const sx = entity.number(41, 1);
        const sy = entity.number(42, 1);
        const turn = entity.number(50, 0) * DEG;
        const cos = Math.cos(turn);
        const sin = Math.sin(turn);
        const columns = Math.max(1, entity.whole(70, 1));
        const rows = Math.max(1, entity.whole(71, 1));
        const columnStep = entity.number(44, 0);
        const rowStep = entity.number(45, 0);
        const [bx, by] = block.base;
        const placed = multiply(matrix, ocs(entity.normal()));
        for (let row = 0; row < rows; row++) {
            for (let column = 0; column < columns; column++) {
                // Rows and columns run along the turned block's axes, their steps not scaled.
                const dx = column * columnStep;
                const dy = row * rowStep;
                const ix = entity.number(10) + cos * dx - sin * dy;
                const iy = entity.number(20) + sin * dx + cos * dy;
                let local: Matrix = [cos * sx, sin * sx, -sin * sy, cos * sy, 0, 0];
                local = multiply(local, [1, 0, 0, 1, -bx, -by]);
                local = multiply([1, 0, 0, 1, ix, iy], local);
                this.walk(block.entities, multiply(placed, local), layer, [...inserting, key]);
            }
        }
    }
}

/** The drawing's paths in millimeters, its curves within `tolerance` mm, by layer; layers that draw nothing are left out. */
export function readDxf(text: string, tolerance = 0.005): DxfDrawing {
    if (!(tolerance > 0)) {
        throw new Error("tolerance must be > 0");
    }
    const sections = sectionsOf(pairsOf(text));
    const entities = sections.get("ENTITIES");
    if (!entities) {
        throw new Error("not a DXF drawing: it has no ENTITIES section");
    }
    const unit = unitMm(sections.get("HEADER") ?? []);
    const reader = new Reader(blocksOf(sections.get("BLOCKS") ?? []), hiddenLayers(sections.get("TABLES") ?? []), tolerance);
    reader.walk(entitiesOf(entities), [unit, 0, 0, unit, 0, 0], null, []);
    const byName = new Map<string, Point[][]>();
    for (const [name, points] of reader.drawn) {
        let paths = byName.get(name);
        if (!paths) {
            paths = [];
            byName.set(name, paths);
        }
        paths.push(points);
    }
    const layers: DxfLayer[] = [];
    for (const [name, drawn] of byName) {
        const paths = chains(drawn).filter((path) => path.some(([x, y]) => x !== path[0]![0] || y !== path[0]![1]));
        if (paths.length > 0) {
            layers.push({ name, paths });
        }
    }
    return { layers, unitMm: unit };
}
