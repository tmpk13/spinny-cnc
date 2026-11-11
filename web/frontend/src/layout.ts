// The panels' layout on a page: which column each panel is in and in what
// order, panels stacked into one place (one shown at a time, the others as
// tabs over it), panels stuck together (drawn as one block with no gap and
// moved as one), and each panel's own state: folded, hidden by the
// operator, or held at a fixed height. A layout also gives the columns'
// widths. The page's markup is the default layout; what the operator
// changes is kept per browser, and layouts can be saved under a name and
// brought back (presets). Pure functions over plain data, so they can be
// tested without a page; src/views/panels.ts puts a layout on the page.
//
// A column is a list of blocks, a block a list of stacks stuck together,
// and a stack a list of panel ids. A panel alone is a stack of one in a
// block of one. Every function returns a new layout and leaves the one it
// was given alone.

export interface Stack {
    /** The panels in the stack, in the order their tabs show. */
    ids: string[];
    /** The panel shown; the others are tabs over it. */
    front: string;
}

/** Stacks stuck together: no gap between them, and a move moves them all. */
export type Block = Stack[];

/** What the operator set on one panel; a field left out is the panel's own way. */
export interface PanelPrefs {
    /** Folded to its head. */
    collapsed?: boolean;
    /** Taken off the page until shown again from the page settings. */
    hidden?: boolean;
    /** A fixed height in rem; the panel scrolls within it. */
    height?: number;
}

export interface PageLayout {
    /** Each column's blocks, top to bottom. */
    columns: Block[][];
    /** Each column's share of the page's width (they sum to 1); null for the stylesheet's widths. */
    widths: number[] | null;
    /** The panels the operator set something on, by id. */
    panels: Record<string, PanelPrefs>;
}

/** Where a panel is: its column, its block in the column, its stack in the block, and its place in the stack. */
export interface Place {
    column: number;
    block: number;
    stack: number;
    index: number;
}

/** Whether a panel shows on the page; a move steps over panels that do not. */
export type Shown = (id: string) => boolean;

/** The smallest and largest fixed height kept, in rem. */
export const MIN_HEIGHT = 4;
export const MAX_HEIGHT = 200;
/** The narrowest share of the page's width a column keeps. */
export const MIN_WIDTH = 0.08;

const always: Shown = () => true;

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function single(id: string): Block {
    return [{ ids: [id], front: id }];
}

function copy(layout: PageLayout): PageLayout {
    return {
        columns: layout.columns.map((column) => column.map((block) => block.map((stack) => ({ ids: [...stack.ids], front: stack.front })))),
        widths: layout.widths ? [...layout.widths] : null,
        panels: Object.fromEntries(Object.entries(layout.panels).map(([id, prefs]) => [id, { ...prefs }])),
    };
}

/** The markup's layout: every panel alone, in the markup's columns and order. */
export function defaultLayout(columns: string[][]): PageLayout {
    return { columns: columns.map((ids) => ids.map(single)), widths: null, panels: {} };
}

/** The panels of each column in the order they are drawn, stacks and blocks flattened. */
export function columnIds(layout: PageLayout): string[][] {
    return layout.columns.map((column) => column.flatMap((block) => block.flatMap((stack) => stack.ids)));
}

export function locate(layout: PageLayout, id: string): Place | null {
    for (const [column, blocks] of layout.columns.entries()) {
        for (const [block, stacks] of blocks.entries()) {
            for (const [stack, entry] of stacks.entries()) {
                const index = entry.ids.indexOf(id);
                if (index >= 0) {
                    return { column, block, stack, index };
                }
            }
        }
    }
    return null;
}

/** Whether any panel of a block shows. */
function blockShown(block: Block, shown: Shown): boolean {
    return block.some((stack) => stack.ids.some(shown));
}

/**
 * Puts a panel the layout does not hold where the markup has it: in its
 * column, before the first block holding a panel the markup puts after it.
 */
