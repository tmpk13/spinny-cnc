// The views of each area. An area owns many panels; a view shows a few of
// them in set places, the work on the left as large as the window allows
// and what acts on it on the right, so a screen holds one thing to do
// instead of everything the area can do. The Run area's views are the
// steps of a run for the machine connected, in the order the work is done,
// each marked done from the page's own state. The Job area's are the ways
// to make a job. An area's last view is All: every panel, arranged by the
// layout tools as the operator left them.
//
// This file only says what each view holds; src/views/viewbar.ts shows the
// views across an area's top and src/views/panels.ts lays one out.

import { formatDuration, formatLength } from "../format.ts";
import { machineInUse } from "../machineuse.ts";
import { isMilling, profileBadge, profileOf } from "../profile.ts";
import type { AppState } from "../state.ts";
import { mapComplete, mapUsable, runActive } from "./heightmap.ts";
import { gcodePlacing, referencesOf } from "./placing.ts";
import type { PageId } from "./tabs.ts";

/** A step of a run: whether the state shows it done, and whether a run can do without it. */
export interface StepState {
    done: boolean;
    optional: boolean;
}

export interface AreaView {
    id: string;
    label: string;
    /** What the view is for, in a phrase: its tab's tooltip. */
    tip: string;
    /** The panels shown, by column: a panel's id, or a stack of ids shown one at a time under tabs. */
    columns: (string | string[])[][];
    /** The columns' widths on a wide window, as a grid's track list. */
    cols: string;
    /** Whether the last column is the dock: one panel laid along the foot of the view, under the others. */
    dock?: boolean;
    /** The panels folded when the view first shows. */
    folded?: string[];
    /** The panels brought to the front of their stacks. */
    front?: string[];
    /** For a step: its state, and what is so now in one line. */
    step?: StepState;
    line?: string;
}

/** The id of every area's last view: all its panels, as the operator arranged them. */
export const ALL_VIEW = "all";

/** The panels made for a view alone, by area: with every panel shown they are left out, as nothing there needs them. */
export const VIEW_ONLY: Partial<Record<PageId, readonly string[]>> = {
    run: ["run-connect", "run-job"],
};

/** The work beside one panel: the usual shape of a step. */
const WORK_AND_PANEL = "minmax(0, 1fr) minmax(19rem, 26rem)";

/** The machine connected, by the name its file gives it, else its kind. */
export function machineName(state: AppState): string {
    const use = machineInUse(state);
    return (use.how === "board" || use.how === "connected" ? use.name : null) ?? profileBadge(profileOf(state.snapshot));
}

/** Where a job sits on the machine, in words: its offset and its turn. */
export function placeText(state: AppState): string {
    const job = state.job;
    if (job === null) {
        return "No job picked yet.";
    }
    const turned = job.rotation ?? 0;
    const turn = Math.abs(turned) < 0.00005 ? "not turned" : `turned ${Number(turned.toFixed(2))} deg`;
    return `The job sits at X ${Number(job.offset.x.toFixed(2))} Y ${Number(job.offset.y.toFixed(2))} mm, ${turn}.`;
}

/** The heights a run goes by, in words: the travel height, the map, the focus. */
export function heightText(state: AppState): string {
    const travel = state.settings?.host.travel;
    const map = state.heightMap?.map ?? null;
    const across = travel === null || travel === undefined ? "No travel height" : `Travel height ${Number(travel.toFixed(2))} mm`;
    const milling = isMilling(state.snapshot);
    let board: string;
    if (map === null) {
        board = "no height map";
    } else if (!mapComplete(map)) {
        board = "a height map probed in part";
    } else if (!map.focus_set) {
        board = milling ? "a height map, not touched off" : "a height map, not focused";
    } else {
        board = "a height map ready";
    }
    return `${across}; ${board}.`;
}

/** What a run is doing or would do, in words. */
export function runText(state: AppState): string {
    const progress = state.progress ?? state.snapshot.run;
    const job = state.job;
    if (progress !== null && runActive(progress)) {
        const name = state.jobs.find((entry) => entry.id === progress.job)?.name ?? "a job";
        const share = progress.total > 0 ? Math.round((100 * progress.acked) / progress.total) : 0;
        return `${progress.state === "hold" ? "Holding" : "Running"} ${name}: ${share}%.`;
    }
    if (job === null) {
        return "No job picked yet.";
    }
    if (progress !== null && progress.job === job.id && progress.state === "done") {
        return `${job.name} is done.`;
    }
    return `${job.name}: ${formatLength(job.stats.length_mm)}, about ${formatDuration(job.stats.seconds)}.`;
}

/**
 * The steps of running a job on a laser, a mill or a dispenser of this
 * project's firmware: connect, pick the job, say where the board sits, set
 * the heights when the machine has an axis for them, run. Before a machine
 * is connected nothing is known of it, and every step shows.
 */
