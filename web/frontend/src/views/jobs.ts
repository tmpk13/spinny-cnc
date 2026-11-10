// Upload, job list, the selected job's groups and stats, and the run controls.

import { askConfirm } from "../confirm.ts";
import { button, el, labeled, numberField, replace, setLocked } from "../dom.ts";
import { formatDuration, formatFixed, formatLength, formatMm, formatPercent, parseNumber } from "../format.ts";
import { type BoardLayer, boardLayers, isDrawingLayer, layerChoiceText } from "../kicad.ts";
import { isDispensing, isMilling, profileOf } from "../profile.ts";
import { GCODE_SUFFIXES, GERBER_SUFFIXES } from "../uploads.ts";
import { type ArraySpec, type PathRef, type Regrouped, arrayPaths, arrayRefusal, boxedAfter, groupRefs, pathsMiddle, regroup, regroupRefusal, removePaths, tidyRefs } from "../regroup.ts";
import type { AppState } from "../state.ts";
import type { Anchor, BoardMode, ClearPattern, Compensate, DepositFill, Group, Job, Progress, ResumePlan, ResumeRecord, ResumeRequest, UploadOptions } from "../types.ts";
import { calibrationTest } from "./calibrate.ts";
import { centerTest } from "./center.ts";
import { focusAgainText, mapUsable, mapUse, runMapUse, showMapUse } from "./heightmap.ts";
import { choiceRow, type Ctx } from "./context.ts";
import { changedWord, focusHereWord, withFocusHere, withWords } from "./focushere.ts";

/** Every file the Jobs import reads: a drawing, a job, a board layer's gerber or the KiCad file, or gcode. */
export const ACCEPT = [".svg", ".json", ...GERBER_SUFFIXES, ".kicad_pcb", ...GCODE_SUFFIXES].join(",");

/** The layers of a KiCad board a job is usually cut from, offered under the layer field; any other name may be typed. */
export const BOARD_LAYERS = ["F.Cu", "B.Cu", "F.Paste", "B.Paste", "F.Mask", "B.Mask", "F.SilkS", "B.SilkS"];
export const DEFAULT_LAYER = "F.Cu";
/** The paste layer on a copper layer's side, which a stencil is cut from. */
const PASTE_OF: Record<string, string> = { "F.Cu": "F.Paste", "B.Cu": "B.Paste" };
/** The most a stencil's openings are shrunk by on every side, mm, as the backend bounds it. */
export const MAX_MARGIN = 10;

/**
 * The margin a stencil job was cut with, mm: how much every opening was
 * shrunk by on every side. Null for a job that is not a stencil made from
 * a kept file, which has no margin to change.
 */
export function stencilMargin(job: Job): number | null {
    const options = job.recipe?.file ? job.recipe.options : null;
    if (!options || options["mode"] !== "stencil") {
        return null;
    }
    const margin = options["margin"];
    return typeof margin === "number" && Number.isFinite(margin) ? margin : 0;
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
    /** A laser with a focus axis: mm over focus for the group, blank for none. */
    focus: HTMLInputElement | null;
    enabled: HTMLInputElement;
}

/**
 * Whether the groups table has a focus column: a laser with a focus axis,
 * or a job whose groups have a focus already, so it can be seen and
 * cleared on a machine without one.
 */
export function showsFocus(job: Job, milling: boolean, focusAxis: boolean): boolean {
    if (milling || job.groups.some((group) => group.tool === "dispenser")) {
        return false;
    }
    return focusAxis || job.groups.some((group) => group.focus !== undefined && group.focus !== null);
}

/** A group's focus as its field shows it: blank for none. */
function focusText(focus: number | null | undefined): string {
    return focus === undefined || focus === null ? "" : String(focus);
}

/** What the groups table shows of a job's groups besides their fields: each label and how many paths it has. */
export function groupsShown(job: Job): string {
    return JSON.stringify(job.groups.map((group) => [group.label, group.paths.length, group.joints?.length ?? 0, group.moves?.length ?? 0]));
}

