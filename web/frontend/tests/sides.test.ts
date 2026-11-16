import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { at } from "./harness.ts";
import { addressFor, browserTakes, parseTarget, readAddress, targetText } from "../src/sides.ts";
import { initialState, Store, type AppState } from "../src/state.ts";
import { channelName, peerFor, TabSync, type ChannelLike, type PeerInfo, type SyncMessage } from "../src/tabsync.ts";
import { shareAt, shareForKey } from "../src/views/split.ts";
import {
    isSplit,
    mountTabs,
    PAGES,
    pagesOf,
    parseSidePages,
    parseSplitPrefs,
    readPage,
    setSplit,
    SIDE_PAGES_KEY,
    showPage,
    showSide,
    shownOn,
    sideKey,
    sideOf,
    SPLIT_KEY,
    SPLIT_MAX,
    SPLIT_MIN,
    SPLIT_SHARE,
} from "../src/views/tabs.ts";

describe("addresses", () => {
    test("an address names a side, a page, a target and the split; anything else is none", () => {
        expect(readAddress("?mock=1&side=setup&page=config&split=1", "#machine-file/polar-laser")).toEqual({
            side: "setup",
            page: "config",
            target: { panel: "machine-file", detail: "polar-laser" },
            split: true,
        });
        expect(readAddress("?side=sideways", "")).toEqual({ side: null, page: null, target: null, split: null });
        // A hash that is no panel's id is no target.
        expect(readAddress("", "#").target).toBeNull();
        expect(readAddress("", "#9lives").target).toBeNull();
        expect(readAddress("", "#facts/head.offset").target).toEqual({ panel: "facts", detail: "head.offset" });
    });

    test("a link keeps the backend's parameters and replaces the address's own", () => {
        const here = { pathname: "/", search: "?mock=1&api=http%3A%2F%2Fpi%3A8000&side=use&page=jobs&split=0" };
        const href = addressFor(here, { side: "setup", page: "facts", target: { panel: "facts", detail: "head.offset" } });
        expect(href).toBe("/?mock=1&api=http%3A%2F%2Fpi%3A8000&side=setup&page=facts#facts/head.offset");
        expect(addressFor(here, {})).toBe("/?mock=1&api=http%3A%2F%2Fpi%3A8000");
        expect(addressFor({ pathname: "/", search: "" }, {})).toBe("/");
    });

    test("a target with spaces or a hash in its detail comes back as it went", () => {
        const target = { panel: "machine-file", detail: "my file #2" };
        const href = addressFor({ pathname: "/", search: "" }, { target });
        const hash = href.slice(href.indexOf("#"));
        expect(readAddress("", hash).target).toEqual(target);
        expect(targetText(parseTarget("facts")!)).toBe("facts");
    });

    test("the browser takes a click with a modifier or another button: a tab of its own", () => {
        const click = { button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false };
        expect(browserTakes(click)).toBe(false);
        expect(browserTakes({ ...click, ctrlKey: true })).toBe(true);
        expect(browserTakes({ ...click, button: 1 })).toBe(true);
        expect(browserTakes({ ...click, shiftKey: true })).toBe(true);
    });
});

describe("the sides' pages", () => {
    test("every page is on one side, the Use side's first", () => {
        expect(pagesOf("use")).toEqual(["home", "job", "run"]);
        expect(pagesOf("setup")).toEqual(["facts", "machines", "cameras", "cam", "ui"]);
        expect(PAGES.every((page) => sideOf(page.id) === page.side)).toBe(true);
    });

    test("each side remembers a page of its own; anything else is the side's first", () => {
        expect(parseSidePages(JSON.stringify({ use: "run", setup: "machines" }))).toEqual({ use: "run", setup: "machines" });
        // A page of the other side, or junk.
        expect(parseSidePages(JSON.stringify({ use: "machines", setup: "job" }))).toEqual({ use: "job", setup: "facts" });
        expect(parseSidePages("not json")).toEqual({ use: "job", setup: "facts" });
        // An old name opens the area its panels went to, on its side.
        expect(parseSidePages(JSON.stringify({ use: "pnp", setup: "config" }))).toEqual({ use: "run", setup: "machines" });
        expect(parseSidePages(JSON.stringify({ use: "machine", setup: "plugins" }))).toEqual({ use: "job", setup: "ui" });
    });

    test("the split's share is held to its limits", () => {
        expect(parseSplitPrefs(null)).toEqual({ on: false, share: SPLIT_SHARE });
        expect(parseSplitPrefs(JSON.stringify({ on: true, share: 0.99 }))).toEqual({ on: true, share: SPLIT_MAX });
        expect(parseSplitPrefs(JSON.stringify({ on: 1, share: -3 }))).toEqual({ on: false, share: SPLIT_MIN });
    });

    test("the handle's share follows the pointer and the keys, within the limits", () => {
        expect(shareAt(500, 0, 1000)).toBe(0.5);
        expect(shareAt(10, 0, 1000)).toBe(SPLIT_MIN);
        expect(shareAt(990, 0, 1000)).toBe(SPLIT_MAX);
        expect(shareAt(5, 0, 0)).toBe(SPLIT_SHARE);
        expect(shareForKey("ArrowLeft", 0.5)).toBeCloseTo(0.48);
        expect(shareForKey("ArrowRight", SPLIT_MAX)).toBe(SPLIT_MAX);
        expect(shareForKey("Enter", 0.3)).toBe(SPLIT_SHARE);
        expect(shareForKey("a", 0.3)).toBeNull();
    });

    test("\\ swaps the sides and | splits them, never while typing or with a modifier", () => {
        const key = (key: string, target: EventTarget | null = document.body, extra: Partial<KeyboardEvent> = {}): KeyboardEvent => {
            const event = new KeyboardEvent("keydown", { key, ...extra });
            Object.defineProperty(event, "target", { value: target });
            return event;
        };
        expect(sideKey(key("\\"))).toBe("swap");
        expect(sideKey(key("|"))).toBe("split");
        expect(sideKey(key("\\", document.createElement("input")))).toBeNull();
        expect(sideKey(key("\\", document.body, { ctrlKey: true }))).toBeNull();
        expect(sideKey(key("s"))).toBeNull();
    });
});

