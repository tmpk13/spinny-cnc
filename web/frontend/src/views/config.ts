// The Config page's machine file panel: the files in machines/ picked,
// edited in a colored TOML editor that reads what is typed as it is
// typed, checked whole by the backend, saved, made and removed, written
// to the board (and saved to its flash in the same step) and read back
// from it. The file is the one place a machine is described: its axes,
// its pins, its tool, the host's values and the page's controls. Beside
// it the list of every key a file can set shows the file's value next to
// the board's.

import { askConfirm } from "../confirm.ts";
import { button, el, labeled, readStored, replace, setLocked, writeStored } from "../dom.ts";
import { keyLine, setKey, type KeyValue } from "../machinekeys.ts";
import { setPending } from "../state.ts";
import type { MachineDocument, MachineProblem, MachineResponse, MachineSummary } from "../types.ts";
import type { Ctx } from "./context.ts";
import { codeEditor } from "./editor.ts";
import { mountSettingsList } from "./settingslist.ts";

/** Settings the firmware reads at boot: a change takes effect after a save to flash and a restart. */
export const BOOT_SETTINGS = ["laser_pin", "probe_pin", "tool_out", "tool_pin", "r_stop_pin", "a_stop_pin", "h_stop_pin", "z_stop_pin"];

/** The boot-time settings a load changed, so the operator is told to save and restart. */
export function changedBootSettings(before: Record<string, number> | undefined, after: Record<string, number>): string[] {
    if (!before) {
        return [];
    }
    return BOOT_SETTINGS.filter((name) => name in before && name in after && before[name] !== after[name]);
}

