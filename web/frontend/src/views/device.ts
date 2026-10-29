// The PNP page's G-code device: a pick and place machine of its own whose
// controller takes the G-code OpenPnP's GcodeDriver sends (Marlin,
// Smoothieware, RepRapFirmware, Grbl). Its profile (pnp/*.toml: the port,
// the dialect, the heights and the feeders) is edited here with the TOML
// editor the machine files use; the board is placed on the device from
// reference parts read off it; a placement program is planned, shown,
// downloaded or sent a line at a time; and the last lines either way show
// below.

import { askConfirm } from "../confirm.ts";
import { button, el, labeled, numberField, replace, setLocked } from "../dom.ts";
import { formatFixed, parseNumber } from "../format.ts";
import { setPending, type AppState } from "../state.ts";
import type { DevicePlan, DeviceReference, DeviceState } from "../types.ts";
import type { Ctx } from "./context.ts";
import { codeEditor } from "./editor.ts";
import { pnpRoutineText } from "./pnp.ts";
import type { Setup } from "./steps.ts";

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
    const where = `${run.sent} of ${run.total} lines, ${run.placed.length} parts placed`;
    switch (run.state) {
        case "running":
            return `Sending: ${where}${run.part ? `, now ${run.part}` : ""}, ${formatFixed(run.seconds, 0)} s`;
        case "done":
            return `Done: ${where} in ${formatFixed(run.seconds, 0)} s.`;
        case "stopped":
            return `Stopped: ${where}.`;
        default:
            return `Failed: ${where}: ${run.error ?? "no reason given"}`;
    }
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
    return `Up camera at X ${formatFixed(camera.position[0], 3)} Y ${formatFixed(camera.position[1], 3)}${sharp}, `
        + `${formatFixed(camera.mm_per_px * 1000, 1)} um per pixel, roll ${formatFixed(camera.roll, 2)} deg${camera.mirror ? ", mirrored" : ""}.`;
}

