// Event feed from the backend: a WebSocket that reconnects with exponential
// backoff and reports its link status.

import type { LinkStatus } from "./state.ts";
import type { WsEvent } from "./types.ts";

export const BACKOFF_BASE_MS = 500;
export const BACKOFF_MAX_MS = 15000;

/** Delay before reconnect attempt `attempt` (0 for the first retry). */
export function backoffDelay(attempt: number, base = BACKOFF_BASE_MS, max = BACKOFF_MAX_MS): number {
    const n = Math.max(0, Math.floor(attempt));
    return Math.min(max, base * 2 ** n);
}

/** The first `count` retry delays. */
export function backoffSchedule(count: number, base = BACKOFF_BASE_MS, max = BACKOFF_MAX_MS): number[] {
    const out: number[] = [];
    for (let attempt = 0; attempt < count; attempt++) {
        out.push(backoffDelay(attempt, base, max));
    }
    return out;
}

export interface EventFeed {
    start(): void;
    stop(): void;
    onEvent(listener: (event: WsEvent) => void): () => void;
    onStatus(listener: (status: LinkStatus) => void): () => void;
}

/** The part of WebSocket the client uses, so tests can hand in a fake. */
export interface SocketLike {
    onopen: ((event: unknown) => void) | null;
    onmessage: ((event: { data: unknown }) => void) | null;
    onclose: ((event: unknown) => void) | null;
    onerror: ((event: unknown) => void) | null;
    close(): void;
}

export interface EventSocketOptions {
    factory?: (url: string) => SocketLike;
    base?: number;
    max?: number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
}

type DataOf<K extends WsEvent["type"]> = Extract<WsEvent, { type: K }>["data"];

/** Reads an event frame; `data`, `payload` or the flattened fields carry the payload. */
export function parseEvent(raw: unknown): WsEvent | null {
    if (typeof raw !== "string") {
        return null;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== "object") {
        return null;
    }
    const frame = parsed as Record<string, unknown>;
    const type = frame["type"];
    if (typeof type !== "string") {
        return null;
    }
    let data: unknown = frame["data"] ?? frame["payload"];
    if (data === undefined || data === null) {
        const rest: Record<string, unknown> = { ...frame };
        delete rest["type"];
        data = rest;
    }
    if (!data || typeof data !== "object") {
        return null;
    }
    switch (type) {
        case "state":
            return { type, data: data as DataOf<"state"> };
        case "console":
            return { type, data: data as DataOf<"console"> };
        case "progress":
            return { type, data: data as DataOf<"progress"> };
        case "heightmap":
            return { type, data: data as DataOf<"heightmap"> };
        case "message":
            return { type, data: data as DataOf<"message"> };
        default:
            return null;
    }
}

export class EventSocket implements EventFeed {
    readonly url: string;
    attempt = 0;
    status: LinkStatus = "closed";

    private readonly factory: (url: string) => SocketLike;
    private readonly base: number;
    private readonly max: number;
    private readonly setTimer: (fn: () => void, ms: number) => unknown;
    private readonly clearTimer: (handle: unknown) => void;
    private socket: SocketLike | null = null;
    private timer: unknown = null;
    private stopped = true;
    private eventListeners = new Set<(event: WsEvent) => void>();
    private statusListeners = new Set<(status: LinkStatus) => void>();

    constructor(url: string, options: EventSocketOptions = {}) {
        this.url = url;
        this.factory = options.factory ?? ((target) => new WebSocket(target) as unknown as SocketLike);
        this.base = options.base ?? BACKOFF_BASE_MS;
        this.max = options.max ?? BACKOFF_MAX_MS;
        this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
        this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    }

    start(): void {
        if (!this.stopped) {
            return;
        }
        this.stopped = false;
        this.attempt = 0;
        this.open();
    }

    stop(): void {
        this.stopped = true;
        if (this.timer !== null) {
            this.clearTimer(this.timer);
            this.timer = null;
        }
        const socket = this.socket;
        this.socket = null;
        if (socket) {
            socket.onclose = null;
            socket.onmessage = null;
            socket.onopen = null;
            socket.onerror = null;
            socket.close();
        }
        this.setStatus("closed");
    }

    onEvent(listener: (event: WsEvent) => void): () => void {
        this.eventListeners.add(listener);
        return () => {
            this.eventListeners.delete(listener);
        };
    }

    onStatus(listener: (status: LinkStatus) => void): () => void {
        this.statusListeners.add(listener);
        return () => {
            this.statusListeners.delete(listener);
        };
    }

    private open(): void {
        this.setStatus("connecting");
        let socket: SocketLike;
        try {
            socket = this.factory(this.url);
        } catch {
            this.setStatus("closed");
            this.scheduleReconnect();
            return;
        }
        this.socket = socket;
        socket.onopen = () => {
            if (this.socket !== socket) {
                return;
            }
            this.attempt = 0;
            this.setStatus("open");
        };
        socket.onmessage = (event) => {
            if (this.socket !== socket) {
                return;
            }
            const parsed = parseEvent(event.data);
            if (parsed) {
                for (const listener of [...this.eventListeners]) {
                    listener(parsed);
                }
            }
        };
        socket.onclose = () => {
            if (this.socket !== socket) {
                return;
            }
            this.socket = null;
            this.setStatus("closed");
            this.scheduleReconnect();
        };
        socket.onerror = () => {
            // The close event follows and drives the reconnect.
        };
    }

    private scheduleReconnect(): void {
        if (this.stopped || this.timer !== null) {
            return;
        }
        const delay = backoffDelay(this.attempt, this.base, this.max);
        this.attempt += 1;
        this.timer = this.setTimer(() => {
            this.timer = null;
            if (!this.stopped) {
                this.open();
            }
        }, delay);
    }

    private setStatus(status: LinkStatus): void {
        if (this.status === status) {
            return;
        }
        this.status = status;
        for (const listener of [...this.statusListeners]) {
            listener(status);
        }
    }
}

/** ws:// or wss:// URL for `/ws` next to the API base (same origin when blank). */
export function wsUrl(base: string, location: { protocol: string; host: string }): string {
    if (base !== "") {
        const url = new URL(base, `${location.protocol}//${location.host}`);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.pathname = url.pathname.replace(/\/+$/, "") + "/ws";
        url.search = "";
        return url.toString();
    }
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    return `${scheme}//${location.host}/ws`;
}
