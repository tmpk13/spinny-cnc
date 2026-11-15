import { describe, expect, test } from "bun:test";

import { checkedBox, MockMachineViews, pictureType } from "../src/mock/machineview.ts";
import { parseStl, shadePixels, stlTriangleCount, topShades, topSize } from "../src/stl.ts";
import { areaText, boxOf, clampBox, clientToMachine, machineBox, mountMachineView, placesBox, roundBox, viewExtent } from "../src/views/machineview.ts";
import type { GcodeDocument } from "../src/types.ts";
import { connectGcode } from "./gcoderig.ts";
import { click, findButton, setup, settle } from "./harness.ts";

/** A binary STL of the triangles given, nine numbers each; its header starts with `solid`, as some binary files do. */
function binaryStl(triangles: number[][]): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(84 + 50 * triangles.length);
    bytes.set(new TextEncoder().encode("solid but binary"));
    const view = new DataView(bytes.buffer);
    view.setUint32(80, triangles.length, true);
    triangles.forEach((corners, index) => {
        corners.forEach((value, k) => view.setFloat32(84 + index * 50 + 12 + k * 4, value, true));
    });
    return bytes;
}

const ASCII = `solid box
  facet normal 0 0 1
    outer loop
      vertex 0 0 0
      vertex 1 0 0
      vertex 0 1 0
    endloop
  endfacet
endsolid box
`;

/** A square from x0, y0 to x1, y1 at height z, as two triangles. */
function square(x0: number, y0: number, x1: number, y1: number, z: number): number[][] {
    return [[x0, y0, z, x1, y0, z, x1, y1, z], [x0, y0, z, x1, y1, z, x0, y1, z]];
}

describe("the machine view's geometry", () => {
    test("a pointer over the drawing fitted whole is a machine point, +Y up", () => {
        // A 200 by 100 mm extent in a 400 by 400 px box: 2 px a mm, centered, with 100 px above and below.
        const rect = { left: 10, top: 20, width: 400, height: 400 };
        const extent: [number, number, number, number] = [0, 0, 200, 100];
        expect(clientToMachine(10, 120, rect, extent)).toEqual([0, 100]);
        expect(clientToMachine(410, 320, rect, extent)).toEqual([200, 0]);
        expect(clientToMachine(210, 220, rect, extent)).toEqual([100, 50]);
    });

    test("boxes are made from corners, cut to the bed and rounded to a tenth", () => {
        expect(boxOf([5, 9], [1, 2])).toEqual([1, 2, 5, 9]);
        expect(clampBox([0, 0, 100, 100], [20, 60, 450, 550])).toEqual([20, 60, 100, 100]);
        expect(clampBox([0, 0, 10, 10], [20, 60, 450, 550])).toBeNull();
        expect(clampBox([0, 0, 10, 10], null)).toEqual([0, 0, 10, 10]);
        expect(roundBox([1.04, 2.06, -0.04, 3])).toEqual([1, 2.1, 0, 3]);
    });

    test("the machine is the file's travel, else the box round the places it names; the view has a margin", () => {
        const doc = {
            park: [42, 411],
            camera_position: [61.9, 219.8],
            discard: null,
            slots: [{ address: 1, at: [100, 30, 12], rotation: 0 }],
            feeders: [],
            top: { z: null, offset: null, fiducial: "bright", within: 2, bed: [24, 66, 456, 552], home_fiducial: [60, 175] },
        } as unknown as GcodeDocument;
        expect(placesBox(doc)).toEqual([24, 30, 456, 552]);
        expect(machineBox(doc)).toEqual([24, 30, 456, 552]);
        expect(machineBox({ ...doc, travel: [0, 0, 433, 487] })).toEqual([0, 0, 433, 487]);
        expect(viewExtent([0, 0, 200, 100])).toEqual([-10, -10, 210, 110]);
        expect(viewExtent(null)).toEqual([-55, -55, 55, 55]);
        expect(areaText(doc)).toContain("whole bed");
        expect(areaText({ ...doc, top: { ...doc.top!, board_area: [40, 80, 200, 200], board_area_only: true } })).toContain("never looks outside");
    });
});

