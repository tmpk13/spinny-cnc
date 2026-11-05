// The PNP page: the parts of the selected board job in a list and on a
// drawing of the board, the up camera's picture with its settings (its
// device picked from the cameras found attached, or typed), and the
// nozzle: where it sits over the up camera (measured by centering it),
// where a part sits on it, and a goto that takes it over a part's place.
// Its own setup steps lead through all of it.

import { button, el, labeled, numberField, replace, setLocked, activePage } from "../dom.ts";
import { formatFixed, parseNumber } from "../format.ts";
import { isCartesian } from "../profile.ts";
import { setPending, type AppState } from "../state.ts";
import type { Component, Job, PnpSettings, PnpState, SpotPolarity } from "../types.ts";
import { mountCameraPick } from "./camerapick.ts";
import { mountCameraLog } from "./camlog.ts";
import type { Ctx } from "./context.ts";
import { DEVICE_SETUP, mountDevice } from "./device.ts";
import { connectStep, mountSteps, type Setup } from "./steps.ts";

const TARGET_KEY = "spinny.pnp.target";

/** Which machine places the parts, as remembered in this browser: this one unless a G-code device was picked. */
export function readTarget(): "machine" | "device" {
    try {
        return globalThis.localStorage?.getItem(TARGET_KEY) === "device" ? "device" : "machine";
    } catch {
        return "machine";
    }
}

/** How often the picture is asked for while it shows, ms, and the width it is asked at. */
export const PNP_FRAME_MS = 250;
export const PNP_FRAME_WIDTH = 640;
const POLL_MS = 500;

/** The parts that match a filter (ref, value or footprint, any case) on a side. */
export function filterParts(parts: Component[], text: string, side: "all" | "front" | "back"): Component[] {
    const words = text.trim().toLowerCase().split(/\s+/).filter((word) => word !== "");
    return parts.filter((part) => {
        if (side !== "all" && part.side !== side) {
            return false;
        }
        const hay = `${part.ref} ${part.value} ${part.footprint}`.toLowerCase();
        return words.every((word) => hay.includes(word));
    });
}

/** A footprint's name without its library. */
export function footprintName(footprint: string): string {
    const at = footprint.indexOf(":");
    return at >= 0 ? footprint.slice(at + 1) : footprint;
}

/** The up camera's place on the board: its joints turned by the table's angle, as a cartesian machine's board frame is. */
export function cameraOnBoard(position: [number, number] | null, angle: number): { x: number; y: number } | null {
    if (position === null) {
        return null;
    }
    const radians = (angle * Math.PI) / 180;
    const [r, z] = position;
    return { x: r * Math.cos(radians) - z * Math.sin(radians), y: r * Math.sin(radians) + z * Math.cos(radians) };
}

export interface Box {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

/** The box the board drawing shows: the outline, the pads, the parts and the markers given, with a margin; null for nothing. */
export function drawingBox(job: Job | null, parts: Component[], marks: { x: number; y: number }[], margin = 3): Box | null {
    let box: Box | null = null;
    const take = (x: number, y: number): void => {
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return;
        }
        box = box === null ? { x0: x, y0: y, x1: x, y1: y } : { x0: Math.min(box.x0, x), y0: Math.min(box.y0, y), x1: Math.max(box.x1, x), y1: Math.max(box.y1, y) };
    };
    for (const path of job?.outline ?? []) {
        for (const [x, y] of path) {
            take(x, y);
        }
    }
    for (const [x, y] of job?.pads ?? []) {
        take(x, y);
    }
    for (const part of parts) {
        take(part.x, part.y);
    }
    for (const mark of marks) {
        take(mark.x, mark.y);
    }
    const found = box as Box | null;
    return found === null ? null : { x0: found.x0 - margin, y0: found.y0 - margin, x1: found.x1 + margin, y1: found.y1 + margin };
}

const SVG_NS = "http://www.w3.org/2000/svg";

function svg(tag: string, attrs: Record<string, string | number>, ...children: (SVGElement | string)[]): SVGElement {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) {
        node.setAttribute(name, String(value));
    }
    for (const child of children) {
        node.append(child);
    }
    return node;
}

export interface BoardScene {
    job: Job | null;
    parts: Component[];
    selected: string | null;
    camera: { x: number; y: number } | null;
}

/**
 * The board drawing: outline, pads, every part as a dot with its reference,
 * and the up camera; y up. The head is drawn into it by `placeHead`, which
 * follows the machine without drawing the board again.
 */
