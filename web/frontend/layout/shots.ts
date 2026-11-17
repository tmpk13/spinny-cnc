// The page over its in-page mock in Chromium, put in a state and looked
// at: what the screenshots task (shot.ts) and the budget check (budget.ts)
// both do. A shot is
//
//     { "name": "run-board", "page": "run", "width": 1440, "height": 900,
//       "dark": true, "storage": { "spinny.look": "{...}" },
//       "machine": "laser", "job": true, "view": "Board",
//       "before": "document.querySelector('#jobs .more > summary').click()",
//       "click": ["#jog button:has-text('Fine')"],
//       "drag": { "from": ".panel-tab:has-text('Markers')", "to": [180, 130] },
//       "after": "document.querySelectorAll('.panel-tab').length",
//       "selector": "#page-jobs .column", "wait": 400, "measure": true }
//
// where only the name is needed: the page opened (?page=), the window's
// size, the dark theme, localStorage set before the page loads, the mock
// machine connected (the one whose port's name holds the word, any case:
// "laser" or "lumen"), the first job picked, the view of the area pressed
// by its name on the view bar, JavaScript run in the page before the shot
// (what it returns is printed), elements clicked in turn with the mouse, a
// drag with the mouse from an element to a point, JavaScript run after
// them, one element shot instead of the window, the wait before the shot
// (ms), and whether to measure what the first view holds (measure.ts: the
// controls and words in view, the boxes, the colors, the work's share of
// the window). The machine, the job and the view come first, in that
// order, then the script before.
//
// Chromium is the one the layout check uses (CHROMIUM overrides it).

import index from "../index.html";
import { chromium } from "playwright-core";
import { measure, type Measure } from "./measure.ts";

export interface Shot {
    name: string;
    page?: string;
    width?: number;
    height?: number;
    dark?: boolean;
    storage?: Record<string, string>;
    machine?: string;
    job?: boolean;
    view?: string;
    before?: string;
    click?: string[];
    drag?: { from: string; to: [number, number] };
    after?: string;
    selector?: string;
    wait?: number;
    measure?: boolean;
}

export interface Measured {
    name: string;
    said: Measure;
}

/** Runs in the page: connects the mock machine whose port's name holds `word`; says what it did. */
async function connectMachine(word: string): Promise<string> {
    const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
    const select = document.querySelector<HTMLSelectElement>("#connection select");
    const option = select ? Array.from(select.options).find((entry) => (entry.value + entry.textContent).toLowerCase().includes(word.toLowerCase())) : undefined;
    if (!select || !option) {
        return `no port named ${word}`;
    }
    select.value = option.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    const connect = Array.from(document.querySelectorAll<HTMLButtonElement>("#connection button")).find((button) => button.textContent?.trim() === "Connect");
    if (!connect) {
        return "no Connect button";
    }
    connect.click();
    await wait(600);
    return `connected ${option.textContent}`;
}

/** Runs in the page: picks the first job of the list; says what it did. */
async function pickJob(): Promise<string> {
    const pick = document.querySelector<HTMLButtonElement>(".job-list li .job-pick");
    if (!pick) {
        return "no job to pick";
    }
    pick.click();
    await new Promise((done) => setTimeout(done, 500));
    return "picked a job";
}

/** Runs in the page: presses the view named `label` on the view bar of the pane in front; says what it did. */
async function pressView(label: string): Promise<string> {
    const bars = Array.from(document.querySelectorAll<HTMLElement>(".viewbar")).filter((bar) => !bar.hidden && bar.getBoundingClientRect().width > 0);
    for (const bar of bars) {
        // A step's button holds its number or its tick before its name.
        const press = Array.from(bar.querySelectorAll<HTMLButtonElement>("button")).find((button) => {
            const text = button.textContent?.trim() ?? "";
            return text === label || text.replace(/^\d+/, "") === label;
        });
        if (press) {
            press.click();
            await new Promise((done) => setTimeout(done, 300));
            return `view ${label}`;
        }
    }
    return `no view named ${label}`;
}

/** Lets go of the messages passing by, as a press on each does: they are not the screen at rest, and cover what is under them. */
function dropToasts(): void {
    for (const toast of Array.from(document.querySelectorAll<HTMLElement>("#toasts .toast"))) {
        toast.click();
    }
}

/**
 * Takes each shot in turn: a picture into `outDir` (none when it is null)
 * and, for a shot that asks, what its first view holds. `say` gets a line
 * for everything worth telling (a script's answer, a picture's path).
 */
export async function takeShots(shots: Shot[], outDir: string | null, say: (line: string) => void = console.log): Promise<Measured[]> {
    const server = Bun.serve({ port: 0, routes: { "/": index } });
    const browser = await chromium.launch(process.env["CHROMIUM"] ? { executablePath: process.env["CHROMIUM"] } : {});
    const measured: Measured[] = [];
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
            const told = (what: string, said: unknown): void => {
                if (said !== undefined) {
                    say(`${shot.name}${what}: ${typeof said === "string" ? said : JSON.stringify(said)}`);
                }
            };
            if (shot.machine) {
                told("", await page.evaluate(connectMachine, shot.machine));
            }
            if (shot.job) {
                told("", await page.evaluate(pickJob));
            }
            if (shot.view) {
                told("", await page.evaluate(pressView, shot.view));
            }
            if (shot.before) {
                told("", await page.evaluate(shot.before));
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
                told(" after", await page.evaluate(shot.after));
            }
            await page.waitForTimeout(shot.wait ?? 400);
            if (shot.measure) {
                await page.evaluate(dropToasts);
                await page.waitForTimeout(60);
                const said = await page.evaluate(measure);
                measured.push({ name: shot.name, said });
            }
            if (outDir !== null) {
                const path = `${outDir}/${shot.name}.png`;
                if (shot.selector) {
                    await page.locator(shot.selector).first().screenshot({ path });
                } else {
                    await page.screenshot({ path });
                }
                say(path);
            }
            await context.close();
        }
    } finally {
        await browser.close();
        server.stop(true);
    }
    return measured;
}

/** The measured shots as one markdown table, for a document. */
export function measureTable(measured: Measured[]): string {
    const lines = [
        "| Shot | Controls in view (page) | Locked | Words in view (page) | Panels | Type sizes | Text colors | Boxes (deep) | Filled colors | Work % | Scroll |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|",
    ];
    for (const { name, said } of measured) {
        lines.push(`| ${name} | ${said.controls} (${said.controlsOnPage}) | ${said.locked} | ${said.words} (${said.wordsOnPage}) | ${said.panels} | ${said.sizes} | ${said.inks} | ${said.boxes} (${said.depth}) | ${said.loud || "none"} | ${said.work} | ${said.scroll}x |`);
    }
    return lines.join("\n");
}
