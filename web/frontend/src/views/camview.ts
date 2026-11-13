// The PNP page's camera pictures, each in a panel of its own so the page's
// layout can put them side by side, stack them as tabs or size them apart:
// the bottom camera's (fixed to the machine, looking up at the nozzle) and,
// with a G-code machine, its top camera's (on the head, looking down). Each
// shows what its routines and Look once found (the circle looked within,
// the spot's ellipse and rectangle), the circle a part or a mark is looked
// for within, and for the top camera the box a board search keeps to and
// the board where its looks put it. A drag moves the head (picture.ts).
// The pictures are asked for only while the page shows.

import { activePage, el } from "../dom.ts";
import type { AppState } from "../state.ts";
import type { BoardCorners, BoardEstimate, Job, RoutineSpot, SpotLook } from "../types.ts";
import type { Ctx } from "./context.ts";
import { type Calibration, type Mark, machineToPicturePoints, mountPicture, type PictureView, spotMarks } from "./picture.ts";
import { gcodePlacing } from "./placing.ts";

export { dragMove, pictureToMachine } from "./picture.ts";

/** A camera's full picture size: the frame's when it has one, else the size it was started at. */
export function frameSize(frame: { width: number; height: number } | null | undefined, size: string | undefined): [number, number] | null {
    if (frame && frame.width > 0 && frame.height > 0) {
        return [frame.width, frame.height];
    }
    const match = /^(\d+)x(\d+)$/.exec(size ?? "");
    return match ? [Number(match[1]), Number(match[2])] : null;
}

/** The marks of the spot a routine found while it runs or after it failed, else of the last Look once. */
export function foundMarks(routine: { state: string; spot: RoutineSpot | null } | null | undefined, look: SpotLook | null | undefined, size: [number, number]): Mark[] {
    if (routine && routine.spot && (routine.state === "running" || routine.state === "error")) {
        return spotMarks(routine.spot, size, "spot");
    }
    if (look) {
        return spotMarks(look, size, "look");
    }
    return routine?.spot ? spotMarks(routine.spot, size, "spot") : [];
}

/** A circle about the picture's center `mm` wide on either side, in the picture's px. */
export function reachMark(mm: number | null | undefined, calibration: Calibration | null, size: [number, number], title: string): Mark[] {
    if (calibration === null || mm === null || mm === undefined || !(mm > 0)) {
        return [];
    }
    return [{ kind: "circle", x: size[0] / 2, y: size[1] / 2, r: mm / calibration.mmPerPx, tone: "ring", title }];
}

/**
 * The job's outline where a board look's estimate puts it, in the picture:
 * each outline point turned and shifted onto the machine, then seen from
 * the picture's center; the rough place the corners taken give drawn as
 * `rough`.
 */
export function boardMarks(
    job: Job | null,
    estimate: { rotation: number; shift: [number, number] } | null | undefined,
    center: [number, number] | null,
    calibration: Calibration | null,
    size: [number, number],
    tone: "board" | "rough" = "board",
): Mark[] {
    if (!job || !estimate || center === null || calibration === null) {
        return [];
    }
    const radians = (estimate.rotation * Math.PI) / 180;
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    return job.outline.map((path) => ({
        kind: "line" as const,
        points: machineToPicturePoints(path.map(([x, y]) => [x * c - y * s + estimate.shift[0], x * s + y * c + estimate.shift[1]] as [number, number]), center, calibration, size),
        tone,
        title: tone === "rough" ? "the board where the corners taken put it" : "the board where the looks put it",
    }));
}

/** The rough place the corners taken of the job drawn give, when they are of that job. */
export function roughOf(job: Job | null, corners: BoardCorners | null | undefined): BoardEstimate | null {
    return job !== null && corners && corners.job === job.id ? corners.rough : null;
}

/** The bottom camera's calibration on the machine its routines move. */
function bottomCalibration(state: AppState): Calibration | null {
    if (gcodePlacing(state)) {
        const place = state.placing?.camera;
        return place && place.mm_per_px > 0 ? { mmPerPx: place.mm_per_px, roll: place.roll, mirror: place.mirror } : null;
    }
    const pnp = state.pnp;
    return pnp && pnp.mm_per_px > 0 ? { mmPerPx: pnp.mm_per_px, roll: pnp.roll, mirror: pnp.mirror } : null;
}

/** The top camera's calibration, once measured. */
export function topCalibration(state: AppState): Calibration | null {
    const top = state.placing?.top;
    return top && top.mm_per_px > 0 ? { mmPerPx: top.mm_per_px, roll: top.roll, mirror: top.mirror } : null;
}

/** The machine point under the top camera's picture's center: the head's place plus the camera's offset, measured or the file's. */
export function topCenter(state: AppState): [number, number] | null {
    const placing = state.placing;
    const offset = placing?.top?.offset ?? placing?.document?.top?.offset ?? null;
    const x = placing?.position?.x;
    const y = placing?.position?.y;
    if (offset === null || x === undefined || y === undefined) {
        return null;
    }
    return [x + offset[0], y + offset[1]];
}

