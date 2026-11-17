// The page's areas, on two sides (src/sides.ts), listed down a rail at
// the window's left (a bar across the top on a narrow window). The Use
// side has three areas: Home (where things stand, a card for each area),
// Job (the jobs, the selected job, its preview, drawing operations by
// hand and the assistant that makes jobs) and Run (the machine, its
// steps, where the board is, heights, the cameras' pictures, the parts and
// the run itself). The Setup side: the Checklist (what the machine knows,
// where each value came from, what is missing), Machines (the machine
// files, the connection and the firmware's settings), Cameras (each
// camera's device, calibration and routines, the head and the bed), CAM
// (the CAM profiles) and Page (this page's version, bug reports and
// plugins).
//
// The rail names each side over its areas and lists both sides' areas, so
// every place the page has is in sight and one press away. A narrow
// window's bar has no room for both: there the other side's areas fold
// away behind its name, which swaps to it, and the area each side last
// showed comes back. Side by side (split),
// both sides show at once, each in a pane of its own with its tabs, and a
// handle between the panes sets their widths. Which page each side shows,
// and whether they are side by side, is set on #app for the stylesheet
// and remembered per browser. A tab whose page holds edits not applied yet
// carries their count.
//
// What the page settings menu sets for the tabs is kept per browser too
// (TabPrefs): the tab the page opens on, whether the bar folds to a thin
// strip that opens on hover or a press, and tabs kept out of the bar, which
// then open from a More folder at the bar's end.

import { el, readStored, svgIcon, writeStored } from "../dom.ts";
import { countText } from "../format.ts";
import { readObject } from "../layout.ts";
import { popUp } from "../dismiss.ts";
import { closeMenu, openMenu } from "../menu.ts";
import { isSide, otherSide, readAddress, SIDES, type Side } from "../sides.ts";
import type { AppState, Store } from "../state.ts";

export type PageId = "home" | "job" | "run" | "facts" | "machines" | "cameras" | "cam" | "ui";

/**
 * The pages in the rail's order: each one's tab label, its tooltip, its
 * side, and its color, a Solarized accent by name (Home's and the
 * Checklist's are grays: each stands for its whole side).
 * The color is the page's own: its tab is underlined in it, its panels
 * wear it along their top edge, and its Overview card draws in it, unless
 * the page settings turn colors off.
 */
export const PAGES: { id: PageId; label: string; tip: string; accent: string; side: Side }[] = [
    { id: "home", label: "Home", tip: "where things stand: every area at a glance", accent: "base01", side: "use" },
    { id: "job", label: "Job", tip: "the jobs: open a file, draw one, describe one; the preview", accent: "orange", side: "use" },
    { id: "run", label: "Run", tip: "the machine: its steps, the board's place, heights, cameras, the run", accent: "green", side: "use" },
    { id: "facts", label: "Checklist", tip: "what the machine knows: each value, where it came from, and what is missing", accent: "base00", side: "setup" },
    { id: "machines", label: "Machines", tip: "the machine files, the connection and the firmware's settings", accent: "yellow", side: "setup" },
    { id: "cameras", label: "Cameras", tip: "each camera's device, calibration and routines; the head and the bed", accent: "violet", side: "setup" },
    { id: "cam", label: "CAM", tip: "the CAM profiles: axes, tools and operations", accent: "cyan", side: "setup" },
    { id: "ui", label: "Page", tip: "this page: its version, bug reports and plugins", accent: "red", side: "setup" },
];

/** A page's color as a CSS value, its Solarized variable; the page's accent for a page not listed. */
export function accentOf(page: string): string {
    const accent = PAGES.find((entry) => entry.id === page)?.accent;
    return accent ? `var(--${accent})` : "var(--accent)";
}

/** The side a page is on. */
export function sideOf(page: PageId): Side {
    return PAGES.find((entry) => entry.id === page)!.side;
}

/** The pages of a side, in the bar's order. */
export function pagesOf(side: Side): PageId[] {
    return PAGES.filter((page) => page.side === side).map((page) => page.id);
}

const PAGE_KEY = "spinny.page";
export const TABS_KEY = "spinny.tabs";
/** The page each side last showed, so a swap brings it back. */
export const SIDE_PAGES_KEY = "spinny.side-pages";
/** Whether the sides show side by side, and the Use side's share of the width. */
export const SPLIT_KEY = "spinny.split";

/** The pages' names before they were renamed or merged into areas, so an
 * old address, a page remembered from before or a plugin asking for a page
 * by its old name still opens where that page's panels went. */
