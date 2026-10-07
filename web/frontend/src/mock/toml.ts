// A small TOML reader for the in-page mock: enough of the format for the
// CAM profiles and the machine files (tables, arrays of tables, dotted
// table names one level deep, inline tables, strings, numbers, booleans
// and arrays of those), the line named in every refusal. The backend reads
// the language in full; this reads what the shipped files and the page
// write.

export class TomlError extends Error {
    constructor(line: number, text: string) {
        super(`line ${line}: ${text}`);
        this.name = "TomlError";
    }
}

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;

export interface TomlTable {
    [key: string]: TomlValue;
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const NUMBER = /^[+-]?(\d[\d_]*)(\.\d[\d_]*)?([eE][+-]?\d+)?$/;

/** The text up to a `#` outside a string, trailing space dropped. */
export function stripComment(line: string): string {
    let quote: string | null = null;
    for (let i = 0; i < line.length; i++) {
        const char = line[i]!;
        if (quote !== null) {
            if (char === "\\" && quote === '"') {
                i++;
            } else if (char === quote) {
                quote = null;
            }
        } else if (char === '"' || char === "'") {
            quote = char;
        } else if (char === "#") {
            return line.slice(0, i).trimEnd();
        }
    }
    return line.trimEnd();
}

/** The depth of open brackets at the end of a line, strings not counted. */
function openBrackets(text: string): number {
    let depth = 0;
    let quote: string | null = null;
    for (let i = 0; i < text.length; i++) {
        const char = text[i]!;
        if (quote !== null) {
            if (char === "\\" && quote === '"') {
                i++;
            } else if (char === quote) {
                quote = null;
            }
        } else if (char === '"' || char === "'") {
            quote = char;
        } else if (char === "[") {
            depth++;
        } else if (char === "]") {
            depth--;
        }
    }
    return depth;
}

export function parseToml(text: string): TomlTable {
    const root: TomlTable = {};
    let current: TomlTable = root;
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
        const number = index + 1;
        let line = stripComment(lines[index]!).trim();
        if (line === "") {
            continue;
        }
        let header = /^\[\[\s*([^\]]+?)\s*\]\]$/.exec(line);
        if (header) {
            const [parent, name] = tablePath(root, header[1]!, number);
            const list = parent[name];
            if (list === undefined) {
                parent[name] = [];
            } else if (!Array.isArray(list)) {
                throw new TomlError(number, `${name} is a key and a table at once`);
            }
            const table: TomlTable = {};
            (parent[name] as TomlValue[]).push(table);
            current = table;
            continue;
        }
        header = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
        if (header) {
            const [parent, name] = tablePath(root, header[1]!, number);
            if (parent[name] !== undefined) {
                throw new TomlError(number, `[${header[1]}] is defined twice`);
            }
            const table: TomlTable = {};
            parent[name] = table;
            current = table;
            continue;
        }
        const pair = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
        if (!pair) {
            throw new TomlError(number, "expected key = value");
        }
        const key = pair[1]!;
        if (!BARE_KEY.test(key)) {
            throw new TomlError(number, `the mock reads plain keys only, not ${key}`);
        }
        let value = pair[2]!;
        // An array may run over several lines; the lines are joined until
        // its brackets close.
        while (openBrackets(value) > 0 && index + 1 < lines.length) {
            index++;
            value += " " + stripComment(lines[index]!).trim();
        }
        if (value === "") {
            throw new TomlError(number, `${key} has no value`);
        }
        if (key in current) {
            throw new TomlError(number, `${key} is given twice`);
        }
        current[key] = parseValue(value, number);
    }
    return root;
}

/**
 * Where a table header lands: its parent table and its last name. A dotted
 * name, `[[controls.axes]]`, goes one level down into a table that must be
 * there already or is made; deeper names are not read.
 */
