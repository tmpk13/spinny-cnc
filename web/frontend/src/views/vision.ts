// The Camera panel: the picture from the camera on the head, refreshed
// while the panel shows and the camera runs, the pose pcbv reads off the
// board, the camera's settings and its measured values, the board it
// looks for, and the camera offset routine, which finds a mark made with
// the tool in the picture and centers the picture on it. The file is
// vision.ts: camera.ts is the 3D preview's camera.

import { askConfirm } from "../confirm.ts";
import { activePage, button, el, labeled, numberField, setLocked } from "../dom.ts";
import { formatFixed, parseNumber } from "../format.ts";
import { isMilling } from "../profile.ts";
import type { AppState } from "../state.ts";
import type { CameraFinish, CameraSettings, CameraSide, CameraState } from "../types.ts";
import type { Ctx } from "./context.ts";

/** How often the picture is asked for while it shows, and the state polled. */
export const FRAME_INTERVAL_MS = 250;
export const POLL_INTERVAL_MS = 333;
/** The width the picture is asked at, pixels. */
export const FRAME_WIDTH = 640;

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

// Whether the panel is folded is a per-browser convenience; storage that is
// blocked or empty leaves the panel open.
const FOLD_KEY = "spinny.camera.open";

function readFoldOpen(): boolean {
    try {
        return globalThis.localStorage?.getItem(FOLD_KEY) !== "0";
    } catch {
        return true;
    }
}

function writeFoldOpen(open: boolean): void {
    try {
        globalThis.localStorage?.setItem(FOLD_KEY, open ? "1" : "0");
    } catch {
        // Not remembered; the panel still folds.
    }
}

export interface VisionPanel {
    /** Stops the polling; for tests, which mount and leave. */
    stop(): void;
}

