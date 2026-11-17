// Screenshots of the page over its in-page mock in Chromium, to see a
// change as it looks: `mise run shots -- SPEC.json OUTDIR`. The spec is a
// JSON list of shots, each
//
//     { "name": "jobs-dark", "page": "jobs", "width": 1440, "height": 1000,
//       "dark": true, "storage": { "spinny.look": "{...}" },
//       "before": "document.querySelector('#jobs .panel-menu-button').click()",
//       "click": ["#jog button:has-text('Fine')"],
//       "drag": { "from": ".panel-tab:has-text('Markers')", "to": [180, 130] },
//       "after": "document.querySelectorAll('.panel-tab').length",
//       "selector": "#page-jobs .column", "wait": 400, "measure": true }
//
// where only the name is needed: the page opened (?page=), the window's
// size, the dark theme, localStorage set before the page loads, JavaScript
// run in the page before the shot (what it returns is printed), elements
// clicked in turn with the mouse, a drag with the mouse from an element to
// a point, JavaScript run after them, one
// element shot instead of the window, the wait before the shot (ms), and
// whether to measure what the first view holds (layout/measure.ts: the
// controls and words in view, the boxes, the colors, the work's share of
// the window), printed per shot and as one table at the end.
// Each shot is OUTDIR/NAME.png. Paths are taken from where mise was run.
// Chromium is the one the layout check uses (CHROMIUM overrides it).

import { isAbsolute, resolve } from "node:path";
import index from "../index.html";
import { chromium } from "playwright-core";
import { measure, type Measure } from "./measure.ts";

type Shot = { name: string; page?: string; width?: number; height?: number; before?: string; selector?: string; wait?: number; dark?: boolean; storage?: Record<string, string>; click?: string[]; drag?: { from: string; to: [number, number] }; after?: string; measure?: boolean };

const here = process.env["MISE_ORIGINAL_CWD"] ?? process.cwd();
const [specArg, outArg] = process.argv.slice(2);
if (!specArg || !outArg) {
    console.error("usage: shots SPEC.json OUTDIR");
    process.exit(2);
}
const specPath = isAbsolute(specArg) ? specArg : resolve(here, specArg);
const outDir = isAbsolute(outArg) ? outArg : resolve(here, outArg);
const shots: Shot[] = JSON.parse(await Bun.file(specPath).text());
const server = Bun.serve({ port: 0, routes: { "/": index } });
const browser = await chromium.launch(process.env["CHROMIUM"] ? { executablePath: process.env["CHROMIUM"] } : {});
const measured: { name: string; said: Measure }[] = [];
try {
    for (const shot of shots) {
        const context = await browser.newContext({ viewport: { width: shot.width ?? 1440, height: shot.height ?? 1000 }, colorScheme: shot.dark ? "dark" : "light" });
        const page = await context.newPage();
        page.on("pageerror", (error) => console.error(`page error: ${error.message}`));
        page.on("console", (message) => {
            if (message.type() === "error") {
                console.error(`console: ${message.text()}`);
            }
        });
        if (shot.storage) {
            await page.addInitScript((entries: Record<string, string>) => {
                for (const [key, value] of Object.entries(entries)) {
                    localStorage.setItem(key, value);
                }
            }, shot.storage);
        }
        await page.goto(`${server.url}?mock=1${shot.page ? `&page=${shot.page}` : ""}`);
        await page.waitForSelector(".tabs .tab[aria-selected=\"true\"]");
        await page.waitForTimeout(600);
        if (shot.before) {
            const said = await page.evaluate(shot.before);
            if (said !== undefined) {
                console.log(`${shot.name}: ${typeof said === "string" ? said : JSON.stringify(said)}`);
            }
        }
        for (const selector of shot.click ?? []) {
            await page.locator(selector).first().click();
            await page.waitForTimeout(100);
        }
        if (shot.drag) {
            const box = (await page.locator(shot.drag.from).first().boundingBox())!;
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.down();
            for (let step = 1; step <= 12; step++) {
                await page.mouse.move(box.x + box.width / 2 + ((shot.drag.to[0] - box.x - box.width / 2) * step) / 12, box.y + box.height / 2 + ((shot.drag.to[1] - box.y - box.height / 2) * step) / 12);
                await page.waitForTimeout(20);
            }
            await page.mouse.up();
        }
        if (shot.after) {
            const said = await page.evaluate(shot.after);
            if (said !== undefined) {
                console.log(`${shot.name} after: ${typeof said === "string" ? said : JSON.stringify(said)}`);
            }
        }
        await page.waitForTimeout(shot.wait ?? 400);
        if (shot.measure) {
            measured.push({ name: shot.name, said: await page.evaluate(measure) });
        }
        const path = `${outDir}/${shot.name}.png`;
        if (shot.selector) {
            await page.locator(shot.selector).first().screenshot({ path });
        } else {
            await page.screenshot({ path });
        }
        console.log(path);
        await context.close();
    }
} finally {
    await browser.close();
    server.stop(true);
}
if (measured.length > 0) {
    // One table of every shot measured, as markdown, for a document.
    console.log("\n| Shot | Controls in view (page) | Locked | Words in view (page) | Panels | Type sizes | Text colors | Boxes (deep) | Filled colors | Work % | Scroll |");
    console.log("|---|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|");
    for (const { name, said } of measured) {
        console.log(`| ${name} | ${said.controls} (${said.controlsOnPage}) | ${said.locked} | ${said.words} (${said.wordsOnPage}) | ${said.panels} | ${said.sizes} | ${said.inks} | ${said.boxes} (${said.depth}) | ${said.loud || "none"} | ${said.work} | ${said.scroll}x |`);
    }
}
