// The CAM profiles of the in-page mock: the shipped files as text, read with
// the small TOML reader into the documents the page shows, changed one value
// at a time as the backend does it, a design taken through one into a job,
// and gcode written for a cartesian profile. The geometry is the demo
// coupon's: copper needs the real backend.

import laserText from "../../../../cam/cartesian-laser.toml" with { type: "text" };
import modelText from "../../../../cam/mill-3d.toml" with { type: "text" };
import millText from "../../../../cam/mill-3axis.toml" with { type: "text" };
import polarText from "../../../../cam/polar-laser.toml" with { type: "text" };

import { errorText } from "../api.ts";
import type {
    CamAxis,
    CamGcodeReport,
    CamGcodeResponse,
    CamMaterial,
    CamOperation,
    CamPath,
    CamPlacement,
    CamPost,
    CamProfile,
    CamSettingValue,
    CamShape,
    CamStock,
    CamSummary,
    CamTool,
    CamValue,
    Group,
    Job,
    Move,
    Path,
    Point,
    Tool,
} from "../types.ts";
import { DEFAULT_DEPTH, DEFAULT_PLUNGE, GERBER_EXTENSIONS, computeStats, demoCoupon, extensionOf, flipPaths, formatG, isBottom, layerOf, modelStats, outlineCut, parseGcode, parseSvg, shiftPaths, type RateLimits } from "./jobs.ts";
import { isTable } from "./machines.ts";
import { innerFirst } from "./order.ts";
import { parseToml, type TomlTable, type TomlValue } from "../toml.ts";

export const SHIPPED_PROFILES: { id: string; text: string }[] = [
    { id: "cartesian-laser", text: laserText },
    { id: "mill-3axis", text: millText },
    { id: "mill-3d", text: modelText },
    { id: "polar-laser", text: polarText },
];

export const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ROLES = ["x", "y", "depth", "radius", "angle", "setup"];
const MODEL_SOURCES = ["rough", "waterline", "parallel"];
const SOURCES = ["isolation", "clearing", "outline", "drills", "deposit", "paths", ...MODEL_SOURCES];
const SHAPES = ["flat", "ball", "bull", "vee"];
const DIRECTIONS = ["climb", "conventional"];
const DEFAULT_FLUTES = 2;
const DEFAULT_RPM_MAX = 24000;
const DEFAULT_ROUGH_STEPOVER = 0.4;
const DEFAULT_LEAVE = 0.2;
const DEFAULT_RAMP = 3;
const DEFAULT_MARGIN = 2;
const PATTERNS = ["radial", "rings", "lines"];
const FILLS = ["contour", "radial", "rings", "lines"];
const MARKS = ["circle", "cross", "dot"];
const MAX_VALUE = 1e6;
const MAX_DEPTH = 50;
const MAX_PASSES = 100;

type Bounds = [low: number, high: number, lowOk: boolean];
const SPINDLE_SETTINGS: Record<string, Bounds> = {
    rpm: [0, MAX_VALUE, false],
    feed: [0, MAX_VALUE, false],
    plunge: [0, MAX_VALUE, false],
    depth: [0, MAX_DEPTH, false],
    step_down: [0, MAX_DEPTH, true],
    stepover: [0, 1, false],
    // A model's operations: the stock left on walls and floors, the
    // steepest entry, how far round the model, how far under its bottom.
    leave: [0, MAX_DEPTH, true],
    leave_floor: [0, MAX_DEPTH, true],
    ramp: [0, 90, false],
    band: [0, 1000, true],
    below: [-MAX_DEPTH, MAX_DEPTH, true],
};
/** The settings only a model's operations read. */
const MODEL_SETTINGS = ["leave", "leave_floor", "ramp", "band", "below"];
const LASER_SETTINGS: Record<string, Bounds> = {
    power: [0, MAX_VALUE, true],
    min_power: [0, MAX_VALUE, true],
    speed: [0, MAX_VALUE, false],
    height: [-1000, 1000, true],
};
/** The keys a tool of each kind must give; a CAM profile has no dispenser tools. */
const REQUIRED: Partial<Record<Tool, string[]>> = { spindle: ["rpm", "feed"], laser: ["power", "speed"] };
const OPERATION_KEYS = ["name", "source", "tool", "enabled", "passes", "loops", "pattern", "fill", "marks", "match", "direction", "flats", "angle"];

// --- reading --------------------------------------------------------------------

class Reader {
    constructor(private readonly where: string) {}

    fail(section: string | null, key: string, what: string): Error {
        return new Error(`${this.where}: ${section ? `${section} ${key}` : key} ${what}`);
    }

    tables(top: TomlTable, name: string): TomlTable[] {
        const found = top[name] ?? [];
        if (!Array.isArray(found) || !found.every((item) => isTable(item))) {
            throw this.fail(null, name, `must be [[${name}]] tables`);
        }
        return found as TomlTable[];
    }

    table(top: TomlTable, name: string): TomlTable {
        const found = top[name] ?? {};
        if (!isTable(found)) {
            throw this.fail(null, name, "must be a table");
        }
        return found;
    }

    text(table: TomlTable, section: string | null, key: string, fallback: string): string {
        const value = table[key] ?? fallback;
        if (typeof value !== "string") {
            throw this.fail(section, key, "must be a string");
        }
        return value;
    }

    choice(table: TomlTable, section: string | null, key: string, choices: string[], fallback: string | null): string {
        const value = table[key] ?? fallback;
        if (value === null) {
            throw this.fail(section, key, `is needed: one of ${choices.join(", ")}`);
        }
        if (typeof value !== "string" || !choices.includes(value)) {
            throw this.fail(section, key, `must be one of ${choices.join(", ")}`);
        }
        return value;
    }

    flag(table: TomlTable, section: string | null, key: string, fallback: boolean): boolean {
        const value = table[key] ?? fallback;
        if (typeof value !== "boolean") {
            throw this.fail(section, key, "must be true or false");
        }
        return value;
    }

    number(table: TomlTable, section: string | null, key: string): number | null {
        const value = table[key];
        if (value === undefined) {
            return null;
        }
        if (typeof value !== "number" || !Number.isFinite(value)) {
            throw this.fail(section, key, "must be a number");
        }
        if (Math.abs(value) > MAX_VALUE) {
            throw this.fail(section, key, `must be within ${MAX_VALUE}`);
        }
        return value;
    }

    bounded(table: TomlTable, section: string | null, key: string, [low, high, lowOk]: Bounds): number | null {
        const value = this.number(table, section, key);
        if (value === null) {
            return null;
        }
        if (value > high || value < low || (value === low && !lowOk)) {
            throw this.fail(section, key, `must be ${lowOk ? "at least" : "above"} ${low} and at most ${high}`);
        }
        return value;
    }

    integer(table: TomlTable, section: string | null, key: string, low: number, high: number): number | null {
        const value = table[key];
        if (value === undefined) {
            return null;
        }
        if (typeof value !== "number" || !Number.isInteger(value) || value < low || value > high) {
            throw this.fail(section, key, `must be a whole number from ${low} to ${high}`);
        }
        return value;
    }

    strings(table: TomlTable, section: string | null, key: string, fallback: string[]): string[] {
        const value = table[key];
        if (value === undefined) {
            return fallback;
        }
        if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
            throw this.fail(section, key, "must be a list of strings");
        }
        return value as string[];
    }

    triple(table: TomlTable, section: string, key: string, low: number, high: number, lowOk = false): [number, number, number] | null {
        const value = table[key];
        if (value === undefined) {
            return null;
        }
        if (
            !Array.isArray(value) || value.length !== 3
            || !value.every((v) => typeof v === "number" && Number.isFinite(v) && v <= high && (v > low || (v === low && lowOk)))
        ) {
            throw this.fail(section, key, `must be [x, y, z], each ${lowOk ? "at least" : "above"} ${low} and at most ${high}`);
        }
        return [value[0] as number, value[1] as number, value[2] as number];
    }

    done(table: TomlTable, section: string | null, known: string[]): void {
        const unknown = Object.keys(table).filter((key) => !known.includes(key)).sort();
        if (unknown.length > 0) {
            throw this.fail(section, unknown[0]!, `is not a key here; the keys are ${[...known].sort().join(", ")}`);
        }
    }
}

/** A mill's full width: a V bit's shank, else its cut. */
export function toolDiameter(tool: CamTool): number {
    return tool.angle !== undefined && tool.shank !== undefined ? tool.shank : tool.width;
}

/** The chip a tooth takes at a diameter, read straight between the material's points. */
export function chipLoad(material: CamMaterial, diameter: number): number {
    const points = material.chip_load;
    if (diameter <= points[0]![0]) {
        return points[0]![1];
    }
    for (let i = 1; i < points.length; i += 1) {
        const [d0, c0] = points[i - 1]!;
        const [d1, c1] = points[i]!;
        if (diameter <= d1) {
            return c0 + (c1 - c0) * (diameter - d0) / (d1 - d0);
        }
    }
    return points[points.length - 1]![1];
}

/**
 * The rpm and feed a material asks of a mill, held to the spindle's range
 * and the plane's slowest axis, the rpm brought down with a held feed so
 * each tooth still takes its chip; and a rough's defaults. As the
 * backend's profile reader works them out.
 */
