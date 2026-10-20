// The machine files of the in-page mock: the shipped files as text, read
// with the small TOML reader into the documents the backend sends (every
// firmware setting, the host's values and the page's controls), with the
// checks the backend makes and its words, so a file edited on the Config
// page against the mock is refused as the backend would refuse it.

import cartesianLaser from "../../../../machines/cartesian-laser.toml" with { type: "text" };
import cartesianMill from "../../../../machines/cartesian-mill.toml" with { type: "text" };
import polarLaserFocus from "../../../../machines/polar-laser-focus.toml" with { type: "text" };
import polarLaser from "../../../../machines/polar-laser.toml" with { type: "text" };

import { defaultControls } from "../controls.ts";
import { parseToml, type TomlTable, type TomlValue } from "../toml.ts";
import type { AxisControl, CameraFinish, CameraSettings, CameraSide, Controls, HostSettings, JointAxis, Kinematics, MachineDocument, MachineSummary, Tool } from "../types.ts";

/** The shipped files by id, as the backend lists them. */
export const MOCK_MACHINE_TEXTS: { id: string; text: string }[] = [
    { id: "cartesian-laser", text: cartesianLaser },
    { id: "cartesian-mill", text: cartesianMill },
    { id: "polar-laser-focus", text: polarLaserFocus },
    { id: "polar-laser", text: polarLaser },
];

/** The firmware's shipped defaults, in the order it lists them: a machine is always all of them. */
export const DEFAULT_SETTINGS: Record<string, number> = {
    r_steps: 10240,
    a_steps: 14222.222,
    r_rate: 560,
    a_rate: 400,
    r_accel: 50,
    a_accel: 50,
    r_jerk: 3,
    a_jerk: 2,
    r_max: 0,
    z_steps: 10240,
    z_rate: 560,
    z_accel: 50,
    jog_z: 120,
    jog_r: 300,
    jog_a: 200,
    dir_invert: 0,
    en_invert: 0,
    idle_ms: 0,
    step_us: 2,
    laser_hz: 5000,
    s_max: 1000,
    s_min: 0,
    laser_invert: 0,
    laser_ms: 5000,
    tmc_r_ma: 800,
    tmc_a_ma: 800,
    tmc_hold_pct: 50,
    tmc_r_micro: 256,
    tmc_a_micro: 256,
    tmc_z_ma: 800,
    tmc_z_micro: 256,
    tmc_stealth: 1,
    h_axis: 0,
    h_steps: 6400,
    h_rate: 600,
    h_accel: 50,
    h_jerk: 1,
    jog_h: 120,
    probe_invert: 0,
    tmc_h_ma: 600,
    tmc_h_micro: 256,
    probe_ms: 20,
    z_jerk: 3,
    z_max: 0,
    cartesian: 0,
    spindle: 0,
    sockets: 1234,
    laser_pin: 20,
    probe_pin: 25,
    tool_out: 0,
    tool_pin: 17,
    tool_invert: 0,
    r_stop: 0,
    r_stop_pin: 4,
    r_home_pull: 1,
    r_home_pos: 0,
    r_home_travel: 200,
    a_stop: 0,
    a_stop_pin: 3,
    a_home_pull: 1,
    a_home_pos: 0,
    a_home_travel: 400,
    h_stop: 0,
    h_stop_pin: 16,
    h_home_pull: 1,
    h_home_pos: 0,
    h_home_travel: 50,
    z_stop: 0,
    z_stop_pin: 22,
    z_home_pull: 1,
    z_home_pos: 0,
    z_home_travel: 200,
    stop_invert: 0,
    limits: 0,
    dispenser: 0,
};

