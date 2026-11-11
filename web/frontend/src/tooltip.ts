// Tooltips the browser's own do not give. A disabled button takes no
// pointer events in Firefox, so its title never shows, and that is the
// moment an operator most wants to know what it does and why it is off.
// The stylesheet lets the pointer pass through a disabled button
// (pointer-events: none) to whatever holds it; this module finds the
// button under the pointer by its box and shows, after a short rest, its
// title and the reason it is locked (`data-reason`, from setLocked, or the
// reason on a disabled fieldset around it). Firefox and Chromium then
// behave the same. A press on a disabled button's box is swallowed, as
// the button itself would have, rather than reaching what holds it.
//
// A view can also give an element a tip that depends on where the pointer
// is over it (`setTip`): the machine file editor names the key under the
// pointer.

import { el } from "./dom.ts";

/** How long the pointer rests before a tip shows, as the browsers' own. */
const REST_MS = 450;

/** Gives the tip a view computes from the pointer's place over `element`, or null for none there. */
type TipSource = (event: PointerEvent) => string | null;

const sources = new WeakMap<Element, TipSource>();

export function setTip(element: Element, source: TipSource): void {
    sources.set(element, source);
}

/** The words for a disabled button: what it does (its title) over why it is off. */
export function disabledTip(button: HTMLButtonElement): string | null {
    const fieldset = button.closest("fieldset");
    const reason = button.dataset["reason"]
        ?? (fieldset instanceof HTMLFieldSetElement && fieldset.disabled ? fieldset.dataset["reason"] : undefined)
        ?? null;
    const what = button.getAttribute("title") || null;
    if (reason && what && reason !== what) {
        return `${what}\n${reason}`;
    }
    return reason ?? what;
}

/** The disabled button whose box holds the point, among those inside `holder`. */
export function disabledAt(holder: Element, x: number, y: number): HTMLButtonElement | null {
    for (const button of Array.from(holder.querySelectorAll<HTMLButtonElement>("button:disabled"))) {
        const box = button.getBoundingClientRect();
        if (box.width > 0 && x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) {
            return button;
        }
    }
    return null;
}

export function mountTooltips(): void {
    const tip = el("div", { class: "tip", role: "tooltip" });
    tip.hidden = true;
    document.body.append(tip);
    let shown: { key: Element; text: string } | null = null;
    let waiting: { key: Element; text: string; x: number; y: number } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let frame = 0;
    let last: PointerEvent | null = null;

    const hide = (): void => {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
        waiting = null;
        shown = null;
        tip.hidden = true;
    };

    const place = (x: number, y: number): void => {
        const space = (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
        const box = tip.getBoundingClientRect();
        const width = window.innerWidth;
        const height = window.innerHeight;
        let left = x + space * 0.75;
        let top = y + space * 1.25;
        if (left + box.width > width - space / 2) {
            left = Math.max(space / 2, width - box.width - space / 2);
        }
        if (top + box.height > height - space / 2) {
            top = Math.max(space / 2, y - box.height - space / 2);
        }
        tip.style.left = `${left}px`;
        tip.style.top = `${top}px`;
    };

    /** What the pointer is over that has a tip of this module's to show, if anything. */
    const find = (event: PointerEvent): { key: Element; text: string; disabled: boolean } | null => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target || tip.contains(target)) {
            return null;
        }
        const button = disabledAt(target, event.clientX, event.clientY);
        if (button) {
            const text = disabledTip(button);
            return text ? { key: button, text, disabled: true } : { key: button, text: "", disabled: true };
        }
        for (let node: Element | null = target; node; node = node.parentElement) {
            const source = sources.get(node);
            if (source) {
                const text = source(event);
                return text ? { key: node, text, disabled: false } : null;
            }
        }
        return null;
    };

    const look = (): void => {
        frame = 0;
        const event = last;
        if (!event) {
            return;
        }
        const found = find(event);
        // The pointer passes through a disabled button, so the not-allowed
        // cursor it would show is put on the page while over one.
        document.documentElement.toggleAttribute("data-over-disabled", found?.disabled === true);
        if (!found || found.text === "") {
            hide();
            return;
        }
        if (shown && shown.key === found.key && shown.text === found.text) {
            return;
        }
        if (shown) {
            // Already showing one: the next shows at once, as the browsers' do.
            shown = { key: found.key, text: found.text };
            tip.textContent = found.text;
            place(event.clientX, event.clientY);
            return;
        }
        if (waiting && waiting.key === found.key && waiting.text === found.text) {
            waiting.x = event.clientX;
            waiting.y = event.clientY;
            return;
        }
        if (timer !== null) {
            clearTimeout(timer);
        }
        waiting = { key: found.key, text: found.text, x: event.clientX, y: event.clientY };
        timer = setTimeout(() => {
            timer = null;
            if (!waiting) {
                return;
            }
            shown = { key: waiting.key, text: waiting.text };
            tip.textContent = waiting.text;
            tip.hidden = false;
            place(waiting.x, waiting.y);
            waiting = null;
        }, REST_MS);
    };

    document.addEventListener("pointermove", (event) => {
        if (event.pointerType !== "mouse") {
            return;
        }
        last = event;
        if (frame === 0) {
            frame = requestAnimationFrame(look);
        }
    }, { passive: true });
    document.addEventListener("pointerleave", () => {
        hide();
        document.documentElement.removeAttribute("data-over-disabled");
    });
    for (const type of ["pointerdown", "keydown", "wheel"]) {
        document.addEventListener(type, hide, { capture: true, passive: true });
    }
    document.addEventListener("scroll", hide, { capture: true, passive: true });
    window.addEventListener("blur", hide);
    // A press on a disabled button's box is the button's, as it would be
    // were the pointer not let through it: nothing under it hears it.
    document.addEventListener("click", (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target && event.isTrusted && disabledAt(target, event.clientX, event.clientY)) {
            event.preventDefault();
            event.stopPropagation();
        }
    }, true);
}
