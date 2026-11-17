// Home: where things stand, the one next thing to do, what needs someone.

import { afterEach, describe, expect, test } from "bun:test";
import { machineLine, mountHomeNeeds, mountOverview, needsOf, nextAction } from "../src/views/overview.ts";
import type { AppState } from "../src/state.ts";
import type { Job, JobSummary, Port, Progress } from "../src/types.ts";
import { connected, findButton, settle, setup } from "./harness.ts";

afterEach(() => {
    document.body.replaceChildren();
    document.getElementById("app")?.removeAttribute("data-page");
    localStorage.removeItem("spinny.page");
    localStorage.removeItem("spinny.recent");
});

const port: Port = { url: "/dev/serial/by-id/usb-spinny_laser-if00", device: "/dev/ttyACM0", description: "spinny laser controller", product: "spinny laser controller", kind: "usb", spinny: true };
const summary = { id: "a1", name: "board", source: "gerber", spot: 0.1, offset: { x: 0, y: 0 }, groups: [], stats: { length_mm: 120, seconds: 90 } } as unknown as JobSummary;
const job = { ...summary, outline: [], copper: [], groups: [] } as unknown as Job;
const progress: Progress = { job: "a1", state: "running", sent: 60, acked: 50, total: 200, seconds: 3, estimate: 9, group: 0 } as Progress;

describe("the next thing to do", () => {
    test("with nothing connected it is to connect: the port found on the button, else where a port is typed", () => {
        const { store } = setup();
        const state = store.get();
        expect(nextAction({ ...state, ports: [] })).toMatchObject({ kind: "ports", title: "Connect the machine", label: "Machines and ports", step: null });
        expect(nextAction({ ...state, ports: [port] })).toMatchObject({ kind: "connect", label: "Connect spinny laser controller", detail: "spinny laser controller is plugged in." });
    });

    test("connected, it is the Run area's first step a run needs that is not done", () => {
        const { store } = setup();
        const state: AppState = { ...store.get(), snapshot: connected(), jobs: [summary] };
        // No job picked: the Job step.
        expect(nextAction(state)).toMatchObject({ kind: "step", step: "job", label: "Continue: Job", detail: "No job picked yet." });
        // A job picked: the run itself, whose button names it.
        const picked = nextAction({ ...state, job });
        expect(picked).toMatchObject({ kind: "step", step: "run", title: "Run", label: "Go to Run" });
        expect(picked.detail).toStartWith("board: ");
    });

    test("a run under way comes before everything", () => {
        const { store } = setup();
        const state: AppState = { ...store.get(), snapshot: connected(), jobs: [summary], job, progress };
        expect(nextAction(state)).toMatchObject({ kind: "run", title: "A run is under way", detail: "Running board: 25%.", label: "Show the run", step: "run" });
        expect(nextAction({ ...state, progress: { ...progress, state: "hold" } })).toMatchObject({ title: "A run is held", detail: "Holding board: 25%." });
    });

    test("the machine in a line", () => {
        const { store } = setup();
        const state = store.get();
        expect(machineLine(state)).toBe("No machine is connected.");
        // The harness's machine has a focus axis: its kind is named.
        expect(machineLine({ ...state, snapshot: connected() })).toEndWith("is connected, idle.");
        expect(machineLine({ ...state, snapshot: connected({ state: "Alarm", alarm: 2 }) })).toEndWith("is connected, in alarm 2.");
    });
});

describe("the Next panel", () => {
    test("says the machine, the next thing and what is so, and its one button connects the port found", async () => {
        const { ctx, root, store } = setup();
        mountOverview(root, ctx);
        expect(root.querySelector(".home-machine")?.textContent).toBe("No machine is connected.");
        expect(root.querySelector(".home-title")?.textContent).toBe("Connect the machine");
        expect(root.querySelectorAll("button.btn-primary").length).toBe(1);
        await ctx.refreshPorts();
        const go = root.querySelector<HTMLButtonElement>(".home-go")!;
        expect(go.textContent).toStartWith("Connect ");
        go.click();
        await settle();
        await settle();
        expect(store.get().snapshot.connected).toBe(true);
        // Connected, with no job picked: on to the Job step.
        expect(root.querySelector(".home-title")?.textContent).toStartWith("Job: ");
        expect(findButton(root, "Continue: Job")).toBeTruthy();
    });

    test("its button goes to the Run area at the step named", () => {
        const { ctx, root, store } = setup();
        const app = document.createElement("div");
        app.id = "app";
        document.body.append(app);
        store.set({ snapshot: connected(), jobs: [summary], job });
        mountOverview(root, ctx);
        findButton(root, "Go to Run").click();
        expect(app.getAttribute("data-page")).toBe("run");
        app.remove();
    });
});

describe("Needs you", () => {
    test("lists what the Checklist says someone has to do now, each with its link", () => {
        const { ctx, root, store } = setup();
        mountHomeNeeds(root, ctx);
        const needs = needsOf(store.get());
        // With nothing connected the connection is the thing missing.
        expect(needs.some((fact) => fact.id === "link.port")).toBe(true);
        const lines = Array.from(root.querySelectorAll(".home-need"));
        expect(lines.length).toBe(needs.length);
        expect(lines[0]!.querySelector(".home-need-name")?.textContent).toBe(needs[0]!.label);
        expect(lines[0]!.querySelector("a")?.textContent).toBe(needs[0]!.action);
        expect((root.querySelector(".home-needs") as HTMLElement).hidden).toBe(false);
    });
});
