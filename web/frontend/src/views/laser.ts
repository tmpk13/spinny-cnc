// Constant beam test, laser off, and the power mode; on a spindle machine
// the spindle's start, speed and stop instead.

import { askConfirm } from "../confirm.ts";

/** The longest beam test the firmware accepts, ms. */
export const MAX_BEAM_MS = 60000;
import { button, el, labeled, numberField, setLocked } from "../dom.ts";
import { parseNumber } from "../format.ts";
import { isMilling } from "../profile.ts";
import type { Mode } from "../types.ts";
import { choiceRow, setPressed, type Ctx } from "./context.ts";

export function mountLaser(root: HTMLElement, ctx: Ctx): void {
    const power = numberField({ value: 100, min: 0, step: 1 });
    const ms = numberField({ value: 1000, min: 1, step: 1 });
    const fire = button("Test beam", () => test(), "btn btn-danger btn-big");
    const off = button("Laser off", () => ctx.call(ctx.api.laserOff()), "btn btn-big");
    const modes = choiceRow<Mode>(["dyn", "const"], "dyn", (mode) => void ctx.call(ctx.api.mode(mode)), (mode) => mode, "Mode");
    const title = el("h2", {}, "Laser");
    const laserBody = el("div", { class: "tool-laser" },
        el("div", { class: "field-row" },
            labeled("Power S", power),
            labeled("Duration ms", ms),
        ),
        el("div", { class: "button-row" }, fire, off),
        modes,
    );
    const speed = numberField({ value: 800, min: 0, step: 1 });
    const start = button("Start spindle", () => startSpindle(), "btn btn-danger btn-big");
    const stop = button("Stop spindle", () => ctx.call(ctx.api.spindleOff()), "btn btn-big");
    const spindleBody = el("div", { class: "tool-spindle hidden" },
        el("div", { class: "field-row" }, labeled("Speed S", speed)),
        el("div", { class: "button-row" }, start, stop),
        el("p", { class: "muted hint" }, "A job starts and stops the spindle itself. It keeps turning through a hold: Stop ends a job and the spindle with it."),
    );
    const body = el("fieldset", { class: "panel-body" }, laserBody, spindleBody);
    root.append(title, body);

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

    // A spinning tool is as much a hazard as a beam, and it keeps turning
    // until it is stopped, so starting it always asks.
    async function startSpindle(): Promise<void> {
        const s = parseNumber(speed.value);
        if (s === null || s < 0) {
            ctx.toast("error", "enter a speed of 0 or more");
            return;
        }
        const ok = await askConfirm(`Start the spindle at S${s}? It turns until Stop spindle. Tool clear of the work, guard on.`, "Start");
        if (ok) {
            await ctx.call(ctx.api.spindle(s));
        }
    }

    ctx.store.subscribe((state) => {
        body.disabled = !state.snapshot.connected;
        const milling = isMilling(state.snapshot);
        title.textContent = milling ? "Spindle" : "Laser";
        laserBody.classList.toggle("hidden", milling);
        spindleBody.classList.toggle("hidden", !milling);
        const mode = state.snapshot.machine?.mode;
        if (mode) {
            setPressed(modes, mode);
        }
        // The tool may be the probe: it must not turn while it touches down.
        // Stop stays open whatever happens.
        setLocked(start, state.heightMap?.probe?.state === "running");
    }, ["snapshot", "heightMap"]);
}
