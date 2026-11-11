// The G-code device's jog, drawn like this machine's jog panel: a bar per
// axis (X, Y, Z and the nozzle's turn) with its step choices, a step typed
// in beside them, and minus and plus; a jog reads where the device is and
// moves one axis by the step from there. Below: a goto (across at the
// safe height, then Z), the head parked, the nozzle over the up camera,
// and the top camera and the nozzle swapped over the point one of them is
// over. The arrow keys jog X and Y, Page Up and Page Down jog Z, while the
// PNP page places with the device.

import { activePage, button, el, inputHasFocus, lockFor, modalOpen, numberField, onEnter } from "../dom.ts";
import { formatFixed, parseNumber } from "../format.ts";
import type { AppState } from "../state.ts";
import { choiceRow, setPressed, type Ctx } from "./context.ts";
import { infoTip } from "./infotip.ts";

export type DeviceAxis = "x" | "y" | "z" | "rotation";

interface Bar {
    axis: DeviceAxis;
    letter: string;
    title: string;
    unit: string;
    steps: number[];
    start: number;
}

export const DEVICE_BARS: Bar[] = [
    { axis: "x", letter: "X", title: "Head X", unit: "mm", steps: [0.1, 1, 10], start: 1 },
    { axis: "y", letter: "Y", title: "Head Y", unit: "mm", steps: [0.1, 1, 10], start: 1 },
    { axis: "z", letter: "Z", title: "Nozzle Z", unit: "mm", steps: [0.1, 1, 5], start: 1 },
    { axis: "rotation", letter: "A", title: "Nozzle turn", unit: "deg", steps: [1, 15, 90], start: 15 },
];

/** The jog a key asks for while the device jogs: the arrows X and Y, Page Up and Page Down Z. */
export function deviceKey(key: string): { axis: DeviceAxis; sign: 1 | -1 } | null {
    switch (key) {
        case "ArrowLeft":
            return { axis: "x", sign: -1 };
        case "ArrowRight":
            return { axis: "x", sign: 1 };
        case "ArrowUp":
            return { axis: "y", sign: 1 };
        case "ArrowDown":
            return { axis: "y", sign: -1 };
        case "PageUp":
            return { axis: "z", sign: 1 };
        case "PageDown":
            return { axis: "z", sign: -1 };
        default:
            return null;
    }
}

