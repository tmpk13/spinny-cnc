// The Plot page: simple cuts made by hand, the way a manual mill is used.
// Pick what to cut (points drilled, a board job's holes, a line through
// points, a face, or a pocket or a profile of a rectangle, its corners
// square or rounded, or of a circle), give its corners, or its center and
// size, by typing them (arithmetic too), from where the head is or from a
// marker, and the bit, the depth and the feeds, or on a laser the spot,
// the power and the passes. The operation is planned as it is typed and
// drawn on the page's preview with its sizes over it, as a sketch is.
//
// A job made here holds a list of operations, cut in order. New job makes
// one of the operation in the fields; Add to job puts it at the end of the
// selected Plot page job; a click on one of the job's operations puts it
// in the fields, and Apply puts the fields back in its place. A mark says
// whether the fields match the job, and the tab counts a change not
// applied. The run panel beside runs the selected job. The fields are
// remembered in this browser.

import { turnPoint } from "../align.ts";
import { askConfirm } from "../confirm.ts";
import { button, el, labeled, numberField, readStored, replace, setLocked, writeStored } from "../dom.ts";
import { formatDuration, formatLength, formatMm, parseNumber } from "../format.ts";
import { defaultOperation, recipeOps } from "../mock/mill.ts";
import { profileOf } from "../profile.ts";
import { movedDims, operationDims, operationSummary, sameOperation, type RectMode } from "../sketch.ts";
import { setPending, type AppState } from "../state.ts";
import type { Compensate, HolePoint, Job, MillKind, MillOperation, MillShape, MillSide, Point } from "../types.ts";
import { choiceRow, setPressed, type Ctx } from "./context.ts";
import { withFocusHere } from "./focushere.ts";
import { mapUsable } from "./heightmap.ts";
import { progressText } from "./jobs.ts";
import { headPosition, markerPicker } from "./markers.ts";

/** Where the page's fields are remembered between visits. */
export const MILL_KEY = "spinny.mill";
/** How long typing pauses before the operation is planned again, ms. */
export const PLAN_DELAY_MS = 250;

export const MILL_KINDS: { kind: MillKind; label: string }[] = [
    { kind: "drill", label: "Drill" },
    { kind: "holes", label: "Holes" },
    { kind: "line", label: "Line" },
    { kind: "face", label: "Face" },
    { kind: "pocket", label: "Pocket" },
    { kind: "profile", label: "Profile" },
];

const SHAPES: { shape: MillShape; label: string }[] = [
    { shape: "rect", label: "Rectangle" },
    { shape: "circle", label: "Circle" },
];

const SIDES: { side: MillSide; label: string }[] = [
    { side: "outside", label: "Outside" },
    { side: "inside", label: "Inside" },
    { side: "on", label: "On the line" },
];

/** What each kind of operation asks for. */
export function millNeeds(kind: MillKind, shape: MillShape): { points: boolean; closed: boolean; rect: boolean; circle: boolean; holes: boolean; stepover: boolean; direction: boolean; side: boolean; shape: boolean; corner: boolean } {
    const shaped = kind === "pocket" || kind === "profile";
    return {
        points: kind === "drill" || kind === "line",
        closed: kind === "line",
        rect: kind === "face" || (shaped && shape === "rect"),
        circle: shaped && shape === "circle",
        holes: kind === "holes",
        stepover: kind === "face" || kind === "pocket" || kind === "holes",
        direction: shaped || kind === "holes",
        side: kind === "profile",
        shape: shaped,
        corner: shaped && shape === "rect",
    };
}

export const RECT_MODES: { mode: RectMode; label: string }[] = [
    { mode: "corners", label: "Corners" },
    { mode: "center", label: "Center and size" },
];

/** A rectangle's two corners from its center and its size. */
export function cornersOf(cx: number, cy: number, width: number, height: number): [number, number, number, number] {
    return [cx - width / 2, cy - height / 2, cx + width / 2, cy + height / 2];
}

/** A rectangle's center and size from two corners. */
export function centerOf(x0: number, y0: number, x1: number, y1: number): [number, number, number, number] {
    return [(x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0), Math.abs(y1 - y0)];
}

/**
 * The fields against the selected job: `new` with no Plot page job
 * selected, `outside` when the fields are not one of its operations,
 * `applied` when they match the operation they were taken from, `changed`
 * when they no longer do (or no longer read).
 */
export type ApplyState = "new" | "outside" | "applied" | "changed";

export function applyState(ops: MillOperation[] | null, editing: number | null, op: MillOperation | null): ApplyState {
    if (ops === null) {
        return "new";
    }
    if (editing === null || editing >= ops.length) {
        return "outside";
    }
    return op !== null && sameOperation(ops[editing]!, op) ? "applied" : "changed";
}

/** What the mark says, naming the operation Apply would replace. */
export function applyText(state: ApplyState, editing: number | null): string {
    switch (state) {
        case "new":
            return "not in a job yet";
        case "outside":
            return "not in this job";
        case "applied":
            return `applied as operation ${(editing ?? 0) + 1}`;
        case "changed":
            return `changed from operation ${(editing ?? 0) + 1}`;
    }
}

/** What each button would do with the fields in that state, for the mark's title. */
export const APPLY_HINT: Record<ApplyState, string> = {
    new: "New job makes a job of this operation",
    outside: "Add to job puts this operation at the end of the job; New job makes a job of it alone",
    applied: "the fields are this operation of the job as it is kept",
    changed: "Apply puts the fields in place of the operation they were taken from; Add to job puts them at the end",
};

/** The selected job when it was made on this page (it keeps its operations), else null. */
export function plotJobOf(state: AppState): Job | null {
    const job = state.job;
    return job !== null && recipeOps(job.recipe).length > 0 ? job : null;
}

/** Whether a job has been moved or turned since it was made, so its operations are typed in a frame of their own. */
export function jobMoved(job: Job | null): boolean {
    return job !== null && (job.offset.x !== 0 || job.offset.y !== 0 || (job.rotation ?? 0) !== 0);
}

