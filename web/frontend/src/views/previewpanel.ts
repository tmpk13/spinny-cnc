// Hosts the 3D preview and feeds it the selected job (or what the page
// shows in its place: the JSON panel's edit while it is typed, the Plot
// page's plan), the live position, the soft limits, the markers and the
// probe grid; the rotation lock, the height map toggle, the grid in place
// of the rings, box selection, a view straight down, quarter turns and the
// reset to the overview sit in its head. A path clicked, or the paths a box holds, become the page's picked
// paths, which the Jobs panel moves between groups.

import { button, el } from "../dom.ts";
import { Preview, type Dimension } from "../preview.ts";
import { type PathRef, boxedAfter, pickedAfter } from "../regroup.ts";
import type { AppState } from "../state.ts";
import type { Job } from "../types.ts";
import type { Ctx } from "./context.ts";

export const LOCK_LABEL = "Lock rotation";
export const LOCKED_LABEL = "Rotation locked";
export const HEIGHTS_LABEL = "Heights";
export const GRID_LABEL = "Grid";
export const BOX_LABEL = "Box select";

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
                viewButton("Top view", "look straight down, the board square to the canvas", () => preview.lookDown()),
                viewButton("CCW 90", "turn the board a quarter counterclockwise on the canvas", () => preview.turnView(-1)),
                viewButton("CW 90", "turn the board a quarter clockwise on the canvas", () => preview.turnView(1)),
                button("Reset view", () => preview.resetView(), "btn btn-quiet btn-small"),
                button("Clear trail", () => preview.clearTrail(), "btn btn-quiet btn-small"),
            ),
        ),
        el("div", { class: "preview-box" }, canvas),
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
        shownJob = job?.id ?? null;
        shownPlan = plan;
        preview.setJob(job, keep);
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
    preview.resize();
    return preview;
}
