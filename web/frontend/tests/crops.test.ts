import { describe, expect, test } from "bun:test";

import { checkCrop, checkTasks, cropOf, cropText, TOP_TASKS, UP_TASKS, type CropBox } from "../src/crops.ts";
import { setValue } from "../src/mock/cam.ts";
import { gcodeMachineOf } from "../src/mock/machines.ts";
import { cropMarks, mountPicture, type PictureCrops } from "../src/views/picture.ts";
import type { AppState } from "../src/state.ts";
import { click, setup, settle } from "./harness.ts";

const PROFILE = `controller = "gcode"
name = "crop rig"
[port]
url = "socket://127.0.0.1:9"
[motion]
feed_xy = 3000
feed_z = 600
safe_z = 5
place_z = -1
[up_camera]
z = -4
[top_camera]
offset = [34.0, -9.0]
`;

describe("crops", () => {
    test("a crop is four shares in order inside the picture, and a camera's are its own tasks'", () => {
        expect(checkCrop([0, 0.25, 1, 0.75])).toEqual([0, 0.25, 1, 0.75]);
        for (const bad of [[0.5, 0, 0.5, 1], [0, 0, 1.2, 1], [-0.1, 0, 0.5, 1], [0, 0.9, 1, 0.1], [0, 0, 1], "all"]) {
            expect(() => checkCrop(bad)).toThrow();
        }
        expect(checkTasks({ nozzle: [0.4, 0.4, 0.6, 0.6] }, UP_TASKS)).toEqual({ nozzle: [0.4, 0.4, 0.6, 0.6] });
        expect(() => checkTasks({ board: [0, 0, 1, 1] }, UP_TASKS)).toThrow("no task 'board': the tasks are nozzle, part");
        expect(() => checkTasks({ spot: [0.6, 0, 0.4, 1] }, TOP_TASKS)).toThrow("spot: a crop needs");
    });

    test("a box drawn either way round becomes shares clamped to the picture, said in percent", () => {
        expect(cropOf([600, 300], [200, 100], [1000, 500])).toEqual([0.2, 0.2, 0.6, 0.6]);
        // Past the picture's edge the box stops at it.
        expect(cropOf([-50, -20], [500, 600], [1000, 500])).toEqual([0, 0, 0.5, 1]);
        expect(cropOf([100, 100], [100, 300], [1000, 500])).toBeNull();
        expect(cropText(null)).toBe("the whole picture");
        expect(cropText([0.2, 0.25, 0.6, 1])).toBe("20% to 60% across, 25% to 100% down");
    });

    test("a crop dims the picture outside it and draws its outline with its task", () => {
        const marks = cropMarks([0.2, 0.2, 0.6, 1], [1000, 500], "nozzle", 12);
        const dims = marks.filter((mark) => mark.tone === "dim");
        // Above, left and right of it; it reaches the bottom, so no band below.
        expect(dims).toHaveLength(3);
        const area = dims.reduce((sum, mark) => sum + (mark.kind === "rect" ? mark.w * mark.h : 0), 0);
        expect(area).toBeCloseTo(1000 * 500 - 400 * 400, 6);
        const outline = marks.find((mark) => mark.kind === "line");
        expect(outline?.kind === "line" && outline.points).toEqual([[200, 100], [600, 100], [600, 500], [200, 500]]);
        expect(marks.some((mark) => mark.kind === "text" && mark.text === "nozzle crop")).toBe(true);
        expect(cropMarks([0, 0, 1, 1], [1000, 500], "board", 12, true).some((mark) => mark.kind === "text" && mark.text === "board crop, not saved")).toBe(true);
    });

    test("the mock reads a machine file's crops as the backend does and writes one into a table of its own", () => {
        const text = `${PROFILE}\n[top_camera.crops]\nspot = [0.3, 0.3, 0.7, 0.7]\n\n[up_camera.crops]\nnozzle = [0.4, 0.35, 0.6, 0.65]\n`;
        const machine = gcodeMachineOf(text, "rig");
        expect(machine.top?.crops).toEqual({ spot: [0.3, 0.3, 0.7, 0.7] });
        expect(machine.camera_crops).toEqual({ nozzle: [0.4, 0.35, 0.6, 0.65] });
        expect(() => gcodeMachineOf(`${PROFILE}\n[up_camera.crops]\nboard = [0, 0, 1, 1]\n`, "rig")).toThrow("[up_camera.crops] no task 'board': the tasks are nozzle, part");
        expect(() => gcodeMachineOf(`${PROFILE}\n[top_camera.crops]\nedges = [0.5, 0, 0.5, 1]\n`, "rig")).toThrow("[top_camera.crops] edges: a crop needs");
        // A key of [top_camera] goes in its own table, before its crops; a crop's in the crops' table.
        let changed = setValue(text, ["top_camera", "within"], 2.5);
        expect(changed.indexOf("within = 2.5")).toBeLessThan(changed.indexOf("[top_camera.crops]"));
        changed = setValue(changed, ["top_camera", "crops", "board"], [0, 0.1, 1, 0.9]);
        expect(gcodeMachineOf(changed, "rig").top?.crops).toEqual({ spot: [0.3, 0.3, 0.7, 0.7], board: [0, 0.1, 1, 0.9] });
        changed = setValue(changed, ["top_camera", "crops", "spot"], null);
        expect(gcodeMachineOf(changed, "rig").top?.crops).toEqual({ board: [0, 0.1, 1, 0.9] });
        expect(() => setValue(PROFILE, ["up_camera", "crops", "part"], [0, 0, 1, 1])).toThrow("no [up_camera.crops] table");
    });

    test("the mock's machine file takes a crop from the page, adding its table, and the placing state's document carries it", async () => {
        const { backend } = setup();
        await backend.saveMachineFile("rig", PROFILE);
        await backend.patchMachineFile("rig", ["up_camera", "crops", "nozzle"], [0.4, 0.35, 0.6, 0.65]);
        const text = (await backend.machineFile("rig")).text;
        expect(text).toContain("[up_camera.crops]\nnozzle = [0.4, 0.35, 0.6, 0.65]");
        expect(gcodeMachineOf(text, "rig").camera_crops).toEqual({ nozzle: [0.4, 0.35, 0.6, 0.65] });
        await expect(backend.patchMachineFile("rig", ["up_camera", "crops", "part"], [0.8, 0, 0.2, 1])).rejects.toMatchObject({ status: 400 });
        await backend.patchMachineFile("rig", ["up_camera", "crops", "nozzle"], null);
        expect(gcodeMachineOf((await backend.machineFile("rig")).text, "rig").camera_crops).toEqual({});
    });
});

