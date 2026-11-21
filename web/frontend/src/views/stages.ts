// The stages of a run, read from the page's state. For a laser, a mill or
// a dispenser of this project's firmware: connect, pick the job, say where
// the board sits, set the heights when the machine has an axis for them,
// run. For a G-code pick and place machine: connect, home, pick the board
// and its parts, say where it sits, check the feeders, place. Each stage
// is done or not by the state, says what is so in a line, and names the
// panel that does it. Home's Next panel goes on with the first stage a run
// needs that is not done; Auto (src/views/autosteps.ts) names the stage
// each of its moves is in.
//
// The stages were once the Run area's steps, a view of a few panels each;
// since the areas show their panels by mode (src/modes.ts), a stage only
// says which panel to go to.

import { formatDuration, formatLength } from "../format.ts";
import { machineInUse } from "../machineuse.ts";
import { isMilling, profileBadge, profileOf } from "../profile.ts";
import type { AppState } from "../state.ts";
import { feedersDone, feedersLine } from "./feedercheck.ts";
import { mapComplete, mapUsable, runActive } from "./heightmap.ts";
import { gcodePlacing, referencesOf } from "./placing.ts";

export interface Stage {
    id: string;
    label: string;
    /** What the stage is for, in a phrase. */
    tip: string;
    /** Whether the state shows it done. */
    done: boolean;
    /** Whether a run can do without it. */
    optional: boolean;
    /** What is so now, in one line. */
    line: string;
    /** The panel, or part of one, that does it. */
    panel: string;
}

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
 * The stages of running a job on a laser, a mill or a dispenser of this
 * project's firmware. Before a machine is connected nothing is known of
 * it, and the heights are among them. The board's place is never done:
 * the page cannot tell whether the board was placed.
 */
export function jobStages(state: AppState): Stage[] {
    const connected = state.snapshot.connected;
    const job = state.job;
    const profile = profileOf(state.snapshot);
    const heights = !connected || profile.h_axis || isMilling(state.snapshot);
    const progress = state.progress ?? state.snapshot.run;
    const stages: (Stage | null)[] = [
        {
            id: "connect",
            label: "Connect",
            tip: "connect the machine",
            done: connected,
            optional: false,
            line: connected ? `${machineName(state)} is connected.` : "No machine is connected.",
            panel: "connection",
        },
        {
            id: "job",
            label: "Job",
            tip: "pick the job to run",
            done: job !== null,
            optional: false,
            line: job === null ? "No job picked yet." : `${job.name}: ${formatLength(job.stats.length_mm)}, about ${formatDuration(job.stats.seconds)}.`,
            panel: "jobs",
        },
        {
            id: "board",
            label: "Board",
            tip: "say where the board sits on the machine: by hand, by camera or by marks",
            done: false,
            optional: true,
            line: placeText(state),
            panel: "place",
        },
        heights ? {
            id: "height",
            label: "Height",
            tip: "the height moves cross at, the board's height map and the focus",
            done: mapUsable(state.heightMap?.map ?? null),
            optional: true,
            line: heightText(state),
            panel: "heightmap",
        } : null,
        {
            id: "run",
            label: "Run",
            tip: "run the job, hold it, stop it",
            done: progress !== null && job !== null && progress.job === job.id && progress.state === "done",
            optional: false,
            line: runText(state),
            panel: "run",
        },
    ];
    return stages.filter((stage): stage is Stage => stage !== null);
}

/** How each kind of reference was taken, as the Board stage says it. */
const TAKEN_BY: Record<string, string> = {
    nozzle: "the nozzle", camera: "the camera", fiducial: "fiducials found", look: "the camera's look", corners: "corners taken", corner: "corners taken",
};

/** A board's references in a line: how many, and how they were taken. */
export function referencesText(references: { by?: string }[]): string {
    const ways = Array.from(new Set(references.map((entry) => TAKEN_BY[entry.by ?? "nozzle"] ?? "hand")));
    return `${references.length} ${references.length === 1 ? "reference" : "references"} taken, by ${ways.join(" and ")}.`;
}

/** The stages of placing parts with a G-code pick and place machine. */
export function placingStages(state: AppState): Stage[] {
    const placing = state.placing;
    const jobId = state.job?.id ?? null;
    const parts = state.components !== null && state.components.job === jobId ? state.components.components.length : 0;
    const taken = referencesOf(placing, jobId);
    const references = taken.length;
    return [
        {
            id: "connect",
            label: "Connect",
            tip: "connect the machine",
            done: placing?.connected === true,
            optional: false,
            line: placing?.connected === true ? `${machineName(state)} is connected.` : "No machine is connected.",
            panel: "connection",
        },
        {
            // Home and Home by fiducial are in the Machine panel's head.
            id: "home",
            label: "Home",
            tip: "home the machine, by its switches and by the bed's fiducial",
            done: placing?.homed === true,
            optional: false,
            line: placing?.homed === true ? "The machine is homed." : "The machine is not homed yet.",
            panel: "machine",
        },
        {
            id: "parts",
            label: "Parts",
            tip: "pick the board and the parts to place",
            done: parts > 0,
            optional: false,
            line: parts > 0 ? `${parts} ${parts === 1 ? "part" : "parts"} on the board picked.` : "No board picked yet.",
            panel: "pnp-board",
        },
        {
            id: "board",
            label: "Board",
            tip: "say where the board sits on the bed: by the camera or by references",
            done: references > 0,
            optional: false,
            line: references > 0 ? referencesText(taken) : "The board's place is not known yet: find it by the camera, or take a reference.",
            panel: "place",
        },
        {
            // Done when the feeder check says a run would place every part:
            // each has a feeder, each feeder's place is known, none is short.
            id: "feeders",
            label: "Feeders",
            tip: "what is loaded, low or missing",
            done: feedersDone(state),
            optional: false,
            line: feedersLine(state),
            panel: "pnp-feeders",
        },
        {
            id: "run",
            label: "Place",
            tip: "plan the placing, run it, stop it",
            done: placing?.progress?.state === "done",
            optional: false,
            line: placing?.running === true ? "Placing." : placing?.progress?.state === "done" ? "The board is placed." : "Not placed yet.",
            panel: "pnp-run",
        },
    ];
}

/** The stages of a run on the machine connected. */
export function runStages(state: AppState): Stage[] {
    return gcodePlacing(state) ? placingStages(state) : jobStages(state);
}

/** The stage the work stands at: the first one a run needs that is not done, else the last. */
export function nextStage(stages: Stage[]): Stage | null {
    return stages.find((stage) => !stage.optional && !stage.done) ?? stages[stages.length - 1] ?? null;
}
