// Jog panel, drawn from the machine's controls (controls.ts): one bar per
// axis, each with its steps (the choices, and a step typed in beside
// them), its minus and plus buttons and its zero button. The board's X and
// Y bars come first on a machine with a pad, and the arrow keys drive
// them. Below: the feed field, goto fields, Center, motors and unlock; the
// cancel button sits in the panel's head, away from every move. Which
// joints there are, what they are called, how they step and whether the
// feed applies is the machine file's; the panel only draws it, and draws
// it again when the controls change. Escape cancels a jog or goto from
// anywhere but a dialog while a machine is connected.

import { askConfirm } from "../confirm.ts";
import { controlOf, controlsOf, sameControls, UNITS } from "../controls.ts";
import { activePage, button, el, inputHasFocus, labeled, modalOpen, numberField, replace, setLocked } from "../dom.ts";
import { parseNumber } from "../format.ts";
import type { AppState } from "../state.ts";
import type { AxisControl, Controls, GotoRequest, JogRequest, JointAxis } from "../types.ts";
import { choiceRow, setPressed, type Ctx } from "./context.ts";

export type KeyAction = { dx: number; dy: number } | { axis: JointAxis; sign: 1 | -1 } | "cancel" | null;

/** A bar: the board's X or Y, or a joint. */
export type BarId = "x" | "y" | JointAxis;

/**
 * Maps a key to a board jog in step units, a joint jog by its step, or a
 * cancel; null when the key is not bound. Without controls the pad's arrow
 * keys are assumed.
 */
