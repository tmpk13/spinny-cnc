// The keys of a machine file that no firmware setting holds: the page's
// controls and names, the head camera's [camera], the servos' names, and a
// G-code machine's own tables (its port, its dialect, its heights, the
// vacuum, the cameras, the feeder bus, the slots and the feeders). The
// Config page's settings list shows them beside the firmware's keys
// (src/machinekeys.ts), each with what it does and the other words an
// operator may look for it by, so its search finds "vacuum" or "rotation".
// The readers are the backend's (spinny_laser.machines, spinny_web.openpnp)
// and the mock's twins of them; a test checks that every key here reads in
// the mock and that every key docs/MACHINES.md names is here.

import { tomlValue, type TomlWritable } from "./machinekeys.ts";
import type { TomlTable, TomlValue } from "./toml.ts";

/** A value a file may give: a number, a flag, a word, or a list of them. */
export type FileValue = TomlWritable;

/** Which machines' files take a key: this project's firmware's, a G-code machine's, or both. */
export type FileMachine = "spinny" | "gcode" | "both";

export interface FileKey {
    /** The table, null for the top; an array of tables ([[feeder]]) by its name. */
    section: string | null;
    key: string;
    /** The table is an array of tables: the row stands for the key in each of them. */
    array: boolean;
    machine: FileMachine;
    /** Where the value goes, for the list's Sets column: the page, a camera, or the G-code machine's own run. */
    sets: "page" | "camera" | "G-code";
    /** What it is, in one phrase. */
    help: string;
    /** Other words an operator may look for it by. */
    words: string;
    /** What a file that leaves it out reads as, which a click adds it with; null when it has to be typed. */
    fallback: FileValue;
}

function keys(section: string | null, machine: FileMachine, sets: FileKey["sets"], rows: [string, string, string, FileValue][], array = false): FileKey[] {
    return rows.map(([key, help, words, fallback]) => ({ section, key, array, machine, sets, help, words, fallback }));
}

/** The words a camera's turn is looked for by: the file calls it roll. */
const TURN_WORDS = "rotation rotate turn angle orientation upside down";

/** A camera's own keys, as [camera], [up_camera] and [top_camera] give them. */
function cameraKeys(section: string, machine: FileMachine, device: string): FileKey[] {
    return keys(section, machine, "camera", [
        ["device", "the camera: a V4L2 device, an http snapshot or stream, socket://host:port of a pcbv serve", "video webcam usb camera", device],
        ["size", "capture size, WIDTHxHEIGHT", "resolution width height", "1280x720"],
        ["fps", "frames a second", "frame rate", 30],
        ["pcbv", "the pcbv program: a name on PATH or a path", "vision program", "pcbv"],
    ]);
}

function servoKeys(n: number): FileKey[] {
    return keys(`servo.${n}`, "spinny", "page", [
        ["name", `the jog panel's bar title; left out, Servo ${n}`, "label title", `Servo ${n}`],
        ["positions", "the page's buttons, name = angle, at most 8", "presets buttons angles", null],
    ]);
}

