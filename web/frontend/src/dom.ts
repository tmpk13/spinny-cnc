// Small DOM helpers: element construction, a few common controls, and what
// this browser remembers for the page.

import { calcText, calculate } from "./calc.ts";
import { parseNumber } from "./format.ts";

export type Child = Node | string | number | null | undefined | false;

export type Attrs = Record<string, string | number | boolean | ((event: Event) => void) | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attrs: Attrs = {},
    ...children: Child[]
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (value === undefined || value === false) {
            continue;
        }
        if (key.startsWith("on") && typeof value === "function") {
            node.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (key === "class") {
            node.className = String(value);
        } else if (value === true) {
            node.setAttribute(key, "");
        } else if (typeof value !== "function") {
            node.setAttribute(key, String(value));
        }
    }
    append(node, children);
    return node;
}

export function append(node: Node, children: Child[]): void {
    for (const child of children) {
        if (child === null || child === undefined || child === false) {
            continue;
        }
        node.appendChild(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
    }
}

export function replace(node: Node, ...children: Child[]): void {
    while (node.firstChild) {
        node.removeChild(node.firstChild);
    }
    append(node, children);
}

export type ClickHandler = (event: Event) => void | Promise<unknown>;

function isThenable(value: unknown): value is Promise<unknown> {
    return typeof value === "object" && value !== null && typeof (value as Promise<unknown>).then === "function";
}

function applyDisabled(node: HTMLButtonElement): void {
    node.disabled = node.dataset["busy"] === "1" || node.dataset["locked"] === "1";
}

/** Disables `node` until `promise` settles; the lock from `setLocked` is kept apart so neither clobbers the other. */
export function busyWhile(node: HTMLButtonElement, promise: Promise<unknown>): void {
    node.dataset["busy"] = "1";
    applyDisabled(node);
    void promise.finally(() => {
        delete node.dataset["busy"];
        applyDisabled(node);
    });
}

/** State-driven disabling of a button; a request in flight keeps it disabled either way. */
export function setLocked(node: HTMLButtonElement, locked: boolean): void {
    if (locked) {
        node.dataset["locked"] = "1";
    } else {
        delete node.dataset["locked"];
    }
    applyDisabled(node);
}

/** A button that stays disabled while the promise its handler returns is pending, so a second click cannot submit again. */
export function button(label: string, onClick: ClickHandler, className = "btn"): HTMLButtonElement {
    const node = el("button", { type: "button", class: className }, label);
    node.addEventListener("click", (event) => {
        if (node.disabled) {
            return;
        }
        const result = onClick(event);
        if (isThenable(result)) {
            busyWhile(node, result);
        }
    });
    return node;
}

export interface NumberFieldOptions {
    value?: number | null;
    step?: number | "any";
    min?: number;
    max?: number;
    placeholder?: string;
    width?: string;
}

/**
 * A field for a number, which also takes arithmetic (`25.4/2`, `1/8 in`,
 * `3*(4+1.5)`; src/calc.ts reads it). It is a text field, since a number
 * field throws away anything that is not a plain number: the arrow keys
 * step it by `step` (1 for `any`) within `min` and `max` as a number field
 * would, a text that reads as no number is marked invalid while typed, and
 * on change (Enter, or leaving the field) a calculation is replaced by its
 * value before anything else hears the change. Every reader of a field
 * goes through `parseNumber`, which reads the arithmetic too.
 */
export function numberField(options: NumberFieldOptions = {}): HTMLInputElement {
    // The decimal keypad a phone shows for inputmode=decimal has no minus
    // key, nor any operator, so only a field that cannot go below zero asks
    // for it; the others get the phone's full keyboard, where both are.
    const unsigned = options.min !== undefined && options.min >= 0;
    const input = el("input", {
        type: "text",
        inputmode: unsigned ? "decimal" : undefined,
        autocomplete: "off",
        spellcheck: "false",
        placeholder: options.placeholder,
        class: "field num",
    });
    // Kept where a number field keeps them, for the arrow keys and for
    // anything that reads the field's limits.
    input.setAttribute("step", String(options.step ?? "any"));
    if (options.min !== undefined) {
        input.setAttribute("min", String(options.min));
    }
    if (options.max !== undefined) {
        input.setAttribute("max", String(options.max));
    }
    if (options.value !== undefined && options.value !== null) {
        input.value = String(options.value);
    }
    if (options.width) {
        input.style.width = options.width;
    }
    const mark = (): void => {
        const text = input.value.trim();
        const bad = text !== "" && parseNumber(text) === null;
        input.classList.toggle("invalid", bad);
        if (bad) {
            input.setAttribute("aria-invalid", "true");
            input.title = `not a number: ${calculate(text)}`;
        } else if (input.getAttribute("aria-invalid") === "true") {
            input.removeAttribute("aria-invalid");
            input.removeAttribute("title");
        }
    };
    input.addEventListener("input", mark);
    input.addEventListener("change", () => {
        const text = input.value.trim();
        const value = parseNumber(text);
        // A plain number stays as typed (3.50 is not made 3.5).
        if (value !== null && !Number.isFinite(Number(text))) {
            input.value = calcText(value);
        }
        mark();
    });
    input.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
            return;
        }
        const now = parseNumber(input.value);
        if (now === null && input.value.trim() !== "") {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        const stepAttr = Number(input.getAttribute("step"));
        const step = Number.isFinite(stepAttr) && stepAttr > 0 ? stepAttr : 1;
        let next = (now ?? 0) + (event.key === "ArrowUp" ? step : -step);
        const min = input.getAttribute("min");
        const max = input.getAttribute("max");
        if (min !== null && next < Number(min)) {
            next = Number(min);
        }
        if (max !== null && next > Number(max)) {
            next = Number(max);
        }
        input.value = calcText(next);
        mark();
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    return input;
}

export function labeled(label: string, control: HTMLElement, className = "labeled"): HTMLLabelElement {
    return el("label", { class: className }, el("span", { class: "labeled-text" }, label), control);
}

/** A field the state fills in: a text or number field, or a select. */
export type TrackedField = HTMLInputElement | HTMLSelectElement;

/**
 * Fields that follow the state until typed in. Each value the state gives
 * a field goes into it while the field still shows the value before, so
 * one typed in keeps what was typed, and the field with the focus is not
 * written. `onChange`, when given, hears every input and change of them.
 */
export class Tracked {
    private shown = new Map<TrackedField, string>();

    constructor(readonly fields: TrackedField[], onChange?: () => void) {
        if (onChange) {
            for (const field of fields) {
                field.addEventListener("input", onChange);
                field.addEventListener("change", onChange);
            }
        }
    }

    /** Gives `field` the state's `value`, which it shows unless it holds an edit or has the focus. */
    follow(field: TrackedField, value: string): void {
        const untouched = !this.shown.has(field) || field.value === this.shown.get(field);
        if (untouched && field !== document.activeElement) {
            field.value = value;
        }
        this.shown.set(field, value);
    }

    /** Whether `field` holds an edit: a text other than the value the state last gave it. */
    changed(field: TrackedField): boolean {
        return this.shown.has(field) && field.value !== this.shown.get(field);
    }

    /** Marks the fields that hold an edit (`edited` on the `.labeled` around each) and counts them. */
    edited(): number {
        let count = 0;
        for (const field of this.fields) {
            const edited = this.changed(field);
            field.closest(".labeled")?.classList.toggle("edited", edited);
            count += edited ? 1 : 0;
        }
        return count;
    }

    /** Forgets the values given, so each field takes the next one whatever it holds, unless it has the focus. */
    reset(): void {
        this.shown.clear();
    }
}

/** Inputs that do nothing with the arrow keys: a checkbox and the button kinds. */
const KEYLESS_INPUTS = new Set(["checkbox", "button", "submit", "reset", "image", "file"]);

/** True when a control that uses the arrow keys has focus, so they should not jog. */
export function inputHasFocus(): boolean {
    const active = document.activeElement;
    if (!active || active === document.body) {
        return false;
    }
    const tag = active.tagName;
    if (tag === "INPUT") {
        return !KEYLESS_INPUTS.has((active as HTMLInputElement).type);
    }
    if (tag === "TEXTAREA" || tag === "SELECT") {
        return true;
    }
    return (active as HTMLElement).isContentEditable === true;
}

/** True while a modal dialog is up, so keys answer it rather than the page. */
export function modalOpen(): boolean {
    return document.querySelector("dialog[open]") !== null;
}

/** Reads a CSS custom property from an element, with a fallback. */
export function cssVar(node: Element, name: string, fallback: string): string {
    const value = getComputedStyle(node).getPropertyValue(name).trim();
    return value !== "" ? value : fallback;
}

/** Which page is up (jobs, plot, cam, pnp, auto or config), as the tabs set it on #app. */
export function activePage(): string {
    return document.getElementById("app")?.getAttribute("data-page") ?? "jobs";
}

/** What this browser remembers under `key`; null when it remembers nothing there, or its storage is blocked. */
export function readStored(key: string): string | null {
    try {
        return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
        return null;
    }
}

/** Remembers `value` under `key` in this browser; with its storage blocked nothing is kept. */
export function writeStored(key: string, value: string): void {
    try {
        globalThis.localStorage?.setItem(key, value);
    } catch {
        // Not remembered; the page works without it.
    }
}

/**
 * A panel that folds: `head` is its summary line, shown folded or not,
 * and `body` what folds away. Whether it is open is remembered in this
 * browser under `key`, "1" open and "0" folded; with nothing remembered it
 * is open. `onToggle` runs after every fold and unfold.
 */
export function foldPanel(key: string, head: HTMLElement, body: HTMLElement, onToggle?: (open: boolean) => void): HTMLDetailsElement {
    const fold = el("details", { class: "panel-fold", open: readStored(key) !== "0" }, head, body);
    fold.addEventListener("toggle", () => {
        writeStored(key, fold.open ? "1" : "0");
        onToggle?.(fold.open);
    });
    return fold;
}
