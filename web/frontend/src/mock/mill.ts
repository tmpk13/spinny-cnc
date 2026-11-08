// The Plot page's operations for the in-page mock backend, the backend's
// twin: the same paths, groups, labels and refusals for the same numbers,
// with a spindle or a laser, one operation a job or several, so the page
// can be tried without a machine. Also the turn and shift of a whole job
// and the group settings a job made again keeps.

import { turnPoint } from "../align.ts";
import type { Group, HolePoint, Job, MillOperation, MillResponse, Path, Point, Recipe } from "../types.ts";
import { checkDepth, checkPower, checkSpeed, computeStats, DEFAULT_DEPTH, DEFAULT_PLUNGE, formatG, MAX_GROUP_PASSES, MAX_VALUE, MAX_VALUE_TEXT, type RateLimits } from "./jobs.ts";

export const DEFAULT_TOLERANCE = 0.005;
export const MIN_STEPOVER = 0.05;
export const MAX_STEPOVER = 1;
export const MAX_POCKET_STEPOVER = 0.85;
const EPSILON = 1e-9;
const BORE_SLACK = 0.05;
const MAX_POINTS = 5000;
export const MAX_OPERATIONS = 100;

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

function checkTool(tool: number): void {
    if (!(Number.isFinite(tool) && tool > 0 && tool <= 100)) {
        throw new Error("the bit must be above 0 and at most 100 mm across");
    }
}

function checkStepover(stepover: number): void {
    if (!(Number.isFinite(stepover) && stepover >= MIN_STEPOVER && stepover <= MAX_STEPOVER)) {
        throw new Error(`the stepover is a share of the bit, ${formatG(MIN_STEPOVER)} to ${formatG(MAX_STEPOVER)}`);
    }
}

export function box(x0: number, y0: number, x1: number, y1: number): [number, number, number, number] {
    return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}

/** A rectangle's corner radius: none (0), up to half its shorter side, where the rounded corners meet. */
export function checkCorner(corner: number, xa: number, ya: number, xb: number, yb: number): void {
    if (!(Number.isFinite(corner) && corner >= 0)) {
        throw new Error("the corner radius must be 0 or more");
    }
    const half = Math.min(xb - xa, yb - ya) / 2;
    if (corner > half + EPSILON) {
        throw new Error(`the corner radius is at most half the shorter side, ${formatG(half)} mm`);
    }
}

export function arc(cx: number, cy: number, radius: number, start: number, sweep: number, tolerance = DEFAULT_TOLERANCE): Path {
    if (radius <= EPSILON) {
        return [[cx, cy]];
    }
    const tol = Math.min(Math.max(tolerance, 1e-6), radius);
    const step = 2 * Math.acos(1 - tol / radius);
    const count = Math.max(2, Math.ceil(Math.abs((sweep * Math.PI) / 180) / step), Math.ceil((Math.abs(sweep) / 360) * 16));
    const a0 = (start * Math.PI) / 180;
    const a1 = (sweep * Math.PI) / 180;
    const out: Path = [];
    for (let i = 0; i <= count; i++) {
        const a = a0 + (a1 * i) / count;
        out.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a)]);
    }
    return out;
}

export function circle(cx: number, cy: number, radius: number, ccw = true, tolerance = DEFAULT_TOLERANCE): Path {
    const path = arc(cx, cy, radius, 0, ccw ? 360 : -360, tolerance);
    if (path.length > 1) {
        path[path.length - 1] = path[0]!;
    }
    return path;
}

function rectangle(xa: number, ya: number, xb: number, yb: number, ccw: boolean, near: Point | null = null): Path {
    let corners: Point[] = [[xa, ya], [xb, ya], [xb, yb], [xa, yb]];
    if (!ccw) {
        corners = [corners[0]!, corners[3]!, corners[2]!, corners[1]!];
    }
    let first = 0;
    if (near !== null) {
        let best = Infinity;
        corners.forEach((corner, index) => {
            const distance = Math.hypot(corner[0] - near[0], corner[1] - near[1]);
            if (distance < best) {
                best = distance;
                first = index;
            }
        });
    }
    const ordered = [...corners.slice(first), ...corners.slice(0, first)];
    return [...ordered, ordered[0]!];
}

