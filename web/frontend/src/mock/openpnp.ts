// The in-page mock's twin of the backend's G-code pick and place machine:
// a G-code machine file's own tables read and checked with the backend's
// words, the board's fit from reference parts, and the placement program,
// line for line what the backend makes for the same file and parts (the
// plan before a run: the vacuum reads, the notes where a camera looks, the
// nozzle's runout made up for, the rotation axis's sign).

import { fitRigid, turnPoint } from "../align.ts";
import { errorText } from "../api.ts";
import { checkTasks, TOP_TASKS, UP_TASKS, type CropBox } from "../crops.ts";
import { type TomlTable, type TomlValue } from "../toml.ts";
import { HEADER_FIELDS, slotPlace } from "../feederbus.ts";
import type { AlignFit, Component, GcodeDocument, PartClass, PlacingPlan, SpotPolarity } from "../types.ts";

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
/** A camera's capture size, as the camera settings take it. */
const CAPTURE_SIZE = /^[1-9][0-9]{1,4}x[1-9][0-9]{1,4}$/;
/** A camera's own settings a G-code machine's file may name in its [top_camera] or [up_camera], as openpnp.TOP_CAMERA_SETTINGS and UP_CAMERA_SETTINGS. */
export const TOP_CAMERA_SETTINGS = ["device", "size", "fps", "pcbv", "mark_spot"] as const;
export const UP_CAMERA_SETTINGS = ["device", "size", "fps", "pcbv", "nozzle_spot", "part_spot"] as const;
/** Who takes the axes' skew out ([motion] skew_by), as openpnp.SKEW_BY: the backend's link, or the firmware told it by [gcode] skew. */
export const SKEW_BY = ["link", "firmware"] as const;
/** The largest skew a file may give, mm of X per mm of Y (openpnp.SKEW_LIMIT): an angle in degrees typed for it is refused. */
const SKEW_LIMIT = 0.02;
/** Decimals the skew goes out to the firmware with. */
const SKEW_DECIMALS = 6;
/** The camera settings a file names, by key. */
export type CameraTake = Record<string, string | number>;

export interface MockFeeder {
    id: string;
    match: string;
    /** The first part's place; null for a feeder on the bus whose slot is found when a run starts. */
    at: [number, number, number] | null;
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
    /** How far from the up camera's center its parts are looked for, mm; null takes the profile's. */
    crop: number | null;
    /** The parts it holds by reference, which outdo the words. */
    refs: string[];
    /** On the bus: its id there, its address (null until found), its place from the slot's, and its advance per part, mm. */
    bus_id: string | null;
    slot: number | null;
    offset: [number, number, number];
    advance: number;
}

/** How packets reach the feeders on a bus, as the backend's BusProfile has it. */
export interface MockBus {
    send: string;
    reply: string;
    header: string[];
    host: number;
    broadcast: number;
    tries: number;
    max_address: number;
    poll_ms: number;
    codes: Record<string, number>;
}

/** Where the feeder at a bus address presents its part. */
export interface MockSlot {
    address: number;
    at: [number, number, number];
    rotation: number;
}

export const BUS_DEFAULTS: MockBus = {
    send: "M485 {packet}",
    reply: "rs485-reply: *(?P<packet>[0-9A-Fa-f]*)",
    header: [...HEADER_FIELDS],
    host: 0,
    broadcast: 255,
    tries: 3,
    max_address: 32,
    poll_ms: 50,
    codes: { get_id: 0x01, init: 0x02, feed: 0x04, status: 0x06, find: 0xc0, ok: 0x00, wrong_id: 0x01, unreachable: 0x02, uninitialized: 0x03, busy: 0x04 },
};

export interface MockVacuum {
    /** The lines that read it: the reading is in the last one's answer. */
    read: string[];
    /** As the backend keeps it: Python's (?P<name>...) for a named group. */
    pattern: string;
    /** The readings with a part held and with the nozzle empty; a sensor with neither is read by hand only. */
    part_on: [number, number] | null;
    part_off: [number, number] | null;
}

export interface MockTopProfile {
    z: number | null;
    offset: [number, number] | null;
    /** The picture's turn as mounted, degrees, until Measure offset measures it; null: none given. */
    roll: number | null;
    /** The picture's scale as designed, mm a pixel at the camera's size; null: none given. */
    mm_per_px: number | null;
    /** Where boards lie, as the places the picture's center goes over (x0, y0, x1, y1); null: none given. */
    bed: [number, number, number, number] | null;
    /** Where a board is expected, in the frame of `bed` and inside it; null: none given, the whole bed. */
    board_area: [number, number, number, number] | null;
    /** Boards are only ever placed inside the board area (true), or only near it (false: a search looks there first). */
    board_area_only: boolean;
    fiducial: SpotPolarity;
    within: number;
    /** A fiducial on the bed, as the nozzle's place over it: Home by fiducial finds it. */
    home_fiducial: [number, number] | null;
    /** The camera's own settings the file names, put into it as the machine connects. */
    settings: CameraTake;
    /** The part of the picture each task looks in ([top_camera.crops]); a task left out, the whole picture. */
    crops: Record<string, CropBox>;
}