const RENAMED: Record<string, PageId> = {
    machine: "job", mill: "job", jobs: "job", plot: "job", auto: "job",
    overview: "home", pnp: "run",
    config: "machines", connection: "machines", plugins: "ui",
};

/** The page of each panel that holds edits until they are applied. */
export const PENDING_PAGES: Record<string, PageId> = {
    "machine-file": "machines",
    camera: "cameras",
    "job-json": "job",
    plot: "job",
    "cam-profile": "cam",
    pnp: "cameras",
    "pnp-head": "cameras",
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
export function pageNamed(value: string | null | undefined): PageId | null {
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

/** The page each side shows, from stored text: a page of the side, else the side's first. */
export function parseSidePages(text: string | null): Record<Side, PageId> {
    const raw = readObject(text);
    const pages = { use: "job", setup: "facts" } as Record<Side, PageId>;
    for (const side of ["use", "setup"] as Side[]) {
        const page = pageNamed(typeof raw[side] === "string" ? raw[side] : null);
        if (page !== null && sideOf(page) === side) {
            pages[side] = page;
        }
    }
    return pages;
}

/** The split's settings: whether the sides show side by side, and the Use side's share of the width, 0.2 to 0.8. */
export interface SplitPrefs {
    on: boolean;
    share: number;
}

export const SPLIT_SHARE = 0.6;
export const SPLIT_MIN = 0.2;
export const SPLIT_MAX = 0.8;

export function parseSplitPrefs(text: string | null): SplitPrefs {
    const raw = readObject(text);
    const share = typeof raw["share"] === "number" && Number.isFinite(raw["share"]) ? Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, raw["share"])) : SPLIT_SHARE;
    return { on: raw["on"] === true, share };
}

/**
 * The page to open on: the one named in the address (`?page=run`,
 * `?page=machines`), else the page the side named in it (`?side=setup`)
 * last showed, else the start page the settings name, else the one last
 * shown in this browser, else the Job area.
 */
export function readPage(): PageId {
    try {
        const address = readAddress(globalThis.location?.search ?? "", "");
        const asked = pageNamed(address.page);
        if (asked !== null) {
            return asked;
        }
        if (address.side !== null) {
            return parseSidePages(readStored(SIDE_PAGES_KEY))[address.side];
        }
    } catch {
        // No address to read; the settings and the memory decide.
    }
    const start = readTabPrefs().start;
    if (start !== "last") {
        return start;
    }
    return pageNamed(readStored(PAGE_KEY)) ?? "job";
}

const pageListeners: ((id: PageId) => void)[] = [];

/** Hears every page shown. */
export function onPage(listener: (id: PageId) => void): void {
    pageListeners.push(listener);
}

// What this browser tab shows: the page each side shows, the side in
// front (side by side, the one last worked in), and whether the sides
// are side by side when the window is wide enough for it.
const shown: Record<Side, PageId> = parseSidePages(null);
let front: Side = "use";
let split: SplitPrefs = { on: false, share: SPLIT_SHARE };
const sideListeners: (() => void)[] = [];

/** Hears every change of side, of a side's page or of the split. */
export function onSides(listener: () => void): void {
    sideListeners.push(listener);
}

/** Whether the window is wide enough for the sides side by side: the width the page's columns take. */
export function wideWindow(): boolean {
    return typeof globalThis.matchMedia !== "function" || globalThis.matchMedia("(min-width: 64rem)").matches;
}

/** Whether the tabs are the rail down the window's left side: on a window wide enough for it, as the stylesheet lays it out. */
export function railShown(): boolean {
    try {
        return typeof globalThis.matchMedia === "function" && globalThis.matchMedia("(min-width: 64rem)").matches;
    } catch {
        return false;
    }
}

/** The side in front: shown alone, or side by side the one last worked in. */
export function frontSide(): Side {
    return front;
}

/** The page a side shows, or showed last. */
export function shownOn(side: Side): PageId {
    return shown[side];
}

/** Whether both sides show now: asked for, and the window wide enough. */
export function isSplit(): boolean {
    return split.on && wideWindow();
}

/** Whether a side is in view in this tab: in front, or side by side. */
export function sideInView(side: Side): boolean {
    return side === front || isSplit();
}

export function splitPrefs(): SplitPrefs {
    return { ...split };
}

/** Puts the sides side by side or one at a time, and remembers it unless `keep` is false (an address asked for it). */
export function setSplit(on: boolean, keep = true): void {
    split = { ...split, on };
    if (keep) {
        writeStored(SPLIT_KEY, JSON.stringify(split));
    }
    applySides();
}

