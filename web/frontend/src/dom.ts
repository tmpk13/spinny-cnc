// Small DOM helpers: element construction and a few common controls.

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

export function numberField(options: NumberFieldOptions = {}): HTMLInputElement {
    // The decimal keypad a phone shows for inputmode=decimal has no minus
    // key, so only a field that cannot go below zero asks for it; the
    // others get the keyboard that type=number brings, minus included.
    const unsigned = options.min !== undefined && options.min >= 0;
    const input = el("input", {
        type: "number",
        inputmode: unsigned ? "decimal" : undefined,
        step: options.step ?? "any",
        min: options.min,
        max: options.max,
        placeholder: options.placeholder,
        class: "field",
    });
    if (options.value !== undefined && options.value !== null) {
        input.value = String(options.value);
    }
    if (options.width) {
        input.style.width = options.width;
    }
    return input;
}

export function labeled(label: string, control: HTMLElement, className = "labeled"): HTMLLabelElement {
    return el("label", { class: className }, el("span", { class: "labeled-text" }, label), control);
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
