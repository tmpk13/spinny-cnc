// Job geometry for the in-page mock backend: SVG and gcode readers, a demo
// coupon for the formats only the real backend can read, placement and stats.

import { jointOfBoard, jointPath, moveMinutes, surfaceLength } from "./kinematics.ts";
import type { Anchor, Board, Group, Job, Joint, Path, Point, Stats, UploadOptions } from "./types.ts";

/** Row-major 2x3 affine matrix [a, b, c, d, e, f] as SVG writes it. */
type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const CURVE_STEPS = 12;
const CIRCLE_STEPS = 48;
/** Millimeters per CSS pixel: an SVG length without a unit is a pixel at 96 dpi. */
export const PX_MM = 25.4 / 96;

export interface ParsedGeometry {
    groups: { label: string; paths: Path[] }[];
}

function multiply(m: Matrix, n: Matrix): Matrix {
    return [
        m[0] * n[0] + m[2] * n[1],
        m[1] * n[0] + m[3] * n[1],
        m[0] * n[2] + m[2] * n[3],
        m[1] * n[2] + m[3] * n[3],
        m[0] * n[4] + m[2] * n[5] + m[4],
        m[1] * n[4] + m[3] * n[5] + m[5],
    ];
}

function apply(m: Matrix, x: number, y: number): Point {
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Parses an SVG transform attribute into a matrix. */
export function parseTransform(text: string | null): Matrix {
    let matrix: Matrix = IDENTITY;
    if (!text) {
        return matrix;
    }
    const pattern = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
        const name = match[1];
        const args = (match[2] ?? "").split(/[\s,]+/).filter((s) => s !== "").map(Number);
        const a = (index: number, fallback = 0): number => args[index] ?? fallback;
        let next: Matrix;
        switch (name) {
            case "matrix":
                next = [a(0, 1), a(1), a(2), a(3, 1), a(4), a(5)];
                break;
            case "translate":
                next = [1, 0, 0, 1, a(0), a(1)];
                break;
            case "scale":
                next = [a(0, 1), 0, 0, args.length > 1 ? a(1) : a(0, 1), 0, 0];
                break;
            case "rotate": {
                const angle = (a(0) * Math.PI) / 180;
                const cos = Math.cos(angle);
                const sin = Math.sin(angle);
                next = [cos, sin, -sin, cos, 0, 0];
                if (args.length > 2) {
                    const cx = a(1);
                    const cy = a(2);
                    next = multiply(multiply([1, 0, 0, 1, cx, cy], next), [1, 0, 0, 1, -cx, -cy]);
                }
                break;
            }
            case "skewX":
                next = [1, 0, Math.tan((a(0) * Math.PI) / 180), 1, 0, 0];
                break;
            case "skewY":
                next = [1, Math.tan((a(0) * Math.PI) / 180), 0, 1, 0, 0];
                break;
            default:
                next = IDENTITY;
        }
        matrix = multiply(matrix, next);
    }
    return matrix;
}

/** A CSS length to mm; a bare number is a pixel, as a browser reads it. Null when unreadable. */
export function lengthToMm(text: string | null): number | null {
    if (!text) {
        return null;
    }
    const match = /^\s*([-+]?[0-9]*\.?[0-9]+(?:e[-+]?[0-9]+)?)\s*([a-z%]*)\s*$/i.exec(text);
    if (!match) {
        return null;
    }
    const value = Number(match[1]);
    const unit = (match[2] ?? "").toLowerCase();
    const factors: Record<string, number> = {
        "": PX_MM,
        mm: 1,
        cm: 10,
        in: 25.4,
        pt: 25.4 / 72,
        pc: 25.4 / 6,
        px: PX_MM,
    };
    const factor = factors[unit];
    return factor === undefined ? null : value * factor;
}

function sampleCubic(p0: Point, p1: Point, p2: Point, p3: Point, out: Path): void {
    for (let i = 1; i <= CURVE_STEPS; i++) {
        const t = i / CURVE_STEPS;
        const u = 1 - t;
        out.push([
            u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
            u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
        ]);
    }
}

