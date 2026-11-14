// A camera's picture as the page shows it: the newest frame, asked for at
// the size it is shown at (the box's width times the screen's pixel ratio
// times the zoom, up to the camera's full size), fitted inside a box the
// operator can make taller or shorter by its grip (kept per camera), and
// the page's own marks drawn over it as SVG in the picture's own pixels
// (the crosshair, the circles looked within, the spots found, the box a
// search covers, the board where the looks put it, the points whose place
// is known), so their lines stay thin and sharp at any zoom. Each frame
// shown is handed to whoever watches the picture's key (a camera's live
// numbers). Ctrl and the wheel zoom on the picture's center (the plain
// wheel scrolls the page), as do the buttons under it and a zoom typed in
// between them, out to a quarter of the picture's size with room around
// it; Reset view brings the whole picture back. A drag moves the head so
// what the camera sees follows the pointer, a line showing the move; a
// double-click brings a point to the crosshair; Shift and a drag draw the
// box a search keeps to, in the machine's frame. Upright (on unless
// switched off, kept per camera) shows the picture turned by the camera's
// roll to the nearest quarter turn, and flipped when the camera sees the
// machine mirrored, so the machine's +X points right and +Y up as on the
// jog pad; Turn turns it a further quarter clockwise by hand (kept per
// camera). The marks turn with it, their words kept level, and the pointer
// is turned back into the picture's own pixels. The View menu sets the
// crosshair's shape (a cross, a circle, both) and reach, kept per camera.
// A spot a routine or a look found stays over the picture until Clear
// marks, moving with the machine so it stays over what it marked (or, the
// View menu's Marks follow the machine off, where it was drawn). Edges
// (kept per camera) draws the straight edges pcbv finds, asked once a
// second while on and shown. What a routine found and holds for the
// operator (spinny_web.findings) is drawn dashed in magenta with a row of
// its words, Keep and Discard; the View menu says whether the camera's
// routines ask first.

import { button, el, numberField, readStored, setLocked, stepperBox, writeStored } from "../dom.ts";
import { errorText } from "../api.ts";
import { formatFixed, parseNumber } from "../format.ts";
import { openMenu } from "../menu.ts";
import { knownMarks } from "./known.ts";
import type { AppState } from "../state.ts";
import type { CameraEdges, CameraFinding } from "../types.ts";
import type { Ctx } from "./context.ts";

/** How often a picture is asked for while it shows, ms. */
export const FRAME_INTERVAL_MS = 250;
/** How often the edge view asks for the straight edges in the picture while it is on and the picture shows, ms. */
export const EDGES_INTERVAL_MS = 1000;
/**
 * The zooms the buttons and the wheel step through; a zoom typed in may lie
 * anywhere from the first to the last. Under 1 the picture shows smaller
 * than its box, with room around it where marks beyond its edges show.
 */
export const ZOOMS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8];

/** How the picture's center is marked: a cross, a circle, both, or nothing. */
export type CrosshairShape = "cross" | "circle" | "both" | "none";
/** How far the crosshair reaches from the center: a share of the view's width, or `across` to the view's edges. */
export type CrosshairSize = "small" | "medium" | "large" | "across";

export const CROSSHAIR_SHAPES: { value: CrosshairShape; label: string }[] = [
    { value: "cross", label: "Cross" },
    { value: "circle", label: "Circle" },
    { value: "both", label: "Cross and circle" },
    { value: "none", label: "No crosshair" },
];

export const CROSSHAIR_SIZES: { value: CrosshairSize; label: string }[] = [
    { value: "small", label: "Small crosshair" },
    { value: "medium", label: "Medium crosshair" },
    { value: "large", label: "Large crosshair" },
    { value: "across", label: "Crosshair across the view" },
];

/** The share of the view's width each arm (and the circle's radius) reaches at each size but `across`. */
export const CROSSHAIR_SHARE: Record<Exclude<CrosshairSize, "across">, number> = { small: 1 / 40, medium: 1 / 10, large: 1 / 4 };

/** A kept crosshair shape or size, or the default for anything else. */
export function readCrosshair(shape: string | null, size: string | null): { shape: CrosshairShape; size: CrosshairSize } {
    return {
        shape: CROSSHAIR_SHAPES.find((entry) => entry.value === shape)?.value ?? "cross",
        size: CROSSHAIR_SIZES.find((entry) => entry.value === size)?.value ?? "small",
    };
}

/**
 * The crosshair's marks about the point `cx`, `cy` of a view `width` by
 * `height` px of the picture: arms a share of the view's width either way
 * (to its edges `across`), a circle of the same reach (the view's shorter
 * half `across`), or both. Sized to the view, so it keeps one size on the
 * screen at any zoom.
 */
export function crosshairMarks(shape: CrosshairShape, size: CrosshairSize, cx: number, cy: number, width: number, height: number): Mark[] {
    if (shape === "none") {
        return [];
    }
    const across = size === "across";
    const reach = across ? Math.min(width, height) / 2 : width * CROSSHAIR_SHARE[size];
    const armX = across ? width / 2 : reach;
    const armY = across ? height / 2 : reach;
    const marks: Mark[] = [];
    if (shape === "cross" || shape === "both") {
        marks.push({ kind: "line", points: [[cx - armX, cy], [cx + armX, cy]], tone: "center" });
        marks.push({ kind: "line", points: [[cx, cy - armY], [cx, cy + armY]], tone: "center" });
    }
    if (shape === "circle" || shape === "both") {
        marks.push({ kind: "circle", x: cx, y: cy, r: reach, tone: "center" });
    }
    return marks;
}

/** The zoom a value typed in asks for: within the steps' range, to a hundredth; null for no number. */
export function clampZoom(value: number | null): number | null {
    if (value === null || !Number.isFinite(value)) {
        return null;
    }
    const low = ZOOMS[0]!;
    const high = ZOOMS[ZOOMS.length - 1]!;
    return Math.round(Math.max(low, Math.min(high, value)) * 100) / 100;
}

/** The next step from `zoom` in or out (a zoom between steps goes to the step beside it), the end step at most. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
    if (direction > 0) {
        return ZOOMS.find((value) => value > zoom + 1e-9) ?? ZOOMS[ZOOMS.length - 1]!;
    }
    return [...ZOOMS].reverse().find((value) => value < zoom - 1e-9) ?? ZOOMS[0]!;
}

/** A zoom as its field shows it: 1, 2.5, 1.25. */
export function zoomText(zoom: number): string {
    return String(Math.round(zoom * 100) / 100);
}

/** The picture box's height the grip keeps it within, rem. */
export const MIN_BOX_REM = 6;
export const MAX_BOX_REM = 80;

/** How a camera's pixels turn into the machine's mm: its scale, its roll and whether it is mirrored. */
export interface Calibration {
    mmPerPx: number;
    roll: number;
    mirror: boolean;
}

/** A box on the machine, mm: x0, y0, x1, y1. */
export type MachineBox = [number, number, number, number];

/**
 * A displacement seen in a picture, px from its center (right and down
 * positive), as one on the machine, mm: the picture's y turned over, its x
 * too when mirrored, turned by the roll and scaled, as the backend's
 * picture_to_machine does.
 */
export function pictureToMachine(dx: number, dy: number, mmPerPx: number, roll: number, mirror: boolean): [number, number] {
    const u = mirror ? -dx : dx;
    const v = -dy;
    const radians = (roll * Math.PI) / 180;
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    return [mmPerPx * (u * c - v * s), mmPerPx * (u * s + v * c)];
}

