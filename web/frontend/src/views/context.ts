// What every view gets: the API, the store, and error reporting.

import type { Api } from "../api.ts";
import type { AppState, Store } from "../state.ts";
import type { MessageLevel } from "../types.ts";

export interface Ctx {
    api: Api;
    store: Store<AppState>;
    toast(level: MessageLevel, text: string): void;
    /** Awaits a request; a failure becomes a toast and resolves to undefined. */
    call<T>(promise: Promise<T>): Promise<T | undefined>;
    refreshState(): Promise<void>;
    refreshPorts(): Promise<void>;
    refreshJobs(): Promise<void>;
    refreshSettings(): Promise<void>;
    /** Loads a job in full and makes it the selected one; null clears the selection. */
    selectJob(id: string | null): Promise<void>;
}

/** Radio-style button row; `format` gives each value its label. */
export function choiceRow<T>(
    values: T[],
    initial: T,
    onPick: (value: T) => void,
    format: (value: T) => string,
    label?: string,
): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "choice-row";
    if (label) {
        const text = document.createElement("span");
        text.className = "choice-label";
        text.textContent = label;
        row.appendChild(text);
    }
    const buttons: HTMLButtonElement[] = [];
    for (const value of values) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn btn-choice";
        button.textContent = format(value);
        button.setAttribute("aria-pressed", value === initial ? "true" : "false");
        button.addEventListener("click", () => {
            for (const other of buttons) {
                other.setAttribute("aria-pressed", other === button ? "true" : "false");
            }
            onPick(value);
        });
        buttons.push(button);
        row.appendChild(button);
    }
    return row;
}

export function setPressed(row: HTMLElement, label: string): void {
    for (const button of Array.from(row.querySelectorAll("button"))) {
        button.setAttribute("aria-pressed", button.textContent === label ? "true" : "false");
    }
}
