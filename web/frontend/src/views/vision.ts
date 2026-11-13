// The Camera panel: the camera on the head's settings (its device picked
// from the cameras found attached, or typed), its picture controls and
// measured values, the pose pcbv reads off the board, and the camera offset
// routine, which finds a mark made with the tool in the picture and centers
// the picture on it. The look for a board and its search are the Find
// board panel's (findboard.ts).
// Its picture is a panel of its own (Camera view), refreshed while it
// shows and the camera runs, with the routine's spot, the search box, the
// board where the looks put it and the points whose place is known
// (known.ts) drawn over it. The file is vision.ts:
// camera.ts is the 3D preview's camera.

import { askConfirm } from "../confirm.ts";
import { activePage, button, el, foldPanel, labeled, lockFor, numberField, setLocked, Tracked } from "../dom.ts";
import { formatFixed, formatPercent, parseNumber } from "../format.ts";
import { isMilling } from "../profile.ts";
import { setPending, type AppState } from "../state.ts";
import type { BoardLook, CameraFinish, CameraSettings, CameraSide, CameraState } from "../types.ts";
import { mountCameraControls, placeFolds, type CameraFolds } from "./cameracontrols.ts";
import { mountCameraSight } from "./camerasight.ts";
import { mountCameraPick } from "./camerapick.ts";
import { mountCameraLog } from "./camlog.ts";
import { boardMarks, foundMarks, frameSize, roughOf } from "./camview.ts";
import { into, type Ctx } from "./context.ts";
import { headKnown, knownMarks } from "./known.ts";
import { type Calibration, mountPicture, type PictureView } from "./picture.ts";

export { FRAME_INTERVAL_MS } from "./picture.ts";
/** How often this panel asks for the camera's state while it shows, ms. */
export const POLL_INTERVAL_MS = 333;

/** One line on the pose: the camera's state, where the picture's center is, the board's angle, the fit and the rate. */
export function poseText(state: CameraState | null): string {
    if (!state) {
        return "no camera state yet";
    }
    if (!state.running) {
        return "camera stopped";
    }
    const pose = state.pose;
    if (!pose || pose.state === null) {
        return "camera running, no pose yet";
    }
    if (pose.state === "none") {
        return "camera running, no board loaded";
    }
    const fps = pose.fps !== null && pose.fps !== undefined ? `, ${formatFixed(pose.fps, 1)} fps` : "";
    if (pose.state !== "locked") {
        const spots = pose.spots !== null && pose.spots !== undefined ? `, ${pose.spots} spots` : "";
        return `${pose.state}${spots}${fps}`;
    }
    const center = pose.center ? `center ${formatFixed(pose.center[0], 3)}, ${formatFixed(pose.center[1], 3)}` : "center unknown";
    const job = pose.job_center ? ` (job frame ${formatFixed(pose.job_center[0], 3)}, ${formatFixed(pose.job_center[1], 3)})` : "";
    return `locked: ${center}${job}, angle ${formatFixed(pose.angle_deg, 3)} deg, rms ${formatFixed(pose.rms_mm, 3)} mm,`
        + ` ${pose.inliers ?? 0} of ${pose.expected ?? 0} inliers${fps}`;
}

/** What the routine's progress line says; empty before any routine. */
export function routineText(state: CameraState | null): string {
    const routine = state?.routine;
    if (!routine) {
        return "";
    }
    const spot = routine.spot ? `, spot ${formatFixed(routine.spot.mm, 3)} mm off the center (${routine.spot.dx}, ${routine.spot.dy} px)` : "";
    const error = routine.error ? `: ${routine.error}` : "";
    return `${routine.state}: ${routine.step}, ${routine.done} of ${routine.total}${spot}${error}`;
}

/** The badge in the panel's head. */
export function cameraBadge(state: CameraState | null): string {
    if (!state || !state.running) {
        return "stopped";
    }
    if (state.routine?.state === "running") {
        return state.routine.kind === "search" ? "searching" : "finding mark";
    }
    if (state.board_look?.found) {
        return "found";
    }
    if (state.pose?.state === "locked") {
        return "locked";
    }
    return state.board ? "looking" : "running";
}

