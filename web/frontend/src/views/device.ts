// The PNP page's G-code device: a pick and place machine of its own whose
// controller takes the G-code OpenPnP's GcodeDriver sends (Marlin,
// Smoothieware, RepRapFirmware, Grbl). Its profile (pnp/*.toml: the port,
// the dialect, the heights, the vacuum sensor, the cameras and the
// feeders) is edited here with the TOML editor the machine files use; the
// up camera's place and the nozzle's runout are measured on it; its top
// camera (on the head, looking down) is set up and its offset measured
// from a mark; the board is placed on the device from reference parts read
// off it, or from its fiducials found by the top camera; and a placement
// is planned, shown, downloaded or run, its parts left out named, and the
// last lines either way show below.

import { askConfirm } from "../confirm.ts";
import { activePage, button, el, labeled, numberField, replace, setLocked, Tracked, type TrackedField } from "../dom.ts";
import { formatFixed, parseNumber } from "../format.ts";
import { setPending, type AppState } from "../state.ts";
import type { DevicePlan, DeviceReference, DeviceState, SpotPolarity, TopSettings, TopState } from "../types.ts";
import { mountCameraPick } from "./camerapick.ts";
import { mountCameraLog } from "./camlog.ts";
import { into, type Ctx } from "./context.ts";
import { codeEditor } from "./editor.ts";
import { pnpRoutineText, polaritySelect } from "./pnp.ts";
import type { Setup } from "./steps.ts";
import { FRAME_INTERVAL_MS, FRAME_WIDTH } from "./vision.ts";

/** The references of one job. */
export function referencesOf(device: DeviceState | null, jobId: string | null): DeviceReference[] {
    return jobId === null ? [] : (device?.references ?? []).filter((entry) => entry.job === jobId);
}

/** What the badge says of the device. */
export function deviceBadge(device: DeviceState | null): string {
    if (!device) {
        return "no device";
    }
    if (device.running) {
        return "sending";
    }
    if (device.lost) {
        return "lost";
    }
    return device.connected ? "connected" : "disconnected";
}

/** One line on a program being sent, or how the last one ended. */
export function deviceRunText(device: DeviceState | null): string {
    const run = device?.progress;
    if (!run) {
        return "";
    }
    const failed = run.failed?.length ?? 0;
    const where = `${run.sent} of ${run.total} lines, ${run.placed.length} parts placed${failed > 0 ? `, ${failed} left out` : ""}`;
    switch (run.state) {
        case "running":
            return `Sending: ${where}${run.part ? `, now ${run.part}` : ""}${run.doing ? ` (${run.doing})` : ""}, ${formatFixed(run.seconds, 0)} s`;
        case "done":
            return `Done: ${where} in ${formatFixed(run.seconds, 0)} s.`;
        case "stopped":
            return `Stopped: ${where}.`;
        default:
            return `Failed: ${where}: ${run.error ?? "no reason given"}`;
    }
}

/** The parts of the last run's job not placed by it: what Run the rest sends. */
export function partsLeft(device: DeviceState | null, plan: DevicePlan | null, jobId: string | null): string[] {
    const run = device?.progress;
    if (!run || !plan || jobId === null || run.job !== jobId || run.state === "running") {
        return [];
    }
    const placed = new Set(run.placed);
    return plan.parts.map((part) => part.ref).filter((ref) => !placed.has(ref));
}

/** The plan in words: what it places, and what it leaves and why. */
export function planText(plan: DevicePlan): string {
    const fit = plan.fit.marks > 1 ? `, the board turned ${formatFixed(plan.fit.rotation, 2)} deg (rms ${formatFixed(plan.fit.rms, 3)} mm)` : "";
    const looked = plan.parts.filter((part) => part.vision).length;
    return `${plan.parts.length} parts in ${plan.lines} lines${fit}${looked > 0 ? `; ${looked} looked at over the up camera` : ""}.`;
}