function tablePath(root: TomlTable, header: string, line: number): [TomlTable, string] {
    const parts = header.split(".").map((part) => part.trim());
    if (parts.length > 2 || !parts.every((part) => BARE_KEY.test(part))) {
        throw new TomlError(line, `the mock reads plain table names only, not [${header}]`);
    }
    if (parts.length === 1) {
        return [root, parts[0]!];
    }
    const outer = root[parts[0]!];
    if (outer === undefined) {
        const made: TomlTable = {};
        root[parts[0]!] = made;
        return [made, parts[1]!];
    }
    if (Array.isArray(outer) || typeof outer !== "object") {
        throw new TomlError(line, `${parts[0]} is not a table to put ${parts[1]} in`);
    }
    return [outer, parts[1]!];
}

function parseValue(text: string, line: number): TomlValue {
    text = text.trim();
    if (text === "true" || text === "false") {
        return text === "true";
    }
    if (text.startsWith('"')) {
        return basicString(text, line);
    }
    if (text.startsWith("'")) {
        if (!text.endsWith("'") || text.length < 2) {
            throw new TomlError(line, "a string is not closed");
        }
        return text.slice(1, -1);
    }
    if (text.startsWith("[")) {
        if (!text.endsWith("]")) {
            throw new TomlError(line, "an array is not closed");
        }
        return splitArray(text.slice(1, -1), line).map((item) => parseValue(item, line));
    }
    // An inline table, { key = value, ... }, on one line.
    if (text.startsWith("{")) {
        if (!text.endsWith("}")) {
            throw new TomlError(line, "an inline table is not closed");
        }
        const table: TomlTable = {};
        for (const item of splitArray(text.slice(1, -1), line)) {
            const pair = /^\s*([^=]+?)\s*=\s*(.*)$/.exec(item);
            if (!pair || !BARE_KEY.test(pair[1]!)) {
                throw new TomlError(line, `expected key = value in the inline table, not ${item.trim()}`);
            }
            if (pair[1]! in table) {
                throw new TomlError(line, `${pair[1]} is given twice`);
            }
            table[pair[1]!] = parseValue(pair[2]!, line);
        }
        return table;
    }
    if (NUMBER.test(text)) {
        const value = Number(text.replace(/_/g, ""));
        if (!Number.isFinite(value)) {
            throw new TomlError(line, `${text} is not a number the mock reads`);
        }
        return value;
    }
    throw new TomlError(line, `cannot read the value ${text}`);
}

function basicString(text: string, line: number): string {
    let out = "";
    for (let i = 1; i < text.length; i++) {
        const char = text[i]!;
        if (char === "\\") {
            const next = text[++i];
            const escapes: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", b: "\b", f: "\f" };
            if (next === undefined || !(next in escapes)) {
                throw new TomlError(line, `unknown escape \\${next ?? ""}`);
            }
            out += escapes[next];
        } else if (char === '"') {
            if (i !== text.length - 1) {
                throw new TomlError(line, "text after the closing quote");
            }
            return out;
        } else {
            out += char;
        }
    }
    throw new TomlError(line, "a string is not closed");
}

function splitArray(inner: string, line: number): string[] {
    const items: string[] = [];
    let depth = 0;
    let quote: string | null = null;
    let start = 0;
    for (let i = 0; i < inner.length; i++) {
        const char = inner[i]!;
        if (quote !== null) {
            if (char === "\\" && quote === '"') {
                i++;
            } else if (char === quote) {
                quote = null;
            }
        } else if (char === '"' || char === "'") {
            quote = char;
        } else if (char === "[" || char === "{") {
            depth++;
        } else if (char === "]" || char === "}") {
            depth--;
            if (depth < 0) {
                throw new TomlError(line, "an array closes before it opens");
            }
        } else if (char === "," && depth === 0) {
            items.push(inner.slice(start, i));
            start = i + 1;
        }
    }
    const last = inner.slice(start);
    if (last.trim() !== "") {
        items.push(last);
    }
    return items.filter((item) => item.trim() !== "");
}
