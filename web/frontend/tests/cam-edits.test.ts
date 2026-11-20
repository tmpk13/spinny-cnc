// The CAM view's profile text: an edit not saved is never thrown away
// without a word when another profile is picked.

import { afterEach, describe, expect, test } from "bun:test";

import { mountCam } from "../src/views/cam.ts";
import { dialogButton, settle, setup } from "./harness.ts";

afterEach(() => {
    localStorage.removeItem("spinny.cam.profile");
    for (const dialog of Array.from(document.querySelectorAll("dialog"))) {
        dialog.remove();
    }
});

async function settled(): Promise<void> {
    for (let i = 0; i < 6; i += 1) {
        await settle();
    }
}

describe("an unsaved edit of a CAM profile's text", () => {
    test("is kept when another profile is picked and the leave is declined", async () => {
        const { ctx, root } = setup();
        const fileRoot = document.createElement("section");
        document.body.append(fileRoot);
        mountCam(root, ctx, fileRoot);
        await settled();
        const pick = root.querySelector("select[aria-label='CAM profile']") as HTMLSelectElement;
        pick.value = "mill-3axis";
        pick.dispatchEvent(new Event("change"));
        await settled();
        const text = fileRoot.querySelector("textarea") as HTMLTextAreaElement;
        text.value = `${text.value}\n# a note typed and not saved\n`;
        text.dispatchEvent(new Event("input"));
        await settled();
        pick.value = "polar-laser";
        pick.dispatchEvent(new Event("change"));
        await settled();
        expect(document.querySelector("dialog[open]")?.textContent ?? "").toContain("Unsaved edits are lost");
        dialogButton("Cancel").click();
        await settled();
        expect(pick.value).toBe("mill-3axis");
        expect(text.value).toContain("# a note typed and not saved");
        fileRoot.remove();
    });
});
