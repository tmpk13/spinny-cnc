import { describe, expect, test } from "bun:test";

import { initialState, type AppState } from "../src/state.ts";
import { bottomKnown, headKnown, knownMarks, type KnownPoint, LABEL_REM, placedBy, RING_REM, topKnown } from "../src/views/known.ts";
import { type Mark, mountPicture, type PictureShown } from "../src/views/picture.ts";
import { connected, setup } from "./harness.ts";

const calibration = { mmPerPx: 0.1, roll: 0, mirror: false };

/** A 1000 by 500 px picture shown 500 CSS px wide at a zoom, a rem of 16 px. */
function shownAt(zoom: number): PictureShown {
    const width = 1000 / zoom;
    const height = 500 / zoom;
    return { size: [1000, 500], region: [500 - width / 2, 250 - height / 2, width, height], scale: 500 / width, rem: 16 };
}

function point(at: [number, number], label: string): KnownPoint {
    return { at, label, title: label };
}

function rings(marks: Mark[]): Extract<Mark, { kind: "circle" }>[] {
    return marks.filter((mark): mark is Extract<Mark, { kind: "circle" }> => mark.kind === "circle");
}

function labels(marks: Mark[]): Extract<Mark, { kind: "text" }>[] {
    return marks.filter((mark): mark is Extract<Mark, { kind: "text" }> => mark.kind === "text");
}

describe("known points on a picture", () => {
    test("a point ringed at one screen size, labeled beside it; one outside the view left out", () => {
        // The picture's center sees 50, 20; 10 mm right is 100 px right.
        const marks = knownMarks([point([60, 20], "FID1"), point([200, 20], "far")], [50, 20], calibration, shownAt(1));
        const [ring] = rings(marks);
        // 0.75 rem of 16 px on a picture shown at half its px: 24 picture px.
        expect(rings(marks)).toHaveLength(1);
        expect(ring).toMatchObject({ x: 600, y: 250, tone: "known" });
        expect(ring!.r).toBeCloseTo((RING_REM * 16) / 0.5, 9);
        const [label] = labels(marks);
        expect(label).toMatchObject({ text: "FID1", anchor: "start" });
        expect(label!.size).toBeCloseTo((LABEL_REM * 16) / 0.5, 9);
        expect(label!.x).toBeGreaterThan(600 + ring!.r);
        // Zoomed in fourfold: the ring keeps its size on the screen, a quarter of the picture's px.
        const zoomed = rings(knownMarks([point([52, 20], "FID1")], [50, 20], calibration, shownAt(4)));
        expect(zoomed[0]!.r).toBeCloseTo(ring!.r / 4, 9);
        // At that zoom the view spans x 375 to 625 px: 70 mm (700 px) is out of it.
        expect(knownMarks([point([70, 20], "FID1")], [50, 20], calibration, shownAt(4))).toEqual([]);
        // No place for the center, or no scale: nothing.
        expect(knownMarks([point([60, 20], "FID1")], null, calibration, shownAt(1))).toEqual([]);
        expect(knownMarks([point([60, 20], "FID1")], [50, 20], null, shownAt(1))).toEqual([]);
    });

    test("a label near the view's right edge goes to the left of its ring; crowded labels are dropped, their rings kept", () => {
        const edge = labels(knownMarks([point([98, 20], "home")], [50, 20], calibration, shownAt(1)));
        expect(edge[0]).toMatchObject({ text: "home", anchor: "end" });
        // Two points a ring apart: the first takes the right, the second the left.
        const pair = labels(knownMarks([point([50, 20], "A1"), point([54, 20], "A2")], [50, 20], calibration, shownAt(1)));
        expect(pair.map((label) => [label.text, label.anchor])).toEqual([["A1", "end"], ["A2", "start"]]);
        // A cluster of ten in a few mm: every ring, few words.
        const crowd = Array.from({ length: 10 }, (_, index) => point([50 + (index % 5), 20 + Math.floor(index / 5)], `M${index + 1}`));
        const marks = knownMarks(crowd, [50, 20], calibration, shownAt(1));
        expect(rings(marks)).toHaveLength(10);
        expect(labels(marks).length).toBeLessThan(4);
        // The first ones get the room.
        expect(labels(marks).map((label) => label.text)).toContain("M1");
    });

    test("an estimate turns and shifts a point of the job's frame onto the machine", () => {
        const [x, y] = placedBy({ rotation: 90, shift: [100, 50] }, [10, 0]);
        expect(x).toBeCloseTo(100, 9);
        expect(y).toBeCloseTo(60, 9);
    });
});

function withState(patch: Partial<AppState>): AppState {
    return { ...initialState(true), ...patch };
}

const job = { id: "a1", name: "board", outline: [], groups: [] } as unknown as AppState["job"];
const fiducial = (ref: string, x: number, y: number) => ({ ref, value: "", footprint: "Fiducial", side: "front" as const, x, y, rotation: 0, pads: 1, smd: true, dnp: false, fiducial: true });

