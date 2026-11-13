// The up camera of the in-page mock: where it really sits on the machine
// (what the nozzle routine is to find), how its picture lies against the
// machine (scaled, turned and, looking up, mirrored), the part a pick
// leaves on the nozzle, the picture itself drawn as an SVG, and the parts
// a board job stands for. Picture coordinates are pixels from the
// picture's center, x right and y down.

import { turnPoint } from "../align.ts";
import type { Component, Job, PnpSettings, SpotPolarity, TopSettings } from "../types.ts";
import { svgUrl } from "./camlog.ts";
import { round4 } from "./jobs.ts";
import { CAMERA_SIZE } from "./machines.ts";
import { checkLook, inPicture, parseSize } from "./vision.ts";

/** How the up camera really sits, and the part the mock's nozzle holds. */
export interface UpTruth {
    /** The rail and cross slide joints that put the nozzle over the picture's center. */
    where: [number, number];
    roll: number;
    mirror: boolean;
    mmPerPx: number;
    /** The held part's center from the nozzle's, mm in the machine's frame, and its size. */
    part: [number, number];
    partSize: [number, number];
}

export const UP_TRUTH: UpTruth = { where: [60, 20], roll: 2.5, mirror: true, mmPerPx: 0.01, part: [0.15, -0.08], partSize: [1.6, 0.8] };

/** Where the up camera really sits on the mock's G-code machine, its X and Y, when it is mounted there. */
export const DEVICE_CAMERA_WHERE: [number, number] = [150, 30];

/** How far the mock device's nozzle tip really runs off its turning axis at 0, mm. */
export const DEVICE_RUNOUT: [number, number] = [0.03, -0.012];

/** The mock device's top camera as it really is: its picture's center from the nozzle's tip, its scale and roll. */
export const TOP_TRUTH = { offset: [35, -10] as [number, number], mmPerPx: 0.02, roll: 1.5, mirror: false };

/** The top camera's settings before any are kept. */
export const TOP_DEFAULTS: TopSettings = {
    device: "/dev/video4",
    size: "1280x720",
    fps: 30,
    pcbv: "pcbv",
    mark_spot: "dark",
    mark_at: null,
    offset: null,
    mm_per_px: 0,
    roll: 0,
    mirror: false,
};

/** The top camera settings checked as the backend checks a PUT; throws with its words. */
export function checkTopSettings(settings: TopSettings): void {
    if (typeof settings.device !== "string" || settings.device.trim() === "") {
        throw new Error("the top camera device must be named");
    }
    if (!CAMERA_SIZE.test(settings.size)) {
        throw new Error("the top camera size must be WIDTHxHEIGHT");
    }
    if (!(Number.isInteger(settings.fps) && settings.fps >= 1 && settings.fps <= 120)) {
        throw new Error("the top camera fps must be 1 to 120");
    }
    if (!POLARITIES.includes(settings.mark_spot)) {
        throw new Error("the mark spot is dark or bright");
    }
    for (const [name, value] of [["mark place", settings.mark_at], ["offset", settings.offset]] as const) {
        if (value !== null && !value.every((v) => Number.isFinite(v) && Math.abs(v) <= 10000)) {
            throw new Error(`the top camera's ${name} must be two numbers within 10000 mm`);
        }
    }
    if (!(Number.isFinite(settings.mm_per_px) && settings.mm_per_px >= 0 && settings.mm_per_px <= 1)) {
        throw new Error("mm_per_px must be 0 to 1");
    }
    if (!(Number.isFinite(settings.roll) && Math.abs(settings.roll) <= 360)) {
        throw new Error("the top camera roll must be within 360 degrees");
    }
    checkLook(settings);
}

