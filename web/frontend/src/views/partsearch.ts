// The Board panel's search: a few letters of a part's reference or of its
// value, matched loosely as the feature search matches (every letter in
// order, any case), light the parts that match on the drawing and dim the
// rest. Enter and the arrow keys step through the matches, best first,
// each picked as a click on it picks it and brought into view.

import { el, readStored, writeStored } from "../dom.ts";
import type { Component } from "../types.ts";
import { choiceRow } from "./context.ts";
import { fuzzyScore } from "./search.ts";

const BY_KEY = "spinny.pnp.searchby";

export type SearchBy = "ref" | "value";

/** What the search matches the letters against, as picked before: the reference unless the value was. */
export function readSearchBy(): SearchBy {
    return readStored(BY_KEY) === "value" ? "value" : "ref";
}

/**
 * The parts whose reference (or value) holds the letters typed, in order
 * and any case, best first: the whole text typed first, then by
 * fuzzyScore, ties in reference order (R2 before R10).
 */
export function searchParts(parts: Component[], query: string, by: SearchBy): Component[] {
    const want = query.trim().toLowerCase();
    if (want === "") {
        return [];
    }
    const scored: { part: Component; score: number }[] = [];
    for (const part of parts) {
        const text = by === "ref" ? part.ref : part.value;
        const score = fuzzyScore(want, text);
        if (score !== null) {
            scored.push({ part, score: score + (text.toLowerCase() === want ? 100 : 0) });
        }
    }
    return scored
        .sort((a, b) => b.score - a.score || a.part.ref.localeCompare(b.part.ref, undefined, { numeric: true, sensitivity: "base" }))
        .map((entry) => entry.part);
}

/** The match a step lands on: the next (or, `back`, the one before) after `at`, round the end; -1 for none to step to. */
export function stepMatch(at: number, count: number, back: boolean): number {
    if (count === 0) {
        return -1;
    }
    if (at < 0) {
        return back ? count - 1 : 0;
    }
    return (at + (back ? count - 1 : 1)) % count;
}

/** What the count beside the field says. */
export function matchText(query: string, count: number, at: number): string {
    if (query.trim() === "") {
        return "";
    }
    if (count === 0) {
        return "no match";
    }
    return at >= 0 ? `${at + 1} of ${count}` : `${count} match${count === 1 ? "" : "es"}`;
}

export interface BoardSearch {
    root: HTMLElement;
    /** Whether letters are typed: only then are parts lit and dimmed. */
    active(): boolean;
    /** The references matching now, best first. */
    matches(): string[];
    /** The parts shown changed (another job, side or filter): matched again. */
    refresh(): void;
}

export interface BoardSearchOptions {
    /** The parts the drawing shows. */
    parts(): Component[];
    /** A match stepped to: picked, and brought into view. */
    onPick(ref: string): void;
    /** The matches changed: the drawing lights them. */
    onChange(): void;
}

export function mountBoardSearch(options: BoardSearchOptions): BoardSearch {
    let by = readSearchBy();
    const input = el("input", { type: "search", class: "field pnp-search-field", placeholder: "find a part", "aria-label": "Find a part on the board", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
    input.title = "a few letters of a part's reference or value; Enter and the arrow keys step through the matches";
    const byRow = choiceRow<SearchBy>(["ref", "value"], by, (value) => {
        by = value;
        writeStored(BY_KEY, value);
        search();
    }, (value) => (value === "ref" ? "Ref" : "Value"), undefined, (value) => (value === "ref" ? "match references" : "match values"));
    const count = el("span", { class: "muted pnp-search-count", "aria-live": "polite" });
    const root = el("div", { class: "button-row pnp-search" }, input, byRow, count);
    let found: Component[] = [];
    let at = -1;

    function show(): void {
        count.textContent = matchText(input.value, found.length, at);
    }

    function search(): void {
        found = searchParts(options.parts(), input.value, by);
        at = -1;
        show();
        options.onChange();
    }

    function step(back: boolean): void {
        at = stepMatch(at, found.length, back);
        show();
        const part = found[at];
        if (part) {
            options.onPick(part.ref);
        }
    }

    input.addEventListener("input", () => search());
    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            step(event.key === "ArrowUp" || (event.key === "Enter" && event.shiftKey));
        } else if (event.key === "Escape" && input.value !== "") {
            event.preventDefault();
            event.stopPropagation();
            input.value = "";
            search();
        }
    });
    show();
    return {
        root,
        active: () => input.value.trim() !== "",
        matches: () => found.map((part) => part.ref),
        refresh(): void {
            const before = found[at]?.ref ?? null;
            found = searchParts(options.parts(), input.value, by);
            // Still on the match stepped to, if it is still one.
            at = before === null ? -1 : found.findIndex((part) => part.ref === before);
            show();
        },
    };
}
