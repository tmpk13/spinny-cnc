// The handle between the Use and Setup panes side by side: dragged, it
// sets the Use side's share of the width (the Setup side has the rest);
// the arrow keys move it a step, Home and End to the ends, and a double
// click or Enter gives back the usual share. The share is remembered per
// browser with the split itself (src/views/tabs.ts).

import { setSplitShare, SPLIT_MAX, SPLIT_MIN, SPLIT_SHARE, splitPrefs } from "./tabs.ts";

/** How far an arrow key moves the handle, as a share of the width. */
export const SPLIT_STEP = 0.02;

/** The Use side's share for a pointer at `x` over a page from `left` to `left + width`, held to the limits. */
export function shareAt(x: number, left: number, width: number): number {
    if (!(width > 0)) {
        return SPLIT_SHARE;
    }
    return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, (x - left) / width));
}

/** The share a key moves the handle to; null for a key the handle does not take. */
export function shareForKey(key: string, share: number): number | null {
    switch (key) {
        case "ArrowLeft":
            return Math.max(SPLIT_MIN, share - SPLIT_STEP);
        case "ArrowRight":
            return Math.min(SPLIT_MAX, share + SPLIT_STEP);
        case "Home":
            return SPLIT_MIN;
        case "End":
            return SPLIT_MAX;
        case "Enter":
            return SPLIT_SHARE;
        default:
            return null;
    }
}

export function mountSplitHandle(handle: HTMLElement, app: HTMLElement): void {
    const describe = (): void => {
        const share = splitPrefs().share;
        handle.setAttribute("aria-valuenow", String(Math.round(share * 100)));
        handle.setAttribute("aria-valuemin", String(Math.round(SPLIT_MIN * 100)));
        handle.setAttribute("aria-valuemax", String(Math.round(SPLIT_MAX * 100)));
        handle.title = `drag to share the width between Use (${Math.round(share * 100)}%) and Setup; a double click for the usual share`;
    };
    handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) {
            return;
        }
        event.preventDefault();
        handle.setPointerCapture?.(event.pointerId);
        handle.setAttribute("data-dragging", "");
        const box = app.getBoundingClientRect();
        const move = (moved: PointerEvent): void => {
            setSplitShare(shareAt(moved.clientX, box.left, box.width), false);
            describe();
        };
        const end = (): void => {
            handle.removeEventListener("pointermove", move);
            handle.removeEventListener("pointerup", end);
            handle.removeEventListener("pointercancel", end);
            handle.removeAttribute("data-dragging");
            // Kept once let go, not at every move.
            setSplitShare(splitPrefs().share);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", end);
        handle.addEventListener("pointercancel", end);
    });
    handle.addEventListener("dblclick", () => {
        setSplitShare(SPLIT_SHARE);
        describe();
    });
    handle.addEventListener("keydown", (event) => {
        const share = shareForKey(event.key, splitPrefs().share);
        if (share !== null) {
            event.preventDefault();
            setSplitShare(share);
            describe();
        }
    });
    describe();
}
