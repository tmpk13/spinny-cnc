import { describe, expect, test } from "bun:test";

import { BRIGHT_LEVEL, DARK_LEVEL, EDGE_LEVELS, grayOf, HISTOGRAM_BINS, pictureStats } from "../src/imagestats.ts";

/** A seeded uniform number in [0, 1): mulberry32. */
function uniform(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** A gray picture of `level(x, y)` with gaussian noise of `sigma` levels, rounded and held to 0..255. */
function picture(width: number, height: number, level: (x: number, y: number) => number, sigma = 0, seed = 7): Uint8Array {
    const next = uniform(seed);
    const gray = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            // Box and Muller: two uniforms make a normal one.
            const normal = Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
            gray[y * width + x] = Math.max(0, Math.min(255, Math.round(level(x, y) + sigma * normal)));
        }
    }
    return gray;
}

/** A disc of `inner` on `outer`, `radius` px about the middle. */
function disc(width: number, height: number, radius: number, inner: number, outer: number): (x: number, y: number) => number {
    return (x, y) => (Math.hypot(x - width / 2, y - height / 2) <= radius ? inner : outer);
}

/** The picture averaged over a square `size` px on a side about each pixel (edges held). */
function blurred(gray: Uint8Array, width: number, height: number, size: number): Uint8Array {
    const half = Math.floor(size / 2);
    const out = new Uint8Array(gray.length);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let sum = 0;
            for (let dy = -half; dy <= half; dy++) {
                for (let dx = -half; dx <= half; dx++) {
                    const sx = Math.max(0, Math.min(width - 1, x + dx));
                    const sy = Math.max(0, Math.min(height - 1, y + dy));
                    sum += gray[sy * width + sx]!;
                }
            }
            out[y * width + x] = Math.round(sum / (size * size));
        }
    }
    return out;
}

describe("a picture's numbers", () => {
    test("gray is the luma JPEG weighs", () => {
        const rgba = [255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255];
        expect(Array.from(grayOf(rgba, 5))).toEqual([255, 0, 77, 149, 29]);
    });

    test("a flat picture: its level, no spread, no edges, no noise, no ratio", () => {
        const stats = pictureStats(picture(64, 48, () => 128), 64, 48);
        expect(stats).toMatchObject({ width: 64, height: 48, mean: 128, spread: 0, dark: 0, bright: 0, sharpness: 0, edges: 0, noise: 0, snr: null });
        expect(stats.histogram).toHaveLength(HISTOGRAM_BINS);
        expect(stats.histogram[32]).toBe(1);
        expect(stats.histogram.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    });

    test("the shares clipped black and white, and the mean and spread", () => {
        // Half black, a quarter white, a quarter mid gray, in rows.
        const stats = pictureStats(picture(40, 40, (_x, y) => (y < 20 ? 0 : y < 30 ? 255 : 128)), 40, 40);
        expect(stats.dark).toBe(0.5);
        expect(stats.bright).toBe(0.25);
        expect(stats.mean).toBeCloseTo(0.25 * 255 + 0.25 * 128, 9);
        const variance = 0.5 * stats.mean ** 2 + 0.25 * (255 - stats.mean) ** 2 + 0.25 * (128 - stats.mean) ** 2;
        expect(stats.spread).toBeCloseTo(Math.sqrt(variance), 9);
        // The clipped levels are the named ones.
        expect(pictureStats(picture(8, 8, () => DARK_LEVEL), 8, 8).dark).toBe(1);
        expect(pictureStats(picture(8, 8, () => DARK_LEVEL + 1), 8, 8).dark).toBe(0);
        expect(pictureStats(picture(8, 8, () => BRIGHT_LEVEL), 8, 8).bright).toBe(1);
        expect(pictureStats(picture(8, 8, () => BRIGHT_LEVEL - 1), 8, 8).bright).toBe(0);
    });

    test("noise of a known size is measured, and the signal to noise ratio from it", () => {
        const stats = pictureStats(picture(200, 200, () => 100, 5), 200, 200);
        expect(stats.noise).toBeGreaterThan(4.5);
        expect(stats.noise).toBeLessThan(5.5);
        expect(stats.snr!).toBeCloseTo(20 * Math.log10(100 / 5), 0);
    });

    test("edges are not taken for noise", () => {
        // A bright disc on a dark board, with the same noise as a flat picture.
        const flat = pictureStats(picture(200, 200, () => 60, 4, 3), 200, 200);
        const round = pictureStats(picture(200, 200, disc(200, 200, 60, 200, 50), 4, 3), 200, 200);
        expect(round.noise).toBeGreaterThan(4 * 0.85);
        expect(round.noise).toBeLessThan(4 * 1.15);
        expect(Math.abs(round.noise - flat.noise)).toBeLessThan(0.5);
        // The disc's rim is an edge, the rest is not (noise of 4 levels
        // passes the edge's gradient about once in 40000 pixels).
        expect(round.edges).toBeGreaterThan(0.01);
        expect(round.edges).toBeLessThan(0.1);
        expect(flat.edges).toBeLessThan(0.001);
    });

    test("sharpness is the gradient's root mean square, and falls as the picture blurs", () => {
        // A ramp of 2 levels a pixel: that gradient everywhere, under an edge, and no noise.
        const ramp = pictureStats(picture(50, 30, (x) => 20 + 2 * x), 50, 30);
        expect(ramp.sharpness).toBeCloseTo(2, 9);
        expect(ramp.edges).toBe(0);
        expect(ramp.noise).toBeCloseTo(0, 9);
        expect(EDGE_LEVELS).toBeGreaterThan(2);
        const sharp = picture(120, 120, disc(120, 120, 35, 220, 40));
        const soft = blurred(sharp, 120, 120, 7);
        const crisp = pictureStats(sharp, 120, 120);
        const blurry = pictureStats(soft, 120, 120);
        expect(crisp.sharpness).toBeGreaterThan(blurry.sharpness * 1.5);
        expect(crisp.edges).toBeGreaterThan(0);
    });

    test("a picture too small for a neighborhood has a level but no gradient or noise", () => {
        const stats = pictureStats(new Uint8Array([10, 20, 30, 40]), 2, 2);
        expect(stats.mean).toBe(25);
        expect(stats).toMatchObject({ sharpness: 0, edges: 0, noise: 0, snr: null });
    });
});