export const FILE_KEYS: FileKey[] = [
    ...keys(null, "both", "page", [
        ["name", "shown on the page; left out, the file's id", "title label", null],
        ["description", "shown beside the pick", "notes", null],
        ["controller", 'spinny, this project\'s firmware, or "gcode", a machine\'s own controller taking G-code', "firmware marlin grbl kind", "spinny"],
    ]),
    ...keys(null, "gcode", "G-code", [
        ["kinematics", "cartesian: the only kind a G-code machine is", "", "cartesian"],
        ["tool", "nozzle: the only tool a G-code machine has", "vacuum pick and place", "nozzle"],
    ]),
    ...cameraKeys("camera", "spinny", "/dev/video0"),
    ...keys("camera", "spinny", "camera", [
        ["side", "front or back: the board's side the camera sees", "top bottom", "front"],
        ["finish", "masked or bare: whether solder mask hides the copper", "soldermask", "masked"],
        ["offset", "the picture's center from the tool, board mm X Y; the offset routine measures it", "camera offset tool", [0, 0]],
        ["roll", "the picture's turn, degrees from its x axis to board +X, counterclockwise; measured with the offset", TURN_WORDS, 0],
        ["mm_per_px", "mm per picture pixel at the board; 0 until measured", "scale pixel size resolution", 0],
    ]),
    ...[1, 2, 3, 4].flatMap(servoKeys),
    ...keys("controls", "both", "page", [
        ["pad", "a board X/Y pad, on the arrow keys", "arrows keyboard jog", true],
        ["pad_steps", "the pad's step choices, mm", "jog increments", [0.1, 1, 10]],
        ["pad_step", "the step picked at the start, mm; left out, the middle one", "jog increment", null],
        ["feed", "a feed field for the pad and the axes that take it", "speed", true],
        ["center", "where Center sends the joints, as { r = 0 }; left out, no button", "home middle", null],
    ]),
    ...keys("controls", "spinny", "page", [
        ["centering", "the Tests panel's Centering test, burnt where the rail crosses the axis", "test burn", true],
    ]),
    ...keys("controls.axes", "both", "page", [
        ["axis", "the joint a bar moves: r, a, z or h", "joint", null],
        ["letter", "1 to 3 characters: the readout's and the zero button's", "name", null],
        ["label", "the bar's title", "name title", null],
        ["steps", "the bar's step choices; left out, the pad's", "jog increments", null],
        ["step", "the step picked at the start", "jog increment", null],
        ["buttons", "the minus and plus buttons' words", "labels", null],
        ["feed", "the feed field applies to the bar", "speed", null],
        ["goto", "a field in the goto row", "go to", null],
        ["zero", "a Set 0 here button", "zero home", null],
        ["zero_hint", "what the zero button asks", "confirm", null],
        ["keys", "two key names for minus and plus", "keyboard shortcut", null],
        ["note", "a line under the bar's title", "hint", null],
    ], true),

    // A G-code machine's own tables.
    ...keys("port", "gcode", "G-code", [
        ["url", "a serial device or socket://host:port that is this machine's", "serial tty com device port", ""],
        ["match", "words in a port's USB names that make it this machine's", "usb product name port", []],
        ["baud", "the serial rate", "bitrate speed", 115200],
        ["wait_ms", "ms a board that resets as its port opens gets before the first line", "boot delay reset", 2000],
        ["timeout", "s a line may take to be answered; a home gets three times this", "wait", 60],
    ]),
    ...keys("gcode", "gcode", "G-code", [
        ["init", "lines sent at the connect and before a run", "startup", ["G21", "G90"]],
        ["end", "lines sent after a run", "finish", []],
        ["move", "the move word; every move carries its F", "G0 G1", "G0"],
        ["x", "the X axis's letter", "axis", "X"],
        ["y", "the Y axis's letter", "axis", "Y"],
        ["z", "the nozzle height's axis letter", "axis height", "Z"],
        ["rotation", "the nozzle turn's axis letter", "axis turn angle A nozzle", "A"],
        ["rotation_cw", "true when a positive turn turns the nozzle clockwise from above", "direction reverse clockwise", false],
        ["wait", "answered once the moves queued have run", "finish moves M400", "M400"],
        ["pick", "vacuum on: a line or a list (a pump and a valve)", "vacuum suction pump valve on", "M106"],
        ["place", "vacuum off: a line or a list", "vacuum suction pump valve off release", "M107"],
        ["dwell", "a wait, {ms} or {s} for the time; empty for none", "pause delay G4", "G4 P{ms}"],
        ["home", "the jog panel's Home", "homing G28", "G28"],
        ["position", "answered with X: Y: Z: (A:)", "report where M114", "M114"],
        ["stop", "the Stop and a jog's cancel, sent ahead of anything queued; empty sends nothing", "halt emergency quickstop M410", "M410"],
        ["motors_on", "the jog panel's Motors on; empty: no button", "enable steppers M17", "M17"],
        ["motors_off", "the jog panel's Motors off", "disable steppers M18", "M18"],
        ["light_on", "the cameras' lights on: a line or a list", "lamp ring led light", []],
        ["light_off", "the cameras' lights off", "lamp ring led light", []],
    ]),
    ...keys("motion", "gcode", "G-code", [
        ["feed_xy", "mm/min across, and a jog's or goto's without a feed", "speed feed rate", 6000],
        ["feed_z", "mm/min up and down", "speed feed rate height", 1200],
        ["safe_z", "the lowest height a move across goes at: a nozzle below it rises to it first", "travel clearance height", null],
        ["seesaw", "true: one Z motor drives two nozzles, moves across come to safe_z from either side, Z jogs stop at it; false: a plain Z, a nozzle above safe_z stays up; left out: from either side, jogs go where sent", "lumenpnp two nozzles n1 n2 safe height", null],
        ["place_z", "the tip with a part on it at the board's top", "height board place", null],
        ["pick_dwell_ms", "ms the vacuum gets before the nozzle rises with a part", "vacuum suction wait pick", 200],
        ["place_dwell_ms", "ms after the vacuum lets go of a part", "vacuum wait place", 150],
        ["pick_tries", "pockets tried for one part before it is left out", "retry attempts", 3],
        ["park", "X Y where Park takes the head", "rest out of the way", null],
        ["discard", "X Y Z where a part that failed a check is let go; left out, back in its pocket", "reject bin trash drop", null],
    ]),
    ...keys("vacuum", "gcode", "G-code", [
        ["read", "the line or lines that read the vacuum sensor", "vacuum suction pressure sensor", null],
        ["pattern", "a regular expression whose group is the vacuum reading", "vacuum regex reading sensor", "T:\\s*(-?[0-9]+(?:\\.[0-9]+)?)"],
        ["part_on", "the low and high vacuum readings with a part held", "vacuum suction range part held", null],
        ["part_off", "the low and high vacuum readings with the nozzle empty", "vacuum suction range empty", null],
    ]),
    ...keys("up_camera", "gcode", "G-code", [
        ["position", "the head's place with the nozzle over the bottom camera's center, as designed", "bottom camera location place", null],
        ["z", "the height the nozzle tip is seen sharp at over the bottom camera", "bottom camera focus height", null],
        ["crop", "mm from the picture's center a part is looked for", "bottom camera search reach", null],
        ["max_offset", "mm a part's center may sit off the nozzle's", "bottom camera tolerance part", 1],
        ["max_turn", "degrees a part may sit off its angle", "bottom camera tolerance part turn", 15],
        ["size_tolerance", "the share a part's length or width may be off; 0 checks no size", "bottom camera part size", 0.3],
        ["leave", "mm: a jog leaving the camera with the tip down rises to the safe height first", "bottom camera lift jog", null],
        ["roll", "the bottom camera's picture turn as mounted, degrees; Center nozzle measures it", `bottom camera ${TURN_WORDS}`, 0],
        ["mirror", "the bottom camera's picture shows the machine mirrored; false when it flips the picture", "bottom camera flip flipped", true],
    ]),
    ...cameraKeys("up_camera", "gcode", "/dev/video1"),
    ...keys("up_camera", "gcode", "camera", [
        ["nozzle_spot", "dark or bright: how the nozzle's bore looks to the bottom camera", "bottom camera shade tip", "dark"],
        ["part_spot", "dark or bright: how a part on the nozzle looks to the bottom camera", "bottom camera shade", "dark"],
    ]),
    ...keys("top_camera", "gcode", "G-code", [
        ["z", "the height the head looks from with the top camera; left out, the safe height", "top camera focus height", null],
        ["offset", "the top camera's center from the nozzle, as designed; Measure offset finds it", "top camera nozzle offset", null],
        ["roll", "the top camera's picture turn as mounted, degrees (180 upside down); Measure offset measures it", `top camera ${TURN_WORDS}`, 0],
        ["mm_per_px", "the top camera's scale as designed, mm a pixel at its size: searches plan by it until one is measured", "top camera scale resolution pixel size", null],
        ["fiducial", "dark or bright: how a fiducial looks to the top camera", "top camera shade fiducial", "bright"],
        ["within", "mm from where a fiducial, mark or pocket is expected that it is looked for", "top camera search reach", 2],
        ["home_fiducial", "a bed fiducial, as the nozzle's place over it, for Home by fiducial", "top camera homing fiducial", null],
    ]),
    ...cameraKeys("top_camera", "gcode", "/dev/video4"),
    ...keys("top_camera", "gcode", "camera", [
        ["mark_spot", "dark or bright: how the mark Measure offset centers looks to the top camera", "top camera shade mark", "dark"],
    ]),
    ...keys("bus", "gcode", "G-code", [
        ["send", "the line a feeder packet goes out in; {packet} is its hex", "feeder bus rs485 photon", "M485 {packet}"],
        ["reply", "a regular expression around an answer's hex", "feeder bus rs485 photon regex", null],
        ["header", "the packet header's bytes in order", "feeder bus", ["to", "from", "id", "length", "crc"]],
        ["host", "this host's address on the feeder bus", "feeder bus address", 0],
        ["broadcast", "the address every feeder listens to", "feeder bus address", 255],
        ["tries", "times a packet is sent before a feeder is given up", "feeder bus retry", 3],
        ["max_address", "the highest address a scan asks", "feeder bus scan", 32],
        ["poll_ms", "ms between status asks while a feeder moves", "feeder bus wait", 50],
        ["get_id", "command code: a feeder's id", "feeder bus command", 1],
        ["init", "command code: initialize a feeder by its id", "feeder bus command", 2],
        ["feed", "command code: move the tape on", "feeder bus command advance", 4],
        ["status", "command code: how the move went", "feeder bus command", 6],
        ["find", "command code: the feeder with an id answers from its address", "feeder bus command", 192],
        ["ok", "answer code: done", "feeder bus answer", 0],
        ["wrong_id", "answer code: not that feeder's id", "feeder bus answer", 1],
        ["unreachable", "answer code: the move could not reach its place", "feeder bus answer", 2],
        ["uninitialized", "answer code: the feeder must be initialized first", "feeder bus answer", 3],
        ["busy", "answer code: still moving", "feeder bus answer", 4],
    ]),
    ...keys("slot", "gcode", "G-code", [
        ["address", "the feeder's address on the bus", "feeder bus slot", null],
        ["at", "X Y Z with the nozzle over the slot's pick point", "feeder slot place", null],
        ["rotation", "the slot's angle, degrees", "feeder slot angle turn", null],
    ], true),
    ...keys("part_class", "gcode", "G-code", [
        ["name", "the class's name, shown in the bottom camera's Crop list", "part class size crop", null],
        ["match", "words a part's value and footprint must all hold; the first class that matches is the part's", "part class size value footprint", null],
        ["crop", "mm from the bottom camera's center its parts are looked for, when their feeder gives none", "part class bottom camera reach crop size", null],
    ], true),
    ...keys("feeder", "gcode", "G-code", [
        ["id", "the feeder's name: letters, digits, - and _", "feeder name", null],
        ["match", "words a part's value and footprint must all hold", "feeder part value footprint", null],
        ["refs", "the parts it holds by reference, which outdo match", "feeder parts references", null],
        ["at", "the first part's place, X Y Z", "feeder place location", null],
        ["pitch", "from one part to the next, or column to column of a tray", "feeder spacing tape", null],
        ["count", "parts in it; 0 for one that presents every part at its place", "feeder parts quantity", null],
        ["columns", "a tray's columns, taken row by row", "feeder tray", null],
        ["row_pitch", "from one row of a tray to the next", "feeder tray spacing", null],
        ["rotation", "the parts' angle as they sit in it, degrees", "feeder angle turn", null],
        ["place_z", "its parts' place height, in place of [motion] place_z", "feeder height", null],
        ["feed", "lines sent before each pick, for a feeder told to advance", "feeder advance actuator", null],
        ["vision", "its parts are looked at over the bottom camera before they are placed", "feeder bottom camera check", null],
        ["size", "the part's length and width as the cameras see it, mm", "feeder part body size", null],
        ["pocket", "dark or bright: a part in its pocket to the top camera, looked at before each pick", "feeder top camera shade", null],
        ["marks", "one or two marks on the feeder the top camera finds first", "feeder holes fiducials top camera", null],
        ["mark", "dark or bright: how the marks look", "feeder shade", null],
        ["crop", "mm from the bottom camera's center its parts are looked for", "feeder bottom camera reach", null],
        ["bus_id", "a bus feeder's hardware id, in place of at, pitch and count", "feeder bus photon id", null],
        ["slot", "a bus feeder's address, when it is not looked for by its id", "feeder bus slot address", null],
        ["offset", "a bus feeder's pick place from its slot's, X Y Z", "feeder bus offset", null],
        ["advance", "mm its tape moves on a part", "feeder bus pitch tape", null],
    ], true),
];

