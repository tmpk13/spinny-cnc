// The mock's twin of the camera log (spinny_web.camlog): photos taken by
// hand, kept with the same picture marked up. The mock's pictures are SVG
// drawings, so a logged picture is a data URL kept in memory rather than a
// file, and the marked one embeds it as the backend's embeds its JPEG. The
// routines' looks are logged by the real backend only.

import { escapeHtml as escape } from "../highlight.ts";
import type { CamLogEntry, SpotReply } from "../types.ts";

/** Most entries kept, as the backend keeps them. */
export const MAX_ENTRIES = 300;

const CENTER = "#2aa198";
const SEARCH = "#93a1a1";
const FOUND = "#d33682";
const MISSED = "#dc322f";

/**
 * The picture with what a look found drawn over it, as the backend draws
 * it: the center's crosshair, the circle searched (a third of the height),
 * and the spot found with the box of its axes and the line to it, or the
 * words when nothing was found. `picture` is an image source.
 */
export function overlaySvg(picture: string, width: number, height: number, spot: SpotReply | null, title: string): string {
    const cx = width / 2;
    const cy = height / 2;
    const arm = Math.max(8, height / 40);
    const stroke = Math.max(1.5, height / 400);
    const font = Math.max(12, height / 36);
    const parts = [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
        `<image href="${escape(picture)}" x="0" y="0" width="${width}" height="${height}"/>`,
        `<g fill="none" stroke-width="${stroke.toFixed(2)}">`,
        `<circle cx="${cx}" cy="${cy}" r="${(height / 3).toFixed(1)}" stroke="${SEARCH}" stroke-dasharray="${arm.toFixed(0)} ${(arm / 2).toFixed(0)}"/>`,
        `<line x1="${cx - arm}" y1="${cy}" x2="${cx + arm}" y2="${cy}" stroke="${CENTER}"/>`,
        `<line x1="${cx}" y1="${cy - arm}" x2="${cx}" y2="${cy + arm}" stroke="${CENTER}"/>`,
    ];
    const lines = [title];
    if (spot?.found) {
        const x = spot.x ?? cx + (spot.dx ?? 0);
        const y = spot.y ?? cy + (spot.dy ?? 0);
        const major = Math.max(4, spot.major ?? 0);
        const minor = Math.max(4, spot.minor ?? 0);
        parts.push(
            `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${SEARCH}"/>`,
            `<rect x="${(x - major / 2).toFixed(1)}" y="${(y - minor / 2).toFixed(1)}" width="${major.toFixed(1)}" height="${minor.toFixed(1)}" stroke="${FOUND}"/>`,
        );
        const sign = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(1)}`;
        lines.push(`found at dx ${sign(spot.dx ?? 0)} dy ${sign(spot.dy ?? 0)} px, ${major.toFixed(1)} x ${minor.toFixed(1)} px`);
    } else if (spot) {
        lines.push("nothing found inside the circle");
    }
    parts.push("</g>");
    const color = !spot || spot.found ? FOUND : MISSED;
    lines.forEach((text, index) => {
        parts.push(`<text x="${(font * 0.6).toFixed(1)}" y="${(font * 1.4 * (index + 1)).toFixed(1)}" font-family="sans-serif" font-size="${font.toFixed(1)}" fill="${index ? color : CENTER}">${escape(text)}</text>`);
    });
    parts.push("</svg>");
    return parts.join("\n");
}

/** An SVG text as an image source. */
export function svgUrl(svg: string): string {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** The log's entries and pictures, in memory. */
export class MockCameraLog {
    enabled = false;
    entries: CamLogEntry[] = [];
    files = new Map<string, string>();
    private serial = 0;

    /** Keeps a picture and its marked copy; the entry kept. */
    keep(entry: Omit<CamLogEntry, "id" | "time" | "files">, picture: string): CamLogEntry {
        const now = new Date();
        const pad = (n: number, width = 2): string => String(n).padStart(width, "0");
        const id = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(this.serial++ % 1000, 3)}`;
        const title = `${entry.camera} camera, ${entry.routine}: ${entry.step}${entry.note ? ` (${entry.note})` : ""}`;
        const files = { photo: `${id}.jpg`, overlay: `${id}.svg` };
        this.files.set(files.photo, picture);
        this.files.set(files.overlay, svgUrl(overlaySvg(picture, entry.width, entry.height, entry.spot, title)));
        const made: CamLogEntry = { ...entry, id, time: now.toISOString(), files };
        this.entries.push(made);
        while (this.entries.length > MAX_ENTRIES) {
            const old = this.entries.shift()!;
            for (const name of Object.values(old.files)) {
                this.files.delete(name);
            }
        }
        return made;
    }

    clear(): number {
        const count = this.entries.length;
        this.entries = [];
        this.files.clear();
        return count;
    }
}
