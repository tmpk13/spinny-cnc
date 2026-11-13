// The PNP page: the parts of the selected board job in a list (sorted by
// any column, grouped by value and footprint) and on a drawing of the
// board that zooms and pans; a board picked or uploaded right here; the
// jog of the machine connected; the cameras' pictures; the up camera's
// settings with where it sits on the machine; and when the machine is a
// G-code one (its file says controller = "gcode") its panels for placing:
// the head, the top camera, the board's place on it, the feeders, and the
// run. Its own setup steps lead through all of it.

import { activePage, button, el, labeled, lockFor, numberField, readStored, replace, resizableBox, setLocked, Tracked, writeStored } from "../dom.ts";
import { formatFixed, formatPercent, parseNumber } from "../format.ts";
import { isCartesian } from "../profile.ts";
import { setPending, type AppState } from "../state.ts";
import type { BoardLook, Component, Job, PnpSettings, PnpState, SpotPolarity } from "../types.ts";
import { mountCameraControls } from "./cameracontrols.ts";
import { mountCameraSight } from "./camerasight.ts";
import { mountCameraPick } from "./camerapick.ts";
import { mountCameraLog } from "./camlog.ts";
import { mountCameraViews } from "./camview.ts";
import { into, type Ctx } from "./context.ts";
import { mountFindBoard, shownGuesses } from "./findboard.ts";
import { PLACING_SETUP, gcodePlacing, mountHead, upCameraText } from "./placing.ts";
import { keptOut, mountPartsFilter, pickedToPlace, readShowKeptOut, setPickedToPlace, shownParts, writeShowKeptOut } from "./partsfilter.ts";
import { mountBoardSearch } from "./partsearch.ts";
import { mountPnpFeeders } from "./pnpfeeders.ts";
import { mountPnpRefs } from "./pnprefs.ts";
import { mountPnpRun } from "./pnprun.ts";
import { infoTip } from "./infotip.ts";
import { mountJog } from "./jog.ts";
import { connectStep, mountSteps, type Setup } from "./steps.ts";
import type { MachineBox } from "./picture.ts";
import { mountTopCamera } from "./topcamera.ts";

const SIDE_KEY = "spinny.pnp.side";
const SORT_KEY = "spinny.pnp.sort";
const GROUP_KEY = "spinny.pnp.group";

/** How often the up camera's state is asked for while the page shows, ms. */
const POLL_MS = 500;

export type Side = "all" | "front" | "back";

/** The side the list starts on: the one picked before, else the front, where parts are placed. */
export function readSide(): Side {
    const stored = readStored(SIDE_KEY);
    return stored === "all" || stored === "back" ? stored : "front";
}

/** The parts that match a filter (ref, value or footprint, any case) on a side. */
export function filterParts(parts: Component[], text: string, side: Side): Component[] {
    const words = text.trim().toLowerCase().split(/\s+/).filter((word) => word !== "");
    return parts.filter((part) => {
        if (side !== "all" && part.side !== side) {
            return false;
        }
        const hay = `${part.ref} ${part.value} ${part.footprint}`.toLowerCase();
        return words.every((word) => hay.includes(word));
    });
}

/** A footprint's name without its library. */
export function footprintName(footprint: string): string {
    const at = footprint.indexOf(":");
    return at >= 0 ? footprint.slice(at + 1) : footprint;
}

export type SortKey = "ref" | "value" | "footprint" | "x" | "y" | "rotation" | "side";

/** Text compared the way people count: R2 before R10. */
export function naturalCompare(a: string, b: string): number {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/** The parts sorted by a column, ties by reference; `descending` turns the order round. */
export function sortParts(parts: Component[], key: SortKey, descending = false): Component[] {
    const sorted = [...parts].sort((a, b) => {
        let order: number;
        switch (key) {
            case "x":
            case "y":
            case "rotation":
                order = a[key] - b[key];
                break;
            case "footprint":
                order = naturalCompare(footprintName(a.footprint), footprintName(b.footprint));
                break;
            default:
                order = naturalCompare(String(a[key]), String(b[key]));
        }
        return order !== 0 ? order : naturalCompare(a.ref, b.ref);
    });
    return descending ? sorted.reverse() : sorted;
}

/** The parts grouped by value and footprint, in the order of their first part. */
export function groupParts(parts: Component[]): { key: string; value: string; footprint: string; parts: Component[] }[] {
    const groups = new Map<string, { key: string; value: string; footprint: string; parts: Component[] }>();
    for (const part of parts) {
        const key = JSON.stringify([part.value, part.footprint]);
        let group = groups.get(key);
        if (!group) {
            group = { key, value: part.value, footprint: part.footprint, parts: [] };
            groups.set(key, group);
        }
        group.parts.push(part);
    }
    return [...groups.values()];
}

/** The up camera's place on the board: its joints turned by the table's angle, as a cartesian machine's board frame is. */
export function cameraOnBoard(position: [number, number] | null, angle: number): { x: number; y: number } | null {
    if (position === null) {
        return null;
    }
    const radians = (angle * Math.PI) / 180;
    const [r, z] = position;
    return { x: r * Math.cos(radians) - z * Math.sin(radians), y: r * Math.sin(radians) + z * Math.cos(radians) };
}

export interface Box {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

/** The box the board drawing shows: the outline, the pads, the parts and the markers given, with a margin; null for nothing. */
export function drawingBox(job: Job | null, parts: Component[], marks: { x: number; y: number }[], margin = 3): Box | null {
    let box: Box | null = null;
    const take = (x: number, y: number): void => {
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return;
        }
        box = box === null ? { x0: x, y0: y, x1: x, y1: y } : { x0: Math.min(box.x0, x), y0: Math.min(box.y0, y), x1: Math.max(box.x1, x), y1: Math.max(box.y1, y) };
    };
    for (const path of job?.outline ?? []) {
        for (const [x, y] of path) {
            take(x, y);
        }
    }
    for (const [x, y] of job?.pads ?? []) {
        take(x, y);
    }
    for (const part of parts) {
        take(part.x, part.y);
    }
    for (const mark of marks) {
        take(mark.x, mark.y);
    }
    const found = box as Box | null;
    return found === null ? null : { x0: found.x0 - margin, y0: found.y0 - margin, x1: found.x1 + margin, y1: found.y1 + margin };
}

const SVG_NS = "http://www.w3.org/2000/svg";

function svg(tag: string, attrs: Record<string, string | number>, ...children: (SVGElement | string)[]): SVGElement {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) {
        node.setAttribute(name, String(value));
    }
    for (const child of children) {
        node.append(child);
    }
    return node;
}

export interface BoardScene {
    job: Job | null;
    parts: Component[];
    selected: string | null;
    camera: { x: number; y: number } | null;
}

/**
 * The board drawing: outline, pads, every part as a dot with its reference
 * (its value and footprint on hover), and the up camera; y up. The head is
 * drawn into it by `placeHead`, which follows the machine without drawing
 * the board again.
 */
export function boardSvg(scene: BoardScene, onPick: (ref: string) => void): { root: SVGElement; box: Box } | null {
    const box = drawingBox(scene.job, scene.parts, scene.camera ? [scene.camera] : []);
    if (box === null) {
        return null;
    }
    const width = box.x1 - box.x0;
    const height = box.y1 - box.y0;
    const size = Math.max(width, height);
    const sx = (x: number): string => (x - box.x0).toFixed(3);
    const sy = (y: number): string => (box.y1 - y).toFixed(3);
    const root = svg("svg", { class: "pnp-board", viewBox: `0 0 ${width.toFixed(3)} ${height.toFixed(3)}`, role: "img", "aria-label": "The board with its parts" });
    for (const path of scene.job?.outline ?? []) {
        root.append(svg("polyline", { class: "pnp-outline", points: path.map(([x, y]) => `${sx(x)},${sy(y)}`).join(" ") }));
    }
    for (const [x, y, area] of scene.job?.pads ?? []) {
        const side = Math.sqrt(Math.max(area, 0.01));
        root.append(svg("rect", { class: "pnp-pad", x: sx(x - side / 2), y: sy(y + side / 2), width: side.toFixed(3), height: side.toFixed(3) }));
    }
    const dot = size / 140;
    const text = size / 45;
    for (const part of scene.parts) {
        const chosen = part.ref === scene.selected;
        const group = svg("g", { class: `pnp-part${chosen ? " selected" : ""}${part.side === "back" ? " back" : ""}${part.dnp ? " dnp" : ""}${keptOut(part) ? " kept-out" : ""}`, "data-ref": part.ref },
            svg("title", {}, `${part.ref} ${part.value} ${footprintName(part.footprint)}`),
            svg("circle", { cx: sx(part.x), cy: sy(part.y), r: (chosen ? dot * 2 : dot).toFixed(3) }),
            svg("text", { x: sx(part.x), y: (box.y1 - part.y - dot * 2.2).toFixed(3), "font-size": text.toFixed(3) }, part.ref),
        );
        group.addEventListener("click", () => onPick(part.ref));
        root.append(group);
    }
    if (scene.camera) {
        root.append(crossMark(scene.camera, box, "pnp-camera-mark", "bottom camera"));
    }
    return { root, box };
}