/** Where the up camera sits on the device, in words. */
export function deviceCameraText(device: DeviceState | null): string {
    const camera = device?.camera;
    if (!camera?.position || !(camera.mm_per_px > 0)) {
        return "The up camera's place on the device is not measured: jog the nozzle over it so it shows in the picture, then Center nozzle.";
    }
    const sharp = camera.height !== null ? `, the nozzle sharp at Z ${formatFixed(camera.height, 3)}` : "";
    const runout = camera.runout
        ? ` Runout ${formatFixed(Math.hypot(camera.runout[0], camera.runout[1]) * 1000, 0)} um (tip X ${formatFixed(camera.runout[0], 3)} Y ${formatFixed(camera.runout[1], 3)} off the axis at 0).`
        : " Runout not measured.";
    return `Up camera at X ${formatFixed(camera.position[0], 3)} Y ${formatFixed(camera.position[1], 3)}${sharp}, `
        + `${formatFixed(camera.mm_per_px * 1000, 1)} um per pixel, roll ${formatFixed(camera.roll, 2)} deg${camera.mirror ? ", mirrored" : ""}.${runout}`;
}

/** Where the top camera looks from the nozzle, in words. */
export function topCameraText(top: TopState | null | undefined): string {
    if (!top?.offset || !(top.mm_per_px > 0)) {
        return top?.mark_at
            ? `The nozzle was on the mark at X ${formatFixed(top.mark_at[0], 3)} Y ${formatFixed(top.mark_at[1], 3)}: Measure offset finds it with the camera.`
            : "The top camera's offset is not measured: put the nozzle's tip on a mark and press Nozzle on mark, then Measure offset.";
    }
    return `Top camera looks from X ${formatFixed(top.offset[0], 3)} Y ${formatFixed(top.offset[1], 3)} off the nozzle, `
        + `${formatFixed(top.mm_per_px * 1000, 1)} um per pixel, roll ${formatFixed(top.roll, 2)} deg${top.mirror ? ", mirrored" : ""}.`;
}

/** The top camera's routine, in words. */
export function topRoutineText(top: TopState | null | undefined): string {
    const routine = top?.routine;
    if (!routine) {
        return "";
    }
    const what = routine.kind === "offset" ? "Measuring the offset" : "Finding the fiducials";
    switch (routine.state) {
        case "running":
            return `${what}: ${routine.step} (${routine.done} of ${routine.total})`;
        case "done":
            return `${what}: done.`;
        case "stopped":
            return `${what}: stopped.`;
        default:
            return `${what}: failed: ${routine.error ?? "no reason given"}`;
    }
}

/** The fiducials last found for a job, in words. */
export function fiducialText(top: TopState | null | undefined, jobId: string | null): string {
    const found = top?.fiducials;
    if (!found || jobId === null || found.job !== jobId) {
        return "";
    }
    const rms = found.found.length > 1 ? `, ${formatFixed(found.fit.rms * 1000, 0)} um rms` : "";
    return `Fiducials ${found.found.map((entry) => entry.ref).join(", ")} found: the board turned ${formatFixed(found.fit.rotation, 3)} deg${rms}.`;
}

/** The PNP page's setup when a G-code device places the parts. */
export const DEVICE_SETUP: Setup = {
    id: "pnp-device",
    label: "Place parts with a G-code device",
    steps: (state: AppState) => {
        const device = state.device;
        const jobId = state.job?.id ?? null;
        const parts = state.components !== null && state.components.job === jobId ? state.components.components.length : 0;
        return [
            { label: "Profile", done: device?.profile !== null && device?.profile !== undefined, hint: "Pick the device's profile in the G-code device panel, and set its [port] url.", panel: "pnp-device" },
            { label: "Connect", done: device?.connected === true, hint: "Press Connect in the G-code device panel.", panel: "pnp-device" },
            { label: "Home", done: device?.homed === true, hint: "Press Home so the device knows where it is.", panel: "pnp-device" },
            { label: "Board", done: parts > 0, hint: "Pick a board job uploaded as a .kicad_pcb in the Parts panel.", panel: "pnp-parts" },
            {
                label: "Reference",
                done: referencesOf(device, jobId).length > 0,
                hint: "Jog the device's nozzle (or its top camera) over a part's place, pick the part, and press Here (or Camera here); two parts give the board's turn too, and Find fiducials then refines it.",
                panel: "pnp-device",
            },
            { label: "Place", done: device?.progress?.state === "done", hint: "Plan the program, look it over, and Run it.", panel: "pnp-device" },
        ];
    },
};

