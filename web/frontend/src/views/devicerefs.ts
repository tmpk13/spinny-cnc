// Where the board lies on the G-code device. A reference pairs a part of
// the board job with the place it was found on the device: the nozzle
// over it (Nozzle here), or the top camera's crosshair over it (Camera
// here). The references are kept per job and map the whole board: one
// gives the shift (turned by the typed angle), two or more the shift and
// the turn, and every part is placed through that fit. The panel says so
// in numbers: the fit, and how far each reference sits off it. The top
// camera can also find the board's fiducials, which replace the
// references once two or more are found.

import { fitRigid, type RigidFit } from "../align.ts";
import { button, el, labeled, lockFor, numberField, replace, setLocked } from "../dom.ts";
import { formatFixed, parseNumber } from "../format.ts";
import type { AppState } from "../state.ts";
import type { Component, DeviceState } from "../types.ts";
import { into, type Ctx } from "./context.ts";
import { fiducialText, referencesOf } from "./device.ts";
import { infoTip } from "./infotip.ts";

/** The fit the references make of a job's board, as the backend makes it, and how far each one used sits off it; null without a reference. */
export function referenceFit(device: DeviceState | null, jobId: string | null, parts: Component[]): (RigidFit & { off: Map<string, number> }) | null {
    const byRef = new Map(parts.map((part) => [part.ref, part]));
    const entries = referencesOf(device, jobId).filter((entry) => byRef.has(entry.ref));
    const found = entries.filter((entry) => entry.by === "fiducial");
    const used = found.length > 1 ? found : entries;
    if (used.length === 0) {
        return null;
    }
    const pairs = used.map((entry) => {
        const part = byRef.get(entry.ref)!;
        return { design: [part.x, part.y] as [number, number], machine: [entry.at[0], entry.at[1]] as [number, number] };
    });
    try {
        const fit = fitRigid(pairs, used.length === 1 ? device?.angle ?? 0 : null);
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

export function mountDeviceRefs(root: HTMLElement, ctx: Ctx): void {
    const nozzleHere = button("Nozzle here", () => reference(false), "btn btn-primary");
    nozzleHere.title = "the picked part is under the nozzle's tip: keep where the device is as its place";
    const cameraHere = button("Camera here", () => reference(true), "btn");
    cameraHere.title = "the picked part is under the top camera's crosshair: keep its place by the camera's offset";
    const angle = numberField({ step: 0.1, placeholder: "fitted", width: "6rem" });
    angle.setAttribute("aria-label", "Board turned on the device");
    angle.title = "the board's turn on the device, used with a single reference";
    const clear = button("Clear", () => clearReferences(), "btn btn-quiet");
    const list = el("ul", { class: "device-references" });
    const fitLine = el("p", { class: "muted hint device-fit" });
    const findFiducials = button("Find fiducials", () => findFiducialsNow(), "btn");
    findFiducials.title = "the top camera looks for the board's fiducials where the references put them";
    const fiducialLine = el("p", { class: "muted" });

    root.append(
        el("div", { class: "panel-head" }, el("h2", {}, "Board on the device"), infoTip("references")),
        el("div", { class: "panel-body" },
            el("p", { class: "muted hint" }, "Pick a part, put the nozzle or the top camera over it, and press Here. The references are kept and map the whole board."),
            el("div", { class: "button-row" }, nozzleHere, cameraHere),
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
        void into(ctx, "device", ctx.api.deviceSelect(text === "" ? { clear_angle: true } : { angle: value! }));
    });

    async function reference(camera: boolean): Promise<void> {
        const state = ctx.store.get();
        if (!state.job || state.pnpPart === null) {
            ctx.toast("error", "pick a part in the Parts panel first");
            return;
        }
        await into(ctx, "device", ctx.api.deviceReference({ job: state.job.id, ref: state.pnpPart, ...(camera ? { camera: true } : {}) }));
    }

    async function clearReferences(): Promise<void> {
        const job = ctx.store.get().job;
        if (job) {
            await into(ctx, "device", ctx.api.deviceDropReferences(job.id));
        }
    }

    async function findFiducialsNow(): Promise<void> {
        const job = ctx.store.get().job;
        if (!job) {
            ctx.toast("error", "pick a board job first");
            return;
        }
        await into(ctx, "device", ctx.api.deviceFiducials(job.id));
    }

    let listKey = "";
    function render(state: AppState): void {
        const device = state.device;
        const job = state.job;
        const parts = state.components !== null && state.components.job === job?.id ? state.components.components : [];
        const refs = referencesOf(device, job?.id ?? null);
        const fit = referenceFit(device, job?.id ?? null, parts);
        const connected = device?.connected === true;
        const busy = device?.running === true || (state.pnp?.routine?.state === "running" && state.pnp.routine.target === "device") || device?.top?.routine?.state === "running";
        const picked = state.pnpPart !== null && parts.some((part) => part.ref === state.pnpPart);
        nozzleHere.textContent = picked ? `Nozzle here: ${state.pnpPart}` : "Nozzle here";
        cameraHere.textContent = picked ? `Camera here: ${state.pnpPart}` : "Camera here";
        lockFor(nozzleHere, [!connected, "connect the device first"], [busy, "the device is busy"], [!picked, "pick a part in the Parts panel first"]);
        const offsetKnown = (device?.top?.offset ?? null) !== null || (state.deviceDoc?.document.top?.offset ?? null) !== null;
        lockFor(cameraHere, [!connected, "connect the device first"], [busy, "the device is busy"], [!picked, "pick a part in the Parts panel first"], [!offsetKnown, "the top camera's offset is not known: give it in the profile or measure it"]);
        setLocked(clear, refs.length === 0, "no reference to clear");
        const measured = device?.top?.offset !== null && device?.top?.offset !== undefined && (device?.top?.mm_per_px ?? 0) > 0;
        lockFor(findFiducials, [!connected, "connect the device first"], [busy, "the device is busy"], [device?.top?.running !== true, "start the top camera first"], [!measured, "measure the top camera's offset first"], [!job, "pick a board job first"]);
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
                button("Drop", () => job ? into(ctx, "device", ctx.api.deviceDropReferences(job.id, entry.ref)) : Promise.resolve(), "btn btn-quiet btn-small"));
        }));
    }

    ctx.store.subscribe((state) => render(state), ["device", "deviceDoc", "job", "components", "pnpPart", "pnp"]);
    render(ctx.store.get());
}
