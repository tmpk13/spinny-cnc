// The CAM page: a profile picked from cam/, its axes, tools and operations
// with every cutting setting (edited in place, the file keeping its
// comments), the file's text to edit whole, a design made into a job through
// the profile, and a job written out as gcode for the profile's controller.

import { errorText } from "../api.ts";
import { askConfirm } from "../confirm.ts";
import { button, downloadText, el, fileDrop, labeled, numberField, readStored, replace, setLocked, writeStored } from "../dom.ts";
import { countText, formatDuration, formatLength, formatOptional, parseNumber } from "../format.ts";
import { setPending, type AppState } from "../state.ts";
import type {
    CamGcodeReport,
    CamOperation,
    CamPath,
    CamProfile,
    CamProfileResponse,
    CamSummary,
    CamTool,
    CamValue,
    Tool,
} from "../types.ts";
import { GCODE_SUFFIXES, GERBER_SUFFIXES } from "../uploads.ts";
import type { Ctx } from "./context.ts";
import { codeEditor } from "./editor.ts";
import { showPage } from "./tabs.ts";

/** Every design the CAM reads: a drawing (SVG or DXF), a job, a board (its layers' gerbers and drill files, or the KiCad file), gcode or a model. */
export const ACCEPT = [".svg", ".dxf", ".json", ...GERBER_SUFFIXES, ".drl", ".kicad_pcb", ...GCODE_SUFFIXES, ".stl"].join(",");

export interface NumberSpec {
    key: string;
    label: string;
    step: number;
    min?: number;
}

/** The cutting settings of a spindle operation, in the order shown. */
export const SPINDLE_FIELDS: NumberSpec[] = [
    { key: "depth", label: "Depth mm", step: 0.01, min: 0 },
    { key: "step_down", label: "Step down mm", step: 0.1, min: 0 },
    { key: "feed", label: "Feed mm/min", step: 10, min: 0 },
    { key: "plunge", label: "Plunge mm/min", step: 5, min: 0 },
    { key: "rpm", label: "Spindle S", step: 100, min: 0 },
    { key: "stepover", label: "Stepover", step: 0.05, min: 0 },
];

/** The cutting settings of a model's operation: rough, waterline or parallel. */
export const MODEL_FIELDS: NumberSpec[] = [
    { key: "step_down", label: "Step down mm", step: 0.1, min: 0 },
    { key: "stepover", label: "Stepover", step: 0.05, min: 0 },
    { key: "leave", label: "Leave mm", step: 0.05, min: 0 },
    { key: "leave_floor", label: "Leave floor mm", step: 0.05, min: 0 },
    { key: "ramp", label: "Ramp deg", step: 1, min: 0 },
    { key: "below", label: "Below mm", step: 0.1 },
    { key: "feed", label: "Feed mm/min", step: 10, min: 0 },
    { key: "plunge", label: "Plunge mm/min", step: 5, min: 0 },
    { key: "rpm", label: "Spindle S", step: 100, min: 0 },
];

/** The model's sources; their cutting settings are MODEL_FIELDS. */
export const MODEL_SOURCES = ["rough", "waterline", "parallel"];

/** How a model may be stood up: [X, Y, Z] degrees turned before it is cut. */
export const TURNS: { label: string; turn: [number, number, number] }[] = [
    { label: "as drawn", turn: [0, 0, 0] },
    { label: "upside down", turn: [180, 0, 0] },
    { label: "front down", turn: [90, 0, 0] },
    { label: "back down", turn: [-90, 0, 0] },
    { label: "left side down", turn: [0, 90, 0] },
    { label: "right side down", turn: [0, -90, 0] },
];

/** The cutting settings of a laser operation. */
export const LASER_FIELDS: NumberSpec[] = [
    { key: "power", label: "Power S", step: 10, min: 0 },
    { key: "min_power", label: "Floor S", step: 10, min: 0 },
    { key: "speed", label: "Speed mm/min", step: 10, min: 0 },
    { key: "passes", label: "Passes", step: 1, min: 1 },
    { key: "height", label: "Height mm", step: 0.1 },
];

