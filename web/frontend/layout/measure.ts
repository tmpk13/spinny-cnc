// What the eye meets in the first view of the page, as numbers: the shots
// task runs this in the page for a shot that asks for it (`"measure":
// true`) and prints the result. It counts what is in the window before any
// scroll, not what the page holds in all: the controls and words in view,
// how many of the controls are locked, the type sizes and text colors in
// use, the boxes drawn (anything with an edge of its own) and how deep they
// nest, the filled colors that call for attention, the share of the window
// given to the work (the preview, a camera's picture, the board), and how
// far the longest column scrolls on, in heights of itself.
//
// The function is sent to the browser as its own text, so it uses nothing
// outside itself.

export interface Measure {
    controls: number;
    controlsOnPage: number;
    locked: number;
    words: number;
    wordsOnPage: number;
    panels: number;
    sizes: number;
    inks: number;
    boxes: number;
    depth: number;
    /** Filled colors in view by hue: "red 2, blue 5". */
    loud: string;
    /** The work's share of the window, percent. */
    work: number;
    /** The longest scrolling box, in heights of itself; 1 when nothing scrolls. */
    scroll: number;
}

export function measure(): Measure {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const shown = (node: Element): boolean => {
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const within = (box: DOMRect): boolean => box.bottom > 0 && box.top < vh && box.right > 0 && box.left < vw;
    /** In the window and not under something else: what a point in its middle hits is it, or within it. */
    const met = (node: Element): boolean => {
        const box = node.getBoundingClientRect();
        if (!within(box)) {
            return false;
        }
        const x = Math.min(vw - 1, Math.max(0, box.left + box.width / 2));
        const y = Math.min(vh - 1, Math.max(0, box.top + box.height / 2));
        const at = document.elementFromPoint(x, y);
        return at !== null && (at === node || node.contains(at) || (at.contains(node) && at.closest("label") !== null));
    };
    const all = Array.from(document.querySelectorAll("button, input:not([type=hidden]), select, textarea, a[href], summary")).filter(shown);
    const inView = all.filter(met);
    const locked = inView.filter((node) => (node as HTMLButtonElement).disabled || node.getAttribute("aria-disabled") === "true");

    // Words, by text node, with the size and color each is set in.
    const sizes = new Set<string>();
    const inks = new Set<string>();
    let words = 0;
    let wordsOnPage = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = (node.textContent ?? "").trim();
        const parent = node.parentElement;
        if (!text || !parent || !shown(parent) || parent.closest("script, style")) {
            continue;
        }
        range.selectNodeContents(node);
        const box = range.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) {
            continue;
        }
        const count = text.split(/\s+/).filter(Boolean).length;
        wordsOnPage += count;
        if (!within(box)) {
            continue;
        }
        const at = document.elementFromPoint(Math.min(vw - 1, Math.max(0, box.left + Math.min(box.width / 2, 4))), Math.min(vh - 1, Math.max(0, box.top + box.height / 2)));
        if (!at || !(at === parent || parent.contains(at) || at.contains(parent))) {
            continue;
        }
        words += count;
        const style = getComputedStyle(parent);
        sizes.add(String(Math.round(parseFloat(style.fontSize) * 2) / 2));
        inks.add(style.color);
    }

    // Any CSS color as numbers, through a canvas, so color-mix() counts too.
    const pad = document.createElement("canvas");
    pad.width = pad.height = 1;
    const pen = pad.getContext("2d", { willReadFrequently: true })!;
    const parsed = new Map<string, [number, number, number, number]>();
    const parse = (color: string): [number, number, number, number] => {
        const known = parsed.get(color);
        if (known) {
            return known;
        }
        pen.clearRect(0, 0, 1, 1);
        pen.fillStyle = "rgba(0,0,0,0)";
        pen.fillStyle = color;
        pen.fillRect(0, 0, 1, 1);
        const data = pen.getImageData(0, 0, 1, 1).data;
        const out: [number, number, number, number] = [data[0]!, data[1]!, data[2]!, data[3]! / 255];
        parsed.set(color, out);
        return out;
    };
    const boxed = new Set<Element>();
    const loud = new Map<string, number>();
    for (const node of Array.from(document.querySelectorAll("#app *"))) {
        if (!shown(node)) {
            continue;
        }
        const box = node.getBoundingClientRect();
        if (!within(box) || box.width < 12 || box.height < 12) {
            continue;
        }
        const style = getComputedStyle(node);
        const edge = parseFloat(style.borderTopWidth) + parseFloat(style.borderLeftWidth) + parseFloat(style.borderBottomWidth) + parseFloat(style.borderRightWidth);
        if (edge > 0 && style.borderStyle !== "none" && parse(style.borderTopColor)[3] > 0.05) {
            boxed.add(node);
        }
        const [r, g, b, a] = parse(style.backgroundColor);
        const high = Math.max(r, g, b);
        const saturation = high === 0 ? 0 : (high - Math.min(r, g, b)) / high;
        // Bright enough to call the eye: a dark theme's own surfaces are not.
        if (a > 0.5 && saturation > 0.45 && high > 120 && box.width * box.height > 300) {
            const hue = r > b + 40 && r > g + 40 ? "red" : b > r + 40 ? "blue" : g > b + 30 ? (r > 150 ? "yellow" : "green") : "other";
            loud.set(hue, (loud.get(hue) ?? 0) + 1);
        }
    }
    let depth = 0;
    for (const node of boxed) {
        let levels = 0;
        for (let at: Element | null = node; at; at = at.parentElement) {
            if (boxed.has(at)) {
                levels += 1;
            }
        }
        depth = Math.max(depth, levels);
    }

    // The work: canvases, pictures and large drawings, as a share of the
    // window. Counted over a grid of points, so two canvases laid one over
    // the other (a preview's scene and its overlay) count once.
    const works: DOMRect[] = [];
    for (const node of Array.from(document.querySelectorAll("canvas, video, img:not(.job-thumb), svg"))) {
        if (!shown(node)) {
            continue;
        }
        const box = node.getBoundingClientRect();
        const width = Math.max(0, Math.min(vw, box.right) - Math.max(0, box.left));
        const height = Math.max(0, Math.min(vh, box.bottom) - Math.max(0, box.top));
        if (width > 200 && height > 150) {
            works.push(box);
        }
    }
    const grid = 8;
    let covered = 0;
    let points = 0;
    for (let y = grid / 2; y < vh; y += grid) {
        for (let x = grid / 2; x < vw; x += grid) {
            points += 1;
            if (works.some((box) => x >= box.left && x < box.right && y >= box.top && y < box.bottom)) {
                covered += 1;
            }
        }
    }
    const work = points === 0 ? 0 : covered / points;
    let scroll = 1;
    for (const node of Array.from(document.querySelectorAll<HTMLElement>("#app *"))) {
        if (node.clientHeight > 200 && node.scrollHeight > node.clientHeight + 24 && /(auto|scroll)/.test(getComputedStyle(node).overflowY) && !node.matches("textarea, pre, .console-log, .code-input")) {
            scroll = Math.max(scroll, node.scrollHeight / node.clientHeight);
        }
    }
    return {
        controls: inView.length,
        controlsOnPage: all.length,
        locked: locked.length,
        words,
        wordsOnPage,
        panels: Array.from(document.querySelectorAll(".panel")).filter((panel) => shown(panel) && within(panel.getBoundingClientRect())).length,
        sizes: sizes.size,
        inks: inks.size,
        boxes: boxed.size,
        depth,
        loud: Array.from(loud.entries()).sort((a, b) => b[1] - a[1]).map(([hue, count]) => `${hue} ${count}`).join(", "),
        work: Math.round(100 * work),
        scroll: Math.round(scroll * 10) / 10,
    };
}
