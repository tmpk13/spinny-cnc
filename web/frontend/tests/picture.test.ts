import { describe, expect, test } from "bun:test";

import { boardMarks, boxShares, frameSize, nozzleBoxMarks, reachMark, shownSpots } from "../src/views/camview.ts";
import { addTurn, armBox, armedPick, armPick, clampZoom, crosshairMarks, disarmPick, dragMove, followShift, frameRequestWidth, growBox, keptMarks, levelText, machineToPicture, MAX_KEPT_SPOTS, mountPicture, pictureToMachine, readCrosshair, readQuarters, shiftMark, type ShownSpot, spotMarks, stepZoom, takeSpots, turnTransform, UNTURNED, unturnOffset, uprightTurn, zoomText } from "../src/views/picture.ts";
import { click, setup, settle } from "./harness.ts";

/** A CSS or SVG transform list applied to a point: rotate (degrees, clockwise on a y-down screen), scaleX, scale and translate; the last one listed acts first. */
function transformPoint(list: string, point: [number, number]): [number, number] {
    const steps = [...list.matchAll(/(rotate|scaleX|scale|translate)\(([^)]*)\)/g)].map((match) => [match[1]!, match[2]!.split(/[\s,]+/).map((value) => parseFloat(value))] as const);
    let [x, y] = point;
    for (const [name, args] of steps.reverse()) {
        if (name === "rotate") {
            const radians = (args[0]! * Math.PI) / 180;
            [x, y] = [x * Math.cos(radians) - y * Math.sin(radians), x * Math.sin(radians) + y * Math.cos(radians)];
        } else if (name === "scaleX") {
            x *= args[0]!;
        } else if (name === "scale") {
            [x, y] = [x * args[0]!, y * (args[1] ?? args[0]!)];
        } else {
            [x, y] = [x + args[0]!, y + (args[1] ?? 0)];
        }
    }
    return [x, y];
}

