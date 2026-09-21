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

    test("toasts come and go", () => {
        const store = new Store<AppState>(initialState(true));
        const toast = pushToast(store, "error", "bad");
        expect(store.get().toasts.map((t) => t.text)).toEqual(["bad"]);
        dropToast(store, toast.id);
        expect(store.get().toasts).toEqual([]);
        expect(store.get().mock).toBe(true);
    });
});