export function materialDefaults(
    material: CamMaterial | null,
    spindle: { min: number; max: number },
    axes: CamAxis[],
    tool: CamTool,
    source: string,
): { defaults: Record<string, number>; note: string } {
    if (material === null || tool.kind !== "spindle") {
        return { defaults: {}, note: "" };
    }
    const diameter = toolDiameter(tool);
    const flutes = tool.flutes ?? DEFAULT_FLUTES;
    let rpm = material.speed * 1000 / (Math.PI * diameter);
    const held: string[] = [];
    if (rpm > spindle.max) {
        rpm = spindle.max;
        held.push(`the rpm held to the spindle's ${spindle.max}`);
    } else if (rpm < spindle.min) {
        rpm = spindle.min;
        held.push(`the rpm raised to the spindle's least ${spindle.min}`);
    }
    const chip = chipLoad(material, diameter);
    let feed = rpm * flutes * chip;
    const plane = axes.filter((axis) => ["x", "y", "radius"].includes(axis.role) && axis.rate !== null).map((axis) => axis.rate!);
    const cap = plane.length > 0 ? Math.min(...plane) : null;
    if (cap !== null && feed > cap) {
        feed = cap;
        held.push(`the feed held to the axes' ${cap} mm/min and the rpm brought down to keep the chip`);
        rpm = Math.max(feed / (flutes * chip), spindle.min);
    }
    let plunge = feed * material.plunge;
    const depth = axes.find((axis) => axis.role === "depth" && axis.rate !== null);
    if (depth) {
        plunge = Math.min(plunge, depth.rate!);
    }
    const defaults: Record<string, number> = { rpm: Math.round(rpm), feed: Math.round(feed), plunge: Math.max(1, Math.round(plunge)) };
    if (source === "rough") {
        defaults["step_down"] = Math.round(material.depth * diameter * 1000) / 1000;
        defaults["stepover"] = material.stepover;
        defaults["leave"] = material.leave;
    }
    if (MODEL_SOURCES.includes(source)) {
        defaults["ramp"] = material.ramp;
    }
    const actual = defaults["rpm"]! > 0 ? defaults["feed"]! / (defaults["rpm"]! * flutes) : 0;
    let note = `${material.name} with ${tool.name}: ${defaults["rpm"]} rpm, ${defaults["feed"]} mm/min, ${actual.toFixed(3)} mm a tooth on ${flutes} flutes`;
    if (held.length > 0) {
        note += `; ${held.join(", ")}`;
    }
    return { defaults, note };
}

/** The settings an operation cuts with: the tool's, its own over them, a material's under the tool's, and the pass count. */
export function resolveCutting(
    tool: CamTool,
    settings: Record<string, CamSettingValue>,
    defaults: Record<string, number> = {},
    source: string | null = null,
): Record<string, number> {
    const cutting: Record<string, number> = {};
    const keys = [...Object.keys(tool.kind === "spindle" ? SPINDLE_SETTINGS : LASER_SETTINGS), "passes"];
    for (const key of keys) {
        const own = settings[key];
        if (typeof own === "number") {
            cutting[key] = own;
        } else if (tool.settings[key] !== undefined) {
            cutting[key] = tool.settings[key]!;
        } else if (defaults[key] !== undefined) {
            cutting[key] = defaults[key]!;
        }
    }
    if (tool.kind === "spindle" && source !== null && MODEL_SOURCES.includes(source)) {
        const diameter = toolDiameter(tool);
        if (source === "rough") {
            cutting["step_down"] ??= Math.round(0.5 * diameter * 1000) / 1000;
            cutting["stepover"] ??= DEFAULT_ROUGH_STEPOVER;
            cutting["leave"] ??= DEFAULT_LEAVE;
        } else if (source === "waterline") {
            cutting["step_down"] ??= Math.round(diameter * 1000) / 1000;
            cutting["stepover"] ??= DEFAULT_ROUGH_STEPOVER;
            cutting["leave"] ??= 0;
        } else {
            cutting["stepover"] ??= 0.1;
            cutting["leave"] ??= 0;
        }
        cutting["leave_floor"] ??= cutting["leave"]!;
        cutting["ramp"] ??= DEFAULT_RAMP;
        cutting["below"] ??= 0;
        cutting["passes"] = 1;
    }
    if (tool.kind === "spindle") {
        cutting["plunge"] ??= DEFAULT_PLUNGE;
        cutting["depth"] ??= DEFAULT_DEPTH;
        cutting["step_down"] ??= 0;
        cutting["stepover"] ??= 0.5;
        if (cutting["passes"] === undefined) {
            const step = cutting["step_down"];
            cutting["passes"] = step > 0 ? Math.ceil(cutting["depth"] / step - 1e-9) : 1;
        }
    } else {
        cutting["min_power"] ??= 0;
        cutting["passes"] ??= 1;
    }
    // A V bit cuts as wide as the operation's depth makes it; the last
    // pass, at the full depth, sets the trench.
    cutting["width"] = tool.kind === "spindle" ? widthAt(tool, cutting["depth"]!) : tool.width;
    return cutting;
}

/** The width of a tool's cut at a depth: a straight bit's or a beam's is its own, a V bit's is its tip plus what its flanks add, up to its shank. */
export function widthAt(tool: CamTool, depth: number): number {
    if (tool.angle === undefined) {
        return tool.width;
    }
    const wide = (tool.tip ?? 0) + 2 * Math.max(0, depth) * Math.tan(((tool.angle / 2) * Math.PI) / 180);
    return tool.shank !== undefined ? Math.min(wide, tool.shank) : wide;
}

export function parseProfile(text: string, id: string): CamProfile {
    const where = `${id}.toml`;
    let data: TomlTable;
    try {
        data = parseToml(text);
    } catch (error) {
        throw new Error(`${where}: ${errorText(error)}`);
    }
    const reader = new Reader(where);
    const name = reader.text(data, null, "name", id);
    const description = reader.text(data, null, "description", "");
    const machine = reader.text(data, null, "machine", "") || null;
    if (machine !== null && !ID_PATTERN.test(machine)) {
        throw reader.fail(null, "machine", "must be the stem of a file in machines/");
    }
    const axes = reader.tables(data, "axes").map((table, index) => readAxis(reader, table, index));
    const materials = reader.tables(data, "materials").map((table, index) => readMaterial(reader, table, index));
    for (const material of materials) {
        if (materials.filter((other) => other.id === material.id).length > 1) {
            throw reader.fail("[[materials]]", "id", `'${material.id}' is given twice`);
        }
    }
    const stock = readStock(reader, data, materials.map((material) => material.id));
    const modelSetup = readModel(reader, data);
    const spindle = readSpindle(reader, data);
    const material = materials.find((candidate) => candidate.id === stock.material) ?? null;
    const tools = reader.tables(data, "tools").map((table, index) => readTool(reader, table, index, material !== null));
    for (const tool of tools) {
        if (tools.filter((other) => other.id === tool.id).length > 1) {
            throw reader.fail("[[tools]]", "id", `'${tool.id}' is given twice`);
        }
    }
    const feeds = (tool: CamTool, source: string) => materialDefaults(material, spindle, axes, tool, source);
    const operations = reader.tables(data, "operations").map((table, index) => readOperation(reader, table, index, tools, feeds));
    const post = readPost(reader, data);
    const placement = readPlacement(reader, data);
    reader.done(data, null, ["name", "description", "machine", "axes", "tools", "operations", "post", "placement", "materials", "stock", "model", "spindle"]);
    checkAxes(reader, axes);
    if (tools.length === 0) {
        throw reader.fail(null, "tools", "the profile needs a tool: a [[tools]] table");
    }
    for (const operation of operations) {
        if (operations.filter((other) => other.name === operation.name).length > 1) {
            throw reader.fail("[[operations]]", "name", `'${operation.name}' is given twice`);
        }
    }
    const kinematics = axes.some((axis) => axis.role === "x") ? "cartesian" : "polar";
    const model = operations.some((operation) => MODEL_SOURCES.includes(operation.source));
    return {
        id, name, description, machine, kinematics, axes, tools, operations, post, placement,
        material: material?.name ?? null,
        model,
        materials,
        stock,
        model_setup: modelSetup,
        spindle,
    };
}

function readMaterial(reader: Reader, table: TomlTable, index: number): CamMaterial {
    let section = `[[materials]] ${index + 1}`;
    const id = reader.text(table, section, "id", "");
    if (!ID_PATTERN.test(id)) {
        throw reader.fail(section, "id", "is needed: lower case letters, digits, - and _");
    }
    section = `[[materials]] ${id}`;
    const name = reader.text(table, section, "name", id);
    const speed = reader.bounded(table, section, "speed", [0, 5000, false]);
    if (speed === null) {
        throw reader.fail(section, "speed", "is needed: the cutting edge's speed in m/min");
    }
    let raw = table["chip_load"];
    if (raw === undefined) {
        throw reader.fail(section, "chip_load", "is needed: [[diameter mm, mm per tooth], ...]");
    }
    if (typeof raw === "number") {
        raw = [[1, raw]];
    }
    if (!Array.isArray(raw) || raw.length === 0) {
        throw reader.fail(section, "chip_load", "must be [[diameter mm, mm per tooth], ...]");
    }
    const pairs: [number, number][] = [];
    for (const pair of raw) {
        if (!Array.isArray(pair) || pair.length !== 2 || !pair.every((v) => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1000)) {
            throw reader.fail(section, "chip_load", "must be [[diameter mm, mm per tooth], ...] with every number above 0");
        }
        pairs.push([pair[0] as number, pair[1] as number]);
    }
    pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (pairs.some((pair, i) => i > 0 && pairs[i - 1]![0] === pair[0])) {
        throw reader.fail(section, "chip_load", "gives one diameter twice");
    }
    const material: CamMaterial = {
        id,
        name,
        speed,
        chip_load: pairs,
        depth: reader.bounded(table, section, "depth", [0, 10, false]) ?? 0.5,
        stepover: reader.bounded(table, section, "stepover", [0, 1, false]) ?? DEFAULT_ROUGH_STEPOVER,
        ramp: reader.bounded(table, section, "ramp", [0, 90, false]) ?? DEFAULT_RAMP,
        plunge: reader.bounded(table, section, "plunge", [0, 1, false]) ?? 0.3,
        leave: reader.bounded(table, section, "leave", [0, MAX_DEPTH, true]) ?? DEFAULT_LEAVE,
        note: reader.text(table, section, "note", ""),
    };
    reader.done(table, section, ["id", "name", "speed", "chip_load", "depth", "stepover", "ramp", "plunge", "leave", "note"]);
    return material;
}

