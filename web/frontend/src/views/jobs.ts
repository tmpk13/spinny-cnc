// Upload, job list, the selected job's groups and stats, and the run controls.

import { askConfirm } from "../confirm.ts";
import { button, el, labeled, numberField, replace, setLocked } from "../dom.ts";
import { formatDuration, formatLength, formatMm, formatPercent, parseNumber } from "../format.ts";
import type { AppState } from "../state.ts";
import type { Anchor, ClearPattern, Job, Progress, UploadOptions } from "../types.ts";
import { centerTest } from "./center.ts";
import type { Ctx } from "./context.ts";

export const ACCEPT = ".svg,.json,.gbr,.kicad_pcb,.gcode,.nc";

export function progressText(progress: Progress | null): { bar: number; counts: string; time: string; state: string; reason: string } {
    if (!progress) {
        return { bar: 0, counts: "", time: "", state: "", reason: "" };
    }
    const bar = progress.total > 0 ? Math.min(1, progress.acked / progress.total) : 0;
    return {
        bar,
        counts: `${progress.sent} sent / ${progress.acked} acked / ${progress.total}`,
        time: `${formatDuration(progress.seconds)} / ${formatDuration(progress.estimate)}`,
        state: progress.state,
        // Why a run ended the way it did stays with the run, after the
        // toast that announced it is gone.
        reason: progress.error ?? "",
    };
}