/**
 * A closed loop round the box with each corner a quarter circle of radius
 * `rho` about a center `rho` inside it, counterclockwise or clockwise,
 * starting and ending at the middle of the corner arc nearest `near` (the
 * low corner's without one).
 */
function roundedLoop(xa: number, ya: number, xb: number, yb: number, rho: number, ccw: boolean, near: Point | null = null, tolerance = DEFAULT_TOLERANCE): Path {
    const centers: Point[] = [[xa + rho, ya + rho], [xb - rho, ya + rho], [xb - rho, yb - rho], [xa + rho, yb - rho]];
    const starts = [180, 270, 0, 90];
    const halves = centers.map(([cx, cy], index): [Path, Path] => [
        arc(cx, cy, rho, starts[index]!, 45, tolerance),
        arc(cx, cy, rho, starts[index]! + 45, 45, tolerance),
    ]);
    let first = 0;
    if (near !== null) {
        let best = Infinity;
        halves.forEach(([, late], index) => {
            const distance = Math.hypot(late[0]![0] - near[0], late[0]![1] - near[1]);
            if (distance < best) {
                best = distance;
                first = index;
            }
        });
    }
    const path: Path = [...halves[first]![1]];
    for (let step = 1; step < 4; step++) {
        const [early, late] = halves[(first + step) % 4]!;
        path.push(...early, ...late.slice(1));
    }
    path.push(...halves[first]![0]);
    if (!ccw) {
        path.reverse();
    }
    return path;
}

/** The rectangle's own outline, closed, counterclockwise: from the low corner when its corners are square, else from the middle of the low corner's arc. */
export function roundedRectangle(x0: number, y0: number, x1: number, y1: number, corner = 0, tolerance = DEFAULT_TOLERANCE): Path {
    const [xa, ya, xb, yb] = box(x0, y0, x1, y1);
    checkCorner(corner, xa, ya, xb, yb);
    if (corner > EPSILON) {
        return roundedLoop(xa, ya, xb, yb, corner, true, null, tolerance);
    }
    return [[xa, ya], [xb, ya], [xb, yb], [xa, yb], [xa, ya]];
}

export function drill(points: Point[]): Path[] {
    if (points.length === 0) {
        throw new Error("a drill needs at least one point");
    }
    return points.map(([x, y]) => [[x, y]]);
}

export function line(points: Point[], closed = false): Path[] {
    const path: Path = [];
    for (const [x, y] of points) {
        const last = path[path.length - 1];
        if (!last || Math.hypot(x - last[0], y - last[1]) > EPSILON) {
            path.push([x, y]);
        }
    }
    if (path.length < 2) {
        throw new Error("a line needs two points apart");
    }
    const first = path[0]!;
    const last = path[path.length - 1]!;
    if (closed && Math.hypot(first[0] - last[0], first[1] - last[1]) > EPSILON) {
        path.push([first[0], first[1]]);
    }
    return [path];
}

export function face(x0: number, y0: number, x1: number, y1: number, tool: number, stepover: number): Path[] {
    checkTool(tool);
    checkStepover(stepover);
    const [xa, ya, xb, yb] = box(x0, y0, x1, y1);
    if (xb - xa <= EPSILON && yb - ya <= EPSILON) {
        throw new Error("a face needs two corners apart");
    }
    const rows = Math.max(0, Math.ceil((yb - ya) / (stepover * tool) - 1e-9));
    const path: Path = [];
    for (let j = 0; j <= rows; j++) {
        const y = rows > 0 ? ya + ((yb - ya) * j) / rows : ya;
        const ends: Path = [[xa, y], [xb, y]];
        path.push(...(j % 2 === 0 ? ends : ends.reverse()));
    }
    return line(path);
}

