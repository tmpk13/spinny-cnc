// A G-code machine's feeders, as its machine file has them: where each one
// presents its parts, how many it has given, a count started again, and,
// for a feeder on the bus (Opulo's Photon feeders), one advance to see its
// tape move. With a [bus] in the file, a scan lists the feeders that
// answer by address and id: a file's feeder found at an address takes it
// as its slot, and a slot's place is taken with the nozzle over the point
// a feeder there presents its part at.

import { askConfirm } from "../confirm.ts";
import { button, el, lockFor, replace } from "../dom.ts";
import { formatFixed } from "../format.ts";
import type { AppState } from "../state.ts";
import type { BusFeeder, GcodeDocument, FeederSummary } from "../types.ts";
import { into, type Ctx } from "./context.ts";

/** Where a feeder presents its parts, in words. */
export function feederPlaceText(feeder: FeederSummary): string {
    if (feeder.at) {
        const slot = feeder.bus_id ? `slot ${feeder.slot}, ` : "";
        return `${slot}X ${formatFixed(feeder.at[0], 2)} Y ${formatFixed(feeder.at[1], 2)} Z ${formatFixed(feeder.at[2], 2)}`;
    }
    return "slot found on the bus when a run starts";
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

export function mountPnpFeeders(root: HTMLElement, ctx: Ctx): void {
    const list = el("table", { class: "pnp-parts device-feeders" });
    const scan = button("Scan bus", () => scanBus(), "btn");
    scan.title = "ask every address on the feeder bus which feeder is there";
    const scanList = el("ul", { class: "device-references bus-scan" });
    const busBox = el("div", { class: "stack hidden" }, el("div", { class: "button-row" }, scan), scanList);
    const note = el("p", { class: "muted hint" });
    const listBox = el("div", { class: "pnp-parts-box" }, list);
    root.append(
        el("div", { class: "panel-head" }, el("h2", {}, "Feeders")),
        el("div", { class: "panel-body" }, note, listBox, busBox),
    );

    let found: BusFeeder[] = [];
    const feedButtons = new Map<string, HTMLButtonElement>();

    async function scanBus(): Promise<void> {
        const answer = await ctx.call(ctx.api.pnpBusScan());
        if (answer) {
            const { feeders, ...state } = answer;
            found = feeders;
            ctx.store.set({ placing: state });
            drawScan(ctx.store.get());
            if (feeders.length === 0) {
                ctx.toast("info", "no feeder answered on the bus");
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
        }
    }

    // What the scan list was last drawn from: drawn again only when it
    // changes, so a press on its buttons is not lost to a rebuild.
    let scanKey = "";
    function drawScan(state: AppState): void {
        const doc = state.placing?.document;
        const feeders = doc?.feeders ?? [];
        const key = JSON.stringify([found, feeders.map((feeder) => [feeder.id, feeder.bus_id, feeder.slot]), doc?.slots ?? []]);
        if (key === scanKey) {
            return;
        }
        scanKey = key;
        replace(scanList, ...found.map((entry) => {
            const index = feeders.findIndex((feeder) => feeder.bus_id === entry.id);
            const feeder = index >= 0 ? feeders[index]! : null;
            const actions: HTMLElement[] = [];
            if (feeder && feeder.slot !== entry.address && entry.slot) {
                actions.push(button(`Keep slot ${entry.address}`, () => keepSlot(index, entry.address), "btn btn-quiet btn-small"));
            }
            actions.push(button(entry.slot ? "Slot here again" : "Slot here", () => slotHere(entry.address), "btn btn-quiet btn-small"));
            return el("li", {}, `address ${entry.address}: ${entry.id}${feeder ? `, feeder ${feeder.id}` : ", no feeder in the machine file has this id"}${entry.slot ? "" : ", no slot place yet"} `, ...actions);
        }));
    }

    let drawn = "";
    function render(state: AppState): void {
        const doc = state.placing?.document ?? null;
        const device = state.placing;
        const feeders = doc?.feeders ?? [];
        const key = JSON.stringify([feeders, device?.taken ?? {}, doc?.bus ?? false]);
        if (key !== drawn) {
            drawn = key;
            feedButtons.clear();
            replace(list,
                el("thead", {}, el("tr", {}, ...["Feeder", "Parts", "Place", "Taken", ""].map((name) => el("th", {}, name)))),
                el("tbody", {}, ...feeders.map((feeder) => {
                    const actions: HTMLElement[] = [];
                    if (feeder.bus_id) {
                        const feed = button("Feed", () => into(ctx, "placing", ctx.api.pnpBusFeed(feeder.id)), "btn btn-quiet btn-small");
                        feed.title = `advance its tape ${feeder.advance ?? 4} mm`;
                        feedButtons.set(feeder.id, feed);
                        actions.push(feed);
                    }
                    actions.push(button("Count again", async () => {
                        if (await askConfirm(`Count feeder ${feeder.id} from its first part again?`, "Count again")) {
                            await into(ctx, "placing", ctx.api.pnpResetFeeders(feeder.id));
                        }
                    }, "btn btn-quiet btn-small"));
                    return el("tr", {},
                        el("td", { class: "mono" }, feeder.id),
                        el("td", {}, (feeder.refs?.length ?? 0) > 0 ? feeder.refs!.join(" ") : feeder.match),
                        el("td", { class: "muted" }, feederPlaceText(feeder)),
                        el("td", { class: "mono" }, `${device?.taken[feeder.id] ?? 0}${feeder.count > 0 ? ` of ${feeder.count}` : ""}`),
                        el("td", {}, ...actions),
                    );
                })),
            );
        }
        note.textContent = !doc ? "No G-code machine to place with: connect one from the top bar." : feeders.length === 0 ? "Its machine file has no feeders: add [[feeder]] tables on the Config page." : "";
        note.classList.toggle("hidden", note.textContent === "");
        listBox.classList.toggle("hidden", feeders.length === 0);
        busBox.classList.toggle("hidden", doc?.bus !== true);
        const connected = device?.connected === true;
        const busy = device?.running === true || state.pnp?.routine?.state === "running" || device?.top?.routine?.state === "running";
        lockFor(scan, [!connected, "connect the machine first"], [busy, "the machine is busy"]);
        for (const feed of feedButtons.values()) {
            lockFor(feed, [!connected, "connect the machine first"], [busy, "the machine is busy"]);
        }
    }

    ctx.store.subscribe((state) => {
        render(state);
        drawScan(state);
    }, ["placing", "pnp"]);
    render(ctx.store.get());
}
