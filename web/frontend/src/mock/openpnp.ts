// The in-page mock's twin of the backend's G-code pick and place machine:
// a device profile read and checked with the backend's words, the board's
// fit from reference parts, and the placement program, line for line what
// the backend makes for the same profile and parts.

import { fitRigid, turnPoint } from "../align.ts";
import { parseToml, TomlError, type TomlTable, type TomlValue } from "../toml.ts";
import type { AlignFit, Component, DeviceDocument, DevicePlan } from "../types.ts";

export const DEVICE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const AXIS = /^[A-Z]$/;
const LINE = /^[\x20-\x7e]*$/;
const BAUDS = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 250000, 460800, 500000, 921600, 1000000, 2000000];
const COORD_LIMIT = 10000;
const FEED_LIMIT = 100000;

export interface MockFeeder {
    id: string;
    match: string;
    at: [number, number, number];
    pitch: [number, number];
    count: number;
    rotation: number;
    place_z: number | null;
    feed: string;
}

export interface MockDevice {
    id: string;
    name: string;
    description: string;
    url: string;
    baud: number;
    wait_ms: number;
    timeout: number;
    init: string[];
    end: string[];
    move: string;
    axes: [string, string, string, string];
    wait: string;
    pick: string;
    place: string;
    dwell: string;
    home: string;
    position: string;
    stop: string;
    feed_xy: number;
    feed_z: number;
    safe_z: number;
    place_z: number;
    pick_dwell_ms: number;
    place_dwell_ms: number;
    feeders: MockFeeder[];
}

class Reader {
    constructor(readonly where: string) {}

    fail(section: string | null, key: string, what: string): Error {
        return new Error(`${this.where}: ${section ? `[${section}] ${key}` : key} ${what}`);
    }

    table(top: TomlTable, name: string): TomlTable {
        const value = top[name] ?? {};
        if (typeof value !== "object" || Array.isArray(value)) {
            throw this.fail(null, name, "must be a table");
        }
        return value;
    }

    text(table: TomlTable, key: string, section: string | null, fallback: string): string {
        const value = table[key] ?? fallback;
        if (typeof value !== "string") {
            throw this.fail(section, key, "must be a string");
        }
        if (!LINE.test(value)) {
            throw this.fail(section, key, "must be one line of printable ASCII");
        }
        return value.trim();
    }

    lines(table: TomlTable, key: string, section: string, fallback: string[]): string[] {
        const value = table[key] ?? fallback;
        if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && LINE.test(item))) {
            throw this.fail(section, key, "must be a list of lines of printable ASCII");
        }
        return (value as string[]).map((item) => item.trim()).filter((item) => item !== "");
    }

    number(table: TomlTable, key: string, section: string, fallback: number | null, low = -COORD_LIMIT, high = COORD_LIMIT): number {
        if (!(key in table)) {
            if (fallback === null) {
                throw this.fail(section, key, "is needed");
            }
            return fallback;
        }
        const value = table[key];
        if (typeof value !== "number" || !Number.isFinite(value) || value < low || value > high) {
            throw this.fail(section, key, `must be a number from ${low} to ${high}`);
        }
        return value;
    }

    integer(table: TomlTable, key: string, section: string, fallback: number, low: number, high: number): number {
        const value = table[key] ?? fallback;
        if (typeof value !== "number" || !Number.isInteger(value) || value < low || value > high) {
            throw this.fail(section, key, `must be a whole number from ${low} to ${high}`);
        }
        return value;
    }

    point(table: TomlTable, key: string, section: string, size: number, fallback: number[] | null): number[] {
        if (!(key in table)) {
            if (fallback === null) {
                throw this.fail(section, key, "is needed");
            }
            return fallback;
        }
        const value = table[key] as TomlValue;
        if (!Array.isArray(value) || value.length !== size || !value.every((v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= COORD_LIMIT)) {
            throw this.fail(section, key, `must be ${size} numbers within ${COORD_LIMIT}`);
        }
        return value as number[];
    }

    done(table: TomlTable, section: string | null, known: string[]): void {
        const unknown = Object.keys(table).filter((key) => !known.includes(key)).sort();
        if (unknown.length > 0) {
            throw this.fail(section, unknown[0]!, "is not a key here");
        }
    }
}

