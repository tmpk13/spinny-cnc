// What the machine knows about itself, as the Setup side's Checklist lists
// it: each value it runs on (its connection, its file, the cameras'
// offsets and scales, the up camera's place), where the value came from,
// and what fills it in. The aim is that a person sets as little as
// possible: a value a routine measured or the page detected needs nobody,
// one written or typed by hand is work a routine could take over, and a
// value missing is what needs someone now.
//
// Where a value came from is read from what the page already holds: the
// findings log (spinny_web.findings) records every value a camera routine
// applied, with its time, so a value equal to what a routine applied was
// measured then; a value that differs from it was changed by hand since.
// Each fact is read fresh from the state; nothing here is stored.

import { formatFixed } from "./format.ts";
import { machineInUse } from "./machineuse.ts";
import { isGcode, profileOf } from "./profile.ts";
import type { AppState } from "./state.ts";
import type { FindingEntry } from "./types.ts";

/**
 * Where a value came from: a routine on the machine measured it, the page
 * read it from the machine or the computer (detected), it is written in
 * the machine file, it was typed on the page, nothing set it and the
 * default holds, or it is not known.
 */
export type FactSource = "measured" | "detected" | "file" | "typed" | "default" | "missing";

/** What can fill a value in today: a routine that measures it, the page reading it, or a person only. */
export type FactFill = "routine" | "detect" | "hand";

export interface Fact {
    /** Its address in the Checklist (`facts/<id>`). */
    id: string;
    /** The part of the machine it belongs to, a heading of the list. */
    group: string;
    label: string;
    /** The value in words; for a missing one, what holds meanwhile. */
    value: string;
    source: FactSource;
    /** When a routine measured it, ISO local time; null when not measured. */
    when: string | null;
    fill: FactFill;
    /** Something a person must do now, in a few words; null when nothing. */
    need: string | null;
    /** Where it is set or measured: a link target (`panel` or `panel/detail`). */
    where: string;
    /** What the link does there: Measure, Set, Open, Connect. */
    action: string;
    /** The Use side's panels that depend on it, which link here from their heads. */
    uses: string[];
}

interface FactRule {
    id: string;
    group: string;
    /** The Use side's panels that depend on it. */
    uses: string[];
    fits(state: AppState): boolean;
    read(state: AppState): Omit<Fact, "id" | "group" | "uses">;
}

// --- reading the state ----------------------------------------------------------

/** Two values the same as JSON has them, numbers within rounding. */
export function sameValue(a: unknown, b: unknown): boolean {
    if (typeof a === "number" && typeof b === "number") {
        return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
    }
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((value, index) => sameValue(value, b[index]));
    }
    return a === b;
}

/**
 * The newest routine result that set `name` on `target` and still holds:
 * not undone, not an undo itself, and its value the one there now. Null
 * when no routine set it, or it was changed since.
 */
export function measuredBy(entries: FindingEntry[] | undefined, target: string, name: string, now: unknown): FindingEntry | null {
    for (const entry of entries ?? []) {
        const change = entry.changes.find((each) => each.target === target && each.name === name);
        if (!change) {
            continue;
        }
        // The newest word on the value: an undo or a result undone means a
        // routine's value no longer holds, nor does one changed since.
        if (entry.kind === "undo" || entry.undone_by !== null || !sameValue(change.after, now)) {
            return null;
        }
        return entry;
    }
    return null;
}

/** A value with no routine's word on it: in the machine file, typed, or the default when it is the default. */
function setBy(isDefault: boolean): FactSource {
    return isDefault ? "default" : "file";
}

function pair(value: [number, number], decimals: number): string {
    return `${formatFixed(value[0], decimals)}, ${formatFixed(value[1], decimals)}`;
}

/** A camera value's source: measured when a routine set what is there now, else written or the default. */
function cameraSource(state: AppState, target: string, name: string, now: unknown, isDefault: boolean): { source: FactSource; when: string | null } {
    const entry = measuredBy(state.findings?.entries, target, name, now);
    return entry ? { source: "measured", when: entry.time } : { source: setBy(isDefault), when: null };
}

function hasHeadCamera(state: AppState): boolean {
    return (state.camera?.device ?? "") !== "";
}

function placingFits(state: AppState): boolean {
    return (state.placing?.machine ?? null) !== null;
}

function boardConnected(state: AppState): boolean {
    return state.snapshot.connected && !isGcode(state.snapshot);
}

// --- the facts ---------------------------------------------------------------------

