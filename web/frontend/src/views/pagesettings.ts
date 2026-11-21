// The page settings, behind a gear at the right end of the tab bar: the
// tab the page opens on, the tab bar folding to a strip, and the tabs kept
// out of the bar; the mode in use (src/views/modes.ts), put back as it has
// its panels itself, a mode of one's own kept from the panels as they are
// or deleted; the edit mode that drags panels about, the area's panels put
// back as the mode has them, and the panels hidden, each to show again.
// Beside the gear, in edit mode, a Done editing button ends it. An eye beside the
// gear, while any panel is hidden, shows the hidden panels for a while
// (marked as hidden) and hides them again; two arrows scroll the column
// last pointed at to its top or its end. The look: the page's own fonts or
// the system's, whether changes move into place, and whether each page's
// tab and panels wear its color. Everything here is
// kept in this browser; the peek is not.

import { popUp } from "../dismiss.ts";
import { el, labeled, replace, setLocked, svgIcon } from "../dom.ts";
import { readLook, writeLook, type Look } from "../look.ts";
import { closeMenu } from "../menu.ts";
import { ownNameOf } from "../modes.ts";
import { fillModes, type ModesController } from "./modes.ts";
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

/**
 * Mounts the gear and its sheet in `tools`. `modes` gives the sheet its
 * Mode part; left out (a test of the panels alone), an area's reset puts
 * it back as the page first lays it out.
 */
