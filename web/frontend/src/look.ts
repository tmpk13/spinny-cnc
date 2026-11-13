// How the page looks, as the page settings set it and this browser keeps
// it: the page's own fonts (Inter and JetBrains Mono, served with the
// page) or the system's, and whether things move as they change (panels
// unfolding, a stack's panel coming forward, menus and sheets opening,
// pages coming in) or simply appear. Both are attributes on the root
// element the stylesheet switches on; the system's reduced motion setting
// stops the movement too, whatever is picked here.

import { readStored, writeStored } from "./dom.ts";
import { readObject } from "./layout.ts";

export const LOOK_KEY = "spinny.look";

export interface Look {
    /** The page's own fonts, or the system's. */
    fonts: "page" | "system";
    /** Whether changes move into place or simply appear. */
    motion: "on" | "off";
}

/** The look in stored text; anything missing or malformed is the page's fonts, moving. */
export function parseLook(text: string | null): Look {
    const raw = readObject(text);
    return {
        fonts: raw["fonts"] === "system" ? "system" : "page",
        motion: raw["motion"] === "off" ? "off" : "on",
    };
}

export function readLook(): Look {
    return parseLook(readStored(LOOK_KEY));
}

/** Puts the look on the root element: `data-fonts="system"`, `data-motion="off"`, or neither. */
export function applyLook(look: Look, root: HTMLElement = document.documentElement): void {
    if (look.fonts === "system") {
        root.setAttribute("data-fonts", "system");
    } else {
        root.removeAttribute("data-fonts");
    }
    if (look.motion === "off") {
        root.setAttribute("data-motion", "off");
    } else {
        root.removeAttribute("data-motion");
    }
}

/** Keeps the look in this browser and puts it on the page. */
export function writeLook(look: Look): void {
    writeStored(LOOK_KEY, JSON.stringify(look));
    applyLook(look);
}

/**
 * Whether the page moves things into place now: not when the look says
 * still, nor when the system asks for reduced motion. The layout layer
 * asks before it marks a panel to come in, so a still page is not left
 * waiting for an animation that never runs.
 */
export function moving(root: HTMLElement = document.documentElement): boolean {
    if (root.getAttribute("data-motion") === "off") {
        return false;
    }
    try {
        return !(globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
    } catch {
        return true;
    }
}
