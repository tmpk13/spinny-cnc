// Console log of tx/rx lines, a command line, and the realtime buttons.

import { button, el } from "../dom.ts";
import { CONSOLE_LIMIT, type AppState } from "../state.ts";
import type { ConsoleLine } from "../types.ts";
import type { Ctx } from "./context.ts";

const HISTORY = 50;

/** A line that writes the machine's settings, by the backend's own test: `$name=value`, `$load` or `$defaults`. */
export function writesSettings(line: string): boolean {
    const text = line.trim();
    return text.startsWith("$") && (text.includes("=") || ["load", "defaults"].includes(text.slice(1).trim().toLowerCase()));
}

export function mountConsole(root: HTMLElement, ctx: Ctx): void {
    const log = el("div", { class: "console-log", role: "log", "aria-live": "off" });
    const input = el("input", { type: "text", class: "field mono", placeholder: "command, e.g. ? or $ or jog R1", "aria-label": "Command line", autocomplete: "off" });
    const send = button("Send", () => submit(), "btn btn-quiet");
    // The link polls for status several times a second; showing that by
    // default buries everything an operator or a job did.
    const polls = el("input", { type: "checkbox", id: "show-polls" });
    polls.addEventListener("change", () => ctx.store.set({ showPolls: polls.checked }));
    const realtime = el("div", { class: "button-row" },
        button("Status ?", () => ctx.call(ctx.api.realtime("status")), "btn btn-quiet btn-small"),
        button("Hold !", () => ctx.call(ctx.api.realtime("hold")), "btn btn-quiet btn-small"),
        button("Resume ~", () => ctx.call(ctx.api.realtime("resume")), "btn btn-quiet btn-small"),
        button("Reset", () => ctx.call(ctx.api.realtime("reset")), "btn btn-danger btn-small"),
        button("Clear", () => { ctx.store.set({ console: [] }); }, "btn btn-quiet btn-small"),
        el("label", { class: "check", for: "show-polls", title: "Show the status polls the link sends on its own" }, polls, "polls"),
    );
    root.append(
        el("div", { class: "panel-head" }, el("h2", {}, "Console"), realtime),
        log,
        el("form", { class: "console-input", onsubmit: (event) => { event.preventDefault(); send.click(); } }, input, send),
    );

    const history: string[] = [];
    let historyIndex = -1;
    input.addEventListener("keydown", (event) => {
        if (event.key === "ArrowUp" && history.length > 0) {
            event.preventDefault();
            historyIndex = Math.max(0, historyIndex < 0 ? history.length - 1 : historyIndex - 1);
            input.value = history[historyIndex] ?? "";
        } else if (event.key === "ArrowDown" && historyIndex >= 0) {
            event.preventDefault();
            historyIndex = historyIndex + 1 >= history.length ? -1 : historyIndex + 1;
            input.value = historyIndex < 0 ? "" : history[historyIndex] ?? "";
        }
    });

    async function submit(): Promise<void> {
        const line = input.value.trim();
        if (line === "") {
            return;
        }
        history.push(line);
        if (history.length > HISTORY) {
            history.shift();
        }
        historyIndex = -1;
        input.value = "";
        await ctx.call(ctx.api.command(line));
        // The settings panel, the preview's reach and the probe queue read
        // the page's copy of the settings, which this line may have changed.
        if (writesSettings(line) && ctx.store.get().snapshot.connected) {
            await ctx.refreshSettings();
        }
    }

    let shown: ConsoleLine[] = [];
    ctx.store.subscribe((state) => render(state), ["console"]);

    function lineNode(line: ConsoleLine): HTMLElement {
        const dir = el("span", { class: "dir" }, line.dir === "tx" ? "> " : "< ");
        return el("div", { class: `console-line ${line.dir}${line.poll ? " poll" : ""}` }, dir, el("span", { class: "text" }, line.text));
    }

    function render(state: AppState): void {
        const next = state.console;
        const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 2 * 16;
        const appended = next.length === shown.length + 1 && (shown.length === 0 || next[shown.length - 1] === shown[shown.length - 1]);
        const rolled = next.length === CONSOLE_LIMIT && shown.length === CONSOLE_LIMIT && next[next.length - 2] === shown[shown.length - 1];
        if (appended) {
            const last = next[next.length - 1];
            if (last) {
                log.appendChild(lineNode(last));
            }
        } else if (rolled) {
            if (log.firstChild) {
                log.removeChild(log.firstChild);
            }
            const last = next[next.length - 1];
            if (last) {
                log.appendChild(lineNode(last));
            }
        } else {
            while (log.firstChild) {
                log.removeChild(log.firstChild);
            }
            for (const line of next) {
                log.appendChild(lineNode(line));
            }
        }
        shown = next;
        if (atBottom) {
            log.scrollTop = log.scrollHeight;
        }
    }
}
