import { describe, expect, test } from "bun:test";

import { boardMarks, foundMarks, frameSize, reachMark } from "../src/views/camview.ts";
import { dragMove, frameRequestWidth, growBox, machineToPicture, mountPicture, pictureToMachine, spotMarks } from "../src/views/picture.ts";
import { setup, settle } from "./harness.ts";

describe("picture geometry", () => {
    test("a picture displacement turns into the machine's mm and back, mirrored or not", () => {
        for (const [roll, mirror] of [[0, false], [37, false], [-120, true], [180, true]] as [number, boolean][]) {
            const [mx, my] = pictureToMachine(12, -7, 0.02, roll, mirror);
            const [dx, dy] = machineToPicture(mx, my, 0.02, roll, mirror);
            expect(dx).toBeCloseTo(12, 9);
            expect(dy).toBeCloseTo(-7, 9);
        }
        // Right in an unturned picture is +X; down is -Y.
        expect(pictureToMachine(50, 0, 0.02, 0, false)).toEqual([1, 0]);
        const [, down] = pictureToMachine(0, 50, 0.02, 0, false);
        expect(down).toBeCloseTo(-1, 9);
    });

    test("a drag moves a riding camera's head against it and a fixed camera's with it", () => {
        const calibration = { mmPerPx: 0.02, roll: 0, mirror: false };
        expect(dragMove(true, 50, 0, calibration)).toEqual([-1, -0]);
        expect(dragMove(false, 50, 0, calibration)).toEqual([1, 0]);
    });

    test("a picture is asked at the whole factor that still fills the screen's pixels, the full size at most", () => {
        // 640 px shown at a ratio of 1 from a 1280 wide camera: half size.
        expect(frameRequestWidth(640, 1, 1, 1280)).toBe(640);
        // A little wider than half: the full size, since pcbv shrinks by whole factors.
        expect(frameRequestWidth(700, 1, 1, 1280)).toBe(1280);
        // A high density screen or a zoom asks for more, the full size at most.
        expect(frameRequestWidth(640, 2, 1, 1280)).toBe(1280);
        expect(frameRequestWidth(400, 1, 4, 1920)).toBe(1920);
        // A small box of a big camera: a third.
        expect(frameRequestWidth(300, 1, 1, 1920)).toBe(320);
        // Size unknown: what is shown, within the backend's range.
        expect(frameRequestWidth(50, 1, 1, null)).toBe(160);
        expect(frameRequestWidth(9000, 1, 1, null)).toBe(4096);
    });

    test("a box grows to take in another", () => {
        expect(growBox(null, [5, 6, 1, 2])).toEqual([1, 2, 5, 6]);
        expect(growBox([0, 0, 10, 10], [5, -3, 20, 4])).toEqual([0, -3, 20, 10]);
    });

    test("a spot found draws its ellipse, rectangle, center and reach; a miss only the reach", () => {
        const marks = spotMarks({ found: true, dx: 10, dy: -5, major: 20, minor: 10, angle: 30, rect: { length: 22, width: 11, angle: 28 }, radius: null }, [1280, 720], "look");
        expect(marks[0]).toMatchObject({ kind: "circle", x: 640, y: 360, r: 240, tone: "ring" });
        expect(marks.find((mark) => mark.kind === "ellipse")).toMatchObject({ x: 650, y: 355, rx: 10, ry: 5, angle: 30, tone: "look" });
        expect(marks.find((mark) => mark.kind === "rect")).toMatchObject({ w: 22, h: 11, angle: 28 });
        const miss = spotMarks({ found: false, radius: 100 }, [1280, 720], "look");
        expect(miss.map((mark) => mark.tone)).toEqual(["ring", "miss"]);
        expect(miss[0]).toMatchObject({ r: 100 });
    });

    test("a running or failed routine's spot is shown before a look once, a look once before an old routine's", () => {
        const spot = { dx: 1, dy: 2, mm: 0.1 };
        const look = { found: true, polarity: "dark" as const, radius: null, dx: 3, dy: 4 };
        expect(foundMarks({ state: "running", spot }, look, [100, 100]).some((mark) => mark.tone === "spot")).toBe(true);
        expect(foundMarks({ state: "done", spot }, look, [100, 100]).some((mark) => mark.tone === "look")).toBe(true);
        expect(foundMarks(null, null, [100, 100])).toEqual([]);
        expect(frameSize(null, "640x480")).toEqual([640, 480]);
        expect(frameSize({ width: 1920, height: 1080 }, "640x480")).toEqual([1920, 1080]);
        expect(reachMark(2, { mmPerPx: 0.02, roll: 0, mirror: false }, [1280, 720], "")[0]).toMatchObject({ r: 100 });
    });

    test("the board's outline lands in the picture where the estimate puts it", () => {
        const job = { outline: [[[0, 0], [10, 0]]] } as never;
        // The board turned a quarter and shifted to 100, 50; the picture's center sees 100, 50.
        const [line] = boardMarks(job, { rotation: 90, shift: [100, 50] }, [100, 50], { mmPerPx: 0.1, roll: 0, mirror: false }, [200, 100]);
        expect(line?.kind).toBe("line");
        const points = (line as { points: [number, number][] }).points;
        expect(points[0]![0]).toBeCloseTo(100, 9);
        expect(points[0]![1]).toBeCloseTo(50, 9);
        // Job +X became machine +Y: up in the picture by 100 px.
        expect(points[1]![0]).toBeCloseTo(100, 9);
        expect(points[1]![1]).toBeCloseTo(-50, 9);
    });
});