/** Mounts the device's jog in `root`; `active` says when the keys are its. */
export function mountDeviceJog(root: HTMLElement, ctx: Ctx, active: () => boolean): void {
    const picks = new Map<DeviceAxis, number>();
    const typed = new Map<DeviceAxis, number>();
    const stepOf = (bar: Bar): number => typed.get(bar.axis) ?? picks.get(bar.axis) ?? bar.start;
    const locked: HTMLButtonElement[] = [];

    const jog = (bar: Bar, sign: 1 | -1): Promise<unknown> => ctx.call(ctx.api.deviceJog(bar.axis, sign * stepOf(bar)).then((state) => ctx.store.set({ device: state })));

    function barRow(bar: Bar): HTMLDivElement {
        const custom = numberField({ placeholder: "custom", min: 0, width: "6.5rem" });
        custom.setAttribute("aria-label", `${bar.title} step`);
        const format = (value: number): string => `${value} ${bar.unit}`;
        const row = choiceRow(bar.steps, bar.start, (value) => {
            picks.set(bar.axis, value);
            typed.delete(bar.axis);
            custom.value = "";
        }, format);
        custom.addEventListener("input", () => {
            const value = parseNumber(custom.value);
            if (value !== null && value > 0) {
                typed.set(bar.axis, value);
                setPressed(row, "");
            } else {
                typed.delete(bar.axis);
                setPressed(row, format(picks.get(bar.axis) ?? bar.start));
            }
        });
        const minus = button(`${bar.letter}-`, () => jog(bar, -1), "btn btn-axis");
        const plus = button(`${bar.letter}+`, () => jog(bar, 1), "btn btn-axis");
        locked.push(minus, plus);
        return el("div", { class: "axis-bar", "data-axis": `device-${bar.axis}` },
            el("div", { class: "axis-bar-head" },
                el("span", { class: "axis-bar-letter" }, bar.letter),
                el("span", { class: "axis-bar-title" }, bar.title),
            ),
            el("div", { class: "axis-bar-steps" }, row, custom),
            el("div", { class: "axis-bar-buttons" }, minus, plus),
        ) as HTMLDivElement;
    }

    const position = el("p", { class: "muted mono device-jog-position" });
    const gx = numberField({ placeholder: "x" });
    const gy = numberField({ placeholder: "y" });
    const gz = numberField({ placeholder: "z" });
    for (const [field, name] of [[gx, "X"], [gy, "Y"], [gz, "Z"]] as const) {
        field.setAttribute("aria-label", `Device goto ${name}`);
    }
    const go = button("Go", () => goto(), "btn btn-quiet");
    go.title = "X and Y across at the safe height, then down or up to Z";
    for (const field of [gx, gy, gz]) {
        field.addEventListener("keydown", onEnter(go));
    }
    const park = button("Park", () => ctx.call(ctx.api.devicePark().then((state) => ctx.store.set({ device: state }))), "btn btn-quiet");
    park.title = "up to the safe height, then to the profile's park place";
    const overCamera = button("Nozzle over camera", () => ctx.call(ctx.api.deviceOverCamera().then((state) => ctx.store.set({ device: state }))), "btn");
    overCamera.title = "the nozzle over the up camera, turned to 0, at the height it is sharp at";
    const toNozzle = button("Nozzle to camera spot", () => ctx.call(ctx.api.deviceSwap("nozzle").then((state) => ctx.store.set({ device: state }))), "btn");
    toNozzle.title = "the nozzle over the point the top camera looks at";
    const toCamera = button("Camera to nozzle spot", () => ctx.call(ctx.api.deviceSwap("camera").then((state) => ctx.store.set({ device: state }))), "btn");
    toCamera.title = "the top camera over the point the nozzle is over";
    locked.push(go, park, overCamera, toNozzle, toCamera);

    root.append(
        el("div", { class: "stack device-jog" },
            ...DEVICE_BARS.map((bar) => barRow(bar)),
            position,
            el("div", { class: "goto-row" }, el("span", { class: "choice-label" }, "Go to"), gx, gy, gz, go),
            el("div", { class: "button-row" }, park, overCamera, infoTip("upcam")),
            el("div", { class: "button-row" }, toNozzle, toCamera, infoTip("offset")),
            el("p", { class: "muted hint" }, "Arrow keys jog X and Y, Page Up and Page Down jog Z."),
        ),
    );

    async function goto(): Promise<void> {
        const x = parseNumber(gx.value);
        const y = parseNumber(gy.value);
        const z = parseNumber(gz.value);
        if (x === null && y === null && z === null) {
            ctx.toast("error", "enter x, y and/or z");
            return;
        }
        const target: { x?: number; y?: number; z?: number } = {};
        if (x !== null) {
            target.x = x;
        }
        if (y !== null) {
            target.y = y;
        }
        if (z !== null) {
            target.z = z;
        }
        await ctx.call(ctx.api.deviceMove(target).then((state) => ctx.store.set({ device: state })));
    }

    function render(state: AppState): void {
        const device = state.device;
        const busy = device?.running === true || state.pnp?.routine?.state === "running" || device?.top?.routine?.state === "running";
        const idle = device?.connected === true && !busy;
        for (const control of locked) {
            lockFor(control, [device?.connected !== true, "connect the device first"], [!idle, "the device is busy"]);
        }
        const doc = state.deviceDoc?.document;
        lockFor(park, [device?.connected !== true, "connect the device first"], [!idle, "the device is busy"], [!doc?.park, "the profile has no [motion] park"]);
        lockFor(overCamera, [device?.connected !== true, "connect the device first"], [!idle, "the device is busy"], [!device?.camera.position, "the up camera's place is not known yet"]);
        const offsetKnown = (device?.top?.offset ?? null) !== null || (doc?.top?.offset ?? null) !== null;
        lockFor(toNozzle, [device?.connected !== true, "connect the device first"], [!idle, "the device is busy"], [!offsetKnown, "the top camera's offset is not known"]);
        lockFor(toCamera, [device?.connected !== true, "connect the device first"], [!idle, "the device is busy"], [!offsetKnown, "the top camera's offset is not known"]);
        const at = device?.position;
        position.textContent = at
            ? `At X ${formatFixed(at.x ?? 0, 3)} Y ${formatFixed(at.y ?? 0, 3)}${at.z !== undefined ? ` Z ${formatFixed(at.z, 3)}` : ""}${at.rotation !== undefined ? ` A ${formatFixed(at.rotation, 2)}` : ""}`
            : "Position not read yet.";
    }

    // One key jog at a time, as this machine's jog panel does.
    let keyJog: Promise<unknown> | null = null;
    document.addEventListener("keydown", (event) => {
        if (event.defaultPrevented || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.isComposing || modalOpen()) {
            return;
        }
        const action = deviceKey(event.key);
        if (action === null || inputHasFocus() || activePage() !== "pnp" || !active()) {
            return;
        }
        event.preventDefault();
        const state = ctx.store.get();
        if (state.device?.connected && !state.device.running && keyJog === null) {
            const bar = DEVICE_BARS.find((entry) => entry.axis === action.axis)!;
            keyJog = jog(bar, action.sign).finally(() => {
                keyJog = null;
            });
        }
    });

    ctx.store.subscribe((state) => render(state), ["device", "deviceDoc", "pnp"]);
    render(ctx.store.get());
}
