// Entry point: picks the real backend or the in-page mock, wires the event
// feed into the store, and mounts the views.

import { errorText, HttpApi, type Api } from "./api.ts";
import { MockBackend } from "./mock/backend.ts";
import { appendConsole, autoClears, initialState, mergeAuto, noteAutoCleared, pendingTotal, pushToast, Store, withEntry, type AppState } from "./state.ts";
import type { MessageLevel, Profile, Snapshot, WsEvent } from "./types.ts";
import { mountTooltips } from "./tooltip.ts";
import { EventSocket, wsUrl, type EventFeed } from "./ws.ts";
import { mountAlign } from "./views/align.ts";
import { mountAuto } from "./views/auto.ts";
import { mountFocusBanner } from "./views/banner.ts";
import { mountCam } from "./views/cam.ts";
import { mountConfig } from "./views/config.ts";
import { mountVersion } from "./views/version.ts";
import { mountConsole } from "./views/console.ts";
import { into, type Ctx } from "./views/context.ts";
import { mountOpenPnpImport } from "./views/openpnpimport.ts";
import { mountDro } from "./views/dro.ts";
import { mountHeightMap } from "./views/heightmap.ts";
import { mountJobJson } from "./views/jobjson.ts";
import { mountJobs } from "./views/jobs.ts";
import { mountJog } from "./views/jog.ts";
import { mountLaser } from "./views/laser.ts";
import { mountMarkers } from "./views/markers.ts";
import { mountMill } from "./views/mill.ts";
import { mountConnection } from "./views/connection.ts";
import { mountPageSettings } from "./views/pagesettings.ts";
import { mountSearch } from "./views/search.ts";
import { mountPanels } from "./views/panels.ts";
import { mountPnp } from "./views/pnp.ts";
import { mountPreviewPanel } from "./views/previewpanel.ts";
import { mountStatusBar } from "./views/statusbar.ts";
import { mountSteps } from "./views/steps.ts";
import { mountTabs } from "./views/tabs.ts";
import { mountToasts } from "./views/toasts.ts";
import { mountVision } from "./views/vision.ts";

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
                toast("error", errorText(error));
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
            await into(ctx, "ports", api.ports());
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
            await into(ctx, "settings", api.settings());
        },
        async refreshHeightMap() {
            await into(ctx, "heightMap", api.heightMap());
        },
        async refreshCamera() {
            await into(ctx, "camera", api.camera());
        },
        async refreshAlign() {
            await into(ctx, "align", api.align());
        },
        async refreshPnp() {
            await into(ctx, "pnp", api.pnp());
        },
        async refreshPlacing() {
            await into(ctx, "placing", api.placingState());
        },
        async refreshMarkers() {
            await into(ctx, "markers", api.markers());
        },
        async refreshAuto() {
            const clears = autoClears();
            const auto = await ctx.call(api.autoConversation());
            // A reply asked for before a New chat is not put back after it.
            if (auto && clears === autoClears()) {
                mergeAuto(store, auto);
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
            // Only on a change: the Settings list on the Config tab is
            // redrawn from every fresh copy, which must not happen at the
            // frame rate.
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
        case "camera":
            store.set({ camera: event.data });
            break;
        case "pnp":
            store.set({ pnp: event.data });
            break;
        case "placing":
            store.set({ placing: event.data });
            break;
        case "markers":
            store.set({ markers: event.data.markers });
            break;
        case "camlog":
            store.set({ camlog: event.data });
            break;
        case "searchlog":
            store.set({ searchlog: event.data });
            break;
        case "auto": {
            const before = store.get().auto;
            if (event.data.cleared) {
                noteAutoCleared();
            }
            const entries = event.data.cleared ? [] : withEntry(before?.entries ?? [], event.data.entry);
            store.set({ auto: { entries, busy: event.data.busy } });
            // A tool that made or changed a job: the Jobs and Plot tabs list them again.
            const entry = event.data.entry;
            if (entry && entry.role === "tool" && entry.done && (entry.changed ?? []).includes("jobs")) {
                // The list first: it lets go of a selected job the tool
                // deleted, which is then not asked for.
                void ctx.refreshJobs().then(() => {
                    const selected = store.get().job;
                    if (selected) {
                        void ctx.reloadJob(selected.id);
                    }
                });
            }
            // A turn has ended: the whole of it as the backend has it, in
            // case the feed dropped one of its events on the way.
            if (before?.busy && !event.data.busy && !event.data.cleared) {
                void ctx.refreshAuto();
            }
            break;
        }
        case "align":
            store.set({ align: event.data });
            // An alignment applied has moved the job: the selected copy is stale.
            if (event.data.job !== null && event.data.marks.length === 0 && store.get().job?.id === event.data.job) {
                void ctx.reloadJob(event.data.job);
            }
            break;
    }
}

