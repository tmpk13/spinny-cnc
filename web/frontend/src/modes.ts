// The modes: arrangements of every area's panels, each for one kind of
// work (placing parts, setting up a pick and place machine, running a
// laser job), picked from the top bar. A mode says which panels show and
// where they sit; an area it leaves nothing to show drops out of the rail.
// A few modes are built in (All panels is every panel, as the page first
// lays them out); the operator keeps others under names of their own, made
// from the panels as they are.
//
// Each mode keeps the changes made while it shows (a panel hidden, moved,
// folded, a column's width) until it is reset, so going to another mode
// and back loses nothing. What is stored, under MODES_KEY: the mode in
// use, the operator's own modes (each one's layouts and the area it opens
// on), and the changes kept for each mode, by its key: a built-in mode's
// id, or OWN and the name for one of the operator's. Pure functions over
// plain data; src/views/modes.ts puts a mode on the page.

import { arrangedLayout, canonicalLayouts, readObject, sameLayouts, type Arrangement, type Defaults, type Layouts } from "./layout.ts";
import { pageNamed, type PageId } from "./views/tabs.ts";

export const MODES_KEY = "spinny.modes";
/** Where the page kept named layouts before there were modes: read once, each becoming a mode of the operator's own. */
export const OLD_PRESETS_KEY = "spinny.layout.presets";
/** The longest name a mode of the operator's takes. */
export const MODE_NAME_MAX = 40;
/** Before the name in the key of a mode of the operator's. */
export const OWN = "own:";

export interface BuiltInMode {
    id: string;
    name: string;
    /** What it is for, in a phrase: the pick's tooltip. */
    tip: string;
    /** The area shown when the mode is picked; left out, the area shown stays. */
    opens?: PageId;
    /** How it arranges each area; an area left out shows every panel as the page first lays them out. */
    pages: Partial<Record<PageId, Arrangement>>;
}

/** A mode of the operator's own: every area's layout as it was kept, and the area it opens on. */
export interface OwnMode {
    layouts: Record<string, unknown>;
    page: PageId | null;
}

/** What is kept of the modes. */
export interface Modes {
    /** The key of the mode in use. */
    current: string;
    /** The operator's own modes, by name. */
    own: Record<string, OwnMode>;
    /** Each mode's layouts as last left, by key, where they differ from the mode's own. */
    working: Record<string, Record<string, unknown>>;
}

/** One line of the pick: a mode's key, its name and what it is for. */
export interface ModeEntry {
    key: string;
    name: string;
    tip: string;
    own: boolean;
}

/**
 * Each area's panels, by id, as index.html has them. A built-in mode hides
 * by these lists, so a panel added to the page later shows in every mode
 * until a mode says otherwise; a test holds the lists to the markup.
 */
export const PAGE_PANELS: Record<PageId, readonly string[]> = {
    home: ["overview", "home-needs", "home-jobs"],
    job: ["jobs", "job", "preview", "jobjson", "mill-operation", "job-machine", "auto-chat", "auto-about"],
    run: ["machine", "steps", "run-preview", "camera-view", "pnp-view", "pnp-top-view", "place", "console", "pnp-parts", "pnp-board", "heightmap", "pnp-feeders", "run"],
    facts: ["facts", "tests"],
    machines: ["connection", "machine-file", "openpnp-import", "settings"],
    cameras: [
        "camera-picture", "camera", "camera-controls", "camera-sight", "camera-changes", "pnp-nozzle",
        "pnp-camera-picture", "pnp-camera", "pnp-camera-controls", "pnp-camera-sight", "pnp-camera-changes",
        "pnp-top-picture", "pnp-top", "pnp-top-controls", "pnp-top-sight", "pnp-top-changes",
        "pnp-head", "pnp-machine-view",
    ],
    cam: ["cam", "cam-file"],
    ui: ["version", "reports", "plugins"],
};

/** An area showing these panels in these columns (an id, or a stack's ids), its others hidden. */
function only(page: PageId, columns: (string | string[])[][], folded: string[] = []): Arrangement {
    const named = new Set(columns.flat(2));
    return { columns, hidden: PAGE_PANELS[page].filter((id) => !named.has(id)), folded };
}

/** An area with none of its panels shown: it leaves the rail. */
function none(page: PageId): Arrangement {
    return { hidden: PAGE_PANELS[page] };
}

/** The key of All panels, the mode a browser starts in. */
export const ALL_PANELS = "all";

