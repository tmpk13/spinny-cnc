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

describe("HttpApi camera list route", () => {
    test("the cameras attached are asked for with a GET", async () => {
        const { calls, fetchFn } = fakeFetch();
        const api = new HttpApi("http://host", fetchFn);
        await api.cameras();
        expect(calls.map((call) => [call.method, call.url.replace("http://host", ""), call.body])).toEqual([["GET", "/api/cameras", null]]);
    });
});

describe("HttpApi pick and place routes", () => {
    test("methods, paths and bodies follow the contract", async () => {
        const { calls, fetchFn } = fakeFetch();
        const api = new HttpApi("http://host", fetchFn);
        await api.pnp();
        await api.pnpSettings({ device: "/dev/video2", clear: ["height"] });
        await api.pnpStart();
        await api.pnpStop();
        await api.pnpNozzle(1.5);
        await api.pnpPart();
        await api.pnpAbort();
        await api.pnpGoto({ job: "a1", ref: "R1", correct: true });
        await api.components("a 1");
        expect(calls.map((call) => [call.method, call.url.replace("http://host", ""), call.body])).toEqual([
            ["GET", "/api/pnp", null],
            ["PUT", "/api/pnp/settings", { device: "/dev/video2", clear: ["height"] }],
            ["POST", "/api/pnp/start", null],
            ["POST", "/api/pnp/stop", null],
            ["POST", "/api/pnp/nozzle", { step: 1.5 }],
            ["POST", "/api/pnp/part", null],
            ["POST", "/api/pnp/abort", null],
            ["POST", "/api/pnp/goto", { job: "a1", ref: "R1", correct: true }],
            ["GET", "/api/jobs/a%201/components", null],
        ]);
        expect(api.pnpFrameUrl(50, false)).toMatch(/^http:\/\/host\/api\/pnp\/frame\.jpg\?width=160&overlay=0&t=\d+$/);
    });
});

describe("HttpApi G-code device routes", () => {
    test("methods, paths and bodies follow the contract", async () => {
        const { calls, fetchFn } = fakeFetch();
        const api = new HttpApi("http://host", fetchFn);
        await api.devices();
        await api.deviceFile("marlin");
        await api.saveDeviceFile("marlin", "name = 1");
        await api.checkDeviceFile("marlin", "x");
        await api.deviceState();
        await api.deviceSelect({ profile: "marlin", angle: 90 });
        await api.deviceConnect();
        await api.deviceDisconnect();
        await api.deviceCommand("M114");
        await api.deviceHome();
        await api.devicePosition();
        await api.deviceReference({ job: "a1", ref: "R1" });
        await api.deviceDropReferences("a1", "R 1");
        await api.deviceDropReferences("a1");
        await api.devicePlan("a1");
        await api.devicePlan("a1", ["R1", "C2"]);
        await api.deviceRun("a1");
        await api.deviceStop();
        await api.deviceGoto("a1", "R1");
        await api.deviceResetFeeders("tape");
        await api.deviceResetFeeders();
        await api.deviceNozzle(0.5);
        expect(calls.map((call) => [call.method, call.url.replace("http://host", ""), call.body])).toEqual([
            ["GET", "/api/pnp/devices", null],
            ["GET", "/api/pnp/devices/marlin", null],
            ["PUT", "/api/pnp/devices/marlin", { text: "name = 1" }],
            ["POST", "/api/pnp/devices/marlin/check", { text: "x" }],
            ["GET", "/api/pnp/device", null],
            ["PUT", "/api/pnp/device", { profile: "marlin", angle: 90 }],
            ["POST", "/api/pnp/device/connect", null],
            ["POST", "/api/pnp/device/disconnect", null],
            ["POST", "/api/pnp/device/command", { line: "M114" }],
            ["POST", "/api/pnp/device/home", null],
            ["POST", "/api/pnp/device/position", null],
            ["POST", "/api/pnp/device/references", { job: "a1", ref: "R1" }],
            ["DELETE", "/api/pnp/device/references?job=a1&ref=R%201", null],
            ["DELETE", "/api/pnp/device/references?job=a1", null],
            ["POST", "/api/pnp/device/plan", { job: "a1" }],
            ["POST", "/api/pnp/device/plan", { job: "a1", refs: ["R1", "C2"] }],
            ["POST", "/api/pnp/device/run", { job: "a1" }],
            ["POST", "/api/pnp/device/stop", null],
            ["POST", "/api/pnp/device/goto", { job: "a1", ref: "R1" }],
            ["POST", "/api/pnp/device/feeders/reset", { feeder: "tape" }],
            ["POST", "/api/pnp/device/feeders/reset", {}],
            ["POST", "/api/pnp/device/nozzle", { step: 0.5 }],
        ]);
        expect(api.deviceProgramUrl("a1", ["R1", "C2"])).toBe("http://host/api/pnp/device/program.gcode?job=a1&refs=R1%2CC2");
    });
});

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

describe("HttpApi stencil routes", () => {
    test("an upload carries the margin, and a stencil is cut again with its own route", async () => {
        const { calls, fetchFn } = fakeFetch();
        const api = new HttpApi("http://host", fetchFn);
        await api.uploadJob(new File(["x"], "b.kicad_pcb"), { mode: "stencil", margin: 0.05 });
        await api.setJobMargin("a 1", 0.1);
        expect(calls.map((call) => [call.method, call.url.replace("http://host", ""), call.body])).toEqual([
            ["POST", "/api/jobs", { file: "b.kicad_pcb", mode: "stencil", margin: "0.05" }],
            ["POST", "/api/jobs/a%201/margin", { margin: 0.1 }],
        ]);
    });
});
