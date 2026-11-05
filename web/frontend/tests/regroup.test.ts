import { describe, expect, test } from "bun:test";

import { formatJson, lineColumn, offsetOf, placeOf, stepsAt } from "../src/jsontext.ts";
import { freshLabel, groupRefs, regroup, regroupRefusal, removePaths, tidyRefs } from "../src/regroup.ts";
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
        expect(regroupRefusal(before, [[0, 0], [1, 0]], "new")).toBe("dots and paths do not go in one group");
        expect(regroupRefusal(before, [[0, 0]], 1)).toBe("dots and paths do not go in one group");
        expect(() => regroup(before, [[0, 0]], 1)).toThrow("dots and paths do not go in one group");
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
        expect(() => removePaths(before, [[0, 0]])).toThrow("drawn from its joints");
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
        expect(lineColumn("ab\ncde", 4)).toEqual({ line: 2, column: 2 });
    });
});