describe("STL models", () => {
    test("binary and ASCII files are read and counted, and anything else refused, in the backend's words", () => {
        const binary = binaryStl(square(0, 0, 10, 20, 1));
        expect(stlTriangleCount(binary)).toBe(2);
        const mesh = parseStl(binary);
        expect(mesh.count).toBe(2);
        expect(mesh.box).toEqual([0, 0, 1, 10, 20, 1]);
        const ascii = new TextEncoder().encode(ASCII);
        expect(stlTriangleCount(ascii)).toBe(1);
        expect(parseStl(ascii).box).toEqual([0, 0, 0, 1, 1, 0]);
        expect(() => stlTriangleCount(new TextEncoder().encode("solid nothing\nendsolid\n"))).toThrow("a model must be an STL file");
        expect(() => stlTriangleCount(binary.subarray(0, binary.length - 1))).toThrow("STL");
    });

    test("seen from above the highest surface wins, shaded by how it faces the light", () => {
        // A low square over the whole box, a high one over its left half, and a wall seen edge on.
        const mesh = parseStl(binaryStl([...square(0, 0, 4, 4, 0), ...square(0, 0, 2, 4, 3), [2, 0, 0, 2, 4, 0, 2, 4, 3]]));
        expect(topSize(mesh, 8)).toEqual([8, 8]);
        const flat = topShades(mesh, 4, 4);
        // Every pixel is covered by a flat face: the same shade everywhere, the high one on the left.
        expect(Array.from(flat).every((shade) => Math.abs(shade - flat[0]!) < 1e-6)).toBe(true);
        expect(flat[0]!).toBeGreaterThan(0.25);
        // A face sloping away from the light is darker than a flat one.
        const slope = parseStl(binaryStl([[0, 0, 4, 4, 0, 0, 4, 4, 0], [0, 0, 4, 4, 4, 0, 0, 4, 4]]));
        expect(topShades(slope, 4, 4)[5]!).toBeLessThan(flat[0]!);
        // Nothing over a pixel: clear.
        const half = parseStl(binaryStl([[0, 0, 0, 4, 0, 0, 0, 4, 0]]));
        const shades = topShades(half, 4, 4);
        // Row 0 is the box's top: its right end (3.5, 3.5) is past the triangle's long side, its bottom left (0.5, 0.5) inside.
        expect(shades[3]).toBe(-1);
        const pixels = shadePixels(shades, [0, 0, 0], [255, 255, 255]);
        expect(pixels[3 * 4 + 3]).toBe(0);
        expect(pixels[12 * 4 + 3]).toBe(255);
    });
});

describe("the mock's pictures and models", () => {
    test("told by their bytes and kept with a box, as the backend keeps them", async () => {
        expect(pictureType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("image/png");
        expect(() => pictureType(new TextEncoder().encode("<svg/>"))).toThrow("PNG, JPEG, WebP or GIF");
        expect(() => checkedBox([5, 0, 1, 1])).toThrow("below");
        const views = new MockMachineViews((id) => id === "lumen");
        const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])], "bench.png", { type: "image/png" });
        const state = await views.put("lumen", "picture", png);
        expect(state.picture).toEqual({ name: "bench.png", type: "image/png", bytes: 10, version: 1, box: null });
        expect(views.place("lumen", "picture", [0, 0, 10, 10]).picture?.version).toBe(2);
        const model = await views.put("lumen", "model", new File([binaryStl(square(0, 0, 1, 1, 0))], "m.stl"));
        expect(model.model?.triangles).toBe(2);
        await expect(views.put("lumen", "model", new File([new TextEncoder().encode("nope")], "m.stl"))).rejects.toThrow("STL");
        await expect(views.put("nobody", "picture", png)).rejects.toThrow("no machine file");
        expect(views.remove("lumen", "picture").picture).toBeNull();
    });
});

