// A G-code machine's feeders, as its machine file has them: where each one
// presents its parts and how many it has given. Feeders picked in the list
// (a press picks one, Shift a run of them, Ctrl or Cmd adds or drops one)
// are what the row of buttons under it acts on: one advance of a feeder on
// the bus (Opulo's Photon feeders) to see its tape move, and a count
// started again; and what the scan looks for, each by its id, in place of
// every address. A row of the list has no button of its own, so the list
// costs the screen nothing however long it grows.
//
// Above the list, the parts of the board picked that no feeder holds, as
// the feeder check finds them (src/views/feedercheck.ts), each group of
// one value and footprint with Add feeder; in the list, a feeder the job
// takes more parts from than it has left, or whose place is not known,
// says so in its row.
//
// With a [bus] in the file, a scan lists the feeders that answer, a row
// each by address: the row opens in place on what is done to that address
// now and then (its slot's place taken again, the address written into the
// file's feeder), and shows one button, the one the row wants: Add feeder
// for an id no feeder of the file has, Slot here for a slot with no place.
// Add feeder opens its fields in place, under the row it was pressed on,
// and writes a [[feeder]] at the end of the machine file.

import { askConfirm } from "../confirm.ts";
import { button, el, labeled, lockFor, numberField, replace, setLocked } from "../dom.ts";
import { formatFixed, parseNumber } from "../format.ts";
import type { AppState } from "../state.ts";
import type { BusFeeder, BusMissing, CamValue, FeederCheck, FeederCheckFeeder, FeederSummary, GcodeDocument } from "../types.ts";
import { into, type Ctx } from "./context.ts";
import { currentCheck, footprintName, refreshFeederCheck, watchFeederCheck } from "./feedercheck.ts";

/** Where a feeder presents its parts, in words; with the check's word on it, where the bus last answered for one with no slot in the file. */
export function feederPlaceText(feeder: FeederSummary, checked: FeederCheckFeeder | null = null): string {
    if (feeder.at) {
        const slot = feeder.bus_id ? `slot ${feeder.slot}, ` : "";
        return `${slot}X ${formatFixed(feeder.at[0], 2)} Y ${formatFixed(feeder.at[1], 2)} Z ${formatFixed(feeder.at[2], 2)}`;
    }
    if (checked?.seen && checked.address !== null) {
        return checked.place_known ? `found at address ${checked.address}` : `found at address ${checked.address}, which has no slot place`;
    }
    return checked !== null && !checked.place_known ? "not found on the bus yet: scan it" : "slot found on the bus when a run starts";
}

/** What a feeder has given, and, when the job takes more than it has left, how many it needs. */
export function feederTakenText(feeder: FeederSummary, taken: number, checked: FeederCheckFeeder | null = null): string {
    const given = `${taken}${feeder.count > 0 ? ` of ${feeder.count}` : ""}`;
    return checked !== null && checked.left !== null && checked.left < checked.needs ? `${given}, ${checked.needs} needed` : given;
}

/** A group of parts no feeder holds: one value and footprint, and the parts of it. */
export interface LooseGroup {
    value: string;
    footprint: string;
    refs: string[];
}

/** The parts a check found no feeder for, by value and footprint, in the check's order. */
export function looseGroups(check: FeederCheck): LooseGroup[] {
    const groups: LooseGroup[] = [];
    for (const part of check.parts) {
        if (part.feeder !== null) {
            continue;
        }
        const group = groups.find((entry) => entry.value === part.value && entry.footprint === part.footprint);
        if (group) {
            group.refs.push(part.ref);
        } else {
            groups.push({ value: part.value, footprint: part.footprint, refs: [part.ref] });
        }
    }
    return groups;
}

/** A feeder's id as the machine file takes it: lower case letters, digits, - and _, from a letter or digit. */
export const FEEDER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Text made fit for an id: lower case, every run of other characters one -. */
function slug(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * An id for a feeder of a value and footprint, the value then the
 * footprint's kind and size ("10k" and "Resistor_SMD:R_0603_1608Metric"
 * give "10k-r0603"); one the file has already gets a number after it.
 */
