// Where each firmware setting is written in a machine file: the page's twin
// of spinny_laser.machine_keys. The Config page lists every key with the
// file's value beside the board's, and the mock reads a board into a file
// with it. The table is checked against the fixture the Python prints
// (mise run keys-fixture), and so is a board read into a sample file.

/** How a key's value sits in its setting. */
export type KeyKind = "number" | "integer" | "flag" | "bit" | "word" | "socket" | "scale" | "kinematics" | "tool" | "host";

export interface MachineKey {
    /** The firmware setting, or for the host's own values `host.<key>`. */
    setting: string;
    /** The file's section, null for its top; `table` stands for `dispenser` on a dispenser. */
    section: string | null;
    key: string;
    kind: KeyKind;
    /** The bit of a mask, or the digit of `sockets`, counted from 0. */
    bit: number;
}

export type KeyValue = number | boolean | string | null;

const ENDSTOPS = ["none", "min", "max", "both"];
const SOCKETS = ["X", "Y", "Z", "E"];
/** The `[drivers]` keys of the drivers' register fields, each its setting's name less the `tmc_`, as spinny_laser.machines.TUNING_KEYS. */
const TUNING_KEYS = ["toff", "tbl", "hstrt", "hend", "hold_delay", "tpowerdown", "tpwmthrs"];
/** Section, axis letter, the firmware's scale key and the axis's bit, as spinny_laser.machines.AXES. */
const AXES: [string, string, string, number][] = [
    ["rail", "r", "steps_per_mm", 0],
    ["table", "a", "steps_per_deg", 1],
    ["slide", "z", "steps_per_mm", 2],
    ["focus", "h", "steps_per_mm", 3],
];

function key(setting: string, section: string | null, name: string, kind: KeyKind, bit = 0): MachineKey {
    return { setting, section, key: name, kind, bit };
}

function axisKeys(section: string, axis: string, bit: number, scaleKey: string): MachineKey[] {
    const keys = [
        key(`${axis}_steps`, section, `full_${scaleKey}`, "scale"),
        key(`${axis}_rate`, section, "max_rate", "number"),
        key(`${axis}_accel`, section, "accel", "number"),
        key(`${axis}_jerk`, section, "jerk", "number"),
        key(`jog_${axis}`, section, "jog_rate", "number"),
    ];
    if (axis === "r" || axis === "z") {
        keys.push(key(`${axis}_max`, section, "limit", "number"));
    }
    if (axis === "h") {
        keys.unshift(key("h_axis", section, "fitted", "flag"));
    }
    keys.push(
        key("dir_invert", section, "invert", "bit", bit),
        key(`tmc_${axis}_ma`, section, "current_ma", "integer"),
        key(`tmc_${axis}_micro`, section, "microsteps", "integer"),
        key("sockets", section, "socket", "socket", bit),
        key(`${axis}_stop`, section, "endstop", "word"),
        key(`${axis}_stop_pin`, section, "endstop_pin", "integer"),
        key("stop_invert", section, "endstop_invert", "bit", bit),
        key("limits", section, "endstop_halt", "bit", bit),
        key(`${axis}_home_pull`, section, "home_pull", "number"),
        key(`${axis}_home_pos`, section, "home_pos", "number"),
        key(`${axis}_home_travel`, section, "home_travel", "number"),
    );
    return keys;
}