/**
 * One line on a camera's look for a board: how many looks agree on the most
 * likely guess of how many needed, its share of the evidence against the
 * threshold, how far apart its looks lie, and where it puts the board; or
 * why the newest pose was not used. Empty with no board loaded.
 */
export function lookText(look: BoardLook | null | undefined, name: string | null = null): string {
    if (!look || look.job === null) {
        return "";
    }
    const what = name ?? look.job;
    const need = look.need ?? 5;
    const spread = look.spread_mm !== null && look.spread_mm !== undefined && look.spread_deg !== null && look.spread_deg !== undefined
        ? ` within ${formatFixed(look.spread_mm, 2)} mm and ${formatFixed(look.spread_deg, 2)} deg`
        : "";
    const estimate = look.estimate;
    const place = estimate ? `; middle at ${formatFixed(estimate.center[0], 2)}, ${formatFixed(estimate.center[1], 2)}, turned ${formatFixed(estimate.rotation, 2)} deg` : "";
    const lead = look.guesses?.[0];
    const share = lead && !lead.ruled_out ? `, ${formatPercent(lead.probability)} of the evidence` : "";
    const locks = look.sessions !== undefined && look.sessions_needed !== undefined
        ? ` from ${look.sessions} of ${look.sessions_needed} independent locks${look.rechecking ? ", looking afresh for another" : ""}`
        : "";
    const ambiguous = ambiguityText(look);
    if (look.found) {
        return `${what} found: ${look.agree ?? need} looks agree${locks}${spread}${share}${place}${ambiguous}`;
    }
    const needs = look.threshold !== undefined && share !== "" ? ` (needs ${formatPercent(look.threshold)})` : "";
    const pose = look.pose ? look.pose : "no pose yet";
    const why = look.problem ? ` (${look.problem})` : "";
    return `looking for ${what}: ${look.agree ?? 0} of ${need} looks agree${locks}${share}${needs}, ${look.locked ?? 0} of ${look.looks ?? 0} locked, now ${pose}${why}${place}${ambiguous}`;
}

/** What the look says of a rival place: the share of a look's evidence another place pcbv checked held, when it makes the place ambiguous; empty otherwise. */
export function ambiguityText(look: BoardLook | null | undefined): string {
    if (!look?.ambiguous || look.rival === null || look.rival === undefined) {
        return "";
    }
    return `; AMBIGUOUS: another place fit ${formatPercent(look.rival)} as well (a repeated or symmetric pattern): check it from elsewhere on the board`;
}

/** The head camera's calibration, once its scale is measured: its roll from board +X, never mirrored. */
function headCalibration(state: AppState): Calibration | null {
    const camera = state.camera;
    return camera && camera.mm_per_px > 0 ? { mmPerPx: camera.mm_per_px, roll: camera.roll, mirror: false } : null;
}

/** The board point under the head camera's picture's center: the tool's point plus the offset. */
function headCenter(state: AppState): [number, number] | null {
    const board = state.snapshot.connected ? state.snapshot.machine?.board ?? null : null;
    const offset = state.camera?.offset;
    return board && offset ? [board.x + offset[0], board.y + offset[1]] : null;
}