/** The page's frame as index.html has it: the bar, the two panes and a page of each side. */
function frame(): HTMLElement {
    document.body.innerHTML = `
        <div id="app">
            <nav id="tabs" class="tabs"></nav>
            <div id="pane-use" class="pane" data-side="use">
                ${pagesOf("use").map((id) => `<main id="page-${id}" class="page"><div class="column"><section id="panel-${id}" class="panel"></section></div></main>`).join("")}
            </div>
            <div id="pane-divider" class="pane-divider"></div>
            <div id="pane-setup" class="pane" data-side="setup">
                ${pagesOf("setup").map((id) => `<main id="page-${id}" class="page"><div class="column"><section id="panel-${id}" class="panel"></section></div></main>`).join("")}
            </div>
        </div>`;
    return document.getElementById("app")!;
}

const up = (): string[] => Array.from(document.querySelectorAll("main.page[data-up]")).map((node) => node.id);
const panesUp = (): string[] => Array.from(document.querySelectorAll(".pane[data-up]")).map((node) => node.id);

describe("showing the sides", () => {
    beforeEach(() => {
        localStorage.clear();
        at("/");
    });
    afterEach(() => {
        setSplit(false);
        document.body.innerHTML = "";
    });

    test("a page shows in its side's pane, that side in front, the other folded with the page it last showed", () => {
        const app = frame();
        mountTabs(document.getElementById("tabs")!, new Store<AppState>(initialState(true)));
        showPage("run");
        expect(up()).toEqual(["page-run"]);
        expect(panesUp()).toEqual(["pane-use"]);
        expect(app.dataset["side"]).toBe("use");
        showPage("machines");
        expect(up()).toEqual(["page-machines"]);
        expect(panesUp()).toEqual(["pane-setup"]);
        expect(app.dataset["side"]).toBe("setup");
        expect(app.dataset["page"]).toBe("machines");
        // A swap brings back the page each side showed last.
        showSide("use");
        expect(up()).toEqual(["page-run"]);
        showSide("setup");
        expect(up()).toEqual(["page-machines"]);
        expect(JSON.parse(localStorage.getItem(SIDE_PAGES_KEY)!)).toEqual({ use: "run", setup: "machines" });
    });

    test("side by side both sides show, each its own page, and the bar opens both sides' tabs", () => {
        const app = frame();
        mountTabs(document.getElementById("tabs")!, new Store<AppState>(initialState(true)));
        showPage("job");
        showPage("facts");
        setSplit(true);
        expect(isSplit()).toBe(true);
        expect(app.hasAttribute("data-split")).toBe(true);
        expect(up()).toEqual(["page-job", "page-facts"]);
        expect(panesUp()).toEqual(["pane-use", "pane-setup"]);
        const lists = Array.from(document.querySelectorAll<HTMLElement>(".tabs-list"));
        expect(lists.map((list) => list.hidden)).toEqual([false, false]);
        const selected = Array.from(document.querySelectorAll(".tabs .tab[aria-selected='true']")).map((tab) => tab.getAttribute("data-page"));
        expect(selected).toEqual(["job", "facts"]);
        expect(JSON.parse(localStorage.getItem(SPLIT_KEY)!)).toEqual({ on: true, share: SPLIT_SHARE });
        // One at a time again: the side in front, the other's tabs folded behind its button.
        setSplit(false);
        expect(up()).toEqual(["page-facts"]);
        expect(lists.map((list) => list.hidden)).toEqual([true, false]);
    });

    test("the side's button swaps to it; the folded side counts its edits not applied", () => {
        frame();
        const store = new Store<AppState>(initialState(true));
        mountTabs(document.getElementById("tabs")!, store);
        showPage("job");
        const setupButton = document.querySelector<HTMLButtonElement>(".tabs-side[data-side='setup']")!;
        expect(setupButton.hasAttribute("data-open")).toBe(false);
        store.set({ pending: { "machine-file": 3 } });
        expect(setupButton.getAttribute("data-pending")).toBe("3");
        setupButton.click();
        expect(shownOn("setup")).toBe("facts");
        expect(up()).toEqual(["page-facts"]);
        expect(setupButton.hasAttribute("data-open")).toBe(true);
    });

    test("an address's side opens on the page that side showed last", () => {
        localStorage.setItem(SIDE_PAGES_KEY, JSON.stringify({ use: "job", setup: "machines" }));
        at("/?mock=1&side=setup");
        expect(readPage()).toBe("machines");
        at("/?mock=1&side=setup&page=ui");
        expect(readPage()).toBe("ui");
        at("/?page=machines");
        expect(readPage()).toBe("machines");
        // An old page's address opens the area its panels went to.
        at("/?page=pnp");
        expect(readPage()).toBe("run");
        at("/?page=config");
        expect(readPage()).toBe("machines");
    });
});

