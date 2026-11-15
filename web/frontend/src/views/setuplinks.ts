// The Use side's links to the Setup side: each panel that depends on what
// the machine knows (src/facts.ts names which) gets a Setup link in its
// head, to its facts in the Checklist. All set, the link is quiet; a fact
// that needs someone (a camera offset not measured, settings not saved to
// flash) turns it to the color for "needs you" and counts them, so the
// panel says what is missing without holding any of the setup itself.

import { factsOf, factsUsedBy, panelsUsingFacts, sourceText } from "../facts.ts";
import type { AppState } from "../state.ts";
import type { Ctx } from "./context.ts";
import { FACT_KEYS } from "./facts.ts";
import { hrefOf, linkTo } from "./links.ts";

/** A panel's head: its own, or the summary of the fold it is in. */
function headOf(panel: HTMLElement): HTMLElement | null {
    for (const child of Array.from(panel.children)) {
        if (child.classList.contains("panel-head")) {
            return child as HTMLElement;
        }
        if (child instanceof HTMLDetailsElement) {
            const summary = child.querySelector(":scope > summary");
            if (summary instanceof HTMLElement) {
                return summary;
            }
        }
    }
    return null;
}

export function mountSetupLinks(ctx: Ctx): void {
    const links: { panel: string; link: HTMLAnchorElement; target: string; drawn: string }[] = [];
    for (const id of panelsUsingFacts()) {
        const panel = document.getElementById(id);
        const head = panel ? headOf(panel) : null;
        if (!panel || !head) {
            continue;
        }
        const entry = { panel: id, link: null as unknown as HTMLAnchorElement, target: "", drawn: "" };
        entry.link = linkTo(() => ({ panel: "facts", detail: entry.target === "" ? null : entry.target }), "Setup", "", "side-link setup-link");
        // With the panel's title and its menu, not among the view's own
        // buttons after them.
        const after = [...head.querySelectorAll<HTMLElement>(":scope > h2, :scope > .panel-menu-button, :scope > .panel-scroll")].pop();
        if (after) {
            after.after(entry.link);
        } else {
            head.append(entry.link);
        }
        links.push(entry);
    }

    function render(state: AppState): void {
        const facts = factsOf(state);
        const now = Date.now();
        for (const entry of links) {
            const used = factsUsedBy(facts, entry.panel);
            const needs = used.filter((fact) => fact.need !== null);
            const shown = JSON.stringify([used.length, needs.map((fact) => fact.id), used.map((fact) => [fact.label, fact.value, sourceText(fact, now)])]);
            if (shown === entry.drawn) {
                continue;
            }
            entry.drawn = shown;
            entry.target = (needs[0] ?? used[0])?.id ?? "";
            entry.link.href = hrefOf({ panel: "facts", detail: entry.target === "" ? null : entry.target });
            entry.link.hidden = used.length === 0;
            entry.link.textContent = needs.length === 0 ? "Setup" : `Setup: ${needs.length} to do`;
            entry.link.toggleAttribute("data-need", needs.length > 0);
            const lines = used.map((fact) => `${fact.label}: ${fact.value} (${sourceText(fact, now)})${fact.need ? `; ${fact.need}` : ""}`);
            entry.link.title = `What this panel runs on, from the Setup side's Checklist:\n${lines.join("\n")}`;
        }
    }

    ctx.store.subscribe(render, FACT_KEYS);
    render(ctx.store.get());
}