export function keyAction(key: string, controls?: Controls): KeyAction {
    if (key === "Escape") {
        return "cancel";
    }
    if (controls === undefined || controls.pad) {
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
    for (const axis of controls?.axes ?? []) {
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

export function mountJog(root: HTMLElement, ctx: Ctx): void {
    // The step of each bar, kept across a redraw: the choice pressed, and
    // a step typed in, which is the step while it is there.
    const picks = new Map<BarId, number>();
    const typed = new Map<BarId, number>();
    const feedInput = numberField({ placeholder: "default", min: 0 });
    const feed = (): number | null => parseNumber(feedInput.value);
    const cancelButton = button("Cancel", () => cancel(), "btn btn-danger btn-small");
    const body = el("fieldset", { class: "panel-body" });
    root.append(el("div", { class: "panel-head" }, el("h2", {}, "Jog"), el("div", { class: "button-row" }, cancelButton)), body);

    let controls: Controls = controlsOf(ctx.store.get());
    let drawn: Controls | null = null;
    let motors: HTMLButtonElement | null = null;
    let home: HTMLButtonElement | null = null;

    /** The choices of a bar: the joint's own steps, or the pad's for one without. */
    const choicesOf = (axis?: AxisControl): number[] => axis?.steps ?? controls.pad_steps;
    const startOf = (axis?: AxisControl): number => (axis?.steps ? axis.step ?? axis.steps[0]! : controls.pad_step);
    /** The choice a bar has pressed: the one remembered if it is still a choice, else the start. */
    const pickOf = (id: BarId, axis?: AxisControl): number => {
        const pick = picks.get(id);
        return pick !== undefined && choicesOf(axis).includes(pick) ? pick : startOf(axis);
    };
    const stepOf = (id: BarId, axis?: AxisControl): number => typed.get(id) ?? pickOf(id, axis);

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
        const ok = await askConfirm(`Declare ${axis.letter} (${axis.label}) to be 0 at the current position? ${axis.zero_hint}`.trim(), "Set 0");
        if (ok) {
            await ctx.call(ctx.api.setPosition({ [axis.axis]: 0 }));
        }
    }

    const toggleMotors = async (): Promise<void> => {
        const enabled = ctx.store.get().snapshot.machine?.enabled ?? false;
        await ctx.call(ctx.api.motors(!enabled));
    };

    const onEnter = (target: HTMLButtonElement) => (event: Event): void => {
        if ((event as KeyboardEvent).key === "Enter") {
            event.preventDefault();
            target.click();
        }
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
        zero: HTMLButtonElement | null,
    ): HTMLDivElement {
        const format = (value: number): string => `${value} ${unit}`;
        const custom = numberField({ placeholder: "custom", min: 0, width: "6.5rem" });
        custom.setAttribute("aria-label", `${title} step`);
        const row = choiceRow(choicesOf(axis), pickOf(id, axis), (value) => {
            picks.set(id, value);
            typed.delete(id);
            custom.value = "";
        }, format);
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
                button(buttons[0], () => onMove(-1), "btn btn-axis"),
                button(buttons[1], () => onMove(1), "btn btn-axis"),
            ),
            zero,
        );
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
        const center = controls.center;
        return el("div", { class: "goto-row" },
            el("span", { class: "choice-label" }, "Joint"),
            ...fields.map((field) => field.input),
            fields.length > 0 ? go : null,
            center ? button("Center", () => ctx.call(ctx.api.goto({ kind: "joint", ...center } as GotoRequest)), "btn btn-quiet") : null,
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
            const ok = await askConfirm(`Declare the head to be at ${words} without moving it? The height map's offset is taken back and must be set again.`, "Set position");
            if (!ok) {
                return;
            }
            await ctx.call(ctx.api.setPosition(Object.fromEntries(given)));
        }, "btn btn-quiet");
        const last = button("Last known", () => {
            const snapshot = ctx.store.get().snapshot;
            const position = snapshot.position ?? snapshot.resume?.position;
            if (!position) {
                ctx.toast("error", "the machine has not reported a position yet");
                return;
            }
            for (const field of fields) {
                const value = position[field.axis.axis];
                field.input.value = value === null || value === undefined ? "" : String(value);
            }
        }, "btn btn-quiet");
        last.title = "Fill in the last position the machine reported: its last report before the link closed, or a run's record";
        for (const field of fields) {
            field.input.addEventListener("keydown", onEnter(set));
        }
        return el("div", { class: "position-row" },
            el("span", { class: "choice-label" }, "Here is"),
            ...fields.flatMap((field) => [el("span", { class: "muted position-letter" }, field.axis.letter), field.input]),
            set,
            last,
        );
    }

    function draw(): void {
        drawn = controls;
        const bars = el("div", { class: "axis-bars" });
        if (controls.pad) {
            bars.append(
                bar("x", "X", "Board X", "Board mm; the left and right arrow keys", "mm", undefined, ["X-", "X+"], (sign) => jogBoard(sign * stepOf("x"), 0), null),
                bar("y", "Y", "Board Y", "Board mm; the up and down arrow keys", "mm", undefined, ["Y-", "Y+"], (sign) => jogBoard(0, sign * stepOf("y")), null),
            );
        }
        for (const axis of controls.axes) {
            const zero = axis.zero ? button(`Set ${axis.letter}=0 here`, () => declare(axis), "btn btn-quiet btn-small") : null;
            bars.append(bar(axis.axis, axis.letter, axis.label, axis.note, UNITS[axis.axis], axis, axis.buttons, (sign) => jogAxis(axis, sign), zero));
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
        if (controls.axes.length > 0) {
            rows.push(positionRow(controls.axes));
        }

        motors = button("Motors", () => toggleMotors(), "btn btn-quiet");
        // Only a machine with an endstop reports what is homed, and only
        // that one has anything to home.
        home = button("Home", () => ctx.call(ctx.api.home()), "btn btn-quiet hidden");
        const bottom = el("div", { class: "button-row" },
            motors,
            home,
            button("Unlock", () => ctx.call(ctx.api.unlock()), "btn btn-quiet"),
        );
        replace(body, bars, ...rows, bottom);
        show(ctx.store.get());
    }

    function show(state: AppState): void {
        body.disabled = !state.snapshot.connected;
        setLocked(cancelButton, !state.snapshot.connected);
        if (motors) {
            motors.textContent = state.snapshot.machine?.enabled ? "Motors off" : "Motors on";
        }
        if (home) {
            home.classList.toggle("hidden", typeof state.snapshot.machine?.homed !== "string");
        }
    }

    ctx.store.subscribe((state) => {
        const next = controlsOf(state);
        if (drawn === null || !sameControls(drawn, next)) {
            controls = next;
            draw();
        } else {
            show(state);
        }
    }, ["snapshot", "settings"]);
    draw();

    // One key jog at a time: a held or hammered key must not queue up moves.
    let keyJog: Promise<unknown> | null = null;
    document.addEventListener("keydown", (event) => {
        if (event.defaultPrevented || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) {
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
            if (ctx.store.get().snapshot.connected) {
                event.preventDefault();
                void cancel();
            }
            return;
        }
        // Jog keys belong to a field that has the focus, and jog only from
        // the machine's page: on the other pages nothing should move.
        if (inputHasFocus() || activePage() !== "machine") {
            return;
        }
        event.preventDefault();
        if (ctx.store.get().snapshot.connected && keyJog === null) {
            const axis = "axis" in action ? controlOf(controls, action.axis) : undefined;
            const move = "axis" in action
                ? (axis ? jogAxis(axis, action.sign) : Promise.resolve())
                : jogBoard(action.dx * stepOf("x"), action.dy * stepOf("y"));
            keyJog = move.finally(() => {
                keyJog = null;
            });
        }
    });
}
