// The Run panel, one for the Jobs and the Plot pages: the selected job's
// name, how the run follows the height map, Run, Hold, Resume and Stop,
// the run's progress and why it ended, and picking a stopped run up at a
// line. Each page mounts a copy in its own panel. The height map choice
// the operator makes is the store's (`mapPick`), so both copies show the
// same one, and the panel puts the choice it settles on in `mapChoice`
// for the other panels to describe.

import { askConfirm } from "../confirm.ts";
import { button, el, labeled, lockFor, numberField } from "../dom.ts";
import { formatDuration, formatLength, formatMm, parseNumber } from "../format.ts";
import { isCartesian, isDispensing, isMilling, profileOf } from "../profile.ts";
import type { AppState } from "../state.ts";
import type { Compensate, Group, HeightMap, Job, Progress, ResumePlan, ResumeRecord, ResumeRequest } from "../types.ts";
import type { Ctx } from "./context.ts";
import { changedWord, focusHereWord, withFocusHere, withWords } from "./focushere.ts";
import { focusAgainText, mapUsable, mapUse, runActive, runMapUse, showMapUse } from "./heightmap.ts";

/** What a page adds to its copy of the panel. */
export interface RunOptions {
    /** A line under the title with the job's length, time and groups on, for a page with no job details of its own. */
    stats?: boolean;
    /** A hint at the panel's foot. */
    hint?: string;
}

export function progressText(progress: Progress | null): { bar: number; counts: string; time: string; state: string; reason: string } {
    if (!progress) {
        return { bar: 0, counts: "", time: "", state: "", reason: "" };
    }
    const bar = progress.total > 0 ? Math.min(1, progress.acked / progress.total) : 0;
    const from = progress.resumed_from ? `, picked up at line ${progress.resumed_from}` : "";
    return {
        bar,
        counts: `${progress.sent} sent / ${progress.acked} acked / ${progress.total}${from}`,
        time: `${formatDuration(progress.seconds)} / ${formatDuration(progress.estimate)}`,
        state: progress.state,
        // Why a run ended the way it did stays with the run, after the
        // toast that announced it is gone.
        reason: progress.error ?? "",
    };
}

/**
 * The run of `jobId` a resume could pick up: the progress of the last run
 * when it is this job's and over, else the record kept across sessions.
 * Null while nothing of this job has run, or it ran to the end.
 */
export function resumable(jobId: string | null, progress: Progress | null, record: ResumeRecord | null | undefined): Progress | ResumeRecord | null {
    if (jobId === null) {
        return null;
    }
    const candidates = [progress, record ?? null];
    for (const candidate of candidates) {
        if (!candidate || candidate.job !== jobId) {
            continue;
        }
        if (candidate.state === "running" || candidate.state === "hold" || candidate.state === "done") {
            return null;
        }
        if (candidate.acked > 0 || candidate.sent > 0) {
            return candidate;
        }
    }
    return null;
}

/** Where the last run says the head is, for the operator to check against the machine. */
export function recordPositionText(record: ResumeRecord | null | undefined, cartesian: boolean): string {
    const position = record?.position;
    if (!position) {
        return "";
    }
    const parts = cartesian
        ? [`X ${formatMm(position.r)}`, `Y ${formatMm(position.z)}`]
        : [`R ${formatMm(position.r)}`, `A ${position.a.toFixed(3)}`];
    if (position.h !== null && position.h !== undefined) {
        parts.push(`${cartesian ? "Z" : "H"} ${formatMm(position.h)}`);
    }
    return `last reported position ${parts.join(" ")}${record?.note ? ` (${record.note})` : ""}`;
}

/** A group of dots: every path one point, as a dispense import makes them. */
export function isDots(group: Group): boolean {
    return group.paths.length > 0 && group.paths.every((path) => path.length === 1);
}

/**
 * Why a dispenser machine would refuse to run the job, as the backend
 * refuses it: an enabled group of paths rather than dots. Empty when it
 * would run, or the machine is not a dispenser.
 */
