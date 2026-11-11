// The Camera panel: the picture from the camera on the head, refreshed
// while the panel shows and the camera runs, the pose pcbv reads off the
// board, the camera's settings (its device picked from the cameras found
// attached, or typed) and its measured values, the board it looks for, and
// the camera offset routine, which finds a mark made with the tool in the
// picture and centers the picture on it. The file is vision.ts: camera.ts
// is the 3D preview's camera.

import { askConfirm } from "../confirm.ts";
import { activePage, button, el, foldPanel, labeled, numberField, setLocked, Tracked } from "../dom.ts";
import { formatFixed, parseNumber } from "../format.ts";
import { isMilling } from "../profile.ts";
import { setPending, type AppState } from "../state.ts";
import type { CameraFinish, CameraSettings, CameraSide, CameraState } from "../types.ts";
import { mountCameraPick } from "./camerapick.ts";
import { mountCameraLog } from "./camlog.ts";
import { into, type Ctx } from "./context.ts";

/**
 * How often a camera's picture is asked for while it shows, ms, and the
 * width it is asked at, pixels: the head camera's here, and the up and top
 * cameras' on the PNP page.
 */
export const FRAME_INTERVAL_MS = 250;
export const FRAME_WIDTH = 640;
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
        return "finding mark";
    }
    return state.pose?.state === "locked" ? "locked" : "running";
}

export interface VisionPanel {
    /** Stops the polling; for tests, which mount and leave. */
    stop(): void;
}

