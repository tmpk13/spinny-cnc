// The top bar: the machine's state (a press opens the Connection tab, where
// the port is picked), the kind of machine, its firmware, the event link,
// and the big Stop. Also the port helpers the Connection tab uses: a port
// a G-code machine file claims (its url, or words in the port's USB names)
// is named after that machine and opens as it, so the same Connect serves
// this project's board and a pick and place machine's own Marlin.

import { button, el, setLocked } from "../dom.ts";
import { isMilling, profileBadge, profileOf } from "../profile.ts";
import { gcodePort } from "../ports.ts";
import type { AppState } from "../state.ts";
import type { Firmware, Port } from "../types.ts";
import type { Ctx } from "./context.ts";
import { runActive, runMapUse, showMapUse } from "./heightmap.ts";
import { showPage } from "./tabs.ts";

/** How often the ports are listed again while nothing is connected, ms: a controller plugged in shows up by itself. */
export const PORT_POLL_MS = 10_000;
/** A report older than this, s, is a machine that has gone quiet; the link gives it up a little later. */
export const STALE_SECONDS = 1.5;

/**
 * The port to offer first: the controller by name, then the url last used,
 * then a G-code machine's port its file claims, then any USB device that
 * does not look like an unclaimed G-code controller, then anything.
 */
export function defaultPort(ports: Port[]): Port | null {
    const usb = ports.filter((port) => port.kind === "usb" && (port.machine || !gcodePort(port)));
    return ports.find((port) => port.spinny)
        ?? ports.find((port) => port.kind === "last")
        ?? ports.find((port) => port.machine)
        ?? usb[0]
        ?? ports.find((port) => !gcodePort(port))
        ?? null;
}

/** The G-code machine file a url opens as: the one the port listed under it names; null for this project's firmware. */
export function machineOfPort(ports: Port[], url: string): string | null {
    return ports.find((port) => port.url === url || port.device === url)?.machine ?? null;
}

/** The ports shown: without the built-in ones when asked, which are never the controller. */
export function visiblePorts(ports: Port[], hideSystem: boolean): Port[] {
    return hideSystem ? ports.filter((port) => port.kind !== "system") : ports;
}

/**
 * What the select says for a port, short: the G-code machine it is, else
 * what it is, then its device node (the long by-id url is the field's).
 */
export function portLabel(port: Port): string {
    const name = port.product || port.description;
    const where = port.device && port.device !== port.url ? port.device : port.url;
    if (port.kind === "machine") {
        return `${port.machine_name ?? port.description}: ${port.url}`;
    }
    if (port.machine_name) {
        return `${port.machine_name}: ${where}`;
    }
    return name ? `${name} (${where})` : where;
}

/** A version number in a firmware's words: 2.1.2, v0.3.0-rc1, bugfix-2.1.x. */
const VERSION = /\bv?\d+(?:\.[\dx]+)+(?:[-+][\w.]+)?|\b[a-z]+-\d+(?:\.[\dx]+)+/i;

/**
 * What the top bar says of the firmware: its version, short. This
 * project's firmware gives only a version; a G-code machine's says of
 * itself whatever its answer to M115 holds (a build date, a fork's name, a
 * line of notes), so the bar shows its first word and the version in it,
 * and the whole answer on hover. A machine that said nothing of its
 * firmware shows nothing: the badge beside it names the machine.
 */
export function firmwareLabel(firmware: Firmware | null): { text: string; title: string } {
    if (firmware === null) {
        return { text: "", title: "" };
    }
    if (firmware.name === undefined) {
        return { text: `v${firmware.version}`, title: `this project's firmware, version ${firmware.version}` };
    }
    const said = firmware.version.trim();
    if (said === "") {
        return { text: "", title: "" };
    }
    const found = VERSION.exec(said);
    const word = said.split(/\s+/)[0]!;
    let text: string;
    if (found === null) {
        text = word.length > 16 ? `${word.slice(0, 15)}...` : word;
    } else {
        text = found.index === 0 ? found[0] : `${word} ${found[0]}`;
    }
    return { text, title: `firmware: ${said}` };
}

export function mountStatusBar(root: HTMLElement, ctx: Ctx): void {
    // The state, a press away from the Connection tab where the port is picked.
    const stateBadge = el("button", { type: "button", class: "badge state", "data-state": "none", title: "the machine's state; press for the Connection tab" }, "No link");
    stateBadge.addEventListener("click", () => showPage("connection"));
    const firmware = el("span", { class: "firmware muted" }, "");
    // Shown only for a machine that is not the polar laser.
    const profile = el("span", { class: "badge profile hidden" }, "");
    // Shown only while a run is under way: whether it follows the height map.
    const mapChip = el("span", { class: "badge map-use hidden" });
    const link = el("span", { class: "link", "data-link": "closed" }, "feed off");
    const mock = ctx.store.get().mock ? el("span", { class: "badge mock" }, "mock") : null;
    // Whatever moves or burns stops: a run or probing as their Stop does,
    // else a routine, a jog or a goto, and the beam or spindle; a G-code
    // machine's own stop line.
    const stop = button("Stop", () => stopAll(), "btn btn-danger btn-stop");
    stop.title = "stop the machine: the run, probing, a routine, a jog or goto, the beam or spindle";

    root.append(
        el("div", { class: "brand" }, "Spinny Laser"),
        el("div", { class: "status" }, stateBadge, mapChip, profile, firmware, link, mock),
        stop,
    );

    async function stopAll(): Promise<void> {
        const answer = await ctx.call(ctx.api.stopAll());
        if (answer) {
            ctx.store.set({ snapshot: answer.snapshot });
            ctx.toast("info", `stopped ${answer.stopped.join(", ")}`);
        }
    }

    function render(state: AppState): void {
        const snapshot = state.snapshot;
        const machine = snapshot.machine;
        setLocked(stop, !snapshot.connected, "connect first");
        if (!snapshot.connected || !machine) {
            stateBadge.textContent = snapshot.connected ? "Connected" : "Disconnected";
            stateBadge.setAttribute("data-state", snapshot.connected ? "Idle" : "none");
        } else {
            const name = machine.state === "Alarm" ? `Alarm:${machine.alarm ?? "?"}` : machine.state;
            // A report that is not being refreshed is a machine that has
            // stopped answering: the state shown is only what it last said.
            const stale = (machine.age ?? 0) > STALE_SECONDS;
            stateBadge.textContent = stale ? `${name}, no answer ${Math.round(machine.age ?? 0)} s` : name;
            stateBadge.setAttribute("data-state", machine.state);
            stateBadge.toggleAttribute("data-stale", stale);
        }
        const label = firmwareLabel(snapshot.firmware);
        firmware.textContent = label.text;
        firmware.title = label.title;
        const badgeName = snapshot.connected ? profileBadge(profileOf(snapshot)) : "";
        profile.textContent = badgeName;
        profile.classList.toggle("hidden", badgeName === "");
        link.setAttribute("data-link", state.link);
        link.textContent = state.link === "open" ? "live" : state.link === "connecting" ? "connecting" : "disconnected";
        const progress = state.progress ?? snapshot.run;
        showMapUse(mapChip, runActive(progress) ? runMapUse(progress, isMilling(snapshot)) : null);
    }
    ctx.store.subscribe(render, ["snapshot", "link", "progress"]);
    render(ctx.store.get());
}
