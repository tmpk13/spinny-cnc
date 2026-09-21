// Constant beam test, laser off, and the power mode.

import { askConfirm } from "../confirm.ts";
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
        if (s === null || s < 0 || t === null || t <= 0) {
            ctx.toast("error", "enter a power and a duration");
            return;
        }
        const duration = Math.round(t);
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
