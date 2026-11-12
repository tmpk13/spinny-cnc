// The page settings, behind a gear at the right end of the tab bar: the
// tab the page opens on, the tab bar folding to a strip, and the tabs kept
// out of the bar; the panel layouts kept by name and the one in use, the
// edit mode that drags panels about, the page's panels put back as the
// markup has them, and the panels hidden, each to show again. Beside the
// gear, once a layout is kept, a pick of the layouts swaps them in one
// step, and in edit mode a Done editing button ends it. An eye beside the
// gear, while any panel is hidden, shows the hidden panels for a while
// (marked as hidden) and hides them again; two arrows scroll the column
// last pointed at to its top or its end. Everything here is kept in this
// browser; the peek is not.

import { el, labeled, replace, svgIcon } from "../dom.ts";
import { DEFAULT_PRESET } from "../layout.ts";
import { closeMenu } from "../menu.ts";
import { TO_END, TO_TOP, type PanelsController } from "./panels.ts";
import { onPage, PAGES, readTabPrefs, writeTabPrefs, type PageId, type TabPrefs } from "./tabs.ts";

/** A gear with eight teeth and a hole, in a box 16 units square. */
function gearPath(): string {
    const center = 8;
    const point = (angle: number, radius: number): string => {
        const rad = (angle * Math.PI) / 180;
        return `${(center + radius * Math.cos(rad)).toFixed(2)} ${(center + radius * Math.sin(rad)).toFixed(2)}`;
    };
    const parts: string[] = [];
    for (let tooth = 0; tooth < 8; tooth++) {
        const at = tooth * 45;
        parts.push(point(at - 13, 5.3), point(at - 7, 7.4), point(at + 7, 7.4), point(at + 13, 5.3));
    }
    const hole = 2.3;
    return `M${parts.join("L")}Z M${center + hole} ${center}A${hole} ${hole} 0 1 0 ${center - hole} ${center}A${hole} ${hole} 0 1 0 ${center + hole} ${center}Z`;
}

/** An eye: its outline and its pupil. */
const EYE = "M0.8 8c1.9 -3.1 4.4 -4.7 7.2 -4.7s5.3 1.6 7.2 4.7c-1.9 3.1 -4.4 4.7 -7.2 4.7s-5.3 -1.6 -7.2 -4.7zM8 5.4a2.6 2.6 0 1 0 0.01 0z";

/** The name the layout pick shows for a layout no name keeps. */
const UNKEPT = "";

