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

import { button, el, labeled, lockFor, onShownPage, readStored, writeStored } from "../dom.ts";
import { formatFixed } from "../format.ts";
import type { AppState } from "../state.ts";
import type { BoardCorners, BoardEstimate, Job, RoutineSpot, SpotLook } from "../types.ts";
import { undoEntry } from "./changes.ts";
import { type Ctx, into } from "./context.ts";
import { bottomHead, bottomKnown, knownMarks, LABEL_REM, topKnown } from "./known.ts";
import { boardTurn, partShapes, readShowShape, shapeMarks } from "./partshape.ts";
import { armBox, type Calibration, machineToPicturePoints, type Mark, mountPicture, type PictureCrops, type PictureShown, type PictureView, type ShownSpot } from "./picture.ts";
import { TOP_TASKS, UP_TASKS, type CropBox } from "../crops.ts";
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

/**
 * The box drawn where the nozzle shows in the top camera's picture (shares
 * of its width and height), as marks over the picture `shown`: the box
 * and the word "nozzle" in its top left corner, one size on the screen.
 */
export function nozzleBoxMarks(box: [number, number, number, number] | null | undefined, shown: PictureShown): Mark[] {
    if (!box) {
        return [];
    }
    const [width, height] = shown.size;
    const [x0, y0, x1, y1] = [box[0] * width, box[1] * height, box[2] * width, box[3] * height];
    const font = shown.scale > 0 ? (LABEL_REM * shown.rem) / shown.scale : height / 40;
    return [
        { kind: "line", points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], closed: true, tone: "nozzle", title: "where the nozzle shows in the picture, as drawn" },
        { kind: "text", x: x0 + font / 3, y: y0 + font * 1.1, text: "nozzle", size: font, anchor: "start", tone: "nozzle" },
    ];
}

/** A box drawn on a picture of `size` px, as shares of its width and height within it, to hundred-thousandths; null for one with no width or height. */
export function boxShares(box: [number, number, number, number], size: [number, number]): [number, number, number, number] | null {
    const clamp = (value: number): number => Math.round(Math.max(0, Math.min(1, value)) * 100000) / 100000;
    const shares: [number, number, number, number] = [clamp(box[0] / size[0]), clamp(box[1] / size[1]), clamp(box[2] / size[0]), clamp(box[3] / size[1])];
    return shares[0] < shares[2] && shares[1] < shares[3] ? shares : null;
}

/** Where the page keeps the part class picked for the bottom camera's crop, by name. */
export const CROP_KEY = "spinny.pnp.crop";

/**
 * How far from the bottom camera's center a part is looked for, mm, and
 * why: the part class picked (`name`), else the G-code machine file's own
 * crop; null for pcbv's own reach, or with no G-code machine placing.
 */
export function partCrop(state: AppState, picked: string | null = readStored(CROP_KEY)): { mm: number; name: string | null } | null {
    if (!gcodePlacing(state)) {
        return null;
    }
    const document = state.placing?.document;
    const chosen = document?.classes?.find((entry) => entry.name === picked) ?? null;
    if (chosen) {
        return { mm: chosen.crop, name: chosen.name };
    }
    const crop = document?.crop ?? null;
    return crop !== null && crop > 0 ? { mm: crop, name: null } : null;
}

