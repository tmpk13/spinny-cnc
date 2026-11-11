// The Align panel: lining the selected job up with the board on the table.
// A mark pairs a design point of the job (a pad, a hole or a point typed
// in) with the board point the machine finds it at: the tool put over it
// by hand, or the camera's picture centered on it. The fit the marks give
// is shown after every change, and Apply turns and shifts the job by it.

import { errorText } from "../api.ts";
import { askConfirm } from "../confirm.ts";
import { button, el, foldPanel, labeled, lockFor, numberField, replace, setLocked } from "../dom.ts";
import { countText, formatFixed, parseNumber } from "../format.ts";
import type { AppState } from "../state.ts";
import type { AlignFit, AlignMark, AlignMarkRequest, CameraState, Job } from "../types.ts";
import { into, type Ctx } from "./context.ts";

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
        + ` scale ${formatFixed(fit.scale, 5)} (not applied), rms ${formatFixed(fit.rms, 3)} mm`;
}

/** A capture needs a running camera with this job's board loaded and locked. */
export function canCapture(camera: CameraState | null, job: Job | null): boolean {
    return camera !== null && job !== null && camera.running && camera.board === job.id && camera.pose?.state === "locked";
}

/** A mark's cells as the table shows them: its design point, the machine's, how far the tool was from the pad or hole picked, and its residual. */
export function markWords(mark: AlignMark): { design: string; machine: string; distance: string; residual: string } {
    const point = ([x, y]: [number, number]): string => `${formatFixed(x, 3)}, ${formatFixed(y, 3)}`;
    return {
        design: point(mark.design),
        machine: point(mark.machine),
        distance: mark.kind === "point" || mark.kind === "center" ? "-" : `${formatFixed(mark.distance, 3)} mm`,
        residual: mark.residual === null ? "-" : `${formatFixed(mark.residual, 3)} mm`,
    };
}

export type MarkPick = "pad" | "hole" | "point";

export function mountAlign(root: HTMLElement, ctx: Ctx): void {
    const badge = el("span", { class: "badge align-badge" }, "no marks");
    const table = el("table", { class: "align-marks" });
    const pick = el("select", { class: "field", "aria-label": "Pair the tool's point with" },
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
            "Mark here pairs the tool's point with the nearest pad or hole, or a typed point; Capture from camera uses the"
            + " picture's center. One mark fits a shift, two or more a turn too. Apply turns the job about the origin and shifts it."),
    );
    root.append(foldPanel("spinny.align.open", el("summary", { class: "panel-head" }, el("h2", {}, "Align"), badge), body));

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
                ctx.toast("error", "within: more than 0 mm");
                return;
            }
            request.nearest = pick.value as "pad" | "hole";
            request.within = reach;
        }
        await into(ctx, "align", ctx.api.alignMark(request));
    }

    async function capture(): Promise<void> {
        const job = ctx.store.get().job;
        if (!job) {
            ctx.toast("error", "select the job to align");
            return;
        }
        await into(ctx, "align", ctx.api.alignCapture(job.id));
    }

    async function remove(index: number): Promise<void> {
        await into(ctx, "align", ctx.api.alignDeleteMark(index));
    }

    async function clear(): Promise<void> {
        await into(ctx, "align", ctx.api.alignClear());
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
            + ` Y ${formatFixed(fit.shift[1], 3)} mm (rms ${formatFixed(fit.rms, 3)} mm)? The whole job moves.`,
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
                fitLine.textContent = fitText(null, errorText(error));
            }
        });
    }

    let drawnMarks = "";

    function renderMarks(state: AppState): void {
        const job = state.job;
        const align = state.align;
        const marks = align && job && align.job === job.id ? align.marks : [];
        badge.textContent = marks.length === 0 ? "no marks" : countText(marks.length, "mark", "marks");
        const cells = marks.map((mark) => {
            const words = markWords(mark);
            return [words.design, words.machine, mark.source, mark.kind, words.distance, words.residual];
        });
        // Drawn again only when what it shows changes: the store changes
        // with every status report, and a Remove button replaced between a
        // press and its release takes no click.
        const shown = JSON.stringify(cells);
        if (shown !== drawnMarks) {
            drawnMarks = shown;
            drawMarks(cells);
        }
        if (!job) {
            note.textContent = "select a job to align";
        } else if (align && align.job !== null && align.job !== job.id && align.marks.length > 0) {
            const other = state.jobs.find((entry) => entry.id === align.job)?.name ?? align.job;
            note.textContent = `the marks are for ${other}; a mark here replaces them`;
        } else {
            note.textContent = "";
        }
    }

    function drawMarks(cells: string[][]): void {
        const rows = cells.map(([design, machine, source, kind, distance, residual], index) =>
            el("tr", {},
                el("td", { class: "mono" }, design!),
                el("td", { class: "mono" }, machine!),
                el("td", {}, source!),
                el("td", {}, kind!),
                el("td", {}, distance!),
                el("td", {}, residual!),
                el("td", {}, button("Remove", () => remove(index), "btn btn-quiet btn-small")),
            ));
        replace(table,
            el("thead", {}, el("tr", {},
                el("th", { title: "Pad, hole or typed point, in the job's frame" }, "Design"),
                el("th", { title: "Where the machine found it: tool point or camera center" }, "Machine"),
                el("th", {}, "Source"),
                el("th", {}, "Kind"),
                el("th", { title: "Tool's distance from the pad or hole" }, "Distance"),
                el("th", { title: "Distance from where the fit puts it" }, "Residual"),
                el("th", {}, ""),
            )),
            el("tbody", {}, ...rows),
        );
    }

    function render(state: AppState): void {
        renderMarks(state);
        refit(state);
        const job = state.job;
        const connected = state.snapshot.connected;
        const marks = state.align && job && state.align.job === job.id ? state.align.marks.length : 0;
        lockFor(markButton, [!connected, "connect first"], [!job, "pick a job first"]);
        lockFor(captureButton, [!connected, "connect first"], [!canCapture(state.camera, job), "the camera must be locked on this job's board"]);
        lockFor(applyButton, [!connected, "connect first"], [!job, "pick a job first"], [marks === 0, "mark a point first"]);
        setLocked(clearButton, (state.align?.marks.length ?? 0) === 0, "no marks to clear");
    }

    ctx.store.subscribe((state) => render(state), ["align", "job", "jobs", "camera", "snapshot"]);
    render(ctx.store.get());
}
