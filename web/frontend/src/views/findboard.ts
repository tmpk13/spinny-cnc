// The Find board panel: one camera's look for the selected job's board, the
// camera picked from those that can look for one (the head camera, and with
// a G-code machine its top camera), a running one unless another is picked.
// Look for board loads the job's board into the camera's pcbv; Search moves
// the camera over a box until a guess is likely enough; Use as board place
// keeps where the board found (else the corners taken) puts the board: the
// top camera's as the job's references, the head camera's as alignment
// marks. The guesses the looks make are columns of their share of the
// evidence, the camera's threshold a line across them that a drag or the
// slider moves: the most likely guess is called found once it has enough
// looks and reaches the line. Corners of the board taken by hand (the
// picture's center put on each) rule out the guesses that put one elsewhere
// and give a rough place of their own (boardlook.py on the backend). A
// search starts where the board is known to be and tells pcbv so; a line
// says what said where. The camera's look method picks how the board is
// called found: the vote among guesses, or the probability over the board's
// pose (posterior.py), whose columns are its places' probabilities with one
// more for where nothing has looked yet.

import { errorText } from "../api.ts";
import { CORNER_NAMES } from "../corners.ts";
import { button, el, labeled, lockFor, numberField, readStored, setLocked, Tracked, writeStored } from "../dom.ts";
import { formatFixed, formatPercent as percent, parseNumber } from "../format.ts";
import type { AppState } from "../state.ts";
import type { BoardCorners, BoardGuess, BoardKnown, BoardLook, BoardStretch, CornerName, LookMethod, RefineUse, ScanMosaic, SkewState } from "../types.ts";
import { into, type Ctx } from "./context.ts";
import type { MachineBox } from "./picture.ts";
import { gcodePlacing } from "./placing.ts";
import { mountMosaic } from "./mosaic.ts";
import { lookText } from "./vision.ts";

/** The cameras that can look for a board. */
export type LookCamera = "head" | "top";

/** The threshold a camera keeps when it says none, as the backend's. */
const DEFAULT_THRESHOLD = 0.5;
/** The guesses a graph has room for, as many as the backend sends. */
const SLOTS = 8;

interface LookSource {
    label: string;
    /** The camera is there to pick: the head camera always, the top camera with a G-code machine or while it runs. */
    present(state: AppState): boolean;
    running(state: AppState): boolean;
    device(state: AppState): string | null;
    look(state: AppState): BoardLook | null;
    /** One of the camera's routines runs: its search among them. */
    busy(state: AppState): boolean;
    searching(state: AppState): boolean;
    scanning(state: AppState): boolean;
    /** A place measured for the job's board besides a find or corners: the Align fit (head camera), the references (top camera). */
    placeKnown(state: AppState, job: string): boolean;
}

const SOURCES: Record<LookCamera, LookSource> = {
    head: {
        label: "Head camera",
        present: () => true,
        running: (state) => state.camera?.running === true,
        device: (state) => state.camera?.device ?? null,
        look: (state) => state.camera?.board_look ?? null,
        busy: (state) => state.camera?.routine?.state === "running",
        searching: (state) => state.camera?.routine?.state === "running" && state.camera.routine.kind === "search",
        scanning: (state) => state.camera?.routine?.state === "running" && state.camera.routine.kind === "scan",
        placeKnown: (state, job) => state.align?.job === job && (state.align.fit ?? null) !== null,
    },
    top: {
        label: "Top camera",
        present: (state) => gcodePlacing(state) || state.placing?.top?.running === true,
        running: (state) => state.placing?.top?.running === true,
        device: (state) => state.placing?.top?.device ?? null,
        look: (state) => state.placing?.top?.board_look ?? null,
        busy: (state) => state.placing?.top?.routine?.state === "running",
        searching: (state) => state.placing?.top?.routine?.state === "running" && state.placing.top.routine.kind === "search",
        scanning: (state) => state.placing?.top?.routine?.state === "running" && state.placing.top.routine.kind === "scan",
        placeKnown: (state, job) => (state.placing?.references ?? []).some((reference) => reference.job === job),
    },
};

const CAMERAS: LookCamera[] = ["top", "head"];

/** The camera a page looks with when none was picked, or the one picked is not there: a running one, the top camera first with a G-code machine. */
export function defaultCamera(state: AppState): LookCamera {
    const top = SOURCES.top;
    if (top.present(state) && (top.running(state) || !SOURCES.head.running(state))) {
        return "top";
    }
    return "head";
}

/** The camera picked, while it is there; else the default. */
export function pickedCamera(state: AppState, stored: string | null): LookCamera {
    if ((stored === "head" || stored === "top") && SOURCES[stored].present(state)) {
        return stored;
    }
    return defaultCamera(state);
}

/** The guesses at or over the threshold, and the most likely one whatever its share: the ones a board drawing shows. */
export function shownGuesses(look: BoardLook | null | undefined, threshold: number): BoardGuess[] {
    const guesses = look?.guesses ?? [];
    return guesses.filter((guess, index) => !guess.ruled_out && (index === 0 || guess.probability >= threshold - 1e-9));
}

/** What the corners taken say: each corner and where it was taken, and the rough place they give; empty with none. */
export function cornersText(corners: BoardCorners | null | undefined, job: string | null, name: (id: string) => string): string {
    if (!corners || corners.points.length === 0) {
        return "";
    }
    if (corners.job !== job) {
        return `${corners.points.length === 1 ? "a corner" : `${corners.points.length} corners`} taken of ${name(corners.job)}: Clear corners, or take this board's`;
    }
    const taken = corners.points.map((point) => `${point.corner}${point.by === "edges" ? " by its edges" : ""} at ${formatFixed(point.machine[0], 2)}, ${formatFixed(point.machine[1], 2)}`).join("; ");
    const rough = corners.rough;
    if (!rough) {
        return taken;
    }
    const place = `rough place: middle at ${formatFixed(rough.center[0], 2)}, ${formatFixed(rough.center[1], 2)}`;
    if (corners.points.length === 1) {
        const angle = corners.points[0]!.angle;
        return angle !== undefined
            ? `${taken}; ${place}, turned ${formatFixed(rough.rotation, 2)} deg as its edges run`
            : `${taken}; ${place}, taken square: a second corner gives the turn`;
    }
    return `${taken}; ${place}, turned ${formatFixed(rough.rotation, 2)} deg, the corners within ${formatFixed(rough.rms, 2)} mm of it`;
}

