// What the PNP page shows of a G-code machine, the one connected from the
// top bar whose machine file says controller = "gcode" (a pick and place
// machine's own Marlin, Smoothieware, RepRapFirmware or Grbl): the words
// the panels share (the references of a job, a run, the cameras, the
// fiducials), the setup steps, and the Head panel: the cameras' lights,
// the vacuum switched and its sensor read, the head parked, put over the
// up camera, or swapped between the nozzle and the top camera, and the
// file's heights, feeds and vacuum ranges tuned a value at a time. Its
// connection, jog, readout and console are every machine's: the top bar,
// the Jog panel and the Console.

import { button, el, labeled, lockFor, numberField } from "../dom.ts";
import { formatFixed, parseNumber } from "../format.ts";
import { isGcode } from "../profile.ts";
import type { AppState } from "../state.ts";
import type { CamPath, CamValue, GcodeDocument, PlacingPlan, PlacingState, PnpReference, TopState } from "../types.ts";
import { into, type Ctx } from "./context.ts";
import { infoTip } from "./infotip.ts";
import type { Setup } from "./steps.ts";

/**
 * The PNP page works with a G-code machine: the machine connected is one,
 * or, with nothing connected, there is one to place with (the one last
 * connected, or the only G-code machine file).
 */
export function gcodePlacing(state: AppState): boolean {
    if (state.snapshot.connected) {
        return isGcode(state.snapshot);
    }
    return (state.placing?.machine ?? null) !== null;
}

/** The references of one job. */
export function referencesOf(placing: PlacingState | null, jobId: string | null): PnpReference[] {
    return jobId === null ? [] : (placing?.references ?? []).filter((entry) => entry.job === jobId);
}

/** What the head panel's badge says of the G-code machine placed with. */
export function placingBadge(placing: PlacingState | null): string {
    if (!placing || placing.machine === null) {
        return "no G-code machine";
    }
    if (placing.running) {
        return "placing";
    }
    if (placing.lost) {
        return "lost";
    }
    return placing.connected ? "connected" : "not connected";
}