function readStock(reader: Reader, top: TomlTable, materialIds: string[]): CamStock {
    const table = reader.table(top, "stock");
    const section = "[stock]";
    const material = reader.text(table, section, "material", "") || null;
    if (material !== null && !materialIds.includes(material)) {
        throw reader.fail(section, "material", `must name a [[materials]] id: ${materialIds.join(", ") || "none yet"}`);
    }
    const stock: CamStock = {
        material,
        margin: reader.bounded(table, section, "margin", [0, 1000, true]) ?? DEFAULT_MARGIN,
        top: reader.bounded(table, section, "top", [0, MAX_DEPTH, true]) ?? 0,
        size: reader.triple(table, section, "size", 0, 1000),
    };
    reader.done(table, section, ["material", "margin", "top", "size"]);
    return stock;
}

function readModel(reader: Reader, top: TomlTable): { turn: [number, number, number]; scale: number } {
    const table = reader.table(top, "model");
    const section = "[model]";
    const turn = reader.triple(table, section, "turn", -360, 360, true) ?? [0, 0, 0];
    const scale = reader.bounded(table, section, "scale", [0, 1000, false]) ?? 1;
    reader.done(table, section, ["turn", "scale"]);
    return { turn, scale };
}

function readSpindle(reader: Reader, top: TomlTable): { min: number; max: number } {
    const table = reader.table(top, "spindle");
    const section = "[spindle]";
    const min = reader.bounded(table, section, "min", [0, MAX_VALUE, true]) ?? 0;
    const max = reader.bounded(table, section, "max", [0, MAX_VALUE, false]) ?? DEFAULT_RPM_MAX;
    if (min > max) {
        throw reader.fail(section, "min", "must be at most max");
    }
    reader.done(table, section, ["min", "max"]);
    return { min, max };
}

function checkAxes(reader: Reader, axes: CamAxis[]): void {
    const letters = axes.map((axis) => axis.letter);
    for (const letter of letters) {
        if (letters.filter((other) => other === letter).length > 1) {
            throw reader.fail("[[axes]]", "letter", `${letter} is given twice`);
        }
    }
    const roles = axes.map((axis) => axis.role);
    for (const role of ["x", "y", "depth", "radius", "angle"]) {
        if (roles.filter((other) => other === role).length > 1) {
            throw reader.fail("[[axes]]", "role", `two axes are '${role}'; one at most`);
        }
    }
    const plane = roles.includes("x") && roles.includes("y");
    const polar = roles.includes("radius") && roles.includes("angle");
    if (plane === polar) {
        throw reader.fail("[[axes]]", "role", "the axes need x and y (a cartesian machine), or radius and angle (a polar one), and not both");
    }
    for (const axis of axes) {
        if (axis.role === "angle" && axis.kind !== "rotary") {
            throw reader.fail("[[axes]]", "kind", `${axis.letter} is the angle, which turns: kind must be 'rotary'`);
        }
        if (["x", "y", "depth", "radius"].includes(axis.role) && axis.kind !== "linear") {
            throw reader.fail("[[axes]]", "kind", `${axis.letter} is '${axis.role}', which must be 'linear'`);
        }
        if (axis.role === "depth" && axis.safe === null) {
            throw reader.fail("[[axes]]", "safe", `${axis.letter} is the depth axis and needs a safe height over the surface`);
        }
    }
}

function readAxis(reader: Reader, table: TomlTable, index: number): CamAxis {
    let section = `[[axes]] ${index + 1}`;
    const raw = reader.text(table, section, "letter", "");
    if (!/^[A-Za-z]$/.test(raw)) {
        throw reader.fail(section, "letter", "must be one letter, A to Z");
    }
    const letter = raw.toUpperCase();
    section = `[[axes]] ${letter}`;
    const kind = reader.choice(table, section, "kind", ["linear", "rotary"], "linear") as CamAxis["kind"];
    const role = reader.choice(table, section, "role", ROLES, null) as CamAxis["role"];
    const min = reader.number(table, section, "min");
    const max = reader.number(table, section, "max");
    if (min !== null && max !== null && min >= max) {
        throw reader.fail(section, "max", "must be above min");
    }
    const rate = reader.bounded(table, section, "rate", [0, MAX_VALUE, false]);
    const rapid = reader.bounded(table, section, "rapid", [0, MAX_VALUE, false]);
    const offset = reader.number(table, section, "offset") ?? 0;
    const home = reader.number(table, section, "home");
    const safe = reader.bounded(table, section, "safe", [0, 1000, false]);
    const park = reader.number(table, section, "park");
    if (safe !== null && role !== "depth") {
        throw reader.fail(section, "safe", "is the depth axis' travel height; this axis is not the depth");
    }
    if (park !== null && role !== "setup") {
        throw reader.fail(section, "park", "is where a setup axis is put; this axis is not one");
    }
    reader.done(table, section, ["letter", "kind", "role", "min", "max", "rate", "rapid", "offset", "home", "safe", "park"]);
    return { letter, kind, role, min, max, rate, rapid, offset, home, safe, park };
}

function readTool(reader: Reader, table: TomlTable, index: number, material = false): CamTool {
    let section = `[[tools]] ${index + 1}`;
    const id = reader.text(table, section, "id", "");
    if (!ID_PATTERN.test(id)) {
        throw reader.fail(section, "id", "is needed: lower case letters, digits, - and _");
    }
    section = `[[tools]] ${id}`;
    let kind = reader.text(table, section, "kind", "");
    if (kind === "mill") {
        kind = "spindle";
    }
    if (kind !== "laser" && kind !== "spindle") {
        throw reader.fail(section, "kind", "must be one of laser, spindle, or mill");
    }
    const name = reader.text(table, section, "name", id);
    const diameter = reader.bounded(table, section, "diameter", [0, 1000, false]);
    const spot = reader.bounded(table, section, "spot", [0, 1000, false]);
    if (diameter !== null && spot !== null) {
        throw reader.fail(section, "spot", "and diameter are the same width; give one");
    }
    // A V bit is given by its point: the cut is as wide as the depth makes
    // it, and the diameter, when given, is the shank that bounds it.
    const angle = reader.bounded(table, section, "angle", [0, 179, false]);
    const tip = reader.bounded(table, section, "tip", [0, 1000, true]);
    if ((angle !== null || tip !== null) && kind !== "spindle") {
        throw reader.fail(section, angle !== null ? "angle" : "tip", "is for a mill V bit; a beam has a spot");
    }
    if (tip !== null && angle === null) {
        throw reader.fail(section, "tip", "needs angle: the included angle of the V bit point, degrees");
    }
    let width = diameter ?? spot;
    if (width === null && angle === null) {
        throw reader.fail(section, kind === "spindle" ? "diameter" : "spot", "is needed: the width of the cut, mm");
    }
    const bounds = kind === "spindle" ? SPINDLE_SETTINGS : LASER_SETTINGS;
    const settings: Record<string, number> = {};
    for (const [key, limits] of Object.entries(bounds)) {
        const value = reader.bounded(table, section, key, limits);
        if (value !== null) {
            settings[key] = value;
        }
    }
    const passes = reader.integer(table, section, "passes", 1, MAX_PASSES);
    if (passes !== null) {
        settings["passes"] = passes;
    }
    for (const key of REQUIRED[kind] ?? []) {
        if (settings[key] === undefined && !(material && kind === "spindle")) {
            throw reader.fail(section, key, "is needed, or a [stock] material to work it out from");
        }
    }
    const millKeys = ["shape", "corner", "flutes", "length"];
    let end: Partial<CamTool> = {};
    if (kind === "spindle") {
        end = readMillEnd(reader, table, section, angle, angle !== null ? diameter : width);
    } else {
        for (const key of millKeys.filter((key) => key in table).sort()) {
            throw reader.fail(section, key, "is for a mill; a beam has a spot");
        }
    }
    reader.done(table, section, ["id", "kind", "name", "diameter", "spot", "passes", "angle", "tip", ...Object.keys(bounds), ...millKeys]);
    if (angle !== null) {
        // The nominal width is the cut at the tool's own default depth.
        const depth = settings["depth"] ?? DEFAULT_DEPTH;
        const wide = (tip ?? 0) + 2 * depth * Math.tan((angle / 2) * Math.PI / 180);
        width = diameter !== null ? Math.min(wide, diameter) : wide;
        if (width <= 0) {
            throw reader.fail(section, "tip", "or the depth must give the cut some width");
        }
        return { id, kind, name, width, settings, angle, tip: tip ?? 0, ...(diameter !== null ? { shank: diameter } : {}), ...end };
    }
    return { id, kind, name, width: width ?? 0, settings, ...end };
}

/** A mill's shape, corner, flutes and reach. */
function readMillEnd(reader: Reader, table: TomlTable, section: string, angle: number | null, diameter: number | null): Partial<CamTool> {
    const shape = reader.choice(table, section, "shape", SHAPES, angle !== null ? "vee" : "flat") as CamShape;
    if (shape === "vee" && angle === null) {
        throw reader.fail(section, "shape", "vee needs angle: the included angle of the V bit's point, degrees");
    }
    if (angle !== null && shape !== "vee") {
        throw reader.fail(section, "angle", `is a V bit's; this mill's shape is ${shape}`);
    }
    const corner = reader.bounded(table, section, "corner", [0, 1000, false]);
    if (shape === "bull") {
        if (corner === null) {
            throw reader.fail(section, "corner", "is needed for a bull nose: the radius of its rounded corners, mm");
        }
        if (diameter !== null && corner > diameter / 2) {
            throw reader.fail(section, "corner", "must be at most half the diameter");
        }
    } else if (corner !== null) {
        throw reader.fail(section, "corner", "is a bull nose's corner radius; give shape = \"bull\"");
    }
    const flutes = reader.integer(table, section, "flutes", 1, 12) ?? DEFAULT_FLUTES;
    const length = reader.bounded(table, section, "length", [0, 1000, false]);
    return { shape, flutes, ...(shape === "bull" ? { corner: corner! } : {}), ...(length !== null ? { length } : {}) };
}

