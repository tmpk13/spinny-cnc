// The selected job as JSON text, to read and to edit: every path on a line
// of its own, and the place the caret is in drawn on the preview (its path,
// and the point there with the segments either side). A path picked in the
// preview puts the caret on its line. Typing redraws the preview from the
// text as soon as it reads as a job, so an edited point is seen where it
// lands; Apply sends the text back (PUT /api/jobs/{id}), checked there as
// an upload is, and Revert takes the stored job again.

import { errorText } from "../api.ts";
import { button, el, setLocked, tabIndents } from "../dom.ts";
import { countText } from "../format.ts";
import { type JobPlace, formatJson, offsetOf, placeOf, stepsAt } from "../jsontext.ts";
import { jointPreview } from "../mock/jobs.ts";
import { setPending } from "../state.ts";
import type { Job } from "../types.ts";
import type { Ctx } from "./context.ts";

/** Text longer than this is not put in the editor until asked: a board of a few hundred thousand points. */
export const LARGE_TEXT = 4_000_000;
/** How long typing rests before the text is read again, ms. */
const READ_MS = 250;
/** The edits this panel holds, as the tabs count them. */
export const PENDING_SOURCE = "job-json";

/** The job as the editor shows it: what a run uses, without its id and price, which the backend keeps and works out. */
export function jobText(job: Job): string {
    const { id: _id, stats: _stats, ...rest } = job;
    return formatJson(rest);
}

function isPoint(value: unknown): boolean {
    return Array.isArray(value) && value.length >= 2 && value.every((v) => typeof v === "number" && Number.isFinite(v));
}

function isPaths(value: unknown): boolean {
    return Array.isArray(value) && value.every((path) => Array.isArray(path) && path.every(isPoint));
}

/** A model's moves: lists of [x, y, z, kind]. */
function isMoves(value: unknown): boolean {
    return Array.isArray(value) && value.every((path) => Array.isArray(path) && path.every((move) => isPoint(move) && (move as unknown[]).length === 4));
}

/**
 * The job a text says, as far as the page can tell before the backend
 * checks it, with the stored job's id and the fields a drawing needs
 * filled in; a message saying what is wrong otherwise. A joint-space
 * group's paths are only its drawing: one whose joints are not the
 * `stored` job's group's, or that has none, is drawn from its joints, as
 * the backend draws it once applied, so the edit shows where a run cuts.
 */
export function readJobText(text: string, id: string, stored: Job | null = null): Job | string {
    let data: unknown;
    try {
        data = JSON.parse(text);
    } catch (error) {
        return `not JSON yet: ${errorText(error)}`;
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
        return "a job is a JSON object";
    }
    const raw = data as Record<string, unknown>;
    if (!Array.isArray(raw["groups"])) {
        return "a job needs its groups, a list";
    }
    for (const [index, group] of (raw["groups"] as unknown[]).entries()) {
        if (typeof group !== "object" || group === null || Array.isArray(group)) {
            return `group ${index + 1} is not an object`;
        }
        const fields = group as Record<string, unknown>;
        if (typeof fields["label"] !== "string") {
            return `group ${index + 1} needs a label`;
        }
        // Each list the preview walks is refused when given as anything
        // else (null included), as the backend refuses it: drawn, it would
        // stop the preview.
        const given = (key: string): boolean => fields[key] !== undefined;
        if (given("paths") && !isPaths(fields["paths"])) {
            return `${fields["label"]}: paths are lists of [x, y] points`;
        }
        if (given("joints") && !isPaths(fields["joints"])) {
            return `${fields["label"]}: joints are lists of [radius, angle] points`;
        }
        if (given("moves") && !isMoves(fields["moves"])) {
            return `${fields["label"]}: moves are lists of [x, y, z, kind] moves`;
        }
        const areas = fields["areas"];
        if (given("areas") && !(Array.isArray(areas) && areas.every((area) => typeof area === "number" && Number.isFinite(area)))) {
            return `${fields["label"]}: areas are a list of numbers`;
        }
    }
    for (const key of ["outline", "copper"]) {
        if (raw[key] !== undefined && !isPaths(raw[key])) {
            return `${key}: lists of [x, y] points`;
        }
    }
    const groups = (raw["groups"] as Record<string, unknown>[]).map((group, index) => {
        const made = { power: 500, min_power: 0, speed: 400, passes: 1, enabled: true, paths: [] as unknown, ...group };
        const joints = group["joints"];
        if (Array.isArray(joints) && joints.length > 0) {
            const drawn = Array.isArray(made.paths) && made.paths.length > 0;
            if (!drawn || JSON.stringify(joints) !== JSON.stringify(stored?.groups[index]?.joints ?? [])) {
                made.paths = (joints as [number, number][][]).map((poly) => jointPreview(poly));
            }
        }
        return made;
    });
    return {
        name: "job",
        source: "json",
        spot: 0.1,
        offset: { x: 0, y: 0 },
        outline: [],
        copper: [],
        ...raw,
        groups,
        id,
        stats: { length_mm: 0, seconds: 0, max_radius: 0, min_radius: 0, limited_fraction: 0, moves: 0 },
    } as unknown as Job;
}

