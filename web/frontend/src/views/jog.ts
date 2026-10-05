// Jog pad for board X/Y, radius and turn buttons, the focus axis (on a
// machine with one), the cross slide setup control, go-to fields, position
// declaration, motors and unlock. Arrow keys jog when no input has focus;
// Escape cancels a jog or goto from anywhere but a dialog while a machine
// is connected.
// On a cartesian machine the cross slide is the Y axis instead of a setup
// control: it steps like the rail, at the feed given, and a joint goto
// takes it beside the radius.

import { askConfirm } from "../confirm.ts";
import { activePage, button, el, inputHasFocus, labeled, modalOpen, numberField } from "../dom.ts";
import { parseNumber } from "../format.ts";
import { isCartesian, isMilling } from "../profile.ts";
import { choiceRow, type Ctx } from "./context.ts";

export const STEPS_MM = [0.1, 1, 10];
export const STEPS_DEG = [1, 10, 90];
// The cross slide is set from a measured centering burn, so its steps are the
// small corrections that reading calls for.
export const STEPS_Z = [0.05, 0.1, 0.5];
// The focus axis: fine steps to find focus by eye, a coarse one to clear the board.
export const STEPS_H = [0.05, 0.1, 1];

export interface JogControls {
    jogBoard(dx: number, dy: number): Promise<void>;
    jogJoint(dr: number, da: number): Promise<void>;
    jogSlide(dz: number): Promise<void>;
    jogFocus(dh: number): Promise<void>;
    cancel(): Promise<void>;
    stepMm(): number;
    stepDeg(): number;
    stepZ(): number;
}

/** Maps a key to a board jog in step units, or a cancel; null when the key is not bound. */
export function keyAction(key: string): { dx: number; dy: number } | "cancel" | null {
    switch (key) {
        case "ArrowLeft":
            return { dx: -1, dy: 0 };
        case "ArrowRight":
            return { dx: 1, dy: 0 };
        case "ArrowUp":
            return { dx: 0, dy: 1 };
        case "ArrowDown":
            return { dx: 0, dy: -1 };
        case "Escape":
            return "cancel";
        default:
            return null;
    }
}

