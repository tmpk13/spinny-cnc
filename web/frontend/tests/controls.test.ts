// The page's default controls are the backend's word for word: the shipped
// machine files spell out the defaults for what they are (the backend's
// tests check that against its own defaults), so the page's twin is read
// against the files here.

import { describe, expect, test } from "bun:test";

import cartesianLaser from "../../../machines/cartesian-laser.toml" with { type: "text" };
import cartesianMill from "../../../machines/cartesian-mill.toml" with { type: "text" };
import polarLaserFocus from "../../../machines/polar-laser-focus.toml" with { type: "text" };
import polarLaser from "../../../machines/polar-laser.toml" with { type: "text" };
import { controlOf, controlsOf, defaultControls, sameControls } from "../src/controls.ts";
import { MockBackend } from "../src/mock/backend.ts";
import { parseToml, type TomlTable } from "../src/toml.ts";
import { initialState } from "../src/state.ts";
import type { Profile } from "../src/types.ts";

const SHIPPED: [string, string, Profile][] = [
    ["polar-laser", polarLaser, { kinematics: "polar", tool: "laser", h_axis: false, r_max: 0, z_max: 0 }],
    ["polar-laser-focus", polarLaserFocus, { kinematics: "polar", tool: "laser", h_axis: true, r_max: 0, z_max: 0 }],
    ["cartesian-laser", cartesianLaser, { kinematics: "cartesian", tool: "laser", h_axis: false, r_max: 0, z_max: 30 }],
    ["cartesian-mill", cartesianMill, { kinematics: "cartesian", tool: "spindle", h_axis: true, r_max: 0, z_max: 30 }],
];

describe("default controls", () => {
    test("are what the shipped machine files spell out", () => {
        for (const [id, text, profile] of SHIPPED) {
            const file = parseToml(text);
            const controls = file["controls"] as TomlTable;
            const expected = defaultControls(profile);
            const { axes, ...top } = controls;
            // The files say what they say; a key left out is the default.
            const said = (where: string, key: string, value: unknown): Record<string, unknown> => ({ [`${id} ${where} ${key}`]: value });
            for (const [key, value] of Object.entries(top)) {
                expect(said("controls", key, (expected as unknown as Record<string, unknown>)[key])).toEqual(said("controls", key, value));
            }
            const entries = axes as TomlTable[];
            expect(entries.map((entry) => entry["axis"])).toEqual(expected.axes.map((axis) => axis.axis));
            entries.forEach((entry, index) => {
                const axis = expected.axes[index] as unknown as Record<string, unknown>;
                for (const [key, value] of Object.entries(entry)) {
                    expect(said(String(entry["axis"]), key, axis[key])).toEqual(said(String(entry["axis"]), key, value));
                }
            });
        }
    });

    test("follow the kinematics, the tool and the focus axis", () => {
        const polar = defaultControls(SHIPPED[0]![2]);
        expect(polar.axes.map((axis) => axis.axis)).toEqual(["r", "a", "z"]);
        expect(polar.center).toEqual({ r: 0 });
        expect(controlOf(polar, "r")?.steps).toBeNull();
        expect(controlOf(polar, "a")?.step).toBe(10);
        const mill = defaultControls(SHIPPED[3]![2]);
        expect(mill.axes.map((axis) => axis.goto)).toEqual([true, false, true, false]);
        expect(controlOf(mill, "h")?.label).toBe("Depth axis");
        expect(controlOf(mill, "z")?.label).toBe("Cross slide (Y)");
        expect(sameControls(polar, defaultControls(SHIPPED[0]![2]))).toBe(true);
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
