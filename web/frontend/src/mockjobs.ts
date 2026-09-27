// Job geometry for the in-page mock backend: SVG and gcode readers, a demo
// coupon for the formats only the real backend can read, placement and stats.

import { axisSnap, boardOfJoint, jointOfBoard, jointPath, moveMinutes, surfaceLength } from "./kinematics.ts";
import type { Anchor, Board, CenterRequest, Group, Job, Joint, Path, Point, Stats, UploadOptions } from "./types.ts";

/** Row-major 2x3 affine matrix [a, b, c, d, e, f] as SVG writes it. */
type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const CURVE_STEPS = 12;
const CIRCLE_STEPS = 48;
/** Millimeters per CSS pixel: an SVG length without a unit is a pixel at 96 dpi. */
export const PX_MM = 25.4 / 96;

export const DEFAULT_POWER = 500;
export const DEFAULT_SPEED = 400;
export const DEFAULT_SPOT = 0.1;
/** Largest number a coordinate, power or speed may be, as the backend bounds them. */
export const MAX_VALUE = 1e6;
/** The bound as the backend writes it in its refusals. */
export const MAX_VALUE_TEXT = "1e+06";
/** Most times a group may run over its own paths. */
export const MAX_GROUP_PASSES = 100;

/**
 * A number as the backend's refusals write one (Python's `:g`): six
 * significant digits, trailing zeros dropped, and the exponent form below
 * 1e-4 and from 1e6 on.
 */
export function formatG(value: number): string {
    if (!Number.isFinite(value) || value === 0) {
        return String(value === 0 ? 0 : value);
    }
    const rounded = Number(value.toPrecision(6));
    const exponent = Math.floor(Math.log10(Math.abs(rounded)));
    if (exponent < -4 || exponent >= 6) {
        const [mantissa = "", power = "0"] = rounded.toExponential(5).split("e");
        const e = Number(power);
        return `${mantissa.replace(/\.?0+$/, "")}e${e < 0 ? "-" : "+"}${String(Math.abs(e)).padStart(2, "0")}`;
    }
    return String(rounded);
}

export function checkPower(power: number, what = "power"): void {
    if (!(power >= 0 && power <= MAX_VALUE)) {
        throw new Error(`${what} must be between 0 and ${MAX_VALUE_TEXT}`);
    }
}

/** Slowest speed or plunge a group may ask for, mm/min: written with three decimals, less would reach the firmware as F0. */
export const MIN_SPEED = 0.001;
/** Deepest a milled group may cut under the surface, mm. */
export const MAX_DEPTH = 50;
/** What a milled group cuts to and plunges at when it does not say. */
export const DEFAULT_DEPTH = 0.1;
export const DEFAULT_PLUNGE = 60;

export function checkSpeed(speed: number, what = "speed"): void {
    if (!(speed > 0 && speed <= MAX_VALUE)) {
        throw new Error(`${what} must be above 0 and at most ${MAX_VALUE_TEXT}`);
    }
    if (speed < MIN_SPEED) {
        throw new Error(`${what} must be at least ${formatG(MIN_SPEED)} mm/min`);
    }
}

export function checkDepth(depth: number, what = "depth"): void {
    if (!(depth > 0 && depth <= MAX_DEPTH)) {
        throw new Error(`${what} must be above 0 and at most ${formatG(MAX_DEPTH)} mm`);
    }
}

export function checkPasses(passes: number, what = "passes"): void {
    if (!(Number.isInteger(passes) && passes >= 1 && passes <= MAX_GROUP_PASSES)) {
        throw new Error(`${what} must be between 1 and ${MAX_GROUP_PASSES}`);
    }
}