function sampleQuadratic(p0: Point, p1: Point, p2: Point, out: Path): void {
    for (let i = 1; i <= CURVE_STEPS; i++) {
        const t = i / CURVE_STEPS;
        const u = 1 - t;
        out.push([
            u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
            u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
        ]);
    }
}

/** SVG elliptical arc from endpoint parameters, sampled into the path. */
function sampleArc(p0: Point, rx: number, ry: number, rotation: number, large: boolean, sweep: boolean, p1: Point, out: Path): void {
    if (rx === 0 || ry === 0) {
        out.push(p1);
        return;
    }
    const phi = (rotation * Math.PI) / 180;
    const cos = Math.cos(phi);
    const sin = Math.sin(phi);
    const dx = (p0[0] - p1[0]) / 2;
    const dy = (p0[1] - p1[1]) / 2;
    const x1 = cos * dx + sin * dy;
    const y1 = -sin * dx + cos * dy;
    let arx = Math.abs(rx);
    let ary = Math.abs(ry);
    const lambda = (x1 * x1) / (arx * arx) + (y1 * y1) / (ary * ary);
    if (lambda > 1) {
        arx *= Math.sqrt(lambda);
        ary *= Math.sqrt(lambda);
    }
    const num = arx * arx * ary * ary - arx * arx * y1 * y1 - ary * ary * x1 * x1;
    const den = arx * arx * y1 * y1 + ary * ary * x1 * x1;
    let factor = den === 0 ? 0 : Math.sqrt(Math.max(0, num / den));
    if (large === sweep) {
        factor = -factor;
    }
    const cxp = (factor * arx * y1) / ary;
    const cyp = (-factor * ary * x1) / arx;
    const cx = cos * cxp - sin * cyp + (p0[0] + p1[0]) / 2;
    const cy = sin * cxp + cos * cyp + (p0[1] + p1[1]) / 2;
    const angle = (ux: number, uy: number, vx: number, vy: number): number => {
        const dot = ux * vx + uy * vy;
        const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
        let value = Math.acos(Math.max(-1, Math.min(1, dot / len)));
        if (ux * vy - uy * vx < 0) {
            value = -value;
        }
        return value;
    };
    const start = angle(1, 0, (x1 - cxp) / arx, (y1 - cyp) / ary);
    let delta = angle((x1 - cxp) / arx, (y1 - cyp) / ary, (-x1 - cxp) / arx, (-y1 - cyp) / ary);
    if (!sweep && delta > 0) {
        delta -= 2 * Math.PI;
    } else if (sweep && delta < 0) {
        delta += 2 * Math.PI;
    }
    const steps = Math.max(2, Math.ceil((Math.abs(delta) / (2 * Math.PI)) * CIRCLE_STEPS));
    for (let i = 1; i <= steps; i++) {
        const theta = start + (delta * i) / steps;
        const ex = arx * Math.cos(theta);
        const ey = ary * Math.sin(theta);
        out.push([cos * ex - sin * ey + cx, sin * ex + cos * ey + cy]);
    }
}