export function pocketRect(x0: number, y0: number, x1: number, y1: number, tool: number, stepover: number, climb = true, corner = 0, tolerance = DEFAULT_TOLERANCE): Path[] {
    checkTool(tool);
    checkStepover(stepover);
    if (stepover > MAX_POCKET_STEPOVER) {
        throw new Error(`a rectangular pocket's stepover is at most ${formatG(MAX_POCKET_STEPOVER)}: wider, its loops leave the corners between them standing`);
    }
    const [xa, ya, xb, yb] = box(x0, y0, x1, y1);
    checkCorner(corner, xa, ya, xb, yb);
    const r = tool / 2;
    const a = xa + r;
    const c = ya + r;
    let b = xb - r;
    let d = yb - r;
    if (b < a - EPSILON || d < c - EPSILON) {
        throw new Error(`the pocket is narrower than the bit: ${(xb - xa).toFixed(3)} by ${(yb - ya).toFixed(3)} mm for a ${formatG(tool)} mm bit`);
    }
    b = Math.max(a, b);
    d = Math.max(c, d);
    const m = Math.min(b - a, d - c) / 2;
    const path: Path = [[a + m, c + m], [b - m, d - m]];
    const insets: number[] = [];
    for (let t = m - stepover * tool; t > EPSILON; t -= stepover * tool) {
        insets.push(t);
    }
    insets.push(0);
    for (const t of insets) {
        const rho = corner - r - t;
        path.push(...(rho > EPSILON
            ? roundedLoop(a + t, c + t, b - t, d - t, rho, climb, path[path.length - 1]!, tolerance)
            : rectangle(a + t, c + t, b - t, d - t, climb, path[path.length - 1]!)));
    }
    return line(path);
}

export function pocketCircle(cx: number, cy: number, diameter: number, tool: number, stepover: number, climb = true, tolerance = DEFAULT_TOLERANCE): Path[] {
    checkTool(tool);
    checkStepover(stepover);
    if (!(Number.isFinite(diameter) && diameter > 0)) {
        throw new Error("the circle needs a diameter above 0");
    }
    const radius = diameter / 2 - tool / 2;
    if (radius < -EPSILON) {
        throw new Error(`the bit is wider than the circle: a ${formatG(tool)} mm bit in ${formatG(diameter)} mm`);
    }
    if (radius <= 1e-6) {
        return [[[cx, cy]]];
    }
    const radii: number[] = [];
    for (let rho = radius; rho > EPSILON; rho -= stepover * tool) {
        radii.push(rho);
    }
    const path: Path = [[cx, cy]];
    for (const rho of radii.reverse()) {
        path.push(...circle(cx, cy, rho, climb, tolerance));
    }
    return line(path);
}

const SIDES = ["outside", "inside", "on"];

export function profileRect(x0: number, y0: number, x1: number, y1: number, tool: number, side = "outside", climb = true, tolerance = DEFAULT_TOLERANCE, corner = 0): Path[] {
    checkTool(tool);
    if (!SIDES.includes(side)) {
        throw new Error(`the side is one of ${SIDES.join(", ")}`);
    }
    const [xa, ya, xb, yb] = box(x0, y0, x1, y1);
    if (xb - xa <= EPSILON || yb - ya <= EPSILON) {
        throw new Error("a rectangle needs a width and a height");
    }
    checkCorner(corner, xa, ya, xb, yb);
    const r = tool / 2;
    if (side === "inside") {
        if (xb - xa < tool - EPSILON || yb - ya < tool - EPSILON) {
            throw new Error(`the rectangle is narrower than the bit: ${(xb - xa).toFixed(3)} by ${(yb - ya).toFixed(3)} mm for a ${formatG(tool)} mm bit`);
        }
        const a = xa + r;
        const c = ya + r;
        const b = Math.max(xa + r, xb - r);
        const d = Math.max(ya + r, yb - r);
        if (corner - r > EPSILON) {
            return line(roundedLoop(a, c, b, d, corner - r, climb, null, tolerance));
        }
        return line(rectangle(a, c, b, d, climb));
    }
    if (side === "on") {
        if (corner > EPSILON) {
            return line(roundedLoop(xa, ya, xb, yb, corner, !climb, null, tolerance));
        }
        return line(rectangle(xa, ya, xb, yb, !climb));
    }
    const k = corner;
    const rr = r + corner;
    const path: Path = [[xa + k, ya - r], [xb - k, ya - r]];
    path.push(...arc(xb - k, ya + k, rr, -90, 90, tolerance).slice(1));
    path.push([xb + r, yb - k]);
    path.push(...arc(xb - k, yb - k, rr, 0, 90, tolerance).slice(1));
    path.push([xa + k, yb + r]);
    path.push(...arc(xa + k, yb - k, rr, 90, 90, tolerance).slice(1));
    path.push([xa - r, ya + k]);
    path.push(...arc(xa + k, ya + k, rr, 180, 90, tolerance).slice(1));
    path[path.length - 1] = path[0]!;
    if (climb) {
        path.reverse();
    }
    return line(path);
}