export const MACHINE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** The board's highest GPIO, and the ones the driver sockets and the driver UART own. */
export const PIN_MAX = 29;
export const RESERVED_PINS = new Set([2, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 19, 28]);
const HEADERS: Record<number, string> = {
    17: "FAN1", 18: "FAN2", 20: "FAN3", 21: "BED", 23: "HE", 29: "SERVO", 24: "RGB",
    4: "X-STOP", 3: "Y-STOP", 25: "Z-STOP", 16: "E-STOP", 22: "PROBE", 26: "THB", 27: "TH0",
};
const KINEMATICS: Kinematics[] = ["polar", "cartesian"];
const TOOLS: Tool[] = ["laser", "spindle", "dispenser"];
const MICROSTEPS = [1, 2, 4, 8, 16, 32, 64, 128, 256];
const SOCKETS = ["X", "Y", "Z", "E"];
/** Where an axis's endstops are, in the order of the <axis>_stop values. */
const ENDSTOPS = ["none", "min", "max", "both"];
const FLOAT_MAX = 1e7;
const PROBE_MS_MAX = 160;
const INT_MAX = 4294967295;
/**
 * What a machine file may say about the host's own settings: the bounds,
 * and whether the low one is allowed. The dispensing values are what a dot
 * of paste is made of: the needle's gap over the pad, the plunger's
 * pull-back after each dot, the mm^3 of paste a mm of plunger gives, the
 * plunger's speed while a dot is pushed out, and the wait before the
 * pull-back.
 */
const HOST_KEYS: Record<string, [number, number, boolean]> = {
    tolerance: [0, 10, false],
    clearance: [0, 100, false],
    spinup: [0, 600, true],
    gap: [0, 10, false],
    retract: [0, 50, true],
    output: [0, 1e5, false],
    extrude_rate: [0, 1e4, false],
    dwell_ms: [0, 60000, true],
};
const HOST_INTEGERS = new Set(["dwell_ms"]);
/** A camera on the head, as the backend reads it: nothing of it reaches the firmware. What a file leaves out keeps the backend's value. */
export const CAMERA_DEFAULTS: CameraSettings = {
    device: "/dev/video0",
    size: "1280x720",
    fps: 30,
    pcbv: "pcbv",
    side: "front",
    finish: "masked",
    offset: [0, 0],
    roll: 0,
    mm_per_px: 0,
};
export const CAMERA_SIDES: CameraSide[] = ["front", "back"];
export const CAMERA_FINISHES: CameraFinish[] = ["masked", "bare"];
export const CAMERA_SIZE = /^[1-9][0-9]{1,4}x[1-9][0-9]{1,4}$/;
const JOINTS: JointAxis[] = ["r", "a", "z", "h"];
const PAD_KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
const CANCEL_KEY = "Escape";
const MAX_STEPS = 8;
const STEP_MAX = 1e4;
const LETTER_MAX = 3;
/** Section, the firmware's axis letter, the key its scale goes by, and its bit in dir_invert. */
const AXES: [string, string, string, number][] = [
    ["rail", "r", "steps_per_mm", 0],
    ["table", "a", "steps_per_deg", 1],
    ["slide", "z", "steps_per_mm", 2],
    ["focus", "h", "steps_per_mm", 3],
];

function pinName(pin: number): string {
    return pin in HEADERS ? `${pin} (${HEADERS[pin]})` : String(pin);
}

const isTable = (value: TomlValue | undefined): value is TomlTable => typeof value === "object" && value !== null && !Array.isArray(value);
const isNumber = (value: TomlValue | undefined): value is number => typeof value === "number" && Number.isFinite(value);

/** Typed reads out of the parsed tables, each refusal naming the file and the key as the backend does. */
class Reader {
    constructor(private readonly where: string) {}

    fail(section: string | null, key: string, what: string): Error {
        return new Error(section ? `${this.where}: [${section}] ${key} ${what}` : `${this.where}: ${key} ${what}`);
    }

    table(top: TomlTable, section: string): TomlTable {
        const value = top[section];
        if (value === undefined) {
            return {};
        }
        if (!isTable(value)) {
            throw this.fail(null, section, "must be a table");
        }
        return value;
    }

    text(table: TomlTable, key: string, fallback: string, section: string | null = null): string {
        const value = table[key] ?? fallback;
        if (typeof value !== "string") {
            throw this.fail(section, key, "must be a string");
        }
        return value;
    }