/** One line on a placing run under way, or how the last one ended. */
export function placingRunText(placing: PlacingState | null): string {
    const run = placing?.progress;
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
export function partsLeft(placing: PlacingState | null, plan: PlacingPlan | null, jobId: string | null): string[] {
    const run = placing?.progress;
    if (!run || !plan || jobId === null || run.job !== jobId || run.state === "running") {
        return [];
    }
    const placed = new Set(run.placed);
    return plan.parts.map((part) => part.ref).filter((ref) => !placed.has(ref));
}

/** The plan in words: what it places, and what it leaves and why. */
export function planText(plan: PlacingPlan): string {
    const fit = plan.fit.marks > 1 ? `, board turned ${formatFixed(plan.fit.rotation, 2)} deg (rms ${formatFixed(plan.fit.rms, 3)} mm)` : "";
    const looked = plan.parts.filter((part) => part.vision).length;
    return `${plan.parts.length} parts in ${plan.lines} lines${fit}${looked > 0 ? `, ${looked} checked on the bottom camera` : ""}.`;
}

/** Where the up camera sits on the G-code machine, in words. */
export function upCameraText(placing: PlacingState | null): string {
    const camera = placing?.camera;
    if (!camera?.position) {
        return "Bottom camera place not known: put the nozzle over it and press Camera is here, or type it.";
    }
    const where = `Bottom camera at X ${formatFixed(camera.position[0], 3)} Y ${formatFixed(camera.position[1], 3)}${camera.measured === false ? " (the machine file's)" : ""}`;
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

/** The PNP page's setup when a G-code machine places the parts. */
export const PLACING_SETUP: Setup = {
    id: "pnp-gcode",
    label: "Place parts with a G-code machine",
    steps: (state: AppState) => {
        const placing = state.placing;
        const jobId = state.job?.id ?? null;
        const parts = state.components !== null && state.components.job === jobId ? state.components.components.length : 0;
        return [
            {
                label: "Connect",
                done: placing?.connected === true,
                hint: "Pick the machine's port in the top bar (it is named after its machine file) and press Connect.",
                panel: "status",
            },
            { label: "Home", done: placing?.homed === true, hint: "Press Home in the Jog panel.", panel: "pnp-jog" },
            { label: "Board", done: parts > 0, hint: "Pick or upload a board (.kicad_pcb) in the Parts panel.", panel: "pnp-parts" },
            {
                label: "Reference",
                done: referencesOf(placing, jobId).length > 0,
                hint: "Pick a part, put the nozzle or the top camera over it, and press Nozzle here or Camera here.",
                panel: "pnp-refs",
            },
            { label: "Place", done: placing?.progress?.state === "done", hint: "Press Plan, check it, then Run.", panel: "pnp-run" },
        ];
    },
};

/** The file's values the head panel tunes, each by its table and key. */
interface Tunable {
    label: string;
    path: CamPath;
    unit: string;
    tip: string;
    read: (doc: GcodeDocument) => number | null;
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

/** The Head panel in `root`: lights, vacuum, the head's places, and the file's values tuned. */
export function mountHead(root: HTMLElement, ctx: Ctx): void {
    const badge = el("span", { class: "badge device-badge" }, "no G-code machine");
    const nameLine = el("p", { class: "muted" });
    const light = button("Light", () => toggleLight(), "btn btn-quiet btn-toggle");
    light.title = "switch the cameras' lights (the file's light_on and light_off lines)";
    const park = button("Park", () => into(ctx, "placing", ctx.api.pnpPark()), "btn btn-quiet");
    park.title = "the head to the file's park place, across at the safe height";
    const overCamera = button("Nozzle over camera", () => into(ctx, "placing", ctx.api.pnpOverCamera()), "btn");
    overCamera.title = "the nozzle over the bottom camera, turned to 0, at the height it is sharp at: across at the safe height, the height last";
    const toNozzle = button("Nozzle to camera spot", () => into(ctx, "placing", ctx.api.pnpSwap("nozzle")), "btn");
    toNozzle.title = "the nozzle over the point the top camera looks at";
    const toCamera = button("Camera to nozzle spot", () => into(ctx, "placing", ctx.api.pnpSwap("camera")), "btn");
    toCamera.title = "the top camera over the point the nozzle is over";
    // The vacuum, switched by hand and read, to find the sensor's ranges.
    const vacuumOn = button("Vacuum on", () => vacuum({ on: true }), "btn btn-quiet", "suck: the file's pick lines");
    const vacuumOff = button("Vacuum off", () => vacuum({ on: false }), "btn btn-quiet", "let go: the file's place lines");
    const vacuumRead = button("Read vacuum", () => vacuum({ read: true }), "btn btn-quiet");
    vacuumRead.title = "read the vacuum sensor: with the nozzle open, then blocked, to set the ranges";
    const vacuumLine = el("span", { class: "muted mono" });
    // The file's values, a value at a time.
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
        el("summary", {}, "Tune the machine file"),
        el("div", { class: "field-grid" }, ...tuneFields.map(({ tunable, field }) => labeled(`${tunable.label} ${tunable.unit}`, field))),
        el("div", { class: "button-row" }, el("span", { class: "muted" }, "What the heights mean"), infoTip("heights")),
        el("div", { class: "field-grid" }, ...rangeFields.map(({ range, low, high }) => {
            const group = el("div", { class: "button-row", title: range.tip }, low, high);
            return labeled(`Vacuum ${range.label.toLowerCase()}`, group);
        })),
        tuneNote,
    );

    root.append(
        el("div", { class: "panel-head" }, el("h2", {}, "Head"), badge),
        el("div", { class: "panel-body" },
            nameLine,
            el("div", { class: "button-row" }, light, park, overCamera),
            el("div", { class: "button-row" }, toNozzle, toCamera),
            el("div", { class: "button-row" }, vacuumOn, vacuumOff, vacuumRead, vacuumLine),
            tuneFold,
        ),
    );

    async function toggleLight(): Promise<void> {
        await into(ctx, "placing", ctx.api.pnpLight(ctx.store.get().placing?.light !== true));
    }

    async function vacuum(request: { on?: boolean; read?: boolean }): Promise<void> {
        const answer = await ctx.call(ctx.api.pnpVacuum(request));
        if (answer) {
            const { reply: _reply, ...state } = answer;
            ctx.store.set({ placing: state });
        }
    }

    async function patch(path: CamPath, value: CamValue): Promise<boolean> {
        const id = ctx.store.get().placing?.machine;
        if (!id) {
            return false;
        }
        const file = await ctx.call(ctx.api.patchMachineFile(id, path, value));
        if (file) {
            tuneNote.textContent = `${path.join(".")} saved in ${id}.toml`;
            await ctx.refreshPlacing();
        }
        return file !== undefined;
    }

    async function tune(path: CamPath, field: HTMLInputElement, read: Tunable["read"]): Promise<void> {
        const value = parseNumber(field.value);
        const doc = ctx.store.get().placing?.document ?? null;
        if (value === null) {
            ctx.toast("error", `${path[path.length - 1]}: a number`);
            field.value = doc ? String(read(doc) ?? "") : "";
            return;
        }
        const whole = path[1] === "pick_dwell_ms" || path[1] === "place_dwell_ms";
        if (!(await patch(path, whole ? Math.round(value) : value)) && doc) {
            field.value = String(read(doc) ?? "");
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
        if (!ctx.store.get().placing?.document?.vacuum) {
            ctx.toast("error", "the machine file has no [vacuum] read lines: add them on the Config page first");
            return;
        }
        await patch(["vacuum", key], [Math.min(a, b), Math.max(a, b)]);
    }

    function renderTune(state: AppState): void {
        const doc = state.placing?.document ?? null;
        for (const { tunable, field } of tuneFields) {
            if (field !== document.activeElement) {
                const value = doc ? tunable.read(doc) : null;
                field.value = value === null ? "" : String(value);
            }
            field.disabled = doc === null;
        }
        for (const { range, low, high } of rangeFields) {
            const span = doc?.vacuum?.[range.key] ?? null;
            if (low !== document.activeElement && high !== document.activeElement) {
                low.value = span ? String(span[0]) : "";
                high.value = span ? String(span[1]) : "";
            }
            low.disabled = high.disabled = !doc?.vacuum;
        }
    }

    function render(state: AppState): void {
        const placing = state.placing;
        const doc = placing?.document ?? null;
        badge.textContent = placingBadge(placing);
        badge.setAttribute("data-device", placingBadge(placing));
        nameLine.textContent = placing?.machine
            ? `${placing.name ?? placing.machine} (machines/${placing.machine}.toml)${placing.connected ? "" : ": connect it from the top bar"}`
            : 'No G-code machine: add a machine file with controller = "gcode" on the Config page, or import one from OpenPnP.';
        const connected = placing?.connected === true;
        const running = placing?.running === true;
        const routine = state.pnp?.routine;
        const moving = routine?.state === "running" && routine.target === "gcode";
        const topBusy = placing?.top?.routine?.state === "running";
        const idle = connected && !running && !moving && !topBusy;
        for (const control of [vacuumOn, vacuumOff, overCamera]) {
            lockFor(control, [!connected, "connect the machine first"], [!idle, "the machine is busy"]);
        }
        lockFor(park, [!connected, "connect the machine first"], [!idle, "the machine is busy"], [!doc?.park, "the machine file has no [motion] park place"]);
        const offsetKnown = (placing?.top?.offset ?? null) !== null || (doc?.top?.offset ?? null) !== null;
        for (const control of [toNozzle, toCamera]) {
            lockFor(control, [!connected, "connect the machine first"], [!idle, "the machine is busy"], [!offsetKnown, "the top camera's offset is not known"]);
        }
        lockFor(vacuumRead, [!connected, "connect the machine first"], [!idle, "the machine is busy"], [!doc?.vacuum, "the machine file has no [vacuum] read lines"]);
        lockFor(light, [!connected, "connect the machine first"], [!idle, "the machine is busy"], [doc?.light !== true, "the machine file has no light_on lines"]);
        light.setAttribute("aria-pressed", placing?.light === true ? "true" : "false");
        const reading = placing?.vacuum?.reading;
        vacuumLine.textContent = [
            placing?.vacuum?.on === true ? "vacuum on" : placing?.vacuum?.on === false ? "vacuum off" : "",
            reading !== null && reading !== undefined ? `reads ${formatFixed(reading, 2)}` : "",
        ].filter((word) => word).join(", ");
        renderTune(state);
    }

    ctx.store.subscribe((state) => render(state), ["placing", "snapshot", "pnp"]);
    render(ctx.store.get());
}
