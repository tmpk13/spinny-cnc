// The PNP page's G-code device: a pick and place machine of its own whose
// controller takes the G-code OpenPnP's GcodeDriver sends (Marlin,
// Smoothieware, RepRapFirmware, Grbl). This panel picks its profile (the
// files in pnp/, edited whole on the Config page) and its port (from the
// ports found, the same list the top bar has, a G-code controller found
// by its USB name, or typed), asks the firmware what it is, connects,
// homes, switches the lights and the vacuum and reads the vacuum sensor,
// tunes the profile's heights, feeds and vacuum ranges a value at a time,
// and shows the lines going out and coming back. The board's place on the
// device, the run and the cameras have panels of their own.

import { button, el, labeled, lockFor, numberField, onEnter, replace, setLocked } from "../dom.ts";
import { formatFixed, parseNumber } from "../format.ts";
import type { AppState } from "../state.ts";
import type { CamPath, CamValue, DevicePlan, DeviceReference, DeviceState, Port, TopState } from "../types.ts";
import { into, type Ctx } from "./context.ts";
import { infoTip } from "./infotip.ts";
import { gcodePort } from "../ports.ts";
import { portLabel } from "./statusbar.ts";
import type { Setup } from "./steps.ts";
import { goToPanel } from "./steps.ts";

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
    const fit = plan.fit.marks > 1 ? `, board turned ${formatFixed(plan.fit.rotation, 2)} deg (rms ${formatFixed(plan.fit.rms, 3)} mm)` : "";
    const looked = plan.parts.filter((part) => part.vision).length;
    return `${plan.parts.length} parts in ${plan.lines} lines${fit}${looked > 0 ? `, ${looked} checked on the up camera` : ""}.`;
}

/** Where the up camera sits on the device, in words. */
export function deviceCameraText(device: DeviceState | null): string {
    const camera = device?.camera;
    if (!camera?.position) {
        return "Up camera place not known: put the nozzle over it and press Camera is here, or type it.";
    }
    const where = `Up camera at X ${formatFixed(camera.position[0], 3)} Y ${formatFixed(camera.position[1], 3)}${camera.measured === false ? " (the profile's)" : ""}`;
    const sharp = camera.height !== null ? `, nozzle sharp at Z ${formatFixed(camera.height, 3)}` : "";
    if (!(camera.mm_per_px > 0)) {
        return `${where}${sharp}; scale not measured: Center nozzle.`;
    }
    const runout = camera.runout
        ? ` Runout ${formatFixed(Math.hypot(camera.runout[0], camera.runout[1]) * 1000, 0)} um (tip off by X ${formatFixed(camera.runout[0], 3)} Y ${formatFixed(camera.runout[1], 3)} at 0 deg).`
        : " Runout not measured.";
    return `${where}${sharp}, ${formatFixed(camera.mm_per_px * 1000, 1)} um/px, roll ${formatFixed(camera.roll, 2)} deg${camera.mirror ? ", mirrored" : ""}.${runout}`;
}

/** Where the top camera looks from the nozzle, in words. */
export function topCameraText(top: TopState | null | undefined): string {
    if (!top?.offset || !(top.mm_per_px > 0)) {
        return top?.mark_at
            ? `Mark kept at X ${formatFixed(top.mark_at[0], 3)} Y ${formatFixed(top.mark_at[1], 3)}: now press Measure offset.`
            : "Top camera offset not measured: put the nozzle tip on a mark, press Nozzle on mark, then Measure offset.";
    }
    return `Top camera looks from X ${formatFixed(top.offset[0], 3)} Y ${formatFixed(top.offset[1], 3)} off the nozzle, `
        + `${formatFixed(top.mm_per_px * 1000, 1)} um/px, roll ${formatFixed(top.roll, 2)} deg${top.mirror ? ", mirrored" : ""}.`;
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
    return `Fiducials ${found.found.map((entry) => entry.ref).join(", ")} found: board turned ${formatFixed(found.fit.rotation, 3)} deg${rms}.`;
}