    choice<T extends string>(top: TomlTable, key: string, choices: T[], fallback: T): T {
        const value = this.text(top, key, fallback);
        if (!(choices as string[]).includes(value)) {
            throw this.fail(null, key, `must be one of ${choices.join(", ")}`);
        }
        return value as T;
    }

    flag(table: TomlTable, key: string, fallback: boolean, section: string): boolean {
        const value = table[key] ?? fallback;
        if (typeof value !== "boolean") {
            throw this.fail(section, key, "must be true or false");
        }
        return value;
    }

    number(table: TomlTable, key: string, section: string): number {
        const value = table[key];
        if (!isNumber(value)) {
            throw this.fail(section, key, "must be a number");
        }
        return value;
    }

    positive(table: TomlTable, key: string, section: string): number {
        const value = this.number(table, key, section);
        if (!(value > 0 && value <= FLOAT_MAX)) {
            throw this.fail(section, key, `must be above 0 and at most ${FLOAT_MAX}`);
        }
        return value;
    }

    nonNegative(table: TomlTable, key: string, section: string): number {
        const value = this.number(table, key, section);
        if (!(value >= 0 && value <= FLOAT_MAX)) {
            throw this.fail(section, key, `must be 0 or more and at most ${FLOAT_MAX}`);
        }
        return value;
    }

    integer(table: TomlTable, key: string, section: string, low: number, high: number): number {
        const value = this.number(table, key, section);
        if (!Number.isInteger(value)) {
            throw this.fail(section, key, "must be a whole number");
        }
        if (value < low || value > high) {
            throw this.fail(section, key, `must be ${low} to ${high}`);
        }
        return value;
    }

    oneOf(table: TomlTable, key: string, section: string, choices: number[]): number {
        const value = this.number(table, key, section);
        if (!choices.includes(value)) {
            throw this.fail(section, key, `must be one of ${choices.join(", ")}`);
        }
        return value;
    }

    pin(table: TomlTable, key: string, section: string): number {
        const value = this.integer(table, key, section, 0, PIN_MAX);
        if (RESERVED_PINS.has(value)) {
            throw this.fail(section, key, `${value} is a driver socket's or the driver UART's; the sockets and the UART keep ${[...RESERVED_PINS].sort((a, b) => a - b).join(", ")}`);
        }
        return value;
    }

    done(table: TomlTable, section: string | null, known: string[]): void {
        for (const key of Object.keys(table)) {
            if (!known.includes(key)) {
                throw this.fail(section, key, "is not a key here");
            }
        }
    }
}

