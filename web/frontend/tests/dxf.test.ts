// The in-page mock's DXF reader, the twin of the toolpath library's: it
// reads the same fixture drawings into the same paths, which the backend's
// reader printed into dxf-samples.json (mise run dxf-fixture), and the mock
// takes a DXF upload the way the backend does.

import { describe, expect, test } from "bun:test";

import fixture from "../../../toolpath/tests/data/dxf-samples.json" with { type: "json" };
import { MockBackend } from "../src/mock/backend.ts";
import { chains, readDxf } from "../src/mock/dxf.ts";

const FIXTURES = new URL("../../../toolpath/tests/data/dxf/", import.meta.url);

async function fixtureText(name: string): Promise<string> {
    return Bun.file(new URL(name, FIXTURES)).text();
}

describe("the mock's DXF reader", () => {
    const drawings = fixture.drawings as Record<string, { unit_mm: number; layers: { name: string; paths: number[][][] }[] }>;

    test("reads every fixture into the paths the backend's reader does", async () => {
        expect(Object.keys(drawings).sort()).toEqual(["blocks.dxf", "curves.dxf", "lines.dxf", "splines.dxf"]);
        for (const [name, expected] of Object.entries(drawings)) {
            const drawing = readDxf(await fixtureText(name), fixture.tolerance);
            expect(drawing.unitMm).toBe(expected.unit_mm);
            expect(drawing.layers.map((layer) => layer.name)).toEqual(expected.layers.map((layer) => layer.name));
            drawing.layers.forEach((layer, l) => {
                const paths = expected.layers[l]!.paths;
                expect(layer.paths.map((path) => path.length)).toEqual(paths.map((path) => path.length));
                layer.paths.forEach((path, p) => {
                    path.forEach(([x, y], i) => {
                        const [ex, ey] = paths[p]![i]!;
                        expect(Math.abs(x - ex!)).toBeLessThan(1e-9);
                        expect(Math.abs(y - ey!)).toBeLessThan(1e-9);
                    });
                });
            });
        }
    });

    test("refuses what the backend refuses, in its words", () => {
        expect(() => readDxf("AutoCAD Binary DXF\r\n\x1a\x00")).toThrow("a binary DXF: save the drawing as an ASCII DXF");
        expect(() => readDxf("hello\nworld\n")).toThrow("not an ASCII DXF: line 1 should be a group code, not 'hello'");
        expect(() => readDxf("  0\nSECTION\n  2\nHEADER\n  0\nENDSEC\n  0\nEOF\n")).toThrow("not a DXF drawing: it has no ENTITIES section");
        expect(() => readDxf("  0\nSECTION\n  2\nENTITIES\n  0\nLINE\n 10\n1,5\n  0\nENDSEC\n")).toThrow("LINE: group 10 should be a number, not '1,5'");
    });

    test("joins pieces end to end as the backend's chains does", () => {
        // Closed ones first, then each chain from the first piece left.
        const joined = chains([[[5, 5], [6, 5]], [[0, 0], [1, 0], [1, 1], [0, 0]], [[7, 5], [6, 5]], [[4, 5], [5, 5]]]);
        expect(joined).toEqual([[[0, 0], [1, 0], [1, 1], [0, 0]], [[4, 5], [5, 5], [6, 5], [7, 5]]]);
    });
});

describe("a DXF upload to the mock", () => {
    test("is a job of a group a layer, as the backend makes it", async () => {
        const backend = new MockBackend({ timers: false });
        const text = await fixtureText("lines.dxf");
        const job = await backend.uploadJob(new File([text], "plate.dxf"), { anchor: "keep", power: 300 });
        expect(job.source).toBe("dxf");
        expect(job.name).toBe("plate");
        expect(job.groups.map((group) => group.label)).toEqual(["layer CUT", "layer MARK"]);
        expect(job.groups[0]!.power).toBe(300);
        expect(job.groups[0]!.paths[0]).toEqual([[20, 0], [20, 10], [0, 10], [0, 0], [20, 0]]);
        expect(job.recipe ?? null).toBeNull();
        await expect(backend.uploadJob(new File(["AutoCAD Binary DXF\r\n\x1a\x00"], "b.dxf"), {})).rejects.toMatchObject({ status: 400, message: "a binary DXF: save the drawing as an ASCII DXF" });
        await expect(backend.uploadJob(new File(["  0\nSECTION\n  2\nENTITIES\n  0\nENDSEC\n  0\nEOF\n"], "e.dxf"), {})).rejects.toMatchObject({ status: 400, message: "the DXF has no lines to cut" });
        // Kilometers put a 2 km line past what a job may reach.
        const far = "  0\nSECTION\n  2\nHEADER\n  9\n$INSUNITS\n 70\n7\n  0\nENDSEC\n  0\nSECTION\n  2\nENTITIES\n  0\nLINE\n 10\n0\n 20\n0\n 11\n2\n 21\n0\n  0\nENDSEC\n  0\nEOF\n";
        await expect(backend.uploadJob(new File([far], "far.dxf"), { anchor: "keep" })).rejects.toMatchObject({ status: 400, message: "the drawing reaches past 1e+06 mm: is its unit ($INSUNITS) right?" });
    });

    test("goes through a CAM profile's paths operation by layer", async () => {
        const backend = new MockBackend({ timers: false });
        const text = await fixtureText("lines.dxf");
        const answer = await backend.camJob("cartesian-laser", [new File([text], "lines.dxf")]);
        const cut = answer.job.groups.filter((group) => group.paths.length > 0);
        expect(cut.map((group) => group.label)).toEqual(["engraving: layer CUT", "engraving: layer MARK"]);
        expect(answer.job.source).toBe("dxf");
        expect(Math.min(...cut.flatMap((group) => group.paths.flat().map(([x]) => x)))).toBeCloseTo(10, 9);
    });
});
