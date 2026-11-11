import { describe, expect, test } from "bun:test";

import {
    PX_MM,
    buildJob,
    centerJob,
    checkSpeed,
    closestApproach,
    colorName,
    computeStats,
    demoCoupon,
    jointMinRadius,
    layerOf,
    lengthToMm,
    parseGcode,
    parsePathData,
    parseSvg,
    parseTransform,
    pathMinRadius,
    placeJob,
} from "../src/mock/jobs.ts";
import { MockBackend } from "../src/mock/backend.ts";
import { groupMoves, jointPreview, pathMoves } from "../src/moves.ts";
import { defaultOperation } from "../src/sketch.ts";
import type { Group, Job, MillOperation } from "../src/types.ts";

const limits = { rRate: 1000, aRate: 1080, tolerance: 0.005 };

describe("path data", () => {
    test("absolute lines and close", () => {
        const paths = parsePathData("M0 0 L10 0 L10 10 Z");
        expect(paths).toEqual([[[0, 0], [10, 0], [10, 10], [0, 0]]]);
    });

    test("relative commands, H and V, several subpaths", () => {
        const paths = parsePathData("m1,1 l2,0 v3 h-2 z M10 10 L12 12");
        expect(paths[0]).toEqual([[1, 1], [3, 1], [3, 4], [1, 4], [1, 1]]);
        expect(paths[1]).toEqual([[10, 10], [12, 12]]);
    });

    test("implicit lineto after moveto", () => {
        const paths = parsePathData("M0 0 5 5 10 0");
        expect(paths).toEqual([[[0, 0], [5, 5], [10, 0]]]);
    });

    test("curves are sampled and end on their endpoints", () => {
        const cubic = parsePathData("M0 0 C 0 10, 10 10, 10 0")[0]!;
        expect(cubic.length).toBeGreaterThan(5);
        expect(cubic[cubic.length - 1]).toEqual([10, 0]);
        const arc = parsePathData("M0 0 A 5 5 0 0 1 10 0")[0]!;
        expect(arc.length).toBeGreaterThan(5);
        const end = arc[arc.length - 1]!;
        expect(end[0]).toBeCloseTo(10, 6);
        expect(end[1]).toBeCloseTo(0, 6);
        const mid = arc[Math.floor(arc.length / 2)]!;
        expect(Math.hypot(mid[0] - 5, mid[1])).toBeCloseTo(5, 6);
    });
});

describe("svg", () => {
    test("units, transforms and grouping by stroke", () => {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="20mm" height="10mm" viewBox="0 0 200 100">
            <g id="cuts" stroke="#f00" transform="translate(100,0)"><line x1="0" y1="0" x2="100" y2="0"/></g>
            <rect x="0" y="0" width="10" height="10"/>
        </svg>`;
        const parsed = parseSvg(svg);
        expect(parsed.groups.map((g) => g.label)).toEqual(["stroke #ff0000", "no stroke"]);
        const line = parsed.groups[0]!.paths[0]!;
        expect(line[0]).toEqual([10, 0]);
        expect(line[1]).toEqual([20, 0]);
        const rect = parsed.groups[1]!.paths[0]!;
        expect(rect[2]![0]).toBeCloseTo(1, 9);
        expect(rect[2]![1]).toBeCloseTo(-1, 9);
    });

    test("the effective stroke comes from the nearest ancestor and hidden shapes are left out", () => {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10mm" viewBox="0 0 10 10" stroke="blue">
            <g id="cuts" style="stroke: #f00; fill: none">
                <path d="M0 0 L1 0" stroke="#00f"/>
                <path d="M0 1 L1 1"/>
                <g style="stroke:inherit"><path d="M0 2 L1 2"/></g>
                <path d="M0 3 L1 3" visibility="hidden"/>
                <g visibility="hidden"><path d="M0 4 L1 4"/><path d="M0 5 L1 5" visibility="visible"/></g>
                <g display="none"><path d="M0 6 L1 6" stroke="lime"/></g>
                <path d="M0 7 L1 7" style="display:none"/>
                <path d="M0 8 L1 8" stroke="none"/>
                <path d="M0 9 L1 9" stroke="rgb(0, 128, 0)"/>
            </g>
            <line x1="0" y1="0" x2="1" y2="1"/>
            <line x1="0" y1="0" x2="2" y2="2" stroke="RED"/>
        </svg>`;
        const parsed = parseSvg(svg);
        expect(parsed.groups.map((g) => [g.label, g.paths.length])).toEqual([
            ["stroke #0000ff", 2],
            ["stroke #ff0000", 4],
            ["no stroke", 1],
            ["stroke #008000", 1],
        ]);
        // The document's own stroke reaches a loose line; rgb() and names normalize.
        expect(parsed.groups[0]!.paths[1]![1]).toEqual([1, -1]);
        expect(parsed.groups[1]!.paths[1]![0]![1]).toBeCloseTo(-2, 9);
        expect(colorName("#abc")).toBe("#aabbcc");
        expect(colorName("#aabbccff")).toBe("#aabbcc");
        expect(colorName("#aabbcc80")).toBe("#aabbcc80");
        expect(colorName("rgb(100%, 0%, 50%)")).toBe("#ff0080");
        expect(colorName("None")).toBe("none");
        expect(colorName("bogus")).toBeNull();
        const hidden = '<svg xmlns="http://www.w3.org/2000/svg"><g display="none"><rect width="1" height="1"/></g></svg>';
        expect(() => parseSvg(hidden)).toThrow("the SVG has no shapes to cut");
    });

    test("a bare length is a pixel and matrices compose", () => {
        expect(lengthToMm("12")).toBeCloseTo(12 * PX_MM, 9);
        expect(lengthToMm("12px")).toBeCloseTo(12 * PX_MM, 9);
        expect(lengthToMm("1in")).toBeCloseTo(25.4, 9);
        expect(lengthToMm("x")).toBeNull();
        const m = parseTransform("translate(1,2) scale(2)");
        expect(m).toEqual([2, 0, 0, 2, 1, 2]);
        const r = parseTransform("rotate(90)");
        expect(r[0]).toBeCloseTo(0, 9);
        expect(r[1]).toBeCloseTo(1, 9);
    });

    test("without units the drawing is in pixels, as the backend reads it", () => {
        const bare = parseSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96"/></svg>');
        const rect = bare.groups[0]!.paths[0]!;
        expect(rect[1]![0]).toBeCloseTo(25.4, 6);
        const pxWidth = parseSvg('<svg xmlns="http://www.w3.org/2000/svg" width="192" viewBox="0 0 96 96"><rect width="96" height="96"/></svg>');
        expect(pxWidth.groups[0]!.paths[0]![1]![0]).toBeCloseTo(50.8, 6);
        const noBox = parseSvg('<svg xmlns="http://www.w3.org/2000/svg" width="10mm"><rect width="96" height="96"/></svg>');
        expect(noBox.groups[0]!.paths[0]![1]![0]).toBeCloseTo(25.4, 6);
    });

    test("a document without shapes is refused", () => {
        expect(() => parseSvg('<svg xmlns="http://www.w3.org/2000/svg"/>')).toThrow();
        expect(() => parseSvg("<html/>")).toThrow();
    });
});

