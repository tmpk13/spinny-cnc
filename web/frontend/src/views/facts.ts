// The Checklist, first page of the Setup side: what the machine knows
// about itself (src/facts.ts), grouped by its parts. Each row gives the
// value, where it came from (measured when, detected, in the file, typed,
// the default, missing) and a link to where it is set or measured, on
// whichever side that is. A row that needs someone now says what and is
// marked in the color for "needs you"; nothing else is colored. The head
// counts how much of what the machine runs on is automatic (measured or
// detected) against what a person set: the share a routine could still
// take over, which is the Setup side's work to shrink.
//
// A link to `facts/<id>` shows that row, flashing.

import { el, replace } from "../dom.ts";
import { countFacts, factsOf, sourceText, type Fact } from "../facts.ts";
import type { AppState } from "../state.ts";
import { parseTarget } from "../sides.ts";
import type { Ctx } from "./context.ts";
import { linkTo } from "./links.ts";

/** The store's keys the facts are read from. */
export const FACT_KEYS: (keyof AppState)[] = ["snapshot", "settings", "machines", "camera", "cameras", "findings", "placing", "plugins", "ports"];

/** What a row shows, as text, so the list is redrawn only when that changes (the state changes at the status rate). */
function rowKey(fact: Fact, now: number): string {
    return JSON.stringify([fact.id, fact.label, fact.value, sourceText(fact, now), fact.need, fact.where, fact.action]);
}

export function mountFacts(root: HTMLElement, ctx: Ctx): void {
    const counts = el("span", { class: "badge facts-count" });
    const summary = el("p", { class: "facts-summary" });
    const meter = el("div", { class: "facts-meter", role: "img" }, el("span", { class: "facts-meter-auto" }), el("span", { class: "facts-meter-hand" }));
    const all = el("button", { type: "button", class: "btn btn-small", "aria-pressed": "true", title: "every value the machine runs on" }, "All");
    const needs = el("button", { type: "button", class: "btn btn-small", "aria-pressed": "false", title: "only what needs someone now: a value missing, settings not saved, a machine not homed" }, "Needs you");
    const list = el("div", { class: "facts-list" });
    root.append(
        el("div", { class: "panel-head" }, el("h2", {}, "Checklist"), counts),
        el("div", { class: "panel-body" }, summary, meter, el("div", { class: "button-row facts-filter", role: "group", "aria-label": "Show" }, all, needs), list),
    );

    let onlyNeeds = false;
    let drawn = "";
    // A link to a row not drawn yet (a tab opened at it, before the state
    // came): shown once it is.
    let wanted: string | null = null;
    const pick = (needsOnly: boolean): void => {
        onlyNeeds = needsOnly;
        all.setAttribute("aria-pressed", needsOnly ? "false" : "true");
        needs.setAttribute("aria-pressed", needsOnly ? "true" : "false");
        drawn = "";
        render(ctx.store.get());
    };
    all.addEventListener("click", () => pick(false));
    needs.addEventListener("click", () => pick(true));

    function row(fact: Fact, now: number): HTMLElement {
        const target = parseTarget(fact.where);
        const action = target
            ? linkTo(target, fact.action, `${fact.action}: ${fact.label}, where it is set`, "side-link fact-action")
            : el("span", {});
        const item = el("li", { class: "fact", id: `fact-${fact.id}`, "data-source": fact.source },
            el("span", { class: "fact-mark", "aria-hidden": "true" }),
            el("span", { class: "fact-label" }, fact.label),
            el("span", { class: "fact-value" }, fact.value),
            el("span", { class: "fact-source", title: sourceTitle(fact) }, sourceText(fact, now)),
            action,
        );
        if (fact.need !== null) {
            item.setAttribute("data-need", "");
            item.append(el("span", { class: "fact-need" }, fact.need));
        }
        return item;
    }

    function render(state: AppState): void {
        const now = Date.now();
        const facts = factsOf(state);
        const shown = onlyNeeds ? facts.filter((fact) => fact.need !== null) : facts;
        const key = JSON.stringify([onlyNeeds, shown.map((fact) => rowKey(fact, now))]);
        const tally = countFacts(facts);
        counts.textContent = tally.needs === 0 ? "nothing to do" : `${tally.needs} to do`;
        counts.setAttribute("data-apply", tally.needs === 0 ? "applied" : "pending");
        needs.textContent = tally.needs === 0 ? "Needs you" : `Needs you (${tally.needs})`;
        summary.textContent = `${tally.total} values the machine runs on: ${tally.automatic} measured or detected, ${tally.byHand} written or typed by hand, ${tally.defaults} left at the default, ${tally.missing} missing.`;
        const share = tally.total === 0 ? 0 : tally.automatic / tally.total;
        const hand = tally.total === 0 ? 0 : tally.byHand / tally.total;
        (meter.children[0] as HTMLElement).style.width = `${share * 100}%`;
        (meter.children[1] as HTMLElement).style.width = `${hand * 100}%`;
        meter.setAttribute("aria-label", `${tally.automatic} of ${tally.total} automatic, ${tally.byHand} by hand`);
        meter.title = `automatic: ${tally.automatic} of ${tally.total}; by hand: ${tally.byHand}; the rest default or missing`;
        if (key === drawn) {
            return;
        }
        drawn = key;
        const groups = new Map<string, Fact[]>();
        for (const fact of shown) {
            groups.set(fact.group, [...(groups.get(fact.group) ?? []), fact]);
        }
        replace(list, ...(shown.length === 0
            ? [el("p", { class: "muted" }, onlyNeeds ? "Nothing needs you." : "Nothing known yet: connect a machine.")]
            : [...groups].map(([group, rows]) => el("section", { class: "fact-group stack" }, el("h3", {}, group), el("ul", { class: "facts" }, ...rows.map((fact) => row(fact, now)))))));
        if (wanted !== null && flashRow(wanted)) {
            wanted = null;
        }
    }

    /** Scrolls to a row and flashes it; false when it is not drawn. */
    function flashRow(id: string): boolean {
        const item = root.querySelector<HTMLElement>(`#fact-${CSS.escape(id)}`);
        if (!item) {
            return false;
        }
        item.scrollIntoView?.({ behavior: "smooth", block: "center" });
        item.classList.remove("flash");
        void item.offsetWidth;
        item.classList.add("flash");
        return true;
    }

    // A link to a fact: the whole list, the row shown and flashing.
    root.addEventListener("spinny:goto", (event) => {
        const id = (event as CustomEvent<string>).detail;
        if (onlyNeeds) {
            pick(false);
        }
        wanted = flashRow(id) ? null : id;
    });

    ctx.store.subscribe(render, FACT_KEYS);
    render(ctx.store.get());
    // The ages ("measured 3 min ago") move on with no state change.
    setInterval(() => render(ctx.store.get()), 60_000);
}

/** The source chip's tooltip: what the source means for this value. */
function sourceTitle(fact: Fact): string {
    const fill = fact.fill === "routine" ? "a routine measures it" : fact.fill === "detect" ? "the page reads it from the machine or the computer" : "only a person sets it today";
    switch (fact.source) {
        case "measured":
            return `a routine measured this value${fact.when ? ` at ${fact.when.replace("T", " ")}` : ""}; it holds until measured again or changed`;
        case "detected":
            return "read from the machine or the computer; nobody set it";
        case "file":
            return `written in the machine file by hand or by a tool; ${fill}`;
        case "typed":
            return `typed on the page; ${fill}`;
        case "default":
            return `nothing set it: the default holds; ${fill}`;
        case "missing":
            return `not known; ${fill}`;
    }
}
