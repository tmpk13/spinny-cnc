import { describe, expect, test } from "bun:test";

import type { Api } from "../src/api.ts";
import { applyEvent, createContext, settingsMayHaveChanged } from "../src/main.ts";
import { MockBackend } from "../src/mock/backend.ts";
import { button, numberField, setLocked } from "../src/dom.ts";
import { Store, appendConsole, initialState, pushToast, type AppState } from "../src/state.ts";
import type { Job, JobSummary, Machine, Snapshot, WsEvent } from "../src/types.ts";
import { mountConsole, writesSettings } from "../src/views/console.ts";
import { droText, mountDro } from "../src/views/dro.ts";
import { mountJobs, progressText } from "../src/views/jobs.ts";
import { keyAction, mountJog } from "../src/views/jog.ts";
import { confirmSettle } from "../src/confirm.ts";
import { MAX_BEAM_MS, mountLaser } from "../src/views/laser.ts";
import { changedValues, mountSettings } from "../src/views/settings.ts";
import { mountPreviewPanel } from "../src/views/previewpanel.ts";
import { mountStatusBar } from "../src/views/statusbar.ts";
import { mountToasts } from "../src/views/toasts.ts";

function machine(overrides: Partial<Machine> = {}): Machine {
    return {
        state: "Idle",
        alarm: null,
        joint: { r: 12.345, a: 90, z: 0 },
        board: { x: 0, y: 12.345 },
        rate: 0,
        laser: 0,
        mode: "dyn",
        enabled: true,
        queue: { planner: 32, lines: 16 },
        ...overrides,
    };
}

function connected(overrides: Partial<Machine> = {}): Snapshot {
    return { connected: true, url: "/dev/ttyACM0", firmware: { version: "0.1.0", lines: 16, blocks: 32 }, machine: machine(overrides), run: null };
}

