// What the operator did lately, for a bug report: a ring of the last few
// hundred actions, kept in memory from the page's load. An action is a
// button pressed (its label, the panel and the page it is on), a page
// shown, a request made to the backend (method, path, status and how long
// it took, never a body), a toast shown, or an error the page ran into.
// The same action again straight after (a poll, a button pressed twice) is
// counted on the one before rather than taking another place in the ring.

import type { FetchLike } from "./api.ts";
import type { AppState, Store } from "./state.ts";
import { onPage } from "./views/tabs.ts";

export type ActionKind = "press" | "page" | "request" | "toast" | "error";

export interface Action {
    /** When, ms since 1970; for a repeated action, the last time. */
    at: number;
    kind: ActionKind;
    /** A button's words, or a check box's label. */
    label?: string;
    /** The panel a button is in, by its name. */
    panel?: string;
    page?: string;
    method?: string;
    path?: string;
    /** A request's answer; 0 when none came. */
    status?: number;
    ms?: number;
    level?: string;
    text?: string;
    /** How many times it came in a row, when more than once. */
    count?: number;
}

/** How many actions the ring keeps. */
export const ACTIONS_KEPT = 200;
/** The longest text an action keeps, characters. */
export const ACTION_TEXT = 300;

function short(text: string): string {
    const one = text.replace(/\s+/g, " ").trim();
    return one.length <= ACTION_TEXT ? one : `${one.slice(0, ACTION_TEXT - 3)}...`;
}

/** Whether two actions are the same but for their time. */
function same(a: Action, b: Action): boolean {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    keys.delete("at");
    keys.delete("count");
    keys.delete("ms");
    return [...keys].every((key) => a[key as keyof Action] === b[key as keyof Action]);
}

export class ActionLog {
    private readonly ring: Action[] = [];

    constructor(readonly size = ACTIONS_KEPT, private readonly clock: () => number = Date.now) {}

    push(action: Omit<Action, "at">): void {
        const made: Action = { ...action, at: this.clock() };
        for (const key of ["label", "panel", "text"] as const) {
            if (typeof made[key] === "string") {
                made[key] = short(made[key]);
            }
        }
        const last = this.ring[this.ring.length - 1];
        if (last && same(last, made)) {
            last.count = (last.count ?? 1) + 1;
            last.at = made.at;
            if (made.ms !== undefined) {
                last.ms = made.ms;
            }
            return;
        }
        this.ring.push(made);
        if (this.ring.length > this.size) {
            this.ring.splice(0, this.ring.length - this.size);
        }
    }

    /** The actions kept, oldest first, as copies. */
    list(): Action[] {
        return this.ring.map((action) => ({ ...action }));
    }

    clear(): void {
        this.ring.length = 0;
    }
}

/** The page's own log, from its load. */
export const actions = new ActionLog();

/** An action as a report carries it: its time written out, the fields it has. */
export function reportAction(action: Action): Record<string, string | number> {
    const out: Record<string, string | number> = { at: new Date(action.at).toISOString() };
    for (const [key, value] of Object.entries(action)) {
        if (key !== "at" && value !== undefined) {
            out[key] = value as string | number;
        }
    }
    return out;
}

function clock(at: number): string {
    const time = new Date(at);
    const two = (value: number): string => String(value).padStart(2, "0");
    return `${two(time.getHours())}:${two(time.getMinutes())}:${two(time.getSeconds())}`;
}

/** One action as a line of text, as the backend writes it into an issue. */
export function actionLine(action: Action): string {
    let what: string;
    switch (action.kind) {
        case "press":
            what = `press "${action.label ?? ""}" (${action.panel || "-"}, ${action.page || "-"})`;
            break;
        case "page":
            what = `page ${action.page ?? ""}`;
            break;
        case "request":
            what = `${action.method ?? ""} ${action.path ?? ""} ${action.status ?? ""} ${action.ms ?? ""} ms`;
            break;
        case "toast":
            what = `toast ${action.level ?? ""}: ${action.text ?? ""}`;
            break;
        case "error":
            what = `error: ${action.text ?? ""}`;
            break;
    }
    const times = action.count !== undefined && action.count > 1 ? ` (x${action.count})` : "";
    return `${clock(action.at)} ${what}${times}`;
}