/**
 * The modes the page comes with. A use mode shows the work of a run and
 * leaves the Setup side's areas out but for the page's own; a config mode
 * shows what sets the machine up, and the Run area's jog and pictures to
 * do it with. The laser's modes serve a mill as well: its heights, its
 * spindle and its jobs are in the same panels.
 */
export const BUILT_IN_MODES: readonly BuiltInMode[] = [
    {
        id: ALL_PANELS,
        name: "All panels",
        tip: "every panel of every area, as the page first lays them out",
        pages: {},
    },
    {
        id: "laser-use",
        name: "Laser/mill use",
        tip: "run a job on a laser or a mill: the jobs, the machine, where the board sits, the heights and the run",
        opens: "run",
        pages: {
            run: only("run", [["machine"], [["run-preview", "camera-view"], "place", "console"], ["heightmap", "run"]], ["console"]),
            facts: none("facts"),
            machines: none("machines"),
            cameras: none("cameras"),
            cam: none("cam"),
        },
    },
    {
        id: "laser-config",
        name: "Laser/mill config",
        tip: "set up a laser or a mill: its file and the firmware's keys, the head camera, the heights, the checklist and the tests",
        opens: "facts",
        pages: {
            job: none("job"),
            run: only("run", [["machine"], [["camera-view", "run-preview"], "console"], ["heightmap", "run"]], ["console"]),
            machines: only("machines", [["connection", "machine-file"], ["settings"]]),
            cameras: only("cameras", [["camera"], ["camera-picture"], [["camera-controls", "camera-sight", "camera-changes"]]]),
        },
    },
    {
        id: "pnp-use",
        name: "PNP use",
        tip: "place parts with a pick and place machine: the board and its parts, where it sits, the feeders and the run",
        opens: "run",
        pages: {
            job: none("job"),
            run: only("run", [["machine"], [["pnp-top-view", "pnp-view"], "pnp-board", "place", "console"], ["pnp-parts", "pnp-feeders", "run"]], ["console"]),
            facts: none("facts"),
            machines: none("machines"),
            cameras: none("cameras"),
            cam: none("cam"),
        },
    },
    {
        id: "pnp-config",
        name: "PNP config",
        tip: "set up a pick and place machine: its file, the top and bottom cameras and the nozzle, the head and the bed, the feeders",
        opens: "cameras",
        pages: {
            job: none("job"),
            run: only("run", [["machine"], [["pnp-top-view", "pnp-view"], "console"], ["pnp-feeders"]], ["console"]),
            cameras: only("cameras", [
                [["pnp-top", "pnp-top-controls", "pnp-top-sight", "pnp-top-changes"], ["pnp-camera", "pnp-camera-controls", "pnp-camera-sight", "pnp-camera-changes"], "pnp-nozzle"],
                [["pnp-top-picture", "pnp-camera-picture"]],
                ["pnp-head", "pnp-machine-view"],
            ]),
            cam: none("cam"),
        },
    },
];

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The key of the operator's mode of this name. */
export function ownKey(name: string): string {
    return `${OWN}${name}`;
}

/** The built-in mode a key names; null for any other key. */
export function builtInOf(key: string): BuiltInMode | null {
    return BUILT_IN_MODES.find((mode) => mode.id === key) ?? null;
}

/** The name in the key of one of the operator's modes; null for any other key. */
export function ownNameOf(key: string): string | null {
    return key.startsWith(OWN) ? key.slice(OWN.length) : null;
}

/** Whether a key names a mode there is: built in, or one of the operator's. */
export function modeExists(key: string, modes: Modes): boolean {
    const name = ownNameOf(key);
    return builtInOf(key) !== null || (name !== null && Object.hasOwn(modes.own, name));
}

/** A mode's name as the pick shows it. */
export function modeName(key: string, modes: Modes): string {
    return builtInOf(key)?.name ?? (ownNameOf(key) !== null && modeExists(key, modes) ? ownNameOf(key)! : key);
}

/** The area a mode opens on; null to stay on the area shown. */
export function modeOpens(key: string, modes: Modes): PageId | null {
    const name = ownNameOf(key);
    return builtInOf(key)?.opens ?? (name !== null ? modes.own[name]?.page ?? null : null);
}

/** The pick's lines: the built-in modes in their order, then the operator's by name. */
export function modeList(modes: Modes): ModeEntry[] {
    const built = BUILT_IN_MODES.map((mode) => ({ key: mode.id, name: mode.name, tip: mode.tip, own: false }));
    const own = Object.keys(modes.own).sort((a, b) => a.localeCompare(b))
        .map((name) => ({ key: ownKey(name), name, tip: "a mode of your own: the panels as you kept them", own: true }));
    return [...built, ...own];
}

