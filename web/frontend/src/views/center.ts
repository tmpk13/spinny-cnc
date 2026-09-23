// The centering test burn: the options of `spinny-center`, made into a job.

import { button, el, labeled, numberField, replace } from "../dom.ts";
import { parseNumber } from "../format.ts";
import type { CenterRequest } from "../types.ts";
import type { Ctx } from "./context.ts";

/** The fine pattern's own dimensions, as the backend defaults them. */
export const FINE_DEFAULTS = { reach: 7, ring: 0, angle: 3, cross: 4, arm: 2.5, spiral: 5 };
export const COARSE_DEFAULTS = { lines: 4, reach: 6, ring: 8 };

/** The raw text of each field; a blank one is left for the backend to default. */
export interface CenterFields {
    fine: boolean;
    lines: string;
    reach: string;
    ring: string;
    angle: string;
    cross: string;
    arm: string;
    spiral: string;
    errorAlong: string;
    errorAcross: string;
    power: string;
    speed: string;
    spot: string;
}

/**
 * The request the fields describe, or a message saying which field is wrong.
 * Only the options of the chosen pattern are sent, so a value left in a
 * field of the other one is not refused as not applying.
 */
export function centerRequest(fields: CenterFields): CenterRequest | string {
    const out: CenterRequest = { fine: fields.fine };
    const take = (text: string, name: string): number | null | string => {
        if (text.trim() === "") {
            return null;
        }
        const value = parseNumber(text);
        return value === null ? `${name} is not a number` : value;
    };
    const numbers: [keyof CenterRequest, string, string][] = [
        ["reach", fields.reach, "reach"],
        ["ring", fields.ring, "ring"],
        ["power", fields.power, "power"],
        ["speed", fields.speed, "speed"],
        ["spot", fields.spot, "spot"],
    ];
    if (fields.fine) {
        numbers.push(["angle", fields.angle, "angle"], ["cross", fields.cross, "cross"], ["arm", fields.arm, "arm"], ["spiral", fields.spiral, "spiral"]);
    } else {
        numbers.push(["lines", fields.lines, "lines"]);
    }
    for (const [key, text, name] of numbers) {
        const value = take(text, name);
        if (typeof value === "string") {
            return value;
        }
        if (value !== null) {
            (out as Record<string, unknown>)[key] = value;
        }
    }
    if (out.lines !== undefined && !Number.isInteger(out.lines)) {
        return "lines must be a whole number";
    }
    if (fields.fine) {
        const along = take(fields.errorAlong, "error E");
        const across = take(fields.errorAcross, "error Z");
        if (typeof along === "string" || typeof across === "string") {
            return typeof along === "string" ? along : (across as string);
        }
        if (along !== null || across !== null) {
            out.show_error = [along ?? 0, across ?? 0];
        }
    }
    return out;
}

export function centerTest(ctx: Ctx): HTMLElement {
    const fine = el("input", { type: "checkbox", "aria-label": "Fine pattern" });
    const lines = numberField({ value: COARSE_DEFAULTS.lines, min: 0, step: 1 });
    const reach = numberField({ min: 0, step: 0.1 });
    const ring = numberField({ min: 0, step: 0.1 });
    const angle = numberField({ value: FINE_DEFAULTS.angle, min: 0, step: 0.5 });
    const cross = numberField({ value: FINE_DEFAULTS.cross, min: 0, step: 0.1 });
    const arm = numberField({ value: FINE_DEFAULTS.arm, min: 0, step: 0.1 });
    const spiral = numberField({ value: FINE_DEFAULTS.spiral, min: 0, step: 0.1 });
    const errorAlong = numberField({ step: 0.01, placeholder: "off" });
    const errorAcross = numberField({ step: 0.01, placeholder: "off" });
    const power = numberField({ value: 400, min: 0, step: 1 });
    const speed = numberField({ value: 200, min: 1, step: 1 });
    const spot = numberField({ value: 0.1, min: 0.01, step: 0.01 });
    const fineOnly = [angle, cross, arm, spiral, errorAlong, errorAcross];
    const output = el("div", { class: "center-test-output" });

    const showMode = (): void => {
        const defaults = fine.checked ? FINE_DEFAULTS : COARSE_DEFAULTS;
        reach.placeholder = String(defaults.reach);
        ring.placeholder = String(defaults.ring);
        lines.disabled = fine.checked;
        for (const field of fineOnly) {
            field.disabled = !fine.checked;
        }
    };
    fine.addEventListener("change", showMode);
    showMode();

    async function make(): Promise<void> {
        const request = centerRequest({
            fine: fine.checked,
            lines: lines.value,
            reach: reach.value,
            ring: ring.value,
            angle: angle.value,
            cross: cross.value,
            arm: arm.value,
            spiral: spiral.value,
            errorAlong: errorAlong.value,
            errorAcross: errorAcross.value,
            power: power.value,
            speed: speed.value,
            spot: spot.value,
        });
        if (typeof request === "string") {
            ctx.toast("error", request);
            return;
        }
        const result = await ctx.call(ctx.api.centerJob(request));
        if (!result) {
            return;
        }
        replace(output,
            el("pre", { class: "center-test-summary" }, result.summary.join("\n")),
            el("ul", { class: "center-test-notes" }, ...result.notes.map((note) => el("li", {}, note))),
        );
        await ctx.refreshJobs();
        await ctx.selectJob(result.job.id);
        ctx.toast("info", `made ${result.job.name}`);
    }

    return el("details", { class: "center-test" },
        el("summary", {}, "Centering test"),
        el("p", { class: "muted" },
            "Radial lines and a ring that show where the rotation axis really is; the fine pattern"
            + " crosses marks from both sides of the axis so what is left is amplified. Blank reach"
            + " and ring take the pattern's default. Cut it in constant power mode."),
        el("div", { class: "field-grid" },
            labeled("Fine pattern", fine, "labeled inline"),
            labeled("Lines", lines),
            labeled("Reach mm", reach),
            labeled("Ring mm", ring),
            labeled("Angle deg", angle),
            labeled("Cross mm", cross),
            labeled("Arm mm", arm),
            labeled("Spiral mm", spiral),
            labeled("Show error E mm", errorAlong),
            labeled("Show error Z mm", errorAcross),
            labeled("Power S", power),
            labeled("Speed mm/min", speed),
            labeled("Spot mm", spot),
        ),
        button("Make test job", () => make(), "btn"),
        output,
    );
}