describe("gcode", () => {
    test("spindle-on G1 runs become paths; rapids, M5 and S0 split them", () => {
        const parsed = parseGcode("G21\nG0 X0 Y0\nM3 S200\nG1 X10 Y0 F300\nG1 X10 Y10\nG0 X20 Y20\nG1 X25 Y20 ; note\nM5\nG1 X30 Y30\nM3\nG1 X30 Y40\nS0\nG1 X30 Y50 (travel)\nS200\nG1 X40 Y50\n");
        expect(parsed.groups.length).toBe(1);
        expect(parsed.groups[0]!.label).toBe("S200 F300");
        expect(parsed.groups[0]!.power).toBe(200);
        expect(parsed.groups[0]!.speed).toBe(300);
        expect(parsed.groups[0]!.paths).toEqual([
            [[0, 0], [10, 0], [10, 10]],
            [[20, 20], [25, 20]],
            [[30, 30], [30, 40]],
            [[30, 50], [40, 50]],
        ]);
    });

    test("a change of S or F starts a path and a group; consecutive runs at one pair share a group", () => {
        const parsed = parseGcode("G0 X0 Y0\nM3 S200\nG1 X10 Y0 F300\nG1 X20 Y0 S400\nG1 X30 Y0 F600\nG0 X40 Y0\nG1 X50 Y0\nG1 X60 Y0 S200 F300\n");
        expect(parsed.groups.map((g) => [g.label, g.paths.length])).toEqual([["S200 F300", 1], ["S400 F300", 1], ["S400 F600", 2], ["S200 F300", 1]]);
        expect(parsed.groups[0]!.paths[0]).toEqual([[0, 0], [10, 0]]);
        expect(parsed.groups[1]!.paths[0]).toEqual([[10, 0], [20, 0]]);
        expect(parsed.groups[2]!.paths).toEqual([[[20, 0], [30, 0]], [[40, 0], [50, 0]]]);
        expect(parsed.groups[3]!.paths[0]).toEqual([[50, 0], [60, 0]]);
    });

    test("refusals match the backend importer", () => {
        expect(() => parseGcode("G0 X0 Y0\nG91\nM3 S1\nG1 X1 Y1 F100\n")).toThrow("line 2: G91 is relative moves");
        expect(() => parseGcode("G20\n")).toThrow("line 1: G20 is inches");
        expect(() => parseGcode("G0 X0 Y0\nG2 X1 Y1 I1 J0\n")).toThrow("line 2: G2 is arcs, export them as line segments");
        expect(() => parseGcode("X1 Y1\n")).toThrow("line 1: axis words before any G0 or G1");
        expect(() => parseGcode("G0 X1\n")).toThrow("line 1: the first move must give both X and Y");
        expect(() => parseGcode("M3 S100\nG1 X1 Y1 F100\n")).toThrow("line 2: a cut before any rapid");
        expect(() => parseGcode("G0 X0 Y0\nM3 S100\nG1 X1 Y1\n")).toThrow("line 3: a cut with no usable feed rate");
        expect(() => parseGcode("G0 X0 Y0\nM3 S100\nG1 X1 Y1 F1\n")).toThrow("line 3: a cut with no usable feed rate");
        expect(() => parseGcode("G0 X0 Y0\nG1 X10 Y0 F300\n")).toThrow("the file has no cuts");
    });

    test("a gcode upload keeps each group's own power and feed", () => {
        const built = buildJob("0005", "part.nc", "G0 X0 Y0\nM3 S200\nG1 X10 Y0 F300\nS400\nG1 X10 Y10\n", { power: 999, speed: 999, anchor: "keep" }, limits);
        expect(built.job.source).toBe("gcode");
        expect(built.job.groups.map((g) => [g.label, g.power, g.speed])).toEqual([["S200 F300", 200, 300], ["S400 F300", 400, 300]]);
    });
});

