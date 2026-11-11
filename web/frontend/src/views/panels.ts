// The panels' layout put on the page (src/layout.ts holds the rules). Every
// panel of every page, whatever its view, gets in its head a fold button
// and a menu (its dots button, or a right click on the head): fold, hide,
// move up, down or to the next column, stack with the panel above or
// below, stick to the panel above, and reset. A stack shows one panel at a
// time under a row of tabs, one per panel. Panels stuck together are drawn
// as one block with no gap and move together. A handle under each panel
// holds it at a height, its content scrolling within; a handle between two
// columns sets their widths; a double click on either gives the size back
// to the stylesheet. In edit mode each head has a grip that drags its
// panel (with what is stuck to it) to another place or onto another panel
// to stack them.
//
// The layer finds the panels in the markup (`main.page > .column >
// section.panel[id]`) and works on them by id, so a panel added to the
// markup later takes part with no change here. A panel its view hides
// (the `hidden` class) stays out of the stacks' tabs and of the moves. The
// layouts are kept in this browser: the working one under LAYOUT_KEY, by
// page, and saved ones by name under PRESETS_KEY, each covering every
// page. Panels that fold with a disclosure of their own (Setup, Align,
// Camera, Job JSON) keep that fold their own way: the layer opens and
// closes it, but a layout does not carry it.

import { el, readStored, svgIcon, writeStored } from "../dom.ts";
import {
    bringToFront,
    canonicalLayouts,
    DEFAULT_PRESET,
    isStuck,
    locate,
    matchingPreset,
    MIN_HEIGHT,
    moveBlock,
    moveToColumn,
    normalizeLayout,
    placeBlock,
    presetNameProblem,
    readObject,
    readPresets,
    resetPanel,
    sameArrangement,
    setPrefs,
    setWidths,
    stackNeighbor,
    stackOnto,
    stick,
    unstack,
    unstick,
    type PageLayout,
    type Stack,
} from "../layout.ts";
import { closeMenu, openMenu, type MenuEntry } from "../menu.ts";

export const LAYOUT_KEY = "spinny.layout";
export const PRESETS_KEY = "spinny.layout.presets";

/** What the page settings menu works the layouts with. */
export interface PanelsController {
    /** The names kept, Default not among them. */
    presetNames(): string[];
    /** The kept name the panels are laid out as now (Default for the markup's), or null for a layout not kept. */
    currentPreset(): string | null;
    applyPreset(name: string): void;
    /** Keeps the layout under a name (replacing one of that name); the problem with the name, or null when kept. */
    savePreset(name: string): string | null;
    deletePreset(name: string): void;
    /** Puts a page's panels back as the markup has them. */
    resetPage(page: string): void;
    editing(): boolean;
    setEditing(on: boolean): void;
    /** The panels the operator hid, on every page. */
    hiddenPanels(): { id: string; title: string; page: string }[];
    showPanel(id: string): void;
    /** Hears every change of a layout, the edit mode or the presets. */
    onChange(listener: () => void): void;
    /**
     * Draws every page again from the panels as their views have them. The
     * layer follows a view hiding its panel by itself; this is for the
     * tests, whose DOM (happy-dom) can drop an observer at any garbage
     * collection, holding its callback only weakly.
     */
    refresh(): void;
}

interface PageView {
    id: string;
    root: HTMLElement;
    columns: HTMLElement[];
    /** The markup's panel ids per column: the default layout. */
    defaults: string[][];
    layout: PageLayout;
    /** The tab rows over stacks, by the stack's ids. */
    strips: Map<string, HTMLElement>;
    /** A handle on each boundary between two columns. */
    handles: HTMLElement[];
}

interface PanelView {
    id: string;
    page: PageView;
    root: HTMLElement;
    head: HTMLElement;
    /** A disclosure the panel folds with, its head being its summary. */
    fold: HTMLDetailsElement | null;
    chevron: HTMLButtonElement | null;
    menuButton: HTMLButtonElement;
    grip: HTMLButtonElement;
    /** The handle under the panel that sets its height; it lives in the column. */
    resize: HTMLElement;
    /** Whether its view hid it, and its name, as last drawn. */
    viewHidden: boolean;
    name: string;
}

let controller: (PanelsController & { reveal(id: string): void }) | null = null;

/**
 * Makes sure a panel can be seen: shown again if hidden, unfolded, and in
 * front of its stack. Setup steps use it before they scroll to a panel; it
 * does nothing where the layer is not mounted (the tests).
 */
