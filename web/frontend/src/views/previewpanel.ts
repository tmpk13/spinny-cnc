// Hosts the 3D preview and feeds it the selected job (or what the page
// shows in its place), the live position, the soft limits, the markers and
// the probe grid; the rotation lock, the height map toggle, the grid in
// place of the rings and the reset to the overview sit in its head.

import { button, el } from "../dom.ts";
import { Preview } from "../preview.ts";
import type { AppState } from "../state.ts";
import type { Job } from "../types.ts";
import type { Ctx } from "./context.ts";

export const LOCK_LABEL = "Lock rotation";
export const LOCKED_LABEL = "Rotation locked";
export const HEIGHTS_LABEL = "Heights";
export const GRID_LABEL = "Grid";

/** Every preview panel's grid: a grid picked on one page's preview is picked on all of them. */
const gridPanels = new Set<(on: boolean) => void>();

/** `show` picks the job drawn: the selected one unless the page says otherwise, as the Mill page shows its plan. */
export function mountPreviewPanel(root: HTMLElement, ctx: Ctx, show: (state: AppState) => Job | null = (state) => state.job): Preview {
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
    root.append(
        el("div", { class: "panel-head" },
            el("h2", {}, "Preview"),
            el("div", { class: "button-row" },
                lock,
                heights,
                grid,
                button("Reset view", () => preview.resetView(), "btn btn-quiet btn-small"),
                button("Clear trail", () => preview.clearTrail(), "btn btn-quiet btn-small"),
            ),
        ),
        el("div", { class: "preview-box" }, canvas),
        el("p", { class: "muted hint" }, "drag orbits, or pans with the rotation locked; shift or right drag pans, wheel zooms, double click resets"),
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
    }, ["job", "millPlan"]);
    ctx.store.subscribe((state) => {
        preview.setMarkers(state.markers);
    }, ["markers"]);
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
