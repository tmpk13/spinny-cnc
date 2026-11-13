// The servos the jog panel draws a bar for: every one the live settings fit
// (servoN_out above 0), named and with the buttons of the machine file the
// controls come from. A servo the file does not describe still gets a bar,
// as "Servo N" with no named positions, so one fitted at the console can be
// moved too.

import { parseNumber } from "./format.ts";
import { SERVOS } from "./machinekeys.ts";
import type { ServoInfo, ServoPosition } from "./types.ts";

/** One servo's bar: its number (1 to 4), name, range in degrees and the named angles within it. */
export interface ServoBar {
    servo: number;
    name: string;
    range: number;
    positions: ServoPosition[];
}

/**
 * The bars for the servos the settings fit, servo 1 first. A G-code
 * machine's servos are its controller's and get none; nor do settings not
 * read yet.
 */
export function servoBars(values: Record<string, number> | undefined, infos: ServoInfo[] | undefined, gcode: boolean): ServoBar[] {
    if (values === undefined || gcode) {
        return [];
    }
    const bars: ServoBar[] = [];
    for (let n = 1; n <= SERVOS; n += 1) {
        if (!values[`servo${n}_out`]) {
            continue;
        }
        const info = infos?.find((entry) => entry.servo === n);
        // The board's range is the one a line is held to.
        const range = values[`servo${n}_range`] ?? info?.range ?? 180;
        const positions = (info?.positions ?? []).filter((position) => position.angle >= 0 && position.angle <= range);
        bars.push({ servo: n, name: info?.name ?? `Servo ${n}`, range, positions });
    }
    return bars;
}

/** What a bar shows of where its servo is: the angle, or `off` without a pulse. */
export function angleText(angle: number | null | undefined): string {
    if (angle === null || angle === undefined) {
        return "off";
    }
    return `${Math.round(angle * 100) / 100} deg`;
}

/** An angle typed for a servo: a number within its range, or what is wrong with the text. */
export function readAngle(text: string, range: number): { angle: number } | { problem: string } {
    const angle = parseNumber(text);
    if (angle === null || !(angle >= 0 && angle <= range)) {
        return { problem: `enter an angle, 0 to ${range} deg` };
    }
    return { angle };
}

/** The bars as one text, so a panel redraws them only when one of them changes. */
export function servoKey(bars: ServoBar[]): string {
    return JSON.stringify(bars);
}
