// Spacing check: drives the page and its in-page mock through a set of
// states in Chromium, on every tab at a desktop and a phone width, and
// fails on spacing the stylesheet's flow rules are meant to rule out:
//
// - Blocks stacked in a panel sit one spacing token apart (--flow-tight,
//   --flow or --flow-wide from :root), the first flush with the top of the
//   box holding them and the last flush with its bottom. A gap of any
//   other size means a block's own margin decided it, or a box stacks
//   blocks without being one of the stylesheet's flow boxes.
// - Text keeps clear of the inner edge of the box drawn around it (a
//   border on that side, or a background of its own).
// - Every button shown says what it does on hover: a title.
// - The info drawings (the "i" beside some settings, drawn all at once on
//   layout/tips.html) keep their words apart: no text over other text, over
//   a solid shape, or out of the drawing.
//
// Run with `mise run test-layout`. Chromium is Playwright's build for the
// pinned playwright-core, or CHROMIUM=/path/to/chrome. Under bun the
// installer's own download fails on a TLS name check, so
// `bun x playwright-core install --dry-run chromium` gives each directory
// and URL (chromium and chromium_headless_shell); unzip each there with
// curl and touch INSTALLATION_COMPLETE in it.

import index from "../index.html";
import tips from "./tips.html";
import { chromium, type Page } from "playwright-core";

type Finding = { kind: string; where: string; detail: string };

/** Stacked blocks off the token gaps, found in the page; runs in the browser. */
function stackFindings(): Finding[] {
    const root = getComputedStyle(document.documentElement);
    const rem = parseFloat(root.fontSize);
    const tokens = ["--flow-tight", "--flow", "--flow-wide"]
        .map((name) => parseFloat(root.getPropertyValue(name)) * rem)
        .filter((value) => Number.isFinite(value));
    const name = (node: Element): string => {
        const classes = typeof node.className === "string" ? node.className.trim().split(/\s+/).filter((c) => c && c !== "hidden") : [];
        return `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ""}${classes.map((c) => `.${c}`).join("")}`;
    };
    // Lists, tables and the like lay out their own items.
    const own = "svg, table, pre, select, textarea, ul, ol, dl, .code-editor, .console-log";
    const findings: Finding[] = [];
    for (const box of Array.from(document.querySelectorAll(".panel, .panel *"))) {
        const style = getComputedStyle(box);
        if (box.getClientRects().length === 0 || !["block", "flow-root", "list-item"].includes(style.display) || box.closest(own)) {
            continue;
        }
        // The box's items: its block children, and each run of inline
        // content between them (text, labels, buttons set in a line).
        type Item = { name: string; top: number; bottom: number };
        const items: Item[] = [];
        let run: ChildNode[] = [];
        const endRun = () => {
            if (run.length > 0) {
                const range = document.createRange();
                range.setStartBefore(run[0]!);
                range.setEndAfter(run[run.length - 1]!);
                const rects = Array.from(range.getClientRects()).filter((r) => r.height > 0);
                const first = run.find((node): node is Element => node instanceof Element);
                if (rects.length > 0) {
                    items.push({ name: `inline ${first ? name(first) : "text"}`, top: Math.min(...rects.map((r) => r.top)), bottom: Math.max(...rects.map((r) => r.bottom)) });
                }
                run = [];
            }
        };
        for (const node of Array.from(box.childNodes)) {
            if (node instanceof Text) {
                if ((node.textContent ?? "").trim()) {
                    run.push(node);
                }
                continue;
            }
            if (!(node instanceof Element) || node.getClientRects().length === 0) {
                continue;
            }
            const s = getComputedStyle(node);
            if (!["static", "relative", "sticky"].includes(s.position) || s.float !== "none" || s.display === "contents") {
                continue;
            }
            if (s.display.startsWith("inline")) {
                run.push(node);
                continue;
            }
            endRun();
            // An empty box takes no room; the flow rules give it no margin.
            const r = node.getBoundingClientRect();
            if (r.height > 0) {
                items.push({ name: name(node), top: r.top, bottom: r.bottom });
            }
        }
        endRun();
        if (items.length < 2) {
            continue;
        }
        const where = `${box.parentElement ? `${name(box.parentElement)} > ` : ""}${name(box)}`;
        const rect = box.getBoundingClientRect();
        const top = rect.top + parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop);
        const lead = items[0]!.top - top;
        if (Math.abs(lead) > 0.6) {
            findings.push({ kind: "lead", where, detail: `${items[0]!.name} starts ${lead.toFixed(1)}px below the top` });
        }
        // A box that grows to fill its column is taller than its items; one
        // held at a height (data-height) or scrolling its items has a foot
        // of its own.
        const parent = box.parentElement ? getComputedStyle(box.parentElement) : null;
        const grown = parent !== null && parent.display.includes("flex") && parseFloat(style.flexGrow) > 0;
        const held = box.hasAttribute("data-height") || (/(auto|scroll)/.test(style.overflowY) && box.scrollHeight > box.clientHeight + 1);
        if (!grown && !held) {
            const bottom = rect.bottom - parseFloat(style.borderBottomWidth) - parseFloat(style.paddingBottom);
            const tail = bottom - items[items.length - 1]!.bottom;
            if (Math.abs(tail) > 0.6) {
                findings.push({ kind: "tail", where, detail: `${items[items.length - 1]!.name} ends ${tail.toFixed(1)}px above the bottom` });
            }
        }
        for (let i = 1; i < items.length; i++) {
            const gap = items[i]!.top - items[i - 1]!.bottom;
            if (!tokens.some((token) => Math.abs(gap - token) <= 0.6)) {
                findings.push({ kind: "gap", where, detail: `${items[i - 1]!.name} then ${items[i]!.name}: ${gap.toFixed(1)}px` });
            }
        }
    }
    return findings;
}