/** The radius a Look once at a part keeps to, px of the bottom camera's picture, from the crop picked; undefined without a crop or a scale. */
export function partLookRadius(state: AppState): number | undefined {
    const crop = partCrop(state);
    const calibration = bottomCalibration(state);
    return crop !== null && calibration !== null ? Math.round((crop.mm / calibration.mmPerPx) * 10) / 10 : undefined;
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

/**
 * A G-code machine camera's crops for its picture: the tasks of the
 * machine file's `section` ([up_camera] or [top_camera]), their boxes as the
 * placing state's document has them, the task the routine under way keeps
 * to, and a save that writes `[section.crops] task` into the file.
 */
export function machineCrops(
    ctx: Ctx,
    section: "up_camera" | "top_camera",
    tasks: readonly string[],
    boxes: (state: AppState) => Partial<Record<string, CropBox>> | undefined,
    routine: (state: AppState) => { state: string; crop?: { task: string } | null } | null | undefined,
): PictureCrops {
    return {
        tasks,
        boxes: (state) => (gcodePlacing(state) && state.placing?.document ? boxes(state) ?? {} : null),
        running: (state) => {
            const now = routine(state);
            return now?.state === "running" ? now.crop?.task ?? null : null;
        },
        save: async (task, box) => {
            const id = ctx.store.get().placing?.machine ?? null;
            if (id === null) {
                ctx.toast("info", "no G-code machine's file to write the crop into");
                return false;
            }
            const saved = await ctx.call(ctx.api.patchMachineFile(id, [section, "crops", task], box));
            if (saved === undefined) {
                return false;
            }
            ctx.toast("info", box === null ? `[${section}.crops] ${task} taken out of ${id}.toml` : `[${section}.crops] ${task} saved in ${id}.toml`);
            await ctx.refreshPlacing();
            // The Config tab's editor shows the file with the crop in it.
            await ctx.refreshMachines();
            return true;
        },
    };
}

export interface CameraViews {
    bottom: PictureView;
    top: PictureView;
}

export function mountCameraViews(roots: { bottom: HTMLElement; top: HTMLElement }, ctx: Ctx): CameraViews {
    // The pictures show while their page does.
    const visible = (): boolean => onShownPage(roots.bottom) && document.visibilityState !== "hidden";
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
            const crop = partCrop(state);
            const known = bottomKnown(state, gcode);
            return [
                ...reachMark(crop?.mm ?? null, bottomCalibration(state), size, crop?.name ? `parts of class ${crop.name} are looked for within this circle` : "parts are looked for within this circle"),
                ...knownMarks(known.points, known.center, bottomCalibration(state), shown),
            ];
        },
        spots: (state) => (state.pnp ? shownSpots(state.pnp.routine, state.pnp.look) : null),
        edges: () => ctx.api.cameraEdges("up"),
        // Fixed to the machine, the camera sees the nozzle: what it found moves with the head.
        follow: (state) => bottomHead(state, gcodePlacing(state)),
        applied: (state) => (state.pnp ? state.pnp.applied ?? null : undefined),
        undo: (id) => undoEntry(ctx, id),
        move: jog,
        noScale: "the bottom camera's scale is not measured yet: Center nozzle first",
        visible,
        crops: machineCrops(ctx, "up_camera", UP_TASKS, (state) => state.placing?.document?.camera_crops, (state) => state.pnp?.routine),
    }, ctx);
    const bottomEmpty = el("p", { class: "muted camera-view-empty" }, "The bottom camera is not running.");
    // The part class whose crop the picture rings and a Look once at a
    // part keeps to: the machine file's [[part_class]] tables.
    const cropPick = el("select", { class: "field", "aria-label": "Bottom camera crop" }) as HTMLSelectElement;
    cropPick.title = "the part class whose crop the picture rings and Look once at a part keeps to; a run looks at each part within its own class's crop";
    const cropField = labeled("Crop", cropPick, "labeled inline");
    cropPick.addEventListener("change", () => {
        writeStored(CROP_KEY, cropPick.value);
        bottom.render(ctx.store.get());
    });
    bottom.caption.append(cropField);
    let cropOptions = "";

    /** The crop list: the file's own crop, then each part class with its crop. */
    function renderCrop(state: AppState): void {
        const document = gcodePlacing(state) ? state.placing?.document ?? null : null;
        const classes = document?.classes ?? [];
        cropField.classList.toggle("hidden", classes.length === 0);
        const options = JSON.stringify([document?.crop ?? null, classes]);
        if (options !== cropOptions) {
            cropOptions = options;
            const own = document?.crop ? `file's crop, ${formatFixed(document.crop, 2)} mm` : "pcbv's own reach";
            cropPick.replaceChildren(
                el("option", { value: "" }, own),
                ...classes.map((entry) => el("option", { value: entry.name }, `${entry.name}, ${formatFixed(entry.crop, 2)} mm`)),
            );
        }
        cropPick.value = partCrop(state)?.name ?? "";
    }
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
                ...nozzleBoxMarks(topState?.nozzle_box, shown),
            ];
        },
        spots: (state) => (state.placing?.top ? shownSpots(state.placing.top.routine, state.placing.top.look) : null),
        edges: () => ctx.api.cameraEdges("top"),
        applied: (state) => (state.placing?.top ? state.placing.top.applied ?? null : undefined),
        undo: (id) => undoEntry(ctx, id),
        move: jog,
        noScale: "the top camera's scale is not measured yet: Measure offset first",
        visible: () => visible() && gcodePlacing(ctx.store.get()),
        boxes: true,
        crops: machineCrops(ctx, "top_camera", TOP_TASKS, (state) => state.placing?.document?.top?.crops, (state) => state.placing?.top?.routine),
    }, ctx);
    const topEmpty = el("p", { class: "muted camera-view-empty" }, "The top camera is not running.");
    // The nozzle's place in the top camera's picture, drawn by hand: the
    // nozzle rides on the head with the camera, so it stays put there.
    const nozzleBox = button("Nozzle box", () => armBox("top", "the nozzle", (box) => void keepNozzleBox(box)), "btn btn-quiet btn-small",
        "drag a box on the picture around where the nozzle generally shows; it stays drawn there, kept with the top camera");
    const clearNozzle = button("Clear nozzle box", () => into(ctx, "placing", ctx.api.topSettings({ clear: ["nozzle_box"] })), "btn btn-quiet btn-small",
        "forget the nozzle's box");
    top.caption.append(nozzleBox, clearNozzle);

    async function keepNozzleBox(box: [number, number, number, number]): Promise<void> {
        const topState = ctx.store.get().placing?.top;
        const size = frameSize(topState?.frame, topState?.size) ?? [1280, 720];
        const shares = boxShares(box, size);
        if (shares === null) {
            ctx.toast("info", "the box has no width or height inside the picture: drag across the nozzle");
            return;
        }
        await into(ctx, "placing", ctx.api.topSettings({ nozzle_box: shares }));
    }

    roots.top.append(
        el("div", { class: "panel-head" }, el("h2", {}, "Top camera view")),
        el("div", { class: "panel-body" },
            top.root,
            topEmpty,
            el("p", { class: "muted hint" }, "Drag the picture to move the head; double-click a point to bring it to the crosshair; Ctrl and the wheel zoom; Shift and a drag draw the box a board search keeps to; Nozzle box, then a drag, marks where the nozzle shows."),
        ),
    );

    function render(state: AppState): void {
        renderCrop(state);
        bottom.render(state);
        top.render(state);
        const topState = state.placing?.top;
        lockFor(nozzleBox, [topState?.running !== true, "start the top camera first"]);
        clearNozzle.classList.toggle("hidden", !topState?.nozzle_box);
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
