// The Align panel: lining the selected job up with the board on the table.
// A mark pairs a design point of the job (a pad, a hole or a point typed
// in) with the board point the machine finds it at: the tool put over it
// by hand, or the camera's picture centered on it. The fit the marks give
// is shown after every change, and Apply turns and shifts the job by it.

import { askConfirm } from "../confirm.ts";
import { button, el, labeled, numberField, replace, setLocked } from "../dom.ts";
import { formatFixed, parseNumber } from "../format.ts";
import type { AppState } from "../state.ts";
import type { AlignFit, AlignMark, AlignMarkRequest, AlignState, CameraState, Job } from "../types.ts";
import type { Ctx } from "./context.ts";

/** One line on a fit; what a refused fit said when there is none. */
export function fitText(fit: AlignFit | null, problem: string | null = null): string {
    if (problem) {
        return problem;
    }
    if (!fit) {
        return "no fit yet: add a mark";
    }
    const what = fit.marks === 1 ? "one mark: a shift" : `${fit.marks} marks`;
    return `${what}: rotation ${formatFixed(fit.rotation, 4)} deg, shift X ${formatFixed(fit.shift[0], 3)} Y ${formatFixed(fit.shift[1], 3)} mm,`
        + ` scale ${formatFixed(fit.scale, 5)} (reported only), rms ${formatFixed(fit.rms, 3)} mm`;
}

/** A capture needs a running camera with this job's board loaded and locked. */
export function canCapture(camera: CameraState | null, job: Job | null): boolean {
    return camera !== null && job !== null && camera.running && camera.board === job.id && camera.pose?.state === "locked";
}

/** What a mark's design point was: the kind, and the point. */
export function markWords(mark: AlignMark): { design: string; machine: string; distance: string; residual: string } {
    const point = ([x, y]: [number, number]): string => `${formatFixed(x, 3)}, ${formatFixed(y, 3)}`;
    return {
        design: point(mark.design),
        machine: point(mark.machine),
        distance: mark.kind === "point" || mark.kind === "center" ? "-" : `${formatFixed(mark.distance, 3)} mm`,
        residual: mark.residual === null ? "-" : `${formatFixed(mark.residual, 3)} mm`,
    };
}

const FOLD_KEY = "spinny.align.open";

function readFoldOpen(): boolean {
    try {
        return globalThis.localStorage?.getItem(FOLD_KEY) !== "0";
    } catch {
        return true;
    }
}

function writeFoldOpen(open: boolean): void {
    try {
        globalThis.localStorage?.setItem(FOLD_KEY, open ? "1" : "0");
    } catch {
        // Not remembered; the panel still folds.
    }
}

export type MarkPick = "pad" | "hole" | "point";

