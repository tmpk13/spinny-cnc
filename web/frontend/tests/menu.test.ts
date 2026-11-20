import { afterEach, expect, test } from "bun:test";
import { closeMenu, openMenu } from "../src/menu.ts";

afterEach(() => {
    closeMenu(false);
    document.body.replaceChildren();
});

test("no key pressed in an open menu reaches the document's jog keys", () => {
    const opener = Object.assign(document.createElement("button"), { textContent: "dots" });
    document.body.append(opener);
    const picked: string[] = [];
    const menu = openMenu([
        { label: "First", run: () => picked.push("first") },
        { label: "Second", run: () => picked.push("second") },
    ], opener, "Panel");
    // The jog keys listen on the document and skip a key whose default is
    // prevented: a key that reaches them undefended would move the machine.
    const reached: string[] = [];
    const jog = (event: KeyboardEvent): void => {
        if (!event.defaultPrevented) {
            reached.push(event.key);
        }
    };
    document.addEventListener("keydown", jog);
    try {
        const item = menu.querySelector<HTMLButtonElement>("button.menu-item")!;
        expect(document.activeElement).toBe(item);
        for (const key of ["ArrowLeft", "ArrowRight", "PageUp", "PageDown", "a", "ArrowDown"]) {
            (document.activeElement ?? item).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
        }
        expect(reached).toEqual([]);
        // The menu's own keys still work: ArrowDown moved to the second item.
        expect(document.activeElement?.textContent).toBe("Second");
    } finally {
        document.removeEventListener("keydown", jog);
    }
});
