// Points whose place on the machine is known, ringed on a camera's picture
// with a short label, so the operator can see whether what the page holds
// sits on what the camera shows: the head camera's alignment marks, the
// job's fiducials, the corners taken by hand, the mark its offset was
// measured from and the markers; the top camera's fiducials, the parts
// taken by hand, the corners, its mark and the fiducial Home by fiducial
// finds; the nozzle in the bottom camera's. A ring keeps one size on the
// screen at any zoom; only rings that show in the part of the picture
// shown are drawn, and a label only where it has room beside its ring,
// over no other ring or label, so a crowded view keeps its rings and
// drops words. Points come in order of weight: the first get the room.

import type { AppState } from "../state.ts";
import type { BoardCorners, BoardEstimate, BoardLook, Component } from "../types.ts";
import { type Calibration, type Mark, machineToPicturePoints, type PictureShown } from "./picture.ts";

/** A point whose place is known: where it is in the frame of the picture's center, mm, a short label, and words for its tooltip. */
export interface KnownPoint {
    at: [number, number];
    label: string;
    title: string;
}

/** A ring's radius on the screen, rem. */
export const RING_REM = 0.75;
/** A label's font size on the screen, rem. */
export const LABEL_REM = 0.75;
/** A letter's width in a label, of its font size: the monospace advance. */
const LETTER_EM = 0.62;

type Box = [number, number, number, number];

function overlaps(a: Box, b: Box): boolean {
    return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}

/**
 * The rings and labels of the points that show in the part of the picture
 * shown, the picture's center seeing `center`: a ring each, and a label
 * beside its ring on the right, else on the left, where that keeps inside
 * the view and off every other ring and the labels already placed.
 */
export function knownMarks(points: KnownPoint[], center: [number, number] | null, calibration: Calibration | null, shown: PictureShown): Mark[] {
    if (center === null || calibration === null || points.length === 0 || !(shown.scale > 0)) {
        return [];
    }
    const [x0, y0, width, height] = shown.region;
    const r = (RING_REM * shown.rem) / shown.scale;
    const font = (LABEL_REM * shown.rem) / shown.scale;
    const gap = font / 3;
    const places = machineToPicturePoints(points.map((point) => point.at), center, calibration, shown.size);
    const seen = points
        .map((point, index) => ({ point, x: places[index]![0], y: places[index]![1] }))
        .filter(({ x, y }) => Number.isFinite(x) && Number.isFinite(y) && x >= x0 - r && x <= x0 + width + r && y >= y0 - r && y <= y0 + height + r);
    const marks: Mark[] = seen.map(({ point, x, y }) => ({ kind: "circle", x, y, r, tone: "known", title: point.title }));
    const rings: Box[] = seen.map(({ x, y }) => [x - r, y - r, x + r, y + r]);
    const kept: Box[] = [];
    seen.forEach(({ point, x, y }, index) => {
        if (point.label === "") {
            return;
        }
        const long = point.label.length * LETTER_EM * font;
        const top = y - font * 0.6;
        const bottom = y + font * 0.6;
        const sides: { box: Box; anchor: "start" | "end"; x: number }[] = [
            { box: [x + r + gap, top, x + r + gap + long, bottom], anchor: "start", x: x + r + gap },
            { box: [x - r - gap - long, top, x - r - gap, bottom], anchor: "end", x: x - r - gap },
        ];
        for (const side of sides) {
            const [left, high, right, low] = side.box;
            const inside = left >= x0 && right <= x0 + width && high >= y0 && low <= y0 + height;
            if (!inside || kept.some((other) => overlaps(side.box, other)) || rings.some((other, at) => at !== index && overlaps(side.box, other))) {
                continue;
            }
            kept.push(side.box);
            // The baseline a third of the font under the ring's middle
            // puts the letters' middle on it.
            marks.push({ kind: "text", x: side.x, y: y + font / 3, text: point.label, size: font, anchor: side.anchor, tone: "known" });
            return;
        }
    });
    return marks;
}

/** A point of the job's frame where a board look's estimate puts it on the machine. */
export function placedBy(estimate: Pick<BoardEstimate, "rotation" | "shift">, point: [number, number]): [number, number] {
    const radians = (estimate.rotation * Math.PI) / 180;
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    return [point[0] * c - point[1] * s + estimate.shift[0], point[0] * s + point[1] * c + estimate.shift[1]];
}

/** The selected job's fiducials, as its board file lists them; none for another job's list or none read. */
function fiducialsOf(state: AppState, jobId: string): Component[] {
    const parts = state.components;
    return parts !== null && parts.job === jobId ? parts.components.filter((part) => part.fiducial === true) : [];
}

/** The estimate of a look that found this job's board; null otherwise. */
function foundEstimate(look: BoardLook | null | undefined, jobId: string): BoardEstimate | null {
    return look && look.found === true && look.job === jobId ? look.estimate ?? null : null;
}

