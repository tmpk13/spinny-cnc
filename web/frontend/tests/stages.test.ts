// The stages of a run: which there are for the machine connected, each
// done from the state, the panel each goes to, and what is so in words.

import { describe, expect, test } from "bun:test";
import { initialState } from "../src/state.ts";
import type { Job, JobSummary, Progress } from "../src/types.ts";
import { heightText, jobStages, nextStage, placeText, placingStages, runStages, runText } from "../src/views/stages.ts";
import { connected } from "./harness.ts";

const summary = { id: "a1", name: "board", source: "gerber", spot: 0.1, offset: { x: 1.5, y: -2 }, rotation: 0, groups: [], stats: { length_mm: 120, seconds: 90 } } as unknown as JobSummary;
const job = { ...summary, outline: [], copper: [], groups: [] } as unknown as Job;
const progress: Progress = { job: "a1", state: "running", sent: 60, acked: 50, total: 200, seconds: 3, estimate: 9, group: 0 } as Progress;

describe("the stages of a run", () => {
    test("a laser or a mill: connect, job, board, height, run; each done from the state", () => {
        const state = initialState(true);
        const before = jobStages(state);
        expect(before.map((stage) => stage.id)).toEqual(["connect", "job", "board", "height", "run"]);
        expect(before.map((stage) => stage.done)).toEqual([false, false, false, false, false]);
        expect(before.map((stage) => stage.optional)).toEqual([false, false, true, true, false]);
        const after = jobStages({ ...state, snapshot: connected(), jobs: [summary], job });
        expect(after.map((stage) => stage.done)).toEqual([true, true, false, false, false]);
        // A run of the job picked that ran to its end.
        const done = jobStages({ ...state, snapshot: connected(), jobs: [summary], job, progress: { ...progress, state: "done" } });
        expect(done.at(-1)?.done).toBe(true);
    });

    test("each names the panel that does it", () => {
        expect(jobStages(initialState(true)).map((stage) => stage.panel)).toEqual(["connection", "jobs", "place", "heightmap", "run"]);
        expect(placingStages(initialState(true)).map((stage) => stage.panel)).toEqual(["connection", "machine", "pnp-board", "place", "pnp-feeders", "pnp-run"]);
    });

    test("a machine with no axis for heights has no Height stage", () => {
        const state = initialState(true);
        const plain = connected({}, { profile: { kinematics: "polar", tool: "laser", h_axis: false, r_max: 0, z_max: 0 } });
        expect(jobStages({ ...state, snapshot: plain }).map((stage) => stage.id)).toEqual(["connect", "job", "board", "run"]);
        const mill = connected({}, { profile: { kinematics: "cartesian", tool: "spindle", h_axis: true, r_max: 0, z_max: 0 } });
        expect(jobStages({ ...state, snapshot: mill }).map((stage) => stage.id)).toContain("height");
    });

    test("the work stands at the first stage a run needs that is not done, else the last", () => {
        const state = initialState(true);
        expect(nextStage(jobStages(state))?.id).toBe("connect");
        expect(nextStage(jobStages({ ...state, snapshot: connected() }))?.id).toBe("job");
        // Board and Height can be done without: a job picked leads to the run.
        expect(nextStage(jobStages({ ...state, snapshot: connected(), job }))?.id).toBe("run");
        expect(nextStage([])).toBeNull();
    });

    test("a G-code pick and place machine has its own stages", () => {
        const stages = placingStages(initialState(true));
        expect(stages.map((stage) => stage.label)).toEqual(["Connect", "Home", "Parts", "Board", "Feeders", "Place"]);
        expect(runStages(initialState(true)).map((stage) => stage.id)).toEqual(jobStages(initialState(true)).map((stage) => stage.id));
    });

    test("what is so in a stage, in words", () => {
        const state = initialState(true);
        expect(placeText(state)).toBe("No job picked yet.");
        expect(placeText({ ...state, job })).toBe("The job sits at X 1.5 Y -2 mm, not turned.");
        expect(placeText({ ...state, job: { ...job, rotation: 90 } as Job })).toBe("The job sits at X 1.5 Y -2 mm, turned 90 deg.");
        expect(heightText(state)).toBe("No travel height; no height map.");
        expect(runText({ ...state, jobs: [summary], job })).toBe("board: 120.0 mm, about 1:30.");
        expect(runText({ ...state, jobs: [summary], job, progress })).toBe("Running board: 25%.");
        expect(runText({ ...state, jobs: [summary], job, progress: { ...progress, state: "done" } })).toBe("board is done.");
        expect(jobStages({ ...state, job }).find((stage) => stage.id === "board")?.line).toBe("The job sits at X 1.5 Y -2 mm, not turned.");
    });
});
