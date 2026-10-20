import { describe, expect, test } from "bun:test";

import fixture from "../../../toolpath/tests/data/default-controls.json" with { type: "json" };
import { defaultControls, unitOf } from "../src/controls.ts";
import { MockBackend } from "../src/mock/backend.ts";
import { isDispensing, profileBadge } from "../src/profile.ts";
import type { Controls, Profile } from "../src/types.ts";
import { droText, mountDro } from "../src/views/dro.ts";
import { dispenseRefusal, isDots, mountJobs } from "../src/views/jobs.ts";
import { mountJog } from "../src/views/jog.ts";
import { mountSettings } from "../src/views/settings.ts";
import { click, connected, machine, settle, setup } from "./harness.ts";

const DISPENSER: Profile = { kinematics: "cartesian", tool: "dispenser", h_axis: true, r_max: 0, z_max: 0 };
const KINDS = fixture as unknown as Record<string, Controls>;
const SVG = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'><path d='M0 0 L10 0'/></svg>";

describe("units and controls on a dispenser", () => {
    test("the table joint is mm on a dispenser and degrees otherwise", () => {
        expect(unitOf("a", DISPENSER)).toBe("mm");
        expect(unitOf("a", { ...DISPENSER, tool: "laser" })).toBe("deg");
        expect(unitOf("a", { ...DISPENSER, tool: "spindle" })).toBe("deg");
        expect(unitOf("r", DISPENSER)).toBe("mm");
        expect(unitOf("h", { ...DISPENSER, tool: "spindle" })).toBe("mm");
    });

    test("the dispenser controls are the fixture's, word for word", () => {
        expect(defaultControls(DISPENSER)).toEqual(KINDS["cartesian-dispenser-focus"]!);
        expect(defaultControls({ ...DISPENSER, h_axis: false })).toEqual(KINDS["cartesian-dispenser"]!);
    });

    test("the readout shows the plunger to three decimals, and the badge names the tool", () => {
        const reported = machine({ joint: { r: 1, a: 0.12345, z: 0, h: 0 } });
        expect(droText(reported, null, true).a).toBe("0.123");
        expect(droText(reported, null).a).toBe("0.1235");
        expect(droText(null, null, true).a).toBe("-.---");
        expect(profileBadge(DISPENSER)).toBe("X/Y dispenser");
        expect(isDispensing(connected({}, { profile: DISPENSER }))).toBe(true);
        expect(isDispensing(connected())).toBe(false);
    });

    test("the readout and the jog panel draw E in mm once the settings say dispenser", async () => {
        const { ctx, root, api, backend } = setup();
        await api.connect("/dev/ttyACM0");
        mountDro(root, ctx);
        const jog = document.createElement("section");
        document.body.appendChild(jog);
        mountJog(jog, ctx);
        await backend.updateSettings({ values: { cartesian: 1, dispenser: 1 } });
        await ctx.refreshState();
        await ctx.refreshSettings();
        const cells = Array.from(root.querySelectorAll(".dro-row-joint .dro-cell")).map((cell) => `${cell.querySelector(".dro-label")?.textContent} ${cell.querySelector(".dro-unit")?.textContent}`);
        expect(cells).toEqual(["X mm", "Y mm", "E mm", "H mm"]);
        const labels = Array.from(jog.querySelectorAll("button")).map((b) => b.textContent);
        expect(labels).toContain("Extrude");
        expect(labels).toContain("Retract");
        expect(jog.querySelector('[data-axis="a"]')?.textContent).toContain("0.5 mm");
        expect(jog.querySelector('[data-axis="a"]')?.textContent).not.toContain("deg");
    });
});