/** The top camera's picture as an SVG data URL, `width` pixels wide: a stretch of board with a fiducial at its middle and the crosshair. */
export function topFrameSvg(size: string, width: number, overlay: boolean): string {
    const [w, h] = parseSize(size);
    const height = Math.round((width * h) / w);
    const n = (value: number): string => value.toFixed(1);
    const dot = (0.5 / TOP_TRUTH.mmPerPx) * (width / w);
    const parts = [
        `<rect width="${width}" height="${height}" fill="#2f4f2f"/>`,
        `<circle cx="${n(width / 2 + dot * 3)}" cy="${n(height / 2 - dot * 2)}" r="${n(dot * 2)}" fill="#1f3a1f"/>`,
        `<circle cx="${n(width / 2 + dot * 3)}" cy="${n(height / 2 - dot * 2)}" r="${n(dot)}" fill="#d9b382"/>`,
        `<line x1="0" y1="${n(height / 2)}" x2="${width}" y2="${n(height / 2)}" stroke="#dc322f" stroke-width="1"/>`,
        `<line x1="${n(width / 2)}" y1="0" x2="${n(width / 2)}" y2="${height}" stroke="#dc322f" stroke-width="1"/>`,
    ];
    if (overlay) {
        parts.push(`<text x="6" y="16" font-family="monospace" font-size="12" fill="#fdf6e3">top</text>`);
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join("")}</svg>`;
    return svgUrl(svg);
}

export const PNP_DEFAULTS: PnpSettings = {
    device: "/dev/video1",
    size: "1280x720",
    fps: 30,
    pcbv: "pcbv",
    nozzle_spot: "dark",
    part_spot: "dark",
    position: null,
    height: null,
    mm_per_px: 0,
    roll: 0,
    mirror: true,
};

const POLARITIES: SpotPolarity[] = ["dark", "bright"];

/** The up camera settings checked as the backend checks a PUT; throws with its words. */
export function checkPnpSettings(settings: PnpSettings): void {
    if (typeof settings.device !== "string" || settings.device.trim() === "") {
        throw new Error("the bottom camera device must be named");
    }
    if (!CAMERA_SIZE.test(settings.size)) {
        throw new Error("the bottom camera size must be WIDTHxHEIGHT");
    }
    if (!(Number.isInteger(settings.fps) && settings.fps >= 1 && settings.fps <= 120)) {
        throw new Error("the bottom camera fps must be 1 to 120");
    }
    if (!POLARITIES.includes(settings.nozzle_spot) || !POLARITIES.includes(settings.part_spot)) {
        throw new Error("the nozzle and part spots are dark or bright");
    }
    if (settings.position !== null && !settings.position.every((value) => Number.isFinite(value) && Math.abs(value) <= 2000)) {
        throw new Error("the bottom camera position must be two numbers within 2000 mm");
    }
    if (settings.height !== null && !(Number.isFinite(settings.height) && Math.abs(settings.height) <= 100)) {
        throw new Error("the bottom camera height must be within 100 mm");
    }
    if (!(Number.isFinite(settings.mm_per_px) && settings.mm_per_px >= 0 && settings.mm_per_px <= 1)) {
        throw new Error("mm_per_px must be 0 to 1");
    }
    if (!(Number.isFinite(settings.roll) && Math.abs(settings.roll) <= 360)) {
        throw new Error("the bottom camera roll must be within 360 degrees");
    }
}

/** Where a point `mm` from the nozzle-over-center place (machine frame) shows in the picture, px from its center. */
export function upPicturePoint(mm: [number, number], truth: UpTruth): { px: number; py: number } {
    const [x, y] = turnPoint(mm, -truth.roll);
    const u = x / truth.mmPerPx;
    const v = y / truth.mmPerPx;
    return { px: truth.mirror ? -u : u, py: -v };
}

export interface UpScene {
    /** The nozzle's place from the camera's, mm in the machine's frame. */
    nozzle: [number, number];
    /** Whether a part hangs on the nozzle. */
    holding: boolean;
    size: string;
    truth: UpTruth;
}

/** The up camera's picture as an SVG data URL, `width` pixels wide: the nozzle seen from below, lit by a ring, and a part on it. */
export function upFrameSvg(scene: UpScene, width: number, overlay: boolean): string {
    const [w, h] = parseSize(scene.size);
    const height = Math.round((width * h) / w);
    const scale = width / w;
    const n = (value: number): string => value.toFixed(1);
    const at = (mm: [number, number]): { x: number; y: number } => {
        const p = upPicturePoint(mm, scene.truth);
        return { x: width / 2 + p.px * scale, y: height / 2 + p.py * scale };
    };
    const mm = (value: number): number => (value / scene.truth.mmPerPx) * scale;
    const parts: string[] = [`<rect width="${width}" height="${height}" fill="#073642"/>`];
    parts.push(`<circle cx="${n(width / 2)}" cy="${n(height / 2)}" r="${n(Math.min(width, height) * 0.45)}" fill="#0b4250"/>`);
    const nozzle = at(scene.nozzle);
    if (scene.holding) {
        const center = at([scene.nozzle[0] + scene.truth.part[0], scene.nozzle[1] + scene.truth.part[1]]);
        const [length, wide] = scene.truth.partSize;
        parts.push(
            `<rect x="${n(center.x - mm(length) / 2)}" y="${n(center.y - mm(wide) / 2)}" width="${n(mm(length))}" height="${n(mm(wide))}"`
            + ` fill="#eee8d5" transform="rotate(${n(-scene.truth.roll)} ${n(center.x)} ${n(center.y)})"/>`,
        );
    } else {
        parts.push(`<circle cx="${n(nozzle.x)}" cy="${n(nozzle.y)}" r="${n(mm(0.6))}" fill="#93a1a1"/>`);
        parts.push(`<circle cx="${n(nozzle.x)}" cy="${n(nozzle.y)}" r="${n(mm(0.22))}" fill="#002b36"/>`);
    }
    parts.push(`<line x1="0" y1="${n(height / 2)}" x2="${width}" y2="${n(height / 2)}" stroke="#dc322f" stroke-width="1"/>`);
    parts.push(`<line x1="${n(width / 2)}" y1="0" x2="${n(width / 2)}" y2="${height}" stroke="#dc322f" stroke-width="1"/>`);
    if (overlay) {
        parts.push(`<circle cx="${n(nozzle.x)}" cy="${n(nozzle.y)}" r="${n(mm(0.8))}" fill="none" stroke="#2aa198" stroke-width="1"/>`);
        parts.push(`<text x="6" y="16" font-family="monospace" font-size="12" fill="#fdf6e3">${scene.holding ? "part" : "nozzle"}</text>`);
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join("")}</svg>`;
    return svgUrl(svg);
}

