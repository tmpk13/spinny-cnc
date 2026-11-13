// A camera's picture as the page shows it: the newest frame, asked for at
// the size it is shown at (the box's width times the screen's pixel ratio
// times the zoom, up to the camera's full size), fitted inside a box the
// operator can make taller or shorter by its grip (kept per camera), and
// the page's own marks drawn over it as SVG in the picture's own pixels
// (the crosshair, the circles looked within, the spots found, the box a
// search covers, the board where the looks put it), so their lines stay
// thin and sharp at any zoom. Ctrl and the wheel zoom on the picture's
// center (the plain wheel scrolls the page); a drag moves the head so what
// the camera sees follows the pointer, a line showing the move; a
// double-click brings a point to the crosshair; Shift and a drag draw the
// box a search keeps to, in the machine's frame.

import { button, el, readStored, writeStored } from "../dom.ts";
import { formatFixed } from "../format.ts";
import type { AppState } from "../state.ts";
import type { Ctx } from "./context.ts";

/** How often a picture is asked for while it shows, ms. */
export const FRAME_INTERVAL_MS = 250;
export const ZOOMS = [1, 1.5, 2, 3, 4, 6, 8];
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
export type Tone = "center" | "ring" | "spot" | "look" | "box" | "board" | "rough" | "drag" | "miss";

/** A mark over the picture, in its full size px from the top left (y down). */
export type Mark =
    | { kind: "circle"; x: number; y: number; r: number; tone: Tone; title?: string }
    | { kind: "ellipse"; x: number; y: number; rx: number; ry: number; angle: number; tone: Tone; title?: string }
    | { kind: "rect"; x: number; y: number; w: number; h: number; angle: number; tone: Tone; title?: string }
    | { kind: "line"; points: [number, number][]; closed?: boolean; tone: Tone; title?: string };

/** The marks of a spot the finder found, about the picture's center: its ellipse, its rectangle, its center, and the circle it was looked for within; a miss draws only that circle. */
export function spotMarks(
    spot: { dx?: number; dy?: number; major?: number; minor?: number; angle?: number; rect?: { length: number; width: number; angle: number }; found?: boolean; radius?: number | null } | null | undefined,
    size: [number, number],
    tone: Tone,
): Mark[] {
    if (!spot) {
        return [];
    }
    const [width, height] = size;
    const cx = width / 2;
    const cy = height / 2;
    const reach = spot.radius ?? height / 3;
    const marks: Mark[] = [{ kind: "circle", x: cx, y: cy, r: reach, tone: "ring", title: `looked for within ${formatFixed(reach, 0)} px of the center` }];
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
    marks.push({ kind: "line", points: [[cx, cy], [x, y]], tone });
    return marks;
}

/** Machine points as picture points, the picture's center seeing `center`. */
export function machineToPicturePoints(points: [number, number][], center: [number, number], calibration: Calibration, size: [number, number]): [number, number][] {
    return points.map(([x, y]) => {
        const [dx, dy] = machineToPicture(x - center[0], y - center[1], calibration.mmPerPx, calibration.roll, calibration.mirror);
        return [size[0] / 2 + dx, size[1] / 2 + dy];
    });
}

/** A pick armed on a camera's picture, by the picture's key: the next click on that picture hands `take` the point of the full size picture clicked instead of doing nothing. */
interface Pick {
    label: string;
    take: (point: [number, number]) => void;
}

const picks = new Map<string, Pick>();
const pickWatchers = new Set<() => void>();

