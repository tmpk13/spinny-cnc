// Syntax coloring for the TOML editors: the text as HTML, a span per token,
// for the layer drawn under the transparent text of the editor. Comments,
// table headers, keys, strings, numbers, booleans and punctuation each get
// a class; what is none of those is left as it is. The coloring follows the
// text's shape line by line and never refuses anything, so a text being
// typed looks right up to the point being typed.

const BOOLEAN = /^(true|false)$/;
const NUMBER = /^[+-]?(inf|nan|0x[0-9A-Fa-f_]+|0o[0-7_]+|0b[01_]+|\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?)$/;
/** A date or a time, which TOML also writes bare: 2026-10-08, 07:32:00, 2026-10-08T07:32:00Z. */
const DATE = /^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})?)?$|^\d{2}:\d{2}:\d{2}(\.\d+)?$/;
const BARE = /[A-Za-z0-9_\-+.:]/;

export function escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function span(kind: string, text: string): string {
    return text === "" ? "" : `<span class="tk-${kind}">${escapeHtml(text)}</span>`;
}

/** What carries over from one line to the next: open arrays and inline tables. */
export interface LineState {
    /** Open `[` of arrays, and `{` of inline tables, outside strings. */
    depth: number;
    /** Inside an inline table the next bare word before `=` is a key. */
    braces: number;
}

/** The end of a quoted string that starts at `from` (on the quote), or the line's end. */
function stringEnd(line: string, from: number): number {
    const quote = line[from]!;
    for (let i = from + 1; i < line.length; i++) {
        const char = line[i]!;
        if (char === "\\" && quote === '"') {
            i++;
        } else if (char === quote) {
            return i + 1;
        }
    }
    return line.length;
}

/** The values part of a line (after `key =`, or a whole line inside an open array) as HTML. */
function values(line: string, state: LineState): string {
    let out = "";
    let i = 0;
    while (i < line.length) {
        const char = line[i]!;
        if (char === "#") {
            out += span("comment", line.slice(i));
            break;
        }
        if (char === '"' || char === "'") {
            const end = stringEnd(line, i);
            const text = line.slice(i, end);
            // A quoted key of an inline table.
            const key = state.braces > 0 && /^\s*=/.test(line.slice(end));
            out += span(key ? "key" : "string", text);
            i = end;
            continue;
        }
        if (char === "[" || char === "{" || char === "]" || char === "}" || char === "," || char === "=") {
            if (char === "[" || char === "{") {
                state.depth++;
            } else if ((char === "]" || char === "}") && state.depth > 0) {
                state.depth--;
            }
            if (char === "{") {
                state.braces++;
            } else if (char === "}" && state.braces > 0) {
                state.braces--;
            }
            out += span("punct", char);
            i++;
            continue;
        }
        if (BARE.test(char)) {
            let end = i;
            while (end < line.length && BARE.test(line[end]!)) {
                end++;
            }
            const word = line.slice(i, end);
            const key = state.braces > 0 && /^\s*=/.test(line.slice(end));
            const kind = key ? "key" : BOOLEAN.test(word) ? "bool" : NUMBER.test(word) || DATE.test(word) ? "number" : "plain";
            out += kind === "plain" ? escapeHtml(word) : span(kind, word);
            i = end;
            continue;
        }
        out += escapeHtml(char);
        i++;
    }
    return out;
}

/** One line as HTML, with the state carried into it and left after it. */
export function highlightLine(line: string, state: LineState = { depth: 0, braces: 0 }): string {
    const trimmed = line.trimStart();
    const lead = line.slice(0, line.length - trimmed.length);
    if (trimmed === "") {
        return escapeHtml(line);
    }
    if (trimmed.startsWith("#")) {
        return lead + span("comment", trimmed);
    }
    if (state.depth === 0) {
        const header = /^(\[\[?)([^\]]*)(\]\]?)(.*)$/.exec(trimmed);
        if (header) {
            const rest = header[4]!;
            const comment = rest.indexOf("#");
            return lead + span("punct", header[1]!) + span("table", header[2]!) + span("punct", header[3]!)
                + (comment >= 0 ? escapeHtml(rest.slice(0, comment)) + span("comment", rest.slice(comment)) : escapeHtml(rest));
        }
        // The key runs to the first `=` outside quotes.
        let at = 0;
        while (at < trimmed.length && trimmed[at] !== "=" && trimmed[at] !== "#") {
            at = trimmed[at] === '"' || trimmed[at] === "'" ? stringEnd(trimmed, at) : at + 1;
        }
        if (at < trimmed.length && trimmed[at] === "=") {
            const key = trimmed.slice(0, at);
            const padded = key.length - key.trimEnd().length;
            return lead + span("key", key.trimEnd()) + escapeHtml(key.slice(key.length - padded)) + span("punct", "=") + values(trimmed.slice(at + 1), state);
        }
    }
    return lead + values(trimmed, state);
}

/**
 * The whole text as HTML, a line each. `errorLine` (from 1) wraps that
 * line so the stylesheet can mark where a check stopped reading. The text
 * ends with a space past its last newline, so the layer is as tall as the
 * text field's empty last line.
 */
export function highlightToml(text: string, errorLine: number | null = null): string {
    const state: LineState = { depth: 0, braces: 0 };
    const lines = text.split("\n").map((line, index) => {
        const html = highlightLine(line, state);
        return index + 1 === errorLine ? `<span class="tk-error">${html || " "}</span>` : html;
    });
    return lines.join("\n") + " ";
}
