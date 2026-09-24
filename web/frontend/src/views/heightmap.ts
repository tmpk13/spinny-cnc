// The height map: where to probe, how, the probing under way, the heights as
// a map of the board, and the focus offset a compensated run needs.

import { askConfirm } from "../confirm.ts";
import { button, el, labeled, numberField, replace, setLocked } from "../dom.ts";
import { formatFixed, parseNumber } from "../format.ts";
import { boardOfJoint } from "../kinematics.ts";
import type { AppState } from "../state.ts";
import type { Grid, HeightMap, HeightMapState, Job, ProbeSettings } from "../types.ts";
import type { Ctx } from "./context.ts";

/** A grid when there is neither a map nor a job to take one from. */
export const DEFAULT_GRID: Grid = { x0: -20, y0: -20, x1: 20, y1: 20, nx: 5, ny: 5 };
/** How far past the job a grid made to fit it reaches, mm. */
export const FIT_MARGIN = 1;
/** Above this many points a side the cells are too small to carry their value. */
export const LABELED_POINTS = 8;
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

/** Board points of the enabled groups of a job; joint-space groups on the board. */
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
                for (const [r, a] of poly) {
                    const board = boardOfJoint({ r, a });
                    take(board.x, board.y);
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

/** The grid the fields describe, or a message saying which field is wrong. */
export function readGrid(fields: Record<keyof Grid, string>): Grid | string {
    const out: Partial<Grid> = {};
    for (const key of ["x0", "y0", "x1", "y1", "nx", "ny"] as (keyof Grid)[]) {
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

/** Probed everywhere and told its focus offset: what a compensated run needs besides covering the job. */
export function mapUsable(map: HeightMap | null): boolean {
    return map !== null && map.focus_set && map.heights.every((row) => row.every((value) => value !== null));
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
    const stats = heightStats(map);
    const total = map.grid.nx * map.grid.ny;
    if (stats === null || stats.probed < total) {
        return { text: `${stats?.probed ?? 0}/${total} probed`, kind: "partial" };
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
        for (const key of Object.keys(gridFields) as (keyof Grid)[]) {
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

    const probeButton = button("Probe", () => startProbe(), "btn btn-primary");
    const stopButton = button("Stop", () => ctx.call(ctx.api.probeStop()), "btn btn-danger");
    const probeNote = el("p", { class: "muted hint" });

    // --- the map ---
    const mapBox = el("div", { class: "hm-map" });
    const legend = el("div", { class: "hm-legend" });

    // --- focus ---
    const focusField = numberField({ step: 0.05 });
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
    const focusHere = button("Focus here", () => applyFocus(null), "btn");
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
            ),
            el("p", { class: "muted hint" },
                "Depth is the most the probe goes down from where the head starts. Slow 0 touches once."
                + " The tip offset is from the beam: along the rail, outward positive, and across it."),
        ),
        el("div", { class: "button-row" }, fit, probeButton, stopButton),
        probeNote,
        mapBox,
        legend,
        el("div", { class: "button-row hm-focus" },
            labeled("Focus offset mm", focusField, "labeled inline"),
            setFocus,
            focusHere,
            focusState,
        ),
        el("p", { class: "muted hint" },
            "Focus the beam by eye over the probed area by jogging the head up or down, then"
            + " Focus here: the offset is the head's height less the board's under the beam."),
        el("div", { class: "button-row" },
            labeled("Rayleigh mm", rayleighField, "labeled inline"),
            saveButton, loadButton, clearButton, loadInput,
        ),
    );

    async function startProbe(): Promise<void> {
        const grid = readGrid({
            x0: gridFields.x0.value,
            y0: gridFields.y0.value,
            x1: gridFields.x1.value,
            y1: gridFields.y1.value,
            nx: gridFields.nx.value,
            ny: gridFields.ny.value,
        });
        if (typeof grid === "string") {
            ctx.toast("error", grid);
            return;
        }
        const ok = await askConfirm(
            `Probe ${grid.nx * grid.ny} points? The head travels between them at the height it has now,`
            + " so it must clear the board, and it replaces the current map.",
            "Probe",
        );
        if (!ok) {
            return;
        }
        const state = await ctx.call(ctx.api.probe(grid));
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
        const showValues = map.grid.nx <= LABELED_POINTS;
        const xs = Array.from({ length: map.grid.nx }, (_, i) => map.grid.x0 + (map.grid.x1 - map.grid.x0) * i / (map.grid.nx - 1));
        const ys = Array.from({ length: map.grid.ny }, (_, j) => map.grid.y0 + (map.grid.y1 - map.grid.y0) * j / (map.grid.ny - 1));
        const table = el("table", { class: "hm-table", "aria-label": "Board height at each probe point, rows from the top of the board" });
        // Rows from the highest Y down, so the table reads as the board seen
        // from above, the same way up as the preview.
        for (let iy = map.grid.ny - 1; iy >= 0; iy--) {
            const row = el("tr");
            for (let ix = 0; ix < map.grid.nx; ix++) {
                const value = map.heights[iy]?.[ix] ?? null;
                const where = `X ${formatFixed(xs[ix], 1)} Y ${formatFixed(ys[iy], 1)}`;
                const text = value === null ? "not probed" : `${formatFixed(value, 3)} mm`;
                const cell = el("td", {
                    class: "hm-cell",
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
        replace(legend,
            el("div", { class: "hm-scale" },
                el("span", {}, `low ${formatFixed(stats.min, 3)}`),
                el("span", { class: "hm-ramp", "aria-hidden": "true" }),
                el("span", {}, `high ${formatFixed(stats.max, 3)}`),
            ),
            el("span", { class: "muted" },
                `mean ${formatFixed(stats.mean, 3)} mm, span ${formatFixed(stats.max - stats.min, 3)} mm`
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
        body.disabled = !connected;
        setLocked(probeButton, !connected || !focusAxis || !idle || probing || busy);
        setLocked(stopButton, !probing);
        setLocked(focusHere, !connected || !heightMap?.map || !idle || probing);
        setLocked(setFocus, !heightMap?.map || probing);
        setLocked(clearButton, !heightMap?.map || probing);
        setLocked(loadButton, probing);
        setLocked(saveButton, !heightMap?.map);
        const probe = heightMap?.probe ?? null;
        if (connected && machine && !focusAxis) {
            probeNote.textContent = "No focus axis: set h_axis to 1 in the settings to probe.";
        } else if (probe?.state === "error" || probe?.state === "stopped") {
            probeNote.textContent = `Probing ${probe.state}${probe.error ? `: ${probe.error}` : ""}`;
        } else if (probing && probe) {
            probeNote.textContent = `Probing point ${probe.done + 1} of ${probe.total}, ${formatFixed(probe.seconds, 0)} s`;
        } else {
            probeNote.textContent = "Raise the head so the probe clears the board: probing travels at that height.";
        }
        const map = heightMap?.map ?? null;
        if (map) {
            if (focusField !== document.activeElement) {
                focusField.value = String(map.focus_offset);
            }
            focusState.textContent = map.focus_set ? "set" : "not set yet";
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
    publishDraft();
    ctx.store.subscribe((state) => render(state), ["heightMap", "snapshot", "progress"]);
    renderData(ctx.store.get());
    render(ctx.store.get());
}