export function boardSvg(scene: BoardScene, onPick: (ref: string) => void): { root: SVGElement; box: Box } | null {
    const box = drawingBox(scene.job, scene.parts, scene.camera ? [scene.camera] : []);
    if (box === null) {
        return null;
    }
    const width = box.x1 - box.x0;
    const height = box.y1 - box.y0;
    const size = Math.max(width, height);
    const sx = (x: number): string => (x - box.x0).toFixed(3);
    const sy = (y: number): string => (box.y1 - y).toFixed(3);
    const root = svg("svg", { class: "pnp-board", viewBox: `0 0 ${width.toFixed(3)} ${height.toFixed(3)}`, role: "img", "aria-label": "The board with its parts" });
    for (const path of scene.job?.outline ?? []) {
        root.append(svg("polyline", { class: "pnp-outline", points: path.map(([x, y]) => `${sx(x)},${sy(y)}`).join(" ") }));
    }
    for (const [x, y, area] of scene.job?.pads ?? []) {
        const side = Math.sqrt(Math.max(area, 0.01));
        root.append(svg("rect", { class: "pnp-pad", x: sx(x - side / 2), y: sy(y + side / 2), width: side.toFixed(3), height: side.toFixed(3) }));
    }
    const dot = size / 140;
    const text = size / 45;
    for (const part of scene.parts) {
        const chosen = part.ref === scene.selected;
        const group = svg("g", { class: `pnp-part${chosen ? " selected" : ""}${part.side === "back" ? " back" : ""}${part.dnp ? " dnp" : ""}`, "data-ref": part.ref },
            svg("circle", { cx: sx(part.x), cy: sy(part.y), r: (chosen ? dot * 2 : dot).toFixed(3) }),
            svg("text", { x: sx(part.x), y: (box.y1 - part.y - dot * 2.2).toFixed(3), "font-size": text.toFixed(3) }, part.ref),
        );
        group.addEventListener("click", () => onPick(part.ref));
        root.append(group);
    }
    if (scene.camera) {
        root.append(crossMark(scene.camera, box, "pnp-camera-mark", "up camera"));
    }
    return { root, box };
}

/** A cross with a ring and a label at a board point, sized to the drawing. */
function crossMark(at: { x: number; y: number }, box: Box, kind: string, label: string): SVGElement {
    const size = Math.max(box.x1 - box.x0, box.y1 - box.y0);
    const arm = (size / 140) * 4;
    const sx = (x: number): string => (x - box.x0).toFixed(3);
    const sy = (y: number): string => (box.y1 - y).toFixed(3);
    return svg("g", { class: kind },
        svg("line", { x1: sx(at.x - arm), y1: sy(at.y), x2: sx(at.x + arm), y2: sy(at.y) }),
        svg("line", { x1: sx(at.x), y1: sy(at.y - arm), x2: sx(at.x), y2: sy(at.y + arm) }),
        svg("circle", { cx: sx(at.x), cy: sy(at.y), r: (arm * 0.6).toFixed(3) }),
        svg("text", { x: sx(at.x + arm), y: sy(at.y + arm), "font-size": (size / 45).toFixed(3) }, label),
    );
}

/** The head's cross in a board drawing, moved to `head` or taken out for null or a head past the drawing's edge. */
export function placeHead(root: SVGElement, box: Box, head: { x: number; y: number } | null): void {
    root.querySelector(".pnp-head")?.remove();
    if (head === null || head.x < box.x0 || head.x > box.x1 || head.y < box.y0 || head.y > box.y1) {
        return;
    }
    root.append(crossMark(head, box, "pnp-head", "head"));
}

/** One line on the routine: which, where it is, and how it ended. */
export function pnpRoutineText(state: PnpState | null): string {
    const routine = state?.routine;
    if (!routine) {
        return "";
    }
    const what = routine.kind === "nozzle" ? "Centering the nozzle" : "Looking at the part";
    if (routine.state === "running") {
        const spot = routine.spot ? `, nozzle ${formatFixed(routine.spot.mm, 3)} mm off center` : "";
        return `${what}: ${routine.step} (${routine.done} of ${routine.total})${spot}`;
    }
    if (routine.state === "done") {
        return routine.kind === "nozzle" ? "Nozzle centered: the position, scale, roll and mirror below are measured." : "Part looked at: its offset is below.";
    }
    return `${what} ${routine.state}${routine.error && routine.error !== "stopped" ? `: ${routine.error}` : ""}`;
}