/** The ports a device can be put on: every one but this machine's own, the G-code controllers first. */
export function devicePorts(ports: Port[], own: string | null): Port[] {
    const usable = ports.filter((port) => port.url !== own && port.device !== own && !port.spinny);
    return [...usable.filter((port) => gcodePort(port)), ...usable.filter((port) => !gcodePort(port))];
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
            { label: "Profile", done: device?.profile !== null && device?.profile !== undefined, hint: "Pick a profile and a port in the G-code device panel.", panel: "pnp-device" },
            { label: "Connect", done: device?.connected === true, hint: "Press Connect in the G-code device panel.", panel: "pnp-device" },
            { label: "Home", done: device?.homed === true, hint: "Press Home in the G-code device panel.", panel: "pnp-device" },
            { label: "Board", done: parts > 0, hint: "Pick or upload a board (.kicad_pcb) in the Parts panel.", panel: "pnp-parts" },
            {
                label: "Reference",
                done: referencesOf(device, jobId).length > 0,
                hint: "Pick a part, put the nozzle or the top camera over it, and press Nozzle here or Camera here.",
                panel: "pnp-refs",
            },
            { label: "Place", done: device?.progress?.state === "done", hint: "Press Plan, check it, then Run.", panel: "pnp-run" },
        ];
    },
};

/** The profile's values the panel tunes, each by its table and key. */
interface Tunable {
    label: string;
    path: CamPath;
    unit: string;
    tip: string;
    read: (doc: NonNullable<AppState["deviceDoc"]>["document"]) => number | null;
}

const TUNABLES: Tunable[] = [
    { label: "Safe Z", path: ["motion", "safe_z"], unit: "mm", tip: "the height every move across goes at", read: (doc) => doc.safe_z },
    { label: "Place Z", path: ["motion", "place_z"], unit: "mm", tip: "the tip with a part on it at the board's top", read: (doc) => doc.place_z },
    { label: "Feed XY", path: ["motion", "feed_xy"], unit: "mm/min", tip: "the speed across", read: (doc) => doc.feed_xy },
    { label: "Feed Z", path: ["motion", "feed_z"], unit: "mm/min", tip: "the speed up and down", read: (doc) => doc.feed_z },
    { label: "Pick dwell", path: ["motion", "pick_dwell_ms"], unit: "ms", tip: "the wait with the vacuum on before rising", read: (doc) => doc.pick_dwell_ms },
    { label: "Place dwell", path: ["motion", "place_dwell_ms"], unit: "ms", tip: "the wait with the vacuum off before rising", read: (doc) => doc.place_dwell_ms },
];

/** The vacuum's ranges the panel tunes: with a part held, and empty. */
const RANGES: { label: string; key: "part_on" | "part_off"; tip: string }[] = [
    { label: "Part held", key: "part_on", tip: "the readings with a part on the nozzle; blank checks nothing" },
    { label: "Empty", key: "part_off", tip: "the readings with the nozzle open; blank checks nothing" },
];

/** Loads the picked profile's text and document into the store once the pick changes. */
export async function loadDeviceDoc(ctx: Ctx, force = false): Promise<void> {
    const id = ctx.store.get().device?.profile ?? null;
    if (id === null) {
        ctx.store.set({ deviceDoc: null });
        return;
    }
    if (!force && ctx.store.get().deviceDoc?.id === id) {
        return;
    }
    const file = await ctx.call(ctx.api.deviceFile(id));
    if (file && ctx.store.get().device?.profile === id) {
        ctx.store.set({ deviceDoc: { id, ...file } });
    }
}

