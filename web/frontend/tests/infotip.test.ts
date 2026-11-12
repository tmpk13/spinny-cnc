import { expect, test } from "bun:test";

import { closeInfoTip, infoTip } from "../src/views/infotip.ts";

test("a drawing opens on a press, not on a hover, and closes on another press, outside or with Escape", () => {
    const tip = infoTip("upcam");
    document.body.append(tip);
    const mark = tip.querySelector(".info-tip-mark")!;
    tip.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(tip.hasAttribute("data-open")).toBe(false);
    mark.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(tip.hasAttribute("data-open")).toBe(true);
    expect(tip.getAttribute("aria-expanded")).toBe("true");
    mark.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(tip.hasAttribute("data-open")).toBe(false);
    mark.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(tip.hasAttribute("data-open")).toBe(false);
    tip.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(tip.hasAttribute("data-open")).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(tip.hasAttribute("data-open")).toBe(false);
    closeInfoTip();
    tip.remove();
});

test("one drawing open at a time", () => {
    const first = infoTip("heights");
    const second = infoTip("feeder");
    document.body.append(first, second);
    first.querySelector(".info-tip-mark")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    second.querySelector(".info-tip-mark")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(first.hasAttribute("data-open")).toBe(false);
    expect(second.hasAttribute("data-open")).toBe(true);
    closeInfoTip();
    first.remove();
    second.remove();
});
