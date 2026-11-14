// A text editor for the TOML files the page keeps (the CAM profiles, the
// machine files): a text field with a colored copy of its text drawn
// under it, and the text read as TOML on every edit so a line that does
// not read is named at once, before any save. The field's own text is
// transparent; only its caret and selection show over the colored layer,
// which scrolls with it.
//
// A field hidden with its page (the tabs hide a page by display: none)
// loses its scroll and its focus, and not every browser gives them back
// the same way the layer under it gets its own back, so the two came back
// out of step. The editor keeps what the field showed last and puts it
// back the moment its size returns.
//
// A find marks every place the text holds a word on a third layer, under
// the colored one, and steps from one to the next without taking the
// focus from the field the word is typed in: a browser draws no selection
// in a field without the focus, so the marks are what shows where it is.

import { errorText } from "../api.ts";
import { el, tabIndents } from "../dom.ts";
import { escapeHtml, highlightToml } from "../highlight.ts";
import { TomlError, parseToml } from "../toml.ts";

export interface CodeEditor {
    root: HTMLDivElement;
    textarea: HTMLTextAreaElement;
    /**
     * Puts a text in as read from its file; not an edit, so no listener
     * runs. The field stays scrolled where it was and the caret stays put,
     * held within the new text; the same text again changes nothing.
     */
    setText(text: string): void;
    getText(): string;
    /** What keeps the text from reading as TOML, "line N: ...", or null. */
    syntaxProblem(): string | null;
    /** Runs after every edit with the syntax problem of the moment. */
    onInput(listener: (problem: string | null) => void): void;
    /** Selects a line, counted from 0, and scrolls it into the middle of the field. */
    revealLine(line: number): void;
    /** Selects `start` to `end` of the text and scrolls it into view; the focus moves to the field only when `focus` says so. */
    selectRange(start: number, end: number, focus?: boolean): void;
    /** Marks every place the text holds `query`, any case, and says how many; an empty query takes the marks away. */
    find(query: string): number;
    /**
     * Goes to the next place marked after the selection (`step` -1: the one
     * before), round the end: selected, scrolled into view and marked as
     * the current one, the focus left where it is. Its number from 1 and
     * the count, or null with nothing marked.
     */
    findStep(step: 1 | -1): { index: number; count: number } | null;
    /** The line and column (from 0) of the text under a point on the screen, or null off the text. */
    positionAt(x: number, y: number): { line: number; column: number } | null;
    /**
     * Tells the editor its page was hidden (false) or is back (true). Back,
     * the field is scrolled to where it was, the layer put in step, and the
     * focus and selection given back when it had them. The editor sees
     * this itself from its size, so no page calls it; it is a hook for the
     * tests, which hide and show an editor without a size changing.
     */
    setShown(shown: boolean): void;
    /**
     * Lets go of the page-wide listeners, for an editor taken off the page.
     * The page keeps its editors, so no page calls it; it is a hook for the
     * tests, which make an editor and leave it.
     */
    dispose(): void;
}

/** The syntax problem of a text, with its line, or null for a text that reads. */
export function tomlProblem(text: string): { line: number; message: string } | null {
    try {
        parseToml(text);
        return null;
    } catch (error) {
        if (error instanceof TomlError) {
            return { line: error.line, message: error.message };
        }
        return { line: 0, message: errorText(error) };
    }
}

/** Where `query` starts in `text`, any case, one place after another without overlapping; none for an empty query. */
export function findMatches(text: string, query: string): number[] {
    if (query === "") {
        return [];
    }
    const hay = text.toLowerCase();
    const wanted = query.toLowerCase();
    const found: number[] = [];
    for (let at = hay.indexOf(wanted); at >= 0; at = hay.indexOf(wanted, at + wanted.length)) {
        found.push(at);
    }
    return found;
}

/** The width of one character in a monospaced font, measured once per font. */
const charWidths = new Map<string, number>();

function charWidth(style: CSSStyleDeclaration): number {
    const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    let width = charWidths.get(font);
    if (width === undefined) {
        const context = typeof document.createElement("canvas").getContext === "function" ? document.createElement("canvas").getContext("2d") : null;
        if (context) {
            context.font = font;
            width = context.measureText("0".repeat(10)).width / 10;
        }
        // No canvas to measure with: a monospaced face is about 0.6 of its size.
        if (!width) {
            width = (parseFloat(style.fontSize) || 16) * 0.6;
        }
        charWidths.set(font, width);
    }
    return width;
}

/** What the field showed last while it was on screen. */
interface View {
    start: number;
    end: number;
    top: number;
    left: number;
    focused: boolean;
}

