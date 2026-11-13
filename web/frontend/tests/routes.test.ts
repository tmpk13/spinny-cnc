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

describe("HttpApi search record routes", () => {
    test("the records are asked for by camera, and a record's page and files by name", async () => {
        const { calls, fetchFn } = fakeFetch();
        const api = new HttpApi("http://host", fetchFn);
        await api.searchLog();
        await api.searchLog("top");
        expect(calls.map((call) => [call.method, call.url.replace("http://host", ""), call.body])).toEqual([["GET", "/api/searchlog", null], ["GET", "/api/searchlog?camera=top", null]]);
        expect(api.searchLogUrl("20261112-153012-000", "report")).toBe("http://host/api/searchlog/20261112-153012-000/report");
        expect(api.searchLogUrl("20261112-153012-000", "stop-003.jpg")).toBe("http://host/api/searchlog/20261112-153012-000/stop-003.jpg");
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

describe("HttpApi G-code machine and placing routes", () => {
    test("methods, paths and bodies follow the contract", async () => {
        const { calls, fetchFn } = fakeFetch();
        const api = new HttpApi("http://host", fetchFn);
        await api.connect("/dev/ttyACM1", "opulo-lumen-rev5");
        await api.connect("/dev/ttyACM0");
        await api.patchMachineFile("marlin", ["motion", "place_z"], 12.5);
        await api.placingState();
        await api.placingAngle({ angle: 90 });
        await api.placingAngle({ clear_angle: true });
        await api.pnpReference({ job: "a1", ref: "R1" });
        await api.pnpDropReferences("a1", "R 1");
        await api.pnpDropReferences("a1");
        await api.pnpPlan("a1");
        await api.pnpPlan("a1", ["R1", "C2"]);
        await api.pnpRun("a1");
        await api.pnpRunStop();
        await api.pnpGoto({ job: "a1", ref: "R1", camera: true });
        await api.pnpResetFeeders("tape");
        await api.pnpResetFeeders();
        await api.pnpNozzle(0.5);
        await api.pnpRun("a1", ["R1"], true);
        await api.pnpReference({ job: "a1", ref: "FID1", camera: true });
        await api.pnpRunout();
        await api.pnpFiducials("a1");
        await api.topSettings({ device: "/dev/video2", clear: ["offset"] });
        await api.topStart();
        await api.topStop();
        await api.topMark();
        await api.topOffset(1.5);
        await api.topHome();
        await api.topAbort();
        await api.pnpPark();
        await api.pnpOverCamera();
        await api.pnpSwap("camera");
        await api.pnpCameraPlace({ here: true });
        await api.pnpLight(true);
        await api.pnpVacuum({ on: false, read: true });
        await api.pnpBoardsReset();
        await api.pnpBusScan();
        await api.pnpBusFeed("tape");
        expect(calls.map((call) => [call.method, call.url.replace("http://host", ""), call.body])).toEqual([
            ["POST", "/api/connect", { url: "/dev/ttyACM1", machine: "opulo-lumen-rev5" }],
            ["POST", "/api/connect", { url: "/dev/ttyACM0" }],
            ["PATCH", "/api/machines/marlin", { path: ["motion", "place_z"], value: 12.5 }],
            ["GET", "/api/pnp/placing", null],
            ["PUT", "/api/pnp/placing", { angle: 90 }],
            ["PUT", "/api/pnp/placing", { clear_angle: true }],
            ["POST", "/api/pnp/references", { job: "a1", ref: "R1" }],
            ["DELETE", "/api/pnp/references?job=a1&ref=R%201", null],
            ["DELETE", "/api/pnp/references?job=a1", null],
            ["POST", "/api/pnp/plan", { job: "a1" }],
            ["POST", "/api/pnp/plan", { job: "a1", refs: ["R1", "C2"] }],
            ["POST", "/api/pnp/run", { job: "a1", fiducials: false }],
            ["POST", "/api/pnp/run/stop", null],
            ["POST", "/api/pnp/goto", { job: "a1", ref: "R1", camera: true }],
            ["POST", "/api/pnp/feeders/reset", { feeder: "tape" }],
            ["POST", "/api/pnp/feeders/reset", {}],
            ["POST", "/api/pnp/nozzle", { step: 0.5 }],
            ["POST", "/api/pnp/run", { job: "a1", refs: ["R1"], fiducials: true }],
            ["POST", "/api/pnp/references", { job: "a1", ref: "FID1", camera: true }],
            ["POST", "/api/pnp/runout", null],
            ["POST", "/api/pnp/fiducials", { job: "a1" }],
            ["PUT", "/api/pnp/top", { device: "/dev/video2", clear: ["offset"] }],
            ["POST", "/api/pnp/top/start", null],
            ["POST", "/api/pnp/top/stop", null],
            ["POST", "/api/pnp/top/mark", null],
            ["POST", "/api/pnp/top/offset", { step: 1.5 }],
            ["POST", "/api/pnp/top/home", null],
            ["POST", "/api/pnp/top/abort", null],
            ["POST", "/api/pnp/park", null],
            ["POST", "/api/pnp/over-camera", null],
            ["POST", "/api/pnp/swap", { to: "camera" }],
            ["PUT", "/api/pnp/camera", { here: true }],
            ["POST", "/api/pnp/light", { on: true }],
            ["POST", "/api/pnp/vacuum", { on: false, read: true }],
            ["POST", "/api/pnp/boards/reset", null],
            ["POST", "/api/pnp/bus/scan", null],
            ["POST", "/api/pnp/bus/feed", { feeder: "tape" }],
        ]);
        expect(api.pnpProgramUrl("a1", ["R1", "C2"])).toBe("http://host/api/pnp/program.gcode?job=a1&refs=R1%2CC2");
        expect(api.topFrameUrl(640, true)).toMatch(/^http:\/\/host\/api\/pnp\/top\/frame\.jpg\?width=640&overlay=1&t=\d+$/);
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

describe("HttpApi Auto tab routes", () => {
    test("methods, paths and bodies follow the contract", async () => {
        const { calls, fetchFn } = fakeFetch();
        const api = new HttpApi("http://host", fetchFn);
        await api.autoSettings();
        await api.setAutoSettings({ provider: "openai", model: "qwen2.5:7b", base_url: "http://box:11434/v1" });
        await api.autoConversation();
        await api.autoSend("make a ring");
        await api.autoStop();
        await api.autoClear();
        expect(calls.map((call) => [call.method, call.url.replace("http://host", ""), call.body])).toEqual([
            ["GET", "/api/auto/settings", null],
            ["PUT", "/api/auto/settings", { provider: "openai", model: "qwen2.5:7b", base_url: "http://box:11434/v1" }],
            ["GET", "/api/auto/conversation", null],
            ["POST", "/api/auto/messages", { text: "make a ring" }],
            ["POST", "/api/auto/stop", null],
            ["DELETE", "/api/auto/conversation", null],
        ]);
    });
});

describe("HttpApi camera look, search and control routes", () => {
    test("methods, paths and bodies follow the contract", async () => {
        const { calls, fetchFn } = fakeFetch();
        const api = new HttpApi("http://host", fetchFn);
        await api.cameraSearch([1, 2, 3, 4]);
        await api.cameraSearch(null);
        await api.cameraControls("up");
        await api.setCameraControls("top", { gain: 4, exposure_time_absolute: null });
        await api.pnpLook("part");
        await api.topLook();
        await api.topBoard("a1");
        await api.topBoard(null);
        await api.topSearch([0, 0, 50, 40]);
        await api.topPlace("a1");
        expect(calls.map((call) => [call.method, call.url.replace("http://host", ""), call.body])).toEqual([
            ["POST", "/api/camera/search", { box: [1, 2, 3, 4] }],
            ["POST", "/api/camera/search", {}],
            ["GET", "/api/cameras/controls?camera=up", null],
            ["PUT", "/api/cameras/controls", { camera: "top", values: { gain: 4, exposure_time_absolute: null } }],
            ["POST", "/api/pnp/look", { spot: "part" }],
            ["POST", "/api/pnp/top/look", null],
            ["POST", "/api/pnp/top/board", { job: "a1" }],
            ["POST", "/api/pnp/top/board", { job: null }],
            ["POST", "/api/pnp/top/search", { box: [0, 0, 50, 40] }],
            ["POST", "/api/pnp/top/place", { job: "a1" }],
        ]);
    });
});

describe("HttpApi board finding routes", () => {
    test("edge corners, centering features, a lens and picked colors follow the contract", async () => {
        const { calls, fetchFn } = fakeFetch();
        const api = new HttpApi("http://host", fetchFn);
        await api.cameraEdgeCorner("j1", "top left");
        await api.topEdgeCorner("j1", "bottom right");
        await api.cameraRefine("j1", "holes", 3);
        await api.cameraLens("top", "bright", 2);
        await api.cameraLensClear("up");
        await api.cameraColor("head", "board", [640, 360]);
        await api.cameraColor("head", "board", null);
        expect(calls.map((call) => [call.method, call.url.replace("http://host", ""), call.body])).toEqual([
            ["POST", "/api/camera/edge-corner", { job: "j1", corner: "top left" }],
            ["POST", "/api/pnp/top/edge-corner", { job: "j1", corner: "bottom right" }],
            ["POST", "/api/camera/refine", { job: "j1", use: "holes", count: 3 }],
            ["POST", "/api/cameras/lens", { camera: "top", polarity: "bright", pitch: 2 }],
            ["DELETE", "/api/cameras/lens?camera=up", null],
            ["POST", "/api/cameras/color", { camera: "head", item: "board", x: 640, y: 360 }],
            ["POST", "/api/cameras/color", { camera: "head", item: "board", clear: true }],
        ]);
    });
});