function readOperation(
    reader: Reader,
    table: TomlTable,
    index: number,
    tools: CamTool[],
    feeds: (tool: CamTool, source: string) => { defaults: Record<string, number>; note: string } = () => ({ defaults: {}, note: "" }),
): CamOperation {
    let section = `[[operations]] ${index + 1}`;
    const name = reader.text(table, section, "name", "");
    if (name.trim() === "") {
        throw reader.fail(section, "name", "is needed");
    }
    section = `[[operations]] ${name}`;
    const source = reader.choice(table, section, "source", SOURCES, null) as CamOperation["source"];
    const toolId = reader.text(table, section, "tool", "");
    const tool = tools.find((candidate) => candidate.id === toolId);
    if (!tool) {
        throw reader.fail(section, "tool", `must name a [[tools]] id: ${tools.map((t) => t.id).join(", ") || "none yet"}`);
    }
    const enabled = reader.flag(table, section, "enabled", true);
    const bounds = tool.kind === "spindle" ? SPINDLE_SETTINGS : LASER_SETTINGS;
    const settings: Record<string, CamSettingValue> = {};
    for (const [key, limits] of Object.entries(bounds)) {
        const value = reader.bounded(table, section, key, limits);
        if (value !== null) {
            settings[key] = value;
        }
    }
    const passes = reader.integer(table, section, "passes", 1, MAX_PASSES);
    if (passes !== null) {
        settings["passes"] = passes;
    }
    const loops = reader.integer(table, section, "loops", 1, 50);
    if (loops !== null) {
        if (source !== "isolation" && source !== "deposit") {
            throw reader.fail(section, "loops", "counts isolation or deposit loops; this operation is neither");
        }
        settings["loops"] = loops;
    }
    if ("pattern" in table) {
        if (source !== "clearing") {
            throw reader.fail(section, "pattern", "is how clearing fills; this operation is not clearing");
        }
        settings["pattern"] = reader.choice(table, section, "pattern", PATTERNS, null);
    }
    if ("fill" in table) {
        if (source !== "deposit") {
            throw reader.fail(section, "fill", "is how a deposit fills the copper; this operation is not a deposit");
        }
        settings["fill"] = reader.choice(table, section, "fill", FILLS, null);
    }
    if ("marks" in table) {
        if (source !== "drills" || tool.kind !== "laser") {
            throw reader.fail(section, "marks", "is how a laser marks the drills; this operation is not that");
        }
        settings["marks"] = reader.choice(table, section, "marks", MARKS, null);
    }
    if ("match" in table) {
        if (source !== "paths") {
            throw reader.fail(section, "match", "picks imported paths by their label; this operation does not take paths");
        }
        settings["match"] = reader.text(table, section, "match", "");
    }
    if (MODEL_SOURCES.includes(source)) {
        if (tool.kind !== "spindle") {
            throw reader.fail(section, "tool", "must be a mill: a model is cut, not burned");
        }
        if (tool.shape === "vee" && source !== "parallel") {
            throw reader.fail(section, "tool", "is a V bit, which cuts parallel passes only");
        }
    } else {
        for (const key of MODEL_SETTINGS) {
            if (key in settings) {
                throw reader.fail(section, key, "is for a model's operations: rough, waterline or parallel");
            }
        }
    }
    if ("direction" in table) {
        if (source !== "rough" && source !== "waterline") {
            throw reader.fail(section, "direction", "is which way a rough or a waterline goes round; this operation is neither");
        }
        settings["direction"] = reader.choice(table, section, "direction", DIRECTIONS, null);
    }
    if ("flats" in table) {
        if (source !== "rough" && source !== "waterline") {
            throw reader.fail(section, "flats", "adds a rough's or a waterline's levels at the flat faces; this operation is neither");
        }
        settings["flats"] = reader.flag(table, section, "flats", true);
    }
    if ("angle" in table) {
        if (source !== "parallel") {
            throw reader.fail(section, "angle", "is the direction of parallel lines; this operation is not parallel");
        }
        settings["angle"] = reader.bounded(table, section, "angle", [-360, 360, true])!;
    }
    reader.done(table, section, [...OPERATION_KEYS, ...Object.keys(bounds)]);
    const { defaults, note } = feeds(tool, source);
    const cutting = resolveCutting(tool, settings, defaults, source);
    if (tool.kind === "spindle" && cutting["passes"]! > MAX_PASSES) {
        throw reader.fail(section, "step_down", `gives more than ${MAX_PASSES} passes to the depth`);
    }
    if (tool.kind === "spindle" && source === "rough" && cutting["step_down"]! > 0 && cutting["step_down"]! < 0.01) {
        throw reader.fail(section, "step_down", "must be 0.01 mm or more for a rough");
    }
    const used = ["rpm", "feed"].some((key) => settings[key] === undefined && tool.settings[key] === undefined) ? note : "";
    return { name, source, tool: toolId, enabled, settings, cutting, feeds: used };
}

function readPost(reader: Reader, top: TomlTable): CamPost {
    const table = reader.table(top, "post");
    const section = "[post]";
    const spindleOn = reader.text(table, section, "spindle_on", "M3").trim().toUpperCase();
    const laserOn = reader.text(table, section, "laser_on", "M4").trim().toUpperCase();
    if (spindleOn !== "M3" && spindleOn !== "M4") {
        throw reader.fail(section, "spindle_on", "must be M3 or M4");
    }
    if (laserOn !== "M3" && laserOn !== "M4") {
        throw reader.fail(section, "laser_on", "must be M3 or M4");
    }
    const post: CamPost = {
        header: reader.strings(table, section, "header", ["G21", "G90", "G94", "G17"]),
        footer: reader.strings(table, section, "footer", ["M5", "M2"]),
        spindle_on: spindleOn,
        laser_on: laserOn,
        spinup: reader.bounded(table, section, "spinup", [0, 600, true]) ?? 2,
        decimals: reader.integer(table, section, "decimals", 1, 6) ?? 3,
        return_home: reader.flag(table, section, "return_home", true),
    };
    reader.done(table, section, ["header", "footer", "spindle_on", "laser_on", "spinup", "decimals", "return_home"]);
    return post;
}

