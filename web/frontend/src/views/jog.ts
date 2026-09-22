// Jog pad for board X/Y, radius and turn buttons, the cross slide setup
// control, go-to fields, position declaration, motors and unlock. Arrow keys
// jog when no input has focus.

import { askConfirm } from "../confirm.ts";
import { button, el, inputHasFocus, labeled, modalOpen, numberField } from "../dom.ts";
import { parseNumber } from "../format.ts";
import { choiceRow, type Ctx } from "./context.ts";

export const STEPS_MM = [0.1, 1, 10];
export const STEPS_DEG = [1, 10, 90];
// The cross slide is set from a measured centering burn, so its steps are the
// small corrections that reading calls for.
export const STEPS_Z = [0.05, 0.1, 0.5];

export interface JogControls {
    jogBoard(dx: number, dy: number): Promise<void>;
    jogJoint(dr: number, da: number): Promise<void>;
    jogSlide(dz: number): Promise<void>;
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
            // The slide keeps the firmware's own jog rate: the feed field
            // belongs to the moves that carry the beam over the board.
            await ctx.call(ctx.api.jog({ kind: "joint", dz, feed: null }));
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
    // reads as the setup control it is.
    const slide = el("div", { class: "slide" },
        el("span", { class: "slide-title" }, "Cross slide"),
        el("span", { class: "slide-note" }, "Setup only: carries the rail across the rotation axis"),
        choiceRow(STEPS_Z, stepZ, (value) => { stepZ = value; }, (value) => `${value} mm`, "Step"),
        el("div", { class: "slide-buttons" },
            button("Z-", () => controls.jogSlide(-stepZ), "btn btn-slide"),
            button("Z+", () => controls.jogSlide(stepZ), "btn btn-slide"),
        ),
        button("Set Z=0 here", () => declare("z"), "btn btn-quiet"),
    );
    body.append(el("div", { class: "jog-main" }, pad, axes, slide));

    const gotoX = numberField({ placeholder: "x" });
    const gotoY = numberField({ placeholder: "y" });
    const gotoR = numberField({ placeholder: "r", min: 0 });
    const gotoA = numberField({ placeholder: "a" });
    const gotoBoard = async (): Promise<void> => {
        let x = parseNumber(gotoX.value);
        let y = parseNumber(gotoY.value);
        if (x === null && y === null) {
            ctx.toast("error", "enter x and/or y");
            return;
        }
        // A board goto is absolute in both axes; a blank one keeps the current coordinate.
        const here = ctx.store.get().snapshot.machine?.board;
        if (x === null || y === null) {
            if (!here) {
                ctx.toast("error", "enter both x and y: the position is not known");
                return;
            }
            x = x ?? here.x;
            y = y ?? here.y;
        }
        await ctx.call(ctx.api.goto({ kind: "board", x, y, feed: feed() }));
    };
    const gotoJoint = async (): Promise<void> => {
        const r = parseNumber(gotoR.value);
        const a = parseNumber(gotoA.value);
        if (r === null && a === null) {
            ctx.toast("error", "enter r and/or a");
            return;
        }
        const request = { kind: "joint" as const, feed: feed(), ...(r !== null ? { r } : {}), ...(a !== null ? { a } : {}) };
        await ctx.call(ctx.api.goto(request));
    };
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

    body.append(
        el("div", { class: "goto-row" },
            el("span", { class: "choice-label" }, "Board"),
            gotoX, gotoY,
            goBoard,
        ),
        el("div", { class: "goto-row" },
            el("span", { class: "choice-label" }, "Joint"),
            gotoR, gotoA,
            goJoint,
            button("Center", () => ctx.call(ctx.api.goto({ kind: "joint", r: 0 })), "btn btn-quiet"),
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

    async function declare(axis: "r" | "a" | "z"): Promise<void> {
        const what = { r: "the radius", a: "the table angle", z: "the cross slide" }[axis];
        const hint = {
            r: "The beam must be over the rotation axis.",
            a: "",
            z: "The rail is over the axis when the centering lines meet at a point.",
        }[axis];
        const ok = await askConfirm(`Declare ${what} to be 0 at the current position? ${hint}`.trim(), "Set 0");
        if (ok) {
            const request = axis === "r" ? { r: 0 } : axis === "a" ? { a: 0 } : { z: 0 };
            await ctx.call(ctx.api.setPosition(request));
        }
    }

    ctx.store.subscribe((state) => {
        const machine = state.snapshot.machine;
        body.disabled = !state.snapshot.connected;
        motors.textContent = machine?.enabled ? "Motors off" : "Motors on";
    }, ["snapshot"]);

    // One key jog at a time: a held or hammered key must not queue up moves.
    let keyJog: Promise<void> | null = null;
    document.addEventListener("keydown", (event) => {
        if (event.defaultPrevented || event.repeat || event.altKey || event.ctrlKey || event.metaKey) {
            return;
        }
        if (inputHasFocus() || modalOpen()) {
            return;
        }
        const action = keyAction(event.key);
        if (action === null) {
            return;
        }
        event.preventDefault();
        if (action === "cancel") {
            void controls.cancel();
        } else if (ctx.store.get().snapshot.connected && keyJog === null) {
            keyJog = controls.jogBoard(action.dx * stepMm, action.dy * stepMm).finally(() => {
                keyJog = null;
            });
        }
    });

    return controls;
}