export function codeEditor(label: string): CodeEditor {
    const code = el("code", { class: "code-text" });
    const layer = el("pre", { class: "code-layer", "aria-hidden": "true" }, code);
    // The places a find marks, drawn under the colored text.
    const marked = el("code", { class: "code-text" });
    const marks = el("pre", { class: "code-layer code-marks", "aria-hidden": "true" }, marked);
    const textarea = el("textarea", {
        class: "code-input",
        spellcheck: "false",
        autocapitalize: "off",
        autocomplete: "off",
        wrap: "off",
        "aria-label": label,
    });
    const root = el("div", { class: "code-editor" }, marks, layer, textarea);
    const listeners: ((problem: string | null) => void)[] = [];
    let problem: { line: number; message: string } | null = null;
    // What a find looks for, where the text holds it, and which of those is current (-1: none yet).
    let finding = "";
    let found: number[] = [];
    let current = -1;
    let rendered = false;
    const view: View = { start: 0, end: 0, top: 0, left: 0, focused: false };
    // Whether the editor has a size, as last observed; a hidden field
    // reports a scroll of zero and no focus, which is not what it showed.
    let shown = true;
    let gutter = { x: 0, y: 0 };

    function render(): void {
        problem = tomlProblem(textarea.value);
        code.innerHTML = highlightToml(textarea.value, problem?.line ?? null);
        rendered = true;
        if (finding !== "") {
            found = findMatches(textarea.value, finding);
            current = Math.min(current, found.length - 1);
        }
        renderMarks();
        fitGutter();
        sync();
    }

    /** The marks layer: the text unseen, every place found on a ground of its own, the current one stronger. */
    function renderMarks(): void {
        if (finding === "" || found.length === 0) {
            marked.innerHTML = "";
            return;
        }
        const text = textarea.value;
        let html = "";
        let at = 0;
        found.forEach((start, index) => {
            html += escapeHtml(text.slice(at, start));
            html += `<mark class="code-found${index === current ? " current" : ""}">${escapeHtml(text.slice(start, start + finding.length))}</mark>`;
            at = start + finding.length;
        });
        // As the colored layer, a space past the last line keeps a trailing newline's line.
        marked.innerHTML = `${html}${escapeHtml(text.slice(at))} `;
    }

    function sync(): void {
        layer.scrollTop = textarea.scrollTop;
        layer.scrollLeft = textarea.scrollLeft;
        marks.scrollTop = textarea.scrollTop;
        marks.scrollLeft = textarea.scrollLeft;
    }

    /** The field's own line height; a "normal" one is taken as 1.2 of its font. */
    function lineHeight(style: CSSStyleDeclaration): number {
        return parseFloat(style.lineHeight) || (parseFloat(style.fontSize) || 16) * 1.2;
    }

    function selectRange(start: number, end: number, focus = false): void {
        const text = textarea.value;
        const from = Math.max(0, Math.min(start, text.length));
        const to = Math.max(from, Math.min(end, text.length));
        if (focus) {
            textarea.focus({ preventScroll: true });
        }
        textarea.setSelectionRange(from, to);
        const style = getComputedStyle(textarea);
        const line = text.slice(0, from).split("\n").length - 1;
        const column = from - (text.lastIndexOf("\n", from - 1) + 1);
        textarea.scrollTop = Math.max(0, line * lineHeight(style) - textarea.clientHeight / 2);
        const x = column * charWidth(style);
        if (x < textarea.scrollLeft || x > textarea.scrollLeft + textarea.clientWidth * 0.8) {
            textarea.scrollLeft = Math.max(0, x - textarea.clientWidth / 2);
        }
        remember();
        sync();
    }

    /**
     * The field's scrollbars take a strip from its scroll range that the
     * layer, which has none, keeps, so near the end of a long file the
     * layer could not follow by a scrollbar's height. The layer is kept
     * clear of the same strip, measured from the field since it is the
     * browser's to size, and both then scroll the same distance.
     */
    function fitGutter(): void {
        const x = Math.max(0, textarea.offsetWidth - textarea.clientWidth);
        const y = Math.max(0, textarea.offsetHeight - textarea.clientHeight);
        if (x !== gutter.x || y !== gutter.y) {
            gutter = { x, y };
            for (const each of [layer, marks]) {
                each.style.right = x > 0 ? `${x}px` : "";
                each.style.bottom = y > 0 ? `${y}px` : "";
            }
        }
    }

    function remember(): void {
        if (!shown) {
            return;
        }
        view.start = textarea.selectionStart;
        view.end = textarea.selectionEnd;
        view.top = textarea.scrollTop;
        view.left = textarea.scrollLeft;
        view.focused = document.activeElement === textarea;
    }

    function restoreView(): void {
        const { start, end, top, left, focused } = view;
        textarea.scrollTop = top;
        textarea.scrollLeft = left;
        if (focused) {
            textarea.focus({ preventScroll: true });
            textarea.setSelectionRange(start, end);
            // Taking the focus scrolls the caret into view, which may not
            // be where the field was; the scroll it showed is the one kept.
            textarea.scrollTop = top;
            textarea.scrollLeft = left;
        }
        fitGutter();
        sync();
        remember();
    }

    function setShown(next: boolean): void {
        if (next === shown) {
            return;
        }
        shown = next;
        if (next) {
            restoreView();
        }
    }

    textarea.addEventListener("input", () => {
        render();
        remember();
        for (const listener of listeners) {
            listener(problem?.message ?? null);
        }
    });
    textarea.addEventListener("scroll", () => {
        sync();
        remember();
    });
    for (const type of ["keyup", "mouseup", "selectionchange", "focus"]) {
        textarea.addEventListener(type, remember);
    }
    textarea.addEventListener("blur", () => {
        // The blur of a field hidden with its page is not the operator
        // leaving it: shown again, it gets the focus back.
        if (root.getClientRects().length === 0) {
            return;
        }
        remember();
    });
    tabIndents(textarea);

    // Not every browser fires selectionchange on the field itself.
    const documentSelection = (): void => {
        if (document.activeElement === textarea) {
            remember();
        }
    };
    document.addEventListener("selectionchange", documentSelection);
    const windowResize = (): void => {
        fitGutter();
        sync();
    };
    window.addEventListener("resize", windowResize);
    // A page hidden by display: none gives its elements no size; the size
    // coming back is the editor being shown again.
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver === "function") {
        observer = new ResizeObserver((entries) => {
            const rect = entries[entries.length - 1]?.contentRect;
            const sized = rect ? rect.width > 0 || rect.height > 0 : root.getClientRects().length > 0;
            if (sized && shown) {
                // Resized while on screen: a scrollbar may have come or gone.
                fitGutter();
                sync();
            }
            setShown(sized);
        });
        observer.observe(root);
    }

    return {
        root,
        textarea,
        setText(text) {
            if (rendered && text === textarea.value) {
                return;
            }
            const { selectionStart: start, selectionEnd: end, scrollTop: top, scrollLeft: left } = textarea;
            textarea.value = text;
            // Putting a value in moves the caret to its end; the place being
            // read is kept, held within the new text, and the scroll with it.
            textarea.setSelectionRange(Math.min(start, text.length), Math.min(end, text.length));
            textarea.scrollTop = top;
            textarea.scrollLeft = left;
            render();
            remember();
        },
        getText() {
            return textarea.value;
        },
        syntaxProblem() {
            return problem?.message ?? null;
        },
        onInput(listener) {
            listeners.push(listener);
        },
        revealLine(line) {
            const lines = textarea.value.split("\n");
            const index = Math.max(0, Math.min(line, lines.length - 1));
            const start = lines.slice(0, index).reduce((sum, text) => sum + text.length + 1, 0);
            textarea.focus({ preventScroll: true });
            textarea.setSelectionRange(start, start + (lines[index]?.length ?? 0));
            // The field's own line height, so the line lands mid field.
            textarea.scrollTop = Math.max(0, index * lineHeight(getComputedStyle(textarea)) - textarea.clientHeight / 2);
            remember();
            sync();
        },
        selectRange,
        find(query) {
            if (query !== finding) {
                current = -1;
            }
            finding = query;
            found = findMatches(textarea.value, query);
            renderMarks();
            return found.length;
        },
        findStep(step) {
            if (found.length === 0) {
                return null;
            }
            if (current < 0) {
                // The first step goes from the selection: forward to the
                // first place past its end, back to the last before its start.
                if (step > 0) {
                    const next = found.findIndex((start) => start >= textarea.selectionEnd);
                    current = next < 0 ? 0 : next;
                } else {
                    const before = found.filter((start) => start < textarea.selectionStart).length - 1;
                    current = before < 0 ? found.length - 1 : before;
                }
            } else {
                current = (current + step + found.length) % found.length;
            }
            const start = found[current]!;
            selectRange(start, start + finding.length);
            renderMarks();
            return { index: current + 1, count: found.length };
        },
        positionAt(x, y) {
            const style = getComputedStyle(textarea);
            const box = textarea.getBoundingClientRect();
            const height = lineHeight(style);
            const top = box.top + (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.paddingTop) || 0);
            const left = box.left + (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.paddingLeft) || 0);
            if (x < left || y < top || x > box.right || y > box.bottom) {
                return null;
            }
            return {
                line: Math.floor((y - top + textarea.scrollTop) / height),
                column: Math.floor((x - left + textarea.scrollLeft) / charWidth(style)),
            };
        },
        setShown,
        dispose() {
            observer?.disconnect();
            observer = null;
            document.removeEventListener("selectionchange", documentSelection);
            window.removeEventListener("resize", windowResize);
        },
    };
}