/** A displacement on the machine, mm, as one in the picture, px from its center: what pictureToMachine undoes. */
export function machineToPicture(mx: number, my: number, mmPerPx: number, roll: number, mirror: boolean): [number, number] {
    const radians = (-roll * Math.PI) / 180;
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    const u = (mx * c - my * s) / mmPerPx;
    const v = (mx * s + my * c) / mmPerPx;
    return [mirror ? -u : u, -v];
}

/** How a picture is shown turned: quarter turns counterclockwise on the screen (0 to 3), after flipping it left for right when `flip`. */
export interface Turn {
    quarter: number;
    flip: boolean;
}

/** The picture as the camera gives it. */
export const UNTURNED: Turn = { quarter: 0, flip: false };

/**
 * The turn that shows a camera's picture with the machine's +X to the
 * right and +Y up: flipped when the picture is mirrored, then turned by the
 * roll (from the picture's x axis to +X, counterclockwise) to the nearest
 * quarter turn.
 */
export function uprightTurn(roll: number, mirror: boolean): Turn {
    const quarter = Number.isFinite(roll) ? ((Math.round(roll / 90) % 4) + 4) % 4 : 0;
    return { quarter, flip: mirror };
}

/** A turn turned further by `quarters` counterclockwise on the screen (negative: clockwise), its flip kept: the flip comes first, so a further turn of the screen only adds to the quarter. */
export function addTurn(turn: Turn, quarters: number): Turn {
    const add = Number.isFinite(quarters) ? Math.round(quarters) : 0;
    return { quarter: (((turn.quarter + add) % 4) + 4) % 4, flip: turn.flip };
}

/** The quarters a picture is kept turned by hand, counterclockwise, 0 to 3; 0 for anything else kept. */
export function readQuarters(kept: string | null): number {
    const value = Number(kept);
    return Number.isInteger(value) && value >= 0 && value <= 3 ? value : 0;
}

/** The cosine and sine of a turn's angle. */
function quarterTrig(quarter: number): [number, number] {
    return ([[1, 0], [0, 1], [-1, 0], [0, -1]] as [number, number][])[quarter] ?? [1, 0];
}

/** The CSS transform that shows a picture turned (flipped first, then turned counterclockwise); empty for none. */
export function turnTransform(turn: Turn): string {
    const parts: string[] = [];
    if (turn.quarter !== 0) {
        parts.push(`rotate(${-90 * turn.quarter}deg)`);
    }
    if (turn.flip) {
        parts.push("scaleX(-1)");
    }
    return parts.join(" ");
}

/**
 * A displacement on the screen, CSS px (right and down positive), as one
 * in the picture shown turned, in the same px before the turn: the
 * counterclockwise turn undone, then the flip.
 */
export function unturnOffset(x: number, y: number, turn: Turn): [number, number] {
    const [c, s] = quarterTrig(turn.quarter);
    const u = x * c - y * s;
    const v = x * s + y * c;
    return [turn.flip ? -u : u, v];
}

/** The SVG transform that keeps words at `x`, `y` of a turned picture level on the screen: the turn undone about that point; null for none. */
export function levelText(x: number, y: number, turn: Turn): string | null {
    if (turn.quarter === 0 && !turn.flip) {
        return null;
    }
    const at = `${x.toFixed(2)} ${y.toFixed(2)}`;
    return `translate(${at}) scale(${turn.flip ? -1 : 1} 1) rotate(${90 * turn.quarter}) translate(${(-x).toFixed(2)} ${(-y).toFixed(2)})`;
}

/**
 * The head's move a drag of `dx`, `dy` px of the full size picture asks
 * for, so what the camera sees follows the pointer. A camera riding on the
 * head sees the machine move against the head, so the head moves against
 * the drag; a fixed camera sees the nozzle, which moves with the head.
 */
export function dragMove(rides: boolean, dx: number, dy: number, calibration: Calibration): [number, number] {
    const [mx, my] = pictureToMachine(dx, dy, calibration.mmPerPx, calibration.roll, calibration.mirror);
    return rides ? [-mx, -my] : [mx, my];
}

/**
 * The width to ask a picture at for one shown `shown` CSS px wide at a
 * pixel ratio and a zoom: pcbv shrinks a frame by a whole factor to at
 * most the width asked for, so the factor that still gives every screen
 * pixel a picture pixel is asked for, the full size at most; 160 to 4096.
 */
export function frameRequestWidth(shown: number, ratio: number, zoom: number, full: number | null): number {
    const wanted = Math.max(1, shown * Math.max(ratio, 1) * zoom);
    if (full === null || !(full > 0)) {
        return Math.max(160, Math.min(4096, Math.ceil(wanted)));
    }
    const factor = Math.max(1, Math.floor(full / wanted));
    return Math.max(160, Math.min(4096, Math.ceil(full / factor)));
}

/** The box that holds both boxes, or `box` alone. */
export function growBox(box: MachineBox | null, by: MachineBox): MachineBox {
    if (box === null) {
        return [Math.min(by[0], by[2]), Math.min(by[1], by[3]), Math.max(by[0], by[2]), Math.max(by[1], by[3])];
    }
    return [Math.min(box[0], by[0], by[2]), Math.min(box[1], by[1], by[3]), Math.max(box[2], by[0], by[2]), Math.max(box[3], by[1], by[3])];
}

/** What a mark is: its color and line follow the tone. */
export type Tone = "center" | "ring" | "spot" | "look" | "box" | "board" | "rough" | "drag" | "miss" | "known" | "part" | "edge" | "nozzle" | "finding";

/**
 * A mark over the picture, in its full size px from the top left (y down);
 * a text's `size` is its font size in those px, `x` and `y` where its
 * baseline starts (`start`) or ends (`end`).
 */
export type Mark =
    | { kind: "circle"; x: number; y: number; r: number; tone: Tone; title?: string }
    | { kind: "ellipse"; x: number; y: number; rx: number; ry: number; angle: number; tone: Tone; title?: string }
    | { kind: "rect"; x: number; y: number; w: number; h: number; angle: number; tone: Tone; title?: string }
    | { kind: "line"; points: [number, number][]; closed?: boolean; tone: Tone; title?: string }
    | { kind: "text"; x: number; y: number; text: string; size: number; anchor: "start" | "end"; tone: Tone; title?: string };

/**
 * What a picture shows now: its full size, px; the part of it the zoom
 * shows (x, y, width, height, full size px); the CSS px a picture px takes
 * on the screen; and the CSS px of a rem. Marks meant to keep one size on
 * the screen are sized from it.
 */
export interface PictureShown {
    size: [number, number];
    region: [number, number, number, number];
    scale: number;
    rem: number;
}

/** What the finder said of a spot, as far as a mark needs it: its place from the picture's center, its ellipse and rectangle, whether it was found and how far it was looked for. */
export interface SpotLike {
    dx?: number;
    dy?: number;
    major?: number;
    minor?: number;
    angle?: number;
    rect?: { length: number; width: number; angle: number };
    found?: boolean;
    radius?: number | null;
}

/**
 * The marks of a spot the finder found, about the picture's center: its
 * ellipse, its rectangle, its center, and the circle it was looked for
 * within with the line from the center to it; a miss draws only that
 * circle. `reach` false leaves out the circle and the line, which say how
 * the newest look went and would crowd the picture for older ones.
 */
