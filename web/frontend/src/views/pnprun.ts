// Placing with the G-code machine: the plan (the program made from the
// references and the feeders, shown and downloadable; nothing moves), the
// run and its stop, the parts the last run left to place, the feeders
// counted again after a refill, and the run's steps in words: each pick,
// look, place and retry, not each line. With Repeat on, a run that
// finished asks for the next board and places it again; the boards placed
// are counted until reset. A run window floats over the page while a run
// is under way, with its progress, its steps and Stop.

import { askConfirm } from "../confirm.ts";
import { button, el, lockFor, readStored, replace, setLocked, writeStored } from "../dom.ts";
import { formatFixed } from "../format.ts";
import type { AppState } from "../state.ts";
import type { PlacingPlan, PlacingState, PlacingStep } from "../types.ts";
import { into, type Ctx } from "./context.ts";
import { partsLeft, placingRunText, planText } from "./placing.ts";

const REPEAT_KEY = "spinny.pnp.repeat";
const WINDOW_KEY = "spinny.pnp.window";

/** A run's step as a line of the log: its time, its part and what happened. */
export function stepLine(step: PlacingStep): string {
    return `${formatFixed(step.t, 1).padStart(6)} s  ${step.ref ? `${step.ref}: ` : ""}${step.text}`;
}

/** A log box whose text follows its newest line only while scrolled to the bottom; scrolled up to read, it stays put. */
export function stickyLog(box: HTMLElement): (steps: PlacingStep[]) => void {
    let shown = "";
    return (steps) => {
        const key = steps.length > 0 ? `${steps.length} ${stepLine(steps[steps.length - 1]!)} ${stepLine(steps[0]!)}` : "";
        if (key === shown) {
            return;
        }
        const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 8;
        shown = key;
        replace(box, ...steps.map((step) => el("div", { class: `device-step ${step.level}` }, stepLine(step))));
        if (atBottom) {
            box.scrollTop = box.scrollHeight;
        }
    };
}

