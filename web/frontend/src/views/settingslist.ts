// The Config page's list of every key a machine file can set: the file's
// value beside the board's (or, for a camera's keys, the camera's), the
// ones that differ marked, a fuzzy search over the key, the firmware
// setting it drives, its help and the other words it goes by (a roll is
// found as rotation or turn, the vacuum's keys by suction). A G-code
// machine's file lists its own tables instead of the firmware's keys.
// Nothing is edited here: a row clicked takes the editor to its key, and
// adds the key with the file's value when the file leaves it out, so the
// file stays the one place a machine is written.

import { button, copyText, el, replace, setLocked } from "../dom.ts";
import { FILE_KEYS, fileValue, takes, textController, type FileKey, type FileValue } from "../filekeys.ts";
import { MACHINE_KEYS, fuzzyScore, keyLine, sameValue, sectionFor, tomlValue, valueOf, type KeyValue, type MachineKey } from "../machinekeys.ts";
import { profileOf } from "../profile.ts";
import type { AppState } from "../state.ts";
import { parseToml, type TomlTable } from "../toml.ts";
import type { MachineDocument, SettingsResponse } from "../types.ts";
import { helpMark, type Ctx } from "./context.ts";

/** What the list reads the file from and takes the editor to. */
export interface SettingsListSource {
    /** The file as last read or checked; null for none, or one that does not read. */
    document(): MachineDocument | null;
    /** The editor's text now, to tell which scale key the file uses. */
    text(): string;
    /**
     * Takes the editor to the key, added with `value` when the file leaves
     * it out; a key of an array of tables (`array`) is only gone to, in the
     * first table that gives it.
     */
    reveal(section: string | null, key: string, value: FileValue, array?: boolean): void;
    /** Writes `value` into the editor's text at the key, added where the file leaves it out, and takes the editor there. */
    insert(section: string | null, key: string, value: FileValue): void;
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

/**
 * Other words the firmware's keys are looked for by: by the section, which
 * names the axis or the part of the board, and by the key.
 */
const SECTION_WORDS: Record<string, string> = {
    rail: "x radius r axis",
    table: "a turntable rotation turn",
    dispenser: "plunger paste extruder e",
    slide: "y cross z axis",
    focus: "z h height depth",
    probe: "touch",
    output: "laser spindle pwm power",
    enable: "relay tool output air assist",
    drivers: "tmc2209 stepper motor driver",
    pca9685: "i2c servo",
    host: "",
};
const KEY_WORDS: Record<string, string> = {
    max_rate: "speed velocity feed",
    accel: "acceleration",
    jerk: "corner junction",
    jog_rate: "jog speed",
    limit: "travel soft limit max",
    invert: "reverse direction flip",
    current_ma: "amps motor current",
    microsteps: "mres microstep",
    socket: "driver slot plug",
    endstop: "limit switch home",
    endstop_pin: "limit switch gpio",
    endstop_invert: "limit switch active high",
    endstop_halt: "limit switch stop",
    home_pull: "homing back off",
    home_pos: "homing position",
    home_travel: "homing length",
    pin: "gpio",
    pwm_hz: "frequency",
    s_max: "power rpm full",
    s_min: "power minimum",
    test_ms: "beam test time",
    full_steps_per_mm: "scale steps resolution",
    full_steps_per_deg: "scale steps resolution",
    steps_per_mm: "scale resolution",
    steps_per_deg: "scale resolution",
};

/** One row: the key, the section it is in for this machine, and its values. */
export interface SettingRow {
    /** The firmware setting or host value it is; null for a key no firmware setting holds (FILE_KEYS). */
    entry: MachineKey | null;
    /** The key of the file's own it is, when it is one of those. */
    fileKey?: FileKey | null;
    section: string | null;
    /** The key as the file says it: a scale's plain key when the file uses that one. */
    name: string;
    file: FileValue;
    /** The board's value, the host's, or a camera's; null where none is known. */
    board: FileValue;
    differs: boolean;
    help: string;
}

/** What a row's Sets column says: the firmware setting, `host`, or where a file key's value goes. */
export function rowSets(row: SettingRow): string {
    if (row.fileKey) {
        return row.fileKey.sets;
    }
    return row.entry === null ? "" : row.entry.kind === "host" ? "host" : row.entry.setting;
}

/** The value a click adds a missing key with: the file's, else the board's or the camera's, else what a file without it reads as. */
export function rowAdds(row: SettingRow): FileValue {
    if (row.fileKey) {
        return row.file ?? row.board ?? row.fileKey.fallback;
    }
    return row.entry?.kind === "host" ? row.file ?? row.board : row.file;
}

/** Equal as the list compares a file's value with the live one. */
function sameFileValue(a: FileValue, b: FileValue): boolean {
    if (Array.isArray(a) || Array.isArray(b)) {
        return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => sameFileValue(item, b[index]!));
    }
    return sameValue(a, b);
}

