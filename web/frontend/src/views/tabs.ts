// The page's tabs: the Overview page (a card for each page, with what it
// holds now), the Jobs page (the dashboard: position, jogging, the
// jobs and their preview), the Plot page (simple cuts made by hand, a
// board's holes drilled), the CAM page, the PNP page (parts, the board and
// the up camera), the Auto page (a conversation with a language model that
// makes jobs and other data) and the Config page (the machine files and
// the list of their keys). The pick is set on #app for the stylesheet and remembered
// per browser. A tab whose page holds edits not applied yet carries their
// count.
//
// What the page settings menu sets for the tabs is kept per browser too
// (TabPrefs): the tab the page opens on, whether the bar folds to a thin
// strip that opens on hover or a press, and tabs kept out of the bar, which
// then open from a More folder at the bar's end.

import { el, readStored, writeStored } from "../dom.ts";
import { countText } from "../format.ts";
import { readObject } from "../layout.ts";
import { popUp } from "../dismiss.ts";
import { closeMenu, openMenu } from "../menu.ts";
import type { AppState, Store } from "../state.ts";

export type PageId = "overview" | "jobs" | "plot" | "cam" | "pnp" | "auto" | "config" | "connection" | "plugins";

export const PAGES: { id: PageId; label: string; tip: string }[] = [
    { id: "overview", label: "Overview", tip: "every page at a glance" },
    { id: "jobs", label: "Jobs", tip: "jobs, the preview and runs" },
    { id: "plot", label: "Plot", tip: "operations drawn by hand" },
    { id: "cam", label: "CAM", tip: "CAM profiles and their G-code" },
    { id: "pnp", label: "PNP", tip: "pick and place" },
    { id: "auto", label: "Auto", tip: "a model that makes jobs" },
    { id: "config", label: "Config", tip: "machine files and settings" },
    { id: "connection", label: "Connection", tip: "the port and the machine connected" },
    { id: "plugins", label: "Plugins", tip: "page plugins and their switches" },
];

const PAGE_KEY = "spinny.page";
export const TABS_KEY = "spinny.tabs";

/** The pages' names before they were renamed, so an old address or a
 * page remembered from before still opens the same page. */
const RENAMED: Record<string, PageId> = { machine: "jobs", mill: "plot" };

