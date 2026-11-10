// Setup steps: a common setup (probing and a run that follows the map,
// milling a board, the camera's offset) as a row of numbered circles, each
// filled in once the page's own state shows that step done. The first step
// not done is the next one, and what it takes is said under the row; a
// press on any step takes the page to the panel that does it. Which setup is
// shown, and whether the panel is folded, is remembered per browser.

import { el, foldPanel, readStored, replace, writeStored } from "../dom.ts";
import { isMilling, profileOf } from "../profile.ts";
import type { AppState } from "../state.ts";
import type { Ctx } from "./context.ts";
import { mapComplete, mapUse, runActive } from "./heightmap.ts";
import { PAGES, showPage, type PageId } from "./tabs.ts";

export interface Step {
    label: string;
    done: boolean;
    /** What the step takes, said while it is the next one. */
    hint: string;
    /** The id of the panel that does it. */
    panel: string;
}

export interface Setup {
    id: string;
    label: string;
    /** Whether this machine has what the setup needs: probing needs a focus axis. Left out, the setup fits every machine. */
    fits?(state: AppState): boolean;
    steps(state: AppState): Step[];
}

export type StepState = "done" | "next" | "todo";

/** Each step's state: done, the first one not done (the next), or still to do. */
export function stepStates(steps: Step[]): StepState[] {
    const next = steps.findIndex((step) => !step.done);
    return steps.map((step, index) => (step.done ? "done" : index === next ? "next" : "todo"));
}

// --- the steps the setups share ---------------------------------------------

export function connectStep(state: AppState): Step {
    return { label: "Connect", done: state.snapshot.connected, hint: "Pick the controller's port in the bar at the top and press Connect.", panel: "status" };
}

export function jobStep(state: AppState): Step {
    return { label: "Job", done: state.job !== null, hint: "Upload a board or a drawing in the Jobs panel, or pick a job there.", panel: "jobs" };
}

function travelStep(state: AppState): Step {
    const travel = state.settings?.host.travel;
    return {
        label: "Travel height",
        done: travel !== null && travel !== undefined,
        hint: "Type a Travel H in the Jog panel that clears the board and its clamps: probing and gotos rise to it before going across.",
        panel: "jog",
    };
}

function probeStep(state: AppState): Step {
    return {
        label: "Probe",
        done: mapComplete(state.heightMap?.map ?? null),
        hint: "In the Height map panel press Fit to job, then Probe (or Probe pads for a probe that must land on copper).",
        panel: "heightmap",
    };
}

function focusStep(state: AppState, milling: boolean): Step {
    return {
        label: milling ? "Touch off" : "Focus",
        done: state.heightMap?.map?.focus_set === true,
        hint: milling
            ? "Jog the tool down until it just touches the copper over the probed area, then press Touch off here."
            : "Focus the beam by eye over the probed area with the focus axis, then press Focus here.",
        panel: "heightmap",
    };
}

function followStep(state: AppState): Step {
    const progress = state.progress ?? state.snapshot.run;
    const following = runActive(progress) && progress?.compensate !== undefined && progress.compensate !== "off";
    const planned = mapUse(state.mapChoice, state.heightMap?.map ?? null, state.job, profileOf(state.snapshot));
    return {
        label: "Map on",
        done: following || planned.kind === "on",
        hint: `Pick height map: auto beside Run; the chip there says map on once a run will follow the map. Now: ${planned.detail}`,
        panel: "run",
    };
}

function runStep(state: AppState): Step {
    const progress = state.progress ?? state.snapshot.run;
    return {
        label: "Run",
        done: progress !== null && progress.job === state.job?.id && progress.state === "done",
        hint: "Press Run; while it lasts the status bar says whether it follows the map.",
        panel: "run",
    };
}

// --- the setups ---------------------------------------------------------------

export const SETUPS: Setup[] = [
    {
        id: "map",
        label: "Probe and follow a height map",
        fits: (state) => profileOf(state.snapshot).h_axis && !isMilling(state.snapshot),
        steps: (state) => [connectStep(state), jobStep(state), travelStep(state), probeStep(state), focusStep(state, false), followStep(state), runStep(state)],
    },
    {
        id: "mill",
        label: "Mill a board",
        fits: (state) => isMilling(state.snapshot),
        steps: (state) => [connectStep(state), jobStep(state), travelStep(state), probeStep(state), focusStep(state, true), followStep(state), runStep(state)],
    },
    {
        id: "camera",
        label: "Measure the camera offset",
        steps: (state) => {
            const camera = state.camera;
            return [
                connectStep(state),
                { label: "Camera on", done: camera?.running === true, hint: "In the Camera panel pick the camera (Detect lists the ones attached) or type its device, then press Start.", panel: "camera" },
                {
                    label: "Mark",
                    done: camera?.mark !== null && camera?.mark !== undefined,
                    hint: "Make mark cuts a mark with the tool (a spindle); on another machine make one by hand and press Mark is here over it.",
                    panel: "camera",
                },
                {
                    label: "Find mark",
                    done: camera?.routine?.state === "done",
                    hint: "Press Find mark: the head goes where the camera should see the mark and centers the picture on it, which measures the offset.",
                    panel: "camera",
                },
            ];
        },
    },
];