describe("picture geometry", () => {
    test("Upright shows the machine's +X to the right and +Y up, whatever the roll and mirror", () => {
        for (const mirror of [false, true]) {
            for (const roll of [0, 90, 180, -90, 270, 178.5, 93, -136]) {
                const turn = uprightTurn(roll, mirror);
                // A step right on the screen and one up (the screen's y is down), back in the picture, then on the machine.
                const right = unturnOffset(10, 0, turn);
                const up = unturnOffset(0, -10, turn);
                const [rx, ry] = pictureToMachine(right[0], right[1], 1, roll, mirror);
                const [ux, uy] = pictureToMachine(up[0], up[1], 1, roll, mirror);
                expect(rx).toBeGreaterThan(Math.abs(ry));
                expect(uy).toBeGreaterThan(Math.abs(ux));
                // The CSS turn puts each picture step where the pointer's turn back takes it from.
                for (const step of [[10, 0], [0, -10], [3, 7]] as [number, number][]) {
                    const [sx, sy] = transformPoint(turnTransform(turn), unturnOffset(step[0], step[1], turn));
                    expect(sx).toBeCloseTo(step[0], 9);
                    expect(sy).toBeCloseTo(step[1], 9);
                }
                // Words keep level: their own turn and the picture's cancel about their anchor.
                const level = levelText(40, 30, turn);
                const [lx, ly] = transformPoint(turnTransform(turn), (([x, y]) => [x - 40, y - 30] as [number, number])(transformPoint(level ?? "", [45, 30])));
                expect(lx).toBeCloseTo(5, 9);
                expect(ly).toBeCloseTo(0, 9);
            }
        }
        expect(uprightTurn(180, false)).toEqual({ quarter: 2, flip: false });
        expect(uprightTurn(-90, true)).toEqual({ quarter: 3, flip: true });
        expect(uprightTurn(Number.NaN, false)).toEqual(UNTURNED);
        expect(turnTransform(uprightTurn(90, true))).toBe("rotate(-90deg) scaleX(-1)");
        expect(turnTransform(UNTURNED)).toBe("");
        expect(levelText(1, 2, UNTURNED)).toBeNull();
    });

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

    test("a zoom typed in is held within the steps' range, and the steps go to the one beside it", () => {
        expect(clampZoom(null)).toBeNull();
        expect(clampZoom(Number.NaN)).toBeNull();
        // Out past the picture's own size, a quarter of it at least.
        expect(clampZoom(0.5)).toBe(0.5);
        expect(clampZoom(0.1)).toBe(0.25);
        expect(clampZoom(20)).toBe(8);
        expect(clampZoom(2.3456)).toBe(2.35);
        expect(stepZoom(1, 1)).toBe(1.5);
        expect(stepZoom(2, 1)).toBe(3);
        expect(stepZoom(2.5, 1)).toBe(3);
        expect(stepZoom(2.5, -1)).toBe(2);
        expect(stepZoom(8, 1)).toBe(8);
        expect(stepZoom(1, -1)).toBe(0.75);
        expect(stepZoom(0.25, -1)).toBe(0.25);
        expect(stepZoom(1.2, -1)).toBe(1);
        expect(zoomText(2.5)).toBe("2.5");
        expect(zoomText(1)).toBe("1");
    });

    test("a box grows to take in another", () => {
        expect(growBox(null, [5, 6, 1, 2])).toEqual([1, 2, 5, 6]);
        expect(growBox([0, 0, 10, 10], [5, -3, 20, 4])).toEqual([0, -3, 20, 10]);
    });

    test("the crosshair is a cross, a circle or both, its reach a share of the view or across it", () => {
        // A view 400 by 200 px about the point 500, 250.
        const cross = crosshairMarks("cross", "small", 500, 250, 400, 200);
        expect(cross).toHaveLength(2);
        expect(cross[0]).toMatchObject({ kind: "line", points: [[490, 250], [510, 250]], tone: "center" });
        const circle = crosshairMarks("circle", "large", 500, 250, 400, 200);
        expect(circle).toEqual([{ kind: "circle", x: 500, y: 250, r: 100, tone: "center" }]);
        // Across: the arms reach the view's edges, the circle its shorter half.
        const across = crosshairMarks("both", "across", 500, 250, 400, 200);
        expect(across[0]).toMatchObject({ points: [[300, 250], [700, 250]] });
        expect(across[1]).toMatchObject({ points: [[500, 150], [500, 350]] });
        expect(across[2]).toMatchObject({ kind: "circle", r: 100 });
        expect(crosshairMarks("none", "medium", 0, 0, 10, 10)).toEqual([]);
        // What a store keeps, read back; anything else is the default.
        expect(readCrosshair("circle", "large")).toEqual({ shape: "circle", size: "large" });
        expect(readCrosshair("square", null)).toEqual({ shape: "cross", size: "small" });
    });

    test("spots are kept from when they first show; at the start only a routine under way's", () => {
        const seen = new Set<string>();
        const old = { key: "look a", spot: { dx: 1, dy: 1 }, tone: "look" as const };
        const live = { key: "routine b", spot: { dx: 2, dy: 2 }, tone: "spot" as const, live: true };
        let kept = takeSpots([], [old, live], seen, false, [5, 6]);
        expect(kept.map((entry) => entry.key)).toEqual(["routine b"]);
        expect(kept[0]!.at).toEqual([5, 6]);
        // Shown again, nothing is taken twice; a new one joins at the place now.
        kept = takeSpots(kept, [old, live, { key: "look c", spot: {}, tone: "look" }], seen, true, [7, 8]);
        expect(kept.map((entry) => [entry.key, entry.at])).toEqual([["routine b", [5, 6]], ["look c", [7, 8]]]);
        // At most MAX_KEPT_SPOTS, the oldest going.
        for (let index = 0; index < MAX_KEPT_SPOTS; index++) {
            kept = takeSpots(kept, [{ key: `n${index}`, spot: {}, tone: "look" }], seen, true, null);
        }
        expect(kept).toHaveLength(MAX_KEPT_SPOTS);
        expect(kept[0]!.key).toBe("n0");
    });

    test("kept spots follow what they mark as the machine moves: against a riding camera's moves, with a fixed camera's head", () => {
        const calibration = { mmPerPx: 0.1, roll: 0, mirror: false };
        // The point under a riding camera's center went 1 mm to +X: what it saw moves 10 px left.
        expect(followShift(true, [50, 20], [51, 20], calibration)).toEqual([-10, -0]);
        // A fixed camera's head went 1 mm to +Y: the nozzle it sees goes up the picture.
        const [, up] = followShift(false, [0, 0], [0, 1], calibration);
        expect(up).toBeCloseTo(-10, 9);
        const kept = [
            { key: "a", spot: { found: true, dx: 10, dy: 0, major: 20, minor: 10 }, tone: "spot" as const, at: [50, 20] as [number, number] },
            { key: "b", spot: { found: true, dx: -10, dy: 0, major: 20, minor: 10 }, tone: "look" as const, at: null },
        ];
        const marks = keptMarks(kept, [1000, 500], true, { now: [51, 20], calibration });
        const ellipses = marks.filter((mark) => mark.kind === "ellipse") as { x: number }[];
        // The first moved with the machine; the second, its place not known, stays where it was drawn.
        expect(ellipses.map((mark) => mark.x)).toEqual([500, 490]);
        // Only the newest says how it was looked for: one ring.
        expect(marks.filter((mark) => mark.tone === "ring")).toHaveLength(1);
        expect(shiftMark({ kind: "line", points: [[1, 2]], tone: "spot" }, 3, 4)).toMatchObject({ points: [[4, 6]] });
    });

    test("a turn by hand adds quarters to Upright's and keeps its flip", () => {
        expect(addTurn({ quarter: 3, flip: true }, 2)).toEqual({ quarter: 1, flip: true });
        expect(addTurn(UNTURNED, -1)).toEqual({ quarter: 3, flip: false });
        expect(readQuarters("2")).toBe(2);
        expect(readQuarters("7")).toBe(0);
        expect(readQuarters(null)).toBe(0);
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

    test("a camera's state shows its routine's spot and its look once, each keyed by what it says", () => {
        const spot = { dx: 1, dy: 2, mm: 0.1 };
        const look = { found: true, polarity: "dark" as const, radius: null, dx: 3, dy: 4 };
        const shown = shownSpots({ state: "running", spot }, look);
        expect(shown.map((entry) => [entry.tone, entry.live === true])).toEqual([["spot", true], ["look", false]]);
        expect(shownSpots({ state: "done", spot: { ...spot, dx: 5 } }, null)[0]!.key).not.toBe(shown[0]!.key);
        expect(shownSpots(null, null)).toEqual([]);
        expect(frameSize(null, "640x480")).toEqual([640, 480]);
        expect(frameSize({ width: 1920, height: 1080 }, "640x480")).toEqual([1920, 1080]);
        expect(reachMark(2, { mmPerPx: 0.02, roll: 0, mirror: false }, [1280, 720], "")[0]).toMatchObject({ r: 100 });
    });

    test("the nozzle box is kept in shares of the picture and drawn with its word at its corner", () => {
        expect(boxShares([128, 72, 384, 360], [1280, 720])).toEqual([0.1, 0.1, 0.3, 0.5]);
        // Past the picture's edge it is held to it; a box with no width is none.
        expect(boxShares([-20, 0, 640, 900], [1280, 720])).toEqual([0, 0, 0.5, 1]);
        expect(boxShares([10, 10, 10, 50], [1280, 720])).toBeNull();
        const shown = { size: [1000, 500] as [number, number], region: [0, 0, 1000, 500] as [number, number, number, number], scale: 0.5, rem: 16 };
        const [outline, word] = nozzleBoxMarks([0.1, 0.2, 0.3, 0.4], shown);
        expect(outline).toMatchObject({ kind: "line", closed: true, tone: "nozzle", points: [[100, 100], [300, 100], [300, 200], [100, 200]] });
        // 0.75 rem at 0.5 screen px a picture px: 24 px of the picture.
        expect(word).toMatchObject({ kind: "text", text: "nozzle", size: 24 });
        expect(nozzleBoxMarks(null, shown)).toEqual([]);
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
    function mounted(rides = true, orientation?: { roll: number; mirror: boolean }, key = `test-${rides}`) {
        const { ctx } = setup();
        const moves: [number, number][] = [];
        const view = mountPicture({
            key,
            label: "Test camera",
            rides,
            running: () => true,
            frameUrl: (width, overlay) => `data:image/svg+xml,w=${width}&o=${overlay ? 1 : 0}`,
            pcbvOverlay: () => false,
            size: () => [1000, 500],
            calibration: () => ({ mmPerPx: 0.1, roll: orientation?.roll ?? 0, mirror: orientation?.mirror ?? false }),
            ...(orientation ? { orientation: () => orientation } : {}),
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

    test("a pick armed on a picture takes its next click, and only that one", async () => {
        const { view, stage, moves } = mounted();
        const picked: [number, number][] = [];
        armPick("test-true", "the pads show", (point) => picked.push(point));
        expect(armedPick("test-true")).toBe("the pads show");
        expect(stage.classList.contains("picking")).toBe(true);
        expect(view.root.querySelector(".picture-pick")?.textContent).toBe("Click the picture where the pads show.");
        pointer(stage, "pointerdown", 250, 125);
        pointer(stage, "pointerup", 251, 125);
        await settle();
        // The click lands on the picture's center, 500, 250 of its 1000 by 500 px; nothing moves.
        expect(picked).toEqual([[500, 250]]);
        expect(moves).toHaveLength(0);
        expect(armedPick("test-true")).toBeNull();
        expect(stage.classList.contains("picking")).toBe(false);
        pointer(stage, "pointerdown", 100, 100);
        pointer(stage, "pointerup", 100, 100);
        expect(picked).toHaveLength(1);
        // Cancel takes a pick off.
        armPick("test-true", "x", () => picked.push([0, 0]));
        disarmPick("test-true");
        pointer(stage, "pointerdown", 100, 100);
        pointer(stage, "pointerup", 100, 100);
        expect(picked).toHaveLength(1);
        view.stop();
    });

    test("a box pick takes the next drag as a box of the full size picture, not a move; a click leaves it armed", async () => {
        const { view, stage, moves } = mounted();
        const boxes: [number, number, number, number][] = [];
        armBox("test-true", "the nozzle", (box) => boxes.push(box));
        expect(view.root.querySelector(".picture-pick")?.textContent).toBe("Drag a box on the picture around the nozzle.");
        pointer(stage, "pointerdown", 100, 100);
        pointer(stage, "pointerup", 101, 100);
        expect(boxes).toHaveLength(0);
        expect(armedPick("test-true")).toBe("the nozzle");
        // Dragged up and left: the box comes corner first, up and left.
        pointer(stage, "pointerdown", 300, 150);
        pointer(stage, "pointermove", 200, 50);
        expect(view.root.querySelector(".mark-box")).not.toBeNull();
        pointer(stage, "pointerup", 200, 50);
        await settle();
        expect(boxes).toEqual([[400, 100, 600, 300]]);
        expect(moves).toHaveLength(0);
        expect(armedPick("test-true")).toBeNull();
        view.stop();
    });

    test("Upright turns a camera upside down the right way up, and the pointer follows the turn", async () => {
        const { view, stage, moves } = mounted(true, { roll: 180, mirror: false }, "test-upright");
        expect(stage.style.transform).toBe("rotate(-180deg)");
        const button = [...view.root.querySelectorAll("button")].find((node) => node.textContent === "Upright")!;
        expect(button.getAttribute("aria-pressed")).toBe("true");
        expect(button.title).toContain("turned 180 degrees");
        const picked: [number, number][] = [];
        // A click up and left of the center lands down and right of the picture's own center.
        armPick("test-upright", "here", (point) => picked.push(point));
        pointer(stage, "pointerdown", 100, 50);
        pointer(stage, "pointerup", 100, 50);
        expect(picked[0]![0]).toBeCloseTo(800, 9);
        expect(picked[0]![1]).toBeCloseTo(400, 9);
        // A drag to the right on the screen still moves the riding camera's head to -X: the picture follows the pointer.
        pointer(stage, "pointerdown", 100, 100);
        pointer(stage, "pointerup", 150, 100);
        await settle();
        expect(moves[0]![0]).toBeCloseTo(-10, 9);
        expect(moves[0]![1]).toBeCloseTo(0, 9);
        // Switched off: the picture as the camera gives it, kept for the camera.
        click(view.root, "Upright");
        expect(stage.style.transform).toBe("");
        expect(button.getAttribute("aria-pressed")).toBe("false");
        armPick("test-upright", "here", (point) => picked.push(point));
        pointer(stage, "pointerdown", 100, 50);
        pointer(stage, "pointerup", 100, 50);
        expect(picked[1]).toEqual([200, 100]);
        click(view.root, "Upright");
        view.stop();
    });

    test("a quarter turn stands the picture on its side, and the screen's up is the picture's right", () => {
        const { view, stage } = mounted(true, { roll: 90, mirror: false }, "test-quarter");
        expect(stage.style.transform).toBe("rotate(-90deg)");
        // On its side the stage's box on the screen is 250 wide by 500 high.
        stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 250, height: 500, right: 250, bottom: 500, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
        const picked: [number, number][] = [];
        armPick("test-quarter", "here", (point) => picked.push(point));
        pointer(stage, "pointerdown", 125, 50);
        pointer(stage, "pointerup", 125, 50);
        expect(picked[0]![0]).toBeCloseTo(900, 9);
        expect(picked[0]![1]).toBeCloseTo(250, 9);
        view.stop();
    });

    test("a picture without an orientation has no Upright", () => {
        const { view, stage } = mounted();
        expect([...view.root.querySelectorAll("button")].some((node) => node.textContent === "Upright")).toBe(false);
        expect(stage.style.transform).toBe("");
        view.stop();
    });

    test("Turn turns the picture a quarter clockwise each press over Upright's turn, kept for the camera, and the pointer follows", async () => {
        const { view, stage, moves } = mounted(true, { roll: 180, mirror: false }, "test-turn");
        expect(stage.style.transform).toBe("rotate(-180deg)");
        click(view.root, "Turn");
        // Upright's half turn and a quarter clockwise: three quarters counterclockwise.
        expect(stage.style.transform).toBe("rotate(-90deg)");
        expect(localStorage.getItem("spinny.picture.test-turn.turn")).toBe("3");
        const turnButton = [...view.root.querySelectorAll("button")].find((node) => node.textContent === "Turn")!;
        expect(turnButton.title).toContain("90 degrees clockwise by hand");
        // On its side the stage's box on the screen is 250 wide by 500 high.
        stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 250, height: 500, right: 250, bottom: 500, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
        // Upright put +X to the right; a quarter clockwise more puts +Y
        // there. A drag to the right moves the riding camera's head to -Y,
        // so the picture follows the pointer.
        pointer(stage, "pointerdown", 100, 100);
        pointer(stage, "pointerup", 150, 100);
        await settle();
        expect(moves[0]![0]).toBeCloseTo(0, 9);
        expect(moves[0]![1]).toBeCloseTo(-10, 9);
        // A new picture of the same camera starts turned as it was left.
        view.stop();
        const again = mounted(true, { roll: 180, mirror: false }, "test-turn");
        expect(again.stage.style.transform).toBe("rotate(-90deg)");
        for (let press = 0; press < 3; press++) {
            click(again.view.root, "Turn");
        }
        expect(again.stage.style.transform).toBe("rotate(-180deg)");
        expect(localStorage.getItem("spinny.picture.test-turn.turn")).toBe("0");
        again.view.stop();
    });

    test("zoomed out past the picture the marks' view takes in the room around it, and Reset view brings the whole picture back", () => {
        const { view } = mounted(false, undefined, "test-out");
        const marks = view.root.querySelector(".picture-marks") as SVGElement;
        view.setZoom(0.5);
        expect(view.zoom()).toBe(0.5);
        const [x, y, width, height] = (marks.getAttribute("viewBox") ?? "").split(" ").map(Number);
        // A 1000 by 500 picture at a half: a view twice its size about its center.
        expect(width).toBeCloseTo(2000, 2);
        expect(height).toBeCloseTo(1000, 2);
        expect(x).toBeCloseTo(-500, 2);
        expect(y).toBeCloseTo(-250, 2);
        click(view.root, "Reset view");
        expect(view.zoom()).toBe(1);
        expect(Number((marks.getAttribute("viewBox") ?? "").split(" ")[2])).toBeCloseTo(1000, 2);
        view.stop();
    });

    test("spots found stay over the picture, following the machine, until Clear marks; one cleared does not come back", () => {
        const { ctx } = setup();
        let spots: ShownSpot[] | null = null;
        let center: [number, number] = [50, 20];
        const view = mountPicture({
            key: "test-kept",
            label: "Test camera",
            rides: true,
            running: () => true,
            frameUrl: (width) => `data:image/svg+xml,w=${width}`,
            pcbvOverlay: () => false,
            size: () => [1000, 500],
            calibration: () => ({ mmPerPx: 0.1, roll: 0, mirror: false }),
            center: () => center,
            marks: () => [],
            spots: () => spots,
            move: async () => undefined,
            noScale: "no scale",
            visible: () => true,
        }, ctx);
        document.body.append(view.root);
        const layer = view.root.querySelector(".picture-marks") as SVGElement;
        const ellipses = (): number[] => [...layer.querySelectorAll("ellipse")].map((node) => Number(node.getAttribute("cx")));
        const clear = [...view.root.querySelectorAll("button")].find((node) => node.textContent === "Clear marks")!;
        const spot = (dx: number) => ({ found: true, dx, dy: 0, major: 20, minor: 10 });
        // A look from before the picture showed is not drawn; a routine under way is.
        spots = [{ key: "look old", spot: spot(-100), tone: "look" }];
        view.render(ctx.store.get());
        expect(ellipses()).toEqual([]);
        expect(clear.disabled).toBe(true);
        spots = [{ key: "look old", spot: spot(-100), tone: "look" }, { key: "routine a", spot: spot(10), tone: "spot", live: true }];
        view.render(ctx.store.get());
        expect(ellipses()).toEqual([510]);
        expect(clear.disabled).toBe(false);
        // The head moves 1 mm to +X: the spot keeps over what it marks, 10 px to the left.
        center = [51, 20];
        view.render(ctx.store.get());
        expect(ellipses()).toEqual([500]);
        // Switched to stay with the picture, it is drawn where it was found.
        click(view.root, "View");
        [...document.querySelectorAll<HTMLButtonElement>(".menu-item")].find((node) => node.textContent === "Marks follow the machine")!.click();
        expect(ellipses()).toEqual([510]);
        expect(localStorage.getItem("spinny.picture.test-kept.follow")).toBe("0");
        // The routine's next look joins it; the state no longer showing the first takes nothing away.
        spots = [{ key: "routine b", spot: spot(20), tone: "spot" }];
        view.render(ctx.store.get());
        expect(ellipses()).toEqual([510, 520]);
        clear.click();
        expect(ellipses()).toEqual([]);
        view.render(ctx.store.get());
        expect(ellipses()).toEqual([]);
        localStorage.removeItem("spinny.picture.test-kept.follow");
        view.stop();
    });

    test("Edges draws the straight edges pcbv finds while on, scaled to the picture, and says why when they cannot be had", async () => {
        const { ctx } = setup();
        let fail = false;
        let asked = 0;
        const view = mountPicture({
            key: "test-edges",
            label: "Test camera",
            rides: true,
            running: () => true,
            frameUrl: (width) => `data:image/svg+xml,w=${width}`,
            pcbvOverlay: () => false,
            size: () => [1000, 500],
            calibration: () => null,
            center: () => null,
            marks: () => [],
            edges: async () => {
                asked += 1;
                if (fail) {
                    throw new Error("the camera is busy");
                }
                return { camera: "head", lines: [{ x0: 10, y0: 20, x1: 110, y1: 20, length: 100, contrast: 40 }], width: 500, height: 250 };
            },
            move: async () => undefined,
            noScale: "no scale",
            visible: () => true,
        }, ctx);
        document.body.append(view.root);
        const layer = view.root.querySelector(".picture-marks") as SVGElement;
        view.render(ctx.store.get());
        expect(asked).toBe(0);
        click(view.root, "Edges");
        await settle();
        const line = layer.querySelector("polyline.mark-edge");
        // pcbv measured a picture half the size: its ends doubled.
        expect(line?.getAttribute("points")).toBe("20.00,40.00 220.00,40.00");
        expect(line?.querySelector("title")?.textContent).toBe("edge 1 of 1, the strongest first: 100 px, contrast 40");
        expect(localStorage.getItem("spinny.picture.test-edges.edges")).toBe("1");
        // Off: nothing drawn and nothing asked.
        click(view.root, "Edges");
        await settle();
        expect(layer.querySelector(".mark-edge")).toBeNull();
        const before = asked;
        view.refresh(true);
        await settle();
        expect(asked).toBe(before);
        // On again and refused: no lines, and the button says why.
        fail = true;
        click(view.root, "Edges");
        await settle();
        const edges = [...view.root.querySelectorAll("button")].find((node) => node.textContent === "Edges")!;
        expect(edges.title).toContain("the camera is busy");
        expect(layer.querySelector(".mark-edge")).toBeNull();
        localStorage.removeItem("spinny.picture.test-edges.edges");
        view.stop();
    });

    test("the View menu sets the crosshair's shape and size, kept for the camera", () => {
        const { view } = mounted(false, undefined, "test-crosshair");
        const layer = view.root.querySelector(".picture-marks") as SVGElement;
        expect(layer.querySelectorAll("polyline.mark-center")).toHaveLength(2);
        const pick = (label: string): void => {
            click(view.root, "View");
            const item = [...document.querySelectorAll<HTMLButtonElement>(".menu-item")].find((node) => node.textContent === label);
            expect(item).toBeDefined();
            item!.click();
        };
        pick("Circle");
        expect(layer.querySelectorAll("polyline.mark-center")).toHaveLength(0);
        const ring = layer.querySelector("circle.mark-center");
        // A small circle: a fortieth of the 1000 px view.
        expect(Number(ring?.getAttribute("r"))).toBeCloseTo(25, 6);
        pick("Large crosshair");
        expect(Number(layer.querySelector("circle.mark-center")?.getAttribute("r"))).toBeCloseTo(250, 6);
        expect(localStorage.getItem("spinny.picture.test-crosshair.crosshair")).toBe("circle");
        expect(localStorage.getItem("spinny.picture.test-crosshair.crosshair.size")).toBe("large");
        pick("No crosshair");
        expect(layer.querySelector(".mark-center")).toBeNull();
        localStorage.removeItem("spinny.picture.test-crosshair.crosshair");
        localStorage.removeItem("spinny.picture.test-crosshair.crosshair.size");
        view.stop();
    });

    test("a zoom typed in is taken on Enter, held within range, and the buttons step from it", () => {
        const { view } = mounted(false);
        const field = view.root.querySelector('input[aria-label="Test camera zoom"]') as HTMLInputElement;
        const img = view.root.querySelector("img.picture-img") as HTMLImageElement;
        const marks = view.root.querySelector(".picture-marks") as SVGElement;
        expect(field.value).toBe("1");
        field.value = "2.5";
        field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        expect(view.zoom()).toBe(2.5);
        // The marks' view box is the part the zoom shows; the frame asked
        // for is the full size, since 500 px shown at 2.5 need 1250.
        const width = Number((marks.getAttribute("viewBox") ?? "").split(" ")[2]);
        expect(width).toBeCloseTo(400, 2);
        expect(img.getAttribute("src")).toBe("data:image/svg+xml,w=1000&o=0");
        // Arithmetic works as in any number field; past the end is held there.
        field.value = "5/2*2";
        field.dispatchEvent(new Event("change"));
        expect(view.zoom()).toBe(5);
        field.value = "20";
        field.dispatchEvent(new Event("change"));
        expect(view.zoom()).toBe(8);
        expect(field.value).toBe("8");
        // No number: the zoom stays and its words come back.
        field.value = "abc";
        field.dispatchEvent(new Event("change"));
        expect(view.zoom()).toBe(8);
        expect(field.value).toBe("8");
        expect(field.classList.contains("invalid")).toBe(false);
        // The - and + are the ends of the field's own box, the x inside it.
        const box = field.closest(".stepper")!;
        expect(Array.from(box.querySelectorAll("button")).map((node) => node.textContent)).toEqual(["-", "+"]);
        expect(box.querySelector(".stepper-unit")?.textContent).toBe("x");
        // The buttons go to the step beside a zoom typed in, and say it in the field.
        view.setZoom(2.5);
        click(view.root, "-");
        expect(view.zoom()).toBe(2);
        view.setZoom(2.5);
        click(view.root, "+");
        expect(view.zoom()).toBe(3);
        expect(field.value).toBe("3");
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
        // A look with no guesses: the newest pose's picture.
        placeLookView(drawn.root, box, { job: "a1", found: true, view: [[0, 0], [10, 0], [10, 5], [0, 5]], seen: [5, 2.5] }, "top camera", 0.5, "a1");
        expect(drawn.root.querySelector(".pnp-look.found polygon")).not.toBeNull();
        placeLookView(drawn.root, box, { job: null }, "top camera", 0.5, "a1");
        expect(drawn.root.querySelector(".pnp-look")).toBeNull();
        // Guesses: the most likely and those at or over the threshold, each
        // where it says the picture lies, labeled; one ruled out is left out.
        const guess = (probability: number, x: number, ruled = false) => ({
            rotation: 0, shift: [0, 0] as [number, number], center: [0, 0] as [number, number], rms: 0, looks: 5, probability, share: probability,
            spread_mm: 0, spread_deg: 0, ruled_out: ruled, corner_mm: null, view: [[x, 0], [x + 4, 0], [x + 4, 3], [x, 3]] as [number, number][], seen: [x + 2, 1.5] as [number, number],
        });
        const look = {
            job: "a1", found: false, guesses: [guess(0.45, 0), guess(0.35, 5), guess(0.2, 10), guess(0, 15, true)],
            corners: { job: "a1", points: [{ corner: "bottom left" as const, job: [0, 0] as [number, number], machine: [100, 50] as [number, number] }], rough: null },
        };
        placeLookView(drawn.root, box, look, "top camera", 0.3, "a1");
        const labels = Array.from(drawn.root.querySelectorAll(".pnp-guess text")).map((text) => text.textContent);
        expect(labels).toEqual(["#1 45%", "#2 35%"]);
        expect(drawn.root.querySelectorAll(".pnp-guess.under").length).toBe(0);
        expect(drawn.root.querySelectorAll(".pnp-corner circle").length).toBe(1);
        // Over the line only the most likely is left, dashed under it; another job's look draws nothing.
        placeLookView(drawn.root, box, look, "top camera", 0.6, "a1");
        expect(Array.from(drawn.root.querySelectorAll(".pnp-guess")).map((group) => group.getAttribute("class"))).toEqual(["pnp-guess under"]);
        placeLookView(drawn.root, box, look, "top camera", 0.6, "b2");
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