/** A machine file's text as the document the backend sends; throws with the file and the key named. */
export function parseMachine(text: string, id: string): MachineDocument {
    const where = `${id}.toml`;
    let top: TomlTable;
    try {
        top = parseToml(text);
    } catch (error) {
        throw new Error(`${where}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const reader = new Reader(where);
    const settings: Record<string, number> = { ...DEFAULT_SETTINGS };
    const name = reader.text(top, "name", id);
    const description = reader.text(top, "description", "");
    const kinematics = reader.choice(top, "kinematics", KINEMATICS, "polar");
    const tool = reader.choice(top, "tool", TOOLS, "laser");
    settings["cartesian"] = kinematics === "cartesian" ? 1 : 0;
    settings["spindle"] = tool === "spindle" ? 1 : 0;
    settings["dispenser"] = tool === "dispenser" ? 1 : 0;
    if (tool === "dispenser" && kinematics !== "cartesian") {
        throw new Error(`${where}: tool = dispenser needs kinematics = cartesian`);
    }
    // The dispenser's plunger turns on the table's driver, so its section
    // stands in for the table's, in millimeters.
    const plunger = "dispenser" in top;
    if (plunger) {
        if ("table" in top) {
            throw new Error(`${where}: [table] and [dispenser] cannot both be given: the dispenser is the table's driver`);
        }
        if (tool !== "dispenser") {
            throw new Error(`${where}: [dispenser] needs tool = dispenser`);
        }
    }
    const sections = AXES.map(([section]) => (section === "table" && plunger ? "dispenser" : section));
    let dirInvert = 0;
    let stopInvert = 0;
    let limits = 0;
    const sockets = [...SOCKETS];
    for (const [index, [, axis, axisScaleKey, bit]] of AXES.entries()) {
        const section = sections[index]!;
        const scaleKey = section === "dispenser" ? "steps_per_mm" : axisScaleKey;
        const table = reader.table(top, section);
        if ("socket" in table) {
            const socket = reader.text(table, "socket", "", section);
            if (!SOCKETS.includes(socket)) {
                throw reader.fail(section, "socket", `must be one of ${SOCKETS.join(", ")}`);
            }
            sockets[bit] = socket;
        }
        if (axis === "h") {
            settings["h_axis"] = reader.flag(table, "fitted", settings["h_axis"] === 1, section) ? 1 : 0;
        }
        if (scaleKey in table) {
            settings[`${axis}_steps`] = reader.positive(table, scaleKey, section);
        }
        for (const [key, setting] of [["max_rate", `${axis}_rate`], ["accel", `${axis}_accel`], ["jerk", `${axis}_jerk`], ["jog_rate", `jog_${axis}`]] as [string, string][]) {
            if (key in table) {
                settings[setting] = reader.positive(table, key, section);
            }
        }
        if ((axis === "r" || axis === "z") && "limit" in table) {
            settings[`${axis}_max`] = reader.nonNegative(table, "limit", section);
        }
        if (reader.flag(table, "invert", false, section)) {
            dirInvert |= 1 << bit;
        }
        if ("current_ma" in table) {
            settings[`tmc_${axis}_ma`] = reader.integer(table, "current_ma", section, 0, 2000);
        }
        if ("microsteps" in table) {
            settings[`tmc_${axis}_micro`] = reader.oneOf(table, "microsteps", section, MICROSTEPS);
        }
        if ("endstop" in table) {
            const ends = reader.text(table, "endstop", "", section);
            if (!ENDSTOPS.includes(ends)) {
                throw reader.fail(section, "endstop", `must be one of ${ENDSTOPS.join(", ")}`);
            }
            settings[`${axis}_stop`] = ENDSTOPS.indexOf(ends);
        }
        if ("endstop_pin" in table) {
            settings[`${axis}_stop_pin`] = reader.pin(table, "endstop_pin", section);
        }
        if (reader.flag(table, "endstop_invert", false, section)) {
            stopInvert |= 1 << bit;
        }
        if (reader.flag(table, "endstop_halt", false, section)) {
            limits |= 1 << bit;
        }
        for (const key of ["home_pull", "home_travel"]) {
            if (key in table) {
                settings[`${axis}_${key}`] = reader.positive(table, key, section);
            }
        }
        if ("home_pos" in table) {
            settings[`${axis}_home_pos`] = reader.number(table, "home_pos", section);
        }
        const known = [
            scaleKey, "max_rate", "accel", "jerk", "jog_rate", "invert", "current_ma", "microsteps", "socket",
            "endstop", "endstop_pin", "endstop_invert", "endstop_halt", "home_pull", "home_pos", "home_travel",
        ];
        if (axis === "r" || axis === "z") {
            known.push("limit");
        }
        if (axis === "h") {
            known.push("fitted");
        }
        reader.done(table, section, known);
    }
    settings["dir_invert"] = dirInvert;
    settings["stop_invert"] = stopInvert;
    settings["limits"] = limits;
    sockets.forEach((socket, index) => {
        const other = sockets.indexOf(socket);
        if (other < index) {
            throw new Error(`${where}: [${sections[index]}] socket ${socket} is the [${sections[other]}] socket too`);
        }
    });
    settings["sockets"] = Number(sockets.map((socket) => SOCKETS.indexOf(socket) + 1).join(""));

    const probe = reader.table(top, "probe");
    settings["probe_invert"] = reader.flag(probe, "invert", false, "probe") ? 1 : 0;
    if ("brake_ms" in probe) {
        settings["probe_ms"] = reader.integer(probe, "brake_ms", "probe", 0, PROBE_MS_MAX);
    }
    if ("pin" in probe) {
        settings["probe_pin"] = reader.pin(probe, "pin", "probe");
    }
    reader.done(probe, "probe", ["invert", "brake_ms", "pin"]);

    const output = reader.table(top, "output");
    if ("pwm_hz" in output) {
        settings["laser_hz"] = reader.integer(output, "pwm_hz", "output", 100, 100000);
    }
    if ("s_max" in output) {
        settings["s_max"] = reader.positive(output, "s_max", "output");
    }
    if ("s_min" in output) {
        settings["s_min"] = reader.nonNegative(output, "s_min", "output");
    }
    if (settings["s_min"]! > settings["s_max"]!) {
        throw new Error(`${where}: [output] s_min is above s_max`);
    }
    settings["laser_invert"] = reader.flag(output, "invert", false, "output") ? 1 : 0;
    if ("test_ms" in output) {
        settings["laser_ms"] = reader.integer(output, "test_ms", "output", 1, 60000);
    }
    if ("pin" in output) {
        settings["laser_pin"] = reader.pin(output, "pin", "output");
    }
    reader.done(output, "output", ["pwm_hz", "s_max", "s_min", "invert", "test_ms", "pin"]);

    const enable = reader.table(top, "enable");
    settings["tool_out"] = reader.flag(enable, "fitted", false, "enable") ? 1 : 0;
    if ("pin" in enable) {
        settings["tool_pin"] = reader.pin(enable, "pin", "enable");
    }
    settings["tool_invert"] = reader.flag(enable, "invert", false, "enable") ? 1 : 0;
    reader.done(enable, "enable", ["fitted", "pin", "invert"]);
    if (settings["probe_pin"] === settings["laser_pin"]) {
        throw new Error(`${where}: [probe] pin ${pinName(settings["probe_pin"]!)} is the [output] pin too`);
    }
    if (settings["tool_out"]) {
        for (const [section, other] of [["output", "laser_pin"], ["probe", "probe_pin"]] as [string, string][]) {
            if (settings["tool_pin"] === settings[other]) {
                throw new Error(`${where}: [enable] pin ${pinName(settings["tool_pin"]!)} is the [${section}] pin too`);
            }
        }
    }
    // A fitted endstop is an input like the probe, which it may share; on
    // an output's pin it would read the output.
    for (const [index, [, axis]] of AXES.entries()) {
        const section = sections[index]!;
        if (!settings[`${axis}_stop`]) {
            continue;
        }
        const pin = settings[`${axis}_stop_pin`]!;
        const outputs: [string, number][] = [["output", settings["laser_pin"]!]];
        if (settings["tool_out"]) {
            outputs.push(["enable", settings["tool_pin"]!]);
        }
        for (const [other, otherPin] of outputs) {
            if (pin === otherPin) {
                throw new Error(`${where}: [${section}] endstop_pin ${pinName(pin)} is the [${other}] pin too`);
            }
        }
    }

    const drivers = reader.table(top, "drivers");
    settings["en_invert"] = reader.flag(drivers, "enable_invert", false, "drivers") ? 1 : 0;
    if ("idle_ms" in drivers) {
        settings["idle_ms"] = reader.integer(drivers, "idle_ms", "drivers", 0, INT_MAX);
    }
    if ("step_us" in drivers) {
        settings["step_us"] = reader.integer(drivers, "step_us", "drivers", 1, 20);
    }
    if ("hold_pct" in drivers) {
        settings["tmc_hold_pct"] = reader.integer(drivers, "hold_pct", "drivers", 0, 100);
    }
    settings["tmc_stealth"] = reader.flag(drivers, "stealth", true, "drivers") ? 1 : 0;
    reader.done(drivers, "drivers", ["enable_invert", "idle_ms", "step_us", "hold_pct", "stealth"]);

    const hostTable = reader.table(top, "host");
    const hostNumbers: Record<string, number> = {};
    for (const [key, [low, high, lowOk]] of Object.entries(HOST_KEYS)) {
        if (!(key in hostTable)) {
            continue;
        }
        if (HOST_INTEGERS.has(key)) {
            hostNumbers[key] = reader.integer(hostTable, key, "host", low, high);
            continue;
        }
        const value = reader.number(hostTable, key, "host");
        if (!(low <= value && value <= high) || (!lowOk && value <= low)) {
            // The spin-up keeps the words it had before the low end was allowed.
            if (key === "spinup" || !lowOk) {
                throw new Error(`${where}: [host] ${key} must be above ${low} and at most ${high}`);
            }
            throw new Error(`${where}: [host] ${key} must be ${low} to ${high}`);
        }
        hostNumbers[key] = value;
    }
    const host: Partial<HostSettings> = { ...hostNumbers };
    if ("speed_control" in hostTable) {
        host.speed_control = reader.flag(hostTable, "speed_control", true, "host");
    }
    reader.done(hostTable, "host", [...Object.keys(HOST_KEYS), "speed_control"]);
    const camera = parseCamera(reader, reader.table(top, "camera"));
    const focus = settings["h_axis"] === 1;
    const controls = parseControls(reader, top, kinematics, tool, focus);
    reader.done(top, null, ["name", "description", "kinematics", "tool", ...AXES.map((axis) => axis[0]), "dispenser", "probe", "output", "enable", "drivers", "host", "camera", "controls"]);
    return { id, name, description, kinematics, tool, focus, settings, host, camera, controls };
}

