import { afterEach, expect, test } from "bun:test";
import { mountOverview, pageNote } from "../src/views/overview.ts";
import { PAGES } from "../src/views/tabs.ts";
import { connected, setup } from "./harness.ts";

afterEach(() => {
    document.body.replaceChildren();
    document.getElementById("app")?.removeAttribute("data-page");
    localStorage.removeItem("spinny.page");
});

test("a card for every other page, each with a drawing and a tooltip, showing its page when pressed", () => {
    const { ctx, root } = setup();
    const app = document.createElement("div");
    app.id = "app";
    document.body.append(app);
    mountOverview(root, ctx);
    const cards = Array.from(root.querySelectorAll<HTMLButtonElement>(".overview-card"));
    expect(cards.map((card) => card.dataset["page"])).toEqual(PAGES.map((page) => page.id).filter((id) => id !== "overview"));
    for (const card of cards) {
        expect(card.title).not.toBe("");
        expect(card.querySelector("svg.overview-drawing path, svg.overview-drawing rect, svg.overview-drawing circle")).not.toBeNull();
    }
    cards.find((card) => card.dataset["page"] === "pnp")!.click();
    expect(app.getAttribute("data-page")).toBe("pnp");
    app.remove();
});

test("a card says what its page holds now, and follows the store", () => {
    const { ctx, root, store } = setup();
    mountOverview(root, ctx);
    const note = (page: string): string => root.querySelector(`.overview-card[data-page="${page}"] .overview-note`)!.textContent ?? "";
    store.set({ jobs: [], snapshot: { ...store.get().snapshot, connected: false } });
    expect(note("jobs")).toBe("0 jobs");
    expect(note("connection")).toBe("nothing connected");
    store.set({ snapshot: connected({}, { url: "socket://127.0.0.1:2323" }), pending: { "machine-file": 2 } });
    expect(note("connection")).toBe("connected: socket://127.0.0.1:2323");
    expect(note("config")).toBe("2 edits not applied");
    // A page with nothing to say shows no note.
    expect((root.querySelector(`.overview-card[data-page="cam"] .overview-note`) as HTMLElement).hidden).toBe(true);
});

test("a run under way is named with how far it got", () => {
    const { store } = setup();
    const state = store.get();
    const jobs = [{ ...({} as typeof state.jobs[number]), id: "a1", name: "board" }];
    const progress = { job: "a1", state: "running" as const, sent: 60, acked: 50, total: 200, seconds: 3, estimate: 9, group: 0 };
    expect(pageNote("jobs", { ...state, jobs, progress })).toBe("1 job; running board, 25%");
    expect(pageNote("jobs", { ...state, jobs, progress: { ...progress, state: "hold" } })).toBe("1 job; holding board, 25%");
    expect(pageNote("jobs", { ...state, jobs, progress: { ...progress, state: "done" } })).toBe("1 job");
});

test("the plugins card counts the plugins on", () => {
    const { store } = setup();
    const plugin = { id: "a", name: "a", description: "", made_by: "auto" as const, enabled: true, changed: false, hash: "", size: 1, modified: "" };
    expect(pageNote("plugins", { ...store.get(), plugins: [] })).toBe("");
    expect(pageNote("plugins", { ...store.get(), plugins: [plugin, { ...plugin, id: "b", enabled: false }] })).toBe("1 of 2 plugins on");
});
