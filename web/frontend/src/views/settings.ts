// Firmware settings table with inline edits, apply, save to flash, and the
// host chord tolerance.

import { button, el, labeled, numberField, replace } from "../dom.ts";
import { parseNumber } from "../format.ts";
import type { SettingsResponse } from "../types.ts";
import type { Ctx } from "./context.ts";

/** The values that differ from what the backend reported. */
export function changedValues(settings: SettingsResponse, edits: Record<string, number>): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [name, value] of Object.entries(edits)) {
        if (settings.values[name] !== value) {
            out[name] = value;
        }
    }
    return out;
}

export function mountSettings(root: HTMLElement, ctx: Ctx): void {
    const tolerance = numberField({ value: 0.005, min: 0.0001, step: 0.001, width: "6rem" });
    const apply = button("Apply", () => applyEdits(), "btn btn-primary");
    const save = button("Save to flash", () => saveFlash(), "btn");
    const reload = button("Reload", () => ctx.refreshSettings(), "btn btn-quiet");
    const table = el("table", { class: "settings" });
    const body = el("fieldset", { class: "panel-body" },
        el("div", { class: "button-row" }, labeled("Chord tolerance mm", tolerance, "labeled inline"), apply, save, reload),
        table,
    );
    root.append(el("h2", {}, "Settings"), body);

    let edits: Record<string, number> = {};
    let shown: SettingsResponse | null = null;

    ctx.store.subscribe((state) => {
        if (state.settings !== shown) {
            shown = state.settings;
            edits = {};
            render(state.settings);
        }
    }, ["settings"]);

    function render(settings: SettingsResponse | null): void {
        if (!settings) {
            replace(table, el("tbody", {}, el("tr", {}, el("td", { class: "muted" }, "no settings loaded"))));
            return;
        }
        tolerance.value = String(settings.host.tolerance);
        const names = settings.schema.length > 0 ? settings.schema : Object.keys(settings.values).map((name) => ({ name, unit: "", help: "" }));
        const rows = names.map((entry) => {
            const current = settings.values[entry.name];
            const input = numberField({ value: current ?? null, width: "6.5rem" });
            input.setAttribute("aria-label", entry.name);
            const row = el("tr", {},
                el("td", { class: "mono" }, entry.name),
                el("td", {}, input),
                el("td", { class: "muted" }, entry.unit),
                el("td", { class: "muted help" }, entry.help),
            );
            input.addEventListener("input", () => {
                const value = parseNumber(input.value);
                if (value === null || value === current) {
                    delete edits[entry.name];
                } else {
                    edits[entry.name] = value;
                }
                row.classList.toggle("edited", entry.name in edits);
            });
            return row;
        });
        replace(table,
            el("thead", {}, el("tr", {}, el("th", {}, "Name"), el("th", {}, "Value"), el("th", {}, "Unit"), el("th", {}, "Help"))),
            el("tbody", {}, ...rows),
        );
    }

    async function applyEdits(): Promise<void> {
        const settings = ctx.store.get().settings;
        if (!settings) {
            return;
        }
        const values = changedValues(settings, edits);
        const hostTolerance = parseNumber(tolerance.value);
        const patch: { values?: Record<string, number>; host?: { tolerance: number } } = {};
        if (Object.keys(values).length > 0) {
            patch.values = values;
        }
        if (hostTolerance !== null && hostTolerance > 0 && hostTolerance !== settings.host.tolerance) {
            patch.host = { tolerance: hostTolerance };
        }
        if (!patch.values && !patch.host) {
            ctx.toast("info", "nothing changed");
            return;
        }
        const done = await ctx.call(ctx.api.updateSettings(patch).then(() => true));
        if (done) {
            ctx.toast("info", "settings applied");
        }
        // Refreshed either way: a refused write may still have changed
        // the values before the one refused, and the table must say so.
        await ctx.refreshSettings();
    }

    async function saveFlash(): Promise<void> {
        const done = await ctx.call(ctx.api.saveSettings().then(() => true));
        if (done) {
            ctx.toast("info", "settings saved to flash");
        }
    }
}
