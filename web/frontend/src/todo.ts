// The to-do list the top bar's drawer holds, as the backend keeps it
// (GET and PUT /api/todo): plain items with a check. A change is made as a
// function of the list, so when another window changed the list first (the
// backend refuses a put made on an older revision) the same change can be
// made again on the list as it now is.

export interface TodoItem {
    id: string;
    text: string;
    done: boolean;
}

export interface TodoList {
    /** Counts the puts the list has had; a put names the one it was made on. */
    revision: number;
    items: TodoItem[];
}

/** The longest to-do, characters, as the backend takes it. */
export const MAX_TODO_TEXT = 500;

/** A change to the list: the list it makes of the one given. */
export type TodoChange = (items: TodoItem[]) => TodoItem[];

/** A to-do's text as kept: trimmed, with any run of spaces or line breaks made one space. */
export function todoText(text: string): string {
    return text.split(/\s+/).filter((word) => word !== "").join(" ");
}

/** An id no other to-do has: the time and a little chance, in letters and digits. */
export function newTodoId(now = Date.now(), random = Math.random): string {
    return `${now.toString(36)}${Math.floor(random() * 36 ** 4).toString(36).padStart(4, "0")}`;
}

/** Adds a to-do at the end; a text with nothing in it adds nothing. */
export function addTodo(text: string, id: string): TodoChange {
    const kept = todoText(text).slice(0, MAX_TODO_TEXT);
    return (items) => (kept === "" || items.some((item) => item.id === id) ? items : [...items, { id, text: kept, done: false }]);
}

/** Checks a to-do off, or back on. */
export function checkTodo(id: string, done: boolean): TodoChange {
    return (items) => items.map((item) => (item.id === id ? { ...item, done } : item));
}

export function removeTodo(id: string): TodoChange {
    return (items) => items.filter((item) => item.id !== id);
}

/** Takes away every to-do checked off. */
export const clearDone: TodoChange = (items) => items.filter((item) => !item.done);

/** How many are not checked off. */
export function openCount(items: TodoItem[]): number {
    return items.filter((item) => !item.done).length;
}
