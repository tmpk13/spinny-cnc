// The PNP page's camera view: the up camera's picture and, with a G-code
// machine, its top camera's, one at a time or side by side, swapped with a
// press. Each picture zooms in on its center (the buttons, or the wheel),
// draws the circle a part is looked for within when the camera's scale is
// known, and moves the machine by dragging: drag what the camera sees and
// the head follows so the picture moves with the pointer, or double-click
// a point to bring it to the crosshair. The pictures are asked for only
// while the page shows.

import { activePage, button, el, readStored, writeStored } from "../dom.ts";
import { formatFixed } from "../format.ts";
import type { AppState } from "../state.ts";
import type { Ctx } from "./context.ts";
import { gcodePlacing } from "./placing.ts";
import { FRAME_INTERVAL_MS, FRAME_WIDTH } from "./vision.ts";

export type ViewMode = "up" | "top" | "split";
type CameraId = "up" | "top";

const MODE_KEY = "spinny.pnp.view";
const ZOOMS = [1, 1.5, 2, 3, 4, 6, 8];

/**
 * A displacement seen in a picture, px from its center (right and down
 * positive), as one on the machine, mm: the picture's y turned over, its x
 * too when mirrored, turned by the roll and scaled, as the backend's
 * picture_to_machine does.
 */
export function pictureToMachine(dx: number, dy: number, mmPerPx: number, roll: number, mirror: boolean): [number, number] {
    const u = mirror ? -dx : dx;
    const v = -dy;
    const radians = (roll * Math.PI) / 180;
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    return [mmPerPx * (u * c - v * s), mmPerPx * (u * s + v * c)];
}

/**
 * The head's move that a drag of `dx`, `dy` px of the full size picture
 * asks for. The top camera rides on the head, so the head moves against
 * what the picture shows; the up camera stays put and sees the nozzle, so
 * the head moves with it.
 */
export function dragMove(camera: CameraId, dx: number, dy: number, mmPerPx: number, roll: number, mirror: boolean): [number, number] {
    const [mx, my] = pictureToMachine(dx, dy, mmPerPx, roll, mirror);
    return camera === "top" ? [-mx, -my] : [mx, my];
}

/** The views offered: the top camera's only with a G-code machine. */
export function viewModes(device: boolean): ViewMode[] {
    return device ? ["up", "top", "split"] : ["up"];
}

interface Calibration {
    mmPerPx: number;
    roll: number;
    mirror: boolean;
    /** The full size picture's width, px, when the camera says it. */
    width: number | null;
}

