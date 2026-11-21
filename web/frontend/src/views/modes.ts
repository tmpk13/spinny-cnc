// The mode in use put on the page (src/modes.ts says what a mode is). The
// layout layer draws the panels; this keeps each mode's layouts as they
// were last left, puts another mode's on the page when it is picked, and
// tells the rail which areas the mode leaves nothing to show. The pick is
// a select at the top bar's left (mountModePick); the page settings keep,
// reset and delete modes through the same controller.
//
// A mode picked goes to the area it opens on (Run for a use mode, the
// Setup side for a config one); All panels stays where the page is. An
// area the mode in use leaves blank is never the one shown after a pick
// or a reload.

import { el, readStored, replace, writeStored } from "../dom.ts";
import {
    ALL_PANELS,
    baseLayouts,
    builtInOf,
    matchingMode,
    migratedModes,
    MODES_KEY,
    modeChanged,
    modeExists,
    modeList,
    modeName,
    modeNameProblem,
    modeOpens,
    OLD_PRESETS_KEY,
    ownKey,
    ownNameOf,
    parseModes,
    withWorking,
    workingLayouts,
    type ModeEntry,
    type Modes,
} from "../modes.ts";
import type { PanelsController } from "./panels.ts";
import { firstShown, frontSide, isBlank, setBlankPages, showPage, shownOn, type PageId } from "./tabs.ts";

export interface ModesController {
    /** The modes to pick from: the built-in ones, then the operator's. */
    list(): ModeEntry[];
    /** The key of the mode in use. */
    current(): string;
    /** A mode's name, as the pick shows it. */
    name(key: string): string;
    /** Puts a mode on the page, as its layouts were last left, and goes to the area it opens on. */
    pick(key: string): void;
    /** Whether the mode in use has changes kept: its panels are not as it has them itself. */
    changed(): boolean;
    /** Puts every area back as the mode in use has it itself. */
    reset(): void;
    /** Puts one area back as the mode in use has it itself. */
    resetPage(page: string): void;
    /** Keeps the panels as they are as a mode of the operator's under a name (over one of that name); the problem with the name, or null when kept. */
    keep(name: string): string | null;
    /** Forgets a mode of the operator's; in use, All panels takes its place. */
    remove(key: string): void;
    /** Hears every change of the mode in use, its changes and the modes kept. */
    onChange(listener: () => void): void;
}

/**
 * Mounts the modes over the layout layer: the mode kept as in use, with
 * the panels as the layer drew them taken as that mode's as last left.
 * The first time, the layouts kept by name before there were modes become
 * the operator's own modes, and the mode in use is the one the panels are
 * laid out as, else All panels.
 */
export function mountModes(panels: PanelsController): ModesController {
    const listeners: (() => void)[] = [];
    let modes: Modes = parseModes(readStored(MODES_KEY)) ?? firstModes();

    function firstModes(): Modes {
        const fresh = migratedModes(readStored(OLD_PRESETS_KEY));
        return { ...fresh, current: matchingMode(panels.layouts(), fresh, panels.defaults()) ?? ALL_PANELS };
    }

    function save(): void {
        writeStored(MODES_KEY, JSON.stringify(modes));
    }

    function notify(): void {
        for (const listener of listeners) {
            listener();
        }
    }

    /** The panels as drawn kept as the mode in use's; the rail told what is blank. */
    function follow(): void {
        modes = withWorking(modes, modes.current, panels.layouts(), panels.defaults());
        save();
        setBlankPages(panels.blankPages());
        notify();
    }

    /** Away from an area left blank: to the one the mode opens on, else the first with something to show. */
    function leaveBlank(opens: PageId | null): void {
        const shown = shownOn(frontSide());
        if (opens !== null && !isBlank(opens)) {
            showPage(opens);
        } else if (isBlank(shown)) {
            showPage(firstShown());
        }
    }

    panels.onChange(follow);
    follow();
    leaveBlank(null);

    const api: ModesController = {
        list: () => modeList(modes),
        current: () => modes.current,
        name: (key) => modeName(key, modes),
        pick(key) {
            if (!modeExists(key, modes)) {
                return;
            }
            if (key !== modes.current) {
                modes = { ...modes, current: key };
                // The layer hears it and calls follow(), which keeps the layouts as this mode's.
                panels.setLayouts(workingLayouts(key, modes, panels.defaults()));
            }
            leaveBlank(modeOpens(key, modes));
            notify();
        },
        changed: () => modeChanged(modes.current, modes),
        reset() {
            panels.setLayouts(baseLayouts(modes.current, modes, panels.defaults()));
        },
        resetPage(page) {
            const next: Record<string, unknown> = { ...panels.layouts() };
            const own = baseLayouts(modes.current, modes, panels.defaults())[page];
            if (own) {
                next[page] = own;
            } else {
                delete next[page];
            }
            panels.setLayouts(next);
        },
        keep(name) {
            const problem = modeNameProblem(name);
            if (problem !== null) {
                return problem;
            }
            const trimmed = name.trim();
            const key = ownKey(trimmed);
            const working = { ...modes.working };
            delete working[key];
            modes = { current: key, own: { ...modes.own, [trimmed]: { layouts: panels.layouts(), page: shownOn(frontSide()) } }, working };
            save();
            notify();
            return null;
        },
        remove(key) {
            const name = ownNameOf(key);
            if (name === null || !Object.hasOwn(modes.own, name)) {
                return;
            }
            const own = { ...modes.own };
            delete own[name];
            const working = { ...modes.working };
            delete working[key];
            const inUse = modes.current === key;
            modes = { ...modes, own, working, current: inUse ? ALL_PANELS : modes.current };
            if (inUse) {
                panels.setLayouts(workingLayouts(ALL_PANELS, modes, panels.defaults()));
                leaveBlank(null);
            }
            save();
            notify();
        },
        onChange(listener) {
            listeners.push(listener);
        },
    };
    return api;
}

/** The pick's tooltip: what the mode in use is for, and whether it has changes kept. */
export function modeTitle(modes: ModesController): string {
    const key = modes.current();
    const tip = builtInOf(key)?.tip ?? "a mode of your own: the panels as you kept them";
    return `Mode: ${tip}${modes.changed() ? ". Changed since: Page settings puts it back" : ""}`;
}

/** The select of the mode in use, in `host` (the top bar). */
export function mountModePick(host: HTMLElement, modes: ModesController): HTMLSelectElement {
    const pick = el("select", { class: "field mode-pick", "aria-label": "Mode" }) as HTMLSelectElement;
    host.append(pick);
    pick.addEventListener("change", () => modes.pick(pick.value));
    const draw = (): void => fillModes(pick, modes);
    modes.onChange(draw);
    draw();
    return pick;
}

/** Fills a select with the modes, the one in use picked and marked when it has changes kept. */
export function fillModes(select: HTMLSelectElement, modes: ModesController): void {
    const current = modes.current();
    const option = (entry: ModeEntry): HTMLOptionElement => el("option", { value: entry.key, title: entry.tip }, entry.key === current && modes.changed() ? `${entry.name} (changed)` : entry.name) as HTMLOptionElement;
    const entries = modes.list();
    const own = entries.filter((entry) => entry.own);
    replace(select,
        ...(own.length === 0
            ? entries.map(option)
            : [el("optgroup", { label: "Built in" }, ...entries.filter((entry) => !entry.own).map(option)), el("optgroup", { label: "Yours" }, ...own.map(option))]),
    );
    select.value = current;
    select.title = modeTitle(modes);
}