describe("which points each camera rings", () => {
    test("the head camera: the job's align marks, its fiducials, the corners, the mark and the markers", () => {
        const look = { job: "a1", found: false, estimate: { rotation: 90, shift: [100, 50] as [number, number], center: [0, 0] as [number, number], rms: 0 },
            corners: { job: "a1", points: [{ corner: "bottom left" as const, job: [0, 0] as [number, number], machine: [5, 6] as [number, number] }], rough: null } };
        const state = withState({
            job,
            align: { job: "a1", marks: [{ design: [1, 1], machine: [1.2, 0.9], source: "camera", kind: "center", distance: 0, angle: 0, residual: null }], fit: null },
            components: { job: "a1", components: [fiducial("FID1", 10, 0), { ...fiducial("R1", 3, 3), fiducial: false }], note: null },
            markers: [{ name: "M1", x: 7, y: 8 }],
            camera: { mark: [2, 3], board_look: look } as unknown as AppState["camera"],
        });
        const points = headKnown(state);
        expect(points.map((entry) => entry.label)).toEqual(["A1", "FID1", "bottom left", "mark", "M1"]);
        expect(points[0]!.at).toEqual([1.2, 0.9]);
        // Not found: the fiducial where the job lies.
        expect(points[1]!.at).toEqual([10, 0]);
        expect(points[2]!.at).toEqual([5, 6]);
        // Found: where the looks put the board.
        const found = headKnown(withState({ ...state, camera: { board_look: { ...look, found: true } } as unknown as AppState["camera"] }));
        const at = found.find((entry) => entry.label === "FID1")!.at;
        expect(at[0]).toBeCloseTo(100, 9);
        expect(at[1]).toBeCloseTo(60, 9);
        // Another job's marks, parts and corners are not this one's; the markers stay.
        const other = headKnown(withState({ ...state, job: { ...job!, id: "b2" } }));
        expect(other.map((entry) => entry.label)).toEqual(["mark", "M1"]);
    });

    test("the top camera: fiducials found or placed by the look, parts taken by hand, corners, its mark and the home fiducial", () => {
        const state = withState({
            job,
            components: { job: "a1", components: [fiducial("FID1", 0, 0), fiducial("FID2", 10, 0)], note: null },
            placing: {
                references: [
                    { job: "a1", ref: "R1", at: [30, 40], by: "nozzle" },
                    { job: "a1", ref: "R2", at: [31, 41], by: "look" },
                    { job: "a1", ref: "U1", at: [32, 42] },
                ],
                document: { top: { home_fiducial: [1, 2] } },
                top: {
                    mark_at: [3, 4],
                    fiducials: { job: "a1", found: [{ ref: "FID1", at: [20, 20] }], fit: {} },
                    board_look: { job: "a1", found: true, estimate: { rotation: 0, shift: [100, 0], center: [0, 0], rms: 0 } },
                },
            } as unknown as AppState["placing"],
        });
        const points = topKnown(state);
        expect(points.map((entry) => entry.label)).toEqual(["FID1", "FID2", "R1", "U1", "mark", "home"]);
        expect(points[0]!.at).toEqual([20, 20]);
        expect(points[1]!.at).toEqual([110, 0]);
        expect(points[5]!.at).toEqual([1, 2]);
    });

    test("the bottom camera: the nozzle from the head's place, the center the camera's place", () => {
        const gcode = bottomKnown(withState({ placing: { camera: { position: [100, 50] }, position: { x: 101, y: 50 } } as unknown as AppState["placing"] }), true);
        expect(gcode).toEqual({ center: [100, 50], points: [{ at: [101, 50], label: "nozzle", title: "the nozzle's tip where the head's place puts it" }] });
        const own = bottomKnown(withState({ snapshot: connected({ joint: { r: 40, a: 0, z: 12, h: 0 } }), pnp: { position: [40.5, 12] } as unknown as AppState["pnp"] }), false);
        expect(own.center).toEqual([40.5, 12]);
        expect(own.points[0]!.at).toEqual([40, 12]);
        // Not connected: no place for the nozzle.
        expect(bottomKnown(withState({ pnp: { position: [40.5, 12] } as unknown as AppState["pnp"] }), false).points).toEqual([]);
    });
});

describe("the picture draws them", () => {
    test("rings and labels go with the overlay, the labels sized for the screen", () => {
        const { ctx } = setup();
        const view = mountPicture({
            key: "known-test",
            label: "Test camera",
            rides: true,
            running: () => true,
            frameUrl: (width) => `data:image/svg+xml,w=${width}`,
            pcbvOverlay: () => false,
            size: () => [1000, 500],
            calibration: () => calibration,
            center: () => [50, 20],
            marks: (_state, shown) => knownMarks([point([60, 20], "FID1")], [50, 20], calibration, shown),
            move: async () => undefined,
            noScale: "no scale",
            visible: () => true,
        }, ctx);
        document.body.append(view.root);
        const stage = view.root.querySelector(".picture-stage") as HTMLElement;
        stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 500, height: 250, right: 500, bottom: 250, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
        view.render(ctx.store.get());
        const text = view.root.querySelector("text.mark-label");
        expect(text?.textContent).toBe("FID1");
        // happy-dom's rem is 16 px: 0.75 rem on a 500 px stage of a 1000 px picture.
        expect(Number(text?.getAttribute("font-size"))).toBeCloseTo(24, 2);
        expect(view.root.querySelector("circle.mark-known")).not.toBeNull();
        const overlay = Array.from(view.root.querySelectorAll("button")).find((button) => button.textContent === "Overlay")!;
        overlay.click();
        expect(view.root.querySelector("text.mark-label")).toBeNull();
        expect(view.root.querySelector("circle.mark-known")).toBeNull();
        overlay.click();
        view.stop();
    });
});