/** The board drawing's labels and dots, rem on the screen whatever the zoom. */
export const LABEL_REM = 0.7;
export const DOT_REM = 0.22;

/**
 * Which labels to keep so none overlaps another: each one's box on the
 * screen (its anchor in the middle of its bottom edge, `width` and
 * `height` px), the first ones kept first (the part picked comes first,
 * then the ones a search lights).
 */
export function uncrowded(labels: { x: number; y: number; width: number; height: number }[]): boolean[] {
    const kept: { x0: number; y0: number; x1: number; y1: number }[] = [];
    return labels.map((label) => {
        const box = { x0: label.x - label.width / 2, y0: label.y - label.height, x1: label.x + label.width / 2, y1: label.y };
        if (kept.some((other) => box.x0 < other.x1 && box.x1 > other.x0 && box.y0 < other.y1 && box.y1 > other.y0)) {
            return false;
        }
        kept.push(box);
        return true;
    });
}

/**
 * The drawing's dots, labels and marks at one size on the screen for the
 * view shown, and the labels that would crowd others dropped: `unit` is
 * the drawing's units per screen px, `rem` px per rem.
 */
export function fitLabels(root: SVGElement, box: Box, view: Box, unit: number, rem: number): void {
    const font = LABEL_REM * rem * unit;
    const dot = DOT_REM * rem * unit;
    const sy = (y: number): number => box.y1 - y;
    const labels: { node: SVGElement; x: number; y: number; width: number; height: number; rank: number }[] = [];
    for (const group of Array.from(root.querySelectorAll<SVGElement>(".pnp-part"))) {
        const circle = group.querySelector("circle");
        const text = group.querySelector("text");
        if (!circle || !text) {
            continue;
        }
        const chosen = group.classList.contains("selected");
        const cx = Number(circle.getAttribute("cx"));
        const cy = Number(circle.getAttribute("cy"));
        circle.setAttribute("r", (chosen ? dot * 2 : dot).toFixed(4));
        text.setAttribute("font-size", font.toFixed(4));
        text.setAttribute("y", (cy - dot * 2.2).toFixed(4));
        // In the view's screen px, for the crowding.
        const x = (cx + box.x0 - view.x0) / unit;
        const y = (cy - dot * 2.2 - (sy(view.y1))) / unit;
        const inside = cx + box.x0 >= view.x0 && cx + box.x0 <= view.x1 && sy(cy) >= view.y0 && sy(cy) <= view.y1;
        const length = (text.textContent ?? "").length;
        const rank = chosen ? 2 : group.classList.contains("match") ? 1 : 0;
        labels.push({ node: text, x: inside ? x : -1e9, y: inside ? y : -1e9, width: length * LABEL_REM * rem * 0.62, height: LABEL_REM * rem, rank });
    }
    const order = labels.map((_, index) => index).sort((a, b) => labels[b]!.rank - labels[a]!.rank);
    const keep = uncrowded(order.map((index) => labels[index]!));
    order.forEach((index, at) => labels[index]!.node.classList.toggle("crowded", !keep[at]));
    for (const mark of Array.from(root.querySelectorAll<SVGElement>(".pnp-head, .pnp-camera-mark, .pnp-look"))) {
        mark.querySelectorAll("text").forEach((text) => text.setAttribute("font-size", font.toFixed(4)));
    }
}

/**
 * What a camera's look for the board drawn says, on the board drawing:
 * while it looks for this board, where each guess at or over the threshold
 * (and the most likely whatever its share) says the newest picture lies,
 * labeled with its rank and share, the found one solid; with no guesses,
 * the newest pose's picture. And a ring at each corner taken of this board
 * by hand. `job` is the job drawn; all taken out for none.
 */
export function placeLookView(root: SVGElement, box: Box, look: BoardLook | null | undefined, label: string, threshold: number, job: string | null): void {
    root.querySelector(".pnp-look")?.remove();
    if (!look || job === null) {
        return;
    }
    const sx = (x: number): string => (x - box.x0).toFixed(3);
    const sy = (y: number): string => (box.y1 - y).toFixed(3);
    const points = (corners: [number, number][]): string => corners.map(([x, y]) => `${sx(x)},${sy(y)}`).join(" ");
    const group = svg("g", { class: `pnp-look${look.found ? " found" : ""}` });
    const looking = look.job === job;
    const guesses = looking ? shownGuesses(look, threshold).filter((guess) => guess.view !== null && guess.view.length === 4) : [];
    if (guesses.length > 0) {
        for (const guess of guesses) {
            const rank = (look.guesses ?? []).indexOf(guess) + 1;
            const found = rank === 1 && look.found === true;
            const under = guess.probability < threshold - 1e-9;
            const item = svg("g", { class: `pnp-guess${found ? " found" : ""}${under ? " under" : ""}` },
                svg("title", {}, `${label}, guess #${rank}: ${formatPercent(guess.probability)} of the evidence${found ? ", found" : under ? ", under the threshold" : ""}; where it says the picture lies on the board`),
                svg("polygon", { points: points(guess.view!) }),
            );
            if (guess.seen) {
                item.append(svg("text", { x: sx(guess.seen[0]), y: sy(guess.seen[1]) }, `#${rank} ${formatPercent(guess.probability)}`));
            }
            group.append(item);
        }
    } else if (looking && look.view && look.view.length === 4) {
        group.append(
            svg("title", {}, `${label}: what its picture shows of the board${look.found ? ", the board found" : ""}`),
            svg("polygon", { points: points(look.view) }),
        );
        if (look.seen) {
            group.append(svg("text", { x: sx(look.seen[0]), y: sy(look.seen[1]) }, label));
        }
    }
    const corners = look.corners;
    if (corners && corners.job === job) {
        const size = Math.max(box.x1 - box.x0, box.y1 - box.y0);
        const ring = size / 60;
        corners.points.forEach((point, index) => {
            // The number sits outside the board, off the corner, clear of a guess's label.
            const outX = point.corner.endsWith("left") ? -1 : 1;
            const outY = point.corner.startsWith("bottom") ? -1 : 1;
            group.append(svg("g", { class: "pnp-corner" },
                svg("title", {}, `corner ${index + 1}, ${point.corner}: taken with the ${label} at ${formatFixed(point.machine[0], 2)}, ${formatFixed(point.machine[1], 2)}`),
                svg("circle", { cx: sx(point.job[0]), cy: sy(point.job[1]), r: ring.toFixed(3) }),
                svg("text", { x: sx(point.job[0] + outX * ring * 1.6), y: sy(point.job[1] + outY * ring * 1.6), "text-anchor": outX < 0 ? "end" : "start" }, `${index + 1}`),
            ));
        });
    }
    if (group.childNodes.length > 0) {
        root.append(group);
    }
}

/** A cross with a ring and a label at a board point, sized to the drawing. */
function crossMark(at: { x: number; y: number }, box: Box, kind: string, label: string): SVGElement {
    const size = Math.max(box.x1 - box.x0, box.y1 - box.y0);
    const arm = (size / 140) * 4;
    const sx = (x: number): string => (x - box.x0).toFixed(3);
    const sy = (y: number): string => (box.y1 - y).toFixed(3);
    return svg("g", { class: kind },
        svg("line", { x1: sx(at.x - arm), y1: sy(at.y), x2: sx(at.x + arm), y2: sy(at.y) }),
        svg("line", { x1: sx(at.x), y1: sy(at.y - arm), x2: sx(at.x), y2: sy(at.y + arm) }),
        svg("circle", { cx: sx(at.x), cy: sy(at.y), r: (arm * 0.6).toFixed(3) }),
        svg("text", { x: sx(at.x + arm), y: sy(at.y + arm), "font-size": (size / 45).toFixed(3) }, label),
    );
}

