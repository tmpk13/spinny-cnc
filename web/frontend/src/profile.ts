// What the machine is, as the backend last read it from the settings, with
// the polar laser standing in until it has said.

import type { Profile, SettingsResponse, Snapshot } from "./types.ts";

export const POLAR_LASER: Profile = { kinematics: "polar", tool: "laser", h_axis: false, r_max: 0, z_max: 0 };

export function profileOf(snapshot: Snapshot): Profile {
    return snapshot.profile ?? POLAR_LASER;
}

export function isCartesian(snapshot: Snapshot): boolean {
    return profileOf(snapshot).kinematics === "cartesian";
}

export function isMilling(snapshot: Snapshot): boolean {
    return profileOf(snapshot).tool === "spindle";
}

/**
 * The output's duty in permille of full power: 0 is the beam dark or the
 * spindle stopped. The status reports the duty driven on the pin, which an
 * active-low output (laser_invert) turns around; without settings read yet
 * the output is taken as active high.
 */
export function outputDuty(driven: number, settings: SettingsResponse | null): number {
    return settings?.values["laser_invert"] ? 1000 - driven : driven;
}

/** A short name for a machine that is not the polar laser; empty for that one. */
export function profileBadge(profile: Profile): string {
    const parts: string[] = [];
    if (profile.kinematics === "cartesian") {
        parts.push("X/Y");
    }
    if (profile.tool === "spindle") {
        parts.push("spindle");
    }
    return parts.join(" ");
}
