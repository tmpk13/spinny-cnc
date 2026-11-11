import { describe, expect, test } from "bun:test";

import { formatJson, offsetOf, placeOf, stepsAt } from "../src/jsontext.ts";
import { arrayPaths, arrayPlace, arrayRefusal, arrayStep, freshLabel, groupRefs, pathsMiddle, regroup, regroupRefusal, removePaths, tidyRefs } from "../src/regroup.ts";
import type { Group, Job } from "../src/types.ts";

function group(label: string, paths: [number, number][][], extra: Partial<Group> = {}): Group {
    return { label, power: 500, min_power: 0, speed: 400, passes: 1, enabled: true, paths, ...extra };
}

function job(groups: Group[]): Job {
    return {
        id: "j1",
        name: "j",
        source: "svg",
        spot: 0.1,
        offset: { x: 0, y: 0 },
        groups,
        outline: [[[0, 0], [9, 0], [9, 9], [0, 0]]],
        copper: [],
        stats: { length_mm: 0, seconds: 0, max_radius: 0, min_radius: 0, limited_fraction: 0, moves: 0 },
    };
}

const line = (y: number): [number, number][] => [[0, y], [5, y]];

describe("regrouping paths", () => {
    test("picked paths go into a new group after the last group they came from, with the first one's settings", () => {
        const before = job([
            group("a", [line(0), line(1), line(2)], { power: 300, focus: 0.5, passes: 2 }),
            group("b", [line(3)]),
            group("c", [line(4)]),
        ]);
        const { job: after, refs } = regroup(before, [[1, 0], [0, 2], [0, 0], [0, 2]], "new");
        expect(after.groups.map((g) => [g.label, g.paths.length])).toEqual([["a", 1], ["group", 3], ["c", 1]]);
        const made = after.groups[1]!;
        // b was emptied and dropped; the new group sits where b was.
        expect([made.power, made.focus, made.passes, made.enabled]).toEqual([300, 0.5, 2, true]);
        expect(made.paths).toEqual([line(0), line(2), line(3)]);
        expect(refs).toEqual([[1, 0], [1, 1], [1, 2]]);
        // The job given is as it was.
        expect(before.groups[0]!.paths.length).toBe(3);
        expect(regroup(before, [[0, 1]], "new", "  slow  ").job.groups[1]!.label).toBe("slow");
    });

    test("a new group is switched off when a group its paths come from is", () => {
        const before = job([group("outline", [line(0), line(1)], { enabled: false, power: 300 }), group("cut", [line(2)])]);
        const off = regroup(before, [[0, 0]], "new").job;
        expect(off.groups.map((g) => [g.label, g.enabled, g.power])).toEqual([["outline", false, 300], ["group", false, 300], ["cut", true, 500]]);
        // Taken with paths of a group that is on, still off: nothing that
        // was off is cut by being moved.
        expect(regroup(before, [[1, 0], [0, 1]], "new").job.groups.find((g) => g.label === "group")!.enabled).toBe(false);
        expect(regroup(before, [[1, 0]], "new").job.groups.find((g) => g.label === "group")!.enabled).toBe(true);
    });

    test("picked paths go to the end of a group the job has, which is kept even if it gave them", () => {
        const before = job([group("a", [line(0), line(1)]), group("b", [line(3)])]);
        const into = regroup(before, [[0, 0], [0, 1]], 1);
        expect(into.job.groups.map((g) => [g.label, g.paths.length])).toEqual([["b", 3]]);
        expect(into.refs).toEqual([[0, 1], [0, 2]]);
        const reorder = regroup(before, [[0, 0]], 0);
        expect(reorder.job.groups[0]!.paths).toEqual([line(1), line(0)]);
        expect(reorder.refs).toEqual([[0, 1]]);
    });

    test("dots carry their pads' areas, and do not mix with paths", () => {
        const dots = group("dots", [[[1, 1]], [[2, 2]], [[3, 3]]], { tool: "dispenser", areas: [1, 2, 3] });
        const before = job([dots, group("paths", [line(0)])]);
        const { job: after } = regroup(before, [[0, 1]], "new");
        expect(after.groups[0]!.areas).toEqual([1, 3]);
        expect(after.groups[1]!.areas).toEqual([2]);
        expect(after.groups[1]!.tool).toBe("dispenser");
        expect(regroupRefusal(before, [[0, 0], [1, 0]], "new")).toBe("dots and paths cannot share a group");
        expect(regroupRefusal(before, [[0, 0]], 1)).toBe("dots and paths cannot share a group");
        expect(() => regroup(before, [[0, 0]], 1)).toThrow("dots and paths cannot share a group");
    });

    test("a CAM profile's bit goes with its paths, and two bits do not share a group", () => {
        const vbit = { tool: "spindle" as const, tool_id: "vbit", tool_name: "30 degree V bit" };
        const drill = { tool: "spindle" as const, tool_id: "drill", tool_name: "0.8 mm drill" };
        const before = job([
            group("isolation", [line(0), line(1)], vbit),
            group("drills", [[[1, 1]], [[2, 2]]], drill),
            group("engraving", [line(5)], { tool: "laser", tool_id: "diode", tool_name: "Diode", height: 6 }),
        ]);
        const made = regroup(before, [[1, 1]], "new").job.groups[2]!;
        expect([made.tool, made.tool_id, made.tool_name]).toEqual(["spindle", "drill", "0.8 mm drill"]);
        const engraved = regroup(before, [[2, 0]], "new").job.groups;
        expect(engraved.map((g) => [g.label, g.height])).toEqual([["isolation", undefined], ["drills", undefined], ["group", 6]]);
        // The gcode stops to change the bit between groups, never inside one.
        expect(regroupRefusal(before, [[0, 0], [1, 0]], "new")).toBe("drills uses 0.8 mm drill and isolation 30 degree V bit; they cannot share a group");
        expect(regroupRefusal(before, [[1, 0]], 0)).toBe("isolation uses 30 degree V bit, the paths use 0.8 mm drill");
        expect(regroupRefusal(job([group("drawn", [line(0)], { tool: "spindle" }), before.groups[1]!]), [[1, 0]], 0)).toBe(
            "drawn uses no profile tool, the paths use 0.8 mm drill",
        );
    });

    test("a joint-space or a model's group gives no path away, and nothing picked moves nothing", () => {
        const joints = group("ring", [line(0)], { joints: [[[1, 0], [1, 90]]] });
        const model = group("rough", [line(1)], { moves: [[[0, 0, 0, 0]]] });
        const before = job([joints, model, group("c", [line(2)])]);
        expect(regroupRefusal(before, [[0, 0]], "new")).toContain("joint-space");
        expect(regroupRefusal(before, [[1, 0]], "new")).toContain("model's moves");
        expect(regroupRefusal(before, [[2, 0]], 0)).toContain("takes no paths");
        expect(regroupRefusal(before, [], "new")).toBe("pick some paths in the preview first");
        expect(regroupRefusal(before, [[9, 9]], "new")).toBe("pick some paths in the preview first");
        expect(regroupRefusal(before, [[2, 0]], 7)).toBe("the job has no group 8");
        expect(() => removePaths(before, [[0, 0]])).toThrow("cannot be deleted one by one");
    });

    test("paths taken out leave their groups, an emptied one dropped", () => {
        const before = job([group("a", [line(0), line(1)]), group("b", [line(3)])]);
        const after = removePaths(before, [[0, 1], [1, 0]]);
        expect(after.groups.map((g) => [g.label, g.paths])).toEqual([["a", [line(0)]]]);
        expect(tidyRefs(before, [[1, 0], [0, 1], [1, 0], [0, 5], [4, 0]])).toEqual([[0, 1], [1, 0]]);
        expect(groupRefs(before, 0)).toEqual([[0, 0], [0, 1]]);
        expect(freshLabel(job([group("group", []), group("group 2", [])]))).toBe("group 3");
    });
});