export function mountDevice(root: HTMLElement, ctx: Ctx): void {
    const badge = el("span", { class: "badge device-badge" }, "no device");
    const pick = el("select", { class: "field", "aria-label": "Device profile" }) as HTMLSelectElement;
    const edit = button("Edit", () => goToPanel("device-file"), "btn btn-quiet btn-small");
    edit.title = "edit the whole profile on the Config page";
    const listNote = el("p", { class: "muted hint" });
    // The port: picked from the ports found, or typed.
    const portPick = el("select", { class: "field", "aria-label": "Device port" }) as HTMLSelectElement;
    const portField = el("input", { type: "text", class: "field url", placeholder: "/dev/ttyACM1 or socket://host:port", "aria-label": "Device port url", spellcheck: "false", autocomplete: "off" }) as HTMLInputElement;
    const detect = button("Detect", () => detectPorts(), "btn btn-quiet btn-small");
    detect.title = "list the serial ports again and pick the G-code controller among them";
    const identify = button("Identify", () => identifyPort(), "btn btn-quiet btn-small");
    identify.title = "ask the firmware on the port what it is (M115); nothing moves";
    const portNote = el("p", { class: "muted hint device-port-note" });
    const connect = button("Connect", () => toggleConnect(), "btn btn-primary");
    const home = button("Home", () => into(ctx, "device", ctx.api.deviceHome()), "btn");
    home.title = "home the device's axes (the profile's home command)";
    const light = button("Light", () => toggleLight(), "btn btn-quiet btn-toggle");
    light.title = "switch the cameras' lights";
    const readPosition = button("Read position", () => into(ctx, "device", ctx.api.devicePosition()), "btn btn-quiet");
    const positionLine = el("p", { class: "muted mono" });
    // The vacuum, switched by hand and read, to find the sensor's ranges.
    const vacuumOn = button("Vacuum on", () => vacuum({ on: true }), "btn btn-quiet");
    const vacuumOff = button("Vacuum off", () => vacuum({ on: false }), "btn btn-quiet");
    const vacuumRead = button("Read vacuum", () => vacuum({ read: true }), "btn btn-quiet");
    vacuumRead.title = "read the vacuum sensor: with the nozzle open, then blocked, to set the ranges";
    const vacuumLine = el("span", { class: "muted mono" });
    // The profile's values, a value at a time.
    const tuneFields = TUNABLES.map((tunable) => {
        const field = numberField({ width: "6rem" });
        field.setAttribute("aria-label", tunable.label);
        field.title = tunable.tip;
        field.addEventListener("change", () => void tune(tunable.path, field, tunable.read));
        return { tunable, field };
    });
    const rangeFields = RANGES.map((range) => {
        const low = numberField({ width: "5rem", placeholder: "low" });
        const high = numberField({ width: "5rem", placeholder: "high" });
        low.setAttribute("aria-label", `${range.label} low`);
        high.setAttribute("aria-label", `${range.label} high`);
        const save = (): void => void tuneRange(range.key, low, high);
        low.addEventListener("change", save);
        high.addEventListener("change", save);
        return { range, low, high };
    });
    const tuneNote = el("p", { class: "muted hint" });
    const tuneFold = el("details", { class: "device-tune stack" },
        el("summary", {}, "Tune the profile"),
        el("div", { class: "field-grid" }, ...tuneFields.map(({ tunable, field }) => labeled(`${tunable.label} ${tunable.unit}`, field))),
        el("div", { class: "button-row" }, el("span", { class: "muted" }, "What the heights mean"), infoTip("heights")),
        el("div", { class: "field-grid" }, ...rangeFields.map(({ range, low, high }) => {
            const group = el("div", { class: "button-row", title: range.tip }, low, high);
            return labeled(`Vacuum ${range.label.toLowerCase()}`, group);
        })),
        tuneNote,
    );
    const line = el("input", { type: "text", class: "field", placeholder: "a G-code line", "aria-label": "Device line", spellcheck: "false", autocomplete: "off" }) as HTMLInputElement;
    const send = button("Send", () => sendLine(), "btn btn-quiet");
    const consoleBox = el("pre", { class: "device-console", "aria-label": "Device lines" });

    root.append(
        el("div", { class: "panel-head" }, el("h2", {}, "G-code device"), badge),
        el("div", { class: "panel-body" },
            el("div", { class: "button-row" }, labeled("Profile", pick, "labeled inline"), edit),
            listNote,
            el("div", { class: "button-row" }, labeled("Port", portPick, "labeled inline"), detect, identify),
            el("div", { class: "button-row" }, portField),
            portNote,
            el("div", { class: "button-row" }, connect, home, light, readPosition),
            positionLine,
            el("div", { class: "button-row" }, vacuumOn, vacuumOff, vacuumRead, vacuumLine),
            tuneFold,
            el("div", { class: "button-row" }, line, send),
            consoleBox,
        ),
    );

    let picked: string | null = null;

    async function loadList(): Promise<void> {
        const listing = await ctx.call(ctx.api.devices());
        if (!listing) {
            return;
        }
        const current = ctx.store.get().device?.profile ?? null;
        replace(pick,
            el("option", { value: "" }, listing.devices.length > 0 ? "pick a profile" : "no profiles in pnp/"),
            ...listing.devices.map((device) => el("option", { value: device.id }, device.name)),
        );
        pick.value = current ?? "";
        listNote.textContent = listing.problems.map((entry) => `${entry.id}: ${entry.problem}`).join("; ");
        listNote.classList.toggle("hidden", listing.problems.length === 0);
    }

    pick.addEventListener("change", () => {
        void (async () => {
            const next = pick.value;
            if (next === "" || next === picked) {
                return;
            }
            const state = await ctx.call(ctx.api.deviceSelect({ profile: next }));
            if (!state) {
                pick.value = picked ?? "";
                return;
            }
            ctx.store.set({ device: state });
            await loadDeviceDoc(ctx);
        })();
    });

    /** The port the device talks on: the one picked, else the profile's. */
    function portOf(state: AppState): string {
        return state.device?.port ?? state.deviceDoc?.document.url ?? "";
    }

    async function setPort(url: string): Promise<void> {
        await into(ctx, "device", ctx.api.deviceSelect({ url }));
    }

    portPick.addEventListener("change", () => {
        portField.value = portPick.value;
        void setPort(portPick.value);
    });
    portField.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            void setPort(portField.value.trim());
        }
    });

    async function detectPorts(): Promise<void> {
        await ctx.refreshPorts();
        const state = ctx.store.get();
        const found = devicePorts(state.ports, state.snapshot.connected ? state.snapshot.url : null).filter((port) => gcodePort(port));
        if (found.length === 0) {
            ctx.toast("info", "no G-code controller among the ports: pick or type one");
            return;
        }
        if (found.length === 1 && portOf(state) !== found[0]!.url && !state.device?.connected) {
            await setPort(found[0]!.url);
            const port = found[0]!;
            ctx.toast("info", `picked ${port.device ?? port.url}${port.product || port.description ? `: ${port.product || port.description}` : ""}`);
            return;
        }
        ctx.toast("info", `${found.length} G-code controller${found.length === 1 ? "" : "s"} found: pick one`);
    }

    async function identifyPort(): Promise<void> {
        const url = portField.value.trim() || portOf(ctx.store.get());
        if (url === "") {
            ctx.toast("error", "pick or type a port first");
            return;
        }
        const answer = await ctx.call(ctx.api.deviceIdentify(url));
        if (answer) {
            const port = ctx.store.get().ports.find((entry) => entry.url === url);
            const where = port?.device && port.device !== url ? port.device : url;
            portNote.textContent = answer.firmware || answer.machine
                ? `${where}: ${[answer.firmware, answer.machine].filter((word) => word).join(", ")}`
                : `${where}: ${answer.lines.length > 0 ? answer.lines.slice(0, 3).join(" | ") : "no answer to M115"}`;
        }
    }

    async function toggleConnect(): Promise<void> {
        const device = ctx.store.get().device;
        await into(ctx, "device", device?.connected ? ctx.api.deviceDisconnect() : ctx.api.deviceConnect());
    }

    async function toggleLight(): Promise<void> {
        await into(ctx, "device", ctx.api.deviceLight(ctx.store.get().device?.light !== true));
    }

    async function vacuum(request: { on?: boolean; read?: boolean }): Promise<void> {
        const answer = await ctx.call(ctx.api.deviceVacuum(request));
        if (answer) {
            const { reply: _reply, ...state } = answer;
            ctx.store.set({ device: state });
        }
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
    line.addEventListener("keydown", onEnter(send));

    async function patch(path: CamPath, value: CamValue): Promise<boolean> {
        const id = ctx.store.get().device?.profile;
        if (!id) {
            return false;
        }
        const file = await ctx.call(ctx.api.patchDeviceFile(id, path, value));
        if (file) {
            ctx.store.set({ deviceDoc: { id, ...file } });
            tuneNote.textContent = `${path.join(".")} saved`;
        }
        return file !== undefined;
    }

    async function tune(path: CamPath, field: HTMLInputElement, read: Tunable["read"]): Promise<void> {
        const value = parseNumber(field.value);
        const doc = ctx.store.get().deviceDoc;
        if (value === null) {
            ctx.toast("error", `${path[path.length - 1]}: a number`);
            field.value = doc ? String(read(doc.document) ?? "") : "";
            return;
        }
        const whole = path[1] === "pick_dwell_ms" || path[1] === "place_dwell_ms";
        if (!(await patch(path, whole ? Math.round(value) : value)) && doc) {
            field.value = String(read(doc.document) ?? "");
        }
    }

    async function tuneRange(key: "part_on" | "part_off", low: HTMLInputElement, high: HTMLInputElement): Promise<void> {
        const a = parseNumber(low.value);
        const b = parseNumber(high.value);
        if (low.value.trim() === "" && high.value.trim() === "") {
            await patch(["vacuum", key], null);
            return;
        }
        if (a === null || b === null) {
            return;
        }
        if (ctx.store.get().deviceDoc?.document.vacuum === null) {
            ctx.toast("error", "the profile has no [vacuum] read lines: add them on the Config page first");
            return;
        }
        await patch(["vacuum", key], [Math.min(a, b), Math.max(a, b)]);
    }

    // What the port select was last drawn from.
    let portsKey = "";
    function renderPorts(state: AppState): void {
        const own = state.snapshot.connected ? state.snapshot.url : null;
        const ports = devicePorts(state.ports, own);
        const current = portOf(state);
        const key = JSON.stringify([ports.map((port) => port.url), current, state.device?.port ?? null, state.deviceDoc?.document.url ?? null]);
        if (key === portsKey) {
            return;
        }
        portsKey = key;
        const profileUrl = state.deviceDoc?.document.url ?? "";
        const options = [
            el("option", { value: "" }, profileUrl ? `the profile's: ${profileUrl}` : "pick a port"),
            ...ports.map((port) => el("option", { value: port.url }, `${portLabel(port)}${gcodePort(port) ? "  (G-code)" : ""}`)),
        ];
        const picked = state.device?.port ?? null;
        if (picked !== null && !ports.some((port) => port.url === picked)) {
            options.push(el("option", { value: picked }, `${picked} (not found now)`));
        }
        replace(portPick, ...options);
        portPick.value = picked ?? "";
        if (portField !== document.activeElement) {
            portField.value = current;
        }
    }

    function renderTune(state: AppState): void {
        const doc = state.deviceDoc;
        for (const { tunable, field } of tuneFields) {
            if (field !== document.activeElement) {
                const value = doc ? tunable.read(doc.document) : null;
                field.value = value === null ? "" : String(value);
            }
            field.disabled = doc === null;
        }
        for (const { range, low, high } of rangeFields) {
            const span = doc?.document.vacuum?.[range.key] ?? null;
            if (low !== document.activeElement && high !== document.activeElement) {
                low.value = span ? String(span[0]) : "";
                high.value = span ? String(span[1]) : "";
            }
            low.disabled = high.disabled = !doc?.document.vacuum;
        }
    }

    // The console follows the newest line only while it is scrolled to the
    // bottom: scrolled up to read, it stays where it was.
    let consoleText = "";
    function renderConsole(device: DeviceState | null): void {
        const text = (device?.log ?? []).map((entry) => `${entry.dir === "tx" ? ">" : entry.dir === "rx" ? "<" : "#"} ${entry.text}`).join("\n");
        if (text === consoleText) {
            return;
        }
        const atBottom = consoleBox.scrollHeight - consoleBox.scrollTop - consoleBox.clientHeight < 8;
        consoleText = text;
        consoleBox.textContent = text;
        if (atBottom) {
            consoleBox.scrollTop = consoleBox.scrollHeight;
        }
    }

    function render(state: AppState): void {
        const device = state.device;
        if (device && device.profile !== picked) {
            picked = device.profile;
            pick.value = picked ?? "";
            void loadDeviceDoc(ctx);
        }
        badge.textContent = deviceBadge(device);
        badge.setAttribute("data-device", deviceBadge(device));
        const connected = device?.connected === true;
        const running = device?.running === true;
        connect.textContent = connected ? "Disconnect" : "Connect";
        connect.classList.toggle("btn-primary", !connected);
        lockFor(connect, [picked === null, "pick a profile first"], [running, "a run is under way"]);
        const routine = state.pnp?.routine;
        const moving = routine?.state === "running" && routine.target === "device";
        const topBusy = device?.top?.routine?.state === "running";
        const idle = connected && !running && !moving && !topBusy;
        for (const control of [home, readPosition, send, vacuumOn, vacuumOff]) {
            lockFor(control, [!connected, "connect the device first"], [!idle, "the device is busy"]);
        }
        lockFor(vacuumRead, [!connected, "connect the device first"], [!idle, "the device is busy"], [!state.deviceDoc?.document.vacuum, "the profile has no [vacuum] read lines"]);
        lockFor(light, [!connected, "connect the device first"], [!idle, "the device is busy"], [state.deviceDoc?.document.light !== true, "the profile has no light_on lines"]);
        light.setAttribute("aria-pressed", device?.light === true ? "true" : "false");
        portPick.disabled = connected;
        portField.disabled = connected;
        setLocked(detect, connected, "disconnect first to pick another port");
        setLocked(identify, running || moving || topBusy, "the device is busy");
        const position = device?.position;
        positionLine.textContent = position
            ? `X ${formatFixed(position.x ?? 0, 3)} Y ${formatFixed(position.y ?? 0, 3)}${position.z !== undefined ? ` Z ${formatFixed(position.z, 3)}` : ""}${position.rotation !== undefined ? ` A ${formatFixed(position.rotation, 2)}` : ""}${device?.homed ? "" : " (not homed)"}`
            : device?.homed ? "homed" : "";
        const reading = device?.vacuum?.reading;
        vacuumLine.textContent = [
            device?.vacuum?.on === true ? "vacuum on" : device?.vacuum?.on === false ? "vacuum off" : "",
            reading !== null && reading !== undefined ? `reads ${formatFixed(reading, 2)}` : "",
        ].filter((word) => word).join(", ");
        renderPorts(state);
        renderTune(state);
        renderConsole(device);
    }

    ctx.store.subscribe((state) => render(state), ["device", "deviceDoc", "ports", "snapshot", "pnp"]);
    render(ctx.store.get());
    void loadList();
}
