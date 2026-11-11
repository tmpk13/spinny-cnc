// A prompt across the top of the page when the height map's focus offset
// was taken back. The backend drops it on every connect and restart, since
// nothing there says the focus axis is still where it was; the operator
// may know better (a link that dropped mid-cut and came straight back,
// say) and keep it rather than focus again.

import { button, el } from "../dom.ts";
import { formatFixed } from "../format.ts";
import { isMilling } from "../profile.ts";
import type { AppState } from "../state.ts";
import { into, type Ctx } from "./context.ts";
import { mapComplete } from "./heightmap.ts";

export interface FocusPrompt {
    text: string;
    keep: string;
}

/**
 * What the banner says, or null when there is nothing to offer: the map is
 * probed everywhere and was focused once, but its offset was taken back.
 */
export function focusPrompt(state: AppState): FocusPrompt | null {
    const map = state.heightMap?.map ?? null;
    if (!state.snapshot.connected || map === null || map.focus_set || !map.focus_known || !mapComplete(map)) {
        return null;
    }
    const milling = isMilling(state.snapshot);
    const what = milling ? "touch-off" : "focus";
    const axis = milling ? "depth axis" : "focus axis";
    const again = milling ? "touch off here again" : "focus here again";
    const offset = formatFixed(map.focus_offset, 4);
    const record = state.snapshot.resume ?? null;
    const stopped = record?.state === "error" ? `Run ${record.job} stopped at line ${record.acked} of ${record.total}. ` : "";
    return {
        text: `${stopped}The height map's ${what} offset (${offset} mm) was dropped: the ${axis} may have moved.`
            + ` Keep it if not; otherwise ${again}.`,
        keep: `Keep ${offset}`,
    };
}

export function mountFocusBanner(root: HTMLElement, ctx: Ctx): void {
    const text = el("span", { class: "banner-text" });
    // Its label, Keep and the offset, is set from the prompt.
    const keep = button("", () => into(ctx, "heightMap", ctx.api.keepFocus()), "btn btn-primary btn-small");
    const dismiss = el("button", { type: "button", class: "btn btn-quiet btn-small" }, "Dismiss");
    const banner = el("div", { class: "banner hidden", role: "status" }, text, keep, dismiss);
    root.append(banner);
    // Dismissed for one prompt: a later drop of the offset asks again.
    let dismissed: string | null = null;

    dismiss.addEventListener("click", () => {
        dismissed = text.textContent;
        banner.classList.add("hidden");
    });

    ctx.store.subscribe((state) => {
        const prompt = focusPrompt(state);
        if (prompt === null) {
            dismissed = null;
        }
        banner.classList.toggle("hidden", prompt === null || prompt.text === dismissed);
        if (prompt !== null) {
            text.textContent = prompt.text;
            keep.textContent = prompt.keep;
        }
    }, ["snapshot", "heightMap"]);
}
