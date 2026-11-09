// A job as editable JSON text, and where in the job a place in that text
// is: the JSON panel shows the selected job with every path on a line of
// its own, so a board of thousands of points stays a few hundred lines,
// and the caret's place names the group, path and point the preview
// highlights. Both work on any JSON text, edited or not.

/** A step into a JSON value: a key of an object or an index of an array. */
export type JsonStep = string | number;

/** An array of numbers: a point, written on one line. */
function isFlat(value: unknown): boolean {
    return Array.isArray(value) && value.every((item) => typeof item === "number" || item === null);
}

/** An array of points (or of nothing): a path, written on one line. */
function isLine(value: unknown): boolean {
    return Array.isArray(value) && value.every(isFlat);
}

/**
 * The value as JSON, indented by four spaces, with every array of numbers
 * (a point) and every array of points (a path) kept on one line; the
 * rest, objects and arrays of paths, one entry a line.
 */
export function formatJson(value: unknown, indent = ""): string {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value) ?? "null";
    }
    const flat = (point: unknown[]): string => `[${point.map((item) => JSON.stringify(item)).join(", ")}]`;
    if (isFlat(value)) {
        return flat(value as unknown[]);
    }
    if (isLine(value)) {
        return `[${(value as unknown[][]).map(flat).join(", ")}]`;
    }
    const inner = `${indent}    `;
    if (Array.isArray(value)) {
        if (value.length === 0) {
            return "[]";
        }
        return `[\n${value.map((item) => `${inner}${formatJson(item, inner)}`).join(",\n")}\n${indent}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined);
    if (entries.length === 0) {
        return "{}";
    }
    return `{\n${entries.map(([key, item]) => `${inner}${JSON.stringify(key)}: ${formatJson(item, inner)}`).join(",\n")}\n${indent}}`;
}

interface Container {
    kind: "object" | "array";
    /** The key of the entry being read, in an object; null between entries. */
    key: string | null;
    /** The index of the entry being read, in an array; -1 before the first. */
    index: number;
    /** An object: the next string is a key, not a value. */
    expectKey: boolean;
}

/**
 * The steps into the JSON value at `offset` in `text`: the keys and indices
 * of the containers round it, so a caret inside the third point of the
 * second path of group 1 is ["groups", 1, "paths", 1, 2] and then the index
 * of the number. The text is read up to `offset` only, so text that does
 * not parse past the caret (being typed) still answers.
 */
export function stepsAt(text: string, offset: number): JsonStep[] {
    const stack: Container[] = [];
    const end = Math.max(0, Math.min(offset, text.length));
    // An array's entry begins at its first character that is not space: a
    // caret on a value's first character is inside it.
    let i = 0;
    const startEntry = (): void => {
        const top = stack[stack.length - 1];
        if (top && top.kind === "array" && top.index < 0) {
            top.index = 0;
        }
    };
    while (i < end) {
        const char = text[i]!;
        if (char === '"') {
            const top = stack[stack.length - 1];
            let j = i + 1;
            let raw = "";
            while (j < text.length && text[j] !== '"') {
                if (text[j] === "\\") {
                    raw += text.slice(j, j + 2);
                    j += 2;
                    continue;
                }
                raw += text[j];
                j += 1;
            }
            if (top && top.kind === "object" && top.expectKey) {
                try {
                    top.key = JSON.parse(`"${raw}"`) as string;
                } catch {
                    top.key = raw;
                }
                top.expectKey = false;
            } else {
                startEntry();
            }
            i = j + 1;
            continue;
        }
        if (char === "{" || char === "[") {
            startEntry();
            stack.push({ kind: char === "{" ? "object" : "array", key: null, index: -1, expectKey: char === "{" });
        } else if (char === "}" || char === "]") {
            stack.pop();
        } else if (char === ",") {
            const top = stack[stack.length - 1];
            if (top?.kind === "array") {
                top.index += 1;
            } else if (top) {
                top.key = null;
                top.expectKey = true;
            }
        } else if (!" \n\r\t:".includes(char)) {
            startEntry();
        }
        i += 1;
    }
    // A later entry's index is set by the comma before it, the first's by
    // its first character, which a caret on that character has not read:
    // the entry begins there all the same, as `offsetOf` has it.
    if (end < text.length && !" \n\r\t]".includes(text[end]!)) {
        startEntry();
    }
    const steps: JsonStep[] = [];
    for (const container of stack) {
        if (container.kind === "object") {
            if (container.key === null) {
                break;
            }
            steps.push(container.key);
        } else {
            if (container.index < 0) {
                break;
            }
            steps.push(container.index);
        }
    }
    return steps;
}

/**
 * Where the value at `steps` begins in `text`, or null when the text has no
 * such value: the counterpart of `stepsAt`, for putting the caret on a
 * path picked in the preview.
 */
export function offsetOf(text: string, steps: JsonStep[]): number | null {
    if (steps.length === 0) {
        return text.search(/\S/) >= 0 ? text.search(/\S/) : null;
    }
    const stack: Container[] = [];
    const matches = (): boolean => {
        if (stack.length !== steps.length) {
            return false;
        }
        return stack.every((container, depth) => (container.kind === "object" ? container.key : container.index) === steps[depth]);
    };
    // Whether the containers so far are on the way to the steps.
    const onTheWay = (): boolean => stack.every((container, depth) => depth >= steps.length || (container.kind === "object" ? container.key : container.index) === steps[depth]);
    for (let i = 0; i < text.length; i++) {
        const char = text[i]!;
        const top = stack[stack.length - 1];
        const entryStart = top !== undefined && top.kind === "array" && top.index < 0 && !" \n\r\t".includes(char) && char !== "]";
        if (entryStart) {
            top!.index = 0;
        }
        if (char === '"') {
            let j = i + 1;
            let raw = "";
            while (j < text.length && text[j] !== '"') {
                if (text[j] === "\\") {
                    raw += text.slice(j, j + 2);
                    j += 2;
                    continue;
                }
                raw += text[j];
                j += 1;
            }
            if (top && top.kind === "object" && top.expectKey) {
                try {
                    top.key = JSON.parse(`"${raw}"`) as string;
                } catch {
                    top.key = raw;
                }
                top.expectKey = false;
            } else if (matches()) {
                return i;
            }
            i = j;
            continue;
        }
        if ((char === "{" || char === "[") && matches()) {
            return i;
        }
        if (char === "{" || char === "[") {
            if (!onTheWay()) {
                // Not on the way: skip the whole value.
                let depth = 0;
                let j = i;
                for (; j < text.length; j++) {
                    const c = text[j]!;
                    if (c === '"') {
                        j += 1;
                        while (j < text.length && text[j] !== '"') {
                            j += text[j] === "\\" ? 2 : 1;
                        }
                    } else if (c === "{" || c === "[") {
                        depth += 1;
                    } else if (c === "}" || c === "]") {
                        depth -= 1;
                        if (depth === 0) {
                            break;
                        }
                    }
                }
                i = j;
                continue;
            }
            stack.push({ kind: char === "{" ? "object" : "array", key: null, index: -1, expectKey: char === "{" });
        } else if (char === "}" || char === "]") {
            stack.pop();
        } else if (char === ",") {
            if (top?.kind === "array") {
                top.index += 1;
            } else if (top) {
                top.key = null;
                top.expectKey = true;
            }
        } else if (!" \n\r\t:".includes(char) && matches()) {
            return i;
        }
    }
    return null;
}

/** Where a place in a job's JSON lies on the board: a group's path or the outline's or copper's, and the point in it when the place is inside one. */
export interface JobPlace {
    list: "groups" | "outline" | "copper";
    /** The group's index, for a group's path. */
    group: number | null;
    path: number;
    point: number | null;
}

/** The path (and point) of the job the steps lead into; null for anywhere else (a group's settings, the stats). */
export function placeOf(steps: JsonStep[]): JobPlace | null {
    const [head] = steps;
    if (head === "groups") {
        const [, group, key, path, point] = steps;
        if (typeof group !== "number" || key !== "paths" || typeof path !== "number") {
            return null;
        }
        return { list: "groups", group, path, point: typeof point === "number" ? point : null };
    }
    if (head === "outline" || head === "copper") {
        const [, path, point] = steps;
        if (typeof path !== "number") {
            return null;
        }
        return { list: head, group: null, path, point: typeof point === "number" ? point : null };
    }
    return null;
}

/** The line and column (both from 1) of an offset, for a parse error's place. */
export function lineColumn(text: string, offset: number): { line: number; column: number } {
    const before = text.slice(0, Math.max(0, offset));
    const lines = before.split("\n");
    return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}
