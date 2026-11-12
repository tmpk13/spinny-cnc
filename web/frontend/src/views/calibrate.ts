// The calibration tests, made into a job: a laser's material test (a grid
// of squares at a power and a speed each), its focus ladder (a row of lines
// a step over focus each, with a focus axis), a mill's depth test (a row
// of slots a step deeper each), and the camera pattern for either (a grid
// of dots a known pitch apart, for a camera's lens, also offered as a sheet
// to print). The ones for the machine show; a dispenser has none.

import { button, downloadText, el, labeled, numberField } from "../dom.ts";
import { parseNumber } from "../format.ts";
import { profileOf } from "../profile.ts";
import type { AppState } from "../state.ts";
import type { CalibrateRequest } from "../types.ts";
import { showMade } from "./center.ts";
import type { Ctx } from "./context.ts";

/** The raw text of each field; a blank one is left for the backend to default. */
export type CalibrateFields = Record<string, string> & { kind: "material" | "depth" | "focus" | "dots"; fill: string };

/** The ladders of each test, as the request names them and the fields do. */
const LADDERS: Record<CalibrateFields["kind"], [keyof CalibrateRequest, string][]> = {
    material: [["powers", "power"], ["speeds", "speed"]],
    depth: [["depths", "depth"]],
    focus: [["focuses", "focus"]],
    dots: [],
};
/** The single numbers of each test. */
const SINGLES: Record<CalibrateFields["kind"], string[]> = {
    material: ["size", "gap", "spot", "x", "y"],
    depth: ["length", "gap", "feed", "plunge", "spindle", "x", "y"],
    focus: ["power", "speed", "length", "gap", "x", "y"],
    // A laser's dots or a mill's: only the fields shown are given.
    dots: ["columns", "rows", "pitch", "diameter", "spot", "power", "speed", "depth", "feed", "plunge", "spindle", "x", "y"],
};
/** The fields that count dots, which take whole numbers. */
const WHOLE = ["columns", "rows"];

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
    for (const [key, name] of LADDERS[fields.kind]) {
        const parts = [read(`${name} from`), read(`${name} to`), read(`${name} steps`)];
        const wrong = parts.find((part) => typeof part === "string");
        if (wrong !== undefined) {
            return wrong as string;
        }
        if (parts.every((part) => part === null)) {
            continue;
        }
        if (parts.some((part) => part === null)) {
            return `${name} ladder: fill in from, to and steps, or none`;
        }
        if (!Number.isInteger(parts[2])) {
            return `${name} steps must be a whole number`;
        }
        (out as Record<string, unknown>)[key] = parts as [number, number, number];
    }
    for (const name of SINGLES[fields.kind]) {
        const value = read(name);
        if (typeof value === "string") {
            return value;
        }
        if (value !== null && WHOLE.includes(name) && !Number.isInteger(value)) {
            return `${name} must be a whole number`;
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
    material.title = "Power rises to the right, speed upward; filled squares engrave, outlines cut through";
    const depth = el("div", { class: "field-grid" },
        field("depth from", 0.05, 0.01), field("depth to", 0.3, 0.01), field("depth steps", 6, 1),
        field("length", 10, 1), field("gap", 2, 0.5), field("feed", 120, 10), field("plunge", 30, 5), field("spindle", 1000, 100),
        field("x", 0, 1), field("y", 0, 1),
    );
    depth.title = "One slot per depth, shallowest first";
    const focus = el("div", { class: "field-grid" },
        field("focus from", -1, 0.1), field("focus to", 1, 0.1), field("focus steps", 9, 1),
        field("power", 500, 10), field("speed", 600, 10), field("length", 10, 1), field("gap", 2, 0.5),
        field("x", 0, 1), field("y", 0, 1),
    );
    focus.title = "One line per step, lowest first. Negative steps are below focus";
    const dotsLaser = el("div", { class: "field-grid" },
        field("columns", 21, 1), field("rows", 15, 1), field("pitch", 2, 0.1), field("diameter", 0.6, 0.05),
        field("power", 500, 10), field("speed", 600, 10), field("spot", 0.1, 0.01),
        field("x", 0, 1), field("y", 0, 1),
    );
    dotsLaser.title = "Dots a pitch apart, each filled a spot apart; the top right one is left out to show which way the pattern lies";
    const dotsMill = el("div", { class: "field-grid" },
        field("columns", 21, 1), field("rows", 15, 1), field("pitch", 2, 0.1), field("depth", 0.1, 0.01),
        field("feed", 120, 10), field("plunge", 30, 5), field("spindle", 1000, 100),
        field("x", 0, 1), field("y", 0, 1),
    );
    dotsMill.title = "One plunge a dot, as wide as the tool; the top right one is left out to show which way the pattern lies";
    // The tests the machine takes: a laser's material test (the focus test
    // too without a focus axis) and, with one, its focus ladder; a mill's
    // depth test; and either's camera pattern.
    const which = el("select", { class: "field", "aria-label": "Test" }) as HTMLSelectElement;
    const whichLabel = labeled("Test", which);
    const intro = el("p", { class: "muted" });
    const output = el("div", { class: "center-test-output" });
    const makeButton = button("Make test job", () => make(), "btn");
    makeButton.title = "Make the test shown as a job";
    const panel = el("details", { class: "center-test calibrate-test" },
        el("summary", { title: "fold or unfold",}, "Calibration test"),
        whichLabel,
        intro,
        material,
        focus,
        depth,
        dotsLaser,
        dotsMill,
        makeButton,
        output,
    );

    let kind: CalibrateFields["kind"] = "material";
    let milling = false;
    let offered = "";
    const follow = (state: AppState): void => {
        const profile = profileOf(state.snapshot);
        const tool = profile.tool;
        milling = tool === "spindle";
        const ladder = tool === "laser" && profile.h_axis;
        const tests: [CalibrateFields["kind"], string][] = milling
            ? [["depth", "depth test"], ["dots", "camera pattern"]]
            : [["material", "material test"], ...(ladder ? [["focus", "focus ladder"] as [CalibrateFields["kind"], string]] : []), ["dots", "camera pattern"]];
        const names = tests.map(([value]) => value).join(" ");
        if (names !== offered) {
            const was = which.value;
            which.replaceChildren(...tests.map(([value, label]) => el("option", { value }, label)));
            which.value = tests.some(([value]) => value === was) ? was : tests[0]![0];
            offered = names;
        }
        kind = which.value as CalibrateFields["kind"];
        panel.classList.toggle("hidden", tool === "dispenser");
        material.classList.toggle("hidden", kind !== "material");
        focus.classList.toggle("hidden", kind !== "focus");
        depth.classList.toggle("hidden", kind !== "depth");
        dotsLaser.classList.toggle("hidden", kind !== "dots" || milling);
        dotsMill.classList.toggle("hidden", kind !== "dots" || !milling);
        intro.textContent = kind === "material"
            ? ladder
                ? "Squares at a range of powers and speeds, to find a material's settings."
                : "Squares at a range of powers and speeds, to find a material's settings. With one speed and a power ladder it also tests focus."
            : kind === "focus"
                ? "Lines burnt at steps above and below focus: the thinnest is at focus. Steps count from the start height, or the map's focus height when following a map."
                : kind === "dots"
                    ? milling
                        ? "A grid of dots a known pitch apart for measuring a camera's lens, one plunge each; or print it from its SVG."
                        : "A grid of dots a known pitch apart for measuring a camera's lens: a light mark on anodized aluminum from an IR or diode laser; or print it from its SVG."
                    : "Slots a step deeper each, to find the depth that cuts through the copper and check the depth axis scale.";
    };
    which.addEventListener("change", () => follow(ctx.store.get()));
    ctx.store.subscribe(follow, ["snapshot"]);
    follow(ctx.store.get());

    async function make(): Promise<void> {
        // The fields of the test shown: the sets share some names.
        const shown = kind === "material" ? material : kind === "focus" ? focus : kind === "dots" ? (milling ? dotsMill : dotsLaser) : depth;
        const fields: CalibrateFields = { kind, fill: fill.checked ? "1" : "0" };
        for (const input of shown.querySelectorAll("input.num")) {
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
        if (result) {
            await showMade(ctx, output, result);
            const svg = result.svg;
            if (svg) {
                const save = button("Save SVG", () => {
                    if (!downloadText("camera-pattern.svg", svg, "image/svg+xml")) {
                        ctx.toast("error", "this browser cannot save a file from the page");
                    }
                }, "btn btn-quiet");
                save.title = "The pattern at true size as a file, to print at 100%";
                output.append(el("div", { class: "button-row" }, save));
            }
        }
    }

    return panel;
}