/** The head's cross in a board drawing, moved to `head` or taken out for null or a head past the drawing's edge. */
export function placeHead(root: SVGElement, box: Box, head: { x: number; y: number } | null): void {
    root.querySelector(".pnp-head")?.remove();
    if (head === null || head.x < box.x0 || head.x > box.x1 || head.y < box.y0 || head.y > box.y1) {
        return;
    }
    root.append(crossMark(head, box, "pnp-head", "head"));
}

/** A view box zoomed by `factor` about a point of it (fractions of its width and height from its top left), kept within `limit` and no smaller than a 64th of it. */
export function zoomBox(view: Box, factor: number, fx: number, fy: number, limit: Box): Box {
    const width = view.x1 - view.x0;
    const height = view.y1 - view.y0;
    const fullWidth = limit.x1 - limit.x0;
    const scale = Math.min(Math.max(factor, (fullWidth / 64) / width), fullWidth / width);
    const nextWidth = width * scale;
    const nextHeight = height * scale;
    const px = view.x0 + fx * width;
    const py = view.y0 + fy * height;
    return clampBox({ x0: px - fx * nextWidth, y0: py - fy * nextHeight, x1: px - fx * nextWidth + nextWidth, y1: py - fy * nextHeight + nextHeight }, limit);
}

/** A view box moved back inside `limit` where it hangs over, its size kept. */
export function clampBox(view: Box, limit: Box): Box {
    const width = view.x1 - view.x0;
    const height = view.y1 - view.y0;
    const x0 = Math.min(Math.max(view.x0, limit.x0), Math.max(limit.x0, limit.x1 - width));
    const y0 = Math.min(Math.max(view.y0, limit.y0), Math.max(limit.y0, limit.y1 - height));
    return { x0, y0, x1: x0 + width, y1: y0 + height };
}

/** The view with a point in it: unchanged when the point is well inside, else as large and centered on it, kept within `limit`. */
export function viewOn(view: Box, x: number, y: number, limit: Box): Box {
    const width = view.x1 - view.x0;
    const height = view.y1 - view.y0;
    if (x >= view.x0 + width * 0.1 && x <= view.x1 - width * 0.1 && y >= view.y0 + height * 0.1 && y <= view.y1 - height * 0.1) {
        return view;
    }
    return clampBox({ x0: x - width / 2, y0: y - height / 2, x1: x + width / 2, y1: y + height / 2 }, limit);
}

/** One line on the last Look once: what it looked for and what it found, px from the center and its size. */
export function lookOnceText(look: { found: boolean; polarity: string; dx?: number; dy?: number; major?: number; minor?: number } | null): string {
    if (!look) {
        return "";
    }
    if (!look.found) {
        return `look once: no ${look.polarity} spot found: try the other polarity, or bring the spot nearer the center`;
    }
    const size = look.major !== undefined && look.minor !== undefined ? `, ${formatFixed(look.major, 1)} by ${formatFixed(look.minor, 1)} px` : "";
    return `look once: a ${look.polarity} spot ${formatFixed(look.dx ?? 0, 1)}, ${formatFixed(look.dy ?? 0, 1)} px from the center${size}`;
}

/** One line on the routine: which, where it is, and how it ended. */
export function pnpRoutineText(state: PnpState | null): string {
    const routine = state?.routine;
    if (!routine) {
        return "";
    }
    const what = routine.kind === "nozzle" ? "Centering the nozzle" : routine.kind === "runout" ? "Measuring the runout" : "Looking at the part";
    if (routine.state === "running") {
        const spot = routine.spot ? `, nozzle ${formatFixed(routine.spot.mm, 3)} mm off center` : "";
        return `${what}: ${routine.step} (${routine.done} of ${routine.total})${spot}`;
    }
    if (routine.state === "done") {
        return routine.kind === "nozzle" ? "Nozzle centered: camera place, scale, roll and mirror measured."
            : routine.kind === "runout" ? "Runout measured." : "Part measured: offset below.";
    }
    return `${what} ${routine.state}${routine.error && routine.error !== "stopped" ? `: ${routine.error}` : ""}`;
}

/** Where the part on the nozzle sits, and how big it looked. */
export function partOffsetText(state: PnpState | null): string {
    const part = state?.part_offset;
    if (!part) {
        return "No part measured: hold one on the nozzle, then Look at part.";
    }
    return `Part sits X ${formatFixed(part.dx, 3)} Y ${formatFixed(part.dy, 3)} mm off the nozzle center (${formatFixed(part.mm, 3)} mm),`
        + ` size ${formatFixed(part.length, 2)} by ${formatFixed(part.width, 2)} mm.`;
}

/** The PNP setup: an X/Y machine, the up camera, the nozzle over it, a board job with parts, and a part looked at. */
export const PNP_SETUP: Setup = {
    id: "pnp",
    label: "Place parts",
    steps: (state: AppState) => {
        const pnp = state.pnp;
        const parts = state.components !== null && state.components.job === state.job?.id ? state.components.components.length : 0;
        return [
            connectStep(state),
            {
                label: "X/Y machine",
                done: state.snapshot.connected && isCartesian(state.snapshot),
                hint: "The bottom camera needs an X/Y machine ($cartesian=1): pick one on the Config page and Write to board.",
                panel: "machine-file",
            },
            { label: "Bottom camera on", done: pnp?.running === true, hint: "Pick or type the camera in the Bottom camera panel, then press Start.", panel: "pnp-camera" },
            {
                label: "Nozzle centered",
                done: pnp?.position !== null && pnp?.position !== undefined && (pnp?.mm_per_px ?? 0) > 0,
                hint: "Jog the nozzle into the bottom camera's view, then press Center nozzle.",
                panel: "pnp-nozzle",
            },
            { label: "Board", done: parts > 0, hint: "Pick or upload a board (.kicad_pcb) in the Parts panel.", panel: "pnp-parts" },
            {
                label: "Part on nozzle",
                done: pnp?.part_offset !== null && pnp?.part_offset !== undefined,
                hint: "Hold a part on the nozzle, then press Look at part.",
                panel: "pnp-nozzle",
            },
        ];
    },
};

/** A pick of what a finder looks for: a spot dark or bright against what is around it. */
export function polaritySelect(label: string): HTMLSelectElement {
    return el("select", { class: "field", "aria-label": label }, el("option", { value: "dark" }, "dark"), el("option", { value: "bright" }, "bright")) as HTMLSelectElement;
}

export interface PnpRoots {
    steps: HTMLElement;
    parts: HTMLElement;
    board: HTMLElement;
    camera: HTMLElement;
    nozzle: HTMLElement;
    /** A G-code machine's head: lights, vacuum, its places, its file's values. */
    head: HTMLElement;
    /** The jog of the machine connected. */
    jog: HTMLElement;
    /** The bottom camera's picture. */
    view: HTMLElement;
    /** A G-code machine's top camera's picture. */
    topView: HTMLElement;
    /** A G-code machine's top camera. */
    top: HTMLElement;
    /** The board's place on a G-code machine. */
    refs: HTMLElement;
    /** A G-code machine's feeders, and its feeder bus. */
    feeders: HTMLElement;
    /** Placing with a G-code machine. */
    run: HTMLElement;
    /** The look for the board with a camera picked. */
    find: HTMLElement;
}

export interface PnpPanels {
    /** The box the top camera's search keeps to, drawn on its picture. */
    topBox(): MachineBox | null;
}

const COLUMNS: [SortKey, string][] = [["ref", "Ref"], ["value", "Value"], ["footprint", "Footprint"], ["x", "X"], ["y", "Y"], ["rotation", "Rot"], ["side", "Side"]];

