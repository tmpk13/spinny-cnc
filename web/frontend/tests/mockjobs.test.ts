import { describe, expect, test } from "bun:test";

import {
    PX_MM,
    buildJob,
    closestApproach,
    colorName,
    computeStats,
    demoCoupon,
    groupMoves,
    jointMinRadius,
    jointPreview,
    lengthToMm,
    parseGcode,
    parsePathData,
    parseSvg,
    parseTransform,
    pathMinRadius,
    placeJob,
} from "../src/mockjobs.ts";
import type { Group } from "../src/types.ts";

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
        const near: Group[] = [{ label: "near", power: 500, min_power: 0, speed: 400, enabled: true, paths: [circle(10)] }];
        const far: Group[] = [{ label: "far", power: 500, min_power: 0, speed: 400, enabled: true, paths: [circle(30)] }];
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
        const groups: Group[] = [{ label: "off", power: 1, min_power: 0, speed: 100, enabled: false, paths: [[[5, 5], [6, 6]]] }];
        expect(computeStats(groups, limits)).toEqual({ length_mm: 0, seconds: 0, max_radius: 0, min_radius: 0, limited_fraction: 0, moves: 0 });
    });

    test("min radius is the closest approach of a segment, not of a vertex", () => {
        expect(closestApproach([-18, 2], [18, 2])).toBeCloseTo(2, 9);
        expect(closestApproach([3, 4], [6, 8])).toBeCloseTo(5, 9);
        expect(closestApproach([-1, 0], [1, 0])).toBe(0);
        expect(closestApproach([3, 4], [3, 4])).toBeCloseTo(5, 9);
        expect(pathMinRadius([[3, 4]])).toBeCloseTo(5, 9);
        expect(pathMinRadius([[-18, 2], [18, 2], [18, 12]])).toBeCloseTo(2, 9);
        const groups: Group[] = [{ label: "edge", power: 500, min_power: 0, speed: 400, enabled: true, paths: [[[-18, 2], [18, 2]]] }];
        expect(computeStats(groups, limits).min_radius).toBeCloseTo(2, 6);
        expect(computeStats(groups, limits).max_radius).toBeCloseTo(Math.hypot(18, 2), 9);
        const demo = placeJob(demoCoupon(), "center", { x: 0, y: 14 });
        const enabled = demo.groups.map((g) => ({ label: g.label, power: 500, min_power: 0, speed: 400, enabled: true, paths: g.paths }));
        expect(computeStats(enabled, limits).min_radius).toBeCloseTo(2, 6);
        const crossing: Group[] = [{ label: "x", power: 500, min_power: 0, speed: 400, enabled: true, paths: [[[-5, 0], [5, 0]]] }];
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
        const group: Group = { label: "rail", power: 200, min_power: 0, speed: 300, enabled: true, paths: [], joints: [[[5, 0], [-5, 0]], [[-5, 0], [-5, 90]]] };
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
    });

    test("unknown types are refused", () => {
        expect(() => buildJob("0004", "x.txt", "", {}, limits)).toThrow();
    });
});
