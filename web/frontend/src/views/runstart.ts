// The Run area's first two steps, each a small panel: Connect, which
// offers the machine found on one button (the port a machine file claims
// or this project's board, as the Connection panel on the Setup side picks
// it) with the other ports in a list beside it, and Job, the jobs kept as
// a list to pick the one to run from. Neither holds a setting: the port
// typed by hand, the machine files and the jobs' own settings are a link
// away, on the pages that own them.

import { button, el, replace, setLocked } from "../dom.ts";
import { formatDuration, formatLength } from "../format.ts";
import type { AppState } from "../state.ts";
import { machineName } from "./areaviews.ts";
import { connectOffered, disconnectFrom, offeredPorts, portName } from "./connection.ts";
import type { Ctx } from "./context.ts";
import { jobPicture } from "./jobicon.ts";
import { linkTo } from "./links.ts";
import { defaultPort, portLabel } from "../ports.ts";
import { showPage } from "./tabs.ts";

/** The Connect step's panel in `root`. */
export function mountRunConnect(root: HTMLElement, ctx: Ctx): void {
    const line = el("p", { class: "start-line" });
    const detail = el("p", { class: "muted start-detail" });
    const connect = button("Connect", () => connectOffered(ctx, pick.value || null), "btn btn-primary btn-big");
    const disconnect = button("Disconnect", () => disconnectFrom(ctx), "btn", "let the machine go");
    const pick = el("select", { class: "field", "aria-label": "Port", title: "the ports found; a machine file's port is named after it" }) as HTMLSelectElement;
    const pickRow = el("label", { class: "labeled inline start-ports" }, el("span", {}, "Port"), pick);
    const machines = linkTo({ panel: "connection", detail: null }, "Machines", "the machine files, a port typed by hand, the firmware's settings");
    root.append(
        el("div", { class: "panel-head" }, el("h2", {}, "Connect")),
        el("div", { class: "panel-body stack" }, line, detail, el("div", { class: "button-row" }, connect, disconnect), pickRow, el("p", { class: "muted start-more" }, "A port typed by hand, another machine file: ", machines, ".")),
    );

    let listed = "";
    function render(state: AppState): void {
        const snapshot = state.snapshot;
        const ports = offeredPorts(state);
        const offered = defaultPort(ports);
        // Listed again only when the ports change: a select replaced while open shuts.
        const key = ports.map((port) => port.url).join(" ");
        if (key !== listed) {
            listed = key;
            const before = pick.value;
            replace(pick, ...ports.map((port) => el("option", { value: port.url }, portLabel(port))));
            pick.value = ports.some((port) => port.url === before) ? before : offered?.url ?? "";
        }
        connect.hidden = snapshot.connected;
        disconnect.hidden = !snapshot.connected;
        pickRow.hidden = snapshot.connected || ports.length < 2;
        if (snapshot.connected) {
            line.textContent = `${machineName(state)} is connected.`;
            const firmware = snapshot.firmware ? `, firmware ${snapshot.firmware.name ?? `v${snapshot.firmware.version}`}` : "";
            detail.textContent = `On ${snapshot.url ?? "its port"}${firmware}.`;
            return;
        }
        const chosen = ports.find((port) => port.url === pick.value) ?? offered;
        line.textContent = "No machine is connected.";
        detail.textContent = chosen ? "" : "No port found: plug the machine in.";
        connect.textContent = chosen ? `Connect ${portName(chosen)}` : "Connect";
        setLocked(connect, chosen === null, "no port found: plug the machine in");
    }
    pick.addEventListener("change", () => render(ctx.store.get()));
    ctx.store.subscribe(render, ["snapshot", "ports", "settings", "machines"]);
    render(ctx.store.get());
}

/** A list of the jobs kept in `root`, under `title`: the one picked marked; a press picks. The Run area's Job step, and Home's jobs. */
export function mountRunJob(root: HTMLElement, ctx: Ctx, title = "Job to run"): void {
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
