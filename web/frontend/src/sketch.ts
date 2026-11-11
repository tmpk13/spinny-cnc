// The Plot page's operation as a sketch: the sizes the preview draws over
// it (a rectangle's width, height, corners or center and its corner
// radius, a circle's diameter and center, the points of a drill or a line
// and the lengths between them), a line naming it in the job's list,
// whether two operations cut the same, an operation with every field at
// the backend's default, and the operations a job was made from.

import { turnPoint } from "./align.ts";
import { countText } from "./format.ts";
import type { MillOperation, Point, Recipe } from "./types.ts";
import type { Dimension } from "./preview.ts";

/** An operation the page would send: every field there, with the backend's defaults. */
export function defaultOperation(kind: MillOperation["kind"] = "drill"): MillOperation {
    return {
        kind,
        cutter: "spindle",
        name: null,
        tool: 1,
        depth: 0.5,
        step_down: 0.5,
        stepover: 0.4,
        speed: 300,
        plunge: 60,
        spindle: 10000,
        power: 500,
        passes: 1,
        climb: true,
        points: [],
        closed: false,
        shape: "rect",
        x0: 0,
        y0: 0,
        x1: 0,
        y1: 0,
        corner: 0,
        cx: 0,
        cy: 0,
        diameter: 0,
        side: "outside",
        job: null,
        sizes: null,
        bore: true,
        holes: null,
    };
}

/** The operations a Plot page job was made from: its list, or the one operation a job made before there were lists keeps. */
export function recipeOps(recipe: Recipe | null | undefined): MillOperation[] {
    if (!recipe) {
        return [];
    }
    if (recipe.ops && recipe.ops.length > 0) {
        return [...recipe.ops];
    }
    return recipe.mill ? [recipe.mill] : [];
}

/** How a rectangle is given: by two corners, or by its center and its size. */
export type RectMode = "corners" | "center";

/** A size as a sketch writes it: to the micron, without trailing zeros. */
export function sizeText(value: number): string {
    return String(Number(value.toFixed(3)));
}

/** Points of a drill or a line named one by one up to this many; past it, only numbered. */
const NAMED_POINTS = 12;

function pointText([x, y]: Point): string {
    return `${sizeText(x)}, ${sizeText(y)}`;
}

/** The kinds whose fields are a rectangle. */
function isRect(op: MillOperation): boolean {
    return op.kind === "face" || ((op.kind === "pocket" || op.kind === "profile") && op.shape === "rect");
}

function isCircle(op: MillOperation): boolean {
    return (op.kind === "pocket" || op.kind === "profile") && op.shape === "circle";
}

/** The sizes the operation is given by, as the preview draws them over it. */
export function operationDims(op: MillOperation, mode: RectMode = "corners"): Dimension[] {
    const dims: Dimension[] = [];
    if (isRect(op)) {
        const xa = Math.min(op.x0, op.x1);
        const xb = Math.max(op.x0, op.x1);
        const ya = Math.min(op.y0, op.y1);
        const yb = Math.max(op.y0, op.y1);
        if (xb - xa > 0) {
            dims.push({ kind: "linear", from: [xa, ya], to: [xb, ya], side: -1, text: sizeText(xb - xa) });
        }
        if (yb - ya > 0) {
            dims.push({ kind: "linear", from: [xb, ya], to: [xb, yb], side: -1, text: sizeText(yb - ya) });
        }
        if (mode === "center") {
            const center: Point = [(xa + xb) / 2, (ya + yb) / 2];
            dims.push({ kind: "point", at: center, text: pointText(center) });
        } else {
            dims.push({ kind: "point", at: [op.x0, op.y0], text: pointText([op.x0, op.y0]) });
            dims.push({ kind: "point", at: [op.x1, op.y1], text: pointText([op.x1, op.y1]) });
        }
        const corner = op.corner ?? 0;
        if (op.kind !== "face" && corner > 0) {
            dims.push({ kind: "radius", center: [xb - corner, yb - corner], radius: corner, angle: 45, text: `R${sizeText(corner)}` });
        }
    } else if (isCircle(op)) {
        const r = op.diameter / 2;
        if (r > 0) {
            dims.push({ kind: "linear", from: [op.cx - r, op.cy], to: [op.cx + r, op.cy], side: 0, text: `D${sizeText(op.diameter)}` });
        }
        dims.push({ kind: "point", at: [op.cx, op.cy], text: pointText([op.cx, op.cy]) });
    } else if (op.kind === "drill" || op.kind === "line") {
        const named = op.points.length <= NAMED_POINTS;
        op.points.forEach((point, index) => {
            dims.push({ kind: "point", at: point, text: named ? `${index + 1}: ${pointText(point)}` : String(index + 1) });
        });
        if (op.kind === "line" && named) {
            const points = op.closed && op.points.length > 2 ? [...op.points, op.points[0]!] : op.points;
            for (let index = 1; index < points.length; index++) {
                const from = points[index - 1]!;
                const to = points[index]!;
                const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
                if (length > 0) {
                    dims.push({ kind: "linear", from, to, side: 1, text: sizeText(length) });
                }
            }
        }
    }
    return dims;
}

