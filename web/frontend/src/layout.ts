// The panels' layout on a page: which column each panel is in and in what
// order, panels stacked into one place (one shown at a time, the others as
// tabs over it), panels stuck together (drawn as one block with no gap and
// moved as one), and each panel's own state: folded, hidden by the
// operator, or held at a fixed height. A layout also gives the columns'
// widths. The page's markup is the default layout; a mode (src/modes.ts)
// arranges a page its own way, and what the operator changes is kept per
// browser with the mode. Pure functions over plain data, so they can be
// tested without a page; src/views/panels.ts puts a layout on the page.
//
// A column is a list of blocks, a block a list of stacks stuck together,
// and a stack a list of panel ids. A panel alone is a stack of one in a
// block of one. A block may be a folder: it has a name, and folds and
// moves as one. What belongs to a block (side by side, its folder's name,
// the folder shut) is kept on the panel heading it, the first of its first
// stack, and passes to the next one when that panel leaves. The markup may
// stack panels from the start (Defaults' `stacked`) and put panels in
// folders (`stuck`, `folders`). Every function returns a new layout and
// leaves the one it was given alone.

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
    /** On the first panel of a block: its stacks sit side by side rather than one above another. */
    row?: boolean;
    /** On the first panel of a block: the block is a folder of this name, which folds and moves as one. */
    folder?: string;
    /** On the first panel of a folder's block: the folder is folded to its head. */
    shut?: boolean;
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

/**
 * The markup's layout of a page: each column's panel ids in order, the
 * panels it stacks from the start (`stacked`: a panel's id to the id of the
 * panel whose stack it joins, which the markup puts before it), and its
 * folders: `stuck`, a panel's id to the id of the panel heading the block
 * it joins, and `folders`, a heading panel's id to its folder's name.
 * Plain columns of ids stack nothing and have no folders.
 */
export type Defaults = string[][] & { stacked?: Record<string, string>; stuck?: Record<string, string>; folders?: Record<string, string> };

/** Columns of ids with the panels the markup stacks, and the folders it makes. */
export function withStacks(columns: string[][], stacked: Record<string, string>, stuck: Record<string, string> = {}, folders: Record<string, string> = {}): Defaults {
    return Object.assign(columns.map((ids) => [...ids]), { stacked: { ...stacked }, stuck: { ...stuck }, folders: { ...folders } });
}

/** The longest name a folder takes. */
export const FOLDER_NAME_MAX = 40;

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

/** The markup's layout: every panel alone, in the markup's columns and order, but for the ones it stacks and puts in folders. */
export function defaultLayout(columns: Defaults): PageLayout {
    const blocks: Block[][] = columns.map(() => []);
    for (const ids of columns) {
        for (const id of ids) {
            insertDefault(blocks, id, columns);
        }
    }
    return { columns: blocks, widths: null, panels: defaultPrefs(columns) };
}

/** What the markup sets on its panels: its folders' names, on the panels heading them, by id in order. */
function defaultPrefs(defaults: Defaults): Record<string, PanelPrefs> {
    const known = new Set(defaults.flat());
    return Object.fromEntries(Object.entries(defaults.folders ?? {})
        .filter(([id, name]) => known.has(id) && cleanName(name) !== null)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([id, name]) => [id, { folder: cleanName(name)! }]));
}

