// Connection selector, machine state, firmware version and the event link.

import { button, el, replace } from "../dom.ts";
import { profileBadge, profileOf } from "../profile.ts";
import type { Port } from "../types.ts";
import type { Ctx } from "./context.ts";

/** How often the ports are listed again while nothing is connected, ms: a controller plugged in shows up by itself. */
export const PORT_POLL_MS = 10_000;
const HIDE_SYSTEM_KEY = "spinny.hideSystemPorts";
/** A report older than this, s, is a machine that has gone quiet; the link gives it up a little later. */
export const STALE_SECONDS = 1.5;

/** The port to offer first: the controller by name, then the url last used, then any USB device, then anything. */
export function defaultPort(ports: Port[]): Port | null {
    return ports.find((port) => port.spinny)
        ?? ports.find((port) => port.kind === "last")
        ?? ports.find((port) => port.kind === "usb")
        ?? ports[0]
        ?? null;
}

/** The ports shown: without the built-in ones when asked, which are never the controller. */
export function visiblePorts(ports: Port[], hideSystem: boolean): Port[] {
    return hideSystem ? ports.filter((port) => port.kind !== "system") : ports;
}

/** What the select says for a port: what it is, then where. */
export function portLabel(port: Port): string {
    const name = port.product || port.description;
    return name ? `${name}  ${port.url}` : port.url;
}

function readHideSystem(): boolean {
    try {
        const stored = localStorage.getItem(HIDE_SYSTEM_KEY);
        return stored === null ? true : stored === "1";
    } catch {
        return true;
    }
}

export function mountStatusBar(root: HTMLElement, ctx: Ctx): void {
    let hideSystem = readHideSystem();
    const hideBox = el("input", { type: "checkbox", class: "hide-system", "aria-label": "Hide system ports" }) as HTMLInputElement;
    hideBox.checked = hideSystem;
    const hideLabel = el("label", { class: "muted hide-system-label", title: "Leave out the built-in serial ports, which are never the controller" }, hideBox, " hide system ports");
    hideBox.addEventListener("change", () => {
        hideSystem = hideBox.checked;
        try {
            localStorage.setItem(HIDE_SYSTEM_KEY, hideSystem ? "1" : "0");
        } catch {
            // Nothing to remember it in: the choice holds for this page.
        }
        renderPorts(ctx.store.get().ports);
    });
    const select = el("select", { class: "field", "aria-label": "Serial port" });
    const urlInput = el("input", {
        type: "text",
        class: "field url",
        placeholder: "/dev/ttyACM0 or socket://host:port",
        "aria-label": "Port url",
        autocomplete: "off",
    });
    const refresh = button("Ports", () => ctx.refreshPorts(), "btn btn-quiet");
    const connect = button("Connect", () => toggle());
    const stateBadge = el("span", { class: "badge state", "data-state": "none" }, "No link");
    const firmware = el("span", { class: "firmware muted" }, "");
    // Shown only for a machine that is not the polar laser.
    const profile = el("span", { class: "badge profile hidden" }, "");
    const link = el("span", { class: "link", "data-link": "closed" }, "feed off");
    const mock = ctx.store.get().mock ? el("span", { class: "badge mock" }, "mock") : null;

    root.append(
        el("div", { class: "brand" }, "Spinny Laser"),
        el("div", { class: "connection" }, select, urlInput, refresh, connect, hideLabel),
        el("div", { class: "status" }, stateBadge, profile, firmware, link, mock),
    );

    select.addEventListener("change", () => {
        urlInput.value = select.value;
    });

    async function toggle(): Promise<void> {
        const snapshot = ctx.store.get().snapshot;
        if (snapshot.connected) {
            const next = await ctx.call(ctx.api.disconnect());
            if (next) {
                ctx.store.set({ snapshot: next });
            }
        } else {
            const url = urlInput.value.trim() || select.value;
            if (!url) {
                ctx.toast("error", "pick a port or type a url");
                return;
            }
            const next = await ctx.call(ctx.api.connect(url));
            if (next) {
                ctx.store.set({ snapshot: next });
                if (next.connected) {
                    await ctx.refreshSettings();
                }
            }
        }
    }

    function renderPorts(all: Port[]): void {
        const ports = visiblePorts(all, hideSystem);
        const current = select.value;
        replace(
            select,
            el("option", { value: "" }, ports.length ? "port..." : "no ports"),
            ...ports.map((port) => el("option", { value: port.url }, portLabel(port))),
        );
        if (ports.some((port) => port.url === current)) {
            select.value = current;
        }
        const connected = ctx.store.get().snapshot.connected;
        const offered = defaultPort(ports);
        // The controller takes the field over from a built-in port it was
        // given before anything better was listed, never from something typed.
        const typed = urlInput.value !== "" && !all.some((port) => port.url === urlInput.value || port.device === urlInput.value);
        const held = all.find((port) => port.url === urlInput.value || port.device === urlInput.value);
        if (!connected && offered && !typed && (urlInput.value === "" || (held?.kind === "system" && offered.kind !== "system"))) {
            urlInput.value = offered.url;
            select.value = offered.url;
        }
    }

    ctx.store.subscribe((state) => renderPorts(state.ports), ["ports"]);

    // A controller plugged in later shows up without a press of Ports.
    const poll = setInterval(() => {
        if (!ctx.store.get().snapshot.connected && document.visibilityState !== "hidden") {
            void ctx.refreshPorts();
        }
    }, PORT_POLL_MS);
    window.addEventListener("pagehide", () => clearInterval(poll));

    ctx.store.subscribe((state) => {
        const snapshot = state.snapshot;
        const machine = snapshot.machine;
        connect.textContent = snapshot.connected ? "Disconnect" : "Connect";
        connect.classList.toggle("btn-primary", !snapshot.connected);
        urlInput.disabled = snapshot.connected;
        select.disabled = snapshot.connected;
        if (snapshot.connected && snapshot.url) {
            urlInput.value = snapshot.url;
        }
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
        firmware.textContent = snapshot.firmware ? `v${snapshot.firmware.version}` : "";
        const badgeName = snapshot.connected ? profileBadge(profileOf(snapshot)) : "";
        profile.textContent = badgeName;
        profile.classList.toggle("hidden", badgeName === "");
        link.setAttribute("data-link", state.link);
        link.textContent = state.link === "open" ? "live" : state.link === "connecting" ? "connecting" : "disconnected";
    }, ["snapshot", "link"]);
}
