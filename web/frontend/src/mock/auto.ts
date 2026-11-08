// The mock's twin of the Auto tab's backend (spinny_web.auto): its routes
// and `auto` events, with one provider the backend does not have, `mock`,
// which answers from a script: it looks at the jobs with the tool the
// backend's agent would call (list_jobs, which answers what GET /api/jobs
// does), then says what it found, a step at a time as the mock's clock
// runs, so the tab can be tried and tested with no model. The backend's
// own providers answer as the backend does when theirs cannot be reached.

import { ApiError } from "../api.ts";
import type { AutoConversation, AutoEntry, AutoEvent, AutoProvider, AutoProviderId, AutoSettings, AutoSettingsUpdate, JobSummary } from "../types.ts";

/** A turn's tool calls at most, as the backend's cap. */
export const MAX_TOOL_CALLS = 25;
export const MAX_MESSAGE = 20000;
export const DEFAULT_BASE_URL = "http://localhost:11434/v1";
const MODEL = /^[A-Za-z0-9._:/@+-]{0,200}$/;
const URL_PATTERN = /^https?:\/\/[^\s/?#]+[^\s]{0,500}$/;

export const MOCK_PROVIDERS: AutoProvider[] = [
    { id: "mock", label: "Scripted (mock)", default_model: "script", key_name: null, key_present: null, ready: true, note: "answers by listing the jobs; no model is asked" },
    { id: "anthropic", label: "Anthropic API", default_model: "claude-opus-5-5", key_name: "ANTHROPIC_API_KEY", key_present: false, ready: true, note: "ANTHROPIC_API_KEY is not set where the backend runs" },
    { id: "openai", label: "OpenAI-compatible", default_model: "", key_name: "OPENAI_API_KEY", key_present: false, ready: true, note: "OPENAI_API_KEY is not set: a local server such as ollama needs none" },
    { id: "claude-code", label: "Claude Code", default_model: "", key_name: null, key_present: null, ready: false, note: "the claude command is not on the backend's PATH" },
];

/** When each step of the scripted turn comes, in seconds of the mock's clock after the message. */
export const SCRIPT_SECONDS = { look: 0.3, call: 0.5, result: 1.0, write: 1.15, done: 1.3 };

/** A value as the backend's tools write it for the model: JSON with one space of indent. */
export function toolText(value: unknown): string {
    return JSON.stringify(value, null, 1);
}

/** What the scripted provider says about the jobs it found. */
export function summarize(jobs: JobSummary[]): string {
    if (jobs.length === 0) {
        return "There are no jobs yet. Upload a drawing or a board on the Jobs tab, or ask for one to be made.";
    }
    const parts = jobs.map((job) => {
        const paths = job.groups.reduce((sum, group) => sum + group.paths, 0);
        return `${job.name} (${job.id}): ${job.groups.length} group${job.groups.length === 1 ? "" : "s"}, ${paths} path${paths === 1 ? "" : "s"}`;
    });
    return `There ${jobs.length === 1 ? "is one job" : `are ${jobs.length} jobs`}: ${parts.join("; ")}. Nothing has been cut: a job runs when you run it on the Jobs tab.`;
}

/** What the backend says when a provider cannot answer, as its providers word it. */
function unreachable(provider: AutoProviderId, model: string, baseUrl: string): string {
    switch (provider) {
        case "anthropic":
            return "no Anthropic credentials: set ANTHROPIC_API_KEY where the backend runs, and restart it";
        case "openai":
            return model === "" ? "type the model's name for the OpenAI-compatible provider, as the server names it (for ollama, one that `ollama list` shows)" : `could not reach ${baseUrl.replace(/\/+$/, "")}: the mock reaches no server`;
        default:
            return "the claude command is not on the backend's PATH: install Claude Code where the backend runs, or pick another provider";
    }
}

interface Script {
    elapsed: number;
    stage: number;
    tool: AutoEntry | null;
    answer: AutoEntry | null;
    jobs: JobSummary[];
}

export class MockAuto {
    private readonly emit: (event: AutoEvent) => void;
    private readonly listJobs: () => JobSummary[];
    private entries: AutoEntry[] = [];
    private nextId = 1;
    private busy = false;
    private provider: AutoProviderId = "mock";
    private models: Partial<Record<AutoProviderId, string>> = {};
    private baseUrl = DEFAULT_BASE_URL;
    private script: Script | null = null;

    constructor(emit: (event: AutoEvent) => void, listJobs: () => JobSummary[]) {
        this.emit = emit;
        this.listJobs = listJobs;
    }

    settings(): AutoSettings {
        return {
            provider: this.provider,
            model: this.models[this.provider] ?? "",
            base_url: this.baseUrl,
            models: Object.fromEntries(MOCK_PROVIDERS.map((provider) => [provider.id, this.models[provider.id] ?? ""])),
            providers: MOCK_PROVIDERS.map((provider) => ({ ...provider })),
            max_tool_calls: MAX_TOOL_CALLS,
        };
    }

    /** Keeps what the backend would, and refuses what it would, before keeping any of it. */
    update(patch: AutoSettingsUpdate): AutoSettings {
        const ids = MOCK_PROVIDERS.map((provider) => provider.id);
        if (patch.provider !== undefined && !ids.includes(patch.provider)) {
            throw new ApiError(400, `provider must be one of ${ids.join(", ")}`);
        }
        const model = patch.model?.trim();
        if (model !== undefined && !MODEL.test(model)) {
            throw new ApiError(400, "a model's name is up to 200 letters, digits and . _ : / @ + -");
        }
        const baseUrl = patch.base_url?.trim();
        if (baseUrl !== undefined && baseUrl !== "" && !URL_PATTERN.test(baseUrl)) {
            throw new ApiError(400, "the base URL is http:// or https:// and a host, such as http://localhost:11434/v1");
        }
        if (patch.provider !== undefined) {
            this.provider = patch.provider;
        }
        if (model !== undefined) {
            this.models = { ...this.models, [patch.provider ?? this.provider]: model };
        }
        if (baseUrl !== undefined) {
            this.baseUrl = baseUrl === "" ? DEFAULT_BASE_URL : baseUrl;
        }
        return this.settings();
    }

    conversation(): AutoConversation {
        return { entries: this.entries.map((entry) => structuredClone(entry)), busy: this.busy };
    }

    send(text: string): AutoConversation {
        const message = text.trim();
        if (message === "") {
            throw new ApiError(400, "the message is empty");
        }
        if (message.length > MAX_MESSAGE) {
            throw new ApiError(400, `a message is at most ${MAX_MESSAGE} characters`);
        }
        if (this.busy) {
            throw new ApiError(409, "a turn is under way: wait for it, or stop it");
        }
        this.busy = true;
        this.add({ id: 0, role: "user", text: message, done: true });
        if (this.provider === "mock") {
            this.script = { elapsed: 0, stage: 0, tool: null, answer: null, jobs: [] };
        } else {
            this.add({ id: 0, role: "error", text: unreachable(this.provider, this.models[this.provider] ?? "", this.baseUrl), done: true });
            this.finish();
        }
        return this.conversation();
    }

    /** The scripted turn, a step as each of its times comes. */
    step(dt: number): void {
        const script = this.script;
        if (script === null) {
            return;
        }
        script.elapsed += dt;
        if (script.stage === 0 && script.elapsed >= SCRIPT_SECONDS.look) {
            this.add({ id: 0, role: "assistant", text: "Looking at the jobs first.", done: true });
            script.stage = 1;
        }
        if (script.stage === 1 && script.elapsed >= SCRIPT_SECONDS.call) {
            script.tool = this.add({ id: 0, role: "tool", text: "", done: false, name: "list_jobs", arguments: {}, result: null, error: false, changed: [] });
            script.stage = 2;
        }
        if (script.stage === 2 && script.elapsed >= SCRIPT_SECONDS.result && script.tool !== null) {
            script.jobs = this.listJobs();
            script.tool.result = toolText({ jobs: script.jobs });
            script.tool.done = true;
            this.publish(script.tool);
            script.stage = 3;
        }
        if (script.stage === 3 && script.elapsed >= SCRIPT_SECONDS.write) {
            // Written in two parts, as an answer streams.
            const text = summarize(script.jobs);
            script.answer = this.add({ id: 0, role: "assistant", text: text.slice(0, Math.ceil(text.length / 2)), done: false });
            script.stage = 4;
        }
        if (script.stage === 4 && script.elapsed >= SCRIPT_SECONDS.done && script.answer !== null) {
            script.answer.text = summarize(script.jobs);
            script.answer.done = true;
            this.publish(script.answer);
            this.script = null;
            this.finish();
        }
    }

    stop(): AutoConversation {
        if (this.busy) {
            this.script = null;
            for (const entry of this.entries) {
                if (!entry.done) {
                    entry.done = true;
                    if (entry.role === "tool") {
                        entry.result = "stopped by the operator";
                        entry.error = true;
                    }
                    this.publish(entry);
                }
            }
            this.add({ id: 0, role: "notice", text: "Stopped.", done: true });
            this.finish();
        }
        return this.conversation();
    }

    clear(): AutoConversation {
        this.stop();
        this.entries = [];
        this.emit({ entry: null, busy: false, cleared: true });
        return this.conversation();
    }

    private add(entry: AutoEntry): AutoEntry {
        entry.id = this.nextId++;
        this.entries.push(entry);
        this.publish(entry);
        return entry;
    }

    /** The entry as it is now, a copy: the page keeps what it was sent, and the mock goes on changing its own. */
    private publish(entry: AutoEntry): void {
        this.emit({ entry: structuredClone(entry), busy: this.busy, cleared: false });
    }

    private finish(): void {
        this.busy = false;
        this.emit({ entry: null, busy: false, cleared: false });
    }
}
