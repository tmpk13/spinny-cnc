// The Connection tab's panel: the port picked from the ports found (or a
// url typed), Ports to list them again, Connect and Disconnect, the
// built-in ports left out of the list, and one button per machine
// connected lately, which switches to it in one press: the machine
// connected now is let go first, as only one is connected at a time. A
// port a G-code machine file claims is named after that machine and opens
// as it. The top bar shows the state only; a press on it opens this tab.

import { button, el, readStored, replace, setLocked, writeStored } from "../dom.ts";
import type { Port } from "../types.ts";
import type { Ctx } from "./context.ts";
import { defaultPort, machineOfPort, PORT_POLL_MS, portLabel, visiblePorts } from "./statusbar.ts";

const HIDE_SYSTEM_KEY = "spinny.hideSystemPorts";
const RECENT_KEY = "spinny.recent";
/** How many machines connected lately keep a button. */
export const RECENT_COUNT = 4;

/** A machine connected lately: where, as which G-code machine file (null: this project's firmware), and its name. */
export interface Recent {
    url: string;
    machine: string | null;
    label: string;
}

/** The machines connected lately, newest first, read safely. */
export function readRecent(text: string | null): Recent[] {
    try {
        const raw: unknown = JSON.parse(text ?? "[]");
        if (!Array.isArray(raw)) {
            return [];
        }
        return raw
            .filter((entry): entry is Recent => typeof entry === "object" && entry !== null && typeof entry.url === "string" && entry.url !== "" && typeof entry.label === "string")
            .map((entry) => ({ url: entry.url, machine: typeof entry.machine === "string" ? entry.machine : null, label: entry.label }))
            .slice(0, RECENT_COUNT);
    } catch {
        return [];
    }
}

/** `entry` put first, any older entry for its url dropped, at most RECENT_COUNT kept. */
export function rememberRecent(recent: Recent[], entry: Recent): Recent[] {
    return [entry, ...recent.filter((other) => other.url !== entry.url)].slice(0, RECENT_COUNT);
}

/** What a machine connected at `url` is called on its button: the G-code machine's name, the port's name, else the url. */
export function recentLabel(ports: Port[], url: string, profileName: string | null): string {
    if (profileName) {
        return profileName;
    }
    const port = ports.find((entry) => entry.url === url || entry.device === url);
    return port?.product || port?.description || url;
}

function readHideSystem(): boolean {
    const stored = readStored(HIDE_SYSTEM_KEY);
    return stored === null ? true : stored === "1";
}

export function mountConnection(root: HTMLElement, ctx: Ctx): void {
    let hideSystem = readHideSystem();
    const hideBox = el("input", { type: "checkbox", class: "hide-system", "aria-label": "Hide system ports" }) as HTMLInputElement;
    hideBox.checked = hideSystem;
    const hideLabel = el("label", { class: "muted hide-system-label", title: "Hide built-in serial ports; they are never the controller" }, hideBox, " hide system ports");
    hideBox.addEventListener("change", () => {
        hideSystem = hideBox.checked;
        writeStored(HIDE_SYSTEM_KEY, hideSystem ? "1" : "0");
        renderPorts(ctx.store.get().ports);
    });
    const select = el("select", { class: "field", "aria-label": "Serial port", title: "the ports found; a machine file's port is named after it" });
    const urlInput = el("input", {
        type: "text",
        class: "field url",
        placeholder: "/dev/ttyACM0 or socket://host:port",
        "aria-label": "Port url",
        autocomplete: "off",
        title: "a port or a socket url; picked from the list or typed",
    });
    const refresh = button("Ports", () => ctx.refreshPorts(), "btn btn-quiet");
    refresh.title = "list the ports again";
    const connect = button("Connect", () => toggle());
    const recentRow = el("div", { class: "button-row connection-recent" });
    const recentHead = el("h3", {}, "Switch to");
    const detail = el("p", { class: "muted connection-detail" });
    root.append(
        el("div", { class: "panel-head" }, el("h2", {}, "Connection")),
        el("div", { class: "panel-body" },
            el("div", { class: "button-row connection" }, select, urlInput, refresh, connect),
            el("div", { class: "button-row" }, hideLabel),
            detail,
            recentHead,
            recentRow,
            el("p", { class: "muted hint" }, "One machine at a time: switching lets the one connected go first."),
        ),
    );

    select.addEventListener("change", () => {
        urlInput.value = select.value;
    });

    /** Connects to `url` as `machine`, and remembers it for its button. */
    async function open(url: string, machine: string | null): Promise<boolean> {
        const next = await ctx.call(ctx.api.connect(url, machine));
        if (!next) {
            return false;
        }
        ctx.store.set({ snapshot: next });
        if (next.connected) {
            const label = recentLabel(ctx.store.get().ports, url, next.profile?.controller === "gcode" ? next.profile.name ?? null : null);
            writeStored(RECENT_KEY, JSON.stringify(rememberRecent(readRecent(readStored(RECENT_KEY)), { url, machine, label })));
            await ctx.refreshSettings();
            renderRecent();
        }
        return next.connected;
    }

    async function close(): Promise<boolean> {
        const next = await ctx.call(ctx.api.disconnect());
        if (next) {
            ctx.store.set({ snapshot: next });
        }
        return next ? !next.connected : false;
    }

    async function toggle(): Promise<void> {
        if (ctx.store.get().snapshot.connected) {
            await close();
            return;
        }
        const url = urlInput.value.trim() || select.value;
        if (!url) {
            ctx.toast("error", "pick a port or type a url");
            return;
        }
        await open(url, machineOfPort(ctx.store.get().ports, url));
    }

    /** One press to the machine of a button: the one connected let go first. */
    async function switchTo(entry: Recent): Promise<void> {
        const snapshot = ctx.store.get().snapshot;
        if (snapshot.connected && snapshot.url === entry.url) {
            return;
        }
        if (snapshot.connected && !(await close())) {
            return;
        }
        urlInput.value = entry.url;
        await open(entry.url, entry.machine);
    }

    function renderRecent(): void {
        const recent = readRecent(readStored(RECENT_KEY));
        const snapshot = ctx.store.get().snapshot;
        recentHead.classList.toggle("hidden", recent.length === 0);
        recentRow.classList.toggle("hidden", recent.length === 0);
        replace(recentRow, ...recent.map((entry) => {
            const here = snapshot.connected && snapshot.url === entry.url;
            const press = button(entry.label, () => switchTo(entry), "btn btn-big btn-toggle");
            press.setAttribute("aria-pressed", String(here));
            press.title = here ? `connected: ${entry.url}` : snapshot.connected ? `disconnect, then connect ${entry.url}` : `connect ${entry.url}`;
            return press;
        }));
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
        connect.textContent = snapshot.connected ? "Disconnect" : "Connect";
        connect.title = snapshot.connected ? "let the machine go" : "open the port";
        connect.classList.toggle("btn-primary", !snapshot.connected);
        urlInput.disabled = snapshot.connected;
        select.disabled = snapshot.connected;
        setLocked(refresh, snapshot.connected, "disconnect first");
        if (snapshot.connected && snapshot.url) {
            urlInput.value = snapshot.url;
        }
        const name = snapshot.profile?.controller === "gcode" ? snapshot.profile.name ?? "a G-code machine" : "this project's firmware";
        const firmware = snapshot.firmware ? `, ${snapshot.firmware.name ?? `v${snapshot.firmware.version}`}` : "";
        detail.textContent = snapshot.connected ? `Connected to ${snapshot.url ?? "?"} as ${name}${firmware}.` : "Not connected.";
        renderRecent();
    }, ["snapshot"]);
    renderRecent();
}
