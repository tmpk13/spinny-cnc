// The calibration tests, made into a job: a laser's material test (a grid
// of squares at a power and a speed each) and a mill's depth test (a row
// of slots a step deeper each). The one for the machine shows; a
// dispenser has neither.

import { button, el, labeled, numberField, replace } from "../dom.ts";
import { parseNumber } from "../format.ts";
import { profileOf } from "../profile.ts";
import type { AppState } from "../state.ts";
import type { CalibrateRequest } from "../types.ts";
import type { Ctx } from "./context.ts";

/** The raw text of each field; a blank one is left for the backend to default. */
export type CalibrateFields = Record<string, string> & { kind: "material" | "depth"; fill: string };

/** The request the fields describe, or a message saying which field is wrong; a ladder needs all three of its fields or none. */
export function calibrateRequest(fields: CalibrateFields): CalibrateRequest | string {
    const out: CalibrateRequest = { kind: fields.kind };
    const read = (name: string): number | null | string => {
        const text = (fields[name] ?? "").trim();
        if (text === "") {
            return null;
        }
        const value = parseNumber(text);
        return value === null ? `${name} is not a number` : value;
    };
    const ladders: [keyof CalibrateRequest, string][] = fields.kind === "material" ? [["powers", "power"], ["speeds", "speed"]] : [["depths", "depth"]];
    for (const [key, name] of ladders) {
        const parts = [read(`${name} from`), read(`${name} to`), read(`${name} steps`)];
        const wrong = parts.find((part) => typeof part === "string");
        if (wrong !== undefined) {
            return wrong as string;
        }
        if (parts.every((part) => part === null)) {
            continue;
        }
        if (parts.some((part) => part === null)) {
            return `give the ${name} ladder its from, to and steps, or none of them`;
        }
        if (!Number.isInteger(parts[2])) {
            return `${name} steps must be a whole number`;
        }
        (out as Record<string, unknown>)[key] = parts as [number, number, number];
    }
    const singles = fields.kind === "material" ? ["size", "gap", "spot", "x", "y"] : ["length", "gap", "feed", "plunge", "spindle", "x", "y"];
    for (const name of singles) {
        const value = read(name);
        if (typeof value === "string") {
            return value;
        }
        if (value !== null) {
            (out as Record<string, unknown>)[name] = value;
        }
    }
    if (fields.kind === "material") {
        out.fill = fields.fill === "1";
    }
    return out;
}

export function calibrationTest(ctx: Ctx): HTMLElement {
    const field = (name: string, value: number, step: number): HTMLElement => {
        const input = numberField({ value, step, width: "5.5rem" });
        input.setAttribute("aria-label", name);
        return labeled(name[0]!.toUpperCase() + name.slice(1), input);
    };
    const fill = el("input", { type: "checkbox", "aria-label": "Fill the squares" }) as HTMLInputElement;
    fill.checked = true;
    const material = el("div", { class: "field-grid" },
        field("power from", 100, 10), field("power to", 1000, 10), field("power steps", 5, 1),
        field("speed from", 300, 10), field("speed to", 1500, 10), field("speed steps", 5, 1),
        field("size", 5, 0.5), field("gap", 2, 0.5), field("spot", 0.1, 0.01),
        labeled("Fill", fill, "labeled inline"),
        field("x", 0, 1), field("y", 0, 1),
    );
    material.title = "Power rises left to right, speed bottom to top; a filled square is an engraving test, an outline a cut-through test";
    const depth = el("div", { class: "field-grid" },
        field("depth from", 0.05, 0.01), field("depth to", 0.3, 0.01), field("depth steps", 6, 1),
        field("length", 10, 1), field("gap", 2, 0.5), field("feed", 120, 10), field("plunge", 30, 5), field("spindle", 1000, 100),
        field("x", 0, 1), field("y", 0, 1),
    );
    depth.title = "A slot per depth, shallowest first, each its own group at that depth";
    const intro = el("p", { class: "muted" });
    const output = el("div", { class: "center-test-output" });
    const panel = el("details", { class: "center-test calibrate-test" },
        el("summary", {}, "Calibration test"),
        intro,
        material,
        depth,
        button("Make test job", () => make(), "btn"),
        output,
    );

    let kind: "material" | "depth" = "material";
    const follow = (state: AppState): void => {
        const tool = profileOf(state.snapshot).tool;
        kind = tool === "spindle" ? "depth" : "material";
        panel.classList.toggle("hidden", tool === "dispenser");
        material.classList.toggle("hidden", kind !== "material");
        depth.classList.toggle("hidden", kind !== "depth");
        intro.textContent = kind === "material"
            ? "A grid of squares, each its own group at a power and a speed, to find the settings for a material. On a machine with no focus axis it is the focus and power test too: one speed and a ladder of powers."
            : "A row of slots, each its own group a step deeper, to find the depth that parts the copper and check the depth axis's scale.";
    };
    ctx.store.subscribe(follow, ["snapshot"]);
    follow(ctx.store.get());

    async function make(): Promise<void> {
        // The fields of the test shown: the two sets share some names.
        const shown = kind === "material" ? material : depth;
        const fields: CalibrateFields = { kind, fill: fill.checked ? "1" : "0" };
        for (const input of shown.querySelectorAll("input[type=number]")) {
            const name = input.getAttribute("aria-label");
            if (name) {
                fields[name] = (input as HTMLInputElement).value;
            }
        }
        const request = calibrateRequest(fields);
        if (typeof request === "string") {
            ctx.toast("error", request);
            return;
        }
        const result = await ctx.call(ctx.api.calibrateJob(request));
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

    return panel;
}
