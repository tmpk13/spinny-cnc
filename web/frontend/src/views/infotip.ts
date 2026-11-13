// A small "i" beside a group of settings that shows, when pressed, a
// drawing of what they mean: the heights the nozzle works at, a feeder's
// places, the top camera's offset from the nozzle, the up camera's place
// and scale, how references place the board, and the nozzle's runout.
// The drawings are inline SVG colored by the stylesheet, so they follow
// the page's light and dark themes.

import { popUp } from "../dismiss.ts";
import { el } from "../dom.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

function svg(tag: string, attrs: Record<string, string | number>, ...children: (SVGElement | string)[]): SVGElement {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) {
        node.setAttribute(name, String(value));
    }
    for (const child of children) {
        node.append(child);
    }
    return node;
}

const line = (x1: number, y1: number, x2: number, y2: number, kind = "tip-line"): SVGElement => svg("line", { x1, y1, x2, y2, class: kind });
const text = (x: number, y: number, words: string, anchor = "start"): SVGElement => svg("text", { x, y, "text-anchor": anchor, class: "tip-text" }, words);
const rect = (x: number, y: number, width: number, height: number, kind = "tip-shape"): SVGElement => svg("rect", { x, y, width, height, class: kind });
const circle = (cx: number, cy: number, r: number, kind = "tip-shape"): SVGElement => svg("circle", { cx, cy, r, class: kind });
const arrow = (x1: number, y1: number, x2: number, y2: number): SVGElement => svg("line", { x1, y1, x2, y2, class: "tip-arrow", "marker-end": "url(#tip-head)" });

/** The arrowhead every drawing's arrows end in. */
function defs(): SVGElement {
    return svg("defs", {},
        svg("marker", { id: "tip-head", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: "auto-start-reverse" },
            svg("path", { d: "M0,0 L10,5 L0,10 z", class: "tip-arrowhead" })),
    );
}

/** A nozzle seen from the side, its tip at (x, y). */
function nozzle(x: number, y: number): SVGElement {
    return svg("g", {}, rect(x - 4, y - 26, 8, 18), svg("path", { d: `M${x - 4},${y - 8} L${x},${y} L${x + 4},${y - 8} z`, class: "tip-shape" }));
}

export type InfoTopic = "heights" | "feeder" | "offset" | "upcam" | "references" | "runout";

const CAPTIONS: Record<InfoTopic, string> = {
    heights: "Z grows upward. Moves across go at Safe Z; the tip goes down to a feeder's Z to pick, to Place Z to put a part down, and to the bottom camera's Z to be seen sharp.",
    feeder: "A feeder's first part is at `at`; the next ones follow by `pitch`. A tray goes `columns` across, then on by `row_pitch` to the next row.",
    offset: "The top camera rides on the head: its picture's center is the offset away from the nozzle's tip. Camera here and Go to with the camera use it.",
    upcam: "The bottom camera is fixed and looks up. Its place is the head's X Y with the nozzle over its picture's center; Center nozzle finds that place and the picture's scale, roll and mirror by moving the nozzle over it.",
    references: "Each reference pairs a part on the board with the place it was found on the machine. One gives the shift (with the typed turn); two or more give the shift and the turn. Every part is placed by that fit.",
    runout: "A bent tip swings round its turning axis. Measure runout turns the nozzle over the bottom camera and fits the circle, so each place keeps the tip, not the axis, on its point.",
};

function drawing(topic: InfoTopic): SVGElement {
    const root = svg("svg", { viewBox: "0 0 220 120", class: "tip-drawing", role: "img", "aria-label": CAPTIONS[topic] }, defs());
    switch (topic) {
        case "heights":
            root.append(
                line(10, 22, 210, 22, "tip-dash"), text(20, 18, "Safe Z"),
                nozzle(50, 52), rect(30, 58, 40, 10), text(50, 80, "feeder", "middle"), line(28, 52, 72, 52, "tip-dash"), text(74, 55, "pick Z"),
                nozzle(120, 86), rect(95, 92, 50, 8), text(120, 112, "board", "middle"), line(93, 86, 147, 86, "tip-dash"), text(149, 89, "Place Z"),
                nozzle(200, 70), rect(190, 82, 20, 12), text(216, 108, "bottom camera", "end"),
                arrow(12, 66, 12, 26), text(16, 48, "Z"),
            );
            break;
        case "feeder":
            for (let row = 0; row < 2; row += 1) {
                for (let column = 0; column < 4; column += 1) {
                    root.append(rect(30 + column * 40, 30 + row * 40, 16, 12, column === 0 && row === 0 ? "tip-mark" : "tip-shape"));
                }
            }
            root.append(
                text(38, 22, "at", "middle"),
                arrow(46, 50, 76, 50), text(61, 62, "pitch", "middle"),
                arrow(38, 46, 38, 66), text(42, 92, "row_pitch"),
                text(110, 112, "columns = 4", "middle"),
            );
            break;
        case "offset":
            root.append(
                rect(40, 30, 140, 60, "tip-faint"), text(110, 24, "head, seen from above", "middle"),
                circle(70, 70, 6, "tip-mark"), text(70, 104, "nozzle tip", "middle"),
                rect(135, 38, 30, 22), circle(150, 49, 4), text(150, 104, "top camera", "middle"),
                arrow(74, 67, 146, 51), text(112, 54, "offset", "middle"),
            );
            break;
        case "upcam":
            root.append(
                rect(20, 20, 110, 80, "tip-faint"), line(75, 20, 75, 100, "tip-dash"), line(20, 60, 130, 60, "tip-dash"),
                circle(88, 52, 7, "tip-mark"), text(75, 114, "the bottom camera's picture", "middle"),
                arrow(88, 52, 77, 59),
                text(136, 34, "the nozzle, seen"), text(136, 46, "off center: the"), text(136, 58, "head moves until"), text(136, 70, "it sits on the"), text(136, 82, "crosshair"),
            );
            break;
        case "references":
            root.append(
                rect(15, 30, 70, 50, "tip-faint"), text(50, 15, "board", "middle"),
                circle(30, 45, 4, "tip-mark"), circle(70, 65, 4, "tip-mark"), text(30, 94, "R1"), text(62, 94, "C2"),
                svg("g", { transform: "rotate(-12 160 55)" }, rect(125, 30, 70, 50, "tip-faint"), circle(140, 45, 4, "tip-mark"), circle(180, 65, 4, "tip-mark")),
                text(160, 15, "on the machine", "middle"),
                arrow(36, 45, 132, 50), arrow(76, 65, 170, 72), text(110, 112, "shift + turn", "middle"),
            );
            break;
        case "runout":
            root.append(
                circle(110, 60, 30, "tip-dash"), circle(110, 60, 3, "tip-mark"), text(110, 76, "axis", "middle"),
                circle(140, 60, 5), circle(125, 34, 5), circle(95, 34, 5), circle(80, 60, 5), circle(95, 86, 5), circle(125, 86, 5),
                arrow(113, 60, 134, 60), text(110, 112, "the tip at six turns", "middle"),
            );
            break;
    }
    return root;
}

