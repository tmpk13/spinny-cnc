import { describe, expect, test } from "bun:test";

import type { Api } from "../src/api.ts";
import { createContext } from "../src/main.ts";
import { MockBackend } from "../src/mock.ts";
import { POLAR_LASER, isCartesian, isMilling, profileBadge, profileOf } from "../src/profile.ts";
import { Store, initialState, type AppState } from "../src/state.ts";
import type { Machine, Profile, Snapshot } from "../src/types.ts";
import { Preview } from "../src/preview.ts";
import { mountDro } from "../src/views/dro.ts";
import { jobLabels, mountJobs } from "../src/views/jobs.ts";
import { mountJog } from "../src/views/jog.ts";
import { mountLaser } from "../src/views/laser.ts";
import { mountSettings } from "../src/views/settings.ts";
import { mountStatusBar } from "../src/views/statusbar.ts";

function machine(overrides: Partial<Machine> = {}): Machine {
    return {
        state: "Idle",
        alarm: null,
        joint: { r: 3, a: 0, z: 4, h: 0 },
        board: { x: 3, y: 4 },
        rate: 0,
        laser: 0,
        mode: "dyn",
        enabled: true,
        queue: { planner: 32, lines: 16 },
        ...overrides,
    };
}

function snapshot(profile: Partial<Profile>, overrides: Partial<Machine> = {}): Snapshot {
    return {
        connected: true,
        url: "/dev/ttyACM0",
        firmware: { version: "0.1.0", lines: 16, blocks: 32 },
        machine: machine(overrides),
        profile: { ...POLAR_LASER, ...profile },
        run: null,
    };
}

/** An API that records calls, backed by the in-page mock. */
function setup() {
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
    const store = new Store<AppState>(initialState(true));
    const ctx = createContext(api, store);
    const root = document.createElement("section");
    document.body.appendChild(root);
    return { store, api, calls, ctx, root, backend };
}

function click(root: ParentNode, label: string): void {
    const found = Array.from(root.querySelectorAll("button")).find((b) => b.textContent === label);
    if (!found) {
        throw new Error(`no button ${label}`);
    }
    found.click();
}

