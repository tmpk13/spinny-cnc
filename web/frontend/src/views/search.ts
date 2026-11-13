// Finding a feature by a few letters of its name: a magnifier in the tab
// bar (or "/" or Ctrl+K with no field in use) opens a box; what is typed
// is matched loosely against every page, every panel and every button the
// page has, in the order of the letters (so "hmprb" finds "Height map:
// Probe"), and the best matches are listed. Picking one shows its page and
// panel (unhidden, unfolded, in front of its stack, pulsing); a button is
// given the focus, not pressed, so a search never moves the machine.

import { popUp } from "../dismiss.ts";
import { el, replace, svgIcon } from "../dom.ts";
import { closeInfoTip } from "./infotip.ts";
import { goToPanel } from "./steps.ts";
import { PAGES, showPage, type PageId } from "./tabs.ts";

/** A thing the search can take the operator to. */
export interface Feature {
    kind: "page" | "panel" | "button";
    /** What the list shows: the button's or panel's name. */
    label: string;
    /** Where it is: "Jobs" or "Jobs > Height map". */
    where: string;
    /** Words matched besides the label: a button's tooltip. */
    more: string;
    page: PageId;
    /** The panel's id; the button sits in it. */
    panel: string | null;
    /** The button itself. */
    node: HTMLElement | null;
}

/** How many matches the box lists. */
export const SHOWN = 12;

/**
 * How well `query` matches `text`, loosely: every letter of the query in
 * order, case aside; null when one is missing. Higher is better: letters
 * that follow each other, and ones that start a word, count more, and a
 * match that starts early counts more than one late.
 */
export function fuzzyScore(query: string, text: string): number | null {
    const want = query.toLowerCase().replace(/\s+/g, "");
    if (want === "") {
        return 0;
    }
    const have = text.toLowerCase();
    let score = 0;
    let at = 0;
    let last = -2;
    for (const letter of want) {
        const found = have.indexOf(letter, at);
        if (found < 0) {
            return null;
        }
        score += 1;
        if (found === last + 1) {
            score += 3;
        }
        if (found === 0 || /[^a-z0-9]/.test(have[found - 1]!)) {
            score += 2;
        }
        if (last < 0) {
            score -= Math.min(found, 10) * 0.1;
        }
        last = found;
        at = found + 1;
    }
    return score;
}

/**
 * A feature's whole path, as its tooltip in the list gives it: the page,
 * the panel and the button ("Jobs > Height map > Probe"), then what the
 * button's own tooltip says of it, where it has one. The list cuts a long
 * path short; hovering a match shows it whole.
 */
export function featurePath(feature: Feature): string {
    const path = feature.kind === "page" ? `${feature.label} tab` : `${feature.where} > ${feature.label}`;
    return feature.more.trim() === "" ? path : `${path}: ${feature.more.trim()}`;
}

/** The features matching `query`, best first: the label weighs most, then where it is, then its tooltip. */
export function rankFeatures(features: Feature[], query: string, count = SHOWN): Feature[] {
    const scored: { feature: Feature; score: number }[] = [];
    for (const feature of features) {
        const label = fuzzyScore(query, feature.label);
        const where = fuzzyScore(query, `${feature.where} ${feature.label}`);
        const more = fuzzyScore(query, `${feature.label} ${feature.more}`);
        const best = Math.max(label === null ? -Infinity : label + 2, where ?? -Infinity, more === null ? -Infinity : more - 2);
        if (best > -Infinity) {
            scored.push({ feature, score: best + (feature.kind === "button" ? 0 : 0.5) });
        }
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, count).map((entry) => entry.feature);
}

function titleOf(panel: HTMLElement): string {
    return panel.getAttribute("aria-label") ?? panel.querySelector("h2")?.textContent ?? panel.id;
}

/** Every page, panel and button on the page now, as the search knows them. */
export function collectFeatures(root: ParentNode = document): Feature[] {
    const features: Feature[] = [];
    for (const page of PAGES) {
        features.push({ kind: "page", label: page.label, where: "tab", more: page.tip, page: page.id, panel: null, node: null });
        const main = root.querySelector(`#page-${page.id}`);
        if (!main) {
            continue;
        }
        for (const panel of Array.from(main.querySelectorAll<HTMLElement>("section.panel[id]"))) {
            const name = titleOf(panel);
            features.push({ kind: "panel", label: name, where: page.label, more: "", page: page.id, panel: panel.id, node: null });
            const seen = new Set<string>();
            for (const press of Array.from(panel.querySelectorAll<HTMLElement>("button"))) {
                // The layer's own head buttons are no features of the panel,
                // nor are the setup steps' numbered stops.
                if ((press.closest(".panel-head-tools") && !press.closest(".panel-head .button-row")) || press.closest(".roadmap")) {
                    continue;
                }
                const label = (press.getAttribute("aria-label") ?? press.textContent ?? "").trim().replace(/\s+/g, " ");
                if (label === "" || seen.has(label)) {
                    continue;
                }
                seen.add(label);
                features.push({ kind: "button", label, where: `${page.label} > ${name}`, more: press.title, page: page.id, panel: panel.id, node: press });
            }
        }
    }
    return features;
}

