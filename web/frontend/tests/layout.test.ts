import { describe, expect, test } from "bun:test";
import {
    bringToFront,
    canonicalLayout,
    canonicalLayouts,
    cleanWidths,
    columnIds,
    DEFAULT_PRESET,
    defaultLayout,
    isDefault,
    isStuck,
    locate,
    matchingPreset,
    MIN_WIDTH,
    moveBlock,
    moveToColumn,
    normalizeLayout,
    placeBlock,
    presetNameProblem,
    readObject,
    readPresets,
    resetPanel,
    sameArrangement,
    setPrefs,
    setWidths,
    stackNeighbor,
    stackOnto,
    stick,
    unstack,
    unstick,
    type PageLayout,
} from "../src/layout.ts";

const MARKUP = [["dro", "jog", "laser", "markers"], ["steps", "preview", "console"], ["jobs", "heightmap", "run"]];

const fresh = (): PageLayout => defaultLayout(MARKUP);

/** A column's blocks as ids: a block is a list of stacks, a stack a list of ids. */
function blocks(layout: PageLayout, column: number): string[][][] {
    return layout.columns[column]!.map((block) => block.map((stack) => stack.ids));
}

describe("the markup's layout", () => {
    test("every panel alone, in the markup's order, and nothing set", () => {
        const layout = fresh();
        expect(columnIds(layout)).toEqual(MARKUP);
        expect(blocks(layout, 0)).toEqual([[["dro"]], [["jog"]], [["laser"]], [["markers"]]]);
        expect(isDefault(layout, MARKUP)).toBe(true);
        expect(canonicalLayout(layout, MARKUP)).toBeNull();
    });

    test("nothing stored, or anything that is not a layout, reads as the markup's", () => {
        for (const raw of [null, undefined, 3, "x", [], { columns: "no" }, { columns: [[["dro"]]] }]) {
            expect(isDefault(normalizeLayout(raw, MARKUP), MARKUP)).toBe(true);
        }
    });
});

describe("a stored layout made to fit the page", () => {
    test("a panel gone from the page is dropped, a panel stored twice kept once", () => {
        const raw = { columns: [[[{ ids: ["gone", "dro"], front: "gone" }], [{ ids: ["dro"], front: "dro" }]]] };
        const layout = normalizeLayout(raw, MARKUP);
        expect(blocks(layout, 0)[0]).toEqual([["dro"]]);
        expect(layout.columns[0]![0]![0]!.front).toBe("dro");
        expect(columnIds(layout).flat().sort()).toEqual(MARKUP.flat().sort());
    });

    test("a panel the stored layout lacks goes where the markup has it, before the panels the markup puts after it", () => {
        // The stored layout predates "laser": it moved markers above jog.
        const raw = { columns: [[[{ ids: ["dro"], front: "dro" }], [{ ids: ["markers"], front: "markers" }], [{ ids: ["jog"], front: "jog" }]]] };
        const layout = normalizeLayout(raw, MARKUP);
        // laser comes before markers in the markup, so before the first block holding markers.
        expect(columnIds(layout)[0]).toEqual(["dro", "laser", "markers", "jog"]);
        // The other columns, not stored at all, are the markup's.
        expect(columnIds(layout).slice(1)).toEqual(MARKUP.slice(1));
    });

    test("columns past the page's last fold into its last column", () => {
        const raw = { columns: [[], [], [], [[{ ids: ["dro"], front: "dro" }]]] };
        const layout = normalizeLayout(raw, MARKUP);
        expect(layout.columns.length).toBe(3);
        expect(columnIds(layout)[2]).toContain("dro");
        expect(columnIds(layout)[0]).toEqual(["jog", "laser", "markers"]);
    });

    test("a stack's front must be one of its panels", () => {
        const raw = { columns: [[[{ ids: ["dro", "jog"], front: "console" }]]] };
        expect(normalizeLayout(raw, MARKUP).columns[0]![0]![0]!.front).toBe("dro");
    });

    test("only real settings survive: true flags, heights within limits", () => {
        const raw = { panels: { dro: { collapsed: true, hidden: "yes", height: 1 }, jog: { height: 1e6 }, nope: { hidden: true }, run: { collapsed: false } } };
        const layout = normalizeLayout(raw, MARKUP);
        expect(layout.panels).toEqual({ dro: { collapsed: true, height: 4 }, jog: { height: 200 } });
    });

    test("a layout survives being stored and read back", () => {
        let layout = stackOnto(fresh(), "console", "preview");
        layout = stick(layout, "laser");
        layout = setPrefs(layout, "dro", { collapsed: true, height: 12.5 });
        layout = setWidths(layout, [1, 2, 1]);
        const back = normalizeLayout(JSON.parse(JSON.stringify(layout)), MARKUP);
        expect(back).toEqual(layout);
        expect(canonicalLayout(back, MARKUP)).toEqual(canonicalLayout(layout, MARKUP));
    });
});

