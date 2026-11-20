// The feeder check: the picked board's parts against the placing
// machine's feeders, as a plan of them would take them (the backend's
// POST /api/pnp/feeders/check: nothing moves and the bus is not asked).
// The Run area's Feeders step is done when it says a run would place every
// part, and its line counts what it found; the Feeders panel lists the
// parts no feeder holds. It is asked again when what it depends on changes
// (a board or its parts picked, the machine file, the counts, the machine
// connected or gone) and after a scan of the bus, which changes where the
// backend last saw each feeder. It is never polled.

import { errorText } from "../api.ts";
import type { AppState, FeederCheckState, Store } from "../state.ts";
import type { FeederCheck } from "../types.ts";
import type { Ctx } from "./context.ts";
import { pickedToPlace, placeRefs } from "./partsfilter.ts";
import { gcodePlacing } from "./placing.ts";

/** A footprint's name without its library. */
export function footprintName(footprint: string): string {
    const at = footprint.indexOf(":");
    return at >= 0 ? footprint.slice(at + 1) : footprint;
}

/** What a check asks about: the board job picked, the parts a plan of it would ask for (undefined: every one that can be), and its parts as listed. */
export interface CheckAsk {
    job: string;
    refs: string[] | undefined;
    parts: string[];
}

/** What a check asks about now; null with no G-code machine to place with, no board picked, or its parts not read yet. */
export function checkAsk(state: AppState): CheckAsk | null {
    if (!gcodePlacing(state) || (state.placing?.machine ?? null) === null) {
        return null;
    }
    const job = state.job;
    const parts = job !== null && state.components?.job === job.id ? state.components.components : [];
    if (job === null || parts.length === 0) {
        return null;
    }
    return { job: job.id, refs: placeRefs(parts, pickedToPlace(job.id)), parts: parts.filter((part) => part.filtered !== true).map((part) => part.ref) };
}

/** Everything in the page's state an answer depends on, as a key: the question, the machine and whether it is connected, its file's feeders and slots, the counts. */
export function checkKey(state: AppState, ask: CheckAsk): string {
    const placing = state.placing;
    const doc = placing?.document ?? null;
    return JSON.stringify([ask, placing?.machine ?? null, placing?.connected === true, doc?.bus ?? false, doc?.feeders ?? [], doc?.slots ?? [], placing?.taken ?? {}]);
}

/** Per store: the newest question sent and the key it was sent for, null once answered. */
const asking = new WeakMap<Store<AppState>, { seq: number; key: string | null }>();

/**
 * Asks for the check again when what it depends on changed since the last
 * answer, or always with `force` (after a scan, which changes where the
 * backend last saw the feeders); with nothing to check, the last answer is
 * let go. An answer overtaken by a newer question is dropped. A check that
 * fails is kept with its reason, for the step to say: it runs by itself,
 * so a toast would come with every change.
 */
export async function refreshFeederCheck(ctx: Ctx, force = false): Promise<void> {
    const state = ctx.store.get();
    const ask = checkAsk(state);
    const flight = asking.get(ctx.store) ?? { seq: 0, key: null };
    if (ask === null) {
        asking.set(ctx.store, { seq: flight.seq + 1, key: null });
        if (state.feederCheck !== null) {
            ctx.store.set({ feederCheck: null });
        }
        return;
    }
    const key = checkKey(state, ask);
    if (!force && (flight.key === key || (flight.key === null && state.feederCheck?.key === key))) {
        return;
    }
    const seq = flight.seq + 1;
    asking.set(ctx.store, { seq, key });
    let check: FeederCheck | null = null;
    let error: string | null = null;
    try {
        check = await ctx.api.pnpFeederCheck(ask.job, ask.refs);
    } catch (failure) {
        error = errorText(failure);
    }
    if (asking.get(ctx.store)?.seq !== seq) {
        return;
    }
    asking.set(ctx.store, { seq, key: null });
    ctx.store.set({ feederCheck: { key, job: ask.job, check, error } });
}

/** Keeps the check up to date with the page's state; the returned function stops it. */
export function watchFeederCheck(ctx: Ctx): () => void {
    const stop = ctx.store.subscribe(() => void refreshFeederCheck(ctx), ["snapshot", "job", "components", "placing"]);
    void refreshFeederCheck(ctx);
    return stop;
}

/** The answer for the board picked now; null before it is back. */
export function currentCheck(state: AppState): FeederCheckState | null {
    const ask = checkAsk(state);
    const kept = state.feederCheck;
    return ask !== null && kept !== null && kept.job === ask.job ? kept : null;
}

/** Parts by reference in words: "R3", "R3 and R4", "R3, R4 and R5", past `most` "R3, R4 and 5 more". */
export function refsText(refs: string[], most = 3): string {
    if (refs.length <= 1) {
        return refs[0] ?? "";
    }
    if (refs.length > most) {
        return `${refs.slice(0, most - 1).join(", ")} and ${refs.length - most + 1} more`;
    }
    return `${refs.slice(0, -1).join(", ")} and ${refs[refs.length - 1]}`;
}

/** How many feeders' wants a line names before it counts the rest. */
const WANTS_SAID = 2;

/**
 * What a check found, in one line: how many parts come from how many
 * feeders, the parts no feeder holds, and the feeders whose place is not
 * known or that have fewer parts left than the job takes from them.
 */
export function checkLine(check: FeederCheck): string {
    if (check.parts.length === 0) {
        return "The board has no part to place.";
    }
    const fed = check.parts.filter((part) => part.feeder !== null).length;
    const loose = check.parts.filter((part) => part.feeder === null).map((part) => part.ref);
    const feeders = check.feeders.length;
    const said: string[] = [];
    if (fed > 0) {
        said.push(`${fed} ${fed === 1 ? "part" : "parts"} from ${feeders} ${feeders === 1 ? "feeder" : "feeders"}`);
    }
    if (loose.length > 0) {
        said.push(`${refsText(loose)} ${loose.length === 1 ? "has" : "have"} no feeder`);
    }
    const wants: string[] = [];
    for (const feeder of check.feeders) {
        if (!feeder.place_known) {
            wants.push(`${feeder.id}'s place is not known`);
        }
        if (feeder.left !== null && feeder.left < feeder.needs) {
            wants.push(`${feeder.id} has ${feeder.left === 0 ? "none" : feeder.left} left of ${feeder.needs}`);
        }
    }
    if (wants.length > WANTS_SAID + 1) {
        const rest = wants.length - WANTS_SAID;
        said.push(...wants.slice(0, WANTS_SAID), `${rest} more ${rest === 1 ? "want" : "wants"} of the feeders`);
    } else {
        said.push(...wants);
    }
    if (check.ready) {
        return `${said[0]}: every place known, none short.`;
    }
    return `${said.join("; ")}.`;
}

/** The Feeders step's line: what the check says, or why there is none yet. */
export function feedersLine(state: AppState): string {
    if (checkAsk(state) === null) {
        return "No board picked yet: its parts say which feeders a run needs.";
    }
    const kept = currentCheck(state);
    if (kept === null) {
        return "Checking the feeders against the board's parts.";
    }
    if (kept.check === null) {
        return `The feeders could not be checked: ${kept.error ?? "no answer"}.`;
    }
    return checkLine(kept.check);
}

/** Whether the Feeders step is done: the check says a run would place every part of the board picked. */
export function feedersDone(state: AppState): boolean {
    return currentCheck(state)?.check?.ready === true;
}
