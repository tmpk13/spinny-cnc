// The Config page's OpenPnP import: OpenPnP's machine.xml, and with it a
// job and its board files, read into a new G-code machine file. Every
// value read is shown with a box to keep or leave it, the file it makes is
// shown as it will be saved (in machines/, beside the others, where the
// machine file panel edits it), and the job's placements become references
// for the board job picked.

import { askConfirm } from "../confirm.ts";
import { button, el, labeled, replace } from "../dom.ts";
import { buildProfile, jobItems, machineItems, readJob, readMachine, type ImportItem, type OpenPnpMachine } from "../openpnp.ts";
import type { Ctx } from "./context.ts";

/** An id a machine file may have: lower case letters, digits, - and _. */
export function machineId(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

export function mountOpenPnpImport(root: HTMLElement, ctx: Ctx): void {
    const files = el("input", { type: "file", accept: ".xml", multiple: true, class: "hidden", "aria-label": "OpenPnP files" }) as HTMLInputElement;
    const importButton = button("Import from OpenPnP", () => files.click(), "btn");
    importButton.title = "read OpenPnP's machine.xml, and a job with its boards, into a new G-code machine file";
    const importBox = el("div", { class: "stack openpnp-import hidden" });

    root.append(
        el("div", { class: "panel-head" }, el("h2", {}, "Import from OpenPnP")),
        el("div", { class: "panel-body" },
            el("p", { class: "muted hint" }, "A pick and place machine OpenPnP drives, read into a machine file with controller = \"gcode\": connected from the top bar, it is used like the other machines."),
            el("div", { class: "button-row" }, importButton, files),
            importBox,
        ),
    );

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
        const idField = el("input", { type: "text", class: "field", "aria-label": "Imported machine id", spellcheck: "false" }) as HTMLInputElement;
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
        const make = button(machine ? "Make machine file" : "Keep references", () => apply(idField.value), "btn btn-primary");
        const cancel = button("Cancel", () => {
            reading = null;
            importBox.classList.add("hidden");
            replace(importBox);
        }, "btn btn-quiet");
        idField.addEventListener("input", showText);
        replace(importBox,
            el("h3", {}, "From OpenPnP"),
            machine && machine.nozzles.length > 1 ? el("div", { class: "button-row" }, labeled("Nozzle", nozzlePick, "labeled inline")) : null,
            machine ? el("div", { class: "button-row" }, labeled("New machine file", idField, "labeled inline")) : null,
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
            const id = machineId(rawId);
            if (id === "" || !/^[a-z0-9]/.test(id)) {
                ctx.toast("error", "id: lower case letters, digits, - and _, starting with a letter or digit");
                return;
            }
            const text = buildProfile(rawId.trim() || id, items, kept);
            const exists = (await ctx.call(ctx.api.machines()))?.machines.some((entry) => entry.id === id) ?? false;
            if (exists && !(await askConfirm(`Replace the machine file ${id} with the one read from OpenPnP?`, "Replace"))) {
                return;
            }
            if (!(await ctx.call(ctx.api.saveMachineFile(id, text)))) {
                return;
            }
            ctx.toast("info", `machines/${id}.toml made from OpenPnP: give its port a url or match words, then connect it from the top bar`);
            await ctx.refreshPorts();
            await ctx.refreshPlacing();
        }
        const job = ctx.store.get().job;
        if (kept.has("references") && references.length > 0 && job) {
            let done = 0;
            for (const reference of references) {
                const state = await ctx.call(ctx.api.pnpReference({ job: job.id, ref: reference.ref, at: reference.at }));
                if (!state) {
                    break;
                }
                ctx.store.set({ placing: state });
                done += 1;
            }
            ctx.toast("info", `${done} references kept for ${job.name}`);
        }
        reading = null;
        importBox.classList.add("hidden");
        replace(importBox);
    }

}
