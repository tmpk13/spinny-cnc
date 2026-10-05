// The CAM profiles of the in-page mock: the shipped files as text, read with
// the small TOML reader into the documents the page shows, changed one value
// at a time as the backend does it, a design taken through one into a job,
// and gcode written for a cartesian profile. The geometry is the demo
// coupon's: copper needs the real backend.

import laserText from "../../../../cam/cartesian-laser.toml" with { type: "text" };
import millText from "../../../../cam/mill-3axis.toml" with { type: "text" };
import polarText from "../../../../cam/polar-laser.toml" with { type: "text" };

import type {
    CamAxis,
    CamGcodeReport,
    CamGcodeResponse,
    CamOperation,
    CamPath,
    CamPlacement,
    CamPost,
    CamProfile,
    CamSettingValue,
    CamSummary,
    CamTool,
    CamValue,
    Group,
    Job,
    Path,
    Point,
    Tool,
} from "../types.ts";
import { DEFAULT_DEPTH, DEFAULT_PLUNGE, computeStats, demoCoupon, parseGcode, parseSvg, type RateLimits } from "./jobs.ts";
import { parseToml, type TomlTable, type TomlValue } from "./toml.ts";

export const SHIPPED_PROFILES: { id: string; text: string }[] = [
    { id: "cartesian-laser", text: laserText },
    { id: "mill-3axis", text: millText },
    { id: "polar-laser", text: polarText },
];

export const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ROLES = ["x", "y", "depth", "radius", "angle", "setup"];
const SOURCES = ["isolation", "clearing", "outline", "drills", "deposit", "paths"];
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
};
const LASER_SETTINGS: Record<string, Bounds> = {
    power: [0, MAX_VALUE, true],
    min_power: [0, MAX_VALUE, true],
    speed: [0, MAX_VALUE, false],
    height: [-1000, 1000, true],
};
const REQUIRED: Record<Tool, string[]> = { spindle: ["rpm", "feed"], laser: ["power", "speed"] };
const OPERATION_KEYS = ["name", "source", "tool", "enabled", "passes", "loops", "pattern", "fill", "marks", "match"];

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

    done(table: TomlTable, section: string | null, known: string[]): void {
        const unknown = Object.keys(table).filter((key) => !known.includes(key)).sort();
        if (unknown.length > 0) {
            throw this.fail(section, unknown[0]!, `is not a key here; the keys are ${[...known].sort().join(", ")}`);
        }
    }
}

