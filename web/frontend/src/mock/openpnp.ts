// The in-page mock's twin of the backend's G-code pick and place machine:
// a device profile read and checked with the backend's words, the board's
// fit from reference parts, and the placement program, line for line what
// the backend makes for the same profile and parts (the plan before a run:
// the vacuum reads, the notes where a camera looks, the nozzle's runout
// made up for, the rotation axis's sign).

import { fitRigid, turnPoint } from "../align.ts";
import { errorText } from "../api.ts";
import { parseToml, TomlError, type TomlTable, type TomlValue } from "../toml.ts";
import type { AlignFit, Component, DeviceDocument, DevicePlan, SpotPolarity } from "../types.ts";

export const DEVICE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const AXIS = /^[A-Z]$/;
const LINE = /^[\x20-\x7e]*$/;
const BAUDS = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 250000, 460800, 500000, 921600, 1000000, 2000000];
const COORD_LIMIT = 10000;
const FEED_LIMIT = 100000;
const SHADES = ["dark", "bright"];
/** Marlin's answer to M105 carries a sensor read through a thermistor input as `T:12.34`. */
export const DEFAULT_VACUUM_PATTERN = "T:\\s*(-?[0-9]+(?:\\.[0-9]+)?)";
/** OpenPnP's patterns name their group the Java way, (?<Value>...); the backend keeps them as Python's (?P<Value>...). */
const JAVA_GROUP = /\(\?<(?![=!])/g;

export interface MockFeeder {
    id: string;
    match: string;
    at: [number, number, number];
    pitch: [number, number];
    count: number;
    /** A tray's columns, 0 for a strip, and the step from row to row. */
    columns: number;
    row_pitch: [number, number];
    rotation: number;
    place_z: number | null;
    /** Lines sent before each pick. */
    feed: string[];
    /** Each part is looked at over the up camera before it is placed. */
    vision: boolean;
    /** The part's length and width as the cameras see it; null takes the footprint's body. */
    size: [number, number] | null;
    /** The shade of a part in its pocket to the top camera, which then looks before each pick. */
    pocket: SpotPolarity | null;
    /** Marks on the feeder the top camera finds once a run. */
    marks: [number, number][];
    mark: SpotPolarity;
}

export interface MockVacuum {
    read: string;
    /** As the backend keeps it: Python's (?P<name>...) for a named group. */
    pattern: string;
    part_on: [number, number];
    part_off: [number, number] | null;
}

export interface MockTopProfile {
    z: number | null;
    offset: [number, number] | null;
    fiducial: SpotPolarity;
    within: number;
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
    /** The height the nozzle is seen sharp at over the up camera; null keeps the safe height. */
    camera_z: number | null;
    /** A positive rotation turns the nozzle clockwise: every angle goes out negated. */
    rotation_cw: boolean;
    discard: [number, number, number] | null;
    pick_tries: number;
    vacuum: MockVacuum | null;
    max_offset: number;
    max_turn: number;
    size_tolerance: number;
    top: MockTopProfile | null;
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

    text(table: TomlTable, key: string, section: string | null, fallback: string, line = true): string {
        const value = table[key] ?? fallback;
        if (typeof value !== "string") {
            throw this.fail(section, key, "must be a string");
        }
        if (line && !LINE.test(value)) {
            throw this.fail(section, key, "must be one line of printable ASCII");
        }
        return value.trim();
    }

    shade(table: TomlTable, key: string, section: string, fallback: SpotPolarity): SpotPolarity {
        const value = table[key] ?? fallback;
        if (typeof value !== "string" || !SHADES.includes(value)) {
            throw this.fail(section, key, "must be dark or bright");
        }
        return value as SpotPolarity;
    }

    /** Two numbers, the low one first, or null when left out. */
    span(table: TomlTable, key: string, section: string): [number, number] | null {
        if (!(key in table)) {
            return null;
        }
        const [low, high] = this.point(table, key, section, 2, null) as [number, number];
        if (low > high) {
            throw this.fail(section, key, "must be the low reading, then the high one");
        }
        return [low, high];
    }

    places(table: TomlTable, key: string, section: string, most: number): [number, number][] {
        const value = (table[key] ?? []) as TomlValue;
        const fine = Array.isArray(value)
            && value.length <= most
            && value.every((item) => Array.isArray(item) && item.length === 2 && item.every((v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= COORD_LIMIT));
        if (!fine) {
            throw this.fail(section, key, `must be a list of at most ${most} places, each [X, Y]`);
        }
        return (value as number[][]).map((item) => [item[0]!, item[1]!]);
    }

    lines(table: TomlTable, key: string, section: string, fallback: string[], one = false): string[] {
        let value = table[key] ?? fallback;
        if (one && typeof value === "string") {
            value = [value];
        }
        if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && LINE.test(item))) {
            throw this.fail(section, key, `must be ${one ? "a line, or " : ""}a list of lines of printable ASCII`);
        }
        return (value as string[]).map((item) => item.trim()).filter((item) => item !== "");
    }

    flag(table: TomlTable, key: string, section: string, fallback: boolean): boolean {
        const value = table[key] ?? fallback;
        if (typeof value !== "boolean") {
            throw this.fail(section, key, "must be true or false");
        }
        return value;
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
    device.rotation_cw = read.flag(gcode, "rotation_cw", "gcode", false);
    read.done(gcode, "gcode", ["init", "end", "move", "x", "y", "z", "rotation", "rotation_cw", "wait", "pick", "place", "dwell", "home", "position", "stop"]);
    const motion = read.table(top, "motion");
    device.feed_xy = read.number(motion, "feed_xy", "motion", 6000, 1, FEED_LIMIT);
    device.feed_z = read.number(motion, "feed_z", "motion", 1200, 1, FEED_LIMIT);
    device.safe_z = read.number(motion, "safe_z", "motion", null);
    device.place_z = read.number(motion, "place_z", "motion", null);
    device.pick_dwell_ms = read.integer(motion, "pick_dwell_ms", "motion", 200, 0, 60000);
    device.place_dwell_ms = read.integer(motion, "place_dwell_ms", "motion", 150, 0, 60000);
    device.discard = "discard" in motion ? (read.point(motion, "discard", "motion", 3, null) as [number, number, number]) : null;
    device.pick_tries = read.integer(motion, "pick_tries", "motion", 3, 1, 20);
    read.done(motion, "motion", ["feed_xy", "feed_z", "safe_z", "place_z", "pick_dwell_ms", "place_dwell_ms", "discard", "pick_tries"]);
    device.vacuum = null;
    const sensor = read.table(top, "vacuum");
    if (Object.keys(sensor).length > 0) {
        const readLine = read.text(sensor, "read", "vacuum", "");
        if (!readLine) {
            throw read.fail("vacuum", "read", "must name the line that reads the vacuum sensor");
        }
        const pattern = read.text(sensor, "pattern", "vacuum", DEFAULT_VACUUM_PATTERN, false).replace(JAVA_GROUP, "(?P<");
        let groups: number;
        try {
            groups = new RegExp(`${jsPattern(pattern)}|`).exec("")!.length - 1;
        } catch (error) {
            throw read.fail("vacuum", "pattern", `is not a regular expression: ${errorText(error)}`);
        }
        if (groups < 1) {
            throw read.fail("vacuum", "pattern", "must hold a group, ( ), around the reading");
        }
        const partOn = read.span(sensor, "part_on", "vacuum");
        if (partOn === null) {
            throw read.fail("vacuum", "part_on", "is needed: the low and high reading with a part held");
        }
        device.vacuum = { read: readLine, pattern, part_on: partOn, part_off: read.span(sensor, "part_off", "vacuum") };
        read.done(sensor, "vacuum", ["read", "pattern", "part_on", "part_off"]);
    }
    device.top = null;
    const looking = read.table(top, "top_camera");
    if (Object.keys(looking).length > 0) {
        device.top = {
            z: "z" in looking ? read.number(looking, "z", "top_camera", null) : null,
            offset: "offset" in looking ? (read.point(looking, "offset", "top_camera", 2, null) as [number, number]) : null,
            fiducial: read.shade(looking, "fiducial", "top_camera", "bright"),
            within: read.number(looking, "within", "top_camera", 2, 0.1, 50),
        };
        read.done(looking, "top_camera", ["z", "offset", "fiducial", "within"]);
    }
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
        const placeZ = "place_z" in table ? read.number(table, "place_z", section, null) : null;
        const count = read.integer(table, "count", section, 0, 0, 100000);
        const columns = read.integer(table, "columns", section, 0, 0, 10000);
        if (columns > 0 && count === 0) {
            throw read.fail(section, "columns", "makes a tray, which needs its count of parts");
        }
        if ("row_pitch" in table && columns === 0) {
            throw read.fail(section, "row_pitch", "is for a tray: give its columns too");
        }
        let size: [number, number] | null = null;
        if ("size" in table) {
            size = read.point(table, "size", section, 2, null) as [number, number];
            if (!size.every((value) => value > 0 && value <= 200)) {
                throw read.fail(section, "size", "must be a length and a width over 0, at most 200 mm");
            }
        }
        const pocket = "pocket" in table ? read.shade(table, "pocket", section, "dark") : null;
        const marks = read.places(table, "marks", section, 2);
        if ((pocket !== null || marks.length > 0) && device.top === null) {
            throw read.fail(section, pocket !== null ? "pocket" : "marks", "looks with the top camera: add a [top_camera] section");
        }
        feeders.push({
            id: feederId,
            match,
            at: read.point(table, "at", section, 3, null) as [number, number, number],
            pitch: read.point(table, "pitch", section, 2, [0, 0]) as [number, number],
            count,
            columns,
            row_pitch: read.point(table, "row_pitch", section, 2, [0, 0]) as [number, number],
            rotation: read.number(table, "rotation", section, 0, -360, 360),
            place_z: placeZ,
            feed: read.lines(table, "feed", section, [], true),
            vision: read.flag(table, "vision", section, false),
            size,
            pocket,
            marks,
            mark: read.shade(table, "mark", section, "dark"),
        });
        read.done(table, section, ["id", "match", "at", "pitch", "count", "columns", "row_pitch", "rotation", "place_z", "feed", "vision", "size", "pocket", "marks", "mark"]);
    });
    device.feeders = feeders;
    const camera = read.table(top, "camera");
    device.camera_z = "z" in camera ? read.number(camera, "z", "camera", null) : null;
    device.max_offset = read.number(camera, "max_offset", "camera", 1, 0.01, 20);
    device.max_turn = read.number(camera, "max_turn", "camera", 15, 0.1, 45);
    device.size_tolerance = read.number(camera, "size_tolerance", "camera", 0.3, 0, 1);
    read.done(camera, "camera", ["z", "max_offset", "max_turn", "size_tolerance"]);
    read.done(top, null, ["name", "description", "port", "gcode", "motion", "vacuum", "top_camera", "feeder", "camera"]);
    return device as MockDevice;
}

