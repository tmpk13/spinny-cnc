// The height map: where to probe, how, the probing under way, the heights as
// a map of the board, and the focus offset a compensated run needs.

import { askConfirm } from "../confirm.ts";
import { button, el, labeled, numberField, replace, setLocked } from "../dom.ts";
import { formatDuration, formatFixed, parseNumber } from "../format.ts";
import { isDispensing, isMilling, outputDuty } from "../profile.ts";
import { boardOfJoint, lerpJoint } from "../kinematics.ts";
import type { AppState } from "../state.ts";
import type { Grid, HeightMap, HeightMapState, Job, PadProbeRequest, ProbeRequest, ProbeSettings, TouchMode } from "../types.ts";
import type { Ctx } from "./context.ts";

/** A grid when there is neither a map nor a job to take one from. */
export const DEFAULT_GRID: Grid = { x0: -20, y0: -20, x1: 20, y1: 20, nx: 5, ny: 5 };
/** How far past the job a grid made to fit it reaches, mm. */
export const FIT_MARGIN = 1;
/** Above this many points a side the cells are too small to carry their value. */
export const LABELED_POINTS = 8;
/** Largest brake queue the firmware takes, ms: its whole segment ring. */
export const PROBE_MS_MAX = 160;
/** The strongest a cell's color gets, percent of the pole: past it the value on top loses its contrast. */
export const MAX_TINT = 70;

export interface HeightStats {
    min: number;
    max: number;
    mean: number;
    probed: number;
    total: number;
}

/** Lowest, highest and mean of the heights probed so far; null before the first. */
export function heightStats(map: HeightMap): HeightStats | null {
    const values = map.heights.flat().filter((value): value is number => value !== null);
    if (values.length === 0) {
        return null;
    }
    const sum = values.reduce((total, value) => total + value, 0);
    return {
        min: Math.min(...values),
        max: Math.max(...values),
        mean: sum / values.length,
        probed: values.length,
        total: map.grid.nx * map.grid.ny,
    };
}

/**
 * The fill of one cell: blue below the mean, red above, the neutral gray at
 * it, stronger the further off it is against the largest deviation.
 */
export function cellColor(value: number | null, stats: HeightStats | null): string {
    if (value === null || stats === null) {
        return "transparent";
    }
    const reach = Math.max(stats.max - stats.mean, stats.mean - stats.min);
    if (!(reach > 1e-9)) {
        return "var(--hm-mid)";
    }
    const deviation = value - stats.mean;
    const tint = Math.round(Math.min(1, Math.abs(deviation) / reach) * MAX_TINT);
    const pole = deviation >= 0 ? "var(--hm-high)" : "var(--hm-low)";
    return `color-mix(in oklab, ${pole} ${tint}%, var(--hm-mid))`;
}

/** The longest steps, in angle and in radius, a joint-space line is followed in to find where it reaches on the board. */
export const JOINT_STEP_DEG = 1;
export const JOINT_STEP_MM = 0.1;

/**
 * The board points a joint-space line passes through, ends included. The
 * machine moves R and A together in proportion, so on the board the line is
 * an arc or a spiral that can reach well past its ends: a full turn at a
 * constant radius starts and ends at the same point.
 */
export function jointLineBoard(from: [number, number], to: [number, number]): { x: number; y: number }[] {
    const start = { r: from[0], a: from[1] };
    const end = { r: to[0], a: to[1] };
    const steps = Math.max(1, Math.ceil(Math.max(
        Math.abs(end.a - start.a) / JOINT_STEP_DEG,
        Math.abs(end.r - start.r) / JOINT_STEP_MM,
    )));
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i <= steps; i++) {
        out.push(boardOfJoint(lerpJoint(start, end, i / steps)));
    }
    return out;
}

/**
 * The labels of the legend's ramp. The colors scale alike on both sides of
 * the mean, by the larger deviation, so the ramp's ends are that far below
 * and above it. On a skewed map the extreme on the other side stops short of
 * its end of the ramp, which is why the lowest and highest are listed apart.
 */
export function legendEnds(stats: HeightStats): { low: string; high: string } {
    const reach = Math.max(stats.max - stats.mean, stats.mean - stats.min);
    return { low: signed(-reach), high: signed(reach) };
}

/** Board points of the enabled groups of a job; joint-space groups on the board, all along their lines. */
export function jobBox(job: Job): { x0: number; y0: number; x1: number; y1: number } | null {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const take = (x: number, y: number): void => {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
    };
    for (const group of job.groups) {
        if (!group.enabled) {
            continue;
        }
        if (group.joints && group.joints.length > 0) {
            for (const poly of group.joints) {
                if (poly.length === 1) {
                    const board = boardOfJoint({ r: poly[0]![0], a: poly[0]![1] });
                    take(board.x, board.y);
                }
                for (let i = 1; i < poly.length; i++) {
                    for (const board of jointLineBoard(poly[i - 1]!, poly[i]!)) {
                        take(board.x, board.y);
                    }
                }
            }
        } else {
            for (const path of group.paths) {
                for (const [x, y] of path) {
                    take(x, y);
                }
            }
        }
    }
    return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
}

