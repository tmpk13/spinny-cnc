// A job's own icon in the job list, shown in place of its drawing: a press
// on the drawing opens a picker under the job's row with the glyphs, the
// colors and a field for one or two letters; Drawing gives the drawing
// back. The icon is kept with the job on the backend (PATCH
// /api/jobs/{id} with `icon`), which takes it while the job runs.

import { button, el, replace, setLocked } from "../dom.ts";
import { ICON_COLORS, ICON_GLYPHS, ICON_LETTERS, iconProblem } from "../icons.ts";
import type { JobIcon, JobSummary } from "../types.ts";
import type { Ctx } from "./context.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

function svg(tag: string, attrs: Record<string, string>): SVGElement {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) {
        node.setAttribute(name, value);
    }
    return node;
}

/** The icon drawn: its glyph or letters on its color; null for one the page cannot draw (a name it does not know), which leaves the drawing. */
export function iconSvg(icon: JobIcon): SVGSVGElement | null {
    if (iconProblem(icon) !== null) {
        return null;
    }
    const root = svg("svg", { class: "job-icon", viewBox: "0 0 16 16", role: "img", "aria-label": icon.glyph ? `icon: ${icon.glyph}` : `icon: ${icon.letters}` }) as SVGSVGElement;
    root.style.setProperty("--job-icon", `var(--${icon.color})`);
    root.append(svg("rect", { class: "job-icon-bg", width: "16", height: "16", rx: "3" }));
    if (icon.glyph) {
        root.append(svg("path", { class: "job-icon-fg", d: ICON_GLYPHS[icon.glyph]!, "fill-rule": "evenodd", transform: "translate(2.4 2.4) scale(0.7)" }));
    } else {
        const text = svg("text", { class: "job-icon-fg job-icon-letters", x: "8", y: "8.6", "font-size": [...icon.letters!].length > 1 ? "7" : "9.5" });
        text.textContent = icon.letters!;
        root.append(text);
    }
    return root;
}

/** What a job's row shows for it: its icon, or its drawing. */
export function jobPicture(job: JobSummary, drawingUrl: string): Element {
    return (job.icon ? iconSvg(job.icon) : null) ?? el("img", { class: "job-thumb", src: drawingUrl, alt: "", loading: "lazy", decoding: "async" });
}

/** The icon's color the picker starts on: the job's, else blue. */
export function startColor(icon: JobIcon | null | undefined): string {
    return icon && (ICON_COLORS as readonly string[]).includes(icon.color) ? icon.color : "blue";
}

/**
 * The picker for one job's icon: a press on a glyph, or Letters, keeps it
 * at once in the color picked; a color picked recolors an icon kept;
 * Drawing takes the icon away. `close` shuts the picker.
 */
export function iconPicker(job: JobSummary, ctx: Ctx, close: () => void): HTMLElement {
    let color = startColor(job.icon);
    const glyphs = el("div", { class: "button-row job-icon-glyphs", role: "group", "aria-label": "Glyphs" });
    const colors = el("div", { class: "button-row job-icon-colors", role: "group", "aria-label": "Colors" });
    const letters = el("input", { type: "text", class: "field job-icon-letters-field", maxlength: String(ICON_LETTERS), placeholder: "AB", "aria-label": "Icon letters", spellcheck: "false", autocomplete: "off" }) as HTMLInputElement;
    letters.value = job.icon?.letters ?? "";
    const useLetters = button("Letters", () => keep({ letters: letters.value.trim(), color }), "btn btn-small");
    useLetters.title = "show these letters";
    const drawing = button("Drawing", () => keep(null), "btn btn-quiet btn-small");
    drawing.title = "show the job's drawing again";
    const shut = button("Close", () => close(), "btn btn-quiet btn-small", "close the icon picker");
    const root = el("div", { class: "stack job-icon-picker", role: "group", "aria-label": `Icon of ${job.name}` },
        glyphs, colors, el("div", { class: "button-row" }, letters, useLetters, drawing, shut));

    function draw(): void {
        const current = job.icon ?? null;
        replace(glyphs, ...Object.keys(ICON_GLYPHS).map((glyph) => {
            const press = button("", () => keep({ glyph, color }), "btn btn-quiet job-icon-choice");
            press.title = glyph;
            press.setAttribute("aria-label", glyph);
            press.setAttribute("aria-pressed", String(current?.glyph === glyph));
            const drawn = iconSvg({ glyph, color });
            if (drawn) {
                press.append(drawn);
            }
            return press;
        }));
        replace(colors, ...ICON_COLORS.map((name) => {
            const press = button("", () => recolor(name), "btn job-icon-swatch");
            press.title = name;
            press.setAttribute("aria-label", name);
            press.setAttribute("aria-pressed", String(name === color));
            press.style.setProperty("--job-icon", `var(--${name})`);
            return press;
        }));
        setLocked(drawing, current === null, "the job shows its drawing");
    }

    async function keep(icon: JobIcon | null): Promise<void> {
        const problem = iconProblem(icon);
        if (problem !== null) {
            ctx.toast("error", icon?.letters !== undefined ? `letters: 1 to ${ICON_LETTERS} letters or digits` : problem);
            return;
        }
        const kept = await ctx.call(ctx.api.patchJob(job.id, { icon }).then(() => true));
        if (!kept) {
            return;
        }
        job = { ...job, icon };
        draw();
        await ctx.refreshJobs();
        // The job shown in full carries its icon too, for its JSON.
        if (ctx.store.get().job?.id === job.id) {
            await ctx.reloadJob(job.id);
        }
    }

    async function recolor(name: string): Promise<void> {
        color = name;
        draw();
        const current = job.icon ?? null;
        if (current !== null && current.color !== name) {
            await keep({ ...current, color: name });
        }
    }

    letters.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            void keep({ letters: letters.value.trim(), color });
        }
    });
    root.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            event.preventDefault();
            close();
        }
    });
    draw();
    return root;
}