export const FACT_RULES: FactRule[] = [
    {
        id: "link.port",
        group: "Connection",
        uses: [],
        fits: () => true,
        read: (state) => {
            const snapshot = state.snapshot;
            if (!snapshot.connected || snapshot.url === null) {
                return { label: "Connection", value: "not connected", source: "missing", when: null, fill: "detect", need: "connect to run anything", where: "connection", action: "Connect" };
            }
            const port = state.ports.find((entry) => entry.url === snapshot.url || entry.device === snapshot.url);
            const named = port !== undefined && (port.spinny === true || (port.machine ?? null) !== null);
            return { label: "Connection", value: snapshot.url, source: named ? "detected" : "typed", when: null, fill: "detect", need: null, where: "connection", action: "Open" };
        },
    },
    {
        id: "link.file",
        group: "Connection",
        uses: [],
        fits: () => true,
        read: (state) => {
            const use = machineInUse(state);
            if (use.id === null) {
                const value = use.how === "no-file" ? "none: the board runs settings no file has" : use.how === "reading" ? "reading the board's settings" : "none yet";
                return { label: "Machine file", value, source: use.how === "reading" ? "detected" : "default", when: null, fill: "hand", need: null, where: "machine-file", action: "Open" };
            }
            return { label: "Machine file", value: use.name ?? use.id, source: "file", when: null, fill: "hand", need: null, where: `machine-file/${use.id}`, action: "Open" };
        },
    },
    {
        id: "link.flash",
        group: "Connection",
        uses: [],
        fits: (state) => boardConnected(state) && state.settings !== null && state.settings.controller !== "gcode",
        read: (state) => {
            const unsaved = state.settings?.unsaved ?? [];
            const value = unsaved.length === 0 ? "every setting saved to flash" : `${unsaved.length} written, not saved to flash: ${unsaved.slice(0, 4).join(", ")}${unsaved.length > 4 ? ", ..." : ""}`;
            return {
                label: "Board's settings",
                value,
                source: "detected",
                when: null,
                fill: "detect",
                need: unsaved.length === 0 ? null : "save them, or a restart loses them",
                where: "settings",
                action: unsaved.length === 0 ? "Open" : "Save",
            };
        },
    },
    {
        id: "motion.controls",
        group: "Motion",
        uses: ["machine", "job-machine"],
        fits: (state) => state.settings !== null && state.snapshot.connected,
        read: (state) => {
            const from = state.settings?.controls_from ?? null;
            const name = from === null ? null : state.machines?.machines.find((machine) => machine.id === from)?.name ?? from;
            return {
                label: "Jog controls",
                value: name === null ? "the defaults for this kind of machine" : `from ${name}`,
                source: name === null ? "default" : "file",
                when: null,
                fill: "hand",
                need: null,
                where: from === null ? "machine-file" : `machine-file/${from}`,
                action: "Edit",
            };
        },
    },
    {
        id: "motion.travel",
        group: "Motion",
        uses: ["heightmap"],
        fits: (state) => state.snapshot.connected && profileOf(state.snapshot).h_axis && !isGcode(state.snapshot),
        read: (state) => {
            const travel = state.settings?.host.travel ?? null;
            return {
                label: "Travel height",
                value: travel === null ? "none: moves cross at the height they are at" : `H ${formatFixed(travel, 2)} mm`,
                source: travel === null ? "default" : "typed",
                when: null,
                fill: "hand",
                need: travel === null ? "set one that clears the clamps before probing" : null,
                where: "heightmap",
                action: "Set",
            };
        },
    },
    {
        id: "head.device",
        group: "Camera on the head",
        uses: ["camera-view"],
        fits: (state) => state.camera !== null,
        read: (state) => {
            const device = state.camera?.device ?? "";
            if (device === "") {
                return { label: "Camera", value: "none", source: "default", when: null, fill: "detect", need: null, where: "camera", action: "Pick" };
            }
            const listed = state.cameras?.cameras.some((camera) => camera.device === device || camera.names.includes(device)) ?? false;
            return { label: "Camera", value: device, source: listed ? "detected" : "typed", when: null, fill: "detect", need: null, where: "camera", action: "Open" };
        },
    },
    {
        id: "head.offset",
        group: "Camera on the head",
        uses: ["camera-view", "place"],
        fits: hasHeadCamera,
        read: (state) => {
            const offset = state.camera!.offset;
            const zero = offset[0] === 0 && offset[1] === 0;
            const { source, when } = cameraSource(state, "head", "offset", offset, zero);
            const missing = zero && source !== "measured";
            return {
                label: "Offset from the tool",
                value: missing ? "not measured" : `${pair(offset, 2)} mm`,
                source: missing ? "missing" : source,
                when,
                fill: "routine",
                need: missing ? "measure it before lining a job up by camera" : null,
                where: "steps/camera",
                action: "Measure",
            };
        },
    },
    {
        id: "head.scale",
        group: "Camera on the head",
        uses: ["find"],
        fits: hasHeadCamera,
        read: (state) => {
            const scale = state.camera!.mm_per_px;
            const { source, when } = cameraSource(state, "head", "mm_per_px", scale, scale === 0);
            return {
                label: "Picture scale",
                value: scale === 0 ? "not measured: taken from the board once found" : `${formatFixed(scale, 4)} mm a pixel`,
                source,
                when,
                fill: "routine",
                need: null,
                where: "find",
                action: "Find board",
            };
        },
    },
    {
        id: "head.roll",
        group: "Camera on the head",
        uses: [],
        fits: hasHeadCamera,
        read: (state) => {
            const roll = state.camera!.roll;
            const { source, when } = cameraSource(state, "head", "roll", roll, roll === 0);
            return { label: "Picture roll", value: `${formatFixed(roll, 2)} deg`, source, when, fill: "routine", need: null, where: "camera", action: "Open" };
        },
    },
    {
        id: "head.lens",
        group: "Camera on the head",
        uses: [],
        fits: hasHeadCamera,
        read: (state) => {
            const lens = state.camera!.lens ?? null;
            return {
                label: "Lens correction",
                value: lens === null ? "none: the picture is taken as it is" : `k1 ${formatFixed(lens.k1, 4)}, k2 ${formatFixed(lens.k2, 4)}`,
                // Only a dot grid's measurement writes a lens.
                source: lens === null ? "default" : "measured",
                when: null,
                fill: "routine",
                need: null,
                where: "camera-sight",
                action: "Measure",
            };
        },
    },
    {
        id: "pnp.file",
        group: "Pick and place",
        uses: [],
        fits: placingFits,
        read: (state) => {
            const placing = state.placing!;
            const feeders = placing.document?.feeders.length ?? 0;
            return {
                label: "Machine",
                value: `${placing.name ?? placing.machine}, ${feeders} feeder${feeders === 1 ? "" : "s"}${placing.connected ? ", connected" : ""}`,
                source: "file",
                when: null,
                fill: "hand",
                need: null,
                where: `machine-file/${placing.machine}`,
                action: "Open",
            };
        },
    },
    {
        id: "pnp.homed",
        group: "Pick and place",
        uses: ["machine", "pnp-run"],
        fits: (state) => placingFits(state) && state.placing!.connected,
        read: (state) => {
            const homed = state.placing!.homed;
            return { label: "Homed", value: homed ? "yes" : "not since it was connected", source: "detected", when: null, fill: "routine", need: homed ? null : "home it before it moves", where: "pnp-steps", action: "Home" };
        },
    },
    {
        id: "pnp.up",
        group: "Pick and place",
        uses: ["pnp-run"],
        fits: placingFits,
        read: (state) => {
            const position = state.placing!.camera.position;
            const entry = position === null ? null : measuredBy(state.findings?.entries, "up place", "position", position);
            return {
                label: "Up camera's place",
                value: position === null ? "not measured" : `X ${formatFixed(position[0], 2)}, Y ${formatFixed(position[1], 2)}`,
                source: position === null ? "missing" : entry ? "measured" : "file",
                when: entry?.time ?? null,
                fill: "routine",
                need: position === null ? "center the nozzle over it to place parts by vision" : null,
                where: "pnp-nozzle",
                action: "Measure",
            };
        },
    },
    {
        id: "pnp.up.scale",
        group: "Pick and place",
        uses: ["pnp-run"],
        fits: placingFits,
        read: (state) => {
            const scale = state.placing!.camera.mm_per_px;
            const entry = scale === 0 ? null : measuredBy(state.findings?.entries, "up place", "mm_per_px", scale);
            return {
                label: "Up camera's scale",
                value: scale === 0 ? "not measured" : `${formatFixed(scale, 4)} mm a pixel`,
                source: scale === 0 ? "missing" : entry ? "measured" : "file",
                when: entry?.time ?? null,
                fill: "routine",
                need: scale === 0 ? "measure it with the nozzle over the camera" : null,
                where: "pnp-nozzle",
                action: "Measure",
            };
        },
    },
    {
        id: "pnp.runout",
        group: "Pick and place",
        uses: [],
        fits: placingFits,
        read: (state) => {
            const runout = state.placing!.camera.runout ?? null;
            const entry = runout === null ? null : measuredBy(state.findings?.entries, "up place", "runout", runout);
            return {
                label: "Nozzle runout",
                value: runout === null ? "not measured: taken as none" : `${pair(runout, 3)} mm`,
                source: runout === null ? "default" : entry ? "measured" : "file",
                when: entry?.time ?? null,
                fill: "routine",
                need: null,
                where: "pnp-nozzle",
                action: "Measure",
            };
        },
    },
    {
        id: "pnp.top.offset",
        group: "Pick and place",
        uses: ["place"],
        fits: (state) => placingFits(state) && state.placing!.top !== undefined,
        read: (state) => {
            const offset = state.placing!.top!.offset;
            const entry = offset === null ? null : measuredBy(state.findings?.entries, "top", "offset", offset);
            return {
                label: "Top camera's offset from the nozzle",
                value: offset === null ? "not measured" : `${pair(offset, 2)} mm`,
                source: offset === null ? "missing" : entry ? "measured" : "file",
                when: entry?.time ?? null,
                fill: "routine",
                need: offset === null ? "measure it before finding fiducials" : null,
                where: "pnp-top",
                action: "Measure",
            };
        },
    },
    {
        id: "pnp.top.scale",
        group: "Pick and place",
        uses: [],
        fits: (state) => placingFits(state) && state.placing!.top !== undefined,
        read: (state) => {
            const scale = state.placing!.top!.mm_per_px;
            const entry = scale === 0 ? null : measuredBy(state.findings?.entries, "top", "mm_per_px", scale);
            return {
                label: "Top camera's scale",
                value: scale === 0 ? "not measured: taken from the board once found" : `${formatFixed(scale, 4)} mm a pixel`,
                source: scale === 0 ? "default" : entry ? "measured" : "file",
                when: entry?.time ?? null,
                fill: "routine",
                need: null,
                where: "find",
                action: "Find board",
            };
        },
    },
    {
        id: "page.plugins",
        group: "This page",
        uses: [],
        fits: (state) => state.plugins !== null,
        read: (state) => {
            const on = (state.plugins ?? []).filter((plugin) => plugin.enabled).length;
            return { label: "Plugins on", value: on === 0 ? "none" : String(on), source: on === 0 ? "default" : "typed", when: null, fill: "hand", need: null, where: "plugins", action: "Open" };
        },
    },
];

