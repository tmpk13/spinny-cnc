// Jog panel, drawn from the machine's controls (controls.ts): one bar per
// axis, each with its steps (the choices, and a step typed in beside
// them), its minus and plus buttons and its zero button. The board's X and
// Y bars come first on a machine with a pad, and the arrow keys drive
// them. Below: the feed field, goto fields, Center, motors and unlock; the
// cancel button sits in the panel's head, away from every move. Which
// joints there are, what they are called, how they step and whether the
// feed applies is the machine file's; the panel only draws it, and draws
// it again when the controls change. Escape cancels a jog or goto from
// anywhere but a dialog while a machine is connected, and leaves a text
// field, so the next arrow key jogs. In the head: Fine, which jogs every
// bar by its smallest step (so does holding Shift with a jog key), and
// Hold to move, under which a button or key held moves the axis until let
// go, the step read as the distance per second.

import { askConfirm } from "../confirm.ts";
import { controlOf, controlsOf, sameControls, unitOf } from "../controls.ts";
import { activePage, button, el, inputHasFocus, labeled, lockFieldset, modalOpen, numberField, onEnter, readStored, replace, setLocked, writeStored } from "../dom.ts";
import { parseNumber } from "../format.ts";
import { gotoPlanText, type PlanInput, type PlanWant } from "../gotoplan.ts";
import { profileOf } from "../profile.ts";
import type { AppState } from "../state.ts";
import type { AxisControl, Controls, GotoRequest, JogRequest, JointAxis, Tool } from "../types.ts";
import { choiceRow, setPressed, type Ctx } from "./context.ts";

export type KeyAction = { dx: number; dy: number } | { axis: JointAxis; sign: 1 | -1 } | "cancel" | null;

/** A bar: the board's X or Y, or a joint. */
export type BarId = "x" | "y" | JointAxis;

/**
 * Maps a key to a board jog in step units, a joint jog by its step, or a
 * cancel; null when the key is not bound. The arrow keys jog the board
 * when the controls have the pad.
 */
export function keyAction(key: string, controls: Controls): KeyAction {
    if (key === "Escape") {
        return "cancel";
    }
    if (controls.pad) {
        switch (key) {
            case "ArrowLeft":
                return { dx: -1, dy: 0 };
            case "ArrowRight":
                return { dx: 1, dy: 0 };
            case "ArrowUp":
                return { dx: 0, dy: 1 };
            case "ArrowDown":
                return { dx: 0, dy: -1 };
        }
    }
    for (const axis of controls.axes) {
        const at = axis.keys.indexOf(key);
        if (at === 0) {
            return { axis: axis.axis, sign: -1 };
        }
        if (at === 1) {
            return { axis: axis.axis, sign: 1 };
        }
    }
    return null;
}

/** "r", "r and/or a", "r, a and/or h": the fields a goto row wants at least one of. */
export function anyOf(names: string[]): string {
    if (names.length <= 1) {
        return names[0] ?? "";
    }
    return `${names.slice(0, -1).join(", ")} and/or ${names[names.length - 1]}`;
}

/** How often a held jog sends its next piece, ms, and the longest a hold runs without a release, s. */
export const HOLD_TICK_MS = 100;
export const HOLD_LIMIT_S = 60;
const SMOOTH_KEY = "spinny.jog.smooth";

/** The smallest of a bar's step choices: what Fine jogs by. */
export function fineStep(choices: number[]): number {
    return Math.min(...choices);
}

/**
 * The distance a held jog sends for `seconds` since its last piece, at
 * `rate` per second: at least a tick's worth, so the first piece fills the
 * queue, and at most three ticks', so a late tick does not lurch.
 */
export function holdPiece(rate: number, seconds: number): number {
    const tick = HOLD_TICK_MS / 1000;
    return rate * Math.min(3 * tick, Math.max(tick, seconds));
}

/** The travel height's bounds, mm: an H, so it may be below H 0. */
export const TRAVEL_LIMIT = 100;

/** The travel height typed: a number, null for a blank field (off), or what is wrong with it. */
export function readTravel(text: string): { travel: number | null } | { problem: string } {
    if (text.trim() === "") {
        return { travel: null };
    }
    const value = parseNumber(text);
    if (value === null || Math.abs(value) > TRAVEL_LIMIT) {
        return { problem: `travel height: -${TRAVEL_LIMIT} to ${TRAVEL_LIMIT} mm, or blank` };
    }
    return { travel: value };
}

