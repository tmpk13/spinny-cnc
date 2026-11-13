// The overlay: what is drawn over the scene on a 2D canvas of its own,
// every frame, since it moves while the scene stands (the head, its trail
// and the board a camera found) or is text, which a 2D canvas sets well:
// the grid's or the rings' labels, the markers' names, the sketch's sizes,
// the speed view's key, the notes line and the selection box being dragged.

import { type Frame, type Vec3, Projector, project } from "../camera.ts";
import { SPEED_COLORS, type SpeedMap } from "../speed.ts";
import type { Point } from "../types.ts";
import { type Context2D, tracePolyline } from "./canvas2d.ts";
import { type GridLayout, type RenderState, formatTick, headHeightOf, labelEvery, majorEvery, ringsIn } from "./scene.ts";

/** How far a dimension line stands off what it measures, and its arrowheads' length, px. */
const DIM_OFFSET_PX = 18;
const DIM_ARROW_PX = 7;

/** A canvas point of a world point; null behind the eye. */
type At = (x: number, y: number, z?: number) => { x: number; y: number } | null;

export interface OverlayInput {
    state: RenderState;
    frame: Frame;
    /** CSS px per mm at the target's depth. */
    scale: number;
    reach: number;
    layout: GridLayout;
    /** How far the probed heights are stretched; null without a mesh. */
    exaggeration: number | null;
    speeds: SpeedMap | null;
}

/** Strokes world points as one line, the pen up across a point behind the eye. */
function polyline(ctx: Context2D, view: Projector, points: Vec3[]): void {
    ctx.beginPath();
    if (tracePolyline(ctx, view, { points })) {
        ctx.stroke();
    }
}

