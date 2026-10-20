// Firmware settings table with inline edits, apply, save to flash, and the
// host chord tolerance; on a spindle machine also the host's milling travel
// clearance and spin-up, on a dispenser the travel clearance and what a dot
// of paste is made of. On the Config page, beside the machine file that is
// the other way to set every one of them.

import { button, el, labeled, numberField, replace } from "../dom.ts";
import { parseNumber } from "../format.ts";
import { isDispensing, isMilling } from "../profile.ts";
import type { AppState } from "../state.ts";
import type { HostSettings, SettingsResponse } from "../types.ts";
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

/** The host's numbers the panel has a field for. */
type HostField = "tolerance" | "clearance" | "spinup" | DispensingKey;
type DispensingKey = "gap" | "retract" | "output" | "extrude_rate" | "dwell_ms";

export function mountSettings(root: HTMLElement, ctx: Ctx): void {
    const tolerance = numberField({ value: 0.005, min: 0.0001, step: 0.001, width: "6rem" });
    const clearance = numberField({ value: 2, min: 0.1, step: 0.5, width: "6rem" });
    const spinup = numberField({ value: 2, min: 0, step: 0.5, width: "6rem" });
    // Off, every spindle line asks for s_max: a spindle with its own speed
    // knob, or one behind a switch, runs full on and never at a group's rpm.
    const speedControl = el("input", { type: "checkbox", "aria-label": "Spindle speed from the groups" }) as HTMLInputElement;
    speedControl.checked = true;
    const milling = el("div", { class: "button-row hidden" },
        labeled("Travel clearance mm", clearance, "labeled inline"),
        labeled("Spin-up s", spinup, "labeled inline"),
        el("label", { class: "muted", title: "Off, the spindle runs full on (S = s_max) whenever a run or the button starts it, whatever a group's speed says" },
            speedControl, " speed from the groups"),
    );
    // What a dispensing run makes every dot of; the travel height between
    // dots is the milling clearance, shown again here.
    const dispenseClearance = numberField({ value: 2, min: 0.1, step: 0.5, width: "6rem" });
    const gap = numberField({ value: 0.1, min: 0.01, step: 0.05, width: "6rem" });
    const retract = numberField({ value: 0.2, min: 0, step: 0.05, width: "6rem" });
    const output = numberField({ value: 100, min: 0.01, step: 1, width: "6rem" });
    const extrudeRate = numberField({ value: 60, min: 0.01, step: 10, width: "6rem" });
    const dwellMs = numberField({ value: 200, min: 0, step: 50, width: "6rem" });
    const dispensing = el("div", { class: "button-row hidden" },
        labeled("Travel clearance mm", dispenseClearance, "labeled inline"),
        labeled("Gap mm", gap, "labeled inline"),
        labeled("Retract mm", retract, "labeled inline"),
        labeled("Output mm^3/mm", output, "labeled inline"),
        labeled("Extrude rate mm/min", extrudeRate, "labeled inline"),
        labeled("Dwell ms", dwellMs, "labeled inline"),
    );
    dispensing.title = "Every dot: the head travels the clearance over the surface, the needle stands the gap over the pad, the plunger pushes the pad's area times the paste thickness over the output (plus the last retract) at the extrude rate, waits the dwell, and pulls back the retract";
    const apply = button("Apply", () => applyEdits(), "btn btn-primary");
    const save = button("Save to flash", () => saveFlash(), "btn");
    const reload = button("Reload", () => ctx.refreshSettings(), "btn btn-quiet");
    const table = el("table", { class: "settings" });
    // The buttons stay in view while the long table scrolls under them.
    const actions = el("div", { class: "button-row settings-actions" }, labeled("Chord tolerance mm", tolerance, "labeled inline"), apply, save, reload);
    // On the narrow layout the page scrolls under the status bar, which is
    // stuck to its top; the row is stuck under that, however tall it is
    // (it wraps onto two lines on a phone). The wide layout scrolls each
    // column on its own, below the bar, and the stylesheet puts the row at
    // the top there.
    const bar = document.querySelector<HTMLElement>(".statusbar");
    if (bar && typeof ResizeObserver === "function") {
        const under = new ResizeObserver(() => actions.style.setProperty("--stuck-under", `${bar.offsetHeight}px`));
        under.observe(bar);
    }
    const body = el("fieldset", { class: "panel-body" },
        actions,
        milling,
        dispensing,
        table,
        el("p", { class: "muted hint" }, "the values the controller runs with now; a machine file loaded from the panel beside sets every one of them. laser_pin, probe_pin, tool_pin and the endstop pins are read at boot, and tool_out claims its pin then: Save to flash, then restart the board for those."),
    );
    const fold = el("details", { class: "panel-fold", open: readFoldOpen() },
        el("summary", { class: "panel-head" }, el("h2", {}, "Firmware settings")),
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
    let hostShown: Record<HostField, string> | null = null;

    const machineOf = (state: AppState): string | null => (state.snapshot.connected ? state.snapshot.url ?? "" : null);

    const followMachine = (state: AppState): void => {
        milling.classList.toggle("hidden", !isMilling(state.snapshot));
        dispensing.classList.toggle("hidden", !isDispensing(state.snapshot));
        const machine = machineOf(state);
        if (machine !== editsFor) {
            editsFor = machine;
            if (Object.keys(edits).length > 0 || hostShown !== null) {
                edits = {};
                hostShown = null;
                render(shown);
            }
        }
    };
    ctx.store.subscribe(followMachine, ["snapshot"]);
    // The machine may be known before the panel is: its rows follow it at once.
    followMachine(ctx.store.get());

    ctx.store.subscribe((state) => {
        if (state.settings !== shown) {
            shown = state.settings;
            render(state.settings);
        }
    }, ["settings"]);
    render(shown);

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
        const host: Record<HostField, string> = {
            tolerance: String(settings.host.tolerance),
            clearance: String(settings.host.clearance ?? 2),
            spinup: String(settings.host.spinup ?? 2),
            gap: String(settings.host.gap ?? 0.1),
            retract: String(settings.host.retract ?? 0.2),
            output: String(settings.host.output ?? 100),
            extrude_rate: String(settings.host.extrude_rate ?? 60),
            dwell_ms: String(settings.host.dwell_ms ?? 200),
        };
        const follow = (field: HTMLInputElement, key: HostField): void => {
            const untouched = hostShown === null || field.value === hostShown[key];
            if (untouched && field !== focused) {
                field.value = host[key];
            }
        };
        follow(tolerance, "tolerance");
        follow(clearance, "clearance");
        follow(dispenseClearance, "clearance");
        follow(spinup, "spinup");
        follow(gap, "gap");
        follow(retract, "retract");
        follow(output, "output");
        follow(extrudeRate, "extrude_rate");
        follow(dwellMs, "dwell_ms");
        speedControl.checked = settings.host.speed_control ?? true;
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
        // The clearance has a field in the milling row and one in the
        // dispensing row; the row shown is the one that counts.
        const hostClearance = parseNumber((isDispensing(ctx.store.get().snapshot) ? dispenseClearance : clearance).value);
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
        if (speedControl.checked !== (settings.host.speed_control ?? true)) {
            host.speed_control = speedControl.checked;
            hostChanged = true;
        }
        const dispensingFields: [DispensingKey, HTMLInputElement, (value: number) => string | null][] = [
            ["gap", gap, (value) => (value > 0 && value <= 10 ? null : "the gap must be above 0 and at most 10 mm")],
            ["retract", retract, (value) => (value >= 0 && value <= 50 ? null : "the retract must be 0 to 50 mm")],
            ["output", output, (value) => (value > 0 && value <= 100000 ? null : "the output must be above 0 and at most 100000 mm^3/mm")],
            ["extrude_rate", extrudeRate, (value) => (value > 0 && value <= 10000 ? null : "the extrude rate must be above 0 and at most 10000 mm/min")],
            ["dwell_ms", dwellMs, (value) => (Number.isInteger(value) && value >= 0 && value <= 60000 ? null : "the dwell is a whole number of ms from 0 to 60000")],
        ];
        for (const [key, field, check] of dispensingFields) {
            const value = parseNumber(field.value);
            if (value === null) {
                continue;
            }
            const problem = check(value);
            if (problem !== null) {
                ctx.toast("error", problem);
                return;
            }
            if (value !== settings.host[key]) {
                host[key] = value;
                hostChanged = true;
            }
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
