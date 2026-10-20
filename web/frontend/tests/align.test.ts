import { describe, expect, test } from "bun:test";

import { fitRigid, turnPoint } from "../src/align.ts";
import { ApiError } from "../src/api.ts";
import { jointOfBoard } from "../src/kinematics.ts";
import { MockBackend } from "../src/mock/backend.ts";
import type { CameraState } from "../src/types.ts";
import { parseEvent } from "../src/ws.ts";
import { canCapture, fitText, mountAlign } from "../src/views/align.ts";
import { click, dialogButton, settle, setup } from "./harness.ts";

const PADS: [number, number][] = [[-12, 14], [0, 14], [12, 14]];

function placed(point: [number, number], rotation: number, shift: [number, number]): [number, number] {
    const turned = turnPoint(point, rotation);
    return [turned[0] + shift[0], turned[1] + shift[1]];
}

describe("the rigid fit", () => {
    test("recovers a known turn and shift from three points, with zero residuals on exact data", () => {
        const pairs = PADS.map((design) => ({ design, machine: placed(design, 1.25, [0.3, -0.2]) }));
        const fit = fitRigid(pairs);
        expect(fit.rotation).toBeCloseTo(1.25, 9);
        expect(fit.shift[0]).toBeCloseTo(0.3, 9);
        expect(fit.shift[1]).toBeCloseTo(-0.2, 9);
        expect(fit.scale).toBeCloseTo(1, 9);
        expect(fit.rms).toBeCloseTo(0, 9);
        expect(fit.residuals.every((value) => value < 1e-9)).toBe(true);
    });

    test("one pair gives a shift only", () => {
        const fit = fitRigid([{ design: [5, 5], machine: [5.4, 4.7] }]);
        expect(fit.rotation).toBe(0);
        expect(fit.shift).toEqual([expect.closeTo(0.4, 9), expect.closeTo(-0.3, 9)]);
        expect(fit.residuals).toEqual([expect.closeTo(0, 9)]);
    });

    test("the scale is reported and never applied, and a fixed turn is taken as given", () => {
        const pairs = PADS.map((design) => ({ design, machine: [design[0] * 1.01, design[1] * 1.01] as [number, number] }));
        const fit = fitRigid(pairs);
        expect(fit.scale).toBeCloseTo(1.01, 6);
        expect(fit.rotation).toBeCloseTo(0, 9);
        // Residuals are what the scale would have taken out.
        expect(fit.rms).toBeGreaterThan(0);
        const fixed = fitRigid([{ design: [10, 0], machine: [10, 0] }], 90);
        expect(fixed.rotation).toBe(90);
        expect(fixed.shift[0]).toBeCloseTo(10, 9);
        expect(fixed.shift[1]).toBeCloseTo(-10, 9);
    });

    test("no pairs is refused", () => {
        expect(() => fitRigid([])).toThrow("no marks");
    });
});

/** Declares the head at a board point without moving it. */
async function headAt(backend: MockBackend, x: number, y: number): Promise<void> {
    const joint = jointOfBoard({ x, y });
    await backend.setPosition({ r: joint.r, a: joint.a });
}