describe("moves", () => {
    test("up and down swap a block with its neighbor; at an end nothing moves", () => {
        const up = moveBlock(fresh(), "laser", -1);
        expect(columnIds(up)[0]).toEqual(["dro", "laser", "jog", "markers"]);
        const down = moveBlock(fresh(), "laser", 1);
        expect(columnIds(down)[0]).toEqual(["dro", "jog", "markers", "laser"]);
        expect(moveBlock(fresh(), "dro", -1)).toEqual(fresh());
        expect(moveBlock(fresh(), "markers", 1)).toEqual(fresh());
    });

    test("a move steps over blocks that show nothing", () => {
        const hidden = (id: string) => id !== "jog";
        expect(columnIds(moveBlock(fresh(), "laser", -1, hidden))[0]).toEqual(["laser", "dro", "jog", "markers"]);
        expect(columnIds(moveBlock(fresh(), "dro", 1, hidden))[0]).toEqual(["jog", "laser", "dro", "markers"]);
    });

    test("panels stuck together move together", () => {
        const stuck = stick(fresh(), "laser");
        expect(blocks(stuck, 0)).toEqual([[["dro"]], [["jog"], ["laser"]], [["markers"]]]);
        expect(columnIds(moveBlock(stuck, "laser", -1))[0]).toEqual(["jog", "laser", "dro", "markers"]);
        expect(columnIds(moveToColumn(stuck, "jog", 1))[1]).toEqual(["steps", "jog", "laser", "preview", "console"]);
    });

    test("to the next column at the same place counted in blocks, or at its end", () => {
        expect(columnIds(moveToColumn(fresh(), "jog", 1))).toEqual([["dro", "laser", "markers"], ["steps", "jog", "preview", "console"], MARKUP[2]!]);
        expect(columnIds(moveToColumn(fresh(), "markers", 1))[1]).toEqual(["steps", "preview", "console", "markers"]);
        expect(moveToColumn(fresh(), "dro", -1)).toEqual(fresh());
        expect(moveToColumn(fresh(), "jobs", 1)).toEqual(fresh());
    });

    test("a drop puts the block before another block, or at a column's end", () => {
        const before = placeBlock(fresh(), "markers", 2, "heightmap");
        expect(columnIds(before)[2]).toEqual(["jobs", "markers", "heightmap", "run"]);
        expect(columnIds(before)[0]).toEqual(["dro", "jog", "laser"]);
        expect(columnIds(placeBlock(fresh(), "dro", 1, null))[1]).toEqual(["steps", "preview", "console", "dro"]);
        // Within its own column, before a panel above it.
        expect(columnIds(placeBlock(fresh(), "markers", 0, "jog"))[0]).toEqual(["dro", "markers", "jog", "laser"]);
        // Onto its own block: no change.
        const stuck = stick(fresh(), "laser");
        expect(placeBlock(stuck, "jog", 0, "laser")).toEqual(stuck);
    });

    test("every move leaves the layout it was given alone", () => {
        const layout = fresh();
        moveBlock(layout, "jog", 1);
        stackOnto(layout, "jog", "dro");
        stick(layout, "jog");
        setPrefs(layout, "jog", { hidden: true });
        expect(layout).toEqual(fresh());
    });
});

