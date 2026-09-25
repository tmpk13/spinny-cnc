// Connection selector, machine state, firmware version and the event link.

import { button, el, replace } from "../dom.ts";
import { profileBadge, profileOf } from "../profile.ts";
import type { Ctx } from "./context.ts";

export function mountStatusBar(root: HTMLElement, ctx: Ctx): void {
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
        el("div", { class: "brand" }, "Spinny laser"),
        el("div", { class: "connection" }, select, urlInput, refresh, connect),
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

    ctx.store.subscribe((state) => {
        const current = select.value;
        replace(
            select,
            el("option", { value: "" }, state.ports.length ? "port..." : "no ports"),
            ...state.ports.map((port) => el("option", { value: port.url }, `${port.url}  ${port.description}`.trim())),
        );
        if (state.ports.some((port) => port.url === current)) {
            select.value = current;
        }
        const first = state.ports[0];
        if (urlInput.value === "" && first && !state.snapshot.connected) {
            urlInput.value = first.url;
            select.value = first.url;
        }
    }, ["ports"]);

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
            stateBadge.textContent = machine.state === "Alarm" ? `Alarm:${machine.alarm ?? "?"}` : machine.state;
            stateBadge.setAttribute("data-state", machine.state);
        }
        firmware.textContent = snapshot.firmware ? `v${snapshot.firmware.version}` : "";
        const name = snapshot.connected ? profileBadge(profileOf(snapshot)) : "";
        profile.textContent = name;
        profile.classList.toggle("hidden", name === "");
        link.setAttribute("data-link", state.link);
        link.textContent = state.link === "open" ? "live" : state.link === "connecting" ? "connecting" : "disconnected";
    }, ["snapshot", "link"]);
}
