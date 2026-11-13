import { afterEach, describe, expect, test } from "bun:test";

import { HttpApi } from "../src/api.ts";
import { createContext } from "../src/main.ts";
import { MockBackend } from "../src/mock/backend.ts";
import { MockTodo } from "../src/mock/todo.ts";
import { Store, initialState, type AppState } from "../src/state.ts";
import { addTodo, checkTodo, clearDone, newTodoId, openCount, removeTodo, todoText, type TodoItem } from "../src/todo.ts";
import { mountTodo } from "../src/views/todo.ts";

const settle = async (): Promise<void> => {
    for (let i = 0; i < 8; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
};

const item = (id: string, text: string, done = false): TodoItem => ({ id, text, done });

describe("the to-do list's changes", () => {
    test("a line is added trimmed, once, and an empty one adds nothing", () => {
        expect(todoText("  clean   the\nlens ")).toBe("clean the lens");
        const one = addTodo(" clean  lens ", "a")([]);
        expect(one).toEqual([item("a", "clean lens")]);
        expect(addTodo("   ", "b")(one)).toBe(one);
        expect(addTodo("again", "a")(one)).toBe(one);
        expect(addTodo("x".repeat(600), "c")([])[0]!.text).toHaveLength(500);
    });

    test("checking, deleting and clearing what is done", () => {
        const items = [item("a", "one"), item("b", "two", true), item("c", "three")];
        expect(checkTodo("a", true)(items).map((entry) => entry.done)).toEqual([true, true, false]);
        expect(removeTodo("b")(items).map((entry) => entry.id)).toEqual(["a", "c"]);
        expect(clearDone(items).map((entry) => entry.id)).toEqual(["a", "c"]);
        expect(openCount(items)).toBe(2);
    });

    test("ids are letters and digits the backend takes", () => {
        const id = newTodoId(1_700_000_000_000, () => 0.5);
        expect(id).toMatch(/^[a-z0-9]{1,40}$/);
        expect(newTodoId(1_700_000_000_000, () => 0.25)).not.toBe(id);
    });
});

describe("the mock's to-do list", () => {
    test("keeps the list put, counts revisions and refuses one made on an older revision", () => {
        const todo = new MockTodo();
        expect(todo.get()).toEqual({ revision: 0, items: [] });
        expect(todo.put([item("a", " one  two ")], 0)).toEqual({ revision: 1, items: [item("a", "one two")] });
        expect(() => todo.put([], 0)).toThrow("the list changed in another window: read it again");
        expect(todo.put([], null).revision).toBe(2);
    });

    test("refuses with the backend's words", () => {
        const todo = new MockTodo();
        expect(() => todo.put([item("a", " ")], null)).toThrow("a to-do is 1 to 500 characters");
        expect(() => todo.put([item("a", "x"), item("a", "y")], null)).toThrow("two to-dos have the id 'a'");
        expect(() => todo.put([item("../x", "x")], null)).toThrow("a to-do's id is 1 to 40 letters, digits, _ or -");
        expect(() => todo.put(Array.from({ length: 501 }, (_, n) => item(`i${n}`, "x")), null)).toThrow("at most 500 to-dos");
    });
});

describe("HttpApi to-do routes", () => {
    test("the list is read with a GET and put whole with its revision", async () => {
        const calls: [string, string, unknown][] = [];
        const api = new HttpApi("http://host", async (url, init) => {
            calls.push([init?.method ?? "GET", url.replace("http://host", ""), typeof init?.body === "string" ? JSON.parse(init.body) : null]);
            return new Response(JSON.stringify({ revision: 1, items: [] }), { status: 200 });
        });
        await api.todo();
        await api.setTodo([item("a", "one")], 0);
        await api.setTodo([], null);
        expect(calls).toEqual([
            ["GET", "/api/todo", null],
            ["PUT", "/api/todo", { items: [item("a", "one")], revision: 0 }],
            ["PUT", "/api/todo", { items: [] }],
        ]);
    });
});

describe("the to-do drawer", () => {
    afterEach(() => {
        document.body.replaceChildren();
    });

    function mount() {
        const store = new Store<AppState>(initialState(true));
        const backend = new MockBackend({ timers: false });
        const ctx = createContext(backend, store);
        const app = document.createElement("div");
        app.id = "app";
        const bar = document.createElement("header");
        const stop = document.createElement("button");
        stop.className = "btn btn-stop";
        bar.append(stop);
        app.append(bar);
        document.body.append(app);
        const drawer = mountTodo(bar, ctx);
        return { backend, store, bar, drawer, stop };
    }

    function rowsOf(drawer: HTMLElement): string[] {
        return Array.from(drawer.querySelectorAll(".todo-item")).map((row) => `${row.hasAttribute("data-done") ? "x" : "-"} ${row.querySelector(".todo-text")?.textContent}`);
    }

    function type(input: HTMLInputElement, text: string): void {
        input.value = text;
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    }

    test("sits in the top bar before Stop, with the count of what is left on its button", async () => {
        const { backend, bar, drawer, stop } = mount();
        await backend.setTodo([item("a", "one"), item("b", "two", true)], null);
        expect(bar.lastElementChild).toBe(stop);
        expect(stop.previousElementSibling).toBe(drawer.toggle);
        expect(drawer.drawer.hasAttribute("inert")).toBe(true);
        drawer.open();
        await settle();
        expect(drawer.toggle.dataset["count"]).toBe("1");
        expect(drawer.toggle.title).toBe("the to-do list: 1 left");
        expect(drawer.toggle.getAttribute("aria-expanded")).toBe("true");
        expect(drawer.drawer.hasAttribute("inert")).toBe(false);
        expect(rowsOf(drawer.drawer)).toEqual(["- one", "x two"]);
    });

    test("Enter adds, a check marks done, Delete and Clear done take out, and the backend keeps it all", async () => {
        const { backend, drawer } = mount();
        drawer.open();
        await settle();
        const input = drawer.drawer.querySelector<HTMLInputElement>(".todo-input")!;
        expect(document.activeElement).toBe(input);
        expect(drawer.drawer.querySelector(".todo-list")!.hasAttribute("hidden")).toBe(true);
        type(input, "  clean the lens ");
        type(input, "order bits");
        type(input, "check the belt");
        await drawer.settled();
        expect(input.value).toBe("");
        expect(rowsOf(drawer.drawer)).toEqual(["- clean the lens", "- order bits", "- check the belt"]);
        const foot = drawer.drawer.querySelector<HTMLElement>(".button-row")!;
        expect(foot.hidden).toBe(true);
        const boxes = drawer.drawer.querySelectorAll<HTMLInputElement>(".todo-item input[type=checkbox]");
        boxes[0]!.checked = true;
        boxes[0]!.dispatchEvent(new Event("change"));
        await drawer.settled();
        expect(rowsOf(drawer.drawer)).toEqual(["x clean the lens", "- order bits", "- check the belt"]);
        expect(foot.hidden).toBe(false);
        expect(drawer.toggle.dataset["count"]).toBe("2");
        Array.from(drawer.drawer.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.getAttribute("aria-label") === "Delete order bits")!.click();
        await drawer.settled();
        Array.from(drawer.drawer.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === "Clear done")!.click();
        await drawer.settled();
        expect(rowsOf(drawer.drawer)).toEqual(["- check the belt"]);
        expect((await backend.todo()).items.map((entry) => entry.text)).toEqual(["check the belt"]);
    });

    test("a change after another window's is made on the list as it now is", async () => {
        const { backend, drawer } = mount();
        await backend.setTodo([item("a", "one")], null);
        drawer.open();
        await settle();
        // Another window adds one; this one, not knowing, checks the first off.
        await backend.setTodo([item("a", "one"), item("b", "from elsewhere")], null);
        const box = drawer.drawer.querySelector<HTMLInputElement>(".todo-item input[type=checkbox]")!;
        box.checked = true;
        box.dispatchEvent(new Event("change"));
        await drawer.settled();
        await settle();
        expect(rowsOf(drawer.drawer)).toEqual(["x one", "- from elsewhere"]);
        expect((await backend.todo()).items).toEqual([item("a", "one", true), item("b", "from elsewhere")]);
    });

    test("the button, Escape and a press outside close it; Escape gives the focus back to the button", async () => {
        const { drawer } = mount();
        drawer.toggle.click();
        expect(drawer.isOpen()).toBe(true);
        drawer.toggle.click();
        expect(drawer.isOpen()).toBe(false);
        drawer.open();
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        expect(drawer.isOpen()).toBe(false);
        expect(document.activeElement).toBe(drawer.toggle);
        expect(drawer.drawer.hasAttribute("inert")).toBe(true);
        drawer.open();
        drawer.drawer.querySelector(".todo-input")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
        expect(drawer.isOpen()).toBe(true);
        // Open, it is a pop-up: the pointer elsewhere says a press only closes it.
        expect(document.documentElement.hasAttribute("data-dismiss")).toBe(true);
        document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
        expect(drawer.isOpen()).toBe(false);
        expect(document.documentElement.hasAttribute("data-dismiss")).toBe(false);
    });

    test("arrow keys and space in it stop short of the jog keys", () => {
        const { drawer } = mount();
        drawer.open();
        const heard: string[] = [];
        const listener = (event: KeyboardEvent): void => {
            heard.push(event.key);
        };
        document.addEventListener("keydown", listener);
        const input = drawer.drawer.querySelector(".todo-input")!;
        for (const key of ["ArrowLeft", " ", "a"]) {
            input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
        }
        document.removeEventListener("keydown", listener);
        expect(heard).toEqual(["a"]);
    });
});