export function spotMarks(spot: SpotLike | null | undefined, size: [number, number], tone: Tone, reach = true): Mark[] {
    if (!spot) {
        return [];
    }
    const [width, height] = size;
    const cx = width / 2;
    const cy = height / 2;
    const within = spot.radius ?? height / 3;
    const marks: Mark[] = reach ? [{ kind: "circle", x: cx, y: cy, r: within, tone: "ring", title: `looked for within ${formatFixed(within, 0)} px of the center` }] : [];
    if (spot.found === false || spot.dx === undefined || spot.dy === undefined) {
        marks.push({ kind: "circle", x: cx, y: cy, r: Math.min(width, height) / 40, tone: "miss", title: "nothing found" });
        return marks;
    }
    const x = cx + spot.dx;
    const y = cy + spot.dy;
    if (spot.major !== undefined && spot.minor !== undefined && spot.major > 0) {
        marks.push({ kind: "ellipse", x, y, rx: spot.major / 2, ry: spot.minor / 2, angle: spot.angle ?? 0, tone, title: `${formatFixed(spot.major, 1)} by ${formatFixed(spot.minor, 1)} px` });
    }
    if (spot.rect) {
        marks.push({ kind: "rect", x, y, w: spot.rect.length, h: spot.rect.width, angle: spot.rect.angle, tone, title: `${formatFixed(spot.rect.length, 1)} by ${formatFixed(spot.rect.width, 1)} px` });
    }
    const arm = Math.max(4, (spot.minor ?? 8) / 4);
    marks.push({ kind: "line", points: [[x - arm, y], [x + arm, y]], tone });
    marks.push({ kind: "line", points: [[x, y - arm], [x, y + arm]], tone });
    if (reach) {
        marks.push({ kind: "line", points: [[cx, cy], [x, y]], tone });
    }
    return marks;
}

/**
 * The straight edges pcbv found, as marks over a picture `size` px: each
 * from end to end, scaled from the size of the picture pcbv measured when
 * that is another, the strongest first.
 */
export function edgeMarks(edges: CameraEdges, size: [number, number]): Mark[] {
    const sx = edges.width && edges.width > 0 ? size[0] / edges.width : 1;
    const sy = edges.height && edges.height > 0 ? size[1] / edges.height : 1;
    return edges.lines
        .filter((line) => [line.x0, line.y0, line.x1, line.y1].every((value) => Number.isFinite(value)))
        .map((line, index) => {
            const length = line.length ?? Math.hypot(line.x1 - line.x0, line.y1 - line.y0);
            const contrast = line.contrast !== undefined ? `, contrast ${formatFixed(line.contrast, 0)}` : "";
            return {
                kind: "line" as const,
                points: [[line.x0 * sx, line.y0 * sy], [line.x1 * sx, line.y1 * sy]] as [number, number][],
                tone: "edge" as const,
                title: `edge ${index + 1} of ${edges.lines.length}, the strongest first: ${formatFixed(length, 0)} px${contrast}`,
            };
        });
}

/**
 * The marks of what a routine found and holds, in a picture `size` px: the
 * spot it centered (with how it was looked for), the straight edges and
 * the corner they made (scaled from the size of the picture they were
 * found in). Its points on the machine are drawn as known points are.
 */
export function findingMarks(finding: CameraFinding, size: [number, number]): Mark[] {
    const marks: Mark[] = [];
    if (finding.spot) {
        marks.push(...spotMarks(finding.spot, size, "finding"));
    }
    const sx = finding.size && finding.size[0] > 0 ? size[0] / finding.size[0] : 1;
    const sy = finding.size && finding.size[1] > 0 ? size[1] / finding.size[1] : 1;
    for (const line of finding.lines ?? []) {
        if ([line.x0, line.y0, line.x1, line.y1].every((value) => Number.isFinite(value))) {
            marks.push({ kind: "line", points: [[line.x0 * sx, line.y0 * sy], [line.x1 * sx, line.y1 * sy]], tone: "finding", title: "an edge the corner was found from" });
        }
    }
    if (finding.corner) {
        const [x, y] = [finding.corner[0] * sx, finding.corner[1] * sy];
        const arm = Math.min(size[0], size[1]) / 30;
        marks.push({ kind: "circle", x, y, r: arm, tone: "finding", title: "where the edges meet" });
        marks.push({ kind: "line", points: [[x - arm, y], [x + arm, y]], tone: "finding" });
        marks.push({ kind: "line", points: [[x, y - arm], [x, y + arm]], tone: "finding" });
    }
    return marks;
}

/** Whether routines started from a camera's panels hold what they find for the operator to keep (the View menu's setting, on unless switched off, kept per camera). */
export function confirmFindings(key: string): boolean {
    return readStored(`spinny.picture.${key}.confirm`) !== "0";
}

/** A mark moved by `dx`, `dy` px of the picture. */
export function shiftMark(mark: Mark, dx: number, dy: number): Mark {
    if (mark.kind === "line") {
        return { ...mark, points: mark.points.map(([x, y]) => [x + dx, y + dy] as [number, number]) };
    }
    return { ...mark, x: mark.x + dx, y: mark.y + dy };
}

/**
 * How far, px of the picture, what a picture showed has moved in it since
 * the machine place that carries it was `then` and now is `now`: a camera
 * on the head (`rides`) sees the machine move against the head, so the
 * point under its center going from `then` to `now` moves everything seen
 * the other way; a fixed camera sees the nozzle, which moves with the head.
 */
export function followShift(rides: boolean, then: [number, number], now: [number, number], calibration: Calibration): [number, number] {
    const mx = rides ? then[0] - now[0] : now[0] - then[0];
    const my = rides ? then[1] - now[1] : now[1] - then[1];
    return machineToPicture(mx, my, calibration.mmPerPx, calibration.roll, calibration.mirror);
}

/**
 * A spot a camera's state shows now (a routine's newest, a Look once):
 * `key` tells it from every other (a new look gives a new key), `live`
 * says the routine that found it is under way.
 */
export interface ShownSpot {
    key: string;
    spot: SpotLike;
    tone: Tone;
    live?: boolean;
}

/**
 * A spot kept over the picture until Clear marks, with the place that
 * carried what the picture showed when it was found (`at`, null when not
 * known, which keeps it fixed to the picture).
 */
export interface KeptSpot extends ShownSpot {
    at: [number, number] | null;
}

/** Spots a picture keeps at most; the oldest go past it. */
export const MAX_KEPT_SPOTS = 40;

/**
 * The spots kept once the ones a state shows now are taken in: those not
 * seen before join the kept ones, each with the place `at` carries now.
 * With `primed` false (the first state the camera's state is known in)
 * only a routine under way is taken, the rest being looks from before the
 * picture was shown. `seen` gains every key.
 */
export function takeSpots(kept: KeptSpot[], shown: ShownSpot[], seen: Set<string>, primed: boolean, at: [number, number] | null): KeptSpot[] {
    const fresh = shown.filter((entry) => !seen.has(entry.key) && (primed || entry.live === true));
    shown.forEach((entry) => seen.add(entry.key));
    if (fresh.length === 0) {
        return kept;
    }
    const next = [...kept, ...fresh.map((entry) => ({ ...entry, at }))];
    return next.length > MAX_KEPT_SPOTS ? next.slice(next.length - MAX_KEPT_SPOTS) : next;
}

/**
 * The marks of the spots kept, the newest with how it was looked for, each
 * moved by how far what it marks has moved since (`follow`: the place now
 * and the calibration; null keeps them where they were drawn).
 */
export function keptMarks(kept: KeptSpot[], size: [number, number], rides: boolean, follow: { now: [number, number]; calibration: Calibration } | null): Mark[] {
    return kept.flatMap((entry, index) => {
        const marks = spotMarks(entry.spot, size, entry.tone, index === kept.length - 1);
        if (follow === null || entry.at === null) {
            return marks;
        }
        const [dx, dy] = followShift(rides, entry.at, follow.now, follow.calibration);
        return marks.map((mark) => shiftMark(mark, dx, dy));
    });
}

