// A picture of the page as the operator sees it, for a bug report, made in
// the browser from the page itself, with nothing sent anywhere: the page is
// copied, and each copy is given what the page holds outside its markup
// (what is typed in a field, a box ticked, an option picked, how far a box
// is scrolled, the picture on a canvas); the copy is drawn as an SVG image
// with the page's own stylesheet in it, and that image drawn on a canvas
// and read back as a PNG. A canvas the page cannot read (the preview hands
// its canvases to a worker that draws them) is asked of whoever draws it
// (`registerPicture`); one nobody answers for is left a plain box saying
// so. Pages not shown and anything hidden are left out of the copy, which
// changes nothing drawn and keeps it small.

/** A picture as RGBA bytes, top row first. */
export interface Picture {
    width: number;
    height: number;
    pixels: Uint8ClampedArray;
}

/**
 * Whoever draws a canvas the page cannot read: the canvases its picture
 * covers, the first taking the picture's place and the others (drawn over
 * it, already in the picture) left out; and the picture, read now.
 */
export interface PictureSource {
    canvases(): HTMLCanvasElement[];
    read(): Promise<Picture | null>;
}

const sources = new Set<PictureSource>();

/** Says who can give a canvas's picture; the function returned takes that back. */
export function registerPicture(source: PictureSource): () => void {
    sources.add(source);
    return () => {
        sources.delete(source);
    };
}

/** How long a canvas's painter gets to give its picture, ms. */
export const PICTURE_WAIT_MS = 3000;
/** The most pixels a screenshot has; a larger screen is drawn at a smaller scale. */
export const MAX_PIXELS = 4_000_000;

const XHTML = "http://www.w3.org/1999/xhtml";

/** What the copy leaves out: anything marked so, scripts, and what is hidden anyway. */
function leftOut(node: Element, page: string | null): boolean {
    if (node.hasAttribute("data-no-shot") || node.tagName === "SCRIPT" || node.tagName === "TEMPLATE") {
        return true;
    }
    if (node.hasAttribute("hidden") || node.classList.contains("hidden")) {
        return true;
    }
    return page !== null && node.tagName === "MAIN" && node.classList.contains("page") && node.id !== `page-${page}`;
}

/** What is left to do on the copy once it is made: canvases and pictures to fill in. */
export interface PageCopy {
    /** The copy of the body. */
    body: HTMLElement;
    canvases: { from: HTMLCanvasElement; to: Element }[];
    images: { from: HTMLImageElement; to: HTMLImageElement }[];
}

/**
 * A copy of the page's body as it is shown now: fields with what is typed
 * in them, boxes ticked, options picked, scrolled boxes with their content
 * moved by the scroll; what is hidden left out. Canvases and pictures are
 * listed to be filled in, which takes time (see `pageShot`); the copy
 * itself is made at once, so what the page does next is not in it.
 */
export function copyPage(doc: Document = document): PageCopy {
    const page = doc.getElementById("app")?.getAttribute("data-page") ?? null;
    const body = doc.body.cloneNode(true) as HTMLElement;
    const copy: PageCopy = { body, canvases: [], images: [] };
    const gone: Element[] = [];
    const walk = (from: Element, to: Element): void => {
        if (leftOut(from, page)) {
            gone.push(to);
            return;
        }
        if (from instanceof HTMLInputElement && to instanceof HTMLInputElement) {
            if (from.type === "checkbox" || from.type === "radio") {
                to.toggleAttribute("checked", from.checked);
            } else if (from.type === "password") {
                to.setAttribute("value", "");
            } else if (from.type !== "file") {
                to.setAttribute("value", from.value);
            }
        } else if (from instanceof HTMLTextAreaElement) {
            to.textContent = from.value;
        } else if (from instanceof HTMLSelectElement) {
            Array.from(from.options).forEach((option, index) => {
                to.querySelectorAll("option")[index]?.toggleAttribute("selected", option.selected);
            });
        } else if (from instanceof HTMLCanvasElement) {
            copy.canvases.push({ from, to });
        } else if (from instanceof HTMLImageElement && to instanceof HTMLImageElement) {
            copy.images.push({ from, to });
        }
        if (from.scrollTop !== 0 || from.scrollLeft !== 0) {
            // The copy is never scrolled: its content is moved instead, all
            // but what sticks to an edge, which stays where a scroll left it.
            Array.from(to.children).forEach((child, index) => {
                const original = from.children[index];
                if ((child instanceof HTMLElement || child instanceof SVGElement) && !(original && getComputedStyle(original).position === "sticky")) {
                    child.style.translate = `${-from.scrollLeft}px ${-from.scrollTop}px`;
                }
            });
        }
        const a = from.children;
        const b = to.children;
        for (let index = 0; index < a.length && index < b.length; index++) {
            walk(a[index]!, b[index]!);
        }
    };
    walk(doc.body, body);
    for (const node of gone) {
        node.remove();
    }
    copy.canvases = copy.canvases.filter(({ to }) => body.contains(to));
    copy.images = copy.images.filter(({ to }) => body.contains(to));
    return copy;
}

