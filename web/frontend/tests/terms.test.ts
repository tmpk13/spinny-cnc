import { describe, expect, test } from "bun:test";

import { labeled, el } from "../src/dom.ts";
import { explain, meaning, TERMS } from "../src/terms.ts";
import { mountCameraSight } from "../src/views/camerasight.ts";
import { setup } from "./harness.ts";

describe("the cameras' words", () => {
    test("each term says what it means in a phrase, in plain ASCII", () => {
        for (const [key, [word, said]] of Object.entries(TERMS)) {
            expect(word.length).toBeGreaterThan(0);
            expect(said.length).toBeGreaterThan(20);
            expect(/^[\x20-\x7e]*$/.test(`${word} ${said}`)).toBe(true);
            expect(meaning(key as keyof typeof TERMS)).toBe(said);
        }
    });

    test("a labeled label's words take the meaning, its control keeps its own tooltip; a tooltip there already comes first", () => {
        const select = el("select", { title: "front or back" });
        const label = explain(labeled("Side", select), "side");
        const words = label.querySelector(".labeled-text") as HTMLElement;
        expect(words.classList.contains("term")).toBe(true);
        expect(words.title).toBe(`side: ${meaning("side")}`);
        expect(label.title).toBe("");
        expect(select.title).toBe("front or back");
        const line = explain(explain(el("p", { title: "the pose" }), "pose"), "rms");
        expect(line.title).toBe(`the pose; pose: ${meaning("pose")}; rms: ${meaning("rms")}`);
    });

    test("the lens and colors panel says what spots are on hover, with no word list", () => {
        const { ctx } = setup();
        const sight = mountCameraSight(ctx, { camera: "head", label: "the head camera", settings: () => null, running: () => false });
        const spots = [...sight.root.querySelectorAll(".labeled-text")].find((node) => node.textContent === "Spots") as HTMLElement;
        expect(spots.classList.contains("term")).toBe(true);
        expect(spots.title).toContain("a small blob the finder looks for");
        expect(sight.root.querySelector(".terms-list")).toBeNull();
    });
});