export interface CameraViews {
    bottom: PictureView;
    top: PictureView;
}

export function mountCameraViews(roots: { bottom: HTMLElement; top: HTMLElement }, ctx: Ctx): CameraViews {
    const visible = (): boolean => activePage() === "pnp" && document.visibilityState !== "hidden";
    const jog = async (mm: [number, number]): Promise<void> => {
        if (Math.hypot(mm[0], mm[1]) < 0.001) {
            return;
        }
        // X and Y on a G-code machine, the rail and the cross slide on this
        // project's: a joint jog moves either.
        await ctx.call(ctx.api.jog({ kind: "joint", dr: Number(mm[0].toFixed(4)), dz: Number(mm[1].toFixed(4)) }));
    };

    const bottom = mountPicture({
        key: "up",
        label: "Bottom camera",
        rides: false,
        running: (state) => state.pnp?.running === true,
        frameUrl: (width, overlay) => ctx.api.pnpFrameUrl(width, overlay),
        pcbvOverlay: () => false,
        size: (state) => frameSize(state.pnp?.frame, state.pnp?.size),
        calibration: bottomCalibration,
        center: () => null,
        marks: (state) => {
            const size = frameSize(state.pnp?.frame, state.pnp?.size) ?? [1280, 720];
            const crop = gcodePlacing(state) ? state.placing?.document?.crop ?? null : null;
            return [
                ...reachMark(crop, bottomCalibration(state), size, "parts are looked for within this circle"),
                ...foundMarks(state.pnp?.routine, state.pnp?.look, size),
            ];
        },
        move: jog,
        noScale: "the bottom camera's scale is not measured yet: Center nozzle first",
        visible,
    }, ctx);
    const bottomEmpty = el("p", { class: "muted camera-view-empty" }, "The bottom camera is not running: start it in its panel.");
    roots.bottom.append(
        el("div", { class: "panel-head" }, el("h2", {}, "Bottom camera view")),
        el("div", { class: "panel-body" },
            bottom.root,
            bottomEmpty,
            el("p", { class: "muted hint" }, "Drag the picture to move the head; double-click a point to bring it to the crosshair; Ctrl and the wheel zoom. The grip under the picture sets its height."),
        ),
    );

    const top = mountPicture({
        key: "top",
        label: "Top camera",
        rides: true,
        running: (state) => state.placing?.top?.running === true,
        frameUrl: (width, overlay) => ctx.api.topFrameUrl(width, overlay),
        pcbvOverlay: (state) => (state.placing?.top?.board_look?.job ?? null) !== null,
        size: (state) => frameSize(state.placing?.top?.frame, state.placing?.top?.size),
        calibration: topCalibration,
        center: topCenter,
        marks: (state) => {
            const topState = state.placing?.top;
            const size = frameSize(topState?.frame, topState?.size) ?? [1280, 720];
            const calibration = topCalibration(state);
            const look = topState?.board_look;
            const job = look?.job && state.job?.id === look.job ? state.job : null;
            return [
                ...reachMark(state.placing?.document?.top?.within ?? null, calibration, size, "marks and fiducials are looked for within this circle"),
                ...foundMarks(topState?.routine, topState?.look, size),
                ...boardMarks(state.job, roughOf(state.job, look?.corners), topCenter(state), calibration, size, "rough"),
                ...boardMarks(job, look?.estimate ?? null, topCenter(state), calibration, size),
            ];
        },
        move: jog,
        noScale: "the top camera's scale is not measured yet: Measure offset first",
        visible: () => visible() && gcodePlacing(ctx.store.get()),
        boxes: true,
    }, ctx);
    const topEmpty = el("p", { class: "muted camera-view-empty" }, "The top camera is not running: start it in its panel.");
    roots.top.append(
        el("div", { class: "panel-head" }, el("h2", {}, "Top camera view")),
        el("div", { class: "panel-body" },
            top.root,
            topEmpty,
            el("p", { class: "muted hint" }, "Drag the picture to move the head; double-click a point to bring it to the crosshair; Ctrl and the wheel zoom; Shift and a drag draw the box a board search keeps to."),
        ),
    );

    function render(state: AppState): void {
        bottom.render(state);
        top.render(state);
        bottomEmpty.classList.toggle("hidden", state.pnp?.running === true);
        topEmpty.classList.toggle("hidden", state.placing?.top?.running === true);
        // The top camera is a G-code machine's: its panel shows with one.
        roots.top.classList.toggle("hidden", !gcodePlacing(state));
    }
    ctx.store.subscribe((state) => render(state), ["pnp", "placing", "snapshot", "job"]);
    render(ctx.store.get());
    globalThis.addEventListener?.("pagehide", () => {
        bottom.stop();
        top.stop();
    });
    return { bottom, top };
}