/**
 * Words in the info drawings that run into other words, onto a solid shape
 * (a part, a mark; not the faint boxes and dashed circles the words are
 * meant to sit in), across a line or an arrow, or out of the drawing; runs
 * in the browser on layout/tips.html.
 */
function drawingFindings(): Finding[] {
    const findings: Finding[] = [];
    const hit = (a: DOMRect, b: DOMRect): boolean => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
    for (const pop of Array.from(document.querySelectorAll<HTMLElement>("[data-topic]"))) {
        const where = `info drawing ${pop.dataset["topic"]}`;
        const frame = pop.querySelector("svg")!.getBoundingClientRect();
        const texts = Array.from(pop.querySelectorAll<SVGTextElement>("svg text"));
        const solid = Array.from(pop.querySelectorAll<SVGGraphicsElement>("svg rect.tip-shape, svg rect.tip-mark, svg circle.tip-shape, svg circle.tip-mark"));
        const strokes = Array.from(pop.querySelectorAll<SVGGeometryElement>("svg line, svg path.tip-shape")).filter((node) => !node.closest("marker"));
        texts.forEach((text, index) => {
            const box = text.getBoundingClientRect();
            if (box.left < frame.left - 0.5 || box.right > frame.right + 0.5 || box.top < frame.top - 0.5 || box.bottom > frame.bottom + 0.5) {
                findings.push({ kind: "draw", where, detail: `"${text.textContent}" runs out of the drawing` });
            }
            for (const other of texts.slice(index + 1)) {
                if (hit(box, other.getBoundingClientRect())) {
                    findings.push({ kind: "draw", where, detail: `"${text.textContent}" runs into "${other.textContent}"` });
                }
            }
            for (const shape of solid) {
                if (hit(box, shape.getBoundingClientRect())) {
                    findings.push({ kind: "draw", where, detail: `"${text.textContent}" over a ${shape.tagName}` });
                }
            }
            // Lines and outlines by points along them: a slanted arrow's box
            // is far larger than the arrow.
            for (const stroke of strokes) {
                const matrix = stroke.getScreenCTM();
                const length = stroke.getTotalLength();
                for (let step = 0; matrix && step <= 40; step++) {
                    const at = stroke.getPointAtLength((length * step) / 40);
                    const point = new DOMPoint(at.x, at.y).matrixTransform(matrix);
                    if (point.x > box.left + 0.5 && point.x < box.right - 0.5 && point.y > box.top + 0.5 && point.y < box.bottom - 0.5) {
                        findings.push({ kind: "draw", where, detail: `"${text.textContent}" over a ${stroke.tagName}` });
                        break;
                    }
                }
            }
        });
    }
    return findings;
}

