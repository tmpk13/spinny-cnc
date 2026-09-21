import { describe, expect, test } from "bun:test";

import {
    formatDeg,
    formatDuration,
    formatDuty,
    formatFixed,
    formatLength,
    formatMm,
    formatPercent,
    formatRate,
    parseNumber,
} from "../src/format.ts";

describe("DRO formatting", () => {
    test("millimeters to three decimals", () => {
        expect(formatMm(1.23456)).toBe("1.235");
        expect(formatMm(0)).toBe("0.000");
        expect(formatMm(-12.5)).toBe("-12.500");
    });

    test("degrees to four decimals", () => {
        expect(formatDeg(90)).toBe("90.0000");
        expect(formatDeg(-0.00004)).toBe("0.0000");
        expect(formatDeg(370.12346)).toBe("370.1235");
    });

    test("a rounded zero has no sign", () => {
        expect(formatMm(-0.0001)).toBe("0.000");
        expect(formatMm(-0)).toBe("0.000");
    });

    test("missing values are dashes", () => {
        expect(formatMm(null)).toBe("-.---");
        expect(formatDeg(undefined)).toBe("-.----");
        expect(formatFixed(Number.NaN, 2)).toBe("-.--");
        expect(formatRate(Infinity)).toBe("-");
    });

    test("rates are whole numbers", () => {
        expect(formatRate(399.6)).toBe("400");
        expect(formatRate(0)).toBe("0");
    });

    test("duty from permille", () => {
        expect(formatDuty(500)).toBe("50.0%");
        expect(formatDuty(0)).toBe("0.0%");
        expect(formatDuty(1000)).toBe("100.0%");
        expect(formatDuty(null)).toBe("-.-%");
    });

    test("percent from a fraction", () => {
        expect(formatPercent(0.256)).toBe("26%");
        expect(formatPercent(0)).toBe("0%");
        expect(formatPercent(undefined)).toBe("-%");
    });

    test("durations", () => {
        expect(formatDuration(0)).toBe("0:00");
        expect(formatDuration(65)).toBe("1:05");
        expect(formatDuration(3661)).toBe("1:01:01");
        expect(formatDuration(59.6)).toBe("1:00");
        expect(formatDuration(-1)).toBe("-:--");
        expect(formatDuration(null)).toBe("-:--");
    });

    test("lengths", () => {
        expect(formatLength(123.45)).toBe("123.5 mm");
        expect(formatLength(1234.5)).toBe("1.23 m");
        expect(formatLength(null)).toBe("- mm");
    });

    test("parsing fields", () => {
        expect(parseNumber("")).toBeNull();
        expect(parseNumber("  ")).toBeNull();
        expect(parseNumber("abc")).toBeNull();
        expect(parseNumber(" 12.5 ")).toBe(12.5);
        expect(parseNumber("-3")).toBe(-3);
    });
});