describe("arrays of paths", () => {
    const round = (point: [number, number]): [number, number] => [Math.round(point[0] * 1e9) / 1e9 + 0, Math.round(point[1] * 1e9) / 1e9 + 0];

    test("a linear array steps each copy on, at the end of its own group, the picked paths left where they are", () => {
        const before = job([group("a", [line(0), line(1)]), group("b", [line(5)])]);
        const { job: after, refs } = arrayPaths(before, [[0, 1], [1, 0]], { kind: "linear", count: 3, dx: 10, dy: 0 });
        expect(after.groups[0]!.paths).toEqual([line(0), line(1), [[10, 1], [15, 1]], [[20, 1], [25, 1]]]);
        expect(after.groups[1]!.paths).toEqual([line(5), [[10, 5], [15, 5]], [[20, 5], [25, 5]]]);
        // The copies, to pick them, in the order they were made.
        expect(refs).toEqual([[0, 2], [1, 1], [0, 3], [1, 2]]);
        // Deleting what was picked takes the array back.
        expect(removePaths(after, refs).groups.map((g) => g.paths)).toEqual(before.groups.map((g) => g.paths));
        expect(before.groups[0]!.paths.length).toBe(2);
    });

    test("a circular array spreads a whole turn evenly and puts the last copy on the end of a part turn", () => {
        const full = { kind: "circular" as const, count: 4, cx: 0, cy: 0, sweep: 360 };
        expect(arrayStep(full)).toBe(90);
        expect(round(arrayPlace(full, 1)([10, 0]))).toEqual([0, 10]);
        expect(round(arrayPlace(full, 3)([10, 0]))).toEqual([0, -10]);
        const part = { kind: "circular" as const, count: 3, cx: 5, cy: 0, sweep: -90 };
        expect(arrayStep(part)).toBe(-45);
        expect(round(arrayPlace(part, 2)([10, 0]))).toEqual([5, -5]);
        const { job: after } = arrayPaths(job([group("a", [[[10, 0], [12, 0]]])]), [[0, 0]], full);
        expect(after.groups[0]!.paths.map((path) => round(path[0]!))).toEqual([[10, 0], [0, 10], [-10, 0], [0, -10]]);
    });

    test("dots keep their areas, and what cannot be copied says why", () => {
        const dots = job([group("dots", [[[1, 1]], [[2, 2]]], { areas: [0.5, 0.7] })]);
        const { job: after } = arrayPaths(dots, [[0, 1]], { kind: "linear", count: 2, dx: 0, dy: 3 });
        expect(after.groups[0]!.paths).toEqual([[[1, 1]], [[2, 2]], [[2, 5]]]);
        expect(after.groups[0]!.areas).toEqual([0.5, 0.7, 0.7]);
        const before = job([group("a", [line(0)]), group("joints", [line(1)], { joints: [[[0, 0], [1, 1]]] } as Partial<Group>)]);
        expect(arrayRefusal(before, [], { kind: "linear", count: 2, dx: 1, dy: 0 })).toBe("pick some paths in the preview first");
        expect(arrayRefusal(before, [[1, 0]], { kind: "linear", count: 2, dx: 1, dy: 0 })).toContain("joint-space");
        expect(arrayRefusal(before, [[0, 0]], { kind: "linear", count: 1, dx: 1, dy: 0 })).toContain("2 to 1000");
        expect(arrayRefusal(before, [[0, 0]], { kind: "linear", count: 2.5, dx: 1, dy: 0 })).toContain("whole number");
        expect(arrayRefusal(before, [[0, 0]], { kind: "linear", count: 2, dx: 0, dy: 0 })).toContain("a step");
        expect(arrayRefusal(before, [[0, 0]], { kind: "circular", count: 2, cx: 0, cy: 0, sweep: 0 })).toContain("an angle");
        expect(arrayRefusal(before, [[0, 0]], { kind: "linear", count: 2, dx: Number.NaN, dy: 0 })).toContain("needs a number");
        expect(() => arrayPaths(before, [[1, 0]], { kind: "linear", count: 2, dx: 1, dy: 0 })).toThrow("joint-space");
        expect(pathsMiddle(before, [[0, 0]])).toEqual([2.5, 0]);
        expect(pathsMiddle(before, [])).toEqual([0, 0]);
    });
});

