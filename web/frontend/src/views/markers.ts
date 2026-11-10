// Markers: named positions on the board, saved where the head is or typed,
// listed with a button to go back to each, drawn on every preview, and
// offered to the Plot page's corners, centers and points. The backend keeps
// them, so every page and browser has the same ones.

import { button, el, labeled, numberField, replace, setLocked } from "../dom.ts";
import { formatMm, parseNumber } from "../format.ts";
import type { AppState } from "../state.ts";
import type { Board, Marker } from "../types.ts";
import type { Ctx } from "./context.ts";

/** The first name of the form M1, M2, ... that no marker has yet. */
export function nextMarkerName(markers: Marker[]): string {
    const taken = new Set(markers.map((marker) => marker.name));
    for (let n = 1; ; n++) {
        const name = `M${n}`;
        if (!taken.has(name)) {
            return name;
        }
    }
}

/** The list with a marker put in: one of the same name is moved, else it is added at the end. */
export function withMarker(markers: Marker[], marker: Marker): Marker[] {
    const at = markers.findIndex((other) => other.name === marker.name);
    if (at < 0) {
        return [...markers, marker];
    }
    return markers.map((other, index) => (index === at ? marker : other));
}

/** Where the head is over the board, from the latest report; null with no machine. */
export function headPosition(state: AppState): Board | null {
    const board = state.snapshot.connected ? state.snapshot.machine?.board : null;
    return board ? { x: board.x, y: board.y } : null;
}

/** Where the head is over the board now; with no machine, null after a toast that says to connect one. */
export function headOrSay(ctx: Ctx): Board | null {
    const head = headPosition(ctx.store.get());
    if (!head) {
        ctx.toast("error", "no head position: connect the machine first");
    }
    return head;
}

/** A select of the markers that hands the one picked to `onPick` and goes back to its prompt. */
export function markerPicker(ctx: Ctx, prompt: string, onPick: (marker: Marker) => void): HTMLSelectElement {
    const select = el("select", { class: "field marker-pick", "aria-label": prompt, title: "take the position of a marker" }) as HTMLSelectElement;
    const fill = (markers: Marker[]): void => {
        replace(select,
            el("option", { value: "" }, prompt),
            ...markers.map((marker) => el("option", { value: marker.name }, marker.name)),
        );
        select.disabled = markers.length === 0;
    };
    select.addEventListener("change", () => {
        const marker = ctx.store.get().markers.find((other) => other.name === select.value);
        select.value = "";
        if (marker) {
            onPick(marker);
        }
    });
    fill(ctx.store.get().markers);
    ctx.store.subscribe((state) => fill(state.markers), ["markers"]);
    return select;
}

export function mountMarkers(root: HTMLElement, ctx: Ctx): void {
    const name = el("input", { type: "text", class: "field", placeholder: "name", spellcheck: "false", "aria-label": "Marker name" }) as HTMLInputElement;
    name.maxLength = 40;
    const x = numberField({ placeholder: "x", width: "5.5rem" });
    const y = numberField({ placeholder: "y", width: "5.5rem" });
    x.setAttribute("aria-label", "Marker x");
    y.setAttribute("aria-label", "Marker y");
    const here = button("Mark here", () => markHere(), "btn btn-primary btn-small");
    here.title = "save where the head is over the board, under the name typed or the next M number";
    const add = button("Add", () => addTyped(), "btn btn-quiet btn-small");
    add.title = "save the x and y typed";
    const list = el("ul", { class: "marker-list" });
    root.append(
        el("div", { class: "panel-head" }, el("h2", {}, "Markers"), el("div", { class: "button-row" }, here)),
        el("div", { class: "marker-add" }, labeled("Name", name), labeled("X", x), labeled("Y", y), add),
        list,
        el("p", { class: "muted hint" }, "a name used again moves that marker; Go rises to the travel height before going across"),
    );

    async function save(markers: Marker[]): Promise<boolean> {
        const kept = await ctx.call(ctx.api.setMarkers(markers));
        if (kept) {
            ctx.store.set({ markers: kept });
            return true;
        }
        return false;
    }

    function typedName(markers: Marker[]): string {
        return name.value.trim() || nextMarkerName(markers);
    }

    async function markHere(): Promise<void> {
        const head = headOrSay(ctx);
        if (!head) {
            return;
        }
        const state = ctx.store.get();
        const marker = { name: typedName(state.markers), x: round(head.x), y: round(head.y) };
        if (await save(withMarker(state.markers, marker))) {
            name.value = "";
            ctx.toast("info", `marked ${marker.name} at ${formatMm(marker.x)}, ${formatMm(marker.y)}`);
        }
    }

    async function addTyped(): Promise<void> {
        const mx = parseNumber(x.value);
        const my = parseNumber(y.value);
        if (mx === null || my === null) {
            ctx.toast("error", "a marker needs an x and a y");
            return;
        }
        const markers = ctx.store.get().markers;
        if (await save(withMarker(markers, { name: typedName(markers), x: mx, y: my }))) {
            name.value = "";
            x.value = "";
            y.value = "";
        }
    }

    async function goTo(marker: Marker): Promise<void> {
        await ctx.call(ctx.api.goto({ kind: "board", x: marker.x, y: marker.y }));
    }

    async function moveHere(marker: Marker): Promise<void> {
        const head = headOrSay(ctx);
        if (!head) {
            return;
        }
        await save(withMarker(ctx.store.get().markers, { ...marker, x: round(head.x), y: round(head.y) }));
    }

    async function remove(marker: Marker): Promise<void> {
        await save(ctx.store.get().markers.filter((other) => other.name !== marker.name));
    }

    // Drawn again when the list or the link changes, not at the rate the
    // position comes in: a button rebuilt under the pointer loses its click.
    let drawn: { markers: Marker[]; connected: boolean } | null = null;
    function render(state: AppState): void {
        const connected = state.snapshot.connected;
        if (drawn && drawn.markers === state.markers && drawn.connected === connected) {
            return;
        }
        drawn = { markers: state.markers, connected };
        setLocked(here, !connected);
        replace(list, ...state.markers.map((marker) => {
            const go = button("Go", () => goTo(marker), "btn btn-quiet btn-small");
            go.title = `go to ${marker.name}`;
            setLocked(go, !connected);
            const moved = button("Here", () => moveHere(marker), "btn btn-quiet btn-small");
            moved.title = `move ${marker.name} to where the head is`;
            setLocked(moved, !connected);
            return el("li", {},
                el("span", { class: "marker-name" }, marker.name),
                el("span", { class: "mono muted" }, `${formatMm(marker.x)}, ${formatMm(marker.y)}`),
                el("span", { class: "button-row" }, go, moved, button("Delete", () => remove(marker), "btn btn-quiet btn-small")),
            );
        }));
        if (state.markers.length === 0) {
            list.append(el("li", { class: "muted" }, "no markers yet"));
        }
    }

    ctx.store.subscribe((state) => render(state), ["markers", "snapshot"]);
    render(ctx.store.get());
}

/** A position to the micron, as a marker keeps it. */
function round(value: number): number {
    return Math.round(value * 1000) / 1000;
}