describe("placement and stats", () => {
    test("center anchor puts the middle on the axis, then the offset", () => {
        const placed = placeJob({ groups: [{ label: "g", paths: [[[0, 0], [10, 0], [10, 20]]] }] }, "center", { x: 0, y: 14 });
        expect(placed.groups[0]!.paths[0]).toEqual([[-5, 4], [5, 4], [5, 24]]);
        const kept = placeJob({ groups: [{ label: "g", paths: [[[0, 0], [10, 0]]] }] }, "keep", { x: 1, y: 1 });
        expect(kept.groups[0]!.paths[0]).toEqual([[1, 1], [11, 1]]);
    });

    test("a circle inside the table-limited radius is fully limited", () => {
        const circle = (r: number) => {
            const path: [number, number][] = [];
            for (let i = 0; i <= 72; i++) {
                const t = (i / 72) * Math.PI * 2;
                path.push([r * Math.cos(t), r * Math.sin(t)]);
            }
            return path;
        };
        const near: Group[] = [{ label: "near", power: 500, min_power: 0, speed: 400, passes: 1, enabled: true, paths: [circle(10)] }];
        const far: Group[] = [{ label: "far", power: 500, min_power: 0, speed: 400, passes: 1, enabled: true, paths: [circle(30)] }];
        const nearStats = computeStats(near, limits);
        const farStats = computeStats(far, limits);
        expect(nearStats.length_mm).toBeCloseTo(2 * Math.PI * 10, 0);
        expect(nearStats.limited_fraction).toBeCloseTo(1, 6);
        expect(nearStats.max_radius).toBeCloseTo(10, 6);
        expect(farStats.limited_fraction).toBe(0);
        expect(farStats.seconds).toBeCloseTo((2 * Math.PI * 30 / 400) * 60 + (30 / 1000) * 60, 0);
        expect(nearStats.seconds).toBeCloseTo((360 / 1080) * 60 + (10 / 1000) * 60, 0);
    });

    test("disabled groups do not count", () => {
        const groups: Group[] = [{ label: "off", power: 1, min_power: 0, speed: 100, passes: 1, enabled: false, paths: [[[5, 5], [6, 6]]] }];
        expect(computeStats(groups, limits)).toEqual({ length_mm: 0, seconds: 0, max_radius: 0, min_radius: 0, limited_fraction: 0, moves: 0 });
    });

    test("min radius is the closest approach of a segment, not of a vertex", () => {
        expect(closestApproach([-18, 2], [18, 2])).toBeCloseTo(2, 9);
        expect(closestApproach([3, 4], [6, 8])).toBeCloseTo(5, 9);
        expect(closestApproach([-1, 0], [1, 0])).toBe(0);
        expect(closestApproach([3, 4], [3, 4])).toBeCloseTo(5, 9);
        expect(pathMinRadius([[3, 4]])).toBeCloseTo(5, 9);
        expect(pathMinRadius([[-18, 2], [18, 2], [18, 12]])).toBeCloseTo(2, 9);
        const groups: Group[] = [{ label: "edge", power: 500, min_power: 0, speed: 400, passes: 1, enabled: true, paths: [[[-18, 2], [18, 2]]] }];
        expect(computeStats(groups, limits).min_radius).toBeCloseTo(2, 6);
        expect(computeStats(groups, limits).max_radius).toBeCloseTo(Math.hypot(18, 2), 9);
        const demo = placeJob(demoCoupon(), "center", { x: 0, y: 14 });
        const enabled = demo.groups.map((g) => ({ label: g.label, power: 500, min_power: 0, speed: 400, passes: 1, enabled: true, paths: g.paths }));
        expect(computeStats(enabled, limits).min_radius).toBeCloseTo(2, 6);
        const crossing: Group[] = [{ label: "x", power: 500, min_power: 0, speed: 400, passes: 1, enabled: true, paths: [[[-5, 0], [5, 0]]] }];
        expect(computeStats(crossing, limits).min_radius).toBe(0);
    });

    test("a joint-space group is previewed by sampling and streamed as written", () => {
        expect(jointMinRadius([[5, 0], [-5, 0]])).toBe(0);
        expect(jointMinRadius([[5, 0], [3, 90], [-4, 0]])).toBe(0);
        expect(jointMinRadius([[5, 0], [3, 90]])).toBe(3);
        expect(jointMinRadius([[-5, 0], [-3, 90]])).toBe(3);
        const preview = jointPreview([[5, 0], [-5, 0]]);
        expect(preview.length).toBe(101);
        expect(preview[0]).toEqual([5, 0]);
        expect(preview[50]![0]).toBeCloseTo(0, 9);
        expect(preview[100]![0]).toBeCloseTo(-5, 9);
        const turn = jointPreview([[10, 0], [10, 90]]);
        expect(turn.length).toBe(91);
        expect(turn[90]![0]).toBeCloseTo(0, 9);
        expect(turn[90]![1]).toBeCloseTo(10, 9);
        const group: Group = { label: "rail", power: 200, min_power: 0, speed: 300, passes: 1, enabled: true, paths: [], joints: [[[5, 0], [-5, 0]], [[-5, 0], [-5, 90]]] };
        // The start is taken a whole number of turns toward where the head is.
        const moves = groupMoves(group, { r: 0, a: 710 }, 0.005);
        expect(moves).toEqual([
            { kind: "go", target: { r: 5, a: 720 } },
            { kind: "cut", target: { r: -5, a: 720 } },
            { kind: "cut", target: { r: -5, a: 810 } },
        ]);
        const stats = computeStats([group], limits);
        expect(stats.moves).toBe(3);
        expect(stats.max_radius).toBe(5);
        expect(stats.min_radius).toBe(0);
        expect(stats.length_mm).toBeCloseTo(10 + 5 * Math.PI / 2, 6);
        // A rapid already at its target and a repeated point send nothing.
        expect(groupMoves({ ...group, joints: [[[0, 0], [0, 0], [1, 0]]] }, { r: 0, a: 0 }, 0.005)).toEqual([{ kind: "cut", target: { r: 1, a: 0 } }]);
    });

    test("a group with passes runs whole again from where the last pass ended", () => {
        const rail: Group = { label: "rail", power: 200, min_power: 0, speed: 300, passes: 2, enabled: true, paths: [], joints: [[[5, 0], [5, 90]]] };
        // Each pass goes back to the start of an open path.
        expect(groupMoves(rail, { r: 0, a: 0 }, 0.005)).toEqual([
            { kind: "go", target: { r: 5, a: 0 } },
            { kind: "cut", target: { r: 5, a: 90 } },
            { kind: "go", target: { r: 5, a: 0 } },
            { kind: "cut", target: { r: 5, a: 90 } },
        ]);
        const square: [number, number][] = [[10, 0], [12, 0], [12, 2], [10, 2], [10, 0]];
        const line: [number, number][] = [[10, -5], [12, -5]];
        const once: Group = { label: "g", power: 500, min_power: 0, speed: 400, passes: 1, enabled: true, paths: [square, line] };
        const thrice: Group = { ...once, passes: 3 };
        const one = groupMoves(once, { r: 0, a: 0 }, 0.005);
        const three = groupMoves(thrice, { r: 0, a: 0 }, 0.005);
        // The whole group each pass, the square then the line, not each path three times.
        expect(three.length).toBe(3 * one.length);
        three.forEach((move, i) => {
            expect(move.kind).toBe(one[i % one.length]!.kind);
            expect(move.target.r).toBeCloseTo(one[i % one.length]!.target.r, 6);
        });
        const oneStats = computeStats([once], limits);
        const threeStats = computeStats([thrice], limits);
        expect(threeStats.length_mm).toBeCloseTo(3 * oneStats.length_mm, 6);
        expect(threeStats.max_radius).toBe(oneStats.max_radius);
        expect(threeStats.moves).toBe(3 * oneStats.moves);
    });
});

