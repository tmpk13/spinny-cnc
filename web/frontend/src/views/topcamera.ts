// A G-code machine's top camera, on its head and looking down: its
// device picked from the cameras found or typed, its size, rate and the
// shade of a mark, its picture controls, and its offset from the nozzle
// measured from a mark the nozzle's tip was put on, and Home by fiducial.
// Its picture shows in the Top camera view panel; the looks of its routines
// are kept in its camera log. The look for a board, its search and the
// place found are the Find board panel's (findboard.ts).

import { button, el, labeled, lockFor, numberField, setLocked, Tracked, type TrackedField } from "../dom.ts";
import { parseNumber } from "../format.ts";
import type { AppState } from "../state.ts";
import type { CameraFinish, CameraSide, SpotPolarity, TopSettings } from "../types.ts";
import { mountCameraControls, placeFolds, type CameraFolds } from "./cameracontrols.ts";
import { mountCameraSight } from "./camerasight.ts";
import { mountCameraPick } from "./camerapick.ts";
import { mountCameraLog } from "./camlog.ts";
import { into, type Ctx } from "./context.ts";
import { topCameraText, topRoutineText } from "./placing.ts";
import { infoTip } from "./infotip.ts";
import { lookOnceText, polaritySelect } from "./pnp.ts";

export function mountTopCamera(root: HTMLElement, ctx: Ctx, visible: () => boolean, folds?: CameraFolds): void {
    const badge = el("span", { class: "badge" }, "stopped");
    const start = button("Start", () => startTop(), "btn btn-primary");
    start.title = "start the top camera with these settings";
    const stop = button("Stop", () => into(ctx, "placing", ctx.api.topStop()), "btn");
    stop.title = "stop the top camera";
    const device = el("input", { type: "text", class: "field", "aria-label": "Top camera device", placeholder: "/dev/video2", spellcheck: "false" }) as HTMLInputElement;
    const size = el("input", { type: "text", class: "field", "aria-label": "Top camera size", placeholder: "1280x720", spellcheck: "false" }) as HTMLInputElement;
    const fps = numberField({ min: 1, max: 120, step: 1, width: "5rem" });
    fps.setAttribute("aria-label", "Top camera fps");
    const markSpot = polaritySelect("Mark spot");
    // The board as the top camera sees it, for its look for a board.
    const side = el("select", { class: "field", "aria-label": "Top camera board side" }, el("option", { value: "front" }, "front"), el("option", { value: "back" }, "back")) as HTMLSelectElement;
    side.title = "the side of the board the camera looks at";
    const finish = el("select", { class: "field", "aria-label": "Top camera board finish" }, el("option", { value: "masked" }, "masked"), el("option", { value: "bare" }, "bare")) as HTMLSelectElement;
    finish.title = "masked: solder mask hides the copper but the pads; bare: all the copper shows";
    const paste = el("select", { class: "field", "aria-label": "Top camera board paste" }, el("option", { value: "false" }, "no paste"), el("option", { value: "true" }, "paste")) as HTMLSelectElement;
    paste.title = "whether the board carries solder paste; the parts a run places are told to the camera as it places them";
    const pick = mountCameraPick(ctx, {
        device,
        size,
        fps,
        otherLabel: "bottom camera",
        otherDevice: (state) => state.pnp?.device ?? null,
        visible,
    });
    const apply = button("Apply", () => applyTop(), "btn");
    apply.title = "send the fields changed";
    const lookOnce = button("Look once", () => into(ctx, "placing", ctx.api.topLook()), "btn");
    lookOnce.title = "find the mark spot once, with no move, and draw what was found over the picture";
    const lookLine = el("p", { class: "muted pnp-look-line" });
    const controls = mountCameraControls(ctx, "top", "the top camera");
    const sight = mountCameraSight(ctx, { camera: "top", label: "the top camera", settings: (state) => state.placing?.top ?? null, running: (state) => state.placing?.top?.running === true });
    const offsetLine = el("p", { class: "muted" });
    const markHere = button("Nozzle on mark", () => into(ctx, "placing", ctx.api.topMark()), "btn");
    markHere.title = "the nozzle's tip is on a mark: keep its place for Measure offset";
    const step = numberField({ value: 2, min: 0, max: 20, step: 0.5, width: "5rem" });
    step.setAttribute("aria-label", "Top camera step mm");
    const measure = button("Measure offset", () => measureOffset(), "btn");
    measure.title = "move the top camera over the mark to measure its offset from the nozzle";
    const homeFiducial = button("Home by fiducial", () => into(ctx, "placing", ctx.api.topHome()), "btn",
        "home, then find the bed's homing fiducial and correct where the head is from it");
    const abort = button("Abort", () => into(ctx, "placing", ctx.api.topAbort()), "btn btn-danger urgent");
    abort.title = "stop the top camera's routine (Measure offset, Home by fiducial, Find fiducials or Search) and the machine";
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
                labeled("Side", side),
                labeled("Finish", finish),
                labeled("Paste", paste),
            ),
            el("div", { class: "button-row" }, apply, lookOnce),
            lookLine,
            ...placeFolds(folds, "top", controls.root, sight.root),
            el("div", { class: "button-row" }, offsetLine, infoTip("offset")),
            el("div", { class: "button-row" }, markHere, labeled("Step mm", step, "labeled inline"), measure, homeFiducial, abort),
            routineLine,
            log,
        ),
    );

    // The fields: filled from the state unless edited since.
    const fields: [TrackedField, keyof TopSettings][] = [[device, "device"], [size, "size"], [fps, "fps"], [markSpot, "mark_spot"], [side, "side"], [finish, "finish"], [paste, "paste"]];
    const tracked = new Tracked(fields.map(([field]) => field));

    function patchOf(): Partial<TopSettings> {
        const top = ctx.store.get().placing?.top;
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
        if (top && side.value !== (top.side ?? "front")) {
            patch.side = side.value as CameraSide;
        }
        if (top && finish.value !== (top.finish ?? "masked")) {
            patch.finish = finish.value as CameraFinish;
        }
        if (top && (paste.value === "true") !== (top.paste ?? false)) {
            patch.paste = paste.value === "true";
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
            ctx.store.set({ placing: state });
        }
        return state !== undefined;
    }

    async function startTop(): Promise<void> {
        if (await applyTop()) {
            await into(ctx, "placing", ctx.api.topStart());
        }
    }

    async function measureOffset(): Promise<void> {
        const value = parseNumber(step.value);
        if (value === null || value < 0 || value > 20) {
            ctx.toast("error", "step: 0 to 20 mm");
            return;
        }
        await into(ctx, "placing", ctx.api.topOffset(value));
    }

    function render(state: AppState): void {
        sight.render(state);
        const top = state.placing?.top ?? null;
        const connected = state.placing?.connected === true;
        const running = state.placing?.running === true;
        const routine = state.pnp?.routine;
        const moving = routine?.state === "running" && routine.target === "gcode";
        const busy = top?.routine?.state === "running";
        for (const [field, key] of fields) {
            tracked.follow(field, top ? String(top[key] ?? "") : "");
        }
        const look = top?.board_look;
        const badgeText = busy ? (top?.routine?.kind === "search" ? "searching" : "routine") : !top?.running ? "stopped" : look?.found ? "found" : look?.job ? "looking" : "running";
        badge.textContent = badgeText;
        badge.setAttribute("data-camera", badgeText === "routine" ? "finding mark" : badgeText);
        lockFor(start, [top?.running === true, "the top camera is running"], [busy, "a routine is under way"]);
        lockFor(stop, [top?.running !== true, "the top camera is not running"], [busy, "a routine is under way: abort it first"]);
        setLocked(apply, busy, "a routine is under way");
        lockFor(markHere, [!connected, "connect the machine first"], [running || moving || busy, "the machine is busy"]);
        lockFor(measure, [!connected, "connect the machine first"], [running || moving || busy, "the machine is busy"], [top?.running !== true, "start the top camera first"], [!top?.mark_at, "put the nozzle on a mark and press Nozzle on mark first"]);
        lockFor(homeFiducial,
            [!state.placing?.document?.top?.home_fiducial, "the machine file has no [top_camera] home_fiducial"],
            [!connected, "connect the machine first"],
            [running || moving || busy, "the machine is busy"],
            [top?.running !== true, "start the top camera first"],
            [!(top?.mm_per_px && top.mm_per_px > 0), "the top camera's offset is not measured: Measure offset first"]);
        setLocked(abort, !busy, "no routine under way");
        offsetLine.textContent = topCameraText(top);
        routineLine.textContent = topRoutineText(top);
        lockFor(lookOnce, [top?.running !== true, "start the top camera first"]);
        lookLine.textContent = lookOnceText(top?.look ?? null);
        lookLine.classList.toggle("hidden", lookLine.textContent === "");
        pick.render();
    }

    globalThis.addEventListener?.("pagehide", () => pick.stop());
    ctx.store.subscribe((state) => render(state), ["placing", "pnp", "cameras", "job", "jobs"]);
    render(ctx.store.get());
}
