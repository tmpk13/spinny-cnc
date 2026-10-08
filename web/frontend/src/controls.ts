// What the jog panel and the readout draw: the machine file's controls, as
// the backend sends them with the settings, or, until it has, the defaults
// for what the machine's profile says it is. The defaults here are the
// backend's (spinny_laser.controls) word for word, so the page looks the
// same before and after the settings arrive, and the in-page mock answers
// with them.

import { profileOf } from "./profile.ts";
import type { AppState } from "./state.ts";
import type { AxisControl, Controls, JointAxis, Profile } from "./types.ts";

/** The joint's unit: degrees for the table, mm for the rest. */
export const UNITS: Record<JointAxis, "mm" | "deg"> = { r: "mm", a: "deg", z: "mm", h: "mm" };

/**
 * The controls for a machine that describes none: the polar laser's board
 * bars, radius and table bars and cross slide bar, with the slide as the Y
 * axis when cartesian, and the focus axis as a bar of its own when one is
 * fitted, called the depth axis with a spindle.
 */
export function defaultControls(profile: Profile): Controls {
    const cartesian = profile.kinematics === "cartesian";
    const milling = profile.tool === "spindle";
    const axes: AxisControl[] = [
        axis("r", "R", "Radius", null, ["Radius -", "Radius +"], true, true, "The beam must be over the rotation axis."),
        // The table is left alone under a cartesian cut, so no goto field there.
        axis("a", "A", "Table", [1, 10, 90], ["Turn -", "Turn +"], true, !cartesian, ""),
    ];
    if (cartesian) {
        axes.push(axis(
            "z", "Z", "Cross slide (Y)", null, ["Z-", "Z+"], true, true,
            "Y is measured from here: over the rotation axis, board X/Y is where a polar job puts it.",
            "Y axis: moves across the rail, which is X; steps and feed as the rail's",
        ));
    } else {
        // The cross slide is set from a measured centering burn, so its steps
        // are the small corrections that reading calls for.
        axes.push(axis(
            "z", "Z", "Cross slide", [0.05, 0.1, 0.5], ["Z-", "Z+"], false, false,
            "The rail is over the axis when the centering lines meet at a point.",
            "Setup only: carries the rail across the rotation axis",
        ));
    }
    if (profile.h_axis) {
        // Fine steps to find focus by eye, a coarse one to clear the board.
        if (milling) {
            axes.push(axis(
                "h", "H", "Depth axis", [0.05, 0.1, 1], ["Down", "Up"], false, false,
                "Touch the tool to the copper first: a milled cut without a height map goes down from H 0."
                + " A height map probed before keeps its heights in the old numbers, so a run follows it"
                + " only after Touch off here again (probe again for another board).",
                "Raises and lowers the tool; up is positive, H 0 is the board's surface",
            ));
        } else {
            axes.push(axis(
                "h", "H", "Focus axis", [0.05, 0.1, 1], ["Down", "Up"], false, false,
                "A height map probed before keeps its heights in the old numbers, so a run follows it"
                + " only after Focus here again (probe again for another board).",
                "Raises and lowers the head; up is positive",
            ));
        }
    }
    return {
        pad: true,
        pad_steps: [0.1, 1, 10],
        pad_step: 1,
        feed: true,
        // The rotation axis: R 0 on the polar machine, where the slide is
        // parked over it; on a cartesian machine the slide is Y, so Z 0 too.
        center: cartesian ? { r: 0, z: 0 } : { r: 0 },
        axes,
    };
}

function axis(
    joint: JointAxis,
    letter: string,
    label: string,
    steps: number[] | null,
    buttons: [string, string],
    feed: boolean,
    goto: boolean,
    zeroHint: string,
    note = "",
): AxisControl {
    return {
        axis: joint,
        letter,
        label,
        steps,
        step: steps ? steps[Math.floor(steps.length / 2)]! : null,
        buttons,
        feed,
        goto,
        zero: true,
        zero_hint: zeroHint,
        keys: [],
        note,
    };
}

/** The controls to draw now: the settings' when read, else the profile's defaults. */
export function controlsOf(state: AppState): Controls {
    return state.settings?.controls ?? defaultControls(profileOf(state.snapshot));
}

export function sameControls(a: Controls, b: Controls): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

/** The control of a joint, if the machine shows one. */
export function controlOf(controls: Controls, joint: JointAxis): AxisControl | undefined {
    return controls.axes.find((entry) => entry.axis === joint);
}
