// A full scan's pictures laid side by side where the head took them: each
// picture turned by the camera's roll (and flipped when mirrored) and placed
// with its center on the machine point it was taken at, so the mosaic shows
// the board as the machine sees it, +X right and +Y up. The board's outline
// is drawn dashed where the scan found it.

import { el } from "../dom.ts";
import type { BoardEstimate, ScanMosaic, ScanTile } from "../types.ts";

const SVG = "http://www.w3.org/2000/svg";

/** An SVG transform's six numbers: (x, y) to (a x + c y + e, b x + d y + f). */
export type Matrix = [number, number, number, number, number, number];

/**
 * The matrix taking a picture's px (x right, y down) to the drawing's
 * units: machine mm with y turned over so it points down on screen. A px
 * `dx`, `dy` from the picture's center is `mm_per_px` times (dx, -dy),
 * x negated when mirrored, turned by the roll, from the center.
 */
export function tileMatrix(tile: ScanTile): Matrix {
    const s = tile.mm_per_px;
    const m = tile.mirror ? -1 : 1;
    const r = (tile.roll * Math.PI) / 180;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    const a = s * m * cos;
    const b = -s * m * sin;
    const c = s * sin;
    const d = s * cos;
    const e = tile.center[0] - (a * tile.width) / 2 - (c * tile.height) / 2;
    const f = -tile.center[1] - (b * tile.width) / 2 - (d * tile.height) / 2;
    return [a, b, c, d, e, f];
}

function apply(matrix: Matrix, x: number, y: number): [number, number] {
    const [a, b, c, d, e, f] = matrix;
    return [a * x + c * y + e, b * x + d * y + f];
}

/** A job point where a place puts it on the machine, in the drawing's units (y down). */
function placed(estimate: BoardEstimate, point: [number, number]): [number, number] {
    const r = (estimate.rotation * Math.PI) / 180;
    const x = point[0] * Math.cos(r) - point[1] * Math.sin(r) + estimate.shift[0];
    const y = point[0] * Math.sin(r) + point[1] * Math.cos(r) + estimate.shift[1];
    return [x, -y];
}

export interface MosaicView {
    root: HTMLElement;
    /** Draws a scan's pictures, each fetched from `urlOf(index)`; null or none hides the drawing. */
    render(mosaic: ScanMosaic | null, urlOf: (index: number) => string): void;
}

export function mountMosaic(): MosaicView {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("class", "mosaic");
    svg.setAttribute("role", "img");
    const root = el("div", { class: "mosaic-box hidden" });
    root.append(svg);
    let drawn = "";

    function render(mosaic: ScanMosaic | null, urlOf: (index: number) => string): void {
        const tiles = mosaic?.pictures ?? [];
        root.classList.toggle("hidden", tiles.length === 0);
        const key = mosaic ? `${mosaic.job}:${mosaic.version}:${tiles.length}` : "";
        if (key === drawn) {
            return;
        }
        drawn = key;
        if (!mosaic || tiles.length === 0) {
            svg.replaceChildren();
            return;
        }
        const xs: number[] = [];
        const ys: number[] = [];
        const nodes: SVGElement[] = [];
        for (const tile of tiles) {
            const matrix = tileMatrix(tile);
            for (const [x, y] of [[0, 0], [tile.width, 0], [tile.width, tile.height], [0, tile.height]] as const) {
                const [u, v] = apply(matrix, x, y);
                xs.push(u);
                ys.push(v);
            }
            const image = document.createElementNS(SVG, "image");
            image.setAttribute("href", urlOf(tile.index));
            image.setAttribute("width", String(tile.width));
            image.setAttribute("height", String(tile.height));
            image.setAttribute("preserveAspectRatio", "none");
            image.setAttribute("transform", `matrix(${matrix.map((value) => value.toFixed(6)).join(" ")})`);
            const title = document.createElementNS(SVG, "title");
            title.textContent = `picture ${tile.index + 1}: its center at ${tile.center[0].toFixed(2)}, ${tile.center[1].toFixed(2)} mm`;
            image.append(title);
            nodes.push(image);
        }
        if (mosaic.estimate && mosaic.outline) {
            const [x0, y0, x1, y1] = mosaic.outline;
            const corners = ([[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as [number, number][]).map((point) => placed(mosaic.estimate!, point));
            const outline = document.createElementNS(SVG, "polygon");
            outline.setAttribute("class", "mosaic-outline");
            outline.setAttribute("points", corners.map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`).join(" "));
            const title = document.createElementNS(SVG, "title");
            title.textContent = "the board's outline where the scan found it";
            outline.append(title);
            nodes.push(outline);
            for (const [x, y] of corners) {
                xs.push(x);
                ys.push(y);
            }
        }
        const left = Math.min(...xs);
        const top = Math.min(...ys);
        const width = Math.max(...xs) - left;
        const height = Math.max(...ys) - top;
        const pad = 0.02 * Math.max(width, height, 1);
        svg.setAttribute("viewBox", `${(left - pad).toFixed(3)} ${(top - pad).toFixed(3)} ${(width + 2 * pad).toFixed(3)} ${(height + 2 * pad).toFixed(3)}`);
        svg.setAttribute("aria-label", `${tiles.length} pictures of the board's scan${mosaic.estimate ? ", the board found" : ""}`);
        svg.replaceChildren(...nodes);
    }

    return { root, render };
}