/** Dimensions turned counterclockwise about the origin by `degrees`, then moved, as a job placed elsewhere is. */
export function movedDims(dims: Dimension[], degrees: number, dx: number, dy: number): Dimension[] {
    if (degrees === 0 && dx === 0 && dy === 0) {
        return dims;
    }
    const at = (point: [number, number]): [number, number] => {
        const [x, y] = degrees === 0 ? point : turnPoint(point, degrees);
        return [x + dx, y + dy];
    };
    return dims.map((dim): Dimension => {
        if (dim.kind === "linear") {
            return { ...dim, from: at(dim.from), to: at(dim.to) };
        }
        if (dim.kind === "radius") {
            return { ...dim, center: at(dim.center), angle: dim.angle + degrees };
        }
        return { ...dim, at: at(dim.at) };
    });
}

const SIDE_TEXT: Record<string, string> = { outside: "outside", inside: "inside", on: "on the line" };

/** A line naming an operation in the job's list. */
export function operationSummary(op: MillOperation): string {
    const w = Math.abs(op.x1 - op.x0);
    const h = Math.abs(op.y1 - op.y0);
    const corner = op.corner ?? 0;
    const rect = `${sizeText(w)} x ${sizeText(h)}${corner > 0 && op.kind !== "face" ? ` R${sizeText(corner)}` : ""} at ${pointText([(op.x0 + op.x1) / 2, (op.y0 + op.y1) / 2])}`;
    const circle = `D${sizeText(op.diameter)} at ${pointText([op.cx, op.cy])}`;
    switch (op.kind) {
        case "drill":
            return `${op.cutter === "laser" ? "mark" : "drill"} ${countText(op.points.length, "point", "points")}`;
        case "holes":
            return `holes${op.holes ? ` (${op.holes.length})` : ""}${op.sizes ? `, ${op.sizes.map((size) => sizeText(size)).join(", ")} mm` : ""}`;
        case "line":
            return `${op.closed ? "closed line" : "line"} through ${op.points.length} points`;
        case "face":
            return `face ${rect}`;
        case "pocket":
            return `pocket ${op.shape === "circle" ? circle : rect}`;
        case "profile":
            return `profile ${SIDE_TEXT[op.side] ?? op.side} ${op.shape === "circle" ? circle : rect}`;
    }
}

/** The fields of an operation that decide what it cuts: everything but its name and the holes filled in when it was made. */
function cutting(op: MillOperation): Record<string, unknown> {
    const { name: _name, holes: _holes, ...rest } = op;
    return { ...rest, corner: op.corner ?? 0 };
}

/** Whether two operations cut the same, a field left out counting as one set to null: what decides the applied mark on the Plot page. */
export function sameOperation(a: MillOperation, b: MillOperation): boolean {
    const x = cutting(a);
    const y = cutting(b);
    const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
    for (const key of keys) {
        if (JSON.stringify(x[key] ?? null) !== JSON.stringify(y[key] ?? null)) {
            return false;
        }
    }
    return true;
}