describe("building jobs", () => {
    test("svg upload", () => {
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10mm" viewBox="0 0 10 10"><path d="M0 0 L10 0"/></svg>';
        const built = buildJob("0001", "coupon.svg", svg, { power: 300, speed: 200, spot: 0.2, anchor: "keep", offset_x: 0, offset_y: 20 }, limits);
        expect(built.note).toBeNull();
        expect(built.job.name).toBe("coupon");
        expect(built.job.source).toBe("svg");
        expect(built.job.groups[0]!.power).toBe(300);
        expect(built.job.groups[0]!.paths[0]).toEqual([[0, 20], [10, 20]]);
        // The joint replay is a spiral, a hair longer than the chord.
        expect(built.job.stats.length_mm).toBeCloseTo(10, 2);
    });

    test("gerber falls back to the demo coupon with a note", () => {
        const built = buildJob("0002", "board-F_Cu.gbr", "G04 nothing*", {}, limits);
        expect(built.note).not.toBeNull();
        expect(built.job.source).toBe("gerber");
        expect(built.job.copper.length).toBe(demoCoupon().copper.length);
        const cleared = buildJob("0002", "board-F_Cu.gbr", "G04 nothing*", { clear: "radial" }, limits);
        expect(cleared.note).toContain("clearing need the real backend");
        const deposited = buildJob("0002", "board-F_Cu.gbr", "G04 nothing*", { mode: "deposit", fill: "radial" }, limits);
        expect(deposited.note).toContain("deposition need the real backend");
    });

    test("a layer cut on its lines takes the demo coupon's, the outline itself for Edge.Cuts", () => {
        const edge = buildJob("0004", "board.kicad_pcb", "", { mode: "lines", layer: "Edge.Cuts" }, limits);
        expect(edge.job.groups.map((group) => group.label)).toEqual(["lines of Edge.Cuts"]);
        expect(edge.job.groups[0]!.paths.length).toBe(demoCoupon().outline.length);
        expect(edge.note).toContain("lines of a layer need the real backend");
        const silk = buildJob("0004", "board.kicad_pcb", "", { mode: "lines", layer: "F.SilkS" }, limits);
        expect(silk.job.groups.map((group) => [group.label, group.enabled])).toEqual([["lines of F.SilkS", true], ["board outline pass 1", false]]);
        expect(() => buildJob("0004", "board.kicad_pcb", "", { mode: "lines", clear: "radial" }, limits)).toThrow("neither clear nor fill");
        expect(() => buildJob("0004", "board.kicad_pcb", "", { mode: "lines", fill: "rings" }, limits)).toThrow("neither clear nor fill");
    });

    test("a stencil cuts the demo paste round the inside of each opening the margin leaves", () => {
        const cut = (margin: number, spot = 0.1) => buildJob("0003", "board.kicad_pcb", "", { mode: "stencil", margin, spot }, limits);
        const exact = cut(0);
        expect(exact.job.layer).toBe("F.Paste");
        expect(exact.note).toContain("showing a demo stencil");
        const [openings, outline] = exact.job.groups;
        expect(openings!.label).toBe("paste openings, 0.000 mm margin");
        expect(openings!.paths.length).toBe(6);
        expect([openings!.enabled, outline!.label, outline!.enabled]).toEqual([true, "board outline pass 1", false]);
        // A fine pad 0.25 x 1 mm: the loop half a spot inside its edge.
        const fine = openings!.paths.at(-1)!;
        const xs = fine.map(([x]) => x);
        const ys = fine.map(([, y]) => y);
        expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(0.15);
        expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(0.9);
        // 0.1 mm off each side leaves the fine pads too narrow for the beam,
        // 0.13 closes them, and 0.5 closes every pad.
        expect(cut(0.1).job.groups.map((group) => [group.label, group.paths.length])).toEqual([
            ["paste openings, 0.100 mm margin", 2],
            ["paste openings narrower than the spot, along their middle", 4],
            ["board outline pass 1", 1],
        ]);
        const along = cut(0.1).job.groups[1]!.paths[0]!;
        expect(Math.abs(along[1]![1] - along[0]![1])).toBeCloseTo(0.7);
        const closed = cut(0.13).job.groups[1]!;
        expect([closed.label, closed.enabled, closed.paths.length]).toEqual(["paste openings the margin closes, along their middle", false, 4]);
        expect(() => cut(0.5)).toThrow("a margin of 0.5 mm closes every opening of board.kicad_pcb");
    });

    test("stencil options are refused where they mean nothing, as the backend refuses them", () => {
        const board = (options: Parameters<typeof buildJob>[3]) => () => buildJob("0004", "board.kicad_pcb", "", options, limits);
        expect(board({ mode: "stencil", clear: "radial" })).toThrow("a stencil cuts round every opening: it takes neither clear nor fill");
        expect(board({ mode: "stencil", fill: "contour" })).toThrow("it takes neither clear nor fill");
        expect(board({ margin: 0.05 })).toThrow("margin is how much a stencil shrinks its openings; this import is not a stencil");
        expect(board({ mode: "stencil", margin: -0.01 })).toThrow("margin must be 0 to 10 mm");
        expect(board({ mode: "stencil", margin: 11 })).toThrow("margin must be 0 to 10 mm");
        expect(board({ mode: "stencil", layer: "B.Paste" })().job.layer).toBe("B.Paste");
    });

    test("a back layer is flipped in X unless the upload says otherwise, as the backend flips it", () => {
        const front = buildJob("0002", "board-F_Cu.gbr", "G04 nothing*", {}, limits).job;
        const back = buildJob("0002", "board-B_Cu.gbr", "G04 nothing*", {}, limits).job;
        const asDrawn = buildJob("0002", "board-B_Cu.gbr", "G04 nothing*", { mirror: "none" }, limits).job;
        const points = (paths: [number, number][][], sign = 1): string[] =>
            paths.flat().map(([x, y]) => `${(Math.round(sign * x * 1000) / 1000) + 0},${Math.round(y * 1000) / 1000}`).sort();
        expect(back.layer).toBe("B.Cu");
        expect(front.design?.mirror).toBe("none");
        expect(back.design?.mirror).toBe("x");
        // Centered on the axis, so the board turned over is the front about x = 0.
        expect(points(back.copper)).toEqual(points(front.copper, -1));
        expect(points((back.pads ?? []).map(([x, y]) => [[x, y]]))).toEqual(points((front.pads ?? []).map(([x, y]) => [[x, y]]), -1));
        expect(points(asDrawn.copper)).toEqual(points(front.copper));
        expect(() => buildJob("0002", "board-B_Cu.gbr", "G04*", { mirror: "z" as "x" }, limits)).toThrow("mirror must be one of none, x, y");
    });

    test("on a mill the outline is cut the bit's radius off the board, as the backend cuts it", async () => {
        const box = (paths: [number, number][][]): number[] => {
            const xs = paths.flat().map(([x]) => x);
            const ys = paths.flat().map(([, y]) => y);
            return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
        };
        const grown = (paths: [number, number][][], radius: number): number[] => box(paths).map((v, i) => (i < 2 ? v - radius : v + radius));
        const outline = (groups: Group[], label = "outline") => groups.find((group) => group.label === label)!.paths;
        const drawn = buildJob("0002", "board-F_Cu.gbr", "G04 nothing*", { spot: 1 }, limits).job;
        expect(outline(drawn.groups)).toEqual(drawn.outline);
        const milled = buildJob("0002", "board-F_Cu.gbr", "G04 nothing*", { spot: 1 }, limits, true).job;
        box(outline(milled.groups)).forEach((v, i) => expect(v).toBeCloseTo(grown(milled.outline, 0.5)[i]!, 6));
        const silk = buildJob("0004", "board.kicad_pcb", "", { mode: "lines", layer: "F.SilkS", spot: 0.2 }, limits, true).job;
        box(outline(silk.groups, "board outline pass 1")).forEach((v, i) => expect(v).toBeCloseTo(grown(silk.outline, 0.1)[i]!, 6));
        // The lines of Edge.Cuts are cut where they are drawn, on any machine.
        const edge = buildJob("0004", "board.kicad_pcb", "", { mode: "lines", layer: "Edge.Cuts", spot: 1 }, limits, true).job;
        expect(edge.groups[0]!.paths).toEqual(edge.outline);
        // The mock backend imports for the machine it has.
        const backend = new MockBackend({ timers: false });
        await backend.connect("/dev/ttyACM0");
        await backend.updateSettings({ values: { spindle: 1 } });
        const uploaded = await backend.uploadJob(new File(["G04*"], "board-F_Cu.gbr"), { spot: 1 });
        expect(outline(uploaded.groups)).toEqual(outline(milled.groups));
    });

    test("json is taken as a job", () => {
        const text = JSON.stringify({ name: "j", groups: [{ label: "g", paths: [[[0, 10], [1, 10]]] }] });
        const built = buildJob("0003", "j.json", text, {}, limits);
        expect(built.job.groups[0]!.enabled).toBe(true);
        expect(built.job.groups[0]!.power).toBe(500);
        expect(built.job.groups[0]!.speed).toBe(400);
        expect(built.job.source).toBe("json");
        expect(built.job.stats.moves).toBeGreaterThan(0);
        const unnamed = buildJob("0003", "saved.json", JSON.stringify({ name: "job", groups: [] }), {}, limits);
        expect(unnamed.job.name).toBe("saved");
    });

    test("json with joints keeps them and previews them", () => {
        const text = JSON.stringify({ groups: [{ label: "rail", joints: [[[5, 0], [-5, 0]]] }] });
        const built = buildJob("0006", "far.json", text, {}, limits);
        expect(built.job.groups[0]!.joints).toEqual([[[5, 0], [-5, 0]]]);
        expect(built.job.groups[0]!.paths.length).toBe(1);
        expect(built.job.groups[0]!.paths[0]!.length).toBe(101);
        expect(built.job.stats.min_radius).toBe(0);
        const drawn = JSON.stringify({ groups: [{ label: "rail", joints: [[[5, 0], [-5, 0]]], paths: [[[1, 1], [2, 2]]] }] });
        expect(buildJob("0007", "far.json", drawn, {}, limits).job.groups[0]!.paths).toEqual([[[1, 1], [2, 2]]]);
    });

    test("json that the backend would refuse is refused before any geometry runs", () => {
        const refuse = (job: unknown, text: string): void => {
            expect(() => buildJob("0008", "bad.json", JSON.stringify(job), {}, limits)).toThrow(text);
        };
        refuse({ groups: [{ label: "g", paths: [[[1e400, 0], [0, 1]]] }] }, "must be a number");
        refuse({ groups: [{ label: "g", paths: [[["1", 0], [0, 1]]] }] }, "must be a number");
        refuse({ groups: [{ label: "g", paths: [[[1, 0, 0], [0, 1]]] }] }, "not two numbers");
        refuse({ groups: [{ label: "g", paths: [[[2e6, 0], [0, 1]]] }] }, "group 'g': a coordinate is past 1e+06");
        refuse({ groups: [{ label: "g", joints: [[[5, 0]]] }] }, "a joint-space path needs at least two points");
        refuse({ groups: [{ label: "g", speed: 0, paths: [[[0, 0], [1, 1]]] }] }, "group 'g': speed must be above 0 and at most 1e+06");
        refuse({ groups: [{ label: "g", power: -1 }] }, "group 'g': power must be between 0 and 1e+06");
        refuse({ groups: [{ paths: [] }] }, "has no label");
        refuse({ groups: [{ label: "g" }], spot: 0 }, "spot must be above 0 and at most 1000");
        refuse({ groups: [{ label: "g" }], offset: { x: "1", y: 0 } }, "must be a number");
        refuse({ name: "x" }, "job JSON has no groups");
        expect(() => buildJob("0009", "bad.json", "{", {}, limits)).toThrow("not a job");
        // NaN never appears in JSON, but a string coordinate would freeze the bisection.
        expect(() => buildJob("0010", "bad.json", JSON.stringify({ groups: [{ label: "g", paths: [[[0, 0], ["x", 1]]] }] }), {}, limits)).toThrow("must be a number");
    });

    test("upload options are checked like the backend's", () => {
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10mm" viewBox="0 0 10 10"><path d="M0 0 L10 0"/></svg>';
        expect(() => buildJob("0011", "a.svg", svg, { speed: 0 }, limits)).toThrow("speed must be above 0");
        expect(() => buildJob("0011", "a.svg", svg, { power: -5 }, limits)).toThrow("power must be between 0");
        expect(() => buildJob("0011", "a.svg", svg, { spot: 0 }, limits)).toThrow("spot must be above 0");
        expect(() => buildJob("0011", "a.svg", svg, { offset_x: Number.NaN }, limits)).toThrow("offset must be within");
        expect(() => buildJob("0011", "a.svg", svg, { clear: "zigzag" as never }, limits)).toThrow("clear must be one of off, radial, rings, lines");
        expect(() => buildJob("0011", "a.svg", svg, { mode: "print" as never }, limits)).toThrow("mode must be one of isolate, deposit");
        expect(() => buildJob("0011", "a.svg", svg, { mode: "deposit", fill: "zigzag" as never }, limits)).toThrow("fill must be one of contour, radial, rings, lines");
        expect(() => buildJob("0011", "a.svg", svg, { mode: "deposit", clear: "radial" }, limits)).toThrow("clear is for isolation");
        expect(() => buildJob("0011", "a.svg", svg, { fill: "contour" }, limits)).toThrow("fill is for a deposit");
    });

    test("a board's layer is checked and kept, and a gerber's read from its name", () => {
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10mm" viewBox="0 0 10 10"><path d="M0 0 L10 0"/></svg>';
        expect(() => buildJob("0012", "board.kicad_pcb", "", { layer: "F/Paste" }, limits)).toThrow("layer must be a KiCad layer name such as F.Cu or F.Paste");
        const stencil = buildJob("0012", "board.kicad_pcb", "", { layer: "F.Paste", mode: "deposit" }, limits);
        expect(stencil.job.layer).toBe("F.Paste");
        expect(stencil.note).toContain("paste geometry and deposition");
        expect(buildJob("0013", "board.kicad_pcb", "", {}, limits).job.layer).toBe("F.Cu");
        expect(buildJob("0014", "board-F_Paste.gtp", "G04 nothing*", {}, limits).job.layer).toBe("F.Paste");
        expect(buildJob("0015", "coupon.gbr", "G04 nothing*", {}, limits).job.layer).toBeNull();
        expect(buildJob("0016", "a.svg", svg, {}, limits).job.layer).toBeNull();
        expect(layerOf("test-gerbers-F_Cu.gbr")).toBe("F.Cu");
        expect(layerOf("board-Edge_Cuts.gm1")).toBe("Edge.Cuts");
        expect(layerOf("my_board.gbr")).toBeNull();
    });

    test("unknown types are refused", () => {
        expect(() => buildJob("0004", "x.txt", "", {}, limits)).toThrow();
    });
});

