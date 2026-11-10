// One store for the page. Views subscribe to the keys they draw from.

import type { JobPlace } from "./jsontext.ts";
import type { Dimension } from "./preview.ts";
import type { PathRef } from "./regroup.ts";

import type {
    AlignState,
    AutoConversation,
    AutoEntry,
    AutoSettings,
    CamLogState,
    CamerasResponse,
    CameraState,
    Compensate,
    ComponentsResponse,
    ConsoleLine,
    DeviceState,
    Grid,
    HeightMapState,
    Job,
    JobSummary,
    Marker,
    MessageLevel,
    PnpState,
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
    /**
     * The paths picked in the preview, of the job named; null with none
     * picked. `draft` marks paths picked on the JSON panel's edit: they are
     * the edit's group and path indices, which need not be the stored
     * job's, so they find their place in the text and nothing acts on them
     * in the stored job.
     */
    selection: { job: string; paths: PathRef[]; draft?: boolean } | null;
    /** The job as the JSON panel's text has it while it is edited, drawn in the stored one's place; null with no edit. */
    jobDraft: Job | null;
    /** The selected job with the copies the Jobs panel's array fields would add, drawn on the preview until they are made or let go. */
    arrayDraft: Job | null;
    /** The place in the job the JSON panel's caret is in, drawn on the preview; null for none. */
    highlight: (JobPlace & { job: string }) | null;
    progress: Progress | null;
    settings: SettingsResponse | null;
    /** The height map, the probing under way and the probe settings; null until read. */
    heightMap: HeightMapState | null;
    /** The grid the height map panel's fields describe, drawn on the preview before it is probed. */
    probeDraft: Grid | null;
    /** The camera on the head: its settings, picture, pose and find routine; null until read. */
    camera: CameraState | null;
    /** The cameras attached, which either camera's device is picked from, and when they were listed (ms, the page's clock); null until listed. */
    cameras: (CamerasResponse & { at: number }) | null;
    /** The alignment marks and their fit; null until read. */
    align: AlignState | null;
    /** The up camera of the PNP page; null until read. */
    pnp: PnpState | null;
    /** The camera log: whether looks are kept, and the newest pictures; null until read. */
    camlog: CamLogState | null;
    /** The parts of the selected job's board; null until read. */
    components: ComponentsResponse | null;
    /** The part picked on the PNP page, by its reference. */
    pnpPart: string | null;
    /** Which machine the PNP page places with: this one, or a G-code device. */
    pnpTarget: "machine" | "device";
    /** The G-code device; null until read. */
    device: DeviceState | null;
    /** The saved positions on the board, as the backend keeps them. */
    markers: Marker[];
    /** The Auto tab's conversation and whether a turn is under way; null until read. */
    auto: AutoConversation | null;
    /** The Auto tab's provider settings; null until read. */
    autoSettings: AutoSettings | null;
    /** The Plot page's operations as a job not made yet, drawn on its preview; null with nothing to show. */
    millPlan: Job | null;
    /** The sizes of the Plot page's operation in its fields, drawn over its preview as a sketch's. */
    millDims: Dimension[];
    /** How the next run is to follow the height map: the Jobs panel's choice, which the other panels describe. */
    mapChoice: Compensate;
    /** Edits typed and not applied yet, counted by the panel that holds them (`PENDING_PAGES` and `pendingOn` put them on a tab). */
    pending: Record<string, number>;
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
        selection: null,
        jobDraft: null,
        arrayDraft: null,
        highlight: null,
        progress: null,
        settings: null,
        heightMap: null,
        probeDraft: null,
        camera: null,
        cameras: null,
        align: null,
        pnp: null,
        camlog: null,
        components: null,
        pnpPart: null,
        pnpTarget: "machine",
        device: null,
        markers: [],
        auto: null,
        autoSettings: null,
        millPlan: null,
        millDims: [],
        mapChoice: "off",
        pending: {},
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

/** Says how many edits a panel holds that are not applied; 0 when it has none. */
export function setPending(store: Store<AppState>, source: string, count: number): void {
    const pending = store.get().pending;
    if ((pending[source] ?? 0) === count) {
        return;
    }
    const next = { ...pending };
    if (count > 0) {
        next[source] = count;
    } else {
        delete next[source];
    }
    store.set({ pending: next });
}

/** All the edits not applied yet, over every panel. */
export function pendingTotal(pending: Record<string, number>): number {
    return Object.values(pending).reduce((sum, count) => sum + count, 0);
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

/** The conversation with one line put in: a new one at the end, a changed one in its place. */
export function withEntry(entries: AutoEntry[], entry: AutoEntry | null): AutoEntry[] {
    if (entry === null) {
        return entries;
    }
    const at = entries.findIndex((other) => other.id === entry.id);
    if (at >= 0) {
        return entries.map((other, index) => (index === at ? entry : other));
    }
    // A new line comes after the others, unless the feed brought it late.
    return [...entries, entry].sort((a, b) => a.id - b.id);
}

/**
 * Puts a conversation the backend answered with into the store. Lines that
 * came by the feed while the reply was on its way are newer than it, and
 * stay.
 */
export function mergeAuto(store: Store<AppState>, reply: AutoConversation): void {
    const last = reply.entries.reduce((most, entry) => Math.max(most, entry.id), 0);
    const later = (store.get().auto?.entries ?? []).filter((entry) => entry.id > last);
    store.set({ auto: later.length === 0 ? reply : { entries: [...reply.entries, ...later], busy: store.get().auto?.busy ?? reply.busy } });
}

let clears = 0;

/** How many times the feed has said the conversation was cleared. */
export function autoClears(): number {
    return clears;
}

export function noteAutoCleared(): void {
    clears += 1;
}