/** Where the part on the nozzle sits, and how big it looked. */
export function partOffsetText(state: PnpState | null): string {
    const part = state?.part_offset;
    if (!part) {
        return "No part looked at yet: pick one, then Look at part.";
    }
    return `The part sits X ${formatFixed(part.dx, 3)} Y ${formatFixed(part.dy, 3)} mm from the nozzle's center (${formatFixed(part.mm, 3)} mm),`
        + ` and looks ${formatFixed(part.length, 2)} by ${formatFixed(part.width, 2)} mm.`;
}

/** The PNP setup: an X/Y machine, the up camera, the nozzle over it, a board job with parts, and a part looked at. */
export const PNP_SETUP: Setup = {
    id: "pnp",
    label: "Place parts",
    fits: () => true,
    steps: (state: AppState) => {
        const pnp = state.pnp;
        const parts = state.components !== null && state.components.job === state.job?.id ? state.components.components.length : 0;
        return [
            connectStep(state),
            {
                label: "X/Y machine",
                done: state.snapshot.connected && isCartesian(state.snapshot),
                hint: "The up camera needs an X/Y machine: load one from the Config page ($cartesian=1).",
                panel: "machine-file",
            },
            { label: "Up camera on", done: pnp?.running === true, hint: "In the Up camera panel pick the camera (Detect lists the ones attached) or type its device, then press Start.", panel: "pnp-camera" },
            {
                label: "Nozzle centered",
                done: pnp?.position !== null && pnp?.position !== undefined && (pnp?.mm_per_px ?? 0) > 0,
                hint: "Jog the nozzle over the up camera so it shows in the picture, then press Center nozzle: it measures where the camera is.",
                panel: "pnp-nozzle",
            },
            { label: "Board", done: parts > 0, hint: "Pick a board job uploaded as a .kicad_pcb in the Parts panel: its footprints are the parts.", panel: "pnp-parts" },
            {
                label: "Part on nozzle",
                done: pnp?.part_offset !== null && pnp?.part_offset !== undefined,
                hint: "With a part on the nozzle, press Look at part: the up camera measures where it sits against the nozzle.",
                panel: "pnp-nozzle",
            },
        ];
    },
};

type Field = HTMLInputElement | HTMLSelectElement;

/** Fields that follow the state until typed in, counted while they hold an edit. */
class Tracked {
    private shown = new Map<Field, string>();

    constructor(readonly fields: Field[], onChange: () => void) {
        for (const field of fields) {
            field.addEventListener("input", onChange);
            field.addEventListener("change", onChange);
        }
    }

    follow(field: Field, value: string): void {
        const untouched = !this.shown.has(field) || field.value === this.shown.get(field);
        if (untouched && field !== document.activeElement) {
            field.value = value;
        }
        this.shown.set(field, value);
    }

    /** Marks the fields typed in; how many there are. */
    edited(): number {
        let count = 0;
        for (const field of this.fields) {
            const edited = this.shown.has(field) && field.value !== this.shown.get(field);
            field.closest(".labeled")?.classList.toggle("edited", edited);
            count += edited ? 1 : 0;
        }
        return count;
    }

    changed(field: Field): boolean {
        return this.shown.has(field) && field.value !== this.shown.get(field);
    }
}

function polaritySelect(label: string): HTMLSelectElement {
    return el("select", { class: "field", "aria-label": label }, el("option", { value: "dark" }, "dark"), el("option", { value: "bright" }, "bright")) as HTMLSelectElement;
}

export interface PnpRoots {
    steps: HTMLElement;
    parts: HTMLElement;
    board: HTMLElement;
    camera: HTMLElement;
    nozzle: HTMLElement;
    /** The G-code device's panel; left out, the page has none. */
    device?: HTMLElement;
}

