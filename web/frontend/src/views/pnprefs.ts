// Where the board lies on the G-code machine. A reference pairs a part of
// the board job with the place it was found on the machine: the nozzle
// over it (Nozzle here), or the top camera's crosshair over it (Camera
// here). The references are kept per job and map the whole board: one
// gives the shift (turned by the typed angle), two or more the shift and
// the turn, and every part is placed through that fit. The panel says so
// in numbers: the fit, and how far each reference sits off it. The top
// camera can also find the board's fiducials, which replace the
// references once two or more are found. The parts to align to: how many
// and which (partshape.ts), stepped through with Next, each one's shape
// drawn about the top camera's crosshair to line it up with by eye.

import { fitRigid, type RigidFit } from "../align.ts";
import { button, el, labeled, lockFor, numberField, replace, setLocked } from "../dom.ts";
import { formatFixed, parseNumber } from "../format.ts";
import type { AppState } from "../state.ts";
import type { Component, PlacingState, PnpReference } from "../types.ts";
import { into, type Ctx } from "./context.ts";
import { fiducialText, referencesOf } from "./placing.ts";
import { infoTip } from "./infotip.ts";
import { readAlignCount, readAlignSet, readShowShape, spreadParts, writeAlignCount, writeAlignSet, writeShowShape } from "./partshape.ts";

/** A reference's place in the job's frame: a corner's own point, else its part's; null for a part the board lacks. */
function designOf(entry: PnpReference, byRef: Map<string, Component>): [number, number] | null {
    if (entry.by === "corner") {
        return entry.point ?? null;
    }
    const part = byRef.get(entry.ref);
    return part ? [part.x, part.y] : null;
}

/**
 * The fit the references make of a job's board, as the backend makes it
 * (two fiducials found or more outdo the rest; a corner taken is a
 * reference of its own; a lone one is turned by the typed angle, else by
 * its edges' turn), and how far each one used sits off it; null without
 * a reference.
 */
export function referenceFit(device: PlacingState | null, jobId: string | null, parts: Component[]): (RigidFit & { off: Map<string, number> }) | null {
    const byRef = new Map(parts.map((part) => [part.ref, part]));
    const entries = referencesOf(device, jobId).filter((entry) => designOf(entry, byRef) !== null);
    const found = entries.filter((entry) => entry.by === "fiducial");
    const used = found.length > 1 ? found : entries;
    if (used.length === 0) {
        return null;
    }
    const pairs = used.map((entry) => ({ design: designOf(entry, byRef)!, machine: [entry.at[0], entry.at[1]] as [number, number] }));
    const lone = used.length === 1 ? device?.angle ?? used[0]!.angle ?? 0 : null;
    try {
        const fit = fitRigid(pairs, lone);
        return { ...fit, off: new Map(used.map((entry, index) => [entry.ref, fit.residuals[index] ?? 0])) };
    } catch {
        return null;
    }
}

/** The map in words: what the references give, and how well they agree. */
export function fitText(fit: RigidFit | null, count: number, angle: number | null | undefined): string {
    if (fit === null || count === 0) {
        return "Not mapped: no reference yet. Every part is placed by the references, so take one or more.";
    }
    const turn = `turned ${formatFixed(fit.rotation, 2)} deg`;
    if (count === 1) {
        return `Mapped by 1 reference: shifted X ${formatFixed(fit.shift[0], 3)} Y ${formatFixed(fit.shift[1], 3)}, ${turn} ${angle === null || angle === undefined ? "(no turn typed: 0)" : "(typed)"}. A second reference fits the turn.`;
    }
    const worst = Math.max(...fit.residuals);
    return `Mapped by ${count} references: ${turn}, shifted X ${formatFixed(fit.shift[0], 3)} Y ${formatFixed(fit.shift[1], 3)}; the worst sits ${formatFixed(worst, 3)} mm off the fit.`;
}

/** The set's next part to take: the first without a reference; null when every one has one. */
export function nextToAlign(set: string[], taken: Set<string>): string | null {
    return set.find((ref) => !taken.has(ref)) ?? null;
}