/** The page's look as text: every rule of its stylesheets it may read. */
export function pageCss(doc: Document = document): string {
    const parts: string[] = [];
    for (const sheet of Array.from(doc.styleSheets)) {
        try {
            for (const rule of Array.from(sheet.cssRules)) {
                parts.push(rule.cssText);
            }
        } catch {
            // A sheet from another origin: its rules cannot be read.
        }
    }
    return parts.join("\n");
}

/**
 * The root's custom properties the stylesheet sets, as the root has them
 * now, with its color scheme and font size: in the image the root is the
 * SVG, so the copy takes the page's colors whichever scheme it is drawn in.
 */
export function rootStyle(css: string, root: Element): string {
    const style = getComputedStyle(root);
    const names = new Set(css.match(/--[A-Za-z0-9_-]+(?=\s*:)/g) ?? []);
    const parts = [...names]
        .map((name) => [name, style.getPropertyValue(name).trim()] as const)
        .filter(([, value]) => value !== "")
        .map(([name, value]) => `${name}: ${value};`);
    for (const name of ["color-scheme", "font-size"]) {
        const value = style.getPropertyValue(name).trim();
        if (value !== "") {
            parts.push(`${name}: ${value};`);
        }
    }
    return parts.join(" ");
}

/** Where the stylesheet goes in the written copy. */
const CSS_MARK = "spinny-page-css-here";