export function revealPanel(id: string): void {
    controller?.reveal(id);
}

/** The children of `parent` that match `selector` (`:scope >` without the selector support it needs). */
function childrenOf<T extends Element = HTMLElement>(parent: Element, selector: string): T[] {
    return Array.from(parent.children).filter((child) => child.matches(selector)) as T[];
}

function remPx(): number {
    return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

/** Whether the page is laid out in columns (the wide layout) rather than as one column. */
function wide(): boolean {
    return typeof window.matchMedia !== "function" || window.matchMedia("(min-width: 64rem)").matches;
}

function title(root: HTMLElement): string {
    return root.getAttribute("aria-label") ?? root.querySelector("h2")?.textContent ?? root.id;
}

/** Three dots in a row. */
const DOTS = "M2 8a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0M6.5 8a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0M11 8a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0";
/** Two columns of three dots: a grip. */
const GRIP = "M5 3.5a1.25 1.25 0 1 0 0.01 0M11 3.5a1.25 1.25 0 1 0 0.01 0M5 8a1.25 1.25 0 1 0 0.01 0M11 8a1.25 1.25 0 1 0 0.01 0M5 12.5a1.25 1.25 0 1 0 0.01 0M11 12.5a1.25 1.25 0 1 0 0.01 0";

export function mountPanels(app: HTMLElement): PanelsController {
    const pages = new Map<string, PageView>();
    const panels = new Map<string, PanelView>();
    const listeners: (() => void)[] = [];
    let editing = false;

    const stored = readObject(readStored(LAYOUT_KEY));
    for (const root of childrenOf(app, "main.page")) {
        const id = root.id.replace(/^page-/, "");
        const columns = childrenOf(root, ".column");
        const defaults = columns.map((column) => childrenOf(column, "section.panel[id]").map((panel) => panel.id));
        const page: PageView = { id, root, columns, defaults, layout: normalizeLayout(stored[id] ?? null, defaults), strips: new Map(), handles: [] };
        pages.set(id, page);
        for (const column of columns) {
            for (const panel of childrenOf(column, "section.panel[id]")) {
                panels.set(panel.id, decorate(panel, page));
            }
        }
        for (let boundary = 1; boundary < columns.length; boundary++) {
            const handle = el("div", { class: "column-resize", title: "drag to set the widths; double click for the usual ones", "aria-hidden": "true" });
            handle.addEventListener("pointerdown", (event) => dragWidth(page, boundary, event));
            handle.addEventListener("dblclick", () => update(page, setWidths(page.layout, null)));
            root.append(handle);
            page.handles.push(handle);
        }
    }

    function defaultsByPage(): Record<string, string[][]> {
        return Object.fromEntries([...pages.values()].map((page) => [page.id, page.defaults]));
    }

    function currentLayouts(): Record<string, PageLayout> {
        return canonicalLayouts(Object.fromEntries([...pages.values()].map((page) => [page.id, page.layout])), defaultsByPage());
    }

    function save(): void {
        writeStored(LAYOUT_KEY, JSON.stringify(currentLayouts()));
        for (const listener of listeners) {
            listener();
        }
    }

    function update(page: PageView, layout: PageLayout): void {
        page.layout = layout;
        save();
        render(page);
    }

    // --- the heads ------------------------------------------------------------

    /** The panel's head: its own, its disclosure's summary, a bare title wrapped into one, or one made from its name. */
    function findHead(root: HTMLElement): { head: HTMLElement; fold: HTMLDetailsElement | null } {
        const own = childrenOf(root, ".panel-head")[0];
        if (own) {
            return { head: own, fold: null };
        }
        const first = root.firstElementChild;
        if (first instanceof HTMLDetailsElement) {
            const summary = childrenOf(first, "summary")[0];
            if (summary) {
                return { head: summary, fold: first };
            }
        }
        const head = el("div", { class: "panel-head" });
        const bare = childrenOf(root, "h2")[0];
        if (bare) {
            bare.replaceWith(head);
            head.append(bare);
        } else {
            head.append(el("h2", {}, title(root)));
            root.prepend(head);
        }
        return { head, fold: null };
    }

    function decorate(root: HTMLElement, page: PageView): PanelView {
        const { head, fold } = findHead(root);
        const name = title(root);
        const grip = el("button", { type: "button", class: "panel-grip", "aria-label": `Drag ${name}`, title: "drag to another place, or onto a panel to stack" });
        grip.append(svgIcon(GRIP));
        const menuButton = el("button", { type: "button", class: "panel-menu-button", "aria-label": `${name} panel menu`, "aria-haspopup": "menu", title: "panel menu" });
        menuButton.append(svgIcon(DOTS));
        let chevron: HTMLButtonElement | null = null;
        if (!fold) {
            chevron = el("button", { type: "button", class: "panel-chevron", "aria-label": `Fold ${name}`, "aria-expanded": "true" });
        }
        const resize = el("div", { class: "panel-resize", title: "drag to hold the panel at a height; double click to free it", "aria-hidden": "true" });
        const panel: PanelView = { id: root.id, page, root, head, fold, chevron, menuButton, grip, resize, viewHidden: root.classList.contains("hidden"), name };
        place(panel);

        // In a summary a press would also open or close the disclosure.
        const own = (event: Event): void => {
            event.preventDefault();
            event.stopPropagation();
        };
        menuButton.addEventListener("click", (event) => {
            own(event);
            openPanelMenu(panel, menuButton);
        });
        chevron?.addEventListener("click", () => setCollapsed(panel, !collapsedOf(panel)));
        grip.addEventListener("click", own);
        grip.addEventListener("pointerdown", (event) => dragPanel(panel, event));
        head.addEventListener("contextmenu", (event) => {
            const target = event.target as Element | null;
            if (target?.closest("input, textarea, select, a")) {
                return;
            }
            event.preventDefault();
            openPanelMenu(panel, { x: (event as MouseEvent).clientX, y: (event as MouseEvent).clientY }, head);
        });
        fold?.addEventListener("toggle", () => {
            applyPanel(panel);
            positionHandles(panel.page);
        });
        resize.addEventListener("pointerdown", (event) => dragHeight(panel, event));
        resize.addEventListener("dblclick", () => update(panel.page, setPrefs(panel.page.layout, panel.id, { height: undefined })));

        // A view that hides or shows its panel, renames it, or draws its
        // head again, is followed: the stacks' tabs and the moves skip
        // hidden panels, and a tab carries its panel's name.
        if (typeof MutationObserver === "function") {
            new MutationObserver(() => {
                if (!panel.head.isConnected || !panel.menuButton.isConnected) {
                    const found = findHead(root);
                    panel.head = found.head;
                    panel.fold = found.fold;
                    place(panel);
                }
                const hidden = root.classList.contains("hidden");
                if (hidden !== panel.viewHidden || title(root) !== panel.name) {
                    panel.viewHidden = hidden;
                    panel.name = title(root);
                    render(panel.page);
                }
            }).observe(root, { attributes: true, attributeFilter: ["class", "aria-label"], childList: true });
        }
        return panel;
    }

    /** Puts the grip and the fold button before the title, and the menu after it. */
    function place(panel: PanelView): void {
        const { head } = panel;
        const heading = childrenOf(head, "h2")[0];
        head.prepend(...[panel.grip, panel.chevron].filter((node): node is HTMLButtonElement => node !== null));
        if (heading) {
            heading.after(panel.menuButton);
        } else {
            head.append(panel.menuButton);
        }
        head.classList.add("panel-head-tools");
    }

    // --- one panel's state -----------------------------------------------------

    function prefsOf(panel: PanelView) {
        return panel.page.layout.panels[panel.id] ?? {};
    }

    function collapsedOf(panel: PanelView): boolean {
        return panel.fold ? !panel.fold.open : prefsOf(panel).collapsed === true;
    }

    function setCollapsed(panel: PanelView, collapsed: boolean): void {
        if (panel.fold) {
            // The disclosure's own listener keeps the fold; its toggle
            // event draws the panel again.
            panel.fold.open = !collapsed;
            return;
        }
        update(panel.page, setPrefs(panel.page.layout, panel.id, { collapsed: collapsed || undefined }));
    }

    /** Whether the panel shows: its view has not hidden it (read as it is now) and neither has the operator. */
    function shown(id: string): boolean {
        const panel = panels.get(id);
        return panel !== undefined && !panel.root.classList.contains("hidden") && prefsOf(panel).hidden !== true;
    }

    function applyPanel(panel: PanelView): void {
        const prefs = prefsOf(panel);
        const collapsed = collapsedOf(panel);
        const { root } = panel;
        if (!panel.fold) {
            root.toggleAttribute("data-collapsed", collapsed);
            panel.chevron?.setAttribute("aria-expanded", String(!collapsed));
            panel.chevron?.setAttribute("aria-label", `${collapsed ? "Unfold" : "Fold"} ${title(root)}`);
            if (panel.chevron) {
                panel.chevron.title = collapsed ? "unfold" : "fold to the head";
            }
        }
        root.toggleAttribute("data-off", prefs.hidden === true);
        const height = !collapsed && prefs.height !== undefined ? prefs.height : null;
        root.toggleAttribute("data-height", height !== null);
        // Written only on a change: besides saving work, setting a style
        // (or reading a computed one) stops happy-dom's mutation observers
        // on the element, which the tests rely on.
        const want = height === null ? "" : `${height}rem`;
        if (root.style.height !== want) {
            root.style.height = want;
        }
        panel.resize.hidden = handleHidden(panel, collapsed);
    }

    /**
     * Whether the height handle under a panel is out of use: the panel is
     * folded, not shown, behind in its stack, or docked at its column's
     * foot (the Run panel, alone), where a handle under it could not be
     * reached.
     */
    function handleHidden(panel: PanelView, collapsed = collapsedOf(panel)): boolean {
        const { root } = panel;
        const docked = root.hasAttribute("data-dock") && !["data-join-up", "data-join-down", "data-stacked"].some((name) => root.hasAttribute(name));
        return collapsed || !shown(panel.id) || root.hasAttribute("data-behind") || docked;
    }

    // --- drawing a page --------------------------------------------------------

    function stripFor(page: PageView, stack: Stack, visible: PanelView[], front: PanelView): HTMLElement {
        const key = stack.ids.join(" ");
        let strip = page.strips.get(key);
        if (!strip) {
            strip = el("div", { class: "panel-tabs", role: "tablist" });
            page.strips.set(key, strip);
        }
        // Drawn again only when what it shows changes (a panel renamed, as
        // the Laser panel is on a spindle machine, included): a tab replaced
        // between a press and its release takes no click.
        const shownKey = `${visible.map((panel) => `${panel.id}=${title(panel.root)}`).join(" ")}|${front.id}`;
        if (strip.dataset["shown"] !== shownKey) {
            strip.dataset["shown"] = shownKey;
            strip.setAttribute("aria-label", `Stack of ${visible.map((panel) => title(panel.root)).join(", ")}`);
            strip.replaceChildren(...visible.map((panel) => {
                const tab = el("button", {
                    type: "button",
                    class: "panel-tab",
                    role: "tab",
                    "aria-selected": String(panel === front),
                    "aria-controls": panel.id,
                }, title(panel.root));
                tab.addEventListener("click", () => update(page, bringToFront(page.layout, panel.id)));
                tab.addEventListener("contextmenu", (event) => {
                    event.preventDefault();
                    openPanelMenu(panel, { x: event.clientX, y: event.clientY }, tab);
                });
                return tab;
            }));
        }
        return strip;
    }

    /** Puts `desired` first in `parent`, in order, moving only what is out of place; anything else stays after them. */
    function reorder(parent: HTMLElement, desired: HTMLElement[]): void {
        desired.forEach((node, index) => {
            const at = parent.children[index] ?? null;
            if (at !== node) {
                parent.insertBefore(node, at);
            }
        });
    }

    function render(page: PageView): void {
        page.root.toggleAttribute("data-arranged", !sameArrangement(page.layout, page.defaults));
        if (page.layout.widths) {
            page.root.setAttribute("data-widths", "");
            page.root.style.setProperty("--cols", page.layout.widths.map((share) => `minmax(12rem, ${share}fr)`).join(" "));
        } else {
            page.root.removeAttribute("data-widths");
            page.root.style.removeProperty("--cols");
        }
        const used = new Set<HTMLElement>();
        page.layout.columns.forEach((blocks, index) => {
            const column = page.columns[index];
            if (!column) {
                return;
            }
            const desired: HTMLElement[] = [];
            const handles: HTMLElement[] = [];
            // What is drawn, in order, with its block, for the joins.
            const drawn: { node: HTMLElement; block: number }[] = [];
            blocks.forEach((block, blockIndex) => {
                for (const stack of block) {
                    const members = stack.ids.map((id) => panels.get(id)).filter((panel): panel is PanelView => panel !== undefined);
                    const visible = members.filter((panel) => shown(panel.id));
                    const front = visible.find((panel) => panel.id === stack.front) ?? visible[0];
                    if (front && visible.length > 1) {
                        const strip = stripFor(page, stack, visible, front);
                        used.add(strip);
                        desired.push(strip);
                        drawn.push({ node: strip, block: blockIndex });
                    }
                    for (const panel of members) {
                        desired.push(panel.root);
                        handles.push(panel.resize);
                        panel.root.toggleAttribute("data-behind", visible.includes(panel) && panel !== front);
                        panel.root.toggleAttribute("data-stacked", visible.length > 1 && panel === front);
                        applyPanel(panel);
                        if (panel === front) {
                            drawn.push({ node: panel.root, block: blockIndex });
                        }
                    }
                }
            });
            reorder(column, [...desired, ...handles]);
            drawn.forEach(({ node, block }, at) => {
                node.toggleAttribute("data-join-up", at > 0 && drawn[at - 1]!.block === block);
                node.toggleAttribute("data-join-down", at < drawn.length - 1 && drawn[at + 1]!.block === block);
            });
            // The first and last things shown take the room over and under
            // them (the stylesheet's column rules), whichever panels they are.
            for (const node of desired) {
                node.toggleAttribute("data-first", node === drawn[0]?.node);
                node.toggleAttribute("data-last", node === drawn[drawn.length - 1]?.node);
            }
            // The joins are known only now: a docked panel stuck to another
            // gets its handle back.
            for (const handle of handles) {
                const panel = [...panels.values()].find((entry) => entry.resize === handle);
                if (panel) {
                    handle.hidden = handleHidden(panel);
                }
            }
        });
        for (const [key, strip] of page.strips) {
            if (!used.has(strip)) {
                strip.remove();
                page.strips.delete(key);
            }
        }
        positionHandles(page);
    }

    /** Puts each panel's height handle on its bottom edge and each column handle between its columns. */
    function positionHandles(page: PageView): void {
        if (!wide()) {
            return;
        }
        for (const panel of panels.values()) {
            if (panel.page === page && !panel.resize.hidden) {
                panel.resize.style.top = `${panel.root.offsetTop + panel.root.offsetHeight}px`;
            }
        }
        page.handles.forEach((handle, index) => {
            const column = page.columns[index];
            if (column) {
                handle.style.left = `${column.offsetLeft + column.offsetWidth}px`;
            }
        });
    }

    // --- the menu --------------------------------------------------------------

    function openPanelMenu(panel: PanelView, at: HTMLElement | { x: number; y: number }, from?: Element): void {
        const { page, id } = panel;
        const layout = page.layout;
        const where = locate(layout, id);
        if (!where) {
            return;
        }
        const blocks = layout.columns[where.column]!;
        const visibleBlock = (index: number): boolean => blocks[index]!.some((stack) => stack.ids.some(shown));
        const before = blocks.slice(0, where.block).some((_, index) => visibleBlock(index));
        const after = blocks.slice(where.block + 1).some((_, index) => visibleBlock(where.block + 1 + index));
        const above = stackNeighbor(layout, id, -1, shown);
        const below = stackNeighbor(layout, id, 1, shown);
        const stacked = blocks[where.block]![where.stack]!.ids.length > 1;
        const stuck = isStuck(layout, id);
        const prefs = prefsOf(panel);
        const collapsed = collapsedOf(panel);
        const columns = layout.columns.length;
        const apply = (next: PageLayout): void => update(page, next);
        const entries: MenuEntry[] = [
            { label: collapsed ? "Unfold" : "Fold", run: () => setCollapsed(panel, !collapsed) },
            { label: "Hide", run: () => apply(setPrefs(layout, id, { hidden: true })) },
            "-",
            { label: "Move up", run: () => apply(moveBlock(layout, id, -1, shown)), disabled: before ? undefined : "already at the top" },
            { label: "Move down", run: () => apply(moveBlock(layout, id, 1, shown)), disabled: after ? undefined : "already at the bottom" },
        ];
        if (columns > 1) {
            entries.push(
                { label: "Move left", run: () => apply(moveToColumn(layout, id, -1)), disabled: where.column > 0 ? undefined : "already in the first column" },
                { label: "Move right", run: () => apply(moveToColumn(layout, id, 1)), disabled: where.column < columns - 1 ? undefined : "already in the last column" },
            );
        }
        entries.push(
            "-",
            { label: "Stack with above", run: () => apply(stackOnto(layout, id, above!)), disabled: above ? undefined : "no panel above" },
            { label: "Stack with below", run: () => apply(stackOnto(layout, id, below!)), disabled: below ? undefined : "no panel below" },
        );
        if (stacked) {
            entries.push({ label: "Unstack", run: () => apply(unstack(layout, id)) });
        }
        entries.push(stuck
            ? { label: "Unstick from above", run: () => apply(unstick(layout, id)) }
            : { label: "Stick to above", run: () => apply(stick(layout, id, shown)), disabled: before ? undefined : "no panel above" });
        entries.push("-");
        if (prefs.height !== undefined) {
            entries.push({ label: "Free height", run: () => apply(setPrefs(layout, id, { height: undefined })) });
        }
        entries.push({ label: "Reset panel", run: () => apply(resetPanel(layout, id, page.defaults)) });
        openMenu(entries, at, `${title(panel.root)} panel`, from);
    }

    // --- sizes ----------------------------------------------------------------

    /** Follows a drag from `event` until the pointer is let go; `move` hears the pointer's travel from where it went down. */
    function follow(event: PointerEvent, move: (dx: number, dy: number, at: PointerEvent) => void, done: (cancelled: boolean) => void): void {
        const target = event.currentTarget as HTMLElement;
        const startX = event.clientX;
        const startY = event.clientY;
        target.setPointerCapture?.(event.pointerId);
        document.documentElement.setAttribute("data-dragging", "");
        const onMove = (at: PointerEvent): void => move(at.clientX - startX, at.clientY - startY, at);
        const end = (cancelled: boolean): void => {
            target.removeEventListener("pointermove", onMove);
            target.removeEventListener("pointerup", onUp);
            target.removeEventListener("pointercancel", onCancel);
            document.removeEventListener("keydown", onKey, true);
            document.documentElement.removeAttribute("data-dragging");
            done(cancelled);
        };
        const onUp = (): void => end(false);
        const onCancel = (): void => end(true);
        const onKey = (key: KeyboardEvent): void => {
            if (key.key === "Escape") {
                key.preventDefault();
                key.stopPropagation();
                end(true);
            }
        };
        target.addEventListener("pointermove", onMove);
        target.addEventListener("pointerup", onUp);
        target.addEventListener("pointercancel", onCancel);
        document.addEventListener("keydown", onKey, true);
    }

    function dragHeight(panel: PanelView, event: PointerEvent): void {
        if (event.button !== 0) {
            return;
        }
        event.preventDefault();
        const rem = remPx();
        const start = panel.root.getBoundingClientRect().height;
        let height = start / rem;
        follow(event, (_dx, dy) => {
            height = Math.max(MIN_HEIGHT, (start + dy) / rem);
            panel.root.style.height = `${height}rem`;
            panel.root.setAttribute("data-height", "");
            positionHandles(panel.page);
        }, (cancelled) => {
            if (cancelled || Math.abs(height * rem - start) < 2) {
                applyPanel(panel);
                positionHandles(panel.page);
                return;
            }
            update(panel.page, setPrefs(panel.page.layout, panel.id, { height: Math.round(height * 4) / 4 }));
        });
    }

    function dragWidth(page: PageView, boundary: number, event: PointerEvent): void {
        if (event.button !== 0) {
            return;
        }
        event.preventDefault();
        const widths = page.columns.map((column) => column.getBoundingClientRect().width);
        const least = 12 * remPx();
        let now = [...widths];
        follow(event, (dx) => {
            const left = widths[boundary - 1]!;
            const right = widths[boundary]!;
            const shift = Math.max(Math.min(dx, right - least), least - left);
            now = [...widths];
            now[boundary - 1] = left + shift;
            now[boundary] = right - shift;
            page.root.setAttribute("data-widths", "");
            page.root.style.setProperty("--cols", now.map((width) => `minmax(12rem, ${width}fr)`).join(" "));
            positionHandles(page);
        }, (cancelled) => {
            if (cancelled) {
                render(page);
                return;
            }
            const total = now.reduce((sum, width) => sum + width, 0);
            update(page, setWidths(page.layout, now.map((width) => width / total)));
        });
    }

    // --- dragging a panel in edit mode -------------------------------------------

    type Drop = { kind: "before"; column: number; before: string | null } | { kind: "stack"; target: string };

    /** Where a panel dragged to (x, y) would go, and the box to mark for it; null for nowhere. */
    function dropAt(page: PageView, dragged: string, x: number, y: number): { drop: Drop; mark: { left: number; top: number; width: number; height: number } } | null {
        const where = locate(page.layout, dragged);
        if (!where) {
            return null;
        }
        const own = page.layout.columns[where.column]![where.block]!;
        const ownIds = new Set(own.flatMap((stack) => stack.ids));
        const rects = page.columns.map((column) => column.getBoundingClientRect());
        let column = rects.findIndex((rect) => x >= rect.left && x < rect.right);
        if (column < 0) {
            column = x < rects[0]!.left ? 0 : rects.length - 1;
        }
        const rect = rects[column]!;
        const rem = remPx();
        // Blocks drawn in the column, each the box around what it shows.
        const boxes: { first: string; top: number; bottom: number; fronts: { id: string; rect: DOMRect }[] }[] = [];
        for (const block of page.layout.columns[column]!) {
            const ids = block.flatMap((stack) => stack.ids);
            if (ids.some((id) => ownIds.has(id))) {
                continue;
            }
            const fronts: { id: string; rect: DOMRect }[] = [];
            let top = Infinity;
            let bottom = -Infinity;
            for (const stack of block) {
                const visible = stack.ids.filter(shown);
                const front = visible.includes(stack.front) ? stack.front : visible[0];
                if (!front) {
                    continue;
                }
                const box = panels.get(front)!.root.getBoundingClientRect();
                fronts.push({ id: front, rect: box });
                const strip = page.strips.get(stack.ids.join(" "));
                top = Math.min(top, strip?.isConnected ? strip.getBoundingClientRect().top : box.top);
                bottom = Math.max(bottom, box.bottom);
            }
            if (fronts.length > 0) {
                boxes.push({ first: ids[0]!, top, bottom, fronts });
            }
        }
        // Over the middle of a panel: stack onto it, when what is dragged is one stack.
        if (own.length === 1) {
            for (const box of boxes) {
                for (const front of box.fronts) {
                    const band = Math.min(front.rect.height * 0.3, 4 * rem);
                    if (y > front.rect.top + band && y < front.rect.bottom - band) {
                        return { drop: { kind: "stack", target: front.id }, mark: { left: front.rect.left, top: front.rect.top, width: front.rect.width, height: front.rect.height } };
                    }
                }
            }
        }
        const next = boxes.find((box) => y < (box.top + box.bottom) / 2);
        const line = next ? next.top - rem / 2 : boxes.length > 0 ? boxes[boxes.length - 1]!.bottom + rem / 2 : rect.top + rem;
        return {
            drop: { kind: "before", column, before: next ? next.first : null },
            mark: { left: rect.left + rem / 2, top: line - rem / 8, width: rect.width - rem, height: rem / 4 },
        };
    }

    function dragPanel(panel: PanelView, event: PointerEvent): void {
        if (event.button !== 0 || !editing || !wide()) {
            return;
        }
        event.preventDefault();
        closeMenu(false);
        const page = panel.page;
        const where = locate(page.layout, panel.id);
        if (!where) {
            return;
        }
        const block = page.layout.columns[where.column]![where.block]!;
        const moving = block.flatMap((stack) => stack.ids).map((id) => panels.get(id)!.root);
        for (const node of moving) {
            node.setAttribute("data-dragged", "");
        }
        const ghost = el("div", { class: "drag-ghost" }, title(panel.root));
        const mark = el("div", { class: "drop-mark" });
        document.body.append(ghost, mark);
        let drop: Drop | null = null;
        let pointer = { x: event.clientX, y: event.clientY };
        let frame = 0;
        // The column under the pointer scrolls while it is held near its top or bottom.
        const scroll = (): void => {
            const rem = remPx();
            for (const column of page.columns) {
                const rect = column.getBoundingClientRect();
                if (pointer.x >= rect.left && pointer.x < rect.right) {
                    if (pointer.y < rect.top + 3 * rem) {
                        column.scrollTop -= rem / 2;
                    } else if (pointer.y > rect.bottom - 3 * rem) {
                        column.scrollTop += rem / 2;
                    }
                }
            }
            frame = requestAnimationFrame(scroll);
        };
        frame = requestAnimationFrame(scroll);
        const show = (x: number, y: number): void => {
            pointer = { x, y };
            ghost.style.left = `${x}px`;
            ghost.style.top = `${y}px`;
            const found = dropAt(page, panel.id, x, y);
            drop = found?.drop ?? null;
            mark.hidden = found === null;
            if (found) {
                mark.classList.toggle("stack", found.drop.kind === "stack");
                mark.style.left = `${found.mark.left}px`;
                mark.style.top = `${found.mark.top}px`;
                mark.style.width = `${found.mark.width}px`;
                mark.style.height = `${found.mark.height}px`;
            }
        };
        show(event.clientX, event.clientY);
        follow(event, (_dx, _dy, at) => show(at.clientX, at.clientY), (cancelled) => {
            cancelAnimationFrame(frame);
            ghost.remove();
            mark.remove();
            for (const node of moving) {
                node.removeAttribute("data-dragged");
            }
            if (cancelled || drop === null) {
                return;
            }
            const next = drop.kind === "stack"
                ? stackOnto(page.layout, panel.id, drop.target)
                : placeBlock(page.layout, panel.id, drop.column, drop.before);
            update(page, next);
        });
    }

    // --- the whole -------------------------------------------------------------

    function reveal(id: string): void {
        const panel = panels.get(id);
        if (!panel) {
            return;
        }
        let layout = panel.page.layout;
        if (prefsOf(panel).hidden) {
            layout = setPrefs(layout, id, { hidden: undefined });
        }
        if (!panel.fold && prefsOf(panel).collapsed) {
            layout = setPrefs(layout, id, { collapsed: undefined });
        }
        layout = bringToFront(layout, id);
        if (layout !== panel.page.layout && JSON.stringify(layout) !== JSON.stringify(panel.page.layout)) {
            update(panel.page, layout);
        }
        if (panel.fold && !panel.fold.open) {
            panel.fold.open = true;
        }
    }

    function applyAll(layouts: Record<string, unknown>): void {
        for (const page of pages.values()) {
            page.layout = normalizeLayout(layouts[page.id] ?? null, page.defaults);
            render(page);
        }
        save();
    }

    const presets = (): Record<string, Record<string, unknown>> => readPresets(readStored(PRESETS_KEY));
    const notify = (): void => {
        for (const listener of listeners) {
            listener();
        }
    };

    const api: PanelsController & { reveal(id: string): void } = {
        presetNames: () => Object.keys(presets()).sort((a, b) => a.localeCompare(b)),
        currentPreset: () => matchingPreset(currentLayouts(), presets(), defaultsByPage()),
        applyPreset(name) {
            applyAll(name === DEFAULT_PRESET ? {} : presets()[name] ?? {});
        },
        savePreset(name) {
            const problem = presetNameProblem(name);
            if (problem !== null) {
                return problem;
            }
            const kept = presets();
            kept[name.trim()] = currentLayouts();
            writeStored(PRESETS_KEY, JSON.stringify(kept));
            notify();
            return null;
        },
        deletePreset(name) {
            const kept = presets();
            delete kept[name];
            writeStored(PRESETS_KEY, JSON.stringify(kept));
            notify();
        },
        resetPage(id) {
            const page = pages.get(id);
            if (page) {
                update(page, normalizeLayout(null, page.defaults));
            }
        },
        editing: () => editing,
        setEditing(on) {
            editing = on;
            app.toggleAttribute("data-edit", on);
            notify();
        },
        hiddenPanels: () => [...panels.values()]
            .filter((panel) => prefsOf(panel).hidden === true)
            .map((panel) => ({ id: panel.id, title: title(panel.root), page: panel.page.id })),
        showPanel(id) {
            const panel = panels.get(id);
            if (panel) {
                update(panel.page, setPrefs(panel.page.layout, id, { hidden: undefined }));
            }
        },
        onChange(listener) {
            listeners.push(listener);
        },
        refresh() {
            for (const page of pages.values()) {
                render(page);
            }
        },
        reveal,
    };

    for (const page of pages.values()) {
        render(page);
    }
    // Sizes change with the window, a panel's content, a fold: the handles follow.
    if (typeof ResizeObserver === "function") {
        const observer = new ResizeObserver((entries) => {
            const touched = new Set<PageView>();
            for (const entry of entries) {
                const page = [...pages.values()].find((candidate) => candidate.root.contains(entry.target));
                if (page) {
                    touched.add(page);
                }
            }
            for (const page of touched) {
                positionHandles(page);
            }
        });
        for (const page of pages.values()) {
            observer.observe(page.root);
            for (const column of page.columns) {
                observer.observe(column);
            }
        }
        for (const panel of panels.values()) {
            observer.observe(panel.root);
        }
    }
    controller = api;
    return api;
}
