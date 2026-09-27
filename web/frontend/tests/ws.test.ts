import { describe, expect, test } from "bun:test";

import { EventSocket, STALE_MS, backoffDelay, backoffSchedule, parseEvent, wsUrl, type SocketLike } from "../src/ws.ts";
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

    test("a flattened state frame keeps the cross slide", () => {
        const machine = {
            state: "Jog",
            alarm: null,
            joint: { r: 1, a: 2, z: 0.25 },
            board: { x: 1, y: 0 },
            rate: 0,
            laser: 0,
            mode: "dyn",
            enabled: true,
            queue: { planner: 32, lines: 16 },
        };
        const frame = JSON.stringify({ type: "state", connected: true, url: null, firmware: null, machine, run: null });
        const event = parseEvent(frame);
        expect(event?.type).toBe("state");
        expect(event?.type === "state" ? event.data.machine?.joint : null).toEqual({ r: 1, a: 2, z: 0.25 });
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

describe("silence", () => {
    function silentHarness() {
        const sockets: FakeSocket[] = [];
        const timers: { fn: () => void; ms: number; canceled: boolean }[] = [];
        const clock = { now: 0 };
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
            now: () => clock.now,
        });
        const statuses: string[] = [];
        socket.onStatus((status) => statuses.push(status));
        return { socket, sockets, timers, clock, statuses };
    }
    const state = (connected: boolean): { data: string } => ({
        data: JSON.stringify({ type: "state", data: { connected, url: null, firmware: null, machine: null, run: null } }),
    });

    test("a feed silent for too long while a machine is connected is dropped and opened again", () => {
        const { socket, sockets, timers, clock, statuses } = silentHarness();
        socket.start();
        sockets[0]!.onopen?.({});
        // No machine: the backend may say nothing for a long time.
        sockets[0]!.onmessage?.(state(false));
        expect(timers.length).toBe(0);
        sockets[0]!.onmessage?.(state(true));
        expect(timers.map((t) => t.ms)).toEqual([STALE_MS]);
        // A frame of a type the page does not know still counts.
        clock.now = 3000;
        sockets[0]!.onmessage?.({ data: JSON.stringify({ type: "ping" }) });
        clock.now = STALE_MS;
        timers[0]!.fn();
        expect(socket.status).toBe("open");
        expect(timers.map((t) => t.ms)).toEqual([STALE_MS, 3000]);
        clock.now = 3000 + STALE_MS;
        timers[1]!.fn();
        expect(socket.status).toBe("closed");
        expect(statuses).toEqual(["connecting", "open", "closed"]);
        expect(sockets[0]!.closed).toBe(true);
        // The retry does not wait for a close the dead socket may never send.
        expect(timers.map((t) => t.ms)).toEqual([STALE_MS, 3000, 500]);
        sockets[0]!.onmessage?.(state(true));
        expect(timers.length).toBe(3);
        timers[2]!.fn();
        expect(sockets.length).toBe(2);
    });

    test("the check stands down when the machine goes, and with the socket", () => {
        const { socket, sockets, timers, clock } = silentHarness();
        socket.start();
        sockets[0]!.onopen?.({});
        sockets[0]!.onmessage?.(state(true));
        sockets[0]!.onmessage?.(state(false));
        clock.now = 60000;
        timers[0]!.fn();
        expect(socket.status).toBe("open");
        expect(timers.length).toBe(1);
        // Armed again by the next frame that says connected.
        sockets[0]!.onmessage?.(state(true));
        expect(timers.map((t) => t.ms)).toEqual([STALE_MS, STALE_MS]);
        sockets[0]!.onclose?.({});
        expect(timers[1]!.canceled).toBe(true);
        expect(timers.map((t) => t.ms)).toEqual([STALE_MS, STALE_MS, 500]);
        socket.stop();
        expect(timers.every((t) => t.canceled || t === timers[0])).toBe(true);
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
