// Constant beam test, laser off, and the power mode.

import { askConfirm } from "../confirm.ts";

/** The longest beam test the firmware accepts, ms. */
export const MAX_BEAM_MS = 60000;
import { button, el, labeled, numberField } from "../dom.ts";
import { parseNumber } from "../format.ts";
import type { Mode } from "../types.ts";
import { choiceRow, setPressed, type Ctx } from "./context.ts";

export function mountLaser(root: HTMLElement, ctx: Ctx): void {
    const power = numberField({ value: 100, min: 0, step: 1 });
    const ms = numberField({ value: 1000, min: 1, step: 1 });
    const fire = button("Test beam", () => test(), "btn btn-danger btn-big");
    const off = button("Laser off", () => ctx.call(ctx.api.laserOff()), "btn btn-big");
    const modes = choiceRow<Mode>(["dyn", "const"], "dyn", (mode) => void ctx.call(ctx.api.mode(mode)), (mode) => mode, "Mode");
    const body = el("fieldset", { class: "panel-body" },
        el("div", { class: "field-row" },
            labeled("Power S", power),
            labeled("Duration ms", ms),
        ),
        el("div", { class: "button-row" }, fire, off),
        modes,
    );
    root.append(el("h2", {}, "Laser"), body);

    // Every test asks: the beam fires on a click, so no answer is remembered.
    async function test(): Promise<void> {
        const s = parseNumber(power.value);
        const t = parseNumber(ms.value);
        // What is checked is what is sent: whole milliseconds, at least
        // one, and no more than the firmware takes.
        const duration = t === null ? null : Math.round(t);
        if (s === null || s < 0 || duration === null || duration < 1) {
            ctx.toast("error", "enter a power and a duration of at least 1 ms");
            return;
        }
        if (duration > MAX_BEAM_MS) {
            ctx.toast("error", `the beam test runs for at most ${MAX_BEAM_MS} ms`);
            return;
        }
        const ok = await askConfirm(`Fire the beam at S${s} for ${duration} ms? Eye protection on.`, "Fire");
        if (ok) {
            await ctx.call(ctx.api.laser(s, duration));
        }
    }

    ctx.store.subscribe((state) => {
        body.disabled = !state.snapshot.connected;
        const mode = state.snapshot.machine?.mode;
        if (mode) {
            setPressed(modes, mode);
        }
    }, ["snapshot"]);
}
