import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ageText, countFacts, factsOf, measuredBy, sameValue, sourceText, type Fact } from "../src/facts.ts";
import { initialState, type AppState } from "../src/state.ts";
import type { CameraState, FindingEntry, PlacingState } from "../src/types.ts";
import { TabSync, type ChannelLike, type SyncMessage } from "../src/tabsync.ts";
import { mountFacts } from "../src/views/facts.ts";
import { goTo, linkTo, mountLinks } from "../src/views/links.ts";
import { mountSetupLinks } from "../src/views/setuplinks.ts";
import { mountTabs, pagesOf, setSplit, showPage, shownOn } from "../src/views/tabs.ts";
import { at, connected, setup } from "./harness.ts";

function camera(over: Partial<CameraState> = {}): CameraState {
    return {
        device: "/dev/video0", size: "1280x720", fps: 30, pcbv: "pcbv", side: "top", finish: "bare",
        offset: [0, 0], roll: 0, mm_per_px: 0,
        running: false, board: null, mark: null, frame: null, pose: null, routine: null,
        ...over,
    } as CameraState;
}

function finding(id: number, time: string, name: string, after: unknown, over: Partial<FindingEntry> = {}): FindingEntry {
    return {
        id, time, camera: "head", kind: "offset", text: "", marks: {}, machine: null,
        changes: [{ target: "head", name, label: name, before: null, after }],
        undo: "data", undoes: null, undone_by: null, undoable: true, why: null,
        ...over,
    };
}

function state(over: Partial<AppState> = {}): AppState {
    return { ...initialState(true), ...over };
}

const byId = (facts: Fact[], id: string): Fact => {
    const fact = facts.find((entry) => entry.id === id);
    if (!fact) {
        throw new Error(`no fact ${id}`);
    }
    return fact;
};

describe("what the machine knows", () => {
    test("with nothing connected the connection is missing and asks for someone", () => {
        const facts = factsOf(state());
        const link = byId(facts, "link.port");
        expect(link.source).toBe("missing");
        expect(link.need).not.toBeNull();
        expect(link.where).toBe("connection");
        expect(byId(facts, "link.file").value).toBe("none yet");
    });

    test("a camera offset a routine measured is measured then; changed since, it is the file's", () => {
        const measured = state({ camera: camera({ offset: [3.2, -1.05] }), findings: { entries: [finding(7, "2026-11-13T10:00:00", "offset", [3.2, -1.05])], count: 1 } });
        const offset = byId(factsOf(measured), "head.offset");
        expect(offset.source).toBe("measured");
        expect(offset.when).toBe("2026-11-13T10:00:00");
        expect(offset.need).toBeNull();
        expect(offset.value).toBe("3.20, -1.05 mm");
        // Typed over since: the routine's word no longer holds.
        const typed = state({ camera: camera({ offset: [3.3, -1.05] }), findings: measured.findings });
        expect(byId(factsOf(typed), "head.offset").source).toBe("file");
        // Never set: missing, with what to do.
        const none = byId(factsOf(state({ camera: camera() })), "head.offset");
        expect(none.source).toBe("missing");
        expect(none.need).toContain("measure");
        expect(none.where).toBe("steps/camera");
    });

    test("an undone result, or an undo as the newest word, is no measurement", () => {
        const entries = [finding(9, "2026-11-14T09:00:00", "offset", [1, 2], { kind: "undo" }), finding(8, "2026-11-13T09:00:00", "offset", [1, 2])];
        expect(measuredBy(entries, "head", "offset", [1, 2])).toBeNull();
        expect(measuredBy([finding(8, "t", "offset", [1, 2], { undone_by: 9 })], "head", "offset", [1, 2])).toBeNull();
        expect(measuredBy([finding(8, "t", "offset", [1, 2])], "head", "offset", [1, 2])?.id).toBe(8);
        expect(measuredBy([finding(8, "t", "offset", [1, 2])], "top", "offset", [1, 2])).toBeNull();
        expect(sameValue([1, 2.0000000000001], [1, 2])).toBe(true);
        expect(sameValue(0.0161, 0.0162)).toBe(false);
    });

    test("no camera set: one row says so, and the camera's other values are not listed", () => {
        const facts = factsOf(state({ camera: camera({ device: "" }) }));
        expect(byId(facts, "head.device").value).toBe("none");
        expect(facts.some((fact) => fact.id === "head.offset")).toBe(false);
    });

    test("a pick and place machine lists its cameras' places and what is missing of them", () => {
        const placing = {
            machine: "lumenpnp", name: "LumenPnP", document: { feeders: [{}, {}] }, angle: null, references: [], taken: {},
            camera: { position: null, height: null, mm_per_px: 0.02, roll: 0, mirror: true, runout: null },
            top: { offset: [12.5, -40.1], mm_per_px: 0, roll: 0, mirror: false },
            connected: true, url: "/dev/ttyACM1", lost: null, running: false, homed: false, position: null, progress: null, log: [],
        } as unknown as PlacingState;
        const facts = factsOf(state({ placing }));
        expect(byId(facts, "pnp.file").value).toBe("LumenPnP, 2 feeders, connected");
        expect(byId(facts, "pnp.homed").need).not.toBeNull();
        expect(byId(facts, "pnp.up").source).toBe("missing");
        expect(byId(facts, "pnp.up.scale").source).toBe("file");
        expect(byId(facts, "pnp.top.offset").value).toBe("12.50, -40.10 mm");
    });

    test("the counts split what is automatic from what a person set", () => {
        const connectedState = state({
            snapshot: connected(),
            ports: [{ url: "/dev/ttyACM0", spinny: true } as AppState["ports"][number]],
            settings: { values: {}, schema: [], host: { tolerance: 0.005, travel: 12 }, unsaved: ["r_rate"], controls_from: null },
            camera: camera({ offset: [1, 1] }),
            plugins: [],
        });
        const facts = factsOf(connectedState);
        expect(byId(facts, "link.port").source).toBe("detected");
        expect(byId(facts, "link.flash").need).not.toBeNull();
        expect(byId(facts, "motion.travel").value).toBe("H 12.00 mm");
        const counts = countFacts(facts);
        expect(counts.total).toBe(facts.length);
        expect(counts.automatic + counts.byHand + counts.defaults + counts.missing).toBe(counts.total);
        expect(counts.needs).toBe(1);
    });

    test("ages and sources read in a few words", () => {
        const now = Date.parse("2026-11-15T12:00:00");
        expect(ageText("2026-11-15T11:59:30", now)).toBe("just now");
        expect(ageText("2026-11-15T11:40:00", now)).toBe("20 min ago");
        expect(ageText("2026-11-15T07:00:00", now)).toBe("5 h ago");
        expect(ageText("2026-11-13T12:00:00", now)).toBe("2 d ago");
        expect(ageText("garbage", now)).toBe("");
        expect(sourceText({ source: "measured", when: "2026-11-13T12:00:00" }, now)).toBe("measured 2 d ago");
        expect(sourceText({ source: "file", when: null }, now)).toBe("in the file");
    });
});

