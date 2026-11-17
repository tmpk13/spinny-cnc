// Jog panel, drawn from the machine's controls (controls.ts). One step
// size serves every axis: Fine, Normal or Coarse, each axis taking its own
// step for it from the machine file (its smallest choice, the one it
// starts on, its largest), so the pad and the bars all follow one pick and
// say the step they move by. On a machine with a board pad, the pad comes
// first: eight arrows around where the head is on the board, the corners
// moving X and Y together; the arrow keys drive it. Then a bar per joint:
// where it is, its step, its minus and plus. Under More: a step of its own
// typed for any axis (which is that axis's step at every size while it is
// there), the zero buttons, the feed field, goto fields, Center, motors
// and unlock. The cancel button sits in the panel's head, away from every
// move. Which joints there are, what they are called, how they step and
// whether the feed applies is the machine file's; the panel only draws it,
// and draws it again when the controls change. Escape cancels a jog or
// goto from anywhere but a dialog while a machine is connected, and leaves
// a text field, so the next arrow key jogs. Holding Shift with a jog key
// jogs by the fine step. In the head: Hold to move, under which a button
// or key held moves the axis until let go, the step read as the distance
// per second. A bar per servo follows the axes' (servos.ts): where it is,
// its named positions, an angle to send it to, and Off, which lets it go.

import { askConfirm } from "../confirm.ts";
import { controlOf, controlsOf, sameControls, unitOf } from "../controls.ts";
import { activePage, button, el, inputHasFocus, labeled, lockFieldset, modalOpen, numberField, onEnter, readStored, replace, setLocked, svgIcon, writeStored } from "../dom.ts";
import { formatDeg, formatMm, parseNumber } from "../format.ts";
import { gotoPlanText, type PlanInput, type PlanWant } from "../gotoplan.ts";
import { profileOf } from "../profile.ts";
import { angleText, readAngle, servoBars, servoKey, type ServoBar } from "../servos.ts";
import type { AppState } from "../state.ts";
import type { AxisControl, Controls, GotoRequest, JogRequest, JointAxis, Machine, Tool } from "../types.ts";
import { choiceRow, type Ctx } from "./context.ts";

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

/**
 * Where a bar's axis is now, in its unit: the board's X or Y, or a joint;
 * blank numbers when no machine reports, or the machine has no such joint.
 */
export function barPlace(id: BarId, unit: "mm" | "deg", machine: Machine | null, withUnit = true): string {
    const value = machine === null ? null : id === "x" ? machine.board.x : id === "y" ? machine.board.y : machine.joint[id];
    const number = unit === "deg" ? formatDeg(value) : formatMm(value);
    return withUnit ? `${number} ${unit}` : number;
}

/** An arrow pointing right in a box 16 units square, turned for each move of the pad. */
const ARROW = "M2 7.25H9.5V3.75L14 8L9.5 12.25V8.75H2Z";

/** A move of the board pad: which way in X and in Y, and its name, which is its button's text. */
export interface PadMove {
    dx: -1 | 0 | 1;
    dy: -1 | 0 | 1;
    name: string;
}

/** The pad's cells row by row, top left first; null is the middle, where the head's place is. */
export const PAD: (PadMove | null)[] = ([[-1, 1], [0, 1], [1, 1], [-1, 0], null, [1, 0], [-1, -1], [0, -1], [1, -1]] as ([-1 | 0 | 1, -1 | 0 | 1] | null)[])
    .map((cell) => cell === null ? null : {
        dx: cell[0],
        dy: cell[1],
        name: [cell[0] !== 0 ? `X${cell[0] > 0 ? "+" : "-"}` : "", cell[1] !== 0 ? `Y${cell[1] > 0 ? "+" : "-"}` : ""].filter((part) => part !== "").join(" "),
    });

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
/** The step size picked, as this browser keeps it. */
export const LEVEL_KEY = "spinny.jog.level";

/** The step sizes every axis shares: each axis has its own step for each. */
export type StepLevel = 0 | 1 | 2;
export const LEVELS: readonly string[] = ["Fine", "Normal", "Coarse"];

