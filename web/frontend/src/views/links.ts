// Links between the sides (src/sides.ts). A link names a target, a panel
// and what the panel is to show in itself, and is a real link: its address
// opens the target's side in a new tab (the middle button, Ctrl or a
// copied address), with the same backend. A plain press follows it here:
//
// 1. The target's side is in view in this tab (in front, or side by side):
//    its page comes up in its pane and the panel shows itself.
// 2. Another tab shows that side (src/tabsync.ts): that tab goes there, and
//    a toast here says so, with Show here for this tab instead.
// 3. Otherwise this tab swaps to the target's side; Back (the browser's,
//    or the other side's name in the bar) returns to where it was.
//
// The tabs know of each other through a TabSync, which also takes this
// tab to the targets other tabs send.

import { pushToast } from "../state.ts";
import { addressFor, browserTakes, parseTarget, readAddress, sideLabel, targetText, type Side, type Target } from "../sides.ts";
import { channelName, TabSync, type ChannelLike } from "../tabsync.ts";
import type { Ctx } from "./context.ts";
import { goToPanel } from "./steps.ts";
import { frontSide, isSplit, onPage, onSides, pageNamed, shownOn, showPage, sideInView, sideOf, sideOfNode, type PageId } from "./tabs.ts";

let sync: TabSync | null = null;
let context: Ctx | null = null;
/** Set while this tab goes where a link, Back or another tab sent it: the address then names where it is. */
let following = false;
/** When this tab last had the focus, ms since the epoch. */
let focused = 0;

/** The panel element a target names; null for none. */
function panelOf(target: Target): HTMLElement | null {
    const node = typeof document === "undefined" ? null : document.getElementById(target.panel);
    return node && node.closest("main.page") ? node : null;
}

/** The page a target's panel is on; null for a panel on no page. */
export function pageOfTarget(target: Target): PageId | null {
    const panel = panelOf(target);
    return panel ? pageNamed(panel.closest("main.page")?.id.replace(/^page-/, "")) : null;
}

/** The address of a target: its side and page, and the target as the hash, on this page's own address. */
export function hrefOf(target: Target): string {
    const page = pageOfTarget(target);
    const here = globalThis.location ?? { pathname: "/", search: "" };
    return addressFor(here, { side: page ? sideOf(page) : null, page, target });
}

/**
 * Shows a target in this tab: its page in its side's pane (that side in
 * front), the panel revealed and pulsing, and its view told the rest of
 * the target as a `spinny:goto` event. False for a target on no page.
 */
export function reveal(target: Target): boolean {
    const panel = panelOf(target);
    if (!panel) {
        return false;
    }
    goToPanel(target.panel);
    if (target.detail !== null) {
        panel.dispatchEvent(new CustomEvent("spinny:goto", { detail: target.detail }));
    }
    return true;
}

/** The page shown before a link swapped sides, put on the history entry so Back returns to it. */
interface HistoryNote {
    spinny: { page: PageId };
}

function noted(state: unknown): PageId | null {
    const page = (state as Partial<HistoryNote> | null)?.spinny?.page;
    return pageNamed(typeof page === "string" ? page : null);
}

/**
 * Takes the operator to a target, where the header says: here when its
 * side is in view, else a tab already showing that side, else here with
 * the sides swapped and a history entry to come back by.
 */
export async function goTo(target: Target): Promise<"here" | "tab" | "missing"> {
    const panel = panelOf(target);
    if (!panel) {
        return "missing";
    }
    const side = sideOfNode(panel);
    if (side === null || sideInView(side)) {
        reveal(target);
        return "here";
    }
    const peer = sync?.peerFor(side) ?? null;
    if (peer && sync && (await sync.send(peer.id, targetText(target)))) {
        const name = sideLabel(side);
        if (context) {
            pushToast(context.store, "info", `Shown in the ${name} tab${peer.visible ? " beside this one" : "; switch to it to see it"}.`, { label: "Show here", run: () => swapTo(target) });
        }
        return "tab";
    }
    swapTo(target);
    return "here";
}

/** This tab to a target on the other side, with a history entry so Back returns to the page shown now. */
function swapTo(target: Target): void {
    const before = shownOn(frontSide());
    const history = globalThis.history;
    try {
        history?.replaceState({ ...(history.state ?? {}), spinny: { page: before } } satisfies HistoryNote, "");
    } catch {
        // No history to note it in; the bar's side buttons still swap back.
    }
    following = true;
    reveal(target);
    following = false;
    try {
        history?.pushState({ spinny: { page: shownOn(frontSide()) } } satisfies HistoryNote, "", hrefOf(target));
    } catch {
        // As above.
    }
}