// --- the panel ----------------------------------------------------------------

/** The page a panel is on, from the page element around it. */
function pageOf(node: Element): PageId | null {
    const id = node.closest("main.page")?.id.replace(/^page-/, "");
    return PAGES.find((page) => page.id === id)?.id ?? null;
}

/** Takes the page to a panel: its tab, the panel scrolled into view, and a short flash on it. */
export function goToPanel(id: string): void {
    const node = document.getElementById(id);
    if (!node) {
        return;
    }
    const page = pageOf(node);
    if (page !== null) {
        showPage(page);
    }
    if (typeof node.scrollIntoView === "function") {
        node.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    node.classList.remove("flash");
    // Read back so a flash started again restarts its animation.
    void node.offsetWidth;
    node.classList.add("flash");
    setTimeout(() => node.classList.remove("flash"), 1600);
}

/** The setups that fit the machine; every one before a machine is connected, since which it is is not known yet. */
export function setupsFor(setups: Setup[], state: AppState): Setup[] {
    if (!state.snapshot.connected) {
        return setups;
    }
    const fitting = setups.filter((setup) => setup.fits?.(state) ?? true);
    return fitting.length > 0 ? fitting : setups.slice(0, 1);
}

/**
 * Mounts a steps panel in `root` offering `setups`: of a list, the ones the
 * connected machine fits; a function picks the setups offered from the
 * state itself. `key` names what is remembered of the panel (the setup
 * picked, the fold), so another page can have a panel of its own.
 */
export function mountSteps(root: HTMLElement, ctx: Ctx, setups: Setup[] | ((state: AppState) => Setup[]) = SETUPS, key = "spinny.steps"): void {
    const pick = el("select", { class: "field", "aria-label": "Setup" }) as HTMLSelectElement;
    const list = el("ol", { class: "roadmap" });
    const next = el("p", { class: "muted hint roadmap-next" });
    // How far the setup has got, in the head, which shows while folded.
    const count = el("span", { class: "badge roadmap-count" });
    root.append(foldPanel(`${key}.open`,
        el("summary", { class: "panel-head" }, el("h2", {}, "Setup"), count),
        el("div", { class: "panel-body" }, el("div", { class: "button-row" }, pick), list, next),
    ));

    let chosen = readStored(`${key}.setup`);
    let offered = "";
    let drawn = "";
    pick.addEventListener("change", () => {
        chosen = pick.value;
        writeStored(`${key}.setup`, chosen);
        render(ctx.store.get());
    });

    function render(state: AppState): void {
        const fitting = typeof setups === "function" ? setups(state) : setupsFor(setups, state);
        const ids = fitting.map((setup) => setup.id).join(" ");
        if (ids !== offered) {
            offered = ids;
            replace(pick, ...fitting.map((setup) => el("option", { value: setup.id }, setup.label)));
        }
        const setup = fitting.find((entry) => entry.id === chosen) ?? fitting[0]!;
        pick.value = setup.id;
        const steps = setup.steps(state);
        const states = stepStates(steps);
        // Rebuilt only when what the row shows changes: the store changes
        // with every status report, and a button replaced between a press
        // and its release takes no click.
        const shown = JSON.stringify([setup.id, steps.map((step) => [step.label, step.hint, step.panel]), states]);
        if (shown !== drawn) {
            drawn = shown;
            drawSteps(steps, states);
        }
        const at = states.indexOf("next");
        next.textContent = at < 0 ? "Every step is done." : `Next, ${steps[at]!.label}: ${steps[at]!.hint}`;
        const done = states.filter((entry) => entry === "done").length;
        count.textContent = `${done} of ${steps.length}`;
        count.setAttribute("data-apply", done === steps.length ? "applied" : "pending");
    }

    function drawSteps(steps: Step[], states: StepState[]): void {
        replace(list, ...steps.map((step, index) => {
            const item = el("li", { class: "roadmap-step", "data-step": states[index]! },
                el("button", { type: "button", class: "roadmap-button", title: step.hint, onclick: () => goToPanel(step.panel) },
                    el("span", { class: "roadmap-dot" }, String(index + 1)),
                    el("span", { class: "roadmap-label" }, step.label),
                ),
            );
            if (states[index] === "next") {
                item.setAttribute("aria-current", "step");
            }
            return item;
        }));
        // A row wider than its panel scrolls by itself to the next step.
        const current = list.querySelector<HTMLElement>('[aria-current="step"]');
        if (current && list.scrollWidth > list.clientWidth) {
            list.scrollLeft = Math.max(0, current.offsetLeft - (list.clientWidth - current.offsetWidth) / 2);
        }
    }

    ctx.store.subscribe((state) => render(state), ["snapshot", "settings", "job", "heightMap", "camera", "progress", "mapChoice", "pnp", "components", "device", "pnpTarget"]);
    render(ctx.store.get());
}