describe("a job as JSON text", () => {
    const sample = job([group("a", [line(0), line(1)]), group("b", [[[1.5, -2], [3, 4], [5, 6]]])]);

    test("puts every path on a line of its own and reads back as the job", () => {
        const text = formatJson(sample);
        expect(JSON.parse(text)).toEqual(sample);
        expect(text).toContain('"paths": [\n');
        expect(text).toContain("[[1.5, -2], [3, 4], [5, 6]]");
        expect(text).toContain('"offset": {\n');
        expect(text.split("\n").length).toBeLessThan(60);
        expect(formatJson([])).toBe("[]");
        expect(formatJson({})).toBe("{}");
    });

    test("names the group, path and point a place in the text lies in, and finds a path's place", () => {
        const text = formatJson(sample);
        const at = text.indexOf("[3, 4]");
        // On the point's bracket, inside its numbers, and after it.
        expect(placeOf(stepsAt(text, at + 1))).toEqual({ list: "groups", group: 1, path: 0, point: 1 });
        expect(placeOf(stepsAt(text, at + 3))).toEqual({ list: "groups", group: 1, path: 0, point: 1 });
        expect(stepsAt(text, at + 2)).toEqual(["groups", 1, "paths", 0, 1, 0]);
        expect(stepsAt(text, at + 3)).toEqual(["groups", 1, "paths", 0, 1, 1]);
        const outline = text.indexOf("[9, 9]");
        expect(placeOf(stepsAt(text, outline + 2))).toEqual({ list: "outline", group: null, path: 0, point: 2 });
        // A group's settings are no place on the board.
        expect(placeOf(stepsAt(text, text.indexOf('"power"') + 3))).toBeNull();
        expect(stepsAt(text, text.indexOf('"power"') + 10)).toEqual(["groups", 0, "power"]);
        // The way back: where the second path of group 0 begins.
        const second = offsetOf(text, ["groups", 0, "paths", 1]);
        expect(text.slice(second!, second! + 8)).toBe("[[0, 1],");
        expect(offsetOf(text, ["groups", 1, "paths", 0, 2])).toBe(text.indexOf("[5, 6]"));
        expect(offsetOf(text, ["groups", 0, "label"])).toBe(text.indexOf('"a"'));
        expect(offsetOf(text, ["groups", 5])).toBeNull();
        // Text being typed, broken past the caret, still answers.
        const broken = `${text.slice(0, at + 3)} ,,,`;
        expect(placeOf(stepsAt(broken, at + 3))).toEqual({ list: "groups", group: 1, path: 0, point: 1 });
    });

    test("a caret where a path or a point begins is in it, the first of a list as much as the others", () => {
        const text = formatJson(sample);
        const places: (string | number)[][] = [];
        sample.groups.forEach((group, g) => group.paths.forEach((path, p) => {
            places.push(["groups", g, "paths", p]);
            path.forEach((_, n) => places.push(["groups", g, "paths", p, n]));
        }));
        sample.outline.forEach((path, p) => places.push(["outline", p], ...path.map((_, n) => ["outline", p, n])));
        for (const steps of places) {
            expect(stepsAt(text, offsetOf(text, steps)!)).toEqual(steps);
        }
        // Space before the first entry, or an empty list, is no entry.
        const list = text.indexOf('"paths": [') + '"paths": ['.length;
        expect(stepsAt(text, list)).toEqual(["groups", 0, "paths"]);
        expect(stepsAt("[]", 1)).toEqual([]);
    });
});
