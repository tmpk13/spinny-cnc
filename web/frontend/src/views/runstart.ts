// The jobs kept as a list to pick the one to run from: Home's Jobs panel.
// It holds no setting: the jobs' own settings are in the Job area, a press
// away.

import { button, el, replace } from "../dom.ts";
import { formatDuration, formatLength } from "../format.ts";
import type { AppState } from "../state.ts";
import type { Ctx } from "./context.ts";
import { jobPicture } from "./jobicon.ts";
import { showPage } from "./tabs.ts";

/** A list of the jobs kept in `root`, under `title`: the one picked marked; a press picks. */
export function mountRunJob(root: HTMLElement, ctx: Ctx, title = "Jobs"): void {
    const list = el("ul", { class: "pick-list", "aria-label": "Jobs" });
    const none = el("p", { class: "muted" }, "No jobs yet.");
    const open = button("Open or make a job", () => showPage("job"), "btn", "the Job area: open a file, draw a job, describe one");
    root.append(
        el("div", { class: "panel-head" }, el("h2", {}, title)),
        el("div", { class: "panel-body stack" }, none, list, el("div", { class: "button-row" }, open)),
    );

    let drawn = "";
    function render(state: AppState): void {
        const picked = state.job?.id ?? null;
        // Drawn again only when the list or the pick changes: a row replaced
        // between a press and its release takes no click.
        const key = JSON.stringify([state.jobs.map((job) => [job.id, job.name, job.source, job.stats?.length_mm, job.stats?.seconds, job.icon]), picked]);
        if (key === drawn) {
            return;
        }
        drawn = key;
        none.hidden = state.jobs.length > 0;
        open.classList.toggle("btn-primary", state.jobs.length === 0);
        replace(list, ...state.jobs.map((job) => el("li", {},
            el("button", {
                type: "button",
                class: "pick-row",
                "aria-pressed": String(job.id === picked),
                title: job.id === picked ? "the job picked" : "pick this job",
                onclick: () => void ctx.selectJob(job.id),
            },
            el("span", { class: "pick-picture" }, jobPicture(job, ctx.api.jobThumbUrl(job))),
            el("span", { class: "pick-text" },
                el("span", { class: "pick-name" }, job.name),
                el("span", { class: "muted pick-note" }, `${job.layer ? `${job.source} ${job.layer}` : job.source}${job.stats ? `, ${formatLength(job.stats.length_mm)}, ${formatDuration(job.stats.seconds)}` : ""}`),
            )),
        )));
    }
    ctx.store.subscribe(render, ["jobs", "job"]);
    render(ctx.store.get());
}
