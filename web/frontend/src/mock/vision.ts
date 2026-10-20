// The camera of the in-page mock: how it really sits on the head (what the
// camera offset routine is to find), where a board point lands in its
// picture, the pose pcbv would report of a board a little off the job's
// design, and the picture itself, drawn as an SVG so the page can show it
// without a backend. Picture coordinates are pixels from the picture's
// center, x right and y down; a board vector lands at its turn by the roll.

import { turned } from "../kinematics.ts";
import type { Board, CameraPose, CameraSettings, Job, Path } from "../types.ts";
import { CAMERA_FINISHES, CAMERA_SIDES, CAMERA_SIZE } from "./machines.ts";

/** How the camera really sits: the picture's center from the tool, its roll and its scale at the board. */
export interface CameraTruth {
    offset: [number, number];
    roll: number;
    mmPerPx: number;
}

export const CAMERA_TRUTH: CameraTruth = { offset: [3.5, -1.2], roll: 0.4, mmPerPx: 0.02 };

/** Where the mock's board really lies against a loaded job's design: a little off, so alignment has something to find. */
export const BOARD_MISPLACEMENT: Placement = { shift: [0.4, -0.3], rotation: 0.6 };

/** A board's placement: the map from the design's gerber frame to the machine's, machine = turn(rotation) * gerber + shift. */
export interface Placement {
    shift: [number, number];
    rotation: number;
}

/** What pcbv reports of a lock besides the pose: the picture rate and age. */
export const POSE_FPS = 14;
export const POSE_AGE_MS = 40;
export const POSE_RMS_MM = 0.04;
/** How far past the job's extent the picture's center may be and still see the board. */
const LOCK_MARGIN = 2;