export function jobSteps(state: AppState): AreaView[] {
    const connected = state.snapshot.connected;
    const job = state.job;
    const profile = profileOf(state.snapshot);
    const heights = !connected || profile.h_axis || isMilling(state.snapshot);
    const progress = state.progress ?? state.snapshot.run;
    // The job's preview, with the head on it; the camera's picture behind
    // it, in front while the camera runs and the board is being found.
    const work: (string | string[])[] = [["run-preview", "camera-view"]];
    const looking = state.camera?.running === true;
    const steps: (AreaView | null)[] = [
        {
            id: "connect",
            label: "Connect",
            tip: "connect the machine",
            columns: [work, ["run-connect"], ["machine"]],
            cols: WORK_AND_PANEL,
            dock: true,
            step: { done: connected, optional: false },
            line: connected ? `${machineName(state)} is connected.` : "No machine is connected.",
        },
        {
            id: "job",
            label: "Job",
            tip: "pick the job to run",
            columns: [work, ["run-job"], ["machine"]],
            cols: WORK_AND_PANEL,
            dock: true,
            step: { done: job !== null, optional: false },
            line: job === null ? "No job picked yet." : `${job.name}: ${formatLength(job.stats.length_mm)}, about ${formatDuration(job.stats.seconds)}.`,
        },
        {
            id: "board",
            label: "Board",
            tip: "say where the board sits on the machine: by hand, by camera or by marks",
            columns: [work, ["place"], ["machine"]],
            cols: WORK_AND_PANEL,
            dock: true,
            front: looking ? ["camera-view"] : [],
            step: { done: false, optional: true },
            line: placeText(state),
        },
        heights ? {
            id: "height",
            label: "Height",
            tip: "the height moves cross at, the board's height map and the focus",
            columns: [work, ["heightmap"], ["machine"]],
            cols: WORK_AND_PANEL,
            dock: true,
            step: { done: mapUsable(state.heightMap?.map ?? null), optional: true },
            line: heightText(state),
        } : null,
        {
            id: "run",
            label: "Run",
            tip: "run the job, hold it, stop it",
            columns: [work, ["run", "console"], ["machine"]],
            cols: WORK_AND_PANEL,
            dock: true,
            folded: ["console"],
            step: { done: progress !== null && job !== null && progress.job === job.id && progress.state === "done", optional: false },
            line: runText(state),
        },
    ];
    return steps.filter((step): step is AreaView => step !== null);
}

/**
 * The steps of placing parts with a G-code pick and place machine:
 * connect, home, pick the board and its parts, say where the board sits,
 * load the feeders, place.
 */
export function placingSteps(state: AppState): AreaView[] {
    const placing = state.placing;
    const jobId = state.job?.id ?? null;
    const parts = state.components !== null && state.components.job === jobId ? state.components.components.length : 0;
    const references = referencesOf(placing, jobId).length;
    const cameras: (string | string[])[] = [["pnp-top-view", "pnp-view"]];
    return [
        {
            id: "connect",
            label: "Connect",
            tip: "connect the machine",
            columns: [cameras, ["run-connect"], ["machine"]],
            cols: WORK_AND_PANEL,
            dock: true,
            step: { done: placing?.connected === true, optional: false },
            line: placing?.connected === true ? `${machineName(state)} is connected.` : "No machine is connected.",
        },
        {
            // Homing is the machine's own: its panel, whole, beside the picture.
            id: "home",
            label: "Home",
            tip: "home the machine, by its switches and by the bed's fiducial",
            columns: [cameras, ["machine"]],
            cols: WORK_AND_PANEL,
            step: { done: placing?.homed === true, optional: false },
            line: placing?.homed === true ? "The machine is homed." : "The machine is not homed yet.",
        },
        {
            id: "parts",
            label: "Parts",
            tip: "pick the board and the parts to place",
            columns: [["pnp-board"], ["pnp-parts"], ["machine"]],
            cols: WORK_AND_PANEL,
            dock: true,
            step: { done: parts > 0, optional: false },
            line: parts > 0 ? `${parts} ${parts === 1 ? "part" : "parts"} on the board picked.` : "No board picked yet.",
        },
        {
            id: "board",
            label: "Board",
            tip: "say where the board sits on the bed: by the camera or by references",
            columns: [[["pnp-top-view", "pnp-board", "pnp-view"]], ["place"], ["machine"]],
            cols: WORK_AND_PANEL,
            dock: true,
            step: { done: references > 0, optional: false },
            line: references > 0 ? `${references} ${references === 1 ? "reference" : "references"} taken.` : "No reference taken yet.",
        },
        {
            id: "feeders",
            label: "Feeders",
            tip: "what is loaded, low or missing",
            columns: [["pnp-board"], ["pnp-feeders"], ["machine"]],
            cols: WORK_AND_PANEL,
            dock: true,
            step: { done: false, optional: true },
            line: "The feeders the parts come from.",
        },
        {
            id: "run",
            label: "Place",
            tip: "plan the placing, run it, stop it",
            columns: [[["pnp-board", "pnp-top-view", "pnp-view"]], ["run", "console"], ["machine"]],
            cols: WORK_AND_PANEL,
            dock: true,
            folded: ["console"],
            step: { done: placing?.progress?.state === "done", optional: false },
            line: placing?.running === true ? "Placing." : placing?.progress?.state === "done" ? "The board is placed." : "Not placed yet.",
        },
    ];
}

