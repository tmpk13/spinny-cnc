// Hosts the canvas preview and feeds it the selected job and live position.

import { button, el } from "../dom.ts";
import { Preview } from "../preview.ts";
import type { Ctx } from "./context.ts";

export function mountPreviewPanel(root: HTMLElement, ctx: Ctx): Preview {
    const canvas = el("canvas", { class: "preview", "aria-label": "Board preview around the rotation axis" });
    const preview = new Preview(canvas);
    root.append(
        el("div", { class: "panel-head" },
            el("h2", {}, "Preview"),
            el("div", { class: "button-row" },
                button("Fit", () => preview.resetView(), "btn btn-quiet btn-small"),
                button("Clear trail", () => preview.clearTrail(), "btn btn-quiet btn-small"),
            ),
        ),
        el("div", { class: "preview-box" }, canvas),
        el("p", { class: "muted hint" }, "wheel zooms, drag pans, double click fits"),
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
        preview.setRMax(state.settings?.values["r_max"] ?? 0);
    }, ["settings"]);
    ctx.store.subscribe((state) => {
        preview.setProbe(state.heightMap?.map ?? null, state.probeDraft);
    }, ["heightMap", "probeDraft"]);
    preview.resize();
    return preview;
}