/** The camera settings checked as the backend checks a PUT; throws with its words. */
export function checkCameraSettings(patch: Partial<CameraSettings>): void {
    for (const key of ["device", "pcbv"] as const) {
        if (patch[key] !== undefined && (typeof patch[key] !== "string" || patch[key].trim() === "")) {
            throw new Error(`${key} must be text`);
        }
    }
    if (patch.size !== undefined && (typeof patch.size !== "string" || !CAMERA_SIZE.test(patch.size))) {
        throw new Error("size must be WIDTHxHEIGHT");
    }
    if (patch.fps !== undefined && !(Number.isInteger(patch.fps) && patch.fps >= 1 && patch.fps <= 120)) {
        throw new Error("fps must be a whole number from 1 to 120");
    }
    if (patch.side !== undefined && !CAMERA_SIDES.includes(patch.side)) {
        throw new Error(`side must be one of ${CAMERA_SIDES.join(", ")}`);
    }
    if (patch.finish !== undefined && !CAMERA_FINISHES.includes(patch.finish)) {
        throw new Error(`finish must be one of ${CAMERA_FINISHES.join(", ")}`);
    }
    if (patch.offset !== undefined) {
        const offset = patch.offset;
        const ok = Array.isArray(offset) && offset.length === 2 && offset.every((v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1000);
        if (!ok) {
            throw new Error("offset must be two numbers within 1000 mm");
        }
    }
    if (patch.roll !== undefined && !(typeof patch.roll === "number" && Number.isFinite(patch.roll) && Math.abs(patch.roll) <= 360)) {
        throw new Error("roll must be a number within 360");
    }
    if (patch.mm_per_px !== undefined && !(typeof patch.mm_per_px === "number" && Number.isFinite(patch.mm_per_px) && patch.mm_per_px >= 0)) {
        throw new Error("mm_per_px must be 0 or more");
    }
}

/** The sensor's width and height from a WIDTHxHEIGHT size. */
export function parseSize(size: string): [number, number] {
    const [w, h] = size.split("x").map(Number);
    return [w ?? 1280, h ?? 720];
}

/**
 * A board point in picture pixels from the picture's center at `center`, y
 * down: the picture's x axis points `roll` degrees from board +X, so a board
 * vector is turned back by the roll to read it in the picture.
 */
export function picturePoint(point: Board, center: Board, roll: number, mmPerPx: number): { px: number; py: number } {
    const u = turned({ x: point.x - center.x, y: point.y - center.y }, -roll);
    return { px: u.x / mmPerPx, py: -u.y / mmPerPx };
}

/** The board vector a picture offset stands for: turned over (y down) and by the roll, then scaled. */
export function boardVector(dx: number, dy: number, roll: number, mmPerPx: number): Board {
    return turned({ x: dx * mmPerPx, y: -dy * mmPerPx }, roll);
}

/** Whether a picture point is within the sensor. */
export function inPicture(px: number, py: number, size: string): boolean {
    const [w, h] = parseSize(size);
    return Math.abs(px) <= w / 2 && Math.abs(py) <= h / 2;
}

/** A gerber (design) frame point placed on the machine, and back. */
export function placedPoint(gerber: Board, placement: Placement): Board {
    const t = turned(gerber, placement.rotation);
    return { x: t.x + placement.shift[0], y: t.y + placement.shift[1] };
}

export function designPoint(machine: Board, placement: Placement): Board {
    return turned({ x: machine.x - placement.shift[0], y: machine.y - placement.shift[1] }, -placement.rotation);
}

/** The job's own map from the gerber frame, the identity for a job without one. */
export function jobPlacement(job: Job): Placement {
    return job.design ? { shift: job.design.shift, rotation: job.design.rotation } : { shift: [0, 0], rotation: 0 };
}

/** The board extent of a job in its own frame: its outline, copper, paths and pads. */
export function jobBounds(job: Job): { x0: number; y0: number; x1: number; y1: number } | null {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const take = (x: number, y: number): void => {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
    };
    const paths: Path[] = [...job.outline, ...job.copper, ...job.groups.flatMap((group) => group.paths)];
    for (const path of paths) {
        for (const [x, y] of path) {
            take(x, y);
        }
    }
    for (const [x, y] of job.pads ?? []) {
        take(x, y);
    }
    return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
}

/**
 * The pose pcbv reports with the picture's center at `center`, the board
 * lying at `placement`: the center in the KiCad frame (the gerber's, with
 * Y down), the board's turn as seen in the picture, and the center in the
 * job's frame through the job's design; locked while the center is over
 * the board, lost otherwise.
 */
export function boardPose(center: Board, job: Job, placement: Placement, truth: CameraTruth, size: string): CameraPose {
    const gerber = designPoint(center, placement);
    const jobCenter = placedPoint(gerber, jobPlacement(job));
    const extent = jobBounds(job);
    const over = extent !== null
        && jobCenter.x >= extent.x0 - LOCK_MARGIN && jobCenter.x <= extent.x1 + LOCK_MARGIN
        && jobCenter.y >= extent.y0 - LOCK_MARGIN && jobCenter.y <= extent.y1 + LOCK_MARGIN;
    const pads = job.pads ?? [];
    const seen = pads.filter(([x, y]) => {
        const real = placedPoint(designPoint({ x, y }, jobPlacement(job)), placement);
        const p = picturePoint(real, center, truth.roll, truth.mmPerPx);
        return inPicture(p.px, p.py, size);
    }).length;
    if (!over) {
        return { state: "lost", spots: seen, expected: pads.length, fps: POSE_FPS, age_ms: POSE_AGE_MS };
    }
    const round = (value: number): number => Math.round(value * 10000) / 10000;
    return {
        state: "locked",
        center: [round(gerber.x), round(-gerber.y)],
        angle_deg: round(truth.roll - placement.rotation),
        mm_per_px: truth.mmPerPx,
        inliers: seen,
        expected: pads.length,
        rms_mm: POSE_RMS_MM,
        spots: seen,
        fps: POSE_FPS,
        age_ms: POSE_AGE_MS,
        job_center: [round(jobCenter.x), round(jobCenter.y)],
    };
}

export interface PictureScene {
    /** The picture's center on the board, and how the camera sits. */
    center: Board;
    truth: CameraTruth;
    size: string;
    /** The board's pads where they really lie, with their areas, and its outline. */
    pads: [number, number, number][];
    outline: Path[];
    /** The recorded mark's board point. */
    mark: Board | null;
    finish: "masked" | "bare";
    pose: CameraPose | null;
}

/**
 * The picture as an SVG data URL, `width` pixels wide at the sensor's
 * aspect: the board under the camera with its pads and outline, the mark
 * as a dark dot, a crosshair at the center always, and with `overlay` the
 * spots circled and the pose written in a corner.
 */
export function frameSvg(scene: PictureScene, width: number, overlay: boolean): string {
    const [w, h] = parseSize(scene.size);
    const height = Math.round((width * h) / w);
    const scale = width / w;
    const at = (point: Board): { x: number; y: number } => {
        const p = picturePoint(point, scene.center, scene.truth.roll, scene.truth.mmPerPx);
        return { x: width / 2 + p.px * scale, y: height / 2 + p.py * scale };
    };
    const n = (value: number): string => value.toFixed(1);
    const parts: string[] = [];
    parts.push(`<rect width="${width}" height="${height}" fill="${scene.finish === "masked" ? "#355e3b" : "#8a6d1f"}"/>`);
    for (const path of scene.outline) {
        const points = path.map((point) => {
            const p = at({ x: point[0], y: point[1] });
            return `${n(p.x)},${n(p.y)}`;
        });
        parts.push(`<polyline points="${points.join(" ")}" fill="none" stroke="#fdf6e3" stroke-width="1"/>`);
    }
    for (const [x, y, area] of scene.pads) {
        const side = (Math.sqrt(Math.max(area, 0.01)) / scene.truth.mmPerPx) * scale;
        const p = at({ x, y });
        parts.push(`<rect x="${n(p.x - side / 2)}" y="${n(p.y - side / 2)}" width="${n(side)}" height="${n(side)}" fill="#c9c2a8" transform="rotate(${n(-scene.truth.roll)} ${n(p.x)} ${n(p.y)})"/>`);
        if (overlay) {
            parts.push(`<circle cx="${n(p.x)}" cy="${n(p.y)}" r="${n(side * 0.8)}" fill="none" stroke="#2aa198" stroke-width="1"/>`);
        }
    }
    if (scene.mark) {
        const p = at(scene.mark);
        const r = (0.25 / scene.truth.mmPerPx) * scale;
        parts.push(`<circle cx="${n(p.x)}" cy="${n(p.y)}" r="${n(r)}" fill="#002b36"/>`);
    }
    parts.push(`<line x1="0" y1="${n(height / 2)}" x2="${width}" y2="${n(height / 2)}" stroke="#dc322f" stroke-width="1"/>`);
    parts.push(`<line x1="${n(width / 2)}" y1="0" x2="${n(width / 2)}" y2="${height}" stroke="#dc322f" stroke-width="1"/>`);
    if (overlay && scene.pose) {
        const pose = scene.pose;
        const words = pose.state === "locked"
            ? `locked ${pose.inliers}/${pose.expected} rms ${pose.rms_mm} mm angle ${pose.angle_deg} deg`
            : `${pose.state ?? "stopped"}`;
        parts.push(`<text x="6" y="16" font-family="monospace" font-size="12" fill="#fdf6e3">${words}</text>`);
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join("")}</svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