/** Sets the Use side's share of the width side by side, remembered unless `keep` is false (a drag under way). */
export function setSplitShare(share: number, keep = true): void {
    split = { ...split, share: Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, share)) };
    if (keep) {
        writeStored(SPLIT_KEY, JSON.stringify(split));
    }
    applySides();
}

/** Brings a side to the front with the page it last showed. */
export function showSide(side: Side): void {
    showPage(shown[side]);
}

/**
 * Shows a page: in its side's pane, that side brought to the front (alone,
 * the other side folds away; side by side, both stay). The attributes the
 * stylesheet switches on, the tabs' state, and the memory of it.
 */
export function showPage(id: PageId): void {
    const side = sideOf(id);
    shown[side] = id;
    front = side;
    writeStored(PAGE_KEY, id);
    writeStored(SIDE_PAGES_KEY, JSON.stringify(shown));
    applySides();
    for (const listener of pageListeners) {
        listener(id);
    }
}

/** Sets on the page what shows: #app's page, side and split, each page and pane up or not, each tab selected or not. */
function applySides(): void {
    const app = typeof document === "undefined" ? null : document.getElementById("app");
    if (!app) {
        return;
    }
    const both = isSplit();
    app.setAttribute("data-page", shown[front]);
    app.setAttribute("data-side", front);
    app.toggleAttribute("data-split", both);
    app.style.setProperty("--split-cols", `minmax(0, ${split.share}fr) var(--divider) minmax(0, ${1 - split.share}fr)`);
    const up = (page: PageId): boolean => shown[sideOf(page)] === page && (both || sideOf(page) === front);
    for (const main of Array.from(app.querySelectorAll<HTMLElement>("main.page"))) {
        const page = pageNamed(main.id.replace(/^page-/, ""));
        main.toggleAttribute("data-up", page !== null && up(page));
    }
    for (const pane of Array.from(app.querySelectorAll<HTMLElement>(".pane"))) {
        const side = pane.dataset["side"];
        pane.toggleAttribute("data-up", both || side === front);
        pane.toggleAttribute("data-front", side === front);
    }
    for (const tab of Array.from(document.querySelectorAll<HTMLButtonElement>(".tabs .tab"))) {
        const page = pageNamed(tab.dataset["page"]);
        tab.setAttribute("aria-selected", page !== null && up(page) ? "true" : "false");
    }
    for (const listener of sideListeners) {
        listener();
    }
}

/**
 * Mounts the tab bar in `root`: each side's button with its tabs after it,
 * the button that puts the sides side by side, the More folder for tabs
 * kept out, and a tools area at the bar's end, returned, for the page
 * settings.
 */
