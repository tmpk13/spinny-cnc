// The Config page's machine file panel: the files in machines/ picked,
// edited in a colored TOML editor that reads what is typed as it is
// typed, checked whole by the backend, saved, made and removed, written
// to the board (and saved to its flash in the same step) and read back
// from it. The file is the one place a machine is described: its axes,
// its pins, its tool, the host's values and the page's controls. Beside
// it the list of every key a file can set shows the file's value next to
// the board's. A G-code machine's file (controller = "gcode") is edited
// the same way; it has none of the firmware's settings to write or read,
// and its machine is connected from the top bar.

import { errorText } from "../api.ts";
import { askConfirm } from "../confirm.ts";
import { button, el, labeled, lockFor, readStored, replace, setLocked, writeStored } from "../dom.ts";
import { inUseText, machineInUse } from "../machineuse.ts";
import { isGcode } from "../profile.ts";
import type { FileValue } from "../filekeys.ts";
import { keyLine, setKey, tomlValue } from "../machinekeys.ts";
import { profileOf } from "../profile.ts";
import { setPending } from "../state.ts";
import { setTip } from "../tooltip.ts";
import type { MachineDocument, MachineProblem, MachineResponse, MachineSummary } from "../types.ts";
import { boardPort, connectTo, disconnectFrom } from "./connection.ts";
import { into, type Ctx } from "./context.ts";
import { codeEditor } from "./editor.ts";
import { mountMachineUpdates } from "./machineupdates.ts";
import { keyAt, keyTip, mountSettingsList, settingRows, type SettingRow } from "./settingslist.ts";

/** Settings the firmware reads at boot: a change takes effect after a save to flash and a restart. */
export const BOOT_SETTINGS = ["laser_pin", "probe_pin", "tool_out", "tool_pin", "r_stop_pin", "a_stop_pin", "h_stop_pin", "z_stop_pin"];

/** The boot-time settings a Write to board changed: it saves them to flash, so the operator is told to restart. */
export function changedBootSettings(before: Record<string, number> | undefined, after: Record<string, number>): string[] {
    if (!before) {
        return [];
    }
    return BOOT_SETTINGS.filter((name) => name in before && name in after && before[name] !== after[name]);
}

/** One line on what a file reads as. */
export function describeMachine(document: MachineDocument): string {
    if (document.controller === "gcode") {
        const gcode = document.gcode;
        const port = gcode?.url ? `port ${gcode.url}` : gcode?.match && gcode.match.length > 0 ? `a port named ${gcode.match.join(" or ")}` : "no port named yet";
        const feeders = gcode ? `${gcode.feeders.length} feeder${gcode.feeders.length === 1 ? "" : "s"}` : "";
        return `${document.name}: a G-code machine (its own controller), ${port}, safe Z ${gcode?.safe_z ?? "?"}, ${feeders}; ${document.controls.axes.length} joint controls`;
    }
    const what: string[] = [document.kinematics, document.tool];
    if (document.focus) {
        what.push("focus axis");
    }
    const pins = [`laser pin ${document.settings["laser_pin"]}`, `probe pin ${document.settings["probe_pin"]}`];
    if (document.settings["tool_out"]) {
        pins.push(`tool output pin ${document.settings["tool_pin"]}`);
    }
    return `${document.name}: ${what.join(", ")}; ${pins.join(", ")}; ${document.controls.axes.length} joint controls`;
}

// The file picked is a per-browser convenience; storage that is blocked
// or empty leaves the pick to the loaded file, else the first.
const PICK_KEY = "spinny.machine";

/** What the board row says of the board: what it runs, and whether its flash has it. */
export function boardText(connected: boolean, picked: string | null, current: string | null, unsaved: string[]): string {
    if (!connected) {
        return "connect to write to or read from the board";
    }
    const runs = current === null ? "runs settings no file has" : current === picked ? "runs this file" : `runs ${current}`;
    if (unsaved.length > 0) {
        return `the board ${runs}; ${unsaved.length} not saved to flash (${unsaved.join(", ")}), lost on restart`;
    }
    return `the board ${runs}, as saved to its flash`;
}

// How long the editor waits after the last key before it checks the text
// with the backend, for the list's file values; a find in every file waits
// as long after the last key of the word.
const CHECK_AFTER_MS = 400;
/** The most lines a find in every file lists. */
const FOUND_MOST = 100;