/** Tabs on one bus, as a BroadcastChannel joins them: each hears what the others post. */
class Bus {
    members: FakeChannel[] = [];
    log: SyncMessage[] = [];
    join(): FakeChannel {
        const channel = new FakeChannel(this);
        this.members.push(channel);
        return channel;
    }
}

class FakeChannel implements ChannelLike {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    closed = false;
    constructor(private readonly bus: Bus) {}
    postMessage(message: unknown): void {
        this.bus.log.push(message as SyncMessage);
        for (const other of this.bus.members) {
            if (other !== this && !other.closed) {
                other.onmessage?.({ data: structuredClone(message) });
            }
        }
    }
    close(): void {
        this.closed = true;
    }
}

function info(over: Partial<PeerInfo> = {}): Omit<PeerInfo, "id" | "seen"> {
    return { side: "use", split: false, pages: { use: "job", setup: "facts" }, visible: true, focused: 0, ...over };
}

describe("tabs that know of each other", () => {
    test("a link goes to a tab showing its side: one in view first, then the one focused last", () => {
        const peer = (id: string, over: Partial<PeerInfo>): PeerInfo => ({ ...info(over), id, seen: 0 });
        const peers = [peer("a", { side: "use" }), peer("b", { side: "setup", visible: false, focused: 9 }), peer("c", { side: "setup", visible: true, focused: 1 }), peer("d", { side: "setup", visible: false, focused: 20 })];
        expect(peerFor(peers, "setup")?.id).toBe("c");
        expect(peerFor(peers.filter((entry) => entry.id !== "c"), "setup")?.id).toBe("d");
        expect(peerFor([peer("e", { side: "use", split: true })], "setup")?.id).toBe("e");
        expect(peerFor([peers[0]!], "setup")).toBeNull();
    });

    test("a tab opening says hello, the others answer once, and nobody answers an answer", () => {
        const bus = new Bus();
        const use = new TabSync(bus.join(), () => info({ side: "use" }), () => true, () => 1, "use-tab");
        const setup = new TabSync(bus.join(), () => info({ side: "setup" }), () => true, () => 2, "setup-tab");
        use.announce();
        expect(setup.peers.get("use-tab")?.side).toBe("use");
        expect(use.peers.get("setup-tab")?.side).toBe("setup");
        expect(bus.log.map((message) => `${message.kind}:${message.from}`)).toEqual(["hello:use-tab", "hello:setup-tab"]);
        setup.leave();
        expect(use.peers.has("setup-tab")).toBe(false);
    });

    test("asked to go to a target, the tab goes and says so; a tab gone quiet is forgotten", async () => {
        const bus = new Bus();
        const went: string[] = [];
        const use = new TabSync(bus.join(), () => info({ side: "use" }), () => true, () => 1, "use-tab");
        const setupChannel = bus.join();
        new TabSync(setupChannel, () => info({ side: "setup" }), (target) => {
            went.push(target);
            return target.startsWith("facts");
        }, () => 2, "setup-tab");
        use.announce();
        expect(await use.send("setup-tab", "facts/head.offset", 50)).toBe(true);
        expect(went).toEqual(["facts/head.offset"]);
        // A target the other tab does not have: no answer, so the link goes here.
        expect(await use.send("setup-tab", "nowhere", 20)).toBe(false);
        expect(use.peers.has("setup-tab")).toBe(false);
        // Closed without a word.
        use.announce();
        setupChannel.closed = true;
        expect(await use.send("setup-tab", "facts", 20)).toBe(false);
    });

    test("pages of another backend or of the mock keep to a channel of their own", () => {
        expect(channelName("", false)).not.toBe(channelName("", true));
        expect(channelName("http://pi:8000", false)).not.toBe(channelName("", false));
    });
});