export interface MockDevice {
    id: string;
    name: string;
    description: string;
    url: string;
    /** Words in a port's USB names that make it this machine's. */
    match: string[];
    baud: number;
    wait_ms: number;
    timeout: number;
    init: string[];
    end: string[];
    move: string;
    axes: [string, string, string, string];
    wait: string;
    /** The vacuum on (a pump and a valve may take a line each) and off. */
    pick: string[];
    place: string[];
    dwell: string;
    home: string;
    position: string;
    stop: string;
    /** The motors switched on and off by the jog panel; empty for no button. */
    motors_on: string;
    motors_off: string;
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
    /** One Z motor drives two nozzles, both up only at the safe height (true): moves across come to it from either side, Z jogs stop at it; a plain Z (false); not said (null): moves across from either side, jogs go where sent. */
    seesaw: boolean | null;
    /** How far the head's travel along Y leans toward +X, mm of X per mm of Y: a controller that does not take it out puts a head sent to X Y at X + skew * Y. */
    skew: number;
    /** Who takes the skew out: the link (X less skew * Y out, plus it in) or the firmware, told by skew_line. */
    skew_by: (typeof SKEW_BY)[number];
    /** The line that tells the firmware the skew, {skew} for the factor; empty for a firmware built with it. */
    skew_line: string;
    discard: [number, number, number] | null;
    pick_tries: number;
    vacuum: MockVacuum | null;
    max_offset: number;
    max_turn: number;
    size_tolerance: number;
    top: MockTopProfile | null;
    /** The lights the cameras need, on and off. */
    light_on: string[];
    light_off: string[];
    /** Where the up camera is as designed: the head with the nozzle over its picture's center. */
    camera_position: [number, number] | null;
    /** How the up camera's picture lies as mounted, until centering measures it: its roll and whether it is mirrored; null leaves the measured one. */
    camera_roll: number | null;
    camera_mirror: boolean | null;
    /** The up camera's own settings the file names, put into it as the machine connects. */
    camera_settings: CameraTake;
    /** The part of the up camera's picture each task looks in ([up_camera.crops]). */
    camera_crops: Record<string, CropBox>;
    /** A jog taking the nozzle from within this many mm of the up camera to farther, off the safe height, rises first; null never. */
    leave: number | null;
    /** Where the head waits out of the way. */
    park: [number, number] | null;
    /** How far the head reaches, as places of the nozzle (x0, y0, x1, y1); null: not said. */
    travel: [number, number, number, number] | null;
    /** How far from the up camera's center a part is looked for, mm; null: as far as pcbv does. */
    crop: number | null;
    /** Classes of parts by size, each with its own crop. */
    classes: PartClass[];
    /** The bus smart feeders are on, and where each address's feeder sits. */
    bus: MockBus | null;
    slots: MockSlot[];
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

    /** A camera's own settings the table names, of `keys`, each checked as the camera's settings check it. */
    camera(table: TomlTable, section: string, keys: readonly string[]): CameraTake {
        const taken: CameraTake = {};
        for (const key of keys) {
            if (!(key in table)) {
                continue;
            }
            if (key === "device" || key === "pcbv") {
                const value = this.text(table, key, section, "");
                if (!value) {
                    throw this.fail(section, key, "must name it");
                }
                taken[key] = value;
            } else if (key === "size") {
                const value = this.text(table, key, section, "");
                if (!CAPTURE_SIZE.test(value)) {
                    throw this.fail(section, key, "must be WIDTHxHEIGHT");
                }
                taken[key] = value;
            } else if (key === "fps") {
                taken[key] = this.integer(table, key, section, 30, 1, 120);
            } else {
                taken[key] = this.shade(table, key, section, "dark");
            }
        }
        return taken;
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

    /** A box x0, y0, x1, y1 with x0 below x1 and y0 below y1, or null when left out. */
    box(table: TomlTable, key: string, section: string): [number, number, number, number] | null {
        if (!(key in table)) {
            return null;
        }
        const [x0, y0, x1, y1] = this.point(table, key, section, 4, null) as [number, number, number, number];
        if (!(x0 < x1 && y0 < y1)) {
            throw this.fail(section, key, "must be x0, y0, x1, y1 with x0 below x1 and y0 below y1");
        }
        return [x0, y0, x1, y1];
    }

    /** A camera's crops by task, its `crops` table, as the backend reads them (crops.ts). */
    crops(table: TomlTable, section: string, tasks: readonly string[]): Record<string, CropBox> {
        if (!("crops" in table)) {
            return {};
        }
        const value = table.crops;
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            throw this.fail(section, "crops", `must be a table [${section}.crops] of tasks: ${tasks.join(", ")}`);
        }
        try {
            return checkTasks(value, tasks);
        } catch (error) {
            throw new Error(`${this.where}: [${section}.crops] ${errorText(error)}`);
        }
    }

    done(table: TomlTable, section: string | null, known: string[]): void {
        const unknown = Object.keys(table).filter((key) => !known.includes(key)).sort();
        if (unknown.length > 0) {
            throw this.fail(section, unknown[0]!, "is not a key here");
        }
    }
}

/**
 * A G-code machine's own tables, read off its machine file (the TOML read
 * whole by the machine file's reader, which checked its top level, name,
 * description and controls), as the backend's openpnp.machine_of reads
 * them; throws with its words.
 */