/** Why a mode cannot be kept under a name, or null when it can; a name of the operator's may be kept over. */
export function modeNameProblem(name: string): string | null {
    const trimmed = name.trim();
    if (trimmed === "") {
        return "name the mode";
    }
    if (trimmed.length > MODE_NAME_MAX) {
        return `name: at most ${MODE_NAME_MAX} characters`;
    }
    const built = BUILT_IN_MODES.find((mode) => mode.name.toLowerCase() === trimmed.toLowerCase() || mode.id === trimmed.toLowerCase());
    if (built) {
        return `${built.name} is built in; pick another name`;
    }
    return null;
}

/** A fresh start: All panels in use, no mode of the operator's, nothing changed. */
export function freshModes(): Modes {
    return { current: ALL_PANELS, own: {}, working: {} };
}

/** The modes kept in stored text; null for nothing stored or text that is not modes. Anything malformed in it is left out. */
export function parseModes(text: string | null): Modes | null {
    if (text === null) {
        return null;
    }
    const raw = readObject(text);
    if (typeof raw["current"] !== "string") {
        return null;
    }
    const modes = freshModes();
    if (isObject(raw["own"])) {
        for (const [name, value] of Object.entries(raw["own"])) {
            if (modeNameProblem(name) !== null || name !== name.trim() || !isObject(value) || !isObject(value["layouts"])) {
                continue;
            }
            const page = typeof value["page"] === "string" ? pageNamed(value["page"]) : null;
            modes.own[name] = { layouts: value["layouts"], page };
        }
    }
    if (isObject(raw["working"])) {
        for (const [key, value] of Object.entries(raw["working"])) {
            if (modeExists(key, modes) && isObject(value)) {
                modes.working[key] = value;
            }
        }
    }
    modes.current = modeExists(raw["current"], modes) ? raw["current"] : ALL_PANELS;
    return modes;
}

/** The layouts kept by name before there were modes, each a mode of the operator's own; anything malformed left out. */
export function migratedModes(presetsText: string | null): Modes {
    const modes = freshModes();
    for (const [name, value] of Object.entries(readObject(presetsText))) {
        const trimmed = name.trim();
        // Default was the name of the page's own layout then: All panels now.
        if (modeNameProblem(trimmed) === null && trimmed.toLowerCase() !== "default" && isObject(value) && !Object.hasOwn(modes.own, trimmed)) {
            modes.own[trimmed] = { layouts: value, page: null };
        }
    }
    return modes;
}

/** A mode's own layouts: a built-in mode's arrangements, or what the operator kept; every area as the page lays it out for a key that names no mode. */
export function baseLayouts(key: string, modes: Modes, defaults: Record<string, Defaults>): Layouts {
    const built = builtInOf(key);
    if (built) {
        const raw: Record<string, unknown> = {};
        for (const [page, arrangement] of Object.entries(built.pages)) {
            const columns = defaults[page];
            if (columns && arrangement) {
                raw[page] = arrangedLayout(arrangement, columns);
            }
        }
        return canonicalLayouts(raw, defaults);
    }
    const name = ownNameOf(key);
    return canonicalLayouts(name !== null ? modes.own[name]?.layouts ?? {} : {}, defaults);
}

/** A mode's layouts as last left: its changes where it has any, else its own. */
export function workingLayouts(key: string, modes: Modes, defaults: Record<string, Defaults>): Layouts {
    const working = modes.working[key];
    return working !== undefined ? canonicalLayouts(working, defaults) : baseLayouts(key, modes, defaults);
}

/** Keeps `layouts` as a mode's as left: as its changes, or as nothing when they are its own. */
export function withWorking(modes: Modes, key: string, layouts: Record<string, unknown>, defaults: Record<string, Defaults>): Modes {
    const working = { ...modes.working };
    if (sameLayouts(layouts, baseLayouts(key, modes, defaults), defaults)) {
        delete working[key];
    } else {
        working[key] = canonicalLayouts(layouts, defaults);
    }
    return { ...modes, working };
}

/** Whether a mode has changes kept: its panels are not as it has them itself. */
export function modeChanged(key: string, modes: Modes): boolean {
    return modes.working[key] !== undefined;
}

/** The mode whose own layouts are these, of the built-in ones first, then the operator's; null for none. */
export function matchingMode(layouts: Record<string, unknown>, modes: Modes, defaults: Record<string, Defaults>): string | null {
    return modeList(modes).find((entry) => sameLayouts(layouts, baseLayouts(entry.key, modes, defaults), defaults))?.key ?? null;
}