/** The board's stretch the posterior fits, as a line; empty without it. */
export function stretchText(stretch: BoardStretch | null | undefined): string {
    if (!stretch) {
        return "";
    }
    const scale = (value: number, sd: number) => `${formatFixed(value, 4)} +- ${formatFixed(sd, 4)}`;
    return `Board stretch: X scale ${scale(stretch.scale_x, stretch.scale_x_sd)}, Y scale ${scale(stretch.scale_y, stretch.scale_y_sd)},`
        + ` shear ${formatFixed(stretch.shear_deg, 3)} +- ${formatFixed(stretch.shear_deg_sd, 3)} deg off square`;
}

/** What a machine's skew learned says, as a line; empty with nothing learned. */
export function skewText(skew: SkewState | null): string {
    const estimate = skew?.estimate;
    if (!skew || !skew.machine || !estimate) {
        return "";
    }
    const scale = (value: number, sd: number) => `${formatFixed(value, 4)} +- ${formatFixed(sd, 4)}`;
    const boards = `${estimate.boards} ${estimate.boards === 1 ? "board" : "boards"} at turns ${formatFixed(estimate.turn_span_deg, 0)} deg apart`;
    const told = estimate.separated ? "" : "; find a board turned a quarter too, to tell it from the boards' own stretch";
    return `Machine skew of ${skew.machine}: X scale ${scale(estimate.x_scale, estimate.x_sd)}, Y scale ${scale(estimate.y_scale, estimate.y_sd)},`
        + ` ${formatFixed(estimate.square_deg, 3)} +- ${formatFixed(estimate.square_sd, 3)} deg out of square, from ${boards}${told}`;
}

/** The look methods as the page names them. */
const METHOD_NAMES: Record<LookMethod, string> = { vote: "Vote among guesses", posterior: "Probability over the pose" };

/** What said where the board was before a search, as the page names it. */
const KNOWN_SOURCES: Record<BoardKnown["source"], string> = {
    corners: "the corners taken",
    found: "where it was found before",
    align: "the Align marks",
    references: "the references",
    job: "the job's own place",
};

/** Where the newest search expected the board, and whether pcbv was told; empty with none. */
export function knownText(known: BoardKnown | null | undefined): string {
    if (!known) {
        return "";
    }
    const turn = known.within_deg === null ? "any turn" : `${formatFixed(known.within_deg, 1)} deg`;
    const place = `The search started from ${KNOWN_SOURCES[known.source] ?? known.source}: middle at ${formatFixed(known.center[0], 2)}, ${formatFixed(known.center[1], 2)}, turned ${formatFixed(known.rotation, 2)} deg, within ${formatFixed(known.within_mm, 1)} mm and ${turn}`;
    const told = known.guided > 0 ? `; pcbv looked there first at ${known.guided} ${known.guided === 1 ? "stop" : "stops"}` : "";
    const refused = known.unguided > 0
        ? `; pcbv could not take it at ${known.unguided} ${known.unguided === 1 ? "stop" : "stops"} (built before it could: build pcb-vision again)`
        : "";
    return `${place}${told}${refused}. It orders the search only: every place is checked the same.`;
}

let graphCount = 0;

function svg(tag: string, attrs: Record<string, string | number> = {}, ...children: (SVGElement | string)[]): SVGElement {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attrs)) {
        node.setAttribute(key, String(value));
    }
    for (const child of children) {
        node.append(child);
    }
    return node;
}

/** The plot's place in the graph's view box: its left, right, top (100%) and baseline (0%). */
const PLOT = { x0: 34, x1: 314, top: 16, base: 110 };
const VIEW = { width: 320, height: 128 };
/** A column's width, view box units: about 1.5rem with the graph at its widest. */
const COLUMN = 16;

/** The y of a share in the graph. */
function shareY(value: number): number {
    return PLOT.base - Math.min(Math.max(value, 0), 1) * (PLOT.base - PLOT.top);
}

/** A column `height` tall from the baseline, its top corners rounded. */
function columnPath(x: number, top: number, width: number): string {
    const radius = Math.min(3, width / 2, Math.max(PLOT.base - top, 0));
    return `M${x},${PLOT.base} L${x},${top + radius} Q${x},${top} ${x + radius},${top} L${x + width - radius},${top} Q${x + width},${top} ${x + width},${top + radius} L${x + width},${PLOT.base} Z`;
}

export interface GuessGraph {
    root: HTMLElement;
    /** Draws the look's guesses against a threshold (0 to 1). */
    render(look: BoardLook | null, threshold: number): void;
}

/**
 * The guesses as columns of their share of the evidence, as an equalizer
 * shows its bands, with the threshold as a line across them: a press or a
 * drag on the graph moves the line (`preview` while it moves, `commit` once
 * let go). A guess the corners rule out is hatched, as tall as its share of
 * every guess's evidence, and the threshold does not apply to it.
 */