/** The step size in stored text; anything else is Normal. */
export function parseLevel(text: string | null): StepLevel {
    return text === "0" ? 0 : text === "2" ? 2 : 1;
}

/** The smallest of a bar's step choices: what Fine jogs by. */
export function fineStep(choices: number[]): number {
    return Math.min(...choices);
}

/**
 * An axis's step at a step size: its smallest choice for Fine, its largest
 * for Coarse, and for Normal the step it starts on (`start`, the machine
 * file's), which is the middle one where the file names none.
 */
export function levelStep(choices: number[], start: number, level: StepLevel): number {
    if (level === 0) {
        return fineStep(choices);
    }
    return level === 2 ? Math.max(...choices) : start;
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

export interface JogOptions {
    /**
     * Where the travel height's row goes: left out, among the jog's rows;
     * a box (the Height panel's), there; null, nowhere, for a second jog
     * panel whose page has the Height panel's elsewhere.
     */
    travel?: HTMLElement | null;
}
/**
 * Mounts the jog panel in `root` for the page `page`, whose arrow keys it
 * answers; `active` says when they are its at all. The panel jogs the
 * machine connected, whichever it is: a G-code machine's file draws its
 * bars as any other machine file does.
 */
export function mountJog(root: HTMLElement, ctx: Ctx, page = "run", active: () => boolean = () => true, options: JogOptions = {}): void {
    // The step size every axis moves by, and a step typed for one axis,
    // which is that axis's step while it is there; both kept across a redraw.
    let level: StepLevel = parseLevel(readStored(LEVEL_KEY));
    const typed = new Map<BarId, number>();
    const feedInput = numberField({ placeholder: "default", min: 0 });
    const feed = (): number | null => parseNumber(feedInput.value);
    const cancelButton = button("Cancel", () => cancel(), "btn btn-danger btn-small urgent");
    cancelButton.title = "stop a jog or goto (Escape)";
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
    root.append(el("div", { class: "panel-head" }, el("h2", {}, "Jog"), el("div", { class: "button-row" }, smoothButton, cancelButton)), body);

    let controls: Controls = controlsOf(ctx.store.get());
    let drawn: Controls | null = null;
    // The tool the bars were drawn for: the table bar's unit is mm once
    // the joint is a dispenser's plunger.
    let drawnTool: Tool | null = null;
    let drawnController = "spinny";
    // The servos the bars were drawn for, and each one's angle readout.
    let drawnServos = "";
    const servoAngles = new Map<number, HTMLElement>();
    // Each bar's place readout, the unit it reads in, and whether it says
    // the unit (the pad's middle does not: its tooltip does), by bar.
    const places = new Map<BarId, { node: HTMLElement; unit: "mm" | "deg"; bare?: boolean }>();
    // Where each bar says the step it moves by, with what gives the step.
    const stepSays = new Map<BarId, { node: HTMLElement; unit: string; axis: AxisControl | undefined }>();

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
    // Shift held with a jog key: the fine step for that jog.
    let shiftJog = false;
    /** The step a bar moves by: the fine one under Shift, else one typed for it, else its step at the size picked. */
    const stepOf = (id: BarId, axis?: AxisControl): number => shiftJog ? fineStep(choicesOf(axis)) : typed.get(id) ?? levelStep(choicesOf(axis), startOf(axis), level);

    /** Every bar's step in words again, after the size or a typed step changed. */
    function showSteps(): void {
        for (const [id, { node, unit, axis }] of stepSays) {
            const text = `${stepOf(id, axis)} ${unit}`;
            if (node.textContent !== text) {
                node.textContent = text;
            }
            node.toggleAttribute("data-own", typed.has(id));
        }
    }

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
    /**
     * A held piece of a board jog: X and Y each at its own bar's step per
     * second (a corner of the pad moves both), at the speed of the two
     * together where the feed applies.
     */
    const holdBoard = (dx: number, dy: number) => (seconds: number): Promise<unknown> => {
        const rateX = dx !== 0 ? stepOf("x") : 0;
        const rateY = dy !== 0 ? stepOf("y") : 0;
        const gcode = profileOf(ctx.store.get().snapshot).controller === "gcode";
        return ctx.api.jog({
            kind: "board",
            dx: dx === 0 ? 0 : dx * holdPiece(rateX, seconds),
            dy: dy === 0 ? 0 : dy * holdPiece(rateY, seconds),
            feed: gcode || controls.feed ? Math.hypot(rateX, rateY) * 60 : null,
        });
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
     * One joint as a bar: its letter and title (what the machine file
     * notes of it on hover), where it is now, and its minus and plus
     * buttons with the step a press moves it by between them.
     */
    function bar(
        id: BarId,
        letter: string,
        title: string,
        note: string,
        unit: string,
        axis: AxisControl,
        onMove: (sign: 1 | -1) => Promise<unknown>,
        onHold: (sign: 1 | -1) => (seconds: number) => Promise<unknown>,
    ): HTMLDivElement {
        const place = el("span", { class: "axis-bar-at", title: `where ${title} is now` }, barPlace(id, unit === "deg" ? "deg" : "mm", null));
        places.set(id, { node: place, unit: unit === "deg" ? "deg" : "mm" });
        const step = el("span", { class: "axis-bar-step", title: "the step a press moves it by, at the step size picked; a step typed for this axis under More is marked" });
        stepSays.set(id, { node: step, unit, axis });
        const head = el("div", { class: "axis-bar-head" },
            el("span", { class: "axis-bar-letter" }, letter),
            el("span", { class: "axis-bar-title" }, title),
            place,
        );
        if (note) {
            head.title = note;
        }
        return el("div", { class: "axis-bar", "data-axis": id },
            head,
            el("div", { class: "axis-bar-buttons" },
                jogButton(axis.buttons[0], () => onMove(-1), onHold(-1), `${title}: back by the step`),
                step,
                jogButton(axis.buttons[1], () => onMove(1), onHold(1), `${title}: on by the step`),
            ),
        );
    }

    /** A field for a step of an axis's own, under More: typed, it is that axis's step at every size; blank, the size's. */
    function ownStep(id: BarId, title: string, unit: string): HTMLLabelElement {
        const field = numberField({ placeholder: "custom", min: 0, width: "5.5rem" });
        field.setAttribute("aria-label", `${title} step`);
        field.title = `a step of its own for ${title}, ${unit}; blank: the step size picked`;
        const kept = typed.get(id);
        if (kept !== undefined) {
            field.value = String(kept);
        }
        field.addEventListener("input", () => {
            const value = parseNumber(field.value);
            if (value !== null && value > 0) {
                typed.set(id, value);
            } else {
                typed.delete(id);
            }
            showSteps();
        });
        return labeled(title, field, "labeled inline");
    }

    /** The step size every axis moves by: one of three, each axis taking its own step for it. */
    function sizeRow(): HTMLDivElement {
        const row = choiceRow<StepLevel>([0, 1, 2], level, (value) => {
            level = value;
            writeStored(LEVEL_KEY, String(value));
            showSteps();
        }, (value) => LEVELS[value]!, undefined, (value) => `every axis by its ${LEVELS[value]!.toLowerCase()} step${value === 0 ? "; Shift with a jog key does the same" : ""}`);
        row.setAttribute("role", "group");
        row.setAttribute("aria-label", "Step size");
        return row;
    }

    /**
     * The board's moves as a pad of arrows around where the head is: up,
     * down, left, right, and the corners, which move X and Y together, X by
     * the X bar's step and Y by the Y bar's. Every arrow holds under Hold
     * to move as the bars' buttons do.
     */
    function boardPad(): HTMLDivElement {
        const cells = PAD.map((move) => {
            if (move === null) {
                const x = el("span", { class: "jog-pad-value" }, barPlace("x", "mm", null, false));
                const y = el("span", { class: "jog-pad-value" }, barPlace("y", "mm", null, false));
                places.set("x", { node: x, unit: "mm", bare: true });
                places.set("y", { node: y, unit: "mm", bare: true });
                return el("div", { class: "jog-pad-here", title: "where the head is on the board, mm" },
                    el("span", { class: "jog-pad-letter" }, "X"), x, el("span", { class: "jog-pad-letter" }, "Y"), y);
            }
            const corner = move.dx !== 0 && move.dy !== 0;
            const press = jogButton(move.name, () => jogBoard(move.dx * stepOf("x"), move.dy * stepOf("y")), holdBoard(move.dx, move.dy),
                corner ? `board ${move.name}: X and Y together, each by its bar's step` : `board ${move.name} by the ${move.dx !== 0 ? "X" : "Y"} bar's step`);
            press.classList.add("jog-pad-move");
            const arrow = svgIcon(ARROW);
            arrow.style.setProperty("--turn", `${(Math.atan2(-move.dy, move.dx) * 180) / Math.PI}deg`);
            press.prepend(arrow);
            return press;
        });
        return el("div", { class: "jog-pad", "data-axis": "board" }, ...cells);
    }

    /** What the pad moves by at the size picked, in words beside it: X and Y each. */
    function padSays(): HTMLSpanElement {
        const x = el("span", {});
        const y = el("span", {});
        stepSays.set("x", { node: x, unit: "mm", axis: undefined });
        stepSays.set("y", { node: y, unit: "mm", axis: undefined });
        return el("span", { class: "muted jog-pad-steps", title: "what an arrow moves the head by on the board" }, "X ", x, ", Y ", y);
    }

    /** The servos the state fits, as their bars. */
    const servosOf = (state: AppState): ServoBar[] =>
        servoBars(state.settings?.values, state.settings?.servos, profileOf(state.snapshot).controller === "gcode");

    /**
     * A servo as a bar: its number and name with where it is, a button per
     * named position, a field for any angle in its range with Go, and Off,
     * which takes its pulse away so it stops holding.
     */
    function servoBar(servo: ServoBar): HTMLDivElement {
        const move = (angle: number | null): Promise<unknown> => ctx.call(ctx.api.servo(servo.servo, angle));
        const angle = numberField({ placeholder: `0 to ${servo.range}`, min: 0, max: servo.range, width: "6.5rem" });
        angle.setAttribute("aria-label", `${servo.name} angle`);
        const go = button("Go", async () => {
            const read = readAngle(angle.value, servo.range);
            if ("problem" in read) {
                ctx.toast("error", `${servo.name}: ${read.problem}`);
                return;
            }
            await move(read.angle);
        }, "btn btn-axis", `${servo.name}: to the angle typed`);
        angle.addEventListener("keydown", onEnter(go));
        const readout = el("span", { class: "servo-angle" }, angleText(null));
        servoAngles.set(servo.servo, readout);
        return el("div", { class: "axis-bar servo-bar", "data-servo": String(servo.servo) },
            el("div", { class: "axis-bar-head" },
                el("span", { class: "axis-bar-letter" }, `S${servo.servo}`),
                el("span", { class: "axis-bar-title" }, servo.name),
                readout,
            ),
            el("div", { class: "axis-bar-steps" },
                ...servo.positions.map((position) =>
                    button(position.name, () => move(position.angle), "btn btn-quiet", `${servo.name} to ${position.angle} deg`)),
                angle,
            ),
            el("div", { class: "axis-bar-buttons" },
                go,
                button("Off", () => move(null), "btn btn-axis", `${servo.name}: no pulse, so it stops holding its angle`),
            ),
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
            // Only a plain Z said so lets a nozzle above the safe height stay up.
            seesaw: gcode && state.placing?.document?.seesaw !== false,
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

    // Whether More is open, kept across the redraws a new machine file makes.
    let moreOpen = false;

    function draw(): void {
        drawn = controls;
        const profile = profileOf(ctx.store.get().snapshot);
        drawnTool = profile.tool;
        drawnController = profile.controller ?? "spinny";
        const bars = el("div", { class: "axis-bars" });
        places.clear();
        stepSays.clear();
        // The step size over everything it sets, with what the pad moves by at it.
        const size = el("div", { class: "jog-size" }, sizeRow(), controls.pad ? padSays() : null);
        const pad = controls.pad ? boardPad() : null;
        for (const axis of controls.axes) {
            bars.append(bar(axis.axis, axis.letter, axis.label, axis.note, unitOf(axis.axis, profile), axis, (sign) => jogAxis(axis, sign), (sign) => holdAxis(axis, sign)));
        }
        const servos = servosOf(ctx.store.get());
        drawnServos = servoKey(servos);
        servoAngles.clear();
        for (const servo of servos) {
            bars.append(servoBar(servo));
        }

        const rows: HTMLElement[] = [];
        // A step of an axis's own, the pad's X and Y among them, in each axis's unit.
        rows.push(el("div", { class: "jog-own-steps" },
            el("span", { class: "choice-label", title: "a step typed here is that axis's step at every size; blank, the step size picked gives it" }, "Own steps"),
            ...(controls.pad ? [ownStep("x", "Board X", "mm"), ownStep("y", "Board Y", "mm")] : []),
            ...controls.axes.map((axis) => ownStep(axis.axis, axis.label, unitOf(axis.axis, profile))),
        ));
        const zeros = controls.axes.filter((axis) => axis.zero).map((axis) => button(`Set ${axis.letter}=0 here`, () => declare(axis), "btn btn-quiet btn-small", `call this place ${axis.letter} 0`));
        if (zeros.length > 0) {
            rows.push(el("div", { class: "button-row jog-zeros" }, ...zeros));
        }
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
        const travelShown = profile.h_axis && !gcode;
        if (options.travel === undefined) {
            if (travelShown) {
                rows.push(travelRow());
            }
        } else if (options.travel !== null) {
            replace(options.travel, travelShown ? travelRow() : null);
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
        // The size, the pad and the bars in view; steps of an axis's own,
        // zeroing, going to a place, naming one, the feed and the motors
        // under More, open as it was left.
        const fold = el("details", { class: "more jog-more stack" }, el("summary", { title: "fold or unfold" }, "More: own steps, zero, go to, motors"), ...rows, bottom);
        fold.open = moreOpen;
        fold.addEventListener("toggle", () => {
            moreOpen = fold.open;
        });
        replace(body, size, el("div", { class: "jog-moves" }, pad, bars), fold);
        showSteps();
        show(ctx.store.get());
    }

    function show(state: AppState): void {
        lockFieldset(body, !state.snapshot.connected, "connect first");
        setLocked(cancelButton, !state.snapshot.connected, "connect first");
        // Red fills it only while there is a move to stop.
        const state_ = state.snapshot.machine?.state;
        cancelButton.classList.toggle("at-rest", state_ === undefined || state_ === "Idle");
        if (motors) {
            motors.textContent = state.snapshot.machine?.enabled ? "Motors off" : "Motors on";
        }
        if (home) {
            home.classList.toggle("hidden", typeof state.snapshot.machine?.homed !== "string" && profileOf(state.snapshot).controller !== "gcode");
        }
        const machine = state.snapshot.connected ? state.snapshot.machine : null;
        for (const [id, { node, unit, bare }] of places) {
            const text = barPlace(id, unit, machine, bare !== true);
            if (node.textContent !== text) {
                node.textContent = text;
            }
        }
        const angles = state.snapshot.machine?.servos ?? null;
        for (const [servo, readout] of servoAngles) {
            readout.textContent = angleText(angles?.[servo - 1]);
        }
        showTravel(state);
        showPlan(state);
    }

    ctx.store.subscribe((state) => {
        const next = controlsOf(state);
        if (
            drawn === null
            || !sameControls(drawn, next)
            || drawnTool !== profileOf(state.snapshot).tool
            || drawnController !== (profileOf(state.snapshot).controller ?? "spinny")
            || drawnServos !== servoKey(servosOf(state))
        ) {
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
