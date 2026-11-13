// The glyphs and colors a job's icon is drawn with: each glyph one path on
// a 16 by 16 grid, filled even-odd so the holes in it show through, and
// each color one of Solarized's accents by its stylesheet token. The
// backend keeps the same names (ICON_GLYPHS and ICON_COLORS in
// spinny_web/jobs.py) and refuses any other; a test holds the two lists
// together.

import type { JobIcon } from "./types.ts";

export const ICON_GLYPHS: Record<string, string> = {
    board: "M1 3h14v10H1zM2.5 4.5v7h11v-7zM4 6.5h2v3H4zM10 6.5h2v3h-2zM6 7.5h4v1H6z",
    chip: "M4 3h8v10H4zM5.2 4.2h1.6v1.6H5.2zM1.5 4.5h2v1.2h-2zM1.5 7.4h2v1.2h-2zM1.5 10.3h2v1.2h-2zM12.5 4.5h2v1.2h-2zM12.5 7.4h2v1.2h-2zM12.5 10.3h2v1.2h-2z",
    drill: "M6.5 1h3v5h-3zM5.5 6h5v6l-2.5 3l-2.5 -3zM6 8.2l4 -1.2v1.1l-4 1.2zM6 10.6l4 -1.2v1.1l-4 1.2z",
    laser: "M4 1h8v3l-2 2H6L4 4zM7.5 6h1v5h-1zM8 11l2 2.5L8 16l-2 -2.5z",
    mill: "M6 1h4v6H6zM5 7h6v6.5l-1 1.5l-1 -1.5l-1 1.5l-1 -1.5l-1 1.5l-1 -1.5zM7.4 8.3h1.2v4.5H7.4z",
    gear: "M13.12 6L15.19 6.72 15.19 9.28 13.12 10 13.04 10.2 13.99 12.17 12.17 13.99 10.2 13.04 10 13.12 9.28 15.19 6.72 15.19 6 13.12"
        + " 5.8 13.04 3.83 13.99 2.01 12.17 2.96 10.2 2.88 10 0.81 9.28 0.81 6.72 2.88 6 2.96 5.8 2.01 3.83 3.83 2.01 5.8 2.96 6 2.88"
        + " 6.72 0.81 9.28 0.81 10 2.88 10.2 2.96 12.17 2.01 13.99 3.83 13.04 5.8ZM5.7 8a2.3 2.3 0 1 0 4.6 0a2.3 2.3 0 1 0 -4.6 0Z",
    bolt: "M9.5 0.5L3 9h4.2l-1.2 6.5L13 7H8.6z",
    star: "M8 1.3L9.76 6.27 15.04 6.41 10.85 9.63 12.35 14.69 8 11.7 3.65 14.69 5.15 9.63 0.96 6.41 6.24 6.27Z",
    heart: "M8 14.5C6.5 13.3 1.5 10 1.5 6.2A3.4 3.4 0 0 1 8 4.6A3.4 3.4 0 0 1 14.5 6.2C14.5 10 9.5 13.3 8 14.5z",
    flag: "M3 1h1.5v14H3zM4.5 2h9l-2 3l2 3h-9z",
    check: "M1.8 8.6l1.9 -1.9l2.8 2.8l5.8 -5.8l1.9 1.9l-7.7 7.7z",
    dot: "M3 8a5 5 0 1 0 10 0a5 5 0 1 0 -10 0z",
};

export const ICON_COLORS = ["yellow", "orange", "red", "magenta", "violet", "blue", "cyan", "green"] as const;

/** The most letters an icon shows. */
export const ICON_LETTERS = 2;

/** Why an icon is refused, in the backend's words; null for one it keeps, and for none (the drawing). */
export function iconProblem(icon: JobIcon | null | undefined): string | null {
    if (!icon) {
        return null;
    }
    const glyph = icon.glyph ?? null;
    const letters = icon.letters ?? null;
    if ((glyph === null) === (letters === null)) {
        return "an icon is a glyph or letters, one of the two";
    }
    if (glyph !== null && !(glyph in ICON_GLYPHS)) {
        return `the icon's glyph must be one of ${Object.keys(ICON_GLYPHS).join(", ")}`;
    }
    if (letters !== null && !(letters.length >= 1 && [...letters].length <= ICON_LETTERS && /^[\p{L}\p{N}]+$/u.test(letters))) {
        return `the icon's letters must be 1 to ${ICON_LETTERS} letters or digits`;
    }
    if (!(ICON_COLORS as readonly string[]).includes(icon.color)) {
        return `the icon's color must be one of ${ICON_COLORS.join(", ")}`;
    }
    return null;
}
