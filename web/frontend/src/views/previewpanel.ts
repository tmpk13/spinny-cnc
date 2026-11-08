// Hosts the 3D preview and feeds it the selected job (or what the page
// shows in its place: the JSON panel's edit while it is typed, the Plot
// page's plan), the live position, the soft limits, the markers and the
// probe grid; the rotation lock, the height map toggle, the grid in place
// of the rings, box selection, the speed view, a view straight down,
// quarter turns and the reset to the overview sit in its head, and a
// slider under it steps through the job's paths in the order they are cut. A path clicked, or the paths a box holds, become the page's picked
// paths, which the Jobs panel moves between groups.

import { button, el } from "../dom.ts";
import { Preview, type Dimension } from "../preview.ts";
import type { SpeedLimits } from "../speed.ts";
import { type PathRef, boxedAfter, pickedAfter } from "../regroup.ts";
import type { AppState } from "../state.ts";
import type { Job } from "../types.ts";
import type { Ctx } from "./context.ts";

export const LOCK_LABEL = "Lock rotation";
export const LOCKED_LABEL = "Rotation locked";
export const HEIGHTS_LABEL = "Heights";
export const GRID_LABEL = "Grid";
export const BOX_LABEL = "Box select";
export const SPEED_LABEL = "Speed";

/** The rates the speed view works with: the settings read, else the firmware's defaults, marked as assumed. */
export function speedLimitsOf(state: AppState): SpeedLimits {
    const values = state.settings?.values;
    const rate = (name: string, fallback: number): number => {
        const value = values?.[name];
        return typeof value === "number" && value > 0 ? value : fallback;
    };
    return {
        kinematics: state.snapshot.profile?.kinematics ?? "polar",
        rRate: rate("r_rate", 560),
        aRate: rate("a_rate", 400),
        zRate: rate("z_rate", 600),
        tolerance: state.settings?.host?.tolerance ?? 0.005,
        assumed: !values,
    };
}

/** What the cut order slider says at `at` of `total` paths. */
export function scrubText(at: number, total: number, label: string | null): string {
    if (at >= total) {
        return `all ${total} ${total === 1 ? "path" : "paths"} in the order they are cut`;
    }
    if (at === 0) {
        return `none of ${total} cut yet`;
    }
    return `${at} of ${total} cut, the last in ${label ?? "a group"}`;
}

/** The selected job, with the copies an array would add while its fields are open, or its edit in the JSON panel while one is typed. */
export function shownJob(state: AppState): Job | null {
    const array = state.arrayDraft;
    if (array !== null && state.job !== null && array.id === state.job.id) {
        return array;
    }
    const draft = state.jobDraft;
    return draft !== null && state.job !== null && draft.id === state.job.id ? draft : state.job;
}

/** A button in the preview's head that sets the view, with what it does as its title. */
function viewButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
    const made = button(label, onClick, "btn btn-quiet btn-small");
    made.title = title;
    return made;
}

/** No paths picked: one array, so the preview sees nothing changed. */
const NONE: PathRef[] = [];

/** Every preview panel's grid: a grid picked on one page's preview is picked on all of them. */
const gridPanels = new Set<(on: boolean) => void>();

/**
 * `show` picks the job drawn: the selected one unless the page says
 * otherwise, as the Plot page shows its plan; `dims` gives the sizes drawn
 * over it, as the Plot page draws its operation's.
 */