export function mountGuessGraph(preview: (value: number) => void, commit: (value: number) => void): GuessGraph {
    graphCount += 1;
    const hatch = `find-hatch-${graphCount}`;
    const root = svg("svg", { class: "find-graph", viewBox: `0 0 ${VIEW.width} ${VIEW.height}`, role: "img", "aria-label": "the guesses' shares of the evidence and the threshold" }) as SVGSVGElement;
    const box = el("div", { class: "find-graph-box" });
    box.append(root);
    const defs = svg("defs", {},
        svg("pattern", { id: hatch, width: 5, height: 5, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" },
            svg("rect", { width: 5, height: 5, class: "find-hatch-ground" }),
            svg("line", { x1: 0, y1: 0, x2: 0, y2: 5, class: "find-hatch-line" }),
        ),
    );
    const grid = svg("g", { class: "find-grid" });
    for (const value of [0, 0.5, 1]) {
        const y = shareY(value);
        grid.append(
            svg("line", { x1: PLOT.x0, y1: y, x2: PLOT.x1, y2: y, class: value === 0 ? "find-base" : "find-gridline" }),
            svg("text", { x: PLOT.x0 - 4, y: y + 3, class: "find-tick", "font-size": 8, "text-anchor": "end" }, percent(value)),
        );
    }
    const columns = svg("g", { class: "find-columns" });
    const empty = svg("text", { x: (PLOT.x0 + PLOT.x1) / 2, y: (PLOT.top + PLOT.base) / 2, class: "find-empty", "font-size": 9, "text-anchor": "middle" }, "no guesses yet");
    const line = svg("line", { x1: PLOT.x0, x2: PLOT.x1, class: "find-line" });
    const grip = svg("circle", { cx: PLOT.x1, r: 4.5, class: "find-grip" });
    const lineLabel = svg("text", { x: PLOT.x1 - 8, class: "find-line-label", "font-size": 8, "text-anchor": "end" });
    const threshold = svg("g", { class: "find-threshold" }, line, grip, lineLabel);
    // The plot takes a press or a drag anywhere, a column too; the columns
    // lie over it so each keeps its tooltip.
    const hit = svg("rect", { x: PLOT.x0, y: PLOT.top - 8, width: PLOT.x1 - PLOT.x0 + 8, height: PLOT.base - PLOT.top + 16, class: "find-hit" });
    hit.append(svg("title", {}, "press or drag to set the threshold: the least share of the evidence the most likely guess must hold"));
    root.append(defs, grid, hit, columns, empty, threshold);

    /** The share under a pointer's height. */
    const valueAt = (clientY: number): number => {
        const rect = root.getBoundingClientRect();
        if (rect.height <= 0) {
            return DEFAULT_THRESHOLD;
        }
        const y = ((clientY - rect.top) / rect.height) * VIEW.height;
        const value = (PLOT.base - y) / (PLOT.base - PLOT.top);
        return Math.round(Math.min(Math.max(value, 0), 1) * 100) / 100;
    };
    let dragging = false;
    root.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) {
            return;
        }
        dragging = true;
        root.setPointerCapture?.(event.pointerId);
        preview(valueAt(event.clientY));
        event.preventDefault();
    });
    root.addEventListener("pointermove", (event) => {
        if (dragging) {
            preview(valueAt(event.clientY));
        }
    });
    root.addEventListener("pointerup", (event) => {
        if (!dragging) {
            return;
        }
        dragging = false;
        commit(valueAt(event.clientY));
    });
    root.addEventListener("pointercancel", () => {
        dragging = false;
    });

    function render(look: BoardLook | null, value: number): void {
        // The posterior keeps the last slot for where nothing has looked yet.
        const elsewhere = look?.method === "posterior" && typeof look.elsewhere === "number" ? look.elsewhere : null;
        const guesses = (look?.guesses ?? []).slice(0, elsewhere === null ? SLOTS : SLOTS - 1);
        const slot = (PLOT.x1 - PLOT.x0) / SLOTS;
        const found = look?.found === true;
        const rest: SVGElement[] = [];
        if (elsewhere !== null) {
            const x = PLOT.x0 + guesses.length * slot + (slot - COLUMN) / 2;
            const top = shareY(elsewhere);
            rest.push(svg("g", { class: "find-column elsewhere" },
                svg("title", {}, `where nothing has looked yet: ${percent(elsewhere)} of the probability; the board may lie where no picture has shown it`),
                svg("path", { d: columnPath(x, top, COLUMN) }),
                svg("text", { x: x + COLUMN / 2, y: PLOT.base + 11, class: "find-tick", "font-size": 8, "text-anchor": "middle" }, "?"),
                svg("text", { x: x + COLUMN / 2, y: top - 3, class: "find-value", "font-size": 8, "text-anchor": "middle" }, percent(elsewhere)),
            ));
        }
        columns.replaceChildren(...guesses.map((guess, index) => {
            const x = PLOT.x0 + index * slot + (slot - COLUMN) / 2;
            const height = guess.ruled_out ? guess.share : guess.probability;
            const top = shareY(height);
            const kind = guess.ruled_out ? "ruled" : index === 0 && found ? "found" : guess.probability >= value - 1e-9 ? "over" : "under";
            const group = svg("g", { class: `find-column ${kind}` },
                svg("title", {}, guessTitle(guess, index, kind, elsewhere !== null)),
                svg("path", { d: columnPath(x, top, COLUMN), ...(kind === "ruled" ? { fill: `url(#${hatch})` } : {}) }),
                svg("text", { x: x + COLUMN / 2, y: PLOT.base + 11, class: "find-tick", "font-size": 8, "text-anchor": "middle" }, `#${index + 1}`),
            );
            // The value on the cap of the columns that count: over the line, or the most likely one.
            if (kind !== "under" || index === 0) {
                group.append(svg("text", { x: x + COLUMN / 2, y: top - 3, class: "find-value", "font-size": 8, "text-anchor": "middle" }, kind === "ruled" ? "out" : percent(guess.probability)));
            }
            return group;
        }), ...rest);
        empty.classList.toggle("hidden", guesses.length > 0 || elsewhere !== null);
        const y = shareY(value);
        line.setAttribute("y1", String(y));
        line.setAttribute("y2", String(y));
        grip.setAttribute("cy", String(y));
        // The label rides above the line, or under it near the top.
        lineLabel.setAttribute("y", String(y > PLOT.top + 10 ? y - 4 : y + 10));
        lineLabel.textContent = `threshold ${percent(value)}`;
        root.setAttribute("aria-label", `${guesses.length} guesses; threshold ${percent(value)}${found ? "; the most likely found" : ""}`);
    }

    return { root: box, render };
}