/** The PNP page in `roots`; `headBox` is the box the head camera's search keeps to, drawn on its picture on the Jobs page. */
export function mountPnp(roots: PnpRoots, ctx: Ctx, headBox: () => MachineBox | null = () => null): PnpPanels {
    let selected: string | null = null;
    // The job, and where it lay, the parts were asked for: a reply for
    // another is dropped, and a job moved, turned or aligned is asked again.
    let asked: string | null = null;
    let loading = false;

    // The steps follow the machine the parts are placed with.
    mountSteps(roots.steps, ctx, (state) => [gcodePlacing(state) ? PLACING_SETUP : PNP_SETUP], "spinny.steps.pnp");
    mountHead(roots.head, ctx);
    mountPnpRefs(roots.refs, ctx);
    mountPnpFeeders(roots.feeders, ctx);
    mountPnpRun(roots.run, ctx);
    const views = mountCameraViews({ bottom: roots.view, top: roots.topView }, ctx);
    mountTopCamera(roots.top, ctx, () => visible() && gcodePlacing(ctx.store.get()));
    // The board drawing shows the look of the camera this panel picks.
    const find = mountFindBoard(roots.find, ctx, {
        page: "pnp",
        boxes: { head: headBox, top: () => views.top.box() },
        onChange: () => renderBoard(ctx.store.get()),
    });

    // --- the jog: the machine connected's, whichever it is; the panel is
    // the jog panel itself, one head and its buttons, as on the Jobs page ---
    mountJog(roots.jog, ctx, "pnp", () => true);

    // --- the parts ---
    const jobPick = el("select", { class: "field", "aria-label": "Board job" }) as HTMLSelectElement;
    const upload = el("input", { type: "file", accept: ".kicad_pcb", class: "hidden", "aria-label": "Board file" }) as HTMLInputElement;
    const uploadButton = button("Upload board", () => upload.click(), "btn btn-quiet btn-small");
    uploadButton.title = "upload a .kicad_pcb as a job and list its parts";
    const filter = el("input", { type: "search", class: "field", placeholder: "ref, value or footprint", "aria-label": "Filter parts" }) as HTMLInputElement;
    const sidePick = el("select", { class: "field", "aria-label": "Side" },
        el("option", { value: "front" }, "front"), el("option", { value: "back" }, "back"), el("option", { value: "all" }, "both sides")) as HTMLSelectElement;
    sidePick.value = readSide();
    const grouped = el("input", { type: "checkbox", "aria-label": "Group by value and footprint" }) as HTMLInputElement;
    grouped.checked = readStored(GROUP_KEY) === "1";
    const showKeptOut = el("input", { type: "checkbox", "aria-label": "Show parts kept out of the position files" }) as HTMLInputElement;
    showKeptOut.checked = readShowKeptOut();
    const keptOutLabel = el("label", { class: "muted", title: "list the parts KiCad keeps out of the position files: test points, mounting holes" }, showKeptOut, " kept out");
    // A filter kept changes which parts the backend marks: they are asked for again.
    const partsFilter = mountPartsFilter(ctx, () => {
        asked = null;
        void loadParts(ctx.store.get());
    });
    const partsNote = el("p", { class: "muted hint pnp-parts-note" });
    const table = el("table", { class: "pnp-parts" });
    const correct = el("input", { type: "checkbox", "aria-label": "Correct by the part on the nozzle" }) as HTMLInputElement;
    const correctLabel = el("label", { class: "muted" }, correct, " part center over the place");
    const withCamera = el("input", { type: "checkbox", "aria-label": "Go with the top camera" }) as HTMLInputElement;
    const withCameraLabel = el("label", { class: "muted", title: "the top camera's crosshair goes over the part instead of the nozzle" }, withCamera, " with the top camera");
    const gotoButton = button("Go to part", () => gotoPart(), "btn btn-primary");
    gotoButton.title = "X and Y over the picked part, at the safe height (Travel H on this project's firmware, safe Z on a G-code machine); Z stays up";
    const chosenLine = el("p", { class: "muted pnp-chosen" });
    roots.parts.append(
        el("div", { class: "panel-head" }, el("h2", {}, "Parts")),
        el("fieldset", { class: "panel-body" },
            el("div", { class: "button-row" }, labeled("Job", jobPick, "labeled inline"), uploadButton, upload),
            el("div", { class: "button-row" }, filter, sidePick, el("label", { class: "muted" }, grouped, " group"), keptOutLabel),
            partsFilter.root,
            el("div", { class: "button-row" }, gotoButton, correctLabel, withCameraLabel),
            chosenLine,
            partsNote,
            resizableBox(el("div", { class: "pnp-parts-box", title: "drag the lower right corner to size the list" }, table), "spinny.pnp.parts.height"),
        ),
    );
    jobPick.addEventListener("change", () => {
        partsNote.textContent = "Loading the job...";
        void ctx.selectJob(jobPick.value === "" ? null : jobPick.value);
    });
    filter.addEventListener("input", () => renderAll());
    sidePick.addEventListener("change", () => {
        writeStored(SIDE_KEY, sidePick.value);
        renderAll();
    });
    grouped.addEventListener("change", () => {
        writeStored(GROUP_KEY, grouped.checked ? "1" : "0");
        renderParts(ctx.store.get());
    });
    showKeptOut.addEventListener("change", () => {
        writeShowKeptOut(showKeptOut.checked);
        renderAll();
    });
    upload.addEventListener("change", () => void uploadBoard());

    let sortKey: SortKey = (COLUMNS.map(([key]) => key)).find((key) => key === (readStored(SORT_KEY) ?? "").replace(/^-/, "")) ?? "ref";
    let sortDown = (readStored(SORT_KEY) ?? "").startsWith("-");
    // The groups folded shut, by value and footprint.
    const folded = new Set<string>();

    // --- the board ---
    const drawing = el("div", { class: "pnp-drawing" });
    const fit = button("Fit", () => resetView(), "btn btn-quiet btn-small");
    fit.title = "the whole board again";
    const boardSearch = mountBoardSearch({
        parts: () => sideParts(ctx.store.get()),
        onPick: (ref) => {
            choose(ref);
            bringIntoView(ref);
        },
        onChange: () => {
            markSearch();
            fitDrawing();
        },
    });
    roots.board.append(
        el("div", { class: "panel-head" }, el("h2", {}, "Board"), fit),
        el("div", { class: "panel-body" }, boardSearch.root, drawing, el("p", { class: "muted hint" }, "Click a part to pick it; Ctrl and the wheel zoom, a drag pans, a double-click fits. Hollow dots are on the back, grey ones dnp or kept out of the position files."
            + " An outline is where a guess of the Find board panel says the camera's picture lies on the board, labeled with its share (dashed: the most likely, under the threshold); a ring is a corner taken.")),
    );

    // --- the up camera ---
    const startButton = button("Start", () => startCamera(), "btn btn-primary");
    startButton.title = "start the bottom camera with these settings";
    const stopButton = button("Stop", () => into(ctx, "pnp", ctx.api.pnpStop()), "btn", "stop the bottom camera");
    const cameraBadge = el("span", { class: "badge" }, "stopped");
    const device = el("input", { type: "text", class: "field", "aria-label": "Bottom camera device", spellcheck: "false" }) as HTMLInputElement;
    const size = el("input", { type: "text", class: "field", "aria-label": "Bottom camera size", placeholder: "1280x720", spellcheck: "false" }) as HTMLInputElement;
    const fps = numberField({ min: 1, max: 120, step: 1, width: "5rem" });
    fps.setAttribute("aria-label", "Bottom camera fps");
    const nozzleSpot = polaritySelect("Nozzle spot");
    const partSpot = polaritySelect("Part spot");
    const cameraPick = mountCameraPick(ctx, {
        device,
        size,
        fps,
        otherLabel: "head camera",
        otherDevice: (state) => state.camera?.device ?? null,
        visible: () => visible(),
    });
    const cameraApply = button("Apply", () => applySettings(), "btn", "use these camera settings");
    cameraApply.title = "send the fields marked as not applied";
    const lookSpot = el("select", { class: "field", "aria-label": "Spot to look for once" },
        el("option", { value: "nozzle" }, "nozzle spot"), el("option", { value: "part" }, "part spot")) as HTMLSelectElement;
    const lookOnce = button("Look once", () => into(ctx, "pnp", ctx.api.pnpLook(lookSpot.value as "nozzle" | "part")), "btn");
    lookOnce.title = "find the spot once, with no move, and draw what was found over the picture: a wrong polarity or size shows before a routine trusts it";
    const lookLine = el("p", { class: "muted pnp-look-line" });
    const upControls = mountCameraControls(ctx, "up", "the bottom camera");
    const upSight = mountCameraSight(ctx, { camera: "up", label: "the bottom camera", settings: (state) => state.pnp ?? null, running: (state) => state.pnp?.running === true });
    // The pictures the nozzle and part routines looked at, and photos by hand.
    const upLog = el("div", { class: "camlog-box" });
    mountCameraLog(upLog, ctx, "up");
    const cameraChip = el("span", { class: "badge apply-state hidden", "data-apply": "pending" });
    // Where the up camera sits on a G-code machine: typed, taken by eye, or measured.
    const placeX = numberField({ step: 0.01, width: "6rem" });
    placeX.setAttribute("aria-label", "Bottom camera place X");
    const placeY = numberField({ step: 0.01, width: "6rem" });
    placeY.setAttribute("aria-label", "Bottom camera place Y");
    const placeSet = button("Set", () => setPlace(), "btn btn-quiet btn-small");
    placeSet.title = "keep the typed place as the bottom camera's";
    const placeHere = button("Camera is here", () => into(ctx, "placing", ctx.api.pnpCameraPlace({ here: true })), "btn");
    placeHere.title = "the nozzle is over the bottom camera's center by eye: keep where the head is as its place";
    const placeForget = button("Forget", () => into(ctx, "placing", ctx.api.pnpCameraPlace({ clear: true })), "btn btn-quiet btn-small");
    placeForget.title = "forget the place kept: the machine file's again";
    const deviceStep = numberField({ value: 1, min: 0, max: 10, step: 0.5, width: "5rem" });
    deviceStep.setAttribute("aria-label", "Centering step mm");
    const deviceCenter = button("Center nozzle", () => centerOnDevice(), "btn");
    deviceCenter.title = "find where the bottom camera is and its picture's scale, roll and mirror, by moving the nozzle over it until it sits on the crosshair";
    const runout = button("Measure runout", () => into(ctx, "placing", ctx.api.pnpRunout()), "btn");
    runout.title = "turn the nozzle over the bottom camera to measure how far its tip runs off its turning axis";
    const deviceAbort = button("Abort", () => into(ctx, "pnp", ctx.api.pnpAbort()), "btn btn-danger", "stop the routine");
    const deviceCameraLine = el("p", { class: "muted" });
    const deviceRoutineLine = el("p", { class: "muted vision-routine" });
    const deviceCalibration = el("div", { class: "stack pnp-camera-device" },
        el("h3", {}, "On the G-code machine"),
        deviceCameraLine,
        el("div", { class: "button-row" }, labeled("X", placeX, "labeled inline"), labeled("Y", placeY, "labeled inline"), placeSet, placeForget),
        el("div", { class: "button-row" }, placeHere, infoTip("upcam")),
        el("div", { class: "button-row" }, labeled("Step mm", deviceStep, "labeled inline"), deviceCenter, runout, deviceAbort, infoTip("runout")),
        deviceRoutineLine,
        el("p", { class: "muted hint" }, "Center nozzle moves the nozzle over the camera's place, finds it in the picture, measures the picture against two small moves, and moves the nozzle onto the crosshair: that place is the camera's."),
    );
    roots.camera.append(
        el("div", { class: "panel-head" }, el("h2", {}, "Bottom camera"), cameraBadge),
        el("fieldset", { class: "panel-body" },
            el("div", { class: "button-row" }, startButton, stopButton),
            cameraPick.row,
            cameraPick.note,
            el("div", { class: "field-grid" },
                labeled("Device", device),
                labeled("Size", size),
                labeled("fps", fps),
                labeled("Nozzle spot", nozzleSpot),
                labeled("Part spot", partSpot),
            ),
            el("div", { class: "button-row" }, cameraApply, cameraChip),
            el("div", { class: "button-row" }, labeled("Look for", lookSpot, "labeled inline"), lookOnce),
            lookLine,
            upControls.root,
            upSight.root,
            el("p", { class: "muted hint" }, "A fixed camera looking up at the nozzle. Set Nozzle spot and Part spot to how the bore and a held part look against their background."),
            deviceCalibration,
            upLog,
        ),
    );

    // --- the nozzle ---
    const posR = numberField({ step: 0.01, width: "6rem" });
    posR.setAttribute("aria-label", "Bottom camera position R");
    const posZ = numberField({ step: 0.01, width: "6rem" });
    posZ.setAttribute("aria-label", "Bottom camera position Z");
    const height = numberField({ step: 0.1, width: "6rem", placeholder: "travel" });
    height.setAttribute("aria-label", "Nozzle height H");
    const scale = numberField({ min: 0, step: 0.001, width: "6rem" });
    scale.setAttribute("aria-label", "Bottom camera mm per px");
    const roll = numberField({ step: 0.01, width: "6rem" });
    roll.setAttribute("aria-label", "Bottom camera roll");
    const mirror = el("input", { type: "checkbox", "aria-label": "Bottom camera mirrored" }) as HTMLInputElement;
    const nozzleApply = button("Apply", () => applyMeasured(), "btn", "use these values");
    const nozzleChip = el("span", { class: "badge apply-state hidden", "data-apply": "pending" });
    const forget = button("Forget position", () => into(ctx, "pnp", ctx.api.pnpSettings({ clear: ["position"] })), "btn btn-quiet", "forget where the camera is: centering finds it again");
    const step = numberField({ value: 1, min: 0, max: 10, step: 0.5, width: "5rem" });
    step.setAttribute("aria-label", "Centering step mm");
    const centerButton = button("Center nozzle", () => centerNozzle(), "btn btn-primary");
    centerButton.title = "find the bottom camera's place and scale by moving the nozzle onto its crosshair";
    const partButton = button("Look at part", () => into(ctx, "pnp", ctx.api.pnpPart()), "btn");
    partButton.title = "over the bottom camera with a part on the nozzle: measure where it sits on the nozzle";
    const abortButton = button("Abort", () => into(ctx, "pnp", ctx.api.pnpAbort()), "btn btn-danger", "stop the routine");
    const overButton = button("Nozzle over camera", () => nozzleOverCamera(), "btn");
    overButton.title = "the nozzle over the bottom camera's place at the travel height, then down to Sharp at H";
    const routineLine = el("p", { class: "muted vision-routine" });
    const partLine = el("p", { class: "muted" });
    roots.nozzle.append(
        el("div", { class: "panel-head" }, el("h2", {}, "Nozzle"), infoTip("upcam")),
        el("fieldset", { class: "panel-body" },
            el("div", { class: "field-grid" },
                labeled("Camera at R mm", posR),
                labeled("Camera at Z mm", posZ),
                labeled("Sharp at H mm", height),
                labeled("mm per px", scale),
                labeled("Roll deg", roll),
                labeled("Mirrored", mirror),
            ),
            el("div", { class: "button-row" }, nozzleApply, nozzleChip, forget),
            el("div", { class: "button-row" }, labeled("Step mm", step, "labeled inline"), centerButton, partButton, abortButton),
            el("div", { class: "button-row" }, overButton),
            routineLine,
            partLine,
            el("p", { class: "muted hint" },
                "Center nozzle rises to travel height, then comes down over the bottom camera to Sharp at H; step 0 keeps the scale."
                + " With the box ticked, Go to part places the held part's center (from Look at part), not the nozzle's."),
        ),
    );

    const cameraFields = new Tracked([device, size, fps, nozzleSpot, partSpot], () => showPending());
    const measuredFields = new Tracked([posR, posZ, height, scale, roll], () => showPending());
    let mirrorShown: boolean | null = null;
    mirror.addEventListener("change", () => showPending());

    function showPending(): void {
        const camera = cameraFields.edited();
        const mirrorEdited = mirrorShown !== null && mirror.checked !== mirrorShown;
        mirror.closest(".labeled")?.classList.toggle("edited", mirrorEdited);
        const measured = measuredFields.edited() + (mirrorEdited ? 1 : 0);
        for (const [chip, count] of [[cameraChip, camera], [nozzleChip, measured]] as const) {
            chip.classList.toggle("hidden", count === 0);
            chip.textContent = `${count} not applied`;
            chip.title = "marked fields are not sent yet; press Apply";
        }
        cameraApply.classList.toggle("btn-primary", camera > 0);
        nozzleApply.classList.toggle("btn-primary", measured > 0);
        setPending(ctx.store, "pnp", camera + measured);
    }

    /** The camera fields typed in or picked and not applied. */
    function cameraPatch(): Partial<PnpSettings> {
        const patch: Partial<PnpSettings> = {};
        if (cameraFields.changed(device) && device.value.trim() !== "") {
            patch.device = device.value.trim();
        }
        if (cameraFields.changed(size) && size.value.trim() !== "") {
            patch.size = size.value.trim();
        }
        const frames = parseNumber(fps.value);
        if (cameraFields.changed(fps) && frames !== null) {
            patch.fps = frames;
        }
        if (cameraFields.changed(nozzleSpot)) {
            patch.nozzle_spot = nozzleSpot.value as SpotPolarity;
        }
        if (cameraFields.changed(partSpot)) {
            patch.part_spot = partSpot.value as SpotPolarity;
        }
        return patch;
    }

    async function applySettings(): Promise<void> {
        const patch = cameraPatch();
        if (Object.keys(patch).length === 0) {
            ctx.toast("info", "nothing changed");
            return;
        }
        await into(ctx, "pnp", ctx.api.pnpSettings(patch));
    }

    /** Starts the up camera on what the fields show: settings picked or typed and not applied go first. */
    async function startCamera(): Promise<void> {
        const patch = cameraPatch();
        if (Object.keys(patch).length > 0) {
            const state = await ctx.call(ctx.api.pnpSettings(patch));
            if (!state) {
                return;
            }
            ctx.store.set({ pnp: state });
        }
        await into(ctx, "pnp", ctx.api.pnpStart());
    }

    async function applyMeasured(): Promise<void> {
        const patch: Partial<PnpSettings> & { clear?: ("position" | "height")[] } = {};
        const r = parseNumber(posR.value);
        const z = parseNumber(posZ.value);
        if ((measuredFields.changed(posR) || measuredFields.changed(posZ)) && r !== null && z !== null) {
            patch.position = [r, z];
        }
        if (measuredFields.changed(height)) {
            const value = parseNumber(height.value);
            if (height.value.trim() === "") {
                patch.clear = ["height"];
            } else if (value !== null) {
                patch.height = value;
            }
        }
        const mm = parseNumber(scale.value);
        if (measuredFields.changed(scale) && mm !== null) {
            patch.mm_per_px = mm;
        }
        const turn = parseNumber(roll.value);
        if (measuredFields.changed(roll) && turn !== null) {
            patch.roll = turn;
        }
        if (mirrorShown !== null && mirror.checked !== mirrorShown) {
            patch.mirror = mirror.checked;
        }
        if (Object.keys(patch).length === 0) {
            ctx.toast("info", "nothing changed");
            return;
        }
        await into(ctx, "pnp", ctx.api.pnpSettings(patch));
    }

    async function centerNozzle(): Promise<void> {
        const value = parseNumber(step.value);
        if (value === null || value < 0 || value > 10) {
            ctx.toast("error", "step: 0 to 10 mm");
            return;
        }
        await into(ctx, "pnp", ctx.api.pnpNozzle(value));
    }

    async function nozzleOverCamera(): Promise<void> {
        const pnp = ctx.store.get().pnp;
        if (!pnp?.position) {
            ctx.toast("error", "the bottom camera's place is not known: center the nozzle over it, or type it");
            return;
        }
        // A goto answers nothing: true once it was taken.
        const moved = await ctx.call(ctx.api.goto({ kind: "joint", r: pnp.position[0], z: pnp.position[1] }).then(() => true));
        if (moved === true && pnp.height !== null) {
            await ctx.call(ctx.api.goto({ kind: "joint", h: pnp.height }));
        }
    }

    async function centerOnDevice(): Promise<void> {
        const value = parseNumber(deviceStep.value);
        if (value === null || value < 0 || value > 10) {
            ctx.toast("error", "step: 0 to 10 mm");
            return;
        }
        await into(ctx, "pnp", ctx.api.pnpNozzle(value));
        await ctx.refreshPlacing();
    }

    async function setPlace(): Promise<void> {
        const x = parseNumber(placeX.value);
        const y = parseNumber(placeY.value);
        if (x === null || y === null) {
            ctx.toast("error", "place: an X and a Y");
            return;
        }
        await into(ctx, "placing", ctx.api.pnpCameraPlace({ position: [x, y] }));
    }

    async function gotoPart(): Promise<void> {
        const state = ctx.store.get();
        const job = state.job;
        if (!job || selected === null) {
            ctx.toast("error", "pick a part first");
            return;
        }
        if (gcodePlacing(state)) {
            await ctx.call(ctx.api.pnpGoto({ job: job.id, ref: selected, camera: withCamera.checked }));
            await ctx.refreshPlacing();
            return;
        }
        await ctx.call(ctx.api.pnpGoto({ job: job.id, ref: selected, correct: correct.checked }));
    }

    async function uploadBoard(): Promise<void> {
        const file = upload.files?.[0];
        upload.value = "";
        if (!file) {
            return;
        }
        partsNote.textContent = `Uploading ${file.name}...`;
        const job = await ctx.call(ctx.api.uploadJob(file, {}));
        if (job) {
            await ctx.refreshJobs();
            await ctx.selectJob(job.id);
        } else {
            renderParts(ctx.store.get());
        }
    }

    function pick(ref: string): void {
        selected = selected === ref ? null : ref;
        ctx.store.set({ pnpPart: selected });
        renderAll();
    }

    /** Picks a part, whether or not it was picked before. */
    function choose(ref: string): void {
        if (selected !== ref) {
            pick(ref);
        }
    }

    /** The drawing moved to show a part when it is out of view; the zoom stays. */
    function bringIntoView(ref: string): void {
        const part = sideParts(ctx.store.get()).find((entry) => entry.ref === ref);
        if (part && drawn && view) {
            const next = viewOn(view, part.x, part.y, drawn.box);
            if (next !== view) {
                setView(next);
            }
        }
    }

    /** The parts a search matches lit on the drawing, the rest dimmed, while letters are typed. */
    function markSearch(): void {
        if (!drawn) {
            return;
        }
        const searching = boardSearch.active();
        const lit = new Set(boardSearch.matches());
        for (const group of Array.from(drawn.root.querySelectorAll<SVGElement>(".pnp-part"))) {
            const match = lit.has(group.getAttribute("data-ref") ?? "");
            group.classList.toggle("match", searching && match);
            group.classList.toggle("dim", searching && !match);
        }
    }

    function partsOf(state: AppState): Component[] {
        return state.components !== null && state.components.job === state.job?.id ? state.components.components : [];
    }

    /** The parts on the side shown, less the ones the filter leaves out and, unless shown, the kept-out ones. */
    function sideParts(state: AppState): Component[] {
        return shownParts(filterParts(partsOf(state), "", sidePick.value as Side), showKeptOut.checked);
    }

    // What the table and the drawing were last made from: they are made
    // again only when that changes, so a press on a row or a dot is not
    // lost to a rebuild under the pointer.
    let tableKey = "";
    let boardKey = "";
    let drawn: { root: SVGElement; box: Box } | null = null;
    let view: Box | null = null;

    function renderAll(): void {
        const state = ctx.store.get();
        renderParts(state);
        renderBoard(state);
    }

    function header(): HTMLTableSectionElement {
        return el("thead", {}, el("tr", {}, ...COLUMNS.map(([key, name]) => {
            const mark = key === sortKey ? (sortDown ? " v" : " ^") : "";
            return el("th", {
                class: `sortable${key === sortKey ? " sorted" : ""}`,
                title: `sort by ${name.toLowerCase()}`,
                onclick: () => {
                    sortDown = key === sortKey ? !sortDown : false;
                    sortKey = key;
                    writeStored(SORT_KEY, `${sortDown ? "-" : ""}${key}`);
                    tableKey = "";
                    renderParts(ctx.store.get());
                },
            }, `${name}${mark}`);
        }))) as HTMLTableSectionElement;
    }

    /** A kept-out part's mark, with the box that picks it to be placed all the same. */
    function placePick(part: Component): HTMLElement {
        const job = ctx.store.get().job?.id ?? "";
        const box = el("input", { type: "checkbox", "aria-label": `Place ${part.ref}` }) as HTMLInputElement;
        box.checked = pickedToPlace(job).has(part.ref);
        box.addEventListener("change", () => setPickedToPlace(job, part.ref, box.checked));
        const label = el("label", { class: "muted pnp-place-pick", title: "kept out of the position files: tick to place it all the same" }, " kept out ", box, " place");
        // A press on the box is not a press on the row, which picks the part.
        label.addEventListener("click", (event) => event.stopPropagation());
        return label;
    }

    function row(part: Component, hidden = false): HTMLTableRowElement {
        return el("tr", { class: `${part.ref === selected ? "selected" : ""}${part.dnp ? " dnp" : ""}${keptOut(part) ? " kept-out" : ""}${hidden ? " hidden" : ""}`, onclick: () => pick(part.ref) },
            el("td", { class: "mono" }, part.ref),
            el("td", {}, part.value, part.dnp ? el("span", { class: "muted" }, " dnp") : null, keptOut(part) ? placePick(part) : null),
            el("td", { class: "muted", title: part.footprint }, footprintName(part.footprint)),
            el("td", { class: "mono" }, formatFixed(part.x, 2)),
            el("td", { class: "mono" }, formatFixed(part.y, 2)),
            el("td", { class: "mono" }, formatFixed(part.rotation, 1)),
            el("td", { class: "muted" }, part.side),
        ) as HTMLTableRowElement;
    }

    function renderParts(state: AppState): void {
        const all = partsOf(state);
        if (selected !== null && !all.some((part) => part.ref === selected)) {
            selected = null;
            ctx.store.set({ pnpPart: null });
        }
        renderActions(state);
        partsFilter.render(all);
        const key = JSON.stringify([state.job?.id ?? null, state.components, filter.value, sidePick.value, showKeptOut.checked, selected, sortKey, sortDown, grouped.checked, [...folded], loading]);
        if (key === tableKey) {
            return;
        }
        tableKey = key;
        const shown = sortParts(shownParts(filterParts(all, filter.value, sidePick.value as Side), showKeptOut.checked), sortKey, sortDown);
        const note = state.components !== null && state.components.job === state.job?.id ? state.components.note : null;
        partsNote.textContent = !state.job
            ? "Pick a board job, or upload a .kicad_pcb, to list its parts."
            : loading ? `Loading the parts of ${state.job.name}...`
            : note ?? (all.length === 0 ? "The board has no parts." : `${shown.length} of ${all.length} parts`);
        partsNote.classList.toggle("loading", loading);
        let rows: HTMLTableRowElement[];
        if (grouped.checked) {
            rows = groupParts(shown).flatMap((group) => {
                const shut = folded.has(group.key);
                const head = el("tr", {
                    class: `pnp-group${shut ? " shut" : ""}`,
                    title: shut ? "show the parts" : "fold the parts away",
                    onclick: () => {
                        if (folded.has(group.key)) {
                            folded.delete(group.key);
                        } else {
                            folded.add(group.key);
                        }
                        renderParts(ctx.store.get());
                    },
                }, el("td", { colspan: "7" }, `${shut ? "+" : "-"} ${group.value || "(no value)"}  ${footprintName(group.footprint)}  x${group.parts.length}  `,
                    el("span", { class: "muted" }, group.parts.map((part) => part.ref).join(" ")))) as HTMLTableRowElement;
                return [head, ...group.parts.map((part) => row(part, shut))];
            });
        } else {
            rows = shown.map((part) => row(part));
        }
        replace(table, header(), el("tbody", {}, ...rows));
        const chosen = all.find((part) => part.ref === selected) ?? null;
        chosenLine.textContent = chosen
            ? `${chosen.ref} ${chosen.value}: X ${formatFixed(chosen.x, 3)} Y ${formatFixed(chosen.y, 3)}, ${formatFixed(chosen.rotation, 1)} deg, ${chosen.side}`
            : "No part picked.";
    }

    /** The goto's button and boxes, which follow the machine and the cameras. */
    function renderActions(state: AppState): void {
        const onDevice = gcodePlacing(state);
        const busy = onDevice ? state.placing?.running === true : state.pnp?.routine?.state === "running";
        const chosen = selected !== null && partsOf(state).some((part) => part.ref === selected);
        const linked = onDevice ? state.placing?.connected === true : state.snapshot.connected;
        lockFor(gotoButton, [!linked, "connect first"], [busy, onDevice ? "the machine is placing" : "a camera routine is under way"], [!chosen, "pick a part first"]);
        correctLabel.classList.toggle("hidden", onDevice);
        withCameraLabel.classList.toggle("hidden", !onDevice);
        const offsetKnown = (state.placing?.top?.offset ?? null) !== null || (state.placing?.document?.top?.offset ?? null) !== null;
        withCamera.disabled = !offsetKnown;
        if (withCamera.disabled) {
            withCamera.checked = false;
        }
        correct.disabled = !state.pnp?.part_offset;
        if (correct.disabled) {
            correct.checked = false;
        }
    }

    function setView(next: Box): void {
        view = next;
        drawn?.root.setAttribute("viewBox", `${(next.x0 - (drawn?.box.x0 ?? 0)).toFixed(3)} ${((drawn?.box.y1 ?? 0) - next.y1).toFixed(3)} ${(next.x1 - next.x0).toFixed(3)} ${(next.y1 - next.y0).toFixed(3)}`);
        fitDrawing();
    }

    /** The labels and dots at one screen size for the view shown, the crowded labels dropped. */
    function fitDrawing(): void {
        if (!drawn || !view) {
            return;
        }
        const rect = drawn.root.getBoundingClientRect();
        const width = view.x1 - view.x0;
        const height = view.y1 - view.y0;
        // The drawing is scaled to fit its element, the smaller way.
        const scale = rect.width > 0 && rect.height > 0 ? Math.min(rect.width / width, rect.height / height) : 0;
        if (!(scale > 0)) {
            return;
        }
        const rem = parseFloat(globalThis.getComputedStyle?.(document.documentElement).fontSize ?? "") || 16;
        fitLabels(drawn.root, drawn.box, view, 1 / scale, rem);
    }
    const Observer = globalThis.ResizeObserver;
    if (Observer) {
        new Observer(() => fitDrawing()).observe(drawing);
    }

    function resetView(): void {
        if (drawn) {
            setView(drawn.box);
        }
    }

    function renderBoard(state: AppState): void {
        const machine = state.snapshot.machine;
        const camera = !gcodePlacing(state) && isCartesian(state.snapshot) ? cameraOnBoard(state.pnp?.position ?? null, machine?.joint.a ?? 0) : null;
        const parts = sideParts(state);
        const key = JSON.stringify([state.job?.id ?? null, state.job?.outline.length ?? 0, state.job?.pads?.length ?? 0, state.job?.rotation ?? 0, state.components, selected, camera, sidePick.value, showKeptOut.checked, loading]);
        if (key !== boardKey) {
            boardKey = key;
            boardSearch.refresh();
            const before = drawn?.box ?? null;
            drawn = boardSvg({ job: state.job, parts, selected, camera }, pick);
            replace(drawing, drawn?.root ?? el("p", { class: `muted${loading ? " loading" : ""}` }, loading ? "Loading the board..." : "Nothing to draw: pick a board job."));
            // A pick keeps the zoom; another board starts whole.
            if (drawn && view && before && JSON.stringify(before) === JSON.stringify(drawn.box)) {
                setView(view);
            } else {
                view = drawn?.box ?? null;
            }
        }
        if (drawn) {
            placeHead(drawn.root, drawn.box, !gcodePlacing(state) && state.snapshot.connected && machine ? machine.board : null);
            // What the camera the Find board panel looks with says of this
            // board: its guesses and the corners taken of it.
            const job = state.job?.id ?? null;
            const camera = find.camera(state);
            const look = camera === "top" ? state.placing?.top?.board_look : state.camera?.board_look;
            placeLookView(drawn.root, drawn.box, look, camera === "top" ? "top camera" : "head camera", find.threshold(state), job);
            markSearch();
            fitDrawing();
        }
    }

    // The drawing zooms about the pointer with Ctrl and the wheel (a pinch
    // on a touchpad), and pans by a drag; the plain wheel scrolls the page.
    drawing.addEventListener("wheel", (event) => {
        if (!drawn || !view || !event.ctrlKey) {
            return;
        }
        event.preventDefault();
        const rect = drawn.root.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            return;
        }
        const fx = (event.clientX - rect.left) / rect.width;
        const fy = (event.clientY - rect.top) / rect.height;
        // The SVG's y runs down; a box's y0 is its bottom, so the pointer's height counts from the top.
        const next = zoomBox(view, event.deltaY < 0 ? 0.8 : 1.25, fx, 1 - fy, drawn.box);
        setView(next);
    }, { passive: false });
    let panFrom: { x: number; y: number; view: Box } | null = null;
    drawing.addEventListener("pointerdown", (event) => {
        if (!drawn || !view || event.button !== 0 || (event.target as Element).closest(".pnp-part")) {
            return;
        }
        panFrom = { x: event.clientX, y: event.clientY, view };
        drawing.setPointerCapture?.(event.pointerId);
    });
    drawing.addEventListener("pointermove", (event) => {
        if (!panFrom || !drawn) {
            return;
        }
        const rect = drawn.root.getBoundingClientRect();
        const width = panFrom.view.x1 - panFrom.view.x0;
        const height = panFrom.view.y1 - panFrom.view.y0;
        const dx = ((event.clientX - panFrom.x) / rect.width) * width;
        const dy = ((event.clientY - panFrom.y) / rect.height) * height;
        setView(clampBox({ x0: panFrom.view.x0 - dx, y0: panFrom.view.y0 + dy, x1: panFrom.view.x1 - dx, y1: panFrom.view.y1 + dy }, drawn.box));
    });
    drawing.addEventListener("pointerup", () => {
        panFrom = null;
    });
    drawing.addEventListener("dblclick", () => resetView());

    function renderJobs(state: AppState): void {
        const current = state.job?.id ?? "";
        replace(jobPick,
            el("option", { value: "" }, state.jobs.length > 0 ? "pick a job" : "no jobs"),
            ...state.jobs.map((job) => el("option", { value: job.id }, `${job.name} (${job.source})`)),
        );
        jobPick.value = current;
    }

    function renderCamera(state: AppState): void {
        upSight.render(state);
        const pnp = state.pnp;
        const running = pnp?.running === true;
        const busy = pnp?.routine?.state === "running";
        cameraBadge.textContent = busy ? "routine" : running ? "running" : "stopped";
        cameraBadge.setAttribute("data-camera", busy ? "finding mark" : running ? "running" : "stopped");
        setLocked(startButton, running, "the bottom camera is running");
        lockFor(stopButton, [!running, "the bottom camera is not running"], [busy, "a routine is under way: abort it first"]);
        const connected = state.snapshot.connected;
        lockFor(centerButton, [!connected, "connect first"], [!running, "start the bottom camera first"], [busy, "a routine is under way"]);
        lockFor(partButton, [!connected, "connect first"], [!running, "start the bottom camera first"], [busy, "a routine is under way"], [!pnp?.position || !(pnp.mm_per_px > 0), "center the nozzle over the bottom camera first"]);
        setLocked(abortButton, !busy, "no routine under way");
        lockFor(forget, [!pnp?.position, "no place kept"], [busy, "a routine is under way"]);
        lockFor(overButton, [!connected, "connect first"], [busy, "a routine is under way"], [!pnp?.position, "the bottom camera's place is not known yet"]);
        if (pnp) {
            cameraFields.follow(device, pnp.device);
            cameraFields.follow(size, pnp.size);
            cameraFields.follow(fps, String(pnp.fps));
            cameraFields.follow(nozzleSpot, pnp.nozzle_spot);
            cameraFields.follow(partSpot, pnp.part_spot);
            measuredFields.follow(posR, pnp.position ? String(pnp.position[0]) : "");
            measuredFields.follow(posZ, pnp.position ? String(pnp.position[1]) : "");
            measuredFields.follow(height, pnp.height === null ? "" : String(pnp.height));
            measuredFields.follow(scale, String(pnp.mm_per_px));
            measuredFields.follow(roll, String(pnp.roll));
            if (mirrorShown === null || mirror.checked === mirrorShown) {
                mirror.checked = pnp.mirror;
            }
            mirrorShown = pnp.mirror;
        }
        cameraPick.render();
        showPending();
        lockFor(lookOnce, [!running, "start the camera first"]);
        lookLine.textContent = lookOnceText(pnp?.look ?? null);
        lookLine.classList.toggle("hidden", lookLine.textContent === "");
        routineLine.textContent = state.pnp?.routine?.target === "gcode" ? "" : pnpRoutineText(pnp);
        partLine.textContent = partOffsetText(pnp);
        // The up camera on a G-code machine.
        const deviceState = state.placing;
        const linked = deviceState?.connected === true && !deviceState.running && deviceState.top?.routine?.state !== "running";
        const moving = busy && pnp?.routine?.target === "gcode";
        deviceCameraLine.textContent = upCameraText(deviceState);
        const place = deviceState?.camera.position ?? null;
        for (const [field, value] of [[placeX, place?.[0]], [placeY, place?.[1]]] as const) {
            if (field !== document.activeElement) {
                field.value = value === undefined ? "" : String(value);
            }
        }
        lockFor(placeHere, [!linked, "connect the machine first"], [busy, "a routine is under way"]);
        lockFor(placeForget, [deviceState?.camera.measured !== true, "no place kept: the machine file's is used"], [busy, "a routine is under way"]);
        lockFor(deviceCenter, [!linked, "connect the machine first"], [busy, "a routine is under way"], [!running, "start the bottom camera first"]);
        lockFor(runout, [!linked, "connect the machine first"], [busy, "a routine is under way"], [!running, "start the bottom camera first"], [!(deviceState?.camera.mm_per_px && deviceState.camera.position), "center the nozzle over the bottom camera first"]);
        setLocked(deviceAbort, !moving, "no routine under way on the machine");
        deviceRoutineLine.textContent = pnp?.routine?.target === "gcode" ? pnpRoutineText(pnp) : "";
    }

    // The parts of the selected job, asked for once it changes.
    async function loadParts(state: AppState): Promise<void> {
        const job = state.job;
        const id = job?.id ?? null;
        const key = job ? JSON.stringify([job.id, job.offset, job.rotation ?? 0, job.design ?? null]) : null;
        if (key === asked) {
            return;
        }
        asked = key;
        if (id === null) {
            loading = false;
            ctx.store.set({ components: null });
            return;
        }
        loading = true;
        renderAll();
        const parts = await ctx.call(ctx.api.components(id));
        if (asked === key) {
            loading = false;
            if (parts) {
                ctx.store.set({ components: parts });
            } else {
                renderAll();
            }
        }
    }

    function visible(): boolean {
        return activePage() === "pnp" && document.visibilityState !== "hidden";
    }

    // The state is polled while the page shows, for the picture's age and a
    // routine's steps; the event feed carries the rest.
    const pollTimer = setInterval(() => {
        if (visible()) {
            ctx.api.pnp().then((state) => ctx.store.set({ pnp: state }), () => undefined);
        }
    }, POLL_MS);
    globalThis.addEventListener?.("pagehide", () => {
        clearInterval(pollTimer);
        cameraPick.stop();
    });

    ctx.store.subscribe((state) => {
        void loadParts(state);
        renderParts(state);
        renderBoard(state);
    }, ["job", "components"]);
    ctx.store.subscribe((state) => renderJobs(state), ["jobs", "job"]);
    ctx.store.subscribe((state) => {
        renderCamera(state);
        renderActions(state);
        renderBoard(state);
    }, ["pnp", "snapshot", "placing", "camera"]);
    // The nozzle panel of a machine on this project's firmware, or a G-code
    // machine's panels for placing: whichever is connected, or with none
    // connected the G-code machine there is to place with.
    let shownGcode: boolean | null = null;
    const showTarget = (state: AppState): void => {
        const onDevice = gcodePlacing(state);
        if (onDevice === shownGcode) {
            return;
        }
        shownGcode = onDevice;
        // The up camera serves either machine; the nozzle panel is this project's machine's.
        roots.nozzle.classList.toggle("hidden", onDevice);
        for (const root of [roots.head, roots.refs, roots.feeders, roots.run, roots.top]) {
            root.classList.toggle("hidden", !onDevice);
        }
        deviceCalibration.classList.toggle("hidden", !onDevice);
        renderActions(state);
        renderBoard(state);
    };
    ctx.store.subscribe(showTarget, ["snapshot", "placing"]);
    showTarget(ctx.store.get());
    const now = ctx.store.get();
    renderJobs(now);
    renderParts(now);
    renderBoard(now);
    renderCamera(now);
    void loadParts(now);
    return { topBox: () => views.top.box() };
}
