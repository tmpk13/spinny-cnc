// Job geometry for the in-page mock backend: SVG and gcode readers, a demo
// coupon for the formats only the real backend can read, placement and stats.

import { errorText } from "../api.ts";
import { jointOfBoard, moveMinutes, surfaceLength } from "../kinematics.ts";
import { groupMoves, jointPreview } from "../moves.ts";
import { extent, innerFirst } from "./order.ts";
import type { Anchor, Board, CenterRequest, DesignMap, Group, HolePoint, Job, Joint, Mirror, Move, PadPoint, Path, Point, Stats, Tool, UploadOptions } from "../types.ts";

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

/** A number rounded to four decimals, as the mock answers points, offsets and angles. */
export function round4(value: number): number {
    return Math.round(value * 1e4) / 1e4;
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

/** How much paste a dispensed pad gets, mm, as the backend bounds it. */
export const MIN_THICKNESS = 0.01;
export const MAX_THICKNESS = 5;
export const DEFAULT_THICKNESS = 0.12;

/** Farthest a group may raise or lower the head from focus, mm, as the backend bounds it. */
export const MAX_FOCUS = 50;

/** Farthest a CAM laser group's height may be from the surface, mm, the bound a CAM profile holds it to. */
const MAX_HEIGHT = 1000;

/** A group's focus within bounds, as the backend checks it; none is no focus. */
export function checkFocus(focus: number | null | undefined, what = "focus"): void {
    if (focus !== null && focus !== undefined && !(Number.isFinite(focus) && Math.abs(focus) <= MAX_FOCUS)) {
        throw new Error(`${what} must be within ${MAX_FOCUS} mm of focus either way`);
    }
}

export function checkThickness(thickness: number, what = "thickness"): void {
    if (!(Number.isFinite(thickness) && thickness >= MIN_THICKNESS && thickness <= MAX_THICKNESS)) {
        throw new Error(`${what} must be ${MIN_THICKNESS} to ${MAX_THICKNESS} mm`);
    }
}

const TOOL_NAMES: readonly string[] = ["laser", "spindle", "dispenser"];

export function checkPasses(passes: number, what = "passes"): void {
    if (!(Number.isInteger(passes) && passes >= 1 && passes <= MAX_GROUP_PASSES)) {
        throw new Error(`${what} must be between 1 and ${MAX_GROUP_PASSES}`);
    }
}

/** A read drawing: groups of board paths, each with the power and speed the file gave them, if any, and whether it comes switched on. */
export interface ParsedGeometry {
    groups: { label: string; paths: Path[]; power?: number; speed?: number; enabled?: boolean }[];
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

/** What the demo coupon stands for besides its cuts: its pads with their areas and its holes with their diameters. */
export interface CouponGeometry {
    groups: { label: string; paths: Path[]; enabled?: boolean }[];
    copper: Path[];
    outline: Path[];
    pads: PadPoint[];
    holes: HolePoint[];
}

/** A small coupon: three 3 mm pads with a hole each, a track, isolation loops, drill marks and an outline. */
export function demoCoupon(): CouponGeometry {
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
    return {
        groups,
        copper,
        outline: [rectPath(-18, -12, 18, 12)],
        pads: pads.map(([x, y]) => [x, y, 9] as PadPoint),
        holes: pads.map(([x, y]) => [x, y, 0.8] as HolePoint),
    };
}

/** Chords in each rounded corner of a bit's cut round the outline. */
const CORNER_STEPS = 8;

/**
 * A board's outline as it is cut, the backend's way: a beam on the line
 * (`radius` 0), a bit's middle `radius` off the board, so the board comes
 * out the size it is drawn. The demo's outlines are rectangles along the
 * axes, so each grows to the same rectangle `radius` bigger on every side
 * with its corners rounded to `radius`, as the backend's round-joined
 * offset draws it, from its lowest left point counterclockwise.
 */
export function outlineCut(outline: Path[], radius: number): Path[] {
    if (!(radius > 0)) {
        return outline;
    }
    return outline.map((path) => {
        const [x0, y0, x1, y1] = extent(path);
        const start: Point = [x0, y0 - radius];
        const loop: Point[] = [start];
        const corners: [number, number, number][] = [[x1, y0, -90], [x1, y1, 0], [x0, y1, 90], [x0, y0, 180]];
        for (const [cx, cy, from] of corners) {
            for (let i = 0; i <= CORNER_STEPS; i += 1) {
                const angle = ((from + (90 * i) / CORNER_STEPS) * Math.PI) / 180;
                loop.push([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)]);
            }
        }
        // The last corner ends where the loop began.
        loop[loop.length - 1] = start;
        return loop;
    });
}

/** The groups that cut a board's outline: the demo coupon's, and the backend's name for it. */
const OUTLINE_GROUPS = ["outline", "board outline pass 1"];

/** A stencil's openings are shrunk by at most this much on every side, mm, as the backend bounds the margin. */
export const MAX_MARGIN = 10;
/** Room for the beam narrower than this is none, mm, as the backend leaves a hairline. */
const HAIRLINE = 0.006;
/** The shortest stroke along an opening's middle, as a share of the spot. */
const SHORTEST = 0.25;

type Rect = [number, number, number, number];

/** The demo stencil's paste: a pair of 1 x 1.3 mm pads and a row of four 0.25 x 1 mm on a 0.5 mm pitch, as x0, y0, x1, y1. */
const DEMO_PASTE: Rect[] = [
    [-2.4, -0.65, -1.4, 0.65],
    [-0.5, -0.65, 0.5, 0.65],
    ...[2, 2.5, 3, 3.5].map((x): Rect => [x - 0.125, -0.5, x + 0.125, 0.5]),
];

/**
 * A few paste pads cut as a stencil, the way the backend cuts a paste
 * layer: a loop half a spot inside every pad shrunk by the margin, a
 * stroke along the middle of one left too narrow for the beam, and,
 * switched off, one along each pad the margin closes. The pads are
 * rectangles along the axes, where the offsets are exact.
 */
export function demoStencil(spot: number, margin: number, word: string, name: string): CouponGeometry {
    const radius = spot / 2;
    // Along a rectangle's longer middle, half a spot short of each end but
    // no shorter than SHORTEST of the spot, and never past the rectangle.
    const middle = ([x0, y0, x1, y1]: Rect): Path => {
        const cx = (x0 + x1) / 2;
        const cy = (y0 + y1) / 2;
        const along = x1 - x0 >= y1 - y0;
        const half = (along ? x1 - x0 : y1 - y0) / 2;
        const reach = Math.min(half, Math.max(half - radius, SHORTEST * radius));
        return along ? [[cx - reach, cy], [cx + reach, cy]] : [[cx, cy - reach], [cx, cy + reach]];
    };
    const loops: Path[] = [];
    const narrow: Path[] = [];
    const closed: Path[] = [];
    for (const pad of DEMO_PASTE) {
        const shrunk: Rect = [pad[0] + margin, pad[1] + margin, pad[2] - margin, pad[3] - margin];
        if (!(shrunk[2] > shrunk[0] && shrunk[3] > shrunk[1])) {
            closed.push(middle(pad));
            continue;
        }
        const core: Rect = [shrunk[0] + radius, shrunk[1] + radius, shrunk[2] - radius, shrunk[3] - radius];
        if (core[2] - core[0] > HAIRLINE && core[3] - core[1] > HAIRLINE) {
            loops.push(rectPath(...core));
        } else {
            narrow.push(middle(shrunk));
        }
    }
    if (loops.length === 0 && narrow.length === 0) {
        throw new Error(`a margin of ${formatG(margin)} mm closes every opening of ${name}`);
    }
    const outline = [rectPath(-3.5, -2, 4.5, 2)];
    const groups: CouponGeometry["groups"] = [];
    if (loops.length > 0) {
        groups.push({ label: `${word} openings, ${margin.toFixed(3)} mm margin`, paths: loops });
    }
    if (narrow.length > 0) {
        groups.push({ label: `${word} openings narrower than the spot, along their middle`, paths: narrow });
    }
    if (closed.length > 0) {
        groups.push({ label: `${word} openings the margin closes, along their middle`, paths: closed, enabled: false });
    }
    groups.push({ label: "board outline pass 1", paths: outline, enabled: false });
    return {
        groups,
        copper: DEMO_PASTE.map((pad) => rectPath(...pad)),
        outline,
        pads: DEMO_PASTE.map(([x0, y0, x1, y1]) => [(x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) * (y1 - y0)] as PadPoint),
        holes: [],
    };
}

/**
 * A short tour over points: from the first, always on to the nearest one
 * not yet visited. The backend orders a board's pads the same way, so the
 * head does not cross the board for every dot.
 */
export function shortTour<T extends [number, number, ...number[]]>(points: T[]): T[] {
    const left = points.slice();
    const out: T[] = [];
    let here: [number, number] | null = null;
    while (left.length > 0) {
        let best = 0;
        if (here !== null) {
            let bestDistance = Infinity;
            left.forEach((point, index) => {
                const distance = Math.hypot(point[0] - here![0], point[1] - here![1]);
                if (distance < bestDistance) {
                    bestDistance = distance;
                    best = index;
                }
            });
        }
        const next = left.splice(best, 1)[0]!;
        out.push(next);
        here = [next[0], next[1]];
    }
    return out;
}

/** The paths moved by `dx`, `dy`. */
export function shiftPaths(paths: Path[], dx: number, dy: number): Path[] {
    return paths.map((path) => path.map(([x, y]) => [x + dx, y + dy]));
}

/** The paths with X scaled by `fx` and Y by `fy`: -1 mirrors that axis. */
export function flipPaths(paths: Path[], fx: number, fy: number): Path[] {
    return paths.map((path) => path.map(([x, y]) => [x * fx, y * fy]));
}

/** Places the geometry: `center` puts the middle of everything on the axis, then the offset applies; `shift` says how far it all moved. */
export function placeJob(
    geometry: { groups: { label: string; paths: Path[] }[]; copper?: Path[]; outline?: Path[]; pads?: PadPoint[]; holes?: HolePoint[] },
    anchor: Anchor,
    offset: Board,
): { groups: { label: string; paths: Path[] }[]; copper: Path[]; outline: Path[]; pads: PadPoint[]; holes: HolePoint[]; shift: [number, number] } {
    const all: Path[] = [...(geometry.copper ?? []), ...(geometry.outline ?? [])];
    for (const group of geometry.groups) {
        all.push(...group.paths);
    }
    let dx = offset.x;
    let dy = offset.y;
    if (anchor === "center") {
        const [minX, minY, maxX, maxY] = extent(all.flat());
        if (Number.isFinite(minX)) {
            dx -= (minX + maxX) / 2;
            dy -= (minY + maxY) / 2;
        }
    }
    return {
        groups: geometry.groups.map((group) => ({ label: group.label, paths: shiftPaths(group.paths, dx, dy) })),
        copper: shiftPaths(geometry.copper ?? [], dx, dy),
        outline: shiftPaths(geometry.outline ?? [], dx, dy),
        pads: (geometry.pads ?? []).map(([x, y, area]) => [x + dx, y + dy, area] as PadPoint),
        holes: (geometry.holes ?? []).map(([x, y, diameter]) => [x + dx, y + dy, diameter] as HolePoint),
        shift: [dx, dy],
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

/** What a model's job costs without a machine: every move at its feed, as the backend prices it. */
export function modelStats(groups: Group[]): Stats {
    let length = 0;
    let seconds = 0;
    let moves = 0;
    for (const group of groups) {
        if (!group.enabled) {
            continue;
        }
        for (const path of group.moves ?? []) {
            moves += path.length;
            for (let i = 1; i < path.length; i++) {
                const [x0, y0, z0] = path[i - 1]!;
                const [x1, y1, z1, kind] = path[i]!;
                if (kind === 0) {
                    continue;
                }
                length += Math.hypot(x1 - x0, y1 - y0);
                const rate = kind === 2 ? group.plunge ?? DEFAULT_PLUNGE : group.speed;
                seconds += rate > 0 ? (Math.hypot(x1 - x0, y1 - y0, z1 - z0) / rate) * 60 : 0;
            }
        }
    }
    return { length_mm: length, seconds, max_radius: 0, min_radius: 0, limited_fraction: 0, moves };
}

/**
 * Length, time, radii and the table-limited share over the enabled groups.
 * A model's moves are no polar machine's to cut: a job with a group of them
 * switched on is priced at their feeds, as the backend prices it when the
 * machine cannot run it.
 */
export function computeStats(groups: Group[], limits: RateLimits): Stats {
    if (groups.some((group) => group.enabled && (group.moves?.length ?? 0) > 0)) {
        return modelStats(groups);
    }
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
        // A group of dots (one point each, as a dispense import makes them)
        // is a tour of rapids: the time is the travel, there is no length.
        if (group.paths.length > 0 && group.paths.every((path) => path.length === 1)) {
            for (const path of group.paths) {
                const target = jointOfBoard({ x: path[0]![0], y: path[0]![1] }, joint);
                minutes += moveMinutes(joint, target, null, limits.rRate, limits.aRate);
                moves += 1;
                joint = target;
            }
            continue;
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

/** A list of polylines from JSON: every point two finite numbers within the bound; left out, none, but null is no list. */
function pathsOf(value: unknown, what: string): Path[] {
    if (value === undefined) {
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

/**
 * A model's moves from JSON, each x, y and z over the stock's top and how
 * the tool gets there, checked as the backend checks them: a kind of 0 (a
 * rapid), 1 (a feed) or 2 (a plunge), x and y within the bound and z within
 * twenty times the deepest cut.
 */
function movesOf(value: unknown, what: string): Move[][] {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value)) {
        throw new Error(`not a job: ${what}: moves must be a list of paths of [x, y, z, kind]`);
    }
    return value.map((path: unknown): Move[] => {
        if (!Array.isArray(path)) {
            throw new Error(`not a job: ${what}: moves must be a list of paths of [x, y, z, kind]`);
        }
        return path.map((move: unknown): Move => {
            if (!Array.isArray(move) || move.length !== 4) {
                throw new Error(`not a job: ${what}: a move is [x, y, z, kind]`);
            }
            const x = finiteNumber(move[0], `${what}: a move's x`);
            const y = finiteNumber(move[1], `${what}: a move's y`);
            const z = finiteNumber(move[2], `${what}: a move's z`);
            const kind = move[3];
            if (kind !== 0 && kind !== 1 && kind !== 2) {
                throw new Error(`${what}: a move's kind is 0 (rapid), 1 (feed) or 2 (plunge)`);
            }
            if (Math.abs(x) > MAX_VALUE || Math.abs(y) > MAX_VALUE || Math.abs(z) > MAX_DEPTH * 20) {
                throw new Error(`${what}: a move is out of reach`);
            }
            return [x, y, z, kind];
        });
    });
}

/** A saved job read back, checked the way the backend checks one. */
export function jobFromJson(id: string, stem: string, data: unknown, limits: RateLimits): Job {
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
        const thickness = raw["thickness"] === undefined ? DEFAULT_THICKNESS : finiteNumber(raw["thickness"], `${what}: thickness`);
        checkSpeed(speed, `${what}: speed`);
        checkPower(power, `${what}: power`);
        checkPower(minPower, `${what}: min power`);
        checkPasses(passes, `${what}: passes`);
        checkDepth(depth, `${what}: depth`);
        checkSpeed(plunge, `${what}: plunge`);
        checkThickness(thickness, `${what}: thickness`);
        const focus = raw["focus"] === undefined || raw["focus"] === null ? null : finiteNumber(raw["focus"], `${what}: focus`);
        checkFocus(focus, `${what}: focus`);
        const tool = raw["tool"] ?? null;
        if (tool !== null && (typeof tool !== "string" || !TOOL_NAMES.includes(tool))) {
            throw new Error(`${what}: tool must be one of ${TOOL_NAMES.join(", ")}`);
        }
        const textOf = (key: string): string | null => {
            const value = raw[key] ?? null;
            if (value !== null && typeof value !== "string") {
                throw new Error(`not a job: ${what}: ${key} must be a string`);
            }
            return value;
        };
        const toolId = textOf("tool_id");
        const toolName = textOf("tool_name");
        const height = raw["height"] === undefined || raw["height"] === null ? null : finiteNumber(raw["height"], `${what}: height`);
        if (height !== null && !(Math.abs(height) <= MAX_HEIGHT)) {
            throw new Error(`${what}: height must be within ${MAX_HEIGHT} mm of the surface`);
        }
        const areas = raw["areas"] === undefined ? [] : raw["areas"];
        if (!Array.isArray(areas) || !areas.every((area) => typeof area === "number" && Number.isFinite(area) && area >= 0)) {
            throw new Error(`${what}: areas must be a list of numbers`);
        }
        const paths = pathsOf(raw["paths"], what);
        if (areas.length > 0 && areas.length !== paths.length) {
            throw new Error(`${what}: areas must have one entry per path`);
        }
        const joints = pathsOf(raw["joints"], what);
        if (joints.some((poly) => poly.length < 2)) {
            throw new Error("a joint-space path needs at least two points");
        }
        const moves = movesOf(raw["moves"], what);
        if (moves.length > 0 && (paths.length > 0 || joints.length > 0)) {
            throw new Error(`${what}: a model's moves come alone, without paths or joints`);
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
            thickness,
            ...(focus !== null ? { focus } : {}),
            tool: tool as Tool | null,
            ...(toolId !== null ? { tool_id: toolId } : {}),
            ...(toolName !== null ? { tool_name: toolName } : {}),
            ...(height !== null ? { height } : {}),
            areas: areas as number[],
            paths: joints.length > 0 && paths.length === 0 ? joints.map((poly) => jointPreview(poly)) : paths,
        };
        if (joints.length > 0) {
            group.joints = joints;
        }
        if (moves.length > 0) {
            group.moves = moves;
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
    const rotation = data["rotation"] === undefined ? 0 : finiteNumber(data["rotation"], "rotation");
    const triples = (value: unknown, what: string): [number, number, number][] => {
        if (value === undefined || value === null) {
            return [];
        }
        if (!Array.isArray(value) || !value.every((item) => Array.isArray(item) && item.length === 3 && item.every((v) => typeof v === "number" && Number.isFinite(v)))) {
            throw new Error(`not a job: ${what} must be a list of [x, y, value] triples`);
        }
        return value as [number, number, number][];
    };
    let design: DesignMap | null = null;
    const rawDesign = data["design"];
    if (rawDesign !== undefined && rawDesign !== null) {
        if (!isRecord(rawDesign) || !Array.isArray(rawDesign["shift"]) || rawDesign["shift"].length !== 2) {
            throw new Error("not a job: design must have a shift of two numbers, a rotation and board");
        }
        design = {
            shift: [finiteNumber(rawDesign["shift"][0], "design shift x"), finiteNumber(rawDesign["shift"][1], "design shift y")],
            rotation: rawDesign["rotation"] === undefined ? 0 : finiteNumber(rawDesign["rotation"], "design rotation"),
            // A job file carries no board file: the camera cannot look for it.
            board: false,
            mirror: rawDesign["mirror"] === "x" || rawDesign["mirror"] === "y" ? rawDesign["mirror"] : "none",
        };
    }
    const job: Job = {
        id,
        name,
        source: "json",
        spot,
        offset,
        rotation,
        pads: triples(data["pads"], "pads"),
        holes: triples(data["holes"], "holes"),
        design,
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
/** A KiCad layer name, as the backend checks it: F.Cu, In2.Cu, B.Paste, Margin. */
const LAYER_NAME = /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)?$/;
const MAX_LAYER_LENGTH = 32;
/** The layer a gerber's name ends with, the way kicad-cli names them: board-F_Paste.gtp. */
const NAMED_LAYER = /(?:^|-)((?:F|B|In[0-9]+)_(?:Cu|Paste|Mask|SilkS|Adhes|Fab|CrtYd)|(?:Dwgs|Cmts|Eco[12])_User|Edge_Cuts|User_[0-9]+|Margin)$/;
/** The gerber extensions the backend takes: KiCad's own and the Protel ones kicad-cli gives the layers. */
export const GERBER_EXTENSIONS = ["gbr", "gtl", "gbl", "gts", "gbs", "gtp", "gbp", "gto", "gbo", "gm1"];

/** A file name's extension, lower case and without its dot; empty for a name with none. */
export function extensionOf(name: string): string {
    const lower = name.toLowerCase();
    return lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
}

/** The layer a gerber's name says it is, or null when the name does not say. */
export function layerOf(name: string): string | null {
    const stem = name.replace(/\.[^.]+$/, "");
    const match = NAMED_LAYER.exec(stem);
    return match ? match[1]!.replace(/_/g, ".") : null;
}

/** What a layer draws, as the backend labels the groups cut from it. */
function layerWord(layer: string | null): string {
    const words: Record<string, string> = { Cu: "copper", Paste: "paste", Mask: "mask", SilkS: "silk" };
    if (layer === null) {
        return "copper";
    }
    const kind = layer.includes(".") ? layer.slice(layer.lastIndexOf(".") + 1) : layer;
    return words[kind] ?? layer;
}
/** What a board import makes, and what a deposit may fill with, as the backend names them. */
const MODES: string[] = ["isolate", "deposit", "stencil", "dispense", "lines"];
/** The layer whose lines are the board's outline, as the backend names it. */
const OUTLINE_LAYER = "Edge.Cuts";
/** How a board layer may be flipped, as the backend names them. */
const MIRRORS: string[] = ["none", "x", "y"];

/** Whether a layer is on the board's back, cut with the board turned over. */
export function isBottom(layer: string | null): boolean {
    return layer !== null && layer.startsWith("B.");
}

/** A board's geometry flipped as its layer is, before it is placed. */
function flipped<T extends { groups: { label: string; paths: Path[] }[]; copper?: Path[]; outline?: Path[]; pads?: PadPoint[]; holes?: HolePoint[] }>(geometry: T, mirror: Mirror): T {
    if (mirror === "none") {
        return geometry;
    }
    const fx = mirror === "x" ? -1 : 1;
    const fy = mirror === "y" ? -1 : 1;
    return {
        ...geometry,
        groups: geometry.groups.map((group) => ({ ...group, paths: flipPaths(group.paths, fx, fy) })),
        copper: geometry.copper && flipPaths(geometry.copper, fx, fy),
        outline: geometry.outline && flipPaths(geometry.outline, fx, fy),
        pads: geometry.pads?.map(([x, y, area]) => [x * fx, y * fy, area] as PadPoint),
        holes: geometry.holes?.map(([x, y, d]) => [x * fx, y * fy, d] as HolePoint),
    };
}
const FILL_CHOICES: string[] = ["contour", "radial", "rings", "lines"];

/**
 * Turns an uploaded file into a job the way the backend would, as far as
 * the browser can. `milling` says the machine cuts with a spindle, whose
 * bit, the spot wide, runs round a board's outline off the board.
 */
export function buildJob(id: string, name: string, text: string, options: UploadOptions, limits: RateLimits, milling = false): BuiltJob {
    const extension = extensionOf(name);
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
    const mode: string = options.mode ?? "isolate";
    if (!MODES.includes(mode)) {
        throw new Error(`mode must be one of ${MODES.join(", ")}`);
    }
    const thickness = options.thickness ?? DEFAULT_THICKNESS;
    if (mode === "dispense") {
        checkThickness(thickness);
    }
    // A dispense is solder paste on a board already made, and a stencil is
    // cut for the paste: their layer is the paste's unless said otherwise.
    const layer = options.layer ?? (mode === "dispense" || mode === "stencil" ? "F.Paste" : "F.Cu");
    if (layer.length > MAX_LAYER_LENGTH || !LAYER_NAME.test(layer)) {
        throw new Error(`layer must be a KiCad layer name such as F.Cu or F.Paste, not ${JSON.stringify(layer)}`);
    }
    const clear: string = options.clear ?? "off";
    if (!CLEAR_CHOICES.includes(clear)) {
        throw new Error(`clear must be one of ${CLEAR_CHOICES.join(", ")}`);
    }
    if (options.fill !== undefined && !FILL_CHOICES.includes(options.fill)) {
        throw new Error(`fill must be one of ${FILL_CHOICES.join(", ")}`);
    }
    if (mode === "stencil" && (clear !== "off" || options.fill !== undefined)) {
        throw new Error("a stencil cuts round every opening: it takes neither clear nor fill");
    }
    const margin = options.margin;
    if (margin !== undefined) {
        if (mode !== "stencil") {
            throw new Error("margin is how much a stencil shrinks its openings; this import is not a stencil");
        }
        if (!(Number.isFinite(margin) && margin >= 0 && margin <= MAX_MARGIN)) {
            throw new Error(`margin must be 0 to ${MAX_MARGIN} mm`);
        }
    }
    if (mode === "lines" && (clear !== "off" || options.fill !== undefined)) {
        throw new Error("lines cuts on the layer's lines: it takes neither clear nor fill");
    }
    if (mode === "deposit" && clear !== "off") {
        throw new Error("clear is for isolation; a deposit takes fill instead");
    }
    if (mode === "isolate" && options.fill !== undefined) {
        throw new Error("fill is for a deposit; isolation takes clear instead");
    }
    if (mode === "dispense" && (clear !== "off" || options.fill !== undefined)) {
        throw new Error("a dispense lays a dot on every pad: it takes neither clear nor fill");
    }
    if (options.mirror !== undefined && !MIRRORS.includes(options.mirror)) {
        throw new Error(`mirror must be one of ${MIRRORS.join(", ")}`);
    }

    if (extension === "json") {
        let data: unknown;
        try {
            data = JSON.parse(text);
        } catch (error) {
            throw new Error(`not a job: ${errorText(error)}`);
        }
        return { job: jobFromJson(id, name.replace(/\.json$/i, ""), data, limits), note: null };
    }

    let source: string;
    let note: string | null = null;
    let geometry: ParsedGeometry & { copper?: Path[]; outline?: Path[]; pads?: PadPoint[]; holes?: HolePoint[] };
    // A board job keeps the layer it was cut from: a KiCad board's chosen
    // one, a gerber's from its name when the name says.
    let jobLayer: string | null = null;
    const board = extension === "kicad_pcb" || GERBER_EXTENSIONS.includes(extension);
    if (mode === "dispense" && !board) {
        throw new Error("mode dispense is for a gerber or a KiCad board: a dot is laid on every pad of its layer");
    }
    if (board) {
        const coupon = demoCoupon();
        source = extension === "kicad_pcb" ? "kicad" : "gerber";
        jobLayer = extension === "kicad_pcb" ? layer : layerOf(name);
        const word = layerWord(jobLayer);
        if (mode === "dispense") {
            // One dot per pad, in a short tour over the board; the outline
            // and the copper stay for the preview, and nothing is cut.
            const tour = shortTour(coupon.pads);
            geometry = {
                groups: [{ label: "paste dots", paths: tour.map(([x, y]) => [[x, y]] as Path) }],
                copper: coupon.copper,
                outline: coupon.outline,
                pads: tour,
                holes: coupon.holes,
            };
            note = `mock backend: ${word} pads need the real backend, showing a demo coupon's`;
        } else if (mode === "stencil") {
            geometry = demoStencil(spot, margin ?? 0, word, name);
            note = `mock backend: ${word} geometry needs the real backend, showing a demo stencil`;
        } else if (mode === "lines") {
            // The lines as drawn: the coupon's outline for Edge.Cuts, which
            // is then the whole job, else the edges of its copper, with the
            // outline there to be switched on.
            const label = jobLayer ? `lines of ${jobLayer}` : "lines of the layer";
            geometry = {
                groups: jobLayer === OUTLINE_LAYER
                    ? [{ label, paths: coupon.outline }]
                    : [{ label, paths: coupon.copper }, { label: "board outline pass 1", paths: coupon.outline, enabled: false }],
                copper: coupon.copper,
                outline: coupon.outline,
                pads: coupon.pads,
                holes: coupon.holes,
            };
            note = `mock backend: the lines of a layer need the real backend, showing a demo coupon's`;
        } else {
            geometry = coupon;
            note = mode === "deposit"
                ? `mock backend: ${word} geometry and deposition need the real backend, showing a demo coupon`
                : clear === "off"
                    ? `mock backend: ${word} geometry needs the real backend, showing a demo coupon`
                    : `mock backend: ${word} geometry and clearing need the real backend, showing a demo coupon`;
        }
    } else {
        switch (extension) {
            case "svg":
                geometry = parseSvg(text);
                // A part's holes and marks before its outline, while the sheet holds it.
                geometry = { ...geometry, groups: geometry.groups.map((group) => ({ ...group, paths: innerFirst(group.paths) })) };
                source = "svg";
                break;
            case "gcode":
            case "nc":
            case "ngc":
                geometry = parseGcode(text);
                source = "gcode";
                break;
            default:
                throw new Error(`unsupported file type: .${extension || "?"}`);
        }
    }

    // A layer on the back is cut with the board turned over, flipped in X
    // unless the upload says otherwise.
    const mirror: Mirror = board ? options.mirror ?? (isBottom(jobLayer) ? "x" : "none") : "none";
    let turned = flipped(geometry, mirror);
    if (board && milling) {
        // The bit's middle runs its radius off the board round the outline.
        turned = { ...turned, groups: turned.groups.map((group) => OUTLINE_GROUPS.includes(group.label) ? { ...group, paths: outlineCut(group.paths, spot / 2) } : group) };
    }
    const placed = placeJob(turned, anchor, offset);
    // A gcode group keeps the power and feed the file ran it at.
    const groups: Group[] = placed.groups.map((group, index) => ({
        label: group.label,
        power: geometry.groups[index]?.power ?? power,
        min_power: 0,
        speed: geometry.groups[index]?.speed ?? speed,
        passes: 1,
        enabled: geometry.groups[index]?.enabled ?? true,
        paths: group.paths,
    }));
    if (mode === "dispense") {
        const dots = groups[0];
        if (dots) {
            dots.tool = "dispenser";
            dots.thickness = thickness;
            dots.areas = placed.pads.map((pad) => pad[2]);
        }
    }
    const job: Job = {
        id,
        name: name.replace(/\.[^.]+$/, ""),
        source,
        layer: jobLayer,
        spot,
        offset,
        rotation: 0,
        pads: board ? placed.pads : [],
        holes: board ? placed.holes : [],
        // The design's frame is the coupon's own here, so the map is the placement.
        design: board ? { shift: placed.shift, rotation: 0, board: extension === "kicad_pcb", mirror } : null,
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