describe("the Machine view panel", () => {
    /** The view mounted over the mock's LumenPnP, the drawing given a size. */
    async function mounted() {
        const harness = setup();
        await connectGcode(harness.backend, "opulo-lumen-rev5");
        await harness.ctx.refreshPlacing();
        mountMachineView(harness.root, harness.ctx);
        const drawing = harness.root.querySelector(".machine-view-svg") as SVGSVGElement;
        drawing.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 600, right: 600, bottom: 600, x: 0, y: 0, toJSON: () => ({}) });
        return { ...harness, drawing };
    }

    function drag(drawing: SVGSVGElement, from: [number, number], to: [number, number]): void {
        drawing.dispatchEvent(new MouseEvent("pointerdown", { clientX: from[0], clientY: from[1], button: 0, bubbles: true }));
        drawing.dispatchEvent(new MouseEvent("pointermove", { clientX: to[0], clientY: to[1], bubbles: true }));
        drawing.dispatchEvent(new MouseEvent("pointerup", { clientX: to[0], clientY: to[1], bubbles: true }));
    }

    test("draws the travel and the bed, and a drag sets a board area that Save writes into the file", async () => {
        const { root, drawing, store, backend } = await mounted();
        expect(store.get().placing?.machine).toBe("opulo-lumen-rev5");
        expect(root.querySelector(".mv-travel")).not.toBeNull();
        expect(root.querySelector(".mv-travel")?.classList.contains("mv-guessed")).toBe(false);
        expect(root.querySelector(".mv-bed")).not.toBeNull();
        expect(root.querySelector(".mv-area")).toBeNull();
        expect(root.querySelector(".machine-view-area")?.textContent).toContain("whole bed");
        // A drag from the far top left to the middle: cut to the bed's corner.
        drag(drawing, [1, 1], [300, 300]);
        expect(store.get().pending["machine-view"]).toBe(1);
        const area = root.querySelector(".mv-area");
        expect(area).not.toBeNull();
        const fields = Array.from(root.querySelectorAll(".machine-view-fields input")) as HTMLInputElement[];
        expect(fields.map((field) => Number(field.value))[0]).toBe(24);
        expect(Number(fields[3]!.value)).toBe(552);
        // Boards only within it, then saved: both keys in the file.
        const only = root.querySelector("select[aria-label='Boards near or only within the area']") as HTMLSelectElement;
        only.value = "only";
        only.dispatchEvent(new Event("change"));
        click(root, "Save");
        await settle();
        await settle();
        const text = (await backend.machineFile("opulo-lumen-rev5")).text;
        expect(text).toMatch(/^board_area = \[24(\.0)?, [0-9.]+, [0-9.]+, 552(\.0)?\]$/m);
        expect(text).toMatch(/^board_area_only = true$/m);
        expect(store.get().placing?.document?.top?.board_area_only).toBe(true);
        expect(store.get().pending["machine-view"]).toBeUndefined();
        expect(root.querySelector(".mv-area.mv-only")).not.toBeNull();
        expect(root.querySelector(".machine-view-area")?.textContent).toContain("never looks outside");
        // Clear area, saved: both keys out of the file.
        click(root, "Clear area");
        click(root, "Save");
        await settle();
        await settle();
        const cleared = (await backend.machineFile("opulo-lumen-rev5")).text;
        expect(cleared).not.toMatch(/^board_area/m);
        expect(store.get().placing?.document?.top?.board_area ?? null).toBeNull();
    });

    test("a drag off the bed sets nothing, and a click is no drag", async () => {
        const { root, drawing, store } = await mounted();
        drag(drawing, [300, 300], [301, 301]);
        expect(store.get().pending["machine-view"]).toBeUndefined();
        expect(findButton(root, "Save").disabled || findButton(root, "Save").getAttribute("aria-disabled") === "true").toBe(true);
    });

    test("a picture added is drawn over the travel, and over the box a drag sets for it once saved", async () => {
        const { root, drawing, ctx, backend } = await mounted();
        const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])], "bench.png", { type: "image/png" });
        const input = root.querySelector("input[aria-label='Picture of the machine']") as HTMLInputElement;
        Object.defineProperty(input, "files", { value: [png], configurable: true });
        input.dispatchEvent(new Event("change"));
        await settle();
        await settle();
        expect(root.querySelector(".machine-view-file")?.textContent).toBe("Picture: bench.png");
        const image = root.querySelector(".machine-view-picture") as SVGElement;
        expect(image.getAttribute("visibility")).toBe("visible");
        expect([image.getAttribute("x"), image.getAttribute("y"), image.getAttribute("width"), image.getAttribute("height")]).toEqual(["0", "-487", "433", "487"]);
        const pick = root.querySelector("select[aria-label='What a drag sets']") as HTMLSelectElement;
        pick.value = "picture";
        pick.dispatchEvent(new Event("change"));
        drag(drawing, [100, 100], [400, 400]);
        click(root, "Save");
        await settle();
        const kept = await backend.machineView("opulo-lumen-rev5");
        expect(kept.picture?.box).not.toBeNull();
        expect(image.getAttribute("width")).not.toBe("433");
        void ctx;
    });
});
