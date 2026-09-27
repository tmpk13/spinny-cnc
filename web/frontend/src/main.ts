// Entry point: picks the real backend or the in-page mock, wires the event
// feed into the store, and mounts the views.

import { HttpApi, type Api } from "./api.ts";
import { MockBackend } from "./mock.ts";
import { appendConsole, initialState, pushToast, Store, type AppState } from "./state.ts";
import type { MessageLevel, Profile, Snapshot, WsEvent } from "./types.ts";
import { EventSocket, wsUrl, type EventFeed } from "./ws.ts";
import { mountConsole } from "./views/console.ts";
import type { Ctx } from "./views/context.ts";
import { mountDro } from "./views/dro.ts";
import { mountHeightMap } from "./views/heightmap.ts";
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
    // Replies can overtake each other (a large job takes longer to send
    // than a small one): only the latest selection and the latest list
    // are applied, whatever order their replies come back in.
    let selection = 0;
    let listing = 0;
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
            const ticket = ++listing;
            const jobs = await ctx.call(api.jobs());
            if (jobs && ticket === listing) {
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
        async refreshHeightMap() {
            const heightMap = await ctx.call(api.heightMap());
            if (heightMap) {
                store.set({ heightMap });
            }
        },
        async selectJob(id) {
            const ticket = ++selection;
            if (id === null) {
                store.set({ job: null });
                return;
            }
            const job = await ctx.call(api.job(id));
            if (job && ticket === selection) {
                store.set({ job });
            }
        },
        async reloadJob(id) {
            // Not a selection of its own: it loses to any selection made
            // while it is under way, and to a job picked since.
            const ticket = selection;
            const job = await ctx.call(api.job(id));
            if (job && ticket === selection && store.get().job?.id === id) {
                store.set({ job });
            }
        },
    };
    return ctx;
}

function sameProfile(a: Profile | undefined, b: Profile | undefined): boolean {
    if (a === undefined || b === undefined) {
        return a === b;
    }
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof Profile>;
    return [...keys].every((key) => a[key] === b[key]);
}

/**
 * The machine's settings may be other than the page last read: it has just
 * connected, it is another machine, or its profile (which the backend reads
 * from the settings) moved, as it does after a setting typed at the console
 * or changed from another page.
 */
export function settingsMayHaveChanged(before: Snapshot, after: Snapshot): boolean {
    if (!after.connected) {
        return false;
    }
    return !before.connected || before.url !== after.url || !sameProfile(before.profile, after.profile);
}

/** Puts one event of the feed into the store. */
export function applyEvent(ctx: Ctx, event: WsEvent): void {
    const store = ctx.store;
    switch (event.type) {
        case "state": {
            const before = store.get().snapshot;
            store.set({ snapshot: event.data, progress: event.data.run });
            // Only on a change: the settings panel is rebuilt from every
            // fresh copy, which must not happen at the frame rate.
            if (settingsMayHaveChanged(before, event.data)) {
                void ctx.refreshSettings();
            }
            break;
        }
        case "console":
            appendConsole(store, event.data);
            break;
        case "progress":
            store.set({ progress: event.data });
            break;
        case "heightmap":
            store.set({ heightMap: event.data });
            break;
        case "message":
            ctx.toast(event.data.level, event.data.text);
            break;
    }
}

/** Everything the page needs after a (re)connect of the event feed. */
async function refreshAll(ctx: Ctx): Promise<void> {
    await Promise.all([ctx.refreshState(), ctx.refreshPorts(), ctx.refreshJobs(), ctx.refreshHeightMap()]);
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
    feed.onEvent((event) => applyEvent(ctx, event));

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
    mountHeightMap(panel("heightmap"), ctx);
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
