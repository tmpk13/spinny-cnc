// Picking a path in the preview by what is drawn of it: a pad's dot is as
// wide as the pad, a line as wide as the spot, and a click anywhere on
// either picks it, however far in the view is zoomed.

import { describe, expect, test } from "bun:test";

import type { Camera } from "../src/camera.ts";
import { Preview } from "../src/preview.ts";
import type { Job } from "../src/types.ts";

const W = 400;
const H = 300;
const topDown: Camera = { target: [0, 0, 0], distance: 60, yaw: 0, pitch: 90 };
/** CSS px per mm straight down from 60 mm: half the canvas's height over the tangent of half the field of view, over the distance. */
const SCALE = (H / 2) / Math.tan((20 * Math.PI) / 180) / 60;

/** A canvas of a size, as a laid out page would measure it. */
function sized(width: number, height: number): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.getBoundingClientRect = (() => ({ width, height, x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, toJSON: () => ({}) })) as typeof canvas.getBoundingClientRect;
    document.body.appendChild(canvas);
    return canvas;
}

function job(spot: number, groups: Job["groups"]): Job {
    return {
        id: "j1", name: "j", source: "json", spot, offset: { x: 0, y: 0 },
        groups,
        outline: [], copper: [],
        stats: { length_mm: 0, seconds: 0, max_radius: 0, min_radius: 0, limited_fraction: 0, moves: 0 },
    };
}

function group(paths: [number, number][][], areas?: number[]): Job["groups"][number] {
    return { label: "g", power: 500, min_power: 0, speed: 400, passes: 1, enabled: true, paths, ...(areas ? { areas } : {}) };
}

/** The canvas point over a board point, straight down. */
const at = (x: number, y: number): [number, number] => [W / 2 + x * SCALE, H / 2 - y * SCALE];

describe("picking what is drawn", () => {
    test("a click inside a pad's dot picks it, off its middle too", () => {
        const preview = new Preview(sized(W, H));
        // A pad of 4 pi mm2 is drawn as a dot of 2 mm radius, 13.7 px here.
        preview.setJob(job(0.1, [group([[[0, 0]]], [4 * Math.PI])]));
        preview.setCamera(topDown);
        expect(2 * SCALE).toBeGreaterThan(13);
        // 1.6 mm from its middle, 11 px: inside the dot drawn.
        expect(preview.pick(...at(1.6, 0))).toEqual([0, 0]);
        // Beyond the dot's edge by more than the pick's reach: nothing.
        expect(preview.pick(...at(4, 0))).toBeNull();
        preview.dispose();
    });

    test("a click on a line drawn as wide as a wide spot picks it, and the line nearest wins where two are drawn over each other", () => {
        const preview = new Preview(sized(W, H));
        // A 3 mm spot draws its lines 20.6 px wide here.
        preview.setJob(job(3, [group([[[-10, 0], [10, 0]], [[-10, 2.5], [10, 2.5]]])]));
        preview.setCamera(topDown);
        // 1.4 mm (9.6 px) off the first line, on its stroke and on the second's too: the first is nearer.
        expect(preview.pick(...at(0, 1.2))).toEqual([0, 0]);
        expect(preview.pick(...at(0, -1.4))).toEqual([0, 0]);
        expect(preview.pick(...at(0, 1.4))).toEqual([0, 1]);
        expect(preview.pick(...at(0, -4))).toBeNull();
        preview.dispose();
    });
});
