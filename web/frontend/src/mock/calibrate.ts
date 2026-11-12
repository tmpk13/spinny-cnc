// The mock's twin of the calibration tests (spinny_laser.calibrate and
// spinny_web.calibration): a laser's material test, a grid of squares at a
// power and a speed each, its focus ladder, a row of lines a step over
// focus each, a mill's depth test, a row of slots a step deeper each,
// every patch a group of its own, and the camera pattern for either, a
// grid of dots a known pitch apart with its top right dot left out, and
// the sheet to print it on.

import type { CalibrateRequest, CalibrateResponse, Group, Path, Point } from "../types.ts";
import { DEFAULT_DEPTH, DEFAULT_PLUNGE, checkDepth, checkFocus, checkPower, checkSpeed, computeStats, formatG, type RateLimits } from "./jobs.ts";

/** The most patches along a side, and the largest patch or slot, mm. */
export const MAX_STEPS = 12;
export const MAX_SIZE = 100;
/** The finest a material test's fill may be, mm, and the most points it may make in all, as the backend bounds them. */
export const MIN_PITCH = 0.01;
export const MAX_POINTS = 200000;
/** The camera pattern's bounds: dots a side, the pitch, mm, and the widest it may be, mm; how far a dot's outline may stray from a circle, mm; the printed sheet's margin and the width its words take, mm. */
export const MAX_DOTS = 100;
export const MIN_DOT_PITCH = 0.2;
export const MAX_DOT_PITCH = 20;
export const MAX_SPAN = 200;
export const DOT_TOLERANCE = 0.005;
export const SHEET_MARGIN = 5;
export const SHEET_TEXT = 70;
/** A focus step as a label says it: +0.25 above focus, -0.5 below, 0 at it. */
export function focusLabel(focus: number): string {
    return focus === 0 ? "0" : `${focus > 0 ? "+" : ""}${formatG(focus)}`;
}



/** `count` values from `first` to `last`, both ends included, evenly apart. */
export function ladder(first: number, last: number, count: number): number[] {
    if (!(Number.isInteger(count) && count >= 1 && count <= MAX_STEPS)) {
        throw new Error(`a ladder has 1 to ${MAX_STEPS} steps`);
    }
    if (!Number.isFinite(first) || !Number.isFinite(last)) {
        throw new Error("a ladder's ends must be numbers");
    }
    if (count === 1) {
        return [first];
    }
    return Array.from({ length: count }, (_, i) => Math.round((first + ((last - first) * i) / (count - 1)) * 1e6) / 1e6);
}

function square(x: number, y: number, size: number): Path {
    return [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]];
}

/** How many lines a fill a pitch apart puts across a square. */
function rows(size: number, pitch: number): number {
    return Math.max(1, Math.floor(size / pitch + 1e-9) + 1);
}

/** One path back and forth across the square, a pitch apart. */
function hatch(x: number, y: number, size: number, pitch: number): Path {
    const lines = rows(size, pitch);
    const step = lines > 1 ? size / (lines - 1) : 0;
    const points: Point[] = [];
    for (let i = 0; i < lines; i += 1) {
        const row = y + i * step;
        const ends: Point[] = [[x, row], [x + size, row]];
        points.push(...(i % 2 === 0 ? ends : ends.reverse()));
    }
    return points;
}