export const MACHINE_KEYS: MachineKey[] = [
    key("cartesian", null, "kinematics", "kinematics"),
    key("spindle", null, "tool", "tool"),
    ...AXES.flatMap(([section, axis, scaleKey, bit]) => axisKeys(section, axis, bit, scaleKey)),
    key("probe_invert", "probe", "invert", "flag"),
    key("probe_ms", "probe", "brake_ms", "integer"),
    key("probe_pin", "probe", "pin", "integer"),
    key("laser_hz", "output", "pwm_hz", "integer"),
    key("s_max", "output", "s_max", "number"),
    key("s_min", "output", "s_min", "number"),
    key("laser_invert", "output", "invert", "flag"),
    key("laser_ms", "output", "test_ms", "integer"),
    key("laser_pin", "output", "pin", "integer"),
    key("tool_out", "enable", "fitted", "flag"),
    key("tool_pin", "enable", "pin", "integer"),
    key("tool_invert", "enable", "invert", "flag"),
    key("en_invert", "drivers", "enable_invert", "flag"),
    key("idle_ms", "drivers", "idle_ms", "integer"),
    key("step_us", "drivers", "step_us", "integer"),
    key("tmc_hold_pct", "drivers", "hold_pct", "integer"),
    key("tmc_stealth", "drivers", "stealth", "flag"),
    key("tmc_intpol", "drivers", "interpolate", "flag"),
    ...TUNING_KEYS.map((name) => key(`tmc_${name}`, "drivers", name, "integer")),
    ...["tolerance", "travel", "clearance", "spinup", "speed_control", "gap", "retract", "output", "extrude_rate", "dwell_ms"].map((name) => key(`host.${name}`, "host", name, "host")),
];

/** The section a key is in for a machine with this tool. */
export function sectionFor(entry: MachineKey, tool: string): string | null {
    return entry.section === "table" && tool === "dispenser" ? "dispenser" : entry.section;
}

/** The key's value as a file would say it, read from a full set of settings (and the host's values for a host key); null when they do not hold it. */
export function valueOf(entry: MachineKey, settings: Record<string, number>, host: Record<string, unknown> | null = null): KeyValue {
    if (entry.kind === "host") {
        const value = host?.[entry.key];
        return typeof value === "number" || typeof value === "boolean" ? value : null;
    }
    if (!(entry.setting in settings) && entry.kind !== "tool") {
        return null;
    }
    if (entry.kind === "kinematics") {
        return settings["cartesian"] ? "cartesian" : "polar";
    }
    if (entry.kind === "tool") {
        if (settings["spindle"]) {
            return "spindle";
        }
        return settings["dispenser"] ? "dispenser" : "laser";
    }
    const value = settings[entry.setting]!;
    switch (entry.kind) {
        case "flag":
            return Boolean(value);
        case "bit":
            return Boolean((Math.trunc(value) >> entry.bit) & 1);
        case "word":
            return ENDSTOPS[Math.trunc(value)] ?? null;
        case "socket": {
            const digits = String(Math.trunc(value));
            if (digits.length !== SOCKETS.length || entry.bit >= digits.length) {
                return null;
            }
            return SOCKETS[Number(digits[entry.bit]) - 1] ?? null;
        }
        case "integer":
            return Math.trunc(value);
        default:
            return value;
    }
}

/** Equal as a setting read back from the firmware can tell: a 32 bit float printed to three decimals. */
export function closeTo(a: number, b: number): boolean {
    return Math.abs(a - b) <= Math.max(1e-6 * Math.max(Math.abs(a), Math.abs(b)), 5e-4);
}

/** Equal as a key's value, numbers as far as the firmware can tell. */
export function sameValue(a: KeyValue, b: KeyValue): boolean {
    if (typeof a === "number" && typeof b === "number") {
        return closeTo(a, b);
    }
    return a === b;
}

export function tomlValue(value: KeyValue): string {
    if (typeof value === "boolean") {
        return value ? "true" : "false";
    }
    if (typeof value === "string") {
        return `"${value}"`;
    }
    if (value === null) {
        return "unset";
    }
    if (Number.isInteger(value) && Math.abs(value) < 1e15) {
        return String(value);
    }
    return value.toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
}

// --- the text ----------------------------------------------------------------