export function profileCircle(cx: number, cy: number, diameter: number, tool: number, side = "outside", climb = true, tolerance = DEFAULT_TOLERANCE): Path[] {
    checkTool(tool);
    if (!SIDES.includes(side)) {
        throw new Error(`the side is one of ${SIDES.join(", ")}`);
    }
    if (!(Number.isFinite(diameter) && diameter > 0)) {
        throw new Error("the circle needs a diameter above 0");
    }
    const r = tool / 2;
    const radius = diameter / 2 + (side === "outside" ? r : side === "inside" ? -r : 0);
    if (radius < -EPSILON) {
        throw new Error(`the bit is wider than the circle: a ${formatG(tool)} mm bit in ${formatG(diameter)} mm`);
    }
    if (radius <= 1e-6) {
        return [[[cx, cy]]];
    }
    return line(circle(cx, cy, radius, (side === "inside") === climb, tolerance));
}

function isLaser(op: MillOperation): boolean {
    return op.cutter === "laser";
}

/** A laser's passes as given; a spindle's as many as go down to the operation's depth. */
export function passesOf(op: MillOperation): number {
    if (isLaser(op)) {
        return op.passes ?? 1;
    }
    return Math.max(1, Math.ceil(op.depth / op.step_down - 1e-9));
}

function checkOperation(op: MillOperation): void {
    if (isLaser(op)) {
        if (!(Number.isFinite(op.tool) && op.tool > 0 && op.tool <= 100)) {
            throw new Error("the spot must be above 0 and at most 100 mm across");
        }
        const passes = op.passes ?? 1;
        if (!(Number.isInteger(passes) && passes >= 1 && passes <= MAX_GROUP_PASSES)) {
            throw new Error(`the passes must be 1 to ${MAX_GROUP_PASSES}`);
        }
        checkSpeed(op.speed, "the speed");
        checkPower(op.power ?? 500, "the power");
    } else {
        checkTool(op.tool);
        checkDepth(op.depth);
        if (!(Number.isFinite(op.step_down) && op.step_down > 0)) {
            throw new Error("the step down must be above 0 mm");
        }
        if (passesOf(op) > MAX_GROUP_PASSES) {
            throw new Error(`${formatG(op.depth)} mm in steps of ${formatG(op.step_down)} is over ${MAX_GROUP_PASSES} passes`);
        }
        checkSpeed(op.speed, "the feed");
        checkSpeed(op.plunge, "the plunge");
        checkPower(op.spindle, "the spindle speed");
    }
    const values = [op.x0, op.y0, op.x1, op.y1, op.cx, op.cy, op.diameter, op.corner ?? 0, ...op.points.flat()];
    if (!values.every((v) => Math.abs(v) <= MAX_VALUE)) {
        throw new Error(`coordinates must be within ${MAX_VALUE_TEXT} mm`);
    }
    if (op.points.length > MAX_POINTS) {
        throw new Error(`at most ${MAX_POINTS} points`);
    }
    if (op.holes && op.holes.length > MAX_POINTS) {
        throw new Error(`at most ${MAX_POINTS} holes`);
    }
}