function insertDefault(columns: Block[][], id: string, defaults: string[][]): void {
    const column = defaults.findIndex((ids) => ids.includes(id));
    if (column < 0 || column >= columns.length) {
        return;
    }
    const later = new Set(defaults[column]!.slice(defaults[column]!.indexOf(id) + 1));
    const blocks = columns[column]!;
    const at = blocks.findIndex((block) => block.some((stack) => stack.ids.some((other) => later.has(other))));
    blocks.splice(at < 0 ? blocks.length : at, 0, single(id));
}

function cleanPrefs(raw: unknown): PanelPrefs {
    const prefs: PanelPrefs = {};
    if (!isObject(raw)) {
        return prefs;
    }
    if (raw["collapsed"] === true) {
        prefs.collapsed = true;
    }
    if (raw["hidden"] === true) {
        prefs.hidden = true;
    }
    const height = raw["height"];
    if (typeof height === "number" && Number.isFinite(height)) {
        prefs.height = Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, height)) * 100) / 100;
    }
    return prefs;
}

/** Shares that sum to 1, each at least MIN_WIDTH; null for anything that is not one positive number per column. */
export function cleanWidths(raw: unknown, count: number): number[] | null {
    if (!Array.isArray(raw) || raw.length !== count || count < 2) {
        return null;
    }
    if (!raw.every((value) => typeof value === "number" && Number.isFinite(value) && value > 0)) {
        return null;
    }
    const values = raw as number[];
    const total = values.reduce((sum, v) => sum + v, 0);
    // Shares already rounded sum to 1 within the rounding; dividing them
    // again would move their last digit on every read.
    let shares = Math.abs(total - 1) < 1e-3 ? [...values] : values.map((value) => value / total);
    // Raising the narrow ones to the floor takes the room from the others.
    for (let pass = 0; pass < count && shares.some((share) => share < MIN_WIDTH - 1e-9); pass++) {
        const floored = shares.map((share) => Math.max(share, MIN_WIDTH));
        const extra = floored.reduce((sum, v) => sum + v, 0) - 1;
        const free = floored.reduce((sum, v) => sum + (v > MIN_WIDTH ? v - MIN_WIDTH : 0), 0);
        shares = floored.map((share) => (share > MIN_WIDTH && free > 0 ? share - extra * (share - MIN_WIDTH) / free : share));
    }
    return shares.map((share) => Math.round(share * 10000) / 10000);
}

/**
 * A layout read back from storage made to fit the page as it is now:
 * panels no longer on the page dropped, panels the stored layout does not
 * hold put where the markup has them, columns past the page's last folded
 * into it, and anything malformed left out. Nothing stored (null, or not a
 * layout) gives the markup's layout.
 */
export function normalizeLayout(raw: unknown, defaults: string[][]): PageLayout {
    const known = new Set(defaults.flat());
    const seen = new Set<string>();
    const columns: Block[][] = defaults.map(() => []);
    const stored = isObject(raw) && Array.isArray(raw["columns"]) ? raw["columns"] as unknown[] : [];
    for (const [index, rawColumn] of stored.entries()) {
        const target = columns[Math.min(index, columns.length - 1)];
        if (!target || !Array.isArray(rawColumn)) {
            continue;
        }
        for (const rawBlock of rawColumn) {
            if (!Array.isArray(rawBlock)) {
                continue;
            }
            const block: Block = [];
            for (const rawStack of rawBlock) {
                const rawIds = isObject(rawStack) && Array.isArray(rawStack["ids"]) ? rawStack["ids"] as unknown[] : [];
                const ids: string[] = [];
                for (const id of rawIds) {
                    if (typeof id === "string" && known.has(id) && !seen.has(id)) {
                        seen.add(id);
                        ids.push(id);
                    }
                }
                if (ids.length > 0) {
                    const front = isObject(rawStack) && typeof rawStack["front"] === "string" && ids.includes(rawStack["front"]) ? rawStack["front"] : ids[0]!;
                    block.push({ ids, front });
                }
            }
            if (block.length > 0) {
                target.push(block);
            }
        }
    }
    for (const ids of defaults) {
        for (const id of ids) {
            if (!seen.has(id)) {
                seen.add(id);
                insertDefault(columns, id, defaults);
            }
        }
    }
    const panels: Record<string, PanelPrefs> = {};
    const rawPanels = isObject(raw) && isObject(raw["panels"]) ? raw["panels"] : {};
    for (const id of [...known].sort()) {
        const prefs = cleanPrefs(rawPanels[id]);
        if (Object.keys(prefs).length > 0) {
            panels[id] = prefs;
        }
    }
    const widths = isObject(raw) ? cleanWidths(raw["widths"], columns.length) : null;
    return { columns, widths, panels };
}