export function mountPageSettings(tools: HTMLElement, panels: PanelsController): void {
    const gear = el("button", { type: "button", class: "tabs-gear", "aria-label": "Page settings", "aria-haspopup": "dialog", "aria-expanded": "false", title: "page settings" });
    gear.append(svgIcon(gearPath(), true));
    const quick = el("select", { class: "field tabs-layouts", "aria-label": "Panel layout", title: "the panel layout; pick a kept one to swap to it" }) as HTMLSelectElement;
    const done = el("button", { type: "button", class: "btn btn-small btn-primary tabs-done", title: "stop editing the panels" }, "Done editing");
    const peek = el("button", { type: "button", class: "tabs-tool tabs-peek", "aria-label": "Show hidden panels", "aria-pressed": "false" });
    peek.append(svgIcon(EYE, true));
    peek.addEventListener("click", () => panels.setPeeking(!panels.peeking()));
    const toTop = el("button", { type: "button", class: "tabs-tool", "aria-label": "Scroll to the top", title: "scroll the column last pointed at to its top" });
    toTop.append(svgIcon(TO_TOP));
    toTop.addEventListener("click", () => panels.scrollColumn("top"));
    const toEnd = el("button", { type: "button", class: "tabs-tool", "aria-label": "Scroll to the end", title: "scroll the column last pointed at to its end" });
    toEnd.append(svgIcon(TO_END));
    toEnd.addEventListener("click", () => panels.scrollColumn("end"));
    const sheet = el("div", { class: "panel page-settings", role: "dialog", "aria-label": "Page settings" });
    sheet.hidden = true;
    tools.append(quick, done, toTop, toEnd, peek, gear, sheet);

    /** Fills a layout pick: Default, the kept names, and a blank for a layout none keeps. */
    function fillLayouts(select: HTMLSelectElement): void {
        const current = panels.currentPreset();
        const names = [DEFAULT_PRESET, ...panels.presetNames()];
        const options = names.map((name) => el("option", { value: name }, name));
        if (current === null) {
            options.push(el("option", { value: UNKEPT, disabled: true }, "this layout (not kept)"));
        }
        replace(select, ...options);
        select.value = current ?? UNKEPT;
    }

    function drawBar(): void {
        quick.hidden = panels.presetNames().length === 0;
        if (!quick.hidden) {
            fillLayouts(quick);
        }
        done.hidden = !panels.editing();
        // The eye shows while a panel is hidden, or while it is pressed.
        const hidden = panels.hiddenPanels().length;
        if (hidden === 0 && panels.peeking()) {
            panels.setPeeking(false);
            return;
        }
        peek.hidden = hidden === 0;
        peek.setAttribute("aria-pressed", String(panels.peeking()));
        peek.title = panels.peeking() ? "hide the hidden panels again" : `show the ${hidden} hidden panel${hidden === 1 ? "" : "s"} for now`;
    }

    quick.addEventListener("change", () => {
        if (quick.value !== UNKEPT) {
            panels.applyPreset(quick.value);
        }
    });
    done.addEventListener("click", () => panels.setEditing(false));

    function setTabs(change: Partial<TabPrefs>): void {
        writeTabPrefs({ ...readTabPrefs(), ...change });
        drawSheet();
    }

    function currentPage(): PageId {
        const id = document.getElementById("app")?.getAttribute("data-page");
        return PAGES.find((page) => page.id === id)?.id ?? "jobs";
    }

    /** The sheet's content, drawn again from the settings whenever it opens or they change. */
    function drawSheet(): void {
        if (sheet.hidden) {
            return;
        }
        const prefs = readTabPrefs();
        const start = el("select", { class: "field", title: "the tab shown when the page is opened" }) as HTMLSelectElement;
        replace(start,
            el("option", { value: "last" }, "the last one shown"),
            ...PAGES.map((page) => el("option", { value: page.id }, page.label)),
        );
        start.value = prefs.start;
        start.addEventListener("change", () => setTabs({ start: start.value as TabPrefs["start"] }));

        const fold = el("input", { type: "checkbox" }) as HTMLInputElement;
        fold.checked = prefs.fold;
        fold.addEventListener("change", () => setTabs({ fold: fold.checked }));

        const shownTabs = PAGES.map((page) => {
            const box = el("input", { type: "checkbox" }) as HTMLInputElement;
            box.checked = !prefs.hidden.includes(page.id);
            box.addEventListener("change", () => {
                const hidden = new Set(readTabPrefs().hidden);
                if (box.checked) {
                    hidden.delete(page.id);
                } else {
                    hidden.add(page.id);
                }
                setTabs({ hidden: PAGES.map((entry) => entry.id).filter((id) => hidden.has(id)) });
            });
            return el("label", { class: "check", title: "a tab left out opens from More at the bar's end" }, box, ` ${page.label}`);
        });

        const layout = el("select", { class: "field", "aria-label": "Panel layout", title: "a kept arrangement of every page's panels" }) as HTMLSelectElement;
        fillLayouts(layout);
        layout.addEventListener("change", () => {
            if (layout.value !== UNKEPT) {
                panels.applyPreset(layout.value);
            }
        });
        const current = panels.currentPreset();
        const remove = el("button", { type: "button", class: "btn btn-small btn-quiet" }, "Delete");
        remove.title = "forget the layout picked";
        if (current === null || current === DEFAULT_PRESET) {
            remove.disabled = true;
            remove.dataset["reason"] = current === DEFAULT_PRESET ? "Default is built in" : "pick a kept layout first";
        }
        remove.addEventListener("click", () => {
            if (current !== null && current !== DEFAULT_PRESET) {
                panels.deletePreset(current);
            }
        });
        const name = el("input", { type: "text", class: "field", placeholder: "name", "aria-label": "Layout name", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
        name.value = current !== null && current !== DEFAULT_PRESET ? current : "";
        const problem = el("p", { class: "hint page-settings-problem", role: "status" });
        const keep = el("button", { type: "button", class: "btn btn-small" }, "Keep as");
        keep.title = "keep every page's layout under the name, replacing one of that name";
        const saveAs = (): void => {
            const said = panels.savePreset(name.value);
            if (said !== null) {
                problem.textContent = said;
            }
        };
        keep.addEventListener("click", saveAs);
        name.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                saveAs();
            }
        });

        const edit = el("button", { type: "button", class: "btn btn-small btn-toggle", "aria-pressed": String(panels.editing()) }, "Edit panels");
        edit.title = "show grips to drag panels between columns and onto each other";
        // Editing takes the sheet away, so the panels under it can be dragged.
        edit.addEventListener("click", () => {
            const on = !panels.editing();
            if (on) {
                close(false);
            }
            panels.setEditing(on);
        });
        const page = currentPage();
        const label = PAGES.find((entry) => entry.id === page)!.label;
        const reset = el("button", { type: "button", class: "btn btn-small btn-quiet" }, `Reset ${label}`);
        reset.title = "put this page's panels back as they first were";
        reset.addEventListener("click", () => panels.resetPage(page));

        const hidden = panels.hiddenPanels();
        const hiddenList = hidden.length === 0
            ? el("p", { class: "muted hint" }, "No panel is hidden.")
            : el("ul", { class: "page-settings-hidden" }, ...hidden.map((panel) => {
                const show = el("button", { type: "button", class: "btn btn-small" }, "Show");
                show.addEventListener("click", () => panels.showPanel(panel.id));
                const where = PAGES.find((entry) => entry.id === panel.page)?.label ?? panel.page;
                return el("li", {}, el("span", {}, `${panel.title} `, el("span", { class: "muted" }, `(${where})`)), show);
            }));

        replace(sheet,
            el("div", { class: "panel-head" }, el("h2", {}, "Page settings")),
            el("div", { class: "stack" },
                el("h3", {}, "Tabs"),
                labeled("Open on", start, "labeled inline"),
                el("label", { class: "check", title: "the bar opens on hover, or on a press of the strip" }, fold, " Fold the tab bar to a strip"),
                el("div", { class: "page-settings-tabs", title: "a tab left out opens from More at the bar's end" }, ...shownTabs),
                el("h3", {}, "Panels"),
                el("div", { class: "button-row" }, labeled("Layout", layout, "labeled inline"), remove),
                el("div", { class: "button-row" }, name, keep),
                problem,
                el("div", { class: "button-row" }, edit, reset),
                el("h3", {}, "Hidden panels"),
                hiddenList,
            ),
        );
    }

    function open(): void {
        closeMenu(false);
        sheet.hidden = false;
        gear.setAttribute("aria-expanded", "true");
        tools.closest(".tabs")?.setAttribute("data-open", "");
        drawSheet();
        sheet.querySelector<HTMLElement>("select, input, button")?.focus({ preventScroll: true });
    }

    function close(restoreFocus: boolean): void {
        if (sheet.hidden) {
            return;
        }
        sheet.hidden = true;
        gear.setAttribute("aria-expanded", "false");
        if (restoreFocus) {
            gear.focus({ preventScroll: true });
        }
    }

    gear.addEventListener("click", () => (sheet.hidden ? open() : close(true)));
    document.addEventListener("pointerdown", (event) => {
        const target = event.target as Node | null;
        if (!sheet.hidden && target && !sheet.contains(target) && !gear.contains(target)) {
            close(false);
        }
    }, true);
    // Escape closes the sheet wherever the focus is: a control pressed in
    // it may have been drawn again, leaving the focus on the page.
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !sheet.hidden) {
            event.preventDefault();
            event.stopPropagation();
            close(true);
        }
    }, true);
    sheet.addEventListener("keydown", (event) => {
        // The jog keys listen on the document; a key meant for a box or a
        // pick here stops short of them.
        if (event.key.startsWith("Arrow") || event.key === " ") {
            event.stopPropagation();
        }
    });

    panels.onChange(() => {
        drawBar();
        drawSheet();
    });
    onPage(() => drawSheet());
    drawBar();
}
