// Live numbers of a camera's picture at the head of its controls' fold,
// while the fold is open, so focus, exposure and gain can be turned by
// numbers rather than by eye: each frame its picture shows (picture.ts
// hands them over), no more than five a second, is read through a small
// canvas, only the part the zoom shows and at most MAX_PIXELS of it, and
// measured (imagestats.ts). Sharpness keeps its best since the fold
// opened, so focus can be turned to the peak; the best starts again when
// the zoom or the picture's size changes, since sharpness compares only at
// one of each. Nothing is read while the fold is closed.

import { button, el } from "../dom.ts";
import { formatFixed } from "../format.ts";
import { grayOf, HISTOGRAM_BINS, NOISE_FLOOR, pictureStats, type PictureStats } from "../imagestats.ts";
import type { ControlledCamera } from "../types.ts";
import { type ShownFrame, watchFrames } from "./picture.ts";

/** The least time between two measures, ms. */
export const STATS_INTERVAL_MS = 200;
/** The most pixels measured: the part shown is shrunk to this. */
export const MAX_PIXELS = 640 * 360;
/** No frame for this long and the numbers are old, ms. */
export const STALE_MS = 2000;

/** RGBA rows of the part of a frame shown. */
export interface FramePixels {
    data: ArrayLike<number>;
    width: number;
    height: number;
}

/** Reads a frame's pixels: null with no picture or no canvas, `unreadable` when the page may not read them. */
export type PixelReader = (frame: ShownFrame) => FramePixels | "unreadable" | null;

/** The part of a picture `natural` px wide and high the zoom shows (x, y, width, height), and the size it is measured at: no more than MAX_PIXELS. */
export function statsRegion(natural: [number, number], zoom: number): { source: [number, number, number, number]; size: [number, number] } {
    const [width, height] = natural;
    const factor = Math.max(1, zoom);
    const shownWidth = width / factor;
    const shownHeight = height / factor;
    const shrink = Math.min(1, Math.sqrt(MAX_PIXELS / Math.max(1, shownWidth * shownHeight)));
    return {
        source: [(width - shownWidth) / 2, (height - shownHeight) / 2, shownWidth, shownHeight],
        size: [Math.max(3, Math.round(shownWidth * shrink)), Math.max(3, Math.round(shownHeight * shrink))],
    };
}

let canvas: HTMLCanvasElement | null = null;

/** The part of the frame shown, read through a canvas the pictures share; a picture from another address is `unreadable` (the canvas is tainted). */
export function readFrame(frame: ShownFrame): FramePixels | "unreadable" | null {
    const image = frame.image;
    if (!(image.naturalWidth > 0 && image.naturalHeight > 0)) {
        return null;
    }
    const { source, size } = statsRegion([image.naturalWidth, image.naturalHeight], frame.zoom);
    canvas ??= document.createElement("canvas");
    canvas.width = size[0];
    canvas.height = size[1];
    let context: CanvasRenderingContext2D | null = null;
    try {
        context = canvas.getContext("2d", { willReadFrequently: true });
    } catch {
        return null;
    }
    if (!context) {
        return null;
    }
    try {
        context.drawImage(image, source[0], source[1], source[2], source[3], 0, 0, size[0], size[1]);
        return context.getImageData(0, 0, size[0], size[1]);
    } catch {
        return "unreadable";
    }
}

/** A share as a percentage with one decimal. */
function percent(share: number): string {
    return `${formatFixed(share * 100, 1)}%`;
}

/** The words of each row: sharpness against the best and the edges, noise and the ratio, brightness and its spread, and the shares clipped. */
export function statsLines(stats: PictureStats, best: number): { sharpness: string; noise: string; brightness: string; clipped: string } {
    const against = best > 0 ? ` (best ${formatFixed(best, 1)}, ${Math.round((100 * stats.sharpness) / best)}%)` : "";
    return {
        sharpness: `${formatFixed(stats.sharpness, 1)}${against}; edges ${percent(stats.edges)}`,
        noise: stats.snr === null || stats.noise < NOISE_FLOOR
            ? "none measured"
            : `${formatFixed(stats.noise, 2)} levels; SNR ${formatFixed(stats.snr, 1)} dB`,
        brightness: `${formatFixed(stats.mean, 0)} of 255; spread ${formatFixed(stats.spread, 0)}`,
        clipped: `black ${percent(stats.dark)}, white ${percent(stats.bright)}`,
    };
}

/** The histogram as bars a unit wide and at most a unit high, y down: the square root of each bin's share of the fullest, so a few pixels still show. */
export function histogramPath(histogram: number[]): string {
    const most = Math.max(0, ...histogram);
    if (!(most > 0)) {
        return "";
    }
    return histogram.map((share, bin) => {
        const high = Math.sqrt(share / most);
        return high > 0 ? `M${bin} 1V${(1 - high).toFixed(4)}H${bin + 1}V1Z` : "";
    }).join("");
}

export interface StatsView {
    root: HTMLElement;
    /** Measures the frames the camera's picture shows from now on, the best afresh. */
    start(): void;
    /** Stops measuring. */
    stop(): void;
}

export interface StatsOptions {
    /** How the pixels are read; a canvas by default. */
    read?: PixelReader;
    /** The clock, ms. */
    now?: () => number;
}

