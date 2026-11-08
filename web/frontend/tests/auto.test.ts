import { describe, expect, test } from "bun:test";

import { applyEvent } from "../src/main.ts";
import { SCRIPT_SECONDS, summarize } from "../src/mock/auto.ts";
import { mergeAuto, withEntry } from "../src/state.ts";
import type { AutoEntry, AutoProvider } from "../src/types.ts";
import { keyState, mountAuto, shortText, toolLine } from "../src/views/auto.ts";
import { parseEvent } from "../src/ws.ts";
import { findButton, settle, setup } from "./harness.ts";

async function settleMany(times = 8): Promise<void> {
    for (let i = 0; i < times; i++) {
        await settle();
    }
}

/** The tab on the mock, with the mock's events going into the store as the page's feed puts them. */
function mount() {
    const env = setup();
    env.backend.onEvent((event) => applyEvent(env.ctx, event));
    const chat = document.createElement("section");
    const about = document.createElement("section");
    env.root.append(chat, about);
    mountAuto({ chat, about }, env.ctx);
    const input = chat.querySelector("textarea") as HTMLTextAreaElement;
    const select = chat.querySelector('select[aria-label="Provider"]') as HTMLSelectElement;
    return { ...env, chat, about, input, select };
}

function press(input: HTMLElement, key: string, shiftKey = false): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    return event;
}

function kinds(chat: HTMLElement): string[] {
    return Array.from(chat.querySelectorAll(".auto-entry")).map((node) => node.className.split(" ")[1]!);
}

function tool(id: number, overrides: Partial<AutoEntry> = {}): AutoEntry {
    return { id, role: "tool", text: "", done: true, name: "make_job", arguments: { filename: "a.svg" }, result: "{}", error: false, changed: ["jobs"], ...overrides };
}

