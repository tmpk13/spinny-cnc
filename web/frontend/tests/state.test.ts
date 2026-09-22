import { describe, expect, test } from "bun:test";

import { CONSOLE_LIMIT, Store, appendConsole, dropToast, initialState, pushToast, type AppState } from "../src/state.ts";

describe("store", () => {
    test("set merges and notifies once per change", () => {
        const store = new Store({ a: 1, b: "x" });
        const seen: number[] = [];
        store.subscribe((state) => seen.push(state.a));
        store.set({ a: 2 });
        store.set({ a: 2 });
        store.set({ b: "y" });
        expect(seen).toEqual([2, 2]);
        expect(store.get()).toEqual({ a: 2, b: "y" });
    });

    test("key filters", () => {
        const store = new Store({ a: 1, b: 1 });
        let aCalls = 0;
        let bCalls = 0;
        store.subscribe(() => aCalls++, ["a"]);
        const off = store.subscribe(() => bCalls++, ["b"]);
        store.set({ a: 2 });
        store.set({ b: 2 });
        off();
        store.set({ b: 3 });
        expect(aCalls).toBe(1);
        expect(bCalls).toBe(1);
    });

    test("update takes a function", () => {
        const store = new Store({ n: 1 });
        store.update((state) => ({ n: state.n + 1 }));
        expect(store.get().n).toBe(2);
    });

    test("listeners get the previous state", () => {
        const store = new Store({ n: 1 });
        let previousSeen = 0;
        store.subscribe((_state, previous) => {
            previousSeen = previous.n;
        });
        store.set({ n: 5 });
        expect(previousSeen).toBe(1);
    });
});

describe("app state helpers", () => {
    test("console is capped", () => {
        const store = new Store<AppState>(initialState(false));
        for (let i = 0; i < CONSOLE_LIMIT + 10; i++) {
            appendConsole(store, { dir: "rx", text: `line ${i}` });
        }
        const lines = store.get().console;
        expect(lines.length).toBe(CONSOLE_LIMIT);
        expect(lines[0]?.text).toBe("line 10");
        expect(lines[lines.length - 1]?.text).toBe(`line ${CONSOLE_LIMIT + 9}`);
    });

    test("a snapshot carries the cross slide with the other axes", () => {
        const store = new Store<AppState>(initialState(false));
        expect(store.get().snapshot.machine).toBeNull();
        store.set({
            snapshot: {
                connected: true,
                url: "/dev/ttyACM0",
                firmware: { version: "0.1.0", lines: 16, blocks: 32 },
                machine: {
                    state: "Jog",
                    alarm: null,
                    joint: { r: 12.345, a: 90, z: -0.125 },
                    board: { x: 0, y: 12.345 },
                    rate: 0,
                    laser: 0,
                    mode: "dyn",
                    enabled: true,
                    queue: { planner: 32, lines: 16 },
                },
                run: null,
            },
        });
        expect(store.get().snapshot.machine?.joint).toEqual({ r: 12.345, a: 90, z: -0.125 });
    });

    test("toasts come and go", () => {
        const store = new Store<AppState>(initialState(true));
        const toast = pushToast(store, "error", "bad");
        expect(store.get().toasts.map((t) => t.text)).toEqual(["bad"]);
        dropToast(store, toast.id);
        expect(store.get().toasts).toEqual([]);
        expect(store.get().mock).toBe(true);
    });
});

describe("console polls", () => {
    test("the link's own polls stay out of the buffer unless asked for", () => {
        // The poll runs several times a second; keeping it would push every
        // real line out of a 400 line buffer in well under a minute.
        const store = new Store<AppState>(initialState(false));
        appendConsole(store, { dir: "tx", text: "?", poll: true });
        appendConsole(store, { dir: "rx", text: "<Idle|J:0.000,0.0000>", poll: true });
        appendConsole(store, { dir: "tx", text: "jog R1" });
        appendConsole(store, { dir: "rx", text: "ok" });
        expect(store.get().console.map((l) => l.text)).toEqual(["jog R1", "ok"]);

        store.set({ showPolls: true });
        appendConsole(store, { dir: "tx", text: "?", poll: true });
        expect(store.get().console.length).toBe(3);

        store.set({ showPolls: false });
        appendConsole(store, { dir: "tx", text: "?", poll: true });
        expect(store.get().console.length).toBe(3);
    });

    test("a real line is never dropped, whatever the toggle says", () => {
        const store = new Store<AppState>(initialState(false));
        for (let i = 0; i < 20; i += 1) {
            appendConsole(store, { dir: "tx", text: "?", poll: true });
            appendConsole(store, { dir: "rx", text: `report ${i}`, poll: true });
        }
        appendConsole(store, { dir: "rx", text: "ALARM:1" });
        expect(store.get().console.map((l) => l.text)).toEqual(["ALARM:1"]);
    });
});