/** Machine points as picture points, the picture's center seeing `center`. */
export function machineToPicturePoints(points: [number, number][], center: [number, number], calibration: Calibration, size: [number, number]): [number, number][] {
    return points.map(([x, y]) => {
        const [dx, dy] = machineToPicture(x - center[0], y - center[1], calibration.mmPerPx, calibration.roll, calibration.mirror);
        return [size[0] / 2 + dx, size[1] / 2 + dy];
    });
}

/**
 * A pick armed on a camera's picture, by the picture's key: the next click
 * on that picture hands `take` the point of the full size picture clicked
 * instead of doing nothing; a box pick takes the next drag instead, as the
 * box it draws (x0, y0, x1, y1 of the full size picture, the first corner
 * up and left) rather than a move of the head.
 */
type Pick =
    | { label: string; box?: false; take: (point: [number, number]) => void }
    | { label: string; box: true; take: (box: [number, number, number, number]) => void };

const picks = new Map<string, Pick>();
const pickWatchers = new Set<() => void>();

/** Arms a pick on the picture of `key` (head, up, top): its next click is handed to `take`; `label` says what is picked. */
export function armPick(key: string, label: string, take: (point: [number, number]) => void): void {
    picks.set(key, { label, take });
    pickWatchers.forEach((watch) => watch());
}

/** Arms a box pick on the picture of `key`: its next drag draws a box, handed to `take` in the full size picture's px; `label` says what the box is drawn around. */
export function armBox(key: string, label: string, take: (box: [number, number, number, number]) => void): void {
    picks.set(key, { label, box: true, take });
    pickWatchers.forEach((watch) => watch());
}

/** Takes an armed pick off the picture of `key`. */
export function disarmPick(key: string): void {
    if (picks.delete(key)) {
        pickWatchers.forEach((watch) => watch());
    }
}

/** What the picture of `key` waits to have picked; null when nothing. */
export function armedPick(key: string): string | null {
    return picks.get(key)?.label ?? null;
}

/** A frame a picture has just shown: its image, the zoom about its center it is shown at, and whether pcbv drew its own marks into it. */
export interface ShownFrame {
    image: HTMLImageElement;
    zoom: number;
    marked?: boolean;
}

const frameWatchers = new Map<string, Set<(frame: ShownFrame) => void>>();

/** Hands `watch` each frame the picture of `key` (head, up, top) shows from now on, so another panel can measure it; the answer stops it. */
export function watchFrames(key: string, watch: (frame: ShownFrame) => void): () => void {
    const watchers = frameWatchers.get(key) ?? new Set<(frame: ShownFrame) => void>();
    frameWatchers.set(key, watchers);
    watchers.add(watch);
    return () => {
        watchers.delete(watch);
    };
}

/** Tells the watchers of the picture of `key` that it shows a new frame. */
export function frameShown(key: string, frame: ShownFrame): void {
    frameWatchers.get(key)?.forEach((watch) => watch(frame));
}

export interface PictureOptions {
    /** Names the picture's kept height, zoom and box: `head`, `up` or `top`. */
    key: string;
    /** The picture in words, for its alternative text and its caption. */
    label: string;
    /** The camera rides on the head (it sees the machine move against it), or is fixed and sees the nozzle. */
    rides: boolean;
    running(state: AppState): boolean;
    frameUrl(width: number, overlay: boolean): string;
    /** pcbv's own overlay is asked for (the board's pose, with a board loaded). */
    pcbvOverlay(state: AppState): boolean;
    /** The picture's full size, px, when known. */
    size(state: AppState): [number, number] | null;
    calibration(state: AppState): Calibration | null;
    /** The camera's roll and whether its picture is mirrored, measured or not, which Upright turns the picture by; left out, no Upright. */
    orientation?(state: AppState): { roll: number; mirror: boolean } | null;
    /** The machine point under the picture's center now; null when not known. */
    center(state: AppState): [number, number] | null;
    /** The page's marks over the picture besides the crosshair, the box, a drag and the spots kept; `shown` is what the picture shows now. */
    marks(state: AppState, shown: PictureShown): Mark[];
    /**
     * The spots the camera's state shows now (its routine's newest, its
     * last Look once), each kept over the picture from when it first shows
     * until Clear marks; null while the camera's state is not known.
     */
    spots?(state: AppState): ShownSpot[] | null;
    /**
     * The machine place that carries what the picture shows, for marks
     * that follow the machine: for a camera on the head the point under the
     * picture's center (`center`, the default), for a fixed camera the
     * head's place (it sees the nozzle); null when not known.
     */
    follow?(state: AppState): [number, number] | null;
    /** The straight edges pcbv finds in the camera's newest picture; given, an Edges switch draws them over the picture while it is on. */
    edges?(): Promise<CameraEdges>;
    /**
     * What a routine of the camera found and holds for the operator, null
     * with none; given with `answer`, the picture draws it and offers Keep
     * and Discard, and the View menu whether routines ask first.
     */
    finding?(state: AppState): CameraFinding | null;
    /** Keeps (true) or discards what was found; its points are on the machine, ringed about `center`. */
    answer?(keep: boolean): Promise<void>;
    /** Moves the head by a step on the machine, mm. */
    move(mm: [number, number]): Promise<void>;
    /** Said when a drag or a double-click needs the scale and there is none. */
    noScale: string;
    /** The picture is in view. */
    visible(): boolean;
    /** Takes a box drawn with Shift and a drag; with none, Shift does nothing. */
    boxes?: boolean;
}

export interface PictureView {
    root: HTMLElement;
    /** The buttons under the picture, where its owner adds its own. */
    caption: HTMLElement;
    render(state: AppState): void;
    refresh(force?: boolean): void;
    /** The search box drawn, machine mm; null when none. */
    box(): MachineBox | null;
    setBox(box: MachineBox | null): void;
    zoom(): number;
    setZoom(next: number): void;
    stop(): void;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function svg(tag: string, attrs: Record<string, string | number>): SVGElement {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) {
        node.setAttribute(name, String(value));
    }
    return node;
}

function readBox(key: string): MachineBox | null {
    try {
        const value = JSON.parse(readStored(key) ?? "null") as unknown;
        if (Array.isArray(value) && value.length === 4 && value.every((v) => typeof v === "number" && Number.isFinite(v))) {
            return value as MachineBox;
        }
    } catch {
        // Nothing kept, or something unreadable: no box.
    }
    return null;
}

/** The root element's font size, px: a rem. */
function remPx(): number {
    const size = parseFloat(globalThis.getComputedStyle?.(document.documentElement).fontSize ?? "");
    return Number.isFinite(size) && size > 0 ? size : 16;
}

