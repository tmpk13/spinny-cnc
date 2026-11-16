// The Home area: a card for each of the other areas and Setup pages, with
// a small drawing of what it is for, its name, what it is for in words,
// and a line on what it holds now (the jobs kept, a run under way, the
// parts of the board picked, the machine connected, the plugins on, edits
// not applied); a press on a card shows its page. The drawings are
// inline SVG drawn with the page's text color and the page's own color
// (tabs.ts PAGES), so they follow the light and dark themes.

import { el, replace } from "../dom.ts";
import { countText } from "../format.ts";
import type { AppState } from "../state.ts";
import type { Ctx } from "./context.ts";
import { portLabel } from "./statusbar.ts";
import { accentOf, PAGES, pendingOn, showPage, type PageId } from "./tabs.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

/** One shape of a drawing: its tag and attributes; `accent` draws it in the card's accent rather than the text color. */
type Shape = [tag: string, attrs: Record<string, string | number>];

function shape([tag, attrs]: Shape): SVGElement {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) {
        node.setAttribute(name, String(value));
    }
    return node;
}

/** Each page's drawing, in a box 120 by 72; `class: "accent"` marks the parts drawn in the card's accent color. */
const DRAWINGS: Record<string, Shape[]> = {
    // A board with a track between two pads, the beam's spot on it.
    job: [
        ["rect", { x: 14, y: 10, width: 92, height: 52, rx: 5 }],
        ["path", { d: "M32 46 H54 L64 28 H88", class: "accent" }],
        ["circle", { cx: 32, cy: 46, r: 5 }],
        ["circle", { cx: 88, cy: 28, r: 5 }],
        ["circle", { cx: 64, cy: 28, r: 2.5, class: "accent fill" }],
    ],
    // A play mark beside a progress bar partly filled.
    run: [
        ["path", { d: "M18 18 L42 36 L18 54 Z", class: "accent fill" }],
        ["rect", { x: 54, y: 30, width: 52, height: 12, rx: 3 }],
        ["path", { d: "M58 36 H84", class: "accent" }],
    ],
    // A camera's body and lens.
    cameras: [
        ["rect", { x: 28, y: 22, width: 64, height: 40, rx: 5 }],
        ["path", { d: "M46 22 L52 14 H68 L74 22" }],
        ["circle", { cx: 60, cy: 42, r: 11, class: "accent" }],
    ],
    // A gear beside the zigzag of a toolpath.
    cam: [
        ["path", { d: "M44.2 33.5 L48.9 33.9 L48.9 38.1 L44.2 38.5 L43.0 41.4 L46.0 45.0 L43.0 48.0 L39.4 45.0 L36.5 46.2 L36.1 50.9 L31.9 50.9 L31.5 46.2 L28.6 45.0 L25.0 48.0 L22.0 45.0 L25.0 41.4 L23.8 38.5 L19.1 38.1 L19.1 33.9 L23.8 33.5 L25.0 30.6 L22.0 27.0 L25.0 24.0 L28.6 27.0 L31.5 25.8 L31.9 21.1 L36.1 21.1 L36.5 25.8 L39.4 27.0 L43.0 24.0 L46.0 27.0 L43.0 30.6 Z" }],
        ["circle", { cx: 34, cy: 36, r: 4.5 }],
        ["path", { d: "M68 14 H106 V24 H68 V34 H106 V44 H68 V54 H106", class: "accent" }],
    ],
    // Three sliders, each at its own setting.
    machines: [
        ["path", { d: "M16 18 H104 M16 36 H104 M16 54 H104" }],
        ["circle", { cx: 40, cy: 18, r: 5, class: "accent fill" }],
        ["circle", { cx: 80, cy: 36, r: 5, class: "accent fill" }],
        ["circle", { cx: 56, cy: 54, r: 5, class: "accent fill" }],
    ],
    // A puzzle piece.
    ui: [
        ["path", { d: "M30 20 H50 Q50 10 58 10 Q66 10 66 20 H86 V38 Q96 38 96 46 Q96 54 86 54 V62 H30 V48 Q40 48 40 40 Q40 32 30 32 Z", class: "accent" }],
    ],
};