/** A guess's tooltip: its share (a probability with the posterior), looks, match, spread and place. */
function guessTitle(guess: BoardGuess, index: number, kind: string, posterior = false): string {
    const state = kind === "found" ? ", found" : kind === "over" ? ", at or over the threshold" : kind === "ruled" ? ", ruled out by the corners" : ", under the threshold";
    if (posterior) {
        const corner = guess.corner_mm !== null ? `; puts a corner ${formatFixed(guess.corner_mm, 2)} mm from where it was taken` : "";
        const searches = guess.sessions ?? 1;
        return `#${index + 1}: ${percent(guess.probability)} likely${state}; seen in ${guess.looks} ${guess.looks === 1 ? "picture" : "pictures"} by ${searches} ${searches === 1 ? "search" : "searches"},`
            + ` within ${formatFixed(guess.spread_mm, 2)} mm and ${formatFixed(guess.spread_deg, 2)} deg (one standard deviation);`
            + ` middle at ${formatFixed(guess.center[0], 2)}, ${formatFixed(guess.center[1], 2)}, turned ${formatFixed(guess.rotation, 2)} deg${corner}`;
    }
    const corner = guess.corner_mm !== null ? `; puts a corner ${formatFixed(guess.corner_mm, 2)} mm from where it was taken` : "";
    const match = guess.match !== undefined ? `, matched ${percent(guess.match)}` : "";
    return `#${index + 1}: ${percent(kind === "ruled" ? guess.share : guess.probability)} of the evidence${state}; ${guess.looks} looks${match}, within ${formatFixed(guess.spread_mm, 2)} mm and ${formatFixed(guess.spread_deg, 2)} deg;`
        + ` middle at ${formatFixed(guess.center[0], 2)}, ${formatFixed(guess.center[1], 2)}, turned ${formatFixed(guess.rotation, 2)} deg${corner}`;
}

export interface FindBoardOptions {
    /** The page the panel is on: its pick of camera is kept apart from another page's. */
    page: string;
    /** The box each camera's search keeps to, drawn on its picture; null for none. */
    boxes: Record<LookCamera, () => MachineBox | null>;
    /** Told when the camera picked changes, or the threshold moves while dragged. */
    onChange?: () => void;
}

export interface FindBoardPanel {
    /** The camera whose look the panel shows. */
    camera(state: AppState): LookCamera;
    /** The threshold shown: the one being dragged, else the camera's. */
    threshold(state: AppState): number;
}