/** Whether the panels sit as the markup has them: every one alone, in its column and order. */
export function sameArrangement(layout: PageLayout, defaults: string[][]): boolean {
    if (layout.columns.length !== defaults.length) {
        return false;
    }
    return layout.columns.every((blocks, column) => {
        const ids = defaults[column]!;
        return blocks.length === ids.length && blocks.every((block, index) => block.length === 1 && block[0]!.ids.length === 1 && block[0]!.ids[0] === ids[index]);
    });
}

/** Whether a layout is the markup's in every respect. */
export function isDefault(layout: PageLayout, defaults: string[][]): boolean {
    return sameArrangement(layout, defaults) && layout.widths === null && Object.keys(layout.panels).length === 0;
}

/**
 * The layout as it is stored: the same layout every time for the same
 * arrangement (ids sorted, nothing empty), and null for the markup's, which
 * is not stored at all.
 */
export function canonicalLayout(layout: PageLayout, defaults: string[][]): PageLayout | null {
    const clean = normalizeLayout(layout, defaults);
    return isDefault(clean, defaults) ? null : clean;
}

function mapStack(layout: PageLayout, id: string, change: (stack: Stack) => void): PageLayout {
    const next = copy(layout);
    const place = locate(next, id);
    if (place) {
        change(next.columns[place.column]![place.block]![place.stack]!);
    }
    return next;
}

/** Shows a panel of its stack in front. */
export function bringToFront(layout: PageLayout, id: string): PageLayout {
    return mapStack(layout, id, (stack) => {
        stack.front = id;
    });
}

/**
 * Moves the panel's block (everything stuck to it) past the next block up
 * (step -1) or down (step 1) in its column that shows anything; blocks of
 * panels not shown that lie between are stepped over.
 */
export function moveBlock(layout: PageLayout, id: string, step: -1 | 1, shown: Shown = always): PageLayout {
    const place = locate(layout, id);
    if (!place) {
        return layout;
    }
    const blocks = layout.columns[place.column]!;
    let target = place.block + step;
    while (target >= 0 && target < blocks.length && !blockShown(blocks[target]!, shown)) {
        target += step;
    }
    if (target < 0 || target >= blocks.length) {
        return layout;
    }
    const next = copy(layout);
    const column = next.columns[place.column]!;
    const [block] = column.splice(place.block, 1);
    // Taken out below the target (moving up), the block goes in at the
    // target's index, before it; taken out above it (moving down), the
    // target has shifted up by one, so the same index is after it.
    column.splice(target, 0, block!);
    return next;
}

/**
 * Moves the panel's block into the column to the left (step -1) or right
 * (step 1), at the same place counted in blocks, or at the column's end
 * when it holds fewer.
 */
export function moveToColumn(layout: PageLayout, id: string, step: -1 | 1): PageLayout {
    const place = locate(layout, id);
    if (!place) {
        return layout;
    }
    const target = place.column + step;
    if (target < 0 || target >= layout.columns.length) {
        return layout;
    }
    const next = copy(layout);
    const [block] = next.columns[place.column]!.splice(place.block, 1);
    const column = next.columns[target]!;
    column.splice(Math.min(place.block, column.length), 0, block!);
    return next;
}

/**
 * Moves the panel's block into `column` before the block that holds
 * `before`, or to the column's end for null; a drop on the block itself
 * changes nothing.
 */
export function placeBlock(layout: PageLayout, id: string, column: number, before: string | null): PageLayout {
    const place = locate(layout, id);
    if (!place || column < 0 || column >= layout.columns.length) {
        return layout;
    }
    if (before !== null) {
        const at = locate(layout, before);
        if (!at || (at.column === place.column && at.block === place.block)) {
            return layout;
        }
    }
    const next = copy(layout);
    const [block] = next.columns[place.column]!.splice(place.block, 1);
    const blocks = next.columns[column]!;
    const at = before === null ? null : locate(next, before);
    blocks.splice(at === null ? blocks.length : at.block, 0, block!);
    return next;
}