/** What a pressed control says it is: its label, else its words, else its tooltip. */
export function labelOf(node: Element): string {
    if (node instanceof HTMLInputElement && (node.type === "checkbox" || node.type === "radio")) {
        const words = (node.closest("label")?.textContent ?? node.getAttribute("aria-label") ?? node.title ?? "").trim();
        return `${words || node.type} (${node.checked ? "on" : "off"})`;
    }
    const said = node.getAttribute("aria-label") ?? node.textContent ?? "";
    return short(said) || node.getAttribute("title") || node.tagName.toLowerCase();
}

/** The panel, bar or dialog a control is in, by its name. */
export function panelOf(node: Element): string {
    const holder = node.closest("section.panel, dialog, [role=dialog], aside, header, nav");
    if (!holder) {
        return "";
    }
    const named = holder.getAttribute("aria-label") ?? holder.querySelector("h2")?.textContent ?? "";
    if (named) {
        return short(named);
    }
    return holder.tagName === "HEADER" ? "top bar" : holder.tagName === "NAV" ? "tab bar" : holder.id;
}

function pageNow(): string {
    return document.getElementById("app")?.getAttribute("data-page") ?? "";
}

/** The controls a press is recorded for. */
const PRESSED = "button, [role=button], [role=tab], summary, a[href], input[type=checkbox], input[type=radio]";

/** Records every press on the page's controls, from the capture phase, so a handler that stops it is no matter. */
export function recordPresses(root: Document = document, log: ActionLog = actions): void {
    root.addEventListener("click", (event) => {
        const target = event.target instanceof Element ? event.target.closest(PRESSED) : null;
        if (target) {
            log.push({ kind: "press", label: labelOf(target), panel: panelOf(target), page: pageNow() });
        }
    }, true);
}

/** The path of a request's address, without its query. */
export function pathOf(input: string): string {
    try {
        return new URL(input, globalThis.location?.href ?? "http://localhost/").pathname;
    } catch {
        return input.split("?")[0] ?? input;
    }
}

/** A fetch that records each request it makes: method, path, status and time. */
export function recordingFetch(fetchFn: FetchLike, log: ActionLog = actions, now: () => number = () => performance.now()): FetchLike {
    return async (input, init) => {
        const started = now();
        const method = (init?.method ?? "GET").toUpperCase();
        const path = pathOf(input);
        try {
            const response = await fetchFn(input, init);
            log.push({ kind: "request", method, path, status: response.status, ms: Math.round(now() - started) });
            return response;
        } catch (error) {
            log.push({ kind: "request", method, path, status: 0, ms: Math.round(now() - started) });
            throw error;
        }
    };
}

/** Records the errors the page runs into: an exception nothing caught, a promise nobody handled. */
export function recordErrors(target: Window = window, log: ActionLog = actions): void {
    target.addEventListener("error", (event) => {
        const where = event.filename ? ` (${pathOf(event.filename)}:${event.lineno})` : "";
        log.push({ kind: "error", text: `${event.message}${where}` });
    });
    target.addEventListener("unhandledrejection", (event) => {
        const reason = event.reason;
        log.push({ kind: "error", text: `unhandled: ${reason instanceof Error ? reason.message : String(reason)}` });
    });
}

/**
 * Records from the page's load on: presses, pages shown, toasts and
 * errors. Requests are recorded by the fetch the page's API is given
 * (recordingFetch).
 */
export function recordActions(store: Store<AppState>, log: ActionLog = actions): void {
    recordPresses(document, log);
    recordErrors(window, log);
    onPage((page) => log.push({ kind: "page", page }));
    let seen = new Set(store.get().toasts.map((toast) => toast.id));
    store.subscribe((state) => {
        for (const toast of state.toasts) {
            if (!seen.has(toast.id)) {
                log.push({ kind: "toast", level: toast.level, text: toast.text });
            }
        }
        seen = new Set(state.toasts.map((toast) => toast.id));
    }, ["toasts"]);
}