export function dispenseRefusal(job: Job | null, dispensing: boolean): string {
    if (!job || !dispensing) {
        return "";
    }
    const bad = job.groups.find((group) => group.enabled && (group.paths.length > 0 || (group.joints?.length ?? 0) > 0) && !isDots(group));
    return bad ? `${bad.label}: a dispenser lays dots: import the board with mode dispense` : "";
}

/**
 * How the next run follows the height map: the operator's pick, or until
 * one is made, auto while a usable map exists and off when there is none.
 * A spindle follows the board with its depth axis or not at all, so power
 * is auto on a mill.
 */
export function mapChoiceOf(pick: Compensate | null, map: HeightMap | null, milling: boolean): Compensate {
    const choice = pick ?? (mapUsable(map) ? "auto" : "off");
    return milling && choice === "power" ? "auto" : choice;
}

/** The job's length, time and groups on, in a line; what to do with no job. */
export function runStatsText(job: Job | null): string {
    if (!job) {
        return "make a job, or select one in the Jobs panel";
    }
    const on = job.groups.filter((group) => group.enabled).length;
    return `${formatLength(job.stats.length_mm)}, about ${formatDuration(job.stats.seconds)}, ${on} of ${job.groups.length} groups on`;
}

/** The Run panel in `root`, working on the selected job. */
export function mountRun(root: HTMLElement, ctx: Ctx, options: RunOptions = {}): void {
    // The selected job's name over the controls, since the panel may be
    // far from the list it was picked in.
    const title = el("span", { class: "muted run-job" });
    const stats = options.stats ? el("p", { class: "muted run-stats" }) : null;
    const runButton = button("Run", () => run(), "btn btn-primary");
    // How the run follows the height map. It turns to auto by itself while a
    // usable map exists and back to off when there is none, until the
    // operator picks something; a choice the map cannot meet is refused by
    // the backend rather than run without it.
    const compensate = el("select", { class: "field", "aria-label": "Height map" },
        el("option", { value: "off" }, "no height map"),
        el("option", { value: "auto" }, "height map: auto"),
        el("option", { value: "focus" }, "height map: focus axis"),
        el("option", { value: "power" }, "height map: power"),
    ) as HTMLSelectElement;
    const focusOption = compensate.querySelector('option[value="focus"]') as HTMLOptionElement;
    const powerOption = compensate.querySelector('option[value="power"]') as HTMLOptionElement;
    compensate.addEventListener("change", () => {
        ctx.store.set({ mapPick: compensate.value as Compensate });
    });
    // What Run does with the map, or what the run under way does with it.
    const mapChip = el("span", { class: "badge map-use" });
    const holdButton = button("Hold", () => ctx.call(ctx.api.runHold()), "btn urgent", "pause the job");
    const resumeButton = button("Resume", () => ctx.call(ctx.api.runResume()), "btn", "go on with the job");
    const stopButton = button("Stop", () => ctx.call(ctx.api.runStop()), "btn btn-danger urgent", "stop the job");
    // Why a dispenser would refuse the job, beside the run button.
    const runNote = el("span", { class: "muted run-note hidden" });
    const runRow = el("div", { class: "run-row" }, runButton, compensate, mapChip, holdButton, resumeButton, stopButton, runNote);
    // A map that lost its offset is not followed until it is taken again.
    const compensateNote = el("p", { class: "muted hint hidden" });
    const progressBar = el("div", { class: "progress-fill" });
    const progressCounts = el("span", { class: "progress-counts" });
    const progressTime = el("span", { class: "progress-time" });
    const progressState = el("span", { class: "badge run-state" });
    const progressReason = el("span", { class: "progress-reason" });
    const progressBox = el("div", { class: "progress" },
        el("div", { class: "progress-track" }, progressBar),
        el("div", { class: "progress-text" }, progressState, progressCounts, progressTime, progressReason),
    );
    // Picking a stopped run up: the line to go on from, whether to start
    // that line's path over, what the plan says, and the button.
    const pickupLine = numberField({ min: 0, step: 1, width: "7rem" });
    const pickupRewind = el("input", { type: "checkbox" }) as HTMLInputElement;
    pickupRewind.checked = true;
    const pickupPlanButton = button("Plan", () => planPickup(), "btn btn-quiet btn-small", "show where a pickup would start");
    const pickupButton = button("Resume from line", () => pickup(), "btn btn-primary btn-small", "run the job from the line picked");
    const pickupNote = el("p", { class: "muted hint" });
    const pickupPosition = el("p", { class: "muted hint" });
    const pickupBox = el("div", { class: "pickup hidden" },
        el("div", { class: "run-row" },
            labeled("Line done", pickupLine, "labeled inline"),
            el("label", { class: "muted" }, pickupRewind, " from the start of its path"),
            pickupPlanButton,
            pickupButton,
        ),
        pickupNote,
        pickupPosition,
    );
    // The job whose count the line field was filled from, so a new job or
    // a new record fills it again without overwriting what was typed.
    let pickupFilledFor: string | null = null;
    root.append(
        el("div", { class: "panel-head" }, el("h2", {}, "Run"), title),
        ...(stats ? [stats] : []),
        runRow,
        compensateNote,
        progressBox,
        pickupBox,
        ...(options.hint ? [el("p", { class: "muted hint" }, options.hint)] : []),
    );

    async function run(): Promise<void> {
        const job = ctx.store.get().job;
        if (!job) {
            return;
        }
        await withFocusHere(ctx, (focusHere) => ctx.api.runJob(job.id, compensate.value as Compensate, focusHere), "Focused here: run");
        await ctx.refreshState();
    }

    function pickupRequest(): { line: number; rewind: boolean; compensate: Compensate | null } | null {
        const line = parseNumber(pickupLine.value);
        if (line === null || !Number.isInteger(line) || line < 0) {
            ctx.toast("error", "line done: a whole number, 0 or more");
            return null;
        }
        // The map choice follows the row above: what the operator picked, or
        // the way the run being picked up followed the board when untouched.
        const picked = ctx.store.get().mapPick !== null;
        return { line, rewind: pickupRewind.checked, compensate: picked ? (compensate.value as Compensate) : null };
    }

    /**
     * The pickup's plan, with the words the backend asked the operator for:
     * that the head is at focus where it stands, or that the line is
     * counted in the job as it is now. Undefined when refused or declined.
     */
    function planWithWords(job: Job, request: ResumeRequest): Promise<{ value: ResumePlan; given: ReadonlySet<"focus_here" | "changed"> } | undefined> {
        const words = [focusHereWord("Focused here: plan"), changedWord(request.line)];
        return withWords(ctx, words, (given) => ctx.api.planResume(job.id, { ...request, focus_here: given.has("focus_here"), changed: given.has("changed") }));
    }

    /** What the operator's words make of the plan, said after it. */
    function wordsText(given: ReadonlySet<"focus_here" | "changed">): string {
        const here = given.has("focus_here") ? " Focus counts from the head's height now." : "";
        const changed = given.has("changed") ? " Lines count in the job as it is now, not as the stopped run had it." : "";
        return `${here}${changed}`;
    }

    async function planPickup(): Promise<void> {
        const job = ctx.store.get().job;
        const request = pickupRequest();
        if (!job || !request) {
            return;
        }
        const planned = await planWithWords(job, request);
        if (!planned) {
            return;
        }
        const plan = planned.value;
        const approach = plan.approach.length ? ` First: ${plan.approach.join("; ")}.` : "";
        const where = plan.next ? ` Then line ${plan.skip}: ${plan.next}.` : " Nothing left to send.";
        const fromRecord = plan.planned_from_record ? "" : " The last record is another job's; lines count from the head's position now.";
        pickupNote.textContent = `Starts at line ${plan.skip} of ${plan.total} (${plan.compensate === "off" ? "no height map" : `height map: ${plan.compensate}`}).${approach}${where}${fromRecord}${wordsText(planned.given)}`;
    }

    async function pickup(): Promise<void> {
        const job = ctx.store.get().job;
        const request = pickupRequest();
        if (!job || !request) {
            return;
        }
        const planned = await planWithWords(job, request);
        if (!planned) {
            return;
        }
        const plan = planned.value;
        const ok = await askConfirm(
            `Resume ${job.name} at line ${plan.skip} of ${plan.total}? The head moves there first:`
            + ` ${plan.approach.join("; ") || "nothing to do"}. Check the position shown matches the head.`
            + wordsText(planned.given),
            "Resume",
        );
        if (!ok) {
            return;
        }
        const words = { focus_here: planned.given.has("focus_here"), changed: planned.given.has("changed") };
        const started = await ctx.call(ctx.api.resumeJob(job.id, { ...request, ...words }));
        if (started) {
            ctx.store.set({ progress: started });
            pickupNote.textContent = "";
        }
        await ctx.refreshState();
    }

    function render(state: AppState): void {
        const job = state.job;
        title.textContent = job ? job.name : "no job selected";
        if (stats) {
            stats.textContent = runStatsText(job);
        }
        const progress = state.progress ?? state.snapshot.run;
        const text = progressText(progress);
        progressBar.style.width = `${(text.bar * 100).toFixed(1)}%`;
        progressCounts.textContent = text.counts;
        progressTime.textContent = text.time;
        progressState.textContent = text.state;
        progressState.setAttribute("data-run", text.state);
        progressReason.textContent = text.reason;
        progressBox.classList.toggle("hidden", progress === null || progress.job !== job?.id);
        const active = runActive(progress);
        const connected = state.snapshot.connected;
        // A dispenser lays dots: a job of paths is refused before it is sent.
        const refusal = dispenseRefusal(job, isDispensing(state.snapshot));
        runNote.textContent = refusal;
        runNote.classList.toggle("hidden", refusal === "");
        runButton.title = refusal || "start the job";
        lockFor(runButton, [!connected, "connect first"], [active, "a run is under way"], [!job, "pick a job first"], [refusal !== "", refusal]);
        lockFor(holdButton, [!connected, "connect first"], [!active, "no run under way"], [progress?.state !== "running", "the run is held already"]);
        lockFor(resumeButton, [!connected, "connect first"], [!active, "no run under way"], [progress?.state !== "hold", "only a held run resumes"]);
        lockFor(stopButton, [!connected, "connect first"], [!active, "no run under way"]);
        compensate.disabled = active;
        const milling = isMilling(state.snapshot);
        powerOption.disabled = milling;
        focusOption.textContent = milling ? "height map: depth axis" : "height map: focus axis";
        const map = state.heightMap?.map ?? null;
        const choice = mapChoiceOf(state.mapPick, map, milling);
        compensate.value = choice;
        const again = focusAgainText(map, milling);
        compensateNote.textContent = again;
        compensateNote.classList.toggle("hidden", again === "");
        const ours = active && progress?.job === job?.id;
        const planned = mapUse(choice, map, job, profileOf(state.snapshot));
        showMapUse(mapChip, ours ? runMapUse(progress, milling) ?? planned : planned);
        // A run of this job that stopped short can be picked up where it
        // got to, this session's or an earlier one's.
        const record = state.snapshot.resume ?? null;
        const candidate = resumable(job?.id ?? null, progress, record);
        pickupBox.classList.toggle("hidden", candidate === null);
        if (candidate !== null) {
            const key = `${candidate.job}:${candidate.acked}`;
            if (pickupFilledFor !== key && pickupLine !== document.activeElement) {
                pickupFilledFor = key;
                pickupLine.value = String(candidate.acked);
                pickupNote.textContent = "";
            }
            pickupPosition.textContent = recordPositionText(record?.job === candidate.job ? record : null, isCartesian(state.snapshot));
            const idle = state.snapshot.machine?.state === "Idle";
            lockFor(pickupButton, [!connected, "connect first"], [active, "a run is under way"], [!idle, "wait for the machine to be idle"]);
            lockFor(pickupPlanButton, [!connected, "connect first"], [active, "a run is under way"]);
        }
        // The other panels say what the choice does; set last, since it
        // calls them back. Every copy of the panel settles on the same one.
        ctx.store.set({ mapChoice: choice });
    }

    ctx.store.subscribe((state) => render(state), ["job", "progress", "snapshot", "heightMap", "mapPick"]);
    render(ctx.store.get());
}