interface GroupRow {
    /** The group's name line and its fields line. */
    body: HTMLElement;
    power: HTMLInputElement;
    minPower: HTMLInputElement;
    speed: HTMLInputElement;
    passes: HTMLInputElement;
    enabled: HTMLInputElement;
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
    const clearField = el("select", {
        class: "field",
        "aria-label": "Clear copper",
        title: "Burn away the copper the isolation leaves, inside the board outline or else the job's X/Y box (gerber and KiCad only)",
    },
        el("option", { value: "off" }, "off"),
        el("option", { value: "radial" }, "radial"),
        el("option", { value: "rings" }, "rings"),
        el("option", { value: "lines" }, "lines"),
    );
    const drop = el("div", { class: "drop" },
        el("p", {}, "Drop a file here (svg, json, gerber, kicad_pcb, gcode) or"),
        el("label", { class: "btn btn-quiet" }, "pick a file", fileInput),
    );
    const options = el("div", { class: "field-grid" },
        labeled("Power S", powerField),
        labeled("Speed mm/min", speedField),
        labeled("Spot mm", spotField),
        labeled("Anchor", anchorField),
        labeled("Offset x", offsetX),
        labeled("Offset y", offsetY),
        labeled("Clear copper", clearField),
    );
    const list = el("ul", { class: "job-list" });
    const details = el("div", { class: "job-details" });
    root.append(el("h2", {}, "Jobs"), drop, options, centerTest(ctx), list, details);

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
        if (clearField.value !== "off") {
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
    ctx.store.subscribe((state) => renderDetails(state), ["job", "progress", "snapshot"]);

    function renderList(state: AppState): void {
        const selected = state.job?.id ?? null;
        replace(list, ...state.jobs.map((job) => {
            const item = el("li", { class: job.id === selected ? "selected" : "" });
            const pick = el("button", { type: "button", class: "job-pick", onclick: () => void ctx.selectJob(job.id) },
                el("span", { class: "job-name" }, job.name),
                el("span", { class: "muted" }, ` ${job.source}`),
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
    // The inputs of the groups table and the offset row, kept so that a
    // fresh copy of the same job updates them in place: rebuilding the
    // table would tear out the field the operator is typing in, and the
    // browser fires no change for a field that is gone.
    let groupRows: GroupRow[] = [];
    let offsetFields: { x: HTMLInputElement; y: HTMLInputElement } | null = null;
    let statsEl: HTMLElement | null = null;
    const progressBar = el("div", { class: "progress-fill" });
    const progressCounts = el("span", { class: "progress-counts" });
    const progressTime = el("span", { class: "progress-time" });
    const progressState = el("span", { class: "badge run-state" });
    const progressReason = el("span", { class: "progress-reason" });
    const runButton = button("Run", () => run(), "btn btn-primary");
    const holdButton = button("Hold", () => ctx.call(ctx.api.runHold()), "btn");
    const resumeButton = button("Resume", () => ctx.call(ctx.api.runResume()), "btn");
    const stopButton = button("Stop", () => ctx.call(ctx.api.runStop()), "btn btn-danger");
    const runRow = el("div", { class: "run-row" }, runButton, holdButton, resumeButton, stopButton);
    const progressBox = el("div", { class: "progress" },
        el("div", { class: "progress-track" }, progressBar),
        el("div", { class: "progress-text" }, progressState, progressCounts, progressTime, progressReason),
    );

    async function run(): Promise<void> {
        const job = ctx.store.get().job;
        if (!job) {
            return;
        }
        await ctx.call(ctx.api.runJob(job.id));
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
        if (detailsFor !== job.id || detailsJob === null || groupRows.length !== job.groups.length) {
            detailsFor = job.id;
            detailsJob = job;
            statsEl = statsBlock(job);
            replace(details,
                el("h3", {}, job.name),
                groupsTable(job),
                statsEl,
                offsetRow(job),
                runRow,
                progressBox,
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
            if (row.enabled !== focused) {
                row.enabled.checked = group.enabled;
            }
            row.body.classList.toggle("disabled", !group.enabled);
        });
        if (offsetFields) {
            setUnlessFocused(offsetFields.x, String(job.offset.x), focused);
            setUnlessFocused(offsetFields.y, String(job.offset.y), focused);
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
        setLocked(runButton, !connected || active || !state.job);
        setLocked(holdButton, !connected || !active || progress.state !== "running");
        setLocked(resumeButton, !connected || !active || progress.state !== "hold");
        setLocked(stopButton, !connected || !active);
    }

    /** A number cell of the groups table; the stylesheet sizes it to the column. */
    function groupField(value: number, min: number, label: string): HTMLInputElement {
        const field = numberField({ value, min, step: 1 });
        field.setAttribute("aria-label", label);
        return field;
    }

    function groupsTable(job: Job): HTMLElement {
        groupRows = [];
        const rows = job.groups.map((group, index) => {
            const power = groupField(group.power, 0, "power");
            const minPower = groupField(group.min_power, 0, "min power");
            const speed = groupField(group.speed, 1, "speed");
            const passes = groupField(group.passes, 1, "passes");
            const enabled = el("input", { type: "checkbox", "aria-label": "enabled" });
            enabled.checked = group.enabled;
            const patch = async (): Promise<void> => {
                const p = parseNumber(power.value);
                const m = parseNumber(minPower.value);
                const s = parseNumber(speed.value);
                const n = parseNumber(passes.value);
                await ctx.call(ctx.api.patchJob(job.id, {
                    groups: [{
                        index,
                        ...(p !== null ? { power: p } : {}),
                        ...(m !== null ? { min_power: m } : {}),
                        ...(s !== null ? { speed: s } : {}),
                        ...(n !== null ? { passes: n } : {}),
                        enabled: enabled.checked,
                    }],
                }));
                await ctx.selectJob(job.id);
                await ctx.refreshJobs();
            };
            power.addEventListener("change", () => void patch());
            minPower.addEventListener("change", () => void patch());
            speed.addEventListener("change", () => void patch());
            passes.addEventListener("change", () => void patch());
            enabled.addEventListener("change", () => void patch());
            // The name has a line of its own above the fields, so the five
            // of them get the whole width of a side panel.
            const body = el("tbody", { class: group.enabled ? "" : "disabled" },
                el("tr", { class: "group-name" },
                    el("th", { scope: "rowgroup", colspan: "5" },
                        el("span", { class: "swatch", "data-group": String(index % 4) }), group.label,
                        el("span", { class: "muted" }, group.joints?.length ? ` (${group.joints.length}, joint space)` : ` (${group.paths.length})`))),
                el("tr", { class: "group-fields" },
                    el("td", {}, power),
                    el("td", {}, minPower),
                    el("td", {}, speed),
                    el("td", {}, passes),
                    el("td", {}, enabled),
                ),
            );
            groupRows.push({ body, power, minPower, speed, passes, enabled });
            return body;
        });
        return el("table", { class: "groups" },
            el("thead", {}, el("tr", {},
                el("th", {}, "S"),
                el("th", { title: "Least power where the head slows for a corner (dyn mode); 0 is none" }, "Min S"),
                el("th", {}, "mm/min"),
                el("th", { title: "Times the group runs over all of its paths" }, "Passes"),
                el("th", {}, "On"),
            )),
            ...rows,
        );
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

    function offsetRow(job: Job): HTMLElement {
        const x = numberField({ value: job.offset.x, width: "5.5rem" });
        const y = numberField({ value: job.offset.y, width: "5.5rem" });
        offsetFields = { x, y };
        const apply = async (): Promise<void> => {
            const ox = parseNumber(x.value);
            const oy = parseNumber(y.value);
            if (ox === null || oy === null) {
                ctx.toast("error", "offset needs x and y");
                return;
            }
            await ctx.call(ctx.api.patchJob(job.id, { offset: { x: ox, y: oy } }));
            await ctx.selectJob(job.id);
            await ctx.refreshJobs();
        };
        return el("div", { class: "goto-row" },
            el("span", { class: "choice-label" }, "Offset"),
            x, y,
            button("Move", () => apply(), "btn btn-quiet"),
        );
    }
}
