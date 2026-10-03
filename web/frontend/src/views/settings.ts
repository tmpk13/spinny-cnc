// Firmware settings table with inline edits, apply, save to flash, and the
// host chord tolerance; on a spindle machine also the host's milling travel
// clearance and spin-up.

import { askConfirm } from "../confirm.ts";
import { button, el, labeled, numberField, replace, setLocked } from "../dom.ts";
import { parseNumber } from "../format.ts";
import { isMilling } from "../profile.ts";
import type { AppState } from "../state.ts";
import type { HostSettings, MachineSummary, SettingsResponse } from "../types.ts";
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

// Whether the panel is folded is a per-browser convenience; storage that is
// blocked or empty leaves the panel open.
const FOLD_KEY = "spinny.settings.open";

function readFoldOpen(): boolean {
    try {
        return globalThis.localStorage?.getItem(FOLD_KEY) !== "0";
    } catch {
        return true;
    }
}

function writeFoldOpen(open: boolean): void {
    try {
        globalThis.localStorage?.setItem(FOLD_KEY, open ? "1" : "0");
    } catch {
        // Not remembered; the panel still folds.
    }
}

/** The machine select's value for settings that are no file's. */
export const NO_MACHINE_FILE = "";

export function mountSettings(root: HTMLElement, ctx: Ctx): void {
    const machinePick = el("select", { class: "field machine-pick", "aria-label": "Machine" });
    const load = button("Load", () => loadMachine(), "btn");
    const machineNote = el("span", { class: "muted machine-note" });
    const tolerance = numberField({ value: 0.005, min: 0.0001, step: 0.001, width: "6rem" });
    const clearance = numberField({ value: 2, min: 0.1, step: 0.5, width: "6rem" });
    const spinup = numberField({ value: 2, min: 0, step: 0.5, width: "6rem" });
    const milling = el("div", { class: "button-row hidden" },
        labeled("Travel clearance mm", clearance, "labeled inline"),
        labeled("Spin-up s", spinup, "labeled inline"),
    );
    const apply = button("Apply", () => applyEdits(), "btn btn-primary");
    const save = button("Save to flash", () => saveFlash(), "btn");
    const reload = button("Reload", () => Promise.all([ctx.refreshSettings(), refreshMachines()]), "btn btn-quiet");
    const table = el("table", { class: "settings" });
    const body = el("fieldset", { class: "panel-body" },
        el("div", { class: "button-row" }, labeled("Machine", machinePick, "labeled inline"), load, machineNote),
        el("div", { class: "button-row" }, labeled("Chord tolerance mm", tolerance, "labeled inline"), apply, save, reload),
        milling,
        table,
    );
    const fold = el("details", { class: "panel-fold", open: readFoldOpen() },
        el("summary", { class: "panel-head" }, el("h2", {}, "Settings")),
        body,
    );
    fold.addEventListener("toggle", () => writeFoldOpen(fold.open));
    root.append(fold);

    let edits: Record<string, number> = {};
    let shown: SettingsResponse | null = null;
    // The machine the edits were typed for: connected to another one (or to
    // none), what was typed is not carried over to it.
    let editsFor: string | null = null;
    // The host values the fields were last filled with, to tell a field the
    // operator has typed in from one still showing the backend's value.
    let hostShown: { tolerance: string; clearance: string; spinup: string } | null = null;

    const machineOf = (state: AppState): string | null => (state.snapshot.connected ? state.snapshot.url ?? "" : null);

    // The machine files, and the one the operator picked to load, kept
    // until it is loaded or the settings come from another machine.
    let files: MachineSummary[] = [];
    let picked: string | null = null;
    machinePick.addEventListener("change", () => {
        picked = machinePick.value;
        showMachine();
    });

    ctx.store.subscribe((state) => {
        milling.classList.toggle("hidden", !isMilling(state.snapshot));
        showMachine();
        const machine = machineOf(state);
        if (machine !== editsFor) {
            editsFor = machine;
            if (Object.keys(edits).length > 0 || hostShown !== null) {
                edits = {};
                hostShown = null;
                render(shown);
            }
        }
    }, ["snapshot"]);

    ctx.store.subscribe((state) => {
        if (state.settings !== shown) {
            shown = state.settings;
            render(state.settings);
            renderMachines();
        }
    }, ["settings"]);
    void refreshMachines();

    async function refreshMachines(): Promise<void> {
        const listed = await ctx.call(ctx.api.machines());
        if (!listed) {
            return;
        }
        files = listed.machines;
        for (const problem of listed.problems) {
            ctx.toast("error", problem);
        }
        renderMachines();
    }

    /** The select: the files by name, and first the entry for settings that are no file's. */
    function renderMachines(): void {
        const current = shown?.machine ?? null;
        const want = picked ?? current ?? NO_MACHINE_FILE;
        replace(machinePick,
            el("option", { value: NO_MACHINE_FILE, disabled: true }, "settings of no file"),
            ...files.map((file) => el("option", { value: file.id }, file.name)),
        );
        machinePick.value = files.some((file) => file.id === want) ? want : NO_MACHINE_FILE;
        showMachine();
    }

    /** The note beside the select, and whether Load has anything to do. */
    function showMachine(): void {
        const connected = ctx.store.get().snapshot.connected;
        const current = shown?.machine ?? null;
        const file = files.find((entry) => entry.id === machinePick.value);
        if (!connected) {
            machineNote.textContent = files.length > 0 ? "connect to load one" : "no machine files";
        } else if (file && file.id === current) {
            machineNote.textContent = "loaded";
        } else if (file) {
            machineNote.textContent = file.description;
        } else {
            machineNote.textContent = "the settings are no file's";
        }
        setLocked(load, !connected || !file || file.id === current);
    }

    async function loadMachine(): Promise<void> {
        const file = files.find((entry) => entry.id === machinePick.value);
        if (!file) {
            return;
        }
        const ok = await askConfirm(
            `Load ${file.name}? Every firmware setting is written from its file; the ones changed by hand are lost. Save to flash afterwards keeps it over a restart.`,
            "Load",
        );
        if (!ok) {
            return;
        }
        const done = await ctx.call(ctx.api.applyMachine(file.id, false));
        if (done) {
            picked = null;
            ctx.toast("info", `${file.name} loaded; Save to flash keeps it over a restart`);
        }
        // Refreshed either way: a refused write may still have changed
        // the values before the one refused.
        await ctx.refreshSettings();
    }

    /**
     * Builds the table from `settings`. A refresh (another panel writing a
     * setting, the event feed coming back) keeps what the operator typed and
     * has not applied, as long as it still differs from the machine's value.
     */
    function render(settings: SettingsResponse | null): void {
        if (!settings) {
            edits = {};
            hostShown = null;
            replace(table, el("tbody", {}, el("tr", {}, el("td", { class: "muted" }, "no settings loaded"))));
            return;
        }
        const focused = document.activeElement;
        const host = {
            tolerance: String(settings.host.tolerance),
            clearance: String(settings.host.clearance ?? 2),
            spinup: String(settings.host.spinup ?? 2),
        };
        const follow = (field: HTMLInputElement, key: keyof typeof host): void => {
            const untouched = hostShown === null || field.value === hostShown[key];
            if (untouched && field !== focused) {
                field.value = host[key];
            }
        };
        follow(tolerance, "tolerance");
        follow(clearance, "clearance");
        follow(spinup, "spinup");
        hostShown = host;
        // The field being typed in keeps its text as it is, parsed or not.
        const typing = focused instanceof HTMLInputElement && table.contains(focused)
            ? { name: focused.getAttribute("aria-label"), text: focused.value }
            : null;
        const kept: Record<string, number> = {};
        for (const [name, edit] of Object.entries(edits)) {
            if (name in settings.values && edit !== settings.values[name]) {
                kept[name] = edit;
            }
        }
        const names = settings.schema.length > 0 ? settings.schema : Object.keys(settings.values).map((name) => ({ name, unit: "", help: "" }));
        const inputs = new Map<string, HTMLInputElement>();
        const rows = names.map((entry) => {
            const current = settings.values[entry.name];
            const input = numberField({ value: entry.name in kept ? kept[entry.name] : current ?? null, width: "6.5rem" });
            input.setAttribute("aria-label", entry.name);
            inputs.set(entry.name, input);
            const row = el("tr", { class: entry.name in kept ? "edited" : "" },
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
        edits = kept;
        replace(table,
            el("thead", {}, el("tr", {}, el("th", {}, "Name"), el("th", {}, "Value"), el("th", {}, "Unit"), el("th", {}, "Help"))),
            el("tbody", {}, ...rows),
        );
        const again = typing?.name ? inputs.get(typing.name) : undefined;
        if (typing && again) {
            again.value = typing.text;
            again.focus();
        }
    }

    async function applyEdits(): Promise<void> {
        const settings = ctx.store.get().settings;
        if (!settings) {
            return;
        }
        const values = changedValues(settings, edits);
        const hostTolerance = parseNumber(tolerance.value);
        if (hostTolerance !== null && hostTolerance <= 0) {
            ctx.toast("error", "the chord tolerance must be above 0");
            return;
        }
        const hostClearance = parseNumber(clearance.value);
        const hostSpinup = parseNumber(spinup.value);
        if (hostClearance !== null && hostClearance <= 0) {
            ctx.toast("error", "the travel clearance must be above 0");
            return;
        }
        if (hostSpinup !== null && hostSpinup < 0) {
            ctx.toast("error", "the spin-up cannot be negative");
            return;
        }
        const patch: { values?: Record<string, number>; host?: HostSettings } = {};
        if (Object.keys(values).length > 0) {
            patch.values = values;
        }
        const host: HostSettings = { tolerance: settings.host.tolerance };
        let hostChanged = false;
        if (hostTolerance !== null && hostTolerance > 0 && hostTolerance !== settings.host.tolerance) {
            host.tolerance = hostTolerance;
            hostChanged = true;
        }
        if (hostClearance !== null && hostClearance !== settings.host.clearance) {
            host.clearance = hostClearance;
            hostChanged = true;
        }
        if (hostSpinup !== null && hostSpinup !== settings.host.spinup) {
            host.spinup = hostSpinup;
            hostChanged = true;
        }
        if (hostChanged) {
            patch.host = host;
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