/** A grid over a job with a margin, corners on whole tenths of a mm outward; null for a job with nothing enabled. */
export function gridForJob(job: Job, nx: number, ny: number, margin = FIT_MARGIN): Grid | null {
    const box = jobBox(job);
    if (box === null) {
        return null;
    }
    const down = (value: number): number => Math.floor(value * 10) / 10;
    const up = (value: number): number => Math.ceil(value * 10) / 10;
    let { x0, y0, x1, y1 } = { x0: down(box.x0 - margin), y0: down(box.y0 - margin), x1: up(box.x1 + margin), y1: up(box.y1 + margin) };
    // A job that is a line along one axis still needs a grid with area.
    if (x1 - x0 < 1) {
        x0 -= 0.5;
        x1 += 0.5;
    }
    if (y1 - y0 < 1) {
        y0 -= 0.5;
        y1 += 0.5;
    }
    return { x0, y0, x1, y1, nx, ny };
}

/** The fields of a grid typed in: its corners and its point counts. */
export type GridField = "x0" | "y0" | "x1" | "y1" | "nx" | "ny";
export const GRID_FIELDS: GridField[] = ["x0", "y0", "x1", "y1", "nx", "ny"];

/** The grid the fields describe, or a message saying which field is wrong. */
export function readGrid(fields: Record<GridField, string>): Grid | string {
    const out: Partial<Record<GridField, number>> = {};
    for (const key of GRID_FIELDS) {
        const value = parseNumber(fields[key]);
        if (value === null) {
            return `${key} is not a number`;
        }
        out[key] = value;
    }
    const grid = out as Grid;
    if (!(grid.x1 > grid.x0 && grid.y1 > grid.y0)) {
        return "the grid needs X to above X from, and Y to above Y from";
    }
    for (const key of ["nx", "ny"] as const) {
        if (!Number.isInteger(grid[key]) || grid[key] < 2 || grid[key] > 50) {
            return `points must be whole numbers from 2 to 50`;
        }
    }
    return grid;
}

/** A deviation with its sign, so a cell above the mean reads as such without its color. */
export function signed(value: number): string {
    const text = formatFixed(value, 3);
    return value > 0 && Number(text) !== 0 ? `+${text}` : text;
}

/** The pads' default area floor and point count, as the backend takes them. */
export const PADS_MIN_AREA = 0.5;
export const PADS_MAX_POINTS = 100;

/** A pad map: probed at a job's pads, its grid filled in from them. */
export function isPadMap(map: HeightMap | null): map is HeightMap & { points: [number, number][]; point_heights: (number | null)[] } {
    return map !== null && Array.isArray(map.points) && Array.isArray(map.point_heights);
}

/** How many points the map has, and how many are probed: its pads for a pad map, its grid cells otherwise. */
export function mapCounts(map: HeightMap): { probed: number; total: number } {
    if (isPadMap(map)) {
        return { probed: map.point_heights.filter((value) => value !== null).length, total: map.points.length };
    }
    return { probed: map.heights.flat().filter((value) => value !== null).length, total: gridPointCount(map.grid) };
}

/** Probed everywhere and told its focus offset: what a compensated run needs besides covering the job. */
export function mapUsable(map: HeightMap | null): boolean {
    return map !== null && map.focus_set && mapComplete(map);
}

/** Whether a grid point is probed at all: every one without a mask. */
export function gridWanted(grid: Grid, ix: number, iy: number): boolean {
    const mask = grid.mask;
    return !mask || Boolean(mask[iy]?.[ix]);
}

/** How many points a grid probes. */
export function gridPointCount(grid: Grid): number {
    let count = 0;
    for (let iy = 0; iy < grid.ny; iy++) {
        for (let ix = 0; ix < grid.nx; ix++) {
            if (gridWanted(grid, ix, iy)) {
                count += 1;
            }
        }
    }
    return count;
}

/** Probed at every point of its grid that is to be probed, or at every pad of a pad map. */
export function mapComplete(map: HeightMap | null): boolean {
    if (map === null) {
        return false;
    }
    if (isPadMap(map)) {
        return map.point_heights.every((value) => value !== null);
    }
    return map.heights.every((row, iy) => row.every((value, ix) => value !== null || !gridWanted(map.grid, ix, iy)));
}

/** Probed in part: some points still to come, which probing can go on with. */
export function mapPartial(map: HeightMap | null): boolean {
    if (map === null || mapComplete(map)) {
        return false;
    }
    return mapCounts(map).probed > 0;
}

/** What the progress line says of the point being probed: a pad's place on a pad map, a point's otherwise. */
export function probingText(probe: { done: number; total: number; pad?: number | null; seconds: number; remaining?: number | null }, padMap: boolean): string {
    const left = aboutTime(probe.remaining);
    const which = padMap ? `pad ${(probe.pad ?? probe.done) + 1} of ${probe.total}` : `point ${probe.done + 1} of ${probe.total}`;
    return `Probing ${which}, ${formatFixed(probe.seconds, 0)} s${left ? `, ${left} left` : ""}`;
}

/** "about 4 min" for a time in seconds; empty for none. */
export function aboutTime(seconds: number | null | undefined): string {
    if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
        return "";
    }
    return `about ${formatDuration(Math.max(0, seconds))}`;
}