/** Every fact that fits the machine and the page now, in the list's order. */
export function factsOf(state: AppState, rules: FactRule[] = FACT_RULES): Fact[] {
    return rules.filter((rule) => rule.fits(state)).map((rule) => ({ id: rule.id, group: rule.group, uses: rule.uses, ...rule.read(state) }));
}

/** The counts the Checklist heads its list with. */
export interface FactCounts {
    total: number;
    /** Set by a routine or read by the page: nobody's work. */
    automatic: number;
    /** Written in a file or typed: work a routine could take over where one exists. */
    byHand: number;
    /** Nothing set it; the default holds. */
    defaults: number;
    missing: number;
    /** Facts asking for someone now (a value missing, unsaved settings, not homed). */
    needs: number;
}

export function countFacts(facts: Fact[]): FactCounts {
    const count = (sources: FactSource[]): number => facts.filter((fact) => sources.includes(fact.source)).length;
    return {
        total: facts.length,
        automatic: count(["measured", "detected"]),
        byHand: count(["file", "typed"]),
        defaults: count(["default"]),
        missing: count(["missing"]),
        needs: facts.filter((fact) => fact.need !== null).length,
    };
}

/** The facts a panel of the Use side depends on. */
export function factsUsedBy(facts: Fact[], panel: string): Fact[] {
    return facts.filter((fact) => fact.uses.includes(panel));
}