/** Takes a stack out of its block; a block left empty goes too. */
function takeStack(next: PageLayout, place: Place): Stack {
    const blocks = next.columns[place.column]!;
    const block = blocks[place.block]!;
    const [stack] = block.splice(place.stack, 1);
    if (block.length === 0) {
        blocks.splice(place.block, 1);
    }
    return stack!;
}

/**
 * Stacks the panel's stack with the stack holding `target`: its panels join
 * that stack at its end, and the panel moved is the one shown.
 */
export function stackOnto(layout: PageLayout, id: string, target: string): PageLayout {
    const from = locate(layout, id);
    const to = locate(layout, target);
    if (!from || !to || (from.column === to.column && from.block === to.block && from.stack === to.stack)) {
        return layout;
    }
    const next = copy(layout);
    const moved = takeStack(next, from);
    const place = locate(next, target)!;
    const stack = next.columns[place.column]![place.block]![place.stack]!;
    stack.ids.push(...moved.ids);
    stack.front = id;
    return next;
}

/**
 * The panel shown in front of the nearest stack above (step -1) or below
 * (step 1) the panel's own in its column that shows anything, for stacking
 * with; null when there is none.
 */
export function stackNeighbor(layout: PageLayout, id: string, step: -1 | 1, shown: Shown = always): string | null {
    const place = locate(layout, id);
    if (!place) {
        return null;
    }
    const stacks = layout.columns[place.column]!.flat();
    const own = stacks.findIndex((stack) => stack.ids.includes(id));
    for (let index = own + step; index >= 0 && index < stacks.length; index += step) {
        const stack = stacks[index]!;
        const visible = stack.ids.filter(shown);
        if (visible.length > 0) {
            return visible.includes(stack.front) ? stack.front : visible[0]!;
        }
    }
    return null;
}

/** Takes the panel out of its stack into a block of its own right after the stack's block. */
export function unstack(layout: PageLayout, id: string): PageLayout {
    const place = locate(layout, id);
    if (!place || layout.columns[place.column]![place.block]![place.stack]!.ids.length < 2) {
        return layout;
    }
    const next = copy(layout);
    const blocks = next.columns[place.column]!;
    const stack = blocks[place.block]![place.stack]!;
    stack.ids.splice(place.index, 1);
    if (stack.front === id) {
        stack.front = stack.ids[Math.min(place.index, stack.ids.length - 1)]!;
    }
    blocks.splice(place.block + 1, 0, single(id));
    return next;
}

/**
 * Sticks the panel's block under the nearest block above it that shows
 * anything: the two become one block. Blocks of panels not shown in
 * between are moved under the joined block.
 */
export function stick(layout: PageLayout, id: string, shown: Shown = always): PageLayout {
    const place = locate(layout, id);
    if (!place) {
        return layout;
    }
    const blocks = layout.columns[place.column]!;
    let target = place.block - 1;
    while (target >= 0 && !blockShown(blocks[target]!, shown)) {
        target -= 1;
    }
    if (target < 0) {
        return layout;
    }
    const next = copy(layout);
    const column = next.columns[place.column]!;
    const [block] = column.splice(place.block, 1);
    column[target]!.push(...block!);
    return next;
}

/** Whether the panel's stack is stuck to a stack above it in its block. */
export function isStuck(layout: PageLayout, id: string): boolean {
    const place = locate(layout, id);
    return place !== null && place.stack > 0;
}

/** Parts the panel's stack, and the stacks under it in its block, from the stacks above it. */
export function unstick(layout: PageLayout, id: string): PageLayout {
    const place = locate(layout, id);
    if (!place || place.stack === 0) {
        return layout;
    }
    const next = copy(layout);
    const column = next.columns[place.column]!;
    const rest = column[place.block]!.splice(place.stack);
    column.splice(place.block + 1, 0, rest);
    return next;
}

