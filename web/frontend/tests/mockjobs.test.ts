import { describe, expect, test } from "bun:test";

import {
    PX_MM,
    buildJob,
    computeStats,
    demoCoupon,
    lengthToMm,
    parseGcode,
    parsePathData,
    parseSvg,
    parseTransform,
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
    test("units, transforms and grouping", () => {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="20mm" height="10mm" viewBox="0 0 200 100">
            <g id="cuts" transform="translate(100,0)"><line x1="0" y1="0" x2="100" y2="0"/></g>
            <rect x="0" y="0" width="10" height="10"/>
        </svg>`;
        const parsed = parseSvg(svg);
        expect(parsed.groups.map((g) => g.label)).toEqual(["cuts", "paths"]);
        const line = parsed.groups[0]!.paths[0]!;
        expect(line[0]).toEqual([10, 0]);
        expect(line[1]).toEqual([20, 0]);
        const rect = parsed.groups[1]!.paths[0]!;
        expect(rect[2]![0]).toBeCloseTo(1, 9);
        expect(rect[2]![1]).toBeCloseTo(-1, 9);
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
    test("G1 runs become paths and rapids split them", () => {
        const parsed = parseGcode("G21\nG0 X0 Y0\nG1 X10 Y0 F300 S200\nG1 X10 Y10\nG0 X20 Y20\nG1 X25 Y20 ; note\n");
        expect(parsed.groups[0]!.paths).toEqual([[[0, 0], [10, 0], [10, 10]], [[20, 20], [25, 20]]]);
        expect(parsed.power).toBe(200);
        expect(parsed.speed).toBe(300);
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
        const near: Group[] = [{ label: "near", power: 500, speed: 400, enabled: true, paths: [circle(10)] }];
        const far: Group[] = [{ label: "far", power: 500, speed: 400, enabled: true, paths: [circle(30)] }];
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
        const groups: Group[] = [{ label: "off", power: 1, speed: 100, enabled: false, paths: [[[5, 5], [6, 6]]] }];
        expect(computeStats(groups, limits)).toEqual({ length_mm: 0, seconds: 0, max_radius: 0, min_radius: 0, limited_fraction: 0, moves: 0 });
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
        expect(built.job.stats.moves).toBeGreaterThan(0);
    });

    test("unknown types are refused", () => {
        expect(() => buildJob("0004", "x.txt", "", {}, limits)).toThrow();
    });
});