/** Whether the nozzle (or its part) is in the picture at all, `mm` from the camera's center place. */
export function upInPicture(mm: [number, number], truth: UpTruth, size: string): boolean {
    const p = upPicturePoint(mm, truth);
    return inPicture(p.px, p.py, size);
}

/**
 * The parts a board job stands for: the mock reads no board file, so each
 * pad is a one-pad part where it lies, turned with the job, and two
 * fiducials sit 2 mm off the pads' corners.
 */
export function mockComponents(job: Job): Component[] {
    if (!job.design?.board) {
        return [];
    }
    const pads = job.pads ?? [];
    const rotation = ((job.rotation ?? 0) % 360 + 360) % 360;
    const parts: Component[] = pads.map(([x, y, area], index) => ({
        ref: `TP${index + 1}`,
        value: `${Math.round(area * 10) / 10} mm^2`,
        footprint: "TestPoint:TestPoint_Pad",
        side: "front",
        x: round4(x),
        y: round4(y),
        rotation,
        pads: 1,
        smd: true,
        dnp: false,
        fiducial: false,
        body: null,
        diameter: null,
    }));
    if (pads.length > 0) {
        const xs = pads.map(([x]) => x);
        const ys = pads.map(([, y]) => y);
        const corners: [number, number][] = [[Math.min(...xs) - 2, Math.min(...ys) - 2], [Math.max(...xs) + 2, Math.max(...ys) + 2]];
        corners.forEach(([x, y], index) => parts.push({
            ref: `FID${index + 1}`,
            value: "Fiducial",
            footprint: "Fiducial:Fiducial_1mm_Mask2mm",
            side: "front",
            x: round4(x),
            y: round4(y),
            rotation: 0,
            pads: 1,
            smd: true,
            dnp: false,
            fiducial: true,
            body: null,
            diameter: 1,
        }));
    }
    return parts;
}
