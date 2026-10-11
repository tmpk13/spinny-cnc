// The Config page's machine file panel: the files in machines/ picked,
// edited in a colored TOML editor that reads what is typed as it is
// typed, checked whole by the backend, saved, made and removed, and loaded
// onto the board, with a save to flash after. The file is the one place a
// machine is described: its axes, its pins, its tool and the page's
// controls. The live firmware settings sit beside it in their own panel.

import { askConfirm } from "../confirm.ts";
import { button, el, labeled, replace, setLocked } from "../dom.ts";
import type { MachineDocument, MachineProblem, MachineResponse, MachineSummary } from "../types.ts";
import type { Ctx } from "./context.ts";
import { codeEditor } from "./editor.ts";

/** Settings the firmware reads at boot: a change takes effect after a save to flash and a restart. */
export const BOOT_SETTINGS = ["laser_pin", "probe_pin", "tool_out", "tool_pin"];

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

function readPick(): string | null {
    try {
        return globalThis.localStorage?.getItem(PICK_KEY) ?? null;
    } catch {
        return null;
    }
}

function writePick(id: string): void {
    try {
        globalThis.localStorage?.setItem(PICK_KEY, id);
    } catch {
        // Not remembered; the pick still works.
    }
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function mountConfig(root: HTMLElement, ctx: Ctx): void {
    const pick = el("select", { class: "field", "aria-label": "Machine file" });
    const newId = el("input", { type: "text", class: "field", placeholder: "new id", "aria-label": "New machine id", autocomplete: "off" });
    newId.style.width = "8rem";
    const create = button("New", () => createFile(), "btn");
    const remove = button("Delete", () => removeFile(), "btn btn-quiet");
    const reload = button("Reload", () => reloadAll(), "btn btn-quiet btn-small");
    const note = el("p", { class: "muted config-note" });
    const load = button("Load to board", () => loadMachine(), "btn btn-primary");
    const flash = button("Save to flash", () => saveFlash(), "btn");
    const loadNote = el("span", { class: "muted" });
    const editor = codeEditor("Machine file");
    const check = button("Check", () => checkText(), "btn");
    const save = button("Save", () => saveText(), "btn btn-primary");
    const revert = button("Revert", () => revertText(), "btn btn-quiet");
    const status = el("span", { class: "muted config-status" });
    const problems = el("ul", { class: "config-problems hidden" });

    root.append(
        el("div", { class: "panel-head" }, el("h2", {}, "Machine file"), el("div", { class: "button-row" }, reload)),
        el("div", { class: "button-row" }, labeled("Machine", pick, "labeled inline"), newId, create, remove),
        note,
        el("div", { class: "button-row" }, load, flash, loadNote),
        editor.root,
        el("div", { class: "button-row" }, check, save, revert, status),
        problems,
        el("p", { class: "muted hint" },
            "the file is the machine: every axis, the pins, the tool and the page's controls, with a comment on each key."
            + " Check reads the text as the backend would; Save keeps nothing of a text that does not read."
            + " Load to board writes the file's every setting to the controller, and Save to flash keeps them over a restart."
            + " The pins (laser_pin, probe_pin, tool_out, tool_pin) are read at boot: after a load that changes one, save to flash and restart the board."),
    );

    let files: MachineSummary[] = [];
    let broken: MachineProblem[] = [];
    let picked: string | null = readPick();
    let shown: MachineResponse | null = null;
    let dirty = false;

    editor.onInput((problem) => {
        dirty = true;
        setStatus(problem ?? "edited, not saved", problem !== null);
    });
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
            writePick(next);
            await open(next);
        })();
    });

    function setStatus(text: string, error: boolean): void {
        status.textContent = text;
        status.classList.toggle("error", error);
    }

    function showProblems(list: string[]): void {
        replace(problems, ...list.map((problem) => el("li", {}, problem)));
        problems.classList.toggle("hidden", list.length === 0);
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
        if (!connected) {
            loadNote.textContent = "connect to load one";
        } else if (picked !== null && picked === current) {
            loadNote.textContent = "loaded on the board";
        } else if (current === null) {
            const drawn = state.settings?.controls_from ?? null;
            const whose = drawn === null ? "the defaults" : drawn === picked ? "this file's controls" : `the controls of ${drawn}`;
            loadNote.textContent = `the board's settings are no file's; the jog panel draws ${whose}`;
        } else {
            loadNote.textContent = `the board has ${current}`;
        }
        setLocked(load, !connected || picked === null || shown?.document === null || picked === current);
        setLocked(flash, !connected);
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
            writePick(picked);
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
        dirty = false;
        editor.setText(response.text);
        showProblems(response.problems);
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
            dirty = false;
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
            writePick(id);
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
        const ok = await askConfirm(
            `Load ${name}? Every firmware setting is written from its file; the ones changed by hand are lost. Save to flash afterwards keeps it over a restart.`,
            "Load",
        );
        if (!ok) {
            return;
        }
        const before = ctx.store.get().settings?.values;
        const done = await ctx.call(ctx.api.applyMachine(id, false));
        if (done) {
            const pins = changedBootSettings(before, done.values);
            ctx.toast("info", `${name} loaded; Save to flash keeps it over a restart`);
            if (pins.length > 0) {
                ctx.toast("info", `${pins.join(", ")} changed: Save to flash, then restart the board for the pins to take effect`);
            }
        }
        // Refreshed either way: a refused write may still have changed
        // the values before the one refused.
        await ctx.refreshSettings();
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
