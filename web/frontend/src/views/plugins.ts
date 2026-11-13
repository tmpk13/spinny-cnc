// The Plugins page: the plugins the backend keeps (var/plugins), each with
// a switch, what it says it does, who made it (Auto, or a file put there
// by hand), its source in a fold, and Delete. A plugin runs in this page
// with the page's whole power, the machine's moves included, so turning
// one on asks first, saying so. The backend keeps which are on and sends
// the list to every page after each change (a switch, a tool writing one
// again, a delete), and each page starts and stops its plugins by it: a
// switch applies in every browser at once. The list is read again when
// this page is shown and when the event feed opens again.

import { button, el } from "../dom.ts";
import { askConfirm } from "../confirm.ts";
import { PluginRuntime, type PluginInfo, type RuntimeOptions } from "../plugins.ts";
import type { AppState } from "../state.ts";
import type { Ctx } from "./context.ts";
import { onPage } from "./tabs.ts";

interface Row {
    item: HTMLLIElement;
    toggle: HTMLInputElement;
    name: HTMLElement;
    by: HTMLElement;
    id: HTMLElement;
    description: HTMLParagraphElement;
    state: HTMLParagraphElement;
    fold: HTMLDetailsElement;
    code: HTMLPreElement;
    /** The text the fold shows, by its hash; null until it is opened. */
    shown: string | null;
}

/** What the state line says of a plugin. */
export function pluginState(info: PluginInfo, running: boolean, failure: string | null): string {
    if (failure !== null) {
        return `On, but not running: ${failure}.`;
    }
    if (info.enabled) {
        return running ? "On: running in this page." : "On: starting.";
    }
    if (info.changed) {
        return "Off: its file changed since it was turned on.";
    }
    return "Off.";
}

/** The question asked before a plugin is turned on. */
export function turnOnQuestion(info: PluginInfo): string {
    const who = info.made_by === "auto" ? "written by Auto" : "a file put in var/plugins";
    return `Turn on "${info.name}" (${who})? A plugin runs with the page's whole power: it can move the machine, fire the laser and change any setting.`;
}