/** `onShape` is called when the shape over the top camera's picture is turned on or off. */
export function mountPnpRefs(root: HTMLElement, ctx: Ctx, onShape: () => void = () => undefined): void {
    const nozzleHere = button("Nozzle here", () => reference(false), "btn btn-primary");
    nozzleHere.title = "the picked part is under the nozzle's tip: keep where the head is as its place";
    const cameraHere = button("Camera here", () => reference(true), "btn");
    cameraHere.title = "the picked part is under the top camera's crosshair: keep its place by the camera's offset";
    const angle = numberField({ step: 0.1, placeholder: "fitted", width: "6rem" });
    angle.setAttribute("aria-label", "Board turned on the machine");
    angle.title = "the board's turn on the machine, used with a single reference";
    const clear = button("Clear", () => clearReferences(), "btn btn-quiet", "forget this board's references");
    const list = el("ul", { class: "device-references" });
    const fitLine = el("p", { class: "muted hint device-fit" });
    const findFiducials = button("Find fiducials", () => findFiducialsNow(), "btn");
    findFiducials.title = "the top camera looks for the board's fiducials where the references put them";
    const fiducialLine = el("p", { class: "muted" });
    // The parts to align to.
    const count = numberField({ value: readAlignCount(), min: 1, max: 20, step: 1, width: "4rem" });
    count.setAttribute("aria-label", "Parts to align to");
    count.title = "how many parts Choose picks to line the board up by";
    const choose = button("Choose", () => chooseSet(), "btn", "pick that many parts spread over the board: its fiducials first, then each next part the farthest from those picked");
    const addPicked = button("Add picked", () => editSet(true), "btn btn-quiet", "add the part picked to the parts to align to");
    const dropPicked = button("Drop picked", () => editSet(false), "btn btn-quiet", "take the part picked out of the parts to align to");
    const next = button("Next", () => nextPart(), "btn btn-primary", "pick the next part to align to with no reference yet, and take the top camera over it when the board's place is known");
    const showShape = el("input", { type: "checkbox", "aria-label": "Draw the picked part on the top camera" }) as HTMLInputElement;
    showShape.checked = readShowShape();
    showShape.addEventListener("change", () => {
        writeShowShape(showShape.checked);
        onShape();
    });
    const shapeLabel = el("label", { class: "muted", title: "draw the picked part's pads and body about the top camera's crosshair, turned as it lies, to line it up with by eye" }, showShape, " part's shape on the top camera");
    const setRow = el("div", { class: "button-row align-set" });
    const setLine = el("p", { class: "muted align-line" });

    root.append(
        el("div", { class: "panel-head" }, el("h2", {}, "Board on the machine"), infoTip("references")),
        el("div", { class: "panel-body" },
            el("p", { class: "muted hint" }, "Pick a part, put the nozzle or the top camera over it, and press Here. The references are kept and map the whole board;"
                + " a corner taken with the top camera (Corner here, Board place) is a reference too."),
            el("div", { class: "button-row" }, nozzleHere, cameraHere, shapeLabel),
            el("div", { class: "stack align-parts" },
                el("h3", {}, "Parts to align to"),
                el("div", { class: "button-row" }, labeled("Parts", count, "labeled inline"), choose, addPicked, dropPicked, next),
                setRow,
                setLine,
            ),
            el("div", { class: "button-row" }, labeled("Turned deg", angle, "labeled inline"), clear),
            fitLine,
            list,
            el("div", { class: "button-row" }, findFiducials),
            fiducialLine,
        ),
    );

    // The angle the field was last filled with, to tell a typed one.
    let angleShown = "";
    angle.addEventListener("change", () => {
        const text = angle.value.trim();
        const value = parseNumber(text);
        if (text !== "" && (value === null || Math.abs(value) > 360)) {
            ctx.toast("error", "turn: -360 to 360 deg, or blank to fit it");
            return;
        }
        void into(ctx, "placing", ctx.api.placingAngle(text === "" ? { clear_angle: true } : { angle: value! }));
    });

    count.addEventListener("change", () => {
        const value = parseNumber(count.value);
        if (value === null || !Number.isInteger(value) || value < 1 || value > 20) {
            ctx.toast("error", "parts to align to: 1 to 20");
            count.value = String(readAlignCount());
            return;
        }
        writeAlignCount(value);
    });

    function partsOf(state: AppState): Component[] {
        return state.components !== null && state.components.job === state.job?.id ? state.components.components : [];
    }

    function chooseSet(): void {
        const state = ctx.store.get();
        if (!state.job) {
            ctx.toast("error", "pick a board job first");
            return;
        }
        const value = parseNumber(count.value);
        const wanted = value !== null && Number.isInteger(value) && value >= 1 && value <= 20 ? value : readAlignCount();
        const set = spreadParts(partsOf(state), wanted, state.placing?.top?.side === "back" ? "back" : "front");
        if (set.length === 0) {
            ctx.toast("error", "the board has no part on the side the top camera looks at");
            return;
        }
        writeAlignSet(state.job.id, set);
        renderSet(ctx.store.get());
    }

    function editSet(add: boolean): void {
        const state = ctx.store.get();
        if (!state.job || state.pnpPart === null) {
            ctx.toast("error", "pick a part first");
            return;
        }
        const set = readAlignSet(state.job.id).filter((ref) => ref !== state.pnpPart);
        writeAlignSet(state.job.id, add ? [...set, state.pnpPart] : set);
        renderSet(ctx.store.get());
    }

    /**
     * The set's next part with no reference picked, and the top camera
     * taken over it where the board's place puts it, when that is known;
     * else said where it is to be found by hand.
     */
    async function nextPart(): Promise<void> {
        const state = ctx.store.get();
        const job = state.job;
        if (!job) {
            ctx.toast("error", "pick a board job first");
            return;
        }
        const taken = new Set(referencesOf(state.placing, job.id).map((entry) => entry.ref));
        const ref = nextToAlign(readAlignSet(job.id), taken);
        if (ref === null) {
            ctx.toast("info", "every part to align to has a reference");
            return;
        }
        ctx.store.set({ pnpPart: ref });
        if (referenceFit(state.placing, job.id, partsOf(state)) === null) {
            ctx.toast("info", `${ref} picked: no reference yet to find it by, so put the top camera over it by hand, line it up with its shape, then Camera here`);
            return;
        }
        await ctx.call(ctx.api.pnpGoto({ job: job.id, ref, camera: true }));
        await ctx.refreshPlacing();
    }

    /** The parts to align to as buttons that pick each, those with a reference marked. */
    let setKey = "";
    function renderSet(state: AppState): void {
        const job = state.job;
        const set = job ? readAlignSet(job.id) : [];
        const parts = new Set(partsOf(state).map((part) => part.ref));
        const taken = new Set(referencesOf(state.placing, job?.id ?? null).map((entry) => entry.ref));
        const listed = set.filter((ref) => parts.has(ref));
        const connected = state.placing?.connected === true;
        const busy = state.placing?.running === true || state.placing?.top?.routine?.state === "running";
        const picked = state.pnpPart !== null && parts.has(state.pnpPart);
        lockFor(choose, [!job || parts.size === 0, "pick a board job with parts first"]);
        lockFor(addPicked, [!picked, "pick a part first"], [picked && listed.includes(state.pnpPart!), "the part picked is in the set"]);
        lockFor(dropPicked, [!picked, "pick a part first"], [picked && !listed.includes(state.pnpPart!), "the part picked is not in the set"]);
        lockFor(next, [listed.length === 0, "choose the parts to align to first"], [!connected, "connect the machine first"], [busy, "the machine is busy"]);
        const done = listed.filter((ref) => taken.has(ref)).length;
        const following = nextToAlign(listed, taken);
        setLine.textContent = listed.length === 0
            ? "No parts to align to: Choose picks them spread over the board, or add the part picked."
            : `${done} of ${listed.length} have a reference${following ? `; next: ${following}` : ": the board is lined up by them"}.`;
        const key = JSON.stringify([listed, [...taken].filter((ref) => listed.includes(ref)), state.pnpPart]);
        if (key === setKey) {
            return;
        }
        setKey = key;
        replace(setRow, ...listed.map((ref) => {
            const chip = button(ref, () => ctx.store.set({ pnpPart: ref }), `btn btn-small align-chip${taken.has(ref) ? " taken" : ""}${state.pnpPart === ref ? " picked" : ""}`,
                taken.has(ref) ? `${ref} has a reference: pick it` : `${ref} has no reference yet: pick it, put the top camera over it and press Camera here`);
            chip.setAttribute("aria-pressed", state.pnpPart === ref ? "true" : "false");
            return chip;
        }));
    }

    async function reference(camera: boolean): Promise<void> {
        const state = ctx.store.get();
        if (!state.job || state.pnpPart === null) {
            ctx.toast("error", "pick a part in the Parts panel first");
            return;
        }
        await into(ctx, "placing", ctx.api.pnpReference({ job: state.job.id, ref: state.pnpPart, ...(camera ? { camera: true } : {}) }));
    }

    async function clearReferences(): Promise<void> {
        const job = ctx.store.get().job;
        if (job) {
            await into(ctx, "placing", ctx.api.pnpDropReferences(job.id));
        }
    }

    async function findFiducialsNow(): Promise<void> {
        const job = ctx.store.get().job;
        if (!job) {
            ctx.toast("error", "pick a board job first");
            return;
        }
        await into(ctx, "placing", ctx.api.pnpFiducials(job.id));
    }

    let listKey = "";
    function render(state: AppState): void {
        const device = state.placing;
        const job = state.job;
        const parts = state.components !== null && state.components.job === job?.id ? state.components.components : [];
        const refs = referencesOf(device, job?.id ?? null);
        const fit = referenceFit(device, job?.id ?? null, parts);
        const connected = device?.connected === true;
        const busy = device?.running === true || (state.pnp?.routine?.state === "running" && state.pnp.routine.target === "gcode") || device?.top?.routine?.state === "running";
        const picked = state.pnpPart !== null && parts.some((part) => part.ref === state.pnpPart);
        nozzleHere.textContent = picked ? `Nozzle here: ${state.pnpPart}` : "Nozzle here";
        cameraHere.textContent = picked ? `Camera here: ${state.pnpPart}` : "Camera here";
        lockFor(nozzleHere, [!connected, "connect the machine first"], [busy, "the machine is busy"], [!picked, "pick a part in the Parts panel first"]);
        const offsetKnown = (device?.top?.offset ?? null) !== null || (state.placing?.document?.top?.offset ?? null) !== null;
        lockFor(cameraHere, [!connected, "connect the machine first"], [busy, "the machine is busy"], [!picked, "pick a part in the Parts panel first"], [!offsetKnown, "the top camera's offset is not known: give it in the machine file or measure it"]);
        setLocked(clear, refs.length === 0, "no reference to clear");
        const measured = device?.top?.offset !== null && device?.top?.offset !== undefined && (device?.top?.mm_per_px ?? 0) > 0;
        lockFor(findFiducials, [!connected, "connect the machine first"], [busy, "the machine is busy"], [device?.top?.running !== true, "start the top camera first"], [!measured, "measure the top camera's offset first"], [!job, "pick a board job first"]);
        fitLine.textContent = fitText(fit, refs.length, device?.angle);
        fiducialLine.textContent = fiducialText(device?.top, job?.id ?? null);
        const angleText = device?.angle === null || device?.angle === undefined ? "" : String(device.angle);
        if (angle !== document.activeElement && (angle.value === angleShown || angleShown === "")) {
            angle.value = angleText;
        }
        angleShown = angleText;
        // The list is drawn again only when it changes: a press on a Drop
        // button must not land on one replaced under the pointer.
        const key = JSON.stringify([job?.id ?? null, refs, fit?.residuals ?? []]);
        if (key === listKey) {
            return;
        }
        listKey = key;
        replace(list, ...refs.map((entry) => {
            const residual = fit !== null && fit.off.size > 1 ? fit.off.get(entry.ref) : undefined;
            const off = residual !== undefined ? `, ${formatFixed(residual, 3)} mm off` : "";
            return el("li", {}, `${entry.ref} at X ${formatFixed(entry.at[0], 3)} Y ${formatFixed(entry.at[1], 3)}${entry.by && entry.by !== "nozzle" ? ` (${entry.by})` : ""}${off} `,
                button("Drop", () => job ? into(ctx, "placing", ctx.api.pnpDropReferences(job.id, entry.ref)) : Promise.resolve(), "btn btn-quiet btn-small", `forget ${entry.ref}'s reference`));
        }));
    }

    ctx.store.subscribe((state) => {
        render(state);
        renderSet(state);
    }, ["placing", "job", "components", "pnpPart", "pnp"]);
    render(ctx.store.get());
    renderSet(ctx.store.get());
}
