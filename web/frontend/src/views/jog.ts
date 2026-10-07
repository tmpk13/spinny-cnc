// Jog panel, drawn from the machine's controls (controls.ts): a board X/Y
// pad on the arrow keys, a button pair beside it or a framed block with its
// own steps per joint, goto fields, zero buttons, Center, motors and
// unlock. Which joints there are, what they are called, how they step and
// whether the feed applies is the machine file's; the panel only draws it,
// and draws it again when the controls change. Escape cancels a jog or
// goto from anywhere but a dialog while a machine is connected.

import { askConfirm } from "../confirm.ts";
import { controlOf, controlsOf, sameControls, UNITS } from "../controls.ts";
import { activePage, button, el, inputHasFocus, labeled, modalOpen, numberField, replace } from "../dom.ts";
import { parseNumber } from "../format.ts";
import type { AppState } from "../state.ts";
import type { AxisControl, Controls, GotoRequest, JogRequest, JointAxis } from "../types.ts";
import { choiceRow, type Ctx } from "./context.ts";

export type KeyAction = { dx: number; dy: number } | { axis: JointAxis; sign: 1 | -1 } | "cancel" | null;

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
    // The step picked per control, kept across a redraw: "pad", or the joint
    // of an axis with steps of its own.
    const picks = new Map<string, number>();
    const feedInput = numberField({ placeholder: "default", min: 0 });
    const feed = (): number | null => parseNumber(feedInput.value);
    const body = el("fieldset", { class: "panel-body" });
    root.append(el("h2", {}, "Jog"), body);

    let controls: Controls = controlsOf(ctx.store.get());
    let drawn: Controls | null = null;
    let motors: HTMLButtonElement | null = null;

    const remembered = (key: string, choices: number[], fallback: number): number => {
        const pick = picks.get(key);
        return pick !== undefined && choices.includes(pick) ? pick : fallback;
    };
    const padStep = (): number => remembered("pad", controls.pad_steps, controls.pad_step);
    const stepOf = (axis: AxisControl): number =>
        axis.steps ? remembered(axis.axis, axis.steps, axis.step ?? axis.steps[0]!) : padStep();

    const jogBoard = (dx: number, dy: number): Promise<unknown> =>
        ctx.call(ctx.api.jog({ kind: "board", dx, dy, feed: controls.feed ? feed() : null }));
    // An axis that does not take the feed runs at the firmware's own jog
    // rate for it: the feed field belongs to the moves that carry the beam
    // over the board.
    const jogAxis = (axis: AxisControl, sign: 1 | -1): Promise<unknown> => {
        const request = { kind: "joint", [`d${axis.axis}`]: sign * stepOf(axis), feed: axis.feed && controls.feed ? feed() : null } as JogRequest;
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

    function stepRow(axis: AxisControl): HTMLDivElement {
        const steps = axis.steps!;
        const unit = UNITS[axis.axis];
        return choiceRow(
            steps,
            remembered(axis.axis, steps, axis.step ?? steps[0]!),
            (value) => { picks.set(axis.axis, value); },
            (value) => `${value} ${unit}`,
            axis.place === "frame" ? "Step" : axis.label,
        );
    }

    function pad(): HTMLDivElement {
        const padButton = (label: string, area: string, onClick: () => Promise<unknown>, extra = ""): HTMLButtonElement => {
            const node = button(label, onClick, `btn btn-pad ${extra}`.trim());
            node.style.gridArea = area;
            return node;
        };
        return el("div", { class: "pad" },
            padButton("Y+", "up", () => jogBoard(0, padStep())),
            padButton("X-", "left", () => jogBoard(-padStep(), 0)),
            padButton("Cancel", "mid", () => cancel(), "btn-cancel"),
            padButton("X+", "right", () => jogBoard(padStep(), 0)),
            padButton("Y-", "down", () => jogBoard(0, -padStep())),
        );
    }

    function pair(axis: AxisControl, className: string): HTMLButtonElement[] {
        return [
            button(axis.buttons[0], () => jogAxis(axis, -1), className),
            button(axis.buttons[1], () => jogAxis(axis, 1), className),
        ];
    }

    // A framed control is kept in its own block so it reads as what it is:
    // a setup axis, or one that moves the head up and down.
    function frame(axis: AxisControl): HTMLDivElement {
        return el("div", { class: "axis-frame", "data-axis": axis.axis },
            el("span", { class: "axis-frame-title" }, axis.label),
            axis.note ? el("span", { class: "axis-frame-note" }, axis.note) : null,
            axis.steps ? stepRow(axis) : null,
            el("div", { class: "axis-frame-buttons" }, ...pair(axis, "btn btn-frame")),
            axis.zero ? button(`Set ${axis.letter}=0 here`, () => declare(axis), "btn btn-quiet") : null,
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
            el("span", { class: "choice-label" }, "JointAxis"),
            ...fields.map((field) => field.input),
            fields.length > 0 ? go : null,
            center ? button("Center", () => ctx.call(ctx.api.goto({ kind: "joint", ...center } as GotoRequest)), "btn btn-quiet") : null,
        );
    }

    function draw(): void {
        drawn = controls;
        const steps = el("div", { class: "steps" });
        // The pad's step row serves the pad and every axis without steps of its own.
        if (controls.pad || controls.axes.some((axis) => axis.steps === null)) {
            steps.append(choiceRow(controls.pad_steps, padStep(), (value) => { picks.set("pad", value); }, (value) => `${value} mm`, "Step"));
        }
        for (const axis of controls.axes) {
            if (axis.place === "buttons" && axis.steps) {
                steps.append(stepRow(axis));
            }
        }
        if (controls.feed) {
            steps.append(labeled("Feed mm/min", feedInput));
        }

        const main = el("div", { class: "jog-main" });
        if (controls.pad) {
            main.append(pad());
        }
        const beside = controls.axes.filter((axis) => axis.place === "buttons");
        if (beside.length > 0) {
            main.append(el("div", { class: "axis-buttons" }, ...beside.flatMap((axis) => pair(axis, "btn btn-axis"))));
        }
        for (const axis of controls.axes) {
            if (axis.place === "frame") {
                main.append(frame(axis));
            }
        }

        const rows: HTMLElement[] = [];
        if (controls.pad) {
            rows.push(boardGotoRow());
        }
        const gotoAxes = controls.axes.filter((axis) => axis.goto);
        if (gotoAxes.length > 0 || controls.center) {
            rows.push(jointGotoRow(gotoAxes));
        }

        motors = button("Motors", () => toggleMotors(), "btn btn-quiet");
        const bottom = el("div", { class: "button-row" },
            ...beside.filter((axis) => axis.zero).map((axis) => button(`Set ${axis.letter}=0 here`, () => declare(axis), "btn btn-quiet")),
            motors,
            button("Unlock", () => ctx.call(ctx.api.unlock()), "btn btn-quiet"),
            // The pad carries the cancel button; without one it goes here.
            controls.pad ? null : button("Cancel", () => cancel(), "btn btn-quiet"),
        );
        replace(body, steps, main, ...rows, bottom);
        show(ctx.store.get());
    }

    function show(state: AppState): void {
        body.disabled = !state.snapshot.connected;
        if (motors) {
            motors.textContent = state.snapshot.machine?.enabled ? "Motors off" : "Motors on";
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
        // the machine's page: on the CAM page nothing should move.
        if (inputHasFocus() || activePage() !== "machine") {
            return;
        }
        event.preventDefault();
        if (ctx.store.get().snapshot.connected && keyJog === null) {
            const axis = "axis" in action ? controlOf(controls, action.axis) : undefined;
            const move = "axis" in action
                ? (axis ? jogAxis(axis, action.sign) : Promise.resolve())
                : jogBoard(action.dx * padStep(), action.dy * padStep());
            keyJog = move.finally(() => {
                keyJog = null;
            });
        }
    });
}
