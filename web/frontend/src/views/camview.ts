// The PNP page's camera pictures, each in a panel of its own so the page's
// layout can put them side by side, stack them as tabs or size them apart:
// the bottom camera's (fixed to the machine, looking up at the nozzle) and,
// with a G-code machine, its top camera's (on the head, looking down). Each
// keeps what its routines and Look once found (the circle looked within,
// the spot's ellipse and rectangle) until Clear marks, following the
// machine; shows the circle a part or a mark is looked for within, and for
// the top camera the box a board search keeps to and the board where its
// looks put it; each rings the points whose place is known (known.ts), and
// the top camera draws the picked part's pads and body about its crosshair
// to line the part up with (partshape.ts). A drag moves the head
// (picture.ts). The pictures are asked for only while the page shows.

import { activePage, el } from "../dom.ts";
import type { AppState } from "../state.ts";
import type { BoardCorners, BoardEstimate, Job, RoutineSpot, SpotLook } from "../types.ts";
import type { Ctx } from "./context.ts";
import { bottomHead, bottomKnown, knownMarks, topKnown } from "./known.ts";
import { boardTurn, partShapes, readShowShape, shapeMarks } from "./partshape.ts";
import { type Calibration, type Mark, machineToPicturePoints, mountPicture, type PictureView, type ShownSpot } from "./picture.ts";
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

/**
 * The spots a camera's state shows: its routine's newest (live while the
 * routine runs) and its last Look once, each keyed by what it says, so a
 * picture keeps every new one until Clear marks.
 */
export function shownSpots(routine: { state: string; spot: RoutineSpot | null } | null | undefined, look: SpotLook | null | undefined): ShownSpot[] {
    const spots: ShownSpot[] = [];
    if (routine?.spot) {
        spots.push({ key: `routine ${JSON.stringify(routine.spot)}`, spot: routine.spot, tone: "spot", live: routine.state === "running" });
    }
    if (look) {
        spots.push({ key: `look ${JSON.stringify(look)}`, spot: look, tone: "look" });
    }
    return spots;
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

/** The bottom camera's roll and mirror, measured or not, for Upright. */
function bottomOrientation(state: AppState): { roll: number; mirror: boolean } | null {
    const place = gcodePlacing(state) ? state.placing?.camera : state.pnp;
    return place ? { roll: place.roll, mirror: place.mirror } : null;
}

/** The top camera's calibration, once measured. */
export function topCalibration(state: AppState): Calibration | null {
    const top = state.placing?.top;
    return top && top.mm_per_px > 0 ? { mmPerPx: top.mm_per_px, roll: top.roll, mirror: top.mirror } : null;
}

/** The top camera's roll and mirror for Upright: the roll as measured with its scale, else the machine file's, else the settings'. */
export function topOrientation(state: AppState): { roll: number; mirror: boolean } | null {
    const top = state.placing?.top;
    if (!top) {
        return null;
    }
    const designed = state.placing?.document?.top?.roll ?? null;
    return { roll: top.mm_per_px > 0 || designed === null ? top.roll : designed, mirror: top.mirror };
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
        orientation: bottomOrientation,
        center: () => null,
        marks: (state, shown) => {
            const size = frameSize(state.pnp?.frame, state.pnp?.size) ?? [1280, 720];
            const gcode = gcodePlacing(state);
            const crop = gcode ? state.placing?.document?.crop ?? null : null;
            const known = bottomKnown(state, gcode);
            return [
                ...reachMark(crop, bottomCalibration(state), size, "parts are looked for within this circle"),
                ...knownMarks(known.points, known.center, bottomCalibration(state), shown),
            ];
        },
        spots: (state) => (state.pnp ? shownSpots(state.pnp.routine, state.pnp.look) : null),
        // Fixed to the machine, the camera sees the nozzle: what it found moves with the head.
        follow: (state) => bottomHead(state, gcodePlacing(state)),
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

    // The picked part's shape, asked for once a part is picked.
    const shapes = partShapes(ctx, () => top.render(ctx.store.get()));
    const shapeOf = (state: AppState, calibration: Calibration | null, size: [number, number]): Mark[] => {
        const job = state.job;
        const ref = state.pnpPart;
        if (!readShowShape() || !job || ref === null || calibration === null) {
            return [];
        }
        const shape = shapes.get(job, ref);
        return shape ? shapeMarks(shape, boardTurn(state), calibration, size) : [];
    };

    const top = mountPicture({
        key: "top",
        label: "Top camera",
        rides: true,
        running: (state) => state.placing?.top?.running === true,
        frameUrl: (width, overlay) => ctx.api.topFrameUrl(width, overlay),
        pcbvOverlay: (state) => (state.placing?.top?.board_look?.job ?? null) !== null,
        size: (state) => frameSize(state.placing?.top?.frame, state.placing?.top?.size),
        calibration: topCalibration,
        orientation: topOrientation,
        center: topCenter,
        marks: (state, shown) => {
            const topState = state.placing?.top;
            const size = frameSize(topState?.frame, topState?.size) ?? [1280, 720];
            const calibration = topCalibration(state);
            const look = topState?.board_look;
            const job = look?.job && state.job?.id === look.job ? state.job : null;
            return [
                ...reachMark(state.placing?.document?.top?.within ?? null, calibration, size, "marks and fiducials are looked for within this circle"),
                ...boardMarks(state.job, roughOf(state.job, look?.corners), topCenter(state), calibration, size, "rough"),
                ...boardMarks(job, look?.estimate ?? null, topCenter(state), calibration, size),
                ...knownMarks(topKnown(state), topCenter(state), calibration, shown),
                ...shapeOf(state, calibration, size),
            ];
        },
        spots: (state) => (state.placing?.top ? shownSpots(state.placing.top.routine, state.placing.top.look) : null),
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
    ctx.store.subscribe((state) => render(state), ["pnp", "placing", "snapshot", "job", "components", "pnpPart"]);
    render(ctx.store.get());
    globalThis.addEventListener?.("pagehide", () => {
        bottom.stop();
        top.stop();
    });
    return { bottom, top };
}