/** The Job area's views: the ways to make a job, each beside the one preview. */
export function jobViews(state: AppState): AreaView[] {
    const list = "minmax(16rem, 19rem)";
    return [
        {
            id: "jobs",
            label: "Jobs",
            tip: "the jobs, the one picked and its preview",
            // The picked job's own panel shows once a job is picked.
            columns: state.job === null ? [["jobs"], ["preview"]] : [["jobs"], ["preview"], ["job"]],
            cols: state.job === null ? `${list} minmax(0, 1fr)` : `${list} minmax(0, 1fr) minmax(20rem, 25rem)`,
        },
        {
            id: "draw",
            label: "Draw",
            tip: "draw a job by hand: drill, holes, lines, faces, pockets, profiles",
            columns: [["mill-operation"], ["preview"], ["job-machine"]],
            cols: "minmax(19rem, 24rem) minmax(0, 1fr) minmax(19rem, 23rem)",
        },
        {
            id: "assistant",
            label: "Assistant",
            tip: "describe a job to the assistant",
            columns: [["auto-chat", "auto-about"], ["preview"]],
            // What it can and cannot do is there to read once: folded, a press on its head away.
            folded: ["auto-about"],
            cols: "minmax(22rem, 2fr) minmax(0, 3fr)",
        },
        {
            id: "json",
            label: "JSON",
            tip: "the picked job as text",
            columns: [["jobjson"], ["preview"]],
            cols: "minmax(22rem, 2fr) minmax(0, 3fr)",
        },
    ];
}

/**
 * The Machines page's views: the machine and its file (which machine, its
 * port, the file's text), the file beside every key a file can set with
 * the board's own value (a press on a key goes to it in the file), and
 * making a machine file from OpenPnP's.
 */
export function machineViews(): AreaView[] {
    return [
        {
            id: "machine",
            label: "Machine",
            tip: "the machine connected, its port and its file",
            columns: [["connection", "machine-file"]],
            cols: "minmax(0, 64rem)",
        },
        {
            id: "keys",
            label: "Keys",
            tip: "every key a machine file can set, the file's value beside the board's",
            columns: [["machine-file"], ["settings"]],
            cols: "minmax(0, 3fr) minmax(24rem, 2fr)",
        },
        {
            id: "import",
            label: "Import",
            tip: "make a machine file from OpenPnP's machine.xml",
            columns: [["openpnp-import"]],
            cols: "minmax(0, 64rem)",
        },
    ];
}

/**
 * The Cameras page's views: a camera each, its settings beside its picture
 * controls, lens and colors, and changes, and the pick and place head and
 * bed. The bar lists the ones the machine connected has.
 */
export function cameraViews(): AreaView[] {
    const cols = "minmax(20rem, 2fr) minmax(0, 3fr)";
    return [
        {
            id: "head-camera",
            label: "Head camera",
            tip: "the camera on the head: its device, its place and scale, its routines",
            columns: [["camera"], [["camera-controls", "camera-sight", "camera-changes"]]],
            cols,
        },
        {
            id: "bottom-camera",
            label: "Bottom camera",
            tip: "the camera looking up at the nozzle, and the nozzle seen by it",
            columns: [["pnp-camera", "pnp-nozzle"], [["pnp-camera-controls", "pnp-camera-sight", "pnp-camera-changes"]]],
            cols,
        },
        {
            id: "top-camera",
            label: "Top camera",
            tip: "a pick and place machine's camera on its head",
            columns: [["pnp-top"], [["pnp-top-controls", "pnp-top-sight", "pnp-top-changes"]]],
            cols,
        },
        {
            id: "head",
            label: "Head and bed",
            tip: "a pick and place head's moves and heights, and the bed from above",
            columns: [["pnp-head"], ["pnp-machine-view"]],
            cols: "minmax(20rem, 2fr) minmax(0, 3fr)",
        },
    ];
}

/** The views an area offers besides All; none for an area shown whole. */
export function viewsOf(page: PageId, state: AppState): AreaView[] {
    switch (page) {
        case "run":
            return gcodePlacing(state) ? placingSteps(state) : jobSteps(state);
        case "job":
            return jobViews(state);
        case "machines":
            return machineViews();
        case "cameras":
            return cameraViews();
        default:
            return [];
    }
}

/** The panels a view holds, by id. */
export function viewPanels(view: AreaView): string[] {
    return view.columns.flatMap((column) => column.flatMap((entry) => (Array.isArray(entry) ? entry : [entry])));
}

/** Whether an area's views are steps, done in order. */
export function isSteps(views: AreaView[]): boolean {
    return views.some((view) => view.step !== undefined);
}

/**
 * The step to open on: the first one a run needs that is not done, else
 * the last, so the area opens where the work stands.
 */
export function stepToOpen(views: AreaView[]): string | null {
    const next = views.find((view) => view.step !== undefined && !view.step.optional && !view.step.done);
    return (next ?? views[views.length - 1])?.id ?? null;
}

/** The first view that shows a panel; null when none does. */
export function viewHolding(views: AreaView[], panel: string): string | null {
    return views.find((view) => viewPanels(view).includes(panel))?.id ?? null;
}