function group(op: MillOperation, label: string, paths: Path[]): Group {
    if (isLaser(op)) {
        return { label, power: op.power ?? 500, min_power: 0, speed: op.speed, passes: passesOf(op), enabled: true, depth: DEFAULT_DEPTH, plunge: DEFAULT_PLUNGE, tool: "laser", paths };
    }
    return { label, power: op.spindle, min_power: 0, speed: op.speed, passes: passesOf(op), enabled: true, depth: op.depth, plunge: op.plunge, tool: "spindle", paths };
}

/** A drill at every point, or for a beam, which drills nothing standing still, a ring the spot across about it. */
function pointPaths(op: MillOperation, points: Point[]): Path[] {
    if (isLaser(op)) {
        return points.map(([x, y]) => circle(x, y, op.tool / 2, true, Math.min(DEFAULT_TOLERANCE, op.tool / 8)));
    }
    return drill(points);
}

function rectOutline(op: MillOperation, corner = 0): Path[] {
    return [roundedRectangle(op.x0, op.y0, op.x1, op.y1, corner, Math.max(0.01, corner * 0.002))];
}

/** How a rectangle's corners are rounded, for its label; nothing when square. */
function cornersText(op: MillOperation): string {
    const corner = op.corner ?? 0;
    return corner > 0 ? `, corners R${formatG(corner)}` : "";
}

function circleOutline(cx: number, cy: number, diameter: number): Path {
    return circle(cx, cy, diameter / 2, true, Math.max(0.01, diameter * 0.002));
}

/** The indices of a short walk over the points from the one nearest `start`. */
export function tour(points: Point[], start: Point = [0, 0]): number[] {
    const left = points.map((_, index) => index);
    const order: number[] = [];
    let here = start;
    while (left.length > 0) {
        let best = 0;
        let bestDistance = Infinity;
        left.forEach((index, at) => {
            const point = points[index]!;
            const distance = Math.hypot(point[0] - here[0], point[1] - here[1]);
            if (distance < bestDistance) {
                bestDistance = distance;
                best = at;
            }
        });
        const index = left.splice(best, 1)[0]!;
        order.push(index);
        here = points[index]!;
    }
    return order;
}

function sizeOf(diameter: number): number {
    return Math.round(diameter * 100) / 100;
}

function holeGroups(op: MillOperation, holes: HolePoint[]): { groups: Group[]; notes: string[] } {
    const wanted = op.sizes ? new Set(op.sizes.map(sizeOf)) : null;
    const bySize = new Map<number, Point[]>();
    for (const [x, y, d] of holes) {
        const size = sizeOf(d);
        if (wanted === null || wanted.has(size)) {
            bySize.set(size, [...(bySize.get(size) ?? []), [x, y]]);
        }
    }
    if (bySize.size === 0) {
        throw new Error("no holes of the sizes asked for");
    }
    const groups: Group[] = [];
    const notes: string[] = [];
    let here: Point = [0, 0];
    let small = 0;
    for (const size of [...bySize.keys()].sort((a, b) => a - b)) {
        const found = bySize.get(size)!;
        const points = tour(found, here).map((index) => found[index]!);
        here = points[points.length - 1]!;
        const laser = isLaser(op);
        const wide = size > op.tool + BORE_SLACK;
        if (op.bore && wide) {
            const paths = points.map(([x, y]) => pocketCircle(x, y, size, op.tool, Math.min(op.stepover, 1), op.climb)[0]!);
            groups.push(group(op, `${laser ? "clear" : "bore"} ${size.toFixed(2)} mm holes (${points.length})`, paths));
        } else if (laser && wide) {
            // The beam along the hole's edge, inside it: the plug drops out.
            const paths = points.map(([x, y]) => profileCircle(x, y, size, op.tool, "inside", op.climb)[0]!);
            groups.push(group(op, `cut ${size.toFixed(2)} mm holes (${points.length})`, paths));
        } else {
            if (size < op.tool - BORE_SLACK) {
                small += points.length;
            }
            groups.push(group(op, `${laser ? "mark" : "drill"} ${size.toFixed(2)} mm holes (${points.length})`, pointPaths(op, points)));
        }
    }
    if (small > 0) {
        notes.push(`${small} holes are smaller than the ${formatG(op.tool)} mm ${isLaser(op) ? "spot" : "bit"} and come out its size`);
    }
    return { groups, notes };
}

