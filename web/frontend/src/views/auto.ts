// The Auto tab: a conversation with a language model that makes jobs and
// other data through the backend's tools. The backend runs each turn; this
// shows it as it comes (an answer as it is written, every tool call a
// folded line with its name, its arguments and a short result, unfolding
// to the whole), holds the box to write in with Send, Stop and New chat,
// and the row that picks the provider and model the next turn uses. Keys
// stay where the backend runs: the page is only told whether each is set.

import { button, el, labeled, replace, setLocked } from "../dom.ts";
import { mergeAuto, type AppState } from "../state.ts";
import type { AutoEntry, AutoProvider, AutoSettings } from "../types.ts";
import { into, type Ctx } from "./context.ts";

/** How long a folded tool call's result may be, characters. */
export const SHORT = 100;
/** How close to the end the conversation has to be scrolled to follow new lines, rem. */
const FOLLOW_REM = 3;

function remPixels(): number {
    return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

/** A value on one line, cut to `limit` characters: JSON compacted, other text its first line. */
export function shortText(value: unknown, limit = SHORT): string {
    let text: string;
    if (typeof value === "string") {
        try {
            text = JSON.stringify(JSON.parse(value));
        } catch {
            text = value.split("\n").find((line) => line.trim() !== "") ?? "";
        }
    } else {
        text = JSON.stringify(value) ?? "";
    }
    text = text.replace(/\s+/g, " ").trim();
    return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

/** A tool call's folded line: the call with its arguments, and what it answered so far. */
export function toolLine(entry: AutoEntry): { call: string; result: string } {
    const args = shortText(entry.arguments ?? {}, 60);
    const call = `${entry.name ?? "tool"}(${args === "{}" ? "" : args})`;
    if (!entry.done) {
        return { call, result: "running" };
    }
    return { call, result: `${entry.error ? "failed: " : ""}${shortText(entry.result ?? "")}` };
}

/** What the row says of the provider picked: its key set, missing, or why it cannot run. */
export function keyState(provider: AutoProvider | undefined): { state: "ok" | "warn" | "bad"; text: string } {
    if (provider === undefined) {
        return { state: "warn", text: "" };
    }
    if (!provider.ready) {
        return { state: "bad", text: provider.note ?? "not ready" };
    }
    if (provider.key_present === true) {
        return { state: "ok", text: `${provider.key_name} is set` };
    }
    if (provider.key_present === false) {
        return { state: "warn", text: provider.note ?? `${provider.key_name} is not set` };
    }
    return { state: "ok", text: provider.note ?? "ready" };
}

const WHO: Record<AutoEntry["role"], string> = { user: "You", assistant: "Model", tool: "Tool call", notice: "Notice", error: "Error" };

interface Shown {
    node: HTMLElement;
    update(entry: AutoEntry): void;
}

/** One line of the conversation, made once and changed in place, so an unfolded call stays open while its turn goes on. */
function entryNode(entry: AutoEntry): Shown {
    if (entry.role === "tool") {
        const call = el("span", { class: "auto-call" });
        const result = el("span", { class: "auto-result" });
        const args = el("pre", { class: "auto-pre" });
        const whole = el("pre", { class: "auto-pre" });
        const node = el("details", { class: "auto-entry auto-tool", "data-id": entry.id },
            el("summary", { "aria-label": "Tool call" }, call, result),
            el("div", { class: "auto-tool-body" },
                el("span", { class: "labeled-text" }, "Arguments"), args,
                el("span", { class: "labeled-text" }, "Result"), whole,
            ),
        );
        const update = (next: AutoEntry): void => {
            const line = toolLine(next);
            call.textContent = line.call;
            result.textContent = line.result;
            args.textContent = JSON.stringify(next.arguments ?? {}, null, 2);
            whole.textContent = next.done ? (next.result ?? "") : "running";
            node.classList.toggle("running", !next.done);
            node.classList.toggle("failed", next.done && next.error === true);
        };
        update(entry);
        return { node, update };
    }
    const text = el("div", { class: "auto-text" });
    const node = el("div", { class: `auto-entry auto-${entry.role}`, "data-id": entry.id, "aria-label": WHO[entry.role] }, text);
    const update = (next: AutoEntry): void => {
        text.textContent = next.text;
        node.classList.toggle("writing", !next.done);
    };
    update(entry);
    return { node, update };
}

export function mountAuto(roots: { chat: HTMLElement; about: HTMLElement }, ctx: Ctx): void {
    const { chat, about } = roots;
    const fresh = button("New chat", () => newChat(), "btn btn-quiet btn-small");
    fresh.title = "stop and start a new conversation";

    const provider = el("select", { class: "field", "aria-label": "Provider" }) as HTMLSelectElement;
    const model = el("input", { type: "text", class: "field", spellcheck: "false", autocomplete: "off", "aria-label": "Model" }) as HTMLInputElement;
    const baseUrl = el("input", { type: "url", class: "field", spellcheck: "false", autocomplete: "off", "aria-label": "Base URL", placeholder: "http://localhost:11434/v1" }) as HTMLInputElement;
    const baseField = labeled("Base URL", baseUrl, "labeled auto-base");
    const key = el("span", { class: "auto-key", "data-state": "warn" });
    const settingsRow = el("div", { class: "auto-settings" },
        labeled("Provider", provider),
        labeled("Model", model, "labeled auto-model"),
        baseField,
        key,
    );

    const log = el("div", { class: "auto-log", role: "log", "aria-live": "polite", "aria-label": "Conversation" });
    const empty = el("p", { class: "auto-empty muted" },
        "Ask for a job (drawing, test pattern, engraved text), a Plot operation, markers or a placement plan. "
        + "Nothing here moves the machine; run its jobs from the Jobs or Plot tab.");
    const working = el("p", { class: "auto-working muted" }, "working");
    const input = el("textarea", {
        class: "field auto-input",
        rows: 3,
        "aria-label": "Message",
        placeholder: "Message (Enter sends, Shift+Enter for a new line)",
    }) as HTMLTextAreaElement;
    const send = button("Send", () => sendMessage(), "btn btn-primary", "send the message");
    const stop = button("Stop", () => stopTurn(), "btn btn-danger urgent");
    stop.title = "stop this turn; what it made stays";
    chat.append(
        el("div", { class: "panel-head" }, el("h2", {}, "Auto"), el("div", { class: "button-row" }, fresh)),
        settingsRow,
        log,
        el("div", { class: "auto-compose" }, input, el("div", { class: "button-row" }, send, stop)),
    );

    const limit = el("span", {}, "25");
    about.append(
        el("h2", {}, "What it can do"),
        el("p", {}, "It makes and changes jobs, Plot jobs, CAM jobs, markers and pick and place plans, "
            + "and reads the machine state, machine files and CAM profiles."),
        el("p", {}, el("strong", {}, "It never moves the machine."), " It cannot connect, home, run jobs, fire the laser, "
            + "start the spindle, probe, use cameras, move the pick and place device, "
            + "or edit settings, machine files or CAM profiles. You run what it made."),
        el("p", {}, "It can write plugins for this page. Each stays off until you read it and turn it on in the Plugins tab; "
            + "one turned on runs with the page's whole power."),
        el("p", { class: "muted" }, "A turn makes at most ", limit, " tool calls. "
            + "Keys are read where the backend runs; this page only learns whether each is set."),
    );

    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            send.click();
        }
    });

    async function sendMessage(): Promise<void> {
        const text = input.value.trim();
        if (text === "") {
            input.focus();
            return;
        }
        const state = await ctx.call(ctx.api.autoSend(text));
        if (state) {
            input.value = "";
            mergeAuto(ctx.store, state);
        }
    }

    async function stopTurn(): Promise<void> {
        const state = await ctx.call(ctx.api.autoStop());
        if (state) {
            mergeAuto(ctx.store, state);
        }
    }

    async function newChat(): Promise<void> {
        await into(ctx, "auto", ctx.api.autoClear());
    }

    async function keep(patch: Parameters<Ctx["api"]["setAutoSettings"]>[0]): Promise<void> {
        const settings = await ctx.call(ctx.api.setAutoSettings(patch));
        if (settings) {
            ctx.store.set({ autoSettings: settings });
        } else {
            // Refused: the fields show what is kept again.
            renderSettings(ctx.store.get(), true);
        }
    }

    provider.addEventListener("change", () => void keep({ provider: provider.value as AutoSettings["provider"] }));
    model.addEventListener("change", () => void keep({ model: model.value }));
    baseUrl.addEventListener("change", () => void keep({ base_url: baseUrl.value }));

    const shown = new Map<number, Shown>();

    function renderConversation(state: AppState): void {
        const auto = state.auto;
        const entries = auto?.entries ?? [];
        const follow = log.scrollHeight - log.scrollTop - log.clientHeight < FOLLOW_REM * remPixels();
        const ids = new Set(entries.map((entry) => entry.id));
        for (const [id, line] of shown) {
            if (!ids.has(id)) {
                line.node.remove();
                shown.delete(id);
            }
        }
        for (const entry of entries) {
            const line = shown.get(entry.id);
            if (line === undefined) {
                const made = entryNode(entry);
                shown.set(entry.id, made);
                log.insertBefore(made.node, working);
            } else {
                line.update(entry);
            }
        }
        if (empty.parentElement !== log) {
            log.prepend(empty);
        }
        if (working.parentElement !== log) {
            log.append(working);
        }
        empty.classList.toggle("hidden", entries.length > 0);
        const busy = auto?.busy ?? false;
        working.classList.toggle("hidden", !busy);
        setLocked(send, busy, "the model is answering; Stop ends its turn");
        setLocked(stop, !busy, "nothing to stop");
        if (follow) {
            log.scrollTop = log.scrollHeight;
        }
    }

    function renderSettings(state: AppState, force = false): void {
        const settings = state.autoSettings;
        if (settings === null) {
            return;
        }
        const ids = settings.providers.map((entry) => entry.id).join(",");
        if (provider.dataset["ids"] !== ids) {
            provider.dataset["ids"] = ids;
            replace(provider, ...settings.providers.map((entry) => el("option", { value: entry.id }, entry.label)));
        }
        provider.value = settings.provider;
        const picked = settings.providers.find((entry) => entry.id === settings.provider);
        // A field being typed in is left alone: the reply to its change
        // sets it.
        if (force || document.activeElement !== model) {
            model.value = settings.model;
        }
        model.placeholder = picked?.default_model ? picked.default_model : "the model's name";
        if (force || document.activeElement !== baseUrl) {
            baseUrl.value = settings.base_url;
        }
        baseField.classList.toggle("hidden", settings.provider !== "openai");
        const said = keyState(picked);
        key.dataset["state"] = said.state;
        key.textContent = said.text;
        limit.textContent = String(settings.max_tool_calls);
    }

    ctx.store.subscribe((state) => renderConversation(state), ["auto"]);
    ctx.store.subscribe((state) => renderSettings(state), ["autoSettings"]);
    renderConversation(ctx.store.get());
    renderSettings(ctx.store.get());
    void into(ctx, "autoSettings", ctx.api.autoSettings());
    void ctx.refreshAuto();
}
