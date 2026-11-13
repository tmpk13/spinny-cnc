import { afterEach, describe, expect, test } from "bun:test";

import { HttpApi } from "../src/api.ts";
import { createContext } from "../src/main.ts";
import { MockBackend } from "../src/mock/backend.ts";
import { EXAMPLE_PLUGIN, exportedText, MockPlugins, textHash } from "../src/mock/plugins.ts";
import { PluginRuntime, type PluginHost, type PluginInfo, type PluginModule } from "../src/plugins.ts";
import { Store, initialState, type AppState } from "../src/state.ts";
import { LAYOUT_KEY, mountPanels } from "../src/views/panels.ts";
import { mountPlugins, pluginState, turnOnQuestion } from "../src/views/plugins.ts";
import { showPage } from "../src/views/tabs.ts";
import { connected } from "./harness.ts";

const settle = async (): Promise<void> => {
    for (let i = 0; i < 12; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
};

/** Pages like index.html's, a column each, for plugins' panels to go on. */
function makePages(): HTMLElement {
    const app = document.createElement("div");
    app.id = "app";
    app.setAttribute("data-page", "jobs");
    app.innerHTML = `
        <main id="page-jobs" class="grid page"><div class="column"><section id="dro" class="panel" aria-label="Position"><div class="panel-head"><h2>Position</h2></div></section></div>
            <div class="column"><section id="jobs" class="panel" aria-label="Jobs"><div class="panel-head"><h2>Jobs</h2></div></section>
                <section id="run" class="panel" data-dock aria-label="Run"><div class="panel-head"><h2>Run</h2></div></section></div></main>
        <main id="page-plugins" class="grid page"><div class="column"><section id="plugins" class="panel" aria-label="Plugins"></section></div></main>`;
    document.body.append(app);
    return app;
}

function context() {
    const store = new Store<AppState>(initialState(true));
    const backend = new MockBackend({ timers: false });
    const ctx = createContext(backend, store);
    return { store, backend, ctx };
}

/**
 * A loader that imports the address as a module, as the browser does. Bun
 * picks a data address's loader by the last dot in the address, not by its
 * type, and reads a module whose text has a dot near its end as a text
 * file: the text is given a last line ending in .js.
 */
const importing = (url: string): Promise<PluginModule> => {
    const comma = url.indexOf(",");
    const address = url.startsWith("data:") ? `${url.slice(0, comma + 1)}${encodeURIComponent(`${decodeURIComponent(url.slice(comma + 1))}\n// .js`)}` : url;
    return import(address) as Promise<PluginModule>;
};

afterEach(() => {
    document.body.replaceChildren();
    localStorage.removeItem(LAYOUT_KEY);
    localStorage.removeItem("spinny.page");
});

describe("the mock's plugins", () => {
    test("the example is there off, as a file; one written is off, by Auto; on only as the text shown", () => {
        const shelf = new MockPlugins();
        const [example] = shelf.list();
        expect(example).toMatchObject({ id: "big-position", name: "Big position", made_by: "file", enabled: false, changed: false });
        expect(example!.description).toBe("The head's place on the board in large digits, in a panel on the Jobs page.");
        const written = shelf.write("clock", 'export const name = "Clock";\nexport function activate(host) {}\n');
        expect(written).toMatchObject({ id: "clock", name: "Clock", made_by: "auto", enabled: false });
        expect(() => shelf.moduleUrl(written)).toThrow("not turned on as that text");
        expect(() => shelf.setEnabled("clock", true, "0000")).toThrow("read it again");
        const on = shelf.setEnabled("clock", true, written.hash);
        expect(on.enabled).toBe(true);
        expect(shelf.moduleUrl(on)).toStartWith("data:text/javascript;charset=utf-8,");
        const again = shelf.write("clock", 'export const name = "Clock 2";\n');
        expect(again).toMatchObject({ enabled: false, changed: true, made_by: "auto" });
        expect(() => shelf.moduleUrl(on)).toThrow("not turned on as that text");
        shelf.delete("clock");
        expect(shelf.list().map((info) => info.id)).toEqual(["big-position"]);
        expect(() => shelf.read("clock")).toThrow("no plugin clock");
        expect(() => shelf.write("Clock", "x")).toThrow("lower-case letters");
        expect(() => shelf.write("clock", "  ")).toThrow("source is empty");
    });

    test("name and description come from plain literals only; the hash follows the text", () => {
        expect(exportedText("export const name = 'A \\'quoted\\' one';\nexport const description = `two`;")).toEqual({ name: "A 'quoted' one", description: "two" });
        expect(exportedText("export const name = `made ${here}`;")).toEqual({});
        expect(textHash("abc")).toMatch(/^[0-9a-f]{16}$/);
        expect(textHash("abc")).toBe(textHash("abc"));
        expect(textHash("abd")).not.toBe(textHash("abc"));
    });

    test("docs/PLUGINS.md shows the example word for word", async () => {
        const docs = await Bun.file(new URL("../../../docs/PLUGINS.md", import.meta.url)).text();
        expect(docs).toContain(EXAMPLE_PLUGIN);
    });
});

describe("HttpApi plugin routes", () => {
    test("listed, read, switched with the hash shown, deleted, and imported from the backend's address", async () => {
        const calls: [string, string, unknown][] = [];
        const api = new HttpApi("http://host", async (url, init) => {
            calls.push([init?.method ?? "GET", url.replace("http://host", ""), typeof init?.body === "string" ? JSON.parse(init.body) : null]);
            return new Response(JSON.stringify({ plugins: [] }), { status: 200 });
        });
        await api.plugins();
        await api.plugin("big-position");
        await api.setPluginEnabled("big-position", true, "abc");
        await api.setPluginEnabled("big-position", false, null);
        await api.deletePlugin("big-position");
        expect(calls).toEqual([
            ["GET", "/api/plugins", null],
            ["GET", "/api/plugins/big-position", null],
            ["PUT", "/api/plugins/big-position/enabled", { enabled: true, hash: "abc" }],
            ["PUT", "/api/plugins/big-position/enabled", { enabled: false }],
            ["DELETE", "/api/plugins/big-position", null],
        ]);
        expect(api.pluginModuleUrl({ id: "big-position", hash: "a b" } as PluginInfo)).toBe("http://host/api/plugins/big-position/module.js?v=a%20b");
        expect(new HttpApi("").pluginModuleUrl({ id: "x", hash: "h" } as PluginInfo)).toEndWith("/api/plugins/x/module.js?v=h");
    });
});

describe("the plugin runtime", () => {
    function info(id: string, hash = "h1"): PluginInfo {
        return { id, name: id, description: "", made_by: "auto", enabled: true, changed: false, hash, size: 1, modified: "" };
    }

    function runtimeWith(modules: Record<string, PluginModule | Error>) {
        const { store, ctx } = context();
        const loaded: string[] = [];
        const fake = { ...ctx, api: { ...ctx.api, pluginModuleUrl: (plugin: PluginInfo) => `${plugin.id}@${plugin.hash}` } as typeof ctx.api };
        const runtime = new PluginRuntime(fake, {
            load: async (url) => {
                loaded.push(url);
                const module = modules[url.split("@")[0]!];
                if (!module || module instanceof Error) {
                    throw module ?? new Error("no module");
                }
                return module;
            },
        });
        return { runtime, store, loaded };
    }

    test("a plugin's panel goes on the page named, its listeners hear the store, and turning it off undoes it all", async () => {
        const app = makePages();
        const heard: string[] = [];
        let host: PluginHost | null = null;
        const { runtime, store } = runtimeWith({
            clock: {
                activate(given: PluginHost) {
                    host = given;
                    const body = given.panel({ title: "Clock" });
                    body.textContent = "tick";
                    given.subscribe((state) => heard.push(state.link), ["link"]);
                    given.onPage((page) => heard.push(`page ${page}`));
                    return () => heard.push("undone");
                },
            },
        });
        expect(await runtime.start(info("clock"))).toBeNull();
        const panel = app.querySelector<HTMLElement>("#page-jobs .column:last-child #plugin-clock")!;
        expect(panel.getAttribute("aria-label")).toBe("Clock");
        expect(panel.querySelector(".plugin-body")!.textContent).toBe("tick");
        expect(host!.state()).toBe(store.get());
        expect(host!.page()).toBe("jobs");
        store.set({ link: "open" });
        showPage("plugins");
        expect(heard).toEqual(["open", "page plugins"]);
        expect(runtime.isRunning("clock")).toBe(true);
        runtime.stop("clock");
        expect(app.querySelector("#plugin-clock")).toBeNull();
        store.set({ link: "closed" });
        showPage("jobs");
        expect(heard).toEqual(["open", "page plugins", "undone"]);
        expect(runtime.isRunning("clock")).toBe(false);
    });

    test("one that does not load, has no activate, or throws says why and is not running", async () => {
        makePages();
        const { runtime } = runtimeWith({
            broken: new Error("SyntaxError: unexpected token"),
            empty: { name: "Empty" },
            thrower: {
                activate(host: PluginHost) {
                    host.panel({ title: "Half" });
                    throw new Error("boom");
                },
            },
        });
        expect(await runtime.start(info("broken"))).toBe("it did not load: SyntaxError: unexpected token");
        expect(await runtime.start(info("empty"))).toBe("it exports no activate(host)");
        expect(await runtime.start(info("thrower"))).toBe("its activate failed: boom");
        // What it added before it threw is taken away.
        expect(document.querySelector("#plugin-thrower")).toBeNull();
        expect([...runtime.failures.keys()]).toEqual(["broken", "empty", "thrower"]);
        expect(runtime.isRunning("thrower")).toBe(false);
    });

    test("a listener that throws stops its plugin and says so", async () => {
        makePages();
        const { runtime, store } = runtimeWith({
            noisy: {
                activate(host: PluginHost) {
                    host.panel({});
                    host.subscribe(() => {
                        throw new Error("bad state");
                    }, ["link"]);
                },
            },
        });
        await runtime.start(info("noisy"));
        store.set({ link: "open" });
        expect(runtime.isRunning("noisy")).toBe(false);
        expect(runtime.failures.get("noisy")).toBe("bad state");
        expect(store.get().toasts.at(-1)?.text).toBe("plugin noisy: bad state");
        expect(document.querySelector("#plugin-noisy")).toBeNull();
    });

    test("sync runs what is on as its text, stops the rest, and does not try a failed text again", async () => {
        makePages();
        const { runtime, loaded } = runtimeWith({
            a: { activate: () => undefined },
            b: { activate: () => undefined },
            bad: new Error("nope"),
        });
        await runtime.sync([info("a"), { ...info("b"), enabled: false }, info("bad")]);
        expect(runtime.isRunning("a")).toBe(true);
        expect(runtime.isRunning("b")).toBe(false);
        expect(runtime.failures.get("bad")).toBe("it did not load: nope");
        await runtime.sync([info("a"), info("bad")]);
        expect(loaded).toEqual(["a@h1", "bad@h1"]);
        // Rewritten and turned on again: the new text runs in place of the old.
        await runtime.sync([info("a", "h2"), info("bad", "h2")]);
        expect(loaded).toEqual(["a@h1", "bad@h1", "a@h2", "bad@h2"]);
        await runtime.sync([]);
        expect(runtime.isRunning("a")).toBe(false);
        expect(runtime.failures.size).toBe(0);
    });

    test("the example of docs/PLUGINS.md runs: the head's place in large digits on the Jobs page", async () => {
        makePages();
        const { store, backend, ctx } = context();
        const runtime = new PluginRuntime(ctx, { load: importing });
        const example = backend.pluginShelf.list()[0]!;
        const on = backend.pluginShelf.setEnabled(example.id, true, example.hash);
        expect(await runtime.start(on)).toBeNull();
        const readout = document.querySelector("#page-jobs #plugin-big-position .plugin-body div")!;
        expect(readout.textContent).toBe("no machine");
        store.set({ snapshot: connected({ board: { x: 1, y: -2.5 } }) });
        expect(readout.textContent).toBe("X 1.00\nY -2.50");
        runtime.stop(example.id);
        expect(document.querySelector("#plugin-big-position")).toBeNull();
    });
});

describe("the panel layer and a plugin's panel", () => {
    test("a panel added after the layer mounted gets its head's controls, and goes when let go", async () => {
        const app = makePages();
        mountPanels(app);
        const { ctx, backend } = context();
        const runtime = new PluginRuntime(ctx, { load: importing });
        const example = backend.pluginShelf.list()[0]!;
        await runtime.start(backend.pluginShelf.setEnabled(example.id, true, example.hash));
        const panel = app.querySelector<HTMLElement>("#plugin-big-position")!;
        expect(panel.querySelector(".panel-menu-button")).not.toBeNull();
        expect(panel.querySelector(".panel-chevron")).not.toBeNull();
        // Above the panel docked at the column's foot, in the page and in its layout.
        const column = panel.parentElement!;
        expect(Array.from(column.children).filter((node) => node.matches("section.panel")).map((node) => node.id)).toEqual(["jobs", "plugin-big-position", "run"]);
        runtime.stop(example.id);
        expect(app.querySelector("#plugin-big-position")).toBeNull();
        expect(app.querySelectorAll(".panel-resize").length).toBe(app.querySelectorAll("section.panel").length);
    });
});

describe("the Plugins page", () => {
    function mount() {
        makePages();
        const { store, backend, ctx } = context();
        const root = document.getElementById("plugins")!;
        const view = mountPlugins(root, ctx, { load: importing });
        return { store, backend, root, view };
    }

    function press(root: ParentNode, label: string): void {
        const found = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === label);
        if (!found) {
            throw new Error(`no button ${label}`);
        }
        found.click();
    }

    test("lists each plugin with its switch, who made it, what it does and its state", async () => {
        const { root, view } = mount();
        await view.refresh();
        const item = root.querySelector(".plugin-item[data-id=big-position]")!;
        expect(item.querySelector(".plugin-name")!.textContent).toBe("Big position");
        expect(item.querySelector(".plugin-by")!.textContent).toBe("file");
        expect(item.querySelector(".plugin-description")!.textContent).toContain("large digits");
        expect(item.querySelector(".plugin-state")!.textContent).toBe("Off.");
        expect(item.querySelector<HTMLInputElement>("input[role=switch]")!.checked).toBe(false);
        const fold = item.querySelector<HTMLDetailsElement>("details")!;
        fold.open = true;
        fold.dispatchEvent(new Event("toggle"));
        await settle();
        expect(item.querySelector(".plugin-code")!.textContent).toBe(EXAMPLE_PLUGIN);
    });

    test("turning one on asks, naming the risk, then runs it here; off takes its panel away", async () => {
        const { root, view, backend } = mount();
        await view.refresh();
        const toggle = root.querySelector<HTMLInputElement>(".plugin-item[data-id=big-position] input[role=switch]")!;
        toggle.checked = true;
        toggle.dispatchEvent(new Event("change"));
        await settle();
        const ask = document.querySelector("dialog.confirm")!;
        expect(ask.textContent).toContain('Turn on "Big position" (a file put in var/plugins)? A plugin runs with the page\'s whole power: it can move the machine, fire the laser');
        press(ask, "Turn on");
        await settle();
        expect((await backend.plugins())[0]!.enabled).toBe(true);
        expect(document.querySelector("#page-jobs #plugin-big-position")).not.toBeNull();
        expect(root.querySelector(".plugin-state")!.textContent).toBe("On: running in this page.");
        toggle.checked = false;
        toggle.dispatchEvent(new Event("change"));
        await settle();
        expect((await backend.plugins())[0]!.enabled).toBe(false);
        expect(document.querySelector("#plugin-big-position")).toBeNull();
    });

    test("declined, it stays off; a plugin a tool wrote shows up, off, by Auto", async () => {
        const { root, view, backend, store } = mount();
        await view.refresh();
        const toggle = root.querySelector<HTMLInputElement>("input[role=switch]")!;
        toggle.checked = true;
        toggle.dispatchEvent(new Event("change"));
        await settle();
        press(document.querySelector("dialog.confirm")!, "Cancel");
        await settle();
        expect(toggle.checked).toBe(false);
        expect((await backend.plugins())[0]!.enabled).toBe(false);
        backend.pluginShelf.write("clock", 'export const name = "Clock";\nexport function activate(host) {}\n');
        store.set({ auto: { busy: false, entries: [{ id: 3, role: "tool", text: "", done: true, name: "write_plugin", changed: ["plugins"] }] } });
        await settle();
        const clock = root.querySelector(".plugin-item[data-id=clock]")!;
        expect(clock.querySelector(".plugin-by")!.textContent).toBe("Auto");
        expect(clock.querySelector(".plugin-state")!.textContent).toBe("Off.");
    });

    test("Delete asks, stops it and takes it out", async () => {
        const { root, view, backend } = mount();
        await view.refresh();
        const example = (await backend.plugins())[0]!;
        backend.pluginShelf.setEnabled(example.id, true, example.hash);
        await view.refresh();
        expect(document.querySelector("#plugin-big-position")).not.toBeNull();
        press(root, "Delete");
        await settle();
        press(document.querySelector("dialog.confirm")!, "Delete");
        await settle();
        expect(await backend.plugins()).toEqual([]);
        expect(document.querySelector("#plugin-big-position")).toBeNull();
        expect(root.querySelector(".plugin-item")).toBeNull();
        expect(root.textContent).toContain("No plugins yet");
    });

    test("what a plugin's state line and question say", () => {
        const off: PluginInfo = { id: "a", name: "A", description: "", made_by: "auto", enabled: false, changed: false, hash: "h", size: 1, modified: "" };
        expect(pluginState(off, false, null)).toBe("Off.");
        expect(pluginState({ ...off, changed: true }, false, null)).toBe("Off: its file changed since it was turned on.");
        expect(pluginState({ ...off, enabled: true }, true, null)).toBe("On: running in this page.");
        expect(pluginState({ ...off, enabled: true }, false, "it did not load: x")).toBe("On, but not running: it did not load: x.");
        expect(turnOnQuestion(off)).toStartWith('Turn on "A" (written by Auto)?');
    });
});