/** The operation's job, not stored, and what to know about it; `holes` are the board job's for a holes operation. */
export function buildMill(id: string, op: MillOperation, holes: HolePoint[] | null, limits: RateLimits): MillResponse {
    checkOperation(op);
    let groups: Group[];
    let notes: string[] = [];
    let outline: Path[] = [];
    let kept: HolePoint[] = [];
    let name: string;
    const mm = formatG;
    if (op.kind === "drill") {
        if (op.points.length === 0) {
            throw new Error("a drill needs at least one point");
        }
        const verb = isLaser(op) ? "mark" : "drill";
        groups = [group(op, `${verb} ${op.points.length} points`, pointPaths(op, op.points))];
        outline = op.points.map(([x, y]) => circleOutline(x, y, op.tool));
        name = `${verb} ${op.points.length} points`;
    } else if (op.kind === "holes") {
        if (!holes || holes.length === 0) {
            throw new Error("the job has no drill holes: import its board with the drill file");
        }
        ({ groups, notes } = holeGroups(op, holes));
        const wanted = op.sizes ? new Set(op.sizes.map(sizeOf)) : null;
        kept = holes.filter((hole) => wanted === null || wanted.has(sizeOf(hole[2])));
        outline = kept.map(([x, y, d]) => circleOutline(x, y, d));
        name = `holes ${kept.length}`;
    } else if (op.kind === "line") {
        groups = [group(op, `${op.closed ? "closed line" : "line"} through ${op.points.length} points`, line(op.points, op.closed))];
        name = `line ${op.points.length} points`;
    } else if (op.kind === "face") {
        const w = Math.abs(op.x1 - op.x0);
        const h = Math.abs(op.y1 - op.y0);
        groups = [group(op, `face ${mm(w)} x ${mm(h)} mm`, face(op.x0, op.y0, op.x1, op.y1, op.tool, op.stepover))];
        outline = rectOutline(op);
        name = `face ${mm(w)} x ${mm(h)}`;
    } else {
        let paths: Path[];
        let size: string;
        if (op.shape === "circle") {
            paths = op.kind === "pocket"
                ? pocketCircle(op.cx, op.cy, op.diameter, op.tool, op.stepover, op.climb)
                : profileCircle(op.cx, op.cy, op.diameter, op.tool, op.side, op.climb);
            size = `${mm(op.diameter)} mm circle`;
            outline = [circleOutline(op.cx, op.cy, op.diameter)];
        } else {
            const corner = op.corner ?? 0;
            paths = op.kind === "pocket"
                ? pocketRect(op.x0, op.y0, op.x1, op.y1, op.tool, op.stepover, op.climb, corner)
                : profileRect(op.x0, op.y0, op.x1, op.y1, op.tool, op.side, op.climb, DEFAULT_TOLERANCE, corner);
            size = `${mm(Math.abs(op.x1 - op.x0))} x ${mm(Math.abs(op.y1 - op.y0))} mm${cornersText(op)}`;
            outline = rectOutline(op, corner);
        }
        const what = op.kind === "pocket" ? "pocket" : `profile ${op.side}`;
        groups = [group(op, `${what} ${size}`, paths)];
        name = `${what} ${size}`;
        if (op.kind === "profile" && op.side !== "inside") {
            notes.push("no tabs: a part cut free can move at the last pass, so hold it down or leave a skin");
        }
    }
    const passes = passesOf(op);
    if (isLaser(op)) {
        notes.push(`${passes} pass${passes !== 1 ? "es" : ""} at S${mm(op.power ?? 500)} and ${mm(op.speed)} mm/min, a ${mm(op.tool)} mm spot`);
    } else {
        notes.push(`${passes} pass${passes !== 1 ? "es" : ""} of ${mm(op.depth / passes)} mm down to ${mm(op.depth)} mm`);
    }
    const job: Job = {
        id,
        name: (op.name ?? "").trim() || name,
        source: "mill",
        spot: op.tool,
        offset: { x: 0, y: 0 },
        rotation: 0,
        pads: [],
        holes: kept,
        design: null,
        recipe: { mill: { ...op } },
        groups,
        outline,
        copper: [],
        stats: computeStats(groups, limits),
    };
    return { job, notes };
}

