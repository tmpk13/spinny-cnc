// Render check: the preview drawn by its WebGL2 painter, in the page and in
// the drawing worker, against its 2D painter, scene by scene in Chromium
// (render.html), and a drag over a large job timed with each. The pictures
// are read back inside the renderer, in the frame that drew them (a
// screenshot of a 2D canvas over a WebGL one can come back stale under
// headless Chromium's software GL).
//
// Fails when the worker does not draw with WebGL, when its picture differs
// from the page's WebGL picture, or when the WebGL picture strays from the
// 2D one by more than anti-aliasing does. Headless Chromium renders WebGL
// in software (SwiftShader), so the drag's frame rates are a floor, far
// below a graphics card's; the page's own time per step is the point.
//
// Run with `mise run test-render`; `--shots DIR` writes each scene's
// pictures (2d, gl, worker, and where gl and 2d differ) there as PNGs,
// `--no-drag` leaves the timing out, and `--headed` opens a window, where
// Chromium draws WebGL with the graphics card. Chromium as for the layout
// check.

import app from "../index.html";
import page from "./render.html";
import { chromium } from "playwright-core";

interface Drawing {
    mode: string;
    place: string;
    painter: string | null;
    frames: number;
}

interface Difference {
    mean: number;
    share: number;
}

interface Comparison {
    glVs2d: Difference;
    workerVsGl: Difference;
    worker2dVs2d: Difference;
    pngs: Record<string, string>;
}

interface DragResult {
    mode: string;
    painter: string | null;
    upPage: number;
    upMs: number;
    stepMean: number;
    stepMax: number;
    frames: number;
    seconds: number;
}

interface RenderCheck {
    scenes: string[];
    drawing(): Drawing[];
    show(name: string): Promise<void>;
    compare(shots: boolean): Promise<Comparison>;
    drag(index: number, scene: string, steps: number): Promise<DragResult>;
}

/**
 * How far the WebGL picture may stray from the 2D one: the mean over the
 * picture of the largest channel difference (0..255) and the share of
 * pixels off by more than 64. Anti-aliasing alone stays under a unit; a
 * board of hundreds of thousands of lines under a pixel apart makes a moire
 * that each painter draws its own way. Seen from low over the board, the 2D
 * painter leaves out a shape or a segment that reaches behind the eye where
 * WebGL cuts it at the eye and draws what is in front, so that scene is
 * not compared.
 */
const GL_LIMITS: Record<string, { mean: number; share: number } | null> = {
    big: { mean: 10, share: 0.02 },
    low: null,
};
const GL_LIMIT = { mean: 1.5, share: 0.002 };
/** A worker draws with the same painter as the page: the same picture. */
const WORKER_MEAN = 0.5;
const WORKER_SHARE = 0.001;

const args = process.argv.slice(2);
const shotsAt = args.indexOf("--shots");
const shots = shotsAt >= 0 ? args[shotsAt + 1] ?? null : null;
const timed = !args.includes("--no-drag");
const headed = args.includes("--headed");

