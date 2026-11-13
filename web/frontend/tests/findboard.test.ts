import { describe, expect, test } from "bun:test";

import { turned } from "../src/kinematics.ts";
import { estimateOf, jobSize } from "../src/mock/boardlook.ts";
import { TOP_TRUTH } from "../src/mock/pnp.ts";
import type { BoardGuess, BoardLook } from "../src/types.ts";
import { cornersText, knownText, mountFindBoard, mountGuessGraph, pickedCamera, shownGuesses } from "../src/views/findboard.ts";
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
        const edged = { ...two, points: [{ ...two.points[0]!, by: "edges" as const, angle: 2 }], rough: { ...two.rough, rotation: 2 } };
        expect(cornersText(edged, "a1", name)).toBe("bottom left by its edges at 100.00, 50.00; rough place: middle at 120.00, 65.00, turned 2.00 deg as its edges run");
    });
});

describe("the place a search started from", () => {
    test("says what said where the board was, how far it may be off, and whether pcbv took it", () => {
        expect(knownText(null)).toBe("");
        const known = { source: "corners" as const, rotation: 1, shift: [40, 30] as [number, number], center: [59.7, 45.3] as [number, number], within_mm: 2, within_deg: 3.27, guided: 4, unguided: 0 };
        expect(knownText(known)).toBe("The search started from the corners taken: middle at 59.70, 45.30, turned 1.00 deg, within 2.0 mm and 3.3 deg;"
            + " pcbv looked there first at 4 stops. It orders the search only: every place is checked the same.");
        expect(knownText({ ...known, source: "job", within_deg: null, guided: 1 })).toContain("from the job's own place: middle at 59.70, 45.30, turned 1.00 deg, within 2.0 mm and any turn; pcbv looked there first at 1 stop.");
        expect(knownText({ ...known, guided: 0, unguided: 3 })).toContain("pcbv could not take it at 3 stops (built before it could: build pcb-vision again)");
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
        // A blank board's corner by its edges: one corner, with its turn,
        // is a whole rough place; then features centered make the marks.
        corner.value = "bottom left";
        expect(findButton(root, "Corner by edges").disabled).toBe(false);
        click(root, "Corner by edges");
        await twice();
        const edged = store.get().camera?.board_look?.corners;
        expect(edged?.points.map((point) => [point.corner, point.by])).toEqual([["bottom left", "edges"]]);
        expect(root.querySelector(".find-corners")?.textContent).toContain("bottom left by its edges at");
        expect(root.querySelector(".find-corners")?.textContent).toContain("as its edges run");
        // Centering needs the camera's scale measured.
        expect(findButton(root, "Center features").dataset["reason"]).toContain("scale is not measured");
        store.set({ camera: await api.cameraSettings({ mm_per_px: 0.02 }) });
        expect(findButton(root, "Center features").disabled).toBe(false);
        click(root, "Center features");
        await twice();
        expect(calls.find((call) => call.name === "cameraRefine")?.args).toEqual([job.id, "auto", 3]);
    });

    test("the locks a guess came from show in the table, and an ambiguous place is said", () => {
        const { ctx, root, store } = setup();
        mountFindBoard(root, ctx, { page: "test-locks", boxes: { head: () => null, top: () => null } });
        store.set({ camera: { ...(store.get().camera ?? {}), running: true, board_look: { job: "a1", need: 5, agree: 6, found: true, sessions: 2, sessions_needed: 2, rival: 0.86, ambiguous: true, guesses: [guess(0.9, { sessions: 2, rival: 0.86 })] } } as never });
        const heads = Array.from(root.querySelectorAll(".find-guesses th")).map((node) => node.textContent);
        expect(heads).toContain("Locks");
        expect(root.querySelector(".find-guesses tbody td:nth-child(4)")?.textContent).toBe("2");
        expect(root.querySelector(".find-look")?.textContent).toContain("from 2 of 2 independent locks");
        expect(root.querySelector(".find-look")?.textContent).toContain("AMBIGUOUS: another place fit 86% as well");
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
        // Nothing said where the board was: no line. Searched again, it
        // starts where the board was found, tells pcbv, and says so.
        expect(look?.known).toBeNull();
        expect(root.querySelector(".find-known")?.classList.contains("hidden")).toBe(true);
        click(root, "Search");
        await twice();
        for (let t = 0; t < 60 && store.get().placing?.top?.routine?.state === "running"; t += 0.1) {
            backend.step(0.1);
            await ctx.refreshPlacing();
        }
        const again = store.get().placing?.top?.board_look;
        expect(again?.found).toBe(true);
        expect(again?.known?.source).toBe("found");
        expect(again?.known?.center).toEqual(look!.estimate!.center);
        expect(again?.known?.guided).toBe(1);
        expect(root.querySelector(".find-known")?.textContent).toContain("The search started from where it was found before");
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
