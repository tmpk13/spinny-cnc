// One store for the page. Views subscribe to the keys they draw from.

import type {
    ConsoleLine,
    Job,
    JobSummary,
    MessageLevel,
    Port,
    Progress,
    SettingsResponse,
    Snapshot,
} from "./types.ts";

export type Listener<T> = (state: T, previous: T) => void;

export class Store<T extends object> {
    private state: T;
    private listeners = new Set<{ fn: Listener<T>; keys: (keyof T)[] | null }>();

    constructor(initial: T) {
        this.state = initial;
    }

    get(): T {
        return this.state;
    }

    /** Shallow merge; listeners run only when a key actually changed. */
    set(patch: Partial<T>): void {
        const previous = this.state;
        const changed: (keyof T)[] = [];
        for (const key of Object.keys(patch) as (keyof T)[]) {
            if (!Object.is(previous[key], patch[key])) {
                changed.push(key);
            }
        }
        if (changed.length === 0) {
            return;
        }
        this.state = { ...previous, ...patch };
        for (const listener of [...this.listeners]) {
            if (listener.keys === null || listener.keys.some((key) => changed.includes(key))) {
                listener.fn(this.state, previous);
            }
        }
    }

    update(fn: (state: T) => Partial<T>): void {
        this.set(fn(this.state));
    }

    /** With `keys`, the listener runs only when one of them changed. */
    subscribe(fn: Listener<T>, keys?: (keyof T)[]): () => void {
        const entry = { fn, keys: keys ?? null };
        this.listeners.add(entry);
        return () => {
            this.listeners.delete(entry);
        };
    }
}

/** WebSocket link to the backend, shown in the status bar. */
export type LinkStatus = "connecting" | "open" | "closed";

export interface Toast {
    id: number;
    level: MessageLevel;
    text: string;
}

export interface AppState {
    snapshot: Snapshot;
    link: LinkStatus;
    ports: Port[];
    jobs: JobSummary[];
    /** The selected job in full. */
    job: Job | null;
    progress: Progress | null;
    settings: SettingsResponse | null;
    console: ConsoleLine[];
    /** Show the link's status polls in the console. */
    showPolls: boolean;
    toasts: Toast[];
    mock: boolean;
}

export const CONSOLE_LIMIT = 400;

export function emptySnapshot(): Snapshot {
    return { connected: false, url: null, firmware: null, machine: null, run: null };
}

export function initialState(mock: boolean): AppState {
    return {
        snapshot: emptySnapshot(),
        link: "closed",
        ports: [],
        jobs: [],
        job: null,
        progress: null,
        settings: null,
        console: [],
        showPolls: false,
        toasts: [],
        mock,
    };
}

export function appendConsole(store: Store<AppState>, line: ConsoleLine): void {
    // The link polls for status several times a second. Keeping those would
    // push every real line out of the buffer within a minute, so they are
    // dropped unless someone asked to watch them.
    if (line.poll && !store.get().showPolls) {
        return;
    }
    const lines = store.get().console;
    const next = lines.length >= CONSOLE_LIMIT ? lines.slice(lines.length - CONSOLE_LIMIT + 1) : lines.slice();
    next.push(line);
    store.set({ console: next });
}

let nextToast = 1;

export function pushToast(store: Store<AppState>, level: MessageLevel, text: string): Toast {
    const toast: Toast = { id: nextToast++, level, text };
    store.set({ toasts: [...store.get().toasts, toast] });
    return toast;
}

export function dropToast(store: Store<AppState>, id: number): void {
    const toasts = store.get().toasts;
    if (toasts.some((toast) => toast.id === id)) {
        store.set({ toasts: toasts.filter((toast) => toast.id !== id) });
    }
}