/** Everything the page needs after a (re)connect of the event feed. */
async function refreshAll(ctx: Ctx): Promise<void> {
    await Promise.all([ctx.refreshState(), ctx.refreshPorts(), ctx.refreshJobs(), ctx.refreshHeightMap(), ctx.refreshCamera(), ctx.refreshAlign(), ctx.refreshPnp(), ctx.refreshPlacing(), ctx.refreshMarkers(), ctx.refreshAuto()]);
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
    mountConnection(panel("connection"), ctx);
    mountFocusBanner(panel("status"), ctx);
    const tabTools = mountTabs(panel("tabs"), store);
    mountSteps(panel("steps"), ctx);
    mountDro(panel("dro"), ctx);
    mountJog(panel("jog"), ctx);
    mountLaser(panel("laser"), ctx);
    mountMarkers(panel("markers"), ctx);
    mountJobs(panel("jobs"), ctx, panel("run"));
    mountHeightMap(panel("heightmap"), ctx);
    mountPreviewPanel(panel("preview"), ctx);
    mountJobJson(panel("jobjson"), ctx);
    mountVision(panel("camera"), ctx, panel("camera-view"));
    mountAlign(panel("align"), ctx);
    mountConsole(panel("console"), ctx);
    // The Plot page: the position, the jog and the spindle again beside
    // its operations, the markers, and a preview of the operation planned.
    mountDro(panel("mill-dro"), ctx);
    mountJog(panel("mill-jog"), ctx, "plot");
    mountLaser(panel("mill-spindle"), ctx);
    mountMarkers(panel("mill-markers"), ctx);
    mountPreviewPanel(panel("mill-preview"), ctx, (state) => state.millPlan ?? state.job, (state) => state.millDims);
    mountMill({ operation: panel("mill-operation"), run: panel("mill-run") }, ctx);
    // The CAM page has a preview of its own, since the panels of the
    // Jobs page are not shown beside it.
    mountCam(panel("cam"), ctx, panel("cam-file"));
    mountPreviewPanel(panel("cam-preview"), ctx);
    // The PNP page: the parts, the board, the jog, the cameras, the nozzle,
    // and a G-code machine's panels.
    mountPnp({
        steps: panel("pnp-steps"),
        parts: panel("pnp-parts"),
        board: panel("pnp-board"),
        camera: panel("pnp-camera"),
        nozzle: panel("pnp-nozzle"),
        head: panel("pnp-head"),
        jog: panel("pnp-jog"),
        view: panel("pnp-view"),
        topView: panel("pnp-top-view"),
        top: panel("pnp-top"),
        refs: panel("pnp-refs"),
        feeders: panel("pnp-feeders"),
        run: panel("pnp-run"),
    }, ctx);
    // The Auto page: the conversation with a model that makes jobs and
    // other data through the backend's tools, and which model it is.
    mountAuto({ chat: panel("auto-chat"), about: panel("auto-about") }, ctx);
    // The Config page: the machine files beside the list of every key a
    // file can set, the file's value next to the board's.
    mountConfig(panel("machine-file"), ctx, panel("settings"));
    mountOpenPnpImport(panel("openpnp-import"), ctx);
    // The release running and its update from GitHub.
    mountVersion(panel("version"), ctx);
    mountToasts(panel("toasts"), ctx);
    // Last, once every view has drawn its panel's head: the layout layer
    // adds its controls to the heads and puts the panels where the
    // operator left them.
    mountPageSettings(tabTools, mountPanels(panel("app")));
    mountSearch(tabTools);
    mountTooltips();

    // Leaving with edits not applied asks first; the browser words it.
    window.addEventListener("beforeunload", (event) => {
        if (pendingTotal(store.get().pending) > 0) {
            event.preventDefault();
            event.returnValue = "";
        }
    });

    if (mock) {
        ctx.toast("info", "mock backend: nothing here touches the machine");
    }
    feed.start();
    void refreshAll(ctx);
}

if (typeof document !== "undefined" && document.getElementById("app")) {
    main();
}
