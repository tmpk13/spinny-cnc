// The CAM page: a profile picked from cam/, its axes, tools and operations
// with every cutting setting (edited in place, the file keeping its
// comments), the file's text to edit whole, a design made into a job through
// the profile, and a job written out as gcode for the profile's controller.

import { askConfirm } from "../confirm.ts";
import { button, el, labeled, numberField, replace, setLocked } from "../dom.ts";
import { formatDuration, formatLength, parseNumber } from "../format.ts";
import type { AppState } from "../state.ts";
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
import type { Ctx } from "./context.ts";
import { showPage } from "./tabs.ts";

export const ACCEPT = ".svg,.json,.gbr,.gtl,.gbl,.gm1,.drl,.kicad_pcb,.gcode,.nc";

export interface NumberSpec {
    key: string;
    label: string;
    step: number;
    min?: number;
}

/** The cutting settings of a spindle operation, in the order shown. */
export const SPINDLE_FIELDS: NumberSpec[] = [
    { key: "depth", label: "Depth mm", step: 0.05, min: 0 },
    { key: "step_down", label: "Step down mm", step: 0.1, min: 0 },
    { key: "feed", label: "Feed mm/min", step: 10, min: 0 },
    { key: "plunge", label: "Plunge mm/min", step: 5, min: 0 },
    { key: "rpm", label: "Spindle S", step: 100, min: 0 },
    { key: "stepover", label: "Stepover", step: 0.05, min: 0 },
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
        default:
            return [];
    }
}