export function mountTabs(root: HTMLElement, store: Store<AppState>): HTMLElement {
    const groups = SIDES.map((entry) => {
        const button = el("button", {
            type: "button",
            class: "tabs-side",
            "data-side": entry.id,
            title: `${entry.label}: ${entry.tip}`,
            onclick: () => {
                showSide(entry.id);
                root.removeAttribute("data-open");
            },
        }, entry.label);
        const list = el("div", { class: "tabs-list", role: "tablist", "aria-label": `${entry.label} pages`, "data-side": entry.id });
        return { side: entry.id, button, list, group: el("div", { class: "tabs-group", "data-side": entry.id }, button, list) };
    });
    const splitButton = el("button", {
        type: "button",
        class: "tabs-tool tabs-split",
        "aria-pressed": "false",
        onclick: () => {
            setSplit(!split.on);
            root.removeAttribute("data-open");
        },
    }, svgIcon("M1 2h14v12H1z M2.5 3.5v9h4.6v-9z M8.9 3.5v9h4.6v-9z", true));
    // Its name, drawn beside the drawing where the rail has room for it.
    splitButton.dataset["label"] = "Side by side";
    const more = el("button", { type: "button", class: "tabs-more", "aria-haspopup": "menu" }, "More");
    const tools = el("div", { class: "tabs-tools" });
    // The Setup side's group goes with the tools, so side by side they sit
    // over the Setup pane together (the stylesheet).
    const bar = el("div", { class: "tabs-bar" }, groups[0]!.group, el("div", { class: "tabs-right" }, groups[1]!.group, splitButton, more, tools));
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
        // The page's color, on its tab and on its page for the panels.
        tab.style.setProperty("--page-accent", accentOf(page.id));
        document.getElementById(`page-${page.id}`)?.style.setProperty("--page-accent", accentOf(page.id));
        groups.find((entry) => entry.side === page.side)!.list.append(tab);
        return { page: page.id, tab };
    });
    let prefs = readTabPrefs();
    split = parseSplitPrefs(readStored(SPLIT_KEY));

    /** The bar as the settings, the sides and the page shown have it. */
    function draw(): void {
        const both = isSplit();
        const page = shown[front];
        for (const { page: id, tab } of tabs) {
            tab.hidden = prefs.hidden.includes(id);
        }
        // The rail has room for both sides' areas; a narrow window's bar
        // folds the other side's away behind its name.
        const rail = railShown();
        for (const entry of groups) {
            const open = both || entry.side === front || rail;
            entry.list.hidden = !open;
            entry.button.setAttribute("aria-pressed", entry.side === front ? "true" : "false");
            entry.button.toggleAttribute("data-open", open);
            entry.button.title = open
                ? `${entry.button.textContent}: ${SIDES.find((side) => side.id === entry.side)!.tip}`
                : `swap to ${entry.button.textContent} (\\): ${SIDES.find((side) => side.id === entry.side)!.tip}; it opens on ${PAGES.find((other) => other.id === shown[entry.side])!.label}`;
        }
        splitButton.hidden = !wideWindow();
        splitButton.setAttribute("aria-pressed", both ? "true" : "false");
        splitButton.title = both ? "one side at a time (|)" : "Use and Setup side by side (|)";
        splitButton.setAttribute("aria-label", splitButton.title);
        more.hidden = prefs.hidden.length === 0;
        const label = PAGES.find((entry) => entry.id === page)?.label ?? page;
        // The page shown when its own tab is kept out: More stands for it.
        const inMore = prefs.hidden.includes(page);
        more.textContent = inMore ? label : "More";
        more.setAttribute("aria-current", inMore ? "page" : "false");
        more.style.setProperty("--page-accent", inMore ? accentOf(page) : "var(--border-strong)");
        more.title = inMore ? "the page shown; its tab is kept out of the bar" : "tabs kept out of the bar";
        root.toggleAttribute("data-fold", prefs.fold);
        root.toggleAttribute("data-split", both);
        // Drawn by the stylesheet, so no button's text is a tab's name twice.
        strip.dataset["label"] = label;
        strip.title = "show the tabs";
    }

    more.addEventListener("click", () => {
        openMenu(prefs.hidden.map((id) => ({
            label: PAGES.find((entry) => entry.id === id)!.label,
            checked: id === shown[front],
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
    sideListeners.push(() => draw());
    // A window made narrow shows one side; made wide again, both, if asked.
    globalThis.matchMedia?.("(min-width: 64rem)").addEventListener?.("change", () => applySides());

    // The page each side showed last, then the page to open on, and side
    // by side if the address or the memory asks.
    Object.assign(shown, parseSidePages(readStored(SIDE_PAGES_KEY)));
    const asked = readAddress(globalThis.location?.search ?? "", "").split;
    if (asked !== null) {
        split = { ...split, on: asked };
    }
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
                tab.title = PAGES.find((entry) => entry.id === page)!.tip;
            }
        }
        // A side folded away says how many edits it holds.
        for (const entry of groups) {
            const count = pagesOf(entry.side).reduce((sum, page) => sum + pendingOn(state.pending, page), 0);
            if (count > 0) {
                entry.button.setAttribute("data-pending", String(count));
            } else {
                entry.button.removeAttribute("data-pending");
            }
        }
    }, ["pending"]);
    return tools;
}

/** Whether a key press is one the sides answer: `\` swaps them, `|` puts them side by side or back, with no field in use. */
export function sideKey(event: KeyboardEvent): "swap" | "split" | null {
    if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) {
        return null;
    }
    const target = event.target;
    if (target instanceof Element && target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) {
        return null;
    }
    return event.key === "\\" ? "swap" : event.key === "|" ? "split" : null;
}

/** Swaps the side in front, or the split, by the keys `sideKey` names. */
export function mountSideKeys(): void {
    document.addEventListener("keydown", (event) => {
        const key = sideKey(event);
        if (key === null || event.defaultPrevented) {
            return;
        }
        event.preventDefault();
        if (key === "swap") {
            showSide(otherSide(front));
        } else if (wideWindow()) {
            setSplit(!split.on);
        }
    });
}

/** The side a pane or page element belongs to; null outside the panes. */
export function sideOfNode(node: Element): Side | null {
    const side = node.closest<HTMLElement>(".pane")?.dataset["side"];
    if (isSide(side)) {
        return side;
    }
    const page = pageNamed(node.closest("main.page")?.id.replace(/^page-/, ""));
    return page === null ? null : sideOf(page);
}