function escapeText(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * The SVG of a page copy `width` by `height`, scrolled by `scroll`: the
 * copy in an XHTML document of its own inside a foreign object, the page's
 * stylesheet in its head.
 */
export function svgOf(copy: HTMLElement, css: string, style: string, width: number, height: number, scroll: { x: number; y: number } = { x: 0, y: 0 }): string {
    const doc = copy.ownerDocument;
    const html = doc.createElementNS(XHTML, "html");
    for (const attribute of Array.from(doc.documentElement.attributes)) {
        if (attribute.name !== "xmlns") {
            html.setAttribute(attribute.name, attribute.value);
        }
    }
    html.setAttribute("style", `width: ${width}px; height: ${height}px; overflow: hidden;`);
    const head = doc.createElementNS(XHTML, "head");
    const sheet = doc.createElementNS(XHTML, "style");
    // Put in after the copy is written, escaped for XML: serializers
    // differ in whether they escape a style's text.
    sheet.textContent = CSS_MARK;
    head.append(sheet);
    // The page scrolled: the body moves up by as much, while what is fixed
    // to the screen stays put.
    if (scroll.x !== 0 || scroll.y !== 0) {
        copy.style.position = "relative";
        copy.style.left = `${-scroll.x}px`;
        copy.style.top = `${-scroll.y}px`;
    }
    html.append(head, copy);
    const text = new XMLSerializer().serializeToString(html).replace(CSS_MARK, () => escapeText(css));
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" style="${escapeAttribute(style)}">`
        + `<foreignObject x="0" y="0" width="100%" height="100%">${text}</foreignObject></svg>`;
}

/** A picture as a PNG data address. */
function pictureUrl(picture: Picture): string | null {
    if (picture.width <= 0 || picture.height <= 0) {
        return null;
    }
    const canvas = document.createElement("canvas");
    canvas.width = picture.width;
    canvas.height = picture.height;
    const context = canvas.getContext("2d");
    if (!context) {
        return null;
    }
    context.putImageData(new ImageData(new Uint8ClampedArray(picture.pixels), picture.width, picture.height), 0, 0);
    return canvas.toDataURL("image/png");
}

function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
    return Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

/** A box the size of `from` in its place, an image when there is a picture, else words saying there is none. */
function stand(from: Element, to: Element, url: string | null, words: string): void {
    const rect = from.getBoundingClientRect();
    const doc = to.ownerDocument;
    const box = doc.createElementNS(XHTML, url ? "img" : "div") as HTMLElement;
    for (const name of ["class", "style", "id"]) {
        const value = to.getAttribute(name);
        if (value !== null) {
            box.setAttribute(name, value);
        }
    }
    const computed = getComputedStyle(from);
    box.style.display = computed.display === "inline" ? "inline-block" : computed.display;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
    box.style.boxSizing = "border-box";
    if (url) {
        box.setAttribute("src", url);
        box.setAttribute("alt", "");
    } else {
        box.textContent = words;
        box.style.border = "thin dashed currentColor";
        box.style.color = "var(--muted)";
        box.style.fontSize = "0.8rem";
        box.style.padding = "0.5rem";
        box.style.overflow = "hidden";
    }
    to.replaceWith(box);
}

/** Fills in the copy's canvases: a painter's picture, or the canvas read, or a box saying it is not in the screenshot. */
async function fillCanvases(copy: PageCopy): Promise<void> {
    const owners = new Map<HTMLCanvasElement, PictureSource>();
    const covered = new Set<HTMLCanvasElement>();
    for (const source of sources) {
        const [first, ...over] = source.canvases();
        if (first) {
            owners.set(first, source);
        }
        for (const canvas of over) {
            covered.add(canvas);
        }
    }
    await Promise.all(copy.canvases.map(async ({ from, to }) => {
        if (covered.has(from)) {
            to.remove();
            return;
        }
        let url: string | null = null;
        const owner = owners.get(from);
        if (owner) {
            const picture = await within(owner.read().catch(() => null), PICTURE_WAIT_MS);
            url = picture ? pictureUrl(picture) : null;
        } else {
            try {
                const data = from.toDataURL("image/png");
                url = data === "data:," ? null : data;
            } catch {
                url = null;
            }
        }
        stand(from, to, url, "(not in the screenshot)");
    }));
}

/** Fills in the copy's pictures as data, which an SVG image needs: it loads nothing from elsewhere. */
function fillImages(copy: PageCopy): void {
    for (const { from, to } of copy.images) {
        const src = from.currentSrc || from.src;
        to.removeAttribute("srcset");
        to.removeAttribute("loading");
        if (src.startsWith("data:")) {
            to.setAttribute("src", src);
            continue;
        }
        let url: string | null = null;
        if (from.complete && from.naturalWidth > 0) {
            try {
                const canvas = document.createElement("canvas");
                canvas.width = from.naturalWidth;
                canvas.height = from.naturalHeight;
                canvas.getContext("2d")?.drawImage(from, 0, 0);
                url = canvas.toDataURL("image/png");
            } catch {
                url = null;
            }
        }
        if (url) {
            to.setAttribute("src", url);
        } else {
            stand(from, to, null, "");
        }
    }
}

function loadImage(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("the browser could not draw the copy of the page"));
        image.src = url;
    });
}

/** The scale a screenshot is drawn at: the screen's, at most 2, and at most MAX_PIXELS in all. */
export function shotScale(width: number, height: number, ratio: number): number {
    const area = Math.max(1, width * height);
    return Math.max(0.25, Math.min(ratio || 1, 2, Math.sqrt(MAX_PIXELS / area)));
}

/** A screenshot of the page as shown now, as a PNG. Throws when this browser cannot make one. */
export async function pageShot(doc: Document = document): Promise<{ png: Blob; width: number; height: number }> {
    const view = doc.defaultView ?? window;
    const width = Math.max(1, Math.round(view.innerWidth));
    const height = Math.max(1, Math.round(view.innerHeight));
    const scroll = { x: view.scrollX, y: view.scrollY };
    // The copy first, at once: what follows waits on painters and pictures.
    const copy = copyPage(doc);
    const css = pageCss(doc);
    const style = rootStyle(css, doc.documentElement);
    await fillCanvases(copy);
    fillImages(copy);
    const svg = svgOf(copy.body, css, style, width, height, scroll);
    const image = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
    const scale = shotScale(width, height, view.devicePixelRatio);
    const canvas = doc.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const context = canvas.getContext("2d");
    if (!context) {
        throw new Error("this browser gives no canvas to draw on");
    }
    context.fillStyle = getComputedStyle(doc.body).backgroundColor || "#fdf6e3";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!png) {
        throw new Error("the browser could not write the picture");
    }
    return { png, width: canvas.width, height: canvas.height };
}