/** What the Config panel lets other panels do: open a file in its editor. */
export interface ConfigPanel {
    /** Opens the machine file `id`, asking first when the editor holds edits not saved. */
    open(id: string): Promise<void>;
}

/** The machine file panel in `root`, and the list of every key a file can set in `listRoot`. */
export function mountConfig(root: HTMLElement, ctx: Ctx, listRoot: HTMLElement): ConfigPanel {
    const pick = el("select", { class: "field", "aria-label": "Machine file" });
    const useButton = button("Use this machine", () => useMachine(), "btn btn-primary");
    useButton.title = "make this file the machine in use: connect its machine, or write it to the board";
    const inUse = el("p", { class: "config-in-use" });
    // Where the files are kept: a file made here (New, Save as, the OpenPnP import) is written there.
    const folderLine = el("p", { class: "muted config-folder hidden" });
    // What a release updated to offers of its machine files.
    const offersBox = el("div", {});
    const offers = mountMachineUpdates(offersBox, ctx, () => ctx.refreshMachines());
    const newId = el("input", { type: "text", class: "field", placeholder: "new id", "aria-label": "New machine id", autocomplete: "off" });
    newId.style.width = "8rem";
    const create = button("New", () => createFile(), "btn", "start a new machine file");
    const remove = button("Delete", () => removeFile(), "btn btn-quiet", "delete this machine file");
    const reload = button("Reload", () => reloadAll(), "btn btn-quiet btn-small", "read the files again from disk");
    const note = el("p", { class: "muted config-note" });
    const load = button("Write to board", () => loadMachine(), "btn");
    load.title = "write every setting to the board and its flash, [host] values to the host";
    const read = button("Read from board", () => readBoard(), "btn");
    read.title = "copy differing board values into the text; Save keeps them";
    const flash = button("Save to flash", () => saveFlash(), "btn btn-quiet");
    flash.title = "keep the board's current settings over a restart";
    const loadNote = el("span", { class: "muted config-board" });
    const editor = codeEditor("Machine file");
    // Finding a word in the file, or in every machine file.
    const findField = el("input", {
        type: "search",
        class: "field config-find",
        placeholder: "find in the file",
        "aria-label": "Find in the file",
        autocomplete: "off",
        spellcheck: "false",
        title: "find a word in the file (Ctrl+F in the editor); Enter for the next, Shift+Enter the one before, Escape back to the text",
    }) as HTMLInputElement;
    const findCount = el("span", { class: "muted config-find-count" });
    const findPrevious = button("Previous", () => findStep(-1), "btn btn-quiet btn-small", "the place before (Shift+Enter)");
    const findNext = button("Next", () => findStep(1), "btn btn-quiet btn-small", "the next place (Enter)");
    const allFiles = el("input", { type: "checkbox", "aria-label": "Find in every machine file" }) as HTMLInputElement;
    const foundList = el("ul", { class: "config-found hidden", "aria-label": "Found in the machine files" });
    const check = button("Check", () => checkText(), "btn", "check the file without saving");
    const save = button("Save", () => saveText(), "btn btn-primary", "save the file");
    const revert = button("Revert", () => revertText(), "btn btn-quiet", "drop the edits");
    const status = el("span", { class: "muted config-status" });
    const problems = el("ul", { class: "config-problems hidden" });
    // What a read from the board wrote, key by key.
    const notes = el("ul", { class: "config-notes hidden" });

    root.append(
        el("div", { class: "panel-head" }, el("h2", {}, "Machine file"), el("div", { class: "button-row" }, reload)),
        el("div", { class: "button-row" }, labeled("Machine", pick, "labeled inline"), useButton, newId, create, remove),
        inUse,
        folderLine,
        offersBox,
        note,
        el("div", { class: "button-row" }, load, read, flash),
        loadNote,
        el("div", { class: "button-row config-find-row" },
            findField, findCount, findPrevious, findNext,
            el("label", { class: "muted", title: "list the lines of every machine file that hold it" }, allFiles, " all files"),
        ),
        foundList,
        editor.root,
        el("div", { class: "button-row" }, check, save, revert, status),
        problems,
        notes,
        el("p", { class: "muted hint" },
            "Save refuses a file that does not parse. Pins are read at boot: restart the board after changing one."),
    );

    let files: MachineSummary[] = [];
    let broken: MachineProblem[] = [];
    let picked: string | null = readStored(PICK_KEY);
    let shown: MachineResponse | null = null;
    // What the editor's text read as when last checked: the list's file
    // values follow the text as it is typed, not only as saved.
    let checked: MachineDocument | null = null;
    let checkTimer: ReturnType<typeof setTimeout> | null = null;
    let dirty = false;
    const list = mountSettingsList(listRoot, ctx, {
        document: () => checked ?? shown?.document ?? null,
        text: () => editor.getText(),
        reveal: (section, name, value, array) => reveal(section, name, value, array === true),
        insert: (section, name, value) => insert(section, name, value),
    });
    // An edit not saved is counted on the page's tab.
    const setDirty = (value: boolean): void => {
        dirty = value;
        setPending(ctx.store, "machine-file", value ? 1 : 0);
    };

    // A key in the text names what it does under the pointer. The rows are
    // made again only when the text, the file read or the board's settings
    // change, not at every move of the pointer.
    let tipRows: { key: unknown[]; rows: SettingRow[] } | null = null;
    setTip(editor.textarea, (event) => {
        const at = editor.positionAt(event.clientX, event.clientY);
        const text = editor.getText();
        const key = at ? keyAt(text, at.line, at.column) : null;
        if (!key) {
            return null;
        }
        const state = ctx.store.get();
        const file = checked ?? shown?.document ?? null;
        const stamp = [text, file, state.settings, state.snapshot.profile];
        if (!tipRows || tipRows.key.some((part, index) => part !== stamp[index])) {
            tipRows = { key: stamp, rows: settingRows(file, text, state.settings, profileOf(state.snapshot)) };
        }
        return keyTip(tipRows.rows, key.section, key.name);
    });

    editor.onInput((problem) => {
        setDirty(true);
        setStatus(problem ?? "edited, not saved", problem !== null);
        scheduleCheck();
        showFound();
    });

    // --- finding a word -------------------------------------------------------

    /** The machine files' texts as last read, for a find in all of them; dropped when the files may have changed. */
    const texts = new Map<string, string>();
    let filesTimer: ReturnType<typeof setTimeout> | null = null;

    /** The count of places the editor's text holds the word, the steps locked with none. */
    function showFound(): void {
        const query = findField.value;
        const count = editor.find(query);
        findCount.textContent = query === "" ? "" : count === 0 ? "none here" : `${count} here`;
        for (const node of [findPrevious, findNext]) {
            setLocked(node, count === 0, query === "" ? "type a word to find" : "the file does not hold it");
        }
    }

    function findStep(step: 1 | -1): void {
        const at = editor.findStep(step);
        if (at) {
            findCount.textContent = `${at.index} of ${at.count}`;
        }
    }

    /** The word looked for again: in the editor at once, in every file a moment after the last key. */
    function runFind(): void {
        showFound();
        if (filesTimer !== null) {
            clearTimeout(filesTimer);
        }
        filesTimer = setTimeout(() => {
            filesTimer = null;
            void findInFiles();
        }, CHECK_AFTER_MS);
    }

    /** Every line of every machine file that holds the word, each a button to that file and line; the open file as the editor has it. */
    async function findInFiles(): Promise<void> {
        const query = findField.value;
        if (!allFiles.checked || query === "") {
            replace(foundList);
            foundList.classList.add("hidden");
            return;
        }
        const ids = [...files.map((file) => file.id), ...broken.map((entry) => entry.id)];
        for (const id of ids) {
            if (!texts.has(id) && id !== picked) {
                try {
                    texts.set(id, (await ctx.api.machineFile(id)).text);
                } catch {
                    // A file that cannot be read is left out of the find.
                }
            }
        }
        if (findField.value !== query || !allFiles.checked) {
            return;
        }
        const wanted = query.toLowerCase();
        const hits: { id: string; line: number; text: string }[] = [];
        for (const id of ids) {
            const text = id === picked ? editor.getText() : texts.get(id);
            text?.split("\n").forEach((line, index) => {
                if (line.toLowerCase().includes(wanted)) {
                    hits.push({ id, line: index, text: line.trim() });
                }
            });
        }
        const shownHits = hits.slice(0, FOUND_MOST);
        replace(foundList,
            ...shownHits.map((hit) => {
                const name = files.find((file) => file.id === hit.id)?.name ?? hit.id;
                const go = el("button", { type: "button", class: "config-found-item", title: `open ${name} at line ${hit.line + 1}` },
                    el("span", { class: "config-found-where" }, `${hit.id}:${hit.line + 1}`),
                    el("span", { class: "mono config-found-text" }, hit.text),
                );
                go.addEventListener("click", () => void openAt(hit.id, hit.line));
                return el("li", {}, go);
            }),
            ...(hits.length === 0 ? [el("li", { class: "muted" }, "no machine file holds it")] : []),
            ...(hits.length > shownHits.length ? [el("li", { class: "muted" }, `and ${hits.length - shownHits.length} more lines`)] : []),
        );
        foundList.classList.remove("hidden");
    }

    /** A file opened at a line that holds the word, the word selected there. */
    async function openAt(id: string, line: number): Promise<void> {
        if (id !== picked) {
            if (dirty && picked !== null && !(await askConfirm(`Leave ${picked}? Unsaved edits are lost.`, "Leave"))) {
                return;
            }
            picked = id;
            pick.value = id;
            writeStored(PICK_KEY, id);
            await open(id);
        }
        const text = editor.getText();
        const start = text.split("\n").slice(0, line).reduce((sum, each) => sum + each.length + 1, 0);
        const column = (text.split("\n")[line] ?? "").toLowerCase().indexOf(findField.value.toLowerCase());
        showFound();
        editor.selectRange(start + Math.max(0, column), start + Math.max(0, column) + (column >= 0 ? findField.value.length : 0), true);
    }

    findField.addEventListener("input", () => runFind());
    allFiles.addEventListener("change", () => void findInFiles());
    findField.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            findStep(event.shiftKey ? -1 : 1);
        } else if (event.key === "Escape") {
            // Back to the text, at the place found.
            event.preventDefault();
            event.stopPropagation();
            editor.textarea.focus({ preventScroll: true });
        }
    });
    // Ctrl+F in the text finds in it, starting from the word selected.
    editor.textarea.addEventListener("keydown", (event) => {
        if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "f") {
            event.preventDefault();
            const selected = editor.getText().slice(editor.textarea.selectionStart, editor.textarea.selectionEnd);
            if (selected !== "" && !selected.includes("\n")) {
                findField.value = selected;
                runFind();
            }
            findField.focus();
            findField.select();
        }
    });

    /** The text checked with the backend a moment after the last key, for the list. */
    function scheduleCheck(): void {
        if (checkTimer !== null) {
            clearTimeout(checkTimer);
        }
        checkTimer = setTimeout(() => {
            checkTimer = null;
            const id = picked;
            const text = editor.getText();
            if (id === null || editor.syntaxProblem() !== null) {
                return;
            }
            void ctx.api.checkMachineFile(id, text).then((result) => {
                if (picked === id && editor.getText() === text && result.document) {
                    checked = result.document;
                    list.refresh();
                }
            }, () => undefined);
        }, CHECK_AFTER_MS);
    }

    /**
     * The editor at a key: its line selected, or the key added with `value`
     * where the file leaves it out. A key of an array of tables (`array`,
     * [[feeder]]) is gone to in the first table that gives it; one none
     * gives is typed into the table it belongs in.
     */
    function reveal(section: string | null, name: string, value: FileValue, array = false): void {
        let text = editor.getText();
        let line = keyLine(text, section, name);
        if (line === null) {
            if (array) {
                ctx.toast("error", `no [[${section}]] table gives ${name}: type it into the one it belongs in`);
                return;
            }
            if (editor.syntaxProblem() !== null) {
                ctx.toast("error", "fix the text first: it does not parse");
                return;
            }
            if (value === null) {
                // With no file read there is nothing to take a value from;
                // with one, the key has none to add (a host value left off).
                const where = section ? `[${section}] ${name}` : name;
                ctx.toast("error", (checked ?? shown?.document) ? `${where} has no value; type it into the file` : "open a file that parses first");
                return;
            }
            text = setKey(text, section, name, value);
            editor.setText(text);
            setDirty(true);
            setStatus(`added ${section ? `[${section}] ` : ""}${name}, not saved`, false);
            line = keyLine(text, section, name);
        }
        if (line !== null) {
            editor.revealLine(line);
        }
    }
    /** The key written with `value` in the editor's text, added where the file leaves it out; an edit, not saved. */
    function insert(section: string | null, name: string, value: FileValue): void {
        if (editor.syntaxProblem() !== null) {
            ctx.toast("error", "fix the text first: it does not parse");
            return;
        }
        const text = setKey(editor.getText(), section, name, value);
        editor.setText(text);
        setDirty(true);
        setStatus(`set ${section ? `[${section}] ` : ""}${name} = ${tomlValue(value)}, not saved`, false);
        scheduleCheck();
        list.refresh();
        const line = keyLine(text, section, name);
        if (line !== null) {
            editor.revealLine(line);
        }
    }

    pick.addEventListener("change", () => {
        const next = pick.value;
        if (next === picked) {
            return;
        }
        void (async () => {
            // An edit not saved is not thrown away without a word.
            if (dirty && picked !== null && !(await askConfirm(`Leave ${picked}? Unsaved edits are lost.`, "Leave"))) {
                pick.value = picked;
                return;
            }
            picked = next;
            writeStored(PICK_KEY, next);
            await open(next);
        })();
    });

    function setStatus(text: string, error: boolean): void {
        status.textContent = text;
        status.classList.toggle("error", error);
    }

    function showProblems(lines: string[]): void {
        replace(problems, ...lines.map((problem) => el("li", {}, problem)));
        problems.classList.toggle("hidden", lines.length === 0);
    }

    function showNotes(lines: string[]): void {
        replace(notes, ...lines.map((note) => el("li", {}, note)));
        notes.classList.toggle("hidden", lines.length === 0);
    }

    // What the select was last made from.
    let pickShown = "";

    /** The select: the files by name, and the ones that do not read, by id, so they can be mended; the file in use says so. */
    function renderPick(): void {
        const use = machineInUse(ctx.store.get());
        const mark = (id: string): string => (use.id !== id ? "" : use.how === "last" ? " (last used)" : " (in use)");
        const options = [
            ...files.map((file) => [file.id, `${file.name}${mark(file.id)}`]),
            ...broken.map((entry) => [entry.id, `${entry.id} (does not parse)`]),
        ];
        // Made again only when what it lists changes: the snapshot comes ten
        // times a second, and a select whose options are replaced closes.
        const key = JSON.stringify([options, picked]);
        if (key === pickShown) {
            return;
        }
        pickShown = key;
        replace(pick, ...options.map(([value, label]) => el("option", { value: value! }, label!)));
        if (files.length === 0 && broken.length === 0) {
            pick.append(el("option", { value: "", disabled: true }, "no machine files"));
        }
        pick.value = picked ?? "";
    }

    /** What the board runs, and whether Write to board, Read from board and Save to flash have anything to do. */
    function showLoaded(): void {
        const state = ctx.store.get();
        const connected = state.snapshot.connected;
        const current = state.settings?.machine ?? null;
        const unsaved = state.settings?.unsaved ?? [];
        let text = boardText(connected, picked, current, unsaved);
        if (connected && current === null) {
            const drawn = state.settings?.controls_from ?? null;
            text += `; the jog draws ${drawn === null ? "the defaults" : drawn === picked ? "this file's controls" : `the controls of ${drawn}`}`;
        }
        const gcodeFile = shown?.document?.controller === "gcode";
        if (gcodeFile) {
            text = state.snapshot.connected && current === picked
                ? "this G-code machine is the one connected; its controller keeps its own settings"
                : "a G-code machine: its controller keeps its own settings; Use this machine connects it on the port its file claims";
        }
        loadNote.textContent = text;
        // The machine file in use, said where the files are picked.
        const use = machineInUse(state);
        inUse.textContent = `In use: ${inUseText(use)}`;
        const folder = state.machines?.folder ?? null;
        folderLine.textContent = folder ? `Machine files are kept in ${folder}: a new or imported one is written there as its id with .toml` : "";
        folderLine.classList.toggle("hidden", folder === null);
        inUse.classList.toggle("muted", use.how !== "board" && use.how !== "connected");
        const using = (use.how === "board" || use.how === "connected") && use.id === picked;
        lockFor(useButton, [picked === null, "pick a machine file first"], [shown?.document == null, "the file does not parse"], [using, "this is the machine in use"]);
        const why = "a G-code machine's controller keeps its own settings";
        lockFor(load, [gcodeFile, why], [!connected, "connect first"], [picked === null, "pick a machine file first"], [shown?.document === null, "the file does not parse"]);
        lockFor(read, [gcodeFile, why], [!connected, "connect first"], [picked === null, "pick a machine file first"]);
        // Only something written past the file, at the console or by a
        // page control, leaves the board's flash behind.
        flash.classList.toggle("hidden", !connected || unsaved.length === 0);
    }

    function lockAll(): void {
        const none = picked === null || shown === null;
        for (const node of [remove, save, revert, check]) {
            setLocked(node, none, "pick a machine file first");
        }
        showLoaded();
    }

    async function refresh(): Promise<void> {
        void offers.refresh();
        listing = true;
        try {
            await ctx.refreshMachines();
        } finally {
            listing = false;
        }
        const listed = ctx.store.get().machines;
        if (!listed) {
            return;
        }
        texts.clear();
        files = listed.machines;
        broken = listed.problems;
        const ids = [...files.map((file) => file.id), ...broken.map((entry) => entry.id)];
        if (picked === null || !ids.includes(picked)) {
            picked = ids.includes(listed.current ?? "") ? listed.current : ids[0] ?? null;
        }
        if (picked !== null) {
            writeStored(PICK_KEY, picked);
        }
        renderPick();
        if (picked !== null) {
            await open(picked);
        } else {
            shown = null;
            editor.setText("");
            note.textContent = "";
            showProblems([]);
            lockAll();
        }
    }

    /** The list and the file again, and the settings with them: a file edited by hand may have changed the controls the jog panel draws. */
    async function reloadAll(): Promise<void> {
        await refresh();
        if (ctx.store.get().snapshot.connected) {
            await ctx.refreshSettings();
        }
    }

    async function open(id: string): Promise<void> {
        const response = await ctx.call(ctx.api.machineFile(id));
        if (response && picked === id) {
            show(response);
        }
    }

    function show(response: MachineResponse): void {
        shown = response;
        checked = null;
        setDirty(false);
        editor.setText(response.text);
        texts.set(response.document?.id ?? picked ?? "", response.text);
        showFound();
        showProblems(response.problems);
        showNotes([]);
        list.refresh();
        note.textContent = response.document ? describeMachine(response.document) : "the file does not parse; fix it and Save";
        setStatus(response.document ? "" : "does not parse", response.document === null);
        lockAll();
    }

    /** The list again, the pick kept, after a save or a delete changed what there is. */
    async function refreshList(): Promise<void> {
        listing = true;
        try {
            await ctx.refreshMachines();
        } finally {
            listing = false;
        }
        takeList();
    }

    /** The files as the store lists them now, into the select and the board line. */
    function takeList(): void {
        const listed = ctx.store.get().machines;
        if (!listed) {
            return;
        }
        texts.clear();
        files = listed.machines;
        broken = listed.problems;
        renderPick();
        showLoaded();
    }

    /**
     * The files listed again elsewhere (an import made one, a panel wrote a
     * value into one, a machine connected): the select follows, and the
     * file open in the editor is read again unless it holds edits, so a
     * value written into it from another panel shows.
     */
    async function listChanged(): Promise<void> {
        if (listing) {
            return;
        }
        takeList();
        const id = picked;
        if (id === null || dirty || shown === null) {
            return;
        }
        if (![...files, ...broken].some((entry) => entry.id === id)) {
            // Gone from the directory: another file is picked.
            picked = null;
            await refresh();
            return;
        }
        try {
            const response = await ctx.api.machineFile(id);
            if (picked === id && !dirty && response.text !== shown?.text) {
                show(response);
            }
        } catch {
            // Read again at the next change, or by Reload.
        }
    }

    async function checkText(): Promise<void> {
        if (picked === null) {
            return;
        }
        const result = await ctx.call(ctx.api.checkMachineFile(picked, editor.getText()));
        if (!result) {
            return;
        }
        showProblems(result.problems);
        if (result.document) {
            checked = result.document;
            list.refresh();
            setStatus(`reads as ${describeMachine(result.document)}${dirty ? "; not saved" : ""}`, false);
        } else {
            setStatus("does not parse", true);
        }
    }

    async function saveText(): Promise<void> {
        if (picked === null) {
            return;
        }
        const id = picked;
        try {
            const response = await ctx.api.saveMachineFile(id, editor.getText());
            if (picked === id) {
                show(response);
                setStatus("saved", false);
            }
            await refreshList();
            // The loaded file's controls may have changed: the settings
            // carry them, and the jog panel draws from those.
            if (ctx.store.get().snapshot.connected) {
                await ctx.refreshSettings();
            }
        } catch (error) {
            setStatus(errorText(error), true);
            showProblems([errorText(error)]);
        }
    }

    function revertText(): void {
        if (shown) {
            editor.setText(shown.text);
            checked = null;
            list.refresh();
            showNotes([]);
            setDirty(false);
            showProblems(shown.problems);
            setStatus(shown.document ? "" : "does not parse", shown.document === null);
        }
    }

    async function createFile(): Promise<void> {
        const id = newId.value.trim();
        if (id === "") {
            ctx.toast("error", "type an id for the new file: letters, digits, - and _");
            return;
        }
        // The new file starts as the text in the editor, so the nearest
        // machine is copied and changed where it differs.
        const text = editor.getText().trim() === "" ? `name = ${JSON.stringify(id)}\n` : editor.getText();
        try {
            const response = await ctx.api.saveMachineFile(id, text);
            newId.value = "";
            picked = id;
            writeStored(PICK_KEY, id);
            await refreshList();
            show(response);
            ctx.toast("info", `saved machines/${id}.toml`);
        } catch (error) {
            ctx.toast("error", errorText(error));
        }
    }

    async function removeFile(): Promise<void> {
        if (picked === null) {
            return;
        }
        const id = picked;
        const name = files.find((file) => file.id === id)?.name ?? id;
        if (!(await askConfirm(`Delete machine file ${name} (machines/${id}.toml)?`, "Delete"))) {
            return;
        }
        const done = await ctx.call(ctx.api.deleteMachineFile(id).then(() => true));
        if (done) {
            picked = null;
            await refresh();
        }
    }

    async function loadMachine(): Promise<void> {
        if (picked === null) {
            return;
        }
        const id = picked;
        const name = files.find((file) => file.id === id)?.name ?? id;
        const edited = dirty ? " Your edits are saved to the file first." : "";
        const ok = await askConfirm(
            `Write ${name} to the board and its flash?${edited} Settings changed at the console are lost.`,
            "Write",
        );
        if (!ok) {
            return;
        }
        if (dirty) {
            try {
                const saved = await ctx.api.saveMachineFile(id, editor.getText());
                if (picked === id) {
                    show(saved);
                }
                await refreshList();
            } catch (error) {
                setStatus(errorText(error), true);
                showProblems([errorText(error)]);
                return;
            }
        }
        const before = ctx.store.get().settings?.values;
        const done = await ctx.call(ctx.api.applyMachine(id, true));
        if (done) {
            const pins = changedBootSettings(before, done.values);
            ctx.toast("info", `${name} written to the board and its flash`);
            if (pins.length > 0) {
                ctx.toast("info", `${pins.join(", ")} changed: restart the board to apply`);
            }
        }
        // Refreshed either way: a refused write may still have changed
        // the values before the one refused.
        await ctx.refreshSettings();
    }

    /** The board's values into the text where they differ; the text is then edited, not saved. */
    async function readBoard(): Promise<void> {
        if (picked === null) {
            return;
        }
        const id = picked;
        const result = await ctx.call(ctx.api.machineFromBoard(id, editor.getText()));
        if (!result || picked !== id) {
            return;
        }
        await ctx.refreshSettings();
        if (result.changes.length === 0) {
            showNotes(result.left.length > 0 ? [`no file key holds the board's ${result.left.join(", ")}`] : []);
            ctx.toast("info", "the file already matches the board");
            return;
        }
        editor.setText(result.text);
        checked = result.document;
        setDirty(true);
        showProblems(result.problems);
        const left = result.left.length > 0 ? [`no file key holds the board's ${result.left.join(", ")}`] : [];
        showNotes([...result.changes, ...left]);
        setStatus(`${result.changes.length} values read from the board; Save to keep them`, false);
        list.refresh();
    }

    async function saveFlash(): Promise<void> {
        const done = await ctx.call(ctx.api.saveSettings().then(() => true));
        if (done) {
            ctx.toast("info", "settings saved to flash");
        }
    }

    // --- the machine in use -----------------------------------------------------

    /**
     * Makes the picked file the machine in use. A G-code machine's is
     * connected on the port its file claims, the machine connected now let
     * go first; one of this project's firmware's is written to the board
     * (Write to board, which asks), the board connected first when it is
     * not and its port is known. With no port to open, the file is
     * remembered as the one in use: the PNP tab places with a G-code
     * machine's, and the jog panel keeps a board file's controls.
     */
    async function useMachine(): Promise<void> {
        const document = shown?.document ?? null;
        if (picked === null || document === null) {
            return;
        }
        const id = picked;
        if (dirty) {
            try {
                const saved = await ctx.api.saveMachineFile(id, editor.getText());
                if (picked === id) {
                    show(saved);
                }
            } catch (error) {
                setStatus(errorText(error), true);
                showProblems([errorText(error)]);
                return;
            }
        }
        // The ports as they are now: a machine plugged in since the list was made shows.
        if (!ctx.store.get().snapshot.connected) {
            await ctx.refreshPorts();
        }
        const state = ctx.store.get();
        const snapshot = state.snapshot;
        const now = machineInUse(state);
        const current = now.name ?? snapshot.url ?? "the machine connected";
        if (document.controller === "gcode") {
            const port = state.ports.find((entry) => entry.machine === id);
            if (!port) {
                await remember(id, `no port is ${document.name}'s now: give its [port] a url or match words, or connect it in the Connection panel`);
                return;
            }
            if (snapshot.connected && !(await askConfirm(`Let ${current} go and connect ${document.name} on ${port.url}?`, "Connect"))) {
                return;
            }
            if ((!snapshot.connected || (await disconnectFrom(ctx))) && (await connectTo(ctx, port.url, id))) {
                ctx.toast("info", `${document.name} connected: the machine in use`);
            }
            await ctx.refreshMachines();
            return;
        }
        if (!snapshot.connected || isGcode(snapshot)) {
            const url = boardPort(state.ports);
            if (url === null) {
                await remember(id, `connect the board in the Connection panel, then Use writes ${document.name} to it`);
                return;
            }
            if (snapshot.connected && !(await askConfirm(`Let ${current} go and connect the board on ${url}?`, "Connect"))) {
                return;
            }
            if (snapshot.connected && !(await disconnectFrom(ctx))) {
                return;
            }
            if (!(await connectTo(ctx, url, null))) {
                return;
            }
        }
        await ctx.refreshSettings();
        if (ctx.store.get().settings?.machine === id) {
            await remember(id, `the board runs ${document.name} already`);
            return;
        }
        await loadMachine();
        await ctx.refreshMachines();
    }

    /** The file remembered as the machine in use, with no machine touched, and why that is all. */
    async function remember(id: string, why: string): Promise<void> {
        if (await into(ctx, "machines", ctx.api.useMachine(id))) {
            ctx.toast("info", `${files.find((file) => file.id === id)?.name ?? id} is the machine in use: ${why}`);
            await ctx.refreshPlacing();
        }
    }

    let listing = false;
    ctx.store.subscribe(() => {
        showLoaded();
        renderPick();
    }, ["snapshot", "settings"]);
    ctx.store.subscribe(() => void listChanged(), ["machines"]);
    lockAll();
    void refresh();
    return {
        async open(id: string): Promise<void> {
            if (id === picked) {
                await open(id);
                return;
            }
            if (dirty && picked !== null && !(await askConfirm(`Leave ${picked}? Unsaved edits are lost.`, "Leave"))) {
                return;
            }
            picked = id;
            writeStored(PICK_KEY, id);
            await refreshList();
            pick.value = id;
            await open(id);
        },
    };
}
