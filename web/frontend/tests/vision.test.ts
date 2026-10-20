import { describe, expect, test } from "bun:test";

import { jointOfBoard } from "../src/kinematics.ts";
import { FIND_STEP_SECONDS, MockBackend } from "../src/mock/backend.ts";
import { BOARD_MISPLACEMENT, CAMERA_TRUTH, boardVector, picturePoint } from "../src/mock/vision.ts";
import type { WsEvent } from "../src/types.ts";
import { cameraBadge, mountVision, poseText, routineText } from "../src/views/vision.ts";
import { click, findButton, settle, setup } from "./harness.ts";

async function finished(backend: MockBackend): Promise<void> {
    let guard = 0;
    while ((await backend.camera()).routine?.state === "running" && guard < 100) {
        backend.step(FIND_STEP_SECONDS);
        guard += 1;
    }
}

describe("the mock camera", () => {
    test("the picture mapping turns a board vector by the roll and back", () => {
        const p = picturePoint({ x: 1, y: 0 }, { x: 0, y: 0 }, 0, 0.02);
        expect(p).toEqual({ px: 50, py: -0 });
        const up = picturePoint({ x: 0, y: 1 }, { x: 0, y: 0 }, 0, 0.02);
        expect(up.py).toBeCloseTo(-50, 9);
        const back = boardVector(50, 0, 0, 0.02);
        expect(back.x).toBeCloseTo(1, 9);
        // At a roll of 90 the picture's x axis points along board +Y, so
        // board +X lies down the picture.
        const turned = picturePoint({ x: 1, y: 0 }, { x: 0, y: 0 }, 90, 1);
        expect(turned.px).toBeCloseTo(0, 9);
        expect(turned.py).toBeCloseTo(1, 9);
        const round = boardVector(turned.px, turned.py, 90, 1);
        expect(round.x).toBeCloseTo(1, 9);
        expect(round.y).toBeCloseTo(0, 9);
    });

    test("starts, stops, takes settings and refuses what the backend refuses", async () => {
        const backend = new MockBackend({ timers: false });
        const events: WsEvent[] = [];
        backend.onEvent((event) => events.push(event));
        const initial = await backend.camera();
        expect(initial).toMatchObject({ running: false, device: "/dev/video0", size: "1280x720", fps: 30, pcbv: "pcbv", side: "front", finish: "masked", offset: [0, 0], roll: 0, mm_per_px: 0, board: null, mark: null, frame: null, pose: null, routine: null });
        expect(await backend.cameraPose()).toEqual({ state: null });
        const started = await backend.cameraStart();
        expect(started.running).toBe(true);
        expect(started.frame).toMatchObject({ width: 1280, height: 720 });
        expect(started.pose).toEqual({ state: "none" });
        await expect(backend.cameraStart()).rejects.toMatchObject({ status: 409, message: "the camera is running" });
        expect(events.filter((event) => event.type === "camera").length).toBeGreaterThan(0);
        const url = backend.cameraFrameUrl(320, true);
        expect(url.startsWith("data:image/svg+xml")).toBe(true);
        expect(decodeURIComponent(url)).toContain("<svg");
        expect(decodeURIComponent(url)).toContain('width="320" height="180"');
        await expect(backend.cameraSettings({ size: "big" })).rejects.toMatchObject({ status: 400, message: "size must be WIDTHxHEIGHT" });
        await expect(backend.cameraSettings({ side: "left" as never })).rejects.toMatchObject({ status: 400, message: "side must be one of front, back" });
        await expect(backend.cameraSettings({ finish: "shiny" as never })).rejects.toMatchObject({ status: 400, message: "finish must be one of masked, bare" });
        await expect(backend.cameraSettings({ offset: [2000, 0] })).rejects.toMatchObject({ status: 400, message: "offset must be two numbers within 1000 mm" });
        await expect(backend.cameraSettings({ roll: 400 })).rejects.toMatchObject({ status: 400, message: "roll must be a number within 360" });
        await expect(backend.cameraSettings({ mm_per_px: -1 })).rejects.toMatchObject({ status: 400, message: "mm_per_px must be 0 or more" });
        const changed = await backend.cameraSettings({ size: "640x480", fps: 15, finish: "bare" });
        expect(changed).toMatchObject({ size: "640x480", fps: 15, finish: "bare", frame: { width: 640, height: 480 } });
        const stopped = await backend.cameraStop();
        expect(stopped).toMatchObject({ running: false, frame: null, pose: null });
    });

    test("looks for a board, locks over it, and a capture aligns the job to where the board lies", async () => {
        const backend = new MockBackend({ timers: false });
        await backend.connect("/dev/ttyACM0");
        const demo = (await backend.jobs())[0]!;
        await expect(backend.cameraBoard(demo.id)).rejects.toMatchObject({ status: 400 });
        const job = await backend.uploadJob(new File(["x"], "board.kicad_pcb"), {});
        await backend.cameraStart();
        const loaded = await backend.cameraBoard(job.id);
        expect(loaded.board).toBe(job.id);
        expect(loaded.pose?.state).toBe("locked");
        expect(loaded.pose?.expected).toBe(3);
        expect(loaded.pose?.angle_deg).toBeCloseTo(CAMERA_TRUTH.roll - BOARD_MISPLACEMENT.rotation, 4);
        expect(loaded.pose?.job_center).not.toBeNull();
        await backend.setPosition({ r: 80, a: 0 });
        expect((await backend.camera()).pose?.state).toBe("lost");
        await backend.setPosition({ r: 0, a: 0 });
        // The capture pairs the picture's center with the tool's point plus the offset: measured first.
        await backend.cameraSettings({ offset: CAMERA_TRUTH.offset, roll: CAMERA_TRUTH.roll, mm_per_px: CAMERA_TRUTH.mmPerPx });
        const marks = await backend.alignCapture(job.id);
        expect(marks.marks[0]).toMatchObject({ source: "camera", kind: "center", distance: 0 });
        expect(marks.marks[0]!.angle).toBeCloseTo(BOARD_MISPLACEMENT.rotation, 3);
        const fit = await backend.alignFit(job.id);
        expect(fit.rotation).toBeCloseTo(BOARD_MISPLACEMENT.rotation, 3);
        expect(fit.shift[0]).toBeCloseTo(BOARD_MISPLACEMENT.shift[0], 3);
        expect(fit.shift[1]).toBeCloseTo(BOARD_MISPLACEMENT.shift[1], 3);
        const { job: aligned } = await backend.alignApply(job.id);
        expect(aligned.rotation).toBeCloseTo(BOARD_MISPLACEMENT.rotation, 3);
        // Once aligned, a capture finds nothing left to correct: the board did not move.
        await backend.alignCapture(job.id);
        const residual = await backend.alignFit(job.id);
        expect(Math.abs(residual.rotation)).toBeLessThan(1e-3);
        expect(Math.hypot(residual.shift[0], residual.shift[1])).toBeLessThan(1e-3);
        await backend.cameraBoard(null);
        await expect(backend.alignCapture(job.id)).rejects.toMatchObject({ status: 409 });
        // The board goes with its job.
        await backend.cameraBoard(job.id);
        await backend.deleteJob(job.id);
        expect((await backend.camera()).board).toBeNull();
    });

    test("the offset routine finds the mark through its steps and measures the offset, the scale and the roll", async () => {
        const backend = new MockBackend({ timers: false });
        const steps: string[] = [];
        backend.onEvent((event) => {
            if (event.type === "camera" && event.data.routine) {
                steps.push(`${event.data.routine.step}:${event.data.routine.done}`);
            }
        });
        await backend.connect("/dev/ttyACM0");
        await expect(backend.cameraFind(2)).rejects.toMatchObject({ status: 400, message: "the camera is not running: start it first" });
        await backend.cameraStart();
        await expect(backend.cameraFind(2)).rejects.toMatchObject({ status: 400 });
        const joint = jointOfBoard({ x: 10, y: 14 });
        await backend.setPosition({ r: joint.r, a: joint.a });
        const marked = await backend.cameraMark({ here: true });
        expect(marked.mark).toEqual([10, 14]);
        await expect(backend.cameraFind(30)).rejects.toMatchObject({ status: 400, message: "step must be 0 to 20 mm" });
        const running = await backend.cameraFind(2);
        expect(running.routine).toMatchObject({ state: "running", step: "lifting", done: 0, total: 6 });
        await expect(backend.cameraStop()).rejects.toMatchObject({ status: 409 });
        await expect(backend.jog({ kind: "joint", dr: 1 })).rejects.toMatchObject({ status: 409, message: "the camera offset routine is running" });
        await finished(backend);
        const done = await backend.camera();
        expect(done.routine).toMatchObject({ state: "done", step: "done", done: 6, total: 6, error: null });
        expect(done.offset[0]).toBeCloseTo(CAMERA_TRUTH.offset[0], 2);
        expect(done.offset[1]).toBeCloseTo(CAMERA_TRUTH.offset[1], 2);
        expect(done.roll).toBeCloseTo(CAMERA_TRUTH.roll, 1);
        expect(done.mm_per_px).toBeCloseTo(CAMERA_TRUTH.mmPerPx, 4);
        expect(done.routine?.spot?.mm).toBeLessThanOrEqual(0.02);
        expect(steps[0]).toBe("lifting:0");
        for (const step of ["moving:1", "scale:2", "centering:3", "done:6"]) {
            expect(steps).toContain(step);
        }
        // The picture's center is on the mark, and the head is at the travel height.
        const head = backend.machine.headBoard();
        expect(head.x + done.offset[0]).toBeCloseTo(10, 2);
        expect(head.y + done.offset[1]).toBeCloseTo(14, 2);
        expect(backend.machine.h).toBeCloseTo(2, 9);
        // An abort ends a routine as stopped; none running is 409.
        await backend.cameraFind(0);
        const aborted = await backend.cameraAbort();
        expect(aborted.routine?.state).toBe("stopped");
        await expect(backend.cameraAbort()).rejects.toMatchObject({ status: 409 });
        // A mark too far from the picture ends the routine in error, with the head where it stopped.
        await backend.cameraSettings({ offset: [200, 0] });
        await backend.cameraFind(2);
        await finished(backend);
        expect((await backend.camera()).routine).toMatchObject({ state: "error" });
    });

    test("a mark is drilled on a spindle machine, and the routine runs from a cartesian head", async () => {
        const backend = new MockBackend({ timers: false });
        await backend.connect("/dev/ttyACM0");
        await expect(backend.cameraMark({ depth: 0.1, plunge: 30 })).rejects.toMatchObject({ status: 400 });
        await backend.updateSettings({ values: { cartesian: 1, spindle: 1, h_axis: 1 } });
        await backend.setPosition({ r: 5 });
        await expect(backend.cameraMark({ depth: 9 })).rejects.toMatchObject({ status: 400, message: "depth must be 0.01 to 5 mm" });
        await expect(backend.cameraMark({ plunge: 0 })).rejects.toMatchObject({ status: 400, message: "plunge must be 1 to 1000 mm/min" });
        const marked = await backend.cameraMark({ depth: 0.2, plunge: 50 });
        expect(marked.mark).toEqual([5, 0]);
        const mark = (await backend.jobs()).find((job) => job.name === "camera mark")!;
        expect(mark.groups[0]).toMatchObject({ label: "camera mark", tool: "spindle", paths: 1, depth: 0.2, plunge: 50 });
        expect((await backend.run())?.job).toBe(mark.id);
        let guard = 0;
        while ((await backend.run())?.state === "running" && guard < 20000) {
            backend.step(0.05);
            guard += 1;
        }
        expect((await backend.run())?.state).toBe("done");
        expect(backend.machine.spindle).toBe(0);
        await backend.cameraStart();
        await backend.cameraFind(1);
        await finished(backend);
        const done = await backend.camera();
        expect(done.routine?.state).toBe("done");
        expect(done.offset[0]).toBeCloseTo(CAMERA_TRUTH.offset[0], 2);
        expect(done.offset[1]).toBeCloseTo(CAMERA_TRUTH.offset[1], 2);
    });

    test("the words of the panel", () => {
        expect(poseText(null)).toBe("no camera state yet");
        expect(cameraBadge(null)).toBe("stopped");
        const base = { running: true, device: "d", size: "1280x720", fps: 30, pcbv: "pcbv", side: "front" as const, finish: "masked" as const, offset: [0, 0] as [number, number], roll: 0, mm_per_px: 0, board: null, mark: null, frame: null, routine: null };
        expect(poseText({ ...base, pose: { state: "none" } })).toBe("camera running, no board loaded");
        expect(poseText({ ...base, pose: { state: "lost", spots: 3, fps: 14 } })).toBe("lost, 3 spots, 14.0 fps");
        const locked = poseText({ ...base, pose: { state: "locked", center: [1, 2], angle_deg: 0.5, rms_mm: 0.04, inliers: 3, expected: 3, fps: 14, job_center: [3, 4] } });
        expect(locked).toContain("locked: center 1.000, 2.000 (job frame 3.000, 4.000), angle 0.500 deg, rms 0.040 mm, 3 of 3 inliers, 14.0 fps");
        expect(cameraBadge({ ...base, pose: { state: "locked" } })).toBe("locked");
        expect(routineText({ ...base, pose: null, routine: { state: "running", step: "centering", done: 3, total: 6, error: null, spot: { dx: 12.4, dy: -3.1, mm: 0.27 } } }))
            .toBe("running: centering, 3 of 6, spot 0.270 mm off the center (12.4, -3.1 px)");
        expect(routineText({ ...base, pose: null, routine: { state: "error", step: "moving", done: 1, total: 6, error: "lost", spot: null } })).toBe("error: moving, 1 of 6: lost");
    });

    test("the camera panel polls the state, shows the picture while the camera runs, and drives the routine", async () => {
        const { store, ctx, root, api, backend, calls } = setup();
        await api.connect("/dev/ttyACM0");
        await ctx.refreshState();
        await ctx.refreshJobs();
        await ctx.refreshCamera();
        const panel = mountVision(root, ctx);
        try {
            expect(root.querySelector(".vision-badge")?.textContent).toBe("stopped");
            expect(root.querySelector(".vision-pose")?.textContent).toBe("camera stopped");
            const img = root.querySelector("img.vision-picture") as HTMLImageElement;
            expect(img.getAttribute("src")).toBeNull();
            click(root, "Start");
            await settle();
            await settle();
            expect(store.get().camera?.running).toBe(true);
            expect(root.querySelector(".vision-badge")?.textContent).toBe("running");
            expect(img.getAttribute("src")?.startsWith("data:image/svg+xml")).toBe(true);
            const fps = root.querySelector('input[aria-label="Camera fps"]') as HTMLInputElement;
            expect(fps.value).toBe("30");
            fps.value = "15";
            click(root, "Apply");
            await settle();
            await settle();
            expect(calls.filter((c) => c.name === "cameraSettings").at(-1)?.args[0]).toEqual({ fps: 15 });
            const jobs = await api.jobs();
            await ctx.selectJob(jobs[0]!.id);
            expect(findButton(root, "Look for board").disabled).toBe(true);
            const job = await backend.uploadJob(new File(["x"], "board.kicad_pcb"), {});
            await ctx.refreshJobs();
            await ctx.selectJob(job.id);
            expect(findButton(root, "Look for board").disabled).toBe(false);
            click(root, "Look for board");
            await settle();
            await settle();
            expect(store.get().camera?.board).toBe(job.id);
            expect(root.querySelector(".vision-badge")?.textContent).toBe("locked");
            expect(root.querySelector(".vision-pose")?.textContent).toContain("locked");
            click(root, "Mark is here");
            await settle();
            await settle();
            expect(store.get().camera?.mark).toEqual([0, 0]);
            click(root, "Find mark");
            await settle();
            await settle();
            expect(calls.some((c) => c.name === "cameraFind" && c.args[0] === 2)).toBe(true);
            expect(root.querySelector(".vision-routine")?.textContent).toContain("running: lifting");
            await finished(backend);
            await ctx.refreshCamera();
            expect(root.querySelector(".vision-routine")?.textContent).toContain("done: done, 6 of 6");
            expect(findButton(root, "Make mark").disabled).toBe(true);
            click(root, "Stop");
            await settle();
            await settle();
            expect(root.querySelector(".vision-pose")?.textContent).toBe("camera stopped");
            expect(img.getAttribute("src")).toBeNull();
        } finally {
            panel.stop();
        }
    });
});
