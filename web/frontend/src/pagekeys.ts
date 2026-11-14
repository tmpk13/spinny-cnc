// PageUp and PageDown do not scroll the page. On a machine they are jog
// keys (a mill's file binds them to its Z), and a page that jumps under the
// operator's hand loses the panel they were working in; a held key's
// repeats, which a jog does not take, scrolled the page even where the key
// jogs. A text area keeps them for its own lines, and a pick for its
// options. The listener sits on the window, after the document's: the jog
// keys hear the key first, its default not yet prevented.

/** Whether the element with the key keeps PageUp and PageDown for itself: a text area, editable text, or a pick. */
export function keepsPageKeys(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) {
        return false;
    }
    return target.closest("textarea, select, [contenteditable]:not([contenteditable='false'])") !== null;
}

/** Whether a key scrolls a page by its height. */
export function isPageKey(key: string): boolean {
    return key === "PageDown" || key === "PageUp";
}

/** Stops PageUp and PageDown scrolling the page, wherever the focus is but in a text area or a pick. */
export function stopPageScroll(target: Window = window): void {
    target.addEventListener("keydown", (event) => {
        if (isPageKey(event.key) && !keepsPageKeys(event.target)) {
            event.preventDefault();
        }
    });
}