/** Sets the operator's state of a panel: given fields replace, an undefined (or false) one is cleared. */
export function setPrefs(layout: PageLayout, id: string, prefs: PanelPrefs): PageLayout {
    const next = copy(layout);
    const merged = cleanPrefs({ ...next.panels[id], ...prefs });
    for (const key of Object.keys(prefs) as (keyof PanelPrefs)[]) {
        if (prefs[key] === undefined) {
            delete merged[key];
        }
    }
    if (Object.keys(merged).length > 0) {
        next.panels[id] = merged;
    } else {
        delete next.panels[id];
    }
    return next;
}

/** Sets the columns' shares of the page's width, or null for the stylesheet's. */
export function setWidths(layout: PageLayout, widths: number[] | null): PageLayout {
    const next = copy(layout);
    next.widths = widths === null ? null : cleanWidths(widths, next.columns.length);
    return next;
}

/**
 * Puts one panel back as the markup has it: out of any stack or block, in
 * its column before the first block holding a panel the markup puts after
 * it, with nothing the operator set on it.
 */
export function resetPanel(layout: PageLayout, id: string, defaults: string[][]): PageLayout {
    const place = locate(layout, id);
    if (!place) {
        return layout;
    }
    const next = copy(layout);
    const stack = next.columns[place.column]![place.block]![place.stack]!;
    if (stack.ids.length > 1) {
        stack.ids.splice(place.index, 1);
        if (stack.front === id) {
            stack.front = stack.ids[0]!;
        }
    } else {
        takeStack(next, place);
    }
    insertDefault(next.columns, id, defaults);
    delete next.panels[id];
    return next;
}

// --- many pages, and the layouts kept by name --------------------------------

/** The layouts of several pages by page id, as stored: only pages that differ from their markup. */
export type Layouts = Record<string, PageLayout>;

/** The name of the markup's own layout, which cannot be saved over or deleted. */
export const DEFAULT_PRESET = "Default";

/** Reads stored JSON as an object, or an empty one for nothing stored or text that is not an object. */
export function readObject(text: string | null): Record<string, unknown> {
    if (text === null) {
        return {};
    }
    try {
        const value: unknown = JSON.parse(text);
        return isObject(value) ? value : {};
    } catch {
        return {};
    }
}

/**
 * The layouts of the pages in `defaults` (page id to the markup's columns)
 * in their stored form: each made to fit its page, the markup's left out,
 * pages in the order `defaults` lists them.
 */
export function canonicalLayouts(raw: Record<string, unknown>, defaults: Record<string, string[][]>): Layouts {
    const out: Layouts = {};
    for (const [page, columns] of Object.entries(defaults)) {
        const layout = canonicalLayout(normalizeLayout(raw[page] ?? null, columns), columns);
        if (layout) {
            out[page] = layout;
        }
    }
    return out;
}

/** The names kept (Default first), each a layout of the pages by page id. */
export function readPresets(text: string | null): Record<string, Record<string, unknown>> {
    const raw = readObject(text);
    const out: Record<string, Record<string, unknown>> = {};
    for (const [name, value] of Object.entries(raw)) {
        if (name.trim() !== "" && name.toLowerCase() !== DEFAULT_PRESET.toLowerCase() && isObject(value)) {
            out[name] = value;
        }
    }
    return out;
}

/** Why a name cannot be saved under, or null when it can. */
export function presetNameProblem(name: string): string | null {
    const trimmed = name.trim();
    if (trimmed === "") {
        return "name the layout";
    }
    if (trimmed.toLowerCase() === DEFAULT_PRESET.toLowerCase()) {
        return "Default is the built-in layout; pick another name";
    }
    if (trimmed.length > 40) {
        return "name: at most 40 characters";
    }
    return null;
}

/** The kept name whose layouts are the ones given, Default for the markup's everywhere, or null for none. */
export function matchingPreset(current: Layouts, presets: Record<string, Record<string, unknown>>, defaults: Record<string, string[][]>): string | null {
    const shown = JSON.stringify(current);
    if (shown === "{}") {
        return DEFAULT_PRESET;
    }
    for (const [name, layouts] of Object.entries(presets)) {
        if (JSON.stringify(canonicalLayouts(layouts, defaults)) === shown) {
            return name;
        }
    }
    return null;
}
