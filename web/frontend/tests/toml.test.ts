import { describe, expect, test } from "bun:test";

import millText from "../../../cam/mill-3axis.toml" with { type: "text" };
import polarText from "../../../cam/polar-laser.toml" with { type: "text" };
import { TomlError, parseToml, stripComment, type TomlTable } from "../src/mock/toml.ts";

describe("the mock's TOML reader", () => {
    test("reads the shipped profiles as Bun's own reader does", () => {
        expect(parseToml(millText)).toEqual(Bun.TOML.parse(millText) as TomlTable);
        expect(parseToml(polarText)).toEqual(Bun.TOML.parse(polarText) as TomlTable);
    });

    test("keeps a hash inside a string and drops a comment after a value", () => {
        expect(stripComment('a = "x # y"  # note')).toBe('a = "x # y"');
        expect(parseToml('a = "x # y" # note\nb = [1, 2] # c\n')).toEqual({ a: "x # y", b: [1, 2] });
    });

    test("reads strings, numbers, booleans and arrays over several lines", () => {
        const text = 'name = "a \\"b\\""\nlit = \'c\\d\'\nn = -1_000.5e2\nflag = false\nlist = [\n    "G21",\n    "G90",\n]\nempty = []\n';
        expect(parseToml(text)).toEqual({ name: 'a "b"', lit: "c\\d", n: -100050, flag: false, list: ["G21", "G90"], empty: [] });
    });

    test("names the line of what it cannot read", () => {
        expect(() => parseToml("a = 1\nb\n")).toThrow(new TomlError(2, "expected key = value"));
        expect(() => parseToml("a = 1\na = 2\n")).toThrow(/line 2: a is given twice/);
        expect(() => parseToml('a = "open\n')).toThrow(/line 1: a string is not closed/);
        expect(() => parseToml("[t]\nx = 1\n[t]\n")).toThrow(/line 3: \[t\] is defined twice/);
        expect(() => parseToml("a.b = 1\n")).toThrow(/plain keys only/);
        expect(() => parseToml("x = nope\n")).toThrow(/cannot read the value nope/);
    });
});
