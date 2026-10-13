import { describe, expect, test } from "bun:test";

import { highlightLine, highlightToml } from "../src/highlight.ts";
import { codeEditor, tomlProblem } from "../src/views/editor.ts";

describe("TOML coloring", () => {
    test("comments, headers, keys and values each get their span", () => {
        expect(highlightLine("# a note")).toBe('<span class="tk-comment"># a note</span>');
        expect(highlightLine("[rail]  # R")).toBe('<span class="tk-punct">[</span><span class="tk-table">rail</span><span class="tk-punct">]</span>  <span class="tk-comment"># R</span>');
        expect(highlightLine("[[controls.axes]]")).toContain('<span class="tk-table">controls.axes</span>');
        expect(highlightLine('name = "Polar laser"')).toBe('<span class="tk-key">name</span> <span class="tk-punct">=</span> <span class="tk-string">&quot;Polar laser&quot;</span>');
        expect(highlightLine("max_rate = 560 # mm/min")).toBe('<span class="tk-key">max_rate</span> <span class="tk-punct">=</span> <span class="tk-number">560</span> <span class="tk-comment"># mm/min</span>');
        expect(highlightLine("invert = false")).toContain('<span class="tk-bool">false</span>');
        expect(highlightLine("steps = [0.1, 1, 10]")).toContain('<span class="tk-number">0.1</span><span class="tk-punct">,</span> <span class="tk-number">1</span>');
        expect(highlightLine("center = { r = 0 }")).toContain('<span class="tk-key">r</span> <span class="tk-punct">=</span> <span class="tk-number">0</span>');
        expect(highlightLine('a = "x # y" # z')).toBe('<span class="tk-key">a</span> <span class="tk-punct">=</span> <span class="tk-string">&quot;x # y&quot;</span> <span class="tk-comment"># z</span>');
        expect(highlightLine("    ")).toBe("    ");
        expect(highlightLine("when = 2026-10-08T07:32:00Z")).toContain('<span class="tk-number">2026-10-08T07:32:00Z</span>');
        expect(highlightLine("odd = nope")).toBe('<span class="tk-key">odd</span> <span class="tk-punct">=</span> nope');
    });

    test("an array over several lines keeps its values colored, and the error line is marked", () => {
        const html = highlightToml('list = [\n    "G21",\n    1,\n]\nb = 2 <\n', 5);
        expect(html).toContain('<span class="tk-string">&quot;G21&quot;</span>');
        expect(html).toContain('    <span class="tk-number">1</span><span class="tk-punct">,</span>');
        expect(html).toContain('<span class="tk-error"><span class="tk-key">b</span>');
        expect(html).toContain("&lt;");
        expect(html.endsWith("\n ")).toBe(true);
        expect(highlightToml("")).toBe(" ");
    });
});

