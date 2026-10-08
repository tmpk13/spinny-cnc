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
    });
});
