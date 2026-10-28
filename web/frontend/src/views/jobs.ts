// Upload, job list, the selected job's groups and stats, and the run controls.

import { askConfirm } from "../confirm.ts";
import { button, el, labeled, numberField, replace, setLocked } from "../dom.ts";
import { formatDuration, formatFixed, formatLength, formatMm, formatPercent, parseNumber } from "../format.ts";
import { isDispensing, isMilling } from "../profile.ts";
import type { AppState } from "../state.ts";
import type { Anchor, BoardMode, ClearPattern, Compensate, DepositFill, Job, Progress, ResumeRecord, UploadOptions } from "../types.ts";
import { centerTest } from "./center.ts";
import { focusAgainText, mapUsable } from "./heightmap.ts";
import type { Ctx } from "./context.ts";

export const ACCEPT = ".svg,.json,.gbr,.gtl,.gbl,.gts,.gbs,.gtp,.gbp,.gto,.gbo,.gm1,.kicad_pcb,.gcode,.nc";

/** The layers of a KiCad board a job is usually cut from, offered under the layer field; any other name may be typed. */
export const BOARD_LAYERS = ["F.Cu", "B.Cu", "F.Paste", "B.Paste", "F.Mask", "B.Mask", "F.SilkS", "B.SilkS"];
export const DEFAULT_LAYER = "F.Cu";

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

interface GroupRow {
    /** The group's name line and its fields line. */
    body: HTMLElement;
    power: HTMLInputElement;
    minPower: HTMLInputElement;
    speed: HTMLInputElement;
    passes: HTMLInputElement;
    /** Milling only: the depth of the last pass and the plunge rate. */
    depth: HTMLInputElement;
    plunge: HTMLInputElement;
    /** A dispenser's group only: the paste over every pad, mm. */
    thickness: HTMLInputElement | null;
    enabled: HTMLInputElement;
}

/** What a group mills to when a job does not say: through the copper, gently. */
export const DEFAULT_DEPTH = 0.1;
export const DEFAULT_PLUNGE = 60;
/** The paste over a pad when a job does not say, mm. */
export const DEFAULT_THICKNESS = 0.12;