export interface SourceSpec {
    key: string;
    label: string;
    choices?: string[];
    text?: boolean;
    /** A switch: true or false. */
    flag?: boolean;
    /** Any number, not a count: degrees. */
    number?: boolean;
}

/** What an operation of each source says about its geometry. */
export function sourceFields(source: string, toolKind: Tool): SourceSpec[] {
    switch (source) {
        case "isolation":
            return [{ key: "loops", label: "Loops" }];
        case "clearing":
            return [{ key: "pattern", label: "Pattern", choices: ["radial", "rings", "lines"] }];
        case "deposit":
            return [{ key: "loops", label: "Loops" }, { key: "fill", label: "Fill", choices: ["contour", "radial", "rings", "lines"] }];
        case "drills":
            return toolKind === "laser" ? [{ key: "marks", label: "Marks", choices: ["circle", "cross", "dot"] }] : [];
        case "paths":
            return [{ key: "match", label: "Match label", text: true }];
        case "rough":
        case "waterline":
            return [
                { key: "direction", label: "Direction", choices: ["climb", "conventional"] },
                { key: "flats", label: "Levels at flats", flag: true },
            ];
        case "parallel":
            return [{ key: "angle", label: "Lines deg", number: true }];
        default:
            return [];
    }
}

/** What a model's operation does with its settings, in words. */
export function modelPassText(source: string, cutting: Record<string, number>, diameter: number): string {
    const step = cutting["step_down"] ?? 0;
    if (source === "parallel") {
        return `lines ${Number(((cutting["stepover"] ?? 0.1) * diameter).toFixed(3))} mm apart`;
    }
    const levels = step > 0 ? `a level every ${step} mm` : "levels at the flats and the bottom";
    const leave = cutting["leave"] ?? 0;
    return leave > 0 ? `${levels}, ${leave} mm left` : levels;
}

/** A tool's settings on one line, a mill's end first. */
export function describeTool(tool: CamTool): string {
    const names: Record<string, string> = {
        rpm: "S", feed: "feed", plunge: "plunge", step_down: "step down", stepover: "stepover", depth: "depth",
        power: "S", min_power: "floor", speed: "speed", passes: "passes", height: "height",
    };
    const end: string[] = [];
    if (tool.kind === "spindle" && tool.shape) {
        end.push(tool.shape === "bull" ? `bull nose r${tool.corner ?? 0}` : tool.shape === "vee" ? `${tool.angle ?? ""} degree V` : tool.shape);
        end.push(`${tool.flutes ?? 2} flutes`);
        if (tool.length !== undefined) {
            end.push(`reaches ${tool.length} mm`);
        }
    }
    return [...end, ...Object.entries(tool.settings).map(([key, value]) => `${names[key] ?? key} ${value}`)].join(", ");
}

/** The lines a gcode report reads as. */
export function reportLines(report: CamGcodeReport): [string, string][] {
    const lines: [string, string][] = [
        ["Lines", String(report.lines)],
        ["Cuts", `${report.cuts}, ${formatLength(report.length_mm)}`],
        ["Time", formatDuration(report.seconds)],
    ];
    for (const [letter, [low, high]] of Object.entries(report.extents)) {
        lines.push([`${letter} reach`, `${low} to ${high}`]);
    }
    return lines;
}

// The profile last picked is a per-browser convenience, like the tab.
const PICK_KEY = "spinny.cam.profile";