/** The `[camera]` table over the defaults, each key named checked as the backend checks it. */
function parseCamera(reader: Reader, table: TomlTable): CameraSettings {
    const section = "camera";
    const camera: CameraSettings = { ...CAMERA_DEFAULTS, offset: [...CAMERA_DEFAULTS.offset] };
    for (const key of ["device", "pcbv"] as const) {
        if (key in table) {
            const value = table[key];
            if (typeof value !== "string" || value.trim() === "") {
                throw reader.fail(section, key, "must be text");
            }
            camera[key] = value;
        }
    }
    if ("size" in table) {
        const value = table["size"];
        if (typeof value !== "string" || !CAMERA_SIZE.test(value)) {
            throw reader.fail(section, "size", "must be WIDTHxHEIGHT");
        }
        camera.size = value;
    }
    if ("fps" in table) {
        camera.fps = reader.integer(table, "fps", section, 1, 120);
    }
    if ("side" in table) {
        camera.side = textChoice(reader, table, "side", section, CAMERA_SIDES);
    }
    if ("finish" in table) {
        camera.finish = textChoice(reader, table, "finish", section, CAMERA_FINISHES);
    }
    if ("offset" in table) {
        const value = table["offset"];
        const ok = Array.isArray(value) && value.length === 2 && value.every((item) => isNumber(item) && Math.abs(item) <= 1000);
        if (!ok) {
            throw reader.fail(section, "offset", "must be two numbers within 1000 mm");
        }
        camera.offset = [value[0] as number, value[1] as number];
    }
    if ("roll" in table) {
        const value = reader.number(table, "roll", section);
        if (Math.abs(value) > 360) {
            throw reader.fail(section, "roll", "must be a number within 360");
        }
        camera.roll = value;
    }
    if ("mm_per_px" in table) {
        camera.mm_per_px = reader.nonNegative(table, "mm_per_px", section);
    }
    reader.done(table, section, Object.keys(CAMERA_DEFAULTS));
    return camera;
}