describe("the picture view", () => {
    function mounted(rides = true) {
        const { ctx } = setup();
        const moves: [number, number][] = [];
        const view = mountPicture({
            key: `test-${rides}`,
            label: "Test camera",
            rides,
            running: () => true,
            frameUrl: (width, overlay) => `data:image/svg+xml,w=${width}&o=${overlay ? 1 : 0}`,
            pcbvOverlay: () => false,
            size: () => [1000, 500],
            calibration: () => ({ mmPerPx: 0.1, roll: 0, mirror: false }),
            center: () => [50, 20],
            marks: () => [],
            move: async (mm) => {
                moves.push(mm);
            },
            noScale: "no scale",
            visible: () => true,
            boxes: true,
        }, ctx);
        document.body.append(view.root);
        const stage = view.root.querySelector(".picture-stage") as HTMLElement;
        // The stage 500 by 250 px on the screen.
        stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 500, height: 250, right: 500, bottom: 250, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
        view.render(ctx.store.get());
        return { view, stage, moves };
    }

    function pointer(stage: HTMLElement, type: string, x: number, y: number, shift = false): void {
        const event = new MouseEvent(type, { clientX: x, clientY: y, button: 0, shiftKey: shift, bubbles: true }) as unknown as PointerEvent;
        stage.dispatchEvent(event);
    }

    test("Ctrl and the wheel zoom; the plain wheel is left to the page", () => {
        const { view, stage } = mounted();
        const box = view.root.querySelector(".picture-box") as HTMLElement;
        const plain = new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true });
        box.dispatchEvent(plain);
        expect(plain.defaultPrevented).toBe(false);
        expect(view.zoom()).toBe(1);
        // The test DOM's WheelEvent keeps no modifier keys: a wheel event made as a mouse event with the wheel's delta.
        const ctrl = Object.assign(new MouseEvent("wheel", { ctrlKey: true, bubbles: true, cancelable: true }), { deltaY: -100 });
        box.dispatchEvent(ctrl);
        expect(ctrl.defaultPrevented).toBe(true);
        expect(view.zoom()).toBe(1.5);
        // The marks' view box is the part of the picture the zoom shows.
        const marks = view.root.querySelector(".picture-marks") as SVGElement;
        const [x, , width] = (marks.getAttribute("viewBox") ?? "").split(" ").map(Number);
        expect(width).toBeCloseTo(1000 / 1.5, 2);
        expect(x).toBeCloseTo(500 - 1000 / 3, 2);
        void stage;
        view.stop();
    });

    test("a drag draws its line and moves the head so the picture follows; a Shift drag draws the search box", async () => {
        const { view, stage, moves } = mounted();
        pointer(stage, "pointerdown", 100, 100);
        pointer(stage, "pointermove", 150, 100);
        // The line from the press to the pointer, while dragged.
        expect(view.root.querySelector(".mark-drag")).not.toBeNull();
        pointer(stage, "pointerup", 150, 100);
        await settle();
        // 50 screen px of a 500 px stage are 100 picture px, 10 mm: the riding camera's head goes the other way.
        expect(moves).toHaveLength(1);
        expect(moves[0]![0]).toBeCloseTo(-10, 9);
        expect(view.root.querySelector(".mark-drag")).toBeNull();
        pointer(stage, "pointerdown", 0, 0, true);
        pointer(stage, "pointermove", 250, 125, true);
        pointer(stage, "pointerup", 250, 125, true);
        // From the picture's corner to its center: 50 by 25 mm to the left of and above the center's 50, 20.
        expect(view.box()).toEqual([0, 20, 50, 45]);
        expect(view.root.querySelector(".mark-box")).not.toBeNull();
        expect(moves).toHaveLength(1);
        view.setBox(null);
        view.stop();
    });

    test("the picture is asked for at the size shown", () => {
        const { view } = mounted(false);
        const img = view.root.querySelector("img.picture-img") as HTMLImageElement;
        view.refresh(true);
        // 500 px shown of a 1000 px picture at a ratio of 1: half.
        expect(img.getAttribute("src")).toBe("data:image/svg+xml,w=500&o=0");
        view.setZoom(2);
        expect(img.getAttribute("src")).toBe("data:image/svg+xml,w=1000&o=0");
        view.stop();
    });
});

