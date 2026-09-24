import { describe, expect, test } from "bun:test";

import type { Api } from "../src/api.ts";
import { createContext } from "../src/main.ts";
import { MockBackend } from "../src/mock.ts";
import { button, numberField, setLocked } from "../src/dom.ts";
import { Store, appendConsole, initialState, pushToast, type AppState } from "../src/state.ts";
import type { Machine, Snapshot } from "../src/types.ts";
import { mountConsole } from "../src/views/console.ts";
import { droText, mountDro } from "../src/views/dro.ts";
import { mountJobs, progressText } from "../src/views/jobs.ts";
import { keyAction, mountJog } from "../src/views/jog.ts";
import { confirmSettle } from "../src/confirm.ts";
import { MAX_BEAM_MS, mountLaser } from "../src/views/laser.ts";
import { changedValues, mountSettings } from "../src/views/settings.ts";
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
        expect(droText(machine())).toEqual({ r: "12.345", a: "90.0000", z: "0.000", x: "0.000", y: "12.345", laser: "0.0%", rate: "0", mode: "dyn", queue: "32/16", motors: "on" });
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
        const row = table.querySelectorAll("tbody tr")[0]!;
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
