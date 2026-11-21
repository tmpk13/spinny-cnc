// The top bar: the mode in use (src/views/modes.ts, mounted into it once
// the panels are), the machine, Auto (src/views/autosteps.ts), a run under
// way, and the big Stop. The machine
// is one button saying its state and its name (the machine file in use,
// else the kind of machine); a press opens its menu: connect a port found,
// disconnect, switch to a machine connected lately, home, and the Machines
// page for the rest. While nothing is connected a Connect button beside it
// connects the port offered first in one press. A run under way shows as a
// chip with its job and how far it is, a press away from the Run panel. The
// firmware's version is the machine button's tooltip; the event link shows
// only while it is down.

import { button, el, setLocked } from "../dom.ts";
import { openMenu, type MenuEntry } from "../menu.ts";
import { machineInUse } from "../machineuse.ts";
import { isMilling, profileBadge, profileOf } from "../profile.ts";
import { defaultPort, machineOfPort, PORT_POLL_MS, portLabel, visiblePorts } from "../ports.ts";
import type { AppState } from "../state.ts";
import type { Firmware } from "../types.ts";
import { connectOffered, disconnectFrom, offeredPorts, portName, recentMachines, switchMachine } from "./connection.ts";
import type { Ctx } from "./context.ts";
import { runActive, runMapUse, showMapUse } from "./heightmap.ts";
import { goTo } from "./links.ts";
import { goToPanel } from "./steps.ts";

/** A report older than this, s, is a machine that has gone quiet; the link gives it up a little later. */
export const STALE_SECONDS = 1.5;

// The port helpers live in src/ports.ts; they are handed on from here for
// what has always read them here.
export { defaultPort, machineOfPort, PORT_POLL_MS, portLabel, visiblePorts };

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

/** What the run chip says: the job and how far the run is. */
export function runChipText(state: AppState): string {
    const progress = state.progress ?? state.snapshot.run;
    if (progress === null || !runActive(progress)) {
        return "";
    }
    const name = state.jobs.find((job) => job.id === progress.job)?.name ?? "a job";
    const share = progress.total > 0 ? Math.round((100 * progress.acked) / progress.total) : 0;
    return `${progress.state === "hold" ? "Held" : "Running"} ${name}, ${share}%`;
}

/** The places in the top bar filled once the rest of the page is up: the mode's pick, and Auto. */
export interface StatusBarHosts {
    mode: HTMLElement;
    auto: HTMLElement;
}