/** The camera pattern's dots from the lower left, row by row, every other row backwards; the top right one left out. */
export function dotCenters(columns: number, rows: number, pitch: number, origin: Point = [0, 0]): Point[] {
    if (!(Number.isInteger(columns) && Number.isInteger(rows) && columns >= 2 && rows >= 2 && columns <= MAX_DOTS && rows <= MAX_DOTS)) {
        throw new Error(`the pattern has 2 to ${MAX_DOTS} dots a side`);
    }
    if (!(pitch >= MIN_DOT_PITCH && pitch <= MAX_DOT_PITCH)) {
        throw new Error(`the dots' pitch must be ${formatG(MIN_DOT_PITCH)} to ${formatG(MAX_DOT_PITCH)} mm`);
    }
    if (Math.max(columns, rows) - 1 > MAX_SPAN / pitch + 1e-9) {
        throw new Error(`the pattern must be at most ${formatG(MAX_SPAN)} mm across`);
    }
    const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;
    const centers: Point[] = [];
    for (let row = 0; row < rows; row += 1) {
        for (let i = 0; i < columns; i += 1) {
            const column = row % 2 === 0 ? i : columns - 1 - i;
            if (row !== rows - 1 || column !== columns - 1) {
                centers.push([round6(origin[0] + column * pitch), round6(origin[1] + row * pitch)]);
            }
        }
    }
    return centers;
}

function circleSides(radius: number): number {
    if (radius <= DOT_TOLERANCE) {
        return 8;
    }
    return Math.max(8, Math.ceil(Math.PI / Math.acos(1 - DOT_TOLERANCE / radius)));
}

/** A laser's dot as one path: its outline half a spot inside the edge, then a spiral a spot apart in to the middle. */
export function filledDot(center: Point, diameter: number, spot: number): Path {
    const radius = diameter / 2 - spot / 2;
    const sides = circleSides(radius);
    const [cx, cy] = center;
    const points: Point[] = [];
    for (let i = 0; i <= sides; i += 1) {
        points.push([cx + radius * Math.cos((2 * Math.PI * i) / sides), cy + radius * Math.sin((2 * Math.PI * i) / sides)]);
    }
    const turns = radius / spot;
    const steps = Math.max(1, Math.ceil(turns * sides));
    for (let i = 1; i <= steps; i += 1) {
        const part = i / steps;
        const angle = 2 * Math.PI * turns * part;
        points.push([cx + radius * (1 - part) * Math.cos(angle), cy + radius * (1 - part) * Math.sin(angle)]);
    }
    const round4 = (value: number): number => Math.round(value * 1e4) / 1e4;
    return points.map(([x, y]) => [round4(x), round4(y)]);
}

/** A length for the printed sheet: four decimals at most, no trailing zeros. */
function sheetMm(value: number): string {
    const text = value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
    return text === "" || text === "-0" ? "0" : text;
}

/** The camera pattern as a sheet to print at 100%: black dots on white, a 10 mm bar, and what it is in words. */
export function dotsSvg(columns: number, rows: number, pitch: number, diameter: number): string {
    const centers = dotCenters(columns, rows, pitch);
    const spanX = (columns - 1) * pitch;
    const spanY = (rows - 1) * pitch;
    const width = Math.max(spanX, SHEET_TEXT) + 2 * SHEET_MARGIN;
    const barY = spanY + 2 * SHEET_MARGIN;
    const height = barY + 10;
    const words = [
        `${columns} x ${rows} dots ${sheetMm(pitch)} mm apart, ${sheetMm(diameter)} mm across`,
        "the top right one left out; the bar is 10 mm: print at 100%",
    ];
    const lines = [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${sheetMm(width)}mm" height="${sheetMm(height)}mm" viewBox="0 0 ${sheetMm(width)} ${sheetMm(height)}">`,
        `<rect width="${sheetMm(width)}" height="${sheetMm(height)}" fill="#ffffff"/>`,
        '<g fill="#000000">',
        ...centers.map(([x, y]) => `<circle cx="${sheetMm(SHEET_MARGIN + x)}" cy="${sheetMm(SHEET_MARGIN + spanY - y)}" r="${sheetMm(diameter / 2)}"/>`),
        "</g>",
        `<path d="M ${sheetMm(SHEET_MARGIN)} ${sheetMm(barY)} h 10" stroke="#000000" stroke-width="0.3" fill="none"/>`,
        ...words.map((line, i) => `<text x="${sheetMm(SHEET_MARGIN)}" y="${sheetMm(barY + 3.5 + 2.8 * i)}" font-family="sans-serif" font-size="2" fill="#000000">${line}</text>`),
        "</svg>",
    ];
    return `${lines.join("\n")}\n`;
}