export function mountPnpRun(root: HTMLElement, ctx: Ctx): void {
    const planButton = button("Plan", () => planNow(), "btn");
    planButton.title = "make the placement program from the references and the feeders and show it; nothing moves";
    const download = el("a", { class: "btn btn-quiet", download: "placement.gcode" }, "Download") as HTMLAnchorElement;
    download.title = "the planned program as a file";
    const run = button("Run", () => runNow(), "btn btn-primary", "place the parts planned");
    const stop = button("Stop", () => into(ctx, "placing", ctx.api.pnpRunStop()), "btn btn-danger", "stop placing");
    const runRest = button("Run the rest", () => runNow(true), "btn");
    runRest.title = "place the parts the last run did not, failed ones included";
    const recount = button("Count feeders again", () => recountFeeders(), "btn btn-quiet");
    recount.title = "every feeder from its first part again, after a refill";
    const fiducialsFirst = el("input", { type: "checkbox", "aria-label": "Find fiducials first" }) as HTMLInputElement;
    const repeat = el("input", { type: "checkbox", "aria-label": "Repeat" }) as HTMLInputElement;
    repeat.checked = readStored(REPEAT_KEY) === "1";
    repeat.addEventListener("change", () => writeStored(REPEAT_KEY, repeat.checked ? "1" : "0"));
    const boards = el("span", { class: "badge device-boards" }, "0 boards");
    const resetBoards = button("Reset", () => into(ctx, "placing", ctx.api.pnpBoardsReset()), "btn btn-quiet btn-small");
    resetBoards.title = "count the boards placed from 0 again";
    const openWindow = button("Run window", () => showWindow(true), "btn btn-quiet");
    openWindow.title = "the run's progress and steps in a window over the page";
    const runLine = el("p", { class: "muted vision-routine" });
    const failedList = el("ul", { class: "device-skipped device-failed" });
    const planLine = el("p", { class: "muted" });
    const skipped = el("ul", { class: "device-skipped" });
    const program = el("pre", { class: "device-program" });
    const programFold = el("details", { class: "device-program-fold" }, el("summary", {}, "G-code"), program);
    const takenLine = el("p", { class: "muted" });
    const log = el("div", { class: "device-steps", "aria-label": "Run steps" });
    const showLog = stickyLog(log);
    let fiducialsTouched = false;
    fiducialsFirst.addEventListener("change", () => {
        fiducialsTouched = true;
    });

    root.append(
        el("div", { class: "panel-head" }, el("h2", {}, "Placing"), boards),
        el("div", { class: "panel-body" },
            el("div", { class: "button-row" }, planButton, download, run, stop),
            el("div", { class: "button-row" }, runRest, recount, openWindow),
            el("div", { class: "button-row" },
                el("label", { class: "muted" }, fiducialsFirst, " find fiducials first"),
                el("label", { class: "muted", title: "after each board, ask for the next one and place it again" }, repeat, " repeat"),
                resetBoards,
            ),
            runLine,
            failedList,
            log,
            planLine,
            skipped,
            programFold,
            takenLine,
        ),
    );

    // The run window, over the page, while a run is under way.
    const windowLine = el("p", { class: "muted vision-routine" });
    const windowBar = el("progress", { class: "device-run-bar", max: "1", value: "0" }) as HTMLProgressElement;
    const windowLog = el("div", { class: "device-steps", "aria-label": "Run window steps" });
    const showWindowLog = stickyLog(windowLog);
    const windowStop = button("Stop", () => into(ctx, "placing", ctx.api.pnpRunStop()), "btn btn-danger", "stop placing");
    const windowClose = button("Close", () => showWindow(false), "btn btn-quiet btn-small");
    const runWindow = el("div", { class: "run-window panel hidden", role: "dialog", "aria-label": "Run window" },
        el("div", { class: "panel-head run-window-head" }, el("h2", {}, "Placing"), windowClose),
        el("div", { class: "panel-body" }, windowLine, windowBar, windowLog, el("div", { class: "button-row" }, windowStop)),
    );
    document.body.append(runWindow);
    let windowWanted = readStored(WINDOW_KEY) !== "0";

    function showWindow(open: boolean): void {
        runWindow.classList.toggle("hidden", !open);
        if (!open && ctx.store.get().placing?.running) {
            // Closed by hand during a run: not opened again by itself until the next run.
            windowWanted = false;
        }
    }

    // The window can be dragged by its head.
    const head = runWindow.querySelector(".run-window-head") as HTMLElement;
    head.addEventListener("pointerdown", (event) => {
        if ((event.target as HTMLElement).closest("button")) {
            return;
        }
        const box = runWindow.getBoundingClientRect();
        const dx = event.clientX - box.left;
        const dy = event.clientY - box.top;
        const move = (next: PointerEvent): void => {
            runWindow.style.left = `${Math.max(0, next.clientX - dx)}px`;
            runWindow.style.top = `${Math.max(0, next.clientY - dy)}px`;
            runWindow.style.right = "auto";
            runWindow.style.bottom = "auto";
        };
        const up = (): void => {
            document.removeEventListener("pointermove", move);
            document.removeEventListener("pointerup", up);
        };
        document.addEventListener("pointermove", move);
        document.addEventListener("pointerup", up);
    });

    let plan: PlacingPlan | null = null;
    // The job the plan shown is of: the download is its program, once one planned.
    let planJob: string | null = null;

    async function planNow(): Promise<void> {
        const job = ctx.store.get().job;
        if (!job) {
            ctx.toast("error", "pick a board job first");
            return;
        }
        const result = await ctx.call(ctx.api.pnpPlan(job.id));
        if (result) {
            plan = result;
            planJob = job.id;
            renderPlan();
        }
    }

    async function runNow(rest = false, again = false): Promise<void> {
        const state = ctx.store.get();
        const job = state.job;
        if (!job) {
            ctx.toast("error", "pick a board job first");
            return;
        }
        const refs = rest ? partsLeft(state.placing, plan, job.id) : undefined;
        if (rest && refs!.length === 0) {
            ctx.toast("info", "the last run placed every part");
            return;
        }
        const planned = await ctx.call(ctx.api.pnpPlan(job.id, refs));
        if (!planned) {
            return;
        }
        plan = planned;
        planJob = job.id;
        renderPlan();
        const device = state.placing?.name ?? state.placing?.machine ?? "the machine";
        const left = planned.skipped.length > 0 ? ` ${planned.skipped.length} parts left out (listed below).` : "";
        const first = fiducialsFirst.checked ? " Fiducials are found first." : "";
        const question = again
            ? `Board ${(state.placing?.boards ?? 0) + 1}: put the next board in place. Place ${planned.parts.length} parts on it with ${device}?${first}`
            : `Place ${planned.parts.length} parts with ${device}? The head moves and the vacuum switches.${first}${left}`;
        if (!(await askConfirm(question, again ? "Place next board" : "Run"))) {
            return;
        }
        const started = await ctx.call(ctx.api.pnpRun(job.id, refs, fiducialsFirst.checked));
        if (started) {
            const { parts, skipped: left2, fit, lines, text, ...rest2 } = started;
            plan = { parts, skipped: left2, fit, lines, text };
            renderPlan();
            ctx.store.set({ placing: rest2 as PlacingState });
            windowWanted = readStored(WINDOW_KEY) !== "0";
            showWindow(windowWanted);
        }
    }

    async function recountFeeders(): Promise<void> {
        if (await askConfirm("Restart every feeder at its first part? Do this after refilling.", "Count again")) {
            await into(ctx, "placing", ctx.api.pnpResetFeeders());
        }
    }

    function renderPlan(): void {
        // Only a program that planned is offered for download: a refused one
        // would save the refusal as the file.
        const job = ctx.store.get().job;
        const ready = plan !== null && planJob !== null && job?.id === planJob;
        download.href = ready ? ctx.api.pnpProgramUrl(planJob!) : "";
        download.classList.toggle("disabled", !ready);
        planLine.textContent = plan ? planText(plan) : "";
        replace(skipped, ...(plan?.skipped ?? []).map((entry) => el("li", {}, `${entry.ref}: ${entry.reason}`)));
        program.textContent = plan?.text ?? "";
        programFold.classList.toggle("hidden", plan === null);
    }

    // The run last seen under way, to ask for the next board when it ends.
    let wasRunning = false;
    function render(state: AppState): void {
        const device = state.placing;
        const connected = device?.connected === true;
        const running = device?.running === true;
        const job = state.job;
        if (planJob !== null && job?.id !== planJob) {
            // Another job: its plan is not the one shown.
            plan = null;
            planJob = null;
            renderPlan();
        }
        const top = device?.top;
        const measured = top?.offset !== null && top?.offset !== undefined && (top?.mm_per_px ?? 0) > 0;
        const hasFiducials = state.components?.job === job?.id && (state.components?.components ?? []).some((part) => part.fiducial);
        // Ticked once it can be, unless the operator has had a say.
        if (!measured || !hasFiducials) {
            fiducialsFirst.checked = false;
        } else if (!fiducialsTouched) {
            fiducialsFirst.checked = true;
        }
        fiducialsFirst.disabled = !measured || !hasFiducials;
        lockFor(planButton, [!job, "pick a board job first"], [!device?.machine, "no G-code machine to place with: connect one from the top bar"]);
        lockFor(run, [!connected, "connect the machine first"], [running, "a run is under way"], [!job, "pick a board job first"]);
        setLocked(stop, !running, "no run under way");
        setLocked(windowStop, !running, "no run under way");
        lockFor(runRest, [!connected, "connect the machine first"], [running, "a run is under way"], [partsLeft(device, plan, job?.id ?? null).length === 0, "the last run left no part of this job"]);
        setLocked(recount, running, "a run is under way");
        const count = device?.boards ?? 0;
        boards.textContent = `${count} board${count === 1 ? "" : "s"}`;
        lockFor(resetBoards, [running, "a run is under way"], [count === 0, "no board counted yet"]);
        const text = device?.lost ? `Link lost: ${device.lost}` : placingRunText(device);
        runLine.textContent = text;
        windowLine.textContent = text;
        const progress = device?.progress;
        windowBar.value = progress && progress.total > 0 ? progress.sent / progress.total : 0;
        replace(failedList, ...(progress?.job === job?.id ? progress?.failed ?? [] : []).map((entry) => el("li", {}, `${entry.ref} left out: ${entry.reason}`)));
        const steps = progress?.steps ?? [];
        showLog(steps);
        showWindowLog(steps);
        log.classList.toggle("hidden", steps.length === 0);
        const taken = Object.entries(device?.taken ?? {});
        takenLine.textContent = taken.length > 0 ? `Picked so far: ${taken.map(([feeder, picked]) => `${feeder} ${picked}`).join(", ")}` : "";
        if (running && windowWanted && runWindow.classList.contains("hidden") && !wasRunning) {
            showWindow(true);
        }
        if (wasRunning && !running) {
            if (progress?.state === "done" && repeat.checked) {
                // The next board, once the operator says it is in place.
                void runNow(false, true);
            }
        }
        wasRunning = running;
    }

    ctx.store.subscribe((state) => render(state), ["placing", "job", "components"]);
    render(ctx.store.get());
    renderPlan();
}
