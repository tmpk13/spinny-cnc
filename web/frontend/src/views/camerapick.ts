// The list a camera's device is picked from: the cameras the backend finds
// attached (the V4L2 cameras on its computer, and the streams a Pi sends to
// the ports the relay forwards). They are listed when the panel comes into
// view and on Detect, not on a timer: every look at a forwarded port with
// no camera behind it makes the relay's ssh print a refused channel. A
// pick fills the Device, Size and fps fields as if typed, so they count as
// not applied until Apply or Start sends them; the Device field still takes
// any device by hand.

import { button, el, labeled, replace } from "../dom.ts";
import { countText, parseNumber } from "../format.ts";
import type { AppState } from "../state.ts";
import type { CamerasResponse, DetectedCamera } from "../types.ts";
import type { Ctx } from "./context.ts";

/** A listing younger than this is kept when a panel comes into view, ms. */
export const DETECT_FRESH_MS = 10_000;
/** How often a panel checks whether it has come into view, ms. */
export const VIEW_TICK_MS = 1_000;
/** The size a pick takes when the camera does not have the one set and has this. */
export const PREFERRED_SIZE = "1280x720";

/** The camera a device setting names, by any of the names that reach it. */
export function cameraOf(cameras: DetectedCamera[], device: string): DetectedCamera | null {
    const wanted = device.trim();
    if (wanted === "") {
        return null;
    }
    return cameras.find((camera) => camera.device === wanted || camera.names.includes(wanted)) ?? null;
}

function area(size: string): number {
    const [width, height] = size.split("x").map(Number);
    return (width ?? 0) * (height ?? 0);
}

/**
 * The size and rate a pick fills in: the size set when the camera has it,
 * else 1280x720 when it has that, else its largest below that, else its
 * smallest; the rate set, unless the camera gives less at that size. A
 * camera that names no modes keeps both.
 */
export function pickMode(camera: DetectedCamera, size: string, fps: number): { size: string; fps: number } {
    const modes = camera.modes;
    if (modes.length === 0) {
        return { size, fps };
    }
    const limit = area(PREFERRED_SIZE);
    // The modes come largest first.
    const mode = modes.find((each) => each.size === size)
        ?? modes.find((each) => each.size === PREFERRED_SIZE)
        ?? modes.find((each) => area(each.size) <= limit)
        ?? modes[modes.length - 1]!;
    const top = Math.floor(mode.fps);
    return { size: mode.size, fps: top >= 1 && fps > top ? top : fps };
}

/** What the list says of a camera: what it is, a stream's size and signal, whether the other camera is set to it, then the device. */
export function cameraLabel(camera: DetectedCamera, otherLabel: string | null): string {
    const words = [camera.name];
    if (camera.kind === "stream" && camera.modes[0]) {
        words.push(camera.modes[0].size);
    }
    if (camera.online === false) {
        words.push("no signal");
    }
    if (otherLabel) {
        words.push(`set as the ${otherLabel}`);
    }
    return `${words.join(", ")}  ${camera.device}`;
}

/** The line under the list: how many were found, whether the device set is one of them, and what kept some from being looked for. */
export function foundText(listing: CamerasResponse | null, device: string): string {
    if (!listing) {
        return "Looking for cameras...";
    }
    const count = listing.cameras.length;
    const words: string[] = [];
    if (count === 0) {
        words.push("No camera found: plug one in and press Detect, or type a device.");
    } else {
        const set = device.trim();
        const missing = set !== "" && cameraOf(listing.cameras, set) === null;
        words.push(`${countText(count, "camera", "cameras")} found${missing ? `; ${set} is not one of them` : ""}.`);
    }
    words.push(...listing.problems);
    return words.join(" ");
}

function rate(fps: number): string {
    return String(Math.round(fps * 100) / 100);
}

// A listing under way, and when one was last asked for, per store: the
// three camera panels (the head camera's, the up camera's and the G-code
// device's top camera's) share one list.
const listing = new WeakSet<object>();
const tried = new WeakMap<object, number>();

/** Lists the cameras into the store. Asked for by a press, a failure is a toast; asked for by a panel coming into view, it waits for the next. */
export async function detectCameras(ctx: Ctx, pressed: boolean): Promise<void> {
    if (!pressed && listing.has(ctx.store)) {
        return;
    }
    listing.add(ctx.store);
    tried.set(ctx.store, Date.now());
    try {
        const found = pressed ? await ctx.call(ctx.api.cameras()) : await ctx.api.cameras().catch(() => undefined);
        if (found) {
            ctx.store.set({ cameras: { ...found, at: Date.now() } });
        }
    } finally {
        listing.delete(ctx.store);
    }
}