/**
 * A board position in the frame a Plot page job's operations are typed in,
 * from before the job was turned and moved: the inverse of the turn and
 * the shift that put the job where it is. The position itself with no job.
 */
export function boardToJob(point: Point, job: Job | null): Point {
    if (job === null) {
        return point;
    }
    const shifted: Point = [point[0] - job.offset.x, point[1] - job.offset.y];
    const degrees = job.rotation ?? 0;
    return degrees === 0 ? shifted : turnPoint(shifted, -degrees);
}

/** The operations planned: the job's with the edited one in its place, or with the fields' at the end, or the fields' alone. */
export function plannedOps(ops: MillOperation[] | null, editing: number | null, op: MillOperation): MillOperation[] {
    if (ops === null) {
        return [op];
    }
    if (editing !== null && editing < ops.length) {
        return ops.map((each, index) => (index === editing ? op : each));
    }
    return [...ops, op];
}

/** Points typed one a line as `x, y` (or `x y`); a blank line is skipped. */
export function parsePoints(text: string): Point[] | string {
    const points: Point[] = [];
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index]!.trim();
        if (line === "") {
            continue;
        }
        const parts = line.split(/[\s,;]+/).filter((part) => part !== "");
        const x = parts.length === 2 ? parseNumber(parts[0]!) : null;
        const y = parts.length === 2 ? parseNumber(parts[1]!) : null;
        if (x === null || y === null) {
            return `line ${index + 1} is not x, y: ${line}`;
        }
        points.push([x, y]);
    }
    return points;
}

/**
 * A kept number as a field shows it: to the micron when that reads back as
 * the very number, else every digit it takes (1/16 in is 1.5875), so an
 * operation put back in the fields reads as it was kept.
 */
export function fieldText(value: number): string {
    const short = formatMm(value);
    return Number(short) === value ? short : String(value);
}

export function pointsText(points: Point[]): string {
    return points.map(([x, y]) => `${fieldText(x)}, ${fieldText(y)}`).join("\n");
}

/** A job's holes by size, smallest first, with how many there are of each. */
export function holeSizes(holes: HolePoint[]): { size: number; count: number }[] {
    const counts = new Map<number, number>();
    for (const [, , diameter] of holes) {
        // In hundredths, a half rounded up: the backend's size_of does the
        // same arithmetic, so the sizes sent back match its holes.
        const size = Math.round(diameter * 100) / 100;
        counts.set(size, (counts.get(size) ?? 0) + 1);
    }
    return [...counts.entries()].sort(([a], [b]) => a - b).map(([size, count]) => ({ size, count }));
}

/** What is remembered of the fields besides the operation: the bit and the spot apart, and how a rectangle is given. */
export interface StoredFields {
    bit?: number;
    spot?: number;
    rectMode?: RectMode;
    rcx?: number;
    rcy?: number;
    rw?: number;
    rh?: number;
}

/** The fields remembered from the last visit; anything that does not read is left out. */
export function readStoredOperation(): Partial<MillOperation> & StoredFields {
    const text = readStored(MILL_KEY);
    try {
        const data: unknown = text ? JSON.parse(text) : null;
        return data && typeof data === "object" ? (data as Partial<MillOperation> & StoredFields) : {};
    } catch {
        return {};
    }
}

function storeOperation(op: Partial<MillOperation> & StoredFields): void {
    writeStored(MILL_KEY, JSON.stringify(op));
}

/** What cuts on this page: the connected machine's tool, else the one last used here, else the spindle. */
export function cutterOf(state: AppState, stored: Partial<MillOperation>): "spindle" | "laser" {
    if (state.snapshot.connected) {
        return profileOf(state.snapshot).tool === "laser" ? "laser" : "spindle";
    }
    return stored.cutter === "laser" ? "laser" : "spindle";
}

const DEFAULTS = {
    tool: 1,
    spot: 0.1,
    power: 500,
    passes: 1,
    depth: 0.5,
    step_down: 0.5,
    stepover: 0.4,
    speed: 300,
    plunge: 60,
    spindle: 10000,
};

