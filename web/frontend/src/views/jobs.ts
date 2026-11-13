// Upload, job list, the selected job's groups and stats; the Run panel beside them is run.ts.

import { errorText } from "../api.ts";
import { askConfirm } from "../confirm.ts";
import { popUp } from "../dismiss.ts";
import { button, downloadText, el, fileDrop, labeled, numberField, onEnter, relabel, replace, setLocked, setUnlessFocused } from "../dom.ts";
import { countText, formatDuration, formatFixed, formatLength, formatMm, formatOptional, formatPercent, parseNumber } from "../format.ts";
import { type BoardLayer, boardLayers, isDrawingLayer, layerChoiceText } from "../kicad.ts";
import { isMilling, profileOf } from "../profile.ts";
import { GCODE_SUFFIXES, GERBER_SUFFIXES } from "../uploads.ts";
import { type ArraySpec, type PathRef, type Regrouped, arrayPaths, arrayRefusal, boxedAfter, groupRefs, pathsMiddle, regroup, regroupRefusal, removePaths, tidyRefs } from "../regroup.ts";
import type { AppState } from "../state.ts";
import type { Anchor, BoardMode, ClearPattern, DepositFill, Job, UploadOptions } from "../types.ts";
import { runActive } from "./heightmap.ts";
import { choiceRow, type Ctx } from "./context.ts";
import { iconPicker, jobPicture } from "./jobicon.ts";
import { mountRun } from "./run.ts";

/** Every file the Jobs import reads: a drawing (SVG or DXF), a job, a board layer's gerber or the KiCad file, or gcode. */
export const ACCEPT = [".svg", ".dxf", ".json", ...GERBER_SUFFIXES, ".kicad_pcb", ...GCODE_SUFFIXES].join(",");

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

/** What the groups table shows of a job's groups besides their fields: each label and how many paths it has. */
export function groupsShown(job: Job): string {
    return JSON.stringify(job.groups.map((group) => [group.label, group.paths.length, group.joints?.length ?? 0, group.moves?.length ?? 0]));
}

/** What a group mills to when a job does not say: through the copper, gently. */
export const DEFAULT_DEPTH = 0.1;
export const DEFAULT_PLUNGE = 60;
/** The paste over a pad when a job does not say, mm. */
export const DEFAULT_THICKNESS = 0.12;

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
    return job.recipe ? ` It is no longer remade from its ${job.recipe.file ? "file" : "operations"} (new width, Plot page), which would ${undo}.` : "";
}

/** The labels a milling machine gives the job's numbers, and a laser's. */
export function jobLabels(milling: boolean): { power: string; speed: string; spot: string } {
    return milling
        ? { power: "Spindle S", speed: "Feed mm/min", spot: "Tool mm" }
        : { power: "Power S", speed: "Speed mm/min", spot: "Spot mm" };
}

