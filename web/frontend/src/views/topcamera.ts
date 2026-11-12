// A G-code machine's top camera, on its head and looking down: its
// device picked from the cameras found or typed, its size, rate and the
// shade of a mark, its picture controls, and its offset from the nozzle
// measured from a mark the nozzle's tip was put on; the look for the
// selected job's board, the search over a box for it, and the place found
// kept as the board's references. Its picture shows in the Top camera
// view panel; the looks of its routines are kept in its camera log.

import { button, el, labeled, lockFor, numberField, setLocked, Tracked, type TrackedField } from "../dom.ts";
import { parseNumber } from "../format.ts";
import type { AppState } from "../state.ts";
import type { SpotPolarity, TopSettings } from "../types.ts";
import { mountCameraControls } from "./cameracontrols.ts";
import { mountCameraPick } from "./camerapick.ts";
import { mountCameraLog } from "./camlog.ts";
import { into, type Ctx } from "./context.ts";
import { topCameraText, topRoutineText } from "./placing.ts";
import { infoTip } from "./infotip.ts";
import type { MachineBox } from "./picture.ts";
import { lookOnceText, polaritySelect } from "./pnp.ts";
import { lookText } from "./vision.ts";

export function mountTopCamera(root: HTMLElement, ctx: Ctx, visible: () => boolean, searchBox: () => MachineBox | null = () => null): void {
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
    const pick = mountCameraPick(ctx, {
        device,
        size,
        fps,
        otherLabel: "up camera",
        otherDevice: (state) => state.pnp?.device ?? null,
        visible,
    });
    const apply = button("Apply", () => applyTop(), "btn");
    apply.title = "send the fields changed";
    const lookOnce = button("Look once", () => into(ctx, "placing", ctx.api.topLook()), "btn");
    lookOnce.title = "find the mark spot once, with no move, and draw what was found over the picture";
    const lookLine = el("p", { class: "muted pnp-look-line" });
    const controls = mountCameraControls(ctx, "top", "the top camera");
    // The look for the selected job's board.
    const boardLook = button("Look for board", () => lookForBoard(), "btn");
    boardLook.title = "load the selected job's board: the camera looks for it in every picture until Unload";
    const boardSearch = button("Search", () => into(ctx, "placing", ctx.api.topSearch(searchBox())), "btn");
    boardSearch.title = "move the camera over the search box (Shift and a drag on its picture), or the board's size about where it looks, until enough looks agree on the board";
    const boardPlace = button("Use as board place", () => usePlace(), "btn");
    boardPlace.title = "keep where the looks put the board as its references (two parts far apart); Find fiducials then makes it exact";
    const boardUnload = button("Unload", () => into(ctx, "placing", ctx.api.topBoard(null)), "btn btn-quiet");
    boardUnload.title = "stop looking for the board";
    const boardLine = el("p", { class: "muted vision-look" });
    const offsetLine = el("p", { class: "muted" });
    const markHere = button("Nozzle on mark", () => into(ctx, "placing", ctx.api.topMark()), "btn");
    markHere.title = "the nozzle's tip is on a mark: keep its place for Measure offset";
    const step = numberField({ value: 2, min: 0, max: 20, step: 0.5, width: "5rem" });
    step.setAttribute("aria-label", "Top camera step mm");
    const measure = button("Measure offset", () => measureOffset(), "btn");
    measure.title = "move the top camera over the mark to measure its offset from the nozzle";
    const abort = button("Abort", () => into(ctx, "placing", ctx.api.topAbort()), "btn btn-danger");
    abort.title = "stop the top camera's routine (Measure offset, Find fiducials or Search) and the machine";
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
            el("div", { class: "button-row" }, apply, lookOnce),
            lookLine,
            controls.root,
            el("div", { class: "button-row" }, offsetLine, infoTip("offset")),
            el("div", { class: "button-row" }, markHere, labeled("Step mm", step, "labeled inline"), measure, abort),
            routineLine,
            el("h3", {}, "Board"),
            el("div", { class: "button-row" }, boardLook, boardSearch, boardPlace, boardUnload),
            boardLine,
            log,
        ),
    );

    // The fields: filled from the state unless edited since.
    const fields: [TrackedField, keyof TopSettings][] = [[device, "device"], [size, "size"], [fps, "fps"], [markSpot, "mark_spot"]];
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

    async function lookForBoard(): Promise<void> {
        const job = ctx.store.get().job;
        if (!job) {
            ctx.toast("error", "pick a board job first");
            return;
        }
        await into(ctx, "placing", ctx.api.topBoard(job.id));
    }

    async function usePlace(): Promise<void> {
        const look = ctx.store.get().placing?.top?.board_look;
        if (!look?.job) {
            return;
        }
        await into(ctx, "placing", ctx.api.topPlace(look.job));
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
        setLocked(abort, !busy, "no routine under way");
        offsetLine.textContent = topCameraText(top);
        routineLine.textContent = topRoutineText(top);
        lockFor(lookOnce, [top?.running !== true, "start the top camera first"]);
        lookLine.textContent = lookOnceText(top?.look ?? null);
        lookLine.classList.toggle("hidden", lookLine.textContent === "");
        const job = state.job;
        lockFor(boardLook, [top?.running !== true, "start the top camera first"], [!job, "pick a board job first"], [job?.design?.board !== true, "the camera needs a job uploaded as .kicad_pcb"], [busy, "a routine is under way"]);
        lockFor(boardSearch,
            [!look?.job, "load a board first: Look for board"],
            [!connected, "connect the machine first"],
            [running || moving || busy, "the machine is busy"],
            [!(top?.mm_per_px && top.mm_per_px > 0), "the top camera's scale is not measured: Measure offset first"]);
        lockFor(boardPlace, [!look?.found, "the board is not found yet: Search, or wait for enough looks to agree"], [busy, "a routine is under way"]);
        lockFor(boardUnload, [!look?.job, "no board loaded"], [busy, "a routine is under way"]);
        const name = look?.job ? state.jobs.find((entry) => entry.id === look.job)?.name ?? null : null;
        boardLine.textContent = lookText(look, name) || "No board loaded: pick a board job and press Look for board.";
        pick.render();
    }

    globalThis.addEventListener?.("pagehide", () => pick.stop());
    ctx.store.subscribe((state) => render(state), ["placing", "pnp", "cameras", "job", "jobs"]);
    render(ctx.store.get());
}