export function mountJog(root: HTMLElement, ctx: Ctx): JogControls {
    let stepMm = 1;
    let stepDeg = 10;
    let stepZ = 0.1;
    let stepH = 0.1;
    const feedInput = numberField({ placeholder: "default", min: 0 });
    const feed = (): number | null => parseNumber(feedInput.value);

    const controls: JogControls = {
        async jogBoard(dx, dy) {
            await ctx.call(ctx.api.jog({ kind: "board", dx, dy, feed: feed() }));
        },
        async jogJoint(dr, da) {
            const request = dr !== 0 && da !== 0
                ? { kind: "joint" as const, dr, da, feed: feed() }
                : dr !== 0
                    ? { kind: "joint" as const, dr, feed: feed() }
                    : { kind: "joint" as const, da, feed: feed() };
            await ctx.call(ctx.api.jog(request));
        },
        async jogSlide(dz) {
            // As a setup axis the slide keeps the firmware's own jog rate:
            // the feed field belongs to the moves that carry the beam over
            // the board, which on a cartesian machine it is one of.
            const cartesian = isCartesian(ctx.store.get().snapshot);
            await ctx.call(ctx.api.jog({ kind: "joint", dz, feed: cartesian ? feed() : null }));
        },
        async jogFocus(dh) {
            // Its own rate too: the firmware's jog_h, not a surface speed.
            await ctx.call(ctx.api.jog({ kind: "joint", dh, feed: null }));
        },
        async cancel() {
            await ctx.call(ctx.api.jogCancel());
        },
        stepMm: () => stepMm,
        stepDeg: () => stepDeg,
        stepZ: () => stepZ,
    };

    const body = el("fieldset", { class: "panel-body" });
    root.append(el("h2", {}, "Jog"), body);

    body.append(
        el("div", { class: "steps" },
            choiceRow(STEPS_MM, stepMm, (value) => { stepMm = value; }, (value) => `${value} mm`, "Step"),
            choiceRow(STEPS_DEG, stepDeg, (value) => { stepDeg = value; }, (value) => `${value} deg`, "Turn"),
            labeled("Feed mm/min", feedInput),
        ),
    );

    const padButton = (label: string, area: string, onClick: () => Promise<void>, extra = ""): HTMLButtonElement => {
        const node = button(label, onClick, `btn btn-pad ${extra}`.trim());
        node.style.gridArea = area;
        return node;
    };
    const pad = el("div", { class: "pad" },
        padButton("Y+", "up", () => controls.jogBoard(0, stepMm)),
        padButton("X-", "left", () => controls.jogBoard(-stepMm, 0)),
        padButton("Cancel", "mid", () => controls.cancel(), "btn-cancel"),
        padButton("X+", "right", () => controls.jogBoard(stepMm, 0)),
        padButton("Y-", "down", () => controls.jogBoard(0, -stepMm)),
    );
    const axes = el("div", { class: "axis-buttons" },
        button("Radius -", () => controls.jogJoint(-stepMm, 0), "btn btn-axis"),
        button("Radius +", () => controls.jogJoint(stepMm, 0), "btn btn-axis"),
        button("Turn -", () => controls.jogJoint(0, -stepDeg), "btn btn-axis"),
        button("Turn +", () => controls.jogJoint(0, stepDeg), "btn btn-axis"),
    );
    // The cross slide is not a board move: it is kept in its own frame so it
    // reads as the setup control it is. On a cartesian machine it is an axis
    // like the rail and steps with the main step.
    const slideTitle = el("span", { class: "slide-title" }, "Cross slide");
    const slideNote = el("span", { class: "slide-note" }, "Setup only: carries the rail across the rotation axis");
    const slideSteps = choiceRow(STEPS_Z, stepZ, (value) => { stepZ = value; }, (value) => `${value} mm`, "Step");
    const slideStep = (): number => (isCartesian(ctx.store.get().snapshot) ? stepMm : stepZ);
    const slide = el("div", { class: "slide" },
        slideTitle,
        slideNote,
        slideSteps,
        el("div", { class: "slide-buttons" },
            button("Z-", () => controls.jogSlide(-slideStep()), "btn btn-slide"),
            button("Z+", () => controls.jogSlide(slideStep()), "btn btn-slide"),
        ),
        button("Set Z=0 here", () => declare("z"), "btn btn-quiet"),
    );
    // The focus axis moves the head up and down over the board; it is shown
    // only on a machine that reports one.
    const focusTitle = el("span", { class: "slide-title" }, "Focus axis");
    const focusNote = el("span", { class: "slide-note" }, "Raises and lowers the head; up is positive");
    const focus = el("div", { class: "slide focus-axis hidden" },
        focusTitle,
        focusNote,
        choiceRow(STEPS_H, stepH, (value) => { stepH = value; }, (value) => `${value} mm`, "Step"),
        el("div", { class: "slide-buttons" },
            button("Down", () => controls.jogFocus(-stepH), "btn btn-slide"),
            button("Up", () => controls.jogFocus(stepH), "btn btn-slide"),
        ),
        button("Set H=0 here", () => declare("h"), "btn btn-quiet"),
    );
    body.append(el("div", { class: "jog-main" }, pad, axes, slide, focus));

    const gotoX = numberField({ placeholder: "x" });
    const gotoY = numberField({ placeholder: "y" });
    // A negative radius is the far side of the axis, which the machine
    // takes on a jog: it is how the head is lined up with the axis.
    const gotoR = numberField({ placeholder: "r" });
    const gotoA = numberField({ placeholder: "a" });
    // On a cartesian machine the joint goto takes the cross slide instead of
    // the table, which holds the board still under a cut.
    const gotoZ = numberField({ placeholder: "z" });
    gotoZ.classList.add("hidden");
    const gotoBoard = async (): Promise<void> => {
        const x = parseNumber(gotoX.value);
        const y = parseNumber(gotoY.value);
        if (x === null && y === null) {
            ctx.toast("error", "enter x and/or y");
            return;
        }
        // A blank axis is left to the backend, which keeps the coordinate
        // the head will have once the jog in progress ends; the readout
        // here is a point it is passing through.
        await ctx.call(ctx.api.goto({ kind: "board", ...(x !== null ? { x } : {}), ...(y !== null ? { y } : {}), feed: feed() }));
    };
    const gotoJoint = async (): Promise<void> => {
        const r = parseNumber(gotoR.value);
        if (isCartesian(ctx.store.get().snapshot)) {
            const z = parseNumber(gotoZ.value);
            if (r === null && z === null) {
                ctx.toast("error", "enter r and/or z");
                return;
            }
            await ctx.call(ctx.api.goto({ kind: "joint", feed: feed(), ...(r !== null ? { r } : {}), ...(z !== null ? { z } : {}) }));
            return;
        }
        const a = parseNumber(gotoA.value);
        if (r === null && a === null) {
            ctx.toast("error", "enter r and/or a");
            return;
        }
        const request = { kind: "joint" as const, feed: feed(), ...(r !== null ? { r } : {}), ...(a !== null ? { a } : {}) };
        await ctx.call(ctx.api.goto(request));
    };
    // The rotation axis: R 0 on the polar machine, where the slide is parked
    // over it; on a cartesian machine the slide is Y, so Z 0 as well.
    const goCenter = (): Promise<unknown> => ctx.call(ctx.api.goto(isCartesian(ctx.store.get().snapshot)
        ? { kind: "joint", r: 0, z: 0 }
        : { kind: "joint", r: 0 }));
    const goBoard = button("Go", () => gotoBoard(), "btn btn-quiet");
    const goJoint = button("Go", () => gotoJoint(), "btn btn-quiet");
    const onEnter = (target: HTMLButtonElement) => (event: Event): void => {
        if ((event as KeyboardEvent).key === "Enter") {
            event.preventDefault();
            target.click();
        }
    };
    gotoX.addEventListener("keydown", onEnter(goBoard));
    gotoY.addEventListener("keydown", onEnter(goBoard));
    gotoR.addEventListener("keydown", onEnter(goJoint));
    gotoA.addEventListener("keydown", onEnter(goJoint));
    gotoZ.addEventListener("keydown", onEnter(goJoint));

    body.append(
        el("div", { class: "goto-row" },
            el("span", { class: "choice-label" }, "Board"),
            gotoX, gotoY,
            goBoard,
        ),
        el("div", { class: "goto-row" },
            el("span", { class: "choice-label" }, "Joint"),
            gotoR, gotoA, gotoZ,
            goJoint,
            button("Center", () => goCenter(), "btn btn-quiet"),
        ),
    );

    const toggleMotors = async (): Promise<void> => {
        const enabled = ctx.store.get().snapshot.machine?.enabled ?? false;
        await ctx.call(ctx.api.motors(!enabled));
    };
    const motors = button("Motors", () => toggleMotors(), "btn btn-quiet");
    body.append(
        el("div", { class: "button-row" },
            button("Set R=0 here", () => declare("r"), "btn btn-quiet"),
            button("Set A=0 here", () => declare("a"), "btn btn-quiet"),
            motors,
            button("Unlock", () => ctx.call(ctx.api.unlock()), "btn btn-quiet"),
        ),
    );

    async function declare(axis: "r" | "a" | "z" | "h"): Promise<void> {
        const what = { r: "the radius", a: "the table angle", z: "the cross slide", h: "the focus axis" }[axis];
        const hint = {
            r: "The beam must be over the rotation axis.",
            a: "",
            z: isCartesian(ctx.store.get().snapshot)
                ? "Y is measured from here: over the rotation axis, board X/Y is where a polar job puts it."
                : "The rail is over the axis when the centering lines meet at a point.",
            h: isMilling(ctx.store.get().snapshot)
                ? "Touch the tool to the copper first: a milled cut without a height map goes down from H 0."
                    + " A height map probed before keeps its heights in the old numbers, so a run follows it"
                    + " only after Touch off here again (probe again for another board)."
                : "A height map probed before keeps its heights in the old numbers, so a run follows it"
                    + " only after Focus here again (probe again for another board).",
        }[axis];
        const ok = await askConfirm(`Declare ${what} to be 0 at the current position? ${hint}`.trim(), "Set 0");
        if (ok) {
            await ctx.call(ctx.api.setPosition({ [axis]: 0 }));
        }
    }

    ctx.store.subscribe((state) => {
        const machine = state.snapshot.machine;
        body.disabled = !state.snapshot.connected;
        motors.textContent = machine?.enabled ? "Motors off" : "Motors on";
        focus.classList.toggle("hidden", machine?.joint.h === null || machine?.joint.h === undefined);
        const cartesian = isCartesian(state.snapshot);
        slideNote.textContent = cartesian
            ? "Y axis: moves across the rail, which is X; steps and feed as the rail's"
            : "Setup only: carries the rail across the rotation axis";
        slideTitle.textContent = cartesian ? "Cross slide (Y)" : "Cross slide";
        slideSteps.classList.toggle("hidden", cartesian);
        gotoA.classList.toggle("hidden", cartesian);
        gotoZ.classList.toggle("hidden", !cartesian);
        const milling = isMilling(state.snapshot);
        focusTitle.textContent = milling ? "Depth axis" : "Focus axis";
        focusNote.textContent = milling
            ? "Raises and lowers the tool; up is positive, H 0 is the board's surface"
            : "Raises and lowers the head; up is positive";
    }, ["snapshot"]);

    // One key jog at a time: a held or hammered key must not queue up moves.
    let keyJog: Promise<void> | null = null;
    document.addEventListener("keydown", (event) => {
        if (event.defaultPrevented || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) {
            return;
        }
        // An open dialog answers every key, Escape included.
        if (modalOpen()) {
            return;
        }
        const action = keyAction(event.key);
        if (action === null) {
            return;
        }
        // The stop works from a field too: a goto started with Enter
        // leaves the focus in the field it was typed in. With no machine
        // there is nothing to stop, and the key stays the field's.
        if (action === "cancel") {
            if (ctx.store.get().snapshot.connected) {
                event.preventDefault();
                void controls.cancel();
            }
            return;
        }
        // Arrow keys belong to a field that has the focus, and jog only
        // from the machine's page: on the CAM page nothing should move.
        if (inputHasFocus() || activePage() !== "machine") {
            return;
        }
        event.preventDefault();
        if (ctx.store.get().snapshot.connected && keyJog === null) {
            keyJog = controls.jogBoard(action.dx * stepMm, action.dy * stepMm).finally(() => {
                keyJog = null;
            });
        }
    });

    return controls;
}
