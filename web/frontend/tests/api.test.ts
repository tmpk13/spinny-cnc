import { describe, expect, test } from "bun:test";

import { ApiError, HttpApi, errorMessage } from "../src/api.ts";

interface Call {
    url: string;
    method: string;
    body: unknown;
    headers: Record<string, string>;
}

function fakeFetch(reply: (call: Call) => { status: number; body?: unknown } = () => ({ status: 200, body: {} })) {
    const calls: Call[] = [];
    const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
        let body: unknown = null;
        if (init?.body instanceof FormData) {
            const fields: Record<string, unknown> = {};
            init.body.forEach((value, key) => {
                fields[key] = value instanceof File ? { name: value.name, size: value.size } : value;
            });
            body = fields;
        } else if (typeof init?.body === "string") {
            body = JSON.parse(init.body);
        }
        const call: Call = { url, method: init?.method ?? "GET", body, headers: (init?.headers as Record<string, string>) ?? {} };
        calls.push(call);
        const out = reply(call);
        const text = out.body === undefined ? "" : typeof out.body === "string" ? out.body : JSON.stringify(out.body);
        return new Response(text, { status: out.status, statusText: out.status === 200 ? "OK" : "Error" });
    };
    return { calls, fetchFn };
}

const summary = {
    id: "a1",
    name: "x",
    source: "svg",
    spot: 0.1,
    offset: { x: 0, y: 14 },
    groups: [{ label: "g", power: 500, speed: 400, enabled: true, paths: 3 }],
    stats: { length_mm: 1, seconds: 2, max_radius: 3, min_radius: 1, limited_fraction: 0, moves: 4 },
};

describe("HttpApi", () => {
    test("routes, methods and bodies", async () => {
        const { calls, fetchFn } = fakeFetch((call) => {
            if (call.url.endsWith("/api/ports")) {
                return { status: 200, body: { ports: [{ url: "/dev/ttyACM0", description: "board" }] } };
            }
            if (call.url.endsWith("/api/command")) {
                return { status: 200, body: { lines: ["ok"] } };
            }
            if (call.url.endsWith("/api/jobs") && call.method === "GET") {
                return { status: 200, body: { jobs: [summary] } };
            }
            if (call.url.endsWith("/api/run")) {
                return { status: 200, body: null };
            }
            return { status: 200, body: { connected: true } };
        });
        const api = new HttpApi("http://host:8000/", fetchFn);

        expect(await api.ports()).toEqual([{ url: "/dev/ttyACM0", description: "board" }]);
        await api.connect("/dev/ttyACM0");
        await api.disconnect();
        await api.state();
        await api.jog({ kind: "board", dx: 0, dy: -1, feed: 500 });
        await api.goto({ kind: "joint", r: 0 });
        await api.jogCancel();
        await api.setPosition({ r: 0 });
        await api.motors(false);
        await api.unlock();
        await api.realtime("hold");
        expect(await api.command("cut R10 F300 S200")).toEqual(["ok"]);
        await api.laser(50, 2000);
        await api.laserOff();
        await api.mode("const");
        await api.settings();
        await api.updateSettings({ values: { r_rate: 800 }, host: { tolerance: 0.005 } });
        await api.saveSettings();
        expect(await api.jobs()).toEqual([summary]);
        await api.job("a1");
        await api.patchJob("a1", { groups: [{ index: 0, power: 500, speed: 400, enabled: true }], offset: { x: 0, y: 14 } });
        await api.deleteJob("a1");
        await api.runJob("a1");
        await api.runHold();
        await api.runResume();
        await api.runStop();
        expect(await api.run()).toBeNull();

        const seen = calls.map((call) => `${call.method} ${call.url.replace("http://host:8000", "")}`);
        expect(seen).toEqual([
            "GET /api/ports",
            "POST /api/connect",
            "POST /api/disconnect",
            "GET /api/state",
            "POST /api/jog",
            "POST /api/goto",
            "POST /api/jog/cancel",
            "POST /api/position",
            "POST /api/motors",
            "POST /api/unlock",
            "POST /api/realtime",
            "POST /api/command",
            "POST /api/laser",
            "POST /api/laser/off",
            "POST /api/mode",
            "GET /api/settings",
            "PUT /api/settings",
            "POST /api/settings/save",
            "GET /api/jobs",
            "GET /api/jobs/a1",
            "PATCH /api/jobs/a1",
            "DELETE /api/jobs/a1",
            "POST /api/jobs/a1/run",
            "POST /api/run/hold",
            "POST /api/run/resume",
            "POST /api/run/stop",
            "GET /api/run",
        ]);
        expect(calls[1]?.body).toEqual({ url: "/dev/ttyACM0" });
        expect(calls[4]?.body).toEqual({ kind: "board", dx: 0, dy: -1, feed: 500 });
        expect(calls[4]?.headers["content-type"]).toBe("application/json");
        expect(calls[8]?.body).toEqual({ enabled: false });
        expect(calls[10]?.body).toEqual({ action: "hold" });
        expect(calls[12]?.body).toEqual({ power: 50, ms: 2000 });
        expect(calls[16]?.body).toEqual({ values: { r_rate: 800 }, host: { tolerance: 0.005 } });
    });

    test("upload is multipart with the option fields", async () => {
        const { calls, fetchFn } = fakeFetch(() => ({ status: 200, body: { id: "b2", name: "board", source: "svg" } }));
        const api = new HttpApi("", fetchFn);
        const file = new File(["<svg/>"], "board.svg", { type: "image/svg+xml" });
        const job = await api.uploadJob(file, { power: 500, speed: 400, spot: 0.1, anchor: "center", offset_x: 0, offset_y: 14 });
        expect(job.id).toBe("b2");
        expect(calls[0]?.url).toBe("/api/jobs");
        expect(calls[0]?.headers["content-type"]).toBeUndefined();
        expect(calls[0]?.body).toEqual({
            file: { name: "board.svg", size: 6 },
            power: "500",
            speed: "400",
            spot: "0.1",
            anchor: "center",
            offset_x: "0",
            offset_y: "14",
        });
    });

    test("errors carry the status and the detail", async () => {
        const { fetchFn } = fakeFetch(() => ({ status: 409, body: { detail: "not connected" } }));
        const api = new HttpApi("", fetchFn);
        let caught: unknown;
        try {
            await api.unlock();
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ApiError);
        expect((caught as ApiError).status).toBe(409);
        expect((caught as ApiError).message).toBe("not connected");
    });

    test("a network failure is an ApiError with status 0", async () => {
        const api = new HttpApi("", async () => {
            throw new TypeError("fetch failed");
        });
        let caught: unknown;
        try {
            await api.state();
        } catch (error) {
            caught = error;
        }
        expect((caught as ApiError).status).toBe(0);
        expect((caught as ApiError).message).toContain("fetch failed");
    });

    test("error messages from bodies", () => {
        expect(errorMessage({ detail: "boom" }, 400, "Bad")).toBe("boom");
        expect(errorMessage({ detail: [{ loc: ["body"], msg: "bad" }] }, 422, "Unprocessable")).toContain("bad");
        expect(errorMessage("plain text", 500, "Error")).toBe("plain text");
        expect(errorMessage(null, 502, "Bad Gateway")).toBe("502 Bad Gateway");
        expect(errorMessage(null, 503, "")).toBe("HTTP 503");
    });
});