/** A pattern as the backend keeps it (Python's named groups) as JavaScript takes it. */
export function jsPattern(pattern: string): string {
    return pattern.replace(/\(\?P</g, "(?<");
}

/** The reading in an answer to the vacuum's read line: its group named Value (any case), else its first; null for none. */
export function vacuumReading(vacuum: MockVacuum, reply: string[]): number | null {
    const regex = new RegExp(jsPattern(vacuum.pattern));
    for (const line of reply) {
        const found = regex.exec(line);
        if (!found) {
            continue;
        }
        const named = found.groups ? Object.entries(found.groups).find(([key]) => key.toLowerCase() === "value")?.[1] : undefined;
        const value = Number(named ?? found[1]);
        if (Number.isFinite(value)) {
            return value;
        }
    }
    return null;
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
        rotation_cw: device.rotation_cw,
        safe_z: device.safe_z,
        place_z: device.place_z,
        discard: device.discard ? [...device.discard] : null,
        pick_tries: device.pick_tries,
        camera_z: device.camera_z,
        max_offset: device.max_offset,
        max_turn: device.max_turn,
        size_tolerance: device.size_tolerance,
        vacuum: device.vacuum
            ? { read: device.vacuum.read, pattern: device.vacuum.pattern, part_on: [...device.vacuum.part_on], part_off: device.vacuum.part_off ? [...device.vacuum.part_off] : null }
            : null,
        top: device.top ? { z: device.top.z, offset: device.top.offset ? [...device.top.offset] : null, fiducial: device.top.fiducial, within: device.top.within } : null,
        feeders: device.feeders.map((f) => ({
            id: f.id,
            match: f.match,
            at: [...f.at],
            pitch: [...f.pitch],
            count: f.count,
            columns: f.columns,
            rotation: f.rotation,
            vision: f.vision,
            size: f.size ? [...f.size] : null,
            pocket: f.pocket,
            marks: f.marks.map((mark) => [mark[0], mark[1]]),
            mark: f.mark,
        })),
    };
}

