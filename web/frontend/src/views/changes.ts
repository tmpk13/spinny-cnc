// A camera's log of changes, folded under its settings like its picture
// controls: what its routines applied (Find mark, Measure offset, a
// search's roll and scale, Find fiducials, Corner by edges, Center
// features, Center nozzle, Measure runout), newest first, each with the
// time, its words, every setting it changed as before -> after, and Undo
// while it can still be undone (Redo for an undo). Routines keep what they
// find at once; nothing asks first (spinny_web.findings).

import { button, el, setLocked } from "../dom.ts";
import type { AppState } from "../state.ts";
import type { CameraState, ControlledCamera, FindingChange, FindingEntry, PlacingState, PnpState } from "../types.ts";
import { into, type Ctx } from "./context.ts";

/** How many of a camera's newest entries its log shows. */
export const SHOWN = 30;

/** A setting's value in a few words: numbers to five decimals, places as x, y, references by name. */
export function valueText(value: unknown): string {
    if (value === null || value === undefined) {
        return "none";
    }
    if (typeof value === "boolean") {
        return value ? "yes" : "no";
    }
    if (typeof value === "number") {
        return Number.isFinite(value) ? String(Number(value.toFixed(5))) : String(value);
    }
    if (typeof value === "string") {
        return value;
    }
    if (Array.isArray(value)) {
        if (value.length === 0) {
            return "none";
        }
        if (value.every((item) => typeof item === "number")) {
            return value.map((item) => valueText(item)).join(", ");
        }
        if (value.every((item) => item !== null && typeof item === "object" && typeof (item as { ref?: unknown }).ref === "string")) {
            return value.map((item) => (item as { ref: string }).ref).join(", ");
        }
    }
    return JSON.stringify(value);
}

/** A change as one line: what it is, before -> after. */
export function changeText(change: FindingChange): string {
    return `${change.label || change.name}: ${valueText(change.before)} -> ${valueText(change.after)}`;
}

/** The words of the row under a picture for a result applied: what it did, or what its undo took back. */
export function appliedText(entry: FindingEntry): string {
    return entry.kind === "undo" ? `${entry.text.charAt(0).toUpperCase()}${entry.text.slice(1)}.` : `Applied: ${entry.text}.`;
}

/** Today's date here, as the backend writes an entry's (local time). */
function localToday(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** An entry's time as the log shows it: the time of day, with the date when not today. */
export function entryTime(time: string, today: string = localToday()): string {
    const [date, clock] = time.split("T");
    if (!clock) {
        return time;
    }
    return date === today ? clock : `${date} ${clock}`;
}

/** A camera's entries in the log as the page holds it, newest first. */
export function cameraEntries(state: AppState, camera: ControlledCamera): FindingEntry[] {
    return (state.findings?.entries ?? []).filter((entry) => entry.camera === camera);
}

/**
 * Takes back what an entry applied: the camera's state as the backend
 * answers it goes into the page, and the log is read again.
 */
export async function undoEntry(ctx: Ctx, id: number): Promise<void> {
    const reply = await ctx.call(ctx.api.undoFinding(id));
    if (!reply) {
        return;
    }
    if (reply.camera === "head") {
        ctx.store.set({ camera: reply.state as CameraState });
    } else if (reply.camera === "up") {
        ctx.store.set({ pnp: reply.state as PnpState });
    } else {
        ctx.store.set({ placing: reply.state as PlacingState });
    }
    await into(ctx, "findings", ctx.api.findings());
}

export interface ChangesFold {
    root: HTMLDetailsElement;
    render(state: AppState): void;
}

/** The log of changes of one camera (`label` names it in words), as a fold. */
export function mountChanges(ctx: Ctx, camera: ControlledCamera, label: string): ChangesFold {
    const list = el("ol", { class: "changes-list" });
    const empty = el("p", { class: "muted" }, "Nothing applied yet: what this camera's routines measure and find shows here.");
    const summary = el("summary", { class: "camera-controls-head" }, "Changes");
    summary.title = `what ${label}'s routines applied, newest first, each with Undo`;
    const root = el("details", { class: "camera-controls camera-changes" },
        summary,
        el("p", { class: "muted hint" }, "Each routine keeps what it finds at once. Undo puts the settings it changed back as they were; it is refused once one of them changed since."),
        empty,
        list,
    ) as HTMLDetailsElement;
    // The entries drawn, by their JSON, so a state that changed nothing of them draws nothing.
    let drawn = "";

    function item(entry: FindingEntry): HTMLElement {
        const undo = button(entry.kind === "undo" ? "Redo" : "Undo", () => void undoEntry(ctx, entry.id), "btn btn-quiet btn-small",
            entry.kind === "undo" ? "apply again what this undo took back" : "put back the settings it changed as they were before");
        setLocked(undo, !entry.undoable, entry.why ?? "it cannot be undone");
        const words = entry.kind === "undo" ? `${entry.text.charAt(0).toUpperCase()}${entry.text.slice(1)}` : entry.text;
        const machine = entry.machine ? el("span", { class: "muted" }, `on ${entry.machine}`) : null;
        const head = el("div", { class: "button-row changes-head" },
            el("span", { class: "muted mono" }, entryTime(entry.time)),
            el("span", { class: "changes-text" }, words),
            ...(machine ? [machine] : []),
            undo,
        );
        const values = el("ul", { class: "changes-values muted mono" }, ...entry.changes.map((change) => el("li", {}, changeText(change))));
        const node = el("li", { class: `changes-entry${entry.undone_by !== null ? " undone" : ""}`, "data-entry": String(entry.id) }, head);
        if (entry.changes.length > 0) {
            node.append(values);
        }
        return node;
    }

    function render(state: AppState): void {
        const entries = cameraEntries(state, camera).slice(0, SHOWN);
        const key = JSON.stringify(entries);
        if (key === drawn) {
            return;
        }
        drawn = key;
        empty.classList.toggle("hidden", entries.length > 0);
        list.replaceChildren(...entries.map(item));
    }

    void into(ctx, "findings", ctx.api.findings());
    return { root, render };
}
