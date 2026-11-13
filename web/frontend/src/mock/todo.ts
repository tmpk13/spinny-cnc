// The mock's twin of the backend's to-do list (spinny_web.todo): kept in
// memory, put whole with the revision it was changed on, refused with the
// backend's words.

import { ApiError } from "../api.ts";
import type { TodoItem, TodoList } from "../todo.ts";

export const MAX_ITEMS = 500;
export const MAX_TEXT = 500;
const ITEM_ID = /^[A-Za-z0-9_-]{1,40}$/;

/** The items with their text trimmed, or the backend's 400 for what is wrong with them. */
export function checkedTodos(items: TodoItem[]): TodoItem[] {
    if (items.length > MAX_ITEMS) {
        throw new ApiError(400, `at most ${MAX_ITEMS} to-dos`);
    }
    const ids = new Set<string>();
    return items.map((item) => {
        if (typeof item.id !== "string" || !ITEM_ID.test(item.id)) {
            throw new ApiError(400, "a to-do's id is 1 to 40 letters, digits, _ or -");
        }
        if (ids.has(item.id)) {
            throw new ApiError(400, `two to-dos have the id '${item.id}'`);
        }
        const text = String(item.text).split(/\s+/).filter((word) => word !== "").join(" ");
        if (text === "" || text.length > MAX_TEXT) {
            throw new ApiError(400, `a to-do is 1 to ${MAX_TEXT} characters`);
        }
        ids.add(item.id);
        return { id: item.id, text, done: item.done === true };
    });
}

export class MockTodo {
    private list: TodoList = { revision: 0, items: [] };

    get(): TodoList {
        return { revision: this.list.revision, items: this.list.items.map((item) => ({ ...item })) };
    }

    put(items: TodoItem[], revision: number | null): TodoList {
        const kept = checkedTodos(items);
        if (revision !== null && revision !== this.list.revision) {
            throw new ApiError(409, "the list changed in another window: read it again");
        }
        this.list = { revision: this.list.revision + 1, items: kept };
        return this.get();
    }
}