/** Where a feeder's part `index` is: along a strip, or row by row in a tray. */
export function feederPlace(feeder: MockFeeder, index: number): [number, number, number] {
    if (feeder.columns > 0) {
        const column = index % feeder.columns;
        const row = Math.floor(index / feeder.columns);
        return [
            feeder.at[0] + column * feeder.pitch[0] + row * feeder.row_pitch[0],
            feeder.at[1] + column * feeder.pitch[1] + row * feeder.row_pitch[1],
            feeder.at[2],
        ];
    }
    return [feeder.at[0] + index * feeder.pitch[0], feeder.at[1] + index * feeder.pitch[1], feeder.at[2]];
}

/** The first feeder whose words a part's value and footprint all hold, or null. */
export function feederFor<T extends { match: string }>(feeders: T[], value: string, footprint: string): T | null {
    const hay = `${value} ${footprint}`.toLowerCase();
    return feeders.find((feeder) => feeder.match.toLowerCase().split(/\s+/).filter((word) => word !== "").every((word) => hay.includes(word))) ?? null;
}

/** A plain decimal with the zeros after its point dropped, and no negative zero. */
export function gnum(value: number, decimals = 3): string {
    let text = value.toFixed(decimals);
    // From 1e21 up toFixed writes an exponent, whose zeros are not trailing ones.
    if (text.includes(".") && !text.includes("e")) {
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

export const VISION_NOTE = "; looked at over the up camera: placed where its center lands";
export const POCKET_NOTE = "; the top camera looks at the pocket first: picked where the part is";
export const MARKS_NOTE = "; the feeder's marks are found with the top camera first: its places follow them";

export interface MockBlock {
    ref: string;
    feeder: string;
    index: number;
    pick: string[];
    place: string[];
    target: [number, number];
    turn: number;
    place_z: number;
    vision: boolean;
    /** The vacuum read with the part held, and once it let go. */
    check: string[];
    release: string[];
    /** The part's angle on the device. */
    angle: number;
}

/** A block's lines as the program text has them. */
export function blockLines(block: MockBlock): string[] {
    return [...block.pick, ...block.check, ...(block.vision ? [VISION_NOTE] : []), ...block.place, ...block.release];
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
    return [...plan.head, ...plan.blocks.flatMap(blockLines), ...plan.tail].join("\n") + "\n";
}

/** A line as it goes out: its comment and the space around it taken off. */
export function codeOf(line: string): string {
    return line.split(";", 1)[0]!.trim();
}

/** What the backend answers for a plan. */
export function planSummary(plan: MockPlan): DevicePlan {
    const text = planText(plan);
    return {
        parts: plan.blocks.map((block) => ({ ref: block.ref, feeder: block.feeder, index: block.index, vision: block.vision })),
        skipped: plan.skipped,
        fit: plan.fit,
        lines: text.split("\n").filter((line) => codeOf(line) !== "").length,
        text,
    };
}

function dwellLines(device: MockDevice, ms: number): string[] {
    return ms <= 0 || !device.dwell ? [] : [device.dwell.replace("{ms}", String(ms)).replace("{s}", gnum(ms / 1000))];
}

/** An angle of the nozzle, counterclockwise from above, as the rotation axis's word: negated for an axis that turns clockwise. */
export function angleWord(device: MockDevice, degrees: number): string {
    return `${device.axes[3]}${gnum(device.rotation_cw ? -degrees : degrees)}`;
}

/** The nozzle's height axis moved to `z`, at its feed. */
export function zLine(device: MockDevice, z: number): string {
    return `${device.move} ${device.axes[2]}${gnum(z)} F${gnum(device.feed_z, 0)}`;
}

/** The head moved across to `x`, `y`, the nozzle turned to `turn` on the way when one is given, at the feed across. */
export function xyLine(device: MockDevice, x: number, y: number, turn?: number): string {
    const angle = turn === undefined ? "" : ` ${angleWord(device, turn)}`;
    return `${device.move} ${device.axes[0]}${gnum(x)} ${device.axes[1]}${gnum(y)}${angle} F${gnum(device.feed_xy, 0)}`;
}

/** The nozzle up to the safe height. */
export function safeLine(device: MockDevice): string {
    return zLine(device, device.safe_z);
}

/** How far the head moves to keep the nozzle's tip on a point as the nozzle turns from 0 to `degrees`, the tip `runout` off the axis at 0. */
export function tipShift(runout: [number, number], degrees: number): [number, number] {
    const [sx, sy] = turnPoint(runout, degrees);
    return [runout[0] - sx, runout[1] - sy];
}

/** The lines that take a part from its pocket: which, the feeder's own lines, up, over it turned to 0, down, the vacuum on, and back up. */
export function pickLines(device: MockDevice, feeder: MockFeeder, label: string, point: [number, number, number]): string[] {
    return [
        `; ${label}`.trimEnd(),
        ...feeder.feed,
        safeLine(device),
        xyLine(device, point[0], point[1], 0),
        zLine(device, point[2]),
        ...(device.wait ? [device.wait] : []),
        device.pick,
        ...dwellLines(device, device.pick_dwell_ms),
        safeLine(device),
    ];
}

/** The vacuum read with the head at rest: a part held after a pick, the nozzle empty after a place (when the profile says what empty reads). */
export function checkLines(device: MockDevice, held: boolean): string[] {
    const vacuum = device.vacuum;
    const span = vacuum === null ? null : held ? vacuum.part_on : vacuum.part_off;
    if (vacuum === null || span === null) {
        return [];
    }
    return [...(device.wait ? [device.wait] : []), `${vacuum.read} ; vacuum: ${held ? "a part held" : "an empty nozzle"} reads ${gnum(span[0])} to ${gnum(span[1])}`];
}

/** The lines that put a held part down: across at the safe height, turned to its angle, down, the vacuum off, and back up. */
export function placeLines(device: MockDevice, point: [number, number], turn: number, placeZ: number): string[] {
    return [
        xyLine(device, point[0], point[1], turn),
        zLine(device, placeZ),
        ...(device.wait ? [device.wait] : []),
        device.place,
        ...dwellLines(device, device.place_dwell_ms),
        safeLine(device),
    ];
}

/** The placement program, as the backend makes it. */
export function planDevice(
    device: MockDevice,
    parts: Component[],
    fit: AlignFit,
    taken: Record<string, number>,
    refs: string[] | null,
    title: string,
    visionReady = false,
    runout: [number, number] = [0, 0],
): MockPlan {
    const given: Record<string, number> = { ...taken };
    const blocks: MockBlock[] = [];
    const skipped: { ref: string; reason: string }[] = [];
    const marked = new Set<string>();
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
    for (const part of parts) {
        if (wanted !== null && !wanted.has(part.ref)) {
            continue;
        }
        if (part.fiducial) {
            if (wanted !== null) {
                skipped.push({ ref: part.ref, reason: "a fiducial, not a part" });
            }
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
        if (feeder.vision && !visionReady) {
            skipped.push({ ref: part.ref, reason: `feeder ${feeder.id} wants the up camera: center the nozzle over it first` });
            continue;
        }
        const index = given[feeder.id] ?? 0;
        if (feeder.count > 0 && index >= feeder.count) {
            skipped.push({ ref: part.ref, reason: `feeder ${feeder.id} is empty` });
            continue;
        }
        given[feeder.id] = index + 1;
        const [qx, qy] = apply([part.x, part.y]);
        const angle = wrapAngle(part.rotation + fit.rotation);
        const turn = wrapAngle(angle - feeder.rotation);
        const placeZ = feeder.place_z ?? device.place_z;
        const pick = pickLines(device, feeder, `${part.ref} ${part.value} from ${feeder.id} #${index + 1}`, feederPlace(feeder, feeder.count > 0 ? index : 0));
        const notes: string[] = [];
        if (feeder.marks.length > 0 && !marked.has(feeder.id)) {
            marked.add(feeder.id);
            notes.push(MARKS_NOTE);
        }
        if (feeder.pocket !== null) {
            notes.push(POCKET_NOTE);
        }
        const [sx, sy] = tipShift(runout, turn);
        blocks.push({
            ref: part.ref,
            feeder: feeder.id,
            index,
            pick: [pick[0]!, ...notes, ...pick.slice(1)],
            place: placeLines(device, [qx + sx, qy + sy], turn, placeZ),
            target: [qx, qy],
            turn,
            place_z: placeZ,
            vision: feeder.vision,
            check: checkLines(device, true),
            release: checkLines(device, false),
            angle,
        });
    }
    const head = [`; ${title || "placement"} on ${device.name}: ${blocks.length} parts`, ...device.init];
    return { head, blocks, tail: [...(device.wait ? [device.wait] : []), ...device.end], skipped, fit };
}

/** The nozzle up to the safe height and over a part's place on the device. */
export function deviceGotoLines(device: MockDevice, fit: AlignFit, part: Component): string[] {
    const [tx, ty] = turnPoint([part.x, part.y], fit.rotation);
    return [
        safeLine(device),
        xyLine(device, tx + fit.shift[0], ty + fit.shift[1]),
    ];
}
