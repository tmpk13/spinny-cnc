import { describe, expect, test } from "bun:test";

import { boardLayers, isDrawingLayer, layerChoiceText, layerKind } from "../src/kicad.ts";

const BOARD = new URL("../../../toolpath/tests/data/board.kicad_pcb", import.meta.url);

describe("a KiCad board's layers", () => {
    test("are the table's, with what is drawn on each", async () => {
        const layers = boardLayers(await Bun.file(BOARD).text());
        expect(layers.length).toBe(24);
        expect(layers.slice(0, 2).map((layer) => layer.name)).toEqual(["F.Cu", "B.Cu"]);
        const by = (name: string) => layers.find((layer) => layer.name === name)!;
        // What the backend finds on them: paste on the front, none behind.
        expect(by("F.Paste").items).toBe(32);
        expect(by("B.Paste").items).toBe(0);
        expect(by("F.Cu").items).toBeGreaterThan(32);
        expect(by("Edge.Cuts").items).toBe(1);
        expect(by("User.1").items).toBe(0);
        // A hidden text draws nothing: the datasheet on F.Fab is hidden.
        expect(by("F.Fab").items).toBe(3);
        expect(by("F.SilkS").shown).toBe("F.Silkscreen");
        expect(by("Dwgs.User").shown).toBe("User.Drawings");
        expect(by("F.Cu").shown).toBeNull();
        expect(by("F.Cu").type).toBe("signal");
    });

    test("count a pad on every layer its wildcards name, once", () => {
        const text = `(kicad_pcb (version 20240108)
            (layers (0 "F.Cu" signal) (1 "In1.Cu" signal) (31 "B.Cu" signal) (38 "B.Mask" user) (39 "F.Mask" user) (44 "User.1" user "Logo"))
            (setup (stackup (layer "F.Mask" (type "Top Solder Mask"))))
            (footprint "x" (layer "F.Cu")
                (pad "1" thru_hole circle (at 0 0) (size 1 1) (drill 0.5) (layers "*.Cu" "*.Mask"))
                (pad "2" smd rect (at 1 0) (size 1 1) (layers "F&B.Cu"))
                (fp_text reference "R1" (at 0 0) (layer "User.1") hide (effects (font (size 1 1))))
                (property "Value" "10k" (at 0 0 0) (layer "User.1") (effects (font (size 1 1)) (hide yes))))
            (gr_line (start 0 0) (end 1 1) (layer "User.1") (width 0.1))
            (gr_poly (pts (xy 0 0) (arc (start 0 0) (mid 1 1) (end 2 0))) (layer "F.Mask")))`;
        const layers = boardLayers(text);
        const items = Object.fromEntries(layers.map((layer) => [layer.name, layer.items]));
        expect(items).toEqual({ "F.Cu": 2, "In1.Cu": 1, "B.Cu": 2, "B.Mask": 1, "F.Mask": 2, "User.1": 1 });
        expect(layers.find((layer) => layer.name === "User.1")!.shown).toBe("Logo");
    });

    test("read an old file's bare names, and nothing from text with no table", () => {
        const old = "(kicad_pcb (version 4) (layers (0 F.Cu signal) (31 B.Cu signal) (44 Edge.Cuts user)) (gr_line (start 0 0) (end 1 0) (layer Edge.Cuts) (width 0.15)) (module R (layer F.Cu) (pad 1 smd rect (at 0 0) (size 1 1) (layers F.Cu F.Paste))))";
        expect(boardLayers(old).map((layer) => [layer.name, layer.items])).toEqual([["F.Cu", 1], ["B.Cu", 0], ["Edge.Cuts", 1]]);
        expect(boardLayers("(kicad_pcb)")).toEqual([]);
        expect(boardLayers("not a board")).toEqual([]);
    });

    test("say what each layer is, and which are drawings to cut on their lines", () => {
        expect(layerKind("In2.Cu")).toBe("copper");
        expect(layerKind("B.SilkS")).toBe("silk");
        expect(layerKind("Edge.Cuts")).toBe("outline");
        expect(layerKind("User.3")).toBe("drawing");
        expect(layerKind("Margin")).toBe("margin");
        expect(["F.Cu", "F.Paste", "B.Mask"].map(isDrawingLayer)).toEqual([false, false, false]);
        expect(["Edge.Cuts", "F.SilkS", "Dwgs.User", "User.1", "F.Fab", "F.CrtYd"].map(isDrawingLayer)).toEqual([true, true, true, true, true, true]);
        expect(layerChoiceText({ name: "F.SilkS", shown: "F.Silkscreen", type: "user", items: 1 })).toBe("F.SilkS (F.Silkscreen): 1 item");
        expect(layerChoiceText({ name: "B.Cu", shown: null, type: "signal", items: 0 })).toBe("B.Cu: empty");
    });
});