export function mountMill(roots: { operation: HTMLElement; run: HTMLElement }, ctx: Ctx): void {
    const stored = readStoredOperation();
    let kind: MillKind = MILL_KINDS.some((entry) => entry.kind === stored.kind) ? stored.kind! : "drill";
    let shape: MillShape = stored.shape === "circle" ? "circle" : "rect";
    let side: MillSide = SIDES.some((entry) => entry.side === stored.side) ? stored.side! : "outside";
    let climb = stored.climb !== false;
    let rectMode: RectMode = stored.rectMode === "center" ? "center" : "corners";
    // The holes' job, and the sizes left out of it, kept apart from the
    // job's own list so a size comes back checked when the job does.
    let holesJob: Job | null = null;
    const skipped = new Set<number>();
    // The selected Plot page job's operations, the one of them in the
    // fields (null: the fields are an operation of their own), and the
    // holes of an operation taken from the job whose board job is gone.
    let plotJob: Job | null = null;
    let ops: MillOperation[] | null = null;
    let editing: number | null = null;
    let editingHoles: { job: string | null; holes: HolePoint[] } | null = null;
    // The corners the center and size fields were last written from, and
    // the texts written: while the fields still read so, the rectangle is
    // those corners to the last digit, not to the micron the fields show,
    // so an operation put in them, or a rectangle carried from its
    // corners, reads back as it was.
    let centerFrom: { texts: string[]; corners: [number, number, number, number] } | null = null;

    const field = (value: number | undefined, fallback: number, options: { min?: number; step?: number } = {}): HTMLInputElement =>
        numberField({ value: typeof value === "number" && Number.isFinite(value) ? value : fallback, ...options });
    // The bit and the spot are remembered apart: a page used with both
    // machines keeps each one's own.
    const storedBit = stored.bit ?? (stored.cutter !== "laser" ? stored.tool : undefined);
    const storedSpot = stored.spot ?? (stored.cutter === "laser" ? stored.tool : undefined);
    const tool = field(storedBit, DEFAULTS.tool, { min: 0.01, step: 0.1 });
    const spot = field(storedSpot, DEFAULTS.spot, { min: 0.01, step: 0.01 });
    const power = field(stored.power, DEFAULTS.power, { min: 0, step: 10 });
    const passes = field(stored.passes, DEFAULTS.passes, { min: 1, step: 1 });
    let cutter = cutterOf(ctx.store.get(), stored);
    const depth = field(stored.depth, DEFAULTS.depth, { min: 0.01, step: 0.1 });
    const stepDown = field(stored.step_down, DEFAULTS.step_down, { min: 0.01, step: 0.1 });
    const stepover = field(stored.stepover, DEFAULTS.stepover, { min: 0.05, step: 0.05 });
    const speed = field(stored.speed, DEFAULTS.speed, { min: 1, step: 10 });
    const plunge = field(stored.plunge, DEFAULTS.plunge, { min: 1, step: 10 });
    const spindle = field(stored.spindle, DEFAULTS.spindle, { min: 0, step: 100 });
    const x0 = field(stored.x0, 0);
    const y0 = field(stored.y0, 0);
    const x1 = field(stored.x1, 10);
    const y1 = field(stored.y1, 10);
    const [storedCx, storedCy, storedW, storedH] = centerOf(stored.x0 ?? 0, stored.y0 ?? 0, stored.x1 ?? 10, stored.y1 ?? 10);
    const rcx = field(stored.rcx, storedCx);
    const rcy = field(stored.rcy, storedCy);
    const rw = field(stored.rw, storedW, { min: 0, step: 1 });
    const rh = field(stored.rh, storedH, { min: 0, step: 1 });
    const corner = field(stored.corner, 0, { min: 0, step: 0.5 });
    const cx = field(stored.cx, 0);
    const cy = field(stored.cy, 0);
    const diameter = field(stored.diameter, 10, { min: 0 });
    const name = el("input", { type: "text", class: "field", placeholder: "made from the operations", spellcheck: "false", "aria-label": "Job name" }) as HTMLInputElement;
    const points = el("textarea", { class: "field mill-points", rows: "4", spellcheck: "false", placeholder: "x, y\none point a line", "aria-label": "Points" }) as HTMLTextAreaElement;
    points.value = Array.isArray(stored.points) ? pointsText(stored.points) : "";
    const closed = el("input", { type: "checkbox", "aria-label": "Closed line" }) as HTMLInputElement;
    closed.checked = stored.closed === true;
    const bore = el("input", { type: "checkbox", "aria-label": "Bore wide holes" }) as HTMLInputElement;
    bore.checked = stored.bore !== false;
    const boreText = el("span", {});
    const holesSelect = el("select", { class: "field", "aria-label": "Job with holes" }) as HTMLSelectElement;
    const sizesBox = el("div", { class: "hole-sizes" });

    const labels: Record<string, HTMLLabelElement> = {
        tool: labeled("Bit mm", tool),
        depth: labeled("Depth mm", depth),
        stepDown: labeled("Step down mm", stepDown),
        stepover: labeled("Stepover", stepover),
        speed: labeled("Feed mm/min", speed),
        plunge: labeled("Plunge mm/min", plunge),
        spindle: labeled("Spindle S", spindle),
        spot: labeled("Spot mm", spot),
        power: labeled("Power S", power),
        passes: labeled("Passes", passes),
    };
    for (const label of Object.values(labels)) {
        label.querySelector("input")?.setAttribute("aria-label", label.querySelector(".labeled-text")?.textContent ?? "");
    }
    labels["stepover"]!.title = "how far apart a face's rows or a pocket's loops are, as a share of the bit";
    labels["depth"]!.title = "how deep under the surface the cut ends";
    labels["stepDown"]!.title = "how far each pass goes down: the passes are as many as it takes to the depth";
    labels["spot"]!.title = "the beam's width on the work, mm: paths are offset by half of it";
    labels["passes"]!.title = "how many times each path is burnt";
    // On a laser the speed is the beam's along the cut, not a feed.
    const speedText = labels["speed"]!.querySelector(".labeled-text");

    /**
     * A position on the board as the fields take it: in the selected Plot
     * page job's frame from before it was moved, where its operations are
     * typed, so it lands there again when the job is made.
     */
    const fromBoard = (x: number, y: number): Point => boardToJob([x, y], plotJob);

    /** A row of two fields with a button that fills them from the head and a pick of the markers. */
    const pointRow = (title: string, fx: HTMLInputElement, fy: HTMLInputElement): HTMLElement => {
        fx.setAttribute("aria-label", `${title} x`);
        fy.setAttribute("aria-label", `${title} y`);
        const here = button("Here", () => {
            const head = headPosition(ctx.store.get());
            if (!head) {
                ctx.toast("error", "no head position: connect the machine first");
                return;
            }
            fill([fx, fy], fromBoard(head.x, head.y));
            changed();
        }, "btn btn-quiet btn-small");
        here.title = "take where the head is over the board";
        const pick = markerPicker(ctx, "marker", (marker) => {
            fill([fx, fy], fromBoard(marker.x, marker.y));
            changed();
        });
        return el("div", { class: "goto-row mill-point" }, el("span", { class: "choice-label" }, title), fx, fy, here, pick);
    };

    const kinds = choiceRow(MILL_KINDS.map((entry) => entry.kind), kind, (picked) => {
        kind = picked;
        changed();
    }, (value) => MILL_KINDS.find((entry) => entry.kind === value)!.label);
    kinds.classList.add("choice-wrap");
    kinds.setAttribute("aria-label", "Operation");
    const shapes = choiceRow(SHAPES.map((entry) => entry.shape), shape, (picked) => {
        shape = picked;
        changed();
    }, (value) => SHAPES.find((entry) => entry.shape === value)!.label, "Shape");
    const rectModes = choiceRow(RECT_MODES.map((entry) => entry.mode), rectMode, (picked) => setRectMode(picked), (value) => RECT_MODES.find((entry) => entry.mode === value)!.label, "By");
    rectModes.title = "give the rectangle by two corners, or by its center, its width and its height";
    const sides = choiceRow(SIDES.map((entry) => entry.side), side, (picked) => {
        side = picked;
        changed();
    }, (value) => SIDES.find((entry) => entry.side === value)!.label, "Side");
    const directions = choiceRow([true, false], climb, (picked) => {
        climb = picked;
        changed();
    }, (value) => (value ? "Climb" : "Conventional"), "Cut");
    directions.title = "with the spindle turning clockwise: climb runs counterclockwise inside a pocket and clockwise around a part";

    const addHere = button("Add here", () => {
        const head = headPosition(ctx.store.get());
        if (!head) {
            ctx.toast("error", "no head position: connect the machine first");
            return;
        }
        appendPoint(fromBoard(head.x, head.y));
    }, "btn btn-quiet btn-small");
    addHere.title = "add where the head is over the board";
    const addMarker = markerPicker(ctx, "add marker", (marker) => appendPoint(fromBoard(marker.x, marker.y)));
    const addAll = button("All markers", () => {
        for (const marker of ctx.store.get().markers) {
            appendPoint(fromBoard(marker.x, marker.y));
        }
    }, "btn btn-quiet btn-small");
    const clearPoints = button("Clear", () => {
        points.value = "";
        changed();
    }, "btn btn-quiet btn-small");
    const closedLabel = el("label", { class: "muted" }, closed, " back to the first point");

    const pointsLabel = labeled("Points, board mm", points);
    const pointsLabelText = pointsLabel.querySelector(".labeled-text");
    const pointsBox = el("div", { class: "mill-section" },
        pointsLabel,
        el("div", { class: "button-row" }, addHere, addMarker, addAll, clearPoints, closedLabel),
    );
    rw.setAttribute("aria-label", "Width");
    rh.setAttribute("aria-label", "Height");
    corner.setAttribute("aria-label", "Corner radius");
    const cornersBox = el("div", {}, pointRow("Corner", x0, y0), pointRow("Corner", x1, y1));
    const centerBox = el("div", {}, pointRow("Center", rcx, rcy), el("div", { class: "field-row" }, labeled("Width mm", rw), labeled("Height mm", rh)));
    const cornerLabel = labeled("Corner R mm", corner);
    cornerLabel.title = "the radius the rectangle's corners are rounded to, 0 for square ones; inside, a corner tighter than the bit gets the bit's";
    const rectBox = el("div", { class: "mill-section" }, rectModes, cornersBox, centerBox, el("div", { class: "field-row" }, cornerLabel));
    diameter.setAttribute("aria-label", "Diameter");
    const circleBox = el("div", { class: "mill-section" }, pointRow("Center", cx, cy), el("div", { class: "field-row" }, labeled("Diameter mm", diameter)));
    const holesBox = el("div", { class: "mill-section" },
        labeled("Holes of", holesSelect),
        sizesBox,
        el("label", { class: "muted" }, bore, boreText),
    );
    const cutGrid = el("div", { class: "field-grid" }, ...Object.values(labels));
    const notes = el("ul", { class: "mill-notes muted" });
    const problem = el("p", { class: "mill-problem hidden", role: "alert" });
    const applyButton = button("Apply", () => apply(), "btn btn-primary");
    applyButton.title = "put the fields in the job in place of the operation they were taken from";
    const addButton = button("Add to job", () => add(), "btn");
    addButton.title = "put the operation at the end of the selected job, or make a job of it when none is selected";
    const newButton = button("New job", () => makeNew(), "btn");
    newButton.title = "make a job of this operation alone, selected, ready to run";
    const stateBadge = el("span", { class: "badge plot-state" });
    const jobTitle = el("span", { class: "plot-job-title muted" });
    const opList = el("ol", { class: "plot-ops" });
    const machineNote = el("p", { class: "muted hint hidden" });
    const hint = el("p", { class: "muted hint" });

    roots.operation.append(
        el("div", { class: "panel-head" }, el("h2", {}, "Operation"), el("div", { class: "button-row" }, applyButton, addButton, newButton)),
        el("div", { class: "plot-job" }, el("div", { class: "plot-job-head" }, jobTitle, stateBadge), opList),
        kinds,
        shapes,
        sides,
        rectBox,
        circleBox,
        pointsBox,
        holesBox,
        cutGrid,
        directions,
        labeled("Name", name),
        problem,
        notes,
        machineNote,
        hint,
    );

    for (const input of [tool, spot, power, passes, depth, stepDown, stepover, speed, plunge, spindle, x0, y0, x1, y1, rcx, rcy, rw, rh, corner, cx, cy, diameter, name, points]) {
        input.addEventListener("input", () => changed());
    }
    for (const input of [closed, bore]) {
        input.addEventListener("change", () => changed());
    }
    holesSelect.addEventListener("change", () => {
        editingHoles = null;
        void loadHoles(holesSelect.value);
    });

    /** Each field given its number, as the fields write them. */
    function fill(inputs: HTMLInputElement[], values: readonly number[]): void {
        inputs.forEach((input, index) => {
            input.value = formatMm(values[index] ?? 0);
        });
    }

    /** Each field given a kept number, every digit it takes to read back as it. */
    function fillKept(inputs: HTMLInputElement[], values: readonly number[]): void {
        inputs.forEach((input, index) => {
            input.value = fieldText(values[index] ?? 0);
        });
    }

    /** The center and size fields written from a rectangle's corners, which they stand for while they read as written. */
    function writeCenter(corners: [number, number, number, number]): void {
        fill([rcx, rcy, rw, rh], centerOf(...corners));
        centerFrom = { texts: [rcx, rcy, rw, rh].map((input) => input.value), corners };
    }

    /** The corners the center and size fields were written from, while they still read as written; else null. */
    function keptCenter(): [number, number, number, number] | null {
        const from = centerFrom;
        return from !== null && [rcx, rcy, rw, rh].every((input, index) => input.value === from.texts[index]) ? from.corners : null;
    }

    function appendPoint(point: Point): void {
        const text = points.value.trimEnd();
        points.value = `${text}${text ? "\n" : ""}${formatMm(point[0])}, ${formatMm(point[1])}`;
        changed();
    }

    /** Switches how the rectangle is given, carrying the rectangle across. */
    function setRectMode(mode: RectMode): void {
        if (mode === rectMode) {
            return;
        }
        const kept = mode === "corners" ? keptCenter() : null;
        const from = mode === "center" ? [x0, y0, x1, y1] : [rcx, rcy, rw, rh];
        const values = from.map((input) => parseNumber(input.value));
        if (kept !== null) {
            // The center fields untouched since they were written from
            // these corners: the corners as they were, every digit.
            fillKept([x0, y0, x1, y1], kept);
        } else if (values.every((value): value is number => value !== null)) {
            const [a, b, c, d] = values as [number, number, number, number];
            if (mode === "center") {
                writeCenter([a, b, c, d]);
            } else {
                fill([x0, y0, x1, y1], cornersOf(a, b, c, d));
            }
        }
        rectMode = mode;
        setPressed(rectModes, RECT_MODES.find((entry) => entry.mode === mode)!.label);
        changed();
    }

    /** The operation the fields describe, or what is wrong with them. */
    function read(): MillOperation | string {
        const number = (input: HTMLInputElement, what: string): number | string => parseNumber(input.value) ?? `${what} needs a number`;
        const laser = cutter === "laser";
        const values = {
            tool: laser ? number(spot, "the spot") : number(tool, "the bit"),
            power: number(power, "the power"),
            passes: number(passes, "the passes"),
            depth: number(depth, "the depth"),
            step_down: number(stepDown, "the step down"),
            stepover: number(stepover, "the stepover"),
            speed: number(speed, "the feed"),
            plunge: number(plunge, "the plunge"),
            spindle: number(spindle, "the spindle speed"),
            x0: number(x0, "a corner"),
            y0: number(y0, "a corner"),
            x1: number(x1, "a corner"),
            y1: number(y1, "a corner"),
            rcx: number(rcx, "the center"),
            rcy: number(rcy, "the center"),
            rw: number(rw, "the width"),
            rh: number(rh, "the height"),
            corner: number(corner, "the corner radius"),
            cx: number(cx, "the center"),
            cy: number(cy, "the center"),
            diameter: number(diameter, "the diameter"),
        };
        const needs = millNeeds(kind, shape);
        const used = laser ? ["tool", "speed", "power", "passes"] : ["tool", "depth", "step_down", "speed", "plunge", "spindle"];
        if (needs.stepover) {
            used.push("stepover");
        }
        if (needs.rect) {
            used.push(...(rectMode === "center" ? ["rcx", "rcy", "rw", "rh"] : ["x0", "y0", "x1", "y1"]));
        }
        if (needs.corner) {
            used.push("corner");
        }
        if (needs.circle) {
            used.push("cx", "cy", "diameter");
        }
        for (const key of used) {
            const value = values[key as keyof typeof values];
            if (typeof value === "string") {
                return value;
            }
        }
        const numbers = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, typeof value === "number" ? value : 0])) as Record<keyof typeof values, number>;
        if (laser && !Number.isInteger(numbers.passes)) {
            return "the passes are a whole number";
        }
        if (needs.rect && rectMode === "center") {
            if (numbers.rw < 0 || numbers.rh < 0) {
                return "the width and the height are 0 or more";
            }
            [numbers.x0, numbers.y0, numbers.x1, numbers.y1] = keptCenter() ?? cornersOf(numbers.rcx, numbers.rcy, numbers.rw, numbers.rh);
        }
        let list: Point[] = [];
        if (needs.points) {
            const parsed = parsePoints(points.value);
            if (typeof parsed === "string") {
                return parsed;
            }
            list = parsed;
        }
        let sizes: number[] | null = null;
        let jobId: string | null = null;
        let holes: HolePoint[] | null = null;
        if (needs.holes) {
            if (holesJob) {
                jobId = holesJob.id;
                sizes = holeSizes(holesJob.holes ?? []).map((entry) => entry.size).filter((size) => !skipped.has(size));
            } else if (editingHoles) {
                // An operation of the job whose board job is gone: its own holes.
                jobId = editingHoles.job;
                holes = editingHoles.holes;
                sizes = holeSizes(holes).map((entry) => entry.size).filter((size) => !skipped.has(size));
            } else {
                return "pick a job with drill holes";
            }
        }
        const { rcx: _rcx, rcy: _rcy, rw: _rw, rh: _rh, ...opNumbers } = numbers;
        return {
            kind,
            cutter,
            name: null,
            ...opNumbers,
            corner: needs.corner ? numbers.corner : 0,
            climb,
            points: list,
            closed: closed.checked,
            shape,
            side,
            job: jobId,
            sizes,
            bore: bore.checked,
            holes,
        };
    }

    /** Puts an operation of the job in the fields. */
    function setFields(op: MillOperation): void {
        const full: MillOperation = { ...defaultOperation(op.kind), ...op };
        kind = full.kind;
        shape = full.shape;
        side = full.side;
        climb = full.climb;
        setPressed(kinds, MILL_KINDS.find((entry) => entry.kind === kind)!.label);
        setPressed(shapes, SHAPES.find((entry) => entry.shape === shape)!.label);
        setPressed(sides, SIDES.find((entry) => entry.side === side)!.label);
        setPressed(directions, climb ? "Climb" : "Conventional");
        // Every number as kept, so the fields read back as this operation.
        (full.cutter === "laser" ? spot : tool).value = fieldText(full.tool);
        power.value = String(full.power ?? DEFAULTS.power);
        passes.value = String(full.passes ?? DEFAULTS.passes);
        depth.value = fieldText(full.depth);
        stepDown.value = fieldText(full.step_down);
        stepover.value = String(full.stepover);
        speed.value = String(full.speed);
        plunge.value = String(full.plunge);
        spindle.value = String(full.spindle);
        fillKept([x0, y0, x1, y1], [full.x0, full.y0, full.x1, full.y1]);
        writeCenter([full.x0, full.y0, full.x1, full.y1]);
        corner.value = fieldText(full.corner ?? 0);
        fillKept([cx, cy, diameter], [full.cx, full.cy, full.diameter]);
        points.value = pointsText(full.points);
        closed.checked = full.closed;
        bore.checked = full.bore;
        editingHoles = null;
        if (full.kind === "holes") {
            const source = ctx.store.get().jobs.find((job) => job.id === full.job);
            skipped.clear();
            const all = holeSizes(full.holes ?? []).map((entry) => entry.size);
            const wanted = full.sizes ? new Set(full.sizes) : null;
            for (const size of all) {
                if (wanted !== null && !wanted.has(size)) {
                    skipped.add(size);
                }
            }
            if (source && !full.holes) {
                // Made before operations kept their holes: the board job's.
                holesSelect.value = source.id;
                void loadHoles(source.id);
            } else {
                // Its own holes, where they were when it was made, as the
                // job's other operations are: the board job's may have moved
                // since. Picking a job in the select takes that job's again.
                holesSelect.value = source ? source.id : "";
                holesJob = null;
                editingHoles = { job: full.job ?? null, holes: full.holes ?? [] };
                renderSizes();
            }
        }
    }

    function show(): void {
        const needs = millNeeds(kind, shape);
        const laser = cutter === "laser";
        shapes.classList.toggle("hidden", !needs.shape);
        sides.classList.toggle("hidden", !needs.side);
        // A beam cuts the same either way round.
        directions.classList.toggle("hidden", !needs.direction || laser);
        for (const key of ["tool", "depth", "stepDown", "plunge", "spindle"]) {
            labels[key]!.classList.toggle("hidden", laser);
        }
        for (const key of ["spot", "power", "passes"]) {
            labels[key]!.classList.toggle("hidden", !laser);
        }
        if (speedText) {
            speedText.textContent = laser ? "Speed mm/min" : "Feed mm/min";
        }
        boreText.textContent = laser
            ? " clear a hole wider than the spot in rings, rather than cut along its edge"
            : " bore a hole wider than the bit out with it, in rings";
        // A job moved or turned on the Jobs page has its operations typed
        // where they were before the move.
        const moved = jobMoved(plotJob);
        const where = moved
            ? `positions are ${plotJob!.name}'s own, from before it was moved or turned on the Jobs page: Here and the markers are taken into them, and the plan and the job made are put where it now is`
            : "positions are board mm";
        if (pointsLabelText) {
            pointsLabelText.textContent = moved ? "Points, the job's mm" : "Points, board mm";
        }
        hint.textContent = laser
            ? `${where}; a point is marked with a ring the spot across, and each pass burns the whole path again; fields take arithmetic, such as 25.4/2 or 1/8 in`
            : `${where}; the depth is under the surface where the tool was zeroed; fields take arithmetic, such as 25.4/2 or 1/8 in`;
        rectBox.classList.toggle("hidden", !needs.rect);
        cornersBox.classList.toggle("hidden", rectMode !== "corners");
        centerBox.classList.toggle("hidden", rectMode !== "center");
        cornerLabel.classList.toggle("hidden", !needs.corner);
        circleBox.classList.toggle("hidden", !needs.circle);
        pointsBox.classList.toggle("hidden", !needs.points);
        closedLabel.classList.toggle("hidden", !needs.closed);
        holesBox.classList.toggle("hidden", !needs.holes);
        labels["stepover"]!.classList.toggle("hidden", !needs.stepover);
    }

    /** The mark of the fields against the job, the job's list, and what the buttons may do. */
    function renderJob(): void {
        const op = read();
        const state = applyState(ops, editing, typeof op === "string" ? null : op);
        stateBadge.textContent = applyText(state, editing);
        stateBadge.title = APPLY_HINT[state];
        stateBadge.setAttribute("data-state", state);
        setPending(ctx.store, "plot", state === "changed" ? 1 : 0);
        jobTitle.textContent = plotJob && ops
            ? `${plotJob.name}: ${ops.length} operation${ops.length === 1 ? "" : "s"}${editing !== null ? `, number ${editing + 1} in the fields` : ""}`
            : "no Plot page job selected";
        setLocked(applyButton, state !== "changed");
        setLocked(addButton, typeof op === "string");
        setLocked(newButton, typeof op === "string");
        addButton.textContent = plotJob ? "Add to job" : "Add to new job";
        replace(opList, ...(ops ?? []).map((each, index) => {
            const edit = button(operationSummary(each), () => {
                editing = index;
                setFields(each);
                changed();
            }, "btn btn-quiet btn-small plot-op-pick");
            edit.title = "put this operation in the fields to change it";
            const up = button("Up", () => move(index), "btn btn-quiet btn-small");
            up.title = "cut this operation before the one above it";
            setLocked(up, index === 0);
            const remove = button("Remove", () => removeOp(index), "btn btn-quiet btn-small");
            remove.title = "take this operation out of the job";
            const row = el("li", { class: "plot-op" }, edit, el("span", { class: "button-row" }, up, remove));
            row.classList.toggle("editing", index === editing);
            return row;
        }));
    }

    // Planned again a moment after the typing stops; a reply that a later
    // request has overtaken is dropped.
    let timer: ReturnType<typeof setTimeout> | null = null;
    let ticket = 0;
    function changed(): void {
        show();
        const op = read();
        if (typeof op !== "string") {
            storeOperation({
                ...op,
                job: null,
                sizes: null,
                holes: null,
                bit: parseNumber(tool.value) ?? undefined,
                spot: parseNumber(spot.value) ?? undefined,
                rectMode,
                rcx: parseNumber(rcx.value) ?? undefined,
                rcy: parseNumber(rcy.value) ?? undefined,
                rw: parseNumber(rw.value) ?? undefined,
                rh: parseNumber(rh.value) ?? undefined,
            });
        }
        renderJob();
        if (timer !== null) {
            clearTimeout(timer);
        }
        timer = setTimeout(() => {
            timer = null;
            void plan();
        }, PLAN_DELAY_MS);
    }

    function showProblem(text: string): void {
        problem.textContent = text;
        problem.classList.toggle("hidden", text === "");
    }

    /** The job's name for a request: the field's, or for a job already made, its own. */
    function jobName(): string | null {
        return name.value.trim() || plotJob?.name || null;
    }

    async function plan(): Promise<void> {
        const op = read();
        const mine = ++ticket;
        if (typeof op === "string") {
            showProblem(op);
            replace(notes);
            ctx.store.set({ millPlan: null, millDims: [] });
            return;
        }
        // The sizes go where the job is: a job moved on the Jobs page takes
        // its operations with it.
        const dims = operationDims(op, rectMode);
        ctx.store.set({ millDims: plotJob ? movedDims(dims, plotJob.rotation ?? 0, plotJob.offset.x, plotJob.offset.y) : dims });
        try {
            const planned = await ctx.api.planMill({ ops: plannedOps(ops, editing, op), name: jobName(), job: plotJob?.id ?? null });
            if (mine !== ticket) {
                return;
            }
            showProblem("");
            replace(notes, ...planned.notes.map((note) => el("li", {}, note)));
            ctx.store.set({ millPlan: planned.job });
        } catch (error) {
            if (mine !== ticket) {
                return;
            }
            showProblem(error instanceof Error ? error.message : String(error));
            replace(notes);
            ctx.store.set({ millPlan: null });
        }
    }

    /**
     * Sends the job's operations: in the place of the selected job, or as a
     * new one; selects what came back. A new one made while a Plot page job
     * is selected is put as that job is, since the fields are typed in its
     * frame and the plan showed them there.
     */
    async function send(list: MillOperation[], into: Job | null, nextEditing: number | null, what: string): Promise<void> {
        const body = into
            ? { ops: list, name: jobName(), job: into.id }
            : { ops: list, name: name.value.trim() || null, job: null, like: plotJob?.id ?? null };
        const made = await ctx.call(ctx.api.makeMill(body));
        if (!made) {
            return;
        }
        // Set before the selection lands, so the job's arrival keeps the
        // operation in the fields marked as the one it is.
        plotJob = made.job;
        ops = recipeOps(made.job.recipe);
        editing = nextEditing;
        await ctx.refreshJobs();
        await ctx.selectJob(made.job.id);
        if (into) {
            await ctx.reloadJob(made.job.id);
        }
        // The plan stays up and is made again for the job as it now is,
        // so the view is not fitted again under the operator.
        ctx.toast("info", `${what} ${made.job.name}`);
        changed();
    }

    async function apply(): Promise<void> {
        const op = read();
        if (typeof op === "string") {
            showProblem(op);
            return;
        }
        if (!plotJob || !ops || editing === null) {
            return;
        }
        await send(plannedOps(ops, editing, op), plotJob, editing, "applied to");
    }

    async function add(): Promise<void> {
        const op = read();
        if (typeof op === "string") {
            showProblem(op);
            return;
        }
        if (!plotJob || !ops) {
            await makeNew();
            return;
        }
        await send([...ops, op], plotJob, ops.length, "added to");
    }

    async function makeNew(): Promise<void> {
        const op = read();
        if (typeof op === "string") {
            showProblem(op);
            return;
        }
        await send([op], null, 0, "made");
    }

    async function move(index: number): Promise<void> {
        if (!plotJob || !ops || index < 1) {
            return;
        }
        const list = [...ops];
        [list[index - 1], list[index]] = [list[index]!, list[index - 1]!];
        const next = editing === index ? index - 1 : editing === index - 1 ? index : editing;
        await send(list, plotJob, next, "moved an operation in");
    }

    async function removeOp(index: number): Promise<void> {
        if (!plotJob || !ops) {
            return;
        }
        if (ops.length === 1) {
            ctx.toast("error", "a job keeps at least one operation: delete the job on the Jobs page");
            return;
        }
        if (!(await askConfirm(`Take operation ${index + 1}, ${operationSummary(ops[index]!)}, out of ${plotJob.name}?`, "Remove"))) {
            return;
        }
        const next = editing === null || editing === index ? null : editing > index ? editing - 1 : editing;
        await send(ops.filter((_, at) => at !== index), plotJob, next, "took an operation out of");
    }

    async function loadHoles(id: string): Promise<void> {
        holesJob = null;
        renderSizes();
        if (id === "") {
            changed();
            return;
        }
        const job = await ctx.call(ctx.api.job(id));
        if (job && holesSelect.value === id) {
            holesJob = job;
            editingHoles = null;
            renderSizes();
        }
        changed();
    }

    function renderSizes(): void {
        const sizes = holeSizes(holesJob?.holes ?? editingHoles?.holes ?? []);
        replace(sizesBox, ...sizes.map(({ size, count }) => {
            const box = el("input", { type: "checkbox", "aria-label": `${size} mm holes` }) as HTMLInputElement;
            box.checked = !skipped.has(size);
            box.addEventListener("change", () => {
                if (box.checked) {
                    skipped.delete(size);
                } else {
                    skipped.add(size);
                }
                changed();
            });
            return el("label", { class: "hole-size" }, box, ` ${size.toFixed(2)} mm `, el("span", { class: "muted" }, `x${count}`));
        }));
        if ((holesJob || editingHoles) && sizes.length === 0) {
            sizesBox.append(el("p", { class: "muted" }, "this job has no drill holes"));
        }
    }

    function renderJobs(state: AppState): void {
        const picked = holesSelect.value;
        const withHoles = state.jobs.filter((job) => (job.holes ?? 0) > 0);
        replace(holesSelect,
            el("option", { value: "" }, withHoles.length ? "a job with drill holes" : "no job has drill holes"),
            ...withHoles.map((job) => el("option", { value: job.id }, `${job.name} (${job.holes} holes)`)),
        );
        if (withHoles.some((job) => job.id === picked)) {
            holesSelect.value = picked;
        } else if (picked !== "") {
            holesSelect.value = "";
            void loadHoles("");
        }
    }

    function renderMachine(state: AppState): void {
        const dispenser = state.snapshot.connected && profileOf(state.snapshot).tool === "dispenser";
        machineNote.textContent = dispenser ? "the machine is a dispenser, which lays dots: a job made here cuts with a spindle or a laser" : "";
        machineNote.classList.toggle("hidden", !dispenser);
        // The operation follows the machine: planned again for its cutter.
        // A page the machine goes away from keeps the cutter it was using,
        // not the one stored when the page was mounted.
        const now = state.snapshot.connected ? cutterOf(state, stored) : cutter;
        if (now !== cutter) {
            cutter = now;
            changed();
        }
    }

    /** The selected job, when it is a Plot page job, is the one the buttons work on. */
    function renderSelected(state: AppState): void {
        const job = plotJobOf(state);
        if (job?.id !== plotJob?.id) {
            editing = null;
            // A name typed is for the job it was typed with: the next job
            // selected keeps its own (a job just made is set as plotJob
            // before it is selected, so it keeps the name it was made with).
            name.value = "";
        }
        plotJob = job;
        ops = job ? recipeOps(job.recipe) : null;
        if (editing !== null && (ops === null || editing >= ops.length)) {
            editing = null;
        }
        changed();
    }

    ctx.store.subscribe((state) => renderJobs(state), ["jobs"]);
    ctx.store.subscribe((state) => renderMachine(state), ["snapshot"]);
    ctx.store.subscribe((state) => renderSelected(state), ["job"]);
    renderJobs(ctx.store.get());
    renderMachine(ctx.store.get());
    setPressed(kinds, MILL_KINDS.find((entry) => entry.kind === kind)!.label);
    plotJob = plotJobOf(ctx.store.get());
    ops = plotJob ? recipeOps(plotJob.recipe) : null;
    show();
    renderJob();
    void plan();

    mountMillRun(roots.run, ctx);
}

