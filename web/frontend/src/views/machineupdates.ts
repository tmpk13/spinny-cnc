// The machine files a release ships, offered against the operator's copies
// once it has been updated to: a file the operator does not have yet, or
// their copy with the release's changes merged in (keys added, values the
// release changed where the operator left them, the operator's own values
// kept). Each offer lists its changes and shows the difference it makes,
// to Take (written) or to Keep mine (left as it is, not offered again).
// The backend merges (spinny_web.shipped); a checkout ships none.

import { button, el, replace } from "../dom.ts";
import type { MachineOffer, MachineUpdates } from "../types.ts";
import type { Ctx } from "./context.ts";

/** What an offer says it is, in a few words. */
export function offerSummary(offer: MachineOffer): string {
    if (offer.status === "new") {
        return "new in this release";
    }
    if (offer.status === "problem") {
        return "could not be merged";
    }
    const kept = offer.changes.filter((line) => line.includes(": yours kept,")).length;
    const made = offer.changes.length - kept;
    const parts = [made > 0 ? `${made} change${made === 1 ? "" : "s"}` : "", kept > 0 ? `${kept} of yours kept` : ""].filter((part) => part !== "");
    return parts.join(", ") || "nothing to write";
}

/** A unified diff's lines, each marked as added, taken out, a hunk's head or context. */
export function diffLines(diff: string): { kind: "add" | "del" | "hunk" | "same"; text: string }[] {
    return diff.split("\n").filter((line, index, all) => line !== "" || index < all.length - 1).map((line) => {
        if (line.startsWith("@@")) {
            return { kind: "hunk", text: line };
        }
        if (line.startsWith("+") && !line.startsWith("+++")) {
            return { kind: "add", text: line };
        }
        if (line.startsWith("-") && !line.startsWith("---")) {
            return { kind: "del", text: line };
        }
        return { kind: "same", text: line };
    });
}

/**
 * The offers box in `root`; `changed` is told when a file was written, for
 * the machine file panel to read it again.
 */
export function mountMachineUpdates(root: HTMLElement, ctx: Ctx, changed: () => Promise<void>): { refresh(): Promise<void> } {
    root.classList.add("stack", "machine-updates", "hidden");

    function draw(updates: MachineUpdates | undefined): void {
        const offers = updates?.files ?? [];
        root.classList.toggle("hidden", offers.length === 0);
        replace(root,
            el("p", { class: "machine-updates-head" },
                `This release has ${offers.length === 1 ? "a machine file" : `${offers.length} machine files`} for you: your values are kept, its additions merged in.`),
            ...offers.map((offer) => drawOffer(offer)),
        );
    }

    function drawOffer(offer: MachineOffer): HTMLElement {
        const take = button(offer.status === "new" ? "Add it" : "Take", () => decide(offer, true), "btn btn-primary btn-small",
            offer.status === "new" ? `add ${offer.id}.toml to your machine files` : `write ${offer.id}.toml as merged: your values kept, the release's changes in`);
        const keep = button("Keep mine", () => decide(offer, false), "btn btn-quiet btn-small", "leave your file as it is; this release does not offer it again");
        const diff = el("pre", { class: "config-diff" }, ...diffLines(offer.diff).map((line) => el("span", { class: `diff-${line.kind}` }, `${line.text}\n`)));
        return el("details", { class: "machine-offer" },
            el("summary", {}, `${offer.name} (${offer.id}.toml): ${offerSummary(offer)}`),
            el("div", { class: "stack" },
                offer.problem ? el("p", { class: "error" }, offer.problem) : null,
                offer.changes.length > 0 ? el("ul", { class: "config-notes" }, ...offer.changes.map((line) => el("li", {}, line))) : null,
                !offer.known && offer.status === "merged"
                    ? el("p", { class: "muted hint" }, "What your copy was made from is not known: every value of yours is kept, only what the release adds goes in.")
                    : null,
                diff,
                el("div", { class: "button-row" }, offer.status === "problem" ? null : take, keep),
            ),
        );
    }

    async function decide(offer: MachineOffer, take: boolean): Promise<void> {
        const updates = await ctx.call(ctx.api.takeMachineUpdate(offer.id, take));
        if (updates) {
            draw(updates);
            if (take) {
                ctx.toast("info", `${offer.id}.toml ${offer.status === "new" ? "added" : "merged"}`);
                await changed();
            }
        }
    }

    async function refresh(): Promise<void> {
        try {
            draw(await ctx.api.machineUpdates());
        } catch {
            // A backend without the offers, or none to make: nothing shown.
            draw(undefined);
        }
    }

    return { refresh };
}