/** A device profile from its TOML text, checked as the backend checks it; throws with its words. */
export function parseDevice(text: string, id: string): MockDevice {
    const where = `${id}.toml`;
    if (!DEVICE_ID.test(id)) {
        throw new Error(`'${id}' is not a device id: lower case letters, digits, - and _, starting with a letter or digit, at most 64`);
    }
    let top: TomlTable;
    try {
        top = parseToml(text);
    } catch (error) {
        throw new Error(`${where}: ${error instanceof TomlError ? `line ${error.line}: ${error.message}` : String(error)}`);
    }
    const read = new Reader(where);
    const port = read.table(top, "port");
    const baud = read.integer(port, "baud", "port", 115200, 1200, 2000000);
    if (!BAUDS.includes(baud)) {
        throw read.fail("port", "baud", `must be one of ${BAUDS.join(", ")}`);
    }
    const device: Partial<MockDevice> = {
        id,
        name: read.text(top, "name", null, id) || id,
        description: read.text(top, "description", null, ""),
        url: read.text(port, "url", "port", ""),
        baud,
        wait_ms: read.integer(port, "wait_ms", "port", 2000, 0, 30000),
        timeout: read.number(port, "timeout", "port", 60, 1, 600),
    };
    read.done(port, "port", ["url", "baud", "wait_ms", "timeout"]);
    const gcode = read.table(top, "gcode");
    device.init = read.lines(gcode, "init", "gcode", ["G21", "G90"]);
    device.end = read.lines(gcode, "end", "gcode", []);
    device.move = read.text(gcode, "move", "gcode", "G0");
    if (!device.move) {
        throw read.fail("gcode", "move", "must name the move word");
    }
    const axes: [string, string, string, string] = [
        read.text(gcode, "x", "gcode", "X"),
        read.text(gcode, "y", "gcode", "Y"),
        read.text(gcode, "z", "gcode", "Z"),
        read.text(gcode, "rotation", "gcode", "A"),
    ];
    ["x", "y", "z", "rotation"].forEach((key, index) => {
        const letter = axes[index]!;
        if (!AXIS.test(letter) || letter === "F") {
            throw read.fail("gcode", key, "must be one capital letter, not F");
        }
    });
    if (new Set(axes).size !== 4) {
        throw read.fail("gcode", "rotation", "the four axis letters must differ");
    }
    device.axes = axes;
    device.wait = read.text(gcode, "wait", "gcode", "M400");
    device.pick = read.text(gcode, "pick", "gcode", "M106");
    device.place = read.text(gcode, "place", "gcode", "M107");
    if (!device.pick || !device.place) {
        throw read.fail("gcode", !device.pick ? "pick" : "place", "must name the vacuum's command");
    }
    device.dwell = read.text(gcode, "dwell", "gcode", "G4 P{ms}");
    if (device.dwell && !device.dwell.includes("{ms}") && !device.dwell.includes("{s}")) {
        throw read.fail("gcode", "dwell", "must hold {ms} or {s} for the time, or be empty for none");
    }
    device.home = read.text(gcode, "home", "gcode", "G28");
    device.position = read.text(gcode, "position", "gcode", "M114");
    device.stop = read.text(gcode, "stop", "gcode", "M410");
    read.done(gcode, "gcode", ["init", "end", "move", "x", "y", "z", "rotation", "wait", "pick", "place", "dwell", "home", "position", "stop"]);
    const motion = read.table(top, "motion");
    device.feed_xy = read.number(motion, "feed_xy", "motion", 6000, 1, FEED_LIMIT);
    device.feed_z = read.number(motion, "feed_z", "motion", 1200, 1, FEED_LIMIT);
    device.safe_z = read.number(motion, "safe_z", "motion", null);
    device.place_z = read.number(motion, "place_z", "motion", null);
    device.pick_dwell_ms = read.integer(motion, "pick_dwell_ms", "motion", 200, 0, 60000);
    device.place_dwell_ms = read.integer(motion, "place_dwell_ms", "motion", 150, 0, 60000);
    read.done(motion, "motion", ["feed_xy", "feed_z", "safe_z", "place_z", "pick_dwell_ms", "place_dwell_ms"]);
    const tables = top["feeder"] ?? [];
    if (!Array.isArray(tables) || !tables.every((item) => typeof item === "object" && item !== null && !Array.isArray(item))) {
        throw read.fail(null, "feeder", "must be an array of tables ([[feeder]])");
    }
    const feeders: MockFeeder[] = [];
    (tables as TomlTable[]).forEach((table, offset) => {
        const section = `feeder ${offset + 1}`;
        const feederId = read.text(table, "id", section, "");
        if (!DEVICE_ID.test(feederId)) {
            throw read.fail(section, "id", "must be lower case letters, digits, - and _, starting with a letter or digit");
        }
        if (feeders.some((other) => other.id === feederId)) {
            throw read.fail(section, "id", `'${feederId}' is another feeder's too`);
        }
        const match = read.text(table, "match", section, "");
        if (!match) {
            throw read.fail(section, "match", "must hold the words of a part's value or footprint");
        }
        feeders.push({
            id: feederId,
            match,
            at: read.point(table, "at", section, 3, null) as [number, number, number],
            pitch: read.point(table, "pitch", section, 2, [0, 0]) as [number, number],
            count: read.integer(table, "count", section, 0, 0, 100000),
            rotation: read.number(table, "rotation", section, 0, -360, 360),
            place_z: "place_z" in table ? read.number(table, "place_z", section, null) : null,
            feed: read.text(table, "feed", section, ""),
        });
        read.done(table, section, ["id", "match", "at", "pitch", "count", "rotation", "place_z", "feed"]);
    });
    device.feeders = feeders;
    read.done(top, null, ["name", "description", "port", "gcode", "motion", "feeder"]);
    return device as MockDevice;
}