/** A group's label with its numbers taken out. */
export function labelStem(label: string): string {
    return label.replace(/[-+]?\d+(?:\.\d+)?/g, "#");
}

const SETTINGS = ["power", "min_power", "speed", "passes", "enabled", "depth", "plunge", "thickness", "focus"] as const;

/** Each old group's settings onto the new group made in its place, matched by label but for its numbers, in order. */
export function carrySettings(old: Group[], made: Group[]): void {
    const byStem = new Map<string, Group[]>();
    for (const g of old) {
        const stem = labelStem(g.label);
        byStem.set(stem, [...(byStem.get(stem) ?? []), g]);
    }
    const seen = new Map<string, number>();
    for (const g of made) {
        const stem = labelStem(g.label);
        const index = seen.get(stem) ?? 0;
        seen.set(stem, index + 1);
        const source = byStem.get(stem)?.[index];
        if (source) {
            for (const name of SETTINGS) {
                (g as unknown as Record<string, unknown>)[name] = source[name];
            }
        }
    }
}

/** The job turned counterclockwise about the origin, then moved, everything on it with it. */
export function moveJob(job: Job, degrees: number, dx: number, dy: number): void {
    const at = (point: Point): Point => {
        const [x, y] = degrees === 0 ? point : turnPoint(point, degrees);
        return [x + dx, y + dy];
    };
    const paths = (list: Path[]): Path[] => list.map((path) => path.map(at));
    for (const g of job.groups) {
        g.paths = paths(g.paths);
        if (g.moves) {
            g.moves = g.moves.map((path) => path.map(([x, y, z, kind]) => [...at([x, y]), z, kind]));
        }
    }
    job.outline = paths(job.outline);
    job.copper = paths(job.copper);
    job.pads = (job.pads ?? []).map(([x, y, area]) => [...at([x, y]), area]);
    job.holes = (job.holes ?? []).map(([x, y, d]) => [...at([x, y]), d]);
    const [ox, oy] = at([job.offset.x, job.offset.y]);
    job.offset = { x: ox, y: oy };
    job.rotation = (job.rotation ?? 0) + degrees;
    if (job.design) {
        const [sx, sy] = at(job.design.shift);
        job.design = { ...job.design, shift: [sx, sy], rotation: job.design.rotation + degrees };
    }
}

