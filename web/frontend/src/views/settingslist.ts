// The Config page's list of every key a machine file can set: the file's
// value beside the board's, the ones that differ marked, a fuzzy search
// over the key, the firmware setting it drives and its help. Nothing is
// edited here: a row clicked takes the editor to its key, and adds the key
// with the file's value when the file leaves it out, so the file stays the
// one place a machine is written.

import { el, replace } from "../dom.ts";
import { MACHINE_KEYS, fuzzyScore, keyLine, sameValue, sectionFor, tomlValue, valueOf, type KeyValue, type MachineKey } from "../machinekeys.ts";
import { profileOf } from "../profile.ts";
import type { MachineDocument, SettingsResponse } from "../types.ts";
import type { Ctx } from "./context.ts";

/** What the list reads the file from and takes the editor to. */
export interface SettingsListSource {
    /** The file as last read or checked; null for none, or one that does not read. */
    document(): MachineDocument | null;
    /** The editor's text now, to tell which scale key the file uses. */
    text(): string;
    /** Takes the editor to the key, added with `value` when the file leaves it out. */
    reveal(section: string | null, key: string, value: KeyValue): void;
}

/** The host's own values: what each is, since the firmware's schema does not hold them. */
const HOST_HELP: Record<string, string> = {
    tolerance: "mm: max chord deviation on streamed curves",
    travel: "H to rise to before travel moves; unset uses the host's",
    clearance: "mm above the surface for travel between cuts or dots",
    spinup: "s of dwell after the spindle starts or changes speed",
    speed_control: "false: spindle always at s_max, ignoring group speeds",
    gap: "mm needle height over a pad",
    retract: "mm the plunger pulls back after a dot",
    output: "mm^3 of paste per mm of plunger",
    extrude_rate: "mm/min plunger speed while laying a dot",
    dwell_ms: "ms the needle waits on a dot",
};

/** One row: the key, the section it is in for this machine, and its values. */
export interface SettingRow {
    entry: MachineKey;
    section: string | null;
    /** The key as the file says it: a scale's plain key when the file uses that one. */
    name: string;
    file: KeyValue;
    board: KeyValue;
    differs: boolean;
    help: string;
}

/** Whether a host key applies to the machine: the dispensing values to a dispenser, the spindle's to a spindle, the travel height to a focus axis. */
function hostApplies(name: string, tool: string, focus: boolean): boolean {
    if (["gap", "retract", "output", "extrude_rate", "dwell_ms"].includes(name)) {
        return tool === "dispenser";
    }
    if (name === "clearance") {
        return tool === "spindle" || tool === "dispenser";
    }
    if (name === "spinup" || name === "speed_control") {
        return tool === "spindle";
    }
    if (name === "travel") {
        return focus;
    }
    return true;
}

/** A scale in the file's terms: full steps over the microsteps, or the firmware's number where the file gives that. */
function scaleValue(entry: MachineKey, settings: Record<string, number> | null, plain: boolean): KeyValue {
    if (!settings) {
        return null;
    }
    const value = valueOf(entry, settings);
    const micro = settings[`tmc_${entry.setting[0]}_micro`];
    if (typeof value !== "number" || plain || !micro) {
        return value;
    }
    return value / micro;
}

/** The rows for a file and a board, in the keys' order. */
export function settingRows(document: MachineDocument | null, text: string, settings: SettingsResponse | null, profile: { tool: string; h_axis: boolean }): SettingRow[] {
    const tool = document?.tool ?? profile.tool;
    const focus = document?.focus ?? profile.h_axis;
    const help = new Map((settings?.schema ?? []).map((item) => [item.name, item.unit ? `${item.unit}: ${item.help}` : item.help]));
    const rows: SettingRow[] = [];
    for (const entry of MACHINE_KEYS) {
        if (entry.kind === "host" && !hostApplies(entry.key, tool, focus)) {
            continue;
        }
        const section = sectionFor(entry, tool);
        let name = entry.key;
        let file: KeyValue;
        let board: KeyValue;
        let differs: boolean;
        if (entry.kind === "host") {
            const own = document?.host[entry.key as keyof MachineDocument["host"]];
            file = typeof own === "number" || typeof own === "boolean" ? own : null;
            board = valueOf(entry, {}, (settings?.host ?? null) as Record<string, unknown> | null);
            // A file that leaves a host key out keeps the host's value.
            differs = file !== null && board !== null && !sameValue(file, board);
        } else {
            let plain = false;
            if (entry.kind === "scale") {
                const plainKey = section === "dispenser" ? "steps_per_mm" : name.replace(/^full_/, "");
                name = section === "dispenser" ? "full_steps_per_mm" : name;
                plain = keyLine(text, section, plainKey) !== null;
                name = plain ? plainKey : name;
            }
            const fileSettings = document?.settings ?? null;
            const boardSettings = settings?.values ?? null;
            const fileRaw = fileSettings ? valueOf(entry, fileSettings) : null;
            const boardRaw = boardSettings ? valueOf(entry, boardSettings) : null;
            file = entry.kind === "scale" ? scaleValue(entry, fileSettings, plain) : fileRaw;
            board = entry.kind === "scale" ? scaleValue(entry, boardSettings, plain) : boardRaw;
            // Compared as shown: a scale in full steps differs when the full
            // steps do, whatever the microsteps (they have a row of their own).
            differs = file !== null && board !== null && !sameValue(file, board);
        }
        let what = entry.kind === "host" ? HOST_HELP[entry.key] ?? "" : help.get(entry.setting) ?? "";
        if (entry.kind === "scale" && name.startsWith("full_")) {
            what = `motor full steps per ${entry.setting === "a_steps" && section === "table" ? "degree" : "mm"}; times microsteps gives ${entry.setting}`;
        }
        rows.push({ entry, section, name, file, board, differs, help: what });
    }
    return rows;
}