const HEADER = /^\s*\[\[?\s*([A-Za-z0-9_.-]+)\s*\]\]?\s*(#.*)?$/;

function escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A value and the comment after it, the `#` outside any string. */
function splitComment(rest: string): [string, string] {
    let quote: string | null = null;
    let escaped = false;
    for (let i = 0; i < rest.length; i += 1) {
        const char = rest[i]!;
        if (quote) {
            if (escaped) {
                escaped = false;
            } else if (char === "\\" && quote === '"') {
                escaped = true;
            } else if (char === quote) {
                quote = null;
            }
        } else if (char === '"' || char === "'") {
            quote = char;
        } else if (char === "#") {
            return [rest.slice(0, i), rest.slice(i)];
        }
    }
    return [rest, ""];
}

/** Each section as [name, first line after its header, end], the top first with no header. */
function sections(lines: string[]): [string | null, number, number][] {
    const spans: [string | null, number, number][] = [];
    let name: string | null = null;
    let start = 0;
    lines.forEach((line, i) => {
        const found = HEADER.exec(line);
        if (found) {
            spans.push([name, start, i]);
            name = found[1]!;
            start = i + 1;
        }
    });
    spans.push([name, start, lines.length]);
    return spans;
}

/** The line of `key` in its section, counted from 0, or null where the file leaves it out. */
export function keyLine(text: string, section: string | null, name: string): number | null {
    const lines = text.split("\n");
    const pattern = new RegExp(`^\\s*${escapeRegex(name)}\\s*=`);
    for (const [found, a, b] of sections(lines)) {
        if (found !== section) {
            continue;
        }
        for (let i = a; i < b; i += 1) {
            if (pattern.test(lines[i]!)) {
                return i;
            }
        }
    }
    return null;
}

export function hasKey(text: string, section: string | null, name: string): boolean {
    return keyLine(text, section, name) !== null;
}

/**
 * The text with `key = value` in its section: the line's value replaced
 * and its comment kept, or a line added after the section's last key, or
 * the section added before [controls] (or at the end).
 */
export function setKey(text: string, section: string | null, name: string, value: KeyValue): string {
    const lines = text.split("\n");
    const written = tomlValue(value);
    const pattern = new RegExp(`^(\\s*${escapeRegex(name)}\\s*=\\s*)(.*)$`);
    const spans = sections(lines);
    for (const [found, a, b] of spans) {
        if (found !== section) {
            continue;
        }
        for (let i = a; i < b; i += 1) {
            const match = pattern.exec(lines[i]!);
            if (match) {
                const [old, comment] = splitComment(match[2]!);
                if (comment) {
                    // The comment stays in its column where the value fits.
                    const width = old.length;
                    lines[i] = match[1]! + written.padEnd(written.length < width ? width - 1 : written.length) + " " + comment;
                } else {
                    lines[i] = match[1]! + written;
                }
                return lines.join("\n");
            }
        }
        let last = a - 1;
        for (let i = a; i < b; i += 1) {
            const stripped = lines[i]!.trim();
            if (stripped && !stripped.startsWith("#")) {
                last = i;
            }
        }
        if (section === null && last < a) {
            // A top with no keys: after its leading comments.
            let first = b;
            for (let i = a; i < b; i += 1) {
                if (!lines[i]!.trim().startsWith("#")) {
                    first = i;
                    break;
                }
            }
            last = first - 1;
        }
        lines.splice(last + 1, 0, `${name} = ${written}`);
        return lines.join("\n");
    }
    const block = [`[${section}]`, `${name} = ${written}`, ""];
    const controls = spans.find(([found]) => found !== null && (found === "controls" || found.startsWith("controls.")));
    if (!controls) {
        while (lines.length > 0 && lines[lines.length - 1] === "") {
            lines.pop();
        }
        return [...lines, "", ...block].join("\n");
    }
    lines.splice(controls[1] - 1, 0, ...block);
    return lines.join("\n");
}

/** What reading a board into a file gave: the text, a line per key written, and the settings it still does not give the board's value for. */
export interface FromBoard {
    text: string;
    changes: string[];
    left: string[];
}

/** What a machine file reads as, as far as reading a board into it needs. */
export interface ReadMachine {
    tool: string;
    settings: Record<string, number>;
    host: Record<string, number | boolean | null | undefined>;
}

/**
 * The text with every key whose value differs from the board's written to
 * the board's value, as spinny_laser.machine_keys.from_board writes it. A
 * scale goes in the key the section already uses, else as full steps over
 * the board's microsteps; a [host] key only where the file names it. `parse`
 * reads a text as a machine, and throws what is wrong with one that does not.
 */
export function fromBoard(text: string, live: Record<string, number>, host: Record<string, unknown> | null, parse: (text: string) => ReadMachine, where: string): FromBoard {
    const machine = parse(text);
    const boardTool = valueOf(MACHINE_KEYS[1]!, live) as string;
    if ((machine.tool === "dispenser" || boardTool === "dispenser") && machine.tool !== boardTool) {
        throw new Error(
            `${where}: the board runs a ${boardTool} and the file a ${machine.tool}:`
            + " the dispenser's plunger takes the [table]'s place, so change the tool and that section by hand",
        );
    }
    const changes: string[] = [];
    for (const entry of MACHINE_KEYS) {
        let board: KeyValue;
        let mine: KeyValue;
        if (entry.kind === "host") {
            const given = host?.[entry.key];
            if (!hasKey(text, entry.section, entry.key) || given === null || given === undefined) {
                continue;
            }
            const own = machine.host[entry.key];
            board = entry.key === "speed_control" ? Boolean(given) : (given as number);
            mine = own === undefined || own === null ? null : entry.key === "speed_control" ? Boolean(own) : own;
        } else {
            board = valueOf(entry, live);
            mine = valueOf(entry, machine.settings);
        }
        if (board === null) {
            continue;
        }
        const section = sectionFor(entry, machine.tool);
        let name = entry.key;
        if (entry.kind === "scale") {
            let plain = name.replace(/^full_/, "");
            if (section === "dispenser") {
                plain = "steps_per_mm";
                name = "full_steps_per_mm";
            }
            const axis = entry.setting[0]!;
            if (hasKey(text, section, plain)) {
                name = plain;
            } else {
                // Compared as full steps: the same steps per mm at other
                // microsteps are other full steps, and the same full steps
                // at other microsteps need no line of their own.
                board = (board as number) / (live[`tmc_${axis}_micro`] ?? 256);
                mine = (mine as number) / machine.settings[`tmc_${axis}_micro`]!;
            }
        }
        if (sameValue(board, mine)) {
            continue;
        }
        text = setKey(text, section, name, board);
        const at = section ? `[${section}] ${name}` : name;
        changes.push(`${at} = ${tomlValue(board)} (was ${mine === null ? "unset" : tomlValue(mine)})`);
    }
    const after = parse(text);
    const left = Object.entries(live)
        .filter(([name, value]) => name in after.settings && typeof value === "number" && !closeTo(value, after.settings[name]!))
        .map(([name]) => name);
    return { text, changes, left };
}

/**
 * How well a query matches a text, higher for a better match, or null for
 * none: the query's characters in order, case aside, with runs of them
 * together, matches at word starts, the query found whole and an early
 * first match worth more.
 */
export function fuzzyScore(query: string, text: string): number | null {
    const wanted = query.toLowerCase().replace(/\s+/g, "");
    if (wanted === "") {
        return 0;
    }
    const haystack = text.toLowerCase();
    let score = 0;
    let at = 0;
    let previous = -2;
    let first = -1;
    for (const char of wanted) {
        const found = haystack.indexOf(char, at);
        if (found < 0) {
            return null;
        }
        if (first < 0) {
            first = found;
        }
        score += found === previous + 1 ? 3 : 1;
        if (found === 0 || /[\s_.[\]=]/.test(haystack[found - 1]!)) {
            score += 2;
        }
        previous = found;
        at = found + 1;
    }
    // The query whole, as typed, is worth more than its letters apart.
    const whole = haystack.indexOf(wanted);
    if (whole >= 0) {
        score += 2 * wanted.length;
        first = Math.min(first, whole);
    }
    return score - first / 100;
}