describe("the board drawing's labels and a camera's controls", () => {
    test("labels keep one screen size as the view zooms, and a camera's look shows on the drawing", async () => {
        const { boardSvg, fitLabels, placeLookView } = await import("../src/views/pnp.ts");
        const part = (ref: string, x: number, y: number) => ({ ref, value: "10k", footprint: "R", side: "front" as const, x, y, rotation: 0, pads: 2, smd: true, dnp: false });
        const drawn = boardSvg({ job: null, parts: [part("R1", 0, 0), part("R2", 0.2, 0), part("R3", 30, 20)], selected: "R2", camera: null }, () => undefined)!;
        const box = drawn.box;
        // Whole: 2 drawing units a screen px; zoomed in tenfold: 0.2.
        fitLabels(drawn.root, box, box, 2, 16);
        const sizes = Array.from(drawn.root.querySelectorAll("text")).map((text) => Number(text.getAttribute("font-size")));
        expect(sizes[0]).toBeCloseTo(0.7 * 16 * 2, 6);
        // R1 and R2 sit on one another: the picked one keeps its label.
        const crowded = Array.from(drawn.root.querySelectorAll(".pnp-part")).map((group) => group.querySelector("text")!.classList.contains("crowded"));
        expect(crowded).toEqual([true, false, false]);
        fitLabels(drawn.root, box, box, 0.2, 16);
        expect(Number(drawn.root.querySelector("text")!.getAttribute("font-size"))).toBeCloseTo(0.7 * 16 * 0.2, 6);
        placeLookView(drawn.root, box, { job: "a1", found: true, view: [[0, 0], [10, 0], [10, 5], [0, 5]], seen: [5, 2.5] }, "top camera");
        expect(drawn.root.querySelector(".pnp-look.found polygon")).not.toBeNull();
        placeLookView(drawn.root, box, { job: null }, "top camera");
        expect(drawn.root.querySelector(".pnp-look")).toBeNull();
    });

    test("a camera's controls unfold into sliders, boxes and lists, and a change is sent and kept", async () => {
        const { mountCameraControls } = await import("../src/views/cameracontrols.ts");
        const { ctx, calls } = setup();
        const fold = mountCameraControls(ctx, "head", "the head camera");
        document.body.append(fold.root);
        fold.root.open = true;
        fold.root.dispatchEvent(new Event("toggle"));
        await settle();
        await settle();
        const brightness = fold.root.querySelector('input[aria-label="brightness"]') as HTMLInputElement;
        expect(brightness.type).toBe("range");
        expect(fold.root.querySelector('select[aria-label="auto exposure"]')).not.toBeNull();
        expect((fold.root.querySelector('input[aria-label="white balance automatic"]') as HTMLInputElement).checked).toBe(true);
        brightness.value = "150";
        brightness.dispatchEvent(new Event("change"));
        await settle();
        await settle();
        expect(calls.find((call) => call.name === "setCameraControls")?.args).toEqual(["head", { brightness: 150 }]);
        const kept = fold.root.querySelector(".camera-control.kept .camera-control-name");
        expect(kept?.textContent).toBe("brightness");
    });
});