/** The CAM panel in `root`, and the profile's file to edit whole in `fileRoot`. */
export function mountCam(root: HTMLElement, ctx: Ctx, fileRoot: HTMLElement): void {
    // --- the profile ---
    const pick = el("select", { class: "field", "aria-label": "CAM profile" });
    const newId = el("input", { type: "text", class: "field", placeholder: "new id", "aria-label": "New profile id", autocomplete: "off" });
    newId.style.width = "8rem";
    const create = button("New", () => createProfile(), "btn");
    const remove = button("Delete", () => removeProfile(), "btn btn-quiet");
    const reload = button("Reload", () => refresh(), "btn btn-quiet btn-small");
    const summary = el("p", { class: "muted cam-summary" });
    const problems = el("ul", { class: "cam-problems hidden" });
    const axesBox = el("div", { class: "groups-scroll" });
    const toolsBox = el("div", { class: "groups-scroll" });
    const opsBox = el("div", { class: "groups-scroll" });
    const stockBox = el("div", { class: "cam-stock" });
    const stockSection = el("div", { class: "cam-section hidden" }, el("h3", {}, "Stock"), stockBox);

    // --- a job from a design ---
    const fileInput = el("input", { type: "file", accept: ACCEPT, multiple: true, class: "file-input", "aria-label": "Design files" });
    const nameField = el("input", { type: "text", class: "field", placeholder: "job name (default: file name)", "aria-label": "Job name", autocomplete: "off" });
    const drop = el("div", { class: "drop" },
        el("p", {}, "Drop a board (with outline and drill files), SVG, DXF, gcode, JSON or STL here, or"),
        el("label", { class: "btn btn-quiet" }, "pick files", fileInput),
    );
    const notes = el("ul", { class: "cam-notes muted hidden" });
    const open = button("Show in Jobs", () => showPage("jobs"), "btn btn-quiet btn-small");

    // --- gcode ---
    const jobPick = el("select", { class: "field", "aria-label": "Job to write" });
    const exportButton = button("Export gcode", () => exportGcode(), "btn btn-primary");
    const reportBox = el("div", { class: "cam-report" });

    root.append(
        el("div", { class: "panel-head" }, el("h2", {}, "CAM"), el("div", { class: "button-row" }, reload)),
        el("div", { class: "button-row" }, labeled("Profile", pick, "labeled inline"), newId, create, remove),
        summary,
        problems,
        el("div", { class: "cam-section" }, el("h3", {}, "Axes"), axesBox),
        el("div", { class: "cam-section" }, el("h3", {}, "Tools"), toolsBox),
        stockSection,
        el("div", { class: "cam-section" }, el("h3", {}, "Operations"), opsBox),
        el("div", { class: "cam-section" },
            el("h3", {}, "Make a job"),
            drop,
            el("div", { class: "button-row" }, labeled("Name", nameField, "labeled inline"), open),
            notes,
        ),
        el("div", { class: "cam-section" },
            el("h3", {}, "Gcode"),
            el("div", { class: "button-row" }, labeled("Job", jobPick, "labeled inline"), exportButton),
            reportBox,
        ),
    );

    // --- the file ---
    const fileEditor = codeEditor("Profile file");
    const save = button("Save", () => saveText(), "btn btn-primary");
    const revert = button("Revert", () => revertText(), "btn btn-quiet");
    const fileStatus = el("span", { class: "muted cam-status" });
    const editor = el("div", { class: "panel-body" },
        el("div", { class: "button-row" }, save, revert, fileStatus),
        fileEditor.root,
        el("p", { class: "muted hint" }, "the whole profile; Save checks it and refuses a file that does not parse"),
    );
    fileRoot.append(el("div", { class: "panel-head" }, el("h2", {}, "Profile file")), editor);

    let files: CamSummary[] = [];
    let shown: CamProfileResponse | null = null;
    let picked: string | null = readStored(PICK_KEY);
    let dirty = false;
    // An edit not saved is counted on the page's tab.
    const setDirty = (value: boolean): void => {
        dirty = value;
        setPending(ctx.store, "cam-profile", value ? 1 : 0);
    };
    let lastJob: string | null = null;

    fileEditor.onInput((problem) => {
        setDirty(true);
        setStatus(problem ?? "edited, not saved", problem !== null);
    });
    pick.addEventListener("change", () => {
        picked = pick.value;
        writeStored(PICK_KEY, picked);
        void load(picked);
    });

    function setStatus(text: string, error: boolean): void {
        fileStatus.textContent = text;
        fileStatus.classList.toggle("error", error);
    }

    function lockAll(): void {
        const none = picked === null || shown === null;
        for (const node of [remove, exportButton, save, revert]) {
            setLocked(node, none, "pick a profile first");
        }
        fileInput.disabled = none;
    }

    async function refresh(): Promise<void> {
        const listed = await ctx.call(ctx.api.camProfiles());
        if (!listed) {
            return;
        }
        files = listed.profiles;
        replace(problems, ...listed.problems.map((problem) => el("li", {}, problem)));
        problems.classList.toggle("hidden", listed.problems.length === 0);
        if (picked === null || !files.some((file) => file.id === picked)) {
            picked = files[0]?.id ?? null;
        }
        if (picked !== null) {
            writeStored(PICK_KEY, picked);
        }
        renderPick();
        if (picked !== null) {
            await load(picked);
        } else {
            shown = null;
            renderProfile();
        }
    }

    function renderPick(): void {
        replace(pick, ...files.map((file) => el("option", { value: file.id }, file.name)));
        if (files.length === 0) {
            pick.append(el("option", { value: "", disabled: true }, "no profiles"));
        }
        pick.value = picked ?? "";
    }

    async function load(id: string): Promise<void> {
        const response = await ctx.call(ctx.api.camProfile(id));
        if (response && picked === id) {
            setDirty(false);
            show(response);
        }
    }

    function show(response: CamProfileResponse): void {
        shown = response;
        renderProfile();
        if (!dirty) {
            fileEditor.setText(response.text);
            setStatus("", false);
        }
    }

    function renderProfile(): void {
        lockAll();
        const profile = shown?.document ?? null;
        if (!profile) {
            summary.textContent = files.length === 0 ? "no profiles in cam/; add a TOML file there or save one here" : "";
            replace(axesBox);
            replace(toolsBox);
            replace(opsBox);
            replace(stockBox);
            stockSection.classList.add("hidden");
            return;
        }
        const parts = [profile.description, profile.kinematics, profile.machine ? `runs on ${profile.machine}` : "gcode only"];
        summary.textContent = parts.filter((part) => part !== "").join(" | ");
        replace(axesBox, axesTable(profile));
        replace(toolsBox, toolsTable(profile));
        replace(opsBox, operationsTable(profile));
        const model = profile.model === true || (profile.materials?.length ?? 0) > 0;
        stockSection.classList.toggle("hidden", !model);
        if (model) {
            replace(stockBox, ...stockFields(profile));
        } else {
            replace(stockBox);
        }
    }

    /** The block a model is cut from and how the model stands in it, each value patched into the file on its own. */
    function stockFields(profile: CamProfile): HTMLElement[] {
        const stock = profile.stock ?? { material: null, margin: 2, top: 0, size: null };
        const materials = profile.materials ?? [];
        const material = el("select", { class: "field", "aria-label": "Stock material" },
            el("option", { value: "" }, "none (tool feeds)"),
            ...materials.map((candidate) => el("option", { value: candidate.id }, candidate.name)),
        );
        material.value = stock.material ?? "";
        material.addEventListener("change", () => void patch(["stock", "material"], material.value === "" ? null : material.value));
        const margin = numberField({ value: stock.margin, step: 0.5, min: 0 });
        margin.setAttribute("aria-label", "Stock margin mm");
        margin.addEventListener("change", () => void patch(["stock", "margin"], parseNumber(margin.value)));
        const top = numberField({ value: stock.top, step: 0.1, min: 0 });
        top.setAttribute("aria-label", "Stock over the top mm");
        top.addEventListener("change", () => void patch(["stock", "top"], parseNumber(top.value)));
        const turn = el("select", { class: "field", "aria-label": "Model turned" },
            ...TURNS.map((choice, index) => el("option", { value: String(index) }, choice.label)),
        );
        const now = profile.model_setup?.turn ?? [0, 0, 0];
        const known = TURNS.findIndex((choice) => choice.turn.every((value, k) => value === now[k]));
        if (known < 0) {
            turn.append(el("option", { value: "file" }, `from the file: ${now.join(", ")}`));
        }
        turn.value = known < 0 ? "file" : String(known);
        turn.addEventListener("change", () => {
            const choice = TURNS[Number(turn.value)];
            if (choice) {
                void patch(["model", "turn"], choice.turn);
            }
        });
        if (stock.size) {
            for (const field of [margin, top]) {
                field.disabled = true;
                field.title = "set by the file's block size";
            }
        }
        const chosen = materials.find((candidate) => candidate.id === stock.material);
        const note = el("p", { class: "muted hint" }, chosen?.note ? `${chosen.name}: ${chosen.note}` : "");
        const size = stock.size ? el("p", { class: "muted hint" }, `block ${stock.size.join(" x ")} mm, model centered on the bottom`) : null;
        return [
            el("div", { class: "button-row" },
                labeled("Material", material, "labeled inline"),
                labeled("Margin mm", margin, "labeled inline"),
                labeled("Over the top mm", top, "labeled inline"),
                labeled("Model", turn, "labeled inline"),
            ),
            ...(size ? [size] : []),
            note,
        ];
    }

    function axesTable(profile: CamProfile): HTMLElement {
        const head = el("tr", {}, ...["Axis", "Kind", "Role", "Travel", "Feed", "Rapid", "Offset", "Safe / park", "Home"].map((text) => el("th", {}, text)));
        const rows = profile.axes.map((axis) => el("tr", {},
            el("td", { class: "cam-op-name" }, axis.letter),
            el("td", {}, axis.kind),
            el("td", {}, axis.role),
            el("td", { class: "num" }, axis.min === null && axis.max === null ? "" : `${formatOptional(axis.min)} to ${formatOptional(axis.max)}`),
            el("td", { class: "num" }, formatOptional(axis.rate)),
            el("td", { class: "num" }, formatOptional(axis.rapid)),
            el("td", { class: "num" }, formatOptional(axis.offset)),
            el("td", { class: "num" }, axis.role === "depth" ? formatOptional(axis.safe) : formatOptional(axis.park)),
            el("td", { class: "num" }, formatOptional(axis.home)),
        ));
        return el("table", { class: "cam-table axes" }, el("thead", {}, head), el("tbody", {}, ...rows));
    }

    function toolsTable(profile: CamProfile): HTMLElement {
        const head = el("tr", {}, ...["Tool", "Kind", "Width mm", "Settings"].map((text) => el("th", {}, text)));
        const rows = profile.tools.map((tool) => el("tr", {},
            el("td", {}, el("span", { class: "cam-op-name" }, tool.name), el("span", { class: "muted" }, ` ${tool.id}`)),
            el("td", {}, tool.kind === "spindle" ? "mill" : "laser"),
            el("td", { class: "num" }, String(Number(tool.width.toFixed(3)))),
            el("td", {}, describeTool(tool)),
        ));
        return el("table", { class: "cam-table tools" }, el("thead", {}, head), el("tbody", {}, ...rows));
    }

    function operationsTable(profile: CamProfile): HTMLElement {
        const head = el("tr", {}, ...["On", "Operation", "Tool", "Cutting settings", "Passes"].map((text) => el("th", {}, text)));
        const bodies = profile.operations.map((operation, index) => operationRow(profile, operation, index));
        return el("table", { class: "cam-table operations" }, el("thead", {}, head), ...bodies);
    }

    function operationRow(profile: CamProfile, operation: CamOperation, index: number): HTMLElement {
        const tool = profile.tools.find((candidate) => candidate.id === operation.tool);
        const kind: Tool = tool?.kind ?? "laser";
        const enabled = el("input", { type: "checkbox", "aria-label": `${operation.name} enabled` });
        enabled.checked = operation.enabled;
        enabled.addEventListener("change", () => void patch(["operations", index, "enabled"], enabled.checked));
        const toolPick = el("select", { class: "field", "aria-label": `${operation.name} tool` },
            ...profile.tools.map((candidate) => el("option", { value: candidate.id }, candidate.name)),
        );
        toolPick.value = operation.tool;
        toolPick.addEventListener("change", () => void patch(["operations", index, "tool"], toolPick.value));
        const fields = el("div", { class: "cam-fields" });
        const model = MODEL_SOURCES.includes(operation.source);
        for (const spec of kind === "spindle" ? (model ? MODEL_FIELDS : SPINDLE_FIELDS) : LASER_FIELDS) {
            const own = operation.settings[spec.key];
            const value = typeof own === "number" ? own : operation.cutting[spec.key] ?? null;
            const input = numberField({ value, step: spec.step, min: spec.min });
            input.setAttribute("aria-label", `${operation.name} ${spec.label}`);
            if (typeof own !== "number") {
                input.classList.add("inherited");
                input.title = "blank uses the tool's value";
            }
            input.addEventListener("change", () => {
                const typed = parseNumber(input.value);
                void patch(["operations", index, spec.key], input.value.trim() === "" ? null : typed);
            });
            fields.append(labeled(spec.label, input));
        }
        for (const spec of sourceFields(operation.source, kind)) {
            const own = operation.settings[spec.key];
            if (spec.choices) {
                const select = el("select", { class: "field", "aria-label": `${operation.name} ${spec.label}` },
                    ...spec.choices.map((choice) => el("option", { value: choice }, choice)),
                );
                select.value = typeof own === "string" ? own : spec.choices[0]!;
                select.addEventListener("change", () => void patch(["operations", index, spec.key], select.value));
                fields.append(labeled(spec.label, select));
            } else if (spec.flag) {
                const box = el("input", { type: "checkbox", "aria-label": `${operation.name} ${spec.label}` });
                box.checked = typeof own === "boolean" ? own : true;
                box.addEventListener("change", () => void patch(["operations", index, spec.key], box.checked));
                fields.append(labeled(spec.label, box));
            } else if (spec.number) {
                const input = numberField({ value: typeof own === "number" ? own : 0, step: 1 });
                input.setAttribute("aria-label", `${operation.name} ${spec.label}`);
                input.addEventListener("change", () => {
                    const typed = parseNumber(input.value);
                    void patch(["operations", index, spec.key], input.value.trim() === "" ? null : typed);
                });
                fields.append(labeled(spec.label, input));
            } else if (spec.text) {
                const input = el("input", { type: "text", class: "field", "aria-label": `${operation.name} ${spec.label}`, autocomplete: "off" });
                input.value = typeof own === "string" ? own : "";
                input.addEventListener("change", () => void patch(["operations", index, spec.key], input.value));
                fields.append(labeled(spec.label, input));
            } else {
                const input = numberField({ value: typeof own === "number" ? own : 1, step: 1, min: 1 });
                input.setAttribute("aria-label", `${operation.name} ${spec.label}`);
                input.addEventListener("change", () => {
                    const typed = parseNumber(input.value);
                    void patch(["operations", index, spec.key], typed === null ? null : Math.round(typed));
                });
                fields.append(labeled(spec.label, input));
            }
        }
        const passes = operation.cutting["passes"] ?? 1;
        const diameter = tool ? (tool.angle !== undefined && tool.shank !== undefined ? tool.shank : tool.width) : 0;
        const passText = model
            ? modelPassText(operation.source, operation.cutting, diameter)
            : kind === "spindle"
                ? `${countText(passes, "pass", "passes")} to ${operation.cutting["depth"] ?? 0} mm`
                : countText(passes, "pass", "passes");
        return el("tbody", { class: operation.enabled ? "" : "disabled" },
            el("tr", {},
                el("td", {}, enabled),
                el("td", {}, el("div", { class: "cam-op-name" }, operation.name), el("div", { class: "muted" }, operation.source)),
                el("td", {}, toolPick),
                el("td", {}, fields),
                el("td", { class: "cam-passes muted" }, passText),
            ),
            // Where a material put the speed and the feed, under the row.
            ...(operation.feeds ? [el("tr", { class: "cam-feeds" }, el("td", {}), el("td", { colspan: "4", class: "muted" }, operation.feeds))] : []),
        );
    }

    async function patch(path: CamPath, value: CamValue): Promise<void> {
        if (picked === null) {
            return;
        }
        const id = picked;
        const response = await ctx.call(ctx.api.patchCamProfile(id, path, value));
        if (response && picked === id) {
            // The file changed under the editor: a text being edited keeps
            // its edits, and is told it is behind.
            show(response);
            if (dirty) {
                setStatus("changed in the table; Revert restores the saved file", false);
            }
        } else if (picked === id && shown) {
            renderProfile();
        }
    }

    async function saveText(): Promise<void> {
        if (picked === null) {
            return;
        }
        const id = picked;
        try {
            const response = await ctx.api.saveCamProfile(id, fileEditor.getText());
            if (picked === id) {
                setDirty(false);
                show(response);
                setStatus("saved", false);
            }
            await refreshList();
        } catch (error) {
            setStatus(errorText(error), true);
        }
    }

    function revertText(): void {
        if (shown) {
            fileEditor.setText(shown.text);
            setDirty(false);
            setStatus("", false);
        }
    }

    /** The list again, the pick kept, after a save or a delete changed what there is. */
    async function refreshList(): Promise<void> {
        const listed = await ctx.call(ctx.api.camProfiles());
        if (listed) {
            files = listed.profiles;
            renderPick();
        }
    }

    async function createProfile(): Promise<void> {
        const id = newId.value.trim();
        if (id === "") {
            ctx.toast("error", "type an id for the new profile: letters, digits, - and _");
            return;
        }
        const typed = fileEditor.getText();
        const text = typed.trim() === "" ? `name = ${JSON.stringify(id)}\n` : typed;
        try {
            const response = await ctx.api.saveCamProfile(id, text);
            newId.value = "";
            picked = id;
            writeStored(PICK_KEY, id);
            setDirty(false);
            await refreshList();
            show(response);
            ctx.toast("info", `saved cam/${id}.toml`);
        } catch (error) {
            ctx.toast("error", errorText(error));
        }
    }

    async function removeProfile(): Promise<void> {
        if (picked === null) {
            return;
        }
        const id = picked;
        const name = shown?.document.name ?? id;
        if (!(await askConfirm(`Delete profile ${name} (cam/${id}.toml)?`, "Delete"))) {
            return;
        }
        const done = await ctx.call(ctx.api.deleteCamProfile(id).then(() => true));
        if (!done) {
            return;
        }
        picked = null;
        setDirty(false);
        await refresh();
    }

    // --- making a job ---
    // The design dropped or picked is made a job through the profile
    // picked; with none picked the zone takes nothing.
    async function makeJob(files: File[]): Promise<void> {
        if (picked === null) {
            return;
        }
        const answer = await ctx.call(ctx.api.camJob(picked, files, nameField.value.trim() || undefined));
        await ctx.refreshJobs();
        if (answer) {
            lastJob = answer.job.id;
            await ctx.selectJob(answer.job.id);
            renderJobs(ctx.store.get());
            replace(notes, ...answer.notes.map((note) => el("li", {}, note)));
            notes.classList.toggle("hidden", answer.notes.length === 0);
            ctx.toast("info", `made ${answer.job.name}: ${answer.job.groups.filter((g) => g.enabled && (g.paths.length > 0 || (g.moves?.length ?? 0) > 0)).length} operations`);
        }
    }
    fileDrop(drop, fileInput, makeJob, () => picked !== null);

    // --- gcode ---
    function renderJobs(state: AppState): void {
        const current = jobPick.value;
        replace(jobPick, ...state.jobs.map((job) => el("option", { value: job.id }, `${job.name} (${job.source})`)));
        if (state.jobs.length === 0) {
            jobPick.append(el("option", { value: "", disabled: true }, "no jobs yet"));
        }
        const want = [lastJob, current, state.job?.id ?? null].find((id) => id !== null && id !== "" && state.jobs.some((job) => job.id === id));
        jobPick.value = want ?? state.jobs[0]?.id ?? "";
    }
    ctx.store.subscribe(renderJobs, ["jobs", "job"]);
    renderJobs(ctx.store.get());

    async function exportGcode(): Promise<void> {
        if (picked === null || jobPick.value === "") {
            ctx.toast("error", "make or pick a job first");
            return;
        }
        const written = await ctx.call(ctx.api.camGcode(picked, jobPick.value));
        if (!written) {
            return;
        }
        replace(reportBox,
            el("dl", {}, ...reportLines(written.report).flatMap(([term, value]) => [el("dt", {}, term), el("dd", {}, value)])),
            ...written.report.warnings.map((warning) => el("p", { class: "warning" }, warning)),
        );
        if (downloadText(written.filename, written.text)) {
            ctx.toast("info", `saved ${written.filename}`);
        } else {
            ctx.toast("info", `${written.filename} made, but this browser cannot save it`);
        }
    }

    lockAll();
    void refresh();
}
