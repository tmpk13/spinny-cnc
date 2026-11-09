import { describe, expect, test } from "bun:test";

import type { Api } from "../src/api.ts";
import { applyEvent, createContext, settingsMayHaveChanged } from "../src/main.ts";
import { MockBackend } from "../src/mock/backend.ts";
import { button, numberField, setLocked } from "../src/dom.ts";
import { Store, appendConsole, initialState, pushToast, type AppState } from "../src/state.ts";
import type { Controls, Job, JobSummary, Machine, SettingsResponse, Snapshot, WsEvent } from "../src/types.ts";
import { mountConsole, writesSettings } from "../src/views/console.ts";
import { droText, mountDro } from "../src/views/dro.ts";
import { mountJobs, progressText } from "../src/views/jobs.ts";
import { findButton } from "./harness.ts";
import { anyOf, keyAction, mountJog } from "../src/views/jog.ts";
import { confirmSettle } from "../src/confirm.ts";
import { MAX_BEAM_MS, mountLaser } from "../src/views/laser.ts";
import { changedBootSettings, mountConfig } from "../src/views/config.ts";
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
        expect(droText(machine())).toEqual({ r: "12.345", a: "90.0000", z: "0.000", h: null, x: "0.000", y: "12.345", laser: "0.0%", rate: "0", mode: "dyn", queue: "32/16", motors: "on", probe: null, homed: null });
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
        // Each bar has its own step: the radius bar's 10 mm, not the board's.
        const radius = root.querySelector('[data-axis="r"]')!;
        click(radius, "10 mm");
        click(radius, "Radius -");
        await settle();
        expect(calls.find((c) => c.name === "jog")?.args[0]).toEqual({ kind: "joint", dr: -10, feed: null });
        calls.length = 0;
        click(root, "X-");
        await settle();
        expect(calls.find((c) => c.name === "jog")?.args[0]).toEqual({ kind: "board", dx: -1, dy: 0, feed: null });
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
        // The cancel button sits in the panel's head, outside the fieldset, and locks with it.
        const cancel = root.querySelector(".panel-head button") as HTMLButtonElement;
        expect(cancel.textContent).toBe("Cancel");
        expect(cancel.disabled).toBe(false);
        store.set({ snapshot: { connected: false, url: null, firmware: null, machine: null, run: null } });
        expect(root.querySelector("fieldset")?.disabled).toBe(true);
        expect(cancel.disabled).toBe(true);
    });

    test("a step typed in is the step until a choice is pressed again", async () => {
        const { store, ctx, root, calls, api } = setup();
        await api.connect("/dev/ttyACM0");
        store.set({ snapshot: connected() });
        mountJog(root, ctx);
        const x = root.querySelector('[data-axis="x"]')!;
        const custom = x.querySelector('input[aria-label="Board X step"]') as HTMLInputElement;
        custom.value = "2.5";
        custom.dispatchEvent(new Event("input", { bubbles: true }));
        expect(Array.from(x.querySelectorAll(".btn-choice")).every((b) => b.getAttribute("aria-pressed") === "false")).toBe(true);
        click(x, "X+");
        await settle();
        expect(calls.find((c) => c.name === "jog")?.args[0]).toEqual({ kind: "board", dx: 2.5, dy: 0, feed: null });
        calls.length = 0;
        // The arrow keys take it, and the Y bar keeps its own step.
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
        await settle();
        expect(calls.find((c) => c.name === "jog")?.args[0]).toEqual({ kind: "board", dx: -2.5, dy: 0, feed: null });
        calls.length = 0;
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
        await settle();
        expect(calls.find((c) => c.name === "jog")?.args[0]).toEqual({ kind: "board", dx: 0, dy: 1, feed: null });
        calls.length = 0;
        // A choice pressed clears the typed step.
        click(x, "10 mm");
        expect(custom.value).toBe("");
        click(x, "X-");
        await settle();
        expect(calls.find((c) => c.name === "jog")?.args[0]).toEqual({ kind: "board", dx: -10, dy: 0, feed: null });
        calls.length = 0;
        // A typed step that is no step leaves the choice pressed.
        custom.value = "0";
        custom.dispatchEvent(new Event("input", { bubbles: true }));
        expect(x.querySelector('.btn-choice[aria-pressed="true"]')?.textContent).toBe("10 mm");
        click(x, "X+");
        await settle();
        expect(calls.find((c) => c.name === "jog")?.args[0]).toEqual({ kind: "board", dx: 10, dy: 0, feed: null });
    });

    test("the cross slide moves on its own step and can be zeroed", async () => {
        const { store, ctx, root, calls, api, backend } = setup();
        await api.connect("/dev/ttyACM0");
        store.set({ snapshot: connected() });
        mountJog(root, ctx);
        const slide = root.querySelector('[data-axis="z"]')!;
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

    test("a run refused for want of the head at focus asks, and runs with focus here on the operator's word", async () => {
        const { ctx, root, api, calls, backend } = setup();
        await api.connect("/dev/ttyACM0");
        await api.updateSettings({ values: { h_axis: 1 } });
        const made = await api.calibrateJob({ kind: "focus", focuses: [-1, 1, 3], length: 30, gap: 1, x: -15, y: 20 });
        // Stopped on its first line, the run left the head a millimetre low.
        await api.runJob(made.job.id);
        for (let waited = 0; waited < 60 && Math.abs(backend.machine.h + 1) > 1e-9; waited += 0.1) {
            backend.step(0.1);
        }
        await api.runStop();
        backend.step(1);
        mountJobs(root, ctx);
        await ctx.refreshState();
        await ctx.refreshJobs();
        await ctx.selectJob(made.job.id);
        click(root, "Run");
        await settle();
        await settle();
        expect(document.querySelector("dialog[open]")?.textContent).toContain("The last run of focus ladder stopped with the focus axis at H-1, not at H0");
        dialogButton("Focused here: run").click();
        await settle();
        await settle();
        expect(calls.filter((c) => c.name === "runJob").at(-1)?.args).toEqual([made.job.id, "off", true]);
        expect((await api.run())?.state).toBe("running");
        await api.runStop();
        backend.step(1);
        // Renumbered since: a pickup needs the word too, and carries it to the resume.
        await api.setPosition({ h: 0 });
        await ctx.refreshState();
        click(root, "Resume from line");
        await settle();
        await settle();
        expect(document.querySelector("dialog[open]")?.textContent).toContain("The focus axis has been renumbered since the run being picked up began at H-1");
        dialogButton("Focused here: plan").click();
        await settle();
        await settle();
        expect(document.querySelector("dialog[open]")?.textContent).toContain("Its groups' focus counts from where the head is now.");
        dialogButton("Resume").click();
        await settle();
        await settle();
        const resumed = calls.filter((c) => c.name === "resumeJob").at(-1)?.args[1] as { focus_here?: boolean } | undefined;
        expect(resumed?.focus_here).toBe(true);
        expect((await api.run())?.state).toBe("running");
        await api.runStop();
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

    test("the layer goes with an upload, trimmed, and an empty one sends none", async () => {
        const { ctx, root, calls } = setup();
        mountJobs(root, ctx);
        const layer = root.querySelector('input[aria-label="Board layer"]') as HTMLInputElement;
        expect(layer.value).toBe("F.Cu");
        const offered = Array.from(root.querySelectorAll("datalist#board-layers option")).map((option) => (option as HTMLOptionElement).value);
        expect(offered).toContain("F.Paste");
        expect(layer.getAttribute("list")).toBe("board-layers");
        const drop = root.querySelector(".drop") as HTMLElement;
        const send = async (): Promise<void> => {
            const event = new Event("drop", { cancelable: true });
            Object.defineProperty(event, "dataTransfer", { value: { files: [new File(["(kicad_pcb)"], "board.kicad_pcb")] } });
            drop.dispatchEvent(event);
            for (let i = 0; i < 5; i++) {
                await settle();
            }
        };
        await send();
        layer.value = " F.Paste ";
        await send();
        expect(root.querySelector(".job-list")!.textContent).toContain("kicad F.Paste");
        layer.value = "";
        await send();
        const uploads = calls.filter((c) => c.name === "uploadJob").map((c) => c.args[1] as { layer?: string });
        expect(uploads.map((options) => options.layer)).toEqual(["F.Cu", "F.Paste", undefined]);
    });

    test("a KiCad board's own layers are offered before it is sent, a drawing cut on its lines", async () => {
        const { ctx, root, calls } = setup();
        mountJobs(root, ctx);
        const text = await Bun.file(new URL("../../../toolpath/tests/data/board.kicad_pcb", import.meta.url)).text();
        const mode = root.querySelector('select[aria-label="Board mode"]') as HTMLSelectElement;
        const layer = root.querySelector('input[aria-label="Board layer"]') as HTMLInputElement;
        const chooser = root.querySelector(".layer-chooser") as HTMLElement;
        const pick = chooser.querySelector("select") as HTMLSelectElement;
        const drop = async (): Promise<void> => {
            const event = new Event("drop", { cancelable: true });
            Object.defineProperty(event, "dataTransfer", { value: { files: [new File([text], "board.kicad_pcb")] } });
            root.querySelector(".drop")!.dispatchEvent(event);
            for (let i = 0; i < 5; i++) {
                await settle();
            }
        };
        const uploads = (): Record<string, unknown>[] => calls.filter((c) => c.name === "uploadJob").map((c) => c.args[1] as Record<string, unknown>);
        expect(chooser.classList.contains("hidden")).toBe(true);
        await drop();
        // Nothing is sent until a layer is picked; the board's own are offered.
        expect(chooser.classList.contains("hidden")).toBe(false);
        expect(uploads()).toEqual([]);
        const offered = Array.from(pick.options).map((option) => option.textContent);
        expect(offered).toContain("F.SilkS (F.Silkscreen): 10 items");
        expect(offered).toContain("B.Paste: empty");
        expect(pick.value).toBe("F.Cu");
        // A drawing is cut on its lines; copper again puts the choice back.
        pick.value = "Edge.Cuts";
        pick.dispatchEvent(new Event("change"));
        expect(mode.value).toBe("lines");
        pick.value = "F.Cu";
        pick.dispatchEvent(new Event("change"));
        expect(mode.value).toBe("isolate");
        pick.value = "Edge.Cuts";
        pick.dispatchEvent(new Event("change"));
        expect(chooser.textContent).toContain("Board: on the lines");
        findButton(chooser, "Import").click();
        for (let i = 0; i < 5; i++) {
            await settle();
        }
        expect(chooser.classList.contains("hidden")).toBe(true);
        expect(uploads()).toEqual([expect.objectContaining({ layer: "Edge.Cuts", mode: "lines" })]);
        expect(layer.value).toBe("Edge.Cuts");
        expect(root.querySelector(".job-list")!.textContent).toContain("kicad Edge.Cuts");
        // Called off, nothing goes; the layer last cut is offered first.
        await drop();
        expect(pick.value).toBe("Edge.Cuts");
        findButton(chooser, "Cancel").click();
        for (let i = 0; i < 5; i++) {
            await settle();
        }
        expect(uploads().length).toBe(1);
        // A Board choice made by hand while the chooser is open stands.
        await drop();
        mode.value = "deposit";
        mode.dispatchEvent(new Event("change"));
        pick.value = "F.Cu";
        pick.dispatchEvent(new Event("change"));
        expect(mode.value).toBe("deposit");
        pick.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
        for (let i = 0; i < 5; i++) {
            await settle();
        }
        expect(uploads()[1]).toMatchObject({ layer: "F.Cu", mode: "deposit" });
    });

    test("a stencil sends its margin in place of clear and fill, and takes the paste for a copper layer", async () => {
        const { ctx, root, calls } = setup();
        mountJobs(root, ctx);
        const mode = root.querySelector('select[aria-label="Board mode"]') as HTMLSelectElement;
        const layer = root.querySelector('input[aria-label="Board layer"]') as HTMLInputElement;
        const margin = root.querySelector('input[aria-label="Stencil margin"]') as HTMLInputElement;
        const shown = (field: HTMLElement): boolean => !field.closest("label")!.classList.contains("hidden");
        const clear = root.querySelector('select[aria-label="Clear copper"]') as HTMLSelectElement;
        const fill = root.querySelector('select[aria-label="Fill copper"]') as HTMLSelectElement;
        expect(shown(margin)).toBe(false);
        clear.value = "rings";
        mode.value = "stencil";
        mode.dispatchEvent(new Event("change", { bubbles: true }));
        expect([shown(clear), shown(fill), shown(margin)]).toEqual([false, false, true]);
        expect(layer.value).toBe("F.Paste");
        margin.value = "0.05";
        const event = new Event("drop", { cancelable: true });
        Object.defineProperty(event, "dataTransfer", { value: { files: [new File(["(kicad_pcb)"], "board.kicad_pcb")] } });
        root.querySelector(".drop")!.dispatchEvent(event);
        for (let i = 0; i < 5; i++) {
            await settle();
        }
        const [options] = calls.filter((c) => c.name === "uploadJob").map((c) => c.args[1] as Record<string, unknown>);
        expect(options).toMatchObject({ mode: "stencil", margin: 0.05, layer: "F.Paste" });
        expect([options!["clear"], options!["fill"]]).toEqual([undefined, undefined]);
        // A layer typed for the stencil is the user's to keep.
        mode.value = "isolate";
        mode.dispatchEvent(new Event("change", { bubbles: true }));
        layer.value = "B.Cu";
        mode.value = "stencil";
        mode.dispatchEvent(new Event("change", { bubbles: true }));
        expect(layer.value).toBe("B.Paste");
        layer.value = "User.1";
        mode.value = "deposit";
        mode.dispatchEvent(new Event("change", { bubbles: true }));
        mode.value = "stencil";
        mode.dispatchEvent(new Event("change", { bubbles: true }));
        expect(layer.value).toBe("User.1");
    });

    test("a stencil's margin row cuts it again for another margin, where it lies", async () => {
        const { store, ctx, root, api, calls } = setup();
        mountJobs(root, ctx);
        const job = await api.uploadJob(new File(["(kicad_pcb)"], "board.kicad_pcb"), { mode: "stencil", margin: 0 });
        await ctx.refreshJobs();
        await ctx.selectJob(job.id);
        const field = root.querySelector('input[aria-label="Margin of this stencil"]') as HTMLInputElement;
        expect(field.value).toBe("0");
        const labels = (): string[] => (store.get().job?.groups ?? []).map((group) => group.label);
        expect(labels()[0]).toBe("paste openings, 0.000 mm margin");
        await api.patchJob(job.id, { offset: { x: job.offset.x + 2, y: job.offset.y } });
        await ctx.reloadJob(job.id);
        const recut = async (margin: string): Promise<void> => {
            const row = root.querySelector('input[aria-label="Margin of this stencil"]') as HTMLInputElement;
            row.value = margin;
            row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
            for (let i = 0; i < 5; i++) {
                await settle();
            }
        };
        // As many groups as before, but the table says the new margin.
        await recut("0.05");
        expect(root.querySelector("table.groups")!.textContent).toContain("paste openings, 0.050 mm margin");
        // The fine pads, 0.25 mm wide, leave a 0.1 mm spot no room once
        // 0.1 mm comes off each side.
        await recut("0.1");
        expect(calls.filter((c) => c.name === "setJobMargin").map((c) => c.args)).toEqual([[job.id, 0.05], [job.id, 0.1]]);
        expect(labels()).toEqual([
            "paste openings, 0.100 mm margin",
            "paste openings narrower than the spot, along their middle",
            "board outline pass 1",
        ]);
        expect(store.get().job?.offset.x).toBeCloseTo(job.offset.x + 2);
        expect((root.querySelector('input[aria-label="Margin of this stencil"]') as HTMLInputElement).value).toBe("0.1");
        // A job that is no stencil has no margin to change.
        const plain = await api.uploadJob(new File(["(kicad_pcb)"], "plain.kicad_pcb"), {});
        await ctx.refreshJobs();
        await ctx.selectJob(plain.id);
        expect(root.querySelector('input[aria-label="Margin of this stencil"]')).toBeNull();
    });

    test("list and groups of the selected job", async () => {
        const { store, ctx, root, api } = setup();
        mountJobs(root, ctx);
        await ctx.refreshJobs();
        expect(root.querySelectorAll("li").length).toBe(1);
        const jobs = await api.jobs();
        await ctx.selectJob(jobs[0]!.id);
        expect(root.querySelectorAll("table.groups tbody").length).toBe(4);
        expect(root.querySelectorAll("table.groups tbody tr.group-fields input.num").length).toBe(16);
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

});

describe("machine files", () => {
    test("the config panel lists the files, names the loaded one, checks and saves a text, and writes one on confirm", async () => {
        localStorage.removeItem("spinny.machine");
        const { store, ctx, root, api, calls } = setup();
        await api.connect("/dev/ttyACM0");
        store.set({ snapshot: connected() });
        mountConfig(root, ctx);
        await settle();
        const pick = root.querySelector("select[aria-label='Machine file']") as HTMLSelectElement;
        expect(Array.from(pick.options).map((option) => option.value)).toEqual(["cartesian-laser", "cartesian-mill", "polar-laser-focus", "polar-laser"]);
        const load = Array.from(root.querySelectorAll("button")).find((b) => b.textContent === "Write to board")!;
        const flash = Array.from(root.querySelectorAll("button")).find((b) => b.textContent === "Save to flash")!;
        const text = root.querySelector("textarea") as HTMLTextAreaElement;
        const status = (): string => root.querySelector(".config-status")?.textContent ?? "";
        // The mock boots as the polar laser with its focus axis: that file is picked first.
        expect(pick.value).toBe("polar-laser-focus");
        expect(text.value).toContain("[focus]");
        store.set({ settings: await api.settings() });
        await settle();
        expect(root.querySelector(".config-board")?.textContent).toBe("the board runs this file, as saved to its flash");
        expect(flash.classList.contains("hidden")).toBe(true);
        // Another file: what it reads as, and the board runs the other one.
        pick.value = "cartesian-mill";
        pick.dispatchEvent(new Event("change"));
        await settle();
        expect(load.disabled).toBe(false);
        expect(root.querySelector(".config-board")?.textContent).toBe("the board runs polar-laser-focus, as saved to its flash");
        expect(text.value).toContain('kinematics = "cartesian"');
        expect(root.querySelector(".config-note")?.textContent).toContain("Cartesian mill: cartesian, spindle, focus axis");
        const original = text.value;
        // Typed, a line that does not read is named before any save.
        text.value = `${original}\n[rail\n`;
        text.dispatchEvent(new Event("input", { bubbles: true }));
        expect(status()).toContain("expected key = value");
        // Checked, the backend's refusal is listed and nothing is written.
        text.value = `${original}\n[nope]\nx = 1\n`;
        text.dispatchEvent(new Event("input", { bubbles: true }));
        expect(status()).toBe("edited, not saved");
        click(root, "Check");
        await settle();
        expect(root.querySelector(".config-problems")?.textContent).toContain("nope is not a key here");
        click(root, "Save");
        await settle();
        expect(status()).toContain("nope is not a key here");
        expect((await api.machineFile("cartesian-mill")).text).toBe(original);
        // A good edit is saved, and the list follows the name.
        text.value = original.replace('name = "Cartesian mill"', 'name = "My mill"');
        text.dispatchEvent(new Event("input", { bubbles: true }));
        click(root, "Save");
        await settle();
        expect(status()).toBe("saved");
        expect(Array.from(pick.options).find((option) => option.value === "cartesian-mill")?.textContent).toBe("My mill");
        // Revert takes the saved text.
        text.value = "x";
        text.dispatchEvent(new Event("input", { bubbles: true }));
        click(root, "Revert");
        expect(text.value).toContain('name = "My mill"');
        // Write to board asks first, then writes every setting of the file
        // and saves it to flash in the same step.
        load.click();
        await settle();
        dialogButton("Cancel").click();
        await settle();
        expect(calls.some((c) => c.name === "applyMachine")).toBe(false);
        load.click();
        await settle();
        dialogButton("Write").click();
        await settle();
        await settle();
        expect(calls.filter((c) => c.name === "applyMachine").map((c) => c.args)).toEqual([["cartesian-mill", true]]);
        const settings = store.get().settings!;
        expect(settings.machine).toBe("cartesian-mill");
        expect(settings.values["cartesian"]).toBe(1);
        expect(root.querySelector(".config-board")?.textContent).toBe("the board runs this file, as saved to its flash");
        // A setting changed by hand: the settings are no file's any more,
        // and flash is behind the board until saved.
        await api.updateSettings({ values: { a_rate: 123 } });
        await ctx.refreshSettings();
        await settle();
        const board = root.querySelector(".config-board")?.textContent ?? "";
        expect(board).toContain("runs settings no file has; 1 written since the last save to flash (a_rate)");
        expect(board).toContain("the jog panel draws this file's controls");
        expect(flash.classList.contains("hidden")).toBe(false);
        // Read from board writes the board's value into the text, not saved.
        click(root, "Read from board");
        await settle();
        await settle();
        expect(text.value).toMatch(/\nmax_rate = 123\b/);
        expect(status()).toBe("1 values read from the board, not saved: Save keeps them");
        expect(root.querySelector(".config-notes")?.textContent).toContain("[table] max_rate = 123 (was");
        expect((await api.machineFile("cartesian-mill")).text).not.toMatch(/\nmax_rate = 123\b/);
        // Written with the edit: the text is saved first, then written.
        load.click();
        await settle();
        expect(document.querySelector("dialog[open]")?.textContent).toContain("The edits in the text are saved to the file first.");
        dialogButton("Write").click();
        for (let i = 0; i < 4; i += 1) {
            await settle();
        }
        expect((await api.machineFile("cartesian-mill")).text).toMatch(/\nmax_rate = 123\b/);
        expect(root.querySelector(".config-board")?.textContent).toBe("the board runs this file, as saved to its flash");
        expect(flash.classList.contains("hidden")).toBe(true);
        // Reload reads the settings again too: a file edited by hand may have changed the controls.
        const settingsReads = calls.filter((c) => c.name === "settings").length;
        click(root, "Reload");
        await settle();
        expect(calls.filter((c) => c.name === "settings").length).toBe(settingsReads + 1);
        // Not connected: nothing to load.
        store.set({ snapshot: { ...connected(), connected: false, machine: null } });
        await settle();
        expect(load.disabled).toBe(true);
        expect(root.textContent).toContain("connect to write the file to the board or read the board into it");
        localStorage.removeItem("spinny.machine");
    });

    test("a new file is made from the text in the editor, and a file goes on confirm", async () => {
        localStorage.removeItem("spinny.machine");
        const { store, ctx, root, api } = setup();
        await api.connect("/dev/ttyACM0");
        store.set({ snapshot: connected() });
        mountConfig(root, ctx);
        await settle();
        const pick = root.querySelector("select[aria-label='Machine file']") as HTMLSelectElement;
        pick.value = "polar-laser";
        pick.dispatchEvent(new Event("change"));
        await settle();
        const id = root.querySelector("input[aria-label='New machine id']") as HTMLInputElement;
        id.value = "my-rig";
        click(root, "New");
        await settle();
        expect(pick.value).toBe("my-rig");
        expect(Array.from(pick.options).map((option) => option.value)).toContain("my-rig");
        expect((await api.machineFile("my-rig")).text).toContain('name = "Polar laser"');
        click(root, "Delete");
        await settle();
        dialogButton("Delete").click();
        await settle();
        expect(Array.from(pick.options).map((option) => option.value)).not.toContain("my-rig");
        await expect(api.machineFile("my-rig")).rejects.toBeDefined();
        localStorage.removeItem("spinny.machine");
    });

    test("a load that changes a pin says the board must be saved and restarted", () => {
        expect(changedBootSettings(undefined, { laser_pin: 20 })).toEqual([]);
        const before = { laser_pin: 20, probe_pin: 25, tool_out: 0, tool_pin: 17, tool_invert: 0, r_rate: 1 };
        expect(changedBootSettings(before, { ...before, laser_pin: 23, tool_out: 1, tool_invert: 1, r_rate: 2 })).toEqual(["laser_pin", "tool_out"]);
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

    test("the Log and Wire buttons read the backend's two logs into the console", async () => {
        const { ctx, root, calls } = setup();
        mountConsole(root, ctx);
        calls.length = 0;
        click(root, "Log");
        await settle();
        click(root, "Wire");
        await settle();
        expect(calls.filter((c) => c.name === "log").map((c) => c.args)).toEqual([[100, "spinny"], [100, "wire"]]);
        const log = root.querySelector(".console-log")!;
        expect(log.textContent).toContain("# the backend's log is empty");
        expect(log.textContent).toContain("# the backend's wire log is empty");
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

describe("controls from the machine file", () => {
    // A rig of its own: no pad, no feed, no Center, the rail as X with
    // keys, and a depth axis in a frame without a zero button.
    const rig: Controls = {
        pad: false,
        pad_steps: [1],
        pad_step: 1,
        feed: false,
        center: null,
        centering: false,
        axes: [
            { axis: "r", letter: "X", label: "Rail", steps: [0.5, 5], step: 5, buttons: ["Left", "Right"], feed: false, goto: true, zero: true, zero_hint: "", keys: ["PageDown", "PageUp"], note: "" },
            { axis: "h", letter: "Z", label: "Depth", steps: [0.1, 1], step: 1, buttons: ["Down", "Up"], feed: false, goto: false, zero: false, zero_hint: "", keys: [], note: "Up is positive" },
        ],
    };
    const settingsWith = (controls: Controls): SettingsResponse => ({ values: {}, schema: [], host: { tolerance: 0.01 }, controls });

    test("keys and the goto wording follow the controls", () => {
        expect(keyAction("ArrowLeft", rig)).toBeNull();
        expect(keyAction("PageUp", rig)).toEqual({ axis: "r", sign: 1 });
        expect(keyAction("PageDown", rig)).toEqual({ axis: "r", sign: -1 });
        expect(keyAction("Escape", rig)).toBe("cancel");
        expect(anyOf(["r"])).toBe("r");
        expect(anyOf(["r", "a"])).toBe("r and/or a");
        expect(anyOf(["r", "a", "h"])).toBe("r, a and/or h");
    });

    test("the jog panel draws what the file says, and again when it changes", async () => {
        const { store, ctx, root, calls, api } = setup();
        await api.connect("/dev/ttyACM0");
        store.set({ snapshot: connected() });
        mountJog(root, ctx);
        const labels = (): (string | null)[] => Array.from(root.querySelectorAll("button")).map((b) => b.textContent);
        expect(labels()).toContain("Radius -");
        store.set({ settings: settingsWith(rig) });
        expect(labels()).not.toContain("Radius -");
        expect(labels()).not.toContain("X+");
        expect(labels()).not.toContain("Center");
        expect(labels()).toContain("Cancel");
        expect(labels()).toContain("Set X=0 here");
        expect(labels()).not.toContain("Set Z=0 here");
        expect(root.textContent).not.toContain("Feed mm/min");
        expect(root.querySelector('[data-axis="h"]')?.textContent).toContain("Up is positive");
        click(root, "Right");
        await settle();
        expect(calls.find((c) => c.name === "jog")?.args[0]).toEqual({ kind: "joint", dr: 5, feed: null });
        calls.length = 0;
        click(root, "0.5 mm");
        click(root, "Left");
        await settle();
        expect(calls.find((c) => c.name === "jog")?.args[0]).toEqual({ kind: "joint", dr: -0.5, feed: null });
        calls.length = 0;
        click(root, "Up");
        await settle();
        expect(calls.find((c) => c.name === "jog")?.args[0]).toEqual({ kind: "joint", dh: 1, feed: null });
        calls.length = 0;
        // The goto row has the axes that take one, by their letters.
        const fields = Array.from(root.querySelectorAll("input[placeholder]")).filter((f) => f !== null) as HTMLInputElement[];
        expect(fields.filter((f) => f.placeholder !== "default" && f.placeholder !== "custom").map((f) => f.placeholder)).toEqual(["x"]);
        fields.find((f) => f.placeholder === "x")!.value = "2";
        click(root, "Go");
        await settle();
        expect(calls.find((c) => c.name === "goto")?.args[0]).toEqual({ kind: "joint", feed: null, r: 2 });
        calls.length = 0;
        // Its keys jog it by the step picked.
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", bubbles: true }));
        await settle();
        expect(calls.find((c) => c.name === "jog")?.args[0]).toEqual({ kind: "joint", dr: -0.5, feed: null });
        calls.length = 0;
        // The same controls again: nothing is redrawn, so the step pick stays.
        store.set({ settings: settingsWith(JSON.parse(JSON.stringify(rig)) as Controls) });
        click(root, "Left");
        await settle();
        expect(calls.find((c) => c.name === "jog")?.args[0]).toEqual({ kind: "joint", dr: -0.5, feed: null });
    });

    test("the readout shows the joints the controls name", () => {
        const { store, ctx, root } = setup();
        mountDro(root, ctx);
        store.set({ snapshot: connected({ joint: { r: 1.5, a: 0, z: 0, h: -0.25 } }), settings: settingsWith(rig) });
        const labels = Array.from(root.querySelectorAll(".dro-row-joint .dro-label")).map((n) => n.textContent);
        expect(labels).toEqual(["X", "Z"]);
        expect(root.querySelector('[data-dro="r"]')?.textContent).toBe("1.500");
        expect(root.querySelector('[data-dro="h"]')?.textContent).toBe("-0.250");
        expect(root.querySelector('[data-dro="a"]')).toBeNull();
        // No pad: the board row is hidden.
        expect(root.querySelector('[data-dro="x"]')?.closest(".dro-row")?.classList.contains("hidden")).toBe(true);
        // Back to the defaults: the polar laser's joints and the board.
        store.set({ settings: null });
        expect(Array.from(root.querySelectorAll(".dro-row-joint .dro-label")).map((n) => n.textContent)).toEqual(["R", "A", "Z"]);
        expect(root.querySelector('[data-dro="x"]')?.closest(".dro-row")?.classList.contains("hidden")).toBe(false);
    });
});

describe("jog position row", () => {
    test("Last known fills in the machine's last reported position, run or no run", async () => {
        const { store, ctx, root, api } = setup();
        await api.connect("/dev/ttyACM0");
        store.set({
            snapshot: {
                ...connected(),
                resume: null,
                position: { r: 1.5, a: 30, z: 2.25, h: null, state: "Idle", at: "2026-10-14T03:00:00+00:00" },
            },
        });
        mountJog(root, ctx);
        click(root, "Last known");
        const declared = Array.from(root.querySelectorAll<HTMLInputElement>('input[aria-label^="declare "]'));
        expect(declared.length).toBeGreaterThan(0);
        const byLetter = Object.fromEntries(declared.map((input) => [input.getAttribute("aria-label"), input.value]));
        expect(byLetter["declare R"]).toBe("1.5");
        expect(byLetter["declare A"]).toBe("30");
    });

    test("Last known says when the position is held from before a connect or a restart", async () => {
        const { store, ctx, root, api } = setup();
        await api.connect("/dev/ttyACM0");
        const at = "2026-10-14T03:00:00+00:00";
        store.set({
            snapshot: {
                ...connected(),
                resume: null,
                position: { r: 42.5, a: 117.25, z: 0, h: -3, state: "Idle", at, held: "2026-10-14T03:16:00+00:00" },
            },
        });
        mountJog(root, ctx);
        click(root, "Last known");
        const said = store.get().toasts.map((toast) => toast.text);
        expect(said.some((text) => text.includes("held from before the board was connected again or started over"))).toBe(true);
    });

    test("Last known with nothing reported says so", async () => {
        const { store, ctx, root, api } = setup();
        await api.connect("/dev/ttyACM0");
        store.set({ snapshot: { ...connected(), resume: null, position: null } });
        mountJog(root, ctx);
        click(root, "Last known");
        const declared = Array.from(root.querySelectorAll<HTMLInputElement>('input[aria-label^="declare "]'));
        expect(declared.every((input) => input.value === "")).toBe(true);
    });
});