// Bundled as `bun build` bundles the page: the worker loads that bundle by its http URL,
// which the dev server does not give (it names the source file).
const server = Bun.serve({ port: 0, development: false, routes: { "/": page } });
const browser = await chromium.launch({ headless: !headed, ...(process.env["CHROMIUM"] ? { executablePath: process.env["CHROMIUM"] } : {}) });
const failures: string[] = [];
try {
    const context = await browser.newContext({ viewport: { width: 900, height: 2500 } });
    const tab = await context.newPage();
    tab.on("pageerror", (error) => failures.push(`page error: ${error.message}`));
    tab.on("console", (message) => {
        if (message.type() === "warning" || message.type() === "error") {
            console.log(`console ${message.type()}: ${message.text()}`);
        }
    });
    await tab.goto(server.url.href);
    await tab.waitForFunction(() => {
        const check = (window as unknown as { renderCheck?: RenderCheck }).renderCheck;
        return check !== undefined && check.drawing().every((drawing) => drawing.painter !== null);
    }, undefined, { timeout: 20000 });
    // Each call runs in the page, where the check page put its functions.
    type Page = { renderCheck: RenderCheck };
    const drawing = await tab.evaluate(() => (window as unknown as Page).renderCheck.drawing());
    console.log(drawing.map((d) => `${d.mode}: ${d.place} ${d.painter}`).join(", "));
    console.log(`WebGL by ${await tab.evaluate(() => {
        const gl = document.createElement("canvas").getContext("webgl2");
        const info = gl?.getExtension("WEBGL_debug_renderer_info");
        return gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "nothing";
    })}`);
    const asked = drawing.map((d) => `${d.place} ${d.painter}`).join(", ");
    if (asked !== "page 2d, page gl, worker gl, worker 2d") {
        failures.push(`the previews do not draw as asked: ${asked}`);
    }
    const scenes = await tab.evaluate(() => (window as unknown as Page).renderCheck.scenes);
    console.log("scene        gl/2d mean  share    worker/gl mean  share   worker 2d/2d mean  share");
    for (const scene of scenes) {
        await tab.evaluate((name) => (window as unknown as Page).renderCheck.show(name), scene);
        const result = await tab.evaluate((wanted) => (window as unknown as Page).renderCheck.compare(wanted), shots !== null);
        const { glVs2d, workerVsGl, worker2dVs2d } = result;
        const cell = (d: Difference, width: number): string => `${d.mean.toFixed(2).padStart(width)}  ${(d.share * 100).toFixed(2).padStart(5)}%`;
        console.log(`${scene.padEnd(12)} ${cell(glVs2d, 10)}  ${cell(workerVsGl, 14)}  ${cell(worker2dVs2d, 17)}`);
        const limit = scene in GL_LIMITS ? GL_LIMITS[scene] : GL_LIMIT;
        if (limit && (glVs2d.mean > limit.mean || glVs2d.share > limit.share)) {
            failures.push(`${scene}: the WebGL picture strays from the 2D one`);
        }
        if (workerVsGl.mean > WORKER_MEAN || workerVsGl.share > WORKER_SHARE) {
            failures.push(`${scene}: the worker's WebGL picture differs from the page's`);
        }
        if (worker2dVs2d.mean > WORKER_MEAN || worker2dVs2d.share > WORKER_SHARE) {
            failures.push(`${scene}: the worker's 2D picture differs from the page's`);
        }
        if (shots !== null) {
            for (const [name, url] of Object.entries(result.pngs)) {
                await Bun.write(`${shots}/${scene}-${name}.png`, Buffer.from(url.slice(url.indexOf(",") + 1), "base64"));
            }
        }
    }
    if (timed) {
        console.log("\nthe large job: shown (the page's own ms, ms until drawn), then a drag of 120 animation frames");
        console.log("mode    draws  page ms  drawn ms  page ms/step  max ms  frames  fps");
        for (const index of [0, 1, 2, 3]) {
            const result = await tab.evaluate((at) => (window as unknown as Page).renderCheck.drag(at, "big", 120), index);
            console.log(`${result.mode.padEnd(7)} ${String(result.painter).padEnd(5)} ${result.upPage.toFixed(0).padStart(8)}  ${result.upMs.toFixed(0).padStart(8)}  ${result.stepMean.toFixed(1).padStart(12)}  ${result.stepMax.toFixed(1).padStart(6)}  ${String(result.frames).padStart(6)}  ${(result.frames / result.seconds).toFixed(1).padStart(4)}`);
        }
    }
    await context.close();

    // The page itself, bundled for release: its preview must draw in a
    // worker, which takes a script that loads with no page (nothing in the
    // bundle may touch the page while it loads).
    const site = Bun.serve({ port: 0, development: false, routes: { "/": app } });
    try {
        const appContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
        const appTab = await appContext.newPage();
        appTab.on("pageerror", (error) => failures.push(`page error in the app: ${error.message}`));
        await appTab.goto(`${site.url.href}?mock=1`);
        // Headless Chromium has only a software GL (SwiftShader), so there
        // the worker draws with the 2D painter; with a graphics card, WebGL.
        const drawn = await appTab.waitForFunction(
            () => /^worker (gl|2d)$/.test(document.querySelector("canvas.preview")?.getAttribute("data-drawing") ?? ""),
            undefined,
            { timeout: 20000 },
        ).then(() => true, () => false);
        const said = await appTab.evaluate(() => Array.from(document.querySelectorAll("canvas.preview")).map((canvas) => canvas.getAttribute("data-drawing")));
        console.log(`\nthe app's previews: ${said.join(", ")}`);
        if (!drawn) {
            failures.push("the app's preview does not draw in a worker");
        }
        await appContext.close();
    } finally {
        site.stop(true);
    }
} finally {
    await browser.close();
    server.stop(true);
}

for (const failure of failures) {
    console.log(`FAIL ${failure}`);
}
console.log(failures.length === 0 ? "render: ok" : `render: ${failures.length} failures`);
process.exit(failures.length === 0 ? 0 : 1);