describe("alignment in the mock", () => {
    test("marks pair the tool's point with the nearest pad, the fit says the shift, and apply moves the job", async () => {
        const backend = new MockBackend({ timers: false });
        const events: string[] = [];
        backend.onEvent((event) => events.push(event.type));
        await backend.connect("/dev/ttyACM0");
        const job = (await backend.jobs())[0]!;
        expect((await backend.job(job.id)).pads).toEqual(PADS.map(([x, y]) => [x, y, 9]));
        await expect(backend.alignFit(job.id)).rejects.toMatchObject({ status: 400, message: "there are no marks: mark a pad, a hole or a point first" });
        await headAt(backend, -11.8, 14.1);
        const one = await backend.alignMark({ job: job.id, nearest: "pad" });
        expect(one.job).toBe(job.id);
        expect(one.marks).toHaveLength(1);
        expect(one.marks[0]).toMatchObject({ design: [-12, 14], machine: [-11.8, 14.1], source: "tool", kind: "pad", angle: null });
        expect(one.marks[0]!.distance).toBeCloseTo(Math.hypot(0.2, 0.1), 4);
        expect(events).toContain("align");
        const fit = await backend.alignFit(job.id);
        expect(fit).toMatchObject({ rotation: 0, marks: 1 });
        expect(fit.shift[0]).toBeCloseTo(0.2, 4);
        expect(fit.shift[1]).toBeCloseTo(0.1, 4);
        // A hole far from the tool is not within reach; a point typed in is taken as it is.
        await headAt(backend, 5, 5);
        await expect(backend.alignMark({ job: job.id, nearest: "hole", within: 1 })).rejects.toMatchObject({ status: 400, message: "no hole within 1 mm of the tool" });
        const two = await backend.alignMark({ job: job.id, design: [4.8, 4.9] });
        expect(two.marks[1]).toMatchObject({ kind: "point", distance: 0, machine: [5, 5] });
        expect(two.fit?.marks).toBe(2);
        const removed = await backend.alignDeleteMark(1);
        expect(removed.marks).toHaveLength(1);
        await expect(backend.alignDeleteMark(5)).rejects.toMatchObject({ status: 404 });
        const applied = await backend.alignApply(job.id);
        expect(applied.fit.shift[0]).toBeCloseTo(0.2, 4);
        expect(applied.job.pads?.[0]?.[0]).toBeCloseTo(-11.8, 4);
        expect(applied.job.pads?.[0]?.[1]).toBeCloseTo(14.1, 4);
        expect(applied.job.rotation).toBe(0);
        expect(applied.job.offset.x).toBeCloseTo(0.2, 4);
        expect(applied.job.offset.y).toBeCloseTo(14.1, 4);
        expect(applied.job.groups[0]!.paths[0]![0]![0]).toBeCloseTo(job.groups[0]!.paths > 0 ? (await backend.job(job.id)).groups[0]!.paths[0]![0]![0] : 0, 4);
        expect((await backend.align()).marks).toEqual([]);
        expect((await backend.job(job.id)).design?.shift[0]).toBeCloseTo(0.2, 4);
    });

    test("three marks fit a turn, which apply records on the job and its design", async () => {
        const backend = new MockBackend({ timers: false });
        await backend.connect("/dev/ttyACM0");
        const job = (await backend.jobs())[0]!;
        for (const pad of PADS) {
            const [x, y] = placed(pad, 1, [0.5, -0.25]);
            await headAt(backend, x, y);
            await backend.alignMark({ job: job.id, nearest: "pad", within: 2 });
        }
        const fit = await backend.alignFit(job.id);
        expect(fit.rotation).toBeCloseTo(1, 3);
        expect(fit.shift[0]).toBeCloseTo(0.5, 3);
        expect(fit.shift[1]).toBeCloseTo(-0.25, 3);
        expect(fit.rms).toBeLessThan(0.001);
        const { job: moved } = await backend.alignApply(job.id);
        expect(moved.rotation).toBeCloseTo(1, 3);
        expect(moved.design?.rotation).toBeCloseTo(1, 3);
        const first = moved.pads![0]!;
        expect(first[0]).toBeCloseTo(placed(PADS[0]!, 1, [0.5, -0.25])[0], 3);
        expect(first[1]).toBeCloseTo(placed(PADS[0]!, 1, [0.5, -0.25])[1], 3);
        // The marks were for this job: another job's fit is refused.
        await headAt(backend, 0, 14);
        await backend.alignMark({ job: job.id, nearest: "pad" });
        const other = await backend.uploadJob(new File(["<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'><path d='M0 0 L10 0'/></svg>"], "line.svg"), {});
        await expect(backend.alignFit(other.id)).rejects.toMatchObject({ status: 400 });
    });

    test("a mark while a run owns the machine is refused", async () => {
        const backend = new MockBackend({ timers: false });
        await backend.connect("/dev/ttyACM0");
        const job = (await backend.jobs())[0]!;
        await backend.runJob(job.id);
        await expect(backend.alignMark({ job: job.id, nearest: "pad" })).rejects.toBeInstanceOf(ApiError);
    });
});