/** A read drawing: groups of board paths, each with the power and speed the file gave them, if any. */
export interface ParsedGeometry {
    groups: { label: string; paths: Path[]; power?: number; speed?: number }[];
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

/** Presentation reaching a shape from itself or its ancestors: the stroke, and whether it is drawn. */
interface Paint {
    /** `#rrggbb`, or `none` when nothing is painted. */
    stroke: string;
    /** `visibility: hidden`; a child may turn itself visible again. */
    hidden: boolean;
    /** `display: none`: the whole subtree is left out. */
    gone: boolean;
}

interface Shape {
    stroke: string;
    path: Path;
}

const NAMED_COLORS: Record<string, string> = {
    black: "#000000",
    white: "#ffffff",
    red: "#ff0000",
    lime: "#00ff00",
    green: "#008000",
    blue: "#0000ff",
    yellow: "#ffff00",
    cyan: "#00ffff",
    aqua: "#00ffff",
    magenta: "#ff00ff",
    fuchsia: "#ff00ff",
    gray: "#808080",
    grey: "#808080",
    silver: "#c0c0c0",
    maroon: "#800000",
    olive: "#808000",
    navy: "#000080",
    purple: "#800080",
    teal: "#008080",
    orange: "#ffa500",
};

/**
 * A CSS color as `#rrggbb` (`#rrggbbaa` when not opaque), `none` when nothing
 * is painted, or null when unreadable.
 */
export function colorName(text: string): string | null {
    const value = text.trim().toLowerCase();
    if (value === "" || value === "none" || value === "transparent") {
        return "none";
    }
    const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(value);
    if (hex) {
        let digits = hex[1] ?? "";
        if (digits.length <= 4) {
            digits = digits.split("").map((d) => d + d).join("");
        }
        return digits.length === 8 && digits.endsWith("ff") ? `#${digits.slice(0, 6)}` : `#${digits}`;
    }
    const rgb = /^rgba?\(([^)]*)\)$/.exec(value);
    if (rgb) {
        const parts = (rgb[1] ?? "").split(/[\s,/]+/).filter((s) => s !== "");
        if (parts.length < 3) {
            return null;
        }
        const channel = (part: string): string => {
            const number = parseFloat(part);
            const scaled = part.endsWith("%") ? (number / 100) * 255 : number;
            return Math.max(0, Math.min(255, Math.round(scaled))).toString(16).padStart(2, "0");
        };
        return `#${parts.slice(0, 3).map(channel).join("")}`;
    }
    return NAMED_COLORS[value] ?? null;
}

/** A property from the style attribute, which wins, else the presentation attribute. */
function declared(node: Element, name: string): string | null {
    const style = node.getAttribute("style");
    if (style) {
        for (const rule of style.split(";")) {
            const colon = rule.indexOf(":");
            if (colon > 0 && rule.slice(0, colon).trim().toLowerCase() === name) {
                return rule.slice(colon + 1).trim();
            }
        }
    }
    return node.getAttribute(name);
}

function paintOf(node: Element, parent: Paint): Paint {
    const paint = { ...parent };
    const stroke = declared(node, "stroke");
    if (stroke !== null && stroke.trim().toLowerCase() !== "inherit") {
        paint.stroke = colorName(stroke) ?? "none";
    }
    const visibility = declared(node, "visibility");
    if (visibility !== null && visibility.trim().toLowerCase() !== "inherit") {
        paint.hidden = visibility.trim().toLowerCase() === "hidden";
    }
    const display = declared(node, "display");
    if (display !== null && display.trim().toLowerCase() === "none") {
        paint.gone = true;
    }
    return paint;
}

function collect(node: Element, matrix: Matrix, parent: Paint, out: Shape[]): void {
    const paint = paintOf(node, parent);
    if (paint.gone) {
        return;
    }
    const local = multiply(matrix, parseTransform(node.getAttribute("transform")));
    if (!paint.hidden) {
        for (const path of shapePaths(node)) {
            out.push({ stroke: paint.stroke, path: path.map(([x, y]) => apply(local, x, y)) });
        }
    }
    if (node.localName === "g" || node.localName === "svg" || node.localName === "a") {
        for (const child of Array.from(node.children)) {
            collect(child, local, paint, out);
        }
    }
}