describe("the Auto tab", () => {
    test("Enter sends, Shift+Enter does not, and the turn shows as it comes: a tool call folded, then the answer", async () => {
        const { chat, input, backend, calls, root } = mount();
        await settleMany();
        expect(chat.querySelector(".auto-empty")!.classList.contains("hidden")).toBe(false);
        input.value = "what jobs are there?";
        expect(press(input, "Enter", true).defaultPrevented).toBe(false);
        expect(calls.some((call) => call.name === "autoSend")).toBe(false);
        expect(press(input, "Enter").defaultPrevented).toBe(true);
        await settleMany();
        expect(calls.filter((call) => call.name === "autoSend").map((call) => call.args[0])).toEqual(["what jobs are there?"]);
        expect(input.value).toBe("");
        expect(kinds(chat)).toEqual(["auto-user"]);
        expect(findButton(chat, "Send").disabled).toBe(true);
        expect(findButton(chat, "Stop").disabled).toBe(false);
        expect(chat.querySelector(".auto-working")!.classList.contains("hidden")).toBe(false);

        backend.step(SCRIPT_SECONDS.call);
        await settleMany();
        expect(kinds(chat)).toEqual(["auto-user", "auto-assistant", "auto-tool"]);
        const call = chat.querySelector("details.auto-tool") as HTMLDetailsElement;
        expect(call.classList.contains("running")).toBe(true);
        expect(call.querySelector(".auto-call")!.textContent).toBe("list_jobs()");
        expect(call.querySelector(".auto-result")!.textContent).toBe("running");

        backend.step(SCRIPT_SECONDS.result - SCRIPT_SECONDS.call);
        await settleMany();
        // The same line, done, and unfolded it holds the whole of it.
        expect(chat.querySelector("details.auto-tool")).toBe(call);
        expect(call.classList.contains("running")).toBe(false);
        expect(call.querySelector(".auto-result")!.textContent!.startsWith('{"jobs":[{"id":')).toBe(true);
        call.open = true;
        const [args, whole] = Array.from(call.querySelectorAll("pre"));
        expect(args!.textContent).toBe("{}");
        expect(JSON.parse(whole!.textContent!).jobs[0].name).toBe("demo coupon");

        backend.step(SCRIPT_SECONDS.write - SCRIPT_SECONDS.result);
        await settleMany();
        const writing = chat.querySelectorAll(".auto-assistant")[1]!;
        expect(writing.classList.contains("writing")).toBe(true);
        backend.step(1);
        await settleMany();
        expect(kinds(chat)).toEqual(["auto-user", "auto-assistant", "auto-tool", "auto-assistant"]);
        expect(writing.classList.contains("writing")).toBe(false);
        expect(writing.textContent).toContain("demo coupon");
        // An unfolded call stays open while the turn goes on and after it.
        expect(call.open).toBe(true);
        expect(findButton(chat, "Send").disabled).toBe(false);
        expect(findButton(chat, "Stop").disabled).toBe(true);
        expect(chat.querySelector(".auto-working")!.classList.contains("hidden")).toBe(true);
        root.remove();
    });

    test("Stop ends the turn under way: the call it was making is marked stopped", async () => {
        const { chat, input, backend, calls, root } = mount();
        await settleMany();
        input.value = "jobs?";
        findButton(chat, "Send").click();
        await settleMany();
        backend.step(SCRIPT_SECONDS.call);
        await settleMany();
        findButton(chat, "Stop").click();
        await settleMany();
        expect(calls.some((call) => call.name === "autoStop")).toBe(true);
        const call = chat.querySelector("details.auto-tool")!;
        expect(call.classList.contains("failed")).toBe(true);
        expect(call.querySelector(".auto-result")!.textContent).toBe("failed: stopped by the operator");
        expect(kinds(chat)).toEqual(["auto-user", "auto-assistant", "auto-tool", "auto-notice"]);
        expect(chat.querySelector(".auto-notice")!.textContent).toBe("Stopped.");
        expect(findButton(chat, "Stop").disabled).toBe(true);
        expect(findButton(chat, "Send").disabled).toBe(false);
        // Nothing more comes of the stopped turn.
        backend.step(5);
        await settleMany();
        expect(kinds(chat)).toHaveLength(4);
        root.remove();
    });

    test("New chat clears the conversation", async () => {
        const { chat, input, backend, calls, store, root } = mount();
        await settleMany();
        input.value = "jobs?";
        findButton(chat, "Send").click();
        await settleMany();
        backend.step(5);
        await settleMany();
        expect(kinds(chat)).toHaveLength(4);
        findButton(chat, "New chat").click();
        await settleMany();
        expect(calls.some((call) => call.name === "autoClear")).toBe(true);
        expect(kinds(chat)).toEqual([]);
        expect(store.get().auto).toEqual({ entries: [], busy: false });
        expect(chat.querySelector(".auto-empty")!.classList.contains("hidden")).toBe(false);
        root.remove();
    });

    test("the settings row picks the provider, keeps its model and says whether its key is set", async () => {
        const { chat, select, calls, store, root, about } = mount();
        await settleMany();
        expect(Array.from(select.options).map((option) => option.value)).toEqual(["mock", "anthropic", "openai", "claude-code"]);
        expect(select.value).toBe("mock");
        const base = chat.querySelector(".auto-base")!;
        const key = chat.querySelector(".auto-key") as HTMLElement;
        expect(base.classList.contains("hidden")).toBe(true);
        expect(key.textContent).toBe("answers by listing the jobs; no model is asked");
        expect(about.textContent).toContain("at most 25 tool calls");
        expect(about.textContent).toContain("It cannot connect or disconnect the machine");

        select.value = "openai";
        select.dispatchEvent(new Event("change"));
        await settleMany();
        expect(calls.some((call) => call.name === "setAutoSettings" && JSON.stringify(call.args[0]) === '{"provider":"openai"}')).toBe(true);
        expect(base.classList.contains("hidden")).toBe(false);
        expect(key.dataset["state"]).toBe("warn");
        expect(key.textContent).toContain("OPENAI_API_KEY is not set");
        const model = chat.querySelector('input[aria-label="Model"]') as HTMLInputElement;
        model.value = "qwen2.5:7b";
        model.dispatchEvent(new Event("change"));
        await settleMany();
        expect(store.get().autoSettings?.models.openai).toBe("qwen2.5:7b");
        const url = chat.querySelector('input[aria-label="Base URL"]') as HTMLInputElement;
        url.value = "ftp://box";
        url.dispatchEvent(new Event("change"));
        await settleMany();
        expect(store.get().toasts.some((toast) => toast.text.startsWith("the base URL is http://"))).toBe(true);
        expect(url.value).toBe("http://localhost:11434/v1");

        // A provider the mock cannot reach answers as the backend's does.
        const input = chat.querySelector("textarea") as HTMLTextAreaElement;
        input.value = "hello";
        findButton(chat, "Send").click();
        await settleMany();
        expect(chat.querySelector(".auto-error")!.textContent).toBe("could not reach http://localhost:11434/v1: the mock reaches no server");
        expect(findButton(chat, "Send").disabled).toBe(false);

        select.value = "claude-code";
        select.dispatchEvent(new Event("change"));
        await settleMany();
        expect(key.dataset["state"]).toBe("bad");
        expect(model.placeholder).toBe("the model's name");
        root.remove();
    });

    test("a tool call that changed a job has the page list the jobs again", async () => {
        const { ctx, calls } = setup();
        const listed = () => calls.filter((call) => call.name === "jobs").length;
        applyEvent(ctx, { type: "auto", data: { entry: tool(1, { done: false }), busy: true, cleared: false } });
        applyEvent(ctx, { type: "auto", data: { entry: tool(2, { name: "list_jobs", changed: [] }), busy: true, cleared: false } });
        await settleMany();
        expect(listed()).toBe(0);
        applyEvent(ctx, { type: "auto", data: { entry: tool(1), busy: true, cleared: false } });
        await settleMany();
        expect(listed()).toBe(1);
        expect(ctx.store.get().auto?.entries.map((entry) => entry.id)).toEqual([1, 2]);
    });

    test("a line is put in its place, a late reply keeps the newer lines, and a clear empties it", async () => {
        const user: AutoEntry = { id: 1, role: "user", text: "hi", done: true };
        const answer: AutoEntry = { id: 3, role: "assistant", text: "Hel", done: false };
        expect(withEntry([user, answer], { ...answer, text: "Hello", done: true }).map((entry) => entry.text)).toEqual(["hi", "Hello"]);
        expect(withEntry([answer], user).map((entry) => entry.id)).toEqual([1, 3]);
        expect(withEntry([user], null)).toEqual([user]);

        const { ctx, store } = setup();
        store.set({ auto: { entries: [user, answer], busy: true } });
        mergeAuto(store, { entries: [user], busy: true });
        expect(store.get().auto?.entries.map((entry) => entry.id)).toEqual([1, 3]);
        applyEvent(ctx, { type: "auto", data: { entry: null, busy: false, cleared: true } });
        expect(store.get().auto).toEqual({ entries: [], busy: false });
        expect(parseEvent(JSON.stringify({ type: "auto", entry: null, busy: false, cleared: true }))).toEqual({ type: "auto", data: { entry: null, busy: false, cleared: true } });
    });

    test("a folded call and the key line say it in a few words", () => {
        expect(shortText('{\n "jobs": [\n  {"id": "a1"}\n ]\n}')).toBe('{"jobs":[{"id":"a1"}]}');
        expect(shortText("404: no such job\nmore")).toBe("404: no such job");
        expect(shortText("x".repeat(300))).toHaveLength(100);
        expect(toolLine(tool(1, { name: "get_job", arguments: { job_id: "a1" }, result: "404: no such job", error: true }))).toEqual({ call: 'get_job({"job_id":"a1"})', result: "failed: 404: no such job" });
        expect(toolLine(tool(1, { name: "list_jobs", arguments: {}, done: false })).call).toBe("list_jobs()");
        const provider = (overrides: Partial<AutoProvider>): AutoProvider => ({ id: "anthropic", label: "A", default_model: "m", key_name: "ANTHROPIC_API_KEY", key_present: true, ready: true, note: null, ...overrides });
        expect(keyState(provider({}))).toEqual({ state: "ok", text: "ANTHROPIC_API_KEY is set" });
        expect(keyState(provider({ key_present: false, note: "missing" }))).toEqual({ state: "warn", text: "missing" });
        expect(keyState(provider({ ready: false, note: "no claude" }))).toEqual({ state: "bad", text: "no claude" });
        expect(summarize([])).toContain("no jobs yet");
    });
});
