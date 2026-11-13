// The camera log in a camera's panel: logging every look on or off (one
// switch for every camera), a photo taken now with this camera, and the
// newest pictures it kept, each as it was and with what its finder found
// drawn on it, so a routine that went wrong can be seen look by look. The
// head and top cameras also list their newest search records, kept by the
// backend for every look for a board and every search whatever the switch
// says, each a page of its stops, poses and pictures.

import { askConfirm } from "../confirm.ts";
import { button, el, replace, setLocked } from "../dom.ts";
import type { AppState } from "../state.ts";
import type { CamLogEntry, CamLogState, LoggedCamera, SearchCamera, SearchLogState, SearchRecordLine } from "../types.ts";
import { into, type Ctx } from "./context.ts";

/** How many of a camera's newest pictures its panel shows. */
export const SHOWN = 6;
/** How many of a camera's newest search records its panel shows. */
export const SEARCHES_SHOWN = 4;

/** Results that say a search record went wrong, marked as a missed look is. */
const WENT_WRONG = new Set(["not found", "error", "unfinished", "cut short"]);

/** What a search record says, in a few words: how far it went and how long it took. */
export function searchText(line: SearchRecordLine): string {
    const parts: string[] = [];
    if (line.kind === "search" && line.stops !== null) {
        parts.push(`${line.visited ?? 0} of ${line.stops} stops`);
    }
    if (line.poses !== null) {
        parts.push(`${line.poses} poses`);
    }
    if (line.seconds !== null) {
        parts.push(`${line.seconds.toFixed(1)} s`);
    }
    if (line.job_name) {
        parts.push(line.job_name);
    }
    return parts.join(", ");
}

/** What a look found, in a few words. */
export function lookText(entry: CamLogEntry): string {
    const spot = entry.spot;
    if (spot === null) {
        return "no finder";
    }
    if (!spot.found) {
        return "found nothing";
    }
    const sign = (v: number | undefined): string => `${(v ?? 0) >= 0 ? "+" : ""}${(v ?? 0).toFixed(1)}`;
    return `found at dx ${sign(spot.dx)} dy ${sign(spot.dy)} px`;
}

/** A moment given as an ISO time, as the time of day. */
function clockOf(time: string): string {
    const at = time.indexOf("T");
    return at >= 0 ? time.slice(at + 1, at + 9) : time;
}