/** The middle of the box round everything the job cuts and its outline; the origin for a job with nothing on the board. */
export function cutMiddle(job: Job): Point {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const take = (x: number, y: number): void => {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
    };
    for (const g of job.groups) {
        for (const path of g.paths) {
            for (const [x, y] of path) {
                take(x, y);
            }
        }
        for (const path of g.moves ?? []) {
            for (const [x, y] of path) {
                take(x, y);
            }
        }
    }
    for (const path of job.outline) {
        for (const [x, y] of path) {
            take(x, y);
        }
    }
    return minX > maxX ? [0, 0] : [(minX + maxX) / 2, (minY + maxY) / 2];
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

function bitOf(op: MillOperation): string {
    return isLaser(op) ? "spot" : "bit";
}

/**
 * The job of several operations, not stored, and what to know about it:
 * each operation's groups in order, every outline and hole, the notes
 * numbered by operation when there are several. `holesOf` gives a holes
 * operation the board job's holes where it does not carry them.
 */
export function buildMillJob(id: string, ops: MillOperation[], holesOf: ((op: MillOperation) => HolePoint[]) | null, limits: RateLimits, name: string | null = null): MillResponse {
    if (ops.length === 0) {
        throw new Error("a job needs at least one operation");
    }
    const first = ops[0]!;
    ops.slice(1).forEach((op, at) => {
        const index = at + 2;
        const cutter = op.cutter ?? "spindle";
        const firstCutter = first.cutter ?? "spindle";
        if (cutter !== firstCutter) {
            throw new Error(`operation ${index} cuts with a ${cutter} and operation 1 with a ${firstCutter}: a job cuts with one`);
        }
        if (Math.abs(op.tool - first.tool) > 1e-9) {
            throw new Error(`operation ${index}'s ${formatG(op.tool)} mm ${bitOf(op)} is not operation 1's ${formatG(first.tool)} mm: a job cuts with one ${bitOf(first)}`);
        }
    });
    const groups: Group[] = [];
    const outline: Path[] = [];
    const kept: HolePoint[] = [];
    const notes: string[] = [];
    const keptOps: MillOperation[] = [];
    const names: string[] = [];
    ops.forEach((op, at) => {
        let holes = op.holes ?? null;
        if (op.kind === "holes" && holes === null && holesOf !== null) {
            holes = holesOf(op);
        }
        const part = buildMill(id, op, holes, limits);
        groups.push(...part.job.groups);
        outline.push(...part.job.outline);
        kept.push(...(part.job.holes ?? []));
        notes.push(...(ops.length === 1 ? part.notes : part.notes.map((note) => `${at + 1}: ${note}`)));
        names.push(part.job.name);
        keptOps.push(op.kind === "holes" ? { ...op, holes: (holes ?? []).map(([x, y, d]) => [x, y, d] as HolePoint) } : { ...op });
    });
    const made = (name ?? "").trim() || (names.length === 1 ? names[0]! : `${names[0]!} and ${names.length - 1} more`);
    const job: Job = {
        id,
        name: made,
        source: "mill",
        spot: first.tool,
        offset: { x: 0, y: 0 },
        rotation: 0,
        pads: [],
        holes: kept,
        design: null,
        recipe: { ops: keptOps },
        groups,
        outline,
        copper: [],
        stats: computeStats(groups, limits),
    };
    return { job, notes };
}

/** A job made again from its operations put where `where` is: turned and moved as it has been since it was made, under its id. */
export function placed(made: Job, where: Job): Job {
    moveJob(made, where.rotation ?? 0, where.offset.x, where.offset.y);
    made.id = where.id;
    made.offset = { ...where.offset };
    made.rotation = where.rotation ?? 0;
    return made;
}

/** A Plot page job made again for a bit `tool` mm across, where it is now, its groups' settings kept. */
export function remakeMill(job: Job, tool: number, limits: RateLimits): Job {
    const ops = recipeOps(job.recipe).map((op): MillOperation => ({ ...defaultOperation(), ...op, tool }));
    let made: Job;
    if (ops.length === 1 && ops[0]!.kind === "holes" && (ops[0]!.holes ?? null) === null) {
        // A job made before operations kept their holes: the job's own,
        // which moved with it.
        made = buildMill(job.id, ops[0]!, job.holes ?? [], limits).job;
        made.offset = { ...job.offset };
        made.rotation = job.rotation ?? 0;
    } else {
        made = placed(buildMillJob(job.id, ops, null, limits).job, job);
    }
    carrySettings(job.groups, made.groups);
    made.name = job.name;
    made.stats = computeStats(made.groups, limits);
    return made;
}
