// The bar across the top of each side's pane that lists the views of the
// area shown (src/views/areaviews.ts) and shows one of them. Steps are
// drawn as numbered circles joined by a line, done ones ticked, with one
// line under them saying what is so in the step shown, and Back and Next;
// other views as plain tabs. All panels, at the bar's end, shows the area
// whole, as the operator arranged it.
//
// Which view an area shows: a view pressed stays until another is; until
// one is pressed, a stepped area follows the work (the first step a run
// needs that is not done), so it opens where things stand and moves on
// when a step's own action completes it. All panels, and a plain area's
// view, are remembered per browser; a step is not, since where the work
// stands is read from the state each time.
//
// A panel a view keeps out of sight that has to be seen (a link, a setup
// step, the search going to it) brings up the first view that holds it,
// else All panels.

import { button, el, readStored, replace, svgIcon, writeStored } from "../dom.ts";
import { readObject } from "../layout.ts";
import type { Side } from "../sides.ts";
import type { AppState } from "../state.ts";
import { ALL_VIEW, isSteps, stepToOpen, VIEW_ONLY, viewHolding, viewPanels, viewsOf, type AreaView } from "./areaviews.ts";
import type { Ctx } from "./context.ts";
import { onPanelOutOfView, showPanelView } from "./panels.ts";
import { onPage, onSides, pageNamed, shownOn, type PageId } from "./tabs.ts";

/** The view each area shows, by page, as this browser remembers it. */
export const VIEWS_KEY = "spinny.views";

/** A tick, for a step done. */
const TICK = "M6.4 11.6 L2.9 8.1 L4.1 6.9 L6.4 9.2 L11.9 3.7 L13.1 4.9 Z";

export type StepMark = "done" | "now" | "todo" | "optional";

/** How a step is drawn: the one shown, one done, one a run can do without, or one still to do. */
export function stepMark(view: AreaView, shown: boolean): StepMark {
    if (shown) {
        return "now";
    }
    if (view.step?.done) {
        return "done";
    }
    return view.step?.optional ? "optional" : "todo";
}

let mounted: ViewBars | null = null;

/** Shows a view of an area, as a press on its tab does; nothing where the bars are not mounted (the tests of single views). */
export function showAreaView(page: PageId, view: string): void {
    mounted?.show(page, view);
}

export interface ViewBars {
    /** Shows a view of an area, as a press on its tab does. */
    show(page: PageId, view: string): void;
    /** The id of the view an area shows; null for an area with no views. */
    shown(page: PageId): string | null;
}

interface Built {
    page: PageId;
    ids: string;
    tabs: Map<string, { item: HTMLElement; press: HTMLButtonElement; dot: HTMLElement }>;
    title: HTMLElement;
    tag: HTMLElement;
    say: HTMLElement;
    back: HTMLButtonElement;
    next: HTMLButtonElement;
    all: HTMLButtonElement;
}

/**
 * Mounts the view bars: `bars` holds each side's bar element, the first
 * child of its pane. The layout layer has to be mounted first, as a view
 * is put on the page through it.
 */
