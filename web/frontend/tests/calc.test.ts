import { describe, expect, test } from "bun:test";

import { calcText, calculate, evaluate } from "../src/calc.ts";
import { numberField } from "../src/dom.ts";
import { parseNumber } from "../src/format.ts";

describe("arithmetic in number fields", () => {
    test("the four operations keep their usual order and brackets win", () => {
        expect(evaluate("25.4 / 2")).toBe(12.7);
        expect(evaluate("1 + 2 * 3")).toBe(7);
        expect(evaluate("(1 + 2) * 3")).toBe(9);
        expect(evaluate("10 - 4 - 3")).toBe(3);
        expect(evaluate("100 / 10 / 5")).toBe(2);
        expect(evaluate("7 % 4")).toBe(3);
        expect(evaluate(".5*4")).toBe(2);
        expect(evaluate("1e3 / 4")).toBe(250);
    });

    test("a power binds tighter than a sign and runs right to left", () => {
        expect(evaluate("2^3^2")).toBe(512);
        expect(evaluate("-2^2")).toBe(-4);
        expect(evaluate("2^-1")).toBe(0.5);
        expect(evaluate("--3")).toBe(3);
        expect(evaluate("-(4 - 6)")).toBe(2);
    });

    test("a unit scales the product it ends or stands in, to millimeters", () => {
        expect(evaluate("1 in")).toBeCloseTo(25.4, 12);
        expect(evaluate("1/8in")).toBeCloseTo(3.175, 12);
        expect(evaluate("1 in / 8")).toBeCloseTo(3.175, 12);
        expect(evaluate("2 + 1/8 in")).toBeCloseTo(5.175, 12);
        expect(evaluate("10 mil")).toBeCloseTo(0.254, 12);
        expect(evaluate("1.5cm - 5mm")).toBeCloseTo(10, 12);
        expect(evaluate("in")).toBeCloseTo(25.4, 12);
    });

    test("functions take degrees, give degrees, and check how many values they get", () => {
        expect(evaluate("sqrt(2) * sqrt(2)")).toBeCloseTo(2, 12);
        expect(evaluate("sin(30)")).toBeCloseTo(0.5, 12);
        expect(evaluate("10 * cos(60)")).toBeCloseTo(5, 12);
        expect(evaluate("atan2(1, 1)")).toBeCloseTo(45, 12);
        expect(evaluate("hypot(3, 4)")).toBe(5);
        expect(evaluate("max(1, 7, 3) - min(4, 2)")).toBe(5);
        expect(evaluate("round(2.6) + floor(-0.5) + ceil(0.2)")).toBe(3);
        expect(evaluate("-pi/4")).toBeCloseTo(-Math.PI / 4, 12);
        expect(evaluate("SQRT(16)")).toBe(4);
        expect(calculate("atan2(1)")).toBe("atan2 takes 2 values");
        expect(calculate("sqrt 4")).toBe("sqrt takes its value in brackets");
    });

    test("anything else is no number, with a reason, and nothing is run as code", () => {
        expect(evaluate("")).toBeNull();
        expect(evaluate("1 +")).toBeNull();
        expect(evaluate("(1 + 2")).toBeNull();
        expect(evaluate("1 2")).toBeNull();
        expect(evaluate("1/0")).toBeNull();
        expect(evaluate("sqrt(-1)")).toBeNull();
        expect(evaluate("alert(1)")).toBeNull();
        expect(evaluate("constructor")).toBeNull();
        expect(evaluate("1; 2")).toBeNull();
        expect(calculate("foo(2)")).toBe("unknown foo");
        expect(calculate("1 2")).toBe("something follows the value");
        expect(calculate("1/0")).toBe("no finite value");
        expect(calculate("2 $ 3")).toBe("not arithmetic");
    });

    test("parseNumber reads plain numbers as before and arithmetic besides", () => {
        expect(parseNumber(" 12.5 ")).toBe(12.5);
        expect(parseNumber("-3")).toBe(-3);
        expect(parseNumber("1e-3")).toBe(0.001);
        expect(parseNumber("")).toBeNull();
        expect(parseNumber("abc")).toBeNull();
        expect(parseNumber("Infinity")).toBeNull();
        expect(parseNumber("3*4")).toBe(12);
        expect(calcText(0.1 + 0.2)).toBe("0.3");
        expect(calcText(-2.5)).toBe("-2.5");
    });
});

describe("a number field", () => {
    const keydown = (input: HTMLInputElement, key: string): void => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    };

    test("takes arithmetic and shows its value once changed, before other listeners hear it", () => {
        const field = numberField({ value: 1, min: 0 });
        expect(field.type).toBe("text");
        expect(field.getAttribute("inputmode")).toBe("decimal");
        const heard: string[] = [];
        field.addEventListener("change", () => heard.push(field.value));
        field.value = "25.4 / 2";
        field.dispatchEvent(new Event("change"));
        expect(field.value).toBe("12.7");
        expect(heard).toEqual(["12.7"]);
        // A plain number is left as typed.
        field.value = "3.50";
        field.dispatchEvent(new Event("change"));
        expect(field.value).toBe("3.50");
        // A signed field gets the full keyboard, which has the operators.
        expect(numberField({ value: 0 }).getAttribute("inputmode")).toBeNull();
    });

    test("marks text that is no number while it is typed, and clears the mark", () => {
        const field = numberField({ value: 1 });
        field.value = "2 +";
        field.dispatchEvent(new Event("input"));
        expect(field.classList.contains("invalid")).toBe(true);
        expect(field.getAttribute("aria-invalid")).toBe("true");
        expect(field.title).toContain("not a number");
        field.value = "2 + 3";
        field.dispatchEvent(new Event("input"));
        expect(field.classList.contains("invalid")).toBe(false);
        expect(field.getAttribute("aria-invalid")).toBeNull();
        // Blank is no mark: a field may be left empty on purpose.
        field.value = "";
        field.dispatchEvent(new Event("input"));
        expect(field.classList.contains("invalid")).toBe(false);
    });

    test("steps with the arrow keys within its limits, and says so", () => {
        const field = numberField({ value: 0.25, min: 0, max: 0.5, step: 0.1 });
        let changes = 0;
        field.addEventListener("change", () => changes++);
        keydown(field, "ArrowUp");
        expect(field.value).toBe("0.35");
        keydown(field, "ArrowUp");
        keydown(field, "ArrowUp");
        expect(field.value).toBe("0.5");
        field.value = "0.1";
        keydown(field, "ArrowDown");
        keydown(field, "ArrowDown");
        expect(field.value).toBe("0");
        expect(changes).toBe(5);
        // A step of any moves by one, and a calculation steps from its value.
        const free = numberField({ value: 0 });
        free.value = "10/4";
        keydown(free, "ArrowDown");
        expect(free.value).toBe("1.5");
        // Text that is no number is left for the operator to mend.
        free.value = "2 +";
        keydown(free, "ArrowUp");
        expect(free.value).toBe("2 +");
    });
});