/** The head camera's picture as a panel of its own, with the pose and the look under it. */
export function mountVisionView(root: HTMLElement, ctx: Ctx, visible: () => boolean): PictureView {
    const picture = mountPicture({
        key: "head",
        label: "Head camera",
        rides: true,
        running: (state) => state.camera?.running === true,
        frameUrl: (width, overlay) => ctx.api.cameraFrameUrl(width, overlay),
        pcbvOverlay: (state) => (state.camera?.board ?? null) !== null,
        size: (state) => frameSize(state.camera?.frame, state.camera?.size),
        calibration: headCalibration,
        center: headCenter,
        marks: (state, shown) => {
            const camera = state.camera;
            const size = frameSize(camera?.frame, camera?.size) ?? [1280, 720];
            const look = camera?.board_look;
            const job = look?.job && state.job?.id === look.job ? state.job : null;
            return [
                ...foundMarks(camera?.routine, null, size),
                ...boardMarks(state.job, roughOf(state.job, look?.corners), headCenter(state), headCalibration(state), size, "rough"),
                ...boardMarks(job, look?.estimate ?? null, headCenter(state), headCalibration(state), size),
                ...knownMarks(headKnown(state), headCenter(state), headCalibration(state), shown),
            ];
        },
        move: async (mm) => {
            if (Math.hypot(mm[0], mm[1]) >= 0.001) {
                await ctx.call(ctx.api.jog({ kind: "board", dx: Number(mm[0].toFixed(4)), dy: Number(mm[1].toFixed(4)) }));
            }
        },
        noScale: "the camera's scale is not measured yet: Find mark first",
        visible,
        boxes: true,
    }, ctx);
    const empty = el("p", { class: "muted camera-view-empty" }, "The camera is not running: start it in the Camera panel.");
    const lookLine = el("p", { class: "muted vision-look" });
    root.append(
        el("div", { class: "panel-head" }, el("h2", {}, "Camera view")),
        el("div", { class: "panel-body" },
            picture.root,
            empty,
            lookLine,
            el("p", { class: "muted hint" }, "Drag the picture to move the head; double-click a point to bring it to the crosshair; Ctrl and the wheel zoom; Shift and a drag draw the box a board search keeps to."),
        ),
    );
    ctx.store.subscribe((state) => {
        picture.render(state);
        empty.classList.toggle("hidden", state.camera?.running === true);
        const look = state.camera?.board_look;
        lookLine.textContent = lookText(look, look?.job ? state.jobs.find((entry) => entry.id === look.job)?.name ?? null : null);
        lookLine.classList.toggle("hidden", lookLine.textContent === "");
    }, ["camera", "snapshot", "job", "jobs", "align", "components", "markers"]);
    picture.render(ctx.store.get());
    return picture;
}

export interface VisionPanel {
    /** The head camera's picture, with the search box drawn on it. */
    view: PictureView;
    /** Stops the polling; for tests, which mount and leave. */
    stop(): void;
}

/**
 * The Camera panel in `root`, and its picture in `viewRoot` (the Camera
 * view panel); without one the picture goes in a box of its own appended
 * to `root`. The picture controls and the lens and colors folds are panels
 * of their own in `folds` (stacked with this one by the markup); without
 * them they fold inside this panel.
 */
