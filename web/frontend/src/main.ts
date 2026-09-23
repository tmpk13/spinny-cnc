// Entry point: picks the real backend or the in-page mock, wires the event
// feed into the store, and mounts the views.

import { HttpApi, type Api } from "./api.ts";
import { MockBackend } from "./mock.ts";
import { appendConsole, initialState, pushToast, Store, type AppState } from "./state.ts";
import type { MessageLevel } from "./types.ts";
import { EventSocket, wsUrl, type EventFeed } from "./ws.ts";
import { mountConsole } from "./views/console.ts";
import type { Ctx } from "./views/context.ts";
import { mountDro } from "./views/dro.ts";
import { mountJobs } from "./views/jobs.ts";
import { mountJog } from "./views/jog.ts";
import { mountLaser } from "./views/laser.ts";
import { mountPreviewPanel } from "./views/previewpanel.ts";
import { mountSettings } from "./views/settings.ts";
import { mountStatusBar } from "./views/statusbar.ts";
import { mountToasts } from "./views/toasts.ts";

export function createContext(api: Api, store: Store<AppState>): Ctx {
    const toast = (level: MessageLevel, text: string): void => {
        pushToast(store, level, text);
    };
    const ctx: Ctx = {
        api,
        store,
        toast,
        async call<T>(promise: Promise<T>): Promise<T | undefined> {
            try {
                return await promise;
            } catch (error) {
                toast("error", error instanceof Error ? error.message : String(error));
                return undefined;
            }
        },
        async refreshState() {
            const snapshot = await ctx.call(api.state());
            // Once the event feed is open it carries the same snapshot at up
            // to 10 Hz, and a reply built before its latest frame must not
            // step the readout back; before that, the reply is all there is.
            // A null run is the backend's word that no run exists in it
            // (it restarted): a run kept from before would lock the page.
            if (snapshot && store.get().link !== "open") {
                store.set({ snapshot, progress: snapshot.run });
            }
        },
        async refreshPorts() {
            const ports = await ctx.call(api.ports());
            if (ports) {
                store.set({ ports });
            }
        },
        async refreshJobs() {
            const jobs = await ctx.call(api.jobs());
            if (jobs) {
                store.set({ jobs });
                const selected = store.get().job;
                if (selected && !jobs.some((job) => job.id === selected.id)) {
                    store.set({ job: null });
                }
            }
        },
        async refreshSettings() {
            const settings = await ctx.call(api.settings());
            if (settings) {
                store.set({ settings });
            }
        },
        async selectJob(id) {
            if (id === null) {
                store.set({ job: null });
                return;
            }
            const job = await ctx.call(api.job(id));
            if (job) {
                store.set({ job });
            }
        },
    };
    return ctx;
}

/** Everything the page needs after a (re)connect of the event feed. */
async function refreshAll(ctx: Ctx): Promise<void> {
    await Promise.all([ctx.refreshState(), ctx.refreshPorts(), ctx.refreshJobs()]);
    // The settings live on the machine: asking with no machine connected
    // is answered with an error, which is not news.
    if (ctx.store.get().snapshot.connected) {
        await ctx.refreshSettings();
    }
}

function main(): void {
    const params = new URLSearchParams(window.location.search);
    const mock = params.get("mock") === "1";
    const apiBase = params.get("api") ?? "";
    const store = new Store<AppState>(initialState(mock));

    let api: Api;
    let feed: EventFeed;
    if (mock) {
        const backend = new MockBackend();
        api = backend;
        feed = backend;
    } else {
        api = new HttpApi(apiBase);
        feed = new EventSocket(wsUrl(apiBase, window.location));
    }
    const ctx = createContext(api, store);

    feed.onStatus((status) => {
        const before = store.get().link;
        store.set({ link: status });
        document.getElementById("app")?.setAttribute("data-link", status);
        if (status === "open" && before !== "open") {
            void refreshAll(ctx);
        }
    });
    feed.onEvent((event) => {
        switch (event.type) {
            case "state":
                store.set({ snapshot: event.data, progress: event.data.run });
                break;
            case "console":
                appendConsole(store, event.data);
                break;
            case "progress":
                store.set({ progress: event.data });
                break;
            case "message":
                ctx.toast(event.data.level, event.data.text);
                break;
        }
    });

    const panel = (id: string): HTMLElement => {
        const node = document.getElementById(id);
        if (!node) {
            throw new Error(`missing element #${id}`);
        }
        return node;
    };
    mountStatusBar(panel("status"), ctx);
    mountDro(panel("dro"), ctx);
    mountJog(panel("jog"), ctx);
    mountLaser(panel("laser"), ctx);
    mountJobs(panel("jobs"), ctx);
    mountPreviewPanel(panel("preview"), ctx);
    mountConsole(panel("console"), ctx);
    mountSettings(panel("settings"), ctx);
    mountToasts(panel("toasts"), ctx);

    if (mock) {
        ctx.toast("info", "mock backend: nothing here touches the machine");
    }
    feed.start();
    void refreshAll(ctx);
}

if (typeof document !== "undefined" && document.getElementById("app")) {
    main();
}