/** The corners of this job's board taken by hand, as points. */
function cornerPoints(corners: BoardCorners | null | undefined, jobId: string): KnownPoint[] {
    if (!corners || corners.job !== jobId) {
        return [];
    }
    return corners.points.map((point) => ({
        at: point.machine,
        label: point.corner,
        title: `the board's ${point.corner} corner, taken ${point.by === "edges" ? "by its edges" : "by hand"}`,
    }));
}

/**
 * What the head camera's picture rings, in the board frame its center is
 * in: the selected job's alignment marks where they were found, its
 * fiducials where a look that found the board puts them (else where the
 * job lies, the place it is cut at), the corners taken of its board, the
 * mark Find mark centers on, and the markers.
 */
export function headKnown(state: AppState): KnownPoint[] {
    const job = state.job;
    const camera = state.camera;
    const points: KnownPoint[] = [];
    if (job) {
        const align = state.align;
        if (align && align.job === job.id) {
            align.marks.forEach((mark, index) => points.push({
                at: mark.machine,
                label: `A${index + 1}`,
                title: `align mark ${index + 1}, where the ${mark.source === "tool" ? "tool" : "camera"} found it`,
            }));
        }
        const estimate = foundEstimate(camera?.board_look, job.id);
        for (const part of fiducialsOf(state, job.id)) {
            points.push({
                at: estimate ? placedBy(estimate, [part.x, part.y]) : [part.x, part.y],
                label: part.ref,
                title: estimate ? `fiducial ${part.ref} where the looks put the board` : `fiducial ${part.ref} where the job lies`,
            });
        }
        points.push(...cornerPoints(camera?.board_look?.corners, job.id));
    }
    if (camera?.mark) {
        points.push({ at: camera.mark, label: "mark", title: "the mark Find mark centers the camera on" });
    }
    for (const marker of state.markers) {
        points.push({ at: [marker.x, marker.y], label: marker.name, title: `marker ${marker.name}` });
    }
    return points;
}

/**
 * What the top camera's picture rings, in the frame of the nozzle's place
 * its center is in: the selected job's fiducials where Find fiducials
 * found them, the others where a look that found the board puts them, the
 * parts taken with the nozzle or the camera, the corners taken of its
 * board, the mark the offset is measured from, and the fiducial Home by
 * fiducial finds.
 */
export function topKnown(state: AppState): KnownPoint[] {
    const placing = state.placing;
    const top = placing?.top;
    const job = state.job;
    const points: KnownPoint[] = [];
    if (job) {
        const found = top?.fiducials && top.fiducials.job === job.id ? top.fiducials.found : [];
        for (const fiducial of found) {
            points.push({ at: fiducial.at, label: fiducial.ref, title: `fiducial ${fiducial.ref} where Find fiducials found it` });
        }
        const estimate = foundEstimate(top?.board_look, job.id);
        if (estimate) {
            for (const part of fiducialsOf(state, job.id).filter((part) => !found.some((entry) => entry.ref === part.ref))) {
                points.push({ at: placedBy(estimate, [part.x, part.y]), label: part.ref, title: `fiducial ${part.ref} where the looks put the board` });
            }
        }
        // The parts taken by hand; those a fiducial, a look or the corners
        // gave are shown as those are.
        for (const reference of (placing?.references ?? []).filter((entry) => entry.job === job.id)) {
            if (reference.by === undefined || reference.by === "nozzle" || reference.by === "camera") {
                points.push({ at: reference.at, label: reference.ref, title: `${reference.ref} as taken with the ${reference.by === "camera" ? "top camera" : "nozzle"}` });
            }
        }
        points.push(...cornerPoints(top?.board_look?.corners, job.id));
    }
    if (top?.mark_at) {
        points.push({ at: top.mark_at, label: "mark", title: "the mark the top camera's offset is measured from" });
    }
    const home = placing?.document?.top?.home_fiducial;
    if (home) {
        points.push({ at: home, label: "home", title: "the fiducial Home by fiducial finds" });
    }
    return points;
}

/**
 * What the bottom camera's picture rings: the nozzle's tip where the
 * head's place puts it, the picture's center being the nozzle's place
 * over the camera as centering measured it. A G-code machine's X and Y,
 * or this project's rail and cross slide joints.
 */
export function bottomKnown(state: AppState, gcode: boolean): { center: [number, number] | null; points: KnownPoint[] } {
    let center: [number, number] | null;
    let head: [number, number] | null = null;
    if (gcode) {
        center = state.placing?.camera?.position ?? null;
        const position = state.placing?.position;
        if (position?.x !== undefined && position.y !== undefined) {
            head = [position.x, position.y];
        }
    } else {
        center = state.pnp?.position ?? null;
        const joint = state.snapshot.connected ? state.snapshot.machine?.joint : undefined;
        if (joint) {
            head = [joint.r, joint.z];
        }
    }
    const points: KnownPoint[] = head ? [{ at: head, label: "nozzle", title: "the nozzle's tip where the head's place puts it" }] : [];
    return { center, points };
}