/** An API that records calls and answers with empty results. */
function recordingApi(): { api: Api; calls: { name: string; args: unknown[] }[]; backend: MockBackend } {
    const calls: { name: string; args: unknown[] }[] = [];
    const backend = new MockBackend({ timers: false });
    const api = new Proxy(backend, {
        get(target, name: string) {
            const value = (target as unknown as Record<string, unknown>)[name];
            if (typeof value !== "function") {
                return value;
            }
            return (...args: unknown[]) => {
                calls.push({ name, args });
                return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
        },
    }) as unknown as Api;
    return { api, calls, backend };
}

function setup() {
    const store = new Store<AppState>(initialState(true));
    const { api, calls, backend } = recordingApi();
    const ctx = createContext(api, store);
    const root = document.createElement("section");
    document.body.appendChild(root);
    return { store, api, calls, ctx, root, backend };
}

function click(root: ParentNode, label: string): void {
    const button = Array.from(root.querySelectorAll("button")).find((b) => b.textContent === label);
    if (!button) {
        throw new Error(`no button ${label}`);
    }
    button.click();
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A button of the open confirm dialog. */
function dialogButton(label: string): HTMLButtonElement {
    const dialog = document.querySelector("dialog[open]");
    if (!dialog) {
        throw new Error("no confirm dialog");
    }
    const found = Array.from(dialog.querySelectorAll("button")).find((b) => b.textContent === label);
    if (!found) {
        throw new Error(`no dialog button ${label}`);
    }
    return found;
}

/** A resolvable promise, to hold a request open during a test. */
function gate<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve: (value: T) => void = () => undefined;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

describe("buttons", () => {
    test("a button stays disabled until its request returns, and the lock is kept apart", async () => {
        let calls = 0;
        const open = gate<void>();
        const node = button("Go", () => {
            calls += 1;
            return open.promise;
        });
        node.click();
        node.click();
        node.click();
        expect(calls).toBe(1);
        expect(node.disabled).toBe(true);
        setLocked(node, true);
        open.resolve();
        await settle();
        expect(node.disabled).toBe(true);
        setLocked(node, false);
        expect(node.disabled).toBe(false);
        node.click();
        expect(calls).toBe(2);
    });

    test("a synchronous handler leaves the button alone", () => {
        let calls = 0;
        const node = button("Clear", () => {
            calls += 1;
        });
        node.click();
        node.click();
        expect(calls).toBe(2);
        expect(node.disabled).toBe(false);
    });
});

describe("dro", () => {
    test("text for a machine and for none", () => {
        expect(droText(machine())).toEqual({ r: "12.345", a: "90.0000", z: "0.000", h: null, x: "0.000", y: "12.345", laser: "0.0%", rate: "0", mode: "dyn", queue: "32/16", motors: "on", probe: null });
        expect(droText(machine({ joint: { r: 1, a: 2, z: -0.125 } })).z).toBe("-0.125");
        expect(droText(null).r).toBe("-.---");
        expect(droText(null).z).toBe("-.---");
    });

    test("renders the snapshot", () => {
        const { store, ctx, root } = setup();
        mountDro(root, ctx);
        store.set({ snapshot: connected({ laser: 500, rate: 399.6, joint: { r: 12.345, a: 90, z: 0.5 } }) });
        expect(root.querySelector('[data-dro="r"]')?.textContent).toBe("12.345");
        expect(root.querySelector('[data-dro="a"]')?.textContent).toBe("90.0000");
        expect(root.querySelector('[data-dro="z"]')?.textContent).toBe("0.500");
        expect(root.querySelector('[data-dro="laser"]')?.textContent).toBe("50.0%");
        expect(root.querySelector('[data-dro="rate"]')?.textContent).toBe("400");
        expect(root.classList.contains("laser-on")).toBe(true);
    });

    test("an active-low output shows the beam's power, not its pin", () => {
        const inverted = { values: { laser_invert: 1 }, schema: [], host: { tolerance: 0.01 } };
        expect(droText(machine({ laser: 1000 }), inverted).laser).toBe("0.0%");
        expect(droText(machine({ laser: 200 }), inverted).laser).toBe("80.0%");
        expect(droText(machine({ laser: 200 }), { ...inverted, values: { laser_invert: 0 } }).laser).toBe("20.0%");
        const { store, ctx, root } = setup();
        mountDro(root, ctx);
        store.set({ snapshot: connected({ laser: 1000 }), settings: inverted });
        expect(root.querySelector('[data-dro="laser"]')?.textContent).toBe("0.0%");
        expect(root.classList.contains("laser-on")).toBe(false);
        store.set({ snapshot: connected({ laser: 0 }) });
        expect(root.querySelector('[data-dro="laser"]')?.textContent).toBe("100.0%");
        expect(root.classList.contains("laser-on")).toBe(true);
    });
});

describe("context", () => {
    test("a backend with no run in it clears a run the page remembered", async () => {
        const { api, backend } = recordingApi();
        const store = new Store<AppState>(initialState(false));
        const ctx = createContext(api, store);
        store.set({ progress: { job: "j1", state: "running", sent: 3, acked: 1, total: 9, seconds: 1, estimate: 5, group: 0 } });
        // Before the feed is open the HTTP snapshot is all there is, and its
        // null run says the backend restarted underneath the page.
        expect(backend.snapshot().run).toBeNull();
        await ctx.refreshState();
        expect(store.get().progress).toBeNull();
        // Once the feed is open its frames carry the snapshot, and a reply
        // from before the latest frame must not step it back.
        store.set({ link: "open", progress: { job: "j2", state: "done", sent: 9, acked: 9, total: 9, seconds: 5, estimate: 5, group: 0 } });
        await ctx.refreshState();
        expect(store.get().progress?.job).toBe("j2");
    });
});

describe("settings follow the machine", () => {
    test("a state frame reloads the settings when the machine or its profile changes, not on every frame", async () => {
        const { store, ctx, calls, api } = setup();
        await api.connect("/dev/ttyACM0");
        const profile = { kinematics: "polar" as const, tool: "laser" as const, h_axis: false, r_max: 60, z_max: 5 };
        const frame = (overrides: Partial<Snapshot> = {}): WsEvent => ({ type: "state", data: { ...connected(), profile, ...overrides } });
        const settingsCalls = (): number => calls.filter((c) => c.name === "settings").length;
        applyEvent(ctx, frame());
        await settle();
        expect(settingsCalls()).toBe(1);
        applyEvent(ctx, frame());
        applyEvent(ctx, frame({ machine: machine({ rate: 10 }) }));
        await settle();
        expect(settingsCalls()).toBe(1);
        // $r_max=40 typed at the console, or on another page.
        applyEvent(ctx, frame({ profile: { ...profile, r_max: 40 } }));
        await settle();
        expect(settingsCalls()).toBe(2);
        // No machine: nothing to ask.
        applyEvent(ctx, frame({ connected: false, url: null, machine: null }));
        await settle();
        expect(settingsCalls()).toBe(2);
        expect(store.get().snapshot.connected).toBe(false);
        expect(settingsMayHaveChanged(connected(), { ...connected(), url: "/dev/ttyACM1" })).toBe(true);
        expect(settingsMayHaveChanged(connected(), connected())).toBe(false);
    });

    test("the preview's reach follows the profile of every frame", () => {
        const { store, ctx, root } = setup();
        const preview = mountPreviewPanel(root, ctx);
        const reach = (): number => (preview as unknown as { rMax: number }).rMax;
        store.set({ settings: { values: { r_max: 60 }, schema: [], host: { tolerance: 0.005 } } });
        expect(reach()).toBe(60);
        store.set({ snapshot: { ...connected(), profile: { kinematics: "polar", tool: "laser", h_axis: false, r_max: 40, z_max: 0 } } });
        expect(reach()).toBe(40);
        // A cartesian profile reaches the preview whole: its limit is a box.
        store.set({ snapshot: { ...connected(), profile: { kinematics: "cartesian", tool: "spindle", h_axis: true, r_max: 50, z_max: 30 } } });
        expect(preview.getLimits()).toEqual({ kinematics: "cartesian", r_max: 50, z_max: 30 });
        preview.dispose();
    });
});

describe("settings fold", () => {
    test("the settings panel opens by default and remembers being folded", () => {
        localStorage.removeItem("spinny.settings.open");
        const first = setup();
        mountSettings(first.root, first.ctx);
        const fold = first.root.querySelector("details.panel-fold") as HTMLDetailsElement;
        expect(fold.open).toBe(true);
        expect(fold.querySelector("summary h2")?.textContent).toBe("Settings");
        fold.open = false;
        fold.dispatchEvent(new Event("toggle"));
        const second = setup();
        mountSettings(second.root, second.ctx);
        expect((second.root.querySelector("details.panel-fold") as HTMLDetailsElement).open).toBe(false);
        localStorage.removeItem("spinny.settings.open");
    });
});

describe("job selection", () => {
    /** Holds each job request open until the test answers it. */
    function heldJobs(api: Api): Map<string, (job: Job) => void> {
        const pending = new Map<string, (job: Job) => void>();
        (api as unknown as { job: (id: string) => Promise<Job> }).job = (id: string) => new Promise<Job>((resolve) => {
            pending.set(id, resolve);
        });
        return pending;
    }
    const stub = (id: string): Job => ({ id, name: id } as unknown as Job);

    test("the last job picked stays selected, whatever order the replies come in", async () => {
        const { store, ctx, api } = setup();
        const pending = heldJobs(api);
        const big = ctx.selectJob("big");
        const small = ctx.selectJob("small");
        pending.get("small")!(stub("small"));
        await small;
        expect(store.get().job?.id).toBe("small");
        pending.get("big")!(stub("big"));
        await big;
        expect(store.get().job?.id).toBe("small");
        // Clearing the selection wins over a reply still on its way.
        const late = ctx.selectJob("big");
        await ctx.selectJob(null);
        pending.get("big")!(stub("big"));
        await late;
        expect(store.get().job).toBeNull();
    });

    test("a reload after a change to a job does not take the selection back from the job picked since", async () => {
        const { store, ctx, api } = setup();
        const pending = heldJobs(api);
        const first = ctx.selectJob("a");
        pending.get("a")!(stub("a"));
        await first;
        // A group field of job a commits on blur, as job b is clicked.
        const reload = ctx.reloadJob("a");
        const pick = ctx.selectJob("b");
        pending.get("b")!(stub("b"));
        await pick;
        pending.get("a")!(stub("a"));
        await reload;
        expect(store.get().job?.id).toBe("b");
        // With nothing picked meanwhile the reload is applied.
        const fresh = { ...stub("b"), name: "b again" } as Job;
        const again = ctx.reloadJob("b");
        pending.get("b")!(fresh);
        await again;
        expect(store.get().job).toBe(fresh);
    });

    test("an older job list does not replace a newer one or clear the selection", async () => {
        const { store, ctx, api } = setup();
        const lists: ((jobs: JobSummary[]) => void)[] = [];
        (api as unknown as { jobs: () => Promise<JobSummary[]> }).jobs = () => new Promise<JobSummary[]>((resolve) => {
            lists.push(resolve);
        });
        store.set({ job: stub("new") });
        const older = ctx.refreshJobs();
        const newer = ctx.refreshJobs();
        const summary = (id: string): JobSummary => ({ id, name: id } as unknown as JobSummary);
        lists[1]!([summary("old"), summary("new")]);
        await newer;
        lists[0]!([summary("old")]);
        await older;
        expect(store.get().jobs.map((job) => job.id)).toEqual(["old", "new"]);
        expect(store.get().job?.id).toBe("new");
    });
});

describe("jog", () => {
    test("keys map to board jogs and cancel", () => {
        expect(keyAction("ArrowLeft")).toEqual({ dx: -1, dy: 0 });
        expect(keyAction("ArrowUp")).toEqual({ dx: 0, dy: 1 });
        expect(keyAction("Escape")).toBe("cancel");
        expect(keyAction("a")).toBeNull();
    });

    test("pad and axis buttons send the right requests", async () => {
        const { store, ctx, root, calls, api } = setup();
        await api.connect("/dev/ttyACM0");
        store.set({ snapshot: connected() });
        mountJog(root, ctx);
        click(root, "X+");
        await settle();
        expect(calls.find((c) => c.name === "jog")?.args[0]).toEqual({ kind: "board", dx: 1, dy: 0, feed: null });
        calls.length = 0;
        click(root, "10 mm");
        click(root, "Radius -");
        await settle();
        expect(calls.find((c) => c.name === "jog")?.args[0]).toEqual({ kind: "joint", dr: -10, feed: null });
        calls.length = 0;
        click(root, "90 deg");
        click(root, "Turn +");
        await settle();
        expect(calls.find((c) => c.name === "jog")?.args[0]).toEqual({ kind: "joint", da: 90, feed: null });
        calls.length = 0;
        click(root, "Cancel");
        await settle();
        expect(calls.some((c) => c.name === "jogCancel")).toBe(true);
        calls.length = 0;
        click(root, "Center");
        await settle();
        expect(calls.find((c) => c.name === "goto")?.args[0]).toEqual({ kind: "joint", r: 0 });
        expect(root.querySelector("button.btn-quiet")?.closest("fieldset")?.disabled).toBe(false);
        store.set({ snapshot: { connected: false, url: null, firmware: null, machine: null, run: null } });
        expect(root.querySelector("fieldset")?.disabled).toBe(true);
    });

    test("the cross slide moves on its own step and can be zeroed", async () => {
        const { store, ctx, root, calls, api, backend } = setup();
        await api.connect("/dev/ttyACM0");
        store.set({ snapshot: connected() });
        mountJog(root, ctx);
        const slide = root.querySelector(".slide")!;
        expect(slide.textContent).toContain("Cross slide");

        click(slide, "Set Z=0 here");
        await settle();
        click(document.querySelector("dialog[open]")!, "Set 0");
        await settle();
        expect(calls.find((c) => c.name === "setPosition")?.args[0]).toEqual({ z: 0 });
        calls.length = 0;

        // The step is the slide's own: the board step stays at 1 mm.
        click(slide, "0.05 mm");
        click(slide, "Z+");
        await settle();
        expect(calls.find((c) => c.name === "jog")?.args[0]).toEqual({ kind: "joint", dz: 0.05, feed: null });
        calls.length = 0;
        backend.step(1);
        expect(backend.machine.z).toBeCloseTo(0.05, 9);
        click(slide, "Z-");
        await settle();
        expect(calls.find((c) => c.name === "jog")?.args[0]).toEqual({ kind: "joint", dz: -0.05, feed: null });
        backend.step(1);
        expect(backend.machine.z).toBeCloseTo(0, 9);
        calls.length = 0;
        click(root, "X+");
        await settle();
        expect(calls.find((c) => c.name === "jog")?.args[0]).toEqual({ kind: "board", dx: 1, dy: 0, feed: null });
    });

    test("a cross slide button stays disabled until its request returns", async () => {
        const { store, ctx, root, api } = setup();
        await api.connect("/dev/ttyACM0");
        store.set({ snapshot: connected() });
        const open = gate<void>();
        const slow = api as unknown as { jog: () => Promise<void> };
        const real = slow.jog;
        slow.jog = () => open.promise;
        mountJog(root, ctx);
        const plus = Array.from(root.querySelectorAll("button")).find((b) => b.textContent === "Z+")!;
        plus.click();
        plus.click();
        expect(plus.disabled).toBe(true);
        open.resolve();
        await settle();
        expect(plus.disabled).toBe(false);
        slow.jog = real;
    });

    test("fast clicks on the pad send one jog until the first returns", async () => {
        const { store, ctx, root, calls, api } = setup();
        await api.connect("/dev/ttyACM0");
        store.set({ snapshot: connected() });
        const open = gate<void>();
        // The recording proxy logs the call; the stub only holds the request open.
        const slow = api as unknown as { jog: () => Promise<void> };
        const real = slow.jog;
        slow.jog = () => open.promise;
        mountJog(root, ctx);
        click(root, "X+");
        click(root, "X+");
        click(root, "X+");
        expect(calls.filter((c) => c.name === "jog").length).toBe(1);
        const plus = Array.from(root.querySelectorAll("button")).find((b) => b.textContent === "X+")!;
        expect(plus.disabled).toBe(true);
        open.resolve();
        await settle();
        expect(plus.disabled).toBe(false);
        slow.jog = real;
    });

    test("a board goto sends only the axes given, and the blank one is the backend's to fill", async () => {
        const { store, ctx, root, calls, api } = setup();
        await api.connect("/dev/ttyACM0");
        store.set({ snapshot: connected({ joint: { r: 5, a: 90, z: 0 }, board: { x: 0, y: 5 } }) });
        mountJog(root, ctx);
        const fields = Array.from(root.querySelectorAll("input[placeholder]")) as HTMLInputElement[];
        const x = fields.find((f) => f.placeholder === "x")!;
        x.value = "3";
        const goBoard = Array.from(root.querySelectorAll("button")).filter((b) => b.textContent === "Go")[0]!;
        goBoard.click();
        await settle();
        expect(calls.find((c) => c.name === "goto")?.args[0]).toEqual({ kind: "board", x: 3, feed: null });
    });

    test("fields that may go below zero do not ask for the keypad without a minus", () => {
        expect(numberField({ min: 0 }).getAttribute("inputmode")).toBe("decimal");
        expect(numberField({ min: 1, step: 1 }).getAttribute("inputmode")).toBe("decimal");
        expect(numberField({ placeholder: "x" }).hasAttribute("inputmode")).toBe(false);
        expect(numberField({ value: -2 }).hasAttribute("inputmode")).toBe(false);
    });

    test("arrow keys jog when no input has focus", async () => {
        const { store, ctx, root, calls, api } = setup();
        await api.connect("/dev/ttyACM0");
        store.set({ snapshot: connected() });
        mountJog(root, ctx);
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
        await settle();
        expect(calls.find((c) => c.name === "jog")?.args[0]).toEqual({ kind: "board", dx: 0, dy: -1, feed: null });
        calls.length = 0;
        const input = document.createElement("input");
        document.body.appendChild(input);
        input.focus();
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
        await settle();
        expect(calls.some((c) => c.name === "jog")).toBe(false);
        input.blur();
        input.remove();
        const dialog = document.createElement("dialog");
        document.body.appendChild(dialog);
        dialog.showModal();
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
        await settle();
        expect(calls.some((c) => c.name === "jog")).toBe(false);
        dialog.close();
        dialog.remove();
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await settle();
        expect(calls.some((c) => c.name === "jogCancel")).toBe(true);
    });

    // The events are not cancelable: every jog panel mounted by these tests
    // listens on the document, and one must not keep the key from the next.
    test("Escape stops a goto started with Enter while its field keeps the focus", async () => {
        const { store, ctx, root, calls, api } = setup();
        await api.connect("/dev/ttyACM0");
        store.set({ snapshot: connected() });
        mountJog(root, ctx);
        const x = root.querySelector('input[placeholder="x"]') as HTMLInputElement;
        x.value = "60";
        x.focus();
        x.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        await settle();
        expect(calls.find((c) => c.name === "goto")?.args[0]).toEqual({ kind: "board", x: 60, feed: null });
        expect(document.activeElement).toBe(x);
        x.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await settle();
        expect(calls.some((c) => c.name === "jogCancel")).toBe(true);
        // The field keeps its arrow keys.
        calls.length = 0;
        x.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
        await settle();
        expect(calls.some((c) => c.name === "jog")).toBe(false);
        x.blur();
    });

    test("Escape in a field with no machine connected sends nothing and raises no error", async () => {
        const { store, ctx, root, calls } = setup();
        mountJog(root, ctx);
        const x = root.querySelector('input[placeholder="x"]') as HTMLInputElement;
        x.focus();
        x.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await settle();
        expect(calls.some((c) => c.name === "jogCancel")).toBe(false);
        expect(store.get().toasts).toEqual([]);
        x.blur();
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await settle();
        expect(calls.some((c) => c.name === "jogCancel")).toBe(false);
        expect(store.get().toasts).toEqual([]);
    });

    test("a focused checkbox leaves the arrow keys to the jog, and a dialog keeps Escape", async () => {
        const { store, ctx, root, calls, api } = setup();
        await api.connect("/dev/ttyACM0");
        store.set({ snapshot: connected() });
        mountJog(root, ctx);
        const box = document.createElement("input");
        box.type = "checkbox";
        document.body.appendChild(box);
        box.focus();
        box.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
        await settle();
        expect(calls.find((c) => c.name === "jog")?.args[0]).toEqual({ kind: "board", dx: 1, dy: 0, feed: null });
        box.blur();
        box.remove();
        const dialog = document.createElement("dialog");
        document.body.appendChild(dialog);
        dialog.showModal();
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await settle();
        expect(calls.some((c) => c.name === "jogCancel")).toBe(false);
        dialog.close();
        dialog.remove();
    });
});

describe("status bar", () => {
    test("ports, state badge and link", () => {
        const { store, ctx, root } = setup();
        mountStatusBar(root, ctx);
        store.set({ ports: [{ url: "/dev/ttyACM0", description: "board" }] });
        expect(root.querySelectorAll("option").length).toBe(2);
        expect((root.querySelector("input.url") as HTMLInputElement).value).toBe("/dev/ttyACM0");
        store.set({ snapshot: connected({ state: "Alarm", alarm: 1 }), link: "open" });
        const badge = root.querySelector(".badge.state")!;
        expect(badge.getAttribute("data-state")).toBe("Alarm");
        expect(badge.textContent).toBe("Alarm:1");
        expect(root.querySelector(".firmware")?.textContent).toBe("v0.1.0");
        expect(root.querySelector(".link")?.getAttribute("data-link")).toBe("open");
        expect(Array.from(root.querySelectorAll("button")).some((b) => b.textContent === "Disconnect")).toBe(true);
        store.set({ link: "closed" });
        expect(root.querySelector(".link")?.textContent).toBe("disconnected");
    });
});

describe("jobs", () => {
    test("progress text", () => {
        expect(progressText(null)).toEqual({ bar: 0, counts: "", time: "", state: "", reason: "" });
        const text = progressText({ job: "a", state: "running", sent: 120, acked: 118, total: 900, seconds: 12.5, estimate: 95, group: 0 });
        expect(text.bar).toBeCloseTo(118 / 900, 9);
        expect(text.counts).toBe("120 sent / 118 acked / 900");
        expect(text.time).toBe("0:13 / 1:35");
        expect(text.reason).toBe("");
        const failed = progressText({ job: "a", state: "error", sent: 3, acked: 2, total: 9, seconds: 1, estimate: 9, group: 0, error: "'cut R1 A2 F3 S4': error:4 out of range" });
        expect(failed.reason).toContain("error:4");
    });

    test("the reason a run ended stays on the panel", async () => {
        const { store, ctx, root, api } = setup();
        mountJobs(root, ctx);
        await ctx.refreshJobs();
        const jobs = await api.jobs();
        await ctx.selectJob(jobs[0]!.id);
        store.set({ progress: { job: jobs[0]!.id, state: "error", sent: 3, acked: 2, total: 9, seconds: 1, estimate: 9, group: 0, error: "the machine reset during the run" } });
        expect(root.querySelector(".progress-reason")?.textContent).toBe("the machine reset during the run");
        store.set({ progress: { job: jobs[0]!.id, state: "running", sent: 3, acked: 2, total: 9, seconds: 1, estimate: 9, group: 0 } });
        expect(root.querySelector(".progress-reason")?.textContent).toBe("");
    });

    test("delete asks first, and a refused delete keeps the job selected with its controls", async () => {
        const { store, ctx, root, api, calls } = setup();
        await api.connect("/dev/ttyACM0");
        store.set({ snapshot: connected() });
        mountJobs(root, ctx);
        await ctx.refreshJobs();
        const jobs = await api.jobs();
        await ctx.selectJob(jobs[0]!.id);
        click(root, "Delete");
        await settle();
        dialogButton("Cancel").click();
        await settle();
        expect(calls.some((c) => c.name === "deleteJob")).toBe(false);
        expect(store.get().job?.id).toBe(jobs[0]!.id);
        // The job is running: the backend refuses to delete it, and the
        // panel with the Stop button must stay where it is.
        await api.runJob(jobs[0]!.id);
        await ctx.refreshState();
        click(root, "Delete");
        await settle();
        dialogButton("Delete").click();
        await settle();
        await settle();
        expect(calls.some((c) => c.name === "deleteJob")).toBe(true);
        expect(store.get().job?.id).toBe(jobs[0]!.id);
        expect(store.get().toasts.some((t) => t.level === "error")).toBe(true);
        const stop = Array.from(root.querySelectorAll("button")).find((b) => b.textContent === "Stop");
        expect(stop).toBeDefined();
        expect(root.querySelectorAll("table.groups tbody tr").length).toBeGreaterThan(0);
    });

    test("a patch of the same job updates the table in place and keeps the field being typed in", async () => {
        const { ctx, root, api } = setup();
        mountJobs(root, ctx);
        await ctx.refreshJobs();
        const jobs = await api.jobs();
        await ctx.selectJob(jobs[0]!.id);
        const table = root.querySelector("table.groups")!;
        const row = table.querySelectorAll("tbody")[0]!;
        const field = (label: string): HTMLInputElement => row.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
        const power = field("power");
        const minPower = field("min power");
        const speed = field("speed");
        expect(minPower.value).toBe("0");
        speed.focus();
        speed.value = "123";
        power.value = "321";
        power.dispatchEvent(new Event("change", { bubbles: true }));
        await settle();
        await settle();
        await settle();
        expect((await api.job(jobs[0]!.id)).groups[0]!.power).toBe(321);
        expect(root.querySelector("table.groups")).toBe(table);
        expect(speed.isConnected).toBe(true);
        expect(speed.value).toBe("123");
        expect(power.value).toBe("321");
        minPower.value = "80";
        minPower.dispatchEvent(new Event("change", { bubbles: true }));
        await settle();
        await settle();
        await settle();
        const group = (await api.job(jobs[0]!.id)).groups[0]!;
        expect(group.min_power).toBe(80);
        expect(group.power).toBe(321);
        expect(minPower.value).toBe("80");
        const passes = field("passes");
        expect(passes.value).toBe("1");
        passes.value = "3";
        passes.dispatchEvent(new Event("change", { bubbles: true }));
        await settle();
        await settle();
        await settle();
        expect((await api.job(jobs[0]!.id)).groups[0]!.passes).toBe(3);
        expect(root.querySelector("table.groups")).toBe(table);
        expect(passes.value).toBe("3");
    });

    test("the clear choice goes with an upload, and off sends none", async () => {
        const { ctx, root, calls } = setup();
        mountJobs(root, ctx);
        const clear = root.querySelector('select[aria-label="Clear copper"]') as HTMLSelectElement;
        const drop = root.querySelector(".drop") as HTMLElement;
        const send = async (): Promise<void> => {
            const event = new Event("drop", { cancelable: true });
            Object.defineProperty(event, "dataTransfer", { value: { files: [new File(["G04 x*"], "board-F_Cu.gbr")] } });
            drop.dispatchEvent(event);
            for (let i = 0; i < 5; i++) {
                await settle();
            }
        };
        await send();
        clear.value = "rings";
        await send();
        const uploads = calls.filter((c) => c.name === "uploadJob").map((c) => c.args[1] as { clear?: string });
        expect(uploads.map((options) => options.clear)).toEqual([undefined, "rings"]);
    });

    test("a deposit sends its fill in place of the clear choice, which it hides", async () => {
        const { ctx, root, calls } = setup();
        mountJobs(root, ctx);
        const mode = root.querySelector('select[aria-label="Board mode"]') as HTMLSelectElement;
        const clear = root.querySelector('select[aria-label="Clear copper"]') as HTMLSelectElement;
        const fill = root.querySelector('select[aria-label="Fill copper"]') as HTMLSelectElement;
        const drop = root.querySelector(".drop") as HTMLElement;
        const send = async (): Promise<void> => {
            const event = new Event("drop", { cancelable: true });
            Object.defineProperty(event, "dataTransfer", { value: { files: [new File(["G04 x*"], "board-F_Cu.gbr")] } });
            drop.dispatchEvent(event);
            for (let i = 0; i < 5; i++) {
                await settle();
            }
        };
        const shown = (select: HTMLSelectElement): boolean => !select.closest("label")!.classList.contains("hidden");
        expect([shown(clear), shown(fill)]).toEqual([true, false]);
        clear.value = "rings";
        mode.value = "deposit";
        mode.dispatchEvent(new Event("change", { bubbles: true }));
        expect([shown(clear), shown(fill)]).toEqual([false, true]);
        await send();
        fill.value = "radial";
        await send();
        mode.value = "isolate";
        mode.dispatchEvent(new Event("change", { bubbles: true }));
        expect([shown(clear), shown(fill)]).toEqual([true, false]);
        await send();
        const uploads = calls.filter((c) => c.name === "uploadJob").map((c) => c.args[1] as { mode?: string; clear?: string; fill?: string });
        expect(uploads.map(({ mode, clear, fill }) => ({ mode, clear, fill }))).toEqual([
            { mode: "deposit", clear: undefined, fill: "contour" },
            { mode: "deposit", clear: undefined, fill: "radial" },
            { mode: undefined, clear: "rings", fill: undefined },
        ]);
    });

    test("list and groups of the selected job", async () => {
        const { store, ctx, root, api } = setup();
        mountJobs(root, ctx);
        await ctx.refreshJobs();
        expect(root.querySelectorAll("li").length).toBe(1);
        const jobs = await api.jobs();
        await ctx.selectJob(jobs[0]!.id);
        expect(root.querySelectorAll("table.groups tbody").length).toBe(4);
        expect(root.querySelectorAll("table.groups tbody tr.group-fields input[type=number]").length).toBe(16);
        expect(root.querySelector(".stats")?.textContent).toContain("Table limited");
        expect(root.querySelector("li")?.classList.contains("selected")).toBe(true);
        store.set({ progress: { job: jobs[0]!.id, state: "running", sent: 1, acked: 1, total: 10, seconds: 1, estimate: 10, group: 0 } });
        expect((root.querySelector(".progress-fill") as HTMLElement).style.width).toBe("10.0%");
    });
});

describe("laser and settings", () => {
    test("laser panel follows the mode", () => {
        const { store, ctx, root } = setup();
        mountLaser(root, ctx);
        store.set({ snapshot: connected({ mode: "const" }) });
        const pressed = Array.from(root.querySelectorAll('button[aria-pressed="true"]')).map((b) => b.textContent);
        expect(pressed).toEqual(["const"]);
    });

    test("every beam test asks first and fires only on confirm", async () => {
        const { store, ctx, root, calls, api } = setup();
        await api.connect("/dev/ttyACM0");
        store.set({ snapshot: connected() });
        mountLaser(root, ctx);
        const dialogButton = (label: string): HTMLButtonElement => {
            const dialog = document.querySelector("dialog[open]");
            if (!dialog) {
                throw new Error("no confirm dialog");
            }
            return Array.from(dialog.querySelectorAll("button")).find((b) => b.textContent === label)!;
        };
        click(root, "Test beam");
        await settle();
        dialogButton("Cancel").click();
        await settle();
        expect(calls.some((c) => c.name === "laser")).toBe(false);
        click(root, "Test beam");
        await settle();
        dialogButton("Fire").click();
        await settle();
        expect(calls.filter((c) => c.name === "laser").length).toBe(1);
        expect(calls.find((c) => c.name === "laser")?.args).toEqual([100, 1000]);
        // A click in the first moments after the dialog opens is not a
        // confirmation: a held key or a double click must not fire it.
        confirmSettle.ms = 1000;
        click(root, "Test beam");
        await settle();
        expect(document.activeElement?.textContent).toBe("Cancel");
        dialogButton("Fire").click();
        await settle();
        expect(calls.filter((c) => c.name === "laser").length).toBe(1);
        dialogButton("Cancel").click();
        await settle();
        confirmSettle.ms = 0;
        // The next test asks again rather than remembering the answer.
        click(root, "Test beam");
        await settle();
        expect(document.querySelector("dialog[open]")).not.toBeNull();
        dialogButton("Cancel").click();
        await settle();
        expect(calls.filter((c) => c.name === "laser").length).toBe(1);
    });

    test("a chord tolerance of zero is refused with a message, not dropped", async () => {
        const { store, ctx, root, api, calls } = setup();
        mountSettings(root, ctx);
        const settings = await api.settings();
        store.set({ settings });
        const inputs = Array.from(root.querySelectorAll("input")) as HTMLInputElement[];
        const tolerance = inputs.find((i) => i.value === String(settings.host.tolerance))!;
        tolerance.value = "0";
        click(root, "Apply");
        await settle();
        expect(calls.some((c) => c.name === "updateSettings")).toBe(false);
        expect(store.get().toasts.some((t) => t.level === "error" && t.text.includes("tolerance"))).toBe(true);
    });

    test("a beam duration is checked as the whole milliseconds that will be sent", async () => {
        const { store, ctx, root, calls, api } = setup();
        await api.connect("/dev/ttyACM0");
        store.set({ snapshot: connected() });
        mountLaser(root, ctx);
        const inputs = Array.from(root.querySelectorAll("input")) as HTMLInputElement[];
        const ms = inputs.find((i) => i.value === "1000")!;
        for (const bad of ["0.4", String(MAX_BEAM_MS + 1)]) {
            ms.value = bad;
            click(root, "Test beam");
            await settle();
            expect(document.querySelector("dialog[open]")).toBeNull();
        }
        expect(calls.some((c) => c.name === "laser")).toBe(false);
        expect(store.get().toasts.filter((t) => t.level === "error").length).toBe(2);
        ms.value = "1.6";
        click(root, "Test beam");
        await settle();
        expect(document.querySelector("dialog[open]")?.textContent).toContain("for 2 ms");
        dialogButton("Cancel").click();
        await settle();
    });

    test("changed values and the settings table", async () => {
        const { store, ctx, root, api } = setup();
        mountSettings(root, ctx);
        const settings = await api.settings();
        store.set({ settings });
        expect(root.querySelectorAll("table.settings tbody tr").length).toBe(settings.schema.length);
        expect(changedValues(settings, { r_rate: 560, a_rate: 500 })).toEqual({ a_rate: 500 });
        const input = root.querySelector('input[aria-label="r_rate"]') as HTMLInputElement;
        input.value = "900";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        expect(input.closest("tr")?.classList.contains("edited")).toBe(true);
    });
});

describe("machine files", () => {
    test("the settings panel lists the files, names the loaded one, and loads another on confirm", async () => {
        const { store, ctx, root, api, calls } = setup();
        await api.connect("/dev/ttyACM0");
        store.set({ snapshot: connected() });
        mountSettings(root, ctx);
        await settle();
        const pick = root.querySelector("select[aria-label='Machine']") as HTMLSelectElement;
        expect(Array.from(pick.options).map((option) => option.value)).toEqual(["", "polar-laser", "polar-laser-focus", "cartesian-laser", "cartesian-mill"]);
        const load = Array.from(root.querySelectorAll("button")).find((b) => b.textContent === "Load")!;
        // Before the settings are read nothing is known to be loaded.
        expect(pick.value).toBe("");
        store.set({ settings: await api.settings() });
        await settle();
        // The mock boots as the polar laser with its focus axis: that is the one loaded, and there is nothing to load.
        expect(pick.value).toBe("polar-laser-focus");
        expect(root.textContent).toContain("loaded");
        expect(load.disabled).toBe(true);
        pick.value = "cartesian-mill";
        pick.dispatchEvent(new Event("change"));
        expect(load.disabled).toBe(false);
        expect(root.textContent).toContain("spindle on the output");
        // A settings refresh does not take the pick away.
        store.set({ settings: await api.settings() });
        await settle();
        expect(pick.value).toBe("cartesian-mill");
        load.click();
        await settle();
        dialogButton("Cancel").click();
        await settle();
        expect(calls.some((c) => c.name === "applyMachine")).toBe(false);
        load.click();
        await settle();
        dialogButton("Load").click();
        await settle();
        expect(calls.filter((c) => c.name === "applyMachine").map((c) => c.args)).toEqual([["cartesian-mill", false]]);
        const settings = store.get().settings!;
        expect(settings.machine).toBe("cartesian-mill");
        expect(settings.values["cartesian"]).toBe(1);
        expect(pick.value).toBe("cartesian-mill");
        expect(load.disabled).toBe(true);
        // A setting changed by hand: the settings are no file's any more.
        await api.updateSettings({ values: { a_rate: 123 } });
        await ctx.refreshSettings();
        await settle();
        expect(pick.value).toBe("");
        expect(root.textContent).toContain("no file");
        // Not connected: nothing to load.
        store.set({ snapshot: { ...connected(), connected: false, machine: null } });
        await settle();
        expect(load.disabled).toBe(true);
        expect(root.textContent).toContain("connect to load one");
    });
});

describe("settings table under the operator's hands", () => {
    test("an edit not yet applied outlives a refresh, and goes once the machine has the value", async () => {
        const { store, ctx, root, api } = setup();
        await api.connect("/dev/ttyACM0");
        store.set({ snapshot: connected() });
        mountSettings(root, ctx);
        const settings = await api.settings();
        store.set({ settings });
        const field = (name: string): HTMLInputElement => root.querySelector(`input[aria-label="${name}"]`) as HTMLInputElement;
        const edited = (name: string): boolean => field(name).closest("tr")!.classList.contains("edited");
        field("r_rate").value = "900";
        field("r_rate").dispatchEvent(new Event("input", { bubbles: true }));
        const tolerance = root.querySelector("input[step='0.001']") as HTMLInputElement;
        tolerance.value = "0.01";
        // Another panel writes a setting and reads them all again.
        store.set({ settings: { ...settings, values: { ...settings.values, probe_ms: 40 } } });
        expect(field("r_rate").value).toBe("900");
        expect(edited("r_rate")).toBe(true);
        expect(field("probe_ms").value).toBe("40");
        expect(tolerance.value).toBe("0.01");
        // The field being typed in keeps its text and its focus.
        field("a_rate").focus();
        field("a_rate").value = "7";
        store.set({ settings: { ...settings } });
        expect(field("a_rate").value).toBe("7");
        expect(document.activeElement).toBe(field("a_rate"));
        field("a_rate").blur();
        // Applied: the machine has 900 now, so it is no edit any more.
        store.set({ settings: { ...settings, values: { ...settings.values, r_rate: 900 } } });
        expect(field("r_rate").value).toBe("900");
        expect(edited("r_rate")).toBe(false);
        field("r_rate").value = "950";
        field("r_rate").dispatchEvent(new Event("input", { bubbles: true }));
        // Another machine: what was typed for the last one is dropped.
        store.set({ snapshot: { ...connected(), url: "/dev/ttyACM1" } });
        store.set({ settings: { ...settings } });
        expect(field("r_rate").value).toBe(String(settings.values["r_rate"]));
        expect(edited("r_rate")).toBe(false);
        expect(tolerance.value).toBe(String(settings.host.tolerance));
    });
});

describe("console and toasts", () => {
    test("console appends, rolls and clears", () => {
        const { store, ctx, root } = setup();
        mountConsole(root, ctx);
        appendConsole(store, { dir: "tx", text: "?" });
        appendConsole(store, { dir: "rx", text: "<Idle>" });
        const log = root.querySelector(".console-log")!;
        expect(log.children.length).toBe(2);
        expect(log.children[0]?.classList.contains("tx")).toBe(true);
        for (let i = 0; i < 500; i++) {
            appendConsole(store, { dir: "rx", text: `line ${i}` });
        }
        expect(log.children.length).toBe(400);
        expect(log.children[399]?.textContent).toContain("line 499");
        click(root, "Clear");
        expect(log.children.length).toBe(0);
    });

    test("a setting typed at the console reloads the page's copy of the settings", async () => {
        const { store, ctx, root, calls, api } = setup();
        await api.connect("/dev/ttyACM0");
        store.set({ snapshot: connected(), settings: await api.settings() });
        mountConsole(root, ctx);
        const input = root.querySelector(".console-input input") as HTMLInputElement;
        const send = async (line: string): Promise<void> => {
            input.value = line;
            click(root, "Send");
            await settle();
            await settle();
        };
        calls.length = 0;
        await send("?");
        expect(calls.some((c) => c.name === "settings")).toBe(false);
        await send("$r_max=40");
        expect(calls.filter((c) => c.name === "settings").length).toBe(1);
        expect(store.get().settings?.values["r_max"]).toBe(40);
        expect(writesSettings("$load")).toBe(true);
        expect(writesSettings(" $Defaults ")).toBe(true);
        expect(writesSettings("$")).toBe(false);
        expect(writesSettings("$save")).toBe(false);
        expect(writesSettings("cut R1 F1")).toBe(false);
    });

    test("toasts render and can be dismissed", () => {
        const { store, ctx, root } = setup();
        mountToasts(root, ctx);
        pushToast(store, "error", "oops");
        expect(root.querySelector(".toast.error")?.textContent).toBe("oops");
        (root.querySelector(".toast") as HTMLElement).click();
        expect(root.children.length).toBe(0);
    });
});