export function parseGcodeTables(top: TomlTable, id: string, name: string, description: string): MockDevice {
    const where = `${id}.toml`;
    const read = new Reader(where);
    const port = read.table(top, "port");
    const baud = read.integer(port, "baud", "port", 115200, 1200, 2000000);
    if (!BAUDS.includes(baud)) {
        throw read.fail("port", "baud", `must be one of ${BAUDS.join(", ")}`);
    }
    const device: Partial<MockDevice> = {
        id,
        name: name || id,
        description,
        url: read.text(port, "url", "port", ""),
        match: read.lines(port, "match", "port", [], true),
        baud,
        wait_ms: read.integer(port, "wait_ms", "port", 2000, 0, 30000),
        timeout: read.number(port, "timeout", "port", 60, 1, 600),
    };
    read.done(port, "port", ["url", "match", "baud", "wait_ms", "timeout"]);
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
    device.pick = read.lines(gcode, "pick", "gcode", ["M106"], true);
    device.place = read.lines(gcode, "place", "gcode", ["M107"], true);
    if (device.pick.length === 0 || device.place.length === 0) {
        throw read.fail("gcode", device.pick.length === 0 ? "pick" : "place", "must name the vacuum's command");
    }
    device.light_on = read.lines(gcode, "light_on", "gcode", [], true);
    device.light_off = read.lines(gcode, "light_off", "gcode", [], true);
    device.dwell = read.text(gcode, "dwell", "gcode", "G4 P{ms}");
    if (device.dwell && !device.dwell.includes("{ms}") && !device.dwell.includes("{s}")) {
        throw read.fail("gcode", "dwell", "must hold {ms} or {s} for the time, or be empty for none");
    }
    device.home = read.text(gcode, "home", "gcode", "G28");
    device.position = read.text(gcode, "position", "gcode", "M114");
    device.stop = read.text(gcode, "stop", "gcode", "M410");
    device.motors_on = read.text(gcode, "motors_on", "gcode", "M17");
    device.motors_off = read.text(gcode, "motors_off", "gcode", "M18");
    device.rotation_cw = read.flag(gcode, "rotation_cw", "gcode", false);
    device.skew_line = read.text(gcode, "skew", "gcode", "M852 I{skew}");
    if (device.skew_line && !device.skew_line.includes("{skew}")) {
        throw read.fail("gcode", "skew", "must hold {skew} for the factor, or be empty for a firmware built with it");
    }
    read.done(gcode, "gcode", [
        "init", "end", "move", "x", "y", "z", "rotation", "rotation_cw", "wait", "pick", "place", "dwell", "home", "position", "stop",
        "motors_on", "motors_off", "light_on", "light_off", "skew",
    ]);
    const motion = read.table(top, "motion");
    device.feed_xy = read.number(motion, "feed_xy", "motion", 6000, 1, FEED_LIMIT);
    device.feed_z = read.number(motion, "feed_z", "motion", 1200, 1, FEED_LIMIT);
    device.safe_z = read.number(motion, "safe_z", "motion", null);
    device.place_z = read.number(motion, "place_z", "motion", null);
    device.pick_dwell_ms = read.integer(motion, "pick_dwell_ms", "motion", 200, 0, 60000);
    device.place_dwell_ms = read.integer(motion, "place_dwell_ms", "motion", 150, 0, 60000);
    device.discard = "discard" in motion ? (read.point(motion, "discard", "motion", 3, null) as [number, number, number]) : null;
    device.pick_tries = read.integer(motion, "pick_tries", "motion", 3, 1, 20);
    device.park = "park" in motion ? (read.point(motion, "park", "motion", 2, null) as [number, number]) : null;
    device.seesaw = "seesaw" in motion ? read.flag(motion, "seesaw", "motion", false) : null;
    device.travel = read.box(motion, "travel", "motion");
    const skew = motion["skew"] ?? 0;
    if (typeof skew !== "number" || !Number.isFinite(skew) || Math.abs(skew) > SKEW_LIMIT) {
        throw read.fail("motion", "skew", `must be a number from ${-SKEW_LIMIT} to ${SKEW_LIMIT}: mm of X per mm of Y, the tangent of the angle (0.13 degrees is 0.0023)`);
    }
    device.skew = skew;
    const skewBy = motion["skew_by"] ?? "link";
    if (!(SKEW_BY as readonly unknown[]).includes(skewBy)) {
        throw read.fail("motion", "skew_by", 'must be "link" (this backend takes the skew out) or "firmware" (the controller does)');
    }
    device.skew_by = skewBy as MockDevice["skew_by"];
    read.done(motion, "motion", [
        "feed_xy", "feed_z", "safe_z", "place_z", "pick_dwell_ms", "place_dwell_ms", "discard", "pick_tries", "park", "seesaw", "travel", "skew", "skew_by",
    ]);
    device.vacuum = null;
    const sensor = read.table(top, "vacuum");
    if (Object.keys(sensor).length > 0) {
        const readLines = read.lines(sensor, "read", "vacuum", [], true);
        if (readLines.length === 0) {
            throw read.fail("vacuum", "read", "must name the line, or lines, that read the vacuum sensor");
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
        device.vacuum = { read: readLines, pattern, part_on: read.span(sensor, "part_on", "vacuum"), part_off: read.span(sensor, "part_off", "vacuum") };
        read.done(sensor, "vacuum", ["read", "pattern", "part_on", "part_off"]);
    }
    device.top = null;
    const looking = read.table(top, "top_camera");
    if (Object.keys(looking).length > 0) {
        const bed = "bed" in looking ? (read.point(looking, "bed", "top_camera", 4, null) as [number, number, number, number]) : null;
        const area = read.box(looking, "board_area", "top_camera");
        if (area !== null && bed !== null) {
            const [lowX, highX] = [Math.min(bed[0], bed[2]), Math.max(bed[0], bed[2])];
            const [lowY, highY] = [Math.min(bed[1], bed[3]), Math.max(bed[1], bed[3])];
            if (!(lowX <= area[0] && area[2] <= highX && lowY <= area[1] && area[3] <= highY)) {
                throw read.fail("top_camera", "board_area", "must lie inside bed");
            }
        }
        device.top = {
            z: "z" in looking ? read.number(looking, "z", "top_camera", null) : null,
            offset: "offset" in looking ? (read.point(looking, "offset", "top_camera", 2, null) as [number, number]) : null,
            roll: "roll" in looking ? read.number(looking, "roll", "top_camera", null, -360, 360) : null,
            mm_per_px: "mm_per_px" in looking ? read.number(looking, "mm_per_px", "top_camera", null, 1e-4, 1) : null,
            bed,
            board_area: area,
            board_area_only: read.flag(looking, "board_area_only", "top_camera", false),
            fiducial: read.shade(looking, "fiducial", "top_camera", "bright"),
            within: read.number(looking, "within", "top_camera", 2, 0.1, 50),
            home_fiducial: "home_fiducial" in looking ? (read.point(looking, "home_fiducial", "top_camera", 2, null) as [number, number]) : null,
            settings: read.camera(looking, "top_camera", TOP_CAMERA_SETTINGS),
            crops: read.crops(looking, "top_camera", TOP_TASKS),
        };
        read.done(looking, "top_camera", ["z", "offset", "roll", "mm_per_px", "bed", "board_area", "board_area_only", "fiducial", "within", "home_fiducial", "crops", ...TOP_CAMERA_SETTINGS]);
    }
    device.bus = null;
    const wire = read.table(top, "bus");
    if (Object.keys(wire).length > 0) {
        const header = read.lines(wire, "header", "bus", [...HEADER_FIELDS]);
        if (header.length === 0 || new Set(header).size !== header.length || header.some((name) => !HEADER_FIELDS.includes(name))) {
            throw read.fail("bus", "header", `must name each of its bytes once, from ${HEADER_FIELDS.join(", ")}`);
        }
        const send = read.text(wire, "send", "bus", BUS_DEFAULTS.send);
        if (!send.includes("{packet}")) {
            throw read.fail("bus", "send", "must hold {packet}, where the packet's hex goes");
        }
        const reply = read.text(wire, "reply", "bus", BUS_DEFAULTS.reply, false).replace(JAVA_GROUP, "(?P<");
        let groups: number;
        try {
            groups = new RegExp(`${jsPattern(reply)}|`).exec("")!.length - 1;
        } catch (error) {
            throw read.fail("bus", "reply", `is not a regular expression: ${errorText(error)}`);
        }
        if (groups < 1) {
            throw read.fail("bus", "reply", "must hold a group, ( ), around the answer's hex");
        }
        const codes: Record<string, number> = {};
        for (const name of Object.keys(BUS_DEFAULTS.codes)) {
            codes[name] = read.integer(wire, name, "bus", BUS_DEFAULTS.codes[name]!, 0, 255);
        }
        device.bus = {
            send,
            reply,
            header,
            host: read.integer(wire, "host", "bus", BUS_DEFAULTS.host, 0, 255),
            broadcast: read.integer(wire, "broadcast", "bus", BUS_DEFAULTS.broadcast, 0, 255),
            tries: read.integer(wire, "tries", "bus", BUS_DEFAULTS.tries, 1, 10),
            max_address: read.integer(wire, "max_address", "bus", BUS_DEFAULTS.max_address, 1, 254),
            poll_ms: read.integer(wire, "poll_ms", "bus", BUS_DEFAULTS.poll_ms, 10, 5000),
            codes,
        };
        read.done(wire, "bus", ["send", "reply", "header", "host", "broadcast", "tries", "max_address", "poll_ms", ...Object.keys(BUS_DEFAULTS.codes)]);
    }
    const slotTables = top["slot"] ?? [];
    if (!Array.isArray(slotTables) || !slotTables.every((item) => typeof item === "object" && item !== null && !Array.isArray(item))) {
        throw read.fail(null, "slot", "must be an array of tables ([[slot]])");
    }
    const slots: MockSlot[] = [];
    (slotTables as TomlTable[]).forEach((table, offset) => {
        const section = `slot ${offset + 1}`;
        if (device.bus === null) {
            throw read.fail(section, "address", "is a feeder bus's slot: add a [bus] table");
        }
        const address = read.integer(table, "address", section, 0, 1, 254);
        if (slots.some((other) => other.address === address)) {
            throw read.fail(section, "address", `${address} is another slot's too`);
        }
        slots.push({ address, at: read.point(table, "at", section, 3, null) as [number, number, number], rotation: read.number(table, "rotation", section, 0, -360, 360) });
        read.done(table, section, ["address", "at", "rotation"]);
    });
    device.slots = slots;
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
        const refs = read.lines(table, "refs", section, []);
        if (!match && refs.length === 0) {
            throw read.fail(section, "match", "must hold the words of a part's value or footprint (or give refs)");
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
            throw read.fail(section, pocket !== null ? "pocket" : "marks", "looks with the top camera: add a [top_camera] table");
        }
        let rotation = read.number(table, "rotation", section, 0, -360, 360);
        let busId: string | null = null;
        let slot: number | null = null;
        let busOffset: [number, number, number] = [0, 0, 0];
        let advance = 4;
        let at: [number, number, number] | null;
        if ("bus_id" in table) {
            if (device.bus === null) {
                throw read.fail(section, "bus_id", "is a feeder on the bus: add a [bus] table");
            }
            const id = read.text(table, "bus_id", section, "").toUpperCase();
            if (!/^[0-9A-F]{24}$/.test(id)) {
                throw read.fail(section, "bus_id", `must be the feeder's id: a feeder's id is 24 hex digits, not '${read.text(table, "bus_id", section, "")}'`);
            }
            busId = id;
            if ("at" in table || count > 0 || columns > 0) {
                throw read.fail(section, "at" in table ? "at" : "count", "is not for a feeder on the bus: its slot gives its place, and it presents every part there");
            }
            if ("slot" in table) {
                slot = read.integer(table, "slot", section, 0, 1, 254);
                if (!slots.some((entry) => entry.address === slot)) {
                    throw read.fail(section, "slot", `${slot} has no [[slot]] with its place`);
                }
            }
            busOffset = read.point(table, "offset", section, 3, [0, 0, 0]) as [number, number, number];
            advance = read.number(table, "advance", section, 4, 0.1, 25.5);
            const placed = slots.find((entry) => entry.address === slot);
            at = placed ? slotPlace(placed.at, placed.rotation, busOffset) : null;
            rotation += placed ? placed.rotation : 0;
        } else {
            for (const key of ["slot", "offset", "advance"]) {
                if (key in table) {
                    throw read.fail(section, key, "is for a feeder on the bus: give its bus_id");
                }
            }
            at = read.point(table, "at", section, 3, null) as [number, number, number];
        }
        feeders.push({
            id: feederId,
            match,
            at,
            pitch: read.point(table, "pitch", section, 2, [0, 0]) as [number, number],
            count,
            columns,
            row_pitch: read.point(table, "row_pitch", section, 2, [0, 0]) as [number, number],
            rotation,
            place_z: placeZ,
            feed: read.lines(table, "feed", section, [], true),
            vision: read.flag(table, "vision", section, false),
            size,
            pocket,
            marks,
            mark: read.shade(table, "mark", section, "dark"),
            crop: "crop" in table ? read.number(table, "crop", section, null, 0.1, 100) : null,
            refs,
            bus_id: busId,
            slot,
            offset: busOffset,
            advance,
        });
        read.done(table, section, [
            "id", "match", "refs", "at", "pitch", "count", "columns", "row_pitch", "rotation", "place_z", "feed", "vision", "size",
            "pocket", "marks", "mark", "crop", "bus_id", "slot", "offset", "advance",
        ]);
    });
    device.feeders = feeders;
    const classTables = top["part_class"] ?? [];
    if (!Array.isArray(classTables) || !classTables.every((item) => typeof item === "object" && item !== null && !Array.isArray(item))) {
        throw read.fail(null, "part_class", "must be an array of tables ([[part_class]])");
    }
    const classes: PartClass[] = [];
    (classTables as TomlTable[]).forEach((table, at) => {
        const section = `part_class ${at + 1}`;
        const name = read.text(table, "name", section, "");
        if (name === "") {
            throw read.fail(section, "name", "must name the class, as 0402 or SOT-23");
        }
        if (classes.some((other) => other.name === name)) {
            throw read.fail(section, "name", `'${name}' is another class's too`);
        }
        const match = read.text(table, "match", section, "");
        if (match === "") {
            throw read.fail(section, "match", "must hold the words of a part's value or footprint, as 0402 or SOT-23");
        }
        if (!("crop" in table)) {
            throw read.fail(section, "crop", "must say how far from the picture's center its parts are looked for, mm");
        }
        classes.push({ name, match, crop: read.number(table, "crop", section, null, 0.1, 100)! });
        read.done(table, section, ["name", "match", "crop"]);
    });
    device.classes = classes;
    const camera = read.table(top, "up_camera");
    device.camera_z = "z" in camera ? read.number(camera, "z", "up_camera", null) : null;
    device.camera_position = "position" in camera ? (read.point(camera, "position", "up_camera", 2, null) as [number, number]) : null;
    device.crop = "crop" in camera ? read.number(camera, "crop", "up_camera", null, 0.1, 100) : null;
    device.max_offset = read.number(camera, "max_offset", "up_camera", 1, 0.01, 20);
    device.max_turn = read.number(camera, "max_turn", "up_camera", 15, 0.1, 45);
    device.size_tolerance = read.number(camera, "size_tolerance", "up_camera", 0.3, 0, 1);
    device.leave = "leave" in camera ? read.number(camera, "leave", "up_camera", null, 0, 1000) : null;
    device.camera_roll = "roll" in camera ? read.number(camera, "roll", "up_camera", null, -360, 360) : null;
    device.camera_mirror = "mirror" in camera ? read.flag(camera, "mirror", "up_camera", true) : null;
    device.camera_settings = read.camera(camera, "up_camera", UP_CAMERA_SETTINGS);
    device.camera_crops = read.crops(camera, "up_camera", UP_TASKS);
    read.done(camera, "up_camera", ["z", "position", "crop", "crops", "max_offset", "max_turn", "size_tolerance", "leave", "roll", "mirror", ...UP_CAMERA_SETTINGS]);
    return device as MockDevice;
}

