import { describe, expect, test } from "bun:test";

import { SHIPPED_PROFILES, buildCamJob, parseProfile, setValue } from "../src/mock/cam.ts";
import { buildJob } from "../src/mock/jobs.ts";
import type { Path } from "../src/types.ts";
import { ACCEPT as CAM_ACCEPT } from "../src/views/cam.ts";
import { ACCEPT as JOBS_ACCEPT } from "../src/views/jobs.ts";

const limits = { rRate: 560, aRate: 400, tolerance: 0.005 };

function shipped(id: string): string {
    return SHIPPED_PROFILES.find((profile) => profile.id === id)!.text;
}

function box(paths: Path[]): [number, number, number, number] {
    const xs = paths.flatMap((path) => path.map(([x]) => x));
    const ys = paths.flatMap((path) => path.map(([, y]) => y));
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

describe("the mock's CAM jobs", () => {
    test("a mill's bit goes round the board's outline off the board, a beam on its line", () => {
        const milled = buildCamJob("0001", parseProfile(shipped("mill-3axis"), "mill-3axis"), "coupon", "board-F_Cu.gbr", "G04*", limits).job;
        const cut = milled.groups.find((group) => group.label === "outline: board outline")!;
        expect(cut.paths.length).toBe(1);
        const loop = cut.paths[0]!;
        expect(loop[0]).toEqual(loop.at(-1)!);
        // The 1 mm end mill's middle half a millimeter out all round.
        const [x0, y0, x1, y1] = box(milled.outline);
        box(cut.paths).forEach((value, i) => expect(value).toBeCloseTo([x0 - 0.5, y0 - 0.5, x1 + 0.5, y1 + 0.5][i]!, 6));
        const burnt = buildCamJob("0002", parseProfile(shipped("polar-laser"), "polar-laser"), "coupon", "board-F_Cu.gbr", "G04*", limits).job;
        expect(burnt.groups.find((group) => group.label === "outline: board outline")!.paths).toEqual(burnt.outline);
    });

    test("a V bit cuts as wide as the operation's depth makes it, and the job's spot is the isolation's", () => {
        const text = `
[[axes]]
letter = "X"
role = "x"
[[axes]]
letter = "Y"
role = "y"
[[axes]]
letter = "Z"
role = "depth"
safe = 5
[[tools]]
id = "v"
kind = "mill"
angle = 30
tip = 0.05
rpm = 12000
feed = 300
[[operations]]
name = "iso"
source = "isolation"
tool = "v"
depth = 0.2
`;
        const profile = parseProfile(text, "v");
        const flank = 2 * Math.tan((15 * Math.PI) / 180);
        // The tool's own width is at its default depth, 0.1 mm.
        expect(profile.tools[0]!.width).toBeCloseTo(0.05 + 0.1 * flank, 9);
        expect(profile.operations[0]!.cutting["width"]).toBeCloseTo(0.05 + 0.2 * flank, 9);
        const job = buildCamJob("0003", profile, "coupon", "board-F_Cu.gbr", "G04*", limits).job;
        expect(job.spot).toBeCloseTo(0.05 + 0.2 * flank, 9);
        expect(job.groups[0]!.label).toBe(`iso: loop 1 at ${((0.05 + 0.2 * flank) / 2).toFixed(3)} mm`);
        // A shank bounds the width however deep the cut.
        const capped = parseProfile(text.replace("tip = 0.05\n", "tip = 0.05\ndiameter = 0.12\n"), "v");
        expect(capped.operations[0]!.cutting["width"]).toBe(0.12);
    });

    test("a board is flipped as the placement's mirror says before it is placed", () => {
        const text = shipped("mill-3axis");
        const plain = buildCamJob("0004", parseProfile(text, "m"), "coupon", "board-F_Cu.gbr", "G04*", limits).job;
        const flipped = buildCamJob("0005", parseProfile(setValue(text, ["placement", "mirror"], "x"), "m"), "coupon", "board-F_Cu.gbr", "G04*", limits).job;
        // The coupon's track runs on one side of its middle pad, so turned
        // over it is on the other; the corner anchor puts the box back.
        const [x0, , x1] = box([...plain.copper, ...plain.outline]);
        const points = (paths: Path[], flip: boolean): string[] =>
            paths.flat().map(([x, y]) => `${(Math.round((flip ? x0 + x1 - x : x) * 1000) / 1000) + 0},${Math.round(y * 1000) / 1000}`).sort();
        expect(points(flipped.copper, false)).not.toEqual(points(plain.copper, false));
        expect(points(flipped.copper, false)).toEqual(points(plain.copper, true));
        // A drawing's paths are placed as they are drawn.
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10mm" viewBox="0 0 10 10"><path d="M1 1 L4 1 L4 3" stroke="red"/></svg>';
        const laser = shipped("cartesian-laser");
        const drawn = buildCamJob("0006", parseProfile(laser, "l"), "art", "art.svg", svg, limits).job;
        const mirrored = buildCamJob("0007", parseProfile(setValue(laser, ["placement", "mirror"], "x"), "l"), "art", "art.svg", svg, limits).job;
        expect(mirrored.groups.map((group) => group.paths)).toEqual(drawn.groups.map((group) => group.paths));
    });

    test("a back layer cut as drawn is noted, as the backend notes it", () => {
        const text = shipped("mill-3axis");
        const said = (profileText: string, fileName: string): string[] =>
            buildCamJob("0008", parseProfile(profileText, "m"), "coupon", fileName, "G04*", limits).notes.filter((note) => note.includes("back layer"));
        expect(said(text, "board-B_Cu.gbl")).toEqual([
            'board-B_Cu: B.Cu is a back layer and [placement] mirror is "none", so it is cut as drawn, which with the board'
            + ` turned over is the copper's mirror image; mirror = "x" flips it`,
        ]);
        expect(said(setValue(text, ["placement", "mirror"], "x"), "board-B_Cu.gbl")).toEqual([]);
        expect(said(text, "board-F_Cu.gbr")).toEqual([]);
        // A KiCad board is read on the profile's layer.
        expect(said(setValue(text, ["placement", "layer"], "B.Cu"), "board.kicad_pcb").length).toBe(1);
    });
});

describe("the file pickers", () => {
    test("offer every file the backend reads, and the mocks read them", () => {
        // The backend's board.GERBER_SUFFIXES and its gcode suffixes.
        const gerbers = [".gbr", ".gtl", ".gbl", ".gts", ".gbs", ".gtp", ".gbp", ".gto", ".gbo", ".gm1"];
        const gcode = [".gcode", ".nc", ".ngc"];
        expect(CAM_ACCEPT.split(",").sort()).toEqual([".svg", ".json", ...gerbers, ".drl", ".kicad_pcb", ...gcode, ".stl"].sort());
        expect(JOBS_ACCEPT.split(",").sort()).toEqual([".svg", ".json", ...gerbers, ".kicad_pcb", ...gcode].sort());
        // A paste layer's gerber through a CAM profile, and a .ngc file through the Jobs import.
        const paste = buildCamJob("0009", parseProfile(shipped("polar-laser"), "p"), "paste", "board-F_Paste.gtp", "G04*", limits);
        expect(paste.job.source).toBe("gerber");
        const ngc = buildJob("0010", "part.ngc", "G0 X0 Y0\nM3 S200\nG1 X10 Y0 F300\n", {}, limits);
        expect(ngc.job.source).toBe("gcode");
    });
});