/** Arms a pick on the picture of `key` (head, up, top): its next click is handed to `take`; `label` says what is picked. */
export function armPick(key: string, label: string, take: (point: [number, number]) => void): void {
    picks.set(key, { label, take });
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
    /** The machine point under the picture's center now; null when not known. */
    center(state: AppState): [number, number] | null;
    /** The page's marks over the picture besides the crosshair, the box and a drag. */
    marks(state: AppState): Mark[];
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
    let zoom = 1;
    let overlayOn = readStored(overlayKey) !== "0";
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
    const zoomLine = el("span", { class: "muted mono picture-zoom" }, "1x");
    const out = button("-", () => step(-1), "btn btn-quiet btn-small");
    out.title = "zoom out (or Ctrl and the wheel)";
    const into = button("+", () => step(1), "btn btn-quiet btn-small");
    into.title = "zoom in (or Ctrl and the wheel)";
    const overlay = button("Overlay", () => {
        overlayOn = !overlayOn;
        writeStored(overlayKey, overlayOn ? "1" : "0");
        overlay.setAttribute("aria-pressed", overlayOn ? "true" : "false");
        draw(ctx.store.get());
        refresh(true);
    }, "btn btn-quiet btn-small btn-toggle");
    overlay.title = "the page's marks over the picture, and pcbv's pose of a board loaded";
    overlay.setAttribute("aria-pressed", overlayOn ? "true" : "false");
    const boxLine = el("span", { class: "muted picture-box-line" });
    const clearBox = button("Clear box", () => setBox(null), "btn btn-quiet btn-small");
    clearBox.title = "forget the box: a search then covers the board's size about where the picture is";
    const growView = button("Add view", () => addView(), "btn btn-quiet btn-small");
    growView.title = "grow the search box to take in what the picture shows now (jog to the far corner and press again)";
    const pickLine = el("span", { class: "muted picture-pick hidden" });
    const cancelPick = button("Cancel", () => disarmPick(options.key), "btn btn-quiet btn-small");
    cancelPick.title = "pick nothing";
    const pickRow = el("div", { class: "button-row picture-pick-row hidden" }, pickLine, cancelPick);
    const caption = el("div", { class: "button-row picture-caption" }, out, zoomLine, into, overlay);
    /** The picture waits for a pick: a crosshair, and a line saying what for. */
    const showPick = (): void => {
        const label = armedPick(options.key);
        stage.classList.toggle("picking", label !== null);
        pickRow.classList.toggle("hidden", label === null);
        pickLine.classList.toggle("hidden", label === null);
        pickLine.textContent = label === null ? "" : `Click the picture where ${label}.`;
    };
    pickWatchers.add(showPick);
    if (options.boxes) {
        caption.append(growView, clearBox, boxLine);
    }
    const root = el("figure", { class: "picture-view" }, box, grip, pickRow, caption);

    // --- sizing ------------------------------------------------------------------

    function fullSize(state: AppState): [number, number] {
        const size = options.size(state);
        if (size && size[0] > 0 && size[1] > 0) {
            return size;
        }
        return [picture.naturalWidth || 1280, picture.naturalHeight || 720];
    }

    /** The box at its kept height or the picture's own shape, and the stage fitted inside it with the picture's shape. */
    function fit(): void {
        const [width, height] = fullSize(ctx.store.get());
        if (held === null) {
            box.style.height = "";
            box.style.aspectRatio = `${width} / ${height}`;
        } else {
            box.style.aspectRatio = "";
            box.style.height = `${held}rem`;
        }
        const rect = box.getBoundingClientRect();
        if (!(rect.width > 0) || !(rect.height > 0)) {
            Object.assign(stage.style, { left: "0", top: "0", width: "100%", height: "100%" });
            return;
        }
        const shown = Math.min(rect.width, rect.height * (width / height));
        const shownHeight = shown * (height / width);
        stage.style.width = `${(100 * shown) / rect.width}%`;
        stage.style.height = `${(100 * shownHeight) / rect.height}%`;
        stage.style.left = `${(100 * (rect.width - shown)) / 2 / rect.width}%`;
        stage.style.top = `${(100 * (rect.height - shownHeight)) / 2 / rect.height}%`;
    }

    const Observer = globalThis.ResizeObserver;
    const observer = Observer ? new Observer(() => {
        fit();
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

    function setZoom(next: number): void {
        zoom = ZOOMS.reduce((best, value) => (Math.abs(value - next) < Math.abs(best - next) ? value : best), ZOOMS[0]!);
        picture.style.transform = `scale(${zoom})`;
        zoomLine.textContent = `${zoom}x`;
        draw(ctx.store.get());
        refresh(true);
    }

    function step(direction: 1 | -1): void {
        const at = ZOOMS.indexOf(zoom);
        setZoom(ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, at + direction))]!);
    }

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

    /** A pointer's place as a point of the full size picture, the zoom about its center undone. */
    function pictureAt(clientX: number, clientY: number): [number, number] {
        const rect = stage.getBoundingClientRect();
        const [width, height] = fullSize(ctx.store.get());
        const fx = rect.width > 0 ? (clientX - rect.left) / rect.width : 0.5;
        const fy = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5;
        return [width / 2 + ((fx - 0.5) * width) / zoom, height / 2 + ((fy - 0.5) * height) / zoom];
    }

    let press: { from: [number, number]; to: [number, number]; client: [number, number]; boxing: boolean } | null = null;
    stage.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) {
            return;
        }
        const at = pictureAt(event.clientX, event.clientY);
        press = { from: at, to: at, client: [event.clientX, event.clientY], boxing: event.shiftKey && options.boxes === true };
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
        // else the double-click handles it.
        if (Math.hypot(event.clientX - done.client[0], event.clientY - done.client[1]) < 4) {
            const pick = picks.get(options.key);
            if (pick) {
                disarmPick(options.key);
                pick.take(done.from);
            }
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
        const [width, height] = fullSize(state);
        // The view box is the part of the picture the zoom shows, so a mark
        // lands where the zoomed picture shows its point.
        const shownWidth = width / zoom;
        const shownHeight = height / zoom;
        layer.setAttribute("viewBox", `${(width / 2 - shownWidth / 2).toFixed(3)} ${(height / 2 - shownHeight / 2).toFixed(3)} ${shownWidth.toFixed(3)} ${shownHeight.toFixed(3)}`);
        const marks: Mark[] = [];
        if (overlayOn && options.running(state)) {
            // The crosshair, a fortieth of the view's width either way.
            const arm = shownWidth / 40;
            marks.push({ kind: "line", points: [[width / 2 - arm, height / 2], [width / 2 + arm, height / 2]], tone: "center" });
            marks.push({ kind: "line", points: [[width / 2, height / 2 - arm], [width / 2, height / 2 + arm]], tone: "center" });
            marks.push(...options.marks(state));
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
        const shown = stage.getBoundingClientRect().width || box.getBoundingClientRect().width || 640;
        const size = options.size(state);
        const width = frameRequestWidth(shown, globalThis.devicePixelRatio ?? 1, zoom, size ? size[0] : null);
        picture.src = options.frameUrl(width, overlayOn && options.pcbvOverlay(state));
    }
    const timer = setInterval(() => refresh(), FRAME_INTERVAL_MS);
    picture.addEventListener("load", () => fit());

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