/**
 * What to do before a run can follow a map that is probed everywhere but has
 * no focus offset: the backend drops the offset whenever the focus axis may
 * have been moved to other numbers (Set H=0, a connect, the firmware
 * restarting, a map loaded), and taking it again puts the map in the
 * current ones. Empty when there is nothing to do.
 */
export function focusAgainText(map: HeightMap | null, milling: boolean): string {
    if (!mapComplete(map) || map!.focus_set) {
        return "";
    }
    return milling
        ? "The height map has no touch-off offset: jog the tool onto the copper and Touch off here before a run follows it."
        : "The height map has no focus offset: focus the beam and Focus here before a run follows it.";
}

function focusStateText(map: HeightMap, milling: boolean): string {
    if (map.focus_set) {
        return "set";
    }
    if (!mapComplete(map)) {
        return "not set yet";
    }
    return milling ? "not set: Touch off here" : "not set: Focus here";
}

/** What the badge says about the map and the probing. */
export function mapStatus(state: HeightMapState | null): { text: string; kind: string } {
    const probe = state?.probe ?? null;
    if (probe !== null && probe.state === "running") {
        return { text: `probing ${probe.done}/${probe.total}`, kind: "running" };
    }
    const map = state?.map ?? null;
    if (map === null) {
        return { text: "no map", kind: "none" };
    }
    const { probed, total } = mapCounts(map);
    const pads = isPadMap(map) ? " pads" : "";
    if (probed < total) {
        return { text: `${probed}/${total}${pads} probed`, kind: "partial" };
    }
    return { text: map.focus_set ? "ready" : "focus not set", kind: map.focus_set ? "ready" : "partial" };
}