export function mountDevice(root: HTMLElement, ctx: Ctx): void {
    const badge = el("span", { class: "badge device-badge" }, "no device");
    const pick = el("select", { class: "field", "aria-label": "Device profile" }) as HTMLSelectElement;
    const reload = button("Reload", () => loadList(), "btn btn-quiet btn-small");
    const listNote = el("p", { class: "muted hint" });
    const editor = codeEditor("Device profile");
    const check = button("Check", () => checkText(), "btn");
    const save = button("Save", () => saveText(), "btn btn-primary");
    const revert = button("Revert", () => showFile(), "btn btn-quiet");
    const status = el("span", { class: "muted config-status" });
    const connect = button("Connect", () => toggleConnect(), "btn btn-primary");
    const home = button("Home", () => into(ctx, "device", ctx.api.deviceHome()), "btn");
    const readPosition = button("Read position", () => into(ctx, "device", ctx.api.devicePosition()), "btn btn-quiet");
    const positionLine = el("span", { class: "muted" });
    const line = el("input", { type: "text", class: "field", placeholder: "a G-code line", "aria-label": "Device line", spellcheck: "false", autocomplete: "off" }) as HTMLInputElement;
    const send = button("Send", () => sendLine(), "btn btn-quiet");
    const here = button("Here", () => reference(), "btn");
    here.title = "The picked part's place is where the device's nozzle is now";
    const angle = numberField({ step: 0.1, placeholder: "fitted", width: "6rem" });
    angle.setAttribute("aria-label", "Board turned on the device");
    const clearRefs = button("Clear", () => clearReferences(), "btn btn-quiet");
    const refList = el("ul", { class: "device-references" });
    const planButton = button("Plan", () => planNow(), "btn");
    const download = el("a", { class: "btn btn-quiet", download: "placement.gcode" }, "Download") as HTMLAnchorElement;
    const run = button("Run", () => runNow(), "btn btn-primary");
    const stop = button("Stop", () => into(ctx, "device", ctx.api.deviceStop()), "btn btn-danger");
    const recount = button("Count feeders again", () => recountFeeders(), "btn btn-quiet");
    const runLine = el("p", { class: "muted vision-routine" });
    const planLine = el("p", { class: "muted" });
    const skipped = el("ul", { class: "device-skipped" });
    const program = el("pre", { class: "device-program" });
    const programFold = el("details", { class: "device-program-fold" }, el("summary", {}, "G-code"), program);
    const takenLine = el("p", { class: "muted" });
    const consoleBox = el("pre", { class: "device-console", "aria-label": "Device lines" });
    const cameraLine = el("p", { class: "muted" });
    const step = numberField({ value: 1, min: 0, max: 10, step: 0.5, width: "5rem" });
    step.setAttribute("aria-label", "Device centering step mm");
    const center = button("Center nozzle", () => centerNozzle(), "btn");
    center.title = "Over the up camera on this device: measures where it is and how its picture lies, for the feeders marked vision";
    const runout = button("Measure runout", () => into(ctx, "device", ctx.api.deviceRunout()), "btn");
    runout.title = "The nozzle's tip found at six turns over the up camera: how far it runs off the turning axis, made up for at every look and place";
    const routineLine = el("p", { class: "muted vision-routine" });
    // The top camera, on the head and looking down.
    const topPicture = el("img", { class: "vision-picture", alt: "The top camera's picture, with a crosshair at its center" }) as HTMLImageElement;
    const topPictureBox = el("div", { class: "vision-picture-box hidden" }, topPicture);
    const topStart = button("Start", () => startTop(), "btn btn-primary");
    topStart.title = "start the top camera on the settings shown, sending any not applied first";
    const topStop = button("Stop", () => into(ctx, "device", ctx.api.topStop()), "btn");
    const topDevice = el("input", { type: "text", class: "field", "aria-label": "Top camera device", placeholder: "/dev/video2", spellcheck: "false" }) as HTMLInputElement;
    const topSize = el("input", { type: "text", class: "field", "aria-label": "Top camera size", placeholder: "1280x720", spellcheck: "false" }) as HTMLInputElement;
    const topFps = numberField({ min: 1, max: 120, step: 1, width: "5rem" });
    topFps.setAttribute("aria-label", "Top camera fps");
    const markSpot = polaritySelect("Mark spot");
    const topPick = mountCameraPick(ctx, {
        device: topDevice,
        size: topSize,
        fps: topFps,
        otherLabel: "up camera",
        otherDevice: (state) => state.pnp?.device ?? null,
        visible: () => visible(),
    });
    const topApply = button("Apply", () => applyTop(), "btn");
    const topLine = el("p", { class: "muted" });
    const markHere = button("Nozzle on mark", () => into(ctx, "device", ctx.api.topMark()), "btn");
    markHere.title = "The nozzle's tip is over a mark the top camera can see: its place is kept for Measure offset";
    const topStep = numberField({ value: 2, min: 0, max: 20, step: 0.5, width: "5rem" });
    topStep.setAttribute("aria-label", "Top camera step mm");
    const measureOffset = button("Measure offset", () => measureTopOffset(), "btn");
    measureOffset.title = "The head goes where the camera should see the mark, measures the picture with a step along X and Y, and centers the mark: the camera's offset from the nozzle";
    const topAbort = button("Abort", () => into(ctx, "device", ctx.api.topAbort()), "btn btn-danger");
    const topRoutineLine = el("p", { class: "muted vision-routine" });
    const topLog = el("div", { class: "camlog-box" });
    mountCameraLog(topLog, ctx, "top");
    const cameraHere = button("Camera here", () => reference(true), "btn");
    cameraHere.title = "The picked part's place is under the top camera's crosshair";
    const findFiducials = button("Find fiducials", () => findFiducialsNow(), "btn");
    findFiducials.title = "The top camera finds the board's fiducials where the references put them; two or more replace the references given by hand";
    const fiducialLine = el("p", { class: "muted" });
    const fiducialsFirst = el("input", { type: "checkbox", "aria-label": "Find fiducials first" }) as HTMLInputElement;
    const runRest = button("Run the rest", () => runNow(true), "btn");
    runRest.title = "Places the parts of the last run's plan it did not place, those left out included";
    const failedList = el("ul", { class: "device-skipped device-failed" });
    let fiducialsTouched = false;
    fiducialsFirst.addEventListener("change", () => {
        fiducialsTouched = true;
    });

    root.append(
        el("div", { class: "panel-head" }, el("h2", {}, "G-code device"), badge),
        el("div", { class: "panel-body" },
            el("div", { class: "button-row" }, labeled("Profile", pick, "labeled inline"), reload),
            listNote,
            editor.root,
            el("div", { class: "button-row" }, check, save, revert, status),
            el("div", { class: "button-row" }, connect, home, readPosition, positionLine),
            el("div", { class: "button-row" }, line, send),
            el("h3", {}, "Up camera on the device"),
            cameraLine,
            el("div", { class: "button-row" }, labeled("Step mm", step, "labeled inline"), center, runout),
            routineLine,
            el("h3", {}, "Top camera on the device"),
            topPictureBox,
            el("div", { class: "button-row" }, topStart, topStop),
            topPick.row,
            topPick.note,
            el("div", { class: "field-grid" },
                labeled("Device", topDevice),
                labeled("Size", topSize),
                labeled("fps", topFps),
                labeled("Mark spot", markSpot),
            ),
            el("div", { class: "button-row" }, topApply),
            topLine,
            el("div", { class: "button-row" }, markHere, labeled("Step mm", topStep, "labeled inline"), measureOffset, topAbort),
            topRoutineLine,
            topLog,
            el("h3", {}, "Board on the device"),
            el("div", { class: "button-row" }, here, cameraHere, labeled("Turned deg", angle, "labeled inline"), clearRefs),
            refList,
            el("div", { class: "button-row" }, findFiducials),
            fiducialLine,
            el("h3", {}, "Program"),
            el("div", { class: "button-row" }, planButton, download, run, stop, runRest, recount),
            el("label", { class: "muted" }, fiducialsFirst, " find the fiducials first"),
            runLine,
            failedList,
            planLine,
            skipped,
            programFold,
            takenLine,
            consoleBox,
            el("p", { class: "muted hint" },
                "A machine whose controller takes the G-code OpenPnP's GcodeDriver sends, a line at a time with each one answered ok."
                + " The profile names its port, the words of its dialect, its heights and its feeders (strips, trays, ones told to advance);"
                + " a part is picked from the first feeder whose words its value and footprint hold, and one from a feeder marked vision is"
                + " looked at over the up camera (its picture is in the Up camera panel) turned to its angle, and placed where its center lands, its angle corrected."
                + " Measure runout makes up for a nozzle tip off true. Here pairs the picked part with where the nozzle is (Camera here, the top camera's crosshair): one reference"
                + " places the board (turned by Turned deg), two or more fit its turn too; Find fiducials (or a run with the box ticked) then fits it on its fiducials."
                + " A [vacuum] sensor in the profile is read after each pick and place; a pick that will not do is put back and the next pocket tried."
                + " Plan shows the program as planned, Run places, Stop sends the stop command at once and nothing after the line in flight."),
        ),
    );

    let picked: string | null = null;
    let dirty = false;
    let plan: DevicePlan | null = null;
    // The job the plan shown is of: the download is its program, once one planned.
    let planJob: string | null = null;
    // The angle the field was last filled with, to tell a typed one.
    let angleShown = "";

    const setDirty = (value: boolean): void => {
        dirty = value;
        setPending(ctx.store, "pnp-device", value ? 1 : 0);
    };
    const setStatus = (text: string, error: boolean): void => {
        status.textContent = text;
        status.classList.toggle("error", error);
    };
    editor.onInput((problem) => {
        setDirty(true);
        setStatus(problem ?? "edited, not saved", problem !== null);
    });

    async function loadList(): Promise<void> {
        const listing = await ctx.call(ctx.api.devices());
        if (!listing) {
            return;
        }
        const current = ctx.store.get().device?.profile ?? null;
        replace(pick,
            el("option", { value: "" }, listing.devices.length > 0 ? "pick a profile" : "no profiles in pnp/"),
            ...listing.devices.map((device) => el("option", { value: device.id }, `${device.name} (${device.id})`)),
        );
        pick.value = current ?? "";
        listNote.textContent = listing.problems.map((entry) => `${entry.id}: ${entry.problem}`).join("; ");
        if (current !== picked) {
            picked = current;
            await showFile();
        }
    }

    async function showFile(): Promise<void> {
        if (picked === null) {
            editor.setText("");
            setDirty(false);
            setStatus("", false);
            return;
        }
        const file = await ctx.call(ctx.api.deviceFile(picked));
        if (file) {
            editor.setText(file.text);
            setDirty(false);
            setStatus(`reads as ${file.document.name}, ${file.document.feeders.length} feeders`, false);
        }
    }

    pick.addEventListener("change", () => {
        void (async () => {
            const next = pick.value;
            if (next === "" || next === picked) {
                return;
            }
            if (dirty && !(await askConfirm(`Leave ${picked} without saving the edits to it?`, "Leave"))) {
                pick.value = picked ?? "";
                return;
            }
            const state = await ctx.call(ctx.api.deviceSelect({ profile: next }));
            if (!state) {
                pick.value = picked ?? "";
                return;
            }
            ctx.store.set({ device: state });
            picked = next;
            await showFile();
        })();
    });

    async function checkText(): Promise<void> {
        if (picked === null) {
            return;
        }
        const result = await ctx.call(ctx.api.checkDeviceFile(picked, editor.getText()));
        if (result) {
            setStatus(result.document ? `reads as ${result.document.name}, ${result.document.feeders.length} feeders${dirty ? "; not saved" : ""}` : result.problems.join("; "), !result.document);
        }
    }

    async function saveText(): Promise<void> {
        if (picked === null) {
            return;
        }
        const saved = await ctx.call(ctx.api.saveDeviceFile(picked, editor.getText()));
        if (saved) {
            setDirty(false);
            setStatus(`saved: ${saved.document.name}, ${saved.document.feeders.length} feeders`, false);
            plan = null;
            planJob = null;
            renderPlan();
        }
    }

    async function toggleConnect(): Promise<void> {
        const device = ctx.store.get().device;
        if (dirty && !device?.connected && !(await askConfirm("The profile has edits that are not saved; connect with the saved one?", "Connect"))) {
            return;
        }
        await into(ctx, "device", device?.connected ? ctx.api.deviceDisconnect() : ctx.api.deviceConnect());
    }

    async function sendLine(): Promise<void> {
        const text = line.value.trim();
        if (text === "") {
            return;
        }
        const answer = await ctx.call(ctx.api.deviceCommand(text));
        if (answer) {
            const { reply, ...state } = answer;
            ctx.store.set({ device: state });
            ctx.toast("info", `${text}: ${reply.join(" | ") || "ok"}`);
        }
    }
    line.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            void sendLine();
        }
    });

    async function reference(camera = false): Promise<void> {
        const state = ctx.store.get();
        if (!state.job || state.pnpPart === null) {
            ctx.toast("error", "pick a part in the Parts panel first");
            return;
        }
        await into(ctx, "device", ctx.api.deviceReference({ job: state.job.id, ref: state.pnpPart, ...(camera ? { camera: true } : {}) }));
    }

    async function findFiducialsNow(): Promise<void> {
        const job = ctx.store.get().job;
        if (!job) {
            ctx.toast("error", "pick a board job first");
            return;
        }
        await into(ctx, "device", ctx.api.deviceFiducials(job.id));
    }

    // The top camera's fields: filled from the state unless edited since.
    const topFields: [TrackedField, keyof TopSettings][] = [[topDevice, "device"], [topSize, "size"], [topFps, "fps"], [markSpot, "mark_spot"]];
    const topTracked = new Tracked(topFields.map(([field]) => field));
    function topPatch(): Partial<TopSettings> {
        const top = ctx.store.get().device?.top;
        const patch: Partial<TopSettings> = {};
        if (topDevice.value.trim() !== "" && topDevice.value.trim() !== top?.device) {
            patch.device = topDevice.value.trim();
        }
        if (topSize.value.trim() !== "" && topSize.value.trim() !== top?.size) {
            patch.size = topSize.value.trim();
        }
        const fps = parseNumber(topFps.value);
        if (fps !== null && fps !== top?.fps) {
            patch.fps = fps;
        }
        if (markSpot.value !== top?.mark_spot) {
            patch.mark_spot = markSpot.value as SpotPolarity;
        }
        return patch;
    }
    async function applyTop(): Promise<boolean> {
        const patch = topPatch();
        if (Object.keys(patch).length === 0) {
            return true;
        }
        const state = await ctx.call(ctx.api.topSettings(patch));
        if (state) {
            topTracked.reset();
            ctx.store.set({ device: state });
        }
        return state !== undefined;
    }
    async function startTop(): Promise<void> {
        if (await applyTop()) {
            await into(ctx, "device", ctx.api.topStart());
        }
    }
    async function measureTopOffset(): Promise<void> {
        const value = parseNumber(topStep.value);
        if (value === null || value < 0 || value > 20) {
            ctx.toast("error", "the step is 0 to 20 mm");
            return;
        }
        await into(ctx, "device", ctx.api.topOffset(value));
    }

    function visible(): boolean {
        return activePage() === "pnp" && ctx.store.get().pnpTarget === "device"
            && document.visibilityState !== "hidden";
    }
    const topTimer = setInterval(() => {
        if (visible() && ctx.store.get().device?.top?.running) {
            topPicture.src = ctx.api.topFrameUrl(FRAME_WIDTH, true);
        }
    }, FRAME_INTERVAL_MS);
    globalThis.addEventListener?.("pagehide", () => {
        clearInterval(topTimer);
        topPick.stop();
    });

    async function clearReferences(): Promise<void> {
        const job = ctx.store.get().job;
        if (job) {
            await into(ctx, "device", ctx.api.deviceDropReferences(job.id));
        }
    }

    angle.addEventListener("change", () => {
        const text = angle.value.trim();
        const value = parseNumber(text);
        if (text !== "" && (value === null || Math.abs(value) > 360)) {
            ctx.toast("error", "the board's turn is within 360 degrees, or blank to fit it");
            return;
        }
        void into(ctx, "device", ctx.api.deviceSelect(text === "" ? { clear_angle: true } : { angle: value! }));
    });

    async function centerNozzle(): Promise<void> {
        const value = parseNumber(step.value);
        if (value === null || value < 0 || value > 10) {
            ctx.toast("error", "the step is 0 to 10 mm");
            return;
        }
        await into(ctx, "device", ctx.api.deviceNozzle(value));
        await ctx.refreshPnp();
    }

    async function planNow(): Promise<void> {
        const job = ctx.store.get().job;
        if (!job) {
            ctx.toast("error", "pick a board job first");
            return;
        }
        const result = await ctx.call(ctx.api.devicePlan(job.id));
        if (result) {
            plan = result;
            planJob = job.id;
            renderPlan();
        }
    }

    async function runNow(rest = false): Promise<void> {
        const state = ctx.store.get();
        const job = state.job;
        if (!job) {
            ctx.toast("error", "pick a board job first");
            return;
        }
        const refs = rest ? partsLeft(state.device, plan, job.id) : undefined;
        if (rest && refs!.length === 0) {
            ctx.toast("info", "the last run placed every part of its plan");
            return;
        }
        const planned = await ctx.call(ctx.api.devicePlan(job.id, refs));
        if (!planned) {
            return;
        }
        plan = planned;
        planJob = job.id;
        renderPlan();
        const device = state.device?.profile ?? "the device";
        const left = planned.skipped.length > 0 ? ` ${planned.skipped.length} parts are left out (listed below).` : "";
        const first = fiducialsFirst.checked ? " The top camera finds the board's fiducials first." : "";
        if (!(await askConfirm(`Place ${planned.parts.length} parts with ${device}? Its head moves and its vacuum switches.${first}${left}`, "Run"))) {
            return;
        }
        const started = await ctx.call(ctx.api.deviceRun(job.id, refs, fiducialsFirst.checked));
        if (started) {
            const { parts, skipped: left2, fit, lines, text, ...rest } = started;
            plan = { parts, skipped: left2, fit, lines, text };
            renderPlan();
            ctx.store.set({ device: rest as DeviceState });
        }
    }

    async function recountFeeders(): Promise<void> {
        if (await askConfirm("Count every feeder from its first part again? Do it once they are refilled.", "Count again")) {
            await into(ctx, "device", ctx.api.deviceResetFeeders());
        }
    }

    function renderPlan(): void {
        // Only a program that planned is offered for download: a refused one
        // would save the refusal as the file.
        const job = ctx.store.get().job;
        const ready = plan !== null && planJob !== null && job?.id === planJob;
        download.href = ready ? ctx.api.deviceProgramUrl(planJob!) : "";
        download.classList.toggle("disabled", !ready);
        planLine.textContent = plan ? planText(plan) : "";
        replace(skipped, ...(plan?.skipped ?? []).map((entry) => el("li", {}, `${entry.ref}: ${entry.reason}`)));
        program.textContent = plan?.text ?? "";
        programFold.classList.toggle("hidden", plan === null);
    }

    function render(state: AppState): void {
        const device = state.device;
        // A profile picked elsewhere (another page, the backend's memory) is shown here.
        if (device && device.profile !== picked && !dirty) {
            picked = device.profile;
            pick.value = picked ?? "";
            void showFile();
        }
        badge.textContent = deviceBadge(device);
        badge.setAttribute("data-device", deviceBadge(device));
        const connected = device?.connected === true;
        const running = device?.running === true;
        connect.textContent = connected ? "Disconnect" : "Connect";
        connect.classList.toggle("btn-primary", !connected);
        setLocked(connect, picked === null || running);
        const routine = state.pnp?.routine;
        const moving = routine?.state === "running" && routine.target === "device";
        const topRunning = device?.top?.routine?.state === "running";
        for (const control of [home, readPosition, send, here]) {
            setLocked(control, !connected || running || moving || topRunning);
        }
        const top = device?.top ?? null;
        const topBusy = top?.routine?.state === "running";
        setLocked(center, !connected || running || moving || topBusy || state.pnp?.running !== true);
        setLocked(runout, !connected || running || moving || topBusy || state.pnp?.running !== true || !(device?.camera.mm_per_px && device.camera.position));
        cameraLine.textContent = deviceCameraText(device);
        routineLine.textContent = routine?.target === "device" ? pnpRoutineText(state.pnp) : "";
        // The top camera.
        for (const [field, key] of topFields) {
            topTracked.follow(field, top ? String(top[key] ?? "") : "");
        }
        topPictureBox.classList.toggle("hidden", top?.running !== true);
        setLocked(topStart, top?.running === true || topBusy);
        setLocked(topStop, top?.running !== true || topBusy);
        setLocked(topApply, topBusy);
        setLocked(markHere, !connected || running || moving || topBusy);
        setLocked(measureOffset, !connected || running || moving || topBusy || top?.running !== true || !top?.mark_at);
        setLocked(topAbort, !topBusy);
        topLine.textContent = topCameraText(top);
        topRoutineLine.textContent = topRoutineText(top);
        const measured = top?.offset !== null && top?.offset !== undefined && (top?.mm_per_px ?? 0) > 0;
        setLocked(cameraHere, !connected || running || moving || topBusy || !measured);
        setLocked(findFiducials, !connected || running || moving || topBusy || top?.running !== true || !measured || !state.job);
        fiducialLine.textContent = fiducialText(top, state.job?.id ?? null);
        const hasFiducials = state.components?.job === state.job?.id && (state.components?.components ?? []).some((part) => part.fiducial);
        // Ticked once it can be, unless the operator has had a say.
        if (!measured || !hasFiducials) {
            fiducialsFirst.checked = false;
        } else if (!fiducialsTouched) {
            fiducialsFirst.checked = true;
        }
        fiducialsFirst.disabled = !measured || !hasFiducials;
        setLocked(runRest, !connected || running || partsLeft(device, plan, state.job?.id ?? null).length === 0);
        replace(failedList, ...(device?.progress?.job === state.job?.id ? device?.progress?.failed ?? [] : []).map((entry) => el("li", {}, `${entry.ref} left out: ${entry.reason}`)));
        setLocked(planButton, !state.job || picked === null);
        setLocked(run, !connected || running || !state.job);
        setLocked(stop, !running);
        setLocked(clearRefs, referencesOf(device, state.job?.id ?? null).length === 0);
        const position = device?.position;
        positionLine.textContent = position
            ? `X ${formatFixed(position.x, 3)} Y ${formatFixed(position.y, 3)}${position.z !== undefined ? ` Z ${formatFixed(position.z, 3)}` : ""}${device?.homed ? "" : " (not homed)"}`
            : device?.homed ? "homed" : "";
        const job = state.job;
        replace(refList, ...referencesOf(device, job?.id ?? null).map((entry) =>
            el("li", {}, `${entry.ref} at X ${formatFixed(entry.at[0], 3)} Y ${formatFixed(entry.at[1], 3)}${entry.by && entry.by !== "nozzle" ? ` (${entry.by})` : ""} `,
                button("Drop", () => job ? into(ctx, "device", ctx.api.deviceDropReferences(job.id, entry.ref)) : Promise.resolve(), "btn btn-quiet btn-small")),
        ));
        here.textContent = state.pnpPart ? `Here: ${state.pnpPart}` : "Here";
        const angleText = device?.angle === null || device?.angle === undefined ? "" : String(device.angle);
        if (angle !== document.activeElement && (angle.value === angleShown || angleShown === "")) {
            angle.value = angleText;
        }
        angleShown = angleText;
        if (planJob !== null && job?.id !== planJob) {
            // Another job: its plan is not the one shown.
            plan = null;
            planJob = null;
            renderPlan();
        }
        runLine.textContent = device?.lost ? `The link was lost: ${device.lost}` : deviceRunText(device);
        const taken = Object.entries(device?.taken ?? {});
        takenLine.textContent = taken.length > 0 ? `Picked so far: ${taken.map(([feeder, count]) => `${feeder} ${count}`).join(", ")}` : "";
        consoleBox.textContent = (device?.log ?? []).map((entry) => `${entry.dir === "tx" ? ">" : entry.dir === "rx" ? "<" : "#"} ${entry.text}`).join("\n");
        consoleBox.scrollTop = consoleBox.scrollHeight;
    }

    ctx.store.subscribe((state) => render(state), ["device", "job", "pnpPart", "components", "pnp"]);
    render(ctx.store.get());
    renderPlan();
    void loadList();
}
