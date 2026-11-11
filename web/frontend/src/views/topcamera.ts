// The G-code device's top camera, on its head and looking down: its
// device picked from the cameras found or typed, its size, rate and the
// shade of a mark, and its offset from the nozzle measured from a mark the
// nozzle's tip was put on. Its picture shows in the Cameras panel; the
// looks of its routines are kept in its camera log.

import { button, el, labeled, lockFor, numberField, setLocked, Tracked, type TrackedField } from "../dom.ts";
import { parseNumber } from "../format.ts";
import type { AppState } from "../state.ts";
import type { SpotPolarity, TopSettings } from "../types.ts";
import { mountCameraPick } from "./camerapick.ts";
import { mountCameraLog } from "./camlog.ts";
import { into, type Ctx } from "./context.ts";
import { topCameraText, topRoutineText } from "./device.ts";
import { infoTip } from "./infotip.ts";
import { polaritySelect } from "./pnp.ts";

export function mountTopCamera(root: HTMLElement, ctx: Ctx, visible: () => boolean): void {
    const badge = el("span", { class: "badge" }, "stopped");
    const start = button("Start", () => startTop(), "btn btn-primary");
    start.title = "start the top camera with these settings";
    const stop = button("Stop", () => into(ctx, "device", ctx.api.topStop()), "btn");
    const device = el("input", { type: "text", class: "field", "aria-label": "Top camera device", placeholder: "/dev/video2", spellcheck: "false" }) as HTMLInputElement;
    const size = el("input", { type: "text", class: "field", "aria-label": "Top camera size", placeholder: "1280x720", spellcheck: "false" }) as HTMLInputElement;
    const fps = numberField({ min: 1, max: 120, step: 1, width: "5rem" });
    fps.setAttribute("aria-label", "Top camera fps");
    const markSpot = polaritySelect("Mark spot");
    const pick = mountCameraPick(ctx, {
        device,
        size,
        fps,
        otherLabel: "up camera",
        otherDevice: (state) => state.pnp?.device ?? null,
        visible,
    });
    const apply = button("Apply", () => applyTop(), "btn");
    const offsetLine = el("p", { class: "muted" });
    const markHere = button("Nozzle on mark", () => into(ctx, "device", ctx.api.topMark()), "btn");
    markHere.title = "the nozzle's tip is on a mark: keep its place for Measure offset";
    const step = numberField({ value: 2, min: 0, max: 20, step: 0.5, width: "5rem" });
    step.setAttribute("aria-label", "Top camera step mm");
    const measure = button("Measure offset", () => measureOffset(), "btn");
    measure.title = "move the top camera over the mark to measure its offset from the nozzle";
    const abort = button("Abort", () => into(ctx, "device", ctx.api.topAbort()), "btn btn-danger");
    const routineLine = el("p", { class: "muted vision-routine" });
    const log = el("div", { class: "camlog-box" });
    mountCameraLog(log, ctx, "top");

    root.append(
        el("div", { class: "panel-head" }, el("h2", {}, "Top camera"), badge),
        el("fieldset", { class: "panel-body" },
            el("div", { class: "button-row" }, start, stop),
            pick.row,
            pick.note,
            el("div", { class: "field-grid" },
                labeled("Device", device),
                labeled("Size", size),
                labeled("fps", fps),
                labeled("Mark spot", markSpot),
            ),
            el("div", { class: "button-row" }, apply),
            el("div", { class: "button-row" }, offsetLine, infoTip("offset")),
            el("div", { class: "button-row" }, markHere, labeled("Step mm", step, "labeled inline"), measure, abort),
            routineLine,
            log,
        ),
    );

    // The fields: filled from the state unless edited since.
    const fields: [TrackedField, keyof TopSettings][] = [[device, "device"], [size, "size"], [fps, "fps"], [markSpot, "mark_spot"]];
    const tracked = new Tracked(fields.map(([field]) => field));

    function patchOf(): Partial<TopSettings> {
        const top = ctx.store.get().device?.top;
        const patch: Partial<TopSettings> = {};
        if (device.value.trim() !== "" && device.value.trim() !== top?.device) {
            patch.device = device.value.trim();
        }
        if (size.value.trim() !== "" && size.value.trim() !== top?.size) {
            patch.size = size.value.trim();
        }
        const rate = parseNumber(fps.value);
        if (rate !== null && rate !== top?.fps) {
            patch.fps = rate;
        }
        if (markSpot.value !== top?.mark_spot) {
            patch.mark_spot = markSpot.value as SpotPolarity;
        }
        return patch;
    }

    async function applyTop(): Promise<boolean> {
        const patch = patchOf();
        if (Object.keys(patch).length === 0) {
            return true;
        }
        const state = await ctx.call(ctx.api.topSettings(patch));
        if (state) {
            tracked.reset();
            ctx.store.set({ device: state });
        }
        return state !== undefined;
    }

    async function startTop(): Promise<void> {
        if (await applyTop()) {
            await into(ctx, "device", ctx.api.topStart());
        }
    }

    async function measureOffset(): Promise<void> {
        const value = parseNumber(step.value);
        if (value === null || value < 0 || value > 20) {
            ctx.toast("error", "step: 0 to 20 mm");
            return;
        }
        await into(ctx, "device", ctx.api.topOffset(value));
    }

    function render(state: AppState): void {
        const top = state.device?.top ?? null;
        const connected = state.device?.connected === true;
        const running = state.device?.running === true;
        const routine = state.pnp?.routine;
        const moving = routine?.state === "running" && routine.target === "device";
        const busy = top?.routine?.state === "running";
        for (const [field, key] of fields) {
            tracked.follow(field, top ? String(top[key] ?? "") : "");
        }
        badge.textContent = busy ? "routine" : top?.running ? "running" : "stopped";
        lockFor(start, [top?.running === true, "the top camera is running"], [busy, "a routine is under way"]);
        lockFor(stop, [top?.running !== true, "the top camera is not running"], [busy, "a routine is under way: abort it first"]);
        setLocked(apply, busy, "a routine is under way");
        lockFor(markHere, [!connected, "connect the device first"], [running || moving || busy, "the device is busy"]);
        lockFor(measure, [!connected, "connect the device first"], [running || moving || busy, "the device is busy"], [top?.running !== true, "start the top camera first"], [!top?.mark_at, "put the nozzle on a mark and press Nozzle on mark first"]);
        setLocked(abort, !busy, "no routine under way");
        offsetLine.textContent = topCameraText(top);
        routineLine.textContent = topRoutineText(top);
        pick.render();
    }

    globalThis.addEventListener?.("pagehide", () => pick.stop());
    ctx.store.subscribe((state) => render(state), ["device", "pnp", "cameras"]);
    render(ctx.store.get());
}
