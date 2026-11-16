// The page's two sides. The Use side runs the machine (its areas Home,
// Job and Run); the Setup side is what the machine is and knows (its
// checklist, its files and connection, its cameras, the CAM profiles,
// this page's own settings). Each page belongs to
// one side. A browser tab shows one side at a time, or both side by side
// (split), and each side has an address of its own, so it can be open in a
// tab or a window of its own beside the other.
//
// An address names a side, a page and a target in it:
// `?side=setup&page=machines#machine-file/controls`. The target is a panel's
// id, then after a slash what the panel is asked to show in itself (a
// fact, a key); its view hears it as a `spinny:goto` event. The other
// parameters (`mock`, `api`) are kept, so a link reaches the same backend.

export type Side = "use" | "setup";

export const SIDES: readonly { id: Side; label: string; tip: string }[] = [
    { id: "use", label: "Use", tip: "run the machine: make jobs and run them" },
    { id: "setup", label: "Setup", tip: "what the machine is and knows: its checklist, files, connection, cameras and CAM profiles" },
];

export function isSide(value: unknown): value is Side {
    return value === "use" || value === "setup";
}

export function otherSide(side: Side): Side {
    return side === "use" ? "setup" : "use";
}

export function sideLabel(side: Side): string {
    return SIDES.find((entry) => entry.id === side)!.label;
}

/** A place on the page: a panel, and what it is asked to show in itself. */
export interface Target {
    panel: string;
    /** After the slash: a fact's id, a key; null for the panel itself. */
    detail: string | null;
}

/** What an address asks for; null where it asks nothing. */
export interface Address {
    side: Side | null;
    /** As written: a page id or an old name of one. */
    page: string | null;
    target: Target | null;
    split: boolean | null;
}

/** The parameters an address sets; the others are the page's own (the mock, the api) and travel with every link. */
const OWN = ["side", "page", "split"];

/** A target from its text, `panel` or `panel/detail`; null for an empty one or a panel id that is no id. */
export function parseTarget(text: string): Target | null {
    const cut = text.indexOf("/");
    const panel = cut < 0 ? text : text.slice(0, cut);
    if (!/^[A-Za-z][\w-]*$/.test(panel)) {
        return null;
    }
    const detail = cut < 0 ? "" : text.slice(cut + 1);
    return { panel, detail: detail === "" ? null : detail };
}

export function targetText(target: Target): string {
    return target.detail === null ? target.panel : `${target.panel}/${target.detail}`;
}

/** What `?...` and `#...` ask for. A hash that does not read as a target is left alone: it is no address's. */
export function readAddress(search: string, hash: string): Address {
    const params = new URLSearchParams(search);
    const side = params.get("side");
    const split = params.get("split");
    let target: Target | null = null;
    const raw = hash.startsWith("#") ? hash.slice(1) : hash;
    if (raw !== "") {
        try {
            target = parseTarget(decodeURIComponent(raw));
        } catch {
            target = null;
        }
    }
    return {
        side: isSide(side) ? side : null,
        page: params.get("page"),
        target,
        split: split === "1" ? true : split === "0" ? false : null,
    };
}

/**
 * The address of a side, a page and a target, on the page at `here`: its
 * path and the parameters that are not an address's own, so a link opened
 * in a new tab talks to the same backend (or the same mock).
 */
export function addressFor(here: { pathname: string; search: string }, to: { side?: Side | null; page?: string | null; target?: Target | null; split?: boolean | null }): string {
    const params = new URLSearchParams(here.search);
    for (const name of OWN) {
        params.delete(name);
    }
    if (to.side) {
        params.set("side", to.side);
    }
    if (to.page) {
        params.set("page", to.page);
    }
    if (to.split === true || to.split === false) {
        params.set("split", to.split ? "1" : "0");
    }
    const query = params.toString();
    const hash = to.target ? `#${encodeURI(targetText(to.target)).replace(/#/g, "%23")}` : "";
    return `${here.pathname}${query === "" ? "" : `?${query}`}${hash}`;
}

/** The address with none of an address's own parts: what the bar shows once the page has gone elsewhere by its tabs. */
export function plainAddress(here: { pathname: string; search: string }): string {
    return addressFor(here, {});
}

/** Whether a click on a link is the browser's to take: a new tab or window, a download, or not the main button. */
export function browserTakes(event: { button: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }): boolean {
    return event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey;
}
