import { describe, expect, test } from "bun:test";

import { HttpApi } from "../src/api.ts";

interface Call {
    url: string;
    method: string;
    body: unknown;
}

function fakeFetch(): { calls: Call[]; fetchFn: (url: string, init?: RequestInit) => Promise<Response> } {
    const calls: Call[] = [];
    const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
        let body: unknown = null;
        if (init?.body instanceof FormData) {
            const fields: Record<string, unknown> = {};
            init.body.forEach((value, key) => {
                fields[key] = value instanceof File ? value.name : value;
            });
            body = fields;
        } else if (typeof init?.body === "string") {
            body = JSON.parse(init.body);
        }
        calls.push({ url, method: init?.method ?? "GET", body });
        return new Response("{}", { status: 200, statusText: "OK" });
    };
    return { calls, fetchFn };
}

describe("HttpApi camera, alignment and pad routes", () => {
    test("methods, paths and bodies follow the contract", async () => {
        const { calls, fetchFn } = fakeFetch();
        const api = new HttpApi("http://host", fetchFn);
        await api.camera();
        await api.cameraSettings({ fps: 15 });
        await api.cameraStart();
        await api.cameraStop();
        await api.cameraPose();
        await api.cameraBoard("a1");
        await api.cameraBoard(null);
        await api.cameraMark({ depth: 0.1, plunge: 30 });
        await api.cameraMark({ here: true });
        await api.cameraFind(2);
        await api.cameraAbort();
        await api.align();
        await api.alignMark({ job: "a1", nearest: "pad", within: 5 });
        await api.alignCapture("a1");
        await api.alignDeleteMark(2);
        await api.alignClear();
        await api.alignFit("a1");
        await api.alignApply("a1");
        await api.probePads({ job: "a1", min_area: 0.5, max_points: 100 });
        await api.planPads({ job: "a1" });
        expect(calls.map((call) => [call.method, call.url.replace("http://host", ""), call.body])).toEqual([
            ["GET", "/api/camera", null],
            ["PUT", "/api/camera/settings", { fps: 15 }],
            ["POST", "/api/camera/start", null],
            ["POST", "/api/camera/stop", null],
            ["GET", "/api/camera/pose", null],
            ["POST", "/api/camera/board", { job: "a1" }],
            ["POST", "/api/camera/board", { job: null }],
            ["POST", "/api/camera/mark", { depth: 0.1, plunge: 30 }],
            ["POST", "/api/camera/mark", { here: true }],
            ["POST", "/api/camera/find", { step: 2 }],
            ["POST", "/api/camera/abort", null],
            ["GET", "/api/align", null],
            ["POST", "/api/align/mark", { job: "a1", nearest: "pad", within: 5 }],
            ["POST", "/api/align/capture", { job: "a1" }],
            ["DELETE", "/api/align/marks/2", null],
            ["DELETE", "/api/align", null],
            ["POST", "/api/align/fit", { job: "a1" }],
            ["POST", "/api/align/apply", { job: "a1" }],
            ["POST", "/api/heightmap/pads", { job: "a1", min_area: 0.5, max_points: 100 }],
            ["POST", "/api/heightmap/pads/plan", { job: "a1" }],
        ]);
        // The picture's address is no fetch: a URL with the size, the overlay and a time against caches.
        expect(api.cameraFrameUrl(640, true)).toMatch(/^http:\/\/host\/api\/camera\/frame\.jpg\?width=640&overlay=1&t=\d+$/);
        expect(api.cameraFrameUrl(10, false)).toContain("width=160&overlay=0");
        expect(api.cameraFrameUrl(9000, false)).toContain("width=4096");
        expect(calls).toHaveLength(20);
        // An upload carries the mode and the thickness as form fields.
        await api.uploadJob(new File(["x"], "b.kicad_pcb"), { mode: "dispense", thickness: 0.15 });
        expect(calls.at(-1)?.body).toEqual({ file: "b.kicad_pcb", mode: "dispense", thickness: "0.15" });
    });
});
