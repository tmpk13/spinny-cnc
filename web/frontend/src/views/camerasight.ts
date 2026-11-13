// A camera's lens and picked colors, folded under its settings like its
// picture controls. The lens: the camera put over the calibration dot grid
// (Calibration test, camera pattern), Measure lens has pcbv measure how the
// lens bends the grid's rows and keeps the two terms, which pcbv then
// corrects every point of a picture by, from every start on. The colors:
// Pick arms the camera's picture, whose next click reads the color there,
// kept for what the camera looks for: spots (marks, fiducials, pads), the
// board's pads, or a blank board's edges against the bed.

import { button, el, labeled, lockFor, numberField, setLocked } from "../dom.ts";
import { formatFixed, parseNumber } from "../format.ts";
import type { AppState } from "../state.ts";
import type { CameraColors, CameraLens, ColorItem, ControlledCamera, SpotPolarity } from "../types.ts";
import type { Ctx } from "./context.ts";
import { armPick, armedPick, disarmPick } from "./picture.ts";

/** What each color is for, in words. */
export const COLOR_ITEMS: { item: ColorItem; label: string; what: string }[] = [
    { item: "spots", label: "Spots", what: "a mark, a fiducial or a pad shows" },
    { item: "board", label: "Board pads", what: "the board's pads show" },
    { item: "edges", label: "Edges", what: "the blank board (or the bed beside it) shows" },
];

/** A lens's terms in words; empty with none. */
export function lensText(lens: CameraLens | null | undefined): string {
    if (!lens) {
        return "No lens correction: points are taken as the picture shows them.";
    }
    return `Lens corrected: k1 ${formatFixed(lens.k1, 4)}, k2 ${formatFixed(lens.k2, 4)}, for ${lens.width}x${lens.height} pictures.`;
}

/** A color as CSS. */
export function rgbCss(rgb: [number, number, number]): string {
    return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

export interface CameraSightOptions {
    camera: ControlledCamera;
    /** The camera in words, for tooltips. */
    label: string;
    /** The camera's settings (its lens and colors) and whether it runs. */
    settings(state: AppState): { lens?: CameraLens | null; colors?: CameraColors } | null;
    running(state: AppState): boolean;
}

export function mountCameraSight(ctx: Ctx, options: CameraSightOptions): { root: HTMLDetailsElement; render(state: AppState): void } {
    const lensLine = el("p", { class: "muted" });
    const polarity = el("select", { class: "field", "aria-label": "Dot polarity" },
        el("option", { value: "dark" }, "dark dots"), el("option", { value: "bright" }, "bright dots")) as HTMLSelectElement;
    polarity.title = "dark dots on a light ground (a printed sheet), or bright dots on a dark one (a laser on anodized aluminum)";
    const pitch = numberField({ value: 2, min: 0.1, max: 50, step: 0.5, width: "5rem" });
    pitch.setAttribute("aria-label", "Dot pitch mm");
    const measure = button("Measure lens", () => void measureLens(), "btn",
        "with the dot grid filling the picture, measure how the lens bends it and correct every point from now on");
    const clear = button("Clear lens", () => void clearLens(), "btn btn-quiet", "forget the lens correction");
    const colorRows = COLOR_ITEMS.map(({ item, label, what }) => {
        const swatch = el("span", { class: "color-swatch none", role: "img", "aria-label": `${label} color` });
        const text = el("span", { class: "muted mono" }, "none");
        const pick = button("Pick", () => armPick(options.camera, `${what} (for ${label.toLowerCase()})`, (point) => void pickAt(item, point)), "btn btn-small",
            `click this, then the camera's picture where ${what}: the camera looks for that color`);
        const forget = button("Clear", () => void ctx.call(ctx.api.cameraColor(options.camera, item, null)), "btn btn-quiet btn-small",
            `look for ${label.toLowerCase()} by shade again`);
        return { item, swatch, text, pick, forget, row: el("div", { class: "button-row" }, labeled(label, swatch, "labeled inline"), text, pick, forget) };
    });
    const summary = el("summary", { class: "camera-controls-head" }, "Lens and colors");
    summary.title = `${options.label}'s lens correction and the colors it looks for`;
    const root = el("details", { class: "camera-controls camera-sight" },
        summary,
        lensLine,
        el("div", { class: "button-row" }, labeled("Dots", polarity, "labeled inline"), labeled("Pitch mm", pitch, "labeled inline"), measure, clear),
        ...colorRows.map((row) => row.row),
        el("p", { class: "muted hint" }, "A color picked is looked for in place of light or dark: copper on bare FR4, a fiducial under odd light, the board against the bed."),
    ) as HTMLDetailsElement;

    async function measureLens(): Promise<void> {
        const value = parseNumber(pitch.value);
        if (value === null || value < 0.1 || value > 50) {
            ctx.toast("error", "pitch: 0.1 to 50 mm");
            return;
        }
        // The camera's state comes back over the event stream.
        await ctx.call(ctx.api.cameraLens(options.camera, polarity.value as SpotPolarity, value));
    }

    async function clearLens(): Promise<void> {
        await ctx.call(ctx.api.cameraLensClear(options.camera));
    }

    async function pickAt(item: ColorItem, point: [number, number]): Promise<void> {
        await ctx.call(ctx.api.cameraColor(options.camera, item, point));
    }

    function render(state: AppState): void {
        const settings = options.settings(state);
        const running = options.running(state);
        lensLine.textContent = lensText(settings?.lens);
        lockFor(measure, [!running, `start ${options.label} first`]);
        setLocked(clear, !settings?.lens, "no lens correction kept");
        for (const row of colorRows) {
            const rgb = settings?.colors?.[row.item] ?? null;
            row.swatch.classList.toggle("none", rgb === null);
            row.swatch.style.background = rgb ? rgbCss(rgb) : "";
            row.text.textContent = rgb ? `${rgb[0]}, ${rgb[1]}, ${rgb[2]}` : "none";
            lockFor(row.pick, [!running, `start ${options.label} first`]);
            row.pick.setAttribute("aria-pressed", armedPick(options.camera) !== null ? "true" : "false");
            setLocked(row.forget, rgb === null, "no color picked");
        }
        if (!running) {
            disarmPick(options.camera);
        }
    }

    return { root, render };
}
