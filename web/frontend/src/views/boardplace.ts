// The Board place panel: every way of saying where the board, and so the
// job, sits on the machine, in one panel, from rough to exact: by hand (the
// selected job's offset and turn), by camera (the look for the board, its
// search, corners and features: findboard.ts), by marks (the tool put on
// points of the design: align.ts) and by references (a pick and place
// machine's parts or fiducials: pnprefs.ts). Its head says where the
// selected job is and how it was placed.
//
// A G-code pick and place machine places a board by its references alone,
// which its top camera takes or a part under the nozzle does: the job's
// own offset and the marks of this project's machines say nothing there,
// so those two ways go, and By camera, the way to start from, is open at
// first (elsewhere it is folded until pressed: By hand leads). A fold
// pressed keeps as the operator left it.
//
// Each way is a fold holding a box whose id is the panel it was (`find`,
// `align`, `pnp-refs`), so links and steps naming those still find it, and
// the view that fills the box is the one that always did. Once the views
// have drawn, `finish` takes their own titles away: what else their heads
// held (a badge, a setup count, a note) joins the fold's summary.

import { el, readStored, writeStored } from "../dom.ts";
import { formatFixed } from "../format.ts";
import type { AppState } from "../state.ts";
import type { Ctx } from "./context.ts";
import { gcodePlacing } from "./placing.ts";

/** The ways a G-code pick and place machine has no use for. */
const NOT_GCODE: ReadonlySet<string> = new Set(["hand", "align"]);

/** Whether a way's fold is open before the operator has pressed it: as the list says, and By camera with a G-code machine. */
export function openAtFirst(way: (typeof PLACE_WAYS)[number], state: AppState): boolean {
    return way.key === "find" ? gcodePlacing(state) : way.open;
}

/** The ways to place the board, in the panel's order: the key, the box's id, the fold's title, open at first or not. */
export const PLACE_WAYS = [
    { key: "hand", id: "board-hand", title: "By hand", open: true },
    { key: "find", id: "find", title: "By camera", open: false },
    { key: "align", id: "align", title: "By marks", open: false },
    { key: "refs", id: "pnp-refs", title: "By references", open: true },
] as const;

export type PlaceWay = (typeof PLACE_WAYS)[number]["key"];

export interface BoardPlace {
    /** The box each way's view is mounted in. */
    parts: Record<PlaceWay, HTMLElement>;
    /** Takes the views' own titles away, once they have drawn. */
    finish(): void;
}

/** Where the selected job is and what placed it, in a line; empty with no job. */
export function placeLine(state: AppState): string {
    const job = state.job;
    if (!job) {
        return "no job selected";
    }
    const words = [`X ${formatFixed(job.offset.x, 2)} Y ${formatFixed(job.offset.y, 2)} mm`];
    const turned = job.rotation ?? 0;
    if (turned !== 0) {
        words.push(`turned ${formatFixed(turned, 2)} deg`);
    }
    const align = state.align;
    if (align && align.job === job.id && align.marks.length > 0) {
        words.push(`${align.marks.length} ${align.marks.length === 1 ? "mark" : "marks"} taken`);
    }
    const looks = [state.camera?.board_look, state.placing?.top?.board_look];
    if (looks.some((look) => look?.job === job.id && (look.estimate ?? null) !== null)) {
        words.push("seen by a camera");
    }
    return words.join(", ");
}

/** The children of `node` that are `tag` elements or carry the class `name`; happy-dom's `:scope` finds none. */
function childrenOf(node: Element, test: (child: Element) => boolean): HTMLElement[] {
    return Array.from(node.children).filter((child): child is HTMLElement => test(child));
}

/** The panel in `root`, with a fold and an empty box for each way. */
export function mountBoardPlace(root: HTMLElement, ctx: Ctx): BoardPlace {
    const line = el("span", { class: "muted place-line" });
    root.append(el("div", { class: "panel-head" }, el("h2", {}, "Board place"), line));
    const parts = {} as Record<PlaceWay, HTMLElement>;
    const extras = {} as Record<PlaceWay, HTMLElement>;
    const folds = {} as Record<PlaceWay, HTMLDetailsElement>;
    const keyOf = (way: PlaceWay): string => `spinny.place.${way}`;
    for (const way of PLACE_WAYS) {
        const box = el("div", { id: way.id, class: "place-part stack" });
        const extra = el("span", { class: "place-extras" });
        const summary = el("summary", { title: "fold or unfold" }, el("h3", {}, way.title), extra);
        const fold = el("details", { class: "place-way stack", open: (readStored(keyOf(way.key)) ?? (openAtFirst(way, ctx.store.get()) ? "1" : "0")) === "1" },
            summary,
            box,
        ) as HTMLDetailsElement;
        // Kept when the operator folds it, not when the machine's kind does:
        // a fold standing as it would at first, with nothing kept yet, is
        // the page's own doing.
        fold.addEventListener("toggle", () => {
            if (readStored(keyOf(way.key)) !== null || fold.open !== openAtFirst(way, ctx.store.get())) {
                writeStored(keyOf(way.key), fold.open ? "1" : "0");
            }
        });
        root.append(fold);
        parts[way.key] = box;
        extras[way.key] = extra;
        folds[way.key] = fold;
    }

    // A way whose view hides its box (references with no pick and place
    // machine) takes its fold with it: the stylesheet, by :has.
    const render = (state: AppState): void => {
        line.textContent = placeLine(state);
        const gcode = gcodePlacing(state);
        for (const way of PLACE_WAYS) {
            folds[way.key].classList.toggle("hidden", gcode && NOT_GCODE.has(way.key));
            if (readStored(keyOf(way.key)) === null) {
                folds[way.key].open = openAtFirst(way, state);
            }
        }
    };
    ctx.store.subscribe(render, ["job", "align", "camera", "placing", "snapshot"]);

    function finish(): void {
        for (const way of PLACE_WAYS) {
            const box = parts[way.key];
            // A head of the view's own: its title goes, the rest joins the summary.
            for (const head of childrenOf(box, (child) => child.classList.contains("panel-head"))) {
                extras[way.key].append(...childrenOf(head, (child) => child.tagName !== "H2"));
                head.remove();
            }
            // A fold of the view's own (Align's): its summary's extras join
            // the summary, its body stays in the box, the fold goes.
            for (const fold of childrenOf(box, (child) => child instanceof HTMLDetailsElement)) {
                const [summary, ...body] = Array.from(fold.children);
                if (summary?.tagName === "SUMMARY") {
                    extras[way.key].append(...childrenOf(summary, (child) => child.tagName !== "H2"));
                    fold.replaceWith(...body);
                }
            }
        }
        render(ctx.store.get());
    }
    render(ctx.store.get());
    return { parts, finish };
}