const SVG_NS = "http://www.w3.org/2000/svg";

export function mountCameraStats(camera: ControlledCamera, options: StatsOptions = {}): StatsView {
    const read = options.read ?? readFrame;
    const now = options.now ?? (() => Date.now());
    const row = (label: string, tip: string): { line: HTMLElement; value: HTMLElement } => {
        const value = el("span", { class: "mono camera-stat-value" });
        return { line: el("div", { class: "camera-stat", title: tip }, el("span", { class: "camera-stat-name" }, label), value), value };
    };
    const sharpness = row("Sharpness", "how crisp the edges are, levels a pixel: turn the focus to the best; compares at one zoom and light");
    const noise = row("Noise", "grain in the flat parts, levels: less is better; SNR, brightness over noise, more is better");
    const brightness = row("Brightness", "mean level, 0 black to 255 white, and its spread: more spread sets the parts apart");
    const clipped = row("Clipped", "pixels at pure black or white, whose detail is lost: keep both near 0%");
    const numbers = el("div", { class: "camera-stats-grid hidden" }, sharpness.line, noise.line, brightness.line, clipped.line);
    const bars = document.createElementNS(SVG_NS, "path");
    const histogram = document.createElementNS(SVG_NS, "svg");
    histogram.setAttribute("class", "camera-stats-histogram hidden");
    histogram.setAttribute("viewBox", `0 0 ${HISTOGRAM_BINS} 1`);
    histogram.setAttribute("preserveAspectRatio", "none");
    histogram.setAttribute("role", "img");
    histogram.setAttribute("aria-label", "histogram of the picture's levels, black at the left");
    const tip = document.createElementNS(SVG_NS, "title");
    tip.textContent = "how many pixels at each level, black at the left";
    histogram.append(tip, bars);
    // Hidden while empty: a grid item takes its gap even with nothing in it.
    const status = el("p", { class: "muted camera-stats-status hidden" });
    const reset = button("Reset best", () => {
        best = last?.sharpness ?? 0;
        show();
    }, "btn btn-quiet btn-small", "start the best sharpness again from the picture now");
    const root = el("div", { class: "camera-stats" },
        el("div", { class: "button-row" }, el("span", { class: "camera-stats-head" }, "Live picture"), reset),
        numbers,
        histogram,
        status,
    );

    let unwatch: (() => void) | null = null;
    let staleTimer: ReturnType<typeof setInterval> | null = null;
    let measuredAt = Number.NEGATIVE_INFINITY;
    let seenAt = 0;
    let last: PictureStats | null = null;
    let marked = false;
    let best = 0;
    let shape = "";

    function say(text: string): void {
        status.textContent = text;
        status.classList.toggle("hidden", text === "");
    }

    function show(): void {
        if (last === null) {
            return;
        }
        const lines = statsLines(last, best);
        sharpness.value.textContent = lines.sharpness;
        noise.value.textContent = lines.noise;
        brightness.value.textContent = lines.brightness;
        clipped.value.textContent = lines.clipped;
        bars.setAttribute("d", histogramPath(last.histogram));
        numbers.classList.remove("hidden", "stale");
        histogram.classList.remove("hidden", "stale");
        say(marked ? "pcbv's marks are drawn into this picture and count as edges: Overlay off measures the camera alone." : "");
    }

    function measure(frame: ShownFrame): void {
        const at = now();
        seenAt = at;
        if (at - measuredAt < STATS_INTERVAL_MS) {
            return;
        }
        measuredAt = at;
        const pixels = read(frame);
        if (pixels === null) {
            say("This browser gives the page no pixels to measure.");
            return;
        }
        if (pixels === "unreadable") {
            say("The page may not read this picture's pixels: it comes from another address.");
            return;
        }
        const stats = pictureStats(grayOf(pixels.data, pixels.width * pixels.height), pixels.width, pixels.height);
        // Sharpness compares only at one zoom and one picture size.
        const next = `${frame.image.naturalWidth}x${frame.image.naturalHeight}@${frame.zoom}`;
        if (next !== shape) {
            shape = next;
            best = 0;
        }
        best = Math.max(best, stats.sharpness);
        last = stats;
        marked = frame.marked === true;
        show();
    }

    /** No frame for a while: the numbers dim and the line says why. */
    function checkStale(): void {
        if (now() - seenAt > STALE_MS) {
            numbers.classList.add("stale");
            histogram.classList.add("stale");
            say("No picture: the numbers come while the camera runs and its picture is on screen.");
        }
    }

    return {
        root,
        start() {
            if (unwatch !== null) {
                return;
            }
            last = null;
            best = 0;
            shape = "";
            measuredAt = Number.NEGATIVE_INFINITY;
            seenAt = now();
            numbers.classList.add("hidden");
            histogram.classList.add("hidden");
            say("Waiting for the camera's picture.");
            unwatch = watchFrames(camera, measure);
            staleTimer = setInterval(checkStale, 500);
        },
        stop() {
            unwatch?.();
            unwatch = null;
            if (staleTimer !== null) {
                clearInterval(staleTimer);
                staleTimer = null;
            }
        },
    };
}