function textChoice<T extends string>(reader: Reader, table: TomlTable, key: string, section: string, choices: T[]): T {
    const value = table[key];
    if (typeof value !== "string" || !(choices as string[]).includes(value)) {
        throw reader.fail(section, key, `must be one of ${choices.join(", ")}`);
    }
    return value as T;
}

export function summaryOf(document: MachineDocument): MachineSummary {
    const { id, name, description, kinematics, tool, focus } = document;
    return { id, name, description, kinematics, tool, focus };
}

/** The live settings are this file's, every one of them, as far as the firmware's three decimals tell. */
export function matches(document: MachineDocument, settings: Record<string, number>): boolean {
    return Object.entries(document.settings).every(([name, expected]) => {
        const value = settings[name];
        return value !== undefined && Math.abs(value - expected) <= Math.max(5e-4, Math.abs(expected) * 1e-6);
    });
}

// --- the controls ----------------------------------------------------------------

function steps(reader: Reader, table: TomlTable, key: string, section: string, emptyOk = false): number[] {
    const value = table[key];
    const ok = Array.isArray(value) && value.every((item) => isNumber(item) && item > 0 && item <= STEP_MAX);
    const list = ok ? (value as number[]) : [];
    if (!ok || list.length > MAX_STEPS || new Set(list).size !== list.length || (list.length === 0 && !emptyOk)) {
        throw reader.fail(section, key, `must be a list of 1 to ${MAX_STEPS} different numbers above 0 and at most ${STEP_MAX}`);
    }
    return list;
}