/** Draws the overlay on a context already cleared and set to CSS px. */
export function drawOverlay(ctx: Context2D, input: OverlayInput): void {
    const { state, frame, scale, reach, layout } = input;
    const { width, height, colors } = state;
    const view = new Projector(frame, width, height);
    const at: At = (x, y, z = 0) => project(frame, width, height, [x, y, z]);
    const cartesian = state.limits.kinematics === "cartesian";
    const headHeight = headHeightOf(reach);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // The board where the camera's looks put it: dashed, so it reads apart
    // from the job's own outline under it.
    if (state.estimate.length > 0) {
        ctx.strokeStyle = colors.marker;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        for (const path of state.estimate) {
            polyline(ctx, view, path.map(([x, y]) => [x, y, 0] as Vec3));
        }
        ctx.setLineDash([]);
    }

    // Trail and head.
    if (state.trail.length > 1) {
        ctx.strokeStyle = colors.trail;
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.7;
        polyline(ctx, view, state.trail.map(([x, y]) => [x, y, 0] as Vec3));
        ctx.globalAlpha = 1;
    }
    if (state.head && state.headBoard) {
        const board = state.headBoard;
        ctx.strokeStyle = colors.head;
        ctx.fillStyle = colors.head;
        ctx.lineWidth = 1.5;
        // The radius line from the axis to the head, which on a cartesian
        // machine is no joint of it.
        if (!cartesian) {
            ctx.globalAlpha = 0.5;
            polyline(ctx, view, [[0, 0, 0], [board.x, board.y, 0]]);
            ctx.globalAlpha = 1;
        }
        // The beam from the head down to the board.
        ctx.globalAlpha = 0.6;
        polyline(ctx, view, [[board.x, board.y, 0], [board.x, board.y, headHeight]]);
        ctx.globalAlpha = 1;
        const spot = at(board.x, board.y, 0);
        if (spot) {
            ctx.beginPath();
            ctx.arc(spot.x, spot.y, 2.5, 0, Math.PI * 2);
            ctx.fill();
        }
        const marker = at(board.x, board.y, headHeight);
        if (marker) {
            ctx.beginPath();
            ctx.arc(marker.x, marker.y, 6, 0, Math.PI * 2);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(marker.x, marker.y, 2, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    // Labels in screen space on the heavier lines or rings, every one while
    // they are far enough apart to read, every second or fourth beyond: the
    // rings along the rail, or toward the middle of the view when the rail
    // is out of it; the grid's lines along both axes, or along the view's
    // lower and left edges when an axis is out of it.
    const { step, box } = layout;
    ctx.fillStyle = colors.text;
    ctx.font = state.font;
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    const label = (text: string, x: number, y: number): void => {
        const p = at(x, y, 0);
        if (p && p.x > 0 && p.x < width && p.y > 0 && p.y < height) {
            ctx.fillText(text, p.x + 3, p.y + 3);
        }
    };
    const major = step * majorEvery(step);
    const every = labelEvery(major, scale);
    // A grid line's label sits where it meets the axis across it; with that
    // point off the canvas, where the line meets the canvas's lower edge
    // (lines along Y) or its left edge (lines along X).
    const lineLabel = (text: string, from: Point, to: Point, axis: Point, edge: "bottom" | "left"): void => {
        const p = at(axis[0], axis[1], 0);
        if (p && p.x > 0 && p.x < width && p.y > 0 && p.y < height) {
            ctx.fillText(text, p.x + 3, p.y + 3);
            return;
        }
        const a = at(from[0], from[1], 0);
        const b = at(to[0], to[1], 0);
        if (!a || !b) {
            return;
        }
        const [along, across, place] = edge === "bottom" ? [a.y, b.y, height - 34] : [a.x, b.x, 6];
        if (Math.abs(across - along) < 1e-9) {
            return;
        }
        const t = (place - along) / (across - along);
        if (t < 0 || t > 1) {
            return;
        }
        const x = edge === "bottom" ? a.x + (b.x - a.x) * t : place;
        const y = edge === "bottom" ? place : a.y + (b.y - a.y) * t;
        if (x > 0 && x < width && y > 0 && y < height) {
            ctx.fillText(text, x + 3, y + 3);
        }
    };
    if (box) {
        if (state.grid) {
            for (let k = Math.ceil(box.x0 / major - 1e-9); k * major <= box.x1 + 1e-9; k++) {
                if (k !== 0 && k % every === 0) {
                    const v = k * major;
                    lineLabel(formatTick(v), [v, box.y0], [v, box.y1], [v, 0], "bottom");
                }
            }
            for (let k = Math.ceil(box.y0 / major - 1e-9); k * major <= box.y1 + 1e-9; k++) {
                if (k !== 0 && k % every === 0) {
                    const v = k * major;
                    lineLabel(formatTick(v), [box.x0, v], [box.x1, v], [0, v], "left");
                }
            }
        } else {
            const { rings, from, to } = ringsIn(step, box);
            const rail = to - from >= Math.PI * 2 - 1e-9 || (from <= 0 && 0 <= to) || (from <= Math.PI * 2 && Math.PI * 2 <= to);
            const angle = rail ? 0 : (from + to) / 2;
            for (const ring of rings) {
                const k = Math.round(ring.radius / major);
                if (ring.major && k % every === 0) {
                    label(`${formatTick(ring.radius)} mm`, ring.radius * Math.cos(angle), ring.radius * Math.sin(angle));
                }
            }
        }
    }
    drawMarkerLabels(ctx, state, at);
    drawDimensions(ctx, state, at);
    drawSpeedLegend(ctx, state, input.speeds);
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    const notes = [`elev ${Math.round(state.camera.pitch)} deg`];
    notes.unshift(`${state.grid ? "grid" : "rings"} ${formatTick(step)} mm`);
    if (state.locked) {
        notes.unshift("rotation locked");
    }
    const exaggeration = input.exaggeration;
    if (exaggeration !== null) {
        notes.unshift(`heights x${exaggeration >= 10 ? Math.round(exaggeration) : exaggeration.toFixed(1)}`);
    }
    if (state.boxSelect) {
        notes.unshift("box select");
    }
    ctx.fillText(notes.join("   "), width - 6, height - 4);
    // The selection box being dragged.
    const band = state.band;
    if (band) {
        ctx.save();
        ctx.strokeStyle = colors.select;
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 3]);
        ctx.strokeRect(Math.min(band.x0, band.x1), Math.min(band.y0, band.y1), Math.abs(band.x1 - band.x0), Math.abs(band.y1 - band.y0));
        ctx.restore();
    }
}

/** The markers' names beside them, in screen space so they stay upright. */
function drawMarkerLabels(ctx: Context2D, state: RenderState, at: At): void {
    if (state.markers.length === 0) {
        return;
    }
    ctx.save();
    ctx.fillStyle = state.colors.marker;
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    for (const marker of state.markers) {
        const p = at(marker.x, marker.y, 0);
        if (p && p.x > 0 && p.x < state.width && p.y > 0 && p.y < state.height) {
            ctx.fillText(marker.name, p.x + 7, p.y - 5);
        }
    }
    ctx.restore();
}

/** The speed view's key, top left: the colors from slowest to fastest with their speeds, and how much of the cut a rate holds back. */
function drawSpeedLegend(ctx: Context2D, state: RenderState, map: SpeedMap | null): void {
    if (!state.speed || state.job === null) {
        return;
    }
    const colors = state.colors;
    ctx.save();
    ctx.font = state.font;
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    const x = 8;
    const y = 8;
    const lines: string[] = [];
    if (map === null || map.segments.length === 0) {
        lines.push(map === null ? "speed: no machine rates" : "speed: no cuts to show");
    } else {
        lines.push(`speed ${Math.round(map.slowest)} to ${Math.round(map.fastest)} mm/min`);
        const share = map.length > 0 ? map.cappedLength / map.length : 0;
        lines.push(share > 0 ? `capped (red) on ${(share * 100).toFixed(share < 0.1 ? 1 : 0)}% of the cut` : "nothing capped");
        if (state.speedLimits?.assumed) {
            lines.push("default rates: connect for the machine's");
        }
    }
    const boxWidth = Math.max(...lines.map((line) => ctx.measureText(line).width), SPEED_COLORS.length * 22) + 12;
    const barHeight = map !== null && map.segments.length > 0 ? 10 : 0;
    ctx.fillStyle = colors.bg;
    ctx.globalAlpha = 0.88;
    ctx.fillRect(x - 4, y - 4, boxWidth, lines.length * 16 + barHeight + 10);
    ctx.globalAlpha = 1;
    if (barHeight > 0) {
        SPEED_COLORS.forEach((color, index) => {
            ctx.fillStyle = color;
            ctx.fillRect(x + index * 22, y, 22, barHeight);
        });
    }
    ctx.fillStyle = colors.text;
    lines.forEach((line, index) => ctx.fillText(line, x, y + barHeight + 4 + index * 16));
    ctx.restore();
}

/** The sketch dimensions over everything, in screen space, each text on a patch of the background so it reads over the paths. */
function drawDimensions(ctx: Context2D, state: RenderState, at: At): void {
    if (state.dims.length === 0) {
        return;
    }
    const colors = state.colors;
    type Px = { x: number; y: number };
    const arrow = (tip: Px, from: Px): void => {
        const length = Math.hypot(tip.x - from.x, tip.y - from.y);
        if (length < 1e-6) {
            return;
        }
        const ux = (tip.x - from.x) / length;
        const uy = (tip.y - from.y) / length;
        const back = { x: tip.x - ux * DIM_ARROW_PX, y: tip.y - uy * DIM_ARROW_PX };
        ctx.beginPath();
        ctx.moveTo(tip.x, tip.y);
        ctx.lineTo(back.x - uy * DIM_ARROW_PX * 0.35, back.y + ux * DIM_ARROW_PX * 0.35);
        ctx.lineTo(back.x + uy * DIM_ARROW_PX * 0.35, back.y - ux * DIM_ARROW_PX * 0.35);
        ctx.closePath();
        ctx.fill();
    };
    const segment = (a: Px, b: Px): void => {
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
    };
    const text = (label: string, x: number, y: number): void => {
        const w = ctx.measureText(label).width;
        ctx.save();
        ctx.fillStyle = colors.bg;
        ctx.globalAlpha = 0.85;
        ctx.fillRect(x - w / 2 - 3, y - 8, w + 6, 16);
        ctx.restore();
        ctx.fillText(label, x, y);
    };
    ctx.save();
    ctx.strokeStyle = colors.dim;
    ctx.fillStyle = colors.dim;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.font = state.font;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const dim of state.dims) {
        if (dim.kind === "point") {
            const p = at(dim.at[0], dim.at[1], 0);
            if (!p) {
                continue;
            }
            segment({ x: p.x - 5, y: p.y }, { x: p.x + 5, y: p.y });
            segment({ x: p.x, y: p.y - 5 }, { x: p.x, y: p.y + 5 });
            ctx.textAlign = "left";
            const w = ctx.measureText(dim.text).width;
            ctx.textAlign = "center";
            text(dim.text, p.x + 9 + w / 2, p.y - 10);
        } else if (dim.kind === "radius") {
            const c = at(dim.center[0], dim.center[1], 0);
            const rad = (dim.angle * Math.PI) / 180;
            const p = at(dim.center[0] + dim.radius * Math.cos(rad), dim.center[1] + dim.radius * Math.sin(rad), 0);
            if (!c || !p) {
                continue;
            }
            segment(c, p);
            arrow(p, c);
            const length = Math.hypot(p.x - c.x, p.y - c.y) || 1;
            text(dim.text, p.x + ((p.x - c.x) / length) * 16, p.y + ((p.y - c.y) / length) * 16);
        } else {
            const [x0, y0] = dim.from;
            const [x1, y1] = dim.to;
            const length = Math.hypot(x1 - x0, y1 - y0);
            const a = at(x0, y0, 0);
            const b = at(x1, y1, 0);
            if (!a || !b || length < 1e-9 || Math.hypot(b.x - a.x, b.y - a.y) < 4) {
                continue;
            }
            // The side the line stands off to, taken to the screen through
            // a point a little way out on the board.
            let ox = 0;
            let oy = 0;
            if (dim.side !== 0) {
                const nx = (-(y1 - y0) / length) * dim.side;
                const ny = ((x1 - x0) / length) * dim.side;
                const out = at(x0 + nx * length * 0.05, y0 + ny * length * 0.05, 0);
                if (out) {
                    const d = Math.hypot(out.x - a.x, out.y - a.y);
                    if (d > 1e-6) {
                        ox = (out.x - a.x) / d;
                        oy = (out.y - a.y) / d;
                    }
                }
            }
            const off = dim.side === 0 ? 0 : DIM_OFFSET_PX;
            const da = { x: a.x + ox * off, y: a.y + oy * off };
            const db = { x: b.x + ox * off, y: b.y + oy * off };
            if (off > 0) {
                ctx.globalAlpha = 0.6;
                segment({ x: a.x + ox * 3, y: a.y + oy * 3 }, { x: da.x + ox * 4, y: da.y + oy * 4 });
                segment({ x: b.x + ox * 3, y: b.y + oy * 3 }, { x: db.x + ox * 4, y: db.y + oy * 4 });
                ctx.globalAlpha = 1;
            }
            segment(da, db);
            arrow(da, db);
            arrow(db, da);
            text(dim.text, (da.x + db.x) / 2 + ox * 9, (da.y + db.y) / 2 + oy * 9);
        }
    }
    ctx.restore();
}