describe("the code editor", () => {
    test("names the line that does not read as it is typed, and a text put in is no edit", () => {
        const editor = codeEditor("Machine file");
        document.body.appendChild(editor.root);
        const seen: (string | null)[] = [];
        editor.onInput((problem) => seen.push(problem));
        editor.setText("a = 1\n");
        expect(seen).toEqual([]);
        expect(editor.syntaxProblem()).toBeNull();
        expect(editor.root.querySelector(".tk-key")?.textContent).toBe("a");
        editor.textarea.value = "a = 1\nb\n";
        editor.textarea.dispatchEvent(new Event("input"));
        expect(seen).toEqual(["line 2: expected key = value"]);
        expect(editor.syntaxProblem()).toBe("line 2: expected key = value");
        expect(editor.root.querySelector(".tk-error")?.textContent).toBe("b");
        editor.textarea.value = "a = 1\nb = 2\n";
        editor.textarea.dispatchEvent(new Event("input"));
        expect(seen[1]).toBeNull();
        expect(editor.root.querySelector(".tk-error")).toBeNull();
        expect(editor.getText()).toBe("a = 1\nb = 2\n");
        expect(tomlProblem("x = [1,")).toEqual({ line: 1, message: "line 1: an array is not closed" });
        expect(tomlProblem("[t]\nx = 1\n[t]\n")?.line).toBe(3);
        // Tab indents rather than leaving the field.
        editor.textarea.value = "a";
        editor.textarea.selectionStart = 1;
        editor.textarea.selectionEnd = 1;
        editor.textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", cancelable: true }));
        expect(editor.getText()).toBe("a    ");
        expect(seen.length).toBe(3);
        editor.root.remove();
        editor.dispose();
    });

    test("a text put in keeps the caret and the scroll, the caret held within the new text", () => {
        const editor = codeEditor("Machine file");
        document.body.appendChild(editor.root);
        const seen: (string | null)[] = [];
        editor.onInput((problem) => seen.push(problem));
        const text = "a = 1\nb = 2\nc = 3\n";
        editor.setText(text);
        editor.textarea.setSelectionRange(7, 10);
        editor.textarea.scrollTop = 30;
        editor.textarea.scrollLeft = 4;
        // The same text again is no change at all.
        editor.setText(text);
        expect(editor.textarea.selectionStart).toBe(7);
        expect(editor.textarea.selectionEnd).toBe(10);
        expect(editor.textarea.scrollTop).toBe(30);
        expect(editor.textarea.scrollLeft).toBe(4);
        // Another text keeps the scroll and the caret where they were.
        editor.setText("a = 1\nb = 22\nc = 3\n");
        expect(editor.textarea.selectionStart).toBe(7);
        expect(editor.textarea.selectionEnd).toBe(10);
        expect(editor.textarea.scrollTop).toBe(30);
        // A shorter text holds the caret within it rather than at its end.
        editor.setText("a = 1\n");
        expect(editor.textarea.selectionStart).toBe(6);
        expect(editor.textarea.selectionEnd).toBe(6);
        expect(editor.textarea.scrollTop).toBe(30);
        expect(seen).toEqual([]);
        // Tab keeps the line being typed where it was.
        editor.setText(text);
        editor.textarea.setSelectionRange(6, 6);
        editor.textarea.scrollTop = 25;
        editor.textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", cancelable: true }));
        expect(editor.getText()).toBe("a = 1\n    b = 2\nc = 3\n");
        expect(editor.textarea.selectionStart).toBe(10);
        expect(editor.textarea.scrollTop).toBe(25);
        expect(seen).toEqual([null]);
        editor.root.remove();
        editor.dispose();
    });

    test("shown again after its page was hidden, the field is scrolled, focused and selected as it was, the layer in step", () => {
        const editor = codeEditor("Machine file");
        document.body.appendChild(editor.root);
        const layer = editor.root.querySelector(".code-layer") as HTMLElement;
        editor.setText("a = 1\nb = 2\nc = 3\n");
        editor.textarea.focus();
        editor.textarea.setSelectionRange(2, 5);
        editor.textarea.scrollTop = 48;
        editor.textarea.scrollLeft = 9;
        editor.textarea.dispatchEvent(new Event("scroll"));
        expect(layer.scrollTop).toBe(48);
        expect(layer.scrollLeft).toBe(9);
        // Hidden, the field loses its scroll and its focus, as the browser
        // takes them from an element without a box.
        editor.setShown(false);
        editor.textarea.blur();
        editor.textarea.scrollTop = 0;
        editor.textarea.scrollLeft = 0;
        layer.scrollTop = 0;
        editor.textarea.setSelectionRange(0, 0);
        expect(document.activeElement).not.toBe(editor.textarea);
        editor.setShown(true);
        expect(editor.textarea.scrollTop).toBe(48);
        expect(editor.textarea.scrollLeft).toBe(9);
        expect(layer.scrollTop).toBe(48);
        expect(layer.scrollLeft).toBe(9);
        expect(document.activeElement).toBe(editor.textarea);
        expect(editor.textarea.selectionStart).toBe(2);
        expect(editor.textarea.selectionEnd).toBe(5);
        // Left on purpose while shown, the field does not take the focus back.
        editor.textarea.blur();
        editor.setShown(false);
        editor.setShown(true);
        expect(document.activeElement).not.toBe(editor.textarea);
        expect(editor.textarea.scrollTop).toBe(48);
        editor.root.remove();
        editor.dispose();
    });
});
