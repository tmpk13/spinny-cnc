// The page's default controls are the backend's word for word: the backend
// prints its defaults for every kind of machine into a fixture (mise run
// controls-fixture), which its tests keep current, and the page's twin is
// read against that fixture here. The shipped machine files are read too,
// as what they say they are.

import { describe, expect, test } from "bun:test";

import fixture from "../../../toolpath/tests/data/default-controls.json" with { type: "json" };
import { controlOf, controlsOf, defaultControls, sameControls } from "../src/controls.ts";
import { MockBackend } from "../src/mock/backend.ts";
import { initialState } from "../src/state.ts";
import type { Controls, Kinematics, Profile, Tool } from "../src/types.ts";

const SHIPPED: [string, Profile][] = [
    ["polar-laser", { kinematics: "polar", tool: "laser", h_axis: false, r_max: 0, z_max: 0 }],
    ["polar-laser-focus", { kinematics: "polar", tool: "laser", h_axis: true, r_max: 0, z_max: 0 }],
    ["cartesian-laser", { kinematics: "cartesian", tool: "laser", h_axis: false, r_max: 0, z_max: 30 }],
    ["cartesian-mill", { kinematics: "cartesian", tool: "spindle", h_axis: true, r_max: 0, z_max: 30 }],
];

describe("default controls", () => {
    test("are the backend's for every kind of machine", () => {
        const kinds = Object.keys(fixture);
        // Two kinematics by two tools by two focus axes, and the cartesian dispenser with and without the axis.
        expect(kinds).toHaveLength(10);
        expect(kinds).toContain("cartesian-dispenser");
        expect(kinds).toContain("cartesian-dispenser-focus");
        for (const kind of kinds) {
            // polar-laser, cartesian-spindle-focus: the kinematics, the tool and whether a focus axis is fitted.
            const [kinematics, tool, focus] = kind.split("-");
            const profile: Profile = { kinematics: kinematics as Kinematics, tool: tool as Tool, h_axis: focus === "focus", r_max: 0, z_max: 0 };
            const expected = (fixture as unknown as Record<string, Controls>)[kind]!;
            expect({ kind, controls: defaultControls(profile) }).toEqual({ kind, controls: expected });
        }
    });

    test("the shipped files read as what they say they are, and the polar laser's spells the defaults out", async () => {
        const backend = new MockBackend({ timers: false });
        for (const [id, profile] of SHIPPED) {
            const { document, problems } = await backend.machineFile(id);
            expect({ id, problems }).toEqual({ id, problems: [] });
            expect({ id, kind: [document?.kinematics, document?.tool, document?.focus] }).toEqual({ id, kind: [profile.kinematics, profile.tool, profile.h_axis] });
        }
        expect((await backend.machineFile("polar-laser")).document?.controls).toEqual(defaultControls(SHIPPED[0]![1]));
        // The mill draws its rail, cross slide and depth axis as X, Y and Z bars, with no pad and no table.
        expect((await backend.machineFile("cartesian-mill")).document?.controls.axes.map((axis) => [axis.axis, axis.letter])).toEqual([["r", "X"], ["z", "Y"], ["h", "Z"]]);
    });

    test("follow the kinematics, the tool and the focus axis", () => {
        const polar = defaultControls(SHIPPED[0]![1]);
        expect(polar.axes.map((axis) => axis.axis)).toEqual(["r", "a", "z"]);
        expect(polar.center).toEqual({ r: 0 });
        expect(controlOf(polar, "r")?.steps).toBeNull();
        expect(controlOf(polar, "a")?.step).toBe(10);
        const mill = defaultControls(SHIPPED[3]![1]);
        expect(mill.axes.map((axis) => axis.goto)).toEqual([true, false, true, false]);
        expect(controlOf(mill, "h")?.label).toBe("Depth axis");
        expect(controlOf(mill, "z")?.label).toBe("Cross slide (Y)");
        expect(sameControls(polar, defaultControls(SHIPPED[0]![1]))).toBe(true);
        expect(sameControls(polar, mill)).toBe(false);
    });

    test("stand in until the settings say, and the mock answers with them", async () => {
        const state = initialState(true);
        expect(controlsOf(state)).toEqual(defaultControls({ kinematics: "polar", tool: "laser", h_axis: false, r_max: 0, z_max: 0 }));
        const backend = new MockBackend({ timers: false });
        const settings = await backend.settings();
        expect(settings.controls?.axes.map((axis) => axis.axis)).toEqual(["r", "a", "z", "h"]);
        expect(settings.controls).toEqual(defaultControls(backend.machine.profile()));
        expect(controlsOf({ ...state, settings })).toBe(settings.controls!);
    });
});
