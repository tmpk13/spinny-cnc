// The layers of a KiCad board file, read in the page so an import can offer
// the ones the board has before anything is sent: the layer table at the
// top of the file, and how many drawn things (pads, tracks, zones, lines,
// arcs, texts) lie on each. The file is read as a stream of lists without
// building a tree, so a board of a few megabytes costs one pass.

import { countText } from "./format.ts";

/** One layer of a board, as its table lists it. */
export interface BoardLayer {
    /** The layer's name in the file: F.Cu, F.SilkS, Edge.Cuts, User.1. */
    name: string;
    /** The name KiCad shows it by when that is another: F.Silkscreen, or the board's own. */
    shown: string | null;
    /** The table's type: signal, power, mixed, jumper or user. */
    type: string;
    /** How many drawn things lie on it. */
    items: number;
}

/** What a layer holds, for the way an import cuts it. */
export type LayerKind = "copper" | "paste" | "mask" | "silk" | "outline" | "fab" | "courtyard" | "adhesive" | "drawing" | "margin";

/** The names KiCad shows the layers by where they are not the layers' own, as the backend knows them. */
export const SHOWN_NAMES: Record<string, string> = {
    "F.SilkS": "F.Silkscreen",
    "B.SilkS": "B.Silkscreen",
    "F.Adhes": "F.Adhesive",
    "B.Adhes": "B.Adhesive",
    "F.CrtYd": "F.Courtyard",
    "B.CrtYd": "B.Courtyard",
    "Dwgs.User": "User.Drawings",
    "Cmts.User": "User.Comments",
    "Eco1.User": "User.Eco1",
    "Eco2.User": "User.Eco2",
};

/** The lists that draw on the layers they name; a footprint's own layer or a stackup's entries draw nothing. */
const DRAWN = new Set([
    "pad", "segment", "arc", "via", "zone", "dimension", "target", "property",
    "fp_line", "fp_arc", "fp_circle", "fp_rect", "fp_poly", "fp_curve", "fp_text", "fp_text_box",
    "gr_line", "gr_arc", "gr_circle", "gr_rect", "gr_poly", "gr_curve", "gr_text", "gr_text_box",
]);

/** What a layer of this name holds. */
export function layerKind(name: string): LayerKind {
    const suffix = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
    switch (suffix) {
        case "Cu":
            return "copper";
        case "Paste":
            return "paste";
        case "Mask":
            return "mask";
        case "SilkS":
            return "silk";
        case "Cuts":
            return "outline";
        case "Fab":
            return "fab";
        case "CrtYd":
            return "courtyard";
        case "Adhes":
            return "adhesive";
        default:
            return name === "Margin" ? "margin" : "drawing";
    }
}

/**
 * Whether a layer is a drawing rather than copper or paste: its lines are
 * cut where they lie, not isolated (Edge.Cuts, a silk screen, a user layer).
 */
export function isDrawingLayer(name: string): boolean {
    return !["copper", "paste", "mask"].includes(layerKind(name));
}

type Token = { kind: "open" } | { kind: "close" } | { kind: "atom"; text: string; quoted: boolean };

/** The tokens of an s-expression: brackets, quoted strings with their escapes undone, and bare atoms. */
function* tokens(text: string): Generator<Token> {
    const length = text.length;
    let i = 0;
    while (i < length) {
        const char = text[i]!;
        if (char === "(") {
            i++;
            yield { kind: "open" };
        } else if (char === ")") {
            i++;
            yield { kind: "close" };
        } else if (char === '"') {
            let out = "";
            i++;
            while (i < length && text[i] !== '"') {
                if (text[i] === "\\" && i + 1 < length) {
                    i++;
                }
                out += text[i];
                i++;
            }
            i++;
            yield { kind: "atom", text: out, quoted: true };
        } else if (char === " " || char === "\n" || char === "\t" || char === "\r") {
            i++;
        } else {
            const start = i;
            while (i < length && !" \n\t\r()\"".includes(text[i]!)) {
                i++;
            }
            yield { kind: "atom", text: text.slice(start, i), quoted: false };
        }
    }
}