/** The PNP page's setup when a G-code device places the parts. */
export const DEVICE_SETUP: Setup = {
    id: "pnp-device",
    label: "Place parts with a G-code device",
    fits: () => true,
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
                hint: "Jog the device's nozzle over a part's place, pick the part, and press Here; two parts give the board's turn too.",
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
    const home = button("Home", () => ctx.call(ctx.api.deviceHome()).then(take), "btn");
    const readPosition = button("Read position", () => ctx.call(ctx.api.devicePosition()).then(take), "btn btn-quiet");
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
    const stop = button("Stop", () => ctx.call(ctx.api.deviceStop()).then(take), "btn btn-danger");
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
    const routineLine = el("p", { class: "muted vision-routine" });

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
            el("div", { class: "button-row" }, labeled("Step mm", step, "labeled inline"), center),
            routineLine,
            el("h3", {}, "Board on the device"),
            el("div", { class: "button-row" }, here, labeled("Turned deg", angle, "labeled inline"), clearRefs),
            refList,
            el("h3", {}, "Program"),
            el("div", { class: "button-row" }, planButton, download, run, stop, recount),
            runLine,
            planLine,
            skipped,
            programFold,
            takenLine,
            consoleBox,
            el("p", { class: "muted hint" },
                "A machine whose controller takes the G-code OpenPnP's GcodeDriver sends, a line at a time with each one answered ok."
                + " The profile names its port, the words of its dialect, its heights and its feeders (strips, trays, ones told to advance);"
                + " a part is picked from the first feeder whose words its value and footprint hold, and one from a feeder marked vision is"
                + " looked at over the up camera (its picture is in the Up camera panel) and placed where its center lands. Here pairs the picked part with where the nozzle is: one reference"
                + " places the board (turned by Turned deg), two or more fit its turn too. Plan shows the program, Run sends it, Stop"
                + " sends the stop command at once and nothing after the line in flight."),
        ),
    );

    let picked: string | null = null;
    let dirty = false;
    let plan: DevicePlan | null = null;
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

    function take(state: DeviceState | undefined): void {
        if (state) {
            ctx.store.set({ device: state });
        }
    }

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
            take(state);
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
            renderPlan();
        }
    }

    async function toggleConnect(): Promise<void> {
        const device = ctx.store.get().device;
        if (dirty && !device?.connected && !(await askConfirm("The profile has edits that are not saved; connect with the saved one?", "Connect"))) {
            return;
        }
        take(await ctx.call(device?.connected ? ctx.api.deviceDisconnect() : ctx.api.deviceConnect()));
    }

    async function sendLine(): Promise<void> {
        const text = line.value.trim();
        if (text === "") {
            return;
        }
        const answer = await ctx.call(ctx.api.deviceCommand(text));
        if (answer) {
            const { reply, ...state } = answer;
            take(state);
            ctx.toast("info", `${text}: ${reply.join(" | ") || "ok"}`);
        }
    }
    line.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            void sendLine();
        }
    });

    async function reference(): Promise<void> {
        const state = ctx.store.get();
        if (!state.job || state.pnpPart === null) {
            ctx.toast("error", "pick a part in the Parts panel first");
            return;
        }
        take(await ctx.call(ctx.api.deviceReference({ job: state.job.id, ref: state.pnpPart })));
    }

    async function clearReferences(): Promise<void> {
        const job = ctx.store.get().job;
        if (job) {
            take(await ctx.call(ctx.api.deviceDropReferences(job.id)));
        }
    }

    angle.addEventListener("change", () => {
        const text = angle.value.trim();
        const value = parseNumber(text);
        if (text !== "" && (value === null || Math.abs(value) > 360)) {
            ctx.toast("error", "the board's turn is within 360 degrees, or blank to fit it");
            return;
        }
        void ctx.call(ctx.api.deviceSelect(text === "" ? { clear_angle: true } : { angle: value! })).then(take);
    });

    async function centerNozzle(): Promise<void> {
        const value = parseNumber(step.value);
        if (value === null || value < 0 || value > 10) {
            ctx.toast("error", "the step is 0 to 10 mm");
            return;
        }
        take(await ctx.call(ctx.api.deviceNozzle(value)));
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
            renderPlan();
        }
    }

    async function runNow(): Promise<void> {
        const state = ctx.store.get();
        const job = state.job;
        if (!job) {
            ctx.toast("error", "pick a board job first");
            return;
        }
        const planned = await ctx.call(ctx.api.devicePlan(job.id));
        if (!planned) {
            return;
        }
        plan = planned;
        renderPlan();
        const device = state.device?.profile ?? "the device";
        const left = planned.skipped.length > 0 ? ` ${planned.skipped.length} parts are left out (listed below).` : "";
        if (!(await askConfirm(`Place ${planned.parts.length} parts with ${device}? Its head moves and its vacuum switches.${left}`, "Run"))) {
            return;
        }
        const started = await ctx.call(ctx.api.deviceRun(job.id));
        if (started) {
            const { parts, skipped: left2, fit, lines, text, ...rest } = started;
            plan = { parts, skipped: left2, fit, lines, text };
            renderPlan();
            take(rest as DeviceState);
        }
    }

    async function recountFeeders(): Promise<void> {
        if (await askConfirm("Count every feeder from its first part again? Do it once they are refilled.", "Count again")) {
            take(await ctx.call(ctx.api.deviceResetFeeders()));
        }
    }

    function renderPlan(): void {
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
        for (const control of [home, readPosition, send, here]) {
            setLocked(control, !connected || running || moving);
        }
        setLocked(center, !connected || running || moving || state.pnp?.running !== true);
        cameraLine.textContent = deviceCameraText(device);
        routineLine.textContent = routine?.target === "device" ? pnpRoutineText(state.pnp) : "";
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
            el("li", {}, `${entry.ref} at X ${formatFixed(entry.at[0], 3)} Y ${formatFixed(entry.at[1], 3)} `,
                button("Drop", () => job ? ctx.call(ctx.api.deviceDropReferences(job.id, entry.ref)).then(take) : Promise.resolve(), "btn btn-quiet btn-small")),
        ));
        here.textContent = state.pnpPart ? `Here: ${state.pnpPart}` : "Here";
        const angleText = device?.angle === null || device?.angle === undefined ? "" : String(device.angle);
        if (angle !== document.activeElement && (angle.value === angleShown || angleShown === "")) {
            angle.value = angleText;
        }
        angleShown = angleText;
        download.href = job && picked !== null ? ctx.api.deviceProgramUrl(job.id) : "";
        download.classList.toggle("disabled", !job || picked === null);
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
