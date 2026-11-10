// Arithmetic typed into a number field: "25.4 / 2", "3 * (4 + 1.5)",
// "1/8 in", "sqrt(2) * 10", "-pi / 4". A small reader of its own, so no
// text typed into the page is ever run as code.
//
// Precedence, loosest first: + and -; *, / and %; a sign; ^ (right to
// left, so -2^2 is -4 and 2^-1 is 0.5). A length unit (mm, cm, in, mil,
// ft) scales the product it ends or stands in, so "1/8 in" and "1 in / 8"
// are both an eighth of an inch, and "2 + 1/8 in" adds that to 2 mm.
// Angles in and out of the trigonometric functions are degrees, the way
// the rest of the page gives them.

import { errorText } from "./api.ts";
import { DEG } from "./kinematics.ts";

/** Millimeters in each length unit a number may carry. */
export const UNITS: Record<string, number> = { mm: 1, cm: 10, in: 25.4, mil: 0.0254, ft: 304.8 };

/** The functions a field may call, by name, with how many arguments each takes. */
const FUNCTIONS: Record<string, { args: [number, number]; call: (...values: number[]) => number }> = {
    sqrt: { args: [1, 1], call: (x) => Math.sqrt(x) },
    abs: { args: [1, 1], call: (x) => Math.abs(x) },
    round: { args: [1, 1], call: (x) => Math.round(x) },
    floor: { args: [1, 1], call: (x) => Math.floor(x) },
    ceil: { args: [1, 1], call: (x) => Math.ceil(x) },
    sin: { args: [1, 1], call: (x) => Math.sin(x * DEG) },
    cos: { args: [1, 1], call: (x) => Math.cos(x * DEG) },
    tan: { args: [1, 1], call: (x) => Math.tan(x * DEG) },
    asin: { args: [1, 1], call: (x) => Math.asin(x) / DEG },
    acos: { args: [1, 1], call: (x) => Math.acos(x) / DEG },
    atan: { args: [1, 1], call: (x) => Math.atan(x) / DEG },
    atan2: { args: [2, 2], call: (y, x) => Math.atan2(y, x) / DEG },
    hypot: { args: [1, 16], call: (...values) => Math.hypot(...values) },
    min: { args: [1, 16], call: (...values) => Math.min(...values) },
    max: { args: [1, 16], call: (...values) => Math.max(...values) },
};

const CONSTANTS: Record<string, number> = { pi: Math.PI };

type Token = { kind: "number"; value: number } | { kind: "word"; name: string } | { kind: "op"; op: string };

/** The text as numbers, words and operators, or null for a character none of them can hold. */
function tokens(text: string): Token[] | null {
    const out: Token[] = [];
    let at = 0;
    while (at < text.length) {
        const char = text[at]!;
        if (char === " " || char === "\t") {
            at++;
            continue;
        }
        const number = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(text.slice(at));
        if (number) {
            out.push({ kind: "number", value: Number(number[0]) });
            at += number[0].length;
            continue;
        }
        const word = /^[a-z_][a-z0-9_]*/i.exec(text.slice(at));
        if (word) {
            out.push({ kind: "word", name: word[0].toLowerCase() });
            at += word[0].length;
            continue;
        }
        if ("+-*/%^(),".includes(char)) {
            out.push({ kind: "op", op: char });
            at++;
            continue;
        }
        return null;
    }
    return out;
}

class Reader {
    private at = 0;

    constructor(private readonly list: Token[]) {}

    done(): boolean {
        return this.at >= this.list.length;
    }

    private peek(): Token | undefined {
        return this.list[this.at];
    }

    private isOp(op: string): boolean {
        const token = this.peek();
        return token?.kind === "op" && token.op === op;
    }

    private take(op: string): boolean {
        if (this.isOp(op)) {
            this.at++;
            return true;
        }
        return false;
    }

    /** A sum: products added and taken away. */
    sum(): number {
        let value = this.product();
        for (;;) {
            if (this.take("+")) {
                value += this.product();
            } else if (this.take("-")) {
                value -= this.product();
            } else {
                return value;
            }
        }
    }

    /** A product: signed powers multiplied and divided, scaled by a unit where one stands. */
    private product(): number {
        let value = this.signed();
        for (;;) {
            const token = this.peek();
            if (token?.kind === "word" && Object.hasOwn(UNITS, token.name)) {
                this.at++;
                value *= UNITS[token.name]!;
            } else if (this.take("*")) {
                value *= this.signed();
            } else if (this.take("/")) {
                value /= this.signed();
            } else if (this.take("%")) {
                value %= this.signed();
            } else {
                return value;
            }
        }
    }

    private signed(): number {
        if (this.take("-")) {
            return -this.signed();
        }
        if (this.take("+")) {
            return this.signed();
        }
        return this.power();
    }

    private power(): number {
        const base = this.atom();
        if (this.take("^")) {
            return base ** this.signed();
        }
        return base;
    }

    private atom(): number {
        const token = this.peek();
        if (token === undefined) {
            throw new Error("the text ends too soon");
        }
        this.at++;
        if (token.kind === "number") {
            return token.value;
        }
        if (token.kind === "op") {
            if (token.op !== "(") {
                throw new Error(`no number before ${token.op}`);
            }
            const value = this.sum();
            if (!this.take(")")) {
                throw new Error("a bracket is not closed");
            }
            return value;
        }
        if (Object.hasOwn(CONSTANTS, token.name)) {
            return CONSTANTS[token.name]!;
        }
        // A unit with no number before it stands for one of itself: "in / 8".
        if (Object.hasOwn(UNITS, token.name)) {
            return UNITS[token.name]!;
        }
        const fn = Object.hasOwn(FUNCTIONS, token.name) ? FUNCTIONS[token.name]! : undefined;
        if (!fn) {
            throw new Error(`no ${token.name}`);
        }
        if (!this.take("(")) {
            throw new Error(`${token.name} takes its value in brackets`);
        }
        const values = [this.sum()];
        while (this.take(",")) {
            values.push(this.sum());
        }
        if (!this.take(")")) {
            throw new Error("a bracket is not closed");
        }
        if (values.length < fn.args[0] || values.length > fn.args[1]) {
            throw new Error(`${token.name} takes ${fn.args[0] === fn.args[1] ? fn.args[0] : `${fn.args[0]} to ${fn.args[1]}`} values`);
        }
        return fn.call(...values);
    }
}

/** The value of an arithmetic text, or why it has none. */
export function calculate(text: string): number | string {
    const list = tokens(text.trim());
    if (list === null) {
        return "not arithmetic";
    }
    if (list.length === 0) {
        return "nothing typed";
    }
    try {
        const reader = new Reader(list);
        const value = reader.sum();
        if (!reader.done()) {
            return "something follows the value";
        }
        return Number.isFinite(value) ? value : "no finite value";
    } catch (error) {
        return errorText(error);
    }
}

/** The value of an arithmetic text, null when it has none. */
export function evaluate(text: string): number | null {
    const value = calculate(text);
    return typeof value === "number" ? value : null;
}

/** A computed value as a field shows it: twelve significant digits, so 0.1 + 0.2 reads 0.3. */
export function calcText(value: number): string {
    return String(Number(value.toPrecision(12)));
}