/** A magnifier: a ring and its handle. */
const LENS = "M6.5 1.5a5 5 0 1 0 3.1 8.9l3.7 3.7l1.1 -1.1l-3.7 -3.7a5 5 0 0 0 -4.2 -7.8zM6.5 3a3.5 3.5 0 1 1 0 7a3.5 3.5 0 0 1 0 -7z";

/** Takes the page to a feature: its page, its panel shown and pulsing, a button given the focus. */
export function goToFeature(feature: Feature): void {
    if (feature.panel === null) {
        showPage(feature.page);
        return;
    }
    goToPanel(feature.panel);
    feature.node?.focus({ preventScroll: false });
}

export function mountSearch(tools: HTMLElement): void {
    const lens = el("button", { type: "button", class: "tabs-tool tabs-search", "aria-label": "Find a feature", "aria-haspopup": "dialog", title: "find a feature by name (/ or Ctrl+K)" });
    lens.append(svgIcon(LENS, true));
    const input = el("input", { type: "search", class: "field search-input", placeholder: "find a feature", "aria-label": "Feature", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
    const list = el("ul", { class: "search-list", role: "listbox", "aria-label": "Matches" });
    const sheet = el("div", { class: "panel search-sheet", role: "dialog", "aria-label": "Find a feature" }, input, list);
    sheet.hidden = true;
    tools.prepend(lens, sheet);
    let features: Feature[] = [];
    let matches: Feature[] = [];
    let active = 0;
    let release: (() => void) | null = null;

    function draw(): void {
        matches = input.value.trim() === "" ? [] : rankFeatures(features, input.value);
        active = Math.min(active, Math.max(0, matches.length - 1));
        replace(list, ...matches.map((feature, index) => {
            const item = el("li", { class: "search-item", role: "option", "aria-selected": String(index === active), title: featurePath(feature) },
                el("span", { class: "search-label" }, feature.label),
                el("span", { class: "muted search-where" }, feature.kind === "page" ? "tab" : feature.where),
            );
            item.addEventListener("pointerdown", (event) => {
                event.preventDefault();
                pick(feature);
            });
            return item;
        }));
        if (input.value.trim() !== "" && matches.length === 0) {
            list.append(el("li", { class: "muted search-none" }, "nothing by that name"));
        }
    }

    function open(): void {
        closeInfoTip();
        features = collectFeatures();
        sheet.hidden = false;
        lens.setAttribute("aria-expanded", "true");
        release ??= popUp({ nodes: () => [sheet, lens], close });
        input.value = "";
        active = 0;
        draw();
        input.focus();
    }

    function close(): void {
        sheet.hidden = true;
        lens.setAttribute("aria-expanded", "false");
        release?.();
        release = null;
    }

    function pick(feature: Feature): void {
        close();
        goToFeature(feature);
    }

    lens.addEventListener("click", () => (sheet.hidden ? open() : close()));
    input.addEventListener("input", () => {
        active = 0;
        draw();
    });
    input.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            event.stopPropagation();
            if (matches.length > 0) {
                active = (active + (event.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length;
                draw();
            }
        } else if (event.key === "Enter") {
            event.preventDefault();
            const feature = matches[active];
            if (feature) {
                pick(feature);
            }
        } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close();
            lens.focus();
        }
    });
    document.addEventListener("pointerdown", (event) => {
        const target = event.target as Node | null;
        if (!sheet.hidden && target && !sheet.contains(target) && !lens.contains(target)) {
            close();
        }
    }, true);
    document.addEventListener("keydown", (event) => {
        if (event.defaultPrevented || event.altKey || event.metaKey) {
            return;
        }
        const field = document.activeElement;
        const typing = field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement || (field as HTMLElement | null)?.isContentEditable === true;
        if ((event.key === "/" && !event.ctrlKey && !typing) || (event.ctrlKey && event.key.toLowerCase() === "k")) {
            event.preventDefault();
            open();
        }
    });
}