/** Buttons shown with no title to say what they do; runs in the browser. */
function tipFindings(): Finding[] {
    const findings: Finding[] = [];
    for (const press of Array.from(document.querySelectorAll<HTMLElement>("button, [role=button]"))) {
        if (press.getClientRects().length === 0 || press.getAttribute("title")) {
            continue;
        }
        const panel = press.closest("section.panel")?.id ?? press.closest("header, nav")?.tagName.toLowerCase() ?? "page";
        const text = (press.getAttribute("aria-label") ?? press.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
        findings.push({ kind: "tip", where: panel, detail: `"${text}" has no title` });
    }
    return findings;
}

/** Text closer than 3px to the inner edge of its box; runs in the browser. */
function wallFindings(): Finding[] {
    const clear = 3;
    const transparent = (color: string) => color === "transparent" || /rgba\(.*,\s*0\)$/.test(color);
    const name = (node: Element): string => {
        const classes = typeof node.className === "string" ? node.className.trim().split(/\s+/).filter((c) => c && c !== "hidden") : [];
        return `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ""}${classes.map((c) => `.${c}`).join("")}`;
    };
    type Side = "left" | "right" | "top" | "bottom";
    const sides: Side[] = ["left", "right", "top", "bottom"];
    const drawn = (s: CSSStyleDeclaration, side: Side) => parseFloat(s.getPropertyValue(`border-${side}-width`)) > 0
        && s.getPropertyValue(`border-${side}-style`) !== "none" && !transparent(s.getPropertyValue(`border-${side}-color`));
    const wall = (start: Element, side: Side): Element | null => {
        for (let node: Element | null = start; node && node !== document.documentElement; node = node.parentElement) {
            const s = getComputedStyle(node);
            const parent = node.parentElement ? getComputedStyle(node.parentElement).backgroundColor : "";
            if (drawn(s, side) || (!transparent(s.backgroundColor) && s.backgroundColor !== parent)) {
                return node;
            }
        }
        return null;
    };
    const findings: Finding[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        const words = (text.textContent ?? "").trim();
        const parent = text.parentElement;
        // Badges are pills: their words sit close to the rim on purpose.
        if (!words || !parent || parent.closest("svg, select, option, textarea, script, style, .badge")) {
            continue;
        }
        const range = document.createRange();
        range.selectNodeContents(text);
        const lines = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
        if (lines.length === 0) {
            continue;
        }
        for (const side of sides) {
            const box = wall(parent, side);
            if (!box) {
                continue;
            }
            // Text scrolled out of a box between it and the wall is not shown there.
            let clipped = false;
            for (let node: Element | null = parent; node && node !== box; node = node.parentElement) {
                const s = getComputedStyle(node);
                if (s.overflowX !== "visible" || s.overflowY !== "visible") {
                    const r = node.getBoundingClientRect();
                    clipped ||= lines.some((line) => line.left < r.left - 0.5 || line.right > r.right + 0.5 || line.top < r.top - 0.5 || line.bottom > r.bottom + 0.5);
                }
            }
            if (clipped) {
                continue;
            }
            const s = getComputedStyle(box);
            const r = box.getBoundingClientRect();
            const border = parseFloat(s.getPropertyValue(`border-${side}-width`)) || 0;
            const gap = Math.min(...lines.map((line) => side === "left" ? line.left - (r.left + border)
                : side === "right" ? r.right - border - line.right
                : side === "top" ? line.top - (r.top + border)
                : r.bottom - border - line.bottom));
            // Below -1 the text runs on under a scrolling box's edge.
            if (gap < clear && gap > -1) {
                findings.push({ kind: "wall", where: name(box), detail: `${side} ${gap.toFixed(1)}px: ${name(parent)} "${words.slice(0, 40)}"` });
            }
        }
    }
    return findings;
}

const PAGES = ["overview", "jobs", "plot", "cam", "pnp", "auto", "config", "connection"];

async function openDetails(page: Page): Promise<void> {
    await page.evaluate(() => document.querySelectorAll("details").forEach((d) => d.setAttribute("open", "")));
    await page.waitForTimeout(150);
}

/**
 * Shows a page by its tab, kept out of the bar or not, the bar folded or
 * not, with the window at its top as a click on the tab would leave it
 * (sticky rows are measured where they rest).
 */
async function tab(page: Page, id: string): Promise<void> {
    await page.evaluate((page) => {
        document.querySelector<HTMLElement>(`.tabs .tab[data-page="${page}"]`)?.click();
        window.scrollTo(0, 0);
    }, id);
    await page.waitForTimeout(250);
}

/** Picks an item of a panel's menu. */
async function menu(page: Page, panel: string, label: string): Promise<void> {
    await page.evaluate((id) => document.querySelector<HTMLElement>(`#${id} .panel-menu-button`)?.click(), panel);
    await page.click(`.menu .menu-item:has-text('${label}')`);
    await page.waitForTimeout(200);
}

/** Each state is entered from the one before, then every listed page is checked. */
const STATES: { name: string; pages: string[]; enter: (page: Page) => Promise<void> }[] = [
    { name: "empty", pages: PAGES, enter: async () => {} },
    {
        name: "connected, job picked, folds open", pages: PAGES, enter: async (page) => {
            await tab(page, "connection");
            await page.click("#connection button:has-text('Connect')");
            await page.waitForTimeout(500);
            await tab(page, "jobs");
            await page.locator(".job-list li .job-pick").first().click();
            await page.waitForTimeout(500);
        },
    },
    {
        // The LumenPnP connected on the Connection tab by the port its file
        // claims, its cameras running, the top one looking for the board
        // with a look taken once by each, and the controls unfolded.
        name: "placing with a G-code machine, its cameras looking", pages: ["pnp", "connection"], enter: async (page) => {
            await tab(page, "connection");
            await page.click("#connection button:has-text('Disconnect')");
            await page.waitForTimeout(300);
            await page.locator("#connection select").selectOption({ index: await page.evaluate(() =>
                Array.from(document.querySelectorAll("#connection select option")).findIndex((option) => option.textContent?.includes("LumenPnP"))) });
            await page.click("#connection button:has-text('Connect')");
            await page.waitForTimeout(500);
            await tab(page, "pnp");
            await page.click("#pnp-camera button:has-text('Start')");
            await page.click("#pnp-top button:has-text('Start')");
            await page.waitForTimeout(300);
            await page.click("#pnp-camera button:has-text('Look once')");
            await page.click("#pnp-top button:has-text('Look once')");
            // A job without its board file leaves the button locked.
            await page.click("#pnp-find button:has-text('Look for board')", { timeout: 1000 }).catch(() => undefined);
            await page.waitForTimeout(800);
        },
    },
    {
        name: "the head camera's picture and look", pages: ["jobs"], enter: async (page) => {
            await tab(page, "connection");
            await page.click("#connection button:has-text('Disconnect')");
            await page.waitForTimeout(300);
            await page.locator("#connection select").selectOption({ index: await page.evaluate(() =>
                Array.from(document.querySelectorAll("#connection select option")).findIndex((option) => /spinny/i.test(option.textContent ?? ""))) });
            await page.click("#connection button:has-text('Connect')");
            await page.waitForTimeout(500);
            await tab(page, "jobs");
            await page.click("#camera button:has-text('Start')");
            await page.waitForTimeout(300);
            await page.click("#find button:has-text('Look for board')", { timeout: 1000 }).catch(() => undefined);
            await page.waitForTimeout(800);
        },
    },
    {
        name: "a conversation", pages: ["auto"], enter: async (page) => {
            await tab(page, "auto");
            await page.fill("#auto-chat textarea", "list the jobs");
            await page.click("#auto-chat button:has-text('Send')");
            await page.waitForTimeout(800);
        },
    },
    {
        name: "panels folded, stacked, stuck, one held at a height", pages: ["jobs"], enter: async (page) => {
            await tab(page, "jobs");
            await menu(page, "dro", "Fold");
            await menu(page, "console", "Stack with above");
            await menu(page, "laser", "Stick to above");
            // The height handle under the job list, on the wide layout only.
            const at = await page.evaluate(() => {
                const jobs = document.getElementById("jobs")!;
                const bottom = jobs.offsetTop + jobs.offsetHeight;
                const handle = Array.from(jobs.parentElement!.querySelectorAll<HTMLElement>(".panel-resize"))
                    .find((node) => !node.hidden && node.getClientRects().length > 0 && Math.abs(parseFloat(node.style.top) - bottom) < 1);
                handle?.scrollIntoView({ block: "center" });
                const box = handle?.getBoundingClientRect();
                return box ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : null;
            });
            if (at) {
                await page.mouse.move(at.x, at.y);
                await page.mouse.down();
                await page.mouse.move(at.x, at.y - 250, { steps: 5 });
                await page.mouse.up();
                await page.waitForTimeout(200);
            }
        },
    },
    {
        name: "edit mode, the page settings open", pages: ["jobs", "config"], enter: async (page) => {
            await page.click(".tabs-gear");
            await page.click(".page-settings button:has-text('Edit panels')");
            await page.click(".tabs-gear");
            await page.waitForTimeout(200);
        },
    },
    {
        name: "a tab kept out of the bar, the bar folded", pages: ["jobs", "cam"], enter: async (page) => {
            await page.click(".page-settings .page-settings-tabs label:has-text('CAM')");
            await page.click(".page-settings label:has-text('Fold the tab bar')");
            await page.keyboard.press("Escape");
            await page.click(".tabs-done", { force: true }).catch(() => undefined);
            await page.mouse.move(5, 600);
            await page.waitForTimeout(400);
        },
    },
    ...["Holes", "Line", "Face", "Pocket", "Profile"].map((label) => ({
        name: `plot ${label}`, pages: ["plot"], enter: async (page: Page) => {
            await tab(page, "plot");
            await page.click(`#mill-operation button:has-text('${label}')`);
            await page.waitForTimeout(300);
        },
    })),
];

const server = Bun.serve({ port: 0, routes: { "/": index, "/tips": tips } });
const browser = await chromium.launch(process.env["CHROMIUM"] ? { executablePath: process.env["CHROMIUM"] } : {});
const found = new Map<string, string>();
try {
    for (const width of [1440, 400]) {
        const context = await browser.newContext({ viewport: { width, height: 1000 } });
        const page = await context.newPage();
        page.on("pageerror", (error) => console.error(`page error: ${error.message}`));
        await page.goto(`${server.url}?mock=1`);
        await page.waitForSelector(".tabs .tab");
        await page.waitForTimeout(500);
        for (const state of STATES) {
            await state.enter(page);
            for (const id of state.pages) {
                await tab(page, id);
                await openDetails(page);
                for (const finding of [...await page.evaluate(stackFindings), ...await page.evaluate(wallFindings), ...await page.evaluate(tipFindings)]) {
                    const key = `${finding.kind} ${finding.where}: ${finding.detail.replace(/-?[\d.]+px/g, "")}`;
                    if (!found.has(key)) {
                        found.set(key, `${finding.kind.padEnd(4)} ${finding.where}: ${finding.detail}  [${id}, ${state.name}, ${width}px]`);
                    }
                }
            }
        }
        await context.close();
    }
    const drawings = await browser.newPage();
    await drawings.goto(`${server.url}tips`);
    await drawings.waitForSelector("body[data-ready]");
    for (const finding of await drawings.evaluate(drawingFindings)) {
        found.set(`${finding.kind} ${finding.where}: ${finding.detail}`, `${finding.kind.padEnd(4)} ${finding.where}: ${finding.detail}`);
    }
    await drawings.close();
} finally {
    await browser.close();
    server.stop(true);
}

for (const line of found.values()) {
    console.log(line);
}
console.log(found.size === 0 ? "spacing and tooltips: ok" : `spacing and tooltips: ${found.size} findings`);
process.exit(found.size === 0 ? 0 : 1);