describe("a picture's crops", () => {
    function mounted(running: () => string | null = () => null) {
        const { ctx } = setup();
        const file: Partial<Record<string, CropBox>> = { nozzle: [0.4, 0.4, 0.6, 0.6] };
        const saves: [string, CropBox | null][] = [];
        const moves: [number, number][] = [];
        const crops: PictureCrops = {
            tasks: UP_TASKS,
            boxes: () => file,
            running: (_state: AppState) => running(),
            save: async (task, box) => {
                saves.push([task, box]);
                if (box === null) {
                    delete file[task];
                } else {
                    file[task] = box;
                }
                return true;
            },
        };
        const view = mountPicture({
            key: "test-crops",
            label: "Crop camera",
            rides: false,
            running: () => true,
            frameUrl: (width) => `data:image/svg+xml,w=${width}`,
            pcbvOverlay: () => false,
            size: () => [1000, 500],
            calibration: () => ({ mmPerPx: 0.1, roll: 0, mirror: false }),
            center: () => null,
            marks: () => [],
            move: async (mm) => {
                moves.push(mm);
            },
            noScale: "no scale",
            visible: () => true,
            crops,
        }, ctx);
        document.body.append(view.root);
        const stage = view.root.querySelector(".picture-stage") as HTMLElement;
        stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 500, height: 250, right: 500, bottom: 250, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
        view.render(ctx.store.get());
        return { view, stage, ctx, saves, moves, file };
    }

    function pointer(stage: HTMLElement, type: string, x: number, y: number): void {
        stage.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }) as unknown as PointerEvent);
    }

    function pick(view: { root: HTMLElement }, label: string): void {
        click(view.root, "View");
        const item = [...document.querySelectorAll<HTMLButtonElement>(".menu-item")].find((node) => node.textContent === label);
        expect(item).toBeDefined();
        item!.click();
    }

    test("the View menu picks a task, whose box shows dimmed outside; a drag draws another, Save writes it and Clear takes it out", async () => {
        const { view, stage, saves, moves } = mounted();
        const layer = view.root.querySelector(".picture-marks") as SVGElement;
        const row = view.root.querySelector(".picture-crop") as HTMLElement;
        expect(row.classList.contains("hidden")).toBe(true);
        expect(layer.querySelector(".mark-crop")).toBeNull();
        pick(view, "Crop for nozzle");
        expect(row.classList.contains("hidden")).toBe(false);
        expect(row.textContent).toContain("40% to 60% across, 40% to 60% down");
        expect(layer.querySelectorAll(".mark-dim").length).toBe(4);
        expect(layer.querySelector("polygon.mark-crop")?.getAttribute("points")).toBe("400.00,200.00 600.00,200.00 600.00,300.00 400.00,300.00");
        // Nothing drawn yet: nothing to save; the file has a crop to clear.
        const button = (label: string): HTMLButtonElement => [...view.root.querySelectorAll("button")].find((node) => node.textContent === label)!;
        expect(button("Save crop").dataset["locked"]).toBe("1");
        expect(button("Clear crop").dataset["locked"]).toBeUndefined();
        // A drag draws the crop's box, not a move: 100 to 300 screen px of a 500 px stage are 200 to 600 picture px.
        pointer(stage, "pointerdown", 100, 50);
        pointer(stage, "pointermove", 300, 200);
        expect(layer.querySelector("polygon.mark-crop")).not.toBeNull();
        pointer(stage, "pointerup", 300, 200);
        await settle();
        expect(moves).toHaveLength(0);
        expect(row.textContent).toContain("drawn: 20% to 60% across, 20% to 80% down");
        expect(layer.querySelector("text.mark-label-crop")?.textContent).toBe("nozzle crop, not saved");
        click(view.root, "Save crop");
        await settle();
        expect(saves).toEqual([["nozzle", [0.2, 0.2, 0.6, 0.8]]]);
        expect(layer.querySelector("text.mark-label-crop")?.textContent).toBe("nozzle crop");
        click(view.root, "Clear crop");
        await settle();
        expect(saves[1]).toEqual(["nozzle", null]);
        // No crop for the task: the whole picture, nothing dimmed.
        expect(row.textContent).toContain("the whole picture");
        expect(layer.querySelector(".mark-dim")).toBeNull();
        click(view.root, "Done");
        expect(row.classList.contains("hidden")).toBe(true);
        // With no crop picked a drag moves the head again.
        pointer(stage, "pointerdown", 100, 50);
        pointer(stage, "pointerup", 300, 200);
        await settle();
        expect(moves).toHaveLength(1);
        view.stop();
    });

    test("while a routine runs the picture shows the crop of the task it keeps to", () => {
        let task: string | null = "nozzle";
        const { view, ctx } = mounted(() => task);
        const layer = view.root.querySelector(".picture-marks") as SVGElement;
        expect(layer.querySelector("text.mark-label-crop")?.textContent).toBe("nozzle crop");
        task = "part";
        view.render(ctx.store.get());
        // The part has no crop: the whole picture.
        expect(layer.querySelector(".mark-crop")).toBeNull();
        task = null;
        view.render(ctx.store.get());
        expect(layer.querySelector(".mark-crop")).toBeNull();
        view.stop();
    });
});