function isTable(value: TomlValue | undefined): value is TomlTable {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The settings an operation cuts with: the tool's, its own over them, and the pass count. */
export function resolveCutting(tool: CamTool, settings: Record<string, CamSettingValue>): Record<string, number> {
    const cutting: Record<string, number> = {};
    const keys = [...Object.keys(tool.kind === "spindle" ? SPINDLE_SETTINGS : LASER_SETTINGS), "passes"];
    for (const key of keys) {
        const own = settings[key];
        if (typeof own === "number") {
            cutting[key] = own;
        } else if (tool.settings[key] !== undefined) {
            cutting[key] = tool.settings[key]!;
        }
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
    cutting["width"] = tool.width;
    return cutting;
}

export function parseProfile(text: string, id: string): CamProfile {
    const where = `${id}.toml`;
    let data: TomlTable;
    try {
        data = parseToml(text);
    } catch (error) {
        throw new Error(`${where}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const reader = new Reader(where);
    const name = reader.text(data, null, "name", id);
    const description = reader.text(data, null, "description", "");
    const machine = reader.text(data, null, "machine", "") || null;
    if (machine !== null && !ID_PATTERN.test(machine)) {
        throw reader.fail(null, "machine", "must be the stem of a file in machines/");
    }
    const axes = reader.tables(data, "axes").map((table, index) => readAxis(reader, table, index));
    const tools = reader.tables(data, "tools").map((table, index) => readTool(reader, table, index));
    for (const tool of tools) {
        if (tools.filter((other) => other.id === tool.id).length > 1) {
            throw reader.fail("[[tools]]", "id", `'${tool.id}' is given twice`);
        }
    }
    const operations = reader.tables(data, "operations").map((table, index) => readOperation(reader, table, index, tools));
    const post = readPost(reader, data);
    const placement = readPlacement(reader, data);
    reader.done(data, null, ["name", "description", "machine", "axes", "tools", "operations", "post", "placement"]);
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
    return { id, name, description, machine, kinematics, axes, tools, operations, post, placement };
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

function readTool(reader: Reader, table: TomlTable, index: number): CamTool {
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
    const width = diameter ?? spot;
    if (width === null) {
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
    for (const key of REQUIRED[kind]) {
        if (settings[key] === undefined) {
            throw reader.fail(section, key, "is needed");
        }
    }
    reader.done(table, section, ["id", "kind", "name", "diameter", "spot", "passes", ...Object.keys(bounds)]);
    return { id, kind, name, width, settings };
}

function readOperation(reader: Reader, table: TomlTable, index: number, tools: CamTool[]): CamOperation {
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
    reader.done(table, section, [...OPERATION_KEYS, ...Object.keys(bounds)]);
    const cutting = resolveCutting(tool, settings);
    if (tool.kind === "spindle" && cutting["passes"]! > MAX_PASSES) {
        throw reader.fail(section, "step_down", `gives more than ${MAX_PASSES} passes to the depth`);
    }
    return { name, source, tool: toolId, enabled, settings, cutting };
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
        throw new Error(`the change does not read as TOML: ${error instanceof Error ? error.message : String(error)}`);
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
    const lower = fileName.toLowerCase();
    const extension = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
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
                throw new Error(`not a job: ${error instanceof Error ? error.message : String(error)}`);
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
        case "gbr":
        case "gtl":
        case "gbl":
        case "gm1":
        case "kicad_pcb": {
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
        default:
            throw new Error(`cannot read ${fileName}: unknown file type '.${extension}'`);
    }
}

function shift(paths: Path[], dx: number, dy: number): Path[] {
    return paths.map((path) => path.map(([x, y]) => [x + dx, y + dy] as Point));
}

function place(geometry: Geometry, placement: CamPlacement): Geometry {
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
        sets: geometry.sets.map((set) => ({ label: set.label, paths: shift(set.paths, dx, dy) })),
        copper: shift(geometry.copper, dx, dy),
        outline: shift(geometry.outline, dx, dy),
        loops: geometry.loops.map((loop) => shift(loop, dx, dy)),
        drills: shift(geometry.drills, dx, dy),
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
    }
    const isolation = profile.operations.find((operation) => operation.source === "isolation");
    const toolOf = (operation: CamOperation): CamTool => profile.tools.find((tool) => tool.id === operation.tool)!;
    const spot = isolation ? toolOf(isolation).width : Math.min(...profile.tools.map((tool) => tool.width));
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
            groups.push(...taken.map((set) => groupOf(operation, tool, `${prefix}: ${set.label}`, set.paths)));
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
            case "outline":
                groups.push(groupOf(operation, tool, `${prefix}: board outline`, geometry.outline));
                break;
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

// --- gcode ----------------------------------------------------------------------------

/** A job as gcode for a cartesian profile, the way the backend's post writes it. */
export function camGcode(profile: CamProfile, job: Job): CamGcodeResponse {
    const x = profile.axes.find((axis) => axis.role === "x");
    const y = profile.axes.find((axis) => axis.role === "y");
    const depth = profile.axes.find((axis) => axis.role === "depth");
    if (!x || !y) {
        throw new Error("mock backend: the polar gcode writer needs the real backend");
    }
    const post = profile.post;
    const lines: string[] = [];
    const report: CamGcodeReport = { lines: 0, cuts: 0, length_mm: 0, seconds: 0, extents: {}, warnings: [] };
    const at: Record<string, number | undefined> = {};
    const num = (value: number): string => (Math.abs(value) < 10 ** -post.decimals ? 0 : value).toFixed(post.decimals);
    const warn = (text: string): void => {
        if (!report.warnings.includes(text)) {
            report.warnings.push(text);
        }
    };
    const reach = (axis: CamAxis, value: number): void => {
        const span = report.extents[axis.letter] ?? [value, value];
        report.extents[axis.letter] = [Math.min(span[0], value), Math.max(span[1], value)];
        if (axis.min !== null && value < axis.min - 1e-9) {
            warn(`${axis.letter} reaches ${value.toFixed(3)}, under its min ${axis.min}`);
        }
        if (axis.max !== null && value > axis.max + 1e-9) {
            warn(`${axis.letter} reaches ${value.toFixed(3)}, over its max ${axis.max}`);
        }
    };
    // A park or a home is written even where the axis already is, as the
    // backend's post writes it; a move on the way is left out when it goes nowhere.
    const word = (axis: CamAxis, value: number, always = false): string | null => {
        const before = at[axis.letter];
        if (!always && before !== undefined && Math.abs(before - value) <= 1e-9) {
            return null;
        }
        at[axis.letter] = value;
        reach(axis, value);
        return `${axis.letter}${num(value)}`;
    };
    const go = (words: (string | null)[]): void => {
        const kept = words.filter((w): w is string => w !== null);
        if (kept.length > 0) {
            lines.push(`G0 ${kept.join(" ")}`);
        }
    };
    let feed: number | null = null;
    let power: number | null = null;
    let output: [Tool, number] | null = null;
    const off = (): void => {
        if (output) {
            lines.push("M5");
            output = null;
            power = null;
        }
    };
    const cut = (point: Point, rate: number, s: number | null, label: string): void => {
        const before: [number | undefined, number | undefined] = [at[x.letter], at[y.letter]];
        const words = [word(x, point[0] + x.offset), word(y, point[1] + y.offset)].filter((w): w is string => w !== null);
        if (words.length === 0) {
            return;
        }
        const capped = Math.min(rate, x.rate ?? rate, y.rate ?? rate);
        if (capped < rate) {
            warn(`${label}: ${rate} mm/min is over the axes' rate; written as ${capped}`);
        }
        if (feed !== capped) {
            words.push(`F${num(capped)}`);
            feed = capped;
        }
        if (s !== null && power !== s) {
            words.push(`S${s}`);
            power = s;
        }
        lines.push(`G1 ${words.join(" ")}`);
        const dx = before[0] === undefined ? 0 : point[0] + x.offset - before[0];
        const dy = before[1] === undefined ? 0 : point[1] + y.offset - before[1];
        const length = Math.hypot(dx, dy);
        report.cuts++;
        report.length_mm += length;
        report.seconds += (length / capped) * 60;
    };
    const safeZ = (): number => (depth ? depth.offset + (depth.safe ?? 0) : 0);
    const plunge = (over: number, rate: number): void => {
        if (!depth) {
            return;
        }
        const w = word(depth, depth.offset + over);
        if (w === null) {
            return;
        }
        const capped = Math.min(rate, depth.rate ?? rate);
        const words = [w];
        if (feed !== capped) {
            words.push(`F${num(capped)}`);
            feed = capped;
        }
        lines.push(`G1 ${words.join(" ")}`);
    };

    const enabled = job.groups.filter((group) => group.enabled && group.paths.length > 0);
    lines.push(`(${job.name}: ${enabled.length} operations through ${profile.name})`);
    lines.push(`(board X/Y on ${profile.axes.map((axis) => `${axis.letter}=${axis.role}`).join(" ")})`);
    lines.push(...post.header);
    if (depth) {
        go([word(depth, safeZ())]);
    }
    const parks = profile.axes.filter((axis) => axis.role === "setup" && axis.park !== null);
    if (parks.length > 0) {
        go(parks.map((axis) => word(axis, axis.park!, true)));
    }
    for (const group of enabled) {
        lines.push(`(${group.label}: ${group.paths.length} paths)`);
        const kind: Tool = group.tool ?? profile.tools[0]!.kind;
        if (kind === "spindle") {
            if (!depth) {
                throw new Error(`${group.label}: a spindle operation needs a depth axis in the profile`);
            }
            if (!(group.power > 0)) {
                throw new Error(`${group.label}: a spindle needs a speed above 0`);
            }
            if (!output || output[0] !== "spindle" || output[1] !== group.power) {
                if (output && output[0] !== "spindle") {
                    off();
                }
                lines.push(`${post.spindle_on} S${group.power}`);
                output = ["spindle", group.power];
                if (post.spinup > 0) {
                    lines.push(`G4 P${post.spinup}`);
                    report.seconds += post.spinup;
                }
            }
            const passes = Math.max(1, group.passes);
            for (let k = 1; k <= passes; k++) {
                const cutDepth = ((group.depth ?? DEFAULT_DEPTH) * k) / passes;
                for (const path of group.paths) {
                    const first = path[0];
                    if (!first) {
                        continue;
                    }
                    go([word(depth, safeZ())]);
                    go([word(x, first[0] + x.offset), word(y, first[1] + y.offset)]);
                    plunge(-cutDepth, group.plunge ?? DEFAULT_PLUNGE);
                    for (const point of path.slice(1)) {
                        cut(point, group.speed, null, group.label);
                    }
                    go([word(depth, safeZ())]);
                }
            }
        } else {
            if (group.min_power > 0) {
                warn(`${group.label}: the power floor ${group.min_power} has no gcode word and is left out`);
            }
            if (depth) {
                go([word(depth, safeZ())]);
            }
            if (!output || output[0] !== "laser") {
                off();
                lines.push(`${post.laser_on} S0`);
                output = ["laser", 0];
                power = 0;
            }
            for (let pass = 0; pass < Math.max(1, group.passes); pass++) {
                for (const path of group.paths) {
                    const first = path[0];
                    if (!first || path.length < 2) {
                        continue;
                    }
                    go([word(x, first[0] + x.offset), word(y, first[1] + y.offset)]);
                    for (const point of path.slice(1)) {
                        cut(point, group.speed, group.power, group.label);
                    }
                }
            }
        }
    }
    off();
    if (depth) {
        go([word(depth, safeZ())]);
    }
    if (post.return_home) {
        const homes = profile.axes.filter((axis) => axis.home !== null && axis.role !== "depth");
        if (homes.length > 0) {
            go(homes.map((axis) => word(axis, axis.home!, true)));
        }
        if (depth && depth.home !== null) {
            go([word(depth, depth.home, true)]);
        }
    }
    lines.push(...post.footer);
    report.lines = lines.length;
    report.length_mm = Math.round(report.length_mm * 1000) / 1000;
    report.seconds = Math.round(report.seconds * 10) / 10;
    const stem = job.name.replace(/[^A-Za-z0-9_.-]/g, "_") || "job";
    return { text: lines.join("\n") + "\n", report, filename: `${stem}.nc` };
}