export function mountPicture(options: PictureOptions, ctx: Ctx): PictureView {
    const heightKey = `spinny.picture.${options.key}.height`;
    const boxKey = `spinny.picture.${options.key}.box`;
    const overlayKey = `spinny.picture.${options.key}.overlay`;
    const uprightKey = `spinny.picture.${options.key}.upright`;
    const turnKey = `spinny.picture.${options.key}.turn`;
    const crosshairKey = `spinny.picture.${options.key}.crosshair`;
    const crosshairSizeKey = `spinny.picture.${options.key}.crosshair.size`;
    const followKey = `spinny.picture.${options.key}.follow`;
    const confirmKey = `spinny.picture.${options.key}.confirm`;
    const edgesKey = `spinny.picture.${options.key}.edges`;
    let zoom = 1;
    // The edge view: on when switched on (kept per camera), the edges last
    // read and when, and whether a request is out.
    let edgesOn = options.edges !== undefined && readStored(edgesKey) === "1";
    let edgesSeen: CameraEdges | null = null;
    let edgesAsked = 0;
    let edgesOut = false;
    let overlayOn = readStored(overlayKey) !== "0";
    let uprightOn = readStored(uprightKey) !== "0";
    // Marks of what was found move with the machine, staying over what
    // they mark, unless switched off (then they stay where they were drawn).
    let followOn = readStored(followKey) !== "0";
    // The spots found and kept until Clear marks, and every spot's key
    // seen, so one cleared does not come back with the next state.
    let kept: KeptSpot[] = [];
    const seen = new Set<string>();
    let primed = false;
    // Quarters the picture is turned by hand, counterclockwise, over Upright's turn.
    let byHand = readQuarters(readStored(turnKey));
    let crosshair = readCrosshair(readStored(crosshairKey), readStored(crosshairSizeKey));
    // The turn the picture is shown at, set at each fit.
    let turn: Turn = UNTURNED;
    let searchBox: MachineBox | null = options.boxes ? readBox(boxKey) : null;
    let held: number | null = (() => {
        const value = parseFloat(readStored(heightKey) ?? "");
        return Number.isFinite(value) ? Math.max(MIN_BOX_REM, Math.min(MAX_BOX_REM, value)) : null;
    })();

    const picture = el("img", { class: "picture-img", alt: `${options.label} picture`, draggable: "false" }) as HTMLImageElement;
    const layer = svg("svg", { class: "picture-marks", preserveAspectRatio: "none", "aria-hidden": "true" }) as SVGSVGElement;
    const stage = el("div", { class: "picture-stage" }, picture, layer);
    const box = el("div", { class: "picture-box", "data-camera": options.key }, stage);
    const grip = el("div", { class: "picture-grip", role: "separator", "aria-label": `${options.label} picture height`, title: "drag to make the picture's box taller or shorter; double-click for the picture's own shape" });
    // The zoom as a field: typed (2.5, or 5/2) and taken on Enter or on
    // leaving it; the buttons and the wheel write theirs into it.
    const zoomField = numberField({ value: 1, min: ZOOMS[0], max: ZOOMS[ZOOMS.length - 1], step: 0.5, width: "3.5rem" });
    zoomField.setAttribute("aria-label", `${options.label} zoom`);
    zoomField.title = `zoom, ${ZOOMS[0]} to ${ZOOMS[ZOOMS.length - 1]} times: type one and press Enter`;
    const out = button("-", () => step(-1), "btn btn-quiet btn-small");
    out.title = "zoom out (or Ctrl and the wheel)";
    const into = button("+", () => step(1), "btn btn-quiet btn-small");
    into.title = "zoom in (or Ctrl and the wheel)";
    // The field and its - and + as one box, the zoom's x inside it.
    const zoomLine = stepperBox(zoomField, out, into, "x");
    zoomLine.classList.add("picture-zoom");
    const overlay = button("Overlay", () => {
        overlayOn = !overlayOn;
        writeStored(overlayKey, overlayOn ? "1" : "0");
        overlay.setAttribute("aria-pressed", overlayOn ? "true" : "false");
        draw(ctx.store.get());
        refresh(true);
    }, "btn btn-quiet btn-small btn-toggle");
    overlay.title = "the page's marks over the picture, and pcbv's pose of a board loaded";
    overlay.setAttribute("aria-pressed", overlayOn ? "true" : "false");
    const upright = button("Upright", () => {
        uprightOn = !uprightOn;
        writeStored(uprightKey, uprightOn ? "1" : "0");
        upright.setAttribute("aria-pressed", uprightOn ? "true" : "false");
        fit();
        draw(ctx.store.get());
        refresh(true);
    }, "btn btn-quiet btn-small btn-toggle");
    upright.setAttribute("aria-pressed", uprightOn ? "true" : "false");
    upright.title = "show the picture turned by the camera's roll so the machine's +X points right and +Y up";
    const reset = button("Reset view", () => setZoom(1), "btn btn-quiet btn-small", "back to the whole picture filling its box (zoom 1)");
    const turnButton = button("Turn", () => turnBy(-1), "btn btn-quiet btn-small");
    const view = button("View", () => openView(), "btn btn-quiet btn-small", "the crosshair's shape and size, and whether marks follow the machine");
    view.setAttribute("aria-haspopup", "menu");
    const clearMarks = button("Clear marks", () => {
        kept = [];
        draw(ctx.store.get());
    }, "btn btn-quiet btn-small", "take away the spots routines and Look once found: they stay over the picture until this");
    const EDGES_TITLE = "draw the straight edges pcbv finds in the picture (what Corner by edges reads), asked once a second while on";
    const edgesButton = button("Edges", () => {
        edgesOn = !edgesOn;
        writeStored(edgesKey, edgesOn ? "1" : "0");
        edgesButton.setAttribute("aria-pressed", edgesOn ? "true" : "false");
        edgesSeen = null;
        edgesButton.title = EDGES_TITLE;
        draw(ctx.store.get());
        askEdges(true);
    }, "btn btn-quiet btn-small btn-toggle", EDGES_TITLE);
    edgesButton.setAttribute("aria-pressed", edgesOn ? "true" : "false");
    const boxLine = el("span", { class: "muted picture-box-line" });
    const clearBox = button("Clear box", () => setBox(null), "btn btn-quiet btn-small");
    clearBox.title = "forget the box: a search then covers the board's size about where the picture is";
    const growView = button("Add view", () => addView(), "btn btn-quiet btn-small");
    growView.title = "grow the search box to take in what the picture shows now (jog to the far corner and press again)";
    const pickLine = el("span", { class: "muted picture-pick hidden" });
    const cancelPick = button("Cancel", () => disarmPick(options.key), "btn btn-quiet btn-small");
    cancelPick.title = "pick nothing";
    const pickRow = el("div", { class: "button-row picture-pick-row hidden" }, pickLine, cancelPick);
    // What a routine found and holds: its words, Keep and Discard.
    const findingLine = el("span", { class: "picture-finding-text" });
    const keepFinding = button("Keep", () => answerFinding(true), "btn btn-primary btn-small", "keep what was found, as the routine would have without asking");
    const discardFinding = button("Discard", () => answerFinding(false), "btn btn-quiet btn-small", "drop what was found: nothing is kept");
    const findingRow = el("div", { class: "button-row picture-finding hidden" }, findingLine, keepFinding, discardFinding);
    // Where the finding shown first showed, by its words and marks, for its marks to follow the machine.
    let findingSeen: { key: string; at: [number, number] | null } | null = null;
    const caption = el("div", { class: "button-row picture-caption" }, zoomLine, reset, turnButton);
    if (options.orientation) {
        caption.append(upright);
    }
    caption.append(overlay);
    if (options.edges) {
        caption.append(edgesButton);
    }
    caption.append(clearMarks, view);
    /** The picture waits for a pick: a crosshair, and a line saying what for. */
    const showPick = (): void => {
        const label = armedPick(options.key);
        stage.classList.toggle("picking", label !== null);
        pickRow.classList.toggle("hidden", label === null);
        pickLine.classList.toggle("hidden", label === null);
        pickLine.textContent = label === null ? "" : picks.get(options.key)?.box ? `Drag a box on the picture around ${label}.` : `Click the picture where ${label}.`;
    };
    pickWatchers.add(showPick);
    if (options.boxes) {
        caption.append(growView, clearBox, boxLine);
    }
    const root = el("figure", { class: "picture-view" }, box, grip, pickRow, findingRow, caption);

    // --- sizing ------------------------------------------------------------------

    function fullSize(state: AppState): [number, number] {
        const size = options.size(state);
        if (size && size[0] > 0 && size[1] > 0) {
            return size;
        }
        return [picture.naturalWidth || 1280, picture.naturalHeight || 720];
    }

    /** The turn the picture is shown at now: Upright's, then the turn by hand. */
    function turnOf(state: AppState): Turn {
        const orientation = uprightOn ? options.orientation?.(state) ?? null : null;
        return addTurn(orientation ? uprightTurn(orientation.roll, orientation.mirror) : UNTURNED, byHand);
    }

    /** The turn and the buttons' words about it. */
    function setTurn(state: AppState): void {
        turn = turnOf(state);
        stage.style.transform = turnTransform(turn);
        const orientation = options.orientation?.(state) ?? null;
        const would = orientation ? uprightTurn(orientation.roll, orientation.mirror) : UNTURNED;
        const steps = [would.quarter !== 0 ? `turned ${90 * would.quarter} degrees counterclockwise` : "", would.flip ? "flipped left for right" : ""].filter((part) => part !== "");
        const how = steps.length > 0 ? steps.join(", ") : "the camera's picture is upright already";
        upright.title = `show the picture turned by the camera's roll so the machine's +X points right and +Y up (${how})`;
        // The turn by hand as clockwise degrees, the way the button turns it.
        const clockwise = (4 - byHand) % 4;
        turnButton.title = clockwise === 0
            ? "turn the picture a quarter clockwise, over any Upright turn (kept for this camera)"
            : `turn the picture a quarter clockwise; it is turned ${90 * clockwise} degrees clockwise by hand now (kept for this camera)`;
        turnButton.setAttribute("aria-pressed", byHand !== 0 ? "true" : "false");
    }

    /** Turns the picture by hand by `quarters` counterclockwise (negative: clockwise), kept for the camera. */
    function turnBy(quarters: number): void {
        byHand = addTurn({ quarter: byHand, flip: false }, quarters).quarter;
        writeStored(turnKey, String(byHand));
        fit();
        draw(ctx.store.get());
        refresh(true);
    }

    /** The View menu: the crosshair's shape and size. */
    function openView(): void {
        const pickShape = (shape: CrosshairShape) => (): void => {
            crosshair = { ...crosshair, shape };
            writeStored(crosshairKey, shape);
            draw(ctx.store.get());
        };
        const pickSize = (size: CrosshairSize) => (): void => {
            crosshair = { ...crosshair, size };
            writeStored(crosshairSizeKey, size);
            draw(ctx.store.get());
        };
        openMenu([
            ...CROSSHAIR_SHAPES.map((entry) => ({ label: entry.label, run: pickShape(entry.value), checked: crosshair.shape === entry.value })),
            "-",
            ...CROSSHAIR_SIZES.map((entry) => ({ label: entry.label, run: pickSize(entry.value), checked: crosshair.size === entry.value })),
            "-",
            {
                label: "Marks follow the machine",
                run: () => {
                    followOn = !followOn;
                    writeStored(followKey, followOn ? "1" : "0");
                    draw(ctx.store.get());
                },
                checked: followOn,
            },
            ...(options.finding ? [{
                label: "Ask before keeping what routines find",
                run: () => writeStored(confirmKey, confirmFindings(options.key) ? "0" : "1"),
                checked: confirmFindings(options.key),
            }] : []),
        ], view, `${options.label} view`);
    }

    /** Keeps or discards what was found, then draws what is left. */
    async function answerFinding(keep: boolean): Promise<void> {
        await options.answer?.(keep);
        draw(ctx.store.get());
    }

    /** The place that carries what the picture shows now. */
    function followPlace(state: AppState): [number, number] | null {
        return options.follow ? options.follow(state) : options.center(state);
    }

    /** The row offering Keep and Discard for what a routine found, with its words, shown while it waits; the place that carries the picture kept from when it first showed. */
    function showFinding(state: AppState): void {
        const finding = options.finding?.(state) ?? null;
        findingRow.classList.toggle("hidden", finding === null);
        if (finding === null) {
            findingSeen = null;
            return;
        }
        findingLine.textContent = `Found: ${finding.text}. Keep it?`;
        const key = JSON.stringify(finding);
        if (findingSeen === null || findingSeen.key !== key) {
            findingSeen = { key, at: followPlace(state) };
        }
    }

    /** The marks of what a routine found and holds, moved with the machine as the spots kept are, its points ringed where they are on it. */
    function shownFinding(state: AppState, shown: PictureShown, now: [number, number] | null, calibration: Calibration | null): Mark[] {
        const finding = options.finding?.(state) ?? null;
        if (finding === null || findingSeen === null) {
            return [];
        }
        let marks = findingMarks(finding, shown.size);
        if (followOn && findingSeen.at !== null && now !== null && calibration !== null) {
            const [dx, dy] = followShift(options.rides, findingSeen.at, now, calibration);
            marks = marks.map((mark) => shiftMark(mark, dx, dy));
        }
        const points = (finding.points ?? []).map((point) => ({ at: point.at, label: point.label, title: `${point.label}, as found: Keep takes it` }));
        return [...marks, ...knownMarks(points, options.center(state), calibration, shown, "finding")];
    }

    /** Takes in the spots the state shows that were not seen before, with the place that carries them now. */
    function takeShown(state: AppState): void {
        const shown = options.spots?.(state) ?? null;
        if (shown === null) {
            return;
        }
        kept = takeSpots(kept, shown, seen, primed, followPlace(state));
        primed = true;
    }

    /**
     * The box at its kept height or the shape of the picture as shown, and
     * the stage fitted inside it: laid out in the picture's own shape and
     * turned about its center, so a quarter turn stands it on its side.
     */
    function fit(): void {
        const state = ctx.store.get();
        setTurn(state);
        const [width, height] = fullSize(state);
        const sideways = turn.quarter % 2 === 1;
        const [seenWidth, seenHeight] = sideways ? [height, width] : [width, height];
        if (held === null) {
            box.style.height = "";
            box.style.aspectRatio = `${seenWidth} / ${seenHeight}`;
        } else {
            box.style.aspectRatio = "";
            box.style.height = `${held}rem`;
        }
        const rect = box.getBoundingClientRect();
        if (!(rect.width > 0) || !(rect.height > 0)) {
            Object.assign(stage.style, { left: "0", top: "0", width: "100%", height: "100%" });
            return;
        }
        const shown = Math.min(rect.width, rect.height * (seenWidth / seenHeight));
        const shownHeight = shown * (seenHeight / seenWidth);
        const [stageWidth, stageHeight] = sideways ? [shownHeight, shown] : [shown, shownHeight];
        stage.style.width = `${(100 * stageWidth) / rect.width}%`;
        stage.style.height = `${(100 * stageHeight) / rect.height}%`;
        stage.style.left = `${(100 * (rect.width - stageWidth)) / 2 / rect.width}%`;
        stage.style.top = `${(100 * (rect.height - stageHeight)) / 2 / rect.height}%`;
    }

    /** The stage's own width and height on the screen, CSS px, before its turn: its bounding box's, the other way about when on its side. */
    function stageSize(): [number, number] {
        const rect = stage.getBoundingClientRect();
        return turn.quarter % 2 === 1 ? [rect.height, rect.width] : [rect.width, rect.height];
    }

    // A rem in CSS px, read once and again at each resize: marks sized to
    // the screen need it at every draw, ten times a second.
    let rem = 0;
    const Observer = globalThis.ResizeObserver;
    const observer = Observer ? new Observer(() => {
        rem = 0;
        fit();
        draw(ctx.store.get());
        refresh(false);
    }) : null;
    observer?.observe(box);

    let gripFrom: { y: number; height: number } | null = null;
    grip.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) {
            return;
        }
        gripFrom = { y: event.clientY, height: box.getBoundingClientRect().height };
        grip.setPointerCapture?.(event.pointerId);
        event.preventDefault();
    });
    grip.addEventListener("pointermove", (event) => {
        if (gripFrom === null) {
            return;
        }
        held = Math.max(MIN_BOX_REM, Math.min(MAX_BOX_REM, (gripFrom.height + event.clientY - gripFrom.y) / remPx()));
        fit();
        draw(ctx.store.get());
    });
    grip.addEventListener("pointerup", () => {
        if (gripFrom !== null && held !== null) {
            writeStored(heightKey, held.toFixed(2));
        }
        gripFrom = null;
        refresh(true);
    });
    grip.addEventListener("dblclick", () => {
        held = null;
        writeStored(heightKey, "");
        fit();
        refresh(true);
    });

    // --- zoom --------------------------------------------------------------------

    /** Zooms to `next`, held within the steps' range; a zoom it already has only puts its words back in the field. */
    function setZoom(next: number): void {
        const value = clampZoom(next) ?? zoom;
        zoomField.value = zoomText(value);
        zoomField.classList.remove("invalid");
        zoomField.removeAttribute("aria-invalid");
        if (value === zoom) {
            return;
        }
        zoom = value;
        picture.style.transform = `scale(${zoom})`;
        draw(ctx.store.get());
        refresh(true);
    }

    function step(direction: 1 | -1): void {
        setZoom(stepZoom(zoom, direction));
    }

    /** Takes the zoom typed in; a field that holds no number gets the zoom back. */
    function typedZoom(): void {
        setZoom(parseNumber(zoomField.value.trim()) ?? zoom);
    }
    zoomField.addEventListener("change", typedZoom);
    zoomField.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            typedZoom();
        } else if (event.key === "Escape") {
            setZoom(zoom);
        }
    });

    // The plain wheel scrolls the page; Ctrl and the wheel (a pinch on a
    // touchpad) zooms the picture.
    box.addEventListener("wheel", (event) => {
        if (!event.ctrlKey) {
            return;
        }
        event.preventDefault();
        step(event.deltaY < 0 ? 1 : -1);
    }, { passive: false });

    // --- the pointer ----------------------------------------------------------------

    /** A pointer's place as a point of the full size picture, the turn and the zoom about its center undone. */
    function pictureAt(clientX: number, clientY: number): [number, number] {
        const rect = stage.getBoundingClientRect();
        const [width, height] = fullSize(ctx.store.get());
        const [stageWidth, stageHeight] = stageSize();
        const [x, y] = unturnOffset(clientX - (rect.left + rect.width / 2), clientY - (rect.top + rect.height / 2), turn);
        const fx = stageWidth > 0 ? x / stageWidth : 0;
        const fy = stageHeight > 0 ? y / stageHeight : 0;
        return [width / 2 + (fx * width) / zoom, height / 2 + (fy * height) / zoom];
    }

    // A press: where it began and is now, and whether it draws a box (a
    // search box with Shift, or the box an armed box pick waits for).
    let press: { from: [number, number]; to: [number, number]; client: [number, number]; boxing: boolean } | null = null;
    stage.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) {
            return;
        }
        const at = pictureAt(event.clientX, event.clientY);
        const boxPick = picks.get(options.key)?.box === true;
        press = { from: at, to: at, client: [event.clientX, event.clientY], boxing: boxPick || (event.shiftKey && options.boxes === true) };
        stage.setPointerCapture?.(event.pointerId);
        stage.classList.add(press.boxing ? "boxing" : "dragging");
    });
    stage.addEventListener("pointermove", (event) => {
        if (press === null) {
            return;
        }
        press.to = pictureAt(event.clientX, event.clientY);
        draw(ctx.store.get());
    });
    const release = (event: PointerEvent): void => {
        stage.classList.remove("dragging", "boxing");
        const done = press;
        press = null;
        if (done === null) {
            return;
        }
        done.to = pictureAt(event.clientX, event.clientY);
        draw(ctx.store.get());
        // A press that barely moved is a click: an armed pick takes it,
        // else the double-click handles it. A box pick waits for a drag.
        const pick = picks.get(options.key);
        if (Math.hypot(event.clientX - done.client[0], event.clientY - done.client[1]) < 4) {
            if (pick && !pick.box) {
                disarmPick(options.key);
                pick.take(done.from);
            }
            return;
        }
        if (pick?.box) {
            disarmPick(options.key);
            pick.take([Math.min(done.from[0], done.to[0]), Math.min(done.from[1], done.to[1]), Math.max(done.from[0], done.to[0]), Math.max(done.from[1], done.to[1])]);
            return;
        }
        const state = ctx.store.get();
        const calibration = options.calibration(state);
        if (calibration === null) {
            ctx.toast("info", options.noScale);
            return;
        }
        if (done.boxing) {
            const center = options.center(state);
            if (center === null) {
                ctx.toast("info", "the head's place is not known: jog it, or read the position, then draw the box");
                return;
            }
            const [width, height] = fullSize(state);
            const corners = [done.from, [done.from[0], done.to[1]], done.to, [done.to[0], done.from[1]]].map(([x, y]) => {
                const [mx, my] = pictureToMachine(x! - width / 2, y! - height / 2, calibration.mmPerPx, calibration.roll, calibration.mirror);
                return [center[0] + mx, center[1] + my] as [number, number];
            });
            const xs = corners.map(([x]) => x);
            const ys = corners.map(([, y]) => y);
            setBox([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
            return;
        }
        void options.move(dragMove(options.rides, done.to[0] - done.from[0], done.to[1] - done.from[1], calibration));
    };
    stage.addEventListener("pointerup", release);
    stage.addEventListener("pointercancel", () => {
        press = null;
        stage.classList.remove("dragging", "boxing");
        draw(ctx.store.get());
    });
    stage.addEventListener("dblclick", (event) => {
        const state = ctx.store.get();
        const calibration = options.calibration(state);
        if (calibration === null) {
            ctx.toast("info", options.noScale);
            return;
        }
        const [width, height] = fullSize(state);
        const [x, y] = pictureAt(event.clientX, event.clientY);
        // The point clicked comes to the center: against the drag's sense.
        const [mx, my] = dragMove(options.rides, x - width / 2, y - height / 2, calibration);
        void options.move([-mx, -my]);
    });

    // --- the box -------------------------------------------------------------------

    function setBox(next: MachineBox | null): void {
        searchBox = next;
        writeStored(boxKey, next === null ? "" : JSON.stringify(next.map((value) => Math.round(value * 1000) / 1000)));
        draw(ctx.store.get());
    }

    /** The box grown to take in the picture's view now. */
    function addView(): void {
        const state = ctx.store.get();
        const calibration = options.calibration(state);
        const center = options.center(state);
        if (calibration === null || center === null) {
            ctx.toast("info", "the camera's scale and the head's place are needed to know what the picture shows");
            return;
        }
        const [width, height] = fullSize(state);
        const corners = [[0, 0], [width, 0], [width, height], [0, height]].map(([x, y]) => {
            const [mx, my] = pictureToMachine(x! - width / 2, y! - height / 2, calibration.mmPerPx, calibration.roll, calibration.mirror);
            return [center[0] + mx, center[1] + my];
        });
        const xs = corners.map(([x]) => x!);
        const ys = corners.map(([, y]) => y!);
        setBox(growBox(searchBox, [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]));
    }

    // --- drawing ------------------------------------------------------------------------

    function shape(mark: Mark): SVGElement {
        let node: SVGElement;
        switch (mark.kind) {
            case "circle":
                node = svg("circle", { cx: mark.x, cy: mark.y, r: Math.max(mark.r, 0.01) });
                break;
            case "ellipse":
                node = svg("ellipse", { cx: mark.x, cy: mark.y, rx: Math.max(mark.rx, 0.01), ry: Math.max(mark.ry, 0.01), transform: `rotate(${mark.angle} ${mark.x} ${mark.y})` });
                break;
            case "rect":
                node = svg("rect", { x: mark.x - mark.w / 2, y: mark.y - mark.h / 2, width: Math.max(mark.w, 0.01), height: Math.max(mark.h, 0.01), transform: `rotate(${mark.angle} ${mark.x} ${mark.y})` });
                break;
            case "line":
                node = svg(mark.closed ? "polygon" : "polyline", { points: mark.points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ") });
                break;
            case "text":
                // The halo under the letters is a stroke a quarter of the
                // font wide, so the words read on a light or a dark picture.
                node = svg("text", { x: mark.x.toFixed(2), y: mark.y.toFixed(2), "font-size": mark.size.toFixed(3), "text-anchor": mark.anchor, "stroke-width": (mark.size / 4).toFixed(3) });
                {
                    const level = levelText(mark.x, mark.y, turn);
                    if (level !== null) {
                        node.setAttribute("transform", level);
                    }
                }
                node.textContent = mark.text;
                node.setAttribute("class", `mark-label mark-label-${mark.tone}`);
                return node;
        }
        node.setAttribute("class", `mark mark-${mark.tone}`);
        if (mark.title) {
            const title = document.createElementNS(SVG_NS, "title");
            title.textContent = mark.title;
            node.append(title);
        }
        return node;
    }

    function draw(state: AppState): void {
        takeShown(state);
        showFinding(state);
        const [width, height] = fullSize(state);
        // The view box is the part of the picture the zoom shows, so a mark
        // lands where the zoomed picture shows its point.
        const shownWidth = width / zoom;
        const shownHeight = height / zoom;
        layer.setAttribute("viewBox", `${(width / 2 - shownWidth / 2).toFixed(3)} ${(height / 2 - shownHeight / 2).toFixed(3)} ${shownWidth.toFixed(3)} ${shownHeight.toFixed(3)}`);
        const marks: Mark[] = [];
        if (overlayOn && options.running(state)) {
            marks.push(...crosshairMarks(crosshair.shape, crosshair.size, width / 2, height / 2, shownWidth, shownHeight));
            // A stage not laid out yet is taken as wide as an unknown one
            // is asked for; the observer draws again once it is.
            const screen = stageSize()[0] || box.getBoundingClientRect().width || 640;
            const shown: PictureShown = {
                size: [width, height],
                region: [width / 2 - shownWidth / 2, height / 2 - shownHeight / 2, shownWidth, shownHeight],
                scale: screen / shownWidth,
                rem: rem || (rem = remPx()),
            };
            marks.push(...options.marks(state, shown));
            const now = followPlace(state);
            const calibrated = options.calibration(state);
            marks.push(...keptMarks(kept, [width, height], options.rides, followOn && now !== null && calibrated !== null ? { now, calibration: calibrated } : null));
            marks.push(...shownFinding(state, shown, now, calibrated));
        }
        setLocked(clearMarks, kept.length === 0, "no spots found are kept over the picture");
        if (edgesOn && edgesSeen !== null && options.running(state)) {
            marks.push(...edgeMarks(edgesSeen, [width, height]));
        }
        const calibration = options.calibration(state);
        const center = options.center(state);
        if (searchBox !== null && calibration !== null && center !== null) {
            const [x0, y0, x1, y1] = searchBox;
            marks.push({ kind: "line", points: machineToPicturePoints([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], center, calibration, [width, height]), closed: true, tone: "box", title: "the box a search keeps to" });
        }
        if (press !== null) {
            const [a, b] = [press.from, press.to];
            marks.push(press.boxing
                ? { kind: "line", points: [a, [a[0], b[1]], b, [b[0], a[1]]], closed: true, tone: "box" }
                : { kind: "line", points: [a, b], tone: "drag" });
            if (!press.boxing) {
                marks.push({ kind: "circle", x: a[0], y: a[1], r: shownWidth / 150, tone: "drag" });
            }
        }
        layer.replaceChildren(...marks.map(shape));
        boxLine.textContent = searchBox === null
            ? "Shift and a drag on the picture draw a search box"
            : `search box X ${formatFixed(searchBox[0], 1)} to ${formatFixed(searchBox[2], 1)}, Y ${formatFixed(searchBox[1], 1)} to ${formatFixed(searchBox[3], 1)}`;
        clearBox.classList.toggle("hidden", searchBox === null);
    }

    // --- the frames ---------------------------------------------------------------------

    let last = 0;
    // Whether the frame asked for last has pcbv's marks drawn into it: a
    // new address drops the load of the one before, so the frame that
    // loads is that one.
    let marked = false;
    function refresh(force = false): void {
        const state = ctx.store.get();
        if (!options.visible() || !options.running(state)) {
            return;
        }
        const now = Date.now();
        if (!force && now - last < FRAME_INTERVAL_MS - 10) {
            return;
        }
        last = now;
        const shown = stageSize()[0] || box.getBoundingClientRect().width || 640;
        const size = options.size(state);
        const width = frameRequestWidth(shown, globalThis.devicePixelRatio ?? 1, zoom, size ? size[0] : null);
        marked = overlayOn && options.pcbvOverlay(state);
        picture.src = options.frameUrl(width, marked);
        askEdges();
    }

    /** Asks for the edges in the picture now, at most once an interval and one at a time, while the edge view is on and the picture shows. */
    function askEdges(force = false): void {
        const state = ctx.store.get();
        if (!edgesOn || !options.edges || edgesOut || !options.visible() || !options.running(state)) {
            return;
        }
        const now = Date.now();
        if (!force && now - edgesAsked < EDGES_INTERVAL_MS - 10) {
            return;
        }
        edgesAsked = now;
        edgesOut = true;
        options.edges().then((edges) => {
            edgesSeen = edgesOn ? edges : null;
            edgesButton.title = EDGES_TITLE;
        }, (error: unknown) => {
            edgesSeen = null;
            edgesButton.title = `${EDGES_TITLE}; the last ask failed: ${errorText(error)}`;
        }).finally(() => {
            edgesOut = false;
            draw(ctx.store.get());
        });
    }
    const timer = setInterval(() => refresh(), FRAME_INTERVAL_MS);
    picture.addEventListener("load", () => {
        fit();
        frameShown(options.key, { image: picture, zoom, marked });
    });

    function render(state: AppState): void {
        const running = options.running(state);
        root.classList.toggle("hidden", !running);
        if (!running) {
            picture.removeAttribute("src");
        }
        fit();
        draw(state);
        refresh();
    }

    return {
        root,
        caption,
        render,
        refresh,
        box: () => searchBox,
        setBox,
        zoom: () => zoom,
        setZoom,
        stop() {
            clearInterval(timer);
            observer?.disconnect();
            pickWatchers.delete(showPick);
        },
    };
}
