import { describe, expect, test } from "bun:test";

import modelText from "../../../cam/mill-3d.toml" with { type: "text" };
import { MockBackend } from "../src/mock/backend.ts";
import { buildModelJob, camGcode, chipLoad, parseProfile, stlBounds, summaryOf } from "../src/mock/cam.ts";
import { cutRuns } from "../src/preview.ts";
import type { Move } from "../src/types.ts";

/** A box's twelve triangles, x by y by z from the origin, as a binary STL. */
function boxStl(x: number, y: number, z: number): Uint8Array<ArrayBuffer> {
    const v = (i: number, j: number, k: number): [number, number, number] => [i * x, j * y, k * z];
    const quads: [number, number, number][][] = [
        [v(0, 0, 0), v(0, 1, 0), v(1, 1, 0), v(1, 0, 0)],
        [v(0, 0, 1), v(1, 0, 1), v(1, 1, 1), v(0, 1, 1)],
        [v(0, 0, 0), v(1, 0, 0), v(1, 0, 1), v(0, 0, 1)],
        [v(0, 1, 0), v(0, 1, 1), v(1, 1, 1), v(1, 1, 0)],
        [v(0, 0, 0), v(0, 0, 1), v(0, 1, 1), v(0, 1, 0)],
        [v(1, 0, 0), v(1, 1, 0), v(1, 1, 1), v(1, 0, 1)],
    ];
    const triangles = quads.flatMap((q) => [[q[0]!, q[1]!, q[2]!], [q[0]!, q[2]!, q[3]!]]);
    const bytes = new Uint8Array(84 + triangles.length * 50);
    const view = new DataView(bytes.buffer);
    view.setUint32(80, triangles.length, true);
    triangles.forEach((tri, i) => {
        tri.forEach((point, k) => {
            point.forEach((c, n) => view.setFloat32(84 + i * 50 + 12 + k * 12 + n * 4, c, true));
        });
    });
    return bytes;
}

function edited(changes: Record<string, string>): string {
    let text = modelText;
    for (const [old, now] of Object.entries(changes)) {
        expect(text).toContain(old);
        text = text.replace(old, now);
    }
    return text;
}

describe("the mock's 3D profile", () => {
    test("reads the shipped 3D profile with the feeds the backend works out", () => {
        const profile = parseProfile(modelText, "mill-3d");
        expect(profile.model).toBe(true);
        expect(profile.material).toBe("6061 aluminum");
        expect(profile.materials?.map((material) => material.id)).toEqual(["aluminum", "pom", "acrylic", "hdpe", "wood", "brass"]);
        expect(profile.stock).toEqual({ material: "aluminum", margin: 3, top: 0.5, size: null });
        expect(profile.spindle).toEqual({ min: 3000, max: 12000 });
        const rough = profile.operations[0]!;
        // The numbers toolpath/tests/test_carve.py has the backend's reader give.
        expect(rough.cutting).toMatchObject({ rpm: 12000, feed: 288, plunge: 86, step_down: 0.6, stepover: 0.3, leave: 0.2, leave_floor: 0, ramp: 2, below: -0.3 });
        expect(rough.feeds).toContain("the rpm held to the spindle's 12000");
        expect(profile.operations[1]!.cutting).toMatchObject({ stepover: 0.1, leave: 0, rpm: 12000, feed: 192 });
        expect(profile.operations.map((operation) => operation.cutting["below"])).toEqual([-0.3, 0, 0]);
        expect(profile.tools.find((tool) => tool.id === "vee60")).toMatchObject({ shape: "vee", angle: 60, shank: 3.175, flutes: 2 });
        expect(summaryOf(profile)).toMatchObject({ model: true, material: "6061 aluminum", operations: 2 });
    });

    test("a feed over the axes brings the rpm down to keep the chip", () => {
        const profile = parseProfile(edited({
            'material = "aluminum"   #': 'material = "pom"   #',
            "rate = 1200             # mm/min, the fastest feed": "rate = 800 # mm/min, the fastest feed",
        }), "t");
        const rough = profile.operations[0]!;
        expect(rough.cutting["feed"]).toBe(800);
        expect(rough.cutting["rpm"]).toBe(8000);
        expect(rough.feeds).toContain("rpm brought down to keep the chip");
    });

    test("a chip load is read straight between its points", () => {
        const aluminum = parseProfile(modelText, "mill-3d").materials![0]!;
        expect(chipLoad(aluminum, 0.5)).toBe(0.004);
        expect(chipLoad(aluminum, 2)).toBeCloseTo(0.008, 9);
        expect(chipLoad(aluminum, 10)).toBe(0.025);
    });

    test("a bad 3D setting is named as the backend names it", () => {
        const cases: [Record<string, string>, RegExp][] = [
            [{ 'material = "aluminum"   #': 'material = "steel"   #' }, /\[stock\] material must name a \[\[materials\]\] id/],
            [{ 'shape = "ball"': 'shape = "bull"' }, /corner is needed for a bull nose/],
            [{ 'tool = "ball2"': 'tool = "vee60"', 'source = "parallel"': 'source = "waterline"' }, /V bit, which cuts parallel passes only/],
            [{ "angle = 0\n": "angle = 0\nflats = false\n" }, /flats adds a rough's or a waterline's levels/],
            [{ "turn = [0, 0, 0]": "turn = [0, 0]" }, /\[model\] turn must be \[x, y, z\]/],
            [{ "min = 3000              # rpm": "min = 30000" }, /\[spindle\] min must be at most max/],
            [{ "speed = 150\n": "" }, /speed is needed/],
        ];
        for (const [changes, fault] of cases) {
            expect(() => parseProfile(edited(changes), "t")).toThrow(fault);
        }
    });
});