/**
 * A link to a target: an `a` with the target's address, so the browser
 * opens it in a tab of its own on the middle button or with Ctrl, and a
 * plain press follows it by `goTo`. A function for the target is read
 * each time, for a link whose target follows the state.
 */
export function linkTo(target: Target | (() => Target), label: string | Node, title: string, className = "side-link"): HTMLAnchorElement {
    const now = (): Target => (typeof target === "function" ? target() : target);
    const link = document.createElement("a");
    link.className = className;
    link.append(label);
    link.title = title;
    link.href = hrefOf(now());
    // The address is read again when the link is about to be used: the
    // backend's parameters stay, the page a panel sits on may have changed.
    const refresh = (): void => {
        link.href = hrefOf(now());
    };
    link.addEventListener("pointerenter", refresh);
    link.addEventListener("focus", refresh);
    link.addEventListener("click", (event) => {
        // A link in a panel's head is no press on the head (its fold).
        event.stopPropagation();
        if (browserTakes(event)) {
            refresh();
            return;
        }
        event.preventDefault();
        void goTo(now());
    });
    return link;
}

/** A link to a target written as text, `panel` or `panel/detail`; a plain span for one that does not read. */
export function linkToText(text: string, label: string | Node, title: string, className?: string): HTMLElement {
    const target = parseTarget(text);
    if (!target) {
        const span = document.createElement("span");
        span.append(label);
        return span;
    }
    return linkTo(target, label, title, className);
}

/** What this tab tells the others of itself. */
function describe(): { side: Side; split: boolean; pages: Record<Side, string>; visible: boolean; focused: number } {
    return {
        side: frontSide(),
        split: isSplit(),
        pages: { use: shownOn("use"), setup: shownOn("setup") },
        visible: typeof document === "undefined" || document.visibilityState !== "hidden",
        focused,
    };
}

/**
 * Starts the links: this tab known to the others on the channel of its
 * backend, the target another tab sends followed here, Back and Forward
 * between sides, and the address's own target followed once every view
 * has drawn. Returns the sync, for a test or a view that lists the tabs.
 */
export function mountLinks(ctx: Ctx, options: { apiBase: string; mock: boolean; channel?: ChannelLike | null }): TabSync {
    context = ctx;
    let channel: ChannelLike | null = options.channel ?? null;
    if (options.channel === undefined && typeof BroadcastChannel === "function") {
        try {
            channel = new BroadcastChannel(channelName(options.apiBase, options.mock)) as unknown as ChannelLike;
        } catch {
            channel = null;
        }
    }
    focused = typeof document !== "undefined" && document.hasFocus?.() ? Date.now() : 0;
    sync = new TabSync(channel, describe, (text) => {
        const target = parseTarget(text);
        if (!target || !reveal(target)) {
            return false;
        }
        // A browser lets a tab take the focus only now and then; asked, it
        // is no harm.
        globalThis.focus?.();
        return true;
    });
    const announce = (): void => sync?.announce();
    onSides(announce);
    document.addEventListener("visibilitychange", announce);
    globalThis.addEventListener?.("focus", () => {
        focused = Date.now();
        announce();
    });
    globalThis.addEventListener?.("pagehide", () => sync?.leave());
    // Back and Forward: the page the entry noted, then its target.
    globalThis.addEventListener?.("popstate", (event: PopStateEvent) => {
        // The entry's state is history.state too, in a browser.
        const page = noted(event.state ?? globalThis.history?.state);
        following = true;
        if (page !== null) {
            showPage(page);
        }
        const target = readAddress("", globalThis.location?.hash ?? "").target;
        if (target) {
            reveal(target);
        }
        following = false;
    });
    // Once the operator moves on by the bar, the address no longer names
    // where the tab is: it goes back to the page's own, so a reload opens
    // where the tab was last, not where a link once led.
    onPage(() => {
        if (following) {
            return;
        }
        const here = globalThis.location;
        if (!here) {
            return;
        }
        const plain = addressFor(here, {});
        const now = `${here.pathname}${here.search}${here.hash}`;
        if (plain !== now) {
            try {
                globalThis.history?.replaceState({ ...(globalThis.history.state ?? {}), spinny: { page: shownOn(frontSide()) } }, "", plain);
            } catch {
                // The address stays as it was.
            }
        }
    });
    sync.announce();
    return sync;
}

/** Follows the address's own target (a link opened in a new tab), once the views and the layout layer are up. */
export function followAddress(): void {
    const target = readAddress("", globalThis.location?.hash ?? "").target;
    if (target) {
        following = true;
        reveal(target);
        following = false;
    }
}