export function mountPreviewPanel(
    root: HTMLElement,
    ctx: Ctx,
    show: (state: AppState) => Job | null = shownJob,
    dims: ((state: AppState) => Dimension[]) | null = null,
): Preview {
    const canvas = el("canvas", { class: "preview", "aria-label": "3D preview of the board around the rotation axis" });
    const preview = new Preview(canvas);
    const lock = button(LOCK_LABEL, () => showLock(preview.toggleRotationLock()), "btn btn-quiet btn-small btn-toggle");
    const showLock = (locked: boolean): void => {
        lock.setAttribute("aria-pressed", locked ? "true" : "false");
        lock.textContent = locked ? LOCKED_LABEL : LOCK_LABEL;
    };
    showLock(preview.rotationLocked);
    const heights = button(HEIGHTS_LABEL, () => showHeights(preview.toggleHeights()), "btn btn-quiet btn-small btn-toggle");
    heights.title = "draw the height map's mesh and probe points";
    const showHeights = (on: boolean): void => {
        heights.setAttribute("aria-pressed", on ? "true" : "false");
    };
    showHeights(preview.showHeights);
    const grid = button(GRID_LABEL, () => {
        const on = !preview.showGrid;
        for (const apply of gridPanels) {
            apply(on);
        }
    }, "btn btn-quiet btn-small btn-toggle");
    grid.title = "draw a square grid of X and Y under the work instead of rings about the axis";
    const showGrid = (on: boolean): void => {
        grid.setAttribute("aria-pressed", on ? "true" : "false");
    };
    showGrid(preview.showGrid);
    gridPanels.add((on) => {
        preview.setShowGrid(on);
        showGrid(on);
    });
    const box = button(BOX_LABEL, () => {
        preview.setBoxSelection(!preview.boxSelection);
        box.setAttribute("aria-pressed", preview.boxSelection ? "true" : "false");
    }, "btn btn-quiet btn-small btn-toggle");
    box.title = "drag a box to pick every path inside it, with shift to add them; right drag still pans";
    box.setAttribute("aria-pressed", "false");
    const speed = button(SPEED_LABEL, () => {
        preview.setSpeedView(!preview.speedView);
        speed.setAttribute("aria-pressed", preview.speedView ? "true" : "false");
        showScrub();
    }, "btn btn-quiet btn-small btn-toggle");
    speed.title = "draw each cut by the speed it runs at, slow to fast, with the moves a machine rate holds below their group's speed marked red";
    speed.setAttribute("aria-pressed", "false");
    // Stepping through the cut: the slider's end draws the job whole.
    const scrub = el("input", { type: "range", class: "scrub", min: "0", max: "0", value: "0", step: "1", "aria-label": "Cut order" }) as HTMLInputElement;
    const scrubNote = el("span", { class: "muted scrub-note" });
    const scrubBack = button("Back", () => stepScrub(-1), "btn btn-quiet btn-small");
    scrubBack.title = "one path fewer cut";
    const scrubOn = button("On", () => stepScrub(1), "btn btn-quiet btn-small");
    scrubOn.title = "one path more cut";
    const scrubRow = el("div", { class: "scrub-row hidden" }, scrubBack, scrub, scrubOn, scrubNote);
    scrub.addEventListener("input", () => setScrub(Number(scrub.value)));

    function setScrub(at: number): void {
        const total = preview.cutOrder().length;
        const value = Math.max(0, Math.min(total, Math.round(at)));
        scrub.value = String(value);
        preview.setScrub(value >= total ? null : value);
        const last = value > 0 ? preview.cutOrder()[value - 1] : undefined;
        const job = show(ctx.store.get());
        scrubNote.textContent = scrubText(value, total, last && job ? job.groups[last[0]]?.label ?? null : null);
    }

    function stepScrub(by: number): void {
        setScrub(Number(scrub.value) + by);
    }

    /** The slider for the job shown: back at the end for another job, kept where it is for an edit of the same one. */
    function showScrub(reset = false): void {
        const total = preview.cutOrder().length;
        scrubRow.classList.toggle("hidden", total === 0 || preview.speedView);
        const wasEnd = preview.scrub === null;
        scrub.max = String(total);
        setScrub(reset || wasEnd ? total : Number(scrub.value));
    }
    // Picks are of the stored job: a Plot page plan, not stored, has none.
    const pickable = (): Job | null => {
        const job = show(ctx.store.get());
        return job !== null && job.id !== "" ? job : null;
    };
    const current = (job: Job): PathRef[] => {
        const selection = ctx.store.get().selection;
        return selection !== null && selection.job === job.id ? selection.paths : [];
    };
    preview.onPick = (ref, additive) => {
        const job = pickable();
        if (job) {
            ctx.store.set({ selection: { job: job.id, paths: pickedAfter(current(job), ref, additive) } });
        }
    };
    preview.onBox = (refs, additive) => {
        const job = pickable();
        if (job) {
            ctx.store.set({ selection: { job: job.id, paths: boxedAfter(current(job), refs, additive) } });
        }
    };
    root.append(
        el("div", { class: "panel-head" },
            el("h2", {}, "Preview"),
            el("div", { class: "button-row" },
                lock,
                heights,
                grid,
                box,
                speed,
                viewButton("Top view", "look straight down, the board square to the canvas", () => preview.lookDown()),
                viewButton("CCW 90", "turn the board a quarter counterclockwise on the canvas", () => preview.turnView(-1)),
                viewButton("CW 90", "turn the board a quarter clockwise on the canvas", () => preview.turnView(1)),
                button("Reset view", () => preview.resetView(), "btn btn-quiet btn-small"),
                button("Clear trail", () => preview.clearTrail(), "btn btn-quiet btn-small"),
            ),
        ),
        el("div", { class: "preview-box" }, canvas),
        scrubRow,
        el("p", { class: "muted hint" }, "drag orbits, or pans with the rotation locked; shift or right drag pans, wheel zooms, double click resets; a click picks a path, shift or ctrl adds one"),
    );

    // The view is fitted again for another job, and kept for a fresh copy of
    // the same one (an edit) or a plan changed as it is typed.
    let shownJob: string | null = null;
    let shownPlan = false;
    ctx.store.subscribe((state) => {
        const job = show(state);
        const plan = job !== null && job.id === "";
        const keep = job !== null && ((plan && shownPlan) || (!plan && job.id === shownJob));
        const another = (job?.id ?? null) !== shownJob || plan !== shownPlan;
        shownJob = job?.id ?? null;
        shownPlan = plan;
        preview.setJob(job, keep);
        showScrub(another);
    }, ["job", "millPlan", "jobDraft", "arrayDraft"]);
    // The picked paths and the JSON panel's place, for the job shown.
    ctx.store.subscribe((state) => {
        const job = show(state);
        const selection = state.selection;
        preview.setSelection(job !== null && selection !== null && selection.job === job.id ? selection.paths : NONE);
        const highlight = state.highlight;
        preview.setHighlight(job !== null && highlight !== null && highlight.job === job.id ? highlight : null);
    }, ["selection", "highlight", "job", "millPlan", "jobDraft", "arrayDraft"]);
    ctx.store.subscribe((state) => {
        preview.setMarkers(state.markers);
    }, ["markers"]);
    if (dims) {
        ctx.store.subscribe((state) => preview.setDimensions(dims(state)), ["millDims"]);
        preview.setDimensions(dims(ctx.store.get()));
    }
    preview.setMarkers(ctx.store.get().markers);
    ctx.store.subscribe((state) => {
        // The board point comes from the backend, which knows the frame: on a
        // cartesian machine the head is not at the joint's polar point. The
        // preview draws nothing for a frame that leaves the head where it was.
        // On a dispenser the table joint is the plunger: it turns no frame,
        // so the rail and the limits are drawn at angle 0.
        const machine = state.snapshot.machine;
        const joint = machine?.joint ?? null;
        const head = joint && state.snapshot.profile?.tool === "dispenser" ? { ...joint, a: 0 } : joint;
        preview.setHead(head, machine?.board ?? null);
    }, ["snapshot"]);
    ctx.store.subscribe((state) => {
        // The profile in every state frame follows a setting changed at the
        // console or from another page; the settings read are the fallback
        // for a backend that sends no profile.
        // A cartesian machine reaches a box, not a circle.
        const profile = state.snapshot.profile;
        preview.setLimits(profile
            ? { kinematics: profile.kinematics, r_max: profile.r_max, z_max: profile.z_max }
            : { kinematics: "polar", r_max: state.settings?.values["r_max"] ?? 0, z_max: 0 });
        // Until a grid is picked here, a cartesian machine draws one.
        showGrid(preview.showGrid);
    }, ["settings", "snapshot"]);
    ctx.store.subscribe((state) => {
        preview.setProbe(state.heightMap?.map ?? null, state.probeDraft);
    }, ["heightMap", "probeDraft"]);
    ctx.store.subscribe((state) => preview.setSpeedLimits(speedLimitsOf(state)), ["settings", "snapshot"]);
    preview.setSpeedLimits(speedLimitsOf(ctx.store.get()));
    preview.resize();
    return preview;
}