describe("a model in the mock", () => {
    test("an STL's box is read from binary and from ASCII", () => {
        expect(stlBounds(boxStl(30, 20, 6))).toEqual({ min: [0, 0, 0], max: [30, 20, 6], triangles: 12 });
        const ascii = "solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 4 0 1\nvertex 0 3 2\nendloop\nendfacet\nendsolid t\n";
        expect(stlBounds(new TextEncoder().encode(ascii))).toEqual({ min: [0, 0, 0], max: [4, 3, 2], triangles: 1 });
        expect(() => stlBounds(new TextEncoder().encode("solid t\nendsolid t\n"))).toThrow(/no triangles/);
    });

    test("a model's job is moves round the box, written as gcode in three dimensions", () => {
        const profile = parseProfile(modelText, "mill-3d");
        const { job, notes } = buildModelJob("j1", profile, "box", "box.stl", boxStl(30, 20, 6));
        expect(job.source).toBe("stl");
        expect(job.groups.map((group) => group.label)).toEqual(["rough: 3 mm end mill", "surfaces: 2 mm ball end mill", "walls: 3 mm end mill"]);
        const rough = job.groups[0]!;
        expect(rough.paths).toEqual([]);
        expect(rough.depth).toBeCloseTo(6.2, 9);
        expect(job.groups[2]!.depth).toBeCloseTo(6.5, 9);
        expect(rough.moves!.every((path) => path[0]![3] === 0)).toBe(true);
        expect(Math.min(...rough.moves!.flat().map((move) => move[2]))).toBeCloseTo(-6.2, 9);
        expect(job.outline[1]).toEqual([[0, 0], [36, 0], [36, 26], [0, 26], [0, 0]]);
        expect(notes[0]).toBe("box: 30 x 20 x 6 mm, 12 triangles, in a 36 x 26 x 6.5 mm block with its top at Z 0");
        expect(job.stats.seconds).toBeGreaterThan(0);
        const written = camGcode(profile, job);
        const lines = written.text.split("\n");
        expect(lines[0]).toBe("(box: 2 operations through 3D mill)");
        expect(lines).toContain("M3 S12000");
        expect(lines.some((line) => /^G1 X[-\d.]+ Y[-\d.]+ F288\.000$/.test(line) || /^G1 Y[-\d.]+ F288\.000$/.test(line) || /^G1 X[-\d.]+ F288\.000$/.test(line))).toBe(true);
        expect(written.report.extents["Z"]?.[0]).toBeCloseTo(-6.5, 9);
        expect(written.report.warnings).toEqual([]);
    });

    test("a V bit without its diameter is refused for a model, as the backend refuses it", () => {
        // toolpath/tests/test_carve.py holds the backend's twin of this.
        const text = edited({ "diameter = 3.175        # the shank, which bounds the cut\n": "", 'tool = "ball2"': 'tool = "vee60"' });
        expect(() => buildModelJob("j", parseProfile(text, "t"), "box", "box.stl", boxStl(30, 20, 6))).toThrow("surfaces: the V bit vee60 needs its diameter to cut a model");
    });

    test("the mock backend makes a job from an STL file", async () => {
        const backend = new MockBackend({ timers: false });
        const answer = await backend.camJob("mill-3d", [new File([boxStl(10, 8, 2)], "part.stl")]);
        expect(answer.job.name).toBe("part");
        expect(answer.job.groups[0]!.moves!.length).toBeGreaterThan(0);
        expect(answer.notes.some((note) => note.includes("need the real backend"))).toBe(true);
        const listed = await backend.jobs();
        expect(listed.some((job) => job.id === answer.job.id)).toBe(true);
    });
});

describe("the preview of a model's moves", () => {
    test("a run starts where the tool was and the rapids are left out", () => {
        const path: Move[] = [
            [0, 0, 1, 0],
            [0, 0, 0, 2],
            [5, 0, -1, 1],
            [5, 0, 1, 0],
            [9, 0, 1, 0],
            [9, 0, -1, 2],
        ];
        expect(cutRuns([path])).toEqual([
            [[0, 0, 1], [0, 0, 0], [5, 0, -1]],
            [[9, 0, 1], [9, 0, -1]],
        ]);
        expect(cutRuns([[[1, 1, 1, 0]]])).toEqual([]);
    });
});