describe("stacks", () => {
    test("stacking puts the panel in the other's stack, in front", () => {
        const stacked = stackOnto(fresh(), "console", "preview");
        expect(blocks(stacked, 1)).toEqual([[["steps"]], [["preview", "console"]]]);
        expect(stacked.columns[1]![1]![0]!.front).toBe("console");
        expect(sameArrangement(stacked, MARKUP)).toBe(false);
        // Showing the other one in front.
        expect(bringToFront(stacked, "preview").columns[1]![1]![0]!.front).toBe("preview");
    });

    test("a whole stack stacks onto another, across columns too", () => {
        const two = stackOnto(fresh(), "console", "preview");
        const three = stackOnto(two, "preview", "jobs");
        expect(blocks(three, 2)[0]).toEqual([["jobs", "preview", "console"]]);
        expect(columnIds(three)[1]).toEqual(["steps"]);
    });

    test("the neighbor to stack with is the nearest stack that shows, above or below", () => {
        expect(stackNeighbor(fresh(), "laser", -1)).toBe("jog");
        expect(stackNeighbor(fresh(), "laser", 1)).toBe("markers");
        expect(stackNeighbor(fresh(), "dro", -1)).toBeNull();
        expect(stackNeighbor(fresh(), "laser", -1, (id) => id !== "jog")).toBe("dro");
        // A stack's shown panel stands for it.
        const stacked = bringToFront(stackOnto(fresh(), "jog", "dro"), "dro");
        expect(stackNeighbor(stacked, "laser", -1)).toBe("dro");
        expect(stackNeighbor(stacked, "laser", -1, (id) => id !== "dro")).toBe("jog");
    });

    test("unstacking takes the panel out to a block of its own after the stack", () => {
        const stacked = stackOnto(stackOnto(fresh(), "console", "preview"), "steps", "preview");
        expect(blocks(stacked, 1)).toEqual([[["preview", "console", "steps"]]]);
        const out = unstack(stacked, "console");
        expect(blocks(out, 1)).toEqual([[["preview", "steps"]], [["console"]]]);
        // The one in front leaving puts its neighbor in front.
        expect(out.columns[1]![0]![0]!.front).toBe("steps");
        // A panel alone has no stack to leave.
        expect(unstack(fresh(), "dro")).toEqual(fresh());
    });
});

describe("sticking", () => {
    test("a block sticks under the nearest block above that shows; unsticking parts it again", () => {
        const stuck = stick(fresh(), "laser");
        expect(isStuck(stuck, "laser")).toBe(true);
        expect(isStuck(stuck, "jog")).toBe(false);
        expect(unstick(stuck, "laser")).toEqual(fresh());
        // Nothing above: no change.
        expect(stick(fresh(), "dro")).toEqual(fresh());
        // Over a block that shows nothing, which moves under the joined block.
        const over = stick(fresh(), "laser", (id) => id !== "jog");
        expect(blocks(over, 0)).toEqual([[["dro"], ["laser"]], [["jog"]], [["markers"]]]);
    });

    test("a stack stuck in a block unsticks with the stacks under it", () => {
        const chain = stick(stick(stick(fresh(), "jog"), "laser"), "markers");
        expect(blocks(chain, 0)).toEqual([[["dro"], ["jog"], ["laser"], ["markers"]]]);
        expect(blocks(unstick(chain, "laser"), 0)).toEqual([[["dro"], ["jog"]], [["laser"], ["markers"]]]);
    });
});