/** A group of dots: every path one point, as a dispense import makes them. */
export function isDots(group: { paths: number | unknown[] }): boolean {
    return Array.isArray(group.paths) && group.paths.length > 0 && group.paths.every((path) => Array.isArray(path) && path.length === 1);
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

/** The labels a milling machine gives the job's numbers, and a laser's. */
export function jobLabels(milling: boolean): { power: string; speed: string; spot: string } {
    return milling
        ? { power: "Spindle S", speed: "Feed mm/min", spot: "Tool mm" }
        : { power: "Power S", speed: "Speed mm/min", spot: "Spot mm" };
}

function relabel(label: HTMLLabelElement, text: string): void {
    const span = label.querySelector(".labeled-text");
    if (span && span.textContent !== text) {
        span.textContent = text;
    }
}

function setUnlessFocused(input: HTMLInputElement, value: string, focused: Element | null): void {
    if (input !== focused) {
        input.value = value;
    }
}

export function mountJobs(root: HTMLElement, ctx: Ctx): void {
    const fileInput = el("input", { type: "file", accept: ACCEPT, multiple: true, class: "file-input", "aria-label": "Job file" });
    const powerField = numberField({ value: 500, min: 0, step: 1 });
    const speedField = numberField({ value: 400, min: 1, step: 1 });
    const spotField = numberField({ value: 0.1, min: 0.01, step: 0.01 });
    const anchorField = el("select", { class: "field" },
        el("option", { value: "center" }, "center on axis"),
        el("option", { value: "keep" }, "keep origin"),
    );
    const offsetX = numberField({ value: 0 });
    const offsetY = numberField({ value: 0 });
    const layerList = el("datalist", { id: "board-layers" }, ...BOARD_LAYERS.map((layer) => el("option", { value: layer })));
    const layerField = el("input", {
        type: "text",
        class: "field",
        list: "board-layers",
        value: DEFAULT_LAYER,
        spellcheck: "false",
        "aria-label": "Board layer",
        title: "The layer of a KiCad board the job is cut from: a copper layer to isolate or deposit, or F.Paste with deposit to burn a solder paste stencil out of a film. A gerber is its own layer",
    }) as HTMLInputElement;
    const clearField = el("select", {
        class: "field",
        "aria-label": "Clear copper",
        title: "Burn away the copper the isolation leaves, inside the board outline or else the job's X/Y box (gerber and KiCad only). Radial is the fastest: its spokes run on the rail alone, while rings and lines turn the table",
    },
        el("option", { value: "off" }, "off"),
        el("option", { value: "radial" }, "radial"),
        el("option", { value: "rings" }, "rings"),
        el("option", { value: "lines" }, "lines"),
    );
    const modeField = el("select", {
        class: "field",
        "aria-label": "Board mode",
        title: "Isolate burns around the copper to take it away; deposit burns the copper itself and nothing else, for a process that lays copper down (gerber and KiCad only). A deposit leaves the board outline off",
    },
        el("option", { value: "isolate" }, "isolate"),
        el("option", { value: "deposit" }, "deposit"),
        el("option", { value: "dispense" }, "dispense"),
    );
    // A dispense lays a dot of paste on every pad: the mm of paste over one.
    const thicknessField = numberField({ value: DEFAULT_THICKNESS, min: 0.01, max: 5, step: 0.01 });
    thicknessField.setAttribute("aria-label", "Paste thickness");
    const fillField = el("select", {
        class: "field",
        "aria-label": "Fill copper",
        title: "How a deposit fills the copper inside the loop that follows its edge. Contour goes on with loops in to the middle, along each trace and round each pad; radial is the fastest: its spokes run on the rail alone, while rings and lines turn the table",
    },
        el("option", { value: "contour" }, "contour"),
        el("option", { value: "radial" }, "radial"),
        el("option", { value: "rings" }, "rings"),
        el("option", { value: "lines" }, "lines"),
    );
    const drop = el("div", { class: "drop" },
        el("p", {}, "Drop a file here (svg, json, gerber, kicad_pcb, gcode) or"),
        el("label", { class: "btn btn-quiet" }, "pick a file", fileInput),
    );
    const powerLabel = labeled("Power S", powerField);
    const speedLabel = labeled("Speed mm/min", speedField);
    const spotLabel = labeled("Spot mm", spotField);
    const clearLabel = labeled("Clear copper", clearField);
    const fillLabel = labeled("Fill copper", fillField);
    const thicknessLabel = labeled("Paste mm", thicknessField);
    thicknessLabel.title = "A dispense: mm of solder paste over every pad; a dot's volume is the pad's area times this";
    const options = el("div", { class: "field-grid" },
        powerLabel,
        speedLabel,
        spotLabel,
        labeled("Anchor", anchorField),
        labeled("Offset x", offsetX),
        labeled("Offset y", offsetY),
        labeled("Layer", layerField),
        layerList,
        labeled("Board", modeField),
        clearLabel,
        fillLabel,
        thicknessLabel,
    );
    // A deposit has no copper around its own to clear, and isolation
    // nothing inside the copper to fill: only the one that applies shows;
    // a dispense takes neither, only the paste thickness.
    const showMode = (): void => {
        const deposit = modeField.value === "deposit";
        const dispense = modeField.value === "dispense";
        clearLabel.classList.toggle("hidden", deposit || dispense);
        fillLabel.classList.toggle("hidden", !deposit);
        thicknessLabel.classList.toggle("hidden", !dispense);
    };
    modeField.addEventListener("change", showMode);
    showMode();
    const list = el("ul", { class: "job-list" });
    const details = el("div", { class: "job-details" });
    const saveButton = button("Save job", () => saveJob(), "btn btn-quiet btn-small");
    const deleteAllButton = button("Delete all", () => removeAll(), "btn btn-quiet btn-small");
    root.append(
        el("div", { class: "panel-head" }, el("h2", {}, "Jobs"), el("div", { class: "button-row" }, saveButton, deleteAllButton)),
        drop, options, centerTest(ctx), list, details,
    );

    /** The selected job as the file it is kept in, to put back with an upload. */
    function saveJob(): void {
        const job = ctx.store.get().job;
        if (!job) {
            ctx.toast("error", "select a job to save");
            return;
        }
        const name = job.name.replace(/[^A-Za-z0-9._-]+/g, "_") || "job";
        const blob = new Blob([JSON.stringify(job, null, 2)], { type: "application/json" });
        const link = el("a", { href: URL.createObjectURL(blob), download: `${name}.json` });
        link.click();
        URL.revokeObjectURL(link.href);
    }

    async function removeAll(): Promise<void> {
        const count = ctx.store.get().jobs.length;
        if (count === 0) {
            ctx.toast("info", "there are no jobs to delete");
            return;
        }
        const running = ctx.store.get().progress?.state;
        const kept = running === "running" || running === "hold" ? " The job running stays." : "";
        if (!(await askConfirm(`Delete all ${count} jobs? They are gone for good.${kept}`, "Delete all"))) {
            return;
        }
        const removed = await ctx.call(ctx.api.deleteAllJobs());
        if (!removed) {
            return;
        }
        const selected = ctx.store.get().job?.id ?? null;
        if (selected !== null && removed.includes(selected)) {
            await ctx.selectJob(null);
        }
        await ctx.refreshJobs();
        ctx.toast("info", `deleted ${removed.length} jobs`);
    }

    const uploadOptions = (): UploadOptions => {
        const out: UploadOptions = { anchor: anchorField.value as Anchor };
        const power = parseNumber(powerField.value);
        const speed = parseNumber(speedField.value);
        const spot = parseNumber(spotField.value);
        const ox = parseNumber(offsetX.value);
        const oy = parseNumber(offsetY.value);
        if (power !== null) {
            out.power = power;
        }
        if (speed !== null) {
            out.speed = speed;
        }
        if (spot !== null) {
            out.spot = spot;
        }
        if (ox !== null) {
            out.offset_x = ox;
        }
        if (oy !== null) {
            out.offset_y = oy;
        }
        const layer = layerField.value.trim();
        if (layer) {
            out.layer = layer;
        }
        if (modeField.value === "deposit") {
            out.mode = modeField.value as BoardMode;
            out.fill = fillField.value as DepositFill;
        } else if (modeField.value === "dispense") {
            out.mode = modeField.value as BoardMode;
            const thickness = parseNumber(thicknessField.value);
            if (thickness !== null) {
                out.thickness = thickness;
            }
        } else if (clearField.value !== "off") {
            out.clear = clearField.value as ClearPattern;
        }
        return out;
    };

    // One upload batch at a time; a drop or pick while one runs is ignored.
    let uploading = false;
    async function upload(files: FileList | File[]): Promise<void> {
        if (uploading) {
            return;
        }
        uploading = true;
        drop.classList.add("busy");
        fileInput.disabled = true;
        try {
            for (const file of Array.from(files)) {
                const job = await ctx.call(ctx.api.uploadJob(file, uploadOptions()));
                await ctx.refreshJobs();
                if (job && typeof job === "object" && "id" in job) {
                    await ctx.selectJob(job.id);
                    ctx.toast("info", `loaded ${job.name ?? file.name}`);
                }
            }
        } finally {
            uploading = false;
            drop.classList.remove("busy");
            fileInput.disabled = false;
            fileInput.value = "";
        }
    }

    fileInput.addEventListener("change", () => {
        if (fileInput.files && fileInput.files.length > 0) {
            void upload(fileInput.files);
        }
    });
    for (const type of ["dragenter", "dragover"]) {
        drop.addEventListener(type, (event) => {
            event.preventDefault();
            drop.classList.add("over");
        });
    }
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (event) => {
        event.preventDefault();
        drop.classList.remove("over");
        const files = (event as DragEvent).dataTransfer?.files;
        if (files && files.length > 0) {
            void upload(files);
        }
    });

    ctx.store.subscribe((state) => renderList(state), ["jobs", "job"]);
    ctx.store.subscribe((state) => renderDetails(state), ["job", "progress", "snapshot", "heightMap"]);

    function renderList(state: AppState): void {
        const selected = state.job?.id ?? null;
        replace(list, ...state.jobs.map((job) => {
            const item = el("li", { class: job.id === selected ? "selected" : "" });
            const pick = el("button", { type: "button", class: "job-pick", onclick: () => void ctx.selectJob(job.id) },
                el("span", { class: "job-name" }, job.name),
                el("span", { class: "muted" }, job.layer ? ` ${job.source} ${job.layer}` : ` ${job.source}`),
                job.stats ? el("span", { class: "muted job-stat" }, ` ${formatLength(job.stats.length_mm)}, ${formatDuration(job.stats.seconds)}`) : null,
            );
            const remove = button("Delete", () => removeJob(job.id, job.name), "btn btn-quiet btn-small");
            item.append(pick, remove);
            return item;
        }));
        if (state.jobs.length === 0) {
            list.append(el("li", { class: "muted" }, "no jobs yet"));
        }
    }

    async function removeJob(id: string, name: string): Promise<void> {
        // The file goes for good, and the button sits beside the one that
        // selects the job: a mis-tap must not be enough.
        if (!(await askConfirm(`Delete job ${name}?`, "Delete"))) {
            return;
        }
        const done = await ctx.call(ctx.api.deleteJob(id).then(() => true));
        if (!done) {
            // Refused, so the job is still there, and so are its controls.
            return;
        }
        if (ctx.store.get().job?.id === id) {
            await ctx.selectJob(null);
        }
        await ctx.refreshJobs();
    }

    let detailsFor: string | null = null;
    let detailsJob: Job | null = null;
    // The table's columns are the tool's, so it is built again when the
    // machine's tool changes under it.
    let detailsMilling = false;
    // The inputs of the groups table and the offset row, kept so that a
    // fresh copy of the same job updates them in place: rebuilding the
    // table would tear out the field the operator is typing in, and the
    // browser fires no change for a field that is gone.
    let groupRows: GroupRow[] = [];
    let offsetFields: { x: HTMLInputElement; y: HTMLInputElement; rotation: HTMLElement } | null = null;
    let statsEl: HTMLElement | null = null;
    // Why a dispenser would refuse the job, beside the run button.
    const runNote = el("span", { class: "muted run-note hidden" });
    const progressBar = el("div", { class: "progress-fill" });
    const progressCounts = el("span", { class: "progress-counts" });
    const progressTime = el("span", { class: "progress-time" });
    const progressState = el("span", { class: "badge run-state" });
    const progressReason = el("span", { class: "progress-reason" });
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
    let compensateTouched = false;
    compensate.addEventListener("change", () => {
        compensateTouched = true;
    });
    const holdButton = button("Hold", () => ctx.call(ctx.api.runHold()), "btn");
    const resumeButton = button("Resume", () => ctx.call(ctx.api.runResume()), "btn");
    const stopButton = button("Stop", () => ctx.call(ctx.api.runStop()), "btn btn-danger");
    const runRow = el("div", { class: "run-row" }, runButton, compensate, holdButton, resumeButton, stopButton, runNote);
    // A map that lost its offset is not followed until it is taken again.
    const compensateNote = el("p", { class: "muted hint hidden" });
    const progressBox = el("div", { class: "progress" },
        el("div", { class: "progress-track" }, progressBar),
        el("div", { class: "progress-text" }, progressState, progressCounts, progressTime, progressReason),
    );
    // Picking a stopped run up: the line to go on from, whether to start
    // that line's path over, what the plan says, and the button.
    const pickupLine = numberField({ min: 0, step: 1, width: "7rem" });
    const pickupRewind = el("input", { type: "checkbox" }) as HTMLInputElement;
    pickupRewind.checked = true;
    const pickupPlanButton = button("Plan", () => planPickup(), "btn btn-quiet btn-small");
    const pickupButton = button("Resume from line", () => pickup(), "btn btn-primary btn-small");
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

    async function run(): Promise<void> {
        const job = ctx.store.get().job;
        if (!job) {
            return;
        }
        await ctx.call(ctx.api.runJob(job.id, compensate.value as Compensate));
        await ctx.refreshState();
    }

    function pickupRequest(): { line: number; rewind: boolean; compensate: Compensate | null } | null {
        const line = parseNumber(pickupLine.value);
        if (line === null || !Number.isInteger(line) || line < 0) {
            ctx.toast("error", "the line done is a whole number");
            return null;
        }
        // The map choice follows the row above: what the operator picked, or
        // the way the run being picked up followed the board when untouched.
        return { line, rewind: pickupRewind.checked, compensate: compensateTouched ? (compensate.value as Compensate) : null };
    }

    async function planPickup(): Promise<void> {
        const job = ctx.store.get().job;
        const request = pickupRequest();
        if (!job || !request) {
            return;
        }
        const plan = await ctx.call(ctx.api.planResume(job.id, request));
        if (!plan) {
            return;
        }
        const approach = plan.approach.length ? ` First: ${plan.approach.join("; ")}.` : "";
        const where = plan.next ? ` Then line ${plan.skip}: ${plan.next}.` : " Nothing is left to send.";
        const planned = plan.planned_from_record ? "" : " The last run's record is another job's, so the lines are counted from where the head is now.";
        pickupNote.textContent = `Starts at line ${plan.skip} of ${plan.total} (${plan.compensate === "off" ? "no height map" : `height map: ${plan.compensate}`}).${approach}${where}${planned}`;
    }

    async function pickup(): Promise<void> {
        const job = ctx.store.get().job;
        const request = pickupRequest();
        if (!job || !request) {
            return;
        }
        const plan = await ctx.call(ctx.api.planResume(job.id, request));
        if (!plan) {
            return;
        }
        const ok = await askConfirm(
            `Pick ${job.name} up at line ${plan.skip} of ${plan.total}? The head is brought there from where it is now:`
            + ` ${plan.approach.join("; ") || "nothing to do"}. Check that the position shown is where the head really is.`,
            "Resume",
        );
        if (!ok) {
            return;
        }
        const started = await ctx.call(ctx.api.resumeJob(job.id, request));
        if (started) {
            ctx.store.set({ progress: started });
            pickupNote.textContent = "";
        }
        await ctx.refreshState();
    }

    function renderDetails(state: AppState): void {
        const job = state.job;
        if (!job) {
            if (detailsFor !== null) {
                detailsFor = null;
                detailsJob = null;
                replace(details, el("p", { class: "muted" }, "select a job to see its groups"));
            }
            renderProgress(state);
            return;
        }
        const milling = isMilling(state.snapshot);
        if (detailsFor !== job.id || detailsJob === null || groupRows.length !== job.groups.length || detailsMilling !== milling) {
            detailsFor = job.id;
            detailsJob = job;
            detailsMilling = milling;
            statsEl = statsBlock(job);
            replace(details,
                el("h3", {}, job.name),
                groupsTable(job, milling),
                statsEl,
                offsetRow(job),
                runRow,
                compensateNote,
                progressBox,
                pickupBox,
            );
        } else if (detailsJob !== job) {
            detailsJob = job;
            refreshDetails(job);
        }
        renderProgress(state);
    }

    function refreshDetails(job: Job): void {
        const focused = document.activeElement;
        job.groups.forEach((group, index) => {
            const row = groupRows[index]!;
            setUnlessFocused(row.power, String(group.power), focused);
            setUnlessFocused(row.minPower, String(group.min_power), focused);
            setUnlessFocused(row.speed, String(group.speed), focused);
            setUnlessFocused(row.passes, String(group.passes), focused);
            setUnlessFocused(row.depth, String(group.depth ?? DEFAULT_DEPTH), focused);
            setUnlessFocused(row.plunge, String(group.plunge ?? DEFAULT_PLUNGE), focused);
            if (row.thickness) {
                setUnlessFocused(row.thickness, String(group.thickness ?? DEFAULT_THICKNESS), focused);
            }
            if (row.enabled !== focused) {
                row.enabled.checked = group.enabled;
            }
            row.body.classList.toggle("disabled", !group.enabled);
        });
        if (offsetFields) {
            setUnlessFocused(offsetFields.x, String(job.offset.x), focused);
            setUnlessFocused(offsetFields.y, String(job.offset.y), focused);
            offsetFields.rotation.textContent = rotationText(job);
        }
        const fresh = statsBlock(job);
        statsEl?.replaceWith(fresh);
        statsEl = fresh;
    }

    function renderProgress(state: AppState): void {
        const progress = state.progress ?? state.snapshot.run;
        const text = progressText(progress);
        progressBar.style.width = `${(text.bar * 100).toFixed(1)}%`;
        progressCounts.textContent = text.counts;
        progressTime.textContent = text.time;
        progressState.textContent = text.state;
        progressState.setAttribute("data-run", text.state);
        progressReason.textContent = text.reason;
        progressBox.classList.toggle("hidden", progress === null || (progress.job !== state.job?.id));
        const active = progress !== null && (progress.state === "running" || progress.state === "hold");
        const connected = state.snapshot.connected;
        // A dispenser lays dots: a job of paths is refused before it is sent.
        const refusal = dispenseRefusal(state.job, isDispensing(state.snapshot));
        runNote.textContent = refusal;
        runNote.classList.toggle("hidden", refusal === "");
        runButton.title = refusal;
        setLocked(runButton, !connected || active || !state.job || refusal !== "");
        setLocked(holdButton, !connected || !active || progress.state !== "running");
        setLocked(resumeButton, !connected || !active || progress.state !== "hold");
        setLocked(stopButton, !connected || !active);
        compensate.disabled = active;
        // A spindle follows the board with its depth axis or not at all.
        const milling = isMilling(state.snapshot);
        powerOption.disabled = milling;
        focusOption.textContent = milling ? "height map: depth axis" : "height map: focus axis";
        if (milling && compensate.value === "power") {
            compensate.value = "auto";
        }
        const map = state.heightMap?.map ?? null;
        if (!compensateTouched) {
            compensate.value = mapUsable(map) ? "auto" : "off";
        }
        const again = focusAgainText(map, milling);
        compensateNote.textContent = again;
        compensateNote.classList.toggle("hidden", again === "");
        // A run of this job that stopped short can be picked up where it
        // got to, this session's or an earlier one's.
        const record = state.snapshot.resume ?? null;
        const candidate = resumable(state.job?.id ?? null, progress, record);
        pickupBox.classList.toggle("hidden", candidate === null);
        if (candidate !== null) {
            const key = `${candidate.job}:${candidate.acked}`;
            if (pickupFilledFor !== key && pickupLine !== document.activeElement) {
                pickupFilledFor = key;
                pickupLine.value = String(candidate.acked);
                pickupNote.textContent = "";
            }
            pickupPosition.textContent = recordPositionText(record?.job === candidate.job ? record : null, state.snapshot.profile?.kinematics === "cartesian");
            const idle = state.snapshot.machine?.state === "Idle";
            setLocked(pickupButton, !connected || active || !idle);
            setLocked(pickupPlanButton, !connected || active);
        }
        setLocked(saveButton, !state.job);
        const labels = jobLabels(milling);
        relabel(powerLabel, labels.power);
        relabel(speedLabel, labels.speed);
        relabel(spotLabel, labels.spot);
    }

    /** A number cell of the groups table; the stylesheet sizes it to the column. */
    function groupField(value: number, min: number, label: string): HTMLInputElement {
        const field = numberField({ value, min, step: 1 });
        field.setAttribute("aria-label", label);
        return field;
    }

    function groupsTable(job: Job, milling: boolean): HTMLElement {
        groupRows = [];
        const rows = job.groups.map((group, index) => {
            const power = groupField(group.power, 0, milling ? "spindle speed" : "power");
            const minPower = groupField(group.min_power, 0, "min power");
            const speed = groupField(group.speed, 1, milling ? "feed" : "speed");
            const passes = groupField(group.passes, 1, "passes");
            const depth = groupField(group.depth ?? DEFAULT_DEPTH, 0, "depth");
            depth.step = "0.01";
            const plunge = groupField(group.plunge ?? DEFAULT_PLUNGE, 1, "plunge");
            // A dispenser's group has the paste thickness in place of a cut's numbers.
            const dots = group.tool === "dispenser";
            const thickness = dots ? groupField(group.thickness ?? DEFAULT_THICKNESS, 0.01, "thickness") : null;
            if (thickness) {
                thickness.step = "0.01";
            }
            const enabled = el("input", { type: "checkbox", "aria-label": "enabled" });
            enabled.checked = group.enabled;
            const patch = async (): Promise<void> => {
                const p = parseNumber(power.value);
                const m = parseNumber(minPower.value);
                const s = parseNumber(speed.value);
                const n = parseNumber(passes.value);
                const d = parseNumber(depth.value);
                const u = parseNumber(plunge.value);
                const t = thickness ? parseNumber(thickness.value) : null;
                await ctx.call(ctx.api.patchJob(job.id, {
                    groups: [{
                        index,
                        ...(p !== null && !dots ? { power: p } : {}),
                        ...(m !== null && !milling && !dots ? { min_power: m } : {}),
                        ...(s !== null && !dots ? { speed: s } : {}),
                        ...(n !== null ? { passes: n } : {}),
                        ...(d !== null && milling && !dots ? { depth: d } : {}),
                        ...(u !== null && milling && !dots ? { plunge: u } : {}),
                        ...(t !== null ? { thickness: t } : {}),
                        enabled: enabled.checked,
                    }],
                }));
                await ctx.reloadJob(job.id);
                await ctx.refreshJobs();
            };
            for (const field of [power, minPower, speed, passes, depth, plunge, enabled, ...(thickness ? [thickness] : [])]) {
                field.addEventListener("change", () => void patch());
            }
            // Milled, the floor means nothing and the depth and the plunge
            // take its place: a pass is a step down, not a burn again. A
            // group of paste dots has only its thickness and its passes.
            const fields = thickness ? [thickness, passes, enabled] : milling ? [power, depth, speed, plunge, passes, enabled] : [power, minPower, speed, passes, enabled];
            // The name has a line of its own above the fields, so they get
            // the whole width of a side panel.
            const body = el("tbody", { class: group.enabled ? "" : "disabled" },
                el("tr", { class: "group-name" },
                    el("th", { scope: "rowgroup", colspan: String(fields.length) },
                        el("span", { class: "swatch", "data-group": String(index % 4) }), group.label,
                        el("span", { class: "muted" }, group.joints?.length ? ` (${group.joints.length}, joint space)` : dots ? ` (${group.paths.length} dots)` : ` (${group.paths.length})`))),
                el("tr", { class: "group-fields" }, ...fields.map((field) => el("td", {}, field))),
            );
            groupRows.push({ body, power, minPower, speed, passes, depth, plunge, thickness, enabled });
            return body;
        });
        const anyDots = job.groups.some((group) => group.tool === "dispenser");
        const head = anyDots
            ? [
                el("th", { title: "Dispensing: mm of paste over every pad of the group" }, "Paste mm"),
                el("th", { title: "Times the group runs over all of its dots" }, "Passes"),
                el("th", {}, "On"),
            ]
            : milling
            ? [
                el("th", { title: "Spindle speed" }, "S"),
                el("th", { title: "How deep under the surface the last pass cuts, mm" }, "Depth"),
                el("th", { title: "Feed along the cut" }, "mm/min"),
                el("th", { title: "How fast the tool goes down into the cut, mm/min" }, "Plunge"),
                el("th", { title: "Passes down to the depth, each a step deeper" }, "Passes"),
                el("th", {}, "On"),
            ]
            : [
                el("th", {}, "S"),
                el("th", { title: "Least power where the head slows for a corner (dyn mode); 0 is none" }, "Min S"),
                el("th", {}, "mm/min"),
                el("th", { title: "Times the group runs over all of its paths" }, "Passes"),
                el("th", {}, "On"),
            ];
        return el("div", { class: "groups-scroll" }, el("table", { class: "groups" }, el("thead", {}, el("tr", {}, ...head)), ...rows));
    }

    function statsBlock(job: Job): HTMLElement {
        const stats = job.stats;
        const item = (label: string, value: string): HTMLElement => el("div", { class: "stat" }, el("span", { class: "stat-label" }, label), el("span", { class: "stat-value" }, value));
        return el("div", { class: "stats" },
            item("Length", formatLength(stats.length_mm)),
            item("Estimate", formatDuration(stats.seconds)),
            item("Max radius", formatMm(stats.max_radius) + " mm"),
            item("Min radius", formatMm(stats.min_radius) + " mm"),
            item("Table limited", formatPercent(stats.limited_fraction)),
            item("Moves", String(stats.moves)),
        );
    }

    /** The turn alignment gave the job; read only, as the alignment panel is what changes it. */
    function rotationText(job: Job): string {
        return `turned ${formatFixed(job.rotation ?? 0, 4)} deg`;
    }

    function offsetRow(job: Job): HTMLElement {
        const x = numberField({ value: job.offset.x, width: "5.5rem" });
        const y = numberField({ value: job.offset.y, width: "5.5rem" });
        const rotation = el("span", { class: "muted job-rotation", title: "Degrees the job has been turned counterclockwise about the origin by alignment" }, rotationText(job));
        offsetFields = { x, y, rotation };
        const apply = async (): Promise<void> => {
            const ox = parseNumber(x.value);
            const oy = parseNumber(y.value);
            if (ox === null || oy === null) {
                ctx.toast("error", "offset needs x and y");
                return;
            }
            await ctx.call(ctx.api.patchJob(job.id, { offset: { x: ox, y: oy } }));
            await ctx.reloadJob(job.id);
            await ctx.refreshJobs();
        };
        return el("div", { class: "goto-row" },
            el("span", { class: "choice-label" }, "Offset"),
            x, y,
            button("Move", () => apply(), "btn btn-quiet"),
            rotation,
        );
    }
}