export function feederIdFor(value: string, footprint: string, taken: readonly string[]): string {
    const [kind = "", size = ""] = footprintName(footprint).split("_");
    // A kind of one or two letters (R, C, L, D) says little without its size.
    const short = kind.length <= 2 && size !== "" ? `${kind}${size}` : kind;
    const base = [slug(value), slug(short)].filter((part) => part !== "").join("-").slice(0, 60).replace(/-+$/, "") || "feeder";
    let id = base;
    for (let number = 2; taken.includes(id); number++) {
        id = `${base}-${number}`;
    }
    return id;
}

/** The words a feeder's `match` gets for a value and footprint: the value and the footprint's name, which every such part holds. */
export function matchWords(value: string, footprint: string): string {
    return `${value} ${footprintName(footprint)}`.trim();
}

/** The part pitch a tape of a footprint is likely cut at, mm: 2 for the smallest chips (0201, 0402), else 4. */
export function advanceFor(footprint: string): number {
    return /(^|[^0-9])(01005|0201|0402)([^0-9]|$)/.test(footprintName(footprint)) ? 2 : 4;
}

/** What an Add feeder form would write: its id, the parts by words or by reference, its id on the bus, its advance. */
export interface FeederDraft {
    id: string;
    match: string | null;
    refs: string[] | null;
    busId: string | null;
    advance: number | null;
}

/** Why a draft cannot be written yet, in a phrase; null when it can. */
export function draftProblem(draft: FeederDraft, ids: readonly string[]): string | null {
    if (!FEEDER_ID.test(draft.id)) {
        return "id: lower case letters, digits, - and _";
    }
    if (ids.includes(draft.id)) {
        return `the file has a feeder ${draft.id} already`;
    }
    if ((draft.match ?? "").trim() === "" && (draft.refs ?? []).length === 0) {
        return "say which parts it holds";
    }
    if (draft.busId === null) {
        return "scan the bus first: its id on the bus is needed";
    }
    if (draft.advance === null || !(draft.advance >= 0.1 && draft.advance <= 25.5)) {
        return "advance: 0.1 to 25.5 mm";
    }
    return null;
}

/** The [[feeder]] table a draft writes: its parts by reference when it has them, else by words. */
export function draftValues(draft: FeederDraft): Record<string, CamValue> {
    const parts: Record<string, CamValue> = (draft.refs ?? []).length > 0 ? { refs: draft.refs! } : { match: (draft.match ?? "").trim() };
    return { id: draft.id, ...parts, bus_id: draft.busId ?? "", advance: draft.advance ?? 4 };
}

