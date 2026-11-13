// While a pop-up is up (a menu, the page settings, the feature search, an
// info drawing, the tab bar opened from its strip, a drawer), a press
// anywhere outside it only takes it away: that press goes no further, so
// the button under the pointer is not pressed by it as well. The pointer
// says so over everything but the pop-up: a circle with an x in it (the
// stylesheet, on :root[data-dismiss]; the pop-ups are marked data-popup).
// Stopping is never held back: a press on a button that stops something
// (the bar's Stop, .btn-stop, and every Stop, Abort, Hold, Cancel, Reset,
// Laser off and Stop spindle, marked .urgent) takes the pop-ups away and
// is still a press of that button. The other red buttons start something
// (Test beam, Start spindle, Make mark) and are held back like any other.

export interface PopUp {
    /** What counts as inside: the pop-up and what opened it. */
    nodes: () => (Element | null | undefined)[];
    /** Takes it away; called once by a press outside, and it then lets go itself. */
    close: () => void;
}

/** The buttons a press always reaches, a pop-up up or not. */
export const URGENT = ".btn-stop, .urgent";

const up = new Set<PopUp>();
let installed = false;
let swallowing: ((event: Event) => void) | null = null;

function mark(): void {
    document.documentElement.toggleAttribute("data-dismiss", up.size > 0);
    const marked = new Set<Element>();
    for (const popup of up) {
        for (const node of popup.nodes()) {
            if (node) {
                marked.add(node);
            }
        }
    }
    for (const node of Array.from(document.querySelectorAll("[data-popup]"))) {
        if (!marked.has(node)) {
            node.removeAttribute("data-popup");
        }
    }
    for (const node of marked) {
        node.setAttribute("data-popup", "");
    }
}

/** Swallows the click that ends a press which only took pop-ups away. */
function swallowNextClick(): void {
    if (swallowing) {
        globalThis.removeEventListener("click", swallowing, true);
    }
    const swallow = (event: Event): void => {
        event.preventDefault();
        event.stopPropagation();
        globalThis.removeEventListener("click", swallow, true);
        swallowing = null;
    };
    swallowing = swallow;
    globalThis.addEventListener("click", swallow, true);
    // A press let go elsewhere makes no click: the swallow ends with the press.
    const end = (): void => {
        globalThis.removeEventListener("pointerup", end, true);
        globalThis.removeEventListener("pointercancel", end, true);
        setTimeout(() => {
            if (swallowing === swallow) {
                globalThis.removeEventListener("click", swallow, true);
                swallowing = null;
            }
        }, 0);
    };
    globalThis.addEventListener("pointerup", end, true);
    globalThis.addEventListener("pointercancel", end, true);
}

function onPress(event: Event): void {
    // A pop-up whose nodes all left the page (drawn over by its view) is
    // not up any more, whatever it said.
    for (const popup of [...up]) {
        if (!popup.nodes().some((node) => node?.isConnected)) {
            up.delete(popup);
        }
    }
    if (up.size === 0) {
        mark();
        return;
    }
    const target = event.target;
    if (!(target instanceof Node)) {
        return;
    }
    const popups = [...up];
    if (popups.some((popup) => popup.nodes().some((node) => node?.contains(target)))) {
        return;
    }
    for (const popup of popups) {
        popup.close();
        up.delete(popup);
    }
    mark();
    if (target instanceof Element && target.closest(URGENT)) {
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    swallowNextClick();
}

/**
 * Says a pop-up is up until the returned function is called (by its own
 * close, whatever closed it). A press outside it calls `close`.
 */
export function popUp(popup: PopUp): () => void {
    if (!installed) {
        installed = true;
        // On the window, in the capture phase: before any listener on the
        // document or under it, the pop-ups' own among them.
        globalThis.addEventListener("pointerdown", onPress, true);
    }
    up.add(popup);
    mark();
    return () => {
        if (up.delete(popup)) {
            mark();
        }
    };
}

/** Whether any pop-up is up. */
export function anyPopUp(): boolean {
    return up.size > 0;
}
