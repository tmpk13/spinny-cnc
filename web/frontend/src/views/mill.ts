// The Mill page: one simple cut at a time, the way a manual mill is used.
// Pick what to cut (points drilled, a board job's holes, a line through
// points, a face, or a pocket or a profile of a rectangle or a circle),
// give its corners or center by typing them, from where the head is or
// from a marker, and the bit, the depth and the feeds. The operation is
// planned as it is typed and drawn on the page's preview, then made into a
// job, which the run panel beside it runs. The fields are remembered in
// this browser.

import { button, el, labeled, numberField, replace, setLocked } from "../dom.ts";
import { formatDuration, formatLength, formatMm, parseNumber } from "../format.ts";
import { isMilling } from "../profile.ts";
import type { AppState } from "../state.ts";
import type { Compensate, HolePoint, Job, MillKind, MillOperation, MillShape, MillSide, Point } from "../types.ts";
import { choiceRow, setPressed, type Ctx } from "./context.ts";
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
export function millNeeds(kind: MillKind, shape: MillShape): { points: boolean; closed: boolean; rect: boolean; circle: boolean; holes: boolean; stepover: boolean; direction: boolean; side: boolean; shape: boolean } {
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
    };
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

export function pointsText(points: Point[]): string {
    return points.map(([x, y]) => `${formatMm(x)}, ${formatMm(y)}`).join("\n");
}

/** A job's holes by size, smallest first, with how many there are of each. */
export function holeSizes(holes: HolePoint[]): { size: number; count: number }[] {
    const counts = new Map<number, number>();
    for (const [, , diameter] of holes) {
        const size = Math.round(diameter * 100) / 100;
        counts.set(size, (counts.get(size) ?? 0) + 1);
    }
    return [...counts.entries()].sort(([a], [b]) => a - b).map(([size, count]) => ({ size, count }));
}

/** The fields remembered from the last visit; anything that does not read is left out. */
export function readStoredOperation(): Partial<MillOperation> {
    try {
        const text = globalThis.localStorage?.getItem(MILL_KEY);
        const data: unknown = text ? JSON.parse(text) : null;
        return data && typeof data === "object" ? (data as Partial<MillOperation>) : {};
    } catch {
        return {};
    }
}

function storeOperation(op: Partial<MillOperation>): void {
    try {
        globalThis.localStorage?.setItem(MILL_KEY, JSON.stringify(op));
    } catch {
        // Not remembered; the fields still hold for this visit.
    }
}