/** The run panel: the selected job, how it follows the height map, and its run controls and progress. */
function mountMillRun(root: HTMLElement, ctx: Ctx): void {
    const title = el("span", { class: "muted mill-run-job" });
    const stats = el("p", { class: "muted" });
    const compensate = el("select", { class: "field", "aria-label": "Height map" },
        el("option", { value: "off" }, "no height map"),
        el("option", { value: "auto" }, "height map: auto"),
    ) as HTMLSelectElement;
    const runButton = button("Run", () => run(), "btn btn-primary");
    const holdButton = button("Hold", () => ctx.call(ctx.api.runHold()), "btn");
    const resumeButton = button("Resume", () => ctx.call(ctx.api.runResume()), "btn");
    const stopButton = button("Stop", () => ctx.call(ctx.api.runStop()), "btn btn-danger");
    const progressBar = el("div", { class: "progress-fill" });
    const progressState = el("span", { class: "badge run-state" });
    const progressCounts = el("span", { class: "progress-counts" });
    const progressTime = el("span", { class: "progress-time" });
    const progressReason = el("span", { class: "progress-reason" });
    const progressBox = el("div", { class: "progress hidden" },
        el("div", { class: "progress-track" }, progressBar),
        el("div", { class: "progress-text" }, progressState, progressCounts, progressTime, progressReason),
    );
    const mapNote = el("p", { class: "muted hint hidden" });
    root.append(
        el("div", { class: "panel-head" }, el("h2", {}, "Run"), title),
        stats,
        el("div", { class: "run-row" }, runButton, compensate, holdButton, resumeButton, stopButton),
        mapNote,
        progressBox,
        el("p", { class: "muted hint" }, "runs the selected job, here or from the Jobs panel; zero the depth on the surface first on a mill, focus the beam on a laser"),
    );

    async function run(): Promise<void> {
        const job = ctx.store.get().job;
        if (!job) {
            return;
        }
        await withFocusHere(ctx, (focusHere) => ctx.api.runJob(job.id, compensate.value as Compensate, focusHere), "Focused here: run");
        await ctx.refreshState();
    }

    function render(state: AppState): void {
        const job = state.job;
        title.textContent = job ? job.name : "no job selected";
        stats.textContent = job ? `${formatLength(job.stats.length_mm)}, about ${formatDuration(job.stats.seconds)}, ${job.groups.filter((group) => group.enabled).length} of ${job.groups.length} groups on` : "make a job, or select one in the Jobs panel";
        const progress = state.progress ?? state.snapshot.run;
        const text = progressText(progress);
        progressBar.style.width = `${(text.bar * 100).toFixed(1)}%`;
        progressState.textContent = text.state;
        progressState.setAttribute("data-run", text.state);
        progressCounts.textContent = text.counts;
        progressTime.textContent = text.time;
        progressReason.textContent = text.reason;
        progressBox.classList.toggle("hidden", progress === null || progress.job !== job?.id);
        const active = progress !== null && (progress.state === "running" || progress.state === "hold");
        const connected = state.snapshot.connected;
        setLocked(runButton, !connected || active || !job);
        setLocked(holdButton, !connected || !active || progress?.state !== "running");
        setLocked(resumeButton, !connected || !active || progress?.state !== "hold");
        setLocked(stopButton, !connected || !active);
        compensate.disabled = active;
        const auto = compensate.value === "auto";
        const usable = mapUsable(state.heightMap?.map ?? null);
        mapNote.textContent = auto && !usable ? "no usable height map: the run is refused until one is probed and its offset taken" : "";
        mapNote.classList.toggle("hidden", mapNote.textContent === "");
    }

    compensate.addEventListener("change", () => render(ctx.store.get()));
    ctx.store.subscribe((state) => render(state), ["job", "progress", "snapshot", "heightMap"]);
    render(ctx.store.get());
}
