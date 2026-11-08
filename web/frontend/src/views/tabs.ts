// The page's tabs: the Jobs page (the dashboard: position, jogging, the
// jobs and their preview), the Plot page (simple cuts made by hand, a
// board's holes drilled), the CAM page, the PNP page (parts, the board and
// the up camera) and the Config page (the machine files and the list of
// their keys). The pick is set on #app for the stylesheet and remembered
// per browser. A tab whose page holds edits not applied yet carries their
// count.

import { el } from "../dom.ts";
import type { AppState, Store } from "../state.ts";

export type PageId = "jobs" | "plot" | "cam" | "pnp" | "config";

export const PAGES: { id: PageId; label: string }[] = [
    { id: "jobs", label: "Jobs" },
    { id: "plot", label: "Plot" },
    { id: "cam", label: "CAM" },
    { id: "pnp", label: "PNP" },
    { id: "config", label: "Config" },
];

const PAGE_KEY = "spinny.page";

/** The pages' names before they were renamed, so an old address or a
 * page remembered from before still opens the same page. */
const RENAMED: Record<string, PageId> = { machine: "jobs", mill: "plot" };

/** The page of each panel that holds edits until they are applied. */
export const PENDING_PAGES: Record<string, PageId> = {
    settings: "config",
    "machine-file": "config",
    camera: "jobs",
    "job-json": "jobs",
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

/** A page id, an old name of one, or null. */
function pageNamed(value: string | null | undefined): PageId | null {
    if (isPage(value)) {
        return value;
    }
    return value != null && Object.hasOwn(RENAMED, value) ? RENAMED[value]! : null;
}

/** The page named in the address (`?page=plot`, `?page=cam`, `?page=pnp`, `?page=config`), else the one last shown in this browser, else the Jobs page. */
export function readPage(): PageId {
    try {
        const asked = pageNamed(new URLSearchParams(globalThis.location?.search ?? "").get("page"));
        if (asked !== null) {
            return asked;
        }
    } catch {
        // No address to read; the memory decides.
    }
    try {
        return pageNamed(globalThis.localStorage?.getItem(PAGE_KEY)) ?? "jobs";
    } catch {
        return "jobs";
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