describe("a dispense import", () => {
    test("makes one group of dots with the pads' areas and the paste thickness, checked and patched", async () => {
        const backend = new MockBackend({ timers: false });
        const job = await backend.uploadJob(new File(["(kicad_pcb)"], "board.kicad_pcb"), { mode: "dispense", thickness: 0.15 });
        expect(job.groups).toHaveLength(1);
        const dots = job.groups[0]!;
        expect(dots.label).toBe("paste dots");
        expect(dots.tool).toBe("dispenser");
        expect(dots.thickness).toBe(0.15);
        expect(dots.paths).toHaveLength(3);
        expect(dots.paths.every((path) => path.length === 1)).toBe(true);
        expect(dots.areas).toEqual([9, 9, 9]);
        expect(isDots(dots)).toBe(true);
        expect(job.layer).toBe("F.Paste");
        expect(job.pads).toHaveLength(3);
        expect(job.holes).toHaveLength(3);
        expect(job.design).toEqual({ shift: [0, 0], rotation: 0, board: true });
        expect(job.rotation).toBe(0);
        expect(job.outline).toHaveLength(1);
        // A tour: each dot is a move.
        expect(job.stats.moves).toBe(3);
        expect(job.stats.length_mm).toBe(0);
        const plain = await backend.uploadJob(new File(["x"], "board-F_Paste.gtp"), { mode: "dispense" });
        expect(plain.groups[0]!.thickness).toBe(0.12);
        expect(plain.design?.board).toBe(false);
        await expect(backend.uploadJob(new File(["x"], "b.kicad_pcb"), { mode: "dispense", thickness: 10 })).rejects.toMatchObject({ status: 400, message: "thickness must be 0.01 to 5 mm" });
        await expect(backend.uploadJob(new File(["x"], "b.kicad_pcb"), { mode: "dispense", clear: "radial" })).rejects.toMatchObject({ status: 400 });
        await expect(backend.uploadJob(new File([SVG], "line.svg"), { mode: "dispense" })).rejects.toMatchObject({ status: 400 });
        await backend.patchJob(job.id, { groups: [{ index: 0, thickness: 0.2 }] });
        expect((await backend.job(job.id)).groups[0]!.thickness).toBe(0.2);
        await expect(backend.patchJob(job.id, { groups: [{ index: 0, thickness: 0 }] })).rejects.toMatchObject({ status: 400 });
        const listed = (await backend.jobs()).find((entry) => entry.id === job.id)!;
        expect(listed.groups[0]?.thickness).toBe(0.2);
        expect(listed.rotation).toBe(0);
        // A job file keeps the dots, their areas and the pads.
        const saved = await backend.uploadJob(new File([JSON.stringify(await backend.job(job.id))], "paste.json"), {});
        expect(saved.groups[0]).toMatchObject({ tool: "dispenser", thickness: 0.2, areas: [9, 9, 9] });
        expect(saved.pads).toHaveLength(3);
    });
});

