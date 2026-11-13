// Plugins: JavaScript modules for the page, kept by the backend in
// var/plugins (docs/PLUGINS.md says how one is made). A plugin exports
// `name` and `description` and `activate(host)`, which may return a
// function that undoes what it did. The runtime here loads each plugin the
// backend has turned on, from its module's address, and hands it a host:
// panels on the pages, the page's API, the store, toasts and the page
// shown. What a plugin adds through its host (panels, listeners) is taken
// away again when it is turned off, after its own undo; anything else it
// did is for that undo, or a reload, to clear.
//
// A plugin runs with the page's whole power, the machine's moves included,
// so the backend turns one on only as the text the operator was shown, and
// serves the module only while it is on as that text.

import type { Api } from "./api.ts";
import { activePage, el } from "./dom.ts";
import type { AppState, Store } from "./state.ts";
import type { MessageLevel } from "./types.ts";
import { adoptPanel, dropPanel } from "./views/panels.ts";
import { onPage, PAGES } from "./views/tabs.ts";

/** A plugin as the backend lists it. */
export interface PluginInfo {
    id: string;
    name: string;
    description: string;
    /** Written through the backend (the Auto tools), or a file put in var/plugins by hand. */
    made_by: "auto" | "file";
    /** Turned on as the text it has now. */
    enabled: boolean;
    /** It was on, and its file changed since: off again. */
    changed: boolean;
    /** The SHA-256 of its text: what it is turned on as. */
    hash: string;
    size: number;
    modified: string;
}

export interface PluginWithSource extends PluginInfo {
    source: string;
}

/** What a plugin's `activate` is given. */
export interface PluginHost {
    readonly id: string;
    /** The page's API: every call the page itself makes. */
    readonly api: Api;
    /** Adds a panel to a page (`jobs` unless named), at the end of its last column (before a panel docked at its foot); answers the panel's body to fill. */
    panel(options?: { title?: string; page?: string }): HTMLElement;
    /** The page's state now. */
    state(): AppState;
    /** Calls `listener` when one of `keys` of the state changes (any key with none); answers a function that stops it. */
    subscribe(listener: (state: AppState) => void, keys?: (keyof AppState)[]): () => void;
    toast(level: MessageLevel, text: string): void;
    /** Calls `listener` with each page shown; answers a function that stops it. */
    onPage(listener: (page: string) => void): () => void;
    /** The page shown now. */
    page(): string;
}

/** A plugin's module, as loaded: nothing in it is trusted to have the right type. */
export interface PluginModule {
    name?: unknown;
    description?: unknown;
    activate?: unknown;
}

/** What the runtime needs of the page. */
export interface PluginContext {
    api: Api;
    store: Store<AppState>;
    toast(level: MessageLevel, text: string): void;
}

export interface RuntimeOptions {
    /** Loads a module from its address: the browser's own import, unless a test gives another. */
    load?: (url: string) => Promise<PluginModule>;
}

interface Running {
    hash: string;
    /** The plugin's own undo, run first. */
    own: (() => void) | null;
    /** What the host took away for it, last first. */
    cleanups: (() => void)[];
    panels: number;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** The last column of a page, where a plugin's panel goes. */
function lastColumn(page: string): HTMLElement | null {
    const main = document.getElementById(`page-${page}`);
    const columns = main ? Array.from(main.children).filter((child): child is HTMLElement => child instanceof HTMLElement && child.classList.contains("column")) : [];
    return columns[columns.length - 1] ?? null;
}

export class PluginRuntime {
    private readonly running = new Map<string, Running>();
    /** Why a plugin turned on is not running, by its id. */
    readonly failures = new Map<string, string>();
    /** The text a plugin failed as: not tried again by `sync` until it changes. */
    private readonly failedAs = new Map<string, string>();
    private readonly pageListeners = new Set<(page: string) => void>();
    private readonly listeners: (() => void)[] = [];
    private readonly load: (url: string) => Promise<PluginModule>;

    constructor(private readonly ctx: PluginContext, options: RuntimeOptions = {}) {
        this.load = options.load ?? ((url) => import(/* @vite-ignore */ url) as Promise<PluginModule>);
        onPage((page) => {
            for (const listener of [...this.pageListeners]) {
                listener(page);
            }
        });
    }

    /** Hears each plugin started, stopped or failed. */
    onChange(listener: () => void): void {
        this.listeners.push(listener);
    }

    private changed(): void {
        for (const listener of this.listeners) {
            listener();
        }
    }

    isRunning(id: string): boolean {
        return this.running.has(id);
    }

    /** A plugin that went wrong while it ran: said, and stopped. */
    private fault(id: string, name: string, error: unknown): void {
        const said = messageOf(error);
        const hash = this.running.get(id)?.hash;
        this.stop(id);
        this.failures.set(id, said);
        if (hash !== undefined) {
            this.failedAs.set(id, hash);
        }
        this.ctx.toast("error", `plugin ${name}: ${said}`);
        this.changed();
    }

