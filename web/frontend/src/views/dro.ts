// Digital readout: joint R and A, board X and Y, laser duty, speed and mode.

import { el } from "../dom.ts";
import { formatDeg, formatDuty, formatMm, formatRate } from "../format.ts";
import type { Machine } from "../types.ts";
import type { Ctx } from "./context.ts";

export interface DroText {
    r: string;
    a: string;
    x: string;
    y: string;
    laser: string;
    rate: string;
    mode: string;
    queue: string;
    motors: string;
}

export function droText(machine: Machine | null): DroText {
    if (!machine) {
        return { r: formatMm(null), a: formatDeg(null), x: formatMm(null), y: formatMm(null), laser: formatDuty(null), rate: formatRate(null), mode: "-", queue: "-", motors: "-" };
    }
    return {
        r: formatMm(machine.joint.r),
        a: formatDeg(machine.joint.a),
        x: formatMm(machine.board.x),
        y: formatMm(machine.board.y),
        laser: formatDuty(machine.laser),
        rate: formatRate(machine.rate),
        mode: machine.mode,
        queue: `${machine.queue.planner}/${machine.queue.lines}`,
        motors: machine.enabled ? "on" : "off",
    };
}

export function mountDro(root: HTMLElement, ctx: Ctx): void {
    const joint = el("div", { class: "dro-row" });
    const board = el("div", { class: "dro-row" });
    root.append(el("h2", {}, "Position"), joint, board);
    const cells = {
        r: bigIn(joint, "R", "mm", "r"),
        a: bigIn(joint, "A", "deg", "a"),
        x: bigIn(board, "X", "mm", "x"),
        y: bigIn(board, "Y", "mm", "y"),
    };
    const small = (name: string): HTMLSpanElement => el("span", { class: "dro-small-value", "data-dro": name }, "-");
    const smalls = { laser: small("laser"), rate: small("rate"), mode: small("mode"), queue: small("queue"), motors: small("motors") };
    root.append(el("div", { class: "dro-small" },
        el("div", {}, el("span", { class: "dro-label" }, "Laser"), smalls.laser),
        el("div", {}, el("span", { class: "dro-label" }, "Speed"), smalls.rate, el("span", { class: "dro-unit" }, "mm/min")),
        el("div", {}, el("span", { class: "dro-label" }, "Mode"), smalls.mode),
        el("div", {}, el("span", { class: "dro-label" }, "Queue"), smalls.queue),
        el("div", {}, el("span", { class: "dro-label" }, "Motors"), smalls.motors),
    ));

    ctx.store.subscribe((state) => {
        const text = droText(state.snapshot.machine);
        setText(cells.r, text.r);
        setText(cells.a, text.a);
        setText(cells.x, text.x);
        setText(cells.y, text.y);
        setText(smalls.laser, text.laser);
        setText(smalls.rate, text.rate);
        setText(smalls.mode, text.mode);
        setText(smalls.queue, text.queue);
        setText(smalls.motors, text.motors);
        root.classList.toggle("laser-on", (state.snapshot.machine?.laser ?? 0) > 0);
    }, ["snapshot"]);
}

function bigIn(row: HTMLElement, label: string, unit: string, name: string): HTMLSpanElement {
    const value = el("span", { class: "dro-value", "data-dro": name }, "-.---");
    row.append(el("div", { class: "dro-cell" }, el("span", { class: "dro-label" }, label), value, el("span", { class: "dro-unit" }, unit)));
    return value;
}

function setText(node: HTMLElement, text: string): void {
    if (node.textContent !== text) {
        node.textContent = text;
    }
}
