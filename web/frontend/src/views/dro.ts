// Digital readout: one cell per joint the machine's controls show, with
// the letter the machine file gives it, board X and Y when the machine has
// a board pad, laser duty or spindle speed, speed, mode and the probe.

import { controlsOf, sameControls, unitOf } from "../controls.ts";
import { el, replace } from "../dom.ts";
import { formatDeg, formatDuty, formatMm, formatRate } from "../format.ts";
import { isDispensing, isMilling, outputDuty, profileOf } from "../profile.ts";
import type { Controls, JointAxis, Machine, Profile, SettingsResponse } from "../types.ts";
import type { Ctx } from "./context.ts";

export interface DroText {
    r: string;
    a: string;
    z: string;
    /** Null on a machine without a focus axis, whose cell is hidden. */
    h: string | null;
    x: string;
    y: string;
    laser: string;
    rate: string;
    mode: string;
    queue: string;
    motors: string;
    /** "down" or "up"; null without a focus axis. */
    probe: string | null;
    /** The homed joints' letters, or "none"; null without an endstop. */
    homed: string | null;
}

/**
 * The settings say which way round the output is driven; see outputDuty.
 * On a dispenser the table joint is the plunger in mm, shown to the three
 * decimals the mm axes get rather than the table's four.
 */
export function droText(machine: Machine | null, settings: SettingsResponse | null = null, dispensing = false): DroText {
    const formatA = dispensing ? formatMm : formatDeg;
    if (!machine) {
        return { r: formatMm(null), a: formatA(null), z: formatMm(null), h: null, x: formatMm(null), y: formatMm(null), laser: formatDuty(null), rate: formatRate(null), mode: "-", queue: "-", motors: "-", probe: null, homed: null };
    }
    const h = machine.joint.h;
    const probe = machine.probe;
    const homed = machine.homed;
    return {
        r: formatMm(machine.joint.r),
        a: formatA(machine.joint.a),
        z: formatMm(machine.joint.z),
        h: h === null || h === undefined ? null : formatMm(h),
        x: formatMm(machine.board.x),
        y: formatMm(machine.board.y),
        laser: formatDuty(outputDuty(machine.laser, settings)),
        rate: formatRate(machine.rate),
        mode: machine.mode,
        queue: `${machine.queue.planner}/${machine.queue.lines}`,
        motors: machine.enabled ? "on" : "off",
        probe: probe === null || probe === undefined ? null : probe ? "down" : "up",
        homed: homed === null || homed === undefined ? null : homed === "" ? "none" : homed,
    };
}

/** What the readout says of a report's age: nothing while it is fresh. */
export function ageText(machine: Machine | null): string {
    const age = machine?.age ?? 0;
    return age > 1.5 ? `last report ${Math.round(age)} s ago` : "";
}

export function mountDro(root: HTMLElement, ctx: Ctx): void {
    const joint = el("div", { class: "dro-row dro-row-joint" });
    const board = el("div", { class: "dro-row" });
    // Says when the numbers are old: a machine that has gone quiet is
    // still shown at its last report, which is not where it may be.
    const age = el("span", { class: "dro-age badge hidden" }, "");
    root.append(el("div", { class: "panel-head" }, el("h2", {}, "Position"), age), joint, board);
    const cells = new Map<JointAxis, HTMLSpanElement>();
    const boardCells = { x: bigCell("X", "mm", "x"), y: bigCell("Y", "mm", "y") };
    board.append(boardCells.x.parentElement!, boardCells.y.parentElement!);
    const small = (name: string): HTMLSpanElement => el("span", { class: "dro-small-value", "data-dro": name }, "-");
    const smalls = { laser: small("laser"), rate: small("rate"), mode: small("mode"), queue: small("queue"), motors: small("motors"), probe: small("probe"), homed: small("homed") };
    const probeBox = el("div", {}, el("span", { class: "dro-label" }, "Probe"), smalls.probe);
    const homedBox = el("div", {}, el("span", { class: "dro-label" }, "Homed"), smalls.homed);
    // The output's duty is a spindle's speed on a spindle machine.
    const outputLabel = el("span", { class: "dro-label" }, "Laser");
    root.append(el("div", { class: "dro-small" },
        el("div", {}, outputLabel, smalls.laser),
        el("div", {}, el("span", { class: "dro-label" }, "Speed"), smalls.rate, el("span", { class: "dro-unit" }, "mm/min")),
        el("div", {}, el("span", { class: "dro-label" }, "Mode"), smalls.mode),
        el("div", {}, el("span", { class: "dro-label" }, "Queue"), smalls.queue),
        el("div", {}, el("span", { class: "dro-label" }, "Motors"), smalls.motors),
        probeBox,
        homedBox,
    ));
    let drawn: Controls | null = null;
    let drawnProfile: Profile | null = null;

    /** The joint cells, one per control, in the controls' order; the board row only with a pad. */
    function draw(controls: Controls, profile: Profile): void {
        drawn = controls;
        drawnProfile = profile;
        cells.clear();
        const nodes = controls.axes.map((axis) => {
            const value = bigCell(axis.letter, unitOf(axis.axis, profile), axis.axis);
            cells.set(axis.axis, value);
            return value.parentElement!;
        });
        replace(joint, ...nodes);
        board.classList.toggle("hidden", !controls.pad);
    }

    ctx.store.subscribe((state) => {
        const controls = controlsOf(state);
        const profile = profileOf(state.snapshot);
        // The units follow the tool as well as the controls: the table's
        // cell reads mm once the settings say the joint is a plunger.
        if (drawn === null || !sameControls(drawn, controls) || drawnProfile?.tool !== profile.tool) {
            draw(controls, profile);
        }
        const machine = state.snapshot.machine;
        const text = droText(machine, state.settings, isDispensing(state.snapshot));
        for (const [axis, cell] of cells) {
            setText(cell, text[axis] ?? "-.---");
        }
        setText(smalls.probe, text.probe ?? "-");
        probeBox.classList.toggle("hidden", text.probe === null);
        setText(smalls.homed, text.homed ?? "-");
        homedBox.classList.toggle("hidden", text.homed === null);
        smalls.probe.toggleAttribute("data-down", text.probe === "down");
        setText(boardCells.x, text.x);
        setText(boardCells.y, text.y);
        setText(smalls.laser, text.laser);
        setText(outputLabel, isMilling(state.snapshot) ? "Spindle" : "Laser");
        setText(smalls.rate, text.rate);
        setText(smalls.mode, text.mode);
        setText(smalls.queue, text.queue);
        setText(smalls.motors, text.motors);
        const stale = state.snapshot.connected ? ageText(machine) : "";
        setText(age, stale);
        age.classList.toggle("hidden", stale === "");
        root.classList.toggle("laser-on", machine !== null && outputDuty(machine.laser, state.settings) > 0);
    }, ["snapshot", "settings"]);
    draw(controlsOf(ctx.store.get()), profileOf(ctx.store.get().snapshot));
}

/** A big cell: the label, the value and its unit; returns the value span, inside its cell. */
function bigCell(label: string, unit: string, name: string): HTMLSpanElement {
    const value = el("span", { class: "dro-value", "data-dro": name }, "-.---");
    el("div", { class: "dro-cell" }, el("span", { class: "dro-label" }, label), value, el("span", { class: "dro-unit" }, unit));
    return value;
}

function setText(node: HTMLElement, text: string): void {
    if (node.textContent !== text) {
        node.textContent = text;
    }
}