function readPlacement(reader: Reader, top: TomlTable): CamPlacement {
    const table = reader.table(top, "placement");
    const section = "[placement]";
    const anchor = reader.choice(table, section, "anchor", ["center", "corner", "keep"], "center") as CamPlacement["anchor"];
    const offset = table["offset"] ?? [0, 0];
    if (!Array.isArray(offset) || offset.length !== 2 || !offset.every((v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= MAX_VALUE)) {
        throw reader.fail(section, "offset", "must be [x, y] in mm");
    }
    const layer = reader.text(table, section, "layer", "F.Cu");
    const mirror = reader.choice(table, section, "mirror", ["none", "x", "y"], "none") as CamPlacement["mirror"];
    reader.done(table, section, ["anchor", "offset", "layer", "mirror"]);
    return { anchor, offset: [offset[0] as number, offset[1] as number], layer, mirror };
}

export function summaryOf(profile: CamProfile): CamSummary {
    const kinds: Tool[] = [];
    for (const operation of profile.operations) {
        const tool = profile.tools.find((candidate) => candidate.id === operation.tool);
        if (operation.enabled && tool && !kinds.includes(tool.kind)) {
            kinds.push(tool.kind);
        }
    }
    return {
        id: profile.id,
        name: profile.name,
        description: profile.description,
        machine: profile.machine,
        kinematics: profile.kinematics,
        tools: kinds,
        axes: profile.axes.map((axis) => axis.letter).join(""),
        operations: profile.operations.filter((operation) => operation.enabled).length,
        material: profile.material ?? null,
        model: profile.model ?? false,
    };
}

// --- editing the text -------------------------------------------------------------

const HEADER = /^\s*\[\[\s*([A-Za-z0-9_-]+)\s*\]\]\s*(#.*)?$/;
const TABLE = /^\s*\[\s*([A-Za-z0-9_-]+)\s*\]\s*(#.*)?$/;

function tableRange(lines: string[], table: (string | number)[]): [number, number] {
    const counts: Record<string, number> = {};
    let start: number | null = table.length === 0 ? 0 : null;
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index]!;
        const header = HEADER.exec(line);
        const plain = header ? null : TABLE.exec(line);
        if (!header && !plain) {
            continue;
        }
        if (start !== null) {
            return [start, index];
        }
        if (header) {
            const name = header[1]!;
            if (table.length === 2 && table[0] === name && table[1] === (counts[name] ?? 0)) {
                start = index + 1;
            }
            counts[name] = (counts[name] ?? 0) + 1;
        } else if (plain && table.length === 1 && table[0] === plain[1]) {
            start = index + 1;
        }
    }
    if (start === null) {
        throw new Error(table.length === 2 ? `no [[${table[0]}]] table ${(table[1] as number) + 1} in the file` : `no [${table[0]}] table in the file`);
    }
    return [start, lines.length];
}

function valueEnd(rest: string): number {
    if (rest === "") {
        return 0;
    }
    const first = rest[0]!;
    if (first === '"' || first === "'") {
        for (let i = 1; i < rest.length; i++) {
            if (rest[i] === "\\" && first === '"') {
                i++;
            } else if (rest[i] === first) {
                return i + 1;
            }
        }
        return rest.length;
    }
    if (first === "[" || first === "{") {
        const close = first === "[" ? "]" : "}";
        let depth = 0;
        let quote: string | null = null;
        for (let i = 0; i < rest.length; i++) {
            const char = rest[i]!;
            if (quote !== null) {
                if (char === "\\" && quote === '"') {
                    i++;
                } else if (char === quote) {
                    quote = null;
                }
            } else if (char === '"' || char === "'") {
                quote = char;
            } else if (char === first) {
                depth++;
            } else if (char === close) {
                depth--;
                if (depth === 0) {
                    return i + 1;
                }
            } else if (char === "#") {
                break;
            }
        }
        return rest.length;
    }
    const hash = rest.indexOf("#");
    const end = hash < 0 ? rest.length : hash;
    return rest.slice(0, end).trimEnd().length;
}

export function formatValue(value: CamValue): string {
    if (typeof value === "boolean") {
        return value ? "true" : "false";
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw new Error("a value must be a number");
        }
        return String(value);
    }
    if (typeof value === "string") {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map((item) => formatValue(item)).join(", ")}]`;
    }
    throw new Error("nothing to write");
}

function lookup(data: TomlValue | undefined, path: CamPath): TomlValue | undefined {
    let node: TomlValue | undefined = data;
    for (const step of path) {
        if (typeof step === "number") {
            node = Array.isArray(node) ? node[step] : undefined;
        } else {
            node = isTable(node) ? node[step] : undefined;
        }
        if (node === undefined) {
            return undefined;
        }
    }
    return node;
}

/** The text with one value changed and everything else, comments included, as it was. */
export function setValue(text: string, path: CamPath, value: CamValue): string {
    const key = path[path.length - 1];
    if (path.length === 0 || typeof key !== "string" || !/^[A-Za-z0-9_-]+$/.test(key)) {
        throw new Error("the path must end in a key");
    }
    const table = path.slice(0, -1);
    if (table.length > 2 || (table.length === 2 && (typeof table[0] !== "string" || typeof table[1] !== "number")) || (table.length === 1 && typeof table[0] !== "string")) {
        throw new Error("a table is named by its name, or its name and its index");
    }
    const lines = text.split("\n");
    const [start, end] = tableRange(lines, table);
    const pattern = new RegExp(`^(\\s*${key.replace(/[-]/g, "\\-")}\\s*=\\s*)(.*)$`);
    let found: number | null = null;
    for (let index = start; index < end; index++) {
        if (pattern.test(lines[index]!)) {
            found = index;
            break;
        }
    }
    if (value === null) {
        if (found !== null) {
            lines.splice(found, 1);
        }
    } else if (found !== null) {
        const match = pattern.exec(lines[found]!)!;
        const rest = match[2]!;
        lines[found] = match[1]! + formatValue(value) + rest.slice(valueEnd(rest));
    } else {
        let at = end;
        while (at > start && lines[at - 1]!.trim() === "") {
            at--;
        }
        lines.splice(at, 0, `${key} = ${formatValue(value)}`);
    }
    const changed = lines.join("\n");
    let data: TomlTable;
    try {
        data = parseToml(changed);
    } catch (error) {
        throw new Error(`the change does not read as TOML: ${errorText(error)}`);
    }
    const read = lookup(data, path);
    if (value === null ? read !== undefined : JSON.stringify(read) !== JSON.stringify(value)) {
        throw new Error(`${path.join(".")} did not take the value`);
    }
    return changed;
}

// --- a design through a profile -----------------------------------------------------

interface Geometry {
    source: string;
    board: boolean;
    sets: { label: string; paths: Path[] }[];
    copper: Path[];
    outline: Path[];
    /** Loops around the demo coupon's copper, by loop index. */
    loops: Path[][];
    /** The demo coupon's drill marks, one ring each. */
    drills: Path[];
}

function readGeometry(fileName: string, text: string): Geometry {
    const extension = extensionOf(fileName);
    if (extension === "kicad_pcb" || GERBER_EXTENSIONS.includes(extension)) {
        const coupon = demoCoupon();
        return {
            source: extension === "kicad_pcb" ? "kicad" : "gerber",
            board: true,
            sets: [],
            copper: coupon.copper,
            outline: coupon.outline,
            loops: coupon.groups.filter((group) => group.label.startsWith("isolation loop")).map((group) => group.paths),
            drills: coupon.groups.find((group) => group.label === "drill marks")?.paths ?? [],
        };
    }
    const empty: Geometry = { source: extension, board: false, sets: [], copper: [], outline: [], loops: [], drills: [] };
    switch (extension) {
        case "svg": {
            const parsed = parseSvg(text);
            return { ...empty, source: "svg", sets: parsed.groups.map((group) => ({ label: group.label, paths: group.paths })) };
        }
        case "gcode":
        case "nc":
        case "ngc": {
            const parsed = parseGcode(text);
            return { ...empty, source: "gcode", sets: parsed.groups.map((group) => ({ label: group.label, paths: group.paths })) };
        }
        case "json": {
            let data: unknown;
            try {
                data = JSON.parse(text);
            } catch (error) {
                throw new Error(`not a job: ${errorText(error)}`);
            }
            const job = data as Partial<Job>;
            const groups = Array.isArray(job.groups) ? job.groups : [];
            return {
                ...empty,
                source: "json",
                sets: groups.filter((group) => Array.isArray(group.paths)).map((group) => ({ label: String(group.label), paths: group.paths })),
                outline: Array.isArray(job.outline) ? job.outline : [],
            };
        }
        default:
            throw new Error(`cannot read ${fileName}: unknown file type '.${extension}'`);
    }
}

/** The design placed by the anchor and the offset; a board's layer flipped first as the placement's mirror says, a drawing's paths not. */
function place(design: Geometry, placement: CamPlacement): Geometry {
    let geometry = design;
    if (design.board && placement.mirror !== "none") {
        const fx = placement.mirror === "x" ? -1 : 1;
        const fy = placement.mirror === "y" ? -1 : 1;
        geometry = {
            ...design,
            copper: flipPaths(design.copper, fx, fy),
            outline: flipPaths(design.outline, fx, fy),
            loops: design.loops.map((loop) => flipPaths(loop, fx, fy)),
            drills: flipPaths(design.drills, fx, fy),
        };
    }
    const all: Path[] = [...geometry.copper, ...geometry.outline, ...geometry.drills, ...geometry.loops.flat(), ...geometry.sets.flatMap((set) => set.paths)];
    const points = all.flat();
    let [dx, dy] = placement.offset;
    if (placement.anchor !== "keep" && points.length > 0) {
        const xs = points.map((p) => p[0]);
        const ys = points.map((p) => p[1]);
        const minX = Math.min(...xs);
        const minY = Math.min(...ys);
        if (placement.anchor === "center") {
            dx -= (minX + Math.max(...xs)) / 2;
            dy -= (minY + Math.max(...ys)) / 2;
        } else {
            dx -= minX;
            dy -= minY;
        }
    }
    return {
        ...geometry,
        sets: geometry.sets.map((set) => ({ label: set.label, paths: shiftPaths(set.paths, dx, dy) })),
        copper: shiftPaths(geometry.copper, dx, dy),
        outline: shiftPaths(geometry.outline, dx, dy),
        loops: geometry.loops.map((loop) => shiftPaths(loop, dx, dy)),
        drills: shiftPaths(geometry.drills, dx, dy),
    };
}

function groupOf(operation: CamOperation, tool: CamTool, label: string, paths: Path[]): Group {
    const cutting = operation.cutting;
    if (tool.kind === "spindle") {
        return {
            label,
            power: cutting["rpm"]!,
            min_power: 0,
            speed: cutting["feed"]!,
            passes: cutting["passes"]!,
            enabled: operation.enabled,
            depth: cutting["depth"]!,
            plunge: cutting["plunge"]!,
            tool: "spindle",
            tool_id: tool.id,
            tool_name: tool.name,
            paths,
        };
    }
    return {
        label,
        power: cutting["power"]!,
        min_power: cutting["min_power"]!,
        speed: cutting["speed"]!,
        passes: cutting["passes"]!,
        enabled: operation.enabled,
        depth: DEFAULT_DEPTH,
        plunge: DEFAULT_PLUNGE,
        tool: "laser",
        tool_id: tool.id,
        tool_name: tool.name,
        height: cutting["height"] ?? null,
        paths,
    };
}

function center(path: Path): Point {
    const n = path.length || 1;
    return [path.reduce((sum, p) => sum + p[0], 0) / n, path.reduce((sum, p) => sum + p[1], 0) / n];
}

/** The design through every operation of the profile, the way the backend builds it, on the mock's geometry. */
export function buildCamJob(id: string, profile: CamProfile, name: string, fileName: string, text: string, limits: RateLimits): { job: Job; notes: string[] } {
    const geometry = place(readGeometry(fileName, text), profile.placement);
    const notes: string[] = [];
    if (geometry.board) {
        notes.push("mock backend: copper geometry needs the real backend, showing a demo coupon");
        // A KiCad board is read on the profile's layer, a gerber is the layer its name says.
        const layer = /\.kicad_pcb$/i.test(fileName) ? profile.placement.layer : layerOf(fileName);
        if (isBottom(layer) && profile.placement.mirror === "none") {
            notes.push(
                `${fileName.replace(/\.[^.]+$/, "")}: ${layer} is a back layer and [placement] mirror is "none", so it is cut as drawn,`
                + ` which with the board turned over is the copper's mirror image; mirror = "x" flips it`,
            );
        }
    }
    const isolation = profile.operations.find((operation) => operation.source === "isolation");
    const toolOf = (operation: CamOperation): CamTool => profile.tools.find((tool) => tool.id === operation.tool)!;
    // The isolation's width at the depth it cuts (a V bit widens with it), else the narrowest tool's.
    const spot = isolation ? isolation.cutting["width"] ?? toolOf(isolation).width : Math.min(...profile.tools.map((tool) => tool.width));
    const groups: Group[] = [];
    for (const operation of profile.operations) {
        const tool = toolOf(operation);
        const prefix = operation.name;
        if (operation.source === "paths") {
            const wanted = String(operation.settings["match"] ?? "").toLowerCase();
            const taken = geometry.sets.filter((set) => set.label.toLowerCase().includes(wanted));
            if (taken.length === 0) {
                notes.push(`${prefix}: no paths${wanted ? ` labeled '${wanted}'` : ""} in ${fileName}`);
            }
            groups.push(...taken.map((set) => groupOf(operation, tool, `${prefix}: ${set.label}`, innerFirst(set.paths))));
            continue;
        }
        if (!geometry.board) {
            notes.push(`${prefix}: ${fileName} is not a board, so there is no ${operation.source} in it`);
            continue;
        }
        switch (operation.source) {
            case "isolation": {
                const loops = Number(operation.settings["loops"] ?? 1);
                geometry.loops.slice(0, loops).forEach((paths, index) => {
                    groups.push(groupOf(operation, tool, `${prefix}: loop ${index + 1} at ${(spot / 2 + index * spot).toFixed(3)} mm`, paths));
                });
                break;
            }
            case "outline": {
                // A beam cuts on the line; a bit's middle runs its radius
                // off the board, so the board comes out the size drawn.
                const radius = tool.kind === "spindle" ? operation.cutting["width"]! / 2 : 0;
                groups.push(groupOf(operation, tool, `${prefix}: board outline`, innerFirst(outlineCut(geometry.outline, radius))));
                break;
            }
            case "drills":
                if (tool.kind === "laser") {
                    groups.push(groupOf(operation, tool, `${prefix}: ${geometry.drills.length} holes marked as ${String(operation.settings["marks"] ?? "circle")}`, geometry.drills));
                } else {
                    groups.push(groupOf(operation, tool, `${prefix}: ${geometry.drills.length} holes at the bit's size`, geometry.drills.map((ring) => [center(ring)])));
                }
                break;
            default:
                notes.push(`${prefix}: mock backend: ${operation.source} needs the real backend`);
        }
    }
    if (!groups.some((group) => group.paths.length > 0)) {
        throw new Error(`nothing in ${fileName} for the operations of ${profile.name}`);
    }
    const job: Job = {
        id,
        name,
        source: geometry.source,
        spot,
        offset: { x: profile.placement.offset[0], y: profile.placement.offset[1] },
        groups,
        outline: geometry.outline,
        copper: geometry.copper,
        stats: computeStats(groups, limits),
    };
    return { job, notes };
}

