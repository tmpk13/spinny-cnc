import { describe, expect, test } from "bun:test";

import type { Api } from "../src/api.ts";
import { createContext } from "../src/main.ts";
import { MockBackend } from "../src/mock.ts";
import { button, setLocked } from "../src/dom.ts";
import { Store, appendConsole, initialState, pushToast, type AppState } from "../src/state.ts";
import type { Machine, Snapshot } from "../src/types.ts";
import { mountConsole } from "../src/views/console.ts";
import { droText, mountDro } from "../src/views/dro.ts";
import { mountJobs, progressText } from "../src/views/jobs.ts";
import { keyAction, mountJog } from "../src/views/jog.ts";
import { mountLaser } from "../src/views/laser.ts";
import { changedValues, mountSettings } from "../src/views/settings.ts";
import { mountStatusBar } from "../src/views/statusbar.ts";
import { mountToasts } from "../src/views/toasts.ts";

function machine(overrides: Partial<Machine> = {}): Machine {
    return {
        state: "Idle",
        alarm: null,
        joint: { r: 12.345, a: 90 },
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
function recordingApi(): { api: Api; calls: { name: string; args: unknown[] }[] } {
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
    return { api, calls };
}

function setup() {
    const store = new Store<AppState>(initialState(true));
    const { api, calls } = recordingApi();
    const ctx = createContext(api, store);
    const root = document.createElement("section");
    document.body.appendChild(root);
    return { store, api, calls, ctx, root };
}

function click(root: ParentNode, label: string): void {
    const button = Array.from(root.querySelectorAll("button")).find((b) => b.textContent === label);
    if (!button) {
        throw new Error(`no button ${label}`);
    }
    button.click();
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

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
        expect(droText(machine())).toEqual({ r: "12.345", a: "90.0000", x: "0.000", y: "12.345", laser: "0.0%", rate: "0", mode: "dyn", queue: "32/16", motors: "on" });
        expect(droText(null).r).toBe("-.---");
    });

    test("renders the snapshot", () => {
        const { store, ctx, root } = setup();
        mountDro(root, ctx);
        store.set({ snapshot: connected({ laser: 500, rate: 399.6 }) });
        expect(root.querySelector('[data-dro="r"]')?.textContent).toBe("12.345");
        expect(root.querySelector('[data-dro="a"]')?.textContent).toBe("90.0000");
        expect(root.querySelector('[data-dro="laser"]')?.textContent).toBe("50.0%");
        expect(root.querySelector('[data-dro="rate"]')?.textContent).toBe("400");
        expect(root.classList.contains("laser-on")).toBe(true);
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

    test("a board goto fills the blank axis from the readout", async () => {
        const { store, ctx, root, calls, api } = setup();
        await api.connect("/dev/ttyACM0");
        store.set({ snapshot: connected({ joint: { r: 5, a: 90 }, board: { x: 0, y: 5 } }) });
        mountJog(root, ctx);
        const fields = Array.from(root.querySelectorAll("input[placeholder]")) as HTMLInputElement[];
        const x = fields.find((f) => f.placeholder === "x")!;
        x.value = "3";
        const goBoard = Array.from(root.querySelectorAll("button")).filter((b) => b.textContent === "Go")[0]!;
        goBoard.click();
        await settle();
        expect(calls.find((c) => c.name === "goto")?.args[0]).toEqual({ kind: "board", x: 3, y: 5, feed: null });
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
        expect(progressText(null)).toEqual({ bar: 0, counts: "", time: "", state: "" });
        const text = progressText({ job: "a", state: "running", sent: 120, acked: 118, total: 900, seconds: 12.5, estimate: 95, group: 0 });
        expect(text.bar).toBeCloseTo(118 / 900, 9);
        expect(text.counts).toBe("120 sent / 118 acked / 900");
        expect(text.time).toBe("0:13 / 1:35");
    });

    test("list and groups of the selected job", async () => {
        const { store, ctx, root, api } = setup();
        mountJobs(root, ctx);
        await ctx.refreshJobs();
        expect(root.querySelectorAll("li").length).toBe(1);
        const jobs = await api.jobs();
        await ctx.selectJob(jobs[0]!.id);
        expect(root.querySelectorAll("table.groups tbody tr").length).toBe(4);
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
        // The next test asks again rather than remembering the answer.
        click(root, "Test beam");
        await settle();
        expect(document.querySelector("dialog[open]")).not.toBeNull();
        dialogButton("Cancel").click();
        await settle();
        expect(calls.filter((c) => c.name === "laser").length).toBe(1);
    });

    test("changed values and the settings table", async () => {
        const { store, ctx, root, api } = setup();
        mountSettings(root, ctx);
        const settings = await api.settings();
        store.set({ settings });
        expect(root.querySelectorAll("table.settings tbody tr").length).toBe(settings.schema.length);
        expect(changedValues(settings, { r_rate: 1000, a_rate: 500 })).toEqual({ a_rate: 500 });
        const input = root.querySelector('input[aria-label="r_rate"]') as HTMLInputElement;
        input.value = "900";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        expect(input.closest("tr")?.classList.contains("edited")).toBe(true);
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

    test("toasts render and can be dismissed", () => {
        const { store, ctx, root } = setup();
        mountToasts(root, ctx);
        pushToast(store, "error", "oops");
        expect(root.querySelector(".toast.error")?.textContent).toBe("oops");
        (root.querySelector(".toast") as HTMLElement).click();
        expect(root.children.length).toBe(0);
    });
});