export interface CameraPickOptions {
    /** The fields a pick fills, as if typed. */
    device: HTMLInputElement;
    size: HTMLInputElement;
    fps: HTMLInputElement;
    /** What the other camera is called, and the device it is set to. */
    otherLabel: string;
    otherDevice(state: AppState): string | null;
    /** Whether the panel is in view. */
    visible(): boolean;
}

export interface CameraPick {
    /** The list and the Detect button, for the panel to place. */
    row: HTMLElement;
    /** The line on what was found, for the panel to place. */
    note: HTMLElement;
    /** Draws the list again if the device set or the listing changed. */
    render(): void;
    /** Stops looking at the view: when the page goes (pagehide), and in tests, which mount and leave. */
    stop(): void;
}

export function mountCameraPick(ctx: Ctx, options: CameraPickOptions): CameraPick {
    const select = el("select", { class: "field camera-pick-list", "aria-label": "Detected cameras" }) as HTMLSelectElement;
    const detect = button("Detect", () => detectCameras(ctx, true), "btn btn-quiet");
    detect.title = "list attached cameras again";
    const row = el("div", { class: "button-row camera-pick" }, labeled("Camera", select, "labeled inline camera-pick-label"), detect);
    const note = el("p", { class: "muted camera-found" });
    options.device.title = "/dev/video0, http://host:2325/snapshot, socket://host:port (pcbv), or a picture or folder";

    const fill = (field: HTMLInputElement, value: string): void => {
        if (field.value !== value) {
            field.value = value;
            field.dispatchEvent(new Event("input", { bubbles: true }));
        }
    };
    select.addEventListener("change", () => {
        const camera = ctx.store.get().cameras?.cameras.find((each) => each.device === select.value);
        if (!camera) {
            return;
        }
        const mode = pickMode(camera, options.size.value.trim() || PREFERRED_SIZE, parseNumber(options.fps.value) ?? 30);
        fill(options.device, camera.device);
        fill(options.size, mode.size);
        fill(options.fps, String(mode.fps));
        render();
    });
    options.device.addEventListener("input", () => render());

    // Drawn again only when something it shows changed: a list rebuilt
    // under the pointer would close it.
    let drawn = "";
    function render(): void {
        const state = ctx.store.get();
        const listed = state.cameras;
        const otherDevice = options.otherDevice(state);
        const key = JSON.stringify([listed?.at ?? null, otherDevice, options.device.value]);
        if (key === drawn) {
            return;
        }
        drawn = key;
        const cameras = listed?.cameras ?? [];
        const other = otherDevice ? cameraOf(cameras, otherDevice) : null;
        const current = cameraOf(cameras, options.device.value);
        replace(select,
            el("option", { value: "" }, listed === null ? "looking..." : cameras.length > 0 ? "pick a camera" : "none found"),
            ...cameras.map((camera) => el("option", { value: camera.device }, cameraLabel(camera, camera === other ? options.otherLabel : null))),
        );
        select.value = current?.device ?? "";
        note.textContent = foundText(listed, options.device.value);
        options.size.title = current && current.modes.length > 0
            ? `${current.name} gives ${current.modes.map((mode) => mode.fps > 0 ? `${mode.size} at ${rate(mode.fps)} fps` : mode.size).join(", ")}`
            : "";
    }

    // Listed when the panel comes into view, unless another panel just did.
    let inView = false;
    const look = (): void => {
        const now = options.visible();
        if (now && !inView) {
            const last = Math.max(ctx.store.get().cameras?.at ?? 0, tried.get(ctx.store) ?? 0);
            if (Date.now() - last >= DETECT_FRESH_MS) {
                void detectCameras(ctx, false);
            }
        }
        inView = now;
    };
    const timer = setInterval(look, VIEW_TICK_MS);
    // The first look waits for the panel around the list to be built.
    const first = setTimeout(look, 0);
    const unsubscribe = ctx.store.subscribe(() => render(), ["cameras", "camera", "pnp"]);
    render();
    return {
        row,
        note,
        render,
        stop() {
            clearInterval(timer);
            clearTimeout(first);
            unsubscribe();
        },
    };
}