/** Mounts the Plugins page's panel in `root`, and starts the plugins the backend has turned on. */
export function mountPlugins(root: HTMLElement, ctx: Ctx, options: RuntimeOptions = {}): { runtime: PluginRuntime; refresh(): Promise<void>; settled(): Promise<void> } {
    const runtime = new PluginRuntime(ctx, options);
    const reload = button("Reload list", () => refresh(), "btn btn-small btn-quiet", "read the plugins again from the backend");
    const list = el("ul", { class: "plugin-list", "aria-label": "Plugins" });
    const empty = el("p", { class: "muted hint" }, "No plugins yet: ask the Auto tab for one, or put a .js file in var/plugins.");
    root.append(
        el("div", { class: "panel-head" }, el("h2", {}, "Plugins"), reload),
        el("p", { class: "muted hint" },
            "A plugin runs in this page with its whole power, the machine's moves included: read its source before turning it on. "
            + "Each is off until turned on here, and off again when its file changes."),
        list,
        empty,
    );

    let shown: PluginInfo[] = [];
    const rows = new Map<string, Row>();
    // The plugins started and stopped by the last list, when that is done.
    let syncing: Promise<void> = Promise.resolve();

    async function showSource(info: PluginInfo, row: Row): Promise<void> {
        if (row.shown === info.hash) {
            return;
        }
        const got = await ctx.call(ctx.api.plugin(info.id));
        if (got) {
            row.code.textContent = got.source;
            row.shown = got.hash;
        }
    }

    async function setOn(info: PluginInfo, on: boolean, row: Row): Promise<void> {
        if (on && !(await askConfirm(turnOnQuestion(info), "Turn on"))) {
            row.toggle.checked = false;
            return;
        }
        const kept = await ctx.call(ctx.api.setPluginEnabled(info.id, on, on ? info.hash : null));
        if (!kept) {
            // Refused (the plugin changed since it was shown): the list as it is now.
            await refresh();
            return;
        }
        // Started or stopped by the list, as every other page does with the backend's.
        ctx.store.set({ plugins: (ctx.store.get().plugins ?? shown).map((entry) => (entry.id === kept.id ? kept : entry)) });
        await syncing;
        if (!on) {
            ctx.toast("info", `${kept.name} is off: what it added is gone, and a reload clears anything it left`);
        }
    }

    async function remove(info: PluginInfo): Promise<void> {
        if (!(await askConfirm(`Delete the plugin "${info.name}"? Its file goes from var/plugins.`, "Delete"))) {
            return;
        }
        if (await ctx.call(ctx.api.deletePlugin(info.id).then(() => true))) {
            ctx.store.set({ plugins: (ctx.store.get().plugins ?? shown).filter((entry) => entry.id !== info.id) });
            await syncing;
        }
    }

    function rowFor(info: PluginInfo): Row {
        let row = rows.get(info.id);
        if (!row) {
            const toggle = el("input", { type: "checkbox", role: "switch", "aria-label": `${info.name} on` }) as HTMLInputElement;
            const code = el("pre", { class: "plugin-code" });
            const fold = el("details", { class: "plugin-source stack" }, el("summary", { title: "the plugin's text, as the page would run it" }, "Source"), code) as HTMLDetailsElement;
            const made: Row = {
                item: el("li", { class: "plugin-item stack", "data-id": info.id }),
                toggle,
                name: el("strong", { class: "plugin-name" }),
                by: el("span", { class: "badge plugin-by" }),
                id: el("span", { class: "muted mono plugin-id" }),
                description: el("p", { class: "plugin-description" }),
                state: el("p", { class: "hint plugin-state" }),
                fold,
                code,
                shown: null,
            };
            const remover = button("Delete", () => remove(current(info.id) ?? info), "btn btn-small btn-quiet", "delete the plugin's file");
            toggle.addEventListener("change", () => {
                const now = current(info.id);
                if (now) {
                    void setOn(now, toggle.checked, made);
                }
            });
            fold.addEventListener("toggle", () => {
                const now = current(info.id);
                if (fold.open && now) {
                    void showSource(now, made);
                }
            });
            made.item.append(
                el("div", { class: "plugin-top" },
                    el("label", { class: "check plugin-switch", title: "turn the plugin on or off" }, toggle, " On"),
                    made.name, made.by, made.id, remover),
                made.description,
                made.state,
                fold,
            );
            rows.set(info.id, made);
            row = made;
        }
        row.toggle.checked = info.enabled;
        row.name.textContent = info.name;
        row.by.textContent = info.made_by === "auto" ? "Auto" : "file";
        row.by.dataset["by"] = info.made_by;
        row.by.title = info.made_by === "auto" ? "written by the Auto tab's tools" : "put in var/plugins by hand";
        row.id.textContent = info.id;
        row.description.textContent = info.description;
        row.description.hidden = info.description === "";
        row.state.textContent = pluginState(info, runtime.isRunning(info.id), runtime.failures.get(info.id) ?? null);
        row.state.classList.toggle("plugin-failed", runtime.failures.has(info.id));
        row.item.toggleAttribute("data-on", info.enabled);
        if (row.fold.open && row.shown !== info.hash) {
            void showSource(info, row);
        }
        return row;
    }

    function current(id: string): PluginInfo | undefined {
        return shown.find((entry) => entry.id === id);
    }

    function draw(): void {
        const ids = new Set(shown.map((info) => info.id));
        for (const [id, row] of rows) {
            if (!ids.has(id)) {
                row.item.remove();
                rows.delete(id);
            }
        }
        shown.forEach((info, index) => {
            const row = rowFor(info).item;
            if (list.children[index] !== row) {
                list.insertBefore(row, list.children[index] ?? null);
            }
        });
        list.hidden = shown.length === 0;
        empty.hidden = shown.length > 0;
    }

    async function refresh(): Promise<void> {
        const got = await ctx.call(ctx.api.plugins());
        if (got) {
            ctx.store.set({ plugins: got });
            await syncing;
        }
    }

    runtime.onChange(() => draw());
    // The list, from a reply or the event feed: drawn, and the plugins on
    // in it started, the rest stopped.
    ctx.store.subscribe((state: AppState) => {
        shown = state.plugins ?? [];
        draw();
        const list = shown;
        syncing = syncing.then(() => runtime.sync(list)).then(() => draw());
    }, ["plugins"]);
    onPage((page) => {
        if (page === "plugins") {
            void refresh();
        }
    });
    // Events missed while the feed was down: the list again.
    ctx.store.subscribe((state: AppState, previous: AppState) => {
        if (state.link === "open" && previous.link !== "open") {
            void refresh();
        }
    }, ["link"]);

    draw();
    const started = refresh();
    return {
        runtime,
        async refresh() {
            await started;
            await refresh();
        },
        /** Waits for the plugins of the last list to be started and stopped. */
        async settled() {
            await started;
            await syncing;
        },
    };
}