/** What a group mills to when a job does not say: through the copper, gently. */
export const DEFAULT_DEPTH = 0.1;
export const DEFAULT_PLUNGE = 60;
/** The paste over a pad when a job does not say, mm. */
export const DEFAULT_THICKNESS = 0.12;

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
 * What a new width does to a job, as the backend decides it: the job is
 * made again from its recipe (a kept board file, a Plot page operation),
 * its paths are kept and only the number changes (a drawing's lines), or
 * it cannot take one, since its paths follow the old width and nothing is
 * kept to make them again.
 */
export function widthMode(job: Job): "remake" | "width" | "refused" {
    if (job.recipe) {
        return "remake";
    }
    if (["kicad", "gerber", "stl"].includes(job.source) || job.copper.length > 0 || job.groups.some((group) => group.tool)) {
        return "refused";
    }
    return "width";
}

/**
 * What a job made from its recipe gives up when its paths are copied,
 * moved or taken out, said in a confirm: made again for another width or
 * from the Plot page, the job's file or operations would make its paths as
 * they were, which would `undo` the change. Empty for a job with no recipe.
 */
export function recipeLost(job: Job, undo: string): string {
    return job.recipe ? ` It is then no longer made again from its ${job.recipe.file ? "file" : "operations"} (another width, the Plot page), which would ${undo}.` : "";
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

/**
 * The Jobs panel in `root`, and the run controls in `runRoot`: a panel of
 * their own at the foot of the column, so Run stays in reach however long
 * the list and the groups grow.
 */
export function mountJobs(root: HTMLElement, ctx: Ctx, runRoot: HTMLElement): void {
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
        title: "The layer of a KiCad board the job is cut from: a copper layer to isolate or deposit, or F.Paste for a solder paste stencil cut out of a film. A gerber is its own layer",
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
    // A layer on the back is cut with the board turned over: flipped in X
    // unless said otherwise, so its copper lands where it is.
    const mirrorField = el("select", {
        class: "field",
        "aria-label": "Mirror",
        title: "How the layer is flipped (gerber and KiCad only). Auto flips a layer on the back (B.Cu, B.Paste) in X, for the board turned over left to right, and leaves the front as drawn",
    },
        el("option", { value: "auto" }, "auto"),
        el("option", { value: "none" }, "none"),
        el("option", { value: "x" }, "flip X"),
        el("option", { value: "y" }, "flip Y"),
    ) as HTMLSelectElement;
    const modeField = el("select", {
        class: "field",
        "aria-label": "Board mode",
        title: "Isolate burns around the copper to take it away; deposit burns the copper itself and nothing else, for a process that lays copper down; stencil cuts round the inside of every paste opening, so the piece drops out of the film and leaves the hole; on the lines cuts every line of the layer where it is drawn, the beam's middle on it, and every filled shape round its edge, for Edge.Cuts, a silk screen or a drawing (gerber and KiCad only). A deposit, a stencil or the lines leave the board outline off",
    },
        el("option", { value: "isolate" }, "isolate"),
        el("option", { value: "deposit" }, "deposit"),
        el("option", { value: "stencil" }, "stencil"),
        el("option", { value: "dispense" }, "dispense"),
        el("option", { value: "lines" }, "on the lines"),
    ) as HTMLSelectElement;
    // A stencil shrinks every opening by this much on every side.
    const marginField = numberField({ value: 0, min: 0, max: MAX_MARGIN, step: 0.01 });
    marginField.setAttribute("aria-label", "Stencil margin");
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
    // A KiCad board is cut from one of its layers: the board's own, read
    // from the file, are offered before anything is sent.
    const chooserTitle = el("p", { class: "layer-chooser-title" });
    const chooserSelect = el("select", { class: "field", "aria-label": "Layer to import" }) as HTMLSelectElement;
    const chooserImport = el("button", { type: "button", class: "btn btn-primary btn-small" }, "Import");
    const chooserCancel = el("button", { type: "button", class: "btn btn-quiet btn-small" }, "Cancel");
    const chooserNote = el("p", { class: "muted hint" });
    const chooser = el("div", { class: "layer-chooser hidden", role: "dialog", "aria-label": "Layer to import" },
        chooserTitle,
        el("div", { class: "layer-chooser-row" }, chooserSelect, chooserImport, chooserCancel),
        chooserNote,
    );
    const powerLabel = labeled("Power S", powerField);
    const speedLabel = labeled("Speed mm/min", speedField);
    const spotLabel = labeled("Spot mm", spotField);
    const clearLabel = labeled("Clear copper", clearField);
    const fillLabel = labeled("Fill copper", fillField);
    const thicknessLabel = labeled("Paste mm", thicknessField);
    thicknessLabel.title = "A dispense: mm of solder paste over every pad; a dot's volume is the pad's area times this";
    const marginLabel = labeled("Margin mm", marginField);
    marginLabel.title = "A stencil: mm every paste opening is shrunk by on every side, for less paste than the whole pad; the beam runs half a spot inside that, so the hole is the opening shrunk. The job's margin row cuts it again for another";
    const options = el("div", { class: "field-grid" },
        powerLabel,
        speedLabel,
        spotLabel,
        labeled("Anchor", anchorField),
        labeled("Offset x", offsetX),
        labeled("Offset y", offsetY),
        labeled("Layer", layerField),
        layerList,
        labeled("Mirror", mirrorField),
        labeled("Board", modeField),
        clearLabel,
        fillLabel,
        marginLabel,
        thicknessLabel,
    );
    // A deposit has no copper around its own to clear, and isolation
    // nothing inside the copper to fill: only the one that applies shows;
    // a stencil takes neither, only its margin, and a dispense only the
    // paste thickness.
    const showMode = (): void => {
        const mode = modeField.value;
        clearLabel.classList.toggle("hidden", mode !== "isolate");
        fillLabel.classList.toggle("hidden", mode !== "deposit");
        marginLabel.classList.toggle("hidden", mode !== "stencil");
        thicknessLabel.classList.toggle("hidden", mode !== "dispense");
    };
    modeField.addEventListener("change", () => {
        // A stencil is cut from the paste: a copper layer left in the field
        // turns into the paste layer on its side.
        const paste = PASTE_OF[layerField.value.trim()];
        if (modeField.value === "stencil" && paste) {
            layerField.value = paste;
        }
        showMode();
    });
    showMode();
    const list = el("ul", { class: "job-list" });
    const details = el("div", { class: "job-details" });
    const saveButton = button("Save job", () => saveJob(), "btn btn-quiet btn-small");
    const deleteAllButton = button("Delete all", () => removeAll(), "btn btn-quiet btn-small");
    // The jobs checked to be made one, in the order they were checked,
    // which is the order they are cut in.
    let combining: string[] = [];
    const combineButton = button("Combine", () => combine(), "btn btn-quiet btn-small");
    combineButton.title = "make one job of the jobs checked in the list, cut in the order they were checked; the jobs themselves stay";
    root.append(
        el("div", { class: "panel-head" }, el("h2", {}, "Jobs"), el("div", { class: "button-row" }, combineButton, saveButton, deleteAllButton)),
        drop, chooser, options, centerTest(ctx), calibrationTest(ctx), list, details,
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
        if (mirrorField.value === "none" || mirrorField.value === "x" || mirrorField.value === "y") {
            out.mirror = mirrorField.value;
        }
        if (modeField.value === "deposit") {
            out.mode = modeField.value as BoardMode;
            out.fill = fillField.value as DepositFill;
        } else if (modeField.value === "stencil") {
            out.mode = modeField.value as BoardMode;
            const margin = parseNumber(marginField.value);
            if (margin !== null) {
                out.margin = margin;
            }
        } else if (modeField.value === "dispense") {
            out.mode = modeField.value as BoardMode;
            const thickness = parseNumber(thicknessField.value);
            if (thickness !== null) {
                out.thickness = thickness;
            }
        } else if (modeField.value === "lines") {
            out.mode = modeField.value as BoardMode;
        } else if (clearField.value !== "off") {
            out.clear = clearField.value as ClearPattern;
        }
        return out;
    };

    /**
     * The layer of a KiCad board to cut, picked from the board's own layers
     * with what is drawn on each; undefined when the file has no layer
     * table to offer (the Layer field's goes), null when the import is
     * called off. Picking a drawing (Edge.Cuts, a silk screen, a user
     * layer) sets the Board choice to cut on its lines, and picking copper
     * or paste after that sets it back.
     */
    async function chooseLayer(file: File): Promise<string | null | undefined> {
        let layers: BoardLayer[];
        try {
            layers = boardLayers(await file.text());
        } catch {
            return undefined;
        }
        if (layers.length === 0) {
            return undefined;
        }
        const has = (name: string): boolean => layers.some((layer) => layer.name === name);
        const typed = layerField.value.trim();
        const copper = layers.find((layer) => layer.name.endsWith(".Cu") && layer.items > 0);
        replace(chooserSelect, ...layers.map((layer) => el("option", { value: layer.name }, layerChoiceText(layer))));
        chooserSelect.value = has(typed) ? typed : copper?.name ?? layers[0]!.name;
        chooserTitle.textContent = `${file.name}: the layer to cut`;
        // The Board choice before the chooser turned it to the lines.
        let before: string | null = null;
        const follow = (): void => {
            const name = chooserSelect.value;
            const drawing = isDrawingLayer(name);
            if (drawing && modeField.value !== "lines") {
                before = modeField.value;
                modeField.value = "lines";
                showMode();
            } else if (!drawing && before !== null && modeField.value === "lines") {
                modeField.value = before;
                before = null;
                showMode();
            }
            const layer = layers.find((entry) => entry.name === name);
            const empty = layer && layer.items === 0 ? "Nothing is drawn on it. " : "";
            const how = modeField.selectedOptions[0]?.textContent ?? modeField.value;
            chooserNote.textContent = `${empty}Board: ${how}, as set below.`;
        };
        follow();
        chooser.classList.remove("hidden");
        chooserSelect.focus();
        return await new Promise<string | null>((resolve) => {
            // A Board choice made by hand meanwhile is the operator's.
            const manual = (): void => {
                before = null;
                follow();
            };
            const finish = (value: string | null): void => {
                chooser.classList.add("hidden");
                chooserSelect.removeEventListener("change", follow);
                chooserSelect.removeEventListener("keydown", keys);
                modeField.removeEventListener("change", manual);
                chooserImport.onclick = null;
                chooserCancel.onclick = null;
                resolve(value);
            };
            const keys = (event: KeyboardEvent): void => {
                if (event.key === "Enter") {
                    event.preventDefault();
                    finish(chooserSelect.value);
                } else if (event.key === "Escape") {
                    event.preventDefault();
                    finish(null);
                }
            };
            chooserSelect.addEventListener("change", follow);
            chooserSelect.addEventListener("keydown", keys);
            modeField.addEventListener("change", manual);
            chooserImport.onclick = () => finish(chooserSelect.value);
            chooserCancel.onclick = () => finish(null);
        });
    }

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
                if (file.name.toLowerCase().endsWith(".kicad_pcb")) {
                    const layer = await chooseLayer(file);
                    if (layer === null) {
                        continue;
                    }
                    if (layer !== undefined) {
                        layerField.value = layer;
                    }
                }
                const job = await ctx.call(ctx.api.uploadJob(file, uploadOptions()));
                await ctx.refreshJobs();
                if (job) {
                    await ctx.selectJob(job.id);
                    ctx.toast("info", `loaded ${job.name}`);
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
        combining = combining.filter((id) => state.jobs.some((job) => job.id === id));
        replace(list, ...state.jobs.map((job) => {
            const item = el("li", { class: job.id === selected ? "selected" : "" });
            const check = el("input", { type: "checkbox", class: "job-check", "aria-label": `combine ${job.name}`, title: "check two or more jobs to combine them" }) as HTMLInputElement;
            check.checked = combining.includes(job.id);
            check.addEventListener("change", () => {
                combining = check.checked ? [...combining.filter((id) => id !== job.id), job.id] : combining.filter((id) => id !== job.id);
                renderCombine();
            });
            // A small drawing of the job; its address changes with what it
            // shows, so an unchanged job's is not asked for again.
            const thumb = el("img", { class: "job-thumb", src: ctx.api.jobThumbUrl(job), alt: "", loading: "lazy", decoding: "async" });
            const pick = el("button", { type: "button", class: "job-pick", onclick: () => void ctx.selectJob(job.id) },
                thumb,
                el("span", { class: "job-text" },
                    el("span", { class: "job-name" }, job.name),
                    el("span", { class: "muted" }, job.layer ? ` ${job.source} ${job.layer}` : ` ${job.source}`),
                    job.stats ? el("span", { class: "muted job-stat" }, ` ${formatLength(job.stats.length_mm)}, ${formatDuration(job.stats.seconds)}`) : null,
                ),
            );
            const remove = button("Delete", () => removeJob(job.id, job.name), "btn btn-quiet btn-small");
            item.append(check, pick, remove);
            return item;
        }));
        if (state.jobs.length === 0) {
            list.append(el("li", { class: "muted" }, "no jobs yet"));
        }
        renderCombine();
    }

    function renderCombine(): void {
        setLocked(combineButton, combining.length < 2);
        combineButton.textContent = combining.length >= 2 ? `Combine ${combining.length}` : "Combine";
    }

    async function combine(): Promise<void> {
        const jobs = combining.map((id) => ctx.store.get().jobs.find((job) => job.id === id)).filter((job): job is NonNullable<typeof job> => job !== undefined);
        if (jobs.length < 2) {
            return;
        }
        if (!(await askConfirm(`Make one job of ${jobs.map((job) => job.name).join(", then ")}? It cuts them in that order; the jobs themselves stay.`, "Combine"))) {
            return;
        }
        const made = await ctx.call(ctx.api.combineJobs(jobs.map((job) => job.id)));
        if (!made) {
            return;
        }
        combining = [];
        await ctx.refreshJobs();
        await ctx.selectJob(made.id);
        ctx.toast("info", `made ${made.name}`);
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
    // The table's rows carry each group's label and count of paths, so it
    // is built again when a re-cut changes either, as another width or
    // margin does with the groups as many as before.
    let detailsGroups = "";
    // The table's columns are the tool's, so it is built again when the
    // machine's tool changes under it, or the focus column comes or goes.
    let detailsMilling = false;
    let detailsFocus = false;
    // The inputs of the groups table and the offset row, kept so that a
    // fresh copy of the same job updates them in place: rebuilding the
    // table would tear out the field the operator is typing in, and the
    // browser fires no change for a field that is gone.
    let groupRows: GroupRow[] = [];
    let offsetFields: { x: HTMLInputElement; y: HTMLInputElement; rotation: HTMLElement } | null = null;
    let widthField: HTMLInputElement | null = null;
    let jobMarginField: HTMLInputElement | null = null;
    let statsEl: HTMLElement | null = null;
    // The paths picked in the preview: how many, and moving them into a
    // group of their own or one the job has, or taking them out of it.
    const pickedCount = el("span", { class: "picked-count" });
    const pickedTarget = el("select", { class: "field", "aria-label": "Move picked paths to" }) as HTMLSelectElement;
    const pickedLabel = el("input", { type: "text", class: "field", "aria-label": "New group name", placeholder: "new group's name", spellcheck: "false" }) as HTMLInputElement;
    const pickedMove = button("Move", () => movePicked(), "btn btn-small");
    pickedMove.title = "move the picked paths into the group chosen; a new group takes the settings of the first group they come from, and is off if any of those groups is";
    const pickedDelete = button("Delete paths", () => deletePicked(), "btn btn-quiet btn-small");
    const pickedClear = button("Clear", () => ctx.store.set({ selection: null }), "btn btn-quiet btn-small");
    const pickedArray = button("Array", () => toggleArray(), "btn btn-quiet btn-small btn-toggle");
    pickedArray.title = "copies of the picked paths in a row or round a center, drawn as they are typed";
    pickedArray.setAttribute("aria-pressed", "false");
    // The pattern of copies: a row stepped by x and y, or a turn about a
    // center, the count taking the picked paths in. The copies are drawn
    // on the preview as the fields change, and kept with Make array.
    let arrayKind: ArraySpec["kind"] = "linear";
    const arrayKinds = choiceRow<ArraySpec["kind"]>(["linear", "circular"], arrayKind, (kind) => {
        arrayKind = kind;
        arrayChanged();
    }, (kind) => (kind === "linear" ? "Linear" : "Circular"), "Array");
    const arrayField = (value: number, label: string, min?: number): HTMLInputElement => {
        const field = numberField({ value, min, step: 1 });
        field.setAttribute("aria-label", label);
        field.addEventListener("input", () => arrayChanged());
        return field;
    };
    const arrayCount = arrayField(3, "Count", 2);
    const arrayDx = arrayField(10, "Step x");
    const arrayDy = arrayField(0, "Step y");
    const arrayCx = arrayField(0, "Center x");
    const arrayCy = arrayField(0, "Center y");
    const arraySweep = arrayField(360, "Sweep");
    const arrayMiddle = button("Middle", () => {
        const state = ctx.store.get();
        if (state.job) {
            [arrayCx.value, arrayCy.value] = pathsMiddle(state.job, picked(state)).map((v) => formatMm(v)) as [string, string];
            arrayChanged();
        }
    }, "btn btn-quiet btn-small");
    arrayMiddle.title = "turn about the middle of the picked paths";
    const arrayAxis = button("Origin", () => {
        arrayCx.value = "0";
        arrayCy.value = "0";
        arrayChanged();
    }, "btn btn-quiet btn-small");
    arrayAxis.title = "turn about the board's origin, the rotation axis on the polar machine";
    const linearFields = el("div", { class: "field-row" }, labeled("Step x mm", arrayDx), labeled("Step y mm", arrayDy));
    const circularFields = el("div", { class: "field-row" }, labeled("Center x mm", arrayCx), labeled("Center y mm", arrayCy), arrayMiddle, arrayAxis, labeled("Sweep deg", arraySweep));
    circularFields.title = "a whole turn (360) spreads the copies evenly round it; less puts the last one on the end of the sweep; positive turns counterclockwise";
    const arrayNote = el("p", { class: "muted hint" });
    const arrayMake = button("Make array", () => makeArray(), "btn btn-primary btn-small");
    const arrayCancel = button("Cancel", () => closeArray(), "btn btn-quiet btn-small");
    const arrayBox = el("div", { class: "array-box hidden" },
        arrayKinds,
        el("div", { class: "field-row" }, labeled("Count", arrayCount)),
        linearFields,
        circularFields,
        arrayNote,
        el("div", { class: "button-row" }, arrayMake, arrayCancel),
    );
    const pickedRow = el("div", { class: "picked-row hidden" },
        pickedCount,
        el("div", { class: "picked-controls" }, pickedTarget, pickedLabel, pickedMove, pickedDelete, pickedArray, pickedClear),
        arrayBox,
    );
    pickedTarget.addEventListener("change", () => renderPicked(ctx.store.get()));
    ctx.store.subscribe((state) => renderPicked(state), ["selection", "job"]);

    /** The pattern the array fields give. */
    function arraySpec(): ArraySpec {
        const read = (field: HTMLInputElement): number => parseNumber(field.value) ?? Number.NaN;
        return arrayKind === "linear"
            ? { kind: "linear", count: read(arrayCount), dx: read(arrayDx), dy: read(arrayDy) }
            : { kind: "circular", count: read(arrayCount), cx: read(arrayCx), cy: read(arrayCy), sweep: read(arraySweep) };
    }

    function toggleArray(): void {
        if (arrayBox.classList.contains("hidden")) {
            arrayBox.classList.remove("hidden");
            pickedArray.setAttribute("aria-pressed", "true");
            arrayChanged();
        } else {
            closeArray();
        }
    }

    function closeArray(): void {
        arrayBox.classList.add("hidden");
        pickedArray.setAttribute("aria-pressed", "false");
        if (ctx.store.get().arrayDraft !== null) {
            ctx.store.set({ arrayDraft: null });
        }
    }

    /** The copies as the fields give them, drawn on the preview, or why there are none. */
    function arrayChanged(): void {
        linearFields.classList.toggle("hidden", arrayKind !== "linear");
        circularFields.classList.toggle("hidden", arrayKind !== "circular");
        const state = ctx.store.get();
        const job = state.job;
        const refs = picked(state);
        if (arrayBox.classList.contains("hidden") || job === null) {
            return;
        }
        const spec = arraySpec();
        const refusal = arrayRefusal(job, refs, spec);
        setLocked(arrayMake, refusal !== "");
        if (refusal) {
            arrayNote.textContent = refusal;
            ctx.store.set({ arrayDraft: null });
            return;
        }
        const made = arrayPaths(job, refs, spec);
        arrayNote.textContent = `${made.refs.length} ${made.refs.length === 1 ? "copy" : "copies"} of ${refs.length} ${refs.length === 1 ? "path" : "paths"}, drawn on the preview; each goes at the end of its path's group`;
        ctx.store.set({ arrayDraft: made.job });
    }

    async function makeArray(): Promise<void> {
        const state = ctx.store.get();
        const job = state.job;
        const refs = picked(state);
        if (job === null || refs.length === 0) {
            return;
        }
        let result: Regrouped;
        try {
            result = arrayPaths(job, refs, arraySpec());
        } catch (error) {
            ctx.toast("error", error instanceof Error ? error.message : String(error));
            return;
        }
        if (job.recipe && !(await askConfirm(`Add ${result.refs.length} copies to ${job.name}?${recipeLost(job, "lose them")}`, "Make array"))) {
            return;
        }
        const made = await ctx.call(ctx.api.replaceJob(job.id, { ...result.job, recipe: null }));
        if (!made) {
            return;
        }
        closeArray();
        await ctx.reloadJob(job.id);
        // The copies stay picked: Delete paths takes the array back.
        ctx.store.set({ selection: { job: job.id, paths: result.refs } });
        await ctx.refreshJobs();
        ctx.toast("info", `${result.refs.length} ${result.refs.length === 1 ? "copy" : "copies"} added to ${job.name}`);
    }

    /** The picked paths of the selected job, those it still has; paths picked on the JSON panel's edit are the edit's, not its. */
    function picked(state: AppState): PathRef[] {
        const job = state.job;
        const selection = state.selection;
        return job !== null && selection !== null && selection.job === job.id && !selection.draft ? tidyRefs(job, selection.paths) : [];
    }

    function renderPicked(state: AppState): void {
        const job = state.job;
        const refs = picked(state);
        pickedRow.classList.toggle("hidden", job === null || refs.length === 0);
        if (job === null || refs.length === 0) {
            closeArray();
            return;
        }
        // The copies follow the paths picked.
        arrayChanged();
        const groups = new Set(refs.map(([g]) => g)).size;
        pickedCount.textContent = `${refs.length} ${refs.length === 1 ? "path" : "paths"} picked from ${groups} ${groups === 1 ? "group" : "groups"}`;
        const chosen = pickedTarget.value;
        const options = [
            el("option", { value: "new" }, "into a new group"),
            ...job.groups.map((group, g) => el("option", { value: String(g) }, `into ${group.label}`)),
        ];
        replace(pickedTarget, ...options);
        pickedTarget.value = options.some((option) => option.value === chosen) ? chosen : "new";
        pickedLabel.classList.toggle("hidden", pickedTarget.value !== "new");
        const refusal = regroupRefusal(job, refs, pickedTarget.value === "new" ? "new" : Number(pickedTarget.value));
        pickedMove.title = refusal || "move the picked paths into the group chosen; a new group takes the settings of the first group they come from, and is off if any of those groups is";
        setLocked(pickedMove, refusal !== "");
    }

    async function movePicked(): Promise<void> {
        const state = ctx.store.get();
        const job = state.job;
        const refs = picked(state);
        if (job === null || refs.length === 0) {
            return;
        }
        let result: Regrouped;
        try {
            result = regroup(job, refs, pickedTarget.value === "new" ? "new" : Number(pickedTarget.value), pickedLabel.value);
        } catch (error) {
            ctx.toast("error", error instanceof Error ? error.message : String(error));
            return;
        }
        const count = `${refs.length} ${refs.length === 1 ? "path" : "paths"}`;
        if (job.recipe && !(await askConfirm(`Move ${count} of ${job.name}?${recipeLost(job, "put them back")}`, "Move"))) {
            return;
        }
        const made = await ctx.call(ctx.api.replaceJob(job.id, { ...result.job, recipe: null }));
        if (!made) {
            return;
        }
        pickedLabel.value = "";
        await ctx.reloadJob(job.id);
        // The paths stay picked where they are now, to move on or set.
        ctx.store.set({ selection: { job: job.id, paths: result.refs } });
        await ctx.refreshJobs();
        const into = made.groups[result.refs[0]![0]]?.label ?? "the group";
        ctx.toast("info", `${result.refs.length} ${result.refs.length === 1 ? "path" : "paths"} moved into ${into}`);
    }

    async function deletePicked(): Promise<void> {
        const state = ctx.store.get();
        const job = state.job;
        const refs = picked(state);
        if (job === null || refs.length === 0) {
            return;
        }
        let made: Job;
        try {
            made = removePaths(job, refs);
        } catch (error) {
            ctx.toast("error", error instanceof Error ? error.message : String(error));
            return;
        }
        const count = `${refs.length} ${refs.length === 1 ? "path" : "paths"}`;
        if (!(await askConfirm(`Take ${count} out of ${job.name}? A group left empty goes too.${recipeLost(job, "bring them back")}`, "Delete paths"))) {
            return;
        }
        const kept = await ctx.call(ctx.api.replaceJob(job.id, { ...made, recipe: null }));
        if (!kept) {
            return;
        }
        ctx.store.set({ selection: null });
        await ctx.reloadJob(job.id);
        await ctx.refreshJobs();
        ctx.toast("info", `${count} taken out of ${job.name}`);
    }

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
        renderProgress(ctx.store.get());
    });
    // What Run does with the map, or what the run under way does with it.
    const mapChip = el("span", { class: "badge map-use" });
    const holdButton = button("Hold", () => ctx.call(ctx.api.runHold()), "btn");
    const resumeButton = button("Resume", () => ctx.call(ctx.api.runResume()), "btn");
    const stopButton = button("Stop", () => ctx.call(ctx.api.runStop()), "btn btn-danger");
    const runRow = el("div", { class: "run-row" }, runButton, compensate, mapChip, holdButton, resumeButton, stopButton, runNote);
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
    // The run controls: the selected job's name over them, since the
    // panel they sit in may be far from the list it was picked in.
    const runTitle = el("span", { class: "muted run-job" });
    runRoot.append(
        el("div", { class: "panel-head" }, el("h2", {}, "Run"), runTitle),
        runRow,
        compensateNote,
        progressBox,
        pickupBox,
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
            ctx.toast("error", "the line done is a whole number");
            return null;
        }
        // The map choice follows the row above: what the operator picked, or
        // the way the run being picked up followed the board when untouched.
        return { line, rewind: pickupRewind.checked, compensate: compensateTouched ? (compensate.value as Compensate) : null };
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
        const here = given.has("focus_here") ? " Its groups' focus counts from where the head is now." : "";
        const changed = given.has("changed") ? " Its lines are counted in the job as it is now, not as the stopped run had them." : "";
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
        const where = plan.next ? ` Then line ${plan.skip}: ${plan.next}.` : " Nothing is left to send.";
        const fromRecord = plan.planned_from_record ? "" : " The last run's record is another job's, so the lines are counted from where the head is now.";
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
            `Pick ${job.name} up at line ${plan.skip} of ${plan.total}? The head is brought there from where it is now:`
            + ` ${plan.approach.join("; ") || "nothing to do"}. Check that the position shown is where the head really is.`
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
        const groups = groupsShown(job);
        const focusColumn = showsFocus(job, milling, profileOf(state.snapshot).h_axis);
        if (detailsFor !== job.id || detailsJob === null || detailsGroups !== groups || detailsMilling !== milling || detailsFocus !== focusColumn) {
            detailsFor = job.id;
            detailsJob = job;
            detailsGroups = groups;
            detailsMilling = milling;
            detailsFocus = focusColumn;
            statsEl = statsBlock(job);
            replace(details,
                el("h3", {}, job.name),
                groupsTable(job, milling, focusColumn),
                pickedRow,
                statsEl,
                offsetRow(job),
                widthRow(job, milling),
                marginRow(job),
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
            if (row.focus) {
                setUnlessFocused(row.focus, focusText(group.focus), focused);
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
        if (widthField) {
            setUnlessFocused(widthField, String(job.spot), focused);
        }
        const margin = stencilMargin(job);
        if (jobMarginField && margin !== null) {
            setUnlessFocused(jobMarginField, String(margin), focused);
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
        runTitle.textContent = state.job ? state.job.name : "no job selected";
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
        const choice = compensate.value as Compensate;
        const ours = active && progress.job === state.job?.id;
        const planned = mapUse(choice, map, state.job, profileOf(state.snapshot));
        showMapUse(mapChip, ours ? runMapUse(progress, milling) ?? planned : planned);
        // The other panels say what the choice does; set last, since it
        // calls them back.
        ctx.store.set({ mapChoice: choice });
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

    function groupsTable(job: Job, milling: boolean, focusColumn: boolean): HTMLElement {
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
            // A model's moves carry their own depths, level after level: its
            // depth is the deepest they go, and it has no passes to set.
            const carved = (group.moves?.length ?? 0) > 0;
            if (carved) {
                for (const field of [depth, passes]) {
                    field.disabled = true;
                    field.title = "set by the model's moves";
                }
            }
            const thickness = dots ? groupField(group.thickness ?? DEFAULT_THICKNESS, 0.01, "thickness") : null;
            if (thickness) {
                thickness.step = "0.01";
            }
            // Blank is no focus of its own: the head stays where the run puts it.
            let focus: HTMLInputElement | null = null;
            if (focusColumn && !dots && !carved) {
                focus = numberField({ min: -50, max: 50, step: 0.1, placeholder: "-" });
                focus.value = focusText(group.focus);
                focus.setAttribute("aria-label", "focus");
                focus.title = "mm the head is raised above focus for this group, negative lowers it; blank leaves it where the run puts it";
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
                // A blank focus takes the group's own away; a typed one sets it.
                const f = focus ? (focus.value.trim() === "" ? null : parseNumber(focus.value)) : undefined;
                await ctx.call(ctx.api.patchJob(job.id, {
                    groups: [{
                        index,
                        ...(p !== null && !dots ? { power: p } : {}),
                        ...(m !== null && !milling && !dots ? { min_power: m } : {}),
                        ...(s !== null && !dots ? { speed: s } : {}),
                        ...(n !== null && !carved ? { passes: n } : {}),
                        ...(d !== null && milling && !dots && !carved ? { depth: d } : {}),
                        ...(u !== null && milling && !dots ? { plunge: u } : {}),
                        ...(t !== null ? { thickness: t } : {}),
                        ...(f !== undefined && !(f === null && focus!.value.trim() !== "") ? { focus: f } : {}),
                        enabled: enabled.checked,
                    }],
                }));
                await ctx.reloadJob(job.id);
                await ctx.refreshJobs();
            };
            for (const field of [power, minPower, speed, passes, depth, plunge, enabled, ...(thickness ? [thickness] : []), ...(focus ? [focus] : [])]) {
                field.addEventListener("change", () => void patch());
            }
            // Milled, the floor means nothing and the depth and the plunge
            // take its place: a pass is a step down, not a burn again. A
            // group of paste dots has only its thickness and its passes.
            const fields = thickness
                ? [thickness, passes, enabled]
                : milling
                    ? [power, depth, speed, plunge, passes, enabled]
                    : focusColumn
                        ? [power, minPower, speed, passes, focus ?? el("span", { class: "muted" }, "-"), enabled]
                        : [power, minPower, speed, passes, enabled];
            // The name has a line of its own above the fields, so they get
            // the whole width of a side panel.
            // The name picks the group's paths in the preview, shift adds them.
            const name = el("button", { type: "button", class: "group-pick", title: "pick this group's paths in the preview; shift adds them to those picked" },
                el("span", { class: "swatch", "data-group": String(index % 4) }), group.label);
            name.addEventListener("click", (event) => {
                const refs = groupRefs(job, index);
                const selection = ctx.store.get().selection;
                const current = selection !== null && selection.job === job.id && !selection.draft ? selection.paths : [];
                ctx.store.set({ selection: { job: job.id, paths: boxedAfter(current, refs, event.shiftKey) } });
            });
            const body = el("tbody", { class: group.enabled ? "" : "disabled" },
                el("tr", { class: "group-name" },
                    el("th", { scope: "rowgroup", colspan: String(fields.length) },
                        name,
                        el("span", { class: "muted" }, group.joints?.length ? ` (${group.joints.length}, joint space)` : carved ? ` (${group.moves!.length}, 3D)` : dots ? ` (${group.paths.length} dots)` : ` (${group.paths.length})`))),
                el("tr", { class: "group-fields" }, ...fields.map((field) => el("td", {}, field))),
            );
            groupRows.push({ body, power, minPower, speed, passes, depth, plunge, thickness, focus, enabled });
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
                ...(focusColumn ? [el("th", { title: "mm over focus for the group, on the height the run starts at or the height map's focus height; blank is none" }, "Focus")] : []),
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

    /** The bit's or the beam's width the job is cut for, and the button that makes it again for another. */
    function widthRow(job: Job, milling: boolean): HTMLElement {
        const mode = widthMode(job);
        const field = numberField({ value: job.spot, min: 0.001, step: 0.01, width: "5.5rem" });
        field.setAttribute("aria-label", milling ? "Tool width" : "Spot width");
        widthField = field;
        const apply = button(mode === "remake" ? "Re-cut" : "Set", () => applyWidth(), "btn btn-quiet");
        const note = el("span", { class: "muted job-width-note" },
            mode === "remake" ? "paths made again where the job is now"
                : mode === "width" ? "the paths stay as they are"
                    : "made for this width: import again for another");
        if (mode === "refused") {
            field.disabled = true;
            setLocked(apply, true);
            apply.title = "nothing is kept to make the paths again: import the file again with the new width";
        } else {
            apply.title = mode === "remake"
                ? "make the job's paths again for this width from what it was made of, its groups' settings kept"
                : "the drawn width and the margins of probing take it; the paths are the drawing's lines";
        }
        field.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                void applyWidth();
            }
        });
        const applyWidth = async (): Promise<void> => {
            const width = parseNumber(field.value);
            if (width === null || !(width > 0)) {
                ctx.toast("error", "the width is a number of mm above 0");
                return;
            }
            // The row outlives a re-cut: the job as it is now decides.
            const current = ctx.store.get().job;
            if (!current || current.id !== job.id || width === current.spot) {
                return;
            }
            if (mode === "remake" && !(await askConfirm(`Make ${job.name} again for ${width} mm? Its paths are made anew where the job is now; the groups keep their settings.`, "Re-cut"))) {
                return;
            }
            const made = await ctx.call(ctx.api.setJobWidth(job.id, width));
            if (made) {
                await ctx.reloadJob(job.id);
                await ctx.refreshJobs();
                ctx.toast("info", `${job.name}: ${width} mm`);
            }
        };
        return el("div", { class: "goto-row" },
            el("span", { class: "choice-label" }, jobLabels(milling).spot),
            field,
            apply,
            note,
        );
    }

    /**
     * A stencil's margin and the button that cuts it again for another,
     * where the job is now, so the preview shows what a margin leaves
     * before anything is cut. Null for a job that is not a stencil.
     */
    function marginRow(job: Job): HTMLElement | null {
        const margin = stencilMargin(job);
        if (margin === null) {
            jobMarginField = null;
            return null;
        }
        const field = numberField({ value: margin, min: 0, max: MAX_MARGIN, step: 0.01, width: "5.5rem" });
        field.setAttribute("aria-label", "Margin of this stencil");
        jobMarginField = field;
        const apply = button("Re-cut", () => applyMargin(), "btn btn-quiet");
        apply.title = "cut the stencil again with every opening shrunk by this much on every side, where the job is now; its groups keep their settings";
        field.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                apply.click();
            }
        });
        const applyMargin = async (): Promise<void> => {
            const value = parseNumber(field.value);
            if (value === null || !(value >= 0 && value <= MAX_MARGIN)) {
                ctx.toast("error", `the margin is a number of mm from 0 to ${MAX_MARGIN}`);
                return;
            }
            // The row outlives a re-cut: the job as it is now decides.
            const current = ctx.store.get().job;
            if (!current || current.id !== job.id || value === stencilMargin(current)) {
                return;
            }
            const made = await ctx.call(ctx.api.setJobMargin(job.id, value));
            if (made) {
                await ctx.reloadJob(job.id);
                await ctx.refreshJobs();
                ctx.toast("info", `${job.name}: ${value} mm margin`);
            }
        };
        return el("div", { class: "goto-row" },
            el("span", { class: "choice-label" }, "Margin mm"),
            field,
            apply,
            el("span", { class: "muted job-width-note" }, "openings shrunk this much on every side"),
        );
    }

    function offsetRow(job: Job): HTMLElement {
        const x = numberField({ value: job.offset.x, width: "5.5rem" });
        const y = numberField({ value: job.offset.y, width: "5.5rem" });
        const rotation = el("span", { class: "muted job-rotation", title: "Degrees the job has been turned counterclockwise since import, by Turn and by alignment" }, rotationText(job));
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
        // Turning, counterclockwise for a positive angle: about the middle
        // of what the job cuts it stays where it is, about the origin (the
        // axis on the polar machine) it swings round it.
        const angle = numberField({ value: 90, min: -360, max: 360, step: 15, width: "4.5rem" });
        angle.setAttribute("aria-label", "Turn degrees");
        const about = el("select", { class: "field", "aria-label": "Turn about" },
            el("option", { value: "center" }, "about its middle"),
            el("option", { value: "origin" }, "about the origin"),
        ) as HTMLSelectElement;
        const turn = async (sign: number): Promise<void> => {
            const degrees = parseNumber(angle.value);
            if (degrees === null || degrees === 0 || Math.abs(degrees) > 360) {
                ctx.toast("error", "turn needs an angle from -360 to 360 degrees, not 0");
                return;
            }
            await ctx.call(ctx.api.patchJob(job.id, { turn: sign * degrees, about: about.value === "origin" ? "origin" : "center" }));
            await ctx.reloadJob(job.id);
            await ctx.refreshJobs();
        };
        const fixed = job.groups.some((group) => (group.joints?.length ?? 0) > 0);
        const ccw = button("Turn left", () => turn(1), "btn btn-quiet");
        ccw.title = "Turn the job counterclockwise by the angle";
        const cw = button("Turn right", () => turn(-1), "btn btn-quiet");
        cw.title = "Turn the job clockwise by the angle";
        // A joint-space group is written about the axis: nothing to turn.
        setLocked(ccw, fixed);
        setLocked(cw, fixed);
        angle.disabled = fixed;
        about.disabled = fixed;
        return el("div", { class: "goto-row" },
            el("span", { class: "choice-label" }, "Offset"),
            x, y,
            button("Move", () => apply(), "btn btn-quiet"),
            el("span", { class: "choice-label" }, "Turn"),
            angle, about, ccw, cw,
            rotation,
        );
    }
}
