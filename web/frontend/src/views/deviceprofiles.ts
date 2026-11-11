// The Config page's G-code device profiles: the files in pnp/ picked,
// edited whole in the TOML editor the machine files use, checked, saved,
// made new from the shipped template and removed; and an OpenPnP setup
// read into a new profile. The import takes OpenPnP's machine.xml, and
// with it a job and its board files: every value read is shown with a box
// to keep or leave it, the profile it makes is shown as it will be saved,
// and the job's placements become references for the board job picked.

import { askConfirm } from "../confirm.ts";
import { button, el, labeled, replace, setLocked } from "../dom.ts";
import { buildProfile, jobItems, machineItems, readJob, readMachine, type ImportItem, type OpenPnpMachine } from "../openpnp.ts";
import { setPending, type AppState } from "../state.ts";
import type { Ctx } from "./context.ts";
import { loadDeviceDoc } from "./device.ts";
import { codeEditor } from "./editor.ts";

/** An id a profile file may have: lower case letters, digits, - and _. */
export function profileId(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

export function mountDeviceProfiles(root: HTMLElement, ctx: Ctx): void {
    const pick = el("select", { class: "field", "aria-label": "Device profile file" }) as HTMLSelectElement;
    const newId = el("input", { type: "text", class: "field", placeholder: "new-profile", "aria-label": "New profile id", spellcheck: "false" }) as HTMLInputElement;
    const make = button("New", () => makeNew(), "btn btn-quiet");
    make.title = "a new profile from the shipped template, named by the id typed";
    const remove = button("Delete", () => removeProfile(), "btn btn-quiet btn-danger");
    const editor = codeEditor("Device profile");
    const check = button("Check", () => checkText(), "btn");
    const save = button("Save", () => saveText(), "btn btn-primary");
    const revert = button("Revert", () => showFile(), "btn btn-quiet");
    const status = el("span", { class: "muted config-status" });
    const listNote = el("p", { class: "muted hint" });
    // The import.
    const files = el("input", { type: "file", accept: ".xml", multiple: true, class: "hidden", "aria-label": "OpenPnP files" }) as HTMLInputElement;
    const importButton = button("Import from OpenPnP", () => files.click(), "btn");
    importButton.title = "read OpenPnP's machine.xml, and a job with its boards, into a new profile";
    const importBox = el("div", { class: "stack openpnp-import hidden" });

    root.append(
        el("div", { class: "panel-head" }, el("h2", {}, "PNP device profile")),
        el("div", { class: "panel-body" },
            el("div", { class: "button-row" }, labeled("Profile", pick, "labeled inline"), remove),
            listNote,
            el("div", { class: "button-row" }, newId, make, importButton, files),
            importBox,
            editor.root,
            el("div", { class: "button-row" }, check, save, revert, status),
        ),
    );

    let picked: string | null = null;
    let dirty = false;
    const setDirty = (value: boolean): void => {
        dirty = value;
        setPending(ctx.store, "pnp-device", value ? 1 : 0);
    };
    const setStatus = (text: string, error: boolean): void => {
        status.textContent = text;
        status.classList.toggle("error", error);
    };
    editor.onInput((problem) => {
        setDirty(true);
        setStatus(problem ?? "edited, not saved", problem !== null);
    });

    async function loadList(choose?: string): Promise<void> {
        const listing = await ctx.call(ctx.api.devices());
        if (!listing) {
            return;
        }
        replace(pick,
            el("option", { value: "" }, listing.devices.length > 0 ? "pick a profile" : "no profiles in pnp/"),
            ...listing.devices.map((device) => el("option", { value: device.id }, `${device.name} (${device.id})`)),
        );
        const want = choose ?? picked ?? ctx.store.get().device?.profile ?? listing.devices[0]?.id ?? null;
        picked = want !== null && listing.devices.some((device) => device.id === want) ? want : null;
        pick.value = picked ?? "";
        listNote.textContent = listing.problems.map((entry) => `${entry.id}: ${entry.problem}`).join("; ");
        listNote.classList.toggle("hidden", listing.problems.length === 0);
        await showFile();
    }

    async function showFile(): Promise<void> {
        setLocked(remove, picked === null);
        if (picked === null) {
            editor.setText("");
            setDirty(false);
            setStatus("", false);
            return;
        }
        const file = await ctx.call(ctx.api.deviceFile(picked));
        if (file) {
            editor.setText(file.text);
            setDirty(false);
            setStatus(`reads as ${file.document.name}, ${file.document.feeders.length} feeders`, false);
        }
    }

    pick.addEventListener("change", () => {
        void (async () => {
            const next = pick.value || null;
            if (next === picked) {
                return;
            }
            if (dirty && !(await askConfirm(`Leave ${picked}? Unsaved edits are lost.`, "Leave"))) {
                pick.value = picked ?? "";
                return;
            }
            picked = next;
            await showFile();
        })();
    });

    async function checkText(): Promise<void> {
        if (picked === null) {
            return;
        }
        const result = await ctx.call(ctx.api.checkDeviceFile(picked, editor.getText()));
        if (result) {
            setStatus(result.document ? `reads as ${result.document.name}, ${result.document.feeders.length} feeders${dirty ? "; not saved" : ""}` : result.problems.join("; "), !result.document);
        }
    }

    async function saveText(): Promise<void> {
        if (picked === null) {
            return;
        }
        const saved = await ctx.call(ctx.api.saveDeviceFile(picked, editor.getText()));
        if (saved) {
            setDirty(false);
            setStatus(`saved: ${saved.document.name}, ${saved.document.feeders.length} feeders`, false);
            if (ctx.store.get().device?.profile === picked) {
                await loadDeviceDoc(ctx, true);
            }
        }
    }

    async function makeNew(text?: string, id = profileId(newId.value)): Promise<boolean> {
        if (id === "" || !/^[a-z0-9]/.test(id)) {
            ctx.toast("error", "id: lower case letters, digits, - and _, starting with a letter or digit");
            return false;
        }
        const made = await ctx.call(ctx.api.newDeviceFile(id, text));
        if (!made) {
            return false;
        }
        newId.value = "";
        await loadList(id);
        return true;
    }

    async function removeProfile(): Promise<void> {
        if (picked === null || !(await askConfirm(`Delete the profile ${picked}? Its file is removed from pnp/.`, "Delete"))) {
            return;
        }
        const listing = await ctx.call(ctx.api.deleteDeviceFile(picked));
        if (listing) {
            picked = null;
            await loadList();
        }
    }

    // --- the import ---

    interface Reading {
        machine: OpenPnpMachine | null;
        job: ReturnType<typeof readJob> | null;
        name: string;
    }
    let reading: Reading | null = null;
    let nozzle: string | undefined;
    let items: ImportItem[] = [];
    let references: { ref: string; at: [number, number] }[] = [];
    const kept = new Set<string>();

    files.addEventListener("change", () => void readFiles());

    async function readFiles(): Promise<void> {
        const chosen = Array.from(files.files ?? []);
        files.value = "";
        if (chosen.length === 0) {
            return;
        }
        const texts = await Promise.all(chosen.map(async (file) => ({ name: file.name, text: await file.text() })));
        const machineFile = texts.find((file) => file.text.includes("<openpnp-machine"));
        const jobFile = texts.find((file) => file.text.includes("<openpnp-job"));
        const boards = new Map(texts.filter((file) => file.text.includes("<openpnp-board")).map((file) => [file.name, file.text]));
        try {
            reading = {
                machine: machineFile ? readMachine(machineFile.text) : null,
                job: jobFile ? readJob(jobFile.text, boards) : null,
                name: machineFile ? "OpenPnP machine" : "OpenPnP job",
            };
        } catch (error) {
            ctx.toast("error", `OpenPnP files: ${error instanceof Error ? error.message : String(error)}`);
            return;
        }
        if (!reading.machine && !reading.job) {
            ctx.toast("error", "pick OpenPnP's machine.xml, or a .job.xml with its .board.xml files");
            reading = null;
            return;
        }
        nozzle = reading.machine?.nozzles[0]?.name;
        readItems(true);
    }

    /** The items of the files read, for the nozzle picked and the board job selected; `fresh` keeps each one's own default. */
    function readItems(fresh: boolean): void {
        if (!reading) {
            return;
        }
        const machine = reading.machine;
        const found = machine ? machineItems(machine, nozzle) : { items: [], warnings: [] };
        const state = ctx.store.get();
        const parts = state.components !== null && state.components.job === state.job?.id ? state.components.components : [];
        const offset = machine?.nozzles.find((each) => each.name === nozzle)?.offset ?? { x: 0, y: 0, z: 0 };
        const fromJob = reading.job ? jobItems(reading.job, parts, offset, machine?.feeders ?? []) : { items: [], references: [] };
        items = [...found.items, ...fromJob.items];
        references = fromJob.references;
        if (fresh) {
            kept.clear();
            for (const item of items) {
                if (item.keep || item.needed) {
                    kept.add(item.id);
                }
            }
        }
        drawImport([...found.warnings, ...(reading.job?.warnings ?? []), ...(reading.job && parts.length === 0 ? ["pick the board job on the PNP page for the job's references"] : [])]);
    }

    function drawImport(warnings: string[]): void {
        importBox.classList.remove("hidden");
        const machine = reading?.machine ?? null;
        const nozzlePick = el("select", { class: "field", "aria-label": "OpenPnP nozzle" }, ...(machine?.nozzles ?? []).map((each) => el("option", { value: each.name }, each.name))) as HTMLSelectElement;
        nozzlePick.value = nozzle ?? "";
        nozzlePick.addEventListener("change", () => {
            nozzle = nozzlePick.value;
            readItems(false);
        });
        const idField = el("input", { type: "text", class: "field", "aria-label": "Imported profile id", spellcheck: "false" }) as HTMLInputElement;
        idField.value = "openpnp-import";
        const preview = el("pre", { class: "device-program openpnp-preview" });
        const groups = new Map<string, ImportItem[]>();
        for (const item of items) {
            groups.set(item.group, [...(groups.get(item.group) ?? []), item]);
        }
        const showText = (): void => {
            preview.textContent = machine ? buildProfile(idField.value || "openpnp-import", items, kept) : "";
            preview.classList.toggle("hidden", !machine);
        };
        const lists = [...groups.entries()].map(([group, entries]) => el("fieldset", { class: "openpnp-group" },
            el("legend", {}, group),
            ...entries.map((item) => {
                const box = el("input", { type: "checkbox", "aria-label": item.label }) as HTMLInputElement;
                box.checked = kept.has(item.id) || item.needed === true;
                box.disabled = item.needed === true;
                box.addEventListener("change", () => {
                    if (box.checked) {
                        kept.add(item.id);
                    } else {
                        kept.delete(item.id);
                    }
                    showText();
                });
                return el("label", { class: "openpnp-item", title: item.note ?? "" }, box, el("span", { class: "openpnp-label" }, item.label), el("span", { class: "muted mono openpnp-value" }, item.value));
            }),
        ));
        const make = button(machine ? "Make profile" : "Keep references", () => apply(idField.value), "btn btn-primary");
        const cancel = button("Cancel", () => {
            reading = null;
            importBox.classList.add("hidden");
            replace(importBox);
        }, "btn btn-quiet");
        idField.addEventListener("input", showText);
        replace(importBox,
            el("h3", {}, "From OpenPnP"),
            machine && machine.nozzles.length > 1 ? el("div", { class: "button-row" }, labeled("Nozzle", nozzlePick, "labeled inline")) : null,
            machine ? el("div", { class: "button-row" }, labeled("New profile", idField, "labeled inline")) : null,
            ...lists,
            warnings.length > 0 ? el("ul", { class: "device-skipped" }, ...warnings.map((warning) => el("li", {}, warning))) : null,
            preview,
            el("div", { class: "button-row" }, make, cancel),
        );
        showText();
    }

    async function apply(rawId: string): Promise<void> {
        const machine = reading?.machine ?? null;
        if (machine) {
            const id = profileId(rawId);
            const text = buildProfile(rawId.trim() || id, items, kept);
            const exists = (await ctx.call(ctx.api.devices()))?.devices.some((device) => device.id === id) ?? false;
            if (exists) {
                if (!(await askConfirm(`Replace the profile ${id} with the one read from OpenPnP?`, "Replace"))) {
                    return;
                }
                if (!(await ctx.call(ctx.api.saveDeviceFile(id, text)))) {
                    return;
                }
                await loadList(id);
            } else if (!(await makeNew(text, id))) {
                return;
            }
            ctx.toast("info", `profile ${id} made from OpenPnP: pick it in the PNP page's G-code device panel`);
        }
        const job = ctx.store.get().job;
        if (kept.has("references") && references.length > 0 && job) {
            let done = 0;
            for (const reference of references) {
                const state = await ctx.call(ctx.api.deviceReference({ job: job.id, ref: reference.ref, at: reference.at }));
                if (!state) {
                    break;
                }
                ctx.store.set({ device: state });
                done += 1;
            }
            ctx.toast("info", `${done} references kept for ${job.name}`);
        }
        reading = null;
        importBox.classList.add("hidden");
        replace(importBox);
    }

    // A pick on the PNP page shows its profile here, unless this one is being edited.
    let shownDevice: string | null | undefined;
    ctx.store.subscribe((state: AppState) => {
        const current = state.device?.profile ?? null;
        if (current !== shownDevice) {
            shownDevice = current;
            if (!dirty && current !== null && current !== picked) {
                void loadList(current);
            }
        }
    }, ["device"]);
    void loadList();
}