/**
 * Reads an SVG into board paths in mm, y up: one job group per stroke color
 * in the order the colors first appear, hidden shapes left out. Needs a
 * DOMParser.
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

    const shapes: Shape[] = [];
    const rootPaint = paintOf(root, { stroke: "none", hidden: false, gone: false });
    if (!rootPaint.gone) {
        for (const child of Array.from(root.children)) {
            collect(child, IDENTITY, rootPaint, shapes);
        }
    }
    const groups: { label: string; paths: Path[] }[] = [];
    const byStroke = new Map<string, Path[]>();
    for (const shape of shapes) {
        let paths = byStroke.get(shape.stroke);
        if (!paths) {
            paths = [];
            byStroke.set(shape.stroke, paths);
            groups.push({ label: shape.stroke === "none" ? "no stroke" : `stroke ${shape.stroke}`, paths });
        }
        paths.push(toBoard(shape.path));
    }
    if (groups.length === 0) {
        throw new Error("the SVG has no shapes to cut");
    }
    return { groups };
}

/** G codes the importer refuses, with the reason it gives. */
const REFUSED_G: Record<number, string> = {
    2: "arcs, export them as line segments",
    3: "arcs, export them as line segments",
    10: "coordinate system changes",
    20: "inches",
    28: "moves to a predefined position",
    30: "moves to a predefined position",
    38: "probing",
    53: "machine coordinate moves",
    91: "relative moves",
    92: "coordinate offsets",
};