// --- a 3D model ------------------------------------------------------------------------

/** An STL's box and triangle count: binary when its length says so, else ASCII. */
export function stlBounds(bytes: Uint8Array): { min: [number, number, number]; max: [number, number, number]; triangles: number } {
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    const take = (v: [number, number, number]): void => {
        for (let k = 0; k < 3; k++) {
            min[k] = Math.min(min[k]!, v[k]!);
            max[k] = Math.max(max[k]!, v[k]!);
        }
    };
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = bytes.length >= 84 ? view.getUint32(80, true) : -1;
    let triangles = 0;
    if (count >= 0 && 84 + count * 50 === bytes.length) {
        for (let i = 0; i < count; i++) {
            for (let k = 0; k < 3; k++) {
                const at = 84 + i * 50 + 12 + k * 12;
                take([view.getFloat32(at, true), view.getFloat32(at + 4, true), view.getFloat32(at + 8, true)]);
            }
        }
        triangles = count;
    } else {
        const text = new TextDecoder().decode(bytes);
        let vertices = 0;
        for (const match of text.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/gi)) {
            const v: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3])];
            if (!v.every(Number.isFinite)) {
                throw new Error(`${match[0]} is not a vertex`);
            }
            take(v);
            vertices += 1;
        }
        triangles = Math.floor(vertices / 3);
    }
    if (triangles === 0) {
        throw new Error("no triangles in the file");
    }
    return { min, max, triangles };
}

/** A box's corners turned about X, then Y, then Z by degrees, and the box of those. */
function turnedBox(min: [number, number, number], max: [number, number, number], turn: [number, number, number], scale: number): { min: [number, number, number]; max: [number, number, number] } {
    const [ax, ay, az] = turn.map((d) => (d * Math.PI) / 180) as [number, number, number];
    const low: [number, number, number] = [Infinity, Infinity, Infinity];
    const high: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let corner = 0; corner < 8; corner++) {
        let x = corner & 1 ? max[0] : min[0];
        let y = corner & 2 ? max[1] : min[1];
        let z = corner & 4 ? max[2] : min[2];
        [y, z] = [y * Math.cos(ax) - z * Math.sin(ax), y * Math.sin(ax) + z * Math.cos(ax)];
        [x, z] = [x * Math.cos(ay) + z * Math.sin(ay), -x * Math.sin(ay) + z * Math.cos(ay)];
        [x, y] = [x * Math.cos(az) - y * Math.sin(az), x * Math.sin(az) + y * Math.cos(az)];
        const v = [x * scale, y * scale, z * scale];
        for (let k = 0; k < 3; k++) {
            low[k] = Math.min(low[k]!, Math.round(v[k]! * 1e9) / 1e9);
            high[k] = Math.max(high[k]!, Math.round(v[k]! * 1e9) / 1e9);
        }
    }
    return { min: low, max: high };
}

/** A rectangle's loop, closed: the box from (x0, y0) to (x1, y1) at z. */
function ring(x0: number, y0: number, x1: number, y1: number, z: number): Move[] {
    return [[x0, y0, z, 1], [x1, y0, z, 1], [x1, y1, z, 1], [x0, y1, z, 1], [x0, y0, z, 1]];
}

/**
 * A model through the profile's rough, waterline and parallel operations.
 * The mock has no kernel: it reads the model's box and cuts loops round
 * the box, level by level, and lines over its top, so the page has moves
 * to show and write.
 */
export function buildModelJob(id: string, profile: CamProfile, name: string, fileName: string, bytes: Uint8Array): { job: Job; notes: string[] } {
    const depthAxis = profile.axes.find((axis) => axis.role === "depth");
    if (profile.kinematics !== "cartesian" || !depthAxis || depthAxis.safe === null) {
        throw new Error(`${profile.name}: a 3D model is cut on an X/Y machine with a depth axis`);
    }
    const operations = profile.operations.filter((operation) => MODEL_SOURCES.includes(operation.source));
    if (operations.length === 0) {
        throw new Error(`${profile.name} has no rough, waterline or parallel operation for a 3D model`);
    }
    for (const operation of operations) {
        const tool = profile.tools.find((candidate) => candidate.id === operation.tool)!;
        if (tool.shape === "vee" && tool.shank === undefined) {
            throw new Error(`${operation.name}: the V bit ${tool.id} needs its diameter to cut a model`);
        }
    }
    let read: ReturnType<typeof stlBounds>;
    try {
        read = stlBounds(bytes);
    } catch (error) {
        throw new Error(`${fileName}: ${errorText(error)}`);
    }
    const setup = profile.model_setup ?? { turn: [0, 0, 0] as [number, number, number], scale: 1 };
    const box = turnedBox(read.min, read.max, setup.turn, setup.scale);
    const size = [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
    const stockSpec = profile.stock ?? { material: null, margin: DEFAULT_MARGIN, top: 0, size: null };
    let margin: [number, number] = [stockSpec.margin, stockSpec.margin];
    let top = stockSpec.top;
    if (stockSpec.size) {
        const block = stockSpec.size;
        const short = [0, 1, 2].find((k) => block[k]! < size[k]! - 1e-6);
        if (short !== undefined) {
            throw new Error(`the stock is ${block[short]} mm in ${"XYZ"[short]}, the model ${size[short]!.toFixed(3)} mm: the model does not fit`);
        }
        margin = [(block[0] - size[0]!) / 2, (block[1] - size[1]!) / 2];
        top = block[2] - size[2]!;
    }
    const width = size[0]! + 2 * margin[0];
    const height = size[1]! + 2 * margin[1];
    const anchor = profile.placement.anchor;
    const [ox, oy] = profile.placement.offset;
    const low: [number, number] = anchor === "corner" ? [ox, oy] : anchor === "center" ? [ox - width / 2, oy - height / 2] : [box.min[0] - margin[0] + ox, box.min[1] - margin[1] + oy];
    const x0 = low[0] + margin[0];
    const y0 = low[1] + margin[1];
    const x1 = x0 + size[0]!;
    const y1 = y0 + size[1]!;
    const bottom = -(size[2]! + top);
    const clearance = Math.min(1, depthAxis.safe / 2);
    const groups: Group[] = [];
    for (const operation of operations) {
        const tool = profile.tools.find((candidate) => candidate.id === operation.tool)!;
        const cutting = operation.cutting;
        const radius = toolDiameter(tool) / 2;
        const keep = radius + (cutting["leave"] ?? 0);
        const floor = bottom - (cutting["below"] ?? 0);
        const step = cutting["step_down"] ?? 0;
        const levels: number[] = [];
        for (let k = 1; step > 0 && -k * step > floor + 1e-6; k++) {
            levels.push(-k * step);
        }
        levels.push(floor);
        const moves: Move[][] = [];
        if (operation.source === "parallel") {
            const pitch = (cutting["stepover"] ?? 0.1) * toolDiameter(tool);
            const path: Move[] = [[x0, y0, -top + clearance, 0], [x0, y0, -top, 2]];
            let flip = false;
            for (let y = y0; y <= y1 + 1e-9; y += pitch) {
                path.push([flip ? x1 : x0, y, -top, 1], [flip ? x0 : x1, y, -top, 1]);
                flip = !flip;
            }
            moves.push(path);
        } else {
            let above = 0;
            for (const z of levels) {
                const path: Move[] = [[x0 - keep, y0 - keep, above + clearance, 0], [x0 - keep, y0 - keep, z, 2]];
                const band = operation.source === "rough" ? cutting["band"] ?? radius : 0;
                const pitch = (cutting["stepover"] ?? DEFAULT_ROUGH_STEPOVER) * toolDiameter(tool);
                for (let out = keep; out <= keep + band + 1e-9; out += pitch) {
                    path.push(...ring(x0 - out, y0 - out, x1 + out, y1 + out, z));
                }
                moves.push(path);
                above = z;
            }
        }
        const deepest = -Math.min(...moves.flat().map((m) => m[2]));
        groups.push({
            label: `${operation.name}: ${tool.name}`,
            power: cutting["rpm"]!,
            min_power: 0,
            speed: cutting["feed"]!,
            passes: 1,
            enabled: operation.enabled,
            depth: Math.max(deepest, 0.01),
            plunge: cutting["plunge"]!,
            tool: "spindle",
            tool_id: tool.id,
            tool_name: tool.name,
            paths: [],
            moves,
        });
    }
    const notes = [
        `${name}: ${size.map((v) => Number(v.toFixed(3))).join(" x ")} mm, ${read.triangles} triangles, in a ${Number(width.toFixed(3))} x ${Number(height.toFixed(3))} x ${Number((-bottom).toFixed(3))} mm block with its top at Z 0`,
        "mock backend: a model's toolpaths need the real backend and its kernel; showing loops round the model's box",
        ...operations.filter((operation) => operation.feeds).map((operation) => `${operation.name}: ${operation.feeds}`),
    ];
    const outline: Path[] = [
        [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]],
        [[low[0], low[1]], [low[0] + width, low[1]], [low[0] + width, low[1] + height], [low[0], low[1] + height], [low[0], low[1]]],
    ];
    const job: Job = {
        id,
        name,
        source: "stl",
        spot: Math.min(...operations.map((operation) => profile.tools.find((tool) => tool.id === operation.tool)!.width)),
        offset: { x: ox, y: oy },
        groups,
        outline,
        copper: [],
        stats: modelStats(groups),
    };
    return { job, notes };
}

