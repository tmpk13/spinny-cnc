// The page's tabs: the machine's page (the dashboard), the CAM page, the
// PNP page (parts, the board and the up camera) and the Config page (the
// machine files and the firmware settings). The pick
// is set on #app for the stylesheet and remembered per browser. A tab
// whose page holds edits not applied yet carries their count.

import { el } from "../dom.ts";
import type { AppState, Store } from "../state.ts";

export type PageId = "machine" | "cam" | "pnp" | "config";

export const PAGES: { id: PageId; label: string }[] = [
    { id: "machine", label: "Machine" },
    { id: "cam", label: "CAM" },
    { id: "pnp", label: "PNP" },
    { id: "config", label: "Config" },
];

const PAGE_KEY = "spinny.page";

/** The page of each panel that holds edits until they are applied. */
export const PENDING_PAGES: Record<string, PageId> = {
    settings: "config",
    "machine-file": "config",
    camera: "machine",
    "cam-profile": "cam",
    pnp: "pnp",
    "pnp-device": "pnp",
};

/** The count of edits not applied yet on a page. */
export function pendingOn(pending: Record<string, number>, page: PageId): number {
    let count = 0;
    for (const [source, edits] of Object.entries(pending)) {
        if (PENDING_PAGES[source] === page) {
            count += edits;
        }
    }
    return count;
}

function isPage(value: string | null | undefined): value is PageId {
    return PAGES.some((page) => page.id === value);
}

/** The page named in the address (`?page=cam`, `?page=pnp`, `?page=config`), else the one last shown in this browser, else the machine's. */
export function readPage(): PageId {
    try {
        const asked = new URLSearchParams(globalThis.location?.search ?? "").get("page");
        if (isPage(asked)) {
            return asked;
        }
    } catch {
        // No address to read; the memory decides.
    }
    try {
        const stored = globalThis.localStorage?.getItem(PAGE_KEY);
        return isPage(stored) ? stored : "machine";
    } catch {
        return "machine";
    }
}

/** Shows a page: the attribute the stylesheet switches on, the tabs' state, and the memory of it. */
export function showPage(id: PageId): void {
    const app = document.getElementById("app");
    app?.setAttribute("data-page", id);
    for (const tab of Array.from(document.querySelectorAll<HTMLButtonElement>(".tabs .tab"))) {
        tab.setAttribute("aria-selected", tab.dataset["page"] === id ? "true" : "false");
    }
    try {
        globalThis.localStorage?.setItem(PAGE_KEY, id);
    } catch {
        // Not remembered; the page still shows.
    }
}

export function mountTabs(root: HTMLElement, store?: Store<AppState>): void {
    root.setAttribute("role", "tablist");
    const tabs = PAGES.map((page) => {
        const tab = el("button", { type: "button", class: "tab", role: "tab", "data-page": page.id, onclick: () => showPage(page.id) }, page.label);
        root.append(tab);
        return { page: page.id, tab };
    });
    showPage(readPage());
    // The count is drawn by the stylesheet from an attribute, so the tab's
    // text stays its name.
    store?.subscribe((state) => {
        for (const { page, tab } of tabs) {
            const count = pendingOn(state.pending, page);
            if (count > 0) {
                tab.setAttribute("data-pending", String(count));
                tab.title = `${count} edit${count === 1 ? "" : "s"} on this page not applied`;
            } else {
                tab.removeAttribute("data-pending");
                tab.removeAttribute("title");
            }
        }
    }, ["pending"]);
}