function stepIn(reader: Reader, table: TomlTable, key: string, section: string, choices: number[]): number {
    const value = table[key];
    if (!isNumber(value)) {
        throw reader.fail(section, key, "must be a number");
    }
    if (!choices.includes(value)) {
        throw reader.fail(section, key, `must be one of the steps: ${choices.join(", ")}`);
    }
    return value;
}

function texts(reader: Reader, table: TomlTable, key: string, section: string, count: number, emptyOk = false): string[] {
    const value = table[key];
    const ok = Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim() !== "");
    if (!ok || !(value.length === count || (emptyOk && value.length === 0))) {
        throw reader.fail(section, key, `must be a list of ${count} words${emptyOk ? " or an empty list" : ""}`);
    }
    return value as string[];
}

function parseControls(reader: Reader, top: TomlTable, kinematics: Kinematics, tool: Tool, focus: boolean): Controls {
    const defaults = defaultControls({ kinematics, tool, h_axis: focus, r_max: 0, z_max: 0 });
    const table = reader.table(top, "controls");
    const section = "controls";
    const pad = reader.flag(table, "pad", defaults.pad, section);
    const padSteps = "pad_steps" in table ? steps(reader, table, "pad_steps", section) : [...defaults.pad_steps];
    let padStep: number;
    if ("pad_step" in table) {
        padStep = stepIn(reader, table, "pad_step", section, padSteps);
    } else {
        padStep = padSteps.includes(defaults.pad_step) ? defaults.pad_step : padSteps[Math.floor(padSteps.length / 2)]!;
    }
    const byJoint = new Map(defaults.axes.map((axis) => [axis.axis, axis]));
    let axes: AxisControl[];
    if ("axes" in table) {
        const entries = table["axes"];
        if (!Array.isArray(entries) || !entries.every((entry) => isTable(entry))) {
            throw reader.fail(section, "axes", "must be an array of tables, one [[controls.axes]] per joint");
        }
        axes = (entries as TomlTable[]).map((entry) => axisControl(reader, entry, byJoint, focus, pad, padSteps));
        const seen = new Set<string>();
        for (const axis of axes) {
            if (seen.has(axis.axis)) {
                throw reader.fail("controls.axes", "axis", `${axis.axis} is listed twice`);
            }
            seen.add(axis.axis);
        }
    } else {
        axes = defaults.axes.map((axis) => ({ ...axis, steps: axis.steps ? [...axis.steps] : null, buttons: [...axis.buttons] as [string, string], keys: [...axis.keys] }));
    }
    const listed = axes.map((axis) => axis.axis);
    let center: Controls["center"];
    if ("center" in table) {
        const given = table["center"];
        if (!isTable(given)) {
            throw reader.fail(section, "center", "must be a table of joints, like { r = 0 }");
        }
        center = {};
        for (const [joint, value] of Object.entries(given)) {
            if (!(JOINTS as string[]).includes(joint)) {
                throw reader.fail(section, "center", `names ${joint}, which is not one of r, a, z, h`);
            }
            if (!listed.includes(joint as JointAxis)) {
                throw reader.fail(section, "center", `names ${joint}, which the axes leave out`);
            }
            if (!isNumber(value)) {
                throw reader.fail(section, "center", `${joint} must be a number`);
            }
            center[joint as JointAxis] = value;
        }
        if (Object.keys(center).length === 0) {
            center = null;
        }
    } else {
        const kept = Object.fromEntries(Object.entries(defaults.center ?? {}).filter(([joint]) => listed.includes(joint as JointAxis)));
        center = Object.keys(kept).length > 0 ? kept : null;
    }
    reader.done(table, section, ["pad", "pad_steps", "pad_step", "feed", "center", "axes"]);
    return { pad, pad_steps: padSteps, pad_step: padStep, feed: reader.flag(table, "feed", defaults.feed, section), center, axes };
}

