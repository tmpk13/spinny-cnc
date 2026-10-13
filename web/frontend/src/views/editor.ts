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

import { el } from "../dom.ts";
import { highlightToml } from "../highlight.ts";
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
    /**
     * Tells the editor its page was hidden (false) or is back (true). Back,
     * the field is scrolled to where it was, the layer put in step, and the
     * focus and selection given back when it had them. The editor sees
     * this itself from its size; the method is for a page that knows sooner.
     */
    setShown(shown: boolean): void;
    /** Lets go of the page-wide listeners, for an editor taken off the page. */
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
        return { line: 0, message: error instanceof Error ? error.message : String(error) };
    }
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
    const textarea = el("textarea", {
        class: "code-input",
        spellcheck: "false",
        autocapitalize: "off",
        autocomplete: "off",
        wrap: "off",
        "aria-label": label,
    });
    const root = el("div", { class: "code-editor" }, layer, textarea);
    const listeners: ((problem: string | null) => void)[] = [];
    let problem: { line: number; message: string } | null = null;
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
        fitGutter();
        sync();
    }

    function sync(): void {
        layer.scrollTop = textarea.scrollTop;
        layer.scrollLeft = textarea.scrollLeft;
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
            layer.style.right = x > 0 ? `${x}px` : "";
            layer.style.bottom = y > 0 ? `${y}px` : "";
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
    // Tab indents, as in the files, rather than leaving the field.
    textarea.addEventListener("keydown", (event) => {
        if (event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey) {
            event.preventDefault();
            const { selectionStart: start, selectionEnd: end, scrollTop: top, scrollLeft: left, value } = textarea;
            textarea.value = value.slice(0, start) + "    " + value.slice(end);
            textarea.setSelectionRange(start + 4, start + 4);
            // Putting a value in may scroll the field to its end and back
            // to the caret; the line being typed stays where it was.
            textarea.scrollTop = top;
            textarea.scrollLeft = left;
            textarea.dispatchEvent(new Event("input", { bubbles: true }));
        }
    });

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
        setShown,
        dispose() {
            observer?.disconnect();
            observer = null;
            document.removeEventListener("selectionchange", documentSelection);
            window.removeEventListener("resize", windowResize);
        },
    };
}