/** The frame with the Checklist on the Setup side and two Use panels that depend on facts. */
function frame(): void {
    const page = (id: string, panels: string): string => `<main id="page-${id}" class="page"><div class="column">${panels}</div></main>`;
    const use = pagesOf("use").map((id) => page(id, id === "run"
        ? `<section id="camera-view" class="panel"><div class="panel-head"><h2>Camera view</h2></div></section><section id="machine" class="panel"><div class="panel-head"><h2>Machine</h2></div></section><section id="steps" class="panel"></section>`
        : "")).join("");
    const setupPages = pagesOf("setup").map((id) => page(id, id === "facts" ? `<section id="facts" class="panel"></section>` : id === "machines" ? `<section id="connection" class="panel"></section>` : "")).join("");
    document.body.innerHTML = `<div id="app"><nav id="tabs" class="tabs"></nav><div id="pane-use" class="pane" data-side="use">${use}</div><div id="pane-setup" class="pane" data-side="setup">${setupPages}</div><div id="toasts"></div></div>`;
}

describe("the Checklist and the links to it", () => {
    beforeEach(() => {
        localStorage.clear();
        at("/?mock=1");
        frame();
    });
    afterEach(() => {
        setSplit(false);
        document.body.innerHTML = "";
    });

    test("the list groups the facts, marks what needs someone, and shows a row a link names", () => {
        const { ctx, store } = setup();
        store.set({ camera: camera() });
        mountFacts(document.getElementById("facts")!, ctx);
        const rows = Array.from(document.querySelectorAll<HTMLElement>(".fact"));
        expect(rows.length).toBe(factsOf(store.get()).length);
        expect(document.querySelectorAll(".fact[data-need]").length).toBe(2);
        expect(document.querySelector(".facts-count")!.textContent).toBe("2 to do");
        const needs = Array.from(document.querySelectorAll<HTMLButtonElement>(".facts-filter button")).find((button) => button.textContent?.startsWith("Needs you"))!;
        needs.click();
        expect(document.querySelectorAll(".fact").length).toBe(2);
        // A link to a fact shows the whole list again, the row flashing.
        document.getElementById("facts")!.dispatchEvent(new CustomEvent("spinny:goto", { detail: "head.lens" }));
        expect(document.querySelectorAll(".fact").length).toBe(rows.length);
        expect(document.getElementById("fact-head.lens")!.classList.contains("flash")).toBe(true);
    });

    test("a link to a row not drawn yet (a tab opened at it) shows it once the state brings it", () => {
        const { ctx, store } = setup();
        mountFacts(document.getElementById("facts")!, ctx);
        document.getElementById("facts")!.dispatchEvent(new CustomEvent("spinny:goto", { detail: "head.offset" }));
        expect(document.getElementById("fact-head.offset")).toBeNull();
        store.set({ camera: camera() });
        expect(document.getElementById("fact-head.offset")!.classList.contains("flash")).toBe(true);
    });

    test("a Use panel's head links to the facts it runs on, counting what is missing", () => {
        const { ctx, store } = setup();
        store.set({ camera: camera() });
        mountTabs(document.getElementById("tabs")!, store);
        mountSetupLinks(ctx);
        const link = document.querySelector<HTMLAnchorElement>("#camera-view .setup-link")!;
        expect(link.textContent).toBe("Setup: 1 to do");
        expect(link.hasAttribute("data-need")).toBe(true);
        expect(link.getAttribute("href")).toBe("/?mock=1&side=setup&page=facts#facts/head.offset");
        // Measured: quiet again, and the tooltip says where it came from.
        store.set({ camera: camera({ offset: [2, 3] }), findings: { entries: [finding(1, "2026-11-15T08:00:00", "offset", [2, 3])], count: 1 } });
        expect(link.textContent).toBe("Setup");
        expect(link.hasAttribute("data-need")).toBe(false);
        expect(link.title).toContain("Offset from the tool: 2.00, 3.00 mm (measured");
        // The Machine panel runs on no fact while nothing is connected: no link.
        expect(document.querySelector<HTMLAnchorElement>("#machine .setup-link")!.hidden).toBe(true);
    });

    test("with no other tab, a link to the other side swaps this tab, and Back returns", async () => {
        const { ctx, store } = setup();
        mountTabs(document.getElementById("tabs")!, store);
        mountFacts(document.getElementById("facts")!, ctx);
        mountLinks(ctx, { apiBase: "", mock: true, channel: null });
        showPage("run");
        expect(await goTo({ panel: "facts", detail: "link.port" })).toBe("here");
        expect(document.getElementById("app")!.dataset["side"]).toBe("setup");
        expect(location.search).toContain("side=setup");
        expect(location.hash).toBe("#facts/link.port");
        // Back: the browser puts the address before the link back, then
        // tells the page; that entry noted the Run area.
        history.replaceState({ spinny: { page: "run" } }, "", "/?mock=1");
        window.dispatchEvent(new PopStateEvent("popstate", { state: { spinny: { page: "run" } } }));
        expect(shownOn("use")).toBe("run");
        expect(document.getElementById("app")!.dataset["side"]).toBe("use");
        // Moving on by the bar: the address no longer names the link's target.
        showPage("job");
        expect(location.hash).toBe("");
        expect(location.search).toBe("?mock=1");
    });

    test("side by side, a link shows its target in the other pane and swaps nothing", async () => {
        const { ctx, store } = setup();
        mountTabs(document.getElementById("tabs")!, store);
        mountLinks(ctx, { apiBase: "", mock: true, channel: null });
        showPage("run");
        setSplit(true);
        expect(await goTo({ panel: "connection", detail: null })).toBe("here");
        const up = Array.from(document.querySelectorAll("main.page[data-up]")).map((node) => node.id);
        expect(up).toEqual(["page-run", "page-machines"]);
    });

    test("with another tab showing the Setup side, a link goes there and this tab offers Show here", async () => {
        const { ctx, store } = setup();
        mountTabs(document.getElementById("tabs")!, store);
        const posted: SyncMessage[] = [];
        let other: TabSync | null = null;
        // The other tab, on the far end of a channel of two.
        const mine: ChannelLike = {
            onmessage: null,
            postMessage: (message) => {
                posted.push(message as SyncMessage);
                other?.hear(structuredClone(message));
            },
            close: () => {},
        };
        const sync = mountLinks(ctx, { apiBase: "", mock: true, channel: mine });
        const went: string[] = [];
        other = new TabSync({ onmessage: null, postMessage: (message) => mine.onmessage?.({ data: structuredClone(message) }), close: () => {} }, () => ({ side: "setup", split: false, pages: { use: "run", setup: "facts" }, visible: false, focused: 5 }), (target) => {
            went.push(target);
            return true;
        }, () => 0, "setup-tab");
        sync.announce();
        showPage("run");
        expect(await goTo({ panel: "facts", detail: "head.offset" })).toBe("tab");
        expect(went).toEqual(["facts/head.offset"]);
        // This tab stays where it was, and says where the target went.
        expect(document.getElementById("app")!.dataset["side"]).toBe("use");
        const toast = store.get().toasts.at(-1)!;
        expect(toast.text).toContain("Setup tab");
        expect(toast.action?.label).toBe("Show here");
        toast.action!.run();
        expect(document.getElementById("app")!.dataset["side"]).toBe("setup");
    });

    test("a link is a real link: the middle button and Ctrl are the browser's", () => {
        const { store } = setup();
        mountTabs(document.getElementById("tabs")!, store);
        showPage("run");
        const link = linkTo({ panel: "connection", detail: null }, "Connection", "open the Connection page");
        document.body.append(link);
        expect(link.getAttribute("href")).toBe("/?mock=1&side=setup&page=machines#connection");
        const ctrl = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
        link.dispatchEvent(ctrl);
        expect(ctrl.defaultPrevented).toBe(false);
        expect(document.getElementById("app")!.dataset["side"]).toBe("use");
        const plain = new MouseEvent("click", { bubbles: true, cancelable: true });
        link.dispatchEvent(plain);
        expect(plain.defaultPrevented).toBe(true);
    });
});
