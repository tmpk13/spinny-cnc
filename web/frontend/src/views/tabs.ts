// The page's tabs: the machine's page (the dashboard) and the CAM page. The
// pick is set on #app for the stylesheet and remembered per browser.

import { el } from "../dom.ts";

export type PageId = "machine" | "cam";

export const PAGES: { id: PageId; label: string }[] = [
    { id: "machine", label: "Machine" },
    { id: "cam", label: "CAM" },
];

const PAGE_KEY = "spinny.page";

function isPage(value: string | null | undefined): value is PageId {
    return PAGES.some((page) => page.id === value);
}

/** The page named in the address (`?page=cam`), else the one last shown in this browser, else the machine's. */
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

export function mountTabs(root: HTMLElement): void {
    root.setAttribute("role", "tablist");
    for (const page of PAGES) {
        root.append(
            el("button", { type: "button", class: "tab", role: "tab", "data-page": page.id, onclick: () => showPage(page.id) }, page.label),
        );
    }
    showPage(readPage());
}