/** Whether a file of `controller` takes the key. */
export function takes(key: FileKey, controller: "spinny" | "gcode"): boolean {
    return key.machine === "both" || key.machine === controller;
}

/** The kind of machine a file's text is, by its controller line, for a text that does not read whole. */
export function textController(text: string): "spinny" | "gcode" {
    return /^\s*controller\s*=\s*["']gcode["']/m.test(text) ? "gcode" : "spinny";
}

/** A value read from the file as the list shows it: an inline table as its text. */
function shownValue(value: TomlValue | undefined): FileValue {
    if (value === undefined) {
        return null;
    }
    if (Array.isArray(value)) {
        return value.map((item) => shownValue(item));
    }
    if (typeof value === "object") {
        return `{ ${Object.entries(value).map(([name, item]) => `${name} = ${tomlValue(shownValue(item))}`).join(", ")} }`;
    }
    return value;
}

/** The tables of a file read as TOML that hold a key's section: one for a plain table, each of an array of tables. */
function tablesOf(parsed: TomlTable, key: FileKey): TomlTable[] {
    if (key.section === null) {
        return [parsed];
    }
    let node: TomlValue | undefined = parsed;
    for (const part of key.section.split(".")) {
        node = node !== undefined && typeof node === "object" && !Array.isArray(node) ? node[part] : undefined;
    }
    if (node === undefined) {
        return [];
    }
    if (Array.isArray(node)) {
        return node.filter((item): item is TomlTable => typeof item === "object" && item !== null && !Array.isArray(item));
    }
    return typeof node === "object" ? [node] : [];
}

/**
 * The key's value in a file read as TOML, null where the file leaves it
 * out; for a key of an array of tables, the list of the values of the
 * tables that give it (null when none does).
 */
export function fileValue(parsed: TomlTable | null, key: FileKey): FileValue {
    if (parsed === null) {
        return null;
    }
    const tables = tablesOf(parsed, key).filter((table) => key.key in table);
    if (key.array) {
        return tables.length === 0 ? null : tables.map((table) => shownValue(table[key.key]));
    }
    return tables.length === 0 ? null : shownValue(tables[0]![key.key]);
}
