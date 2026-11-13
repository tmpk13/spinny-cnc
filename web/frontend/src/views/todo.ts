// The to-do list: a button in the top bar, with the count of what is left
// to do, opens a drawer that slides in from the right edge under the bar.
// It holds a plain list: a line typed and Enter adds one, a check marks it
// done, Delete takes it out, Clear done takes out the ones checked. The
// same button, Escape or a press anywhere else closes it. The backend keeps
// the list (src/todo.ts), so every browser shows the same one; it is read
// again each time the drawer opens.

import { ApiError, errorText } from "../api.ts";
import { button, el } from "../dom.ts";
import { addTodo, checkTodo, clearDone, newTodoId, openCount, removeTodo, type TodoChange, type TodoItem, type TodoList } from "../todo.ts";
import type { Ctx } from "./context.ts";

export interface TodoDrawer {
    readonly toggle: HTMLButtonElement;
    readonly drawer: HTMLElement;
    isOpen(): boolean;
    open(): void;
    close(restoreFocus?: boolean): void;
    /** Waits for the changes asked for so far to be answered. */
    settled(): Promise<void>;
}

function remPx(): number {
    return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

/** Mounts the button in the top bar `bar`, before its Stop, and the drawer in the page. */
export function mountTodo(bar: HTMLElement, ctx: Ctx): TodoDrawer {
    const toggle = el("button", {
        type: "button",
        class: "btn btn-small btn-quiet todo-toggle",
        "aria-expanded": "false",
        "aria-controls": "todo-drawer",
        title: "the to-do list",
    }, "To-do");
    const input = el("input", {
        type: "text",
        class: "field todo-input",
        placeholder: "something to do, then Enter",
        "aria-label": "New to-do",
        autocomplete: "off",
        maxlength: 500,
    }) as HTMLInputElement;
    const list = el("ul", { class: "todo-list", "aria-label": "To-dos" });
    const empty = el("p", { class: "muted hint" }, "Nothing to do.");
    const close = button("Close", () => hide(true), "btn btn-small btn-quiet", "close the list (Escape)");
    const clear = button("Clear done", () => change(clearDone), "btn btn-small", "take out the to-dos checked off");
    const foot = el("div", { class: "button-row" }, clear);
    // The drawer runs the height of the screen; what it holds, only its own.
    const drawer = el("aside", { id: "todo-drawer", class: "panel todo-drawer", "aria-label": "To-do", inert: true },
        el("div", { class: "stack" },
            el("div", { class: "panel-head" }, el("h2", {}, "To-do"), close),
            input,
            list,
            empty,
            foot,
        ),
    );
    const stop = bar.querySelector(".btn-stop");
    if (stop) {
        stop.before(toggle);
    } else {
        bar.append(toggle);
    }
    (bar.closest("#app") ?? document.body).append(drawer);

    let shown: TodoList = { revision: 0, items: [] };
    // Changes go one after another, each made on the list the one before left.
    let queue: Promise<void> = Promise.resolve();
    const rows = new Map<string, { row: HTMLLIElement; box: HTMLInputElement; text: HTMLSpanElement; remove: HTMLButtonElement }>();

    function rowFor(item: TodoItem): HTMLLIElement {
        let made = rows.get(item.id);
        if (!made) {
            const box = el("input", { type: "checkbox", title: "done" }) as HTMLInputElement;
            const text = el("span", { class: "todo-text" });
            const remove = button("Delete", () => change(removeTodo(item.id)), "btn btn-small btn-quiet", "delete this to-do");
            box.addEventListener("change", () => change(checkTodo(item.id, box.checked)));
            const row = el("li", { class: "todo-item", "data-id": item.id }, el("label", { class: "check" }, box, text), remove);
            made = { row, box, text, remove };
            rows.set(item.id, made);
        }
        made.box.checked = item.done;
        made.text.textContent = item.text;
        made.remove.setAttribute("aria-label", `Delete ${item.text}`);
        made.row.toggleAttribute("data-done", item.done);
        return made.row;
    }

    /** The list as kept: rows kept for the to-dos still there, so a press under way is not lost to a row made again. */
    function draw(): void {
        const items = shown.items;
        const ids = new Set(items.map((item) => item.id));
        for (const [id, made] of rows) {
            if (!ids.has(id)) {
                made.row.remove();
                rows.delete(id);
            }
        }
        items.forEach((item, index) => {
            const row = rowFor(item);
            if (list.children[index] !== row) {
                list.insertBefore(row, list.children[index] ?? null);
            }
        });
        empty.hidden = items.length > 0;
        list.hidden = items.length === 0;
        foot.hidden = !items.some((item) => item.done);
        const left = openCount(items);
        if (left > 0) {
            toggle.dataset["count"] = String(left);
            toggle.title = `the to-do list: ${left} left`;
        } else {
            delete toggle.dataset["count"];
            toggle.title = "the to-do list";
        }
    }

    async function load(): Promise<void> {
        const got = await ctx.call(ctx.api.todo());
        if (got) {
            shown = got;
            draw();
        }
    }

    /** Puts the list `fn` makes of the one kept; made again on the list read anew when another window changed it first. */
    async function apply(fn: TodoChange): Promise<void> {
        const next = fn(shown.items);
        if (next === shown.items) {
            return;
        }
        try {
            shown = await ctx.api.setTodo(next, shown.revision);
        } catch (error) {
            if (!(error instanceof ApiError && error.status === 409)) {
                ctx.toast("error", errorText(error));
                draw();
                return;
            }
            const fresh = await ctx.call(ctx.api.todo());
            if (fresh) {
                shown = fresh;
                const again = fn(fresh.items);
                if (again !== fresh.items) {
                    shown = (await ctx.call(ctx.api.setTodo(again, fresh.revision))) ?? shown;
                }
            }
        }
        draw();
    }

    function change(fn: TodoChange): Promise<void> {
        queue = queue.then(() => apply(fn));
        return queue;
    }

    /** Under the top bar, wherever its height has put its bottom. */
    function place(): void {
        const bottom = Math.max(0, bar.getBoundingClientRect().bottom);
        drawer.style.top = `${(bottom / remPx()).toFixed(3)}rem`;
    }

    function isOpen(): boolean {
        return drawer.hasAttribute("data-open");
    }

    function show(): void {
        place();
        drawer.removeAttribute("inert");
        drawer.setAttribute("data-open", "");
        toggle.setAttribute("aria-expanded", "true");
        input.focus({ preventScroll: true });
        void load();
    }

    function hide(restoreFocus = false): void {
        if (!isOpen()) {
            return;
        }
        drawer.removeAttribute("data-open");
        drawer.setAttribute("inert", "");
        toggle.setAttribute("aria-expanded", "false");
        if (restoreFocus) {
            toggle.focus({ preventScroll: true });
        }
    }

    toggle.addEventListener("click", () => (isOpen() ? hide() : show()));
    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.isComposing) {
            event.preventDefault();
            const text = input.value;
            input.value = "";
            void change(addTodo(text, newTodoId()));
        }
    });
    // Escape closes it wherever the focus is; a press anywhere else too.
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && isOpen()) {
            event.preventDefault();
            event.stopPropagation();
            hide(true);
        }
    }, true);
    document.addEventListener("pointerdown", (event) => {
        const target = event.target as Node | null;
        if (isOpen() && target && !drawer.contains(target) && !toggle.contains(target)) {
            hide();
        }
    }, true);
    // The jog keys listen on the document: a key meant for a box or a check
    // here stops short of them.
    drawer.addEventListener("keydown", (event) => {
        if (event.key.startsWith("Arrow") || event.key === " ") {
            event.stopPropagation();
        }
    });
    window.addEventListener("resize", () => {
        if (isOpen()) {
            place();
        }
    });

    draw();
    // The count on the button from the start.
    void load();
    return {
        toggle,
        drawer,
        isOpen,
        open: show,
        close: hide,
        async settled() {
            await queue;
        },
    };
}