export function mountViewBars(ctx: Ctx, bars: Record<Side, HTMLElement>): ViewBars {
    const picked = new Map<PageId, { id: string; byHand: boolean }>();
    const kept = readObject(readStored(VIEWS_KEY));
    const built: Partial<Record<Side, Built>> = {};

    const has = (views: AreaView[], id: string): boolean => id === ALL_VIEW || views.some((view) => view.id === id);

    /**
     * The views an area lists now. Steps are all listed: they are the
     * order of the work. Of plain views, only the ones with a panel the
     * machine connected has: a view whose panels their own views all hide
     * (a top camera's on a laser) would show nothing.
     */
    function listed(page: PageId): AreaView[] {
        const views = viewsOf(page, ctx.store.get());
        if (isSteps(views) || typeof document === "undefined") {
            return views;
        }
        return views.filter((view) => viewPanels(view).some((id) => {
            const node = document.getElementById(id);
            return node !== null && !node.classList.contains("hidden");
        }));
    }

    /** The view an area shows now: the one pressed, the one remembered, else where the work stands. */
    function current(page: PageId, views: AreaView[]): string {
        const steps = isSteps(views);
        const pick = picked.get(page);
        if (pick?.byHand && has(views, pick.id)) {
            return pick.id;
        }
        const remembered = typeof kept[page] === "string" ? kept[page] : null;
        if (pick === undefined && remembered !== null && has(views, remembered) && (!steps || remembered === ALL_VIEW)) {
            picked.set(page, { id: remembered, byHand: true });
            return remembered;
        }
        const id = (steps ? stepToOpen(views) : views[0]?.id) ?? ALL_VIEW;
        picked.set(page, { id, byHand: false });
        return id;
    }

    function remember(page: PageId, views: AreaView[], id: string): void {
        if (isSteps(views) && id !== ALL_VIEW) {
            delete kept[page];
        } else {
            kept[page] = id;
        }
        writeStored(VIEWS_KEY, JSON.stringify(kept));
    }

    /** Puts a view on its page: its panels through the layout layer, its columns and its dock for the stylesheet. */
    function apply(page: PageId, views: AreaView[], id: string): void {
        const root = typeof document === "undefined" ? null : document.getElementById(`page-${page}`);
        const view = views.find((entry) => entry.id === id);
        // Panels made for a view alone are left out of the area shown whole.
        for (const only of VIEW_ONLY[page] ?? []) {
            document.getElementById(only)?.classList.toggle("hidden", !view);
        }
        const columns = root ? Array.from(root.children).filter((child) => child.classList.contains("column")) : [];
        columns.forEach((column, index) => column.toggleAttribute("data-dock-column", view?.dock === true && index === columns.length - 1));
        if (!view) {
            showPanelView(page, null);
            root?.removeAttribute("data-dock");
            root?.style.removeProperty("--view-cols");
            return;
        }
        showPanelView(page, { id: view.id, columns: view.columns, folded: view.folded ?? [], front: view.front ?? [] });
        root?.toggleAttribute("data-dock", view.dock === true);
        root?.style.setProperty("--view-cols", view.cols);
    }

    function show(page: PageId, id: string): void {
        const views = listed(page);
        if (!has(views, id)) {
            return;
        }
        picked.set(page, { id, byHand: true });
        remember(page, views, id);
        drawAll();
    }

    /** The bar's nodes for an area's views, made once per area and set of views. */
    function build(side: Side, page: PageId, views: AreaView[]): Built {
        const bar = bars[side];
        const steps = isSteps(views);
        const tabs: Built["tabs"] = new Map();
        const list = el(steps ? "ol" : "div", { class: steps ? "viewbar-steps" : "viewbar-tabs" });
        if (!steps) {
            list.setAttribute("role", "tablist");
        }
        views.forEach((view, index) => {
            const dot = el("span", { class: "viewbar-dot", "aria-hidden": "true" }, String(index + 1));
            const press = el("button", { type: "button", class: steps ? "viewbar-step" : "viewbar-tab", title: view.tip, onclick: () => show(page, view.id) },
                steps ? dot : null,
                el("span", { class: "viewbar-name" }, view.label),
            );
            if (!steps) {
                press.setAttribute("role", "tab");
            }
            const item = steps ? el("li", { class: "viewbar-item" }, press) : press;
            tabs.set(view.id, { item, press, dot });
            list.append(item);
        });
        const all = button("All panels", () => {
            const at = picked.get(page)?.id;
            // Pressed again, All gives way to where the work stands, or the first view.
            if (at === ALL_VIEW) {
                picked.delete(page);
                delete kept[page];
                writeStored(VIEWS_KEY, JSON.stringify(kept));
                drawAll();
            } else {
                show(page, ALL_VIEW);
            }
        }, "btn btn-quiet btn-small btn-toggle viewbar-all", "every panel of this area, arranged as you left them");
        const title = el("span", { class: "viewbar-title" });
        const tag = el("span", { class: "viewbar-tag muted" }, "optional");
        const say = el("span", { class: "viewbar-say" });
        const step = (by: number): void => {
            const now = listed(page);
            const at = now.findIndex((view) => view.id === picked.get(page)?.id);
            const to = now[at + by];
            if (at >= 0 && to) {
                show(page, to.id);
            }
        };
        const back = button("Back", () => step(-1), "btn btn-quiet btn-small viewbar-back", "the step before");
        const next = button("Next", () => step(1), "btn btn-small viewbar-next");
        const top = el("div", { class: "viewbar-row" }, list, all);
        const nodes: HTMLElement[] = [top];
        if (steps) {
            nodes.push(el("div", { class: "viewbar-row viewbar-line" }, el("p", { class: "viewbar-words" }, title, tag, say), el("div", { class: "viewbar-nav" }, back, next)));
        }
        replace(bar, ...nodes);
        bar.toggleAttribute("data-steps", steps);
        bar.setAttribute("aria-label", steps ? "Steps" : "Views");
        return { page, ids: views.map((view) => view.id).join(" "), tabs, title, tag, say, back, next, all };
    }

    function draw(side: Side): void {
        const bar = bars[side];
        const page = shownOn(side);
        const views = listed(page);
        if (views.length === 0) {
            bar.hidden = true;
            delete built[side];
            apply(page, views, ALL_VIEW);
            return;
        }
        const id = current(page, views);
        apply(page, views, id);
        bar.hidden = false;
        let nodes = built[side];
        const ids = views.map((view) => view.id).join(" ");
        if (!nodes || nodes.page !== page || nodes.ids !== ids) {
            nodes = build(side, page, views);
            built[side] = nodes;
        }
        const steps = isSteps(views);
        for (const view of views) {
            const tab = nodes.tabs.get(view.id)!;
            const shown = view.id === id;
            if (steps) {
                const mark = stepMark(view, shown);
                if (tab.item.getAttribute("data-step") !== mark || tab.item.hasAttribute("data-done") !== (view.step?.done === true)) {
                    tab.item.setAttribute("data-step", mark);
                    tab.item.toggleAttribute("data-done", view.step?.done === true);
                    replace(tab.dot, view.step?.done ? svgIcon(TICK) : String(views.indexOf(view) + 1));
                }
                if (shown) {
                    tab.press.setAttribute("aria-current", "step");
                } else {
                    tab.press.removeAttribute("aria-current");
                }
                const state = view.step?.done ? "done" : view.step?.optional ? "optional" : "to do";
                tab.press.title = `${view.label}, ${state}: ${view.tip}`;
            } else {
                tab.press.setAttribute("aria-selected", String(shown));
            }
        }
        nodes.all.setAttribute("aria-pressed", String(id === ALL_VIEW));
        if (steps) {
            const at = views.findIndex((view) => view.id === id);
            const view = views[at];
            const following = views[at + 1];
            nodes.title.textContent = view ? view.label : "All panels";
            nodes.tag.hidden = !(view?.step?.optional === true && !view.step.done);
            const words = view ? view.line ?? view.tip : "Every panel of the area, arranged as you left them.";
            if (nodes.say.textContent !== words) {
                nodes.say.textContent = words;
            }
            nodes.back.hidden = at <= 0;
            nodes.next.hidden = following === undefined;
            if (following) {
                nodes.next.textContent = `Next: ${following.label}`;
                nodes.next.title = following.tip;
            }
            // The way on is the next action once this step is done.
            nodes.next.classList.toggle("btn-primary", view?.step?.done === true);
        }
    }

    function drawAll(): void {
        draw("use");
        draw("setup");
    }

    // A panel out of sight that has to be seen: a view that holds it, else all of them.
    onPanelOutOfView((page, panel) => {
        const id = pageNamed(page);
        if (id === null) {
            return;
        }
        show(id, viewHolding(listed(id), panel) ?? ALL_VIEW);
    });
    onPage(() => drawAll());
    onSides(() => drawAll());
    ctx.store.subscribe((_state: AppState) => drawAll(), ["snapshot", "job", "jobs", "settings", "heightMap", "camera", "placing", "components", "progress", "machines", "pnp"]);
    drawAll();

    mounted = {
        show,
        shown(page) {
            const views = listed(page);
            return views.length === 0 ? null : current(page, views);
        },
    };
    return mounted;
}
