// The Config tab's machine file editor: an edit not saved is never thrown
// away without a word, whichever way the file is read again.

import { afterEach, describe, expect, test } from "bun:test";

import { mountConfig } from "../src/views/config.ts";
import { click, dialogButton, settle, setup } from "./harness.ts";

const PICK_KEY = "spinny.machine";

afterEach(() => {
    localStorage.removeItem(PICK_KEY);
    for (const dialog of Array.from(document.querySelectorAll("dialog"))) {
        dialog.remove();
    }
});

async function settled(): Promise<void> {
    for (let i = 0; i < 6; i += 1) {
        await settle();
    }
}

/** The Config tab on polar-laser, with a line typed into the editor and not saved. */
async function edited() {
    localStorage.removeItem(PICK_KEY);
    const { ctx, root } = setup();
    const config = mountConfig(root, ctx, document.createElement("section"));
    await settled();
    const pick = root.querySelector("select[aria-label='Machine file']") as HTMLSelectElement;
    pick.value = "polar-laser";
    pick.dispatchEvent(new Event("change"));
    await settled();
    const text = root.querySelector("textarea") as HTMLTextAreaElement;
    text.value = `${text.value}\n# a note typed and not saved\n`;
    text.dispatchEvent(new Event("input"));
    await settled();
    return { config, root, text };
}

describe("an unsaved edit in the machine file editor", () => {
    test("is kept when Reload is pressed and the leave is declined", async () => {
        const { root, text } = await edited();
        click(root, "Reload");
        await settled();
        expect(document.querySelector("dialog[open]")?.textContent ?? "").toContain("Unsaved edits are lost");
        dialogButton("Cancel").click();
        await settled();
        expect(text.value).toContain("# a note typed and not saved");
    });

    test("is kept when another panel asks for the same file and the leave is declined", async () => {
        const { config, text } = await edited();
        const opened = config.open("polar-laser");
        await settled();
        expect(document.querySelector("dialog[open]")?.textContent ?? "").toContain("Unsaved edits are lost");
        dialogButton("Cancel").click();
        await opened;
        await settled();
        expect(text.value).toContain("# a note typed and not saved");
    });
});