export function mountAlign(root: HTMLElement, ctx: Ctx): void {
    const badge = el("span", { class: "badge align-badge" }, "no marks");
    const table = el("table", { class: "align-marks" });
    const pick = el("select", { class: "field", "aria-label": "What the mark pairs the tool's point with" },
        el("option", { value: "pad" }, "nearest pad"),
        el("option", { value: "hole" }, "nearest hole"),
        el("option", { value: "point" }, "a point"),
    ) as HTMLSelectElement;
    const pointX = numberField({ step: 0.01, width: "6rem", placeholder: "x" });
    pointX.setAttribute("aria-label", "Design point x");
    const pointY = numberField({ step: 0.01, width: "6rem", placeholder: "y" });
    pointY.setAttribute("aria-label", "Design point y");
    const within = numberField({ value: 5, min: 0.1, max: 100, step: 0.5, width: "5rem" });
    within.setAttribute("aria-label", "Within mm");
    const withinLabel = labeled("Within mm", within, "labeled inline");
    const markButton = button("Mark here", () => markHere(), "btn btn-primary");
    const captureButton = button("Capture from camera", () => capture(), "btn");
    const fitLine = el("p", { class: "muted align-fit" }, fitText(null));
    const applyButton = button("Apply", () => apply(), "btn btn-primary");
    const clearButton = button("Clear", () => clear(), "btn btn-quiet");
    const note = el("p", { class: "muted hint" });
    const showPick = (): void => {
        const point = pick.value === "point";
        pointX.classList.toggle("hidden", !point);
        pointY.classList.toggle("hidden", !point);
        withinLabel.classList.toggle("hidden", point);
    };
    pick.addEventListener("change", showPick);
    showPick();

    const body = el("fieldset", { class: "panel-body" },
        el("div", { class: "align-marks-scroll" }, table),
        el("div", { class: "button-row" }, pick, pointX, pointY, withinLabel, markButton, captureButton),
        fitLine,
        el("div", { class: "button-row" }, applyButton, clearButton),
        note,
        el("p", { class: "muted hint" },
            "Mark here pairs the tool's point now with the job's nearest pad or hole, or with a point typed in. Capture from camera"
            + " pairs the picture's center in the job's frame with the tool's point plus the camera offset, and takes the board's angle"
            + " from the pose. One mark gives a shift, two or more a turn and a shift fitted by least squares. Apply turns the job"
            + " about the origin and shifts it: its paths, outline, copper, pads and holes move."),
    );
    const fold = el("details", { class: "panel-fold", open: readFoldOpen() },
        el("summary", { class: "panel-head" }, el("h2", {}, "Align"), badge),
        body,
    );
    fold.addEventListener("toggle", () => writeFoldOpen(fold.open));
    root.append(fold);

    /** An alignment request; its answer is the state, which goes into the store. */
    async function act(promise: Promise<AlignState>): Promise<void> {
        const state = await ctx.call(promise);
        if (state) {
            ctx.store.set({ align: state });
        }
    }

    async function markHere(): Promise<void> {
        const job = ctx.store.get().job;
        if (!job) {
            ctx.toast("error", "select the job to align");
            return;
        }
        const request: AlignMarkRequest = { job: job.id };
        if (pick.value === "point") {
            const x = parseNumber(pointX.value);
            const y = parseNumber(pointY.value);
            if (x === null || y === null) {
                ctx.toast("error", "enter the design point's x and y");
                return;
            }
            request.design = [x, y];
        } else {
            const reach = parseNumber(within.value);
            if (reach === null || reach <= 0) {
                ctx.toast("error", "within is a distance in mm above 0");
                return;
            }
            request.nearest = pick.value as "pad" | "hole";
            request.within = reach;
        }
        await act(ctx.api.alignMark(request));
    }

    async function capture(): Promise<void> {
        const job = ctx.store.get().job;
        if (!job) {
            ctx.toast("error", "select the job to align");
            return;
        }
        await act(ctx.api.alignCapture(job.id));
    }

    async function remove(index: number): Promise<void> {
        await act(ctx.api.alignDeleteMark(index));
    }

    async function clear(): Promise<void> {
        await act(ctx.api.alignClear());
    }

    async function apply(): Promise<void> {
        const job = ctx.store.get().job;
        if (!job) {
            return;
        }
        const fit = lastFit ?? (await ctx.call(ctx.api.alignFit(job.id)));
        if (!fit) {
            return;
        }
        const ok = await askConfirm(
            `Turn ${job.name} by ${formatFixed(fit.rotation, 4)} deg about the origin and move it by X ${formatFixed(fit.shift[0], 3)}`
            + ` Y ${formatFixed(fit.shift[1], 3)} mm (rms ${formatFixed(fit.rms, 3)} mm)? Its paths, outline, copper, pads and holes move with it.`,
            "Apply",
        );
        if (!ok) {
            return;
        }
        const result = await ctx.call(ctx.api.alignApply(job.id));
        if (!result) {
            return;
        }
        if (ctx.store.get().job?.id === result.job.id) {
            ctx.store.set({ job: result.job });
        }
        await ctx.refreshJobs();
        await ctx.refreshAlign();
        ctx.toast("info", `${result.job.name} aligned: rotation ${formatFixed(result.fit.rotation, 4)} deg, shift ${formatFixed(result.fit.shift[0], 3)}, ${formatFixed(result.fit.shift[1], 3)} mm`);
    }

    // The fit from the backend after every change of the marks; a refused
    // fit (no marks, another job's) is said in its place.
    let lastFit: AlignFit | null = null;
    let fitSeq = 0;
    let fitFor: string | null = null;
    function refit(state: AppState): void {
        const job = state.job;
        const align = state.align;
        const key = job && align ? `${job.id}:${align.job}:${JSON.stringify(align.marks)}` : null;
        if (key === fitFor) {
            return;
        }
        fitFor = key;
        lastFit = null;
        if (!job || !align || align.marks.length === 0 || align.job !== job.id) {
            fitLine.textContent = fitText(null);
            return;
        }
        const seq = ++fitSeq;
        void ctx.api.alignFit(job.id).then((fit) => {
            if (seq === fitSeq) {
                lastFit = fit;
                fitLine.textContent = fitText(fit);
            }
        }).catch((error: unknown) => {
            if (seq === fitSeq) {
                fitLine.textContent = fitText(null, error instanceof Error ? error.message : String(error));
            }
        });
    }

    function renderMarks(state: AppState): void {
        const job = state.job;
        const align = state.align;
        const marks = align && job && align.job === job.id ? align.marks : [];
        badge.textContent = marks.length === 0 ? "no marks" : `${marks.length} mark${marks.length === 1 ? "" : "s"}`;
        const rows = marks.map((mark, index) => {
            const words = markWords(mark);
            return el("tr", {},
                el("td", { class: "mono" }, words.design),
                el("td", { class: "mono" }, words.machine),
                el("td", {}, mark.source),
                el("td", {}, mark.kind),
                el("td", {}, words.distance),
                el("td", {}, words.residual),
                el("td", {}, button("Remove", () => remove(index), "btn btn-quiet btn-small")),
            );
        });
        replace(table,
            el("thead", {}, el("tr", {},
                el("th", { title: "The design point: a pad or hole of the job, or a point typed in, in the job's frame" }, "Design"),
                el("th", { title: "Where the machine found it: the tool's point, or the picture's center" }, "Machine"),
                el("th", {}, "Source"),
                el("th", {}, "Kind"),
                el("th", { title: "How far the tool was from the pad or hole picked" }, "Distance"),
                el("th", { title: "The mark's distance from where the last fit puts it" }, "Residual"),
                el("th", {}, ""),
            )),
            el("tbody", {}, ...rows),
        );
        if (!job) {
            note.textContent = "select a job to align";
        } else if (align && align.job !== null && align.job !== job.id && align.marks.length > 0) {
            const other = state.jobs.find((entry) => entry.id === align.job)?.name ?? align.job;
            note.textContent = `the marks are for ${other}; a mark here replaces them`;
        } else {
            note.textContent = "";
        }
    }

    function render(state: AppState): void {
        renderMarks(state);
        refit(state);
        const job = state.job;
        const connected = state.snapshot.connected;
        const marks = state.align && job && state.align.job === job.id ? state.align.marks.length : 0;
        setLocked(markButton, !connected || !job);
        setLocked(captureButton, !connected || !canCapture(state.camera, job));
        setLocked(applyButton, !connected || !job || marks === 0);
        setLocked(clearButton, (state.align?.marks.length ?? 0) === 0);
    }

    ctx.store.subscribe((state) => render(state), ["align", "job", "jobs", "camera", "snapshot"]);
    render(ctx.store.get());
}