function dialogButton(label: string): HTMLButtonElement {
    const dialog = document.querySelector("dialog[open]");
    if (!dialog) {
        throw new Error("no confirm dialog");
    }
    return Array.from(dialog.querySelectorAll("button")).find((b) => b.textContent === label)!;
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("profile", () => {
    test("a backend that does not say is a polar laser", () => {
        const plain: Snapshot = { connected: false, url: null, firmware: null, machine: null, run: null };
        expect(profileOf(plain)).toEqual(POLAR_LASER);
        expect(isCartesian(plain) || isMilling(plain)).toBe(false);
        expect(profileBadge(POLAR_LASER)).toBe("");
    });

    test("the badge names what differs", () => {
        expect(profileBadge({ ...POLAR_LASER, kinematics: "cartesian" })).toBe("X/Y");
        expect(profileBadge({ ...POLAR_LASER, tool: "spindle" })).toBe("spindle");
        expect(profileBadge({ ...POLAR_LASER, kinematics: "cartesian", tool: "spindle" })).toBe("X/Y spindle");
    });

    test("the status bar shows it only for a machine that is not the polar laser", () => {
        const { store, ctx, root } = setup();
        mountStatusBar(root, ctx);
        const badge = root.querySelector(".badge.profile")!;
        store.set({ snapshot: snapshot({}) });
        expect(badge.classList.contains("hidden")).toBe(true);
        store.set({ snapshot: snapshot({ kinematics: "cartesian", tool: "spindle" }) });
        expect(badge.classList.contains("hidden")).toBe(false);
        expect(badge.textContent).toBe("X/Y spindle");
    });
});

describe("spindle", () => {
    test("the laser panel turns into spindle controls, and a start asks first", async () => {
        const { store, ctx, root, calls, api, backend } = setup();
        await api.connect("/dev/ttyACM0");
        await api.updateSettings({ values: { spindle: 1 } });
        mountLaser(root, ctx);
        store.set({ snapshot: snapshot({ tool: "spindle" }) });
        expect(root.querySelector("h2")?.textContent).toBe("Spindle");
        expect(root.querySelector(".tool-laser")?.classList.contains("hidden")).toBe(true);
        expect(root.querySelector(".tool-spindle")?.classList.contains("hidden")).toBe(false);
        click(root, "Start spindle");
        await settle();
        dialogButton("Cancel").click();
        await settle();
        expect(calls.some((c) => c.name === "spindle")).toBe(false);
        click(root, "Start spindle");
        await settle();
        dialogButton("Start").click();
        await settle();
        expect(calls.find((c) => c.name === "spindle")?.args).toEqual([800]);
        expect(backend.machine.spindle).toBe(800);
        expect(backend.snapshot().machine?.laser).toBe(800);
        click(root, "Stop spindle");
        await settle();
        expect(backend.machine.spindle).toBe(0);
        // Back on a laser machine the beam test is there again.
        store.set({ snapshot: snapshot({ tool: "laser" }) });
        expect(root.querySelector("h2")?.textContent).toBe("Laser");
        expect(root.querySelector(".tool-laser")?.classList.contains("hidden")).toBe(false);
    });

    test("the mock refuses a spindle on a laser machine and a beam on a spindle one", async () => {
        const backend = new MockBackend({ timers: false });
        await backend.connect("/dev/ttyACM0");
        expect(backend.snapshot().profile).toEqual({ kinematics: "polar", tool: "laser", h_axis: true, r_max: 0, z_max: 0 });
        await expect(backend.spindle(300)).rejects.toThrow();
        await backend.updateSettings({ values: { spindle: 1, cartesian: 1, z_max: 8 } });
        expect(backend.snapshot().profile).toEqual({ kinematics: "cartesian", tool: "spindle", h_axis: true, r_max: 0, z_max: 8 });
        await expect(backend.laser(100, 100)).rejects.toThrow();
        await backend.spindle(300);
        expect(backend.machine.spindle).toBe(300);
        await backend.realtime("reset");
        expect(backend.machine.spindle).toBe(0);
        await expect(backend.updateSettings({ values: { spindle: 2 } })).rejects.toThrow();
    });

    test("a milling machine's group table has depth and plunge in place of the floor", async () => {
        const { store, ctx, root, calls, api } = setup();
        await api.connect("/dev/ttyACM0");
        mountJobs(root, ctx);
        store.set({ snapshot: snapshot({ tool: "spindle" }) });
        await ctx.refreshJobs();
        const jobs = await api.jobs();
        await ctx.selectJob(jobs[0]!.id);
        const heads = Array.from(root.querySelectorAll("table.groups thead th")).map((th) => th.textContent);
        expect(heads).toEqual(["S", "Depth", "mm/min", "Plunge", "Passes", "On"]);
        const depth = root.querySelector('table.groups input[aria-label="depth"]') as HTMLInputElement;
        expect(depth.value).toBe("0.1");
        depth.value = "0.25";
        depth.dispatchEvent(new Event("change"));
        await settle();
        const patch = calls.find((c) => c.name === "patchJob")?.args[1] as { groups: Record<string, unknown>[] };
        expect(patch.groups[0]!["depth"]).toBe(0.25);
        expect("min_power" in patch.groups[0]!).toBe(false);
        // The height map can only be followed with the depth axis.
        const power = root.querySelector('select option[value="power"]') as HTMLOptionElement;
        expect(power.disabled).toBe(true);
        expect(jobLabels(true).power).toBe("Spindle S");
        const labels = Array.from(root.querySelectorAll(".field-grid .labeled-text")).map((span) => span.textContent);
        expect(labels.slice(0, 3)).toEqual(["Spindle S", "Feed mm/min", "Tool mm"]);
        // A laser machine gets its own columns back.
        store.set({ snapshot: snapshot({ tool: "laser" }) });
        const back = Array.from(root.querySelectorAll("table.groups thead th")).map((th) => th.textContent);
        expect(back).toEqual(["S", "Min S", "mm/min", "Passes", "On"]);
    });

    test("the settings panel keeps the milling clearance and spin-up", async () => {
        const { store, ctx, root, calls, api } = setup();
        await api.connect("/dev/ttyACM0");
        mountSettings(root, ctx);
        store.set({ snapshot: snapshot({ tool: "spindle" }) });
        await ctx.refreshSettings();
        const fields = Array.from(root.querySelectorAll(".labeled")).filter((label) => label.textContent?.startsWith("Travel"));
        expect(fields.length).toBe(1);
        const clearance = fields[0]!.querySelector("input") as HTMLInputElement;
        expect(clearance.value).toBe("2");
        clearance.value = "3.5";
        click(root, "Apply");
        await settle();
        await settle();
        const update = calls.find((c) => c.name === "updateSettings")?.args[0] as { host: Record<string, number> };
        expect(update.host["clearance"]).toBe(3.5);
        expect((await api.settings()).host.clearance).toBe(3.5);
    });
});

describe("cartesian", () => {
    test("the cross slide is the Y axis: main step, feed, and a joint goto beside the radius", async () => {
        const { store, ctx, root, calls, api } = setup();
        await api.connect("/dev/ttyACM0");
        mountJog(root, ctx);
        store.set({ snapshot: snapshot({ kinematics: "cartesian" }) });
        const slide = root.querySelector(".slide")!;
        expect(slide.textContent).toContain("Cross slide (Y)");
        click(slide, "Z+");
        await settle();
        expect(calls.find((c) => c.name === "jog")?.args[0]).toEqual({ kind: "joint", dz: 1, feed: null });
        calls.length = 0;
        const [feedField] = Array.from(root.querySelectorAll(".steps input")) as HTMLInputElement[];
        feedField!.value = "300";
        click(slide, "Z-");
        await settle();
        expect(calls.find((c) => c.name === "jog")?.args[0]).toEqual({ kind: "joint", dz: -1, feed: 300 });
        calls.length = 0;
        const z = root.querySelector('input[placeholder="z"]') as HTMLInputElement;
        const a = root.querySelector('input[placeholder="a"]') as HTMLInputElement;
        expect(z.classList.contains("hidden")).toBe(false);
        expect(a.classList.contains("hidden")).toBe(true);
        (root.querySelector('input[placeholder="r"]') as HTMLInputElement).value = "5";
        z.value = "-2";
        const goButtons = Array.from(root.querySelectorAll(".goto-row")).map((row) => row.querySelector("button")!);
        goButtons[1]!.click();
        await settle();
        expect(calls.find((c) => c.name === "goto")?.args[0]).toEqual({ kind: "joint", feed: 300, r: 5, z: -2 });
        // A polar machine keeps the setup control.
        store.set({ snapshot: snapshot({}) });
        expect(slide.textContent).toContain("Setup only");
        expect(z.classList.contains("hidden")).toBe(true);
    });

    test("the depth axis is named as such on a spindle machine", () => {
        const { store, ctx, root } = setup();
        mountJog(root, ctx);
        store.set({ snapshot: snapshot({ tool: "spindle", h_axis: true }) });
        const focus = root.querySelector(".focus-axis")!;
        expect(focus.classList.contains("hidden")).toBe(false);
        expect(focus.textContent).toContain("Depth axis");
    });
});

describe("readouts", () => {
    test("the DRO names the output after the tool", () => {
        const { store, ctx, root } = setup();
        mountDro(root, ctx);
        store.set({ snapshot: snapshot({ tool: "spindle" }, { laser: 700 }) });
        expect(root.textContent).toContain("Spindle");
        expect(root.textContent).not.toContain("Laser");
        store.set({ snapshot: snapshot({}, { laser: 0 }) });
        expect(root.textContent).toContain("Laser");
    });

    test("the preview puts the head where the backend says, not at the joint's polar point", () => {
        const canvas = document.createElement("canvas");
        document.body.appendChild(canvas);
        const preview = new Preview(canvas);
        preview.setHead({ r: 3, a: 0 }, { x: 3, y: 4 });
        preview.setHead({ r: 3, a: 0 }, { x: 3, y: 5 });
        const trail = (preview as unknown as { trail: [number, number][] }).trail;
        expect(trail).toEqual([[3, 4], [3, 5]]);
        // Without a board point it falls back to the polar one.
        preview.clearTrail();
        preview.setHead({ r: 5, a: 90 });
        const [x, y] = (preview as unknown as { trail: [number, number][] }).trail[0]!;
        expect(x).toBeCloseTo(0, 9);
        expect(y).toBeCloseTo(5, 9);
        preview.dispose();
        canvas.remove();
    });
});