export function mountFindBoard(root: HTMLElement, ctx: Ctx, options: FindBoardOptions): FindBoardPanel {
    const storeKey = `spinny.find.${options.page}`;
    const badge = el("span", { class: "badge" }, "stopped");
    const pick = el("select", { class: "field", "aria-label": "Camera that looks for the board" }) as HTMLSelectElement;
    pick.title = "the camera that looks for the board";
    const options_ = CAMERAS.map((key) => el("option", { value: key }, SOURCES[key].label) as HTMLOptionElement);
    pick.append(...options_);
    const note = el("p", { class: "muted find-note" });
    const lookButton = button("Look for board", () => lookForBoard(), "btn", "load the selected job's board: the camera looks for it in every picture until Unload");
    const searchButton = button("Search", () => runSearch(), "btn",
        "move the camera over the search box (Shift and a drag on its picture), else where the corners put the board, else the board's size about where it looks, until a guess is likely enough; it starts where the board is known to be (corners, a place found before, the marks or references, the job's place) and tells pcbv to look there first");
    const scanButton = button("Full scan", () => runScan(), "btn",
        "move the camera over the whole board where a rough place puts it (a find, the corners, the Align marks or references), row by row: every picture is weighed and kept for the mosaic below");
    const placeButton = button("Use as board place", () => usePlace(), "btn");
    const unloadButton = button("Unload", () => unload(), "btn btn-quiet", "stop looking for the board");
    const lookLine = el("p", { class: "muted find-look" });
    const knownLine = el("p", { class: "muted find-known" });

    // The threshold: dragged on the graph or slid, sent once let go.
    let dragged: number | null = null;
    const slider = el("input", { type: "range", min: "0", max: "100", step: "1", class: "find-slider", "aria-label": "Threshold percent" }) as HTMLInputElement;
    slider.title = "the threshold: the least share of the evidence the most likely guess must hold to be called found";
    const sliderValue = el("output", { class: "find-slider-value" });
    const graph = mountGuessGraph((value) => show(value), (value) => void setThreshold(value));
    slider.addEventListener("input", () => show(Number(slider.value) / 100));
    slider.addEventListener("change", () => void setThreshold(Number(slider.value) / 100));
    // How the look calls the board found, and the posterior's board stretch.
    const method = el("select", { class: "field", "aria-label": "Look method" }) as HTMLSelectElement;
    method.title = "how the look calls the board found: the vote counts locked looks that agree; the probability weighs every picture, those that locked on nothing too, and keeps some for where nothing has looked yet";
    method.append(...(Object.keys(METHOD_NAMES) as LookMethod[]).map((key) => el("option", { value: key }, METHOD_NAMES[key])));
    method.addEventListener("change", () => void tune({ look_method: method.value === "posterior" ? "posterior" : "vote" }));
    const stretch = el("input", { type: "checkbox", "aria-label": "Board stretch" }) as HTMLInputElement;
    stretch.title = "the probability also fits the board's X and Y scale and shear (within a fab's tolerance): pictures far apart, or a full scan, measure them";
    stretch.addEventListener("change", () => void tune({ board_stretch: stretch.checked }));
    const stretchLabel = el("label", { class: "check-label", title: stretch.title }, stretch, " Board stretch");
    const stretchLine = el("p", { class: "muted find-stretch" });
    const table = el("table", { class: "find-guesses" });
    const tableBox = el("div", { class: "find-table-box" }, table);
    const more = el("p", { class: "muted find-more" });

    // The corners taken by hand.
    const corner = el("select", { class: "field", "aria-label": "Corner of the board" }) as HTMLSelectElement;
    corner.title = "the corner of the board the picture's center is on, as the board drawing shows it";
    corner.append(...CORNER_NAMES.map((name) => el("option", { value: name }, name)));
    const cornerButton = button("Corner here", () => takeCorner(), "btn", "the picture's center is on this corner of the board: keep where it is");
    const edgeButton = button("Corner by edges", () => edgeCorner(), "btn",
        "a blank board's corner is in the picture, the bed around it: find its two edges, keep where they meet and the board's turn");
    // Centering features far apart once the board is found (head camera).
    const use = el("select", { class: "field", "aria-label": "Features to center" },
        el("option", { value: "auto" }, "fiducials, else holes, else pads"), el("option", { value: "fiducials" }, "fiducials"),
        el("option", { value: "holes" }, "holes"), el("option", { value: "pads" }, "pads")) as HTMLSelectElement;
    use.title = "which features the camera centers on";
    const refineButton = button("Center features", () => refine(), "btn",
        "center the camera on three features far apart where the place found puts them, and make them the Align marks: the board's turn from a long baseline");
    const refineRow = el("div", { class: "button-row" }, labeled("Features", use, "labeled inline"), refineButton);
    const refineHead = el("h3", {}, "Exact place by features");
    const clearButton = button("Clear corners", () => clearCorners(), "btn btn-quiet", "forget the corners taken");
    const within = numberField({ min: 0.1, max: 50, step: 0.5, width: "5rem" });
    within.setAttribute("aria-label", "Corners within mm");
    within.title = "a guess that puts a corner further than this from where it was taken is ruled out";
    within.addEventListener("change", () => void setWithin());
    const tracked = new Tracked([within]);
    // The newest full scan's pictures, fetched again when its version moves.
    const scanHead = el("h3", { class: "hidden" }, "Full scan");
    // How the head camera's scan takes its pictures: at rest, or on the move
    // (this project's firmware reports the head's place while it moves).
    const motion = el("select", { class: "field", "aria-label": "Scan motion" },
        el("option", { value: "stop" }, "At rest"), el("option", { value: "fly" }, "On the move")) as HTMLSelectElement;
    motion.title = "how a full scan takes its pictures: the head at rest for each, or moving along each row at a speed the camera's exposure allows (set the exposure by hand), the camera's delay measured from rows run both ways";
    motion.addEventListener("change", () => void into(ctx, "camera", ctx.api.cameraSettings({ scan_motion: motion.value === "fly" ? "fly" : "stop" })));
    const motionField = labeled("Scan", motion, "labeled inline");
    const scanLine = el("p", { class: "muted find-scan hidden" });
    const mosaic = mountMosaic();
    let scanShown: { camera: LookCamera; version: number } | null = null;
    let scanData: ScanMosaic | null = null;
    // The machine's skew its boards show, fetched when a board is found.
    const skewLine = el("p", { class: "muted find-skew hidden" });
    const skewApply = button("Write skew to machine file", () => void writeSkew(), "btn btn-quiet",
        "multiply the machine file's X and Y steps per mm by the X and Y scale learned, and forget the boards measured on the old steps; load the file into the controller after");
    const skewClear = button("Forget boards", () => void forgetSkew(), "btn btn-quiet", "forget the boards the skew was learned from");
    const skewRow = el("div", { class: "button-row hidden" }, skewApply, skewClear);
    let skewData: SkewState | null = null;
    let skewKey = "";
    const cornersLine = el("p", { class: "muted find-corners" });

    root.append(
        el("div", { class: "panel-head" }, el("h2", {}, "Find board"), badge),
        el("fieldset", { class: "panel-body" },
            el("div", { class: "button-row" }, labeled("Camera", pick, "labeled inline")),
            note,
            el("div", { class: "button-row" }, lookButton, searchButton, scanButton, placeButton, unloadButton, motionField),
            lookLine,
            knownLine,
            el("h3", {}, "Guesses"),
            graph.root,
            el("div", { class: "button-row find-slider-row" }, labeled("Threshold", slider, "labeled inline"), sliderValue),
            el("div", { class: "button-row" }, labeled("Method", method, "labeled inline"), stretchLabel),
            stretchLine,
            tableBox,
            more,
            el("h3", {}, "Rough place by corners"),
            el("div", { class: "button-row" }, labeled("Corner", corner, "labeled inline"), cornerButton, edgeButton, clearButton, labeled("Within mm", within, "labeled inline")),
            cornersLine,
            refineHead,
            refineRow,
            scanHead,
            scanLine,
            mosaic.root,
            skewLine,
            skewRow,
            el("p", { class: "muted hint" },
                "Each column is a place the looks put the board, as tall as its share of the evidence (looks weighed by how well they matched);"
                + " the most likely is found once it has enough looks and reaches the threshold line. Put the picture's center on a corner of the board"
                + " (jog, or double-click it in the camera's picture), pick which corner it is and press Corner here: two give the board's place and turn,"
                + " Search keeps to it, and a guess putting a corner further than Within is ruled out. With the top camera a corner is also one of the"
                + " board's references, so Go to part and Find fiducials work from it at once; Use as board place takes a place found instead."
                + " With Probability over the pose each column is a place's probability, the last (?) what no place holds yet, where nothing has looked;"
                + " Full scan, once a rough place is known, covers the whole board and lays its pictures out below."),
        ),
    );

    let chosen: LookCamera = pickedCamera(ctx.store.get(), readStored(storeKey));
    pick.addEventListener("change", () => {
        const value = pick.value === "top" ? "top" : "head";
        writeStored(storeKey, value);
        chosen = value;
        dragged = null;
        render(ctx.store.get());
        options.onChange?.();
    });

    const source = (): LookSource => SOURCES[chosen];
    const lookNow = (): BoardLook | null => source().look(ctx.store.get());
    const thresholdOf = (state: AppState): number => dragged ?? SOURCES[pickedCamera(state, readStored(storeKey))].look(state)?.threshold ?? DEFAULT_THRESHOLD;

    /** The threshold while it is dragged: drawn, not sent. */
    function show(value: number): void {
        dragged = value;
        render(ctx.store.get());
        options.onChange?.();
    }

    async function tune(patch: { look_threshold?: number; corner_mm?: number; look_method?: LookMethod; board_stretch?: boolean }): Promise<void> {
        if (chosen === "top") {
            await into(ctx, "placing", ctx.api.topSettings(patch));
        } else {
            await into(ctx, "camera", ctx.api.cameraSettings(patch));
        }
    }

    async function setThreshold(value: number): Promise<void> {
        dragged = value;
        render(ctx.store.get());
        try {
            if (Math.abs(value - (lookNow()?.threshold ?? DEFAULT_THRESHOLD)) > 1e-9) {
                await tune({ look_threshold: value });
            }
        } finally {
            dragged = null;
            render(ctx.store.get());
            options.onChange?.();
        }
    }

    async function setWithin(): Promise<void> {
        const value = parseNumber(within.value);
        if (value === null || value < 0.1 || value > 50) {
            ctx.toast("error", "within: 0.1 to 50 mm");
            return;
        }
        if (value !== lookNow()?.corner_mm) {
            await tune({ corner_mm: value });
        }
        tracked.reset();
        render(ctx.store.get());
    }

    async function lookForBoard(): Promise<void> {
        const job = ctx.store.get().job;
        if (!job) {
            ctx.toast("error", "pick a board job first");
            return;
        }
        if (chosen === "top") {
            await into(ctx, "placing", ctx.api.topBoard(job.id));
        } else {
            await into(ctx, "camera", ctx.api.cameraBoard(job.id));
        }
    }

    async function runSearch(): Promise<void> {
        const box = options.boxes[chosen]();
        if (chosen === "top") {
            await into(ctx, "placing", ctx.api.topSearch(box));
        } else {
            await into(ctx, "camera", ctx.api.cameraSearch(box));
        }
    }

    async function runScan(): Promise<void> {
        if (chosen === "top") {
            await into(ctx, "placing", ctx.api.topScan(null));
        } else {
            await into(ctx, "camera", ctx.api.cameraScan(null));
        }
    }

    /** The newest scan's pictures, fetched once per version of it. */
    async function showScan(camera: LookCamera, version: number): Promise<void> {
        if (scanShown !== null && scanShown.camera === camera && scanShown.version === version) {
            return;
        }
        scanShown = { camera, version };
        try {
            scanData = camera === "top" ? await ctx.api.topScanState() : await ctx.api.cameraScanState();
        } catch {
            scanData = null;
        }
        if (scanShown.camera === camera && scanShown.version === version) {
            const urlOf = camera === "top" ? (index: number) => ctx.api.topScanUrl(index, version) : (index: number) => ctx.api.cameraScanUrl(index, version);
            mosaic.render(scanData, urlOf);
        }
    }

    /** The machine's skew, fetched again when the camera or what it found changes. */
    async function showSkew(camera: LookCamera, key: string): Promise<void> {
        if (key === skewKey) {
            return;
        }
        skewKey = key;
        try {
            skewData = await ctx.api.skew(camera);
        } catch {
            skewData = null;
        }
        render(ctx.store.get());
    }

    async function writeSkew(): Promise<void> {
        try {
            skewData = await ctx.api.skewApply(chosen);
            ctx.toast("info", `written to ${skewData.machine}: ${(skewData.written ?? []).map((change) => `${change.path.join(".")} ${change.old} to ${change.new}`).join(", ")}; load the file into the controller`);
        } catch (error) {
            ctx.toast("error", errorText(error));
        }
        render(ctx.store.get());
    }

    async function forgetSkew(): Promise<void> {
        try {
            skewData = await ctx.api.skewClear(chosen);
        } catch (error) {
            ctx.toast("error", errorText(error));
        }
        render(ctx.store.get());
    }

    async function usePlace(): Promise<void> {
        const job = ctx.store.get().job;
        if (!job) {
            return;
        }
        if (chosen === "top") {
            await into(ctx, "placing", ctx.api.topPlace(job.id));
        } else {
            await into(ctx, "align", ctx.api.alignCapture(job.id));
        }
    }

    async function unload(): Promise<void> {
        if (chosen === "top") {
            await into(ctx, "placing", ctx.api.topBoard(null));
        } else {
            await into(ctx, "camera", ctx.api.cameraBoard(null));
        }
    }

    async function takeCorner(): Promise<void> {
        const job = ctx.store.get().job;
        if (!job) {
            ctx.toast("error", "pick a board job first");
            return;
        }
        const name = corner.value as CornerName;
        if (chosen === "top") {
            await into(ctx, "placing", ctx.api.topCorner(job.id, name));
        } else {
            await into(ctx, "camera", ctx.api.cameraCorner(job.id, name));
        }
    }

    async function edgeCorner(): Promise<void> {
        const job = ctx.store.get().job;
        if (!job) {
            ctx.toast("error", "pick a board job first");
            return;
        }
        const name = corner.value as CornerName;
        if (chosen === "top") {
            await into(ctx, "placing", ctx.api.topEdgeCorner(job.id, name));
        } else {
            await into(ctx, "camera", ctx.api.cameraEdgeCorner(job.id, name));
        }
    }

    async function refine(): Promise<void> {
        const job = ctx.store.get().job;
        if (!job) {
            return;
        }
        await into(ctx, "camera", ctx.api.cameraRefine(job.id, use.value as RefineUse, 3));
    }

    async function clearCorners(): Promise<void> {
        if (chosen === "top") {
            await into(ctx, "placing", ctx.api.topCornersClear());
        } else {
            await into(ctx, "camera", ctx.api.cameraCornersClear());
        }
    }

    /** The guesses as a table: what the graph shows, in numbers. */
    function renderTable(look: BoardLook | null, threshold: number): void {
        const guesses = look?.guesses ?? [];
        // The posterior's table holds where nothing has looked yet, places or none.
        const rest = look?.method === "posterior" && typeof look.elsewhere === "number";
        tableBox.classList.toggle("hidden", guesses.length === 0 && !rest);
        if (guesses.length === 0 && !rest) {
            table.replaceChildren();
            return;
        }
        const corners = guesses.some((guess) => guess.corner_mm !== null);
        const locks = guesses.some((guess) => guess.sessions !== undefined);
        const posterior = look?.method === "posterior";
        const heads = [
            "#", posterior ? "Probability" : "Share", posterior ? "Pictures" : "Looks", ...(locks ? [posterior ? "Searches" : "Locks"] : []), "Match",
            "Spread mm", ...(corners ? ["Corner mm"] : []), "Middle", "Turn deg", "",
        ];
        const rows = guesses.map((guess, index) => {
            const kind = guess.ruled_out ? "ruled out" : index === 0 && look?.found ? "found" : guess.probability >= threshold - 1e-9 ? "over" : "under";
            return el("tr", { class: `find-row ${kind.replace(" ", "-")}` },
                el("td", {}, `${index + 1}`),
                el("td", {}, guess.ruled_out ? `(${percent(guess.share)})` : percent(guess.probability)),
                el("td", {}, `${guess.looks}`),
                ...(locks ? [el("td", { title: "independent locks (pcbv searches) the looks came from" }, `${guess.sessions ?? "-"}`)] : []),
                el("td", {}, guess.match !== undefined ? percent(guess.match) : "-"),
                el("td", {}, formatFixed(guess.spread_mm, 2)),
                ...(corners ? [el("td", {}, guess.corner_mm !== null ? formatFixed(guess.corner_mm, 2) : "-")] : []),
                el("td", {}, `${formatFixed(guess.center[0], 2)}, ${formatFixed(guess.center[1], 2)}`),
                el("td", {}, formatFixed(guess.rotation, 2)),
                el("td", {}, kind),
            );
        });
        if (posterior && typeof look?.elsewhere === "number") {
            const blank = heads.length - 3;
            rows.push(el("tr", { class: "find-row elsewhere", title: "the probability no place holds yet: where no picture has shown the board" },
                el("td", {}, "?"), el("td", {}, percent(look.elsewhere)), el("td", { colspan: String(blank) }, "where nothing has looked yet"), el("td", {}, ""),
            ));
        }
        table.replaceChildren(
            el("thead", {}, el("tr", {}, ...heads.map((head) => el("th", {}, head)))),
            el("tbody", {}, ...rows),
        );
    }

    function render(state: AppState): void {
        chosen = pickedCamera(state, readStored(storeKey));
        const src = source();
        for (const option of options_) {
            const key = option.value as LookCamera;
            const there = SOURCES[key].present(state);
            const running = SOURCES[key].running(state);
            option.hidden = !there;
            option.disabled = !running && key !== chosen;
            const device = SOURCES[key].device(state);
            option.textContent = `${SOURCES[key].label}${device ? ` (${device})` : ""}${running ? "" : ", stopped"}`;
        }
        pick.value = chosen;
        const running = src.running(state);
        const look = src.look(state);
        const busy = src.busy(state);
        const job = state.job;
        const threshold = thresholdOf(state);
        const badgeText = src.searching(state) ? "searching" : src.scanning(state) ? "scanning" : busy ? "routine" : !running ? "stopped" : look?.found ? "found" : look?.job ? "looking" : "running";
        badge.textContent = badgeText;
        badge.setAttribute("data-camera", badgeText === "routine" ? "finding mark" : badgeText);
        note.textContent = running ? "" : `The ${src.label.toLowerCase()} is not running: start it in its panel.`;
        note.classList.toggle("hidden", running);

        // What may be done now, and why not.
        const machineReady = chosen === "top" ? state.placing?.connected === true : state.snapshot.connected;
        const machineFree = chosen === "top"
            ? state.placing?.running !== true && !(state.pnp?.routine?.state === "running" && state.pnp.routine.target === "gcode")
            : state.snapshot.machine?.state === "Idle";
        const scaled = chosen === "top" ? (state.placing?.top?.mm_per_px ?? 0) > 0 : (state.camera?.mm_per_px ?? 0) > 0 || state.camera?.pose?.state === "locked";
        const offsetKnown = chosen === "top" ? (state.placing?.top?.offset ?? state.placing?.document?.top?.offset ?? null) !== null : true;
        const corners = look?.corners ?? null;
        const ours = corners !== null && job !== null && corners.job === job.id;
        lockFor(lookButton,
            [!running, `start the ${src.label.toLowerCase()} first`],
            [!job, "pick a board job first"],
            [job?.design?.board !== true, "the camera needs a job uploaded as .kicad_pcb"],
            [busy, "a routine is under way"]);
        lockFor(searchButton,
            [!look?.job, "load a board first: Look for board"],
            [!machineReady, "connect the machine first"],
            [!machineFree, chosen === "top" ? "the machine is busy" : "the machine must be Idle"],
            [busy, "a routine is under way"],
            [!scaled, chosen === "top" ? "the top camera's scale is not measured: Measure offset first" : "the camera's scale is not measured: Find mark first"]);
        const found = look?.found === true && job !== null && look.job === job.id;
        lockFor(placeButton,
            [!job, "pick a board job first"],
            [!found && !ours, "the board is not found, and no corners of it are taken: Search, or take its corners"],
            [chosen === "head" && !state.snapshot.connected, "connect the machine first"],
            [busy, "a routine is under way"]);
        placeButton.title = chosen === "top"
            ? "keep where the board found, else its corners, puts it as the job's references (two parts far apart); Find fiducials then makes it exact"
            : "take where the board found, else its corners, puts it as marks in the Align panel";
        lockFor(unloadButton, [!look?.job, "no board loaded"], [busy, "a routine is under way"]);
        lockFor(cornerButton,
            [!job, "pick a board job first"],
            [!running, `start the ${src.label.toLowerCase()} first`],
            [!machineReady, "connect the machine first"],
            [!machineFree, chosen === "top" ? "the machine is busy" : "the machine must be Idle"],
            [!offsetKnown, "the top camera's offset is not measured: Measure offset first"],
            [busy, "a routine is under way"]);
        setLocked(clearButton, corners === null, "no corners taken");
        lockFor(edgeButton,
            [!job, "pick a board job first"],
            [!running, `start the ${src.label.toLowerCase()} first`],
            [!machineReady, "connect the machine first"],
            [!machineFree, chosen === "top" ? "the machine is busy" : "the machine must be Idle"],
            [!scaled, "the camera's scale is not measured"],
            [!offsetKnown, "the top camera's offset is not measured: Measure offset first"],
            [busy, "a routine is under way"]);
        // Centering features is the head camera's: the top camera's Find fiducials does it on the PNP page.
        const headOnly = chosen === "head";
        refineRow.classList.toggle("hidden", !headOnly);
        refineHead.classList.toggle("hidden", !headOnly);
        lockFor(refineButton,
            [!job, "pick a board job first"],
            [!found && !ours, "the board is not found, and no corners of it are taken: Search, or take its corners"],
            [!running, "start the head camera first"],
            [!machineReady, "connect the machine first"],
            [!machineFree, "the machine must be Idle"],
            [!((state.camera?.mm_per_px ?? 0) > 0), "the camera's scale is not measured: Find mark first"],
            [busy, "a routine is under way"]);
        // A full scan starts from a rough place: found, corners, or measured.
        const rough = found || ours || (job !== null && src.placeKnown(state, job.id));
        lockFor(scanButton,
            [!look?.job, "load a board first: Look for board"],
            [!rough, "a full scan needs a rough place: Search, take the board's corners, or mark it (Align, references)"],
            [!machineReady, "connect the machine first"],
            [!machineFree, chosen === "top" ? "the machine is busy" : "the machine must be Idle"],
            [busy, "a routine is under way"],
            [!scaled, "the camera's scale is not measured"]);
        // A G-code machine reports its place only at rest: its scans stop.
        motionField.classList.toggle("hidden", chosen !== "head");
        if (document.activeElement !== motion) {
            motion.value = state.camera?.scan_motion === "fly" ? "fly" : "stop";
        }
        motion.disabled = busy;
        const scanned = look?.scan ?? null;
        scanHead.classList.toggle("hidden", scanned === null);
        scanLine.classList.toggle("hidden", scanned === null);
        if (scanned === null) {
            mosaic.render(null, () => "");
        } else {
            const where = scanned.job === job?.id ? "" : ` of ${state.jobs.find((entry) => entry.id === scanned.job)?.name ?? scanned.job}`;
            const delay = look?.delay ? `; the camera's delay ${formatFixed(look.delay.seconds * 1000, 0)} +- ${formatFixed(look.delay.sd * 1000, 0)} ms` : "";
            scanLine.textContent = `${src.scanning(state) ? "Scanning" : "The newest scan"}${where}: ${scanned.pictures} ${scanned.pictures === 1 ? "picture" : "pictures"}`
                + ` taken ${scanned.motion === "fly" ? "on the move" : "at rest"}${scanned.found ? ", the board found (dashed)" : ""}${delay}.`;
            void showScan(chosen, scanned.version);
        }
        void showSkew(chosen, `${chosen}:${look?.found === true}:${look?.scan?.version ?? 0}:${state.align?.marks.length ?? 0}`);
        const shownSkew = skewData !== null && skewData.camera === chosen ? skewData : null;
        skewLine.textContent = skewText(shownSkew);
        skewLine.classList.toggle("hidden", skewLine.textContent === "");
        skewRow.classList.toggle("hidden", skewLine.textContent === "");
        lockFor(skewApply,
            [shownSkew?.apply === null || shownSkew?.apply === undefined, "only a cartesian machine on this project's firmware has steps per mm in its file to write"],
            [shownSkew?.estimate?.separated !== true, "the boards were all found at about one turn: find one turned a quarter first"],
            [busy, "a routine is under way"]);
        setLocked(skewClear, (shownSkew?.count ?? 0) === 0 || busy, "no boards kept");
        const name = look?.job ? state.jobs.find((entry) => entry.id === look.job)?.name ?? null : null;
        lookLine.textContent = lookText(look, name) || "No board loaded: pick a board job and press Look for board.";
        knownLine.textContent = look?.job ? knownText(look.known) : "";
        knownLine.classList.toggle("hidden", knownLine.textContent === "");

        graph.render(look?.job ? look : null, threshold);
        if (dragged === null) {
            slider.value = String(Math.round(threshold * 100));
        }
        sliderValue.textContent = percent(threshold);
        renderTable(look?.job ? look : null, threshold);
        more.textContent = look?.more ? `and ${look.more} more guesses with fewer looks` : "";
        more.classList.toggle("hidden", !look?.more);
        tracked.follow(within, String(look?.corner_mm ?? 2));
        const lookMethod: LookMethod = look?.method === "posterior" ? "posterior" : "vote";
        if (document.activeElement !== method) {
            method.value = lookMethod;
        }
        stretch.checked = look?.board_stretch === true;
        method.disabled = busy;
        stretch.disabled = busy || lookMethod !== "posterior";
        stretchLabel.title = lookMethod !== "posterior"
            ? "board stretch is the probability's: pick Probability over the pose as the method first"
            : busy ? "a routine is under way" : stretch.title;
        stretchLabel.classList.toggle("muted", lookMethod !== "posterior");
        stretchLine.textContent = look?.job ? stretchText(look.stretch) : "";
        stretchLine.classList.toggle("hidden", stretchLine.textContent === "");
        cornersLine.textContent = cornersText(corners, job?.id ?? null, (id) => state.jobs.find((entry) => entry.id === id)?.name ?? id);
        cornersLine.classList.toggle("hidden", cornersLine.textContent === "");
    }

    ctx.store.subscribe((state) => render(state), ["camera", "placing", "snapshot", "pnp", "job", "jobs"]);
    render(ctx.store.get());
    return {
        camera: (state) => pickedCamera(state, readStored(storeKey)),
        threshold: (state) => thresholdOf(state),
    };
}