/** The machine file's text with a [[slot]] for an address at a place: the one there changed, else a new one at the end. */
export function withSlot(text: string, doc: GcodeDocument, address: number, at: [number, number, number]): string {
    const place = `at = [${at.map((value) => formatFixed(value, 3)).join(", ")}]`;
    const index = (doc.slots ?? []).findIndex((slot) => slot.address === address);
    if (index < 0) {
        return `${text.replace(/\n+$/, "")}\n\n[[slot]]\naddress = ${address}\n${place}\n`;
    }
    // The index-th [[slot]] table's at line.
    const lines = text.split("\n");
    let seen = -1;
    let inside = false;
    for (let at_ = 0; at_ < lines.length; at_++) {
        const line = lines[at_]!.trim();
        if (/^\[\[slot\]\]/.test(line)) {
            seen += 1;
            inside = seen === index;
            continue;
        }
        if (/^\[/.test(line)) {
            inside = false;
            continue;
        }
        if (inside && /^at\s*=/.test(line)) {
            lines[at_] = place;
            return lines.join("\n");
        }
    }
    return text;
}

/** Which keys were held with a press on a list's row: Shift picks a run of rows, Ctrl (or Cmd) adds or drops one. */
export interface PickKeys {
    shift: boolean;
    toggle: boolean;
}

/**
 * A list's picked rows after a press on row `index` of `ids`, and the row
 * a Shift press counts a run from: a plain press picks that row alone (or
 * lets it go when it was the one row picked), Ctrl or Cmd adds or drops
 * it, Shift picks the run from the anchor to it (added to the rows picked
 * with Ctrl too). A plain or Ctrl press moves the anchor; Shift keeps it.
 */
export function pickAfter(ids: string[], picked: ReadonlySet<string>, anchor: string | null, index: number, keys: PickKeys): { picked: Set<string>; anchor: string | null } {
    const id = ids[index];
    if (id === undefined) {
        return { picked: new Set(picked), anchor };
    }
    if (keys.shift) {
        const from = anchor !== null && ids.includes(anchor) ? ids.indexOf(anchor) : index;
        const run = ids.slice(Math.min(from, index), Math.max(from, index) + 1);
        return { picked: new Set([...(keys.toggle ? picked : []), ...run]), anchor: anchor ?? id };
    }
    if (keys.toggle) {
        const next = new Set(picked);
        if (next.has(id)) {
            next.delete(id);
        } else {
            next.add(id);
        }
        return { picked: next, anchor: id };
    }
    const alone = picked.size === 1 && picked.has(id);
    return { picked: alone ? new Set() : new Set([id]), anchor: id };
}

/** Where an Add feeder form was opened: a group of parts no feeder holds, or a feeder on the bus no feeder of the file names. */
interface AddFrom {
    group: LooseGroup | null;
    busId: string | null;
}

export function mountPnpFeeders(root: HTMLElement, ctx: Ctx): void {
    const list = el("table", { class: "pnp-parts device-feeders" });
    const scan = button("Scan bus", () => scanBus(), "btn");
    const scanList = el("ul", { class: "groups bus-scan hidden", "aria-label": "Feeders found on the bus" });
    const missingList = el("ul", { class: "device-references bus-missing-list hidden" });
    const busBox = el("div", { class: "stack hidden" }, el("div", { class: "button-row" }, scan), missingList, scanList);
    const note = el("p", { class: "muted hint" });
    const pickLine = el("span", { class: "muted", title: "a press on a feeder picks it; Shift a run of them, Ctrl or Cmd adds or drops one" });
    const feed = button("Feed", () => feedPicked(), "btn btn-small", "advance each picked feeder's tape once, by its advance");
    const countAgain = button("Count again", () => countPicked(), "btn btn-quiet btn-small", "count the picked feeders from their first part again");
    const clearPicks = button("Clear", () => setPicked(new Set(), null), "btn btn-quiet btn-small", "pick no feeder: the scan asks every address");
    const pickButtons = [feed, countAgain, clearPicks];
    const pickRow = el("div", { class: "button-row feeder-picks" }, pickLine, ...pickButtons);
    const listBox = el("div", { class: "pnp-parts-box" }, list);
    // The parts of the board picked that no feeder holds.
    const looseList = el("ul", { class: "groups feeder-loose hidden", "aria-label": "Parts no feeder holds" });
    root.append(
        el("div", { class: "panel-head" }, el("h2", {}, "Feeders")),
        el("div", { class: "panel-body" }, note, looseList, listBox, pickRow, busBox),
    );

    let found: BusFeeder[] = [];
    let missing: BusMissing[] = [];
    // The feeders picked in the list, by id, and the one a Shift press
    // counts its run from.
    let picked = new Set<string>();
    let anchor: string | null = null;
    // The scan's rows open, by address, and the Add feeder form open, by
    // the row it was opened on: kept while the rows are drawn again.
    const openRows = new Set<number>();
    let form: { key: string; node: HTMLElement } | null = null;
    // The buttons of the rows that send the machine something, locked with
    // the machine's state.
    let rowButtons: HTMLButtonElement[] = [];

    function setPicked(next: Set<string>, nextAnchor: string | null): void {
        picked = next;
        anchor = nextAnchor;
        drawn = "";
        render(ctx.store.get());
    }

    /** The file's feeders picked, in its order. */
    function pickedFeeders(state: AppState): FeederSummary[] {
        return (state.placing?.document?.feeders ?? []).filter((feeder) => picked.has(feeder.id));
    }

    async function scanBus(): Promise<void> {
        const names = pickedFeeders(ctx.store.get()).map((feeder) => feeder.id);
        const answer = await ctx.call(ctx.api.pnpBusScan(names.length > 0 ? names : undefined));
        if (answer) {
            const { feeders, missing: unanswered, ...state } = answer;
            found = feeders;
            missing = unanswered ?? [];
            ctx.store.set({ placing: state });
            drawScan(ctx.store.get());
            // The backend now knows where the bus answered for these feeders.
            void refreshFeederCheck(ctx, true);
            if (feeders.length === 0 && missing.length === 0) {
                ctx.toast("info", "no feeder answered on the bus");
            }
        }
    }

    /** One advance of each picked feeder on the bus, in the file's order; a failure stops the rest. */
    async function feedPicked(): Promise<void> {
        for (const feeder of pickedFeeders(ctx.store.get()).filter((entry) => entry.bus_id)) {
            if ((await into(ctx, "placing", ctx.api.pnpBusFeed(feeder.id))) === undefined) {
                return;
            }
        }
    }

    async function countPicked(): Promise<void> {
        const chosen = pickedFeeders(ctx.store.get());
        const names = chosen.map((feeder) => feeder.id).join(", ");
        if (chosen.length === 0 || !(await askConfirm(`Count ${chosen.length === 1 ? "feeder" : "feeders"} ${names} from the first part again?`, "Count again"))) {
            return;
        }
        for (const feeder of chosen) {
            if ((await into(ctx, "placing", ctx.api.pnpResetFeeders(feeder.id))) === undefined) {
                return;
            }
        }
    }

    async function keepSlot(index: number, address: number): Promise<void> {
        const id = ctx.store.get().placing?.machine;
        if (!id) {
            return;
        }
        if (await ctx.call(ctx.api.patchMachineFile(id, ["feeder", index, "slot"], address))) {
            await ctx.refreshPlacing();
            await ctx.refreshMachines();
        }
    }

    async function slotHere(address: number): Promise<void> {
        const state = ctx.store.get();
        const doc = state.placing?.document ?? null;
        const id = state.placing?.machine;
        if (!doc || !id) {
            return;
        }
        if (!(await askConfirm(`Is the nozzle over the point the feeder at address ${address} presents its part at? Its slot's place is taken from where the head is.`, "Take it"))) {
            return;
        }
        // The head's place read now, the readout's joints: r is X, z is Y, h is Z.
        if ((await ctx.call(ctx.api.realtime("status").then(() => true))) !== true) {
            return;
        }
        const snapshot = await ctx.call(ctx.api.state());
        const joint = snapshot?.machine?.joint;
        const file = await ctx.call(ctx.api.machineFile(id));
        if (!snapshot || !joint || !file) {
            return;
        }
        ctx.store.set({ snapshot });
        const text = withSlot(file.text, doc, address, [joint.r, joint.z, joint.h ?? 0]);
        if (await ctx.call(ctx.api.saveMachineFile(id, text))) {
            await ctx.refreshPlacing();
            await ctx.refreshMachines();
        }
    }

    /** The scan's ids that no feeder of the file has: what a new feeder can be. */
    function freeIds(state: AppState): string[] {
        const named = new Set((state.placing?.document?.feeders ?? []).map((feeder) => feeder.bus_id).filter((id): id is string => Boolean(id)));
        return found.map((entry) => entry.id).filter((id) => !named.has(id));
    }

    function closeForm(): void {
        form?.node.remove();
        form = null;
        looseKey = "";
        scanKey = "";
        render(ctx.store.get());
        drawScan(ctx.store.get());
    }

    /** Opens the Add feeder form under the row `key` names, or shuts it when it is open there. */
    function toggleForm(key: string, from: AddFrom): void {
        const open = form?.key === key;
        closeForm();
        if (!open) {
            form = { key, node: feederForm(from) };
            looseKey = "";
            scanKey = "";
            render(ctx.store.get());
            drawScan(ctx.store.get());
            form.node.querySelector<HTMLInputElement>("input")?.focus();
        }
    }

    /**
     * Add feeder's fields: the id (suggested from the parts' value and
     * footprint), the parts it holds (one of the board's value and
     * footprint pairs no feeder holds, or the group's parts by reference),
     * its id on the bus (the row's, or one the scan found that no feeder of
     * the file has) and its advance, the tape's part pitch.
     */
    function feederForm(from: AddFrom): HTMLElement {
        const state = ctx.store.get();
        const ids = (state.placing?.document?.feeders ?? []).map((feeder) => feeder.id);
        const check = currentCheck(state)?.check ?? null;
        const groups = check ? looseGroups(check) : [];
        const first = from.group ?? groups[0] ?? null;
        const idField = el("input", { type: "text", class: "field mono", "aria-label": "Feeder id", spellcheck: "false", autocomplete: "off" }) as HTMLInputElement;
        // The parts: each pair by its words, and the row's parts by reference.
        const choices: { label: string; match: string | null; refs: string[] | null; group: LooseGroup }[] = groups.map((group) => ({
            label: `${matchWords(group.value, group.footprint)} (${group.refs.join(" ")})`, match: matchWords(group.value, group.footprint), refs: null, group,
        }));
        if (from.group) {
            choices.push({ label: `${from.group.refs.join(" ")} by reference`, match: null, refs: [...from.group.refs], group: from.group });
        }
        const partsPick = el("select", { class: "field", "aria-label": "Parts it holds" },
            ...choices.map((choice, index) => el("option", { value: String(index) }, choice.label))) as HTMLSelectElement;
        const startAt = from.group ? Math.max(0, groups.findIndex((group) => group.value === from.group!.value && group.footprint === from.group!.footprint)) : 0;
        partsPick.value = String(startAt);
        // With no pair to offer (no board, or every part held), the words are typed.
        const wordsField = el("input", { type: "text", class: "field", "aria-label": "Words its parts' value and footprint hold", placeholder: "100n 0402", spellcheck: "false" }) as HTMLInputElement;
        const partsControl = choices.length > 0 ? partsPick : wordsField;
        const free = from.busId !== null ? [from.busId] : freeIds(state);
        const busPick = el("select", { class: "field mono", "aria-label": "Its id on the bus" },
            ...free.map((id) => el("option", { value: id }, id))) as HTMLSelectElement;
        const busControl = from.busId !== null
            ? el("span", { class: "mono" }, from.busId)
            : free.length > 0 ? busPick : el("span", { class: "muted" }, "Scan the bus first: no feeder it found lacks one in the file.");
        const advance = numberField({ value: first ? advanceFor(first.footprint) : 4, min: 0.1, max: 25.5, step: 1, width: "4.5rem" });
        advance.setAttribute("aria-label", "Advance, mm");
        const pitches = [2, 4, 8].map((mm) => {
            const press = button(`${mm}`, () => {
                advance.value = String(mm);
                update();
            }, "btn btn-choice btn-small", `the tape moves ${mm} mm a part`);
            return { mm, press };
        });
        const save = button("Save", () => saveFeeder(), "btn btn-primary btn-small", "write this feeder at the end of the machine file");
        const cancel = button("Cancel", () => closeForm(), "btn btn-quiet btn-small", "close without writing anything");
        let idTyped = false;
        idField.addEventListener("input", () => {
            idTyped = true;
            update();
        });

        function draft(): FeederDraft {
            const choice = choices[Number(partsPick.value)] ?? null;
            return {
                id: idField.value.trim(),
                match: choices.length > 0 ? choice?.match ?? null : wordsField.value,
                refs: choices.length > 0 ? choice?.refs ?? null : null,
                busId: from.busId ?? (free.length > 0 ? busPick.value : null),
                advance: parseNumber(advance.value),
            };
        }

        function update(): void {
            for (const { mm, press } of pitches) {
                press.setAttribute("aria-pressed", String(parseNumber(advance.value) === mm));
            }
            const problem = draftProblem(draft(), ids);
            lockFor(save, [problem !== null, problem ?? ""]);
        }

        /** The id suggested from the parts picked, until one is typed. */
        function suggest(): void {
            const choice = choices[Number(partsPick.value)];
            if (!idTyped) {
                idField.value = choice ? feederIdFor(choice.group.value, choice.group.footprint, ids) : "";
            }
            if (choice) {
                advance.value = String(advanceFor(choice.group.footprint));
            }
            update();
        }

        async function saveFeeder(): Promise<void> {
            const machine = ctx.store.get().placing?.machine;
            if (!machine) {
                return;
            }
            const values = draftValues(draft());
            if (await ctx.call(ctx.api.addMachineTable(machine, "feeder", values))) {
                ctx.toast("info", `feeder ${String(values["id"])} written into the machine file`);
                closeForm();
                await ctx.refreshPlacing();
                await ctx.refreshMachines();
                await refreshFeederCheck(ctx);
            }
        }

        partsPick.addEventListener("change", suggest);
        wordsField.addEventListener("input", update);
        busPick.addEventListener("change", update);
        advance.addEventListener("input", update);
        suggest();
        return el("div", { class: "group-fields stack feeder-form" },
            el("div", { class: "field-grid" }, labeled("Id", idField), labeled("Parts", partsControl)),
            el("div", { class: "button-row" }, el("span", { class: "muted" }, "On the bus"), busControl),
            el("div", { class: "button-row" }, labeled("Advance mm", advance, "labeled inline"), ...pitches.map(({ press }) => press)),
            el("div", { class: "button-row" }, save, cancel),
        );
    }

    /** The form open under the row `key` names, or nothing. */
    function formFor(key: string): HTMLElement | null {
        return form?.key === key ? form.node : null;
    }

    // What the parts with no feeder were last drawn from.
    let looseKey = "";
    function drawLoose(state: AppState, check: FeederCheck | null): void {
        const groups = check ? looseGroups(check) : [];
        // A new feeder goes on the bus: a file with no bus offers none.
        const adds = state.placing?.document?.bus === true;
        const key = JSON.stringify([groups, adds]);
        if (key === looseKey) {
            return;
        }
        looseKey = key;
        replace(looseList, ...groups.map((group) => {
            const formKey = `part ${group.value}\n${group.footprint}`;
            const add = adds ? button("Add feeder", () => toggleForm(formKey, { group, busId: null }), "btn btn-small feeder-add", "write a feeder for these parts into the machine file") : null;
            add?.setAttribute("aria-expanded", String(form?.key === formKey));
            return el("li", { class: "group" },
                el("div", { class: "group-row feeder-loose-row" },
                    el("span", { class: "group-name" }, group.refs.join(" ")),
                    el("span", { class: "muted" }, `${group.value}, ${footprintName(group.footprint)}`),
                    add,
                ),
                formFor(formKey),
            );
        }));
        if (form !== null && form.key.startsWith("part ") && !looseList.contains(form.node)) {
            // The row it was opened on is gone: its parts have a feeder now.
            form = null;
        }
        looseList.classList.toggle("hidden", groups.length === 0);
    }

    // What the scan list was last drawn from: drawn again only when it
    // changes, so a press on its buttons is not lost to a rebuild.
    let scanKey = "";
    function drawScan(state: AppState): void {
        const doc = state.placing?.document;
        const feeders = doc?.feeders ?? [];
        const key = JSON.stringify([found, missing, feeders.map((feeder) => [feeder.id, feeder.bus_id, feeder.slot]), doc?.slots ?? []]);
        if (key === scanKey) {
            return;
        }
        scanKey = key;
        rowButtons = [];
        replace(missingList, ...missing.map((entry) => el("li", { class: "bus-missing" }, `feeder ${entry.feeder}${entry.id ? ` (${entry.id})` : ""}: ${entry.reason}`)));
        missingList.classList.toggle("hidden", missing.length === 0);
        replace(scanList, ...found.map((entry) => {
            const index = feeders.findIndex((feeder) => feeder.bus_id === entry.id);
            const feeder = index >= 0 ? feeders[index]! : null;
            // What is done to the address now and then, under the row.
            const more: HTMLElement[] = [];
            if (feeder && feeder.slot !== entry.address && entry.slot) {
                more.push(button(`Keep slot ${entry.address}`, () => keepSlot(index, entry.address), "btn btn-quiet btn-small",
                    `write address ${entry.address} into feeder ${feeder.id}'s slot in the machine file`));
            }
            const slot = button(entry.slot ? "Slot here again" : "Slot here", () => slotHere(entry.address), entry.slot ? "btn btn-quiet btn-small" : "btn btn-small",
                `take address ${entry.address}'s slot place from where the nozzle is now`);
            rowButtons.push(slot);
            // The one button the row shows: Add feeder for an id no feeder
            // has, else Slot here for a slot with no place yet.
            const formKey = `bus ${entry.id}`;
            let main: HTMLButtonElement | null = null;
            if (!feeder) {
                main = button("Add feeder", () => toggleForm(formKey, { group: null, busId: entry.id }), "btn btn-small feeder-add", "write a feeder of this id into the machine file");
                main.setAttribute("aria-expanded", String(form?.key === formKey));
                more.unshift(slot);
            } else if (!entry.slot) {
                main = slot;
            } else {
                more.unshift(slot);
            }
            const fields = el("div", { class: "group-fields button-row bus-more" }, ...more);
            const says = `${feeder ? feeder.id : `${entry.id}, not in the file`}${entry.slot ? "" : ", no slot place yet"}`;
            const opener = el("button", { type: "button", class: "group-open", title: "what else is done to this address: show or hide it" },
                el("span", { class: "group-name" }, `address ${entry.address}`),
                el("span", { class: "muted group-says" }, says),
            );
            const show = (shown: boolean): void => {
                fields.hidden = !shown;
                opener.setAttribute("aria-expanded", String(shown));
                if (shown) {
                    openRows.add(entry.address);
                } else {
                    openRows.delete(entry.address);
                }
            };
            opener.addEventListener("click", () => show(fields.hidden));
            show(openRows.has(entry.address));
            return el("li", { class: "group", "data-address": entry.address },
                el("div", { class: "group-row" }, opener, main),
                fields,
                formFor(formKey),
            );
        }));
        if (form !== null && form.key.startsWith("bus ") && !scanList.contains(form.node)) {
            // Its id has a feeder in the file now, or the scan no longer has it.
            form = null;
        }
        scanList.classList.toggle("hidden", found.length === 0);
        lockRows(state);
    }

    /** The machine's state on the buttons that move it or ask the bus. */
    function lockRows(state: AppState): void {
        const device = state.placing;
        const connected = device?.connected === true;
        const busy = device?.running === true || state.pnp?.routine?.state === "running" || device?.top?.routine?.state === "running";
        for (const press of rowButtons) {
            lockFor(press, [!connected, "connect the machine first"], [busy, "the machine is busy"]);
        }
    }

    let drawn = "";
    function render(state: AppState): void {
        const doc = state.placing?.document ?? null;
        const device = state.placing;
        const feeders = doc?.feeders ?? [];
        const ids = feeders.map((feeder) => feeder.id);
        if ([...picked].some((id) => !ids.includes(id))) {
            // A feeder gone from the file is picked no more.
            picked = new Set([...picked].filter((id) => ids.includes(id)));
        }
        const check = currentCheck(state)?.check ?? null;
        const checked = (id: string): FeederCheckFeeder | null => check?.feeders.find((entry) => entry.id === id) ?? null;
        drawLoose(state, check);
        const key = JSON.stringify([feeders, device?.taken ?? {}, doc?.bus ?? false, [...picked], check?.feeders ?? []]);
        if (key !== drawn) {
            drawn = key;
            replace(list,
                el("thead", {}, el("tr", {}, ...["Feeder", "Parts", "Place", "Taken"].map((name) => el("th", {}, name)))),
                el("tbody", {}, ...feeders.map((feeder, index) => {
                    // A want the check found is the row's to say, in the color for one.
                    const wants = checked(feeder.id);
                    const short = wants !== null && wants.left !== null && wants.left < wants.needs;
                    const row = el("tr", {
                        class: picked.has(feeder.id) ? "selected" : "",
                        "aria-selected": picked.has(feeder.id) ? "true" : "false",
                        title: "a press picks this feeder; Shift a run of them, Ctrl or Cmd adds or drops one",
                    },
                        el("td", { class: "mono" }, feeder.id),
                        el("td", {}, (feeder.refs?.length ?? 0) > 0 ? feeder.refs!.join(" ") : feeder.match),
                        el("td", { class: "muted", "data-need": wants !== null && !wants.place_known }, feederPlaceText(feeder, wants)),
                        el("td", { class: "mono", "data-need": short }, feederTakenText(feeder, device?.taken[feeder.id] ?? 0, wants)),
                    );
                    row.addEventListener("click", (event) => {
                        const next = pickAfter(ids, picked, anchor, index, { shift: event.shiftKey, toggle: event.ctrlKey || event.metaKey });
                        setPicked(next.picked, next.anchor);
                    });
                    // Shift with a press would also pick the page's text.
                    row.addEventListener("mousedown", (event) => {
                        if (event.shiftKey) {
                            event.preventDefault();
                        }
                    });
                    return row;
                })),
            );
        }
        note.textContent = !doc ? "No G-code machine to place with: connect one from the top bar." : feeders.length === 0 ? "Its machine file has no feeders: add [[feeder]] tables on the Machines page." : "";
        note.classList.toggle("hidden", note.textContent === "");
        listBox.classList.toggle("hidden", feeders.length === 0);
        busBox.classList.toggle("hidden", doc?.bus !== true);
        const connected = device?.connected === true;
        const busy = device?.running === true || state.pnp?.routine?.state === "running" || device?.top?.routine?.state === "running";
        const chosen = pickedFeeders(state);
        const onBus = chosen.filter((feeder) => feeder.bus_id);
        pickRow.classList.toggle("hidden", feeders.length === 0);
        pickLine.textContent = chosen.length === 0
            ? "Pick feeders in the list to feed, count or scan them."
            : `${chosen.length} picked: ${chosen.map((feeder) => feeder.id).join(", ")}${onBus.length < chosen.length ? ` (${chosen.length - onBus.length} not on the bus)` : ""}`;
        // The buttons act on the picked feeders: put away while none is.
        for (const press of pickButtons) {
            press.hidden = chosen.length === 0;
        }
        feed.hidden = chosen.length === 0 || doc?.bus !== true;
        lockFor(feed, [!connected, "connect the machine first"], [busy, "the machine is busy"], [onBus.length === 0, "none of the picked feeders is on the bus"]);
        setLocked(countAgain, busy, "the machine is placing");
        scan.textContent = chosen.length > 0 ? `Scan ${onBus.length} picked` : "Scan bus";
        scan.title = chosen.length > 0
            ? "look for the picked feeders on the bus, each by its id: one question each"
            : "ask every address on the feeder bus which feeder is there";
        lockFor(scan, [!connected, "connect the machine first"], [busy, "the machine is busy"], [chosen.length > 0 && onBus.length === 0, "none of the picked feeders is on the bus"]);
        lockRows(state);
    }

    ctx.store.subscribe((state) => {
        render(state);
        drawScan(state);
    }, ["placing", "pnp", "feederCheck", "job", "components"]);
    render(ctx.store.get());
    watchFeederCheck(ctx);
}