/** The text a row is searched by: its key, the setting it drives and its help. */
function searchText(row: SettingRow): string {
    return `${row.section ? `[${row.section}] ` : ""}${row.name} ${row.entry.setting} ${row.help}`;
}

function shown(value: KeyValue): string {
    if (value === null) {
        return "-";
    }
    if (typeof value === "number" && !Number.isInteger(value)) {
        return String(Math.round(value * 1e6) / 1e6);
    }
    return typeof value === "string" ? value : tomlValue(value);
}

export function mountSettingsList(root: HTMLElement, ctx: Ctx, source: SettingsListSource): { refresh(): void } {
    const search = el("input", {
        type: "search",
        class: "field settings-search",
        placeholder: "search: key, setting or help",
        "aria-label": "Search the settings",
        spellcheck: "false",
        autocomplete: "off",
    }) as HTMLInputElement;
    const onlyDiffer = el("input", { type: "checkbox", "aria-label": "Only where the file and the board differ" }) as HTMLInputElement;
    const count = el("span", { class: "muted settings-count" });
    const table = el("table", { class: "settings settings-list" });
    const actions = el("div", { class: "button-row settings-actions" },
        search,
        el("label", { class: "muted" }, onlyDiffer, " only differences"),
    );
    // The search stays in view while the long table scrolls under it: on
    // the narrow layout the page scrolls under the status bar, stuck to its
    // top, so the row is stuck under that, however tall it is.
    const bar = document.querySelector<HTMLElement>(".statusbar");
    if (bar && typeof ResizeObserver === "function") {
        const under = new ResizeObserver(() => actions.style.setProperty("--stuck-under", `${bar.offsetHeight}px`));
        under.observe(bar);
    }
    root.append(
        el("div", { class: "panel-head" }, el("h2", {}, "Settings"), count),
        actions,
        el("p", { class: "muted hint" },
            "click a row to go to its key in the file, added if missing. Scales are full steps, or firmware steps where the file uses steps_per_mm."),
        table,
    );

    function refresh(): void {
        const state = ctx.store.get();
        const rows = settingRows(source.document(), source.text(), state.settings, profileOf(state.snapshot));
        const query = search.value.trim();
        let picked = rows.map((row) => ({ row, score: fuzzyScore(query, searchText(row)) })).filter((item) => item.score !== null);
        if (onlyDiffer.checked) {
            picked = picked.filter((item) => item.row.differs);
        }
        if (query !== "") {
            picked.sort((a, b) => b.score! - a.score!);
        }
        const differ = rows.filter((row) => row.differs).length;
        count.textContent = `${picked.length} of ${rows.length}${state.settings ? `, ${differ} differ` : ""}`;
        const body = el("tbody", {}, ...picked.map(({ row }) => {
            // The help under the key: the panel is half the page wide.
            const line = el("tr", { class: row.differs ? "differs" : "", title: `${row.entry.setting}: click to show in the file` },
                el("td", {},
                    el("span", { class: "mono settings-key" }, row.section ? `[${row.section}] ${row.name}` : row.name),
                    el("span", { class: "muted settings-help" }, row.help),
                ),
                el("td", { class: "mono muted" }, row.entry.kind === "host" ? "host" : row.entry.setting),
                el("td", { class: "mono" }, shown(row.file)),
                el("td", { class: "mono" }, shown(row.board)),
            );
            // A host key the file leaves out has the host's value, so that
            // is the value it is added with.
            const value = row.entry.kind === "host" ? row.file ?? row.board : row.file;
            line.addEventListener("click", () => source.reveal(row.section, row.name, value));
            return line;
        }));
        replace(table,
            el("thead", {}, el("tr", {}, el("th", {}, "Key"), el("th", {}, "Sets"), el("th", {}, "File"), el("th", {}, "Board"))),
            body,
        );
    }

    search.addEventListener("input", () => refresh());
    onlyDiffer.addEventListener("change", () => refresh());
    // The settings, not the snapshot: that comes ten times a second, and a
    // machine of another kind brings new settings with it.
    ctx.store.subscribe(() => refresh(), ["settings"]);
    refresh();
    return { refresh };
}