export function mountPnp(roots: PnpRoots, ctx: Ctx): void {
    let selected: string | null = null;
    // The job the parts were asked for, so a reply for another is dropped.
    // The job, and where it lay, the parts were asked for: a reply for
    // another is dropped, and a job moved, turned or aligned is asked again.
    let asked: string | null = null;

    // The steps follow the machine the parts are placed with.
    mountSteps(roots.steps, ctx, [PNP_SETUP, DEVICE_SETUP], "spinny.steps.pnp", (state) => [state.pnpTarget === "device" ? DEVICE_SETUP : PNP_SETUP]);
    if (roots.device) {
        mountDevice(roots.device, ctx);
    }
    const target = el("select", { class: "field", "aria-label": "Place with" },
        el("option", { value: "machine" }, "this machine"),
        el("option", { value: "device" }, "a G-code device (OpenPnP compatible)"),
    ) as HTMLSelectElement;
    target.addEventListener("change", () => {
        const value = target.value === "device" ? "device" : "machine";
        try {
            globalThis.localStorage?.setItem(TARGET_KEY, value);
        } catch {
            // Not remembered; the pick holds for this page.
        }
        ctx.store.set({ pnpTarget: value });
    });
    ctx.store.set({ pnpTarget: readTarget() });

    // --- the parts ---
    const jobPick = el("select", { class: "field", "aria-label": "Board job" }) as HTMLSelectElement;
    const filter = el("input", { type: "search", class: "field", placeholder: "ref, value or footprint", "aria-label": "Filter parts" }) as HTMLInputElement;
    const sidePick = el("select", { class: "field", "aria-label": "Side" },
        el("option", { value: "all" }, "both sides"), el("option", { value: "front" }, "front"), el("option", { value: "back" }, "back")) as HTMLSelectElement;
    const partsNote = el("p", { class: "muted hint" });
    const table = el("table", { class: "pnp-parts" });
    const correct = el("input", { type: "checkbox", "aria-label": "Correct by the part on the nozzle" }) as HTMLInputElement;
    const correctLabel = el("label", { class: "muted" }, correct, " part center over the place");
    const gotoButton = button("Go to part", () => gotoPart(), "btn btn-primary");
    const chosenLine = el("p", { class: "muted pnp-chosen" });
    roots.parts.append(
        el("div", { class: "panel-head" }, el("h2", {}, "Parts")),
        el("fieldset", { class: "panel-body" },
            el("div", { class: "button-row" }, labeled("Place with", target, "labeled inline")),
            el("div", { class: "button-row" }, labeled("Job", jobPick, "labeled inline"), sidePick),
            el("div", { class: "button-row" }, filter),
            el("div", { class: "button-row" }, gotoButton, correctLabel),
            chosenLine,
            partsNote,
            el("div", { class: "pnp-parts-box" }, table),
        ),
    );
    jobPick.addEventListener("change", () => void ctx.selectJob(jobPick.value === "" ? null : jobPick.value));
    filter.addEventListener("input", () => renderParts(ctx.store.get()));
    sidePick.addEventListener("change", () => renderParts(ctx.store.get()));

    // --- the board ---
    const drawing = el("div", { class: "pnp-drawing" });
    roots.board.append(el("div", { class: "panel-head" }, el("h2", {}, "Board")), el("div", { class: "panel-body" }, drawing,
        el("p", { class: "muted hint" }, "Every part is a dot at its footprint's place, hollow on the back; a press picks one. The cross is the head, the ring the up camera.")));

    // --- the up camera ---
    const picture = el("img", { class: "vision-picture", alt: "The up camera's picture, with a crosshair at its center" }) as HTMLImageElement;
    const pictureBox = el("div", { class: "vision-picture-box hidden" }, picture);
    const startButton = button("Start", () => startCamera(), "btn btn-primary");
    startButton.title = "start the up camera on the settings shown, sending any not applied first";
    const stopButton = button("Stop", () => act(ctx.api.pnpStop()), "btn");
    let overlayOn = true;
    const overlayButton = button("Overlay", () => {
        overlayOn = !overlayOn;
        overlayButton.setAttribute("aria-pressed", overlayOn ? "true" : "false");
        refreshFrame(true);
    }, "btn btn-quiet btn-small btn-toggle");
    overlayButton.setAttribute("aria-pressed", "true");
    const cameraBadge = el("span", { class: "badge" }, "stopped");
    const device = el("input", { type: "text", class: "field", "aria-label": "Up camera device", spellcheck: "false" }) as HTMLInputElement;
    const size = el("input", { type: "text", class: "field", "aria-label": "Up camera size", placeholder: "1280x720", spellcheck: "false" }) as HTMLInputElement;
    const fps = numberField({ min: 1, max: 120, step: 1, width: "5rem" });
    fps.setAttribute("aria-label", "Up camera fps");
    const nozzleSpot = polaritySelect("Nozzle spot");
    const partSpot = polaritySelect("Part spot");
    const cameraPick = mountCameraPick(ctx, {
        device,
        size,
        fps,
        otherLabel: "head camera",
        otherDevice: (state) => state.camera?.device ?? null,
        visible: () => visible(),
    });
    const cameraApply = button("Apply", () => applySettings(), "btn");
    // The pictures the nozzle and part routines looked at, and photos by hand.
    const upLog = el("div", { class: "camlog-box" });
    mountCameraLog(upLog, ctx, "up");
    const cameraChip = el("span", { class: "badge apply-state hidden", "data-apply": "pending" });
    roots.camera.append(
        el("div", { class: "panel-head" }, el("h2", {}, "Up camera"), cameraBadge),
        el("fieldset", { class: "panel-body" },
            pictureBox,
            el("div", { class: "button-row" }, startButton, stopButton, overlayButton),
            cameraPick.row,
            cameraPick.note,
            el("div", { class: "field-grid" },
                labeled("Device", device),
                labeled("Size", size),
                labeled("fps", fps),
                labeled("Nozzle spot", nozzleSpot),
                labeled("Part spot", partSpot),
            ),
            el("div", { class: "button-row" }, cameraApply, cameraChip),
            el("p", { class: "muted hint" }, "A camera fixed to the machine, looking up at what the head holds over it. The spots are what the finder takes for the nozzle (its bore) and for a part on it: dark or bright against what is around them."),
            upLog,
        ),
    );

    // --- the nozzle ---
    const posR = numberField({ step: 0.01, width: "6rem" });
    posR.setAttribute("aria-label", "Up camera position R");
    const posZ = numberField({ step: 0.01, width: "6rem" });
    posZ.setAttribute("aria-label", "Up camera position Z");
    const height = numberField({ step: 0.1, width: "6rem", placeholder: "travel" });
    height.setAttribute("aria-label", "Nozzle height H");
    const scale = numberField({ min: 0, step: 0.001, width: "6rem" });
    scale.setAttribute("aria-label", "Up camera mm per px");
    const roll = numberField({ step: 0.01, width: "6rem" });
    roll.setAttribute("aria-label", "Up camera roll");
    const mirror = el("input", { type: "checkbox", "aria-label": "Up camera mirrored" }) as HTMLInputElement;
    const nozzleApply = button("Apply", () => applyMeasured(), "btn");
    const nozzleChip = el("span", { class: "badge apply-state hidden", "data-apply": "pending" });
    const forget = button("Forget position", () => act(ctx.api.pnpSettings({ clear: ["position"] })), "btn btn-quiet");
    const step = numberField({ value: 1, min: 0, max: 10, step: 0.5, width: "5rem" });
    step.setAttribute("aria-label", "Centering step mm");
    const centerButton = button("Center nozzle", () => centerNozzle(), "btn btn-primary");
    const partButton = button("Look at part", () => act(ctx.api.pnpPart()), "btn");
    const abortButton = button("Abort", () => act(ctx.api.pnpAbort()), "btn btn-danger");
    const routineLine = el("p", { class: "muted vision-routine" });
    const partLine = el("p", { class: "muted" });
    roots.nozzle.append(
        el("div", { class: "panel-head" }, el("h2", {}, "Nozzle")),
        el("fieldset", { class: "panel-body" },
            el("div", { class: "field-grid" },
                labeled("Camera at R mm", posR),
                labeled("Camera at Z mm", posZ),
                labeled("Sharp at H mm", height),
                labeled("mm per px", scale),
                labeled("Roll deg", roll),
                el("label", { class: "labeled" }, el("span", { class: "labeled-text" }, "Mirrored"), mirror),
            ),
            el("div", { class: "button-row" }, nozzleApply, nozzleChip, forget),
            el("div", { class: "button-row" }, labeled("Step mm", step, "labeled inline"), centerButton, partButton, abortButton),
            routineLine,
            partLine,
            el("p", { class: "muted hint" },
                "Center nozzle rises to the travel height, goes over the up camera (once its place is known), comes down to the H the nozzle is sharp at,"
                + " moves the step along X and along Y to measure how the picture scales, turns and mirrors, and centers the nozzle in the picture:"
                + " the head's R and Z there are the camera's place. Step 0 keeps the scale measured before. Look at part reads where a part on the"
                + " nozzle sits against the nozzle's center; Go to part with the box ticked puts that center over the place instead of the nozzle's."),
        ),
    );

    const cameraFields = new Tracked([device, size, fps, nozzleSpot, partSpot], () => showPending());
    const measuredFields = new Tracked([posR, posZ, height, scale, roll], () => showPending());
    let mirrorShown: boolean | null = null;
    mirror.addEventListener("change", () => showPending());

    function showPending(): void {
        const camera = cameraFields.edited();
        const mirrorEdited = mirrorShown !== null && mirror.checked !== mirrorShown;
        mirror.closest(".labeled")?.classList.toggle("edited", mirrorEdited);
        const measured = measuredFields.edited() + (mirrorEdited ? 1 : 0);
        for (const [chip, count] of [[cameraChip, camera], [nozzleChip, measured]] as const) {
            chip.classList.toggle("hidden", count === 0);
            chip.textContent = `${count} not applied`;
            chip.title = "the marked fields are typed in and not sent: Apply sends them";
        }
        cameraApply.classList.toggle("btn-primary", camera > 0);
        nozzleApply.classList.toggle("btn-primary", measured > 0);
        setPending(ctx.store, "pnp", camera + measured);
    }

    async function act(promise: Promise<PnpState>): Promise<void> {
        const state = await ctx.call(promise);
        if (state) {
            ctx.store.set({ pnp: state });
        }
    }

    /** The camera fields typed in or picked and not applied. */
    function cameraPatch(): Partial<PnpSettings> {
        const patch: Partial<PnpSettings> = {};
        if (cameraFields.changed(device) && device.value.trim() !== "") {
            patch.device = device.value.trim();
        }
        if (cameraFields.changed(size) && size.value.trim() !== "") {
            patch.size = size.value.trim();
        }
        const frames = parseNumber(fps.value);
        if (cameraFields.changed(fps) && frames !== null) {
            patch.fps = frames;
        }
        if (cameraFields.changed(nozzleSpot)) {
            patch.nozzle_spot = nozzleSpot.value as SpotPolarity;
        }
        if (cameraFields.changed(partSpot)) {
            patch.part_spot = partSpot.value as SpotPolarity;
        }
        return patch;
    }

    async function applySettings(): Promise<void> {
        const patch = cameraPatch();
        if (Object.keys(patch).length === 0) {
            ctx.toast("info", "nothing changed");
            return;
        }
        await act(ctx.api.pnpSettings(patch));
    }

    /** Starts the up camera on what the fields show: settings picked or typed and not applied go first. */
    async function startCamera(): Promise<void> {
        const patch = cameraPatch();
        if (Object.keys(patch).length > 0) {
            const state = await ctx.call(ctx.api.pnpSettings(patch));
            if (!state) {
                return;
            }
            ctx.store.set({ pnp: state });
        }
        await act(ctx.api.pnpStart());
    }

    async function applyMeasured(): Promise<void> {
        const patch: Partial<PnpSettings> & { clear?: ("position" | "height")[] } = {};
        const r = parseNumber(posR.value);
        const z = parseNumber(posZ.value);
        if ((measuredFields.changed(posR) || measuredFields.changed(posZ)) && r !== null && z !== null) {
            patch.position = [r, z];
        }
        if (measuredFields.changed(height)) {
            const value = parseNumber(height.value);
            if (height.value.trim() === "") {
                patch.clear = ["height"];
            } else if (value !== null) {
                patch.height = value;
            }
        }
        const mm = parseNumber(scale.value);
        if (measuredFields.changed(scale) && mm !== null) {
            patch.mm_per_px = mm;
        }
        const turn = parseNumber(roll.value);
        if (measuredFields.changed(roll) && turn !== null) {
            patch.roll = turn;
        }
        if (mirrorShown !== null && mirror.checked !== mirrorShown) {
            patch.mirror = mirror.checked;
        }
        if (Object.keys(patch).length === 0) {
            ctx.toast("info", "nothing changed");
            return;
        }
        await act(ctx.api.pnpSettings(patch));
    }

    async function centerNozzle(): Promise<void> {
        const value = parseNumber(step.value);
        if (value === null || value < 0 || value > 10) {
            ctx.toast("error", "the step is 0 to 10 mm");
            return;
        }
        await act(ctx.api.pnpNozzle(value));
    }

    async function gotoPart(): Promise<void> {
        const state = ctx.store.get();
        const job = state.job;
        if (!job || selected === null) {
            ctx.toast("error", "pick a part first");
            return;
        }
        if (state.pnpTarget === "device") {
            const device = await ctx.call(ctx.api.deviceGoto(job.id, selected));
            if (device) {
                ctx.store.set({ device });
            }
            return;
        }
        await ctx.call(ctx.api.pnpGoto({ job: job.id, ref: selected, correct: correct.checked }));
    }

    function pick(ref: string): void {
        selected = selected === ref ? null : ref;
        ctx.store.set({ pnpPart: selected });
        const state = ctx.store.get();
        renderParts(state);
        renderBoard(state);
    }

    function partsOf(state: AppState): Component[] {
        return state.components !== null && state.components.job === state.job?.id ? state.components.components : [];
    }

    // What the table and the drawing were last made from: they are made
    // again only when that changes, so a press on a row or a dot is not
    // lost to a rebuild under the pointer.
    let tableKey = "";
    let boardKey = "";
    let drawn: { root: SVGElement; box: Box } | null = null;

    function renderParts(state: AppState): void {
        const all = partsOf(state);
        if (selected !== null && !all.some((part) => part.ref === selected)) {
            selected = null;
            ctx.store.set({ pnpPart: null });
        }
        renderActions(state);
        const key = JSON.stringify([state.job?.id ?? null, state.components, filter.value, sidePick.value, selected]);
        if (key === tableKey) {
            return;
        }
        tableKey = key;
        const shown = filterParts(all, filter.value, sidePick.value as "all" | "front" | "back");
        const note = state.components !== null && state.components.job === state.job?.id ? state.components.note : null;
        partsNote.textContent = !state.job
            ? "Pick a board job: its parts are listed here and drawn beside."
            : note ?? (all.length === 0 ? "The board has no parts." : `${shown.length} of ${all.length} parts`);
        const rows = shown.map((part) => {
            const row = el("tr", { class: `${part.ref === selected ? "selected" : ""}${part.dnp ? " dnp" : ""}`, onclick: () => pick(part.ref) },
                el("td", { class: "mono" }, part.ref),
                el("td", {}, part.value, part.dnp ? el("span", { class: "muted" }, " dnp") : null),
                el("td", { class: "muted", title: part.footprint }, footprintName(part.footprint)),
                el("td", { class: "mono" }, formatFixed(part.x, 2)),
                el("td", { class: "mono" }, formatFixed(part.y, 2)),
                el("td", { class: "mono" }, formatFixed(part.rotation, 1)),
                el("td", { class: "muted" }, part.side),
            );
            return row;
        });
        replace(table,
            el("thead", {}, el("tr", {}, ...["Ref", "Value", "Footprint", "X", "Y", "Rot", "Side"].map((name) => el("th", {}, name)))),
            el("tbody", {}, ...rows),
        );
        const chosen = all.find((part) => part.ref === selected) ?? null;
        chosenLine.textContent = chosen
            ? `${chosen.ref} ${chosen.value}: X ${formatFixed(chosen.x, 3)} Y ${formatFixed(chosen.y, 3)}, ${formatFixed(chosen.rotation, 1)} deg, ${chosen.side}`
            : "No part picked.";
    }

    /** The goto's button and box, which follow the machine and the up camera. */
    function renderActions(state: AppState): void {
        const onDevice = state.pnpTarget === "device";
        const busy = onDevice ? state.device?.running === true : state.pnp?.routine?.state === "running";
        const chosen = selected !== null && partsOf(state).some((part) => part.ref === selected);
        const linked = onDevice ? state.device?.connected === true : state.snapshot.connected;
        setLocked(gotoButton, !linked || !chosen || busy);
        correctLabel.classList.toggle("hidden", onDevice);
        correct.disabled = !state.pnp?.part_offset;
        if (correct.disabled) {
            correct.checked = false;
        }
    }

    function renderBoard(state: AppState): void {
        const machine = state.snapshot.machine;
        const camera = isCartesian(state.snapshot) ? cameraOnBoard(state.pnp?.position ?? null, machine?.joint.a ?? 0) : null;
        const key = JSON.stringify([state.job?.id ?? null, state.job?.outline.length ?? 0, state.job?.pads?.length ?? 0, state.job?.rotation ?? 0, state.components, selected, camera]);
        if (key !== boardKey) {
            boardKey = key;
            drawn = boardSvg({ job: state.job, parts: partsOf(state), selected, camera }, pick);
            replace(drawing, drawn?.root ?? el("p", { class: "muted" }, "Nothing to draw: pick a board job."));
        }
        if (drawn) {
            placeHead(drawn.root, drawn.box, state.snapshot.connected && machine ? machine.board : null);
        }
    }

    function renderJobs(state: AppState): void {
        const current = state.job?.id ?? "";
        replace(jobPick,
            el("option", { value: "" }, state.jobs.length > 0 ? "pick a job" : "no jobs"),
            ...state.jobs.map((job) => el("option", { value: job.id }, `${job.name} (${job.source})`)),
        );
        jobPick.value = current;
    }

    function renderCamera(state: AppState): void {
        const pnp = state.pnp;
        const running = pnp?.running === true;
        const busy = pnp?.routine?.state === "running";
        cameraBadge.textContent = busy ? "routine" : running ? "running" : "stopped";
        cameraBadge.setAttribute("data-camera", busy ? "finding mark" : running ? "running" : "stopped");
        pictureBox.classList.toggle("hidden", !running);
        if (!running) {
            picture.removeAttribute("src");
        }
        setLocked(startButton, running);
        setLocked(stopButton, !running || busy);
        const connected = state.snapshot.connected;
        setLocked(centerButton, !connected || !running || busy);
        setLocked(partButton, !connected || !running || busy || !pnp?.position || !(pnp.mm_per_px > 0));
        setLocked(abortButton, !busy);
        setLocked(forget, !pnp?.position || busy);
        if (pnp) {
            cameraFields.follow(device, pnp.device);
            cameraFields.follow(size, pnp.size);
            cameraFields.follow(fps, String(pnp.fps));
            cameraFields.follow(nozzleSpot, pnp.nozzle_spot);
            cameraFields.follow(partSpot, pnp.part_spot);
            measuredFields.follow(posR, pnp.position ? String(pnp.position[0]) : "");
            measuredFields.follow(posZ, pnp.position ? String(pnp.position[1]) : "");
            measuredFields.follow(height, pnp.height === null ? "" : String(pnp.height));
            measuredFields.follow(scale, String(pnp.mm_per_px));
            measuredFields.follow(roll, String(pnp.roll));
            if (mirrorShown === null || mirror.checked === mirrorShown) {
                mirror.checked = pnp.mirror;
            }
            mirrorShown = pnp.mirror;
        }
        cameraPick.render();
        showPending();
        routineLine.textContent = pnpRoutineText(pnp);
        partLine.textContent = partOffsetText(pnp);
    }

    // The parts of the selected job, asked for once it changes.
    async function loadParts(state: AppState): Promise<void> {
        const job = state.job;
        const id = job?.id ?? null;
        const key = job ? JSON.stringify([job.id, job.offset, job.rotation ?? 0, job.design ?? null]) : null;
        if (key === asked) {
            return;
        }
        asked = key;
        if (id === null) {
            ctx.store.set({ components: null });
            return;
        }
        const parts = await ctx.call(ctx.api.components(id));
        if (parts && asked === key) {
            ctx.store.set({ components: parts });
        }
    }

    function visible(): boolean {
        return activePage() === "pnp" && (typeof document.visibilityState !== "string" || document.visibilityState !== "hidden");
    }

    let lastFrame = 0;
    function refreshFrame(force = false): void {
        if (!visible() || !ctx.store.get().pnp?.running) {
            return;
        }
        const now = Date.now();
        if (!force && now - lastFrame < PNP_FRAME_MS - 10) {
            return;
        }
        lastFrame = now;
        picture.src = ctx.api.pnpFrameUrl(PNP_FRAME_WIDTH, overlayOn);
    }
    // The state is polled while the page shows, for the picture's age and a
    // routine's steps; the event feed carries the rest.
    const frameTimer = setInterval(() => refreshFrame(), PNP_FRAME_MS);
    const pollTimer = setInterval(() => {
        if (visible()) {
            ctx.api.pnp().then((state) => ctx.store.set({ pnp: state }), () => undefined);
        }
    }, POLL_MS);
    globalThis.addEventListener?.("pagehide", () => {
        clearInterval(frameTimer);
        clearInterval(pollTimer);
        cameraPick.stop();
    });

    ctx.store.subscribe((state) => {
        void loadParts(state);
        renderParts(state);
        renderBoard(state);
    }, ["job", "components"]);
    ctx.store.subscribe((state) => renderJobs(state), ["jobs", "job"]);
    ctx.store.subscribe((state) => {
        renderCamera(state);
        renderActions(state);
        renderBoard(state);
    }, ["pnp", "snapshot"]);
    // This machine's camera and nozzle, or the G-code device.
    const showTarget = (state: AppState): void => {
        const onDevice = state.pnpTarget === "device";
        target.value = state.pnpTarget;
        // The up camera's picture serves either machine; the nozzle panel is this machine's.
        roots.nozzle.classList.toggle("hidden", onDevice);
        roots.device?.classList.toggle("hidden", !onDevice);
        renderActions(state);
    };
    ctx.store.subscribe(showTarget, ["pnpTarget", "device"]);
    showTarget(ctx.store.get());
    const now = ctx.store.get();
    renderJobs(now);
    renderParts(now);
    renderBoard(now);
    renderCamera(now);
    void loadParts(now);
}