describe("checks the backend makes", () => {
    test("a speed or plunge under 0.001 mm/min is refused like one of 0", () => {
        expect(() => checkSpeed(0.0005)).toThrow("speed must be at least 0.001 mm/min");
        expect(() => checkSpeed(0.0005, "plunge")).toThrow("plunge must be at least 0.001 mm/min");
        expect(() => checkSpeed(0)).toThrow("speed must be above 0 and at most 1e+06");
        checkSpeed(0.001);
        const slow = JSON.stringify({ groups: [{ label: "g", speed: 0.0005, paths: [[[0, 0], [1, 1]]] }] });
        expect(() => buildJob("0012", "slow.json", slow, {}, limits)).toThrow("group 'g': speed must be at least 0.001 mm/min");
    });

    test("a saved job keeps its depth and plunge, checked", () => {
        const text = JSON.stringify({ groups: [{ label: "g", depth: 1.6, plunge: 30, paths: [[[0, 10], [1, 10]]] }] });
        const group = buildJob("0013", "milled.json", text, {}, limits).job.groups[0]!;
        expect(group.depth).toBe(1.6);
        expect(group.plunge).toBe(30);
        const plain = buildJob("0014", "plain.json", JSON.stringify({ groups: [{ label: "g", paths: [[[0, 10], [1, 10]]] }] }), {}, limits);
        expect(plain.job.groups[0]!.depth).toBe(0.1);
        expect(plain.job.groups[0]!.plunge).toBe(60);
        const refuse = (raw: Record<string, unknown>, text: string): void => {
            const job = JSON.stringify({ groups: [{ label: "g", paths: [[[0, 10], [1, 10]]], ...raw }] });
            expect(() => buildJob("0015", "bad.json", job, {}, limits)).toThrow(text);
        };
        refuse({ depth: 0 }, "group 'g': depth must be above 0 and at most 50 mm");
        refuse({ depth: 51 }, "group 'g': depth must be above 0 and at most 50 mm");
        refuse({ plunge: 0.0001 }, "group 'g': plunge must be at least 0.001 mm/min");
        refuse({ plunge: "fast" }, "must be a number");
    });

    test("the centering pattern's power stays under s_max, checked before the pattern", () => {
        expect(() => centerJob("c", { power: 1200 }, limits, 1000)).toThrow("power 1200 is over s_max 1000");
        expect(() => centerJob("c", { power: 1200, fine: true }, limits, 1000)).toThrow("power 1200 is over s_max 1000");
        expect(() => centerJob("c", { power: 1200 }, limits, 1e6 + 1)).not.toThrow();
        expect(centerJob("c", { power: 400 }, limits, 1000).job.groups.length).toBe(2);
    });

    test("a path starting within the axis snap starts on the axis and leaves it with a turn", () => {
        const moves = pathMoves([[0.003, 0], [0, 5]], { r: 10, a: 0 }, 0.005);
        expect(moves[0]).toEqual({ kind: "go", target: { r: 0, a: 0 } });
        expect(moves[1]).toEqual({ kind: "cut", target: { r: 0, a: 90 } });
        expect(moves[2]!.target.r).toBeCloseTo(5, 9);
        expect(moves.length).toBe(3);
    });
});