// --- gcode ----------------------------------------------------------------------------

/**
 * What a comment must not carry: the control characters, which a controller
 * or a sender may take for the end of the line, and the line and paragraph
 * separators some senders split lines on. A name or a label holding one
 * would otherwise put the text after it on a line of its own, where it runs.
 */
const LINE_BREAKING = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/g;

/** A comment line: every character that could end a line made a space, the parentheses square. */
function commentLine(text: string): string {
    return `(${text.replace(LINE_BREAKING, " ").replaceAll("(", "[").replaceAll(")", "]")})`;
}

/** A group has something to cut: paths, or a model's moves. */
function hasCuts(group: Group): boolean {
    return group.paths.length > 0 || (group.moves?.length ?? 0) > 0;
}

/**
 * Python's f"{value:.{decimals}f}": the nearest, with an exact tie to the
 * even digit where toFixed takes it away from zero. toFixed at 100 places
 * is the double's exact value for anything a program writes, so a tie is
 * a 5 there followed by nothing but zeros.
 */
function fixed(value: number, decimals: number): string {
    const exact = Math.abs(value).toFixed(100);
    const point = exact.indexOf(".");
    const kept = exact.slice(point + 1, point + 1 + decimals);
    const tie = /^50*$/.test(exact.slice(point + 1 + decimals));
    const last = Number((decimals > 0 ? kept : exact.slice(0, point)).slice(-1));
    if (tie && last % 2 === 0) {
        const text = decimals > 0 ? `${exact.slice(0, point)}.${kept}` : exact.slice(0, point);
        return value < 0 ? `-${text}` : text;
    }
    return value.toFixed(decimals);
}

/** Python's round(value, digits), as the backend rounds the report. */
function rounded(value: number, digits: number): number {
    return Number(fixed(value, digits));
}

/**
 * A job as gcode for a cartesian profile, the way the backend's post
 * writes it, line for line, with the same report: the mock has no polar
 * writer. A spindle group is milled the way a run streams one (the tool up,
 * the spindle started and given its spin-up, each path a rapid to its
 * start, a plunge, the cuts at depth and a rise, pass by pass down to the
 * depth), one cut with another bit than the spindle group before it after a
 * stop to change the bit; a laser group is cut at its height on a depth
 * axis, with its power on every cut.
 */