export function mountPageSettings(tools: HTMLElement, panels: PanelsController, modes: ModesController | null = null): void {
    const gear = el("button", { type: "button", class: "tabs-gear", "aria-label": "Page settings", "aria-haspopup": "dialog", "aria-expanded": "false", "data-label": "Settings", title: "page settings" });
    gear.append(svgIcon(gearPath(), true));
    const done = el("button", { type: "button", class: "btn btn-small btn-primary tabs-done", title: "stop editing the panels" }, "Done editing");
    const peek = el("button", { type: "button", class: "tabs-tool tabs-peek", "aria-label": "Show hidden panels", "aria-pressed": "false", "data-label": "Hidden panels" });
    peek.append(svgIcon(EYE, true));
    peek.addEventListener("click", () => panels.setPeeking(!panels.peeking()));
    const toTop = el("button", { type: "button", class: "tabs-tool tabs-scroll", "aria-label": "Scroll to the top", title: "scroll the column last pointed at to its top" });
    toTop.append(svgIcon(TO_TOP));
    toTop.addEventListener("click", () => panels.scrollColumn("top"));
    const toEnd = el("button", { type: "button", class: "tabs-tool tabs-scroll", "aria-label": "Scroll to the end", title: "scroll the column last pointed at to its end" });
    toEnd.append(svgIcon(TO_END));
    toEnd.addEventListener("click", () => panels.scrollColumn("end"));
    const sheet = el("div", { class: "panel page-settings", role: "dialog", "aria-label": "Page settings" });
    sheet.hidden = true;
    tools.append(done, toTop, toEnd, peek, gear, sheet);

    function drawBar(): void {
        done.hidden = !panels.editing();
        // The eye shows while a panel is hidden, or while it is pressed.
        const hidden = panels.hiddenPanels().length;
        if (hidden === 0 && panels.peeking()) {
            panels.setPeeking(false);
            return;
        }
        peek.hidden = hidden === 0;
        // The count of panels hidden, drawn at the eye's corner.
        if (hidden > 0) {
            peek.dataset["count"] = String(hidden);
        } else {
            delete peek.dataset["count"];
        }
        peek.setAttribute("aria-pressed", String(panels.peeking()));
        peek.title = panels.peeking() ? "hide the hidden panels again" : `show the ${hidden} hidden panel${hidden === 1 ? "" : "s"} for now`;
    }

    done.addEventListener("click", () => panels.setEditing(false));

    function setTabs(change: Partial<TabPrefs>): void {
        writeTabPrefs({ ...readTabPrefs(), ...change });
        drawSheet();
    }

    function currentPage(): PageId {
        const id = document.getElementById("app")?.getAttribute("data-page");
        return PAGES.find((page) => page.id === id)?.id ?? "job";
    }

    /** The sheet's content, drawn again from the settings whenever it opens or they change. */
    function drawSheet(): void {
        if (sheet.hidden) {
            return;
        }
        const prefs = readTabPrefs();
        const start = el("select", { class: "field", title: "the tab shown when the page is opened" }) as HTMLSelectElement;
        replace(start,
            el("option", { value: "last" }, "last shown"),
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

        const modeRows = modes ? modeSettings(modes) : [];

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
        reset.title = modes ? `put this area's panels back as ${modes.name(modes.current())} has them` : "put this area's panels back as they first were";
        reset.addEventListener("click", () => {
            if (modes) {
                modes.resetPage(page);
            } else {
                const next: Record<string, unknown> = { ...panels.layouts() };
                delete next[page];
                panels.setLayouts(next);
            }
        });

        const hidden = panels.hiddenPanels();
        const hiddenList = hidden.length === 0
            ? el("p", { class: "muted hint" }, "None.")
            : el("ul", { class: "page-settings-hidden" }, ...hidden.map((panel) => {
                const show = el("button", { type: "button", class: "btn btn-small" }, "Show");
                show.addEventListener("click", () => panels.showPanel(panel.id));
                const where = PAGES.find((entry) => entry.id === panel.page)?.label ?? panel.page;
                return el("li", {}, el("span", {}, `${panel.title} `, el("span", { class: "muted" }, `(${where})`)), show);
            }));

        const look = readLook();
        const setLook = (change: Partial<Look>): void => {
            writeLook({ ...readLook(), ...change });
            drawSheet();
        };
        const fonts = el("select", { class: "field", title: "the page's own fonts, served with it, or the ones this computer has" }) as HTMLSelectElement;
        replace(fonts,
            el("option", { value: "page" }, "Inter and JetBrains Mono"),
            el("option", { value: "system" }, "the system's"),
        );
        fonts.value = look.fonts;
        fonts.addEventListener("change", () => setLook({ fonts: fonts.value === "system" ? "system" : "page" }));
        const motion = el("input", { type: "checkbox" }) as HTMLInputElement;
        motion.checked = look.motion === "on";
        motion.addEventListener("change", () => setLook({ motion: motion.checked ? "on" : "off" }));
        const colors = el("input", { type: "checkbox" }) as HTMLInputElement;
        colors.checked = look.colors === "on";
        colors.addEventListener("change", () => setLook({ colors: colors.checked ? "on" : "off" }));

        replace(sheet,
            el("div", { class: "panel-head" }, el("h2", {}, "Page settings")),
            el("div", { class: "stack" },
                el("h3", {}, "Tabs"),
                labeled("Open on", start, "labeled inline"),
                el("label", { class: "check", title: "the bar opens on hover, or on a press of the strip" }, fold, " Fold the tab bar"),
                el("div", { class: "page-settings-tabs", title: "a tab left out opens from More at the bar's end" }, ...shownTabs),
                ...modeRows,
                el("h3", {}, "Panels"),
                el("div", { class: "button-row" }, edit, reset),
                el("h3", {}, modes ? `Hidden in ${modes.name(modes.current())}` : "Hidden panels"),
                hiddenList,
                el("h3", {}, "Look"),
                labeled("Fonts", fonts, "labeled inline"),
                el("label", { class: "check", title: "panels unfolding, a stack's panel coming forward, menus and pages opening, the turning marks; off, everything simply appears, as with the system's reduced motion" }, motion, " Animate the page"),
                el("label", { class: "check", title: "each page's own color under its tab and along the top of its panels" }, colors, " Colors for tabs and panels"),
            ),
        );
    }

    /**
     * The sheet's Mode part: the mode in use, put back as it has its
     * panels itself, deleted when it is one of the operator's, and the
     * panels as they are kept as a mode of one's own under a name.
     */
    function modeSettings(controller: ModesController): HTMLElement[] {
        const key = controller.current();
        const name = controller.name(key);
        const pick = el("select", { class: "field", "aria-label": "Mode" }) as HTMLSelectElement;
        fillModes(pick, controller);
        pick.addEventListener("change", () => controller.pick(pick.value));
        const reset = el("button", { type: "button", class: "btn btn-small btn-quiet" }, `Reset ${name}`);
        reset.title = `put every area's panels back as ${name} has them`;
        setLocked(reset, !controller.changed(), `${name} has its panels as it has them already`);
        reset.addEventListener("click", () => controller.reset());
        const own = ownNameOf(key) !== null;
        const remove = el("button", { type: "button", class: "btn btn-small btn-quiet" }, `Delete ${name}`);
        remove.title = "forget this mode of yours; All panels takes its place";
        remove.hidden = !own;
        remove.addEventListener("click", () => controller.remove(key));
        const field = el("input", { type: "text", class: "field", placeholder: "name", "aria-label": "Mode name", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
        field.value = own ? name : "";
        const problem = el("p", { class: "hint page-settings-problem", role: "status" });
        const keep = el("button", { type: "button", class: "btn btn-small" }, "Keep as");
        keep.title = "keep every area's panels as they are now as a mode of yours, under the name (replacing one of yours of that name)";
        const keepAs = (): void => {
            const said = controller.keep(field.value);
            if (said !== null) {
                problem.textContent = said;
            }
        };
        keep.addEventListener("click", keepAs);
        field.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                keepAs();
            }
        });
        return [
            el("h3", {}, "Mode"),
            el("div", { class: "button-row" }, labeled("Mode", pick, "labeled inline"), reset, remove),
            el("div", { class: "button-row" }, field, keep),
            problem,
        ];
    }

    let release: (() => void) | null = null;

    function open(): void {
        closeMenu(false);
        sheet.hidden = false;
        gear.setAttribute("aria-expanded", "true");
        release ??= popUp({ nodes: () => [sheet, gear], close: () => close(false) });
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
        release?.();
        release = null;
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
        // pick here stops short of them, PageUp and PageDown (a mill's Z) too.
        if (event.key.startsWith("Arrow") || event.key === "PageUp" || event.key === "PageDown" || event.key === " ") {
            event.stopPropagation();
        }
    });

    panels.onChange(() => {
        drawBar();
        drawSheet();
    });
    modes?.onChange(() => drawSheet());
    onPage(() => drawSheet());
    drawBar();
}