/** The page of each panel that holds edits until they are applied. */
export const PENDING_PAGES: Record<string, PageId> = {
    "machine-file": "config",
    camera: "jobs",
    "job-json": "jobs",
    plot: "plot",
    "cam-profile": "cam",
    pnp: "pnp",
    "pnp-head": "pnp",
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

/** What the page settings menu keeps for the tabs. */
export interface TabPrefs {
    /** The page shown when the page opens: "last" for the one last shown, else a page id. */
    start: "last" | PageId;
    /** The bar folds to a thin strip and opens on hover or a press. */
    fold: boolean;
    /** Pages whose tabs are kept out of the bar; they open from its More folder. */
    hidden: PageId[];
}

/** The tab settings in stored text; anything missing or malformed is the plain bar opening on the last page. */
export function parseTabPrefs(text: string | null): TabPrefs {
    const raw = readObject(text);
    const start = pageNamed(typeof raw["start"] === "string" ? raw["start"] : null);
    const hidden = Array.isArray(raw["hidden"]) ? raw["hidden"].map((value) => pageNamed(typeof value === "string" ? value : null)) : [];
    return {
        start: start ?? "last",
        fold: raw["fold"] === true,
        hidden: PAGES.map((page) => page.id).filter((id) => hidden.includes(id)),
    };
}

export function readTabPrefs(): TabPrefs {
    return parseTabPrefs(readStored(TABS_KEY));
}

const prefListeners: ((prefs: TabPrefs) => void)[] = [];

/** Keeps the tab settings and has the bar follow them. */
export function writeTabPrefs(prefs: TabPrefs): void {
    writeStored(TABS_KEY, JSON.stringify(prefs));
    for (const listener of prefListeners) {
        listener(prefs);
    }
}

/**
 * The page to open on: the one named in the address (`?page=plot`,
 * `?page=cam`, `?page=pnp`, `?page=auto`, `?page=config`), else the start
 * page the settings name, else the one last shown in this browser, else
 * the Jobs page.
 */
export function readPage(): PageId {
    try {
        const asked = pageNamed(new URLSearchParams(globalThis.location?.search ?? "").get("page"));
        if (asked !== null) {
            return asked;
        }
    } catch {
        // No address to read; the settings and the memory decide.
    }
    const start = readTabPrefs().start;
    if (start !== "last") {
        return start;
    }
    return pageNamed(readStored(PAGE_KEY)) ?? "jobs";
}

const pageListeners: ((id: PageId) => void)[] = [];

/** Hears every page shown. */
export function onPage(listener: (id: PageId) => void): void {
    pageListeners.push(listener);
}

/** Shows a page: the attribute the stylesheet switches on, the tabs' state, and the memory of it. */
export function showPage(id: PageId): void {
    const app = document.getElementById("app");
    app?.setAttribute("data-page", id);
    for (const tab of Array.from(document.querySelectorAll<HTMLButtonElement>(".tabs .tab"))) {
        tab.setAttribute("aria-selected", tab.dataset["page"] === id ? "true" : "false");
    }
    writeStored(PAGE_KEY, id);
    for (const listener of pageListeners) {
        listener(id);
    }
}

/**
 * Mounts the tab bar in `root`: a tab per page, the More folder for tabs
 * kept out, and a tools area at the bar's end, returned, for the page
 * settings.
 */
export function mountTabs(root: HTMLElement, store: Store<AppState>): HTMLElement {
    const list = el("div", { class: "tabs-list", role: "tablist", "aria-label": "Pages" });
    const more = el("button", { type: "button", class: "tabs-more", "aria-haspopup": "menu" }, "More");
    const tools = el("div", { class: "tabs-tools" });
    const bar = el("div", { class: "tabs-bar" }, list, more, tools);
    // Folded, the bar is a strip naming the page; a press opens it, for a
    // screen with no hover.
    const strip = el("button", { type: "button", class: "tabs-strip", "aria-label": "Show the tabs" });
    root.append(strip, bar);
    const tabs = PAGES.map((page) => {
        const tab = el("button", {
            type: "button",
            class: "tab",
            role: "tab",
            title: page.tip,
            "data-page": page.id,
            onclick: () => {
                showPage(page.id);
                root.removeAttribute("data-open");
            },
        }, page.label);
        list.append(tab);
        return { page: page.id, tab };
    });
    let prefs = readTabPrefs();
    const current = (): PageId => pageNamed(document.getElementById("app")?.getAttribute("data-page")) ?? "jobs";

    /** The bar as the settings and the page shown have it. */
    function draw(): void {
        const page = current();
        for (const { page: id, tab } of tabs) {
            tab.hidden = prefs.hidden.includes(id);
        }
        more.hidden = prefs.hidden.length === 0;
        const label = PAGES.find((entry) => entry.id === page)?.label ?? page;
        // The page shown when its own tab is kept out: More stands for it.
        const inMore = prefs.hidden.includes(page);
        more.textContent = inMore ? label : "More";
        more.setAttribute("aria-current", inMore ? "page" : "false");
        more.title = inMore ? "the page shown; its tab is kept out of the bar" : "tabs kept out of the bar";
        root.toggleAttribute("data-fold", prefs.fold);
        // Drawn by the stylesheet, so no button's text is a tab's name twice.
        strip.dataset["label"] = label;
        strip.title = "show the tabs";
    }

    more.addEventListener("click", () => {
        openMenu(prefs.hidden.map((id) => ({
            label: PAGES.find((entry) => entry.id === id)!.label,
            checked: id === current(),
            run: () => {
                showPage(id);
                root.removeAttribute("data-open");
            },
        })), more, "Tabs kept out of the bar");
    });
    strip.addEventListener("click", () => {
        root.toggleAttribute("data-open");
    });
    // A press anywhere else folds an opened strip again.
    document.addEventListener("pointerdown", (event) => {
        if (root.hasAttribute("data-open") && event.target instanceof Node && !root.contains(event.target) && !(event.target instanceof Element && event.target.closest(".menu"))) {
            root.removeAttribute("data-open");
        }
    }, true);
    // Opened from its strip, the bar is a pop-up: a press elsewhere only folds it.
    let release: (() => void) | null = null;
    const followOpen = (): void => {
        if (root.hasAttribute("data-open") && release === null) {
            release = popUp({ nodes: () => [root], close: () => root.removeAttribute("data-open") });
        } else if (!root.hasAttribute("data-open") && release !== null) {
            release();
            release = null;
        }
    };
    if (typeof MutationObserver === "function") {
        new MutationObserver(followOpen).observe(root, { attributes: true, attributeFilter: ["data-open"] });
    }
    root.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && root.hasAttribute("data-open")) {
            root.removeAttribute("data-open");
            closeMenu(false);
            strip.focus();
        }
    });
    prefListeners.push((next) => {
        prefs = next;
        draw();
    });
    onPage(() => draw());

    showPage(readPage());
    draw();
    // The count is drawn by the stylesheet from an attribute, so the tab's
    // text stays its name.
    store.subscribe((state) => {
        for (const { page, tab } of tabs) {
            const count = pendingOn(state.pending, page);
            if (count > 0) {
                tab.setAttribute("data-pending", String(count));
                tab.title = `${countText(count, "edit", "edits")} on this page not applied`;
            } else {
                tab.removeAttribute("data-pending");
                tab.removeAttribute("title");
            }
        }
    }, ["pending"]);
    return tools;
}
