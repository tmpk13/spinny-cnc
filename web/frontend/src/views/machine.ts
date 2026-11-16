// The Machine panel: one panel for the machine's controls where four stood
// before (Position, Jog, Laser, Markers). Where the head is, the jog with
// its buttons in the panel's head, the tool's quick buttons (the beam's
// test and off, or the spindle's start and stop), a box a pick and place
// head's own quick buttons go in, and the markers folded at the foot. Each
// part is the view it always was, mounted in a box of its own whose id is
// the old panel's, so links and steps that name `jog` or `markers` still
// find it; the parts' own titles give way to the panel's.

import { el } from "../dom.ts";
import type { Ctx } from "./context.ts";
import { mountDro } from "./dro.ts";
import { mountJog } from "./jog.ts";
import { mountLaser } from "./laser.ts";
import { mountMarkers } from "./markers.ts";

/** The ids the parts' boxes take: the panels they were. */
export interface MachineParts {
    dro: string;
    jog: string;
    laser: string;
    markers: string;
}

export interface MachinePanel {
    /** The box for the pick and place head's quick buttons, under the tool's. */
    head: HTMLElement;
    /** The jog's box, for rows other panels lend it or take from it. */
    jog: HTMLElement;
}

/** The children of `node` with the class `name`; happy-dom's `:scope` finds none. */
function childrenWith(node: Element, name: string): HTMLElement[] {
    return Array.from(node.children).filter((child): child is HTMLElement => child.classList.contains(name));
}

/**
 * Mounts the Machine panel in `root` for the page `page`, whose arrow keys
 * the jog answers while that page shows. `ids` names the parts' boxes.
 */
export function mountMachine(root: HTMLElement, ctx: Ctx, page: string, ids: MachineParts): MachinePanel {
    const part = (id: string, name: string): HTMLElement => el("div", { id, class: "machine-part stack", "data-part": name });
    const dro = part(ids.dro, "position");
    // The position's styles, and its glow while the beam is on, hang on this class.
    dro.classList.add("dro");
    const jog = part(ids.jog, "jog");
    const tool = part(ids.laser, "tool");
    const head = el("div", { class: "machine-part machine-head stack hidden", "data-part": "head" });
    const markers = part(ids.markers, "markers");
    const markersFold = el("details", { class: "machine-markers stack" }, el("summary", { title: "fold or unfold" }, "Markers"), markers);
    const title = el("div", { class: "panel-head" }, el("h2", {}, "Machine"));
    root.append(title, dro, jog, tool, head, markersFold);
    mountDro(dro, ctx);
    mountJog(jog, ctx, page);
    mountLaser(tool, ctx);
    mountMarkers(markers, ctx);

    // The parts' own heads: their titles go (the panel's names them all),
    // and what else they held joins the panel's head: the position's age,
    // the jog's Fine, Hold to move and Cancel.
    for (const box of [dro, jog]) {
        for (const own of childrenWith(box, "panel-head")) {
            for (const child of Array.from(own.children)) {
                if (child.tagName !== "H2") {
                    title.append(child);
                }
            }
            own.remove();
        }
    }
    // The tool's bare title, and the markers' title (the fold's summary names them).
    for (const bare of Array.from(tool.children).filter((child) => child.tagName === "H2")) {
        bare.remove();
    }
    for (const own of childrenWith(markers, "panel-head")) {
        for (const h2 of Array.from(own.children).filter((child) => child.tagName === "H2")) {
            h2.remove();
        }
    }
    return { head, jog };
}