/** One line on what a file reads as. */
export function describeMachine(document: MachineDocument): string {
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

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** What the board row says of the board: what it runs, and whether its flash has it. */
export function boardText(connected: boolean, picked: string | null, current: string | null, unsaved: string[]): string {
    if (!connected) {
        return "connect to write the file to the board or read the board into it";
    }
    const runs = current === null ? "runs settings no file has" : current === picked ? "runs this file" : `runs ${current}`;
    if (unsaved.length > 0) {
        return `the board ${runs}; ${unsaved.length} written since the last save to flash (${unsaved.join(", ")}): a restart goes back to what flash holds`;
    }
    return `the board ${runs}, as saved to its flash`;
}

// How long the editor waits after the last key before it checks the text
// with the backend, for the list's file values.
const CHECK_AFTER_MS = 400;

/** The machine file panel in `root`, and the list of every key a file can set in `listRoot`. */
export function mountConfig(root: HTMLElement, ctx: Ctx, listRoot: HTMLElement): void {
    const pick = el("select", { class: "field", "aria-label": "Machine file" });
    const newId = el("input", { type: "text", class: "field", placeholder: "new id", "aria-label": "New machine id", autocomplete: "off" });
    newId.style.width = "8rem";
    const create = button("New", () => createFile(), "btn");
    const remove = button("Delete", () => removeFile(), "btn btn-quiet");
    const reload = button("Reload", () => reloadAll(), "btn btn-quiet btn-small");
    const note = el("p", { class: "muted config-note" });
    const load = button("Write to board", () => loadMachine(), "btn btn-primary");
    load.title = "Every setting of the file onto the board, saved to its flash at once so a restart keeps it, and the file's [host] values to this host";
    const read = button("Read from board", () => readBoard(), "btn");
    read.title = "The board's values into the editor's text where they differ from the file's; nothing is saved until you Save";
    const flash = button("Save to flash", () => saveFlash(), "btn btn-quiet");
    flash.title = "Keep what the board runs now, written from the console or a page control since the last save, over a restart";
    const loadNote = el("span", { class: "muted config-board" });
    const editor = codeEditor("Machine file");
    const check = button("Check", () => checkText(), "btn");
    const save = button("Save", () => saveText(), "btn btn-primary");
    const revert = button("Revert", () => revertText(), "btn btn-quiet");
    const status = el("span", { class: "muted config-status" });
    const problems = el("ul", { class: "config-problems hidden" });
    // What a read from the board wrote, key by key.
    const notes = el("ul", { class: "config-notes hidden" });

    root.append(
        el("div", { class: "panel-head" }, el("h2", {}, "Machine file"), el("div", { class: "button-row" }, reload)),
        el("div", { class: "button-row" }, labeled("Machine", pick, "labeled inline"), newId, create, remove),
        note,
        el("div", { class: "button-row" }, load, read, flash),
        loadNote,
        editor.root,
        el("div", { class: "button-row" }, check, save, revert, status),
        problems,
        notes,
        el("p", { class: "muted hint" },
            "the file is the machine: every axis, the pins, the tool, the host's values and the page's controls, with a comment on each key."
            + " Check reads the text as the backend would; Save keeps nothing of a text that does not read."
            + " Write to board puts the file's every setting on the board and saves it to the board's flash in the same step, saving the text first when it is edited."
            + " Read from board writes the board's values into the text where they differ, for you to look over and Save."
            + " The pins (output, probe, enable and endstop pins) are read at boot: restart the board after a write that changes one."),
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
        reveal: (section, name, value) => reveal(section, name, value),
    });
    // An edit not saved is counted on the page's tab.
    const setDirty = (value: boolean): void => {
        dirty = value;
        setPending(ctx.store, "machine-file", value ? 1 : 0);
    };

    editor.onInput((problem) => {
        setDirty(true);
        setStatus(problem ?? "edited, not saved", problem !== null);
        scheduleCheck();
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

    /** The editor at a key: its line selected, or the key added with `value` where the file leaves it out. */
    function reveal(section: string | null, name: string, value: KeyValue): void {
        let text = editor.getText();
        let line = keyLine(text, section, name);
        if (line === null) {
            if (editor.syntaxProblem() !== null) {
                ctx.toast("error", "mend the text first: it does not read");
                return;
            }
            if (value === null) {
                // With no file read there is nothing to take a value from;
                // with one, the key has none to add (a host value left off).
                const where = section ? `[${section}] ${name}` : name;
                ctx.toast("error", (checked ?? shown?.document) ? `${where} has no value to add: type it into the file` : "open a file that reads first");
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
    pick.addEventListener("change", () => {
        const next = pick.value;
        if (next === picked) {
            return;
        }
        void (async () => {
            // An edit not saved is not thrown away without a word.
            if (dirty && picked !== null && !(await askConfirm(`Leave ${picked} without saving the edits to it?`, "Leave"))) {
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

    /** The select: the files by name, and the ones that do not read, by id, so they can be mended. */
    function renderPick(): void {
        replace(pick,
            ...files.map((file) => el("option", { value: file.id }, file.name)),
            ...broken.map((entry) => el("option", { value: entry.id }, `${entry.id} (does not read)`)),
        );
        if (files.length === 0 && broken.length === 0) {
            pick.append(el("option", { value: "", disabled: true }, "no machine files"));
        }
        pick.value = picked ?? "";
    }

    /** What is loaded on the board, and whether Load has anything to do. */
    function showLoaded(): void {
        const state = ctx.store.get();
        const connected = state.snapshot.connected;
        const current = state.settings?.machine ?? null;
        const unsaved = state.settings?.unsaved ?? [];
        let text = boardText(connected, picked, current, unsaved);
        if (connected && current === null) {
            const drawn = state.settings?.controls_from ?? null;
            text += `; the jog panel draws ${drawn === null ? "the defaults" : drawn === picked ? "this file's controls" : `the controls of ${drawn}`}`;
        }
        loadNote.textContent = text;
        setLocked(load, !connected || picked === null || shown?.document === null);
        setLocked(read, !connected || picked === null);
        // Only something written past the file, at the console or by a
        // page control, leaves the board's flash behind.
        flash.classList.toggle("hidden", !connected || unsaved.length === 0);
    }

    function lockAll(): void {
        const none = picked === null || shown === null;
        for (const node of [remove, save, revert, check]) {
            setLocked(node, none);
        }
        showLoaded();
    }

    async function refresh(): Promise<void> {
        const listed = await ctx.call(ctx.api.machines());
        if (!listed) {
            return;
        }
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
        showProblems(response.problems);
        showNotes([]);
        list.refresh();
        note.textContent = response.document ? describeMachine(response.document) : "the file does not read; mend it and Save";
        setStatus(response.document ? "" : "does not read", response.document === null);
        lockAll();
    }

    /** The list again, the pick kept, after a save or a delete changed what there is. */
    async function refreshList(): Promise<void> {
        const listed = await ctx.call(ctx.api.machines());
        if (listed) {
            files = listed.machines;
            broken = listed.problems;
            renderPick();
            showLoaded();
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
            setStatus("does not read", true);
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
            setStatus(shown.document ? "" : "does not read", shown.document === null);
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
        const edited = dirty ? " The edits in the text are saved to the file first." : "";
        const ok = await askConfirm(
            `Write ${name} to the board?${edited} Every firmware setting is written from the file and saved to the board's flash, so a restart keeps it; one changed at the console is lost.`,
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
            ctx.toast("info", `${name} written to the board and saved to its flash`);
            if (pins.length > 0) {
                ctx.toast("info", `${pins.join(", ")} changed: restart the board for the pins to take effect`);
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
            showNotes(result.left.length > 0 ? [`no key can give ${result.left.join(", ")} the board's value`] : []);
            ctx.toast("info", "the file already says what the board runs");
            return;
        }
        editor.setText(result.text);
        checked = result.document;
        setDirty(true);
        showProblems(result.problems);
        const left = result.left.length > 0 ? [`no key can give ${result.left.join(", ")} the board's value`] : [];
        showNotes([...result.changes, ...left]);
        setStatus(`${result.changes.length} values read from the board, not saved: Save keeps them`, false);
        list.refresh();
    }

    async function saveFlash(): Promise<void> {
        const done = await ctx.call(ctx.api.saveSettings().then(() => true));
        if (done) {
            ctx.toast("info", "settings saved to flash");
        }
    }

    ctx.store.subscribe(() => showLoaded(), ["snapshot", "settings"]);
    lockAll();
    void refresh();
}