export function mountVision(root: HTMLElement, ctx: Ctx): VisionPanel {
    const badge = el("span", { class: "badge vision-badge" }, "stopped");
    const picture = el("img", { class: "vision-picture", alt: "The camera's picture, with a crosshair at its center" }) as HTMLImageElement;
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
    const start = button("Start", () => act(ctx.api.cameraStart()), "btn btn-primary");
    const stop = button("Stop", () => act(ctx.api.cameraStop()), "btn");

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
    const applySettings = button("Apply", () => apply(), "btn");
    const applyMeasured = button("Apply", () => apply(), "btn");

    const lookButton = button("Look for board", () => lookForBoard(), "btn");
    const unloadButton = button("Unload", () => act(ctx.api.cameraBoard(null)), "btn btn-quiet");
    const boardNote = el("span", { class: "muted" });

    // The camera offset routine: a mark made with the tool, found in the
    // picture, and the picture's center put on it.
    const depth = numberField({ value: 0.1, min: 0.01, max: 5, step: 0.05, width: "5.5rem" });
    const plunge = numberField({ value: 30, min: 1, max: 1000, step: 5, width: "5.5rem" });
    const markButton = button("Make mark", () => makeMark(), "btn btn-danger");
    const hereButton = button("Mark is here", () => act(ctx.api.cameraMark({ here: true })), "btn");
    const step = numberField({ value: 2, min: 0, max: 20, step: 0.5, width: "5rem" });
    const findButton = button("Find mark", () => findMark(), "btn btn-primary");
    const abortButton = button("Abort", () => act(ctx.api.cameraAbort()), "btn btn-danger");
    const routineLine = el("p", { class: "muted vision-routine" });
    const markNote = el("span", { class: "muted" });

    const body = el("fieldset", { class: "panel-body" },
        pictureBox,
        el("div", { class: "button-row" }, start, stop, overlay, poseLine),
        el("div", { class: "field-grid" },
            labeled("Device", device),
            labeled("Size", size),
            labeled("fps", fps),
            labeled("Side", side),
            labeled("Finish", finish),
        ),
        el("div", { class: "button-row" }, applySettings),
        el("div", { class: "field-grid" },
            labeled("Offset x mm", offsetX),
            labeled("Offset y mm", offsetY),
            labeled("Roll deg", roll),
            labeled("mm per px", scale),
        ),
        el("div", { class: "button-row" }, applyMeasured, el("span", { class: "muted" }, "the measured values: what the routine below finds, kept in the backend's settings; write them into the machine file to keep them")),
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
        el("p", { class: "muted hint" },
            "Make mark drills a point with the tool where it stands (a spindle machine); Mark is here records the tool's point over a mark"
            + " made by hand or a hole. Find mark lifts the head, goes where the camera should see the mark, moves the step along X to"
            + " measure the scale and the roll, and centers the picture on the mark: the offset is the mark less the tool's point."),
    );
    const fold = el("details", { class: "panel-fold", open: readFoldOpen() },
        el("summary", { class: "panel-head" }, el("h2", {}, "Camera"), badge),
        body,
    );
    fold.addEventListener("toggle", () => {
        writeFoldOpen(fold.open);
        refreshFrame(true);
    });
    root.append(fold);

    // The settings fields follow the state until typed in; what each was
    // last given is kept so a field still showing it follows the next.
    const shown = new Map<HTMLInputElement | HTMLSelectElement, string>();
    const follow = (field: HTMLInputElement | HTMLSelectElement, value: string): void => {
        const untouched = !shown.has(field) || field.value === shown.get(field);
        if (untouched && field !== document.activeElement) {
            field.value = value;
        }
        shown.set(field, value);
    };

    /** A camera request; its answer is the state, which goes into the store. */
    async function act(promise: Promise<CameraState>): Promise<void> {
        const state = await ctx.call(promise);
        if (state) {
            ctx.store.set({ camera: state });
        }
    }

    async function apply(): Promise<void> {
        const current = ctx.store.get().camera;
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
        await act(ctx.api.cameraSettings(patch));
    }

    async function lookForBoard(): Promise<void> {
        const job = ctx.store.get().job;
        if (!job) {
            ctx.toast("error", "select a job whose board the camera should look for");
            return;
        }
        await act(ctx.api.cameraBoard(job.id));
    }

    async function makeMark(): Promise<void> {
        const d = parseNumber(depth.value);
        const p = parseNumber(plunge.value);
        if (d === null || p === null) {
            ctx.toast("error", "enter the mark's depth and plunge rate");
            return;
        }
        const ok = await askConfirm(
            `Drill a mark ${d} mm deep where the tool stands, at ${p} mm/min? The spindle starts and cuts the board there.`,
            "Make mark",
        );
        if (!ok) {
            return;
        }
        await act(ctx.api.cameraMark({ depth: d, plunge: p }));
    }

    async function findMark(): Promise<void> {
        const s = parseNumber(step.value);
        if (s === null || s < 0) {
            ctx.toast("error", "the step is a distance in mm, 0 or more");
            return;
        }
        await act(ctx.api.cameraFind(s));
    }

    /** The panel is in view: the machine's page is up, the fold open and the tab shown. */
    function visible(): boolean {
        return fold.open && activePage() === "machine" && (typeof document.visibilityState !== "string" || document.visibilityState !== "hidden");
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
            follow(device, camera.device);
            follow(size, camera.size);
            follow(fps, String(camera.fps));
            follow(side, camera.side);
            follow(finish, camera.finish);
            follow(offsetX, String(camera.offset[0]));
            follow(offsetY, String(camera.offset[1]));
            follow(roll, String(camera.roll));
            follow(scale, String(camera.mm_per_px));
        }
        const job = state.job;
        const hasBoard = job?.design?.board === true;
        setLocked(lookButton, !job || !hasBoard || finding);
        lookButton.title = job && !hasBoard ? "only a .kicad_pcb upload keeps its board file for the camera" : "";
        setLocked(unloadButton, !camera?.board || finding);
        const looking = camera?.board ? state.jobs.find((entry) => entry.id === camera.board)?.name ?? camera.board : null;
        boardNote.textContent = looking ? `looking for the board of ${looking}` : "no board loaded";
        const milling = isMilling(state.snapshot);
        const busy = !connected || !idle || finding;
        setLocked(markButton, busy || !milling || !state.snapshot.profile?.h_axis);
        markButton.title = milling ? "" : "a mark is drilled with a spindle; on this machine record the tool's point over a mark made by hand";
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
        },
    };
}
