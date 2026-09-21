import { describe, expect, test } from "bun:test";

import { EventSocket, backoffDelay, backoffSchedule, parseEvent, wsUrl, type SocketLike } from "../src/ws.ts";
import type { WsEvent } from "../src/types.ts";

class FakeSocket implements SocketLike {
    onopen: ((event: unknown) => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onclose: ((event: unknown) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    closed = false;

    close(): void {
        this.closed = true;
    }
}

function harness() {
    const sockets: FakeSocket[] = [];
    const timers: { fn: () => void; ms: number; canceled: boolean }[] = [];
    const socket = new EventSocket("ws://x/ws", {
        factory: () => {
            const s = new FakeSocket();
            sockets.push(s);
            return s;
        },
        setTimer: (fn, ms) => {
            const timer = { fn, ms, canceled: false };
            timers.push(timer);
            return timer;
        },
        clearTimer: (handle) => {
            (handle as { canceled: boolean }).canceled = true;
        },
    });
    const statuses: string[] = [];
    socket.onStatus((status) => statuses.push(status));
    return { socket, sockets, timers, statuses };
}

describe("backoff", () => {
    test("doubles from the base up to the cap", () => {
        expect(backoffSchedule(7)).toEqual([500, 1000, 2000, 4000, 8000, 15000, 15000]);
    });

    test("custom base and cap", () => {
        expect(backoffSchedule(4, 100, 350)).toEqual([100, 200, 350, 350]);
        expect(backoffDelay(-1, 100, 1000)).toBe(100);
        expect(backoffDelay(2.7, 100, 1000)).toBe(400);
    });
});

describe("event parsing", () => {
    test("payload under data, payload, or flattened", () => {
        const snapshot = { connected: true, url: null, firmware: null, machine: null, run: null };
        expect(parseEvent(JSON.stringify({ type: "state", data: snapshot }))).toEqual({ type: "state", data: snapshot });
        expect(parseEvent(JSON.stringify({ type: "state", payload: snapshot }))).toEqual({ type: "state", data: snapshot });
        expect(parseEvent(JSON.stringify({ type: "console", dir: "rx", text: "ok" }))).toEqual({ type: "console", data: { dir: "rx", text: "ok" } });
        expect(parseEvent(JSON.stringify({ type: "message", level: "info", text: "hi" }))).toEqual({ type: "message", data: { level: "info", text: "hi" } });
    });

    test("junk is ignored", () => {
        expect(parseEvent("not json")).toBeNull();
        expect(parseEvent(JSON.stringify({ nope: 1 }))).toBeNull();
        expect(parseEvent(JSON.stringify({ type: "other", data: {} }))).toBeNull();
        expect(parseEvent(42)).toBeNull();
    });
});

describe("reconnect", () => {
    test("retries follow the schedule and reset after an open", () => {
        const { socket, sockets, timers, statuses } = harness();
        socket.start();
        expect(sockets.length).toBe(1);
        expect(statuses).toEqual(["connecting"]);

        sockets[0]!.onclose?.({});
        expect(statuses).toEqual(["connecting", "closed"]);
        expect(timers.map((t) => t.ms)).toEqual([500]);

        timers[0]!.fn();
        expect(sockets.length).toBe(2);
        sockets[1]!.onclose?.({});
        expect(timers.map((t) => t.ms)).toEqual([500, 1000]);

        timers[1]!.fn();
        sockets[2]!.onclose?.({});
        expect(timers.map((t) => t.ms)).toEqual([500, 1000, 2000]);

        timers[2]!.fn();
        sockets[3]!.onopen?.({});
        expect(socket.status).toBe("open");
        expect(socket.attempt).toBe(0);

        sockets[3]!.onclose?.({});
        expect(timers.map((t) => t.ms)).toEqual([500, 1000, 2000, 500]);
    });

    test("events reach listeners only from the live socket", () => {
        const { socket, sockets } = harness();
        const events: WsEvent[] = [];
        socket.onEvent((event) => events.push(event));
        socket.start();
        sockets[0]!.onopen?.({});
        sockets[0]!.onmessage?.({ data: JSON.stringify({ type: "console", data: { dir: "tx", text: "?" } }) });
        sockets[0]!.onmessage?.({ data: "garbage" });
        expect(events).toEqual([{ type: "console", data: { dir: "tx", text: "?" } }]);
    });

    test("stop closes the socket and cancels the retry", () => {
        const { socket, sockets, timers, statuses } = harness();
        socket.start();
        sockets[0]!.onclose?.({});
        socket.stop();
        expect(timers[0]!.canceled).toBe(true);
        expect(socket.status).toBe("closed");
        timers[0]!.fn();
        expect(sockets.length).toBe(1);

        socket.start();
        expect(sockets.length).toBe(2);
        socket.stop();
        expect(sockets[1]!.closed).toBe(true);
        expect(statuses[statuses.length - 1]).toBe("closed");
    });
});

describe("ws url", () => {
    test("same origin", () => {
        expect(wsUrl("", { protocol: "http:", host: "localhost:8000" })).toBe("ws://localhost:8000/ws");
        expect(wsUrl("", { protocol: "https:", host: "box" })).toBe("wss://box/ws");
    });

    test("explicit api base", () => {
        expect(wsUrl("http://box:8000", { protocol: "http:", host: "localhost:3000" })).toBe("ws://box:8000/ws");
        expect(wsUrl("https://box/api-root/", { protocol: "http:", host: "x" })).toBe("wss://box/api-root/ws");
    });
});