/** A camera key's value as the camera has it now, for the machine shown; null for any other key, or a camera that is not that machine's. */
export function liveValue(state: Pick<AppState, "camera" | "placing" | "pnp">, document: MachineDocument | null, key: FileKey): FileValue {
    const capture = ["device", "size", "fps", "pcbv"];
    if (key.section === "camera") {
        const camera = state.camera;
        if (!camera || document?.controller === "gcode") {
            return null;
        }
        if (key.key === "offset") {
            return [...camera.offset];
        }
        return [...capture, "side", "finish", "roll", "mm_per_px"].includes(key.key) ? (camera[key.key as keyof typeof camera] as FileValue) ?? null : null;
    }
    const placing = state.placing;
    if (!document || !placing || placing.machine !== document.id) {
        return null;
    }
    if (key.section === "top_camera") {
        const top = placing.top;
        if (!top) {
            return null;
        }
        const measured = top.mm_per_px > 0;
        if ([...capture, "mark_spot"].includes(key.key)) {
            return (top[key.key as keyof typeof top] as FileValue) ?? null;
        }
        if (key.key === "offset") {
            return measured && top.offset ? [...top.offset] : null;
        }
        return key.key === "roll" && measured ? top.roll : null;
    }
    if (key.section === "up_camera") {
        const pnp = state.pnp;
        if ([...capture, "nozzle_spot", "part_spot"].includes(key.key)) {
            return pnp ? (pnp[key.key as keyof typeof pnp] as FileValue) ?? null : null;
        }
        const place = placing.camera;
        if (key.key === "position") {
            return place.measured && place.position ? [...place.position] : null;
        }
        return (key.key === "roll" || key.key === "mirror") && place.mm_per_px > 0 ? place[key.key] : null;
    }
    return null;
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

/**
 * The rows for a file and a board, in the keys' order: the firmware's keys
 * and the host's for a file of this project's firmware, then the keys of
 * the file's own (for a G-code machine's file, only those). `live` gives a
 * file key's value as its camera has it.
 */
export function settingRows(
    document: MachineDocument | null,
    text: string,
    settings: SettingsResponse | null,
    profile: { tool: string; h_axis: boolean },
    live: (key: FileKey) => FileValue = () => null,
): SettingRow[] {
    const tool = document?.tool ?? profile.tool;
    const focus = document?.focus ?? profile.h_axis;
    const controller = document?.controller ?? textController(text);
    const help = new Map((settings?.schema ?? []).map((item) => [item.name, item.unit ? `${item.unit}: ${item.help}` : item.help]));
    const rows: SettingRow[] = [];
    for (const entry of controller === "gcode" ? [] : MACHINE_KEYS) {
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
    let parsed: TomlTable | null = null;
    try {
        parsed = parseToml(text);
    } catch {
        // A text that does not read gives no file values; its rows stay.
    }
    for (const key of FILE_KEYS) {
        if (!takes(key, controller)) {
            continue;
        }
        const given = fileValue(parsed, key);
        // A camera's key the file leaves out keeps the camera's own; any
        // other reads as what a file without it reads as.
        const file = given ?? (key.sets === "camera" || key.array ? null : key.fallback);
        const board = live(key);
        rows.push({
            entry: null,
            fileKey: key,
            section: key.section,
            name: key.key,
            file,
            board,
            differs: file !== null && board !== null && !sameFileValue(file, board),
            help: key.help,
        });
    }
    return rows;
}

/**
 * What a key of a machine file does, for a tooltip over it: its help with
 * the firmware setting it drives, or just the setting while the board's
 * help is not known (no machine connected); null for a key the list does
 * not hold.
 */
export function keyTip(rows: SettingRow[], section: string | null, name: string): string | null {
    const row = rows.find((entry) => entry.section === section && entry.name === name);
    if (!row) {
        return null;
    }
    if (row.entry === null || row.entry.kind === "host") {
        return row.help || null;
    }
    return row.help ? `${row.help} (${row.entry.setting})` : `sets ${row.entry.setting}`;
}

/**
 * The key at a column of a line of a TOML text, with the section it is
 * in (the nearest [name] above, null for the top), or null when the column
 * is not on a key's name.
 */
export function keyAt(text: string, line: number, column: number): { section: string | null; name: string } | null {
    const lines = text.split("\n");
    const match = /^(\s*)([A-Za-z0-9_-]+)\s*=/.exec(lines[line] ?? "");
    if (!match || column < match[1]!.length || column >= match[1]!.length + match[2]!.length) {
        return null;
    }
    for (let index = line - 1; index >= 0; index--) {
        const head = /^\s*\[\s*([A-Za-z0-9_.-]+)\s*\]/.exec(lines[index]!);
        if (head) {
            return { section: head[1]!, name: match[2]! };
        }
    }
    return { section: null, name: match[2]! };
}

/** A value a row's Copy gives: the file's for a key of an array of tables, its first table's. */
function copyValue(row: SettingRow): FileValue {
    const value = rowAdds(row);
    return row.fileKey?.array && Array.isArray(value) ? value[0] ?? null : value;
}

/** A row as a TOML text: its table's header, then `key = value`; null with no value to give. */
export function rowToml(row: SettingRow): string | null {
    const value = copyValue(row);
    if (value === null) {
        return null;
    }
    const line = `${row.name} = ${tomlValue(value)}`;
    if (row.section === null) {
        return `${line}\n`;
    }
    return row.fileKey?.array ? `[[${row.section}]]\n${line}\n` : `[${row.section}]\n${line}\n`;
}

/**
 * Rows as one TOML text: the top's keys first, then each table's under
 * its header once, in the order the rows have them. A key of an array of
 * tables is left out, since it would need its table's other keys, and so
 * is a row with no value.
 */
export function rowsToml(rows: SettingRow[]): string {
    const tables = new Map<string | null, string[]>([[null, []]]);
    for (const row of rows) {
        const value = copyValue(row);
        if (value === null || row.fileKey?.array) {
            continue;
        }
        const lines = tables.get(row.section) ?? [];
        lines.push(`${row.name} = ${tomlValue(value)}`);
        tables.set(row.section, lines);
    }
    const parts: string[] = [];
    for (const [section, lines] of tables) {
        if (lines.length > 0) {
            parts.push([...(section === null ? [] : [`[${section}]`]), ...lines].join("\n"));
        }
    }
    return parts.length > 0 ? `${parts.join("\n\n")}\n` : "";
}

/**
 * What a row's Insert writes into the file: the board's value (or the
 * camera's) where there is one and the file says otherwise, else, for a
 * key the file leaves out, the value a click adds; null with nothing to
 * write. `given` says whether the file's text holds the key.
 */
export function insertValue(row: SettingRow, given: boolean): FileValue {
    if (row.fileKey?.array) {
        return null;
    }
    if (row.board !== null && (!given || !sameFileValue(row.file, row.board))) {
        return row.board;
    }
    return given ? null : rowAdds(row);
}

/** The text a row is searched by: its key, the setting it drives, its help and the other words it goes by. */
export function searchText(row: SettingRow): string {
    const words = row.fileKey
        ? row.fileKey.words
        : `${SECTION_WORDS[row.entry?.section ?? ""] ?? ""} ${KEY_WORDS[row.name] ?? ""}`;
    return `${row.section ? `[${row.section}] ` : ""}${row.name} ${row.entry?.setting ?? ""} ${row.help} ${words}`;
}

/** How a value shows in the list: a number to a millionth, a word as it is, a list as TOML writes it. */
export function shown(value: FileValue): string {
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
        placeholder: "search: key, setting, help or what it does",
        "aria-label": "Search the settings",
        spellcheck: "false",
        autocomplete: "off",
    }) as HTMLInputElement;
    // On from the start: where the file and the board differ is what asks
    // for a decision; every key is a tick away, and a search looks through
    // them all.
    const onlyDiffer = el("input", { type: "checkbox", "aria-label": "Only where the file and the board differ" }) as HTMLInputElement;
    onlyDiffer.checked = true;
    const none = el("p", { class: "muted settings-none" });
    const count = el("span", { class: "muted settings-count" });
    const table = el("table", { class: "settings settings-list" });
    // The rows the list shows now, for Copy all.
    let showing: SettingRow[] = [];
    const copyAll = button("Copy all", () => copyRows(), "btn btn-quiet btn-small", "copy the rows shown as TOML, under their tables");
    const actions = el("div", { class: "button-row settings-actions" },
        search,
        el("label", { class: "muted" }, onlyDiffer, " only differences"),
        copyAll,
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
        el("div", { class: "panel-head" }, el("h2", {}, "Settings"), count,
            helpMark(ctx, "Click a row to go to its key in the file, added if missing; Insert writes the board's value there. Scales are full steps, or firmware steps where the file uses steps_per_mm. A camera's keys show the camera's values under Board.")),
        actions,
        none,
        el("div", { class: "settings-scroll" }, table),
    );

    /** The rows as the store and the file are now. */
    function rowsNow(state: AppState): SettingRow[] {
        const document = source.document();
        return settingRows(document, source.text(), state.settings, profileOf(state.snapshot), (key) => liveValue(state, document, key));
    }

    function refresh(): void {
        const state = ctx.store.get();
        const rows = rowsNow(state);
        liveStamp = stampOf(rows);
        const query = search.value.trim();
        let picked = rows.map((row) => ({ row, score: fuzzyScore(query, searchText(row)) })).filter((item) => item.score !== null);
        // The differences alone, while there is a board to differ from and
        // nothing is searched for: a search looks through every key.
        const differences = onlyDiffer.checked && query === "" && !!state.settings;
        if (differences) {
            picked = picked.filter((item) => item.row.differs);
        }
        none.textContent = picked.length > 0 ? ""
            : differences ? "The file and the board agree on every key; untick only differences to see them all."
                : query !== "" ? "No key matches." : "";
        none.hidden = none.textContent === "";
        if (query !== "") {
            picked.sort((a, b) => b.score! - a.score!);
        }
        const differ = rows.filter((row) => row.differs).length;
        count.textContent = `${picked.length} of ${rows.length}${state.settings ? `, ${differ} differ` : ""}`;
        showing = picked.map(({ row }) => row);
        setLocked(copyAll, rowsToml(showing) === "", "no row shown has a value");
        const text = source.text();
        const body = el("tbody", {}, ...picked.map(({ row }) => {
            // The help under the key (the panel is half the page wide), and
            // again on hover with what a click does.
            const line = el("tr", { class: row.differs ? "differs" : "", title: row.help ? `${row.help}; click to show it in the file` : "click to show it in the file" },
                el("td", {},
                    el("span", { class: "mono settings-key" }, row.section ? `[${row.section}] ${row.name}` : row.name),
                    el("span", { class: "muted settings-help" }, row.help),
                ),
                el("td", { class: "mono muted settings-sets" }, rowSets(row)),
                el("td", { class: "mono" }, shown(row.file)),
                el("td", { class: "mono" }, shown(row.board)),
                el("td", {}, rowActions(row, text)),
            );
            // A key the file leaves out is added with the host's or the
            // camera's value where there is one.
            line.addEventListener("click", () => source.reveal(row.section, row.name, rowAdds(row), row.fileKey?.array === true));
            return line;
        }));
        replace(table,
            el("thead", {}, el("tr", {}, el("th", {}, "Key"), el("th", {}, "Sets"), el("th", {}, "File"), el("th", {}, "Board"), el("th", { "aria-label": "Copy or insert" }))),
            body,
        );
    }

    /** A row's Copy (the key as TOML) and Insert (the board's value into the file). */
    function rowActions(row: SettingRow, text: string): HTMLElement {
        const where = row.section ? (row.fileKey?.array ? `[[${row.section}]] ` : `[${row.section}] `) : "";
        const toml = rowToml(row);
        const copy = button("Copy", async () => {
            if (toml !== null) {
                await copied(toml, `${where}${row.name}`);
            }
        }, "btn btn-quiet btn-small", `copy ${where}${row.name} as TOML`);
        setLocked(copy, toml === null, "no value to copy");
        const given = keyLine(text, row.section, row.name) !== null;
        const value = insertValue(row, given);
        const from = row.board !== null && value === row.board ? (row.fileKey?.sets === "camera" || row.fileKey?.key === "roll" ? "the camera's" : "the board's") : "its";
        const insert = button("Insert", () => {
            if (value !== null) {
                source.insert(row.section, row.name, value);
            }
        }, "btn btn-quiet btn-small", value === null ? `write a value into the file at ${where}${row.name}` : `write ${from} ${shown(value)} into the file at ${where}${row.name}`);
        setLocked(insert, value === null, row.fileKey?.array ? `type it into its [[${row.section}]] table` : given ? "the file has this value" : "no value to insert: type it");
        // A press on a button is not a press on its row.
        const cell = el("div", { class: "settings-row-actions" }, copy, insert);
        cell.addEventListener("click", (event) => event.stopPropagation());
        return cell;
    }

    /** A text put on the clipboard, and what became of it said. */
    async function copied(toml: string, what: string): Promise<void> {
        if (await copyText(toml)) {
            ctx.toast("info", `copied ${what}`);
        } else {
            ctx.toast("error", "the browser would not copy: select the key in the file instead");
        }
    }

    async function copyRows(): Promise<void> {
        const toml = rowsToml(showing);
        if (toml !== "") {
            const keys = toml.split("\n").filter((line) => /^\S+ = /.test(line)).length;
            await copied(toml, `${keys} key${keys === 1 ? "" : "s"} as TOML`);
        }
    }

    /** The cameras' values the rows show, as one text. */
    function stampOf(rows: SettingRow[]): string {
        return JSON.stringify(rows.filter((row) => row.fileKey?.sets === "camera" || row.fileKey?.key === "roll").map((row) => row.board));
    }
    let liveStamp = "";

    search.addEventListener("input", () => refresh());
    onlyDiffer.addEventListener("change", () => refresh());
    // The settings, not the snapshot: that comes ten times a second, and a
    // machine of another kind brings new settings with it.
    ctx.store.subscribe(() => refresh(), ["settings"]);
    // The cameras' states come with their pictures and the head's moves:
    // the rows are made again only when a value they show has changed.
    ctx.store.subscribe((state) => {
        if (stampOf(rowsNow(state)) !== liveStamp) {
            refresh();
        }
    }, ["camera", "placing", "pnp"]);
    refresh();
    return { refresh };
}