/** Reads an SVG path `d` attribute into polylines in user units. */
export function parsePathData(d: string): Path[] {
    const tokens = d.match(/[a-df-z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/gi) ?? [];
    const paths: Path[] = [];
    let current: Path = [];
    let command = "";
    let index = 0;
    let pos: Point = [0, 0];
    let start: Point = [0, 0];
    let lastControl: Point | null = null;
    let lastCommand = "";

    const number = (): number => {
        const token = tokens[index++];
        return token === undefined ? 0 : Number(token);
    };
    const hasNumber = (): boolean => index < tokens.length && !/^[a-z]$/i.test(tokens[index] ?? "");
    const flush = (): void => {
        if (current.length > 1) {
            paths.push(current);
        }
        current = [];
    };

    while (index < tokens.length) {
        const token = tokens[index] ?? "";
        if (/^[a-z]$/i.test(token)) {
            command = token;
            index++;
        } else if (command === "") {
            break;
        }
        const relative = command === command.toLowerCase();
        const upper = command.toUpperCase();
        if (upper === "Z") {
            if (current.length > 0) {
                current.push([start[0], start[1]]);
            }
            flush();
            pos = start;
            current = [pos];
            lastControl = null;
            lastCommand = "Z";
            continue;
        }
        if (!hasNumber()) {
            continue;
        }
        const rel = (x: number, y: number): Point => (relative ? [pos[0] + x, pos[1] + y] : [x, y]);
        switch (upper) {
            case "M": {
                const p = rel(number(), number());
                flush();
                current = [p];
                pos = p;
                start = p;
                command = relative ? "l" : "L";
                lastControl = null;
                break;
            }
            case "L": {
                const p = rel(number(), number());
                current.push(p);
                pos = p;
                lastControl = null;
                break;
            }
            case "H": {
                const x = number();
                const p: Point = [relative ? pos[0] + x : x, pos[1]];
                current.push(p);
                pos = p;
                lastControl = null;
                break;
            }
            case "V": {
                const y = number();
                const p: Point = [pos[0], relative ? pos[1] + y : y];
                current.push(p);
                pos = p;
                lastControl = null;
                break;
            }
            case "C": {
                const c1 = rel(number(), number());
                const c2 = rel(number(), number());
                const p = rel(number(), number());
                sampleCubic(pos, c1, c2, p, current);
                lastControl = c2;
                pos = p;
                break;
            }
            case "S": {
                const c1: Point = lastControl && (lastCommand === "C" || lastCommand === "S")
                    ? [2 * pos[0] - lastControl[0], 2 * pos[1] - lastControl[1]]
                    : pos;
                const c2 = rel(number(), number());
                const p = rel(number(), number());
                sampleCubic(pos, c1, c2, p, current);
                lastControl = c2;
                pos = p;
                break;
            }
            case "Q": {
                const c1 = rel(number(), number());
                const p = rel(number(), number());
                sampleQuadratic(pos, c1, p, current);
                lastControl = c1;
                pos = p;
                break;
            }
            case "T": {
                const c1: Point = lastControl && (lastCommand === "Q" || lastCommand === "T")
                    ? [2 * pos[0] - lastControl[0], 2 * pos[1] - lastControl[1]]
                    : pos;
                const p = rel(number(), number());
                sampleQuadratic(pos, c1, p, current);
                lastControl = c1;
                pos = p;
                break;
            }
            case "A": {
                const rx = number();
                const ry = number();
                const rotation = number();
                const large = number() !== 0;
                const sweep = number() !== 0;
                const p = rel(number(), number());
                sampleArc(pos, rx, ry, rotation, large, sweep, p, current);
                pos = p;
                lastControl = null;
                break;
            }
            default:
                index = tokens.length;
        }
        lastCommand = upper;
    }
    flush();
    return paths;
}

/** A shape attribute in user units; the root's scale turns those into mm later. */
function attr(node: Element, name: string, fallback = 0): number {
    const value = node.getAttribute(name);
    if (value === null) {
        return fallback;
    }
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function shapePaths(node: Element): Path[] {
    switch (node.localName) {
        case "path":
            return parsePathData(node.getAttribute("d") ?? "");
        case "line":
            return [[[attr(node, "x1"), attr(node, "y1")], [attr(node, "x2"), attr(node, "y2")]]];
        case "polyline":
        case "polygon": {
            const numbers = (node.getAttribute("points") ?? "").split(/[\s,]+/).filter((s) => s !== "").map(Number);
            const path: Path = [];
            for (let i = 0; i + 1 < numbers.length; i += 2) {
                path.push([numbers[i] ?? 0, numbers[i + 1] ?? 0]);
            }
            if (node.localName === "polygon" && path.length > 1) {
                const first = path[0];
                if (first) {
                    path.push([first[0], first[1]]);
                }
            }
            return path.length > 1 ? [path] : [];
        }
        case "rect": {
            const x = attr(node, "x");
            const y = attr(node, "y");
            const w = attr(node, "width");
            const h = attr(node, "height");
            return [[[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]];
        }
        case "circle":
        case "ellipse": {
            const cx = attr(node, "cx");
            const cy = attr(node, "cy");
            const rx = node.localName === "circle" ? attr(node, "r") : attr(node, "rx");
            const ry = node.localName === "circle" ? attr(node, "r") : attr(node, "ry");
            const path: Path = [];
            for (let i = 0; i <= CIRCLE_STEPS; i++) {
                const t = (i / CIRCLE_STEPS) * Math.PI * 2;
                path.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
            }
            return [path];
        }
        default:
            return [];
    }
}

function collect(node: Element, matrix: Matrix, out: Path[]): void {
    const local = multiply(matrix, parseTransform(node.getAttribute("transform")));
    const own = shapePaths(node);
    for (const path of own) {
        out.push(path.map(([x, y]) => apply(local, x, y)));
    }
    if (node.localName === "g" || node.localName === "svg" || node.localName === "a") {
        for (const child of Array.from(node.children)) {
            collect(child, local, out);
        }
    }
}

/**
 * Reads an SVG into board paths in mm, y up. Top level groups become job
 * groups; loose shapes go into one group. Needs a DOMParser.
 */
export function parseSvg(text: string): ParsedGeometry {
    if (typeof DOMParser !== "function") {
        throw new Error("no XML parser available");
    }
    const doc = new DOMParser().parseFromString(text, "image/svg+xml");
    const root = doc.documentElement;
    if (!root || root.localName !== "svg" || doc.getElementsByTagName("parsererror").length > 0) {
        throw new Error("not an SVG document");
    }
    // User units are pixels unless a width and a viewBox together say how
    // many of them make the drawing's width, the way a browser scales it.
    let scale = PX_MM;
    const viewBox = (root.getAttribute("viewBox") ?? "").split(/[\s,]+/).filter((s) => s !== "").map(Number);
    const widthMm = lengthToMm(root.getAttribute("width"));
    if (widthMm !== null && viewBox.length === 4 && (viewBox[2] ?? 0) > 0) {
        scale = widthMm / (viewBox[2] ?? 1);
    }
    const originX = viewBox.length === 4 ? viewBox[0] ?? 0 : 0;
    const originY = viewBox.length === 4 ? viewBox[1] ?? 0 : 0;
    const toBoard = (path: Path): Path => path.map(([x, y]) => [(x - originX) * scale, (originY - y) * scale]);

    const groups: { label: string; paths: Path[] }[] = [];
    const loose: Path[] = [];
    let count = 0;
    for (const child of Array.from(root.children)) {
        if (child.localName === "g") {
            const paths: Path[] = [];
            collect(child, IDENTITY, paths);
            if (paths.length > 0) {
                count += 1;
                const label = child.getAttribute("inkscape:label") ?? child.getAttribute("id") ?? `group ${count}`;
                groups.push({ label, paths: paths.map(toBoard) });
            }
        } else {
            collect(child, IDENTITY, loose);
        }
    }
    if (loose.length > 0) {
        groups.push({ label: "paths", paths: loose.map(toBoard) });
    }
    if (groups.length === 0) {
        throw new Error("no drawable shapes in the SVG");
    }
    return { groups };
}

/** Reads absolute X/Y G0/G1 gcode; G0 starts a new path. */
export function parseGcode(text: string): ParsedGeometry & { power: number | null; speed: number | null } {
    const paths: Path[] = [];
    let current: Path = [];
    let pos: Point = [0, 0];
    let motion = 0;
    let power: number | null = null;
    let speed: number | null = null;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/\(.*?\)/g, "").replace(/;.*$/, "").trim().toUpperCase();
        if (line === "") {
            continue;
        }
        const words = line.match(/[A-Z][-+]?\d*\.?\d+/g) ?? [];
        let x: number | null = null;
        let y: number | null = null;
        for (const word of words) {
            const value = Number(word.slice(1));
            switch (word[0]) {
                case "G":
                    if (value === 0 || value === 1) {
                        motion = value;
                    }
                    break;
                case "X":
                    x = value;
                    break;
                case "Y":
                    y = value;
                    break;
                case "S":
                    if (power === null && value > 0) {
                        power = value;
                    }
                    break;
                case "F":
                    if (speed === null && value > 0) {
                        speed = value;
                    }
                    break;
                default:
                    break;
            }
        }
        if (x === null && y === null) {
            continue;
        }
        const next: Point = [x ?? pos[0], y ?? pos[1]];
        if (motion === 0) {
            if (current.length > 1) {
                paths.push(current);
            }
            current = [next];
        } else {
            if (current.length === 0) {
                current.push(pos);
            }
            current.push(next);
        }
        pos = next;
    }
    if (current.length > 1) {
        paths.push(current);
    }
    if (paths.length === 0) {
        throw new Error("no G1 moves in the file");
    }
    return { groups: [{ label: "gcode", paths }], power, speed };
}

function rectPath(x0: number, y0: number, x1: number, y1: number): Path {
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
}

function circlePath(cx: number, cy: number, r: number, steps = 24): Path {
    const path: Path = [];
    for (let i = 0; i <= steps; i++) {
        const t = (i / steps) * Math.PI * 2;
        path.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
    }
    return path;
}

/** A small coupon: three pads, a track, isolation loops, drill marks and an outline. */
export function demoCoupon(): { groups: { label: string; paths: Path[] }[]; copper: Path[]; outline: Path[] } {
    const pads: Point[] = [[-12, 0], [0, 0], [12, 0]];
    const copper: Path[] = pads.map(([x, y]) => rectPath(x - 1.5, y - 1.5, x + 1.5, y + 1.5));
    copper.push(rectPath(-10.5, -0.3, -1.5, 0.3));
    const gap = 0.3;
    const loop1 = rectPath(-13.5 - gap, -1.5 - gap, 1.5 + gap, 1.5 + gap);
    const loop2 = rectPath(10.5 - gap, -1.5 - gap, 13.5 + gap, 1.5 + gap);
    const groups = [
        { label: "isolation loop 1", paths: [loop1] },
        { label: "isolation loop 2", paths: [loop2] },
        { label: "drill marks", paths: pads.map(([x, y]) => circlePath(x, y, 0.4, 16)) },
        { label: "outline", paths: [rectPath(-18, -12, 18, 12)] },
    ];
    return { groups, copper, outline: [rectPath(-18, -12, 18, 12)] };
}

function bounds(paths: Path[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const path of paths) {
        for (const [x, y] of path) {
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
        }
    }
    return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

function shift(paths: Path[], dx: number, dy: number): Path[] {
    return paths.map((path) => path.map(([x, y]) => [x + dx, y + dy]));
}

/** Places the geometry: `center` puts the middle of everything on the axis, then the offset applies. */
export function placeJob(
    geometry: { groups: { label: string; paths: Path[] }[]; copper?: Path[]; outline?: Path[] },
    anchor: Anchor,
    offset: Board,
): { groups: { label: string; paths: Path[] }[]; copper: Path[]; outline: Path[] } {
    const all: Path[] = [...(geometry.copper ?? []), ...(geometry.outline ?? [])];
    for (const group of geometry.groups) {
        all.push(...group.paths);
    }
    let dx = offset.x;
    let dy = offset.y;
    if (anchor === "center") {
        const box = bounds(all);
        if (box) {
            dx -= (box.minX + box.maxX) / 2;
            dy -= (box.minY + box.maxY) / 2;
        }
    }
    return {
        groups: geometry.groups.map((group) => ({ label: group.label, paths: shift(group.paths, dx, dy) })),
        copper: shift(geometry.copper ?? [], dx, dy),
        outline: shift(geometry.outline ?? [], dx, dy),
    };
}

export interface RateLimits {
    rRate: number;
    aRate: number;
    tolerance: number;
}

/** Length, time, radii and the table-limited share over the enabled groups. */
export function computeStats(groups: Group[], limits: RateLimits): Stats {
    let length = 0;
    let minutes = 0;
    let limited = 0;
    let moves = 0;
    let maxRadius = 0;
    let minRadius = Infinity;
    let joint: Joint = { r: 0, a: 0 };
    for (const group of groups) {
        if (!group.enabled) {
            continue;
        }
        for (const path of group.paths) {
            const first = path[0];
            if (!first) {
                continue;
            }
            for (const [x, y] of path) {
                const r = Math.hypot(x, y);
                maxRadius = Math.max(maxRadius, r);
                minRadius = Math.min(minRadius, r);
            }
            const start = jointOfBoard({ x: first[0], y: first[1] }, joint);
            minutes += moveMinutes(joint, start, null, limits.rRate, limits.aRate);
            moves += 1;
            joint = start;
            for (const target of jointPath(path.slice(1), start, limits.tolerance)) {
                const segment = surfaceLength(joint, target);
                const wanted = group.speed > 0 ? segment / group.speed : 0;
                const actual = moveMinutes(joint, target, group.speed, limits.rRate, limits.aRate);
                if (actual > wanted * (1 + 1e-6)) {
                    limited += segment;
                }
                length += segment;
                minutes += actual;
                moves += 1;
                joint = target;
            }
        }
    }
    return {
        length_mm: length,
        seconds: minutes * 60,
        max_radius: maxRadius,
        min_radius: Number.isFinite(minRadius) ? minRadius : 0,
        limited_fraction: length > 0 ? limited / length : 0,
        moves,
    };
}

export interface BuiltJob {
    job: Job;
    note: string | null;
}

/** Turns an uploaded file into a job the way the backend would, as far as the browser can. */
export function buildJob(id: string, name: string, text: string, options: UploadOptions, limits: RateLimits): BuiltJob {
    const lower = name.toLowerCase();
    const extension = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
    const power = options.power ?? 500;
    const speed = options.speed ?? 400;
    const spot = options.spot ?? 0.1;
    const anchor: Anchor = options.anchor ?? "center";
    const offset: Board = { x: options.offset_x ?? 0, y: options.offset_y ?? 0 };
    let source: string;
    let note: string | null = null;
    let geometry: { groups: { label: string; paths: Path[] }[]; copper?: Path[]; outline?: Path[] };
    let groupPower = power;
    let groupSpeed = speed;

    if (extension === "json") {
        const parsed = JSON.parse(text) as Partial<Job>;
        if (!Array.isArray(parsed.groups)) {
            throw new Error("job JSON has no groups");
        }
        const job: Job = {
            id,
            name: parsed.name ?? name.replace(/\.json$/i, ""),
            source: parsed.source ?? "json",
            spot: parsed.spot ?? spot,
            offset: parsed.offset ?? { x: 0, y: 0 },
            groups: parsed.groups.map((group) => ({
                label: group.label ?? "group",
                power: group.power ?? power,
                speed: group.speed ?? speed,
                enabled: group.enabled ?? true,
                paths: group.paths ?? [],
            })),
            outline: parsed.outline ?? [],
            copper: parsed.copper ?? [],
            stats: {
                length_mm: 0, seconds: 0, max_radius: 0, min_radius: 0, limited_fraction: 0, moves: 0,
            },
        };
        job.stats = computeStats(job.groups, limits);
        return { job, note: null };
    }

    switch (extension) {
        case "svg":
            geometry = parseSvg(text);
            source = "svg";
            break;
        case "gcode":
        case "nc": {
            const parsed = parseGcode(text);
            geometry = parsed;
            source = "gcode";
            if (options.power === undefined && parsed.power !== null) {
                groupPower = parsed.power;
            }
            if (options.speed === undefined && parsed.speed !== null) {
                groupSpeed = parsed.speed;
            }
            break;
        }
        case "gbr":
        case "kicad_pcb":
            geometry = demoCoupon();
            source = extension === "gbr" ? "gerber" : "kicad";
            note = "mock backend: copper geometry needs the real backend, showing a demo coupon";
            break;
        default:
            throw new Error(`unsupported file type: .${extension || "?"}`);
    }

    const placed = placeJob(geometry, anchor, offset);
    const groups: Group[] = placed.groups.map((group) => ({
        label: group.label,
        power: groupPower,
        speed: groupSpeed,
        enabled: true,
        paths: group.paths,
    }));
    const job: Job = {
        id,
        name: name.replace(/\.[^.]+$/, ""),
        source,
        spot,
        offset,
        groups,
        outline: placed.outline,
        copper: placed.copper,
        stats: computeStats(groups, limits),
    };
    return { job, note };
}