/**
 * The test for the machine, as the backend builds it: the material test or
 * the focus ladder on a laser, the depth test on a mill. `focusAxis` says
 * whether the laser has one: the ladder moves it.
 */
export function calibrateJob(id: string, request: CalibrateRequest, milling: boolean, limits: RateLimits, focusAxis = true): CalibrateResponse {
    const kind = request.kind ?? "material";
    const x = request.x ?? 0;
    const y = request.y ?? 0;
    const spot = request.spot ?? 0.1;
    const plunge = request.plunge ?? 30;
    let groups: Group[];
    let summary: string[];
    let notes: string[];
    let name: string;
    let svg: string | null = null;
    const group = (label: string, power: number, speed: number, paths: Path[], depth: number | null): Group => ({
        label, power, min_power: 0, speed, passes: 1, enabled: true, paths,
        depth: depth ?? DEFAULT_DEPTH, plunge: depth === null ? DEFAULT_PLUNGE : plunge,
    });
    if (kind === "material") {
        if (milling) {
            throw new Error("the material test is a laser's: a mill takes the depth test");
        }
        const [p0, p1, pn] = request.powers ?? [100, 1000, 5];
        const [s0, s1, sn] = request.speeds ?? [300, 1500, 5];
        const powers = ladder(p0, p1, pn);
        const speeds = ladder(s0, s1, sn);
        powers.forEach((power) => checkPower(power));
        speeds.forEach((speed) => checkSpeed(speed));
        const size = request.size ?? 5;
        const gap = request.gap ?? 2;
        const fill = request.fill ?? true;
        if (!(size > 0 && size <= MAX_SIZE)) {
            throw new Error(`size must be above 0 and at most ${MAX_SIZE} mm`);
        }
        if (!(gap >= 0 && gap <= MAX_SIZE)) {
            throw new Error(`gap must be 0 to ${MAX_SIZE} mm`);
        }
        if (fill && !(spot >= MIN_PITCH && spot <= size)) {
            throw new Error(`the fill's pitch must be at least ${formatG(MIN_PITCH)} mm and at most the size`);
        }
        if (fill) {
            const squares = powers.length * speeds.length;
            const points = squares * 2 * rows(size, spot);
            if (points > MAX_POINTS) {
                throw new Error(
                    `a fill ${formatG(spot)} mm apart over ${squares} squares of ${formatG(size)} mm is ${points} points, more than ${MAX_POINTS}:`
                    + " give a wider pitch, or smaller or fewer squares",
                );
            }
        }
        groups = speeds.flatMap((speed, row) => powers.map((power, column) => {
            const cx = x + column * (size + gap);
            const cy = y + row * (size + gap);
            return group(`test S${formatG(power)} F${formatG(speed)}`, power, speed, [fill ? hatch(cx, cy, size, spot) : square(cx, cy, size)], null);
        }));
        const what = fill ? `filled ${formatG(spot)} mm apart` : "outlined";
        summary = [
            `material test: ${powers.length} powers S${formatG(powers[0]!)} to S${formatG(powers.at(-1)!)} left to right,`
            + ` ${speeds.length} speeds ${formatG(speeds[0]!)} to ${formatG(speeds.at(-1)!)} mm/min bottom to top`,
            `${formatG(size)} mm squares ${formatG(gap)} mm apart, ${what}, lower left at X${formatG(x)} Y${formatG(y)}`,
        ];
        notes = [
            "Each square is a group named for its power and speed: the one that marks as you want (or, outlined, the first cut through) names the settings for this material.",
            "With no focus axis this is also the focus and power test: one speed and a ladder of powers shows where the beam starts to mark.",
        ];
        name = "material test";
    } else if (kind === "focus") {
        if (milling) {
            throw new Error("the focus ladder is a laser's: a mill takes the depth test");
        }
        if (!focusAxis) {
            throw new Error("the focus ladder moves the focus axis, and this machine has none ($h_axis=0): the material test's power ladder is the focus test without one");
        }
        const [f0, f1, fn] = request.focuses ?? [-1, 1, 9];
        const focuses = ladder(f0, f1, fn).sort((a, b) => a - b);
        focuses.forEach((focus) => checkFocus(focus, "a focus step"));
        const power = request.power ?? 500;
        const speed = request.speed ?? 600;
        checkPower(power);
        checkSpeed(speed);
        const length = request.length ?? 10;
        const gap = request.gap ?? 2;
        if (!(length > 0 && length <= MAX_SIZE)) {
            throw new Error(`length must be above 0 and at most ${MAX_SIZE} mm`);
        }
        if (!(gap > 0 && gap <= MAX_SIZE)) {
            throw new Error(`gap must be above 0 and at most ${MAX_SIZE} mm`);
        }
        groups = focuses.map((focus, i) => ({
            ...group(`test focus ${focusLabel(focus)} mm`, power, speed, [[[x, y + i * gap], [x + length, y + i * gap]]], null),
            focus,
        }));
        summary = [
            `focus ladder: ${focuses.length} lines ${focusLabel(focuses[0]!)} to ${focusLabel(focuses.at(-1)!)} mm over focus,`
            + ` lowest at Y${formatG(y)}, ${formatG(length)} mm long, ${formatG(gap)} mm apart`,
            `power S${formatG(power)}, speed ${formatG(speed)} mm/min`,
        ];
        notes = [
            "Bring the head to focus as near as you can first: each line is burnt that many mm above it (minus below), from the height the run starts at, or from the height map's focus height when the run follows the map, and the head goes back after.",
            "The thinnest, sharpest line is at focus; set the focus there (Focus here in the Height map panel, or jog H by the line's number) and run the ladder again with smaller steps to close in.",
        ];
        name = "focus ladder";
    } else if (kind === "dots") {
        const columns = request.columns ?? 21;
        const rowCount = request.rows ?? 15;
        const pitch = request.pitch ?? 2;
        const diameter = request.diameter ?? 0.6;
        const span = `${formatG((columns - 1) * pitch)} by ${formatG((rowCount - 1) * pitch)} mm`;
        let how: string;
        let mark: string;
        if (milling) {
            const depth = request.depth ?? 0.1;
            const feed = request.feed ?? 120;
            const spindle = request.spindle ?? 1000;
            checkDepth(depth);
            checkSpeed(feed, "feed");
            checkSpeed(plunge, "plunge");
            checkPower(spindle, "spindle");
            if (!(spindle > 0)) {
                throw new Error("a spindle needs a speed above 0");
            }
            if (!(depth > 0)) {
                throw new Error("the dots' depth must be above 0");
            }
            const centers = dotCenters(columns, rowCount, pitch, [x, y]);
            groups = [group("camera dots", spindle, feed, centers.map((center) => [center]), depth)];
            how = `one plunge each ${formatG(depth)} mm deep, the tool's width across; plunge ${formatG(plunge)} mm/min, spindle S${formatG(spindle)}`;
            mark = "Engrave it where the camera will look, on copper or aluminum, with a small bit: each dot is as wide as the tool.";
        } else {
            const power = request.power ?? 500;
            const speed = request.speed ?? 600;
            checkPower(power);
            checkSpeed(speed);
            if (!(spot < diameter && diameter < pitch)) {
                throw new Error("a dot must be wider than the spot and narrower than the pitch");
            }
            if (!(spot >= MIN_PITCH)) {
                throw new Error(`the spot must be at least ${formatG(MIN_PITCH)} mm`);
            }
            const centers = dotCenters(columns, rowCount, pitch, [x, y]);
            const radius = diameter / 2 - spot / 2;
            const sides = circleSides(radius);
            const points = centers.length * (sides + 1 + Math.max(1, Math.ceil((radius / spot) * sides)));
            if (points > MAX_POINTS) {
                throw new Error(`${centers.length} dots of ${formatG(diameter)} mm filled ${formatG(spot)} mm apart are ${points} points, more than ${MAX_POINTS}: give fewer or smaller dots`);
            }
            groups = [group("camera dots", power, speed, centers.map((center) => filledDot(center, diameter, spot)), null)];
            how = `${formatG(diameter)} mm dots filled ${formatG(spot)} mm apart, power S${formatG(power)}, speed ${formatG(speed)} mm/min`;
            mark = "Mark it where the camera will look: on anodized aluminum an IR or diode laser at low power leaves a light dot on the dark"
                + " surface; run the material test there first for the power.";
        }
        summary = [
            `camera pattern: ${columns} x ${rowCount} dots ${formatG(pitch)} mm apart (${span}),`
            + ` lower left at X${formatG(x)} Y${formatG(y)}, the top right one left out`,
            how,
        ];
        notes = [
            mark,
            "Or save the SVG and print it at 100%: the 10 mm bar under the dots checks the print's scale.",
            "The missing top right dot tells which way the pattern lies in a picture. Measuring the lens's distortion from it is not"
            + " built yet; docs/CALIBRATION.md says what it takes.",
        ];
        name = "camera pattern";
        svg = dotsSvg(columns, rowCount, pitch, diameter);
    } else {
        if (!milling) {
            throw new Error("the depth test is a mill's ($spindle=1): a laser takes the material test");
        }
        const [d0, d1, dn] = request.depths ?? [0.05, 0.3, 6];
        // Shallowest first, as the row is laid out and the summary says.
        const depths = ladder(d0, d1, dn).sort((a, b) => a - b);
        depths.forEach((depth) => checkDepth(depth));
        const feed = request.feed ?? 120;
        const spindle = request.spindle ?? 1000;
        const length = request.length ?? 10;
        const gap = request.gap ?? 2;
        checkSpeed(feed, "feed");
        checkSpeed(plunge, "plunge");
        checkPower(spindle, "spindle");
        if (!(spindle > 0)) {
            throw new Error("a spindle needs a speed above 0");
        }
        if (!(length > 0 && length <= MAX_SIZE)) {
            throw new Error(`length must be above 0 and at most ${MAX_SIZE} mm`);
        }
        if (!(gap > 0 && gap <= MAX_SIZE)) {
            throw new Error(`gap must be above 0 and at most ${MAX_SIZE} mm`);
        }
        groups = depths.map((depth, i) => group(`test depth ${formatG(depth)} mm`, spindle, feed, [[[x, y + i * gap], [x + length, y + i * gap]]], depth));
        summary = [
            `depth test: ${depths.length} slots ${formatG(depths[0]!)} to ${formatG(depths.at(-1)!)} mm deep, ${formatG(length)} mm long,`
            + ` ${formatG(gap)} mm apart, shallowest at Y${formatG(y)}`,
            `feed ${formatG(feed)} mm/min, plunge ${formatG(plunge)} mm/min, spindle S${formatG(spindle)}`,
        ];
        notes = [
            "Touch the tool off on the copper first: each slot goes down from Z 0, or from the height map with it on.",
            "The shallowest slot that parts the copper is the isolation depth; a slot measured against its number shows how far the depth axis really moves.",
        ];
        name = "depth test";
    }
    const job = {
        id,
        name,
        source: "calibrate",
        layer: null,
        spot,
        offset: { x, y },
        rotation: 0,
        pads: [],
        holes: [],
        design: null,
        groups,
        outline: [],
        copper: [],
        stats: computeStats(groups, limits),
    };
    return { job, summary, notes, svg };
}
