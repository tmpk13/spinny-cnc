// A small menu of actions over the page: a panel's menu (its dots button,
// or a right click on its head) and the tab bar's folder of tabs left out.
// One menu is open at a time. It closes on a pick, on Escape, on a press
// outside it, on a scroll or a resize, and gives the focus back to what
// opened it. The arrow keys move between its items and go no further: the
// jog keys listen on the document and skip a key whose default is
// prevented, so a key meant for the menu never moves the machine.

import { popUp } from "./dismiss.ts";
import { el } from "./dom.ts";

export interface MenuItem {
    label: string;
    run: () => void;
    /** Why the item cannot be picked now, shown as its tooltip; absent when it can. */
    disabled?: string;
    /** A check mark beside the label: the item is a setting that is on. */
    checked?: boolean;
}

/** An item, or a rule between groups of items. */
export type MenuEntry = MenuItem | "-";

let open: { menu: HTMLElement; opener: HTMLElement | null; cleanup: () => void } | null = null;

/** Closes the open menu, if any, and gives the focus back to what opened it. */
export function closeMenu(restoreFocus = true): void {
    if (!open) {
        return;
    }
    const { menu, opener, cleanup } = open;
    open = null;
    cleanup();
    menu.remove();
    opener?.removeAttribute("aria-expanded");
    if (restoreFocus && opener?.isConnected && typeof opener.focus === "function") {
        opener.focus({ preventScroll: true });
    }
}

/** Whether a menu is open. */
export function menuOpen(): boolean {
    return open !== null;
}

function items(menu: HTMLElement): HTMLButtonElement[] {
    return Array.from(menu.querySelectorAll<HTMLButtonElement>("button.menu-item:not(:disabled)"));
}

/**
 * Opens a menu of `entries` named `label`, under `at` (an element: the
 * menu sits below it, its right edge on the element's) or at a point (a
 * right click on `from`), kept on the screen. A scroll that moves the
 * element it was opened from closes it; other scrolls (a console taking
 * lines) leave it be. Returns the menu element.
 */
export function openMenu(entries: MenuEntry[], at: HTMLElement | { x: number; y: number }, label: string, from?: Element): HTMLElement {
    closeMenu(false);
    const opener = at instanceof HTMLElement ? at : null;
    const anchor = opener ?? from ?? null;
    const menu = el("div", { class: "menu", role: "menu", "aria-label": label });
    for (const entry of entries) {
        if (entry === "-") {
            menu.append(el("div", { class: "menu-rule", role: "separator" }));
            continue;
        }
        const item = el("button", {
            type: "button",
            class: "menu-item",
            role: entry.checked === undefined ? "menuitem" : "menuitemcheckbox",
            "aria-checked": entry.checked === undefined ? undefined : String(entry.checked),
        }, entry.label);
        if (entry.disabled !== undefined) {
            item.disabled = true;
            item.dataset["reason"] = entry.disabled;
        }
        item.addEventListener("click", () => {
            closeMenu();
            entry.run();
        });
        menu.append(item);
    }
    document.body.append(menu);
    place(menu, at);

    const keys = (event: KeyboardEvent): void => {
        const list = items(menu);
        const index = list.indexOf(document.activeElement as HTMLButtonElement);
        let next: HTMLButtonElement | undefined;
        if (event.key === "ArrowDown") {
            next = list[(index + 1) % list.length];
        } else if (event.key === "ArrowUp") {
            next = list[(index - 1 + list.length) % list.length];
        } else if (event.key === "Home") {
            next = list[0];
        } else if (event.key === "End") {
            next = list[list.length - 1];
        } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            closeMenu();
            return;
        } else if (event.key === "Tab") {
            closeMenu(false);
            return;
        } else {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        next?.focus();
    };
    const outside = (event: Event): void => {
        const target = event.target as Node | null;
        if (target && (menu.contains(target) || (opener !== null && opener.contains(target)))) {
            return;
        }
        closeMenu(false);
    };
    // Where the anchor was when the menu opened: a scroll event can come a
    // frame late, from a scroll made before the menu opened, and only one
    // that moved the anchor since takes the menu away from it.
    const was = anchor?.getBoundingClientRect() ?? null;
    const away = (): void => {
        const now = anchor?.getBoundingClientRect();
        if (was && now && (Math.abs(now.top - was.top) > 1 || Math.abs(now.left - was.left) > 1)) {
            closeMenu(false);
        }
    };
    const resize = (): void => closeMenu(false);
    const release = popUp({ nodes: () => [menu, opener], close: () => closeMenu(false) });
    menu.addEventListener("keydown", keys);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("scroll", away, true);
    window.addEventListener("resize", resize);
    open = {
        menu,
        opener,
        cleanup: () => {
            release();
            document.removeEventListener("pointerdown", outside, true);
            document.removeEventListener("scroll", away, true);
            window.removeEventListener("resize", resize);
        },
    };
    opener?.setAttribute("aria-expanded", "true");
    items(menu)[0]?.focus({ preventScroll: true });
    return menu;
}

/** Puts the menu under its opener or at the point, moved back onto the screen where it would run off. */
function place(menu: HTMLElement, at: HTMLElement | { x: number; y: number }): void {
    const width = window.innerWidth || document.documentElement.clientWidth;
    const height = window.innerHeight || document.documentElement.clientHeight;
    // A quarter of the root font size off the anchor and the screen's edges.
    const space = (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16) / 4;
    let x: number;
    let y: number;
    const box = menu.getBoundingClientRect();
    if (at instanceof HTMLElement) {
        const anchor = at.getBoundingClientRect();
        x = anchor.right - box.width;
        y = anchor.bottom + space;
        if (y + box.height > height && anchor.top - box.height - space >= 0) {
            y = anchor.top - box.height - space;
        }
    } else {
        x = at.x;
        y = at.y;
        if (y + box.height > height) {
            y = Math.max(0, at.y - box.height);
        }
    }
    x = Math.max(space, Math.min(x, width - box.width - space));
    y = Math.max(space, Math.min(y, height - box.height - space));
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
}