describe("a panel's own settings", () => {
    test("set, merged, and cleared by undefined or false", () => {
        let layout = setPrefs(fresh(), "dro", { collapsed: true });
        layout = setPrefs(layout, "dro", { height: 10 });
        expect(layout.panels["dro"]).toEqual({ collapsed: true, height: 10 });
        layout = setPrefs(layout, "dro", { collapsed: undefined });
        expect(layout.panels["dro"]).toEqual({ height: 10 });
        layout = setPrefs(layout, "dro", { height: undefined, hidden: false });
        expect(layout.panels["dro"]).toBeUndefined();
        expect(isDefault(layout, MARKUP)).toBe(true);
    });

    test("a panel put back goes home with nothing set on it", () => {
        let layout = moveToColumn(fresh(), "laser", 1);
        layout = stackOnto(layout, "laser", "preview");
        layout = setPrefs(layout, "laser", { hidden: true, height: 20 });
        const back = resetPanel(layout, "laser", MARKUP);
        expect(columnIds(back)[0]).toEqual(MARKUP[0]);
        expect(blocks(back, 1)).toEqual([[["steps"]], [["preview"]], [["console"]]]);
        expect(back.panels["laser"]).toBeUndefined();
        expect(locate(back, "laser")).toEqual({ column: 0, block: 2, stack: 0, index: 0 });
    });
});

describe("widths", () => {
    test("shares sum to one; a narrow column is raised to the floor", () => {
        expect(cleanWidths([1, 2, 1], 3)).toEqual([0.25, 0.5, 0.25]);
        const floored = cleanWidths([0.01, 0.5, 0.49], 3)!;
        expect(floored[0]).toBeCloseTo(MIN_WIDTH, 3);
        expect(floored.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1, 3);
        // Reading shares back does not move them.
        expect(cleanWidths(floored, 3)).toEqual(floored);
        expect(cleanWidths([0.3343, 0.4157, 0.25], 3)).toEqual([0.3343, 0.4157, 0.25]);
    });

    test("anything but one positive number per column is no widths", () => {
        expect(cleanWidths([1, 2], 3)).toBeNull();
        expect(cleanWidths([1, -2, 1], 3)).toBeNull();
        expect(cleanWidths([1, "2", 1], 3)).toBeNull();
        expect(cleanWidths([1], 1)).toBeNull();
        expect(setWidths(fresh(), [1, 1, 2]).widths).toEqual([0.25, 0.25, 0.5]);
        expect(setWidths(setWidths(fresh(), [1, 1, 2]), null).widths).toBeNull();
    });
});

describe("pages and kept layouts", () => {
    const pages = { jobs: MARKUP, config: [["machine-file"], ["settings"]] };

    test("only pages that differ from their markup are stored, in the pages' order", () => {
        const changed = moveToColumn(defaultLayout(pages.config), "settings", -1);
        const stored = canonicalLayouts({ config: changed, jobs: fresh(), other: changed }, pages);
        expect(Object.keys(stored)).toEqual(["config"]);
        // At the same place counted in blocks: first.
        expect(columnIds(stored["config"]!)).toEqual([["settings", "machine-file"], []]);
    });

    test("stored text that does not read is no layouts", () => {
        expect(readObject(null)).toEqual({});
        expect(readObject("{")).toEqual({});
        expect(readObject("[1]")).toEqual({});
        expect(readObject('{"jobs":1}')).toEqual({ jobs: 1 });
    });

    test("kept names: Default is not one of them, a name must be given", () => {
        expect(readPresets(JSON.stringify({ Default: {}, default: {}, " ": {}, mill: {}, bad: 3 }))).toEqual({ mill: {} });
        expect(presetNameProblem("")).not.toBeNull();
        expect(presetNameProblem("  ")).not.toBeNull();
        expect(presetNameProblem("default")).toContain("built-in");
        expect(presetNameProblem("x".repeat(41))).not.toBeNull();
        expect(presetNameProblem("mill")).toBeNull();
    });

    test("the kept name matching the panels as they are, Default when nothing differs", () => {
        const mill = canonicalLayouts({ jobs: stackOnto(fresh(), "console", "preview") }, pages);
        const kept = { mill: JSON.parse(JSON.stringify(mill)) as Record<string, unknown> };
        expect(matchingPreset({}, kept, pages)).toBe(DEFAULT_PRESET);
        expect(matchingPreset(mill, kept, pages)).toBe("mill");
        const other = canonicalLayouts({ jobs: stick(fresh(), "laser") }, pages);
        expect(matchingPreset(other, kept, pages)).toBeNull();
    });
});
