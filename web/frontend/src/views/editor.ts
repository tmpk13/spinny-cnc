// A text editor for the TOML files the page keeps (the CAM profiles, the
// machine files): a text field with a colored copy of its text drawn
// under it, and the text read as TOML on every edit so a line that does
// not read is named at once, before any save. The field's own text is
// transparent; only its caret and selection show over the colored layer,
// which scrolls with it.

import { el } from "../dom.ts";
import { highlightToml } from "../highlight.ts";
import { TomlError, parseToml } from "../toml.ts";

export interface CodeEditor {
    root: HTMLDivElement;
    textarea: HTMLTextAreaElement;
    /** Puts a text in as read from its file; not an edit, so no listener runs. */
    setText(text: string): void;
    getText(): string;
    /** What keeps the text from reading as TOML, "line N: ...", or null. */
    syntaxProblem(): string | null;
    /** Runs after every edit with the syntax problem of the moment. */
    onInput(listener: (problem: string | null) => void): void;
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

    function render(): void {
        problem = tomlProblem(textarea.value);
        code.innerHTML = highlightToml(textarea.value, problem?.line ?? null);
        sync();
    }

    function sync(): void {
        layer.scrollTop = textarea.scrollTop;
        layer.scrollLeft = textarea.scrollLeft;
    }

    textarea.addEventListener("input", () => {
        render();
        for (const listener of listeners) {
            listener(problem?.message ?? null);
        }
    });
    textarea.addEventListener("scroll", sync);
    // Tab indents, as in the files, rather than leaving the field.
    textarea.addEventListener("keydown", (event) => {
        if (event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey) {
            event.preventDefault();
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            const value = textarea.value;
            textarea.value = value.slice(0, start) + "    " + value.slice(end);
            textarea.selectionStart = start + 4;
            textarea.selectionEnd = start + 4;
            textarea.dispatchEvent(new Event("input", { bubbles: true }));
        }
    });

    return {
        root,
        textarea,
        setText(text) {
            textarea.value = text;
            render();
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
    };
}
