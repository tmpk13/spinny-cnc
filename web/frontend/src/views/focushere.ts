// A run or a pickup the backend refuses until the operator gives their word
// on what nothing else can vouch for.

import { ApiError, errorText } from "../api.ts";
import { askConfirm } from "../confirm.ts";
import type { Ctx } from "./context.ts";

/** A refusal the operator's word lifts: how the backend ends it, and what to ask. */
export interface Word<K extends string> {
    key: K;
    ends: RegExp;
    question: string;
    okLabel: string;
}

/**
 * A laser group's own focus would count from a height nothing vouches for:
 * the last run of the job stopped with the head elsewhere, or the focus
 * axis was renumbered since the run being picked up began.
 */
export function focusHereWord(okLabel: string): Word<"focus_here"> {
    return { key: "focus_here", ends: / with focus here$/, question: "Is the beam in focus with the head where it is now?", okLabel };
}

/** The job's plan changed since the run being picked up stopped, so its count is another line now. */
export function changedWord(line: number): Word<"changed"> {
    return {
        key: "changed",
        ends: / a line counted in the job as it is now$/,
        question: `Pick it up at line ${line} of the job as it is now? Its lines differ from the stopped run's.`,
        okLabel: "Pick up the changed job",
    };
}

/**
 * Makes a request with no word given, and each time the backend refuses it
 * for want of one of `words`, shows the refusal, asks for that word and
 * makes it again with it. A failure becomes a toast. Undefined when the
 * request failed or the operator declined; otherwise what it gave and the
 * words given.
 */
export async function withWords<T, K extends string>(
    ctx: Ctx,
    words: Word<K>[],
    attempt: (given: ReadonlySet<K>) => Promise<T>,
): Promise<{ value: T; given: ReadonlySet<K> } | undefined> {
    const given = new Set<K>();
    for (;;) {
        try {
            return { value: await attempt(given), given };
        } catch (error) {
            const refusal = error instanceof ApiError && error.status === 409 ? error.message : null;
            const word = refusal === null ? undefined : words.find((each) => !given.has(each.key) && each.ends.test(refusal));
            if (refusal === null || word === undefined) {
                ctx.toast("error", errorText(error));
                return undefined;
            }
            const asked = `${refusal.charAt(0).toUpperCase()}${refusal.slice(1)}. ${word.question}`;
            if (!(await askConfirm(asked, word.okLabel))) {
                return undefined;
            }
            given.add(word.key);
        }
    }
}

/** `withWords` for the one word that the head is at focus where it stands. */
export async function withFocusHere<T>(
    ctx: Ctx,
    attempt: (focusHere: boolean) => Promise<T>,
    okLabel: string,
): Promise<{ value: T; focusHere: boolean } | undefined> {
    const done = await withWords(ctx, [focusHereWord(okLabel)], (given) => attempt(given.has("focus_here")));
    return done === undefined ? undefined : { value: done.value, focusHere: done.given.has("focus_here") };
}