/** A tool's settings on one line. */
export function describeTool(tool: CamTool): string {
    const names: Record<string, string> = {
        rpm: "S", feed: "feed", plunge: "plunge", step_down: "step down", stepover: "stepover", depth: "depth",
        power: "S", min_power: "floor", speed: "speed", passes: "passes", height: "height",
    };
    return Object.entries(tool.settings)
        .map(([key, value]) => `${names[key] ?? key} ${value}`)
        .join(", ");
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

function readPick(): string | null {
    try {
        return globalThis.localStorage?.getItem(PICK_KEY) ?? null;
    } catch {
        return null;
    }
}

function writePick(id: string): void {
    try {
        globalThis.localStorage?.setItem(PICK_KEY, id);
    } catch {
        // Not remembered; the pick still holds for the page.
    }
}

function fmt(value: number | null): string {
    return value === null ? "" : String(value);
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function mountCam(root: HTMLElement, ctx: Ctx, fileRoot?: HTMLElement): void {
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

    // --- a job from a design ---
    const fileInput = el("input", { type: "file", accept: ACCEPT, multiple: true, class: "file-input", "aria-label": "Design files" });
    const nameField = el("input", { type: "text", class: "field", placeholder: "job name (the file's)", "aria-label": "Job name", autocomplete: "off" });
    const drop = el("div", { class: "drop" },
        el("p", {}, "Drop a design here (a board with its outline and drill file, svg, gcode, json) or"),
        el("label", { class: "btn btn-quiet" }, "pick files", fileInput),
    );
    const notes = el("ul", { class: "cam-notes muted hidden" });
    const open = button("Show in Jobs", () => showPage("machine"), "btn btn-quiet btn-small");

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
    const textArea = el("textarea", { class: "field cam-text", spellcheck: "false", "aria-label": "Profile file" });
    const save = button("Save", () => saveText(), "btn btn-primary");
    const revert = button("Revert", () => revertText(), "btn btn-quiet");
    const fileStatus = el("span", { class: "muted cam-status" });
    const editor = el("div", { class: "panel-body" },
        el("div", { class: "button-row" }, save, revert, fileStatus),
        textArea,
        el("p", { class: "muted hint" }, "the file is the profile: every axis, tool and operation is here, with a comment on each key; Save checks it whole and keeps nothing of a text that does not read"),
    );
    (fileRoot ?? root).append(el("div", { class: "panel-head" }, el("h2", {}, "Profile file")), editor);

    let files: CamSummary[] = [];
    let shown: CamProfileResponse | null = null;
    let picked: string | null = readPick();
    let dirty = false;
    let lastJob: string | null = null;

    textArea.addEventListener("input", () => {
        dirty = true;
        setStatus("edited, not saved", false);
    });
    pick.addEventListener("change", () => {
        picked = pick.value;
        writePick(picked);
        void load(picked);
    });

    function setStatus(text: string, error: boolean): void {
        fileStatus.textContent = text;
        fileStatus.classList.toggle("error", error);
    }

    function lockAll(): void {
        const none = picked === null || shown === null;
        for (const node of [remove, exportButton, save, revert]) {
            setLocked(node, none);
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
            writePick(picked);
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
            dirty = false;
            show(response);
        }
    }

    function show(response: CamProfileResponse): void {
        shown = response;
        renderProfile();
        if (!dirty) {
            textArea.value = response.text;
            setStatus("", false);
        }
    }

    function renderProfile(): void {
        lockAll();
        const profile = shown?.document ?? null;
        if (!profile) {
            summary.textContent = files.length === 0 ? "no profiles in cam/; drop a TOML file there, or save one here" : "";
            replace(axesBox);
            replace(toolsBox);
            replace(opsBox);
            return;
        }
        const parts = [profile.description, profile.kinematics, profile.machine ? `runs on the ${profile.machine} machine file` : "gcode only"];
        summary.textContent = parts.filter((part) => part !== "").join(" | ");
        replace(axesBox, axesTable(profile));
        replace(toolsBox, toolsTable(profile));
        replace(opsBox, operationsTable(profile));
    }

    function axesTable(profile: CamProfile): HTMLElement {
        const head = el("tr", {}, ...["Axis", "Kind", "Role", "Travel", "Feed", "Rapid", "Offset", "Safe / park", "Home"].map((text) => el("th", {}, text)));
        const rows = profile.axes.map((axis) => el("tr", {},
            el("td", { class: "cam-op-name" }, axis.letter),
            el("td", {}, axis.kind),
            el("td", {}, axis.role),
            el("td", { class: "num" }, axis.min === null && axis.max === null ? "" : `${fmt(axis.min)} to ${fmt(axis.max)}`),
            el("td", { class: "num" }, fmt(axis.rate)),
            el("td", { class: "num" }, fmt(axis.rapid)),
            el("td", { class: "num" }, fmt(axis.offset)),
            el("td", { class: "num" }, axis.role === "depth" ? fmt(axis.safe) : fmt(axis.park)),
            el("td", { class: "num" }, fmt(axis.home)),
        ));
        return el("table", { class: "cam-table axes" }, el("thead", {}, head), el("tbody", {}, ...rows));
    }

    function toolsTable(profile: CamProfile): HTMLElement {
        const head = el("tr", {}, ...["Tool", "Kind", "Width mm", "Settings"].map((text) => el("th", {}, text)));
        const rows = profile.tools.map((tool) => el("tr", {},
            el("td", {}, el("span", { class: "cam-op-name" }, tool.name), el("span", { class: "muted" }, ` ${tool.id}`)),
            el("td", {}, tool.kind === "spindle" ? "mill" : "laser"),
            el("td", { class: "num" }, String(tool.width)),
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
        for (const spec of kind === "spindle" ? SPINDLE_FIELDS : LASER_FIELDS) {
            const own = operation.settings[spec.key];
            const value = typeof own === "number" ? own : operation.cutting[spec.key] ?? null;
            const input = numberField({ value, step: spec.step, min: spec.min });
            input.setAttribute("aria-label", `${operation.name} ${spec.label}`);
            if (typeof own !== "number") {
                input.classList.add("inherited");
                input.title = "from the tool; a value typed here is the operation's own, cleared it is the tool's again";
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
        const passText = kind === "spindle"
            ? `${passes} ${passes === 1 ? "pass" : "passes"} to ${operation.cutting["depth"] ?? 0} mm`
            : `${passes} ${passes === 1 ? "pass" : "passes"}`;
        return el("tbody", { class: operation.enabled ? "" : "disabled" },
            el("tr", {},
                el("td", {}, enabled),
                el("td", {}, el("div", { class: "cam-op-name" }, operation.name), el("div", { class: "muted" }, operation.source)),
                el("td", {}, toolPick),
                el("td", {}, fields),
                el("td", { class: "cam-passes muted" }, passText),
            ),
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
                setStatus("the file changed in the table; Revert takes the saved text", false);
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
            const response = await ctx.api.saveCamProfile(id, textArea.value);
            if (picked === id) {
                dirty = false;
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
            textArea.value = shown.text;
            dirty = false;
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
        const text = textArea.value.trim() === "" ? `name = ${JSON.stringify(id)}\n` : textArea.value;
        try {
            const response = await ctx.api.saveCamProfile(id, text);
            newId.value = "";
            picked = id;
            writePick(id);
            dirty = false;
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
        dirty = false;
        await refresh();
    }

    // --- making a job ---
    let making = false;
    async function makeJob(chosen: FileList | File[]): Promise<void> {
        if (making || picked === null) {
            return;
        }
        making = true;
        drop.classList.add("busy");
        fileInput.disabled = true;
        try {
            const list = Array.from(chosen);
            const answer = await ctx.call(ctx.api.camJob(picked, list, nameField.value.trim() || undefined));
            await ctx.refreshJobs();
            if (answer) {
                lastJob = answer.job.id;
                await ctx.selectJob(answer.job.id);
                renderJobs(ctx.store.get());
                replace(notes, ...answer.notes.map((note) => el("li", {}, note)));
                notes.classList.toggle("hidden", answer.notes.length === 0);
                ctx.toast("info", `made ${answer.job.name}: ${answer.job.groups.filter((g) => g.enabled && g.paths.length > 0).length} operations`);
            }
        } finally {
            making = false;
            drop.classList.remove("busy");
            fileInput.disabled = picked === null;
            fileInput.value = "";
        }
    }

    fileInput.addEventListener("change", () => {
        if (fileInput.files && fileInput.files.length > 0) {
            void makeJob(fileInput.files);
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
        const dropped = (event as DragEvent).dataTransfer?.files;
        if (dropped && dropped.length > 0) {
            void makeJob(dropped);
        }
    });

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
        download(written.filename, written.text);
    }

    function download(filename: string, text: string): void {
        if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
            ctx.toast("info", `${filename} is written; this browser cannot save it from here`);
            return;
        }
        const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
        const link = el("a", { href: url, download: filename });
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        ctx.toast("info", `saved ${filename}`);
    }

    lockAll();
    void refresh();
}