function axisControl(reader: Reader, entry: TomlTable, byJoint: Map<JointAxis, AxisControl>, focus: boolean, pad: boolean, padSteps: number[]): AxisControl {
    const section = "controls.axes";
    if (!("axis" in entry)) {
        throw reader.fail(section, "axis", "is missing: each entry names its joint, one of r, a, z, h");
    }
    const axis = reader.text(entry, "axis", "", section);
    if (!(JOINTS as string[]).includes(axis)) {
        throw reader.fail(section, "axis", `must be one of ${JOINTS.join(", ")}`);
    }
    if (axis === "h" && !focus) {
        throw reader.fail(section, "axis", "h is the focus axis, which [focus] fitted = false leaves out");
    }
    const base = byJoint.get(axis as JointAxis)!;
    const letter = reader.text(entry, "letter", base.letter, section);
    if (!(letter.length >= 1 && letter.length <= LETTER_MAX) || letter.trim() !== letter) {
        throw reader.fail(section, "letter", `must be 1 to ${LETTER_MAX} characters`);
    }
    const label = reader.text(entry, "label", base.label, section);
    if (label.trim() === "") {
        throw reader.fail(section, "label", "must not be empty");
    }
    let stepList: number[] | null;
    if ("steps" in entry) {
        const given = steps(reader, entry, "steps", section, true);
        stepList = given.length > 0 ? given : null;
    } else {
        stepList = base.steps ? [...base.steps] : null;
    }
    const choices = stepList ?? padSteps;
    let step: number | null;
    if ("step" in entry) {
        step = stepIn(reader, entry, "step", section, choices);
    } else if (stepList === null) {
        step = null;
    } else if (!("steps" in entry) && base.step !== null && stepList.includes(base.step)) {
        step = base.step;
    } else {
        step = stepList[Math.floor(stepList.length / 2)]!;
    }
    let buttons: [string, string];
    if ("buttons" in entry) {
        buttons = texts(reader, entry, "buttons", section, 2) as [string, string];
    } else if ("letter" in entry || "label" in entry) {
        // Renamed: the default's words would name the old axis.
        buttons = [`${letter}-`, `${letter}+`];
    } else {
        buttons = [...base.buttons] as [string, string];
    }
    const keys = "keys" in entry ? texts(reader, entry, "keys", section, 2, true) : [...base.keys];
    if (keys.length > 0) {
        if (keys[0] === keys[1]) {
            throw reader.fail(section, "keys", "must name two different keys");
        }
        for (const key of keys) {
            if (key === CANCEL_KEY) {
                throw reader.fail(section, "keys", `${CANCEL_KEY} is the cancel key`);
            }
            if (pad && PAD_KEYS.includes(key)) {
                throw reader.fail(section, "keys", `${key} is the pad's while pad = true`);
            }
        }
    }
    const control: AxisControl = {
        axis: axis as JointAxis,
        letter,
        label,
        steps: stepList,
        step,
        buttons,
        feed: reader.flag(entry, "feed", base.feed, section),
        goto: reader.flag(entry, "goto", base.goto, section),
        zero: reader.flag(entry, "zero", base.zero, section),
        zero_hint: reader.text(entry, "zero_hint", base.zero_hint, section),
        keys,
        note: reader.text(entry, "note", base.note, section),
    };
    // Every control is a bar of its own now; `place`, which said where an
    // older page drew it, is still taken.
    reader.done(entry, section, ["axis", "letter", "label", "steps", "step", "buttons", "place", "feed", "goto", "zero", "zero_hint", "keys", "note"]);
    return control;
}