export function mountVision(root: HTMLElement, ctx: Ctx, viewRoot?: HTMLElement, folds?: CameraFolds): VisionPanel {
    const badge = el("span", { class: "badge vision-badge" }, "stopped");
    const pictureRoot = viewRoot ?? el("div", { class: "stack" });
    // The fold, once made: the picture asks whether it is open.
    let folded: HTMLDetailsElement | null = null;
    const view = mountVisionView(pictureRoot, ctx, () => visibleView());
    const poseLine = el("p", { class: "muted vision-pose" }, poseText(null));
    const start = button("Start", () => startCamera(), "btn btn-primary");
    start.title = "start the camera with these settings";
    const stop = button("Stop", () => into(ctx, "camera", ctx.api.cameraStop()), "btn", "stop the camera");
    stop.title = "stop the camera";

    // The settings: what the camera is read with, and how it sits against
    // the tool, which the routine below measures and Apply writes back.
    const device = el("input", { type: "text", class: "field", "aria-label": "Camera device", spellcheck: "false" }) as HTMLInputElement;
    const size = el("input", { type: "text", class: "field", "aria-label": "Camera size", placeholder: "1280x720", spellcheck: "false" }) as HTMLInputElement;
    const fps = numberField({ min: 1, max: 120, step: 1, width: "5rem" });
    fps.setAttribute("aria-label", "Camera fps");
    const side = el("select", { class: "field", "aria-label": "Camera side" }, el("option", { value: "front" }, "front"), el("option", { value: "back" }, "back")) as HTMLSelectElement;
    const finish = el("select", { class: "field", "aria-label": "Board finish" }, el("option", { value: "masked" }, "masked"), el("option", { value: "bare" }, "bare")) as HTMLSelectElement;
    const offsetX = numberField({ step: 0.01, width: "6rem" });
    offsetX.setAttribute("aria-label", "Camera offset x");
    const offsetY = numberField({ step: 0.01, width: "6rem" });
    offsetY.setAttribute("aria-label", "Camera offset y");
    const roll = numberField({ step: 0.01, width: "6rem" });
    roll.setAttribute("aria-label", "Camera roll");
    const scale = numberField({ min: 0, step: 0.001, width: "6rem" });
    scale.setAttribute("aria-label", "Camera mm per px");
    const pick = mountCameraPick(ctx, {
        device,
        size,
        fps,
        otherLabel: "bottom camera",
        otherDevice: (state) => state.pnp?.device ?? null,
        visible: () => visible(),
    });
    const applySettings = button("Apply", () => apply(), "btn", "use these camera settings");
    const applyMeasured = button("Apply", () => apply(), "btn", "use these values");
    // How many settings fields are typed in and not applied, beside each Apply.
    const pendingChips = [
        el("span", { class: "badge apply-state hidden", "data-apply": "pending" }),
        el("span", { class: "badge apply-state hidden", "data-apply": "pending" }),
    ];

    const controls = mountCameraControls(ctx, "head", "the head camera");
    const sight = mountCameraSight(ctx, { camera: "head", label: "the head camera", settings: (state) => state.camera ?? null, running: (state) => state.camera?.running === true });

    // The camera offset routine: a mark made with the tool, found in the
    // picture, and the picture's center put on it.
    const depth = numberField({ value: 0.1, min: 0.01, max: 5, step: 0.05, width: "5.5rem" });
    const plunge = numberField({ value: 30, min: 1, max: 1000, step: 5, width: "5.5rem" });
    const markButton = button("Make mark", () => makeMark(), "btn btn-danger");
    const hereButton = button("Mark is here", () => into(ctx, "camera", ctx.api.cameraMark({ here: true })), "btn");
    const step = numberField({ value: 2, min: 0, max: 20, step: 0.5, width: "5rem" });
    const findButton = button("Find mark", () => findMark(), "btn btn-primary");
    findButton.title = "lift the head, center the camera on the mark and measure the offset, scale and roll";
    const abortButton = button("Abort", () => into(ctx, "camera", ctx.api.cameraAbort()), "btn btn-danger");
    abortButton.title = "stop the camera's routine (Find mark or Search)";
    markButton.title = "drill a mark at the tool to measure the camera against";
    hereButton.title = "a mark or a hole is under the tool already: keep the tool's point as the mark";
    const routineLine = el("p", { class: "muted vision-routine" });
    const markNote = el("span", { class: "muted" });

    // The pictures the find routine looked at, and photos taken by hand.
    const logBox = el("div", { class: "camlog-box" });
    mountCameraLog(logBox, ctx, "head");
    const body = el("fieldset", { class: "panel-body" },
        ...(viewRoot ? [] : [pictureRoot]),
        el("div", { class: "button-row" }, start, stop, poseLine),
        pick.row,
        pick.note,
        el("div", { class: "field-grid" },
            labeled("Device", device),
            labeled("Size", size),
            labeled("fps", fps),
            labeled("Side", side),
            labeled("Finish", finish),
        ),
        el("div", { class: "button-row" }, applySettings, pendingChips[0]),
        ...placeFolds(folds, "head", controls.root, sight.root),
        el("div", { class: "field-grid" },
            labeled("Offset x mm", offsetX),
            labeled("Offset y mm", offsetY),
            labeled("Roll deg", roll),
            labeled("mm per px", scale),
        ),
        el("div", { class: "button-row" }, applyMeasured, pendingChips[1], el("span", { class: "muted" }, "set by Find mark; copy them into the machine file to keep them")),
        el("div", { class: "button-row" },
            labeled("Depth mm", depth, "labeled inline"),
            labeled("Plunge mm/min", plunge, "labeled inline"),
            markButton,
            hereButton,
            markNote,
        ),
        el("div", { class: "button-row" },
            labeled("Step mm", step, "labeled inline"),
            findButton,
            abortButton,
        ),
        routineLine,
        logBox,
        el("p", { class: "muted hint" },
            "Make mark drills a mark at the tool; Mark is here uses a mark or hole already under it."
            + " Find mark lifts the head, centers the camera on the mark and measures the offset, scale and roll."),
    );
    // Unfolded, the picture (when it is in this panel) is asked for at once rather than at the next tick.
    const fold = foldPanel("spinny.camera.open", el("summary", { class: "panel-head" }, el("h2", {}, "Camera"), badge), body, () => view.refresh(true));
    root.append(fold);
    folded = fold;

    // The settings fields follow the state until typed in.
    const settingsFields = new Tracked([device, size, fps, side, finish], () => showPending());
    const measuredFields = new Tracked([offsetX, offsetY, roll, scale], () => showPending());
    /** Marks the fields typed in and not applied, and counts them for the chips and the page's tab. */
    const showPending = (): void => {
        const counts = [settingsFields.edited(), measuredFields.edited()];
        counts.forEach((count, index) => {
            const chip = pendingChips[index]!;
            chip.classList.toggle("hidden", count === 0);
            chip.textContent = `${count} not applied`;
            chip.title = "marked fields are not sent yet; press Apply";
        });
        setPending(ctx.store, "camera", counts[0]! + counts[1]!);
    };

    /** The settings fields that differ from the state: what the camera is read with. */
    function settingsPatch(current: CameraState | null): Partial<CameraSettings> {
        const patch: Partial<CameraSettings> = {};
        const text = (field: HTMLInputElement, key: "device" | "size"): void => {
            const value = field.value.trim();
            if (value !== "" && value !== current?.[key]) {
                patch[key] = value;
            }
        };
        text(device, "device");
        text(size, "size");
        const frames = parseNumber(fps.value);
        if (frames !== null && frames !== current?.fps) {
            patch.fps = frames;
        }
        if (side.value !== current?.side) {
            patch.side = side.value as CameraSide;
        }
        if (finish.value !== current?.finish) {
            patch.finish = finish.value as CameraFinish;
        }
        return patch;
    }

    /** Starts the camera on what the fields show: settings picked or typed and not applied go first. */
    async function startCamera(): Promise<void> {
        const patch = settingsPatch(ctx.store.get().camera);
        if (Object.keys(patch).length > 0) {
            const state = await ctx.call(ctx.api.cameraSettings(patch));
            if (!state) {
                return;
            }
            ctx.store.set({ camera: state });
        }
        await into(ctx, "camera", ctx.api.cameraStart());
    }

    async function apply(): Promise<void> {
        const current = ctx.store.get().camera;
        const patch = settingsPatch(current);
        const ox = parseNumber(offsetX.value);
        const oy = parseNumber(offsetY.value);
        if (ox !== null && oy !== null && (ox !== current?.offset[0] || oy !== current?.offset[1])) {
            patch.offset = [ox, oy];
        }
        const rollValue = parseNumber(roll.value);
        if (rollValue !== null && rollValue !== current?.roll) {
            patch.roll = rollValue;
        }
        const scaleValue = parseNumber(scale.value);
        if (scaleValue !== null && scaleValue !== current?.mm_per_px) {
            patch.mm_per_px = scaleValue;
        }
        if (Object.keys(patch).length === 0) {
            ctx.toast("info", "nothing changed");
            return;
        }
        await into(ctx, "camera", ctx.api.cameraSettings(patch));
    }

    async function makeMark(): Promise<void> {
        const d = parseNumber(depth.value);
        const p = parseNumber(plunge.value);
        if (d === null || p === null) {
            ctx.toast("error", "enter the mark's depth and plunge rate");
            return;
        }
        const ok = await askConfirm(
            `Drill a ${d} mm deep mark at the tool, at ${p} mm/min? The spindle starts and cuts the board.`,
            "Make mark",
        );
        if (!ok) {
            return;
        }
        await into(ctx, "camera", ctx.api.cameraMark({ depth: d, plunge: p }));
    }

    async function findMark(): Promise<void> {
        const s = parseNumber(step.value);
        if (s === null || s < 0) {
            ctx.toast("error", "step: 0 mm or more");
            return;
        }
        await into(ctx, "camera", ctx.api.cameraFind(s));
    }

    /** The panel is in view: the Jobs page is up, the fold open and the tab shown. */
    function visible(): boolean {
        return fold.open && activePage() === "jobs" && document.visibilityState !== "hidden";
    }

    /** The picture is in view: on the Jobs page in its own panel, or in this one while it is open. */
    function visibleView(): boolean {
        if (activePage() !== "jobs" || document.visibilityState === "hidden") {
            return false;
        }
        return viewRoot ? !viewRoot.hasAttribute("data-collapsed") && !viewRoot.classList.contains("hidden") : folded?.open === true;
    }

    // The pose is read when the state is asked for: polled while the panel
    // or the picture shows, straight from the API so a backend gone quiet
    // is not a toast three times a second.
    async function poll(): Promise<void> {
        if (!visible() && !visibleView()) {
            return;
        }
        try {
            const state = await ctx.api.camera();
            ctx.store.set({ camera: state });
        } catch {
            // The next poll tries again; the event feed carries the changes.
        }
    }
    const pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);

    function render(state: AppState): void {
        sight.render(state);
        const camera = state.camera;
        const connected = state.snapshot.connected;
        const running = camera?.running ?? false;
        const finding = camera?.routine?.state === "running";
        const idle = state.snapshot.machine?.state === "Idle";
        badge.textContent = cameraBadge(camera);
        badge.setAttribute("data-camera", cameraBadge(camera));
        poseLine.textContent = poseText(camera);
        routineLine.textContent = routineText(camera);
        setLocked(start, running, "the camera is running");
        lockFor(stop, [!running, "the camera is not running"], [finding, "a routine is under way: abort it first"]);
        if (camera) {
            settingsFields.follow(device, camera.device);
            settingsFields.follow(size, camera.size);
            settingsFields.follow(fps, String(camera.fps));
            settingsFields.follow(side, camera.side);
            settingsFields.follow(finish, camera.finish);
            measuredFields.follow(offsetX, String(camera.offset[0]));
            measuredFields.follow(offsetY, String(camera.offset[1]));
            measuredFields.follow(roll, String(camera.roll));
            measuredFields.follow(scale, String(camera.mm_per_px));
        }
        pick.render();
        showPending();
        const milling = isMilling(state.snapshot);
        const busy = !connected || !idle || finding;
        setLocked(markButton, busy || !milling || !state.snapshot.profile?.h_axis);
        markButton.title = milling ? "" : "needs a spindle; use Mark is here over a mark made by hand";
        setLocked(hereButton, busy);
        lockFor(findButton, [busy, "the machine must be connected, Idle and free"], [!running, "start the camera first"], [!camera?.mark, "no mark recorded: Make mark or Mark is here first"]);
        setLocked(abortButton, !finding, "no routine under way");
        markNote.textContent = camera?.mark ? `mark at X ${formatFixed(camera.mark[0], 3)} Y ${formatFixed(camera.mark[1], 3)}` : "no mark recorded";
    }

    ctx.store.subscribe((state) => render(state), ["camera", "snapshot", "job", "jobs"]);
    render(ctx.store.get());
    return {
        view,
        stop() {
            clearInterval(pollTimer);
            view.stop();
            pick.stop();
        },
    };
}