/** The drawing of a page with none of its own: a page's outline. */
const PLAIN: Shape[] = [["rect", { x: 30, y: 10, width: 60, height: 52, rx: 4 }], ["path", { d: "M40 24 H80 M40 36 H80 M40 48 H66", class: "accent" }]];

export function drawingOf(page: string): SVGSVGElement {
    const root = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
    root.setAttribute("viewBox", "0 0 120 72");
    root.setAttribute("class", "overview-drawing");
    root.setAttribute("aria-hidden", "true");
    for (const entry of DRAWINGS[page] ?? PLAIN) {
        root.append(shape(entry));
    }
    return root;
}

/** What a page holds now, in a few words; empty when there is nothing to say. */
export function pageNote(page: PageId | string, state: AppState): string {
    const notes: string[] = [];
    switch (page) {
        case "job":
            notes.push(countText(state.jobs.length, "job", "jobs"));
            if (state.auto?.busy) {
                notes.push("the assistant at work");
            }
            break;
        case "run": {
            const run = state.progress;
            if (run && (run.state === "running" || run.state === "hold")) {
                const name = state.jobs.find((job) => job.id === run.job)?.name ?? run.job;
                const share = run.total > 0 ? Math.round((100 * run.acked) / run.total) : 0;
                notes.push(`${run.state === "hold" ? "holding" : "running"} ${name}, ${share}%`);
            }
            const parts = state.components?.components.length ?? 0;
            if (parts > 0) {
                notes.push(`${countText(parts, "part", "parts")} on the board picked`);
            }
            break;
        }
        case "machines": {
            // The port by the name the Connection panel gives it, shorter
            // than its path (a by-id path runs to sixty letters).
            const url = state.snapshot.url;
            const port = url ? state.ports.find((entry) => entry.url === url || entry.device === url) : undefined;
            notes.push(state.snapshot.connected ? `connected: ${port ? portLabel(port) : url ?? "a machine"}` : "nothing connected");
            break;
        }
        case "ui": {
            const plugins = state.plugins ?? [];
            if (plugins.length > 0) {
                notes.push(`${plugins.filter((plugin) => plugin.enabled).length} of ${countText(plugins.length, "plugin", "plugins")} on`);
            }
            break;
        }
        default:
            break;
    }
    const pending = pendingOn(state.pending, page as PageId);
    if (pending > 0) {
        notes.push(`${countText(pending, "edit", "edits")} not applied`);
    }
    return notes.join("; ");
}

export function mountOverview(root: HTMLElement, ctx: Ctx): void {
    const grid = el("div", { class: "overview-cards" });
    root.append(el("div", { class: "panel-head" }, el("h2", {}, "Home")), grid);
    const cards = PAGES.filter((page) => page.id !== "home").map((page) => {
        const note = el("span", { class: "overview-note muted" });
        const card = el("button", {
            type: "button",
            class: "overview-card",
            title: `show the ${page.label} page: ${page.tip}`,
            "data-page": page.id,
            style: `--card-accent: ${accentOf(page.id)}`,
        }, drawingOf(page.id), el("span", { class: "overview-name" }, page.label), el("span", { class: "overview-tip muted" }, page.tip), note);
        card.addEventListener("click", () => showPage(page.id));
        return { page: page.id, card, note };
    });
    replace(grid, ...cards.map((entry) => entry.card));
    const draw = (state: AppState): void => {
        for (const { page, note } of cards) {
            const text = pageNote(page, state);
            if (note.textContent !== text) {
                note.textContent = text;
            }
            note.hidden = text === "";
        }
    };
    ctx.store.subscribe(draw, ["jobs", "progress", "components", "auto", "snapshot", "ports", "pending", "plugins"]);
    draw(ctx.store.get());
}