/** What the backend sends of a profile. */
export function deviceDocument(device: MockDevice): DeviceDocument {
    return {
        id: device.id,
        name: device.name,
        description: device.description,
        url: device.url,
        baud: device.baud,
        wait_ms: device.wait_ms,
        timeout: device.timeout,
        axes: [...device.axes],
        safe_z: device.safe_z,
        place_z: device.place_z,
        feeders: device.feeders.map((f) => ({ id: f.id, match: f.match, at: [...f.at], pitch: [...f.pitch], count: f.count, rotation: f.rotation })),
    };
}

/** The first feeder whose words a part's value and footprint all hold, or null. */
export function feederFor<T extends { match: string }>(feeders: T[], value: string, footprint: string): T | null {
    const hay = `${value} ${footprint}`.toLowerCase();
    return feeders.find((feeder) => feeder.match.toLowerCase().split(/\s+/).filter((word) => word !== "").every((word) => hay.includes(word))) ?? null;
}

/** A plain decimal with the zeros after its point dropped, and no negative zero. */
export function gnum(value: number, decimals = 3): string {
    let text = value.toFixed(decimals);
    if (text.includes(".")) {
        text = text.replace(/0+$/, "").replace(/\.$/, "");
    }
    return text === "-0" || text === "" ? "0" : text;
}

/** An angle in (-180, 180]. */
export function wrapAngle(degrees: number): number {
    let turned = degrees % 360;
    if (turned <= -180) {
        turned += 360;
    } else if (turned > 180) {
        turned -= 360;
    }
    return turned;
}

/** Where the board lies on the device, from reference parts: a shift (and a typed turn) from one, a turn and a shift from more. */
export function deviceFit(pairs: [[number, number], [number, number]][], angle: number | null): AlignFit {
    if (pairs.length === 0) {
        throw new Error("the board has no reference on the device: put the nozzle over a part's place and press Here");
    }
    const fit = fitRigid(pairs.map(([design, machine]) => ({ design, machine })), pairs.length === 1 ? angle ?? 0 : null);
    return { ...fit, marks: pairs.length };
}

export interface MockBlock {
    ref: string;
    feeder: string;
    index: number;
    lines: string[];
}

export interface MockPlan {
    head: string[];
    blocks: MockBlock[];
    tail: string[];
    skipped: { ref: string; reason: string }[];
    fit: AlignFit;
}

/** The program's text, comments and all. */
export function planText(plan: MockPlan): string {
    return [...plan.head, ...plan.blocks.flatMap((block) => block.lines), ...plan.tail].join("\n") + "\n";
}

/** A line as it goes out: its comment and the space around it taken off. */
export function codeOf(line: string): string {
    return line.split(";", 1)[0]!.trim();
}

/** What the backend answers for a plan. */
export function planSummary(plan: MockPlan): DevicePlan {
    const text = planText(plan);
    return {
        parts: plan.blocks.map((block) => ({ ref: block.ref, feeder: block.feeder, index: block.index })),
        skipped: plan.skipped,
        fit: plan.fit,
        lines: text.split("\n").filter((line) => codeOf(line) !== "").length,
        text,
    };
}

