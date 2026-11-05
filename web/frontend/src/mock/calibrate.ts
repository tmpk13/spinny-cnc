// The mock's twin of the calibration tests (spinny_laser.calibrate and
// spinny_web.calibration): a laser's material test, a grid of squares at a
// power and a speed each, its focus ladder, a row of lines a step over
// focus each, and a mill's depth test, a row of slots a step deeper each,
// every patch a group of its own.

import type { CalibrateRequest, CalibrateResponse, Group, Path, Point } from "../types.ts";
import { DEFAULT_DEPTH, DEFAULT_PLUNGE, checkDepth, checkFocus, checkPower, checkSpeed, computeStats, formatG, type RateLimits } from "./jobs.ts";

/** The most patches along a side, and the largest patch or slot, mm. */
export const MAX_STEPS = 12;
export const MAX_SIZE = 100;
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

/** One path back and forth across the square, a pitch apart. */
function hatch(x: number, y: number, size: number, pitch: number): Path {
    const lines = Math.max(1, Math.floor(size / pitch + 1e-9) + 1);
    const step = lines > 1 ? size / (lines - 1) : 0;
    const points: Point[] = [];
    for (let i = 0; i < lines; i += 1) {
        const row = y + i * step;
        const ends: Point[] = [[x, row], [x + size, row]];
        points.push(...(i % 2 === 0 ? ends : ends.reverse()));
    }
    return points;
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
        if (fill && !(spot > 0 && spot <= size)) {
            throw new Error("the fill's pitch must be above 0 and at most the size");
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
    } else {
        if (!milling) {
            throw new Error("the depth test is a mill's ($spindle=1): a laser takes the material test");
        }
        const [d0, d1, dn] = request.depths ?? [0.05, 0.3, 6];
        const depths = ladder(d0, d1, dn);
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
    return { job, summary, notes };
}