/** The tip open now: one at a time. */
let openTip: { tip: HTMLElement; close: () => void } | null = null;

/** Closes the tip open, if any. */
export function closeInfoTip(): void {
    openTip?.close();
}

/**
 * Places a pop under (or over, when there is no room) the mark it opens
 * from, inside the window: it is fixed to the window, so a panel that
 * scrolls or clips its content cannot cut it off.
 */
function placePop(pop: HTMLElement, mark: Element): void {
    const at = mark.getBoundingClientRect();
    const room = { width: document.documentElement.clientWidth || window.innerWidth, height: window.innerHeight };
    const box = pop.getBoundingClientRect();
    const gap = 6;
    const left = Math.max(gap, Math.min(at.right - box.width, room.width - box.width - gap));
    const below = at.bottom + gap;
    const top = below + box.height <= room.height - gap ? below : Math.max(gap, at.top - gap - box.height);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
}

/** The "i" that shows the drawing of `topic` with its caption when pressed, until pressed again or anything else is. */
export function infoTip(topic: InfoTopic): HTMLSpanElement {
    // The mark is drawn, not a box with a letter in it: a circle with an i.
    const mark = svg("svg", { class: "info-tip-mark", viewBox: "0 0 20 20", "aria-hidden": "true" },
        svg("circle", { cx: 10, cy: 10, r: 8.5 }),
        svg("text", { x: 10, y: 14.5, "text-anchor": "middle" }, "i"),
    );
    const pop = el("span", { class: "info-tip-pop", role: "tooltip" }, drawing(topic), el("span", { class: "info-tip-caption" }, CAPTIONS[topic]));
    const tip = el("span", { class: "info-tip", tabindex: "0", role: "button", "aria-expanded": "false", "aria-label": `What this means: ${topic}`, title: "what this means: press for a drawing" },
        mark,
        pop,
    ) as HTMLSpanElement;
    let release: (() => void) | null = null;
    const close = (): void => {
        release?.();
        release = null;
        tip.removeAttribute("data-open");
        tip.setAttribute("aria-expanded", "false");
        document.removeEventListener("pointerdown", outside, true);
        document.removeEventListener("keydown", escape, true);
        globalThis.removeEventListener?.("scroll", close, true);
        if (openTip?.tip === tip) {
            openTip = null;
        }
    };
    const outside = (event: Event): void => {
        if (!tip.contains(event.target as Node | null)) {
            close();
        }
    };
    const escape = (event: KeyboardEvent): void => {
        if (event.key === "Escape") {
            event.stopPropagation();
            close();
        }
    };
    const open = (): void => {
        openTip?.close();
        tip.setAttribute("data-open", "");
        tip.setAttribute("aria-expanded", "true");
        placePop(pop, mark);
        openTip = { tip, close };
        release = popUp({ nodes: () => [tip], close });
        document.addEventListener("pointerdown", outside, true);
        document.addEventListener("keydown", escape, true);
        // A scroll moves the mark away from the pop, which is fixed.
        globalThis.addEventListener?.("scroll", close, true);
    };
    const toggle = (event: Event): void => {
        // In a disclosure's summary a press would also fold the panel.
        event.preventDefault();
        event.stopPropagation();
        if (tip.hasAttribute("data-open")) {
            close();
        } else {
            open();
        }
    };
    mark.addEventListener("click", toggle);
    tip.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
            toggle(event);
        }
    });
    return tip;
}