describe("a dispenser machine", () => {
    async function dispenser(): Promise<{ backend: MockBackend; sent: () => string[] }> {
        const backend = new MockBackend({ timers: false });
        const log: string[] = [];
        backend.onEvent((event) => {
            if (event.type === "console" && event.data.dir === "tx") {
                log.push(event.data.text);
            }
        });
        await backend.connect("/dev/ttyACM0");
        await backend.updateSettings({ values: { cartesian: 1, dispenser: 1, h_axis: 1 } });
        return { backend, sent: () => log };
    }

    test("is read from the settings, with the plunger's controls and the host's dispensing values", async () => {
        const { backend } = await dispenser();
        expect((await backend.state()).profile).toMatchObject({ kinematics: "cartesian", tool: "dispenser", h_axis: true });
        const settings = await backend.settings();
        expect(settings.controls).toEqual(defaultControls(DISPENSER));
        expect(settings.host).toMatchObject({ gap: 0.1, retract: 0.2, output: 100, extrude_rate: 60, dwell_ms: 200 });
        expect(settings.schema.find((entry) => entry.name === "dispenser")).toEqual({ name: "dispenser", unit: "0/1", help: "1 = the table's joint is a dispenser's plunger in mm (with cartesian)" });
        expect(settings.schema).toHaveLength(75);
        expect(settings.values["dispenser"]).toBe(1);
        await expect(backend.updateSettings({ host: { tolerance: 0.005, gap: 0 } })).rejects.toMatchObject({ status: 400, message: "the gap must be above 0 and at most 10 mm" });
        await expect(backend.updateSettings({ host: { tolerance: 0.005, retract: 51 } })).rejects.toMatchObject({ status: 400, message: "the retract must be 0 to 50 mm" });
        await expect(backend.updateSettings({ host: { tolerance: 0.005, output: 0 } })).rejects.toMatchObject({ status: 400, message: "the output must be above 0 and at most 100000 mm^3/mm" });
        await expect(backend.updateSettings({ host: { tolerance: 0.005, extrude_rate: 20000 } })).rejects.toMatchObject({ status: 400, message: "the extrude rate must be above 0 and at most 10000 mm/min" });
        await expect(backend.updateSettings({ host: { tolerance: 0.005, dwell_ms: 1.5 } })).rejects.toMatchObject({ status: 400, message: "the dwell must be a whole number of ms from 0 to 60000" });
        await backend.updateSettings({ host: { tolerance: 0.005, gap: 0.2, dwell_ms: 100 } });
        expect((await backend.settings()).host).toMatchObject({ gap: 0.2, dwell_ms: 100 });
        // A plunger jog is a joint jog of A in mm; the beam is refused on the dark output.
        await backend.jog({ kind: "joint", da: 0.5 });
        expect(backend.machine.queue.length + (backend.machine.active ? 1 : 0)).toBeGreaterThan(0);
        await expect(backend.laser(100, 100)).rejects.toMatchObject({ status: 400 });
        // The plunger moves no board: the head's board point does not turn with it.
        let guard = 0;
        while (backend.machine.state !== "Idle" && guard < 1000) {
            backend.step(0.05);
            guard += 1;
        }
        expect(backend.machine.joint.a).toBeCloseTo(0.5, 6);
        expect(backend.machine.headBoard()).toEqual({ x: 0, y: 0 });
        // The console takes the plunger word on go and cut, and no S.
        expect(await backend.command("go A1")).toEqual(["ok"]);
        expect(await backend.command("cut A1.2 F60")).toEqual(["ok"]);
        expect(await backend.command("cut A1.3 F60 S100")).toEqual(["error:2 bad word"]);
    });

    test("refuses a job of paths and dispenses dots: lift, over the pad, down to the gap, extrude, dwell, retract, lift", async () => {
        const { backend, sent } = await dispenser();
        const demo = (await backend.jobs())[0]!;
        await expect(backend.runJob(demo.id)).rejects.toMatchObject({ status: 400, message: "isolation loop 1: a dispenser lays dots: import the board with mode dispense" });
        expect(dispenseRefusal(await backend.job(demo.id), true)).toBe("isolation loop 1: a dispenser lays dots: import the board with mode dispense");
        expect(dispenseRefusal(await backend.job(demo.id), false)).toBe("");
        const job = await backend.uploadJob(new File(["x"], "board.kicad_pcb"), { mode: "dispense", thickness: 0.15 });
        expect(dispenseRefusal(job, true)).toBe("");
        const before = sent().length;
        await backend.runJob(job.id);
        const lines = sent().slice(before);
        expect(lines.slice(0, 7)).toEqual([
            "go H2.0000",
            "go R-12.000 Z0.000",
            "go H0.1000",
            "cut A0.2135 F60",
            "dwell T200",
            "go A0.0135",
            "go H2.0000",
        ]);
        let guard = 0;
        while ((await backend.run())?.state === "running" && guard < 20000) {
            backend.step(0.05);
            guard += 1;
        }
        expect((await backend.run())?.state).toBe("done");
        // The plunger only ever grows by the dots' volumes: 9 mm^2 * 0.15 mm / 100 per dot.
        expect(backend.machine.joint.a).toBeCloseTo(3 * 0.0135, 6);
        expect(backend.machine.laser).toBe(0);
        expect(backend.machine.h).toBeCloseTo(2, 9);
        // A group made for a laser is refused, and so is the run without the needle's height.
        const line = await backend.uploadJob(new File([JSON.stringify({ groups: [{ label: "dot", tool: "laser", paths: [[[1, 1]]], areas: [1] }] })], "dot.json"), {});
        await expect(backend.runJob(line.id)).rejects.toMatchObject({ status: 400, message: "dot: made for a laser, not this machine's dispenser" });
        await backend.updateSettings({ values: { h_axis: 0 } });
        await expect(backend.runJob(job.id)).rejects.toMatchObject({ status: 400, message: "a dispenser needs the focus axis as the needle's height: set $h_axis=1" });
    });

    test("the jobs panel shows the paste thickness and the refusal, and the settings panel the dispensing values", async () => {
        const { store, ctx, root, api, backend, calls } = setup();
        await api.connect("/dev/ttyACM0");
        await backend.updateSettings({ values: { cartesian: 1, dispenser: 1, h_axis: 1 } });
        await ctx.refreshState();
        await ctx.refreshSettings();
        mountJobs(root, ctx);
        await ctx.refreshJobs();
        const jobs = await api.jobs();
        await ctx.selectJob(jobs[0]!.id);
        expect(root.querySelector(".run-note")?.textContent).toContain("a dispenser lays dots");
        expect(Array.from(root.querySelectorAll("button")).find((b) => b.textContent === "Run")?.disabled).toBe(true);
        const job = await backend.uploadJob(new File(["x"], "board.kicad_pcb"), { mode: "dispense" });
        await ctx.refreshJobs();
        await ctx.selectJob(job.id);
        expect(root.querySelector(".run-note")?.classList.contains("hidden")).toBe(true);
        expect(Array.from(root.querySelectorAll("button")).find((b) => b.textContent === "Run")?.disabled).toBe(false);
        expect(Array.from(root.querySelectorAll("table.groups thead th")).map((th) => th.textContent)).toEqual(["Paste mm", "Passes", "On"]);
        expect(root.querySelector("table.groups .group-name")?.textContent).toContain("(3 dots)");
        const thickness = root.querySelector('input[aria-label="thickness"]') as HTMLInputElement;
        expect(thickness.value).toBe("0.12");
        thickness.value = "0.2";
        thickness.dispatchEvent(new Event("change"));
        for (let i = 0; i < 4; i++) {
            await settle();
        }
        const patch = calls.find((c) => c.name === "patchJob")?.args[1] as { groups: { thickness?: number; power?: number }[] };
        expect(patch.groups[0]!.thickness).toBe(0.2);
        expect(patch.groups[0]!.power).toBeUndefined();
        expect(store.get().job?.groups[0]?.thickness).toBe(0.2);
        expect(root.querySelector(".job-rotation")?.textContent).toBe("turned 0.0000 deg");
        // The upload form: dispense shows the thickness field and sends it with the mode.
        const mode = root.querySelector('select[aria-label="Board mode"]') as HTMLSelectElement;
        mode.value = "dispense";
        mode.dispatchEvent(new Event("change"));
        const paste = root.querySelector('input[aria-label="Paste thickness"]') as HTMLInputElement;
        expect(paste.closest("label")?.classList.contains("hidden")).toBe(false);
        expect(root.querySelector('select[aria-label="Clear copper"]')?.closest("label")?.classList.contains("hidden")).toBe(true);
        paste.value = "0.3";
        const drop = root.querySelector(".drop") as HTMLElement;
        const event = new Event("drop", { cancelable: true });
        Object.defineProperty(event, "dataTransfer", { value: { files: [new File(["x"], "board.kicad_pcb")] } });
        drop.dispatchEvent(event);
        for (let i = 0; i < 6; i++) {
            await settle();
        }
        const upload = calls.filter((c) => c.name === "uploadJob").at(-1)?.args[1] as { mode?: string; thickness?: number; clear?: string };
        expect(upload).toMatchObject({ mode: "dispense", thickness: 0.3 });
        expect(upload.clear).toBeUndefined();
        // The settings panel: the dispensing row shows and Apply sends the gap.
        const settingsRoot = document.createElement("section");
        document.body.appendChild(settingsRoot);
        mountSettings(settingsRoot, ctx);
        await ctx.refreshSettings();
        const gapLabel = Array.from(settingsRoot.querySelectorAll(".labeled")).find((label) => label.textContent?.startsWith("Gap"))!;
        expect(gapLabel.closest(".button-row")?.classList.contains("hidden")).toBe(false);
        const gap = gapLabel.querySelector("input") as HTMLInputElement;
        expect(gap.value).toBe("0.1");
        gap.value = "0.25";
        click(settingsRoot, "Apply");
        await settle();
        await settle();
        const update = calls.filter((c) => c.name === "updateSettings").at(-1)?.args[0] as { host: Record<string, number> };
        expect(update.host["gap"]).toBe(0.25);
        expect((await api.settings()).host.gap).toBe(0.25);
        gap.value = "0";
        click(settingsRoot, "Apply");
        await settle();
        expect(store.get().toasts.some((toast) => toast.text === "the gap must be above 0 and at most 10 mm")).toBe(true);
    });
});
