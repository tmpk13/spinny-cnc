// The mock's twin of the backend's plugins (spinny_web.plugins): kept in
// memory, with the example of docs/PLUGINS.md there from the start as a
// file put in place by hand. A plugin written is off; it is turned on only
// as the text shown, and its module is served only while it is on as that
// text, from a data address made of the text, which the browser imports as
// it would the backend's. The text's hash is one of the mock's own, not
// SHA-256: the page takes it as an opaque word.

import { ApiError } from "../api.ts";
import type { PluginInfo, PluginWithSource } from "../plugins.ts";

/** The example of docs/PLUGINS.md, word for word (a test holds the two together). */
export const EXAMPLE_PLUGIN = `// A panel on the Jobs page with the head's place on the board in large
// digits, drawn again whenever the machine reports.
export const name = "Big position";
export const description = "The head's place on the board in large digits, in a panel on the Jobs page.";

export function activate(host) {
    const body = host.panel({ title: "Big position", page: "jobs" });
    const readout = document.createElement("div");
    readout.style.font = "600 2.5rem/1.2 var(--mono)";
    readout.style.color = "var(--strong)";
    readout.style.whiteSpace = "pre";
    body.append(readout);
    const draw = (state) => {
        const machine = state.snapshot.machine;
        readout.textContent = machine
            ? \`X \${machine.board.x.toFixed(2)}\\nY \${machine.board.y.toFixed(2)}\`
            : "no machine";
    };
    draw(host.state());
    // Stopped by the host when the plugin is turned off, as its panel is taken away.
    host.subscribe(draw, ["snapshot"]);
}
`;

const PLUGIN_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_SOURCE = 256 * 1024;
const EXPORT = /export\s+const\s+(name|description)\s*=\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`([^`\\$]*)`)/g;
const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", "0": "\0" };

/** The `name` and `description` a module exports as plain string literals, the first of each. */
export function exportedText(source: string): { name?: string; description?: string } {
    const found: { name?: string; description?: string } = {};
    for (const match of source.matchAll(EXPORT)) {
        const key = match[1] as "name" | "description";
        if (found[key] !== undefined) {
            continue;
        }
        const raw = match[2] ?? match[3] ?? match[4] ?? "";
        found[key] = raw.replace(/\\(.)/g, (_, char: string) => ESCAPES[char] ?? char);
    }
    return found;
}

/** A hash of a text, sixteen hex digits: two FNV-1a passes with different starts. */
export function textHash(text: string): string {
    let a = 0x811c9dc5;
    let b = 0x01000193 ^ 0x5bd1e995;
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        a = Math.imul(a ^ code, 0x01000193) >>> 0;
        b = Math.imul(b ^ code, 0x01000193 + 2) >>> 0;
    }
    return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

function oneLine(text: string, most: number): string {
    const one = text.split(/\s+/).filter((word) => word !== "").join(" ");
    return one.length <= most ? one : `${one.slice(0, most - 3).trimEnd()}...`;
}

interface Kept {
    source: string;
    /** The hash of the text last written through the routes; null for a file put by hand. */
    written: string | null;
    /** The hash of the text turned on; null for off. */
    enabled: string | null;
    rewritten: boolean;
    modified: string;
}

export class MockPlugins {
    private readonly kept = new Map<string, Kept>([
        ["big-position", { source: EXAMPLE_PLUGIN, written: null, enabled: null, rewritten: false, modified: "2026-11-13T12:00:00+00:00" }],
    ]);

    private checkId(id: string): void {
        if (!PLUGIN_ID.test(id)) {
            throw new ApiError(400, "a plugin's id is 1 to 64 lower-case letters, digits, _ or -, starting with a letter or digit");
        }
    }

    private entry(id: string): Kept {
        this.checkId(id);
        const kept = this.kept.get(id);
        if (!kept) {
            throw new ApiError(404, `no plugin ${id}`);
        }
        return kept;
    }

    private info(id: string, kept: Kept): PluginInfo {
        const hash = textHash(kept.source);
        const said = exportedText(kept.source);
        return {
            id,
            name: oneLine(said.name ?? "", 80) || id,
            description: oneLine(said.description ?? "", 500),
            made_by: kept.written === hash ? "auto" : "file",
            enabled: kept.enabled === hash,
            changed: (kept.enabled !== null && kept.enabled !== hash) || kept.rewritten,
            hash,
            size: new TextEncoder().encode(kept.source).length,
            modified: kept.modified,
        };
    }

    list(): PluginInfo[] {
        return [...this.kept.keys()].sort().map((id) => this.info(id, this.kept.get(id)!));
    }

    read(id: string): PluginWithSource {
        const kept = this.entry(id);
        return { ...this.info(id, kept), source: kept.source };
    }

    /** Keeps a plugin as the Auto tools would write it: switched off. */
    write(id: string, source: string): PluginInfo {
        this.checkId(id);
        if (source.trim() === "") {
            throw new ApiError(400, "a plugin's source is empty");
        }
        if (new TextEncoder().encode(source).length > MAX_SOURCE) {
            throw new ApiError(400, `a plugin is at most ${MAX_SOURCE / 1024} KB`);
        }
        const before = this.kept.get(id);
        const kept: Kept = {
            source,
            written: textHash(source),
            enabled: null,
            rewritten: (before?.enabled ?? null) !== null || before?.rewritten === true,
            modified: new Date().toISOString().replace(/\.\d+Z$/, "+00:00"),
        };
        this.kept.set(id, kept);
        return this.info(id, kept);
    }

    setEnabled(id: string, enabled: boolean, hash: string | null): PluginInfo {
        const kept = this.entry(id);
        const now = textHash(kept.source);
        if (enabled && hash !== now) {
            throw new ApiError(409, "the plugin changed since it was shown: read it again before turning it on");
        }
        kept.enabled = enabled ? now : null;
        kept.rewritten = false;
        return this.info(id, kept);
    }

    delete(id: string): void {
        this.entry(id);
        this.kept.delete(id);
    }

    /** The module's address while the plugin is on as `info.hash`. */
    moduleUrl(info: PluginInfo): string {
        const kept = this.entry(info.id);
        const now = textHash(kept.source);
        if (kept.enabled !== now || info.hash !== now) {
            throw new ApiError(409, `plugin ${info.id} is not turned on as that text`);
        }
        return `data:text/javascript;charset=utf-8,${encodeURIComponent(kept.source)}`;
    }
}