/** The placement program, as the backend makes it. */
export function planDevice(device: MockDevice, parts: Component[], fit: AlignFit, taken: Record<string, number>, refs: string[] | null, title: string): MockPlan {
    const [x, y, z, a] = device.axes;
    const move = device.move;
    const given: Record<string, number> = { ...taken };
    const blocks: MockBlock[] = [];
    const skipped: { ref: string; reason: string }[] = [];
    const wanted = refs !== null ? new Set(refs) : null;
    if (wanted !== null) {
        const known = new Set(parts.map((part) => part.ref));
        for (const missing of [...wanted].filter((ref) => !known.has(ref)).sort()) {
            skipped.push({ ref: missing, reason: "not a part of this job" });
        }
    }
    const apply = (point: [number, number]): [number, number] => {
        const [tx, ty] = turnPoint(point, fit.rotation);
        return [tx + fit.shift[0], ty + fit.shift[1]];
    };
    const dwell = (ms: number): string[] => (ms <= 0 || !device.dwell ? [] : [device.dwell.replace("{ms}", String(ms)).replace("{s}", gnum(ms / 1000))]);
    const waits = device.wait ? [device.wait] : [];
    const safe = `${move} ${z}${gnum(device.safe_z)} F${gnum(device.feed_z, 0)}`;
    for (const part of parts) {
        if (wanted !== null && !wanted.has(part.ref)) {
            continue;
        }
        if (part.dnp) {
            skipped.push({ ref: part.ref, reason: "not to be fitted (dnp)" });
            continue;
        }
        if (part.side === "back") {
            skipped.push({ ref: part.ref, reason: "on the back" });
            continue;
        }
        const feeder = feederFor(device.feeders, part.value, part.footprint);
        if (!feeder) {
            skipped.push({ ref: part.ref, reason: "no feeder holds it" });
            continue;
        }
        const index = given[feeder.id] ?? 0;
        if (feeder.count > 0 && index >= feeder.count) {
            skipped.push({ ref: part.ref, reason: `feeder ${feeder.id} is empty` });
            continue;
        }
        given[feeder.id] = index + 1;
        const step = feeder.count > 0 ? index : 0;
        const [px, py, pz] = [feeder.at[0] + step * feeder.pitch[0], feeder.at[1] + step * feeder.pitch[1], feeder.at[2]];
        const [qx, qy] = apply([part.x, part.y]);
        const turn = wrapAngle(part.rotation + fit.rotation - feeder.rotation);
        const placeZ = feeder.place_z ?? device.place_z;
        const lines = [`; ${part.ref} ${part.value} from ${feeder.id} #${index + 1}`.trimEnd()];
        if (feeder.feed) {
            lines.push(feeder.feed);
        }
        lines.push(
            safe,
            `${move} ${x}${gnum(px)} ${y}${gnum(py)} ${a}0 F${gnum(device.feed_xy, 0)}`,
            `${move} ${z}${gnum(pz)} F${gnum(device.feed_z, 0)}`,
            ...waits,
            device.pick,
            ...dwell(device.pick_dwell_ms),
            safe,
            `${move} ${x}${gnum(qx)} ${y}${gnum(qy)} ${a}${gnum(turn)} F${gnum(device.feed_xy, 0)}`,
            `${move} ${z}${gnum(placeZ)} F${gnum(device.feed_z, 0)}`,
            ...waits,
            device.place,
            ...dwell(device.place_dwell_ms),
            safe,
        );
        blocks.push({ ref: part.ref, feeder: feeder.id, index, lines });
    }
    const head = [`; ${title || "placement"} on ${device.name}: ${blocks.length} parts`, ...device.init];
    return { head, blocks, tail: [...waits, ...device.end], skipped, fit };
}

/** The nozzle up to the safe height and over a part's place on the device. */
export function deviceGotoLines(device: MockDevice, fit: AlignFit, part: Component): string[] {
    const [x, y, z] = device.axes;
    const [tx, ty] = turnPoint([part.x, part.y], fit.rotation);
    return [
        `${device.move} ${z}${gnum(device.safe_z)} F${gnum(device.feed_z, 0)}`,
        `${device.move} ${x}${gnum(tx + fit.shift[0])} ${y}${gnum(ty + fit.shift[1])} F${gnum(device.feed_xy, 0)}`,
    ];
}