/** Crops by task, each box copied. */
function cropsCopy(crops: Record<string, CropBox>): Record<string, CropBox> {
    return Object.fromEntries(Object.entries(crops).map(([task, box]) => [task, [...box] as CropBox]));
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
export function deviceDocument(device: MockDevice): GcodeDocument {
    return {
        id: device.id,
        name: device.name,
        description: device.description,
        url: device.url,
        match: [...device.match],
        baud: device.baud,
        wait_ms: device.wait_ms,
        timeout: device.timeout,
        axes: [...device.axes],
        rotation_cw: device.rotation_cw,
        seesaw: device.seesaw,
        skew: device.skew,
        skew_by: device.skew_by,
        feed_xy: device.feed_xy,
        feed_z: device.feed_z,
        safe_z: device.safe_z,
        place_z: device.place_z,
        pick_dwell_ms: device.pick_dwell_ms,
        place_dwell_ms: device.place_dwell_ms,
        park: device.park ? [...device.park] : null,
        travel: device.travel ? [...device.travel] : null,
        camera_position: device.camera_position ? [...device.camera_position] : null,
        camera_roll: device.camera_roll,
        camera_mirror: device.camera_mirror,
        camera_settings: { ...device.camera_settings },
        camera_crops: cropsCopy(device.camera_crops),
        light: device.light_on.length > 0,
        discard: device.discard ? [...device.discard] : null,
        pick_tries: device.pick_tries,
        camera_z: device.camera_z,
        leave: device.leave,
        crop: device.crop,
        classes: device.classes.map((entry) => ({ ...entry })),
        bus: device.bus !== null,
        slots: device.slots.map((slot) => ({ address: slot.address, at: [...slot.at], rotation: slot.rotation })),
        max_offset: device.max_offset,
        max_turn: device.max_turn,
        size_tolerance: device.size_tolerance,
        vacuum: device.vacuum
            ? {
                read: [...device.vacuum.read],
                pattern: device.vacuum.pattern,
                part_on: device.vacuum.part_on ? [...device.vacuum.part_on] : null,
                part_off: device.vacuum.part_off ? [...device.vacuum.part_off] : null,
            }
            : null,
        top: device.top
            ? {
                z: device.top.z,
                offset: device.top.offset ? [...device.top.offset] : null,
                roll: device.top.roll,
                mm_per_px: device.top.mm_per_px,
                bed: device.top.bed ? [...device.top.bed] : null,
                board_area: device.top.board_area ? [...device.top.board_area] : null,
                board_area_only: device.top.board_area_only,
                fiducial: device.top.fiducial,
                within: device.top.within,
                home_fiducial: device.top.home_fiducial ? [...device.top.home_fiducial] : null,
                settings: { ...device.top.settings },
                crops: cropsCopy(device.top.crops),
            }
            : null,
        feeders: device.feeders.map((f) => ({
            id: f.id,
            match: f.match,
            at: f.at ? [...f.at] : null,
            pitch: [...f.pitch],
            count: f.count,
            columns: f.columns,
            rotation: f.rotation,
            vision: f.vision,
            size: f.size ? [...f.size] : null,
            pocket: f.pocket,
            marks: f.marks.map((mark) => [mark[0], mark[1]]),
            mark: f.mark,
            crop: f.crop,
            refs: [...f.refs],
            bus_id: f.bus_id,
            slot: f.slot,
            advance: f.advance,
        })),
    };
}

/** Where a feeder's part `index` is: along a strip, or row by row in a tray. */
export function feederPlace(feeder: MockFeeder, index: number): [number, number, number] {
    if (feeder.at === null) {
        throw new Error(`feeder ${feeder.id}'s place is not known: its slot is found on the feeder bus when a run starts`);
    }
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
/** The feeder a part comes from: the first that names it among its refs, else the first whose words its value and footprint hold. */
export function feederFor<T extends { match: string; refs?: string[] }>(feeders: T[], value: string, footprint: string, ref = ""): T | null {
    const named = feeders.find((feeder) => (feeder.refs?.length ?? 0) > 0 && feeder.refs!.includes(ref));
    if (named) {
        return named;
    }
    const hay = `${value} ${footprint}`.toLowerCase();
    return feeders.find((feeder) => (feeder.refs?.length ?? 0) === 0 && feeder.match.toLowerCase().split(/\s+/).filter((word) => word !== "").every((word) => hay.includes(word))) ?? null;
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

/** Where the board lies on the machine, from reference parts: a shift (and a typed turn) from one, a turn and a shift from more. */
export function deviceFit(pairs: [[number, number], [number, number]][], angle: number | null): AlignFit {
    if (pairs.length === 0) {
        throw new Error("the board has no reference on the machine: put the nozzle over a part's place and press Here");
    }
    const fit = fitRigid(pairs.map(([design, machine]) => ({ design, machine })), pairs.length === 1 ? angle ?? 0 : null);
    return { ...fit, marks: pairs.length };
}

export const VISION_NOTE = "; looked at over the bottom camera: placed where its center lands";
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
    /** The part's angle on the machine. */
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
export function planSummary(plan: MockPlan): PlacingPlan {
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

/** The skew the backend takes out itself: the file's when its link does it, 0 when the firmware does. The backend's GcodeMachine.link_skew. */
export function linkSkew(device: MockDevice): number {
    return device.skew_by === "link" ? device.skew : 0;
}

/** A place of the nozzle as the controller's numbers: X less the link's skew times Y. */
export function toController(device: MockDevice, x: number, y: number): [number, number] {
    return [x - linkSkew(device) * y, y];
}

/** The controller's numbers as a place of the nozzle: toController undone. */
export function fromController(device: MockDevice, x: number, y: number): [number, number] {
    return [x + linkSkew(device) * y, y];
}

/** The file's skew line with `factor` in it; empty when the file has none. */
export function skewCommand(device: MockDevice, factor: number): string {
    return device.skew_line ? device.skew_line.replace("{skew}", gnum(factor, SKEW_DECIMALS)) : "";
}

/** The line that tells the firmware the file's skew, when the firmware takes it out and the file gives one: openpnp.skew_lines. */
export function skewLines(device: MockDevice): string[] {
    const line = device.skew_by === "firmware" ? skewCommand(device, device.skew) : "";
    return line ? [line] : [];
}

/** The line of a reply saying its command is unknown to the firmware (Marlin's `echo:Unknown command`); null when none does. */
export function unknownIn(reply: string[]): string | null {
    return reply.find((line) => /unknown command/i.test(line)) ?? null;
}

/** The head moved across to `x`, `y` (the controller's numbers, the link's skew taken out), the nozzle turned to `turn` on the way when one is given, at the feed across. */
export function xyLine(device: MockDevice, x: number, y: number, turn?: number): string {
    const angle = turn === undefined ? "" : ` ${angleWord(device, turn)}`;
    const [cx, cy] = toController(device, x, y);
    return `${device.move} ${device.axes[0]}${gnum(cx)} ${device.axes[1]}${gnum(cy)}${angle} F${gnum(device.feed_xy, 0)}`;
}

/** The nozzle up to the safe height. */
export function safeLine(device: MockDevice): string {
    return zLine(device, device.safe_z);
}

/**
 * Whether a nozzle at height `z` goes to the safe height before a move
 * across: unknown, below it, or on a seesaw Z above it too; on a Z that
 * grows upward one at or above it stays. The backend's openpnp.needs_lift.
 */
export function needsLift(device: MockDevice, z: number | undefined | null): boolean {
    if (z === undefined || z === null) {
        return true;
    }
    // A seesaw, or a Z the file does not say (null): from either side.
    return device.seesaw !== false ? Math.abs(z - device.safe_z) > 1e-6 : z < device.safe_z - 1e-6;
}

/**
 * Where a seesaw's Z jog from `z` toward `target` ends: at the safe height
 * when it would pass it, and no higher from it; elsewhere, or on a Z that
 * grows upward, the target. The backend's openpnp.seesaw_jog.
 */
export function seesawJog(device: MockDevice, z: number, target: number): number {
    const safe = device.safe_z;
    if (device.seesaw !== true) {
        return target;
    }
    if (Math.abs(z - safe) <= 1e-6) {
        return target > safe ? safe : target;
    }
    return (z - safe) * (target - safe) < 0 ? safe : target;
}

/**
 * Whether a jog from `here` to `target` goes up to the safe height first:
 * the file asks for it ([up_camera] leave), the up camera's place is
 * known, the nozzle is lower than the safe height (off it on a seesaw)
 * within `leave` mm of that place, and the jog ends farther than that.
 * The backend's openpnp.lifts_leaving.
 */
export function liftsLeaving(device: MockDevice, here: Partial<Record<AxisName, number>>, target: Partial<Record<AxisName, number>>, camera: [number, number] | null): boolean {
    if (device.leave === null || camera === null || (target.x === undefined && target.y === undefined)) {
        return false;
    }
    const z = here.z;
    if (z === undefined || !needsLift(device, z) || target.z !== undefined || here.x === undefined || here.y === undefined) {
        return false;
    }
    const start = Math.hypot(here.x - camera[0], here.y - camera[1]);
    const end = Math.hypot((target.x ?? here.x) - camera[0], (target.y ?? here.y) - camera[1]);
    return start <= device.leave + 1e-9 && end > device.leave + 1e-9;
}

/** A G-code machine's axes by the names its place is kept under. */
export type AxisName = "x" | "y" | "z" | "rotation";
const AXIS_NAMES: AxisName[] = ["x", "y", "z", "rotation"];

/**
 * `target` with X and Y as the controller's numbers: on a machine whose
 * link takes a skew out X carries Y too, so a move naming either names
 * both, the one left out staying where `here` has it. The backend's
 * openpnp.controller_target.
 */
export function controllerTarget(device: MockDevice, target: Partial<Record<AxisName, number>>, here: Partial<Record<AxisName, number>> | null = null): Partial<Record<AxisName, number>> {
    if (linkSkew(device) === 0 || (target.x === undefined && target.y === undefined)) {
        return { ...target };
    }
    const x = target.x ?? here?.x;
    const y = target.y ?? here?.y;
    if (x === undefined || y === undefined) {
        throw new Error("the axes are skewed: a move across needs the head's X and Y, so read its place first");
    }
    const [cx, cy] = toController(device, x, y);
    return { ...target, x: cx, y: cy };
}

/**
 * One move to `target` (x, y and z, the rotation as the controller counts
 * it, not turned for rotation_cw), X and Y as the controller's numbers
 * (`here` filling in the one left out on skewed axes), at `feed`, else at
 * the Z feed for a height alone and the X/Y feed for anything else: the
 * backend's openpnp.move_line.
 */
export function moveLine(device: MockDevice, target: Partial<Record<AxisName, number>>, feed: number | null = null, here: Partial<Record<AxisName, number>> | null = null): string {
    target = controllerTarget(device, target, here);
    const words = [device.move];
    AXIS_NAMES.forEach((name, index) => {
        const value = target[name];
        if (value !== undefined) {
            words.push(`${device.axes[index]}${gnum(value)}`);
        }
    });
    const names = Object.keys(target);
    const rate = feed ?? (names.length === 1 && names[0] === "z" ? device.feed_z : device.feed_xy);
    words.push(`F${gnum(rate, 0)}`);
    return words.join(" ");
}

/**
 * The lines that take the head from `here` to `want`: to the safe height
 * only for a move across (X or Y changing), and only from below it (from
 * either side on a seesaw), the turn with the move across, the height last
 * and only when it changes. The backend's openpnp.goto_lines.
 */
export function gotoLines(device: MockDevice, here: Partial<Record<AxisName, number>>, want: Partial<Record<AxisName, number>>, feed: number | null = null): string[] {
    const across: Partial<Record<AxisName, number>> = {};
    for (const name of ["x", "y"] as const) {
        const value = want[name];
        const now = here[name];
        if (value !== undefined && (now === undefined || Math.abs(value - now) > 1e-6)) {
            across[name] = value;
        }
    }
    const lines: string[] = [];
    let z = here.z;
    if (Object.keys(across).length > 0) {
        if (needsLift(device, z)) {
            lines.push(safeLine(device));
            z = device.safe_z;
        }
        lines.push(moveLine(device, want.rotation !== undefined ? { ...across, rotation: want.rotation } : across, feed, here));
    } else if (want.rotation !== undefined) {
        lines.push(moveLine(device, { rotation: want.rotation }, feed));
    }
    if (want.z !== undefined && (z === undefined || Math.abs(want.z - z) > 1e-6)) {
        lines.push(moveLine(device, { z: want.z }));
    }
    return lines;
}

/** How far the head moves to keep the nozzle's tip on a point as the nozzle turns from 0 to `degrees`, the tip `runout` off the axis at 0. */
/**
 * The G92 that declares the head at `given` (x and y places of the nozzle,
 * z, the rotation as the controller counts it), X and Y as the controller's
 * numbers; on skewed axes the controller's X holds Y too, so X and Y go
 * together. The backend's openpnp.declare_line.
 */
export function declareLine(device: MockDevice, given: Partial<Record<AxisName, number>>): string {
    const values = { ...given };
    if (linkSkew(device) !== 0 && (values.x !== undefined || values.y !== undefined)) {
        if (values.x === undefined || values.y === undefined) {
            throw new Error("the axes are skewed: declare X and Y together");
        }
        [values.x, values.y] = toController(device, values.x, values.y);
    }
    const words = AXIS_NAMES.flatMap((name, index) => {
        const value = values[name];
        return value === undefined ? [] : [`${device.axes[index]}${gnum(value)}`];
    });
    return `G92 ${words.join(" ")}`;
}

export function tipShift(runout: [number, number], degrees: number): [number, number] {
    const [sx, sy] = turnPoint(runout, degrees);
    return [runout[0] - sx, runout[1] - sy];
}

/** The lines that take a part from its pocket: which, the feeder's own lines, up, over it turned to 0, down, the vacuum on, and back up. */
export function pickLines(device: MockDevice, feeder: MockFeeder, label: string, point: [number, number, number]): string[] {
    const advance = feeder.bus_id !== null ? [`; ${feeder.id} advances ${gnum(feeder.advance)} mm on the feeder bus`] : [];
    return [
        `; ${label}`.trimEnd(),
        ...advance,
        ...feeder.feed,
        safeLine(device),
        xyLine(device, point[0], point[1], 0),
        zLine(device, point[2]),
        ...(device.wait ? [device.wait] : []),
        ...device.pick,
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
    const first = vacuum.read.slice(0, -1);
    const last = vacuum.read[vacuum.read.length - 1]!;
    return [...(device.wait ? [device.wait] : []), ...first, `${last} ; vacuum: ${held ? "a part held" : "an empty nozzle"} reads ${gnum(span[0])} to ${gnum(span[1])}`];
}

/** The lines that put a held part down: across at the safe height, turned to its angle, down, the vacuum off, and back up. */
export function placeLines(device: MockDevice, point: [number, number], turn: number, placeZ: number): string[] {
    return [
        xyLine(device, point[0], point[1], turn),
        zLine(device, placeZ),
        ...(device.wait ? [device.wait] : []),
        ...device.place,
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
        if (part.filtered) {
            skipped.push({ ref: part.ref, reason: "left out by the parts filter" });
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
        const feeder = feederFor(device.feeders, part.value, part.footprint, part.ref);
        // Kept out of the position files: placed only when asked for by name, or named by its feeder.
        if (part.exclude_from_pos_files && wanted === null && !(feeder?.refs ?? []).includes(part.ref)) {
            skipped.push({ ref: part.ref, reason: "kept out of the position files: pick it to place it" });
            continue;
        }
        if (!feeder) {
            skipped.push({ ref: part.ref, reason: "no feeder holds it" });
            continue;
        }
        if (feeder.vision && !visionReady) {
            skipped.push({ ref: part.ref, reason: `feeder ${feeder.id} wants the bottom camera: center the nozzle over it first` });
            continue;
        }
        if (feeder.at === null) {
            skipped.push({ ref: part.ref, reason: `feeder ${feeder.id}'s slot is not known: scan the feeder bus, or run, which finds it` });
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
    const head = [`; ${title || "placement"} on ${device.name}: ${blocks.length} parts`, ...device.init, ...skewLines(device)];
    return { head, blocks, tail: [...(device.wait ? [device.wait] : []), ...device.end], skipped, fit };
}

/** The nozzle up to the safe height and over a part's place on the machine. */
export function deviceGotoLines(device: MockDevice, fit: AlignFit, part: Component): string[] {
    const [tx, ty] = turnPoint([part.x, part.y], fit.rotation);
    return [
        safeLine(device),
        xyLine(device, tx + fit.shift[0], ty + fit.shift[1]),
    ];
}
