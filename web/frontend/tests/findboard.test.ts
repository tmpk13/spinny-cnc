import { describe, expect, test } from "bun:test";

import { turned } from "../src/kinematics.ts";
import { estimateOf, jobSize } from "../src/mock/boardlook.ts";
import { TOP_TRUTH } from "../src/mock/pnp.ts";
import type { BoardGuess, BoardLook } from "../src/types.ts";
import { cornersText, mountFindBoard, mountGuessGraph, pickedCamera, shownGuesses } from "../src/views/findboard.ts";
import { click, findButton, runUntilIdle, settle, setup } from "./harness.ts";

const TOP = '[top_camera]\nz = 0\noffset = [34.0, -9.0]\nfiducial = "bright"\nwithin = 2\n';

function guess(probability: number, extra: Partial<BoardGuess> = {}): BoardGuess {
    return {
        rotation: 0, shift: [0, 0], center: [10, 20], rms: 0, match: 0.9, looks: 6, probability, share: probability,
        spread_mm: 0.1, spread_deg: 0.05, ruled_out: false, corner_mm: null, view: null, seen: null, ...extra,
    };
}

async function twice(): Promise<void> {
    await settle();
    await settle();
}

describe("the guesses' graph", () => {
    test("columns as tall as their share, colored against the threshold, one ruled out hatched; a press and a drag move the line", () => {
        const seen: number[] = [];
        const committed: number[] = [];
        const graph = mountGuessGraph((value) => seen.push(value), (value) => committed.push(value));
        document.body.append(graph.root);
        const look: BoardLook = { job: "a1", found: true, guesses: [guess(0.7), guess(0.2), guess(0.1), guess(0, { ruled_out: true, share: 0.3 })] };
        graph.render(look, 0.15);
        const kinds = Array.from(graph.root.querySelectorAll(".find-column")).map((node) => node.getAttribute("class"));
        expect(kinds).toEqual(["find-column found", "find-column over", "find-column under", "find-column ruled"]);
        // Values on the caps of the columns that count, not on every one.
        expect(Array.from(graph.root.querySelectorAll(".find-value")).map((node) => node.textContent)).toEqual(["70%", "20%", "out"]);
        expect(graph.root.querySelector(".find-line-label")?.textContent).toBe("threshold 15%");
        expect(graph.root.querySelector(".find-column.ruled path")?.getAttribute("fill")).toMatch(/^url\(#find-hatch-\d+\)$/);
        expect(graph.root.querySelector(".find-column title")?.textContent).toContain("#1: 70% of the evidence, found; 6 looks, matched 90%");
        // Pressed at 80% and dragged to 25%: drawn as it goes, sent once let go.
        const svg = graph.root.querySelector("svg")!;
        svg.getBoundingClientRect = () => ({ top: 0, left: 0, width: 320, height: 128, right: 320, bottom: 128, x: 0, y: 0, toJSON: () => ({}) });
        const at = (share: number): number => 110 - share * 94;
        svg.dispatchEvent(new PointerEvent("pointerdown", { clientY: at(0.8), button: 0, bubbles: true }));
        svg.dispatchEvent(new PointerEvent("pointermove", { clientY: at(0.25), bubbles: true }));
        svg.dispatchEvent(new PointerEvent("pointerup", { clientY: at(0.25), bubbles: true }));
        expect(seen).toEqual([0.8, 0.25]);
        expect(committed).toEqual([0.25]);
        // Nothing to draw: no columns, the line still there.
        graph.render(null, 0.5);
        expect(graph.root.querySelectorAll(".find-column").length).toBe(0);
        expect(graph.root.querySelector(".find-empty")?.classList.contains("hidden")).toBe(false);
    });

    test("the board drawing shows the most likely guess and those at or over the threshold; the corners say where they were taken", () => {
        const look: BoardLook = { job: "a1", guesses: [guess(0.4), guess(0.35), guess(0.25), guess(0, { ruled_out: true, share: 0.5 })] };
        expect(shownGuesses(look, 0.3).map((entry) => entry.probability)).toEqual([0.4, 0.35]);
        expect(shownGuesses(look, 0.9).map((entry) => entry.probability)).toEqual([0.4]);
        const name = (id: string): string => (id === "b2" ? "other board" : id);
        expect(cornersText(null, "a1", name)).toBe("");
        const two = { job: "a1", points: [
            { corner: "bottom left" as const, job: [0, 0] as [number, number], machine: [100, 50] as [number, number] },
            { corner: "bottom right" as const, job: [40, 0] as [number, number], machine: [140, 50] as [number, number] },
        ], rough: { rotation: 0, shift: [100, 50] as [number, number], center: [120, 65] as [number, number], rms: 0.02 } };
        expect(cornersText(two, "a1", name)).toBe("bottom left at 100.00, 50.00; bottom right at 140.00, 50.00; rough place: middle at 120.00, 65.00, turned 0.00 deg, the corners within 0.02 mm of it");
        expect(cornersText({ ...two, points: two.points.slice(0, 1) }, "a1", name)).toContain("taken square: a second corner gives the turn");
        expect(cornersText({ ...two, job: "b2" }, "a1", name)).toBe("2 corners taken of other board: Clear corners, or take this board's");
    });
});

describe("the Find board panel", () => {
    test("with the head camera: the board looked for, the threshold sent, corners taken and kept as alignment marks", async () => {
        const { store, ctx, root, api, backend, calls } = setup();
        await api.connect("/dev/ttyACM0");
        await backend.applyMachine("cartesian-mill");
        await ctx.refreshState();
        const job = await backend.uploadJob(new File(["(kicad_pcb)"], "board.kicad_pcb"), {});
        await ctx.refreshJobs();
        await ctx.selectJob(job.id);
        await ctx.refreshCamera();
        mountFindBoard(root, ctx, { page: "test-head", boxes: { head: () => null, top: () => null } });
        const pick = root.querySelector('select[aria-label="Camera that looks for the board"]') as HTMLSelectElement;
        expect(pick.value).toBe("head");
        // The top camera is a G-code machine's: not offered here.
        expect((pick.querySelector('option[value="top"]') as HTMLOptionElement).hidden).toBe(true);
        expect(findButton(root, "Look for board").disabled).toBe(true);
        expect(root.querySelector(".find-note")?.textContent).toContain("not running");
        store.set({ camera: await api.cameraStart() });
        expect(findButton(root, "Look for board").disabled).toBe(false);
        click(root, "Look for board");
        await twice();
        expect(store.get().camera?.board_look?.job).toBe(job.id);
        // The threshold slid shows at once and is sent once let go, as the camera's.
        const slider = root.querySelector(".find-slider") as HTMLInputElement;
        expect(slider.value).toBe("50");
        slider.value = "70";
        slider.dispatchEvent(new Event("input"));
        expect(root.querySelector(".find-slider-value")?.textContent).toBe("70%");
        slider.dispatchEvent(new Event("change"));
        await twice();
        expect(calls.filter((call) => call.name === "cameraSettings").at(-1)?.args[0]).toEqual({ look_threshold: 0.7 });
        expect(store.get().camera?.board_look?.threshold).toBe(0.7);
        // Nothing found and no corners: no place to keep.
        expect(findButton(root, "Use as board place").disabled).toBe(true);
        const corner = root.querySelector('select[aria-label="Corner of the board"]') as HTMLSelectElement;
        corner.value = "bottom left";
        click(root, "Corner here");
        await twice();
        await api.jog({ kind: "board", dx: 10, dy: 0 });
        runUntilIdle(backend);
        await ctx.refreshState();
        corner.value = "bottom right";
        click(root, "Corner here");
        await twice();
        const taken = store.get().camera?.board_look?.corners;
        expect(taken?.points.map((point) => point.corner)).toEqual(["bottom left", "bottom right"]);
        expect(root.querySelector(".find-corners")?.textContent).toContain("bottom left at");
        expect(findButton(root, "Use as board place").disabled).toBe(false);
        click(root, "Use as board place");
        await twice();
        expect(calls.some((call) => call.name === "alignCapture")).toBe(true);
        expect(store.get().align?.marks.map((mark) => mark.design)).toEqual(taken!.points.map((point) => point.job));
        click(root, "Clear corners");
        await twice();
        expect(store.get().camera?.board_look?.corners).toBeNull();
        expect(findButton(root, "Clear corners").disabled).toBe(true);
    });

    test("with a G-code machine's top camera: picked by default, its board searched for and kept as references, by look or by corners", async () => {
        const { store, ctx, root, api, backend, calls } = setup();
        const file = await backend.machineFile("openpnp-marlin");
        await backend.saveMachineFile("openpnp-marlin", `${file.text}\n${TOP}`);
        await api.connect("/dev/ttyACM1", "openpnp-marlin");
        await ctx.refreshState();
        const job = await backend.uploadJob(new File(["(kicad_pcb)"], "board.kicad_pcb"), {});
        await ctx.refreshJobs();
        await ctx.selectJob(job.id);
        await api.topStart();
        await api.topSettings({ offset: [...TOP_TRUTH.offset], mm_per_px: TOP_TRUTH.mmPerPx, roll: TOP_TRUTH.roll });
        await ctx.refreshPlacing();
        // The board lies at the mock's own place with no references: a box about its middle.
        const truth = estimateOf((point) => {
            const t = turned(point, 0.8);
            return { x: t.x + 100, y: t.y + 60 };
        }, jobSize(await backend.job(job.id)).middle);
        const [mx, my] = truth.center;
        const searchBox: [number, number, number, number] = [mx - 40, my - 40, mx + 40, my + 40];
        mountFindBoard(root, ctx, { page: "test-top", boxes: { head: () => null, top: () => searchBox } });
        const pick = root.querySelector('select[aria-label="Camera that looks for the board"]') as HTMLSelectElement;
        expect(pick.value).toBe("top");
        expect(pickedCamera(store.get(), "head")).toBe("head");
        click(root, "Look for board");
        await twice();
        click(root, "Search");
        await twice();
        expect(calls.find((call) => call.name === "topSearch")?.args[0]).toEqual(searchBox);
        for (let t = 0; t < 60 && store.get().placing?.top?.routine?.state === "running"; t += 0.1) {
            backend.step(0.1);
            await ctx.refreshPlacing();
        }
        const look = store.get().placing?.top?.board_look;
        expect(look?.found).toBe(true);
        expect(look?.guesses?.[0]?.probability).toBeGreaterThanOrEqual(0.5);
        expect(root.querySelectorAll(".find-column").length).toBe(look!.guesses!.length);
        expect(root.querySelector(".find-guesses tbody tr")?.textContent).toContain("found");
        click(root, "Use as board place");
        await twice();
        expect(store.get().placing?.references.filter((entry) => entry.job === job.id).map((entry) => entry.by)).toEqual(["look", "look"]);
        // The threshold here is the top camera's.
        const slider = root.querySelector(".find-slider") as HTMLInputElement;
        slider.value = "90";
        slider.dispatchEvent(new Event("change"));
        await twice();
        expect(calls.filter((call) => call.name === "topSettings").at(-1)?.args[0]).toEqual({ look_threshold: 0.9 });
        // Nothing looked for, a corner taken: its rough place is kept, by corners.
        click(root, "Unload");
        await twice();
        click(root, "Corner here");
        await twice();
        expect(store.get().placing?.top?.board_look?.corners?.points.length).toBe(1);
        click(root, "Use as board place");
        await twice();
        expect(store.get().placing?.references.filter((entry) => entry.job === job.id).map((entry) => entry.by)).toEqual(["corners", "corners"]);
        click(root, "Clear corners");
        await twice();
        expect(store.get().placing?.top?.board_look?.corners).toBeNull();
    });
});
