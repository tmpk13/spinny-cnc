// What the PNP page's Parts panel lists. Parts KiCad keeps out of the
// position files (test point pads, mounting holes, net ties) are listed
// with a mark and a switch that hides them; a placing run leaves them out
// unless one is picked here to be placed. The parts filter, a regular
// expression kept on the backend so every placing run honors it, leaves
// the parts it matches out of the list, the drawing and placing.

import { button, el, labeled, readStored, replace, writeStored } from "../dom.ts";
import type { Component, PartsFilter, PartsFilterState } from "../types.ts";
import type { Ctx } from "./context.ts";

const KEPT_OUT_KEY = "spinny.pnp.keptout";
const PICKED_KEY = "spinny.pnp.place.";

const FIELDS: [PartsFilter["field"], string][] = [["ref", "ref"], ["value", "value"], ["footprint", "footprint"], ["any", "any of them"]];

/** Whether the parts kept out of the position files are listed: yes unless hidden before. */
export function readShowKeptOut(): boolean {
    return readStored(KEPT_OUT_KEY) !== "0";
}

export function writeShowKeptOut(show: boolean): void {
    writeStored(KEPT_OUT_KEY, show ? "1" : "0");
}

/** A part kept out of the position files; a fiducial is not counted, since the top camera finds those and they always show. */
export function keptOut(part: Component): boolean {
    return part.exclude_from_pos_files === true && part.fiducial !== true;
}

/** The parts the list and the drawing show: none the filter leaves out, and the kept-out ones only while shown. */
export function shownParts(parts: Component[], showKeptOut: boolean): Component[] {
    return parts.filter((part) => part.filtered !== true && (showKeptOut || !keptOut(part)));
}

/** The parts kept out of the position files picked to be placed in a job. */
export function pickedToPlace(job: string): Set<string> {
    try {
        const kept: unknown = JSON.parse(readStored(PICKED_KEY + job) ?? "[]");
        return new Set(Array.isArray(kept) ? kept.filter((ref): ref is string => typeof ref === "string") : []);
    } catch {
        return new Set();
    }
}

export function setPickedToPlace(job: string, ref: string, picked: boolean): void {
    const refs = pickedToPlace(job);
    if (picked) {
        refs.add(ref);
    } else {
        refs.delete(ref);
    }
    writeStored(PICKED_KEY + job, JSON.stringify([...refs]));
}

/**
 * The parts a placing run asks for: none named (every part that can be, as
 * the backend decides) while no part kept out of the position files is
 * picked; with one picked, every part but the fiducials, the ones the
 * filter leaves out and the kept-out ones not picked.
 */
export function placeRefs(parts: Component[], picked: Set<string>): string[] | undefined {
    const placeable = (part: Component): boolean => part.fiducial !== true && part.filtered !== true;
    if (!parts.some((part) => placeable(part) && keptOut(part) && picked.has(part.ref))) {
        return undefined;
    }
    return parts.filter((part) => placeable(part) && (!keptOut(part) || picked.has(part.ref))).map((part) => part.ref);
}

/** What the filter's line says: why it leaves nothing out, or how many parts it leaves out. */
export function filterLine(state: PartsFilterState | null, parts: Component[]): string {
    if (state?.error) {
        return state.error;
    }
    if (!state || state.pattern.trim() === "") {
        return "";
    }
    const count = parts.filter((part) => part.filtered === true).length;
    return `${count} part${count === 1 ? "" : "s"} left out by the filter`;
}

export interface PartsFilterView {
    root: HTMLElement;
    /** The line under the field, for the parts listed now. */
    render(parts: Component[]): void;
}

/** The parts filter's row: the expression, what it is tested against, and Apply; `changed` follows a filter kept. */
export function mountPartsFilter(ctx: Ctx, changed: () => void): PartsFilterView {
    const pattern = el("input", { type: "text", class: "field mono pnp-filter-pattern", placeholder: "^TP|^J", "aria-label": "Parts filter", spellcheck: "false", autocomplete: "off" }) as HTMLInputElement;
    const field = el("select", { class: "field", "aria-label": "Parts filter tests" },
        ...FIELDS.map(([value, label]) => el("option", { value }, label))) as HTMLSelectElement;
    const apply = button("Apply", () => keep(), "btn btn-small");
    apply.title = "leave the parts it matches out of the list and of placing";
    const line = el("p", { class: "muted pnp-filter-line" });
    const root = el("div", { class: "stack pnp-filter" },
        el("div", { class: "button-row" }, labeled("Leave out", pattern, "labeled inline"), labeled("in", field, "labeled inline"), apply),
        line,
    );
    let kept: PartsFilterState | null = null;
    let refused: string | null = null;
    let parts: Component[] = [];

    function edited(): boolean {
        return kept !== null && (pattern.value !== kept.pattern || field.value !== kept.field);
    }

    function show(): void {
        apply.classList.toggle("btn-primary", edited());
        const text = refused ?? filterLine(kept, parts);
        const problem = refused !== null || Boolean(kept?.error);
        replace(line, text);
        line.className = problem ? "config-status error pnp-filter-line" : "muted pnp-filter-line";
        line.classList.toggle("hidden", text === "");
    }

    function follow(state: PartsFilterState): void {
        kept = state;
        if (document.activeElement !== pattern) {
            pattern.value = state.pattern;
        }
        field.value = state.field;
        refused = null;
        show();
    }

    async function keep(): Promise<void> {
        try {
            const state = await ctx.api.setPartsFilter({ pattern: pattern.value, field: field.value as PartsFilter["field"] });
            follow(state);
            pattern.value = state.pattern;
            changed();
        } catch (error) {
            // Said in place, where the expression is typed.
            refused = error instanceof Error ? error.message : String(error);
            show();
        }
    }

    pattern.addEventListener("input", () => {
        refused = null;
        show();
    });
    pattern.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            void keep();
        }
    });
    field.addEventListener("change", () => show());
    ctx.call(ctx.api.partsFilter()).then((state) => {
        if (state) {
            follow(state);
        }
    }, () => undefined);
    show();
    return {
        root,
        render(listed: Component[]): void {
            parts = listed;
            show();
        },
    };
}