describe("the align panel", () => {
    test("shows the marks and the fit, and applies on confirm", async () => {
        const { store, ctx, root, api, backend, calls } = setup();
        await api.connect("/dev/ttyACM0");
        await ctx.refreshState();
        await ctx.refreshJobs();
        await ctx.refreshAlign();
        mountAlign(root, ctx);
        expect(root.textContent).toContain("select a job to align");
        const jobs = await api.jobs();
        await ctx.selectJob(jobs[0]!.id);
        expect(root.querySelectorAll("table.align-marks tbody tr").length).toBe(0);
        await headAt(backend, -11.9, 14);
        await ctx.refreshState();
        click(root, "Mark here");
        await settle();
        await settle();
        expect(calls.find((c) => c.name === "alignMark")?.args[0]).toEqual({ job: jobs[0]!.id, nearest: "pad", within: 5 });
        expect(root.querySelectorAll("table.align-marks tbody tr").length).toBe(1);
        expect(root.querySelector(".align-badge")?.textContent).toBe("1 mark");
        await settle();
        expect(root.querySelector(".align-fit")?.textContent).toContain("one mark: a shift");
        expect(root.querySelector(".align-fit")?.textContent).toContain("shift X 0.100");
        // A point typed in.
        const pick = root.querySelector("select") as HTMLSelectElement;
        pick.value = "point";
        pick.dispatchEvent(new Event("change"));
        (root.querySelector('input[aria-label="Design point x"]') as HTMLInputElement).value = "3";
        (root.querySelector('input[aria-label="Design point y"]') as HTMLInputElement).value = "4";
        click(root, "Mark here");
        await settle();
        await settle();
        expect(calls.filter((c) => c.name === "alignMark").at(-1)?.args[0]).toEqual({ job: jobs[0]!.id, design: [3, 4] });
        expect(root.querySelectorAll("table.align-marks tbody tr").length).toBe(2);
        // The point mark goes; the pad mark's shift stays.
        Array.from(root.querySelectorAll("button")).filter((b) => b.textContent === "Remove").at(-1)!.click();
        await settle();
        await settle();
        expect(root.querySelectorAll("table.align-marks tbody tr").length).toBe(1);
        click(root, "Apply");
        await settle();
        dialogButton("Apply").click();
        await settle();
        await settle();
        await settle();
        expect(calls.some((c) => c.name === "alignApply")).toBe(true);
        expect(store.get().job?.offset.x).toBeCloseTo(0.1, 4);
        expect(root.querySelectorAll("table.align-marks tbody tr").length).toBe(0);
    });

    test("capture needs a locked pose on this job's board, and the words say so", () => {
        expect(fitText(null)).toContain("no fit yet");
        expect(fitText(null, "the marks are for job a, not b")).toBe("the marks are for job a, not b");
        expect(fitText({ rotation: 0.5, shift: [1, 2], scale: 1, rms: 0.01, residuals: [], marks: 2 })).toContain("rotation 0.5000 deg");
        const job = { id: "a1" } as never;
        const base = { running: true, board: "a1", pose: { state: "locked" as const } };
        expect(canCapture({ ...base } as never, job)).toBe(true);
        expect(canCapture({ ...base, running: false } as never, job)).toBe(false);
        expect(canCapture({ ...base, board: "b2" } as never, job)).toBe(false);
        expect(canCapture({ ...base, pose: { state: "lost" } } as never, job)).toBe(false);
        expect(canCapture(null, job)).toBe(false);
    });

    test("the camera and align events are read", () => {
        const align = { job: "a1", marks: [], fit: null };
        expect(parseEvent(JSON.stringify({ type: "align", ...align }))).toEqual({ type: "align", data: align });
        const camera = { running: false } as unknown as CameraState;
        expect(parseEvent(JSON.stringify({ type: "camera", data: camera }))).toEqual({ type: "camera", data: camera });
    });
});
