// Hold to move on the jog panel: a held button or key sends pieces of a
// jog until it is let go, and the jog is then cancelled on this project's
// firmware. Every way of letting go must stop the machine.

import { afterEach, describe, expect, test } from "bun:test";

import type { JogRequest } from "../src/types.ts";
import { mountJog } from "../src/views/jog.ts";
import { connected, findButton, settle, setup } from "./harness.ts";

const SMOOTH_KEY = "spinny.jog.smooth";

afterEach(() => {
    localStorage.removeItem(SMOOTH_KEY);
});

describe("hold to move", () => {
    test("a piece still on its way when the button is let go is cancelled once it is queued", async () => {
        localStorage.setItem(SMOOTH_KEY, "1");
        const { store, ctx, root, calls, api, backend } = setup();
        await api.connect("/dev/ttyACM0");
        store.set({ snapshot: connected() });
        // The backend answers a jog once it is queued: hold the answer back
        // so the release comes while the piece is on its way.
        const answers: (() => void)[] = [];
        const jog = backend.jog.bind(backend);
        backend.jog = (request: JogRequest) => new Promise((resolve, reject) => {
            answers.push(() => {
                calls.push({ name: "jog answered", args: [] });
                jog(request).then(resolve, reject);
            });
        });
        mountJog(root, ctx);
        const plus = findButton(root, "X+");
        plus.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true, pointerId: 1 }));
        await settle();
        expect(answers.length).toBe(1);
        plus.dispatchEvent(new PointerEvent("pointerup", { button: 0, bubbles: true, pointerId: 1 }));
        plus.click();
        await settle();
        // The piece reaches the queue after the cancel sent at the release.
        answers.shift()!();
        await settle();
        await settle();
        const answered = calls.findIndex((call) => call.name === "jog answered");
        expect(answered).toBeGreaterThanOrEqual(0);
        expect(calls.slice(answered + 1).some((call) => call.name === "jogCancel")).toBe(true);
        expect(calls.filter((call) => call.name === "jog").length).toBe(1);
        store.set({ snapshot: { ...connected(), connected: false } });
    });
});
