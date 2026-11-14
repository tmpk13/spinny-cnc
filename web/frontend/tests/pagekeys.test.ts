import { afterEach, expect, test } from "bun:test";
import { isPageKey, keepsPageKeys, stopPageScroll } from "../src/pagekeys.ts";

afterEach(() => {
    document.body.replaceChildren();
});

test("PageUp and PageDown do not scroll the page, but scroll a text area and a pick", () => {
    expect(isPageKey("PageDown") && isPageKey("PageUp")).toBe(true);
    expect(isPageKey("ArrowDown")).toBe(false);
    // A window of its own, so no other test's keys are stopped.
    const target = new EventTarget() as unknown as Window;
    stopPageScroll(target);
    const press = (on: Element, key: string): boolean => {
        const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
        // The event as the window hears it, from the element that had the key.
        Object.defineProperty(event, "target", { value: on });
        target.dispatchEvent(event);
        return event.defaultPrevented;
    };
    const button = document.createElement("button");
    const field = document.createElement("input");
    const area = document.createElement("textarea");
    const pick = document.createElement("select");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    document.body.append(button, field, area, pick, editable);
    expect(press(document.body, "PageDown")).toBe(true);
    expect(press(button, "PageUp")).toBe(true);
    expect(press(field, "PageDown")).toBe(true);
    expect(press(area, "PageDown")).toBe(false);
    expect(press(pick, "PageDown")).toBe(false);
    expect(press(editable, "PageUp")).toBe(false);
    // Other keys go on as they would.
    expect(press(document.body, "ArrowDown")).toBe(false);
    expect(keepsPageKeys(null)).toBe(false);
});