export function mountCameraLog(root: HTMLElement, ctx: Ctx, camera: LoggedCamera): void {
    const enabled = el("input", { type: "checkbox", "aria-label": "Log every look" }) as HTMLInputElement;
    const toggle = el("label", { class: "muted camlog-toggle", title: "keep each picture a routine looks at, with what the finder found" },
        enabled, " log every look (all cameras)");
    const photo = button("Photo", () => take(), "btn btn-small");
    photo.title = "keep a picture now, with what the finder sees";
    const clear = button("Clear log", () => clearAll(), "btn btn-quiet btn-small", "forget the pictures kept");
    const count = el("span", { class: "muted camlog-count" });
    const gallery = el("ul", { class: "camlog-list" });
    const searchHead = el("p", { class: "muted" }, "Board searches recorded, newest first: each a page of its stops, the poses read and the pictures.");
    const searches = el("ul", { class: "camlog-list" });
    searchHead.hidden = true;
    searches.hidden = true;
    // Only the cameras that look for a board have search records.
    const searchable = camera === "head" || camera === "top";
    root.append(el("div", { class: "camlog" },
        el("div", { class: "button-row" }, toggle, photo, clear, count),
        gallery,
        ...(searchable ? [searchHead, searches] : []),
    ));

    enabled.addEventListener("change", async () => {
        const state = await ctx.call(ctx.api.setCamLog(enabled.checked));
        if (state) {
            ctx.store.set({ camlog: state });
        } else {
            enabled.checked = !enabled.checked;
        }
    });

    async function take(): Promise<void> {
        const entry = await ctx.call(ctx.api.takePhoto(camera, true));
        if (entry) {
            await into(ctx, "camlog", ctx.api.camLog());
            ctx.toast("info", `photo kept: ${lookText(entry)}`);
        }
    }

    async function clearAll(): Promise<void> {
        if (!(await askConfirm("Delete the logged pictures of every camera?", "Clear log"))) {
            return;
        }
        const removed = await ctx.call(ctx.api.clearCamLog());
        if (removed !== null) {
            await into(ctx, "camlog", ctx.api.camLog());
        }
    }

    const link = (text: string, name: string | undefined): HTMLElement | null =>
        name ? el("a", { href: ctx.api.camLogFileUrl(name), target: "_blank", rel: "noopener" }, text) : null;

    // This camera's own entries and count, asked for by camera: the log
    // the page keeps holds the newest of every camera, where a run of
    // another camera's looks can push every one of this camera's out.
    let own: CamLogState | null = null;
    let asking = 0;

    async function refreshOwn(): Promise<void> {
        const ask = ++asking;
        const state = await ctx.call(ctx.api.camLog(camera));
        if (state && ask === asking) {
            own = state;
            drawOwn();
        }
    }

    function render(state: AppState): void {
        const log = state.camlog;
        enabled.checked = log?.enabled ?? false;
        setLocked(clear, (log?.entries.length ?? 0) === 0);
        void refreshOwn();
    }

    function drawOwn(): void {
        const mine = own?.entries ?? [];
        count.textContent = (own?.count ?? 0) === 0 ? "" : `${own!.count} kept of this camera`;
        replace(gallery, ...mine.slice(0, SHOWN).map((entry) => el("li", { class: entry.spot && !entry.spot.found ? "camlog-entry missed" : "camlog-entry" },
            el("a", { href: ctx.api.camLogFileUrl(entry.files.overlay), target: "_blank", rel: "noopener", class: "camlog-thumb" },
                el("img", { src: ctx.api.camLogFileUrl(entry.files.overlay), alt: `${entry.routine}: ${entry.step}`, loading: "lazy" })),
            el("div", { class: "camlog-text" },
                el("span", { class: "camlog-what" }, `${clockOf(entry.time)} ${entry.routine}: ${entry.step}`),
                el("span", { class: "muted" }, `${entry.note ? `${entry.note}, ` : ""}${lookText(entry)}`),
                el("span", { class: "camlog-links" }, link("photo", entry.files.photo), " ", link("with marks", entry.files.overlay), " ", link("pose", entry.files.pose)),
            ),
        )));
    }
    ctx.store.subscribe(render, ["camlog"]);
    render(ctx.store.get());
    void into(ctx, "camlog", ctx.api.camLog());

    // The search records, asked for by camera as the pictures are.
    if (!searchable) {
        return;
    }
    const searchCamera: SearchCamera = camera === "head" ? "head" : "top";
    let ownSearches: SearchLogState | null = null;
    let askingSearches = 0;

    async function refreshSearches(): Promise<void> {
        const ask = ++askingSearches;
        const state = await ctx.call(ctx.api.searchLog(searchCamera));
        if (state && ask === askingSearches) {
            ownSearches = state;
            drawSearches();
        }
    }

    function drawSearches(): void {
        const lines = ownSearches?.records ?? [];
        searchHead.hidden = lines.length === 0;
        searches.hidden = lines.length === 0;
        replace(searches, ...lines.slice(0, SEARCHES_SHOWN).map((line) => el("li", { class: WENT_WRONG.has(line.result) ? "camlog-entry missed" : "camlog-entry" },
            el("div", { class: "camlog-text" },
                el("span", { class: "camlog-what" }, `${clockOf(line.started)} ${line.kind}: ${line.result}`),
                el("span", { class: "muted" }, searchText(line) || (line.message ?? "")),
                el("span", { class: "camlog-links" },
                    el("a", { href: ctx.api.searchLogUrl(line.id, "report"), target: "_blank", rel: "noopener" }, "report"), " ",
                    el("a", { href: ctx.api.searchLogUrl(line.id, "record.json"), target: "_blank", rel: "noopener" }, "data")),
            ),
        )));
    }
    ctx.store.subscribe(() => void refreshSearches(), ["searchlog"]);
    void refreshSearches();
}