export function mountHeightMap(root: HTMLElement, ctx: Ctx): void {
    const badge = el("span", { class: "badge hm-badge" }, "no map");
    const body = el("fieldset", { class: "panel-body" });
    root.append(el("div", { class: "panel-head" }, el("h2", {}, "Height map"), badge), body);

    // --- where to probe ---
    const gridFields = {
        x0: numberField({ value: DEFAULT_GRID.x0, step: 1 }),
        x1: numberField({ value: DEFAULT_GRID.x1, step: 1 }),
        y0: numberField({ value: DEFAULT_GRID.y0, step: 1 }),
        y1: numberField({ value: DEFAULT_GRID.y1, step: 1 }),
        nx: numberField({ value: DEFAULT_GRID.nx, min: 2, max: 50, step: 1 }),
        ny: numberField({ value: DEFAULT_GRID.ny, min: 2, max: 50, step: 1 }),
    };
    const showGrid = (grid: Grid): void => {
        for (const key of GRID_FIELDS) {
            gridFields[key].value = String(grid[key]);
        }
        publishDraft();
    };
    // The preview draws the grid the fields describe, so where the points
    // fall on the job is seen before the head goes there.
    const publishDraft = (): void => {
        const grid = readGrid({
            x0: gridFields.x0.value,
            y0: gridFields.y0.value,
            x1: gridFields.x1.value,
            y1: gridFields.y1.value,
            nx: gridFields.nx.value,
            ny: gridFields.ny.value,
        });
        ctx.store.set({ probeDraft: typeof grid === "string" ? null : grid });
    };
    for (const field of Object.values(gridFields)) {
        field.addEventListener("input", publishDraft);
    }
    // What to probe: the whole rectangle, or only the points the selected
    // job's cuts come near, which on a sparse board is a fraction of them.
    const modeField = el("select", { class: "field", "aria-label": "What to probe" },
        el("option", { value: "grid" }, "the whole grid"),
        el("option", { value: "job" }, "around the job's cuts"),
    ) as HTMLSelectElement;
    const marginField = numberField({ value: 1, min: 0, step: 0.5, width: "5rem" });
    const marginLabel = labeled("Margin mm", marginField, "labeled inline hidden");
    const estimateNote = el("span", { class: "muted hm-estimate" });
    const probeRequest = (): ProbeRequest | string => {
        const grid = readGrid({
            x0: gridFields.x0.value,
            y0: gridFields.y0.value,
            x1: gridFields.x1.value,
            y1: gridFields.y1.value,
            nx: gridFields.nx.value,
            ny: gridFields.ny.value,
        });
        if (typeof grid === "string") {
            return grid;
        }
        if (modeField.value !== "job") {
            return grid;
        }
        const job = ctx.store.get().job;
        if (!job) {
            return "select a job to probe around its cuts";
        }
        const margin = parseNumber(marginField.value);
        if (margin === null || margin < 0) {
            return "the margin is a distance in mm, 0 or more";
        }
        return { ...grid, job: job.id, margin };
    };
    // The estimate, and the points the mask leaves, from the backend a
    // moment after the last change, so the preview shows what is probed.
    let estimateTimer: ReturnType<typeof setTimeout> | null = null;
    let estimateSeq = 0;
    const requestEstimate = (): void => {
        if (estimateTimer !== null) {
            clearTimeout(estimateTimer);
        }
        estimateTimer = setTimeout(() => {
            estimateTimer = null;
            const request = probeRequest();
            if (typeof request === "string") {
                estimateNote.textContent = "";
                return;
            }
            const seq = ++estimateSeq;
            void ctx.api.probeEstimate(request).then((estimate) => {
                if (seq !== estimateSeq) {
                    return;
                }
                estimateNote.textContent = `${estimate.points} points, ${aboutTime(estimate.seconds)}`;
                if (request.job) {
                    ctx.store.set({ probeDraft: estimate.grid });
                }
            }).catch(() => {
                estimateNote.textContent = "";
            });
        }, 300);
    };
    for (const field of Object.values(gridFields)) {
        field.addEventListener("input", requestEstimate);
    }
    marginField.addEventListener("input", requestEstimate);
    modeField.addEventListener("change", () => {
        marginLabel.classList.toggle("hidden", modeField.value !== "job");
        publishDraft();
        requestEstimate();
    });
    const fit = button("Fit to job", () => {
        const job = ctx.store.get().job;
        if (!job) {
            ctx.toast("error", "select a job to fit the grid to");
            return;
        }
        const nx = parseNumber(gridFields.nx.value) ?? DEFAULT_GRID.nx;
        const ny = parseNumber(gridFields.ny.value) ?? DEFAULT_GRID.ny;
        const grid = gridForJob(job, nx, ny);
        if (grid === null) {
            ctx.toast("error", "the job has nothing enabled to cut");
            return;
        }
        showGrid(grid);
    }, "btn btn-quiet");

    // --- how to probe ---
    const settingFields = {
        depth: numberField({ min: 0, step: 0.5 }),
        feed: numberField({ min: 0, step: 10 }),
        slow: numberField({ min: 0, step: 5 }),
        backoff: numberField({ min: 0, step: 0.1 }),
        along: numberField({ step: 0.5 }),
        across: numberField({ step: 0.5 }),
    };
    const sendSetting = async (patch: Partial<ProbeSettings>): Promise<void> => {
        const state = await ctx.call(ctx.api.probeSettings(patch));
        if (state) {
            ctx.store.set({ heightMap: state });
        } else {
            showSettings(ctx.store.get().heightMap?.settings ?? null);
        }
    };
    const onChange = (field: HTMLInputElement, make: (value: number) => Partial<ProbeSettings>): void => {
        field.addEventListener("change", () => {
            const value = parseNumber(field.value);
            if (value === null) {
                ctx.toast("error", "enter a number");
                showSettings(ctx.store.get().heightMap?.settings ?? null);
                return;
            }
            void sendSetting(make(value));
        });
    };
    onChange(settingFields.depth, (depth) => ({ depth }));
    onChange(settingFields.feed, (feed) => ({ feed }));
    onChange(settingFields.slow, (slow) => ({ slow }));
    onChange(settingFields.backoff, (backoff) => ({ backoff }));
    const offsetPatch = (): Partial<ProbeSettings> => ({
        offset: [parseNumber(settingFields.along.value) ?? 0, parseNumber(settingFields.across.value) ?? 0],
    });
    onChange(settingFields.along, () => offsetPatch());
    onChange(settingFields.across, () => offsetPatch());

    // How long the head goes on past the contact before it brakes: a
    // setting of the machine, not of this page, so it is written there.
    const queueField = numberField({ min: 0, max: PROBE_MS_MAX, step: 10 });
    queueField.addEventListener("change", () => {
        const value = parseNumber(queueField.value);
        if (value === null || !Number.isInteger(value) || value < 0 || value > PROBE_MS_MAX) {
            ctx.toast("error", `the probe queue is a whole number of ms from 0 to ${PROBE_MS_MAX}`);
            showQueue(ctx.store.get());
            return;
        }
        void (async () => {
            await ctx.call(ctx.api.updateSettings({ values: { probe_ms: value } }));
            await ctx.refreshSettings();
        })();
    });
    const showQueue = (state: AppState): void => {
        const value = state.settings?.values["probe_ms"];
        if (queueField !== document.activeElement) {
            queueField.value = value === undefined ? "" : String(value);
        }
    };

    const probeButton = button("Probe", () => startProbe(), "btn btn-primary");
    const continueButton = button("Continue", () => continueProbe(), "btn");
    const stopButton = button("Stop", () => ctx.call(ctx.api.probeStop()), "btn btn-danger");
    const probeNote = el("p", { class: "muted hint" });
    // The pads: for a probe that must land on copper, the board is probed
    // at the selected job's pads instead of a grid.
    const minAreaField = numberField({ value: PADS_MIN_AREA, min: 0.05, max: 1000, step: 0.1, width: "5.5rem" });
    minAreaField.setAttribute("aria-label", "Least pad area");
    const maxPointsField = numberField({ value: PADS_MAX_POINTS, min: 2, max: 2500, step: 1, width: "5.5rem" });
    maxPointsField.setAttribute("aria-label", "Most pads probed");
    const padsPlanButton = button("Plan", () => planPads(), "btn btn-quiet");
    const padsProbeButton = button("Probe pads", () => startPads(false), "btn btn-primary");
    const padsContinueButton = button("Continue", () => startPads(true), "btn hidden");
    const padsNote = el("span", { class: "muted hm-pads-note" });
    const padsRequest = (resume: boolean): PadProbeRequest | string => {
        const job = ctx.store.get().job;
        if (!job) {
            return "select a job to probe its pads";
        }
        const minArea = parseNumber(minAreaField.value);
        const maxPoints = parseNumber(maxPointsField.value);
        if (minArea === null || minArea <= 0) {
            return "the least pad area is in mm^2, above 0";
        }
        if (maxPoints === null || !Number.isInteger(maxPoints) || maxPoints < 2) {
            return "the most pads probed is a whole number, 2 or more";
        }
        return { job: job.id, min_area: minArea, max_points: maxPoints, resume };
    };
    // One probe under the head: the map tied to the frame in use after a
    // power cycle or a position set, or the surface made H 0 without a map.
    const probeHereMap = button("Probe here: tie map", () => probeHere("map"), "btn btn-quiet");
    const probeNearestMap = button("Probe nearest: tie map", () => probeNearest(), "btn btn-quiet");
    const probeHereZero = button("Probe here: set H 0", () => probeHere("zero"), "btn btn-quiet");
    const PROBE_HERE_HINT = "Probe here lowers the probe where the head is. Tie map: the height found against the map's"
        + " height there moves the map's offset, so a map probed before a power cycle, a restart or a position set"
        + " follows the board again without probing it all over; put the tip over copper the map covers, not in a"
        + " cut. Probe nearest goes to the probed point nearest the tip that the loaded job's cuts (or the last"
        + " run's) keep clear of, and ties the map there. Set H 0: the surface found becomes H 0, for milling"
        + " without a map.";

    // --- the map ---
    const mapBox = el("div", { class: "hm-map" });
    const legend = el("div", { class: "hm-legend" });

    // --- focus ---
    // On a spindle machine the focus offset is the touch-off: the tool, not
    // a beam, is brought to the surface, and a cut goes that far below it.
    const FOCUS_HINT = "Focus the beam by eye over the probed area by jogging the head up or down, then"
        + " Focus here: the offset is the head's height less the board's under the beam.";
    const TOUCH_HINT = "Jog the tool down over the probed area until it just touches the copper, then"
        + " Touch off here: the offset is the tool's height less the probed height there. With the"
        + " tool as the probe (tip offsets 0) it is about 0. A cut goes the group's depth under that.";
    const focusHint = el("p", { class: "muted hint" }, FOCUS_HINT);
    const focusField = numberField({ step: 0.05 });
    // The text the field was last given from the map: a field still showing
    // it follows the map, one typed in keeps what was typed until Set.
    let focusShown: string | null = null;
    const rayleighField = numberField({ min: 0, step: 0.1 });
    onChange(rayleighField, (rayleigh) => ({ rayleigh }));
    const focusState = el("span", { class: "muted" });
    const setFocus = button("Set", () => {
        const offset = parseNumber(focusField.value);
        if (offset === null) {
            ctx.toast("error", "enter the focus offset in mm");
            return undefined;
        }
        return applyFocus(offset);
    }, "btn btn-quiet");
    focusField.addEventListener("keydown", (event) => {
        if ((event as KeyboardEvent).key === "Enter") {
            event.preventDefault();
            setFocus.click();
        }
    });
    const focusHere = button("Focus here", () => applyFocus(null), "btn");
    const focusLabel = labeled("Focus offset mm", focusField, "labeled inline");
    const loadInput = el("input", { type: "file", accept: ".json,application/json", class: "hidden" }) as HTMLInputElement;
    loadInput.addEventListener("change", () => {
        const file = loadInput.files?.[0];
        loadInput.value = "";
        if (file) {
            void loadMap(file);
        }
    });
    const saveButton = button("Save map", () => saveMap(), "btn btn-quiet");
    const loadButton = button("Load map", () => loadInput.click(), "btn btn-quiet");
    const clearButton = button("Clear", () => clearMap(), "btn btn-quiet");

    body.append(
        el("div", { class: "field-grid hm-grid-fields" },
            labeled("X from mm", gridFields.x0),
            labeled("X to mm", gridFields.x1),
            labeled("Y from mm", gridFields.y0),
            labeled("Y to mm", gridFields.y1),
            labeled("Points X", gridFields.nx),
            labeled("Points Y", gridFields.ny),
        ),
        el("details", { class: "hm-probe-settings" },
            el("summary", {}, "Probe"),
            el("div", { class: "field-grid" },
                labeled("Depth mm", settingFields.depth),
                labeled("Feed mm/min", settingFields.feed),
                labeled("Slow mm/min", settingFields.slow),
                labeled("Back-off mm", settingFields.backoff),
                labeled("Tip along mm", settingFields.along),
                labeled("Tip across mm", settingFields.across),
                labeled("Brake queue ms", queueField),
            ),
            el("p", { class: "muted hint" },
                "Depth is the most the probe goes down from where the head starts. Slow 0 touches once."
                + " The tip offset is from the beam: along the rail, outward positive, and across it,"
                + " positive to the left of outward seen from above (board +Y at table angle 0, +Z on an"
                + " X/Y machine). To check the signs, probe one point, then jog the beam over it and compare."
                + " Before the first probe, watch the Probe readout: it must say up with the tip free and down"
                + " when the tip touches; the other way round, set invert = true under [probe] in the machine"
                + " file ($probe_invert). The brake queue is how long the head goes on past the contact before it brakes;"
                + " the height is read at the contact either way. 0 stops it dead when the probe is"
                + " no faster than h_jerk. It is a machine setting: Save to flash keeps it."),
        ),
        el("div", { class: "button-row" }, modeField, marginLabel, fit, estimateNote),
        el("div", { class: "button-row" }, probeButton, continueButton, stopButton),
        probeNote,
        el("div", { class: "button-row hm-pads" },
            el("span", { class: "choice-label" }, "Pads"),
            labeled("Min area mm^2", minAreaField, "labeled inline"),
            labeled("Max points", maxPointsField, "labeled inline"),
            padsPlanButton,
            padsProbeButton,
            padsContinueButton,
            padsNote,
        ),
        el("p", { class: "muted hint" },
            "Probe pads touches the selected job's pads instead of a grid, for a probe that must land on copper (a conductive probe,"
            + " or the tool itself): every pad of at least the area, the most spread out of them over the count, in a short tour."
            + " The map's grid is filled in from the pads probed."),
        el("div", { class: "button-row" }, probeHereMap, probeNearestMap, probeHereZero),
        el("p", { class: "muted hint" }, PROBE_HERE_HINT),
        mapBox,
        legend,
        el("div", { class: "button-row hm-focus" },
            focusLabel,
            setFocus,
            focusHere,
            focusState,
        ),
        focusHint,
        el("div", { class: "button-row" },
            labeled("Rayleigh mm", rayleighField, "labeled inline"),
            saveButton, loadButton, clearButton, loadInput,
        ),
    );

    async function startProbe(): Promise<void> {
        const request = probeRequest();
        if (typeof request === "string") {
            ctx.toast("error", request);
            return;
        }
        const estimate = await ctx.call(ctx.api.probeEstimate(request));
        const points = estimate ? estimate.points : gridPointCount(request);
        const time = estimate ? `, ${aboutTime(estimate.seconds)}` : "";
        const ok = await askConfirm(
            `Probe ${points} points${time}? The head travels between them at the height it has now,`
            + " so it must clear the board, and it replaces the current map.",
            "Probe",
        );
        if (!ok) {
            return;
        }
        const state = await ctx.call(ctx.api.probe(request));
        if (state) {
            ctx.store.set({ heightMap: state });
        }
    }

    async function planPads(): Promise<void> {
        const request = padsRequest(false);
        if (typeof request === "string") {
            ctx.toast("error", request);
            return;
        }
        const plan = await ctx.call(ctx.api.planPads(request));
        if (!plan) {
            return;
        }
        const skipped = plan.skipped > 0 ? `, ${plan.skipped} of ${plan.pads} pads under the area` : `, of ${plan.pads} pads`;
        padsNote.textContent = `${plan.points.length} points${skipped}, ${aboutTime(plan.seconds)}`;
    }

    async function startPads(resume: boolean): Promise<void> {
        const request = padsRequest(resume);
        if (typeof request === "string") {
            ctx.toast("error", request);
            return;
        }
        const plan = await ctx.call(ctx.api.planPads(request));
        if (!plan) {
            return;
        }
        const question = resume
            ? `Go on probing the ${plan.points.length} pads the map still lacks, ${aboutTime(plan.seconds)}? The head travels at the height it has now, so it must clear the board.`
            : `Probe ${plan.points.length} pads, ${aboutTime(plan.seconds)}? The head travels between them at the height it has now, so it must clear the board, and it replaces the current map.`;
        if (!(await askConfirm(question, resume ? "Continue" : "Probe pads"))) {
            return;
        }
        const state = await ctx.call(ctx.api.probePads(request));
        if (state) {
            ctx.store.set({ heightMap: state });
        }
    }

    async function continueProbe(): Promise<void> {
        const map = ctx.store.get().heightMap?.map;
        if (!map) {
            return;
        }
        const left = gridPointCount(map.grid) - map.heights.flat().filter((value) => value !== null).length;
        const ok = await askConfirm(
            `Go on probing the ${left} points the map still lacks? The head travels at the height it has now,`
            + " so it must clear the board.",
            "Continue",
        );
        if (!ok) {
            return;
        }
        const state = await ctx.call(ctx.api.probe({ ...map.grid, resume: true }));
        if (state) {
            ctx.store.set({ heightMap: state });
        }
    }

    async function probeHere(mode: TouchMode): Promise<void> {
        const question = mode === "map"
            ? "Probe down here and tie the height map to the current frame by the height found? The tip must be over copper the map covers."
            : "Probe down here and make the surface found H 0? The height map's offset, if any, is taken back.";
        if (!(await askConfirm(question, "Probe here"))) {
            return;
        }
        const state = await ctx.call(ctx.api.probeHere({ mode }));
        if (state) {
            ctx.store.set({ heightMap: state });
        }
    }

    // The backend picks the point and says where it is before anything
    // moves, so the operator sees the move they are agreeing to.
    async function probeNearest(): Promise<void> {
        const request = { mode: "map" as const, at: "nearest" as const, job: ctx.store.get().job?.id };
        const plan = await ctx.call(ctx.api.planTouch(request));
        if (!plan) {
            return;
        }
        const [x, y] = plan.point;
        const question = `Go to X ${formatFixed(x, 2)} Y ${formatFixed(y, 2)}, the probed point ${formatFixed(plan.distance, 1)} mm`
            + " from the tip that the job's cuts keep clear of, probe down there and tie the height map to the current frame?";
        if (!(await askConfirm(question, "Probe nearest"))) {
            return;
        }
        const state = await ctx.call(ctx.api.probeHere(request));
        if (state) {
            ctx.store.set({ heightMap: state });
        }
    }

    async function applyFocus(offset: number | null): Promise<void> {
        const state = await ctx.call(ctx.api.focus(offset));
        if (state) {
            ctx.store.set({ heightMap: state });
            ctx.toast("info", `focus offset ${formatFixed(state.map?.focus_offset ?? 0, 3)} mm`);
        }
    }

    function saveMap(): void {
        const map = ctx.store.get().heightMap?.map;
        if (!map) {
            ctx.toast("error", "there is no map to save");
            return;
        }
        const blob = new Blob([JSON.stringify(map, null, 2)], { type: "application/json" });
        const link = el("a", { href: URL.createObjectURL(blob), download: "heightmap.json" });
        link.click();
        URL.revokeObjectURL(link.href);
    }

    async function loadMap(file: File): Promise<void> {
        let map: HeightMap;
        try {
            map = JSON.parse(await file.text()) as HeightMap;
        } catch {
            ctx.toast("error", `${file.name} is not JSON`);
            return;
        }
        const state = await ctx.call(ctx.api.putHeightMap(map));
        if (state) {
            ctx.store.set({ heightMap: state });
            if (state.map) {
                showGrid(state.map.grid);
            }
        }
    }

    async function clearMap(): Promise<void> {
        if (!(await askConfirm("Clear the height map? A compensated run needs it probed again.", "Clear"))) {
            return;
        }
        const state = await ctx.call(ctx.api.clearHeightMap());
        if (state) {
            ctx.store.set({ heightMap: state });
        }
    }

    function showSettings(settings: ProbeSettings | null): void {
        if (settings === null) {
            return;
        }
        const focused = document.activeElement;
        const put = (field: HTMLInputElement, value: number): void => {
            if (field !== focused) {
                field.value = String(value);
            }
        };
        put(settingFields.depth, settings.depth);
        put(settingFields.feed, settings.feed);
        put(settingFields.slow, settings.slow);
        put(settingFields.backoff, settings.backoff);
        put(settingFields.along, settings.offset[0]);
        put(settingFields.across, settings.offset[1]);
        put(rayleighField, settings.rayleigh);
    }

    let shownGridOf: HeightMap | null = null;
    function renderMap(state: HeightMapState | null): void {
        const map = state?.map ?? null;
        if (map === null) {
            replace(mapBox, el("p", { class: "muted" }, "no height map yet"));
            replace(legend);
            return;
        }
        // The grid fields follow a map that arrives (a load, another page's
        // probe), not every update of the one being probed.
        if (shownGridOf === null || shownGridOf.created !== map.created) {
            showGrid(map.grid);
        }
        shownGridOf = map;
        const stats = heightStats(map);
        const probing = state?.probe?.state === "running" ? state.probe.point : null;
        const showValues = map.grid.nx <= LABELED_POINTS && !isPadMap(map);
        const xs = Array.from({ length: map.grid.nx }, (_, i) => map.grid.x0 + (map.grid.x1 - map.grid.x0) * i / (map.grid.nx - 1));
        const ys = Array.from({ length: map.grid.ny }, (_, j) => map.grid.y0 + (map.grid.y1 - map.grid.y0) * j / (map.grid.ny - 1));
        const table = el("table", { class: "hm-table", "aria-label": "Board height at each probe point, rows from the top of the board" });
        // Rows from the highest Y down, so the table reads as the board seen
        // from above, the same way up as the preview.
        for (let iy = map.grid.ny - 1; iy >= 0; iy--) {
            const row = el("tr");
            for (let ix = 0; ix < map.grid.nx; ix++) {
                const value = map.heights[iy]?.[ix] ?? null;
                const wanted = gridWanted(map.grid, ix, iy);
                const where = `X ${formatFixed(xs[ix], 1)} Y ${formatFixed(ys[iy], 1)}`;
                const text = value === null ? (wanted ? "not probed" : "left out: no cut comes near") : `${formatFixed(value, 3)} mm`;
                const cell = el("td", {
                    class: wanted ? "hm-cell" : "hm-cell hm-cell-skipped",
                    title: `${where}: ${text}`,
                    "aria-label": `${where}: ${text}`,
                    tabindex: 0,
                    "data-probing": probing !== null && probing[0] === ix && probing[1] === iy,
                });
                cell.style.background = cellColor(value, stats);
                if (showValues && value !== null && stats !== null) {
                    cell.textContent = signed(value - stats.mean);
                }
                row.append(cell);
            }
            table.append(row);
        }
        replace(mapBox, table);
        if (stats === null) {
            replace(legend);
            return;
        }
        const ends = legendEnds(stats);
        replace(legend,
            el("div", { class: "hm-scale", title: "Height off the mean; the ends are the strongest colors a cell has" },
                el("span", {}, ends.low),
                el("span", { class: "hm-ramp", "aria-hidden": "true" }),
                el("span", {}, ends.high),
            ),
            el("span", { class: "muted" },
                `mean ${formatFixed(stats.mean, 3)} mm, lowest ${formatFixed(stats.min, 3)}, highest ${formatFixed(stats.max, 3)},`
                + ` span ${formatFixed(stats.max - stats.min, 3)} mm`
                + (showValues ? "; cells show the height above the mean" : "")),
        );
    }

    function render(state: AppState): void {
        const heightMap = state.heightMap;
        const status = mapStatus(heightMap);
        badge.textContent = status.text;
        badge.setAttribute("data-map", status.kind);
        const machine = state.snapshot.machine;
        const connected = state.snapshot.connected;
        const probing = heightMap?.probe?.state === "running";
        const running = (state.progress ?? state.snapshot.run)?.state;
        const busy = running === "running" || running === "hold";
        const focusAxis = machine?.joint.h !== null && machine?.joint.h !== undefined;
        const idle = machine?.state === "Idle";
        const milling = isMilling(state.snapshot);
        // The needle stands in for the tool on a dispenser: it is touched
        // off like one, with no beam to focus.
        const touchOff = milling || isDispensing(state.snapshot);
        // The tool can be the probe on a spindle machine: a probe run with
        // it turning mills a hole at every point. A stopped spindle on an
        // active-low output reports its pin at full duty.
        const spinning = milling && machine !== null && outputDuty(machine.laser, state.settings) > 0;
        body.disabled = !connected;
        const canProbe = connected && focusAxis && idle && !probing && !busy && !spinning;
        setLocked(probeButton, !canProbe);
        const stored = heightMap?.map ?? null;
        const padMap = isPadMap(stored);
        const partial = mapPartial(stored);
        continueButton.classList.toggle("hidden", !partial || padMap);
        setLocked(continueButton, !canProbe || !partial || padMap);
        padsContinueButton.classList.toggle("hidden", !partial || !padMap);
        setLocked(padsContinueButton, !canProbe || !partial || !padMap || !state.job);
        setLocked(padsProbeButton, !canProbe || !state.job);
        setLocked(padsPlanButton, !state.job);
        setLocked(probeHereMap, !canProbe || !heightMap?.map);
        setLocked(probeNearestMap, !canProbe || !heightMap?.map);
        setLocked(probeHereZero, !canProbe);
        probeHereZero.textContent = milling ? "Probe here: set Z 0" : "Probe here: set H 0";
        setLocked(stopButton, !probing);
        setLocked(focusHere, !connected || !heightMap?.map || !idle || probing);
        focusHere.textContent = touchOff ? "Touch off here" : "Focus here";
        focusHint.textContent = touchOff ? TOUCH_HINT : FOCUS_HINT;
        const offsetText = focusLabel.querySelector(".labeled-text");
        if (offsetText) {
            offsetText.textContent = touchOff ? "Touch-off offset mm" : "Focus offset mm";
        }
        setLocked(setFocus, !heightMap?.map || probing);
        setLocked(clearButton, !heightMap?.map || probing);
        setLocked(loadButton, probing);
        setLocked(saveButton, !heightMap?.map);
        const probe = heightMap?.probe ?? null;
        if (connected && machine && !focusAxis) {
            probeNote.textContent = "No focus axis: set h_axis to 1 in the settings to probe.";
        } else if (probe?.state === "error" || probe?.state === "stopped") {
            probeNote.textContent = `Probing ${probe.state}${probe.error ? `: ${probe.error}` : ""}`;
        } else if (probing && probe && probe.done >= probe.total) {
            // The last point is in; the head rises back before probing ends.
            probeNote.textContent = `Probed all ${probe.total} ${padMap ? "pads" : "points"}, the head is rising, ${formatFixed(probe.seconds, 0)} s`;
        } else if (probing && probe) {
            probeNote.textContent = probingText(probe, padMap);
        } else if (spinning) {
            probeNote.textContent = "The spindle is turning: stop it before probing.";
        } else {
            probeNote.textContent = "Raise the head so the probe clears the board: probing travels at that height.";
        }
        const map = heightMap?.map ?? null;
        if (map) {
            // Only a field still showing what the map last said follows the
            // map: one typed in keeps its text, focused or not, until Set.
            const text = String(map.focus_offset);
            const untouched = focusShown === null || focusField.value === focusShown || focusField.value === "";
            if (untouched && focusField !== document.activeElement && focusField.value !== text) {
                focusField.value = text;
            }
            focusShown = text;
            focusState.textContent = focusStateText(map, touchOff);
        } else {
            focusState.textContent = "";
        }
    }

    // The map and the settings only when they change; the controls with the
    // machine's state too, which arrives several times a second.
    const renderData = (state: AppState): void => {
        showSettings(state.heightMap?.settings ?? null);
        renderMap(state.heightMap);
    };
    ctx.store.subscribe((state) => renderData(state), ["heightMap"]);
    // The estimate follows the job (its cuts) and the probe settings (the depth and feeds).
    ctx.store.subscribe(() => requestEstimate(), ["job"]);
    ctx.store.subscribe((state, previous) => {
        if (state.heightMap?.settings !== previous.heightMap?.settings) {
            requestEstimate();
        }
    }, ["heightMap"]);
    publishDraft();
    requestEstimate();
    // The pads' buttons want a selected job, so the job is watched too.
    ctx.store.subscribe((state) => render(state), ["heightMap", "snapshot", "progress", "settings", "job"]);
    ctx.store.subscribe((state) => showQueue(state), ["settings"]);
    showQueue(ctx.store.get());
    renderData(ctx.store.get());
    render(ctx.store.get());
}
