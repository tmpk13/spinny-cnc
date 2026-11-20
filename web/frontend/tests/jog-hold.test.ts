// Hold to move on the jog panel: a held button or key sends pieces of a
// jog until it is let go, and the jog is then cancelled on this project's
// firmware. Every way of letting go must stop the machine.

import { afterEach, describe, expect, test } from "bun:test";

import type { JogRequest } from "../src/types.ts";
import { HOLD_TICK_MS, mountJog } from "../src/views/jog.ts";
import { connected, findButton, settle, setup } from "./harness.ts";

const SMOOTH_KEY = "spinny.jog.smooth";

afterEach(() => {
    localStorage.removeItem(SMOOTH_KEY);
});

const ticks = (count: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, count * HOLD_TICK_MS));

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

    test("a held key let go after Shift stops the hold though its name changed", async () => {
        localStorage.setItem(SMOOTH_KEY, "1");
        const { store, ctx, root, calls, api } = setup();
        await api.connect("/dev/ttyACM0");
        store.set({ snapshot: connected() });
        mountJog(root, ctx);
        // Num Lock on: Shift with the keypad's 8 is the up arrow; let go of
        // Shift first and the 8 comes up as "8".
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", code: "Numpad8", shiftKey: true, bubbles: true }));
        await ticks(2.5);
        expect(calls.some((call) => call.name === "jog")).toBe(true);
        document.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", code: "ShiftLeft", bubbles: true }));
        document.dispatchEvent(new KeyboardEvent("keyup", { key: "8", code: "Numpad8", bubbles: true }));
        await settle();
        const pieces = calls.filter((call) => call.name === "jog").length;
        await ticks(3);
        expect(calls.filter((call) => call.name === "jog").length).toBe(pieces);
        expect(calls.some((call) => call.name === "jogCancel")).toBe(true);
        store.set({ snapshot: { ...connected(), connected: false } });
    });

    test("the panel's Cancel ends a held key's jog, not only what is queued", async () => {
        localStorage.setItem(SMOOTH_KEY, "1");
        const { store, ctx, root, calls, api } = setup();
        await api.connect("/dev/ttyACM0");
        store.set({ snapshot: connected() });
        mountJog(root, ctx);
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", code: "ArrowUp", bubbles: true }));
        await ticks(2.5);
        const cancel = findButton(root, "Cancel");
        cancel.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true, pointerId: 2 }));
        cancel.click();
        await settle();
        const pieces = calls.filter((call) => call.name === "jog").length;
        await ticks(3);
        expect(calls.filter((call) => call.name === "jog").length).toBe(pieces);
        document.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowUp", code: "ArrowUp", bubbles: true }));
        store.set({ snapshot: { ...connected(), connected: false } });
    });
});
