// The Overview page: a card for each of the other pages, with a small
// drawing of what the page is for, its name, what it is for in words, and
// a line on what it holds now (the jobs kept and a run under way, the
// parts of the board picked, the conversation, the machine connected,
// edits not applied); a press on a card shows its page. The drawings are
// inline SVG drawn with the page's text color and one Solarized accent
// each, so they follow the light and dark themes.

import { el, replace } from "../dom.ts";
import { countText } from "../format.ts";
import type { AppState } from "../state.ts";
import type { Ctx } from "./context.ts";
import { PAGES, pendingOn, showPage, type PageId } from "./tabs.ts";

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
    jobs: [
        ["rect", { x: 14, y: 10, width: 92, height: 52, rx: 5 }],
        ["path", { d: "M32 46 H54 L64 28 H88", class: "accent" }],
        ["circle", { cx: 32, cy: 46, r: 5 }],
        ["circle", { cx: 88, cy: 28, r: 5 }],
        ["circle", { cx: 64, cy: 28, r: 2.5, class: "accent fill" }],
    ],
    // A grid, a rectangle drawn over it and the pencil drawing it.
    plot: [
        ["path", { d: "M14 18 H106 M14 36 H106 M14 54 H106 M32 8 V64 M60 8 V64 M88 8 V64", class: "faint" }],
        ["rect", { x: 32, y: 18, width: 56, height: 36, class: "accent" }],
        ["path", { d: "M88 54 L104 38 L110 44 L94 60 Z M88 54 L86 62 L94 60" }],
    ],
    // A gear beside the zigzag of a toolpath.
    cam: [
        ["path", { d: "M44.2 33.5 L48.9 33.9 L48.9 38.1 L44.2 38.5 L43.0 41.4 L46.0 45.0 L43.0 48.0 L39.4 45.0 L36.5 46.2 L36.1 50.9 L31.9 50.9 L31.5 46.2 L28.6 45.0 L25.0 48.0 L22.0 45.0 L25.0 41.4 L23.8 38.5 L19.1 38.1 L19.1 33.9 L23.8 33.5 L25.0 30.6 L22.0 27.0 L25.0 24.0 L28.6 27.0 L31.5 25.8 L31.9 21.1 L36.1 21.1 L36.5 25.8 L39.4 27.0 L43.0 24.0 L46.0 27.0 L43.0 30.6 Z" }],
        ["circle", { cx: 34, cy: 36, r: 4.5 }],
        ["path", { d: "M68 14 H106 V24 H68 V34 H106 V44 H68 V54 H106", class: "accent" }],
    ],
    // A nozzle over a part with its pins, set on the board.
    pnp: [
        ["path", { d: "M54 6 H66 V24 L62 32 H58 L54 24 Z" }],
        ["rect", { x: 46, y: 40, width: 28, height: 14, rx: 2, class: "accent" }],
        ["path", { d: "M50 40 V36 M56 40 V36 M62 40 V36 M68 40 V36 M50 54 V58 M56 54 V58 M62 54 V58 M68 54 V58", class: "accent" }],
        ["path", { d: "M14 62 H106" }],
    ],
    // A speech bubble with three dots, and a spark.
    auto: [
        ["path", { d: "M18 14 H86 Q92 14 92 20 V44 Q92 50 86 50 H44 L32 60 V50 H18 Q12 50 12 44 V20 Q12 14 18 14 Z" }],
        ["circle", { cx: 36, cy: 32, r: 3, class: "accent fill" }],
        ["circle", { cx: 52, cy: 32, r: 3, class: "accent fill" }],
        ["circle", { cx: 68, cy: 32, r: 3, class: "accent fill" }],
        ["path", { d: "M104 18 V34 M96 26 H112 M99 21 L109 31 M109 21 L99 31", class: "accent" }],
    ],
    // Three sliders, each at its own setting.
    config: [
        ["path", { d: "M16 18 H104 M16 36 H104 M16 54 H104" }],
        ["circle", { cx: 40, cy: 18, r: 5, class: "accent fill" }],
        ["circle", { cx: 80, cy: 36, r: 5, class: "accent fill" }],
        ["circle", { cx: 56, cy: 54, r: 5, class: "accent fill" }],
    ],
    // A plug on its cable, reaching for a socket.
    connection: [
        ["path", { d: "M8 36 H34" }],
        ["rect", { x: 34, y: 26, width: 18, height: 20, rx: 3 }],
        ["path", { d: "M52 30 H62 M52 42 H62", class: "accent" }],
        ["rect", { x: 74, y: 22, width: 30, height: 28, rx: 4 }],
        ["path", { d: "M84 30 V42 M94 30 V42", class: "accent" }],
    ],
    // A puzzle piece.
    plugins: [
        ["path", { d: "M30 20 H50 Q50 10 58 10 Q66 10 66 20 H86 V38 Q96 38 96 46 Q96 54 86 54 V62 H30 V48 Q40 48 40 40 Q40 32 30 32 Z", class: "accent" }],
    ],
};

/** The drawing of a page with none of its own: a page's outline. */
const PLAIN: Shape[] = [["rect", { x: 30, y: 10, width: 60, height: 52, rx: 4 }], ["path", { d: "M40 24 H80 M40 36 H80 M40 48 H66", class: "accent" }]];

/** The accent each page's card draws in, a Solarized color by name. */
const ACCENTS: Record<string, string> = {
    jobs: "var(--orange)",
    plot: "var(--green)",
    cam: "var(--cyan)",
    pnp: "var(--violet)",
    auto: "var(--magenta)",
    config: "var(--yellow)",
    connection: "var(--blue)",
    plugins: "var(--red)",
};

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
        case "jobs": {
            notes.push(countText(state.jobs.length, "job", "jobs"));
            const run = state.progress;
            if (run && (run.state === "running" || run.state === "hold")) {
                const name = state.jobs.find((job) => job.id === run.job)?.name ?? run.job;
                const share = run.total > 0 ? Math.round((100 * run.acked) / run.total) : 0;
                notes.push(`${run.state === "hold" ? "holding" : "running"} ${name}, ${share}%`);
            }
            break;
        }
        case "pnp": {
            const parts = state.components?.components.length ?? 0;
            if (parts > 0) {
                notes.push(`${countText(parts, "part", "parts")} on the board picked`);
            }
            break;
        }
        case "auto":
            if (state.auto?.busy) {
                notes.push("a turn under way");
            } else if ((state.auto?.entries.length ?? 0) > 0) {
                notes.push(countText(state.auto!.entries.length, "line", "lines"));
            }
            break;
        case "connection":
            notes.push(state.snapshot.connected ? `connected: ${state.snapshot.url ?? "a machine"}` : "nothing connected");
            break;
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
    root.append(el("div", { class: "panel-head" }, el("h2", {}, "Overview")), grid);
    const cards = PAGES.filter((page) => page.id !== "overview").map((page) => {
        const note = el("span", { class: "overview-note muted" });
        const card = el("button", {
            type: "button",
            class: "overview-card",
            title: `show the ${page.label} page: ${page.tip}`,
            "data-page": page.id,
            style: `--card-accent: ${ACCENTS[page.id] ?? "var(--accent)"}`,
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
    ctx.store.subscribe(draw, ["jobs", "progress", "components", "auto", "snapshot", "pending"]);
    draw(ctx.store.get());
}
