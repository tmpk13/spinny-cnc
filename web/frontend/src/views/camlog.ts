// The camera log in a camera's panel: logging every look on or off (one
// switch for every camera), a photo taken now with this camera, and the
// newest pictures it kept, each as it was and with what its finder found
// drawn on it, so a routine that went wrong can be seen look by look.

import { askConfirm } from "../confirm.ts";
import { button, el, replace, setLocked } from "../dom.ts";
import type { AppState } from "../state.ts";
import type { CamLogEntry, CamLogState, LoggedCamera } from "../types.ts";
import { into, type Ctx } from "./context.ts";

/** How many of a camera's newest pictures its panel shows. */
export const SHOWN = 6;

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

/** When a picture was taken, as the time of day. */
function timeOf(entry: CamLogEntry): string {
    const at = entry.time.indexOf("T");
    return at >= 0 ? entry.time.slice(at + 1, at + 9) : entry.time;
}

export function mountCameraLog(root: HTMLElement, ctx: Ctx, camera: LoggedCamera): void {
    const enabled = el("input", { type: "checkbox", "aria-label": "Log every look" }) as HTMLInputElement;
    const toggle = el("label", { class: "muted camlog-toggle", title: "keep every picture the cameras' routines look at, as it was and with what the finder found drawn on it" },
        enabled, " log every look (every camera)");
    const photo = button("Photo", () => take(), "btn btn-small");
    photo.title = "keep a picture now, as it is and with what the finder sees drawn on it";
    const clear = button("Clear log", () => clearAll(), "btn btn-quiet btn-small");
    const count = el("span", { class: "muted camlog-count" });
    const gallery = el("ul", { class: "camlog-list" });
    root.append(el("div", { class: "camlog" },
        el("div", { class: "button-row" }, toggle, photo, clear, count),
        gallery,
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
        if (!(await askConfirm("Forget every picture the camera log kept, of every camera?", "Clear log"))) {
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
                el("span", { class: "camlog-what" }, `${timeOf(entry)} ${entry.routine}: ${entry.step}`),
                el("span", { class: "muted" }, `${entry.note ? `${entry.note}, ` : ""}${lookText(entry)}`),
                el("span", { class: "camlog-links" }, link("photo", entry.files.photo), " ", link("with marks", entry.files.overlay), " ", link("pose", entry.files.pose)),
            ),
        )));
    }
    ctx.store.subscribe(render, ["camlog"]);
    render(ctx.store.get());
    void into(ctx, "camlog", ctx.api.camLog());
}