interface Frame {
    head: string | null;
    /** The atoms after the head. */
    atoms: string[];
    /** Layers named by the list's own (layer ...) and (layers ...). */
    layers: string[];
    hidden: boolean;
}

/** The names a layer list's name stands for: *.Cu is every copper layer of the table, F&B.Cu the front's and the back's. */
function expand(name: string, table: string[]): string[] {
    if (name.startsWith("*.")) {
        const suffix = name.slice(1);
        return table.filter((layer) => layer.endsWith(suffix));
    }
    if (name.startsWith("F&B.")) {
        const suffix = name.slice(3);
        return [`F${suffix}`, `B${suffix}`];
    }
    return [name];
}

/**
 * The layers of a KiCad board file in its table's order, each with how
 * many drawn things lie on it; empty for text with no layer table (not a
 * board file, or one cut short).
 */
export function boardLayers(text: string): BoardLayer[] {
    const stack: Frame[] = [];
    const table: { name: string; shown: string | null; type: string }[] = [];
    const counted: { names: string[] }[] = [];
    let tableDone = false;
    let expectHead = false;
    const frame = (): Frame => ({ head: null, atoms: [], layers: [], hidden: false });
    for (const token of tokens(text)) {
        if (token.kind === "open") {
            stack.push(frame());
            expectHead = true;
            continue;
        }
        if (token.kind === "atom") {
            const top = stack[stack.length - 1];
            if (!top) {
                continue;
            }
            if (expectHead) {
                top.head = token.text;
                expectHead = false;
            } else {
                top.atoms.push(token.text);
            }
            continue;
        }
        expectHead = false;
        const done = stack.pop();
        if (!done) {
            continue;
        }
        const parent = stack[stack.length - 1];
        // The board's table: (layers (0 "F.Cu" signal) ...) right under
        // the board, its entries lists of a number, a name and a type.
        if (!tableDone && parent?.head === "layers" && stack.length === 2 && done.head !== null && /^-?\d+$/.test(done.head)) {
            const [name, type, shown] = done.atoms;
            if (name) {
                table.push({ name, type: type ?? "", shown: shown && shown !== name ? shown : SHOWN_NAMES[name] ?? null });
            }
            continue;
        }
        if (done.head === "layers" && stack.length === 1 && table.length > 0) {
            tableDone = true;
            continue;
        }
        if (!parent) {
            continue;
        }
        if (done.head === "layer" || done.head === "layers") {
            parent.layers.push(...done.atoms);
        } else if (done.head === "hide" && (done.atoms.length === 0 || done.atoms[0] === "yes")) {
            parent.hidden = true;
        } else if (done.head === "effects" && (done.hidden || done.atoms.includes("hide"))) {
            // A text hidden through its effects, as some versions write it.
            parent.hidden = true;
        }
        if (done.head !== null && DRAWN.has(done.head)) {
            // A bare hide among an old file's atoms hides a text as well.
            const hidden = done.hidden || done.atoms.includes("hide");
            if (!hidden && done.layers.length > 0) {
                counted.push({ names: done.layers });
            }
        }
    }
    const names = table.map((entry) => entry.name);
    const counts = new Map<string, number>(names.map((name) => [name, 0]));
    for (const { names: listed } of counted) {
        const on = new Set(listed.flatMap((name) => expand(name, names)));
        for (const name of on) {
            if (counts.has(name)) {
                counts.set(name, counts.get(name)! + 1);
            }
        }
    }
    return table.map((entry) => ({ ...entry, items: counts.get(entry.name) ?? 0 }));
}

/** A layer as the import's chooser lists it: its name, the name it is shown by, and what is on it. */
export function layerChoiceText(layer: BoardLayer): string {
    const shown = layer.shown ? ` (${layer.shown})` : "";
    const items = layer.items === 0 ? "empty" : countText(layer.items, "item", "items");
    return `${layer.name}${shown}: ${items}`;
}