export function mountStatusBar(root: HTMLElement, ctx: Ctx): StatusBarHosts {
    // The machine: its state and its name on one button, which opens its menu.
    const stateBadge = el("span", { class: "badge state", "data-state": "none" }, "No link");
    // Shown only for a machine that is not the polar laser.
    const profile = el("span", { class: "badge profile hidden" }, "");
    const machineButton = el("button", { type: "button", class: "machine-button", "aria-haspopup": "menu" }, profile, stateBadge);
    machineButton.addEventListener("click", () => openMenu(machineMenu(ctx.store.get()), machineButton, "Machine"));
    // One press to the machine found, while none is connected.
    const connect = button("Connect", () => connectOffered(ctx), "btn btn-primary btn-small bar-connect");
    const firmware = el("span", { class: "firmware muted" }, "");
    // Shown only while a run is under way: the job and how far it is, and
    // whether it follows the height map.
    const runChip = el("button", { type: "button", class: "badge run-chip hidden", title: "the run under way; press for the Run panel" });
    runChip.addEventListener("click", () => goToPanel("run"));
    const mapChip = el("span", { class: "badge map-use hidden" });
    const link = el("span", { class: "link", "data-link": "closed" }, "feed off");
    const mock = ctx.store.get().mock ? el("span", { class: "badge mock", title: "the page's own stand-in for the backend: nothing here touches a machine" }, "mock") : null;
    // Whatever moves or burns stops: a run or probing as their Stop does,
    // else a routine, a jog or a goto, and the beam or spindle; a G-code
    // machine's own stop line.
    const stop = button("Stop", () => stopAll(), "btn btn-danger btn-stop");
    stop.title = "stop the machine: the run, probing, a routine, a jog or goto, the beam or spindle";

    // The mode's pick beside the name, ahead of the machine: it says what the page shows.
    const modeHost = el("div", { class: "mode-host" });
    const autoHost = el("span", { class: "auto-host" });
    root.append(
        el("div", { class: "brand" }, "Spinny Laser"),
        modeHost,
        el("div", { class: "status" }, machineButton, connect, autoHost, runChip, mapChip, firmware, link, mock),
        stop,
    );

    async function stopAll(): Promise<void> {
        const answer = await ctx.call(ctx.api.stopAll());
        if (answer) {
            ctx.store.set({ snapshot: answer.snapshot });
            ctx.toast("info", `stopped ${answer.stopped.join(", ")}`);
        }
    }

    /** The machine button's menu: the ports to connect, or the machine connected's own. */
    function machineMenu(state: AppState): MenuEntry[] {
        const snapshot = state.snapshot;
        const entries: MenuEntry[] = [];
        const machines: MenuEntry = { label: "Machines and ports", run: () => void goTo({ panel: "connection", detail: null }) };
        if (!snapshot.connected) {
            for (const port of offeredPorts(state)) {
                entries.push({ label: `Connect ${portName(port)}`, run: () => void connectOffered(ctx, port.url) });
            }
            for (const entry of recentMachines().filter((recent) => !offeredPorts(state).some((port) => port.url === recent.url))) {
                entries.push({ label: `Connect ${entry.label}`, run: () => void switchMachine(ctx, entry) });
            }
            return [...entries, ...(entries.length > 0 ? ["-" as const] : []), machines];
        }
        entries.push({ label: "Disconnect", run: () => void disconnectFrom(ctx) });
        for (const entry of recentMachines().filter((recent) => recent.url !== snapshot.url)) {
            entries.push({ label: `Switch to ${entry.label}`, run: () => void switchMachine(ctx, entry) });
        }
        // Only a machine with something to home: an endstop it reports, or a G-code machine's own homing.
        if (typeof snapshot.machine?.homed === "string" || profileOf(snapshot).controller === "gcode") {
            entries.push("-", { label: "Home", run: () => void ctx.call(ctx.api.home()), ...(runActive(state.progress ?? snapshot.run) ? { disabled: "a run is under way" } : {}) });
        }
        return [...entries, "-", machines];
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
        // The machine file in use by its name, else the kind of machine.
        const use = machineInUse(state);
        const named = use.how === "board" || use.how === "connected" ? use.name : null;
        const badgeName = !snapshot.connected ? "" : named ?? profileBadge(profileOf(snapshot));
        profile.textContent = badgeName;
        profile.title = named !== null && use.id !== null ? `the machine file in use: ${use.id}.toml; the Machines page edits it` : "the kind of machine: its settings are no machine file's";
        profile.classList.toggle("hidden", badgeName === "");
        machineButton.title = snapshot.connected
            ? `the machine connected${label.title ? `, ${label.title}` : ""}; press to disconnect, switch or home`
            : "no machine connected; press for the ports found";
        // Connect names the port it would open; with none found it leads to where a port is typed.
        const offered = defaultPort(offeredPorts(state));
        connect.classList.toggle("hidden", snapshot.connected);
        connect.textContent = offered ? `Connect ${portName(offered)}` : "Connect";
        connect.title = offered ? `connect ${offered.url}` : "no port found: plug the machine in, or press the machine for the Machines page";
        link.setAttribute("data-link", state.link);
        link.textContent = state.link === "open" ? "live" : state.link === "connecting" ? "connecting" : "disconnected";
        const progress = state.progress ?? snapshot.run;
        const running = runChipText(state);
        runChip.textContent = running;
        runChip.classList.toggle("hidden", running === "");
        runChip.setAttribute("data-run", progress?.state ?? "");
        showMapUse(mapChip, runActive(progress) ? runMapUse(progress, isMilling(snapshot)) : null);
    }
    ctx.store.subscribe(render, ["snapshot", "link", "progress", "settings", "machines", "ports", "jobs"]);
    render(ctx.store.get());
    return { mode: modeHost, auto: autoHost };
}
