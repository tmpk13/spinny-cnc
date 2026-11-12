// What a goto will do, in words, before it is sent: which axes move from
// where to where, in the order the moves run, with the height the head
// rises to on the way. The backend decides the moves; this says the same
// thing it will do, so the operator sees what Go moves before pressing it.
//
// - A G-code machine (the backend's openpnp.goto_lines) goes up to its
//   safe height only to go across (X or Y changing), from either side of
//   it, turns the nozzle with the move across, and puts the height last,
//   skipping a height already reached.
// - This project's firmware (App._goto and _travel_rise) rises to the
//   travel height first when one is set, the goto moves something across
//   and does not name the height itself, and the head is below it; then
//   the joints named go together.

import type { JointAxis } from "./types.ts";

/** Places closer than this, mm or degrees, are the same place: the backend's tolerance. */
const SAME = 1e-6;

/** One axis moving: its letter, where it is (null when unknown) and where it goes. */
export interface PlanMove {
    letter: string;
    from: number | null;
    to: number;
}

/** What the plan is made from. */
export interface PlanInput {
    /** The machine's own G-code controller rather than this project's firmware. */
    gcode: boolean;
    /** The G-code machine's safe height, or the firmware's travel height (null: off). */
    height: number | null;
    /** The joints where the head is now; null for one not reported. */
    here: Partial<Record<JointAxis, number | null>>;
    /** The board point under the head now, for a board goto; null when unknown. */
    board: { x: number; y: number } | null;
    /** The letter each joint shows by in the jog panel. */
    letters: Partial<Record<JointAxis, string>>;
}

/** What is asked: a board point, or joints; a field left blank is left out. */
export type PlanWant = { kind: "board"; x?: number; y?: number } | { kind: "joint"; r?: number; a?: number; z?: number; h?: number };

/** A number as the plan writes it: at most three decimals, no trailing zeros. */
export function planNumber(value: number): string {
    return String(Number(value.toFixed(3)));
}

function differs(from: number | null | undefined, to: number): boolean {
    return from === null || from === undefined || Math.abs(to - from) > SAME;
}

function moveText(move: PlanMove): string {
    return move.from === null ? `${move.letter} to ${planNumber(move.to)}` : `${move.letter} ${planNumber(move.from)} to ${planNumber(move.to)}`;
}

/**
 * The moves a goto makes, as steps run one after another; the moves in
 * one step go together. Empty when the head is already there.
 */
export function gotoSteps(input: PlanInput, want: PlanWant): PlanMove[][] {
    const letter = (axis: JointAxis): string => input.letters[axis] ?? axis.toUpperCase();
    const here = (axis: JointAxis): number | null => input.here[axis] ?? null;
    const steps: PlanMove[][] = [];
    if (input.gcode) {
        // The joints are the cartesian machine's: r is X, z is Y, h is Z,
        // a the turn; a board point is X and Y.
        const target: Partial<Record<JointAxis, number>> = want.kind === "board"
            ? { ...(want.x !== undefined ? { r: want.x } : {}), ...(want.y !== undefined ? { z: want.y } : {}) }
            : { r: want.r, a: want.a, z: want.z, h: want.h };
        const across = (["r", "z"] as JointAxis[]).filter((axis) => target[axis] !== undefined && differs(here(axis), target[axis]!));
        let height = here("h");
        if (across.length > 0) {
            if (input.height !== null && differs(height, input.height)) {
                steps.push([{ letter: letter("h"), from: height, to: input.height }]);
                height = input.height;
            }
            const flat = across.map((axis) => ({ letter: letter(axis), from: here(axis), to: target[axis]! }));
            if (target.a !== undefined && differs(here("a"), target.a)) {
                flat.push({ letter: letter("a"), from: here("a"), to: target.a });
            }
            steps.push(flat);
        } else if (target.a !== undefined && differs(here("a"), target.a)) {
            steps.push([{ letter: letter("a"), from: here("a"), to: target.a }]);
        }
        if (target.h !== undefined && differs(height, target.h)) {
            steps.push([{ letter: letter("h"), from: height, to: target.h }]);
        }
        return steps;
    }
    const acrossAsked = want.kind === "board" || want.r !== undefined || want.a !== undefined || want.z !== undefined;
    const height = here("h");
    const named = want.kind === "joint" && want.h !== undefined;
    if (input.height !== null && acrossAsked && !named && height !== null && height < input.height - SAME) {
        steps.push([{ letter: letter("h"), from: height, to: input.height }]);
    }
    const main: PlanMove[] = [];
    if (want.kind === "board") {
        for (const [name, value] of [["X", want.x], ["Y", want.y]] as [string, number | undefined][]) {
            const from = input.board ? (name === "X" ? input.board.x : input.board.y) : null;
            if (value !== undefined && differs(from, value)) {
                main.push({ letter: name, from, to: value });
            }
        }
    } else {
        for (const axis of ["r", "a", "z", "h"] as JointAxis[]) {
            const value = want[axis];
            if (value !== undefined && differs(here(axis), value)) {
                main.push({ letter: letter(axis), from: here(axis), to: value });
            }
        }
    }
    if (main.length > 0) {
        steps.push(main);
    }
    return steps;
}

/** The plan as one line: "Z 5 to 31.5, then X 12 to 50, then Z 31.5 to 5". */
export function gotoPlanText(input: PlanInput, want: PlanWant): string {
    const steps = gotoSteps(input, want);
    if (steps.length === 0) {
        return "Go: already there.";
    }
    return `Go: ${steps.map((step) => step.map(moveText).join(" and ")).join(", then ")}.`;
}