export function camGcode(profile: CamProfile, job: Job): CamGcodeResponse {
    for (const group of job.groups) {
        if ((group.joints?.length ?? 0) > 0) {
            throw new Error(`${group.label}: a joint-space group has no board paths to write`);
        }
    }
    // A job with nothing switched on to cut is refused, as a run refuses it:
    // its program would only rise and go home.
    if (!job.groups.some((group) => group.enabled && hasCuts(group))) {
        throw new Error("the job has nothing enabled to cut: switch on a group");
    }
    const x = profile.axes.find((axis) => axis.role === "x");
    const y = profile.axes.find((axis) => axis.role === "y");
    const depth = profile.axes.find((axis) => axis.role === "depth");
    if (!x || !y) {
        throw new Error("mock backend: the polar gcode writer needs the real backend");
    }
    const post = profile.post;
    const lines: string[] = [];
    let cuts = 0;
    let length = 0;
    let seconds = 0;
    // Machine coordinates reached, by axis letter: [min, max].
    const extents: Record<string, [number, number]> = {};
    const warnings: string[] = [];
    // Machine coordinates the controller is at, by letter; missing until written.
    const at = new Map<string, number>();
    // The output's state, the modal feed and power words; null for off or not yet written.
    let output: [Tool, number] | null = null;
    let feedWord: number | null = null;
    let powerWord: number | null = null;
    // The kinds of move a capped feed was said for, once each.
    const capped = new Set<string>();
    // The id of the bit the last spindle group that named one cut with: the
    // one fitted, as far as the program knows; null before any.
    let bit: string | null = null;

    // A number with the profile's decimals, a negative zero written as zero.
    const num = (value: number): string => {
        const text = fixed(value, post.decimals);
        return text.startsWith("-") && Number(text) === 0 ? text.slice(1) : text;
    };
    const warn = (text: string): void => {
        if (!warnings.includes(text)) {
            warnings.push(text);
        }
    };
    const reach = (axis: CamAxis, value: number): void => {
        const span = extents[axis.letter];
        extents[axis.letter] = span ? [Math.min(span[0], value), Math.max(span[1], value)] : [value, value];
    };
    const safe = (): number => depth!.safe!;
    // One axis of a move: its word unless it is there already (a park or a
    // home is written all the same), and how far it goes, 0 from where
    // nothing has put it yet.
    const step = (axis: CamAxis, value: number, words: string[], moved: [CamAxis, number][], always = false): void => {
        const before = at.get(axis.letter);
        if (!always && before !== undefined && Math.abs(before - value) <= 1e-9) {
            return;
        }
        words.push(`${axis.letter}${num(value)}`);
        moved.push([axis, before !== undefined ? value - before : 0]);
        at.set(axis.letter, value);
        reach(axis, value);
    };
    // A rapid in machine coordinates: the plane, the depth, or setup axes;
    // it takes as long as its slowest axis at its rapid, else at its rate.
    const go = (point: Point | null, z: number | null = null, setup: [CamAxis, number][] = []): void => {
        const words: string[] = [];
        const moved: [CamAxis, number][] = [];
        if (point) {
            step(x, point[0] + x.offset, words, moved);
            step(y, point[1] + y.offset, words, moved);
        }
        if (z !== null) {
            step(depth!, depth!.offset + z, words, moved);
        }
        for (const [axis, value] of setup) {
            step(axis, value, words, moved, true);
        }
        if (words.length === 0) {
            return;
        }
        lines.push(`G0 ${words.join(" ")}`);
        let longest = 0;
        for (const [axis, distance] of moved) {
            const rate = axis.rapid || axis.rate;
            if (rate) {
                longest = Math.max(longest, (Math.abs(distance) / rate) * 60);
            }
        }
        seconds += longest;
    };
    // The feed, held to the slowest of the axes that move; said once.
    const cap = (feed: number, axes: CamAxis[], what: string): number => {
        let held = feed;
        for (const axis of axes) {
            if (axis.rate !== null && axis.rate < held) {
                held = axis.rate;
            }
        }
        if (held < feed && !capped.has(what)) {
            capped.add(what);
            warn(`${what}: ${formatG(feed)} mm/min is over the axes' rate; written as ${formatG(held)}`);
        }
        return held;
    };
    // A G1 across the plane at the feed, with S for a laser.
    const cut = (point: Point, feed: number, power: number | null, what: string): void => {
        const words: string[] = [];
        const moved: [CamAxis, number][] = [];
        step(x, point[0] + x.offset, words, moved);
        step(y, point[1] + y.offset, words, moved);
        if (words.length === 0) {
            return;
        }
        const run = moved.length === 2 ? Math.hypot(moved[0]![1], moved[1]![1]) : Math.abs(moved[0]![1]);
        const rate = cap(feed, moved.map(([axis]) => axis), what);
        if (feedWord !== rate) {
            words.push(`F${num(rate)}`);
            feedWord = rate;
        }
        if (power !== null && powerWord !== power) {
            words.push(`S${formatG(power)}`);
            powerWord = power;
        }
        lines.push(`G1 ${words.join(" ")}`);
        cuts += 1;
        length += run;
        seconds += (run / rate) * 60;
    };
    // A G1 in three dimensions at the feed along the move, held so that no
    // axis goes faster than its rate.
    const cut3 = (point: Point, over: number, feed: number, what: string): void => {
        const words: string[] = [];
        const moved: [CamAxis, number][] = [];
        step(x, point[0] + x.offset, words, moved);
        step(y, point[1] + y.offset, words, moved);
        step(depth!, depth!.offset + over, words, moved);
        if (words.length === 0) {
            return;
        }
        const run = Math.sqrt(moved.reduce((sum, [, delta]) => sum + delta * delta, 0));
        // Each axis covers its share of the move: the feed is held where
        // the share of the slowest makes it go over its rate.
        let held = feed;
        for (const [axis, delta] of moved) {
            if (axis.rate !== null && run > 0 && Math.abs(delta) > 0) {
                held = Math.min(held, (axis.rate * run) / Math.abs(delta));
            }
        }
        if (held < feed - 1e-9 && !capped.has(what)) {
            capped.add(what);
            warn(`${what}: ${formatG(feed)} mm/min is over an axis' rate on some moves; those are written slower`);
        }
        if (feedWord === null || Math.abs(feedWord - held) > 1e-9) {
            words.push(`F${num(held)}`);
            feedWord = held;
        }
        lines.push(`G1 ${words.join(" ")}`);
        cuts += 1;
        length += run;
        seconds += (run / held) * 60;
    };
    const plunge = (over: number, rate: number, what: string): void => {
        const value = depth!.offset + over;
        const before = at.get(depth!.letter);
        if (before !== undefined && Math.abs(before - value) <= 1e-9) {
            return;
        }
        const held = cap(rate, [depth!], what);
        const words = [`${depth!.letter}${num(value)}`];
        if (feedWord !== held) {
            words.push(`F${num(held)}`);
            feedWord = held;
        }
        lines.push(`G1 ${words.join(" ")}`);
        at.set(depth!.letter, value);
        reach(depth!, value);
        if (before !== undefined) {
            seconds += (Math.abs(before - value) / held) * 60;
        }
    };
    const outputOff = (): void => {
        if (output !== null) {
            lines.push("M5");
            output = null;
            powerWord = null;
        }
    };
    const spindle = (speed: number): void => {
        if (output !== null && output[0] === "spindle" && output[1] === speed) {
            return;
        }
        if (output !== null && output[0] !== "spindle") {
            outputOff();
        }
        lines.push(`${post.spindle_on} S${formatG(speed)}`);
        output = ["spindle", speed];
        if (post.spinup > 0) {
            lines.push(`G4 P${formatG(post.spinup)}`);
            seconds += post.spinup;
        }
    };
    const laser = (): void => {
        if (output !== null && output[0] === "laser") {
            return;
        }
        outputOff();
        lines.push(`${post.laser_on} S0`);
        output = ["laser", 0];
        powerWord = 0;
    };
    // A stop for the group's bit: the spindle off, the tool up, the bit
    // named and a pause the operator resumes once it is fitted and Z is
    // zeroed with it.
    const changeBit = (group: Group): void => {
        const name = group.tool_name || group.tool_id!;
        outputOff();
        if (depth) {
            go(null, safe());
        }
        lines.push(commentLine(`change the bit to ${name} and zero Z with it as before, then resume`));
        lines.push("M0");
        warn(`${group.label}: the program stops (M0) to change the bit to ${name}`);
    };
    const mill = (group: Group): void => {
        if (!depth) {
            throw new Error(`${group.label}: a spindle operation needs a depth axis in the profile`);
        }
        if (!(group.power > 0)) {
            throw new Error(`${group.label}: a spindle needs a speed above 0`);
        }
        // Up before the spindle starts: a laser group before this one may
        // have left the tool at its focus height, on the work.
        go(null, safe());
        spindle(group.power);
        const passes = Math.max(1, group.passes);
        const rate = group.plunge ?? DEFAULT_PLUNGE;
        for (let k = 1; k <= passes; k++) {
            const cutDepth = ((group.depth ?? DEFAULT_DEPTH) * k) / passes;
            for (const path of group.paths) {
                const first = path[0];
                if (!first) {
                    continue;
                }
                go(null, safe());
                go(first);
                plunge(-cutDepth, rate, `${group.label} plunge`);
                for (const target of path.slice(1)) {
                    cut(target, group.speed, null, group.label);
                }
                go(null, safe());
            }
        }
    };
    // A model's paths: each from the safe height down to its first point,
    // its moves as they are, and up again.
    const carve = (group: Group, kind: Tool): void => {
        if (!depth) {
            throw new Error(`${group.label}: a model's paths need a depth axis in the profile`);
        }
        if (kind !== "spindle") {
            throw new Error(`${group.label}: a model's paths are cut with a spindle`);
        }
        if (!(group.power > 0)) {
            throw new Error(`${group.label}: a spindle needs a speed above 0`);
        }
        go(null, safe());
        spindle(group.power);
        const rate = group.plunge ?? DEFAULT_PLUNGE;
        for (const path of group.moves ?? []) {
            const first = path[0];
            if (!first) {
                continue;
            }
            go(null, safe());
            go([first[0], first[1]]);
            if (first[3] === 0) {
                go(null, first[2]);
            } else {
                plunge(first[2], rate, `${group.label} plunge`);
            }
            for (const [mx, my, mz, how] of path.slice(1)) {
                if (how === 0) {
                    go([mx, my], mz);
                } else if (how === 2) {
                    cut3([mx, my], mz, rate, `${group.label} plunge`);
                } else {
                    cut3([mx, my], mz, group.speed, group.label);
                }
            }
            go(null, safe());
        }
    };
    const burn = (group: Group, height: number | null): void => {
        if (group.min_power > 0) {
            warn(`${group.label}: the power floor ${formatG(group.min_power)} has no gcode word and is left out`);
        }
        if (depth) {
            go(null, safe());
        }
        laser();
        if (depth && height !== null) {
            go(null, height);
        }
        for (let pass = 0; pass < Math.max(1, group.passes); pass++) {
            for (const path of group.paths) {
                if (path.length < 2) {
                    continue;
                }
                go(path[0]!);
                for (const target of path.slice(1)) {
                    cut(target, group.speed, group.power, group.label);
                }
            }
        }
    };

    const enabled = job.groups.filter((group) => group.enabled && hasCuts(group));
    lines.push(commentLine(`${job.name}: ${enabled.length} operations through ${profile.name}`));
    lines.push(commentLine(`board X/Y on ${profile.axes.map((axis) => `${axis.letter}=${axis.role}`).join(" ")}`));
    lines.push(...post.header);
    const parks = profile.axes.filter((axis) => axis.role === "setup" && axis.park !== null).map((axis): [CamAxis, number] => [axis, axis.park!]);
    if (depth) {
        go(null, safe());
    }
    if (parks.length > 0) {
        go(null, null, parks);
    }
    // A group that names no tool is written for the profile's first tool's
    // kind. A laser group a profile made keeps its operation's height, or
    // none; one made otherwise takes the first laser tool's that gives one.
    const kindOf = (group: Group): Tool => group.tool || profile.tools[0]!.kind;
    const firstHeight = profile.tools.find((tool) => tool.kind === "laser" && tool.settings["height"] !== undefined)?.settings["height"] ?? null;
    const heightOf = (group: Group): number | null => {
        const own = group.height ?? null;
        return own === null && (group.tool_id ?? null) === null ? firstHeight : own;
    };
    for (const group of enabled) {
        const kind = kindOf(group);
        const groupBit = group.tool_id ?? null;
        if (kind === "spindle" && groupBit !== null) {
            if (bit !== null && groupBit !== bit) {
                changeBit(group);
            }
            bit = groupBit;
        }
        const moves = group.moves ?? [];
        lines.push(commentLine(`${group.label}: ${moves.length > 0 ? moves.length : group.paths.length} paths`));
        if (moves.length > 0) {
            carve(group, kind);
        } else if (kind === "spindle") {
            mill(group);
        } else {
            burn(group, kind === "laser" ? heightOf(group) : null);
        }
    }
    outputOff();
    if (depth) {
        go(null, safe());
    }
    if (post.return_home) {
        const homes = profile.axes.filter((axis) => axis.home !== null && axis.role !== "depth").map((axis): [CamAxis, number] => [axis, axis.home!]);
        if (homes.length > 0) {
            go(null, null, homes);
        }
        if (depth && depth.home !== null) {
            go(null, null, [[depth, depth.home]]);
        }
    }
    lines.push(...post.footer);
    // One warning for each end of an axis the program goes past, at the farthest it goes.
    for (const axis of profile.axes) {
        const span = extents[axis.letter];
        if (!span) {
            continue;
        }
        if (axis.min !== null && span[0] < axis.min - 1e-9) {
            warn(`${axis.letter} reaches ${fixed(span[0], 3)}, under its min ${formatG(axis.min)}`);
        }
        if (axis.max !== null && span[1] > axis.max + 1e-9) {
            warn(`${axis.letter} reaches ${fixed(span[1], 3)}, over its max ${formatG(axis.max)}`);
        }
    }
    const report: CamGcodeReport = {
        lines: lines.length,
        cuts,
        length_mm: rounded(length, 3),
        seconds: rounded(seconds, 1),
        extents: Object.fromEntries(Object.entries(extents).map(([letter, [low, high]]): [string, [number, number]] => [letter, [rounded(low, 3), rounded(high, 3)]])),
        warnings,
    };
    // The file's name: the job's, every character but a letter, a digit, -, _ and . made _.
    const stem = job.name.replace(/[^\p{L}\p{N}_.-]/gu, "_") || "job";
    return { text: lines.join("\n") + "\n", report, filename: `${stem}.nc` };
}