describe("a job put back whole", () => {
    const line = (y: number): MillOperation => ({ ...defaultOperation("line"), depth: 0.3, step_down: 0.3, points: [[0, y], [10, y]] });

    test("keeps its recipe only while its groups cut what they did under their labels", async () => {
        const backend = new MockBackend({ timers: false });
        const made = (await backend.makeMill({ ops: [line(0), line(5)] })).job;
        const [first, second] = made.groups as [Group, Group];
        const put = (groups: Group[]): Promise<Job> => backend.replaceJob(made.id, { ...made, groups });
        // Settings and a label's numbers change nothing a re-cut makes.
        const renumbered = first.label.replace(/\d/, "7");
        expect(renumbered).not.toBe(first.label);
        expect((await put([{ ...first, power: 250, enabled: false, label: renumbered }, second])).recipe).toEqual(made.recipe!);
        // A path taken out or moved, or a group renamed, would come back as
        // the operations make it.
        expect((await put([first])).recipe ?? null).toBeNull();
        const again = (await backend.makeMill({ ops: [line(0), line(5)] })).job;
        const moved = await backend.replaceJob(again.id, { ...again, groups: [{ ...again.groups[0]!, paths: [...again.groups[0]!.paths, ...again.groups[1]!.paths] }] });
        expect(moved.recipe ?? null).toBeNull();
        const named = (await backend.makeMill({ ops: [line(0)] })).job;
        expect((await backend.replaceJob(named.id, { ...named, groups: [{ ...named.groups[0]!, label: "edges" }] })).recipe ?? null).toBeNull();
    });

    test("takes a new job's default for what it leaves out, as the backend does", async () => {
        const backend = new MockBackend({ timers: false });
        const made = (await backend.makeMill({ ops: [line(0)] })).job;
        const { recipe: _recipe, layer: _layer, ...body } = { ...made, layer: "F.Cu" };
        const kept = await backend.replaceJob(made.id, body as Job);
        expect(kept.recipe ?? null).toBeNull();
        expect(kept.layer ?? null).toBeNull();
        expect(kept.source).toBe(made.source);
        expect(kept.name).toBe(made.name);
        // Areas name one pad each.
        const dots = { label: "dots", tool: "dispenser", paths: [[[1, 1]], [[2, 2]]], areas: [0.5] };
        await expect(backend.replaceJob(made.id, { ...body, groups: [dots] } as unknown as Job)).rejects.toThrow("group 'dots': areas must have one entry per path");
        // A list given as null is no list, as the backend's model has it.
        for (const key of ["paths", "joints", "moves"]) {
            await expect(backend.replaceJob(made.id, { ...body, groups: [{ label: "g", [key]: null }] } as unknown as Job)).rejects.toThrow("not a job");
        }
        await expect(backend.replaceJob(made.id, { ...body, outline: null } as unknown as Job)).rejects.toThrow("not a job");
    });

    test("draws a joint-space group whose joints changed again, and keeps one's drawing whose joints did not", async () => {
        const backend = new MockBackend({ timers: false });
        const radii = (job: Job): number[] => [...new Set(job.groups[0]!.paths.flat().map(([x, y]) => Math.round(Math.hypot(x, y) * 1e6) / 1e6))];
        const job = await backend.uploadJob(new File([JSON.stringify({ groups: [{ label: "arc", joints: [[[10, 0], [10, 90]]] }] })], "arc.json"), {});
        expect(radii(job)).toEqual([10]);
        const moved = await backend.replaceJob(job.id, { ...job, groups: [{ ...job.groups[0]!, joints: [[[20, 0], [20, 90]]] }] });
        expect(radii(moved)).toEqual([20]);
        const shown = moved.groups[0]!.paths.map((path) => path.map(([x, y]): [number, number] => [x * 1.01, y * 1.01]));
        const kept = await backend.replaceJob(job.id, { ...moved, groups: [{ ...moved.groups[0]!, paths: shown }] });
        expect(kept.groups[0]!.paths).toEqual(shown);
    });
});
