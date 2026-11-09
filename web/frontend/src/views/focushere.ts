// A run or a pickup the backend refuses until the operator says the head
// is at focus where it stands.

import { ApiError } from "../api.ts";
import { askConfirm } from "../confirm.ts";
import type { Ctx } from "./context.ts";

/**
 * How the backend ends a refusal only the operator's word can lift: a laser
 * group's own focus would count from a height nothing vouches for, because
 * the last run of the job stopped with the head elsewhere, or the focus
 * axis was renumbered since the run being picked up began.
 */
const ASKS_FOCUS_HERE = / with focus here$/;

/**
 * Makes a request (`attempt(false)`), and when the backend refuses it for
 * want of the operator's word that the head is at focus where it stands,
 * shows the refusal and asks for that word, then makes it again with it.
 * A failure becomes a toast. Undefined when the request failed or the
 * operator declined; otherwise what it gave and whether the word was given.
 */
export async function withFocusHere<T>(
    ctx: Ctx,
    attempt: (focusHere: boolean) => Promise<T>,
    okLabel: string,
): Promise<{ value: T; focusHere: boolean } | undefined> {
    let refusal: string;
    try {
        return { value: await attempt(false), focusHere: false };
    } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 409 || !ASKS_FOCUS_HERE.test(error.message)) {
            ctx.toast("error", error instanceof Error ? error.message : String(error));
            return undefined;
        }
        refusal = error.message;
    }
    const asked = `${refusal.charAt(0).toUpperCase()}${refusal.slice(1)}. Is the beam focused with the head where it is now?`;
    if (!(await askConfirm(asked, okLabel))) {
        return undefined;
    }
    try {
        return { value: await attempt(true), focusHere: true };
    } catch (error) {
        ctx.toast("error", error instanceof Error ? error.message : String(error));
        return undefined;
    }
}