export function mountVision(root: HTMLElement, ctx: Ctx): VisionPanel {
    const badge = el("span", { class: "badge vision-badge" }, "stopped");
    const picture = el("img", { class: "vision-picture", alt: "Camera picture with a center crosshair" }) as HTMLImageElement;
    const pictureBox = el("div", { class: "vision-picture-box" }, picture);
    const overlay = button("Overlay", () => showOverlay(!overlayOn), "btn btn-quiet btn-small btn-toggle");
    overlay.title = "draw the spots and the pose on the picture";
    let overlayOn = true;
    const showOverlay = (on: boolean): void => {
        overlayOn = on;
        overlay.setAttribute("aria-pressed", on ? "true" : "false");
        refreshFrame(true);
    };
    const poseLine = el("p", { class: "muted vision-pose" }, poseText(null));
    const start = button("Start", () => startCamera(), "btn btn-primary");
    start.title = "start the camera with these settings";
    const stop = button("Stop", () => into(ctx, "camera", ctx.api.cameraStop()), "btn");

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
        otherLabel: "up camera",
        otherDevice: (state) => state.pnp?.device ?? null,
        visible: () => visible(),
    });
    const applySettings = button("Apply", () => apply(), "btn");
    const applyMeasured = button("Apply", () => apply(), "btn");
    // How many settings fields are typed in and not applied, beside each Apply.
    const pendingChips = [
        el("span", { class: "badge apply-state hidden", "data-apply": "pending" }),
        el("span", { class: "badge apply-state hidden", "data-apply": "pending" }),
    ];

    const lookButton = button("Look for board", () => lookForBoard(), "btn");
    const unloadButton = button("Unload", () => into(ctx, "camera", ctx.api.cameraBoard(null)), "btn btn-quiet");
    const boardNote = el("span", { class: "muted" });

    // The camera offset routine: a mark made with the tool, found in the
    // picture, and the picture's center put on it.
    const depth = numberField({ value: 0.1, min: 0.01, max: 5, step: 0.05, width: "5.5rem" });
    const plunge = numberField({ value: 30, min: 1, max: 1000, step: 5, width: "5.5rem" });
    const markButton = button("Make mark", () => makeMark(), "btn btn-danger");
    const hereButton = button("Mark is here", () => into(ctx, "camera", ctx.api.cameraMark({ here: true })), "btn");
    const step = numberField({ value: 2, min: 0, max: 20, step: 0.5, width: "5rem" });
    const findButton = button("Find mark", () => findMark(), "btn btn-primary");
    const abortButton = button("Abort", () => into(ctx, "camera", ctx.api.cameraAbort()), "btn btn-danger");
    const routineLine = el("p", { class: "muted vision-routine" });
    const markNote = el("span", { class: "muted" });

    // The pictures the find routine looked at, and photos taken by hand.
    const logBox = el("div", { class: "camlog-box" });
    mountCameraLog(logBox, ctx, "head");
    const body = el("fieldset", { class: "panel-body" },
        pictureBox,
        el("div", { class: "button-row" }, start, stop, overlay, poseLine),
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
        el("div", { class: "field-grid" },
            labeled("Offset x mm", offsetX),
            labeled("Offset y mm", offsetY),
            labeled("Roll deg", roll),
            labeled("mm per px", scale),
        ),
        el("div", { class: "button-row" }, applyMeasured, pendingChips[1], el("span", { class: "muted" }, "set by Find mark; copy them into the machine file to keep them")),
        el("div", { class: "button-row" }, lookButton, unloadButton, boardNote),
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
    // Unfolded, the picture is asked for at once rather than at the next tick.
    const fold = foldPanel("spinny.camera.open", el("summary", { class: "panel-head" }, el("h2", {}, "Camera"), badge), body, () => refreshFrame(true));
    root.append(fold);

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

    async function lookForBoard(): Promise<void> {
        const job = ctx.store.get().job;
        if (!job) {
            ctx.toast("error", "select a job first");
            return;
        }
        await into(ctx, "camera", ctx.api.cameraBoard(job.id));
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

    let lastFrame = 0;
    function refreshFrame(force = false): void {
        const camera = ctx.store.get().camera;
        if (!visible() || !camera?.running) {
            return;
        }
        const now = Date.now();
        if (!force && now - lastFrame < FRAME_INTERVAL_MS - 10) {
            return;
        }
        lastFrame = now;
        picture.src = ctx.api.cameraFrameUrl(FRAME_WIDTH, overlayOn);
    }

    // The pose is read when the state is asked for: polled while the panel
    // shows, straight from the API so a backend gone quiet is not a toast
    // three times a second.
    async function poll(): Promise<void> {
        if (!visible()) {
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
    const frameTimer = setInterval(() => refreshFrame(), FRAME_INTERVAL_MS);

    function render(state: AppState): void {
        const camera = state.camera;
        const connected = state.snapshot.connected;
        const running = camera?.running ?? false;
        const finding = camera?.routine?.state === "running";
        const idle = state.snapshot.machine?.state === "Idle";
        badge.textContent = cameraBadge(camera);
        badge.setAttribute("data-camera", cameraBadge(camera));
        poseLine.textContent = poseText(camera);
        routineLine.textContent = routineText(camera);
        pictureBox.classList.toggle("hidden", !running);
        if (!running) {
            picture.removeAttribute("src");
        }
        setLocked(start, running);
        setLocked(stop, !running || finding);
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
        const job = state.job;
        const hasBoard = job?.design?.board === true;
        setLocked(lookButton, !job || !hasBoard || finding);
        lookButton.title = job && !hasBoard ? "the camera needs a job uploaded as .kicad_pcb" : "";
        setLocked(unloadButton, !camera?.board || finding);
        const looking = camera?.board ? state.jobs.find((entry) => entry.id === camera.board)?.name ?? camera.board : null;
        boardNote.textContent = looking ? `looking for ${looking}` : "no board loaded";
        const milling = isMilling(state.snapshot);
        const busy = !connected || !idle || finding;
        setLocked(markButton, busy || !milling || !state.snapshot.profile?.h_axis);
        markButton.title = milling ? "" : "needs a spindle; use Mark is here over a mark made by hand";
        setLocked(hereButton, busy);
        setLocked(findButton, busy || !running || !camera?.mark);
        setLocked(abortButton, !finding);
        markNote.textContent = camera?.mark ? `mark at X ${formatFixed(camera.mark[0], 3)} Y ${formatFixed(camera.mark[1], 3)}` : "no mark recorded";
        refreshFrame();
    }

    ctx.store.subscribe((state) => render(state), ["camera", "snapshot", "job", "jobs"]);
    showOverlay(true);
    render(ctx.store.get());
    return {
        stop() {
            clearInterval(pollTimer);
            clearInterval(frameTimer);
            pick.stop();
        },
    };
}