/**
 * The Jobs panel in `root`, and the Run panel in `runRoot`: a panel of its
 * own at the foot of the column, so Run stays in reach however long the
 * list and the groups grow.
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
        title: "KiCad layer to cut: copper, or F.Paste for a stencil; gerbers ignore it",
    }) as HTMLInputElement;
    const clearField = el("select", {
        class: "field",
        "aria-label": "Clear copper",
        title: "Burn off leftover copper inside the outline (gerber, KiCad); radial is fastest",
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
        title: "Flip the layer (gerber, KiCad); auto flips back layers in X",
    },
        el("option", { value: "auto" }, "auto"),
        el("option", { value: "none" }, "none"),
        el("option", { value: "x" }, "flip X"),
        el("option", { value: "y" }, "flip Y"),
    ) as HTMLSelectElement;
    const modeField = el("select", {
        class: "field",
        "aria-label": "Board mode",
        title: "isolate: burn around the copper; deposit: burn the copper itself; stencil: cut out paste openings; lines: cut along drawn lines",
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
        title: "How a deposit fills the copper; radial is fastest",
    },
        el("option", { value: "contour" }, "contour"),
        el("option", { value: "radial" }, "radial"),
        el("option", { value: "rings" }, "rings"),
        el("option", { value: "lines" }, "lines"),
    );
    const drop = el("div", { class: "drop" },
        el("p", {}, "Drop a file here (svg, dxf, json, gerber, kicad_pcb, gcode) or"),
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
    thicknessLabel.title = "Paste height over each pad, mm; dot volume is pad area times this";
    const marginLabel = labeled("Margin mm", marginField);
    marginLabel.title = "mm each paste opening shrinks on every side";
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
    const saveButton = button("Save job", () => saveJob(), "btn btn-quiet btn-small", "download the job as JSON");
    const deleteAllButton = button("Delete all", () => removeAll(), "btn btn-quiet btn-small", "delete every job");
    // The jobs checked to be made one, in the order they were checked,
    // which is the order they are cut in.
    let combining: string[] = [];
    // The job whose icon picker is open under its row, if one is.
    let iconFor: string | null = null;
    const combineButton = button("Combine", () => combine(), "btn btn-quiet btn-small");
    combineButton.title = "join the checked jobs into one, in the order checked";
    root.append(
        el("div", { class: "panel-head" }, el("h2", {}, "Jobs"), el("div", { class: "button-row" }, combineButton, saveButton, deleteAllButton)),
        drop, chooser, options, list, details,
    );

    /** The selected job as the file it is kept in, to put back with an upload. */
    function saveJob(): void {
        const job = ctx.store.get().job;
        if (!job) {
            ctx.toast("error", "select a job to save");
            return;
        }
        const name = job.name.replace(/[^A-Za-z0-9._-]+/g, "_") || "job";
        if (!downloadText(`${name}.json`, JSON.stringify(job, null, 2), "application/json")) {
            ctx.toast("error", "this browser cannot save a file from the page");
        }
    }

    async function removeAll(): Promise<void> {
        const count = ctx.store.get().jobs.length;
        if (count === 0) {
            ctx.toast("info", "no jobs to delete");
            return;
        }
        const kept = runActive(ctx.store.get().progress) ? " The running job stays." : "";
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
        chooserTitle.textContent = `${file.name}: layer to cut`;
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
            const empty = layer && layer.items === 0 ? "This layer is empty. " : "";
            const how = modeField.selectedOptions[0]?.textContent ?? modeField.value;
            chooserNote.textContent = `${empty}Board: ${how} (set below).`;
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

    // Each file of a drop or a pick is uploaded in turn, a board after its
    // layer is chosen.
    fileDrop(drop, fileInput, async (files) => {
        for (const file of files) {
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
    });

    ctx.store.subscribe((state) => renderList(state), ["jobs", "job"]);
    ctx.store.subscribe((state) => renderDetails(state), ["job", "progress", "snapshot", "heightMap"]);

    // While the icon picker is open it is a pop-up: a press elsewhere only shuts it.
    let releaseIcon: (() => void) | null = null;

    /** Shuts the icon picker where it stands, the rows left as they are: a row made again under a press would take no click. */
    function closeIcon(): void {
        iconFor = null;
        releaseIcon?.();
        releaseIcon = null;
        list.querySelector(".job-icon-row")?.remove();
        list.querySelector('.job-thumb-button[aria-expanded="true"]')?.setAttribute("aria-expanded", "false");
    }

    document.addEventListener("pointerdown", (event) => {
        const target = event.target as Element | null;
        if (iconFor !== null && target?.closest && !target.closest(".job-icon-row, .job-thumb-button")) {
            closeIcon();
        }
    });

    function renderList(state: AppState): void {
        const selected = state.job?.id ?? null;
        combining = combining.filter((id) => state.jobs.some((job) => job.id === id));
        if (iconFor !== null && !state.jobs.some((job) => job.id === iconFor)) {
            closeIcon();
        }
        replace(list, ...state.jobs.flatMap((job) => {
            const item = el("li", { class: job.id === selected ? "selected" : "" });
            const check = el("input", { type: "checkbox", class: "job-check", "aria-label": `combine ${job.name}`, title: "check two or more to combine" }) as HTMLInputElement;
            check.checked = combining.includes(job.id);
            check.addEventListener("change", () => {
                combining = check.checked ? [...combining.filter((id) => id !== job.id), job.id] : combining.filter((id) => id !== job.id);
                renderCombine();
            });
            // A small drawing of the job, or its own icon; a press opens the
            // icon picker. The drawing's address changes with what it
            // shows, so an unchanged job's is not asked for again.
            const thumb = el("button", { type: "button", class: "job-thumb-button", title: "set this job's icon", "aria-label": `Icon of ${job.name}`, "aria-expanded": String(iconFor === job.id) },
                jobPicture(job, ctx.api.jobThumbUrl(job)));
            thumb.addEventListener("click", () => {
                if (iconFor === job.id) {
                    closeIcon();
                } else {
                    iconFor = job.id;
                    releaseIcon ??= popUp({
                        nodes: () => [list.querySelector(".job-icon-row"), list.querySelector('.job-thumb-button[aria-expanded="true"]')],
                        close: closeIcon,
                    });
                    renderList(ctx.store.get());
                    // The list scrolls within its own height: the picker is brought into it.
                    list.querySelector(".job-icon-row")?.scrollIntoView?.({ block: "nearest" });
                }
            });
            const pick = el("button", { type: "button", class: "job-pick", title: "pick this job", onclick: () => void ctx.selectJob(job.id) },
                el("span", { class: "job-text" },
                    el("span", { class: "job-name" }, job.name),
                    el("span", { class: "muted" }, job.layer ? ` ${job.source} ${job.layer}` : ` ${job.source}`),
                    job.stats ? el("span", { class: "muted job-stat" }, ` ${formatLength(job.stats.length_mm)}, ${formatDuration(job.stats.seconds)}`) : null,
                ),
            );
            const remove = button("Delete", () => removeJob(job.id, job.name), "btn btn-quiet btn-small", "delete this job");
            item.append(check, thumb, pick, remove);
            if (iconFor !== job.id) {
                return [item];
            }
            return [item, el("li", { class: "job-icon-row" }, iconPicker(job, ctx, closeIcon))];
        }));
        if (state.jobs.length === 0) {
            list.append(el("li", { class: "muted" }, "no jobs yet"));
        }
        renderCombine();
    }

    function renderCombine(): void {
        setLocked(combineButton, combining.length < 2, "tick two or more jobs to combine");
        combineButton.textContent = combining.length >= 2 ? `Combine ${combining.length}` : "Combine";
    }

    async function combine(): Promise<void> {
        const jobs = combining.map((id) => ctx.store.get().jobs.find((job) => job.id === id)).filter((job): job is NonNullable<typeof job> => job !== undefined);
        if (jobs.length < 2) {
            return;
        }
        if (!(await askConfirm(`Combine ${jobs.map((job) => job.name).join(", then ")} into one job? The originals stay.`, "Combine"))) {
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
    const pickedLabel = el("input", { type: "text", class: "field", "aria-label": "New group name", placeholder: "new group name", spellcheck: "false" }) as HTMLInputElement;
    const pickedMove = button("Move", () => movePicked(), "btn btn-small");
    pickedMove.title = "move to the chosen group; a new one copies the first source group's settings, off if any source is off";
    const pickedDelete = button("Delete paths", () => deletePicked(), "btn btn-quiet btn-small", "delete the paths picked");
    const pickedClear = button("Clear", () => ctx.store.set({ selection: null }), "btn btn-quiet btn-small", "unpick the paths");
    const pickedArray = button("Array", () => toggleArray(), "btn btn-quiet btn-small btn-toggle");
    pickedArray.title = "copy the picked paths in a row or around a center";
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
    arrayAxis.title = "turn about the origin, the polar table's axis";
    const linearFields = el("div", { class: "field-row" }, labeled("Step x mm", arrayDx), labeled("Step y mm", arrayDy));
    const circularFields = el("div", { class: "field-row" }, labeled("Center x mm", arrayCx), labeled("Center y mm", arrayCy), arrayMiddle, arrayAxis, labeled("Sweep deg", arraySweep));
    circularFields.title = "360 spreads copies evenly; less ends at the sweep; positive is counterclockwise";
    const arrayNote = el("p", { class: "muted hint" });
    const arrayMake = button("Make array", () => makeArray(), "btn btn-primary btn-small", "add the copies to the job");
    const arrayCancel = button("Cancel", () => closeArray(), "btn btn-quiet btn-small", "close the array without copies");
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
        setLocked(arrayMake, refusal !== "", refusal);
        if (refusal) {
            arrayNote.textContent = refusal;
            ctx.store.set({ arrayDraft: null });
            return;
        }
        const made = arrayPaths(job, refs, spec);
        arrayNote.textContent = `${countText(made.refs.length, "copy", "copies")} of ${countText(refs.length, "path", "paths")}, shown on the preview; each joins its path's group`;
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
            ctx.toast("error", errorText(error));
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
        ctx.toast("info", `${countText(result.refs.length, "copy", "copies")} added to ${job.name}`);
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
        pickedCount.textContent = `${countText(refs.length, "path", "paths")} picked from ${countText(groups, "group", "groups")}`;
        const chosen = pickedTarget.value;
        const options = [
            el("option", { value: "new" }, "into a new group"),
            ...job.groups.map((group, g) => el("option", { value: String(g) }, `into ${group.label}`)),
        ];
        replace(pickedTarget, ...options);
        pickedTarget.value = options.some((option) => option.value === chosen) ? chosen : "new";
        pickedLabel.classList.toggle("hidden", pickedTarget.value !== "new");
        const refusal = regroupRefusal(job, refs, pickedTarget.value === "new" ? "new" : Number(pickedTarget.value));
        pickedMove.title = refusal || "move to the chosen group; a new one copies the first source group's settings, off if any source is off";
        setLocked(pickedMove, refusal !== "", refusal);
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
            ctx.toast("error", errorText(error));
            return;
        }
        const count = countText(refs.length, "path", "paths");
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
        ctx.toast("info", `${countText(result.refs.length, "path", "paths")} moved into ${into}`);
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
            ctx.toast("error", errorText(error));
            return;
        }
        const count = countText(refs.length, "path", "paths");
        if (!(await askConfirm(`Delete ${count} from ${job.name}? Emptied groups go too.${recipeLost(job, "bring them back")}`, "Delete paths"))) {
            return;
        }
        const kept = await ctx.call(ctx.api.replaceJob(job.id, { ...made, recipe: null }));
        if (!kept) {
            return;
        }
        ctx.store.set({ selection: null });
        await ctx.reloadJob(job.id);
        await ctx.refreshJobs();
        ctx.toast("info", `${count} deleted from ${job.name}`);
    }

    mountRun(runRoot, ctx);

    function renderDetails(state: AppState): void {
        const job = state.job;
        if (!job) {
            if (detailsFor !== null) {
                detailsFor = null;
                detailsJob = null;
                replace(details, el("p", { class: "muted" }, "select a job to see its groups"));
            }
            renderForm(state);
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
        renderForm(state);
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
                setUnlessFocused(row.focus, formatOptional(group.focus), focused);
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

    /** The parts of the Jobs panel that follow the selected job and the machine: Save, and the upload's labels. */
    function renderForm(state: AppState): void {
        setLocked(saveButton, !state.job, "pick a job first");
        const labels = jobLabels(isMilling(state.snapshot));
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
                focus.value = formatOptional(group.focus);
                focus.setAttribute("aria-label", "focus");
                focus.title = "mm above focus for this group, negative lowers; blank for none";
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
            const name = el("button", { type: "button", class: "group-pick", title: "pick this group's paths; shift adds" },
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
                el("th", { title: "mm of paste over each pad" }, "Paste mm"),
                el("th", { title: "Times the group runs" }, "Passes"),
                el("th", {}, "On"),
            ]
            : milling
            ? [
                el("th", { title: "Spindle speed" }, "S"),
                el("th", { title: "Depth of the last pass below the surface, mm" }, "Depth"),
                el("th", { title: "Feed along the cut" }, "mm/min"),
                el("th", { title: "Plunge feed, mm/min" }, "Plunge"),
                el("th", { title: "Passes to reach the depth" }, "Passes"),
                el("th", {}, "On"),
            ]
            : [
                el("th", {}, "S"),
                el("th", { title: "Least power in corners (dyn mode); 0 is none" }, "Min S"),
                el("th", {}, "mm/min"),
                el("th", { title: "Times the group runs" }, "Passes"),
                ...(focusColumn ? [el("th", { title: "mm above focus for the group; blank is none" }, "Focus")] : []),
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

    /** The turn the job has been given since import, by Turn and by alignment; read only here, as those are what change it. */
    function rotationText(job: Job): string {
        return `turned ${formatFixed(job.rotation ?? 0, 4)} deg`;
    }

    /** The bit's or the beam's width the job is cut for, and the button that makes it again for another. */
    function widthRow(job: Job, milling: boolean): HTMLElement {
        const mode = widthMode(job);
        const field = numberField({ value: job.spot, min: 0.001, step: 0.01, width: "5.5rem" });
        field.setAttribute("aria-label", milling ? "Tool width" : "Spot width");
        widthField = field;
        const apply = button(mode === "remake" ? "Re-cut" : "Set", () => applyWidth(), "btn btn-quiet", mode === "remake" ? "cut the job again with this value" : "set this value");
        const note = el("span", { class: "muted job-width-note" },
            mode === "remake" ? "re-cuts the paths where the job is now"
                : mode === "width" ? "paths stay as they are"
                    : "import again for another width");
        if (mode === "refused") {
            field.disabled = true;
            setLocked(apply, true, "nothing kept to re-cut from; import again with the new width");
        } else {
            apply.title = mode === "remake"
                ? "re-cut the paths for this width; group settings stay"
                : "sets the drawn width and probing margins; paths stay";
        }
        field.addEventListener("keydown", onEnter(apply));
        const applyWidth = async (): Promise<void> => {
            const width = parseNumber(field.value);
            if (width === null || !(width > 0)) {
                ctx.toast("error", "width: more than 0 mm");
                return;
            }
            // The row outlives a re-cut: the job as it is now decides.
            const current = ctx.store.get().job;
            if (!current || current.id !== job.id || width === current.spot) {
                return;
            }
            if (mode === "remake" && !(await askConfirm(`Re-cut ${job.name} for ${width} mm? Paths are remade where the job is now; group settings stay.`, "Re-cut"))) {
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
        apply.title = "re-cut with each opening shrunk this much per side; group settings stay";
        field.addEventListener("keydown", onEnter(apply));
        const applyMargin = async (): Promise<void> => {
            const value = parseNumber(field.value);
            if (value === null || !(value >= 0 && value <= MAX_MARGIN)) {
                ctx.toast("error", `margin: 0 to ${MAX_MARGIN} mm`);
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
            el("span", { class: "muted job-width-note" }, "each opening shrinks this much per side"),
        );
    }

    function offsetRow(job: Job): HTMLElement {
        const x = numberField({ value: job.offset.x, width: "5.5rem" });
        const y = numberField({ value: job.offset.y, width: "5.5rem" });
        const rotation = el("span", { class: "muted job-rotation", title: "Counterclockwise turn since import, by Turn and alignment" }, rotationText(job));
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
                ctx.toast("error", "turn: -360 to 360 degrees, not 0");
                return;
            }
            await ctx.call(ctx.api.patchJob(job.id, { turn: sign * degrees, about: about.value === "origin" ? "origin" : "center" }));
            await ctx.reloadJob(job.id);
            await ctx.refreshJobs();
        };
        const fixed = job.groups.some((group) => (group.joints?.length ?? 0) > 0);
        const ccw = button("Turn left", () => turn(1), "btn btn-quiet");
        ccw.title = "Turn counterclockwise by the angle";
        const cw = button("Turn right", () => turn(-1), "btn btn-quiet");
        cw.title = "Turn clockwise by the angle";
        // A joint-space group is written about the axis: nothing to turn.
        setLocked(ccw, fixed, "joint-space groups do not turn");
        setLocked(cw, fixed, "joint-space groups do not turn");
        angle.disabled = fixed;
        about.disabled = fixed;
        return el("div", { class: "goto-row" },
            el("span", { class: "choice-label" }, "Offset"),
            x, y,
            button("Move", () => apply(), "btn btn-quiet", "move the paths picked"),
            el("span", { class: "choice-label" }, "Turn"),
            angle, about, ccw, cw,
            rotation,
        );
    }
}
