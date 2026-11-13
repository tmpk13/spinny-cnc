import { describe, expect, test } from "bun:test";

import { MockBackend } from "../src/mock/backend.ts";
import { ICON_COLORS, ICON_GLYPHS, iconProblem } from "../src/icons.ts";
import { iconSvg, startColor } from "../src/views/jobicon.ts";
import { mountJobs } from "../src/views/jobs.ts";
import { settle, setup } from "./harness.ts";

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="40mm" viewBox="0 0 40 40"><path d="M0 0 L10 0" stroke="#f00"/></svg>`;

async function settleMany(times = 6): Promise<void> {
    for (let i = 0; i < times; i++) {
        await settle();
    }
}

describe("a job's icon", () => {
    test("is a known glyph or one or two letters, on an accent", () => {
        expect(Object.keys(ICON_GLYPHS).length).toBe(12);
        expect(iconProblem(null)).toBeNull();
        expect(iconProblem({ glyph: "star", color: "blue" })).toBeNull();
        expect(iconProblem({ letters: "J5", color: "cyan" })).toBeNull();
        expect(iconProblem({ glyph: "nope", color: "blue" })).toContain("glyph must be one of");
        expect(iconProblem({ glyph: "star", letters: "A", color: "blue" })).toContain("one of the two");
        expect(iconProblem({ letters: "ABC", color: "blue" })).toContain("1 to 2 letters or digits");
        expect(iconProblem({ letters: "A!", color: "blue" })).toContain("1 to 2 letters or digits");
        expect(iconProblem({ glyph: "star", color: "pink" })).toContain(`one of ${ICON_COLORS.join(", ")}`);
        expect(startColor({ glyph: "star", color: "red" })).toBe("red");
        expect(startColor(null)).toBe("blue");
    });

    test("draws its glyph or its letters on its color, and nothing for a glyph the page does not know", () => {
        const glyph = iconSvg({ glyph: "gear", color: "violet" })!;
        expect(glyph.querySelector("path")?.getAttribute("d")).toBe(ICON_GLYPHS["gear"]!);
        expect(glyph.style.getPropertyValue("--job-icon")).toBe("var(--violet)");
        const letters = iconSvg({ letters: "R2", color: "green" })!;
        expect(letters.querySelector("text")?.textContent).toBe("R2");
        expect(iconSvg({ glyph: "unknown", color: "green" })).toBeNull();
    });

    test("is kept by the mock, also while the job runs, and kept through a width and a whole job put back", async () => {
        const backend = new MockBackend({ timers: false });
        const job = await backend.uploadJob(new File([SVG], "lid.svg"), { anchor: "keep" });
        await backend.patchJob(job.id, { icon: { glyph: "star", color: "magenta" } });
        expect((await backend.jobs()).find((entry) => entry.id === job.id)!.icon).toEqual({ glyph: "star", color: "magenta" });
        await expect(backend.patchJob(job.id, { icon: { glyph: "nope", color: "blue" } })).rejects.toMatchObject({ status: 400 });
        const widened = await backend.setJobWidth(job.id, 0.3);
        expect(widened.icon).toEqual({ glyph: "star", color: "magenta" });
        const whole = await backend.job(job.id);
        const { icon: _icon, ...without } = whole;
        expect((await backend.replaceJob(job.id, without as typeof whole)).icon).toEqual({ glyph: "star", color: "magenta" });
        expect((await backend.replaceJob(job.id, { ...whole, icon: null })).icon).toBeNull();
        // While it runs, the icon alone is taken.
        await backend.connect("/dev/ttyACM0");
        await backend.runJob(job.id);
        await backend.patchJob(job.id, { icon: { letters: "A", color: "red" } });
        await expect(backend.patchJob(job.id, { icon: null, name: "other" })).rejects.toMatchObject({ status: 409 });
        await backend.patchJob(job.id, { icon: null });
        expect((await backend.job(job.id)).icon).toBeNull();
    });
});

describe("the job list's icons", () => {
    test("a press on the drawing opens the picker; a glyph, a color and letters are kept at once, and Drawing gives the drawing back", async () => {
        const { ctx, root, api, calls } = setup();
        mountJobs(root, ctx, root);
        const job = await api.uploadJob(new File([SVG], "lid.svg"), { anchor: "keep" });
        await ctx.refreshJobs();
        const thumb = (): HTMLButtonElement => root.querySelector(`button[aria-label="Icon of ${job.name}"]`) as HTMLButtonElement;
        expect(thumb().querySelector("img.job-thumb")).not.toBeNull();
        expect(thumb().title).not.toBe("");
        thumb().click();
        await settle();
        const picker = (): HTMLElement | null => root.querySelector(".job-icon-picker");
        expect(picker()).not.toBeNull();
        expect(thumb().getAttribute("aria-expanded")).toBe("true");
        // Open, it is a pop-up: the pointer elsewhere says a press only shuts it.
        expect(document.documentElement.hasAttribute("data-dismiss")).toBe(true);
        expect(picker()!.querySelectorAll(".job-icon-choice").length).toBe(12);
        expect(picker()!.querySelectorAll(".job-icon-swatch").length).toBe(8);
        // The color first, then the glyph.
        (picker()!.querySelector('button[aria-label="green"]') as HTMLButtonElement).click();
        (picker()!.querySelector('button[aria-label="flag"]') as HTMLButtonElement).click();
        await settleMany();
        expect(calls.filter((call) => call.name === "patchJob").map((call) => call.args[1])).toEqual([{ icon: { glyph: "flag", color: "green" } }]);
        expect(thumb().querySelector("svg.job-icon path")?.getAttribute("d")).toBe(ICON_GLYPHS["flag"]!);
        // A color picked now recolors the icon kept.
        (picker()!.querySelector('button[aria-label="red"]') as HTMLButtonElement).click();
        await settleMany();
        expect((await api.jobs()).find((entry) => entry.id === job.id)!.icon).toEqual({ glyph: "flag", color: "red" });
        // Letters, then the drawing again.
        const letters = picker()!.querySelector('input[aria-label="Icon letters"]') as HTMLInputElement;
        letters.value = "B7";
        letters.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
        await settleMany();
        expect(thumb().querySelector("svg.job-icon text")?.textContent).toBe("B7");
        (Array.from(picker()!.querySelectorAll("button")).find((b) => b.textContent === "Drawing") as HTMLButtonElement).click();
        await settleMany();
        expect(thumb().querySelector("img.job-thumb")).not.toBeNull();
        // A press elsewhere shuts it, the rows left standing.
        const row = thumb().closest("li");
        document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
        expect(picker()).toBeNull();
        expect(thumb().closest("li")).toBe(row);
        expect(thumb().getAttribute("aria-expanded")).toBe("false");
        expect(document.documentElement.hasAttribute("data-dismiss")).toBe(false);
        root.remove();
    });
});