export function mountCameraView(root: HTMLElement, ctx: Ctx): void {
    let mode: ViewMode = (["up", "top", "split"] as ViewMode[]).find((entry) => entry === readStored(MODE_KEY)) ?? "up";
    const zoom: Record<CameraId, number> = { up: 1, top: 1 };
    const modeButtons = new Map<ViewMode, HTMLButtonElement>();
    const modeRow = el("div", { class: "choice-row camera-view-modes" });
    for (const [value, label] of [["up", "Up"], ["top", "Top"], ["split", "Both"]] as [ViewMode, string][]) {
        const press = button(label, () => setMode(value), "btn btn-choice");
        press.title = value === "split" ? "both cameras side by side" : `the ${value} camera`;
        modeButtons.set(value, press);
        modeRow.append(press);
    }
    const swap = button("Swap", () => setMode(mode === "up" ? "top" : "up"), "btn btn-quiet btn-small");
    swap.title = "show the other camera";
    let overlayOn = true;
    const overlay = button("Overlay", () => {
        overlayOn = !overlayOn;
        overlay.setAttribute("aria-pressed", overlayOn ? "true" : "false");
        refresh(true);
    }, "btn btn-quiet btn-small btn-toggle");
    overlay.setAttribute("aria-pressed", "true");
    const hint = el("p", { class: "muted hint" }, "Drag the picture to move the head; double-click a point to bring it to the crosshair; the wheel zooms.");
    const empty = el("p", { class: "muted camera-view-empty" }, "No camera running: start one below.");

    function viewer(camera: CameraId): { box: HTMLElement; picture: HTMLImageElement; ring: HTMLElement; label: HTMLElement; zoomLine: HTMLElement } {
        const picture = el("img", { class: "camera-view-picture", alt: `${camera === "up" ? "Up" : "Top"} camera picture`, draggable: "false" }) as HTMLImageElement;
        const ring = el("div", { class: "camera-view-ring hidden" });
        const stage = el("div", { class: "camera-view-stage" }, picture, ring);
        const zoomLine = el("span", { class: "muted mono" }, "1x");
        const label = el("span", { class: "camera-view-label" }, camera === "up" ? "Up camera" : "Top camera");
        const out = button("-", () => setZoom(camera, -1), "btn btn-quiet btn-small");
        out.title = "zoom out";
        const into = button("+", () => setZoom(camera, 1), "btn btn-quiet btn-small");
        into.title = "zoom in";
        const box = el("figure", { class: "camera-view hidden", "data-camera": camera },
            stage,
            el("figcaption", { class: "button-row camera-view-caption" }, label, out, zoomLine, into),
        );
        stage.addEventListener("wheel", (event) => {
            event.preventDefault();
            setZoom(camera, event.deltaY < 0 ? 1 : -1);
        }, { passive: false });
        dragToMove(camera, stage, picture);
        return { box, picture, ring, label, zoomLine };
    }

    const up = viewer("up");
    const top = viewer("top");
    const views = { up, top };
    const grid = el("div", { class: "camera-view-grid" }, up.box, top.box);
    root.append(
        el("div", { class: "panel-head" }, el("h2", {}, "Cameras"), el("div", { class: "button-row" }, overlay)),
        el("div", { class: "panel-body" },
            el("div", { class: "button-row" }, modeRow, swap),
            grid,
            empty,
            hint,
        ),
    );

    function setMode(next: ViewMode): void {
        mode = next;
        writeStored(MODE_KEY, next);
        render(ctx.store.get());
        refresh(true);
    }

    function setZoom(camera: CameraId, direction: 1 | -1): void {
        const at = ZOOMS.indexOf(zoom[camera]);
        zoom[camera] = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, at + direction))]!;
        applyZoom(camera);
    }

    function applyZoom(camera: CameraId): void {
        const view = views[camera];
        view.picture.style.transform = `scale(${zoom[camera]})`;
        view.zoomLine.textContent = `${zoom[camera]}x`;
        drawRing(camera, ctx.store.get());
    }

    /** The calibration a camera's picture maps to the machine by, and the machine it moves. */
    function calibrationOf(camera: CameraId, state: AppState): Calibration | null {
        if (camera === "top") {
            const topState = state.placing?.top;
            if (!topState || !(topState.mm_per_px > 0)) {
                return null;
            }
            return { mmPerPx: topState.mm_per_px, roll: topState.roll, mirror: topState.mirror, width: topState.frame?.width ?? null };
        }
        if (gcodePlacing(state)) {
            const place = state.placing?.camera;
            if (!place || !(place.mm_per_px > 0)) {
                return null;
            }
            return { mmPerPx: place.mm_per_px, roll: place.roll, mirror: place.mirror, width: state.pnp?.frame?.width ?? null };
        }
        const pnp = state.pnp;
        if (!pnp || !(pnp.mm_per_px > 0)) {
            return null;
        }
        return { mmPerPx: pnp.mm_per_px, roll: pnp.roll, mirror: pnp.mirror, width: pnp.frame?.width ?? null };
    }

    /** px of the full size picture per px shown. */
    function scaleOf(camera: CameraId, calibration: Calibration | null): number {
        const shown = views[camera].picture.getBoundingClientRect().width / zoom[camera];
        const width = calibration?.width ?? views[camera].picture.naturalWidth;
        return shown > 0 && width ? width / shown : 1;
    }

    /** The circle a part is looked for within: the profile's crop for the up camera, the top camera's search reach for it. */
    function drawRing(camera: CameraId, state: AppState): void {
        const view = views[camera];
        const calibration = calibrationOf(camera, state);
        const doc = state.placing?.document;
        const mm = camera === "top" ? doc?.top?.within ?? null : gcodePlacing(state) ? doc?.crop ?? null : null;
        if (calibration === null || mm === null || mm === undefined) {
            view.ring.classList.add("hidden");
            return;
        }
        const shownPx = (mm / calibration.mmPerPx / scaleOf(camera, calibration)) * zoom[camera];
        const stage = view.ring.parentElement!.getBoundingClientRect();
        if (stage.width <= 0) {
            view.ring.classList.add("hidden");
            return;
        }
        // In percent of the stage, so the ring keeps its place as the page reflows.
        view.ring.style.width = `${(2 * shownPx * 100) / stage.width}%`;
        view.ring.style.height = `${(2 * shownPx * 100) / stage.height}%`;
        view.ring.classList.remove("hidden");
        view.ring.title = `parts are looked for within ${formatFixed(mm, 2)} mm of the center`;
    }

    /** Moves the head by a joint jog along X (the rail, or a G-code machine's X) and Y (the cross slide, or its Y): the same on either. */
    async function moveBy(_camera: CameraId, mm: [number, number]): Promise<void> {
        if (Math.hypot(mm[0], mm[1]) < 0.001) {
            return;
        }
        await ctx.call(ctx.api.jog({ kind: "joint", dr: Number(mm[0].toFixed(4)), dz: Number(mm[1].toFixed(4)) }));
    }

    function dragToMove(camera: CameraId, stage: HTMLElement, picture: HTMLImageElement): void {
        let start: { x: number; y: number } | null = null;
        stage.addEventListener("pointerdown", (event) => {
            if (event.button !== 0) {
                return;
            }
            start = { x: event.clientX, y: event.clientY };
            stage.setPointerCapture?.(event.pointerId);
            stage.classList.add("dragging");
        });
        stage.addEventListener("pointerup", (event) => {
            stage.classList.remove("dragging");
            if (start === null) {
                return;
            }
            const dx = event.clientX - start.x;
            const dy = event.clientY - start.y;
            start = null;
            // A press that barely moved is a click: the double-click handles it.
            if (Math.hypot(dx, dy) < 4) {
                return;
            }
            const state = ctx.store.get();
            const calibration = calibrationOf(camera, state);
            if (calibration === null) {
                ctx.toast("info", "the camera's scale is not measured yet: Center nozzle (up) or Measure offset (top) first");
                return;
            }
            const scale = scaleOf(camera, calibration) / zoom[camera];
            void moveBy(camera, dragMove(camera, dx * scale, dy * scale, calibration.mmPerPx, calibration.roll, calibration.mirror));
        });
        stage.addEventListener("dblclick", (event) => {
            const state = ctx.store.get();
            const calibration = calibrationOf(camera, state);
            if (calibration === null) {
                ctx.toast("info", "the camera's scale is not measured yet");
                return;
            }
            const box = picture.getBoundingClientRect();
            const scale = scaleOf(camera, calibration) / zoom[camera];
            const dx = (event.clientX - (box.left + box.width / 2)) * scale;
            const dy = (event.clientY - (box.top + box.height / 2)) * scale;
            // The point clicked comes to the center: against the drag's sense.
            const [mx, my] = dragMove(camera, dx, dy, calibration.mmPerPx, calibration.roll, calibration.mirror);
            void moveBy(camera, [-mx, -my]);
        });
    }

    function running(camera: CameraId, state: AppState): boolean {
        return camera === "up" ? state.pnp?.running === true : state.placing?.top?.running === true;
    }

    function shown(camera: CameraId, state: AppState): boolean {
        const modes = viewModes(gcodePlacing(state));
        const current = modes.includes(mode) ? mode : "up";
        return running(camera, state) && (current === "split" || current === camera);
    }

    function render(state: AppState): void {
        const device = gcodePlacing(state);
        const modes = viewModes(device);
        for (const [value, press] of modeButtons) {
            press.classList.toggle("hidden", !modes.includes(value));
            press.setAttribute("aria-pressed", (modes.includes(mode) ? mode : "up") === value ? "true" : "false");
        }
        swap.classList.toggle("hidden", !device);
        for (const camera of ["up", "top"] as CameraId[]) {
            const view = views[camera];
            const visible = shown(camera, state);
            view.box.classList.toggle("hidden", !visible);
            if (!running(camera, state)) {
                view.picture.removeAttribute("src");
            }
            drawRing(camera, state);
        }
        empty.classList.toggle("hidden", running("up", state) || (device && running("top", state)));
        grid.classList.toggle("hidden", !shown("up", state) && !shown("top", state));
    }

    function visible(): boolean {
        return activePage() === "pnp" && document.visibilityState !== "hidden";
    }

    let last = 0;
    function refresh(force = false): void {
        if (!visible()) {
            return;
        }
        const now = Date.now();
        if (!force && now - last < FRAME_INTERVAL_MS - 10) {
            return;
        }
        last = now;
        const state = ctx.store.get();
        if (shown("up", state)) {
            up.picture.src = ctx.api.pnpFrameUrl(FRAME_WIDTH, overlayOn);
        }
        if (shown("top", state)) {
            top.picture.src = ctx.api.topFrameUrl(FRAME_WIDTH, overlayOn);
        }
    }
    const timer = setInterval(() => refresh(), FRAME_INTERVAL_MS);
    globalThis.addEventListener?.("pagehide", () => clearInterval(timer));

    ctx.store.subscribe((state) => render(state), ["pnp", "placing", "snapshot"]);
    render(ctx.store.get());
    applyZoom("up");
    applyZoom("top");
}
