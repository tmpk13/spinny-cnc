// Numbers of a camera's picture for tuning its controls: how sharp its
// edges are and how much of it is edges, how noisy it is and its signal to
// noise ratio, how bright it is and how spread its brightness, how much is
// clipped black or white, and its histogram. Pure functions over a gray
// picture (a byte a pixel, rows from the top), so they are tested without
// a canvas; views/camerastats.ts reads the pixels of the picture shown.
//
// Sharpness is the root mean square of the brightness gradient (Sobel,
// scaled to levels per pixel): it peaks when the picture is in focus, but
// it also grows with contrast and with a smaller picture, so it compares
// one focus with another at one zoom and one exposure. Noise is
// Immerkaer's estimate (Fast noise variance estimation, CVIU 64, 1996):
// the mean magnitude of a mask that cancels flat and sloped brightness,
// over the pixels whose gradient is within three noise deviations, so
// edges do not count as noise.

/** At or under: clipped black. */
export const DARK_LEVEL = 5;
/** At or over: clipped white. */
export const BRIGHT_LEVEL = 250;
/** A gradient of this many levels a pixel or more is an edge. */
export const EDGE_LEVELS = 8;
export const HISTOGRAM_BINS = 64;
/** Under this many levels no noise is measured, and there is no ratio. */
export const NOISE_FLOOR = 0.01;

/** Immerkaer's mask's mean magnitude per level of noise: the mask's deviation is 6 sigma, a mean magnitude sqrt(2 / pi) of it. */
const MASK_PER_SIGMA = 6 * Math.sqrt(2 / Math.PI);
/** The gradient a pixel of pure noise stays under but for one pixel in a hundred: three deviations of the scaled Sobel, sqrt(12) / 8 sigma. */
const NOISE_EDGE = (3 * Math.sqrt(12)) / 8;

export interface PictureStats {
    /** The size measured, px. */
    width: number;
    height: number;
    /** Brightness: the mean level, 0 to 255, and its standard deviation. */
    mean: number;
    spread: number;
    /** Shares of the pixels clipped black and white, 0 to 1. */
    dark: number;
    bright: number;
    /** The root mean square gradient, levels a pixel, and the share of pixels on an edge. */
    sharpness: number;
    edges: number;
    /** The noise's standard deviation, levels, and the mean over it in dB; null with no noise measured. */
    noise: number;
    snr: number | null;
    /** The shares of the pixels in each of HISTOGRAM_BINS equal bins of level, darkest first. */
    histogram: number[];
}

/** The gray of RGBA pixels: their luma as JPEG and OpenCV weigh it (0.299 R, 0.587 G, 0.114 B). */
export function grayOf(rgba: ArrayLike<number>, pixels: number): Uint8Array {
    const gray = new Uint8Array(pixels);
    for (let i = 0, j = 0; i < pixels; i += 1, j += 4) {
        gray[i] = (77 * rgba[j]! + 150 * rgba[j + 1]! + 29 * rgba[j + 2]! + 128) >> 8;
    }
    return gray;
}

/** The numbers of a gray picture `width` by `height` px. */
export function pictureStats(gray: Uint8Array | Uint8ClampedArray, width: number, height: number): PictureStats {
    const pixels = Math.min(gray.length, width * height);
    const counts = new Float64Array(256);
    let sum = 0;
    let squares = 0;
    for (let i = 0; i < pixels; i++) {
        const level = gray[i]!;
        counts[level]! += 1;
        sum += level;
        squares += level * level;
    }
    const mean = pixels > 0 ? sum / pixels : 0;
    const spread = pixels > 0 ? Math.sqrt(Math.max(0, squares / pixels - mean * mean)) : 0;
    let dark = 0;
    let bright = 0;
    const histogram: number[] = new Array<number>(HISTOGRAM_BINS).fill(0);
    for (let level = 0; level < 256; level++) {
        if (level <= DARK_LEVEL) {
            dark += counts[level]!;
        }
        if (level >= BRIGHT_LEVEL) {
            bright += counts[level]!;
        }
        histogram[Math.floor((level * HISTOGRAM_BINS) / 256)]! += counts[level]!;
    }
    const share = (count: number): number => (pixels > 0 ? count / pixels : 0);

    // The gradient and the noise mask at every pixel with all eight
    // neighbors, kept for the noise's second look.
    const inner = width >= 3 && height >= 3 ? (width - 2) * (height - 2) : 0;
    const gradients = new Float32Array(inner);
    const masks = new Float32Array(inner);
    let gradientSquares = 0;
    let edgeCount = 0;
    let maskSum = 0;
    let at = 0;
    for (let y = 1; y < height - 1 && inner > 0; y++) {
        const row = y * width;
        for (let x = 1; x < width - 1; x++) {
            const i = row + x;
            const a = gray[i - width - 1]!;
            const b = gray[i - width]!;
            const c = gray[i - width + 1]!;
            const d = gray[i - 1]!;
            const e = gray[i]!;
            const f = gray[i + 1]!;
            const g = gray[i + width - 1]!;
            const h = gray[i + width]!;
            const k = gray[i + width + 1]!;
            const gx = (c + 2 * f + k - a - 2 * d - g) / 8;
            const gy = (g + 2 * h + k - a - 2 * b - c) / 8;
            const squared = gx * gx + gy * gy;
            const gradient = Math.sqrt(squared);
            gradientSquares += squared;
            if (gradient >= EDGE_LEVELS) {
                edgeCount += 1;
            }
            const mask = Math.abs(a - 2 * b + c - 2 * d + 4 * e - 2 * f + g - 2 * h + k);
            maskSum += mask;
            gradients[at] = gradient;
            masks[at] = mask;
            at += 1;
        }
    }
    // Over every pixel first, then twice over those whose gradient pure
    // noise of that size would give: an edge left in reads as noise.
    let noise = inner > 0 ? maskSum / inner / MASK_PER_SIGMA : 0;
    for (let pass = 0; pass < 2 && inner > 0; pass++) {
        const limit = NOISE_EDGE * noise;
        let total = 0;
        let count = 0;
        for (let j = 0; j < inner; j++) {
            if (gradients[j]! <= limit) {
                total += masks[j]!;
                count += 1;
            }
        }
        if (count === 0) {
            break;
        }
        noise = total / count / MASK_PER_SIGMA;
    }
    return {
        width,
        height,
        mean,
        spread,
        dark: share(dark),
        bright: share(bright),
        sharpness: inner > 0 ? Math.sqrt(gradientSquares / inner) : 0,
        edges: inner > 0 ? edgeCount / inner : 0,
        noise,
        snr: noise >= NOISE_FLOOR && mean > 0 ? 20 * Math.log10(mean / noise) : null,
        histogram: histogram.map(share),
    };
}
