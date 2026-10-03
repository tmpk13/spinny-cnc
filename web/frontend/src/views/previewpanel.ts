// Hosts the 3D preview and feeds it the selected job, the live position,
// the soft limits and the probe grid; the rotation lock and the reset to
// the overview sit in its head.

import { button, el } from "../dom.ts";
import { Preview } from "../preview.ts";
import type { Ctx } from "./context.ts";

export const LOCK_LABEL = "Lock rotation";
export const LOCKED_LABEL = "Rotation locked";

export function mountPreviewPanel(root: HTMLElement, ctx: Ctx): Preview {
    const canvas = el("canvas", { class: "preview", "aria-label": "3D preview of the board around the rotation axis" });
    const preview = new Preview(canvas);
    const lock = button(LOCK_LABEL, () => showLock(preview.toggleRotationLock()), "btn btn-quiet btn-small btn-toggle");
    const showLock = (locked: boolean): void => {
        lock.setAttribute("aria-pressed", locked ? "true" : "false");
        lock.textContent = locked ? LOCKED_LABEL : LOCK_LABEL;
    };
    showLock(preview.rotationLocked);
    root.append(
        el("div", { class: "panel-head" },
            el("h2", {}, "Preview"),
            el("div", { class: "button-row" },
                lock,
                button("Reset view", () => preview.resetView(), "btn btn-quiet btn-small"),
                button("Clear trail", () => preview.clearTrail(), "btn btn-quiet btn-small"),
            ),
        ),
        el("div", { class: "preview-box" }, canvas),
        el("p", { class: "muted hint" }, "drag orbits, or pans with the rotation locked; shift or right drag pans, wheel zooms, double click resets"),
    );

    let shownJob: string | null = null;
    ctx.store.subscribe((state) => {
        const job = state.job;
        const keep = job !== null && job.id === shownJob;
        shownJob = job?.id ?? null;
        preview.setJob(job, keep);
    }, ["job"]);
    ctx.store.subscribe((state) => {
        // The board point comes from the backend, which knows the frame: on a
        // cartesian machine the head is not at the joint's polar point.
        const machine = state.snapshot.machine;
        preview.setHead(machine?.joint ?? null, machine?.board ?? null);
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
    }, ["settings", "snapshot"]);
    ctx.store.subscribe((state) => {
        preview.setProbe(state.heightMap?.map ?? null, state.probeDraft);
    }, ["heightMap", "probeDraft"]);
    preview.resize();
    return preview;
}