    /** Runs a plugin's own undo, once, then what the host added for it since the last time, last first. */
    private undo(id: string, running: Running): void {
        const steps = [...(running.own ? [running.own] : []), ...running.cleanups.splice(0).reverse()];
        running.own = null;
        for (const step of steps) {
            try {
                step();
            } catch (error) {
                console.warn(`plugin ${id}: undoing: ${messageOf(error)}`);
            }
        }
    }

    private hostFor(info: PluginInfo, running: Running): PluginHost {
        const guard = <T extends unknown[]>(listener: (...args: T) => void) => (...args: T): void => {
            try {
                listener(...args);
            } catch (error) {
                this.fault(info.id, info.name, error);
            }
        };
        return {
            id: info.id,
            api: this.ctx.api,
            panel: (options = {}) => {
                const page = PAGES.some((entry) => entry.id === options.page) ? options.page! : "jobs";
                const column = lastColumn(page);
                if (!column) {
                    throw new Error(`no page ${page} to put a panel on`);
                }
                running.panels += 1;
                const title = String(options.title ?? info.name);
                const body = el("div", { class: "plugin-body stack" });
                const section = el("section", {
                    id: running.panels === 1 ? `plugin-${info.id}` : `plugin-${info.id}-${running.panels}`,
                    class: "panel plugin-panel",
                    "aria-label": title,
                    "data-plugin": info.id,
                }, el("div", { class: "panel-head" }, el("h2", {}, title)), body);
                // Above a panel docked at the column's foot (the Run panel).
                const docked = Array.from(column.children).find((child) => child.hasAttribute("data-dock")) ?? null;
                column.insertBefore(section, docked);
                adoptPanel(section);
                running.cleanups.push(() => {
                    dropPanel(section.id);
                    section.remove();
                });
                return body;
            },
            state: () => this.ctx.store.get(),
            subscribe: (listener, keys) => {
                const stop = this.ctx.store.subscribe(guard((state: AppState) => listener(state)), keys);
                running.cleanups.push(stop);
                return stop;
            },
            toast: (level, text) => this.ctx.toast(level === "error" ? "error" : "info", String(text)),
            onPage: (listener) => {
                const heard = guard((page: string) => listener(page));
                this.pageListeners.add(heard);
                const stop = (): void => {
                    this.pageListeners.delete(heard);
                };
                running.cleanups.push(stop);
                return stop;
            },
            page: () => activePage(),
        };
    }

    /**
     * Starts a plugin turned on, unless it runs as that text already (one
     * running as another text is stopped first). Answers why it did not
     * start, or null.
     */
    async start(info: PluginInfo): Promise<string | null> {
        if (this.running.get(info.id)?.hash === info.hash) {
            return null;
        }
        this.stop(info.id);
        this.failures.delete(info.id);
        this.failedAs.delete(info.id);
        const running: Running = { hash: info.hash, own: null, cleanups: [], panels: 0 };
        this.running.set(info.id, running);
        const fail = (said: string): string => {
            if (this.running.get(info.id) === running) {
                this.stop(info.id);
            }
            this.failures.set(info.id, said);
            this.failedAs.set(info.id, info.hash);
            this.changed();
            return said;
        };
        let module: PluginModule;
        try {
            module = await this.load(this.ctx.api.pluginModuleUrl(info));
        } catch (error) {
            return fail(`it did not load: ${messageOf(error)}`);
        }
        // Turned off, or started as another text, while it loaded.
        if (this.running.get(info.id) !== running) {
            return null;
        }
        if (typeof module.activate !== "function") {
            return fail("it exports no activate(host)");
        }
        try {
            const undo: unknown = await (module.activate as (host: PluginHost) => unknown)(this.hostFor(info, running));
            if (typeof undo === "function") {
                running.own = () => {
                    (undo as () => void)();
                };
            }
        } catch (error) {
            return fail(`its activate failed: ${messageOf(error)}`);
        }
        if (this.running.get(info.id) !== running) {
            // Turned off while it activated: what it added since goes now.
            this.undo(info.id, running);
            return null;
        }
        this.changed();
        return null;
    }

    /** Stops a plugin: its own undo, then what the host added for it. */
    stop(id: string): void {
        const running = this.running.get(id);
        if (!running) {
            return;
        }
        this.running.delete(id);
        this.undo(id, running);
        this.changed();
    }

    /** Runs what the list has turned on, as the text it has now, and stops the rest. */
    async sync(list: PluginInfo[]): Promise<void> {
        const on = new Map(list.filter((info) => info.enabled).map((info) => [info.id, info]));
        for (const [id, running] of [...this.running]) {
            if (on.get(id)?.hash !== running.hash) {
                this.stop(id);
            }
        }
        for (const id of [...this.failures.keys()]) {
            if (on.get(id)?.hash !== this.failedAs.get(id)) {
                this.failures.delete(id);
                this.failedAs.delete(id);
            }
        }
        // One that failed as the text it has is not tried again.
        await Promise.all([...on.values()].filter((info) => !this.failures.has(info.id)).map((info) => this.start(info)));
    }
}