/** Every panel some fact names as depending on it, for the links in their heads. */
export function panelsUsingFacts(rules: FactRule[] = FACT_RULES): string[] {
    return [...new Set(rules.flatMap((rule) => rule.uses))];
}

/** How long ago an ISO local time was, in a few words: "just now", "5 min ago", "3 h ago", "2 d ago". */
export function ageText(iso: string, now: number = Date.now()): string {
    const then = Date.parse(iso);
    if (!Number.isFinite(then)) {
        return "";
    }
    const seconds = Math.max(0, (now - then) / 1000);
    if (seconds < 60) {
        return "just now";
    }
    if (seconds < 3600) {
        return `${Math.round(seconds / 60)} min ago`;
    }
    if (seconds < 86400) {
        return `${Math.round(seconds / 3600)} h ago`;
    }
    return `${Math.round(seconds / 86400)} d ago`;
}

/** The source in a few words, as its chip says it. */
export function sourceText(fact: Pick<Fact, "source" | "when">, now: number = Date.now()): string {
    switch (fact.source) {
        case "measured":
            return fact.when ? `measured ${ageText(fact.when, now)}` : "measured";
        case "detected":
            return "detected";
        case "file":
            return "in the file";
        case "typed":
            return "typed";
        case "default":
            return "default";
        case "missing":
            return "missing";
    }
}