const GCODE_WORD = /\([^)]*\)|([A-Za-z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/g;

interface CutRun {
    points: Path;
    power: number;
    speed: number;
}

/**
 * Reads absolute X/Y gcode: runs of G1 moves with the spindle on at a power
 * above zero are cuts. A rapid, M5, S0 or a change of S or F ends a path,
 * and consecutive paths at one S and F share a group labeled with them.
 */
export function parseGcode(text: string): ParsedGeometry {
    const runs: CutRun[] = [];
    let position: Point | null = null;
    let modal: number | null = null;
    let power = 0;
    let speed: number | null = null;
    let spindleOn = false;
    let current: CutRun | null = null;
    const close = (): void => {
        if (current !== null && current.points.length > 1) {
            runs.push(current);
        }
        current = null;
    };
    text.split(/\r?\n/).forEach((raw, index) => {
        const where = `line ${index + 1}`;
        const code = raw.split(";")[0] ?? "";
        // The first word of a letter is the one that counts.
        const words = new Map<string, number>();
        const gCodes: number[] = [];
        for (const match of code.matchAll(GCODE_WORD)) {
            const letter = match[1];
            if (letter === undefined) {
                continue;
            }
            const value = Number(match[2]);
            if (letter.toUpperCase() === "G") {
                gCodes.push(value);
            }
            if (!words.has(letter.toUpperCase())) {
                words.set(letter.toUpperCase(), value);
            }
        }
        for (const g of gCodes) {
            const reason = REFUSED_G[Math.trunc(g)];
            if (reason !== undefined) {
                throw new Error(`${where}: G${Math.trunc(g)} is ${reason}`);
            }
        }
        const xy = words.has("X") || words.has("Y");
        const m = words.get("M");
        if (m !== undefined) {
            const mCode = Math.trunc(m);
            if (mCode === 3 || mCode === 4) {
                spindleOn = true;
                if (words.has("S")) {
                    power = words.get("S") ?? 0;
                }
            } else if (mCode === 5) {
                spindleOn = false;
            }
            if ((mCode === 3 || mCode === 4 || mCode === 5) && !xy) {
                if (power === 0 || !spindleOn) {
                    close();
                }
                return;
            }
        }
        if (words.has("S")) {
            power = words.get("S") ?? 0;
            if (power === 0) {
                close();
            }
        }
        if (words.has("F")) {
            speed = words.get("F") ?? null;
        }
        const motion = gCodes.find((g) => g === 0 || g === 1);
        if (motion !== undefined) {
            modal = motion;
        }
        if (!xy) {
            return;
        }
        if (modal === null) {
            throw new Error(`${where}: axis words before any G0 or G1`);
        }
        if (position === null && !(words.has("X") && words.has("Y"))) {
            throw new Error(`${where}: the first move must give both X and Y`);
        }
        const here: Point = position ?? [0, 0];
        const target: Point = [words.get("X") ?? here[0], words.get("Y") ?? here[1]];
        if (modal === 1 && spindleOn && power > 0) {
            if (position === null) {
                throw new Error(`${where}: a cut before any rapid`);
            }
            if (speed === null || speed <= 1) {
                throw new Error(`${where}: a cut with no usable feed rate`);
            }
            if (current === null || current.power !== power || current.speed !== speed) {
                close();
                current = { points: [position], power, speed };
            }
            current.points.push(target);
        } else {
            close();
        }
        position = target;
    });
    close();
    if (runs.length === 0) {
        throw new Error("the file has no cuts");
    }
    const groups: ParsedGeometry["groups"] = [];
    for (const run of runs) {
        const last = groups[groups.length - 1];
        if (last && last.power === run.power && last.speed === run.speed) {
            last.paths.push(run.points);
        } else {
            groups.push({ label: `S${run.power} F${run.speed}`, paths: [run.points], power: run.power, speed: run.speed });
        }
    }
    return { groups };
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

/** Nearest a board segment comes to the axis, mm. */
export function closestApproach(start: Point, end: Point): number {
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const length2 = dx * dx + dy * dy;
    if (length2 === 0) {
        return Math.hypot(start[0], start[1]);
    }
    const t = Math.min(1, Math.max(0, -(start[0] * dx + start[1] * dy) / length2));
    return Math.hypot(start[0] + dx * t, start[1] + dy * t);
}

/** Nearest a board path comes to the axis: a straight edge passes closer than its ends. */
export function pathMinRadius(path: Path): number {
    const only = path[0];
    if (path.length === 1 && only) {
        return Math.hypot(only[0], only[1]);
    }
    let low = Infinity;
    for (let i = 0; i + 1 < path.length; i++) {
        low = Math.min(low, closestApproach(path[i] as Point, path[i + 1] as Point));
    }
    return low;
}

/** Nearest a joint polyline comes to the axis; zero when a move crosses it. */
export function jointMinRadius(poly: [number, number][]): number {
    let low = Infinity;
    for (let i = 0; i < poly.length; i++) {
        const here = poly[i] as [number, number];
        const next = poly[i + 1];
        if (next && here[0] < 0 !== next[0] < 0) {
            return 0;
        }
        low = Math.min(low, Math.abs(here[0]));
    }
    return low;
}

/** Board points along a joint polyline, close enough to draw it; a negative radius lands on the far side. */
export function jointPreview(poly: [number, number][], stepMm = 0.1, stepDeg = 1): Path {
    const first = poly[0];
    if (!first) {
        return [];
    }
    const point = (r: number, a: number): Point => {
        const board = boardOfJoint({ r, a });
        return [board.x, board.y];
    };
    const out: Path = [point(first[0], first[1])];
    for (let i = 0; i + 1 < poly.length; i++) {
        const [r0, a0] = poly[i] as [number, number];
        const [r1, a1] = poly[i + 1] as [number, number];
        const steps = Math.max(1, Math.ceil(Math.max(Math.abs(r1 - r0) / stepMm, Math.abs(a1 - a0) / stepDeg)));
        for (let k = 1; k <= steps; k++) {
            const t = k / steps;
            out.push(point(r0 + (r1 - r0) * t, a0 + (a1 - a0) * t));
        }
    }
    return out;
}

/** Within the resolution of a protocol line: 3 decimals of mm, 4 of degrees. */
function sameJoint(a: Joint, b: Joint): boolean {
    return Math.abs(a.r - b.r) < 0.5e-3 && Math.abs(a.a - b.a) < 0.5e-4;
}

export interface PlannedMove {
    kind: "go" | "cut";
    target: Joint;
}

/** The paths once per pass, the whole group each time rather than each path over and over. */
function perPass<T>(paths: T[], passes: number): T[] {
    const out: T[] = [];
    for (let pass = 0; pass < Math.max(1, passes); pass++) {
        out.push(...paths);
    }
    return out;
}

/**
 * The joint moves of one group from `from`: a rapid to each path's start
 * and a cut per segment within the chord tolerance. A joint-space path goes
 * out as written, with whole turns added so its start is the nearest one.
 * The group runs once per pass, each pass from where the last one ended.
 */
export function groupMoves(group: Group, from: Joint, tolerance: number): PlannedMove[] {
    const out: PlannedMove[] = [];
    let joint = from;
    if (group.joints && group.joints.length > 0) {
        for (const poly of perPass(group.joints, group.passes)) {
            const head = poly[0];
            if (!head || poly.length < 2) {
                continue;
            }
            const turns = Math.round((joint.a - head[1]) / 360);
            const joints = poly.map(([r, a]) => ({ r, a: a + 360 * turns }));
            const first = joints[0] as Joint;
            if (!sameJoint(joint, first)) {
                out.push({ kind: "go", target: first });
                joint = first;
            }
            for (const target of joints.slice(1)) {
                if (sameJoint(joint, target)) {
                    continue;
                }
                out.push({ kind: "cut", target });
                joint = target;
            }
        }
        return out;
    }
    for (const path of perPass(group.paths, group.passes)) {
        for (const move of pathMoves(path, joint, tolerance)) {
            out.push(move);
            joint = move.target;
        }
    }
    return out;
}

/**
 * The joint moves along one board path from `from`: a rapid to its start
 * unless the head is there, then its cuts; nothing for a path of fewer
 * than two points. A start within the axis snap is on the axis, as its
 * radius word says, so the move away from it is a turn, not a spiral.
 */
export function pathMoves(path: Path, from: Joint, tolerance: number): PlannedMove[] {
    const first = path[0];
    if (!first || path.length < 2) {
        return [];
    }
    const out: PlannedMove[] = [];
    let joint = from;
    let start = jointOfBoard({ x: first[0], y: first[1] }, joint);
    if (start.r < axisSnap(tolerance)) {
        start = { r: 0, a: start.a };
    }
    if (!sameJoint(joint, start)) {
        out.push({ kind: "go", target: start });
        joint = start;
    }
    for (const target of jointPath(path.slice(1), joint, tolerance)) {
        out.push({ kind: "cut", target });
        joint = target;
    }
    return out;
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
        if (group.joints && group.joints.length > 0) {
            for (const poly of group.joints) {
                if (poly.length === 0) {
                    continue;
                }
                for (const [r] of poly) {
                    maxRadius = Math.max(maxRadius, Math.abs(r));
                }
                minRadius = Math.min(minRadius, jointMinRadius(poly));
            }
        } else {
            for (const path of group.paths) {
                if (path.length === 0) {
                    continue;
                }
                for (const [x, y] of path) {
                    maxRadius = Math.max(maxRadius, Math.hypot(x, y));
                }
                minRadius = Math.min(minRadius, pathMinRadius(path));
            }
        }
        for (const step of groupMoves(group, joint, limits.tolerance)) {
            if (step.kind === "go") {
                minutes += moveMinutes(joint, step.target, null, limits.rRate, limits.aRate);
            } else {
                const segment = surfaceLength(joint, step.target);
                const wanted = group.speed > 0 ? segment / group.speed : 0;
                const actual = moveMinutes(joint, step.target, group.speed, limits.rRate, limits.aRate);
                if (actual > wanted * (1 + 1e-6)) {
                    limited += segment;
                }
                length += segment;
                minutes += actual;
            }
            moves += 1;
            joint = step.target;
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown, what: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`not a job: ${what} must be a number`);
    }
    return value;
}

/** A list of polylines from JSON: every point two finite numbers within the bound. */
function pathsOf(value: unknown, what: string): Path[] {
    if (value === undefined || value === null) {
        return [];
    }
    if (!Array.isArray(value)) {
        throw new Error(`not a job: ${what} must be a list of paths`);
    }
    return value.map((path: unknown): Path => {
        if (!Array.isArray(path)) {
            throw new Error(`not a job: ${what} must be a list of paths`);
        }
        return path.map((point: unknown): Point => {
            if (!Array.isArray(point) || point.length !== 2) {
                throw new Error(`not a job: ${what} has a point that is not two numbers`);
            }
            const x = finiteNumber(point[0], what);
            const y = finiteNumber(point[1], what);
            if (Math.abs(x) > MAX_VALUE || Math.abs(y) > MAX_VALUE) {
                throw new Error(`${what}: a coordinate is past ${MAX_VALUE_TEXT}`);
            }
            return [x, y];
        });
    });
}

/** A saved job read back, checked the way the backend checks one. */
function jobFromJson(id: string, stem: string, data: unknown, limits: RateLimits): Job {
    if (!isRecord(data) || !Array.isArray(data["groups"])) {
        throw new Error("job JSON has no groups");
    }
    const groups: Group[] = data["groups"].map((raw: unknown, index: number): Group => {
        if (!isRecord(raw) || typeof raw["label"] !== "string") {
            throw new Error(`not a job: group ${index} has no label`);
        }
        const label = raw["label"];
        const what = `group '${label}'`;
        const power = raw["power"] === undefined ? DEFAULT_POWER : finiteNumber(raw["power"], `${what}: power`);
        const minPower = raw["min_power"] === undefined ? 0 : finiteNumber(raw["min_power"], `${what}: min power`);
        const speed = raw["speed"] === undefined ? DEFAULT_SPEED : finiteNumber(raw["speed"], `${what}: speed`);
        const passes = raw["passes"] === undefined ? 1 : finiteNumber(raw["passes"], `${what}: passes`);
        const depth = raw["depth"] === undefined ? DEFAULT_DEPTH : finiteNumber(raw["depth"], `${what}: depth`);
        const plunge = raw["plunge"] === undefined ? DEFAULT_PLUNGE : finiteNumber(raw["plunge"], `${what}: plunge`);
        checkSpeed(speed, `${what}: speed`);
        checkPower(power, `${what}: power`);
        checkPower(minPower, `${what}: min power`);
        checkPasses(passes, `${what}: passes`);
        checkDepth(depth, `${what}: depth`);
        checkSpeed(plunge, `${what}: plunge`);
        const paths = pathsOf(raw["paths"], what);
        const joints = pathsOf(raw["joints"], what);
        if (joints.some((poly) => poly.length < 2)) {
            throw new Error("a joint-space path needs at least two points");
        }
        const group: Group = {
            label,
            power,
            min_power: minPower,
            speed,
            passes,
            enabled: raw["enabled"] === undefined ? true : Boolean(raw["enabled"]),
            depth,
            plunge,
            paths: joints.length > 0 && paths.length === 0 ? joints.map((poly) => jointPreview(poly)) : paths,
        };
        if (joints.length > 0) {
            group.joints = joints;
        }
        return group;
    });
    const spot = data["spot"] === undefined ? DEFAULT_SPOT : finiteNumber(data["spot"], "spot");
    if (!(spot > 0 && spot <= 1000)) {
        throw new Error("spot must be above 0 and at most 1000");
    }
    const offset: Board = { x: 0, y: 0 };
    if (data["offset"] !== undefined) {
        if (!isRecord(data["offset"])) {
            throw new Error("not a job: offset must have x and y");
        }
        offset.x = finiteNumber(data["offset"]["x"], "offset x");
        offset.y = finiteNumber(data["offset"]["y"], "offset y");
    }
    const given = data["name"];
    const name = typeof given === "string" && given !== "" && given !== "job" ? given : stem;
    const job: Job = {
        id,
        name,
        source: "json",
        spot,
        offset,
        groups,
        outline: pathsOf(data["outline"], "outline"),
        copper: pathsOf(data["copper"], "copper"),
        stats: { length_mm: 0, seconds: 0, max_radius: 0, min_radius: 0, limited_fraction: 0, moves: 0 },
    };
    job.stats = computeStats(job.groups, limits);
    return job;
}

/** What a board import may clear with, as the backend names them. */
const CLEAR_CHOICES: string[] = ["off", "radial", "rings", "lines"];

/** Turns an uploaded file into a job the way the backend would, as far as the browser can. */
export function buildJob(id: string, name: string, text: string, options: UploadOptions, limits: RateLimits): BuiltJob {
    const lower = name.toLowerCase();
    const extension = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
    const power = options.power ?? DEFAULT_POWER;
    const speed = options.speed ?? DEFAULT_SPEED;
    const spot = options.spot ?? DEFAULT_SPOT;
    const anchor: Anchor = options.anchor ?? "center";
    const offset: Board = { x: options.offset_x ?? 0, y: options.offset_y ?? 0 };
    checkPower(power);
    checkSpeed(speed);
    if (!(spot > 0 && spot <= 1000)) {
        throw new Error("spot must be above 0 and at most 1000");
    }
    if (![offset.x, offset.y].every((v) => Number.isFinite(v) && Math.abs(v) <= MAX_VALUE)) {
        throw new Error(`offset must be within ${MAX_VALUE_TEXT} mm`);
    }
    const clear: string = options.clear ?? "off";
    if (!CLEAR_CHOICES.includes(clear)) {
        throw new Error(`clear must be one of ${CLEAR_CHOICES.join(", ")}`);
    }

    if (extension === "json") {
        let data: unknown;
        try {
            data = JSON.parse(text);
        } catch (error) {
            throw new Error(`not a job: ${error instanceof Error ? error.message : String(error)}`);
        }
        return { job: jobFromJson(id, name.replace(/\.json$/i, ""), data, limits), note: null };
    }

    let source: string;
    let note: string | null = null;
    let geometry: ParsedGeometry & { copper?: Path[]; outline?: Path[] };
    switch (extension) {
        case "svg":
            geometry = parseSvg(text);
            source = "svg";
            break;
        case "gcode":
        case "nc":
            geometry = parseGcode(text);
            source = "gcode";
            break;
        case "gbr":
        case "kicad_pcb":
            geometry = demoCoupon();
            source = extension === "gbr" ? "gerber" : "kicad";
            note = clear === "off"
                ? "mock backend: copper geometry needs the real backend, showing a demo coupon"
                : "mock backend: copper geometry and clearing need the real backend, showing a demo coupon";
            break;
        default:
            throw new Error(`unsupported file type: .${extension || "?"}`);
    }

    const placed = placeJob(geometry, anchor, offset);
    // A gcode group keeps the power and feed the file ran it at.
    const groups: Group[] = placed.groups.map((group, index) => ({
        label: group.label,
        power: geometry.groups[index]?.power ?? power,
        min_power: 0,
        speed: geometry.groups[index]?.speed ?? speed,
        passes: 1,
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

/** Share of the table's rate the centering ring is paced at, as the backend leaves headroom. */
const RING_HEADROOM = 0.95;

/**
 * The coarse centering pattern: radial lines from the axis and a reference
 * ring, as the backend builds them. The fine pattern needs the backend's
 * polar kinematics and is refused here. `sMax`, the machine's full power
 * when it is known, bounds the power.
 */
export function centerJob(
    id: string,
    request: CenterRequest,
    limits: RateLimits,
    sMax: number | null = null,
): { job: Job; summary: string[]; notes: string[] } {
    const power = request.power ?? 400;
    const speed = request.speed ?? 200;
    checkPower(power);
    checkSpeed(speed);
    if (sMax !== null && power > sMax) {
        throw new Error(`power ${formatG(power)} is over s_max ${formatG(sMax)}`);
    }
    if (request.fine) {
        throw new Error("the fine pattern is only built by the real backend");
    }
    if (request.show_error !== undefined) {
        throw new Error("show error only applies to the fine pattern");
    }
    const lines = request.lines ?? 4;
    const reach = request.reach ?? 6;
    const ring = request.ring ?? 8;
    const spot = request.spot ?? DEFAULT_SPOT;
    if (!Number.isInteger(lines) || lines < 0 || lines === 1) {
        throw new Error("a pattern needs at least two lines to bound anything");
    }
    if (lines === 0 && ring <= 0) {
        throw new Error("0 lines needs a ring to measure");
    }
    if (!(reach > 0) || !(ring >= 0) || !(spot > 0)) {
        throw new Error("reach and spot must be > 0 and ring cannot be negative");
    }
    const groups: Group[] = [];
    if (lines > 0) {
        const paths: Path[] = [];
        for (let i = 0; i < lines; i++) {
            const theta = (2 * Math.PI * i) / lines;
            paths.push([[0, 0], [reach * Math.cos(theta), reach * Math.sin(theta)]]);
        }
        groups.push({ label: `${lines} radial lines from the axis to ${reach} mm`, power, min_power: 0, speed, passes: 1, enabled: true, paths });
    }
    const notes: string[] = [];
    if (ring > 0) {
        const around = Math.min(speed, RING_HEADROOM * (limits.aRate * Math.PI / 180) * ring);
        groups.push({ label: `reference ring at ${ring} mm`, power, min_power: 0, speed: around, passes: 1, enabled: true, paths: [circlePath(0, 0, ring, 360)] });
        if (around < speed) {
            notes.push(`The ring runs at ${around.toFixed(0)} mm/min, not ${speed}: that is all the table can turn at ${ring} mm.`);
        }
    }
    const job: Job = {
        id,
        name: "center",
        source: "center",
        spot,
        offset: { x: 0, y: 0 },
        groups,
        outline: [],
        copper: [],
        stats: computeStats(groups, limits),
    };
    const summary = [`pattern    ${lines} lines to ${reach} mm${ring > 0 ? `, ring at ${ring} mm` : ""}`];
    return { job, summary, notes };
}
