// The Home area: where things stand, and the one thing to do next. Three
// panels: Next (the machine connected or not, the stage of a run the work
// stands at with what is so there, and one button that goes on with it:
// connect the machine found, or the panel that does that stage), Needs you (what the
// Checklist says a person has to do now, each line a link to where it is
// done), and the jobs to pick from. Home holds no setting and no control
// of the machine but Connect: everything else is a press away, in the area
// that owns it.

import { el, replace } from "../dom.ts";
import { factsOf, type Fact } from "../facts.ts";
import { defaultPort } from "../ports.ts";
import type { AppState } from "../state.ts";
import { connectOffered, offeredPorts, portName } from "./connection.ts";
import type { Ctx } from "./context.ts";
import { runActive } from "./heightmap.ts";
import { FACT_KEYS } from "./facts.ts";
import { goTo, linkToText } from "./links.ts";
import { machineName, nextStage, runStages, runText } from "./stages.ts";
import { goToPanel } from "./steps.ts";
import { showPage } from "./tabs.ts";

/** What Home offers next: its name, what is so, the button's words, and what the button does. */
export interface NextAction {
    /** Connect the port found, find a port, watch a run, or go on at a stage of a run. */
    kind: "connect" | "ports" | "run" | "stage";
    title: string;
    detail: string;
    label: string;
    /** The stage the button goes on with; null for an action that is not one. */
    stage: string | null;
    /** The panel the button goes to; null for one that goes to no panel. */
    panel: string | null;
}

/**
 * The next thing to do, from the state: watch a run under way; connect the
 * machine found, or find it; else the first stage a run needs that is not
 * done (pick a job, home, place the board), ending in the run.
 */
export function nextAction(state: AppState): NextAction {
    const progress = state.progress ?? state.snapshot.run;
    if (progress !== null && runActive(progress)) {
        return { kind: "run", title: progress.state === "hold" ? "A run is held" : "A run is under way", detail: runText(state), label: "Show the run", stage: "run", panel: "run" };
    }
    if (!state.snapshot.connected) {
        const port = defaultPort(offeredPorts(state));
        return port
            ? { kind: "connect", title: "Connect the machine", detail: `${portName(port)} is plugged in.`, label: `Connect ${portName(port)}`, stage: null, panel: null }
            : { kind: "ports", title: "Connect the machine", detail: "No port found: plug the machine in, or type its port on the Machines page.", label: "Machines and ports", stage: null, panel: "connection" };
    }
    const stages = runStages(state);
    const stage = nextStage(stages);
    if (!stage) {
        return { kind: "stage", title: "Run", detail: "", label: "Go to Run", stage: null, panel: "run" };
    }
    const last = stage === stages[stages.length - 1];
    return {
        kind: "stage",
        title: last ? stage.label : `${stage.label}: ${stage.tip}`,
        detail: stage.line,
        label: last ? `Go to ${stage.label}` : `Continue: ${stage.label}`,
        stage: stage.id,
        panel: stage.panel,
    };
}

/** The machine in a line: which one is connected and what it is doing, or that none is. */
export function machineLine(state: AppState): string {
    const snapshot = state.snapshot;
    if (!snapshot.connected) {
        return "No machine is connected.";
    }
    const said = snapshot.machine?.state;
    const doing = said === undefined ? "connected" : said === "Alarm" ? `in alarm ${snapshot.machine?.alarm ?? ""}`.trim() : said === "Idle" ? "idle" : said.toLowerCase();
    return said === undefined ? `${machineName(state)} is connected.` : `${machineName(state)} is connected, ${doing}.`;
}

/** The facts that ask for someone now. */
export function needsOf(state: AppState): Fact[] {
    return factsOf(state).filter((fact) => fact.need !== null);
}

/** The Next panel in `root`. */
export function mountOverview(root: HTMLElement, ctx: Ctx): void {
    const machine = el("p", { class: "home-machine" });
    const title = el("p", { class: "home-title" });
    const detail = el("p", { class: "muted home-detail" });
    let action: NextAction = nextAction(ctx.store.get());
    const go = el("button", { type: "button", class: "btn btn-primary btn-big home-go" });
    go.addEventListener("click", () => {
        switch (action.kind) {
            case "connect":
                void connectOffered(ctx);
                break;
            case "ports":
                void goTo({ panel: "connection", detail: null });
                break;
            default:
                if (action.panel !== null) {
                    goToPanel(action.panel);
                } else {
                    showPage("run");
                }
        }
    });
    root.append(
        el("div", { class: "panel-head" }, el("h2", {}, "Next")),
        el("div", { class: "panel-body stack home-next" }, machine, title, detail, el("div", { class: "button-row" }, go)),
    );

    const set = (node: HTMLElement, text: string): void => {
        if (node.textContent !== text) {
            node.textContent = text;
        }
    };
    const draw = (state: AppState): void => {
        action = nextAction(state);
        set(machine, machineLine(state));
        set(title, action.title);
        set(detail, action.detail);
        detail.hidden = action.detail === "";
        set(go, action.label);
        go.title = action.kind === "connect" ? "open the port and read the machine's settings" : action.kind === "ports" ? "the Setup side's Machines page" : "the panel that does this";
    };
    ctx.store.subscribe(draw, ["snapshot", "ports", "jobs", "job", "progress", "placing", "components", "settings", "machines", "heightMap"]);
    draw(ctx.store.get());
}

/** The Needs you panel in `root`: the Checklist's lines that ask for someone now. */
export function mountHomeNeeds(root: HTMLElement, ctx: Ctx): void {
    const list = el("ul", { class: "home-needs" });
    const none = el("p", { class: "muted" }, "Nothing needs you.");
    const all = linkToText("facts", "The whole Checklist", "every value the machine runs on, and where each came from");
    root.append(
        el("div", { class: "panel-head" }, el("h2", {}, "Needs you")),
        el("div", { class: "panel-body stack" }, none, list, el("p", { class: "home-all" }, all)),
    );
    let drawn = "";
    const draw = (state: AppState): void => {
        const needs = needsOf(state);
        // Drawn again only when the lines change: a link replaced between a press and its release takes no click.
        const key = JSON.stringify(needs.map((fact) => [fact.id, fact.label, fact.need, fact.where, fact.action]));
        if (key === drawn) {
            return;
        }
        drawn = key;
        none.hidden = needs.length > 0;
        list.hidden = needs.length === 0;
        replace(list, ...needs.map((fact) => el("li", { class: "home-need" },
            el("span", { class: "home-need-text" }, el("span", { class: "home-need-name" }, fact.label), el("span", { class: "muted" }, fact.need ?? "")),
            linkToText(fact.where, fact.action, `${fact.label}: ${fact.need ?? ""}`),
        )));
    };
    ctx.store.subscribe(draw, FACT_KEYS);
    draw(ctx.store.get());
}