/** What the travel row says it does: rise to the height before moving across, or nothing. */
export function travelText(travel: number | null | undefined): string {
    if (travel === null || travel === undefined) {
        return "off: moves go across at the current height";
    }
    return `moves rise to H ${travel} before going across, unless higher`;
}

/** `page` is the page whose panel this is: its keys jog only while that page shows. */
/**
 * Mounts the jog panel in `root` for the page `page`, whose arrow keys it
 * answers; `active` says when they are its at all. The panel jogs the
 * machine connected, whichever it is: a G-code machine's file draws its
 * bars as any other machine file does.
 */
export function mountJog(root: HTMLElement, ctx: Ctx, page = "jobs", active: () => boolean = () => true): void {
    // The step of each bar, kept across a redraw: the choice pressed, and
    // a step typed in, which is the step while it is there.
    const picks = new Map<BarId, number>();
    const typed = new Map<BarId, number>();
    const feedInput = numberField({ placeholder: "default", min: 0 });
    const feed = (): number | null => parseNumber(feedInput.value);
    const cancelButton = button("Cancel", () => cancel(), "btn btn-danger btn-small");
    cancelButton.title = "stop a jog or goto (Escape)";
    // Fine: every bar jogs by its smallest step while pressed.
    let fine = false;
    const fineButton = button("Fine", () => {
        fine = !fine;
        fineButton.setAttribute("aria-pressed", String(fine));
    }, "btn btn-quiet btn-small btn-toggle");
    fineButton.setAttribute("aria-pressed", "false");
    fineButton.title = "jog every axis by its smallest step; Shift with a jog key does the same";
    // Hold to move: a button or key held moves until let go.
    let smooth = readStored(SMOOTH_KEY) === "1";
    const smoothButton = button("Hold to move", () => {
        smooth = !smooth;
        writeStored(SMOOTH_KEY, smooth ? "1" : "0");
        smoothButton.setAttribute("aria-pressed", String(smooth));
    }, "btn btn-quiet btn-small btn-toggle");
    smoothButton.setAttribute("aria-pressed", String(smooth));
    smoothButton.title = "hold a jog button or key to move until let go; the step is then the distance per second";
    const body = el("fieldset", { class: "panel-body" });
    root.append(el("div", { class: "panel-head" }, el("h2", {}, "Jog"), el("div", { class: "button-row" }, fineButton, smoothButton, cancelButton)), body);

    let controls: Controls = controlsOf(ctx.store.get());
    let drawn: Controls | null = null;
    // The tool the bars were drawn for: the table bar's unit is mm once
    // the joint is a dispenser's plunger.
    let drawnTool: Tool | null = null;
    let drawnController = "spinny";
    let motors: HTMLButtonElement | null = null;
    let home: HTMLButtonElement | null = null;
    // The travel height, a host value: written when the field changes, and
    // filled from the settings while it is not being typed in.
    const travelField = numberField({ step: 0.5, placeholder: "off", width: "6rem" });
    travelField.setAttribute("aria-label", "Travel height H");
    const travelNote = el("span", { class: "muted travel-note" });
    travelField.addEventListener("change", () => void writeTravel());
    // Under the goto rows: what the row last typed in will move, and where.
    const planLine = el("p", { class: "muted goto-plan hidden" });
    let planOf: (() => PlanWant | null) | null = null;
    // Enter takes the value as leaving the field does.
    travelField.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            travelField.blur();
        }
    });

    /** The choices of a bar: the joint's own steps, or the pad's for one without. */
    const choicesOf = (axis?: AxisControl): number[] => axis?.steps ?? controls.pad_steps;
    const startOf = (axis?: AxisControl): number => (axis?.steps ? axis.step ?? axis.steps[0]! : controls.pad_step);
    /** The choice a bar has pressed: the one remembered if it is still a choice, else the start. */
    const pickOf = (id: BarId, axis?: AxisControl): number => {
        const pick = picks.get(id);
        return pick !== undefined && choicesOf(axis).includes(pick) ? pick : startOf(axis);
    };
    // Shift held with a jog key: the fine step for that jog.
    let shiftJog = false;
    const stepOf = (id: BarId, axis?: AxisControl): number => fine || shiftJog ? fineStep(choicesOf(axis)) : typed.get(id) ?? pickOf(id, axis);

    // --- holding a jog -----------------------------------------------------
    // While held, a piece of the move goes out every tick, as long as the
    // time since the last one at the step per second, so the controller's
    // queue holds about a tick of motion. Let go: no more pieces, and on
    // this project's firmware the jog is cancelled, which stops what is
    // queued at once; a G-code machine runs out its last piece.
    let hold: { timer: ReturnType<typeof setInterval>; started: number } | null = null;
    function startHold(piece: (seconds: number) => Promise<unknown>): void {
        stopHold();
        let busy = false;
        let last = performance.now() - HOLD_TICK_MS;
        const tick = (): void => {
            if (hold === null || busy) {
                return;
            }
            if (!ctx.store.get().snapshot.connected || (performance.now() - hold.started) / 1000 > HOLD_LIMIT_S) {
                stopHold();
                return;
            }
            const now = performance.now();
            const seconds = (now - last) / 1000;
            last = now;
            busy = true;
            piece(seconds).then(() => {
                busy = false;
            }, (error: unknown) => {
                busy = false;
                stopHold();
                ctx.toast("error", error instanceof Error ? error.message : String(error));
            });
        };
        hold = { timer: setInterval(tick, HOLD_TICK_MS), started: performance.now() };
        tick();
    }
    function stopHold(): void {
        if (hold === null) {
            return;
        }
        clearInterval(hold.timer);
        hold = null;
        if (profileOf(ctx.store.get().snapshot).controller !== "gcode" && ctx.store.get().snapshot.connected) {
            void cancel();
        }
    }
    globalThis.addEventListener?.("blur", () => stopHold());
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") {
            stopHold();
        }
    });
    /** A held piece of a board jog: the step per second, at that feed where the feed applies. */
    const holdBoard = (dx: number, dy: number) => (seconds: number): Promise<unknown> => {
        const rate = stepOf(dx !== 0 ? "x" : "y");
        const step = holdPiece(rate, seconds);
        const gcode = profileOf(ctx.store.get().snapshot).controller === "gcode";
        return ctx.api.jog({ kind: "board", dx: dx * step, dy: dy * step, feed: gcode || controls.feed ? rate * 60 : null });
    };
    /** A held piece of a joint jog; an axis the feed does not apply to runs at its jog rate, and the cancel at the release stops it. */
    const holdAxis = (axis: AxisControl, sign: 1 | -1) => (seconds: number): Promise<unknown> => {
        const rate = stepOf(axis.axis, axis);
        const gcode = profileOf(ctx.store.get().snapshot).controller === "gcode";
        const feed = gcode || (axis.feed && controls.feed) ? rate * 60 : null;
        return ctx.api.jog({ kind: "joint", [`d${axis.axis}`]: sign * holdPiece(rate, seconds), feed } as JogRequest);
    };

    /** A jog button that moves by a step when pressed, or while held under Hold to move. */
    function jogButton(label: string, step: () => Promise<unknown>, piece: (seconds: number) => Promise<unknown>, title: string): HTMLButtonElement {
        let held = false;
        const press = button(label, () => {
            // The click that ends a hold is not a step of its own.
            if (held) {
                held = false;
                return undefined;
            }
            return step();
        }, "btn btn-axis", title);
        press.addEventListener("pointerdown", (event) => {
            if (!smooth || event.button !== 0 || press.disabled) {
                return;
            }
            held = true;
            press.setPointerCapture?.(event.pointerId);
            startHold(piece);
        });
        for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) {
            press.addEventListener(name, () => stopHold());
        }
        return press;
    }

    const jogBoard = (dx: number, dy: number): Promise<unknown> =>
        ctx.call(ctx.api.jog({ kind: "board", dx, dy, feed: controls.feed ? feed() : null }));
    // An axis that does not take the feed runs at the firmware's own jog
    // rate for it: the feed field belongs to the moves that carry the beam
    // over the board.
    const jogAxis = (axis: AxisControl, sign: 1 | -1): Promise<unknown> => {
        const request = { kind: "joint", [`d${axis.axis}`]: sign * stepOf(axis.axis, axis), feed: axis.feed && controls.feed ? feed() : null } as JogRequest;
        return ctx.call(ctx.api.jog(request));
    };
    const cancel = (): Promise<unknown> => ctx.call(ctx.api.jogCancel());

    async function declare(axis: AxisControl): Promise<void> {
        const ok = await askConfirm(`Set ${axis.letter} (${axis.label}) to 0 here? ${axis.zero_hint}`.trim(), "Set 0");
        if (ok) {
            await ctx.call(ctx.api.setPosition({ [axis.axis]: 0 }));
        }
    }

    const toggleMotors = async (): Promise<void> => {
        const enabled = ctx.store.get().snapshot.machine?.enabled ?? false;
        await ctx.call(ctx.api.motors(!enabled));
    };

    /**
     * One axis as a bar: its letter and title, a note, the step choices
     * with a field for any other step, the minus and plus buttons, and the
     * zero button when the axis has one.
     */
    function bar(
        id: BarId,
        letter: string,
        title: string,
        note: string,
        unit: string,
        axis: AxisControl | undefined,
        buttons: [string, string],
        onMove: (sign: 1 | -1) => Promise<unknown>,
        onHold: (sign: 1 | -1) => (seconds: number) => Promise<unknown>,
        zero: HTMLButtonElement | null,
    ): HTMLDivElement {
        const format = (value: number): string => `${value} ${unit}`;
        const custom = numberField({ placeholder: "custom", min: 0, width: "6.5rem" });
        custom.setAttribute("aria-label", `${title} step`);
        const row = choiceRow(choicesOf(axis), pickOf(id, axis), (value) => {
            picks.set(id, value);
            typed.delete(id);
            custom.value = "";
        }, format, undefined, (value) => `jog by ${format(value)}`);
        const existing = typed.get(id);
        if (existing !== undefined) {
            custom.value = String(existing);
            setPressed(row, "");
        }
        custom.addEventListener("input", () => {
            const value = parseNumber(custom.value);
            if (value !== null && value > 0) {
                typed.set(id, value);
                // A step typed in is the step: no choice shows as pressed.
                setPressed(row, "");
            } else {
                typed.delete(id);
                setPressed(row, format(pickOf(id, axis)));
            }
        });
        return el("div", { class: "axis-bar", "data-axis": id },
            el("div", { class: "axis-bar-head" },
                el("span", { class: "axis-bar-letter" }, letter),
                el("span", { class: "axis-bar-title" }, title),
                note ? el("span", { class: "axis-bar-note" }, note) : null,
            ),
            el("div", { class: "axis-bar-steps" }, row, custom),
            el("div", { class: "axis-bar-buttons" },
                jogButton(buttons[0], () => onMove(-1), onHold(-1), `${title}: back by the step`),
                jogButton(buttons[1], () => onMove(1), onHold(1), `${title}: on by the step`),
            ),
            zero,
        );
    }

    async function writeTravel(): Promise<void> {
        const read = readTravel(travelField.value);
        if ("problem" in read) {
            ctx.toast("error", read.problem);
            showTravel(ctx.store.get(), true);
            return;
        }
        if (read.travel === (ctx.store.get().settings?.host.travel ?? null)) {
            return;
        }
        const done = await ctx.call(ctx.api.updateSettings({ host: { travel: read.travel } }).then(() => true));
        await ctx.refreshSettings();
        if (done) {
            ctx.toast("info", read.travel === null ? "travel height off" : `travel height H ${read.travel}`);
        }
    }

    /** The field and its note from the settings; a field being typed in keeps its text unless `force`. */
    function showTravel(state: AppState, force = false): void {
        const travel = state.settings?.host.travel ?? null;
        if (force || travelField !== document.activeElement) {
            travelField.value = travel === null ? "" : String(travel);
        }
        travelNote.textContent = travelText(travel);
    }

    function travelRow(): HTMLDivElement {
        const row = el("div", { class: "goto-row travel-row" }, el("span", { class: "choice-label" }, "Travel H"), travelField, travelNote);
        row.title = "Safe height for gotos, probing and camera moves. Jogs and runs ignore it.";
        return row;
    }

    /** The row whose fields were typed in last gives the plan line its goto. */
    function watchPlan(inputs: HTMLInputElement[], want: () => PlanWant | null): void {
        for (const input of inputs) {
            input.addEventListener("input", () => {
                planOf = want;
                showPlan(ctx.store.get());
            });
        }
    }

    /** What the head is and where, as the plan reads it. */
    function planInput(state: AppState): PlanInput | null {
        const machine = state.snapshot.machine;
        if (!state.snapshot.connected || !machine) {
            return null;
        }
        const gcode = profileOf(state.snapshot).controller === "gcode";
        const letters = Object.fromEntries(controls.axes.map((axis) => [axis.axis, axis.letter]));
        const joint = machine.joint;
        return {
            gcode,
            height: gcode ? state.placing?.document?.safe_z ?? null : state.settings?.host.travel ?? null,
            here: { r: joint.r, a: joint.a, z: joint.z, h: joint.h ?? null },
            board: machine.board ? { x: machine.board.x, y: machine.board.y } : null,
            letters,
        };
    }

    /** The plan line: what Go would move now, from where the head is. */
    function showPlan(state: AppState): void {
        const want = planOf?.() ?? null;
        const input = planInput(state);
        planLine.classList.toggle("hidden", want === null || input === null);
        if (want !== null && input !== null) {
            planLine.textContent = gotoPlanText(input, want);
        }
    }

    function boardGotoRow(): HTMLDivElement {
        const x = numberField({ placeholder: "x" });
        const y = numberField({ placeholder: "y" });
        const go = button("Go", async () => {
            const xv = parseNumber(x.value);
            const yv = parseNumber(y.value);
            if (xv === null && yv === null) {
                ctx.toast("error", "enter x and/or y");
                return;
            }
            // A blank axis is left to the backend, which keeps the coordinate
            // the head will have once the jog in progress ends; the readout
            // here is a point it is passing through.
            await ctx.call(ctx.api.goto({ kind: "board", ...(xv !== null ? { x: xv } : {}), ...(yv !== null ? { y: yv } : {}), feed: controls.feed ? feed() : null }));
        }, "btn btn-quiet");
        x.addEventListener("keydown", onEnter(go));
        y.addEventListener("keydown", onEnter(go));
        const want = (): PlanWant | null => {
            const xv = parseNumber(x.value);
            const yv = parseNumber(y.value);
            if (xv === null && yv === null) {
                return null;
            }
            return { kind: "board", ...(xv !== null ? { x: xv } : {}), ...(yv !== null ? { y: yv } : {}) };
        };
        watchPlan([x, y], want);
        go.title = "go to this board point; the line below says what moves";
        return el("div", { class: "goto-row" }, el("span", { class: "choice-label" }, "Board"), x, y, go);
    }

    function jointGotoRow(axes: AxisControl[]): HTMLDivElement {
        const fields = axes.map((axis) => ({ axis, input: numberField({ placeholder: axis.letter.toLowerCase() }) }));
        const go = button("Go", async () => {
            const given = fields
                .map((field) => [field.axis.axis, parseNumber(field.input.value)] as const)
                .filter((entry): entry is readonly [JointAxis, number] => entry[1] !== null);
            if (given.length === 0) {
                ctx.toast("error", `enter ${anyOf(fields.map((field) => field.axis.letter.toLowerCase()))}`);
                return;
            }
            const request = { kind: "joint", feed: controls.feed ? feed() : null, ...Object.fromEntries(given) } as GotoRequest;
            await ctx.call(ctx.api.goto(request));
        }, "btn btn-quiet");
        for (const field of fields) {
            field.input.addEventListener("keydown", onEnter(go));
        }
        const want = (): PlanWant | null => {
            const given = fields
                .map((field) => [field.axis.axis, parseNumber(field.input.value)] as const)
                .filter((entry): entry is readonly [JointAxis, number] => entry[1] !== null);
            return given.length === 0 ? null : { kind: "joint", ...Object.fromEntries(given) };
        };
        watchPlan(fields.map((field) => field.input), want);
        go.title = "go to the places typed; a blank field stays where it is";
        const center = controls.center;
        return el("div", { class: "goto-row" },
            el("span", { class: "choice-label" }, "Joint"),
            ...fields.map((field) => field.input),
            fields.length > 0 ? go : null,
            center ? button("Center", () => ctx.call(ctx.api.goto({ kind: "joint", ...center } as GotoRequest)), "btn btn-quiet", "go to the machine file's center") : null,
        );
    }

    /**
     * Declares where the head is without moving it, in the numbers typed:
     * what a power cycle calls for, when the head sits where the last run
     * or jog left it but the controller counts from zero again. The last
     * position the machine reported fills the fields in with a press.
     */
    function positionRow(axes: AxisControl[]): HTMLDivElement {
        // No placeholders: the goto rows own the letters as placeholders, and
        // a letter before each field says which it is.
        const fields = axes.map((axis) => {
            const input = numberField({ step: 0.001, width: "6rem" });
            input.setAttribute("aria-label", `declare ${axis.letter}`);
            return { axis, input };
        });
        const set = button("Set position", async () => {
            const given = fields
                .map((field) => [field.axis.axis, parseNumber(field.input.value)] as const)
                .filter((entry): entry is readonly [JointAxis, number] => entry[1] !== null);
            if (given.length === 0) {
                ctx.toast("error", `enter ${anyOf(fields.map((field) => field.axis.letter.toLowerCase()))} to declare`);
                return;
            }
            const words = given.map(([axis, value]) => `${controlOf(controls, axis)?.letter ?? axis.toUpperCase()} ${value}`).join(", ");
            const ok = await askConfirm(`Set the head's position to ${words} without moving it? The height map's offset must then be set again.`, "Set position");
            if (!ok) {
                return;
            }
            await ctx.call(ctx.api.setPosition(Object.fromEntries(given)));
        }, "btn btn-quiet", "declare where the head is, without moving it");
        const last = button("Last known", () => {
            const snapshot = ctx.store.get().snapshot;
            const reported = snapshot.position ?? null;
            const position = reported ?? snapshot.resume?.position;
            if (!position) {
                ctx.toast("error", "the machine has not reported a position yet");
                return;
            }
            for (const field of fields) {
                const value = position[field.axis.axis];
                field.input.value = value === null || value === undefined ? "" : String(value);
            }
            if (reported) {
                // How old the numbers are, and what the machine was doing:
                // a position reported mid-move is less certain than one at rest.
                const when = new Date(reported.at);
                const time = Number.isNaN(when.getTime()) ? reported.at : when.toLocaleString();
                // Held, they are not what the machine reads now: it may count
                // from zero again since.
                const held = reported.held ? " (from before a reconnect or restart)" : "";
                ctx.toast("info", `last reported ${time}, ${reported.state}${held}`);
            }
        }, "btn btn-quiet");
        last.title = "Fill in the machine's last reported position";
        for (const field of fields) {
            field.input.addEventListener("keydown", onEnter(set));
        }
        // A G-code machine keeps no last position across a reconnect: its
        // own home is where it counts from.
        const gcode = profileOf(ctx.store.get().snapshot).controller === "gcode";
        return el("div", { class: "position-row" },
            el("span", { class: "choice-label" }, "Here is"),
            ...fields.flatMap((field) => [el("span", { class: "muted position-letter" }, field.axis.letter), field.input]),
            set,
            gcode ? null : last,
        );
    }

    function draw(): void {
        drawn = controls;
        const profile = profileOf(ctx.store.get().snapshot);
        drawnTool = profile.tool;
        drawnController = profile.controller ?? "spinny";
        const bars = el("div", { class: "axis-bars" });
        if (controls.pad) {
            bars.append(
                bar("x", "X", "Board X", "Left and right arrow keys", "mm", undefined, ["X-", "X+"], (sign) => jogBoard(sign * stepOf("x"), 0), (sign) => holdBoard(sign, 0), null),
                bar("y", "Y", "Board Y", "Up and down arrow keys", "mm", undefined, ["Y-", "Y+"], (sign) => jogBoard(0, sign * stepOf("y")), (sign) => holdBoard(0, sign), null),
            );
        }
        for (const axis of controls.axes) {
            const zero = axis.zero ? button(`Set ${axis.letter}=0 here`, () => declare(axis), "btn btn-quiet btn-small", `call this place ${axis.letter} 0`) : null;
            bars.append(bar(axis.axis, axis.letter, axis.label, axis.note, unitOf(axis.axis, profile), axis, axis.buttons, (sign) => jogAxis(axis, sign), (sign) => holdAxis(axis, sign), zero));
        }

        const rows: HTMLElement[] = [];
        if (controls.feed) {
            rows.push(el("div", { class: "steps" }, labeled("Feed mm/min", feedInput)));
        }
        if (controls.pad) {
            rows.push(boardGotoRow());
        }
        const gotoAxes = controls.axes.filter((axis) => axis.goto);
        if (gotoAxes.length > 0 || controls.center) {
            rows.push(jointGotoRow(gotoAxes));
        }
        // The rows are new and empty: no goto is planned until one is typed.
        planOf = null;
        rows.push(planLine);
        if (controls.axes.length > 0) {
            rows.push(positionRow(controls.axes));
        }
        // A G-code machine goes across at its file's safe height, not the
        // travel height, and has no alarm to unlock.
        const gcode = profile.controller === "gcode";
        if (profile.h_axis && !gcode) {
            rows.push(travelRow());
        }

        motors = button("Motors", () => toggleMotors(), "btn btn-quiet", "power the motors on or off");
        // Only a machine with an endstop reports what is homed, and only
        // that one has anything to home; a G-code machine homes as its file says.
        home = button("Home", () => ctx.call(ctx.api.home()), "btn btn-quiet hidden");
        home.title = gcode ? "home the machine (its file's home line, G28)" : "home every axis with an endstop";
        const bottom = el("div", { class: "button-row" },
            motors,
            home,
            gcode ? null : button("Unlock", () => ctx.call(ctx.api.unlock()), "btn btn-quiet", "clear an alarm so the machine moves again"),
        );
        replace(body, bars, ...rows, bottom);
        show(ctx.store.get());
    }

    function show(state: AppState): void {
        lockFieldset(body, !state.snapshot.connected, "connect first");
        setLocked(cancelButton, !state.snapshot.connected, "connect first");
        if (motors) {
            motors.textContent = state.snapshot.machine?.enabled ? "Motors off" : "Motors on";
        }
        if (home) {
            home.classList.toggle("hidden", typeof state.snapshot.machine?.homed !== "string" && profileOf(state.snapshot).controller !== "gcode");
        }
        showTravel(state);
        showPlan(state);
    }

    ctx.store.subscribe((state) => {
        const next = controlsOf(state);
        if (drawn === null || !sameControls(drawn, next) || drawnTool !== profileOf(state.snapshot).tool || drawnController !== (profileOf(state.snapshot).controller ?? "spinny")) {
            controls = next;
            draw();
        } else {
            show(state);
        }
    }, ["snapshot", "settings", "placing"]);
    draw();

    // One key jog at a time: a held or hammered key must not queue up moves.
    let keyJog: Promise<unknown> | null = null;
    // The key holding a jog under Hold to move: its release ends the hold.
    let heldKey: string | null = null;
    document.addEventListener("keyup", (event) => {
        if (heldKey !== null && event.key.toLowerCase() === heldKey) {
            heldKey = null;
            stopHold();
        }
    });
    document.addEventListener("keydown", (event) => {
        if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) {
            return;
        }
        // A held key repeats: under Hold to move the hold goes on by
        // itself, and otherwise one press is one jog.
        if (event.repeat) {
            if (heldKey !== null && event.key.toLowerCase() === heldKey) {
                event.preventDefault();
            }
            return;
        }
        // An open dialog answers every key, Escape included.
        if (modalOpen()) {
            return;
        }
        const action = keyAction(event.key, controls);
        if (action === null) {
            return;
        }
        // The stop works from a field too: a goto started with Enter
        // leaves the focus in the field it was typed in. With no machine
        // there is nothing to stop, and the key stays the field's.
        if (action === "cancel") {
            // Escape also leaves a text field, so the next arrow key jogs.
            const focused = document.activeElement;
            if (inputHasFocus() && focused instanceof HTMLElement) {
                focused.blur();
            }
            if (ctx.store.get().snapshot.connected) {
                event.preventDefault();
                stopHold();
                void cancel();
            }
            return;
        }
        // Jog keys belong to a field that has the focus, and jog only from
        // the page this panel is on: on the others nothing should move.
        if (inputHasFocus() || activePage() !== page || !active()) {
            return;
        }
        event.preventDefault();
        const axis = "axis" in action ? controlOf(controls, action.axis) : undefined;
        if (smooth && ctx.store.get().snapshot.connected) {
            heldKey = event.key.toLowerCase();
            const fineNow = event.shiftKey;
            const piece = "axis" in action
                ? (axis ? holdAxis(axis, action.sign) : null)
                : holdBoard(action.dx, action.dy);
            if (piece) {
                // Shift is read when the key goes down and kept for the
                // hold: the piece reads its step before it returns.
                startHold((seconds) => {
                    shiftJog = fineNow;
                    try {
                        return piece(seconds);
                    } finally {
                        shiftJog = false;
                    }
                });
            }
            return;
        }
        if (ctx.store.get().snapshot.connected && keyJog === null) {
            shiftJog = event.shiftKey;
            const move = "axis" in action
                ? (axis ? jogAxis(axis, action.sign) : Promise.resolve())
                : jogBoard(action.dx * stepOf("x"), action.dy * stepOf("y"));
            shiftJog = false;
            keyJog = move.finally(() => {
                keyJog = null;
            });
        }
    });
}