const DEFAULTS = {
    tool: 1,
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
    // The holes' job, and the sizes left out of it, kept apart from the
    // job's own list so a size comes back checked when the job does.
    let holesJob: Job | null = null;
    const skipped = new Set<number>();

    const field = (value: number | undefined, fallback: number, options: { min?: number; step?: number } = {}): HTMLInputElement =>
        numberField({ value: typeof value === "number" && Number.isFinite(value) ? value : fallback, ...options });
    const tool = field(stored.tool, DEFAULTS.tool, { min: 0.01, step: 0.1 });
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
    const cx = field(stored.cx, 0);
    const cy = field(stored.cy, 0);
    const diameter = field(stored.diameter, 10, { min: 0 });
    const name = el("input", { type: "text", class: "field", placeholder: "made from the operation", spellcheck: "false", "aria-label": "Job name" }) as HTMLInputElement;
    const points = el("textarea", { class: "field mill-points", rows: "4", spellcheck: "false", placeholder: "x, y\none point a line", "aria-label": "Points" }) as HTMLTextAreaElement;
    points.value = Array.isArray(stored.points) ? pointsText(stored.points) : "";
    const closed = el("input", { type: "checkbox", "aria-label": "Closed line" }) as HTMLInputElement;
    closed.checked = stored.closed === true;
    const bore = el("input", { type: "checkbox", "aria-label": "Bore wide holes" }) as HTMLInputElement;
    bore.checked = stored.bore !== false;
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
    };
    for (const label of Object.values(labels)) {
        label.querySelector("input")?.setAttribute("aria-label", label.querySelector(".labeled-text")?.textContent ?? "");
    }
    labels["stepover"]!.title = "how far apart a face's rows or a pocket's loops are, as a share of the bit";
    labels["depth"]!.title = "how deep under the surface the cut ends";
    labels["stepDown"]!.title = "how far each pass goes down: the passes are as many as it takes to the depth";

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
            fx.value = formatMm(head.x);
            fy.value = formatMm(head.y);
            changed();
        }, "btn btn-quiet btn-small");
        here.title = "take where the head is over the board";
        const pick = markerPicker(ctx, "marker", (marker) => {
            fx.value = formatMm(marker.x);
            fy.value = formatMm(marker.y);
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
        appendPoint([head.x, head.y]);
    }, "btn btn-quiet btn-small");
    addHere.title = "add where the head is over the board";
    const addMarker = markerPicker(ctx, "add marker", (marker) => appendPoint([marker.x, marker.y]));
    const addAll = button("All markers", () => {
        for (const marker of ctx.store.get().markers) {
            appendPoint([marker.x, marker.y]);
        }
    }, "btn btn-quiet btn-small");
    const clearPoints = button("Clear", () => {
        points.value = "";
        changed();
    }, "btn btn-quiet btn-small");
    const closedLabel = el("label", { class: "muted" }, closed, " back to the first point");

    const pointsBox = el("div", { class: "mill-section" },
        labeled("Points, board mm", points),
        el("div", { class: "button-row" }, addHere, addMarker, addAll, clearPoints, closedLabel),
    );
    const rectBox = el("div", { class: "mill-section" }, pointRow("Corner", x0, y0), pointRow("Corner", x1, y1));
    diameter.setAttribute("aria-label", "Diameter");
    const circleBox = el("div", { class: "mill-section" }, pointRow("Center", cx, cy), el("div", { class: "field-row" }, labeled("Diameter mm", diameter)));
    const holesBox = el("div", { class: "mill-section" },
        labeled("Holes of", holesSelect),
        sizesBox,
        el("label", { class: "muted" }, bore, " bore a hole wider than the bit out with it, in rings"),
    );
    const cutGrid = el("div", { class: "field-grid" }, ...Object.values(labels));
    const notes = el("ul", { class: "mill-notes muted" });
    const problem = el("p", { class: "mill-problem hidden", role: "alert" });
    const makeButton = button("Make job", () => make(), "btn btn-primary");
    makeButton.title = "store the operation as a job, selected, ready to run";
    const machineNote = el("p", { class: "muted hint hidden" });

    roots.operation.append(
        el("div", { class: "panel-head" }, el("h2", {}, "Operation"), el("div", { class: "button-row" }, makeButton)),
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
        el("p", { class: "muted hint" }, "positions are board mm; the depth is under the surface where the tool was zeroed"),
    );

    for (const input of [tool, depth, stepDown, stepover, speed, plunge, spindle, x0, y0, x1, y1, cx, cy, diameter, name, points]) {
        input.addEventListener("input", () => changed());
    }
    for (const input of [closed, bore]) {
        input.addEventListener("change", () => changed());
    }
    holesSelect.addEventListener("change", () => void loadHoles(holesSelect.value));

    function appendPoint(point: Point): void {
        const text = points.value.trimEnd();
        points.value = `${text}${text ? "\n" : ""}${formatMm(point[0])}, ${formatMm(point[1])}`;
        changed();
    }

    /** The operation the fields describe, or what is wrong with them. */
    function read(): MillOperation | string {
        const number = (input: HTMLInputElement, what: string): number | string => parseNumber(input.value) ?? `${what} needs a number`;
        const values = {
            tool: number(tool, "the bit"),
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
            cx: number(cx, "the center"),
            cy: number(cy, "the center"),
            diameter: number(diameter, "the diameter"),
        };
        const needs = millNeeds(kind, shape);
        const used = ["tool", "depth", "step_down", "speed", "plunge", "spindle"];
        if (needs.stepover) {
            used.push("stepover");
        }
        if (needs.rect) {
            used.push("x0", "y0", "x1", "y1");
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
        let list: Point[] = [];
        if (needs.points) {
            const parsed = parsePoints(points.value);
            if (typeof parsed === "string") {
                return parsed;
            }
            list = parsed;
        }
        let sizes: number[] | null = null;
        if (needs.holes) {
            if (!holesJob) {
                return "pick a job with drill holes";
            }
            sizes = holeSizes(holesJob.holes ?? []).map((entry) => entry.size).filter((size) => !skipped.has(size));
        }
        return {
            kind,
            name: name.value.trim() || null,
            ...numbers,
            climb,
            points: list,
            closed: closed.checked,
            shape,
            side,
            job: needs.holes ? holesJob?.id ?? null : null,
            sizes,
            bore: bore.checked,
        };
    }

    function show(): void {
        const needs = millNeeds(kind, shape);
        shapes.classList.toggle("hidden", !needs.shape);
        sides.classList.toggle("hidden", !needs.side);
        directions.classList.toggle("hidden", !needs.direction);
        rectBox.classList.toggle("hidden", !needs.rect);
        circleBox.classList.toggle("hidden", !needs.circle);
        pointsBox.classList.toggle("hidden", !needs.points);
        closedLabel.classList.toggle("hidden", !needs.closed);
        holesBox.classList.toggle("hidden", !needs.holes);
        labels["stepover"]!.classList.toggle("hidden", !needs.stepover);
    }

    // Planned again a moment after the typing stops; a reply that a later
    // request has overtaken is dropped.
    let timer: ReturnType<typeof setTimeout> | null = null;
    let ticket = 0;
    function changed(): void {
        show();
        const op = read();
        if (typeof op !== "string") {
            storeOperation({ ...op, job: null, sizes: null });
        }
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

    async function plan(): Promise<void> {
        const op = read();
        const mine = ++ticket;
        if (typeof op === "string") {
            showProblem(op);
            replace(notes);
            ctx.store.set({ millPlan: null });
            return;
        }
        try {
            const planned = await ctx.api.planMill(op);
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

    async function make(): Promise<void> {
        const op = read();
        if (typeof op === "string") {
            showProblem(op);
            return;
        }
        const made = await ctx.call(ctx.api.makeMill(op));
        if (!made) {
            return;
        }
        await ctx.refreshJobs();
        await ctx.selectJob(made.job.id);
        // The made job is selected and drawn in the plan's place.
        ctx.store.set({ millPlan: null });
        ctx.toast("info", `made ${made.job.name}`);
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
            renderSizes();
        }
        changed();
    }

    function renderSizes(): void {
        const sizes = holeSizes(holesJob?.holes ?? []);
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
        if (holesJob && sizes.length === 0) {
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
        const laser = state.snapshot.connected && !isMilling(state.snapshot);
        machineNote.textContent = laser ? "the machine is set up for a laser ($spindle=0): a job made here runs only on a spindle" : "";
        machineNote.classList.toggle("hidden", !laser);
    }

    ctx.store.subscribe((state) => renderJobs(state), ["jobs"]);
    ctx.store.subscribe((state) => renderMachine(state), ["snapshot"]);
    renderJobs(ctx.store.get());
    renderMachine(ctx.store.get());
    setPressed(kinds, MILL_KINDS.find((entry) => entry.kind === kind)!.label);
    show();
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
        el("p", { class: "muted hint" }, "runs the selected job, here or from the Jobs panel; zero the depth on the surface first"),
    );

    async function run(): Promise<void> {
        const job = ctx.store.get().job;
        if (!job) {
            return;
        }
        await ctx.call(ctx.api.runJob(job.id, compensate.value as Compensate));
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