/** A folder's name as kept: trimmed, and at most FOLDER_NAME_MAX letters; null for none. */
function cleanName(raw: unknown): string | null {
    if (typeof raw !== "string") {
        return null;
    }
    const name = raw.trim().slice(0, FOLDER_NAME_MAX).trim();
    return name === "" ? null : name;
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
 * Puts a panel the layout does not hold where the markup has it: into the
 * stack of the panel the markup stacks it with, wherever that one is now,
 * at its end; else in its column, before the first block holding a panel
 * the markup puts after it.
 */
function insertDefault(columns: Block[][], id: string, defaults: Defaults): void {
    const partner = defaults.stacked?.[id];
    if (partner !== undefined) {
        for (const blocks of columns) {
            for (const block of blocks) {
                const stack = block.find((entry) => entry.ids.includes(partner));
                if (stack) {
                    stack.ids.push(id);
                    return;
                }
            }
        }
    }
    // A panel of a markup folder goes in the block of the panel heading
    // it, wherever that is now, as a stack of its own at its end.
    const head = defaults.stuck?.[id];
    if (head !== undefined) {
        for (const blocks of columns) {
            for (const block of blocks) {
                if (block.some((entry) => entry.ids.includes(head))) {
                    block.push({ ids: [id], front: id });
                    return;
                }
            }
        }
    }
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
    if (raw["row"] === true) {
        prefs.row = true;
    }
    const folder = cleanName(raw["folder"]);
    if (folder !== null) {
        prefs.folder = folder;
    }
    if (raw["shut"] === true) {
        prefs.shut = true;
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
export function normalizeLayout(raw: unknown, defaults: Defaults): PageLayout {
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
    // Nothing stored: the markup's own folders.
    const rawPanels = isObject(raw) && isObject(raw["panels"]) ? raw["panels"] : isObject(raw) ? {} : defaultPrefs(defaults);
    // What belongs to a block stays only on a panel heading one.
    const heads = new Set(columns.flatMap((blocks) => blocks.map((block) => block[0]!.ids[0]!)));
    for (const id of [...known].sort()) {
        const prefs = cleanPrefs(rawPanels[id]);
        if (!heads.has(id)) {
            for (const key of BLOCK_PREFS) {
                delete prefs[key];
            }
        }
        if (prefs.folder === undefined) {
            delete prefs.shut;
        }
        if (Object.keys(prefs).length > 0) {
            panels[id] = prefs;
        }
    }
    const widths = isObject(raw) ? cleanWidths(raw["widths"], columns.length) : null;
    return { columns, widths, panels };
}

/** The panels' places, without which panel of a stack is in front. */
function shape(columns: Block[][]): string {
    return JSON.stringify(columns.map((blocks) => blocks.map((block) => block.map((stack) => stack.ids))));
}

/** Whether the panels sit as the markup has them: in its columns and order, alone but for the stacks it makes. */
export function sameArrangement(layout: PageLayout, defaults: Defaults): boolean {
    return shape(layout.columns) === shape(defaultLayout(defaults).columns);
}

/** Whether a layout is the markup's in every respect, each stack showing its first panel and each folder of the markup's open. */
export function isDefault(layout: PageLayout, defaults: Defaults): boolean {
    return sameArrangement(layout, defaults)
        && layout.columns.every((blocks) => blocks.every((block) => block.every((stack) => stack.front === stack.ids[0])))
        && layout.widths === null
        && JSON.stringify(layout.panels) === JSON.stringify(defaultPrefs(defaults));
}

/**
 * The layout as it is stored: the same layout every time for the same
 * arrangement (ids sorted, nothing empty), and null for the markup's, which
 * is not stored at all.
 */
export function canonicalLayout(layout: PageLayout, defaults: Defaults): PageLayout | null {
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

/** The prefs that belong to a block rather than to a panel, kept on the panel heading it. */
const BLOCK_PREFS = ["row", "folder", "shut"] as const;

/**
 * Passes what belongs to a block from the panel that headed it to the one
 * heading it now (`to`), or takes it away with null (the block is gone, or
 * the panel joined another block).
 */
function passBlockPrefs(layout: PageLayout, from: string, to: string | null): void {
    const prefs = layout.panels[from];
    if (!prefs || from === to) {
        return;
    }
    const carried: PanelPrefs = {};
    for (const key of BLOCK_PREFS) {
        if (prefs[key] !== undefined) {
            Object.assign(carried, { [key]: prefs[key] });
            delete prefs[key];
        }
    }
    if (Object.keys(prefs).length === 0) {
        delete layout.panels[from];
    }
    if (to !== null && Object.keys(carried).length > 0) {
        layout.panels[to] = { ...layout.panels[to], ...carried };
    }
}

/** Takes a stack out of its block; a block left empty goes too. The block's own prefs stay with what is left of it. */
function takeStack(next: PageLayout, place: Place): Stack {
    const blocks = next.columns[place.column]!;
    const block = blocks[place.block]!;
    const [stack] = block.splice(place.stack, 1);
    if (block.length === 0) {
        blocks.splice(place.block, 1);
    }
    if (place.stack === 0) {
        passBlockPrefs(next, stack!.ids[0]!, block[0]?.ids[0] ?? null);
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

/**
 * Takes a stack apart: every panel of the panel's stack but the first in a
 * block of its own, in the stack's order, right after the stack's block.
 */
export function unstackAll(layout: PageLayout, id: string): PageLayout {
    const place = locate(layout, id);
    if (!place) {
        return layout;
    }
    const ids = layout.columns[place.column]![place.block]![place.stack]!.ids;
    let next = layout;
    for (const other of ids.slice(1).reverse()) {
        next = unstack(next, other);
    }
    return next;
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
    if (place.stack === 0 && place.index === 0) {
        passBlockPrefs(next, id, stack.ids[0]!);
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
    // The block joins the one above, which keeps what is its own.
    passBlockPrefs(next, block![0]!.ids[0]!, null);
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
    // The parted stacks are a block of their own, one above another, and
    // no folder.
    for (const other of rest.flatMap((stack) => stack.ids)) {
        passBlockPrefs(next, other, null);
    }
    return next;
}

function clearRow(layout: PageLayout, id: string): void {
    const prefs = layout.panels[id];
    if (prefs?.row) {
        delete prefs.row;
        if (Object.keys(prefs).length === 0) {
            delete layout.panels[id];
        }
    }
}

/** Whether a block lays its stacks side by side: it has more than one, and its first panel says so. */
export function blockIsRow(layout: PageLayout, block: Block): boolean {
    const first = block[0]?.ids[0];
    return block.length > 1 && first !== undefined && layout.panels[first]?.row === true;
}

/** Whether the panel's block lays its stacks side by side. */
export function isRow(layout: PageLayout, id: string): boolean {
    const place = locate(layout, id);
    return place !== null && blockIsRow(layout, layout.columns[place.column]![place.block]!);
}

/**
 * Lays the panel's block side by side (`on`) or one above another. The
 * flag lives on the block's first panel; any other panel of the block
 * loses it.
 */
export function setRow(layout: PageLayout, id: string, on: boolean): PageLayout {
    const place = locate(layout, id);
    if (!place) {
        return layout;
    }
    const next = copy(layout);
    const block = next.columns[place.column]![place.block]!;
    for (const other of block.flatMap((stack) => stack.ids)) {
        clearRow(next, other);
    }
    if (on && block.length > 1) {
        const first = block[0]!.ids[0]!;
        next.panels[first] = { ...next.panels[first], row: true };
    }
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
 * Puts one panel back as the markup has it: out of any stack or block,
 * into the stack or the folder the markup puts it in or else in its column
 * before the first block holding a panel the markup puts after it, with
 * nothing the operator set on it. A folder it headed goes on under the
 * panel heading it next.
 */
export function resetPanel(layout: PageLayout, id: string, defaults: Defaults): PageLayout {
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
        if (place.stack === 0 && place.index === 0) {
            passBlockPrefs(next, id, stack.ids[0]!);
        }
    } else {
        takeStack(next, place);
    }
    insertDefault(next.columns, id, defaults);
    delete next.panels[id];
    return next;
}

// --- folders -------------------------------------------------------------------

/** A folder: the panel heading its block, its name, and whether it is shut. */
export interface Folder {
    head: string;
    name: string;
    shut: boolean;
}

/** The folder a block is, or null for a block that is none. */
export function blockFolder(layout: PageLayout, block: Block): Folder | null {
    const head = block[0]?.ids[0];
    const name = head === undefined ? undefined : layout.panels[head]?.folder;
    return head === undefined || name === undefined ? null : { head, name, shut: layout.panels[head]?.shut === true };
}

/** The folder a panel is in, or null. */
export function folderOf(layout: PageLayout, id: string): Folder | null {
    const place = locate(layout, id);
    return place === null ? null : blockFolder(layout, layout.columns[place.column]![place.block]!);
}

/** The folders of a page, column by column, top to bottom, with each one's column. */
export function foldersOf(layout: PageLayout): (Folder & { column: number })[] {
    return layout.columns.flatMap((blocks, column) => blocks
        .map((block) => blockFolder(layout, block))
        .filter((folder): folder is Folder => folder !== null)
        .map((folder) => ({ ...folder, column })));
}

/** Why a name cannot be a folder's, or null when it can. */
export function folderNameProblem(name: string): string | null {
    if (name.trim() === "") {
        return "name the folder";
    }
    if (name.trim().length > FOLDER_NAME_MAX) {
        return `name: at most ${FOLDER_NAME_MAX} characters`;
    }
    return null;
}

/** Makes the panel's block a folder of `name`, or renames the folder it is; a name that cannot be one changes nothing. */
export function nameFolder(layout: PageLayout, id: string, name: string): PageLayout {
    const place = locate(layout, id);
    const clean = cleanName(name);
    if (place === null || clean === null || folderNameProblem(name) !== null) {
        return layout;
    }
    const next = copy(layout);
    const head = next.columns[place.column]![place.block]![0]!.ids[0]!;
    next.panels[head] = { ...next.panels[head], folder: clean };
    return next;
}

/** Shuts the folder the panel is in (folds it to its head), or opens it. */
export function shutFolder(layout: PageLayout, id: string, shut: boolean): PageLayout {
    const folder = folderOf(layout, id);
    return folder === null ? layout : setPrefs(layout, folder.head, { shut: shut || undefined });
}

/** Takes apart the folder the panel is in: each of its stacks a block of its own, in order, and no folder any more. */
export function ungroup(layout: PageLayout, id: string): PageLayout {
    const place = locate(layout, id);
    if (place === null) {
        return layout;
    }
    const next = copy(layout);
    const blocks = next.columns[place.column]!;
    const block = blocks[place.block]!;
    passBlockPrefs(next, block[0]!.ids[0]!, null);
    blocks.splice(place.block, 1, ...block.map((stack) => [stack]));
    return next;
}

/**
 * Moves the panel's stack into the folder headed by `head`, at its end;
 * from another folder, that one keeps the rest of its panels.
 */
export function intoFolder(layout: PageLayout, id: string, head: string): PageLayout {
    const from = locate(layout, id);
    const to = locate(layout, head);
    if (from === null || to === null || blockFolder(layout, layout.columns[to.column]![to.block]!) === null
        || (from.column === to.column && from.block === to.block)) {
        return layout;
    }
    const next = copy(layout);
    const stack = takeStack(next, from);
    const place = locate(next, head)!;
    next.columns[place.column]![place.block]!.push(stack);
    return next;
}

/** Takes the panel's stack out of its folder into a block of its own right after it; the last one out leaves no folder. */
export function outOfFolder(layout: PageLayout, id: string): PageLayout {
    const place = locate(layout, id);
    if (place === null || folderOf(layout, id) === null) {
        return layout;
    }
    if (layout.columns[place.column]![place.block]!.length === 1) {
        return ungroup(layout, id);
    }
    const next = copy(layout);
    const stack = takeStack(next, place);
    const after = locate(next, next.columns[place.column]![place.block]![0]!.ids[0]!)!;
    next.columns[place.column]!.splice(after.block + 1, 0, [stack]);
    return next;
}

/**
 * Moves the panel's stack one place up (step -1) or down (step 1) among
 * the stacks of its block; what belongs to the block stays with whichever
 * stack heads it then.
 */
export function moveStack(layout: PageLayout, id: string, step: -1 | 1): PageLayout {
    const place = locate(layout, id);
    if (place === null) {
        return layout;
    }
    const target = place.stack + step;
    const block = layout.columns[place.column]![place.block]!;
    if (target < 0 || target >= block.length) {
        return layout;
    }
    const next = copy(layout);
    const stacks = next.columns[place.column]![place.block]!;
    const head = stacks[0]!.ids[0]!;
    const [stack] = stacks.splice(place.stack, 1);
    stacks.splice(target, 0, stack!);
    passBlockPrefs(next, head, stacks[0]!.ids[0]!);
    return next;
}

// --- many pages, and a page arranged by a spec --------------------------------

/** The layouts of several pages by page id, as stored: only pages that differ from their markup. */
export type Layouts = Record<string, PageLayout>;

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
export function canonicalLayouts(raw: Record<string, unknown>, defaults: Record<string, Defaults>): Layouts {
    const out: Layouts = {};
    for (const [page, columns] of Object.entries(defaults)) {
        const layout = canonicalLayout(normalizeLayout(raw[page] ?? null, columns), columns);
        if (layout) {
            out[page] = layout;
        }
    }
    return out;
}

/** Whether two sets of layouts are the same once each is put in its stored form. */
export function sameLayouts(a: Record<string, unknown>, b: Record<string, unknown>, defaults: Record<string, Defaults>): boolean {
    return JSON.stringify(canonicalLayouts(a, defaults)) === JSON.stringify(canonicalLayouts(b, defaults));
}

/**
 * How a page is arranged for a purpose (a mode): the panels laid out
 * first, by column (an id, or the ids of a stack shown one at a time under
 * their tabs), the panels hidden, and the panels folded. The page's other
 * panels keep the markup's column, order and stacks, and show: a panel
 * added later (a plugin's) is in every arrangement.
 */
export interface Arrangement {
    columns?: (string | string[])[][];
    hidden?: readonly string[];
    folded?: readonly string[];
}

/**
 * The layout an arrangement gives a page: its columns' panels first in
 * each column, in its order; every other panel where the markup puts it,
 * joining the stack the markup puts it in; the hidden ones hidden. Ids the
 * page does not have are passed over, so an arrangement written for every
 * kind of machine fits a page that lacks some panels.
 */
export function arrangedLayout(arrangement: Arrangement, defaults: Defaults): PageLayout {
    const known = new Set(defaults.flat());
    const placed = new Set<string>();
    const columns: Block[][] = defaults.map(() => []);
    (arrangement.columns ?? []).forEach((entries, index) => {
        const column = columns[Math.min(index, columns.length - 1)];
        for (const entry of entries) {
            const ids = (Array.isArray(entry) ? entry : [entry]).filter((id) => known.has(id) && !placed.has(id));
            if (!column || ids.length === 0) {
                continue;
            }
            for (const id of ids) {
                placed.add(id);
            }
            column.push([{ ids, front: ids[0]! }]);
        }
    });
    const panels: Record<string, PanelPrefs> = {};
    for (const id of arrangement.hidden ?? []) {
        if (known.has(id)) {
            panels[id] = { hidden: true };
        }
    }
    for (const id of arrangement.folded ?? []) {
        if (known.has(id) && panels[id] === undefined) {
            panels[id] = { collapsed: true };
        }
    }
    // The panels left out go where the markup has them (normalizeLayout).
    return normalizeLayout({ columns, widths: null, panels }, defaults);
}