/** What the caret's place says, for the line under the editor. */
export function placeText(place: JobPlace | null, job: Job | null): string {
    if (place === null) {
        return "";
    }
    const point = place.point === null ? "" : `, point ${place.point + 1}`;
    if (place.list === "groups") {
        const label = job?.groups[place.group ?? -1]?.label;
        return `${label ?? `group ${(place.group ?? 0) + 1}`}: path ${place.path + 1}${point}`;
    }
    return `${place.list}: path ${place.path + 1}${point}`;
}

function samePlace(a: JobPlace | null, b: JobPlace | null): boolean {
    if (a === null || b === null) {
        return a === b;
    }
    return a.list === b.list && a.group === b.group && a.path === b.path && a.point === b.point;
}

export function mountJobJson(root: HTMLElement, ctx: Ctx): void {
    const editor = el("textarea", {
        class: "json-input",
        spellcheck: "false",
        wrap: "off",
        "aria-label": "Job JSON",
        rows: "18",
    }) as HTMLTextAreaElement;
    const status = el("p", { class: "muted hint json-status" });
    const where = el("p", { class: "hint json-where" });
    const applyButton = button("Apply", () => apply(), "btn btn-primary btn-small");
    applyButton.title = "make the job what the text says; the backend checks it as it checks an upload";
    const revertButton = button("Revert", () => revert(), "btn btn-quiet btn-small");
    revertButton.title = "throw the edit away and show the job as it is kept";
    const showLarge = button("Show anyway", () => fill(ctx.store.get().job, true), "btn btn-quiet btn-small");
    const large = el("p", { class: "muted hint hidden" });
    const largeRow = el("div", { class: "button-row hidden" }, showLarge);
    const body = el("details", { class: "json-panel" },
        el("summary", {}, "Job JSON"),
        el("p", { class: "muted hint" }, "The selected job, every path on a line of its own. The caret's path and point are drawn on the preview, and a path clicked there is found here; an edit is drawn as it is typed and kept with Apply."),
        large,
        largeRow,
        editor,
        where,
        status,
        el("div", { class: "button-row" }, applyButton, revertButton),
    );
    root.append(body);

    // The job whose text the editor holds, the text as filled in, and
    // whether it has been typed in since.
    let shownFor: string | null = null;
    let shownJob: Job | null = null;
    let dirty = false;
    let readTimer: ReturnType<typeof setTimeout> | null = null;

    const setDirty = (on: boolean): void => {
        dirty = on;
        setPending(ctx.store, PENDING_SOURCE, on ? 1 : 0);
        setLocked(applyButton, !on);
        setLocked(revertButton, !on);
    };
    setDirty(false);

    /** Puts the stored job's text in the editor, unless it is too long to show without asking. */
    function fill(job: Job | null, force = false): void {
        shownFor = job?.id ?? null;
        shownJob = job;
        if (readTimer !== null) {
            clearTimeout(readTimer);
            readTimer = null;
        }
        ctx.store.set({ jobDraft: null, highlight: null });
        setDirty(false);
        where.textContent = "";
        if (job === null) {
            editor.value = "";
            editor.disabled = true;
            status.textContent = "select a job to see it here";
            large.classList.add("hidden");
            largeRow.classList.add("hidden");
            return;
        }
        const text = jobText(job);
        if (text.length > LARGE_TEXT && !force) {
            editor.value = "";
            editor.disabled = true;
            large.textContent = `${job.name} is ${(text.length / 1e6).toFixed(1)} MB of text, slow to edit here.`;
            large.classList.remove("hidden");
            largeRow.classList.remove("hidden");
            status.textContent = "";
            return;
        }
        large.classList.add("hidden");
        largeRow.classList.add("hidden");
        editor.disabled = false;
        editor.value = text;
        status.textContent = `${countText(job.groups.length, "group", "groups")}, ${job.groups.reduce((sum, group) => sum + group.paths.length, 0)} paths`;
    }

    ctx.store.subscribe((state, previous) => {
        const job = state.job;
        if ((job?.id ?? null) !== shownFor) {
            if (dirty && previous.job) {
                ctx.toast("info", `the JSON edit of ${previous.job.name} was left`);
            }
            fill(job);
            return;
        }
        if (job !== shownJob) {
            if (dirty) {
                status.textContent = "the job changed since this text was taken: Revert takes it as it is now, Apply puts this text in its place";
            } else {
                fill(job);
            }
        }
    }, ["job"]);
    fill(ctx.store.get().job);

    /** Reads the text a moment after typing rests, and draws it when it reads as a job. */
    function read(): void {
        readTimer = null;
        const job = ctx.store.get().job;
        if (!job) {
            return;
        }
        const made = readJobText(editor.value, job.id, job);
        if (typeof made === "string") {
            status.textContent = made;
            return;
        }
        status.textContent = `reads as a job of ${countText(made.groups.length, "group", "groups")}: drawn on the preview, not kept until Apply`;
        ctx.store.set({ jobDraft: made });
    }

    editor.addEventListener("input", () => {
        if (!dirty) {
            setDirty(true);
        }
        if (readTimer !== null) {
            clearTimeout(readTimer);
        }
        readTimer = setTimeout(read, READ_MS);
        follow();
    });
    tabIndents(editor);

    /** The caret's place, drawn on the preview and said under the editor. */
    function follow(): void {
        const job = ctx.store.get().job;
        if (!job || editor.disabled) {
            return;
        }
        const place = placeOf(stepsAt(editor.value, editor.selectionStart));
        const current = ctx.store.get().highlight;
        if (!samePlace(current, place)) {
            ctx.store.set({ highlight: place === null ? null : { ...place, job: job.id } });
        }
        where.textContent = placeText(place, ctx.store.get().jobDraft ?? job);
    }
    for (const type of ["click", "keyup", "focus", "select"]) {
        editor.addEventListener(type, follow);
    }

    /**
     * A path picked in the preview: the caret goes to its line, scrolled
     * into view. While the text is edited the preview shows the edit, so
     * the picks whose indices are the text's are the edit's; until then,
     * the stored job's.
     */
    ctx.store.subscribe((state) => {
        const job = state.job;
        const selection = state.selection;
        if (!job || !selection || selection.job !== job.id || selection.paths.length === 0 || editor.disabled || !body.open || (selection.draft === true) !== dirty) {
            return;
        }
        const [group, path] = selection.paths[selection.paths.length - 1]!;
        const offset = offsetOf(editor.value, ["groups", group, "paths", path]);
        if (offset === null) {
            return;
        }
        editor.setSelectionRange(offset, offset);
        const line = editor.value.slice(0, offset).split("\n").length;
        const lines = editor.value.split("\n").length;
        editor.scrollTop = Math.max(0, (line - 4) * (editor.scrollHeight / Math.max(1, lines)));
        follow();
    }, ["selection"]);

    async function apply(): Promise<void> {
        const job = ctx.store.get().job;
        if (!job) {
            return;
        }
        const made = readJobText(editor.value, job.id, job);
        if (typeof made === "string") {
            ctx.toast("error", made);
            return;
        }
        const kept = await ctx.call(ctx.api.replaceJob(job.id, made));
        if (!kept) {
            return;
        }
        setDirty(false);
        ctx.store.set({ jobDraft: null, selection: null });
        await ctx.reloadJob(job.id);
        await ctx.refreshJobs();
        // Paths changed are nothing the file or operations would make
        // again, so the backend keeps no recipe for such a job.
        const lost = job.recipe && !kept.recipe ? `, no longer made again from its ${job.recipe.file ? "file" : "operations"}` : "";
        ctx.toast("info", `${kept.name}: kept as the text says${lost}`);
    }

    function revert(): void {
        fill(ctx.store.get().job);
    }

    // Closing the panel stops drawing the caret's place.
    body.addEventListener("toggle", () => {
        if (!body.open) {
            ctx.store.set({ highlight: null });
        }
    });
}
